# Design record: kernel-owned observer tracking

How it works today is in `docs/observers.md` §10 and `packages/workshop-backend/src/observer-ledger.ts`.
This file records why it is shaped that way and what was deliberately left out.

## Scope

Kernel-only: `workshop-backend`, the shared contracts in `workshop-shared/src/gatekeeper.ts`, and the
integration test fixture. No shipping gatekeeper opts in yet; every shipping gatekeeper keeps the
legacy `addObserver`/`removeObserver`/`excludeObservers` protocol unchanged, and a workspace may
mix both.

## Decisions

- **Opt-in by capability, not method probing.** `ResourceDescription.supportsObserverTracking`
  promises `getHistoricalSubresources()`, `subresources` on every observation, and the vendor
  verifier's `verifyObserverAccess()`. RPC stubs can't report method presence, so the flag is read
  explicitly. Once a connection is tracked, losing the flag is a refusal, never a downgrade.
- **IDs are fully qualified.** Each subresource ID carries enough vendor scope for the observer's
  own verifier to check it, so there is no per-connection scope descriptor and nothing about a
  connection has to outlive it. The kernel never parses IDs.
- **The audit log is the requirement store.** Each tracked observation's audit record already
  holds its IDs and its caller, which attributes it; keeping `subresources` (stripped from every
  other observation) marks it as a requirement, and an index keyed by the caller's context finds
  it. One representation, written in the same synchronous block as the audit/policy commit, so a
  refused read records nothing and no admission can be published between a check and its write.
  The costs: admission reads and deduplicates repeated observations; audit retention is part of
  enforcement, so the action log must stay append-only; and the index stores the caller-to-context
  mapping's result per record, so changing that mapping needs a reindexing migration. A
  materialized requirement table can be rebuilt from the log later if admission reads get heavy.
- **Always import on upgrade.** An existing legacy connection that starts advertising support is
  imported once (fenced, single-flight, repeatable until it commits). No kernel-side "did it read
  anything" flag: the gatekeeper's export is authoritative, `[]` is cheap, and a flag would fail
  open for requirements recorded outside `authorizeObservation`. A connection created already
  advertising support starts tracked. Imported IDs land on the workspace context, since no
  narrower attribution exists.
- **Disconnect drops checks.** A removed connection's audit records stay but are ignored, matching
  the legacy protocol's behavior on removal (`docs/observers.md` edge case 8).
- **Same verification scope as the legacy protocol.** A tracked connection enters "build" scope at
  creation and "use" scope only while a gadget binds it or an enabled hook feeds it, through the
  existing scope-widening restarts. Within scope, "build" reaches every context and "use" the
  workspace and every gadget. Requirements through a connection outside a "use" collaborator's
  scope are not checked against them: the legacy "never-bound producers" gap, kept rather than
  closed so a connection only chats read asks "use" collaborators for no account.
- **Direct contexts only; no propagation.** Attribution follows the trusted binding authorizer that
  approved the read. Calls, callbacks, spawned chats, code publication, arguments, and persistent
  writes transfer nothing between contexts. Indirect disclosure is knowingly outside the guarantee.
- **Hook observations use the workspace context.** The audit caller stays `{from: "hook"}`;
  the existing ledger checks both collaborator roles and records subresource requirements for
  later admission. No per-gadget attribution: `BoundHookRecord.gadgetId` is heuristic bookkeeping,
  not a trusted destination. The tradeoff is conservative: hook observations constrain every
  collaborator, not just users of the receiving gadget. Disabling/deleting a hook stops future
  events without erasing requirements for data already delivered, even after a restart; "use"
  collaborators stay verified against them only while something still binds or hooks the
  connection.
- **Races are closed by re-checking at the commit point, not by locks or counters.** Admissions are
  serialized per profile; after verifying, admission recomputes its scope and re-runs if it grew.
  An observation recomputes its audience after its checks and re-checks if it changed. A hook
  firing also revalidates its live record and usable connection synchronously before committing
  an observation, so a disable/delete during verification prevents delivery and policy/log writes.

## Deferred

- Message-level attribution and historical cutoffs (the log's ordered ids are a starting point).
- Migrating shipping gatekeepers and their trackers.
