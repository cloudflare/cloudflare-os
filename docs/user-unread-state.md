# Timeline read state

Branch: `ddr/user-unread-state`. Core/API and first-party web UI, independent of the desktop
updater and experimental Computer Operator.

## Semantics

Each user has an inclusive read pointer into each thread's persisted, ordered timeline. A thread
is unread when its latest sequence exceeds that pointer. Workspace and instance badges count
unread **threads**, not messages or outstanding approvals. Reading a permission request does not
approve it. Toast/push delivery neither creates nor clears read state.

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

```ts
type ChatReadState = {
  workspaceId: string;
  chatId: number;
  chatTitle: string;
  latestSequence: number;      // -1 for an empty thread
  latestMessagePreview?: string; // bounded first line of visible chat text
  latestActivityAt?: Date;
  readThroughSequence: number; // inclusive; -1 means nothing read
  readEpoch: number;
};

type ChatReadReceipt = Pick<ChatReadState, "workspaceId" | "chatId" | "readEpoch"> & {
  throughSequence: number;
};

type UserUnreadState = {
  revision: number;
  unreadChatCount: number;
  chats: ChatReadState[]; // all tracked threads, including read ones
};

interface UnreadStateSubscriber {
  updated(state: UserUnreadState): Promise<void>;
}

getUnreadState(): Promise<UserUnreadState>;
subscribeToUnreadState(subscriber: RpcStub<UnreadStateSubscriber>): Promise<RpcStub<{}>>;
markChatRead(receipt: ChatReadReceipt): Promise<void>;
markChatsRead(receipts: ChatReadReceipt[]): Promise<void>;
markChatUnread(workspaceId: string, chatId: number, fromSequence: number,
               readEpoch: number): Promise<void>;
```

Subscribe directly: registration installs the listener before sending the initial full snapshot,
avoiding a fetch/watch gap. Snapshots replace previous state; ignore older/equal revisions. Retain
the handle while hidden, until logout/shutdown. Resubscribe after transport/DO reset; the initial
snapshot reconstructs missed changes. These callbacks are live hints backed by durable state, not
a replayable alert log. Store watermarks per instance and authenticated user.

Reads use the sequence actually observed, never a server-side "latest now". Workspace/all-read
commands submit the boundaries from their observed snapshot, preserving activity that arrives
while the command is in flight. Reads only advance. Explicit unread increments `readEpoch`;
automatic receipts and duplicate unread requests carrying the previous epoch are ignored. Thus
an old window cannot immediately clear a deliberate unread marker, and lost-ACK retries are safe.

## Web experience

- Thread list, workspace list and sidebar indicators use the same authoritative snapshot.
- The aligned Unread threads navigation opens a live, newest-first inbox, with a one-line latest
  message preview, direct thread links, an empty state and Mark all read. Browsing it doesn't read
  threads. Pre-upgrade entries refresh through the authorized workspace-open path, four at a time,
  with retry on failure or after 15 seconds without a delivered preview; workspace capabilities
  are released after the open RPC completes. The workspace-open ACK alone is not a delivery receipt.
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

The User DO owns cursors, manual-unread epochs, a global snapshot revision and per-workspace
source-version fences. New source versions replace timeline heads without resetting read
pointers. Equal/older versions are ignored, including delayed snapshots preceding a deletion.
Unchanged public heads advance their source fence without generating redundant callbacks.
The same journal carries a 240-character first-line preview and latest activity time. Reasoning,
tool-only entries and internal slash-command expansions aren't preview text; previews are plain
text, not rendered HTML. Preview edits update the projection without moving read cursors.

The Overseer journals a dirty version in the same transaction as timeline writes. Typed-storage
subscribers run **before** their write and may run inside an existing KV iterator: they must not
enumerate recipients or construct snapshots. A deferred drain reads committed state, fans out
durable pending versions, and arms a fallback alarm before its first RPC. A constructor recovers
persisted dirtiness if the source invocation was interrupted before fanout.

Each recipient has one coalesced pending version. Delivery rechecks current authority, captures
the committed head set and source version together, and awaits the User DO's durable receipt
before deleting that version. Writes during an in-flight RPC remain dirty/pending and are drained
again. A failed recipient stays queued without blocking other recipients or spinning in the same
drain. Failures persist a 30-second retry deadline in the shared alarm. A lost response,
or interruption after ACK before cleanup, retries the same version safely. In-memory drains and
subscriptions are disposable. Callback failure never rolls back a cursor.

Workspace deletion persists its intent before removing any user's listing and read state. It
uses the same recipient journal, without requiring observer access for removal. The listing
removal fences delayed snapshots; only after every tracked recipient acknowledges cleanup does
the Overseer delete its own storage. Alarms resume interrupted deletion without another user action,
and a deleting workspace refuses new opens and does not resume agent turns.

Only the read-state projection is replayed. Existing transient toast/mobile-push sends are not
blindly retried, and this feature does not claim exactly-once OS alert presentation.

## Native contract and scope

The first-party native bridge can optionally implement:

```ts
cloudflareOSNative.unreadStateChanged(state: UserUnreadState): void;
```

`UnreadStateBridge` forwards every newer snapshot, including while hidden. The native host must
associate it with its verified first-party main frame and saved instance/user, never a claimed
instance or gadget frame. Use `unreadChatCount` for that instance, and sum authenticated instance
counts for an OS badge. A disconnect is stale/unknown, not zero; logout/removal clears that
instance's native badge. Do not log chat titles.

The Electron callback implementation, OS badge/alert presentation and permissions, and retaining
instance webviews when the window closes to the tray are separate desktop-shell work. This core
branch does not prevent OS suspension/termination, deliver after full Quit, or alter APNs payloads.

## Verification

Unit/component tests cover partial and bulk reads, source ordering, manual-unread epochs,
cross-device updates, initial history baselines, user/role isolation, deletion, viewport visibility,
history loading, reset resubscription and cleanup. Recovery tests exercise real DO eviction before
dispatch, a lost ACK, and interruption after ACK before outbox cleanup, without repeating alerts.
Deletion recovery covers those boundaries and interruption before workspace storage deletion.
The integration test drives the real validated Cap'n Web API through two owner WebSocket sessions,
a build collaborator and a use-only collaborator, including appends, rename and deletion.
Chromium tests verify actual viewport geometry, focus, and pointer input for marking unread.

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
