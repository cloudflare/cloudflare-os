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
latches the workspace into a restricted mode — no actions, no web fetches — and is admitted only
if every current collaborator has been verified against the gatekeeper producing it; see the
coverage guard, `#assertSensitiveObservationCoverage`, in `overseer.ts` and edge case 4 below.)

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
- **Role-based breadth of verification:**
  - **`build`** collaborators (full access — chat + code + all bindings) must be verified
    against **every** gatekeeper the Gadget has.
  - **`use`** collaborators (UI only, no chat access — see `UseOverseerInterface` in
    `overseer.ts`) must be verified only against **named bindings** (gatekeepers with a
    `bindingName`), since that is all the UI can invoke.
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
| Overseer DO, `open()` auth entry point | `packages/workshop-backend/src/overseer.ts` |
| Server `openGadget` path | `packages/workshop-backend/src/server.ts` |
| Role resolution / permission graph | `packages/workshop-backend/src/sharing.ts` (`getEffectiveRole`, `computeEffectiveRoles`) |
| `containsRestrictedData` enforcement | `overseer.ts` (`authorizeObservation` coverage guard, `getWebFetchEnv`, `submitAction`) |
| Observation recording | `overseer.ts` `authorizeObservation()`; `ApprovalQueueImpl` |
| Gatekeeper storage record | `overseer.ts` `GatekeeperRecord` (has `creationSpec.vendorId`) |
| `GatekeeperCreationSpec` | `packages/workshop-shared/src/api.ts` |
| Gatekeeper facet access | `overseer.ts` `getGatekeeperFacet()` |
| Overseer storage collections | `overseer.ts` (`gatekeepers`, with `byBindingName` index — template for a new collection) |
| Connected accounts (User DO) | `packages/workshop-backend/src/user.ts` `ConnectedAccountRecord` (`account: Fetcher<GatekeeperUser>`, `vendorId`) |
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
`overseer.ts`, including a secondary index for reverse lookup):

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

### Step 2 — Client-server API: a configuration callback on `open` / `openGadget`

We must avoid structured/typed errors for control flow (prohibited in this codebase) and must not
break promise pipelining in the common case. So `open()` gains an **optional callback** that is
invoked **only** when the opening user needs to configure gatekeeper accounts. In the common case
(owner, or an already-configured observer) the callback is never called, and `open()` resolves
without an extra round trip.

Add to the RPC API (`packages/workshop-shared/src/api.ts`) and thread through
`server.ts` `openGadget` → `overseer.open()`:

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
   - `use`: only those with a `bindingName`.
   - A `creationSpec` with a `vendorId` requires an account; other specs need no verifier or account
     choice.

2. **Load the observer record** for `profileId` (may be absent).

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
     (or no longer) allowed: best-effort `removeObserver(record.observerId)` on the gatekeepers
     added in *this* pass, do **not** persist the working record, and deny the open with a clear
     message.

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
Because v1 has no per-thread hiding, the only case in which we can let an excluded-but-named
observation proceed is when the named observer has *already lost access* in the sharing graph.

For each id in `description.excludeObservers`:

1. Map the opaque `observerId` → `profileId` via the `observers.byObserverId` index. If there is
   no record, the id is not an active observer → ignore it.
2. Check sharing-graph reachability for that `profileId`
   (`SharingManager.getEffectiveRole` / `computeEffectiveRoles`).
   - **Still authorized → throw**, blocking the observation (degrade to per-observation
     lockdown). Use a clear message, e.g.:
     `"This observation was blocked because it contains data that a current collaborator is not permitted to see."`
   - **No longer authorized → allow** for this observer, and **delete their observer record**
     (and best-effort `removeObserver(observerId)` on all gatekeepers). They are no longer set up
     to observe; if they ever regain access they reconfigure from scratch (Step 3).
3. If, after evaluating all excluded ids, none are still-authorized, allow the observation.

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

- After a mutation, use the returned `AffectedCollaborator[]` to find users who **lost access**.
  For each who is now unreachable, if they have an observer record: best-effort
  `removeObserver(record.observerId)` on **all** gatekeeper facets, then delete the observer
  record.
- For a **`build` → `use` downgrade**, optionally `removeObserver` (and drop the corresponding
  `accountChoices` entries) for the now-out-of-scope bindings (those without a `bindingName`).
  Safe to defer — an over-broad observer set only ever errs toward stricter future checks — but
  it keeps gatekeeper state tidy.
- All these calls are best-effort: log and continue on error. An orphaned observer entry only
  causes superfluous future checks, never a data leak (the leak-relevant gate is
  `authorizeObservation`, which keys off the live sharing graph).

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
   model in `sharing.ts`. The denial also scrubs each failed gatekeeper from the collaborator's
   persisted observer record (and best-effort de-registers them gatekeeper-side), so the
   sensitive-observation coverage guard (edge case 4) blocks that producer's later restricted
   observations — including to the collaborator's still-live sessions — until a successful
   re-open re-persists coverage, or the collaborator is removed. The residual under the lazy
   model: a collaborator who never re-opens keeps their record and any live session, but once
   scrubbed they *block* that producer's restricted reads like any unverified collaborator.
   An operational failure (vendor outage, expired credential) scrubs the same way — the
   overseer cannot tell it from a settled denial, so coverage fails closed until a repaired
   re-open.
4. **`containsRestrictedData` interaction** — a sensitive observation is admitted only if every
   current collaborator *in whose role-scope the producing gatekeeper falls* holds an observer
   record covering it
   (`#assertSensitiveObservationCoverage` in `authorizeObservation`); otherwise it is blocked
   with a message naming the unverified collaborator. Coverage is held to each collaborator's own
   verification scope because `ensureObserver` can never verify beyond it: a `use` collaborator
   can't be covered for a gatekeeper no gadget binds, so demanding that would block the read
   permanently (an unverifiable gatekeeper — no vendor account, or a legacy record — blocks
   on any collaborator regardless of role). At open() time, `ensureObserver` re-verifies each
   collaborator against every in-scope gatekeeper, which is what admits (or refuses) them for
   sensitive data. The flag also latches the workspace into a restricted mode that blocks
   actions and web fetches.
   `use` scope is *live* binding state, with a transition case in each direction. Adding a
   binding grows it, and edge case 5 covers the interim. Unbinding shrinks it with no guard:
   a formerly-bound producer drops out of `use` verification scope, so its sensitive reads
   stop requiring `use` collaborators' coverage — the same skip as a never-bound producer,
   though the liveness argument above doesn't apply to it. Accepted because (i) `use` sessions
   cannot read chat history or the action log, so the exposure is limited to state the gadget
   persisted, served through the gadget's own UI or export; (ii) that data entered gadget
   storage while the producer *was* bound, when every `use` collaborator was verified against
   it or the read was blocked; (iii) the residual is `use` grants created after the unbind,
   who view that persisted state unverified — and re-binding the connection restores their
   verifiability at their next open.
   The *never*-bound flavor of the same skip is broader: a producer reachable only through
   chat bindings (an ambient singleton the agent reads in chat) was never in any `use`
   collaborator's scope, so premise (ii) does not hold for it — the agent can persist its
   restricted data into gadget code or storage without any `use` collaborator ever having
   been verified against it, and there is no prior binding for "re-bind" to restore.
   Accepted on the same grounds: coverage there is unverifiable by construction (the
   liveness argument above), `use` sessions still cannot read chat history or the action
   log, so the exposure is limited to what the agent chose to persist, and the forward
   remedy is binding the producer to a gadget — that puts it in `use` scope, so every
   collaborator is verified against it at their next open.
5. **Owner adds a new binding after sharing** — existing observers see an incremental modal for
   just the new binding on their next open, and may be denied if they lack access to the new
   resource (inherent to the security model). Adding a binding does not restart live sessions,
   so an already-open collaborator is only verified against it at their next open; the coverage
   guard (edge case 4) covers the interim, blocking the new connection's sensitive reads until
   every collaborator has been verified against it.
6. **Performance** — `ensureObserver` does one `getVerifier` + one `addObserver` per in-scope
   gatekeeper per open. Parallelize with `Promise.all` and pipe the verifier promise straight into
   `addObserver`. Expensive gatekeepers cache on their side.
7. **`use`-role observers and `excludeObservers`** — `use` observers are only configured against
   named bindings, so they will never appear in `excludeObservers` from a non-named binding (the
   gatekeeper doesn't know their id). The Step 5 logic handles this naturally (unknown id →
   ignored).
8. **Removing a connection that read restricted data** — while the workspace is latched
   (`containsRestrictedData`) *and* shared, `GatekeeperClient.remove()` refuses: the gatekeeper
   record is what observer verification (and the coverage guard) runs against, and the restricted
   data outlives the connection in chat history and storage, so deleting the record would let a
   never-verified collaborator open unchecked. Outstanding (unrevoked) share links block removal
   the same way: a link creates no collaborator state until redeemed, keys are multi-redeemable
   and never expire, and redemption is gated at open() only while the record exists — so a link
   redeemed after removal would grant the same unchecked access. The remedy is to remove
   collaborators and revoke share links first.
   The guard is scoped to the *producer* connections — those through which restricted data was
   actually read, derived from the permanent action log (`restrictedProducerIds`) — since only
   they anchor restricted-data verification; a non-producer connection stays removable while
   shared. Unverifiable records (legacy, or no vendor account behind them) are exempt even as
   producers — they anchor no verification, and removing one is itself a remedy. For a *legacy*
   record that remedy is also an access-widening event for existing grants: while the record
   exists, `#inScopeGatekeepers` throws on every non-owner open (a workspace-wide hard deny),
   so removing it readmits existing collaborators — verified against only the surviving
   connections, with the restricted data still in chat history. Accepted because the
   alternative (requiring zero collaborators first, as for verifiable producers) would strand
   the workspace: once the producer is gone, re-adding anyone is refused, so forced pre-removal
   would make it permanently unshareable rather than usable by exactly the people who already
   had grants. (The other unverifiable flavor — aiModel/agentSpawner, no vendor account —
   widens nothing: it was never in any collaborator's verification scope, and its sensitive
   reads were coverage-blocked whenever anyone was shared in.) Internal removals
   (creation-failure rollback, ambient reconciliation) are unguarded.
   The complementary rule: once latched, if any producer connection no longer exists (removed
   while the workspace was unshared, or an exempt unverifiable producer), a new party could no
   longer be verified for the data, so everything that would admit one refuses
   (`assertNewSharingAllowed`): the grant-creating sharing mutators — `addCollaborator`,
   `createShareLink`, `newShareLinkKey` — and `redeemShareKey` at open(). Gating redemption is
   what makes the unverifiable-producer exemption above safe despite outstanding keys: once any
   producer is gone, those keys are dead too — refused before a pending edge is written, and
   before a not-yet-confirmed edge is settled. The grant-creating mutators check synchronously
   with their storage write, so a concurrent connection removal cannot slip between the check
   and the grant. Redemption is two-phase, so it checks twice: once synchronously with the
   *pending* write (`redeemShareKey`), and again in the *confirm's* synchronous block
   (`confirmShareKeyRedemption`, the granting write) — the two are separated by the redeeming
   open()'s await windows, so a producer removed anywhere between redemption and confirm still
   refuses the grant. Existing grants are untouched: a *confirmed* edge skips both checks, so a
   collaborator re-opening with a retained key stays a no-op.

---

## 7. Testing

- **Observer record / sharing accessors:** unit-test any new `SharingManager` accessor and the
  `observers` collection indexes (lookup by `profileId` and by `observerId`).
- **`ensureObserver`:** with a mock gatekeeper facet that records `addObserver`/`removeObserver`
  calls and can be configured to throw, and a mock `clientUser.getVerifier`:
  - build = all gatekeepers in scope; use = named bindings only.
  - first open invokes the `configure` callback with all account-requiring bindings; subsequent
    opens do not (record covers them) but still re-run `addObserver`.
  - a thrown `addObserver` denies the open and triggers best-effort `removeObserver` rollback on
    bindings added in the same pass, and does not persist the record.
  - a failure against an *already-covered* binding scrubs that binding from the persisted record,
    so coverage fails closed after a revocation (edge case 3) instead of admitting the producer's
    restricted reads on stale coverage.
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
  For data that must additionally never leak back out, the `containsRestrictedData` restricted
  mode (no actions, no web fetches) is available separately; combined with strategy A it makes
  the workspace effectively private once sensitive data is observed.
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
| **google** | Google Calendar (selected calendar) | **B** | Require `writer` or `owner` access to the bound calendar, since `reader` access hides private-event details. Future: let the binding owner exclude private events so readers can collaborate. |
| **google** | Google Calendar (`allVisible` availability) | **C** | In addition to the selected-calendar check, track foreign calendars whose free/busy data was successfully read and verify each observer can independently query their availability. |
| **google** | Gmail Mailbox | **A** | Always throw. (Future: allow observers who independently have access, e.g. mailing-list members — explicitly out of scope now.) |
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
