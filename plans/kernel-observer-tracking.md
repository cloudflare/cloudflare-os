# Design record: kernel-owned observer tracking

How it works is in `docs/observers.md` §10 and `packages/workshop-backend/src/observer-ledger.ts`.
This file records only why it is shaped that way and what was deliberately left out.

## Scope

Kernel-only: `workshop-backend`, the shared contracts in `workshop-shared/src/gatekeeper.ts`, and the
integration test fixture. No shipping gatekeeper reports subresources yet; every shipping gatekeeper
keeps the legacy `addObserver`/`removeObserver`/`excludeObservers` protocol unchanged.

## Decisions

- **One method; subresources are optional and decided per observation.** There is no
  per-connection protocol, flag, switch, or history import. RPC validation forwards undeclared
  properties, so an older Workshop would accept `subresources` and ignore them; a separate method
  would fail closed there instead. The deployment assumption makes that unnecessary: the kernel is
  always upgraded before any gatekeeper.
- **Per-observation migration.** A gatekeeper converts one session / cursor / hook path at a time,
  and may stop a path's legacy bookkeeping only once it reports `subresources`. Nothing in the
  Workshop notices an upgrade, so no connection is described to detect one, and nothing is aborted
  or restarted.
- **Admission is additive.** Every in-scope connection's `addObserver()` runs as before, so it
  keeps covering legacy reads, everything recorded before a path converted, and any binding-wide
  requirement (such as tenant membership). Keeping that requirement there, rather than reporting it
  as a subresource, means a collaborator who fails it is refused at admission even before anything
  is recorded.
- **Accepted trade-off: a forgotten `subresources` is legacy, not refused.** The Workshop cannot
  tell a forgotten field from an unconverted path; gatekeepers mitigate it by making `subresources`
  required in their own migrated read helpers. The follow-up below removes the gap.
- **The kernel decides who is checked and when; the connection decides access.** One bulk
  `verifyObserverAccess(observers, subresources)` call covers a read's whole audience, so the
  gatekeeper may read an ACL once with its own credentials. It returns an allow-list so that an
  observer the answer omits is denied rather than silently admitted. IDs mean something only to the
  connection that reported them, since requirements are indexed per connection. The cost: the call
  can arrive while one of the gatekeeper's own `authorizeObservation()` calls is pending.
- **The audit log is the requirement store.** One representation, written in the same synchronous
  block as the audit/policy commit, so a refused read records nothing and no admission can be
  published between a check and its write; the derived index needs no separate projection. The
  costs: audit retention is part of enforcement, so the action log stays append-only; IDs become
  storage keys, so they must be well-formed Unicode; and changing the caller-to-context mapping
  needs a reindexing migration.
- **One read, one record.** A size cap on one observation's IDs (500,000 UTF-16 code units) keeps
  its audit record inside Durable Object storage's 2 MB value limit, rather than splitting a large
  read across several records that would each appear in the activity log. A gatekeeper whose read
  reveals more reports a coarser ID.
- **Execution fence only where the kernel checks.** An agent loopback whose executeCode call ended
  cannot authorize a read that reports subresources; legacy reads keep their earlier behavior.
- **Disconnect drops checks**, matching the legacy protocol (`docs/observers.md` edge case 8).
- **Same verification scope as the legacy protocol.** The "never-bound producers" gap is kept
  rather than closed, so a connection only chats read asks "use" collaborators for no account.
- **Direct contexts only; no propagation.** Attribution follows the trusted binding authorizer that
  approved the read. Indirect disclosure between contexts is knowingly outside the guarantee.
- **Hook observations use the gadget the hook wakes**, as the hook's "use" scope already does,
  even though an agent-bound hook's `gadgetId` is inferred and can rarely disagree with its
  callback's restore target. The alternative, writing every hook's data into the workspace context,
  could never be narrowed by future per-gadget verification.
- **Races are closed by re-checking at the commit point, not by a shared lock.** Admission rescopes
  after verifying and re-runs if what it must verify grew; an observation re-checks whoever its
  audience gained. A lock would serialize reads behind account prompts.

## Deferred

- Message-level attribution and historical cutoffs (the log's ordered ids are a starting point).
- Migrating shipping gatekeepers and their trackers.
- Follow-up PR: make `subresources` required, import every connection's remaining legacy history
  once through a `getHistoricalSubresources()` export (always on upgrade, single-flight and
  repeatable until it commits, landing on the workspace context; condensed into coarser IDs rather
  than truncated; an earlier revision of PR #881 had this import code), then drop `addObserver()` /
  `removeObserver()` / `excludeObservers`. Binding-wide requirements then become subresources, so
  admission must check them even when nothing has been recorded.
