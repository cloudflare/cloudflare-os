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
snapshot reconstructs missed changes. These callbacks are live hints backed by durable state, not
a replayable alert log. Keep state scoped to the instance and authenticated user.

Reads use the sequence actually observed, never a server-side "latest now". Workspace/all-read
commands submit the boundaries from their observed snapshot, preserving activity that arrives
while the command is in flight. Reads only advance. Explicit unread increments `readEpoch`;
automatic receipts and duplicate unread requests carrying the previous epoch are ignored. Thus
an old window cannot immediately clear a deliberate unread marker, and lost-ACK retries are safe.

## Web experience

- Thread list, workspace list and sidebar indicators use the same authoritative snapshot.
- The aligned Unread threads navigation opens a live, newest-first inbox, with a one-line latest
  message preview, direct thread links, an empty state and Mark all read. Browsing it doesn't read
  threads. Previews arrive with the reconstructed counts, not through a separate hydration flow.
- Thread menus offer Mark thread read/unread; workspace menus offer Mark workspace read.
- Each rendered timeline item offers Mark unread from here. The new-items divider moves there.
- Opening an unread thread loads checkpoint history back to its first unread item and positions
  it in view. Failed history loads keep automatic receipts paused; Jump to first unread retries
  the load, and explicit Mark thread read can release it. Jump remains available as the pointer
  advances.
- Automatic reads require a visible document, focused window, visible chat pane and an item's
  bottom edge in the scroll viewport. Fetching/opening a history page alone never reads it.
- The visit's divider stays in place after reading, showing where new activity began. Explicit
  mark-unread pauses automatic reads in every already-open view until leaving/re-entering the
  thread or explicitly marking it read. This prevents immediate accidental acknowledgement.
- Failed read commands leave durable state authoritative and display an error. Hidden windows
  retain subscriptions without issuing read receipts.

`NotificationBridge` also retains its independent alert subscription while hidden, but rejects
hidden toast delivery so the existing mobile-push fallback still works. Receiving a snapshot does
not acknowledge an alert. The underlying WebSocket reconnects independently of page visibility.

## Persistence and reset recovery

The User DO persists only private consumption horizons (`workspaceId`, `chatId`,
`readThroughSequence`, `readEpoch`) for this feature. It caches those horizons in memory, alongside
latest heads, counts through each horizon, previews, source-version fences and subscription
revisions. Message arrivals do not write user SQLite. Reading through the latest cached message
requires only a horizon write; a partial read/rewind resolves its sparse sequence through the
authorized workspace before writing. Badge calculation and snapshot construction are in-memory.
The prototype's durable head rows on existing test installs are migrated to horizon-only rows on wake.

A cold User DO fetches current heads and counts through its saved horizons from listed workspaces,
using their build-role/observer authorization gate. An initial subscription waits for those loads.
Reconstruction also idempotently enrolls the user for future workspace deliveries, so shared
listings saved before this feature receive updates without reopening the workspace.
Reopening a shared workspace explicitly queues catch-up after restoring its listing, even when
already enrolled: dismissing the listing discards the warm User DO's unread projection.
One failing workspace does not block healthy ones: `unavailableWorkspaceIds` explicitly reports
missing heads, and aggregate counts are lower bounds, not a claim that missing threads are read.
The web client shows a status and retries with backoff; incomplete totals do not replace native
badges. Incoming updates join reconstruction, then apply only if their source
version is newer. A cold rebuild reads the authoritative log, so lost deliveries, coalesced
messages and stale retries cannot lose counts or resurrect an old head. Failures remain failures,
not read receipts. Bulk read applies healthy workspaces' horizons but reports a failed lookup to
the caller; a monotonic retry is safe. There is deliberately no durable latest-message/thread-list
replica in the User DO yet: complete counts depend on workspace availability.

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
the same drain; the persisted 30-second deadline survives resets. Lost ACKs/checkpoint-write
failures safely retry because the receiver fences source versions. Callback failures do not
roll back read cursors.

Workspace deletion persists its intent before removing any user's listing and read state. It
uses the same reader rows, without requiring observer access for removal: a row is deleted only
after that User DO acknowledges cleanup. The listing removal fences delayed snapshots; only after
every row is removed does the Overseer delete its own storage. The input gate protects only
deletion intent: it never joins cross-DO delivery, which may call back into the workspace. The request
waits for the owner's listing cleanup, not unhealthy collaborators; the durable alarm finishes
their cleanup. Alarms resume interrupted deletion without another user action,
and a deleting workspace refuses new opens, agent callbacks and turn starts. Queued callbacks
remain untouched until cleanup removes the source storage; recovery alarms and continuations
returning from model lookup or message preparation cannot resume work during deletion.

Only the read-state projection is replayed. Existing transient toast/mobile-push sends are not
blindly retried, and this feature does not claim exactly-once OS alert presentation.

## Native contract and scope

The first-party native bridge can optionally implement:

```ts
cloudflareOSNative.unreadStateChanged(state: UserUnreadState): void;
```

`UnreadStateBridge` forwards every newer complete snapshot, including while hidden. The native host must
associate it with its verified first-party main frame and saved instance/user, never a claimed
instance or gadget frame. Use `unreadMessageCount` for that instance, and sum authenticated instance
counts for an OS badge. A disconnect is stale/unknown, not zero; logout/removal clears that
instance's native badge. Do not log chat titles.

The Electron callback implementation, OS badge/alert presentation and permissions, and retaining
instance webviews when the window closes to the tray are separate desktop-shell work. This core
branch does not prevent OS suspension/termination, deliver after full Quit, or alter APNs payloads.

## Verification

- `unread-state.test.ts`: private horizons, sparse counts, epochs, no arrival writes, reconstruction,
  unavailable workspaces, authorization and dismissed-listing catch-up.
- `unread-outbox.test.ts`: checkpoint fanout, lost ACKs, failed checkpoint writes, real DO eviction,
  retry isolation and durable deletion, including in-flight agent/gate races. No alert replay.
- `workshop-unread.test.ts`: validated WebSocket API with two owner devices and build/use readers;
  live fanout, private reads, rename and deletion without polling/reopening.
- Frontend tests cover subscription/retry lifecycle, history navigation, unread actions and inbox
  state. Chromium covers actual viewport geometry, focus, pointer input and badge layout.

Useful commands (workerd tests require local loopback sockets):

```sh
pnpm exec vp run -F @gadgets/workshop-backend -F @gadgets/workshop-frontend -F @gadgets/workshop-shared build
pnpm --filter @gadgets/workshop-frontend exec vitest run src/features/notifications
pnpm --filter @gadgets/workshop-frontend exec playwright install chromium --only-shell
pnpm --filter @gadgets/workshop-frontend exec vitest run -c vitest.browser.config.ts
pnpm --filter @gadgets/workshop-backend exec vitest run __tests__/unread-state.test.ts __tests__/unread-outbox.test.ts
pnpm exec vp run -F @gadgets/integration-tests build:test-gatekeeper
pnpm --filter @gadgets/integration-tests exec vitest run __tests__/workshop-unread.test.ts
```

On Node versions that expose experimental global Web Storage without a backing file, run jsdom
tests with `NODE_OPTIONS=--no-experimental-webstorage` so jsdom supplies its own localStorage.
