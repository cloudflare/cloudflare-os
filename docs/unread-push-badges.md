# Unread badges in native apps and push

This is a consumer of the unread state in `docs/user-unread-state.md`. It does not add another
read horizon, count database, or message fanout. The User DO remains authoritative for its user's
per-install total. A snapshot with unavailable workspaces is a lower bound, not a replacement.

## Foreground / desktop

The frontend's optional version-1 `cloudflareOSNative.unreadStateChanged(snapshot)` bridge feeds
complete absolute totals to native apps. Native clients sum their saved instances' last complete
totals; they never increment counters from individual messages. The frontend keeps its unread
subscription while hidden. A confirmed sign-out invokes optional `sessionEnded()` so the shell
can remove that instance's contribution. A reconnect is not a sign-out.

## Push while native apps are asleep

1. A message fanout or read-horizon change updates the User DO's existing unread view.
2. With registered notification devices, a complete changed total writes `notificationBadge`:
   `{version, count, retryAt}`. This scalar is a durable outbox, not a second unread cache.
3. The existing User DO alarm signs `POST /v1/badges` to the notification service, with body
   `{subscriptionId, version, count}`. The signing canonicalization is the same as deliveries,
   with `/v1/badges` as the signed path. Count is an absolute integer in `0..2147483647`.
4. The service replaces the device's total for that enrolled installation, ignoring older/equal
   versions, sums the device's installations, and durably queues a provider badge replacement.
5. APNs applies `aps.badge`, including zero, without a banner or sound. FCM delivers a data-only
   `badge_updated` message to Android's existing opt-in notification receiver.

Task/permission alerts also include the latest complete `{count, version}` when available. Badge
delivery is independent of visible-browser alert acknowledgement and notification mute settings:
reading on another device must clear an icon even when no alert is sent.

## Recovery and rollout

The User DO persists a new version before any HTTP effect and a 30-second retry deadline before
dispatch. Lost ACKs replay only versioned replacements, never alert deliveries. The version is
durable, unlike frontend subscription revisions, and must not reset at eviction. New device
enrollment forces an initial complete snapshot. Dead subscriptions are removed only if they have
not been replaced while the request was in flight.

The notification service needs the matching `/v1/badges` implementation before deploying this
producer. Deploying the producer first is safe but leaves a retrying outbox until the endpoint is
available. Do not advertise live push until APNs/FCM credentials, routes and native entitlements
have been provisioned and a real-device test passes. Foreground badge updates work without push.

Tests cover message-to-outbox propagation, read-to-zero, real User DO eviction, lost ACK retry,
request signing and confirmed sign-out versus transient reconnect.
