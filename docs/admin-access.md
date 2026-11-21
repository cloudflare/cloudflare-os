# Admin access: operating and investigating a deployment

A deployment's admins (the canonical user ids its backend Worker's `ADMINS` variable lists) need to
operate, debug and investigate the instance: find a user or a workspace, look inside a workspace
that misbehaves or at what a user's account holds, and know afterwards who looked at what and who
changed which setting. What they see of a workspace or of an account is its metadata. A
workspace's content (chats, files, attachments) is read only where the deployment's environment
allows it and only under a grant: a record, lasting 72 hours, given by the workspace's owner or by
a second admin's approval (see [Grants](#grants)). Where the environment allows it, they can also
change a workspace (see [Writes](#writes)). Users reach the admins through issue reports, which have a document of their
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
| The writes switch (`adminWorkspaceWritesEnabled`) | `packages/workshop-backend/src/admin-access.ts` |
| What a write is computed from alone: the arguments each action takes (`adminWriteArgs`) | `packages/workshop-backend/src/admin-writes.ts` |
| Calling a write (`AdminApiImpl.writeWorkspace`) | `packages/workshop-backend/src/admin-settings.ts` |
| Running a write (`applyAdminWrite`, `runAdminWrite`) | `packages/workshop-backend/src/overseer.ts` |
| What a grant is computed from alone: whether it is live, whether it can be deleted, a fresh one (`isAdminGrantLive`, `isLiveAccountGrant`, `isAdminGrantPrunable`, `newAdminGrant`) | `packages/workshop-backend/src/admin-grants.ts` |
| What each view method's answer can hold (`ADMIN_METHOD_ANSWERS`), why a call may return no content (`adminContentRefusal`), a user as a grant names them (`namedUser`) | `packages/workshop-backend/src/admin-access.ts` |
| The owner's grant methods, the grant a content call runs under (`contentGrant`), ending an approval's grant (`endAdminGrant`) | `packages/workshop-backend/src/overseer.ts` |
| The account-wide grant | `packages/workshop-backend/src/user.ts` |
| Who counts as one admin where two are required (`sameDeploymentAdmin`) | `packages/workshop-backend/src/auth/config.ts` |
| Requests to read a workspace's content without its owner (`AdminSettings`, `AdminApiImpl`) | `packages/workshop-backend/src/admin-settings.ts` |
| The grant an approval gives (`grantAdminContent`) | `packages/workshop-backend/src/overseer.ts` |
| The Audit tab's pending approvals, and the control that asks for content access | `packages/workshop-frontend/src/features/admin-grants/` |
| An admin's page for one workspace: its live grants, ending one, asking for content access | `packages/workshop-frontend/src/pages/admin-workspace/` |
| What an agent may do with each `AdminApi` method (`ADMIN_AGENT_KINDS`, `ADMIN_AGENT_ACTIONS`) | `packages/workshop-shared/src/admin-agent.ts` |
| Lending a workspace owner's Admin API to the admin gatekeeper (`lendAdminApi`, `restrictAdminApi`) | `packages/workshop-backend/src/overseer.ts`, `packages/workshop-backend/src/admin-agent.ts` |
| The admin gatekeeper | `packages/gatekeeper-admin/` |

## Entry points

Everything goes through `AuthenticatedApi.getAdminApi()`, which returns null unless the
caller is an admin. The admin check runs once, when the capability is minted, for every `AdminApi`
method except inspection, which checks again, of a workspace (see [Inspection](#inspection)) and of
a user's account (see [User inspection](#user-inspection)) alike, and `writeWorkspace()` and the
content access, grant and issue report methods, which check on every call (see [Writes](#writes)).

- **Settings**: the setters (signups, user search, view-only gadget sharing, site name and logo,
  instructions, resource and gatekeeper availability, models, update checks, ...), plus
  `setAdminWorkspaceAccess()`, `setAdminAuditRetentionDays()` and
  `setIssueReportRetentionDays()`. Every setter is audited.
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
  `writeWorkspace(workspaceId, action, args, reason)`.

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
    from a blueprint): the `title` singleton is the one chokepoint, and its
    subscriber bumps the revision inside the write's transaction and defers the sync;
  - with `lastActive` when the workspace is active, at most hourly, alongside its
    last-active report to the owner's user DO.

  Syncs run one at a time, are best-effort, and never restart the workspace. A workspace
  initialised before it recorded its creation time reads it once from its owner's record of it
  (`GadgetRecord.created`) and stores it.
- **The revision is time-based.** `#initializeNewWorkspace()` sets it to at least the current time.
  A workspace initialised again under the same id then outranks whatever its earlier life left in
  the directory.

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
  `autoApprovable`, and never once the workspace has read restricted data: the rules stay stored
  and listed, and every action waits. A view shows both conditions, which is how an admin answers
  why an action still waited: `describe()` reports `containsRestrictedData`, and `listActions()`
  keeps each action's `autoApprovable` verdict and kind, with `autoApproved` on one a rule
  applied.

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
for all of their workspaces, or from a second admin who approves another admin's request (see
[Asking for content without the owner](#asking-for-content-without-the-owner)). No level shows
content without one.

### The record

An `AdminAccessGrant` holds:

| Field | What it is |
| --- | --- |
| `id` | Random and opaque. It is on the audit record of every call made under the grant. |
| `level` | What it lets admins read: `"content"`. A field, so that another level needs no migration. |
| `source` | `"owner"`, or `"admins"` for a second admin's approval. |
| `scope` | `"workspace"`: the one workspace it is stored in. `"account"` (an owner's only): every workspace its giver owns. |
| `grantedBy` | The owner, or the approving admin. |
| `requestedBy`, `requestId`, `reason` | For `"admins"`: the admin who asked, the content access request it was approved through, and why, as the requester gave it. |
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
the owner's methods delete the owner's, and the admins' grant writes delete either kind, except
that ending a grant, the owner's revoke or an admin's `endWorkspaceGrant()`, reads no retention
and deletes nothing, so that nothing it depends on can stop it. Nothing else prunes, so a
workspace nobody gives, renews or lists a grant on again keeps its ended grants until it is
deleted. The account-wide grant is the one exception to "at least": the account keeps one
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

### Asking for content without the owner

Any admin can ask to read a workspace's content without its owner's grant, and an admin other than
the one who asked approves or denies the request. It is not a write: `ADMIN_WORKSPACE_WRITES`
does not bound it. The level does: below `"content"` a request, an approval and the grant it gives
are refused `contentOff`.

- **The request.** `requestContentAccess(workspaceId, reason)`
  (`cf-os api get-admin-api request-content-access <workspaceId> <reason>`) checks that the
  caller is still an admin (`notAdmin`), the reason, as an inspection's is checked, the workspace
  id's form (`workspaceNotFound`), the level in force by the authoritative config (`contentOff`:
  a request is never made at a level the KV mirror alone still shows), and that the directory
  lists the workspace (`workspaceUnlisted`): whoever approves must see whose workspace it opens.
  It never reaches the workspace: the title and the owner it carries are the directory's, as
  for an open refused before it reaches a workspace. `AdminSettings` then refuses a second
  request while one for the workspace is pending (`requestPending`) and one more than
  `MAX_PENDING_CONTENT_REQUESTS` (50) pending across the deployment (`tooManyRequests`), records
  the request, and only once its record exists stores it. It stays pending for a day
  (`ADMIN_CONTENT_REQUEST_LIFETIME_SECONDS`), and ends sooner when its requester stops being an
  admin.
- **The list.** `listContentAccessRequests()` returns every admin's requests, the pending ones
  first. The Audit tab's **Pending approvals** card shows them, with Approve and Deny on other
  admins' requests and an admin's own as waiting for another admin. An admin's page for a
  workspace offers **Request content access**, which takes the reason and points to that card.
- **The approval.** `approveContentAccess(requestId)`. `AdminSettings` claims the pending request
  for the caller, refusing its requester (`secondAdminRequired`, which leaves it pending), a
  request that is no longer pending (`requestNotPending`) and a level below `"content"`. The claim
  is the request's one way out of `"pending"`. `AdminApiImpl` then asks the workspace for the
  grant (`grantAdminContent()`), which checks again, in its own environment, that the two are
  admins and not one admin, that the request gave it no grant already (`requestNotPending`), the
  level, and that it still has the owner the request named (`workspaceChanged`: a deleted
  workspace's id can be initialised again for someone else). It appends the approval's record,
  naming the grant, and only then stores the grant: source `"admins"`, on that workspace, for 72
  hours, never renewed. The workspace's answer is stored with the request: the grant's id, or the
  refusal (`"failed"`). The call goes on under `waitUntil()` if the client hangs up; an approval
  whose answer never arrives is failed after fifteen minutes, and never asked again.
- **The denial.** `denyContentAccess(requestId)`, by any admin, its requester included, who so
  withdraws it, at any level. It is recorded before it is stored.
- **The end of a request.** One that runs out records nothing: no admin did anything. There is
  no alarm: every method sweeps the requests before it reads one, ending those that have run out,
  failing approvals whose answer never arrived and forgetting a request a day after it was
  resolved.

**Who counts as the requester.** Admin names match the `ADMINS` list regardless of the case of
ASCII letters, while an account is named by its email as the identity provider spelled it, so two
accounts that differ only by case are one entry of the list and one admin, and the approval
compares names the way the list does (`sameDeploymentAdmin()`), never with `===`.

**A request an agent filed is closed to everyone who was in its workspace.** A request filed
through the admin gatekeeper is its workspace owner's (see [Through an agent](#through-an-agent)),
and other admins may work in that workspace. So `AdminSettings` keeps, with the request, who was
there when it was filed (its insiders: the owner, everyone the workspace was shared with in any
role, and the member who approved the filing), and both the claim and the workspace refuse any of
them as they refuse the requester (`isRequestInsider()`, `secondAdminRequired`). The list is read
once, at filing: a member who leaves afterwards still cannot approve, and an admin who joins
afterwards can. It is never returned by the API or recorded. An admin from outside the workspace
approves. The Pending approvals card shows such a request as its requester's agent's, with the
workspace and the chat it came from. Requests filed through the gatekeeper hold at most
`MAX_PENDING_AGENT_CONTENT_REQUESTS` (10) of the pending slots: a person files each, but an agent
can ask for many, and people's requests keep the rest.

**What it proves, and what it does not.** It proves that two admin accounts took part: one asked,
and another approved. It does not prove two people: one person who holds two admins' sessions can
ask with one and approve with the other. Against that stands the record: the request's and the
approval's records name both accounts and their sessions.

**A deployment with one admin cannot approve new requests**: nobody can approve its admin's
request, so new access comes only from the owner's grant. Removing an admin from `ADMINS` does not
end a grant an approval already gave, whether the removed admin asked for it or approved it: the
grant is checked by its level, expiry and revocation, not by who took part, so it stays live until
it expires or an admin ends it.

**The grant is given once per request.** The workspace draws the grant's id before it appends the
approval's record, which names it (`grantId`): every read made under the grant carries the same
id, so it leads back to the approval. A request handed to the workspace a second time is refused
(`requestNotPending`): the workspace finds the grant that names it.

**One at a time.** An approval ends the workspace's live grant with source `"admins"`, if there is
one, as ended by the approver, in the step that stores its own, and its record names the grant it
ends (`replacedGrantId`). A workspace holds one, unless two approvals ran at once, each of which
ends only the grant its record names.

**Only admins end it.** `endWorkspaceGrant(workspaceId, grantId, reason)` ends a live grant with
source `"admins"`, and nothing else: an owner's grant is the owner's to end (`notFound`, as for an
id that names no grant). It asks only for an admin, whatever the level, since it only takes access
away. The workspace (`endAdminGrant()`) appends the ending's record, with the grant's id, the
admin who ended it and why (`endReason`), before it ends the grant: an ending whose record cannot
be written does not happen. A grant another admin ended while the record was appended is refused
`notFound`, and the record stands for the attempt.

**A grant that runs out is recorded by nothing.** The grant says when it ends.

**What does not end an approval's grant.** Removing its requester or its approver from `ADMINS`
does not, nor does turning `ADMIN_WORKSPACE_WRITES` off. The grant stays live until it runs out
or an admin ends it with `endWorkspaceGrant()`.

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

**The owner is not told.** The workspace shows nobody a request, its approval or the grant it
gives:

- nothing is entered in the action log, and no event is raised to the workspace's sessions, no
  notification and no unread count, by the approval or by an admin's ending of its grant;
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

What stands in for the owner's knowledge is a second admin's approval, the reason, and the audit
records of the request, the approval and every read made under the grant.

### An owner's grant is the owner's own record

Giving, renewing and ending an owner's grant, and its expiry, on one workspace or account-wide,
write no record to the admin audit log. The log records what admins do. So nothing bounds how
often an owner grants or renews. Admins learn of an owner's grant where they work:

- among the workspace's live grants on the admin view (`describe().grants`);
- on the issue report it was given with;
- by its id (`grantId`) on the record of every content call made under it, which is all the audit
  log says of it.

What admins do about a grant is recorded, as grant records: a request to read content without
the owner, its denial, its approval and an admin's ending of its grant; and every call made under
any grant is an access record that names it.

### What the listings return

An owner gives grants without limit and a display name has no bound of its own, so the answers
are bounded, not the owner: each listing returns at most `MAX_ADMIN_GRANTS_LISTED` (20).

- `listAdminGrants()` puts the owner's live grants first, newest first, then the ended ones still
  kept, so that while a grant the owner can still end exists, one is listed. An owner with more
  than 20 live grants is shown the newest 20; ending one makes room for the next.
- `describe().grants` lists live grants only: the one a second admin approved first, then the
  owner's newest, so that the owner's grants never crowd out the one kind of grant only an admin
  can end. The owner's listing is not the whole set once it holds 20.
  The account-wide grant is not among them, since the workspace asks for it only when a call
  needs content.

## Writes

An admin can also change a workspace, in two ways: stop an agent, or restart the workspace.
Neither gives the admin access to anything in the workspace. Writes are off unless the
deployment's `ADMIN_WORKSPACE_WRITES` is `on` (see
[The environment's bounds](#the-environments-bounds)). A write runs when an admin calls for it, with
no second admin and no second factor. What bounds it is the switch and the record the workspace
appends before anything changes. That record, in the deployment-wide audit log, is the write's only
trace: the workspace keeps none.

### Calling a write

`AdminApi.writeWorkspace(workspaceId, action, args, reason)` is open to any admin session, the
CLI's and an agent's included
(`cf-os api get-admin-api write-workspace <workspaceId> <action> <args> <reason>`).
`AdminApiImpl` checks that the caller is still an admin (`notAdmin`), that writes are on
(`writesOff`) and the workspace id's form (`workspaceNotFound` for a malformed one), and then calls
`OverseerDurableObject.applyAdminWrite(call)`, which nothing else calls. The call carries the
action, its arguments and the reason, and the admin, `sessionId` and `via` of the capability. A
refusal from the workspace is the caller's error; `workspaceNotFound` also drops the workspace
from the directory, as a refused inspection does.

**The reason stays in the admins' log**, as an inspection's does. It is read by admins in the
Audit tab, never by the workspace's members.

**A write an agent asks for is its workspace owner's.** Through the admin gatekeeper,
`writeWorkspace()` is queued as an action of the workspace and runs once a member approves that
action; a rule never approves it (see [Through an agent](#through-an-agent)). Its `admin` is the
owner of that workspace, whichever member approved, and its record carries where it came from
(`via: "gatekeeper"` and `agent`).

### Run

`applyAdminWrite()`:

- **is reachable only over the Workshop's Durable Object binding**, never through a capability a
  user holds;
- **refuses a workspace never initialised or since deleted** (`workspaceNotFound`) before anything
  else, writing nothing, as `openForAdmin()` does;
- rejects with a `TypeError` a reason that is blank or longer than
  `MAX_ADMIN_ACCESS_REASON_LENGTH` (500) characters, a `via` that is not `"api"` or `"cli"`, and
  arguments that are not the action's (`adminWriteArgs()`: each action takes only its own,
  `AdminWriteArgs` lists them, and only what the action takes is kept);
- **re-checks the admin and the switch** through the workspace's own environment (`impl.env`): the
  caller must still be an admin (`notAdmin`) and writes still on (`writesOff`), whatever the Worker
  that called believed;
- **appends the write record before anything changes.** A write whose record cannot be written
  does not happen. Nor does one whose workspace is deleted while the record is appended: the
  record is kept, and nothing follows it;
- **then runs the operation** (`runAdminWrite()`). If it throws, the error is rethrown to the
  caller, and the record stays.

As for an inspection, by explicit policy the admin is not checked by `authorizeCollaborator()` or
observer verification, and joins no session, presence or outputs fan-out. Unlike an inspection,
which starts nothing, a write that changes a workspace does what its operation does for a member.

Each of the two actions that change a workspace runs an `OverseerImpl` operation of its own, the
one a member's session runs for it or close to it; the third stores a record and runs nothing a
member can run:

| Action | Arguments | Operation |
| --- | --- | --- |
| `stopAgent` | `chatId` | `takeSteers(chatId)`, then `cancelAgent(chatId)`: a member's stop, keeping the chat's queued messages |
| `restartWorkspace` | none | Ends every session on the workspace, as a revoked collaborator does |

**`stopAgent` keeps the messages queued for the turn.** A member's stop drops the messages sent
while the agent worked that it had not read yet, and the client that stops puts them back in its
draft. An admin's stop has no such client, so those messages go into the chat as their senders'
own, as when a turn fails, and the agent reads them when it next runs. The chat and the agent are
told the turn was stopped as for any stop (code `stopped`), with nothing naming an admin.

### Who sees a write in the workspace

**Nobody in the workspace is told that an admin acted.** A write enters nothing in the workspace's
action log or its activity, and raises no event or notice for its sessions. Its members see only
what the operation did: a turn stopped as any stop is, or their sessions ended and reconnected as
after any restart. The record in the deployment-wide audit log, with the admin and the reason, is
read by admins in the Audit tab.

### When a write fails

The record says that a write was made, not what came of it. A write that fails once recorded, such
as a `stopAgent` of a chat that does not exist, shows as the caller's error and as an
`admin.write.failed` log line for operators. A write whose workspace is deleted while its record is
appended keeps its record and runs nothing (see [Run](#run)). A write cut short (the object lost
midway) leaves its record and may have changed the workspace in part: a restart aborts the
workspace about 100 ms after it answers, and an operation can throw partway.

## Through an agent

A deployment admin can give the agents of a workspace they own this API, through the admin
gatekeeper (`packages/gatekeeper-admin`, vendor `admin`). The gatekeeper is part
of every deployment, with its mode Disabled until an admin chooses another; only deployment
admins hold its account, and its holder adds its connection ("Deployment admin") to the
workspaces that need it. Its design record is
[the package's README](../packages/gatekeeper-admin/README.md).

**What an agent can do.** Every `AdminApi` method has one kind (`ADMIN_AGENT_KINDS`; the
[README's table](../packages/gatekeeper-admin/README.md#what-each-kind-does) lists
them):

- **Read**: the listings, the settings getters, the audit log and its statistics, issue reports
  with their threads and images, the content access requests, `inspectWorkspace()` and
  `inspectUser()` with every method of the view each returns, and `whoami()`, which names the
  workspace's owner: the admin every call through the binding is made as. A read runs at once. A
  workspace's view reads metadata, and content only as [Each call](#each-call) decides for any
  admin: the gatekeeper adds no way round a grant. A view of a user's account reads metadata
  alone (see [User inspection](#user-inspection)).
- **Act**: an entry in a report's thread, a report's status, claiming or releasing a report, a
  write, and a request for content access. The call is queued as an action of the workspace and
  runs once a member approves it, or a rule does where the kind allows one. A public reply
  through the binding always waits for a person, and so do a write, which then runs with no other
  admin deciding, and a request for content access, which a second admin must still approve once
  it is filed. A claim and a release are one kind of action, for the workspace's owner, whoever
  in the workspace asked: a claim makes the owner the report's assignee and is refused where
  another admin holds the report. It is never a take-over, which only a person makes, from the
  holder they name (see
  [issue-reports.md](issue-reports.md#the-assignee)). An action refused where it lands, such
  a claim included, stays pending until a person rejects it, and the connection's later
  actions wait behind it (see [its limits](issue-reports.md#limits)).
- **Omitted**: every setter, approving or denying a content access request, ending an admins'
  grant, and setting a report's links. They are absent from what the agent is told and refused.

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
workspace has read or received anything through the connection it stays so for good, with or
without the connection, because its chats hold what was read.

**Everything read or received through the connection marks the workspace as holding restricted
data**, in this version: a read through the whole binding, a report session's read (the report,
its images, its view of the reporter's workspace) and every hook's event. Each sets the
platform's restricted-data latch and keeps the workspace admins-only for good. From then on no
rule applies anything there, so every action waits for a person, a reply to a reporter
included, and web fetches reach only the hosts the deployment trusts. A report's text and
images are whatever its author put there, and anyone can file one, so what a report session
reads is not safe to send anywhere just because its reporter could see it. This holds until
[audience-based release](restricted-data-audiences.md) lets an action through when everyone who
can see its effects can already see the data (see
[the README](../packages/gatekeeper-admin/README.md#restricted-data)).

**Where the person behind a call is found.** Every record names the owner, so:

- for an agent's turn, the chat the record names says who prompted it;
- for an approved action, its record in the workspace says who decided (`resolvedBy`);
- for a session opened directly from the connection, it is the owner: no other member is lent
  one, and no other member's queues an action, which a rule could apply with nobody deciding.

A slash command is not among them: this gatekeeper has none.

**What the audit log holds of an agent.** View opens and view calls, of a workspace and of a
user's account, writes, and content access requests carry `via: "gatekeeper"` and the origin
(`agent`). Listings
of users, workspaces, reports, settings and the audit log itself, and reading a report or its
image, leave no audit record, for an agent as for any admin: their only trace is the observation
in the activity of the workspace that called, which goes with that workspace. A report entry, a
status or a change of assignee an agent made is recorded in the report's thread.

**Removing the account.** Disconnecting the deployment admin account from Connectors ends every
connection made with it, in every workspace its holder owns, at the next session, action or hook
firing, and adding it again restores them. In mode Enabled it cannot be removed.

**Limits**, each described in the README:

- [The split of the two reply kinds and the restricted-data mark are the gatekeeper Worker's
  own declarations](../packages/gatekeeper-admin/README.md#what-a-worker-that-keeps-everything-could-do):
  they hold against agents and gadgets, not against the Worker.
- [The latch does not hold back reads through the workspace's other
  connections](../packages/gatekeeper-admin/README.md#what-the-latch-does-not-hold-back).
- [Reading a report closes the workspace as a read of the whole deployment
  does](../packages/gatekeeper-admin/README.md#restricted-data): a reply to the reporter waits
  for a person like any other action.
- [An agent finds the write it asked for through the audit log, and the content request it filed
  through the list of requests](../packages/gatekeeper-admin/README.md#limits): the call
  that queues either returns nothing.

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
- no content access can be requested or approved (`contentOff`);
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
| `ADMIN_WORKSPACE_WRITES` | `on`, `off` (any case, trimmed) | `off` (unset or blank) | Whether admins may make [writes](#writes) to workspaces. Any other value is off, logged as an error, so `true`, `1` or a typo of `on` never enables them. |

The admins' choice is kept in `AdminConfig` as they set it, and `adminAccessPolicy()` holds it within
the bounds wherever it is enforced: `inspectWorkspace()`, `inspectUser()`, every view call, the
grant methods, a content access request, its approval and its grant, the settings audit, the audit
log's own floor and the issue reports' deletion. `getSettings()` reports `chosen`, the bound
(`max` or `min`), and `effective`, which is what is enforced. The setters refuse a value outside the
bounds, naming the variable; a choice stored before a bound tightened is kept but not enforced.
`setAdminWorkspaceAccess()` refuses a value that is not a level, storing and recording nothing.

`ADMIN_WORKSPACE_WRITES` has no choice under it, and no setter changes it.
`adminWorkspaceWritesEnabled()` is the only code that reads the variable: `AdminApiImpl` asks it
before a write reaches the workspace, and the workspace asks it again before the write runs. Each
asks its own environment, and each checks that the caller is still in `ADMINS` the same way, so a
session whose Worker started with an older config is held to the current one. The access level
does not bound writes: where it is `off`, no inspection can show what a chat id names, and a write
still runs. Nor does the switch bound a request to read a workspace's content, which is not a
write: the level does (see [Asking for content without the owner](#asking-for-content-without-the-owner)).

### Setting the bounds

All four are variables of the backend Worker (`workshop-backend`):

- **Locally** (`pnpm run-local`, `pnpm dev-server`): set them in the shell or in the root
  `.dev.vars`; `scripts/run-dev-server.ts` passes all four through to the backend, for example
  `ADMIN_WORKSPACE_ACCESS_MAX=content pnpm dev-server` or
  `ADMIN_WORKSPACE_WRITES=on pnpm dev-server`. A local instance has one admin, `admin`, and an
  approval of content access needs two: `ADMINS` in the shell (comma-separated usernames)
  replaces that list, so `ADMINS=admin,grace pnpm dev-server` gives a second admin. That is for
  local development only; no deployment path reads the shell's `ADMINS`.
- **Your own `wrangler deploy` or workerd config**: the backend Worker's `vars`.
- **Deploy tools that write the backend's variables themselves** (the online deploy flow and the
  deployment starter's `cf-os deploy`, both linked from the [README](../README.md#get-started)):
  they replace the Worker's variables on every deploy, so a value set in the Cloudflare dashboard
  lasts only until the next deploy, and until such a tool carries these variables its
  deployments run with the defaults. Any redeploy that writes its own variables must carry all
  four.
- **Pull request previews** (`scripts/preview/staging-config.ts`): `ADMIN_WORKSPACE_WRITES` is `on`
  and `ADMIN_WORKSPACE_ACCESS_MAX` is `content` in each preview, so that writes, grants and content
  reads can be tried there, and both keep their defaults in the shared baseline the previews branch
  from. The two retention floors keep their defaults.

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
- Writes go off.

So set what you want in the admin panel too: the admins' choices persist in the deployment's
settings across deploys, while a variable only bounds what an admin session can choose.

- **To keep inspection off**, also choose Off as the Audit tab's access setting: the variable only
  stops an admin session from turning inspection on.
- **To keep a retention**, set it in the Audit tab: the floor only stops an admin session from
  choosing less. The tab says when the floor is what holds retention up; it saves only a value
  that is typed, so type the number of days you want kept, even the minimum.
- **To keep a retention for issue reports**, set it in the Reports tab, for the same reason.

## The audit

### Five kinds of record

- **`AdminAccessRecord`** (`kind: "workspace"`): one admin call into a workspace, the open or a view
  method. It holds `at` (when the record was written), `admin`, `sessionId`, `via`, `agent` (for a
  call made through the admin gatekeeper, see below), `workspaceId`,
  the workspace's owner (`workspaceOwner`, resolved when the view opens; from the directory for an
  open refused before it reaches the workspace; a username is unbounded, so a long one keeps its
  start and a digest of the whole id, which keeps long ids apart), the workspace's title at the
  time, `method`, the call's arguments by name, the `reason` given at the open, what the view was
  opened for (`requested`), the deployment's `access` level when the call ran (`"off"` for a call
  refused for that), what the call's answer exposed (`exposed`, see
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
- **`AdminWriteRecord`** (`kind: "write"`): one admin write to a workspace, appended by the
  workspace before it changes anything. It holds `at`, `admin`, `sessionId`, `via`, `agent` (for a
  write made through the admin gatekeeper, see below), `workspaceId`,
  the workspace's owner and title as the workspace gives them (kept as an `AdminAccessRecord` keeps
  them), `method` (the action, named as on the other records so that one filter covers every
  kind), the write's `args` by name and its `reason`. It says what was asked for, not what came of
  it (see [When a write fails](#when-a-write-fails)).
- **`AdminGrantRecord`** (`kind: "grant"`): one step of admins' access to a workspace's content
  without its owner. It holds `at`, `admin` (whose step it is), `sessionId`, `via`, `agent` (on the
  `requestContentAccess` step of a request an agent filed), `workspaceId`,
  the workspace's owner and title, the request's `reason`, `method` (the step), the `requestId` its
  steps share, `requestedBy`, and, where the step has one, the `grantId` or the `endReason`. The
  four steps:

  | Method | Step | Whose (`admin`) | Recorded |
  | --- | --- | --- | --- |
  | `requestContentAccess` | An admin asked to read the workspace's content. | The requester | By `AdminSettings`, before the request is stored, with the directory's owner and title. |
  | `denyContentAccess` | An admin denied it, or its requester withdrew it. | The denier | By `AdminSettings`, before the denial is stored. |
  | `approveContentAccess` | A second admin approved it (`grantId`: the grant it gives). | The approver | By the workspace, with its own owner and title, before the grant is stored. |
  | `endWorkspaceGrant` | An admin ended the grant before its time (`grantId`, `endReason`; `reason` stays the requester's). | The admin who ended it | By the workspace, before the grant is ended. |

  A request that runs out, and a grant that runs out, record nothing: no admin did anything.

**An owner's grant has no record.** The log records what admins do, and an owner's grant is the
owner's own record (see
[An owner's grant is the owner's own record](#an-owners-grant-is-the-owners-own-record)): giving,
renewing and ending one, and its expiry, append nothing. Every call made under a grant, of either
source, is an access record with the grant's id.

**`via` and `agent`.** `via` is `"api"`, `"cli"` or `"gatekeeper"`. The first two come from the
session's User-Agent, the client's own claim. `"gatekeeper"` marks a call made through the admin
gatekeeper's connection of a workspace the record's admin owns, and such a record carries
`agent` (`AdminAgentOrigin`): the workspace whose connection made the call and, when the
workspace ties the caller to one, the chat. Only the workspace sets them, when it lends the
gatekeeper its owner's Admin API (`OverseerImpl.lendAdminApi()`): no client, header, argument or
gatekeeper Worker can claim the value or set the workspace or the chat. They name the lend the
call was made on; that the gatekeeper used each lend for the caller it was made for is the
gatekeeper's word (see
[its README](../packages/gatekeeper-admin/README.md#what-a-worker-that-keeps-everything-could-do)).
An access record, of a workspace or of a user's account, a write record and a grant record can
carry them. A setting record never says `"gatekeeper"`: no setter is open to an agent. The Audit
tab names such a record's `via` "Admin connection", since the record says the call came through
the connection, not that an agent made it (gadget code and a session the owner opened from it say
`"gatekeeper"` too), and shows the workspace and the chat it came from.

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
action shares its name with no other record's method, so a method filter by one lists every write
of it and nothing else. A method no record type names is refused
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

A write record is written by the workspace before it changes anything, so a write whose record
cannot be written does not happen. The workspace keeps no note of the write (see
[Who sees a write in the workspace](#who-sees-a-write-in-the-workspace)). A grant record precedes
its step the same way: a request, a denial, an approval or an ending whose record cannot be
written is not taken. A grant step writes nothing to the workspace a member can see.

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
| A write refused `notAdmin`, `writesOff` or `workspaceNotFound` before its record is appended, or whose reason, `via` or arguments are rejected | No | `AdminApiImpl` or the workspace refuses it before its record is appended: nothing changed. |
| A write whose workspace is deleted while its record is appended (`workspaceNotFound`) | Already recorded | The record stands for the attempt, and the workspace runs nothing. |
| A write that fails once recorded (its operation throws) | Already recorded | The record precedes the write; the failure is the caller's error. |
| A content access request refused before it is stored (`notAdmin`, a rejected reason, `contentOff`, `workspaceNotFound`, `workspaceUnlisted`, `requestPending`, `tooManyRequests`) | No | Nothing was stored, and no workspace was reached. |
| An approval refused when it is claimed (`notAdmin`, `secondAdminRequired`, `requestNotFound`, `requestNotPending`, `contentOff`), and a denial of a request that is no longer pending | No | Nothing was claimed or granted. A requester's own approval leaves the request pending for another admin. |
| An approval the workspace refuses (`notAdmin`, `secondAdminRequired`, `requestNotPending`, `contentOff`, `workspaceChanged`, `workspaceNotFound`) | No | No grant was given; the request is stored as `"failed"` with the refusal. |
| An `endWorkspaceGrant()` refused `notAdmin`, `workspaceNotFound` or `notFound` (an id naming no live grant with source `"admins"`) | No. One refused `notFound` only after its record was appended, because another admin ended the grant meanwhile, leaves that record | No grant changed. A record left behind is of the attempt. |
| An owner's grant call, refused or not (`grantAdminAccess()` and its siblings, the account-wide grant) | No | An owner's grant is the owner's own record: the log records what admins do. |
| An issue report method, refused or not | No | A report's thread is its own record (see [issue-reports.md](issue-reports.md#what-is-recorded-where)). |

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
- Two writes the diff cannot see are recorded explicitly before they happen: the site logo, as
  `"default"` or a logo's size and SHA-256 (never its bytes), which R2 keeps beside the logo, so
  uploading the logo already stored records nothing; a logo stored without its digest, before
  logos were recorded, is `"custom"`; and featuring a blueprint, whose bit lives in its owner's
  user DO.
- A call that changes nothing records nothing (it is still written, since it may be a retry
  repairing the KV mirror). A record is kept if the change then fails, for example when the KV
  mirror write fails and the config is rolled back: it records the attempt.

Not recorded: reads (`getSettings`, `isBlueprintFeatured`, `getUpdateStatus`,
`listContentAccessRequests`, `getContentAccessRequest`, the listings and the audit log itself), the
gateway tests, `checkForUpdates`, the deployment's own promotion of its bundled formats, which
no admin made, and the issue report methods, the five that write to a report included
(`addIssueReportEntry`, `setIssueReportStatus`, `claimIssueReport`, `releaseIssueReport`,
`setIssueReportLinks`): a report's thread is its own record, of its entries, its status changes
and its changes of assignee; replacing a report's links keeps no author and no time. The content
access requests and `endWorkspaceGrant` are recorded, as grant records and not setting records.

### Text bounds

Arguments, workspace titles and setting keys are cut to `MAX_ADMIN_AUDIT_ARG_LENGTH` (256)
characters by `cutAdminAuditText()`, the last character replaced with `…` and never splitting a
surrogate pair: a record marks its cuts, never passing a fragment off as the whole. Reasons are
capped at `MAX_ADMIN_ACCESS_REASON_LENGTH` (500), values at 10,000 with excerpts, and a setter's diff
has a bounded number of changes, so every record, and every page of them, is bounded. A write
record's arguments are cut as arguments are, and its reason is capped as an inspection's is.

The deployment-wide store keeps each field once (kind, time, admin, and an access record's
workspace id and title in columns, the rest as JSON) and cuts the title itself, whatever its caller
sent. The title is the one field of a record that a workspace member writes, and it has no length
limit of its own: kept whole, an over-long title would overflow the row (the platform caps one at
8 MiB), failing every audit write and so refusing every investigation of that workspace, or push a
listing past the RPC size limit.

The store's table keeps `exposed` in a column with an index (`admin_audit_exposed`): `append()`
writes an access record's `exposed` there, leaving it out of the JSON so that the field is stored
once, `metadata` for a record of a call into a user's account, and nothing for a setting, a write
or a grant record. The column is what the `exposed` filter and
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
The write, approval and ending records a workspace appends pass none either; a content access
request's and a denial's pass the committed retention.

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

The statistics also count the writes in the window (`writes`: its write records). Only write
records are writes, so `writes` is 0 for the other kinds.

They count the content reads in the window too (`contentReads`: the access records whose `exposed`
is `"content"`), which is 0 for the other kinds for the same reason.

The Audit tab shows the week's total, its count per day, its most active admins, its writes and
its content reads, each record's kind (Workspace access, User access, Workspace write, Content
grant, Setting change), and each call's or write's target user (a workspace's owner, or the user whose
account was inspected) in a column of its own. A workspace access record carries a badge for what
it exposed, colored only for a content read, and, opened, what its view was opened for, the grant
it ran under and the refusal it carries. The tab filters its log by admin, action, kind,
workspace, target user and what a call exposed; the count of content reads opens the log filtered
to them. A write record, opened, shows its workspace, reason, arguments and `via`; a grant record
its workspace, request, reason, who requested it, and the grant or end reason it carries. Above the
log, the tab lists the content access requests pending (see
[Asking for content without the owner](#asking-for-content-without-the-owner)).
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
| `ADMIN_WORKSPACE_CONTENT_OFF` | The level in force is below `"content"`: an open asking for content, a content read on a view opened for it, an owner's grant or renewal, the account-wide grant, and a content access request, its approval or its grant. |
| `ADMIN_WORKSPACE_WRITES_OFF` | `ADMIN_WORKSPACE_WRITES` is not `on`: a write, refused by `AdminApiImpl` or by its workspace. |
| `ADMIN_CONTENT_NOT_REQUESTED` | A content read on a view opened for metadata. Inspect again, asking for content. |
| `ADMIN_GRANT_REQUIRED` | A content read with no live grant for the workspace: its owner can give one, or a second admin can approve a request for one. |
| `ADMIN_GATEKEEPER_OFF` | The deployment has turned the admin gatekeeper off: a lend to it, or a call through one. An action it refuses stays pending. |

The grant methods refuse with a code from `ADMIN_GRANT_ERROR_CODES` (read with
`getAdminGrantErrorCode()`):

| Code | When |
| --- | --- |
| `ADMIN_GRANT_NOT_FOUND` | `renewAdminAccess()` for an id that names no live grant of the owner's on the workspace; `revokeAdminAccess()` for one that names no grant of the owner's there; `endWorkspaceGrant()` for one that names no live grant with source `"admins"`. An approval's grant is not the owner's, and an owner's is not an admin's to end. |
| `ADMIN_GRANT_REQUEST_NOT_FOUND` | No content access request has that id. A request is forgotten a day after it is resolved. |
| `ADMIN_GRANT_REQUEST_NOT_PENDING` | The request was approved, denied or has expired, or the workspace already gave its grant. |
| `ADMIN_GRANT_REQUEST_PENDING` | A request for the same workspace is pending. |
| `ADMIN_GRANT_TOO_MANY_REQUESTS` | `MAX_PENDING_CONTENT_REQUESTS` (50) requests are pending across the deployment, or, for a request filed through an agent, `MAX_PENDING_AGENT_CONTENT_REQUESTS` (10) of those. |
| `ADMIN_GRANT_WORKSPACE_UNLISTED` | A request for a workspace the directory does not list: whoever approves must see its owner. |
| `ADMIN_GRANT_WORKSPACE_CHANGED` | An approval reached a workspace whose owner is not the one the request named, so no grant was given. |
| `ADMIN_GRANT_SECOND_ADMIN_REQUIRED` | The admin who made a request, or anyone who was in the workspace an agent filed it from, tried to approve it, or the workspace was handed such an approval: another admin must approve it. |

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
  workspace owner alone, a current one left alone, the log of a build without content reads or
  grant records rebuilt row for row and given a content read, and a later one kept, logged and
  still appended to; across it, the numbering goes on from the highest sequence number issued,
  whatever was pruned.
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

Writes add these, in the same directory:

- `admin-access.test.ts` also covers the writes switch: off while unset, blank or `off`, on for
  `on` alone, and off for anything else, reported once and never with the value.
- `admin-writes.test.ts`: the arguments each action takes and refuses.
- `admin-write-apply.test.ts`: `applyAdminWrite()` on a real workspace. The refusals that write
  nothing, each action running its one operation, a stop that keeps the queued messages and reads
  as any stop, the record before the effect, a workspace deleted while its write runs, and an
  action log that gains no entry and tells its sessions of none.
- `admin-api-impl.test.ts` also covers `AdminApiImpl.writeWorkspace()`: the checks before anything
  is touched, what the workspace is handed, and a missing workspace dropped from the directory.
- `admin-audit.test.ts` also covers write records in the log's listing, filters and statistics,
  and the rebuild of a table that knows no write records, which keeps every row, kind and
  sequence number.

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
- `admin-content-requests.test.ts`: the store of content access requests. A request and a denial
  recorded before they are stored; one pending request per workspace and the deployment-wide cap;
  the claim of an approval, once, refused to the requester (two casings of one admin included)
  and below `"content"`; the settling of the workspace's answer; and the sweep that expires,
  fails and forgets requests, recording nothing.
- `admin-write-apply.test.ts` also covers `grantAdminContent()`: the grant stored after its
  record, with no action log entry, event or notification; the requester, an admin no longer one,
  another owner, a request given twice and a level below `"content"` refused before any record;
  and `endAdminGrant()`, its record before the effect, and an owner's grant refused.
- `admin-api-impl.test.ts` also covers an open for content, refused and recorded below
  `"content"`; the content access methods: a request refused below `"content"` or for a workspace
  the directory does not list, nothing stored, the directory's title and owner stored, an
  approval that claims, has the workspace give the grant and settles it; and
  `endWorkspaceGrant()`.
- `deployment-admins.test.ts`: how a name matches the `ADMINS` list, and `sameDeploymentAdmin()`:
  names that differ only by the case of ASCII letters are one admin.
- `git-cache.test.ts` also covers `readLocalFileAtCommit()`: text, a stream for a large file or
  one that is not text, a symlink and a submodule, and never a pull.

The admin gatekeeper adds these, in the same directory (its own suites are listed in
[its README](../packages/gatekeeper-admin/README.md#tests)):

- `admin-agent-kinds.test.ts`: every `AdminApi` method classified, the seven action kinds with a
  tag each, their methods (an assignment's two) and their verdicts, and the constants.
- `admin-agent.test.ts`: the membrane. What `adminAgentRefusal()` refuses under a session and
  under each action kind; `restrictAdminApi()`'s checks in their order, an action's one call, a
  lend that ended or ran out; and a view behind it, of a workspace or of a user's account, which
  answers its own methods and no other name, ends with the lend and lives no longer than the
  lend has left.
- `admin-agent-lend.test.ts`: `lendAdminApi()` on a real workspace. A session's reads and what
  each records, with `via` `"gatekeeper"`, the workspace and the chat, a view of a user's
  account included; an approved action's one call; restricted data, marked by a read and
  refusing a rule's approval afterwards; who is lent
  nothing (the vendor off, an owner who is not an admin or holds no account, a member's direct
  session); the insiders of a request for content, with a second admin who collaborates in the
  workspace; and a spawned chat without the binding named.
- `admin-workspace-admission.test.ts`: the admission rule at each gate, for a workspace with the
  connection, for one that had it and read nothing, and for one that read through it, a
  non-admin kept in the sharing list included.
- `provisioning-policy.test.ts` and `user-ambient-accounts.test.ts`: the gatekeeper's mode,
  Disabled until an admin chooses, and its account offered, provisioned and listed for
  deployment admins alone, in each mode.
- `admin-access.test.ts`, `admin-api-impl.test.ts`, `admin-audit.test.ts`,
  `admin-workspace-view.test.ts`, `admin-user-view.test.ts`, `admin-content-requests.test.ts` and
  the write suites also cover
  a caller's `via` and `agent` checked in one place, before any terms reach a workspace or an
  account, and kept on each record, `isRequestInsider()` at the claim and in the workspace, and a
  view opened for one issue report.

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
  approval of another admin's request, which only an admin ends; a request denied, withdrawn and
  refused below level content; an owner shown nothing of an approval's grant; and a deployment
  with one admin left only the owner's grant.
- `workshop-admin-writes.test.ts`: writes end to end. A write refused to a non-admin, whose
  capabilities run none; a write recorded once, before the effect, with nothing entered in the
  workspace's action log; a stopped turn that reads as any stop; a failed write's record kept;
  nothing changing when the record cannot be written; every action as its operation,
  and anything else refused; a workspace that is gone; and every write refused once a redeploy
  leaves `ADMIN_WORKSPACE_WRITES` unset.

- `admin-gatekeeper.test.ts`, `admin-gatekeeper-actions.test.ts` and
  `admin-gatekeeper-hooks.test.ts`: the admin gatekeeper end to end, with a scripted model. Who
  is offered it; an agent's view calls recorded as made through the gatekeeper, and content read
  only where the workspace's own check allows it; the admins-only workspace, while it has the
  connection and after; a content request no member of the workspace can approve; a public
  reply through the binding held for a person whatever the rules; a note, a status and a write
  request applied by their rules; the restricted-data mark and its order; the session limited
  to one report, its reply reaching the reporter with no person only before anything was read,
  and the mark its reads make; the three hooks firing into a gadget's stored callback, once for
  each kind of change to a report, each event marking the workspace; two admins'
  workspaces claiming one report, of which exactly one holds it; and a spawned agent handed
  one report's session.

The integration suite reaches Durable Object storage directly (see
[integration-testing.md](integration-testing.md#reaching-a-durable-objects-storage-from-a-test)): it
faults the deployment-wide log with a trigger on `admin_audit`, shows that an inspected deleted
id stays unwritten by listing its `sqlite_master`, and shows that a call into an account wrote
nothing by reading the account's `total_changes()` before and after it.

Frontend suites, in `packages/workshop-frontend/src/`:

- The suites beside the Audit tab cover the write and grant kinds, their filters and their records'
  details, and, for content, the badge for what a call exposed, its filter, the count of content
  reads, the grant and the refusal a record carries, and the access setting's Content option under
  each cap.
- `pages/admin-workspace/AdminWorkspacePage.test.tsx`, with a browser test beside it: an admin's
  page for one workspace, its live grants, ending one a second admin approved, and Request
  content access pointing to the pending approvals.
- `features/admin-grants/PendingApprovalsCard.test.tsx` and `AdminPage.test.tsx`: the Audit tab's
  pending approvals, Approve and Deny on other admins' requests, and an admin's own request shown
  as waiting for another admin.
- `features/admin-audit/AdminAuditPanel.test.tsx` and `PendingApprovalsCard.test.tsx` also cover
  a record and a request made through the admin gatekeeper: the "Agent" label, and the workspace
  and the chat it came from. `ShareModal.test.tsx` covers the reason shown when adding someone to
  an admins-only workspace is refused, and `ResourcePicker.test.tsx` and `GatekeeperModal.test.tsx`
  the picker's row that adds an auto-provisioned account.

The CLI's suites, in `packages/api-cli/`, pin the `cf-os api` commands for grants, content reads
and issue reports, and `--out <file>` saving the byte stream a result holds inside it.
