# Admin access: operating and investigating a deployment

A deployment's admins (the canonical user ids its backend Worker's `ADMINS` variable lists) need to
operate, debug and investigate the instance: find a user or a workspace, look inside a workspace
that misbehaves, and know afterwards who looked at what and who changed which setting. This
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

## Entry points

Everything goes through `AuthenticatedApi.getAdminApi()`, which returns null unless the
caller is an admin. The admin check runs once, when the capability is minted, for every `AdminApi`
method except workspace inspection, which checks again (see [Inspection](#inspection)).

- **Settings**: the setters (signups, user search, site name and logo, instructions,
  resource and gatekeeper availability, models, update checks, ...), plus
  `setAdminWorkspaceAccess()` and `setAdminAuditRetentionDays()`. Every setter is audited.
- **The directory**: `listUsers()` and `listWorkspaces()`.
- **Inspection**: `inspectWorkspace(workspaceId, reason, { lifetimeSeconds, access })`, which
  returns an `AdminWorkspaceView` at the lower of the level asked for (`"metadata"` by default) and
  the deployment's.
- **The audit log**: `listAdminAudit()` and `getAdminAuditStats()`.

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
- **Console logs**: `listConsoleLogs()`, the gadget console logs the workspace keeps, paged and
  filtered as `Overseer.listConsoleLogs()` pages them (see
  [gadget-console-logs.md](gadget-console-logs.md)).
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
a link; and the workspace's console log object, in `listConsoleLogs()`, which leaves that object's
entries and alarm as they were and asks no object while the workspace has kept no entry.

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
   `readFile()`, `readFileAtCommit()`, `readPendingFile()`, `listConsoleLogs()`). Its record is
   sent with nothing awaited after step 3's check.
6. The read, on the server and never through a connection. A read that throws is recorded as an
   attempt exposing `"metadata"`, once the checks pass again, and the call fails with the read's
   error: a missing object, a gadget whose code is pending, an invalid path, a commit that is not
   stored, a chat that does not exist. `listObserverRequirements()` throws, as the members' call
   does, for a legacy connection (one made before connections could verify collaborators) in the
   scope of the grant it was asked about: any such connection for `"workspace"`, and for a gadget
   only one the gadget reaches. A malformed string argument (a commit id, a path, an attachment
   id) is checked inside the read, so it is recorded this way. A number out of range is not:
   `getCommitLog()`'s `depth` outside 1 to `MAX_ADMIN_COMMIT_LOG_DEPTH`, like `listActions()`'s
   invalid `beforeId`, is rejected before the call starts, and is not recorded. Neither is a
   `listConsoleLogs()` query whose `since` or `until` is not a valid time or whose `cursor` is
   malformed.
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

## Access levels and their bounds

### The levels

`adminWorkspaceAccess` is `"off"`, `"metadata"` (the default) or `"full"`, the most an inspection
gets (see [The level an inspection asks for](#the-level-an-inspection-asks-for)):

- **off**: `inspectWorkspace()` is refused.
- **metadata**: the workspace's structure. Withheld: chat messages and queued steers, chat
  attachments, file contents (at any commit, and pending in a chat), commit messages, gadget
  console logs, the argument
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
them.

| Variable | Values | Default | Effect |
| --- | --- | --- | --- |
| `ADMIN_WORKSPACE_ACCESS_MAX` | `off`, `metadata`, `full` (any case, trimmed) | `metadata` (unset or blank) | The highest level admins may choose. Any other value is `off`, logged as an error: it bounds a security setting, so `none`, `false` or a typo of `off` must fail closed, never grant the default. |
| `ADMIN_AUDIT_RETENTION_MIN_DAYS` | a positive whole number of days, at most 3650 (`MAX_ADMIN_AUDIT_RETENTION_DAYS`); a larger value counts as 3650 | 90 (unset, blank or invalid; an invalid value is logged) | The fewest days the audit log keeps a record, whatever admins choose. |

The admins' choice is kept in `AdminConfig` as they set it, and `adminAccessPolicy()` holds it within
the bounds wherever it is enforced: `inspectWorkspace()`, every view call, the settings audit and
the audit log's own floor. `getSettings()` reports `chosen`, the bound
(`max` or `min`), and `effective`, which is what is enforced. The setters refuse a value outside the
bounds, naming the variable; a choice stored before a bound tightened is kept but not enforced.
`"full"` therefore takes a deployment config change.

### Setting the bounds

Both are variables of the backend Worker (`workshop-backend`):

- **Locally** (`pnpm run-local`, `pnpm dev-server`): set them in the shell or in the root
  `.dev.vars`; `scripts/run-dev-server.ts` passes both through to the backend, for example
  `ADMIN_WORKSPACE_ACCESS_MAX=full pnpm dev-server`.
- **Your own `wrangler deploy` or workerd config**: the backend Worker's `vars`.
- **Deploy tools that write the backend's variables themselves** (the online deploy flow and the
  deployment starter's `cf-os deploy`, both linked from the [README](../README.md#get-started)):
  they replace the Worker's variables on every deploy, so a value set in the Cloudflare dashboard
  lasts only until the next deploy, and until such a tool carries these two variables its
  deployments run with the defaults. Any redeploy that writes its own variables must carry both.

### When a variable is dropped

- The cap fails safe: a deployment set to `full` drops back to `metadata`.
- The floor falls back to 90 days, and with it the retention actually kept wherever the admins
  chose less, which prunes the older records.

So set the retention you want in the admin panel too: the admins' choice persists in the
deployment's settings across deploys, while the floor only stops an admin session from choosing
less. The Audit tab says when the floor is what holds retention up; it saves only a value that is
typed, so type the number of days you want kept, even the minimum.

## The audit

### Two kinds of record

- **`AdminAccessRecord`** (`kind: "workspace"`): one admin call into a workspace, the open or a view
  method. It holds `at` (when the record was written), `admin`, `sessionId`, `via`, `workspaceId`,
  the workspace's owner (`workspaceOwner`, resolved when the view opens; from the directory for an
  open refused before it reaches the workspace; a username is unbounded, so a long one keeps its
  start and a digest of the whole id, which keeps long ids apart), the workspace's title at the time, `method`, the call's arguments by name, the `reason` given at
  the open, the level the open asked for (`requested`), the `access` level the call ran at (never
  above `requested`), what its answer exposed (`exposed`), and `refused` when the level refused
  it. An argument is recorded as a string or a number, so `listConsoleLogs()` records the fields
  of its query one by one, `since` and `until` as ISO 8601 and a `chatId` of null as `"mainline"`.
- **`AdminSettingRecord`** (`kind: "setting"`): one `AdminApi` setter's change. It holds `at`,
  `admin`, `sessionId`, `via`, `method`, and `changes`, each naming a setting, an entry `key` for a
  map or list setting, and its value `before` and `after`.

`listAdminAudit()` filters by kind, admin, method, workspace, workspace owner (`owner`), what a call
exposed (`exposed`) and time; `getAdminAuditStats()` by kind. The method and the owner stay in a
record's JSON, each read through an index on its `json_extract()`. A method no record type names is refused
(capnweb-validate checks it against the method union); one that no logged record has gives an empty
page.

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
| `listConsoleLogs()` | a console log entry |
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
built from scratch), an empty chat page, an empty console log page, an empty argument summary, an
empty commit message and an emptied blueprint id all record `"metadata"`. The file reads
(`readFile()`, `readFileAtCommit()`, `readPendingFile()`) count any file they find, because an
unreadable file's message can quote it (a symlink's quotes its target), and overstating is the
safe direction. The predicates (`chatHoldsContent()` and its siblings in `admin-access.ts`) mirror
the withholding helpers beside them, so each is false for anything a metadata view returns.

`exposed` is set from the answer, never from the level, so the content-read counts (see
[Statistics](#statistics)) count reads that returned content, not calls made at `"full"`.

### Recorded before anything leaves

An access record is written to the deployment-wide `AdminAuditDurableObject`, and only then is the
answer returned. Nothing is written to the workspace, so `listActions()`, `subscribeToActions()`
and everything else a member reads can never show an inspection. If the write fails, the call
fails and returns nothing.

A setting record is written to the deployment-wide log before the change is stored: a change whose
record cannot be written is refused.

### Which refusals are recorded

| Refusal | Recorded | Why |
| --- | --- | --- |
| A live view's call refused by its level (`accessOff`, `contentWithheld`) | Yes, with `refused` | The admin reached the workspace and asked for something. |
| A live view's call whose read throws (a missing object, a pending gadget, an invalid path, a malformed commit or attachment id, a commit that is not stored, a chat that does not exist, an attachment that is not the chat's, a legacy connection in a grant's scope) | Yes, exposing `"metadata"` | The admin reached the workspace and asked for something; the call returned only its error. A string argument (a commit id, a path, an attachment id) is checked inside the read, so a malformed one is a failed read. |
| An open refused because the authoritative setting or the cap is `"off"` | Yes, titled from the directory (cut) or `""` | No workspace is reached, so its title comes from the directory. |
| An open refused because only the workspace's KV mirror still says `"off"` | Yes | The workspace's own check refused it. |
| A dead capability (no longer an admin), an expired view, a deleted workspace, a malformed or unknown workspace id, including a call that expiry, a demotion or a deletion overtakes while it reads | No | Nothing was reachable, or nothing the call read left the server, and recording a gone workspace would write into storage that must stay empty. |
| A call whose arguments are rejected before it starts: a mistyped argument, `listActions()`'s invalid `beforeId`, `getCommitLog()`'s `depth` outside 1 to `MAX_ADMIN_COMMIT_LOG_DEPTH`, `listConsoleLogs()`'s `since` or `until` that is not a valid time, or malformed `cursor` | No | Validation refuses the call before the view's own checks run, as it refuses a mistyped argument: nothing was read, and the call asked for nothing a record could name (a depth of 0, a `beforeId` of -1, a time that is no time). Only an argument rejected before the call starts goes unrecorded; a malformed commit id, path or attachment id is checked inside the read, and is the failed read above. |

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
- Two writes the diff cannot see are recorded explicitly before they happen: the site logo, as
  `"default"` or a logo's size and SHA-256 (never its bytes), which R2 keeps beside the logo, so
  uploading the logo already stored records nothing; a logo stored without its digest, before
  logos were recorded, is `"custom"`; and featuring a blueprint, whose bit lives in its owner's
  user DO.
- A call that changes nothing records nothing (it is still written, since it may be a retry
  repairing the KV mirror). A record is kept if the change then fails, for example when the KV
  mirror write fails and the config is rolled back: it records the attempt.

Not recorded: reads (`getSettings`, `isBlueprintFeatured`, `getUpdateStatus`, the listings and the
audit log itself), the gateway tests, `checkForUpdates`, and the deployment's own promotion of its
bundled formats, which no admin made.

### Text bounds

Arguments, workspace titles and setting keys are cut to `MAX_ADMIN_AUDIT_ARG_LENGTH` (256)
characters by `cutAdminAuditText()`, the last character replaced with `…` and never splitting a
surrogate pair: a record marks its cuts, never passing a fragment off as the whole. Reasons are
capped at `MAX_ADMIN_ACCESS_REASON_LENGTH` (500), values at 10,000 with excerpts, and a setter's diff
has a bounded number of changes, so every record, and every page of them, is bounded.

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

### Statistics

`getAdminAuditStats({ days, kind })` counts the last `days` UTC days, today included (7 by default,
at most 366): the total, one count per day (empty days included), the ten admins with the most
records, each with its content reads, and the content reads in all (`contentReads`, the records
whose `exposed` is `"content"`). An admin outside the top ten who reads content is not ranked there,
but `listAdminAudit({ exposed: "content" })` lists every content read, as
`listAdminAudit({ workspace })` lists every call into a workspace. Only access records read content,
so for the `"setting"` kind the content reads are 0. A window reaching past the retention counts
nothing there.

The Audit tab shows the week's content reads in all and for each top admin, a
sensitivity on each record (Content read, Workspace metadata, Setting change), the level an
inspection asked for where its view got less, each call's target user (the workspace's owner) in a
column of its own, and filters its log by admin, action, sensitivity, workspace and target user.

## Error codes

Expected refusals carry a code from `ADMIN_ACCESS_ERROR_CODES` (read with
`getAdminAccessErrorCode()`), which survives Durable Object RPC and Cap'n Web:

| Code | When |
| --- | --- |
| `ADMIN_NOT_ADMIN` | The caller, or a view's admin, is no longer named in `ADMINS`. |
| `ADMIN_WORKSPACE_NOT_FOUND` | A malformed id, or one naming no workspace (never initialised or since deleted). |
| `ADMIN_WORKSPACE_ACCESS_OFF` | The level is `"off"`, by the setting or the cap. |
| `ADMIN_CONTENT_WITHHELD` | A method that reads only content (`getChat()`, `readChatAttachment()`, `readFile()`, `readFileAtCommit()`, `readPendingFile()`, `listConsoleLogs()`) on a view below `"full"`, whether its inspection asked for `"metadata"` (the default) or the deployment held it there. |
| `ADMIN_VIEW_EXPIRED` | The view's lifetime has run out. |

## Tests

Unit suites, in `packages/workshop-backend/__tests__/`:

- `admin-access.test.ts`: admin status, the bounds' parsing (failing closed), the policy, validation
  (the commit log's depth included), the per-call level and the content methods it refuses, the
  cuts, setting values and excerpts, withholding, and whether an answer holds content (each
  withholder with its predicate, empty values included, and a console log page).
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
  presence and alarm as they were; the console log read (refused below `"full"` without asking the
  log object, every field of its query recorded with a null chat as `"mainline"`, a malformed
  query rejected unrecorded, a failing log object recorded as an attempt, and the log object's
  entries and alarm left as they were); and the view's surface being exactly what the audit names:
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
- `workshop-console-log-history.test.ts`: the console log read refused at `"metadata"` and
  recorded as a content read at `"full"`, beside what members read of the same log.
- `workshop-admin-bounds.test.ts`: the bounds' defaults, and a redeploy that tightens them (an
  invalid cap failing closed) and demotes an admin. The redeploy ends every session, the demoted
  admin's view among them, so the per-call re-check that stops a live view once its admin is demoted
  is covered by `admin-workspace-view.test.ts`.

The integration suite reaches Durable Object storage directly (see
[integration-testing.md](integration-testing.md#reaching-a-durable-objects-storage-from-a-test)): it
faults the deployment-wide log with a trigger on `admin_audit`, and shows that an inspected deleted
id stays unwritten by listing its `sqlite_master`.
