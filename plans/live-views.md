# Plan: Live views in chat

## Goal

Reference any worktree file with a Markdown link, e.g.
`[Download CSV](worktree://BINDING/results.csv)`. Clicking reads the pinned blob through the
authenticated RPC and downloads its exact bytes with its filename, regardless of format.
Files are fetched on click, not when the message renders. Downloads use octet-stream so HTML
and SVG files are saved rather than opened in the Workshop origin.

For a picture without a custom HTML view, use Markdown directly:
`![Description](worktree://BINDING/path)`. The same URL works in a literal `<img>` in an HTML
view. Only `worktree://` is supported; there is no live/pinned choice or agent OID-lookup method.
The host parser pins each emitted link or image path once, before publishing its completed syntax to
clients. `AiChatMessageBody.embeds` stores its immutable blob OID alongside the original
model text, and `textDelta.embeds` delivers new pins while streaming. Unavailable files are
recorded as null so later viewers cannot silently fill an old reply with a newer file.

Markdown renders the saved blob without an iframe. SVGs use originless data URLs, as attachment
previews do, so opening one separately does not run its scripts in the Workshop's origin.
HTML views receive only a narrow Cap'n Web file reader limited to their message's saved
references. Their object URLs are created inside the opaque-origin frame and released when
images change or leave the document. The host parses literal references, not code that
constructs new file references dynamically. No path polling, change subscription, or file
refresh exists; an old reply stays fixed even when the worktree changes or the DO resets.

A view's code can also read a data file pinned the same way. The agent writes the data with
`executeCode` into a worktree, and in its next answer the view names the file in a quoted string
and reads it, so the data never passes through the answer:

```html
<inline-html>
<title>Spending by month</title>
<h3 id="total"></h3>
<div id="months"></div>
<script type="module">
  const { total, months } = await embeds.json("worktree://OUTPUTS/spending.json");
  document.getElementById("total").textContent = `Total: ${total}`;
  const list = document.getElementById("months");
  for (const [month, amount] of months) {
    list.appendChild(document.createElement("p")).textContent = `${month}: ${amount}`;
  }
</script>
</inline-html>
```

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
- A view reads any file its reply pinned, as it was when the answer was written, with
  `embeds.json` or `embeds.text`, at the `worktree://BINDING/path` URL it was pinned under. A
  reply pins a URL its prose links or its views quote; a view reads no file the reply did not pin.

## Locked decisions

- **A view has no `env`.** It cannot reach the chat's gadgets or connections. It reads only the
  files its reply pinned: images, links and data files the reply names in `worktree://` URLs. The
  agent reads other data with `executeCode` and writes it into a worktree
  file, or, for up to 20 values, into the view's code. Giving a view the chat's `env` was
  built and deferred on 2026-10-28 (#930 holds that design), and built again as saved env (#1098)
  and shelved on 2026-11-16 (see "Data files, not env"). Views use the frontend, a parser in
  `workshop-shared` that the frontend and the evals use, and the agent instructions. File paths
  are snapshotted by the host parser; bytes use the existing blob RPC.
- **Data files, not env.** Kenton's review of #1098 on 2026-11-16 asked for this in place of
  saved env: "What if inline HTML could reference files from a worktree? The agent could write
  data into the scratch worktree (same one used for attachments). This avoids any file-size
  issues, allows referencing images or other media, and generally seems less scary than
  providing access to env. The content can be locked to what existed in the worktree at the time
  the inline-html was embedded [...] I'd have a much easier time approving read-only access to
  worktree contents." He wanted a runtime mechanism for auditing and revoking capabilities that
  flow between facets before views hold any. On #1136 he wrote that data files for
  `<inline-html>` would be a good fit for the pinned-file references, and asked to name them
  "embeds", as #1136 merged them (`ChatEmbeds`). So data files reuse #1136's pins: the same
  `worktree://` URLs, the same `snapshotChatEmbeds` pass, the same `AiChatMessageBody.embeds`
  record and the same `readBlob`, with one reader in the frame.
- **A view reads any file its reply pinned.** The host pins what it finds in the answer's text
  before the view's code runs, so a file must be named in that text to be readable. The kernel
  pins the URLs the prose links (`markdownFileUrls`), each view's `<img src>`, and every complete
  `worktree://` URL a view's raw text quotes, in `"`, `'` or a backtick with no `${`
  (`quotedFileUrls`). The scan is raw text, not a JavaScript tokenizer, so a URL in a comment, or
  quoted inside a longer string, pins too. The frame's reader then serves any `worktree://` URL
  pinned in the message (`readSnapshotFile`) and nothing else, so a view can read a file the prose
  or another view named, at a URL its code builds. Kenton asked for this on #1275 on 2026-11-24:
  "The client-side URL scanning seems redundant. I think we can drop it to reduce complexity. (I
  missed this when reviewing #1136.)" Every view and link in a message is text the agent wrote in
  the same reply, so a per-view filter defends against no one; recomputing it from stored text
  would lock the scan rule for old messages, which instead keep working off their stored pins; and
  it cost hand-declared DOM types in `workshop-shared`, a function serialized into the eval page,
  and a second set. #1136's per-view image filter went with it.
- **No chat gateway text.** A chat gateway gets the agent's answer as stored, tags and all.
  Nothing calls the gateway yet, and its removal is planned, so a note in place of each view was
  built, then dropped on review on 2026-11-06. That gateway path does not use the parser;
  the kernel does use it to snapshot image references.
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
| `embeds.json`, `embeds.text`, `<img src>` | The files the view's reply pinned | The host's `readFile` serves only `worktree://` URLs pinned in the message (`readSnapshotFile`; see "Data files"). Bytes come through the existing `readBlob`. |
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
  `requestMessage(message)`, `resize(height)`, `reportError(message)`,
  `reportImageError(message)` and `readFile(source)`. The frame exports `UiBlockFrame`, with
  `setTheme(theme)`, `write(html)`, `retryImages()` and `close()`. Both are typed and documented
  in `features/chat/uiBlockFrame.ts`, beside the bootstrap. The frontend has no capnweb-validate
  transform, so the host checks its own arguments.
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

### Data files

- **Naming.** `quotedFileUrls(blockHtml)`, a new export of
  `workshop-shared/src/inline-html-blocks.ts` beside `markdownFileUrls`, returns each
  `worktree://` URL in `blockHtml` that a quote (`"`, `'` or a backtick) opens and the same quote
  closes, with no quote, backslash, whitespace, `<` or `&` between, and no `${`. A path with `&`
  in it is percent-encoded (`%26`), as main's prompt already asks for special characters. It is
  the kernel's pinning rule only: it decides what a reply pins, and nothing reads it at view time.
  - **Kernel.** `snapshotChatEmbeds` (`workshop-backend/src/chat-embeds.ts`) adds
    `quotedFileUrls(part.html)` to its `sources` for each block, closed or (while streaming) open.
    The validation, the resolve against the running turn's worktree state and the null for a
    missing file are #1136's, unchanged.
  - **Frontend and evals.** No scan. `UiBlockCard`'s `readFile` calls `readSnapshotFile(files,
    source)`, which serves a `worktree://` URL pinned in the message and refuses any other, and
    refuses every read in a message with no files. The eval host serves the same set from the
    message's `embeds`.
  - **Images.** #1136's `<img src>` pinning stays: the kernel reads `src` through `HTMLRewriter`
    and decodes character references. The raw scan also sees a quoted `src`; with a character
    reference it stops at the `&`, so it adds no second pin under the raw spelling, and the
    kernel's entity tests still pin each decoded `src` exactly once.
- **Streaming.** The kernel pins during streaming on a delta that holds `)`, `]`, `>`, `\r` or
  `\n` (`agent.ts`, `text_delta`), and awaits the pins before it publishes the delta. A quoted URL
  gets its pin with the delta that ends its line, and at the latest with the delta that carries
  the closing tag line, before the frontend sees the block close. Module scripts run only at the
  close, so a module script's read finds its pin. A classic script that reads before the close may
  find none and gets "File unavailable"; the instructions ask for module scripts. An unfinished
  URL has no closing quote, so nothing pins a half-written path. The final pass at `message_end`
  pins a URL on a last line with no newline, and drops pins the stored text no longer holds, as for
  images.
- **One reader, one limit.** `UiBlockHost.readImage(source)` becomes `readFile(source)`, and
  `UiBlockHostOptions.readImage` becomes `readFile`. Its one rule is `readSnapshotFile`'s: the
  source is a `worktree://` URL pinned in the message. The bootstrap's image loader calls
  `readFile` in place of `readImage`. No second method and no second limit.
- **The frame's `embeds`.** The bootstrap defines `globalThis.embeds`, a frozen object with
  `json(source)` and `text(source)`, which call `host.readFile(source)` and read the whole file
  with `new Response(stream).json()` or `.text()`. A read's failure rejects its promise, so it
  reaches the view's code, and as an unhandled rejection, the view's error line.
- **Producing the file.** The agent calls `createWorktree` with no `commitId` and binding name
  `OUTPUTS`, as main's file paragraph does, or uses a worktree it has, and writes from
  `executeCode`. Both writes go through `appendChange` into the turn's `sessionContent`
  (`agent.ts`, `worktreeTurnAccess`), the overlay `getWorktreeFileOid` reads first
  (`overseer.ts`), so a file written in step N pins in step N+1's answer though its change is not
  yet accepted. In the same step, the answer's pins are final at `message_end`, before any of the
  step's tool calls run, so a view written in the response that writes its file pins the path as
  it was before: null for a new file, the old version for a rewritten one. The kernel stays as it
  is; the instructions say to write first and draw next, and the benchmark measures how often
  models do otherwise (see "Benchmark").
- **`writeBytes` in the example.** The two writes cost differently (`worktree-session.ts`):
  - `writeFile(path, text)` appends a text change: the whole text for a new file, a diff for an
    old one. The text lives in the chat's change rows and in `sessionContent`, which every later
    turn rebuilds from those rows until the changes are accepted; it counts toward the step's
    `MAX_CODE_CHANGE_SIZE` (8,000,000); and pinning it writes it once more, as a blob
    (`gitCache.writeBlob` in `getWorktreeFileOid`).
  - `writeBytes(path, bytes)` writes one blob and appends `{setBytes: {oid, byteLength}}`, a row
    of a few dozen bytes; the overlay holds that reference, the pin takes its OID as it is, and
    there is no size limit.
  So the example uses `writeBytes(path, new TextEncoder().encode(JSON.stringify(rows)))`: a data
  file the agent rewrites each answer then grows nothing that every turn carries. Models copy the
  example's call; whether they write it correctly is a benchmark measure.
- **Sizes.** `readBlob` streams the blob (`blobByteStream`), and the frame receives the stream over
  the Cap'n Web port, as images do. `embeds.json` and `embeds.text` read the whole file into the
  frame, and parse on its main thread [INFERENCE: about 100 ms for 8 MB of JSON, not measured]. No
  new cap: a file a view reads costs the viewer's tab, as an image does, and Kenton's point was
  that files avoid the size limits saved env needed. Reading large binary files in parts is out of
  scope (see "Known edge cases").
- **Kernel lines.** `chat-embeds.ts` (one call), the Live views section in `agent.ts`, and the
  GC-roots comment in `git-cache.ts`, which gains the `embeds` OIDs of chat messages: a pin of an
  unaccepted text file writes a blob that only the message names once the change is discarded or
  reverted. No new RPC, no schema change, no change to `AiChatMessageBody.embeds`, `readBlob`,
  `getWorktreeFileOid` or the step barrier.
- **Who can read.** As for #1136's images. `readBlob` serves an owner and build collaborators
  (`OverseerClientInterface`); a use-role collaborator cannot open the chat at all
  (`UseOverseerInterface` denies `getChatHistory` and `readBlob`). Data the agent read with
  `executeCode` was observed then, under the chat's audience, and a file read adds no observation,
  as writing values into the view's code adds none. A DO reset keeps the pinned OID, and
  `readBlob` reads the blob the pin wrote.
- **Reconnects, a deliberate limit.** Only images retry after a reconnect (`retryImages`). A data
  read in flight rejects, the view's code sees it, and Run reads again. `reportImageError` and
  `retryImages` keep their names, since they stay about images.

### Agent instructions

- The guidance on when to create a Gadget is main's: a request for an app gets a Gadget. A
  sentence that made a one-off demo, tool or visual a view even when the user called it an app
  was dropped on review on 2026-11-06.
- The view section: when to draw one, the syntax, with the tags on lines of their own, with no
  indent, outside code fences, that the view's markup draws as the agent writes it and its module
  scripts run as soon as its block closes, so any style comes first, then the markup, and the
  script last, that the `<title>` is not shown and the view sits in the answer with no border or
  padding around it, module scripts, that a view has no `env` and no network, that the code runs
  again on each mount and for each viewer, `agent.send` in the user's words, the Kumo colour
  tokens, the height rules, and that a view keeps no state. The example writes its data into its
  script and builds its bars with `createElement` and `textContent`, since models copy the
  example more than they follow the rules.
- Data files give the section the saved env arm's structure (measured 2026-11-05): one intro
  sentence and a "Views of data from code" part, no longer than that arm's.
  - Intro, after "A short answer or an explanation stays plain text.": "Write up to 20 values into
    a view's code; for more, write them to a file (see "Views of data from code")." This is the
    one size rule, and the part below opens with its condition.
  - The `env` bullet becomes: "A view has no `env` and no network: it shows what you write into
    it and the files it reads. No `fetch()`, and no remote scripts, styles, fonts or images. Draw
    charts with inline SVG or the DOM."
  - The module-script bullet says scripts see "the globals `agent` and `embeds`".
  - The `<img>` sentence ends "write each file reference in quotes in the view's text, never build
    one in code" in place of "construct the file references in the markup, not dynamically in a
    script".
  - The part, after the bullets:
    "## Views of data from code. For more than 20 values, read or work out the data with
    `executeCode`, and write it to a file in a worktree (create one with `createWorktree`, no
    `commitId`, if the chat has none for generated files). Then, in your next response, read the
    file in the view, so the data never passes through your answer: never retype it into the
    view's code. Save the figures your answer states with the rows, so the view shows them too.
    The view reads the file as it was when you wrote the answer, so a view in the same response as
    the write would not see it: write first, then draw the view. Call the tool; never paste its
    code into your answer." Then the example `executeCode` call, which reads a Gadget's rows
    (`// [["Jan", 96], …]`), works out their total, and writes both with
    `env.OUTPUTS.writeBytes("spending.json", new TextEncoder().encode(JSON.stringify({ total, months })))`,
    then "Then, in your answer:" and the view in "Goal", which draws the total above the rows, and
    one bullet: "`embeds.json(url)` and `embeds.text(url)` read the whole file."
  - The sentence about the figures, and the total in the example, came after the 2026-11-23
    benchmark: in 6 of 9 L5 trials the data-files view listed the weekly rows from the file and left
    the summary figures in the prose answer, against 2 of 9 for the Inline control.

## Rejected alternatives

- **Saved env (#1098).** `env.NAME = value` in `executeCode` saved data for the chat, and
  `<inline-html env="A,B">` gave a view saved data, Gadgets and connections. Shelved on review on
  2026-11-16 (see "Data files, not env"). Measured 2026-11-05 (81 ladder view turns per arm): 73
  passed against 76 for `embedView`, 1.6 steps against 1.1, and on Gadget data 24.9 s for a whole
  turn against 15.3 s on gpt-6-luna. Data files keep its data path and drop its capabilities.
- **`embedView` (#914 v2, #950).** It passed 98% on 2026-10-29 and ends the turn with the view,
  but reads a function's source back with `Function.prototype.toString`, which Kenton refused on
  #950.
- **The view and its save in one response, the turn ending once the save lands (env-one).**
  Probed 2026-11-10: gpt-6-luna and claude-haiku-5-5 wrote both in one response in 0 of 3 data
  turns each, Kimi K3 in 2 of 3. Data files pin at `message_end`, before the step's tools run, so
  the same rule, save first and draw next, holds.
- **An attribute on the tag, `<inline-html files="worktree://…">`.** Main's tag line is
  `<inline-html>` alone; an attribute adds grammar to the parser, makes the frontend and the
  kernel agree on it, and repeats each URL that the code then names again.
- **A dedicated element, `<link rel="data" href>` or `<script type="application/json" src>`.**
  `HTMLRewriter` could select it as it selects `<img>`, but the view's code would still have to
  find the element and pass its URL to the reader, and the bootstrap would have to load it before
  module scripts run. A model writes the literal it reads.
- **Any `worktree://` text in the block.** It would pin URLs in comments and prose inside the
  view, and attributes would need their character references decoded to match the browser, as
  `<img src>` does. Literals in scripts are raw text in HTML on both ends.
- **A sibling `readData` method beside `readImage`.** Two readers with one limit is a parallel
  path; one `readFile` serves both.
- **A JavaScript tokenizer for literals in scripts.** The first version of this plan named a file
  by a string literal in a `<script>`, through `HTMLRewriter`'s script text and the DOM's
  `textContent`. Review on 2026-11-23 showed a quote matcher matches comments and quoted
  substrings anyway, and that the two ends decode SVG scripts differently. A real tokenizer would
  not change what a view can read, since every URL it could name is text the agent wrote.
- **`embeds.bytes`.** It read the whole file, so it gave no bounded way to read a large one, and
  no task needs it.
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

Data files take four commits, so reviewers can read the kernel lines alone:

1. **This plan.**
2. **Shared and kernel.** `quotedFileUrls` in `workshop-shared`, its call in
   `snapshotChatEmbeds`, the Live views section, the GC-roots comment, and a paragraph in
   `docs/chat-scratch-worktree.md`.
3. **Frontend.** `readImage` becomes `readFile`, the frame's `embeds`, and the view's list of
   quoted files.
4. **Evals.** The eval host reads a view's pinned files through the session's `readBlob`.

The benchmark's harness and arms go on a branch of their own (see "Benchmark").

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
- Data files, each test red before its change:
  - `inline-html-blocks.test.ts`: `quotedFileUrls` takes `"…"`, `'…'` and `` `…` `` URLs, a URL
    in a comment and one quoted inside a longer string, and the quoted prefix of a joined string;
    it skips one with `${`, an unclosed or mismatched quote, whitespace, a backslash, `<`, `&`, and
    a bare URL.
  - `chat-embeds.test.ts`: a block's quoted URL is pinned, in an HTML script, an SVG script, a
    nested template and an attribute alike; a URL quoted in the prose but not the block is not
    pinned; an unfinished quote while streaming pins nothing; a quoted URL on a last line with no
    newline is pinned by the final pass. #1136's entity cases, each decoded `src` pinned exactly
    once, still pass, which the `&` rule keeps true.
  - `attachment-worktrees.test.ts` (scripted turns): the binding's writes are simulated through
    `WorktreeTurnAccess.appendChange`, a text change for `writeFile` and a stored blob with a
    `setBytes` change for `writeBytes`, because workerd refuses the `executeCode` call into the
    binding in that harness. A text change in an earlier step of the turn pins its overlay
    version, and a `setBytes` change pins the blob it stored; a view in the same step as its
    write pins null for a new file and the old version for a rewritten one; a file written in an
    earlier turn pins before its change is accepted; a binding that is a Gadget pins null.
  - `UiBlockCard.test.tsx`: the host's `readFile` serves any file the message pinned, wherever
    the reply named it: a decoded `<img src>`, a URL the view quotes, one named only in the prose
    or in another view, and one the view's code builds; it refuses an unpinned URL, one pinned as
    missing and one that is not `worktree://`; a message without `embeds` refuses reads and renders.
  - `uiBlockFrame.browser.test.tsx`: in the real frame, a module script's `embeds.json` and
    `embeds.text` return the file, read at the block's close; a refused read rejects and shows the
    view's error; images still load through `readFile`; a file over 1 MiB arrives whole.
  - `view-host.test.ts`: the eval host serves the same set as the card, a pinned quoted URL and
    one pinned elsewhere that the view's code builds, and refuses an unpinned one;
    a view opened without its message's files reads none. `verifier.test.ts`:
    `EvalVerifier.openView(html, embeds)` reads a pinned file through the session.
  - A browser run on the dev server with a real model on Workers AI: the agent builds the Expense
    Log Gadget, writes monthly totals to a file in an `OUTPUTS` worktree, and draws a view that
    reads it; it rewrites the file and draws a second view, and the first still shows the old
    data; Stop, Run and a reload; light and dark; desktop and phone width.

### Benchmark

- **Arms.** "Inline + data files" (this design) against "Inline + embedView" (#950) and "Inline +
  saved env" (`explore/view-bench-env` at `ab21069d4`), on the view benchmark's tasks: L1 to L5,
  D1 and D2, and the changed-view tasks. gpt-6-luna, claude-haiku-5-5 and Kimi K3, 3 trials each,
  the third run's scale (81 ladder view turns per arm).
- **Measures.** Passed checks, retry errors, first view, whole turn and cost per view, the ones
  Kenton asked for, ranked as `rerank-cost-time-2026-11-10.md` ranks them, and steps per view,
  which for data files counts `createWorktree`: benchmark chats start with no worktree, as main's
  chats do. Every pass rate comes with its binomial standard error, √(p(1−p)/n): at p = 0.92 and
  n = 81 that is 3 points, so the 2026-11-05 result of 73 against 76 was one standard error apart.
- **Same-response check.** A check for the data-files arm: the view draws the data its turn wrote,
  so a view written in the response that writes its file fails. The run reports, per model, the
  share of data turns whose view and write came in one response. If any model does so in 10% or
  more of its data turns, a kernel-side notice is justified: the tool result of a write to a path
  the same step's answer pinned says that view will not see it.
- **Fairness.** The two older arms live on a base a month older than main. So all arms run on one
  day, back to back, through the same gateway, and the control, "Inline" (no data access; the
  agent writes the values into the view), runs on both `ab21069d4` and this branch. Each arm is
  reported as its difference from the Inline run on its own base, and the arms compared as a
  difference of those differences. Its confounds, stated with the result: the two bases differ in
  the tag (`<gadget-ui>` against `<inline-html>`), in the Live views prompt (the old base has no
  `worktree://` paragraph; main's opens with #1136's), and in the kernel beneath both, as well as
  in the day. Porting `embedView` and saved env onto main would test a rebuilt arm, not the
  measured one, for kernel code that is not going to land.
- **Prompt weight.** The data-files arm is the product prompt, which has the measured saved env
  arm's structure: one intro sentence and a "Views of data from code" part of about its length.
- **Harness.** The benchmark's tasks and checks (`bench-views.eval.ts`, `evals/views.ts`) and
  its arm switch come from `explore/view-bench-env` onto a benchmark branch from this branch,
  which is never merged; Inline there is this branch's prompt with the data-files text left out.
- **Spend and order.** Luna, Haiku and Kimi only. One trial per model on the data-files arm
  first; if the AI Gateway still returns 402 (as on 2026-11-11), stop and report. Then the full
  run.

## Known edge cases

- **Old messages.** A block's code, literal data and host-pinned file OIDs stay fixed in its
  message. Editing or deleting a file's original worktree path cannot change an old reply. The
  frame reads old messages off their stored pins, so a later change to the pinning rule changes
  only what new replies pin.
- **A file pinned after the view.** A view's module scripts run when its block closes. A file the
  reply pins only later, in prose or a view after it, has no pin yet at that moment, so a read on
  load gets "File unavailable" while the reply streams; once the answer is stored, the view reads
  it on its next mount [INFERENCE: from the streaming order; not tested]. The instructions name each
  file in the view that reads it.
- **A view in the same response as its write.** It reads the file as it was before the write:
  missing, or the old version (see "Producing the file").
- **A read during a reconnect.** It rejects, and the view's code decides what to show; Run reads
  again. Images retry on their own (see "Reconnects, a deliberate limit").
- **Large binary files.** `embeds` reads whole files only. A view that needs a bounded read of a
  large binary file has no API for it; that is out of scope.
- **Re-parsing long views while they stream.** Once an answer holds `worktree://`, each delta with
  `)`, `]`, `>` or a newline parses the whole answer again for pins, its blocks included, so a
  long view script costs time roughly quadratic in its length [INFERENCE: not measured]. #1136's
  images have the same cost; the benchmark's whole-turn time shows it if it matters.
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
- Computed URLs, which Kenton would support but was OK punting on #1275 (2026-11-24): on an
  unpinned request, serve the file from a snapshot of the whole worktree at the message, either
  resolved on demand from the chat log (option A) or by pinning a tree OID per worktree a reply
  references (option B). Either way the readable set is no longer visible from the reply's text.
