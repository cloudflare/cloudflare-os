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

What a gatekeeper does to have a preview: set `hasPreview`, return client code from
`getPreviewUi()`, and give its session a `getPendingChanges()` plus whatever other reads its
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
  session, so its reads are authorized and logged and anything it submitted would wait for
  approval, where a frame's `ui` stub answers to nothing but its gatekeeper. And its code is a
  gadget's UI files rather than a page, so the kernel checks its imports as it does a gadget's and
  a person can fork it into one.
- **A preview is shipped as source, so it can be forked.** Plain `.js` files with relative
  imports, `client.js` the entry: what a person would get on copying the preview into a gadget,
  and what they would edit. No bundler, no minifying and no TypeScript build stands between the
  files a gatekeeper keeps and the files it returns. Several previews of one gatekeeper can share
  modules; each returns the ones it uses.
- **The preview holds a session and nothing more.** The frame's `gadget` stub is what
  `GatekeeperClient.openSession()` returns. The preview can therefore do only what a gadget bound
  to the resource could, every read it makes is authorized and logged as an observation, and any
  action it submitted would wait for approval like any other. No new trust is introduced.
- **Read-only is a property of a preview, not a kernel limit.** The frame holds the full session;
  nothing in the kernel stops a preview from submitting actions.
- **Applying and discarding stay in the Workshop.** The card with Apply and Discard is drawn by
  the Workshop outside the frame and calls the existing `approveAction()` / `rejectAction()`.
  Approval is the user's authority, not a capability a session holder has.
- **Pending changes are revealed through the session API.** `getPendingChanges()` is an ordinary
  session method, so a gadget can do what the preview does. Its shape is a convention every
  gatekeeper follows (section 2).
- **A gatekeeper declares its preview; the Workshop never names a vendor.**
  `ResourceDescription.hasPreview` plus the optional `Gatekeeper.getPreviewUi()` follow
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
  `getPreviewUi`), `UiBundle`, `ActionLogEntry`.
- `packages/workshop-backend/src/ui-bundle.ts`: `buildUiBundle`, which follows `client.js`'s
  relative imports, rewrites them and enforces the UI import rules.
- `packages/workshop-backend/src/overseer.ts`: the gatekeeper client class builds the bundle from
  what the gatekeeper's `getPreviewUi()` returns; `actionRecordToLog` withholds the gatekeeper's own action number
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
  /** Indicates that getPreviewUi() is available. */
  hasPreview?: true;
}

type UiFile = { path: string; code: string };  // as written; client.js is the entry

interface Gatekeeper<Session> {
  getPreviewUi?(): Promise<UiFile[]>;
}

// api.ts
interface GatekeeperClient<Session> {
  getPreviewUi(): Promise<UiBundle>;
}
```

The kernel adds one method and no storage: it asks the gatekeeper for the files and runs
`buildUiBundle` over them, so a preview's imports are followed and checked exactly as a gadget's
are, and `gatekeeper.ts` needs no UI type. A caller checks `describe().hasPreview` before calling
`getPreviewUi()`; calling it on a gatekeeper without one fails, as does a preview with no
`client.js` or with an import the rules refuse.

`describe()` may reach the provider. The flag is not stored on the connection record. If cheap
lookup is needed, denormalize it at connection creation as `hasSlashCommands` is; existing
connections would then lack it until re-described.

### 1a. A preview of one item of a resource (workshop-shared + workshop-backend)

A connection to a folder reaches many files, and a log entry names only the connection. So an
action may name the item it changes, and the preview is asked for by that name:

```ts
// gatekeeper.ts
type PreviewItem = { id: string; title: string; url?: string };

type ActionDescription = {
  /** The one item of the resource this action changes, when the gatekeeper can draw it by itself. */
  previewOf?: PreviewItem;
}

interface Gatekeeper<Session> {
  getPreviewUi?(previewOf?: string): Promise<UiFile[]>;
}

// api.ts
interface GatekeeperClient<Session> {
  getPreviewUi(previewOf?: string): Promise<UiBundle>;
}
```

- `id` is the gatekeeper's own name for the item and opaque to the Workshop, which hands it back.
  It is not one of `ObservationDescription.subresources`: those are enforced and never shown,
  this is shown and enforces nothing. `title` and `url` are for the pane's heading and link, as
  `describe()`'s are for a whole resource.
- The kernel adds no storage and no code beyond passing the argument on: an action's description
  is already stored whole and sent to clients whole. `gatekeeper-kit` carries the field from a
  definition's `describe()` to the queue.
- `getPreviewUi(previewOf)` returns code only. What the item holds is read by that code through a
  session, where the gatekeeper checks access as for any read.
- Nor is it one of the action's `fields`, which are what an approver reads and which a gatekeeper
  words for a person. `previewOf` is read by the Workshop to decide what to draw, and has to mean
  the same thing in every action that touches the item.
- A preview is therefore offered in two ways, and the Workshop looks for both: `hasPreview` on
  `describe()` offers one of the whole resource, and an action that names an item offers one of
  that item. A connection can do either, both or neither, and the second needs no `hasPreview`.
- The session an item's preview draws from is not in the kernel's types. The Workshop calls
  `openPreview(id)` on the connection's session and hands the frame what it returns. That is a
  convention between a gatekeeper and the Workshop (in the write-gatekeeper skill), checked by
  no interface: `Session` is opaque to the kernel, and a typed method there would put a preview's
  shape into it. A gatekeeper that names items and has no `openPreview()` gets a pane that fails
  to load, which a test of its preview catches.
- On actions only. A read that names an item would open a preview for everything an agent skims,
  and a preview's own reads are recorded against the workspace, not a chat.
- Tested by the integration test above: an action carries `previewOf` to a client, and the client
  gets that item's code by its ID.

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

Gadget-format client code the gatekeeper returns from `getPreviewUi()`, as source files. How it
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
  frame's content policy allows no network access, and stays that way: a host the frame could
  load from is a host it could send the session's data to.
- It does not apply or discard. Those stay in the Workshop.

A preview is only as faithful as its session: it can draw what the session's reads return and
nothing more. A gatekeeper that wants its preview to look like the real thing adds the reads for
that to its session, where a gadget can use them too.

### 4. The Workshop pane (workshop-frontend, `features/connection-preview/`)

None of this names a vendor or a resource type; it works from `hasPreview`, the action log and
the connection's ID.

- `ConnectionPreviewPane`: builds a `GadgetUiSource` from the connection
  (`getUiBundle: () => client.getPreviewUi()`, `connectToGadget: () => client.openSession()`),
  relays a debounced refresh when an `action` entry arrives for the connection, and draws the
  "changes waiting" card. Observation entries are ignored: the preview's own reads are logged on
  its connection and would refresh it forever. In a restricted workspace the card points to the
  chat instead of offering Apply and Discard.
- `useAutoOpenConnectionPreview`: opens a connection that offers a preview at its first live read
  or change, and at each change queued after that. Work from before the page loaded does not
  count, a connection whose preview the user closed stays closed until reload or until another
  workspace is opened (connections are numbered per workspace), and a single-pane layout is left
  alone.
- `usePendingConnectionPreviews`: the connections that offer a preview and have changes waiting.
  The editor shows a button in the top bar for each one whose preview is not showing.
- `connectionPreview.ts`: `offersPreview()` asks `describe()` once per connection per page. The
  pane's icon is the one the vendor gives the connection's type of resource
  (`SupportedResource.icon`, found through `getCreationSpec()`), so a gatekeeper says nothing
  more for it.
- The pane takes the Activity pane's place in `GadgetEditor` and shares its open and close
  handling. The top bar's Activity button switches back.

## Verification of the framework

- Integration: a client reads `hasPreview` and `getPreviewUi()` from the test gatekeeper through
  `GatekeeperClient`. The test preview is two files and one it never imports: the import arrives
  rewritten and the unused file does not arrive.
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
preview's reads are declared there although they add more than half again to what every agent
given a Doc is sent: a forked preview is edited by an agent, which learns the session from
these types alone. Sheets and Slides do the same. Each
reads one tab and takes a required `tabId`: `getContent()` lets it be omitted for a one-tab
document only because callers older than tabs exist, and these reads are new.

```ts
getPendingChanges(tabId: string): Promise<GoogleDocPendingChanges>;  // { savedMarkdown, markdown, changes }
getStyles(tabId: string): Promise<GoogleDocStyles>;      // page, named styles, per-paragraph/run/table overrides, heading IDs
listImages(tabId: string): Promise<GoogleDocImage[]>;    // one per [Image] placeholder, in order
readImage(imageId: string, tabId: string): Promise<GoogleDocImageBytes>;  // at most 10 MB
```

- `getPendingChanges()` follows section 2: the changes are `replaceText` and `appendText`, and
  the two copies are Markdown. It is on the read-write session only; a Doc opened through Drive
  has no pending changes and no preview. A tab still to be added reads as saved and empty, with
  every edit to it listed.
- Styles are keyed by the line of `savedMarkdown` they belong to, so a caller lays them over the
  Markdown it already has. They say nothing about pending text, which takes the look of what it
  replaces or follows.
- Image bytes are returned whole, not streamed: a stream from the backend session does not reach
  the UI frame (capnweb 0.12.0). Google's image addresses lapse; a read that finds one lapsed
  reads the document again. Any other failure to fetch an image is reported as it is: only a
  lapsed address (403 or 404) is mended by another read.

### Client

`gatekeeper-google/src/previews/docs.js`, a linted `.js` file that is not type-checked. The
gatekeeper's bundler imports only `.txt` and `.svg` as text, so `docs.ts` imports it through the
symlink `previews/docs.txt`, and returns it as `client.js`. The frame calls `main(gadget)` on
its default export.

It draws a tab in the document's own page, fonts, colors, tables and images, marks insertions and
deletions, lists the tabs and the tab's headings in an outline, and steps through the changes in
the tab shown. A tab still to be added is marked in the outline; the client knows it by the
provisional ID `addTab()` returns. It only reads.

### Verification

- Docs actions suite (workerd): pending changes in order with their arguments, one observation,
  stale changes, tab filtering, the unknown-tab error, a tab still to be added, applied and
  rejected changes, the lost-response case, styles, and images (listing, refusals, the size
  limit, a lapsed address).
- The client in a same-origin frame in real Chromium, where its drawing can be read.
- Live, against a real Google Doc on a local instance: styles, tables, images, several tabs, a
  pending tab add, the outline, heading links, replacements, appends and a stale change; refresh
  on queue and discard; auto-open, dismissal and reopen. Opening a preview logs the tab list,
  the pending changes, the styles and, for a tab with images, the image list. Each change event
  logs the tab list and the pending changes again.
- Not verified live: a web link opened from the real frame, a Doc that has not been created yet,
  and an agent queuing edits from a chat (the local instance had no model; edits were queued
  through the API).

### Watch-fors

- **Image reads after a listing are not authorized again.** `readImage()` skips
  `authorizeObservation()` for an image `listImages()` returned in the same session, to keep one
  log entry per tab rather than one per image. The skill asks for every read to be authorized;
  this is open for review.
- **Bookmark links go nowhere.** The Docs API gives a bookmark's ID and tab but not its place,
  so a link to one in the tab shown cannot be followed.
- **The navigator counts places, not requests.** It steps through the stretches of changed text
  in the tab shown, so it differs from the Workshop's count of requests on the connection.
- **Large documents.** The client fetches and diffs the whole tab. Nothing caps a tab's size or
  keeps only the text around each edit.
- **The Docs rendering version moved from 6 to 7.** Snapshots cached and edits queued under 6
  are discarded or marked stale once, as for any rendering change.

## Pull requests

1. **The framework's kernel half.** `Let a gatekeeper supply code that draws its resource`:
   `hasPreview`, `getPreviewUi()`, the overseer building the bundle, and the integration test. This plan
   rides with it.
2. **The Workshop pane and the first preview, stacked on the first.** Google Docs' session
   reads, its client, and the pane with auto-open, one commit each.

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
- **Store `hasPreview` on the connection record**, to drop the `describe()` call.
- **Type-checking preview clients** without a build, by JSDoc and `checkJs`. A build step is
  ruled out by forking (see the locked decisions).
- **A kit helper for `getPendingChanges()`.** Worth extracting over `SimulationView` once a
  second session follows the convention.
- **One read per refresh.** A preview that lists its scopes and then reads one logs two reads
  per refresh. A combined read would halve that and widen the session API.
- **Mobile.** Auto-open and the reopen button are desktop-only.
- **Google Docs:** comments and suggestions in the preview; bookmark links.
