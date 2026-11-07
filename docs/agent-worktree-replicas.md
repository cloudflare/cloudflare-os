# Mounted worktree integrations

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

## Integration API

These methods are on the actual Worktree capability, but omitted from the agent's file-tool type
text. Hiding the declarations is for discoverability, not authorization.

```ts
interface WorktreeIntegration {
  getSyncSession(): Promise<WorktreeSyncSession>;
  gitPull(request: Request): Promise<Response>;
}
interface WorktreeSyncSession {
  subscribe(receiver: WorktreeSubscriber, after?: string): Promise<WorktreeSubscription>;
  submitChanges(batchId: string, baseRevision: string,
    changes: FileChangeByPath[]): Promise<{revision: string}>;
}
interface WorktreeSubscriber {
  setBaseCommit(state: {revision: string; head: string | null;
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
worktree-scoped capability that outlives the agent turn that passed it on. Removing the
worktree/chat or its source connection ends access. The receiving gatekeeper controls its own mount lifetime and command approvals.

## Initial capture and continuous delivery

The kernel flushes buffered agent edits, then atomically records the subscriber and captures the
accepted commit plus pending transforms at a canonical revision. It sends `setBaseCommit` followed
by the pending transforms, then any changes accepted while hydration was running. `subscribe`
resolves only after this registration has caught up and its callbacks have acknowledged applying
the updates. Capturing first and registering later would lose edits during hydration.

The receiver materializes the base completely and applies pending OTs to its mutable overlay. No
copy-on-read guest filesystem is required. Pending transforms are not synthesized into Git commits.
A subsequent accepted-commit checkpoint changes Git metadata after preceding edits have been
applied; it must not reset the guest filesystem or apply those edits again.

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
The gatekeeper invents a guest-local origin URL and maps it to the passed Worktree; the kernel does
not register URLs or expose a guest filesystem layout. Normal ref discovery reports the worktree's
Git HEAD and ancestry, including explicit commits that have not yet been accepted in the UI. The
subscription's commit is the base for its canonical file transforms; it may differ from Git HEAD,
just as a checkout can have working changes. The guest materializes that file base and its OTs
without replacing HEAD with the base.
Workspace-created commits are real Git objects, not approximated by text changes. The original
remote base remains the shallow boundary.

For a remote-backed mount, the source Git gatekeeper streams the shallow base pack directly.
The kernel appends the additional DO-local objects and recomputes the pack framing/checksum without
repository-sized buffering. Base tree metadata excludes duplicate OIDs, including blobs reused by
renames; base file blobs are not read into the DO. Scratch worktrees use their locally stored Git
objects through the same protocol. A later exact-revision request can pass through to the recorded
source without populating DO storage.

Separately discovered remote URLs use `ApprovalQueue.getGitCache().gitPull(repositoryUrl, request)`.
The kernel resolves caller-visible, already-connected repository gatekeepers and applies normal
observation/revocation checks. URLs must be credential-free HTTPS repository identifiers, not
arbitrary network destinations. Source credentials stay in the Git gatekeeper. Responses retain
only their content type, not cookies or redirect headers, and source removal cancels active streams.

Requesting approval for a previously unconnected repository while holding the same native fetch
pending is deferred. Connect that repository before executing the command. This does not block the
Cloudflare OS integration test: its upgrade-base fetch uses the same already-connected repository.
Push and general network access are outside this interface.

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
