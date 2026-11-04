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
puts the workspace into a restricted mode — web fetches reach only the hosts an admin trusts with
that data (`AdminConfig.restrictedWebFetchHosts`, none by default), and every action requires manual
approval (auto-approval rules are suspended), the approver checking the action text for restricted
data. An action whose description is not complete (`ActionDescription.descriptionIsComplete`)
is accepted and flagged to the approver; only git pushes are refused. Its coverage rests on admission: nobody can open the workspace without being verified
against the producing gatekeeper, and anything that widens what they must be verified against
restarts every live session. An observation that also carries **`ownerInvitesOnly`** sets that
flag on the workspace: from then on only direct grants from the owner count, so share links admit
nobody, people who joined through a link or another collaborator lose access, and only the owner
can add collaborators; see `sharing.md`, "`ownerInvitesOnly`".)

The check works as follows:

- **Observers.** Every non-owner who can see data the Gadget read is an *observer*. Every read
  through a gatekeeper reports the IDs of what it depends on as
  `ObservationDescription.subresources`, and the Workshop records them as requirements (§10).
  When a user becomes an observer, each relevant gatekeeper is asked — via
  `Gatekeeper.verifyObserverAccess()` — whether this specific person may directly read every
  requirement recorded through it that their access reaches. The gatekeeper is the authority on
  its own resource's ACL, so the check runs inside the gatekeeper's trust domain.

- **Verifiers.** The overseer cannot itself reason about a vendor's identity/ACL model. Instead,
  the prospective observer's *own connected account* mints an opaque `GatekeeperUserVerifier`
  (via `GatekeeperUser.getVerifier()`), which the overseer hands back to the gatekeeper. The
  gatekeeper "unwraps" it (today, by calling semi-private methods it defined on its own verifier
  object) to learn the observer's vendor-level identity and check access.

- **Per-read checks.** For reads made *after* a user becomes an observer, the Workshop checks the
  read's reported `subresources` against every configured observer who can see the context that
  made it, and refuses the read if any is denied (§10).

The relevant interfaces are `GatekeeperUser.getVerifier()`, `GatekeeperUserVerifier`,
`Gatekeeper.verifyObserverAccess()`, `Gatekeeper.getHistoricalSubresources()`, and
`ObservationDescription.subresources`, all in `packages/workshop-shared/src/gatekeeper.ts`.
(The original plan used a gatekeeper-side protocol — `addObserver()` / `removeObserver()` and
`ObservationDescription.excludeObservers` — which has since been removed; see §10, "Legacy
history".)

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
  account, the overseer uses it automatically and still verifies them as for any other binding.
- **Authorization is keyed on the sharing table, not on live sessions.** Because a Gadget may
  *store* observed data and re-display it later (even to a `use` observer who opens much later),
  every enforcement decision keys off whether a user is still *authorized* in the
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
  gatekeeper accounts and passed verification** — i.e. is actually set up to observe.
  This is distinct from the sharing table: intent vs. configured-and-verified. Opening requires
  **both** (reachable in the sharing graph AND a valid, complete observer record).
- **Observer ID:** a **random, opaque** string the overseer generates when it first creates an
  observer record, and stores in that record. It identifies the observer within a
  `verifyObserverAccess()` call. We deliberately do **not** use `profile.id` (usually an email),
  to avoid tempting gatekeeper authors to parse identity out of it — identity is conveyed only via
  the verifier. The ID need not survive removal/re-add: a user who loses and regains access gets a
  fresh record and a fresh ID.
- **Verifier:** `Fetcher<GatekeeperUserVerifier>` minted by the *observer's own*
  `GatekeeperUser` (a specific connected account they chose). A persistent service stub — no
  disposal required.
- **Invariant maintained:** at workspace admission for `build`, or gadget admission for `use`,
  every in-scope gatekeeper has confirmed that the user may observe the data that session reaches.
  No later observation reachable by that session is allowed if the user may not see it.

---

## 4. Data model changes

### New overseer storage collection: `observers`

Add an `observers` collection to `OverseerStorage` (mirror the `gatekeepers` collection in
`overseer-storage.ts`):

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

- Primary index: `profileId` (open path looks up by the connecting user's profile). (A
  `byObserverId` index once mapped ids named in `excludeObservers` back to profiles; it was
  removed with that field.)

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

> The observer-open path awaits the result (`requireVerifier` in `observer-ledger.ts`), because a
> null result means the account must be re-selected.

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
// Re-verifies already-configured bindings on every open.
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

   Before each pass, if any in-scope connection still holds un-imported legacy history
   (`observerHistoryPending`), wait for its import, recompute the scope, and start the pass
   again; a failed import denies the open (§10, "Legacy history").

3. **Determine uncovered bindings**: in-scope account-requiring gatekeepers with no
   `accountChoices` entry in the record. Before prompting, automatically fill ambient bindings from
   the collaborator's matching provided singleton accounts. Ordinary bindings, missing ambient
   accounts, and bindings being re-prompted after a failed verification remain uncovered.

4. **If there are uncovered bindings**, invoke `configureCb.configure(needs)` with one
   `ObserverBindingNeed` per uncovered binding. If `configureCb` is absent (e.g. a non-interactive
   open), deny. Merge the returned `ObserverAccountChoice[]` into a working copy of the record's
   `accountChoices`.

5. **Re-verify all in-scope bindings** (covered + newly chosen). For each, resolve the chosen
   account's verifier via `clientUser.getVerifier(accountId, bindingVendorId)` (`requireVerifier`)
   and, only if requirements were recorded through that connection that the grant reaches, ask
   the connection's `verifyObserverAccess()` about them (`ObserverLedger.checkAccess`; §10).
   A connection with no recorded requirements admits anyone with a valid account choice and
   verifier. Generate `observerId` (random) if the record is new. Bindings are verified in
   parallel with `Promise.all`.
   - The User DO compares `bindingVendorId` with the chosen connected account's stored vendor and
     **throws** on a mismatch. This server-side check is what guarantees a gatekeeper only receives
     a verifier minted by its own vendor; filtering account choices in the client is only a
     user-interface convenience.
   - If any check denies or fails (or `getVerifier` throws on vendor mismatch, or returns null
     for a disconnected account), the user is not (or no longer) allowed. Every failure is
     collected, and the user is offered a bounded number of re-prompts to repair (e.g.
     re-authenticate an expired account). On terminal failure the open is denied with a message
     naming each refused binding, and no record is persisted. The persisted `accountChoices` are
     left as they are: an entry records the choice the user made so they are not asked again,
     and asserts nothing about whether the gatekeeper still admits them.
   - Nothing is registered with gatekeepers, so a denial has nothing to roll back.
   - A denial ends only this open. Sessions the collaborator already holds are untouched, and keep
     the access their own opens verified until they next re-open — the lazy-revocation residual
     described under "Known gaps" below.

6. **Persist the observer record** (with merged `accountChoices` and `observerId`) only after
   every binding verified, in the same synchronous block that confirmed the verification scope
   did not change (§10, "Races"). Storing/creating the record is the canonical moment the user
   becomes a configured observer; observations check every published observer from then on.

Then in `open()`:

```ts
await this.impl.ensureObserver(profileId, clientUser, role, configureObservers);
```

Notes:
- **Re-verification every open is intentional.** It catches revocation of the user's underlying
  resource access promptly (caught at their next open). `verifyObserverAccess()` must not cache
  verdicts by observer ID; a gatekeeper may cache provider answers per account (§9.2), choosing
  its own tradeoff between performance and immediacy of revocation.
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

### Step 5 — Overseer: per-read checks in `authorizeObservation()`

The original plan had gatekeepers name observers who must not see a new observation
(`ObservationDescription.excludeObservers`) and the overseer block it unless each named observer
had lost access. That protocol has been removed; the field no longer exists. Every observation
now reports `subresources`, and `authorizeObservation()` checks them against every configured
observer who can see the context that made the read before it commits (§10). Because v1 has no
per-thread hiding, a read any such observer is denied is refused outright.

### Step 6 — Overseer: remove observers on sharing changes

When sharing changes, configured observers who lose access must be torn down. In the overseer
methods wrapping `SharingManager` mutations (`removeCollaborator`, `revokeShareLink`, and role
downgrades — see the matching methods on `OverseerClientInterface` and `SharingManager`):

- The **session-severing restart is scheduled first**, in the same synchronous step as the sharing
  mutation, and only then does the cleanup below run: refreshing cached workspace listings crosses
  User-DO round trips that can stall or hang, and a revoked collaborator's live sessions must not
  outlive it. The reset's ~100 ms delay gives the cleanup a head start; whatever it cuts off
  self-heals (a stale cached workspace listing just yields a denied open).
- After a mutation, `tearDownLostObservers(affected)` synchronously deletes the observer record of
  every affected collaborator who is now unreachable (`newAccess === null`). Nothing is sent to
  gatekeepers. If they ever regain access they reconfigure from scratch (Step 3).
- Access that **narrowed without being lost** (`build` → some gadgets, or one gadget of several)
  keeps its record. The extra `accountChoices` entries grant nothing: every open re-verifies, and
  a per-read check only reaches collaborators whose current access sees the read's context.

### Step 7 — Gatekeeper interface contract (hand-off note)

The contract the Workshop relies on is the JSDoc in `gatekeeper.ts`; add anything missing there
rather than duplicating. In summary:

- `getVerifier()` returns a persistent service stub representing the calling user's account; the
  Workshop only ever passes it back to the *same vendor* that minted it.
- Every `ObservationDescription` reports `subresources`: the IDs of everything the disclosure
  depends on that might restrict who may see it, including the bound resource's own ID when its
  ACL or tenant membership governs the data; `[]` when nothing does.
- `verifyObserverAccess(observers, subresources)` (required when reporting non-empty
  `subresources` or a non-empty export) returns the observers whose account can read every ID
  now, and throws when access cannot be determined.
- `getHistoricalSubresources()` exports the data subresource IDs observed under the legacy
  protocol and not already reported; `[]` for every connection created after the cutover (§10,
  "Legacy history").

---

## 6. Edge cases

1. **Owner is never an observer** — the owner always has `build` and is excluded from the
   collaborators table; `ensureObserver` runs for non-owners only.
2. **Collaborator disconnects a chosen account later** — next open,
   `getVerifier(accountId, bindingVendorId)` returns null; treat the affected binding as uncovered
   and re-prompt via the modal. A mismatched-vendor account (only reachable by bypassing the UI)
   throws and denies the open.
3. **Underlying resource access revoked** — caught at the next open because
   `verifyObserverAccess()` re-checks the recorded requirements live; the open is denied.
   Consistent with the lazy-revocation model in `sharing.ts`, and the residual under that model
   is the same one: only the open being
   attempted is denied, so a collaborator who never opens again is never asked, nothing detects
   their revocation, and the sessions they already hold keep the access their own opens verified.
   The persisted `accountChoices` are left alone — an entry records the account the user picked so
   they are not asked again, and never asserted that the gatekeeper still admits them. An
   operational failure (vendor outage, expired credential) is treated the same way — the overseer
   cannot tell it from a settled denial — and the collaborator gets back in as soon as a repaired
   open re-verifies them.
4. **`containsRestrictedData` interaction** — coverage is enforced per read for configured
   observers who can see the reading context (§10), and at *admission* for everyone else:
   `ensureObserver` re-verifies `build` collaborators at workspace `open()`, and `use`
   collaborators at each gadget's `getGadget()`, against the connections and requirements in scope
   for that admission. Scope widening restarts live sessions (see "Restarting when verification
   scope widens"). Setting `containsRestrictedData` also
   puts the workspace into a restricted mode: web fetches reach only the hosts an admin trusts with
   that data, and every action requires manual approval (auto-approval rules are suspended), the
   approver checking the action text for restricted data. An action whose description is not complete
   (`ActionDescription.descriptionIsComplete`) is accepted and flagged to the approver; only git
   pushes are refused.
   Verification is held to what each collaborator opened, because `ensureObserver` can never
   verify beyond it: a `use` collaborator can't be covered for a gatekeeper their gadget doesn't
   reach (one it doesn't bind, no enabled hook feeds, and none of its agent spawners
   bind — see `#gadgetReach`). Requirements are recorded only on the context that made the read
   (§10, "Direct contexts only"), so a formerly-bound producer's later restricted reads, made in
   chat after the unbind, are not checked against `use` collaborators even if the agent persists
   their data into the gadget. Accepted because `use` sessions cannot read chat history or the
   action log, and a rebind restores coverage. (A producer stays in the gadget's scope through the
   subresource requirements the gadget recorded through it.)
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
6. **Performance** — `ensureObserver` mints one verifier per in-scope connection per open, and
   calls `verifyObserverAccess()` only for connections with recorded requirements the grant
   reaches, in batches of 10,000 IDs, all connections in parallel. Expensive gatekeepers cache
   provider answers per account on their side.
7. **`use`-role observers and per-read checks** — a gadget's read is checked against a `use`
   collaborator only when their access includes a gadget that reaches the reading gadget
   (`gadgetsReaching`), a workspace-attributed read against every collaborator, and a chat's
   read against none. Either way only observers with an account chosen for the connection are
   checked: one who has never been in that connection's scope has no choice for it and is
   checked at their next admission instead.
   **Known gap: a binding loopback retained across an unbind.** A loopback's props name the
   gatekeeper id, never the (gadget, binding) edge, and every call re-resolves a session without
   revalidating any edge, so one retained across the unbind (returned to a browser client,
   persisted in facet storage, or parked in `agentCallbackArgs`) keeps reading until
   `removeGatekeeper`. Its reads are still attributed to the gadget, but a `use` collaborator
   admitted after the unbind has no account choice for the connection, so they are not checked
   (unless the gadget's recorded requirements kept the connection in their admission scope). The
   required fix is a per-call edge check (`#assertBindingEdgeLive`, matching on binding *target*
   for gadget callers) in `startGatekeeperSession`'s gatekeeper branch.
8. **Removing a connection that read restricted data** — removal is not guarded by
   `containsRestrictedData`. The record is what observer verification runs against, so removing a
   producer drops the check for data that outlives it in chat history and storage. The intended
   remedy is that a future connection-removal UI asks the owner to certify that no sensitive data
   from that connection has been retained in the workspace, for any connection.

---

## 7. Testing

- **Observer record / sharing accessors:** unit-test any new `SharingManager` accessor and the
  `observers` collection (lookup by `profileId`).
- **`ensureObserver`:** with a mock gatekeeper facet whose `verifyObserverAccess` can be configured
  to deny or throw, and a mock `clientUser.getVerifier`:
  - build = all gatekeepers in scope; use = what the gadget reaches.
  - first open invokes the `configure` callback with all account-requiring bindings; subsequent
    opens do not (record covers them) but still re-verify.
  - a denied or failed check denies the open without persisting the record; a connection with no
    recorded requirements is never asked.
  - missing account → binding reported as a need to the callback; callback rejection denies open.
  - pending legacy history is imported before verification, and a failed import denies the open.
- **`authorizeObservation`:** a read whose `subresources` a configured observer in its audience is
  denied is refused and records nothing; `[]` checks nothing.
- **Sharing-change teardown:** removing a collaborator / revoking a key deletes their observer
  record.
- **Frontend:** the config modal lists accounts from `subscribeConnectedAccounts()` filtered by
  vendor, defaults to one, supports changing it, and routes to the connect flow when none match.
- Per-gatekeeper integration tests of real `verifyObserverAccess`/`getVerifier` belong to the
  separate per-gatekeeper plans.

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
5. **Per-read checks + teardown** — checking reported `subresources` in `authorizeObservation`
   (Step 5, §10) and observer-record removal on sharing changes (Step 6).
6. **Per-gatekeeper plans (separate docs)** — report `subresources` and implement real
   `verifyObserverAccess` / `getVerifier` for each gatekeeper, and document the verifier pattern
   in the `write-gatekeeper` skill. **Must be completed before deploying the feature to prod.**
   The per-gatekeeper strategy decisions that feed those plans are recorded in §9.

---

## 9. Per-gatekeeper observer-tracking strategy

This section records the **strategy decision** for each existing gatekeeper — i.e. *how* each one
satisfies the contract from §7: what its reads report as `subresources`, and what its
`verifyObserverAccess()` checks. It fixes the approach so per-gatekeeper work proceeds
consistently.

### 9.1 Strategies

Strategy is chosen **per resource type** (per `Gatekeeper` DO class / binding), **not** per
gatekeeper package — a single package (e.g. `gatekeeper-google`) may use several strategies across
its resource types.

- **A — Private-only.** Reads report the private resource's own ID, and `verifyObserverAccess()`
  admits only an observer connected as the same user. Since the owner is never an observer, in
  practice no collaborator passes once such a read is recorded.
  For data that must additionally never leak back out, the `containsRestrictedData` restricted
  mode (web fetches reach only admin-trusted hosts, and every action requires manual approval —
  auto-approval rules are suspended — the approver checking the action text for restricted data) is
  available separately; combined with strategy A it makes the workspace effectively private once
  sensitive data is observed.

- **B — ACL check (single unit).** The resource is treated as one atomic unit. Every read that
  reveals its data reports the bound resource's ID. `getVerifier()` mints a verifier exposing the
  observer's vendor identity (via the "non-standard method on the verifier" pattern; see
  `GatekeeperUserVerifier` in `gatekeeper.ts`), and `verifyObserverAccess()` checks that identity
  against the bound resource's ACL.

- **C — Data-set tracking.** The binding spans **data sets** with distinct ACLs (e.g. BigQuery
  dataset, Linear team, Notion page/database, Supabase project). Every read reports each set it
  revealed, and `verifyObserverAccess()` checks the observer against each, reusing the same ACL
  primitive the corresponding narrow (B) binding uses. The Workshop records the sets and checks
  them at each later admission (§10); the gatekeeper keeps no observer state.

- **D — Low-stakes.** No information-flow tracking. Every read reports `[]`, so any collaborator
  with a valid account choice may observe. `getVerifier()` returns a trivial verifier (the overseer
  still mints one at every open, so it must exist and not throw).

- **N — N/A.** The gatekeeper exposes no resources, so it is never an in-scope binding; nothing to
  implement.

### 9.2 Decision table

| Gatekeeper | Resource type / binding | Strategy | Reported `subresources` and `verifyObserverAccess` check |
|---|---|---|---|
| **cloudflare** | (no resources — auth only) | **N** | Never in scope; nothing to implement. |
| **email** | Email Mailbox | **D** | Reports `[]`. Synthetic per-gadget inbound address; the gadget's collaborators are the intended audience. |
| **spotify** | Account / Playlist | **D** | Reports `[]`. Personal, low-stakes; no corp-security concern. |
| **homeassistant** | Instance / Area / Label / Device / Entity | **D** | Reports `[]`. Self-hosted personal; the pasted long-lived token is all-or-nothing and HA exposes no per-user/per-entity ACL oracle to check against. |
| **github** | Repo / Issue / PR | **B** | Reports the bound repo's ID; the check confirms the observer's GitHub identity has read access to it (public → always pass; private → collaborator/org-team check). Issues/PRs inherit the repo ACL, so the repo is the atomic unit. |
| **google** | Google Doc | **B** | Reports the bound document's ID; the check confirms the observer's Drive sharing access to it. |
| **google** | Google Spreadsheet | **B** | Reports the bound spreadsheet's ID; the check confirms the observer's Google Sheets access to it. Spreadsheet sharing applies to the whole file, so it is the atomic unit. |
| **google** | Google Slides Presentation | **B** | Reports the bound presentation's ID; the check confirms the observer's Google Slides access to it. Presentation sharing applies to the whole file, so it is the atomic unit. |
| **google** | Google Calendar (selected calendar) | **B** | Every read reports what it returned from Google: metadata and every event listing, an empty one included, report `calendar/calendar/<calendarId>`. `verifyObserverAccess` allows an observer for a calendar only with `writer` or `owner` access to that calendar, since `reader` access hides private-event details, reused as for availability (next row); a lookup Google refuses for any reason but the calendar's absence fails the check. Future: let the binding owner exclude private events so readers can collaborate. |
| **google** | Google Calendar (availability) | **C** | An availability check reports each calendar whose free/busy it read successfully, the bound one included, as a `calendar/freeBusy/<calendarId>` subresource (a failed lookup reports nothing); only an `allVisible` binding may check calendars other than its own. `verifyObserverAccess` allows an observer only if their own account can query every one's free/busy. Only Google's answer for a calendar is a verdict: any error, including Google refusing the query itself, fails the check. The observer's `UserAccount` reuses an allowed answer for up to 15 minutes and a denial for up to 15 seconds, counted from when it asked Google and only until its credentials are next installed, so a share revoked in Google can still admit the observer for up to 15 minutes and a new share is noticed within 15 seconds. |
| **google** | Gmail Mailbox | **A** | Reports the mailbox's ID, which the check admits for no other user. (Future: allow observers who independently have access, e.g. mailing-list members — explicitly out of scope now.) |
| **google** | Google Chat Conversation / Thread | **B** | Reports the bound space's ID; the check confirms the observer's own account can open the space (`spaces.get`) and, for a conversation binding, list its members (`members.list`), since a space can restrict its member list to managers and the binding lists members. Everything else the binding reads — including the other participant's name on a direct message — comes from Chat's own space-scoped responses. |
| **google** | Google Chat Account | **A** | Reports the account's ID, which the check admits for no other user. The binding spans the owner's direct messages and every conversation they belong to, so there is no one a collaborator could be verified against. Bind a single conversation to share. |
| **google** | BigQuery | **C** | Every read reports each dataset whose data it revealed as a `subresources` ID, `bigquery/project/<projectId>/dataset/<datasetId>`: a query or dry run the datasets of its referenced tables, a dataset listing every dataset it lists (only the bound one on a dataset binding), a table listing or description its dataset; `getProject` reports `[]`. `verifyObserverAccess` allows an observer only if their own token can fetch every dataset's metadata with `datasets.get`, answered by their `UserAccount` under the same reuse rules as Calendar's availability checks above, so a revoked metadata grant can still admit the observer for up to 15 minutes. This metadata check does not establish permission to read table data; metadata-only roles can pass it. Dataset lookups run one at a time within each account's request. Only BigQuery's denial (403 `accessDenied`) or a missing dataset (404) counts as no access; any other refusal, such as a rate limit, a quota or a missing scope, fails the check. Dataset granularity on every binding, table-scoped ones included (tables/columns later). |
| **linear** | Team / Issue | **B** | Reports the bound team's ID; the check confirms the observer's workspace/team membership, honoring team privacy. |
| **linear** | Workspace | **C** | Reports each team a read revealed; the check verifies the observer against each (reusing the Team B check). |
| **notion** | Page / Database | **B** | Reports the bound page/database's ID; the check confirms the observer's Notion access to it. |
| **notion** | Workspace | **C** | Reports each page/database a read revealed; the check verifies the observer's access to each. |
| **supabase** | Project | **B** | Reports the bound project ref; the check confirms the observer's own `listProjects()` (`supabase-api.ts`) includes it. Within a project, arbitrary read-only SQL spans the whole DB, so the project is the atomic unit (no per-table tracking). |
| **supabase** | Organization | **C** | Reports each project ref a read revealed (the org session reaches them via `openProject` / `listProjects` in `supabase.ts`); the check confirms the observer's `listProjects()` includes each, reusing the Project B check. |
| **confluence** | Site | **C** | Reports the site's ID on reads revealing its data, and each space and content item a read revealed, because both can have narrower permissions. |
| **confluence** | Space | **C** | Reports the space's ID on reads revealing its data, and each page and blog post a read revealed, because content restrictions may be narrower. |
| **confluence** | Page / Blog Post | **C** | Reports the bound content's ID on reads revealing it, and each child page a read revealed, because child pages may have stricter restrictions than their parent. |
| **zoominfo** | Account | **A** | Reports the account's ID, which the check admits for no other user. The whole-account binding exposes licensed, entitlement-dependent and account-specific intelligence, and ZoomInfo provides no ACL oracle proving another account can read every historical result. |
| **context** | Context Library singleton | **C** | Every read reports the collections whose contents it revealed (search results, a collection's listing, a document) as `subresources`, one collection ID each; `verifyObserverAccess` (the kit's `observerAccessVerifier`) allows an observer only if their Context account can read every one now, in the binding's sharing domain: public, everyone-viewable, or granted to it as viewer, editor, or owner. The top-level collection listing reports `[]`: its titles, descriptions and counts are discovery metadata the agent catalog already advertises unobserved. A denial does not name the collection, which the refused collaborator cannot read. |
| **x** | Account | **C** | Public posts, profiles, public Lists and follow graphs need only an X account. Reads private to the account -- bookmarks, likes, mute state, private Lists, and any page holding a protected account's post -- report one synthetic `owner` ID, which the check admits only for an observer connected as the same X user. |
| **x** | Post / List | **C** | As Account, plus the bound post or List's ID on every read revealing it, which the check confirms the observer's own X account can see (`canViewPost` / `canViewList`). Each check is a read billed to the observer's connection, so a passed check is trusted for an hour; a failed one never is. |
| **microsoft** | SharePoint (all, site, library, folder, file, list, page) | **C** | Reports every object a read revealed as a unit (`sharepoint-observers.ts`), since SharePoint breaks inheritance at any level and one container's ACL never vouches for its contents; the check probes each with the observer's own token, twenty to a `$batch`, where 403 and 404 both mean no access. A file's content and its version history are their own units, since someone may see a file they can't open; a draft the owner read pins its version, and the probe passes only if the observer is shown the same one. |
| **microsoft** | Outlook Mailbox / Folder / Conversation / Sender | **C** | Reports the mailbox, folders and messages each read revealed (`outlook-observers.ts`); the check probes each with a `GET` as the observer: the whole mailbox needs access to all of it (someone shared one folder gets 404), a folder or message needs that folder or message. |
| **microsoft** | Outlook Calendar / Availability | **C** | Reports calendar units at the detail level each read revealed (`calendar-observers.ts`): a calendar unit admits an observer only when the owner's `calendarPermissions` give them a role that sees that level (`calendar-acl.ts`, where a group entry can only lower the organization default), which only the owner can read, so a unit of someone else's calendar admits that owner alone; an `availability:<address>` unit only when `getSchedule` as the observer answers for that address; the all-calendars unit admits nobody but the owner. |
| **x** | Profile | **C** | As Account: a public profile needs only an X account, and the `owner` ID covers a protected user's posts. Accepted over-permissiveness for every X binding: an author who has blocked the observer is still readable through the gadget, since checking each author per observer per read would cost a read each and what leaks is public. |

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

Every observation reports the IDs it depends on as `ObservationDescription.subresources`, and the
Workshop checks and records them itself (`src/observer-ledger.ts`). The field is required: the RPC
layer rejects an observation without it, and there is no unchecked path.

- **Non-empty:** the read is attributed to its caller's context, every collaborator who can see
  that context is checked through the connection's `verifyObserverAccess()`, and the IDs are
  recorded as requirements on the audit record. A denial or failed check refuses the read and
  records nothing.
- **`[]`:** an explicit "nothing restricts this read": no check, and no requirement recorded.

When the bound resource's own ACL or tenant membership governs the data, reads report that
resource's ID; nothing outside `subresources` is checked, at admission or per read. Google Calendar
reports `calendar/calendar/<calendarId>` for its metadata and event listings, and
`calendar/freeBusy/<calendarId>` for each calendar an availability check reads; Google BigQuery
reports the datasets each read reveals; the Context Library reports the collections each read
reveals (§9.2). Scheduled Tasks and Web Search report `[]` on every read. The gatekeeper's side of
the contract (ID rules and limits, `verifyObserverAccess()` answers, the historical export) is
documented on those members in `workshop-shared/src/gatekeeper.ts`, and
`plans/kernel-observer-tracking.md` records why it is shaped this way.

- **Validation.** At most 10,000 IDs per observation, totalling at most 500,000 UTF-16 code
  units, each a string of 1–2048 characters of well-formed Unicode; duplicates are dropped. The
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
  gadgets). Per connection, admission lists only the distinct keys of the contexts reached by what
  is opened, never the records under them, so repeated reads of the same data add no admission
  work. Nothing else stores requirements, so the action log is append-only: deleting an entry would
  drop its checks.
  Client action-log entries omit `subresources`. The record, its action ID and the read's
  workspace policy flags commit in one transaction, so a failed write latches nothing.
- **Admission.** For every in-scope connection the overseer mints the chosen account's verifier
  (refusing a disconnected or wrong-vendor account). Then, only if requirements were recorded
  through that connection that the grant reaches, it asks `verifyObserverAccess()` about them. A
  connection with no recorded requirements admits anyone with a valid account choice and
  verifier.
- **Checks.** Account choices stay in `observers.accountChoices`, keyed by connection id.
  Connections enter "build" scope at creation, and a gadget's scope while it reaches them through
  bindings, enabled hooks waking it, or spawners — and also while a reached gadget has recorded
  requirements through them, since its state may hold what it read. Within that scope, admission
  checks every requirement reached by what is opened: "build" reaches every context; a gadget, the
  workspace context and the contexts of the gadgets it reaches
  (`ObserverLedger.observerScope`), never an unrelated gadget's. Two gadgets
  reporting different subresources through one connection have those requirements checked
  independently.
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
  reads are audited and enforce workspace policy but record no requirements.
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
  outlives its executeCode call cannot authorize any observation, `[]` included.
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

The integration fixture's `verifyObserverAccess()` exercises this end to end in
`packages/integration-tests/__tests__/observer-tracking.test.ts`.

### Legacy history

Before this cutover, gatekeepers tracked observers themselves through `addObserver()` /
`removeObserver()` and blocked new reads with `ObservationDescription.excludeObservers`, and
reads could omit `subresources`. Those members are gone and the kernel never calls or reads them.
What a pre-existing connection observed under that protocol is imported once instead:

- **Flag.** Storage migration 6 → 7 (`migrateToKernelObserverTracking` in
  `storage-schema/overseer-migrations.ts`) sets `GatekeeperRecord.observerHistoryPending` on every
  connection with a vendor. New connections never get it and are never asked for an export.
- **Import.** `ObserverLedger.importHistory()` is single-flight per connection. It calls
  `Gatekeeper.getHistoricalSubresources()`, validates each ID as for an observation (no count or
  total limit on the export), deduplicates, and in one storage transaction writes the IDs as
  workspace-context observation records (`caller: {from: "user"}`, title "Imported earlier
  reads") in chunks of at most 10,000 IDs and 500,000 code units, and clears the flag. The export
  can't say which chat or gadget read what, so the workspace context, which every grant reaches,
  holds it. An empty export clears the flag and writes nothing; a connection removed meanwhile
  writes nothing.
- **When.** As the Overseer wakes, `importPendingHistory()` starts the import in the background
  for every flagged connection that is not a pending creation, logging failures. `ensureObserver`
  waits for the import of every flagged in-scope connection before verifying (Step 3). Reads never
  wait for it; they record their own requirements meanwhile.
- **Failure.** A failed or invalid export commits nothing, logs `observer.ledger.import.failed`,
  and denies the open that waited for it with a retryable error. The next admission or wake
  exports again; a missing or failed export is never treated as empty.

Release order:

1. Every gatekeeper reports `subresources` on every read (cursor pages and hook deliveries
   included) and implements `verifyObserverAccess()` and `getHistoricalSubresources()`, keeping
   its legacy enforcement. These gatekeepers ship first.
2. This kernel cutover ships.
3. Gatekeepers then drop their `addObserver()` / `removeObserver()` / `excludeObservers` code, but
   keep the legacy history their export reads for as long as the method exists.

---

## Known limitations

Revocations and role changes take effect within seconds -- the revocation restart lands in
~100ms -- and read-side races inside that envelope are accepted by design: a guard earns its
place here only if its failure mode is *persistent* wrong state that outlives the window.

The observer-side deferrals are ledgered in `plans/restricted-data-sharing.md`, each marked at
its site in the code by a matching `TODO` comment:

- Observer verification is not serialized per profile, so concurrent opens by one collaborator
  can overwrite each other's records, losing the other's account choices.
