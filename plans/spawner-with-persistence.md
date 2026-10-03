# Agent Spawner: Durable Calls and Persistent Stubs

## Background

The agent spawner binding predates two runtime features: persistent stubs (`[restore]()`, storing an
`RpcStub` in Durable Object storage) and per-chat bindings. Its `spawnCallable()` model -- the
gadget calls methods on a stub and the agent "implements" a TypeScript interface -- is worth keeping:
it makes gadget → agent requests look like agent → gadget requests (RPC on a TS interface) instead
of freeform prompts. But the machinery underneath is a mismatch with how agents actually run.

### What exists today

- `spawnCallable(title, prompt)` (`agent-spawner-binding.d.ts:32`, `overseer.ts:13033`) returns an
  `AgentSelfLoopback` -- the same props-based `WorkerEntrypoint` as the `self` object in
  `executeCode` (`overseer.ts:10379`). The stub itself is already persistent (props are plain
  data), so that half needs no change.
- A call becomes an `agentCallback` chat message plus an `agentCallbackArgs` record
  (`overseer.ts:7347-7364`). The **return path is in-memory only**: the caller's `resolve/reject`
  live in `LiveChatContext.activeAgentCallbacks` (`7367`). After a DO restart,
  `resolveAgentCallback` finds no live chat and silently returns (`7203`); the caller's RPC already
  failed with the restart.
- **Delivery is also not durable.** A call arriving while a turn is running sits in
  `liveChat.pendingAgentCallbacks` (`7268`) until the turn ends. A restart mid-turn drops it
  without a trace -- it was never written to the log.
- The caller's RPC (and hence its own DO, if called from an alarm or fetch handler) stays open for
  the agent's whole turn, potentially minutes.
- `TransientStubLoopback` (`overseer.ts:10410-10450`) exists only because args may contain
  non-persistent stubs that must survive into storage. `makeStorableArgs` (`agent.ts:3564`) swaps
  each for a loopback that resolves through an in-memory table (`getTransientStub`, `7242`), which
  expires when the callback is resolved -- another thing that breaks on restart.
- A lot of kernel surface exists solely to support returning a value: the nudge loop and
  `agentNudge` message (`overseer.ts:7036-7104`), the `giveUp` tool (`agent.ts:3227`),
  `callbackResolvers` in `executeCodeMode` (`8617-8641`) and the `{args, resolve, reject}` wrapping
  in `CODE_MODE_HARNESS` (`75-113`), `activeAgentCallbackCount` as a turn-stop condition
  (`agent.ts:3497`), and the resolve/reject/rejectAll trio (`overseer.ts:7200-7239`).
- The interface the agent implements is conveyed only by whatever the gadget author wrote into the
  `prompt` argument. The spawner system prompt (`agent.ts:880`) knows nothing about it; the
  per-call message (`agent.ts:2122`) tells the agent to `resolve()`/`reject()`.
- The "props" paragraph in the `AgentSpawnerConfig` doc comment (`api.ts:1632`) is stale -- that
  mechanism was removed in favor of passing stubs in call arguments.

## Decisions

1. **Calls are durable jobs.** A method call on the callable stub resolves once the call is
   durably recorded, not when the agent has acted on it. There is no return value and no
   completion notification: the agent is done when it says it is done, and the only observable
   outcome is what it does with the capabilities it was given. Flagging a thread as needing human
   attention (the role `giveUp` was meant to grow into) is future work and out of scope.
2. **All stubs passed to an agent must be persistent.** The runtime throws `DataCloneError` when
   asked to persist a non-persistent stub, so writing the args to storage *is* the enforcement.
   `TransientStubLoopback` and everything behind it is deleted.
3. **`spawn(title, prompt)` is unchanged.** It is useful for simple tasks that need nothing beyond
   the agent's environment, and depends on nothing being removed. Only `spawnCallable()` changes.
4. **`spawnCallable()` takes the TypeScript declarations instead of a prompt.** Today the gadget
   author is asked to explain the calling convention and paste the interface into a freeform
   `prompt`. Instead, `spawnCallable()` takes a `types` blob (the interface the agent implements,
   plus the types of anything passed in -- notably the interfaces of the RPC stubs it will call)
   and the name of the interface within it. There is no separate instructions string: at spawn
   time there is no task yet -- the first call supplies it -- so general context belongs in the
   doc comments of the declarations, exactly as binding descriptions work on the agent → gadget
   side. The declarations live in `spawnCallable()`'s arguments rather than in
   `AgentSpawnerConfig` because gadget code is where the interface is naturally maintained, and
   nothing in the config UI or the workspace agent's tools would otherwise be able to edit it.
5. **The kernel owns the prompt framing; the gadget owns the interface text.** The system prompt
   explains the model ("the Gadget calls methods of an interface you implement; here are the
   declarations") and embeds the gadget-supplied `types` verbatim; per-call messages just name the
   method. The gadget never writes prose about *how* calls are delivered or what to do with
   arguments -- that framing is kernel text, which is where per-model tuning lives.
6. **Callback args are named after the method.** `env.composeEmail_ARGS`, with a `_2`, `_3`...
   suffix only on collision. The name is stamped on the `agentCallback` message when it is written
   (like capsule binding names). The value is the args array itself, not `{args}`.
7. **Historical callback arguments are dropped, not migrated.** Old calls were transient: after
   this change they can no longer be resolved and any stubs inside them are dead, so keeping the
   non-stub remainder reachable under its historical `PARAMS_<n>` name -- which would also mean
   either a shape change from `{args, resolve, reject}` to a bare array or a compatibility shim --
   is not worth a migration. Legacy `agentCallback` messages (recognizable by a missing
   `bindingName`) remain in the log for display and are replayed to the model as a call whose
   arguments are no longer available; they bind nothing in `env`. The replay-order `PARAMS_<n>`
   allocation, currently simulated in four places that must stay in sync, is deleted outright.
   `agentNudge` messages and `giveUp` tool calls likewise stay in the `api.ts` unions, marked
   obsolete and no longer emitted, so old logs keep rendering.
8. **One PR, several commits**, grouped so the `workshop-backend`/`workshop-shared` changes can be
   read apart from UI touch-ups, and pure deletion apart from new behaviour.

## Binding API

`packages/workshop-backend/src/agent-spawner-binding.d.ts`:

```ts
/** Binding which spawns agents. */
export interface AgentSpawnerBinding {
  /** (unchanged) */
  spawn(title: string, prompt: string): Promise<void>;

  /**
   * Like spawn(), but the agent does not start immediately. The agent starts when a call is made
   * on the returned stub.
   *
   * This method returns a special stub that delivers calls to the new chat thread. This behaves
   * exactly like the `self` reference available to the `executeCode` tool, but targets the
   * newly-spawned agent. You may call any method name on this stub; the method's name and
   * parameters will be delivered to the agent, and it will then begin executing. The call returns
   * a promise that resolves as soon as the call is durably queued; the agent proceeds
   * asynchronously.
   *
   * The parameters to an agent call are encouraged to contain stubs which the agent may use to
   * call back to the gadget. Any such stubs must be persistent (created with `ctx.restore()`).
   *
   * Note that there is no built-in notification when the agent is done. If the gadget needs such a
   * notification, it should define a callback stub as part of the interface.
   *
   * The returned stub can be stored in Durable Object storage in order to invoke the same agent
   * again in the future. Of course, you should only reuse the same agent when continuing the same
   * logical task; it's better to spawn a new agent for a new task.
   */
  spawnCallable(title: string, options: SpawnCallableOptions): Promise<CallableAgent>;
}

export type SpawnCallableOptions = {
  /**
   * TypeScript declarations defining the interface this agent is meant to implement, including any
   * dependencies such as interfaces of callback stubs. These type definitions should have doc
   * comments explaining, among other things, what the agent is expected to do when it receives
   * each call.
   *
   * These type declarations may assume that the Workers RPC / Cap'n Web types `RpcStub` and
   * `RpcTarget` have already been imported. Use e.g. `RpcStub<SomeInterface>` to declare a
   * parameter that is an RPC callback. As usual, `SomeInterface` should either be an interface
   * inheriting `RpcTarget`, or it can be a simple callable function type.
   */
  types: string;

  /** Name of the interface within `types` that the agent implements. */
  mainType: string;
};

/**
 * Calls the agent. Any method name may be called; it should be one declared on the interface
 * named by `SpawnCallableOptions.mainType`. Every method resolves once the call is recorded.
 */
export type CallableAgent = { [method: string]: (...args: unknown[]) => Promise<void> };
```

`title` stays first for symmetry with `spawn()`.

**Migration guard.** Existing gadgets call `spawnCallable(title, prompt)`. So that they fail with
an explanation rather than a validator's type error, `AgentSpawnerBindingImpl.spawnCallable`
(`overseer.ts:13033`) declares its second parameter as `SpawnCallableOptions | string` and throws
when given a string: *"spawnCallable(title, prompt) has been replaced by spawnCallable(title,
{types, mainType}); the agent no longer receives a prompt and calls no longer return values. Update
the calling code -- call describeBinding on the spawner for the new interface."* The served
`.d.ts` keeps the clean signature. capnweb-validate builds the validator from the class method's
signature, and the README says an `implements` clause "can sharpen matching signatures" -- verify
that the union survives (if the interface's narrower type wins, drop `implements
AgentSpawnerBinding` from the impl class and keep it honest with a `satisfies`-style assignment
check instead). Remove the guard once existing gadgets have been updated.

## Kernel changes (`workshop-backend`)

### Storage

Add to `makeOverseerStorage` beside `agentCallbackArgs` (`overseer.ts:1368`):

```ts
// Calls delivered to a callable agent that have not yet been appended to its chat log. Written
// synchronously by deliverAgentCallback so a call is durable the moment the caller's RPC returns;
// drained into agentCallback messages by drainPendingAgentCalls at turn boundaries.
pendingAgentCalls: collection<{
  chatId: number,
  callId: number,          // from a new nextAgentCallId singleton; key is chatId.callId
  methodName: string,
  args: unknown[],         // persistent stubs only -- put() throws DataCloneError otherwise
  argsSummary: string,     // summary created using the existing summarizeArgs() function
  initiatorUserId: string,
  initiatorModelId: string,
}>
```

This replaces the existing `LiveChatContext.pendingAgentCallbacks` (`overseer.ts:223-256`), which
currently stores similar content in-memory only.

Add `spawnerTypes?: {types: string, mainType: string}` to `AiChatAgentContext` (`agent.ts:143`),
frozen at spawn like `spawnerConfig`. (Storing it on the context rather than in message #0 keeps it
out of the rendered chat and available to the system-prompt builder without a log scan.)

`agentCallbackArgs` keeps its shape; only the `args` contents change (no more loopbacks).

### Legacy callbacks

`bindingName` is optional on the `agentCallback` message type; absent means the message predates
this change and its arguments are gone. Every consumer of the `PARAMS_<n>` simulation instead
reads `msg.bindingName` and does nothing when it is absent: the replay loop (`agent.ts:2122-2144`,
and the counter at `1559-1563`), `agent-compaction.ts:398-403`, `chatScopeNames` (`7574-7581`), and
`prepareChatBindings` (`7806-7813`). The "keep in sync" comments at those sites go with them. The
replay text for a legacy message is *"A callback was received: `self.foo()`. Its arguments are no
longer available."*

Legacy `agentCallbackArgs` records, which hold `TransientStubLoopback` Fetchers, are left in
place; no migration. Restoring a Fetcher whose entrypoint class no longer exists yields a stub
that fails when invoked, not at deserialization, so nothing that lists the records breaks. The
only path that can still put one in front of the agent is a chat compacted *before* this change
while it had callbacks: its checkpoint (`CompactionCheckpoint.chatBindings`, `agent.ts:225`,
seeded at `1263`) carries `PARAMS_<n>` as `{type: "value", messageSequence}` entries, and
`getEnvForAgent` (`overseer.ts:3460-3470`) resolves them to the bare args array with dead stubs
inside -- the same "arguments are stale" outcome dropping them would give, with the non-stub data
still readable. The record is always present when the checkpoint is (chat deletion removes both,
`11796`), so the existing `missing agentCallbackArgs value` throw stays as the invariant it is.
`chatScopeNames` no longer counts such a checkpoint name as taken; no new `<method>_ARGS` name can
collide with `PARAMS_<n>`. `resolveBindingDescription`'s `value` text (`agent.ts:331`) is updated
for the bare-array shape, which also describes these correctly.

### Delivery: `deliverAgentCallback` (`overseer.ts:7254`)

1. Validate the chat exists.
2. `pendingAgentCalls.put(...)` inside try/catch. On `DataCloneError`, rethrow with:
   *"Arguments to a callable agent must be storable. RPC stubs must be persistent stubs created
   with ctx.restore(); see the agent spawner binding documentation."* (Verify the serializer runs
   synchronously at `put()` time under the typed-storage wrapper, so the error surfaces here and
   not on a later flush.)
3. If no agent is active for the chat and no message is being prepared, kick
   `drainPendingAgentCalls(chatId)` (not awaited).
4. Return. The promise resolves after the put.

`LiveChatContext` loses `pendingAgentCallbacks` and `activeAgentCallbacks`; `QueuedAgentCallback`
(`248-256`) goes away.

### Draining: `#startAgentForCallbacks` → `drainPendingAgentCalls`

Same skeleton as today (`overseer.ts:7284-7387`), reading from `pendingAgentCalls` instead of
memory:

- Wait out message preparation and re-check `meta.activeAgent`, as now.
- For each pending record in `callId` order, synchronously: allocate a sequence; compute the args
  binding name (below); write the `agentCallback` message (with `bindingName`) and the
  `agentCallbackArgs` record; delete the pending record. No awaits between the first write and
  the last delete, so a crash cannot half-drain.
- If the spawner has a model, resolve it from the first record's initiator (as now) and start the
  turn. If `config.modelId` is null, stop after appending -- the messages sit in the chat for a
  human to see, which is what the `modelId` doc in `api.ts:1649` already promises. The
  `"Cannot create a callable agent without a model"` check in `spawnAgent` (`10177`) goes away.
- On failure to start (model gone, etc.), post an agent error message to the chat instead of
  rejecting callers -- the callers have already been answered.

Drain points:
- `deliverAgentCallback` when idle (above).
- The turn `finally` (`overseer.ts:7189`): replace the `pendingAgentCallbacks.length` check with a
  storage lookup for the chat's pending records. This covers user-initiated turns too, so a call
  that arrived while the human was chatting is delivered afterwards.
- `reserveChatMessagePreparation`'s dispose (`5287-5292`), which today kicks
  `#startAgentForCallbacks` when the in-memory queue is non-empty; same storage lookup.
- `#resumeInterruptedAgents` (`1943`): after resuming active turns, drain any chat that has pending
  records and is not running. This is the restart case the old design lost.
- Chat deletion (`11796`) deletes the chat's pending records along with `agentCallbackArgs`.

### Turn semantics

- `#runAgentTurnWithContext` (`6966`): the loop at `7036-7104` collapses to the single `runAgent`
  call plus the existing compaction rerun. No nudge, no `outcome: "callbacks_stalled"`.
- Delete `resolveAgentCallback`, `rejectAgentCallback`, `activeAgentCallbackCount`,
  `rejectAllAgentCallbacks` (`7200-7239`) and the `AgentHooks` members (`agent.ts:559-560`); the
  reject-on-error (`7144-7149`) and resolve-undefined (`7182-7186`) blocks in the turn.
- `agent.ts`: remove the `giveUp` tool (`3228-3251`, `1909` replay case) and the
  `shouldStopAfterTurn` callback clause (`3497`). A callback turn ends the way any turn ends.
- `callbackInitiated` then has one remaining effect: exempting the turn from the free-tier usage
  check (`6998-7004`). Keep it for that (and for `observability.ts:10`), but the rationale comment
  ("so outstanding callbacks are never stranded") no longer holds -- see open questions.
  `ActiveAgentRecord.callbackInitiated` (`903-910`) stays as is.

### `executeCode` environment

- `CODE_MODE_HARNESS` (`75-113`): drop the `callbackResolvers` parameter and the `env[index] =
  {args, resolve, reject}` loop. `env.<name>` is the args array. `CodeModeEntrypoint.run`
  (`180-188`) loses the parameter too.
- `executeCodeMode` (`8617-8641`): drop `callbackResolvers` construction; `entrypoint.run(selfStub,
  restoreForger)`.
- `getEnvForAgent` `"value"` case (`3460`): unchanged apart from the comment.

### Transient stubs

Delete `TransientStubLoopback` and its props type (`10410-10450`), `getTransientStub` on the DO
(`10165`) and impl (`7242`), the `server.ts:23,60` exports, and the `makeStorableArgs` stub
replacement (`agent.ts:3564`). What remains of `makeStorableArgs` is the depth limit; either keep
it as a plain depth check or drop it and let the storage serializer decide. `summarizeValue`
(`agent.ts:3635-3643`) renders every stub as `RpcStub`; the `PersistentRpcStub` distinction is
gone.

### Args binding names

- `api.ts` `agentCallback` variant (`2917`) gains `bindingName?: string` -- "Name under which the
  arguments appear in the agent's `env`. Absent on messages from before callable agents became
  durable, whose arguments are no longer available."
- When draining, the name is `${methodName}_ARGS` if it passes `validateBindingName` and is not in
  `chatScopeNames(chatId)`, else `${methodName}_ARGS_2`, `_3`, ...; if the method name is not a
  valid identifier (e.g. `"foo-bar"`), fall back to `CALL_ARGS` with the same suffixing.
- `chatScopeNames` and the other three consumers just add `msg.bindingName` to the set when it is
  present (see "Legacy callbacks").

### Prompting

`spawnAgent` (`10172`) stores `spawnerTypes` on the chat context when spawning callable. It writes
no message #0 for callable agents -- there is no prompt any more. (Sequence numbers start wherever
`nextChatSequence` puts them; the `// always 0 but need to initialize` comment at `10225` suggests
checking nothing assumes message 0 exists.)

`runAgent` system prompt assembly (`agent.ts:2355-2383`), when `agentContext.spawnerTypes` is set,
appends to slot 1 (chat-specific, cache-stable across the chat) something like:

> You are being invoked programmatically from code (typically a Gadget). The caller expects you to
> implement a TypeScript interface defined by `<mainType>`, declared below. Each time the caller
> calls a method of `<mainType>`, you will receive the call as a message, and the parameters to
> the call will be placed into your `env` for use in `executeCode`. Complete the task as described
> in the TypeScript interface's doc comments.
>
> ```ts
> <types>
> ```

`SPAWNER_SYSTEM_PROMPT` (`agent.ts:880`) keeps its "the task is described in the first message"
sentence for `spawn()` agents; make it conditional or reword so it is true for both forms.

Per-call replay (`agent.ts:2122`) becomes:

> The Gadget called `composeEmail()` on your interface. Arguments (`env.composeEmail_ARGS`):
> <argsSummary>
> Access the full arguments as `env.composeEmail_ARGS` in executeCode.

`EXECUTE_CODE_TOOL_DESCRIPTION` (`agent.ts:978`): the `self` paragraph says calls on `self` are
recorded and delivered on a later turn, arguments must be storable (persistent stubs), and the
callback's arguments appear under a name given in the message. Remove `.resolve/.reject`.

`AgentSpawnerConfig` doc (`api.ts:1627-1639`): replace the stale "props" paragraph with a sentence
pointing at `spawnCallable()` arguments as the way to hand an agent per-task capabilities.

### `self` shares the new semantics

`AgentSelfLoopback` (`10379`) remains the single implementation behind both the `self` object in
`executeCode` and the `CallableAgent` stub, so its code does not change -- but the semantics of
`self` change exactly as callable agents do: `self.foo(x)` resolves once the call is recorded,
its arguments must be storable, and it never returns a value. This also removes a latent hang:
code that `await`ed `self.foo()` inside `executeCode` could never resolve within the turn that made
it.

## Shared API changes (`workshop-shared/src/api.ts`)

- `agentCallback` message (`2917`): add optional `bindingName`.
- `agentNudge` message variant (`2930`) and `giveUp` tool-call variant (`3226`): keep, doc comment
  marked **Obsolete** -- "No longer emitted since callable agents stopped returning values;
  retained so older chat logs remain readable."
- `AgentSpawnerConfig` doc comment fix (above). No structural change to the config, the blueprint
  types, or `GatekeeperCreationSpec`.

## Outside the kernel

- `workshop-frontend/src/ChatInterface.tsx:5996`: the callback row is labelled `self.<method>()`,
  which is wrong for spawner calls; show `<method>()` and the `bindingName`. Cosmetic. The
  `giveUp` switch cases (`603`, `695`, `738`, `771`, `797`, `822`) stay for old logs.
- `workshop-evals/src/transcript.ts:66-78`: keeps working unchanged; the field is optional, so
  its fixtures (`transcript.test.ts:84`) and `agent-compaction.test.ts:132` need no change.
- `AgentSpawnerConfigForm.tsx`, `GatekeeperModal.tsx`, blueprints: untouched.

## Tests

`workshop-backend` (workerd project):
- A call delivered while no agent is running produces a pending record, then an `agentCallback`
  message with `bindingName` `foo_ARGS`, and the record is gone.
- Two calls to `foo` in one drain get `foo_ARGS` and `foo_ARGS_2`; a method name colliding with a
  seed binding is suffixed.
- A call delivered during a turn is recorded and drained in the turn's `finally`.
- Pending records present at DO construction, with no active agent, are drained on startup.
- Passing a non-persistent `RpcStub` rejects with the instructive message and writes nothing.
- `spawnCallable(title, "a string")` rejects with the migration message.
- A `modelId: null` spawner appends the message and starts no agent.
- A legacy `agentCallback` message (no `bindingName`) replays as "arguments no longer available"
  and binds nothing.
- `agent-compaction.test.ts:132-134`: keep; add a stamped-`bindingName` case alongside.

## Commits

1. **Pure deletion** (`workshop-backend`, `api.ts` gains only the obsolete markers): the return
   path -- `resolve/reject/rejectAll/activeAgentCallbackCount`, the nudge loop, `giveUp`, the
   `shouldStopAfterTurn` clause, `callbackResolvers` and the harness wrapping -- and
   `TransientStubLoopback` with `getTransientStub` and the `makeStorableArgs` stub replacement.
   Legacy `agentCallbackArgs` records keep their now-dead Fetchers (see "Legacy callbacks").
   After this commit `deliverAgentCallback` resolves its promise as soon as the callback is
   queued, and a non-persistent stub in the args fails at the `agentCallbackArgs` put.
2. **Durable queue** (`workshop-backend`): `pendingAgentCalls` replaces
   `LiveChatContext.pendingAgentCallbacks`; the drain points; the `DataCloneError` rethrow with
   the instructive message; `modelId: null` handling.
3. **Interface-driven spawning** (`workshop-backend` + `workshop-shared`): `spawnCallable(title,
   options)` with the string guard, `spawnerTypes` on the chat context, system-prompt and per-call
   text, `.d.ts` rewrite, `bindingName` stamping and removal of the `PARAMS_<n>` simulation
   from all four sites, doc-comment fixes.
4. Frontend and evals touch-ups.

## Open questions

1. **Usage-limit exemption for callback turns** (`overseer.ts:6998-7004`). The stated reason
   ("callbacks would be stranded") is gone. Keeping the exemption means a gadget can drive
   unlimited agent turns for a free-tier owner via a callable agent; removing it means a blocked
   drain posts a usage error into the chat and the call stays in the log unhandled. Leaning: keep
   as is for this change and note it; revisit with the "needs attention" work.
2. **Retry on the enqueue.** If the gadget's RPC fails after the `put()` (DO eviction between the
   write and the reply), a retrying caller double-enqueues. An optional idempotency key on the call
   is the fix (`submitExternalMessage` has one). Defer unless it bites.
3. **`nextAgentCallId`** as a workspace-wide singleton vs. per-chat. Workspace-wide is simplest
   and the key is `chatId.callId` either way.
4. **`CallableAgent` typing.** `{[method: string]: (...args: unknown[]) => Promise<void>}` is
   honest but gives the gadget author no method-level checking. A generic `CallableAgent<T>` with
   `spawnCallable<T>(...)` would type-check the gadget's calls against its own interface at the
   cost of an unchecked cast (the runtime knows nothing of `T`). Worth it? The gadget author is an
   LLM reading the `.d.ts`, so probably yes, with a doc note that `T` is not enforced.
