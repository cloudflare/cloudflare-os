# Timeline read state

## Semantics

Each user has an inclusive read pointer into each thread's persisted, ordered timeline, and
owns that pointer in their User DO. Thread, workspace and instance badges count unread **messages**,
not outstanding approvals. A countable message is persisted visible text or an attachment; empty
reasoning/tool-only entries, catalog changes and generated slash-command expansions do not count.
Streaming tokens do not count separately. A turn can contain several countable messages; push
policy is independent and may still notify once at turn completion. Reading a permission request
does not approve it. Toast/push delivery neither creates nor clears read state.

The pointer can advance partially, or rewind immediately before an individual rendered work
item. Grouped work/tool runs are one rendered item; their hidden bookkeeping belongs to the same
read range. Agent-only catalog changes do not advance the unread head. Existing history starts
read when the workspace first runs this version; subsequent activity is unread. New threads start
unread when they receive content. Empty threads are read.

State is per authenticated user, per instance, synchronized across devices. Only the owner and
established build collaborators receive thread metadata. Use-only collaborators do not. Deleting
a thread/workspace, dismissing/revoking access, or downgrading to use-only removes its projection.
Shared-workspace recipients are reauthorized before every metadata delivery, including retries while
disconnected. Empty snapshots only remove metadata and do not register observers. A previously
unopened shared workspace is indexed when its build collaborator first opens it; this does not
expand discovery or sharing authority.

## Authenticated API

[`AuthenticatedApi`](../packages/workshop-shared/src/api.ts) exposes `getUnreadState`,
`subscribeToUnreadState`, `markChatRead`, `markChatsRead` and `markChatUnread`, with the
`ChatReadState`, `ChatReadReceipt`, `UserUnreadState` and `UnreadStateSubscriber` contracts.
Snapshots include read and unread threads; unavailable workspaces are explicit, not false zeroes.

Subscribe directly: registration installs the listener before sending the initial full snapshot,
avoiding a fetch/watch gap. Snapshots replace previous state; ignore older/equal revisions within
one subscription. Revisions are in-memory: start a fresh revision stream on resubscription. Retain
the handle while hidden, until logout/shutdown. Resubscribe after transport/DO reset; the initial
snapshot loads the saved projection and pending fanout catches it up. These callbacks are live hints
backed by durable state, not a replayable alert log. Keep state scoped to the instance and authenticated user.

Reads use the sequence actually observed, never a server-side "latest now". Workspace/all-read
commands submit the boundaries from their observed snapshot, preserving activity that arrives
while the command is in flight. Reads only advance. Explicit unread increments `readEpoch`;
automatic receipts and duplicate unread requests carrying the previous epoch are ignored. Thus
an old window cannot immediately clear a deliberate unread marker, and lost-ACK retries are safe.

## Persistence and reset recovery

The User DO persists private consumption horizons (`workspaceId`, `chatId`,
`readThroughSequence`, `readEpoch`) plus one compact `workspaceChatSummaries` record per workspace.
That record holds the last applied source version and each thread's latest head, cumulative message
count, count through the user's horizon, and bounded preview. It does not copy message history.
The horizons remain authoritative; the summaries are derived and rebuildable.

The summary is deliberately one value per workspace, so normal writes are proportional to its
thread count, not the user's entire account. Previews are bounded, but thread count is not; this
trades a large-workspace storage-value ceiling for a small local rehydration/read path. This is
intended for personal workspaces, not unbounded chat collections. If that scale is needed, partition
the summary by thread rather than truncating heads or silently dropping unread counts.

On normal wake, the User DO loads horizons and summaries from its own KV storage into memory. It
does not contact the workspaces or scan their histories. Message delivery updates only the affected
workspace's summary, persisting heads and their source version before ACK. Read changes commit the
horizon and its summary together in one transaction, writing the summary once per workspace even
for bulk reads. Badge calculation and snapshot construction remain in-memory. A partial read or
rewind still resolves its sparse sequence through the authorized workspace before writing.
An observed receipt ahead of the saved projection first refreshes the workspace through that same
authorization gate. A history rewrite during count resolution invalidates the result and retries
once against the current recount generation; continued mutation returns an error instead of saving
a count from a different generation. Healthy workspaces commit without waiting for other lookups.
Count-changing history rewrites carry a durable per-thread recount version in the existing source
change index. They repair the affected workspace's counts through its users' saved horizons; normal
appends and User DO wake-up do not. A concurrent horizon change leaves the previous summary intact
and the source delivery pending for retry, rather than committing mismatched counts.

Only a missing summary (first bootstrap, upgrade from the horizon-only prototype, or repair)
fetches heads and counts through saved horizons from the workspace's build-role/observer gate.
Legacy prototype rows preserve their horizons but discard obsolete derived data. An initial
subscription waits for missing summaries to load. Reconstruction also idempotently enrolls the
user for future workspace deliveries, so shared listings saved before this feature receive updates
without reopening the workspace.
Reopening a shared workspace explicitly queues catch-up after restoring its listing, even when
already enrolled: dismissing the listing discards the warm User DO's unread projection.
One failing workspace does not block healthy ones: `unavailableWorkspaceIds` explicitly reports
missing summaries, and aggregate counts are lower bounds, not a claim that missing threads are read.
Previously delivered summaries remain usable while a source is unavailable. They represent the
last acknowledged projection, not a cross-workspace freshness barrier: pending fanout catches them
up through the durable delivery journal, without a full refresh on every User DO reset. Incoming
updates join any initial reconstruction, then apply only if their source version is newer. That
version survives User DO eviction, so lost ACKs and stale retries cannot double-apply a delivery or
restore an older head. Failures remain failures, not read receipts. Bulk read applies healthy
workspaces' horizons but reports a failed sparse-count lookup; a monotonic retry is safe.

Normal fanout carries only each **changed thread's latest message**: its thread/title, latest
sequence, cumulative countable-message count, author, timestamp and at most 240 characters of the
first visible line. No earlier messages or unchanged thread heads are included. Source checkpoints
and retry watermarks are durable in the workspace. Initial catch-up and cold reconstruction may
read all heads; ordinary appends use an incremental in-memory source index. Sparse timeline
sequences are never treated as message counts. Currently the audience is the workspace owner and
established build collaborators; a future multiplayer thread-membership model can narrow it.

The Overseer increments its source version in the same transaction as timeline writes. Each
`unreadReaders` row stores the recipient's last acknowledged version: an absent/older checkpoint
**is** pending work. There is no separate outbox, copied pending watermark or fanout transaction.
The per-thread `chatTimelineChanges` index selects only heads changed since that checkpoint.
Reopening a dismissed listing clears its delivery checkpoint to request a full catch-up.

Typed-storage subscribers run **before** their write and may run inside an existing KV iterator:
they must not enumerate recipients or construct snapshots. A deferred drain reads committed state,
arms the shared fallback alarm before RPC, rechecks authority, captures heads and their version
together, and advances each checkpoint only after ACK. Concurrent writes leave it behind the
source version for another pass. Failed recipients do not block healthy readers or spin within
the same drain. Their persisted backoff doubles from 30 seconds up to 30 minutes and survives
eviction; new messages still reach healthy readers immediately. Full role/observer authorization
remains mandatory on each attempted metadata delivery, including retries. A successful delivery
clears backoff, and interactive reopening requests immediate catch-up after connection repair.
Lost ACKs/checkpoint-write failures safely retry because the receiver fences source versions.
Callback failures do not roll back read cursors.

Workspace deletion persists its intent before removing any user's listing and read state. It
uses the same reader rows, without requiring observer access for removal: a row is deleted only
after that User DO acknowledges cleanup. The listing removal fences delayed snapshots; only after
every row is removed does the Overseer delete its own storage. Deletion intent is synchronous;
cross-DO delivery never holds the input gate, since it may call back into the workspace. Deletion
clears earlier account-repair backoff because removing metadata needs no observer access. The request
waits for the owner's listing cleanup, not unhealthy collaborators; the durable alarm finishes
their cleanup. Alarms resume interrupted deletion without another user action,
and a deleting workspace refuses new opens, agent callbacks and turn starts. Queued callbacks
remain untouched until cleanup removes the source storage; recovery alarms and continuations
returning from model lookup or message preparation cannot resume work during deletion.

Only the read-state projection is replayed. Existing transient toast/mobile-push sends are not
blindly retried, and this feature does not claim exactly-once OS alert presentation.

## Verification

- `unread-state.test.ts`: private horizons, sparse counts, epochs, isolated summary writes, local
  rehydration after real eviction, atomic read/summary rollback, missing-summary reconstruction,
  unavailable workspaces, authorization and dismissed-listing catch-up.
- `unread-outbox.test.ts`: checkpoint fanout, lost ACKs, failed checkpoint writes, real DO eviction,
  per-recipient capped backoff across eviction, healthy-reader isolation and durable deletion,
  including in-flight agent/gate races. No alert replay.
- `workshop-unread.test.ts`: validated WebSocket API with two owner devices and build/use readers;
  live fanout, private reads, rename and deletion without polling/reopening.

Useful commands (workerd tests require local loopback sockets):

```sh
pnpm exec vp run -F @gadgets/workshop-backend -F @gadgets/workshop-shared build
pnpm --filter @gadgets/workshop-backend exec vitest run __tests__/unread-state.test.ts __tests__/unread-outbox.test.ts
pnpm exec vp run -F @gadgets/integration-tests build:test-gatekeeper
pnpm --filter @gadgets/integration-tests exec vitest run __tests__/workshop-unread.test.ts
```
