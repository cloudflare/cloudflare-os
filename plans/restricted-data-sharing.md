# Plan: Govern sharing of restricted data by observer verification

## Goal

Replace the all-or-nothing sharing lockdown that a restricted-data observation imposes
with a per-collaborator check: a workspace that has read restricted data stays
shareable, and each collaborator is admitted only while they are verified as an
observer of the gatekeeper that produced the data.

**Known security limitation:** that guarantee is currently scoped by collaborator role.
A `use` collaborator is verified only against gatekeepers bound to a gadget. The workspace
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
- **The durable storage key keeps its old name.** The overseer's `prohibitAllSharing`
  singleton is untouched: typed-storage keys *are* property names, so renaming it would
  silently unlatch every workspace that has already observed restricted data. A NOTE at
  the declaration says so.
- **Persisted records are read through a legacy shim.** Old action-log entries still
  carry `prohibitAllSharing` in their recorded `ObservationDescription`.
  `observationContainsRestrictedData()` (with a local `LegacyObservationDescription`
  type) reads either spelling. This is a read-side shim only — no producer may write the
  old name.
- **Admission is per-collaborator, checked continuously.** Not at grant time: at every
  `open()`, so revocation of a collaborator's underlying resource access is caught
  promptly. Nobody is in the workspace without having passed the producer's
  `addObserver()`, and anything that widens what they must pass restarts every live
  session so it re-opens at the new scope (`#restartIfShared`). `authorizeObservation`
  itself only has to refuse the one producer admission cannot see: an unverifiable one
  (`#assertUnverifiableProducerUnshared`).
- **Coverage is held to each collaborator's own role scope.** `ensureObserver` never
  verifies a `use` collaborator against a gatekeeper no gadget binds. This is a liveness
  tradeoff, not a security guarantee: restricted data can flow from that gatekeeper
  through the agent into gadget-visible state. The exception for an unbound producer and
  a `use` collaborator is the known security risk stated above.
- **Share-key redemption stays one-step.** Redeeming a key writes a real edge
  immediately, as on main, gated by `assertNewSharingAllowed` synchronously with the
  write. The redeeming open then verifies the recipient like any other collaborator.
  Two consequences are accepted on the ledger below: an unverified redeemer, and a
  refused recipient, both persist in `listCollaborators` until removed, which is enough
  to make the workspace count as shared. Two-phase redemption (a pending edge granting
  nothing until verification confirms it) is the planned follow-up fix for both.
- **One authorization gate for every non-owner entry point.** `authorizeCollaborator`
  resolves the effective role and runs `ensureObserver`. Both `open()` and
  `receiveExternalMessage()` pass through it; the latter non-interactively, since there
  is no way to configure connected accounts from an inbound message.
- **Removing the producing connection does not lift the restriction** for existing
  collaborators. It does close the workspace to *new* grants
  (`assertNewSharingAllowed`), since there is no longer an anchor to verify a newcomer
  against.
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
  it — this plan keeps that boundary by passing policy in as `assertGrantAllowed`
  callbacks.
- `#inScopeGatekeepers(role)` derives what a collaborator must be verified against.
  `use` scope is live gadget-binding state; `build` scope is broader.

## Design

### 1. Admission, and the residual guard (`#assertUnverifiableProducerUnshared`)

Coverage is enforced by admission rather than per observation. `ensureObserver` verifies
each collaborator against every in-scope gatekeeper at every `open()`, and
`#restartIfShared` aborts the DO whenever that scope widens (a connection added, one
bound into a gadget, a merge promoting such a binding, or a re-verification failure that
scrubbed a persisted account choice), so no live session outlives the scope it was
verified at. It is a no-op on a workspace with no collaborators.

What survives in `authorizeObservation` is the one producer admission structurally cannot
see: one with no vendor account behind it (`aiModel`/`agentSpawner`, or a legacy record
with no `creationSpec`). `#inScopeGatekeepers` skips those, so no collaborator is ever
asked about them, and its restricted observations are refused outright while the
workspace has any collaborator — consistent with `assertNewSharingAllowed`, which already
treats the same case as unshareable.

The error reaches sandboxed gadget code and agent output — an audience that cannot
otherwise enumerate collaborators — so it reports only that the workspace is shared,
naming neither the collaborators nor their profile ids (the full email on OAuth and CF
Access deployments).

### 2. One-step share-key redemption (sharing.ts)

`redeemShareKey` keeps main's shape: hash the key, resolve the link, and write a real
`shareKey` edge (creating the collaborator record if they're new), deduplicating against
an existing edge for the same link. The one delta vs main is the `assertGrantAllowed`
policy gate, invoked synchronously before the write and only when an edge is actually
added — a no-op re-redemption skips it, so an existing collaborator's re-open with a
retained key is untouched by a latched policy.

The edge is real before the redeeming open's observer verification runs; the two
resulting windows (an unverified redeemer blocking restricted reads; a refused recipient
persisting until removed) are the accepted consequences on the ledger, marked by the
TODO at `redeemShareKey`.

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

### 4. Policy hooks, not policy in `SharingManager`

`addCollaborator`, `createShareLink`, `newShareLinkKey` and `redeemShareKey` all take an
optional `assertGrantAllowed` callback, invoked synchronously with the granting write.
The overseer passes `assertNewSharingAllowed`. A throw persists nothing.

### 5. Observer-record scrubbing on a failed live check

`ensureObserver`'s failure path drops the failed gatekeeper from the collaborator's
persisted `accountChoices` synchronously with the failure determination, and the
terminal catch de-registers invalidated gatekeepers alongside newly-added ones
(`removeObserver` is idempotent). The scrub is scoped to the failed gatekeeper; a
repaired pass re-persists full coverage.

### 6. Frontend

- **Share modal**: no longer replaces itself with a "can't be shared" view. Controls stay
  live behind a notice.
- **Retained share keys** (`retainedShareKeys.ts`, new): the `#share=` fragment is
  stripped from the URL on open, so a failed open had nothing to retry with. The key is
  held in `sessionStorage` under a versioned, per-workspace key, and replayed on the next
  attempt. (Note: under one-step redemption a failed open leaves a real edge, so the
  retry is keyless — revisit this rationale when the follow-up branch rebases.)
- **Identity stamping**: because `sessionStorage` outlives the session that wrote it, each
  entry records the capturing user's id. A read by a different identity ignores *and*
  sweeps it, and `logout()` sweeps the whole prefix including malformed and older
  unstamped entries. Without this, one user's pending share key could be auto-redeemed
  under the next user's account in the same tab.
- **The in-memory tier is bound to its capturing stub**: it is replayed only on the same
  `authenticatedApi` that captured it; any other stub falls through to the
  identity-checked storage tier. This removes the reliance on the rendering invariant
  that an identity change unmounts the editor -- true today, but enforced two files away.
- **Stamps are generation-gated**: the async identity stamp commits through a write token
  taken at capture; clearing a workspace's entry (a successful open) or the logout sweep
  voids every earlier token, so a stamp resolving late cannot resurrect a cleared key.
  The invalidation lives in `retainedShareKeys.ts` because the storage outlives any one
  attempt -- a per-attempt flag guards only its own attempt's writes.
- **A superseded open bails after its identity await**, before creating any capability:
  its cleanup already ran with nothing to dispose, so proceeding would mint a stub
  nothing can reach and publish a stale (or wrong-workspace) capability.

## Commit sequence (one PR)

Ordered so the kernel-critical diffs are isolated. Every commit type-checks green across
`workshop-shared`, `workshop-backend`, `workshop-frontend` and `gatekeeper-google`.

This PR is built directly on main and carries the model change alone. The observer
machinery it builds on has a set of preexisting concurrency races (and this PR's own
model adds atomicity hardening on top); those fixes are deferred to follow-up work.
Each deferred fix is acknowledged at its site with a `TODO` comment; the docs collect
the same items in their Known-limitations sections. Three fixes are carried here
rather than deferred, because the model states them as preconditions (the scrub and the
prune) or because the entry point would otherwise ship unverified (the external-message
gate).

1. **Refactor — the rename.** Mechanical, no behavior change, spanning
   `workshop-shared`, `workshop-backend`, `workshop-frontend`, `gatekeeper-google`,
   `gatekeeper-mcp` and the gatekeeper-authoring skill doc. Atomic by necessity.
2. **Part 1 — API.** The restated contract on `containsRestrictedData`. Server still
   implements the old behavior.
3. **Part 2 — core server implementation.** The restricted-observation guard,
   `authorizeCollaborator` (both entry points: `open()` and, replacing its role-only
   check, `receiveExternalMessage`), the redemption policy gate,
   `restrictedProducerIds`/`assertNewSharingAllowed`, the producer-removal guard, the
   legacy flag shim, and removal of `hasAnyShares`. Places the full TODO ledger for the
   deferred fixes.
4. **Bugfix — scrub persisted coverage on a failed live check** (§5; pulled forward).
5. **Bugfix — prune out-of-scope observer coverage at every open** (pulled forward;
   restores the observer record's "entry present ⇒ verified at the most recent open"
   invariant).
6. **Part 3 — backend tests.**
7. **Part 4 — integration tests.** Over real Durable Objects; the test gatekeeper fixture
   grows an external control surface, real per-account sessions, a per-resource
   restricted flag and a controllable verification outcome.
8. **Part 5 — documentation.** `docs/observers.md` coverage rules and residuals;
   `docs/sharing.md` one-step redemption and the policy hooks; this plan.

The deferred items are collected in the Known-limitations section below. The Share
modal unblock and the retained-share-key frontend work live in
`restricted-data-followups`.

## Known limitations

Revocations and role changes take effect within seconds (the revocation restart lands in
~100ms), and read-side races inside that envelope are accepted by design: a deferred fix
stays on this ledger only if its failure mode is *persistent* wrong state that outlives
the window. Each item is marked in the code by a matching `TODO` comment; this ledger is
the follow-up worklist.

- Observer verification is not serialized per profile, so concurrent opens by one
  collaborator can overwrite each other's records and registrations.
- An unverified redeemer persists as a collaborator: redemption writes a real edge
  before the redeeming open's verification runs, so from click onward the recipient is
  visible in `listCollaborators` whether or not they ever complete the open, which is
  enough to make the workspace count as shared (remedies: verify, remove, or revoke the
  link). Two-phase redemption is the planned fix.
- A refused recipient persists: a recipient whose verification is refused keeps their
  edge, with the same consequence as the previous item, and the same planned fix.
- The exclusion gate's teardown deletes from a snapshot that can go stale across the
  awaited fan-out, so a re-granted profile's *replacement* observer record can be
  deleted, after which exclusions naming the new id fail open persistently.

## Known edge cases / watch-fors

- **A producer removed mid-redemption cannot slip a grant through.** `remove()` refuses
  every restricted producer (unverifiable ones included) while any share link is
  outstanding, and the redemption policy gate runs synchronously with the edge write.
- **The scrub fires on operational failures too.** An outage or expired credential scrubs
  exactly as a revocation does, blocking that producer's restricted reads until the
  collaborator re-opens successfully. Fail-closed by design, but it means a provider
  incident is visible as blocked reads rather than as an error.
- **Role increases do not ride out on a redeeming open.** An owner grant landing while
  verification waited takes effect at the recipient's next open, exactly as for an
  ordinary keyless open.
- **Removing an unverifiable restricted producer — implemented: guarded like any other.**
  `remove()`'s producer guard used to exempt unverifiable records ("removing one is
  itself a remedy"), which was backwards once the data had been read: the record is the
  *blocker* -- `#inScopeGatekeepers` throws on it, so no collaborator can open -- and
  removing it let every existing collaborator open unverified while the restricted data
  persists in chat history, gadget storage and code (`assertNewSharingAllowed` only stops
  *new* grants). Decided and implemented: fail closed -- unverifiable producers are
  guarded like any other (the owner must remove all collaborators and revoke all share
  links first), after which the workspace is permanently owner-only
  (`restrictedProducerIds()` reads the action log, which never forgets the producer).
  Deliberately no migration or reconnect flow: an automatic migration is impossible
  (legacy records never persisted `vendorId`, and the class stub is opaque), and an
  owner-driven reconnect flow was considered and rejected as scope. The documented
  recovery for an owner who wants to share such a workspace is to start a new workspace.

## Accepted tradeoffs / future work

- **Formerly-bound producers.** Unbinding shrinks `use` scope with no guard, so a
  formerly-bound producer's sensitive reads stop requiring `use` collaborators'
  coverage. Accepted because `use` sessions cannot read chat history or the action log;
  the data entered gadget storage while the producer *was* bound, when every `use`
  collaborator was verified against it or could not open the workspace; and re-binding
  restores verifiability at the next open. The residual is `use` grants created after the
  unbind.
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
