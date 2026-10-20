# Unread state consumers

The web UI consumes the [unread-state API](user-unread-state.md), without calculating independent
unread counts or persisting a second set of read horizons. First-party native forwarding is added
in [the stacked badge PR](https://github.com/cloudflare/cloudflare-os/pull/842).

## Web experience

- Thread list, workspace list and sidebar indicators use the same User DO snapshot.
- Unread threads opens a live, newest-first inbox with a one-line latest-message preview, direct
  thread links, an empty state and Mark all read. Browsing it does not read threads. Previews arrive
  with the counts, not through a separate hydration flow.
- Thread menus offer Mark thread read/unread; workspace menus offer Mark workspace read.
- Each rendered timeline item offers Mark unread from here. The new-items divider moves there.
  A local mark-unread keeps the viewed item in place rather than initiating a history jump.
- Opening an unread thread loads checkpoint history back to its first unread item and positions
  it in view. Failed history loads keep automatic receipts paused; Jump to first unread retries
  the load, and explicit Mark thread read can release it. Jump remains available as the pointer
  advances.
- Automatic reads require a visible document, focused window, visible chat pane and an item's
  bottom edge in the scroll viewport. Fetching/opening a history page alone never reads it.
  Bookkeeping can extend an item's receipt range, but divider placement and first-unread navigation
  use its countable text/attachment boundary, not trailing observations or checkpoints.
- The visit's divider stays after reading, showing where new activity began. Explicit mark-unread
  pauses automatic reads in already-open views until leaving/re-entering the thread or explicitly
  marking it read. This prevents immediate accidental acknowledgement, but does not cancel
  already-dispatched reads; a later-processed read can clear the manual unread.
- Failed read commands display an error without pretending the state advanced. Missing workspace
  summaries show a status and retry with backoff; incomplete totals do not replace native badges.

`UnreadStateBridge` releases its live callback while hidden, and refreshes on return or transport/DO
reset. Unread support therefore adds no hidden-tab callback keeping the User DO resident. Background native badges use the
separate push-service path; hidden windows never issue automatic read receipts.
`NotificationBridge` also retains its independent alert subscription while hidden, but rejects
hidden toast delivery so the existing mobile-push fallback still works. Receiving an unread
snapshot does not acknowledge an alert or replay one. The WebSocket reconnects independently of
page visibility.

## Native contract and scope

The first-party native bridge can optionally implement:

```ts
cloudflareOSNative.unreadStateChanged(state: UserUnreadState & { revision: number }): void;
cloudflareOSNative.sessionEnded(): void;
```

The bridge forwards complete visible-session updates. Its revision is a web-view-local compatibility
counter, not a persisted unread version. The native host
must associate it with its verified first-party main frame and saved instance/user, never a claimed
instance or gadget frame. Use `unreadMessageCount` for that instance, and sum authenticated instance
counts for an OS badge. A disconnect is stale/unknown, not zero; logout/removal clears that
instance's native badge. Do not log chat titles.

`sessionEnded()` is called on explicit logout or a confirmed non-user identity, not on a transient
reconnect. It lets the host remove that instance's contribution. Both callbacks are optional;
a native bridge failure must not prevent browser logout.

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
