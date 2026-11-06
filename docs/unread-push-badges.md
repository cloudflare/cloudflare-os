# Unread badges in native apps and push

This consumes the User DO's authoritative unread totals described in
[user unread state](user-unread-state.md).

## Foreground / desktop

The frontend's optional version-1 `cloudflareOSNative.unreadStateChanged({unreadMessageCount})` bridge feeds
complete absolute totals to native apps. Native clients sum their saved instances' last complete
totals; they never increment counters from individual messages. A retained native view with this
badge bridge keeps its unread subscription while hidden, without becoming visible or acknowledging
reads or alerts. Ordinary browser and legacy views release it while hidden and refresh on return.
Retaining the subscription keeps its User DO subscriber and unread callbacks active for each
retained view, including while the desktop window is hidden. Desktop needs those updates to
refresh system badges while its web view runs in the background; visibility-gated subscriptions
would leave badges stale until the window returns. This does not change WebSocket visibility
policy. Push handles updates when the operating system suspends the app.
Explicit logout invokes optional `sessionEnded()` so the shell can remove that instance's contribution.

## Push while native apps are asleep

1. A message fanout or read-horizon change updates the User DO's existing unread view.
2. With registered phone notification devices, a complete changed total writes `notificationBadge`:
   `{version, count, retryAt, expiresAt}`. This scalar is a durable outbox, not a second unread cache.
3. The existing User DO alarm signs `POST /v1/badges` to the notification service, with body
   `{subscriptionId, version, count}`. The signing canonicalization is the same as deliveries,
   with `/v1/badges` as the signed path. Count is an absolute integer in `0..2147483647`.
4. The service replaces the device's total for that enrolled installation, ignoring older/equal
   versions, sums the device's installations, and durably queues a provider badge replacement.
5. APNs applies `aps.badge`, including zero, without a banner or sound. FCM delivers a data-only
   `badge_updated` message to Android's existing opt-in notification receiver.

Badge delivery is independent of visible-browser alert acknowledgement and notification mute settings:
reading on another device must clear an icon even when no alert is sent.

## Recovery and rollout

The User DO persists a new version before any HTTP effect and a 30-second retry deadline before
dispatch. Lost ACKs replay only versioned replacements, never alert deliveries. The version is
durable and must not reset at eviction. New device
enrollment forces an initial complete snapshot. Dead subscriptions are removed only if they have
not been replaced while the request was in flight.

Each replacement retries for at most ten minutes, matching the alert retry lifetime. Expiry clears
the pending retry while retaining its version and count; eviction and failed attempts do not extend
the deadline. After a longer outage, a sleeping device's badge can remain stale until the next count
change or phone enrollment starts a fresh replacement. Browser push registration does not queue
badge work, and browser subscriptions receive alerts only.

The notification service needs the matching `/v1/badges` implementation before deploying this
producer. Foreground badge updates work without push.

Tests cover message-to-outbox propagation, read-to-zero, real User DO eviction, lost ACK retry and expiry,
request signing and confirmed sign-out versus transient reconnect.
