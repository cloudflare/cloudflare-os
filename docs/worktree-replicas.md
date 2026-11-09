# Worktree replicas

> **Status:** the live sync protocol this document describes (sync sessions, subscriptions,
> revisions and returning edits) has been removed. For now a mount is read-only: a container can
> clone and fetch the worktree's commits with `gitPull()`, and nothing more. Its replacement is
> planned in [`plans/tree-sync-replicas.md`](../plans/tree-sync-replicas.md), and this document
> will be rewritten when it lands.

A gatekeeper receives the Worktree capability directly. The kernel knows the selected worktree,
its Git provenance and canonical change history; it knows nothing about containers, guest paths,
mount names, or command lifetimes. The container gatekeeper owns `mountWorktree(worktree, mountName)`
and synchronous `exec(command, options)`. The mount lives at `/workspace/<mountName>` in the guest.

## Scenarios

- Materialize a remote repository with DO-created commits and pending edits, without loading its
  remote file contents into DO memory or importing the upstream pack into the DO object cache.
- Materialize a scratch worktree containing supported uploaded text and binary attachments.
- Stream DO edits into a running guest, and return guest edits through the existing canonical OT
  engine. Concurrent text edits are transformed into canonical order, rather than replaced with
  whole-file text snapshots.
- Let a build run `git fetch --depth=1 origin <UPGRADE_BASE>` after mounting. The Cloudflare OS
  integration harness does this in `packages/integration-tests/scripts/build-upgrade-base.ts`.
- Restore a warm snapshot and replay missed canonical changes before running another command.

## API

These methods are on the actual Worktree capability, but omitted from the agent's file-tool type
text. Hiding the declarations is for discoverability, not authorization.

```ts
interface ReplicableWorktree {
  getSyncSession(): Promise<WorktreeSyncSession>;
  gitPull(request: Request): Promise<Response>;
}
interface WorktreeSyncSession {
  subscribe(receiver: WorktreeSubscriber, after?: string): Promise<WorktreeSubscription>;
  submitChanges(batchId: string, baseRevision: string,
    changes: FileChangeByPath[]): Promise<{revision: string}>;
}
interface WorktreeSubscriber {
  setBaseCommit(state: {revision: string; base: string | null; head: string | null;
    shallowCommit: string | null}): Promise<void>;
  change(revision: string, batchId: string, changes: FileChangeByPath[]): Promise<void>;
}
interface WorktreeSubscription {
  unsubscribe(): Promise<void>;
}
```

All capabilities, including receiver callbacks, must be persistable native RPC stubs. Mint them
inside their owning Durable Object with `ctx.restore()`. The kernel's regular file methods retain
the original agent-execution guard; mounted synchronization is an explicitly delegated,
worktree-scoped capability that outlives the agent turn that passed it on. Deleting the
worktree or its chat ends access. The receiving gatekeeper controls its own mount lifetime and command approvals.

## Initial capture and continuous delivery

The kernel flushes buffered agent edits, then atomically records the subscriber and captures the
accepted commit, the Git head and pending transforms at a canonical revision. It sends
`setBaseCommit` followed
by the pending transforms, then any changes accepted while hydration was running. `subscribe`
resolves only after this registration has caught up and its callbacks have acknowledged applying
the updates. Capturing first and registering later would lose edits during hydration.

The receiver materializes the base completely and applies pending OTs to its mutable overlay. No
copy-on-read guest filesystem is required. Pending transforms are not synthesized into Git commits.
A subsequent accepted-commit checkpoint changes Git metadata after preceding edits have been
applied; it must not reset the guest filesystem or apply those edits again. `setBaseCommit` is
also called when only the head moves (the agent committed); it is ordered with the changes
around it, because the head advances in the same step that records them.

Delivery reads one existing canonical row after the last durable acknowledgment. A slow receiver
applies backpressure without creating an in-memory event queue. Callback failures retain the cursor
and retry through the existing DO alarm. Receiver application must be idempotent: a lost ACK may
redeliver the same event. The receiver records its applied revision before returning.

`subscribe(receiver, after)` replaces the session's previous registration and replays retained
history. An old unsubscribe handle cannot stop its replacement. A content-preserving accept can
bridge the previous canonical generation. A destructive reset or an expired history position
requires reconciling outstanding batch receipts and resubscribing for a fresh base; the kernel
never resets a dirty guest silently. This is not an unlimited historical replay service.

## Returning edits

A batch contains existing `FileChange` transforms: text OTs, deletion, or a whole-file `setBytes`
Git-blob reference. Upload a new binary blob through the existing Git cache `put("blob", bytes)` before
referencing it. Binary differences, chunked uploads and large-file support are outside this API.

The DO transforms the batch over canonical changes since `baseRevision`, then persists the changes
and a payload-bound receipt atomically. An identical retry returns the original accepted revision,
even after intervening edits. Reusing the ID with different content rejects. Receipts are retained
for diagnosis and delayed reconciliation; retrying a batch must never rerun a shell command.

The submitting session sees its accepted batch under the same ID. The receiver reconciles this
canonical echo with its optimistic edits rather than applying it twice, and rebases still-pending
local edits over incoming changes. Applying an inbound event must not create another outbound edit.
Foreign events have kernel-generated IDs in a separate namespace.

Only normalized worktree-relative paths are accepted; `.git` metadata and filesystem aliases are
excluded. Batches are limited to 128 paths and 1 MiB of serialized transforms. Fresh bootstrap has
the same 1 MiB transform budget; commit a larger pending overlay before mounting. Binary content
travels separately as raw Git objects and retains the existing object-size limits.

## Unified Git transport

`gitPull` accepts read-only Git protocol v2 smart-HTTP requests and streams raw binary responses.
The kernel parses every request and accepts only the fetch arguments it understands; nothing the
guest sends is forwarded as is.
The gatekeeper invents a guest-local origin URL and maps it to the passed Worktree; the kernel does
not register URLs or expose a guest filesystem layout. Normal ref discovery reports the worktree's
Git HEAD and ancestry, including explicit commits that have not yet been accepted in the UI. The
subscription's commit is the base for its canonical file transforms; it may differ from Git HEAD,
just as a checkout can have working changes. The guest materializes that file base and its OTs
without replacing HEAD with the base.
Workspace-created commits are real Git objects, not approximated by text changes. The original
remote base remains the shallow boundary. A fetch is classified by what the guest lacks, judged
from its `have` and `shallow` lines, not by what it names: a fetch of a new head sends only the
commits and objects the guest's `have`s don't cover.

For a remote-backed mount, the source Git gatekeeper streams the shallow base pack directly.
The kernel appends the additional DO-local objects and recomputes the pack framing/checksum without
repository-sized buffering. Base tree metadata excludes duplicate OIDs, including blobs reused by
renames; base file blobs are not read into the DO. Scratch worktrees use their locally stored Git
objects through the same protocol.

## History beyond the workspace

Mounting a worktree permits fetching any commit in its head's history, e.g. a build script's
`git fetch --depth=1 origin <sha>`. A worktree is not tied to a particular remote: its head is often
a workspace-created commit no remote has. Walking back from the head through locally stored
commits, the first commits with recorded provenance are the history's boundary; any connection
with provenance for them can serve the rest. Commit IDs hash their entire history, so it does not
matter which.

For a wanted commit the workspace lacks, the kernel sends that connection a commit-only pull
(`filterTreeDepth: 0`) of the wanted commits, with each boundary commit as a `have`. An empty
pack means every wanted commit is in the history, and the kernel pulls them from the same
connection with the guest's `have`s, `shallow` commits, depth and filter, re-encoded as
`GitPullHints`, and frames the provider's pack and shallow-info for the guest. Otherwise it
refuses. This trusts the connection's answer, since the data it protects is the connection's
own repository. A deepen of commits the guest already has (`git fetch --deepen=N` or
`--unshallow`) is pulled the same way, starting from the boundary, with no check needed. Nothing
is stored in the DO, no new observation is recorded, and removing the connection cancels its
active streams.

A single fetch that needs both workspace-only objects and remote history is refused, because
merging a proxied pack with a local one risks duplicate objects, which Git rejects (see
[`plans/git-proxy.md`](../plans/git-proxy.md)). A guest that fetches each head as `setBaseCommit`
reports it already has every workspace-only object, so this only happens if the head moves while
a command is running Git.

Other refs of a worktree's origin (e.g. its `main` branch) and other repositories are not
reachable this way. A future design would have the agent pass them to the gatekeeper as objects,
never look them up in the agent's environment. Push and general network access are outside this
interface.

## Git in the container

The container's checkout should match the workspace's view of the worktree:

- **Working tree:** the subscription's file base (the worktree's accepted commit, `pinBase`) plus
  its pending changes.
- **HEAD:** the worktree's Git head (`headCommit`, its latest explicit commit). It may be older or
  newer than the file base, and there is not necessarily any change history from it to the current
  files.
- **Index:** the head's tree, so `git status` and `git diff` show the difference between the files
  and the head, as the workspace would.

To get there, check out the file base, apply its pending changes, then `git reset --mixed <head>`
(not `--soft`, which would leave the index at the file base and show that difference as staged
changes). When only the head changes, fetch it and reset again; the files are untouched. When only
the file base changes (e.g. the user accepted the chat's changes), the files already include it.
The subscription reports both (`setBaseCommit`'s `base` and `head`).

`.git` is not synced in either direction:

- Nothing in the container's `.git` flows back to the workspace. Git state changes (commits,
  branches, new working copies) are made from the workspace: the agent commits with `commit()`, and
  a second working copy is another workspace worktree mounted into the container, so the agent can
  use its own file tools on it. The agent should not run `git commit`, create branches, or use
  `git worktree` in the container itself; the container gatekeeper's agent-facing description
  should say so.
- The gatekeeper owns HEAD and the index and resets them to the workspace's head, overwriting
  anything a command did to them.
- Commands may still write `.git` as scratch space, because fetching history writes objects and
  build scripts may use it privately. For example, `build-upgrade-base.ts` fetches a commit and
  checks it out into a temporary `git worktree` that it removes afterwards; that never becomes
  workspace state. Blocking the agent's own Git state changes more precisely (e.g. with
  finer-grained write restrictions) is up to the container implementation.

As with files, overlapping changes from the container and the workspace at the same time are the
agent's mistake, and some loss is expected; the design favours simplicity over preserving them.

## Container responsibilities and completion

The kernel does not execute commands. The gatekeeper must catch up before starting a shell, stream
edits continuously while it runs, and stop tracked background writers before completing it. Before
resolving `exec`, it must drain captured outbound batches, await their durable ACKs, and persist
canonical application through the latest acknowledged revision. Concurrent DO edits accepted after that revision may arrive later.
A command that produced no changes needs no artificial empty batch.

Between approved commands the gatekeeper seals tracked writers while keeping the guest warm. Its
idle timer can drain, snapshot and unsubscribe after five minutes. Snapshot restoration reattaches
and catches up before another command runs. Private ignored dependencies/caches remain in the
snapshot and do not become workspace edits. The kernel cannot infer which guest paths are ignored;
filtering, filesystem event capture, optimistic reconciliation and snapshot durability belong to
the container implementation.

A synchronization failure rejects completion instead of returning a supposedly synchronized
command result. Persist execution identity and receipts before effects, reconcile lost replies,
and surface an indeterminate shell outcome if it cannot be established.
