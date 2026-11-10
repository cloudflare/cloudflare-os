# Plan: Syncing worktree replicas as Git trees, within a step

Status: implemented on the `ddr/split-worktree-replicas` branch, in the five commits under
[Commits](#commits), with the deviations listed under
[Implementation notes](#implementation-notes).
[`docs/worktree-replicas.md`](../docs/worktree-replicas.md) describes the design as built: the
API, the container's command sequence, what `snapshot()` and `submit()` do, re-rooting the
chat's pin, and the Git transport. The API is `packages/workshop-shared/src/worktree-replica.ts`.
This record keeps what the docs don't: why the design is this way, the decisions behind it, how
the kernel implements it, and how it was tested. Builds on
[`plans/step-transactionality.md`](step-transactionality.md).

## Goal

A container gatekeeper mounts a worktree and runs short commands against it: tests, linters,
formatters, auto-fixers. Those commands' file edits must flow back to the workspace, and the
workspace's edits must reach the container before each command. Some of those commands run Git
themselves (for example `packages/integration-tests/scripts/build-upgrade-base.ts` runs
`git fetch --depth=1 origin <UPGRADE_BASE>`), so the container's `origin` must answer whatever
mix of workspace and remote history they ask for.

## Alternative considered: a live sync protocol

An earlier design on this branch streamed edits both ways as OTs, through persistent sync
sessions with subscribers, and saved each batch a command submitted at once. That broke step
transactionality, the rule that a step's effects are saved if and only if its transcript is.
Consider a crash mid-command:

- The command's edits so far are saved, but the `executeCode` call that made them is not.
- The resumed turn replays the log and asks the model again. The early "changes" message is
  agent-authored, so replay applies it without telling the model.
- The model most likely runs the same command again, on top of the half-applied edits. The old
  command may also still be running in the container, and its later batches land either as
  *user* edits or folded into the new step.

An agent can't sensibly recover from a half-finished command, and the commands this is for can
easily be re-run. Throwing the partial edits away and running the command again is simpler and
more correct, and it needs none of the machinery saving them early took (an early flush of the
step's buffer, per-tool-call persistence flags, durable subscriptions with alarm-driven retry,
durable batch receipts).

## Principles

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
  changes. The native Git operations relied on (fetching a bare tree by ID, packing with
  `rev-list` between two trees, the two-way `read-tree`) were checked against Git 2.53.
- **A submission moves the chat's pin; it isn't turned back into OTs.** The submitted (or merged)
  tree becomes a hidden commit, and the chat's pin for the worktree re-roots at it, as
  `updateChatFromMainline` re-roots a gadget's pin at a merge commit. File modes and binary files
  then need nothing special: the tree carries them.
- **The clone is cut where the history reaches a connected repository.** Everything below that
  boundary is on the remote, so once the container has the head, any further history it asks
  for is purely remote and can be proxied whole, with no request served half locally and half
  remotely.

## Kernel implementation

The docs describe the behaviour; these are the mechanisms behind it.

- **`snapshot()`** builds its tree with `WorkspaceGitCache.writeChangedTree`, the tree half of the
  binding's `commit()`, from the chat pin's `baseCommit` plus the chat's pending edits plus the
  step's buffered edits (`worktreeChanges` in `worktree-session.ts`). It requires an entry in
  `#activeExecutions` for the chat, and remembers the tree on that execution for `gitPull()`.
- **`submit()`** ingests the pack through the same path as a gatekeeper's pack
  (`consumePackFromGatekeeper`, with no gatekeeper), diffs only subtrees whose IDs differ
  (faulting in remote trees as reads do), and merges with `threeWayMerge`. Everything until the
  re-root awaits, during which the agent's code can write through the binding or the execution
  can end. So it reads the turn's edit counter (`WorktreeTurnAccess.getRevision`) with the
  current tree, and in one synchronous block just before the re-root checks it again and checks
  `isLiveExecution()`; if the counter moved it merges again, and if the execution ended it fails.
  Conflicted paths are recorded on the execution, and the `executeCode` result reports them.
- **The re-root** is `WorktreeTurnAccess.reRoot`. It strips the worktree's edits from the step's
  buffer and records the commit in `step.reRoots`, which `commitAgentStep` declares as a pin in
  the step's "changes" message, with a destructive generation bump, as `updateChatFromMainline`
  does. Replay drops the worktree's accumulated content when it applies a re-root pin. The
  file-tool guard (`assertNoExecutedChanges`) refuses later file tools and `executeCode` in the
  step.
- **Accepting** builds the worktree's accepted content on the pin's `baseCommit` tree, applying
  only the paths touched after the last re-root (`#worktreeTouchedPaths` resets at each pin
  declaration), and keeps the old `pinBase` as the commit's parent.
- **Hidden commits stay reachable:** `git-cache.ts` lists pin declarations in chat logs as roots
  for the future garbage collection.

## Git fetches

`ReplicableWorktree.gitPull()` is `worktreeGitPull` in
`packages/workshop-backend/src/worktree-git.ts`, fed by the overseer's `worktreeGitPull` and
`#remoteHistoryBoundaries`. It takes the same structured arguments as `Gatekeeper.gitPull()`
(less `type` and `referencedBy`, which a native client doesn't know) and returns a
`GitPullTransfer`. Native Git's smart HTTP is translated by gatekeeper-kit's
`serveGitUploadPack()` in the container gatekeeper, so the kernel parses no Git protocol.

### Policy

Mounting a worktree permits fetching the entire history of its head commit. Commit IDs hash
their whole history, so when several connections can provide part of it, it doesn't matter which
one serves it.

- A worktree is not tied to a remote; its head is often a commit no remote has. Its remote
  history begins at the *boundary*: walking back from the head through locally stored commits,
  the first commits with recorded provenance (`gitObjectMetadata.onRemote`/`pullableFrom` naming
  a live connection).
- Whether a remote commit is in the head's history is decided by asking a connection that has
  boundary commits: a commit-only fetch (`filter tree:0`) of the wanted commits with a `have` per
  boundary commit. An empty pack means yes. The answer is trusted, since the data it protects is
  the connection's own repository. A "no" moves on to the next connection; the fetch is refused
  only if some connection answered and none confirmed.
- Nothing is looked up in the agent's environment. Other refs of the origin (e.g. `main`) and
  other repositories are out of scope; if they are needed later, the agent should pass them to
  the gatekeeper as objects.

### RPC shape

`Gatekeeper.gitPull(oids, hints): Promise<GitPullTransfer>` keeps main's structured shape, and
providers keep implementing it with `startGitPull`: the kit turns the hints into the protocol-v2
request, so a provider still only adds its credentials and POSTs to its `git-upload-pack`. The
GitHub and GitLab gatekeepers are unchanged. `GitPullHints` gains:

- `haves`: commits the requester has, so the remote leaves out their history. Packs stay
  self-contained, since the kit never asks for thin packs. Cache fills still send none.
- `shallow`: the requester's shallow boundary, which the remote needs to answer a deepen.
- `commitHistory: {kind: "relative", depth}`, for `--deepen=N`.
- `GitPullTransfer.shallowInfo()`, beside `status()`: the response's `shallow`/`unshallow`
  lines, which a proxied fetch must pass on but the raw pack doesn't carry. The kit reads them
  (`openGitFetchResponse`) without consuming pack data.

The ancestry probe is an ordinary `gitPull(wants, {type: "commit", commitHistory: {kind: "full"},
filterTreeDepth: 0, haves: boundaries})` whose pack header the kernel inspects.

### Request handling

`serveGitUploadPack()` parses each request. Ref discovery and `ls-refs` come from `gitHead()`.
For `fetch` it extracts the fields the hints can express (`want`, `have`, `shallow`, `deepen`,
`deepen-since`, `deepen-relative`, `filter` as `blob:none`, `blob:limit=<n>` or `tree:0`, `done`,
and harmless arguments such as `ofs-delta`, `thin-pack`, `no-progress` and `include-tag`) and
refuses anything else. The kernel checks the hints' object IDs and depths, and an upstream request
is always re-encoded from them: never the container's own bytes.

A fetch is classified by what the container lacks, not by its `want` lines. For example,
`git fetch --deepen=N` sends `want <head>`, `have <head>`, `shallow <boundary>` and `deepen N`:
the head is local, but the container already has it, and what it lacks is purely remote. A
deepen reaches past the boundary if it is relative, if its depth exceeds the boundary's depth
from the wanted commits, or if its date is no later than the boundary's commit time. Negotiation
takes one round: the helper answers a request without `done` at once with `ready` and the pack.

Then the fetch is served locally (with the boundary commits at depth 1 from one connection),
proxied whole to a connection that confirmed the wanted commits, or refused if it needs both;
the docs give the exact rules.

### Why spanning requests need storage

A pack can't contain the same object twice: native Git rejects it ("The same object %s appears
twice in the pack"). Pack entries carry content, not object IDs; an ID is the hash of the full
object, and an entry may be a delta against an earlier one, so learning a proxied pack's IDs
means decoding it and keeping delta bases around. Workspace-created trees and blobs can coincide
with remote ones (a reverted file, an unchanged subdirectory), so a local half and a proxied
remote half can't be merged blindly. This is also why the local half of a clone leaves out every
object in the boundary commits' trees, matching by content rather than path.

Protocol v2's `packfile-uris` does allow several packs in one fetch, with duplicates across
packs. But each URI line carries the pack's checksum and comes before the client downloads
anything, and the kernel can't know a proxied pack's checksum until it has streamed through.

Serving a spanning request would therefore mean filling the workspace's Git cache from the
remote first. That was built (formerly commit `2ea4bfb0`, kept on `backup/git-pull-cache-fill`)
and dropped: with the clone cut at the boundary, a spanning request needs the head to move while
a command runs Git, and fetching the head first avoids it.

## Decisions

1. **Concurrent edits are merged**, with three-way conflict markers on conflicts, using the
   existing `threeWayMerge`. The `executeCode` result flags the conflicts. They can only come
   from the same execution: user edits are rejected while an agent turn runs, and tool calls run
   one at a time.
2. **Snapshot trees are stored in the Git cache, with no other stored record.** A future garbage
   collection of unreachable objects cleans up those that never became a hidden commit. The
   execution remembers its trees in memory only, for authorization.
3. **Tool calls run one at a time** (`toolExecution: "sequential"` in `runAgentPass`), so two
   `executeCode` calls never overlap. Parallel work belongs in one `executeCode` call that starts
   several operations and awaits them.
4. **`pinBase` stays a commit.** Turning it into a tree is a separate refactor.
5. **A submission re-roots the chat's pin at a hidden commit** of the result tree, instead of
   being converted into OTs. File modes survive: later edits keep an entry's mode
   (`WorkspaceGitCache.writeChangedTree`), and so does accepting.
6. **A command's handle lives in memory, bound to its execution, and accepts one submission.**
   This fences out a command abandoned by a restart, which could otherwise submit against the
   resumed execution's first snapshot (usually the same tree ID, since the crash rolled the
   edits back). An identical retry returns the first result, so a lost reply never merges twice.
7. **Spanning requests are refused**, not served by a cache fill (see
   [Why spanning requests need storage](#why-spanning-requests-need-storage)).

## Open questions

Re-rooting a worktree's pin mid-epoch was new. These needed checking during implementation; 1 to
5 were settled in `560403c4`, and symlinks and submodules (6) stay refused:

1. **The `baseCommit === pinBase` invariant.** `WorktreeRecord.pinBase`'s docs said a worktree's
   chat pin always has `baseCommit === pinBase`, and that moving it mid-epoch would double-apply
   live rows on replay. A re-root keeps `mergedCommit === pinBase` instead, and absorbs the
   step's rows. Every use of `pinBase` needed auditing: about 29 in `overseer.ts`, 3 in
   `agent.ts`, and the frontend's `otClient.ts` and `WorkpieceCodeInterface.tsx`.
2. **Replay.** For a worktree, `applyReplayedPin` kept the accumulated session content when a
   pin was re-established, on the grounds that it is all base-derived. After a re-root it isn't,
   so replay must drop that worktree's session content and forget which of its files were read.
   Replay must also not re-apply the absorbed tool calls' edits.
3. **Re-root pins in agent steps.** An agent step's pins were only first-touch pins, checked
   against the gadget's current head. `commitAgentStep` needed a re-root kind, with the
   generation bump.
4. **The frontend.** It must read a worktree's chat content from the pin's `baseCommit` and
   review it against `mergedCommit`, as it does for re-rooted gadget pins.
5. **Reverting** a step that re-rooted, as reverts already handle `updateChatFromMainline`'s
   re-roots.
6. **Symlinks and submodules.** The hidden commit could carry them as it carries modes. They stay
   refused until the file tools' handling of them is checked.

## Implementation notes

Where the implementation departed from the design as first reviewed:

- **The stored stub** (`926b2352`). What agent code passes on is the binding loopback, which
  used to fail once its execution ended. Every call through it now resolves to the
  `WorktreeEndpoint` of the execution that minted it: its file methods still work only during
  that execution, while `gitPull()` works at any time and `snapshot()` serves whichever execution
  is running in the chat. So a stub the agent passes to a gadget also keeps replica access.
- **Object check on submit** (`926b2352`). Rather than every object reachable from the submitted
  tree but not the snapshot's, each object at a path where they differ must be stored or
  pullable, so a command can move a file the workspace never loaded. Submitted trees must also
  be canonical, which rejects names such as `..` and `sub/.git`.
- **Retries** (`926b2352`). A failed submission frees its handle for a retry, and every call,
  retries included, requires the execution to still be running.
- **Merging** (`926b2352`). A mode merges on its own, so one command's `chmod` survives another's
  edit (a binary file still takes the command's bytes), and merged changes are written deletions
  first, so a file replaced by a directory on one side alone isn't refused.
- **Re-root** (`560403c4`). A re-rooting step writes no chat change rows: its changes are
  composed into its "changes" message. `executeCode` is refused after a re-root in the same
  step, as well as the file tools (`readFile`, `grep`, `writeFile`, `editFile`).
- **The boundary** (`d7cfef5a`). The boundary is the union of the connections' boundary commits,
  and the clone's shallow lines are the connection's own. A boundary tree the workspace lacks is
  fetched blob-less a level at a time. The refusal is narrower than "needs both": a fetch needing
  workspace commits is refused only with remote wants, or with history beyond the boundary when
  the client has some of the history. An absolute depth over several boundary commits is rebased
  on the nearest.
- **Snapshot tree fetches** (`926b2352`, `d7cfef5a`) must want only snapshot trees, and for a
  worktree from a connected repository need a `have` in the history.

## Commits

Each commit keeps the backend separate from tests and docs where it can, for kernel review.

1. **Remove the live sync protocol** that this plan replaces, leaving only `gitPull`, so a mount
   is read-only for one commit. It brings `agent.ts` back to main.
2. **Re-root a worktree's chat pin in an agent step.** The riskiest kernel change, on its own:
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
5. **Docs.** Rewrite `docs/worktree-replicas.md`: the scenarios, the container's command
   sequence, what the kernel does, and the Git transport.

## Testing

- **`__tests__/worktree-reroot.test.ts`** drives `reRoot` from a stand-in for `executeCodeMode`:
  live reads and the declared pin, the destructive generation bump, replay, reloads and
  restarts, loss before the barrier, reverting, reads overtaken by a re-root, accepting (the
  content kept on the old `pinBase`, only paths touched after the last re-root, executable
  bits), and the file-tool guard.
- **`__tests__/worktree-replica.test.ts`** covers commands (refused outside an execution, saved
  with the step's transcript or lost before its barrier, tree fetches only during the execution,
  stored stubs, retries, parallel submissions and writes, mode merging, an execution ending
  mid-submission, stale handles, file-versus-directory refusals, symlinks, `.git` entries and
  missing objects) and fetches (the pull's checks, the ancestry probe and its fallback to the
  next connection, deepens, the boundary pull from one connection, shallower clones, the
  spanning refusal, and refusal after deletion). Access is checked when a pull starts; a pack
  already streaming is not cut off when access ends.
- **`__tests__/native/worktree-git.test.ts`** runs native Git against workerd with a real
  `git upload-pack` upstream (`uploadpack.allowFilter` on, as GitHub and GitLab have): a clone
  shallow at a pushed commit then deepened, a clone with a merged-in second boundary, and the
  full container command sequence, including a checkout left dirty by an interrupted command.
- **Kit tests** cover the new hint encodings and capturing shallow information.
