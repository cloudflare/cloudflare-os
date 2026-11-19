# The admin gatekeeper

A deployment admin's agent uses the deployment's Admin API as that admin, through this gatekeeper.
Its sessions are built from the API's generated schema: one method for each Admin API method an
agent may call, with the declarations the agent reads and the check each call's arguments pass.
Reads run at once; a write to a workspace and a request for access to its content are queued as
actions, which run once a person approves them. What an admin sees and does through it is in
[docs/admin-access.md](../../docs/admin-access.md#through-an-agent). This file is the design record.

| Concern | Location |
| --- | --- |
| The kind of every Admin API method, the action kinds, the lend's length, the binding's subresource id | `packages/workshop-shared/src/admin-agent.ts` |
| The gatekeeper's contract with the Workshop (`AdminAgentApi`, `AdminAgentQueue`, `AdminGatekeeper`) | `packages/workshop-shared/src/admin-gatekeeper.ts` |
| What a lent call may do (`restrictAdminApi()`, `ADMIN_AGENT_VIEWS`) | `packages/workshop-backend/src/admin-agent.ts` |
| The lend, the admission rule, the mark of a read (`lendAdminApi()`, `admitsNonOwner()`, `adminReads`) | `packages/workshop-backend/src/overseer.ts` |
| The schema, its load-time checks, the declarations | `src/surface.ts` |
| The sessions | `src/forward.ts` |
| The two actions | `src/actions.ts` |
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
say who called.

### After the connection is removed

Which workspaces stay closed is decided by one fact, the mark a read makes:

- **A workspace that never read through the binding is ordinary again at once.** The people kept
  in its sharing list are admitted at their next open, with nobody inviting them.
- **A workspace that has read through the binding stays admins-only for good.** Its chats hold
  what was read, and nothing lifts the rule.

Each rule reads its own fact:

- Nothing applied by a rule, and web fetches held: the restricted-data latch, which any
  observation that carries `containsRestrictedData` sets, of any connection.
- Admins-only for good: `storage.adminReads`, which the Workshop sets in the transaction that
  sets the latch, for an observation of this gatekeeper that carries the flag and names
  `ADMIN_BINDING_SUBRESOURCE`. It is never set without the latch.

While the workspace has the connection it is admins-only whatever it read
(`hasAdminConnection()`).

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
every workspace they own, at the next session or action. Adding the account again restores them.
[Removing the account, and blueprints](#removing-the-account-and-blueprints) has the reason.

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

The Worker has no binding, no credential and no stored capability that reaches the Admin API
(`cloudflare.config.ts` declares none). `createAccount()` takes no identity and every account is
alike. What it can do, the Workshop lends it:

- **For a session**: the owner's Admin API, through the session's queue
  (`AdminAgentQueue.getAdminApi()`). It answers the "read" methods only.
- **For an approved action**: an Admin API that answers one call, of the method the action's kind
  names, handed over as an argument (`AdminGatekeeper.applyAdminAction()`).

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
- leave the restricted-data flag off a read, which is its own to declare.

The restricted-data mark holds against agents and gadgets, which do not choose it. It is the
Worker's word, as an observation's flag is for every gatekeeper: the Worker is deployed with the
Workshop and trusted for its own declarations. Its actions gain nothing from a wrong word: both
kinds wait for a person, and the Workshop holds an approved action to its kind's one method.

It can never:

- act with nothing lent: no session open and no approved action being applied;
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
  queued (`queued()`). The hand-written `src/types.d.ts` follows them: `AdminBinding`.
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
request that does not exist yet.

## What each kind does

| Kind | Methods | What a call does |
| --- | --- | --- |
| `"read"` | `getSettings()`, `listUsers()`, `listWorkspaces()`, `inspectWorkspace()` and `inspectUser()` and every method of the view each returns, `listAdminAudit()`, `getAdminAuditStats()`, `listContentAccessRequests()`, `getContentAccessRequest()` | Runs at once, on the owner's Admin API, and returns its result. Metadata, and a workspace's content under a live grant, exactly as its view's own per-call check decides. A view of a user's account returns metadata alone. |
| `"act"` | `writeWorkspace()`, `requestContentAccess()` | Never runs when called. It is queued as one of the two actions below, and runs once that action is approved, as exactly the queued call. |
| `"omitted"` | Every setter and every other method that changes a setting, the gateway tests, `checkForUpdates()`, `getUpdateStatus()` and `isBlueprintFeatured()`, which repairs the featured catalog's mirror as it reads, approving or denying a content access request, `endWorkspaceGrant()` | Absent from the declarations and refused, by the session and by the Workshop. |

The two action kinds (`ADMIN_AGENT_ACTIONS`). Each card is built from the call's own arguments,
never from a read, so queuing an action marks nothing:

| Kind | Tag | `autoApprovable` | The card says |
| --- | --- | --- | --- |
| `workspaceWriteRequest`: a write to a workspace (`writeWorkspace()`) | `workspace-write-request` | `false` | The workspace, the action, its arguments and the reason, and that the write runs as the owner once approved. |
| `contentAccessRequest`: a request for a workspace's content (`requestContentAccess()`) | `content-access-request` | `false` | The workspace and the reason, and that nobody in this workspace can approve the request. |

**Both verdicts are `false`**:

- `workspaceWriteRequest`: once approved, the write runs at once in another workspace, as a
  deployment admin, with no second admin deciding. The person who approves the card is the one
  check between the agent and that workspace, so no rule may stand in for them.
- `contentAccessRequest` (rule 7 of the write-gatekeeper skill): it asks for access to a
  workspace's content, and whoever approves the filing is one of those who may not approve the
  request, which only a person present can be.

The Workshop refuses to lend to an auto-approval of an action whose tag is that of a kind whose
verdict is `false`, whatever the action's own description claims, and checks the one call an
approved action makes against its kind.

**Why filing a content request is an action**, though what it files still needs a second
admin: it stores a request every admin sees, takes one of the deployment's pending slots, and
puts text an agent wrote in the admin panel's pending approvals. Content requests filed through
the gatekeeper hold at most `MAX_PENDING_AGENT_CONTENT_REQUESTS` (10) of the deployment's
`MAX_PENDING_CONTENT_REQUESTS` (50) pending slots, across every workspace; the next is refused
`tooManyRequests`, and the requests people make keep the rest.

**What is refused before a card is made.** A reason the Admin API would refuse, and a write's
arguments that do not fit its action (`ADMIN_WRITE_ARGS`, the Workshop's own table): a required
one missing, one the action does not take, or an id that is not a non-negative whole number.
The Admin API refuses these with no code, which an approved action could only report as an
outcome nobody knows.

**No action runs twice.** Both kinds claim their action before they call. A coded refusal the
Admin API makes before it writes anything (writes off, a workspace that is gone or unlisted, a
request already pending or too many) fails the action for good; any other failure (a broken
call, an error with no code) leaves an outcome nobody knows, which is never run again: a person
looks at the audit log, and rejects the action. Either way the Workshop keeps the action pending
until a person rejects it, with nothing on its card that says it failed: approving it again
answers with the same failure and calls nothing.

## Restricted data

**Every read through the binding marks the workspace as holding restricted data**, through the
platform's own latch: each of its observations carries `containsRestrictedData`. Listings,
settings, the audit log and every view method all mark. From the first read on, the Workshop
enforces what it enforces for restricted data everywhere:

- nothing of any connection is applied by a rule;
- web fetches reach only the hosts the deployment trusts with such data;
- a push is refused.

**The order.** The latch is set before a read is forwarded and read again before each apply,
and the lend itself refuses an auto-approved action in a marked workspace, so whatever is queued
after the first read waits for a person. This gatekeeper's own two kinds wait for one anyway.

**What marks, and what does not.** A session awaits its lend before its first observation, so a
call refused before anything was lent (the vendor is off, the owner is not an admin, a member's
direct session) marks nothing. A read that was lent and that the Admin API itself then refuses
still marks: the mark is made before the answer is known.

### What the latch does not hold back

Reads through the workspace's other connections. The latch holds web fetches and actions; an
observation of another gatekeeper still runs, and its arguments (a search query, a file path, a
message id) can carry what was read to that vendor. A workspace that reads through the admin
binding should hold no connection its owner would not send that data to.

## Spawned chats

A spawned chat's bindings are its spawner's `env` and nothing else. It has the admin binding
only when its spawner's `env` names the connection, and naming it hands the spawned chat the
whole binding.

## What is recorded where

The admin audit log does not hold everything an agent does. It holds what the Admin API records
for any admin, and no more:

| Call | The admin audit log | The workspace's own activity |
| --- | --- | --- |
| Opening a view: `inspectWorkspace()`, `inspectUser()`, and a refused open | An access record, with `via: "gatekeeper"` and `agent: { workspaceId, chatId? }` | An observation |
| Each call of a view, metadata and content | An access record, with the same `via` and `agent`, and the grant it ran under | An observation |
| A write an agent made (`writeWorkspace()`) | Its write record, with the same `via` and `agent` | An action, with its card |
| A content request an agent filed (`requestContentAccess()`) | Its `requestContentAccess` grant record, with the same `via` and `agent`. A denial, an approval and the grant's end carry the `via` of the admin who made them. | An action, with its card |
| `listUsers()`, `listWorkspaces()`, `getSettings()`, `listAdminAudit()`, `getAdminAuditStats()`, `listContentAccessRequests()`, `getContentAccessRequest()` | None | An observation |

- **In the audit log**: the calls the Admin API records for any admin.
- **In no audit record**, for an agent as for any admin: the listings and getters of the fifth
  row. The only trace is the observation in the activity of the workspace that made the call
  (`Admin API: <method>`, with who prompted the turn), which lives and is deleted with that
  workspace. A deployment that needs a durable record of an agent's listings does not get one
  from this version.
- **In the workspace's activity**: every read as an observation, and every "act" call as an
  action with its card and who decided it (`resolvedBy`).

**Where the person is found.** Every record names the owner, so the person behind a call is
found elsewhere:

- for an agent's turn, in the chat the record names: who prompted it. The chat is the one the
  lend was made for, which the Worker is trusted to have served (see
  [What a Worker that keeps everything could do](#what-a-worker-that-keeps-everything-could-do));
- for a call with no chat, in the gadget's merged code;
- for a decision, in the action's record (`resolvedBy`);
- for a session opened directly from the connection, the owner: nobody else is lent one, and
  nobody else's queues an action;
- in this Worker's logs, event names only: no argument or result is logged.

## Limits

- **Nothing is simulated.** A queued write or request is in no read until it is applied, and an
  agent's turn waits for a manual decision.
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
- **A connection's actions are auto-approved in order.** A write or a request that waits for a
  person holds back the auto-approval of that connection's later actions. A person approving a
  card applies that card, whatever is queued before it.
- **The restricted-data mark is the Worker's own declaration** (see
  [What a Worker that keeps everything could do](#what-a-worker-that-keeps-everything-could-do)).
- **The latch does not hold back reads through other connections** (see
  [What the latch does not hold back](#what-the-latch-does-not-hold-back)).
- **What the agent reads goes into the chat and to its model provider.**
- **A view's own limits** are those of
  [docs/admin-access.md](../../docs/admin-access.md#inspection).

## Removing the account, and blueprints

**Removing the account ends every connection made with it.** Everywhere else, removing an
account ends what its connections can do because the account's `revoke()` ends the vendor's
token. This account has no token: the Worker holds nothing, so its `revoke()` can end nothing.
The power is the Workshop's, so the Workshop asks the owner's account
(`UserDurableObject.holdsGatekeeperAccount()`) at each lend. The connections and their pending
actions stay, refused, until the account is added again or they are removed. A session that is
open keeps its lend until it ends. In mode "enabled" the account cannot be removed.

**Blueprints carry nothing.** A blueprint of a gadget that uses the binding keeps the vendor and
the resource's URL pattern, and nothing else. Whoever instantiates it adds the connection from
an account of their own:

- a non-admin can hold no account of this vendor, so they can't fill the binding. The Workshop's
  installer says the gatekeeper isn't available, as it does for any gatekeeper they can't use,
  and creates nothing. Through the API (`newWorkspaceFromBlueprint()` with no assignment for the
  binding), their instance gets no connection and the binding stays unfilled;
- an admin's instance has an ordinary connection, which the owner check of `newGatekeeper()`
  and the admission rule apply to from that moment.

## Departures from the usual gatekeeper

- **Sessions without `@validateRpc()`.** A session class's methods come from the schema at
  load, so its TypeScript type declares none of them and a validator built from it would refuse
  them all. Each call's arguments are checked against the schema instead
  (`checkArguments()`), and the Workshop validates them again where the call lands. For the same
  reason `startSession()` skips validation of its result (`@skipRpcValidation()`): a validated
  return would wrap the session in a proxy that refuses every method.
- **Actions are applied through `applyAdminAction()`**, which hands over the Admin API lent for
  that one action. `applyAction()` refuses, and no action can be reverted.
- **`verifyObserverAccess()` allows every observer it is asked about** for its one subresource
  id, `ADMIN_BINDING_SUBRESOURCE`, and none for any other. Who may see what the binding read is
  a question of who is a deployment admin, which this Worker cannot tell: admission is the
  Workshop's. `getHistoricalSubresources()` returns `[]`, and `addObserver()` and
  `removeObserver()` do nothing.

## Tests

`pnpm --filter @gadgets/gatekeeper-admin test:run` runs both projects, after writing
the schema when it is stale and building the configurator frame.

- `__tests__/surface.test.ts` (Node): the generated surface. The session's methods are exactly
  those the kind table does not omit; the declarations, with each "act" method resolving to
  nothing and no omitted method; and every load-time check refusing the schema it is for, an
  "act" method with no route included.
- `__tests__/workerd/session.test.ts`: the facet, the account and the vendor; a session's
  reads, lent, then observed, then forwarded, each marking under the binding's id; a view a
  session opened; what a session refuses, an "act" method queued and never forwarded; disposal.
- `__tests__/workerd/actions.test.ts`: each of the two kinds queued with its card and applied as
  exactly the stored call, once; the verdicts; what is refused before anything is queued; an
  action that fails to apply, is lent nothing or is under way.

The kernel's side is in `packages/workshop-backend/__tests__/`: `admin-agent-kinds.test.ts`
(the two tables), `admin-agent.test.ts` (`restrictAdminApi()`, an action's one call, and a view
behind it), `admin-agent-lend.test.ts` (the lend, what it records, an approved action, who is
lent and who queues, the insiders of a content request, a spawned chat),
`admin-workspace-admission.test.ts` (the admission rule, with and after the connection),
`provisioning-policy.test.ts` and `user-ambient-accounts.test.ts` (the mode and who holds the
account).

End to end, with a scripted model, in `packages/integration-tests/__tests__/`:
`admin-gatekeeper.test.ts` (who is offered it, the records, content under a grant, admission,
the two-person rule, removal, a blueprint, a demoted owner) and `admin-gatekeeper-actions.test.ts`
(a write and a content request, each waiting for a person).

## Reviewing a change here

[REVIEW.md](../../REVIEW.md) holds the kernel's invariants. For this package, flag:

- a "read" method that returns a view with no entry of its own in `ADMIN_AGENT_VIEWS`;
- a read through the binding observed without `containsRestrictedData`, without
  `ADMIN_BINDING_SUBRESOURCE`, or before its lend resolved;
- an "act" method answered outside an approved action;
- an action kind added without a tag of its own;
- an action kind that calls `writeWorkspace()` or `requestContentAccess()` with `autoApprovable`
  true;
- a lend that does not ask the owner's account (`UserDurableObject.holdsGatekeeperAccount()`);
- anything that gives this Worker a binding or a stored capability that reaches the Admin API.
