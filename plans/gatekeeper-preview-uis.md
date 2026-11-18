# Plan: Gatekeeper preview UIs — a connection's content drawn beside the chat

This plan records the design agreed for gatekeeper preview UIs: a general way for any gatekeeper
to draw its resource beside the chat, with the changes still waiting marked on it. Nothing in the
kernel or the Workshop knows which vendor or what kind of resource is being drawn.

The framework is sections 1 to 4. One gatekeeper uses it so far, described on its own under
[First preview: Google Docs](#first-preview-google-docs). Cancelling a pending change from inside
a preview and forking a preview into a gadget are designed around but not built; see
[Punted / future work](#punted--future-work).

## Goal

When an agent works on an external resource, show the person what is about to change. A
**preview** draws a connection's content beside the chat: the resource as its provider has it
saved, with the changes that are still waiting marked on top. The person applies or discards
those changes from the Workshop, next to the preview.

The parts:

- A **preview UI**: client-side code a gatekeeper supplies, in the format and sandbox of a
  gadget's UI. Its `gadget` stub is the connection's own session instead of a gadget server.
- A **pending-changes read** on the session (`getPendingChanges()`), so the preview, and any
  gadget, can tell saved content from pending content.
- A **refresh signal** from the Workshop into the frame, because a session has no way to tell
  its holder that something changed.
- **Auto-open**: the Workshop opens the preview when work on a previewable connection starts.

What a gatekeeper does to have a preview: set `hasGadgetUi`, return client code from
`getGadgetUi()`, and give its session a `getPendingChanges()` plus whatever other reads its
client needs to draw the resource faithfully. Nothing else changes for it.

## Locked decisions

- **A preview is gadget-format code, not a kernel-typed document.** The gatekeeper returns the
  preview's source files, each a path and its code, as a gadget's file tree holds its UI. The
  kernel builds a
  `UiBundle` from them with the function that builds a gadget's (`buildUiBundle`), and the
  Workshop runs it in the existing gadget UI frame (`GadgetUI`): opaque-origin `srcDoc` iframe,
  same CSP, same MessagePort handshake. The
  alternative, a kernel `previewResource()` returning typed document/spreadsheet/presentation
  structures that the Workshop draws natively, was not taken: it puts every resource's shape
  into the kernel and the shared API, and every new kind of resource would change both.
- **Not a `GatekeeperUiFrame`.** A gatekeeper already serves two kinds of frame that way (its
  resource configurator and its account's management app): finished HTML, with a capability the
  gatekeeper chooses handed to it. A preview differs on both counts. Its capability is the
  session, so its reads are authorized and logged and anything it submitted would go through the
  approval queue, where a frame's `ui` stub answers to nothing but its gatekeeper. And its code is a
  gadget's UI files rather than a page, so the kernel checks its imports as it does a gadget's and
  a person can fork it into one.
- **A preview is shipped as source, so it can be forked.** Plain `.js` files with relative
  imports, `client.js` the entry: what a person would get on copying the preview into a gadget,
  and what they would edit. No bundler, no minifying and no TypeScript build stands between the
  files a gatekeeper keeps and the files it returns. Several previews of one gatekeeper can share
  modules; each returns the ones it uses.
- **The gatekeeper answers the gadget view calls; no gadget is created.** `GatekeeperClient` has
  the two calls `GadgetUI` makes, which `WorkpieceClient` declares for a gadget and a gatekeeper
  alike: `getUiBundle()` builds the files `Gatekeeper.getGadgetUi()` returns, and `connectToGadget()` opens the connection's session, which
  stands where a gadget's server would. That session's caller is a gadget whose ID is the
  connection's own workpiece ID. Workpiece IDs come from one counter, so it names no real gadget,
  and only real gadgets are walked for who reaches a gadget's reads (`gadgetsReaching()`): a
  preview's reads are recorded against the connection and checked against "build" collaborators
  only. A session from `openSession()` reads for the workspace, which every gadget's "use"
  collaborators are checked against too (`docs/observers.md` §10), so a preview drawn from one
  could lock such a collaborator out of an unrelated gadget on the same connection.
- **The preview holds a session and nothing more.** The frame's `gadget` stub is what
  `GatekeeperClient.connectToGadget()` returns, or for a preview of one item what that session's
  `openPreview()` returns. The preview can therefore do only what a gadget bound to the resource
  could, every read it makes is authorized and logged as an observation, and any action it
  submitted would go through the approval queue like any other. No new trust is introduced.
- **Read-only is a property of a preview, not a kernel limit.** The frame holds the full session;
  nothing in the kernel stops a preview from submitting actions. One it submitted would be queued
  as a gadget's is: waiting for a person, unless the user has switched on auto-approval for that
  kind of action on the connection, which applies it whoever submitted it (`autoApprovalRule()`
  does not ask). A pane that opens by itself is one more reason a preview submits nothing.
- **Applying and discarding stay in the Workshop.** The card with Apply and Discard is drawn by
  the Workshop outside the frame and calls the existing `approveAction()` / `rejectAction()`.
  Approval is the user's authority, not a capability a session holder has.
- **Pending changes are revealed through the session API.** `getPendingChanges()` is an ordinary
  session method, so a gadget can do what the preview does. Its shape is a convention every
  gatekeeper follows (section 2).
- **A gatekeeper declares its preview; the Workshop never names a vendor.**
  `ResourceDescription.hasGadgetUi` plus the optional `Gatekeeper.getGadgetUi()` follow
  `hasSlashCommands` / `getSlashCommandProvider()`.
- **No Preview buttons.** The preview opens by itself when work on a connection starts. One
  control per connection reopens a preview that was closed.
- **Change notification is host-relayed.** The Workshop sees every action on a connection in the
  action log and posts a content-free `refresh` message into the frame. Nothing is added to the
  session or the approval queue for this.
- **Cancel is deferred, and designed for.** Each pending change carries an `id` so a later
  `cancelPendingChange(id)` needs no change to the read.

## Current-state anchors (for orientation)

- `packages/workshop-frontend/src/GadgetUI.tsx`: the gadget UI frame. Takes any
  `GadgetUiSource` (`getUiBundle()`, `connectToGadget()`) and a `refreshSignal`.
- `packages/workshop-frontend/src/sandboxDocument.ts`: the frame's document and CSP.
- `packages/workshop-shared/src/gatekeeper.ts`: `Gatekeeper`, `ResourceDescription`,
  `ApprovalQueue` (`submitAction`, `authorizeObservation`, `bindHook`; no way for a gatekeeper to
  resolve an action).
- `packages/workshop-shared/src/api.ts`: `GatekeeperClient` (`describe`, `openSession`,
  `getUiBundle`, `connectToGadget`), `UiBundle`, `ActionLogEntry`.
- `packages/workshop-backend/src/ui-bundle.ts`: `buildUiBundle`, which follows `client.js`'s
  relative imports, rewrites them and enforces the UI import rules.
- `packages/workshop-backend/src/overseer.ts`: the gatekeeper client class builds the bundle from
  what the gatekeeper's `getGadgetUi()` returns; `actionRecordToLog` withholds the gatekeeper's own action number
  (`record.action`) from clients.
- `packages/workshop-frontend/src/useActions.ts`: `useActions`, `useActionEntries` (the live
  action log on the client).
- `.agents/skills/write-gatekeeper/SKILL.md`, "Revealing pending changes": the convention a
  gatekeeper author follows.

## Design

### 1. Preview declaration and delivery (workshop-shared + workshop-backend)

```ts
// gatekeeper.ts
type ResourceDescription = {
  /** Indicates that getGadgetUi() is available and draws the connection as a whole. */
  hasGadgetUi?: true;
}

type UiFile = { path: string; code: string };  // as written; client.js is the entry

interface Gatekeeper<Session> {
  getGadgetUi?(): Promise<UiFile[]>;
}

// api.ts: moved up from GadgetClient to the base it shares with GatekeeperClient
interface WorkpieceClient {
  getUiBundle(chatId?: number): Promise<UiBundle | null>;
  connectToGadget(chatId?: number): Promise<RpcStub<any>>;
}
```

The kernel adds the two calls and no storage: for `getUiBundle()` it asks the gatekeeper for the
files and runs `buildUiBundle` over them, so a preview's imports are followed and checked exactly
as a gadget's are, and `gatekeeper.ts` needs no UI type; for `connectToGadget()` it opens the
connection's session as `openSession()` does, under the connection's own ID as a gadget's. Both
refuse a `chatId`. A caller checks `describe().hasGadgetUi` before calling `getUiBundle()`;
calling it on a gatekeeper with no UI fails, as does a preview with no `client.js` or with an
import the rules refuse.

`describe()` may reach the provider. The flag is not stored on the connection record. If cheap
lookup is needed, denormalize it at connection creation as `hasSlashCommands` is; existing
connections would then lack it until re-described.

### 1a. A preview of one item of a resource (workshop-shared + workshop-backend)

A connection to a folder reaches many files, and a log entry names only the connection. So an
action may name the item it changes, and the item's session is opened by that name:

```ts
// gatekeeper.ts
type PreviewItem = { id: string; title: string; url?: string };

type ActionDescription = {
  /** The one item of the resource this action changes, when the gatekeeper can draw it by itself. */
  previewOf?: PreviewItem;
}
```

- `id` is the gatekeeper's own name for the item and opaque to the Workshop, which hands it back.
  It is not one of `ObservationDescription.subresources`: those are enforced and never shown,
  this is shown and enforces nothing. `title` and `url` are for the pane's heading and link, as
  `describe()`'s are for a whole resource.
- The kernel adds no storage and no code: an action's description is already stored whole and
  sent to clients whole. `gatekeeper-kit` carries the field from a
  definition's `describe()` to the queue.
- `getGadgetUi()` is not told the item: a connection has one set of files, which draws whichever
  item's session it is handed. What the item holds is read by that code through the session,
  where the gatekeeper checks access as for any read.
- Nor is it one of the action's `fields`, which are what an approver reads and which a gatekeeper
  words for a person. `previewOf` is read by the Workshop to decide what to draw, and has to mean
  the same thing in every action that touches the item.
- A preview is therefore offered in two ways, and the Workshop looks for both: `hasGadgetUi` on
  `describe()` offers one of the whole resource, and an action that names an item offers one of
  that item. A connection can do either, both or neither, and the second needs no `hasGadgetUi`.
- The session an item's preview draws from is not in the kernel's types. The Workshop calls
  `openPreview(id)` on the connection's session and hands the frame what it returns. That is a
  convention between a gatekeeper and the Workshop (on `PreviewItem.id` and in the
  write-gatekeeper skill), checked by
  no interface: `Session` is opaque to the kernel, and a typed method there would put a preview's
  shape into it. A gatekeeper that names items and has no `openPreview()` gets a pane that fails
  to load, which a test of its preview catches.
- On actions only. A read that names an item would open a preview for everything an agent skims,
  and a preview's own reads are recorded against the connection, not a chat.
- Tested by the integration test above: an action carries `previewOf` to a client.

### 2. The pending-changes read (each gatekeeper's session)

A convention, not a kernel type: the kernel never sees these values. Every session that reveals
its pending changes uses one shape.

```ts
getPendingChanges(scope): Promise<{ changes: PendingChange[]; /* the resource, saved and pending */ }>

type PendingChange = { id: number; stale?: true; type: string; /* ...that method's arguments */ }
```

- `scope` is what the session's content read is scoped by (a tab, a sheet, a slide), and is
  always named.
- Beside `changes`, the result carries the scope as the provider has it saved and as it reads
  with the pending changes applied, in whatever form the session's content read uses.
- Changes are oldest first, the order they apply in. `type` is the session method that made the
  change, followed by that method's arguments without the scope.
- `id` is the number the gatekeeper passed to `submitAction()`. It is not the Workshop's action
  log id.
- `stale` marks a change the resource no longer fits. It is left out of the pending copy, cannot
  be applied, and stays listed until rejected.
- A change that has already reached the provider is not listed, even if the gatekeeper has not
  yet heard so: the saved copy already holds it.
- One authorized observation per call, reporting what the content read reports.
- Agent-facing docs call a change "pending" until the provider has saved it, and do not mention
  approvals.

### 3. A preview client (each gatekeeper)

Gadget-format client code the gatekeeper returns from `getGadgetUi()`, as source files. How it
draws its resource is the gatekeeper's business; what every preview keeps to is:

- It reads only through the session: once on load, and again on each `refresh` message from its
  parent. Each read is a logged observation, so it does not poll.
- It shows the resource with its pending changes, and what those changes did against the saved
  copy, from the session's `getPendingChanges()`.
- It says when a change is stale, since a stale change appears in neither copy.
- It treats everything the resource says as text. Nothing from it is parsed as HTML into the
  frame.
- It follows a link inside the resource itself. One to the web is a link element that opens a new
  browser tab (the frame blocks `window.open()`), and only for saved content: text in a pending
  change is not yet approved, and its address could carry what the resource holds elsewhere.
- It carries its own styling for light and dark; the Workshop's tokens do not exist in the frame.
- It gets images and other media as bytes from the session and draws them as `data:` URLs. The
  frame's content policy lets it load and fetch nothing from the network, and stays that way: a
  host the frame could load from is a host it could send the session's data to.
- It sends nothing the session returns anywhere else. The frame does not see to that: its
  content policy does not cover WebRTC, and a link can be followed out of it. Keeping a session's
  data off the network is a rule a preview keeps, the one about links above among them.
- It does not apply or discard. Those stay in the Workshop.

A preview is only as faithful as its session: it can draw what the session's reads return and
nothing more. A gatekeeper that wants its preview to look like the real thing adds the reads for
that to its session, where a gadget can use them too.

### 4. The Workshop pane (workshop-frontend, `features/connection-preview/`)

None of this names a vendor or a resource type; it works from `hasGadgetUi`, the action log and
the connection's ID.

- `ConnectionPreviewPane`: hands `GadgetUI` the connection's `GatekeeperClient` as its source, as
  a gadget's client is handed to it (for one item, a source that opens the item's session),
  relays a debounced refresh when an `action` entry arrives for the connection, and draws the
  "changes waiting" card. Observation entries are ignored: the preview's own reads are logged on
  its connection and would refresh it forever. In a restricted workspace the card points to the
  chat instead of offering Apply and Discard.
- `useAutoOpenConnectionPreview`: opens a connection that offers a preview at its first live read
  or change, and at each change queued after that. Work from before the page loaded does not
  count, nor does the last record of a session that is resumed, which the server delivers again
  on a reconnection or a return to the workspace. A connection whose preview the user closed stays closed until reload or until another
  workspace is opened (connections are numbered per workspace), and a single-pane layout is left
  alone.
- `usePendingConnectionPreviews`: the connections that offer a preview and have changes waiting.
  The editor shows a button in the top bar for each one whose preview is not showing.
- `connectionPreview.ts`: `previewOffers()` asks `describe()` once per connection for a stay in a
  workspace, across reconnections, and asks again a connection that could not be asked. The
  pane's icon is the one the vendor gives the connection's type of resource
  (`SupportedResource.icon`, found through `getCreationSpec()`), so a gatekeeper says nothing
  more for it.
- The pane takes the Activity pane's place in `GadgetEditor` and shares its open and close
  handling. The top bar's Activity button switches back.

## Verification of the framework

- Integration: a client reads `hasGadgetUi` and `getUiBundle()` from the test gatekeeper through
  `GatekeeperClient`. The test preview is two files and one it never imports: the import arrives
  rewritten and the unused file does not arrive. A read through `connectToGadget()` of what a
  "use" collaborator's account cannot read leaves them able to open their gadget on the same
  connection, where the same read through `openSession()` locks them out
  (`observer-tracking.test.ts`).
- Frontend: the pane in real Chromium against a fake session (the frame is opaque-origin, so the
  test asserts the session's call log), and unit tests for the auto-open and pending-preview
  rules. No test of the pane uses a real gatekeeper's client.

## Known edge cases / watch-fors

- **Ids do not match the action log.** A preview's change ids are the gatekeeper's; the
  Workshop's card uses action log ids. They correspond only by order, and not exactly: the card
  counts the whole connection, a preview lists one scope and omits changes that already landed.
  One-to-one linking needs the gatekeeper's action number on `ActionLogEntry`, which
  `actionRecordToLog` withholds today.
- **Any read opens the preview.** The action log entry does not say who made a read, so a gadget
  polling a previewable connection opens the preview once per page load, and every collaborator
  in the workspace sees it open, not only the person whose chat is working.
- **Reads the user did not ask for.** Auto-open logs observations in the activity history
  without an explicit request.
- **`describe()` on workspace open.** A workspace opened with changes waiting describes that
  connection to decide whether to show the reopen button.
- **Refresh only reaches a Workshop frame.** A "use"-role viewer's action subscription is inert,
  so a preview shown to one would not refresh. Gadget server code gets no signal at all.
- **Edits made at the provider directly** are seen only on the next read, subject to the
  session's own caching. Nothing notifies the preview.
- **Size.** Nothing in the framework caps what a preview reads or draws; that is each client's
  to handle.

## First preview: Google Docs

Everything specific to one vendor is in this section and in `packages/gatekeeper-google`.

### Session reads

On `GoogleDocSession` (`docs-types.d.ts`, what an agent sees; implemented in `docs.ts`). A
preview's reads are declared there although they add about a third to what every agent
given a Doc is sent: a forked preview is edited by an agent, which learns the session from
these types alone. Sheets and Slides declare their pending changes there too, and the reads
that only render apart (see "Shared by the three previews"). Each
reads one tab and takes a required `tabId`: `getContent()` lets it be omitted for a one-tab
document only because callers older than tabs exist, and these reads are new.

```ts
getPendingChanges(tabId: string): Promise<GoogleDocPendingChanges>;  // { savedMarkdown, markdown, changes }
readDrawing(tabId: string): Promise<GoogleDocDrawing>;   // the saved tab as Google Docs lays it out
readImage(imageId: string, tabId: string): Promise<GoogleDocImageBytes>;  // at most 10 MB
readFont(family: string, weight: number, italic: boolean): Promise<Uint8Array>;  // a family the drawing named
getRenderingTypes(): Promise<string>;                    // the declarations of readDrawing()
listImages(tabId: string): Promise<GoogleDocImage[]>;    // one for each [Image] in getContent()
```

- `getPendingChanges()` follows section 2: the changes are `replaceText` and `appendText`, and
  the two copies are Markdown. It is on the sessions that edit: the Doc's own, and the one a read
  and write Drive binding opens (see the Drive section). A tab still to be added reads as saved and empty, with
  every edit to it listed.
- `readDrawing()` (`docs-drawing.ts`) is the saved tab resolved to what a renderer needs and no
  more: the page, its sections with their margins, columns and the headers and footers each
  names, every paragraph, table and list with its look in full (inheritance from the named style
  already applied), every image with its size, crop and, when it is positioned, its offsets and
  how text wraps it, and footnotes. Looks are held once and named by index. Each block of the
  body names its line of `savedMarkdown`, and each run where it starts in that line, so a caller
  lays the drawing over the Markdown diff it already has. It says nothing about pending text.
- Its types are apart, in `docs-rendering-types.d.ts`, and `getRenderingTypes()` returns them:
  they would double the session's declarations, and an agent that only reads and edits a
  Doc never needs them. An agent editing a forked preview is told by `getRenderingTypes()`'s
  comment to fetch them first. Sheets and Slides keep their reads that only render apart the
  same way.
- The drawing is cached with the tab's snapshot and has a version of its own
  (`DOC_DRAWING_VERSION`), so a change to it discards cached snapshots without marking queued
  edits stale as a change to the Markdown rendering would.
- `listImages()` is for an agent, not the preview, which takes its images from the drawing. An
  agent sees an image only as an `[Image]` placeholder in `getContent()`, and `listImages()`
  gives each placeholder's ID, size and alt text in order, so that `readImage()` can be called
  without the drawing or its types. `getStyles()`, which the preview read before the drawing,
  is gone: the drawing holds all it returned, in full.
- Fonts come through the session as they do for Sheets and Slides: `readFont()` reads a family
  the drawing of a tab already read names, and no other, from Google Fonts. A family Google
  Fonts does not serve is drawn in the browser's nearest.
- Image bytes are streamed, read from Google as the frame reads them, and fail partway past
  10 MB where Google did not state the size. (A stream from the backend session reaches the UI
  frame from capnweb 0.13.0.) Google's image addresses lapse; a read that finds one lapsed
  reads the document again. Any other failure to fetch an image is reported as it is: only a
  lapsed address (403 or 404) is mended by another read. Images in headers and footers, and
  positioned ones, are read the same way.

#### What the Docs API withholds

Found against real documents, and each is drawn as near as the API allows:

- **A header or footer of "every other page" can be missing.** A document with a different
  first page returned its first-page header and footer and nothing for the rest, although Google
  Docs draws one on every page. The positioned images tethered in the missing ones are still in
  `positionedObjects`, tethered to no paragraph returned. The drawing gives such a section a
  header and footer with the ID `unreturned`, holding those images, split between the two by
  which returned part each lies nearest. Their text, a page number included, and their true
  height cannot be recovered.
- **Where a header sits when the document does not say.** Unless
  `documentStyle.useCustomHeaderFooterMargins` is set, Google Docs ignores `marginHeader` and
  `marginFooter`. Measured in the editor, the header then starts 5.25pt (7px) from the top of
  the sheet, the footer ends 3.6pt *below* the bottom margin's edge, and a header deeper than
  the top margin keeps 5.25pt between itself and the body (`headerGap`). All three are measured,
  not documented; the footer's rests on one document.
- **How Google Docs sets a line.** None of this is documented. It was read off the pages the
  editor draws at 100% (every line's text, font and baseline, and every image's rectangle) for
  five documents in six families, and the client's drawing of four of them was compared with
  it line by line. The client (`draw.js`, `pages.js`) follows these rules:
  - *Every font is set alike.* A line of text is 1.18 times its size tall, times the
    paragraph's line spacing, with the baseline 0.96 of the size under the line's top and the
    rest under the text. A font's own ascent and descent play no part, so each font read for
    the document is given those two as overrides. A line of mixed sizes takes the largest.
  - *Each line is rounded up to a whole pixel*, after the paragraph's space above is added to
    its first line and its space below to its last. A paragraph of one line is rounded once,
    with both.
  - *Between two paragraphs only the larger space is kept*, of the upper's space below and the
    lower's space above. Measured where the space above is the larger; assumed the other way
    round. At the top of a page the space above is kept.
  - *Letters are as wide as the font draws them.* Chrome on Linux rounds each letter's advance
    unless `text-rendering: geometricPrecision` is set, which moved where lines wrap.
  - *No line ends at a hyphen inside a word*: of 644 lines, 53 hold one and none ends at it.
  - *A paragraph that ends in a page break* leaves no empty line on the next page.
  - *A line goes on a page only if its whole box fits*, space included: half a pixel over
    moved a line to the next page.
  - *An object is a whole number of pixels wide and tall.* An inline image stands on the
    baseline, 2px under its line's top when it is taller than the text, and its line is the
    image's height plus 2px plus what a text line of the run's size has under the baseline.
    How far a browser's text reaches under the baseline is measured in the page, since Chrome
    rounds a font's ascent and descent its own way.
  - *Consolas* is Google's own copy, 1126/2048 of its size wide. Whatever fixed-width font
    stands in for it is letter-spaced to that (`FIXED_WIDTHS`).
  - *A paragraph's end sizes only an empty paragraph.* The mark that ends a paragraph has a
    look of its own, often larger than the text before it, and a line with text on it is no
    taller for it. The spaces a paragraph ends in take no room: centered text is centered
    without them, and they start no line.
  - *A table is drawn as CSS collapses one*: a column's width runs between the middles of its
    lines, and a 1pt line is one pixel. The line between two rows is on a whole pixel, so a row
    is its lines, its padding and its border rounded up.
  - *A cell that states no padding has Word's*: none over or under its text, 5.4pt beside it. A
    table made in Google Docs states 5pt all round; one brought in from Word states nothing,
    and usually also starts a padding and a border before its column, so that its text starts
    where the column does. The Docs API returns neither a table's indent nor its alignment, so
    that is drawn for a table wider than its column and no other.

### Client

`gatekeeper-google/src/previews/docs/`, linted `.js` files that are not type-checked:

- `client.js`: reads the tab, composes what to draw from the drawing and the Markdown diff, and
  owns the views, the outline and the change navigator.
- `draw.js`: one block (a paragraph, a table, a list item, an image) as DOM, and the stylesheet.
- `pages.js`: lays composed blocks out on sheets.
- `text.js`: the Markdown the diff works on, as lines, words and inline pieces.

What any preview of this gatekeeper needs is a module of its own, `previews/shared/chrome.js`,
imported as `./ui/chrome.js`: the theme, the outline sheet and the dot it puts on what holds a
change, the change navigator, the part navigator, the stale banner, the loading, updating and error states, and the refresh handling. `getGadgetUi()`
returns all of them, listed once in `previews/files.ts`. The gatekeeper's bundler imports only
`.txt` and `.svg` as text, so each file is imported through a `.txt` symlink beside it, and
`previews/docs/ui` links to `previews/shared` so the import resolves on disk too. The frame calls
`main(gadget)` on the client's default export.

It draws a tab on its own pages, in the document's fonts, colors, tables and images, marks
insertions and deletions, lists the tabs and the tab's headings in an outline, and steps through
the changes in the tab shown. A tab still to be added is marked in the outline; the client knows
it by the provisional ID `addTab()` returns. It only reads.

**Composing.** The Markdown diff says which lines changed. A line that did not is drawn from the
drawing's block for it, exactly as saved. A line that changed or was added is drawn from the
Markdown's words, each taking the look of the saved run it came from, so that an edit in the
middle of a sentence keeps the bold beside it. A paragraph a change adds takes the look of the
paragraph it is written into when their named styles agree and the named style's own otherwise,
which is what `markdownToDocRequests` will ask Google for. A changed paragraph keeps the images
and page breaks of the saved one. This is the simulation: what is drawn "with changes" is laid
out by the same rules as what is saved, so text a change adds pushes the rest down the page and
onto the next.

**Paging.** `pages.js` sets the blocks in a column as wide as the section's and splits it where
a sheet's body ends: between lines of a paragraph (keeping `keepLinesTogether`,
`keepWithNext` and two lines either side of a break), between rows of a table, and at page and
section breaks, pending ones included. Each sheet gets the section's header and footer (the
first page's and even pages' where the section has them), with page numbers filled in, and
footnotes at the foot of the page their reference lands on. Positioned images are placed from
their paragraph by their offsets; text wraps one by a float with a spacer above it, and those
in front of or behind text are layered. Splitting works on the laid-out DOM, so the browser
breaks lines and the client only decides where a sheet ends. A pageless document is one sheet.

**Views.** Three, on a control in the bar shown only while the tab has changes waiting, and
opening on the first:

- *With changes*: the tab as it will be once every change is applied, paged, with what changed
  tinted. Nothing removed is drawn.
- *Inline*: a redline on one endless sheet, removed text struck through beside what replaces
  it. It is not paged, because text that is both there and not has no true page.
- *As saved*: the tab as Google Docs has it now, paged, unmarked.

Slides has two of these; a document needs the third because a reader checking an edit wants to
see the words that went, and a reader checking layout must not have them take up room. The
tint of a change follows the lines of its text, not the paragraph's box, so it goes around a
wrapped image rather than across it.

**Stepping through pages.** A navigator at the foot of the frame, right, the twin of the change
navigator at its head: "Page", the page read of how many ("3 / 21"), and an arrow each way
(`stepper()` in `chrome.js` builds both, and `partNavigator()` there is this one, which Slides
shares). It steps to the top of the next or the previous sheet,
counts steps made while one is still under way, dims the arrow there is nothing past, and names
the page read ("Page 3 of 21") to assistive technology. It is hidden where there is one sheet: a one-page tab, a
pageless document, and the Inline view. The Workshop's card for a change waiting lies across
the foot of a frame narrower than 900px, so there the navigator stands above it while the tab
has changes.

**Refreshing.** The tab list and the pending changes are asked for together. A refresh that
finds the tab's drawing and both copies of its Markdown as they were, as when a change is made
to another tab, leaves what is drawn alone. Bold and italic faces are read beyond the saved
looks' only where a pending change writes them.

**Falling back.** When `readDrawing()` fails, or its blocks do not match `savedMarkdown`'s
lines, the tab is drawn from its Markdown alone, on one sheet. The Markdown does not escape the
document's text, so a paragraph that reads `# of rows` is a heading in it: where the drawing
has that text in a paragraph that is no heading, the line is read as the drawing has it, and
is no mismatch.

**Paper.** A sheet is the document's own color, white unless it says otherwise, in both themes:
a document's colors are chosen against its paper.

### Verification

- Docs actions suite (workerd): pending changes in order with their arguments, one observation,
  stale changes, tab filtering, the unknown-tab error, a tab still to be added, applied and
  rejected changes, the lost-response case, images (listing, refusals, the size
  limit, a lapsed address), and the drawing (its observation, the unknown-tab error, and the
  declarations `getRenderingTypes()` returns).
- The drawing itself (`docs-drawing.test.ts`): each block's line and each run's place in the
  Markdown, header and footer margins with and without `useCustomHeaderFooterMargins`, a header
  with a tethered image, the `unreturned` header and footer, and an image tethered nowhere.
- The client in a same-origin frame in real Chromium, where its drawing can be read: the three
  views, sheets with their headers, footers and page numbers, saved and pending page breaks,
  images kept through an edit, the looks pending words take, and the Markdown fallback.
- Against Google Docs itself. A harness draws a captured drawing beside a screenshot of the
  same document, and the editor's own drawing calls are recorded in a browser tab (the text,
  font and baseline of every line and the rectangle of every image), then compared with the
  client's lines. A 20-page A4 design document in Droid Sans and Consolas makes the same 20
  pages, with each of its 450 lines holding the same words within half a pixel of where the
  editor puts it. Class notes in Roboto Slab with inline images match line for line, images
  included. A brochure (first-page header and footer, positioned and wrapped images) is
  within a pixel down its first page; its second starts 22px high, because the Docs API does
  not return the header Google draws there (see above).
- Two documents that are mostly table, each one page in the editor and one here. A form
  brought in from Word (merged cells, shaded cells, no stated padding) has its table's columns
  on the editor's pixels, each of its 79 lines ending at the editor's word and within half a
  pixel of where the editor draws it, and every line between two rows on the editor's pixel.
  It is set in Cambria, read from Google Fonts; in the serif a browser without Cambria draws
  instead, 34 of the 79 lines ended at another word and the table was seven lines shorter. A rubric
  made in Google Docs has its rows within a pixel: its table is centered in the editor and
  starts 2px further left here, and its first and last rows are a pixel taller here.
- Live, against a real Google Doc on a local instance: styles, tables, images, several tabs, a
  pending tab add, the outline, heading links, replacements, appends and a stale change; refresh
  on queue and discard; auto-open, dismissal and reopen. Opening a preview logs the tab list,
  the pending changes, the drawing and one read per image drawn. Each change event logs the tab
  list and the pending changes again.
- Not verified live: a web link opened from the real frame, a Doc that has not been created yet,
  and an agent queuing edits from a chat (the local instance had no model; edits were queued
  through the API). Not compared against Google Docs: tables that cross a page, columns,
  footnotes, even-page headers, landscape sections and right-to-left text.

### Watch-fors

- **Every image read is authorized.** A listing tells of an image, not its bytes, so
  `readImage()` is authorized and logged as its own read: one log entry per image.
- **Bookmark links go nowhere.** The Docs API gives a bookmark's ID and tab but not its place,
  so a link to one in the tab shown cannot be followed.
- **The navigator steps through places, not requests, and shows no count.** A place is a stretch
  of changed text in the tab shown, so several requests can be one place: a number of them beside
  the Workshop's count of requests read as a disagreement. Its group names the number of places to
  assistive technology. The card says which request it holds ("1 of 3 changes waiting"), which
  is the one its Apply and Discard act on.
- **The card floats over the foot of the frame, closed.** It shows the request's title and one
  line of its description, so the frame keeps the room; "More detail" opens everything the action
  sends, scrolling inside half the pane. What a change adds at the very end of a document can lie
  under the closed card until it is scrolled up.
- **Large documents.** The client fetches, diffs and pages the whole tab. Nothing caps a tab's
  size or keeps only the text around each edit.
- **Page breaks follow measured rules, not documented ones.** A sheet ends where the browser's
  line breaking and the rules above put it, which matched the editor on the documents compared.
  A line that fits by a fraction of a pixel in one and not the other still moves a paragraph
  across a page, and that is likeliest where the rules are assumed or unmeasured: a space
  below larger than the next space above, tables, columns, footnotes, a font the browser
  swaps for another, and a header the Docs API does not return.
- **A full-width inline image** is drawn 2px further right by Google Docs than here, and the
  place of a tethered object is not rounded to a whole pixel.
- **A line's height is not quite the same for every font.** 14pt Karma and 10pt Arial at 1.15
  are each a pixel shorter in the editor than 1.18 times the size rounded up makes them, where
  20pt and 21pt Roboto are not: the factor differs between fonts in its third digit, which
  shows only where a line comes within a tenth of a pixel of a whole one.
- **Fonts that are not Google's.** Google Fonts serves the families an editor offers that are
  Microsoft's or Apple's (Cambria, Calibri, Consolas, Georgia, Times New Roman, Verdana,
  Trebuchet MS, Courier New, Tahoma, Helvetica and others) in the files the editor draws with,
  though its catalog does not list them, and they are read as any other family is, also where
  the browser has its own. It refuses Arial, which is left to the browser, and weights a
  family lacks (Calibri Light). Most are under 150KB a face; Times New Roman and Tahoma are
  600KB to 800KB. A family made to stand in for one is not as wide: Caladea sets a line about
  5% narrower than Cambria.
- **Text wraps an image on one side.** Google Docs runs text down both sides of an image set in
  the middle of a column; here it keeps to the wider side.
- **Tab stops** are drawn at the default spacing, not at the stops a paragraph sets.
- **The Docs rendering version moved from 6 to 7.** Snapshots cached and edits queued under 6
  are discarded or marked stale once, as for any rendering change.

## Next previews: Google Sheets and Google Slides

Both use the framework as it stands: session reads and a client each, no kernel or Workshop
change. One pull request, stacked on the Google Docs one.

### Shared by the three previews

- **One folder per preview**, each with its own `client.js`: `previews/docs/`, `previews/sheets/`,
  `previews/slides/`. The gatekeeper returns each preview's files with the modules it shares.
- **Shared modules** (`previews/shared/`), taken out of the Docs client before the other two are
  written: the theme tokens, the outline sheet, the change navigator, the part navigator, the
  stale banner, the loading, updating and error states, `make()` and `lineIcon()`, and the
  refresh handling. The three previews then look and behave as one product.
- **One dot for a change, in three colors.** The outline marks what holds a change with a dot
  (`touch()` in `chrome.js`): green where every change in it adds, red where every one removes,
  and purple (`--edit`, `--edit-ink`) where they edit, or both add and remove. The title of what
  it marks says the same in words ("has pending additions", "deletions", "edits"), as the outline
  names everything else. Docs takes each heading's section from its rows: a paragraph added or
  removed whole is that, an edited one is what its changed words are, and one written over
  another or restyled with its words left alone is an edit; a section folded away adds its
  changes to the heading it is folded under. Sheets has only what its listing says of a sheet:
  added, deleted, or touched, which is an edit (a sheet's renamed and moved chips are purple
  too). Slides rings the thumbnail instead (below).
- **What each keeps to itself:** how it reads and draws its resource.
- **Every read is authorized**, a picture's as for Docs images and each window of a sheet: a
  listing or drawing tells of a picture, not its bytes, and skipping the check would also skip a
  Drive folder connection's proof that the file is still in the folder. A picture of a slide
  already drawn asks Google for nothing but the picture.
- **Bytes travel as a stream**, which the frame reads whole into a `data:` URL or a font face: a
  picture as Google sends it, and a font, which the isolate keeps, in pieces of 64 KiB, so that
  no one message holds up what else the Workshop's connection carries.
- **Reads that only render are declared apart.** A spreadsheet's `readDrawing()` and a
  presentation's drawings, pictures and fonts serve nothing but rendering, and their shapes were
  most of what a preview added to the types every agent given the connection is sent. They are
  declared in `sheets-rendering-types.d.ts` and `slides-rendering-types.d.ts`, which no agent is
  sent. The session's `getRenderingTypes()`, which is in the agent's types, returns them to one
  that asks, as an agent editing a forked preview would; it reads nothing of the resource and
  reports no read. The pending-changes reads and a Doc's image reads serve more than rendering
  and stay where they were. Whether agents call it when they should is unmeasured.

### Google Sheets

Scope of the first version, which is what can be drawn as Google draws it from what the Sheets
API returns:

- **Drawn:** each cell's displayed value, its effective format (conditional formatting included),
  font, number format, alignment, wrap, borders and text turned on its side (text turned by less
  is drawn level); merges; row heights and column widths; hidden
  and frozen rows and columns; hidden gridlines; the sheet tabs, with added, renamed, moved and
  deleted sheets marked.
- **Changes:** a cell a queued change enters a value in or formats is marked and names its
  change; its saved value is kept beside it for a before and after. Inserted rows and columns are
  drawn as bands, deleted ones where they stood. A queued formula shows its text with a pending
  look, since only Google can work out its result.
- **Not in the first version, wanted later:** charts, images, dropdowns and checkboxes, filters,
  banding and table styles, rich text within a cell, notes. Each is left a placeholder where it
  has a place on the grid, so adding one later is a new read and a new drawing, not a redesign.
  To check before promising any: charts come from the API as specifications with no rendered
  image, and images placed over the grid may not come from it at all.

Session reads, on `GoogleSpreadsheetSession`:

```ts
getPendingChanges(sheet: string): Promise<SpreadsheetPendingChanges>;  // { changes, areas, sheets }
readDrawing(range: string): Promise<SpreadsheetDrawing>;               // one window of one sheet
readFont(family: string, weight: number, italic: boolean): Promise<Uint8Array>;
```

- A sheet is too large to return whole, so `getPendingChanges()` returns, beside `changes`, the
  areas the changes touch and the sheet list as saved and as it will be; the cells come from
  `readDrawing()`. This is the convention of section 2 with the two copies read by window.
- `readDrawing()` returns a window's cells as they will be, each with its saved value when a
  change touches it, plus the sizes, merges, frozen and hidden lines the window needs. A sheet's
  frozen rows and columns come with every window and count toward its cells. A merge that starts
  outside the window comes with its first cell, up to 20 a window.
- A fill a conditional rule gives a cell is kept under a fill a queued change sets, as Google
  draws the rule's over the cell's own. The rule is not worked out again: one that a queued value
  would switch on or off is drawn as it stands now.
- Google reports a row nobody has resized at the default height, though it draws the row as tall
  as its text. The drawing gives such a row the height of its tallest cell, counting the lines of
  wrapped text by an average letter width, since Google's own measure of the text is not read. A
  header that wraps can so be a line taller or shorter than Google draws it.
- Fonts come through the session as they do for Slides, without a listing: `readFont()` reads a
  family that the saved cells of a drawing already read are set in, and no other, so a font only
  a pending change sets is not fetched until the change is saved.
- An area a change touches names its change and what it does; rows and columns a change deletes
  are a seam with their count where they stood, not their saved contents.
- A read that fails once a sheet is drawn leaves the drawing in place and offers to try again;
  a window Google or the session finds too large is asked for again, smaller.
- **Limits:** 10,000 cells drawn at once (what one format read may fetch). A sheet of up to 200
  rows by 26 columns is drawn whole from A1; a larger one opens on the areas its changes touch,
  with a few rows and columns around each, and reads further windows as the person scrolls.

### Google Slides

Slides are drawn from the presentation's own model, not from Google's thumbnails: a thumbnail
shows only what is saved, and a pending change has to be drawn.

- **Outlines the model lacks come from Google's PowerPoint export.** The Slides API gives a
  freeform shape no outline and a preset shape none of its dragged handles (how far a corner is
  rounded, where an arc ends). The export has both. The gatekeeper fetches it through the Drive
  API inside the read of the slides, at most once a minute and only for a presentation that has
  such a shape, keeps the outlines and not the file, and matches its shapes to the model's by
  slide order, document order, kind and placement. A shape it cannot match for certain, and
  every such shape of an account with no Drive read access, is drawn as a hatched box; a preset
  is drawn at its defaults. The export is the saved presentation's content, so it adds no
  observation. A slide whose outlines are still on their way says so, and the client reads it
  again, three times at most.

- **Resolved as Google resolves it for display.** A placeholder takes its place, fill, outline
  and text styles from its layout's placeholder, and that from its master's; a slide shows its
  master's and layout's other elements behind its own; theme colours become the master's.
- **Drawn:** shapes with their geometry, fill, outline and shadow; text with each paragraph's and
  run's full style, bullets and autofit scale as Google last reported it; pictures with crop and
  transparency; tables; lines and arrows; groups; backgrounds.
- **Not drawn as Google draws them:** how Google re-fits text a pending change lengthens, bent
  and curved connectors (drawn straight or with a default bend), gradients, a picture's
  recolouring or mask, video, charts beyond their last picture, and the handles of some presets
  (braces, curved and bent arrows, ribbons, waves).
- **Changes:** the slide is shown as it will be, with each changed element outlined and naming
  its change, in green where it is added, red where it is deleted and purple where it is
  edited. A toggle shows the slide as saved. A filmstrip lists the slides with added, changed,
  moved, skipped and deleted ones marked: in place of the dot, the thumbnail is ringed green for
  a new slide, red for a deleted one, and purple for one changed, moved, skipped or shown again,
  with its tag in the same color, there and over the slide. The slide being read keeps its
  blue ring, whatever is to happen to it, and is the only thumbnail with a glow.
- **Stepping through slides.** The page navigator of Docs, as "Slide" ("4 / 27"), steps from
  card to card and follows the slide the filmstrip marks as read, with the same lift above the
  Workshop's card. It counts and numbers the slides there will be, as the filmstrip does, and
  steps to a slide to be deleted too, which reads "– / 27" and is named "Deleted slide, after
  slide 7 of 27". Speaker notes are diffed as text.
- **Checked against Google's own rendering.** `getSlideThumbnail()` is the reference for a saved
  slide: a slide drawn as saved is compared with its thumbnail.

Session reads, on `GooglePresentationSession`:

```ts
getPendingChanges(): Promise<PresentationPendingChanges>;        // { changes, slides: saved and pending order }
readSlideDrawings(slideIds: string[]): Promise<SlideDrawing[]>;  // resolved, pending and saved
readPicture(pictureId: string, slideId: string): Promise<SlidePictureBytes>;
listFonts(): Promise<SlideFont[]>;                               // the families and weights the deck uses
readFont(family: string, weight: number, italic: boolean): Promise<Uint8Array>;
```

- The scope of `getPendingChanges()` is the presentation, since a change can move, add or delete
  slides; each change names the slides it touches.
- **Fonts come through the session.** The frame has no network, so the gatekeeper fetches each
  font the saved deck uses from Google Fonts and returns its bytes, and the client registers them with
  `FontFace`. A family Google Fonts does not serve falls back to a system font of the same kind.
  The frame's content policy has no `font-src`, and `FontFace` takes bytes under it all the same
  (checked in Chromium). A font only a pending change names is not fetched until the change is
  saved, and is drawn in the fallback till then: the fetch is not reported as a read, so it is
  kept to names that are the presentation's and not their author's choice.
- **Limits:** 50 slides drawn, read 10 at a time, those the changes touch first, then their neighbours, then the
  rest in order; any other is listed by its title alone. 75 pictures, each fetched only as large
  as it is drawn. A slide's pictures come named in its drawing, so there is no listing of them.

### Test files and verification

- A spreadsheet and a presentation with real complexity, connected in the test workspace with
  edit access: both sessions refuse to queue a change to a file their account cannot edit, so a
  public file is used through a copy the test account owns. Edits are queued through the API and
  denied, never approved.
- Each preview: a worker suite for its reads, the client in a same-origin frame in real
  Chromium, and a live pass against the real file. Slides adds the thumbnail comparison.

## Files reached through Google Drive

A Drive connection (a whole Drive, a folder or one file) edits Docs, Sheets and presentations
through the same sessions as their own connections, so their previews draw them unchanged. What
differs is which file, which section 1a answers:

- **Each edit names its file.** `previewOf` is `{ id, title, url }`, set where the edit's card
  gets its "File" fields. `id` is the file's kind, the folders between the connected one and the
  file, and the file: `docs:<folder>/<folder>/<file>`. A folder session opens only its direct
  children, so the way in is part of the name; nothing but the gatekeeper reads it.
- **`getPreviewUi(previewOf)`** returns the files of that kind's preview, from one list the three
  gatekeepers share (`previews/files.ts`). It asks Google nothing. A Drive connection reports no
  `hasPreview`: it has no preview of itself.
- **`openPreview(previewOf)`** on the Drive session walks the folders and opens the file with
  `openGoogleDoc()` and its siblings, so the file's place in the binding's scope is proven as it
  is for an agent. The session convention is in the write-gatekeeper skill. It is not in the
  agent's types.
- **The Workshop** tells previews apart by connection and item. It asks for the item's code,
  opens the connection's session, calls `openPreview()` on it and hands the frame only the
  result, letting the Drive session go: the frame holds one file, not the binding. The card and
  the refresh take only actions that name the same item, which matches Drive ordering approvals
  by file. An item's preview opens when a change to it is queued, never on a read: a preview's
  reads are recorded against the workspace, and an agent skims many files.
- **The Doc a Drive binding opens** gains the four preview reads on its edit session.
- Not built: a read-only binding (its sessions have none of the reads), comments, shares and
  moves naming their file, and an icon for each file: the pane's icon is that of the
  connection's type of resource, and a file's kind is known only to the gatekeeper.

## Pull requests

1. **The framework's kernel half.** `Let a gatekeeper supply code that draws its resource`:
   `hasGadgetUi`, `getGadgetUi()`, the gadget view calls on `GatekeeperClient`, and the integration tests. This plan
   rides with it.
2. **The Workshop pane and the first preview, stacked on the first.** Google Docs' session
   reads, its client, and the pane with auto-open, one commit each.

## Punted / future work

- **More previews.** Each brings its own session reads and client, and should need no kernel or
  Workshop change. If one does, the framework is wrong, not the preview.
- **Cancel from the preview.** Sketch: `cancelPendingChange(id)` on the session, and
  `ApprovalQueue.withdrawAction(action)` so the kernel runs its existing reject path (which calls
  the gatekeeper's `rejectAction()`), keeping one reject path. Open: who may withdraw (any holder
  of the read-write session, which a forked preview needs, versus only the submitter), how a
  withdrawal is attributed when the session is a gadget or carries no user identity, restricted
  workspaces, and re-entrancy of the kernel calling back into the gatekeeper mid-call.
- **Accept all.** A Workshop control that approves a connection's pending actions oldest first,
  from the ids taken at click time. Needs a decision on partial failure.
- **Per-connection "Review" rows in the chat** and the "N changes drafted" bar from the mockup.
- **Fork to gadget.** The files are ready to copy. A fork must stay in the same workspace and bind the existing connection:
  the pending store lives in the connection, and `newWorkspaceFromBlueprint` creates a new
  connection with an empty one. The Workshop would relay refresh by the gadget's
  `listBindings()`. A gadget server passing its binding's session through to its UI is untested.
  A fork is of a kind of file, not of one file: the clients take a session and name no file. To
  use one for an item of a connection (a Doc in a folder), the Workshop must learn the item's
  kind, which `previewOf.id` hides on purpose: either a kind beside `id` and `title`, or the
  gatekeeper naming the type of session `openPreview()` returns, as `describe().tsType` does for
  a connection. Such a gadget is bound to the folder's connection, so it also calls
  `openPreview()` itself.
- **Change notification beyond the Workshop frame.** Either a live callback on the session (no
  precedent for a non-persistent callback; lost when the gatekeeper is evicted) or a hook through
  `bindHook()` (persistent stub, user approval, one logged read per delivery). Open: whether a
  content-free "something changed" signal counts as an observation.
- **Store `hasGadgetUi` on the connection record**, to drop the `describe()` call.
- **Type-checking preview clients** without a build, by JSDoc and `checkJs`. A build step is
  ruled out by forking (see the locked decisions).
- **A kit helper for `getPendingChanges()`.** Worth extracting over `SimulationView` once a
  second session follows the convention.
- **One read per refresh.** A preview that lists its scopes and then reads one logs two reads
  per refresh. A combined read would halve that and widen the session API.
- **Mobile.** Auto-open and the reopen button are desktop-only.
- **Google Docs:** comments and suggestions in the preview; bookmark links; text on both sides
  of a wrapped image; a paragraph's own tab stops; the width of more families only Google
  hands out (`FIXED_WIDTHS`) as documents that need them turn up.
- **Google Docs, found by review and left:**
  - *The drawing is stored inside the tab's snapshot*, which it grows by about two thirds
    (measured: 313 KB to 530 KB for an 83,000-character tab), and is built on every snapshot
    whether or not a preview is open. Storing each tab's drawing under its own key, read only by
    `readDrawing()` and `readImage()`, would keep the snapshot's size and its per-read cost.
  - *The drawing and the Markdown are two reads* matched by block kind, and the client keeps a
    drawing for as long as `savedMarkdown` is unchanged, so an edit to styles alone in Google
    Docs is not seen until the frame reloads. One revision stamp on both reads would settle both.
  - *Runs that are not text have no place in the Markdown.* A changed paragraph finds its images
    by counting `[Image]` placeholders, and its footnote marks, fields and chips fall back to
    text. The converter could record where it writes each.
  - *The column a block is drawn for is the first section's.* Unsized table columns and the side
    text wraps an image on use it; the paginator works each section's out properly.
  - *List spacing is collapsed on the server* from the saved neighbours, so an item beside one a
    pending change adds or removes keeps the spacing it had.
  - *An empty paragraph a change removes or adds is not marked*, so the "As saved" copy can be a
    blank line out.
