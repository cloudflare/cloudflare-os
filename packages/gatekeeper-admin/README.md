# The admin gatekeeper

A deployment admin's agent uses the deployment's Admin API as that admin, through this gatekeeper.
Its sessions are built from the API's generated schema: one method for each Admin API method an
agent may call, with the declarations the agent reads and the check each call's arguments pass.
Reads run at once; what would post to an issue report, set its status, claim or release it, or
ask the admins for a write is queued as an action. Three hooks start work on issue reports: one
fires for each report filed, one each time an investigation ends, and one for every write to a
report after it was filed. What an admin sees and does through it is in
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
| The seven actions | `src/actions.ts` |
| The session limited to one report | `src/report-session.ts` |
| The three hooks | `src/hooks.ts` |
| The facet, the account, the vendor | `src/worker.ts` |

## Who can use it, and where

The gatekeeper is part of every deployment and takes no deploy input. Its vendor
(`ADMIN_GATEKEEPER_VENDOR_ID`, `admin`) auto-provisions its account, with no connect
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
pick the resource (`admin://deployment`, "Deployment admin"), then the account. Only a
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

Which workspaces stay closed is decided by one fact, the mark that reading or receiving anything
through the connection makes: a read through the whole binding, a report session's read, and a
hook's delivery all make it (see [Restricted data](#restricted-data)):

- **A workspace that never read or received anything through the connection is ordinary again
  at once.** It may have opened report sessions, queued actions or subscribed to hooks that
  never fired. The people kept in its sharing list are admitted at their next open, with nobody
  inviting them.
- **A workspace that has read or received anything through the connection stays admins-only
  for good.** Its chats hold what was read, and nothing lifts the rule.

Each rule reads its own fact:

- Nothing applied by a rule, and web fetches held: the restricted-data latch, which any
  observation that carries `containsRestrictedData` sets, of any connection.
- Admins-only for good: `storage.adminReads`, which the Workshop sets in the transaction that
  sets the latch, for an observation of this gatekeeper that carries the flag and names
  `ADMIN_BINDING_SUBRESOURCE`. It is never set without the latch.

While the workspace has the connection it is admins-only whatever it read
(`hasAdminConnection()`).

A latch set by another connection's observation does not close the workspace for good: only
this connection's subresource does.

A member who tries to add a non-admin is refused with the reason (`ADMINS_ONLY_REFUSALS`), which
the Share dialog shows on the person's chip:

> This workspace has the deployment admin connection, so only deployment admins can be added to
> it. Remove the connection to share it with others.

> This workspace has read through the deployment admin connection and its chats hold what was
> read, so only deployment admins can be added to it. Removing the connection does not change
> that.

Non-admins who were in the sharing list before stay listed and stay refused until the owner
removes them.

### Removing the account

An admin who removes their account in mode "optional" ends every connection made with it, in
every workspace they own, at the next session, action or hook firing. Adding the account again
restores them. [Removing the account, and blueprints](#removing-the-account-and-blueprints) has
the reason.

## The two-person rule there

A request for a workspace's content must be approved by an admin other than its requester (see
[docs/admin-access.md](../../docs/admin-access.md#asking-for-content-without-the-owner)). A
request filed through this gatekeeper is its workspace owner's, and other admins can work in that
workspace, so the rule counts everyone who was there.

- **What is compared.** `isRequestInsider()` (`packages/workshop-backend/src/admin-access.ts`)
  refuses an approver who is the requester or one of the request's insiders: the workspace's
  owner, everyone the workspace is shared with in any role, and the member who approved the
  filing. Each is compared with `sameDeploymentAdmin()`, at the two places the base compares
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
- **For an approved action**: an Admin API that answers one call, of a method the action's kind
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
it does for any admin. The first three are checked again once the off switch has been read and
once the call has settled, so a call that spans the lend's end returns nothing, and a view it
returned is let go.

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
- serve one caller with another's lend while that lend is live. A lend is a plain capability,
  and nothing ties a call on it to the session it was lent for, so the Worker could answer one
  chat's call with the lend of another chat or of a gadget. The records then name the lend
  that was used, its owner, its workspace and its chat, and not the caller that was served.
  Nothing in the Workshop ties a lend to one admin's workspaces either, so the same holds
  between two admins wherever the Worker can pass a lend from one of its objects to another;
- fire an enabled hook when it chooses, with an event it made up. Its driver keeps each
  enabled hook's `HookInitiator`, and the Workshop's `startHook()` checks that the hook is
  enabled, the gatekeeper is on and the owner is an admin who holds the account, never that
  the store sent an event. A subscriber's callback that then reads through its binding, as it
  is told to, opens a session, and with it a 15-minute lend of the reads;
- misdeclare what is its own to declare: queue a reply drafted through the whole binding under
  the scoped reply's tag (`issue-report-scoped-reply`), or leave the restricted-data flag off a
  read or a hook's delivery, and so get a rule's approval for what should wait for a person.

The split between a reply through the binding and a reply through a report session, and the
restricted-data mark, hold against agents and gadgets, which choose neither. They are the
Worker's word, as an action's kind and an observation's flag are for every gatekeeper: the
Worker is deployed with the Workshop and trusted for its own declarations.

It can never:

- act with nothing lent: no session open and no approved action being applied. It can cause a
  session only as above, in a workspace where a person enabled a hook whose callback uses the
  binding;
- make a second call under one approval;
- call an omitted method;
- approve anything;
- be recorded as anything but `"gatekeeper"`, with a workspace and a chat the Workshop named
  for a lend that was live at the call. An origin says which lend made a call. That the lend
  was used for the session it was lent for is the Worker's word.

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
  report session and the three hooks.
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
8. Every "act" method has a route to an action, and each route is a call of an action kind of
   `ADMIN_AGENT_ACTIONS` (`adminAgentActionMethods()`: a kind's one method, or the two of an
   assignment).

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
| `"read"` | `getSettings()`, `listUsers()`, `listWorkspaces()`, `inspectWorkspace()` and `inspectUser()` and every method of the view each returns, `listAdminAudit()`, `getAdminAuditStats()`, `listContentAccessRequests()`, `getContentAccessRequest()`, `whoami()`, `listIssueReports()`, `getIssueReport()`, `readIssueReportImage()` | Runs at once, on the owner's Admin API, and returns its result. Metadata, and a workspace's content under a live grant, exactly as its view's own per-call check decides. A view of a user's account returns metadata alone. |
| `"act"` | `addIssueReportEntry()`, `setIssueReportStatus()`, `claimIssueReport()`, `releaseIssueReport()`, `writeWorkspace()`, `requestContentAccess()` | Never runs when called. It is queued as one of the seven actions below, and runs once that action is approved, as exactly the queued call. |
| `"omitted"` | Every setter and every other method that changes a setting, the gateway tests, `checkForUpdates()`, `getUpdateStatus()` and `isBlueprintFeatured()`, which repairs the featured catalog's mirror as it reads, approving or denying a content access request, `endWorkspaceGrant()`, `setIssueReportLinks()` | Absent from the declarations and refused, by the session and by the Workshop. |

The seven action kinds (`ADMIN_AGENT_ACTIONS`). Each card is built from the call's own arguments,
never from a read, so queuing an action marks nothing:

| Kind | Tag | `autoApprovable` | The card says |
| --- | --- | --- | --- |
| `issueReportReply`: a public reply through the binding | `issue-report-reply` | `false` | The report's id and the whole reply, and that it was written with access to what only admins see. |
| `issueReportScopedReply`: a public reply through a report session | `issue-report-scoped-reply` | `true` | The report's id and the whole reply. |
| `issueReportNote`: an admins-only entry | `issue-report-note` | `true` | The report's id and the whole note. |
| `issueReportStatus`: a report's status | `issue-report-status` | `true` | The report's id and the status, and what the reporter reads where that is another status. |
| `issueReportAssignment`: a claim or a release of a report | `issue-report-assignment` | `true` | The report's id, whether it is claimed or released, and that it is for this workspace's owner. |
| `workspaceWriteRequest`: a write to a workspace (`writeWorkspace()`) | `workspace-write-request` | `false` | The workspace, the action, its arguments and the reason, and that the write runs as the owner once approved. |
| `contentAccessRequest`: a request for a workspace's content (`requestContentAccess()`) | `content-access-request` | `false` | The workspace and the reason, and that nobody in this workspace can approve the request. |

A scoped reply's card names the report by its id alone. The session reads nothing to queue it,
so the card, which the workspace keeps after the connection is removed, holds nothing of the
report, and queuing a reply marks nothing.

**A status's card says what the reporter reads.** The card names the status as admins read it
and, for `fixSuggested` and `fixInProgress`, adds a "Reporter reads" line with the words the
reporter's page gives `withAdmin`, "With the admins" (`issueReportStatusForReporter()`, the
Workshop's one function for it, says which status). Its text
says that the reporter sees the change in the thread unless they read the old status and the
new one as the same.

**An assignment is one kind for two calls.** `claimIssueReport()` and `releaseIssueReport()`
both queue `issueReportAssignment`, so a rule for claiming is a rule for releasing, and the
Workshop holds the approved action to one call of those two methods.

- **The card names the report and whom it is for, in words.** Its title is the report's id
  between "Assign issue report" and "to this workspace's owner", or between "Release issue
  report" and "from this workspace's owner": the owner is the admin the connection acts as,
  whoever approves the card. It names no person by a read, since queuing reads nothing; which
  admin the owner is, the Workshop decides where the call lands.
- **It never takes a report over.** The route refuses a claim with `takeOverFrom` set,
  whoever it names, before a card exists, so that no person approves one by mistake, and tells
  the agent that only a person takes a report from the admin who holds it. The report store
  refuses it again where the call lands, whatever approved it: it reads the call's label,
  `via: "gatekeeper"`, which only the Workshop sets.
- **`assigned` is a refusal that ends the action** (`TERMINAL_REFUSALS`): another admin holds
  the report, nothing was done, and the action is failed for good rather than left with an
  outcome nobody knows. Its card stays pending in the Workshop until a person rejects it, and
  holds the connection's later actions meanwhile (see [Limits](#limits)).
- **An applied claim of a report the owner already holds, and a release of one nobody holds,
  change nothing**: no thread line and no event.

**`whoami()` is a read like any other.** It returns the workspace's owner as reports name them
(the id a report's assignee and an entry's author carry), so code can tell its own admin's
reports from another's. It is forwarded, observed and flagged as every read of the whole
binding is, so it marks the workspace as the next section describes.

**The three `false` verdicts**:

- `issueReportReply` (rule 2 of the write-gatekeeper skill): it sends text to the reporter, a
  person outside the workspace, written by code that can read what only admins see. It always
  waits for a person, whatever rules the workspace has.
- `workspaceWriteRequest`: once approved, the write runs at once in another workspace, as a
  deployment admin, with no second admin deciding. The person who approves the card is the one
  check between the agent and that workspace, so no rule may stand in for them.
- `contentAccessRequest` (rule 7 of the skill): it asks for access to a workspace's content, and whoever
  approves the filing is one of those who may not approve the request, which only a person
  present can be.

**The two public kinds never share a rule.** Rules are
stored under an action's tag, and each kind has a tag of its own. Which public kind a reply is
queued as is decided by the capability the call came through, never by an argument: the
binding's session queues `issueReportReply`, a report session queues `issueReportScopedReply`.
The Workshop refuses to lend to an
auto-approval of an action whose tag is that of a kind whose verdict is `false`, whatever the
action's own description claims, and checks the one call an approved action makes against its
kind.

**Why filing a content request is an action**, though what it files still needs a second
admin: it stores a request every admin sees, takes one of the deployment's pending slots, and
puts text an agent wrote in the admin panel's pending approvals.

**What a rule cannot use up.** A rule applies an action with no person deciding, so what a rule
can repeat without end is bounded where it lands, in the Workshop, apart from what people do:

- content requests filed through the gatekeeper hold at most
  `MAX_PENDING_AGENT_CONTENT_REQUESTS` (10) of the deployment's `MAX_PENDING_CONTENT_REQUESTS`
  (50) pending slots, across every workspace; the next is refused `tooManyRequests`, and the
  requests people make keep the rest. A write takes no slot: no rule can approve one;
- one report takes at most `MAX_ISSUE_REPORT_THREAD_ENTRIES` (200) changes of status made
  through the gatekeeper; the next is refused `threadFull`. A person's change of status is
  never refused, so a report can always be closed;
- one report takes at most that many public entries written through the gatekeeper, and that
  many admins-only ones, each counted apart from the entries people write. An agent that fills
  its own share of a thread is refused `threadFull` and leaves the admins all of theirs;
- one report takes at most that many changes of assignee made through the gatekeeper. A
  person's claim, take-over or release is never refused for it.

Those four bounds are per report and per kind, for every admin's agents and gadgets together
(see [Limits](#limits)).

**What is refused before a card is made.** A text or a reason the Admin API would refuse, and a
write's arguments that do not fit its action (`ADMIN_WRITE_ARGS`, the Workshop's own
table): a required one missing, one the action does not take, or an id that is not a
non-negative whole number. The Admin API refuses these with no code, which an approved action
could only report as an outcome nobody knows.

**No action runs twice.** Every kind claims its action before it calls. A coded refusal the
Admin API makes before it writes anything (a report that is gone, a full thread, a closed
report, one another admin holds) fails the action for good; any other failure (a broken call, an
error with no code) leaves an outcome nobody knows, which is never run again: a person looks at
the report's thread or the audit log, and rejects the action. Either way the Workshop keeps the
action pending until a person rejects it, with nothing on its card that says it failed:
approving it again answers with the same failure and calls nothing, and a rule's drain stops at
it each time, so the connection's later actions wait behind it (see [Limits](#limits)). A
status is claimed like the rest:
set again after someone had changed the report's status, it would undo their change, with a
second status line and a second end of an investigation.

**A verdict of `true` is a ceiling.** A rule applies an action only in a workspace that holds no
restricted data, which the next section makes rare on purpose.

## Restricted data

This is the rule of this version.

**Everything read or received through the connection marks the workspace as holding restricted
data, and keeps it admins-only for good.** Each observation the Worker makes carries
`containsRestrictedData` and the binding's subresource, so the Workshop sets its latch and
`storage.adminReads` together (see
[After the connection is removed](#after-the-connection-is-removed)). That is:

- every read through the whole binding: listings, settings, the audit log, reports and every
  view method;
- every read of a report session: `get()`, `readImage()` and each call of its view of the
  reporter's workspace;
- every hook's delivery, of any event.

From the first one on, the Workshop enforces what it enforces for restricted data everywhere:

- nothing is applied by a rule: an admins-only note, a status change, a filed request and a
  report session's reply all wait for a person;
- web fetches reach only the hosts the deployment trusts with such data;
- a push is refused.

**Why a report session's reads mark too.** A report session reads only what the reporter could
see, but that is not data a workspace may send anywhere. A report's images are screenshots of
whatever the reporter had on screen, its text is whatever its author wrote, and anyone can file
one. A triage workspace that kept its web fetches and its rule-applied actions could be steered
by a report to send another user's content out with no person deciding. A hook's event is ids
and labels, but what it tells (an admins-only note was added, an investigation ended as a fix
suggested) is the admins' to share, so it marks as reading the report does.

**This is coarser than it needs to be.** A reply to a report's reporter tells them nothing they
could not see, and an admins-only note tells admins nothing they could not read, yet both wait
for a person once the workspace has read the report. Releasing such an action needs a model of
who can see its effects: [the audience design](../../docs/restricted-data-audiences.md)
proposes one, and this rule stands until it lands.

**So a rule applies this connection's actions only** in a workspace that has read and received
nothing through it.

**The order.** The latch is set before a read is forwarded and read again before each apply,
and the lend itself refuses an auto-approved action in a marked workspace. A reply drafted, or
a session opened, before the first read therefore waits for a person after it.

**What marks, and what does not.** A session awaits its lend before its first observation, so a
call refused before anything was lent (the vendor is off, the owner is not an admin, a member's
direct session) marks nothing. A read that was lent and that the Admin API itself then refuses
still marks: the mark is made before the answer is known. Opening a report session, queuing an
action and subscribing to a hook read nothing and mark nothing.

### What the latch does not hold back

Reads through the workspace's other connections. The latch holds web fetches and actions; an
observation of another gatekeeper still runs, and its arguments (a search query, a file path, a
message id) can carry what was read to that vendor. A workspace that reads through the admin
binding should hold no connection its owner would not send that data to. For triage:

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
prompt. What it reads still marks the workspace (see [Restricted data](#restricted-data)), so
its reply waits for a person once anything has been read.

**What it reaches:**

- `get()`: the report as its reporter reads it. The session builds it field by field
  (`scopedReport()`, an allowlist): no links, no assignee, no admins-only entry, no admin's id
  and nothing of where an admin's entry came from. A field the Admin API adds later does not
  come through until it is named there and in `src/types.d.ts`, and a status this Worker's
  build does not know reads `withAdmin`: the Workshop is deployed apart from it, and may store
  one added since.
  - **Each status is the one the reporter reads**: the report's and each entry's go through
    `issueReportStatusForReporter()`, the function the report store builds the reporter's own
    view with, so `fixSuggested` and `fixInProgress` read as `withAdmin` and the declared
    union holds neither.
  - **It holds no line only admins read**: not a change of assignee, and not a change of
    status between two statuses the reporter reads as the same.
- `readImage(imageId)`: one image of the report, as the stream the Admin API returned.
- `reply(text)`: queues a public reply, as the kind only this session queues
  (`issueReportScopedReply`).
- `inspectWorkspace(reason)`: an audited view of the reporter's workspace (below).

**What it cannot reach:** another report, an admins-only entry, a report's assignee, a listing,
the audit log, a setting, a write or a content request. It cannot assign: it has no method that
claims or releases, and no `whoami()`. No method takes a report id, nothing it returns leads
elsewhere, and it cannot be widened.

**Its view of the reporter's workspace:**

- It exists only when the reporter owns the workspace the report names. The workspace decides
  that with the report store when the view is opened for the report
  (`AdminWorkspaceInspectOptions.forIssueReport`): the session compares no ids. A workspace
  that is not the reporter's is never opened or described, and leaves no record.
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
| Issue reported | `subscribeIssueReported(hook)` | Once for each report filed. | `{ eventId, reportId, priority, filedAt }` |
| Investigation complete | `subscribeInvestigationComplete(hook)` | Each time an admin moves a report from `investigating` to any status but `new`. | `{ eventId, reportId, status, at }` |
| Report changed | `subscribeIssueReportChanged(hook)` | For each write to a report after it was filed, whoever made it: its status set, a claim, a take-over or a release, an entry added to its thread, its links replaced. | `{ eventId, reportId, change, status?, at }` |

An event is ids and labels only: the subscriber reads the report through its own binding.
Subscribing reads nothing and marks nothing; every delivery marks the workspace (below). The
hook is bound disabled, and delivers once a person enables it. A hook wakes a gadget's stored
callback or an existing chat, as hooks do; it opens no chat. The third hook is built as the other two are: who may subscribe, and whose
firings the Workshop refuses, are the same.

**Every delivery marks the workspace.** Each is observed in the subscriber's workspace with
`containsRestrictedData`, under the binding's subresource, before the callback is called: the
latch, and admins-only for good, exactly as a read through the whole binding (see
[Restricted data](#restricted-data) and
[After the connection is removed](#after-the-connection-is-removed)). The hooks fire for every
report of the deployment, so a workspace that subscribes is marked by the first event any
report sends it.

**What "Report changed" fires for.** One write to a report is one event, whose `change` says
what the write was (`ISSUE_REPORT_CHANGES`):

| `change` | The write | `status` |
| --- | --- | --- |
| `status` | `setIssueReportStatus()`, by an admin or an agent | The status set, as admins read it. |
| `assignment` | A claim, a take-over or a release | |
| `reply` | A public entry: the reporter's reply, an admin's, an agent's | `withAdmin`, on the reporter's reply that reopened the report; otherwise none. |
| `note` | An entry for admins alone | |
| `links` | `setIssueReportLinks()` | |

- **It carries no text, no name and not who made the write.** The subscriber reads the report.
- **A report that leaves `investigating` fires this hook and "Investigation complete"**: two
  events for the one write, each with an `eventId` of its own.
- **Filing fires "Issue reported" alone.** An image and a grant are what the reporter attaches
  to a report, not writes to its status, assignee, thread or links, and fire nothing, whenever
  they arrive.
- **A report's events reach a subscriber in no particular order, and several at once.** The
  report store sends them oldest first, but the driver queues one call's events as due
  together, and the kit's queue attempts what is due together side by side. So an event's
  `status` is the one that write set, which may no longer be the report's, and the two events
  of a write that left `investigating` come in either order. The declarations, the preamble
  and the hook's description tell a subscriber to read the report rather than keep the last
  `status` it was sent.
- **It fires for the subscriber's own writes too**: those of its workspace's agents and
  gadgets, as of an admin, the reporter and every other admin's code. That is how code learns
  that an action it queued was applied: the event arrives once the action was approved and has
  run. So a subscriber that writes to a report on each event must not answer its own change.
  The hook's description, the declarations and the preamble all say so.

**What sends no event**, as the declarations tell agents: an applied action that changed
nothing (a claim of a report the owner already holds, a status the report already has), a
denied action, and one refused where it lands (`assigned`, `threadFull`). So code that queued
an action and waits to learn what became of it reads the report as well, and never waits on
the event alone.

**How the gatekeeper learns of a report: the report store calls it**
(`AdminGatekeeperVendor.issueReportEvents()`), and the deployment's one `IssueReportHookDriver`
queues each event for the hooks enabled for its kind. Polling would need the Worker to hold
something it could call at any time, a stored capability into the report store or a binding:
the standing power this design rules out. A Worker that misbehaved could then list every
report of the deployment whenever it liked, with no workspace involved. A pushed event hands it
its own id, a report's id, a priority, a status or what a write was, and a time, which is
exactly what a subscriber receives.

What the Worker does keep is each enabled hook's `HookInitiator`, as every gatekeeper with
hooks does, and that is a narrower standing power, not none: a Worker that misbehaved could
fire a hook with no event behind it (see
[What a Worker that keeps everything could do](#what-a-worker-that-keeps-everything-could-do)).
It reads nothing by itself. It reaches reports only where a person enabled a hook, only while
`startHook()` still finds the gatekeeper on and the owner an admin, and only through the
session the subscriber's own callback opens.

**"Issue reported" fires as the report is filed**, before the reporter's client has attached its
images or given the grant that may come with it. A subscriber that reads at once may find no
image and be refused content, and reads again later.

**A gatekeeper that does not answer** is given up on after `EVENT_RETRY_MS` and offered the
events again from the store's alarm. It holds back neither a later event nor the store's
retention pass.

**Delivery is at least once, twice over.** The store sends an event again until the vendor
resolves, with the same `id`, and the kit's queue ignores a repeat for `DELIVERED_RETENTION_MS`.
The kit retries a firing that failed, up to `MAX_DELIVERY_ATTEMPTS` times. So a subscriber sees
an event twice only when its own callback failed or timed out after doing part of its work: a
callback of any hook keys its work by the event's `eventId`, which is what the declarations and
the preamble tell agents. The store writes that id with the event, so every delivery of one
event carries it and no two events share it. A report can be investigated again and end with the
status it ended with before, in the same millisecond too, which is a second event: its `eventId`
differs where its `at` may not. The id is random rather than the store's count of its events,
which would tell a subscriber how many reports the deployment has had and how many
investigations have ended.

**A callback has `HOOK_CALLBACK_TIMEOUT_MS` (30 seconds) to answer.** The deployment has one
driver, and its alarm waits for every delivery it started, so a callback that did not settle
would hold back every later event of every workspace's hooks and never count as a failed
attempt. The facet's delivery gives up on a callback that has not answered in time, which the
kit's queue retries and in the end drops as any failed delivery. The declarations tell a
subscriber to start long work and return: a call to an agent is recorded and returns at once.

**One queue delivers every hook, and "Report changed" fills it fastest.** The deployment has
one driver and one queue for the hooks of all three kinds:

- a run of its alarm attempts at most `MAX_DELIVERIES_PER_RUN` (20) deliveries, the earliest
  due first, together, and lasts as long as its slowest callback: 30 seconds at most. It then
  comes back at once for what is still due;
- a failed delivery is due again a minute later (doubling to an hour, dropped after
  `MAX_DELIVERY_ATTEMPTS`, 8), so it goes behind what is already due and never holds the same
  place twice;
- so a delivery waits behind every delivery due before it, 20 a run: with N ahead of it, it is
  attempted within ceil(N / 20) further runs.

The third hook raises N. A reporter can cause `MAX_ISSUE_REPORT_REPLIES_PER_DAY` (100) events a
day, where filing gives `MAX_ISSUE_REPORTS_PER_DAY` (20). Code whose writes rules apply can
cause `MAX_ISSUE_REPORT_THREAD_ENTRIES` (200) of each of the four kinds written through the
gatekeeper: up to 800 on one report. A subscriber that writes on every event does so with no
person only for replies: the event of its first note, status or assignment marks its
workspace, and no rule applies what it queues after that. Each event is
one delivery for every enabled hook of its kind. With 800 events, three subscribed hooks and
every callback timing out, that is 2,400 deliveries, 120 runs, and an hour before an "Issue
reported" delivery behind them is attempted. It is delayed, never lost and never reordered
past its own retries. The design accepts the delay rather than give each kind a queue.

### Deploy orders

A release deploys Workers one at a time, so for a while the Workshop and this Worker are of
two builds.

- **The Workshop first.** The report store sends "changed" events to a gatekeeper that has no
  hook for them. It takes and drops them, so "Issue reported" is never held behind one. A hook
  subscribed once the gatekeeper is deployed sees only later writes. An admin can already set
  one of the three fix statuses: a report session of the earlier build does not know them and
  reads each as `withAdmin`, the report's and a status line's alike, so `fixProposed` reads
  `withAdmin` there too until this Worker is deployed.
- **The gatekeeper first.** Nothing sends the third kind yet, so a subscribed hook stays
  silent. A claim, a release, `whoami()` or one of the three fix statuses is refused where it
  lands, by a Workshop that does not know it.

`issueReportEvents()` takes an event of a kind, or with a label, that this Worker's build does
not know, and drops it (`declaredFields()`), logging a count. A gatekeeper built before it
learned to drop unknown kinds would reject such a call, and the store would resend it for a
day, holding "Issue reported" behind it; none was released. A kind or a label added to the
store therefore never stalls an older gatekeeper, but it is not delivered later either: an
event of a kind the Worker has no hook for, and an event of a known kind whose label the
Worker's build does not know, is dropped for good. Deploy the gatekeeper first when subscribers
must see every event of a kind or a label the store adds.

That is also why `GatekeeperVendor` does not declare `implements AdminGatekeeperVendor`:
capnweb-validate would check `issueReportEvents()` against the contract's union and refuse the
unknown event this method exists to take. The class is checked against the contract by type
alone, and an event that is not ids and labels is still refused.

**What is lost:**

- events while the gatekeeper is turned off or not bound: the store deletes them, and turning
  the gatekeeper on later replays nothing;
- events the gatekeeper did not take for `EVENT_MAX_AGE_MS`;
- events that arrive while no hook of their kind is enabled: `ingest()` queues an event for
  the hooks enabled then, and a hook enabled later is sent nothing older;
- events of a kind, or with a label, that this Worker's build does not know (see
  [Deploy orders](#deploy-orders));
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
| A write an agent made (`writeWorkspace()`) | Its write record, with the same `via` and `agent` | | An action, with its card |
| A content request an agent filed (`requestContentAccess()`) | Its `requestContentAccess` grant record, with the same `via` and `agent`. A denial, an approval and the grant's end carry the `via` of the admin who made them. | | An action, with its card |
| `addIssueReportEntry()`, `setIssueReportStatus()` | None | The entry or status line, with `via: "gatekeeper"` and, for admins, the origin | An action, with its card |
| `claimIssueReport()`, `releaseIssueReport()` | None | A line only admins read, with no text: who claimed or released the report, with `via: "gatekeeper"` and the origin. The report's assignee carries the same `via` and origin while the claim holds. | An action, with its card |
| `listUsers()`, `listWorkspaces()`, `getSettings()`, `listAdminAudit()`, `getAdminAuditStats()`, `whoami()`, `listIssueReports()`, `getIssueReport()`, `readIssueReportImage()`, `listContentAccessRequests()`, `getContentAccessRequest()`, and a report session's `get()` and `readImage()` | None | | An observation |
| A hook's delivery, of any of the three | None | | An observation, with the binding's subresource and the restricted-data flag (see [Hooks](#hooks)) |

- **In the audit log**: the calls the Admin API records for any admin. A report session's view
  adds the one `describe` it makes when it opens.
- **In no audit record**, for an agent as for any admin: the listings and getters of the seventh
  row, and the four report writes. For the writes the trace is the thread entry or line. For
  the reads, the only trace is the observation in the activity of the workspace that made the call
  (`Admin API: <method>`, with who prompted the turn), which lives and is deleted with that
  workspace. A deployment that needs a durable record of an agent's listings does not get one
  from this version.
- **In the workspace's activity**: every read as an observation, and every "act" call as an
  action with its card, who decided it (`resolvedBy`) and whether a rule applied it.

**Where the person is found.** Every record names the owner, so the person behind a call is
found elsewhere:

- for an agent's turn, in the chat the record names: who prompted it. The chat is the one the
  lend was made for, which the Worker is trusted to have served (see
  [What a Worker that keeps everything could do](#what-a-worker-that-keeps-everything-could-do));
- for a decision, in the action's record (`resolvedBy`);
- for a call with no chat, in the gadget's merged code;
- for a session opened directly from the connection, the owner: nobody else is lent one, and
  nobody else's queues an action;
- for an entry, a status line or a change of assignee, in the report's thread, which marks an
  agent's;
- in this Worker's logs, event names only: no argument, result or report id is logged.

## Limits

- **Nothing is simulated.** A queued entry, status, assignment or request is in no read until it is
  applied, and an agent's turn waits for a manual decision.
- **An "act" call resolves to nothing**, `requestContentAccess()` included, so an agent is not
  handed the id of the request it filed. The declarations (`src/types.d.ts`) tell it how to
  follow a write or a request:

  > A write or a content request is not returned to you: writeWorkspace() and
  > requestContentAccess() resolve to undefined, and the write runs, or the request exists, only
  > once its action has been approved. To follow a write, read
  > listAdminAudit({ kind: "write", workspace: <the workspace you named> }): its record's
  > `agent.workspaceId` is this workspace. To follow a request, listContentAccessRequests() lists
  > it, with the same `agent.workspaceId`; another human admin approves it there, and nobody in
  > this workspace can.

  The match is on the workspace alone, never on a chat: a gadget's call has none, and an agent
  is not told its chat's id.
- **The reply split and the restricted-data mark are the Worker's own declarations** (see
  [What a Worker that keeps everything could do](#what-a-worker-that-keeps-everything-could-do)).
- **The latch does not hold back reads through other connections** (see
  [What the latch does not hold back](#what-the-latch-does-not-hold-back)).
- **Reading a report, or receiving a hook's event, closes the workspace as a read of the whole
  deployment does**: nothing in it is applied by a rule from then on, a report session's reply
  included, and it stays admins-only after the connection is removed (see
  [Restricted data](#restricted-data)).
- **A connection's actions are auto-approved in order.** A public reply, a write or a request
  that waits for a person holds back the auto-approval of that connection's later notes, status
  changes, assignments and requests, and a triager's scoped replies too. Give triage a workspace
  of its own. A person approving a card applies that card, whatever is queued before it.
- **An action refused where it lands holds them back too, until a person rejects it**
  (`assigned`, `threadFull`, `notFound`). It is never applied, by a rule or by a
  person, yet the Workshop keeps it pending, looking like any action that waits for a
  decision: approving it only repeats the refusal. A claim that loses to another admin's is
  the ordinary case. With a rule for assignments on, the workspace whose claim lost applies no
  later note, status or claim of this connection until someone rejects the lost claim, and
  nothing pauses its agent or tells its gadget. The preamble tells agents so, and to read a
  report's assignee before claiming it.
- **A status is set over whatever the report has by then.** The action is lent no read, so its
  card names no earlier status.
- **A status the reporter reads is public.** An approved change of status tells the reporter
  something, through the choice and the order of the statuses a reporter can tell apart. An
  agent's changes are bounded per report, and two of the statuses read the same to the
  reporter. It can be any status, `closed` included, which ends the reporter's replies until an
  admin sets another.
- **An admins-only note is read by every admin, now and later**, and by any agent that holds
  the whole binding. It can outlive the content grant its text was read under.
- **The Workshop holds an approved action to its kind's method and visibility** (an
  assignment's two methods), **not to a report.** That the call names the report its card
  named is this Worker's to keep (see
  [What a Worker that keeps everything could do](#what-a-worker-that-keeps-everything-could-do)).
- **"Report changed" tells every subscribed admin gadget that a report was written to and which
  kind of write it was, never its text or who made it.** A subscriber that writes on every
  event loops until the per-report bounds on what is written through the gatekeeper
  (`MAX_ISSUE_REPORT_THREAD_ENTRIES` for each kind) refuse it `threadFull`.
- **Those bounds are per report and per kind, not per admin or per workspace.** The store
  counts what was written through the gatekeeper with no author in the count, so every
  admin's agents and gadgets share them. One subscriber's loop spends a kind's bound on a
  report for all of them, after which only a person can write that kind on that report (a
  note, a public reply, a status or an assignment), through the Workshop or the CLI.
- **A claim through a gadget assigns the workspace's owner**, whoever in that workspace pressed
  its "Assign to me" button.
- **One queue delivers every hook of the deployment**, 20 deliveries a run, each run as long
  as its slowest callback (up to 30 seconds). One slow or failing subscriber of "Report
  changed" can delay other workspaces' "Issue reported" deliveries by minutes, and by up to
  an hour at the bounds (see [Hooks](#hooks)). A delivery is delayed, never lost.
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

- a non-admin can hold no account of this vendor, so they can't fill the binding. The Workshop's
  installer says the gatekeeper isn't available, as it does for any gatekeeper they can't use,
  and creates nothing. Through the API (`newWorkspaceFromBlueprint()` with no assignment for the
  binding), their instance gets no connection and the binding stays unfilled;
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
  `ADMIN_BINDING_SUBRESOURCE`, the whole binding's, a report session's and a hook's delivery's
  alike; `getHistoricalSubresources()` returns `[]`, and
  `addObserver()` and `removeObserver()` do nothing.

## Tests

`pnpm --filter @gadgets/gatekeeper-admin test:run` runs both projects, after writing
the schema when it is stale and building the configurator frame.

- `__tests__/surface.test.ts` (Node): the generated surface. The session's methods are exactly
  those the kind table does not omit; the declarations, with each "act" method resolving to
  nothing and no omitted method, `whoami()` as a read, and a claim and a release as queued;
  what the preamble says of whom the binding acts as, of the changed hook firing for a
  workspace's own writes, of what sends no event and of which events mark the workspace; and
  every load-time check refusing the schema it is for.
- `__tests__/workerd/session.test.ts`: the facet, the account and the vendor; a session's
  reads, lent, then observed, then forwarded, each marking under the binding's id, `whoami()`
  among them; a view a session opened; what a session refuses, a claim that asks to take a
  report over included, with nothing queued; disposal.
- `__tests__/workerd/actions.test.ts`: each of the seven kinds queued with its card and applied
  as exactly the stored call, once; a status's card for every status, with what its reporter
  reads where that differs; an assignment's card, one kind for a claim and a release; the
  verdicts, and what splits the two replies and the two requests; what is refused before
  anything is queued; an action that fails to apply, is lent nothing or is under way.
- `__tests__/workerd/report-session.test.ts`: the allowlist; a session that can name no other
  report; its reply's card; its view, opened for the level in force and refused by the
  workspace's own answer; what its reads record, each with the mark and the binding's
  subresource whatever the reporter's workspace holds; and the statuses as the reporter reads
  them, with no admins-only status line, no assignee, no assignment line and no method that
  assigns.
- `__tests__/workerd/hooks.test.ts`: subscribing; an event firing each hook of its kind once,
  each kind of write to a report among them, and a report that leaves `investigating` firing
  two hooks with an event id each; a delivery that fails; many changed events holding an
  "Issue reported" delivery back by whole runs without losing it; the restricted-data flag on
  every delivery, for each kind of write and each status an investigation ends with; the
  delivery stub; the
  vendor's `issueReportEvents()`, through its argument validation: a batch that mixes kinds it
  knows with one it does not delivers the known ones, a known kind with an unknown label is
  dropped alone, and an event that is not ids and labels is still refused; the driver's
  storage, which holds ids and labels only; and the declarations of the three hooks.

The kernel's side is in `packages/workshop-backend/__tests__/`: `admin-agent-kinds.test.ts` (the
two tables), `admin-agent.test.ts` (`restrictAdminApi()`, an assignment's one call of its two
methods, and a view behind it), `admin-agent-lend.test.ts` (the lend, what it records,
`whoami()` naming the owner, a claim applied as the owner and a take-over refused, restricted
data, who is lent, the insiders of a content request, a spawned chat),
`admin-workspace-admission.test.ts` (the admission rule, with and after the connection),
`issue-report-events.test.ts` (the store's events), `issue-reports.test.ts` (the statuses each
reader gets, and the assignee), `provisioning-policy.test.ts` and
`user-ambient-accounts.test.ts` (the mode and who holds the account).

End to end, with a scripted model, in `packages/integration-tests/__tests__/`:
`admin-gatekeeper.test.ts` (who is offered it, the records, admission, the two-person rule,
removal, a blueprint, a demoted owner), `admin-gatekeeper-actions.test.ts` (the verdicts under
rules, the restricted-data order, the report session and what it reads of a fix, two admins'
workspaces claiming one report, a take-over an agent never makes) and
`admin-gatekeeper-hooks.test.ts` (the three hooks into a gadget's stored callback, once for each
kind of change to a report, the workspace marked by every event, a spawned chat with and
without the binding, the hand-off and a forged stub).

## Reviewing a change here

[REVIEW.md](../../REVIEW.md) holds the kernel's invariants. For this package, flag:

- an "act" method answered outside an approved action;
- an action kind added without a tag of its own;
- an action kind that calls `writeWorkspace()` or `requestContentAccess()` with `autoApprovable`
  true;
- a "read" method that returns a view with no entry of its own in `ADMIN_AGENT_VIEWS`;
- a read through the whole binding or a report session, or a hook's delivery, observed without
  `containsRestrictedData`, without `ADMIN_BINDING_SUBRESOURCE`, or (for a read) before its
  lend resolved;
- a comparison of a reporter's id with an owner's outside the report store;
- a lend or a hook firing that does not ask the owner's account
  (`UserDurableObject.holdsGatekeeperAccount()`);
- anything that gives this Worker a binding or a stored capability that reaches the Admin API
  or the report store.
