# Design record: kernel-owned observer tracking

How it works today is in `docs/observers.md` §10 and `packages/workshop-backend/src/observer-ledger.ts`.
This file records why it is shaped that way and what was deliberately left out.

## Scope

Kernel-only: `workshop-backend`, the shared contracts in `workshop-shared/src/gatekeeper.ts`, and the
integration test fixture. No shipping gatekeeper reports subresources yet; every shipping gatekeeper
keeps the legacy `addObserver`/`removeObserver`/`excludeObservers` protocol unchanged.

## Decisions

- **One method; subresources are optional and decided per observation.** A read that reports
  `ObservationDescription.subresources` on `authorizeObservation()` is checked and recorded by the
  Workshop; one that omits them is legacy, covered by the gatekeeper's own `addObserver()` /
  `excludeObservers`; `[]` says nothing restricts it. There is no per-connection protocol, flag,
  switch, or history import. Both may appear on one observation and both are enforced.
- **Why one method suffices.** RPC validation forwards undeclared properties, so an older Workshop
  would accept `subresources` and ignore them, disclosing a converted read unchecked. An earlier
  design added a separate method only so that call failed closed there. The deployment assumption
  makes that unnecessary: the kernel is always upgraded before any gatekeeper, so a gatekeeper
  that reports `subresources` never meets a Workshop that ignores them.
- **Per-observation migration.** A gatekeeper converts one session / cursor / hook path at a time,
  and may stop a path's legacy bookkeeping only once it reports `subresources`; until then the path
  stays fully legacy-enforced. Nothing in the Workshop needs to notice an upgrade, so no connection
  is ever described to detect one, and nothing is aborted or restarted.
- **Admission is additive.** Every in-scope connection's `addObserver()` runs as before, with the
  verifier minted once per connection; then, only if requirements were recorded through it that the
  role reaches, `verifyObserverAccess()` checks them. A collaborator must pass both. So
  `addObserver()` keeps covering legacy reads and everything recorded before a path converted, and
  a connection that never reports subresources is never asked `verifyObserverAccess()`.
- **Accepted trade-off: a forgotten `subresources` is legacy, not refused.** A converted path that
  omits it is checked only by `addObserver()`, which that path no longer feeds. The Workshop cannot
  tell a forgotten field from an unconverted path; gatekeepers mitigate it by making `subresources`
  required in their own migrated read helpers. The follow-up below removes the gap.
- **The kernel decides who is checked and when; the connection decides access.** The Workshop
  computes each check's observers and IDs and calls `Gatekeeper.verifyObserverAccess(observers,
  subresources)` on the connection that reported them, handing it each observer's verifier.
  `GatekeeperUserVerifier` stays opaque, as for `addObserver()` and `applyCreation()`, and the
  gatekeeper may use its own props, state, and credentials (one ACL read checked against the whole
  audience, say). It is a bulk call because a read's decision covers its whole audience, and
  returns an allow-list (`allowedObserverIds`) so that an observer the answer omits is denied
  rather than silently admitted. IDs need only mean something to the connection that reported
  them, since requirements are indexed per connection; the kernel never parses them. The costs:
  checks end with the connection (as they already do, see "Disconnect drops checks"), and the call
  can arrive while one of the gatekeeper's own `authorizeObservation()` calls is pending, so the
  gatekeeper must not wait on anything a read holds.
- **The audit log is the requirement store.** Each observation's audit record already holds its IDs
  and its caller, which attributes it; keeping the `subresources` it reported marks it as a
  requirement. One representation, written in the same synchronous block as the audit/policy
  commit, so a refused read records nothing and no admission can be published between a check and
  its write. Reads while a resource's creation is pending record nothing, since they only simulate
  it. A multi-key index derived from those records holds one key per (connection, context,
  subresource), and admission lists only its distinct keys, never the records under them:
  rereading the same data makes the log grow, not admission. The index is maintained in the same
  transaction as the record, so it needs no separate projection to keep consistent. The costs:
  index entries grow with every recorded subresource occurrence; audit retention is part of
  enforcement, so the action log must stay append-only; IDs become storage keys, so they must be
  well-formed Unicode (storage would merge lone surrogates); and the index stores the
  caller-to-context mapping's result per record, so changing that mapping needs a reindexing
  migration.
- **Execution fence only where the kernel checks.** An agent loopback whose executeCode call ended
  cannot authorize a read that reports subresources; legacy reads keep their earlier behavior.
- **Disconnect drops checks.** A removed connection's audit records stay but are ignored, matching
  the legacy protocol's behavior on removal (`docs/observers.md` edge case 8).
- **Same verification scope as the legacy protocol.** A connection enters "build" scope at
  creation and "use" scope only while a gadget binds it or an enabled hook feeds it, through the
  existing scope-widening restarts. Within scope, "build" reaches every context and "use" the
  workspace and every gadget. Requirements through a connection outside a "use" collaborator's
  scope are not checked against them: the legacy "never-bound producers" gap, kept rather than
  closed so a connection only chats read asks "use" collaborators for no account.
- **Direct contexts only; no propagation.** Attribution follows the trusted binding authorizer that
  approved the read. Calls, callbacks, spawned chats, code publication, arguments, and persistent
  writes transfer nothing between contexts. Indirect disclosure is knowingly outside the guarantee.
- **Hook observations use the gadget the hook wakes.** The audit caller is
  `{from: "hook", gadgetId}`, from the hook record's `gadgetId` (or `defaultGadgetId` when it has
  none) at firing time, and the workspace when neither names a gadget. That `gadgetId` is
  inferred for an agent-bound hook and the callback carries its own restore target, so the two can
  rarely disagree; it is trusted anyway, as it already is for the hook's "use" scope, rather than
  writing every hook's data into the workspace context that no future per-gadget verification
  could narrow. Disabling/deleting a hook stops future events without erasing requirements for
  data already delivered, even after a restart; "use" collaborators stay verified against them
  only while something still binds or hooks the connection.
- **Races between reads and admissions are closed by re-checking at the commit point, not by a
  shared lock.** After verifying, admission recomputes its scope and re-runs if it grew.
  It rereads requirements there only if its connections changed or `nextActionId` moved, since
  only a new action record can add one, so an admission nothing disturbed reads them once.
  An observation recomputes its audience after its checks and re-checks if it changed. A hook
  firing also revalidates its live record and usable connection synchronously before committing
  an observation, so a disable/delete during verification prevents delivery and policy/log writes.

## Deferred

- Message-level attribution and historical cutoffs (the log's ordered ids are a starting point).
- Migrating shipping gatekeepers and their trackers.
- Follow-up PR: make `subresources` required, import every connection's remaining legacy history
  once through a `getHistoricalSubresources()` export (always on upgrade, single-flight and
  repeatable until it commits, landing on the workspace context; one RPC result, so a larger
  history is condensed into coarser IDs rather than truncated; an earlier revision of PR #881 had
  this import code), then drop `addObserver()` / `removeObserver()` / `excludeObservers`.
