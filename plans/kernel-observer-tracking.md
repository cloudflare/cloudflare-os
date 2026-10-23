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
  promises `authorizeTrackedObservation()` for every observation, `getHistoricalSubresources()`,
  `verifyObserverAccess()`, and an `addObserver()` that throws. RPC stubs can't report method
  presence, so the flag is read explicitly. Once a connection is tracked, it is never downgraded.
- **Tracked reads use their own authorization method.** `subresources` on `authorizeObservation()`
  would be enough for a current Workshop to notice, but a gatekeeper cannot tell from a successful
  call whether the Workshop enforced them: RPC validation forwards undeclared properties, so an
  older Workshop accepts the call and ignores them. A migrated gatekeeper has dropped its own
  checks, so that read would be disclosed unchecked, and its requirement would never reach the
  import, which exports only legacy history. `authorizeTrackedObservation()` does not exist on
  an older Workshop, so the call fails closed whatever the deployment order or rollback, and the
  gatekeeper needs no acknowledgment to check. The cost: implementers of `ObservationAuthorizer`
  (test doubles included) add the method.
- **Upgrades are detected only from calls the upgraded gatekeeper makes.** Many gatekeepers'
  `describe()` calls their provider with the owner's credentials, and every binding call opens a
  session, so describing on every use, or before every admission, would add provider traffic,
  latency and a failure mode that has nothing to do with the collaborator being checked: an owner
  whose access lapsed would lock out collaborators whose own access still works. Only an upgraded
  gatekeeper calls `authorizeTrackedObservation()`, and only an upgraded gatekeeper's
  `addObserver()` must throw, so the Workshop describes a legacy connection only after one of
  those, and switches it if the description advertises support. A refused `addObserver()` whose
  connection can't be described, or doesn't advertise support, stays a refusal; nothing falls
  back to admitting.
- **A switch is the cutover; the import is a backfill.** The switch marks the connection tracked
  with its history pending, in one write: from then on the Workshop checks and records every
  observation through it and refuses the legacy `authorizeObservation()`, so a read either was
  authorized under the legacy protocol, and is the export's to cover, or is recorded here. The
  import then appends the export beside whatever reads recorded meanwhile, and only admission,
  which must not verify anyone against an incomplete history, waits for it. An earlier design
  fenced the import instead: it aborted the facet, refused the read that revealed the upgrade,
  and restarted the workspace so clients dropped their stubs to the aborted facet and legacy
  sessions reopened. Neither is needed once nothing is aborted: sessions admitted under the
  legacy protocol were verified against everything it authorized, and tracked reads check them
  from the switch on. The cost: the export must cover reads the legacy protocol authorized that
  were still in flight when the gatekeeper upgraded, and a collaborator opening the workspace
  during the import waits for it.
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
- **The audit log is the requirement store.** Each tracked observation's audit record already
  holds its IDs and its caller, which attributes it; keeping `subresources` (stripped from every
  other observation) marks it as a requirement. One representation, written in the same
  synchronous block as the audit/policy commit, so a refused read records nothing and no
  admission can be published between a check and its write. A multi-key index derived from those
  records holds one key per (connection, context, subresource), and admission lists only its
  distinct keys, never the records under them: rereading the same data makes the log grow, not
  admission. The index is maintained in the same transaction as the record, so it needs no
  separate projection to keep consistent. The costs: index entries grow with every recorded
  subresource occurrence; audit retention is part of enforcement, so the action log must stay
  append-only; IDs become storage keys, so they must be well-formed Unicode (storage would merge
  lone surrogates); and the index stores the caller-to-context mapping's result per record, so
  changing that mapping needs a reindexing migration.
- **Always import on upgrade.** An existing legacy connection that starts advertising support is
  imported once (single-flight, repeatable until it commits). No kernel-side "did it read
  anything" flag: the gatekeeper's export is authoritative, an empty export is cheap, and a flag
  would fail open for requirements recorded outside `authorizeObservation`. A connection created
  already advertising support starts tracked. Imported IDs land on the workspace context, since no
  narrower attribution exists.
- **The export is one RPC result.** `getHistoricalSubresources()` returns every ID in one array,
  which must fit one RPC result (32 MiB serialized), so the Workshop validates the whole export
  and commits it in one transaction, keeping import all-or-nothing. A gatekeeper whose history is
  larger condenses it into coarser IDs, each checked as strictly as everything it replaces,
  rather than truncating it. A paged cursor was dropped: it lifted the bound only to hold an
  unbounded union in memory until that commit.
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
  shared lock.** Only one profile's admissions are serialized with each other; after verifying,
  admission recomputes its scope and re-runs if it grew.
  It rereads requirements there only if its connections changed or `nextActionId` moved, since
  only a new action record can add one, so an admission nothing disturbed reads them once.
  An observation recomputes its audience after its checks and re-checks if it changed. A hook
  firing also revalidates its live record and usable connection synchronously before committing
  an observation, so a disable/delete during verification prevents delivery and policy/log writes.

## Deferred

- Message-level attribution and historical cutoffs (the log's ordered ids are a starting point).
- Migrating shipping gatekeepers and their trackers.
