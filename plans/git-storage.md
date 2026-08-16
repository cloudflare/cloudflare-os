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
  - Conflict markers stay in the files; surface `conflictPaths` in the message so the
    UI/agent can point at them.
- **Revert** is unchanged (fold-level erasure; nothing to clean up in the object
  store).
- Mainline Yjs doc, the `code` log (for new writes), snapshots, and standalone
  editing paths are all retired.

### 4. Migration (Overseer constructor, `version` singleton)

- Runs in the Overseer DO constructor, triggered by bumping the `version` singleton,
  like previous storage migrations. Idempotent in structure (content-addressed object
  writes are naturally re-runnable; record updates happen after object writes).
- Per gadget root, replay the `code` update log (using existing `replayUpdates`
  snapshot support) and synthesize a commit chain:
  - Materialize a commit at **every code version recorded by a `merge` message** in
    any chat (`version`, present on every historical merge). The chat history is a
    complete record of past `mergeChanges()` calls, so these are the principled commit
    points — each one is a moment a user deliberately accepted changes.
  - **Plus** any version where the gap to the *next* `CodeUpdate` timestamp is ≥ 1
    hour (batching keystroke bursts from old standalone editing, which bypassed
    merges), **plus** the final version, **plus** every persisted pinned version
    (next bullet).
  - Skip versions where the gadget's flattened files are unchanged from its previous
    synthesized commit (most updates touch one gadget; others' chains stay short).
  - Commit timestamps from `CodeUpdate.timestamp`; author = workspace owner identity;
    generated message (e.g. `"history import"` with the version range).
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
