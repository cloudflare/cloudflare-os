# Implementation Plan: Observer Tracking & Read-Through Sharing Permissions (Workshop side)

This is a historical implementation plan written about the observer enforcement mechanism. This
mechanism enforces that when you share a Gadget with someone, you are not giving them access to any
sensitive information that they did not have access to already.

Specifically:
- When Bob opens a Gadget that has been shared by Alice, Bob must specify a connected account of
  his own associated with each of the Gadget's Gatekeepers.
- Each Gatekeeper verifies that Bob's connected account has sufficient privileges to directly read
  all information that the Gadget has historically read through the Gatekeeper. If not, Bob is
  denied access to the Gadget.
- If the checks pass, Bob is registered as an "observer" of the Gadget, recording his connected
  accounts.
- Going forward, if the Gadget makes any new observation through a Gatekeeper which at least one
  registered observer lacks privileges to make directly, then that observation is blocked, throwing
  an exception. Alice can optionally resolve the problem by revoking Bob's access.
- Bob's access is also re-checked every time he opens the gadget.

This document contains the original implementation plan for this mechanism, which was used to guide
AI in implementing it. This doc may become outdated over time.

(The above is human-written. The remainder of this document is largely AI-written.)

## 1. Introduction & high-level intent

Gadgets enforce a core security invariant (see `overview.md` §"Security Model"):

> If a Gadget can read information that has restricted access, then any user who is not
> able to read that information will also be prohibited from interacting with the Gadget,
> to prevent data leaks.

The mechanism is a per-user, gatekeeper-mediated check — "this data may be shared, but only with
people who *also* have access to it". (Maximally sensitive data gets an extra layer: an
observation marked **`containsRestrictedData`**
(`ObservationDescription.containsRestrictedData` in `packages/workshop-shared/src/gatekeeper.ts`)
puts the workspace into a restricted mode — no web fetches, and every action requires manual
approval (auto-approval rules are suspended), the approver checking the action text for restricted
data. An action whose description is not complete (`ActionDescription.descriptionIsComplete`)
is accepted and flagged to the approver; only git pushes are refused. Its coverage rests on admission: nobody can open the workspace without being verified
against the producing gatekeeper, and anything that widens what they must be verified against
restarts every live session. An observation that also carries **`ownerInvitesOnly`** sets that
flag on the workspace: from then on only direct grants from the owner count, so share links admit
nobody, people who joined through a link or another collaborator lose access, and only the owner
can add collaborators; see `sharing.md`, "`ownerInvitesOnly`".)

The check works as follows:

- **Observers.** Every non-owner who can see data the Gadget read is an *observer*. When a user
  becomes an observer, each relevant gatekeeper is asked — via `Gatekeeper.addObserver()` — to
  verify that this specific person is allowed to directly observe everything the Gadget has
  already read through that gatekeeper. The gatekeeper is the authority on its own resource's
  ACL, so the check runs inside the gatekeeper's trust domain.

- **Verifiers.** The overseer cannot itself reason about a vendor's identity/ACL model. Instead,
  the prospective observer's *own connected account* mints an opaque `GatekeeperUserVerifier`
  (via `GatekeeperUser.getVerifier()`), which the overseer hands back to the gatekeeper. The
  gatekeeper "unwraps" it (today, by calling semi-private methods it defined on its own verifier
  object) to learn the observer's vendor-level identity and check access.

- **Forward exclusion.** For observations made *after* a user becomes an observer, the gatekeeper
  can name observers who must not see a given observation via
  `ObservationDescription.excludeObservers`. The overseer must then guarantee those observers
  never see it, or block the observation.

**The API is already committed.** The relevant interfaces are
`GatekeeperUser.getVerifier()`, `GatekeeperUserVerifier`, `Gatekeeper.addObserver()` /
`removeObserver()`, and `ObservationDescription.excludeObservers`, all in
`packages/workshop-shared/src/gatekeeper.ts`.

### v1 scope decisions (agreed)

- **No per-thread enforcement.** v1 is all-or-nothing per observer. We do not (yet) hide
  individual chat threads or observations from individual collaborators.
- **Grant-based breadth of verification:**
  - **`build`** collaborators (full access — chat + code + all bindings) must be verified
    against **every** gatekeeper the Gadget has, when they open the workspace.
  - **`use`** collaborators (UI only, no chat access — see `UseOverseerInterface` in
    `overseer.ts`) hold individual gadgets and are verified **one gadget at a time**, when they
    get it (`UseOverseerInterface.getGadget` → `authorizeGadget`), only against gatekeepers a
    session holding that gadget can actually reach: those **the gadget binds** (its UI can invoke
    them), those with **an enabled hook waking it** (a hook is a live write channel into the
    gadget it wakes, delivering the connection's data regardless of binding edges; that gadget is
    the one `bindHook` recorded, trusted as it is for the firing's attribution (§10), and a hook
    recording none counts as waking every gadget), plus — transitively —
    every **binding target of an agent spawner it binds**, including another gadget the spawner
    binds (spawning is reachable from the gadget UI, and the spawned agent reads the env's
    connections with the spawner creator's authority), plus every connection through which any
    of those gadgets recorded requirements (§10). See `#gadgetReach`. Opening the workspace shell
    verifies nothing, since it shows nothing a gadget read. Failing to verify
    for one gadget never affects another the collaborator holds. A collaborator who still holds
    a legacy workspace-wide `use` grant (docs/sharing.md) holds every gadget, but is verified the
    same way, for each gadget they get.
- **Account selection.** A collaborator must have their own connected account for each vendor the
  Gadget depends on. For ordinary bindings, they choose which account to use (e.g. work or personal
  Google). If an account cannot be selected automatically, the configuration modal prompts them to
  choose or connect one; declining denies the open. Ambient bindings are the exception to account
  *selection*, not verification: when the collaborator already has the matching provided singleton
  account, the overseer uses it automatically and still runs the gatekeeper's normal `addObserver`
  check.
- **Authorization is keyed on the sharing table, not on live sessions.** Because a Gadget may
  *store* observed data and re-display it later (even to a `use` observer who opens much later),
  every exclusion/enforcement decision keys off whether a user is still *authorized* in the
  sharing graph (`computeEffectiveAccess`), and for a gadget, whether their access includes a
  gadget that reaches it -- never off whether they currently have it open.

---

## 2. Background: relevant existing code

| Concern | Location |
|---|---|
| Gatekeeper RPC API (the committed surface) | `packages/workshop-shared/src/gatekeeper.ts` |
| Overseer DO, `open()` auth entry point | `packages/workshop-backend/src/overseer.ts` |
| Authorization gate shared by `open()` and `receiveExternalMessage()` | `overseer.ts` `authorizeCollaborator()` |
| Session restart when verification scope widens | `overseer.ts` (`#restartIfSessionsAffected`, `joinSession`, `scheduleAccessRestart`) |
| Server `openWorkspace` path | `packages/workshop-backend/src/server.ts` |
| Access resolution / permission graph | `packages/workshop-backend/src/sharing.ts` (`getEffectiveAccess`, `computeEffectiveAccess`) |
| `containsRestrictedData` enforcement | `overseer.ts` (`authorizeObservation` sets `containsRestrictedData`; `getWebFetchEnv`, `submitAction`) |
| `ownerInvitesOnly` enforcement | `overseer.ts` (`authorizeObservation` sets `ownerInvitesOnly` and restarts the workspace if anyone lost access); `sharing.ts` (`computeEffectiveAccess` counts only direct owner grants; the `ownerInvitesOnly` hook in `redeemShareKey`, `addCollaborator`, `createShareLink`, `newShareLinkKey`) |
| Observation recording | `overseer.ts` `authorizeObservation()`; `ApprovalQueueImpl` |
| Gatekeeper storage record | `overseer-storage.ts` `GatekeeperRecord` (has `creationSpec.vendorId`) |
| `GatekeeperCreationSpec` | `packages/workshop-shared/src/api.ts` |
| Gatekeeper facet access | `overseer.ts` `getGatekeeperFacet()` |
| Overseer storage collections | `overseer-storage.ts` (`gatekeepers`, with `byBindingName` index — template for a new collection) |
| Connected accounts (User DO) | `packages/workshop-backend/src/storage-schema/user-storage.ts` `ConnectedAccountRecord` (`account: Fetcher<GatekeeperUser>`, `vendorId`) |
| List connected accounts | `user.ts` `subscribeConnectedAccounts()`; subscriber type in `api.ts` |
| Account → gatekeeper class | `user.ts` `getGatekeeperClassFor()` |

---

## 3. Concepts & terminology

- **Observer:** a non-owner collaborator (any role) who can see data the Gadget has read.
- **Sharing table:** the existing `collaborators` / `shareKeys` storage + permission graph
  (`sharing.ts`). Records the owner's **intent** that a user have access.
- **Observer record (new):** overseer storage describing a user who has **configured their
  gatekeeper accounts and passed all `addObserver` checks** — i.e. is actually set up to observe.
  This is distinct from the sharing table: intent vs. configured-and-verified. Opening requires
  **both** (reachable in the sharing graph AND a valid, complete observer record).
- **Observer ID:** a **random, opaque** string the overseer generates when it first creates an
  observer record, and stores in that record. It is passed to gatekeepers as the stable handle
  for this observer. We deliberately do **not** use `profile.id` (usually an email), to avoid
  tempting gatekeeper authors to parse identity out of it — identity is conveyed only via the
  verifier. The ID need not survive removal/re-add: a user who loses and regains access gets a
  fresh record and a fresh ID.
- **Verifier:** `Fetcher<GatekeeperUserVerifier>` minted by the *observer's own*
  `GatekeeperUser` (a specific connected account they chose). A persistent service stub — no
  disposal required.
- **Invariant maintained:** for every user authorized in the sharing graph and every gatekeeper
  in scope for their role, the gatekeeper has confirmed (at the user's last open) that the user
  may observe everything read so far, AND no later observation has been allowed that the user may
  not see.

---

## 4. Data model changes

### New overseer storage collection: `observers`

Add an `observers` collection to `OverseerStorage` (mirror the `gatekeepers` collection in
`overseer-storage.ts`, including a secondary index for reverse lookup):

```ts
type ObserverRecord = {
  // The sharing-table key for this user. Primary key of the collection.
  profileId: string;

  // Random, opaque, stable-for-this-record handle passed to gatekeepers.
  observerId: string;

  // The account the user chose to satisfy each in-scope gatekeeper binding.
  // Keyed by gatekeeper id (GatekeeperRecord.id). The accountId refers to a
  // ConnectedAccountRecord in THIS user's own User DO.
  accountChoices: { [gatekeeperId: number]: number };
};
```

- Primary index: `profileId` (open path looks up by the connecting user's profile).
- Secondary index: `byObserverId` (the `excludeObservers` path maps an opaque id back to a
  profile — see Step 5).

No change is required to `GatekeeperRecord`; vendor matching uses the existing
`creationSpec.vendorId`. Gatekeeper-internal observer bookkeeping (e.g. BigQuery's accessed-table
log) lives inside each gatekeeper's own DO and is out of scope here.

---

## 5. Work breakdown

### Step 1 — User DO: mint a verifier for a chosen account

Add a method to the User DO (`packages/workshop-backend/src/user.ts`), near
`getGatekeeperClassFor`:

```ts
// Mint a verifier from one of THIS user's connected accounts, identified by accountId.
// Returns null if the account is missing. Throws if it belongs to a different vendor.
async getVerifier(
  accountId: number,
  expectedVendorId: string,
): Promise<Fetcher<GatekeeperUserVerifier> | null>
```

Implementation: look up `this.storage.connectedAccounts.get(accountId)` and compare its stored
vendor with `expectedVendorId` (exact match) before returning `account.account.getVerifier()`.
Account selection is done by the frontend, but this server-side check must not trust that filtering
(see Step 3). A missing account returns null (re-prompt); a vendor mismatch throws (not a
legitimate UI state).

> Promise pipelining: callers can pass the returned promise straight into `addObserver()` without
> awaiting it (see the Cap'n Web note in `AGENTS.md`). The observer-open path awaits it because a
> null result means the account must be re-selected before calling `addObserver()`.

### Step 2 — Client-server API: a configuration callback on `open` / `openWorkspace`

We must avoid structured/typed errors for control flow (prohibited in this codebase) and must not
break promise pipelining in the common case. So `open()` gains an **optional callback** that is
invoked **only** when the opening user needs to configure gatekeeper accounts. In the common case
(owner, or an already-configured observer) the callback is never called, and `open()` resolves
without an extra round trip.

Add to the RPC API (`packages/workshop-shared/src/api.ts`) and thread through
`server.ts` `openWorkspace` → `overseer.open()`:

```ts
// Provided by the client when opening a gadget. Invoked by the overseer only if the opening
// user must choose connected accounts for one or more gatekeeper bindings before they can
// observe the gadget. The overseer does not resolve open() until this returns.
interface ObserverConfigCallback extends RpcTarget {
  configure(needs: ObserverBindingNeed[]): Promise<ObserverAccountChoice[]>;
}

type ObserverBindingNeed = {
  gatekeeperId: number;
  vendorId: string;
  resourceTitle: string;
  resourceUrl?: string;
};

type ObserverAccountChoice = {
  gatekeeperId: number;
  accountId: number;   // an account in the opening user's own User DO
};
```

`open()` signature gains `configureObservers?: RpcStub<ObserverConfigCallback>`.

(Same goes for `openWorkspace()`, which is the public-facing API method on `AuthenticatedApi`.)

### Step 3 — Overseer: observer configuration & re-verification at `open()`

Hook into `open()` in the non-owner branch, after `effectiveRole` is confirmed and before
constructing the client interface. (Observer verification *is* the open()-time enforcement for
sensitive data; no `containsRestrictedData` check precedes it.)
The `NeedsConnections` signal is produced only *after* a valid role is
confirmed, so it never reveals a workspace's gatekeeper or resource metadata to an unauthorized
user.

Role resolution plus verification is one shared gate, `OverseerImpl.authorizeCollaborator`, and
every non-owner entry point that can surface workspace data runs it — `open()` interactively, and
`receiveExternalMessage()` non-interactively (no configuration channel, so an unverified caller is
told to open the workspace, which is where verification happens). An agent reply on the external
path can surface anything the workspace already read, so it must not admit a collaborator with
less verification than `open()` would demand.

Add a private helper on `OverseerImpl`, roughly:

```ts
// Bring `profileId` (a non-owner) into compliance as an observer for their `role`.
// May invoke `configureCb` to ask the user to choose accounts for not-yet-configured bindings.
// Re-verifies (re-runs addObserver) for already-configured bindings on every open.
// Returns when the user is fully verified; throws to deny access.
async ensureObserver(
    profileId: string,
    clientUser: Fetcher<User>,
    role: CollaboratorRole,
    configureCb?: RpcStub<ObserverConfigCallback>): Promise<void>
```

Logic:

1. **Select in-scope gatekeepers** from `this.storage.gatekeepers.list()`:
   - `build`: all gatekeepers.
   - one gadget (a `use` collaborator's `getGadget`): only those the gadget reaches —
     its bindings, the connection of every enabled hook waking it (or naming no gadget), and
     transitively its agent spawners' bindings — and
     connections a reached gadget recorded requirements through (`#gadgetReach`,
     `#enabledHookConnections`, `ObserverLedger.gadgetProducers` — a hook recorded for a
     still-provisional gadget reaches nothing until promotion; the merge diff reports that
     widening).
   - A `creationSpec` with a `vendorId` requires an account; other specs need no verifier or account
     choice.

2. **Load the observer record** for `profileId` (may be absent) and build a working copy of its
   `accountChoices`. An out-of-scope entry is simply not consulted: nothing is verified against a
   gatekeeper outside what is being opened, so the choice sits there unread until the connection
   is back in scope (or another gadget reaches it) and the entry saves the collaborator from being
   asked again. A choice is never proof of verification: every open re-checks.

3. **Determine uncovered bindings**: in-scope account-requiring gatekeepers with no
   `accountChoices` entry in the record. Before prompting, automatically fill ambient bindings from
   the collaborator's matching provided singleton accounts. Ordinary bindings, missing ambient
   accounts, and bindings being re-prompted after a failed verification remain uncovered.

4. **If there are uncovered bindings**, invoke `configureCb.configure(needs)` with one
   `ObserverBindingNeed` per uncovered binding. If `configureCb` is absent (e.g. a non-interactive
   open), deny. Merge the returned `ObserverAccountChoice[]` into a working copy of the record's
   `accountChoices`.

5. **Re-verify all in-scope bindings** (covered + newly chosen). For each, resolve the chosen
   account's verifier via `clientUser.getVerifier(accountId, bindingVendorId)` and call
   `this.getGatekeeperFacet(gk.id).addObserver(record.observerId, verifier)`. Generate
   `observerId` (random) if the record is new. Run these with `Promise.all` + pipelining where
   possible.
   - The User DO compares `bindingVendorId` with the chosen connected account's stored vendor and
     **throws** on a mismatch. This server-side check is what guarantees a gatekeeper only receives
     a verifier minted by its own vendor; filtering account choices in the client is only a
     user-interface convenience.
   - If any `addObserver` **throws** (or `getVerifier` throws on vendor mismatch, or returns null
     for a disconnected account), the user is not (or no longer) allowed. Every such failure goes
     through one `fail()` path, and the user is offered a bounded number of re-prompts to repair
     (e.g. re-authenticate an expired account). On terminal failure the open is denied with a
     message naming each refused binding, and the registrations this call added are
     best-effort-removed while no record is persisted. The persisted `accountChoices` are left as
     they are: an entry records the choice the user made so they are not asked again, and asserts
     nothing about whether the gatekeeper still admits them.
   - Only a *first-ever* verification rolls anything back (fully — nothing referenced its
     registrations before the call, and the minted id would otherwise linger unresolvable). A
     returning observer's registrations are **all** kept, including ones this call added: their
     persisted `observerId` is shared with concurrent opens, so a rollback could delete a
     registration a concurrent successful open just made and persisted. De-registering is the
     fail-open direction (the gatekeeper stops naming them in `excludeObservers`); a spurious
     registration only blocks fail-closed until the lazy cleanup at exclusion time or a later
     open re-verifies it, and the next successful `addObserver` overwrites its verifier.
   - A denial ends only this open. Sessions the collaborator already holds are untouched, and keep
     the access their own opens verified until they next re-open — the lazy-revocation residual
     described under "Known gaps" below.

6. **Persist the observer record** (with merged `accountChoices` and `observerId`) only after all
   `addObserver` calls succeed. Storing/creating the record is the canonical moment the user
   becomes a configured observer; its later deletion is what triggers `removeObserver` (Steps 5
   and 6).

Then in `open()`:

```ts
await this.impl.ensureObserver(profileId, clientUser, role, configureObservers);
```

Notes:
- **Re-verification every open is intentional.** It catches revocation of the user's underlying
  resource access promptly (caught at their next open). Gatekeepers for which re-running
  `addObserver` on every open is expensive should implement their own caching strategy — it is up
  to each gatekeeper to choose the right tradeoff between performance and immediacy of revocation.
- Re-verification of already-covered bindings does **not** pop the modal; it silently reuses the
  stored account choices. The modal is only for genuinely uncovered bindings (first open, a binding
  the owner added after this user last configured, or an ambient binding without a matching provided
  account).

#### Restarting when verification scope widens

Per-connection verification runs only at `open()` and `getGadget()` (only reads that report
`subresources` are also checked as they happen, see §10), so a live session is only ever as verified
as the scope that existed when it opened. When that scope **widens**, the overseer restarts the
workspace rather than trying to re-verify sessions in place: `#restartIfSessionsAffected` delegates
to `scheduleAccessRestart(reason)` — the same DO abort used to revoke a
collaborator (see `docs/sharing.md`) — so every client's browser reconnects and re-runs
`authorizeCollaborator`/`ensureObserver` against the new scope.

What it gates on is a **live session** holding the affected scope, not an entry in the sharing
table: severing sessions is all a restart achieves, so a collaborator who isn't connected has
nothing to cut, and a solo workspace is never disturbed. `OverseerImpl.joinSession` counts them
by role and, for `use`, by gadget, called synchronously in each client interface's constructor
and released in its `[Symbol.dispose]`; the owner is counted apart because the owner is never an observer.
Being synchronous is the point: the check can neither be skipped by a failed lookup nor land some
unbounded time after the change. The count is deliberately not derived from `#presence`, which a
session joins only once its `fetchProfile()` resolves — fine for a roster, fail-open for an access
decision.

The count covers everything the *overseer* mints into a collaborator session, not just the
top-level interfaces — anything that escaped it would let a widening find no session to sever.
Capabilities a *gadget* mints (an `RpcTarget` returned by a gadget method through the facet
proxy's method wrapper, re-exported to the client as an independently owned stub the overseer
never sees disposed) are structurally outside the count and are covered only by the facet abort
`bumpVersion` performs, which destroys the facet actor and every stub into it — root and
gadget-minted children alike:

- **Capabilities minted into a session** (`GadgetClientImpl`, `UseGadgetClientInterface`,
  `GatekeeperClientImpl`) each count for their own lifetime, since a client can dispose the parent
  interface while retaining a child stub. They join when minted for a collaborator (the
  constructor's `joinedAs` / `addGatekeeper`'s `joinAs`) and skip it for the owner's mints and
  internal construction. A `UseGadgetClientInterface` counts as a session holding its gadget. The
  raw gadget facet stub `connectToGadget()` returns counts the same way (`getGadgetFacet`'s
  `joinAs`, released when the stub is disposed, and for a `use` session counted for that gadget):
  it is the very stub an
  enabled hook's data flows through, and unlike a bind — which aborts gadget facets via
  `bumpVersion` — enabling a hook leaves existing facets running, so an uncounted retained facet
  would let that widening find no session to sever.
- **Known gap — `enableHook` neither counts nor aborts gadget-minted children.** The facet-stub
  lease above covers only the stub the overseer minted; a gadget-minted child is independently
  owned (see the preamble) and reachable only by the facet abort — which every binding mutation
  performs and hook enable, alone among the widenings, does not. A client that disposes its
  counted wrappers but retains a gadget-minted child therefore leaves that gadget's count 0 when a hook
  is enabled: no restart, no quarantine mark, and the retained child keeps reading the gadget
  state the now-live hook writes into, under stale verification. Reachable only when the gadget's
  own code returns such a stub to its caller and the client deliberately drops its wrappers; the
  required fix is an unconditional `bumpVersion([gadgetId])` in `enableHookRecord` — not gated on
  whether a restart fired, since the uncounted-child case is exactly the one where none does. (A
  retained `env.GADGET` loopback is the same shape via a route the abort cannot reach — it
  re-resolves the facet per call — and would additionally need a per-gadget generation stamp or
  per-call role authorization of facet access; the global `codeVersion` cannot serve, since
  bumping it for one gadget invalidates every gadget's loopbacks.)
- **Subscriptions** (`subscribeToMetadata`/`Presence`/`Workpieces`/`Actions`/`Chat`/`ConsoleLogs`,
  on both client interfaces, including the `use` interface's inert ones) are exports minted into
  the session like any other: a client can dispose the interface while a retained chat or action
  subscription keeps streaming gatekeeper-derived data. Each is wrapped in a handle that holds a
  lease for its own lifetime (`#subscriptionLease`); the owner's subscriptions pass through
  uncounted.
- **In-flight authorization** counts as a session-to-be: `authorizeCollaborator` holds a `build`
  lease across `ensureObserver`, and `authorizeGadget` a lease holding the gadget being verified;
  either can park indefinitely on collaborator-controlled awaits (the configuration modal,
  verifier RPCs). A widening then schedules the restart, the DO reset takes the parked open with
  it, and the client retries against the new scope. Between the lease's release and `open()` (or
  `getGadget()`) constructing the counted interface there are only microtask continuations, in
  which no incoming event can be delivered, so nothing can observe the count dip to zero across
  the handoff.
- **`receiveExternalMessage`** holds a `build` lease for a non-owner caller from the moment
  `authorizeCollaborator` admits them until the call completes, since it produces a reply from
  workspace data without ever constructing a counted interface. The lease deliberately starts
  only after authorization (verification itself is covered by `authorizeCollaborator`'s internal
  lease): a caller who is turned away must never have counted, or a stranger racing an
  `addGatekeeper()` would cause a needless workspace reset.
- **Resumed person-initiated turns** re-run `authorizeCollaborator` with `requireBuild`
  for the original non-owner initiator before inference, and hold a `build` lease through the
  resumed turn. This applies after a DO reset and after a decision pause. Denial ends the turn
  with an error; a later approver cannot lend it their authority.
- **Known gap — a freshly started external-message turn** outlives that RPC's lease because it
  is fire-and-forget. Before its first reset or decision pause, a widening can therefore find
  no session to sever, and its reply can egress to the persisted external response target under
  stale verification. The resumed path above is covered, but the initial run still needs its
  own per-turn `build` lease before `receiveExternalMessage` gets real callers. No extra durable
  marker is needed for that resume check: the existing `ActiveAgentRecord` retains the original
  initiator. Owner and UI-collaborator turns are not affected by this external-egress gap: the
  owner is never an observer, and a UI collaborator reads replies through re-verified opens.

  The same mechanism has a spawner variant: a `use` collaborator holding a bound spawner's
  loopback can start a spawn during the window between a connection widening's restart being
  scheduled and the reset landing (the widening blocks the newly reached connection, not the
  vendorless spawner, which nobody is verified against). The spawn persists an
  `ActiveAgentRecord` that the reset's storage sync commits. Its initiator is a gadget, so the
  person-initiated resume check above does not apply: it can complete with its creator's
  authority against the pre-widening scope. (A widening that exposes a *gadget* through a
  spawner does block that spawner, and its queue refuses to spawn while blocked, so this variant
  is limited to newly reached connections.)
  Bounded, unlike the external-message case:
  the resumed turn has no external egress, its output lands in workspace state, and every
  `use`-role reader of that state re-verifies at their next open against the now-widened scope —
  so the only unverified consumption is inside the restart's own delivery window, which the
  design already tolerates for sessions the reset is about to sever. Closing this variant still
  needs lifecycle authorization for gadget-authored turns; re-checking person-initiated resumes
  alone does not cover it.

Five events trigger it:

| Event | What grows |
|---|---|
| `addGatekeeper()` with a vendor-backed `creationSpec` | **build** scope — a live `build` session can `getGatekeeperById()`/`openSession()` on it with no observer check |
| `bindWorkpiece()` for a permanent (non-`chatId`) edge onto a vendor-backed connection — or onto a legacy (pre-`creationSpec`) one, which nobody *can* be verified against, so it restarts and quarantines and fresh gadget opens then fail closed on the reconnect-required error — or onto an agent spawner that binds a gadget the binding gadget did not reach | that gadget's scope, and the scope of every gadget whose agent spawners reach it — the gadget UI a session holding it drives can now invoke the connection, or drive the newly reached gadget, whose recorded history its holders were never verified against |
| A merge that promotes a pending binding edge, or a pending gadget's bindings, into a permanent gadget's reach — or promotes the gadget an enabled hook was recorded for | those gadgets' scopes, same reason (a newly promoted gadget's own scope widens too, but nobody can have opened it yet, so it severs nobody); a promoted hook gadget makes the hook live, widening the scopes that reach that gadget, as `enableHook` does |
| `enableHook` on a vendor-backed connection the hook's gadget does not already reach | that gadget's scope (and its spawner readers') — the hook delivers the connection's data into the gadget it wakes, which is `BoundHookRecord.gadgetId` (or `defaultGadgetId`), trusted as it is for the firing's attribution (§10); a hook naming no gadget counts as waking every gadget, and one recorded for a still-provisional gadget reaches nothing until promotion (the merge diff reports that widening) |
| Approving a creation queued by the agent's `createExternalResource` | every role's scope — the connection was published without a restart because until now it only simulated its resource, so nobody was verified against the real one. The restart is unconditional on role, since the connection may already be bound |

Scopes widen independently, so each trigger passes what it grew and the restart
is skipped when no live collaborator session holds it: a new connection is in every `build`
collaborator's scope at once but in no gadget's until one binds it, and binding one to gadget A
enters A's scope (having been in `build` scope since it was created) but not gadget B's. Sessions
are counted per gadget (`joinSession("use", gadgetId)`, held by each `UseGadgetClientInterface`,
its facet stubs, and in-flight `authorizeGadget` calls), so a session holding only B is not severed
when A widens, and a `use` workspace shell, which holds no gadget, is never severed by a gadget's
widening.

The three gadget-scope triggers share one helper (`#restartIfGadgetScopesWidened`) that compares
what each gadget reaches before and after rather than firing on any mutation: most merges promote
something, and a promoted gadget with no bindings, an edge onto a vendorless connection nobody is
verified against, a second name onto a connection the gadget already reaches, or a hook on an
already-bound connection all widen nothing and must not sever a shared workspace for nothing.
Because the comparison is per gadget, binding to A a connection B already reaches still widens A.
Two things widen a gadget: an account-requiring connection it newly reaches, and a gadget it newly
reaches through an agent spawner. The second widens it even when no connection is new, because
admission to A also checks the recorded history of every gadget A reaches, and the
connections that history was read through (`#observerScope`): with A and B both reporting
subresources through connection C, a spawner exposing B to A adds no connection, but adds B's
subresources on C, and on any connection B read through before and has since unbound.

Shrinking scope needs no restart (`unbindWorkpiece`, `removeGatekeeper`, `disableHook`,
`deleteHook`): a narrower scope can never under-verify a session admitted at the wider one. That
rule is about *sessions* — the capabilities a hook firing was already issued (`startHook`'s
callback and approval queue) are held outside the DO, in other DOs and across resets, and would
otherwise outlive a shrink un-revoked. So `startHook` returns a per-firing wrapper over the stored
persistent callback and a queue that both re-check the hook record on every call
(`requireLiveHook`), implementing the session contract documented on `Gatekeeper.bindHook`: the
record flip is an authoritative kill even for firings already handed out, and a delivery racing a
disable throws.
(`removeGatekeeper` also synchronously deletes the connection's hook records — the authoritative
kill, since `startHook` re-checks the record before every delivery — and fires the gatekeeper-side
disables best-effort rather than awaiting them, so a hung gatekeeper can't keep an orphaned hook
delivering. The hook state flips guard that kill against their own gatekeeper round trips, whose
awaits leave the input gate open: `enableHookRecord` re-reads the hook and its connection after
`controller.enable()` resolves — refusing, with a best-effort compensating disable, when either
was deleted meanwhile, since re-putting the captured record would resurrect an enabled hook the
widening detector can't even see — and `disableHook` likewise re-reads rather than re-putting a
deleted record back as a zombie.) Role *rises* (`addCollaborator`, share-key redemption) are
deliberately not triggers
either — a live session's capability set is fixed at open, so raising someone's graph role does
not widen the session they already hold.

The restart is what makes `addGatekeeper()`'s publication order load-bearing. The DO's input gate
is open across the gatekeeper's `describe()` and ids are allocated sequentially, so publishing the
record before that await would let a live `build` session guess the id and `openSession()` on the
owner's brand-new connection — which gates on nothing but record existence — for as long as
`describe()` took, all of it before the restart severed it. The record is therefore published
exactly once, after `describe()` resolves; `getGatekeeperFacet(id, cls?)` takes the class directly
so nothing needs the early put.

The reset itself lands only after a ~100 ms response-delivery delay, and the widening write must
be durable before it (or the change is lost with the restart) — so when a restart was actually
scheduled, every trigger additionally marks the widened connection ids in the in-memory
`#gatekeepersPendingRestart` set: `addGatekeeper` marks the just-published id, and the three
gadget-scope triggers mark each connection their diff widened, plus every spawner on the route to
a newly reached gadget (a spawner's queue checks the mark before it starts an agent, so a spawner
session opened before the mark spawns nothing while it stands). Marking gatekeeper ids suffices as
quarantine because a binding loopback is not a session but a per-call route: its props name the
target and every call re-resolves a session through `openGatekeeperSession`, where the mark is checked —
so the quarantine holds even for a loopback retained across a facet abort or the reset itself,
which is *not* merely "re-minted on facet reload"). Every route to a marked connection refuses with a retryable error until
the reset destroys the mark along with the sessions: `getGatekeeperById` (the mint clients
pipeline on), `openGatekeeperSession` (which client opens and binding loopbacks both pass through), the
slash-command invoke in `#prepareChatMessage`, `GadgetClientImpl.bindWithSuggestedName`, and
`startHook` — the inbound gatekeeper→gadget delivery route, whose arming enable may itself be the
widening that scheduled the restart — while the enumerating routes (`listSlashCommands`, the
ambient catalog load and seed materialization in `prepareChatBindings`) silently omit it until
clients reconnect. Publish,
restart-check, and mark share one synchronous block, so no request can interleave between the
change appearing and the block taking effect; marks are only ever set when a restart is
scheduled, since nothing else would clear them.

Enforcement is therefore at admission, within the ~100 ms abort delay of the moment the change is
determined — the change itself, for every trigger — and held to what the collaborator opened
(edge case 4 below).

### Step 4 — Frontend: the configuration modal

Implement the `ObserverConfigCallback` on the client. When the overseer calls `configure(needs)`:

1. For each `ObserverBindingNeed`, find the user's candidate accounts by filtering the existing
   `subscribeConnectedAccounts()` results by `need.vendorId`.
2. If one or more accounts match, pre-select one arbitrarily as the default; let the user change
   it via a dropdown. (Most users have one account per vendor and will just click "OK".)
3. Include forced auto-provisioned accounts in the subscription. If **no** account matches, use
   `listAddableGatekeepers()` to identify optional auto-provisioning vendors and provision those
   directly; otherwise use the existing `connectAccount` flow. Then include the new account as the
   choice.
4. Resolve `configure()` with one `ObserverAccountChoice` per binding. If the user cancels / can't
   provide an account, reject (the overseer denies the open and the UI shows an access-denied
   state).

Messaging: "To open this Gadget, choose which of your «Vendor» accounts to use, so we can confirm
you're allowed to see the data it uses."

### Step 5 — Overseer: forward exclusion in `authorizeObservation()`

Extend `authorizeObservation()` (in `overseer.ts`) to honor `description.excludeObservers`.
Because v1 has no per-thread hiding, an excluded-but-named observation can only proceed when the
named observer cannot reach it at all: either they have *already lost access* in the sharing graph,
or the connection that produced it has left their access's verification scope.

For each id in `description.excludeObservers`:

1. Map the opaque `observerId` → `profileId` via the `observers.byObserverId` index. If there is
   no record, the id is not an active observer → ignore it.
   **Known gap: "no record" does not yet imply "not an active observer".** A first-time
   `ensureObserver` registers a freshly minted id with the gatekeepers *before* the record (and
   so `byObserverId`) is persisted, so an id named during that window — the fan-out, which can
   park on the config modal — reads as unknown here and the observation is admitted to the very
   collaborator it names. The required fix is an in-memory map of pending ids consulted here,
   failing closed; it lands with `observer-verification-fixes`.
2. Check sharing-graph reachability for that `profileId`
   (`SharingManager.getEffectiveAccess` / `computeEffectiveAccess`).
   - **Still authorized, and the producing gatekeeper is still in that access's scope → throw**,
     blocking the observation (degrade to per-observation lockdown). Use a clear message, e.g.:
     `"This observation was blocked because it contains data that a current collaborator is not permitted to see."`
   - **Still authorized, but the gatekeeper has left their scope → allow** for this observer, and
     drop their registration on *that gatekeeper only* (`removeObserver(observerId)`), keeping the
     record. The scope test is `#inAccessVerificationScope` and is deliberately narrow and
     fail-closed: the only way out is "access is `use`, the connection requires an account, and
     no gadget their access includes reaches it" (`#gadgetReach` — an enabled hook keeps writing
     the connection's data into a gadget the collaborator can open, and a bound spawner's env
     keeps handing it to agents the collaborator can spawn, so both block exactly as a binding
     does). The test spans every gadget their access includes, opened or not, because
     registrations and exclusions cover the connection rather than one gadget: an exclusion it
     names while gadget B reads still blocks if the collaborator holds gadget A and A reaches the
     connection too. Reported subresources (§10) are checked per gadget, but do not narrow an exclusion.
     This arm is the case a stale registration creates — a
     `use` collaborator's open never verifies (and so never re-registers or removes) a gatekeeper
     outside their scope, so an unbind leaves them named by a gatekeeper they can no longer reach.
     A rebind puts it back in scope and their next open registers them again.
     **Known gap: "left their scope" does not yet imply "cannot reach".** This classification
     derives reachability purely from stored graph state, but a binding loopback's props name the
     gatekeeper id — never the (gadget, binding) edge — and every call re-resolves a session
     without revalidating any edge, so a loopback retained across the unbind (returned by a
     gadget method to a browser client, persisted in the gadget's own facet storage, or parked in
     `agentCallbackArgs` and re-injected later) keeps opening sessions until `removeGatekeeper`.
     Unreachability is currently assumed rather than enforced; the required fix is a per-call
     edge check (`#assertBindingEdgeLive`, matching on binding *target* for gadget callers) in
     `startGatekeeperSession`'s gatekeeper branch, beside `openGatekeeperSession`'s quarantine check. Until
     it lands, this arm is fail-open twice over: the observation is admitted, and the
     de-registration stops the gatekeeper naming that observer in `excludeObservers` at all, so
     every later observation is admitted too — until a rebind plus a fresh open re-registers
     them.
   - **No longer authorized → allow** for this observer, and **delete their observer record**
     (and best-effort `removeObserver(observerId)` on all gatekeepers). They are no longer set up
     to observe; if they ever regain access they reconfigure from scratch (Step 3).
3. If, after evaluating all excluded ids, none can reach the observation, allow it. Every id is
   classified before anything is torn down, so a blocked observation leaves no teardown behind it;
   the removals are then all issued together and awaited with a single `Promise.all`. A fresh
   open's `addObserver` racing one of those `removeObserver` RPCs on the same (observer,
   gatekeeper) pair is ordered behind it (`#withObserverGatekeeperLock`; the overseer is the only
   caller of either, so ordering its own calls is sufficient), so a fresh registration is never
   silently undone. An observer put back in scope while the teardown is in flight — a bind plus a
   fresh open landing inside a removal's window — is admitted for this one observation; that is
   the same tolerance as the restart window (see "Restarting when verification scope widens").

This is the runtime counterpart of `addObserver`: `addObserver` covers observers configured
*after* data was read; `excludeObservers` covers data read *after* observers were configured.
Persisting the observation record itself is unchanged; we only gate it.

> Why not also worry about authorized-but-not-yet-configured users here? A user with no
> registration in flight cannot be named in `excludeObservers` because no gatekeeper knows their
> id yet. The invariant still holds from the other direction: when such a user later opens and
> configures, `addObserver` re-checks them against *all* past observations (including any
> restricted one) and throws, denying them. So forward exclusion only needs to handle
> already-configured observers — plus the one case in between: a user *mid*-registration is
> already known to every gatekeeper whose `addObserver` has returned, and can be named before
> their record exists. That is the Step 5 item 1 known gap above.

### Step 6 — Overseer: remove observers on sharing changes

When sharing changes, configured observers who lose access must be torn down. In the overseer
methods wrapping `SharingManager` mutations (`removeCollaborator`, `revokeShareLink`, and role
downgrades — see the matching methods on `OverseerClientInterface` and `SharingManager`):

- The **session-severing restart is scheduled first**, in the same synchronous step as the sharing
  mutation, and only then does the best-effort teardown below run: the teardown crosses gatekeeper
  and User-DO round trips that can stall or hang, and a revoked collaborator's live sessions must
  not outlive it. The reset's ~100 ms delay gives the cleanup a head start; whatever it cuts off
  self-heals (a leftover registration is lazily cleaned at exclusion time or by a later open, a
  stale cached workspace listing just yields a denied open).

- After a mutation, use the returned `AffectedCollaborator[]` to find users who **lost access**.
  For each who is now unreachable, if they have an observer record: delete the observer record,
  then best-effort `removeObserver(record.observerId)` on **all** gatekeeper facets.
- For access that **narrowed without being lost** (`build` → some gadgets, or one gadget of
  several), optionally `removeObserver` (and drop the corresponding `accountChoices` entries) for
  connections no gadget they still hold reaches. Safe to defer — an over-broad observer set only
  ever errs toward stricter future checks — but it keeps gatekeeper state tidy.
- All these calls are best-effort: log and continue on error. An orphaned observer entry only
  causes superfluous future checks, never a data leak: a registration is what *admits* an open,
  and every open re-runs `addObserver`, so a stale one grants nothing on its own — while
  `authorizeObservation`'s exclusion gate re-checks the live sharing graph for any id a gatekeeper
  still names. A record is only ever persisted for a party who passed full verification.

> Multi-gatekeeper sequencing/atomicity is an overseer implementation detail, not part of the
> shared interface. Because `addObserver` is re-run every open and `removeObserver` is idempotent,
> a failure mid-teardown self-heals: the next open re-verifies, and `authorizeObservation`'s
> sharing-graph check is always authoritative regardless of stale gatekeeper memory.

### Step 7 — Gatekeeper interface contract (hand-off note)

The per-gatekeeper implementations are out of scope (separate plans), but to keep the Workshop
and gatekeeper teams aligned, document the contract the Workshop relies on. Most of this is
already in the JSDoc in `gatekeeper.ts`; add anything missing there rather than duplicating:

- `getVerifier()` returns a persistent service stub representing the calling user's account; the
  Workshop only ever passes it back to the *same vendor* that minted it.
- `addObserver(observerId, verifier)` MUST throw if the user represented by `verifier` is not
  allowed to observe everything read through this gatekeeper so far. The Workshop calls it on
  every open of every authorized observer (re-verification); gatekeepers should cache as needed.
- `removeObserver(observerId)` MUST be idempotent.
- A gatekeeper that wants to restrict a future observation to a subset of observers sets
  `excludeObservers` (the opaque ids it was given) on the `ObservationDescription`; the Workshop
  will block the observation unless every named observer has already lost access.

---

## 6. Edge cases

1. **Owner is never an observer** — the owner always has `build` and is excluded from the
   collaborators table; `ensureObserver` runs for non-owners only.
2. **Collaborator disconnects a chosen account later** — next open,
   `getVerifier(accountId, bindingVendorId)` returns null; treat the affected binding as uncovered
   and re-prompt via the modal. A mismatched-vendor account (only reachable by bypassing the UI)
   throws and denies the open.
3. **Underlying resource access revoked** — caught at the next open because `addObserver`
   re-runs the live check and throws; the open is denied. Consistent with the lazy-revocation
   model in `sharing.ts`, and the residual under that model is the same one: only the open being
   attempted is denied, so a collaborator who never opens again is never asked, nothing detects
   their revocation, and the sessions they already hold keep the access their own opens verified.
   The persisted `accountChoices` are left alone — an entry records the account the user picked so
   they are not asked again, and never asserted that the gatekeeper still admits them. An
   operational failure (vendor outage, expired credential) is treated the same way — the overseer
   cannot tell it from a settled denial — and the collaborator gets back in as soon as a repaired
   open re-verifies them.
4. **`containsRestrictedData` interaction** — coverage is enforced at *admission*, not per
   observation: `ensureObserver` re-verifies each collaborator against every in-scope gatekeeper
   at every `open()`, so nobody can be in the workspace without having passed the producing
   gatekeeper's `addObserver()`, and anything that widens what they must pass restarts every live
   session (see "Restarting when verification scope widens"). Setting `containsRestrictedData` also
   puts the workspace into a restricted mode: no web fetches, and every action requires manual
   approval (auto-approval rules are suspended), the approver checking the action text for
   restricted data. An action whose description is not complete
   (`ActionDescription.descriptionIsComplete`) is accepted and flagged to the approver; only git
   pushes are refused.
   Verification is held to what each collaborator opened, because `ensureObserver` can never
   verify beyond it: a `use` collaborator can't be covered for a gatekeeper their gadget doesn't
   reach (one it doesn't bind, no enabled hook feeds, and none of its agent spawners
   bind — see `#gadgetReach`). Unbinding shrinks a gadget's scope silently, so a formerly-bound
   producer's later restricted reads that omit `subresources` are not covered for `use`
   collaborators added after the unbind. Accepted because `use` sessions cannot read chat history
   or the action log, and a rebind restores coverage at the next open. (A producer stays in the
   gadget's scope through the subresource requirements the gadget recorded through it.)
   The *never*-bound flavor of the same skip is broader: a producer reachable only through
   chat bindings (an ambient singleton the agent reads in chat) was never in any gadget's scope
   — the agent can persist its restricted data into gadget code or storage without any `use`
   collaborator ever having been verified against it, and there is no prior binding for
   "re-bind" to restore.
   Accepted on the same grounds: coverage there is unverifiable by construction (the
   liveness argument above), `use` sessions still cannot read chat history or the action
   log, so the exposure is limited to what the agent chose to persist, and the forward
   remedy is binding the producer to a gadget — that puts it in the gadget's scope, so every
   collaborator holding it is verified against it at their next open.
5. **Owner adds a new binding after sharing** — existing observers see an incremental modal for
   just the new binding on their next open, and may be denied if they lack access to the new
   resource (inherent to the security model). Because that next open is what verifies them, the
   addition restarts a shared workspace (see "Restarting when verification scope widens"): every
   client reconnects within ~100 ms and re-opens at the new scope, so no session keeps watching a
   connection its holder was never verified against. A connection added *while a collaborator's
   verification is parked* on an await (the modal, verifier RPCs) is covered by the same restart:
   the parked open holds an authorization lease that counts as a session of its role, so the
   widening schedules the reset, which takes the parked open with it, and the client retries
   against the new scope. The residual is the ~100 ms window itself — during which the new
   connection is unreachable anyway (`#gatekeepersPendingRestart`) — and it is inside the
   revocation window the sharing model already accepts.
6. **Performance** — `ensureObserver` does one `getVerifier` + one `addObserver` per in-scope
   gatekeeper per open. Parallelize with `Promise.all` and pipe the verifier promise straight into
   `addObserver`. Expensive gatekeepers cache on their side.
7. **`use`-role observers and `excludeObservers`** — `use` observers are only configured against
   connections a gadget they opened reaches, so they never appear in `excludeObservers` from a
   connection that was never in such a scope (the gatekeeper doesn't know their id). The Step 5
   logic handles this naturally (unknown id → ignored). A connection that *was* in scope and has
   since left every gadget their access includes (unbound, with no enabled hook keeping it
   reachable) is the different case Step 5's scope test handles: the gatekeeper still knows the
   id, but the observer can no longer reach what it produces, so they are de-registered from it
   instead of blocking.
8. **Removing a connection that read restricted data** — removal is not guarded by
   `containsRestrictedData`. The record is what observer verification runs against, so removing a
   producer drops the check for data that outlives it in chat history and storage. The intended
   remedy is that a future connection-removal UI asks the owner to certify that no sensitive data
   from that connection has been retained in the workspace, for any connection.

---

## 7. Testing

- **Observer record / sharing accessors:** unit-test any new `SharingManager` accessor and the
  `observers` collection indexes (lookup by `profileId` and by `observerId`).
- **`ensureObserver`:** with a mock gatekeeper facet that records `addObserver`/`removeObserver`
  calls and can be configured to throw, and a mock `clientUser.getVerifier`:
  - build = all gatekeepers in scope; use = named bindings only.
  - first open invokes the `configure` callback with all account-requiring bindings; subsequent
    opens do not (record covers them) but still re-run `addObserver`.
  - a thrown `addObserver` denies the open without persisting the record; a first-ever
    verification also best-effort `removeObserver`s everything it registered, while a returning
    observer's registrations are all kept.
  - missing account → binding reported as a need to the callback; callback rejection denies open.
- **`authorizeObservation` exclusion:** observation naming a still-authorized observer throws;
  observation naming an observer who lost access proceeds and deletes that observer record (+
  `removeObserver`); unknown id is ignored.
- **Sharing-change teardown:** removing a collaborator / revoking a key deletes their observer
  record and calls `removeObserver` on all gatekeepers.
- **Frontend:** the config modal lists accounts from `subscribeConnectedAccounts()` filtered by
  vendor, defaults to one, supports changing it, and routes to the connect flow when none match.
- Per-gatekeeper integration tests of real `addObserver`/`getVerifier` belong to the separate
  per-gatekeeper plans.

---

## 8. Suggested sequencing

1. **Data model + User DO** — add the `observers` collection (Step in §4) and `User.getVerifier`
   (Step 1).
2. **API plumbing** — `ObserverConfigCallback` + `open()`/`openWorkspace()` signature (Step 2).
3. **Overseer enforcement** — `ensureObserver` and the `open()` hook (Step 3). Land with a
   temporary "deny if `configureCb` absent / any uncovered binding" path so server logic can be
   tested before the UI exists.
4. **Frontend modal** — implement `ObserverConfigCallback` (Step 4), turning denials into a usable
   configuration flow.
5. **Forward exclusion + teardown** — `excludeObservers` handling (Step 5) and observer removal on
   sharing changes (Step 6).
6. **Per-gatekeeper plans (separate docs)** — implement real `addObserver` / `getVerifier` /
   `removeObserver` for each gatekeeper, and document the verifier pattern in the
   `write-gatekeeper` skill. **Must be completed before deploying the feature to prod.** The
   per-gatekeeper strategy decisions that feed those plans are recorded in §9.

---

## 9. Per-gatekeeper observer-tracking strategy

This section records the **strategy decision** for each existing gatekeeper — i.e. *how* each one
should satisfy the `addObserver` / `removeObserver` / `getVerifier` contract from §7. The actual
implementation of each is still a separate follow-up plan (sequencing step 6 above); this section
fixes the approach so those plans can proceed consistently.

### 9.1 Strategies

Strategy is chosen **per resource type** (per `Gatekeeper` DO class / binding), **not** per
gatekeeper package — a single package (e.g. `gatekeeper-google`) may use several strategies across
its resource types.

- **A — Private-only.** Non-owner observers are refused: `addObserver()` unconditionally throws.
  For data that must additionally never leak back out, the `containsRestrictedData` restricted
  mode (no web fetches, and every action requires manual approval — auto-approval rules are
  suspended — the approver checking the action text for restricted data) is available separately;
  combined with strategy A it makes the workspace effectively private once sensitive data is
  observed.
  `getVerifier()` must still exist (the overseer mints one on every open) but is never consulted.

- **B — ACL check (single unit).** The resource is treated as one atomic unit.
  `getVerifier()` mints a verifier exposing the observer's vendor identity (via the
  "non-standard method on the verifier" pattern; see `GatekeeperUserVerifier` in `gatekeeper.ts`).
  `addObserver()` resolves that identity and checks it against the bound resource's ACL, throwing
  on failure. Gatekeepers should cache per-open to bound cost (see the note on `addObserver()`).
  No `excludeObservers` is needed:
  the whole unit is covered up front, so nothing read later could be invisible to a verified
  observer.

- **C — Data-set tracking.** The `Gatekeeper` DO maintains its own log of the **data sets** it has
  actually observed (e.g. BigQuery dataset, Linear team, Notion page/database, Supabase project),
  plus the set of current observers. `addObserver()` verifies the observer against **every** logged
  set so far. When a later observation first touches a **new** set, the gatekeeper re-verifies all
  current observers and sets `excludeObservers` for any who fail (the overseer then blocks the
  observation per the `excludeObservers` contract). `removeObserver()` drops the observer from
  the tracked set. Each per-set check reuses the same ACL primitive the corresponding narrow (B)
  binding uses.

- **D — Low-stakes.** No information-flow tracking. `addObserver()` / `removeObserver()` are
  no-ops; any collaborator may observe. `getVerifier()` returns a trivial verifier (the overseer
  still calls it, so it must exist and not throw).

- **N — N/A.** The gatekeeper exposes no resources, so it is never an in-scope binding; nothing to
  implement.

### 9.2 Decision table

| Gatekeeper | Resource type / binding | Strategy | `addObserver` behavior |
|---|---|---|---|
| **cloudflare** | (no resources — auth only) | **N** | Never in scope; nothing to implement. |
| **email** | Email Mailbox | **D** | No-op. Synthetic per-gadget inbound address; the gadget's collaborators are the intended audience. |
| **spotify** | Account / Playlist | **D** | No-op. Personal, low-stakes; no corp-security concern. |
| **homeassistant** | Instance / Area / Label / Device / Entity | **D** | No-op. Self-hosted personal; the pasted long-lived token is all-or-nothing and HA exposes no per-user/per-entity ACL oracle to check against. |
| **github** | Repo / Issue / PR | **B** | Check the observer's GitHub identity has read access to the bound repo (public → always pass; private → collaborator/org-team check). Issues/PRs inherit the repo ACL, so the repo is the atomic unit. |
| **google** | Google Doc | **B** | Check the observer's Drive sharing access to the bound document. |
| **google** | Google Spreadsheet | **B** | Check the observer's Google Sheets access to the bound spreadsheet. Spreadsheet sharing applies to the whole file, so it is the atomic unit. |
| **google** | Google Slides Presentation | **B** | Check the observer's Google Slides access to the bound presentation. Presentation sharing applies to the whole file, so it is the atomic unit. |
| **google** | Google Calendar (selected calendar) | **B** | Require `writer` or `owner` access to the bound calendar, since `reader` access hides private-event details. Future: let the binding owner exclude private events so readers can collaborate. |
| **google** | Google Calendar (`allVisible` availability) | **C** | In addition to the selected-calendar check, track foreign calendars whose free/busy data was successfully read and verify each observer can independently query their availability. |
| **google** | Gmail Mailbox | **A** | Always throw. (Future: allow observers who independently have access, e.g. mailing-list members — explicitly out of scope now.) |
| **google** | Google Chat Conversation / Thread | **B** | Check the observer's own account can open the bound space (`spaces.get`); for a conversation binding, also that it can list the space's members (`members.list`), since a space can restrict its member list to managers and the binding lists members. Everything else the binding reads — including the other participant's name on a direct message — comes from Chat's own space-scoped responses. |
| **google** | Google Chat Account | **A** | Always throw. The binding spans the owner's direct messages and every conversation they belong to, so there is no one a collaborator could be verified against. Bind a single conversation to share. |
| **google** | BigQuery | **C** | Track accessed datasets; verify the observer's IAM access to each. Dataset granularity for now (tables/columns later). |
| **linear** | Team / Issue | **B** | Check the observer's workspace/team membership, honoring team privacy. |
| **linear** | Workspace | **C** | Track accessed teams; verify the observer against each (reusing the Team B check). |
| **notion** | Page / Database | **B** | Check the observer's Notion access to the bound page/database. |
| **notion** | Workspace | **C** | Track accessed pages/databases; verify the observer's access to each. |
| **supabase** | Project | **B** | Verify the observer's own `listProjects()` (`supabase-api.ts`) includes the bound project ref. Within a project, arbitrary read-only SQL spans the whole DB, so the project is the atomic unit (no per-table tracking). |
| **supabase** | Organization | **C** | Track accessed project refs (the org session reaches them via `openProject` / `listProjects` in `supabase.ts`); verify the observer's `listProjects()` includes each, reusing the Project B check. |
| **confluence** | Site | **C** | Verify site access; track observed spaces and content because both can have narrower permissions. |
| **confluence** | Space | **C** | Verify space access; track observed pages and blog posts because content restrictions may be narrower. |
| **confluence** | Page / Blog Post | **C** | Verify bound-content access; track observed child pages because they may have stricter restrictions than their parent. |
| **zoominfo** | Account | **A** | Always throw. The whole-account binding exposes licensed, entitlement-dependent and account-specific intelligence, and ZoomInfo provides no ACL oracle proving another account can read every historical result. |
| **context** | Context Library singleton | **C** | Track collections whose contents a read revealed (search results, a collection's listing, a document); verify each is in the observer's sharing domain and is public, is everyone-viewable, or grants the observer's Context account a viewer, editor, or owner role. Uses the kit's default observer cap to bound per-read verifier fanout. The top-level collection listing tracks nothing: its titles, descriptions and counts are discovery metadata the agent catalog already advertises unobserved. The denial never names the collection, which the refused collaborator cannot read. |
| **x** | Account | **C** | Admit any observer with a working X connection: public posts, profiles, public Lists and follow graphs need only an X account. Reads private to the account -- bookmarks, likes, mute state, private Lists, and any page holding a protected account's post -- authorize against one synthetic `owner` collection, which admits only an observer connected as the same X user. |
| **x** | Post / List | **C** | As Account, plus a check on every open that the observer's own X account can see the bound post or List (`canViewPost` / `canViewList`). Each check is a read billed to the observer's connection, so a passed check is trusted for an hour; a failed one never is. |
| **microsoft** | SharePoint (all, site, library, folder, file, list, page) | **C** | Track every object a read revealed as a unit (`sharepoint-observers.ts`), since SharePoint breaks inheritance at any level and one container's ACL never vouches for its contents; verify each by probing it with the observer's own token, twenty to a `$batch`, where 403 and 404 both mean no access. A file's content and its version history are their own units, since someone may see a file they can't open; a draft the owner read pins its version, and the probe passes only if the observer is shown the same one. |
| **microsoft** | Outlook Mailbox / Folder / Conversation / Sender | **C** | Track the mailbox, folders and messages each read revealed (`outlook-observers.ts`); verify each by a probe `GET` as the observer: the whole mailbox needs access to all of it (someone shared one folder gets 404), a folder or message needs that folder or message. |
| **microsoft** | Outlook Calendar / Availability | **C** | Track calendar units at the detail level each read revealed (`calendar-observers.ts`): a calendar unit admits an observer only when the owner's `calendarPermissions` give them a role that sees that level (`calendar-acl.ts`, where a group entry can only lower the organization default), which only the owner can read, so a unit of someone else's calendar admits that owner alone; an `availability:<address>` unit only when `getSchedule` as the observer answers for that address; the all-calendars unit admits nobody but the owner. |
| **x** | Profile | **C** | As Account: a public profile needs only an X account, and the `owner` collection covers a protected user's posts. Accepted over-permissiveness for every X binding: an author who has blocked the observer is still readable through the gadget, since checking each author per observer per read would cost a read each and what leaks is public. |

### 9.3 The "broad binding" lens

Several packages expose both a broad binding and narrower ones. A broad binding should use **C**
(track the sub-resources actually touched, verifying each with the narrow binding's ACL primitive)
only when **both** of these hold:

1. The broad binding spans sub-resources that have **distinct ACLs** (otherwise one ACL already
   covers everything — use B).
2. There is a **per-observer access oracle** to check each sub-resource against (otherwise you can
   log what was touched but cannot verify anyone against it).

This is why the broad bindings split the way they do:

- **Satisfy both → C:** Supabase Org (projects + `listProjects()` oracle), Linear Workspace
  (teams + membership), Notion Workspace (pages + page access), BigQuery (datasets + IAM), Context
  Library (per-collection access checks scoped to the observer's account and sharing domain: public,
  everyone-viewable, or an explicit viewer/editor/owner grant).
- **Fail criterion 1 → B:** GitHub Repository — issues/PRs/discussions/code all inherit the single
  repo permission, and there is no binding broader than one repo, so the repo is the atomic ACL
  unit.
- **Fail criterion 2 → D (or A):** Home Assistant Instance — areas/devices/entities exist but the
  long-lived token is all-or-nothing and HA has no per-user ACL oracle, so there is nothing to
  verify an observer against. (Spotify is moot: ACL enforcement is off entirely under D.)
- **Decomposition deliberately deferred → A:** Gmail Mailbox — could in principle decompose into
  mailing lists the observer belongs to, but that is the out-of-scope "advanced" case, so it stays
  fully private for now.
- **Satisfies both but still A:** Google Chat Account — spaces have distinct ACLs and `spaces.get`
  is a serviceable oracle, so C is technically available. It stays A because the binding also
  reaches the owner's direct messages, where "can this collaborator open it too" has no useful
  answer, and one stray DM read under C would lock the workspace for everyone anyway. Sharing is
  done by binding a single conversation, which is the B row above.

---

## 10. Kernel-checked subresources (per observation)

An observation may report the IDs it depends on as `ObservationDescription.subresources`, and the
Workshop then checks and records them itself (`src/observer-ledger.ts`). There is no
per-connection protocol, flag, or switch: each call to `authorizeObservation()` decides.

- **Absent:** the Workshop checks nothing for that read and records no requirement; the
  gatekeeper's own `addObserver()` / `excludeObservers` must cover it, exactly as above.
- **Present:** the read is attributed to its caller's context, every collaborator who can see
  that context is checked through the connection's `verifyObserverAccess()`, and the IDs are
  recorded as requirements on the audit record. A denial or failed check refuses the read and
  records nothing.
- **`[]`:** an explicit "nothing restricts this read": no check, and no requirement recorded.

`excludeObservers` and `subresources` may appear together; both are enforced (the exclusion check
runs first). No shipping gatekeeper reports subresources yet. The gatekeeper's side of the
contract (ID rules and limits, `verifyObserverAccess()` answers, what `addObserver()` must still
enforce) is documented on those members in `workshop-shared/src/gatekeeper.ts`, and
`plans/kernel-observer-tracking.md` records why it is shaped this way.

- **Validation.** At most 10,000 IDs per observation, totalling at most 500,000 UTF-16 code
  units, each a string of 1–512 characters of well-formed Unicode; duplicates are dropped. The
  total keeps a read's audit record well inside Durable Object storage's 2 MB value limit, so
  every read is exactly one record.
- **The audit log is the requirement store.** An observation's audit record keeps the
  `subresources` it reported, so keeping them is what marks a requirement. The record's `caller`
  attributes it (`observerContextOf`): the agent's chat, the calling gadget, the chat a slash
  command runs in, the gadget a firing hook wakes, or the workspace context for a hook naming no
  gadget or a user acting outside any chat (a session opened from the connection itself, a new
  chat's first slash command). A gadget caller persisted without a `gadgetId` is refused. The
  sparse multi-key `actions.byObserverRequirement` index holds one key per subresource,
  `<connection>:<context><id>:<subresource>` (context `w` for workspace, `c` for chats, `g` for
  gadgets). Admission lists only the distinct keys of the contexts what is opened reaches through
  each connection, never the records under them, so repeated reads of the same data add no admission
  work. Nothing else stores requirements, so the action log is append-only: deleting an entry would
  drop its checks.
  Client action-log entries omit `subresources`. The record, its action ID and the read's
  workspace policy flags commit in one transaction, so a failed write latches nothing.
- **Admission is additive.** For every in-scope connection the overseer mints the chosen
  account's verifier once and calls `addObserver()`, as above. Then, only if requirements were
  recorded through that connection that the role reaches, it asks `verifyObserverAccess()` about
  them. A collaborator must pass both; a connection with no recorded requirements is never asked
  `verifyObserverAccess()` at admission. `addObserver()` therefore keeps enforcing whatever the
  gatekeeper tracks itself: any binding-wide requirement its reads rely on, reads that omit
  `subresources`, and everything it recorded before it began reporting them.
- **Checks.** Account choices stay in `observers.accountChoices`, keyed by connection id.
  Connections enter "build" scope at creation, and a gadget's scope while it reaches them through
  bindings, enabled hooks waking it, or spawners — and also while a reached gadget has recorded
  requirements through them, since its state may hold what it read. Within that scope, admission
  checks every requirement what is opened reaches: "build" reaches every context; a gadget, the
  workspace context and the contexts of the gadgets it reaches
  (`ObserverLedger.observerScope`), never an unrelated gadget's. Two gadgets
  reporting different subresources through one connection have those requirements checked
  independently, but must still pass the connection-wide `addObserver()` check above.
  Each observation checks its IDs for every configured observer the data reaches, online or not:
  for a gadget's read, "build" collaborators and those whose access includes a gadget that
  reaches it (`gadgetsReaching`); for a workspace read, anyone with access; for a chat's, "build"
  collaborators. A collaborator who lost access is skipped. Either way the Workshop looks up each
  observer's verifier for their chosen account (`getVerifier()` refuses a disconnected or
  wrong-vendor account even when there is nothing to check) and asks `verifyObserverAccess()`:
  one call per 10 observers for a read's audience, and batches of 10,000 IDs for admission,
  stopping at the first batch that denies. A denial, missing method, failed call, or malformed
  answer fails closed for every observer in the call, with no permission cached between operations.
- **Races.** After verifying, admission recomputes what it must verify and runs the pass again
  (at most three times) if a connection in its scope appeared or disappeared, or its requirements
  changed: one recorded meanwhile, one a gadget it newly reaches had recorded, or one dropped
  because a gadget is no longer reached (a failure may have been about it, so it is not reported
  against the narrower scope); reads through connections outside its scope don't count. An
  observation recomputes who it reaches after its checks and checks whoever it gained (at most
  three times). Both decisions are confirmed in the same synchronous block that publishes them
  (the observer record; the audit record), so neither can miss the other.
- **Pending creations.** While a `createExternalResource` creation is pending, its simulated
  reads are audited and enforce workspace policy but record no requirements, even if they report
  subresources.
- **Removal.** A disconnected connection's audit records stay, but admission ignores them: its
  checks go with it, even when data it read survives (edge case 8).
- **Direct contexts only.** A chat binding read records requirements only on that chat, checked
  against "build" collaborators; a gadget binding read only on that gadget, checked against
  "build" collaborators and those holding a gadget that reaches it. Gadget session access, root
  RPC calls, forged restore stubs, callbacks, spawned chats, code edits, merges, arguments and
  persistent writes transfer nothing between contexts. This deliberately permits indirect
  disclosure, such as chat-derived data reaching a gadget without checking its "use"
  collaborators against the chat's requirements.
  Attribution follows the original authorizer, not wherever its capability is passed.
- **Execution fence.** Agent gatekeeper loopbacks carry their `executionId`; a session that
  outlives its executeCode call cannot authorize an observation that reports subresources. Reads
  that omit them are unaffected, as before.
- **Hooks.** A firing's observations are attributed to the gadget the hook wakes, recorded as
  `{from: "hook", gadgetId}` from the hook record's `gadgetId` (or `defaultGadgetId`), and to the
  workspace when neither names one.
  That `gadgetId` is trusted even though an agent-bound hook's is inferred and its callback
  carries its own restore target: while the hook is enabled, its connection is in the scope of
  that gadget and every gadget reaching it, or of every gadget when the hook names none. Before
  delivery, "build" collaborators must pass verification, and so must "use" collaborators with an
  account chosen for the connection whose access includes a gadget reaching the hook's gadget
  (anyone with access, for a workspace-attributed firing); later admission to such a gadget checks
  the recorded subresources. Firings revalidate that the hook exists, is enabled, and its
  connection is usable on each call and synchronously before the observation's audit/policy
  commit, after asynchronous verification. A racing disable/delete prevents delivery. Disabling
  or deleting a hook stops future events and leaves delivered data's requirements in the action
  log, including across workspace restarts; "build" collaborators stay verified against them, and
  "use" collaborators for gadgets that still reach the connection or recorded requirements
  through it, which includes the hook's own gadget.

The integration fixture's "reports subresources" mode exercises this end to end in
`packages/integration-tests/__tests__/observer-tracking.test.ts`.

---

## Known limitations

Revocations and role changes take effect within seconds -- the revocation restart lands in
~100ms -- and read-side races inside that envelope are accepted by design: a guard earns its
place here only if its failure mode is *persistent* wrong state that outlives the window.

The observer-side deferrals are ledgered in `plans/restricted-data-sharing.md`, each marked at
its site in the code by a matching `TODO` comment:

- Observer verification is not serialized per profile, so concurrent opens by one collaborator
  can overwrite each other's records.
- A mid-registration observer named in `excludeObservers` is read as unknown and the observation
  admitted; persistent, since it lands in chat history (Step 5, item 1). Fix: a pending-id map,
  `observer-verification-fixes`.
