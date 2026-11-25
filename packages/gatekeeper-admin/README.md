# Admin gatekeeper

Gives the agents of a workspace this deployment's [Admin API](../../docs/admin-access.md), as the
deployment admin who connected it: they read what admins read, and what they would write to a
workspace or ask of the admins waits as an action for a person to approve. The connection is
called "Deployment admin", its binding is `ADMIN`, and its vendor id is `admin` (the Worker bound
as `GATEKEEPER_ADMIN`).

It is an ordinary gatekeeper, built from the
[`write-gatekeeper`](../../.agents/skills/write-gatekeeper/SKILL.md) skeleton, with one
difference: an account's credential is no provider token but a capability the Workshop hands it.

## Setup

None. The gatekeeper takes no inputs and is installed with every deployment. Deployment admins
(the backend's `ADMINS`) see it under Connectors; nobody else is offered it. An admin turns it off
for the whole deployment from the admin panel's Gatekeepers tab, as any connector, and with the
same effect: no new account and no new connection. A connection already made keeps answering
while its user is a deployment admin, until its account is removed.

## How it works

**Connecting.** When a deployment admin connects the gatekeeper, the Workshop passes
`GatekeeperConnectOptions.adminApi`: an `AdminApiGrant`, a persistent stub bound to that user.
`connectAccount()` refuses a flow that carries none, so only an admin can connect. The grant is
stored in the account's `UserAccount` Durable Object beside the connect callback. There is no
provider to send the user to, so the connect link completes the connection when the popup opens
it, and its page hands the popup back to the Workshop
([connect handoff](../../docs/connect-handoff.md)).

**Reading.** The account has one resource, `admin://deployment`. Each session of a connection asks
the account for its grant and opens the Admin API from it on first use, then forwards each call
(`src/forward.ts`). The Workshop checks and records every call where it lands:

- every forwarded call, a view's included, asks the account before it is made, and again before
  it answers, whether the account still holds its grant and its user is still a deployment
  admin, so demoting the admin or removing the account stops the sessions that are already open,
  not only the next ones;
- a demoted admin's account stays listed, and offers and binds nothing until they are an admin
  again;
- the calls are made as the admin who connected the account, whoever's agent makes them, and a
  view's records in the audit log say `via: "gatekeeper"`;
- removing the account deletes the grant, which ends every connection made with it.

**What an agent may call.** `ADMIN_AGENT_KINDS` (`src/kinds.ts`) gives every `AdminApi` method a
kind, and the package does not compile while the two differ:

| Kind | Methods | Through the binding |
| --- | --- | --- |
| `read` | `getSettings`, `listUsers`, `listWorkspaces`, `inspectWorkspace`, `inspectUser`, `listAdminAudit`, `getAdminAuditStats`, `listContentAccessRequests`, `getContentAccessRequest` | Runs at once. A view answers each of its methods, under the checks the view makes itself. |
| `act` | `writeWorkspace`, `requestContentAccess` | Never runs when called: it is queued as an [action](#actions) and resolves to `undefined`. |
| `omitted` | Every setter, the gateway tests, `checkForUpdates`, `getUpdateStatus`, `isBlueprintFeatured`, `approveContentAccess`, `denyContentAccess`, `endWorkspaceGrant` | Absent from the agent's declarations and from the session, so it cannot be called. |

`scripts/generate-schema.ts` cuts the schema the Worker bundles from the Workshop API's generated
schema (`packages/api-schema`), leaving the omitted methods out. The sessions' methods, the
declarations the agent reads and the check of each call's arguments all come from that schema
(`src/surface.ts`), so a method added to `AdminApi` is served once it has a kind and the Worker is
rebuilt. `surface.ts` refuses, at load, a schema it cannot forward faithfully: a parameter that
takes a capability or a stream, a result the schema does not describe, anything tagged `secret`.

## Actions

An `act` call is queued as one of two action kinds, defined with the kit's `defineActions`
(`src/actions.ts`). Neither may be auto-approved, so each waits as a card in the workspace until
a person who may approve its actions decides:

| Kind (tag) | Queued by | Once approved |
| --- | --- | --- |
| `workspace-write-request` | `writeWorkspace(workspaceId, action, args, reason)` | Makes the write, as the admin who connected the account. The card is the only check between the agent and that workspace. |
| `content-access-request` | `requestContentAccess(workspaceId, reason)` | Files the request, as the admin who connected the account. Another deployment admin must then approve it from the admin panel: the admin it is filed as cannot. |

- **Queuing reads nothing.** The card is built from the call's arguments alone, which are checked
  first (a reason, and the arguments the write's action takes), so a queued action is no
  observation and does not mark the workspace.
- **Applying is one call.** `applyAction()` opens the Admin API from the account's grant, as a
  session does, and makes the action's one call. The action is claimed first, so it never runs
  twice.
- **Failures.** A demoted admin's action, and one whose account was removed, makes no call and
  stays pending. A refusal the Admin API makes before it writes anything (writes or content access
  turned off, an unknown workspace, a request already pending) is final. After any other failure
  nobody knows whether the call was carried out, so the action is never run again: a person
  checks the audit log and rejects it.
- **Following one.** A write's record in the audit log, and a filed request, say
  `via: "gatekeeper"` and name the connecting admin.

## Who sees what it read

Every read the Admin API answered is an observation (a call it refused read nothing, and
observes nothing) that sets `containsRestrictedData` and reports one subresource,
`global` ([connection-only access](../gatekeeper-kit/USAGE.md#connection-only-access-global)): the
deployment is the one instance every account connects to, and what a read discloses is what any
deployment admin may read.

- The first read marks the workspace as holding restricted data. From then on nothing in it is
  applied without a person, and web fetches reach only the hosts the deployment trusts.
- A collaborator opens the workspace only with an account of this gatekeeper of their own, which
  only a deployment admin can connect. `verifyObserverAccess()` asks each observer's account
  whether its user is a deployment admin now. Nothing is cached, so a demotion is seen at the next
  check.
- The requirement lasts as long as the connection: once the connection is removed, the workspace
  is shared as any other, as for every gatekeeper ([observers](../../docs/observers.md)).

## What the account holds

A standing capability. The grant names its user and carries no authority of its own: it reads
`ADMINS` each time it is used. But until the account is removed, this Worker can open the Admin
API as that admin at any time, not only while a session runs, and it receives the whole API: what
an agent cannot call, and what waits for a person, is this package's decision (the tables above),
not the Workshop's. The
Worker is trusted as the backend's own configuration is, which is why the release build reserves
the `admin` install slug for this package.

## Tests

- `__tests__/surface.test.ts` (Node): the schema, its generation and the load-time checks.
- `__tests__/workerd/` (workerd): the connect flow and the account, observer verification, the
  sessions and the actions, over a faked grant.
- `packages/integration-tests/__tests__/admin-gatekeeper.test.ts` and
  `admin-gatekeeper-actions.test.ts`: the real Worker beside the Workshop, end to end.
