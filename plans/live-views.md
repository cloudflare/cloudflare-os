# Plan: Live views in chat

## Goal

The agent can draw a live view inside its answer. It writes HTML, CSS and JS between
`<inline-html>` tags in the answer text, with no tool call. The Workshop runs each block in a
sandboxed frame built the same way as a gadget's UI frame. A view shows what the agent writes into
it: it has no `env`, and no network apart from WebRTC (see "Known edge cases"). A block can also
suggest a message for the viewer to send. The message goes out only when the viewer clicks Send, as
the viewer's own chat message.

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

## Locked decisions

- **A view has no `env`.** It cannot reach the chat's gadgets or connections. The agent reads data
  with `executeCode` and writes the values into the view's code. Giving a view the chat's `env` was
  built and deferred on 2026-10-28 (#930 holds that design), so this feature needs no kernel API:
  the frontend, a parser in `workshop-shared` that the frontend and the evals use, and the agent
  instructions.
- **No chat gateway text.** A chat gateway gets the agent's answer as stored, tags and all.
  Nothing calls the gateway yet, and its removal is planned, so a note in place of each view was
  built, then dropped on review on 2026-11-06. The kernel then does not import the parser.
- **A block runs in a gadget-style frame.** The frame is an opaque-origin srcDoc document with
  the gadget UI CSP. A block's HTML never goes into the Workshop document, and `MarkdownMessage`
  keeps `skipHtml`. The block frame is stricter than a gadget frame in one way: its sandbox is
  `allow-scripts` only, with no popups (see "What a block can reach").
- **A view's code may parse strings as HTML.** A Trusted Types CSP that made `innerHTML` throw in
  block code was built, then dropped on review on 2026-11-04, since the frame is sandboxed: in the
  2026-10-28 eval run, two of the views Kimi K2.7 Code drew built their markup with `innerHTML`,
  which the CSP made throw, so they showed nothing. So text a view shows as HTML, such as a web
  page the agent copied into it, runs as the view's code: it can redraw the view, replace the
  message the view asks to send, and use WebRTC (see "Known edge cases"). It still has no `env`,
  the Send chip shows the whole message, and only the viewer's click sends it.
- **The tag is `<inline-html>`.** A block is HTML in the answer, not a gadget: it has no server,
  no files and no connections.
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
| Gadgets, connections, the agent's `env` | Nothing | Deferred (see "Future work"). |
| Popups, other frames, the network | Nothing but WebRTC | `sandbox="allow-scripts"`, CSP `connect-src 'none'`, and the Workshop's `frame-src srcdoc:`. WebRTC is the exception (see "Known edge cases"). |

Gadget UI frames keep `allow-popups` and `allow-popups-to-escape-sandbox`. So agent-written
`client.js` can still open a link that carries data out, even after the workspace has read
restricted data. This plan does not change gadget frames.

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
  `requestMessage(message)`, `resize(height)` and `reportError(message)`. The frame exports
  `UiBlockFrame`, with `setTheme(theme)`, `write(html)` and `close()`. Both are typed and
  documented in `features/chat/uiBlockFrame.ts`, beside the bootstrap. The frontend has no
  capnweb-validate transform, so the host checks its own arguments.
- **Connection.** The Workshop checks the handshake as `GadgetUI` does: the message must come from
  the view's own frame window, with origin `"null"`.
- **Shell.** A frame loads a shell: the sandbox head, the frame's style in the theme of that
  moment, and one bootstrap module, whose URL is built once per page, since it embeds all of
  Cap'n Web. The bootstrap waits for the shell's `load` event, so that the event cannot fire in
  the block's document once `write` opens it. It then sets up the Cap'n Web session and defines
  `globalThis.agent`, which has one method, `send(message)`.
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
  padding around it, module scripts, that a view has no `env` and no network so the agent reads
  data with `executeCode` first and writes the values in, that the code runs again on each mount
  and for each viewer, `agent.send` in the user's words, the Kumo colour tokens, the height rules,
  and that a view keeps no state. The example writes its data into its script and builds its bars
  with `createElement` and `textContent`, since models copy the example more than they follow the
  rules.

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

## Commits

Three commits, so reviewers can read the kernel lines alone:

1. **This plan.**
2. **Shared and kernel.** The block parser in `workshop-shared`, and the agent instructions.
3. **Frontend.** The block card, its frame and host, and drawing blocks in answers as they stream.

## Verification

- Parser unit tests (`workshop-backend/__tests__/inline-html-blocks.test.ts`, in workerd): prose
  offsets, tags that are indented, have attributes or share their line, which stay prose, tags in
  fences and their closing rules, in list items and block quotes, after thematic breaks, a
  paragraph, a lazy list line and an HTML block, unclosed blocks, several blocks in one message,
  empty bodies and title-only bodies as errors, a tag line that opens or closes no block until it
  ends while the answer streams, the same blocks at the same index among the segments at every cut
  of a streamed answer once they close, an open block at every cut at the index it closes at, with
  HTML that starts the HTML it closes with, and a long code example of tag lines parsed in linear
  time.
- Frontend tests (`UiBlockCard.test.tsx`): a message from the frame never calls the kernel
  until Send; Dismiss; Send held while the composer is held; a failed Send; a Send that finishes
  after a newer message; a second handshake gets the whole block in a new session and clears the
  chip; an empty block shows its error and no frame, and so does an open block that closes with
  nothing but a title; a stored block's frame gets the document's start, all of the block in one
  write, then `close`; an open block's HTML reaches the frame in parts as it grows, after the
  document's start, and `close` follows the last part once it closes, in the same frame; Stop
  removes the frame, and Run gives a new frame load the start and then all of the HTML so far.
- A browser test (`uiBlockFrame.browser.test.tsx`) runs the real frame in Chromium: the calls a
  view's code makes with `agent.send` are released, though the code ignores their results.
- `ChatInterface` tests: an open block in a streaming answer is already a frame, and the closed
  block and then the stored message keep that frame element; a stored message whose text differs
  from the streamed text mounts its view fresh.
- A browser run on the dev server with a real model: the agent draws a view from data it read with
  `executeCode`, the view follows a theme change, a click shows the message, and Send posts it as
  the viewer's message. The view's markup draws while its block streams, its module script runs
  once, at the block's close, and the stored answer does not reload it. Screenshots in light and
  dark, and after a theme change, show the view with no box around it.

## Known edge cases

- **Old messages.** A block's code and data stay fixed in its message, so an old view shows the
  data of the moment the agent wrote it.
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
  each later turn until compaction summarizes that part of the chat.
- **WebRTC.** No CSP directive in any shipping browser covers `RTCPeerConnection`, so a view's code
  can reach STUN and TURN servers, as gadget UI frames can (`browser-export.ts` records the same
  gap). Deleting the `RTC*` globals in the bootstrap does not hold: measured 2026-10-30 in
  Chromium 156, a `srcdoc` child frame gets a fresh `RTCPeerConnection`. The fix belongs to both
  frame kinds at once.

## Open questions

- Should replay give the model a short stand-in for old block HTML? Any change must handle saved
  model snapshots and compaction, and must keep the stored answer unchanged.

## Future work

- Bindings in views, deferred on 2026-10-28 (#930 holds the design): a view reads the
  chat's gadgets and connections live, so it can show current data and act on it.
- Server code in a block: the block becomes a chat-scoped gadget whose files live in the message,
  run by the gadget loader with its own storage, for views that must keep state.
- Save a block as a gadget: the block's HTML becomes a new gadget's UI.
- A small library set for charts, packaged into the frame, since the CSP blocks CDNs.
- Drop popups from gadget UI frames too, or at least once the workspace has read restricted data.
