# Releasing restricted data by audience

A design record, for review before any code. It proposes how the Workshop lets an action through
in a workspace that holds restricted data: **when everyone who can see the action's effects can
already see the data**. That generalizes the one exception proposed so far, the admin
gatekeeper's kinds in `ruleApplies()` (`auto-approval.ts`, in the issue report fix stage, #1204),
and replaces the TODO under `ObservationDescription.containsRestrictedData` in
`workshop-shared/src/gatekeeper.ts`, which now points here.

Nothing here is built. The phases at the end say in what order it would be, and what each phase
is tested with.

## Today

A gatekeeper flags an observation `containsRestrictedData`. The Workshop sets one bit on the
workspace, `storage.containsRestrictedData` (the latch), in the transaction that authorizes the
observation, and never clears it. The bit says that something restricted was read. It does not
say what, from which connection, or who may see it, so every effect of the workspace is treated
as a broadcast to an unknown audience. It bites in four places:

- **Rules.** `autoApprovalRule()` returns no rule while the latch is set, so every action of every
  connection waits for a person, who is shown the action's description and vouches that it
  carries none of the restricted data. The admin gatekeeper reads the latch once more where it
  hands the power over (`OverseerImpl.lendAdminApi()`, for an auto-approved action).
- **Web fetches.** `authorizeWebFetch()` lets a URL reach only the hosts the deployment admin
  trusts with restricted data (`restrictedWebFetchHosts`), or a URL a user approves where the
  admin allows that (`restrictedWebFetchApprovals`).
- **Pushes.** `submitAction()` refuses an action with `pushedCommits`, since commits cannot be
  reviewed as text.
- **The admin gatekeeper's exception** (proposed in #1204, beside this record). `ruleApplies()`
  lets a rule apply three of the admin gatekeeper's kinds (an admins-only note, a status, an
  assignment) while every observation that set the latch came through that gatekeeper
  (`storage.adminRestrictedDataOnly`). The reasoning is an audience argument made by hand: what
  those kinds carry is seen by admins, who can already read what the admin gatekeeper read.

The read side is already audience-based. When an observation reports `subresources`, the observer
ledger checks every collaborator who can see the read's context through the producing
connection's `verifyObserverAccess()`, records the ids as requirements, and checks each later
collaborator against them at admission
([observers.md](observers.md#10-kernel-checked-subresources-per-observation)).
So who can open a workspace that read restricted data is decided per producer and per
subresource. What its actions may send out is decided by one bit.

Everything read or received through the admin gatekeeper is restricted data, its report session
and its hooks included, and keeps the workspace admins-only. So the bluntness shows most there:
a reply to a report's reporter, written by a triage agent that read only that report, waits for
a person, as does an admins-only note written after reading another vendor's data.

## The model

Three changes, each small on its own.

### 1. Reads: the set, not the bit

The workspace keeps the set of its restricted reads: for each producing connection, the
subresource ids its restricted observations reported.

- An entry is `(producer, subresources)`. `producer` names a connection of this workspace, or,
  for what a view of another workspace read (an admin's view, a report session's view of the
  reporter's workspace), that workspace's own entries, carried over with the workspace's id. A
  view of a workspace that holds restricted data hands over its provenance, not just a flag.
- A restricted observation with no `subresources`, or with more ids than the set keeps, records
  its producer as **unbounded**: nothing can be vouched for it.
- The bit stays, derived: it is set exactly when the set is non-empty, in the same transaction.
  Everything that reads the bit today keeps reading it.

The observer ledger already records the subresources of each observation on its audit record;
the set is the union of the restricted ones, kept where a rule can read it without a scan.

### 2. Actions: an audience

An action declares who can see its effects once it is applied: an **audience**, in Workshop
principals.

- named users, by profile id;
- the deployment's admins;
- this workspace's members: whoever can open it, now and later;
- or **unknown**, which is what an action without an audience has.

A web fetch, a push and any post to a third party have an unknown audience. A third party's users
are not Workshop principals, and a URL's host is not a person.

An audience never says "whoever can read resource R". It names principals, so that a producer's
answer about them is a real check, and so that a sink cannot define its audience as its own
access list and then vouch for it (see [Trust](#trust)).

### 3. Producers vouch

Before a rule applies an action in a workspace that holds restricted data, each producer in the
set is asked whether every member of the action's audience may already see what was read from
it. That is `verifyObserverAccess(observers, subresources)`, the call admission already makes,
aimed at the audience: the observers are the audience's principals, with a verifier minted for
each from their account of the producer's vendor (`UserDurableObject.getVerifier()`), and the
subresources are the producer's entry in the set.

The action applies by its rule when **every** producer allows **every** member. It waits for a
person when the audience is unknown, when an entry is unbounded, when a member has no account of
a producer's vendor, when a producer omits anyone, and when a producer throws. Waiting for a person
is today's behavior, so every failure falls back to it.

**A verdict releases only where it covers the content.** Admission today accepts some checks that
look at metadata: BigQuery's verifier asks for the dataset (`getDataset()`), which an account that
cannot read the rows passes ([observers.md](observers.md#92-decision-table)). The write-gatekeeper
review rule, that metadata visibility must not stand in for content access, then becomes a
release rule too. So a producer releases nothing until each resource kind it reports, and the
verifier behind it, are reviewed for release; until then its entries hold every action, as an
unbounded entry does.

**Dynamic audiences.** Two audiences change after the apply, and the effect stays readable by
whoever joins them:

- **Deployment admins.** Someone promoted later reads the effect without ever having been
  checked against its source, and promotion grants no vendor's access. So only a producer whose
  own rule is "deployment admins" can release to this audience: the admin gatekeeper, whose
  `verifyObserverAccess()` allows everyone because admission is the Workshop's. The Workshop knows
  who is an admin (`ADMINS`) and vouches for the role itself, for the admin subresources alone.
  Any other producer holds an action whose audience includes the admins.
- **This workspace's members.** Admission does not cover this one. A `use` collaborator is checked
  against the gadget they open, not against what another gadget or chat read, and a view-only
  collaborator refreshes a gadget's static snapshot with no observer check
  ([sharing.md](sharing.md#static-snapshots)). An automatic write to a gadget's storage can
  therefore reach someone never checked against its source. This audience stays unknown until
  every path that serves the destination, later opens and snapshot refreshes included, enforces
  the source's requirements.

## API sketch

Doc-comment drafts for `workshop-shared`. None of it exists yet.

```ts
/**
 * Who can see an action's effects once it is applied, in Workshop principals. Every field
 * widens it; an absent audience is unknown, and an unknown audience is never vouched for. A
 * gatekeeper's audience counts only where the Workshop trusts that gatekeeper to declare one
 * (see docs/restricted-data-audiences.md#trust); any other is read as unknown.
 */
export interface ActionAudience {
  /** Profile ids of the users who see the effect. At most MAX_ACTION_AUDIENCE_USERS. */
  users?: string[];
  /** Whether the deployment's admins see it, whoever they are when it is applied and after. */
  deploymentAdmins?: boolean;
  /** Whether everyone who can open this workspace sees it, now and later, and nobody else.
   * Read as unknown until every path that serves the workspace enforces what it read. */
  workspaceMembers?: boolean;
}

interface ActionDescription {
  // ...
  /**
   * Who can see this action's effects. Read only in a workspace that holds restricted data,
   * where a rule may apply the action if every restricted producer vouches for every member
   * (see ActionAudience). Absent, the audience is unknown and the action waits for a person
   * there, as every action does today.
   */
  audience?: ActionAudience;
}
```

In the backend:

```ts
// The workspace's restricted reads (see docs/restricted-data-audiences.md), written by
// authorizeObservation() in the transaction that sets containsRestrictedData, and never
// cleared. One row per producer: a connection of this workspace, or one of another
// workspace whose view this one read through.
restrictedReads: collection<RestrictedReadRecord>("restrictedReads", {key: "producer"}),
// Bumped by every write to restrictedReads, so that a verdict computed before an await is
// known to be stale when it is used.
restrictedReadsVersion: singleton(0),

interface RestrictedReadRecord {
  /** `"<gatekeeperId>"`, or `"<workspaceId>/<gatekeeperId>"` for a viewed workspace's. */
  producer: string;
  /** The ids reported, or "unbounded": an observation with none, or more than the set keeps. */
  subresources: string[] | "unbounded";
}
```

**Where the predicate runs.** As the fix stage's `ruleApplies()` does, at each point the power is
handed over, so it is one function with these callers:

1. when an action is queued and its rule looked up (`autoApprovalRule()`, and
   `listPreApprovableActions()`, which tells clients);
2. before each apply in the drain;
3. where the admin gatekeeper is lent the power (`lendAdminApi()`), and once more as the lend
   makes the action's call.

Vouching is an RPC to each producer, so the predicate becomes async: the drain computes the
verdict, then applies only if `restrictedReadsVersion` is what it was when the verdict was
computed, and recomputes otherwise. A read that lands while a verdict is computed therefore
holds the action back rather than slipping past the check.

## Trust

An audience is a claim about where an effect lands, and the Workshop cannot check it. A producer's
answer is a claim about its own data, which the Workshop already trusts at admission. So:

- **The Workshop vouches for the kinds it knows.** The admin gatekeeper's actions are a closed
  table (`ADMIN_AGENT_ACTIONS`). Their audience comes from that table, filled in by the Workshop
  from the approved call (the report's reporter is read from the report the call names), and
  nothing the Worker declares.
- **A gatekeeper's own audience counts only for reviewed first-party gatekeepers**, named in the
  Workshop's code (or the release manifest) and never by the Worker itself, as an ambient
  resource is made so only by an admin and never by its gatekeeper. Any other gatekeeper's
  `audience` is read as unknown.
- **A gatekeeper never vouches for its own sink.** It declares the audience of its action, and the
  producers vouch; when it is a producer too, it is asked about its own data like any other, and
  its audience must still come from the rules above. An audience names principals, never "the
  readers of my resource", so a sink cannot make its vouching true by definition.

## Worked examples

The admin gatekeeper's release labels would be finer than today's subresource: `admin:deployment`
for a read through the whole binding, and `admin:report:<id>` for the report itself and its
images as a session limited to it reads them. Who can see each is the Workshop's table: admins
for the first; admins and the report's reporter for the second. What the session reads of the
reporter's workspace is not the report: it is read under a live grant, as an audited call, and an
automatic reply would keep it readable by every admin after the grant ends
([admin-access.md](admin-access.md#each-call)). It takes a label of its own,
`admin:report:<id>:view`, which releases nothing.

These labels are for release alone. Admission does not change: any observation of the admin
gatekeeper that carries the flag still sets `adminReads` in the transaction that sets the latch,
so a workspace that read a single report stays admins-only after the connection is removed.

| Workspace read | Action | Audience | Vouched by | Result |
| --- | --- | --- | --- | --- |
| Report R through its session | A reply to R's reporter | R's reporter, admins | The Workshop: both may see `admin:report:R` | Applies |
| The audit log, then report R | An admins-only note on R | Admins | The Workshop: admins see every admin subresource | Applies |
| Report R through its session | R's status, which its reporter reads | R's reporter, admins | The Workshop, as for the reply | Applies |
| The audit log, then report R | R's status | R's reporter, admins | The reporter may not see `admin:deployment` | Held |
| Report R, then a chat of the reporter's workspace under their grant | A reply to R's reporter | R's reporter, admins | Nobody: `admin:report:R:view` releases nothing | Held |
| A Google Doc | A Slack post | Unknown: Slack users are not principals | Nobody | Held |
| Anything restricted | A web fetch to a public host | Unknown | Nobody | Held (the trusted hosts still apply) |
| A Google Doc | Text written to the workspace's own gadget storage | This workspace's members: unknown for now | Nobody | Held |
| A Google Doc | An admins-only note | Admins | Not Google: the audience grows with each promotion | Held |

The fourth row is the fix stage's open edge, now bounded. Today a status set after reading the
whole deployment applies by its rule, and its reporter learns something from the choice of status.
Under audiences it applies only when everything read is that reporter's own report.

## Edges

- **Audiences that grow after the apply.** An effect outlives the check. Named users are fixed. The
  admins audience releases only the admin gatekeeper's data, which a new admin can read anyway, and
  the members audience releases nothing yet (see [Dynamic audiences](#3-producers-vouch)). A grown
  third-party audience is unknown, so it was never released. What remains is a named user's access
  shrinking after the apply: the effect stays where it landed, as a person's approval does today.
- **Revocation and caching.** No verdict is cached across applies in the first version: each
  apply asks again. If that is too slow, a cache is bounded by the admin gatekeeper's lend
  (`ADMIN_AGENT_LEND_SECONDS`) and keyed by producer, subresources and audience, and any write to
  the set ends it.
- **Workspace or chat.** The set is the workspace's, as the latch is. Chats share gadgets, storage
  and outputs, so a chat that read nothing still reaches what another chat read. A per-chat set is
  left for later.
- **Mixed producers.** Every producer must allow every member. One that cannot answer holds the
  action, so adding a connection that cannot vouch takes the exception away, as another
  connection's restricted read ends the fix stage's exception today.
- **Migration.** A workspace latched before the set existed has the bit and an empty set. It is
  read as one unbounded entry: no exception, as the fix stage leaves a workspace latched before
  `adminRestrictedDataOnly` existed. A rollback to code that sets the bit without the set needs the
  fix stage's guard (`guardRuleExemption()`: a mirror of `nextActionId`, which every observation
  takes), generalized to the set.
- **Bounds.** The set keeps a fixed number of subresource ids per producer. Past it the producer is
  unbounded, which only takes the exception away.

## How the fix stage maps onto this

Its rule is one row of the table above:

- `adminRestrictedDataOnly` is "every producer in the set is the admin gatekeeper's connection";
- `autoApprovableWhileRestricted` is "the kind's audience is the admins, or the report's reporter
  and the admins, as the Workshop's table says";
- the vouching is the Workshop's, for the admin labels: the one producer whose own rule is the
  admins role.

So phase 2 replaces `ruleApplies()`'s special case with the general predicate and the admin
gatekeeper's table, keeps its tests as they are, and adds the status row that it holds today.

## Phases

1. **Record the set.** `restrictedReads` and its version beside the latch, written in the same
   transaction, carried through admin views and report sessions; no behavior changes. Tests:
   backend unit tests of what each observation adds (with and without subresources, past the
   bound, through a view of a restricted workspace), and the migration and rollback guard;
   `pnpm cf-os api` against a dev server to read the set after a report session's read.
2. **The admin gatekeeper's audiences.** Per-report labels, the Workshop's table, the async
   predicate at its callers, and the lend pinned to the report its card named (today the lend
   holds an approved action to its method and visibility, not to a report). Tests: the worked
   examples' first five rows end to end in `packages/integration-tests`, with a scripted model;
   the fix stage's suites unchanged; a read that lands while a verdict is computed; and a
   workspace that read one report through its session still refusing a non-admin once the
   connection is removed.
3. **Audiences from gatekeepers.** `ActionDescription.audience`, the trusted list, producers
   reviewed for release by resource kind, and producers asked through `verifyObserverAccess()`
   with verifiers minted for named users. Tests: fake producers that allow, omit and throw; a
   producer not reviewed for release; a member with no account of a producer's vendor; two
   producers of which one denies; an untrusted gatekeeper's audience read as unknown; an admins
   audience held for any producer but the admin gatekeeper.
4. **Later, if wanted.** The members audience, once every path that serves a workspace's gadgets
   enforces the source's requirements; per-chat sets; resource-relative audiences (below); and web
   fetch hosts as audiences.

## Open questions

1. **Principals, or resources?** A comment on the Google Doc that was read is seen by exactly the
   Doc's readers. That is a resource-relative audience ("whoever can read R"), which this record
   rules out because the sink would define it. Is a separate producer check worth it, "can
   everyone who can read R read everything read from me?", so that writing back to where the data
   came from is released?
2. **Is the derived bit enough for everything else?** Web fetches, pushes and observers' sharing
   keep reading the bit. Should web fetches move to the set too, with trusted hosts as an
   audience the admin declared?
3. **Who is trusted to declare an audience?** A list in the Workshop's code, or a field the release
   manifest carries for first-party gatekeepers?
4. **Which account vouches for a principal who never chose one?** A report's reporter is not a
   member of the triage workspace and chose no account for its producers. Try each of their
   accounts of the vendor, use the most recent, or refuse?
5. **Is a view of the reporter's workspace ever releasable?** Its answers are read under a live
   grant, as audited calls. Releasing a reply built from them would keep them readable after the
   grant ends; this record holds such a reply for a person.
