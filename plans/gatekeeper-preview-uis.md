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
  (`plans/focus-tracking.md`, and "Where the reader is" below). The frame holds the connection's
  session, and its code gets from the name to what it draws by the session's own methods, as a
  gadget bound to the connection would: the Drive entry walks `openFolder()` to
  `openGoogleDoc()` or its siblings. So nothing of a preview is in the kernel's types and the
  Workshop calls no method of a session, which is opaque to both: the one convention is that the
  anchor of a spot in an item starts with the item's `anchor` (in the write-gatekeeper skill). A
  gatekeeper that names items and registers no `onNavigate()` gets a pane that draws nothing,
  which a test of its preview catches.
- The frame of an item's preview therefore holds the connection's session, which reaches every
  item. A session has no method that is for its preview alone. The code in the frame is the
  gatekeeper's own, and what it reads is still authorized and recorded read by read.
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
  a gadget's client is handed to it, and the focus that sends the frame to an item or to the spot
  it was left at,
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
- `usePreviewFocus`: the spot each preview's frame last reported, kept for a stay in a workspace
  ("Where the reader is" below).
- `usePendingConnectionPreviews`: the connections that offer a preview and have changes waiting.
  The editor shows a button in the top bar for each one whose preview is not showing.
- `connectionPreview.ts`: `previewOffers()` asks `describe()` once per connection for a stay in a
  workspace, across reconnections, and asks again a connection that could not be asked. The
  pane's icon is the one the vendor gives the connection's type of resource
  (`SupportedResource.icon`, found through `getCreationSpec()`), so a gatekeeper says nothing
  more for it.
- The pane takes the Activity pane's place in `GadgetEditor` and shares its open and close
  handling. The top bar's Activity button switches back.

### 5. Where the reader is (each preview, and the Workshop pane)

A gadget's UI tells its host where its user is and is sent back there (`GadgetHost.reportFocus()`
and `onNavigate()`, `plans/focus-tracking.md`). A preview runs in the same frame and is handed the
same `host`, so it does the same, and the pane keeps what it says:

- **A preview reports the reader's spot** as `{ anchor, label }`, each time it moves: the anchor
  is the preview's own and stable (an ID, not a title or a number that a change moves), the label
  is what a person would call the place. Text the reader has selected is the spot's `context`,
  which is what tells the agent what "this" is. Where there is only one place to be (a
  spreadsheet of one sheet) the place has no label, and is reported only with text selected, as
  "Selected text". Text selected with nothing picked is told with the slide it is on, or the
  heading it is under, which need not be where the view is. `reportSpot()` in
  `previews/shared/chrome.js` reads the selection for every preview, tells the host only of
  what has changed, and keeps both within the host's limits.
- **A preview registers `onNavigate()` before its first read**, and makes that read only if the
  host sends it nowhere: a preview sent to a spot opens on it, with one read instead of two. It
  answers false for a spot that is gone, having left the reader where they are, or opened where
  it would have. An anchor may come from any client, so it only chooses what to show among what
  the session reads.
- **The spots**: Google Docs, the tab and the heading the view has passed, as `?tab=<id>` and
  `?tab=<id>#heading=<id>`, the form the document's own links have; Google Sheets, the sheet's
  ID; Google Slides, the slide's ID. A Doc's heading is named by the drawing's `headingId` and
  found again by it after each read, so the spot holds through a refresh and a change that moves
  the heading.
- **A spot says only what Google has saved**, since a host shows the label and may tell an agent
  of it, and what a pending change writes is the agent's and not yet approved. A Doc's heading
  goes by its saved words and a sheet by its saved title, whatever a change makes of them. What
  only a change makes (a tab, a heading, a sheet or a slide still to be added) is no spot: under
  an added heading the last saved one passed is told, and on an added tab, sheet or slide
  nothing is, as where there is one place to be. A slide's label is its number as the preview
  lists the deck, changes applied, which is no text of anyone's.
- **What the reader picks is a finer spot**, wherever the agent can name it: a click on a slide's
  element gives `<slide>#<element>`, and the cell picked in a sheet `<sheet>!<A1>`, each with what
  is in it as the spot's `context`. An element a pending change deletes is still Google's to ask
  about, and its label ends ", being deleted". A press dragged across cells, which rings the range
  as it grows, or a click with Shift held, which grows it from the cell first clicked, picks the
  range between them, `<sheet>!<A1>:<B2>`, whose `context` is its cells as lines of tab-separated
  text, each of its rows and columns, the empty ones too, when all of them are drawn. Where one is
  hidden or lies outside the window drawn it is nothing: the agent reads the range by its name, not
  the part of it that happened to be drawn. A cell of a document's table is named as the session's
  table methods name one, after the heading it is under or, under none, the tab:
  `table=<n>&row=<r>&column=<c>`, each counted from 0 and the table among the tab's as the pending
  changes leave them, which is how `getContent()` shows them. Its label counts from 1, as a person
  does ("Table 2 › row 1, column 3"), and the session's type docs say which is which. These are
  places, not IDs, since nothing else names a cell: a change before one moves it, for the agent as
  for the preview.
- **A cell is named only where its place is certain.** The three numbers are read off the table as
  it is drawn, so they are the session's exactly where the drawing is the session's table: any cell
  in "With changes", which draws each table as the pending changes leave it, and in "As saved" and
  "Inline" a cell of a table no pending change touches. A table a change touches is drawn in those
  two copies with rows and columns the session's table does not have, or without ones it has, and
  the preview does not guess which of its cells is which: a cell of it is told by its heading and
  its text, under the label "Cell of a table being changed" ("Cell being deleted" where it goes),
  and another copy of the tab lets it go. How the merge pairs a saved table with a pending one is
  therefore not something the agent's cell depends on. No table is numbered while the drawing and
  the pending edits are of the document as saved at different times, which is when the copy
  the agent reads may count its tables from other blocks than the ones drawn.
- **A pick lasts as long as the reading it was made on.** To find a thing told by its place again
  in a document that has changed is to guess, and a wrong guess moves the pick to another thing
  without a word. So none is made: each new drawing picks again what was picked by its identity
  alone, never by what it says, and a refresh that reads the file or its pending changes as
  anything else lets it go and tells the host so. What is ringed is always what was last told. A
  slide's element has an ID, and is kept while an element of that ID is drawn on its slide. A
  document names no paragraph, and a cell of its table is a place, so what they have is the merge
  they are drawn from: its row, which of the elements that row is drawn as (a table of contents is
  one row, drawn as a paragraph for each entry), and a cell's row and column in its table. That
  holds through another copy of the tab, a font that arrives and pages set again, and takes in
  every piece of the thing: a paragraph or a cell its pages cut in two is ringed on both and told
  as one text, and a cell of a row its table repeats on each page is ringed on each and says its
  words once. A copy that does not draw the thing (a paragraph a change adds, in "As saved") lets
  it go, as does another copy of a row a change touches that is drawn as a table or as several
  paragraphs, whose cells and entries there may be others. A refresh that finds the saving and
  the edits as they were, as when a change is queued on another tab, draws nothing anew; any other
  is another merge. Google names no saving to an account that may not edit, whose drawing is
  compared whole instead. A paragraph is told by the heading it is under and by its text, which is
  what an edit matches on. A sheet's cells have names, which are of the same cells only on the
  sheet as it was read: a refresh that finds its rows, its columns and its pending changes as many
  and as they were keeps them, as when a change is queued on another sheet, and any other lets
  them go. They are told with no context where what they hold cannot be read, a line of them being
  hidden or outside the window, and while only the window moves they keep what was last drawn of
  them, so that scrolling away and back asks nothing anew. A refresh tells them as it draws them,
  and so by name alone while they are outside its window. A chip of an older message goes to the
  cell its anchor names, told as it reads now: that is what an anchor means, and is no pick found
  again. `picking()` in `chrome.js` marks the pick for Docs and Slides, which is framed with a
  dashed line in the shape of a change's ring, drawn over it so that it keeps its own look, and
  lets it go once its reader scrolls it from in view to out of view, so that a preview is not sent
  back to a place its reader left; a scroll the preview makes (to a new change, to a spot it is
  sent to, to where the reading was once a refresh is laid out) is not its reader's and lets
  nothing go, nor does their own while the pick is out of view already. Sheets had
  its cell already, ringed as Google Sheets rings one. In Slides the frame is one of the slide's
  marks, placed as a change's ring is, round what the element draws rather than its box, which text
  spills out of and a turn moves. What a slide takes from its layout or its master is not the
  slide's to edit and is not picked, and nothing is picked on a tab, a sheet or a slide that only a
  pending change adds: the agent has no such place to act on until it is approved.
- **What a pending change wrote is told as such.** The agent is told what the reader saw, and a
  preview shows text that is not approved yet, so `reportSpot()` starts the `context` with the
  line `(shown with changes not yet approved)` wherever the pick, or the text selected, takes in
  something a pending change wrote. Each preview names what it draws of one: the text a change
  writes and the blocks and cells it adds in a document, where a paragraph or a cell it edits is
  also told so in the copies that show it edited, though the edit only took words away; the
  values a change enters in a sheet; the elements a change adds or alters on a slide, a slide it
  adds, and the words it adds to the notes. A pick and a selection are held to the one definition
  (`takesIn()`). What a change removes is still in the file, and is told plainly; in "Inline",
  where a paragraph shows the words that go beside the words that come, neither a pick nor a
  selection takes the ones that go, so the two are never run together. Text selected counts only
  where all of it is in the document as drawn: a Doc's sheets, a sheet's grid, a slide's stage
  and its notes. What a preview writes around that (a slide's title, an outline, the bar with a
  cell's value) shows what the changes make of it with no mark on it, so text selected there is
  none to tell. Text selected inside a pick is told as not yet approved wherever the pick is, and
  text selected anywhere else by what it takes in itself. A selection that ends at the very start
  of what follows the document, as a triple click leaves one, is in the document still.
  The label of such a pick says what it is ("Pending change", "Shape") in place of its words,
  and the chip shows the context as it is sent, first line included. Nothing of a spot is an
  address or is followed: the anchor is made of IDs the session listed and of numbers, the label
  and the context are text, with the characters that turn text about or are not seen left out,
  and each is cut to the host's limit, which the host and the kernel check again.
- **An item's spot starts with the item**: `<previewOf.anchor> <spot>`. The Drive entry is sent the
  file's name, opens it, and starts the file's preview with a host of its own making, which puts
  the name before each spot that preview reports and takes it off each it is sent to. It labels
  each spot by the file's name first (`getEntry()`, asked with the open, so one more logged read
  for each file opened), since the agent is told only the connection's title. The three
  previews do not know whether a connection or the Drive entry started them. A frame draws one
  file: sent to another it answers false, and the Workshop gives each file a frame of its own.
- **The Workshop keeps each preview's last anchor** (`usePreviewFocus`), by connection and item,
  for a stay in a workspace, and `GadgetUI` sends a frame to it as the frame registers. So a
  preview closed and opened again, or left for another and returned to, opens where it was left.
  The preview of an item that has reported nothing is sent to the item.
- **The agent is told.** A connection with a UI stands where a gadget would, so a message's
  focus (`ChatMessageOptions.focus`) may name one: the kernel checks and stamps it as a gadget's,
  titled by the connection's resource, and the agent reads the same `<user-focus>` block, whose
  `gadget` is its binding to the connection. The kernel does not record which connections have a
  UI, so it takes a focus on any; a focus grants nothing. Each session's type docs say what its
  anchors are made of, so the agent can read one, and that it acts on the anchor alone: a label
  is for the reader and gives a tab, a worksheet or a heading by its saved title, while a range
  names its worksheet by the title the pending changes leave it, which the agent finds by the
  anchor's ID (`getSpreadsheet()`). A Doc's heading is the exception: `getContent()` marks no
  heading with its ID, so the agent finds it by the label's title, and goes by the body or asks
  where a pending edit has rewritten it or several share it.
- **The pane offers its preview as a gadget is offered**: a second `usePaneFocus`, whose gadget
  is the preview's connection, gives the composer's chip and keeps the label and context the
  frame reports. The connection is the focus, not the item: the item is in the anchor. A
  preview's reader picks things at a spot, so its pane (`picks`) takes a report with another
  context under the same anchor as a new offer, which brings back a chip turned down; a pick let
  go does not, nor does a gadget's context, which can change by itself.
- **A sent message's chip opens its preview** at the spot (`previewAt()`): the one with changes
  waiting or already open if there is one, and otherwise as the connection offers. A connection
  with a preview of its own is drawn whole; one with none draws its items, and the item is the
  anchor up to its first space. Such an item is drawn under the connection's title and with no
  link out, since the message kept neither of the item's own. A preview whose last report was
  that spot is sent nowhere: its frame would report nothing new, and the composer would lose
  the spot. So a chip for cells still picked does not scroll back to them.

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
what every agent given a Doc is sent; those that only render are declared apart, in
`docs-rendering-types.d.ts` (`GoogleDocRenderingReads`), and the session has them as it has the
others. Each but `readFont()`
reads one tab and takes a required `tabId`: `getContent()` lets it be omitted for a one-tab
document only because callers older than tabs exist, and these reads are new.

```ts
// docs-types.d.ts
getPendingChanges(tabId: string): Promise<GoogleDocPendingChanges>;  // { tabId, changes }
getRenderingTypes(): Promise<string>;                    // the declarations of those below

// docs-rendering-types.d.ts
readDrawing(tabId: string): Promise<GoogleDocDrawing>;   // the saved tab as Google Docs lays it out
readPendingDrawing(tabId: string): Promise<GoogleDocPendingDrawing>;  // what the changes make of it
readImage(imageId: string, tabId: string): Promise<GoogleDocImageBytes>;  // at most 10 MB
readFont(family: string, weight: number, italic: boolean): Promise<ReadableStream<Uint8Array>>;  // a family the drawing named
```

- `getPendingChanges()` follows section 2 as far as the gatekeeper keeps a call: `replaceText`
  (with `inTable` where the text replaced is in a table's cells) and `appendText` carry their
  Markdown, and a change to a table is listed by the method that made it alone. It carries no
  copy of the tab, saved or pending: what the changes make of the tab is
  `readPendingDrawing()`'s to say, and `getContent()` already reads with them applied. It is on
  the sessions that edit: the Doc's own, and the one a read and write Drive binding opens (see
  the Drive section). Every edit to a tab still to be added is listed, and `listTabs()` marks
  each tab that has edits pending (`pending`).
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
- The rendering reads' types are apart, and `getRenderingTypes()` returns them:
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
- Fonts come through the session as they do for Sheets and Slides: `readFont()` reads a family
  the drawing of a tab already read names, and no other, from Google Fonts. A family Google
  Fonts does not serve is drawn in the browser's nearest. The session keeps the families its
  drawings named, in memory, as it keeps the image addresses.

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

Slides has two of these; a document needs the third because a reader checking an edit wants to
see the words that went, and a reader checking layout must not have them take up room. The
tint of a change follows the lines of its text, not the paragraph's box, so it goes around a
wrapped image rather than across it.

**Stepping through pages.** A navigator at the foot of the frame, right, the twin of the change
navigator at its head: "Page", the page read of how many ("3 / 21"), and an arrow each way
(`stepper()` in `chrome.js` builds both, and `partNavigator()` there is this one, which Slides
shares).
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
waiting. Once a tab is drawn its fonts are read (`readFont()`), and it is set again in each
that arrives; bold and italic faces are read beyond the saved looks' only where a pending
change writes them.

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
- **The Doc store's derived code moved (`DOC_DERIVED`).** A reader of its runs now names each
  run's content and decodes it, and reads list definitions, so each document folds its pending
  edits once more from its stored copy after the deploy, and fetches nothing. No version of
  the copy's format or of the Markdown rendering moved.

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
- **Named, and drawn as far as the API tells:** `readDrawing()` says where a filter is set, which
  cells hold a checkbox, a dropdown or a note, how a cell's text is formatted in parts, and each
  chart's title, place and size. A chart is a titled box where it stands: the API gives its
  specification and no picture.
- **Not in the first version, wanted later:** a chart's picture, images, a dropdown's choices, a
  note's text, banding and table styles. Each is left a placeholder where it has a place on the
  grid, so adding one later is a new read and a new drawing, not a redesign. To check before
  promising any: images placed over the grid may not come from the API at all.

Session reads, on `GoogleSpreadsheetSession`:

```ts
getPendingChanges(sheet: string): Promise<SpreadsheetPendingChanges>;  // { changes, areas, sheets }
// One window of one sheet.
readDrawing(range: string, unfrozen?: ("rows" | "columns")[]): Promise<SpreadsheetDrawing>;
readFont(family: string, weight: number, italic: boolean): Promise<ReadableStream<Uint8Array>>;
```

- A sheet is too large to return whole, so `getPendingChanges()` returns, beside `changes`, the
  areas the changes touch and the sheet list as saved and as it will be; the cells come from
  `readDrawing()`. This is the convention of section 2 with the two copies read by window.
- `readDrawing()` returns a window's cells as they will be, each with its saved value when a
  change touches it, plus the sizes, merges, frozen and hidden lines the window needs. A sheet's
  frozen rows and columns come with every window and count toward its cells, but those of an
  axis the caller names in `unfrozen`: a caller that does not keep them in view draws them as
  lines that scroll, and reads them as it reads the rest. The caller decides, so the session
  and it cannot differ about which lines a drawing holds. A merge that starts
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
- A merge, an unmerge, a resize of rows, one of columns and a freeze are each an area with an
  `op` of its own. A merge's and an unmerge's are their cells. A resize's are its rows or columns,
  with the `size` it gives them. A freeze's are the leading rows, and the leading columns, that
  the pending changes bring into those kept in view or let go of, as the pending sheet numbers
  them, with how many would be kept in view without the freezes (`before`) and how many are
  (`after`, where the freeze line stands). `before` is never every line the sheet has, and a
  sheet a pending change copies counts it from the lines it was copied with, whatever was frozen
  on its original by then. Each is one stretch, since the lines kept in view lead the sheet, and
  it is on the last change that changed how many are kept in view: an earlier one has no area,
  and neither has a change that leaves nothing to see. The bound on `before` can leave a freeze
  none: with 3 of 5 rows saved frozen, a freeze of 2 and then a delete of rows 4 and 5 make
  `before` 2, which is `after`.
- The drawing has the sizes, merges and frozen lines the pending changes leave. The merges of a
  sheet a pending change adds or copies, or whose merges one consults, are the replay's; any
  other sheet's are those the drawing's own read finds among its cells.
- A drawing is read by grid range with `spreadsheets:getByDataFilter`, which Google refuses a
  grant that may only read (403, whatever reason it gives). It is then read by A1 range with
  `spreadsheets.get`, each sheet named by the title Google holds, in as many requests as keep
  each URL within 15,000 characters, since Google refuses one of some 16,500. Their answers are
  put together, and where a range is not answered by the sheet it was asked of, as when a sheet
  was renamed meanwhile, the read fails saying the spreadsheet changed. The theme alone is always
  read with `spreadsheets.get`.
- A read that fails once a sheet is drawn leaves the drawing in place and offers to try again.
  A window Google or the session finds too large is asked for again with half the room, and
  half again while that asks for the same window, down to some 300 cells. The room stays that
  small for the windows after it, each refusal being a fetch of Google; a view scrolled past
  what is drawn is asked for with twice the room, so a sheet heavy in one place is read in
  full windows again a few views on, and one heavy throughout costs a refused read at each.
  A window refused is not asked of Google again until the sheet is read anew, or its reader
  asks to try again.
- **Limits:** 10,000 cells drawn at once (what one format read may fetch). A sheet of up to 200
  rows by 26 columns is drawn whole from A1; a larger one opens on the areas its changes touch,
  with a few rows and columns around each, and reads further windows as the person scrolls.
- **Frozen lines the client lets scroll.** It keeps a sheet's frozen rows, and its frozen
  columns, in view only while they take no more than half of what the frame shows past the
  headers, and while a drawing that holds them has room for 100 rows and 26 columns more (the
  more numerous go first where it has not; fewer more in a window made smaller, and no more
  than the sheet has). Their size counts only once a drawing has read it: lines taken for
  wider than they are would be let go of for nothing. Otherwise it says so over the sheet,
  draws them as lines that scroll and reads its windows without them, so a change anywhere in
  the sheet is drawn. The half is a choice, not Google Sheets' rule, which was not looked up:
  frozen lines that fill a narrow pane would leave nothing of the sheet to scroll.
- **The window read.** The view is what scrolls past the frozen lines kept in view, as far as
  the last line that shows: lines read to be hidden after it are not in view, even where the
  sheet ends. A window is the view and lines around it, up to three times its columns and five
  times its rows, the columns first; the frozen lines the session draws before it count among
  its cells. Where no drawing holds the view, as where a filter hides more rows than one holds,
  the window is the view's lines the shorter way and all there is room for the longer way,
  from where the view starts. Where nothing shows after the view, at the sheet's end, it is
  read back from where the view ends instead: there the view grows backwards.
- **Reading on.** A view grows as the lines read of it turn out hidden, or smaller than the
  usual size they were taken for. It is read again with all the room the way it was left
  short, until a read would bring nothing new, and at most four times on end until the person
  moves the view: by scrolling, also while a window is being read, by resizing it, or by
  opening the outline beside it. What is in view stays where it is as a window arrives, and is
  scrolled back there only where the lines before it changed size, so a smooth step of the
  navigator is not stopped by a window read on its way. A step to a change past what is drawn
  is made at once, and again once the window there is drawn and its lines have their sizes,
  unless the view was moved meanwhile, by scrolling or by a resize. A change that runs the
  sheet's whole length one way (columns inserted, rows resized, a freeze) is stepped to the other
  way only: the place its reader is at along it is as much of it as any.
- **Accepted limit: a view left blank.** A run of hidden lines longer than those reads hold
  leaves the view blank until the person scrolls, in the middle of a sheet and at its end
  alike: some 4,000 rows where 8 columns are in view, and under 2,000 where 20 are. A view of more
  lines than one read holds, as of very small rows in a wide pane, is drawn as far as a read
  goes. Either says "Not read this far yet. Scroll to read on." over the sheet.
- The sizes of the lines, the view, the window and what is read next are
  `previews/sheets/window.js`, which touches no page: the client reads, draws and scrolls as
  it says. Its test holds the windows to what the session draws, over many sheets and views,
  and runs the rules as the client does, over a page it makes up, as lines turn out other
  sizes, the reader scrolls between and during reads, and reads are refused.

### Google Slides

Slides are drawn from the presentation's own model, not from Google's thumbnails: a thumbnail
shows only what is saved, and a pending change has to be drawn.

- **Outlines the model lacks come from Google's PowerPoint export.** The Slides API gives a
  freeform shape no outline and a preset shape none of its dragged handles (how far a corner is
  rounded, where an arc ends). The export has both. The gatekeeper starts fetching it through the
  Drive API inside the read of the slides, at most once a minute and only for a presentation that
  has such a shape, and that read waits five seconds for it. A slower fetch finishes after the
  read, whatever became of the read, and what it finds is kept for the next, as the masters and
  layouts a read fetched are: nothing kept is returned but inside a later read, authorized as
  any is. The gatekeeper keeps the outlines and not the file, and matches its shapes to the
  model's by
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
getPendingChanges(): Promise<PresentationPendingChanges>;        // { changes, savedPresentation, presentation }
readSlideDrawings(slideIds: string[]): Promise<SlideDrawings>;   // { slides, shared }: resolved, pending and saved
readPicture(pictureId: string, slideId: string): Promise<SlidePictureBytes>;
listFonts(): Promise<SlideFont[]>;                               // the families and weights the deck uses
readFont(family: string, weight: number, italic: boolean): Promise<ReadableStream<Uint8Array>>;
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
- Checked once against Google, on a scratch spreadsheet and deck: a token that may only read is
  refused the read by grid range (403) and answered the one by A1 range with the same bytes, for
  one window, frozen lines beside a window, titles that need quoting, a window past the cells
  used and the theme alone; Google leaves out a zero `startRow` or `startColumn`, trailing empty
  rows and cells and an empty range's `rowData`, and tells of merges, conditional rules and
  banding only where they meet the ranges asked; frozen lines follow inserts and deletes as the
  plan moves them; every Slides field mask is accepted, and `drive.file` gets the export.
- Not reproduced: an account with every scope that may only view the file. Whether Google
  refuses it the read by grid range with the same 403 is unknown.
- A wrapped row's height is the gatekeeper's own estimate: Google reported 21 for a row of 115
  wrapped characters that the drawing made 181 tall, and neither was compared with what Google
  Sheets shows.

## Files reached through Google Drive

A Drive connection (a whole Drive, a folder or one file) edits Docs, Sheets and presentations
through the same sessions as their own connections, so their previews draw them unchanged. What
differs is which file, which section 1a answers:

- **Each edit names its file.** `previewOf` is `{ anchor, title, url }`, set where the edit's card
  gets its "File" fields. `anchor` is the file's kind, the folders between the connected one and the
  file, and the file: `docs:<folder>/<folder>/<file>`. A folder session opens only its direct
  children, so the way in is part of the name; nothing but the gatekeeper reads it.
- **`getGadgetUi()`** is asked before any file is named, so it returns the previews of all three
  kinds, from one list the gatekeepers share (`previews/files.ts`), each client under its kind's
  name beside an entry (`previews/drive/client.js`). UI code cannot `import()`, so the entry
  imports all three, opens the file its host sends it to, and starts the one of the kind the
  file's name begins with. A preview therefore builds nothing
  into the frame until its `main()` is called. It asks Google nothing. A Drive connection reports
  no `hasGadgetUi`: it has no preview of itself.
- **The entry opens the file as a gadget would**: `openFolder()` for each folder its name
  gives, then `openGoogleDoc()` or its siblings, each call made on the promise of the one before,
  so the file's place in the binding's scope is proven as it is for an agent. The name it is
  sent may come from any client: one that is not a file of the connection is refused by those
  methods. The name's form is therefore read in two places, `drivePreviewId()` that writes it
  and the entry.
- **The Workshop** tells previews apart by connection and item. It asks for the connection's
  code, hands the frame the connection's session, and sends the frame to the item (section 5).
  The card and
  the refresh take only actions that name the same item, which matches Drive ordering approvals
  by file. An item's preview opens when a change to it is queued, never on a read: a preview's
  reads are recorded against the connection, and an agent skims many files.
- **The Doc a Drive binding opens** forwards its preview's reads on its edit session, each the
  bound session's own, authorized and observed as there: `getPendingChanges()`, `readDrawing()`,
  `readPendingDrawing()`, `readImage()`, `readFont()`, and `getRenderingTypes()` for their types.
  A drawing read from a newer revision than the binding's reads share has the next read fetch
  the document, where a bound Doc's copy is asked after. An edit there that can no longer be
  applied is failed in the binding's journal, which would drop it from the list: its number is
  noted for the file (`driveDocs:stale:<id>`), so it stays listed as stale until it is rejected,
  as on the Doc's own connection.
- **A file moved inside a folder binding is two items.** Its name holds the way in as it was
  when each edit was queued, so edits queued before an approved move and those queued after it
  name the file differently: the Workshop draws a preview for each, and the one under the old
  way shows the refusal its folder gives, since each is opened through the proofs above and a
  file is not where the old name says. Rejecting the edits queued before the move leaves only
  edits that name the file by the way it now has. Naming a file by its ID alone would need the
  session to find a file's folders from the file, a read no folder session has.
- Not built: a read-only binding (its sessions have none of the reads), comments, shares and
  moves naming their file, and an icon for each file: the pane's icon is that of the
  connection's type of resource, and a file's kind is known only to the gatekeeper.

## Pull requests

1. **The framework's kernel half.** `Let a gatekeeper supply code that draws its resource`:
   `hasGadgetUi`, `getGadgetUi()`, the gadget view calls on `GatekeeperClient`, and the integration tests. This plan
   rides with it. `Let an action name the item it changes`: `ActionDescription.previewOf`,
   which `gatekeeper-kit` carries to the queue. `Say how a drawn connection's reads and an
   action's item are treated`: `docs/observers.md` and `docs/admin-access.md`.
2. **The Workshop pane and the first preview, stacked on the first.** Google Docs' reader of a
   Doc's stored runs that names a run's content and decodes one run, the plan's Google Docs
   section, the session reads, the client, and the pane with auto-open, one commit each.
3. **Google Sheets and Google Slides**, and **4. files reached through Google Drive**, each
   stacked on the one before.
5. **Where the reader is**, stacked on the fourth: section 5, and the item named by an anchor
   in place of a session the Workshop opened (section 1a).
6. **Telling the agent**, stacked on the fifth: the kernel's `#stampFocus()` takes a connection
   (one commit, with the agent's guidance), then the pane's offer and the chip, then the
   selection, the file's name and the type docs.

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
  kind, which `previewOf.anchor` hides on purpose: either a kind beside `anchor` and `title`, or the
  gatekeeper naming the type of session the file is opened as, as `describe().tsType` does for
  a connection. Such a gadget is bound to the folder's connection, so it also opens the file
  itself, as the Drive entry does, by methods its types have.
- **A sheet moved under a pick.** Google Sheets names no saving of a spreadsheet to the preview,
  so a collaborator's edit that moves cells while leaving the sheet as many rows and columns (a
  sort, a row put in and another taken out) is not seen: the cells picked keep their name, and
  are told as they read now.
- **More to pick.** A cell of a table on a slide, a table inside a cell of a document's table
  and an image inside a paragraph are each told as the table, the cell or the paragraph they
  are in. Whole rows and columns of a sheet are not picked from its headings, nor a document's
  table as a whole.
- **An item's own title on a chip opened later.** A message's focus keeps the connection's
  title. Opening the chip of a file with no change waiting draws the file under that title; the
  item's own would need the gatekeeper to describe an item by its ID.
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
