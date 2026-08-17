# Plan: Git object storage for gadget code

## Goal

Move committed gadget code out of the workspace-wide Yjs doc and into a git object
store held in each workspace's Overseer DO. Yjs remains only as the representation of
*uncommitted* changes within a chat thread. Mainline history becomes real git commits;
each `GadgetRecord` points at its head commit.

Delivered as **one PR, split into reviewable commits** (see "Commit sequence" at the
end). The kernel packages (`workshop-backend`, `workshop-shared`) get the small,
carefully separated diffs; UI changes ride in their own commits.

## Locked decisions

- **Real git formats** (SHA-1, zlib loose objects) via isomorphic-git plumbing.
  Motivations: future export/import with GitHub, agents "mounting" arbitrary git repos
  with the same read/write/edit tools, gatekeeper-gated push/pull, eventually speaking
  git protocol. isomorphic-git 1.40 is already proven in workerd (gatekeeper-context).
- **Objects only, no refs.** Our refs are the gadget records (and blueprint records,
  and chats' pinned commits). No branches/tags/HEAD.
- **One object store per workspace**, all gadgets' histories mixed together. Unrelated
  DAGs coexist fine in a content-addressed store; related histories dedup at the
  blob/tree level.
- **Storage**: a new typed-storage collection in the Overseer DO keyed by **object oid
  (40-hex) alone**, exposed to isomorphic-git through a custom fs shim that parses the
  loose-object paths and rejects anything it doesn't intend to support. No >2MB object
  handling initially, but the design must leave chunking (or R2 spill for large blobs)
  open as a later shim-local change.
- **Editing happens only within chats.** Standalone (out-of-chat) mainline editing is
  removed. (A future change will make it easy to start an agent-less chat for manual
  edits.)
- **Merge model — merge into the chat, not into mainline:**
  - Committing to mainline is *only ever* a fast-forward: accept requires that the
    chat has already merged the gadget's head commit, and creates a plain commit on
    head.
  - If mainline moved, the user must first "update from mainline": compute a 3-way
    merge (diff3) of merged-head/head/chat trees, deliver the result *into the chat*
    as a Yjs update, and advance the chat's **merged commit** (not its seed — see
    "Chat flow"). Conflicts are left inline as 3-way conflict markers; the user (or
    their agent) cleans them up in the chat, then retries accept.
  - This deliberately plans for future multi-commit chat sessions: the chat is the
    branch, and mainline only ever advances by simple commits.
  - Yjs merge semantics are explicitly *not* used for cross-base merging — CRDT merge
    across divergent bases produces nonsense; conflict markers are better.
- **Commit identity**: the real user profile ID. Profile IDs are typically email
  addresses; in username/password mode they may be bare usernames — distinguish by the
  presence of `@`, and turn bare usernames into `<username>@localhost` (placeholder
  until users can customize commit identity). Message derived from chat context.
- **Migration**: synthesize commits from the existing Yjs update log, run in the
  Overseer constructor triggered by the `version` singleton, like previous migrations
  (details below). Old `code`/`snapshots` collections kept read-only for a transition
  period; deletion is a later cleanup change.

## isomorphic-git findings that shape the design

Verified against the vendored `isomorphic-git@1.40.0`
(`packages/gatekeeper-context/node_modules/isomorphic-git`, single rollup bundle,
line refs into its `index.js`):

- **The plumbing works bare.** `writeBlob`/`writeTree`/`writeCommit`/`readBlob`/
  `readTree`/`readCommit`/`log`/`walk` operate against a gitdir containing only
  `objects/**` — no HEAD, config, refs, or index. `log({ref: <40-hex oid>})`
  short-circuits ref resolution entirely. Writes mkdirp their own fan-out dirs.
- **Avoid the porcelain.** `git.commit` hard-requires HEAD/index/config (crashes on
  missing HEAD). `git.merge` is unsuitable: recursive merge (multiple merge bases)
  throws `MergeNotSupportedError`, and both-sides-added conflicts throw *before* the
  `mergeDriver` runs. We never need merge-base discovery anyway — the chat records its
  merged commit explicitly.
- **fs shim traps** (`bindFs`, index.js:5033ff): all ten methods (`readFile`,
  `writeFile`, `mkdir`, `rmdir`, `unlink`, `stat`, `lstat`, `readdir`, `readlink`,
  `symlink`) are bound unconditionally — missing ones throw at construction, so stubs
  must exist even for methods never called. The promise-fs detection probe calls
  `fs.readFile()` with no arguments and expects a promise — it must return a rejected
  promise, not throw synchronously. For object-DB-only use, the methods actually
  exercised are `stat`, `readFile`, `writeFile`, `mkdir`, `readdir`.
- **No delta compression on write.** Loose objects are zlib'd whole objects;
  `packObjects` writes undeltified packs; there is no gc/repack. (Deltified packs from
  remotes *read* fine.) Accepted tradeoff: dedup comes from content addressing
  (unchanged files are free), not deltas. Fine for source-code-sized files.
- **SHA-1 only.** No SHA-256 repo support anywhere in the library.
- **Concurrency**: no file locking (in-process `async-lock` only); object writes are
  idempotent (existing paths skipped). The DO's single-threaded execution + output
  gate provide all the serialization and atomicity we need.
- Runtime deps (`async-lock`, `sha.js`, `pako`, `diff3`, `crc-32`, `pify`, `ignore`,
  `clean-git-ref`) are pure JS; workerd provides `Buffer` (nodejs_compat),
  `crypto.subtle` SHA-1, and `CompressionStream`. Tree-shakes well
  (`sideEffects: false`).

## Yjs determinism findings that shape the design

Seeding a chat's Y.Doc from a git commit only works if every participant derives a
**byte-identical** seed, so that subsequent updates apply cleanly on replay. Verified
against Yjs:

- The only randomness in Yjs is the per-`Y.Doc` **clientID** (`generateNewClientId()`),
  and it is a plain settable property — `doc.clientID = N` before making any changes is
  supported (standard practice in Yjs tests). Item IDs are `(clientID, sequential
  clock)`; the V2 update encoding contains no timestamps or other nondeterminism.
- Therefore: fixed reserved seed clientID + sorted file iteration + a single
  transaction ⇒ `encodeStateAsUpdateV2` output is a pure function of the file map.
- Yjs's own collision handling (verified in yjs 13.6.31) makes a reserved clientID
  safe without custom guards:
  - Collision with a *past* client is safe by construction: new writes take their
    clock from the doc's current state for that clientID (`nextID`,
    Transaction.js:148), so a client that randomly picks a historical ID *continues*
    that ID's sequence rather than colliding.
  - *Concurrent* collision is detected heuristically: after applying a remote
    transaction that advanced the clock of the doc's own clientID, Yjs re-rolls
    `doc.clientID` with a warning (Transaction.js:357-359). Since the seed update is
    always the first remote update a chat doc applies — before any local edits — a
    client that randomly picked the reserved ID re-rolls automatically.
- Guards we adopt:
  - A **reserved seed clientID constant**, used only inside `seedDocFromFiles`, which
    builds the seed in a **throwaway Y.Doc** and returns the encoded update.
    Session/editor docs only ever *apply* the seed as a remote update, so no
    long-lived doc holds the reserved ID locally (an in-place seeder would keep
    writing as the reserved ID, and two such sessions would genuinely collide).
    Corollary: docs must apply the seed before making any local edits, which the
    seeding flow already guarantees by construction.
  - A **golden-byte unit test**: fixed file map → exact expected seed bytes, catching
    accidental drift from Yjs upgrades or refactors. The seed algorithm is part of
    each chat's implicit contract for its whole lifetime.
  - Each chat stores a **seed hash** (hash of its seed update bytes) so a mismatch
    fails fast and loudly instead of corrupting the doc; if we ever need to change the
    seed algorithm, gate it on a per-chat seed-version field (new chats only).

## Current-state anchors (for orientation)

- One Y.Doc per workspace; root `Y.Map<Y.Text>` per gadget named by decimal workpiece
  ID (legacy default gadget uses root `""`) — `gadgetRootName()`,
  `overseer.ts:1590`. Metadata lives outside Yjs in the `gadgets` collection
  (`GadgetRecord`, `overseer.ts:304`).
- Mainline = `code` collection (every incremental Yjs V2 update since v1,
  `overseer.ts:820`) + `snapshots` (replay optimization, `overseer.ts:827`); docs are
  rebuilt on demand (`buildYDoc`, `overseer.ts:2080`).
- Chats already behave like branches: `"changes"` messages carry Yjs updates +
  `observedCodeVersion` + created gadgets/bindings; `"merge"`/`"revert"` messages fold
  over them (`foldProposedChanges`, agent-compaction.ts:92); `mergeChanges()`
  (`overseer.ts:8398`) is the single choke point where proposed changes become
  mainline. Keystroke drafts live in `chatDraftUpdates`.
- Blueprint export (`snapshotCode`, `overseer.ts:5101`) already flattens Y.Doc → plain
  files; import re-seeds a doc from plain files (`overseer.ts:6780`).
- Existing pain this design removes: unbounded `code` log growth (scales with editing
  activity, not code size), CRDT tombstones in snapshots, undeletable Yjs roots for
  deleted gadgets (`overseer.ts:838-844`), single-KV-value snapshots approaching the
  2MB cap, workspace-wide versioning where per-gadget is wanted.

## Design

### 1. Object store + fs shim (`workshop-backend/src/git-store.ts`)

- New typed-storage collection `gitObjects` in `makeOverseerStorage()`: key = the
  object's **40-hex oid**, value = raw loose-object bytes (zlib'd, as isomorphic-git
  writes them). The fs shim parses paths: `<gitdir>/objects/xx/yyyy…38` →
  oid `xxyyyy…`; anything else it doesn't explicitly support is rejected, so we never
  silently accept writes we didn't intend to store. If we ever need non-object paths
  (e.g. for git protocol support), that's a migration we design then.
- fs shim implementing `PromiseFsClient`:
  - `readFile`: loose-object path → oid lookup (missing → reject ENOENT); the
    tolerated non-object reads (`<gitdir>/shallow`, pack `.idx`/`.pack`) → ENOENT;
    zero-arg call → rejected promise (promise-fs detection probe); anything else →
    reject.
  - `writeFile`: loose-object path → oid put; anything else → reject.
  - `stat`: gitdir itself → directory (for `discoverGitdir`); loose-object path →
    existence via oid lookup; else ENOENT.
  - `mkdir`: no-op success. `readdir`: `objects/pack` → `[]`; else reject.
  - Rejecting stubs: `lstat`, `unlink`, `rmdir`, `readlink`, `symlink`.
- Helper API wrapping the plumbing (module-private isomorphic-git usage; nothing else
  in the kernel imports isomorphic-git directly):
  - `writeFilesAsCommit(files, {parents, author, committer, message, timestamp}) → oid`
    — writes blobs, tree(s), commit via `writeBlob`/`writeTree`/`writeCommit`.
    Trees today are flat (gadget file lists), but read/write nested trees correctly
    (split paths on `/`) so future repo-mounting isn't foreclosed.
  - `readCommitFiles(oid) → Map<filename, string>` — `readCommit` + tree walk +
    `readBlob`.
  - `readCommitLog(oid, {depth}) → CommitInfo[]` — via `log({ref: oid})`.
  - `threeWayMerge(base, ours, theirs: Map<string,string>) → {files, conflictPaths}`
    — hand-rolled tree merge: union of paths; per-path trivial cases (only one side
    changed, both same) resolved directly; both-changed runs `diff3` (direct dependency
    on the same tiny `diff3` package isomorphic-git uses) with 3-way conflict markers
    (`<<<<<<<`/`|||||||`/`=======`/`>>>>>>>`), reimplementing isomorphic-git's
    unexported ~35-line `mergeFile`. Handles both-added and delete-vs-modify
    explicitly (delete-vs-modify keeps the modified side and reports a conflict).
    Never throws on conflict; markers are the resolution mechanism.
  - Commit author helper: `AiChatAuthorInfo` → `{name, email}` — the display name becomes
    the commit name, the profile ID the email; bare-username IDs (no `@`) become
    `username@localhost`.
- Deterministic Yjs seeding lives in **workshop-shared** (`src/yjs-seed.ts`, exported as
  `@gadgets/workshop-shared/yjs-seed`), *not* in git-store: browser editors must derive
  bit-identical seeds to what server sessions derive, so the algorithm is shared code
  (adding `yjs` as a workshop-shared dependency — both frontend and backend already
  depend on it). `seedDocFromFiles(roots) → Uint8Array` (V2 update) uses the reserved
  seed clientID, sorted iteration, and a single transaction (see "Yjs determinism
  findings"); `seedUpdateHash` is the seed-hash helper (manual hex — browsers can't rely
  on `Uint8Array.prototype.toHex` yet). All roots a chat will ever seed must come from a
  single call, since each call restarts the reserved clientID's clock from zero. The
  golden-byte tests live in workshop-backend's suite so they run under workerd.
- Pass a shared isomorphic-git `cache` object per DO instance (avoids re-parsing).
- Punt explicitly: no GC (dangling objects are cheap and only created by accepted
  merges/imports/migration; keep a GC-roots enumeration possible: gadget records,
  blueprint gadget records, live chats' pinned commits), no >2MB objects (chunking is
  a shim-local follow-up), no packfiles.
- Tests (workerd pool, like other workshop-backend tests): oid round-trips verified
  against known-good hashes produced by real git; log traversal; merge matrix (clean,
  conflicting, both-added, delete-vs-modify, unchanged); fs-shim path-parsing and
  probe behavior; golden-byte seed determinism.

### 2. Commit-backed gadget records

- `GadgetRecord` gains `commitId: string | null` — null only while the gadget is
  pending in a chat, before its first accept. This field *is* the ref layer.
- `BlueprintGadgetRecord.codeVersion` is superseded by a stored `commitId`; blueprint
  export builds the archive from the commit tree, import writes an initial commit
  (preserving ancestry where the archive carries commit objects — sets up GitHub
  interop and cross-gadget dedup for blueprint-derived gadgets). `codeVersionDate`
  derives from the commit's timestamp.
- Readers of committed code switch from `buildYDoc` to `readCommitFiles`:
  `loadGadgetWorker` (`overseer.ts:2366`), UI bundle reads (`overseer.ts:9242`),
  blueprint export (`snapshotCode`). Where a chat context applies, the chat overlay
  still comes from the chat's Yjs state as today.

### 3. Chat flow

- Chat state records **two commits per touched gadget**:
  - `seedCommit` — the commit whose tree seeded the chat's Y.Doc root for this gadget.
    **Immutable for the life of the chat**: the deterministic seed is derived from it,
    so changing it would invalidate every Yjs update recorded since.
  - `mergedCommit` — the most recent mainline commit whose content has been merged
    into the chat. Starts equal to `seedCommit`; advances on update-from-mainline.
  - Gadgets created within the chat have neither (both null).
- The pins (and seed hash) are established **at chat creation**, one pin per committed
  gadget, rather than lazily on first code involvement: clients need the pins before
  they can build the doc their edits apply to, so a lazy scheme would need an extra
  "establish now" RPC for the editor path. A head that advances between chat creation
  and first use reaches the chat through update-from-mainline like any other staleness.
- Session docs (`getSessionYDoc` in agent.ts, and the frontend's chat doc) are seeded
  by applying `seedDocFromFiles(readCommitFiles(seedCommit))` (verified against the
  chat's stored seed hash), then applying the chat's proposed updates + drafts as
  today. The `"changes"` message / draft / compaction machinery is unchanged — it is
  exactly the "Yjs tracks uncommitted changes per chat" model.
- **Accept** (`mergeChanges` rewrite):
  1. For every gadget touched by the fold of proposed changes, check
     `chat.mergedCommit[gadget] == gadgetRecord.commitId`. Any mismatch makes the whole
     accept a no-op returning a "stale" outcome (no partial accepts) — an expected
     result reported as a value (`MergeChangesResult`), not an exception, since someone
     else's accept can land at any time.
  2. Flatten the chat doc per gadget → file map → `writeFilesAsCommit` with parent =
     head (parentless for chat-created gadgets).
  3. Update `GadgetRecord.commitId`s, promote pending gadgets/binding edges, write the
     `"merge"` message — all in one DO event (output gate makes storage atomic).
  - Objects are written **only** here (plus migration/import), so reverted chats leave
    zero garbage.
  - `mergeThrough` is validated against recorded history (a future sequence would
    retroactively claim later-recorded changes), and a partial accept may not exclude a
    still-proposed update-from-mainline batch (its pin advancement is already in force;
    accepting around it would overwrite the mainline content it delivered) — both are
    thrown errors, unlike the stale outcome, since they indicate client bugs rather
    than expected races.
  - A covered creation **always gets a first commit — an empty tree if the gadget has
    no files yet — and promotes**. Coverage is never inferred from content equality
    (an empty gadget compares equal to the empty base, which used to drop creations
    from accepts), and every promoted gadget has a head other chats' pins can see, so
    `pending` keeps its single meaning: creation still proposed. (The alternative —
    leaving a covered-but-empty creation pending — was tried and rejected: it made
    "merged but still pending" a state every consumer of `pending` had to know about,
    e.g. compaction's proposed-structure seeding and revert's deletion sweep.) One
    exception: a pending record whose stamp the log already marks *reverted* — a
    failed revert cleanup awaiting reconciliation — is excluded from coverage
    entirely, so an accept can't resurrect a rejected gadget as an empty commit.
    Blueprints of code-less gadgets (head absent *or* an empty tree) can't be
    created, and empty blueprint archives are refused at instantiation.
- **Update-from-mainline** (new Overseer operation):
  1. Per stale gadget: `threeWayMerge(readCommitFiles(mergedCommit),
     readCommitFiles(head), flatten(chatDoc))` — the last merged commit is the common
     ancestor; no merge-base discovery needed.
  2. Convert the merged file map into a Yjs update against the current chat doc using
     minimal per-file text diffs applied to the `Y.Text` instances (so concurrent live
     editors converge instead of seeing delete-all/reinsert), recorded as a normal
     `"changes"` message.
  3. Advance `mergedCommit` to head. `seedCommit` is untouched — the chat's Yjs
     history remains anchored to it; the merge result is just more uncommitted change
     on top. A subsequent accept is a plain commit on head (assuming mainline didn't
     move again).
  - Conflict markers stay in the files; surface `conflictPaths` in the message
    (qualified as `GADGET_NAME/path`, since a chat can merge several gadgets at once)
    so the UI/agent can point at them.
  - Whenever pins advance, the `"changes"` message is recorded **even if the merge
    produced no update** (chat content already matched mainline): the message is the
    durable record of the advancement that the revert restriction below keys on.
  - The "minimal per-file text diff" is a line-level multi-hunk diff, not a single
    prefix/suffix hunk: a whole-middle replacement would orphan a concurrent
    editor's edits sitting *between* two changed regions. The diff itself is the
    diff3 package's own engine (`diff3/onp.js`, the module behind the merge's
    diff3Merge), whose flat edit script folds into hunks. Hunks are applied
    back-to-front; boundaries must never split a UTF-16 surrogate pair: Yjs encodes
    update payloads as UTF-8, under which a lone surrogate becomes U+FFFD, so a
    mid-pair boundary would make remote replicas decode different content than the
    local doc (see applyTextEdit in yjs-files.ts). Line splitting (`splitLines` in
    git-store.ts, shared with the diff3 merge) is lossless — only `\n` ends a line;
    a bare `\r` or U+2028/U+2029 stays inside its line rather than becoming a
    boundary the split can't retain.
- **Revert** is unchanged (fold-level erasure; nothing to clean up in the object
  store) — with one new restriction: a *still-proposed* update-from-mainline batch
  cannot be reverted, because it advanced the chat's `mergedCommit` pins and the
  pins' prior values aren't recorded; erasing the update while the pins stand would
  let a later accept silently overwrite the mainline changes it delivered. A richer
  scheme (recording pre-merge pins on the message so reverts can roll them back) is
  future work if the restriction chafes.
- **Concurrency**: accept, update-from-mainline, and revert all read chat state, may
  await, and write chat state back — and every `await` is an interleaving point even
  in a single-threaded DO. A per-chat operation lock (`withChatLock`) serializes
  these three against each other (two concurrent update-from-mainlines would
  otherwise double-apply the merge as two CRDT insertions). Accept and
  update-from-mainline re-read chat meta and re-check the chat's next-sequence token
  after their last await to catch everything the lock doesn't cover (agent turns
  starting, drafts materializing, chat deletion, other chats' accepts advancing
  heads). Revert is instead **message-first**: after one idempotent
  `reconcilePendingGadgets` await, everything through the revert message and edge
  deletions is synchronous (atomic under the output gate), and the awaited
  provisional-gadget deletions run *after* the message — a destructive change never
  outruns its durable record, and a crash partway leaves records the log marks
  reverted, which the next `reconcilePendingGadgets` reaps.
- The merge/revert status of a `"changes"` message is computed by one shared rule
  (`chatChangeStatuses` in agent-compaction.ts, mirroring `foldProposedChanges`):
  strictly in log order (a marking message affects only changes recorded before it),
  merges inclusive of `mergeThrough`, earliest marking wins. Agent replay, chat-doc
  construction, and the accept/revert guards all use it, so the doc an accept commits
  is always the doc the agent (and every reader) derived.
- Mainline Yjs doc, the `code` log (for new writes), snapshots, and standalone
  editing paths are all retired.

### 4. Migration (Overseer constructor, `version` singleton)

- Runs in the Overseer DO constructor, triggered by bumping the `version` singleton
  (1 -> 2; new workspaces are born at 2), like previous storage migrations — but unlike
  them it awaits (git object writes, the owner-identity fetch), so it runs under
  `ctx.blockConcurrencyWhile`, with agent-turn resumption chained after it via `.then()`
  (resuming earlier would let turns interleave with the migration's rewrites of the very
  chat state they read; running it *inside* the callback would make the resumed turns'
  work inherit the critical section — the microtask continuation still beats any blocked
  event's delivery). A failure aborts the DO; the next wake retries. Idempotent in
  structure (content-addressed object writes are naturally re-runnable; record updates
  happen after object writes, and the version stamp is written last). Implemented as
  `migrateCodeLogToGit()` in `git-migration.ts`, expressed against the storage schema and
  small callbacks so tests drive it over synthetic logs on mock storage.
- Per gadget root, replay the `code` update log (using existing `replayUpdates`
  snapshot support) and synthesize a commit chain:
  - Materialize a commit at **every code version recorded by a `merge` message** in
    any chat (`version`, present on every historical merge). The chat history is a
    complete record of past `mergeChanges()` calls, so these are the principled commit
    points — each one is a moment a user deliberately accepted changes.
  - **Plus** any version where the gap to the *next* `CodeUpdate` timestamp is ≥ 1
    hour (batching keystroke bursts from old standalone editing, which bypassed
    merges), **plus** the final version, **plus** every persisted pinned version
    (next bullet). Pinned versions are first resolved to the last code-log version at
    or below them, so the pinned state is exactly some commit's tree: legacy versions
    came from the shared change counter, which non-code changes (binding edits,
    creation-only merges) also consumed, so a persisted version need not have a code
    entry of its own. (A merge-message `version` becomes a commit point only when it
    *is* a code entry; a counter-only merge version correctly backfills to
    `commits: []`.)
  - Skip versions where the gadget's flattened files are unchanged from its previous
    synthesized commit (most updates touch one gadget; others' chains stay short).
  - Commit timestamps from `CodeUpdate.timestamp`; author = workspace owner identity
    (fetched via `whoamiIfExists()`, degrading to a placeholder rather than blocking
    the migration on an unreachable or deleted owner account); generated message
    (`"Import pre-git history (code versions X-Y)"`).
- **Backfill `commits` on historical `merge` messages**: rewrite each stored merge
  message, setting `commits` to the synthesized commits at its recorded `version`
  (the gadgets whose files changed there; empty when the merge changed no code).
  Combined with the pre-git writer already recording `commits: []` (accurate: those
  merges create no commits), this makes the field **required** on the wire — every
  delivered merge message carries it, forever.
- **Pinned versions** — every persisted code-version reference must map to a
  synthesized commit:
  - Live chats' `observedCodeVersion` (in `"changes"` messages, in
    `AiToolCall.observedCodeVersion` details riding stored messages, and in compaction
    checkpoints, agent.ts:133 — the latter two always reference some chat's fold
    history, so enumerating each live chat's observed versions covers them).
  - `BlueprintGadgetRecord.codeVersion` (`overseer.ts:435`) — used to reconstruct the
    exported snapshot at `overseer.ts:8790`; each becomes the record's `commitId`.
  - The `codeVersion` singleton is only a loader-cache counter — no pin needed.
  - Review `makeOverseerStorage()` once more during implementation for any stragglers.
- Rewrite live chats' pinned versions to `seedCommit`/`mergedCommit` maps (both set to
  the synthesized commit at the chat's observed version).
  - Caveat to handle: the synthesized seed doc and the historical doc are different
    CRDT instances, so old updates do NOT apply to a freshly-seeded doc. For
    *pre-existing* chats, keep seeding from the legacy log (`buildYDoc` at the chat's
    observed version) until the chat merges or reverts; only new chats use
    commit-seeded docs. (Staleness checks and accept still work identically — accept
    flattens whatever doc the chat has and commits on head.) This is the main reason
    the old `code`/`snapshots` collections stay read-only rather than being deleted:
    they remain the CRDT base for in-flight chats.
- Old `code` and `snapshots` collections: no new writes, retained read-only; deletion
  is a later cleanup change once in-flight chats have drained.
- **The commit-backed backend (§3, already landed) is not deployable until this
  migration lands.** Two concrete reasons: on an existing workspace, new chats pin an
  empty code base (no gadget has a `commitId` yet) so agents see no code, and a legacy
  chat's accept — commit-less gadget, pin-less chat — passes the fast-forward gate and
  installs the chat's anchored content as the first commit, silently discarding legacy
  mainline the anchor predates. The migration's synthesized commits and rewritten pins
  are exactly what arm the stale gate for legacy chats: pin `mergedCommit` at the
  synthesized commit of the same version `legacyChatBaseVersion` resolves, so accept
  and update-from-mainline agree on the chat's base.
- Migration test to include: a legacy chat whose *user-authored* updates carry
  `observedCodeVersion` stamps **later** than the chat's anchor (allowed — user stamps
  only seed the agent's version lock). Such updates can reference Yjs items the
  anchored doc lacks; Yjs parks them as pending structs, so they silently vanish from
  flattened content. Old readers built at "current" and never saw this; the anchored
  `buildChatDoc` can. Verify the migration's pin choice (or an explicit fix) keeps
  such a chat's accept from dropping those edits.
  - **Resolution (the explicit fix)**: the anchor rule became "maximum referenced
    version" rather than "first stamp" — the shared `legacyChatBaseVersion()` in
    agent-compaction.ts takes the max over the active checkpoint's stamp, tool-call and
    changes-message `observedCodeVersion`s, and merge messages' `version`s. A Yjs
    update applies cleanly to any doc state including the one it was built against, so
    the max is the smallest base that can represent every recorded update. Merge
    versions are included so a chat whose own accept was the last mainline movement
    pins at the tip it created (no spurious update-from-mainline round). The overseer's
    chat-doc construction and the migration's pin choice both use this one rule. (The
    agent's own replay latch is unchanged: its session doc may still anchor lower, a
    pre-existing quirk, but accept commits the buildChatDoc flatten, which now loses
    nothing.)

### 5. Protocol changes (`workshop-shared/src/api.ts`)

- **`subscribeToCode` is removed outright**, along with `CodeSubscriber`; `CodeUpdate`
  leaves the public API (it survives only as an internal type in overseer's storage
  schema for the read-only legacy collections). The correct way to observe a chat's
  code is to subscribe to the chat itself and watch `"changes"` messages — which
  already exists.
- **`WorkpieceSummary` gains the gadget's `commitId`**, and `subscribeToWorkpieces`
  notifies when it changes. This replaces `subscribeToCode`'s previous purpose of
  tracking mainline code movement.
- **New read API: code at a commit** — `getCodeAtCommit(commitId) →
  {files: Record<string,string>}` — used when viewing code in a chat with no proposed
  changes, or when viewing code outside any chat. Commits are immutable, so responses
  are cacheable client-side by oid.
- **`updateCode`'s `chatId` becomes required** (editing happens only within chats; the
  method now records only live draft edits on a chat's branch).
- Version numbers are replaced by commit oids where they were load-bearing
  (`observedCodeVersion` → per-gadget `seedCommit`/`mergedCommit`;
  `BlueprintGadgetRecord` surfaces; `codeVersionDate` from commit timestamps). The
  legacy `observedCodeVersion` fields (changes messages, `AiToolCall`) and the merge
  message's `version` stay, doc-marked legacy, because replaying pre-git-storage chats
  depends on them; the merge message gains `commits` (per-gadget new heads) —
  **required, not optional**: the migration synthesizes a commit at every historical
  merge's version and backfills the field (§4), and the pre-git writer records an
  accurate `commits: []` in the interim.
- **Chat pins ride `AiChatMetadata.codeBase`** (`ChatCodeBase` / `ChatGadgetPin`):
  per-gadget `seedCommit`(optional — absent for roots that entered the chat via
  update-from-mainline or in-chat creation)/`mergedCommit` pins plus the chat's
  `seedHash`, delivered and re-delivered via the existing metadata subscription. Each
  pin denormalizes `filesRoot` so it stays interpretable after gadget deletion.
  `seedHash` absent marks a pre-git-storage chat whose Yjs base is not derivable from
  commits; **`getLegacyChatDocBase(chatId)`** returns that base as a whole-doc V2
  update (the client-side counterpart of §4's legacy-seeding path).
- New API surface: `updateChatFromMainline(chatId) → {conflictPaths}` (also recorded on
  the changes message as `mainlineMerge`); `mergeChanges` returns `MergeChangesResult`
  (`outcome: "merged" | "stale"` — staleness is expected control flow, reported as a
  value rather than thrown); commit metadata exposure via
  `getCommitLog(fromCommit, depth?)` returning the shared `CommitInfo` type (enough for
  a future history UI).
- `CommitIdentity`/`CommitInfo` are defined in api.ts and imported by git-store.ts
  (which previously defined them locally) — one definition, no backend mirror.
- Kernel review bar: doc-comment every touched/added export; no hand-written mirrors
  of RPC types; keep the diff minimal.
- Keeping the tree *compiling* mid-sequence -- reviewability beats intermediate
  functionality, so no transitional shims that a later commit of the same PR would
  delete: `CodeUpdate` moves into overseer.ts as an internal type (the storage schema
  of the `code`/`snapshots` collections); the `subscribeToCode` implementation, its
  `CodeSubscriber` callback type, and the use-role deny are deleted together with the
  interface method; the new interface methods get throwing stubs in
  `OverseerClientInterface` and denies in `UseOverseerInterface` (whose
  `implements Overseer` forces both at compile time); and the frontend's
  now-uncallable sync paths are simply deleted, leaving the code view rendering its
  loading state ("out of service") until the frontend commit rebuilds it on
  commit-seeded chat docs.

### 6. Frontend

- `GadgetCodeInterface` layering collapses from three layers (mainline doc → proposed
  → drafts) to two (commit-seeded chat doc → drafts). The browser derives chat-doc
  seeds itself via the shared `@gadgets/workshop-shared/yjs-seed` module (the same code
  the server runs), verifying against the chat's stored seed hash. Viewing code outside
  a chat (or in a chat with no proposed changes) uses `getCodeAtCommit` — read-only, no
  Yjs doc at all.
- Remove standalone editing surfaces (editing is only reachable within a chat).
- Accept-flow UX: when accept returns a stale outcome, offer "update from mainline";
  after an update-with-conflicts, show the conflicted files (markers are visible in
  the editor; a richer resolution workflow is future work).

## Commit sequence (one PR)

Ordered so the kernel-critical diffs are isolated and each commit builds/tests green:

1. **git-store**: `git-store.ts` (fs shim, plumbing helpers, `threeWayMerge`, author
   helper), `gitObjects` collection, isomorphic-git + diff3 dependencies in
   workshop-backend; deterministic seeding as the shared `yjs-seed` module in
   workshop-shared (with `yjs` added as a dependency there); workerd tests (including
   golden-byte seed test). No behavior change anywhere else.
2. **workshop-shared API**: removal of `subscribeToCode`/`CodeSubscriber`/public
   `CodeUpdate`; required `updateCode` chatId; `WorkpieceSummary.commitId`;
   `getCodeAtCommit`/`getCommitLog`/`getLegacyChatDocBase`; `ChatCodeBase` pins on
   chat metadata; `updateChatFromMainline` + `mainlineMerge`/`commits` message fields;
   stale-accept outcome; `CommitIdentity`/`CommitInfo` (shared with git-store) — fully
   doc-commented. Rides with the minimal keep-compiling fallout described in §5:
   internal `CodeUpdate` type + deletion of the `subscribeToCode` implementation in
   overseer.ts, throwing stubs/denies for the new methods, and deletion of the
   frontend's mainline sync paths (the code view is out of service until commit 5).
3. **commit-backed backend**: `GadgetRecord.commitId`, accept/update-from-mainline/
   revert flows, commit-seeded session docs (with seed-hash verification), readers
   switched to commit trees, blueprint export/import on commits, retirement of
   mainline Yjs writes and standalone editing paths.
4. **migration**: constructor migration (log→commit synthesis at merge-message
   versions plus 1-hour batching, pinned-version commits, `commits` backfill on
   historical merge messages, chat pin rewriting), legacy-seeding path for in-flight
   chats, read-only retention of `code`/`snapshots`. Tests over synthetic logs (merge
   points, burst batching, multi-gadget, live-chat pins, blueprint pins).
5. **frontend**: chat-doc layering, `getCodeAtCommit` viewing, standalone-editing
   removal, stale-accept / update-from-mainline UX.

## Accepted tradeoffs / future work

- No delta compression (isomorphic-git never writes deltas); zlib'd whole blobs with
  content-address dedup. Revisit if large files show up.
- SHA-1 (the only format isomorphic-git supports; also the interop default).
- No GC yet; roots enumeration is kept possible.
- No >2MB objects yet; chunking or R2 spill is a shim-local follow-up.
- Multi-commit chat sessions, agent-less chats for manual edits, history UI,
  GitHub push/pull via gatekeepers, git protocol: future changes this design
  deliberately leaves room for.

## Future consideration: replacing Yjs with operational transforms

Once mainline lives in git, Yjs's remaining job shrinks to "represent one chat's
uncommitted changes and synchronize live editors". That's a much better fit for OT
than the original workspace-wide CRDT role was, and OT would compose more naturally
with git. Worth considering as a follow-on change; not part of this plan.

**Why OT fits the git-backed model:**

- An OT operation is expressed purely against the file content as of some revision —
  exactly "a change relative to commit X". No CRDT identity graph, no tombstones, no
  seeding problem: the base *is* the git tree, and the deterministic-seed machinery
  (reserved clientID, seed hashes, golden-byte tests, the immutable-`seedCommit`
  constraint) disappears entirely.
- Update-from-mainline becomes native: rebasing a chat onto a new head is literally
  OT's transform operation (or, degenerately, re-diffing merged content), rather than
  a diff smuggled through CRDT updates.
- The chat's uncommitted state can always be compacted to a plain diff against its
  base commit — bounded by content size, not edit history. Today's compaction
  machinery exists precisely because CRDT state can't be compacted that way.
- OT's classic weakness — requiring a central sequencer — is moot here: the Overseer
  DO is already a single-threaded authoritative sequencer for every chat.
- Removes the Yjs dependency (and its update encodings) from the kernel and the wire
  protocol.

**Why not (or not yet):**

- Transform functions are notoriously hard to get right (TP1/TP2 correctness);
  the mature open-source options are unmaintained (ot.js) or heavyweight (ShareDB).
  We'd likely write and own a small text-OT core, which is real, subtle work.
- The entire editor stack is Yjs-native today: y-codemirror bindings give sync,
  presence/cursors, and local undo (Y.UndoManager) for free. OT needs equivalent
  client integration built or adopted.
- Offline and reconnect handling is where CRDTs quietly do a lot of work; OT clients
  must buffer and transform against missed server ops on reconnect — more protocol
  code, more edge cases.
- The chat message format (`"changes"` carrying Yjs updates, compaction checkpoints)
  would change shape again, with another migration for in-flight chats.
- Nothing in the git move *requires* it: Yjs-as-uncommitted-layer works, and this plan
  already isolates it behind the chat boundary. The right time to revisit is when the
  seed-determinism constraints chafe (e.g. wanting to change seeding, or multi-commit
  chat sessions making rebases frequent) or when a Yjs upgrade threatens encoding
  stability.

**Net**: this plan intentionally narrows Yjs's role to the point where an OT swap
becomes a bounded, chat-local change rather than a rewrite. Decide after living with
the git-backed model for a while.

---

# Part 2: Lazy per-gadget pinning

Part 1 (above) is fully implemented on this branch but **not yet deployed anywhere**,
so Part 2 may freely change anything Part 1 introduced — wire types, storage shapes,
the seed algorithm, the migration — without compatibility shims. The only
compatibility obligation is with the *pre-git* state: legacy chats, the legacy
`code`/`snapshots` collections, and the migration path from them.

## Problem with Part 1's eager pinning

Every chat pins **all** committed gadgets' code at chat creation
(`makeChatCodeBase()`, one pin per committed gadget, `seedCommit = mergedCommit =
head`, plus a chat-wide seed hash). This is wrong in the common case where a thread
never touches code:

- A user chatting in thread A (e.g. filling in slide content) while code is modified
  in thread B sees, back in thread A, the *old* code — their changes apparently
  reverted. Worse, if thread B changed the storage schema, gadget previews in thread A
  run old code against new storage: potential corruption.
- The eager pin is also the most expensive part of chat creation: a full tree read of
  every committed gadget just to hash a seed that usually never matters.

## New model — locked decisions

- **A gadget becomes pinned only when its code is first *modified* in the chat**,
  independently per gadget. Unpinned gadgets always track mainline head — reads (agent
  and UI) see current committed code, live.
- **Pin establishment is declared by the editing client.** Every `updateCode()` call
  carries the code-base **generation** it is rooted in (see the `updateCode` design
  section), plus — when it is the first edit to an unpinned gadget — a pin
  declaration naming the base commit the client's doc derives from. The server
  validates the base is the gadget's tip **or a parent of the tip** (graceful
  handling of racing one merge; anything older is rejected) and pins there. If a
  conflicting pin already exists (race), the call **throws** and the client discards
  its keystrokes — rare, loses at most a moment of typing.
- **Agent reads of unpinned gadgets do not pin.** Each such read stamps the commit it
  observed; if the gadget's code is not yet pinned, and it changes as a result of
  activity in another thread (per-file check, see below), future turns **elide** that
  read's content from the model context, replacing it with a note that the code has
  changed and must be re-read. No diffs delivered — re-reading is simpler for the
  model and this situation is rare.
- **Accepting changes unpins everything and discards the chat's Y.Doc.** The chat's
  life divides into **epochs** bounded by merge messages; each merge resets the code
  base to empty (all content is now in commits) and subsequent edits re-pin lazily. A
  client typing across a merge gets its post-merge `updateCode` rejected (generation
  mismatch) and discards those keystrokes.
- **`mergeChanges` loses `mergeThrough` *and* `includeDraft`** — it always merges all
  proposed changes and always sweeps live drafts in. Not merely a simplification:
  under epoch reset, an excluded remainder or an un-included draft would be rooted in
  the discarded doc and destroyed, so partial accepts are incoherent in this model.
- **Legacy (pre-git) chats graduate at their first merge.** The merge's commits fully
  capture the chat's content, so the epoch reset applies to them identically; after it
  they are ordinary new-model chats. This drains the legacy `code`/`snapshots`
  dependency one merge at a time.
- **Per-file staleness via blob oids, never content loads.** isomorphic-git's
  `readTree` returns each entry's oid without touching blob content (exactly how
  `#collectTreeFiles` already walks), so comparing two commits' file oids — with a
  subtree-oid short-circuit — is cheap and uses only supported API. If this had
  required hand-rolled tree parsing we would have compared commit ids instead; it
  doesn't.

## The two structural consequences (and their resolutions)

### Epochs: "the base never advances" is repealed

Part 1's invariant — a chat's Yjs base is immutable, so *every* non-reverted
`"changes"` update (accepted ones included) applies forever — is load-bearing in four
places: `buildChatDoc`, agent replay, the frontend's `computeChatDocUpdates`, and
compaction checkpoints' `acceptedChanges`. Unpin-after-merge breaks it: updates from
*closed* epochs are rooted in pins (and seeds) that no longer exist, yet replay still
needs to reconstruct past epochs' docs (for `observeUserChanges` diffs, `readFile`
recomputation, `buildChatDoc(through)`).

**Resolution: pins become part of the chat log.** Each `"changes"` message records
the pins it establishes (`pins: {gadgetId, filesRoot, baseCommit, seedHash}[]`). Doc
reconstruction walks the log in order: an epoch-boundary merge message → discard the
doc and start fresh; a pin declaration → derive that root's seed from
`readCommitFiles(baseCommit)` and apply it; then apply the message's update. Commits
are content-addressed and immutable, so reconstruction is deterministic. The log pin
carries `seedHash` itself, so derivation drift fails loudly even for closed epochs,
whose pins are long gone from metadata. There is deliberately **no seed-version
field yet**: if the seed algorithm ever changes, a `seedVersion` will be added to
pin records *then*, with absence permanently meaning version 1 — fully
backwards-compatible by construction, since every record written until that day
lacks the field and is version 1. (This per-pin gate is the successor of Part 1's
per-chat seed-version note.) `AiChatMetadata.codeBase` remains as the authoritative
*current-epoch* state (what validation and live clients key on), reconstructible from
the log. Compaction checkpoints record the pins active at the boundary, in the same
full shape (like they record `chatBindings`).

**Seeds are always derived from the pinned commit, never taken from the client.** An
`updateCode` payload contains only the client's own keystrokes under its own random
clientID; the base content comes from the server's (or each client's) own derivation
from the commit. This keeps trust clean: a client cannot misrepresent the base it
claims to edit against, and the 3-way merge base is always genuinely the pinned tree.

### Per-root seeds: the single-call constraint is repealed

Part 1's `seedDocFromFiles` requires all of a chat's roots in one call (each call
restarts the reserved clientID's clock at zero, so two seeds collide in one doc).
Lazy pinning seeds roots **at different times** into the same doc.

**Resolution: a reserved seed clientID band, excluded from live docs by
construction.** `seedClientIdForGadget(id) = SEED_CLIENT_ID_BASE + gadgetId`, with
gadget IDs asserted below the band's width (they are small per-workspace counters;
the band is `[SEED_CLIENT_ID_BASE, SEED_CLIENT_ID_END)`, comfortably inside uint32).
ClientIDs are then unique per root within a doc; each root is seeded at most once per
epoch, and each epoch is a fresh doc, so clock-from-zero per seeding is sound.

Note that Part 1's collision argument **does not carry over**: it relied on the seed
being the *first* update a doc applies, so a doc that randomly collided with the
reserved ID re-rolled before authoring anything. Lazy seeds are applied to docs that
may already contain edits — if a live doc had randomly picked an ID inside the band
and authored items under it, a later seed under that ID would overlap its clocks and
be silently skipped as already-known: divergence, not a re-roll. So the band is kept
out of live docs *by construction*, not probability:

- Every first-party doc that authors chat updates binds its clientID through a
  shared yjs-seed helper (`bindLiveDocClientId(doc)` or equivalent) that both
  allocates an out-of-band ID up front **and enforces it for the doc's lifetime**:
  Yjs re-rolls `doc.clientID` itself on detecting a concurrent collision
  (Transaction.js:357-359, `generateNewClientId()` — unrestricted uint32), so a doc
  can land inside the band *after* allocation. The helper hooks the doc (e.g.
  `afterTransactionCleanup`, where Yjs's re-roll happens) and re-rolls out-of-band
  whenever the ID is in-band, before any local authoring can occur under it.
- "Every authoring doc" includes the **server's own**: agent session docs and the
  `updateChatFromMainline` merge path, which authors updates into a `buildChatDoc`
  result via `writeDocFiles` — not just browser editor docs. Seeds themselves are
  only ever authored in throwaway docs, as in Part 1.
- The server **rejects** any incoming update that authors under an in-band clientID —
  `Y.parseUpdateMetaV2` exposes the update's per-client clock ranges cheaply — at both
  ingestion points (`updateCode`, and `addChatMessages` for agent flushes). A
  conforming client can never trip this; it exists so a nonconforming one fails
  loudly instead of corrupting its chat.

The chat-level `seedHash` is replaced by a **per-pin `seedHash`** (same fail-loud
purpose, per seeding event; recorded on the log pin and checkpoint pins, not just
current metadata — see above); golden-byte tests move to the per-root function.

## Design deltas by area

### `updateCode` — pin establishment, editor path

New signature: `updateCode(update, chatId, base)` where `base` carries the chat's
**generation** and optionally a pin declaration `{gadgetId, baseCommit}`.

The generation is a validation token on `codeBase`, bumped by **every operation that
invalidates client docs**: each merge (the epoch reset), each revert (which erases
updates — and possibly pins — that a live doc may be rooted in), and
`discardChatDraftChanges()` (which erases drafts and their unlogged pins the same
way). It is deliberately
not just the epoch: an epoch token would accept a post-revert update rooted in a
removed pin's seed (same epoch, seed gone from the log's non-reverted set —
unreconstructable content), and the server cannot tell which gadget an opaque Yjs
update touches, so it cannot catch this per-gadget. Pin *additions* and
update-from-mainline do not bump: existing docs stay valid under both (Yjs parks
updates that arrive ahead of a seed and integrates them when it lands). Note the
generation also converts a pre-existing silent-loss race — typing over just-reverted
content leaves Yjs structs parked forever, in Part 1 and pre-git alike — into an
explicit, client-visible discard.

Server, in one synchronous step with recording the draft (atomic under the output
gate):

- Generation mismatch → throw. The client discards queued keystrokes and rebuilds
  from fresh metadata (the merge- or revert-race case).
- Pin declared, gadget unpinned → validate `baseCommit` is the gadget's tip or a
  parent of the tip (one `readCommit`; note the validation git read happens *before*
  the synchronous record step), then write the pin (with derived `seedHash`) into
  `codeBase`.
- Pin declared but a different pin exists → throw (client discards keystrokes).
- Update authors under a reserved-band clientID → throw (see the seed-band
  enforcement above).
- Draft materialization (`materializeChatDraft`) stamps any meta-pins not yet
  declared in the log onto the `"changes"` message it writes, closing the meta/log
  loop.

This answers Part 1's stated objection to laziness ("clients need the pins before
they can build the doc" / "an extra establish-now RPC"): establishment rides
`updateCode` itself, and the client derives the seed locally and optimistically.

### Agent path — pin on first write, read live, elide stale reads

- **Reads** (`readFile`): pinned root → session doc, unstamped (never stale within
  the epoch), as today. Unpinned → `readCommitFiles(head)` via a hook, stamping a new
  `AiToolCall.observedCommit` (40-hex) on the call; track the per-gadget observed
  head in-turn. The system-prompt file list follows the same split. Amend the tool
  description's promise that the agent "will be informed any time a file changes"
  (agent.ts:633) — for unpinned gadgets the mechanism is now elision + re-read.
- **Replay of stamped reads**: prefetch, per turn, the per-file oid diff
  (`changedPaths`) between each distinct `observedCommit` and the gadget's current
  base — head if still unpinned, `pin.seedCommit` if since pinned. File changed →
  elide, substituting a note modeled on the existing reverted-read elision
  (agent.ts:1650-1662; fix the "reuslts" typo while there), and do **not** add the
  file to `filesRead`, so `editFile`'s read-before-edit gate forces the re-read. File
  unchanged → recompute content from `readCommitFiles(observedCommit)`. Reads already
  swallowed by a compaction summary are unrecoverable by this mechanism — accepted,
  same as reverts today; `filesRead` already resets at boundaries.
- **Writes** (`writeFile`/`editFile`) on an unpinned gadget establish the pin at the
  **current head — always, regardless of past reads**. A read that observed an older
  head is (or will be) elided, and a previously-elided read must not spring back to
  life as the anchor of a later write; the pin therefore never derives from an
  observed commit. Correspondingly, `editFile`'s read-before-edit gate tightens: the
  prior read must have observed the file's *current* content — per-file oid check of
  the read's `observedCommit` against head — so a read of an older version, elided or
  not, does not satisfy it, and the tool errors telling the agent to re-read. Yes,
  a merge landing in another thread between a read and an edit fails the edit
  immediately after a successful read; that's correct — the error directs the agent
  to re-read and try again. (`writeFile` requires no prior read and simply pins at
  head; a whole-file overwrite is coherent against any base.) Note this also means
  an edit's content is always consistent with its pin: the gate guarantees the file
  the agent read is byte-identical at the pinned head, even if the read's
  `observedCommit` is an older oid. Mechanics: the hook establishes the pin, applies
  the derived seed to the session doc as a remote update under a **non-capture
  transaction origin** (so seed items never ride the flushed update — clients derive
  the same seed from the logged pin), then applies the edit. Newly established pins
  accumulate in-turn and ride the next `flushCapturedYdocChanges` message's `pins`;
  `addChatMessages` re-validates and mirrors them into `codeBase` in its existing
  synchronous step (same pattern as pending-gadget sequence stamping).

### Accept (`mergeChanges`) — always everything, then reset

- Signature: `mergeChanges(chatId)`. Always materializes drafts first; merges all
  proposed changes.
- The per-touched-gadget fast-forward gate is unchanged in spirit
  (`pin.mergedCommit == head`; chat-created gadgets: both absent). Pinned-but-
  untouched gadgets don't gate — their pin simply evaporates in the reset.
- The "cannot accept around a mainlineMerge batch" throw dies with `mergeThrough`.
- After commits land and heads fast-forward: `codeBase = {gadgets: [], generation:
  generation + 1, epoch: mergeSeq}` — dropping the `legacy` flag if present
  (**legacy graduation**) — delete residual drafts, and write the merge message with
  `epochBoundary: true` and a
  server-computed `mergeThrough` (last covered sequence, still feeding
  `chatChangeStatuses`). `epochBoundary` distinguishes new-model merges from
  pre-git historical merges (whose backfilled `commits` field alone cannot), so
  replay knows exactly which merges reset the doc.

### `updateChatFromMainline` — pinned-and-behind only

The stale set becomes *pinned gadgets whose `mergedCommit` ≠ head*. Part 1's behavior
of pulling never-touched committed gadgets into the chat (absent pin + committed head
⇒ stale) is deleted — under lazy pins, unpinned means "tracks head live", which is
the point. Advancing `mergedCommit` on merged-in pins is unchanged, as is the
restriction that a still-proposed mainlineMerge batch cannot be reverted.

### Revert — rolls back pins, discards drafts, bumps the generation

- Reverting messages that *declared* pins removes those pins from `codeBase`: unlike
  `mergedCommit` advancement (whose prior value is unrecorded, hence the
  mainlineMerge restriction), a declared pin's prior state is trivially "unpinned".
  A pin survives a revert iff its declaring message survives — and a meta-pin with
  *no* logged declaration (established by `updateCode` but whose drafts never
  materialized) is removed too, since the drafts that motivated it die with the
  revert (next bullet). The existing `discardChatDraftChanges()` (api.ts:1975) is a
  second draft-discarding path and gets the same treatment: drop unlogged pins,
  bump the generation.
- Revert **discards all outstanding drafts** (`chatDraftUpdates`). Drafts are
  provisional keystrokes strictly newer than every materialized message, so they fall
  inside the reverted range by definition; and a draft recorded after a
  pin-declaring message may be rooted in that pin's seed, which the revert just made
  unreconstructable — materializing such a draft would strand its content as
  permanently parked Yjs structs. Discarding is the only coherent option (refusing
  the revert while drafts exist would block reverts unpredictably, since drafts can
  linger until the next materialization trigger).
- Revert **bumps `codeBase.generation`** (see `updateCode` above), so live editors —
  whose docs still contain the reverted updates and possibly removed seeds — discard
  local state and rebuild instead of submitting updates rooted in erased history.

### Wire/API deltas (`workshop-shared/src/api.ts`)

- `ChatCodeBase` → `{gadgets: ChatGadgetPin[], generation: number, epoch?: number,
  legacy?: true}`. `generation` is the `updateCode` validation token (bumped by
  merge, revert, and draft discard); `epoch` (the sequence of the merge message that
  opened the current epoch, absent = since chat start) keys reconstruction.
  Chat-level `seedHash` deleted; `legacy: true` (written by the migration) replaces
  `seedHash === undefined` as the pre-git discriminator; new chats have **no**
  `codeBase` until their first pin, and **an absent `codeBase` is defined as
  `{gadgets: [], generation: 0}`** — both sides use that reading, so a new chat's
  first `updateCode` passes `generation: 0` and validates against the absent record
  (doc-comment this on `ChatCodeBase` itself; every bump-site therefore materializes
  the record if absent).
- `ChatGadgetPin`: `seedCommit` + per-pin `seedHash` required on new-model pins;
  legacy pins remain `mergedCommit`-only under the chat-level `legacy` flag. (No
  seed-version field — deferred until a second algorithm exists, see the epochs
  section.)
- `updateCode(update, chatId, base: {generation, pin?})` as above.
- `mergeChanges(chatId)`; `MergeChangesResult` unchanged (`merged | stale`).
- `"changes"` message: `pins?: {gadgetId, filesRoot, baseCommit, seedHash}[]` — the
  log pin carries the fail-loud contract itself, since closed epochs are
  reconstructed from these alone.
- `"merge"` message: `epochBoundary?: true` (present on every newly written merge).
- `readFile` `AiToolCall` variant: `observedCommit?: string`.
- `getLegacyChatDocBase` re-documented against the `legacy` flag.
- Kernel review bar as in Part 1: doc-comment every touched export, no mirrors,
  minimal diffs.

### Migration delta

`git-migration.ts` writes `codeBase: {legacy: true, generation: 0, gadgets:
<mergedCommit-only pins>}` for live legacy chats (shape change only; pin values
unchanged). Everything else stands: legacy chats behave exactly as in Part 1 until
their first merge, which graduates them.

### Frontend

- `GadgetCodeInterface`: chat doc = per-pin derived seeds (via the existing
  oid-cached `getCodeAtCommit`) + current-epoch changes + drafts; keyed by
  (generation, pin set) instead of `seedHash`; legacy path keyed on `legacy`.
- Unpinned gadget in a chat: the existing read-only head view, plus the
  **first-keystroke transition** — derive the pin seed locally, swap in an editable
  doc, send `updateCode` with the pin declaration; on throw, discard local edits,
  toast, drop back to the head view.
- Generation mismatch on `updateCode` (a merge, revert, or draft discard raced a
  typist): discard queued updates, surface "your last edits were discarded — the
  chat's changes were merged (or reverted) concurrently", rebuild from fresh
  metadata. Local doc construction keys on the generation (rebuild whenever it
  moves).
- Editable docs allocate their clientID via the shared out-of-band helper (see the
  reserved seed band above).
- Accept banner: no `mergeThrough` computation; the stale-outcome →
  update-from-mainline dialog is unchanged.
- Ordering subtlety to test: a peer can receive a `draftUpdate` referencing seed
  items before it has applied the new pin's seed (metadata delivery race). Yjs parks
  the update as pending structs and integrates it when the seed arrives — verify
  with a test rather than assuming.

## Known edge cases / watch-fors

- **Crash between meta-pin and log-pin** (editor path): the pin lands in `codeBase`
  atomically with the draft record; the log declaration lands at materialization.
  Two paths discard drafts unmaterialized — revert and the existing
  `discardChatDraftChanges()` — and both must drop the drafts' unlogged pins and
  bump the generation (see the revert section); any new draft-discarding path must
  do the same, or `codeBase` and the log disagree and queued client updates can
  still reference a removed seed.
- **Mid-turn head movement** (agent path): the pin is established at the head
  current at edit time but made durable at flush, and head can move in between;
  `addChatMessages`'s synchronous re-validation (pin base == head) is the backstop,
  and a failure there fails the flush (rare, surfaces as a turn error).
- **Compaction checkpoints**: record active pins (full log-pin shape, including
  `seedHash`) + epoch at the boundary; replay applies checkpoint pins'
  seeds before its update blobs. `acceptedChanges` becomes
  legacy-only (new-model chats never carry accepted updates across a boundary — the
  epoch reset already dropped them).
- **Blueprint-from-chat and preview loads** use `buildChatDoc`; they inherit
  epoch-aware reconstruction. Unpinned gadgets in a chat context read head — verify
  preview cache keys account for head movement now that a chat preview can track
  mainline.
- **GC roots** (still no GC): `observedCommit` stamps reference commits nothing else
  roots. Future GC must either root them or the elision path must tolerate a missing
  commit by eliding unconditionally. Record this in the GC-roots enumeration note.
- **`hasProposedChanges` / proposed-changes views**: post-merge these are empty by
  construction; verify the fold rules (`foldProposedChanges`, `chatChangeStatuses`,
  frontend `computeMessageStates`) all scope to the current epoch.

## Deferred / follow-ups

- **"Someone else is typing" merge guard**: `chatDraftUpdates` records carry author +
  timestamp, so `mergeChanges` could refuse — as a distinct, retryable outcome — when
  a draft from a different author landed within the last ~10s. Not airtight
  (in-flight keystrokes are invisible); the generation-mismatch throw is the
  correctness backstop. Ship the throw first; add the heuristic as a follow-up.
- **Large repos / partial materialization**: decided **not** to build per-file
  seeding now. Lazy pinning already keeps unpinned gadgets out of the doc entirely
  (gadget-granularity laziness); within a pinned root, the whole tree still seeds.
  The epoch/pins-in-log architecture would carry over to per-file pin declarations
  (`{gadgetId, baseCommit, files}` gated on a seed-version field), but incremental
  per-file seeding has a real concurrency wrinkle (deterministic clock continuation
  vs. concurrent optimistic seeders). When large repos arrive, prefer the **OT swap**
  (see "Future consideration" above): an OT op references its base by revision +
  path, so base content never enters the history and the entire seeding apparatus —
  deterministic clientIDs, per-pin hashes, golden-byte tests — is deleted rather than
  extended. Large-repo support is the concrete trigger that OT section was waiting
  for.

## Commit sequence (Part 2)

Two commits: **kernel**, then **frontend** — the split AGENTS.md asks for
(`workshop-backend`/`workshop-shared` reviewable apart from UI). There is no
API-first commit this time: Part 2's wire delta is signature tweaks and new fields,
readable alongside its implementation, and a separate API commit would exist only to
carry keep-compiling stubs the next commit deletes.

**The frontend is expected to be broken (not even compiling) after commit 1** — do
not spend any effort keeping it building or limping along, since commit 2 rewrites
the affected paths anyway; transitional frontend shims are pure waste. Verify commit
1 by filtering to the non-frontend packages, e.g. `pnpm --filter
'!@gadgets/workshop-frontend' build` (and the workshop-backend test suite via `pnpm
--filter @gadgets/workshop-backend test:run`); `pnpm lint` may likewise need the
frontend excluded at that point. The full `pnpm build` / `pnpm test` / `pnpm lint`
gate applies after commit 2.

1. **Kernel** (workshop-shared + workshop-backend, including migration):
   - yjs-seed: replace `seedDocFromFiles` with
     `seedRootFromFiles(rootName, files, clientId)` + `seedClientIdForGadget`
     (reserved band, bounds-asserted) + `bindLiveDocClientId` (out-of-band allocation
     **and lifetime enforcement** against Yjs's own collision re-roll); rewrite the
     module contract (one seed per root per doc-epoch, unique clientID per root,
     live docs never author in-band).
   - workshop-shared API: all wire deltas listed above (including `generation` and
     the full log-pin shape), fully doc-commented.
   - Backend: `commitFileOids`/`changedPaths` in git-store; delete
     `makeChatCodeBase` + both call sites; epoch-aware doc reconstruction (shared
     fold rule); `updateCode` validation (generation, pin, in-band-author rejection)
     + pin establishment; `addChatMessages` pin mirroring + in-band-author
     rejection; `mergeChanges` rewrite (reset + generation bump + graduation +
     `epochBoundary`); `updateChatFromMainline` narrowing (with
     `bindLiveDocClientId` on its merge doc); revert + `discardChatDraftChanges`
     rework (pin rollback, draft discard, generation bump — both paths); agent
     read/elide/pin paths (session docs bound out-of-band); checkpoint pins (full
     shape).
   - Migration: `legacy: true` codeBase shape (with `generation`) + test updates.
   - Tests: golden bytes (per-root goldens, a two-pins-one-doc composition test,
     band allocation, a forced-reroll-lands-in-band re-enforcement test), pin
     lifecycle (establish/race/revert-rollback), generation races (merge-, revert-,
     and draft-discard-vs-typist), draft discard on revert and on
     `discardChatDraftChanges`, epoch replay across merges (including seed-hash
     verification of a closed epoch's pins), elision matrix
     (changed/unchanged/per-file/pinned-since), legacy graduation, tip-or-parent
     validation, in-band clientID rejection.
2. **Frontend**: doc layering by (generation, pins), `bindLiveDocClientId` on every
   editable doc, first-keystroke pin flow, generation-mismatch discard UX, merge
   simplification, pending-structs ordering test.
