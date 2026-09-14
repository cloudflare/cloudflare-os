# GitLab gatekeeper storage schema

Durable Object storage layout for `UserAccount` and `GitLabGatekeeperImpl`. Written from the code
as each piece lands; the GitHub gatekeeper's `storage-schema.md` is the shape this mirrors.

## UserAccount

| Key | Value | Notes |
|---|---|---|
| `callback` | `Fetcher<GatekeeperConnectCallback>` | Stored at connect; used for `complete`, `reconnectComplete`, `credentialsExpired`. |
| `nonce` | `{ value, expiresAt, stage: "initiation" \| "oauth", reconnect?: true }` | Two-stage connect nonce. |
| `codeVerifier` | `string` | PKCE verifier, written with the `oauth`-stage nonce and deleted at code exchange. |
| `requestedScopes` | `string[]` | Scopes requested for this flow (auth-only or full). |
| `ephemeral` | `boolean` | Auth-only sign-in grant; self-destructs two minutes after `complete()`. |
| `accessToken` | `string` | Current access token. |
| `accessTokenExpiresAt` | `number` | Epoch ms, from the token response's `expires_in`. |
| `refreshToken` | `string` | Current refresh token. Rotates on every refresh; the new value is written with the new access token in one transaction. |
| `scopes` | `string[]` | Scopes the live grant was requested with. Absent on stub-era accounts, which is the reconnect trigger. |
| `grantId` | `string` | Names the live authorization: minted by connect/reconnect, kept across refreshes. Derived facts (`userId`) are trusted only while it is unchanged. |
| `userId` | `number` | The GitLab user the live grant belongs to, read from `GET /user` on first need (the observer probe) and dropped with `grantId`. |
| `expiredNotified` | `boolean` | `credentialsExpired()` sent once. |
| `stagedCredentials` | kit `credential-stage` record | A reconnect's grant, until `commitReconnect(stageId)`. |

## GitLabGatekeeperImpl

KV only. Two families: a TTL cache that any queued/applied/rejected action invalidates wholesale
(one generation counter, not a sweep), and durable state that survives cache clears.

| Key | Value | Notes |
|---|---|---|
| `cacheGeneration` | `number` | Bumped by `#clearCaches()`; every `cache:*` entry records the generation it was written under and is ignored once it differs. |
| `cache:<kind>:<parts…>` | `{ fetchedAt, value, generation }` | TTL cache. Families: `viewer` (5 min), `project`, `project-by-id`, `issue`, `mr-raw`, `mr`, `mr-approvals`, `discussions`, `compare`, `commit`, `branch-head` (30 s), `list-issues`, `list-mrs`, `list-branches`, `list-tags`, `list-commits`, `mr-commits`, `mr-diffs` (15 s), `merge-base` (never expires -- a pure function of its two shas). No ETags: GitLab REST does not reliably answer conditional requests. |
| `counter:<name>` | `number` | Action ids and provisional ids (`~N`, per-prefix comment ids). Written by the write side. |
| `action:<approvalId>` | `{ action, state: "staged" \| "pending", … }` | A queued action; `#listPendingActions()` reads the `pending` ones. Written by the write side; the read side overlays them. |
| `retiredAction:<approvalId>` | `{ action, state: "approved" \| "rejected", appliedAt?, rejectedAt?, revertInfo? }` | An action past its lifetime, kept for revert. |
| `provisional:<~N>` | `{ kind, realId? }` | A provisional issue or merge request and, once created, its real number. Both `#~N` and `!~N` resolve through it, each against its own kind. |
| `diffAlias:<~id>` | `string` | A provisional diff-comment id's real note id, once its review is published. |
