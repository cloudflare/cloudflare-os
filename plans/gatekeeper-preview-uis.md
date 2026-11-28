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

Everything specific to one vendor is in `packages/gatekeeper-google` and in this section, which
the second pull request below writes with the preview itself.

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
- **Google Docs:** comments and suggestions in the preview; bookmark links.
