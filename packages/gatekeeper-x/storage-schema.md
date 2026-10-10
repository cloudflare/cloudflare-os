# X gatekeeper storage schema

Durable Object storage layout for `UserAccount` and `XGatekeeperImpl`. Both use synchronous KV only.

## UserAccount

One per connected account.

| Key | Value | Notes |
|---|---|---|
| `callback` | `Fetcher<GatekeeperConnectCallback>` | Stored at connect; used for `complete`, `reconnectComplete` and `credentialsExpired`. |
| `requestedScopes` | `string[]` | The scopes the current connect or reconnect flow asks for. |
| `nonce`, `connectAttempted` | kit `connect-handshake` record, plus at the `oauth` stage `{ codeVerifier, redirectUri, startedUnder, reconnect, scopes }` | The two-stage connect nonce. `codeVerifier` is the PKCE verifier; `redirectUri` is repeated verbatim in the code exchange; `startedUnder` is the connection generation the attempt began under; `reconnect` decides whether the grant is staged; `scopes` are recorded on the grant when X's token response names none. |
| `credentials` | `{ accessToken, refreshToken?, expiresAt?, scopes }` | The live grant, owned by the kit's `CredentialCoordinator` with its `credentials:*` keys (identity fence, connection generation, recorded death). The refresh token is treated as single-use: one redemption, the rotated pair stored before either is served. It never leaves this object. |
| `identity` | `StoredIdentity`: `{ id, username, name, profileImageUrl?, protected, verified, subscriptionType?, fetchedAt }` | The X user the connection is pinned to. Read from `GET /2/users/me` at connect, and again once it is a day old; a re-read naming another user is ignored, and a reconnect as another user is refused. |
| `reads` | `{ day, used }` | Billable reads this UTC day, across every binding of the connection, against `X_DAILY_READ_LIMIT`. Reserved before a read, settled with what X returned. |
| `expiredNotified`, `expiredNotifiedArm` | kit `credential-expiry` latch | `credentialsExpired()` sent once per dead grant. |
| `stagedCredentials` | kit `credential-stage` record of `{ grant, identity, startedUnder }` | A reconnect's grant until `commitReconnect(stageId)`. |

## XGatekeeperImpl

One per binding.

| Key | Value | Notes |
|---|---|---|
| `pinnedUserId` | `string` | The X user the binding was first used as. A connection that comes to name anyone else is refused. Also the action fence, and what the `owner` observer collection admits. |
| `profileUserId` | `string` | A Profile binding's user, pinned by ID at its first lookup by handle, so a rename cannot redirect the binding. |
| `description` | `ResourceDescription` | A Post, List or Profile binding's description, fetched once: describing one costs a read. |
| `x:nextActionId`, `x:action:<id>`, `retained:x:action:<id>`, `applied:x:action:` | kit `ActionJournal` records of `XAction` | Pending, failed and retained (applied) actions. Applied actions are kept 30 days for revert, pruned at most every six hours. Every record is fenced on `pinnedUserId`. |
| `refs:seq:provisional`, `refs:prov:<~N>`, `refs:kind:<~N>` | kit `ProvisionalIds` | Temporary IDs of posts and Lists not yet created, and the IDs X assigned them. |
| `progress:<actionId>` | `string[]` | The posts a thread has published so far, so a retry resumes rather than reposting. |
| `attempt:<actionId>:<index>` | `{ at, mediaIds? }` | A send whose outcome X never reported: a post's, by its index in the thread, with the media it attached, or a List creation's, at index 0. Before sending again the next apply binds the one post or owned List from around `at` that matches what was sent; a rejection is refused while one exists. Leftovers are swept with housekeeping. |
| `images:<handle>:*`, `imageAllocations:<handle>`, `imageAllocations:totalBytes` | kit `ActionFileStore` | Images captured for pending posts: 5 MiB each, 64 MiB together. Released once posted; swept when unreferenced for an hour. |
| `cache:@x:*` | kit `KvTtlCache` | Reads, partitioned by connection generation and invalidated after every action decision. |
| `verdict:<xUserId>` | `number` | When an observer's X account last proved it can see the bound post or List; trusted for an hour. |
| `housekeptAt` | `number` | When housekeeping last ran. |
| `observer:*`, `observed:*` | kit observer tracker | Admitted observers, and the collections (`owner`) reads have disclosed. |

A hook stores nothing in the facet: until it is enabled, everything it needs lives in its
`XHookController`'s props, including a persistent stub to the facet minted by `ctx.restore()`, whose
`[restore]()` target delivers with the binding's re-checks.

## XHookDriver

One per connected account, named by its `UserAccount` id.

| Key | Value | Notes |
|---|---|---|
| `account` | `string` | The `UserAccount` id. |
| `reg:<hook key>` | `{ kind, postId?, conversationId?, userId?, viewerId }` | An enabled hook: what it watches for, and the connected X user, whose own posts are never delivered back to it. |
| `caps:<hook key>` | `{ delivery, initiator }` | The facet's delivery stub and the overseer's initiator. Disposed when replaced, unregistered or revoked. |
| `msg:<hook key>:<event id>` | kit `HookDeliveryQueue` rows | Each event queued for a hook, retried with backoff; finished rows are kept a day, deduplicating X's `event_uuid`. |
| `revoked` | `true` | The account was disconnected: nothing more is registered or delivered. |

## XActivityRouter

One per X user, named by the user's ID.

| Key | Value | Notes |
|---|---|---|
| `sub:<event type>` | `{ id }` | The subscription X delivers this user's `post.mention.create`, `post.reply.create` or `post.create` events through. Forgotten for the private two when X reports `oauth.revoke`, since X deleted them. |
| `watch:<event type>:<account id>` | `true` | An account whose driver watches for the event; the last to go ends the subscription. |

## XWebhookRegistry

One per deployment, named `deployment`.

| Key | Value | Notes |
|---|---|---|
| `webhook` | `{ id, url }` | The webhook X delivers to, checked hourly: revalidated if X marked it invalid, registered again if X lost it. |
| `revokeSubscribed` | `true` | The app-wide `oauth.revoke` subscription exists. |
