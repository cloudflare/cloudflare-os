# Plan: Opening a gadget's spawned agents in the Workshop sidebar

## Goal

A gadget that spawns agents should be able to show the user one of those agents' chats. Its UI
calls a new method on the `host` that `main(gadget, host)` receives (`GadgetHost`), and the
Workshop opens that chat in the chat sidebar.

A gadget must not be able to open chats it didn't create. Chat IDs are small sequential integers,
so the gadget names the chat with an opaque token instead. Only the agent spawner that created the
chat hands a gadget that token.

## Background

- `AgentSpawnerBinding.spawn()` returns nothing. `spawnCallable()` returns a `CallableAgent`, an
  `AgentSelfLoopback` entrypoint wrapped in a `Proxy` that turns every method name into a call to
  the agent. Neither gives the gadget a way to name its chat, and the proxy leaves no room to add
  one. Both stay exactly as they are, so existing gadgets keep working.
- Neither Workers RPC nor Cap'n Web can unwrap a stub. If a gadget hands the Workshop a stub, the
  Workshop can't learn which chat it stands for, so the chat has to be named by data.
- `AgentSelfLoopback` predates `ctx.restore()`: a props-carrying `WorkerEntrypoint` was the only
  way to make a storable stub. New persistent stubs should use `ctx.restore()` instead, as
  `getWorktreeReplicator()` does. It mints `{type: "worktreeReplicator", worktreeId}`, and
  `OverseerImpl.restore()` returns a `WorktreeReplicatorImpl` RPC target. Migrating the existing
  loopbacks is a separate job.
- Workshop clients already hold every chat's `AiChatMetadata`: `ChatInterface` loads the whole list
  with `listChats()` and keeps it current through `subscribeToChat()`.

## Design

### `SpawnedAgent`: a new spawner method

Add a third method to `AgentSpawnerBinding` (`agent-spawner-binding.d.ts`, which `describeBinding`
serves to agents). The result is declared as an `RpcStub`, so nobody mistakes it for a plain
object. Its members are methods rather than properties, so every read is visibly a call that has
to be awaited (or pipelined).

```ts
/**
 * Like spawnCallable(), but returns a SpawnedAgent: a handle to the new agent, of which the
 * callable stub is one part. Prefer this to spawnCallable() in new code.
 */
spawnAgent(title: string, options: SpawnCallableOptions): Promise<RpcStub<SpawnedAgent>>;

/**
 * A spawned agent. The stub is persistent: it can be stored in Durable Object storage and used
 * again later.
 */
interface SpawnedAgent extends RpcTarget {
  /**
   * Returns a stub that calls the agent, exactly like the one spawnCallable() returns. It can be
   * used without awaiting: `spawned.getAgent().process(document)`.
   */
  getAgent(): CallableAgent;

  /**
   * Returns an opaque string naming this agent's chat. Pass it to the gadget UI's
   * `host.openAgentChat()` to show the chat to the user.
   */
  getChatToken(): string;
}
```

`SpawnedAgent` is the place where later operations on a spawned agent go: posting an ordinary
message to it (which would cover what `spawn(title, prompt)` does today, so this method needs no
prompt form), managing its action approvals, and so on. None of those are part of this change.

**Kernel side:**

- **Restore params:** `OverseerRestoreParams` gains
  `{type: "spawnedAgent", chatId, initiatorUserId, initiatorModelId}`.
  - The chat doesn't store the initiator. `#createSpawnedChat()` works it out from the
    spawner's `creatorUserId`, and only the loopback's props and the per-call records keep it. So
    the params carry it, as `AgentSelfLoopback`'s props do today. That keeps the account that
    supplies the model the same when the stub is used after the spawner is gone.
- **`restore()`:** `OverseerImpl.restore()` checks that the chat still exists and was spawned (it
  has `spawnerConfig`), then returns `new SpawnedAgentImpl(this, params)`, an `RpcTarget` with
  `@validateRpc()`. Once the chat is deleted, the stored stub fails to restore, as a worktree
  replicator's does.
- **Queue method:** `AgentSpawnerQueue` gains `spawnAgentHandle(title, options, creatorUserId)`.
  It needs a name of its own because the queue's `spawnAgent()` already implements the public
  `spawn()`, which doesn't change.
  - It shares `#createSpawnedChat` with `spawnCallableAgent`.
  - It returns `await this.impl.ctx.restore({type: "spawnedAgent", ...})`.
  - `AgentSpawnerBindingImpl.spawnAgent` forwards to it, as the binding's other two methods do.
  - **The validator would break persistence.** `capnweb-validate` wraps a returned stub that is
    typed as an interface in a validating `Proxy`, and Workers RPC can't persist a `Proxy`: the
    gadget would get a stub it can't store, whose methods it can't call. So the queue method
    skips validation (`@skipRpcValidation()`, as `user.ts` does for the same reason), since only
    the binding calls it, and the binding's `spawnAgent` is typed to return `any`, so its
    arguments are still validated while the stub passes through.
- **`SpawnedAgentImpl`:**
  - `getAgent()` returns the same `AgentSelfLoopback` that `spawnCallableAgent` builds, from the
    params. Factor that construction into one helper. The call path (`deliverAgentCallback`)
    doesn't change. Making the callable stub itself a `ctx.restore()` stub belongs to the loopback
    migration.
  - `getChatToken()` returns the chat's `chatToken` from its metadata.

### The chat token

- **What it is:** an opaque random ID for the chat (`crypto.randomUUID()`), in a new optional field
  `AiChatMetadata.chatToken` in `workshop-shared/src/api.ts`.
- **Minting:** each of the three places that create a chat mints one: a new chat, a blueprint
  update, and `#createSpawnedChat`. Chats from before this change have none. Nothing hands out
  their token, so there's no backfill.
- **It's not a secret from the workspace.** It goes to Workshop clients with the rest of the
  metadata, which is fine. The token doesn't grant the right to see the chat. It only lets a
  gadget ask the Workshop UI to show the chat, to a user who could have opened it by hand. What
  it guards against is a gadget naming chats it was never given, and a gadget can't read chat
  metadata.
- **Lookup is local:** the Workshop maps a token to a chat in the chat list it already holds, with
  no round trip and no new kernel API.

### `GadgetHost.openAgentChat`

In `workshop-shared/src/api.ts`, replace "It has no methods yet" in `GadgetHost`'s doc comment with:

```ts
/**
 * Shows the user the chat of an agent this gadget spawned, given its
 * `SpawnedAgent.getChatToken()`. In the Workshop, the chat opens in the chat sidebar. Does nothing
 * where there is no chat sidebar (a use-only view, or a browser-mode export) or while the gadget
 * isn't on screen. Throws if the token names no chat in this workspace.
 */
openAgentChat(chatToken: string): Promise<void>;
```

- **Browser-mode export:** `ExportGadgetHost.openAgentChat` does nothing.
- **`GadgetUI.tsx`:**
  - `WorkshopGadgetHost` takes an `onOpenAgentChat` callback through a ref, because the frame's
    RPC session outlives renders.
  - The frontend doesn't use `capnweb-validate`, so the host checks by hand that the argument is
    a string.
  - With no callback, it does nothing.
  - `GadgetUI` gains an `onOpenAgentChat?: (chatToken: string) => void | Promise<void>` prop.
- **Whether the gadget is on screen:** `isVisible` doesn't say. [`GadgetEditor`](../packages/workshop-frontend/src/GadgetEditor.tsx)
  passes `activeTab === 'app' && !previewMode`, which stays true while the workspace pane is closed
  (`workspaceView.mode === 'chat'`) or showing Activity, and the gadget stays mounted in both. So
  `GadgetEditor` works out whether its gadget is actually showing: the pane is on the app with the
  app tab selected, or the gadget is full screen. If it isn't, the handler ignores the call.
- **The handler**, supplied by `GadgetEditor` to the pane's `GadgetUI`. (The preview overlay's
  never renders: nothing sets `previewMode`.)
  - **Look up the token** in the chat list `ChatInterface` holds. `ChatInterface` reports every
    chat's ID by token as the list changes, much as it reports the chat count, into a
    `ChatTokenIndex` that `GadgetEditor` keeps.
  - **A token not in the list yet** is waited for briefly, a few seconds. A gadget may spawn an
    agent and open its chat at once, and the chat's metadata arrives over the chat subscription,
    not with the gadget's RPC reply, so it can arrive later. If it still isn't there, throw "No
    such chat".
  - **Check again after the wait:** the user may have closed the pane, switched gadgets or left
    the workspace in the meantime. So right before navigating, the handler checks again that the
    same gadget is still on screen in the same workspace, and drops the request if not. A request
    still waiting when its `GadgetUI` session ends (its frame's RPC session is torn down, or
    `GadgetEditor` unmounts) is dropped too, so no stale work outlives its view.
  - **Then:**
    - leave full-screen and preview mode;
    - `navigateToChat(chatId)`;
    - on a single-pane layout, close the workspace pane, as `?showChat` does today.
  - Opening a chat from inside a draft's preview leaves that draft's chat. `navigateToChat`
    already handles leaving a pending app.
- **`GadgetUseView`** passes no handler, so a use-role collaborator's gadget does nothing. Those
  sessions have no chat list.

### Agent guidance

- `agent-spawner-binding.d.ts`:
  - The docs for `spawn()` and `spawnCallable()` point at `spawnAgent()` for new code.
  - `SpawnedAgent` documents both methods.
- `agent.ts`: the `host` paragraph describes `host.openAgentChat(chatToken)`. The UI gets the
  token from the gadget's server, which holds the `SpawnedAgent`. (The system prompt has no
  spawner usage guidance to update: agents learn the spawner's API from the served `.d.ts`.)

## Commits

1. **`SpawnedAgent` and chat tokens** (kernel and API):
   - `AiChatMetadata.chatToken` and minting it;
   - the restore params and `SpawnedAgentImpl`;
   - `spawnAgent()` on the binding, and `spawnAgentHandle()` on the queue;
   - the shared `CallableAgent` helper;
   - the `.d.ts`.
2. **`GadgetHost.openAgentChat`** (API): the method, `ExportGadgetHost`, and the agent prompt.
3. **Workshop** (frontend):
   - `WorkshopGadgetHost` and the `GadgetUI` prop;
   - the on-screen check;
   - the token lookup passed from `ChatInterface`;
   - the `GadgetEditor` handler.

## Tests

- **Backend unit tests**, beside `agent-calls.test.ts`:
  - `spawnAgent()` returns a `SpawnedAgent` that a gadget stores, and after a restart, calls
    through `getAgent()` still reach the chat as the spawner's creator.
  - `getChatToken()` matches the chat's `chatToken`.
  - New chats, from all three paths, get distinct tokens.
  - A deleted chat's `SpawnedAgent` fails to restore.
- **Integration**, in `workshop-callable-agents.test.ts`: a gadget spawns with `spawnAgent()`,
  stores the handle, and drives it after `restartWorkspace`.
- **Frontend**, `GadgetUI` tests:
  - `host.openAgentChat` reaches the handler.
  - It does nothing with no handler.
  - It rejects a non-string argument.
- **Frontend**, `GadgetEditor` tests:
  - A token opens its chat, including one whose metadata arrives after the call.
  - An unknown token throws once the wait ends.
  - The call is ignored while the pane is closed, while it shows Activity, and while another tab
    is selected.
  - A call waiting for late metadata doesn't navigate if the gadget is hidden or switched, or the
    workspace is left, before the metadata arrives.
- **Browser export:** `openAgentChat` does nothing.
- **Manual:** in a live browser, a gadget's button opens its agent's chat in the sidebar,
  including from full screen and on a phone-sized layout.

## Open questions

- **Should deleting the spawner revoke `SpawnedAgent`?** `CallableAgent` keeps working after its
  spawner is deleted. This plan matches that: `restore()` only checks that the chat exists.
  Methods that act for the agent later (sending messages, approvals) should check
  `assertGatekeeperUsable(spawnerId)`.
- **Should `openAgentChat()` report anything back?** It returns nothing for now. If a gadget turns
  out to need to know whether the chat was shown, that can be added later.
