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

Today the only mechanism enforcing this is the blunt **`prohibitAllSharing`** flag
(`packages/workshop-shared/src/gatekeeper.ts`, `ObservationDescription.prohibitAllSharing`).
When a gatekeeper marks an observation as maximally sensitive, the Gadget can no longer be
shared with *anyone*, and it drops into "lockdown" (no further actions, no web fetches). This
is a deliberate stopgap — it cannot express "this data may be shared, but only with people who
*also* have access to it."

This feature replaces that all-or-nothing posture with a per-user, gatekeeper-mediated check:

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

**The API is already committed** (commit `e2f1707`). The relevant interfaces are
`GatekeeperUser.getVerifier()`, `GatekeeperUserVerifier`, `Gatekeeper.addObserver()` /
`removeObserver()`, and `ObservationDescription.excludeObservers`, all in
`packages/workshop-shared/src/gatekeeper.ts`.

### v1 scope decisions (agreed)

- **No per-thread enforcement.** v1 is all-or-nothing per observer. We do not (yet) hide
  individual chat threads or observations from individual collaborators.
- **Role-based breadth of verification:**
  - **`build`** collaborators (full access — chat + code + all bindings) must be verified
    against **every** gatekeeper the Gadget has.
  - **`use`** collaborators (UI only, no chat access — see `UseOverseerInterface`,
    `overseer.ts:2816`) must be verified only against gatekeepers their sessions can actually
    reach: those **bound by some gadget** (the UI can invoke them), those with an **enabled
    hook** (a hook is a live write channel into a gadget they can open, delivering the
    connection's data regardless of binding edges), plus — transitively — every **env target of a
    bound agent spawner** (spawning is reachable from the gadget UI, and the spawned agent reads
    the env's connections with the spawner creator's authority). See `#useScopeGatekeeperIds`.
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
  sharing graph (`computeEffectiveRoles`), never off whether they currently have the Gadget open.

---

## 2. Background: relevant existing code

| Concern | Location |
|---|---|
| Gatekeeper RPC API (the committed surface) | `packages/workshop-shared/src/gatekeeper.ts` |
| Overseer DO, `open()` auth entry point | `packages/workshop-backend/src/overseer.ts:2714` |
| Authorization gate shared by `open()` and `receiveExternalMessage()` | `overseer.ts` `authorizeCollaborator()` |
| Session restart when verification scope widens | `overseer.ts` (`#restartIfSessionsAffected`, `joinSession`, `scheduleAccessRestart`) |
| Server `openGadget` path | `packages/workshop-backend/src/server.ts:206` |
| Role resolution / permission graph | `packages/workshop-backend/src/sharing.ts` (`getEffectiveRole`, `computeEffectiveRoles`, `hasAnyShares`) |
| `prohibitAllSharing` enforcement | `overseer.ts:1171` (`authorizeObservation`), `:1207` (web fetch), `:1258` (`submitAction`) |
| Observation recording | `overseer.ts:1169` `authorizeObservation()`; `ApprovalQueueImpl` `overseer.ts:4856` |
| Gatekeeper storage record | `overseer.ts:110` `GatekeeperRecord` (has `creationSpec.vendorId`) |
| `GatekeeperCreationSpec` | `packages/workshop-shared/src/api.ts:1345` |
| Gatekeeper facet access | `overseer.ts:1079` `getGatekeeperFacet()` |
| Overseer storage collections | `overseer.ts:316` (`gatekeepers`, with `byBindingName` index — template for a new collection) |
| Connected accounts (User DO) | `packages/workshop-backend/src/user.ts:12` `ConnectedAccountRecord` (`account: Fetcher<GatekeeperUser>`, `vendorId`) |
| List connected accounts | `user.ts:890` `subscribeConnectedAccounts()`; subscriber type `api.ts:116` |
| Account → gatekeeper class | `user.ts:1136` `getGatekeeperClassFor()` |

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

Add an `observers` collection to `OverseerStorage` (mirror the `gatekeepers` collection at
`overseer.ts:316`, including a secondary index for reverse lookup):

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
`getGatekeeperClassFor` (`user.ts:1136`):

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

### Step 2 — Client-server API: a configuration callback on `open` / `openGadget`

We must avoid structured/typed errors for control flow (prohibited in this codebase) and must not
break promise pipelining in the common case. So `open()` gains an **optional callback** that is
invoked **only** when the opening user needs to configure gatekeeper accounts. In the common case
(owner, or an already-configured observer) the callback is never called, and `open()` resolves
without an extra round trip.

Add to the RPC API (`packages/workshop-shared/src/api.ts`) and thread through
`server.ts:206` → `overseer.open()` (`overseer.ts:2714`):

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

(Same goes for `openGadget()`, which is the public-facing API method on `AuthenticatedApi`.)

### Step 3 — Overseer: observer configuration & re-verification at `open()`

Hook into `open()` in the non-owner branch, after `effectiveRole` is confirmed and before
constructing the client interface. Keep the existing `prohibitAllSharing` short-circuit ahead of
this -- lockdown still wins. The `NeedsConnections` signal is produced only *after* a valid role is
confirmed, so it never reveals a workspace's gatekeeper or resource metadata to an unauthorized
user.

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
   - `use`: only those some gadget binds, an enabled hook feeds, or a bound agent spawner's env
     names (`#useScopeGatekeeperIds` — a hook waking a still-provisional gadget stays out of
     `use` scope until promotion; the merge diff reports that widening).
   - A `creationSpec` with a `vendorId` requires an account; other specs need no verifier or account
     choice.

2. **Load the observer record** for `profileId` (may be absent) and build a working copy of its
   `accountChoices`. An out-of-scope entry is simply not consulted: nothing is verified against a
   gatekeeper outside the role's scope, so the choice sits there unread until the connection is
   back in scope and the entry saves the collaborator from being asked again.

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
   - If any `addObserver` **throws** (or `getVerifier` throws on vendor mismatch), the user is not
     (or no longer) allowed. Every such failure goes through one `fail()` path, and the user is
     offered a bounded number of re-prompts to repair (e.g. re-authenticate an expired account). On
     terminal failure the open is denied with a message naming each refused binding, and the
     registrations this call added are best-effort-removed while no record is persisted. The
     persisted `accountChoices` are left as they are: an entry records the choice the user made so
     they are not asked again, and asserts nothing about whether the gatekeeper still admits them.
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
- **Role resolution and verification belong together.** Both live behind one
  `authorizeCollaborator(profileId, clientUser, {configureCb?, requireRole?})`, so every non-owner
  entry point applies the same gate. `receiveExternalMessage()` — the chat-integration path, whose
  agent reply can surface anything the workspace has already read — passes `requireRole: "build"`
  and no `configureCb`: it has no channel to prompt on, so an unverified caller is told to open the
  workspace in a browser, and an insufficient role is denied *before* verification runs rather than
  being sent to fix a failure that could never grant them access anyway.

#### Restarting when verification scope widens

Verification runs at `open()` and nowhere else, so a live session is only ever as verified as the
scope that existed when it opened. When that scope **widens**, the overseer restarts the workspace
rather than trying to re-verify sessions in place: `#restartIfSessionsAffected(reason,
affectedRole?)` delegates to `scheduleAccessRestart(reason)` — the same DO abort used to revoke a
collaborator (see `docs/sharing.md`) — so every client's browser reconnects and re-runs
`authorizeCollaborator`/`ensureObserver` against the new scope.

What it gates on is a **live session** of the affected role, not an entry in the sharing table:
severing sessions is all a restart achieves, so a collaborator who isn't connected has nothing to
cut, and a solo workspace is never disturbed. `OverseerImpl.joinSession(kind)` counts them, called
synchronously in each client interface's constructor and released in its `[Symbol.dispose]`, with
the owner counted apart from the two collaborator roles because the owner is never an observer.
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
  internal construction. The raw gadget facet stub `connectToGadget()` returns counts the same
  way (`getGadgetFacet`'s `joinAs`, released when the stub is disposed): it is the very stub an
  enabled hook's data flows through, and unlike a bind — which aborts gadget facets via
  `bumpVersion` — enabling a hook leaves existing facets running, so an uncounted retained facet
  would let that widening find no session to sever.
- **Known gap — `enableHook` neither counts nor aborts gadget-minted children.** The facet-stub
  lease above covers only the stub the overseer minted; a gadget-minted child is independently
  owned (see the preamble) and reachable only by the facet abort — which every binding mutation
  performs and hook enable, alone among the widenings, does not. A client that disposes its
  counted wrappers but retains a gadget-minted child therefore leaves `use` count 0 when a hook
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
- **In-flight authorization** counts as a session-to-be: `authorizeCollaborator` holds a lease for
  the resolved role across `ensureObserver`, which can park indefinitely on collaborator-controlled
  awaits (the configuration modal, verifier RPCs). A widening then schedules the restart, the DO
  reset takes the parked open with it, and the client retries against the new scope. Between the
  lease's release and `open()` constructing the counted interface there are only microtask
  continuations, in which no incoming event can be delivered, so nothing can observe the count dip
  to zero across the handoff.
- **`receiveExternalMessage`** holds a `build` lease for a non-owner caller from the moment
  `authorizeCollaborator` admits them until the call completes, since it produces a reply from
  workspace data without ever constructing a counted interface. The lease deliberately starts
  only after authorization (verification itself is covered by `authorizeCollaborator`'s internal
  lease): a caller who is turned away must never have counted, or a stranger racing an
  `addGatekeeper()` would cause a needless workspace reset.
- **Known gap — the agent turn an external message starts** outlives that RPC's lease (it is
  fire-and-forget, and its persisted `ActiveAgentRecord` even survives DO resets, resuming with
  no re-verification), so a widening mid-turn finds no session to sever and the reply egresses
  to the persisted external response target under stale verification. Tolerated only because
  nothing calls `receiveExternalMessage` yet; the required fix (a per-turn `build` lease from
  `#registerRunningAgent` to `#unregisterRunningAgent`, persisted as a marker on
  `ActiveAgentRecord`, plus `authorizeCollaborator` re-run on resume with the turn cancelled on
  denial) is spelled out in the comment at the endpoint and must land before it gets real
  callers. Owner and UI-collaborator turns are not affected: the owner is never an observer, a
  UI collaborator's replies land in the chat log behind re-verified opens, and gadget-callback
  turns have no external egress.

  The same mechanism has a spawner variant: a `use` collaborator holding a bound spawner's
  loopback can start a spawn during the window between a widening's restart being scheduled and
  the reset landing (`spawnAgent` checks no quarantine, and the spawner itself is vendorless so
  it is never the thing quarantined). The spawn persists an `ActiveAgentRecord` that the reset's
  storage sync commits, and the resumed turn re-runs no authorization — so it completes with its
  creator's authority against the pre-widening scope. Bounded, unlike the external-message case:
  the resumed turn has no external egress, its output lands in workspace state, and every
  `use`-role reader of that state re-verifies at their next open against the now-widened scope —
  so the only unverified consumption is inside the restart's own delivery window, which the
  design already tolerates for sessions the reset is about to sever. The per-turn-lease fix
  above (re-run `authorizeCollaborator` on resume, cancel on denial) closes this variant too.

Four events trigger it:

| Event | What grows |
|---|---|
| `addGatekeeper()` with a vendor-backed `creationSpec` | **build** scope — a live `build` session can `getGatekeeperById()`/`openSession()` on it with no observer check |
| `bindWorkpiece()` for a permanent (non-`chatId`) edge onto a vendor-backed connection — or onto a legacy (pre-`creationSpec`) one, which nobody *can* be verified against, so it restarts and quarantines and fresh `use` opens then fail closed on the reconnect-required error | **use** scope — the gadget UI a `use` session drives can now invoke it |
| A merge that promotes a pending gadget or a pending binding edge into `use` scope | **use** scope, same reason |
| `enableHook` on a vendor-backed connection not already in `use` scope | **use** scope — the hook delivers the connection's data into a gadget a `use` session can open (a hook waking a still-provisional gadget stays out of `use` scope until promotion; the merge diff reports that widening) |

The two roles widen independently, so each trigger passes the role it grew and the restart is
skipped when no collaborator holds it: a new connection is in every `build` collaborator's scope
at once but in no `use` collaborator's until a gadget binds it, and binding one enters `use` scope
having been in `build` scope since it was created. A workspace shared only the other way has nobody
with new verification requirements.

The three `use`-scope triggers share one helper (`#restartIfUseScopeWidened`) that compares the
effective `use` scope before and after rather than firing on any mutation: most merges promote
something, and a promoted gadget with no bindings, an edge onto a vendorless connection nobody is
verified against, a second name onto a connection already in scope, or a hook on an
already-bound connection all widen nothing and must not sever a shared workspace for nothing.

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
`use`-scope triggers mark each id their diff widened (marking gatekeeper ids suffices as
quarantine because a binding loopback is not a session but a per-call route: its props name the
target and every call re-resolves a session through `openSession`, where the mark is checked —
so the quarantine holds even for a loopback retained across a facet abort or the reset itself,
which is *not* merely "re-minted on facet reload"). Every route to a marked connection refuses with a retryable error until
the reset destroys the mark along with the sessions: `getGatekeeperById` (the mint clients
pipeline on), `GatekeeperClientImpl.openSession` (which binding loopbacks also pass through), the
slash-command invoke in `#prepareChatMessage`, `GadgetClientImpl.bindWithSuggestedName`, and
`startHook` — the inbound gatekeeper→gadget delivery route, whose arming enable may itself be the
widening that scheduled the restart — while the enumerating routes (`listSlashCommands`, the
ambient catalog load and seed materialization in `prepareChatBindings`) silently omit it until
clients reconnect. Publish,
restart-check, and mark share one synchronous block, so no request can interleave between the
change appearing and the block taking effect; marks are only ever set when a restart is
scheduled, since nothing else would clear them.

### Step 4 — Frontend: the configuration modal

Implement the `ObserverConfigCallback` on the client. When the overseer calls `configure(needs)`:

1. For each `ObserverBindingNeed`, find the user's candidate accounts by filtering the existing
   `subscribeConnectedAccounts()` results (`user.ts:890`) by `need.vendorId`.
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

Extend `authorizeObservation()` (`overseer.ts:1169`) to honor `description.excludeObservers`.
Because v1 has no per-thread hiding, an excluded-but-named observation can only proceed when the
named observer cannot reach it at all: either they have *already lost access* in the sharing graph,
or the connection that produced it has left their role's verification scope.

For each id in `description.excludeObservers`:

1. Map the opaque `observerId` → `profileId` via the `observers.byObserverId` index. If there is
   no record, the id is not an active observer → ignore it.
2. Check sharing-graph reachability for that `profileId`
   (`SharingManager.getEffectiveRole` / `computeEffectiveRoles`).
   - **Still authorized, and the producing gatekeeper is still in that role's scope → throw**,
     blocking the observation (degrade to per-observation lockdown). Use a clear message, e.g.:
     `"This observation was blocked because it contains data that a current collaborator is not permitted to see."`
   - **Still authorized, but the gatekeeper has left their scope → allow** for this observer, and
     drop their registration on *that gatekeeper only* (`removeObserver(observerId)`), keeping the
     record. The scope test is `#inRoleVerificationScope` and is deliberately narrow and
     fail-closed: the only way out is "role is `use`, the connection requires an account, and
     neither a gadget binding, an enabled hook, nor a bound agent spawner's env makes it
     reachable" (`#useScopeGatekeeperIds` — an enabled hook keeps writing the connection's data
     into a gadget the collaborator can open, and a bound spawner's env keeps handing it to
     agents the collaborator can spawn, so both block exactly as a binding does). This is the
     case a stale registration creates — a
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
     `startGatekeeperSession`'s gatekeeper branch, beside `openSession`'s quarantine check. Until
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

> Why not also worry about authorized-but-not-yet-configured users here? They cannot be named in
> `excludeObservers` because no gatekeeper knows their id yet. The invariant still holds from the
> other direction: when such a user later opens and configures, `addObserver` re-checks them
> against *all* past observations (including any restricted one) and throws, denying them. So
> forward exclusion only needs to handle already-configured observers.

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
  For each who is now unreachable, if they have an observer record: best-effort
  `removeObserver(record.observerId)` on **all** gatekeeper facets, then delete the observer
  record.
- For a **`build` → `use` downgrade**, optionally `removeObserver` (and drop the corresponding
  `accountChoices` entries) for the now-out-of-scope bindings (those without a `bindingName`).
  Safe to defer — an over-broad observer set only ever errs toward stricter future checks — but
  it keeps gatekeeper state tidy.
- All these calls are best-effort: log and continue on error. An orphaned observer entry only
  causes superfluous future checks, never a data leak: a registration is what *admits* an open, and
  every open re-runs `addObserver`, so a stale one grants nothing on its own — while
  `authorizeObservation`'s exclusion gate re-checks the live sharing graph for any id a gatekeeper
  still names.

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
4. **`prohibitAllSharing` interaction** — unchanged and still authoritative: if set, no non-owner
   can open at all (`overseer.ts:2770`). Observer checks only matter when sharing is allowed.
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
   in-scope connections, so they never appear in `excludeObservers` from a connection that was
   never in their scope (the gatekeeper doesn't know their id). The Step 5 logic handles this
   naturally (unknown id → ignored). A connection that *was* in scope and has since left it
   (unbound, with no enabled hook keeping it reachable) is the different case Step 5's scope test
   handles: the gatekeeper still knows the id, but the observer can no longer reach what it
   produces, so they are de-registered from it instead of blocking.

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
2. **API plumbing** — `ObserverConfigCallback` + `open()`/`openGadget()` signature (Step 2).
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
  This is the replacement for today's reliance on `prohibitAllSharing` for these resources (the
  `prohibitAllSharing` lockdown mechanism itself is unchanged and remains available separately).
  `getVerifier()` must still exist (the overseer mints one on every open) but is never consulted.

- **B — ACL check (single unit).** The resource is treated as one atomic unit.
  `getVerifier()` mints a verifier exposing the observer's vendor identity (via the
  "non-standard method on the verifier" pattern, `gatekeeper.ts:456-461`). `addObserver()` resolves
  that identity and checks it against the bound resource's ACL, throwing on failure. Gatekeepers
  should cache per-open to bound cost (`gatekeeper.ts:511-516`). No `excludeObservers` is needed:
  the whole unit is covered up front, so nothing read later could be invisible to a verified
  observer.

- **C — Data-set tracking.** The `Gatekeeper` DO maintains its own log of the **data sets** it has
  actually observed (e.g. BigQuery dataset, Linear team, Notion page/database, Supabase project),
  plus the set of current observers. `addObserver()` verifies the observer against **every** logged
  set so far. When a later observation first touches a **new** set, the gatekeeper re-verifies all
  current observers and sets `excludeObservers` for any who fail (the overseer then blocks the
  observation per `gatekeeper.ts:751-774`). `removeObserver()` drops the observer from the tracked
  set. Each per-set check reuses the same ACL primitive the corresponding narrow (B) binding uses.

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
| **google** | Google Calendar (selected calendar) | **B** | Require `writer` or `owner` access to the bound calendar, since `reader` access hides private-event details. Future: let the binding owner exclude private events so readers can collaborate. |
| **google** | Google Calendar (`allVisible` availability) | **C** | In addition to the selected-calendar check, track foreign calendars whose free/busy data was successfully read and verify each observer can independently query their availability. |
| **google** | Gmail Mailbox | **A** | Always throw. (Future: allow observers who independently have access, e.g. mailing-list members — explicitly out of scope now.) |
| **google** | BigQuery | **C** | Track accessed datasets; verify the observer's IAM access to each. Dataset granularity for now (tables/columns later). |
| **linear** | Team / Issue | **B** | Check the observer's workspace/team membership, honoring team privacy. |
| **linear** | Workspace | **C** | Track accessed teams; verify the observer against each (reusing the Team B check). |
| **notion** | Page / Database | **B** | Check the observer's Notion access to the bound page/database. |
| **notion** | Workspace | **C** | Track accessed pages/databases; verify the observer's access to each. |
| **supabase** | Project | **B** | Verify the observer's own `listProjects()` (`supabase-api.ts:306`) includes the bound project ref. Within a project, arbitrary read-only SQL spans the whole DB, so the project is the atomic unit (no per-table tracking). |
| **supabase** | Organization | **C** | Track accessed project refs (the org session reaches them via `openProject` / `listProjects`, `supabase.ts:1015`/`:1037`); verify the observer's `listProjects()` includes each, reusing the Project B check. |
| **confluence** | Site | **C** | Verify site access; track observed spaces and content because both can have narrower permissions. |
| **confluence** | Space | **C** | Verify space access; track observed pages and blog posts because content restrictions may be narrower. |
| **confluence** | Page / Blog Post | **C** | Verify bound-content access; track observed child pages because they may have stricter restrictions than their parent. |
| **zoominfo** | Account | **A** | Always throw. The whole-account binding exposes licensed, entitlement-dependent and account-specific intelligence, and ZoomInfo provides no ACL oracle proving another account can read every historical result. |
| **context** | Context Library singleton | **C** | Track observed collections; verify each is public in the sharing domain or privately owned by the observer's Context account. |

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
  Library (public/private collections + account/domain ownership checks).
- **Fail criterion 1 → B:** GitHub Repository — issues/PRs/discussions/code all inherit the single
  repo permission, and there is no binding broader than one repo, so the repo is the atomic ACL
  unit.
- **Fail criterion 2 → D (or A):** Home Assistant Instance — areas/devices/entities exist but the
  long-lived token is all-or-nothing and HA has no per-user ACL oracle, so there is nothing to
  verify an observer against. (Spotify is moot: ACL enforcement is off entirely under D.)
- **Decomposition deliberately deferred → A:** Gmail Mailbox — could in principle decompose into
  mailing lists the observer belongs to, but that is the out-of-scope "advanced" case, so it stays
  fully private for now.
