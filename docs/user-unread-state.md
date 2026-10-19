# User-owned unread state

The User DO owns private read horizons and derived counts. The workspace owns the ordered
timeline. No read receipts are exposed to other users. See [the UI consumers](user-unread-ui.md)
for inbox, viewport and native bridge behavior.

Open [the four-slide walkthrough](user-unread-flow.html) in a browser for the dirty-bit,
processing, clearing and restart flow.

## Stored state

Each User DO stores one `chatReadCursors` row per thread:

- `workspaceId`, `chatId`
- `readThroughSequence`: inclusive read horizon; -1 means nothing read
- `unreadCount`: absolute count of visible messages after the horizon, not sequence subtraction
- `notifiedThroughSequence`: inclusive notification horizon; earlier candidates were delivered or policy-skipped
- `unreadDirty`, `notificationsDirty`: coalesced pending work

There are no workspace summary blobs, persisted read epochs, source versions, reader enrollment
records, workspace-side recipient checkpoints or audit log. Counts hydrate into memory from these
local rows once per User DO lifetime; normal badge calculations use that memory, not cross-workspace
history scans. Badge snapshots and subscriptions read only those local rows, including after eviction;
they never enumerate workspaces or initialize historical threads. Thread-list titles/previews and
observed menu-command boundaries use a separate authorized workspace query. A metadata failure
does not invalidate badge totals.

Rollout does not backfill unread history. The existing workspace schema migration captures
`nextChatId` as `legacyUnreadChatIdLimit`, without scanning chats or contacting users. New threads
start at read/notification horizon -1. For an old thread with no cursor, metadata-only changes do
nothing. The first new message carries its sequence on the existing source dirty record and then
on the recipient's dirty cursor. The normal count RPC makes one backwards seek for the preceding
visible message, initializes both horizons there, and counts the new tail in that same RPC.
The first sequence survives coalescing and resets, so all new messages in a batch remain unread.
Committing the initial count/horizons removes that temporary cursor field; subsequent deliveries
never repeat the initialization seek. Existing cursors retain their horizons. Successful first
admission to a shared workspace starts at the existing callback's captured tail, with historical
messages read and alerts skipped; subsequent arrivals are reconciled by the same processor.
An ordinary reopen does not initialize missing cursors from a fresh tail; it only resumes
already-tracked dirty work. This preserves new activity whose first fanout is still pending.

Only visible text/attachments count. Tool/reasoning records, empty messages and generated
slash-command expansions do not. Streaming tokens are not separate messages. Horizons may lie
between visible messages, so gaps in sequence numbers do not inflate counts.

## New message: durable handoff before ACK

1. The workspace commits the timeline change and a `dirtyChats` bit together. It arms its existing
   shared alarm before crossing an async dispatch boundary.
2. It dispatches `UserDO.messageArrived(workspaceId, chatId)` in parallel to the owner and established build
   collaborators, with independent dirty threads also dispatched in parallel. One unavailable
   recipient leaves that thread's bit set; healthy recipients/threads proceed.
   In-flight handoffs coalesce per thread, so even a newly dirty thread does not wait for another's alert.
3. The User DO persists dirty intent and, if admitted, an alarm, then acquires the thread's single mutex. It reads
   the current horizons and fetches the absolute count and notification
   candidates together. It commits the count, delivers notifications in order, and persists each
   successful delivery horizon. New dirtiness during an await stays pending for the next mutex holder.
4. After releasing the mutex, subscribers receive committed state and in-memory badge totals.
   The source ACK requires a durable count; failed notification delivery stays dirty for the user's
   alarm. A denied thread instead ACKs its durable pending intent and waits for re-admission.
5. The workspace clears the bit only after all recipients ACK, and only if no newer mutation
   occurred during the RPCs. A retry recounts; it never blindly increments a count.

After a successful pass, newer pending mutations get the normal one-second alarm; the
30-second backoff is reserved for failed delivery. Recounts scan the unread timeline tail per
recipient. An incremental count/index would be a separate performance change, not part of this model.

No input gate is held across source-to-user RPC: the User DO must be able to call back into the
workspace. In-memory promises/tokens serialize and coalesce live work only; persisted dirty bits
and the existing shared alarms recover after eviction, including an ACK lost after commit.
Constructor recovery preserves an existing alarm rather than resetting the platform retry budget.
Unrelated activity also preserves an already scheduled retry deadline, so a busy thread cannot
keep postponing another thread's failed notification delivery.

Initialization, dirty processing, notifications and read commands use one processor and
one in-memory mutex per thread, held across fetches and delivery. Waiters recheck the cursor after
acquiring it, so clean threads need no calculation. A reset discards the mutex and its holder;
persisted dirty bits and alarms restart unfinished work without a durable lock to strand.
Snapshots do not acquire that mutex or contact the source: they report the last committed local state.
The in-memory membership entry also identifies that listing's lifetime: removal invalidates queued
or in-flight work, so an old response cannot recreate cursors after a later readmission.

Read commands count first, then commit horizon and count in one synchronous update. Commands are
processed in per-thread mutex order: mark-read only advances the horizon, while mark-unread sets
the requested boundary and may rewind it. There are no receipt tokens or expected-old-horizon
checks. A delayed read can clear a manual unread if processed afterward; an older read cannot
move the horizon backward. Receipts may include trailing non-countable timeline items; the source's
actual timeline tail bounds validation, while its latest visible message controls unread navigation.
Identical horizons are no-ops. Reading snapshots or reopening an
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
Read commands do not consume pending alerts, even when creating the cursor before first fanout.
One source RPC returns both counts and candidates. If only notification delivery remains dirty,
that same RPC skips the unread-history count. There is no separate notification processor or mutex.

This is not exactly-once OS alert delivery: provider effects and acknowledgement cannot be
atomically committed with a User DO row. The central service's existing reservation/dedup policy
still governs that ambiguity. Versioned native/push badge replacements are a separate consumer
layer in [the stacked badge PR](https://github.com/cloudflare/cloudflare-os/pull/842), not part of
this core change; no unread source/read versions are introduced.

## Authorization and lifecycle

Fanout never calls `authorizeCollaborator`/`ensureObserver`. Metadata checks current build
membership and the observer admission already established by opening a workspace; a new
gatekeeper binding requires fresh interactive admission. Existing sessions' lazy external ACL
revocation semantics are retained, not replaced with per-message gatekeeper registrations.
Badge reads use last-known local access, updated by message processing and existing revocation callbacks.
Admission denial is distinct from deletion: it hides counts but preserves private horizons
and durable dirty work. Before first initialization, a source returns an empty head list rather than
denying the owner's provisional listing. Confirmed denial parks the work without polling; new arrivals still journal
their dirty bits. Successful authorization/reopening resumes the same processor. Credential
restoration also requests a fresh access check, not an authorization grant. A DO restart forgets
the in-memory denial and checks once again. Transient failures retain alarm retries. Reopening
still uses the existing best-effort callback, not a new durable re-authorization handoff.
Initial enrollment does not guarantee coverage of events racing that callback, including a
thread created after its captured thread list but delivered before the User DO records the listing.
Once registration completes, new arrivals follow the normal durable handoff. There is no
additional admission catch-up RPC or durable enrollment workflow.
Use-only/unlisted users receive no thread metadata. Existing sharing/listing cleanup removes
their local state on downgrade/revocation/dismissal; thread deletion removes its cursor and
notification candidates. Workspace deletion first journals dirtiness in the readers' own DOs
before destroying the source; their alarms can finish cleanup even after the source disappears.

## Verification

`packages/workshop-backend/__tests__/unread-state.test.ts` covers sparse counts, atomic horizon/count
updates, no-op reads, local count rehydration, single-thread deltas, real source/User DO eviction,
lost source ACKs, concurrent dirtiness, ordered notification catch-up, lost alert ACKs and mute.
`notifications.test.ts` covers the signed service protocol and notification delivery. Badge retry
outbox coverage is added by the stacked badge PR.
`packages/integration-tests/__tests__/workshop-unread.test.ts` exercises the real WebSocket API,
two devices, collaborators, partial reads, title changes and deletion.
