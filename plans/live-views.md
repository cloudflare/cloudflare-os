# Plan: Live views in chat

## Goal

The agent can draw a live view inside its answer. It writes HTML, CSS and JS between
`<inline-html>` tags in the answer text, with no tool call. The Workshop runs each block in a
sandboxed frame built the same way as a gadget's UI frame. A view shows what the agent writes into
it, and what its tag gives it in `env`. It has no network apart from WebRTC (see "Known edge
cases"). A block can also suggest a message for the viewer to send. The message goes out only when
the viewer clicks Send, as the viewer's own chat message.

Data from code reaches a view without passing through the answer. The agent's `executeCode` saves
a value with `env.NAME = value`. A later answer's block lists the names its code reads, as in
`<inline-html env="FOOD">`, and reads `await env.FOOD`. A listed name can also be one of the chat's
Gadgets or connections, which the view calls live.

```html
Food spending is up 18% on September, mostly eating out.

<inline-html>
<title>Food spending against budget, October</title>
<h3>Food spending against budget, October</h3>
<div id="chart"></div>
<script type="module">
  const limit = 120;
  const weeks = [[1, 96], [2, 132], [3, 88], [4, 141]];
  const chart = document.getElementById("chart");
  for (const [week, total] of weeks) {
    const bar = chart.appendChild(document.createElement("button"));
    bar.textContent = `Week ${week}: $${total} of $${limit}`;
    bar.onclick = () => agent.send(`Show me week ${week} in detail.`);
  }
</script>
</inline-html>
```

The same view, from data that code worked out. First, in `executeCode`:

```js
export default async function(self, env) {
  env.FOOD = { limit: 120, weeks: [[1, 96], [2, 132], [3, 88], [4, 141]] };
}
```

Then, in the next response:

```html
<inline-html env="FOOD">
<title>Food spending by week</title>
<h3>Food spending by week</h3>
<div id="weeks"></div>
<script type="module">
  const { limit, weeks } = await env.FOOD;
  const list = document.getElementById("weeks");
  for (const [week, total] of weeks) {
    const bar = list.appendChild(document.createElement("button"));
    bar.textContent = `Week ${week}: $${total} of $${limit}`;
    bar.onclick = () => agent.send(`Show me week ${week} in detail.`);
  }
</script>
</inline-html>
```

Today an agent that wants to show something interactive must create a gadget, write its files
with tool calls, and send the user to the side pane. That is slow for a one-off chart, a demo or
a choice between three options, and each result adds a gadget to the workspace list.

[Kinu](https://github.com/AshishKumar4/kinu)'s `<slate-ui>` blocks are the model for this
feature: they draw agent-written HTML in place in the answer. This plan keeps that speed but
builds blocks from parts the Workshop already has: the gadget sandbox, the Cap'n Web bridge and
the composer's send path.

Acceptance criteria:

- An agent answer that contains an `<inline-html>` block shows the block as a live, interactive
  view in the chat, in the Workshop's light or dark theme.
- While a block streams, its markup draws in the view as it arrives. Classic scripts run, and
  inline event handlers listen, as soon as they arrive. Module scripts run as soon as the block
  closes, while the rest of the answer streams. When the answer is stored, the view keeps
  running: it does not reload, unless this client saw other streamed text (see "Keeping a view
  across the store").
- A view sits in the answer as its prose does, in the chat's font, with no border, header or
  background of its own. Under it the Workshop shows a Stop button, its Send chip, and its errors.
- `agent.send(message)` in a block shows the message under the block, with Send and Dismiss.
  Nothing reaches the kernel until the viewer clicks Send. Send uses the composer's send path,
  exactly as if the viewer had typed the message, and waits whenever the composer waits.
- A block with no content shows an error and runs nothing.
- `env.NAME = value` in `executeCode` saves `NAME` for the chat when the call's step is stored:
  JSON data of at most 256 KiB, or an alias of one of the chat's bindings. A chat keeps at most 16
  names. Later `executeCode` calls in the chat see them in `env`.
- A block whose tag lists names, as in `<inline-html env="A,B">`, gets an `env` with just those
  names: `await env.A` for saved data, `env.A.rpc.method()` for a Gadget, and `env.A.method()` for
  a connection. A view reaches no models, agent spawners, auto-provided services, worktrees, `GIT`
  or a Gadget's `exports`.
- A connection call from a view is recorded in the action log, with the view as its caller. A
  write waits as an action in the chat until a person approves it.

## Locked decisions

- **A view's tag gives it `env`.** This reverses the decision "A view has no `env`", locked on
  2026-10-28 and recorded here until now, and its "Future work" entry "Bindings in views". Kenton
  asked for this shape in review of #950 on 2026-11-05: `executeCode` assigns properties of `env`,
  which join the agent's bindings, and `<inline-html env="FOO,BAR">` makes `FOO` and `BAR`
  available to the view, data or live RPC objects over Cap'n Web. Measured:
  - 2026-10-29 (view benchmark, first run, commit `f70d1f437`, about 80 ladder view turns per
    arm): views with bindings (#930) passed 93%, inline views with `embedView` 98%, inline views
    alone 95%. No pair differed beyond noise (Fisher exact p ≥ 0.17). On Gadget data, views with
    bindings took 1.2 steps and 20.2K prompt tokens against 2.6 and 68.5K for inline views alone.
  - 2026-11-05 22:08 to 22:42 UTC (third run, commit `ab21069d4`, 81 ladder view turns per arm):
    inline views with saved env passed 73 of 81, inline views with `embedView` 76 of 81 (Fisher
    exact p = 0.56). Saved env took 1.6 steps and 22.6K prompt tokens against 1.1 and 14.9K. The
    extra request is the cost: on Gadget data a whole turn took 24.9 s against 15.3 s on
    gpt-6-luna, and 97-113% of the extra input was cached. Changing a view it had just shown,
    saved env drew first in 6.9 s, 4.3 s and 10.4 s (gpt-6-luna, claude-haiku-5-5, Kimi K3) against
    15.8 s, 10.5 s and 27.6 s.
  The results are in `~/Desktop/inline-ui/view-bench/` and `plans/view-bench.md` on the
  `explore/view-bench-env` branch.
- **A save lands with its step.** A save is an effect of the `executeCode` call that made it, so
  it is durable iff the call's transcript record is, as a worktree commit is. The turn buffers the
  step's saves and the step's barrier writes them in its transaction. A crash mid-step loses both.
- **The agent saves, then writes the view in its next response.** A view's module scripts run as
  soon as its block closes, before any tool call in the same answer, and a save lands only when its
  step is stored. A turn whose view and save came in one response, ended once the save landed, was
  probed on 2026-11-10: gpt-6-luna and claude-haiku-5-5 wrote both in one response in 0 of 3 turns
  each, Kimi K3 in 2 of 3. So the second request stays, and there is no turn-end rule for views.
- **A saved name never shadows a chat binding.** Saving a name the chat binds is refused. A
  binding the chat gains later under a saved name wins, in `executeCode` and in views. The names
  the kernel picks for new bindings avoid saved names.
- **A view is its own caller.** The kernel opens a connection's session for a view with the caller
  `{from: "view", chatId}`, through `openGatekeeperSession`, the chokepoint every session takes.
  The connection works on the account it was made with, whoever views the chat: the account is in
  the props of the class its record stores. The view holds nothing its viewer lacks: an owner or
  build collaborator's tab can already open a session on a connection of the workspace.
- **A view's reads count for its chat; its writes go to the chat.** An observation through a view
  is attributed to the view's chat, as the agent's are, so the observer ledger checks it against
  the chat's audience. It stays in the action log and is not posted to the chat. A write is
  posted to the chat as an action, as a gadget's is, and never auto-approves.
- **The host holds every limit.** Block code runs in the bootstrap's realm (see "The host checks
  every call"), so the host serves only the names the block's tag lists, as the Workshop parsed
  them, and paces every call. The kernel checks only that the name is in the chat's scope and of
  a kind a view may reach.
- **A view with `env` cannot parse a string as HTML.** Its frame gets a Trusted Types CSP that
  makes `innerHTML` (except `= ""`), `insertAdjacentHTML` and the other ways to parse a string as
  HTML throw. Data a view reads, such as an issue title from a connection, could otherwise run as
  code with the view's bindings. A view without `env` keeps the rule below. The saved env arm was
  measured with this CSP in every view.
- **No chat gateway text.** A chat gateway gets the agent's answer as stored, tags and all.
  Nothing calls the gateway yet, and its removal is planned, so a note in place of each view was
  built, then dropped on review on 2026-11-06. The kernel then does not import the parser.
- **A block runs in a gadget-style frame.** The frame is an opaque-origin srcDoc document with
  the gadget UI CSP. A block's HTML never goes into the Workshop document, and `MarkdownMessage`
  keeps `skipHtml`. The block frame is stricter than a gadget frame in one way: its sandbox is
  `allow-scripts` only, with no popups (see "What a block can reach").
- **A view's code may parse strings as HTML, unless it has `env`.** A Trusted Types CSP that made
  `innerHTML` throw in block code was built, then dropped on review on 2026-11-04, since the frame
  is sandboxed: in the 2026-10-28 eval run, two of the views Kimi K2.7 Code drew built their markup
  with `innerHTML`, which the CSP made throw, so they showed nothing. So text a view without `env`
  shows as HTML, such as a web page the agent copied into it, runs as the view's code: it can
  redraw the view, replace the message the view asks to send, and use WebRTC (see "Known edge
  cases"). It has no `env`, the Send chip shows the whole message, and only the viewer's click
  sends it.
- **The tag is `<inline-html>`.** A block is HTML in the answer, not a gadget: it has no server
  and no files. Its `env` holds only what its tag lists.
- **Markdown decides what is code.** A tag line in a code block, as the chat renders it, stays
  prose, so a code example of a view never runs. The parser asks `mdast-util-from-markdown`, the
  parser react-markdown draws the chat with. Hand-written fence and list rules were built, then
  dropped on review on 2026-11-05: review found answers where they ran an example the chat showed
  as code, after a thematic break (`* * *`), an item numbered 2 under a paragraph, a lazy list
  line and an HTML block. The Markdown parser read all 13 test answers as the chat does. The cost,
  measured on 2026-11-05: 90 KB minified (28 KB gzip), in the frontend, which already carries it
  for react-markdown, and about 3 ms per KB of prose since the last view, paid only when a tag line
  follows three backticks or tildes in it. A code example of many tag lines is parsed in time
  linear in its length: review found a parse per tag line quadratic, and then a parse of the rest
  of the answer per view quadratic, on 2026-11-05 and 2026-11-06.
- **The answer's text is the source.** The frontend draws a block from its copy of the answer:
  the streamed text while the answer streams, and the stored message after that. A block's markup
  draws as it streams, and its module scripts run once it closes, because no later text can change
  it. The cost is that a view which ran may never be stored: a stopped or failed model request
  stores nothing, and its views go away with its text.
- **A block has no name.** A view is the block's place in its message, so the parser needs no
  rules for duplicate names.
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
- **The host checks every call.** Block code runs in the same realm as the bootstrap, so it can
  reach the frame's Cap'n Web port, for example by patching `MessagePort.prototype`. No check can
  live in the frame, so the host checks the arguments of each call it gets.

## Current-state anchors

- `GadgetUI.tsx` and block frames both build their documents from `sandboxDocument.ts`
  (`packages/workshop-frontend/src`): the Cap'n Web module URL and a head whose CSP is
  `default-src 'none'; script-src data: 'unsafe-inline'; ... connect-src 'none'`.
- `MarkdownMessage` renders message text with `skipHtml={true}`.
- `CODE_MODE_HARNESS` in `overseer.ts` runs the agent's code with `let env = this.env` and hands
  nothing back, so an assignment to `env` today is lost when the run ends.
- `executeCodeMode` builds `env` with `getEnvForAgent` and returns the run's log as a string. A
  throw in the agent's code is not a tool error: its stack joins the log. A trace that does not
  arrive within 5 s is one.
- The turn's barrier is `commitAgentStep`, called from `runAgent`'s `turn_end` handler. Worktree
  commits are the precedent for an `executeCode` effect it carries: `pendingWorktreeCommits`
  buffers them, `getBufferedHead` shows them to later calls in the step, and the barrier writes
  them. `commitAgentStep` writes nothing for a chat that is gone.
- The chat's binding scope is replayed: the seed in `chatContext.bindings`, the compaction
  checkpoint's `chatBindings`, then the names stamped on messages (`buildCompactionState` in
  `agent-compaction.ts` folds them). Names are never rebound. `chatScopeNames` and
  `prepareChatBindings` pick the names of new bindings the kernel adds.
- `openGatekeeperSession` gives every session an approval queue bound to its caller.
  `GatekeeperCaller` is `agent`, `gadget`, `user` or `hook`. `observerContextOf` maps a caller to
  the context its observations are checked against, and the ledger refuses a caller it maps to
  nothing. `#associateAction` puts an agent's actions on its step and posts a gadget's to its chat.
- `getGadgetFacet(gadgetId, chatId, joinAs)` returns a facet stub that counts toward the holder's
  session until it is disposed, as `GadgetClient.connectToGadget` uses it.
- `createRateLimitedCapability` (`packages/workshop-frontend/src/rateLimitedCapability.ts`) paces a
  stub's calls and refuses its stub members. `SandboxedGatekeeperApp` uses it with 8 concurrent
  calls, 600 a minute and 128 pending.

## Design

### Block syntax

`parseInlineHtmlBlocks(text, {streaming})` in `workshop-shared` returns a message as an ordered list
of prose and blocks. The frontend uses it to lay out a message, and the evals to find the views an
answer shows. The stored text is the streamed text joined with `""`, so provisional and stored
text parse alike, but for the last line while the answer streams (below).

- A block opens on a line that is `<inline-html>` alone, with no indent, outside a code block, and
  closes on the next line that is `</inline-html>` alone, with no indent. Trailing spaces or tabs
  do not count. A tag anywhere else is prose in an answer and HTML in a block, so prose and
  examples that mention the tag stay prose, and a block's code may write the closing tag in a
  string.
- The opening line may carry one attribute, `env` in double quotes: `<inline-html env="A, B">`.
  Its value lists names, split at commas, each trimmed. A block that lists a name that
  `validateBindingName` refuses, the name `then`, or more than 32 names is an error: "This view's
  `env` lists …". A repeated name counts once. Any other attribute, or `env` in other quotes,
  leaves the line prose, as today. The block and its open form carry the names as `env`. A block
  with no attribute has no `env`.
- An opening line is in a code block when Markdown reads it so in the prose since the last view,
  the document the chat draws it in (see "Markdown decides what is code"). A line with no indent
  ends every list item and block quote, and no indented code block holds it, so only a fenced code
  block at the top of that document can. Markdown decides a line's block from the lines before
  it, so one parse of the prose up to a point answers this for every tag line that ends by then.
  The parser parses up to the first tag line, and twice as far each time a later tag line passes
  that point. A line ends at `\n`, `\r\n` or a lone `\r`, as Markdown reads them.
- While the answer streams, its last line may still grow, so it opens or closes no block until it
  ends. Once a block opens or closes, it stays so as the answer grows. The stored answer's last
  line counts as it is.
- A block with no closing line is still streaming, or the agent did not close it. Once its
  message is stored, the chat shows an unclosed block as code and does not run it.
- The body is the HTML between the tag lines, trimmed. Its `<title>`, if present, names the view,
  with each run of whitespace read as one space, as HTML reads it.
- An open block's HTML so far is the text after its opening line, without a closing line that has
  only partly arrived or not yet ended, trimmed. It is always the start of the HTML the block has
  once it closes, so the Workshop can write it into the frame as it grows.
- A body that is empty once its `<title>` is removed is an error: "This view has no content." It
  shows an error and runs nothing.
- Only agent answers can hold blocks: stored messages of type `message` with an author of type
  `agent`, and the text an agent streams. The parser runs on nothing else.

### What a block can reach

| In the frame | Reaches | Rule |
|---|---|---|
| `agent.send` | A message shown under the block | Only the viewer's click on Send calls the kernel, through `sendChatMessage`, as the viewer's own message. |
| Saved data (`env.NAME`, listed in the tag) | The JSON the chat's `executeCode` last saved under `NAME` | `await env.NAME`. Read when the code first touches the name. |
| Gadgets (listed in the tag) | The Gadget's server, at the chat's version | `env.NAME.rpc.method()`, as in `executeCode`. Calls are paced. A write through a Gadget method needs no approval, as from a gadget's own UI. |
| Connections (listed in the tag) | A session on a connection the user made, with the view as caller | `env.NAME.method()`. Reads are recorded in the action log. Each write waits as an action in the chat for a person's decision. Calls are paced. |
| Names the tag does not list, models, agent spawners, auto-provided services, worktrees, `GIT`, a Gadget's `exports` | Nothing | The host serves only the tag's names. The kernel refuses the other kinds. |
| Popups, other frames, the network | Nothing but WebRTC | `sandbox="allow-scripts"`, CSP `connect-src 'none'`, and the Workshop's `frame-src srcdoc:`. WebRTC is the exception (see "Known edge cases"). |

Gadget UI frames keep `allow-popups` and `allow-popups-to-escape-sandbox`. So agent-written
`client.js` can still open a link that carries data out, even after the workspace has read
restricted data. This plan does not change gadget frames.

### Saving env (kernel)

- **Capture.** `CODE_MODE_HARNESS` keeps a map of `env` as the run starts. Once the agent's
  function returns, it hands back each name the run added or replaced. A value that is the very
  object another name held when the run started is an alias of that name. Otherwise the harness
  checks that the value is JSON data (plain objects and arrays of strings, finite numbers,
  booleans and null, with no cycles) and at most 256 KiB as JSON, and hands back its JSON text, or
  what keeps it from being saved, by path (`env.ROWS[3].when is a Date`). A run that throws hands
  back nothing, so it saves nothing. `CodeModeEntrypoint.run` returns the changes.
- **Decision.** `executeCodeMode` decides each name, in order, against the chat's saved names and
  the step's pending saves. It refuses a name that `validateBindingName` refuses, one the chat
  binds, one a pending connection request claims, `GIT`, `then` (an `env.then` would make the
  view's `env` look like a promise), a new name past the 16th, and a value that is neither JSON
  data nor an alias. An alias of a saved alias names its binding. One refused name refuses no
  other. The tool's output gets one line per name:
  `Saved env.TOTALS (data) for views and later code.`, `Saved env.SALES (the binding env.EXPENSES)
  for views and later code.`, or `env.X was not saved: …`. `executeCodeMode` returns the log and
  the accepted saves.
- **The step's buffer.** `runAgent` holds the step's accepted saves beside
  `pendingWorktreeCommits`, and passes them to each later `executeCode` call in the step, so the
  second call sees what the first saved. A later save of a name in the step replaces the earlier
  one. The barrier passes them to `commitAgentStep` as `envSaves`, which writes them in the step's
  transaction. It writes nothing for a chat that is gone. A failed tool call (a `verify()` error,
  a lost trace) buffers nothing.
- **Storage.** A new collection, `chatEnv`, of `ChatEnvRecord = {chatId, name} & ({kind: "data",
  json} | {kind: "alias", target})`, keyed by `chatEnvKey(chatId, name)`, which is
  `chatKeyPrefix(chatId) + name`, so one chat's names list by prefix. `deleteChat` sweeps it.
- **Later runs.** `executeCodeMode` layers the chat's saved names, then the step's pending saves,
  under `getEnvForAgent`'s bindings: a name the chat binds is never replaced. Data goes in as the
  parsed value. An alias is set inside the harness to the object its target holds, so the run can
  save it again by name.
- **Names.** `chatScopeNames`, `prepareChatBindings`' `taken` set and the turn's `isNameInScope`
  count saved names, so a binding the kernel or the agent names later picks another name (see "A
  binding that takes a saved name").
- **The tool description.** `EXECUTE_CODE_TOOL_DESCRIPTION` gains one sentence (see "Agent
  instructions"). The spawned agent's description is unchanged: its chat saves the same way, but
  no one asked it for a view.

### A view's env (kernel)

- **RPC.** `Overseer.connectToChatBinding(chatId, name): Promise<ViewBinding>` opens one name of
  the chat's scope for a view. `ViewBinding` is `{type: "data", json}`, `{type: "gadget", rpc}` or
  `{type: "connection", session}`. `json` is the saved text, which the host parses, so the API
  carries no `unknown`. `OverseerClientInterface` implements it, under its `@validateRpc()`.
  `UseOverseerInterface` denies it, as it denies the chat.
- **Resolution.** `OverseerImpl.openViewBinding(chatId, name, joinAs)` resolves `name` as the
  agent's `env` does. A chat binding wins. `resolveChatBinding(chatId, name)` folds the seed, the
  active checkpoint's `chatBindings` and the messages after it, with the fold that
  `buildCompactionState` uses, taken out into `foldChatBindings`. Then a saved name: data is
  returned as it is, and an alias resolves its target as a chat binding.
- **Kinds.** A Gadget (`gadgets` record of type `gadget`): the kernel materializes the chat's
  changes, then returns `getGadgetFacet(id, chatId, joinAs)`. A connection the user made
  (`creationSpec.type === "gatekeeper"`): `openGatekeeperSession(id, facet, {from: "view",
  chatId})`, wrapped so that it counts toward `joinAs` until it is disposed, as the facet stub
  does. Anything else is refused: "`NAME` can't be used in a view." That covers model and spawner
  gatekeepers, auto-provided services (`creationSpec.type === "ambient"`), connections made before
  `creationSpec` existed, worktrees and agent callback values. The automatic `GIT` binding is not
  a chat binding, so a view never reaches it. A Gadget's `exports` is not in the returned stub.
- **The view caller.** `GatekeeperCaller` gains `{from: "view", chatId}`. `observerContextOf` maps
  it to the chat. `#associateAction` posts a view's action to its chat as it posts a gadget's, and
  leaves its observations in the action log only. `submitAction` stores a view's action with
  `autoApprovable: false`. `awaitDecision` stays an agent's only.

### Rendering (frontend)

- `ChatInterface` splits each agent answer with `parseInlineHtmlBlocks`. Prose still goes through
  `MarkdownMessage`. Each block becomes a view in place: the frame, then a muted line that says
  "Live view", with a Stop button that shows on hover or focus. The `<title>` is the frame's
  accessible name. Copy still copies the raw message.
- **No box.** The view has no border, header or background. A box marks where the view's area
  ends, so without one a view can imitate the transcript around it, such as a user's message or
  an approval card. That can mislead a reader, but it cannot act: approvals, the Send chip and
  every other action that matters stay in Workshop DOM. The muted line is the one mark under every
  view that the frame cannot draw. A box would not have stopped imitation either, since a view can
  draw a fake box edge and fake transcript inside its own area.
- **Stop.** Stop unmounts the frame, so a viewer can end a view that loops or floods its chip
  while it is on screen. The line then says "View stopped", and Run starts the view again.
- **Streaming.** The answer that streams in is drawn as the message it will become.
  `buildChatDisplayEntries` takes the streamed text and reasoning and adds them as the last
  message entry, marked `streaming`, so the agent's model-change row and the row's spacing come
  out as they will once the message is stored. The row uses the stored agent row's markup. It has
  no actions and looks nothing up by sequence. An open block is already a view: its markup draws
  as it streams, and its line says "Drawing…" in place of "Live view" until it closes, with Stop
  as before. A block that closes with no content then shows its error, and its frame goes away.
  Tool calls in progress, "Thinking" and "Compacting" stay below the row, as they are today.
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
- **Frame interfaces.** The host exports `UiBlockHost` to the frame. It has
  `requestMessage(message)`, `resize(height)`, `reportError(message)` and `binding(name)`. The
  frame exports `UiBlockFrame`, with `setTheme(theme)`, `write(html)` and `close()`. Both are typed
  and documented in `features/chat/uiBlockFrame.ts`, beside the bootstrap. The frontend has no
  capnweb-validate transform, so the host checks its own arguments.
- **Connection.** The Workshop checks the handshake as `GadgetUI` does: the message must come from
  the view's own frame window, with origin `"null"`.
- **Shell.** A frame loads a shell: the sandbox head, the frame's style in the theme of that
  moment, and one bootstrap module, whose URL is built once per page, since it embeds all of
  Cap'n Web. The bootstrap waits for the shell's `load` event, so that the event cannot fire in
  the block's document once `write` opens it. It then sets up the Cap'n Web session and defines
  `globalThis.agent`, which has one method, `send(message)`, and `globalThis.env` (see "A view's
  env"). The shell of a block with `env` also carries the Trusted Types CSP, whose two policies
  the bootstrap takes before any block code runs: one writes the block's document, and the
  default one lets code clear an element with `""` and refuses any other string.
- **Writing the block.** After the handshake the host calls `write` with the start of the block
  document (its doctype, and a head with the frame's style in the theme of that moment), then with
  the block's HTML so far, then with each new part as the answer streams, and calls `close` once
  the block closes. A stored block takes the same path, with all of its HTML in one `write`. The
  host settles each call, and the bootstrap each of its own calls to the host, so that Cap'n Web
  releases it: a block streams in many parts, and its view resizes as it grows. The first `write`
  calls `document.open()`, and each one calls `document.write()`, so the browser's own HTML
  parser adds the markup as it arrives, as it does for a page that loads slowly. A tag or a text
  that one part cuts in two joins up with the next part. Classic scripts
  and `async` module scripts run, and inline event handlers listen, as soon as they are parsed.
  Other module scripts wait until `close` ends the document, then run in document order, so a
  block's `<script type="module">` sees all of its markup and `agent`. Checked in Chromium 150,
  Firefox 157 and Safari's WebKit:
  - The CSP that the shell's `<meta>` set stays after `document.open()`, because the document
    keeps its policy container. Code in the new document still has no network apart from WebRTC.
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
- **One session per load.** Each load of the frame's document handshakes once, and the host
  answers each handshake with a new session: it disposes the old one, clears the Send chip and the
  code error, and writes the block from the start, as `GadgetUI` reconnects a gadget's frame. A
  view whose code reloads its document, such as a "Play again" button calling
  `location.reload()`, starts again. The Workshop's `frame-src srcdoc:` keeps the frame on its
  srcdoc, and Send still needs the viewer's click. The cost: a view that reloads itself as it loads
  reloads until the viewer stops it or scrolls it away. Stopping the view on a second handshake
  instead was built, then dropped on review on 2026-11-06.
- **A view's env.** `globalThis.env` is a Proxy, as `env` was in the views-with-bindings frame
  (#930): reading a string name other than `then` returns `host.binding(name)`, so `await env` asks
  for nothing. The bootstrap keeps each name's promise, so `env.A` stays one object and its first
  read is its one kernel lookup. Data resolves to its value; `env.A.rpc.method()` and
  `env.A.method()` pipeline through the promise. A view with no `env` attribute gets no `env`
  global. The host refuses a name its tag does not list, checked against the names in the
  Workshop's own parse of the answer, so code that reaches the port directly gains nothing. It
  opens each name once with `overseer.connectToChatBinding(chatId, name)`, parses saved JSON, and
  wraps a Gadget's `rpc` or a connection's session in `createRateLimitedCapability` with the
  gatekeeper app's limits (8 concurrent calls, 600 a minute, 128 pending, throttled). It disposes
  every stub it opened, and each limiter, when the session ends: a new handshake, Stop,
  unmounting, or a reload. A stub that arrives after that is disposed at once. `UiBlockCard` gets
  the chat's id and an `onOpenBinding` callback from `ChatInterface`, beside `onSendMessage`.
- **Reconnect.** A view with `env` holds kernel stubs, which die with the kernel session. When
  `ChatInterface` gets a new overseer stub, a view with `env` remounts its frame, so its code runs
  again with new stubs. A view without `env` holds no kernel stub, and stays as it is.
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
  Scrolling far away unmounts the frame, so the number of live frames is bounded by what is near
  the screen. A view keeps its last height while its frame is gone, so the transcript does not
  jump.
- **Errors.** Block console output goes nowhere. It must not reach the pane's buffer, which the
  composer offers to the agent. An uncaught error in block code shows under the view, which keeps
  running. No automatic error reporting captures block errors, since blocks are agent-written
  code.

### Agent instructions

- The guidance on when to create a Gadget is main's: a request for an app gets a Gadget. A
  sentence that made a one-off demo, tool or visual a view even when the user called it an app
  was dropped on review on 2026-11-06.
- The view section: when to draw one, the syntax, with the tags on lines of their own, with no
  indent, outside code fences, that the view's markup draws as the agent writes it and its module
  scripts run as soon as its block closes, so any style comes first, then the markup, and the
  script last, that the `<title>` is not shown and the view sits in the answer with no border or
  padding around it, module scripts, that a view has no network, that the code runs again on each
  mount and for each viewer, `agent.send` in the user's words, the Kumo colour tokens, the height
  rules, and that a view keeps no state. The example writes its data into its script and builds
  its bars with `createElement` and `textContent`, since models copy the example more than they
  follow the rules.
- The section's sentence "A view shows only what you write into it: it has no `env` and no
  network. To show data from Gadgets, connections or the web, read it with `executeCode` first,
  then write the values into the view's code." becomes "A view has no network." The module-script
  bullet says scripts see the global `agent`, and `env` when the tag has the attribute.
- A new part, "Views of data from code", carries the saved env arm's text as measured on
  2026-11-05, with `<gadget-ui>` read as `<inline-html>`: save the data on `env` from
  `executeCode`, then list its name in the view's `env` attribute and read it there, so the data
  never passes through the answer; the view runs as soon as its block closes, before any tool
  call in the same answer, so save first and write the view after. Its example is the `FOOD` code
  and answer in "Goal". Then four rules: what `env.NAME = value` saves and its limits; what
  `<inline-html env="A,B">` gives the view's code and what it never reaches, and that a
  connection call uses the connection's own account and each write waits for approval; that in a
  view with `env`, `innerHTML` and the other ways to parse a string as HTML throw, so data goes
  in with `textContent`, and SVG with `createElementNS`; and that code that runs on load must
  only read, and no code may poll or call in a loop.
- `executeCode`'s description gains the arm's sentence: "The code can also save data on `env` for
  a view in your answer and for later code, as in `env.SALES = rows` (see "Live views")."

### Evals

- `RenderedView.open(html, binder, env)` in `workshop-evals/src/view-host.ts` runs a view with an
  `env` that serves the names its tag lists and nothing else. Saved data comes back as its value,
  a Gadget as `{rpc}` and a connection as its methods, each call recorded. The binder is the
  session's `connectToChatBinding`, which `WorkshopAgentSession` gains in
  `integration-tests/src/agent-session.ts`. A view with `env` gets the Workshop's Trusted Types
  CSP there too. The benchmark's eval host did all of this (commits `ee3b9a2f3` and `411f51e4a`).
- `turnViews` in `evals/views.ts` keeps each block's names, and `view-comes-after-its-gadgets`
  fails a view that lists a name its own message, or a later one in the turn, creates or saves.

## Rejected alternatives

- **Raw HTML in Markdown.** It would run agent-written code in the Workshop document, with the
  Workshop's authority.
- **A tool call that shows HTML.** Each view would cost a model round trip, and the view could not
  stream with the prose.
- **A gadget for each block.** Each one would add a gadget to the workspace list and a git
  history, and would need tool calls.
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
  `toJSON`, and `await agent` would call `then`.
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
- **Setting the frame body's `innerHTML` on each delta.** Each delta would parse the whole block
  again and replace its nodes, which loses their state. Scripts set through `innerHTML` never run,
  so the frame would have to make each one again, in order, at the end.
- **Keeping a stored block's HTML in the shell.** It would be a second way to load a view. A
  stored block takes the streaming path with one `write`.
- **Holding classic scripts and inline handlers until the block closes.** The frame would have to
  rewrite the HTML as it streams. Module scripts already wait, and the instructions ask for module
  scripts. Code that runs early reaches the host as any block code does, and the host checks every
  call.
- **`embedView` with the view's script as a function (#914 v2, #950).** It passed 98% on
  2026-10-29. But it reads the function's source back with `Function.prototype.toString` and runs
  it again in the frame. Kenton refused that on #950: stringifying a function is a misfeature, an
  agent may write a closure whose captures do not exist in the frame, and code that runs in a
  different environment from the one it is written in cannot be type-checked there.
- **`embedView` with the view's HTML as a string or a file.** On 2026-10-29, `source` as a string
  hit a SyntaxError in 9% of view turns (17% with `data`), every one a template literal inside the
  `source` template literal. A file in a scratch worktree had no syntax errors but took 2.1 steps
  against 1.1 and 2.3× the prompt tokens; with `executeCode` reading the step's own worktree edits,
  1.8 steps and 24.6K prompt tokens against 1.1 and 13.5K for `embedView` v2.
- **Views with every chat binding and no saved data (#930).** A view then reads a Gadget or a
  connection live, but values the agent works out in code still go through the answer, and the
  view reaches every binding of the chat, not the ones it names.
- **The view and the save in one response, with the turn ending once the save lands.** Probed on
  2026-11-10 (branch `explore/view-bench-env-one`): gpt-6-luna and claude-haiku-5-5 saved first and
  wrote the view in the next response in 3 of 3 data turns each, though the instructions asked for
  one response. Kimi K3 wrote both at once in 2 of 3, and in the third pasted the saving code into
  its answer.
- **Saving straight to storage from `executeCodeMode`.** The benchmark's arm did. A save then
  outlives a step that crashes before its barrier, and needs its own check for a chat deleted while
  the code ran. The step buffer gives both for free (see "A save lands with its step").
- **A frame `env` with one getter per listed name.** The frame would need the names before the
  block's code runs, and the host's check is the boundary anyway.
- **Retargeting a view's stubs on reconnect, as `GadgetUI` does.** One forwarding target per name.
  Remounting the view runs its code again with new stubs, at the cost of a restart.

## Commits

Five commits, so the kernel and shared lines read apart from the frontend and the evals:

1. **This plan.**
2. **Kernel: saving env.** The harness's capture, `executeCodeMode`'s decisions, the step buffer
   and `commitAgentStep`'s `envSaves`, the `chatEnv` collection and its sweep in `deleteChat`, and
   saved names in the scope's name checks.
3. **Shared and kernel: a view's env.** The parser's `env` attribute, `ViewBinding` and
   `Overseer.connectToChatBinding`, `resolveChatBinding` over `foldChatBindings`, and the `view`
   caller in `observerContextOf`, `#associateAction` and `submitAction`.
4. **Frontend.** The host's `binding`, the frame's `env`, the Trusted Types CSP for views with
   `env`, the card's binding callback, and the remount on a new overseer.
5. **Instructions and evals.** The "Live views" section and `executeCode`'s sentence, the eval
   host's `env`, and the chat-views eval's view of saved data.

## Verification

- Parser unit tests (`workshop-backend/__tests__/inline-html-blocks.test.ts`, in workerd): prose
  offsets, tags that are indented, have attributes or share their line, which stay prose, tags in
  fences and their closing rules, in list items and block quotes, after thematic breaks, a
  paragraph, a lazy list line and an HTML block, unclosed blocks, several blocks in one message,
  empty bodies and title-only bodies as errors, a tag line that opens or closes no block until it
  ends while the answer streams, the same blocks at the same index among the segments at every cut
  of a streamed answer once they close, an open block at every cut at the index it closes at, with
  HTML that starts the HTML it closes with, and a long code example of tag lines parsed in linear
  time. New: an `env` attribute's names, trimmed and counted once; a bad name, `then` and a 33rd
  name as errors; other attributes and single quotes as prose; the names on an open block from
  the moment its opening line ends.
- Kernel tests (`workshop-backend/__tests__/chat-env.test.ts`, in workerd), each red before its
  change: `executeCode` saves JSON data and an alias and says so; a later run gets them, an alias
  as its binding's own object; a name the chat binds, `GIT`, `then`, a function, a `Date`, a cycle,
  257 KiB and a 17th name are refused and the rest saved; a run that throws saves nothing; a
  second call in the same step sees the first's saves; a scripted turn (pi's faux provider, as in
  `spawned-agent-tools.test.ts`) stores its saves with its step, and a turn whose chat is deleted
  mid-call stores none; `deleteChat` removes the chat's saves; a binding the kernel names later
  avoids a saved name.
- Kernel tests (`workshop-backend/__tests__/view-bindings.test.ts`): `connectToChatBinding` returns
  saved data, an alias's Gadget, a Gadget and a connection session; refuses model, spawner,
  auto-provided and pre-`creationSpec` connections, worktrees, callback values and unknown names;
  a chat binding beats a saved name; `UseOverseerInterface` denies it; a view's observation is
  attributed to its chat and not posted to it; a view's action is posted to the chat and never
  auto-approves, even under an auto-approval rule; a collaborator's stub counts toward their
  session until disposed.
- Frontend tests (`UiBlockCard.test.tsx`): a message from the frame never calls the kernel
  until Send; Dismiss; Send held while the composer is held; a failed Send; a Send that finishes
  after a newer message; a second handshake gets the whole block in a new session and clears the
  chip; an empty block shows its error and no frame, and so does an open block that closes with
  nothing but a title; a stored block's frame gets the document's start, all of the block in one
  write, then `close`; an open block's HTML reaches the frame in parts as it grows, after the
  document's start, and `close` follows the last part once it closes, in the same frame; Stop
  removes the frame, and Run gives a new frame load the start and then all of the HTML so far.
- A browser test (`uiBlockFrame.browser.test.tsx`) runs the real frame in Chromium: the calls a
  view's code makes with `agent.send` are released, though the code ignores their results. New:
  a view with `env` reads saved data and calls a fake Gadget's method; `innerHTML` throws in it and
  not in a view without `env`.
- Frontend tests (`UiBlockCard.test.tsx`), new: the host refuses a name its tag does not list,
  opens each name once, paces a stub's calls, and disposes every stub on a new handshake, Stop and
  unmount; a stub that arrives after the session ends is disposed; a new overseer remounts a view
  with `env` and leaves one without it.
- `ChatInterface` tests: an open block in a streaming answer is already a frame, and the closed
  block and then the stored message keep that frame element; a stored message whose text differs
  from the streamed text mounts its view fresh.
- Eval host tests (`workshop-evals/src/view-host.test.ts`): a view gets saved data and the
  bindings its tag lists, and nothing else.
- The chat-views eval (`workshop-evals/evals/chat-views.eval.ts`): the spending view of the
  Expense Log reads its totals through `env`, saved or as the Gadget, and a view never lists a name
  that a later step of the same turn saves or creates (`view-comes-after-its-gadgets`, from #930).
  Run on gpt-6-luna, claude-haiku-5-5 and Kimi K3.
- A browser run on the dev server with a real model: the agent draws a view from data it read with
  `executeCode`, the view follows a theme change, a click shows the message, and Send posts it as
  the viewer's message. The view's markup draws while its block streams, its module script runs
  once, at the block's close, and the stored answer does not reload it. Screenshots in light and
  dark, and after a theme change, show the view with no box around it. New: the agent saves the
  Expense Log's totals, then draws a view of them in its next response; a build collaborator's tab
  shows the same view; a view of a connection queues a write as an action in the chat; Stop, Run,
  a page reload and a dropped connection each bring the view back with its data.

## Known edge cases

- **Old messages.** A view without `env` shows its code's data of the moment the agent wrote it.
  A view with `env` reads its names when it mounts: the latest save of a name, and a Gadget's or a
  connection's current state. A later save of a name in another shape breaks the old views that
  read it.
- **A view written before its save.** If the agent writes the view in the response that saves
  its data, the view's code runs before the save lands, its read fails, and the error shows under
  it. It keeps that error until it mounts again: on scroll, Stop and Run, or a reload.
- **A binding that takes a saved name.** The name checks above should leave no path for this.
  Should a binding take a saved name anyway, it wins, and views that read the saved name get the
  binding.
- **An alias whose Gadget is gone.** A chat never drops a binding, but its Gadget can be deleted.
  `executeCode` then has no such name, as it has none for the binding, and a view gets "not a
  binding in this chat".
- **A Gadget's code change.** A view's Gadget stub dies when the Gadget's facet restarts, as on an
  agent's edit. The view's next call fails and shows its error. Mounting again opens a new stub.
- **Compaction.** Saves live beside the transcript, so compaction keeps them, but its summary may
  drop which names exist. `Object.keys(env)` in `executeCode` lists them.
- **Revert.** Reverting a chat's code changes leaves its saves.
- **Spawned agents.** A spawned agent's chat saves the same way, for its own chat only.
- **Who did it.** The `view` caller carries no user, as the `user` caller carries none, so the
  action log does not say whose view read or wrote.
- **Returned stubs.** A stub a connection's method returns, such as a cursor, is not paced.
- **A running agent.** Send while the agent runs steers that turn, as a typed message does.
- **An answer that is never stored.** A stopped or failed model request stores nothing, so its
  views go away with its text. A retried request runs its views again.
- **A block the agent never closes.** Its markup drew while it streamed, its classic scripts ran,
  and its inline event handlers listened. Once the answer is stored, the view goes away and the
  block shows as code.
- **A view drawn mostly by its script.** Markup that is only empty elements shows nothing until
  the script runs at the block's close. A `<style>` applies only once its end tag arrives. The
  instructions ask for the style first, then the markup, and the script last, so the view takes
  shape as it streams.
- **Context cost.** The block's HTML stays in the agent's message, so the model reads it again on
  each later turn until compaction summarizes that part of the chat. Saved data stays out of it.
- **WebRTC.** No CSP directive in any shipping browser covers `RTCPeerConnection`, so a view's code
  can reach STUN and TURN servers, as gadget UI frames can (`browser-export.ts` records the same
  gap). Deleting the `RTC*` globals in the bootstrap does not hold: measured 2026-10-30 in
  Chromium 156, a `srcdoc` child frame gets a fresh `RTCPeerConnection`. The fix belongs to both
  frame kinds at once. A view that reads restricted data through a connection can send it out this
  way. A gadget UI frame that reads it through its Gadget can too, and can also open a popup.

## Open questions

- Should replay give the model a short stand-in for old block HTML? Any change must handle saved
  model snapshots and compaction, and must keep the stored answer unchanged.
- Should a view's action posted to the chat name the viewer? `#associateAction` posts a gadget's
  as the workspace, through `gadgetAuthorFor`, and a view's would read the same.

## Future work

- A turn that ends once a view's save lands, should models come to write the view and the save
  in one response (see "Rejected alternatives").
- Server code in a block: the block becomes a chat-scoped gadget whose files live in the message,
  run by the gadget loader with its own storage, for views that must keep state.
- Save a block as a gadget: the block's HTML becomes a new gadget's UI.
- A small library set for charts, packaged into the frame, since the CSP blocks CDNs.
- Drop popups from gadget UI frames too, or at least once the workspace has read restricted data.
