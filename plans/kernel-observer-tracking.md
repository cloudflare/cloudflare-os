# Design record: kernel-owned observer tracking

How it works is in `docs/observers.md` §10 and `packages/workshop-backend/src/observer-ledger.ts`.
This file records only why it is shaped that way and what was deliberately left out.

## Scope

Kernel-only: `workshop-backend`, the shared contracts in `workshop-shared/src/gatekeeper.ts`, and the
integration test fixture. The first stage kept the legacy `addObserver`/`removeObserver`/
`excludeObservers` protocol beside kernel-checked reads; the cutover (below) removed it.

## Decisions

- **One method; subresources decided per observation.** There is no per-connection protocol or
  switch. RPC validation forwards undeclared properties, so an older Workshop would accept
  `subresources` and ignore them; a separate method would fail closed there instead. During the
  first stage `subresources` was optional and absent meant legacy, so a gatekeeper converted one
  session / cursor / hook path at a time.

## Cutover decisions

- **`subresources` is required; no legacy branch.** A forgotten field was indistinguishable from an
  unconverted path, so the first stage treated it as legacy rather than refusing it. Once every
  gatekeeper reported on every read, the field became required (RPC validation rejects an
  observation without it) and the unchecked branch was deleted.
- **Admission is no longer additive.** The kernel never calls `addObserver()` / `removeObserver()`
  and ignores `excludeObservers`; those members are gone from the interface. Admission is account
  selection, verifier minting (which refuses a disconnected or wrong-vendor account), and
  `verifyObserverAccess()` over recorded requirements only. With no gatekeeper-side registrations
  there is nothing to roll back on denial, no per-(observer, gatekeeper) lock, and teardown on
  sharing changes only deletes observer records.
- **Binding-wide requirements are reported as resource IDs, not checked at admission.** When the
  bound resource's ACL or tenant membership governs a read, the read reports that resource's ID.
  A connection with no recorded requirements therefore admits anyone with a valid account choice:
  access requirements arise from observed data, not from the existence of a connection.
- **Legacy history is imported once.** Storage migration 6 → 7 flags every pre-existing vendor
  connection (`observerHistoryPending`); new connections never get the flag and are never asked.
  `getHistoricalSubresources()` exports what the legacy protocol observed and never reported. The
  import is single-flight per connection, starts in the background at wake and is awaited before
  admission against the connection, and commits the records together with clearing the flag, so
  "once" means one committed import, not one RPC. The export can't attribute reads to a chat or
  gadget, so it lands on the workspace context, which every grant reaches, in records bounded like
  observations, never truncated. A failed export denies the waiting open and is retried; it is
  never treated as empty.
- **Release order.** Gatekeepers first reported `subresources` everywhere and implemented
  `verifyObserverAccess()` and the export while keeping legacy enforcement; then the kernel cutover
  shipped; only then may gatekeepers drop their legacy methods, keeping the history their export
  reads for as long as the method exists.

## Other decisions

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
- **Execution fence on every observation.** An agent loopback whose executeCode call ended cannot
  authorize any read, `[]` included.
- **Disconnect drops checks** (`docs/observers.md` edge case 8).
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
