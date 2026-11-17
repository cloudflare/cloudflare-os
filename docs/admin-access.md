# Admin access: operating and investigating a deployment

A deployment's admins (the canonical user ids its backend Worker's `ADMINS` variable lists) need to
operate, debug and investigate the instance: find a user or a workspace, look inside a workspace
that misbehaves or at what a user's account holds, and know afterwards who looked at what and who
changed which setting. What they see of a workspace or of an account is its metadata. A
workspace's content (chats, files, attachments) is read only where the deployment's environment
allows it and only under a grant: a record, lasting 72 hours, given by the workspace's owner or by
a second admin's approval (see [Grants](#grants)). Where the environment allows it, they can also
change a workspace, through a request that an admin approves with a passkey (see
[Writes](#writes)). Users reach the admins through issue reports, which have a document of their
own ([issue-reports.md](issue-reports.md)). This document is the design record for that surface.
The API itself is documented on `AdminApi`, `AdminWorkspaceView` and `AdminUserView` in
`packages/workshop-shared/src/api.ts`; the pieces are:

| Concern | Location |
| --- | --- |
| Admin status | `packages/workshop-backend/src/auth/config.ts` |
| The environment's bounds, validation, the audit's text bounds | `packages/workshop-backend/src/admin-access.ts` |
| The `AdminApi` capability (`AdminApiImpl`) and the settings audit (`AdminSettings`) | `packages/workshop-backend/src/admin-settings.ts` |
| Diffing a settings change (`diffAdminConfig`) | `packages/workshop-backend/src/admin-config.ts` |
| The deployment-wide audit log (`AdminAuditDurableObject`) | `packages/workshop-backend/src/admin-audit.ts` |
| The user and workspace directory (`UserDirectoryDurableObject`) | `packages/workshop-backend/src/user-directory.ts` |
| What both views share: the call discipline (`adminViewCall`), the audit append included | `packages/workshop-backend/src/admin-view.ts` |
| Workspace inspection (`openForAdmin`, `AdminWorkspaceViewImpl`) and the workspace's directory feed | `packages/workshop-backend/src/overseer.ts` |
| User inspection: the account's `openForAdmin` | `packages/workshop-backend/src/user.ts` |
| User inspection: `openAdminUserView` and the view it mints (`AdminUserViewImpl`) | `packages/workshop-backend/src/admin-user-view.ts` |
| Reads that never pull (`readLocalCommitTree`, `readLocalFileAtCommitIfExists`, `localPathEntryAtCommit`, `changedLocalFilePathsBetween`, `readCommitLog` with `stopAtMissing`) | `packages/workshop-backend/src/git-cache.ts` |
| The admin panel's Audit tab | `packages/workshop-frontend/src/features/admin-audit/` |
| The writes switch (`adminWorkspaceWritesEnabled`) and the passkeys' origin and relying party (`adminPasskeyRelyingParty`) | `packages/workshop-backend/src/admin-access.ts` |
| Verifying a passkey's registration and its assertions (`verifyPasskeyRegistration`, `verifyPasskeyAssertion`) | `packages/workshop-backend/src/webauthn.ts` |
| What a write request is computed from alone: its arguments, the digest an approval signs, a challenge, its title in the action log (`adminWriteArgs`, `adminWriteDigest`, `newPasskeyChallenge`, `adminWriteTitle`) | `packages/workshop-backend/src/admin-writes.ts` |
| Passkeys, write requests and their approval (`AdminSettings`, `AdminApiImpl`) | `packages/workshop-backend/src/admin-settings.ts` |
| Running an approved write (`applyAdminWrite`, `runAdminWrite`) | `packages/workshop-backend/src/overseer.ts` |
| The page on which an admin approves a write | `packages/workshop-frontend/src/pages/admin-write-approval/` |
| The Access tab's passkeys card, the control that asks for content access, and the browser's side of a passkey ceremony | `packages/workshop-frontend/src/features/admin-writes/` |
| What a grant is computed from alone: whether it is live, whether it can be deleted, a fresh one (`isAdminGrantLive`, `isLiveAccountGrant`, `isAdminGrantPrunable`, `newAdminGrant`) | `packages/workshop-backend/src/admin-grants.ts` |
| What each view method's answer can hold (`ADMIN_METHOD_ANSWERS`), why a call may return no content (`adminContentRefusal`), a user as a grant names them (`namedUser`) | `packages/workshop-backend/src/admin-access.ts` |
| The owner's grant methods, the grant a content call runs under (`contentGrant`), ending an approval's grant (`endAdminGrant`) | `packages/workshop-backend/src/overseer.ts` |
| The account-wide grant | `packages/workshop-backend/src/user.ts` |
| Who counts as one admin where two are required (`sameDeploymentAdmin`) | `packages/workshop-backend/src/auth/config.ts` |
| An admin's page for one workspace: its live grants, ending one, asking for content access | `packages/workshop-frontend/src/pages/admin-workspace/` |
| What an agent may do with each `AdminApi` method (`ADMIN_AGENT_KINDS`, `ADMIN_AGENT_ACTIONS`) | `packages/workshop-shared/src/admin-agent.ts` |
| Lending a workspace owner's Admin API to the admin gatekeeper (`lendAdminApi`, `restrictAdminApi`) | `packages/workshop-backend/src/overseer.ts`, `packages/workshop-backend/src/admin-agent.ts` |
| The admin gatekeeper | `packages/gatekeeper-instanceadmin/` |

## Entry points

A client reaches everything through `AuthenticatedApi.getAdminApi()`, which returns null unless
the caller is an admin. The admin check runs once, when the capability is minted, for every
`AdminApi` method except inspection, which checks again, of a workspace (see
[Inspection](#inspection)) and of a user's account (see [User inspection](#user-inspection))
alike, and the write-request, passkey, grant and issue report methods, which check on every call
(see [Writes](#writes)).

- **Settings**: the setters (signups, user search, site name and logo, instructions,
  resource and gatekeeper availability, models, update checks, ...), plus
  `setAdminWorkspaceAccess()`, `setAdminAuditRetentionDays()` and
  `setIssueReportRetentionDays()`. Every one of these is audited.
- **The directory**: `listUsers()` and `listWorkspaces()`.
- **Inspection**: `inspectWorkspace(workspaceId, reason, { lifetimeSeconds, access })`, which
  returns an `AdminWorkspaceView` of the workspace's metadata, or, when `access` asks for
  `"content"`, a view that also reads its content while a grant is live.
- **User inspection**: `inspectUser(userId, reason, { lifetimeSeconds })`, which returns an
  `AdminUserView` of the metadata of the user's account, on the same terms: the same reason and
  lifetime, under the deployment's one level.
- **Grants**: `endWorkspaceGrant(workspaceId, grantId, reason)` ends a grant a second admin
  approved (see [Grants](#grants)). It answers whatever the level and while writes are off.
- **The audit log**: `listAdminAudit()` and `getAdminAuditStats()`.
- **Issue reports**: the listing, a report with its thread, an entry, the status, a claim and a
  release of a report (`claimIssueReport()`, `releaseIssueReport()`), the links and an image's
  bytes, with `whoami()`, which names the caller as a report names its assignee. None of these
  is audited: see [issue-reports.md](issue-reports.md).
- **Writes**, while the deployment's `ADMIN_WORKSPACE_WRITES` is `on`:
  `requestWorkspaceWrite(workspaceId, action, args, reason)`, `getWorkspaceWrite()` and
  `denyWorkspaceWrite()` for a request; `beginWorkspaceWriteApproval()` and
  `approveWorkspaceWrite()`, which approve one with a passkey and run it; and, for the passkeys
  themselves, `listAdminPasskeys()`, `beginAdminPasskeyEnrolment()`, `addAdminPasskey()`,
  `beginAdminPasskeyRemoval()` and `removeAdminPasskey()`. The listing and the two removal methods
  answer while writes are off too.

An admin reaches it three ways: from the Workshop's admin panel, from `cf-os api`, and through an
agent, in a workspace the admin owns and has added the admin gatekeeper's connection to (see
[Through an agent](#through-an-agent)). The third is not a session of `getAdminApi()`: the
workspace lends the gatekeeper its owner's Admin API, less the methods an agent is not given.

Each record's `via` (`AdminVia`) says which. For a session it comes from the User-Agent: `"cli"`
when the `/api` upgrade names `cf-os api` (`cf-os-api/<version>`), `"api"` for any other client,
the Workshop's admin panel included. A client can send any User-Agent, so it labels records and
grants nothing. `"gatekeeper"` is not a client's claim: only a workspace sets it, on the Admin API
it lends the admin gatekeeper (see [The audit](#the-audit)).
Each capability mints a random `sessionId`, so every record made through one `getAdminApi()` call,
settings and inspections alike, shares its `via` and `sessionId` and can be read as one session.

## The directory

### One directory, for search and for admins

`listUsers()` and `listWorkspaces()` read `UserDirectoryDurableObject`, the directory behind user
search (`AuthenticatedApi.searchUsers()`). The admin listings keep what search does not need in
tables of their own, `user_activity` and `workspaces`, beside search's `users` table, rather than in
a second store, because this directory is everything an admin directory needs: the deployment-wide
singleton (always `getByName("")`), fed by every user DO through a revision protocol that backfills
lazily, migrated, and bound in the unit test pool. A parallel store would duplicate the users
table, the sync protocol and the per-session writes.

User search keeps its own matching and its `userSearchEnabled` gate; the admin listings ignore that
setting. Directory listings are unrecorded reads, visible whatever the access level, workspace
titles included: they are what an admin uses to find a workspace before inspecting it.

### Feeds

Durable Objects cannot be enumerated, so the directory learns of accounts and workspaces from the
objects themselves:

- **The user DO** reports its profile, by revision, when a session starts (a session token
  is authenticated, or a Cloudflare Access sign-in), and when the user renames themselves. A session
  start also reports the session's time as `lastLogin`, at most once per
  `DIRECTORY_ACTIVITY_INTERVAL_MS` (an hour, the precision `lastLogin` promises), and every report
  carries the account's creation time once it is recorded. An account records it when it is
  created, so it is listed with it from its first session.
- **The Overseer** reports its workspace's title, owner and creation time:
  - on every `open()`, a no-op once the directory has acknowledged the title's revision;
  - when the title changes, whoever changes it (a rename, an agent-chosen title, initialisation
    from a blueprint or an external message): the `title` singleton is the one chokepoint, and its
    subscriber bumps the revision inside the write's transaction and defers the sync;
  - with `lastActive` when the workspace is active, at most hourly, alongside its
    last-active report to the owner's user DO.

  Syncs run one at a time, are best-effort, and never restart the workspace. A workspace
  initialised before it recorded its creation time reads it once from its owner's record of it
  (`GadgetRecord.created`) and stores it.
- **The revision is time-based.** `#initializeNewWorkspace()` sets it to at least the current time.
  An external message names its workspace by key, so a deleted workspace can be initialised again
  under the same id; its new life then outranks whatever its earlier one left in the directory.

### Deletion

`deleteSelf()` takes the workspace out of the directory (`removeFromDirectory()`) once
`beginDeletion()` has committed the deletion tombstone, which clears the owner and so stops any new
sync. `removeFromDirectory()` marks the instance removed (so no queued sync sends or acknowledges
anything), waits for the syncs in flight, and removes the entry. A failed removal is logged and
leaves the entry listed.

### What the lazy backfill misses

- An account is listed once it has started a session since the directory began recording
  accounts for user search, whatever `userSearchEnabled` says. Most accounts are therefore listed
  as soon as the admin listings ship, but without `lastLogin` until their next session. Only an account with no session since then waits for its next one, and is never listed
  if it never starts another.
- A workspace never opened again is never listed.
- An account created before the deployment recorded creation times is listed without `created`.
- A workspace's `lastActive` is absent until it is next active.
- A workspace whose removal from the directory failed stays listed until an admin inspects it:
  inspection finds it gone (`workspaceNotFound`) and removes the entry. There is no tombstone.

### Text bounds

Nothing upstream bounds a display name or a workspace title, so the directory keeps the first
`MAX_DIRECTORY_TEXT_LENGTH` (1000) characters of each, both where it stores them and where it reads
them (a row stored before it clamped may hold more). The clamp has no marker: the directory is a
finding aid, not a record, and clamps as `boundAgentCatalog()` clamps a catalog. Search text is built
from the clamped name or title and the first 1000 characters of each id.

Ids are identities and filter keys, so they are kept whole, and a username has no length limit
either. A page therefore stops at a million characters of text as well as at its `limit` (and is
never empty while rows remain), and cursors and owner filters take any length.

## Inspection

`AdminApi.inspectWorkspace()` validates the reason, the lifetime and what the view is asked for,
re-checks that the caller is an admin, reads the access policy from the authoritative
`AdminSettings` config (not the KV mirror: a mirror still saying `"metadata"` after an admin turned
access off, or `"content"` after an admin lowered the level, must not mint a view above the level
in force), and then calls `OverseerDurableObject.openForAdmin(adminId, reason, sessionId, terms)`.
The terms carry the caller's `via` and, for a call made through the admin gatekeeper, where it
came from (`agent`), what the view was opened for (`access`: `"metadata"`, or `"content"` when
the open asked for it, see [Opening for content](#opening-for-content)), the issue report it was
opened for when there is one (`forIssueReport`) and the view's expiry (`expiresAt`).

`AdminApiImpl` checks an open of either kind, `inspectWorkspace()` or `inspectUser()`, with
`#openTerms()`, in the order the API documents: the reason and the lifetime, that the caller is
still an admin, the method's own check of the id it was given, and only then the deployment's
level, against the committed config. While that level is `"off"`, each method records its own
refused open and refuses, and so does `inspectWorkspace()` for an open that asks for content
while the level is below `"content"` (see
[Which refusals are recorded](#which-refusals-are-recorded)).

Neither a workspace nor an account checks the terms it is opened with, so `AdminApiImpl` does
before it sends them. The label it puts on the terms and on its own record of a refused open is
what `adminCallerTerms()` returns for the capability's caller: `"api"` or `"cli"` with no
origin, or `"gatekeeper"` with the workspace and, when there is one, the chat, and a `TypeError`
for anything else. `inspectWorkspace()` also refuses, with a `TypeError` and before anything is
reached, a `forIssueReport` that is not a non-empty string of at most 128 characters.

`openForAdmin()`:

- **is reachable only over the Workshop's Durable Object binding**, never through a capability a
  user holds;
- **refuses a workspace never initialised or since deleted** (`workspaceNotFound`) before anything
  else, writing nothing. Unlike `open()`'s first-open path it never asks a user DO whether the
  workspace is theirs, so it never claims ownership;
- **skips `authorizeCollaborator()` and observer verification by explicit policy**: the admin is not
  a collaborator and is never registered with the workspace's gatekeepers. This is a deliberate
  exception to the observer invariant, compensated by the audit (see
  [observers.md](observers.md#admin-access-a-deliberate-exception));
- reads its environment only through the `OverseerImpl` (`impl.env`), never through the Durable
  Object's own `env`;
- refuses an expiry already past when the workspace answers as any call on an expired view is
  (`viewExpired`, unrecorded).

The view (`AdminWorkspaceViewImpl`) is not an `Overseer`. It joins no presence, session count or
outputs fan-out, and starts no agent, ambient capsule or gatekeeper facet; waking the Durable Object
still resumes turns a previous instance left running, as any wake does. It offers these reads,
shaped as the matching `Overseer` reads are where there is one:

- **The workspace**: `describe()` and `getDiagnostics()`, whose counts come with the size of the
  workspace's storage and who has it open. Its `sessions` count what collaborators hold on the
  workspace, by role: holds, not people, and never the owner's sessions or an admin view.
  `describe()` also says what the view was opened for (`access`) and lists the live grants the
  workspace stores (`grants`, see [Grants](#grants)).
- **Chats**: `listChats()`, `getChatState()` and `listChatAttachments()`. `getChatState()` is the
  state behind a chat that looks stuck: the agent turn recorded for it, running or paused, when its
  newest entry was written, the calls queued for its agent, and the actions it submitted that still
  wait for approval. `listChatAttachments()` lists each attachment from its message's reference to
  it, and returns none of its bytes.
- **Actions**: `listActions()`.
- **Code**: `listFiles()` lists the files at a gadget's committed head. `getCommitLog()`,
  `listFilesAtCommit()` and `listChangedPaths()` list a gadget's history, the files of any version
  of its code and the paths that differ between two versions. `listPendingChanges()` lists the
  paths a chat changed on top of each pin's base and has not had accepted.
- **Content**, each refused unless a grant is live when it is called (see
  [The five content reads](#the-five-content-reads)): `getChat()`, `readChatAttachment()`,
  `readFile()`, `readFileAtCommit()` and `readPendingFile()`.
- **Connections and sharing**: `listGatekeepers()`, `listObservers()`,
  `listObserverRequirements()`, `listShareLinks()`, `listAutoApprovals()` and `listBlueprints()`.
  `listObservers()` lists which collaborators hold an observer record, and the account each chose
  for each connection. `listObserverRequirements()` lists what a recipient of a share would have
  to verify: the connections that sharing the workspace, or one gadget, asks them to pass.

Three of these give less than their names promise:

- **`listObservers()` lists who holds a record, not who was admitted.** An observer record is
  reserved at a collaborator's first admission, before anything is verified, and outlives a failed
  one. A record with no account choice has nothing verified yet.
- **`listPendingChanges()` is not always all that accepting would change.** It compares a chat's
  content with each pin's `baseCommit`, while accepting compares it with the pin's `mergedCommit`.
  Where the two differ (a pin rooted at a merge commit, after an update from mainline or for a
  proposed blueprint merge, or a worktree's pin that an agent step re-rooted),
  `listChangedPaths(mergedCommit, baseCommit)` is the rest of what accepting would change, and the
  listed paths can be empty while there is a change to accept. The one entry it lists with no base
  is a gadget the chat created that is not accepted yet (a worktree is pinned at its first
  modification, so it always has one).
- **`listAutoApprovals()` lists opt-ins, which apply nothing alone.** They are the rules members
  turned on. An action is applied without a manual approval only when its author also marked it
  `autoApprovable` and, once the workspace has read restricted data, only where
  [the rule under the mark](#through-an-agent) says so: for an admins-only note, a status change
  and an assignment of the admin gatekeeper, in a workspace only its reads marked. Every other
  rule stays stored and listed while its actions wait, so a rule listed here may be applying
  nothing. A view shows the first two conditions, which is how an admin answers why an action
  still waited: `describe()` reports `containsRestrictedData`, and `listActions()` keeps each
  action's `autoApprovable` verdict and kind, with `autoApproved` on one a rule applied. Whether
  only the admin connection's reads marked the workspace is not a field of a view:
  `listActions()` lists each observation with its connection.

An admin read never reaches a connection, and reads only what the workspace stores:

- **Commits.** `listFiles()` and `readFile()` read a permanent gadget's committed head.
  `listFilesAtCommit()`, `readFileAtCommit()`, `getCommitLog()` and `listChangedPaths()` take any
  commit the workspace stores (a gadget's history, a worktree's commits, a chat pin's base) and
  refuse anything else. All of them read only stored objects, through the local readers of
  `git-cache.ts`: `readLocalCommitTree`, `readLocalFileAtCommit` and
  `changedLocalFilePathsBetween`, which read only the objects the store holds, and `readCommitLog`,
  which reads only the commits the store holds. The ordinary reads pull a missing object through the workspace's
  connections; these never do. A missing object is an error, not a fetch. `getCommitLog()` stops
  at a parent that is not stored (`stopAtMissing`), which is how a worktree checked out without
  its history lists.
- **Commits a connection supplied.** A stored commit can be one a connection supplied. A worktree
  checked out through a connection holds that repository's commits (the workspace records, for
  each object, the connections that are its sources, in `gitObjectMetadata`; a commit that no
  connection is recorded as a source of, such as one in a gadget's history that was never pushed,
  has none), and the workspace stores what it pulled. The commit reads treat those commits as
  any other: they show the repository's file names, commit ids, authors and times, and the paths
  that differ between two of its commits; under a live grant, on a view opened for content, they
  also return its files and its commit messages, as far as the workspace stores them. The
  connection is never asked, so the admin is not verified against the repository, and reads no
  more of it than the workspace already holds. This is the part of the
  [admin exception](observers.md#admin-access-a-deliberate-exception) that these reads widen.
- **A chat's pending content.** `listPendingChanges()` and `readPendingFile()` use the fold the
  members' sessions use (`getCurrentChatContent()`), given a base reader that reads stored objects
  only (`readLocalFileAtCommitIfExists`), where the sessions' reader pulls. The fold's cache stays
  valid whichever reader filled it, because a commit is immutable: a reader that succeeds returns
  the same text, and one that cannot read a base throws. A base that cannot be read fails the call
  with the read's error, and that reader's errors name a path or an object id and never quote a
  file: it names a symlink without its target, which the members' reader includes.
  `listPendingChanges()` tells a worktree's paths apart by what its base holds at each
  (`localPathEntryAtCommit`), reading no blob.
- **Attachments.** `readChatAttachment()` reads an attachment from what its record stores
  (`openChatAttachment()`): the record's own bytes, else its stored blob, else, for a record that
  holds only a commit and a path, the file there. A member's read of that last kind can pull the
  object through a connection; this one fails when the object is not stored.
- **What a connection could answer** is read from the workspace's records instead: observer
  requirements from the connections' records and the action log's index, auto-approvals from the
  stored rules (never `listPreApprovableActions()`, which asks each connection), and connections
  from their records.

Beyond the workspace's own storage, a view asks only its owner's account, for two things. One is
the owner's profile: in `describe()`, and in `listShareLinks()`, which uses the same lookup and
only when the owner created a link. The other is the owner's account-wide grant, asked for only
when a call that would return content finds no live grant in the workspace's own storage (see
[The account-wide grant](#the-account-wide-grant)). That question is the one outward call content
reads add.

### Who created a connection

A connection records its creator (`GatekeeperRecord.createdBy`): the member whose session made it
(`newGatekeeper()`, `newAiModelGatekeeper()`, `newAgentSpawnerGatekeeper()`), or the initiator of
the agent turn whose `createExternalResource` call created its resource. `listGatekeepers()` shows
the creator.

Two kinds of connection have none:

- **An ambient capsule**, because no person created it. A workspace installs one on open for each
  singleton account its owner holds (the Context Library's, for one), so it comes from the owner's
  own account of that vendor, and a workspace whose owner has none has no such connection.
- **A connection whose creator was not recorded**: one written before creators were recorded, or a
  resource created in a turn that has no record.

### Opening for content

An inspection opens a view for `"metadata"` unless it asks for `"content"`
(`AdminWorkspaceInspectOptions.access`). Content must be asked for, so that a view opened to look at
metadata never reads a chat because a grant happened to be live: on a metadata view the five
content reads are refused (`contentNotRequested`) and every other method answers as the
`"metadata"` level does, whatever grants the workspace holds.

- **Opening for content needs the level in force to be `"content"`**, by the authoritative config.
  Below it the open is recorded and refused (`contentOff`) before any workspace is reached, as an
  open is while the level is `"off"` (`accessOff`).
- **It needs no grant yet.** The open looks for none and asks no account: its record says
  `requested: "content"` and `exposed: "metadata"`, with no `grantId`. Each call of the view then
  looks for a grant itself (see [Each call](#each-call)), so a view opened before a grant is given
  reads content once one is, and stops when it ends.
- **A value that is neither is rejected** with a `TypeError` before the open runs, by
  `AdminApiImpl`'s RPC validation.

What a view was opened for is fixed for its life and is on every record it makes (`requested`).
An investigation therefore starts on a metadata view and moves to content deliberately, in a
second `inspectWorkspace()` call with a reason of its own, and the log shows when it did.

**A view can be opened for one issue report** (`AdminWorkspaceInspectOptions.forIssueReport`,
which the admin gatekeeper's session limited to one report uses: see
[Through an agent](#through-an-agent)). Only the grant the workspace's owner gave with that
report, or the owner's account-wide grant, then answers a content call, and the view's
description lists no other grant. Such a view is opened only for a report the workspace's owner
filed about that workspace: any other is refused as a report that does not exist
(`ISSUE_REPORT_NOT_FOUND`), unrecorded, since nothing of the workspace was read.

The Workshop never opens a view for content. Its page for one workspace
(`/admin/workspace/<workspaceId>`) opens a metadata view, lists the workspace's live grants, ends
one a second admin approved and asks for content access; content itself is read through the API
and `cf-os api`:

```sh
pnpm cf-os api get-admin-api inspect-workspace <workspaceId> "<reason>" \
  --options '{"access": "content"}' get-chat <chatId>
pnpm cf-os api get-admin-api inspect-workspace <workspaceId> "<reason>" \
  --options '{"access": "content"}' read-file <gadgetId> <path> --out <file>
```

`--out <file>` saves the bytes of a file the answer streams (see
[The five content reads](#the-five-content-reads)); the JSON around them is printed as without it.

### Each call

Every view method, the open included, runs through `adminViewCall()` (`admin-view.ts`), which each
view's `#call()` hands its call to. Both views run it, a workspace's and a user account's, and it
also appends the record each view builds. Steps 5 and 8 are a workspace view's alone: its `#call()`
runs them inside the read it hands over, which is told the level in force. A user account's view
answers with metadata alone, so it has neither:

1. The view's checks: it has not expired (`viewExpired`), its admin is still an admin (`notAdmin`),
   and the workspace or the account still exists (`workspaceNotFound`, `userNotFound`). A call
   that one of these checks stops is not recorded.
2. The deployment's setting is read (`readAdminConfig`, the KV mirror).
3. The checks again, since that read may have spanned the expiry, a demotion or the workspace's
   deletion.
4. The level in force is the admins' choice held to the environment's cap
   (`adminAccessPolicy()`). While it is `"off"`, the call is recorded with `refused` set, and then
   refused (`accessOff`) without reading anything. Its record is sent with nothing awaited after
   step 3's check. Turning the setting off reaches live views within about a minute (the KV
   mirror's propagation), and a view still within its lifetime answers again once the level is
   back at `"metadata"` or `"content"`.
5. Whether the call may return content. `ADMIN_METHOD_ANSWERS` says what the method's answer can
   hold: `"metadata"` (metadata alone), `"mixed"` (content under a grant, metadata without one) or
   `"content"` (content alone). A `"metadata"` method, the open among them, skips this step: it
   never looks for a grant. For the others, three things are checked, in this order:
   1. the view was opened for content (`contentNotRequested` otherwise);
   2. the level in force is `"content"` (`contentOff` otherwise). The level is read on every
      call, before any grant, so a grant never widens it: lowering the admin setting below
      `"content"` reaches open views within about a minute (the KV mirror's propagation), and a
      lowered cap takes effect when the deployment that carries it is live;
   3. a grant is live for the workspace (`grantRequired` otherwise): in its own storage, or, as
      its owner's account said within the last `ADMIN_GRANT_ACCOUNT_CACHE_SECONDS` (60),
      account-wide (`contentGrant()`, see [Grants](#grants)). The view's checks run again after
      it, since the question to the account may have awaited.

   A `"content"` method lacking one of the three is recorded with `refused` set, exposing
   `"metadata"`, and then refused with that code, having read nothing. A `"mixed"` method is not
   refused: it goes on and answers as the `"metadata"` level does.
6. The read, on the server and never through a connection. It is told whether the call may return
   content, which is the one thing a withholding helper hangs on. A read that throws is recorded
   as an attempt exposing `"metadata"` (with the grant's id when the call ran under one), once the
   checks pass again, and the call fails with the read's error: a missing object, a gadget whose
   code is pending, an invalid path, a commit that is not stored, a chat that does not exist. `listObserverRequirements()` throws, as the members' call does, for a legacy connection
   (one made before connections could verify collaborators) in the scope of the grant it was asked
   about: any such connection for `"workspace"`, and for a gadget only one the gadget reaches. A
   malformed string argument (a commit id, a path, an attachment id) is checked inside the read,
   so it is recorded this way. A number out of range is not: `getCommitLog()`'s `depth` outside 1
   to `MAX_ADMIN_COMMIT_LOG_DEPTH`, like `listActions()`'s invalid `beforeId`, is rejected before
   the call starts, and is not recorded.
7. The checks again, with nothing awaited before the record is sent, since the read may have
   awaited. If the view expired, its admin was demoted or the workspace was deleted while the
   call was reading, the call writes nothing, appends nothing for the workspace and returns
   nothing.
8. What the call exposed (`exposed`), from the answer it read: `"content"` only when the call ran
   under a grant and its answer held something the `"metadata"` level withholds, `"metadata"`
   otherwise (see [What a call exposed](#what-a-call-exposed)).
9. The record, in the deployment-wide log, with the grant's id (`grantId`) when the call ran
   under one, whether or not its answer held content.
10. The answer.

The record follows the read because it says what the call returned, which only the answer can
tell, and so that a call the view stops while it reads (expiry, a demotion, the workspace's
deletion) writes nothing. The point a record must precede is the answer leaving the server, since
that is what an admin sees. Holding the answer until its record exists means that nothing reaches
an admin unrecorded and that a call whose record cannot be written returns nothing, and a call
refused by the level or for want of a grant is still recorded without reading anything. No check
follows the append: the answer was read while the view was live, and its record exists.

**A grant that ends while a view is open ends content on the view's next call.** Step 5 runs on
every call, so nothing a view learnt earlier carries over: an owner ending their workspace's own
grant, and an admin ending an approval's (`endWorkspaceGrant()`), are seen by the very next call,
since both change the workspace's own storage; the end of an account-wide grant is seen within
`ADMIN_GRANT_ACCOUNT_CACHE_SECONDS`. A grant given while a content view is open is found the same
way, by the view's next call.

**When the owner's account cannot answer**, the call is one with no grant: `contentGrant()` never
throws, so a content method is recorded and refused `grantRequired`, and a mixed method answers
withheld and is recorded as exposing `"metadata"`. A call never fails unrecorded because an
account could not be reached.

### The five content reads

Each returns only content, so each is refused, and the refusal recorded, unless all three checks
of step 5 pass. Each reads only what the workspace stores:

| Call | Returns |
| --- | --- |
| `getChat(chatId, beforeSequence?)` | One page of a chat's messages, paged as a member's `getChatHistory()` pages it, with the compaction summary when the page starts at one. |
| `readChatAttachment(chatId, id)` | The bytes of one attachment `listChatAttachments()` lists, as a stream. |
| `readFile(gadgetId, path)` | One file at a permanent gadget's committed head. |
| `readFileAtCommit(commitId, path)` | One file at any commit the workspace stores. |
| `readPendingFile(chatId, gadgetId, path)` | One file of a chat's current content for a workpiece it holds changes to (`listPendingChanges()` names the paths). |

**An admin's chat page carries no inline image.** A member's page inlines the bytes of its image
attachments. An admin's returns every attachment as its reference alone, an image included, so
that a page never holds an image whole on the server: its bytes are read with
`readChatAttachment()`, which streams them.

**A file is an `AdminFileContent`**: `text` for a text file of at most `MAX_BUFFERED_BLOB_SIZE`
(1 MiB); `stream`, with its length, for a larger file or one that is not text; `absent` for a path
that names nothing or a directory; `unreadable` for a symlink or a submodule, with a message that
can quote the link's target. From `readPendingFile()` a file the chat holds as bytes is a `stream`
whatever its size, and a pending text is one when its UTF-8 encoding is over the same bound.

**Large files and attachments are streamed, never held whole.** A `stream` is read from the stored
blob as the caller pulls it, and an attachment the same way. What is in memory is only what a
stored record already holds whole: a pending text, which the chat's folded content holds as a
string, and an attachment whose record keeps its own bytes. The stream is returned at step 10,
after the record, and an answer in flight is not another use of the view, so:

- **The stream is part of the recorded answer.** Its record, exposing `"content"`, exists before
  the first byte leaves, and counts the file whole, whether or not the caller reads it to the end.
- **Nothing checks the view again while the bytes flow.** A stream that has started runs to its
  end after the view expires, its admin is demoted, the level is lowered or the grant ends: those
  stop the next call, not an answer already recorded. A workspace restart ends it, as it ends
  every session's streams.

This matters most for `readFileAtCommit()`, which reads any stored commit, a repository a worktree
checked out included, where a file can be far larger than a gadget's.

A view lasts `DEFAULT_ADMIN_VIEW_LIFETIME_SECONDS` (15 minutes) unless the open asks for up to
`MAX_ADMIN_VIEW_LIFETIME_SECONDS` (an hour). A workspace restart (a revocation, a deletion, a
redeploy) ends every view along with every other session on it; inspect again.

## User inspection

`AdminApi.inspectUser(userId, reason, { lifetimeSeconds })` opens an `AdminUserView` of one user's
account as `inspectWorkspace()` opens a view of a workspace: the reason and the lifetime follow the
same rules, the deployment's one level governs both, and every call runs as a workspace view's
does (see [Each call](#each-call)), without its grant step: an account's view has no level to
ask for (the options of `inspectUser()` declare no `access`), and at the `"content"` level it
shows what it shows at `"metadata"`. `userId` is the user's canonical id, exactly as `listUsers()`
lists it. The method's own check refuses an empty id (`userNotFound`); any other names the
account's Durable Object, on which it calls
`UserDurableObject.openForAdmin(adminId, reason, sessionId, terms)`.

`openForAdmin()`:

- **is reachable only over the Workshop's Durable Object binding**, never through a capability a
  user holds;
- **refuses an account never created** (`userNotFound`) before anything else, writing nothing:
  reaching the object by a name no one signed up with creates no account;
- refuses an expiry already past as any call on an expired view is (`viewExpired`, unrecorded);
- mints the view with `openAdminUserView()`, the one way to make one: the view's class
  (`AdminUserViewImpl`) is not exported, and the open is recorded as the view's first call, so no
  view exists whose open was not recorded.

The view never holds the Durable Object. It holds an `AdminUserViewHost`: the object's environment,
the audit log's namespace, when the alarm next fires, the connected-account records, and the
account's store as `UserStoreReads`, which is the `get` and `list` of each collection and singleton
and nothing that writes, subscribes or opens a transaction. So the view holds only the store's
reads, and the rule that it never touches a gatekeeper is a type: the two collections whose records
hold gatekeeper stubs are not in `UserStoreReads`, connected accounts reach the view without their
stubs (`openForAdmin()` drops each record's `account` before the view sees it), and pending
handoffs (grants staged and not yet confirmed) are not read at all.

The view writes nothing to the account, starts no session, syncs no directory (the user's last
login and their listing stay as they were) and sets no alarm, and no method of it connects,
disconnects, renames or deletes anything. Its records go to the deployment-wide log alone, so
nothing the user can read shows an inspection, unless they are a deployment admin themselves, who
can read that log.

Opening a view wakes the account's Durable Object if it was asleep, and any wake runs the
constructor's recovery, which delivers the notifications already queued for the user and re-arms a
missing alarm. The view causes the wake, not the delivery. The recovery writes only notification
delivery's own records (the queue, the read cursor of a chat it delivered for, a push registration
its service reports gone) and the alarm, and nothing else of the account. An account with nothing
queued is left byte for byte as it was.

The view offers seven reads:

| Call | Returns | Withholds |
| --- | --- | --- |
| `describe()` | The user's profile, when the account was created, the last login it told the directory of (to within an hour), whether the user is a deployment admin, whether the account has a password and has finished onboarding, and how many of each thing it holds, with the view's expiry | Nothing |
| `listWorkspaces()` | The workspaces the account lists, in id order: those the user owns, provisional ones included, and those of other users that they have opened as a collaborator, each with its title, cost, notification mute and times, and a shared one with its owner and the user's role in it | Nothing |
| `listConnectedAccounts()` | Each connected account, in id order: its id, its vendor, whether it was auto-provisioned, when its credentials are expected to expire, and whether its gatekeeper has reported them expired | What its gatekeeper says of each account (its description): its names, avatar, granted resource types and what it provides |
| `listModels()` | The models the user added (id, display name, provider, model name, and whether it overrides the provider's API URL), and the ids of the models they chose as preferred and for quick tasks | Nothing |
| `listSessions()` | How many sign-in sessions the account holds, and the latest `ADMIN_LIST_MAX_LIMIT` (200) of them, latest first: when each was created and when it expires, and for a device session staged for a handoff, when that handoff lapses | Nothing |
| `listBlueprints()` | The blueprints the account holds, the user's own (published from a workspace, or imported) and then those in their library (uploaded, or added by id): each one's title, version and release time, the workspace a published one came from, and whether one of the user's own is featured | Each blueprint's id, which is a share link to its code |
| `getDiagnostics()` | When the alarm next fires, the connect flows and device sign-ins still pending, the push devices by kind, the notifications queued, the day's model-call count, and the billing account's id and credit balance | Nothing |

The open (`inspectUser`) returns the view and nothing of the account.

The two withheld parts are not fields of the view's types (`AdminUserConnectedAccount` has no
description, `AdminUserBlueprint` no id), so no setting and no option returns one. A connected
account's description is its gatekeeper's own text, and a name in it can carry a token (a
gatekeeper that names an account by an address holding one). A blueprint's id is withheld as a
workspace view withholds one (see [The levels](#the-levels)).

No call returns what the account stores as a credential either: session tokens and their hashes,
the password's hash, model API tokens and extra headers, push subscriptions, and pending connect
and sign-in tickets. Each answer names its fields one by one, since the stored records hold more
than an answer may. The three stored values returned whole are API values that hold no credential:
`describe()`'s profile, a shared workspace's owner and a workspace's notification mute. A model's
API URL is free text, not a credential, but a URL can carry one, and an investigation needs
nothing else of it, so only whether one is set is returned (`AdminUserModel.customApiUrl`).

`getDiagnostics()` reports the billing account's id, the credit balance and the day's model-call
count: they are metadata.

`listWorkspaces()` lists more than the user's home page shows. A workspace is provisional until it
has some activity, such as a chat message or a code edit: the home page creates one ahead of the
user's first message, and nothing deletes one left unused. The user's own
`AuthenticatedApi.listWorkspaces()` leaves the provisional ones out. The view lists them, each
with no `lastActive`, and `describe()` counts them among the workspaces the user owns.

A connected account whose gatekeeper is no longer bound is left out, of the listing and of
`describe()`'s count, as the user's own listing leaves it out. A restart of the account's Durable
Object ends the view; inspect again.

## Grants

A grant is one record that makes a workspace's content readable by the deployment's admins for 72
hours (`ADMIN_GRANT_LIFETIME_SECONDS`). It comes from the workspace's owner, for that workspace or
for all of their workspaces, or from a second admin who approves another admin's request with a
passkey. No level shows content without one.

### The record

An `AdminAccessGrant` holds:

| Field | What it is |
| --- | --- |
| `id` | Random and opaque. It is on the audit record of every call made under the grant. |
| `level` | What it lets admins read: `"content"`. A field, so that another level needs no migration. |
| `source` | `"owner"`, or `"admins"` for a second admin's approval. |
| `scope` | `"workspace"`: the one workspace it is stored in. `"account"` (an owner's only): every workspace its giver owns. |
| `grantedBy` | The owner, or the approving admin. |
| `requestedBy`, `requestId`, `reason` | For `"admins"`: the admin who asked, the write request it was approved through, and why, as the requester gave it. |
| `reportId` | For `"owner"`: the issue report it was given with, when it was given with one. |
| `grantedAt`, `expiresAt` | When it was given, and when it stops being live unless ended sooner: 72 hours after it was given or last renewed. |
| `revokedAt`, `revokedBy` | When it was ended early and by whom. Set once, never cleared. |

A workspace's grants are a collection of its own storage (`adminGrants`, by id). The account-wide
grant is one value in its owner's account. A workspace can hold several live grants, and a content
call needs any one.

**One rule says whether a grant is live** (`isAdminGrantLive()`): its level is `"content"`, it is
not revoked, and the time is before its end. It fails closed: a record whose end is not a valid
time, or whose level is not one this server reads content under, is not live. The per-call check,
the owner's methods, the admins' and the account's answer all decide through it.

**A grant never widens the level.** While the level in force is below `"content"` a live grant
reads nothing, new grants are refused (`contentOff`), and a grant still live when the level
returns to `"content"` reads again (see [Access levels and their bounds](#access-levels-and-their-bounds)).

**Who gave and who ended a grant is kept as an id and a display name** (`NamedUser`, made by
`namedUser()`), each at most 256 characters, never a profile: a longer name is cut and marked, and
a longer id is kept as the audit log keeps an owner's, as its start and a digest of the whole.

**An ended grant is kept at least as long as the audit log keeps its records**, and deleted when
its workspace or account next handles grants of that source after that (`isAdminGrantPrunable()`):
the owner's methods delete the owner's, and the admins' grant writes delete either kind. Nothing
else prunes, so a workspace nobody gives or ends a grant on again keeps its ended grants until it
is deleted. The account-wide grant is the one exception to "at least": the account keeps one
record, so an ended one is kept only until its owner gives the next, which replaces it whatever
its age. Every grant of a workspace is deleted with it.

### The owner's grant

Only the workspace's owner grants. Four methods on `Overseer`, refused for anyone else as
`deleteSelf()` is and denied in a `use` session:

- `grantAdminAccess({ reportId? })` stores a grant for 72 hours and returns it;
- `renewAdminAccess(grantId)` moves a live grant's end to 72 hours from now, any number of times;
- `revokeAdminAccess(grantId)` ends it, and works whatever the deployment's level;
- `listAdminGrants()` lists the owner's grants, live and recently ended.

A collaborator can file an issue report but cannot grant. Giving and renewing are refused
`contentOff` while the level in force is below `"content"`. `reportId` names an issue report the
owner filed about the workspace, which then shows the grant (see
[issue-reports.md](issue-reports.md#the-grant-given-with-a-report)).

**The four methods see only the owner's own grants.** They never write, delete or return a grant
whose source is `"admins"`: such a grant is absent from `listAdminGrants()`, and renewing or
ending its id is refused `notFound` by the same lookup and the same throw as an id that names
nothing, so an owner cannot learn by probing that one exists (see
[Who sees a write in the workspace](#who-sees-a-write-in-the-workspace)).

### The account-wide grant

"All my workspaces" is one record in the owner's account, given, renewed and ended through the
owner's own `AuthenticatedApi`: `grantAccountAdminAccess({ reportId? })` gives it, in place of an
ended one, or moves the live one's end to 72 hours from now, `revokeAccountAdminAccess()` ends it,
and `getAccountAdminGrant()` returns it. It is never copied into a workspace, and it covers
workspaces made after it was given.

A workspace asks its owner's account for it (`liveAccountAdminGrant()`) only when an admin's call
needs content and the workspace's own storage holds no live grant (`contentGrant()`). No
member-facing path, no listing and no metadata call ever asks.

- **A live answer is kept for 60 seconds** (`ADMIN_GRANT_ACCOUNT_CACHE_SECONDS`), in memory,
  counted from when the question was sent and for the owner it was asked of. An answer that
  takes that long to arrive is neither used nor kept, so the call that waited for it is one with
  no grant. A revocation of the account-wide grant is therefore seen by content calls within a
  minute, where the end of a workspace's own grant is seen by the very next call.
- **"No grant" is not kept**, so a grant given a moment later is found by the next content call.
- **The workspace checks the answer itself** (`isLiveAccountGrant()`), each time it uses it: the
  account's word is not taken for the grant's liveness, scope or source.
- **An account that cannot answer counts as no grant.** The failure is logged, never kept, and
  the call is still recorded (see [Each call](#each-call)).

### An approval's grant

Any admin can ask to read a workspace's content without its owner, and a second admin approves the
request with a passkey: the write action `"grantContentAccess"` (see
[Asking for content without the owner](#asking-for-content-without-the-owner)). It stores a grant
with source `"admins"` on one workspace for 72 hours. It is never renewed: it is asked for and
approved again. Only admins end it, with `endWorkspaceGrant()`.

### An owner's grant is the owner's own record

Giving, renewing and ending an owner's grant, and its expiry, on one workspace or account-wide,
write no record to the admin audit log. The log records what admins do. So nothing bounds how
often an owner grants or renews, and there is no audit kind for grants. Admins learn of an
owner's grant where they work:

- among the workspace's live grants on the admin view (`describe().grants`);
- on the issue report it was given with;
- by its id (`grantId`) on the record of every content call made under it, which is all the audit
  log says of it.

What admins do about a grant is recorded: the request, the approval and the applying of
`"grantContentAccess"`, an admin's ending of its grant, and every call made under any grant.

### What the listings return

An owner gives grants without limit and a display name has no bound of its own, so the answers
are bounded, not the owner: each listing returns at most `MAX_ADMIN_GRANTS_LISTED` (20).

- `listAdminGrants()` puts the owner's live grants first, newest first, then the ended ones still
  kept, so that while a grant the owner can still end exists, one is listed. An owner with more
  than 20 live grants is shown the newest 20; ending one makes room for the next.
- `describe().grants` lists live grants only: those a second admin approved first, newest first,
  then the owner's newest, so that the owner's grants never crowd out the one kind of grant only
  an admin can end. Each of those took a passkey approval, so they are few; a workspace that
  held more than 20 live ones would show the newest 20, and the next as each is ended. Neither
  listing is the whole set once it holds 20.
  The account-wide grant is not among them, since the workspace asks for it only when a call
  needs content.

## Writes

A write request has three actions. Two change a workspace: stop an agent, or restart the
workspace. They give the admin access to nothing in the workspace. The third,
`"grantContentAccess"`, changes nothing in the workspace and is exactly a grant of access to its
content, for 72 hours, without its owner: which is why a second admin must approve it (see
[Asking for content without the owner](#asking-for-content-without-the-owner)).
Writes are off unless the deployment's `ADMIN_WORKSPACE_WRITES` is `on` (see
[The environment's bounds](#the-environments-bounds)), and a write takes two steps: any admin
session requests it, and an admin approves it with a passkey on a page of the Workshop. Only then
does the workspace run it: for the two that change it, as the operation a member would run.

### Why a second factor, and what it is worth

An inspection reads. A write changes what users own, and some writes cannot be taken back, so a
write asks for more than an admin's session.

What is verified is this, and no more: a write runs only after the server has verified an assertion
by one of the approving admin's enrolled passkeys, with user verification, over a challenge bound
to that request, on the deployment's origin and relying party.

What that does not prove is that anyone other than the holder of an admin's session approved.
Enrolling a passkey needs only an admin's session, and no attestation is checked, so a session
that can enrol a key can also approve with it. The gate therefore holds against a session or an
agent that asks for a write without enrolling a passkey of its own, and against a browser on
another origin. Against an enrolment made by a stolen session, what stands is the record: every
enrolment and removal is a setting record that every admin sees, and every approval's record
names the passkey that signed (see
[If a passkey was enrolled by someone else's hands](#if-a-passkey-was-enrolled-by-someone-elses-hands)).

### Request

`AdminApi.requestWorkspaceWrite(workspaceId, action, args, reason)` is open to any admin session,
the CLI's and an agent's included
(`cf-os api get-admin-api request-workspace-write <workspaceId> <action> <args> <reason>`). It
checks, in this order:

1. that the caller is still an admin (`notAdmin`) and writes are on (`writesOff`);
2. the reason, as an inspection's is checked: not blank, at most
   `MAX_ADMIN_ACCESS_REASON_LENGTH` (500) characters;
3. the arguments (`adminWriteArgs()`): each action takes only its own (`AdminWriteArgs` lists
   them), and a request that names any other, or lacks a required one, is rejected with a
   `TypeError`. Only what the action takes is kept;
4. for `"grantContentAccess"` alone, that the level in force is `"content"`, by the authoritative
   config (`contentOff`): a request for content is never made at a level the KV mirror alone still
   shows;
5. the workspace id's form (`workspaceNotFound` for a malformed one);
6. that the deployment has a `PUBLIC_BASE_URL` (`originUnset`): without one there is no page to
   approve the request on;
7. that the directory lists the workspace (`workspaceUnlisted`);
8. that fewer than `MAX_PENDING_ADMIN_WRITES` (50) requests are pending across the deployment
   and, for a request filed [through an agent](#through-an-agent), fewer than
   `MAX_PENDING_AGENT_ADMIN_WRITES` (10) of those (`tooManyRequests`): a workspace's rule can
   file one with no person deciding, and those leave the other slots to people.

The request is then recorded (`"requested"`) and, only once its record exists, stored.

- **It never reaches the workspace.** The title and the owner a request carries are the
  directory's, the unrecorded finding aid, as they are for an open refused before it reaches a
  workspace. Whether a chat or a connection the arguments name exists is found out only when the
  write runs.
- **A workspace the directory does not list cannot be requested.** The approval must show whose
  workspace it changes, and the directory lists a workspace once one of its members has opened it
  (see [What the lazy backfill misses](#what-the-lazy-backfill-misses)).
- **It lasts ten minutes** (`ADMIN_WRITE_REQUEST_LIFETIME_SECONDS`), after which it is recorded
  `"expired"`. It ends the same way, sooner, when its requester stops being an admin: a request
  does not outlive its requester's admin status. `getWorkspaceWrite()` reads a request for a day
  after it is resolved.
- **It returns its approval URL**, `<PUBLIC_BASE_URL>/admin/approve/<request id>`. Opening the page
  needs an admin's session, and the URL grants nothing.
- **A request an agent files is its workspace owner's.** Through the admin gatekeeper,
  `requestWorkspaceWrite()` is queued as an action of the workspace and filed once that action
  is approved (see [Through an agent](#through-an-agent)). Its requester (`requestedBy`) is the
  owner of that workspace, whichever member approved the filing, and the request carries where
  it came from (`via: "gatekeeper"` and `agent`).

**The reason of a write that changes a workspace is written for the people who read its action
log**: its owner and its build collaborators. An inspection's reason stays in the admins' log. A
write's is shown to those people word for word once the write is approved, so it must not hold
what they should not read. The approval page repeats this beside the reason. The reason of a
`"grantContentAccess"` request is the exception: it stays in the admins' log, as an inspection's
does, and the page says that instead.

`denyWorkspaceWrite()` ends a pending request, recorded (`"denied"`) before it is stored as such.

### Approve

The page at the approval URL shows the workspace's title and id, its owner, the action, each
argument, the reason, who requested it and how (`via`), and when it expires. A request an agent
filed is shown as its requester's agent's, with the workspace and the chat it came from
(`agent`). It shows what the request stores, and looks nothing up in the workspace:

- **Ids are shown as requested.** A chat or a connection is the id the request names, so an
  approver checks what it names with an inspection first. Where the deployment's access level is
  `off` there is no inspection to check it with, and the page states that instead.

The admin confirms with **Approve with passkey**, or denies.

**The challenge** (`beginWorkspaceWriteApproval()`) is 32 random bytes followed by the SHA-256 of
the request's canonical JSON (`adminWriteDigest()`: its id, workspace id, title and owner, action,
arguments, reason, requester, `via`, where an agent's request came from (`agent`), and the times
it was made and expires), so the authenticator signs what is approved. An admin has one approval
challenge outstanding: beginning another replaces it. It lasts five minutes
(`ADMIN_PASSKEY_CHALLENGE_LIFETIME_SECONDS`) and never past its request's expiry, and it is
deleted before anything about its answer is checked, so its first answer spends it, right or
wrong. An admin with no passkey of their own is refused `passkeyRequired` here, and the
requester of a `"grantContentAccess"` request is refused `secondAdminRequired` (see
[Asking for content without the owner](#asking-for-content-without-the-owner)).

**The answer** (`approveWorkspaceWrite()`) must be an assertion by one of the caller's own
passkeys over that challenge, issued for that request as it is still stored. `AdminSettings`
checks that the challenge the caller holds was issued for this request, that the passkey the
answer names is the caller's own, and that the digest the challenge ends with is still the stored
request's, computed again. The verifier (`verifyPasskeyAssertion()`) then checks:

- the ceremony's type (`webauthn.get`, never a registration's answer);
- the challenge, whole, as it was issued;
- the origin, against the deployment's;
- that the answer was not made in a cross-origin frame (`crossOrigin`, and any `topOrigin`);
- the relying party: the authenticator data's hash of the relying party id;
- user presence;
- user verification;
- the authenticator data's shape: no attested credential, nothing after its fixed part unless it
  flags extensions, consistent backup flags;
- the signature, under the stored public key (ES256 or RS256), over the authenticator data and
  the hash of the client data;
- the signature counter, which must have risen for an authenticator that keeps one.

**The origin and the relying party come from `PUBLIC_BASE_URL` alone**
(`adminPasskeyRelyingParty()`: the origin, and its host name without the port). No request header
is consulted. `/api` accepts
cross-origin WebSockets outside Cloudflare Access, so the origin in the signed client data is the
only thing that binds a ceremony to the Workshop's own pages.

**What stops a replay**: the challenge is spent by its first answer, and a request is claimed
once, by a read and a write with nothing awaited between them, after the assertion is verified.
The signature counter is a second check only for authenticators that keep one: a synced passkey
always reports 0.

**Every attempt on a stored request that is refused `passkeyRefused`, `requestNotPending` or
`secondAdminRequired` is written to the audit log**, as a `"refused"` write record with the admin
who tried, the check that failed (`refusal`; `"requester"` for the requester's own approval of a
request that needs a second admin) and, when the answer named one of that admin's own, the
passkey. A failed passkey check leaves a pending request pending, and the caller is told only
`passkeyRefused`, never which check it was. The requester's own attempt leaves it pending too,
for a second admin to approve, and is refused `secondAdminRequired` before any passkey check. An attempt on a request that is no longer pending, such as an approval
sent a second time, is recorded the same way and refused `requestNotPending`. Its record can
follow any other step, a closing one included: when a second admin loses the race to approve, or
an approval is sent again while the first is still running, it precedes the closing record, and
often the workspace's `"approved"` too. A refusal whose record cannot be written is still a
refusal: nothing was approved. Its record is then owed. The request keeps it, up to ten a request,
and the sweep writes it once the log takes records again, so its `at` is later than the attempt;
past ten, an attempt made while the log is down is only logged for operators. An attempt refused
`notAdmin` or `writesOff` is not recorded: `AdminApiImpl` refuses it before `AdminSettings`, which
holds the request, is reached, and `AdminSettings` refuses it the same way, from its own
environment, before it reads the request (see
[Which refusals are recorded](#which-refusals-are-recorded)).

### Run

Once the assertion is verified and the request claimed, `AdminApiImpl.approveWorkspaceWrite()`
calls `OverseerDurableObject.applyAdminWrite(grant)`, which nothing else calls. The grant carries
the request (action, arguments, reason, requester, expiry, the owner the approval page showed) and
who approved it, through which session and with which passkey. `applyAdminWrite()`:

- **is reachable only over the Workshop's Durable Object binding**, never through a capability a
  user holds;
- **refuses a workspace never initialised or since deleted** (`workspaceNotFound`) before anything
  else, writing nothing, as `openForAdmin()` does;
- rejects a malformed grant with a `TypeError`, and a request that expired more than a minute ago
  (`requestNotPending`; the minute allows for clock skew);
- **re-checks the approver, the requester and the switch** through the workspace's own environment
  (`impl.env`): both must still be admins (`notAdmin`) and writes still on (`writesOff`), whatever
  the Worker that approved believed;
- **for `"grantContentAccess"`, checks again what it was handed**: an approver who is the
  requester is refused (`secondAdminRequired`), a request that already gave this workspace its
  grant is refused (`requestNotPending`), and so is a level in force below `"content"`
  (`contentOff`);
- **refuses a workspace whose owner is not the one the approval page showed**
  (`workspaceChanged`). A deleted workspace's id can be initialised again for someone else, and
  the approver confirmed a write to the first owner's workspace;
- **appends the `"approved"` record, with the passkey that signed, before anything changes.** A
  write whose record cannot be written does not happen. Nor does one whose workspace is deleted
  while the record is appended: the record is kept, and nothing follows it;
- **writes the write's entry in the workspace's action log**, for every action but
  `"grantContentAccess"`, which enters nothing there (`entersActionLog()`; see
  [Who sees a write in the workspace](#who-sees-a-write-in-the-workspace));
- **then runs the operation** (`runAdminWrite()`). If it throws, the entry is turned `"rejected"`
  and the error is what the request fails with.

As for an inspection, by explicit policy the admin is not checked by `authorizeCollaborator()` or
observer verification, and joins no session, presence or outputs fan-out. Unlike an inspection,
which starts nothing, a write that changes a workspace does what its operation does for a member.

Each of the two actions that change a workspace runs the `OverseerImpl` operation that a member's
session runs for it; the third stores a record and runs nothing a member can run:

| Action | Arguments | Operation |
| --- | --- | --- |
| `stopAgent` | `chatId` | `Overseer.stopAgent(chatId)`, keeping the chat's queued messages |
| `restartWorkspace` | none | Ends every session on the workspace, as a revoked collaborator does |
| `grantContentAccess` | none | Stores a grant with source `"admins"` on the workspace, for 72 hours |

**`stopAgent` keeps the messages queued for the turn.** A member's stop drops the messages sent
while the agent worked that it had not read yet, and the client that stops puts them back in its
draft. An admin's stop has no such client, so those messages go into the chat as their senders'
own, as when a turn fails, and the agent reads them when it next runs.

### Asking for content without the owner

Any admin can ask to read a workspace's content without its owner's grant:
`requestWorkspaceWrite(workspaceId, "grantContentAccess", {}, reason)`. It takes no argument
beyond the reason and runs through the write machinery as it stands: the stored request and its
ten minutes, the approval page, the passkey challenge bound to the request's digest, the record of
each step, the re-checks in `applyAdminWrite()`. It needs writes on (it is a write) and the level
in force at `"content"`, both when it is requested and when it is applied. Its effect is one grant
with source `"admins"` on that workspace, for 72 hours (see
[An approval's grant](#an-approvals-grant)). In the Workshop, an admin's page for a workspace
offers **Request content access**, which takes the reason and gives the approval link to hand to
another admin.

**The approver is not the requester**, for this action only. It is checked three times:

- `beginWorkspaceWriteApproval()` gives the requester no challenge (`secondAdminRequired`,
  unrecorded, as beginning always is);
- `approveWorkspaceWrite()` refuses the requester's approval before any passkey check and records
  the attempt as a `"refused"` step with the refusal `"requester"`, as it records a failed passkey
  check;
- `applyAdminWrite()` checks it again from the grant it is handed, in the workspace's own
  environment.

**Who counts as the requester.** Admin names match the `ADMINS` list regardless of the case of
ASCII letters, while an account is named by its email as the identity provider spelled it, so two
accounts that differ only by case are one entry of the list and one admin, and the approval
compares names the way the list does (`sameDeploymentAdmin()`), never with `===`.

**A request an agent filed is closed to everyone who was in its workspace.** A request filed
through the admin gatekeeper is its workspace owner's, and other admins may work in that
workspace. So the request keeps who was there when it was filed (its insiders: the owner,
everyone the workspace was shared with in any role, and the member who approved the filing),
and each of the three checks refuses any of them as it refuses the requester
(`isRequestInsider()`, with `secondAdminRequired` and the refusal `"requester"`). The list is
read once, at filing: a member who leaves afterwards still cannot approve, and an admin who
joins afterwards can. An admin from outside the workspace approves. The approval page tells an
admin it refused so, and shows the workspace and the chat the request came from.

**What it proves, and what it does not.** It proves that two admin accounts took part: one asked,
and another approved with a passkey enrolled under it. It does not prove two people. An enrolment
needs only an admin's session (see
[Why a second factor, and what it is worth](#why-a-second-factor-and-what-it-is-worth)), so one
person who holds two admins' sessions can ask with one and approve with the other. Against that
stands the record: every enrolment is a setting record that every admin sees, and the request's
`"requested"` and `"approved"` records name both accounts, their sessions and the passkey that
signed.

**A deployment with one admin has only the owner's grant**: nobody can approve its admin's
request.

**The approval page says what is being approved**: reading this workspace's content for 72 hours
without its owner's grant, who asked, and why; that the owner is not told and nothing in the
workspace shows it; and that every read is recorded with the grant it ran under.

**The grant is stored once per request.** The workspace draws the grant's id before it appends
the `"approved"` record, which names it (`grantId`): every read made under the grant carries the
same id, so it leads back to the approval even when the request's closing record never arrives
(see [How a request ends](#how-a-request-ends)). The request's `"applied"` record carries the
grant's id and its end in `outcome` (`grant <id> until <ISO time>`). A request handed to the
workspace a second time is refused (`requestNotPending`): the workspace finds the grant that
names it.

**Only admins end it.** `endWorkspaceGrant(workspaceId, grantId, reason)` ends a live grant with
source `"admins"`, and nothing else: an owner's grant is the owner's to end (`notFound`, as for an
id that names no grant). It asks only for an admin, whatever the level and whether or not writes
are on, since it only takes access away. The workspace (`endAdminGrant()`) appends the request's
`"revoked"` record, with the grant's id (`grantId`), the admin who ended it and why
(`endReason`), before it ends the grant: an ending whose record cannot be written does not happen. A grant another admin ended
while the record was appended is refused `notFound`, and the record stands for the attempt.

**A grant that runs out is recorded by nothing.** Its `"applied"` record says when it ends.

**What does not end an approval's grant.** Turning `ADMIN_WORKSPACE_WRITES` off does not: the
switch stops requests and approvals, not a grant already stored. Neither does removing its
requester or its approver from `ADMINS`. The grant stays live until it runs out or an admin ends
it with `endWorkspaceGrant()`.

What stops content for every grant, an approval's included, is the level: below `"content"` a
live grant reads nothing, and it reads again if the level returns to `"content"` before the
grant's end. To stop content reads, in this order:

1. **Lower the level**: the admin setting, which reaches open views within about a minute (the
   KV mirror's propagation), or `ADMIN_WORKSPACE_ACCESS_MAX`, which takes effect when the
   deployment that carries it is live.
2. **End the grant** with `endWorkspaceGrant()`, or let it run out, before raising the level
   again.

Ending a grant in the workspace's own storage is seen by the very next call: an owner ending
their workspace's grant, and an admin's `endWorkspaceGrant()`. The end of an account-wide grant
is seen within `ADMIN_GRANT_ACCOUNT_CACHE_SECONDS`.

### Who sees a write in the workspace

Unlike an inspection, each of the two writes that change a workspace is entered in its action
log: an `ActionLogEntry` marked
`byAdmin`, with no connection, whose title names the write (`adminWriteTitle()`, built from the
action and its numeric ids alone), whose `resolvedBy` is the admin who approved it, and whose
fields give the reason, word for word, and the request's id. It is delivered live through
`subscribeToActions()` and paged by `listActions()`, and the workspace's activity shows it as a
deployment admin's. That is who did it and why.

**It reaches whoever reads the action log: the workspace's owner and its build collaborators.** A
collaborator who was only given a gadget has no action log (a `use` session's is always empty), so
they are shown nothing when an admin restarts the workspace, and no notice is added for them.

The entry is written before the workspace changes, for each of those two actions, so that no
change an admin makes to a workspace is missing from its log. It is `"approved"` from then on, and
turns `"rejected"` if the workspace could not run the write. It is therefore not proof that the
write completed: a write cut short (the object lost midway) leaves an `"approved"` entry, and a
`"failed"` record in the audit log.

An inspection reads the entry as it reads any other: its title, its state and `byAdmin`, and,
without a grant, none of its fields, the reason among them.

**The owner is not told about reads.** `"grantContentAccess"` is the one write the workspace
shows nobody:

- it enters nothing in the action log, raises no event to the workspace's sessions, no
  notification and no unread count, and neither does an admin's ending of its grant;
- the grant is absent from every member-facing method. The owner's grant methods never write,
  delete or return an approval's grant and append nothing because one exists: it is not in
  `listAdminGrants()`, and `renewAdminAccess()` and `revokeAdminAccess()` on its id are refused
  exactly as an unknown id is, so the owner cannot learn by probing that it exists;
- nothing a member can call, see or subscribe to changes because such a grant exists or because
  content was read, under any grant. An owner's own grant is theirs to list and to end, and the
  reads made under it are in the admins' audit log, not in the workspace;
- one thing is not hidden: an admin's call starts an idle workspace's Durable Object as any
  call does, and a chat subscriber is sent the time that instance started
  (`streamGeneration`). A member can therefore see that something woke the workspace, and
  when. It does not say what: a scheduled task, a hook, a collaborator and an admin's metadata
  inspection wake it the same way.

What stands in for the owner's knowledge is a second admin's passkey approval, the reason, and
the audit records of the request, the approval and every read made under the grant.

### How a request ends

Every approved request ends `"applied"` or `"failed"`, each with its record. The session that
approved carries the workspace's answer back to `AdminSettings` (`settleWorkspaceWrite()`), which
stores it and then records it. If the client hangs up, the run and its settling continue under
`waitUntil()`. If the session's isolate is lost between its calls, the answer never arrives, and a
request still `"approved"` after fifteen minutes (`ADMIN_WRITE_SETTLE_SECONDS`) is settled as
`"failed"` with its outcome unknown. It is never run again. The closing record is written after
the fact, so it is retried until it lands, and may in rare cases appear twice.

`AdminSettings` keeps all of this moving with an alarm: it expires the overdue requests, fails
the approved ones whose answer never arrived, writes the closing and `"refused"` records still
owed, and forgets a request a day after it is resolved and recorded. Every write-request method but the settling
runs the same sweep before it reads a request, so an overdue request is never read as pending.

How to read the records of one request (they share its `requestId`):

- `"failed"` with no `"approved"` before it changed nothing: the workspace refused the write
  before recording it, or was never reached.
- `"failed"` after `"approved"` may have changed the workspace in part or in whole. A restart
  aborts the workspace about 100 ms after it answers, and an operation can throw partway.
- `"refused"` did nothing, wherever it falls. After a closing record it is an approval that was
  tried again. Before one it is a failed passkey check on a request still pending, or an attempt
  that found the request already approved: a second admin who lost the race to approve, or the
  same approval sent again while the first was still running. With the refusal `"requester"` it
  is the requester's own attempt to approve a `"grantContentAccess"` request.
- `"revoked"` follows the `"applied"` of a `"grantContentAccess"` request, possibly days later:
  an admin ended the grant the request gave. The request itself is long forgotten by then; the
  record carries its id, requester and reason as the stored grant holds them.

### Passkeys

An admin enrols and removes passkeys in the admin panel's Access tab. Both are WebAuthn ceremonies
with user verification, checked against the deployment's origin and relying party as an approval
is:

- **An enrolment creates the passkey.** `beginAdminPasskeyEnrolment()` issues a challenge, and
  `addAdminPasskey(name, registration)` checks its answer (`verifyPasskeyRegistration()`): the
  type, the challenge, the origin, the relying party, user presence, user verification, that the
  credential id the answer names is the one the authenticator attested, and that the key is ES256
  or RS256 (an RSA key of at least 2048 bits). A credential id is enrolled once, to one admin.
- **A removal is signed by one of the caller's own passkeys**, the one removed or another, over a
  challenge that ends with the SHA-256 of the credential id removed
  (`beginAdminPasskeyRemoval()`, `removeAdminPasskey()`), so the passkey signs which passkey goes.

Each change is a setting record, written before the change (see
[Setting records](#setting-records)).

**An admin removes only their own passkeys**, at most ten of which they can hold
(`MAX_ADMIN_PASSKEYS`). Nobody removes another admin's, so one admin's session cannot strip the
others of theirs. Every admin sees every passkey in the list (`listAdminPasskeys()`): its
credential id, its admin, its name, when it was enrolled and when it last confirmed something.
The public key never leaves the server.

The limit is checked before a passkey is made (`beginAdminPasskeyEnrolment()` gives an admin who
holds ten no challenge, and the panel offers them no enrolment) and again when it is enrolled.
Together with the rule that a removal is signed by one of the admin's own passkeys, it has one
dead end: **an admin who holds ten passkeys and can sign with none of them can neither enrol
another nor remove one**, and no other admin can do either for them. That account approves nothing
from then on, and its ten stay listed. So remove a passkey whose authenticator is going away while
another can still sign for it.

A passkey is bound to the host name it was enrolled on. After `PUBLIC_BASE_URL` moves to another
host, the passkeys enrolled before it sign nothing there, a removal included, though they still
count towards the ten: an admin with a place left enrols one on the new host and removes the old
ones with it, and an admin who holds ten cannot until the variable points back. Remove the old
ones before the move.

**A former admin's passkeys stay stored and listed, and approve nothing.** A passkey confirms only
through a session of the admin it belongs to, and an account outside `ADMINS` gets no admin
capability. They work again if the account is made an admin again: re-adding an account to
`ADMINS` also restores its passkeys.

The keys are ES256 or RS256, and no attestation is asked for or checked (see
[Why a second factor, and what it is worth](#why-a-second-factor-and-what-it-is-worth)). Passkeys
are stored by `AdminSettings` outside `AdminConfig`, and so outside its KV mirror, as
authentication material.

None of the six ceremony methods (`beginAdminPasskeyEnrolment`, `addAdminPasskey`,
`beginAdminPasskeyRemoval`, `removeAdminPasskey`, `beginWorkspaceWriteApproval`,
`approveWorkspaceWrite`) is a `cf-os api` command or in the declarations an agent is given. That is
a convenience, since neither can drive an authenticator, and not the boundary: the boundary is the
assertion the server verifies.

**While writes are off** no passkey approves anything and none can be enrolled. Those already
enrolled are still listed (the Access tab shows the card whenever one exists) and can still be
removed by their own admins.

### If a passkey was enrolled by someone else's hands

A passkey in the list that its admin did not enrol means someone else held that admin's session.
In this order:

1. **End the account's admin access**: take it out of `ADMINS`, or secure the account before
   anything else. A passkey confirms nothing except through a session of the admin it belongs to,
   so this is what stops it. Removing the passkey first achieves nothing: a session that could
   enrol one passkey can enrol another.
2. **If it is unclear which account, set `ADMIN_WORKSPACE_WRITES` to `off`.** Every approval stops
   at once, whatever is enrolled. A content grant that an approval already gave stays live: end
   it with `endWorkspaceGrant()`, which works while writes are off (see
   [Asking for content without the owner](#asking-for-content-without-the-owner)).
3. **Read the audit log.** The `addAdminPasskey` record gives the session that enrolled the
   passkey, and every `"approved"` and `"refused"` write record names the passkey that signed, so
   the writes it approved can be listed.
4. **Have the account's owner remove the passkey**, once the account is secure and an admin again.
   A passkey can be removed only by the admin it was enrolled under, signing with a passkey they
   hold themselves: no other admin can remove it. Removal works while writes are off. An owner
   with no passkey of their own enrols one first, which needs writes to be on and a place under
   the limit of ten.
5. **If the account was left ten passkeys, none of them its owner's**, the owner can enrol none
   and so remove none, and nobody else can. Keep that account out of `ADMINS` for good, and make
   its owner an admin under another account. The ten stay stored and approve nothing.

Until then the foreign passkey stays listed and does nothing. A removed account's passkeys stay
stored and inert, and are live again only if the account is made an admin again. That is the
moment by which the account must be secure, since a passkey is usable only through a session of
the account it was enrolled under.

### Why no library

The browser hands over everything the server needs already decoded (the public key as DER
`SubjectPublicKeyInfo`, its COSE algorithm number and the raw authenticator data), and no
attestation is asked for, so there is no CBOR and no X.509 to parse: what is left to check is the
client data, the authenticator data's fixed part and one WebCrypto signature, in a module
(`webauthn.ts`) short enough to read line by line, where a library would bring more code into the
kernel than the checks it replaces. The public key kept is the one the browser reports, not
compared with the authenticator data's copy, since nothing signs a registration without
attestation: both are whatever the enrolling session presents, and what binds a passkey is that
every later assertion must verify under that key.

## Through an agent

A deployment admin can give the agents of a workspace they own this API, through the admin
gatekeeper (`packages/gatekeeper-instanceadmin`, vendor `instanceadmin`). The gatekeeper is part
of every deployment, with its mode Disabled until an admin chooses another; only deployment
admins hold its account, and its holder adds its connection ("Deployment admin") to the
workspaces that need it. Its design record is
[the package's README](../packages/gatekeeper-instanceadmin/README.md).

**What an agent can do.** Every `AdminApi` method has one kind (`ADMIN_AGENT_KINDS`; the
[README's table](../packages/gatekeeper-instanceadmin/README.md#what-each-kind-does) lists
them):

- **Read**: the listings, the settings getters, the audit log and its statistics, issue reports
  with their threads and images, a write request, `inspectWorkspace()` and `inspectUser()`
  with every method of the view each returns, and `whoami()`, which names the workspace's
  owner: the admin every call through the binding is made as. A read runs at once. A
  workspace's view reads metadata, and content only as [Each call](#each-call) decides for any
  admin: the gatekeeper adds no way round a grant. A view of a user's account reads metadata
  alone (see [User inspection](#user-inspection)).
- **Act**: an entry in a report's thread, a report's status, claiming or releasing a report,
  and a write request. The call is queued as an action of the workspace and runs once a member
  approves it, or a rule does where the kind allows one. A public reply through the binding
  always waits for a person, and so does a request for content access. A claim and a release
  are one kind of action, for the workspace's owner, whoever in the workspace asked: a claim
  makes the owner the report's assignee and is refused where another admin holds the report. It
  is never a take-over, which only a person makes, from the holder they name (see
  [issue-reports.md](issue-reports.md#the-assignee)). An action refused where it lands, such
  a claim included, stays pending until a person rejects it, and the connection's later
  actions wait behind it (see [its limits](issue-reports.md#limits)).
- **Omitted**: every setter, every passkey method, approving or denying a write request, ending
  an admins' grant, and setting a report's links. They are absent from what the agent is told
  and refused.

From the binding, code can also open a session limited to one issue report, which reaches that
report as its reporter reads it and the reporter's workspace as the reporter chose to show it
(see [Opening for content](#opening-for-content)), and subscribe to three hooks: a report
filed, an investigation ended, and every write to a report after it was filed (see
[issue-reports.md](issue-reports.md#hooks)).

**Every call is the workspace owner's.** The gatekeeper Worker holds no credential: the workspace
lends it its owner's Admin API, and each call is checked and recorded as any admin's is, with
`via: "gatekeeper"` and where it came from.

**The lend.** A session is lent the read methods for at most `ADMIN_AGENT_LEND_SECONDS` (15
minutes), and a view it opens ends with it. An approved action is lent one call, of a method its
kind names. The Workshop asks at each lend whether the owner still holds the account, and before
every call whether the owner is still a deployment admin and the gatekeeper is still turned on.

**The workspace admits only deployment admins.** While a workspace has the connection, nobody
but its owner and users who are deployment admins at that moment can open it, in any role or by
any share link; other admins may collaborate there and decide its pending actions. Once the
workspace has read anything through the whole binding it stays so for good, with or without the
connection, because its chats hold what was read.

**Reads mark the workspace as holding restricted data.** Every read through the whole binding
sets the platform's restricted-data latch on the workspace, in this version. From then on web
fetches reach only the hosts the deployment trusts, a push is refused, and every action waits
for a person, but for the three kinds a rule still applies there (below). A report session's
reads do not mark, with one exception: its view of a reporter's workspace that itself holds
restricted data marks the workspace that reads it, without closing it for good. A hook's event
that tells what a report's reporter is not shown marks the workspace that receives it as a read
through the whole binding does, for good; a new report and a public reply mark nothing (see
[issue-reports.md](issue-reports.md#hooks)).

**What a rule applies in a marked workspace.** A rule applies an action there only when all
three of these hold:

- **The action is of the admin gatekeeper's connection.** The Workshop reads the vendor from
  its own record of the connection, never from a tag or anything else a Worker declares.
- **Its kind is an admins-only note, a change of status or an assignment** (a claim or a
  release): the three kinds the kernel's own table, `ADMIN_AGENT_ACTIONS`, flags
  `autoApprovableWhileRestricted`.
- **Every observation that marked the workspace came through that connection.** A report
  session that carries the mark of a reporter's workspace counts: it is that connection.

What the workspace holds is then what deployment admins can already read, and admins are who
reads a note and an assignment. A status is read by the report's reporter too, which
[issue-reports.md](issue-reports.md#limits) states among its limits.

Everything else waits for a person there:

- **A public reply**, through the whole binding or through a session limited to one report,
  **and both write requests.**
- **Every action of a workspace that also read another vendor's restricted data**, before the
  admin connection's reads or after them: other admins could not already see that data. Nothing
  makes such a workspace exempt again.
- **Every action of a workspace marked before workspaces kept track of whose reads marked
  them.**
- **Every action of any other connection.** No rule applies one in a marked workspace.

Web fetches are held and a push is refused as in any marked workspace. The exception is the
kernel's: nothing in a gatekeeper's declarations asks for it, and no other vendor can have it.
The Workshop reads the answer for each kind from the workspace
(`PreApprovableAction.ruleApplies`). In a marked workspace "Always approve" is offered, and the
Auto-approval tab lets a rule be turned on, only for the kinds one still applies there; a rule
that applies nothing says so in the tab and can still be turned off.

**Where the person behind a call is found.** Every record names the owner, so:

- for an agent's turn, the chat the record names says who prompted it;
- for an approved action, its record in the workspace says who decided (`resolvedBy`);
- for a session opened directly from the connection, it is the owner: no other member is lent
  one, and no other member's queues an action, which a rule could apply with nobody deciding.

A slash command is not among them: this gatekeeper has none.

**What the audit log holds of an agent.** View opens and view calls, of a workspace and of a
user's account, and write requests carry `via: "gatekeeper"` and the origin (`agent`). Listings
of users, workspaces, reports, settings and the audit log itself, and reading a report or its
image, leave no audit record, for an agent as for any admin: their only trace is the observation
in the activity of the workspace that called, which goes with that workspace. A report entry, a
status or a change of assignee an agent made is recorded in the report's thread.

**Removing the account.** Disconnecting the deployment admin account from Connectors ends every
connection made with it, in every workspace its holder owns, at the next session, action or hook
firing, and adding it again restores them. In mode Enabled it cannot be removed.

**Limits**, each described in the README:

- [The split of the two reply kinds and the restricted-data mark are the gatekeeper Worker's
  own declarations](../packages/gatekeeper-instanceadmin/README.md#what-a-worker-that-keeps-everything-could-do):
  they hold against agents and gadgets, not against the Worker.
- [Non-admins admitted again after the connection is removed read what report sessions left in
  the chats](../packages/gatekeeper-instanceadmin/README.md#what-the-non-admins-who-come-back-can-read).
  When an admin reports their own workspace that read through the whole binding, and grants its
  content, that is what the whole binding answered there: the workspace that triages the report
  is marked as holding restricted data, and is not closed for good.
- [The latch does not hold back reads through the workspace's other
  connections](../packages/gatekeeper-instanceadmin/README.md#what-the-latch-does-not-hold-back).
- [What a report session reads of an ordinary reporter's workspace, under the reporter's grant,
  lands in a triage workspace that is not
  marked](../packages/gatekeeper-instanceadmin/README.md#what-an-unmarked-triage-workspace-holds).
  Its web fetches and the rule-applied actions of its other connections are not held, and a
  report's text can steer an agent to send that content out. So a triage agent is given no
  other connection, and the triage workspace holds none its owner would not send a reporter's
  content to.
- [An agent finds the write request it filed through the audit
  log](../packages/gatekeeper-instanceadmin/README.md#limits): the call that files it returns
  nothing.

## Access levels and their bounds

### The levels

`adminWorkspaceAccess` is `"off"`, `"metadata"` (the default) or `"content"`, in increasing order
(`ADMIN_WORKSPACE_ACCESS_LEVELS`). One setting and one cap govern both inspections, of a workspace
and of a user's account:

- **off**: `inspectWorkspace()` and `inspectUser()` are refused.
- **metadata**: the workspace's structure. Withheld: chat messages and queued steers, chat
  attachments, file contents (at any commit, and pending in a chat), commit messages, the
  arguments of calls queued for an agent, the configuration an agent suggested for a connection
  (`creationSpec.configuration`), which blueprint a gadget follows (`upstream`, a share
  link to code the view withholds), the ids of the blueprints the workspace publishes (an id is a
  share link to the blueprint's code, as `upstream` is), and the descriptions and fields of
  actions, observations and hooks. Kept: titles (of the workspace, chats, gadgets, actions and
  resources), collaborators with the notes on their grants, observer records and their account
  ids, connections with their resource URLs and who created each, file names and changed paths,
  commit ids, authors and times, attachment names, types and sizes and each attachment's `oid`,
  share links' notes, blueprint titles and descriptions, and diagnostics. Titles, names, notes and
  a blueprint's description are written by members and agents and can echo content, restricted
  data included. A blueprint's description is kept, where the description of an action, an
  observation or a hook is withheld.
  - An attachment's `oid` is a hash of its bytes, which `listChatAttachments()` returns: it does
    not give the bytes, and it does tell whether two attachments are the same file, or the file a
    reader already has.
  - Commit messages are content: `getCommitLog()` empties them, where commit ids, authors and
    times show.
  - The level covers every commit the workspace stores, the ones a connection supplied included
    (a worktree's checkout): that repository's file names, commit ids, authors, times and changed
    paths, read from the workspace's copy and never by asking the connection (see
    [Inspection](#inspection)).
  - Of a user's account, the level shows what the account itself records: its profile,
    workspaces, connected accounts, models, sign-in sessions, blueprints and diagnostics.
    Withheld: connected accounts' descriptions (what each gatekeeper says of its account: its
    names, avatar, granted resource types and what it provides) and blueprints' ids (an id is a
    share link to the blueprint's code, as a workspace's is). What an account stores as a
    credential is never returned (see [User inspection](#user-inspection)).
- **content**: what `"metadata"` shows, and what it withholds of a workspace too, but only under a
  live grant on that workspace (see [Grants](#grants)) and only through a view opened for content.
  Without a grant, `"content"` shows what `"metadata"` shows, and of a user's account it never
  shows more. No level shows content without a grant.

[What the metadata level withholds](#what-the-metadata-level-withholds) lists per method what
`"metadata"` withholds, which is what a grant adds at `"content"`.

**Content is off by default.** A deployment whose admins never chose a level is at `"metadata"`,
and with `ADMIN_WORKSPACE_ACCESS_MAX` unset the cap is `"metadata"` too. Content can be granted
and read only where the level in force (the admins' choice held to the cap, as
`adminAccessPolicy()` computes it) is `"content"`, which takes two decisions: the operator raises
the cap, and an admin chooses Content in the admin panel. Raising the cap alone changes nothing an
admin can read; choosing Content alone is refused while the cap is below it.

Below `"content"`:

- the Report issue dialog offers no content grant;
- `grantAdminAccess()`, `renewAdminAccess()` and the account-wide grant are refused
  (`contentOff`);
- no approval can be requested: `"grantContentAccess"` is refused at the request (`contentOff`);
- a view cannot be opened for content (`contentOff`);
- a grant that is already live reads nothing until the level is `"content"` again: the level is
  checked on every call, before the grant.

A value that is not a level, wherever it is stored or configured, reads as `"off"`: a stored one
until an admin chooses a level (`getSettings()` reports it as `chosen: "off"`), a configured one
until the variable is corrected.

**What a member's client learns.** A member's client must know whether content can be granted, to
show or hide the option, and nothing else about the admin configuration. It reads one fact from
the channel the Workshop already reads deployment-wide facts from: `ServerConfig.adminContentGrants`,
present while the level in force is `"content"`. The server decides all the same: a grant asked
for while it is absent is refused.

### The environment's bounds

Three backend variables bound what admins may choose. They are environment variables for the
reason authentication config is (`auth/config.ts`): a compromised admin session must not be able
to widen them. A fourth, `ADMIN_WORKSPACE_WRITES`, is a switch with no admin setting under it, and
an environment variable for the same reason.

| Variable | Values | Default | Effect |
| --- | --- | --- | --- |
| `ADMIN_WORKSPACE_ACCESS_MAX` | `off`, `metadata`, `content` (any case, trimmed) | `metadata` (unset or blank) | The highest level admins may choose. `off` turns inspection off whatever admins choose. `content` is needed before any grant can be given or used: it lets admins choose Content, at which a workspace's content is read only under a live grant. A value that is not a level is `off`, logged as an error: it bounds a security setting, so `none`, `false` or a typo of `off` must fail closed, never grant the default. |
| `ADMIN_AUDIT_RETENTION_MIN_DAYS` | a positive whole number of days, at most 3650 (`MAX_ADMIN_AUDIT_RETENTION_DAYS`); a larger value counts as 3650 | 90 (unset, blank or invalid; an invalid value is logged) | The fewest days the audit log keeps a record, whatever admins choose. |
| `ISSUE_REPORT_RETENTION_MIN_DAYS` | a positive whole number of days, at most 3650 (`MAX_ISSUE_REPORT_RETENTION_DAYS`); a larger value counts as 3650 | 90 (unset, blank or invalid; an invalid value is logged) | The fewest days an [issue report](issue-reports.md#retention) is kept, whatever admins choose. |
| `ADMIN_WORKSPACE_WRITES` | `on`, `off` (any case, trimmed) | `off` (unset or blank) | Whether admins may request and approve [writes](#writes) to workspaces. Any other value is off, logged as an error, so `true`, `1` or a typo of `on` never enables them. |

The admins' choice is kept in `AdminConfig` as they set it, and `adminAccessPolicy()` holds it within
the bounds wherever it is enforced: `inspectWorkspace()`, `inspectUser()`, every view call, the
grant methods, a `"grantContentAccess"` request and its applying, the settings audit, the audit
log's own floor and the issue reports' deletion. `getSettings()` reports `chosen`, the bound
(`max` or `min`), and `effective`, which is what is enforced. The setters refuse a value outside the
bounds, naming the variable; a choice stored before a bound tightened is kept but not enforced.
`setAdminWorkspaceAccess()` refuses a value that is not a level, storing and recording nothing.

`ADMIN_WORKSPACE_WRITES` has no choice under it: `getSettings()` reports it as
`adminWorkspaceWrites`, true or false, and no setter changes it. `adminWorkspaceWritesEnabled()` is
the only code that reads the variable: `AdminApiImpl` asks it before every write-request and
enrolment method, `AdminSettings` asks it again before it takes a request, a denial, an approval
or an enrolment, and the workspace asks it once more before a write runs. Each asks its own
environment, and each checks that the caller is still in `ADMINS` the same way, so a session whose
Worker started with an older config is held to the current one. Writes also need
`PUBLIC_BASE_URL`, the origin of the Workshop's own pages: it is where a request is approved, and
the origin and relying party every passkey is bound to (`originUnset` without it). The switch is a
bound of its own: neither the cap nor the level admins chose holds a write back, except
`"grantContentAccess"`, which also needs the level in force to be `"content"`.

**The cap costs an approver something.** Where the access level is `off` no inspection can show
what a chat or connection id names, so a write that names one is approved on the requester's word,
and the approval page says so instead of pointing at an inspection that would be refused.

### Setting the bounds

All four are variables of the backend Worker (`workshop-backend`):

- **Locally** (`pnpm run-local`, `pnpm dev-server`): set them in the shell or in the root
  `.dev.vars`; `scripts/run-dev-server.ts` passes all four through to the backend, for example
  `ADMIN_WORKSPACE_ACCESS_MAX=content pnpm dev-server` or
  `ADMIN_WORKSPACE_WRITES=on pnpm dev-server`.
  It sets `PUBLIC_BASE_URL` to where it serves the Workshop when the variable is unset, so a
  passkey enrolled locally is bound to that `localhost` origin. A local instance has one admin,
  `admin`, and an approval of content access needs two: `ADMINS` in the shell (comma-separated
  usernames) replaces that list, so `ADMINS=admin,grace pnpm dev-server` gives a second admin.
  That is for local development only; no deployment path reads the shell's `ADMINS`.
- **Your own `wrangler deploy` or workerd config**: the backend Worker's `vars`.
- **Deploy tools that write the backend's variables themselves** (the online deploy flow and the
  deployment starter's `cf-os deploy`, both linked from the [README](../README.md#get-started)):
  they replace the Worker's variables on every deploy, so a value set in the Cloudflare dashboard
  lasts only until the next deploy, and until such a tool carries these variables its
  deployments run with the defaults. Any redeploy that writes its own variables must carry all
  four.
- **Pull request previews** (`scripts/preview/staging-config.ts`): `ADMIN_WORKSPACE_WRITES` is `on`
  and `ADMIN_WORKSPACE_ACCESS_MAX` is `content`, so that writes, their passkeys, grants and
  content reads can be tried there. A preview's passkeys are bound to that preview's host. The
  two retention floors keep their defaults.

**The issue reports' floor** works as the audit log's does. `ISSUE_REPORT_RETENTION_MIN_DAYS` is
the fewest days a report is kept from its filing, whatever admins choose;
`setIssueReportRetentionDays()` refuses fewer, naming the variable, and `getSettings()` reports
`issueReportRetentionDays` as `chosen`, `min` and `effective`. A retention an admin chose below a
floor that is then raised is kept as chosen and held up to the floor wherever it is enforced.

### When a variable is dropped

- The cap falls back to `metadata`. A deploy that drops `ADMIN_WORKSPACE_ACCESS_MAX=off` therefore
  turns inspection back on, at the level the admins chose: `metadata`, unless they chose Off. A
  deploy that drops `ADMIN_WORKSPACE_ACCESS_MAX=content` puts the level in force back at
  `metadata` once it is live: no grant can be given or used, and a grant still live reads nothing
  unless the cap returns before the grant's end.
- The audit floor falls back to 90 days, and with it the retention actually kept wherever the
  admins chose less, which prunes the older records.
- The issue reports' floor falls back to 90 days the same way, and the reports older than the
  retention then in force are deleted by the store's next daily run.
- Writes go off. A pending request can no longer be approved, and expires. No passkey can be
  enrolled. The passkeys already enrolled stay stored and approve nothing; they can still be
  listed, and removed by their own admins.

So set what you want in the admin panel too: the admins' choices persist in the deployment's
settings across deploys, while a variable only bounds what an admin session can choose.

- **To keep inspection off**, also choose Off as the Audit tab's access setting: the variable only
  stops an admin session from turning inspection on.
- **To keep a retention**, set it in the Audit tab: the floor only stops an admin session from
  choosing less. The tab says when the floor is what holds retention up; it saves only a value
  that is typed, so type the number of days you want kept, even the minimum.
- **To keep a retention for issue reports**, set it in the Reports tab, for the same reason.

## The audit

### Four kinds of record

- **`AdminAccessRecord`** (`kind: "workspace"`): one admin call into a workspace, the open or a view
  method. It holds `at` (when the record was written), `admin`, `sessionId`, `via`, `agent` (for a
  call made through the admin gatekeeper, see below), `workspaceId`, the workspace's owner
  (`workspaceOwner`, resolved when the view opens; from the directory for an open refused before
  it reaches the workspace; a username is unbounded, so a long one keeps its start and a digest
  of the whole id, which keeps long ids apart), the workspace's title at the time, `method`, the
  call's arguments by name, the `reason` given at the open, what the view was opened for
  (`requested`), the deployment's `access` level when the call ran (`"off"` for a call refused
  for that), what the call's answer exposed (`exposed`, see
  [What a call exposed](#what-a-call-exposed)), the grant the call was made under (`grantId`,
  whatever the grant's source: present when the call was allowed content, whether or not its
  answer held any), and `refused`, the code a refused call was refused with: `accessOff`,
  `contentOff`, `contentNotRequested` or `grantRequired`.
- **`AdminUserAccessRecord`** (`kind: "user"`): one admin call into a user's account, the open or a
  view method. It holds `at`, `admin`, `sessionId`, `via`, `agent` (for a call made through the
  admin gatekeeper, see below), the user whose account it is (`userId`, by canonical user id,
  kept as `workspaceOwner` is: a long one keeps its start and a digest of the whole id; for an
  open refused before it reaches the account, the id the admin gave), `method`,
  the `reason` given at the open, its own `access` (`"metadata"`, or `"off"` for a call refused
  for that: a view of an account answers with metadata alone, whatever level is in force) and
  `refused` (`accessOff` alone), and its own `args`: only the open records one (`expiresAt`),
  since no user view method takes an argument. It carries no `requested`, `exposed` or `grantId`.
- **`AdminSettingRecord`** (`kind: "setting"`): one `AdminApi` setter's change. It holds `at`,
  `admin`, `sessionId`, `via`, `method`, and `changes`, each naming a setting, an entry `key` for a
  map or list setting, and its value `before` and `after`.
- **`AdminWriteRecord`** (`kind: "write"`): one step in the life of a write request. It holds `at`,
  `admin` (whose step it is), `sessionId`, `via`, `agent` (on the `requested` and `expired` steps
  of a request an agent filed), the `requestId` its steps share, the `event`,
  `workspaceId`, the workspace's owner and title (as the workspace itself gives them for
  `"approved"` and `"revoked"`, as the directory listed them when the request was made for the
  other steps),
  `method` (the action, named as on the other records so that one filter covers every kind), the
  request's `args` by name, its `reason`, `requestedBy`, and, where the step has one, the
  `passkey`, the `refusal`, the `outcome`, the `error`, the `grantId` or the `endReason`. The
  eight events:

  | Event | Step | Whose (`admin`) | Recorded |
  | --- | --- | --- | --- |
  | `requested` | An admin asked for the write. | The requester | Before the request is stored. |
  | `refused` | An attempt to approve was not accepted (`refusal`): the answer failed a passkey check, the request was no longer pending, or the requester, or anyone who was in the workspace an agent's request was filed from, tried to approve a request that needs a second admin (`"requester"`). | The admin who tried | When it is refused. |
  | `approved` | An admin confirmed it with a passkey (for `"grantContentAccess"`, with the `grantId` of the grant it gives). | The approver | By the workspace, before it changes anything. |
  | `applied` | The workspace ran it (`outcome`, when it reports one: for `"grantContentAccess"`, the grant's id and when it ends). | The approver | After the fact, at least once. |
  | `failed` | The workspace refused it or failed to run it, or its answer never arrived (`error`). | The approver | After the fact, at least once. |
  | `denied` | An admin denied it. | The denier | Before the denial is stored. |
  | `expired` | It ran out unapproved, or its requester stopped being an admin first (`error`). | The requester | Before the expiry is stored. |
  | `revoked` | For `"grantContentAccess"` only: an admin ended the grant the request gave, before its time (`grantId`, `endReason`; `reason` stays the requester's). | The admin who ended it | By the workspace, before the grant is ended. |

  `passkey` is the credential id of the passkey behind the step, as the setting record of its
  enrolment keys it: for `approved`, `applied` and `failed`, the one whose assertion approved the
  request; for `refused`, the one the answer named, when it is one of that admin's own, whether or
  not it signed the answer. A `"revoked"` record carries none.

**`via` and `agent`.** `via` is `"api"`, `"cli"` or `"gatekeeper"`. The first two come from the
session's User-Agent, the client's own claim. `"gatekeeper"` marks a call made through the admin
gatekeeper's connection of a workspace the record's admin owns, and such a record carries
`agent` (`AdminAgentOrigin`): the workspace whose connection made the call and, when the
workspace ties the caller to one, the chat. Only the workspace sets them, when it lends the
gatekeeper its owner's Admin API (`OverseerImpl.lendAdminApi()`): no client, header, argument or
gatekeeper Worker can claim the value or set the workspace or the chat. They name the lend the
call was made on; that the gatekeeper used each lend for the caller it was made for is the
gatekeeper's word (see
[its README](../packages/gatekeeper-instanceadmin/README.md#what-a-worker-that-keeps-everything-could-do)).
An access record, of a workspace or of a user's account, and a write record can carry them. A
setting record never says `"gatekeeper"`: no setter is open to an agent. The Audit tab names
such a record's `via` "Agent" and shows the workspace and the chat
it came from.

**There is no kind for grants.** The log records what admins do, and an owner's grant is the
owner's own record (see
[An owner's grant is the owner's own record](#an-owners-grant-is-the-owners-own-record)): giving,
renewing and ending one, and its expiry, append nothing. What admins do about a grant is carried
by the kinds above: the steps of a `"grantContentAccess"` request and the `"revoked"` step are
write records, and every call made under a grant, of either source, is an access record with the
grant's id.

`listAdminAudit()` filters by kind, admin, method, workspace, the user a call's or a write's target
belongs to (`owner`), what a call exposed (`exposed`) and time; `getAdminAuditStats()` by kind.
`exposed: "content"` lists the content reads, which only calls into a workspace can be;
`exposed: "metadata"` lists every other call into a workspace and every call into a user's
account, which answers with metadata alone; no setting or write record matches either. The method
and that user stay in a record's JSON, each read through an index on its `json_extract()`. The
owner filter covers a
workspace's owner and an inspected user through one index, on the record's `userId` or else its
`workspaceOwner` (`admin_audit_target`), so it lists the calls into a user's account together with
the calls into, and the writes to, the workspaces they own. The two views share three method names
(`describe`, `listBlueprints` and `getDiagnostics`), whose records `kind` tells apart. A write
action shares its name with no other record's method, so a method filter by one lists every step
of the requests for it and nothing else. A method no record type names is refused
(capnweb-validate checks it against the method union); one that no logged record has gives an
empty page.

The store's table admits exactly these kinds, by a CHECK on its `kind` column, and its `exposed`
column holds what an access record's answer exposed (`'metadata'` for every call into a user's
account) and nothing for a setting or a write record. SQLite cannot alter a CHECK, so
a table whose stored definition differs from the current one is rebuilt once, when the log's
Durable Object next starts: its rows are copied into a table of the current definition, each
keeping its `seq`, and the table goes on numbering from the highest `seq` it ever issued, a pruned
record's included, so a list cursor held across the rebuild stays valid. A rebuild that fails, as
it does on a table of a later definition holding rows of a kind this CHECK refuses, rolls back
whole: it leaves the stored table with its rows, is logged (`admin.audit.table.rebuild.failed`),
and the log goes on appending the kinds that table admits.

### What the metadata level withholds

Without a grant, every answer is what the `"metadata"` level shows (see
[The levels](#the-levels)). The methods that read a record holding content return it with that
content left out or emptied, and the others read nothing the level withholds. What the last
column lists is what a live grant adds, on a view opened for content while the level in force is
`"content"`: the seven mixed methods (`describe()`, `listChats()`, `getChatState()`,
`listActions()`, `getCommitLog()`, `listGatekeepers()`, `listBlueprints()`) then return it in
place, and the rest (messages, an attachment's bytes, files) comes from
[the five content reads](#the-five-content-reads):

| Call | Returns | Withholds |
| --- | --- | --- |
| `describe()` | The workspace's id, title, cost, restricted-data flag, sharing policy and default gadget, its owner's profile, its workpieces and its collaborators, with what the view was opened for (`access`), the live grants the workspace stores (`grants`) and the view's expiry | Each gadget's `upstream`, which names the blueprint it follows |
| `listChats()` | The chats as a member's `listChats()` lists them, titles included | `queuedSteers`, which hold message text |
| `getChatState()` | The recorded agent turn, the time of the chat's newest entry, the ids of its pending actions, and each queued call's id, method and model | Each queued call's arguments |
| `listChatAttachments()` | Each attachment's id, name, type, size and `oid`, with its message's sequence | The bytes, which a stored reference can hold |
| `listActions()` | The action log's entries with their titles, states, resources, times and `autoApprovable` verdicts | Each entry's `description.description`, and the `description.fields` of an action or an observation |
| `listFiles()` | The names in the tree at a gadget's committed head | Nothing: it reads trees, never a file |
| `getCommitLog()` | Each commit's id, parents, author and time | Each `message` |
| `listFilesAtCommit()` | The names in the tree at a stored commit | Nothing: it reads trees, never a file |
| `listChangedPaths()` | The paths that differ between two stored commits | Nothing: it compares trees, never a file |
| `listPendingChanges()` | Per workpiece, the pin's commits and the paths the chat added, modified and removed | The files: it folds the chat's content to compare it, and returns paths alone |
| `listGatekeepers()` | Each connection's resource title and URL, vendor, creation spec, creator, bindings and hooks | Each hook's `description.description`, and a creation spec's `configuration`, which an agent wrote |
| `listObservers()` | The collaborators holding an observer record, with their account choices | Nothing |
| `listObserverRequirements()` | The connections a grant's recipient would have to pass | Nothing |
| `listShareLinks()` | Each link's id, note, creator, role, gadget or gadgets, and whether it is its creator's default link | Nothing: the listing holds no key that redeems a link |
| `listAutoApprovals()` | Each rule's connection, kind of action and who turned it on | Nothing |
| `listBlueprints()` | Each published blueprint's title, description, version and code date | Each `id`, and `screenshotUrl`, which holds the id |
| `getDiagnostics()` | Counts, the chats with an agent turn recorded, the storage's version and size, times and who is present | Nothing |

The open (`inspectWorkspace`) returns the view and nothing of the workspace.

The withholding helpers (`withholdChatContent()` and its siblings in `admin-access.ts`) are
applied to every answer unless `#call()` told the read that the call may return content. That
flag is the one condition a helper hangs on: no setting, no option and no test of the read's own
skips one. What is kept can still echo content, as [The levels](#the-levels) says of titles,
names, notes and blueprint descriptions.

[User inspection](#user-inspection) lists the same for each call into a user's account.

### What a call exposed

`ADMIN_METHOD_ANSWERS` (`admin-access.ts`) classifies every view method by what its answer can
hold: `"metadata"`, `"mixed"` or `"content"`. It is one table over every method of
`ADMIN_WORKSPACE_METHODS`, the open included, and `#call()` reads a method's kind from it and
from nowhere else, so a method added to the view does not compile until it is classified, and no
second list can disagree with it.

Each access record says what its call exposed:

| Call | `exposed` | `grantId` |
| --- | --- | --- |
| A `"metadata"` method, on any view | `"metadata"` | Absent: it never looks for a grant. |
| A `"mixed"` method without a grant (a metadata view, a level below `"content"`, or no live grant) | `"metadata"`: it answered withheld | Absent |
| A `"mixed"` method under a grant | `"content"` when the answer held something the `"metadata"` level withholds (a queued steer, a commit message, an action's description), `"metadata"` when it held none | Present |
| A `"content"` method under a grant | `"content"`, or `"metadata"` for an answer that holds none (an `absent` file) | Present |
| A `"content"` method without a grant | `"metadata"`, with `refused`: it read nothing | Absent |
| A call whose read failed | `"metadata"` | Present when it ran under a grant |

`exposed` is computed from the answer (the `...HoldsContent` predicates beside the withholding
helpers), not from the method's name, so a mixed call that returned no content under a grant is
not counted as a content read, and its `grantId` still shows that it was allowed one. A stream
counts as content whole, whether or not it is read to its end.

The store keeps `exposed` in a column of its table, for the filter and the statistics, and
returns it on every access record. `requested` is kept in the record's JSON; a record stored
without it reads `"metadata"`, which is what a view is opened for unless content is asked for. So
every access record the API returns carries both. A record of a call into a user's account
carries neither: its row holds `'metadata'` in the column, which is what the `exposed` filter
matches.

### Recorded before anything leaves

An access record is written to the deployment-wide `AdminAuditDurableObject`, and only then is the
answer returned. Nothing is written to the workspace, so `listActions()`, `subscribeToActions()`
and everything else a member reads can never show an inspection, a content read included. Nor is
anything written to an inspected account. If the write fails, the call fails and returns nothing.
A call refused for want of a grant, or because content was not asked for or is off, is recorded
the same way before it is refused.

A setting record is written to the deployment-wide log before the change is stored: a change whose
record cannot be written is refused.

A write record precedes its step wherever a step can wait for it. `"requested"`, `"denied"` and
`"expired"` are written before the request is stored in that state, `"approved"` by the
workspace before it changes anything, and `"revoked"` by the workspace before it ends the grant,
so a step whose record cannot be written is not taken.
`"applied"` and `"failed"` say what came of a run that has already happened, so they follow it,
and are retried until they are written (see [How a request ends](#how-a-request-ends)).
`"refused"` says of an attempt that it was refused, which no missing record can undo, so it
follows the attempt too: one that cannot be written is kept with the request and retried by the
sweep, the first ten a request. Unlike an
inspection, an approved write that changes a workspace is also written to the workspace, as an
entry of its action log; `"grantContentAccess"` writes nothing there
(see [Who sees a write in the workspace](#who-sees-a-write-in-the-workspace)).

An owner's grant calls append nothing to the log, and neither do the issue report methods (see
[issue-reports.md](issue-reports.md#what-is-recorded-where)).

### Which refusals are recorded

| Refusal | Recorded | Why |
| --- | --- | --- |
| A live view's call refused while the level is `"off"` (`accessOff`) | Yes, with `refused` | The admin reached the workspace or the account and asked for something. |
| A content read refused on a view opened for metadata (`contentNotRequested`), while the level in force is below `"content"` (`contentOff`), or without a live grant (`grantRequired`) | Yes, with `refused`, exposing `"metadata"` | The admin asked a workspace for its content. That includes a call refused because the owner's account could not be asked for its grant. |
| An open asking for content while the authoritative level is below `"content"` (`contentOff`) | Yes, titled from the directory (cut) or `""` | As for an open refused while the level is `"off"`: no workspace is reached. |
| A live view's call whose read throws (a missing object, a pending gadget, a malformed commit id, a commit that is not stored, a chat that does not exist, a legacy connection in a grant's scope) | Yes | The admin reached the workspace or the account and asked for something; the call returned only its error. A commit id is checked inside the read, so a malformed one is a failed read. |
| An open refused because the authoritative setting or the cap is `"off"` | Yes, titled from the directory (cut) or `""` | No workspace is reached, so its title comes from the directory. |
| An open refused because only the workspace's KV mirror still says `"off"` | Yes | The workspace's own check refused it. |
| An `inspectUser()` open refused because the authoritative setting or the cap is `"off"` | Yes, naming the id the admin gave | No account is reached, so the record keeps the id as given, whether or not it names an account. |
| An `inspectUser()` open refused because only the KV mirror still says `"off"` | Yes | The open is the view's first call, and the account's own check refused it. |
| A dead capability (no longer an admin), an expired view, a deleted workspace, a malformed or unknown workspace id, including a call that expiry, a demotion or a deletion overtakes while it reads | No | Nothing was reachable, or nothing the call read left the server, and recording a gone workspace would write into storage that must stay empty. |
| An `inspectUser()` open of an empty id, or, while the level is not `"off"`, of an id that names no account (`userNotFound`) | No | Nothing was reachable: no account is created, and there is none to record a call into. |
| A call whose arguments are rejected before it starts: a mistyped argument, `listActions()`'s invalid `beforeId`, `getCommitLog()`'s `depth` outside 1 to `MAX_ADMIN_COMMIT_LOG_DEPTH` | No | Validation refuses the call before the view's own checks run, as it refuses a mistyped argument: nothing was read, and the call asked for nothing a record could name (a depth of 0, a `beforeId` of -1). Only an argument rejected before the call starts goes unrecorded; a malformed commit id is checked inside the read, and is the failed read above. |
| Any write-request or passkey method refused `notAdmin` or `writesOff`: a request, and equally a read, a denial, a begun approval or an approval of a stored request, a pending one included, and a passkey listing, enrolment or removal | No | `AdminApiImpl` refuses the call before `AdminSettings`, which holds the requests and records their steps, is reached, and `AdminSettings` refuses a step the same way, from its own environment, before it reads a request or spends a challenge: no request was read, and nothing changed. That includes an approval of a pending request sent after writes were turned off. |
| A write request refused before it is stored for another reason (a rejected reason or argument, `contentOff` for `"grantContentAccess"`, `workspaceNotFound`, `originUnset`, `workspaceUnlisted`, `tooManyRequests`) | No | Nothing was stored, and no workspace was reached. |
| A refused attempt to approve a stored request, pending or not (`passkeyRefused`, `requestNotPending`, and `secondAdminRequired` for the requester's own approval) | Yes, as a `"refused"` write record with the check that failed | An admin tried to run a write. A failed passkey check, a replayed approval and a requester approving their own request for content are what an investigation looks for. |
| An `endWorkspaceGrant()` refused `notAdmin`, `workspaceNotFound` or `notFound` (an id naming no live grant with source `"admins"`) | No. One refused `notFound` only after its record was appended, because another admin ended the grant meanwhile, leaves that record | No grant changed. A record left behind is of the attempt. |
| An owner's grant call, refused or not (`grantAdminAccess()` and its siblings, the account-wide grant) | No | An owner's grant is the owner's own record: the log records what admins do. |
| An issue report method, refused or not | No | A report's thread is its own record (see [issue-reports.md](issue-reports.md#what-is-recorded-where)). |
| An attempt to approve an id that names no request (`requestNotFound`) | No | There is no request to record it against. |
| Beginning an approval (`beginWorkspaceWriteApproval()`), whatever the answer, and denying a request that is no longer pending | No | Beginning answers nothing: it issues a challenge or refuses to. A denial that finds nothing pending denies nothing. |
| A passkey enrolment or removal refused by a passkey check (`passkeyRefused`) | No, logged for operators. An enrolment refused only once its record was appended, because the same credential was enrolled meanwhile, leaves that record | No passkey changed, and the caller's own session is all that tried. A record left behind is of the attempt (see [Setting records](#setting-records)). |
| A request that is denied, that expires, or that fails once approved | Yes (`"denied"`, `"expired"`, `"failed"`) | Each ends a stored request, and `"failed"` may follow a change to the workspace. |

### Setting records

Every setter of a setting, `setIssueReportRetentionDays()` among them, is recorded before its
change takes effect. `AdminSettings.#mutateAdminConfig()`, which
serializes every `AdminConfig` write, is the chokepoint: each admin-facing mutator takes a
trailing `AdminSettingActor` (who, which session, `via`, and the `AdminApi` method), and the
chokepoint records `diffAdminConfig(current, next)` before `storage.adminConfig.put(next)`.

- Strings are recorded as themselves, and other values as JSON with object keys sorted. Own
  properties only: model maps legitimately hold `__proto__` and `constructor` keys.
- Maps (`banner`, `disabledResources`, `ambientGatekeeperModes`, `modelModes`, `modelSettings`,
  `modelOrder`) are recorded per key. Formats (by blueprint id) and added models (by model id) are
  recorded per entry, and a change to their order as one more change, without `key`, holding both
  lists of ids. `providerOrder` is recorded as one change, holding both lists.
- A value is kept whole up to `MAX_ADMIN_AUDIT_VALUE_LENGTH` (10,000) characters, more than any
  bounded setting holds (the agent instructions are at most 8000). Only unbounded inputs pass it;
  then both values become excerpts starting a little before their first difference, with the offset
  and both whole lengths, so a change hidden behind a long prefix still shows. A cut from the end
  would hide exactly the edits an audit exists to show.
- Three writes the diff cannot see are recorded explicitly before they happen: the site logo, as
  `"default"` or a logo's size and SHA-256 (never its bytes), which R2 keeps beside the logo, so
  uploading the logo already stored records nothing; a logo stored without its digest, before
  logos were recorded, is `"custom"`; featuring a blueprint, whose bit lives in its owner's
  user DO; and the enrolment and the removal of a passkey, since passkeys are stored outside
  `AdminConfig`. Each is recorded under the setting `adminPasskeys`, keyed by the passkey's
  credential id, as the admin it belongs to, its name and its algorithm (`after` for an
  enrolment, `before` for a removal), never its public key.
- A call that changes nothing records nothing (it is still written, since it may be a retry
  repairing the KV mirror). A record is kept if the change then fails, for example when the KV
  mirror write fails and the config is rolled back: it records the attempt.

Not recorded: reads (`getSettings`, `isBlueprintFeatured`, `getUpdateStatus`, `getWorkspaceWrite`,
`listAdminPasskeys`, the listings and the audit log itself), the passkey challenge calls
(`beginAdminPasskeyEnrolment`, `beginAdminPasskeyRemoval`, `beginWorkspaceWriteApproval`), the
gateway tests, `checkForUpdates`, the deployment's own promotion of its bundled formats, which
no admin made, and the issue report methods, the five that write to a report included
(`addIssueReportEntry`, `setIssueReportStatus`, `claimIssueReport`, `releaseIssueReport`,
`setIssueReportLinks`): a report's thread is its own record, of its entries, its status changes
and its changes of assignee; replacing a report's links keeps no author and no time.
`endWorkspaceGrant` is recorded, as a write record and not a setting record. A write-request
call first ends the requests that have run out, so a read such as
`getWorkspaceWrite` or a begun approval, though not recorded itself, can leave another request's
`"expired"` write record. An enrolment or a removal that a passkey check refuses records nothing
either; it is logged for operators. That holds for the checks made before the record is appended.
An enrolment is checked once more after it, and one refused there, because the same credential
was enrolled meanwhile (`passkeyRefused` too) or the admin reached the limit meanwhile, leaves its
record, which is of the attempt, as a change that fails after its record does.

### Text bounds

Arguments, workspace titles and setting keys are cut to `MAX_ADMIN_AUDIT_ARG_LENGTH` (256)
characters by `cutAdminAuditText()`, the last character replaced with `…` and never splitting a
surrogate pair: a record marks its cuts, never passing a fragment off as the whole. Reasons are
capped at `MAX_ADMIN_ACCESS_REASON_LENGTH` (500), values at 10,000 with excerpts, and a setter's diff
has a bounded number of changes, so every record, and every page of them, is bounded. A write
record's arguments and its `error` are cut as arguments are, and its reason is capped as an
inspection's is. A passkey's credential id, which keys its setting record and is a write record's
`passkey`, is the one key kept otherwise: an id over 256 characters (WebAuthn allows up to 1364 as
base64url) is kept as a long owner id is, as its start and a digest of the whole, which keeps two
passkeys apart.

The deployment-wide store keeps each field once (kind, time, admin, and an access record's
workspace id and title in columns, the rest as JSON) and cuts the title itself, whatever its caller
sent. The title is the one field of a record that a workspace member writes, and it has no length
limit of its own: kept whole, an over-long title would overflow the row (the platform caps one at
8 MiB), failing every audit write and so refusing every investigation of that workspace, or push a
listing past the RPC size limit.

The store's table keeps `exposed` in a column with an index (`admin_audit_exposed`): `append()`
writes an access record's `exposed` there, leaving it out of the JSON so that the field is stored
once, `metadata` for a record of a call into a user's account, and nothing for a setting or a
write record. The column is what the `exposed` filter and
`contentReads` read, and it is returned on every access record. An access record handed to
`append()` without `exposed` is stored as `metadata`: the log is one deployment-wide object, and a
workspace whose isolate still runs code that sends no such field, during a rollout, must have its
record kept; such a caller returns metadata only, so `metadata` is what its answer held. A value
that is neither is a `TypeError`, as for any malformed record.

A grant's `grantedBy` and `revokedBy`, and every user an issue report keeps, are bounded the same
way before they are stored (`namedUser()`): the id as a long owner id is, the name cut to 256
characters.

### Retention and pruning

The log keeps a record for the effective retention (`adminAuditRetentionDays`, default 90 days,
never below the floor). It deletes up to 1000 expired rows at the start of each call that passes the
committed retention, and never lists or counts one, and it holds the floor itself whatever retention
a caller passes. A view call's record passes none, since a view reads the KV mirror, whose retention
may be one an admin has since raised; the next listing, statistics read or settings change prunes.
The `"approved"` and `"revoked"` records a workspace appends pass none either; a write request's
other records pass the committed retention.

Grants lean on the same retention: an ended grant is kept at least that long before it is deleted
(see [The record](#the-record), with its one exception), by the retention its workspace or account
last read, which can trail a change an admin has just made. Nothing checks access against an ended
grant, so that is enough.

### Statistics

`getAdminAuditStats({ days, kind })` counts the last `days` UTC days, today included (7 by default,
at most 366): the total, one count per day (empty days included), and the ten admins with the most
records. An admin outside the top ten is not ranked there, but `listAdminAudit({ admin })` lists
every record of theirs, as `listAdminAudit({ workspace })` lists every call into a workspace. A
window reaching past the retention counts nothing there.

The statistics also count the writes approved in the window (`writes`: the write records whose
`event` is `"approved"`, so a request counts once, however many steps it recorded). Only write
records are writes, so `writes` is 0 for the other kinds.

They count the content reads in the window too (`contentReads`: the access records whose `exposed`
is `"content"`), which is 0 for the other kinds for the same reason.

The Audit tab shows the week's total, its count per day, its most active admins, its approved
writes and its content reads, each record's kind (Workspace access, User access, Workspace write,
Setting change), and each call's or write's target user (a workspace's owner, or the user whose
account was inspected) in a column of its own. A workspace access record carries a badge for what
it exposed, colored only for a content read, and, opened, what its view was opened for, the grant
it ran under and the refusal it carries. The tab filters its log by admin, action, kind,
workspace, target user and what a call exposed; the count of content reads opens the log filtered
to them. A write record shows its step beside its kind and, opened, its request, arguments and
reason, who requested it, and the refusal, passkey, grant, outcome, error or end reason it carries.
Its access setting offers Off, Metadata and Content, says what Metadata withholds of a workspace and
of a user's account and that Content is read only under a live grant, and, where the deployment's
cap is below it, that only `ADMIN_WORKSPACE_ACCESS_MAX` can allow Content.

## Error codes

Expected refusals carry a code from `ADMIN_ACCESS_ERROR_CODES` (read with
`getAdminAccessErrorCode()`), which survives Durable Object RPC and Cap'n Web:

| Code | When |
| --- | --- |
| `ADMIN_NOT_ADMIN` | The caller, or a view's admin, is no longer named in `ADMINS`. |
| `ADMIN_WORKSPACE_NOT_FOUND` | A malformed id, or one naming no workspace (never initialised or since deleted). |
| `ADMIN_USER_NOT_FOUND` | An empty user id, or one naming no account; a user view's call once its account is gone. |
| `ADMIN_WORKSPACE_ACCESS_OFF` | The level is `"off"`: by the setting, by the cap, or because either holds a value that is not a level. |
| `ADMIN_VIEW_EXPIRED` | The view's lifetime has run out. |
| `ADMIN_WORKSPACE_CONTENT_OFF` | The level in force is below `"content"`: an open asking for content, a content read on a view opened for it, an owner's grant or renewal, the account-wide grant, and a `"grantContentAccess"` request or its applying. |
| `ADMIN_CONTENT_NOT_REQUESTED` | A content read on a view opened for metadata. Inspect again, asking for content. |
| `ADMIN_GRANT_REQUIRED` | A content read with no live grant for the workspace: its owner can give one, or a second admin can approve a request for one. |

The grant methods refuse with a code from `ADMIN_GRANT_ERROR_CODES` (read with
`getAdminGrantErrorCode()`):

| Code | When |
| --- | --- |
| `ADMIN_GRANT_NOT_FOUND` | `renewAdminAccess()` for an id that names no live grant of the owner's on the workspace; `revokeAdminAccess()` for one that names no grant of the owner's there; `endWorkspaceGrant()` for one that names no live grant with source `"admins"`. An approval's grant is not the owner's, and an owner's is not an admin's to end. |

The write-request and passkey methods refuse with `ADMIN_NOT_ADMIN` and
`ADMIN_WORKSPACE_NOT_FOUND` too, and otherwise with a code from `ADMIN_WRITE_ERROR_CODES` (read
with `getAdminWriteErrorCode()`):

| Code | When |
| --- | --- |
| `ADMIN_WORKSPACE_WRITES_OFF` | `ADMIN_WORKSPACE_WRITES` is not `on`: every write-request and enrolment method, and a write its workspace is asked to run. Listing and removing passkeys still answer, and so does ending a grant. |
| `ADMIN_WRITE_ORIGIN_UNSET` | The deployment has no `PUBLIC_BASE_URL`, so there is no origin to approve a request on or to bind a passkey to. |
| `ADMIN_WRITE_WORKSPACE_UNLISTED` | A request for a workspace the directory does not list: its approval must show an owner. |
| `ADMIN_WRITE_WORKSPACE_CHANGED` | An approved write reached a workspace whose owner is not the one the request named, so it was not run. |
| `ADMIN_WRITE_REQUEST_NOT_FOUND` | No request has that id. A request is forgotten a day after it is resolved. |
| `ADMIN_WRITE_REQUEST_NOT_PENDING` | The request was approved, denied or has expired. |
| `ADMIN_WRITE_TOO_MANY_REQUESTS` | `MAX_PENDING_ADMIN_WRITES` (50) requests are pending across the deployment, or, for a request filed through an agent, `MAX_PENDING_AGENT_ADMIN_WRITES` (10) of those. |
| `ADMIN_WRITE_PASSKEY_REQUIRED` | An approval begun by an admin who has enrolled no passkey. |
| `ADMIN_WRITE_PASSKEY_REFUSED` | A passkey answer failed a check. The caller is not told which; a refused approval's record says (`refusal`). |
| `ADMIN_WRITE_SECOND_ADMIN_REQUIRED` | The admin who made a `"grantContentAccess"` request, or anyone who was in the workspace an agent filed it from, began or sent its approval, or the workspace was handed one: it must be approved by another admin. |

The issue report methods refuse with a code from `ISSUE_REPORT_ERROR_CODES`, listed in
[issue-reports.md](issue-reports.md#error-codes); the admins' also refuse with `ADMIN_NOT_ADMIN`.

## Tests

Unit suites, in `packages/workshop-backend/__tests__/`:

- `admin-access.test.ts`: admin status, the bounds' parsing (failing closed), the policy, validation
  (the commit log's depth included), the cuts, setting values and excerpts, and each withholding
  helper on a copy.
- `admin-config.test.ts` (`diffAdminConfig`) and `admin-settings-audit.test.ts`: what each setter
  records, before which write, and the setters' bounds: a value that is not a level refused,
  nothing stored or recorded, and a stored one reported as `"off"` until an admin chooses.
- `admin-audit.test.ts`: the deployment-wide log's listing, filters, cursors, schema (the CHECKs
  tying the workspace columns to records of access to a workspace, and `exposed` stored in its
  column for every access record, `metadata` for one handed over without it and for every call
  into a user's account, and null for the other kinds), retention, stats (per day, the top
  admins, by kind, the content reads), the method and target indexes (a workspace's owner and an
  inspected user through one), the `exposed` filter, multi-MiB titles, and `requested` reading
  `"metadata"` for a row stored without it. Records of access to users' accounts are listed by
  kind and by a method name both views share, keep a long user id as a long owner is kept, and
  are counted. The table's rebuild: a table that knows no user records, one that indexes the
  workspace owner alone, a current one left alone, the log of a build without content reads read
  with nothing copied and given a content read, and a later one kept, logged and still appended
  to.
- `admin-api-impl.test.ts`: `AdminApiImpl`'s inspection path, opens refused while access is off (by
  the setting or by a cap), the setter's validator refusing a value that is not a level with a
  `TypeError`, listings and forwarding. For `inspectUser()`: the order of its checks, an empty
  id, an open at `"off"` recorded with the id as the admin gave it, the terms the account is
  handed, and the session id it shares with `inspectWorkspace()`.
- `cli-admins-only.test.ts`: the `via` a session's User-Agent gives its records.
- `admin-view.test.ts`: `adminViewCall()`, the call discipline both views share: the order of its
  checks, its read of the setting, the read and the record before the answer; each call recorded
  with no retention, its read handed the level in force; a call refused and recorded while the
  setting or the cap is off or not a level, and answered again once the level is back at
  `"metadata"`; a refused call and a failed
  read recorded with nothing awaited since the last check; nothing recorded for a view no longer
  live; a record that cannot be written failing the call, with the method alone logged; and the
  environment read at each use.
- `admin-workspace-view.test.ts`: the view, from an uninitialised id that stays uninitialised to the
  per-call checks; every method recorded, each record stored with what it exposed in the table;
  what every answer withholds on a metadata view, beside the structure it keeps; a call
  refused and recorded while the setting is off, answered again once it is back at `"metadata"`,
  and refused while the cap or a stored level is not a level; the reads that fail recorded, and a
  depth out of range refused unrecorded; a failed record returning nothing; the races with
  deletion and expiry, at the setting read and while a call reads its answer, writing nothing; a
  2,000,000-character title; the live-session counts, one for each hold a collaborator has, by
  role; the reads that never pull (a gadget's head, history, changed paths, files at a commit,
  and a chat's pending changes with a worktree, a pending edit of a symlink failing without
  naming its target); the sharing reads never reaching a connection, a link to several gadgets
  among them; an inspection calling every method leaving the workspace's storage, presence and
  alarm as they were; and the view's surface being exactly what the audit names: every method in
  `ADMIN_WORKSPACE_METHODS` is recorded and classified in `ADMIN_METHOD_ANSWERS`, and the view
  class exposes no other member over RPC (a helper must be `#private`: the class's public
  members, not its interface, are its RPC surface). It also covers the grant step: the five
  content reads refused and recorded on a metadata view, below `"content"` and without a live
  grant, in that order; each mixed method answering withheld without a grant and with content
  under one, its record carrying the grant's id; a grant that ends while a view is open ending
  content on the next call; the account-wide grant asked for only by a call that would return
  content, its answer kept for a minute and checked by the workspace, and an account that cannot
  answer counting as no grant; files and attachments streamed; and a chat page with no inline
  image.
- `admin-user-view.test.ts`: the user view, from an id that names no account and creates none to
  the per-call checks; every method recorded and none refused, each record stored with `exposed`
  `metadata` in the table; what the answers withhold, shown first in what the user is served
  from; each answer whole, and no credential in any; a call refused and recorded while the
  setting is off, answered again once it is back at `"metadata"`, and refused while the cap or a
  stored level is not a level; a failed record returning nothing; and the case that holds the
  view to its seven reads, with the walk both views' suites share (`rpc-surface.ts`). Two steps
  show the wake:
  1. The read-only case opens views and calls every method, recorded and refused, on an account
     with both kinds of directory sync due, two gatekeeper accounts stored and an alarm set: its
     write count, stored values, alarm and directory entry stay as they were, no subscriber to
     its store is told anything, and neither gatekeeper account is called. It ends by evicting
     the account's object with nothing queued and inspecting it as it wakes, a view opened and
     every method called: nothing has been written since the wake, and its stored values, alarm
     and directory entry are what they were before it.
  2. The wake case evicts an account that has a notification queued and no alarm, and on the
     wake, with no view opened, sees the notification delivered and the alarm armed, and every
     stored record outside notification delivery's own unchanged (the sessions, workspaces,
     connected accounts, profile and directory state among them).
- `connection-creator.test.ts`: the creator stamped at each creation path, and absent on an ambient
  capsule and on a resource whose turn has no record; and which member sessions the live-session
  counts include: none of the owner's, a collaborator's by its role.
- `worktree-reroot.test.ts`: `listPendingChanges()` over a worktree whose pin an agent step
  re-rooted: listed against the commit it was re-rooted at, an edit made since folded onto that
  commit's text, agreeing with what an accept would apply, read from stored objects alone, and a
  reverted re-root listed against the earlier pin.
- `git-cache.test.ts` and `git-cache-history.test.ts`: the local readers against the pulling ones
  (a symlink named without its target, which the pulling read names), and a history whose parent
  is not stored.
- `worktrees.test.ts`: a chat's content folded from stored objects alone, failing rather than
  pulling when a base is not stored.
- `user-directory.test.ts`, `user-directory-feed.test.ts` and `workspace-directory-feed.test.ts`: the
  directory and both feeds. The last includes a deletion that parks a sync on a real call to another
  Durable Object and checks that the deletion still completes.

Writes add these, in the same directory. The passkey suites sign with a software authenticator
(`software-authenticator.ts`: WebCrypto keys held by the test), so every ceremony is a real one:

- `admin-access.test.ts` also covers the writes switch: off while unset, blank or `off`, on for
  `on` alone, and off for anything else, reported once and never with the value.
- `webauthn.test.ts`: the verifier, for ES256 and RS256. A registration and an assertion each
  accepted, and each refused for the wrong type, challenge, origin, a cross-origin frame, the wrong
  relying party, missing user presence, missing user verification, a malformed or over-long field,
  a challenge that differs only in the digest it ends with, another key's signature, a tampered
  signature, a replayed assertion and a counter that did not rise.
- `admin-writes.test.ts`: the arguments each action takes and refuses, the arguments as a record
  keeps them, the action log's title, and the digest an approval signs.
- `admin-passkeys.test.ts`: enrolment and removal through whole ceremonies, each recorded before
  it is stored; a challenge spent by its first answer; another admin's challenge, credential and
  passkey refused; nobody removing another admin's passkey; the limit; the races with a record
  being appended; a change whose record cannot be written; no `PUBLIC_BASE_URL`; listing and
  removal while writes are off; and the object's own check of the caller and the switch.
- `admin-write-requests.test.ts`: the request store. A request recorded before it is stored, the
  limit on pending requests, denial, expiry (by the alarm, by a read, once under concurrency, and
  ahead of time for a demoted requester), the alarm, and the object's own check of the caller and
  the switch.
- `admin-write-approval.test.ts`: the challenge bound to the request's digest; an approval
  spending the request once; every refusal recorded (a replay, a tampered request, another
  admin's credential, a former admin's passkey, a removed passkey, a denied or expired request);
  the races with a denial, an expiry and a second approver; a refusal's record owed while the log
  cannot be written; settling, with a closing record owed the same way; and a workspace that
  never answers.
- `admin-write-apply.test.ts`: `applyAdminWrite()` on a real workspace. The refusals that write
  nothing, each action running its one operation, a stop that keeps the queued messages, the
  record before the effect, a workspace deleted while its write runs, and the action log entry
  as the owner reads it and as a `use` session does not.
- `admin-api-impl.test.ts` also covers `AdminApiImpl`'s write and passkey methods: the checks
  before anything is touched, the directory's title and owner, and an approval that has the
  workspace run the write once and settles it.
- `admin-audit.test.ts` also covers write records in the log's listing, filters and statistics,
  and the rebuild of a table that knows no write records, which keeps every row, kind and
  sequence number and numbers on from the highest one issued, whatever was pruned.

Grants and content reads add these, in the same directory:

- `admin-grants.test.ts`: the pure parts. The one liveness rule (live until its end and not at
  it, not once revoked, not with an end that is not a valid time, not at another level), what
  counts as a live account-wide answer, a fresh grant keeping an id and a bounded name of its
  giver and nothing else of a profile, and when an ended grant can be deleted.
- `admin-owner-grants.test.ts`: the owner's four methods on a real workspace. Who may call them;
  giving, renewing any number of times and ending; each refused below `"content"` except ending
  and listing; the listing's order and bound; ended grants deleted after the retention; no admin
  audit record and nothing else of the workspace written; an approval's grant never touched,
  listed or revealed; a workspace deleted meanwhile; and a grant given with an issue report,
  through its renewal, its end and its replacement.
- `admin-account-grant.test.ts`: the account-wide grant. One record, renewed under its id without
  a bound, replaced once ended; refused below `"content"` while ending still works; what a
  workspace is answered; no admin audit record; and its link to issue reports, a failed link
  included.
- `admin-access.test.ts` also covers the cap's third level and what is not a level, the content
  refusal (`adminContentRefusal()`), `namedUser()`, the `...HoldsContent` predicates, and the
  issue reports' floor.
- `admin-writes.test.ts`, `admin-write-requests.test.ts`, `admin-write-approval.test.ts` and
  `admin-write-apply.test.ts` also cover `"grantContentAccess"`: a request kept for ten minutes
  like any other, which its requester can deny; the requester given no challenge and refused,
  recorded, when they approve, the request left pending; the workspace refusing the requester
  again, a request applied twice and a level below `"content"`; the grant stored with no action
  log entry, event or notification; and `endAdminGrant()`, its `"revoked"` record before the
  effect, and an owner's grant refused.
- `admin-api-impl.test.ts` also covers an open for content, refused and recorded below
  `"content"`; a `"grantContentAccess"` request refused below `"content"`, nothing stored or
  recorded; and `endWorkspaceGrant()`.
- `deployment-admins.test.ts`: how a name matches the `ADMINS` list, and `sameDeploymentAdmin()`:
  names that differ only by the case of ASCII letters are one admin.
- `git-cache.test.ts` also covers `readLocalFileAtCommit()`: text, a stream for a large file or
  one that is not text, a symlink and a submodule, and never a pull.

The admin gatekeeper adds these, in the same directory (its own suites are listed in
[its README](../packages/gatekeeper-instanceadmin/README.md#tests)):

- `admin-agent-kinds.test.ts`: every `AdminApi` method classified, the seven action kinds with a
  tag each, their methods (an assignment's two) and their verdicts, and the constants.
- `admin-agent.test.ts`: the membrane. What `adminAgentRefusal()` refuses under a session and
  under each action kind; `restrictAdminApi()`'s checks in their order, an action's one call, a
  lend that ended or ran out; and a view behind it, of a workspace or of a user's account, which
  answers its own methods and no other name, ends with the lend and lives no longer than the
  lend has left.
- `admin-agent-lend.test.ts`: `lendAdminApi()` on a real workspace. A session's reads and what
  each records, with `via` `"gatekeeper"`, the workspace and the chat, a view of a user's
  account included; an approved action's one call; restricted data, marked by a read, after
  which a rule applies a note, a status and a claim and holds a scoped reply and a write
  request; the lend's own check, which lends to an auto-approval only for those three kinds;
  another vendor's restricted read before the admin connection's and after it, and one that
  lands between an action's submission and the drain; a workspace marked before it kept track
  of whose reads marked it; another vendor's action tagged as a note; a rule-applied note that
  can only add an admins-only entry; the catalog listing the admin connection no gadget binds,
  with whether a rule applies each kind; who is lent nothing (the vendor off, an owner who is
  not an admin or holds no account, a member's direct session); the insiders of a request for
  content, with a second admin who collaborates in the workspace; and a spawned chat without
  the binding named.
- `auto-approval.test.ts`: `ruleApplies()`, the one predicate, with each of its three
  conditions failing alone; `autoApprovalRule()` following it; and the drain under the mark,
  which applies a note, a status and an assignment in order, stops at a scoped reply, applies
  nothing of another vendor's connection, and holds an action judged eligible once another
  vendor's read ended the exemption.
- `admin-workspace-admission.test.ts`: the admission rule at each gate, for a workspace with the
  connection, for one that had it and read nothing, and for one that read through it, a
  non-admin kept in the sharing list included. It also covers whose reads marked a workspace:
  the admin connection's alone when it set the mark first, never once another vendor set it
  first or marked it later, and never in a workspace marked before that was kept.
- `provisioning-policy.test.ts` and `user-ambient-accounts.test.ts`: the gatekeeper's mode,
  Disabled until an admin chooses, and its account offered, provisioned and listed for
  deployment admins alone, in each mode.
- `admin-access.test.ts`, `admin-api-impl.test.ts`, `admin-audit.test.ts`,
  `admin-workspace-view.test.ts`, `admin-user-view.test.ts` and the four write suites also cover
  a caller's `via` and `agent` checked in one place, before any terms reach a workspace or an
  account, and kept on each record, the digest over a request's `agent`, `isRequestInsider()` at
  the three checks, and a view opened for one issue report.

The issue report suites are listed in [issue-reports.md](issue-reports.md#code-and-tests).

Integration suites, in `packages/integration-tests/__tests__/`:

- `workshop-admin-inspection.test.ts`: every admin method this surface adds refused to a non-admin;
  the directory; an inspection recorded apart from the workspace and absent from the owner's
  `listActions()` and `subscribeToActions()`; what the view withholds of what the owner reads, and
  inspection turned off; attachments, commits and a draft's paths listed without their content; a
  view being a metadata view unless content is asked for, an option or a level that is not one
  rejected, and the five content reads refused and recorded on a metadata view; every call
  recorded end to end; the creator of a connection made through `newGatekeeper()`, and none on an
  ambient one; who holds an observer record, with what was verified for each; a deleted id refused
  without being written; an audit write failure, where a call returns nothing; expiry; and long
  text end to end.
- `workshop-admin-user-view.test.ts`: `inspectUser()` reachable by a deployment admin alone, and
  the account's `openForAdmin()` by no capability a user holds; a user that does not exist refused
  with no account created, no directory entry and no record; every call into an account recorded
  with kind `"user"`, and what the view withholds of what the user reads; no level above
  `"metadata"` to ask for or to set; a live view turned off and on with the deployment's level,
  with what that refuses recorded; an audit write failure, where a call returns nothing and
  writes nothing; and an inspection that writes nothing to the account: the open, every method
  and the refusals each sit between two reads of the account's `total_changes()`, which must be
  equal, and the user then sees what they saw before.
- `workshop-admin-audit.test.ts`: every setting change recorded before it takes effect, sessions,
  filters, stats across two admins, and a refused change when its record cannot be written.
- `workshop-admin-bounds.test.ts`: the bounds' defaults, and a redeploy that tightens them (an
  invalid cap failing closed) and demotes an admin. The redeploy ends every session, the demoted
  admin's view among them, so the per-call re-check that stops a live view once its admin is demoted
  is covered by `admin-workspace-view.test.ts`. It also covers writes refused, recording nothing,
  while `ADMIN_WORKSPACE_WRITES` is unset and after a redeploy that sets it to `true`, and
  Content chosen only once a redeploy raises the cap to it.
- `workshop-admin-grants.test.ts`: grants and content reads end to end. Only a workspace's owner
  giving, renewing, listing and ending a grant, none of it in the audit log; answers about the
  grants of an owner with a very long name staying bounded; content read only through a view
  opened for it, under a live grant, each read recorded with the grant's id; a mixed method
  answering as metadata without a grant and with content under one; the account-wide grant, never
  copied into a workspace, and reads under it stopping within a minute of its revocation; a chat
  page with no inline image and the image's bytes as a stream; a grant given by a second admin's
  approval, signed by the software authenticator, which only an admin ends; an owner shown
  nothing of an approval's grant; and a deployment with one admin left only the owner's grant.
- `workshop-admin-writes.test.ts`: writes end to end, signed by the same software authenticator.
  The write and passkey methods refused to a non-admin, whose capabilities run no write; an
  enrolment recorded without its key; an admin with no passkey, and another admin's passkey,
  approving nothing; an approved write recorded step by step, with `"approved"` before the effect,
  and entered in the workspace's action log, where its owner reads who did it and why; nothing
  changing when the record cannot be written; a replayed and a falsified approval refused, each
  recorded; a denial; a passkey removed only by its own admin; every other action as its
  operation, and a request for anything else refused; a workspace that is gone; and passkeys kept
  through writes being turned off, and a former admin's, which do nothing.

- `admin-gatekeeper.test.ts`, `admin-gatekeeper-actions.test.ts` and
  `admin-gatekeeper-hooks.test.ts`: the admin gatekeeper end to end, with a scripted model. Who
  is offered it; an agent's view calls recorded as made through the gatekeeper, and content read
  only where the workspace's own check allows it; the admins-only workspace, while it has the
  connection and after; a content request no member of the workspace can approve; a public
  reply through the binding held for a person whatever the rules; a note, a status and a write
  request applied by their rules; the restricted-data mark and its order; in a workspace that
  read through the whole binding, a note, a status and a claim applied by rule with no person
  while a public reply, a scoped reply and a write request are held, a note held behind a reply
  until the reply is decided, and a subscriber told of its own rule-applied note; a workspace
  that also read another vendor's restricted data, where a rule applies nothing; another
  connection's action never applied by rule under the mark; the admin connection listed in the
  catalog with no gadget binding it; the session limited to one report, its reply reaching the
  reporter with no person, and the mark of a reporter's restricted workspace; the three hooks
  firing into a gadget's stored callback, once for each kind of change to a report, and which of
  their events mark the workspace; two admins'
  workspaces claiming one report, of which exactly one holds it; and a spawned agent handed one
  report's session.

The integration suite reaches Durable Object storage directly (see
[integration-testing.md](integration-testing.md#reaching-a-durable-objects-storage-from-a-test)): it
faults the deployment-wide log with a trigger on `admin_audit`, shows that an inspected deleted
id stays unwritten by listing its `sqlite_master`, and shows that a call into an account wrote
nothing by reading the account's `total_changes()` before and after it.

Frontend suites, in `packages/workshop-frontend/src/`:

- `pages/admin-write-approval/AdminWriteApprovalPage.test.tsx`: what the page shows of a request
  in each state and of each failure, and `features/admin-writes/writeLabels.test.ts` the rows and
  notes it is built from.
- `features/admin-writes/AdminPasskeysCard.test.tsx` and `AdminPage.test.tsx`: the Access tab's
  passkeys card, with writes on and off, and Remove offered only on the caller's own passkeys.
- `features/admin-writes/passkeyCeremony.test.ts`: what the browser is asked for and how its
  answer is encoded.
- `Activity.test.tsx`: an admin's write in the workspace's activity. The suites beside the Audit
  tab cover the write kind, its filter and a write record's details, and, for content, the badge
  for what a call exposed, its filter, the count of content reads, the grant and the refusal a
  record carries, and the access setting's Content option under each cap.
- `Activity.test.tsx` and `Activity.autoApproval.test.tsx` also cover a marked workspace:
  "Always approve" offered, and a rule's switch usable, only for the kinds a rule still applies
  there, and a rule that applies nothing saying so and staying revocable.
  `features/approvals/autoApprovalRules.test.ts`, `useRuleCatalog.test.tsx` and
  `useStandingRules.test.tsx` cover the answer both are built from, and
  `features/approvals/PendingChangesTray.browser.test.tsx` the rule list's rows and keyboard
  order there.
- `pages/admin-workspace/AdminWorkspacePage.test.tsx`, with a browser test beside it: an admin's
  page for one workspace, its live grants, ending one a second admin approved, and Request
  content access giving the approval link. The approval page's suites also cover what the page
  says of a request for content, and its requester offered no approval.
- `features/admin-audit/AdminAuditPanel.test.tsx`, `features/admin-writes/writeLabels.test.ts`
  and the approval page's suite also cover a record and a request made through the admin
  gatekeeper: the "Agent" label, the workspace and the chat it came from, and what the page
  tells an admin who was in that workspace. `ShareModal.test.tsx` covers the reason shown when
  adding someone to an admins-only workspace is refused, and `ResourcePicker.test.tsx` and
  `GatekeeperModal.test.tsx` the picker's row that adds an auto-provisioned account.
- The browser tests (`test:run:browser`) run real ceremonies in Chromium against a virtual
  authenticator: `features/admin-writes/passkeyCeremony.browser.test.tsx` creates a passkey and
  confirms a challenge with it, and
  `pages/admin-write-approval/AdminWriteApprovalPage.browser.test.tsx` approves a request from the
  page, by pointer and by keyboard.

The CLI's suites, in `packages/api-cli/`, pin the `cf-os api` commands for grants, content reads
and issue reports, and `--out <file>` saving the byte stream a result holds inside it.
