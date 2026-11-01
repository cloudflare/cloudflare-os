# GitLab gatekeeper storage schema

Durable Object storage layout for `UserAccount` and `GitLabGatekeeperImpl`. Written from the code
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

KV only. Three families: a TTL cache that any queued/applied/rejected action invalidates wholesale
(one generation counter, not a sweep), the cache of finished CI job logs (`ciLog:*`, its own TTL
and size budget, outside the generation: no action changes a finished log), and durable state
that survives cache clears.

| Key | Value | Notes |
|---|---|---|
| `cacheGeneration` | `number` | Bumped by `#clearCaches()`; every `cache:*` entry records the generation it was written under and is ignored once it differs. |
| `cache:<kind>:<parts…>` | `{ fetchedAt, value, generation }` | TTL cache. Families: `version` (1 h); `viewer` (5 min); `project`, `project-by-id`, `issue`, `mr-raw`, `mr`, `mr-approvals`, `discussions`, `compare`, `commit`, `branch-head`, `mr-diffs`, `mr-simulated`, `pipeline`, `job`, `test-report-summary` (30 s); `list-issues`, `list-mrs`, `list-branches`, `list-tags`, `list-commits`, `mr-commits`, `list-pipelines`, `mr-pipelines` (15 s); `merge-base` and `ci-config` (never expire -- pure functions of their shas: `ci-config:<sha>:<path>` is whether the CI configuration file exists at that commit). `mr-diffs` pages are keyed by the merge request's whole revision (`baseSha`, `mergeBaseSha`, `headSha`): the target branch can move under an unchanged head. `job` serves opens and `getDetails()`; a log read re-reads the job uncached, since its status says whether the log is final and `erased_at` whether it may be served. `mr-pipelines` holds a merge request's pipeline rows (id, project, commit; at most 1000), which decide the pipelines and jobs its binding may open; `listPipelines()` on the merge request pages uncached. No ETags: GitLab REST does not reliably answer conditional requests. |
| `counter:<name>` | `number` | Action ids (`action`) and provisional ids: `resource` (`~N`), and `comment`/`review`/`diff`/`reply` (`~comment1`, …). |
| `action:<approvalId>` | `{ action, state: "staged" \| "pending", progress?, … }` | A queued action; `#listPendingActions()` reads the `pending` ones and the read side overlays them. A `push` record binds `{ branch, expectedOldSha, newSha, force }` at queue time, and a `mergeMergeRequest` record its `expectedHeadSha` and, for a source branch in this project, `sourceBranch`: rejecting a push retires the queued pushes and merges bound to the heads it strands. `progress` records how far a review's apply has got, so a retry resumes instead of repeating a step: `approval` (`"approving"`, `{ approvedAt }`, or `"preexisting"`), `comments` (per diff comment: `null`, `"creating"`, its draft id, `"published"`), `requestedChanges`, `summary` (the note id, once posted). A step whose answer can be lost is recorded as under way first, and the retry asks GitLab what became of it -- save the summary, which is posted again; a discard reads it to take back what is still unpublished, best-effort: a cleanup GitLab refuses does not keep the action pending. |
| `retiredAction:<approvalId>` | `{ action, state: "approved" \| "rejected", appliedAt?, rejectedAt?, revertInfo?, progress? }` | An action past its lifetime, kept for revert. |
| `provisional:<~N>` | `{ kind, realId? }` | A provisional issue or merge request and, once created, its real number. Both `#~N` and `!~N` resolve through it, each against its own kind. |
| `diffAlias:<~id>` | `string` | A provisional reply's real note id, once the reply is posted; a reply queued against it while it was pending resolves through this. |
| `ciPushApplied:<sha>` | `number` (epoch ms) | When this gatekeeper applied a push that made `<sha>` a branch head: CI's first "became the head" source, ahead of the merge request's diff versions and the commit date. Only the 10-minute CI start window reads it, so each new record first prunes those older than that, and the family is capped at 100 (oldest dropped). A retried apply keeps the first record. |
| `ciLog:meta:<jobId>` | `{ version: 1, firstLine, totalLines, lineCount, chunks, bytes, storedAt }` | A finished job's normalised log (the kit's `CiLogCache`; the binding is one project, so the job id names it). Written only once the job's phase is `done` and GitLab returned a log. Expires an hour after `storedAt`. Every `readLog()` re-reads the job first: one gone or erased (`erased_at`) deletes the entry and the read fails. |
| `ciLog:chunk:<jobId>:<index>` | `string` | The log's retained lines, newline-joined, in chunks of at most 512 KiB (two bytes per character); `<index>` is zero-padded to six digits. A missing chunk drops the whole entry. |
| `ciLog:age:<storedAt>:<jobId>` | `string` (the job id) | Eviction index, oldest first (`storedAt` zero-padded to 16 digits). A store sweeps expired entries, then evicts the oldest until the new log fits. |
| `ciLog:totalBytes` | `number` | Bytes held across every `ciLog:chunk:*`, against a 32 MiB budget; a log larger than the budget is not stored. |
| `observedSet:ci-logs` | `"pending" \| "observed"` | The CI-data gate (the kit's `ObserverTracker`, one tracked set): marked `pending` by the first job-log or test-report read, `observed` once the overseer has recorded it, deleted again if the overseer refused that read. While present, `addObserver` requires Developer (30) on the project. Every job-log and test-report read checks the stored observers at Developer and excludes those below it. |
| `observer:<id>` | `Fetcher<GitLabVerifierApi>` | An admitted observer's verifier, stored only so CI-data reads can check them at Developer. `removeObserver` deletes it. |
| `observer-attempt:<id>` | `{ verifier, at }` | An admission in flight, so a concurrent CI-data read already checks the candidate; swept after 10 minutes. |
| `observer-nonce:<id>` | `string` | Fences that attempt: `removeObserver` deletes it, which cancels the admission wherever it is parked. |

The kit reserves the `observer-withhold-fence:*` and `observer-withhold-latch` keys for owner-only
reads; this gatekeeper has none, so they are never written.
