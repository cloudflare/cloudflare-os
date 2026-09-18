# Plan: Worktrees in the Workshop UI

## Goal

Make worktrees (plans/worktrees.md) visible and reviewable in the Workshop: a worktree
appears in the workpiece list of the chat that owns it, its Code tab shows the repository's
**file tree** (delivered whole, so name search can come later) plus a **Changes** list of
the files changed since the user last accepted, and each file opens — content fetched on
open — in the same CodeMirror diff editor gadget code uses, editable under the same rules
(chat selected, agent idle). Accept / Discard / per-turn revert apply to worktrees exactly
as to gadgets. Gadgets move onto the same file browser, so there is one code UI, not two.

Three things move together:

- **Shared API (workshop-shared):** two reads (`listTree`, `readFilesAtCommit`) that
  replace `getCodeAtCommit` for every workpiece type, and a worktree variant of
  `WorkpieceSummary` carrying `pinBase`.
- **Backend (workshop-backend):** worktrees pinned **on first modification** like gadgets
  (so "pinned" means "changed since last accept" for every workpiece type, and the
  pending-changes derivation needs no worktree special case), worktrees published on
  `subscribeToWorkpieces`, the reads implemented over the existing lazy git cache, the
  client-delivery stripping the first plan installed **deleted**, and `getCodeAtCommit`
  deleted.
- **Frontend (workshop-frontend):** `ChatOtClient` becomes sparse for *all* pins (no
  whole-tree fetch anywhere), a per-commit file store sits under the editor,
  `FileSidebar` becomes a changes-list + tree browser, and `GadgetCodeInterface` is
  generalized to both workpiece types.

## Current-state anchors (for orientation)

Frontend:

- CodeMirror 6. `CodeEditor.tsx:29-35` defines `EditSession` (`key`, `getText()`,
  `applyLocal(change, docText)`, `subscribeRemote(cb)`) — the editor↔OT seam.
  `CodeDiffEditor.tsx` renders the in-chat diff (own model, `diff/diffModel.ts`);
  `FileSidebar.tsx` is a flat path list with status dots (`FileChangeStatus`);
  `GadgetCodeInterface.tsx` (1219 lines) orchestrates head fetch, OT client, edit
  previews, file ops, statuses.
- Content comes from `Overseer.getCodeAtCommit(commitId)` (whole tree; oid-cached in
  `commitFilesCache`, `GadgetCodeInterface.tsx:77-90`) and the chat change stream
  (`changeApplied` rows; `"changes"` messages composed by `computeChatEpochChanges`,
  `ChatInterface.tsx:2313`).
- `otClient.ts` (`ChatOtClient`): `#applied` = **full** pin base trees + epoch change +
  rows. A row touching an id without content fetches the *whole* pin base (`#applyRow`,
  `:417-445`); `#rebuild` prefetches every pin's tree (`:644-652`);
  `#trySwitchGeneration` carries touched ids across an epoch reset (`:558-632`);
  `ensureGadgetEditable` (`:709`) seeds an unpinned gadget from head and declares the pin
  on the next submission (`#localSeeds`).
- `GadgetEditor.tsx`: `allGadgets` filters `type === 'gadget'` (`:651`); `visibleGadgets`
  hides other chats' pending gadgets (`:678`); selection from `?w=` (`:692`);
  `getGadget(id)` pipelined (`:1176-1184` — **throws for a worktree id**); pane tabs from
  `rightTabs(output)` (`:173`). `WorkpiecePicker.tsx` is the output rail. The
  "Pending changes" banner/badge derive from `AiChatMetadata.proposedChangeWorkpieces`
  (`chatHasProposedChanges`, `ChatInterface.tsx:2432`); Discard = `revertChanges(chatId,
  0)` (`:4147-4176`); Accept = `mergeChanges` (`:4073`).
- Edit previews (`editPreviewStart/Delta/Clear`, `api.ts:3481-3529`) carry no base text:
  the client locates `textToReplace` in its own copy of the file, synchronously.
- No virtualized list/tree component exists; Kumo has `Collapsible` and `List`, no tree.

Backend:

- `WorktreeRecord` (`overseer.ts:406-463`): `{type:"worktree", id, title, chatId,
  sourceGatekeeperId?, baseCommit, headCommit, pinBase, pending?}`. `pinBase` advances
  only at epoch resets (`:4600-4606`); `headCommit` only by explicit `commit()`
  (`:8433-8450`) and revert rollback (`:4773-4790`, to the earliest reverted
  advancement's `previousHead`).
- Born pinned: `createWorktree` declares the birth pin on the creation batch
  (`agent.ts:3054-3058`); `mergeChanges` re-pins every live worktree in the new
  generation and records `worktreePins` on the merge message (`:4393-4431`,
  `:4536-4539`, `:4590-4597`); `buildChatContent` (`:2875-2922`), `agent.ts:2076-2088`
  and `agent-compaction.ts:437-442` re-establish bases from `worktreePins` at boundaries.
  `submitCodeChange` rejects worktree pin declarations (`:4041-4047`).
- `proposedChangeWorkpieceIds` (`:3216-3229`) is purely derived from pins + pending
  records (its comment explains this replaced a stored `hasProposedChanges` bit that
  drifted) and excludes worktrees because their pins prove nothing.
- Stripping: `stripWorktreeChangeEntries` (`:3185`), `stripWorktreePins` (`:3196`),
  `isEverWorktree` (`:2220`, live ∪ the `deadWorktreeIds` singleton `:1154`), called from
  `emitChatChangeApplied` (`:3254`), `subscribeToChat` replay (`:11676`),
  `hydrateChatMessageForClient` (`:5563`), `chatMetaForClient` (`:3235`), the compaction
  checkpoint in `getChatHistory` (`:11568`). `agent.ts:2333-2342` refuses edit previews
  for worktree targets.
- `subscribeToWorkpieces` (`:2726-2792`) publishes only gadgets (`published`, `:2759`).
- Lazy reads exist in `git-cache.ts` (`WorkspaceGitCache`): `readFileAtCommitIfExists`
  (`:532`), `listCommitTreePaths(commit, path?, {recursive})` (`:631`, kinds
  file/executable/dir/symlink/submodule, trees fault eagerly, no blobs), `ensureGitObjects`
  (`:395`). `worktree-session.ts:309-340` is the batched blob-fault pattern.
- `getCodeAtCommit` (`:10899`) → non-faulting whole-tree `readCommitFiles`; use role
  denies (`:12266`). Its only frontend caller is `GadgetCodeInterface`'s
  `commitFilesCache` (verify no other caller before deleting it).
- Constants: `MAX_GIT_OBJECT_SIZE` 1 MiB, `EAGER_BLOB_LIMIT` 64 KiB (`git-cache.ts:75,92`);
  `MAX_FILE_TEXT_LENGTH` 512K UTF-16 units (`code-change.ts:126`).

## Locked decisions

- **The review base is what accepting would apply against: the chat pin's `mergedCommit`
  when pinned, else the accepted commit; it is distinct from the OT base.** Two commits
  matter to the code view and the plan keeps them apart:
  - The **content base** is what the chat's content is built on: the chat pin's
    `baseCommit` when the workpiece is pinned, else the accepted commit (`commitId` for a
    gadget, `pinBase` for a worktree). The tree listing, a file's text, and the seed for
    an `edit` all come from here — it is what the agent reads. It is fixed for the life
    of the pin (`ChatGadgetPin.baseCommit`'s contract).
  - The **review base** is what "changed" means: `ChatGadgetPinState.mergedCommit` when
    pinned — the mainline commit whose content has been merged into the chat — else the
    accepted commit. Diff `original` and Changes statuses are computed against it, and
    never against head alone.
  The diff must show exactly what clicking Accept would apply, and accepting never reverts
  mainline. A chat not updated from mainline has `mergedCommit === baseCommit`, so it
  diffs against its own pin and mainline's later commits never appear (accept is blocked
  by the stale dialog until they are merged in). Once `updateChatFromMainline` has
  imported them as ordinary OT rows, `mergedCommit` has advanced past `baseCommit` and
  those rows compare equal and vanish, instead of being listed as this chat's changes —
  which diffing against the pin's `baseCommit` would do. Accept requires `mergedCommit ===
  head`, so wherever it is enabled this equals the head comparison. For a worktree the
  bases coincide by construction (no mainline; `pin.baseCommit === pin.mergedCommit ===
  record.pinBase` within an epoch), which yields the review the user wants: an agent that
  edits and immediately commits still shows its work, and a user driving many small
  changes toward one eventual commit accepts them incrementally — `headCommit` plays no
  role in review. No server-side tree diff is needed: the candidate set is the overlay,
  since every path where the review base differs from the content base was touched by the
  rows that imported the difference. Choosing another review base (from a commit log) is
  future work.
- **Rejecting changes rejects their commits.** Already true: a revert rolls `headCommit`
  back to the earliest reverted advancement's `previousHead`, and Discard reverts the
  whole epoch, so the worktree returns to its last accepted state, head included. This
  plan adds no mechanism, only a test and the UI. Known inconsistency, deliberately left
  for a later change: a commit the agent already pushed through a gatekeeper is not
  un-pushed by the revert (reverts will eventually cancel queued gatekeeper actions).
- **Worktrees pin on first modification, like gadgets; the born-pinned design is retired.**
  Terminology first, because "pin" is overloaded: a worktree's state is three things —
  `record.headCommit` (last explicit `commit()`), `record.pinBase` (the **accepted
  commit**: the content as of the last accept, and the commit the epoch's OT rows compose
  on), and the current epoch's OT rows. This plan changes none of those. What it changes
  is the **chat pin** — the `codeBase.pins` entry — which today exists for a worktree from
  birth and is re-created at every accept, and which under this plan exists only while
  the epoch has rows, exactly as for a gadget. The accepted commit takes the role a
  gadget's head plays for pinning: a worktree with no chat pin reads as its accepted
  commit's tree (lazily); the first write in an epoch — or a `commit()` — establishes the
  chat pin `{gadgetId, baseCommit: record.pinBase}` (agent: recorded in the step's
  message like any gadget pin; client: a declaration the server accepts iff its
  `baseCommit` equals `record.pinBase`); accept does what it does today — auto-commit the
  dirty worktree, `record.pinBase := auto-commit`, `headCommit` untouched — and then
  simply does *not* re-create the chat pin, since the new epoch has no rows. Nothing is
  lost at that boundary: changes not committed to head are the accepted commit's tree,
  as now. The invariant "a chat pin, when present, has `baseCommit === record.pinBase`"
  holds as it does today; the entry is merely absent when it would be vacuous. No birth
  pin, no re-pin of clean worktrees, no new `worktreePins` written (the field stays in
  the API and is still *honored* by every reader, since existing chat logs contain it).
  **Legacy live pins are not migrated.** A chat that already holds a born/re-created
  worktree pin in its stored `codeBase` keeps it, and once the exclusion is removed that
  pin reads as "pending changes" — a spurious banner on an idle chat. Accepted: few such
  chats exist and the annoyance is mild. The compatibility rule that makes it
  self-healing: **accept always runs the epoch reset when the chat holds any worktree
  pin, even with no proposed messages to merge** (today it returns early); the reset's
  auto-commit planning finds the worktree clean and simply drops the pin, so one click
  clears it and the new generation is in the new regime. A write under a legacy pin
  behaves as any pinned write (the pin's base equals `record.pinBase`, as the re-pins
  guaranteed); reverts leave a legacy pin alone (its declaring message is a merge, which
  can't be reverted) — accept is the way out. A legacy `worktreePins` declaration is
  still treated as a surviving declaration by `declaredPinGadgets()` for exactly this
  reason.
  Consequences: a chat pin now means "changed since last accept" for every workpiece
  type, so `proposedChangeWorkpieceIds` drops its worktree exclusion and gains nothing
  else; the Changes list's candidate set is "the pinned overlay" by construction; and
  the UI's content base is the chat pin's `baseCommit` when present and
  `WorktreeSummary.pinBase` (the accepted commit) when not — the same `chatFiles ??
  headFiles` shape it uses for gadgets — while the review base is the pin's
  `mergedCommit` when present and the accepted commit when not (see the review-base
  decision).
  (Alternative considered: keep born-pinned and add
  a transactionally maintained "touched this epoch" marker set at row/commit landing,
  cleared at epoch reset, recomputed on revert in the pin walk. Fewer settled lines
  touched, but it is the stored-flag pattern `proposedChangeWorkpieceIds` was built to
  eliminate, and it adds state to shared metadata. Rejected unless review finds the
  re-pinning refactor too costly.)
- **The "Pending changes" banner covers worktrees — once modified.** With
  pins-on-modification it does so through the existing derivation: pinned worktrees. A
  worktree record merely *pending* in the chat (created, never written to or committed) does
  **not** propose anything, unlike a pending gadget: a worktree stays private to its chat
  whether or not it is accepted, so an agent that checks a repository out only to read it
  would otherwise raise a banner over a chat with nothing to accept. For the same reason the
  creation is not revertable: the `changes` message recording it clears the record's `pending`
  at once (only an unrecorded crash orphan is reaped), and a revert covering that message —
  Discard or per-turn — rolls back the worktree's content and head but never deletes it.
  Discard labels name only gadget creations, and a turn whose only change is a worktree
  creation offers no discard. Accept/Discard/per-turn revert are the same buttons and RPCs.
- **The whole tree is delivered up front, as a tree; only file content is lazy.**
  `listTree(commitId)` returns the commit's tree as **nested nodes** — each directory's
  entries in git order, names not paths — so the tree browser needs one call per base
  commit and no parsing, the overlay (added/removed files) is a segment walk, and a
  client-side file-name search is a trivial flatten. Nested is the shape the server
  already walks (`parseGitTree` recursively) and the shape the UI renders; a flat
  path list would repeat every directory prefix per file and make the client rebuild
  what the server just flattened. Trees are always local (eager pull), so this costs DO
  CPU and one response proportional to the repo's entry count, not a gatekeeper round
  trip. No oids are transmitted. (capnweb-validate lowers recursive object shapes with
  lazy back-references, per its README, so the recursive type is fine for `@validateRpc`.)
- **Worktree content is delivered to clients; the stripping is deleted, not bypassed.**
  With a lazy client there is no reason for two delivery shapes: the strip helpers,
  `isEverWorktree`, `deadWorktreeIds` and all call sites go. Soundness is unchanged in
  this direction (per-workpiece transform). Ordering: the lazy-capable frontend deploys
  *before* the stripping is removed (commit sequence), so no intermediate release pairs an
  old client with un-stripped deliveries; tabs left open across the final deploy may show
  an error view in the Code tab until reload, which is accepted.
- **One code-fetching machinery for every workpiece type: sparse pins, content by path.**
  The OT client never materializes a base tree. A pinned workpiece's content entry holds
  only the paths the epoch has touched (plus paths the user began editing). `set`/`remove`
  rows need no base; an `edit` of an unloaded path seeds exactly that path from
  `readFilesAtCommit(baseCommit, [path])` before applying — the client mirror of
  `seedWorktreeEditBases`. A per-workpiece **tombstone set** records removals (a `remove`
  adds, `set` clears), since `applyCodeChange` deletes the key. Opened-but-unedited files
  stay out of the OT content (the view reads them from the file store), so "touched" ≡
  "in display ∪ tombstoned" — for gadgets too, which replaces today's head-vs-display file
  comparison. Because nothing is eager, the client needs no per-pin laziness flag and
  `getCodeAtCommit` has no caller: it is **deleted** from the API. Gadgets pay one extra
  small round trip on open (`listTree` and the first file's read can be issued together
  when the active file is known), which is not worth a second implementation.
- **Reads are commit-keyed `Overseer` methods, as `getCodeAtCommit` was.** Stateless,
  oid-cacheable, no capability lifecycle. They go through the lazy cache and so may
  fault-pull through a gatekeeper on the client's behalf, reaching only commits the
  workspace's gatekeepers advertised or proved — nothing an agent couldn't already
  trigger (gadget commits are always local and never pull). Build role only. A
  `WorktreeClient` capability is deferred until UI *operations* (commit, push, log) need
  one.
- **One file browser, one code interface, one content model, for gadgets and worktrees.**
  The only type-specific code left is the summary field the accepted commit comes from
  (`commitId` vs `pinBase`) and the pane tabs (worktrees have no App or Connections).
- **Streaming edit previews work for worktree files.** Server: delete the refusal. Client:
  a preview targeting a path not yet in the display fetches that path's base from the
  store before overlaying (deltas buffer meanwhile); with sparse pins this is the same
  code for gadgets, whose files are just more likely to be in the store already.
- **Worktrees are chat-scoped in the UI exactly as pending gadgets are** (summary
  `chatId` always set; hidden unless that chat is selected), open a Code-only pane, never
  call `getGadget`, and are never persisted as the workspace's open app.
- **No worktree operations from the UI in v1** (commit/push/branches/log). Editing is in
  scope because ingestion already exists.
- **Limits are surfaced, not worked around.** Symlinks/submodules list with their kind and
  don't open; binary or oversized (`MAX_GIT_OBJECT_SIZE`) blobs open to a placeholder
  naming the reason; a readable file longer than `MAX_FILE_TEXT_LENGTH` opens read-only.

## Design

### 1. Shared API (workshop-shared/src/api.ts)

Every export doc-commented to the kernel bar.

- `WorkpieceSummary` becomes a discriminated union; the existing shape is the `"gadget"`
  member. Add `{ id, type: "worktree", title, chatId: number, pinBase: string,
  headCommit: string, baseCommit: string }`. `pinBase` is the review base while the
  worktree is unpinned (the analog of `commitId`) and is re-delivered when an accept
  advances it; `headCommit` (header display; re-delivered on `commit()`) and `baseCommit`
  (informational) are cheap and may be trimmed in review.
- `CodeChangeSubmission.pins` doc: a worktree declaration is accepted iff `baseCommit`
  equals the worktree's current `pinBase` (`WorkpieceSummary.pinBase`), mirroring the
  head rule for gadgets.
- `Overseer.getCodeAtCommit` is **removed** (and its use-role denial). `getCommitLog`
  stays. `GadgetFiles`/`CodeContent` docs in `code-change.ts` stop describing it as the
  shape `getCodeAtCommit` returns.
- New `Overseer` methods (build role; use role throws, as `getCodeAtCommit` did):
  - `listTree(commitId: string): Promise<TreeNode[]>` — the commit's root directory as a
    nested tree: `TreeNode = { name: string; kind: "file" | "executable" | "symlink" |
    "submodule" } | { name: string; kind: "dir"; children: TreeNode[] }`, each
    directory's entries in git tree order (which is byte order of names, with a
    directory sorted as if its name had a trailing `/`). Names are single path segments;
    the client joins them. Trees fault in eagerly; blobs are never touched; no sizes, no
    oids. Response size is proportional to entry count with each name carried once.
  - `readFilesAtCommit(commitId: string, paths: string[]): Promise<[path: string,
    FileAtCommit][]>`, `FileAtCommit = { kind: "text"; text: string } | { kind: "absent" } |
    { kind: "unreadable"; message: string }`. `absent` covers a missing path and a directory
    path; `unreadable` carries
    the descriptive message for symlink / submodule / binary / oversized content. One
    batched blob pull for all missing blobs. Pull/provenance failures throw the whole call
    (transient or actionable, not per-file facts). Caps: `MAX_READ_FILES_PER_CALL` paths,
    and the server returns entries in request order **stopping early once accumulated
    text exceeds `READ_FILES_RESPONSE_BUDGET`** — omitted paths are absent from the result
    and the client re-requests them (the type makes `absent` explicit so omission is
    never misread).
- Doc updates where comments now state the opposite: `AiChatMessageBody.createdWorktrees`
  ("no worktree UI yet"), `worktreePins` (no longer written; honored when read),
  `ChatGadgetPin`/`ChatCodeBase` (worktrees pin on first modification; the content
  recipe at `api.ts:2380` names `getCodeAtCommit` — point at `readFilesAtCommit` by
  path), `AiChatMetadata.proposedChangeWorkpieces` (includes worktrees),
  `AiChatSubscriber.changeApplied` (worktree entries delivered), `WorkpieceSummary`
  header and `commitId` ("readable via getCodeAtCommit").

### 2. Backend (workshop-backend)

**2a. Pin on first modification** (kernel; the largest part, reviewed on its own):

- `createWorktree` (`agent.ts:3015-3073`, `overseer.ts:2336-2388`) stops declaring the
  birth chat pin; the record's accepted commit (`pinBase`) is the base for reads while no
  chat pin exists.
- Agent file tools and the `Worktree` binding: the pinned/unpinned split now applies to
  worktrees. Read with no chat pin → `hooks.readFileAtCommit(record.pinBase, path)`; first
  write (or `commit()`) → chat pin at `record.pinBase` through the same code path that
  pins a gadget at `getGadgetHead` (a `getWorkpiecePinBase` hook, or `getGadgetHead`
  returning the accepted commit for worktrees). `worktreePinBases`/`readWorktreeBase`/
  `applyReplayedPin` follow: the base comes from the chat pin when present, the record
  when not — the same commit either way. Replay of existing logs still honors birth pins
  and `worktreePins` (ordinary pins in `pins` / boundary re-pins), so old chats
  reconstruct unchanged.
- `mergeChanges`: keep the dirty-worktree auto-commit and the `record.pinBase` advance
  (this is where accepted-but-uncommitted content lives; unchanged); delete the
  new-generation re-pin of every worktree and stop writing `worktreePins`; and do **not**
  return early on "nothing to merge" while any worktree pin exists — run the reset so a
  legacy pin is dropped (the locked decision's compatibility rule). The straggler
  bridge must pin a bridged worktree row at the new `record.pinBase` (verify; it derives
  gadget pins from the boundary commits today).
- `submitCodeChange`: accept a worktree pin declaration iff `baseCommit ===
  record.pinBase` (replacing the rejection at `:4041-4047`); the tree-entry-mode checks
  and other-chat rejection stay.
- `proposedChangeWorkpieceIds`: drop the `isWorktree` exclusion; let the pending-record
  loop include worktrees (`pending?.chatId === chatId`; they have no bindings). Update
  the comment.
- Readers keep honoring `worktreePins` (`buildChatContent`, `agent.ts:2076-2088`,
  `agent-compaction.ts:437-442`); nothing writes it.
- Tests (adapting `worktrees.test.ts` / `worktree-session.test.ts`): unpinned read from
  `pinBase`; first write pins at `pinBase` and the pin lands in the step's message;
  `commit()` on an unpinned worktree pins; `commit()` on a *pinned* worktree advances
  `headCommit` only — the chat pin's `baseCommit`/`mergedCommit` and `record.pinBase` are
  untouched (this is what keeps an agent's own commit out of the review base; see the
  review-base decision); client declaration accepted at `pinBase`,
  rejected otherwise; accept of a dirty worktree advances `pinBase` and leaves it
  unpinned; accept of a clean worktree is a no-op; `proposedChangeWorkpieces` lists a
  worktree after its first edit, after creation only, and not after accept; discard
  restores `headCommit` to the epoch-start value across several `commit()`s; replay of a
  fixture log written by the born-pinned version (birth pin + `worktreePins`) yields
  identical content; **legacy live state**: a stored chat whose `codeBase` holds a
  born/re-created worktree pin and no proposed messages reports the worktree as pending,
  and one `mergeChanges` drops the pin (no auto-commit, `pinBase` unchanged, new
  generation) after which nothing is pending — and a write made under the legacy pin
  before that accept lands and is reviewable like any pinned write.

**2b. Publishing and reads:**

- `subscribeToWorkpieces`: `published` returns worktrees on `includePending`
  subscriptions (build role); `toSummary` maps by `type`. Use-role subscriptions keep
  excluding them.
- Un-strip: delete `stripWorktreeChangeEntries`, `stripWorktreePins`, `isEverWorktree`,
  `deadWorktreeIds` and its write in `removeWorkpiece` (`:2628-2631`), and the call sites
  (`chatMetaForClient` keeps only the `proposedChangeWorkpieces` attachment). The stored
  `deadWorktreeIds` key becomes inert (delete it in the next storage-version bump). Keep
  the `readGadgetFiles` defense — it guards a gadget-only path.
- Delete `getCodeAtCommit` from `OverseerInterface` and `UseOverseerInterface`.
  `GitStore.readCommitFiles` stays for its internal callers.
- Reads in `OverseerInterface` where `getCodeAtCommit` was, `validateOid`'d:
  - `listTree` → new `WorkspaceGitCache.readCommitTree(commit): Promise<TreeNode[]>`, the
    nested sibling of `listCommitTreePaths` (same eager-tree `ensureObject` walk, emitting
    nodes instead of prefixed paths; `parseGitTree` order is preserved as-is). Whether
    `listCommitTreePaths` then still has callers — `Worktree.listFiles` and grep use it —
    decides whether it stays or is re-expressed as a flatten of the nested read.
  - `readFilesAtCommit` → new `WorkspaceGitCache.readFilesAtCommit(commit, paths)`:
    resolve entries (`pathEntryAtCommit`), collect missing regular-file blobs, one
    `ensureGitObjects` with the grep hints, tolerate `GitObjectTooLargeError` per oid,
    decode in request order under the byte budget. Extract the batch-fault loop from
    `worktree-session.ts:#grepFiles` into a cache helper both use.
- Edit previews: delete the throw in `agent.ts:2333-2342`.

### 3. Frontend: sparse pins in `ChatOtClient`

Same class, same three input paths, same submission machinery; the whole-tree fetch
disappears and a tombstone side-table appears. Nothing is type-specific.

- **Delegate**: `fetchCommitFiles(commitId)` is replaced by `fetchFilesAtCommit(commitId,
  paths): Promise<ReadonlyMap<string, string | null>>` (`null` = absent; an `unreadable`
  base under an `edit` row is a server-invariant violation → `onFatalError`, like a
  failed tree fetch today).
- **`#applyRow`** (`:417`): for a pin the content doesn't cover, fetch only the row's
  `edit` paths not already in `#applied` (one call per commit); `set`/`remove` need
  nothing; seeds emit no `set` events (nothing was displayed from the client before —
  open editors read from the store). Hold-until-pin is unchanged. The pending-creation
  path (`#pendingCreations`) is unchanged: rows apply against an empty base.
- **`#rebuild`** (`:644`): batch-fetch the `edit` paths of `durable.epochChange` per pin
  (one call per base commit), then `applyCodeChange` as today.
- **Tombstones follow the applied/display split.** `#removed: Map<WorkpieceId,
  Set<string>>` tracks the **acknowledged** state only, updated exactly where `#applied`
  is (rows, rebuild, switch): `remove` adds, `set`/`edit` deletes. **Displayed**
  tombstones are never stored; `getRemovedPaths(id)` derives them on demand by folding
  the local buffers over the acknowledged set in the same order `#recomputeDisplay` folds
  content — `#removed`, then `#inflight.change`, then `#pending` (`remove` adds,
  `set`/`edit` deletes). One set fed from both timelines would be wrong: with a local
  delete in flight, a remote `edit` of the same file arrives, is applied to `#applied`
  (the file legitimately exists there), and transforms against the local `remove` into
  an empty display change — the file stays deleted on screen, and a shared set would
  have just lost its tombstone, letting the model resurrect the file from base. The
  derivation reproduces the transform's outcome without a second bookkeeping path; the
  buffers are small, so the fold is cheap.
- **`#trySwitchGeneration`** (`:558`): carry across only the paths the local buffers touch
  (today's whole-entry carry would mislabel every file the epoch touched as touched
  again); a local seed is re-rooted at the new base from the summary for the next
  declaration. Tombstones reset except locally removed paths.
- **`ensureFileEditable(id, baseCommit, path, baseText)`** replaces `ensureGadgetEditable`:
  if the id has no content and no seed → a sparse `#localSeeds` entry `{baseCommit,
  files: {path: baseText}}`, declared as the pin on the next submission exactly as today
  (`baseCommit` = the gadget's `commitId` or the worktree's `pinBase`; pending creations
  need no seed, as now); if the id is already pinned/seeded but the path is unloaded →
  seed the path into `#applied`/`#display` (server-acked base content).
- **Tests** (`otClient.test.ts`; existing tests adapt from tree fetches to path fetches):
  `set`/`remove` rows apply with no fetch; `edit` row fetches exactly its paths; rebuild
  fetches the epoch change's edit paths in one call per commit; tombstone add/clear
  across `remove`→`set`; **local delete in flight + remote edit of the same path keeps
  the displayed tombstone** (and the reverse: remote `remove` + pending local `set`
  shows the file); first local edit on an unpinned workpiece declares `{gadgetId,
  baseCommit}` with a sparse seed; a later local edit on another path seeds only that path
  and declares nothing; remote row transforms a pending local edit on a sparse entry;
  switch carries only locally touched paths; unreadable base under an edit → fatal; a pin
  whose base differs from a local seed still discards and rebuilds; deliveries with
  worktree content *stripped* (old backend) are inert.

### 4. Frontend: the per-commit file store

New module replacing `commitFilesCache`, module-scoped like it:

- `listTree(commit) → Promise<TreeNode[]>`, `readFiles(commit, paths) → Promise<Map<path,
  FileAtCommit>>`, memoized by oid (immutable), with in-flight dedupe and microtask
  coalescing of `readFiles` into one RPC per commit (chunked at
  `MAX_READ_FILES_PER_CALL`; re-requests paths the server omitted under the byte budget).
- The OT delegate reads from the store, so a base an editor already opened is never
  fetched twice.

### 5. Frontend: content model, file browser, editor wiring

- **`WorkpieceCodeModel`** (per selected workpiece; fed by the OT client, the store, the
  summary) answers:
  - *Two bases* (the locked decision): `acceptedCommit = summary.type === "worktree" ?
    summary.pinBase : summary.commitId` — the single type-specific line in the model;
    `contentBase = pin?.baseCommit ?? acceptedCommit` is what content is built on, and
    `reviewBase = pin?.mergedCommit ?? acceptedCommit` is the **review base**. Both
    `undefined` for a pending (chat-created) gadget, whose tree is the overlay alone.
    They are equal except for a gadget chat updated from mainline.
  - *The tree*: `store.listTree(contentBase)` overlaid with the client's display for the
    id — displayed tombstones removed, overlay paths absent from the base inserted with
    virtual ancestor directories, directories first then files. A base directory whose
    files are all tombstoned is hidden (the full tree makes that computable).
  - *Changes*: touched paths (display keys ∪ displayed tombstones) with status from
    `store.readFiles(reviewBase, paths)`: `absent` → added; tombstone → deleted if
    present at the review base, else dropped; equal text → unchanged (hidden); else
    modified. `unreadable` review-base content under a `set` → modified, no diff view.
    This replaces today's `headFiles` vs `displayFiles` loop for gadgets.
  - *A file*: `text` = display (touched) or `readFiles(contentBase, [P])`; `original` =
    `readFiles(reviewBase, [P])` in a chat; the seed passed to `ensureFileEditable`
    is the `contentBase` text (the OT base), not `original`; `unreadable` → placeholder;
    `symlink`/`submodule` → not openable; `text.length > MAX_FILE_TEXT_LENGTH` →
    read-only.
- **`FileBrowser`** (replaces `FileSidebar`'s internals): a **Changes** section (flat rows,
  status dots, dimmed directory prefix, count; omitted when empty or in view mode) above a
  **Files** tree (caret, indentation, kind icons; expanded state per workpiece for the
  session; gadgets and small trees render expanded, large trees collapsed to the first
  level). Built on Kumo `Collapsible`/buttons — Kumo has no tree primitive; row styling,
  the per-row menu (download / rename / delete) and the create dialog carry over.
  Rename/delete/create disabled on symlink/submodule entries and non-file paths;
  **rename is also disabled for `executable` entries**: a rename is `remove(old)` +
  `set(new, text)`, and the tree writer takes a mode only from the *destination's* base
  entry, so a renamed script would silently drop `100755` at the next accept or commit —
  `CodeChange` has no way to say "same mode at a new path" (a representation change,
  future work; the agent's `Worktree` API has the same gap). "Download all" hidden for
  worktrees. Mobile keeps the focus-trapped drawer. No
  virtualization in v1 (a windowed list is the fix if a huge expanded directory bites).
- **`GadgetCodeInterface` → `WorkpieceCodeInterface`**: takes the `WorkpieceSummary`,
  branches on `type` only in the model's base-commit line and the tab set. The
  `EditSession` calls `ensureFileEditable(id, contentBase, path, contentBaseText)` on a
  file's first `applyLocal`. Edit previews (landed in commit 4): on `editPreviewStart`
  for a path not in the display, `store.readFiles(contentBase, [path])` first, buffering
  deltas, then overlay as today; a preview that *finishes* (the next call's start) before
  that read lands is deferred, not dropped — it joins its file's pending chain when the
  read arrives, in call order, and a row or clear arriving first resolves it like a chain
  entry. Short edits followed by the next tool call routinely fit inside one read's RTT,
  so dropping would lose previews routinely under lazy content. `isEditingLocked` rules
  unchanged. The head-fetch effect and `headFiles` state go away.
- **`GadgetEditor` / picker / tabs**: `visibleWorkpieces` includes worktrees whose `chatId`
  is the selected chat; picker and pane tabs render them with `GitBranch` (a "Worktrees"
  group at the end of the rail); selecting one forces `code`, `rightTabs` → `['code']`,
  `getGadget` skipped, open-app preference untouched. `?w=<worktreeId>` with another
  `chat` falls through the existing fallbacks. Header: "Reviewing / Editing changes in
  <chat>" plus short `headCommit`.
- Transcript: a `CreatedGadgetChatCard`-style "open" affordance for `createWorktree`
  (routes by id already).

## Constants (tunable, named in one place)

- `MAX_READ_FILES_PER_CALL` — paths per `readFilesAtCommit` (64).
- `READ_FILES_RESPONSE_BUDGET` — text bytes after which the server stops and omits the rest
  (8 MiB; well under the 32MB RPC ceiling with UTF-16 inflation).

## Known edge cases / watch-fors

- **Straggler bridge for worktrees**: with no re-pin in the new generation, a client
  submission bridged across an accept must be pinned at the new `record.pinBase`. Verify
  in `mergeChanges`' bridge and test it (edit in flight during accept lands pinned at the
  auto-commit).
- **Old logs**: every reader keeps honoring birth pins in `pins` and `worktreePins` on
  merges; the fixture-log replay test guards it. Writers stop producing both.
- **`listTree` size**: proportional to entry count, each name once (~25 bytes/entry
  nested; a 100k-file repo ≈ 2.5 MB), re-fetched whenever `pinBase` moves (each accept
  with worktree edits). Acceptable for v1; if it bites, add a `since`-style delta or an
  entry cap with an explicit error, not silent truncation.
- **Old tabs across the final deploy**: an old tab calls the deleted `getCodeAtCommit` →
  RPC error → the Code tab's existing error/retry view until reload (locked decision).
  The reverse skew (new frontend, old backend) never happens in this sequence: the reads
  land in commit 1, several releases before the frontend uses them, and the "stripped
  deliveries are inert" test covers the content side.
- **Gadget open cost**: `listTree(head)` + `readFiles(head, [activeFile])` instead of one
  `getCodeAtCommit`; both are small and issued together when the active file is known.
  If an eager whole-tree path is ever wanted back for gadgets, it is a `readFiles(commit,
  allPaths)` call into the same store — not a second implementation.
- **`edit` row whose base read fails**: pull failure → `onFatalError` → the
  existing retry UI; `unreadable` → fatal. Never skip a row (gapless revisions).
- **`remove` of an absent base path**: valid no-op server-side; the Changes list drops it
  when `readFiles(reviewBase, [path])` says `absent`.
- **Gadget pinned at an older head, then updated from mainline**: `mergedCommit` is the
  new head; imported rows are touched paths whose text equals it → hidden; the chat's own
  edits show their diff against it. Gadget pinned at an older head and *not* updated:
  `mergedCommit === baseCommit`, so every file — touched or not — diffs against the pin
  and mainline's later changes never appear (nothing here reverts them; the stale dialog
  gates accept until they are merged in). Tests: both scenarios against the model.
- **Worktree with an agent commit mid-epoch** (`headCommit !== pinBase`): the review base
  is `pinBase` whether or not the chat pin is present (`pin.mergedCommit === pinBase` for
  a worktree pin's whole life — only `updateChatFromMainline` ever advances a
  `mergedCommit`, and it skips worktrees), so the diff original and statuses come from the
  last *accepted* commit and never from a commit the agent made. `headCommit` is header
  display only. Test: against the model, a worktree whose summary has `headCommit` ahead
  of `pinBase`, pinned and unpinned, with `original` read from `pinBase`.
- **Legacy live worktree pins** show a pending banner on an idle upgraded chat until one
  accept (locked decision). Don't "fix" it with a migration.
- **Accept**: pin evaporates, summary `pinBase` advances, the switch carries only locally
  touched paths; open editors re-read from the store at the new base (identical text by
  construction — compare before dispatching so CodeMirror docs aren't rebuilt); the tree
  re-fetches.
- **Explicit `commit()`**: `headCommit` advances via the summary; Changes list unchanged
  (base is the pin, not the head). A `commit()` on an unpinned worktree pins it so the
  head advancement is revertable and shows as a pending change.
- **Files between 512K UTF-16 units and 1 MiB**: openable, read-only.
- **Two clients on one worktree**: ordinary OT; one client's `edit` row for a path the
  other hasn't loaded triggers that client's per-path seed. One test.
- **Other chats' worktrees** ride the workpiece subscription (like other chats' pending
  gadgets) and are hidden client-side; any build-role collaborator can open the chat
  anyway — not an authority boundary.

## Commit sequence

Kernel diffs first and isolated; every code move is its own commit with only
build-preserving edits; the un-strip lands last so no intermediate deploy pairs an old
client with un-stripped deliveries or lights the pending-changes banner for content the UI
can't yet show.

1. **shared + backend: lazy reads.** `listTree`, `readFilesAtCommit`, `TreeNode`,
   `FileAtCommit`, use-role denials, `WorkspaceGitCache.readCommitTree` and
   `readFilesAtCommit` with the extracted batch-fault helper (grep adopts it). Additive.
   Workerd tests: `listTree` nesting and all five kinds against a real-git fixture tree
   (git order preserved; `@validateRpc` compiles the recursive type), `absent` for
   missing/dir paths,
   `unreadable` for symlink/submodule/binary/oversized, one pull per batch (counted on a
   mock gatekeeper), per-oid too-large tolerance, byte-budget early stop, path cap, oid
   validation.
2. **backend: worktrees pin on first modification** (§2a) with `proposedChangeWorkpieceIds`
   still excluding worktrees (one line, removed in commit 7). Tests per §2a.
3. **frontend: move** the code-editor cluster to `features/code/` — `GadgetCodeInterface`,
   `FileSidebar`, `CodeEditor`, `CodeDiffEditor`, `diff/`, `otClient(.test)`,
   `getLanguage`, `codeTheme` (trim the set in review). Import-path edits only.
4. **frontend: sparse OT client + file store** (§3, §4) with unit tests. Gadgets switch to
   `listTree`/`readFilesAtCommit` here; `getCodeAtCommit` loses its last caller. Worktree
   deliveries are still stripped, so nothing worktree-related is visible yet.
5. **frontend: file browser + `WorkpieceCodeInterface` + picker/tabs + preview fetch**
   (§5). Gadgets move onto the tree browser here — a visible change to the gadget Code
   tab; review screenshots. Still no worktree data arrives. Also lands the
   `WorkpieceSummary` union in `workshop-shared` (type and docs only — the backend keeps
   publishing gadgets alone until commit 7), since the picker/tab/code-interface branches
   on `type === "worktree"` cannot type-check without it. The tree derivation
   (`workpieceTree.ts`: base tree ⊕ overlay, statuses) is pure and unit-tested; the
   browser sorts each directory subdirectories-first then by name, renames edit the leaf
   name within its directory, and the old "dim every unchanged file in diff mode" styling
   is dropped in favour of the Changes section. `flattenTreePaths` (commit 4) is removed,
   superseded by `browserTreePaths` over the displayed tree.
6. **frontend: rename** `GadgetCodeInterface` → `WorkpieceCodeInterface` (if not folded into
   3; rename-only commit).
7. **shared + backend: turn on.** `subscribeToWorkpieces` publishing worktrees (the
   `WorkpieceSummary` union itself landed in 5), deletion of the strip helpers / `deadWorktreeIds` / call sites,
   deletion of `getCodeAtCommit`, `proposedChangeWorkpieceIds` exclusion removed, preview
   throw removed, doc updates. Tests: invert the first plan's leak test (a client
   subscription *does* receive worktree rows, pins, messages, gapless revisions); summary
   delivery and re-delivery on `pinBase`/`headCommit` advance; use-role exclusion; preview
   events for worktree targets; `proposedChangeWorkpieces` with worktrees.
8. **frontend: polish.** Transcript "open worktree" card, header details, expanded-state
   persistence, mobile pass.

## Open questions

1. **Reopen pinning (§2a, recommended) or add a touched-marker instead?** The refactor is
   the honest fix and deletes machinery; the marker touches fewer settled lines.
2. **Trim `WorktreeSummary`** to `{…, pinBase}` only, or keep `headCommit`/`baseCommit`
   for the header?
3. **Move set for commit 3** — the whole editor cluster, or only the files this plan
   substantially reworks (`GadgetCodeInterface`, `FileSidebar`, `otClient`)?

## Punted / future work

- File-name search over the delivered tree (the reason the tree is whole).
- A `WorktreeClient` capability for UI operations: `commit(message)`, push via gatekeeper
  action, commit log (`getCommitLog(headCommit)` exists), branch display; choosing a
  review base from the log.
- Reverts cancelling queued gatekeeper actions (so rejecting a pushed commit un-queues the
  push).
- Repository search (grep) from the UI — `#grepFiles` is the server half.
- Mode-preserving rename (and mode changes generally): `CodeChange` needs a way to carry
  a tree-entry mode, after which rename of executables can be re-enabled in the browser
  and offered in the agent's `Worktree` API.
- Virtualized tree rows; `listTree` deltas or caps for very large repositories.
- Workspace-scoped / cross-chat worktrees; binary and >1 MiB file viewing.
