# GitHub Gatekeeper Storage Schema

This gatekeeper uses Durable Object KV storage only. It does not use SQLite tables.

## Design choices

- Most resource and query caches use short-lived KV entries with stored ETags, while `since`-capable discussion streams use persistent prefix-plus-watermark sync caches.
- Simulation uses a read-time overlay for pending actions rather than mutating cached remote state in place.
- New issues and pull requests get provisional IDs like `~1`, `~2`, etc. Pending follow-up actions target those provisional IDs until the create action is applied.
- Applied review-comment aliases are recorded so later replies can resolve provisional comment IDs to GitHub comment IDs.
- Replies to provisional diff comments are intentionally not supported until the parent review is approved and GitHub assigns real comment IDs.

## UserAccount Durable Object

Keys:

- `callback` -> stored `GatekeeperConnectCallback` fetcher for the connected Workshop account.
- `nonce` -> `{ value: string, expiresAt: number, stage: "initiation" | "oauth" }`.
- `accessToken` -> GitHub OAuth access token string.
- `scopes` -> `string[]` of granted OAuth scopes.
- `expiredNotified` -> boolean guard so `credentialsExpired()` is only sent once per expired credential set.
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

### Pending action log

- `pendingAction:<localId>` -> serialized `GitHubAction` union.

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
- `mergePullRequest`

These records are the source of truth for simulation.

### Provisional resource mapping

- `provisional:<provisionalId>` -> `{ kind: "issue" | "pull", realId?: string }`.

Before approval, `realId` is absent. After the create action is applied, `realId` is filled with the GitHub issue/PR number string.

### Diff comment alias mapping

- `diffAlias:<provisionalCommentId>` -> real GitHub review comment ID string.

This is written after a review or diff reply is applied so later replies can target the real GitHub thread/comment.

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

- `{ fetchedAt: number, value: T, etag?: string }`

Implemented TTL cache families:

- `cache:viewer` -> `{ actor: GitHubActor, fetchedAt: number }`
- `cache:repo-v2:<owner>:<repo>` -> `GitHubRepoMetadata` (v2: the shape gained `defaultBranch`,
  and etag revalidation can keep an old-shaped entry alive past the TTL)
- `cache:issue:<realId>` -> `GitHubIssueDetails`
- `cache:pull:<realId>` -> `GitHubPullRequestDetails`
- `cache:list-issues:<encodedQuery>` -> `GitHubIssueSummary[]`
- `cache:search-issues-scoped-v1:<encodedQuery>` -> validated source URLs and `GitHubIssueSummary` values
- `cache:list-pulls:<encodedQuery>` -> `GitHubPullRequestSummary[]`
- `cache:search-pulls:<encodedQuery>` -> `GitHubPullRequestSummary[]`
- `cache:discussion-reviews:<realId>:p<page>` -> `GitHubDiscussionEntry[]` review-summary pages for pull discussions
- `cache:discussion-review-comments:<realId>:<reviewId>` -> review comments attached to one pull-request review
- `cache:resolve-ref:<encodedRef>` -> full commit id the ref resolved to
- `cache:diff-v2:<realId>:<baseSha>:<headSha>` -> `{ revision, files }` (v2: the revision gained
  `mergeBaseSha`)
- `cache:compare-provisional-v2:<provisionalPullId>` -> provisional diff snapshot from branch
  comparison (v2: same `mergeBaseSha` addition)
- `cache:merge-base:<baseSha>:<headSha>` -> merge base commit id of the two commits

### Cache TTLs

- Viewer cache: 5 minutes
- Entity caches (`repo-v2`, `issue`, `pull`, `discussion-reviews`, `discussion-review-comments`,
  `resolve-ref`, `diff-v2`): 30 seconds
- List/search caches: 15 seconds
- `merge-base` entries never expire (a merge base is a pure function of its two key commits);
  only the generation bump below evicts them

After a TTL expires, cached GET responses are conditionally revalidated with GitHub using the
stored `etag` where available. A `304 Not Modified` response refreshes `fetchedAt` without
rewriting the cached value.

Cache invalidation strategy:

- Any queued, applied, rejected, or reverted action clears all `cache:*` entries in the gatekeeper DO.
- The persistent `discussionComments:*` and `pullReviewComments:*` sync state is retained;
  subsequent reads revalidate it with `since` before use.
- Simulation is then rebuilt from the pending action log on subsequent reads.

## Simulation model

- Reads fetch cached or remote GitHub state.
- Pending actions from `pendingAction:*` are overlaid on that state at read time.
- Provisional creates synthesize issue/PR objects locally until GitHub assigns a real ID.
- Rejecting a provisional create deletes dependent pending actions and returns `restart: true`.
- Review-thread simulation supports pending review comments and pending replies to real GitHub diff comments.

## Absent schema

- No SQLite schema.
- No background sync tables.
- No persisted full-text index.
