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
  and chats' base commits). No branches/tags/HEAD.
- **One object store per workspace**, all gadgets' histories mixed together. Unrelated
  DAGs coexist fine in a content-addressed store; related histories dedup at the
  blob/tree level.
- **Storage**: a new typed-storage collection in the Overseer DO, exposed to
  isomorphic-git through a custom fs shim. No >2MB object handling initially, but the
  design must leave chunking (or R2 spill for large blobs) open as a later shim-local
  change.
- **Editing happens only within chats.** Standalone (out-of-chat) mainline editing is
  removed. (A future change will make it easy to start an agent-less chat for manual
  edits.)
- **Merge model — merge into the chat, not into mainline:**
  - Committing to mainline is *only ever* a fast-forward: accept requires the chat's
    base commit == the gadget's head commit, and creates a plain commit on head.
  - If mainline moved, the user must first "update from mainline": compute a 3-way
    merge (diff3) of base/head/chat trees, deliver the result *into the chat* as a Yjs
    update, and advance the chat's base commit to head. Conflicts are left inline as
    3-way conflict markers; the user (or their agent) cleans them up in the chat, then
    retries accept.
  - This deliberately plans for future multi-commit chat sessions: the chat is the
    branch, and mainline only ever advances by simple commits.
  - Yjs merge semantics are explicitly *not* used for cross-base merging — CRDT merge
    across divergent bases produces nonsense; conflict markers are better.
- **Commit identity**: the real user profile ID. Profile IDs are typically email
  addresses; in username/password mode they may be bare usernames — distinguish by the
  presence of `@`, and turn bare usernames into `<username>@localhost` (placeholder
  until users can customize commit identity). Message derived from chat context.
- **Migration**: synthesize commits from the existing Yjs update log (details below).
  Old `code`/`snapshots` collections kept read-only for a transition period; deletion
  is a later cleanup change.

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
  base commit explicitly.
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

- New typed-storage collection `gitObjects` in `makeOverseerStorage()`: key = path
  under a virtual gitdir (e.g. `objects/ab/cdef...`), value = raw bytes. The path-keyed
  scheme keeps the shim trivial and leaves room for future non-object paths if git
  protocol support ever wants them.
- fs shim implementing `PromiseFsClient`:
  - Real: `readFile` (missing → reject ENOENT; zero-arg call → rejected promise),
    `writeFile`, `stat` (existence + size; directories synthesized from key prefixes,
    though nothing but `discoverGitdir` stats them), `mkdir` (no-op success),
    `readdir` (list by prefix; `objects/pack` → `[]`).
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
  - Commit author helper: profile ID → `{name, email}`; bare username (no `@`) →
    `username@localhost`.
- Pass a shared isomorphic-git `cache` object per DO instance (avoids re-parsing).
- Punt explicitly: no GC (dangling objects are cheap and only created by accepted
  merges/imports/migration; keep a GC-roots enumeration possible: gadget records,
  blueprint gadget records, live chats' base commits), no >2MB objects (chunking is a
  shim-local follow-up), no packfiles.
- Tests (workerd pool, like other workshop-backend tests): oid round-trips verified
  against known-good hashes produced by real git; log traversal; merge matrix (clean,
  conflicting, both-added, delete-vs-modify, unchanged); fs-shim probe behavior.

### 2. Commit-backed gadget records

- `GadgetRecord` gains `commitId: string | null` — null only while the gadget is
  pending in a chat, before its first accept. This field *is* the ref layer.
- `BlueprintGadgetRecord.codeVersion` is superseded by a stored `commitId`; blueprint
  export builds the archive from the commit tree, import writes an initial commit
  (preserving ancestry where the archive carries commit objects — sets up GitHub
  interop and cross-gadget dedup for blueprint-derived gadgets).
- Readers of committed code switch from `buildYDoc` to `readCommitFiles`:
  `loadGadgetWorker` (`overseer.ts:2366`), UI bundle reads (`overseer.ts:9242`),
  blueprint export (`snapshotCode`). Where a chat context applies, the chat overlay
  still comes from the chat's Yjs state as today.

### 3. Chat flow

- Chat state records a **base commit per touched gadget** (map gadgetId → oid),
  replacing the role of `observedCodeVersion`. Gadgets created within the chat have no
  base (null).
- Session docs (`getSessionYDoc` in agent.ts, and the frontend's chat doc) are seeded
  by inserting `readCommitFiles(baseCommit)` into a fresh Y.Doc, then applying the
  chat's proposed updates + drafts as today. The `"changes"` message / draft /
  compaction machinery is unchanged — it is exactly the "Yjs tracks uncommitted
  changes per chat" model.
- **Accept** (`mergeChanges` rewrite):
  1. For every gadget touched by the fold of proposed changes, assert
     `chat.baseCommit[gadget] == gadgetRecord.commitId`. Any mismatch rejects the whole
     accept with a typed "stale — update from mainline" error (no partial accepts).
  2. Flatten the chat doc per gadget → file map → `writeFilesAsCommit` with parent =
     head (parentless for chat-created gadgets).
  3. Update `GadgetRecord.commitId`s, promote pending gadgets/binding edges, write the
     `"merge"` message — all in one DO event (output gate makes storage atomic).
  - Objects are written **only** here (plus migration/import), so reverted chats leave
    zero garbage.
- **Update-from-mainline** (new Overseer operation):
  1. Per stale gadget: `threeWayMerge(readCommitFiles(base), readCommitFiles(head),
     flatten(chatDoc))`.
  2. Convert the merged file map into a Yjs update against the current chat doc using
     minimal per-file text diffs applied to the `Y.Text` instances (so concurrent live
     editors converge instead of seeing delete-all/reinsert), recorded as a normal
     `"changes"` message.
  3. Advance the chat's base commits to the heads. The chat now *contains* mainline;
     a subsequent accept is a plain commit on head (assuming mainline didn't move
     again).
  - Conflict markers stay in the files; surface `conflictPaths` in the message so the
    UI/agent can point at them.
- **Revert** is unchanged (fold-level erasure; nothing to clean up in the object
  store).
- Mainline Yjs doc, the `code` log (for new writes), snapshots, and standalone
  editing paths are all retired.

### 4. Migration (lazy, per workspace, on Overseer DO access)

- Trigger: a storage-schema flag; run before serving any code-touching request. Idempotent
  and resumable (record progress so a mid-migration eviction restarts cleanly).
- Per gadget root, replay the `code` update log (using existing `replayUpdates`
  snapshot support) and synthesize a commit chain:
  - Materialize a commit at any version where the gap to the *next* `CodeUpdate`
    timestamp is ≥ 1 hour (batching keystroke bursts from old standalone editing),
    **plus** the final version, **plus** every version pinned as some live chat's
    `observedCodeVersion` (those become the chats' base commits).
  - Skip versions where the gadget's flattened files are unchanged from its previous
    synthesized commit (most updates touch one gadget; others' chains stay short).
  - Commit timestamps from `CodeUpdate.timestamp`; author = workspace owner identity;
    generated message (e.g. `"history import"` with the version range).
- Rewrite live chats' pinned versions to base-commit maps. Existing proposed-change
  Yjs updates in chat messages remain valid: they were built against the doc at
  `observedCodeVersion`, and the new seeding path reconstructs equivalent file content
  from the synthesized commit at that version.
  - Caveat to handle: the synthesized seed doc and the historical doc are different
    CRDT instances, so old updates do NOT apply to a freshly-seeded doc. For
    *pre-existing* chats, keep seeding from the legacy log (`buildYDoc`) until the
    chat merges or reverts; only new chats use commit-seeded docs. This is the main
    reason the old `code`/`snapshots` collections stay read-only rather than being
    deleted: they remain the CRDT base for in-flight chats.
- Old `code` and `snapshots` collections: no new writes, retained read-only; deletion
  is a later cleanup change once in-flight chats have drained.

### 5. Protocol changes (`workshop-shared/src/api.ts`)

- `subscribeToCode`/`updateCode` and the `CodeUpdate`/version-number model become
  per-chat: subscribe to a chat's doc (seeded from base commits), push updates into the
  chat's draft stream. Workspace-wide code subscription is removed.
- Version numbers are replaced by commit oids where they were load-bearing
  (`observedCodeVersion` → per-gadget base commits; `WorkpieceSummary` /
  `BlueprintGadgetRecord` surfaces).
- New API surface: update-from-mainline operation; typed stale-accept error; commit
  metadata exposure (enough for a future history UI: `readCommitLog`-backed).
- Kernel review bar: doc-comment every touched/added export; no hand-written mirrors
  of RPC types; keep the diff minimal.

### 6. Frontend

- `GadgetCodeInterface` layering collapses from three layers (mainline doc → proposed
  → drafts) to two (commit-seeded chat doc → drafts).
- Remove standalone editing surfaces (editing is only reachable within a chat).
- Accept-flow UX: when accept is rejected as stale, offer "update from mainline";
  after an update-with-conflicts, show the conflicted files (markers are visible in
  the editor; a richer resolution workflow is future work).

## Commit sequence (one PR)

Ordered so the kernel-critical diffs are isolated and each commit builds/tests green:

1. **git-store**: `git-store.ts` (fs shim, plumbing helpers, `threeWayMerge`, author
   helper), `gitObjects` collection, isomorphic-git + diff3 dependencies in
   workshop-backend, workerd tests. No behavior change anywhere else.
2. **workshop-shared API**: new/changed RPC surface (per-chat code subscription,
   base-commit fields, update-from-mainline, stale error, commit metadata types),
   fully doc-commented. Type-only; backend implements in the next commit.
3. **commit-backed backend**: `GadgetRecord.commitId`, accept/update-from-mainline/
   revert flows, commit-seeded session docs, readers switched to commit trees,
   blueprint export/import on commits, retirement of mainline Yjs writes and
   standalone editing paths.
4. **migration**: lazy log→commit synthesis, chat pin rewriting, legacy-seeding path
   for in-flight chats, read-only retention of `code`/`snapshots`. Tests over
   synthetic logs (burst batching, multi-gadget, live-chat pins).
5. **frontend**: chat-doc layering, standalone-editing removal, stale-accept /
   update-from-mainline UX.

## Accepted tradeoffs / future work

- No delta compression (isomorphic-git never writes deltas); zlib'd whole blobs with
  content-address dedup. Revisit if large files show up.
- SHA-1 (the only format isomorphic-git supports; also the interop default).
- No GC yet; roots enumeration is kept possible.
- No >2MB objects yet; chunking or R2 spill is a shim-local follow-up.
- Multi-commit chat sessions, agent-less chats for manual edits, history UI,
  GitHub push/pull via gatekeepers, git protocol: future changes this design
  deliberately leaves room for.
