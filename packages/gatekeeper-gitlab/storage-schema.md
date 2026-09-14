# GitLab gatekeeper storage schema

Durable Object storage layout for `UserAccount` and `GitLabGatekeeperImpl`. Written from the code
as each piece lands; the GitHub gatekeeper's `storage-schema.md` is the shape this mirrors.

## UserAccount

| Key | Value | Notes |
|---|---|---|
| `callback` | `Fetcher<GatekeeperConnectCallback>` | Stored at connect; used for `complete`, `reconnectComplete`, `credentialsExpired`. |
| `nonce` | `{ value, expiresAt, stage: "initiation" \| "oauth", reconnect?: true, replacesGrantId? }` | Two-stage connect nonce. A reconnect's records the `grantId` that was live when it started: the grant it replaces. |
| `codeVerifier` | `string` | PKCE verifier, written with the `oauth`-stage nonce and deleted at code exchange. |
| `requestedScopes` | `string[]` | Scopes requested for this flow (auth-only or full). |
| `ephemeral` | `boolean` | Auth-only sign-in grant; self-destructs two minutes after `complete()`. |
| `accessToken` | `string` | Current access token. |
| `accessTokenExpiresAt` | `number` | Epoch ms, from the token response's `expires_in`. |
| `refreshToken` | `string` | Current refresh token. Rotates on every refresh; the new value is written with the new access token in one transaction. |
| `scopes` | `string[]` | Scopes the live grant was requested with. Absent on stub-era accounts, which is the reconnect trigger. |
| `grantId` | `string` | Names the live authorization: minted by connect/reconnect, kept across refreshes. Derived facts (`userId`, `deadGrantId`) are trusted only while it is unchanged. |
| `credentialId` | `string` | Names the live access token: minted by every grant write, refresh included. |
| `userId` | `number` | The GitLab user the live grant belongs to, read from `GET /user` on first need (the observer probe) and dropped with `grantId`. |
| `deadGrantId` | `string` | The `grantId` whose refresh token GitLab refused (`invalid_grant`), so the dead token is not sent again -- not by a burst of callers, nor by a restarted object. A connect or reconnect writes a new `grantId`, which retires it. |
| `expiredNotified`, `expiredNotifiedArm` | kit `credential-expiry` latch | `credentialsExpired()` sent once per grant: latched after the Workshop acknowledges, re-armed by every grant write. A refusal is reported against the `credentialId` whose token was refused and dropped if that token is no longer live. |
| `stagedCredentials` | kit `credential-stage` record | A reconnect's grant and the `grantId` it replaces, until `commitReconnect(stageId)`. Once another reconnect has replaced that grant, the commit revokes the staged tokens instead. |

## GitLabGatekeeperImpl

KV only. Two families: a TTL cache that any queued/applied/rejected action invalidates wholesale
(one generation counter, not a sweep), and durable state that survives cache clears.

| Key | Value | Notes |
|---|---|---|
| `cacheGeneration` | `number` | Bumped by `#clearCaches()`; every `cache:*` entry records the generation it was written under and is ignored once it differs. |
| `cache:<kind>:<parts…>` | `{ fetchedAt, value, generation }` | TTL cache. Families: `version` (1 h); `viewer` (5 min); `project`, `project-by-id`, `issue`, `mr-raw`, `mr`, `mr-approvals`, `discussions`, `compare`, `commit`, `branch-head`, `mr-diffs`, `mr-simulated` (30 s); `list-issues`, `list-mrs`, `list-branches`, `list-tags`, `list-commits`, `mr-commits` (15 s); `merge-base` (never expires -- a pure function of its two shas). `mr-diffs` pages are keyed by the merge request's whole revision (`baseSha`, `mergeBaseSha`, `headSha`): the target branch can move under an unchanged head. No ETags: GitLab REST does not reliably answer conditional requests. |
| `counter:<name>` | `number` | Action ids (`action`) and provisional ids: `resource` (`~N`), and `comment`/`review`/`diff`/`reply` (`~comment1`, …). |
| `action:<approvalId>` | `{ action, state: "staged" \| "pending", progress?, … }` | A queued action; `#listPendingActions()` reads the `pending` ones and the read side overlays them. A `push` record binds `{ branch, expectedOldSha, newSha, force }` at queue time, and a `mergeMergeRequest` record its `expectedHeadSha` and, for a source branch in this project, `sourceBranch`: rejecting a push retires the queued pushes and merges bound to the heads it strands. `progress` records how far a review's apply has got, so a retry resumes instead of repeating a step: `approval` (`"approving"`, `{ approvedAt }`, or `"preexisting"`), `comments` (per diff comment: `null`, `"creating"`, its draft id, `"published"`), `requestedChanges`, `summary` (`"posting"`, then the note id). A step whose answer can be lost is recorded as under way first, and the retry asks GitLab what became of it; a discard reads it to take back what is still unpublished. |
| `retiredAction:<approvalId>` | `{ action, state: "approved" \| "rejected", appliedAt?, rejectedAt?, revertInfo?, progress? }` | An action past its lifetime, kept for revert. |
| `provisional:<~N>` | `{ kind, realId? }` | A provisional issue or merge request and, once created, its real number. Both `#~N` and `!~N` resolve through it, each against its own kind. |
| `diffAlias:<~id>` | `string` | A provisional reply's real note id, once the reply is posted; a reply queued against it while it was pending resolves through this. |
