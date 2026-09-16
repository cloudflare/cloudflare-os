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
- **Chat pins ride `AiChatMetadata.codeBase`** (`ChatCodeBase` / `ChatGadgetPinState`):
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
  must buffer and transform against missed server changes on reconnect — more protocol
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

> **Update: adopted, before deploying rather than after — see Part 3.** Two of the
> three "why not" bullets turned out weaker than assumed once checked against the
> actual code (no awareness/cursors and no Y.UndoManager anywhere — the editor
> integration is just `MonacoBinding`; and `@codemirror/state`'s ChangeSet is a
> maintained, verified fit for the text-OT core), and the third — "another
> migration" — is precisely the cost that only stays avoidable while nothing is
> deployed.

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
- **Drafts acknowledged mid-accept are never discarded by the reset.** `updateCode()`
  runs outside the chat lock, appends nothing to the chat log (so the sequence-token
  revalidation can't see it), and validates against a generation the reset hasn't
  bumped yet — so a draft can land during the accept's awaits already acknowledged to
  the client. The accept's synchronous tail checks for such drafts and **gives up**
  with a retryable throw, leaving the drafts and the chat untouched: someone is
  actively typing, and silently sweeping a mid-keystroke state into the merge would be
  as wrong as losing it. The user retries once the typing settles. (This is the
  correctness backstop behind the deferred "someone else is typing" heuristic below.)

### `updateChatFromMainline` — pinned-and-behind only

The stale set becomes *pinned gadgets whose `mergedCommit` ≠ head*. Part 1's behavior
of pulling never-touched committed gadgets into the chat (absent pin + committed head
⇒ stale) is deleted — under lazy pins, unpinned means "tracks head live", which is
the point. Advancing `mergedCommit` on merged-in pins is unchanged, as is the
restriction that a still-proposed mainlineMerge batch cannot be reverted.

### Invariant: every permanent gadget has a head commit

"Pinned-and-behind only" (and the whole first-edit-pins model) is sound only if a
chat's first edit always has a commit to pin. So: **`GadgetRecord.commitId` is absent
iff the gadget is pending** — a gadget with no code gets an **empty-tree initial
commit**. "Rooted at nothing" is thereby an ordinary pin at the empty tree, not
unpinned doc content.

The alternative — permanent commit-less gadgets whose in-chat edits are plain,
pin-less doc updates — was tried and rejected: once another chat's accept created the
gadget's first commit, the pin-less chat could never pass the fast-forward gate, and
every attempted repair (merging by detecting non-empty doc roots, seedless
`mergedCommit`-only pins, treating "doc root has content" as the agent's
doc-ownership test) amounted to inferring ownership from content — fragile against
racing pin declarations, file deletions emptying a root, and `chatDocOwnsGadget`
flipping to mainline the moment a head appeared. An explicit head closes all of it:
first edits pin (the empty tree seeds an empty root — the deterministic seed of an
empty file map), accept fast-forwards from it, and update-from-mainline's normal
pinned path (base = the pinned empty tree) covers the gadget-gained-code-elsewhere
race.

Enforced at every permanent-creation site: `createGadget` without a chat writes the
empty-tree commit before the record (and `OverseerImpl.createGadget` throws if a
permanent creation arrives without an initial commit), blueprint instantiation writes
the archive's tree as the initial commit *before* creating the record (so a failed
instantiation can't leave a headless record), promotion already commits (possibly an
empty tree) at accept, and the migration roots every permanent gadget's chain at a
version-0 empty-tree commit (see the migration delta below). Pending gadgets remain
head-less: only their own chat can promote them, and their plain-update edits replay
correctly because a flushed write with no pin declaration is recognized as
pending-era (see the agent replay note in "Known edge cases").

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
- A revert that affects **no materialized changes** (everything at or after
  `revertFrom` already merged or reverted) records no revert message — but outstanding
  drafts are strictly newer than every message, hence inside the reverted range, so
  they are still discarded exactly as `discardChatDraftChanges()` would (unlogged pins
  dropped, generation bumped).

### Wire/API deltas (`workshop-shared/src/api.ts`)

- `ChatCodeBase` → `{gadgets: ChatGadgetPinState[], generation: number, epoch?: number,
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
- `ChatGadgetPinState`: `seedCommit` + per-pin `seedHash` required on new-model pins;
  legacy pins remain `mergedCommit`-only under the chat-level `legacy` flag. (No
  seed-version field — deferred until a second algorithm exists, see the epochs
  section.)
- `WorkpieceSummary.commitId`: absent only for pending gadgets (see the head-commit
  invariant above); permanent gadgets always carry it.
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
unchanged), and — for the head-commit invariant above — roots every permanent
gadget's synthesized chain at a **version-0 empty-tree commit**: every permanent
gadget leaves the migration with a head even if the log never gave it content, real
history parents on the empty root, and legacy pins resolve at every anchor
(`chainFloor` finds at least version 0, so a chat anchored before a gadget's first
content pins at the empty tree — exactly the doc's state there — instead of getting
no pin and wedging on the first out-of-chat commit). Pending gadgets get no root and
no pins, as before; blueprint resolution ignores version-0 floors (an empty snapshot
is not a valid blueprint, so those records keep their explicit legacy errors).
Everything else stands: legacy chats behave exactly as in Part 1 until their first
merge, which graduates them.

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
  epoch reset already dropped them), and an epoch boundary in the compacted span also
  clears the checkpoint's `observedCodeVersion`: it is the legacy-graduation
  discriminator agent replay keys `legacyBase` on, and carrying it across the
  graduating boundary would resurrect the retired legacy doc under commit-derived
  seeds.
- **Epoch resets scope the agent's read-before-edit state**: `resetSessionEpoch`
  clears `filesRead` along with the doc and pins — a root pinned in the new epoch
  skips `editFile`'s freshness gate on the strength of a `filesRead` entry, which must
  therefore never be a previous epoch's read.
- **`buildChatDoc(through)` is as-of-`through`**: messages after `through` — including
  epoch boundaries and merge/revert markings — are excluded outright (a boundary
  recorded after the snapshot must not wipe it), and the caller passes a `meta`
  consistent with `through` (`loadGadgetWorker` snapshots meta in the same synchronous
  step as its cache key's sequence, so a graduating merge landing mid-load can't flip
  a pre-graduation snapshot's legacy base). The legacy anchor's compaction checkpoint
  likewise comes from the *passed* meta's `compactedTo`, not a fresh read — a
  compaction advancing mid-load must not leak stamps from beyond `through` into the
  base.
- **Pending-era writes at replay** (agent path): a write to the chat's own pending
  gadget records no pin (there is no head), but replay after the gadget's promotion
  sees one. A *flushed* write with no pin declaration is recognized as pending-era —
  no seeding; the root's content is plain doc updates — while a write with nothing
  recorded after it is a crashed turn's tail and re-establishes a pin at the current
  head, as the resumed turn's own write would.
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
  (see "Future consideration" above): an OT change references its base by revision +
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
     shape); the head-commit invariant (empty-tree initial commits at both
     permanent-creation sites).
   - Migration: `legacy: true` codeBase shape (with `generation`), version-0
     empty-tree chain roots (see the migration delta), + test updates.
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

---

# Part 3: Replace Yjs with OT (CodeMirror's ChangeSet)

Parts 1 and 2 are fully implemented on this branch but **not yet deployed anywhere**,
so Part 3 — like Part 2 before it — may freely change anything they introduced. The
only compatibility obligation remains the *pre-git* state. That timing is the whole
argument for doing this now rather than as the follow-on the Part 1 plan sketched:
once a deployment exists, the Yjs-era chat format becomes a third live format
(pre-git legacy, git+Yjs legacy, OT) that every doc-reconstruction path must support
until those chats drain, and the deterministic-seed algorithm becomes a contract that
pins the yjs version for the duration. Doing it pre-deploy collapses two migrations
into one and means the seeding apparatus never ships at all.

The frontend editor moves from Monaco to **CodeMirror 6 in the same change**: every
Monaco integration point (both y-monaco bindings, the editable diff side, the chat
doc layering) is already rewritten by this part, so a Monaco↔ChangeSet adapter would
be throwaway work that also forces a second QA pass over the same surfaces when the
editor moved later. See the Monaco findings and the frontend section below.

## Why now — what changed since Part 1's "not yet"

Checked against the actual code rather than assumptions:

- **The editor stack is barely Yjs-native.** The frontend uses Monaco + y-monaco's
  `MonacoBinding` with **no awareness/cursors** (the optional awareness argument is
  omitted at both call sites; `y-protocols` is declared but never imported) and **no
  `Y.UndoManager`** (undo is Monaco's own model history, already reset wholesale on
  doc rebuilds). Editing is locked while the agent streams. The real concurrency
  model is one human + the agent, with multi-human convergence handled correctly but
  unfeatured. There are no cursors to transform, and with the editor swap below the
  "editor binding" shrinks to nearly nothing: a CodeMirror transaction's
  `update.changes` *is* a ChangeSet.
- **A maintained text-OT library exists and was verified** (see the ChangeSet
  findings below) — the "mature options are unmaintained or heavyweight" objection
  no longer holds for the text core. What we own is the thin file-map layer above
  it, which any representation needs.
- **The Yjs-specific surface Parts 1–2 built is large**: roughly 2,400–2,800 backend
  LOC (incl. tests) + ~1,200 frontend LOC exist specifically to make "CRDT on top of
  git" coherent — the seed clientID band and its lifetime enforcement, in-band author
  rejection at two ingestion points, per-pin seed hashes in three places, golden-byte
  tests on both sides, epoch doc reconstruction, `applyTextEdit`'s anchor-preserving
  minimal diffs, and ~700 LOC of agent session-doc capture/replay machinery. Under
  OT, most of this is not migrated but deleted: an OT change is already "a change
  relative to commit X", so there is no seeding problem to solve.
- **Changes are transparent where Yjs updates were opaque.** The server can see exactly
  which files a change touches and validate lengths and boundaries at the trust
  boundary — the generation token's subtlest rationale ("the server cannot tell
  which gadget an opaque update touches") evaporates, and the parked-pending-structs
  class of silent-loss races becomes an explicit, checkable rejection.

## Locked decisions

- **Text OT core: `@codemirror/state`'s `ChangeSet`/`Text` (plus `fast-diff` for
  change generation)**, with `workshop-shared/src/code-change.ts` as the **single
  owner of the invariants**: validation, the file-map lifting, and the priority
  convention live there and nowhere else (the same reason git-store.ts privatizes
  isomorphic-git — invariant ownership, *not* a swappability shim). The wire
  carries our own doc-commented plain-text change types (structurally ChangeSet's
  compact JSON form, so conversion is `ChangeSet.fromJSON`/`toJSON`), keeping the
  RPC contract self-describing; on the backend nothing outside code-change.ts imports
  the library, while the **frontend uses `ChangeSet` objects natively** (its editor
  is CodeMirror — see below), serializing only at the RPC boundary. (quill-delta
  5.1 was evaluated first and passed the same fuzz battery, but lost on every other
  axis — see the findings below.)
- **The editor moves from Monaco to CodeMirror 6, in this change.** No Monaco
  adapter is ever written; `monaco-editor`, `@monaco-editor/react`, `y-monaco`, the
  y-monaco vite alias, and the **jsdelivr runtime dependency** (Monaco 0.55.1 is
  CDN-loaded at first mount today, version-skewed against a bundled 0.56 ESM core
  that exists only for y-monaco) are all removed — the CDN removal is a standalone
  win for self-hosted deployments. Deferring would mean building the adapter and
  re-wiring the editable diff side against Monaco, then deleting both and re-QAing
  the same three surfaces when the editor moved later.
- **`@codemirror/collab` is deliberately not used**, editor choice notwithstanding:
  it is a per-document client state machine, not a wire protocol, and its per-doc
  version model doesn't fit a per-chat revision stream whose changes span files no
  editor has open (`set`/`remove`, agent multi-file edits, pins/generation have no
  collab counterpart). We keep the chat-level two-buffer client; the editor
  integrates via annotated transactions, with CM history configured to skip remote
  changes (a supported, standard setup).
- **Client-server OT (Jupiter model), TP1 only.** The Overseer DO is the single
  authoritative sequencer; there is no peer-to-peer path and no need for TP2.
  Priority convention, fixed in code-change.ts and used identically on both sides: the
  change the server ordered *earlier* comes first (its inserts precede at ties). This is
  exactly ChangeSet's documented law — `A.compose(B.map(A))` ==
  `B.compose(A.map(B, true))` — so for concurrent a (server-applied first) and b:
  the server applies `b' = b.map(a)`; a client holding pending b that receives a
  applies `a' = a.map(b, true)` and rebases its pending to `b'`. Convergence of
  exactly this pairing is fuzz-verified (below) and the harness ports into the
  code-change test suite.
- **One revisioned change stream per chat epoch** replaces all three of today's tiers:
  human drafts (`chatDraftUpdates`), agent streaming (`codeUpdate`/`codeReset`
  stream events), and the Yjs payload of `"changes"` messages. Every accepted change —
  human keystroke batch, agent tool edit, update-from-mainline merge — gets a
  revision and is broadcast on one subscriber event. Agent edits become durable on
  apply (see the agent section for the crash/abort consequences).
- **Legacy (pre-git) chats convert at migration** — no graduation period, no
  `legacy: true` mode, no `getLegacyChatDocBase`, no dual doc bases. The migration
  flattens each live legacy chat's doc once and records its uncommitted state as a
  plain diff against its pinned commit; all pre-conversion `readFile` results are
  elided on replay (unconditionally — the honest cost is that an agent mid-turn
  across the migration re-reads files once). After the migration, `yjs` remains a
  dependency only of `git-migration.ts` (which reads the legacy log) and its tests;
  the frontend and workshop-shared drop `yjs`/`y-monaco`/`y-protocols` entirely.
- **Multi-human convergence is preserved** via the same transform path — no special
  architecture, just the transform matrix tested.
- Everything git-shaped from Parts 1–2 survives unchanged: `git-store.ts`,
  commit-backed records, the fast-forward accept gate, `threeWayMerge`, epochs,
  generation invalidation, lazy pin policy, the empty-tree head-commit invariant,
  agent unpinned-read elision, and the migration's commit synthesis.

## ChangeSet findings that shape the design

Verified against `@codemirror/state` 6.7 (MIT; actively maintained CodeMirror 6
core; one tiny dependency, `@marijn/find-cluster-break`; real ESM with an `exports`
map + dual CJS, `sideEffects: false`; ~16KB gzipped tree-shaken to ChangeSet+Text —
against the ~80KB+ of yjs it displaces; type-checks under this repo's tsgo with
`moduleResolution: "bundler"`):

- **It is the substrate of `@codemirror/collab`** — production OT with a central
  authority, i.e. precisely the DO-as-sequencer model — and the OT law is documented
  right on `map()`: *"`A.compose(B.map(A))` and `B.compose(A.map(B, true))` will
  produce the same document."*
- **Changes are base-free.** A ChangeSet serializes to compact JSON — sections of
  retained lengths and `[deletedLen, ...insertedLines]` (e.g. `[2,[2,"😀","x"],2]`)
  — with no base content; `map` (transform) is change-vs-change and needs no document.
  Applying needs the base transiently as a `Text` (`Text.of(str.split('\n'))`, a
  rope; `toString()` round-trips `\r`, `\r\n`, `\u2028`, and NUL losslessly —
  verified, matching `splitLines`' invariants in git-store). Base content never
  enters storage, the wire, or the change history: chat state is literally
  `(baseCommit, composedChange)`.
- **Exact-length invariants are built in — the trust boundary mostly comes free.**
  Every ChangeSet carries both the before-length (`length`) and after-length
  (`newLength`); `ChangeSet.of` **rejects out-of-range changes at construction**,
  `apply` **throws on a wrong-length document**, and `fromJSON` **rejects malformed
  input**. Our ingestion validator shrinks to surrogate-boundary checks and size
  caps.
- **Fuzz-verified where it matters**: 20k random concurrent-change pairs (including
  astral chars) converge under the documented pairing, in both the composed and the
  stepwise (apply-one-then-map-the-other) forms; 5k compose-vs-apply cases agree.
- **Composition compacts** (measured): 1,500 keystroke-grained changes — type 1,000
  chars, backspace 500 — compose from ~17.4KB of individual JSON rows to a single
  508-byte section; N edits at distinct scattered positions keep N sections, the
  minimal representation. Composed size is bounded by changed-region extent, not
  edit count — the property materialization (§2) and checkpoint `proposedChange`
  bounds rely on.
- **Diff is the one piece it lacks** (quill-delta bundles one; ChangeSet doesn't):
  we depend on `fast-diff` 1.3 directly — one file, zero deps, the Myers-diff port
  quill-delta itself uses. A ~12-line fold turns its output into `ChangeSet.of`
  specs; fuzz-verified over 20k astral-heavy string pairs, correct and **never
  splitting surrogate pairs** (every change boundary checked against the base's
  code-point boundaries).
- **The residual hazard is surrogate boundaries in hostile changes**: ChangeSet accepts
  a mid-pair boundary (a delete of just a high surrogate yields a lone surrogate,
  which becomes U+FFFD over a UTF-8 wire — the corruption class the Yjs design
  guarded against in `applyTextEdit`). The ingestion check (change boundaries on
  code-point boundaries of the base, inserts free of lone surrogates) is ~15 lines —
  and unlike with opaque Yjs updates it is actually possible, because the server
  holds the base.
- **Why not quill-delta** (5.1.0, evaluated first; passed the same convergence/diff
  fuzz): its rich-text surface is baggage — the `Op` type admits embed objects and
  `attributes`, it **silently accepts over-long retains/deletes** (no length
  invariants anywhere), so schema *and* bounds validation would be ours; it is
  CJS-only with no `exports` map and drags in two lodash point packages. ChangeSet
  is plain-text native, stricter, better packaged, and closer to our architecture;
  the incidental fits are better too (change specs are `{from, to, insert}` in
  original coordinates — the same shape as Monaco's `contentChange` events and
  `editFile`'s known replacement span, no retain arithmetic at the producers; and
  `ChangeDesc` is a free compact form for changed-region bookkeeping).

## Monaco findings that motivate the editor swap

Surveyed against the actual usage in workshop-frontend (Monaco appears nowhere else
in the repo):

- **The TypeScript language service is completely unconfigured** — no
  `typescriptDefaults`/`javascriptDefaults`, no `addExtraLib` (no gadget-API types
  injected), no compiler options, no markers, no custom providers, actions, or
  keybindings anywhere. Users get only the stock worker's *generic* per-file
  hover/diagnostics; each file is a standalone model. The feared "losing
  IntelliSense" regression mostly doesn't exist — and a CM TS integration wired to
  real gadget runtime types becomes a plausible follow-up Monaco never had.
- **The diff view doesn't use Monaco's diff UI.** A *hidden offscreen*
  `createDiffEditor` (`CodeDiffEditor.tsx:156-190`) serves purely as the diff
  algorithm (`ILineChange[]` + `charChanges`); the visible UX is entirely custom —
  `diff/diffModel.ts` (476 lines of pairing/whitespace heuristics, deletion-block
  truncation) + `diff/diffRenderer.ts` (decorations, view zones with hand-built
  deletion DOM, stacked/split layouts, scroll sync). Porting means re-sourcing the
  algorithm, not losing a Monaco feature.
- **Monaco is a runtime CDN dependency**: `@monaco-editor/react` has no
  `loader.config()`, so its default lazy-loads Monaco 0.55.1 (editor + language
  workers) from jsdelivr on first mount — a hard third-party runtime dependency and
  an offline/self-hosted liability — while the bundle *also* carries the 0.56 ESM
  editor-api core solely for y-monaco, remapped by a vite alias marked temporary.
- **An in-repo CodeMirror precedent exists**: gatekeeper-context's SPA already uses
  CM6 ("Monaco doesn't run in this sandbox") with a token theme deliberately
  matched to the workshop's Monaco theme (`monacoTheme.ts`) — a ready starting
  point for theme parity.
- Every Monaco touchpoint (both `MonacoBinding` call sites, the editable diff side,
  `GadgetCodeInterface`'s doc layering) is already rewritten by this part; keeping
  Monaco would *add* work (the adapter), not save it.
- **Accepted regressions** (all stock freebies, none configured or product-specific;
  recorded here as the decision): the generic TS-worker hover/diagnostics,
  `formatOnPaste`/`formatOnType`, the built-in context menu / command palette, and
  mouse-wheel zoom. Kept via CM packages: find/replace (`@codemirror/search`),
  multi-cursor, folding, bracket matching, and the `getLanguage.ts` language set
  (~19 ids; official `@codemirror/lang-*` where available, `@codemirror/legacy-modes`
  or plaintext fallback for the tail).

## Design

### 1. Change model (`workshop-shared/src/code-change.ts`, new)

Our own doc-commented wire types; `@codemirror/state` and `fast-diff` are
module-private implementation details (mirroring how git-store.ts privatizes
isomorphic-git):

- A file's state is `string | absent`. `TextChange` is our own TS type for ChangeSet's
  compact JSON form — `(number | [number, ...string[]])[]`, sections of retained
  lengths and `[deletedLen, ...insertedLines]` — plain JSON, friendly for Cap'n Web
  (no `Uint8Array` payloads anywhere in the new protocol), and carrying exact
  before/after lengths by construction.
- `FileChange` = `{edit: TextChange}` (applies to an existing file of exactly the
  change's before-length) | `{set: string}` (create or wholesale replace — `writeFile`;
  valid against any state including absent) | `remove` (delete). An `edit` on an
  absent file is invalid.
- `CodeChange` = per-gadget, per-path map of `FileChange`s, keyed by gadget id (the Yjs
  `filesRoot` naming layer disappears; changes address gadgets directly).
- Operations: `applyCodeChange(files, change)`, `composeCodeChange(a, b)`,
  `transformCodeChange(a, b)` (a = the earlier/priority side), `diffFiles(before,
  after) → CodeChange` (fast-diff output folded into `ChangeSet.of` specs),
  `changedGadgets(change)`. Transform lifting per path: edit/edit delegates to
  `ChangeSet.map` with the fixed priority pairing; `set`/`remove` are
  **last-writer-wins by server order** — transforming b over an earlier a: a's
  `set`/`remove` drops b's `edit` (its base was wholesale-replaced); b's
  `set`/`remove` survives anything. One rule, doc-commented, covering
  delete-vs-edit and create-vs-create.
- **Two-stage ingestion validation** (the trust boundary):
  1. **Schema, before transform**: `ChangeSet.fromJSON` (rejects malformed input
     outright), plus per-file and per-change size caps. Malformed changes must never
     reach transform.
  2. **Content, after transform against the current file**: exact length match
     (`change.length === file.length` — ChangeSet carries it, and `apply` throws on
     mismatch as a backstop), and every change boundary lands on a code-point
     boundary of the base with inserts free of lone surrogates (no surrogate-pair
     splits — the server holds the base, ~15 lines; the one check the library
     doesn't provide).
- Tests: port the fuzz harnesses (transform convergence under the documented
  pairing in both composed and stepwise forms, compose-vs-apply, astral-heavy
  diff-to-ChangeSet boundary checks, `Text` line-separator round-trips) plus the
  validation matrix (malformed JSON, out-of-range changes, wrong-length bases,
  mid-pair boundaries, edit-on-absent, set/remove LWW cases). These run in the
  workshop-backend workerd suite like the git-store tests.

### 2. Revision protocol — one change stream per epoch

- `ChatCodeBase` becomes `{pins: ChatGadgetPinState[], generation, epoch?, revision,
  prior?}`, where `prior: {generation, finalRevision, discontinuousGadgets}` is
  present after a **content-preserving** bump: it names the closed generation and
  its terminal revision — the marker by which a client knows it has processed the
  old generation's tail to completion before switching (§7) — plus the (usually
  empty) list of **bridge-ineligible gadgets** from the boundary map, whose
  content the reset visibly changed and which the client must rebuild from head
  rather than carry over (§7). Absent after destructive bumps, whose tail is not
  processable anyway.
  `ChatGadgetPinState` = `{gadgetId, baseCommit, mergedCommit}`: `baseCommit` replaces
  `seedCommit` (immutable within the epoch — it is what changes compose on top of) and
  needs **no hash**: `readCommitFiles(baseCommit)` is deterministic by construction,
  which is the point of the whole exercise. `mergedCommit` and the fast-forward gate
  are unchanged from Part 2. `seedHash`, the seed band, and both in-band-author
  rejection chokepoints are deleted. Absent `codeBase` still reads as
  `{pins: [], generation: 0, revision: 0}`. The immutable half is its own type,
  `ChatGadgetPin` = `{gadgetId, baseCommit}` — what a submit declares and what the log
  and checkpoints record — with `ChatGadgetPinState` extending it by the one field that
  is live state rather than history.
- **`chatChanges` collection replaces `chatDraftUpdates`**: rows
  `{revision, author, timestamp, change, submission?, source}` under a
  **per-generation** revision counter (see the generation bullet). `source`
  attributes the row to its producer — `user`, `agent` (with the turn's sequence),
  or `mainlineMerge` — which is what lets turn flush select its segment and turn
  abort select its rows (§4); `submission = {clientId, seq}` identifies the
  submission that produced a user row (the idempotency scheme below; absent on
  server-authored rows). Three producers: `submitCodeChange` (human editors), agent
  tool edits (durable on apply), and update-from-mainline's merge change. Every
  accepted row is broadcast as one subscriber event —
  `changeApplied(chatId, generation, revision, author, change, submission?)`, with
  `submission = {clientId, seq}` on user rows (one grouped optional, so
  half-present states are unrepresentable) — which
  **also replaces the `codeUpdate`/`codeReset` stream events**: agent streaming
  preview is just the same feed, and the submission echo lets a submitter
  recognize its own rows (live and in subscribe-replay) without depending on
  ack/broadcast ordering. Events are tagged with the generation because
  revisions restart per generation; a client processes its current generation's
  events to completion before acting on a generation switch (see §7 — dropping an
  old generation's tail would strand its pending buffer). On subscribe, retained
  rows are replayed like drafts are today; clients apply rows in revision order and
  treat a gap as "refetch".
- **`submitCodeChange(chatId, {generation, revision, clientId, seq, pins?, change}) →
  {generation, revision}`** replaces `updateCode` (the ack names the landing spot,
  which under the straggler bridge below can be a *newer* generation than the
  submit's). `pins` is an **array** — one declaration per newly-pinned gadget the
  change covers, since a `CodeChange` spans gadgets and a pending buffer composed while
  disconnected can first-touch several unpinned gadgets at once. A declaration
  identical to an existing pin is **idempotent-accept**; only a genuinely different
  `baseCommit` is a conflict. Idempotency is **per client session**: `clientId` is
  a client-minted token (fresh on every local rebuild; concurrent tabs are
  distinct clients) and `seq` numbers its submissions from 1. The server keeps
  **one record per client session, scoped to the authenticated user** — the last
  accepted `seq`, its landing `(generation, revision)`, and a digest of the
  submission, updated in place at accept — rather than a token per
  change: per-change tokens would grow dedupe state with row count (and on local workerd
  deployments RTT is near zero, so rows genuinely approach one per keystroke),
  while per-client records are O(client sessions) and live outside the rows, so
  recognition survives materialization, epoch resets, and destructive bumps with
  no extra bookkeeping. The user scoping is load-bearing: clientIds are public
  (they ride the `changeApplied` echo), so unscoped records would let one
  collaborator consume another's next `seq` — the victim's own next submit would
  then match the record and be acked with the interloper's landing spot,
  silently stranding an unapplied change. A submit whose `seq` equals the record is a
  **retry of an already-accepted change** — the server verifies the digest (a
  same-seq submit with different content is a client bug, rejected loudly rather
  than acknowledged unapplied) and returns the recorded landing spot without
  re-applying (an RPC response lost after acceptance would otherwise double-apply
  the edit on retry, which OT, unlike a CRDT, does not tolerate); `seq` one past
  the record (or 1 from a session the user has never used) is the next change;
  anything else is a protocol violation → throw, client discards and rebuilds
  under a fresh `clientId`. Only the last change's landing is remembered, so at most
  one submission may be in flight per client — which the seq rule *enforces*
  rather than assumes (and is exactly the two-buffer client's behavior, §7).
  Records are never pruned — they are tiny, one per session that ever submitted,
  the same growth class as the chat log itself, and are deleted with the chat —
  because expiry would reopen the double-apply hole: an unknown session's
  `seq: 1` is accepted as a fresh first change, so a sufficiently delayed retry of a
  pruned session's first change would masquerade as one. Server, in order:
  schema-validate; **dedupe by `(clientId, seq)` before anything that can reject
  the base** — regardless of the claimed `(generation, revision)`, because an
  already-accepted retry must get its recorded landing spot back even when its
  base has since been destructively bumped (recognition must never require the
  base to remain transformable), and dedupe before the
  turn check also means a retry of a change accepted just before a turn started gets
  its ack rather than a bounce; resolve the claimed `(generation, revision)` —
  current generation → proceed; previous generation ended by a
  **content-preserving boundary** with the base still in the retired buffer → the
  straggler bridge below; anything else (destructive bump, or past the buffer
  horizon) → throw, client discards and rebuilds; **reject while an agent turn is
  active** (retryable error; the UI already locks editing during turns, so this
  only backstops races — the client keeps its queue and resubmits after the
  turn); validate/establish each pin exactly as in Part 2 (first edit to an
  unpinned gadget declares `baseCommit`, validated tip-or-parent); transform the
  change over rows since the claimed `revision`; content-validate the transformed change
  against current content; apply, append, broadcast. All in one synchronous step
  with the row write (atomic under the output gate) — the git reads for pin
  validation happen before it, as today.
- **The straggler bridge: merges almost never discard keystrokes.** An accept is
  content-preserving **per gadget**, and the bridge is gated per gadget on
  exactly that property. For a gadget the merge committed, the new head *is* the
  flatten, so the cross-generation step is the *identity map* (a payoff Yjs could
  never offer, where post-merge edits needed a new seed that old updates could
  not be transformed onto; per-file exact-length checks pass by construction).
  But a **pinned gadget with no net change** gets no commit and no stale gate: its
  pin simply evaporates, which is content-preserving only if its **flattened
  content equals head's content at reset**. That comparison is against
  `mergedCommit`/the flatten, **never the immutable `baseCommit`**: after
  `updateChatFromMainline`, `baseCommit` is old while the flatten and
  `mergedCommit` can equal head, and identity bridging is then perfectly valid —
  whereas a pin whose `mergedCommit` fell behind head jumps visibly from pin
  content to head content at reset, and no identity map exists. The accept
  therefore records a **boundary map** alongside the retired rows: per gadget,
  its **boundary commit** (the merge's commit, or head-at-reset for an
  evaporated pin whose flatten equals its content) or a **bridge-ineligible**
  marker (pin evaporated with content differing from head). A bridged change is
  transformed over the old generation's remaining retired rows to the old tip, then
  over the new generation's rows, then applied normally — **rejected** (discard path)
  if it touches a bridge-ineligible gadget, or a gadget whose **new-generation pin sits
  at a different base** than its boundary commit (a new-epoch edit pinned at a
  since-moved head C2: carrying a C-based change onto C2-based content needs the
  C→C2 tree diff — a cross-base merge, which is update-from-mainline's job, not
  transform's). Pin handling otherwise: client declarations on bridged changes are
  **ignored and server-derived** (they describe a world that no longer exists) —
  each touched gadget pins at its boundary commit (idempotent against an existing
  identical pin; boundary commits cover promoted in-chat creations via the merge
  message's `commits`); if mainline has since moved, the boundary commit is a
  parent of tip, landing in the existing tip-or-parent grace and leaving the chat
  ordinarily stale. Gadgets unpinned on *both* sides of the boundary follow the
  normal first-touch rule (the client's own declaration, tip-or-parent
  validated). One previous generation is bridged; older stragglers are
  RTT-scale-impossible and fall back to the discard path.
- **Retired rows, not deleted rows.** Pruning — at materialization and at the
  merge's epoch reset — moves rows into a bounded **grace buffer** (tagged with
  their generation and the boundary kind) instead of deleting them. Retired rows
  are excluded from the fold, from replay, and from subscribe-replay: they are a
  pure transform cache for the straggler bridge and late in-window submits, expired
  lazily by age (a ~60s horizon is generous — stragglers are in-flight-RTT scale).
  This **subsumes the window-expiry rejection**: a submit based inside a
  materialized range transforms over the retired rows instead of being rejected;
  rejection remains only for destructive bumps, the buffer horizon, and invalid
  changes. Destructive boundaries (revert, draft discard, turn abort) retire no
  *rows* — their content basis was erased, transformation across them is
  meaningless, and their discard UX is *intended* semantics — and they need no
  dedupe bookkeeping either: the per-client last-change records live outside the rows,
  so a retry of a change that was accepted (then erased like any other applied change)
  is still recognized and acked with its recorded landing spot.
- **Materialization** (`materializeChatDraft`'s successor) composes a row range into
  a `"changes"` message — `change: CodeChange` replaces `update: Uint8Array`, plus the
  existing `pins` (minus seedHash) and a **generation-qualified watermark**
  `{changesGeneration, throughRevision}` (revisions are per-generation, so an
  unqualified watermark in a delayed message could clear rows of the wrong
  generation) — and retires the rows.
  Composition genuinely compacts: a `ChangeSet` composition is bounded by the
  extent of changed regions, not edit count (measured: 1,500 keystroke-grained changes
  — type 1,000 chars, backspace 500 — compose to a single 508-byte section; changes
  scattered across N distinct positions keep N sections, the minimal
  representation), so a changes message is never per-keystroke JSON. The delivered
  message itself signals materialization (clients drop local knowledge of *that
  generation's* rows ≤ `throughRevision`); `draftCleared` is deleted. Triggers: agent turn start,
  accept, and — new — a **window-size/age threshold**, so a long human-only
  editing session can't grow the live window (and its subscribe-replay cost)
  without bound; this is the OT successor of `compactChatDraftUpdates`, and thanks
  to the grace buffer it stales nobody.
- **Generation** survives with bump sites unchanged (merge, revert,
  `discardChatDraftChanges`' successor) but its bumps now come in the two classes
  above: **content-preserving** (merge — the stream identity changes, the content
  doesn't, and the straggler bridge carries late changes across) and **destructive**
  (revert, draft discard, turn abort — already-applied changes are erased, content
  that other clients may have transformed against is gone, so their local state is
  unrebuildable-by-patching and they must discard and rebuild). Pin additions and
  update-from-mainline still don't bump (they only append). **The revision counter
  is scoped to the generation** (every generation starts a fresh sequence over the
  folded content), not to the epoch: a revert or turn abort erases rows without
  opening an epoch, and reusing revision numbers within a live identifier would
  let a delayed event or retry be misattributed. `(generation, revision)`
  identifies a point in the stream; `epoch` remains what keys log reconstruction.

### 3. Server content, accept, update-from-mainline, revert

- `buildChatDoc` → **`buildChatContent(through)`**: the same epoch-aware log fold
  (epoch-boundary merge → reset; changes message → establish its pins' bases via
  `readCommitFiles`, apply its change; then trailing unmaterialized rows in revision
  order), producing plain `Map<gadgetId, Map<path, string>>`. Commits are immutable,
  so reconstruction of closed epochs is deterministic — from log pins alone, with no
  hash needed. The DO caches the current-epoch content map, invalidated by
  generation. `derivePinSeed`, seed application, and all Y.Doc construction are
  deleted.
- **Accept** (`mergeChanges(chatId)`, signature unchanged from Part 2): the flatten
  *is* the content map. Fast-forward gate, `writeFilesAsCommit`, head advancement,
  provisional promotion, epoch reset (retiring `chatChanges` rows into the grace
  buffer alongside the per-gadget **boundary map** the bridge gates on — §2 — and
  restarting `revision`), generation bump (content-preserving class — the
  straggler bridge applies), `epochBoundary` merge message with server-computed
  `mergeThrough` — otherwise as in Part 2. The mid-accept backstop is unchanged in
  spirit and **not** superseded by the bridge: rows that landed during the accept's
  awaits are already-*accepted* content the flatten didn't cover, so the accept's
  synchronous tail still gives up with a retryable throw (someone is actively
  typing) rather than silently sweeping or dropping them; the bridge only carries
  changes that arrive *after* the merge committed.
- **Update-from-mainline**: `threeWayMerge` with the pin's `mergedCommit` as
  explicit ancestor, unchanged. The delivery mechanism simplifies: the merge result
  becomes `diffFiles(currentChatContent, mergedContent)` applied as a server change row
  at the current revision and broadcast — concurrent typists transform against it
  like any other remote change. Correctness no longer hangs on minimal diffs
  (`applyTextEdit`'s CRDT-anchor rationale is gone); fast-diff's character-level
  minimality is a quality bonus for concurrent-editor transforms. `mergedCommit`
  advancement, `conflictPaths` surfacing, the record-even-if-empty rule, and the
  still-proposed-mainlineMerge revert restriction are all unchanged.
- **Revert**: same policy as Part 2 — pin survival = declaring message survival,
  unlogged pins die with their drafts (now: with their unmaterialized rows), rows at
  or after the reverted point are erased, generation bumps. The rationale is now
  uniform: erasing applied changes invalidates every client's local state, hence the
  bump. One new restriction: **a revert may not start before a conversion
  boundary** (rejected with a clear error). The conversion message collapses all
  surviving legacy edits into one change, so a `revertFrom` before it would mark that
  message reverted and take pre-`revertFrom` legacy edits with it. Reverting *at*
  the boundary (discarding all converted uncommitted changes together) or after it
  works normally. Accepted deliberately: reverts are rare and near-immediate in
  practice, and the product is in early beta — a temporary limitation around
  migration time beats per-batch conversion or history rewriting.

### 4. Agent path

The session Y.Doc apparatus collapses; the *policy* (lazy pins, elision,
read-before-edit gates) is untouched:

- The agent holds the chat content map (from `buildChatContent` + its own edits).
  `writeFile` emits `{set}`; `editFile` emits an **exact** edit — it knows the
  replaced span, so the change is `ChangeSet.of([{from, to, insert}], fileLength)` with
  no diffing. Each tool edit is applied to the content map, written as a durable
  `chatChanges` row, and broadcast — replacing `capturedYdocChanges`, the `seedOrigin`
  transaction-origin trick, the `updateV2` capture listeners, and the streaming
  events. Pin establishment on first write to an unpinned gadget is unchanged in
  policy (always at current head, never at an observed commit), but **validation
  moves to row-append time**: the pin is validated and mirrored into `codeBase` in
  the same synchronous step that makes the edit durable. Part 2's `addChatMessages`
  re-validation at materialization is deleted — it existed because edits only
  became durable at flush; now that the edit and pin are already accepted, stored,
  and broadcast, head movement after the append must merely make the chat *stale*
  (caught by accept's fast-forward gate), not retroactively fail the turn at flush.
- **Turn flush** = materialization of the turn segment's rows into the `"changes"`
  message (with `pins`, `createdGadgets`, `addedBindings` as today). The segment is
  selected by the rows' `source` turn identity and is contiguous by construction:
  human `submitCodeChange` is rejected while a turn is active (§2), and
  update-from-mainline already aborts when a turn has started (its next-sequence
  re-check), so no foreign rows interleave with a turn's.
- **Crash/abort semantics change** (deliberately): agent rows are durable and
  broadcast immediately, so a crashed turn's edits are already part of chat content
  — replay applies messages' changes plus trailing unmaterialized rows and continues;
  `pendingReplayEdits`/`applyPendingEditToYdoc` reconstruction is deleted. An
  *aborted* turn that must discard its edits removes its unmaterialized rows —
  selected by turn identity, and a **contiguous tail** thanks to the mid-turn
  submission rejection (erasing mid-stream rows would require inverting the changes
  later rows transformed against) — which is a revert-shaped operation: generation
  bump, clients rebuild. (Rare; strictly better than today's silent divergence
  risk.)
- **Replay** simplifies: `observeUserChanges` diffs read **directly from the change**
  (changed paths and contents are visible — the `observeDeep` rolling-snapshot
  machinery is deleted); `readFile` recomputation at past points uses
  `buildChatContent(through)` for pinned roots and `readCommitFiles(observedCommit)`
  for unpinned reads, with the Part 2 elision matrix unchanged.
  `resetSessionEpoch` keeps its role (clear content, pins, `filesRead` at replayed
  epoch boundaries) with no doc to destroy.
- **Compaction checkpoints** record pins (new shape, no seedHash) + epoch + a single
  composed `proposedChange` — bounded by content size, not edit history, which is the
  compaction win the Part 1 OT section predicted. `acceptedChanges` is deleted
  outright (epochs made it legacy-only; conversion removes legacy), as is the
  checkpoint `observedCodeVersion` legacy discriminator. `foldProposedChanges` /
  `chatChangeStatuses` keep their exact shape with `composeCodeChange` replacing
  `Y.mergeUpdatesV2`.

### 5. Migration — conversion of live legacy chats

Extends the Part 1–2 migration (commit-point synthesis, gap batching, `commits`
backfill, blueprint `commitId`s, version-0 empty-tree roots: all unchanged). New,
per live legacy chat, after commit synthesis in the same `blockConcurrencyWhile`:

1. Build the chat's legacy doc — `buildYDoc` at `legacyChatBaseVersion` +
   non-reverted proposed updates **+ outstanding drafts folded in** (so no
   keystrokes are lost) — and flatten it. Delete the draft rows.
2. Write pins only for gadgets the chat actually touched (flattened content differs
   from the anchor commit's tree): `{baseCommit: anchorCommit, mergedCommit:
   anchorCommit}`. Untouched gadgets get **no pin** — they track head live, which is
   the Part 2 lazy semantics and strictly better than the legacy eager view.
3. Record one synthetic `"changes"` message **for every migrated live chat**:
   `change = diffFiles(anchorTrees, flattened)`, carrying the pins, flagged
   **`conversionBoundary`** — with an **empty change and no pins** when the chat has
   nothing to convert, because the boundary itself is load-bearing even then:
   `epoch` points at its sequence, and replay's elision keys on it for chats
   whose agent *read* files without ever editing (those reads were computed
   against the legacy doc and are as unrecoverable as any others). For replay the
   flag acts like an epoch boundary that re-seeds at (pin bases + this change):
   messages before it replay as text only — no doc application, **all
   pre-conversion `readFile` results elided** (the existing elision note;
   excluded from `filesRead`, so `editFile`'s gate forces re-reads) and
   pre-conversion user-change diffs replaced with a generic "code was edited"
   note. Reverts may not start before this message (see the revert bullet in §3):
   the conversion change is all-or-nothing, so partial legacy reverts are impossible
   by construction.
4. `codeBase = {pins, generation: 0, epoch: <conversion sequence>, revision: 0}`
   — uniformly, since every migrated chat now has a conversion sequence. No
   `legacy` flag exists anymore.

Deleted with the legacy mode: `getLegacyChatDocBase`, the `legacy` codeBase flag,
legacy graduation, `buildYDoc`/`replayUpdates` as live paths (they move into
git-migration.ts, the only remaining reader of the `code`/`snapshots` collections —
which stay as dead stored data for one release as rollback insurance).
`legacyChatBaseVersion` becomes migration-internal. Old stored messages keep their
`update` bytes and `observedCodeVersion` stamps on disk, but delivery strips
`update` (nothing can apply it; the conversion boundary supersedes) and doc-marks
the stamp fields as pre-conversion historical data.

Migration tests to add: conversion determinism (same log → same conversion change), a
mid-agent-turn legacy chat (replay after conversion elides pre-conversion reads and
the resumed turn re-reads), drafts folded into the conversion change, an untouched
gadget left unpinned, a read-only chat (no code involvement: empty-change boundary
message written, pre-conversion reads still elided, `hasProposedChanges` stays
false), and the Part 2 suite re-based onto the new pin shape.

### 6. Wire/API deltas (`workshop-shared/src/api.ts`)

- `CodeChange`/`FileChange`/`TextChange` defined in code-change.ts and referenced by
  api.ts (like `CommitInfo` in git-store) — one definition, doc-commented, plain
  JSON.
- `submitCodeChange(chatId, {generation, revision, clientId, seq, pins?, change}) →
  {generation, revision}` replaces `updateCode`; the doc contract describes the
  two-stage validation, the `clientId`/`seq` idempotency semantics (user-scoped
  per-session last-change records with a request digest: duplicate seq + identical
  payload → the recorded landing spot returned, no re-apply; same seq with
  different content → rejected loudly; records never pruned; one submission in
  flight per client, enforced by the seq rule), the straggler bridge (a
  previous-generation base ended by a merge is transformed across, and the ack's
  generation names where it landed), the active-turn rejection (retryable), and
  the discard-on-throw client obligation for destructive bumps, horizon expiry,
  and seq violations.
- `AiChatSubscriber`: `changeApplied(chatId, generation, revision, author, change,
  submission?)` replaces `draftUpdate` and `draftCleared`; the
  `codeUpdate`/`codeReset` stream event variants are deleted from
  `AiChatStreamEvent`. The generation tag is what lets a client discard delayed
  events from a superseded stream (revisions restart per generation); the
  `submission` echo (`{clientId, seq}`, user rows only) is what lets a submitter
  recognize its own rows.
- `"changes"` message: `change?: CodeChange` + the generation-qualified
  `{changesGeneration, throughRevision}` watermark replace `update?: Uint8Array`;
  `pins` lose `seedHash`; `mainlineMerge` unchanged; `conversionBoundary?: true`
  added; `observedCodeVersion` doc-marked historical.
- `ChatCodeBase`/`ChatGadgetPinState` reshaped as in §2 (including `prior` — the
  closed generation's terminal-revision marker plus its bridge-ineligible
  `discontinuousGadgets`); `seedHash` and `legacy` gone.
- `getLegacyChatDocBase` deleted. Checkpoint/history-page `acceptedChanges` and
  `proposedChanges` replaced by one composed `proposedChange?: CodeChange`.
- Unchanged: `getCodeAtCommit`, `getCommitLog`, `CommitInfo`/`CommitIdentity`,
  `WorkpieceSummary.commitId`, `merge.commits`/`epochBoundary`/`mergeThrough`,
  `MergeChangesResult`. `WorkpieceSummary.filesRoot` (the Y.Doc root name) is
  deleted along with the root-naming layer.
- Kernel review bar as always: doc-comment every touched export, no mirrors,
  minimal diffs.

### 7. Frontend

- **OT client state machine** (one small module, shared by editor and diff views):
  the classic two-buffer client — one in-flight change awaiting its
  `submitCodeChange` ack, one pending composition of newer local edits; incoming
  `changeApplied` rows transform
  over both (priority pairing from code-change.ts) and rebase them; ack advances the
  known `(generation, revision)`. Because the pending buffer *composes*, rows land
  at ~RTT granularity (everything typed since the last ack rides one submit), not
  per keystroke — the same batching `updateCode` does today — so the live window
  grows slowly even before threshold materialization (though on local workerd
  deployments RTT is near zero and rows can genuinely be per-keystroke — the
  reason dedupe state is per client, not per change). The client mints a session
  `clientId` whenever it builds or rebuilds local state and numbers submits with
  `seq`; a transport failure **retries the same `seq`** (never a re-composed change —
  the server dedupes it); a *retryable* rejection (active agent turn) keeps
  the queue and resubmits after the turn; a hard rejection (destructive generation
  bump, pin race, buffer-horizon expiry, seq violation) discards local state with
  the existing toast and rebuilds under a fresh `clientId`. **A merge is not a discard**: on a content-preserving
  generation switch the client first processes the old generation's remaining
  `changeApplied` tail — complete when it reaches `codeBase.prior.finalRevision`;
  dropping the tail would strand the pending buffer against missed edits — then
  re-bases locally and keeps submitting. Content is byte-identical for every
  gadget *except* those in `prior.discontinuousGadgets`: those it rebuilds from
  head and **drops pending changes touching them** (the server would reject them as
  bridge-ineligible anyway — dropping proactively spares the whole queue from the
  rejection path); for the rest this is bookkeeping, not a rebuild; in-flight and
  queued changes ride the server's straggler bridge, whose acks name their
  new-generation landing spots. In the common case (the typist's own keystrokes are
  the only in-flight thing), typing straight through someone's accept is seamless.
  ~250 LOC replacing the four-Y.Doc construction in `GadgetCodeInterface.tsx`. It
  holds `ChangeSet` objects natively (serialization only at the RPC boundary) and owns
  content for *all* files in the chat, including files no editor has open — which is
  why it is not `@codemirror/collab` (see the locked decision).
- **Editor: CodeMirror 6** replacing Monaco in `CodeEditor.tsx`. The integration is
  direct rather than an adapter: local transactions' `update.changes` (filtered by
  a remote-change annotation) feed the client; remote changes dispatch as annotated
  transactions with `addToHistory: false`, so undo is CM-native and skips remote
  changes. Extensions: per-language packages for the `getLanguage.ts` set,
  `@codemirror/search`, folding, multi-cursor (default), the option parity list
  from `CodeEditor.tsx:85-130` (word wrap, no minimap equivalent needed, tab size,
  custom scrollbars via theme); theme ported starting from gatekeeper-context's
  Monaco-matched CM theme. Preserve the "editor stays mounted while the file is
  transiently absent" behavior (`CodeEditor.tsx:25-27`). `monaco-editor`,
  `@monaco-editor/react`, `y-monaco`, the vite alias, `yjs`, and `y-protocols` are
  all removed from package.json; the jsdelivr runtime load disappears with them.
- **Diff view: rebuilt on CM6, preserving the current UX exactly** (stacked +
  split layouts, deletion zones with expand buttons, char-level highlights, scroll
  sync, width gating, the `localStorage` layout preference, the `-N +N` pill). The
  offscreen-Monaco diff *algorithm* is replaced by `@codemirror/merge`'s exported
  char-precise diff; `diff/diffModel.ts`'s heuristics (replacement-vs-unrelated
  splitting, trim-whitespace compensation, truncation/expansion limits) are ported
  off Monaco's `ILineChange` conventions onto it; `diff/diffRenderer.ts`'s
  decorations + view zones become CM line/mark decorations + block widgets + gutter
  extensions (the deletion blocks' own line-number margin needs gutter work); the
  `.monaco-editor`-targeting CSS is rewritten. The modified side stays editable and
  OT-bound through the same client.
- Content layering: head view via `getCodeAtCommit` (unchanged, oid-cached); chat
  view = pin bases (same cache — a pin's base content is just `getCodeAtCommit
  (baseCommit)`) + composed epoch changes from history + live `changeApplied` feed. The
  **first-keystroke pin flow simplifies**: the client is already displaying head
  content, so "derive the seed locally" becomes "keep the text you have and declare
  `pins: [{gadgetId, baseCommit: head}]` on the first submit" (one entry per
  newly-touched unpinned gadget) — no derivation, no hash check. `chatCodeDoc.ts`
  and `computeChatDocUpdates`'s blob merging are deleted.
- Streaming view = the same `changeApplied` feed (editing stays locked during agent
  turns, as today).
- Discard UX narrows to the destructive cases (revert, draft discard, turn abort,
  buffer-horizon expiry) — Part 2's toast, now rarer: merges and materializations
  no longer discard anyone's keystrokes.

## Known edge cases / watch-fors

- **Validate schema before transform, content after transform.** Transform is
  structural and must only ever see schema-valid changes; length/boundary checks are
  only meaningful against the content the change will actually apply to.
- **Lone surrogates on the wire**: Cap'n Web WebSocket text frames are UTF-8, where
  a lone surrogate becomes U+FFFD — the ingestion boundary check (change boundaries on
  code-point boundaries, inserts contain no lone surrogates) is what keeps replicas
  byte-identical, the OT successor of `applyTextEdit`'s guard.
- **`set('')` vs `remove`**: empty file and absent file are distinct states;
  `filesEqual`, accept's empty-tree handling, and the LWW rules must all agree.
- **Row retention vs reconnect**: the transform window is the retained rows plus
  the retired grace buffer; every retiring site (materialization, epoch reset)
  must keep the buffer's coverage contiguous — a submit based inside a gap has
  nothing to transform against and must hit the reject path, never a hole. The
  per-client dedupe records are deliberately decoupled from this window: they are
  never pruned (see §2 — expiry would let a delayed retry of a session's first change
  re-apply as a fresh session), and a submit that misses the protocol — an
  unknown session with `seq > 1`, a known session with anything but `record` or
  `record + 1`, or a same-seq submit whose digest differs — fails the reject path
  rather than double-applying or mis-acknowledging. Verify the checks stay
  ordered that way (dedupe first, one record lookup; the reject path as the
  fallback).
- **Bridged pins must come from the boundary map, never the client**: a bridged
  change's pin declarations describe the pre-merge world; deriving from anything but
  the recorded boundary commit — the merge's per-gadget commit, or head-at-reset
  for an evaporated content-equal pin (e.g. *current* head, which may have moved
  since) — would pin content the change wasn't transformed against. Test the
  head-moved-since-merge case (pin lands on a parent of tip) explicitly.
- **Turn abort = revert-shaped**: removing an aborted turn's rows must bump the
  generation like any other removal of applied changes. Audit every path that discards
  rows (revert, discard-drafts, abort) for the bump + unlogged-pin rollback pair —
  the Part 2 invariant, now with one uniform justification.
- **`changeApplied` vs metadata delivery races**: `(generation, revision)` makes
  ordering checkable client-side (within a generation apply in order, gap →
  refetch; on a generation switch, **finish the old generation's tail first** —
  completion is checkable against `codeBase.prior.finalRevision`, §7 — and only
  ignore events for generations the client has fully left); test the
  late-joiner-replay, mid-stream-subscribe,
  delayed-event-across-a-generation-bump, and tail-then-switch paths rather than
  assuming.
- **`hasProposedChanges` / fold scoping**: unchanged from Part 2, but re-verify the
  fold rules against the conversionBoundary flag (a conversion message *is* a
  proposed change; an epoch boundary is not — and an **empty** conversion change
  proposes nothing, so a read-only migrated chat must not show proposed changes).
- **GC roots**: log pins' `baseCommit`s root closed-epoch reconstruction (as in
  Part 2); conversion messages' pins root the synthesized anchor commits. The
  `observedCommit` elision-tolerance note stands.
- **Per-change size caps**: changes are content-bounded per file by construction
  (`set`/`edit` carry at most the file), but a composed epoch change or checkpoint
  `proposedChange` spanning many files approaches message-size limits the same way
  snapshots once did — enforce the same caps the gadget file writes already have.
- **Split diff-view alignment**: Monaco kept the two sides aligned with hatched
  blank view zones; the CM rebuild does the same with block widgets, and the manual
  bidirectional scroll sync must be re-verified against CM's own scroll model
  (rAF-coalesced recompute per keystroke, as today).
- **Editable diff side under OT**: the modified side is a second live editor on the
  same file — its local transactions and remote changes flow through the *same* client
  instance as the main editor, or the two editors diverge. One client per chat,
  many views.

## Commit sequence (Part 3)

Kernel commits first, frontend last, with a **deliberately relaxed green policy**
(Part 3's API rework is too invasive for backend-green stubs to be worth their
cost): commit 1 leaves everything green; **after commit 2 only workshop-shared is
required green** (`pnpm --filter @gadgets/workshop-shared build`) — workshop-backend
and workshop-frontend are both expected broken; **backend green again from commit
4** (commits 3+4 are verified as a pair with `pnpm --filter '!@gadgets/
workshop-frontend' build` and `pnpm --filter @gadgets/workshop-backend test:run`;
commit 3 alone need not build); frontend green from commit 5, and the full
`pnpm build` / `pnpm test` / `pnpm lint` gate applies at the end.

1. **ot-core** (workshop-shared): `@codemirror/state` + `fast-diff` dependencies;
   `code-change.ts` (wire types, apply/compose/transform/diff, two-stage validation,
   priority convention — all doc-commented, both libraries module-private); fuzz +
   validation tests in the workshop-backend workerd suite. No behavior change
   anywhere else.
2. **API** (workshop-shared): all §6 wire deltas, fully doc-commented; deletion of
   the Yjs update fields, `getLegacyChatDocBase`, and the seed-band contract
   language. No backend keep-compiling stubs (see the green policy above).
3. **Backend** (workshop-backend): `chatChanges` + revision protocol +
   `submitCodeChange` (per-client `clientId`/`seq` dedupe records, pins[],
   active-turn rejection, the straggler bridge + retired-row grace buffer, threshold
   materialization); `buildChatContent`;
   accept/update-from-mainline/revert on changes; agent path rewrite (append-time pin
   validation, turn-attributed rows); compaction rework (`proposedChange`); delete
   `yjs-seed.ts`, its tests, and both in-band rejection chokepoints (`yjs-files.ts`
   survives until commit 4 — git-migration.ts still imports it). Port
   `chat-code-base.test.ts`'s scenario matrix (generation/pin races, epoch resets,
   tip-or-parent, revert rollback — the scenarios transfer nearly verbatim) plus
   new convergence, reconnect-window (incl. `clientId`/`seq` retry/dedupe — a
   retry after materialization, after an epoch reset, and after a destructive
   bump each get their ack from the per-client record; seq-gap and
   unknown-session rejection; digest-mismatch rejection; a different user
   reusing an observed clientId cannot read or advance its record; the
   dedupe-before-resolution ordering),
   turn-abort, **straggler-bridge** (clean across a merge;
   head-moved-since-merge pinning at a parent of tip; multi-gadget incl. a
   promoted in-chat creation; across a threshold materialization;
   **bridge-ineligible rejection** — pinned-but-net-unchanged gadget whose
   `mergedCommit` fell behind head, reported in `prior.discontinuousGadgets`;
   **eligibility-via-mergedCommit** — a net-unchanged pin whose `baseCommit` is
   old but whose `mergedCommit` equals head after `updateChatFromMainline`
   bridges by identity; **new-generation-pin-at-different-base rejection**;
   destructive bump still discards; past-horizon rejection), watermark
   (a delayed old-generation materialization message must not clear the new
   generation's rows; tail completion via `prior.finalRevision`), and
   threshold-materialization (mid-window typist stales nobody) tests.
4. **Migration** (workshop-backend): conversion boundary + pins + elision +
   the revert-floor restriction, legacy path deletion (Yjs confined to
   git-migration.ts; `yjs-files.ts` deleted here with its tests, its `readDocFiles`
   folded into the migration's own replay), migration test additions (§5).
5. **Frontend OT + editor swap**: the OT client, content layering, first-keystroke
   pin flow; CodeMirror 6 replaces Monaco in `CodeEditor.tsx` (languages, search,
   theme); dependency removal (`yjs`, `y-monaco`, `y-protocols`, `monaco-editor`,
   `@monaco-editor/react`, the vite alias, the jsdelivr runtime load). The diff
   view may be temporarily degraded at this boundary (e.g. `@codemirror/merge`'s
   stock unified view as a placeholder).
6. **Diff view rebuild**: `diff/diffModel.ts` re-sourced onto `@codemirror/merge`'s
   diff, `diff/diffRenderer.ts` rebuilt on CM decorations/block widgets/gutters,
   full current UX restored (stacked/split, deletion zones, expansion, scroll
   sync, layout preference). The full `pnpm build` / `pnpm test` / `pnpm lint`
   gate applies here.
