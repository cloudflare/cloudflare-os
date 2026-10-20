# User-owned unread state

The User DO owns private read horizons and derived counts. The workspace owns the ordered
timeline. No read receipts are exposed to other users.

Open [the four-slide walkthrough](user-unread-flow.html) in a browser for the dirty-bit,
processing, clearing and restart flow.

## Stored state

Each User DO stores one `chatReadCursors` row per thread:

- `workspaceId`, `chatId`
- `readThroughSequence`: inclusive read horizon; -1 means nothing read
- `unreadCount`: absolute count of visible messages after the horizon, not sequence subtraction
- `notifiedThroughSequence`: last acknowledged or policy-skipped notification candidate
- `unreadDirty`, `notificationsDirty`: coalesced pending work

There are no workspace summary blobs, persisted read epochs, source versions, reader enrollment
records, workspace-side recipient checkpoints or audit log. Counts hydrate into memory from these
local rows once per User DO lifetime; normal badge calculations use that memory, not cross-workspace
history scans. Display metadata is fetched separately and remains in memory: loading a full thread
list still contacts its workspaces. A first visit with no existing row
calculates an initial count in memory; reads alone do not persist it. The next message or explicit
horizon change persists the row. Explicit admission to a shared workspace also persists its initial
notification horizon, so dismissal/reopening cannot replay old alerts after eviction. Existing
history is initially unread.

Only visible text/attachments count. Tool/reasoning records, empty messages and generated
slash-command expansions do not. Streaming tokens are not separate messages. Horizons may lie
between visible messages, so gaps in sequence numbers do not inflate counts.

## New message: durable handoff before ACK

1. The workspace commits the timeline change and a `dirtyChats` bit together. It arms its existing
   shared alarm before crossing an async dispatch boundary.
2. It awaits `UserDO.messageArrived(workspaceId, chatId)` for the owner and established build
   collaborators. One unavailable recipient leaves the bit set; healthy recipients/threads proceed.
3. The User DO persists dirty intent and an alarm, then serializes recounts and read commands for
   that thread. It fetches the authoritative absolute count and bounded latest-message metadata
   from the workspace, and persists the new count before acknowledging. When admission is denied,
   the ACK instead confirms durable pending intent; recount waits for re-admission.
4. Badges are summed in memory. Visible subscribers receive one changed thread plus totals.
   Notification catch-up runs independently against its own horizon.
5. The workspace clears the bit only after all recipients ACK, and only if no newer mutation
   occurred during the RPCs. A retry recounts; it never blindly increments a count.

No input gate is held across source-to-user RPC: the User DO must be able to call back into the
workspace. In-memory promises/tokens serialize and coalesce live work only; persisted dirty bits
and the existing shared alarms recover after eviction, including an ACK lost after commit.
Constructor recovery preserves an existing alarm rather than resetting the platform retry budget.
Unrelated activity also preserves an already scheduled retry deadline, so a busy thread cannot
keep postponing another thread's failed notification delivery.

Snapshot initialization, dirty recounts and read-horizon changes share one in-memory mutex per
thread, held across awaits. Waiters recheck the cursor after acquiring it, so an earlier completed
recount is not repeated unless new dirtiness arrived. A reset discards both the mutex and its
holder; persisted dirty bits and alarms restart unfinished work without a durable lock to strand.

Read commands count first, then commit horizon and count in one synchronous update. Commands are
processed in per-thread mutex order: mark-read only advances the horizon, while mark-unread sets
the requested boundary and may rewind it. There are no receipt tokens or expected-old-horizon
checks. A delayed read can clear a manual unread if processed afterward; an older read cannot
move the horizon backward. Identical horizons are no-ops. Reading snapshots or reopening an
already-listed workspace does not rewrite read rows or notify other collaborators. Hidden web clients release their live
callbacks and resubscribe for a fresh snapshot when visible; background native updates use push.

## Ordered notifications

The existing policy remains task completion and permission requests, not an alert per visible
message. The workspace keeps a small `chatNotifications` eligibility index at existing timeline
positions: recipient, kind and stable UUID. It copies no message bodies. Recording eligibility
also dirties the thread. Recovery of the same logged outcome reuses its candidate/UUID.

The User DO fetches candidates after `notifiedThroughSequence`, in order. For each candidate it
awaits delivery (or an intentional policy skip such as mute), then persists the horizon. Three
coalesced candidates still produce three delivery attempts. A reset/lost ACK retries the same
UUID, so the notification service's existing deduplication boundary can recognize it.

This is not exactly-once OS alert delivery: provider effects and acknowledgement cannot be
atomically committed with a User DO row. The central service's existing reservation/dedup policy
still governs that ambiguity. The existing versioned native/push badge-replacement wire protocol
is separate from read state; no unread source/read versions are introduced.

## Authorization and lifecycle

Fanout never calls `authorizeCollaborator`/`ensureObserver`. Metadata checks current build
membership and the observer admission already established by opening a workspace; a new
gatekeeper binding requires fresh interactive admission. Existing sessions' lazy external ACL
revocation semantics are retained, not replaced with per-message gatekeeper registrations.
Admission denial is distinct from deletion: it hides metadata/counts but preserves private horizons
and durable dirty work. New arrivals still journal their dirty bits. Authorized reopening refreshes
metadata, recounts pending messages, and resumes notifications from `notifiedThroughSequence`.
Use-only/unlisted users receive no thread metadata. Existing sharing/listing cleanup removes
their local state on downgrade/revocation/dismissal; thread deletion removes its cursor and
notification candidates. Workspace deletion first journals dirtiness in the readers' own DOs
before destroying the source; their alarms can finish cleanup even after the source disappears.

## Verification

`packages/workshop-backend/__tests__/unread-state.test.ts` covers sparse counts, atomic horizon/count
updates, no-op reads, local count rehydration, single-thread deltas, real source/User DO eviction,
lost source ACKs, concurrent dirtiness, ordered notification catch-up, lost alert ACKs and mute.
`notifications.test.ts` covers the signed service protocol and badge retry outbox.
`packages/integration-tests/__tests__/workshop-unread.test.ts` exercises the real WebSocket API,
two devices, collaborators, partial reads, title changes and deletion.
