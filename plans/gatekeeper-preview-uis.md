# Plan: Gatekeeper preview UIs — a connection's content drawn beside the chat

This plan records the design agreed for gatekeeper preview UIs and what the first implementation
(branch `nathan/gk-google-side-view`) built. Google Docs is the first resource with a preview.
Cancelling a pending change from inside a preview and forking a preview into a gadget are
designed around but not built; see [Punted / future work](#punted--future-work).

## Goal

When an agent works on an external resource, show the person what is about to change. A
**preview** draws a connection's content beside the chat: the resource as its provider has it
saved, with the changes that are still waiting marked on top. The person applies or discards
those changes from the Workshop, next to the preview.

Supporting cast:

- A **preview UI**: client-side code a gatekeeper supplies, in the format and sandbox of a
  gadget's UI. Its `gadget` stub is the connection's own session instead of a gadget server.
- A **pending-changes read** on the session (`getPendingChanges()`), so the preview, and any
  gadget, can tell saved content from pending content.
- A **refresh signal** from the Workshop into the frame, because a session has no way to tell
  its holder that something changed.
- **Auto-open**: the Workshop opens the preview when work on a previewable connection starts.

## Locked decisions

- **A preview is gadget-format code, not a kernel-typed document.** The gatekeeper returns a
  `UiBundle`, the type a gadget's own UI uses, and the Workshop runs it in the existing gadget UI
  frame (`GadgetUI`): opaque-origin `srcDoc` iframe, same CSP, same MessagePort handshake. The
  alternative, a kernel `previewResource()` returning typed document/spreadsheet/presentation
  structures that the Workshop draws natively, was not taken: it puts every resource's shape
  into the kernel and the shared API.
- **The preview holds a session and nothing more.** The frame's `gadget` stub is what
  `GatekeeperClient.openSession()` returns. The preview can therefore do only what a gadget bound
  to the resource could, every read it makes is authorized and logged as an observation, and any
  action it submitted would wait for approval like any other. No new trust is introduced.
- **Read-only is a property of the first preview, not a kernel limit.** The Docs preview only
  reads. The frame does hold the full read-write session; nothing in the kernel stops a preview
  from submitting actions.
- **Applying and discarding stay in the Workshop.** The card with Apply and Discard is drawn by
  the Workshop outside the frame and calls the existing `approveAction()` / `rejectAction()`.
  Approval is the user's authority, not a capability a session holder has.
- **Pending changes are revealed through the session API.** `getPendingChanges()` is an ordinary
  session method, so a gadget can do what the preview does. The shape is a convention every
  gatekeeper follows (see the write-gatekeeper skill, "Revealing pending changes"):
  `getPendingChanges(scope?)` returning `{ changes, ... }`, each change
  `{ id, stale?, type, ...args }`, oldest first.
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
- `packages/workshop-backend/src/overseer.ts`: the gatekeeper client class forwards
  `getPreviewUi()`; `actionRecordToLog` withholds the gatekeeper's own action number
  (`record.action`) from clients.
- `packages/gatekeeper-google/src/google.ts`: `GoogleDocSessionImpl`, `PendingActionStore`,
  `#getSimulatedContent` (replays pending edits over the saved snapshot and marks ones that no
  longer fit).
- `packages/workshop-frontend/src/useActions.ts`: `useActions`, `useActionEntries` (the live
  action log on the client).

## Design

### 1. Preview declaration and delivery (workshop-shared + workshop-backend)

```ts
// gatekeeper.ts
type ResourceDescription = {
  /** Indicates that getPreviewUi() is available. */
  hasPreview?: true;
}

interface Gatekeeper<Session> {
  getPreviewUi?(): Promise<UiBundle>;
}

// api.ts
interface GatekeeperClient<Session> {
  getPreviewUi(): Promise<UiBundle>;
}
```

The kernel adds one forwarding method and no storage. A caller checks `describe().hasPreview`
before calling `getPreviewUi()`; calling it on a gatekeeper without one fails.

`describe()` reaches the provider (two Google API calls for a Doc). The flag is not stored on the
connection record. If cheap lookup is needed, denormalize it at connection creation as
`hasSlashCommands` is; existing connections would then lack it until re-described.

### 2. Pending-changes read (gatekeeper-google)

```ts
interface GoogleDocSession {
  getPendingChanges(tabId?: string): Promise<GoogleDocPendingChanges>;
}

type GoogleDocPendingChanges = {
  savedMarkdown: string;           // the tab as Google Docs has it saved
  markdown: string;                // the tab with pending changes, as getContent() returns it
  changes: GoogleDocPendingChange[];  // oldest first
}

type GoogleDocPendingChange = { id: number; stale?: true } & (
  | { type: "replaceText"; oldMarkdown: string; newMarkdown: string }
  | { type: "appendText"; markdown: string }
);
```

- One authorized observation per call, reporting what `getContent()` reports.
- On the read-write session only. The Drive read-only session has no pending changes.
- Scoped to one tab, with `getContent()`'s tab selection rule.
- `stale` marks a change the document no longer fits. It is left out of `markdown`, cannot be
  applied, and stays listed until rejected.
- A change whose write reached Google although its response was lost is not listed: the saved
  content already holds it.
- `id` is the number the gatekeeper passed to `submitAction()`. It is not the Workshop's action
  log id.
- The agent-facing docs call a change "pending" until Google Docs has saved it. This is the first
  place those docs admit that writes are deferred; they still never mention approvals.

### 3. A preview client (each gatekeeper)

Gadget-format client code the gatekeeper returns from `getPreviewUi()`. How it draws its resource
is the gatekeeper's business; what every preview keeps to is:

- It reads only through the session: once on load, and again on each `refresh` message from its
  parent. Each read is a logged observation, so it does not poll.
- It shows the resource with its pending changes, and what those changes did against the saved
  copy, from the session's `getPendingChanges()`.
- It says when a change is stale, since a stale change appears in neither copy.
- It treats everything the resource says as text. Nothing from it is parsed as HTML into the
  frame, and links are drawn but not followable.
- It carries its own styling for light and dark; the Workshop's tokens do not exist in the frame.
- It does not apply or discard. Those stay in the Workshop.

Google Docs is the first (`gatekeeper-google/src/docs-preview-client.txt`).

The file is `.txt` because the gatekeeper's bundler imports only `.txt` and `.svg` as text, and a
symlink to a `.js` file is executed as code by the test pool. It is therefore not linted.

### 4. The Workshop pane (workshop-frontend, `features/connection-preview/`)

- `ConnectionPreviewPane`: builds a `GadgetUiSource` from the connection
  (`getUiBundle: () => client.getPreviewUi()`, `connectToGadget: () => client.openSession()`),
  relays a debounced refresh when an `action` entry arrives for the connection, and draws the
  "changes waiting" card. Observation entries are ignored: the preview's own reads are logged on
  its connection and would refresh it forever. In a restricted workspace the card points to the
  chat instead of offering Apply and Discard.
- `useAutoOpenConnectionPreview`: opens a connection that offers a preview at its first live read
  or change, and at each change queued after that. Work from before the page loaded does not
  count, a connection whose preview the user closed stays closed until reload, and a single-pane
  layout is left alone.
- `usePendingConnectionPreviews`: the connections that offer a preview and have changes waiting.
  The editor shows a button in the top bar for each one whose preview is not showing.
- `connectionPreview.ts`: `offersPreview()` asks `describe()` once per connection per page.
- The pane takes the Activity pane's place in `GadgetEditor` and shares its open and close
  handling. The top bar's Activity button switches back.

## Verification

- Docs actions suite (workerd): pending changes in order with their arguments, one observation,
  stale changes, tab filtering, the missing-tab error, applied and rejected changes, and the
  lost-response case.
- Integration: a client reads `hasPreview` and `getPreviewUi()` from the fake gatekeeper through
  `GatekeeperClient`.
- Frontend: the pane in real Chromium against a fake session (the frame is opaque-origin, so the
  test asserts the session's call log), and unit tests for the auto-open and pending-preview
  rules.
- Live, against a real Google Doc on a local instance: rendering of replacements, appends, nested
  and numbered lists, inline formatting, a 400-paragraph append and a stale change; refresh on
  queue and discard; auto-open, dismissal and reopen. Opening a preview logs two reads (tab list,
  pending changes) and each change event logs one.
- Not verified live: tables, multiple tabs, a Doc that has not been created yet, and an agent
  queuing edits from a chat (the local instance had no model; edits were queued through the API).

## Known edge cases / watch-fors

- **Ids do not match the action log.** The preview's change ids are the gatekeeper's; the
  Workshop's card uses action log ids. They correspond only by order, and not exactly: the card
  counts the whole connection, the preview lists one tab and omits changes that already landed.
  One-to-one linking needs the gatekeeper's action number on `ActionLogEntry`, which
  `actionRecordToLog` withholds today.
- **Any read opens the preview.** The action log entry does not say who made a read, so a gadget
  polling a Doc opens the preview once per page load, and every collaborator in the workspace
  sees it open, not only the person whose chat is working.
- **Reads the user did not ask for.** Auto-open logs observations in the activity history
  without an explicit request.
- **`describe()` on workspace open.** A workspace opened with Doc changes waiting describes that
  connection to decide whether to show the reopen button.
- **Refresh only reaches a Workshop frame.** A "use"-role viewer's action subscription is inert,
  so a preview shown to one would not refresh. Gadget server code gets no signal at all.
- **Edits made in Google Docs directly** are seen only on the next read, subject to the
  session's snapshot lifetime. Nothing notifies the preview.
- **Large documents.** The preview fetches and diffs the whole tab. Nothing caps a tab's size
  or keeps only the text around each edit.
- **A preview is only as faithful as its session.** It can draw what the session's reads
  return and nothing more; for Docs that is the tab as Markdown, without its appearance.

## Commit sequence

1. `Let a Google Doc session say which of its changes are pending`: `getPendingChanges()`, its
   tests, and the skill convention.
2. `Spike: draw a Google Doc connection beside the chat in the gadget UI frame`: `GadgetUI`
   source and refresh, the pane, the browser test.
3. `Let a gatekeeper supply code that draws its resource`: `hasPreview`, `getPreviewUi()`, the
   kernel forward. Reviewable apart from everything else.
4. `Ship the Google Doc preview with its gatekeeper`: the client moves into the gatekeeper.
5. `Test that a client receives its connection's preview code`: integration coverage.
6. `Open a connection's preview when work on it starts`: auto-open; the test-only Preview
   buttons are removed.
7. `Let a closed connection preview be opened again`: the reopen button.

## Punted / future work

- **Cancel from the preview.** Sketch: `cancelPendingChange(id)` on the session, and
  `ApprovalQueue.withdrawAction(action)` so the kernel runs its existing reject path (which calls
  the gatekeeper's `rejectAction()`), keeping one reject path. Open: who may withdraw (any holder
  of the read-write session, which a forked preview needs, versus only the submitter), how a
  withdrawal is attributed when the session is a gadget or carries no user identity, restricted
  workspaces, and re-entrancy of the kernel calling back into the gatekeeper mid-call.
- **Accept all.** A Workshop control that approves a connection's pending actions oldest first,
  from the ids taken at click time. Needs a decision on partial failure.
- **Per-connection "Review" rows in the chat** and the "N changes drafted" bar from the mockup.
- **Fork to gadget.** A fork must stay in the same workspace and bind the existing connection:
  the pending store lives in the connection, and `newWorkspaceFromBlueprint` creates a new
  connection with an empty one. The Workshop would relay refresh by the gadget's
  `listBindings()`. A gadget server passing its binding's session through to its UI is untested.
- **Change notification beyond the Workshop frame.** Either a live callback on the session (no
  precedent for a non-persistent callback; lost when the gatekeeper is evicted) or a hook through
  `bindHook()` (persistent stub, user approval, one logged read per delivery). Open: whether a
  content-free "something changed" signal counts as an observation.
- **Store `hasPreview` on the connection record**, to drop the `describe()` call.
- **A build step for preview clients**, so they are real `.js` files with lint and types.
- **A kit helper for `getPendingChanges()`.** Worth extracting over `SimulationView` once a
  second session follows the convention.
- **Mobile.** Auto-open and the reopen button are desktop-only.
