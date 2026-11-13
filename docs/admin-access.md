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
| Reads that never pull (`readLocalCommitTree`, `readLocalFileAtCommitIfExists`, `localPathEntryAtCommit`, `changedLocalFilePathsBetween`, `readCommitLog` with `stopAtMissing`) | `packages/workshop-backend/src/git-cache.ts` |
| The admin panel's Audit tab | `packages/workshop-frontend/src/features/admin-audit/` |

## Entry points

Everything goes through `AuthenticatedApi.getAdminApi()`, which returns null unless the
caller is an admin. The admin check runs once, when the capability is minted, for every `AdminApi`
method except workspace inspection, which checks again (see [Inspection](#inspection)).

- **Settings**: the setters (signups, user search, site name and logo, instructions,
  resource and gatekeeper availability, models, update checks, ...), plus
  `setAdminWorkspaceAccess()` and `setAdminAuditRetentionDays()`. Every setter is audited.
- **The directory**: `listUsers()` and `listWorkspaces()`.
- **Inspection**: `inspectWorkspace(workspaceId, reason, { lifetimeSeconds })`, which returns an
  `AdminWorkspaceView` of the workspace's metadata.
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

`AdminApi.inspectWorkspace()` validates the reason and the lifetime, re-checks that the caller is an
admin, reads the access policy from the authoritative `AdminSettings` config (not the KV mirror: a
mirror still saying `"metadata"` after an admin turned access off must not mint a view), and then
calls `OverseerDurableObject.openForAdmin(adminId, reason, sessionId, terms)`. The terms carry the
session's `via` and the view's expiry (`expiresAt`).

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
  is not `"api"` or `"cli"`, and an expiry that is not a valid time or lies beyond the longest
  lifetime. An expiry already past when the workspace answers is not malformed: the open is refused
  as any call on an expired view is (`viewExpired`, unrecorded), so a slow hop never surfaces as a
  validation error.

The view (`AdminWorkspaceViewImpl`) is not an `Overseer`. It joins no presence, session count or
outputs fan-out, and starts no agent, ambient capsule or gatekeeper facet; waking the Durable Object
still resumes turns a previous instance left running, as any wake does. It offers these reads,
shaped as the matching `Overseer` reads are where there is one:

- **The workspace**: `describe()` and `getDiagnostics()`, whose counts come with the size of the
  workspace's storage and who has it open. Its `sessions` count what collaborators hold on the
  workspace, by role: holds, not people, and never the owner's sessions or an admin view.
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
  is a gadget the chat created and has not had accepted (a worktree is pinned at its first
  modification, so it always has one).
- **`listAutoApprovals()` lists opt-ins, which apply nothing alone.** They are the rules members
  turned on. An action is applied without a manual approval only when its author also marked it
  `autoApprovable`, and never once the workspace has read restricted data: the rules stay stored
  and listed, and every action waits. A view shows both conditions, which is how an admin answers
  why an action still waited: `describe()` reports `containsRestrictedData`, and `listActions()`
  keeps each action's `autoApprovable` verdict and kind, with `autoApproved` on one a rule
  applied.

An admin read never reaches a connection, and reads only what the workspace stores:

- **Commits.** `listFiles()` reads a permanent gadget's committed head. `listFilesAtCommit()`,
  `getCommitLog()` and `listChangedPaths()` take any commit the workspace stores (a gadget's
  history, a worktree's commits, a chat pin's base) and refuse anything else. All of them read
  only stored objects, through the local readers of `git-cache.ts`: `readLocalCommitTree` and
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
  any other: they show the repository's file names, commit ids, authors and times, and the paths
  that differ between two of its commits, and never its files or its commit messages. The
  connection is never asked, so the admin is not verified against the repository, and reads no
  more of it than the workspace already holds. This is the part of the
  [admin exception](observers.md#admin-access-a-deliberate-exception) that these reads widen.
- **A chat's pending content.** `listPendingChanges()` uses the fold the members' sessions use
  (`getCurrentChatContent()`), given a base reader that reads stored objects only
  (`readLocalFileAtCommitIfExists`), where the sessions' reader pulls. The fold's cache stays
  valid whichever reader filled it, because a commit is immutable: a reader that succeeds returns
  the same text, and one that cannot read a base throws. A base that cannot be read fails the call
  with the read's error, and that reader's errors name a path or an object id and never quote a
  file: it names a symlink without its target, which the members' reader includes.
  `listPendingChanges()` tells a worktree's paths apart by what its base holds at each
  (`localPathEntryAtCommit`), reading no blob.
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
the creator.

Two kinds of connection have none:

- **An ambient capsule**, because no person created it. A workspace installs one on open for each
  singleton account its owner holds (the Context Library's, for one), so it comes from the owner's
  own account of that vendor, and a workspace whose owner has none has no such connection.
- **A connection whose creator was not recorded**: one written before creators were recorded, or a
  resource created in a turn that has no record.

### Each call

Every view method, the open included, runs through `#call()`:

1. The view's checks: it has not expired (`viewExpired`), its admin is still an admin (`notAdmin`),
   and the workspace still exists (`workspaceNotFound`). A call these stop is not recorded.
2. The deployment's setting is read (`readAdminConfig`, the KV mirror).
3. The checks again, since that read may have spanned the expiry, a demotion or the workspace's
   deletion.
4. The level in force is the admins' choice held to the environment's cap
   (`adminAccessPolicy()`). While it is `"off"`, the call is recorded with `refused` set, and then
   refused (`accessOff`) without reading anything. Its record is sent with nothing awaited after
   step 3's check. Turning the setting off reaches live views within about a minute (the KV
   mirror's propagation), and a view still within its lifetime answers again once the level is
   back at `"metadata"`.
5. The read, on the server and never through a connection. A read that throws is recorded as an
   attempt, once the checks pass again, and the call fails with the read's error: a missing
   object, a gadget whose code is pending, a commit that is not stored, a chat that does not
   exist. `listObserverRequirements()` throws, as the members' call does, for a legacy connection
   (one made before connections could verify collaborators) in the scope of the grant it was asked
   about: any such connection for `"workspace"`, and for a gadget only one the gadget reaches. A
   malformed commit id is checked inside the read, so it is recorded this way. A number out of
   range is not: `getCommitLog()`'s `depth` outside 1 to `MAX_ADMIN_COMMIT_LOG_DEPTH`, like
   `listActions()`'s invalid `beforeId`, is rejected before the call starts, and is not recorded.
6. The checks again, with nothing awaited before the record is sent, since the read may have
   awaited. A call that expiry, a demotion or the workspace's deletion overtakes while it reads
   writes nothing, appends nothing for the workspace and returns nothing.
7. The record, in the deployment-wide log.
8. The answer.

The record follows the read so that a call the view stops while it reads (expiry, a demotion, the
workspace's deletion) writes nothing. The point a record must precede is the answer leaving the
server, since that is what an admin sees. Holding the answer until its record exists means that
nothing reaches an admin unrecorded and that a call whose record cannot be written returns
nothing, and a call refused while the level is `"off"` is still recorded without reading anything.
No check follows the append: the answer was read while the view was live, and its record exists.

A view lasts `DEFAULT_ADMIN_VIEW_LIFETIME_SECONDS` (15 minutes) unless the open asks for up to
`MAX_ADMIN_VIEW_LIFETIME_SECONDS` (an hour). A workspace restart (a revocation, a deletion, a
redeploy) ends every view along with every other session on it; inspect again.

## Access levels and their bounds

### The levels

`adminWorkspaceAccess` is `"off"` or `"metadata"` (the default):

- **off**: `inspectWorkspace()` is refused.
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

Content reads are not offered: no level and no method returns what `"metadata"` withholds.
[What the metadata level withholds](#what-the-metadata-level-withholds) lists it per method.

A deployment whose admins never chose a level is at `"metadata"`. A stored level that is not
`"off"` or `"metadata"` counts as `"off"` until an admin chooses one, and `getSettings()` reports
it as `chosen: "off"`.

### The environment's bounds

Two backend variables bound what admins may choose. They are environment variables for the reason
authentication config is (`auth/config.ts`): a compromised admin session must not be able to widen
them.

| Variable | Values | Default | Effect |
| --- | --- | --- | --- |
| `ADMIN_WORKSPACE_ACCESS_MAX` | `off`, `metadata` (any case, trimmed) | `metadata` (unset or blank) | The highest level admins may choose. `metadata` is also the default and the highest level there is, so the variable is the operator's off switch: `off` turns inspection off whatever admins choose. Any other value is `off`, logged as an error: it bounds a security setting, so `none`, `false` or a typo of `off` must fail closed, never grant the default. |
| `ADMIN_AUDIT_RETENTION_MIN_DAYS` | a positive whole number of days, at most 3650 (`MAX_ADMIN_AUDIT_RETENTION_DAYS`); a larger value counts as 3650 | 90 (unset, blank or invalid; an invalid value is logged) | The fewest days the audit log keeps a record, whatever admins choose. |

The admins' choice is kept in `AdminConfig` as they set it, and `adminAccessPolicy()` holds it within
the bounds wherever it is enforced: `inspectWorkspace()`, every view call, the settings audit and
the audit log's own floor. `getSettings()` reports `chosen`, the bound
(`max` or `min`), and `effective`, which is what is enforced. The setters refuse a value outside the
bounds, naming the variable; a choice stored before a bound tightened is kept but not enforced.
`setAdminWorkspaceAccess()` refuses a value that is not a level, storing and recording nothing.

### Setting the bounds

Both are variables of the backend Worker (`workshop-backend`):

- **Locally** (`pnpm run-local`, `pnpm dev-server`): set them in the shell or in the root
  `.dev.vars`; `scripts/run-dev-server.ts` passes both through to the backend, for example
  `ADMIN_WORKSPACE_ACCESS_MAX=off pnpm dev-server`.
- **Your own `wrangler deploy` or workerd config**: the backend Worker's `vars`.
- **Deploy tools that write the backend's variables themselves** (the online deploy flow and the
  deployment starter's `cf-os deploy`, both linked from the [README](../README.md#get-started)):
  they replace the Worker's variables on every deploy, so a value set in the Cloudflare dashboard
  lasts only until the next deploy, and until such a tool carries these two variables its
  deployments run with the defaults. Any redeploy that writes its own variables must carry both.

### When a variable is dropped

- The cap falls back to `metadata`. A deploy that drops `ADMIN_WORKSPACE_ACCESS_MAX=off` therefore
  turns inspection back on, at the level the admins chose: `metadata`, unless they chose Off.
- The floor falls back to 90 days, and with it the retention actually kept wherever the admins
  chose less, which prunes the older records.

So set what you want in the admin panel too: the admins' choices persist in the deployment's
settings across deploys, while a variable only bounds what an admin session can choose.

- **To keep inspection off**, also choose Off as the Audit tab's access setting: the variable only
  stops an admin session from turning inspection on.
- **To keep a retention**, set it in the Audit tab: the floor only stops an admin session from
  choosing less. The tab says when the floor is what holds retention up; it saves only a value
  that is typed, so type the number of days you want kept, even the minimum.

## The audit

### Two kinds of record

- **`AdminAccessRecord`** (`kind: "workspace"`): one admin call into a workspace, the open or a view
  method. It holds `at` (when the record was written), `admin`, `sessionId`, `via`, `workspaceId`,
  the workspace's owner (`workspaceOwner`, resolved when the view opens; from the directory for an
  open refused before it reaches the workspace; a username is unbounded, so a long one keeps its
  start and a digest of the whole id, which keeps long ids apart), the workspace's title at the
  time, `method`, the call's arguments by name, the `reason` given at the open, the deployment's
  `access` level when the call ran (`"metadata"`, or `"off"` for a call refused for that), and
  `refused` when the level refused it.
- **`AdminSettingRecord`** (`kind: "setting"`): one `AdminApi` setter's change. It holds `at`,
  `admin`, `sessionId`, `via`, `method`, and `changes`, each naming a setting, an entry `key` for a
  map or list setting, and its value `before` and `after`.

`listAdminAudit()` filters by kind, admin, method, workspace, workspace owner (`owner`) and time;
`getAdminAuditStats()` by kind. The method and the owner stay in a record's JSON, each read through
an index on its `json_extract()`. A method no record type names is refused (capnweb-validate checks
it against the method union); one that no logged record has gives an empty page.

### What the metadata level withholds

Every answer is what the `"metadata"` level shows (see [The levels](#the-levels)). The methods
that read a record holding content return it with that content left out or emptied, and the others
read nothing the level withholds:

| Call | Returns | Withholds |
| --- | --- | --- |
| `describe()` | The workspace's id, title, cost, restricted-data flag, sharing policy and default gadget, its owner's profile, its workpieces and its collaborators, with the view's expiry | Each gadget's `upstream`, which names the blueprint it follows |
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
applied to every answer unconditionally: no setting and no option skips one. What is kept can
still echo content, as [The levels](#the-levels) says of titles, names, notes and blueprint
descriptions.

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
| A live view's call refused while the level is `"off"` (`accessOff`) | Yes, with `refused` | The admin reached the workspace and asked for something. |
| A live view's call whose read throws (a missing object, a pending gadget, a malformed commit id, a commit that is not stored, a chat that does not exist, a legacy connection in a grant's scope) | Yes | The admin reached the workspace and asked for something; the call returned only its error. A commit id is checked inside the read, so a malformed one is a failed read. |
| An open refused because the authoritative setting or the cap is `"off"` | Yes, titled from the directory (cut) or `""` | No workspace is reached, so its title comes from the directory. |
| An open refused because only the workspace's KV mirror still says `"off"` | Yes | The workspace's own check refused it. |
| A dead capability (no longer an admin), an expired view, a deleted workspace, a malformed or unknown workspace id, including a call that expiry, a demotion or a deletion overtakes while it reads | No | Nothing was reachable, or nothing the call read left the server, and recording a gone workspace would write into storage that must stay empty. |
| A call whose arguments are rejected before it starts: a mistyped argument, `listActions()`'s invalid `beforeId`, `getCommitLog()`'s `depth` outside 1 to `MAX_ADMIN_COMMIT_LOG_DEPTH` | No | Validation refuses the call before the view's own checks run, as it refuses a mistyped argument: nothing was read, and the call asked for nothing a record could name (a depth of 0, a `beforeId` of -1). Only an argument rejected before the call starts goes unrecorded; a malformed commit id is checked inside the read, and is the failed read above. |

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

The deployment-wide store keeps each field once (kind, time, admin, and an access record's
workspace id and title in columns, the rest as JSON) and cuts the title itself, whatever its caller
sent. The title is the one field of a record that a workspace member writes, and it has no length
limit of its own: kept whole, an over-long title would overflow the row (the platform caps one at
8 MiB), failing every audit write and so refusing every investigation of that workspace, or push a
listing past the RPC size limit.

The store's table also has an `exposed` column with an index (`admin_audit_exposed`): `append()`
writes `metadata` there for every access record and nothing for a setting record. The column is not
part of a record the API returns, and no query filters by it.

### Retention and pruning

The log keeps a record for the effective retention (`adminAuditRetentionDays`, default 90 days,
never below the floor). It deletes up to 1000 expired rows at the start of each call that passes the
committed retention, and never lists or counts one, and it holds the floor itself whatever retention
a caller passes. A view call's record passes none, since a view reads the KV mirror, whose retention
may be one an admin has since raised; the next listing, statistics read or settings change prunes.

### Statistics

`getAdminAuditStats({ days, kind })` counts the last `days` UTC days, today included (7 by default,
at most 366): the total, one count per day (empty days included), and the ten admins with the most
records. An admin outside the top ten is not ranked there, but `listAdminAudit({ admin })` lists
every record of theirs, as `listAdminAudit({ workspace })` lists every call into a workspace. A
window reaching past the retention counts nothing there.

The Audit tab shows the week's total, its count per day and its most active admins, each record's
kind (Workspace access, Setting change), and each call's target user (the workspace's owner) in a
column of its own. It filters its log by admin, action, kind, workspace and target user. Its access
setting offers Off and Metadata, and says what Metadata withholds.

## Error codes

Expected refusals carry a code from `ADMIN_ACCESS_ERROR_CODES` (read with
`getAdminAccessErrorCode()`), which survives Durable Object RPC and Cap'n Web:

| Code | When |
| --- | --- |
| `ADMIN_NOT_ADMIN` | The caller, or a view's admin, is no longer named in `ADMINS`. |
| `ADMIN_WORKSPACE_NOT_FOUND` | A malformed id, or one naming no workspace (never initialised or since deleted). |
| `ADMIN_WORKSPACE_ACCESS_OFF` | The level is `"off"`: by the setting, by the cap, or because either holds a value that is not a level. |
| `ADMIN_VIEW_EXPIRED` | The view's lifetime has run out. |

## Tests

Unit suites, in `packages/workshop-backend/__tests__/`:

- `admin-access.test.ts`: admin status, the bounds' parsing (failing closed), the policy (which
  gives `"off"` for a chosen value that is not a level, with or without a cap), validation (the
  commit log's depth included), the cuts, setting values and excerpts, and each withholding helper
  on a copy.
- `admin-config.test.ts` (`diffAdminConfig`) and `admin-settings-audit.test.ts`: what each setter
  records, before which write, and the setters' bounds: a value that is not a level refused,
  nothing stored or recorded, and a stored one reported as `"off"` until an admin chooses.
- `admin-audit.test.ts`: the deployment-wide log's listing, filters, cursors, schema (the CHECKs
  tying the workspace columns to access records, and `exposed` stored as `metadata` for every
  access record and null for a setting record), retention, stats (per day, the top admins, by
  kind), the method and owner indexes, multi-MiB titles, and each record returned as it is stored.
- `admin-api-impl.test.ts`: `AdminApiImpl`'s inspection path, opens refused while access is off (by
  the setting, by a cap or a committed level that is not a level), the setter's validator refusing
  a value that is not a level with a `TypeError`, listings and forwarding.
- `cli-admins-only.test.ts`: the `via` a session's User-Agent gives its records.
- `admin-workspace-view.test.ts`: the view, from an uninitialised id that stays uninitialised to the
  per-call checks; every method recorded and none refused, each record stored with `exposed`
  `metadata` in the table; what every answer withholds, beside the structure it keeps; a call
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
  `ADMIN_WORKSPACE_METHODS` is recorded, and the view class exposes no other member over RPC, and
  none that reads content (a helper must be `#private`: the class's public members, not its
  interface, are its RPC surface).
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

Integration suites, in `packages/integration-tests/__tests__/`:

- `workshop-admin-inspection.test.ts`: every admin method this surface adds refused to a non-admin;
  the directory; an inspection recorded apart from the workspace and absent from the owner's
  `listActions()` and `subscribeToActions()`; what the view withholds of what the owner reads, and
  inspection turned off; attachments, commits and a draft's paths listed without their content; no
  level above `"metadata"` to ask for or to set, and no method that reads content; every call
  recorded end to end; the creator of a connection made through `newGatekeeper()`, and none on an
  ambient one; who holds an observer record, with what was verified for each; a deleted id refused
  without being written; an audit write failure, where a call returns nothing; expiry; and long
  text end to end.
- `workshop-admin-audit.test.ts`: every setting change recorded before it takes effect, sessions,
  filters, stats across two admins, and a refused change when its record cannot be written.
- `workshop-admin-bounds.test.ts`: the bounds' defaults, and a redeploy that tightens them (an
  invalid cap failing closed) and demotes an admin. The redeploy ends every session, the demoted
  admin's view among them, so the per-call re-check that stops a live view once its admin is demoted
  is covered by `admin-workspace-view.test.ts`.

The integration suite reaches Durable Object storage directly (see
[integration-testing.md](integration-testing.md#reaching-a-durable-objects-storage-from-a-test)): it
faults the deployment-wide log with a trigger on `admin_audit`, and shows that an inspected deleted
id stays unwritten by listing its `sqlite_master`.
