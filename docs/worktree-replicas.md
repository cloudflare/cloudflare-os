# Worktree replicas

Some tools need a worktree's files on a real filesystem. The motivating case is a container
gatekeeper that runs commands like `pnpm test` or `prettier --write .` against a repository the
agent is editing, including the agent's not-yet-accepted edits. Such a gatekeeper keeps a
*replica*: a copy of the worktree's files in a Git repository of its own.

The workspace is always the source of truth. A replica syncs with it only at the edges of a
command, and the unit of sync is a Git tree. Trees are content-addressed, so a replica's files
match the workspace's exactly when the tree IDs match.

The kernel knows the worktree, its Git history and the chat's edits, and hands out a handle for
each command that is bound to the agent's running `executeCode` call. It knows nothing about
containers, guest paths, mount names, processes or command approvals. The container gatekeeper
owns those, for example as `mountWorktree(worktree, mountName)` and `exec(command, options)`, with
the mount at `/workspace/<mountName>` in the guest.

The design record, including the Git fetch policy, is
[`plans/tree-sync-replicas.md`](../plans/tree-sync-replicas.md). The kernel code is
`packages/workshop-backend/src/worktree-replica.ts` (snapshots and submissions) and
`packages/workshop-backend/src/worktree-git.ts` (`gitPull`). Native Git's smart-HTTP requests
are translated into `gitHead()` and `gitPull()` calls by gatekeeper-kit's `serveGitUploadPack()`
(`packages/gatekeeper-kit/src/git-upload-pack.ts`), in the container gatekeeper.

## Scenarios

- Clone a worktree from a connected repository, with the workspace's own commits on top,
  without loading the repository's files into the workspace.
- Clone a scratch worktree, including uploaded text and binary attachments.
- Run a test suite against the agent's uncommitted edits.
- Run a formatter or auto-fixer, and have its edits join the agent's step like the agent's own,
  for the user to review.
- Let a build run `git fetch --depth=1 origin <UPGRADE_BASE>` after mounting. The Cloudflare OS
  integration harness does this in `packages/integration-tests/scripts/build-upgrade-base.ts`.
- Mount once, and run commands in later turns, after the workspace has restarted.

## Step transactionality

A step's effects are saved if and only if its transcript is
([`plans/step-transactionality.md`](../plans/step-transactionality.md)). A command's edits obey
that rule: they become part of the agent step whose `executeCode` call ran the command, are saved
with its transcript, and are lost with it if the step never completes (for example because the
workspace restarted mid-command). An agent therefore never resumes on top of a half-finished
command; the model simply runs it again.

It follows that syncing happens only while an agent's `executeCode` call is running in the
worktree's chat. Background commands are not supported.

## API

The Worktree stub that agent code passes on (`env.REPO`) has one replica method,
`getReplicator()`, alongside the ordinary file methods. It returns the `WorktreeReplicator` the
gatekeeper keeps. Both are defined in
[`packages/workshop-shared/src/worktree-replica.ts`](../packages/workshop-shared/src/worktree-replica.ts),
which documents each method. The agent's description of the Worktree API omits `getReplicator()`,
since agents don't need it; that is for discoverability, not authorization.

```ts
interface WorktreeState {
  tree: GitOid;  // the worktree's current files, uncommitted edits included
  head: GitOid;  // the worktree's Git head (its latest explicit commit)
}
interface WorktreeSnapshot extends WorktreeState {
  command: WorktreeCommand;  // this command's handle (a stub, once received)
}
interface WorktreeCommand extends RpcTarget {
  submit(tree: GitOid, pack: ReadableStream<Uint8Array>): Promise<WorktreeState>;
}
interface ReplicableWorktree extends RpcTarget {  // the Worktree stub
  getReplicator(): Promise<WorktreeReplicator>;  // only during the execution that passed the stub
}
interface WorktreeReplicator extends RpcTarget {  // persistent
  snapshot(): Promise<WorktreeSnapshot>;  // only during an agent's code execution
  gitHead(): Promise<GitOid>;             // at any time
  gitPull(oids: GitOid[], hints: WorktreeGitPullHints): Promise<GitPullTransfer>;  // at any time
}
// GitPullHints without `type` and `referencedBy`: `commitHistory`, `haves`, `shallow`, filters.
type WorktreeGitPullHints = Omit<GitPullHints, "type" | "referencedBy">;
```

## A command, from the container's side

Initial setup is an ordinary `git clone` of a made-up remote URL whose requests the gatekeeper
answers with `serveGitUploadPack(request, replicator)` (see [Git transport](#git-transport)). The clone is shallow where the
history reaches a connected repository, with no special flags.

The replica keeps a private index for syncing, separate from the real one, so that the real index
can stay at the worktree's head. Below, `git-sync` stands for `GIT_INDEX_FILE=.git/replica-index
git`. This is the sequence `__tests__/native/worktree-git.test.ts` runs against the kernel.

1. **Snapshot.** Call `replicator.snapshot()`, which returns `{tree, head, command}`.
   - If `head` changed, fetch it: `git fetch origin`.
   - Compute the tree of the files as they actually are: `git-sync add -A`, then
     `actual=$(git-sync write-tree)`. Don't rely on the tree you last synced: a command cut off
     (for example by a restart) may have left the files changed.
   - If `actual` differs from `tree`, fetch the snapshot's tree and check it out:

     ```sh
     git fetch origin <tree>
     git-sync read-tree -m -u <actual> <tree>
     ```

     This also removes files an interrupted command created.
   - Point the real index and HEAD at the head: `git reset --mixed <head>`. Then `git status` and
     `git diff` show the worktree's uncommitted changes, as the workspace would.
2. **Run** the command.
3. **Submit.** Write the tree of the files: `git-sync add -A`, then `new=$(git-sync write-tree)`.
   `git add -A` keeps ignored files (`node_modules`, build output) out.
   - If `new` equals the snapshot's tree, there is nothing to submit.
   - Otherwise send it, with a pack of what the snapshot's tree lacks:

     ```sh
     git rev-list --objects <new> ^<tree> | git pack-objects --stdout
     ```

     and call `command.submit(new, pack)`.
   - The result is the worktree's new state. If its tree differs from `new`, the workspace merged
     in concurrent edits: check the result out as in step 1.

Two commands in one `executeCode` call (format, then lint) need nothing extra: the second
snapshot's tree equals the first submission's result, so step 1 transfers nothing.

**One command at a time per checkout**, from `snapshot()` through the checkout after `submit()`.
Otherwise one command's snapshot checkout can overwrite files another command is still writing,
before that one submits. Commands that run in parallel need separate checkouts.

**Stop commands when the connection drops.** If the connection to the workspace drops while a
command runs, its execution is gone and its edits can no longer be submitted. Stop the command and
everything it started, rather than let it keep writing files. The next command's step 1 restores
the files.

Dispose of `command` when done with it, as with any stub.

## What the kernel does

### `snapshot()`

- **Requires a running execution.** It fails unless an agent's `executeCode` call is running in
  the worktree's chat.
- **Writes a tree** of the worktree's current files: the chat pin's base commit (the accepted
  commit, or the last re-root) plus the chat's pending edits plus the running step's buffered
  edits, which is what the Worktree binding's `readFile()` sees. Only changed directories get new
  trees, so a worktree from a connected repository keeps the remote IDs of its unchanged subtrees.
- **Stores the tree** in the Git cache like any other object, and records nothing else about it.
  A future garbage collection of unreachable objects will remove snapshot trees no submission
  built on.
- **Remembers the tree in memory** for the execution. Only trees handed out this way can be
  fetched by ID, since the Git cache holds other worktrees' objects too.
- **Returns a handle** bound to the execution, with the snapshot's tree as the base of its
  submission.

### `submit()`

The handle lives in memory. It stops working when its execution ends, and a workspace restart
breaks it outright. That fences out an abandoned command: without it, a command left running
across a restart could submit against the resumed execution, whose first snapshot usually has the
same tree ID, because the restart rolled the edits back. Each call, retries included, checks that
the execution is still running.

A handle accepts one submission. Calling `submit()` again with the same tree (after a lost reply)
returns the first result without merging twice; an identical retry of a merge would otherwise
nest its conflict markers. A different tree is refused. A submission that failed installed
nothing, so it may be retried.

A worktree's submissions run one at a time. Each one:

1. **Ingests the pack** into the Git cache. Files of any size are accepted: one over 1 MiB is
   streamed into storage in chunks rather than held whole.
2. **Checks the submitted tree.** It diffs the snapshot's tree against the submitted one,
   descending only into subtrees whose IDs differ. Every object at a changed path must have come
   in the pack, or be one the workspace has or can pull (for example a file the command moved
   that the workspace never loaded). Each submitted tree must be canonical, as Git would write
   it, which rejects invalid names such as `..`. A `.git` entry is refused, and so is a changed
   symlink or submodule, as the file tools refuse them.
3. **Merges.** If the worktree hasn't changed since the snapshot, the result is the submitted
   tree. Otherwise it is a three-way merge on just the paths both sides changed, with the
   snapshot's tree as the base, the worktree's current files as one side and the submitted files
   as the other. Concurrent edits can only come from the same execution: user edits are refused
   while an agent turn runs, and tool calls run one at a time. So they are the agent's code
   writing through the Worktree binding while the command ran, or two commands running in
   parallel.
   - Conflicting hunks get diff3-style conflict markers. A file deleted on one side and changed
     on the other keeps the change.
   - A binary file changed on both sides keeps the command's bytes, unless the command deleted
     it, even if the command changed only its mode.
   - All of these are reported as conflicts.
   - A file's mode merges on its own: one side's `chmod +x` survives the other side's edit.
   - A merge that would make a path both a file and a directory (the command replaced a file
     with a directory while the agent's code edited the file) is refused, with an error saying
     to take a new snapshot and run the command again.
4. **Re-roots the chat's pin** at a hidden commit of the result, below. Until this point the
   submission has only awaited; the re-root is installed in one synchronous block. If the agent's
   code changed the worktree during those awaits, the kernel merges again against the new
   current files. If the execution ended meanwhile, the submission fails and installs nothing.
5. **Returns the result's tree and the head.** The tree is remembered for fetching, as a
   snapshot's is.

The `executeCode` result then tells the agent which files were merged with conflicts, naming the
worktree by its binding name, so that it resolves them before continuing:

```
A command's file changes in REPO were merged with concurrent edits, with conflicts in: src/a.ts.
Resolve them before continuing.
```

### Re-rooting the chat's pin

A submission is not turned back into OT edits. Its result tree becomes a hidden commit
("Command result", parented on the pin's current base commit), and the chat's pin for the
worktree moves to it, as `updateChatFromMainline` moves a gadget's pin to a merge commit. File
modes and binary files then need nothing special: the tree carries them.

A chat pin has two commits (`ChatGadgetPinState`):

- **`baseCommit`** is what the chat's content builds on. A submission moves it to the hidden
  commit.
- **`mergedCommit`** is the accepted commit the chat's changes are reviewed against. For a
  worktree it stays the record's `pinBase`. Moving it would accept the chat's changes without
  review; keeping it means the user reviews everything the chat changed, the command's edits
  included, as a diff against the accepted commit.

The re-root absorbs the step's earlier edits to the worktree, since the snapshot already
included them. Edits later in the step build on the new base. Several submissions in one step
chain their hidden commits, and only the last is declared. The step's "changes" message declares
the re-root as a pin, which replay applies before the message's change, and the barrier bumps the
chat's code-base generation so that clients rebuild from the log. The re-root also forgets which
of the worktree's files the model has read, so it must read a file again before editing it. A
revert of the step undoes the re-root, as it undoes `updateChatFromMainline`'s.

Replay re-runs no `executeCode`, so a file tool that ran after such a command in the same step
would replay against content without the command's edits. Instead, once an `executeCode` call has
changed files, the step's later file tools (`readFile`, `grep`, `writeFile`, `editFile`) and
`executeCode` calls are refused with an error telling the model to call them in its next step.
Nothing is lost: a step's tool calls are all made before any of them runs, so such a call was
made without seeing the command's result anyway.

**On accept,** the worktree's new accepted commit is built from the pin's `baseCommit` tree plus
the edits made after the last re-root, and is parented on the old `pinBase`. The hidden commits
never appear in the worktree's history.

**Hidden commits stay in the Git cache.** The "changes" messages name them in their pin
declarations, and replay rebuilds closed epochs from them, so they are roots for garbage
collection for as long as the chat's history names them.

## The Worktree stub and the replicator

What a gatekeeper receives is the binding loopback the kernel minted into the agent's
`executeCode` env. Every call through it resolves against the execution that minted it, and
fails once that execution ends, since a worktree's uncommitted content lives in its turn. So the
gatekeeper calls `getReplicator()` when the stub is passed in, and stores the
`WorktreeReplicator` it returns.

The replicator is a persistent stub, which keeps working for as long as the worktree belongs to
the chat and the chat exists. `gitHead()` and `gitPull()` work at any time, and `snapshot()`
serves whichever execution is running in the chat at the time. So passing a Worktree stub hands
lasting access to that one worktree: a gatekeeper can mount in one turn and run commands in
later turns, across workspace restarts. Deleting the worktree or its chat ends access (a fetch
already streaming finishes). The replicator is scoped to its worktree by the kernel, so it
grants nothing beyond it; but a gadget the agent passes the stub to can get one too.

The receiving gatekeeper owns command approvals and the mount's lifetime.

## Git transport

`gitPull(oids, hints)` has the shape of `Gatekeeper.gitPull()`: it returns a `GitPullTransfer`,
whose `status()` keeps a failure's message even where Workers RPC replaces a stream's error, and
whose `shallowInfo()` reports how the pack changes the guest's shallow boundary. The kernel
checks the object IDs and depths, and re-encodes whatever it forwards to a connection from the
hints.

Native Git reaches it through gatekeeper-kit's `serveGitUploadPack(request, replicator)`. The
gatekeeper invents a guest-local origin URL and passes it the requests `git` makes to it,
stripping the URL's own path; the kernel registers no URLs. The helper serves read-only Git
protocol v2 smart HTTP: ref discovery and `ls-refs` from `gitHead()`, and `fetch` from
`gitPull()`, accepting only the fetch arguments the hints can express (`want`, `have`,
`shallow`, `deepen`, `deepen-since`, `deepen-relative`, and `filter` as `blob:none`,
`blob:limit=<n>` or `tree:0`) and ignoring harmless ones such as `ofs-delta`. A refusal, or a
pack that fails partway, reaches Git as a remote error, which it prints.

The repository has a single branch, whose head is the worktree's Git head (`headCommit`, or a
`commit()` buffered earlier in the running step). Workspace-created commits are real Git objects.
A fetch is judged by what the guest lacks, from its `haves` and `shallow` commits, so fetching a
new head sends only the commits and objects the guest doesn't have. Negotiation takes one round:
the helper answers a fetch at once, as if Git had sent `done`.

Besides commits, `gitPull()` serves the trees `snapshot()` and `submit()` handed out to the
running execution, by ID and on their own, never together with commits. Such a fetch leaves out
what the guest's commits' trees hold at the same paths. For a worktree from a connected
repository, the guest must have a commit from the head's history (any fetch from a clone does).

### The shallow boundary

Walking back from the head through the workspace's commits, the history's *boundary* is the
first commits that a live connection has: the commit the worktree was created at, or a later one
the agent pushed or merged in from a connected repository. Everything below the boundary is on
the remote, since a remote that has a commit has its whole history. A scratch worktree has no
boundary, and its history is served in full from the workspace. So, in principle, is a worktree
from a repository whose connections were all removed; but the workspace usually doesn't hold that
history, so its clones and fetches then fail on the missing objects.

- **A clone** holds the workspace-only commits, plus the boundary commits as shallow commits.
  The boundary commits and their files come at depth 1, in one pull from one connection that has
  all of them, streamed through without being stored in the workspace. The rest of the pack is
  built from workspace storage, streaming a file over 1 MiB from its stored chunks. It leaves
  out every object in the boundary commits' trees, since a pack can't hold an object twice (that
  includes renamed, copied and reverted files, which match by content). The trees of a boundary
  commit the workspace hasn't stored, such as a merged-in commit's, are fetched without blobs, a
  level at a time.
- **More history.** Once the guest has the head, any further history it asks for (`--deepen`,
  `--unshallow`, `--depth=N`, or `git fetch --depth=1 origin <sha>`) is purely remote, and is
  proxied whole from a connection, rebased on the boundary. A commit wanted by ID is served only
  after the connection confirms it is in the head's history, with a commit-only fetch that claims
  the boundary commits as `have`s. This trusts the connection, since the data it protects is its
  own repository. Nothing is stored in the workspace.
- **Refused.** A fetch that needs both workspace commits and remote history (for example the
  head moved while a command was running Git) is refused, with an error telling the guest to
  fetch the worktree's head first. Merging a local pack with a proxied one risks duplicate
  objects, which Git rejects (see
  [`plans/tree-sync-replicas.md`](../plans/tree-sync-replicas.md#why-spanning-requests-need-storage)).
  A guest that fetches each new head at step 1 never hits this. A clone is the exception: a
  `git clone --depth=N` that needs workspace commits and reaches past the boundary is just given
  less history, as any shallow server may do. (If the head is itself a boundary commit, a deeper
  clone is proxied whole.)
- If no single connection has every boundary commit, a fetch that needs them is refused.

Other refs of the worktree's origin (e.g. its `main` branch) and other repositories are not
reachable this way. A future design would have the agent pass them to the gatekeeper as objects.
Push and general network access are outside this interface.

## Git in the container

The container's checkout should match the workspace's view of the worktree:

- **Working tree:** the snapshot's `tree`, the worktree's current files.
- **HEAD and index:** the worktree's Git head (`head`), so that `git status` and `git diff` show
  the uncommitted changes. The head may be older or newer than the accepted commit; there is not
  necessarily any history from it to the current files.

`git reset --mixed <head>` gets there; `--soft` would leave the index at the previous tree and
show that difference as staged changes. The private sync index (above) is what lets the real
index stay at the head.

`.git` is not synced in either direction:

- Nothing in the container's `.git` flows back to the workspace; submissions carry only the
  working tree, and a `.git` entry in a submitted tree is refused. Git state changes are made from
  the workspace: the agent commits with `commit()`, and a second working copy is another
  worktree mounted into the container, so the agent can use its own file tools on it. The agent
  should not run `git commit`, create branches, or use `git worktree` in the container; the
  container gatekeeper's agent-facing description should say so.
- The gatekeeper owns HEAD and the index, and resets them to the workspace's head before each
  command, overwriting anything a command did to them.
- Commands may still use `.git` as scratch space, since fetching history writes objects and
  build scripts may use it privately. For example, `build-upgrade-base.ts` fetches a commit and
  checks it out into a temporary `git worktree` that it removes afterwards; that never becomes
  workspace state.

## Limitations

- **No background commands.** A command must run within one `executeCode` call, from
  `snapshot()` to `submit()`.
- **After a command changes files,** the rest of the step can't use the file tools or run
  `executeCode` again; the agent continues in its next step.
- **Symlinks and submodules** can't be changed by a command, and `.git` entries can't be
  submitted.
- **Large text files** changed on both sides are merged in memory, all three versions whole.
- **Binary files** changed on both sides keep the command's version; a file-versus-directory
  conflict with concurrent edits is refused.
- **Snapshot trees** can be fetched only during the execution they were handed out to.
- **History** beyond the worktree's head, other refs and push are not available. A fetch needing
  both workspace commits and remote history is refused.
- **Ignored files** stay in the container and never reach the workspace. The kernel can't tell
  which guest paths are ignored; `git add -A` decides.
