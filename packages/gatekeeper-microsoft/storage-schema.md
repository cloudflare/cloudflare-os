# Microsoft 365 gatekeeper storage schema

The Durable Object storage layout for `UserAccount`, `SharePointGatekeeper`, `OutlookGatekeeper`,
`OutlookHookDriver` and `CalendarGatekeeper`. All use synchronous KV only.

## UserAccount

There is one per connected account.

| Key | Value | Notes |
|---|---|---|
| `callback` | `Fetcher<GatekeeperConnectCallback>` | Stored at connect. Used for `complete`, `reconnectComplete` and `credentialsExpired`. |
| `requestedScopes` | `string[]` | The fully qualified scopes the current connect or reconnect flow asks for, which also seed the grant's `requestedScopes`. |
| `nonce`, `connectAttempted` | kit `connect-handshake` record, which at the `oauth` stage adds `{ codeVerifier, redirectUri, startedUnder, firstConnect?, scopes }` | The two-stage connect nonce. `codeVerifier` is the PKCE verifier. `redirectUri` is repeated verbatim in the code exchange. `startedUnder` is the connection generation the attempt began under. `firstConnect` makes the grant live rather than staged. The nonce is consumed by every callback outcome, refusals included. |
| `credentials` | `{ accessToken, refreshToken?, expiresAt?, scopes, requestedScopes }` | The live grant, owned by the kit's `CredentialCoordinator` with its `credentials:*` keys (identity fence, connection generation, recorded death). `scopes` is what Entra granted, lower-cased and bare. `requestedScopes` is repeated on every refresh, which Entra's v2 endpoint requires. The refresh token never leaves this object. |
| `identity` | `StoredIdentity`: `{ tenantId, objectId, name, username?, email?, sharePointTenant?, fetchedAt }` | The Entra user the connection is pinned to, by `(tenantId, objectId)` from the `id_token` and confirmed against `GET /me`. `sharePointTenant` is read from `/sites/root`. The identity is re-read once a day, and a re-read naming another user is ignored. A reconnect as another user is refused. |
| `expiredNotified`, `expiredNotifiedArm` | kit `credential-expiry` latch | `credentialsExpired()` is sent once per dead grant. |
| `stagedCredentials` | kit `credential-stage` record of `{ grant, identity, startedUnder }` | A reconnect's grant, held until `commitReconnect(stageId)`. |
| `hookDriver:<driver>` | `number`, when last tracked | The `OutlookHookDriver`s holding this account's hooks, by `driverName`. A driver can register a hook only while the account is connected, and `revoke()` has each one forget the account's hooks. |

## SharePointGatekeeper

There is one per binding. Its props are `{ userObjectId, scope }`, where `scope` is the
`SharePointScope` the resource URL resolved to, by ID.

| Key | Value | Notes |
|---|---|---|
| `pinnedUser` | `string`, `"<tenantId>/<objectId>"` | The Entra user the binding was first used as. A connection that comes to name anyone else is refused. Also the action fence. |
| `description` | `{ value: ResourceDescription, at }` | The last description, re-read once it is a day old. It is kept and shown if the target becomes unavailable. |
| `sp:nextActionId`, `sp:action:<id>`, `retained:sp:action:<id>`, `applied:sp:action:` | kit `ActionJournal` records of `SharePointAction` | Pending, failed and retained (applied) actions. Every record is fenced on `pinnedUser`. Applied actions are kept 30 days for revert, pruned at most every six hours. |
| `refs:seq:provisional`, `refs:prov:<~N>`, `refs:kind:<~N>` | kit `ProvisionalIds` | Temporary IDs of folders, files and list items that don't exist yet, and the IDs SharePoint assigned once they were created. Every entry point resolves a temporary ID first, so an agent can keep using one after approval. |
| `files:<handle>:*`, `fileAllocations:<handle>`, `fileAllocations:totalBytes` | kit `ActionFileStore` | Content captured for pending uploads and replacements, 25 MiB each and 128 MiB in total. Released once applied. Swept when unreferenced for an hour. |
| `cache:@sharepoint:*` | kit `KvTtlCache` | Reads, partitioned by connection generation and invalidated after every action decision. Metadata is kept 5 minutes. Extracted text is kept an hour, keyed by the file's `cTag`, and only under 100 KB. |
| `housekeptAt` | `number` | When housekeeping last ran. |
| `observer:*`, `observedUnit:*` | kit tracked-collection observers | The admitted observers, and the access units reads have revealed (`site:`, `drive:`, `item:`, `list:`, `listItem:` and `page:` IDs, a file's `content:` and `versions:`, and the exact draft seen as `fileVersion:`, `listItemVersion:` or `pageVersion:`; at most 2,000), each probed per observer through their `MicrosoftVerifier`. |

## OutlookGatekeeper

There is one per binding. Its props are `{ userObjectId, scope }`, where `scope` is the `OutlookScope`
the resource URL resolved to: the mailbox by its user's object ID, a folder by immutable ID.

| Key | Value | Notes |
|---|---|---|
| `pinnedUser` | `string`, `"<tenantId>/<objectId>"` | As for SharePoint: the binding's user, and the action fence. |
| `description` | `{ value: ResourceDescription, at }` | As for SharePoint. |
| `outlook:nextActionId`, `outlook:action:<id>`, `retained:outlook:action:<id>`, `applied:outlook:action:` | kit `ActionJournal` records of `OutlookAction` | Pending, failed and retained actions, fenced on `pinnedUser`. Applied actions are kept 30 days for revert. A send's record holds the Message-ID it sends with, which makes applying it exactly-once. |
| `refs:seq:provisional`, `refs:prov:<~N>`, `refs:kind:<~N>` | kit `ProvisionalIds` | Temporary IDs of folders and drafts that don't exist yet, and the IDs Exchange assigned. |
| `files:<handle>:*`, `fileAllocations:<handle>`, `fileAllocations:totalBytes` | kit `ActionFileStore` | Attachments captured for pending drafts and sends, 3 MiB each (Graph's inline-attachment limit) and 64 MiB in total. |
| `draftVersion:<messageId>` | `{ changeKey, at }` | The change key a draft had after this binding last wrote it. A send of a draft the binding wrote is fenced on it, so an edit made in Outlook after the proposal stops the send. Dropped with `ownDraft:`. |
| `ownDraft:<messageId>` | `number`, when written | Drafts this binding wrote, which it covers whatever its narrowing. Dropped after 30 days, after which a draft is covered only as any other message. |
| `cache:@outlook:*` | kit `KvTtlCache` | Reads (folders, the mailbox, the organization's domains, who the user has written to), partitioned by connection generation and invalidated after every action decision. |
| `housekeptAt` | `number` | When housekeeping last ran. |
| `observer:*`, `observedUnit:*` | kit tracked-collection observers | The admitted observers, and the mail units reads have revealed (`mailbox:`, `mailFolder:` and `mail:` IDs under the mailbox user's ID, at most 2,000), probed per observer through their `MicrosoftVerifier`. |

## OutlookHookDriver

There is one per connection and mailbox, named `driverName(userObjectId, mailboxUser)`: a hash of
the connection's user, then the mailbox user's object ID. It holds every new-message hook any of the
connection's bindings on that mailbox registered.

| Key | Value | Notes |
|---|---|---|
| `reg:<hookKey>` | `{ userObjectId, mailboxUser, folderId, since }` | A hook: the folder it watches, and when it was enabled (nothing received earlier is delivered). What it receives is decided at delivery by its binding, restored from `caps:`, which skips drafts, the user's own mail and anything the binding doesn't cover. |
| `caps:<hookKey>` | `{ delivery, initiator }`, stored stubs | The binding's persistent `OutlookHookDelivery` and the Workshop's hook initiator. Disposed when replaced or unregistered. |
| `watch:<folderId>` | `{ cursor, renewAt, subscriptionId?, expiresAt? }` | Per watched folder: the `receivedDateTime` read up to (re-read with a two-minute overlap), and its Graph subscription, renewed halfway through its three days. |
| `clientState` | `string` | The secret every notification must carry, compared in constant time. A notification only brings the next read forward, so a forged one costs a read. |
| `syncAt` | `number` | When the next read is due. |
| `msg:<hookKey>…`, `queue:due:*`, `queue:finished:*` | kit `HookDeliveryQueue` | Deliveries, by message ID, retried with backoff and remembered for a day so an overlapping read doesn't deliver twice. |

## CalendarGatekeeper

There is one per binding. Its props are `{ userObjectId, scope }`, where `scope` is the `CalendarScope`
the resource URL resolved to: every calendar, availability only, or one calendar by immutable ID and
MAPI entry ID (what its events name as their parent), with its owner's object ID when it is shared.

| Key | Value | Notes |
|---|---|---|
| `pinnedUser` | `string`, `"<tenantId>/<objectId>"` | As for SharePoint: the binding's user, and the action fence. |
| `description` | `{ value: ResourceDescription, at }` | As for SharePoint. |
| `calendar:nextActionId`, `calendar:action:<id>`, `retained:calendar:action:<id>`, `applied:calendar:action:` | kit `ActionJournal` records of `CalendarAction` | Pending, failed and retained actions, fenced on `pinnedUser`. Applied actions are kept 30 days for revert. A creation's record holds the `transactionId` it was proposed with, which Exchange uses to make it exactly-once; a deletion's holds what it needs to recreate the event. |
| `refs:seq:provisional`, `refs:prov:<~N>`, `refs:kind:<~N>` | kit `ProvisionalIds` | Temporary IDs of events that don't exist yet, and the IDs Exchange assigned. |
| `cache:@calendar:*` | kit `KvTtlCache` | Reads, partitioned by connection generation and invalidated after every action decision: the calendars (5 minutes), mailbox settings (an hour), the organization's domains (a day), and for observer checks a calendar's sharing list (2 minutes) and whether an address is a person (an hour). |
| `housekeptAt` | `number` | When housekeeping last ran. |
| `observer:*`, `observedUnit:*` | kit tracked-collection observers | The admitted observers, and the units reads have revealed, at most 2,000: `calendar:<ownerId>:<calendarId>:<freeBusy\|limited\|full\|private>`, `calendars:<ownerId>` (all of a user's calendars, admitting only that user), and `availability:<address>` (probed by asking for that person's free/busy as the observer). |
