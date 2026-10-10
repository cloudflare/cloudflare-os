# GitLab gatekeeper storage schema

Durable Object storage layout for `UserAccount`, `GitLabGatekeeperImpl` and `GitLabHookDriver`. Written from the code
as each piece lands; the GitHub gatekeeper's `storage-schema.md` is the shape this mirrors.

## UserAccount

| Key | Value | Notes |
|---|---|---|
| `callback` | `Fetcher<GatekeeperConnectCallback>` | Stored at connect; used for `complete`, `reconnectComplete`, `credentialsExpired`. |
| `nonce` | kit `connect-handshake` record: `{ value, expiresAt, stage: "initiation" \| "oauth" }`, plus at the `oauth` stage `{ codeVerifier, redirectUri, startedUnder, reconnect }` | Two-stage connect nonce, consumed by the callback (or by GitLab's refusal). `codeVerifier` is the PKCE verifier; `redirectUri` the `redirect_uri` the authorize request carried (the stable Worker's, on a preview), repeated verbatim in the code exchange; `startedUnder` the connection generation the attempt began under; `reconnect` whether the grant is staged rather than made live, fixed when the attempt starts. |
| `requestedScopes` | `string[]` | Scopes requested for this flow (auth-only or full). |
| `ephemeral` | `boolean` | Auth-only sign-in grant; self-destructs two minutes after `complete()`. |
| `credentials` | `{ accessToken, refreshToken, expiresAt, scopes }` | The live grant, owned by the kit's `CredentialCoordinator` with its `credentials:*` keys (identity fence, connection generation, recorded death, migration marker). `expiresAt` is epoch ms from the token response's `expires_in`; the coordinator refreshes a minute before it, redeeming the single-use refresh token once and storing the rotated pair before serving either. `scopes` are the scopes requested at grant time (the token response carries none); empty on a stub-era grant, which is the reconnect trigger. |
| `accessToken`, `accessTokenExpiresAt`, `refreshToken`, `scopes` | | The layout before the kit, which the deployed internal stub also wrote (minus `scopes`): migrated into `credentials` on first read, then deleted. A missing expiry refreshes on first use. |
| `user` | `{ id, generation }` | The GitLab user behind the connection, read from `GET /user` on first need (the observer probe) and trusted only while the connection generation is unchanged. |
| `expiredNotified`, `expiredNotifiedArm` | kit `credential-expiry` latch | `credentialsExpired()` sent once per dead grant: latched after the Workshop acknowledges, re-armed by every credential replacement. |
| `stagedCredentials` | kit `credential-stage` record of `{ grant, startedUnder }` | A reconnect's grant and the connection generation it replaces, until `commitReconnect(stageId)`. Once another reconnect has moved the generation, the commit revokes the staged tokens instead. |

## GitLabGatekeeperImpl

KV only. Two families: a TTL cache that any queued/applied/rejected action invalidates wholesale
(one generation counter, not a sweep), and durable state that survives cache clears.

| Key | Value | Notes |
|---|---|---|
| `cacheGeneration` | `number` | Bumped by `#clearCaches()`; every `cache:*` entry records the generation it was written under and is ignored once it differs. |
| `cache:<kind>:<parts…>` | `{ fetchedAt, value, generation }` | TTL cache. Families: `version` (1 h); `viewer` (5 min); `project`, `project-id`, `project-by-id`, `issue`, `mr-raw`, `mr`, `mr-approvals`, `discussions`, `compare`, `commit`, `branch-head`, `mr-diffs`, `mr-simulated` (30 s); `list-issues`, `list-mrs`, `list-branches`, `list-tags`, `list-commits`, `mr-commits` (15 s); `merge-base` (never expires -- a pure function of its two shas). `mr-diffs` pages are keyed by the merge request's whole revision (`baseSha`, `mergeBaseSha`, `headSha`): the target branch can move under an unchanged head. No ETags: GitLab REST does not reliably answer conditional requests. |
| `counter:<name>` | `number` | Action ids (`action`) and provisional ids: `resource` (`~N`), and `comment`/`review`/`diff`/`reply` (`~comment1`, …). |
| `action:<approvalId>` | `{ action, state: "staged" \| "pending", progress?, … }` | A queued action; `#listPendingActions()` reads the `pending` ones and the read side overlays them. A `push` record binds `{ branch, expectedOldSha, newSha, force }` at queue time, and a `mergeMergeRequest` record its `expectedHeadSha` and, for a source branch in this project, `sourceBranch`: rejecting a push retires the queued pushes and merges bound to the heads it strands. `progress` records how far a review's apply has got, so a retry resumes instead of repeating a step: `approval` (`"approving"`, `{ approvedAt }`, or `"preexisting"`), `comments` (per diff comment: `null`, `"creating"`, its draft id, `"published"`), `requestedChanges`, `summary` (the note id, once posted). A step whose answer can be lost is recorded as under way first, and the retry asks GitLab what became of it -- save the summary, which is posted again; a discard reads it to take back what is still unpublished. |
| `retiredAction:<approvalId>` | `{ action, state: "approved" \| "rejected", appliedAt?, rejectedAt?, revertInfo?, progress? }` | An action past its lifetime, kept for revert. |
| `provisional:<~N>` | `{ kind, realId? }` | A provisional issue or merge request and, once created, its real number. Both `#~N` and `!~N` resolve through it, each against its own kind. |
| `diffAlias:<~id>` | `string` | A provisional reply's real note id, once the reply is posted; a reply queued against it while it was pending resolves through this. |

## GitLabHookDriver

One per connected account, named by its `UserAccount` id; see `src/gitlab-hooks.ts`. KV only.

| Key | Value | Notes |
|---|---|---|
| `account` | `string` | The `UserAccount` id, whose token adds and deletes the webhooks. |
| `secret` | `string` | The signing token every webhook of this driver signs its deliveries with: `whsec_` and the base64 of a 32-byte key (Standard Webhooks). |
| `webhook:<projectId>` | `{ id, project: { id, path } }` | The webhook this driver added to the project, keyed by the project's numeric id, from when its first hook is enabled until its last is disabled. |
| `reg:<hookKey>` | `{ project, target?, events, viewerId }` | What one enabled hook watches: its project, the issue or merge request it is narrowed to, its event kinds, and the account's GitLab user id. |
| `caps:<hookKey>` | `{ delivery, initiator }` | The facet's persistent delivery stub and the Workshop's `HookInitiator`. |
| `msg:<hookKey>:<webhookId>` | kit `HookDeliveryQueue` row | An event pending delivery to one hook, or a finished one kept for a day, named by the delivery's signed `webhook-id`, so GitLab's retries and resends of it collapse. |
| `revoked` | `true` | Set, with every other key deleted, once the account is disconnected. |
