# Plan: Inline gadget UIs in chat

## Goal

The agent can draw a live view inside its answer. It writes HTML, CSS and JS between
`<gadget-ui>` tags in the answer text, with no tool call. The Workshop runs each block in a
sandboxed frame built the same way as a gadget's UI frame. A block's code gets the chat's `env`,
as the agent's `executeCode` does: it can read and combine the chat's gadgets and connections over
Cap'n Web. A block can also suggest a message for the viewer to send. The message goes out only
when the viewer clicks Send, as the viewer's own chat message.

```html
Food spending is up 18% on September, mostly eating out.

<gadget-ui>
<title>Food spending against budget, October</title>
<h3>Food spending against budget, October</h3>
<div id="chart">Loading…</div>
<script type="module">
  const [weeks, limit] = await Promise.all([
    env.EXPENSES.rpc.totalsByWeek({ month: "2026-10", category: "food" }),
    env.BUDGET.rpc.weeklyLimit({ category: "food" }),
  ]);
  const chart = document.getElementById("chart");
  chart.replaceChildren();
  for (const w of weeks) {
    const bar = chart.appendChild(document.createElement("button"));
    bar.textContent = `Week ${w.week}: $${w.total} of $${limit}`;
    bar.onclick = () => agent.send(`Show me week ${w.week} in detail.`);
  }
</script>
</gadget-ui>
```

Today an agent that wants to show something interactive must create a gadget, write its files
with tool calls, and send the user to the side pane. That is slow for a one-off chart, a demo or
a choice between three options, and each result adds a gadget to the workspace list.

[Kinu](https://github.com/AshishKumar4/kinu)'s `<slate-ui>` blocks are the model for this
feature: they draw agent-written HTML in place in the answer, and their code can call the
workspace's tools. This plan keeps that speed but builds blocks from parts the Workshop already
has: the gadget sandbox, the Cap'n Web bridge, the gadget servers, the gatekeeper session
chokepoint, the action log and the composer's send path.

Acceptance criteria:

- An agent answer that contains a `<gadget-ui>` block shows the block as a live, interactive
  view in the chat, in the Workshop's light or dark theme.
- While a block streams, its markup draws in the view as it arrives. Classic scripts run, and
  inline event handlers listen, as soon as they arrive. Module scripts run as soon as the block
  closes, while the rest of the answer streams. When the answer is stored, the view keeps
  running: it does not reload or read its data again, unless one of its lookups failed while the
  answer streamed or this client saw other streamed text (see "Keeping a view across the store").
- A view sits in the answer as its prose does, in the chat's font, with no border, header or
  background of its own. Under it the Workshop shows the names of the bindings the view used, a
  Stop button, its Send chip, and its errors.
- Block code reads `env.NAME` for any binding in the chat's scope that a view may use. A gadget is
  `env.NAME.rpc`, the server the agent's `env.NAME.rpc` reaches: the chat's draft when the chat
  proposes changes to the gadget, and mainline otherwise. A connection the user made is a session
  on that connection. Nothing else in the agent's `env` is there (see "What a block can reach").
- A view's connection calls use the connection's account, as the agent's do. Its reads are
  recorded in the workspace's action log and not in the chat. Each write waits for a person's
  decision as an action card in the chat: auto-approval rules never apply to a view.
- `agent.send(message)` in a block shows the message under the block, with Send and Dismiss.
  Nothing reaches the kernel until the viewer clicks Send. Send uses the composer's send path,
  exactly as if the viewer had typed the message, and waits whenever the composer waits.
- A block with no content shows an error and runs nothing.
- Only the workspace owner and build collaborators can reach a chat's bindings from a view.
  Use-role collaborators cannot see chats, and the new RPC denies them.

## Locked decisions

- **A block runs in a gadget-style frame.** The frame is an opaque-origin srcDoc document with
  the gadget UI CSP. A block's HTML never goes into the Workshop document, and `MarkdownMessage`
  keeps `skipHtml`. The block frame is stricter than a gadget frame in one way: its sandbox is
  `allow-scripts` only, with no popups (see "What a block can reach").
- **The answer's text is the source.** The frontend draws a block from its copy of the answer:
  the streamed text while the answer streams, and the stored message after that. A block's markup
  draws as it streams, and its module scripts run once it closes, because no later text can change
  it. The cost is that code which ran may never be stored: a stopped or failed model request
  stores nothing, and then the view's calls in the action log and its cards in the chat are the
  only record of it. The kernel does not check which block asks for a binding. It would authorize
  nothing: the viewer's own Workshop tab already reaches every gadget and connection in the chat's
  scope (`getGadget(id).connectToGadget(chatId)`, `getGatekeeperById(id).openSession()`), and
  block code reaches the kernel only through the host.
- **A block has no name.** A view is the block's place in its message, so the parser needs no
  rules for duplicate names.
- **A block declares nothing.** `env.NAME` asks the kernel for `NAME` the first time block code
  reads it. A declaration would not limit the agent, which writes the declaration and the code
  together. It would limit only code injected into a view by data the view shows unsafely, and
  the instructions tell the agent to show data with `textContent` instead. Without one, the agent
  writes view code exactly as it writes `executeCode`, and the Workshop can list the names a view
  actually used.
- **A view is its own caller.** The kernel opens a connection's session with the caller
  `{from: "view", chatId}`, through `openGatekeeperSession`, the chokepoint for every session. A
  view is agent-written code that runs whenever someone views the chat. It is not the agent, whose
  records belong to a turn, and not a person, whose actions are their own. The account a
  connection uses is fixed in its record when it is made (`user.ts:2165-2172`), for the agent and
  for views alike. A view holds nothing its viewer lacks: an owner or build collaborator's tab can
  already open a session on any connection in the workspace.
- **The agent's stubs never reach a view.** A `{from: "agent"}` caller parks its records in a
  per-chat buffer that the agent's next step drains into the chat (`#associateAction`). Outside a
  turn, a view's records would land in some unrelated step.
- **Reads stay in the action log; writes go to the chat.** `authorizeObservation` does not post a
  view's observations to the chat. A view reads each time it mounts, for every viewer, so each read
  would add a card to every viewer's transcript. The agent never reads these cards (`agent.ts`
  skips `action` messages), so the cost is clutter, not context. `#associateAction` still posts a
  view's queued action to the chat, as it does for a gadget in a chat, so a person decides it
  there. A gadget the chat drafts keeps its own caller, `{from: "gadget", chatId}`, so its reads
  still post to the chat, whether its pane or a view called it. Restricted data, excluded
  observers and `ownerInvitesOnly` apply to every observation whatever its caller.
- **A view's writes never auto-approve.** `submitAction` stores a view's action as not
  `autoApprovable`. A view's load code runs again on every mount and for every viewer, and code
  injected through data the view shows runs with it, so each write needs a person's decision.
  Storing the verdict, rather than checking the caller in `autoApprovalRule`, keeps the card
  (which offers "Always approve" only for an auto-approvable action), the action log and the
  drainer in agreement.
- **What a view reaches directly.** A view gets the chat's gadgets and the connections the user
  made (`creationSpec.type === "gatekeeper"`). It does not get models (`aiModel`: their spend is
  not recorded), agent spawners (`agentSpawner`: they start agent turns), auto-provided services
  (`ambient`: Web Search spends the account's credits, Scheduled Tasks registers lasting callbacks,
  and nothing marks which singleton would be safe, so the Context Library goes with them),
  connections from before blueprint support, which have no `creationSpec` (failing closed),
  worktrees, or agent callback values. `GIT` and a gadget's `exports` are not in the chat's binding
  map at all: `getEnvForAgent` adds `GIT` itself, and the kernel serves `exports` to the agent only
  (`startGatekeeperSession`). These rules cover direct access. A gadget reaches its own bindings,
  of any kind, through its methods, whether its pane or a view calls them.
- **A gadget is the agent's view of the gadget.** The kernel opens it with
  `getGadgetFacet(id, chatId, joinAs)`, the facet that `startGatekeeperSession` opens for the
  agent's binding, with `#resolveGadgetChatId` applied. The gadget's own calls to gatekeepers keep
  the gadget's caller, as they do when the agent calls it.
- **Every stub counts toward the viewer's session.** `joinAs` is the caller's minted-capability
  kind (`#mintedCapabilityKind`), as for the stub `GadgetClient.connectToGadget` returns. A
  gadget's facet joins through `getGadgetFacet`. A connection's session joins through a proxy like
  `getGadgetFacet`'s, so the lease cannot be split from the session. The owner's stubs join
  nothing, as the owner's never do.
- **The host holds every limit.** Block code runs in the same realm as the bootstrap, so it can
  reach the frame's Cap'n Web port, for example by patching `MessagePort.prototype`. No limit can
  live in the frame. The host opens each name once per frame load, opens at most 32 names, and
  wraps each binding in `createRateLimitedCapability`. That paces calls on the binding itself.
  Stubs that a call returns, such as cursors and issues, are not paced, as in gatekeeper apps (see
  "Known edge cases").
- **A message to the agent needs a trusted click.** `agent.send` in the frame only asks the host
  to show the message. The Workshop draws it in its own DOM, so block code cannot click Send. Only
  the viewer's click calls the kernel. A block that calls `agent.send` on load or in a loop
  replaces its own pending message and spends nothing.
- **A sent message is the viewer's message.** Send calls the composer's own send handler, which
  calls the existing `Overseer.sendChatMessage(chatId, message, modelId)` with the model selected
  in the composer. That path already runs the turn on the viewer's account, checks a
  collaborator's access, and steers the turn when the agent is running. The chip shows the whole
  message, so data a block puts in the message reaches the agent only as text the viewer chose to
  send, like text they paste. A view can change its message up to the click, so Send has no delay
  to stop that: the message goes to the agent that wrote the view, and the transcript shows
  exactly what was sent.

## Current-state anchors

Symbols are in `packages/workshop-backend/src/overseer.ts` unless named otherwise.

- `getEnvForAgent` builds the agent's `env` from the chat's binding map. A gadget is
  `{rpc, exports}`, two binding loopbacks with the caller `{from: "agent", chatId}`. A gatekeeper
  is a loopback onto its session. A worktree and an agent callback value are agent-only. `GIT` is
  added before the chat's bindings.
- `prepareChatBindings` seeds a chat's bindings once, from the workspace's default binding list
  plus every ambient gatekeeper, and stores the seed in the chat's agent context.
  `resolveChatGadgetBinding` folds the seed, the active compaction checkpoint and the log after it
  (`foldChatBindings`, `agent-compaction.ts`) without writing anything.
- `openGatekeeperSession(id, facet, caller)` is the chokepoint for every gatekeeper session. It
  refuses a connection blocked by a pending scope-widening restart, and gives the gatekeeper an
  `ApprovalQueueImpl` (an `AgentSpawnerQueueImpl` for a spawner) bound to the caller.
- `authorizeObservation` stores every observation in the action log, then calls
  `#associateAction`. `#associateAction` buffers an agent caller's record for the agent's step,
  and posts any other caller's record to the chat when the caller has a `chatId`.
- `GatekeeperCaller` (`storage-schema/overseer-storage.ts`) is agent, gadget, user or hook, and
  only `overseer.ts` reads it. `{from: "user"}` is used today by `GatekeeperClient.openSession` and
  slash-command observations, both without a `chatId`.
- `autoApprovalRule` (`auto-approval.ts`) is the single authority on whether an action applies
  with no person. `submitAction` and the in-order drainer call it. The drainer stops at the first
  pending action it refuses.
- `getGadgetFacet(gadgetId, chatId?, joinAs?)` returns the facet stub in a proxy, inside
  `NativeRpcStub`, that makes it returnable over RPC and leaves the session on dispose.
  `joinSession` counts live sessions, which `#restartIfSessionsAffected` reads to decide whether a
  scope widening must restart.
- `checkChatExistsAndMaterializeChanges` folds a chat's live code-editor edits into its draft
  before a gadget pane loads (`getUiBundle`).
- `UseOverseerInterface` denies every `Overseer` method a use-role collaborator may not call.
  `DENIED_OVERSEER` in `packages/integration-tests/__tests__/workshop-use-role.test.ts` lists them.

Frontend (`packages/workshop-frontend/src`):

- `GadgetUI.tsx` and block frames both build their documents from `sandboxDocument.ts`: the
  Cap'n Web module URL and a head whose CSP is `default-src 'none'; script-src data:
  'unsafe-inline'; ... connect-src 'none'`.
- `createRateLimitedCapability` (`rateLimitedCapability.ts`) wraps an object's top-level methods
  with limits on concurrency, rate and backlog.
- `MarkdownMessage` renders message text with `skipHtml={true}`.

## Design

### Block syntax

`parseGadgetUiBlocks(text)` in `workshop-shared` returns a message as an ordered list of prose and
blocks. The frontend uses it to lay out a message, and the kernel to write the text a chat gateway
gets. The stored text is the streamed text joined with `""`, so provisional and stored text parse
alike.

- A block opens with `<gadget-ui ...>` at the start of a line, after optional spaces or tabs,
  outside a code fence. A tag inside a fence, or in the middle of a line, is prose. A fence opens
  on a line that starts with three or more backticks or tildes. It closes on a line with the same
  marker, at least as long, indented at most three spaces more than the line that opened it, so a
  fence in a list item closes at the item's indent. Kinu's parser
  (`packages/core/src/slates/ui-blocks.ts`) uses the same rules, except that it closes a fence
  only at three spaces of indent or less.
- The opening tag's attributes mean nothing.
- A block ends at the next `</gadget-ui>`. A block with no end is still streaming, or the agent
  did not close it. Once its message is stored, the chat shows an unclosed block as code and does
  not run it.
- The body is the HTML between the tags, trimmed. Its `<title>`, if present, names the view, with
  each run of whitespace read as one space, as HTML reads it.
- An open block's HTML so far is the text after its opening tag, without a closing tag that has
  only partly arrived, trimmed. It is always the start of the HTML the block has once it closes,
  so the Workshop can write it into the frame as it grows.
- A body that is empty once its `<title>` is removed is an error: "This view has no content." It
  shows an error and runs nothing.
- Only agent answers can hold blocks: stored messages of type `message` with an author of type
  `agent`, and the text an agent streams. The parser runs on nothing else.
- A chat gateway shows only text, so the answer it gets has a note, such as
  `[View in the chat: Spending]`, in place of each closed block (`gadgetUiAnswerAsText`). An
  unclosed block stays as written, as the chat shows it.

### Reaching a chat's bindings (kernel)

One new member of the shared API, replacing `connectToUiBlockGadget`, plus its result type:

```ts
/** One of a chat's bindings, as a `<gadget-ui>` view's code reaches it. */
export type ViewBinding =
  /** A gadget: the server that `env.NAME.rpc` reaches in the agent's `executeCode`. */
  | { type: "gadget"; rpc: RpcStub<any> }
  /** A connection the user made: a session on it, with the view as caller. */
  | { type: "connection"; session: RpcStub<any> };

/**
 * Opens the chat binding `name` for a `<gadget-ui>` view in the chat. The view is the caller of
 * a connection's session: its reads stay out of the chat, and each write waits for a person's
 * decision in it. Throws unless `name` is a gadget or a connection a view may use (see
 * plans/inline-gadget-ui.md). Dispose the result when the view's frame unloads.
 */
connectToChatBinding(chatId: number, name: string): Promise<ViewBinding>;
```

`RpcStub<any>` is the type `GadgetClient.connectToGadget` already returns for a gadget server,
whose methods the agent defines. A connection's session methods are the gatekeeper's. The kernel
steps:

1. Resolve `name` with `resolveChatBinding(chatId, name)`, which returns the folded entry. It is
   `resolveChatGadgetBinding` without the gadget check, so it still never writes chat context and
   still resolves on each call: a view drawn before its chat binds a name works once it does.
2. A gadget record: call `checkChatExistsAndMaterializeChanges(chatId)`, as `getUiBundle` does,
   and return `{type: "gadget", rpc: getGadgetFacet(id, chatId, joinAs)}`. It does not mark the
   step `accessedGadget`: the view shows gadget data to the viewer, not to the agent.
3. A gatekeeper record with `creationSpec.type === "gatekeeper"`: open
   `openGatekeeperSession(id, getGatekeeperFacet(id), {from: "view", chatId})`, wrap it in the
   session lease for a collaborator, and return `{type: "connection", session}`.
4. Anything else throws: `"NAME" can't be used in a view.` for a binding a view may not use, and
   `"NAME" is not a binding in this chat.` for a name the chat does not bind.

The session lease is a proxy around the session. It reports `RpcTarget.prototype`, forwards every
property to the session with the session as receiver, and on dispose leaves the viewer's session
and then disposes the session. It goes out inside `NativeRpcStub`, as `getGadgetFacet`'s proxy
does, because workerd misreads a proxy RpcTarget it serializes.

`GatekeeperCaller` gains `{from: "view"; chatId: number}`. `authorizeObservation` calls
`#associateAction` for every caller but a view. `submitAction` stores a view's action with
`autoApprovable: false`, so `submitAction` and the drainer both leave it for a person. The kernel no
longer parses blocks to reach a binding, so `uiBlockGadget` goes.

`OverseerClientInterface` already has `@validateRpc()`, so the arguments need no hand-written
checks. `UseOverseerInterface.connectToChatBinding` denies, and `DENIED_OVERSEER` replaces its
entry. `docs/observers.md` lists the view's stubs among the capabilities that count toward a
session.

### What a block can reach

| In the frame | Reaches | Rule |
|---|---|---|
| `env.NAME.rpc` | A chat gadget's server, at the chat's version | Resolved in the chat's scope on first use. |
| `env.NAME` | A session on a connection the user made, with the view as caller | Reads go to the action log; each write waits for a person's decision in the chat. |
| `agent.send` | A message shown under the block | Only the viewer's click on Send calls the kernel, through `sendChatMessage`, as the viewer's own message. |
| Popups, other frames, the network | Nothing | `sandbox="allow-scripts"`, CSP `connect-src 'none'`, and the Workshop's `frame-src srcdoc:`. |

A view can still write to a gadget through its methods with no approval, as a gadget's own UI
can. Gadget methods declare no read-only flag to limit a stub to.

Gadget UI frames keep `allow-popups` and `allow-popups-to-escape-sandbox`. So agent-written
`client.js` can still open a link that carries data out, even after the workspace has read
restricted data. This plan does not change gadget frames.

### Rendering (frontend)

- `ChatInterface` splits each agent answer with `parseGadgetUiBlocks`. Prose still goes through
  `MarkdownMessage`. Each block becomes a view in place: the frame, then a muted line that says
  "Live view", with the names of the bindings the view has opened and a Stop button that shows on
  hover or focus. Only names that resolved are listed, so block code cannot put arbitrary labels
  in Workshop chrome. The `<title>` is the frame's accessible name. Copy still copies the raw
  message.
- **No box.** The view has no border, header or background. A box marked where the view's area
  ends, so without one a view can imitate the transcript around it, such as a user's message or
  an approval card. That can mislead a reader, but it cannot act: approvals, the Send chip and
  every other action that matters stay in Workshop DOM. The muted line is the one mark under every
  view that the frame cannot draw. A box would not have stopped imitation either, since a view can
  draw a fake box edge and fake transcript inside its own area.
- **Stop.** Stop unmounts the frame and disposes its stubs, so a viewer can end a view that loops
  or floods its chip while it is on screen. The line then says "View stopped", and Run starts the
  view again.
- **Streaming.** The answer that streams in is drawn as the message it will become.
  `buildChatDisplayEntries` takes the streamed text and reasoning and adds them as the last
  message entry, marked `streaming`, so the agent's model-change row and the row's spacing come
  out as they will once the message is stored. The row uses the stored agent row's markup. It has
  no actions and looks nothing up by sequence. An open block is already a view: its markup draws
  as it streams, and its line says "Drawing…" in place of "Live view" until it closes, with the
  names and Stop as before. A block that closes with no content then shows its error, and its
  frame goes away. Tool calls in progress, "Thinking" and "Compacting" stay below the row, as they
  are today.
- **Keeping a view across the store.** When the stored message arrives, its row takes the
  streaming row's React key, so React keeps the row and the frames in it. The stream handler
  mints a key from a session counter when the streamed text or reasoning starts, so each step and
  each retry after `streamReset` gets its own. The subscriber's `message` callback maps the stored
  message's sequence to that key (`answerKeys`), for the agent message that ends the streamed
  text, and only when the stored text equals the streamed text. `buildChatDisplayEntries` uses the
  mapped key. Equal text and a parser that reads a prefix the same way keep each block at its
  index among the answer's segments, from the moment it opens, so each view keeps its block and
  an open block's view becomes the closed block's. A client that joined mid-answer, or lost deltas
  while it reconnected, has other streamed text, so its stored message mounts its views fresh.
- **The answer's own tool calls.** A step's tool calls run after the model finishes the step's
  text, so a view runs before them. If one of a view's lookups fails while its answer streams,
  the view reloads once when the answer is stored, because those tool calls may have added the
  binding. A code change to a gadget the view uses already reloads the view.
- **Frame interfaces.** The host exports `UiBlockHost` to the frame. It has `binding(name)`,
  `requestMessage(message)`, `resize(height)` and `reportError(message)`. The frame exports
  `UiBlockFrame`, with `setTheme(theme)`, `write(html)` and `close()`. Both are typed and
  documented in `features/chat/uiBlockFrame.ts`, beside the bootstrap. The frontend has no
  capnweb-validate transform, so the host checks its own arguments.
- **Bindings.** `binding(name)` refuses anything but a string that passes `validateBindingName`.
  The host keeps one entry per name for the frame load, and at most 32 names. The first call for a
  name calls `connectToChatBinding` and keeps its promise, then wraps the result: a gadget becomes
  `{rpc}` with a rate-limited `rpc`, and a connection becomes its rate-limited session. Later calls
  for the name get the same entry, failures included. At teardown the host disposes every kernel
  promise, which also disposes a result that arrives after it. A lookup that fails rejects in the
  block's code, and the view keeps running.
- **Connection.** The Workshop checks the handshake as `GadgetUI` does: the message must come from
  the view's own frame window, with origin `"null"`. A broken binding stub reloads the frame,
  because a gadget's server restarts on each code change and an agent can change code every few
  seconds. A frame load reloads at most once, however many of its stubs break. The first reload is
  at once. Each next one within 10 seconds of the frame's handshake waits twice as long as the
  last, from 1 second up to 30, so a server that fails as it starts cannot reload the view in a
  loop. A new Overseer stub (the Workshop reconnected) reloads a frame that has asked for a
  binding, because its stubs and lookups were on the old connection. The host marks the frame as
  having asked when `binding` is first called, before the lookup runs, so a lookup in flight across
  a reconnect counts. A frame that never asked keeps running. Lookups use the current Overseer
  stub.
- **Shell.** A frame loads a shell: the sandbox head, the frame's style in the theme of that
  moment, and one bootstrap module, whose URL is built once per page, since it embeds all of Cap'n
  Web. The bootstrap waits for the shell's `load` event, so that the event cannot fire in the
  block's document once `write` opens it. It then sets up the Cap'n Web session, and defines
  `globalThis.env` and `globalThis.agent`. `env` is a proxy: reading a string property other than
  `then` asks the host for that binding once and returns the same promise after that, so
  `env.NAME.rpc.method()` pipelines. `agent` has one method, `send(message)`. The bootstrap's
  cache only keeps `env.NAME` stable; the host enforces every limit.
- **Writing the block.** After the handshake the host calls `write` with the start of the block
  document (its doctype, and a head with the frame's style in the theme of that moment), then with
  the block's HTML so far, then with each new part as the answer streams, and calls `close` once
  the block closes. A stored block takes the same path, with all of its HTML in one `write`. The
  host settles each call, and the bootstrap each of its own calls to the host, so that Cap'n Web
  releases it: a block streams in many parts, and its view resizes as it grows. The first `write`
  calls `document.open()`, and each one calls `document.write()`, so the browser's own HTML parser
  adds the markup as it arrives, as it does for a page that loads slowly. A tag or a text that one
  part cuts in two joins up with the next part. Classic scripts and `async` module scripts run, and
  inline event handlers listen, as soon as they are parsed. Other module scripts wait until
  `close` ends the document, then run in document order, so a block's `<script type="module">`
  sees all of its markup, `env` and `agent`. Checked in Chromium 150, Firefox 157 and Safari's
  WebKit:
  - The CSP that the shell's `<meta>` set stays after `document.open()`, because the document
    keeps its policy container. Code in the new document still has no network.
  - `document.open()` keeps the window, its globals and the Cap'n Web port. It removes every node,
    and every event listener on the document and the window, so the bootstrap adds its error
    listeners and its `ResizeObserver` after the first `write`.
  - The doctype in the first `write` keeps the document in standards mode.
  - Chromium runs a module script inside `close()`, and puts "Failed to execute 'close' on
    'Document': " before the message of an error that the script throws at once. The bootstrap
    takes that text off.
  - WebKit reports an error in a classic script that `document.write()` added only as "Script
    error.", and an error in a module script as an `unhandledrejection`, which the bootstrap also
    reports. The instructions ask for module scripts, whose errors keep their message.
- **One load per session.** The host accepts one handshake per frame load. A second handshake
  means the document navigated by itself, so the Workshop disposes the session and stops the view.
- **Send chip.** `requestMessage` only stores the block's latest message, and refuses anything
  but a non-empty string. The Workshop shows the whole message under the view, in a focusable
  region that scrolls past a few lines, with Send and Dismiss. Send calls the composer's send
  handler, so it trims the message, runs on the composer's model, and reports a failure as the
  composer does; the chip then stays for another try. While a connection request or an awaited
  action holds the composer, the chip shows the composer's reason and Send is off. A newer message
  from the same block replaces the chip, and a message goes away with the frame that asked. A Send
  that finishes after a newer message arrived leaves the newer one in place. The chip sits in a
  polite live region, so a screen reader announces it.
- **Height.** The block document sets `html, body { margin: 0; height: auto }`. The body has 4 px
  of padding, which keeps a child's margin inside the measured height and focus rings inside the
  frame, and is its own formatting context (`display: flow-root`), which keeps floats inside too.
  The frame reaches 4 px past the answer's column on each side, so the view's content lines up
  with the prose. The bootstrap reports the body's height through a `ResizeObserver`, so the view
  grows as its markup streams in. The host clamps it between 40 px and `min(720, innerHeight -
  120)`. Taller content scrolls inside the frame. A view tells the chat when its height changes, so
  a list at the bottom stays there as a view grows or its chip comes and goes. The instructions
  forbid `vh` units and percentage heights on the page.
- **Theme.** The block document's root sets `color-scheme` and the token values, its background is
  transparent, and its text uses `var(--text-color-kumo-default)`. The host reads the mode from the
  `data-mode` attribute that `applyThemeMode` sets on `<html>`, and the computed values of a fixed
  list of Kumo tokens, under their Kumo names. Some values contain `light-dark()`, which the frame
  resolves through its own `color-scheme`. Each frame load starts its shell, and then its
  document, in the theme of that moment, so a view that reloads or scrolls back after a theme
  change starts in the new one, and the host calls `setTheme` again when the theme changes. The
  browser paints an opaque backdrop behind a frame whose root `color-scheme` differs from the
  frame element's (CSS Color Adjust §2.2). The element inherits the Workshop's scheme, so the
  backdrop can show only in the moment a theme change takes to reach a running view.
- **Fonts.** The theme also carries `--font-sans` and `--font-mono`. The body uses the chat's
  font, size, line height and letter spacing, form controls inherit them, and code uses the mono
  font. Both are lists of installed fonts that the Workshop never downloads, so the frame's CSP,
  which has no `font-src`, does not block them.
- **Mounting.** A frame is live only while its view is within one height of the chat's message
  list from that list's visible area, through an `IntersectionObserver` rooted at the list.
  Scrolling far away unmounts the frame and disposes its stubs, so the number of live frames is
  bounded by what is near the screen. A view keeps its last height while its frame is gone, so the
  transcript does not jump.
- **Errors.** Block console output goes nowhere. It must not reach the pane's buffer, which the
  composer offers to the agent. An uncaught error in block code, a failed lookup included, shows
  under the view, which keeps running. No automatic error reporting captures block errors, since
  blocks are agent-written code.

### Agent instructions

- The guidance on when to create a Gadget says that a one-off interactive demo, tool or visual is
  a view in the answer, even when the user calls it an app. A Gadget is for something that must
  last: keep its own data, run in the background, or be opened again later.
- The view section: when to draw one, the syntax, that the view's markup draws as the agent
  writes it and its module scripts run as soon as its block closes, so any style comes first, then
  the markup, and the script last, that the scripts run before the tool calls of the same answer,
  so the Gadgets and connections the view uses must exist before the agent writes it, that the
  `<title>` is not shown and the view sits in the answer with no border or padding around it,
  module scripts, `env` as in `executeCode` and what it lacks, that each write waits for a
  person's decision in the chat, that code on load must only read and no code may poll or loop
  over calls, `textContent` rather than `innerHTML` for data, `agent.send` in the user's words, no
  network, the Kumo colour tokens, the height rules, and that a view keeps no state. The example
  draws its heading and a loading line as markup, and its script fills in the bars, since models
  copy the example more than they follow the rules.

## Rejected alternatives

- **Raw HTML in Markdown.** It would run agent-written code in the Workshop document, with the
  Workshop's authority.
- **A tool call that shows HTML.** Each view would cost a model round trip, and the view could not
  stream with the prose.
- **A gadget for each block.** Each one would add a gadget to the workspace list and a git
  history, and would need tool calls.
- **One gadget per block (`gadget="NAME"`).** The first version of this plan. A view could not
  combine gadgets, and could not reach a connection without a gadget built for it, which pushed
  the agent back to creating gadgets.
- **Declaring a block's bindings (`bindings="A B"`).** See "A block declares nothing".
- **Checking the block in the kernel.** The first version had the kernel read the stored answer
  and check the block that asked, because the block's `gadget=` chose the gadget. With no
  declaration the check would prove only that some block exists. It would authorize nothing the
  viewer's tab cannot already do, and it cost a read and a parse of the answer on each lookup.
- **Pacing stubs that a binding's calls return.** The host would have to walk every result, wrap
  each stub in it and dispose the wrappers. Gatekeeper apps share the limiter and pace only calls
  on the capability itself too.
- **Inlining the `env` factory with `Function.prototype.toString` to unit-test it.** Minifiers and
  coverage tools rewrite a function's body and can make it call helpers outside it. Host tests and
  the browser run cover the bootstrap instead.
- **Keeping views under the user caller.** `{from: "user", chatId}` would work today, but two
  rules would then depend on "a user caller with a chat is a view", which nothing states.
- **Handing a block the agent's `env` stubs.** Their caller is the agent, so a view's records
  would land in an unrelated agent step.
- **Sending a block's requests straight to the kernel.** Block code could then start turns on load,
  on every remount and for every viewer, on that viewer's account, and a block could start a loop
  of turns. A check in the parent would depend on user activation passing from a cross-origin child
  frame to its parent, and Chromium tracks that behaviour as a security bug
  (<https://issues.chromium.org/issues/500508224>). A check inside the frame runs in the same realm
  as the block's code. The host's chip needs neither.
- **Structured calls through the agent callback queue.** `agent.call(name, ...args)` could reach
  the agent as a call on `self` does. But that queue serves the agent's own calls. It runs a batch
  of pending calls as one turn on the first caller's account, and it does not check a
  collaborator's access before a callback turn. Making it safe for calls from people took about
  120 kernel lines and a new RPC method, while `sendChatMessage` already does both. The cost is
  that the agent gets text, not structured values.
- **A proxy `agent`, where any method name is a call.** `JSON.stringify(agent)` would call
  `toJSON`, and `await agent` would call `then`. `env` is a proxy because binding names are open,
  and it returns nothing for `then`.
- **Posting a view's reads to the chat.** Each mount, by each viewer, would add cards to every
  viewer's transcript.
- **Storing the resolved workpiece id on the message.** Names are never rebound, so resolving at
  connect time gives the same answer.
- **Serving blocks from a separate origin by URL, as Kinu does.** Gadget UIs already get isolation
  from opaque-origin srcDoc frames.
- **A card with a border, a header and a collapse button.** A border marks where a view ends, but
  a view can draw a fake one (see "No box"). The header repeated the heading that most views draw.
  Stop keeps what collapse gave a viewer: a way to end a view on screen.
- **Running a view only once its answer is stored.** The first version. A view in a long answer
  waited for the whole step, its tool calls included.
- **Moving a running frame from the streaming row to the stored row.** An iframe that leaves the
  document unloads. `Element.moveBefore()` keeps it loaded, but not every browser has it.
- **One layer that holds every frame over placeholders in the transcript.** The frames would leave
  the transcript's DOM order, so keyboard focus and screen readers would reach them out of place.
- **Keying each view by its HTML as well as its place.** A block's HTML cannot change under one
  key: the streamed text only grows, `streamReset` mints a new row key, and the stored message
  keeps the key only when its text is the streamed text. And the view of an open block needs a key
  that stays as its HTML grows.
- **Holding a lookup that failed while streaming until the store, and retrying it then.** It saves
  the view's other reads, but the host would have to cancel the wait at teardown and on a new
  Overseer stub. A lookup that fails while its answer streams is rare enough that one reload is
  simpler.
- **Setting the frame body's `innerHTML` on each delta.** Each delta would parse the whole block
  again and replace its nodes, which loses their state. Scripts set through `innerHTML` never run,
  so the frame would have to make each one again, in order, at the end.
- **Keeping a stored block's HTML in the shell.** It would be a second way to load a view. A
  stored block takes the streaming path with one `write`.
- **Holding classic scripts and inline handlers until the block closes.** The frame would have to
  rewrite the HTML as it streams. Module scripts already wait, and the instructions ask for module
  scripts. Code that runs early reaches the host as any block code does, and the host holds every
  limit.

## Commits

PR #874 already holds the first version. This change adds commits on top, with kernel and UI
apart so reviewers can read the kernel lines alone:

1. **This plan.**
2. **Kernel.** The parser change, `Overseer.connectToChatBinding`, the view caller and its
   observation and auto-approval rules, the session lease, `docs/observers.md`, the use-role
   denial, and the agent instructions.
3. **Frontend.** The `env` bootstrap, the host's bindings, the card's binding names and reloads.

The kernel commit removes `connectToUiBlockGadget`, which the frontend still calls until the next
commit, so the frontend does not build at the kernel commit alone.

Drawing views in place and running them when their block closes adds three more:

1. **This plan's update.**
2. **Kernel.** The agent instructions, and the parser test that a closed block keeps its index at
   every cut.
3. **Frontend.** The view without card chrome, its muted line and Stop, the chat's font, the
   streaming row and the key its stored message keeps, and the reload after a lookup that failed
   while the answer streamed.

Streaming a block's markup into its frame adds three more:

1. **This plan's update.**
2. **Kernel.** An open block's HTML so far in the parser, its test, and the agent instructions.
3. **Frontend.** The shell, the frame's `write` and `close`, and the view that writes to them.

## Verification

- Parser unit tests (`workshop-backend/__tests__/gadget-ui-blocks.test.ts`): prose offsets, fences
  and their closing rules, tags in the middle of a line, unclosed blocks, several blocks in one
  message, empty bodies and title-only bodies as errors whatever the attributes, the same blocks
  at the same index among the segments at every cut of a streamed answer once they close, an open
  block at every cut at the index it closes at, with HTML that starts the HTML it closes with, and
  the text form a chat gateway gets.
- Backend tests for `connectToChatBinding` (`ui-blocks.test.ts`):
  - It refuses a name the chat does not bind, a worktree, a model, an agent spawner, an ambient
    gatekeeper and a connection with no `creationSpec`.
  - A gadget: it opens the facet at the chat's version for the owner and for a collaborator,
    counted toward the collaborator's session; it folds in a live code-editor edit first; a name
    bound after the view resolves once bound; after a compaction a name resolves from the
    checkpoint and the messages after it.
  - A connection: it opens a session with `{from: "view", chatId}` whose calls work for the owner
    and through a collaborator's lease, counted toward the collaborator's session until disposed.
  - A view's observation is in the action log and not in the chat; its queued action is in the
    chat, pending and stored as not auto-approvable while an enabled rule covers its kind.
- The use-role integration table covers `connectToChatBinding`.
- Frontend tests (`GadgetUiBlockCard.test.tsx`): a message from the frame never calls the kernel
  until Send; Dismiss; Send held while the composer is held; a failed Send; a Send that finishes
  after a newer message; `binding` reaches a gadget's `rpc` and a connection's session; two calls
  for one name make one kernel call; a 33rd name and a name that is not a string are refused; a
  failed lookup rejects and the view keeps running; the line under the view lists only names that
  resolved; a result that arrives after unmount is disposed; a view reloads after each of five
  quick restarts; two stubs that break together reload the view once; a second handshake stops
  the view; a new Overseer connection reloads a view that asked for a binding, including one whose
  lookup is still in flight, and leaves one that did not; unmounting disposes every stub; an empty
  block shows its error, no frame and no Reload, and so does an open block that closes with
  nothing but a title; Stop disposes every stub and Run starts the view again; a lookup that
  failed while the answer streamed reloads the view once the answer is stored, and a failed
  lookup in a stored answer does not; a stored block's frame gets the document's start, all of the
  block in one write, then `close`; an open block's HTML reaches the frame in parts as it grows,
  after the document's start, and `close` follows the last part once it closes, in the same frame;
  a new frame load gets the start and then all of the HTML so far.
- `ChatInterface` tests: an open block in a streaming answer is already a frame, and the closed
  block and then the stored message keep that frame element; a stored message whose text differs
  from the streamed text mounts its view fresh.
- A browser run on the dev server with a real model: the agent draws a view that combines two
  gadgets and a connection, `env.NAME.rpc.method()` pipelines in the real frame, the view follows
  a theme change, a connection write waits as a card in the chat, a click shows the message, and
  Send posts it as the viewer's message. The view's markup draws while its block streams, its
  module script runs once, at the block's close, and the stored answer does not reload it: one
  handshake, and one action-log read for each connection call. Screenshots in light and dark, and
  after a theme change, show the view with no box around it.

## Known edge cases

- **Old messages.** A block's code stays fixed in its message, but its data is live. If a binding
  changes shape, an old block can fail. The view shows the error, and the agent can draw a new
  block.
- **Deleted gadget or connection.** The lookup fails in the view's code, and the error shows under
  the view.
- **A name bound after the block.** A block that reads a binding before the chat has it starts to
  work once the chat binds that name and the view reloads.
- **Versions.** A block and the pane in the same chat use the same version of a gadget. Two viewers
  on different versions restart the facet, as two panes do today, and the block reloads.
- **Repeated reads.** A view reads again on each remount and for each viewer, and each connection
  read is an action-log record. A view that polls fills the log, as a gadget UI that polls
  through its server does today. The rate limit bounds calls on the binding itself.
- **Stubs a call returns.** Cursors and entities that a session returns are not paced. A view
  that loops on one spends the connection's API quota and fills the action log.
- **A gadget the chat drafts.** Its reads post to the chat when a view calls it, as they do when
  its pane calls it.
- **A view's pending write.** It holds the composer when its gatekeeper marks it `awaitDecision`,
  as any pending awaited card does (`hasPendingAwaitedAction` ignores the caller). Like any action
  waiting on a person, it also stops the in-order auto-approval drain for its connection until
  someone decides it.
- **Who made a call.** A view caller carries no user id, so the action log does not say which
  person's view read or wrote. `GatekeeperClient.openSession` has the same gap today.
- **A running agent.** Send while the agent runs steers that turn, as a typed message does.
- **An answer that is never stored.** A stopped or failed model request stores nothing, so its
  views go away with its text. A view in it may have run already: its reads stay in the action
  log, and its writes stay as cards. A retried request runs its views again.
- **A write from a view that is still streaming.** Its action card is stored at once, and the
  answer only at the end of its step, so the card sits above the answer that holds the view. A
  stored view's card sits below it.
- **A block the agent never closes.** Its markup drew while it streamed, its classic scripts ran,
  and its inline event handlers listened. Once the answer is stored, the view goes away and the
  block shows as code.
- **A view drawn mostly by its script.** Markup that is only empty elements shows nothing until
  the script runs at the block's close. A `<style>` applies only once its end tag arrives. The
  instructions ask for the style first, then the markup, and the script last, so the view takes
  shape as it streams.
- **Context cost.** The block's HTML stays in the agent's message, so the model reads it again on
  each later turn until compaction summarizes that part of the chat.

## Open questions

- Should replay give the model a short stand-in for old block HTML? Any change must handle saved
  model snapshots and compaction, and must keep the stored answer unchanged.

## Future work

- Server code in a block: the block becomes a chat-scoped gadget whose files live in the message,
  run by the gadget loader with its own storage, for views that must keep state or cache reads.
- Context Library and other free auto-provided services in views, once a gatekeeper can say that
  its session spends nothing.
- Save a block as a gadget: the block's HTML becomes a new gadget's UI.
- A small library set for charts, packaged into the frame, since the CSP blocks CDNs.
- Drop popups from gadget UI frames too, or at least once the workspace has read restricted data.
- An eval that checks the agent's views for readability in light and dark themes and at phone
  width (see `plans/evals-and-e2e-tests.md`).
