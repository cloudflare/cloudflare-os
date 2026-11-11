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
- `env.NAME = value` in `executeCode` saves `NAME` as a chat binding when the call's step is
  stored: JSON data, or another name of one of the chat's bindings. What a chat's code carries in
  `env` by value, its saved data and any agent callback arguments, is at most 400,000 UTF-16 code
  units (see "Caps"). Later `executeCode` calls see the name in `env`,
  and `describeBinding` describes it. A data name can be saved again. No name is ever removed.
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
- **Saved names are chat bindings.** Kenton's words are that the names "get added to the agent's
  bindings", and main has the mechanism: `ChatBindingEntry`, whose `value` kind already carries a
  payload in its own collection, names stamped on messages, the folds in `buildCompactionState`,
  `chatScopeNames` and `runAgent`'s replay, and `chatBindings.set` at tool time, as `createGadget`
  does. A saved name is a new entry kind, `{type: "data"}`, whose JSON lives in `chatSavedData`;
  another name of a binding is a copy of that binding's own entry. The `executeCode` tool call
  stamps the names it saved on its record. So name checks, compaction, `describeBinding` and a
  view's lookup all work through code that exists, and nothing outside the binding map holds a
  name.
- **A save lands with its step.** A save is an effect of the `executeCode` call that made it, so
  it is durable iff the call's transcript record is, as a worktree commit is. The turn holds the
  step's JSON until the barrier, which writes it in the step's transaction. A crash mid-step loses
  both.
- **The agent saves, then writes the view in its next response.** A view's module scripts run as
  soon as its block closes, before any tool call in the same answer, and a save lands only when its
  step is stored. A turn whose view and save came in one response, ended once the save landed, was
  probed on 2026-11-10: gpt-6-luna and claude-haiku-5-5 wrote both in one response in 0 of 3 turns
  each, Kimi K3 in 2 of 3. So the second request stays, and there is no turn-end rule for views.
- **Only a data name is ever bound again.** Main's chat bindings are never rebound. A data name
  is the one exception: saving it again replaces its JSON and keeps its entry, so its place in the
  map and every other name's stay as they were. A save under any other name in scope is refused,
  and nothing else may take a data name, since `isNameInScope` sees it.
- **A view is its own caller.** The kernel opens a connection's session for a view with the caller
  `{from: "view", chatId}`, through `openGatekeeperSession`, the chokepoint every session takes.
  `{from: "user", chatId}` already maps to the chat, but it is a slash command's caller: its
  actions take the auto-approval rules as any caller's do, and `#associateAction` posts nothing
  for it. A view needs its own policy: its actions never auto-approve and are posted to the chat,
  it cannot bind hooks, and its calls end with its chat. The connection works on the account it
  was made with, whoever views the chat: the account is in the props of the class its record
  stores. The view holds nothing its viewer lacks: an owner or build collaborator's tab can
  already open a session on a connection of the workspace.
- **A view's reads count for its chat; its writes go to the chat.** An observation through a view
  is attributed to the view's chat, as the agent's are, so the observer ledger checks it against
  the chat's audience. It stays in the action log and is not posted to the chat. A write is
  posted to the chat as an action, as a gadget's is, and never auto-approves.
- **The host holds every limit.** Block code runs in the bootstrap's realm (see "The host checks
  every call"), so the host serves only the names the block's tag lists, as the Workshop parsed
  them, and paces connection calls. The kernel checks only that the name is in the chat's scope,
  of a kind a view may reach, and that the chat still exists.
- **A view with `env` cannot parse a string as HTML, or it does not run.** Its frame gets a
  Trusted Types CSP that makes `innerHTML` (except `= ""`), `insertAdjacentHTML` and the other ways
  to parse a string as HTML throw. Data a view reads, such as an issue title from a connection,
  could otherwise run as code with the view's bindings. Where the bootstrap cannot install the
  policy, or a probe shows it is not enforced, the host never writes the block and shows an error.
  A view without `env` keeps the rule below. The saved env arm was measured with this CSP in every
  view.
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
  checkpoint's `chatBindings`, then the names stamped on messages. `runAgent`'s replay and
  `buildCompactionState` (`agent-compaction.ts`) fold them; `chatScopeNames` and
  `prepareChatBindings` scan the same stamps to name new bindings. The comment above
  `chatBindings` in `runAgent` states the rule: "Names are never rebound, so resolution is
  replay-deterministic." `isNameInScope` enforces it at tool time, so no tool claims a name the
  map holds. Replay of seeds, pasted resources, accepted connections and "changes" messages also
  keeps the first entry (`if (!chatBindings.has(name))`). The same comment says "the first name
  inserted for a target wins reverse lookups", which `chatNameFor` relies on.
- `ChatBindingEntry` is `workpiece` or `value`. A `value` entry is an agent callback's arguments:
  its payload is in `agentCallbackArgs`, keyed by the callback message's sequence, and
  `getEnvForAgent` copies it into the run's `env` (`env[name] = stored.args`), so every run carries
  it. `describeBinding` has a case for each kind, and a `satisfies never` default.
- `createGadget` sets its name in the turn's `chatBindings` when the tool runs, and stamps it on
  its tool call's record, which replay reads.
- `openGatekeeperSession` gives every session an `ApprovalQueueImpl` bound to its caller, whose
  `authorizeObservation`, `submitAction` and `bindHook` pass the caller on. `bindHook` credits a
  caller that is not a gadget to the workspace's first gadget. `GatekeeperCaller` is `agent`,
  `gadget`, `user` or `hook`. `observerContextOf` maps a caller to the context its observations are
  checked against, and the ledger refuses a caller it maps to nothing. `#associateAction` puts an
  agent's actions on its step and posts a gadget's to its chat. `submitAction` checks the
  connection, not a chat.
- `getGadgetFacet(gadgetId, chatId, joinAs)` returns a facet stub that counts toward the holder's
  session until it is disposed, as `GadgetClient.connectToGadget` uses it.
  `GatekeeperClientImpl.openSession` returns a session that is not counted; only the client is.
- `createRateLimitedCapability` (`packages/workshop-frontend/src/rateLimitedCapability.ts`) paces a
  stub's calls and refuses its stub members. `SandboxedGatekeeperApp` uses it with 8 concurrent
  calls, 600 a minute and 128 pending. Its `dispose` only clears the resume timer: queued calls
  stay queued, and a call that finishes afterwards drains the queue and may arm the timer again.
  `GadgetUI` does not pace `connectToGadget`'s stub.

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
  `validateBindingName` refuses, or the name `then`, is an error: "This view's `env` lists …". A
  repeated name counts once. There is no limit on how many names a tag lists: the host opens a
  name only when the view's code first reads it. Any other attribute, or `env` in other quotes,
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
| Gadgets (listed in the tag) | The Gadget's server, at the chat's version | `env.NAME.rpc.method()`, as in `executeCode`. Not paced, as `GadgetUI` does not pace its gadget. A write through a Gadget method needs no approval, as from a gadget's own UI. |
| Connections (listed in the tag) | A session on a connection the user made, with the view as caller | `env.NAME.method()`. Reads are recorded in the action log. Each write waits as an action in the chat for a person's decision. Hooks are refused. Calls are paced. |
| Names the tag does not list, models, agent spawners, auto-provided services, worktrees, `GIT`, a Gadget's `exports` | Nothing | The host serves only the tag's names. The kernel refuses the other kinds. |
| Popups, other frames, the network | Nothing but WebRTC | `sandbox="allow-scripts"`, CSP `connect-src 'none'`, and the Workshop's `frame-src srcdoc:`. WebRTC is the exception (see "Known edge cases"). |

Gadget UI frames keep `allow-popups` and `allow-popups-to-escape-sandbox`. So agent-written
`client.js` can still open a link that carries data out, even after the workspace has read
restricted data. This plan does not change gadget frames.

### Saving env (kernel)

- **The entry.** `ChatBindingEntry` gains `{type: "data"}`. Its JSON is in a new collection,
  `chatSavedData`, of `{chatId, name, json}`, keyed by `chatSavedDataKey(chatId, name)`, which is
  `chatKeyPrefix(chatId) + name`. Another name of a binding, as in `env.SALES = env.EXPENSES`, is
  a copy of `EXPENSES`'s own entry under `SALES`: a `workpiece` entry for a Gadget, connection or
  worktree. So it resolves as its target does everywhere, and needs no kind of its own. Another
  name for agent callback arguments is refused: it would carry the same arguments into every run
  again, views refuse them, and the run reaches them by their own name. `deleteChat` sweeps
  `chatSavedData` beside `agentCallbackArgs`.
- **Keyed by name, not by sequence.** A `value` payload is keyed by its message's sequence, since
  each callback has its own arguments. A data name holds one value at a time, and nothing reads an
  older one: a revert "changes what the chat proposes, not what was said" (`refoldChatCompactions`),
  so it keeps every message and every checkpoint's `chatBindings`; messages go only with their
  chat. A checkpoint's `{type: "data"}` entry under a name therefore always means that name's
  current JSON. Keyed by sequence, every replaced value would stay stored, read by nothing, until
  the chat is deleted.
- **Saving a data name again.** Allowed: changing a view the agent just drew is the common case,
  and the env arm was measured with it. The JSON is replaced and the entry stays where it is in
  the map, so no other name moves and `chatNameFor`, which looks only at `workpiece` entries, is
  unaffected. Replay stays deterministic: every reader folds the log in order and treats a later
  save of a data name as a no-op on the map. Another name of a binding is never saved again: its
  entry is a `workpiece` or `value` entry, which the rule above refuses to rebind.
- **A save and a new binding in one step.** A step's tool calls run in order, and `createGadget`,
  `createWorktree`, `createExternalResource` and a save each set their name in `chatBindings` as
  they run. A save after a create of the same name finds a `workpiece` entry and is refused. A
  create after a save finds the name in `isNameInScope` and is refused, as for any taken name. A
  `requestConnection` claims its name the same way. Replay and `buildCompactionState` read the
  step's tool calls in the same order, so they agree with the turn.
- **No name is removed.** `delete env.FOOD` in a run leaves `FOOD` saved, and the output says so:
  "env.FOOD is still saved: a saved name can't be removed; save it again to replace it." So a chat
  near its total cap shrinks a value (`env.FOOD = null`) to free room.
- **Capture.** `CODE_MODE_HARNESS` gets the chat's data names from a small module, as the env arm
  did (`env-api.js`). At the start of the run it keeps each `env` value, and the JSON text of each
  data name. Once the agent's function returns, it hands back, through `CodeModeEntrypoint.run`'s
  result: each name added or replaced; each data name whose JSON text now differs (a change in
  place, as in `env.FOOD.weeks.push(x)`), which is saved like an assignment; and each data name
  deleted. A new value that is the very object a name other than a data name held at the start is
  another name of that binding. Anything else must be JSON data (plain objects and arrays of
  strings, finite numbers, booleans and null, with no cycles), and the harness hands back its
  JSON, or what keeps it from being data, by path (`env.ROWS[3].when is a Date`). A run that
  throws hands back nothing, so it saves nothing.
- **The kernel checks what the harness hands back.** The agent's code runs in the harness's
  isolate and can replace its globals, so `executeCodeMode` trusts only the result's shape: it
  measures each JSON text itself and checks that it parses. Then it decides each name in order. It
  refuses a name `validateBindingName` refuses; a name in scope that is not a data name: one the
  chat binds as anything but data, `GIT`, a name a pending connection request claims (runAgent
  passes the turn's `claimedNames`), or a name saved as another name earlier in the run; another
  name whose target is not one of the chat's own names (it must pass `validateBindingName` and be
  an own property of `bindings`, so a tampered harness can't name `toString`), is saved data, or
  is callback arguments; and a
  save that would take what the chat's code carries by value past the cap, unless it shrinks its
  name. The harness reports a value too long to save by its length alone, so its result stays
  small. One refused name refuses no other. The output
  gets one line per name: `Saved env.TOTALS (data) for views and later code.`, `Saved env.SALES
  (another name for env.EXPENSES) for views and later code.`, or `env.X was not saved: …`.
- **Tool time.** `runAgent` then sets each accepted name in `chatBindings`, as `createGadget` does,
  holds each data name's JSON in the step's `pendingSavedData`, beside `pendingWorktreeCommits`,
  and stamps the saved names on the tool call's record: `savedEnv: {name, alias?}[]`, where
  `alias` names the binding whose entry a name copies. A later call in the same step gets the
  pending JSON through `getEnvForAgent`, which reads `pendingSavedData` before `chatSavedData`:
  `runAgent` passes it, with its claimed names, as `executeCodeMode`'s `savedEnv` parameter,
  beside `bindings`.
- **The barrier.** `commitAgentStep` takes the step's `savedData: {name, json}[]` and writes it in
  the step's transaction, with the record that stamps the names. It writes nothing for a chat that
  is gone. A failed tool call (a `verify()` error, a lost trace) stamps and holds nothing. A save
  is buffered only after `executeCodeMode` returns, and the call then returns at once; pi records
  a call as an error only when it threw or its result says so, and runs no `afterToolCall` here,
  with tool calls run in sequence, so a buffered save's call is always recorded with its stamp,
  even in a step the user stopped.
- **Caps.** One cap on what a save controls, 400,000 UTF-16 code units for what an `executeCode`
  run's `env` carries by value: each data name with its JSON text, measured as `json.length` as
  `MAX_SUBRESOURCES_TOTAL_LENGTH` measures in `observer-ledger.ts`, and each agent callback's name
  with its arguments, measured as JSON would write them, a stub counting 64 (`envValueLength`,
  which reads no member of a stub). A save that grows a name past the cap is refused; one that
  shrinks a name always lands, so a chat over the cap through its callbacks can come back under
  it. Callback arguments arrive unbounded (`deliverAgentCallback`), so the env build enforces the
  platform's limit itself: `#fitEnv` measures the `env` a run would carry in bytes as V8
  serializes it (one byte a code unit for Latin-1 text, two otherwise), and past 1 MiB less 64
  KiB it leaves out saved data names, largest first, then callback arguments, largest first, and
  names each in the run's output. A name left out is still saved, and `env.NAME = null` lands as
  a shrinking save, so the chat recovers. Its reason:
  - Every `executeCode` run carries all of it into its Dynamic Worker, and workerd refuses an
    `env` over 1 MiB: "Dynamic Worker env size (1900053 bytes) exceeds the maximum allowed size of
    1048576 bytes", observed in this branch's workerd tests when a first build tried 2,000,000
    units. The platform docs do not list this limit; that production enforces
    the same one is [INFERENCE]. So the data goes into `env` as its JSON text, the smallest form
    (the harness parses it), and a string serializes at up to two bytes per code unit: 400,000
    units are at most 800,000 bytes, which leaves room for the stubs of the chat's other bindings.
    Callback arguments count because main already copies them into every run's `env`; a review on
    2026-11-11 found that a save under a data-only cap could pass while a large callback made
    every later run fail to start, including the one meant to shrink it.
  - The same bound keeps each `chatSavedData` record under 800 KB plus its other fields:
    typed-storage writes it with V8 serialization, which stores a string with any character above
    U+00FF at two bytes per code unit, well inside the 2 MB value limit `observer-ledger.ts` cites
    (and the 8 MB the platform documents today,
    <https://developers.cloudflare.com/durable-objects/platform/limits/>). The write runs inside
    `commitAgentStep`'s transaction, where a storage error would kill the turn and lose its step,
    so the kernel refuses an oversized save when the code returns.
  - Each run also reads every data name's JSON from storage in the Overseer, whose 128 MB isolate
    every chat of the workspace shares, and the Dynamic Worker's own isolate parses it beside the
    agent's work (<https://developers.cloudflare.com/workers/platform/limits/>).
  - No separate per-value cap and no cap on the number of names: the total bounds what a run and
    a record pay, and a name costs only its entry. The env arm's 16 names and 256 KiB had no
    stated reason, and the plan's earlier 500,000 and 2,000,000 did not fit the env limit.
- **Readers of the binding map.** Each place that folds or reads it gets the new kind:
  - `runAgent`'s replay of an `executeCode` call sets each stamped name: a data name as
    `{type: "data"}` unless the map has it; another name as a copy of its target's entry.
  - `buildCompactionState` does the same in its tool-call loop, so checkpoints carry data entries.
  - `chatScopeNames` and `prepareChatBindings`' `taken` set add each stamped name.
    `prepareChatBindings` gives no `nameByTarget` entry for another name of a binding, so a
    pasted resource still takes its target's first name.
  - `isNameInScope` sees data names through `chatBindings`, unchanged.
  - `getEnvForAgent` gains `case "data"`: the pending or stored JSON text, which the harness
    parses. A missing record throws, as a missing `value` record does.
  - `describeBinding` gains a case: `env.NAME` is JSON data this chat's `executeCode` saved, which
    a later save replaces and a view reads with `await env.NAME`.
  - `resolveToolWorkpieceId`, `setGadgetBinding` and `forgeRestoreStubForBinding` already refuse a
    non-`workpiece` entry. `setGadgetBinding`'s message, which says such an entry holds callback
    arguments, names the entry's kind instead.
  - `resolveChatBinding`, for views, folds with the same code (see "A view's env").
- **The tool descriptions.** `EXECUTE_CODE_TOOL_DESCRIPTION` and
  `SPAWNED_EXECUTE_CODE_TOOL_DESCRIPTION` gain one sentence (see "Agent instructions"): a spawned
  agent's chat saves the same way, and its runs print the same lines.

### Storage and rollback

- **Types.** In `storage-schema/overseer-storage.ts`:
  `ChatBindingEntry = {type: "workpiece"; id: WorkpieceId} | {type: "value"; messageSequence:
  number} | {type: "data"}`, and a collection `chatSavedData: collection<{chatId: number, name:
  string, json: string}>()({primaryKey: entry => chatSavedDataKey(entry.chatId, entry.name)})`,
  with no index. In `workshop-shared/src/api.ts`, the `executeCode` member of `AiToolCall` gains
  `savedEnv?: {name: string, alias?: string}[]`, documented. `GatekeeperCaller` gains
  `{from: "view"; chatId: number}`, stored in `ActionRecord.caller`.
- **No migration and no version bump.** `typed-storage` has no versioning ("(someday) versions and
  migrations", `typed-storage/src/index.ts`). A new collection starts empty and has no index to
  `rebuild()`. The new entry kind, field and caller are additive: no stored record changes shape.
  `chatModelData` (`a073c8b28`) and `pendingAgentCalls` (`8dde840b5`) were added without a bump.
  The rule in `overseer-migrations.ts` ("A change to what a workspace has stored needs a new
  version") is about records that change; it is read so here, and reviewers should confirm it.
- **Rollback.** See "Rollback" in "Known edge cases".

### A view's env (kernel)

- **RPC.** `Overseer.connectToChatBinding(chatId, name): Promise<ViewBinding>` opens one name of
  the chat's scope for a view. `ViewBinding` is `{type: "data", json}`, `{type: "gadget", rpc}` or
  `{type: "connection", session}`. `json` is the saved text, which the host parses, so the API
  carries no `unknown`. `rpc` and `session` are `RpcStub<any>`, as `GadgetClient.connectToGadget`
  returns, and the method carries the one `@ts-ignore` its neighbours carry, with no second
  suppression. Each member and the method get doc comments. `OverseerClientInterface` implements
  it, under its `@validateRpc()`. `UseOverseerInterface` denies it, as it denies the chat.
- **Resolution.** `OverseerImpl.openViewBinding(chatId, name, joinAs)` first checks that the chat
  exists (`getChatMetaOrThrow`). It resolves `name` with `resolveChatBinding(chatId, name)`, which
  folds the seed, the active checkpoint's `chatBindings` and the messages after it with
  `foldChatBindings`: the loop `buildCompactionState` runs today, taken out so both use it. A
  `data` entry returns its stored JSON. A name the tag lists that is another name of a binding
  resolves as that binding, since its entry is a copy. The fold reads every message since the
  checkpoint on each name a view opens.
- **Kinds.** A Gadget (`gadgets` record of type `gadget`): the kernel materializes the chat's
  changes, then returns `getGadgetFacet(id, chatId, joinAs)`. Materializing is skipped while a turn
  runs (`checkChatExistsAndMaterializeChanges`), as it is for a gadget pane opened mid-turn. A
  connection the user made (`creationSpec.type === "gatekeeper"`):
  `openGatekeeperSession(id, facet, {from: "view", chatId})`. Anything else is refused: "`NAME`
  can't be used in a view." That covers model and spawner gatekeepers, auto-provided services
  (`creationSpec.type === "ambient"`), connections made before `creationSpec` existed, worktrees
  and callback arguments. The automatic `GIT` binding is not a chat binding, so a view never
  reaches it. A Gadget's `exports` is not in the returned stub.
- **The root stub.** Both kinds are wrapped once, as `getGadgetFacet` wraps its facet: the wrapper
  counts toward `joinAs` until it is disposed, and refuses each call once the chat is gone. A
  property of the stub gets the same wrapper, and the check runs when it is called, so
  `session.issues.list()` pipelines as Cap'n Web allows, and is refused with its chat.
- **The view caller.** `GatekeeperCaller` gains `{from: "view", chatId}`. `observerContextOf` maps
  it to the chat. `ApprovalQueueImpl` refuses `bindHook` for it ("A view can't bind hooks.") before
  anything is stored, and refuses `authorizeObservation` and `submitAction` once its chat is gone,
  as it refuses a dead hook's calls with `requireLiveHook`, and checks again at the ledger's
  synchronous commit, since the chat can go while an observation's checks await. Every write and
  every recorded read of
  the session goes through that queue, including those of capabilities the session returns: a
  GitHub cursor keeps a duplicate of its session's queue so that it outlives the session.
  `#associateAction` posts a view's action to its chat as it posts a gadget's, and leaves
  its observations in the action log only. `submitAction` stores a view's action with
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
  frame exports `UiBlockFrame`, with `setTheme(theme)`, `trustedTypes()`, `write(html)` and
  `close()`. Both are typed and documented in `features/chat/uiBlockFrame.ts`, beside the
  bootstrap. The frontend has no capnweb-validate transform, so the host checks its own arguments.
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
- **Trusted Types fail closed.** For a block with `env`, the host calls `trustedTypes()` after the
  handshake and before its first `write`, so no block code exists yet. The bootstrap answers true
  only if it created both policies and a probe, `innerHTML = "<b></b>"` on an element of its own,
  threw. Otherwise the host writes nothing, opens no binding, ends the frame's session, and shows
  "This browser can't run a view that reads env safely." under the view. Which current browsers
  enforce Trusted Types is not
  checked [INFERENCE]; the probe decides at run time either way.
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
  opens each name once with `overseer.connectToChatBinding(chatId, name)`, and parses saved JSON.
  It paces a connection's session with `createRateLimitedCapability` and the gatekeeper app's
  policy, now one exported constant that `SandboxedGatekeeperApp` uses too: an untrusted frame's
  connection calls spend the vendor's quota on the connection's account, and a view's code runs
  again on every mount, for every viewer. A Gadget's `rpc` is not paced, as `GadgetUI` does not
  pace `connectToGadget`'s stub: one policy per kind of capability. The host disposes every stub
  it opened, and each limiter, when the session ends: a new handshake, Stop, unmounting, or a
  reload. A stub that arrives after that is disposed at once. `UiBlockCard` gets `chatEnv`, the
  chat's id and the kernel session's `overseer` stub, from `ChatInterface`, beside
  `onSendMessage`. A block with `env` and no `chatEnv` shows "This view reads env, which this chat
  cannot give it." and runs nothing.
- **A limiter's dispose ends it.** `createRateLimitedCapability`'s `dispose` becomes terminal: it
  rejects every queued call, refuses new ones, and a call already in flight neither drains the
  queue nor arms the resume timer when it finishes. `SandboxedGatekeeperApp`, the configurator and
  views all get the fix.
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
  a view in your answer and for later code, as in `env.SALES = rows` (see "Live views")." A
  spawned agent's prompt is `SPAWNER_SYSTEM_PROMPT`, which has no "Live views" section, so
  `SPAWNED_EXECUTE_CODE_TOOL_DESCRIPTION` gains: "The code can also save JSON data on `env` for
  later code, as in `env.SALES = rows`; each run's output says what it saved."

### Evals

- `RenderedView.open(html, binder, env)` in `workshop-evals/src/view-host.ts` runs a view with an
  `env` that serves the names its tag lists and nothing else, as `EvalVerifier.openView(html, env)`
  calls it. Saved data comes back as its value, a Gadget as `{rpc}` and a connection as its
  methods; each result crosses into the frame as plain data, and every opened binding is disposed
  with the view. The binder is the session's `connectToChatBinding`, which `WorkshopAgentSession`
  gains in `integration-tests/src/agent-session.ts`. A view with `env` gets the Workshop's Trusted
  Types CSP and default policy there too, and a view without it gets no `env`. The benchmark's
  eval host did most of this (commits `ee3b9a2f3` and `411f51e4a`).
- `turnViews` in `evals/views.ts` keeps each block's names, and `view-comes-after-its-gadgets`
  fails a view that lists a name its own message, or a later one in the turn, creates or saves
  (the `savedEnv` stamp).
- Declined on review, 2026-11-11: the eval host structured-clones what a binding's call returns,
  so a view that calls a method on a returned capability (a GitHub issue, a cursor) fails there
  with an explicit error; no eval task gives a view a connection today, and the Workshop passes
  such capabilities through Cap'n Web.

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
  the code ran. The step's buffer and barrier give both (see "A save lands with its step").
- **A side table of saved names (`chatEnv`), apart from the chat's bindings.** The first version of
  this plan. It made a second name scope: `chatScopeNames`, `prepareChatBindings`, `isNameInScope`
  and `executeCodeMode` each needed a patch to see saved names, an alias needed a kind of its own
  and a rule for an alias of an alias, compaction checkpoints did not carry the names, and
  `describeBinding` did not know them. Main's `chatScopeNames` says why one scope matters: "Every
  name is stamped on its message when it is claimed, so this is a plain scan."
- **Payloads keyed by sequence.** See "Keyed by name, not by sequence".
- **`delete env.NAME` removing a name.** A removed name would leave entries behind in checkpoints
  and in replay, which would need a removal stamp and a removal case in every fold, for a way to
  free room that `env.NAME = null` already gives.
- **A frame `env` with one getter per listed name.** The frame would need the names before the
  block's code runs, and the host's check is the boundary anyway.
- **Retargeting a view's stubs on reconnect, as `GadgetUI` does.** One forwarding target per name.
  Remounting the view runs its code again with new stubs, at the cost of a restart.

## Commits

Five commits, so the kernel and shared lines read apart from the frontend and the evals:

1. **This plan.**
2. **Shared and kernel: saving env.** The `data` binding kind and its case in every reader of the
   binding map, `chatSavedData` and its sweep in `deleteChat`, the `savedEnv` stamp on the
   `executeCode` tool call, the harness's capture, `executeCodeMode`'s checks, the turn's
   `pendingSavedData`, and `commitAgentStep`'s `savedData`.
3. **Shared and kernel: a view's env.** The parser's `env` attribute, `ViewBinding` and
   `Overseer.connectToChatBinding`, `foldChatBindings` and `resolveChatBinding`, the root stub's
   wrapper, and the `view` caller in `observerContextOf`, `ApprovalQueueImpl`, `#associateAction`
   and `submitAction`.
4. **Frontend.** The limiter's terminal `dispose` and its shared policy constant, then the host's
   `binding`, the frame's `env`, the Trusted Types CSP and its fail-closed probe for views with
   `env`, the card's binding callback, and the remount on a new overseer.
5. **Instructions and evals.** The "Live views" section and `executeCode`'s sentences, the eval
   host's `env` and Trusted Types CSP, and the chat-views eval's view of saved data.

## Verification

- Parser unit tests (`workshop-backend/__tests__/inline-html-blocks.test.ts`, in workerd): prose
  offsets, tags that are indented, have attributes or share their line, which stay prose, tags in
  fences and their closing rules, in list items and block quotes, after thematic breaks, a
  paragraph, a lazy list line and an HTML block, unclosed blocks, several blocks in one message,
  empty bodies and title-only bodies as errors, a tag line that opens or closes no block until it
  ends while the answer streams, the same blocks at the same index among the segments at every cut
  of a streamed answer once they close, an open block at every cut at the index it closes at, with
  HTML that starts the HTML it closes with, and a long code example of tag lines parsed in linear
  time. New: an `env` attribute's names, trimmed and counted once; a bad name and `then` as
  errors; other attributes and single quotes as prose; the names on an open block from the moment
  its opening line ends.
- Kernel tests (`workshop-backend/__tests__/saved-env.test.ts`, in workerd), each red before its
  change:
  - a run saves JSON data and another name of a binding, says so, and stamps both on its record;
    a later run gets them, the other name as its binding's own object; `describeBinding`
    describes a data name;
  - a change in place (`env.FOOD.weeks.push(5)`) is saved; `delete env.FOOD` leaves it saved and
    says so; saving a data name again replaces its JSON and keeps its place in the map;
  - a name the chat binds, a pending connection request's name, `GIT`, another name saved again,
    a function, a `Date`, a cycle, a value over the cap and a save past it are refused, and the
    rest saved; a callback's arguments count toward the cap, and a save that shrinks lands though
    the chat is over it; a run that throws saves nothing; a harness result whose JSON does not
    parse is refused;
  - in one step, a second call sees the first's save; a save after a `createGadget` of the same
    name is refused, and a `createGadget` after a save of it is refused;
  - a scripted turn (pi's faux provider, as in `spawned-agent-tools.test.ts`) stores its JSON with
    its step, stamps it on the record, and the next turn reads and describes it; the barrier writes
    nothing for a deleted chat; a compaction checkpoint folds data names, another name as its
    target's entry, and a data name saved again in place; `chatScopeNames` counts a saved name;
    `deleteChat` removes the chat's `chatSavedData`. A spawned agent's chat runs the same code,
    so it gets no test of its own.
- Kernel tests (`workshop-backend/__tests__/view-bindings.test.ts`):
  - `connectToChatBinding` returns saved data, another name's Gadget, a Gadget and a connection
    session; refuses model, spawner, auto-provided and pre-`creationSpec` connections, worktrees,
    callback arguments and unknown names; `UseOverseerInterface` denies it;
  - a view's observation is attributed to its chat and not posted to it; a view's action is posted
    to the chat and never auto-approves, even under an auto-approval rule;
  - `bindHook` through a view's session is refused and stores no hook and no action;
  - once the chat is deleted, `connectToChatBinding` is refused, and an open view's Gadget call,
    connection read and connection write are refused, the write before any record is stored; a
    read whose chat is deleted while its authorization awaits is refused and records nothing;
  - a collaborator's Gadget and connection root stubs count toward their session until disposed;
  - after the Gadget's facet restarts (as `proposedChangesChanged` restarts it), the view's next
    Gadget call rejects, and a new `connectToChatBinding` works.
  A call through a native RPC stub in the same isolate that rejects is also reported as an
  unhandled rejection of its pipelined result, so `workshop-backend/vitest.config.ts` ignores the
  one refusal these tests expect, as `vitest.integration.config.ts` does for its own.
- Limiter tests (`rateLimitedCapability.test.ts`): after `dispose`, queued calls reject, new calls
  are refused, and a call in flight finishes without draining the queue or arming the timer.
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
  not in a view without `env`; data holding `<img src=x onerror=…>` written with `innerHTML`
  throws and runs nothing, and with `textContent` shows as text.
- Frontend tests (`UiBlockCard.test.tsx`), new: the host refuses a name its tag does not list,
  opens each name once, paces a connection's calls and not a Gadget's, and disposes both on Stop;
  a stub that arrives after the session ends is disposed; a frame whose `trustedTypes()` answers
  false, or throws, gets no `write` and no binding, has its session ended, and shows its error;
  Run opens a name again in
  its new session, as a view whose Gadget stub died with a facet restart needs; a new overseer
  remounts a view with `env` and leaves one without it.
- `ChatInterface` tests: an open block in a streaming answer is already a frame, and the closed
  block and then the stored message keep that frame element; a stored message whose text differs
  from the streamed text mounts its view fresh.
- Eval host tests (`workshop-evals/src/view-host.test.ts`): a view gets saved data and the Gadgets
  its tag lists, and is refused any other name; `innerHTML` throws in a view with `env`, whose code
  can make neither Trusted Types policy; a click that only reads a binding counts as no send; a
  view without the attribute has no `env`.
- Chat-views verifier tests (`workshop-evals/evals/chat-views.test.ts`): the spending view passes
  when it reads the totals through `env`, saved or from the Expense Log, and fails
  `view-comes-after-its-gadgets` when its own message's call saves what it reads.
- The chat-views eval (`workshop-evals/evals/chat-views.eval.ts`), unchanged in its prompts: the
  spending view may now read its totals through `env`. Run on gpt-6-luna, claude-haiku-5-5 and
  Kimi K3.
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
- **A Gadget's code change.** A view's Gadget stub dies when the Gadget's facet restarts, as on an
  agent's edit. The view's next call fails and shows its error. Mounting again opens a new stub.
- **A deleted chat with a view open.** Its next lookup and every call through its stubs are
  refused (see "The root stub" and "The view caller").
- **Scratch assignments.** Code that uses `env` as scratch space, as in `env.rows = await …`, now
  saves JSON values and prints a line for each name, in every chat, spawned agents' included.
  A value that is not JSON prints why it was not saved, and nothing else changes for the run.
- **Compaction.** Data names are entries of the checkpoint's `chatBindings`, so compaction keeps
  them, and `executeCode` sees them, though the summary may not mention them.
- **Revert.** Reverting a chat's code changes leaves its saves, as it leaves what was said.
- **Who did it.** The `view` caller carries no user, as the `user` caller carries none, so the
  action log does not say whose view read or wrote.
- **Returned stubs.** Stubs a connection call returns, such as a GitHub cursor, are not counted
  toward the viewer's session, as on main for the sessions `GatekeeperClientImpl.openSession`
  returns and for what a `getGadgetFacet` stub returns: only the root is leased. Their reads and
  writes still go through the view's queue, with its checks. They are not paced either.
- **Rollback.** A build without this feature reads the new stored shapes as follows. Its
  `getEnvForAgent` skips a `data` entry (its `default` does nothing at run time), its
  `describeBinding` returns the entry itself rather than a description, and its replay, scans and
  folds ignore `savedEnv` stamps, so saved names drop out of scope and can be taken. Its
  `observerContextOf` maps a `view` caller to nothing, so the ledger refuses such a call: it fails
  closed. Its `deleteChat` leaves `chatSavedData` records behind. Rolling forward, a name a
  rollback build bound first keeps its binding, and replay skips the later save of it. In the
  other order, a name saved first and then taken by an older build's `createGadget`: replay and
  `buildCompactionState` set a created Gadget's name unconditionally, so every fold agrees that
  the name is the Gadget, and the `chatSavedData` row stays, read by nothing, until the chat is
  deleted.
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
  Chromium 156, a `srcdoc` child frame gets a fresh `RTCPeerConnection`. The fix belongs to every
  frame kind at once. This holds for views with and without `env`. A view without `env` can carry
  restricted data out today: the agent writes the values it read into the view's code, and nothing
  on main gates a view on `containsRestrictedData`. A gadget UI frame can too, and can also open a
  popup. A view with `env` adds no channel and no authority: its connection works on the account
  the agent's `executeCode` uses. A review on 2026-11-11 asked to block `env` views until WebRTC is
  closed; that was declined for these reasons.

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
