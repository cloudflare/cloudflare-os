# The admin gatekeeper

A deployment admin's agent uses the deployment's Admin API as that admin, through this gatekeeper.
Its sessions are built from the API's generated schema: one method for each Admin API method an
agent may call, with the declarations the agent reads and the check each call's arguments pass.
Reads run at once; what would post to an issue report, set its status or ask the admins for a
write is queued as an action. Two hooks start work on issue reports: one fires for each report
filed, one each time an investigation ends. What an admin sees and does through it is in
[docs/admin-access.md](../../docs/admin-access.md#through-an-agent), and the reports themselves
in [docs/issue-reports.md](../../docs/issue-reports.md). This file is the design record.

| Concern | Location |
| --- | --- |
| The kind of every Admin API method, the action kinds, the lend's length, the binding's subresource id | `packages/workshop-shared/src/admin-agent.ts` |
| The gatekeeper's contract with the Workshop (`AdminAgentApi`, `AdminAgentQueue`, `AdminGatekeeper`, `IssueReportEvent`) | `packages/workshop-shared/src/admin-gatekeeper.ts` |
| What a lent call may do (`restrictAdminApi()`, `ADMIN_AGENT_VIEWS`) | `packages/workshop-backend/src/admin-agent.ts` |
| The lend, the admission rule, the mark of a read (`lendAdminApi()`, `admitsNonOwner()`, `adminReads`) | `packages/workshop-backend/src/overseer.ts` |
| The events the report store sends | `packages/workshop-backend/src/issue-reports.ts` |
| The schema, its load-time checks, the declarations | `src/surface.ts` |
| The sessions | `src/forward.ts` |
| The six actions | `src/actions.ts` |
| The session limited to one report | `src/report-session.ts` |
| The two hooks | `src/hooks.ts` |
| The facet, the account, the vendor | `src/worker.ts` |

## Who can use it, and where

The gatekeeper is part of every deployment and takes no deploy input. Its vendor
(`ADMIN_GATEKEEPER_VENDOR_ID`, `instanceadmin`) auto-provisions its account, with no connect
flow, and its mode starts **disabled** (`defaultAmbientGatekeeperMode()`): a deployment offers it
only once an admin chooses another mode in the admin panel.

**Only deployment admins hold the account.** The Workshop offers, provisions and lists it only
for a user who is a deployment admin at that moment (`UserDurableObject.#offersVendor()`). A user
who stops being one keeps a stored account they can neither see nor use.

**The account is injected into no workspace.** It declares no singleton, so the Workshop makes no
ambient connection of it in any mode: a gatekeeper never asserts its own ambience, and what this
one's mode decides is who holds the account. The three modes mean this for it:

- **Optional**: each admin adds the account, from the Connectors page or from the connection
  picker, whose one row for this vendor adds it.
- **Enabled**: every admin has the account. The connection picker lists it; the Connectors list
  does not, as for every forced account.
- **Disabled**: the vendor is offered to nobody, and its connections answer nothing.

**Its holder adds the connection to the workspaces that need it**, the same way in both modes:
pick the resource (`instanceadmin://deployment`, "Deployment admin"), then the account. Only a
workspace's owner can add it there, and only while they are an admin. An admin's other
workspaces are untouched.

**Every call is the owner's.** A connection uses the Admin API of the workspace's owner, whoever
in the workspace caused the call, so every record it makes names the owner as the admin, with
the workspace and, where there is one, the chat (see
[What is recorded where](#what-is-recorded-where)).

**A workspace that has the connection admits only deployment admins beside its owner.** The
Workshop asks `OverseerImpl.admitsNonOwner()` wherever a non-owner is let in, sent the
workspace's state or answered from its sharing records:

- no role opens it for a non-admin, and a share link is not redeemed for one;
- a chat head is not sent in the background to a collaborator who is not an admin;
- adding the connection ends every collaborator's session, so each is admitted again under the
  rule, or not;
- a collaborator who is demoted loses the workspace at their next open and their next
  background read: `ADMINS` is deployment configuration, read at each admission.

Other admins may collaborate there. Any of them may decide a pending action of the connection
while they are an admin; the action's record names who decided (`resolvedBy`), and what it does
is recorded as the owner's. A second admin needs an account of their own to be admitted, as an
observer of any connection does. Their own direct session on the connection, opened outside any
chat, is lent nothing and queues nothing: its records would name the owner and nothing would
say who called, and a rule would apply what it queued with nobody deciding.

### After the connection is removed

Which workspaces stay closed is decided by one fact, the mark a read makes:

- **A workspace that never read through the whole binding is ordinary again at once.** It may
  have opened report sessions, queued actions or received hooks. The people kept in its sharing
  list are admitted at their next open, with nobody inviting them.
- **A workspace that has read through the whole binding stays admins-only for good.** Its chats
  hold what was read, and nothing lifts the rule.

Each rule reads its own fact:

- Nothing applied by a rule, and web fetches held: the restricted-data latch, which any
  observation that carries `containsRestrictedData` sets, of any connection.
- Admins-only for good: `storage.adminReads`, which the Workshop sets in the transaction that
  sets the latch, for an observation of this gatekeeper that carries the flag and names
  `ADMIN_BINDING_SUBRESOURCE`. It is never set without the latch.

While the workspace has the connection it is admins-only whatever it read
(`hasAdminConnection()`).

No other mark closes a workspace for good. A report session that read a reporter's restricted
workspace sets the latch alone (see [Restricted data](#restricted-data)): that triage workspace
waits for a person from then on, and is still ordinary again once the connection is removed.

A member who tries to add a non-admin is refused with the reason (`ADMINS_ONLY_REFUSALS`), which
the Share dialog shows on the person's chip:

> This workspace has the deployment admin connection, so only deployment admins can be added to
> it. Remove the connection to share it with others.

> This workspace has read through the deployment admin connection and its chats hold what was
> read, so only deployment admins can be added to it. Removing the connection does not change
> that.

Non-admins who were in the sharing list before stay listed and stay refused until the owner
removes them.

### What the non-admins who come back can read

A workspace that never read through the whole binding can still hold, in its chats, what report
sessions brought in: the text and images of other users' reports, public thread entries, and
workspace content those reporters granted to admins, the restricted data of a reporter's own
workspace included. Once the connection is removed, the collaborators who are admitted again
read those chats. Nothing closes that workspace: the rule above reads reads through the whole
binding and nothing else.

An owner who means to share such a workspace again deletes those chats first, or keeps triage in
a workspace that is never shared with non-admins.

### Removing the account

An admin who removes their account in mode "optional" ends every connection made with it, in
every workspace they own, at the next session, action or hook firing. Adding the account again
restores them. [Removing the account, and blueprints](#removing-the-account-and-blueprints) has
the reason.

## The two-person rule there

A request for `"grantContentAccess"` must be approved by an admin other than its requester (see
[docs/admin-access.md](../../docs/admin-access.md#asking-for-content-without-the-owner)). A
request filed through this gatekeeper is its workspace owner's, and other admins can work in that
workspace, so the rule counts everyone who was there.

- **What is compared.** `isRequestInsider()` (`packages/workshop-backend/src/admin-writes.ts`)
  refuses an approver who is the requester or one of the request's insiders: the workspace's
  owner, everyone the workspace is shared with in any role, and the member who approved the
  filing. Each is compared with `sameDeploymentAdmin()`, at the three places the base compares
  the approver with the requester.
- **When membership is read.** Once, when the request is filed: `lendAdminApi()` builds the list
  in the step that lends the approved action its one call, and the request keeps it. It is not
  read again at approval.
- **What follows.** A member who leaves the workspace afterwards still cannot approve. An admin
  who joins it afterwards can: they had no part in the request. An admin from outside the
  workspace approves.

Filing such a request is an action kind of its own that no rule approves
(`contentAccessRequest`, see [What each kind does](#what-each-kind-does)). A person who is in
the workspace at that moment approves each filing and is counted among the insiders. So nobody
can leave code behind that files the request later, leave the workspace and approve it alone.

## Why it holds no power

The Worker has no binding, no credential and no stored capability that reaches the Admin API or
the report store (`cloudflare.config.ts` declares none). `createAccount()` takes no identity and
every account is alike. What it can do, the Workshop lends it:

- **For a session**: the owner's Admin API, through the session's queue
  (`AdminAgentQueue.getAdminApi()`). It answers the "read" methods only.
- **For an approved action**: an Admin API that answers one call, the one the action's kind
  names, handed over as an argument (`AdminGatekeeper.applyAdminAction()`).
- **For a hook's firing**: nothing. A firing's queue is a plain approval queue, and an event is
  an id and a label.

`OverseerImpl.lendAdminApi()` makes each lend, and is the one place an `AdminApiImpl` is made
with `via: "gatekeeper"`. It lends nothing unless the connection is this gatekeeper's, the
deployment has not turned the gatekeeper off, the owner is a deployment admin and still holds the
account, a session opened directly from the connection was opened by the owner and, for an
action, whoever approved it is an admin too.

Every call through a lend passes `restrictAdminApi()` first, which checks, in this order: that
the lend has not ended or run out, that the owner is still a deployment admin, that the session
is still live, that the deployment has not turned the gatekeeper off, and that the kind table
allows the method under this lend. Then `AdminApiImpl` validates, checks and records the call as
it does for any admin.

The bounds:

- A session's lend runs out `ADMIN_AGENT_LEND_SECONDS` (15 minutes) after its queue was made,
  however often the gatekeeper asks again.
- A view ends with its lend. It is handed out only behind the lend's own switch, answering the
  methods `ADMIN_AGENT_VIEWS` allows for the method that returned it and no other name, so no
  `dup()` reaches the stub underneath; and its lifetime is capped at what the lend has left.
- An action's lend answers one call and is ended by the Workshop when `applyAdminAction()`
  returns, whatever copy the Worker kept.

### What a Worker that keeps everything could do

A Worker that kept every capability it was given, and misbehaved, could:

- read, within a session's 15 minutes, anything a "read" method answers, for a workspace whose
  agent asked for less;
- misdeclare what is its own to declare: queue a reply drafted through the whole binding under
  the scoped reply's tag (`issue-report-scoped-reply`), or leave the restricted-data flag off a
  read, and so get a rule's approval for what should wait for a person.

The split between a reply through the binding and a reply through a report session, and the
restricted-data mark, hold against agents and gadgets, which choose neither. They are the
Worker's word, as an action's kind and an observation's flag are for every gatekeeper: the
Worker is deployed with the Workshop and trusted for its own declarations.

It can never:

- act with nothing lent: no session open and no approved action being applied;
- make a second call under one approval;
- call an omitted method;
- approve anything;
- be recorded as anything but `"gatekeeper"`, with the workspace and the chat the Workshop names.

## The generated surface

The one generated input is `packages/api-schema/generated/admin-api.schema.json`, which
`packages/api-schema/scripts/generate.ts` writes: the Workshop's schema rooted at `AdminApi`, with
what it reaches, less the methods `ADMIN_AGENT_KINDS` classifies `"omitted"`. It is not
committed. The package's `build`, `test` and `build:integration-worker` tasks depend on the task
that writes it, and `test:run` and Wrangler's build command write it themselves when it is
stale (see [packages/api-schema/README.md](../api-schema/README.md)).

`src/surface.ts` and `src/forward.ts` build three things from it:

- **The session's methods.** One class per service of the schema (`AdminApi`, and the two views
  it opens), with one prototype method per method of the service, defined at load. Each forwards
  its call, except an "act" method, which queues an action.
- **The declarations the agent reads.** Emitted at load with `emitDeclarations()`, from a copy
  of the schema in which each "act" method returns nothing and says first that the call is
  queued (`queued()`). The hand-written `src/types.d.ts` follows them: `AdminBinding`, the
  report session and the two hooks.
- **The argument check.** `checkArguments()` refuses a malformed call before the queue is
  touched; the Workshop validates the call again where it lands.

**The load-time checks.** `assertAdminSchema()` throws, so that the Worker fails to load, unless
the schema is what the sessions rely on:

1. It is in the format this code reads, rooted at `AdminApi`, and holds the services the
   hand-written declarations name.
2. The Workshop implements every service, and none has a property.
3. Every parameter is plain data the schema describes: no capability, function or stream at any
   depth, and nothing of kind `any` or `unsupported`.
4. An `AdminApi` method returns data the schema describes (a stream included) or exactly one
   stub of another service the schema holds; every other method returns such data, so a view
   opens no further capability.
5. `AdminApi`'s methods are exactly those `ADMIN_AGENT_KINDS` gives a kind other than
   `"omitted"`.
6. No method has a reserved name.
7. Nothing carries a `secret` tag, on a named shape or on a property: no read hands an agent a
   secret.
8. Every "act" method has a route to an action, and each route is the call of an action kind of
   `ADMIN_AGENT_ACTIONS`.

**How a method added to `AdminApi` is classified.** A missing step 1 or step 3 fails the
build; a missing step 2 fails the load and the tests:

1. Its kind, as one entry of `ADMIN_AGENT_KINDS`
   (`packages/workshop-shared/src/admin-agent.ts`). `packages/workshop-shared` does not compile
   while the table and `AdminApi` differ. When in doubt, `"omitted"`.
2. For an "act" method: its action kind in `ADMIN_AGENT_ACTIONS`, and here its definition
   (`src/actions.ts`), its name in `ACT_METHODS` (`src/surface.ts`) and its route (`ACT_ROUTES`
   in `src/forward.ts`, which does not compile unless it routes exactly `ACT_METHODS`). No
   type ties `ACT_METHODS` to the "act" entries of the kind table, so an "act" method left out
   of it compiles: load-time check 8 then refuses the schema, so the Worker does not load and
   the Node suite fails as it imports `src/surface.ts`, and the Workshop's
   `__tests__/admin-agent-kinds.test.ts` fails while the "act" methods and the methods the
   action kinds name differ.
3. For a "read" method that returns a view: its entry in the Workshop's `ADMIN_AGENT_VIEWS`
   (`packages/workshop-backend/src/admin-agent.ts`), which says which names its view answers
   and how the view's life is capped at the lend's. `packages/workshop-backend` does not
   compile until the entry is there. A view answers nothing the Workshop has no table for, and
   never borrows another view's table.
4. Regenerate the schema and rebuild.

A method that returns data and is a "read" needs step 1 and step 4 only.

**Why an "act" method is declared `Promise<void>`.** The call does not run: it queues an action
and resolves to nothing. Declaring the Admin API's own result would tell the agent it holds a
thread entry or a request that does not exist yet.

## What each kind does

| Kind | Methods | What a call does |
| --- | --- | --- |
| `"read"` | `getSettings()`, `isBlueprintFeatured()`, `listUsers()`, `listWorkspaces()`, `inspectWorkspace()` and `inspectUser()` and every method of the view each returns, `listAdminAudit()`, `getAdminAuditStats()`, `getWorkspaceWrite()`, `listIssueReports()`, `getIssueReport()`, `readIssueReportImage()` | Runs at once, on the owner's Admin API, and returns its result. Metadata, and a workspace's content under a live grant, exactly as its view's own per-call check decides. A view of a user's account returns metadata alone. |
| `"act"` | `addIssueReportEntry()`, `setIssueReportStatus()`, `requestWorkspaceWrite()` | Never runs when called. It is queued as one of the six actions below, and runs once that action is approved, as exactly the queued call. |
| `"omitted"` | Every setter and every other method that changes a setting, the gateway tests, `checkForUpdates()` and `getUpdateStatus()`, every passkey method, approving or denying a write request, `endWorkspaceGrant()`, `setIssueReportLinks()` | Absent from the declarations and refused, by the session and by the Workshop. |

The six action kinds (`ADMIN_AGENT_ACTIONS`). Each card is built from the call's own arguments,
never from a read, so queuing an action marks nothing:

| Kind | Tag | `autoApprovable` | The card says |
| --- | --- | --- | --- |
| `issueReportReply`: a public reply through the binding | `issue-report-reply` | `false` | The report's id and the whole reply, and that it was written with access to what only admins see. |
| `issueReportScopedReply`: a public reply through a report session | `issue-report-scoped-reply` | `true` | The report's id, its reporter, when it was filed, how it begins, and the whole reply. |
| `issueReportNote`: an admins-only entry | `issue-report-note` | `true` | The report's id and the whole note. |
| `issueReportStatus`: a report's status | `issue-report-status` | `true` | The report's id and the status. |
| `workspaceWriteRequest`: a write request other than for content | `workspace-write-request` | `true` | The workspace, the action, its arguments and the reason. |
| `contentAccessRequest`: a request for `"grantContentAccess"` | `content-access-request` | `false` | The same, and that nobody in this workspace can approve the request. |

A scoped reply's card also names the reporter and the report's first line, which the session
reads for the card alone and may read anyway.

**The two `false` verdicts**, by the rules of the write-gatekeeper skill:

- `issueReportReply` (rule 2): it sends text to the reporter, a person outside the workspace,
  written by code that can read what only admins see. It always waits for a person, whatever
  rules the workspace has.
- `contentAccessRequest` (rule 7): it asks for access to a workspace's content, and whoever
  approves the filing is one of those who may not approve the request, which only a person
  present can be.

**The two public kinds never share a rule, and neither do the two request kinds.** Rules are
stored under an action's tag, and each kind has a tag of its own. Which public kind a reply is
queued as is decided by the capability the call came through, never by an argument: the
binding's session queues `issueReportReply`, a report session queues `issueReportScopedReply`.
Which request kind is decided by the request's action. The Workshop refuses to lend to an
auto-approval of an action whose tag is that of a kind whose verdict is `false`, whatever the
action's own description claims, and checks the one call an approved action makes against its
kind.

**Why filing a write request is an action**, though what it files still needs a passkey: it
stores a request every admin sees, takes one of the deployment's pending slots, and puts text an
agent wrote on an approval page.

**What a rule cannot use up.** A rule applies an action with no person deciding, so the two
kinds a rule can repeat without end are bounded where they land, in the Workshop:

- requests filed through the gatekeeper hold at most `MAX_PENDING_AGENT_ADMIN_WRITES` (10) of
  the deployment's `MAX_PENDING_ADMIN_WRITES` (50) pending slots, across every workspace; the
  next is refused `tooManyRequests`, and the requests people make keep the rest;
- one report takes at most `MAX_ISSUE_REPORT_THREAD_ENTRIES` (200) changes of status made
  through the gatekeeper; the next is refused `threadFull`. A person's change of status is
  never refused, so a report can always be closed.

**What is refused before a card is made.** A text or a reason the Admin API would refuse, and a
write request's arguments that do not fit its action (`ADMIN_WRITE_ARGS`, the Workshop's own
table): a required one missing, one the action does not take, or an id that is not a
non-negative whole number. The Admin API refuses these with no code, which an approved action
could only report as an outcome nobody knows.

**No action runs twice.** Every kind claims its action before it calls. A coded refusal the
Admin API makes before it writes anything fails the action for good; any other failure (a
broken call, an error with no code) leaves an outcome nobody knows, which is never run again: a
person looks at the report's thread or the audit log, and rejects the action. A status is
claimed like the rest: set again after someone had changed the report's status, it would undo
their change, with a second status line and a second end of an investigation.

**A verdict of `true` is a ceiling.** A rule applies an action only in a workspace that holds no
restricted data, which the next section makes rare on purpose.

## Restricted data

This is the rule of this version.

**Every read through the whole binding marks the workspace as holding restricted data**, through
the platform's own latch: each of its observations carries `containsRestrictedData`. Listings,
settings, the audit log, reports and every view method all mark. From the first read on, the
Workshop enforces what it enforces for restricted data everywhere:

- nothing is applied by a rule: an admins-only note, a status change, a filed request and a
  report session's reply all wait for a person;
- web fetches reach only the hosts the deployment trusts with such data;
- a push is refused.

**A report session's reads do not mark, and neither does a hook's delivery.** A report session
returns only what the reporter could see, and an event is an id and a label.

**The one exception: a reporter's workspace that itself holds restricted data.** When the
reporter's own workspace is marked, every answer of the session's view of that workspace,
metadata and content alike, carries the mark into the workspace that reads it, as restricted
data does everywhere else. Triage of such a report waits for a person from the first view
answer on: no reply applied by a rule, no public web fetch. "What the reporter could see" does
not cover what the reporter's workspace is forbidden to send out. The report itself, its images
and its public thread never mark, and a report from an ordinary workspace is unaffected. This
mark does not make the triage workspace admins-only for good: only a read through the whole
binding does (see [After the connection is removed](#after-the-connection-is-removed)).

Its bound: the session learns whether the reporter's workspace is restricted when it opens the
view. A workspace marked after that is read unflagged until the view ends, at most
`ADMIN_AGENT_LEND_SECONDS` later.

**So the one place a rule applies an action** is a workspace that has never read through the
binding, nor a restricted reporter's workspace through a report session. It is the one way a
reply reaches a reporter with no person in between.

**The order.** The latch is set before a read is forwarded and read again before each apply,
and the lend itself refuses an auto-approved action in a marked workspace. A reply drafted, or
a session opened, before the first read therefore waits for a person after it.

**What marks, and what does not.** A session awaits its lend before its first observation, so a
call refused before anything was lent (the vendor is off, the owner is not an admin, a member's
direct session) marks nothing. A read that was lent and that the Admin API itself then refuses
still marks: the mark is made before the answer is known.

### What the latch does not hold back

Reads through the workspace's other connections. The latch holds web fetches and actions; an
observation of another gatekeeper still runs, and its arguments (a search query, a file path, a
message id) can carry what was read to that vendor. A workspace that reads through the admin
binding should hold no connection its owner would not send that data to.

### What an unmarked triage workspace holds

This is the other side of "a report session's reads do not mark". Under the reporter's grant, a
report session reads another user's chats and files, and when the reporter's workspace is an
ordinary one, that content lands in a triage workspace that is not marked. Nothing is held
there: its web fetches go to any host, and the actions of its other connections can still be
applied by a rule. Text in a report, or in the reporter's workspace, can steer a triage agent to
send that content out with no person in between.

Two rules for whoever builds triage:

- the spawner's `env` of a triage agent names no other connection: the session it is handed is
  all it holds;
- the triage workspace holds no connection its owner would not send a reporter's content to.

### What remains

- The flag is the gatekeeper's word, as for every gatekeeper (see
  [What a Worker that keeps everything could do](#what-a-worker-that-keeps-everything-could-do)).
- Code that holds the whole binding and has read nothing through it can open sessions on several
  reports and carry one reporter's text into another's thread, or feed a session what it likes.
  So a triager holds the binding in merged gadget code and hands each agent one session.

## The scoped report session

`AdminBinding.openIssueReport(reportId)` opens a session limited to one report
(`IssueReportSession`). It exists so that a gadget can hand it to an agent that must hold
nothing the reporter could not see: "only what the reporter could see" is a capability, not a
prompt. That is why its reply may reach the reporter with no person in between.

**What it reaches:**

- `get()`: the report as its reporter reads it. The session builds it field by field
  (`scopedReport()`, an allowlist): no links, no admins-only entry, no admin's id and nothing of
  where an admin's entry came from. A field the Admin API adds later does not come through until
  it is named there and in `src/types.d.ts`.
- `readImage(imageId)`: one image of the report, as the stream the Admin API returned.
- `reply(text)`: queues a public reply, as the kind only this session queues
  (`issueReportScopedReply`).
- `inspectWorkspace(reason)`: an audited view of the reporter's workspace (below).

**What it cannot reach:** another report, an admins-only entry, a listing, the audit log, a
setting or a write request. No method takes a report id, nothing it returns leads elsewhere, and
it cannot be widened.

**Its view of the reporter's workspace:**

- It exists only when the reporter owns the workspace the report names. The workspace decides
  that with the report store when the view is opened for the report
  (`AdminWorkspaceInspectOptions.forIssueReport`): the session compares no ids. A workspace
  that is not the reporter's is never opened or described, and leaves no record.
- It makes one `describe` record per view the session opens: the session's own read, to learn
  whether the workspace holds restricted data (see [Restricted data](#restricted-data)).
- It is opened for content only where the deployment's level in force is `"content"`, which the
  session reads from `getSettings()` first. A deployment at the metadata level is asked for a
  metadata view, and records no refused open.
- It reads content only under the grant the reporter gave with that report, or the reporter's
  account-wide grant. The workspace decides that on each call, through `forIssueReport`.
- A grant the admins approved, or one the reporter gave with another report, opens nothing to
  it and is not listed in the view's description: the reporter cannot see the admins' grants
  either.

**Its lend is its own**, and lasts at most `ADMIN_AGENT_LEND_SECONDS` from when the session was
opened: the session that opened it is gone when the opening call returns, and the report
session keeps a copy of that session's queue, whose deadline and whose end (a chat's code run
settling, the connection removed) are its own too. Code that keeps a report session for longer
opens it again.

### The hand-off

A warning first. Any code whose `env` names a gadget can restore a stub of that gadget from
params it chooses (`env.<GADGET>.rpc[restore](params)`). A gadget whose `[restore]()` opened a
session from `{ reportId }` would therefore give every such chat a session on every report.

A gadget hands a report session to a spawned agent as a persistent stub passed at spawn, minted
from a token:

```ts
// In the gadget, when its own code decides to triage `reportId`:
const token = crypto.randomUUID();
await this.ctx.storage.put(`triage:${token}`, reportId);
await agent.triage(instructions, await this.ctx.restore({ token }));

// Its [restore]({ token }) returns a target that keeps the token and nothing else. Each of
// the target's methods opens the session, only for a token the gadget stored:
const reportId = await this.ctx.storage.get(`triage:${token}`);
if (!reportId) throw new Error("No such triage.");
const session = await this.env.ADMIN.openIssueReport(reportId);
```

- The gadget stores a random token with the report id and mints the stub from `{ token }`,
  never from the report id.
- The restored target opens the session in each of its methods, since a session's lend runs
  out, and only for a token the gadget stored.
- The gadget forgets the token when the triage ends.
- It spawns through a spawner whose `env` names neither the admin connection nor the gadget.

The two rules are the token and the spawner's `env`. The token is what holds when the `env`
rule is broken: a chat that can reach the gadget still cannot name a triage it was not handed.
The `env` rule is what keeps the spawned agent from the gadget's other methods and from the
whole binding. Neither is the Workshop's to enforce: `[restore]()` is the gadget's own code, as
it is for every gadget that mints stubs.

**Why a stub and not a bindable resource.** A connection per report would need a person to add
it before each triage.

**How such calls are recorded.** Calls through the stub are the gadget's merged code: recorded
with the workspace and no chat.

## Spawned chats

A spawned chat's bindings are its spawner's `env` and nothing else. It has the admin binding
only when its spawner's `env` names the connection, and naming it hands the spawned chat the
whole binding.

## Hooks

| Hook | Subscribed with | Fires | Its event |
| --- | --- | --- | --- |
| Issue reported | `subscribeIssueReported(hook)` | Once for each report filed. | `{ reportId, priority, filedAt }` |
| Investigation complete | `subscribeInvestigationComplete(hook)` | Each time an admin moves a report from `investigating` to `answered`, `waitingOnReporter`, `withAdmin` or `closed`. | `{ reportId, status, at }` |

An event is ids and labels only: the subscriber reads the report through its own binding.
Subscribing reads nothing and marks nothing. The hook is bound disabled, and delivers once a
person enables it. A hook wakes a gadget's stored callback or an existing chat, as hooks do; it
opens no chat. A delivery is observed with the binding's subresource and no restricted-data
flag, so a workspace that only receives events keeps its rules.

**How the gatekeeper learns of a report: the report store calls it**
(`AdminGatekeeperVendor.issueReportEvents()`), and the deployment's one `IssueReportHookDriver`
queues each event for the hooks enabled for its kind. Polling would need the Worker to hold
something it could call at any time, a stored capability into the report store or a binding:
the standing power this design rules out. A Worker that misbehaved could then list reports
whenever it liked. A pushed event hands it an id, a priority or a status, and a time, which is
exactly what a subscriber receives.

**"Issue reported" fires as the report is filed**, before the reporter's client has attached its
images or given the grant that may come with it. A subscriber that reads at once may find no
image and be refused content, and reads again later.

**A gatekeeper that does not answer** is given up on after `EVENT_RETRY_MS` and offered the
events again from the store's alarm. It holds back neither a later event nor the store's
retention pass.

**Delivery is at least once, twice over.** The store sends an event again until the vendor
resolves, with the same `seq`, and the kit's queue ignores a repeat for
`DELIVERED_RETENTION_MS`. The kit retries a firing that failed, up to `MAX_DELIVERY_ATTEMPTS`
times. So a subscriber sees an event twice only when its own callback failed or timed out after
doing part of its work: a callback keys its work by the report's id, and for an investigation
by its status too.

**A callback has `HOOK_CALLBACK_TIMEOUT_MS` (30 seconds) to answer.** The deployment has one
driver, and its alarm waits for every delivery it started, so a callback that did not settle
would hold back every later event of every workspace's hooks and never count as a failed
attempt. The facet's delivery gives up on a callback that has not answered in time, which the
kit's queue retries and in the end drops as any failed delivery. The declarations tell a
subscriber to start long work and return: a call to an agent is recorded and returns at once.

**What is lost:**

- events while the gatekeeper is turned off or not bound: the store deletes them, and turning
  the gatekeeper on later replays nothing;
- events the gatekeeper did not take for `EVENT_MAX_AGE_MS`;
- events that arrive while no hook of their kind is enabled: `ingest()` queues an event for
  the hooks enabled then, and a hook enabled later is sent nothing older;
- events the kit gave up on while a workspace's owner was not an admin, or held no account: the
  Workshop refuses those firings (`startHook()`).

**What is kept** through all of that: the connection, its hooks and its rules. They deliver and
apply again once the owner is an admin with the account.

## What is recorded where

The admin audit log does not hold everything an agent does. It holds what the Admin API records
for any admin, and no more:

| Call | The admin audit log | The report's thread | The workspace's own activity |
| --- | --- | --- | --- |
| Opening a view: `inspectWorkspace()`, a report session's included, `inspectUser()`, and a refused open | An access record, with `via: "gatekeeper"` and `agent: { workspaceId, chatId? }` | | An observation |
| Each call of a view, metadata and content | An access record, with the same `via` and `agent`, and the grant it ran under | | An observation |
| A write request an agent filed | Its `"requested"` and `"expired"` records, with the same `via` and `agent`. A denial, an approval and what follows carry the `via` of the admin who made them. | | An action, with its card |
| `addIssueReportEntry()`, `setIssueReportStatus()` | None | The entry or status line, with `via: "gatekeeper"` and, for admins, the origin | An action, with its card |
| `listUsers()`, `listWorkspaces()`, `getSettings()`, `isBlueprintFeatured()`, `listAdminAudit()`, `getAdminAuditStats()`, `listIssueReports()`, `getIssueReport()`, `readIssueReportImage()`, `getWorkspaceWrite()`, and a report session's `get()` and `readImage()` | None | | An observation |
| A hook's delivery | None | | An observation |

- **In the audit log**: the calls the Admin API records for any admin. A report session's view
  adds the one `describe` it makes when it opens.
- **In no audit record**, for an agent as for any admin: the listings and getters of the fifth
  row, and the two report writes. For the two writes the trace is the thread entry. For the
  reads, the only trace is the observation in the activity of the workspace that made the call
  (`Admin API: <method>`, with who prompted the turn), which lives and is deleted with that
  workspace. A deployment that needs a durable record of an agent's listings does not get one
  from this version.
- **In the workspace's activity**: every read as an observation, and every "act" call as an
  action with its card, who decided it (`resolvedBy`) and whether a rule applied it.

**Where the person is found.** Every record names the owner, so the person behind a call is
found elsewhere:

- for an agent's turn, in the chat the record names: who prompted it;
- for a decision, in the action's record (`resolvedBy`);
- for a call with no chat, in the gadget's merged code;
- for a session opened directly from the connection, the owner: nobody else is lent one, and
  nobody else's queues an action;
- for an entry or a status line, in the report's thread, which marks an agent's;
- in this Worker's logs, event names only: no argument, result or report id is logged.

## Limits

- **Nothing is simulated.** A queued entry, status or request is in no read until it is applied,
  and an agent's turn waits for a manual decision.
- **An "act" call resolves to nothing**, `requestWorkspaceWrite()` included, so an agent is not
  handed the id of the request it filed. The declarations (`src/types.d.ts`) tell it how to
  find the request:

  > A write request you file is not returned to you: requestWorkspaceWrite() resolves to
  > undefined, and the request exists only once its action has been approved. To follow it,
  > read listAdminAudit({ kind: "write", workspace: <the workspace you named> }): the record
  > whose `event` is "requested" and whose `agent.workspaceId` is this workspace carries the
  > `requestId`, which getWorkspaceWrite() takes. A human admin approves the request with a
  > passkey; you cannot.

  The match is on the workspace alone, never on a chat: a gadget's call has none, and an agent
  is not told its chat's id.
- **The reply split and the restricted-data mark are the Worker's own declarations** (see
  [What a Worker that keeps everything could do](#what-a-worker-that-keeps-everything-could-do)).
- **Non-admins admitted again after the connection is removed read what report sessions left in
  the chats** (see
  [What the non-admins who come back can read](#what-the-non-admins-who-come-back-can-read)).
- **The latch does not hold back reads through other connections** (see
  [What the latch does not hold back](#what-the-latch-does-not-hold-back)).
- **A reporter's workspace marked after a report session's view was opened is read unflagged
  until that view ends** (see [Restricted data](#restricted-data)).
- **An ordinary reporter's content, read by a report session, sits in a triage workspace that
  is not marked**, where web fetches and other connections' actions are not held (see
  [What an unmarked triage workspace holds](#what-an-unmarked-triage-workspace-holds)).
- **A connection's actions apply in order.** A public reply that waits for a person holds back
  that connection's later notes, status changes and requests, and a triager's scoped replies
  too. Give triage a workspace of its own.
- **A status is set over whatever the report has by then.** The action is lent no read, so its
  card names no earlier status.
- **What the agent reads goes into the chat and to its model provider.**
- **A view's own limits** are those of
  [docs/admin-access.md](../../docs/admin-access.md#inspection).

## Removing the account, and blueprints

**Removing the account ends every connection made with it.** Everywhere else, removing an
account ends what its connections can do because the account's `revoke()` ends the vendor's
token. This account has no token: the Worker holds nothing, so its `revoke()` can end nothing.
The power is the Workshop's, so the Workshop asks the owner's account
(`UserDurableObject.holdsGatekeeperAccount()`) at each lend and each hook firing. The
connections, their rules, hooks and pending actions stay, refused, until the account is added
again or they are removed. A session that is open keeps its lend until it ends. In mode
"enabled" the account cannot be removed.

**Blueprints carry nothing.** A blueprint of a gadget that uses the binding keeps the vendor and
the resource's URL pattern, and nothing else. Whoever instantiates it adds the connection from
an account of their own:

- a non-admin can hold no account of this vendor, so their instance gets no connection and the
  binding stays unfilled;
- an admin's instance has an ordinary connection, which the owner check of `newGatekeeper()`
  and the admission rule apply to from that moment;
- no hook subscription travels with a blueprint: a subscription is a record of the workspace,
  made at run time by the installer's own code through the installer's own connection.

## Departures from the usual gatekeeper

- **Sessions without `@validateRpc()`.** A session class's methods come from the schema at
  load, so its TypeScript type declares none of them and a validator built from it would refuse
  them all. Each call's arguments are checked against the schema instead
  (`checkArguments()`), and the Workshop validates them again where the call lands. A method
  written by hand on the binding's session checks its own arguments. For the same reason the two
  methods that return such a session skip validation of their result (`@skipRpcValidation()`
  on `startSession()` and on `IssueReportSession.inspectWorkspace()`): a validated return would
  wrap the session in a proxy that refuses every method. `IssueReportSession` itself carries
  `@validateRpc()`.
- **Actions are applied through `applyAdminAction()`**, which hands over the Admin API lent for
  that one action. `applyAction()` refuses, and no action can be reverted.
- **`verifyObserverAccess()` allows every observer it is asked about.** Who may see what the
  binding read is a question of who is a deployment admin, which this Worker cannot tell:
  admission is the Workshop's. Every observation carries exactly one subresource id,
  `ADMIN_BINDING_SUBRESOURCE` for the whole binding and a hook's delivery,
  `REPORT_SUBRESOURCE` for a report session; `getHistoricalSubresources()` returns `[]`, and
  `addObserver()` and `removeObserver()` do nothing.

## Tests

`pnpm --filter @gadgets/gatekeeper-instanceadmin test:run` runs both projects, after writing
the schema when it is stale and building the configurator frame.

- `__tests__/surface.test.ts` (Node): the generated surface. The session's methods are exactly
  those the kind table does not omit; the declarations, with each "act" method resolving to
  nothing and no omitted method; and every load-time check refusing the schema it is for.
- `__tests__/workerd/session.test.ts`: the facet, the account and the vendor; a session's
  reads, lent, then observed, then forwarded, each marking under the binding's id; a view a
  session opened; what a session refuses; disposal.
- `__tests__/workerd/actions.test.ts`: each of the six kinds queued with its card and applied
  as exactly the stored call, once; the verdicts, and what splits the two replies and the two
  requests; what is refused before anything is queued; an action that fails to apply, is lent
  nothing or is under way.
- `__tests__/workerd/report-session.test.ts`: the allowlist; a session that can name no other
  report; its reply's card; its view, opened for the level in force and refused by the
  workspace's own answer; and what its reads record, with the mark of a restricted reporter's
  workspace on its view's calls alone.
- `__tests__/workerd/hooks.test.ts`: subscribing; an event firing each hook of its kind once; a
  delivery that fails; the delivery stub; the vendor's `issueReportEvents()`; and the driver's
  storage, which holds ids and labels only.

The kernel's side is in `packages/workshop-backend/__tests__/`: `admin-agent-kinds.test.ts`
(the two tables), `admin-agent.test.ts` (`restrictAdminApi()` and a view behind it),
`admin-agent-lend.test.ts` (the lend, what it records, restricted data, who is lent, the
insiders of a content request, a spawned chat), `admin-workspace-admission.test.ts` (the
admission rule, with and after the connection), `issue-report-events.test.ts` (the store's
events), `provisioning-policy.test.ts` and `user-ambient-accounts.test.ts` (the mode and who
holds the account).

End to end, with a scripted model, in `packages/integration-tests/__tests__/`:
`admin-gatekeeper.test.ts` (who is offered it, the records, admission, the two-person rule,
removal, a blueprint, a demoted owner), `admin-gatekeeper-actions.test.ts` (the verdicts under
rules, the restricted-data order, the report session) and `admin-gatekeeper-hooks.test.ts`
(both hooks into a gadget's stored callback, a spawned chat with and without the binding, the
hand-off and a forged stub).

## Reviewing a change here

[REVIEW.md](../../REVIEW.md) holds the kernel's invariants. For this package, flag:

- an "act" method answered outside an approved action;
- an action kind added without a tag of its own;
- an action kind that files `"grantContentAccess"` with `autoApprovable` true;
- a "read" method that returns a view with no entry of its own in `ADMIN_AGENT_VIEWS`;
- a read through the whole binding observed without `containsRestrictedData`, without
  `ADMIN_BINDING_SUBRESOURCE`, or before its lend resolved;
- a report session's observation that names `ADMIN_BINDING_SUBRESOURCE`, or its view of a
  restricted workspace observed without the flag;
- a comparison of a reporter's id with an owner's outside the report store;
- a lend or a hook firing that does not ask the owner's account
  (`UserDurableObject.holdsGatekeeperAccount()`);
- anything that gives this Worker a binding or a stored capability that reaches the Admin API
  or the report store.
