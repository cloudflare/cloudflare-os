# Admin access: operating and investigating a deployment

A deployment's admins (the canonical user ids its backend Worker's `ADMINS` variable lists) need to
operate, debug and investigate the instance: find a user or a workspace, look inside a workspace
that misbehaves, and know afterwards who looked at what and who changed which setting. Where the
deployment's environment allows it, they can also change a workspace, through a request that an
admin approves with a passkey (see [Writes](#writes)). This
document is the design record for that surface. The API itself is documented on `AdminApi` and
`AdminWorkspaceView` in `packages/workshop-shared/src/api.ts`; the pieces are:

| Concern | Location |
| --- | --- |
| Admin status | `packages/workshop-backend/src/auth/config.ts` |
| The environment's bounds, validation, the audit's text bounds | `packages/workshop-backend/src/admin-access.ts` |
| The `AdminApi` capability (`AdminApiImpl`) and the settings audit (`AdminSettings`) | `packages/workshop-backend/src/admin-settings.ts` |
| Diffing a settings change (`diffAdminConfig`) | `packages/workshop-backend/src/admin-config.ts` |
| The deployment-wide audit log (`AdminAuditDurableObject`) | `packages/workshop-backend/src/admin-audit.ts` |
| The user and workspace directory (`UserDirectoryDurableObject`) | `packages/workshop-backend/src/user-directory.ts` |
| Inspection (`openForAdmin`, `AdminWorkspaceViewImpl`) and the workspace's directory feed | `packages/workshop-backend/src/overseer.ts` |
| Reads that never pull (`readLocalCommitTree`, `readLocalFileAtCommit`, `readLocalFileAtCommitIfExists`, `localPathEntryAtCommit`, `changedLocalFilePathsBetween`, `readCommitLog` with `stopAtMissing`) | `packages/workshop-backend/src/git-cache.ts` |
| The admin panel's Audit tab | `packages/workshop-frontend/src/features/admin-audit/` |
| The writes switch (`adminWorkspaceWritesEnabled`) and the passkeys' origin and relying party (`adminPasskeyRelyingParty`) | `packages/workshop-backend/src/admin-access.ts` |
| Verifying a passkey's registration and its assertions (`verifyPasskeyRegistration`, `verifyPasskeyAssertion`) | `packages/workshop-backend/src/webauthn.ts` |
| What a write request is computed from alone: its arguments, the digest an approval signs, a challenge, its title in the action log (`adminWriteArgs`, `adminWriteDigest`, `newPasskeyChallenge`, `adminWriteTitle`) | `packages/workshop-backend/src/admin-writes.ts` |
| Passkeys, write requests and their approval (`AdminSettings`, `AdminApiImpl`) | `packages/workshop-backend/src/admin-settings.ts` |
| Running an approved write (`applyAdminWrite`, `runAdminWrite`) | `packages/workshop-backend/src/overseer.ts` |
| The page on which an admin approves a write | `packages/workshop-frontend/src/pages/admin-write-approval/` |
| The Access tab's passkeys card, and the browser's side of a passkey ceremony | `packages/workshop-frontend/src/features/admin-writes/` |

## Entry points

Everything goes through `AuthenticatedApi.getAdminApi()`, which returns null unless the
caller is an admin. The admin check runs once, when the capability is minted, for every `AdminApi`
method except workspace inspection, which checks again (see [Inspection](#inspection)), and the
write-request and passkey methods, which check on every call (see [Writes](#writes)).

- **Settings**: the setters (signups, user search, site name and logo, instructions,
  resource and gatekeeper availability, models, update checks, ...), plus
  `setAdminWorkspaceAccess()` and `setAdminAuditRetentionDays()`. Every setter is audited.
- **The directory**: `listUsers()` and `listWorkspaces()`.
- **Inspection**: `inspectWorkspace(workspaceId, reason, { lifetimeSeconds, access })`, which
  returns an `AdminWorkspaceView` at the lower of the level asked for (`"metadata"` by default) and
  the deployment's.
- **The audit log**: `listAdminAudit()` and `getAdminAuditStats()`.
- **Writes**, while the deployment's `ADMIN_WORKSPACE_WRITES` is `on`:
  `requestWorkspaceWrite(workspaceId, action, args, reason)`, `getWorkspaceWrite()` and
  `denyWorkspaceWrite()` for a request; `beginWorkspaceWriteApproval()` and
  `approveWorkspaceWrite()`, which approve one with a passkey and run it; and, for the passkeys
  themselves, `listAdminPasskeys()`, `beginAdminPasskeyEnrolment()`, `addAdminPasskey()`,
  `beginAdminPasskeyRemoval()` and `removeAdminPasskey()`. The listing and the two removal methods
  answer while writes are off too.

Each record's `via` (`AdminVia`) comes from the session's User-Agent: `"cli"` when the `/api`
upgrade names `cf-os api` (`cf-os-api/<version>`), `"api"` for any other client, the Workshop's
admin panel included. A client can send any User-Agent, so it labels records and grants nothing.
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

`AdminApi.inspectWorkspace()` validates the reason, the lifetime and the level asked for,
re-checks that the caller is an admin, reads the access policy from the authoritative
`AdminSettings` config (not the KV mirror: a mirror still saying `"full"` after an admin lowered the
level must not mint a view at the old one), and then calls
`OverseerDurableObject.openForAdmin(adminId, reason, sessionId, terms)`. The terms carry the level
asked for (`requested`) and the view's own `access`, the lower of that and the authoritative policy.

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
- rejects malformed terms with a `TypeError`, unrecorded: a blank or over-long reason, a `via` that
  is not `"api"` or `"cli"`, an `access` or a `requested` that is not `"metadata"` or `"full"`, an
  `access` above `requested`, and an expiry that is not a valid time or lies beyond the longest
  lifetime. An expiry already past when the workspace answers is not malformed: the open is refused
  as any call on an expired view is (`viewExpired`, unrecorded), so a slow hop never surfaces as a
  validation error.

The view (`AdminWorkspaceViewImpl`) is not an `Overseer`. It joins no presence, session count or
outputs fan-out, and starts no agent, ambient capsule or gatekeeper facet; waking the Durable Object
still resumes turns a previous instance left running, as any wake does. It offers these reads,
shaped as the matching `Overseer` reads are where there is one:

- **The workspace**: `describe()` and `getDiagnostics()`, whose counts come with the size of the
  workspace's storage and who has it open.
- **Chats**: `listChats()`, `getChat()`, `getChatState()`, `listChatAttachments()` and
  `readChatAttachment()`. `getChatState()` is the state behind a chat that looks stuck: the agent
  turn recorded for it, running or paused, when its newest entry was written, the calls queued for
  its agent, and the actions it submitted that still wait for approval.
- **Actions**: `listActions()`.
- **Code**: `listFiles()` and `readFile()` read a gadget's committed head. `getCommitLog()`,
  `listFilesAtCommit()`, `readFileAtCommit()` and `listChangedPaths()` read a gadget's history and
  any version of its code. `listPendingChanges()` and `readPendingFile()` read what a chat changed
  on top of each pin's base and has not had accepted.
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
  proposed blueprint merge), `listChangedPaths(mergedCommit, baseCommit)` is the rest of what
  accepting would change, and the listed paths can be empty while there is a change to accept. The
  one entry it lists with no base is a gadget the chat created and has not had accepted (a
  worktree is pinned at its first modification, so it always has one).
- **`listAutoApprovals()` lists opt-ins, which apply nothing alone.** They are the rules members
  turned on. An action is applied without a manual approval only when its author also marked it
  `autoApprovable`, and never once the workspace has read restricted data: the rules stay stored
  and listed, and every action waits. A view shows both conditions, which is how an admin answers
  why an action still waited: `describe()` reports `containsRestrictedData`, and `listActions()`
  keeps each action's `autoApprovable` verdict and kind at every level, with `autoApproved` on one
  a rule applied.

An admin read never reaches a connection, and reads only what the workspace stores:

- **Commits.** `listFiles()` and `readFile()` read a permanent gadget's committed head.
  `listFilesAtCommit()`, `readFileAtCommit()`, `getCommitLog()` and `listChangedPaths()` take any
  commit the workspace stores (a gadget's history, a worktree's commits, a chat pin's base) and
  refuse anything else. All of them read only stored objects, through the local readers of
  `git-cache.ts`: `readLocalCommitTree`, `readLocalFileAtCommit` and
  `changedLocalFilePathsBetween`, built on `readLocalObject`, and `readCommitLog`, which reads only
  the commits the store holds. The ordinary reads pull a missing object through the workspace's
  connections; these never do. A missing object is an error, not a fetch. `getCommitLog()` stops
  at a parent that is not stored (`stopAtMissing`), which is how a worktree checked out without
  its history lists.
- **Commits a connection supplied.** A stored commit can be one a connection supplied. A worktree
  checked out through a connection holds that repository's commits
  (`WorktreeRecord.sourceGatekeeperId` names the connection; a worktree made from a commit that no
  connection is recorded as a source of, such as one in a gadget's history that was never pushed,
  names none), and the workspace stores what it pulled. The commit reads treat those commits as
  any other: at `"metadata"` they show the repository's file names, commit ids, authors and times,
  and the paths that differ between two of its commits; at `"full"`, its files and commit
  messages. The connection is never asked, so the admin is not verified against the repository,
  and reads no more of it than the workspace already holds. This is the part of the
  [admin exception](observers.md#admin-access-a-deliberate-exception) that these reads widen.
- **A chat's pending content.** `listPendingChanges()` and `readPendingFile()` use the fold the
  members' sessions use (`getCurrentChatContent()`), given a base reader that reads stored objects
  only (`readLocalFileAtCommitIfExists`), where the sessions' reader pulls. The fold's cache stays
  valid whichever reader filled it, because a commit is immutable: a reader that succeeds returns
  the same text, and one that cannot read a base throws. `listPendingChanges()` tells a worktree's
  paths apart by what its base holds at each (`localPathEntryAtCommit`), reading no blob.
- **Attachments.** An attachment is read from its record's own bytes or its stored blob, and a
  legacy one from the file at its stored commit.
- **What a connection could answer** is read from the workspace's records instead: observer
  requirements from the connections' records and the action log's index, auto-approvals from the
  stored rules (never `listPreApprovableActions()`, which asks each connection), and connections
  from their records.

Beyond the workspace's own storage, a view reads only its owner's profile, from their account: in
`describe()`, and in `listShareLinks()`, which uses the same lookup and only when the owner created
a link.

### Who created a connection

A connection records its creator (`GatekeeperRecord.createdBy`): the member whose session made it
(`newGatekeeper()`, `newAiModelGatekeeper()`, `newAgentSpawnerGatekeeper()`), or the initiator of
the agent turn whose `createExternalResource` call created its resource. `listGatekeepers()` shows
the creator at every level.

Two kinds of connection have none:

- **An ambient capsule**, because no person created it. A workspace installs one on open for each
  singleton account its owner holds (the Context Library's, for one), so it comes from the owner's
  own account of that vendor, and a workspace whose owner has none has no such connection.
- **A connection whose creator was not recorded**: one written before creators were recorded, or a
  resource created in a turn that has no record.

### The level an inspection asks for

An inspection asks for `"metadata"` (the default) or `"full"` (`AdminInspectOptions.access`), and
its view gets the lower of that and the deployment's effective level.
Asking for `"full"` where the deployment allows only `"metadata"` is not an error: the view opens at
`"metadata"`, and its `describe()` reports the level granted. While the effective level is `"off"`,
every open is refused, whatever it asks for. Any other level is refused with a `TypeError` before
the open runs, by `AdminApiImpl`'s RPC validation.

Every record the view makes keeps the level asked for (`requested`) beside the level the call ran
at (`access`). Reading content is therefore a separate step: an investigation starts at
`"metadata"`, and moves to `"full"` deliberately, in a new `inspectWorkspace()` call with a reason
of its own, and the log shows when it did.

A view never rises. Its level is fixed when it is minted, and later calls only lower it (see
[Each call](#each-call)): raising the setting leaves a view that asked for `"full"` but got
`"metadata"` at `"metadata"`, and the admin inspects again to read content. `openForAdmin()` rejects
terms whose `access` is above `requested`, so no caller can mint a view above what it asked for.

### Each call

Every view method, the open included, runs through `#call()`:

1. The view's checks: it has not expired (`viewExpired`), its admin is still an admin (`notAdmin`),
   and the workspace still exists (`workspaceNotFound`). A call these stop is not recorded.
2. The deployment's setting is read (`readAdminConfig`, the KV mirror).
3. The checks again, since that read may have spanned the expiry, a demotion or the workspace's
   deletion.
4. The level the call runs at: the view's own (the lower of `requested` and the deployment's level
   when it was minted), lowered to the current setting and the environment's cap. Lowering the
   setting reaches live views within about a minute (the KV mirror's propagation); raising it never
   raises a view.
5. A call that level refuses is recorded, exposing `"metadata"` and with `refused` set, and then
   refused without reading anything: `accessOff` once the level is `"off"`, `contentWithheld` below
   `"full"` for a method that reads only content (`getChat()`, `readChatAttachment()`,
   `readFile()`, `readFileAtCommit()`, `readPendingFile()`). Its record is sent with nothing
   awaited after step 3's check.
6. The read, on the server and never through a connection. A read that throws is recorded as an
   attempt exposing `"metadata"`, once the checks pass again, and the call fails with the read's
   error: a missing object, a gadget whose code is pending, an invalid path, a commit that is not
   stored, a chat that does not exist. `listObserverRequirements()` throws, as the members' call
   does, for a legacy connection (one made before connections could verify collaborators) in the
   scope of the grant it was asked about: any such connection for `"workspace"`, and for a gadget
   only one the gadget reaches. A malformed string argument (a commit id, a path, an attachment
   id) is checked inside the read, so it is recorded this way. A number out of range is not:
   `getCommitLog()`'s `depth` outside 1 to `MAX_ADMIN_COMMIT_LOG_DEPTH`, like `listActions()`'s
   invalid `beforeId`, is rejected before the call starts, and is not recorded.
7. The checks again, with nothing awaited before the record is sent, since the read may have
   awaited. A call that expiry, a demotion or the workspace's deletion overtakes while it reads
   writes nothing, appends nothing for the workspace and returns nothing.
8. What the call exposed (`exposed`), computed from the answer it read (see
   [What a call exposed](#what-a-call-exposed)).
9. The record, in the deployment-wide log.
10. The answer.

The record follows the read because it says what the call returned, which only the answer can
tell. The point a record must precede is the answer leaving the server, since that is what an admin
sees. Holding the answer until its record exists means that nothing reaches an admin unrecorded and that a call whose record
cannot be written returns nothing, and a call its level refuses is still recorded without reading
anything. An answer that never left the server, because its record failed or the view stopped
meanwhile, exposed nothing. No check follows the append: the answer was read while the view was
live, and its record exists.

An answer can be a `stream`: a file over `MAX_BUFFERED_BLOB_SIZE` (1 MiB) from `readFile()` or
`readFileAtCommit()`, and from `readPendingFile()` a pending text that large or any file a chat
holds as bytes. Step 10 returns the stream, not its bytes. They are read as the caller pulls them,
after the record: from the stored blob, or, for a pending text, from a copy of its UTF-8 encoding
that the answer holds until the stream ends. The record precedes the answer, and an answer in
flight is not another use of the view, so:

- **The stream is part of the recorded answer.** Its record, exposing `"content"`, exists before
  the first byte leaves, and counts the file whole, whether or not the caller reads it to the end.
- **Nothing checks the view again while the bytes flow.** A stream that has started runs to its
  end after the view expires, its admin is demoted or the setting is lowered: those stop the next
  call, not an answer already recorded. A workspace restart ends it, as it ends every session's
  streams.

This matters most for `readFileAtCommit()`, which reads any stored commit, a repository a worktree
checked out included, where a file can be far larger than a gadget's.

A view lasts `DEFAULT_ADMIN_VIEW_LIFETIME_SECONDS` (15 minutes) unless the open asks for up to
`MAX_ADMIN_VIEW_LIFETIME_SECONDS` (an hour). A workspace restart (a revocation, a deletion, a
redeploy) ends every view along with every other session on it; inspect again.

## Writes

An admin can also change a workspace: stop or retry an agent, restart the workspace, add a
collaborator, delete or revert a chat, restore or delete a gadget, reject a stuck queue of pending
actions, remove a connection, delete the workspace. Writes are off unless the deployment's
`ADMIN_WORKSPACE_WRITES` is `on` (see [The environment's bounds](#the-environments-bounds)), and a
write takes two steps: any admin session requests it, and an admin approves it with a passkey on a
page of the Workshop. Only then does the workspace run it, as the operation a member would run.

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
4. the workspace id's form (`workspaceNotFound` for a malformed one);
5. that the deployment has a `PUBLIC_BASE_URL` (`originUnset`): without one there is no page to
   approve the request on;
6. that the directory lists the workspace (`workspaceUnlisted`);
7. that fewer than `MAX_PENDING_ADMIN_WRITES` (50) requests are pending across the deployment
   (`tooManyRequests`).

The request is then recorded (`"requested"`) and, only once its record exists, stored.

- **It never reaches the workspace.** The title and the owner a request carries are the
  directory's, the unrecorded finding aid, as they are for an open refused before it reaches a
  workspace. Whether a chat, a gadget or a connection the arguments name exists is found out only
  when the write runs.
- **A workspace the directory does not list cannot be requested.** The approval must show whose
  workspace it changes, and the directory lists a workspace once one of its members has opened it
  (see [What the lazy backfill misses](#what-the-lazy-backfill-misses)).
- **It lasts ten minutes** (`ADMIN_WRITE_REQUEST_LIFETIME_SECONDS`), after which it is recorded
  `"expired"`. It ends the same way, sooner, when its requester stops being an admin: a request
  does not outlive its requester's admin status. `getWorkspaceWrite()` reads a request for a day
  after it is resolved.
- **It returns its approval URL**, `<PUBLIC_BASE_URL>/admin/approve/<request id>`. Opening the page
  needs an admin's session, and the URL grants nothing.

**The reason is written for the people who read the workspace's action log**: its owner and its
build collaborators. An inspection's reason stays in the admins' log. A write's is shown to those
people word for word once the write is approved, and for `addCollaborator` it is kept in the
collaborator's note too, so it must not hold what they should not read. The approval page repeats
this beside the reason.

`denyWorkspaceWrite()` ends a pending request, recorded (`"denied"`) before it is stored as such.

### Approve

The page at the approval URL shows the workspace's title and id, its owner, the action, each
argument, the reason, who requested it and how (`via`), and when it expires. It shows what the
request stores, and looks nothing up in the workspace:

- **Ids are shown as requested.** A chat, a gadget, a connection or a version is the id the
  request names, so an approver checks what it names with an inspection first. Where the
  deployment's access level is `off` there is no inspection to check it with, and the page states
  that instead.
- **What the request does not say, the page adds**: that a retried turn is paid for by the owner,
  that an added collaborator reads the workspace whatever the read cap, that a completed deletion
  is shown to nobody in the workspace, and that rejecting a pending creation removes its
  connection.

The admin confirms with **Approve with passkey**, or denies.

**The challenge** (`beginWorkspaceWriteApproval()`) is 32 random bytes followed by the SHA-256 of
the request's canonical JSON (`adminWriteDigest()`: its id, workspace id, title and owner, action,
arguments, reason, requester, `via`, and the times it was made and expires), so the authenticator
signs what is approved. An admin has one approval challenge outstanding: beginning another
replaces it. It lasts five minutes (`ADMIN_PASSKEY_CHALLENGE_LIFETIME_SECONDS`) and never past its
request's expiry, and it is deleted before anything about its answer is checked, so its first
answer spends it, right or wrong. An admin with no passkey of their own is refused
`passkeyRequired` here.

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

**Every attempt on a stored request that is refused `passkeyRefused` or `requestNotPending` is
written to the audit log**, as a `"refused"` write record with the admin who tried, the check that
failed (`refusal`) and, when the answer named one of that admin's own, the passkey. A failed
passkey check leaves a pending request pending, and the caller is told only `passkeyRefused`,
never which check it was. An attempt on a request that is no longer pending, such as an approval
sent a second time, is recorded the same way and refused `requestNotPending`. Its record can
follow any other step, a closing one included: when a second admin loses the race to approve, or
an approval is sent again while the first is still running, it precedes the closing record, and
often the workspace's `"approved"` too. A refusal whose record cannot be written is still a
refusal: nothing was approved. An attempt refused `notAdmin` or `writesOff` is not recorded:
`AdminApiImpl` refuses it before `AdminSettings`, which holds the request, is reached (see
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
- **refuses a workspace whose owner is not the one the approval page showed**
  (`workspaceChanged`). A deleted workspace's id can be initialised again for someone else, and
  the approver confirmed a write to the first owner's workspace;
- **appends the `"approved"` record, with the passkey that signed, before anything changes.** A
  write whose record cannot be written does not happen. Nor does one whose workspace is deleted
  while the record is appended: the record is kept, and nothing follows it;
- **writes the write's entry in the workspace's action log**, for every action (see
  [Who sees a write in the workspace](#who-sees-a-write-in-the-workspace));
- **then runs the operation** (`runAdminWrite()`). If it throws, the entry is turned `"rejected"`
  and the error is what the request fails with.

As for an inspection, by explicit policy the admin is not checked by `authorizeCollaborator()` or
observer verification, and joins no session, presence or outputs fan-out. Unlike an inspection,
which starts nothing, a write does what its operation does for a member. So it calls gatekeepers:
a rejected action is reported to its connection's gatekeeper, and hooks are disabled at theirs
when a gadget, a connection or the workspace is removed. And `retryAgent` starts an agent turn.

Each action runs the `OverseerImpl` operation that a member's session runs for it:

| Action | Arguments | Operation |
| --- | --- | --- |
| `stopAgent` | `chatId` | `Overseer.stopAgent(chatId)` |
| `retryAgent` | `chatId`, and `modelId`, optional | `Overseer.retryAgent(chatId, modelId)`, as the workspace's owner |
| `restartWorkspace` | none | Ends every session on the workspace, as a revoked collaborator does |
| `addCollaborator` | `username`, `grant`, and `note`, optional | `Overseer.addCollaborator(username, grant, note)`, as the workspace's owner |
| `deleteChat` | `chatId` | `Overseer.deleteChat(chatId)` |
| `revertChat` | `chatId`, `revertFrom` | `Overseer.revertChanges(chatId, revertFrom)` |
| `revertGadget` | `gadgetId`, `commitId` | `GadgetClient.restoreVersion(commitId)` |
| `deleteGadget` | `gadgetId` | `GadgetClient.remove()` |
| `deleteWorkspace` | none | `Overseer.deleteSelf()` |
| `rejectPendingActions` | `gatekeeperId`, optional | `Overseer.rejectAction()`, for each pending action |
| `removeConnection` | `gatekeeperId` | `GatekeeperClient.remove()` |

Restoring a workspace after its deletion is not among them: a deletion erases the workspace's
storage, so there is nothing to restore it from. Five of them need more said:

- **`retryAgent` runs as the workspace's owner**, whoever started the turn it retries: on the
  owner's model, keys and account, so **the owner pays for it**, as if they had retried it
  themselves. Only the retry's message is the admin's. Left without a model, it takes the model of
  the chat's most recent agent message, and fails when the chat has none or the owner can no
  longer run that model.
- **`addCollaborator` is granted as if by the owner.** Only a grant from someone who holds `build`
  confers access, and the admin holds none. So it is made **on a workspace where only the owner
  may add people too**, and the admin may add anyone, themself included, which is how writes
  outrank the read cap (see [The environment's bounds](#the-environments-bounds)). A grant the
  owner had already made to that person is kept or widened, never narrowed, and its note
  replaced. The note names the admin and the reason until the owner next changes the grant; the
  action log keeps both. The person added is still verified as an observer, with their own
  accounts, when they open the workspace.
- **`revertGadget` is `GadgetClient.restoreVersion()`**: a commit on top of the head that holds an
  earlier version's files, with that operation's own refusals (a version that is not on the head's
  first-parent history, one with a blueprint update merged since, one whose files cannot be
  read). Only code is restored: the gadget's stored data stays as later versions left it.
- **`rejectPendingActions` rejects at most `MAX_ADMIN_REJECTED_ACTIONS` (500) a request**, oldest
  first, and never drains auto-approvals, so an admin never becomes the initiator of a resumed
  turn. Left without a connection, it rejects every connection's queue. It leaves pending, and
  reports, an action a gatekeeper would not reject, and it rejects an action whose connection was
  removed with no gatekeeper to tell, as `Overseer.rejectAction()` does for a member. **It can
  remove a connection**: a pending creation is rejected as a member's rejection of it is, together
  with the connection it would have created, which is removed, and with everything queued on that
  connection, however much (the bound of 500 is on rejections made one by one). The request's
  `outcome` counts the actions rejected, those that remain, those that could not be rejected and
  the connections removed that way. The approval page says that a creation's connection goes with
  it, before the admin confirms.
- **`deleteWorkspace`** is the one write nothing in the workspace shows once it completes (see
  [Who sees a write in the workspace](#who-sees-a-write-in-the-workspace)).

### Who sees a write in the workspace

Unlike an inspection, a write is entered in the workspace's action log: an `ActionLogEntry` marked
`byAdmin`, with no connection, whose title names the write (`adminWriteTitle()`, built from the
action and its numeric ids alone), whose `resolvedBy` is the admin who approved it, and whose
fields give the reason, word for word, and the request's id, after the account named when the
write adds a collaborator. It is delivered live through `subscribeToActions()` and paged by
`listActions()`, and the workspace's activity shows it as a deployment admin's. That is who did it
and why.

**It reaches whoever reads the action log: the workspace's owner and its build collaborators.** A
collaborator who was only given a gadget has no action log (a `use` session's is always empty), so
they are shown nothing when an admin deletes or restores the gadget they use, or restarts the
workspace, and no notice is added for them.

The entry is written before the workspace changes, for every action, so that no admin write is
missing from the log. It is `"approved"` from then on, and turns `"rejected"` if the workspace
could not run the write. It is therefore not proof that the write completed: a write cut short
(the object lost midway) leaves an `"approved"` entry, and a `"failed"` record in the audit log.

**A deletion that completes is the one write nothing in the workspace shows.** This is a decision:
its entry is deleted with the action log and the workspace, and no notice is sent to the owner or
the collaborators. A session open at that moment may be delivered the entry in the instant before
it is ended; nothing remains to read afterwards. The deployment-wide audit log holds who deleted
the workspace and why. A deletion that fails before the workspace is gone (a hook that cannot be
disabled stops it, after its live chats were ended and earlier hooks disabled) leaves its entry,
`"rejected"`, like any other failed write.

An inspection reads the entry as it reads any other: its title, its state and `byAdmin` at every
level, and its fields, the reason among them, only at `"full"`.

### How a request ends

Every approved request ends `"applied"` or `"failed"`, each with its record. The session that
approved carries the workspace's answer back to `AdminSettings` (`settleWorkspaceWrite()`), which
stores it and then records it. If the client hangs up, the run and its settling continue under
`waitUntil()`. If the session's isolate is lost between its calls, the answer never arrives, and a
request still `"approved"` after fifteen minutes (`ADMIN_WRITE_SETTLE_SECONDS`) is settled as
`"failed"` with its outcome unknown. It is never run again. The closing record is written after
the fact, so it is retried until it lands, and may in rare cases appear twice.

`AdminSettings` keeps all of this moving with an alarm: it expires the overdue requests, fails
the approved ones whose answer never arrived, writes the closing records still owed, and forgets
a request a day after it is resolved and recorded. Every write-request method but the settling
runs the same sweep before it reads a request, so an overdue request is never read as pending.

How to read the records of one request (they share its `requestId`):

- `"failed"` with no `"approved"` before it changed nothing: the workspace refused the write
  before recording it, or was never reached.
- `"failed"` after `"approved"` may have changed the workspace in part or in whole. A restart or a
  deletion aborts the workspace about 100 ms after it answers, and an operation can throw partway.
- `"refused"` did nothing, wherever it falls. After a closing record it is an approval that was
  tried again. Before one it is a failed passkey check on a request still pending, or an attempt
  that found the request already approved: a second admin who lost the race to approve, or the
  same approval sent again while the first was still running.

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
   at once, whatever is enrolled.
3. **Read the audit log.** The `addAdminPasskey` record gives the session that enrolled the
   passkey, and every `"approved"` and `"refused"` write record names the passkey that signed, so
   the writes it approved can be listed.
4. **Have the account's owner remove the passkey**, once the account is secure and an admin again.
   A passkey can be removed only by the admin it was enrolled under, signing with a passkey they
   hold themselves: no other admin can remove it. Removal works while writes are off. An owner
   with no passkey of their own enrols one first, which needs writes to be on.

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

## Access levels and their bounds

### The levels

`adminWorkspaceAccess` is `"off"`, `"metadata"` (the default) or `"full"`, the most an inspection
gets (see [The level an inspection asks for](#the-level-an-inspection-asks-for)):

- **off**: `inspectWorkspace()` is refused.
- **metadata**: the workspace's structure. Withheld: chat messages and queued steers, chat
  attachments, file contents (at any commit, and pending in a chat), commit messages, the argument
  summaries of calls queued for an agent, which blueprint a gadget follows (`upstream`, a share
  link to code the view would otherwise withhold), the ids of the blueprints the workspace
  publishes (an id is a share link to the blueprint's code, as `upstream` is), and the
  descriptions and fields of actions, observations and hooks. Kept: titles (of the workspace,
  chats, gadgets, actions and resources), collaborators with the notes on their grants, observer
  records and their account ids, connections with their resource URLs and who created each, file
  names and changed paths, commit ids, authors and times, attachment names, types and sizes and
  each attachment's `oid`, share links' notes, blueprint titles and descriptions, and diagnostics.
  Titles, names, notes and a blueprint's description are written by members and agents and can
  echo content, restricted data included. A blueprint's description is kept, where the description
  of an action, an observation or a hook is withheld.
  - An attachment's `oid` is a hash of its bytes, which `listChatAttachments()` returns at
    `metadata`: it does not give the bytes, and it does tell whether two attachments are the same
    file, or the file a reader already has.
  - Commit messages are content: they show only at `full` (`getCommitLog()` empties them below
    it), where commit ids, authors and times show at `metadata`.
  - Both levels cover every commit the workspace stores, the ones a connection supplied included
    (a worktree's checkout): at `metadata` that repository's file names, commit ids, authors,
    times and changed paths, at `full` its files and commit messages, read from the workspace's
    copy and never by asking the connection (see [Inspection](#inspection)).
- **full**: everything, restricted data included.

### The environment's bounds

Two backend variables bound what admins may choose. They are environment variables for the reason
authentication config is (`auth/config.ts`): a compromised admin session must not be able to widen
them. A third, `ADMIN_WORKSPACE_WRITES`, is a switch with no admin setting under it, and an
environment variable for the same reason.

| Variable | Values | Default | Effect |
| --- | --- | --- | --- |
| `ADMIN_WORKSPACE_ACCESS_MAX` | `off`, `metadata`, `full` (any case, trimmed) | `metadata` (unset or blank) | The highest level admins may choose. Any other value is `off`, logged as an error: it bounds a security setting, so `none`, `false` or a typo of `off` must fail closed, never grant the default. |
| `ADMIN_AUDIT_RETENTION_MIN_DAYS` | a positive whole number of days, at most 3650 (`MAX_ADMIN_AUDIT_RETENTION_DAYS`); a larger value counts as 3650 | 90 (unset, blank or invalid; an invalid value is logged) | The fewest days the audit log keeps a record, whatever admins choose. |
| `ADMIN_WORKSPACE_WRITES` | `on`, `off` (any case, trimmed) | `off` (unset or blank) | Whether admins may request and approve [writes](#writes) to workspaces. Any other value is off, logged as an error, so `true`, `1` or a typo of `on` never enables them. |

The admins' choice is kept in `AdminConfig` as they set it, and `adminAccessPolicy()` holds it within
the bounds wherever it is enforced: `inspectWorkspace()`, every view call, the settings audit and
the audit log's own floor. `getSettings()` reports `chosen`, the bound
(`max` or `min`), and `effective`, which is what is enforced. The setters refuse a value outside the
bounds, naming the variable; a choice stored before a bound tightened is kept but not enforced.
`"full"` therefore takes a deployment config change.

`ADMIN_WORKSPACE_WRITES` has no choice under it: `getSettings()` reports it as
`adminWorkspaceWrites`, true or false, and no setter changes it. `adminWorkspaceWritesEnabled()` is
the only code that reads the variable: `AdminApiImpl` asks it before every write-request and
enrolment method, and the workspace asks it again before a write runs. Writes also need
`PUBLIC_BASE_URL`, the origin of the Workshop's own pages: it is where a request is approved, and
the origin and relying party every passkey is bound to (`originUnset` without it).

**Writes are not held to the read cap.** `ADMIN_WORKSPACE_ACCESS_MAX` and the level admins choose
bound inspections only. With writes on, an approved `addCollaborator` makes any account a
collaborator of any workspace, the admin's own included, and that account then reads the workspace
as its members do, on a deployment whose cap is `off` or `metadata` too. So does whoever holds an
admin's session and enrols a passkey with it (see
[Why a second factor, and what it is worth](#why-a-second-factor-and-what-it-is-worth)). The grant
is visible (the workspace's action log shows its owner and build collaborators who added the
collaborator and why) and on record, but it is a read of content the cap alone would have refused.
An operator who set the cap to keep admin sessions out of content should leave writes off, or
accept that turning them on outranks the cap. The cap also costs an approver something: where the
access level is `off` no inspection can show what a chat, gadget, connection or version id names,
so a write that names one is approved on the requester's word, and the approval page says so
instead of pointing at an inspection that would be refused.

### Setting the bounds

All three are variables of the backend Worker (`workshop-backend`):

- **Locally** (`pnpm run-local`, `pnpm dev-server`): set them in the shell or in the root
  `.dev.vars`; `scripts/run-dev-server.ts` passes all three through to the backend, for example
  `ADMIN_WORKSPACE_ACCESS_MAX=full pnpm dev-server` or `ADMIN_WORKSPACE_WRITES=on pnpm dev-server`.
  It sets `PUBLIC_BASE_URL` to where it serves the Workshop when the variable is unset, so a
  passkey enrolled locally is bound to that `localhost` origin.
- **Your own `wrangler deploy` or workerd config**: the backend Worker's `vars`.
- **Deploy tools that write the backend's variables themselves** (the online deploy flow and the
  deployment starter's `cf-os deploy`, both linked from the [README](../README.md#get-started)):
  they replace the Worker's variables on every deploy, so a value set in the Cloudflare dashboard
  lasts only until the next deploy, and until such a tool carries these variables its
  deployments run with the defaults. Any redeploy that writes its own variables must carry all
  three.

### When a variable is dropped

- The cap fails safe: a deployment set to `full` drops back to `metadata`.
- The floor falls back to 90 days, and with it the retention actually kept wherever the admins
  chose less, which prunes the older records.
- Writes go off. A pending request can no longer be approved, and expires. No passkey can be
  enrolled. The passkeys already enrolled stay stored and approve nothing; they can still be
  listed, and removed by their own admins.

So set the retention you want in the admin panel too: the admins' choice persists in the
deployment's settings across deploys, while the floor only stops an admin session from choosing
less. The Audit tab says when the floor is what holds retention up; it saves only a value that is
typed, so type the number of days you want kept, even the minimum.

## The audit

### Three kinds of record

- **`AdminAccessRecord`** (`kind: "workspace"`): one admin call into a workspace, the open or a view
  method. It holds `at` (when the record was written), `admin`, `sessionId`, `via`, `workspaceId`,
  the workspace's owner (`workspaceOwner`, resolved when the view opens; from the directory for an
  open refused before it reaches the workspace; a username is unbounded, so a long one keeps its
  start and a digest of the whole id, which keeps long ids apart), the workspace's title at the time, `method`, the call's arguments by name, the `reason` given at
  the open, the level the open asked for (`requested`), the `access` level the call ran at (never
  above `requested`), what its answer exposed (`exposed`), and `refused` when the level refused
  it.
- **`AdminSettingRecord`** (`kind: "setting"`): one `AdminApi` setter's change. It holds `at`,
  `admin`, `sessionId`, `via`, `method`, and `changes`, each naming a setting, an entry `key` for a
  map or list setting, and its value `before` and `after`.
- **`AdminWriteRecord`** (`kind: "write"`): one step in the life of a write request. It holds `at`,
  `admin` (whose step it is), `sessionId`, `via`, the `requestId` its steps share, the `event`,
  `workspaceId`, the workspace's owner and title (as the workspace itself gives them for
  `"approved"`, as the directory listed them when the request was made for the other steps),
  `method` (the action, named as on the other records so that one filter covers all three), the
  request's `args` by name, its `reason`, `requestedBy`, and, where the step has one, the
  `passkey`, the `refusal`, the `outcome` or the `error`. The seven events:

  | Event | Step | Whose (`admin`) | Recorded |
  | --- | --- | --- | --- |
  | `requested` | An admin asked for the write. | The requester | Before the request is stored. |
  | `refused` | An attempt to approve was not accepted (`refusal`): the answer failed a passkey check, or the request was no longer pending. | The admin who tried | When it is refused. |
  | `approved` | An admin confirmed it with a passkey. | The approver | By the workspace, before it changes anything. |
  | `applied` | The workspace ran it (`outcome`, when it reports one). | The approver | After the fact, at least once. |
  | `failed` | The workspace refused it or failed to run it, or its answer never arrived (`error`). | The approver | After the fact, at least once. |
  | `denied` | An admin denied it. | The denier | Before the denial is stored. |
  | `expired` | It ran out unapproved, or its requester stopped being an admin first (`error`). | The requester | Before the expiry is stored. |

  `passkey` is the credential id of the passkey behind the step, as the setting record of its
  enrolment keys it: for `approved`, `applied` and `failed`, the one whose assertion approved the
  request; for `refused`, the one the answer named, when it is one of that admin's own, whether or
  not it signed the answer.

`listAdminAudit()` filters by kind, admin, method, workspace, workspace owner (`owner`), what a call
exposed (`exposed`) and time; `getAdminAuditStats()` by kind. The method and the owner stay in a
record's JSON, each read through an index on its `json_extract()`. A method no record type names is refused
(capnweb-validate checks it against the method union); one that no logged record has gives an empty
page. The three kinds share no method name, so a method filter names records of one kind, and a
write action's lists every step of the requests for it. Only access records carry `exposed`, so
that filter matches no setting record and no write record.

The log's table constrains `kind`, and SQLite cannot alter a constraint. A deployment whose
`admin_audit` table was created without the `"write"` kind has it rebuilt once, when the audit
object starts: its rows are copied to a table that allows all three kinds, which takes its name.
The copy keeps every row's sequence number, so a listing's cursor stays valid.

### What a call exposed

`exposed` is `"content"` when a call's answer held something the `"metadata"` level withholds, and
`"metadata"` otherwise. Only a call at `"full"` can record `"content"`:

| Call | Records `"content"` when its answer holds |
| --- | --- |
| The open (`inspectWorkspace`) | never |
| `describe()` | a gadget that names the blueprint it follows |
| `listChats()` | a queued steer |
| `getChat()` | a message or a compaction summary |
| `getChatState()` | a queued call with an argument summary |
| `listChatAttachments()` | never |
| `readChatAttachment()` | any attachment found |
| `listActions()` | an action, observation or hook entry with a description, or an action or observation with a field |
| `listFiles()` | never |
| `readFile()` | any file at the path, an `unreadable` one included |
| `getCommitLog()` | a commit with a message |
| `listFilesAtCommit()` | never |
| `readFileAtCommit()` | any file at the path, as `readFile()` |
| `listChangedPaths()` | never |
| `listPendingChanges()` | never |
| `readPendingFile()` | any file at the path, as `readFile()` |
| `listGatekeepers()` | a hook with a description |
| `listObservers()` | never |
| `listObserverRequirements()` | never |
| `listShareLinks()` | never |
| `listAutoApprovals()` | never |
| `listBlueprints()` | a blueprint with an id |
| `getDiagnostics()` | never: nothing it returns depends on the level |

A refused call, or one whose read failed, records `"metadata"`. Present but empty is not content:
no queued steers, an empty description or field list, an `upstream` naming no blueprint (a gadget
built from scratch), an empty chat page, an empty argument summary, an empty commit message and an
emptied blueprint id all record `"metadata"`. The file reads (`readFile()`, `readFileAtCommit()`,
`readPendingFile()`) count any file they find, because an unreadable file's message can quote it
(a symlink's quotes its target), and overstating is the safe direction. The predicates
(`chatHoldsContent()` and its siblings in `admin-access.ts`) mirror the withholding helpers beside
them, so each is false for anything a metadata view returns.

`exposed` is set from the answer, never from the level, so the content-read counts (see
[Statistics](#statistics)) count reads that returned content, not calls made at `"full"`.

### Recorded before anything leaves

An access record is written to the deployment-wide `AdminAuditDurableObject`, and only then is the
answer returned. Nothing is written to the workspace, so `listActions()`, `subscribeToActions()`
and everything else a member reads can never show an inspection. If the write fails, the call
fails and returns nothing.

A setting record is written to the deployment-wide log before the change is stored: a change whose
record cannot be written is refused.

A write record precedes its step wherever a step can wait for it. `"requested"`, `"denied"` and
`"expired"` are written before the request is stored in that state, and `"approved"` by the
workspace before it changes anything, so a step whose record cannot be written is not taken.
`"applied"` and `"failed"` say what came of a run that has already happened, so they follow it,
and are retried until they are written (see [How a request ends](#how-a-request-ends)). Unlike an
inspection, an approved write is also written to the workspace, as an entry of its action log
(see [Who sees a write in the workspace](#who-sees-a-write-in-the-workspace)).

### Which refusals are recorded

| Refusal | Recorded | Why |
| --- | --- | --- |
| A live view's call refused by its level (`accessOff`, `contentWithheld`) | Yes, with `refused` | The admin reached the workspace and asked for something. |
| A live view's call whose read throws (a missing object, a pending gadget, an invalid path, a malformed commit or attachment id, a commit that is not stored, a chat that does not exist, an attachment that is not the chat's, a legacy connection in a grant's scope) | Yes, exposing `"metadata"` | The admin reached the workspace and asked for something; the call returned only its error. A string argument (a commit id, a path, an attachment id) is checked inside the read, so a malformed one is a failed read. |
| An open refused because the authoritative setting or the cap is `"off"` | Yes, titled from the directory (cut) or `""` | No workspace is reached, so its title comes from the directory. |
| An open refused because only the workspace's KV mirror still says `"off"` | Yes | The workspace's own check refused it. |
| A dead capability (no longer an admin), an expired view, a deleted workspace, a malformed or unknown workspace id, including a call that expiry, a demotion or a deletion overtakes while it reads | No | Nothing was reachable, or nothing the call read left the server, and recording a gone workspace would write into storage that must stay empty. |
| A call whose arguments are rejected before it starts: a mistyped argument, `listActions()`'s invalid `beforeId`, `getCommitLog()`'s `depth` outside 1 to `MAX_ADMIN_COMMIT_LOG_DEPTH` | No | Validation refuses the call before the view's own checks run, as it refuses a mistyped argument: nothing was read, and the call asked for nothing a record could name (a depth of 0, a `beforeId` of -1). Only an argument rejected before the call starts goes unrecorded; a malformed string is checked inside the read, and is the failed read above. |
| Any write-request or passkey method refused `notAdmin` or `writesOff`: a request, and equally a read, a denial, a begun approval or an approval of a stored request, a pending one included, and a passkey listing, enrolment or removal | No | `AdminApiImpl` refuses the call before `AdminSettings`, which holds the requests and records their steps, is reached: no request was read, and nothing changed. That includes an approval of a pending request sent after writes were turned off. |
| A write request refused before it is stored for another reason (a rejected reason or argument, `workspaceNotFound`, `originUnset`, `workspaceUnlisted`, `tooManyRequests`) | No | Nothing was stored, and no workspace was reached. |
| A refused attempt to approve a stored request, pending or not (`passkeyRefused`, `requestNotPending`) | Yes, as a `"refused"` write record with the check that failed | An admin tried to run a write. A failed passkey check and a replayed approval are what an investigation looks for. |
| An attempt to approve an id that names no request (`requestNotFound`) | No | There is no request to record it against. |
| Beginning an approval (`beginWorkspaceWriteApproval()`), whatever the answer, and denying a request that is no longer pending | No | Beginning answers nothing: it issues a challenge or refuses to. A denial that finds nothing pending denies nothing. |
| A passkey enrolment or removal refused by a passkey check (`passkeyRefused`) | No, logged for operators. An enrolment refused only once its record was appended, because the same credential was enrolled meanwhile, leaves that record | No passkey changed, and the caller's own session is all that tried. A record left behind is of the attempt (see [Setting records](#setting-records)). |
| A request that is denied, that expires, or that fails once approved | Yes (`"denied"`, `"expired"`, `"failed"`) | Each ends a stored request, and `"failed"` may follow a change to the workspace. |

### Setting records

Every setter is recorded before its change takes effect. `AdminSettings.#mutateAdminConfig()`, which
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
gateway tests, `checkForUpdates`, and the deployment's own promotion of its bundled formats, which
no admin made. A write-request call first ends the requests that have run out, so a read such as
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

The deployment-wide store keeps each field once (kind, time, admin, workspace id and title, and
`exposed` in columns, the rest as JSON) and cuts the title itself, whatever its caller sent. The
title is the one field of a record that a workspace member writes, and it has no length limit of
its own: kept whole, an over-long title would overflow the row (the platform caps one at 8 MiB), failing every
audit write and so refusing every investigation of that workspace, or push a listing past the RPC
size limit.

### Retention and pruning

The log keeps a record for the effective retention (`adminAuditRetentionDays`, default 90 days,
never below the floor). It deletes up to 1000 expired rows at the start of each call that passes the
committed retention, and never lists or counts one, and it holds the floor itself whatever retention
a caller passes. A view call's record passes none, since a view reads the KV mirror, whose retention
may be one an admin has since raised; the next listing, statistics read or settings change prunes.
The `"approved"` record a workspace appends passes none either; a write request's other records
pass the committed retention.

### Statistics

`getAdminAuditStats({ days, kind })` counts the last `days` UTC days, today included (7 by default,
at most 366): the total, one count per day (empty days included), the ten admins with the most
records, each with its content reads, and the content reads in all (`contentReads`, the records
whose `exposed` is `"content"`). An admin outside the top ten who reads content is not ranked there,
but `listAdminAudit({ exposed: "content" })` lists every content read, as
`listAdminAudit({ workspace })` lists every call into a workspace. Only access records read content,
so for the `"setting"` kind the content reads are 0. A window reaching past the retention counts
nothing there.

The statistics also count the writes approved in the window (`writes`: the write records whose
`event` is `"approved"`, so a request counts once, however many steps it recorded). Only write
records are writes, so `writes` is 0 for the other two kinds, and the content reads are 0 for the
`"write"` kind.

The Audit tab shows the week's content reads in all and for each top admin, the week's approved
writes, a sensitivity on each record (Workspace write, Content read, Workspace metadata, Setting
change), the level an
inspection asked for where its view got less, each call's target user (the workspace's owner) in a
column of its own, and filters its log by admin, action, sensitivity, workspace and target user.
A write record shows its step beside its sensitivity and, opened, its request, arguments and
reason, who requested it, and the refusal, passkey, outcome or error it carries.

## Error codes

Expected refusals carry a code from `ADMIN_ACCESS_ERROR_CODES` (read with
`getAdminAccessErrorCode()`), which survives Durable Object RPC and Cap'n Web:

| Code | When |
| --- | --- |
| `ADMIN_NOT_ADMIN` | The caller, or a view's admin, is no longer named in `ADMINS`. |
| `ADMIN_WORKSPACE_NOT_FOUND` | A malformed id, or one naming no workspace (never initialised or since deleted). |
| `ADMIN_WORKSPACE_ACCESS_OFF` | The level is `"off"`, by the setting or the cap. |
| `ADMIN_CONTENT_WITHHELD` | A method that reads only content (`getChat()`, `readChatAttachment()`, `readFile()`, `readFileAtCommit()`, `readPendingFile()`) on a view below `"full"`, whether its inspection asked for `"metadata"` (the default) or the deployment held it there. |
| `ADMIN_VIEW_EXPIRED` | The view's lifetime has run out. |

The write-request and passkey methods refuse with `ADMIN_NOT_ADMIN` and
`ADMIN_WORKSPACE_NOT_FOUND` too, and otherwise with a code from `ADMIN_WRITE_ERROR_CODES` (read
with `getAdminWriteErrorCode()`):

| Code | When |
| --- | --- |
| `ADMIN_WORKSPACE_WRITES_OFF` | `ADMIN_WORKSPACE_WRITES` is not `on`: every write-request and enrolment method, and a write its workspace is asked to run. Listing and removing passkeys still answer. |
| `ADMIN_WRITE_ORIGIN_UNSET` | The deployment has no `PUBLIC_BASE_URL`, so there is no origin to approve a request on or to bind a passkey to. |
| `ADMIN_WRITE_WORKSPACE_UNLISTED` | A request for a workspace the directory does not list: its approval must show an owner. |
| `ADMIN_WRITE_WORKSPACE_CHANGED` | An approved write reached a workspace whose owner is not the one the request named, so it was not run. |
| `ADMIN_WRITE_REQUEST_NOT_FOUND` | No request has that id. A request is forgotten a day after it is resolved. |
| `ADMIN_WRITE_REQUEST_NOT_PENDING` | The request was approved, denied or has expired. |
| `ADMIN_WRITE_TOO_MANY_REQUESTS` | `MAX_PENDING_ADMIN_WRITES` (50) requests are pending across the deployment. |
| `ADMIN_WRITE_PASSKEY_REQUIRED` | An approval begun by an admin who has enrolled no passkey. |
| `ADMIN_WRITE_PASSKEY_REFUSED` | A passkey answer failed a check. The caller is not told which; a refused approval's record says (`refusal`). |

## Tests

Unit suites, in `packages/workshop-backend/__tests__/`:

- `admin-access.test.ts`: admin status, the bounds' parsing (failing closed), the policy, validation
  (the commit log's depth included), the per-call level and the content methods it refuses, the
  cuts, setting values and excerpts, withholding, and whether an answer holds content (each
  withholder with its predicate, empty values included).
- `admin-config.test.ts` (`diffAdminConfig`) and `admin-settings-audit.test.ts`: what each setter
  records, before which write, and the setters' bounds.
- `admin-audit.test.ts`: the deployment-wide log's listing, filters (`exposed` alone and with the
  others), cursors, schema (the `exposed` column and the CHECK tying it to access records),
  retention, stats (content reads in all and per top entry, titles, by kind), the method and owner
  indexes, and multi-MiB titles.
- `admin-api-impl.test.ts`: `AdminApiImpl`'s inspection path, the level asked for (the lower of it
  and the deployment's, and the validator's `TypeError` for any other level), refused opens,
  listings and forwarding.
- `cli-admins-only.test.ts`: the `via` a session's User-Agent gives its records.
- `admin-workspace-view.test.ts`: the view, from an uninitialised id that stays uninitialised to the
  per-call checks; `requested` and `exposed` on each method's record; a view that asked for
  `"full"` held at `"metadata"` and never raised; the reads that fail recorded, and a depth out of
  range refused unrecorded; a failed record returning nothing; the races with deletion and expiry,
  at the setting read and while a call reads its answer, writing nothing; withholding; a
  2,000,000-character title; the reads that never pull (a gadget's head, history, changed paths,
  files at a commit, attachments, and a chat's pending content with a worktree); the sharing reads
  never reaching a connection; an inspection calling every method leaving the workspace's storage,
  presence and alarm as they were; and the view's surface being exactly what the audit names:
  every method in `ADMIN_WORKSPACE_METHODS` is recorded, and the view class exposes no other member
  over RPC (a helper must be `#private`: the class's public members, not its interface, are its
  RPC surface).
- `connection-creator.test.ts`: the creator stamped at each creation path, and absent on an ambient
  capsule and on a resource whose turn has no record.
- `git-cache.test.ts` and `git-cache-history.test.ts`: the local readers against the pulling ones,
  and a history whose parent is not stored.
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
  being appended; a change whose record cannot be written; no `PUBLIC_BASE_URL`; and listing and
  removal while writes are off.
- `admin-write-requests.test.ts`: the request store. A request recorded before it is stored, the
  limit on pending requests, denial, expiry (by the alarm, by a read, once under concurrency, and
  ahead of time for a demoted requester), and the alarm.
- `admin-write-approval.test.ts`: the challenge bound to the request's digest; an approval
  spending the request once; every refusal recorded (a replay, a tampered request, another
  admin's credential, a former admin's passkey, a removed passkey, a denied or expired request);
  the races with a denial, an expiry and a second approver; settling, with a closing record owed
  while the log cannot be written; and a workspace that never answers.
- `admin-write-apply.test.ts`: `applyAdminWrite()` on a real workspace. The refusals that write
  nothing, each action running its one operation, a retry as the owner, a collaborator granted as
  the owner (where only the owner may add people too, and still verified as an observer), a
  rejected queue with its bound and a pending creation, the record before the effect, the action
  log entry as the owner reads it and as a `use` session does not, and a deletion that fails
  partway or completes.
- `admin-api-impl.test.ts` also covers `AdminApiImpl`'s write and passkey methods: the checks
  before anything is touched, the directory's title and owner, and an approval that has the
  workspace run the write once and settles it.
- `admin-audit.test.ts` also covers write records in the log's listing, filters and statistics,
  and the table's one-time rebuild, which keeps every row and sequence number.
- `git-push-actions.test.ts` also covers rejecting an action whose connection was removed, with
  no gatekeeper left to tell.

Integration suites, in `packages/integration-tests/__tests__/`:

- `workshop-admin-inspection.test.ts`: every admin method this surface adds refused to a non-admin;
  the directory; an inspection recorded apart from the workspace and absent from the owner's
  `listActions()` and `subscribeToActions()`; metadata and off; the level asked for, and raising
  the setting not raising a view; every read end to end with what it returned and exposed, and
  the `exposed` filter; the content methods refused below `"full"`; the creator of a connection
  made through `newGatekeeper()`, and none on an ambient one; who holds an observer record, with
  what was verified for each; a deleted id refused without being written; an audit write failure,
  where a content read returns nothing; expiry; and long text end to end.
- `workshop-admin-audit.test.ts`: every setting change recorded before it takes effect, sessions,
  filters, stats and content reads across two admins, and a refused change when its record cannot
  be written.
- `workshop-admin-bounds.test.ts`: the bounds' defaults, and a redeploy that tightens them (an
  invalid cap failing closed) and demotes an admin. The redeploy ends every session, the demoted
  admin's view among them, so the per-call re-check that stops a live view once its admin is demoted
  is covered by `admin-workspace-view.test.ts`. It also covers writes refused, recording nothing,
  while `ADMIN_WORKSPACE_WRITES` is unset and after a redeploy that sets it to `true`.
- `workshop-admin-writes.test.ts`: writes end to end, signed by the same software authenticator.
  The write and passkey methods refused to a non-admin, whose capabilities run no write; an
  enrolment recorded without its key; an admin with no passkey, and another admin's passkey,
  approving nothing; an approved write recorded step by step, with `"approved"` before the effect,
  and entered in the workspace's action log, where its owner reads who did it and why; nothing
  changing when the record cannot be written; a replayed and a falsified approval refused, each
  recorded; a denial; a passkey removed only by its own admin; every other action as its
  operation, a collaborator added where only the owner may add people among them; a workspace
  that is gone; and passkeys kept through writes being turned off, and a former admin's, which do
  nothing.

The integration suite reaches Durable Object storage directly (see
[integration-testing.md](integration-testing.md#reaching-a-durable-objects-storage-from-a-test)): it
faults the deployment-wide log with a trigger on `admin_audit`, and shows that an inspected deleted
id stays unwritten by listing its `sqlite_master`.

Frontend suites, in `packages/workshop-frontend/src/`:

- `pages/admin-write-approval/AdminWriteApprovalPage.test.tsx`: what the page shows of a request
  in each state and of each failure, and `features/admin-writes/writeLabels.test.ts` the rows and
  notes it is built from.
- `features/admin-writes/AdminPasskeysCard.test.tsx` and `AdminPage.test.tsx`: the Access tab's
  passkeys card, with writes on and off, and Remove offered only on the caller's own passkeys.
- `features/admin-writes/passkeyCeremony.test.ts`: what the browser is asked for and how its
  answer is encoded.
- `Activity.test.tsx`: an admin's write in the workspace's activity. The suites beside the Audit
  tab cover the write sensitivity, its filter and a write record's details.
- The browser tests (`test:run:browser`) run real ceremonies in Chromium against a virtual
  authenticator: `features/admin-writes/passkeyCeremony.browser.test.tsx` creates a passkey and
  confirms a challenge with it, and
  `pages/admin-write-approval/AdminWriteApprovalPage.browser.test.tsx` approves a request from the
  page, by pointer and by keyboard.
