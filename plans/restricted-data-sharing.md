# Plan: Govern sharing of restricted data by observer verification

## Goal

Replace the all-or-nothing sharing lockdown that a restricted-data observation imposes
with a per-collaborator check: a workspace that has read restricted data stays
shareable, and each collaborator is admitted only while they are verified as an
observer of the gatekeeper that produced the data.

**Known security limitation:** that guarantee is currently scoped by collaborator role.
A `use` collaborator is verified only against gatekeepers in their scope — those bound to a
gadget or fed by an enabled hook (`#useScopeGatekeeperIds`). The workspace
agent can nevertheless read an unbound gatekeeper through a chat binding (including an
ambient singleton), persist its restricted result into gadget storage or UI state, and
thereby expose it to an unverified `use` collaborator. This plan accepts that risk for the
current implementation; "Never-bound producers" below records the exact boundary and the
required future remedies.

Delivered as **one PR, split into reviewable commits** (see "Commit sequence" at the
end). The kernel packages (`workshop-backend`, `workshop-shared`) get the small,
separated diffs; the rename, the UI, and the frontend share-key work ride in their own
commits.

## Locked decisions

- **The flag is renamed, not aliased.** `ObservationDescription.prohibitAllSharing`
  becomes `containsRestrictedData`, and `GadgetMetadata.sharingProhibited` becomes the
  same name. The flag states a fact about the data ("this observation contains
  restricted data"); what the platform does about that is policy and does not belong in
  the name. A hard rename means every gatekeeper call site moves in the same commit —
  TypeScript's excess-property check on the object literals passed to
  `authorizeObservation` will not tolerate a staged one.
- **The durable storage key keeps its old name.** Typed-storage keys *are* property names,
  so renaming the overseer's singleton would silently unlatch every workspace that has
  already observed restricted data. The property is renamed anyway, and declares the old
  key explicitly: `containsRestrictedData: singleton(false, {storageKey:
  "prohibitAllSharing"})`. `storageKey` is a typed-storage schema option added for this,
  so the exception lives in the schema rather than as a special case at each call site.
- **Admission is per-collaborator, checked continuously.** Not at grant time: at every
  `open()`, so revocation of a collaborator's underlying resource access is caught
  promptly. Nobody is in the workspace without having passed the producer's
  `addObserver()`, and anything that widens what they must pass restarts every live
  session so it re-opens at the new scope (`#restartIfSessionsAffected`).
- **Coverage is held to each collaborator's own role scope.** `ensureObserver` never
  verifies a `use` collaborator against a gatekeeper outside their scope. This is a liveness
  tradeoff, not a security guarantee: restricted data can flow from that gatekeeper
  through the agent into gadget-visible state. The exception for an unbound producer and
  a `use` collaborator is the known security risk stated above.
- **Share-key redemption stays one-step.** Redeeming a key writes a real edge
  immediately, as on main. The redeeming open then verifies the recipient like any other
  collaborator. Two consequences are accepted on the ledger below: an unverified
  redeemer, and a refused recipient, both persist in `listCollaborators` until removed.
  Two-phase redemption (a pending edge granting nothing until verification confirms it)
  is the planned follow-up fix for both.
- **One authorization gate for every non-owner entry point.** `authorizeCollaborator`
  resolves the effective role and runs `ensureObserver`. Both `open()` and
  `receiveExternalMessage()` pass through it; the latter non-interactively, since there
  is no way to configure connected accounts from an inbound message.
- **Removing the producing connection is not guarded.** The latch stays set, but nothing
  stops the removal even though the record is what collaborators are verified against.
  There is no UI to remove a connection today; when one is built, it will require the
  owner to certify that no sensitive data from the connection has been retained in the
  workspace, for any connection.
- **Fail closed everywhere.** An operational failure — provider outage, expired
  credential — is treated exactly like a refusal.

## Current-state anchors (for orientation)

- `authorizeObservation` (overseer.ts) is where a gatekeeper's observation is admitted
  or refused, and where the durable restricted-mode flag latches.
- `ensureObserver` (overseer.ts) brings a non-owner into compliance for their role:
  selects in-scope gatekeepers, prompts for unconfigured account choices via
  `configureCb`, calls `addObserver` on each gatekeeper facet, and persists an
  `ObserverRecord` only after all of them succeed. Re-runs on every open. Throws to deny.
- `SharingManager` (sharing.ts) owns the permission graph: collaborator records, their
  `addedBy` edges, share links and keys, and `computeEffectiveRoles`' fixed-point
  resolution. The module header states that sharing *policy* deliberately lives outside
  it.
- `#inScopeGatekeepers(role)` derives what a collaborator must be verified against.
  `use` scope is live gadget-binding state; `build` scope is broader.

## Design

### 1. Admission

Coverage is enforced by admission rather than per observation. `ensureObserver` verifies
each collaborator against every in-scope gatekeeper at every `open()`, and
`#restartIfSessionsAffected` aborts the DO whenever that scope widens (a connection added,
one bound into a gadget, a merge promoting such a binding, a hook enabled), so no live
session outlives the scope it was verified at. It is a no-op unless a collaborator session
of the widened role is live — severing sessions is all a restart does.

### 2. One-step share-key redemption (sharing.ts)

`redeemShareKey` keeps main's shape: hash the key, resolve the link, and write a real
`shareKey` edge (creating the collaborator record if they're new), deduplicating against
an existing edge for the same link.

The edge is real before the redeeming open's observer verification runs; the two
resulting windows (an unverified redeemer and a refused recipient, each persisting in
`listCollaborators` until removed) are the accepted consequences on the ledger, marked by
the TODO at `redeemShareKey`.

### 3. The unified gate (`authorizeCollaborator`)

Resolves the effective role, denies below `requireRole` *before* verification runs, then
calls `ensureObserver`. This PR introduces the gate with both non-owner entry points as
callers: `open()` interactively and `receiveExternalMessage` non-interactively (the
latter previously checked only the role).

Denying early matters: without it a `use` collaborator reaching `receiveExternalMessage`
would be verified (real `addObserver` calls, a persisted record) only to be turned away,
or worse, told to fix a verification failure that could never grant them access.

Because redemption writes a real edge, a redeemer mid-verification is visible to the
revocation affected-set like any collaborator: a link revoked (or a removal landing)
while their open is parked triggers the revocation restart, which severs their session
and re-runs `open()` against the live graph.

### 4. Observer records on a failed live check

An earlier draft scrubbed the failed gatekeeper from the collaborator's persisted
`accountChoices` and restarted the workspace on the failure. The observer machinery
landed on main (#380) without either: an `accountChoices` entry records the account the
collaborator chose so they are not asked again, and asserts nothing about whether the
gatekeeper still admits them — every open re-runs `addObserver`, so a revoked
collaborator is denied at their next open regardless, and only that open is denied (the
lazy-revocation residual in `docs/observers.md` edge case 3). Nothing in this model reads
`accountChoices` to admit a restricted read, so the scrub is not a precondition of it.

### 5. Frontend

- **Share modal**: no longer replaces itself with a "can't be shared" view. Controls stay
  live behind a notice.
- **No share-key retention.** The `#share=` fragment is stripped from the URL on open and
  sent once. If that first open fails before the server redeems the key, the retry is
  keyless and the user re-clicks the invite link. A client-side retention tier
  (`sessionStorage` plus an in-memory ref) was built and then dropped from
  `restricted-data-followups`: keeping the key across retries, reconnects and reloads
  reopened replay-after-removal and cross-user paths that took identity stamps, generation
  tokens, a TTL and cross-tab broadcasts to close, all for a residual that costs one link
  re-click.

## Commit sequence (one PR)

Ordered so the kernel-critical diffs are isolated. Every commit type-checks green across
`workshop-shared`, `workshop-backend`, `workshop-frontend` and `gatekeeper-google`.

This PR is built directly on main and carries the model change alone. The observer
machinery it builds on has a set of preexisting concurrency races (and this PR's own
model adds atomicity hardening on top); those fixes are deferred to follow-up work.
Each deferred fix is acknowledged at its site with a `TODO` comment; the docs collect
the same items in their Known-limitations sections. The observer-side groundwork this
plan once carried — the unified `authorizeCollaborator` gate on the external-message
path, and the scope-widening restart — landed separately in #380.

1. **Refactor — the rename.** Mechanical, no behavior change, spanning
   `workshop-shared`, `workshop-backend`, `workshop-frontend`, `gatekeeper-google`,
   `gatekeeper-mcp` and the gatekeeper-authoring skill doc. Atomic by necessity.
2. **Part 1 — API.** The restated contract on `containsRestrictedData`. Server still
   implements the old behavior.
3. **Part 2 — core server implementation.** The latch, the removal of `hasAnyShares`
   and the sharing checks, and the TODO ledger.
4. **Part 3 — backend tests.**
5. **Part 4 — integration tests.** Over real Durable Objects, through the test
   gatekeeper fixture's `readValue(restricted)` and its controllable verification
   outcome.
6. **Part 5 — documentation.** `docs/observers.md` coverage rules and residuals;
   `docs/sharing.md` one-step redemption; this plan.
7. **Part 6 — drop the producer guards per review.** Deletes the unverifiable-producer
   refusal, the producer-removal guard, `assertNewSharingAllowed` and the
   `assertGrantAllowed` plumbing, the action-log scan, and the legacy flag shim.

The deferred items are collected in the Known-limitations section below. The Share
modal unblock lives in `restricted-data-followups`.

## Known limitations

Revocations and role changes take effect within seconds (the revocation restart lands in
~100ms), and read-side races inside that envelope are accepted by design: a deferred fix
stays on this ledger only if its failure mode is *persistent* wrong state that outlives
the window. Each item is marked in the code by a matching `TODO` comment; this ledger is
the follow-up worklist.

- Observer verification is not serialized per profile, so concurrent opens by one
  collaborator can overwrite each other's records and registrations.
- A mid-registration observer named in `excludeObservers` is read as unknown and the
  observation admitted: a first-time `ensureObserver` registers the id with the
  gatekeepers before the record is persisted, so `#enforceExcludeObservers` cannot map it
  back during that window. Persistent (the observation lands in chat history). Fix: an
  in-memory pending-id map consulted there, failing closed — `observer-verification-fixes`.
- An unverified redeemer persists as a collaborator: redemption writes a real edge
  before the redeeming open's verification runs, so from click onward the recipient is
  visible in `listCollaborators` whether or not they ever complete the open (remedies:
  verify, remove, or revoke the link). Two-phase redemption is the planned fix.
- A refused recipient persists: a recipient whose verification is refused keeps their
  edge and stays in `listCollaborators` until removed; the same planned fix.
- A failed re-verification denies only the open being attempted. Sessions the
  collaborator already holds keep the access their own opens verified until they next
  re-open — the lazy-revocation residual `docs/observers.md` edge case 3 already accepts,
  so it grants no access they do not already hold.

## Known edge cases / watch-fors

- **Operational failures deny like refusals.** An outage or expired credential denies the
  collaborator's open exactly as a revocation does (the overseer cannot tell them apart);
  they get back in as soon as a repaired open re-verifies them. Fail-closed by design.
- **Role increases do not ride out on a redeeming open.** An owner grant landing while
  verification waited takes effect at the recipient's next open, exactly as for an
  ordinary keyless open.

## Accepted tradeoffs / future work

- **Formerly-bound producers.** Unbinding shrinks `use` scope with no guard, so a
  formerly-bound producer's sensitive reads stop requiring `use` collaborators'
  coverage. Accepted because `use` sessions cannot read chat history or the action log;
  the data entered gadget storage while the producer *was* bound, when every `use`
  collaborator was verified against it or could not open the workspace; and re-binding
  restores verifiability at the next open. The residual is `use` grants created after the
  unbind. The chat-history argument does not cover a binding loopback retained across the
  unbind, which returns the read directly as an RPC result and stays callable until
  `removeGatekeeper`; that is the `docs/observers.md` Step 5 known gap, with `#assertBindingEdgeLive` as the
  named fix.
- **Known security risk — never-bound producers.** A producer reachable only through chat
  bindings (including an ambient singleton) is never in a `use` collaborator's verification
  scope. The agent can read restricted data from it, persist the result into gadget code,
  storage, or UI state, and the collaborator can then read that state through the deployed
  gadget despite never passing the producer's `addObserver()` check. Role-scoped
  verification deliberately never asks this collaborator about that producer, so
  `containsRestrictedData` does not prevent this disclosure. Binding the producer makes
  future opens verifiable but does not retract data already exposed. Accepted temporarily
  to avoid making the read permanently unavailable
  under the current role-scoped model. The required fix is either workspace-wide observer
  verification for `use` collaborators or enforceable provenance that prevents data from an
  unverified producer reaching their gadget-visible state. Both this and the formerly-bound
  residual are documented at `docs/observers.md` edge case 4.
- **`calculate()`-style aggregates are out of scope here.** This plan governs *who* may
  see restricted data, not what an aggregate over it discloses.
- **Verification remains interactive-only.** `receiveExternalMessage` can verify but
  cannot configure, so a caller with unconfigured account choices is told to open the
  workspace. A non-interactive configuration path is future work.
