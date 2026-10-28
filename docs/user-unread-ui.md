# Unread state consumers

The web UI consumes the [unread-state API](user-unread-state.md), without calculating independent
unread counts or persisting a second set of read horizons. First-party native forwarding is added
in [the stacked badge PR](https://github.com/cloudflare/cloudflare-os/pull/842).

## Web experience

- One User DO subscription follows the active view: rollups only on ordinary pages, one workspace's
  thread statuses in its editor, or unread-only rows in the inbox. Global/sidebar workspace badges
  use rollups, not the user's historical thread rows. Returning, reconnecting or changing views
  replaces the subscription with the same explicit scope; stale callbacks cannot replace new data.
- Unread threads opens a live, newest-first inbox with a one-line latest-message preview, direct
  thread links, an empty state and Mark all read. Browsing it does not read threads. Previews arrive
  from `getUnreadThreads()` on the User DO, refreshed by live count/title updates. Loading the inbox
  never queries Workspace DOs. Its observed latest positions also avoid another metadata fetch for
  Mark all read; the read command still authorizes/translates the boundary at the source.
- Thread menus offer Mark thread read/unread; workspace menus offer Mark workspace read. The latter
  fetches that workspace's statuses only when invoked, then submits observed unread boundaries.
- Each rendered timeline item offers Mark unread from here. The new-items divider moves there.
  A local mark-unread keeps the viewed item in place rather than initiating a history jump.
- Opening an unread thread loads checkpoint history back to its first unread item and positions
  it in view. Failed history loads keep automatic receipts paused; Jump to first unread retries
  the load, and explicit Mark thread read can release it. Jump remains available as the pointer
  advances. Live horizon changes and reconnect snapshots never initiate another scroll; automatic
  positioning happens only on thread entry, and subsequent jumps require the explicit button.
- Automatic reads require a visible document, focused window, visible chat pane and an item's
  bottom edge in the scroll viewport. Fetching/opening a history page alone never reads it.
  Bookkeeping can extend an item's receipt range, but divider placement and first-unread navigation
  use its countable text/attachment boundary, not trailing observations or checkpoints.
- The visit's divider stays after reading, showing where new activity began. Explicit mark-unread
  pauses automatic reads in already-open views until leaving/re-entering the thread or explicitly
  marking it read. This prevents immediate accidental acknowledgement, but does not cancel
  already-dispatched reads; a later-processed read can clear the manual unread.
  The mark-unread result distinguishes a changed horizon from a no-op, so a missing local echo
  cannot mask a later remote rewind. If the subscription reconnects while that command is pending,
  refresh it once after the ACK before relying on its replacement snapshot; ordinary deltas do not
  cause another request.
- Failed read commands display an error without pretending the state advanced. An inbox query
  failure retains its previous rows and offers retry; it does not present an empty inbox as caught up.

`UnreadStateBridge` releases its live callback while hidden, and refreshes on return or transport/DO
reset. Unread support therefore adds no hidden-tab callback keeping the User DO resident. Background native badges use the
separate push-service path; hidden windows never issue automatic read receipts.
`NotificationBridge` also retains its independent alert subscription while hidden, but rejects
hidden toast delivery so the existing mobile-push fallback still works. Receiving an unread
snapshot does not acknowledge an alert or replay one. The WebSocket reconnects independently of
page visibility.

## Native integration scope

This layer exposes unread state to the web UI, but does not forward snapshots to native hosts.
Native badge forwarding and its bridge contract are a separate consumer layer. Native clients
must use complete absolute totals rather than message increments; an unavailable total or
disconnect is stale/unknown, not zero.

The Electron callback implementation, OS badge/alert presentation and permissions, and retaining
instance webviews when the window closes to the tray are separate desktop-shell work. This bridge
does not prevent OS suspension/termination, deliver after full Quit, or alter APNs payloads.

## Verification

Frontend tests cover subscription/retry lifecycle, history navigation, unread actions and inbox
state. Chromium tests cover actual viewport geometry, focus, pointer input and badge layout.

```sh
pnpm --filter @gadgets/workshop-frontend test:run
pnpm --filter @gadgets/workshop-frontend exec playwright install chromium --only-shell
pnpm --filter @gadgets/workshop-frontend test:run:browser
```

On Node versions that expose experimental global Web Storage without a backing file, run jsdom
tests with `NODE_OPTIONS=--no-experimental-webstorage` so jsdom supplies its own localStorage.
