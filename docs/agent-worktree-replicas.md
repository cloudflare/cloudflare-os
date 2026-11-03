# Single-worktree command mounts

The DO owns canonical worktrees and their existing `FileChange` transforms. A trusted
integration can pull one frozen worktree, run a command, and stream edits back. Filesystem
capture, diff calculation, containers, paths, snapshots, command receipts, idle timers and
network policy belong to the integration.

## API

```ts
// Agent code: container operations belong to the integration session.
await env.CONTAINER.mountWorktree(await env.REPO.exportTo("CONTAINER"));
const executionId = await env.CONTAINER.executePosix("pnpm test");
// Return from executeCode for approval, then read CONTAINER.getExecution(executionId).

// Kernel: one frozen input, and one write-only callback.
Worktree.exportTo(integration: string): Promise<unknown>; // opaque WorktreeExport
interface WorktreeExport {
  id: string;
  binding: string;
  head: string | null;
  packs: Fetcher[]; // GET returns raw binary Git packs, consumed in order
  pendingChanges: FileChangeByPath[];
  writeback: Fetcher<WorktreeWriteback>;
  git?: Fetcher;
  gitRepositories?: {binding: string; url: string; source: boolean}[];
}
WorktreeWriteback.submitChanges(
  batchId: string, changes: FileChangeByPath[], final: boolean
): Promise<void>;
```

There are no cursors, reads after mounting, polling, renewal, release calls, corrections or
multi-master reconciliation. A mount selects one named worktree, never gadget code or the
entire workspace. It is a command-scoped capability, not an arbitrary Git-object reader.

## Scenarios and why these functions exist

- **Run tests against current DO edits:** the agent exports its selected worktree to an explicitly
  granted integration binding, then passes the opaque export to that container's `mountWorktree`.
  The gatekeeper stores the input for one command; ordinary approval still gates guest launch and
  shell dispatch. It materializes the supplied Git objects, DO-only commits and pending OTs before
  running. It never calls back to discover a turn or select a worktree.
- **Work on an uploaded CSV/image:** mount the shared scratch worktree instead. Raw Git packs
  preserve attachment bytes, including non-UTF-8 blobs. Export does not require a remote repo.
- **Fetch fixtures/history during a test:** the mount includes captured whole-repository bindings
  and a command-scoped HTTP `git` capability. The integration routes Git smart HTTP to it with
  `x-workshop-git-binding` selecting the original binding. It is not an arbitrary URL proxy.
- **Edit/build, then read back with normal DO tools:** `submitChanges(batchId, changes, false)`
  streams small existing text OTs while the command runs. `final: true` atomically accepts the
  last batch and closes command authority. Do not report command completion until that ACK.
- **Run several commands without throwing away installed dependencies:** the gatekeeper keeps
  the sealed guest warm, imports a fresh mount for the next command, and owns idle snapshots.
  This needs no kernel turn-end hook or cross-command write lease.

## Unified Git transport

```ts
Gatekeeper.gitPull(request: Request, observer?: RpcStub<ObservationAuthorizer>): Promise<Response>;
```

This is one provider-owned authenticated smart-HTTP transport for both cache hydration and
native Git. Only protocol-v2 GET `/info/refs?service=git-upload-pack` and POST `/git-upload-pack`
are supported. The provider always selects its own bound repository and credentials; request
URLs and guest headers cannot redirect authenticated access.

The kernel omits `observer` only for pulls of objects already observed from that source. It
composes its usual exact-OID/depth/filter request and demultiplexes the raw pack. A command's
native Git request always receives a fresh observation authorizer and requires whole-repository
access. Issue/PR-only bindings remain valid sources for their previously observed objects,
but do not become arbitrary repository readers. Missing/unreachable optional remotes are not
advertised and do not block an otherwise valid mount.

The repository binding IDs are frozen when the agent exports the worktree; connections added later
cannot widen the command. Every request and response-stream read rechecks its original command,
integration grant and source connection. Final writeback closes Git access as well as writes
and cancels open streams. A pending provider RPC cannot be force-aborted on this runtime, but
its response is checked and discarded/cancelled after expiry. New requests fail closed.

Pack responses stream as raw binary, without insertion into the DO Git cache. Only Git content
type is forwarded; provider cookies/authentication headers are not exposed. Guest fetches do
not create DO worktrees, import guest refs/commits into the DO, or move the DO HEAD. Checked-out
file edits still use ordinary writeback. Updating GitHub/GitLab and the kernel together is
required: the former OID/hints provider signature is replaced, not kept as a second API.

## Bootstrap

1. Capture the selected worktree's accepted commit and pending transforms.
2. Import the raw Git packs in order, then check out `head`. Null means an empty base.
3. Apply `pendingChanges` above that base. Only then admit shell execution.

For a remote repository, the kernel obtains the complete depth-one pack through its authorized
source gatekeeper. Repository blobs stream directly to the caller, not through the DO's Git
cache. A subsequent pack supplies actual DO-local commits/objects above that source plus blobs
referenced by pending binary changes. Commit identities are preserved, not replaced with
synthetic OTs. Local/scratch worktrees export their Git objects directly. Pack generation
buffers at most one object; transfers use raw bytes, not base64.

This v0 exposes one accepted head, not a separate explicit-head/history navigation interface.
It does not import guest commits/branches back. Binary bootstrap preserves exact bytes; binary
writeback is a separate extension.

## Authority and completion

Trusted deployment configuration `AGENT_INTEGRATION_GRANTS` grants a vendor
`worktreeReplica: true`; absence denies access. Ambient provisioning remains independently
controlled by the user/admin. The agent chooses the integration recipient by binding name;
export verifies that binding and captures the original authority internally. When opening an
explicitly granted integration's agent session, the kernel supplies a stable opaque chat identifier
as `startSession(queue, {chatId})` metadata. It carries no turn ID or execution authority. The
container uses it for its own per-chat instance ownership. No `AgentContext`, `getTurn`, lifecycle
subscriptions, contextual redelivery or end-of-turn cleanup barriers are added.

Every transfer/write rechecks the grant, connection, original execution and selected worktree.
The gatekeeper cannot inspect the agent turn. Persisted command writeback survives DO reset
only within its original active execution; a later prompt cannot adopt it.

Stream ordered batches while the command runs. Each batch is at most 128 paths/1 MiB and uses
the existing lightweight text OT format. The kernel checks the captured revision and ordinary
path permissions, then atomically persists edits and a payload-bound receipt. Concurrent DO
edits may be rejected by this best-effort revision check, but are unsupported: an edit buffered
during writeback validation can be overwritten by the container. This API does not merge
concurrent edits or send them to the container. Avoid editing the same worktree while a command runs.

After process exit, the integration drains and seals its filesystem and submits a final batch
(possibly empty) with `final: true`. Its durable ACK closes write authority atomically.
Only then may command success be exposed. Retry a lost ACK with the identical ID/payload;
overlapping retries deduplicate too. The final receipt remains retryable after revocation
without creating effects or reviving authority.

Command records and all batch receipts remain in SQLite storage without a time-based expiry,
for diagnosis and delayed lost-ACK recovery. Mounting indexes only unreleased commands for the
selected chat/worktree; retaining completed history does not add a full-history scan to each
mount. Retention does not extend write authority or permit replaying a shell command.

## Warm reuse and failures

The container remains warm but sealed between commands. Every new authorized command obtains a
new frozen mount, replaces DO-backed contents before execution, and preserves ignored private
tools/caches. There is no background synchronization while idle. A gatekeeper-owned configurable
five-minute idle timer snapshots/stops the guest; a later command transparently restores it and
imports its fresh mount.

The export contains persistent pack readers, not live in-memory streams. They can be stored by
the receiving gatekeeper across an approval pause or DO reset; opening them later streams the
captured immutable Git objects without materializing the repository in the kernel cache. Each
reader and writeback call rechecks original authority. Pack transfer is retryable before dispatch;
a lost shell reply is never permission to execute again. The gatekeeper durably assigns each
export to one command and rejects reusing it for a later command. Rejection seals its unused
writeback. Command journals distinguish dispatched, finished and synchronized outcomes.

Symlink/mode mutations, submodules and binary writeback must fail rather than be described as
synchronized. Concurrent writers have no preservation guarantee. This does not change general DO OT semantics.

## Deliberate v0 tradeoffs

- One worktree per mount; no entire-workspace mount or multi-worktree command transaction.
- One complete initial capture per command, including warm reuse/restore. No incremental
  bootstrap negotiation, live DO-to-container updates, polling, or multi-master reconciliation.
- Concurrent canonical DO edits are unsupported and may be overwritten; revision checks are
  best-effort, not a conflict-resolution or preservation guarantee.
- The command's text edits stream during execution, but its result waits for final drain/seal/ACK.
- Only command-duration authority. No #798 lifecycle hooks, #833 contextual-action redelivery,
  cross-turn write leases, or background workspace access while the guest is idle.
- Warm ignored tools/caches survive in the integration. Additional fetched refs/history are
  guest-private and need not survive the next fresh mount; snapshots are not canonical backups.
- Binary attachments/bootstrap work; binary mutation submission, chmod, symlink/gitlink changes,
  large-file support, guest Git ref publication, and submodules are separate work.
- The agent explicitly exports and mounts before every command. It must return from code mode
  for approval, then poll the durable receipt. An expired export needs a fresh request; approval
  never revives an old command's authority.
