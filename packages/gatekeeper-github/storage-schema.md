# GitHub Gatekeeper Storage Schema

This gatekeeper uses Durable Object KV storage only. It does not use SQLite tables.

## Design choices

- Most resource and query caches use short-lived KV entries with stored ETags, while `since`-capable discussion streams use persistent prefix-plus-watermark sync caches.
- Simulation uses a read-time overlay for pending actions rather than mutating cached remote state in place.
- New issues and pull requests get provisional IDs like `~1`, `~2`, etc. Pending follow-up actions target those provisional IDs until the create action is applied.
- Replies to provisional diff comments are not supported: a reply needs a real GitHub comment ID.
  Applying a reply still records `diffAlias:` for its provisional ID, which nothing reads until
  that is lifted (see the plan's "Replies to provisional diff comments").

## UserAccount Durable Object

Keys:

- `callback` -> stored `GatekeeperConnectCallback` fetcher for the connected Workshop account.
- `nonce` -> `{ value: string, expiresAt: number, stage: "initiation" | "oauth" }`.
- `credentials` -> the live `GitHubOAuthGrant`, `{ accessToken, scopes, refreshToken?, expiresAt? }`, owned by the kit's `CredentialCoordinator` along with its `credentials:*` fence keys. `refreshToken` and `expiresAt` are present only for an expiring grant (GitHub's default for OAuth apps since August 2026): its access token lasts eight hours and is refreshed shortly before it expires, and each refresh rotates both tokens.
- `accessToken`, `scopes` -> the layout from before expiring grants were supported, migrated into `credentials` on first read and then deleted.
- `expiredNotified`, `expiredNotifiedArm` -> the kit's expiry latch, so `credentialsExpired()` is only sent once per dead grant. Every credential replacement re-arms it.
- `reconnecting` -> boolean flag indicating an in-progress reconnect flow.

No per-user SQL tables are used.

## GitHubGatekeeperImpl Durable Object

### Counters

- `counter:action` -> next numeric suffix for action IDs (`a1`, `a2`, ...).
- `counter:resource` -> next numeric suffix for provisional resource IDs (`~1`, `~2`, ...).
- `counter:comment` -> next numeric suffix for provisional issue/timeline comments.
- `counter:review` -> next numeric suffix for provisional reviews.
- `counter:diff` -> next numeric suffix for provisional diff comments created by pending reviews.
- `counter:reply` -> next numeric suffix for provisional diff replies.

### Repository identity

- `repoId` -> the bound repository's GitHub id, read once from `/repos/<owner>/<repo>`, whose
  redirect to `/repositories/<id>` (a renamed or transferred repo) is the only one followed
  before the id is known. With it, redirects are followed only to the same path under
  `/repositories/<repoId>`; every other redirect fails the request. Absent until first use.

### Action log

- `action:<approvalId>` -> `{ action, state: "staged" | "pending" }`, the queued `GitHubAction`.
- `retiredAction:<approvalId>` -> the same record once `state` is `"approved"` (with `appliedAt`
  and any `revertInfo`) or `"rejected"` (with `rejectedAt`). Retired records are kept, so a
  repeated apply or discard is answered from them, and a refused push can name a discarded
  predecessor.

Stored action variants:

- `createIssue`
- `createPullRequest`
- `setTitle`
- `setBody`
- `addLabels`
- `removeLabels`
- `changeState`
- `postComment`
- `postReview`
- `replyToDiffComment`
- `mergePullRequest` (bound to `expectedHeadSha` at queue time; a record from before that
  binding applies at the agent's `options.expectedHeadSha`, and is refused without one)
- `push`

Pending records are the source of truth for simulation.

### Provisional resource mapping

- `provisional:<provisionalId>` -> `{ kind: "issue" | "pull", realId?: string }`.

Before approval, `realId` is absent. After the create action is applied, `realId` is filled with the GitHub issue/PR number string.

### Diff comment alias mapping

- `diffAlias:<provisionalCommentId>` -> real GitHub review comment ID string.

Written when a diff reply is applied. Unread while replies to provisional comments are refused
(see Design choices).

### Incremental discussion sync state

Two `since`-capable streams use persistent materialized prefixes plus sync metadata:

- `discussionComments:<realId>:state` ->
  `{ depth: number, freshness: number, exhausted: boolean, chunkSize?: number, ids: string[] }`
- `discussionComments:<realId>:entry:<commentId>` -> cached normalized issue comment entry
- `pullReviewComments:<realId>:state` ->
  `{ depth: number, freshness: number, exhausted: boolean, chunkSize?: number, ids: string[] }`
- `pullReviewComments:<realId>:entry:<commentId>` -> cached raw pull-request review comment response

The `discussionComments:*` family tracks top-level issue comments, used for both issue
discussions and the top-level comment half of pull-request discussions.

The `pullReviewComments:*` family tracks the pull-request diff-comment stream returned by
`GET /pulls/{pull_number}/comments`, which is reused for diff-thread views and, once fully
materialized, for attaching diff comments to review summaries.

Meaning of the state fields:

- `depth`: how many oldest items from the stream are materialized locally
- `freshness`: wall-clock timestamp at which the cached prefix was last fully validated via a
  completed `since` walk
- `exhausted`: true when the materialized prefix reaches the end of the remote stream
- `chunkSize`: the pagination chunk size used when extending `depth`
- `ids`: stable GitHub comment IDs for the materialized prefix, in canonical oldest-first order

Lifecycle:

- The first time issue or pull metadata is loaded, the issue-comment state is initialized with
  `freshness = now` and `depth = 0`. If the metadata says there are zero top-level comments,
  `exhausted` is initialized to `true`.
- The first time a pull request is opened, the review-comment state is initialized with
  `freshness = now` and `depth = 0`.
- A later discussion or diff-thread read performs a `since` walk from `freshness` (with a small
  overlap window) to refresh any cached items inside the materialized prefix.
- If `freshness` is still within the normal entity cache TTL, the gatekeeper skips the `since`
  walk and serves the cached prefix directly.
- If the prefix had previously reached the end of the stream (`exhausted = true`), newly-seen
  items from the `since` walk are appended and the prefix stays complete.
- If the `since` walk returns too much changed data to process cheaply, or if cached depth is no
  longer compatible with known issue comment counts, the prefix is dropped by resetting `depth` to
  zero and `freshness` to `now`.
- When the caller paginates farther into a discussion, or when diff threads need the full diff
  comment stream, normal GitHub pagination extends the materialized prefix and advances `depth`.

### TTL cache entries

Short-lived caches still use `cache:*` keys and store:

- `{ fetchedAt: number, value: T, etag?: string, generation: number }`

Implemented TTL cache families:

- `cache:viewer` -> `{ actor: GitHubActor, fetchedAt: number }`
- `cache:repo-v2:<owner>:<repo>` -> `GitHubRepoMetadata` (v2: the shape gained `defaultBranch`,
  and etag revalidation can keep an old-shaped entry alive past the TTL)
- `cache:issue:<realId>` -> `GitHubIssueDetails`
- `cache:pull:<realId>` -> `GitHubPullRequestDetails`
- `cache:list-issues-v2:<encodedQuery>:p<page>` -> `(GitHubIssueSummary | null)[]`, one entry per
  upstream row (`null` for pull requests), so a page keeps the length that ends the walk (v2: v1
  stored filtered, short pages)
- `cache:search-issues-scoped-v1:<encodedQuery>` -> validated source URLs and `GitHubIssueSummary` values
- `cache:list-pulls-v2:<encodedQuery>:p<page>` -> `GitHubPullRequestSummary[]`, unfiltered (v2: v1
  dropped rows with pending actions)
- `cache:search-pulls-v2:<state>:p<page>` -> `GitHubPullRequestSummary & { bodyMarkdown }` rows of
  the `/pulls` listing (newest-updated first) that PR text search filters after the overlay
- `cache:discussion-reviews:<realId>:p<page>` -> `GitHubDiscussionEntry[]` review-summary pages for pull discussions
- `cache:resolve-ref:<encodedRef>` -> full commit id the ref resolved to
- `cache:diff-v2:<realId>:<baseSha>:<headSha>` -> `{ revision, files }` (v2: the revision gained
  `mergeBaseSha`)
- `cache:compare-provisional-v2:<provisionalPullId>` -> provisional diff snapshot from branch
  comparison (v2: same `mergeBaseSha` addition)
- `cache:merge-base:<baseSha>:<headSha>` -> merge base commit id of the two commits

### Cache TTLs

- Viewer cache: 5 minutes
- Entity caches (`repo-v2`, `issue`, `pull`, `discussion-reviews`, `resolve-ref`, `diff-v2`):
  30 seconds
- List/search caches: 15 seconds
- `merge-base` entries never expire (a merge base is a pure function of its two key commits);
  only the generation bump below evicts them

After a TTL expires, cached GET responses are conditionally revalidated with GitHub using the
stored `etag` where available. A `304 Not Modified` response refreshes `fetchedAt` without
rewriting the cached value.

Cache invalidation strategy:

- Any queued, applied, rejected, or reverted action invalidates every `cache:*` entry in the
  gatekeeper DO by bumping `cacheGeneration`; entries are overwritten by later reads, never
  deleted. A read stores its result only if the generation it captured before fetching is still
  current, so a read that straddled an apply never caches pre-apply data.
- The persistent `discussionComments:*` and `pullReviewComments:*` sync state is retained;
  subsequent reads revalidate it with `since` before use.
- Simulation is then rebuilt from the pending action log on subsequent reads.

## Simulation model

- Reads fetch cached or remote GitHub state.
- Pending actions from `action:*` are overlaid on that state at read time.
- Provisional creates synthesize issue/PR objects locally until GitHub assigns a real ID.
- Rejecting a provisional create retires its dependent pending actions as rejected and returns
  `restart: true`.
- Review-thread simulation supports pending review comments and pending replies to real GitHub diff comments.

## Absent schema

- No SQLite schema.
- No background sync tables.
- No persisted full-text index.
