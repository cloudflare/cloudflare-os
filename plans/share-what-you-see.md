# Plan: Share what you see

> Status: historical. Implemented in November 2026; `docs/sharing.md`, "Shared views", is the
> current description, and where the two differ it is right. Was: proposal, November 2026. Prototype: `dist/share-prototype/share-what-you-see.html`
> (gitignored; ask Phillip). Balint's share-dialog designs are the visual language.

## The problem

Sharing a gadget today means sharing the ability to *run* it. The kernel upholds one rule (see
[docs/observers.md](../docs/observers.md)): nobody may interact with a gadget that has read data
they could not read themselves. So when Phillip shares a BigQuery-backed billing dashboard with
Bob, Bob must connect his own Google account and pass `addObserver()` / `verifyObserverAccess()`
against every dataset the dashboard read. Bob has no BigQuery access and never will (billing), so
he lands on a lock screen. Sharing has failed for the most common reason people share a
dashboard: to show someone what they are looking at.

Users already route around this. Ben built a second gadget that mirrors his dashboard hourly from
the connected one, so colleagues could see it without verifying. Everyone else takes screenshots
or uses the built-in HTML/PDF export (`GadgetExportMenu`, `gadget-export.ts`) and posts the file
in chat. `docs/observers.md` §10 even names the gap: data copied between contexts "transfer[s]
nothing between contexts", which "deliberately permits indirect disclosure". The owner can already
publish what they see; the platform just gives them no good way to do it, nothing records that it
happened, and nothing can be revoked.

## The position

**Sharing a gadget shares the owner's view. Access to the data decides whether the recipient may
also explore it live.** These are two different things, and the owner is responsible for the
first while the platform stays responsible for the second:

| | The owner's view | Live gadget |
|---|---|---|
| What the recipient gets | A copy of the gadget with the owner's data, as of a moment | The running gadget, calling its data sources |
| Who decides | The owner, by sharing | The gatekeeper, by verifying the recipient's own access |
| Recipient needs | Nothing | Their own access to every source the gadget reaches |
| Can run queries on the owner's connection | No | Yes (BigQuery bills the connection's project, `google.ts` `#billingProject`) |

We are opinionated about one thing: **there is no "view only" vs "collaborate" choice at share
time.** Sharing a gadget means "see my view; explore it if you can." Editing never comes from
sharing a gadget; it comes from inviting someone to the workspace (`build`), which already exists
and already demands access to everything in it. A per-share "view only" switch is the one feature
we deliberately defer (see Deferred).

## The user journey

Business users. No "snapshot", "verify", "capability", "live", or "observer" in the UI.

### Phillip shares

1. Phillip opens **Share "Workers Paid billing"** (Balint's dialog), types Bob's name, clicks
   **Invite**. Toast: *"Shared with Bob. He sees what you see."* There is no role dropdown and
   no consent step: sharing *is* the decision, and Phillip knows Bob will see what he sees.
2. People Phillip shared the gadget with show "Can view" with a menu holding only "Remove
   access". Workspace members appear in their own group as "Workspace member · Can edit", with no
   dropdown, since their access comes from the workspace.
3. The footer pill explains the model once, in the variation the team picks (prototype has
   three: a footer line "People without access see your view"; a per-person status line "Sees
   your view / Uses live data / Hasn't opened yet"; a helper line under the invite box "They'll
   see what you see. If they can already open its data, they can explore it themselves."). The
   pill opens **What people see**: one lede ("Everyone you share with sees this app with your
   data. It updates each time you open it."), a "Your view · Updated today at 10:42" row with a
   thumbnail, the gadget's sources as bare vendor rows ("BigQuery · finance.accounts"), and one
   fine-print line: "Exploring runs through your BigQuery connection. Nobody gets your Google
   sign-in."

### Bob opens

Bob's state decides what he gets, with no prompt he does not need:

| Bob | What he sees |
|---|---|
| Has not signed in with Google | Phillip's view, plus one card (styled like "Do you want the same kind of app?"): **Want to explore this yourself?** / *You're seeing Phillip's view from today, 10:42.* |
| Signed in, lacks access to a source | Phillip's view, card reads **You're seeing Phillip's view** / *From today, 10:42. You can look, but not change filters.* He is not asked to sign in again. |
| Signed in, can open every source | Straight to the live gadget. No prompt, no account picker. A "Live data" chip in the header. |

Rules the journey follows:

- **Sharing always works.** Bob never meets a lock screen.
- **The view's date is always visible** ("As of today, 10:42"). Past two weeks it gets an amber
  "3 weeks old" chip and an "Ask Phillip to refresh" link (needs a notification template; v2).
- **Filters are shown frozen, not hidden.** A lock glyph and a tooltip: "This is Phillip's view,
  so filters stay as he left them." Hiding them makes the dashboard look broken.
- **Exploring is one dialog.** "Explore it yourself": one lede, the sources, **Continue with
  Google**, "Not now." Then the same rows gain a status each ("Checking", "Can open", "No
  access"). Success: "You're all set" → **Start exploring**. Failure: "You'll keep Phillip's
  view" with one line naming the table he cannot open, **Copy access request** (text addressed
  to his data team, since Phillip cannot grant BigQuery access), and **Done**.
- **Failure is remembered.** A checked-and-failed Bob keeps the view and is not re-prompted; he
  is re-checked silently on his next open, so access granted later takes effect without him
  doing anything.

### Phillip checks back

The share dialog shows who opened what (variation B puts it on each row). Removing Bob works as
today. Phillip never manages snapshots: there is exactly one view per shared gadget, replaced in
place, and he cannot create, name, list, or delete it.

## Technical design

### What "the view" is

A second copy of the gadget that holds its storage and none of its bindings. Durable Object
facets give the kernel the primitive: `ctx.facets.clone(src, dst)` copies one facet's storage
onto another's (about 10ms for a small gadget; it works while the source runs, and cloning over
a running destination ends it with "Facet was cloned-over", after which the next `facets.get`
starts it on the new copy). The view facet (`viewFacetName()`, beside `gadgetFacetName()`) runs
the gadget's own `server.js` from the same worker modules, pinned to the commit the view was
taken at so code and storage agree, with an empty `env`, no tails, and a bare facet stub rather
than a `ctx.restore()`-minted one, so it can neither reach a gatekeeper nor mint a persistent
stub that would restore against the running gadget. Viewers get the gadget's real UI (`getUiBundle()`
at that commit) connected to the copy, so tabs, filters and whatever else the UI does work; only
what it reads through a binding is absent.

This was a change of shape mid-build. The first version was the browser-mode static HTML export
(`renderGadgetInBrowser()` in Browser Rendering, sanitized and pinned to a no-script CSP, stored in
R2). It showed only the default screen -- a two-tab gadget's first tab, a dashboard's unfiltered
state -- and the team's review (Max, Kenton) pointed at the copy instead. Shapes weighed:

- **A. Rendered page (built first, replaced).** Works for every gadget with no author work, but
  frozen: one screen, no interaction, and a Browser Rendering dependency.
- **B. Record and replay.** Capture the data the UI fetched and replay it. Rejected: it publishes
  everything the gadget *fetched*, not what the owner *saw*.
- **C. Gadget-defined view.** An export-style hook returning the data the gadget is willing to
  publish. Needs gadget code for every gadget.
- **D. Binding-less copy (chosen).** The cloned facet above. Interactive, no rendering
  dependency, no author hook; what it asks of gadgets is a habit the agent is now prompted for:
  keep what the UI displays in storage, render from storage, and treat a missing binding as
  nothing new rather than an error (`agent.ts` system prompt). A gadget that only renders live
  binding reads shows its empty state in the view, which is honest rather than wrong.

Two accepted consequences. The copy is writable: a viewer's clicks may change it, and the
owner's next open overwrites it (`PRAGMA query_only` is refused inside a DO, so there is no
cheap read-only mode; preventing writes is a possible later refinement, not a requirement).
And the clone copies stored capabilities with the storage -- a stub the gadget persisted could
in principle be restored by the copy -- which is a known risk marked `TODO(known-risk)` in
`overseer.ts` and deferred, since gadgets today do not persist stubs to their own storage.

### Where the view lives and when it is taken

- **Storage.** The view facet itself, plus a small `ViewRecord {takenAt, byProfileId, commitId,
  requirementKeys[]}` in the Overseer DO. Replaced in place; no history. `deleteView()` deletes
  the facet with the record, and the gadget's deletion deletes both.
- **Trigger: the gadget being opened.** "Up to date" is the promise. (The first cut retook it only
  on the owner's opens, which left scheduled writes out until the owner came back.)
  When the owner's `connectToGadget()` succeeds on mainline code, or the owner shares the gadget
  with its first collaborator, the Overseer clones in the background, and every opening of the
  view clones first and waits (`refreshView`), so scheduled writes reach viewers too; at
  most once per `VIEW_REFRESH_INTERVAL_MS` (a minute) per gadget, never while a clone is in
  flight, and only while someone holds the gadget through `use`. The clone reads nothing: it is
  a copy of what the gadget already stored, so there is no new read on anyone's behalf and no
  half-loaded screen. Viewers whose UI is connected to the old copy are dropped by the clone-over
  and reconnect to the new one.
- **Policy.** `AdminConfig.sharedViews` is the only switch; `WorkspaceMetadata.sharedViewsAvailable`
  reports it. There is no binding to miss, so no deployment degrades to "no views" by accident.

### Admission: the view as the denied outcome

Today `UseOverseerInterface.getGadget()` (`overseer.ts`) calls `authorizeGadget()`, which runs
`ensureObserver()` and throws to deny; the frontend's `GadgetUseView` shows the denial with a
retry button. The change is in the denial branch only:

1. `authorizeGadget()` splits into **access** (is the gadget in the collaborator's effective
   access, via `SharingManager.getEffectiveAccess()`; unchanged, still refuses like a missing
   gadget) and **verification** (`ensureObserver()`).
2. When verification fails or cannot run non-interactively, and a `ViewRecord` exists,
   `getGadget()` returns a **`ViewGadgetClientInterface`** instead of throwing: a third
   `implements GadgetClient` class beside `UseGadgetClientInterface`, default-deny like it. Its
   allowlist is `getId()`, `getTitle()`, a new `getView(): Promise<GadgetView>` (`takenAt` and
   the owner's profile), and `getUiBundle()` / `connectToGadget()` without a `chatId`, which serve
   the view's copy. `getExportFormats()`, `export()` and the chat-scoped variants `#deny()`, so a
   view session can reach no gatekeeper and never the running gadget. It does **not**
   `joinSession("use", …)`: it holds nothing a scope widening would need to sever. The owner sees
   the same copy through `GadgetClient.openView()`, which the share dialog's preview renders.
3. The frontend asks which it got through one new discriminator rather than probing:
   `GadgetClient.getAccessMode(): Promise<"live" | "view">`, allowed on both restricted classes.
   `GadgetUseView` renders the view with the same `GadgetUI` the live gadget uses, with the
   explore card floating over its top and a header chip once the card is dismissed.
4. **Silent-first verification.** `getGadget()` is first called with `configureObservers`
   undefined. The kernel already treats a missing callback as "cannot configure, deny"; with a
   view available that now yields the view, so the un-signed-in Bob sees the view with no modal.
   Only the explore card calls `getGadget()` again *with* the callback, which drives
   `ObserverConfigModal` (restyled per the prototype as "Explore it yourself"). Success swaps the
   iframe for the live UI in place.
5. **Remembered failure.** The `ObserverRecord.accountChoices` the kernel already persists is
   what makes "signed in, no access" silent: the next `getGadget()` without a callback re-runs
   `addObserver()`/`verifyObserverAccess()` with the remembered account, and either admits live
   (access was granted since) or returns the view (still denied) — no prompt either way.

### Keeping the kernel's invariant honest

The view is owner-published content, not gadget access, and the plan keeps that distinction
enforceable rather than rhetorical:

- **Audit.** Each clone writes an action-log record (`kind: "viewPublished"`, with the
  `requirementKeys` of every subresource the gadget had recorded at that commit). Admins can see
  that restricted data left its access controls, which Ben's mirror can never show.
- **Deployment policy.** `AdminConfig.sharedViews: boolean` beside `restrictedWebFetchHosts`,
  default **on** (decided): owners may already export and forward what they see, so the platform
  defaults to the accountable path. Admins of stricter deployments turn it off on the admin
  panel's Security tab and get today's behavior. The toggle applies to `containsRestrictedData`
  workspaces too; there is no per-flag default.
- **`ownerInvitesOnly` is respected.** A workspace under that flag serves views only to
  collaborators the owner added directly, because share-link joiners already hold nothing there.
- **Scope widening does not leak forward.** A view is taken at a commit; `ViewRecord.commitId`
  and its `requirementKeys` say exactly what it may contain. A later change to the gadget's
  code or bindings does nothing to the stored view until the owner next opens the gadget, at
  which point a new clone is taken under the new scope and the record is replaced. There is
  nothing to re-verify: view recipients were never verified.
- **Revocation.** Removing Bob severs his edge; his next `getGadget()` refuses like a missing
  gadget, as today. The existing revocation restart (`scheduleAccessRestart`) already drops a
  live view session. When the owner loses `build` on the workspace (ownership transfer aside,
  this is "the publisher left"), the `ViewRecord` is deleted on the next access check and the
  gadget falls back to today's deny, because the person who could see it no longer can.
- **Export parity.** A `use` collaborator who holds only the view may not call `export()`; a
  live `use` collaborator keeps today's export rights. Nothing a view session can do produces
  bytes the owner did not already publish.

### Shared API (`workshop-shared/src/api.ts`)

Every member doc-commented; no mirror interfaces, no casts.

```ts
/** How a collaborator's GadgetClient was admitted: the running gadget, or the owner's view. */
export type GadgetAccessMode = "live" | "view";

/** The owner's view of a gadget -- a copy with its storage and no bindings -- served to
 *  collaborators who could not be verified against its data sources. */
export type GadgetView = {
  /** When the owner's open took this view. */
  takenAt: Date;
  /** Whose view it is. */
  owner: AiChatAuthorInfo;
};

interface GadgetClient {
  /** "view" when this client holds only the owner's view; "live" otherwise. */
  getAccessMode(): Promise<GadgetAccessMode>;
  /** The owner's view. Throws for "live" clients. */
  getView(): Promise<GadgetView>;
  /** The owner's own look at the view: a "view" client over the same copy people get. */
  openView(): Promise<RpcStub<GadgetClient>>;
}

type CollaboratorInfo = { …; /** How each held gadget was last opened, for the share dialog. */
  lastOpened?: Record<WorkpieceId, {at: Date; mode: GadgetAccessMode}> };

interface WorkspaceMetadata { …;
  /** True when this deployment serves views (the admin policy is on). */
  sharedViewsAvailable?: boolean; }

interface GadgetSummary { …;
  /** When the owner's view was last taken, for the "What people see" panel. Absent if none. */
  viewTakenAt?: Date; }

interface AdminConfig { …; /** Whether gadget shares serve the owner's view to unverified
  collaborators (see plans/share-what-you-see.md). Default true. */ sharedViews: boolean; }
interface AdminApi { …; setSharedViews(enabled: boolean): Promise<void>; }
```

### Frontend (`workshop-frontend`)

Load `frontend-conventions` before touching these. Kumo components throughout.

- `ShareGadgetDialog`: Balint's layout; drop the role dropdown for gadget shares; "Workspace
  member" group; per-person status line from `CollaboratorInfo.lastOpened` ("Sees your view" /
  "Uses live data" / "Hasn't opened yet"); footer pill → **What people see** panel, whose "Your
  view" row reads `GadgetSummary.viewTakenAt`. When `sharedViewsAvailable` is false the dialog is
  Balint's current design unchanged.
- `GadgetUseView`: branch on `getAccessMode()`; the view's copy in `GadgetUI` + the explore
  card over its top; the card says it is a snapshot of what the owner sees, instead of
  per-control tooltips, since the controls inside the view are the gadget's own markup.
- `ObserverConfigModal`: restyle as "Explore it yourself" with per-source status rows and the
  two outcomes; add **Copy access request** (text built from the failed `ObserverBindingNeed`s).
- Date freshness chip at 14 days. "Ask to refresh" is not in this PR (needs a notification
  template).
- Admin panel: a "Shared views" switch on the Security tab beside the restricted web-fetch
  settings.

### Details that make it feel intentional

All in scope. Each is small; together they are the difference between a feature and a patch.

**Words**
1. Two verbs, never mixed: the view says **"As of today, 10:42"** (a moment), live says
   **"Updated just now"** (a stream). Owner-side copy always says *your view*; viewer-side
   says *Phillip's view*, first name from the profile, falling back to the email. "Snapshot",
   "live", "verify" and "the owner" never appear in UI text.
2. Times age in place: "today, 10:42" → "yesterday, 10:42" → "Oct 16", in the viewer's
   timezone, with the absolute timestamp as the tooltip. The amber "3 weeks old" chip appears
   at 14 days and is the only colored element on the banner.
3. The explore card never asks the same question twice. Before a check: **Want to explore this
   yourself?** After a failed check it becomes a statement, **You're seeing Phillip's view**,
   and its action becomes "See what's missing".
4. Failure copy names the account and the table: "bob@cloudflare.com can't open
   finance.accounts." The **Copy access request** text is paste-ready for a data-team ticket:
   requester email, table id, app name, one sentence. Toast after copying: "Copied. Paste it to
   whoever manages your BigQuery access."
5. The share-dialog footer shifts tense with state: no recipients yet → "People without access
   **will** see your view"; recipients → "People without access see your view". Without Browser
   Rendering it is Balint's "Protected resources (n)" unchanged.
6. The remove confirmation says what will happen to the person, not the record: "Bob will no
   longer see this app." If Bob is on live data right now it adds "and will be disconnected
   now", because the revocation restart does exactly that.

**Phillip's side**
7. The "Your view" row's thumbnail is the real view, the copy's own UI run inert at desktop
   width and scaled down, not an illustration. Phillip literally sees what people see.
8. After **Invite**, the new row flashes once (accent-soft to transparent over 1.4s), the input
   keeps focus for the next name, and Enter invites. The toast reads "Shared with Bob. He sees
   what you see." using the directory's first name.
9. One icon vocabulary across both sides: eye = view, bolt = live, lock = workspace-only. The
   footer pill, status lines, Bob's card and header chips all draw from it; no icon means two
   things.
10. A gadget with no UI (agent-only) takes no view. The panel says so plainly: "This app has no
    screen to show. People need access to its sources to open it."
11. A clone that fails does not replace the last good
    view. The owner, and only the owner, sees a quiet "Couldn't update your view" line in the
    panel with the time of the last good one. Viewers never see an error screen as "the view".

**Bob's side**
12. First frame is the gadget. The view is the gadget's own UI over the copy, in the same
    `GadgetUI` the live gadget uses, so it loads and behaves as the gadget does for Phillip, and
    the explore card floats over its top once the view's owner and time are known.
13. The copy's controls work. Tabs, filters, and whatever else the UI does run against the
    copied storage; only what the gadget would read through a binding is missing, and the
    agent is prompted to make that read as "nothing new", never as an error screen.
14. Dismissing the card collapses it into the header chip ("A snapshot of what Phillip sees"),
    and the chip brings it back, so the invitation stays discoverable without covering content.
17. In the explore dialog, source rows resolve top to bottom with a 300ms stagger even when
    results arrive together, so each outcome can be read; the stagger never adds more than 600ms
    over real latency. The spinner respects `prefers-reduced-motion` (static dot).
18. When a silent re-check passes (Bob was granted access since his last visit), he lands on
    live data with a one-time toast, "You can now explore this yourself", rather than the app
    silently behaving differently than last time.
19. The "Live data" chip's dot pulses for one cycle on the transition from view to live, then
    rests. Nothing on screen animates forever.
20. The export menu is hidden, not disabled, for view sessions; there is no dead control. The
    view iframe carries `title="Phillip's view of Workers Paid billing, as of Nov 6, 10:42"` so
    assistive tech knows it is a still, and the explore card is a single button whose accessible
    name joins its title and subtitle.

### One PR, in reviewable commits

One PR end to end, since every piece is inert without the others. Commits are grouped so the
kernel (`workshop-backend`, `workshop-shared`) can be read apart from the UI, per `AGENTS.md`.
Each commit type-checks and passes its own tests.

1. **API.** `workshop-shared`: `GadgetAccessMode`, `GadgetView`, `GadgetClient.getAccessMode()`
   / `getView()`, `CollaboratorInfo.lastOpened`, `GadgetSummary.viewTakenAt`,
   `WorkspaceMetadata.sharedViewsAvailable`, `AdminConfig.sharedViews`,
   `AdminApi.setSharedViews()`. Every member doc-commented. Existing implementations compile by
   returning `"live"` / throwing, so this commit changes no behavior.
2. **Kernel: view store.** `ViewRecord` typed-storage collection, the view facet and its clone
   on owner `connectToGadget()` (only when the gadget has a `use` collaborator and the admin
   policy is on), the `viewPublished` action-log
   record with requirement keys, `viewTakenAt` in `subscribeToWorkpieces()`, deletion when the
   publisher loses `build`. Admin setting storage and `setSharedViews()`.
3. **Kernel: admission.** `ViewGadgetClientInterface`; `authorizeGadget()` returns
   `"live" | "view" | false`; `UseOverseerInterface.getGadget()` hands out the view class on a
   verification failure when a record exists, the policy is on, and (under `ownerInvitesOnly`)
   the collaborator holds an owner edge; `getAccessMode()` on both restricted classes;
   `lastOpened` recorded on each admission and returned by `listCollaborators()`.
4. **Kernel tests.** `overseer` unit tests for each admission outcome (unverifiable → view;
   verified → live; removed → refusal; policy off → today's throw; no record → today's throw;
   `ownerInvitesOnly` link-joiner → refusal). Integration test in `packages/integration-tests`
   over the fixture gatekeeper: owner opens → the copy holds what the gadget stored, has no
   bindings, and the record exists; a second account with the fixture's verification set to deny gets `"view"`,
   flipped to allow gets `"live"` on its next `getGadget()` with no callback invoked.
5. **Frontend: Bob's side.** `GadgetUseView` branch, view iframe, explore card, restyled
   `ObserverConfigModal`, copy access request. Browser tests (`test:run:browser`) for the three
   Bob states and focus order through the explore dialog.
6. **Frontend: Phillip's side.** Share dialog, What people see, status lines, admin switch.
   Component tests for the dialog in both `sharedViewsAvailable` states.
7. **Docs.** `docs/sharing.md` gains a "Shared views" section (admission outcome, storage,
   revocation, policy); `docs/observers.md` §6 edge case 4 and §10 "Direct contexts only" gain a
   pointer saying the view is the deliberate, audited form of the indirect disclosure they
   describe; `packages/workshop-backend/AGENTS.md` admin-settings list gains `sharedViews`; this
   plan is marked historical.

**End-to-end check before opening the PR**, against `pnpm dev-server` with `pnpm cf-os api`:
create two accounts; owner creates a gadget bound to the fixture gatekeeper, reads through it,
shares the gadget with the second account (`share-gadget`); open as the second account and
assert `getAccessMode() === "view"` and that `connectToGadget()` reaches a copy with the stored
value and no bindings; flip the fixture to allow and assert `"live"`; set `sharedViews` off as
admin and assert the open throws as on `main`. Then one pass in a live browser for the three
Bob states and screenshots for the PR.

## Deferred

- **Share the view only.** The one real reason to want it is cost: exploring runs on the owner's
  BigQuery connection and billing project. If owners ask for it, add a per-gadget "Let people
  with access explore" toggle in What people see, default on. Not a share-time choice.
- **Ask for a fresh view.** Needs a fixed notification template (`docs/notifications.md`).
- **Read-only copy.** Viewers can change the copy until the owner's next open overwrites it.
  Prevent writes if that ever confuses anyone (no cheap SQLite read-only mode exists in a DO).
- **Stored capabilities in the copy.** The clone carries any stub a gadget persisted. Scrub or
  refuse them before gadgets start persisting stubs.

## Decided

- **Default on.** The policy is "owner-published content, audited, admin-switchable, on by
  default", including for `containsRestrictedData` workspaces. The owner's share is the
  authorization; the audit record is the accountability.
- **A view is withdrawn only when the publisher loses the workspace**, not when their upstream
  data access changes. The view is what they saw at the time; it stays what they saw. Their next
  open copies whatever the gadget then holds, which replaces the view the same way any clone
  does.
- **Refresh debounce: one minute per gadget**, and only while the gadget has at least one `use`
  collaborator. A clone is a storage copy, cheap enough that the debounce exists to bound churn
  for connected viewers, not cost.
