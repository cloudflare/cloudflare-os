# Plan: Gatekeeper preview UIs — a connection's content drawn beside the chat

This plan records the design agreed for gatekeeper preview UIs: a general way for any gatekeeper
to draw its resource beside the chat, with the changes still waiting marked on it. Nothing in the
kernel or the Workshop knows which vendor or what kind of resource is being drawn.

The framework is sections 1 to 4. The first preview built on it, of Google Docs, comes in a pull
request of its own and is described under
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
  `GatekeeperClient.connectToGadget()` returns, for a preview of one item too: the connection's
  code opens the item through that session (section 1a). The preview can therefore do only what
  a gadget bound to the resource
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
- `.agents/skills/write-gatekeeper/SKILL.md`: the conventions a gatekeeper author follows. The
  first preview adds "Revealing pending changes" to it.

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
take a `chatId` and do the same for any: the code is the gatekeeper's, and a connection's pending
actions are one queue that every chat's session reads. A caller is offered a preview first, by
`describe().hasGadgetUi` or by an action's `previewOf` (section 1a); calling `getUiBundle()` on a
gatekeeper with no UI fails, as does a preview with no `client.js` or with an import the rules
refuse.

`describe()` may reach the provider. The flag is not stored on the connection record. If cheap
lookup is needed, denormalize it at connection creation as `hasSlashCommands` is; existing
connections would then lack it until re-described.

### 1a. A preview of one item of a resource (workshop-shared + workshop-backend)

A connection to a folder reaches many files, and a log entry names only the connection. So an
action may name the item it changes, and the connection's code is sent to it by that name:

```ts
// gatekeeper.ts
type PreviewItem = { anchor: string; title: string; url?: string };

type ActionDescription = {
  /** The one item of the resource this action changes, when the gatekeeper can draw it by itself. */
  previewOf?: PreviewItem;
}
```

- `anchor` is the gatekeeper's own name for the item and opaque to the Workshop, which hands it
  back as the anchor the connection's code is sent to (below).
  It is not one of `ObservationDescription.subresources`: those are enforced and never shown,
  this is shown and enforces nothing. `title` and `url` are for the pane's heading and link, as
  `describe()`'s are for a whole resource.
- The kernel adds no storage and no code: an action's description is already stored whole and
  sent to clients whole. `gatekeeper-kit` carries the field from a
  definition's `describe()` to the queue.
- `getGadgetUi()` is not told the item: a connection has one set of files, which draws whichever
  item its host sends it to. What the item holds is read by that code through the session,
  where the gatekeeper checks access as for any read.
- Nor is it one of the action's `fields`, which are what an approver reads and which a gatekeeper
  words for a person. `previewOf` is read by the Workshop to decide what to draw, and has to mean
  the same thing in every action that touches the item.
- A preview is therefore offered in two ways, and the Workshop looks for both: `hasGadgetUi` on
  `describe()` offers one of the whole resource, and an action that names an item offers one of
  that item. A connection can do either, both or neither, and the second needs no `hasGadgetUi`.
- The Workshop names the item to the connection's code the way a host tells any gadget UI where
  its user was: `GadgetHost.onNavigate()`, with `anchor` as the anchor
  (`plans/focus-tracking.md`). The frame holds the connection's session, and its code gets from
  the name to what it draws by the session's own methods, as a gadget bound to the connection
  would. So nothing of a preview is in the kernel's types and the Workshop calls no method of a
  session, which is opaque to both. A gatekeeper that names items and registers no
  `onNavigate()` gets a pane that draws nothing, which a test of its preview catches.
- The frame of an item's preview therefore holds the connection's session, which reaches every
  item. The code in the frame is the gatekeeper's own, and what it reads is still authorized and
  recorded read by read.
- On actions only. A read that names an item would open a preview for everything an agent skims,
  and a preview's own reads are recorded against the connection, not a chat.
- Tested by the integration test under
  [Verification of the framework](#verification-of-the-framework): an action carries
  `previewOf` to a client.

### 2. The pending-changes read (each gatekeeper's session)

A convention, not a kernel type: the kernel never sees these values. Every session that reveals
its pending changes uses one shape.

```ts
getPendingChanges(scope): Promise<{
  changes: PendingChange[];
  /* and what else the session says of the scope */
}>

type PendingChange = {
  id: number; stale?: true; type: string;
  /* ...that method's arguments, where the gatekeeper keeps them */
}
```

- `scope` is what the session's content read is scoped by (a tab, a sheet, a slide), and is
  always named.
- The result may carry more beside `changes`, such as the ID the scope is listed under now.
  What the changes make of the scope is for the session's other reads to say.
- Changes are oldest first, the order they apply in. `type` is the session method that made the
  change. Where the gatekeeper keeps the call, that method's arguments follow it, without the
  scope; otherwise the change is listed by `type` alone.
- `id` is the number the gatekeeper passed to `submitAction()`. It is not the Workshop's action
  log id.
- `stale` marks a change the resource no longer fits. It is left out of the pending copy, cannot
  be applied, and stays listed until rejected.
- A change that has already reached the provider is not listed, even if the gatekeeper has not
  yet heard so: the saved copy already holds it.
- One authorized observation per call, reporting every real resource the answer's data came
  from. That can be more than the content read reports: a child a pending change removes is gone
  from a simulated listing, and still told of in the saved copy.
- Agent-facing docs call a change "pending" until the provider has saved it, and do not mention
  approvals.

### 3. A preview client (each gatekeeper)

Gadget-format client code the gatekeeper returns from `getGadgetUi()`, as source files. How it
draws its resource is the gatekeeper's business; what every preview keeps to is:

- It reads only through the session: once on load, and again on each `refresh` message from its
  parent. Each read is a logged observation, so it does not poll.
- It shows the resource with its pending changes, and what those changes did against the saved
  copy, from the session's reads: `getPendingChanges()` says which changes wait and which are
  stale, and what they did is for whatever other reads the session offers (for Google Docs,
  `readDrawing()` and `readPendingDrawing()`).
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
  a gadget's client is handed to it (for one item, with the anchor the frame is sent to),
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
  rewritten and the unused file does not arrive. In the same test an action that names an item
  reaches the client with its `previewOf` (`workshop-action-history.test.ts`). A read through `connectToGadget()` of what a
  "use" collaborator's account cannot read leaves them able to open their gadget on the same
  connection, where the same read through `openSession()` locks them out
  (`observer-tracking.test.ts`).
- Frontend: the pane in real Chromium against a fake session (the frame is opaque-origin, so the
  test asserts the session's call log), and unit tests for the auto-open and pending-preview
  rules. The pane's test runs the Google Docs preview's own files in the real frame against a
  fake session; no test runs the pane against a real gatekeeper.

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

On `GoogleDocSession`, implemented in `docs.ts`. Two are declared in `docs-types.d.ts`, which is
what every agent given a Doc is sent; the three that only render are declared apart, in
`docs-rendering-types.d.ts` (`GoogleDocRenderingReads`), and the session has them as it has the
others. Each
reads one tab and takes a required `tabId`: `getContent()` lets it be omitted for a one-tab
document only because callers older than tabs exist, and these reads are new.

```ts
// docs-types.d.ts
getPendingChanges(tabId: string): Promise<GoogleDocPendingChanges>;  // { tabId, changes }
getRenderingTypes(): Promise<string>;                    // the declarations of the three below

// docs-rendering-types.d.ts
readDrawing(tabId: string): Promise<GoogleDocDrawing>;   // the saved tab as Google Docs lays it out
readPendingDrawing(tabId: string): Promise<GoogleDocPendingDrawing>;  // what the changes make of it
readImage(imageId: string, tabId: string): Promise<GoogleDocImageBytes>;  // at most 10 MB
```

- `getPendingChanges()` follows section 2 as far as the gatekeeper keeps a call: `replaceText`
  (with `inTable` where the text replaced is in a table's cells) and `appendText` carry their
  Markdown, and a change to a table is listed by the method that made it alone. It carries no
  copy of the tab, saved or pending: what the changes make of the tab is
  `readPendingDrawing()`'s to say, and `getContent()` already reads with them applied. It is on
  the directly bound session only: the sessions a Doc opened through Drive is handed forward
  none of these reads, so such a Doc has no preview. Every edit to a tab still to be added is
  listed, and `listTabs()` marks each tab that has edits pending (`pending`).
- `readDrawing()` (`docs-drawing.ts`) is the saved tab resolved to what a renderer needs and no
  more: the page, its sections with their margins, columns and the headers and footers each
  names, every paragraph, table and list with its look in full (inheritance from the named style
  already applied), every image with its size, crop and, when it is positioned, its offsets and
  how text wraps it, and footnotes. Looks are held once and named by index. Each block of the
  body names its `range` in the saved tab, as document indexes, which is what the pending
  drawing's edits are told in. It says nothing about pending text.
- The drawing is a read of its own from Google (`GoogleDocsApi.getDrawnTab()`): `documents.get`
  under a field mask of everything Google Docs draws of a tab, which the copy the gatekeeper
  keeps of a Doc leaves out, since that copy holds what the Markdown rendering and the model of
  an edit read. Nothing of the answer is stored: the drawing is built from it and let go. It is
  asked once the copy is in hand and never beside the copy's own read, since Google answers each
  with the whole document. A field mask Google refuses is dropped and the read made again, as
  for the copy's.
- `readPendingDrawing()` is where the tab with its pending changes applied differs from the
  saved tab, found by comparing the two versions of the tab the copy holds, not their Markdown
  (`changedElements()` in `docs-changed-elements.ts`). The copy keeps a tab as runs of
  elements. A run both versions hold is passed by the name of its content with nothing decoded;
  the runs of a stretch that differs are decoded, both versions', and compared element by
  element without their indexes, along a longest common subsequence. Each difference is an
  edit: a range of the saved tab's indexes and the pending tab's top-level elements there, with
  an empty range where they are only added and no element where the range is only removed. A
  changed table comes whole. An element whose rendering alone moved, as an item of a list
  renumbered, is no edit, and a stale change is in neither version and so in none. Past a
  million comparisons in one stretch (`MOST_COMPARISONS`), what stands between the elements its
  two ends share is one edit.
- An edit's elements are drawn as blocks like the drawing's (`docPendingDrawing()`), with the
  looks the copy keeps of them as it states them and nothing guessed: of text its bold, italic,
  underline, strikethrough, size and color, and of a paragraph its alignment and two indents,
  with no named style laid under them and no default over them. Their looks are places in the
  pending drawing's own tables. The objects they name are the drawing's. Of the lists they name,
  the pending drawing defines those a pending change makes or changes (`changedLists()`), each
  level as far as the copy keeps it: its numbering, symbol and start. A footnote's mark is left
  empty, for the client to number, and of a table of contents and a section break only the
  place is told. It reads from Google nothing `getContent()` would not, so it is read at every
  refresh.
- `version` on both is Google's `revisionId` of the saved document each was read from. The
  edits are ranges of the saved body the copy holds, so they fit a drawing only of the same
  revision. A `readDrawing()` that finds Google at another revision than the copy's has the
  copy asked after (`DocSource.recheck()`), so that the next `readPendingDrawing()` names the
  revision drawn; a caller reads the pending drawing again where the two differ, and the
  drawing again where the edits have moved past it. Google names no revision for an account
  that can only view the document. A missing version is unknown, not a mismatch: the session
  asks nothing after on its account, and nothing then tells that a drawing has gone stale.
- A tab still to be added has no saved body. `readDrawing()` answers the drawing of a blank
  tab, with no `version`, no named style and without asking Google, and `readPendingDrawing()`
  one edit at 0, of all the tab holds. A Doc not created yet is drawn from the same blank tab
  (`blankDrawnTab()`), under the one revision the gatekeeper gives such a Doc.
- The three reads' types are apart, and `getRenderingTypes()` returns them:
  they would double the session's declarations, and an agent that only reads and edits a
  Doc never needs them. An agent editing a forked preview is told by `getRenderingTypes()`'s
  comment to fetch them first. A preview of Sheets or Slides keeps its reads that only render
  apart the same way. They are public all the same: a preview is shipped to be forked, so a
  fork draws from these reads and their shapes are kept as an API's are.
  `getRenderingTypes()` returns the same text for every document and reports no read.
- Neither drawing is stored or cached by the gatekeeper, so no version of the copy or of the
  Markdown rendering moves for them. All a session keeps of what it read is where Google serves
  each tab's images, as the last `readDrawing()` or `readImage()` of the tab that was
  authorized gave them, in memory: each address is a bearer of its image for minutes.
- `readImage()` reads one object the drawing names, at the address the session holds for it.
  With none held, or one that has lapsed (403 or 404), Google is asked again for the objects of
  the document's tabs and nothing else of it (`getDrawnTab()` with `objectsOnly`), and the
  tab's addresses are kept anew; any other failure to fetch an image is reported as it is. All
  that is asked of Google for an image is asked inside its authorized read. Every address asked
  is https on `google.com` or `googleusercontent.com`, or on a subdomain of either: the one
  Google names, and each one the read is sent on to, three at most. Each is checked before it
  is asked, so nothing is asked anywhere else. Those names take in more than Google's own
  servers (a Google Cloud customer's machine has a name under `googleusercontent.com`), so
  this trusts where Google sends the read of an image. The image must be a PNG, JPEG,
  GIF or WebP. Its bytes are streamed, read from Google as the frame reads them, and fail
  partway past 10 MB where Google did not state the size. (A stream from the backend session
  reaches the UI frame from capnweb 0.13.0.) Images in headers and footers, and positioned
  ones, are read the same way. `listImages()` and `getStyles()`, which earlier drafts had, are
  gone: the drawing names every object and holds every look.

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
    rest under the text. A font's own ascent and descent play no part. A line of mixed sizes
    takes the largest.
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

- `client.js`: reads the tab, composes what each view draws, and owns the views, the outline
  and the change navigator.
- `merge.js`: lays the pending drawing's edits over the drawing's blocks, as rows each view is
  drawn from. It touches nothing of the page.
- `draw.js`: one block (a paragraph, a table, a list item, an image) as DOM, and the stylesheet.
- `pages.js`: lays composed blocks out on sheets.

What any preview of this gatekeeper needs is a module of its own, `previews/shared/chrome.js`,
imported as `./ui/chrome.js`: the theme, the outline sheet and the dot it puts on what holds a
change, the change navigator, the part navigator, the stale banner, the loading, updating and error states, and the refresh handling. `getGadgetUi()`
returns the client's four files and the shared ones, which `previews/shared-files.ts` lists.
The gatekeeper's bundler imports only
`.txt` and `.svg` as text, so each file is imported through a `.txt` symlink beside it, and
`previews/docs/ui` links to `previews/shared` so the import resolves on disk too. The frame calls
`main(gadget)` on the client's default export. Importing `client.js`, `draw.js`, `merge.js` or
`pages.js` draws nothing: each exports its styles, and `main()` puts them and the page in the
frame. `chrome.js` puts its own stylesheet, the page's container, the outline and the bar in
the frame when it is imported.

It draws a tab on its own pages, in the document's fonts, colors, tables and images, marks
insertions and deletions, lists the tabs and the tab's headings in an outline, and steps through
the changes in the tab shown. A tab still to be added is marked in the outline, as is one with
changes waiting; the client knows the first by the provisional ID `addTab()` returns. It only
reads.

**Composing.** `merge()` walks the drawing's blocks and the pending drawing's edits together,
by document index. A block no edit's range holds is a row drawn exactly as saved. The saved
blocks in an edit's range are lined up with the edit's blocks in order. The blocks the two
share at each end, where each says exactly what the other does, pair first: being alike is
too little there, where it would pair two of several that are alike. Between those ends each
pending block pairs with the first saved block like it past the last one paired, so a block
that moved is one gone and one come. Blocks are alike when they are of one kind and, for paragraphs, when
they share at least half the words of the one that has fewer; two paragraphs with no words
pair. A saved block left unpaired is removed, a pending one added, and a pair is compared: a
paragraph word by word along a longest common subsequence, with a run that is no text (an
image, a break, a footnote, a chip) counted as a word, so a changed paragraph keeps its images
and page breaks where the pending paragraph has them. One of those that comes or goes is
marked as words are, and a break also where its page ends; where a view leaves it out, the
mark that stands for it names what it is ("a page break", "an image"). A pair in which
nothing differs is drawn as saved. Past a million comparisons (`MOST_COMPARISONS`), the
blocks of an edit between the ends the two share are all gone and come, and what two
paragraphs hold between the words their ends share is replaced whole.

**Looks.** A pending block states little of how it is set, and takes the rest from the saved
text it stands for or beside (`textLook()` and `paragraphLook()` at the head of `merge.js`,
the only readers of a pending look). A paragraph that replaces one of its own named style is
set as that one; any other as the last saved paragraph of its style before it, or as the
named style alone where there is none. A word both paragraphs hold keeps the saved look
unless the pending one states otherwise. A word a change writes takes its family, weight,
small capitals, baseline and highlight from the saved text before it in the paragraph, or at
the paragraph's start from the text after it, as Google Docs sets text typed there; what the
pending look states (bold, italic, underline, strikethrough, size, color) lies over what the
named style sets. This is the simulation: what is drawn "with changes" is laid out by the
same rules as what is saved, so text a change adds pushes the rest down the page and onto the
next.

**Tables.** A table an edit changes is one row of the tab, drawn as a table in every view.
Its rows are lined up as blocks are, by the words in them; its columns by their place where
both tables have as many, and otherwise by what their cells say down the rows both have. A
cell both have has its blocks lined up in turn, and is laid out as the pending table has it,
except in As saved, so cells a change merges are one cell, edited. A cell a merged cell reaches
is not drawn, though Google still lists it and it can still hold text; where the other table
shows that place (a split, or in As saved a merge), the cell is edited and the text is marked
as come or gone. A cell that comes or goes
with its row or column is tinted with all it holds, and an edited one has a bar at its edge.
A cell is edited, too, where only how it is set changes: its fill, its borders, its padding,
where its content sits, the least height of its row or whether the row repeats, and the width
of its column where none came or went. These are what the stored copy keeps of a table; As
saved draws them as saved. A fill of the page's color is none, since a pending cell names it
and a saved one does not.
Where every change is read in place the rows and columns that go stand among those that come,
in one table. Where a view leaves a row or a column out, a seam on the border where it stood
says what went or came. Tables are paired as other blocks are, and any table is like any other:
where one edit holds several tables with nothing unchanged between them, as when a table goes
and the one after it is edited, the first saved pairs with the first pending. What is drawn
then is a true account of the change and not the shortest: the table that goes is shown edited
into the one that stays, and that one as removed.

**Lists and footnotes.** A list the changes make or change is drawn with the levels the
pending drawing tells of it, each over the saved level where that is of its kind (numbered or
bulleted) and over the level Google Docs would make otherwise; as saved, each list is the
drawing's. Items are numbered as the view shows them: an item that goes, read beside what
takes its place, shows the number it would take there and takes none, so two that go together
show the same one. Footnotes are numbered among those drawn, so one a change adds counts. Only
the drawing holds a footnote's text, so the mark of one it does not hold is numbered and its
text drawn nowhere; none of the session's edits adds a footnote, so an edit's marks are saved
ones it kept.

**Links.** Where text leads is followed only from text Google Docs has saved and no change
touches. Every run of every edit is flagged as unsaved where the edits enter `merge()`; a word
an edited paragraph keeps is drawn from its saved run, and so is not. `draw.js` gives a link
an address to follow only for a run that is not unsaved, that no change adds or removes, and
that is in no block, cell or table a change adds or removes; the address of any other is held
and told in the link's title, and the text is no link. `client.js` opens a web address in a new
browser tab only from a link that is not held. A link to a tab or a heading of the document is
followed inside the preview, held or not.

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
  tinted. What is removed is not drawn, and leaves a mark that takes no room: a caret under
  the line for words, a wedge in the margin for whole blocks. A click on one opens Inline at
  that place.
- *Inline*: a redline on one endless sheet, removed text struck through beside what replaces
  it. It is not paged, because text that is both there and not has no true page.
- *As saved*: the tab as Google Docs has it now, paged, with what the changes remove tinted
  and the same marks where they add.

A document needs all three because a reader checking an edit wants to
see the words that went, and a reader checking layout must not have them take up room. The
tint of a change follows the lines of its text, not the paragraph's box, so it goes around a
wrapped image rather than across it.

**Stepping through pages.** A navigator at the foot of the frame, right, the twin of the change
navigator at its head: "Page", the page read of how many ("3 / 21"), and an arrow each way
(`stepper()` in `chrome.js` builds both, and `partNavigator()` there is this one).
It steps to the top of the next or the previous sheet,
counts steps made while one is still under way, dims the arrow there is nothing past, and names
the page read ("Page 3 of 21") to assistive technology. It is hidden where there is one sheet: a one-page tab, a
pageless document, and the Inline view. The Workshop's card for a change waiting lies across
the foot of a frame narrower than 900px, so there the navigator stands above it while any tab
has changes waiting.

**Reading and refreshing.** On opening the tab list is read first and then the chosen tab's
pending changes and pending drawing; on each refresh the three are asked for together. The
drawing is read once the pending
drawing is in, and kept for as long as the pending drawing names the `version` it has, since
Google is asked for the whole document for one; a drawing with no version is read again each
time. Where the two name different versions the pending drawing is asked for again, up to
three times, and the drawing again if the edits have moved to yet another. Still apart then,
with edits to set, the read fails, since they would be set over the wrong blocks: a tab
already drawn stays as it is, to be tried again.
`getPendingChanges()` is read only for whether changes wait and how many are stale. A refresh
that finds the drawing and the pending drawing as they were, as when a change is made to
another tab, leaves what is drawn alone. The client opens on the first tab with changes
waiting.

**Failing.** There is no second way to draw a tab. A tab that cannot be read on opening is an
error with a retry; one already drawn stays, with the failure said under it.

**Paper.** A sheet is the document's own color, white unless it says otherwise, in both themes:
a document's colors are chosen against its paper.

### Verification

- Docs actions suite (workerd): pending changes in order, each as the call that made it, one
  observation, stale changes, tab filtering and the mark on the tab list, the unknown-tab
  error, a tab still to be added, applied and rejected changes, and the lost-response case. The
  drawing: a read of its own under one observation, the unknown-tab error, the declarations
  `getRenderingTypes()` returns and that it reports no read, another version named and the copy
  asked after, no version where Google gives no revision, and a pending tab drawn blank with
  nothing asked of Google. The pending drawing: a replaced paragraph, a changed table whole,
  the lists changes make and not one they only add to, and a pending tab as one edit. Images:
  one read at the address the drawing's read gave, the tab's objects alone where none is held
  or the one held has lapsed, the refusals (a drawing, an unknown image, the size limit), and
  the document left alone when Google fails to serve an image whose address stands.
- What differs between two versions of a tab (`docs-changed-elements.test.ts`): one replaced
  paragraph with its run alone decoded, two edits far apart as two changes, text appended,
  added and removed, a table as the whole table, a list renumbered and not changed left out,
  the lists edits make, a tab with no saved version, and that the changes found make the saved
  tab the pending one. The store's reader (`docs-store.test.ts`): a run's content named and
  the run decoded at the place it is told, and list definitions read with no run read.
- The two drawings (`docs-drawing.test.ts`): the version and each body block's range, header
  and footer margins with and without `useCustomHeaderFooterMargins`, a header with a tethered
  image, the `unreturned` header and footer, and an image tethered nowhere; a pending
  paragraph with what it states of its look and nothing more, a changed table whole, a
  footnote's mark left out, the lists defined, and a table of contents and a section break by
  their place. The request (`native-api.test.ts`): the drawn tab's parts asked for whole
  however deep the tab is nested, and the read made again without a mask Google refuses.
- The client in a same-origin frame in real Chromium, where its drawing can be read, against a
  scripted session (`docsPreviewClient.browser.test.tsx`): the three views, sheets with their
  headers, footers and page numbers, saved and pending page breaks, images kept through an
  edit, the looks pending words and paragraphs take, changed tables in each view and merged
  cells, the text a split brings out from under a merged cell, marks on what is no text and
  on breaks, links held, seams, an edit with too many blocks to compare, lists and footnotes
  numbered as the changes leave them, a pending tab, the drawing
  kept until the edits name another version and the edits asked for again when they name
  another than the drawing's, and a tab that cannot be read again kept as drawn.
- Against Google Docs itself. A harness draws a captured drawing beside a screenshot of the
  same document in the editor at 100%, and the baselines of matching lines are compared. A
  brochure (first-page header and footer, positioned and wrapped images) is within 2px down
  its first page; class notes in Roboto Slab with inline images are exact on the second page
  and within 5px at the foot of the first, where each inline image sits about 1.7px lower in
  Google Docs than here, for a reason not found. A 21-page A4 design document paginates
  without overflow and was not compared line by line.
- Two documents that are mostly table, each one page in the editor and one here. A form
  brought in from Word (merged cells, shaded cells, no stated padding) has its table's columns
  on the editor's pixels and its text where the editor has it in every row that wraps as the
  editor's does. It is set in Cambria, which the browser stood another serif in for, so 34 of
  its 79 lines end at another word and the table is seven lines shorter; with a font as wide
  as Cambria in its place, every line between two rows was on the editor's pixel. A rubric
  made in Google Docs has its rows within a pixel: its table is centered in the editor and
  starts 2px further left here, and its first and last rows are a pixel taller here.
- Both comparisons were made of the client as it was before it merged by index range. What
  sets and pages a drawing (`draw.js`, `pages.js`) changed by a few lines since, among them
  that the client now numbers footnote marks; neither comparison was made again.
- Against the Docs API itself, on a scratch document: Google takes both field masks
  `getDrawnTab()` sends; its answer and the copy's own read, of one revision, name the same
  `revisionId` and the same indexes; `revisionId` moves on an edit to a look alone, which the
  copy's fields do not show; an image is read at the address the answer gives; and
  `docTabDrawing()` drew the answer. The answer was 1.89 times the size of the copy's read.
- Live on a local instance, before the client merged by index range: styles, tables, images,
  several tabs, a pending tab add, the outline, heading links, replacements, appends and a
  stale change; refresh on queue and discard; auto-open, dismissal and reopen. That run was
  not made again.
- Not verified: the client against a real session. The pane's test runs it in the real frame
  against a scripted session, which shows only the order of its reads, and its own tests run
  it in a same-origin frame against a scripted session, so nothing has yet run the session's
  two drawings and the client together. Nor a web link opened from the real frame, a Doc that
  has not been created yet, and an agent queuing edits from a chat. The client's cap on
  comparisons (`MOST_COMPARISONS`) has a test for an edit's blocks and none for a paragraph's
  words, and the session's has none; nor has the cut of an image
  past 10 MB whose size Google does not state. Not compared against Google Docs:
  tables that cross a page, columns, footnotes, even-page headers, landscape sections and
  right-to-left text.

### Watch-fors

- **Every image read is authorized.** The drawing tells of an image, not its bytes, so
  `readImage()` is authorized and logged as its own read: one log entry per image.
- **Three reads on each refresh, and more when the document was saved anew.** The tab list,
  the pending changes and the pending drawing are logged at every refresh. The drawing, for
  which Google is asked for the whole document, is read on opening, on a tab not yet drawn,
  when the pending drawing names another version, and at every refresh where it has none.
  Where the two name different versions the pending drawing is read up to three times more,
  and the drawing with it, so one refresh can log up to ten reads.
- **A drawing with no version is read at every refresh.** Google names no revision for an
  account that can only view the document, so nothing says its drawing still stands, and
  nothing says the edits are ranges of the blocks drawn.
- **The drawing's read is refused sooner than `getContent()`.** Google's answer is refused past
  10 MiB for either. For the one document measured, the drawing's answer was 1.89 times the
  copy's, so a document whose copy is well under the limit can have no preview; how much
  sooner depends on what its styles, headers and objects hold. A read made again without a
  mask Google refused is larger still. The client shows the failure.
- **A tab still to be added, and a Doc not created yet, are set in styles the client carries.**
  Google gives a new tab its own named styles. The copy's blank tab holds only what the copy
  keeps of them, which would set every style as plain text, so the drawing of a blank tab
  leaves them out and names no style, and the client sets it by its own table of Google Docs'
  defaults (`PLAIN` in `merge.js`). They are constants: nothing reads them from Google, and a
  tab Google styles otherwise is drawn differently once it is added. Both are drawn on a
  Letter page with 72pt margins, whatever page the document's other tabs are set on.
- **The client tells a tab still to be added by the form of its ID.** It marks one "new" where
  the ID starts `pending-tab-`, which is how `addTab()` makes a provisional ID
  (`PROVISIONAL_TAB_PREFIX`) and which no declaration states, though a fork reads the same
  types. `GoogleDocTab.pending` cannot stand in: it marks any tab with edits pending, and is
  not set for a tab added and not yet edited.
- **A change is not traced to the action that made it.** An edit is where the tab differs once
  every pending change is applied, so two actions that touch one paragraph are one edit, and
  neither drawing names an action. Recording each replayed step's versions (an observer in
  `replayDoc`) would let the pending drawing say which action each edit is of.
- **Pairing is by words.** A paragraph rewritten past half its words is one removed and one
  added, not one edited, and a block that moves is removed where it was and added where it is.
  Rows of a table pair the same way, so a row rewritten whole reads as a row gone and a row
  come.
- **What a pending block does not state is borrowed.** The copy keeps no font, small capitals,
  baseline, highlight, spacing or border of text and paragraphs, so pending ones are set as the
  saved ones beside them: a guess wherever Google Docs would set them otherwise.
- **A column Google sizes evenly has no width in the drawing.** Only a column of fixed width
  states one; the client shares what the fixed ones leave among the rest.
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
- **Large documents.** The client reads and pages the whole tab's drawing. The session decodes
  only the runs its edits differ in, and the client compares only the blocks in an edit's
  range, but nothing caps a tab's size or draws only the pages around each edit.
  An edit the session made whole past `MOST_COMPARISONS` is lined up in the frame under a cap
  of the same size: past it, the blocks or table rows between the ends the two share are
  drawn as all removed and all added.
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
- **Cambria and Calibri** are in no browser without Office, so a document brought in from
  Word wraps as whatever serif or sans the browser has.
- **Text wraps an image on one side.** Google Docs runs text down both sides of an image set in
  the middle of a column; here it keeps to the wider side.
- **Tab stops** are drawn at the default spacing, not at the stops a paragraph sets.
- **The Doc store's derived code moved (`DOC_DERIVED`).** A reader of its runs now names each
  run's content and decodes it, and reads list definitions, so each document folds its pending
  edits once more from its stored copy after the deploy, and fetches nothing. No version of
  the copy's format or of the Markdown rendering moved.

## Pull requests

1. **The framework's kernel half.** `Let a gatekeeper supply code that draws its resource`:
   `hasGadgetUi`, `getGadgetUi()`, the gadget view calls on `GatekeeperClient`, and the integration tests. This plan
   rides with it. `Let an action name the item it changes`: `ActionDescription.previewOf`,
   which `gatekeeper-kit` carries to the queue. `Say how a drawn connection's reads and an
   action's item are treated`: `docs/observers.md` and `docs/admin-access.md`.
2. **The Workshop pane and the first preview, stacked on the first.** Google Docs' reader of a
   Doc's stored runs that names a run's content and decodes one run, the plan's Google Docs
   section, the session reads, the client, and the pane with auto-open, one commit each.

## Punted / future work

- **More previews.** Sheets and Slides are wanted next and not designed. Each brings its own
  session reads and client; neither should need a kernel or Workshop change. If one does, the
  framework is wrong, not the preview.
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
- **Change notification beyond the Workshop frame.** Either a live callback on the session (no
  precedent for a non-persistent callback; lost when the gatekeeper is evicted) or a hook through
  `bindHook()` (persistent stub, user approval, one logged read per delivery). Open: whether a
  content-free "something changed" signal counts as an observation.
- **Store `hasGadgetUi` on the connection record**, to drop the `describe()` call.
- **Type-checking preview clients** without a build, by JSDoc and `checkJs`. A build step is
  ruled out by forking (see the locked decisions).
- **A kit helper for `getPendingChanges()`.** Worth extracting over `SimulationView` once a
  second session follows the convention.
- **Fewer reads per refresh.** The Google Docs preview logs three reads at every refresh (the
  tab list, the tab's pending changes and its pending drawing), and four on opening with the
  drawing, besides one per image. A combined read would cut that and widen the session API.
- **Mobile.** Auto-open and the reopen button are desktop-only.
- **Google Docs:** comments and suggestions in the preview; bookmark links; text on both sides
  of a wrapped image; a paragraph's own tab stops; the width of more families only Google
  hands out (`FIXED_WIDTHS`) as documents that need them turn up.
- **Google Docs, found by review and left:**
  - *The column a block is drawn for is the first section's.* Unsized table columns and the side
    text wraps an image on use it; the paginator works each section's out properly.
  - *List spacing is collapsed on the server* from the saved neighbours, so an item beside one a
    pending change adds or removes keeps the spacing it had.
