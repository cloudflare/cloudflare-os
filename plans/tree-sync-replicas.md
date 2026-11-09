# Plan: Syncing worktree replicas as Git trees, within a step

Status: proposed, not implemented. Replaces the live sync protocol on the
`ddr/split-worktree-replicas` branch (sync sessions, subscribers, revisions and OT delivery to
the container). The proposed API is drafted on the branch `wip/tree-sync-api-draft`, as a
rewrite of `packages/workshop-shared/src/worktree-replica.ts`, to land with commit 3 (see
[Commits](#commits)).
Builds on [`plans/step-transactionality.md`](step-transactionality.md) and
[`plans/git-proxy.md`](git-proxy.md).

## Goal

A container gatekeeper mounts a worktree and runs short commands against it: tests, linters,
formatters, auto-fixers. Those commands' file edits must flow back to the workspace, and
the workspace's edits must reach the container before each command.

The branch currently does this with a persistent, live protocol. That protocol breaks step
transactionality, the rule that a step's effects are saved if and only if its transcript is.

## Why the current design has to change

Today, each `submitChanges()` batch is saved at once, through `flushReplica`. That also saves the
step's other buffered edits early, before the step's transcript. Consider a crash mid-command:

- The command's edits so far are saved, but the `executeCode` call that made them is not.
- The resumed turn replays the log and asks the model again. The early "changes" message is
  agent-authored, so replay applies it without telling the model.
- The model most likely runs the same command again, on top of the half-applied edits. The old
  command may also still be running in the container. Its later batches are saved either as
  *user* edits (if they arrive before the resumed turn registers) or folded into the new step.

An agent can't sensibly recover from a half-finished command, and the commands this is for can
easily be re-run. Throwing the partial edits away and running the command again is both simpler
and more correct. Keeping the edits also costs a lot of kernel code:
- `flushReplica`, and `AiToolCall.effectsPersisted`.
- The `output` fields on `readFile`, `writeFile` and `editFile`.
- `AgentStepChange.toolCallId`, `earlyFileFlush` and `stepFileReads`.
- `registerWorktreeReplicaTurn` and `reloadForReplica`.
- Durable subscriptions with alarm-driven retry, and durable batch receipts.

## Design

### Principles

- **Step transactionality holds.** A command's edits join the running step's buffer, and are
  saved with its transcript or lost with it.
- **Sync happens only during an `executeCode` call.** Background commands are not supported for
  now. The Worktree stub stays persistent, so a container can mount in one turn and run
  commands in later turns, across Durable Object restarts.
- **The unit of sync is a Git tree.** A hidden commit's metadata would mean nothing. Trees are
  content-addressed, so the container knows its files match the workspace's exactly when the
  tree IDs match. That holds across DO restarts, so a container never replays a history of
  edits; at worst it checks out a newer tree incrementally.
- **The container needs only stock Git.** It runs no OT engine. Merging, where there is any,
  happens in the kernel, with the three-way merge it already uses for accepting a chat's
  changes.
- **A submission moves the chat's pin; it isn't turned back into OTs.** The submitted (or merged)
  tree becomes a hidden commit, and the chat's pin for the worktree re-roots at it, as
  `updateChatFromMainline` re-roots a gadget's pin at a merge commit. File modes and binary files
  then need nothing special: the tree carries them.

### API

On the persistent Worktree stub (`ReplicableWorktree`):

```ts
interface WorktreeState {
  tree: GitOid;         // the worktree's current files, including uncommitted edits
  head: GitOid | null;  // the worktree's Git head
}
interface WorktreeSnapshot extends WorktreeState {
  command: RpcStub<WorktreeCommand>;  // submits this command's result
}
interface WorktreeCommand extends RpcTarget {
  submit(tree: GitOid, pack: ReadableStream<Uint8Array>): Promise<WorktreeState>;
}
interface ReplicableWorktree {
  snapshot(): Promise<WorktreeSnapshot>;
  gitPull(request: Request): Promise<Response>;
}
```

- **`snapshot()` requires a running `executeCode` call** in the worktree's chat.
- **`WorktreeCommand` is an in-memory handle, bound to that execution.** Its `from` is implicit:
  the snapshot's tree. It stops working when the execution ends, and a Durable Object restart
  breaks it outright. That fences out an abandoned command. Without the handle, a command left
  running across a restart could submit against the resumed execution's first snapshot, which
  usually has the same tree ID, because the crash rolled the edits back.
- **A handle accepts one submission.** Calling `submit()` again with the same tree returns the
  first result, and any other tree is refused. A retry after a lost reply therefore never merges
  twice; an identical retry of a merge would otherwise nest the conflict markers.
- **`gitPull()` works at any time.**
- **Removed:** `WorktreeSyncSession`, `WorktreeSubscriber`, `WorktreeSubscription`,
  `WorktreeRevision` and `FileChangeByPath`.

### A command, from the container's side

1. **Snapshot.** Call `snapshot()`.
   - If `head` changed, fetch it (`git fetch origin`).
   - Compute the tree of the files as they actually are, with the private index (`git add -A`,
     then `git write-tree`), not the tree last synced. They differ when a command was cut off,
     for example by a restart. If the actual tree differs from the snapshot's, fetch the
     snapshot's tree (`git fetch origin <tree>`) and update the files with
     `GIT_INDEX_FILE=<private index> git read-tree -m -u <actual tree> <tree>`. That also
     removes files an interrupted command created.
   - Reset the real index and HEAD to `head` (`git reset --mixed <head>`), so `git status` shows
     the uncommitted changes as the workspace would.
2. **Run** the command.
3. **Submit.** Build a tree of the files with the private index (`git add -A`, then
   `git write-tree`). Using `git add -A` keeps ignored files (`node_modules`, build output) out.
   - If the tree equals the snapshot's, there is nothing to submit.
   - Otherwise call `command.submit(tree, pack)` on the snapshot's handle, where `pack` is
     `git rev-list --objects <tree> ^<snapshot tree> | git pack-objects --stdout`.
   - If the returned tree differs from the submitted one, the workspace merged in concurrent
     edits. Check it out as in step 1.

Two commands in one `executeCode` call (format, then lint) need nothing extra: the second
snapshot's tree equals the first submission's result, so step 1 does nothing.

A checkout runs one command at a time, from `snapshot()` through the final checkout after
`submit()`. Otherwise one command's snapshot checkout can overwrite files another command is
still writing, before that one submits, and serializing submissions in the kernel can't recover
them. Commands that run in parallel need separate checkouts.

If the connection to the workspace drops while a command runs, the execution is gone. The
gatekeeper should stop the command and everything it started, rather than let it keep writing
files; the next command's step 1 then restores them.

These native Git operations were checked against Git 2.53: fetching a bare tree by ID, packing
with `rev-list` between two trees, and the two-way `read-tree`.

Initial setup is `git clone` of the made-up remote URL. The clone is shallow when the worktree
came from a connected repository (see below), so no special flags are needed.

### Kernel: `snapshot()`

- **Require a running execution.** Fail unless `#activeExecutions` has one for the worktree's
  chat.
- **Build the tree** of the worktree's current files. That is the chat pin's base commit (the
  accepted commit, or the last re-root) plus the chat's pending edits plus the running step's
  buffered edits to this worktree, which is what the Worktree binding's `readFile` already
  sees.
  - Use `GitStore.writeChangedTree`
    ([git-store.ts:393](../packages/workshop-backend/src/git-store.ts)), the tree half of the
    binding's `commit()`.
  - Only the changed directories' trees are new. For a worktree from a connected repository,
    the unchanged subtrees keep their remote IDs.
- **Store the tree** in the Git cache like any other object. Nothing else about it is stored:
  a later garbage collection of unreachable cache objects will clean up snapshot trees that no
  submission turned into a hidden commit. (Hidden commits stay reachable; see the re-root
  section.)
- **Remember the tree in memory** for the running execution. Only those trees can be fetched
  with `gitPull()`, since the Durable Object's Git cache holds other worktrees' objects too.
- **Return a `WorktreeCommand` handle** bound to the execution and to this tree as `from`.

### Kernel: `submit()`

1. **Check the request.** Require the handle's execution to still be the running one. If the
   handle already accepted a submission, return its result for the same tree and refuse any
   other.
   - Run submissions for one worktree one at a time.
2. **Ingest `pack`** into the Git cache with its usual object and size limits, as the gatekeeper
   pack ingestion (`consumePackFromGatekeeper`) does. Check that every object reachable from
   `tree` but not from `from` is now stored.
3. **Find the changed paths.** Diff `from` against `tree`, and `from` against the worktree's
   current tree (a new snapshot). Only descend into subtrees whose IDs differ. A differing
   subtree on the `from` side may be a remote tree the cache doesn't hold; fault it in, as reads
   do. Refuse `.git` entries, symlinks and submodules, as the file tools do.
4. **Merge.** If no path changed on both sides, the result is simply the submitted content for
   the paths the command changed. Otherwise run `threeWayMerge`
   ([git-store.ts:652](../packages/workshop-backend/src/git-store.ts)) on just the changed paths,
   with `from` as the base, the current files as one side and the submitted files as the other.
   - Concurrent edits can only come from the same execution: user edits are rejected while an
     agent turn runs (`plans/step-transactionality.md`), and tool calls run one at a time. So
     this is the agent's code writing through the Worktree binding while a command runs, or two
     commands on the same worktree in parallel.
   - Conflicting hunks get diff3-style conflict markers, and a file deleted on one side and
     changed on the other keeps the changed content. Both are reported as conflicts.
   - `threeWayMerge` handles text only. A binary file changed on both sides keeps the command's
     version and is reported as a conflict.
   - `threeWayMerge` works path by path, so it can return both a file `a` and a file `a/b`, for
     example when the command replaced a file with a directory while the agent's code edited
     the file. No tree can hold both, so refuse the submission with an error saying to run the
     command again. It needs concurrent edits plus a type change, so it is very rare.
5. **Re-root the chat's pin.** Write the result tree (the submitted tree, or the merge of it) as a
   hidden commit whose parent is the chat pin's current base commit. Buffer, in the running
   step, a re-root of the chat's pin for this worktree at that commit (see below). Nothing is
   converted to `FileChange`s.
   - Steps 2 to 5 await, and the agent's code can write through the Worktree binding during
     those awaits. So read the turn's edit counter (`WorktreeTurnAccess.getRevision`) when
     reading the current tree in step 3, and check it again just before installing the re-root,
     in the same synchronous block. If it moved, redo steps 3 to 5 against the new current
     files.
   - The execution can also end during those awaits, without the edit counter moving. So the
     same synchronous block checks again that the handle's execution is still running
     (`isLiveExecution()`), and fails the submission if not. Otherwise a late re-root would
     land in the turn's state after its tool call had finished.
6. **Report conflicts to the agent.** Record the conflicted paths on the running execution. The
   `executeCode` tool result then says which files were merged with conflicts, so the agent
   resolves them before continuing.
7. **Return the resulting tree and head.** The tree is remembered as in `snapshot()`, so the
   container can fetch it. Record the result on the handle, for retries.

The re-root is attributed to the agent step that ran the command, and is saved at that step's
barrier, together with its transcript.

### Kernel: re-rooting the chat's pin

A chat pin for a gadget already has two commits (`ChatGadgetPinState`):
- **`baseCommit`:** what the chat's content builds on, and what its OT rows compose on.
- **`mergedCommit`:** the accepted commit the chat's changes are reviewed and accepted against.

`updateChatFromMainline` moves `baseCommit` to a synthesized merge commit mid-chat, and keeps
`mergedCommit` at the head it merged. A submission does the same for a worktree:

- **`baseCommit` moves to the hidden commit.** The worktree record's `pinBase` and the pin's
  `mergedCommit` stay at the accepted commit. Moving `pinBase` would accept the chat's changes
  without review; keeping it means the user still reviews everything the chat changed, the
  command's edits included, as a diff against the accepted commit.
- **The re-root absorbs the step's earlier edits to this worktree.** They are already in the
  submitted tree, since the snapshot included them. They leave the step's buffer, and edits later
  in the step compose on the new base. Several submissions in one step chain their hidden
  commits; only the last one is declared.
- **At the barrier,** the step's "changes" message declares the re-root as a pin, which replay
  applies before the message's change. As in `updateChatFromMainline`, the content changed
  without OTs, so the barrier bumps the chat's code-base generation and clients rebuild from the
  log.
- **Replay of later file tools in the same step.** Live, a `readFile` after a submission in the
  same step sees the re-rooted content. On replay, `executeCode` re-runs nothing, so the read
  would see the old content. (The same already happens on main for writes the agent's code makes
  through the Worktree binding.) Recording read outputs would bring back the `output` fields
  this plan deletes. Instead, extend the existing `executeCode` guard the other way: a file tool
  refuses to run after an `executeCode` call earlier in the same step changed files, and tells
  the model to call it in its next step. All of a step's tool calls are issued before any of
  them runs, so such a call was made without seeing the command's result anyway.
- **On accept,** today's epoch reset (`overseer.ts:4083`) rebuilds a worktree's accepted content
  by applying the paths the epoch's OT edits touched on top of `record.pinBase`. A re-root
  touches no paths, so its content would be lost. Instead, build on the pin's `baseCommit` tree,
  applying only the paths touched after the last re-root; paths touched before it are already
  in that tree. The resulting auto-commit keeps the old `pinBase` as its parent, as it already
  does, so the hidden commits never appear in the worktree's history.
- **The hidden commits stay in the Git cache.** The changes messages name them in their pin
  declarations, and replay rebuilds closed epochs from those. `git-store.ts:40` lists pin
  declarations in chat logs as roots for the future garbage collection. They are collected only
  if the history that names them goes away, for example when the chat is deleted.

### Kernel: `gitPull()` and the shallow boundary

Today the clone is cut off at `shallowCommit`, the commit the worktree was created at. Instead,
cut it at the history's *boundary*, as defined in `plans/git-proxy.md`. Walking back from the
head through locally stored commits, the boundary is the first commits with live provenance
(`#remoteHistoryBoundaries`). The clone holds every commit only the workspace has, plus the
boundary commits as shallow commits.

- **What this fixes.** Everything below the boundary is on the remote, since a commit a remote
  has comes with its whole history. So once the container has the current head, any further
  history it asks for (`--deepen`, `--unshallow`, `git fetch --depth=1 origin <sha>`) is purely
  remote and is proxied whole.
- **No hybrid requests are left.**
  - A request that still needs both workspace-only and remote objects is refused, with an error
    telling the container to fetch `head` first.
  - A `git clone --depth=N` deeper than the boundary is given less history, as any shallow
    server does. Stock Git accepts that.
  - The cache fill (formerly commit `2ea4bfb0`, kept on `backup/git-pull-cache-fill`) is
    dropped.
- **When the boundary differs from `shallowCommit`.**
  - *The agent pushed some of its commits:* the newest pushed commit becomes the boundary.
  - *The agent merged in a commit from a connected repository:* that commit becomes an extra
    boundary.
  - In the merge case, today's walk to `shallowCommit` follows the merged commit's parents,
    which aren't stored locally, and faults them in one object at a time. The boundary walk
    fixes that.
- **Streaming the boundary commits.** They come with their files at depth 1, in one request to
  one connection that has them all, so the pack doesn't duplicate the objects their trees
  share. If no single connection has every boundary commit, refuse rather than merge packs.
- **Leaving out the boundary's objects.** The local half must leave out every tree and blob ID
  reachable from any boundary commit's tree, because a pack can't contain the same object twice.
  That includes renamed, copied and reverted files, which match by content, not by path. This
  generalizes today's `excludeBase` from one commit to the union of the boundary.
  - A pushed workspace commit's trees are stored locally.
  - A merged remote commit's trees are fetched once with `filter blob:none` and cached as
    metadata, as is done for the created-at commit today.
- **Snapshot trees** are fetchable by ID, but only those remembered for the running execution
  (see `snapshot()`). A tree want
  is served from the local walk. Its unchanged subtrees and blobs are the head's, which the
  container already has, so its `have`s exclude them.

### What is removed

**Kernel:**
- The sync session machinery: `openWorktreeSync`, `submitWorktreeChanges`,
  `#flushWorktreeTurn`, `#syncRows` and `drainWorktreeSubscription`.
- The storage collections `worktreeSyncSessions`, `worktreeSyncSubscriptions` and
  `worktreeSyncCommits`, together with their alarm retry. Check whether deployed Durable
  Objects can hold records in them (the branch is unreleased, so probably not) before deciding
  whether existing records need cleaning up.
- From `runAgentPass`: `flushReplica`, `registerWorktreeReplicaTurn`, `reloadForReplica`,
  `earlyFileFlush`, `stepFileReads`, the `toolCallNotes` merging at the barrier, and
  `AgentStepChange.toolCallId`.
- In `commitAgentStep`: `replicaCommit` and `replicaAccess`.
- From `worktreeGitPull`: the `localHeads` and `pending` collection from subscription records.
  Snapshot trees and `head` replace it.

**Shared API:**
- `AiToolCall.effectsPersisted`, and the `output` fields on `readFile`, `writeFile` and
  `editFile`.
- Everything in `worktree-replica.ts` except `ReplicableWorktree.gitPull`, which stays and has
  its docs updated.

**Tests and fixtures:**
- The `ReplicaGitSource`/subscriber fixtures.
- `replica-transfer-worker.ts`.
- `test-gatekeeper.ts`'s subscriber.
- The replay tests for early flushes.

## Decisions

1. **Concurrent edits are merged**, with three-way conflict markers on conflicts, using the
   existing `threeWayMerge`. The `executeCode` result flags the conflicts (see `submit()`).
2. **Snapshot trees are stored in the Git cache, with no other stored record.** A future garbage
   collection of unreachable objects cleans up those that never became a hidden commit. The
   execution remembers its trees in memory only, for authorization.
3. **Tool calls run one at a time** (`toolExecution: "sequential"` in `runAgentPass`), so two
   `executeCode` calls never overlap. Parallel work belongs in one `executeCode` call that starts
   several operations and awaits them.
4. **`pinBase` stays a commit.** Turning it into a tree is a separate refactor.
5. **A submission re-roots the chat's pin at a hidden commit** of the result tree, instead of
   being converted into OTs. File modes survive: later edits keep an entry's mode
   (`GitStore.writeChangedTree`), and so does accepting.

## Open questions

Re-rooting a worktree's pin mid-epoch is new. These need checking during implementation:

1. **The `baseCommit === pinBase` invariant.** `WorktreeRecord.pinBase`'s docs say a worktree's
   chat pin always has `baseCommit === pinBase`, and that moving it mid-epoch would double-apply
   live rows on replay. A re-root keeps `mergedCommit === pinBase` instead, and absorbs the
   step's rows. Every use of `pinBase` needs auditing: about 29 in `overseer.ts`, 3 in
   `agent.ts`, and the frontend's `otClient.ts` and `WorkpieceCodeInterface.tsx`.
2. **Replay.** For a worktree, `applyReplayedPin` keeps the accumulated session content when a
   pin is re-established, on the grounds that it is all base-derived. After a re-root it isn't,
   so replay must drop that worktree's session content and forget which of its files were read.
   Replay must also not re-apply the absorbed tool calls' edits.
3. **Re-root pins in agent steps.** Today an agent step's pins are only first-touch pins,
   checked against the gadget's current head. `commitAgentStep` needs a re-root kind, with the
   generation bump.
4. **The frontend.** It must read a worktree's chat content from the pin's `baseCommit` and
   review it against `mergedCommit`, as it does for re-rooted gadget pins.
5. **Reverting** a step that re-rooted, as reverts already handle `updateChatFromMainline`'s
   re-roots.
6. **Symlinks and submodules.** The hidden commit could carry them as it carries modes. They stay
   refused until the file tools' handling of them is checked.

## Commits

Each commit keeps the backend separate from tests and docs where it can, for kernel review.

1. **Remove the live sync protocol.** Delete everything listed under
   [What is removed](#what-is-removed). That's the sync sessions, subscribers, receipts and
   subscription storage, the early-flush machinery, and `effectsPersisted` and the `output`
   fields. Only `gitPull` is left, so a mount is read-only: a container can clone and fetch but
   not write back. Nearly all deletions, and it brings `agent.ts` back close to main.
   - Deleting only the early-flush machinery would leave a half-design. It is what makes
     `submitChanges()` work during a turn. Without it, a submission mid-turn would either be
     refused, which is the only time commands run, or go into the step's buffer. In the buffer,
     revisions already delivered to the container would vanish on a crash, breaking the durable
     receipts and `subscribe(after)`.
2. **Re-root a worktree's chat pin in an agent step.** The riskiest kernel change, on its own
   (see [Kernel: re-rooting the chat's pin](#kernel-re-rooting-the-chats-pin)):
   - `commitAgentStep` accepts a re-root, which absorbs the step's earlier edits to the
     worktree, with the generation bump.
   - Replay drops the worktree's accumulated content after a re-root.
   - The `pinBase` invariant is audited, and its docs rewritten.
   - Accepting writes the worktree's commit with `pinBase` as its parent.
   - The frontend reads the pin's `baseCommit`.

   Nothing calls it yet, so its tests drive the hook directly.
3. **Add `snapshot()`/`submit()`** on top of commit 2, with the conflict note in the
   `executeCode` result.
4. **Shallow boundary at the remote boundary.** Serve the clone shallow at
   `#remoteHistoryBoundaries`, stream several boundary commits from one connection, leave out
   their union, serve snapshot trees, and refuse spanning requests.
5. **Docs.** Rewrite `docs/worktree-replicas.md`: the scenarios, initial capture and delivery,
   returning edits, and container responsibilities. Mark the superseded parts of
   `plans/git-proxy.md`.

## Testing

**Backend tests (`__tests__/worktree-replica.test.ts`):**
- `snapshot()`/`submit()` fail outside an execution.
- A snapshot includes the step's buffered binding writes.
- A submission's edits are saved with the step's transcript, and are lost when the step is
  aborted or the DO restarts before the barrier.
- A retried submission returns the first result without applying or merging again, including
  after a merge with conflicts; a second, different submission on one handle is refused.
- A handle from an earlier execution is refused, and so is one used after a DO restart.
- A submission whose execution ends while it is ingesting the pack installs nothing.
- Two submissions in parallel, and a binding write landing during a submission, keep everyone's
  edits.
- A file tool after an `executeCode` that changed files in the same step is refused.
- A file replaced by a directory, against a concurrent edit of the file, is refused.
- Concurrent binding writes during a command are merged, with conflict markers on overlapping
  hunks and the conflicts named in the `executeCode` result.
- Symlinks and `.git` entries are refused.
- A submission re-roots the chat's pin: replay, a reload, a revert of the step, and the user's
  review diff all show the command's edits, and an executable bit survives accepting.
- Accepting a chat whose only change to a worktree is a submission keeps the submitted content.
  The accepted commit's parent is the old `pinBase`, with no hidden commits in its history.

**Native Git against workerd (`__tests__/native/worktree-git.test.ts`):**
- The full container sequence: clone, snapshot, `read-tree` checkout, edit, `write-tree`, pack,
  submit, and a second command with no transfer.
- A container left dirty by an interrupted command, including a new untracked file, is restored
  by the next snapshot's checkout.
- A clone shallow at a pushed commit.
- A clone with two boundary commits from a merge.
- A `--deepen` after the clone, proxied whole.
- A spanning request, refused.
- A `--depth` clone deeper than the boundary, served shallower.
