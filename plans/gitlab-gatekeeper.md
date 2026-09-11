# Plan: GitLab gatekeeper — a GitHub-gatekeeper mirror for gitlab.com and self-hosted instances

## Goal

Ship `packages/gatekeeper-gitlab`, a gatekeeper for GitLab that is functionally equivalent to
`packages/gatekeeper-github` and implemented as a **mirror** of it: the same three resource
granularities (project / issue / merge request), the same action queue with provisional ids and
read-time simulation, the same **worktree integration** through the workspace `GitCache` (commit
ids advertised, `gitPull()` over smart-HTTP, `push()` as a queued action declaring
`pushedCommits`, simulated reads over queued pushes), the same strategy-B observer verification,
and the same sign-in support (`providesAuth`). An agent that has learned to work a GitHub
repository through a worktree should be able to do the same against a GitLab project with only
vocabulary changes.

Two things the GitHub gatekeeper never needed, and which this one exists to add:

- **Instance configuration.** GitLab is commonly self-hosted. The gatekeeper is configured by
  `GITLAB_URL` (what the user's browser visits; default `https://gitlab.com`), an optional
  `GITLAB_API_URL` (what the Worker talks to, when that differs), and an optional Cloudflare
  Access **service token** pair attached to every Worker→GitLab request — because a self-hosted
  GitLab behind Cloudflare Access is a real deployment shape, including our own.
- **Rotating credentials.** GitLab access tokens expire after two hours and refresh tokens are
  single-use. GitHub's `UserAccount` stores one non-expiring token; this one refreshes under a
  lock and persists the rotated refresh token atomically.

Supporting cast:

- **Git layer moved into `@gadgets/gatekeeper-kit`.** `git-transport.ts`, `git-diff.ts`, and the
  pure git-object half of `git-commits.ts` have no platform imports and take fetch callbacks, not
  a `GitHubApi`; they become kit leaf modules (`./git-transport`, `./git-objects`, `./git-diff`)
  that both gatekeepers import. No second copy of the pkt-line composer.
- **The internal deployment replaces its incubating GitLab stub with this package.** That is a
  separate PR in the internal repo (its own companion plan there); this document notes only what
  the public package must expose for that to be a configuration change.

Two PRs total: one here (kit extraction + the gatekeeper), one in the internal repo (submodule
bump, stub removal, config, secrets). See [Commit sequence](#commit-sequence).

## Locked decisions

- **Mirror, don't redesign.** Same file layout (`gitlab.ts`, `gitlab-api.ts`, `types.d.ts` +
  `types.txt` symlink, `gitlab-configurators.ts`, `configurator/*`, `observability.ts`,
  `storage-schema.md`), same class structure (`GatekeeperVendor`, `UserAccount`,
  `GatekeeperUserImpl`, `GitLabVerifier`, `GitLabGatekeeperImpl`, `GitLabProjectSessionImpl`,
  `GitLabIssueImpl`, `GitLabMergeRequestImpl`), same storage-key scheme (`counter:*`, `action:*`,
  `retiredAction:*`, `provisional:*`, `diffAlias:*`, `discussionComments:*`,
  `pullReviewComments:*` → `diffDiscussions:*`, `cache:*` with a generation counter), same
  cursor classes, same test layout (node suite + workerd suite with a `TestHooks` DO). Diverge
  only where GitLab's API forces it, and record every divergence in §5's table. Rationale:
  reviewers already know the GitHub shape, a fix found in one port applies to the other, and
  "how does GitHub do this" is always an answerable question during implementation.
- **GitLab-native vocabulary in the agent-facing API.** `GitLabProject`, `GitLabIssue`,
  `GitLabMergeRequest`; `createMergeRequest`/`listMergeRequests`/`searchMergeRequests`;
  `sourceBranch`/`targetBranch` (not `head`/`base`); `iid`-derived string ids; states `opened` /
  `closed` (issues) and `opened` / `closed` / `merged` / `locked` (MRs). Agents meet GitLab through
  its URLs and UI, which use these words; translating them to GitHub's would help nobody.
  Structural names that are not GitLab-specific (`Cursor`, `*PageOptions`, `*DiffFile`, `*Hunk`,
  `*Line`, `*Actor`) keep the GitHub shapes with a `GitLab` prefix.
- **Three granularities: project, issue, merge request.** Group-scoped bindings ("everything
  under `some-group/`") — the one thing the internal stub offered that GitHub doesn't — are
  **deferred**: they need strategy-C observers and a project-discovery surface on the session,
  neither of which the mirror has. Deliberately a follow-up, not a silent omission.
- **Instance URL is deployment configuration, not a wizard input.** `GITLAB_URL` and
  `GITLAB_API_URL` are plain `vars` (defaults: `https://gitlab.com`, and `GITLAB_URL`). They are
  *not* `deploy-inputs.json` entries: `manifest-lib.ts` emits bindings only for `secret` inputs,
  and the deploy wizard blocks Install on unfilled inputs, so a `GITLAB_URL` input would force
  every gitlab.com deployer to type it for nothing. Self-hosters set the var after deploy. The
  wizard inputs are the default `CLIENT_ID`/`CLIENT_SECRET` (with `redirectUriTemplate` and
  GitLab-specific `setupSteps`), so the package is deliberately **not** in
  `NO_DEFAULT_CRED_INPUTS`.
- **Every browser-facing URL uses `GITLAB_URL`; every Worker-side request uses `GITLAB_API_URL`.**
  Browser-facing: the OAuth `authorize` redirect (the user's own browser session must reach it),
  `SupportedResource.urlPattern`s (built from env in `getSupportedResources()`, so they can't be
  module constants as GitHub's are), `web_url`-style links in results, `VendorDescription.url`.
  Worker-side: REST, `oauth/token`, `oauth/revoke`, and both git smart-HTTP endpoints. The split exists because an Access-protected instance may expose a service-token
  hostname distinct from the one users log into.
- **Optional upstream Access service token: `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`.**
  When both are set, every Worker→GitLab request (REST, OAuth token endpoints, git) carries
  `CF-Access-Client-Id` / `CF-Access-Client-Secret`. When either is unset, nothing is added. Named
  for what they are — Cloudflare Access credentials — because "self-hosted GitLab behind Access"
  is a configuration any Cloudflare customer might run, not an internal peculiarity. They are
  secrets but not wizard inputs (same reasoning as the URL vars: most deployers don't need them).
- **No inbound Access-JWT verification at the HTTP entrypoint.** The internal repo's own
  gatekeepers verify `cf-access-jwt-assertion` on every request; its deployed *public*
  gatekeepers (github, google, slack, zoominfo) do not, and this one follows them. The route is
  gated by the zone's Access policy where one exists, the connect URL is a bearer capability with
  a DO-stored nonce, and the callback is verified by nonce and single-use ticket — the same
  posture as GitHub. Adding the check would pull `jose` into the package to defend a surface the
  other public gatekeepers leave to Access.
- **OAuth: `api write_repository` for connections, `read_user` for sign-in; S256 PKCE; identity
  from `GET /user`.** Two documentation facts shaped this, both overturning the first draft:
  - The docs grant Git-over-HTTPS to OAuth tokens **only** for `read_repository`/`write_repository`
    ("A token with scope `read_repository` or `write_repository` can access Git over HTTPS"); the
    "`api` also covers Git" clause is stated for personal access tokens alone. `api` probably works
    in practice, but `write_repository` is documented and costs nothing, so a connection requests
    both — REST through `api`, fetch/push through `write_repository`.
  - OIDC `userinfo` returns `email`/`email_verified` "only if the application has access to the
    `email` scope **and the user's public email address**" — and most users have no public email.
    So the sign-in identity is `GET /user` → `email` when `confirmed_at` is non-null (GitLab only
    makes an address primary once confirmed, so this is the provider-verified pair, the analogue
    of GitHub's primary+verified). No OIDC scopes are requested at all.
  GitLab has no repository-granular scopes (nor does GitHub — `repo` is everything). PKCE is
  cheap, documented as "recommended for both client and server apps", and
  `gatekeeper-cloudflare/src/oauth.ts` is the in-repo reference; we send `client_secret` *and*
  `code_verifier` (the docs neither require nor forbid the combination). The refresh request
  carries `redirect_uri`, as the documented example does. Auth-only grants are transient
  (2-minute self-destruct alarm), exactly as GitHub's. One documented ambiguity is left for the
  first live checkpoint: the `read_user` scope is described as exposing the "public email", so
  whether `/user` under `read_user` includes the private primary `email` must be confirmed; if it
  does not, the transient sign-in grant requests `read_api` instead (still read-only, still
  discarded within two minutes).
- **Refresh under a mutex, rotation persisted before use.** `UserAccount.getAccessToken()`
  returns the cached token while it has more than `ACCESS_TOKEN_EXPIRY_SAFETY_MS` left; otherwise
  it takes the account's `Mutex`, re-checks, refreshes, **writes the new refresh token and access
  token in one storage transaction**, and only then returns. A refresh that fails with
  `invalid_grant` marks the account expired (`credentialsExpired()`, once) and throws the
  reconnect message; other failures set a short cooldown so a storm of callers doesn't hammer the
  token endpoint. Modeled on `gatekeeper-google`'s `UserAccount`, minus its "if a new refresh
  token is returned, use it" TODO — GitLab always returns one, and losing it strands the account.
  A `401` is a credential rejection only from `GET /user` (the one request that asserts nothing
  but authentication) and the git endpoints (which authenticate nothing but the bearer); those go
  straight to `credentialsExpired()` and the reconnect message, with no refresh-and-replay —
  expiry is handled proactively from `expires_in`, so a `401` on a token our clock still considers
  fresh means it was revoked, and a refresh would only come back `invalid_grant`. Every other
  endpoint's `401` is that operation's own answer: GitLab documents `PUT …/merge` answering 401 for
  "this user does not have permission to accept this merge request", and the approvals endpoint
  requires an eligible approver, so a Reporter trying to merge must not retire their healthy
  connection. A revoked token still surfaces on the next `describe()` or observer probe, both of
  which read `/user`.
- **Facts derived from a grant are fenced to it.** A connect or reconnect mints a `grantId`; a
  refresh keeps it. The observer probe's user id is read from `/user` once per grant and stored
  against it, and the probe discards a membership row when the grant moved between reading the id
  and reading the row — a reconnect as a different GitLab user landing in that window would
  otherwise pair one user's Reporter membership with another's token and admit the wrong person.
- **Reconnect on the existing internal connections is accepted.** The internal stub's DO
  classes are `UserAccount` and `GitLabGatekeeperImpl` under migration tag `v0`; this package
  uses the same class names and tag, so the worker upgrades in place with no wrangler migration.
  Existing `UserAccount` rows hold `read_api`-scoped tokens (insufficient for writes and push) and
  existing gatekeeper bindings carry `{scopePath}` props rather than `{projectPath, resourceKind}`.
  Neither is worth migrating: the stub was labelled incubating. Instead the new code **works with
  what the grant allows and offers the remedy where the Workshop asks for it**. `UserAccount`
  reads a stored grant with **no `scopes` key** as an empty scope set (the new code always
  records the scopes it *requested* at grant time; the stub never wrote that key — and the
  documented token response carries no `scope` field, so requested-scopes is the only reliable
  record anyway), so `describe()` and the observer probe — reads a `read_api` token can serve —
  keep working. `GatekeeperUserImpl.ensureResources()` returns the `reconnect()` URL when the
  recorded scopes lack `api` or `write_repository`; that is the interface's own "expand the
  grant" hook, and the Workshop opens the URL in the connect pop-up before binding a resource. A
  `read_api` token that reaches a binding anyway fails closed at GitLab (403 on writes, 401 on
  push). `GitLabGatekeeperImpl` treats missing `resourceKind` in `ctx.props` as a stale binding
  and says so — so stale state tells the user what to do rather than 403ing mysteriously.
- **Worktree support is the same contract as GitHub's, verbatim.** Every session read that
  returns commit ids advertises them (`GitCache.advertiseCommit()`, per page for cursors via the
  advertising wrapper); results served from the git cache rather than from GitLab are never
  advertised; `gitPull()` is smart-HTTP protocol v2 against `GITLAB_API_URL` with no `have`s and
  at most one `filter`; `push()` binds `{branch, expectedOldSha, newSha, force}` at queue time
  against the simulated branch head, declares `pushedCommits`, checks fast-forward via
  `GitCache.isAncestor()` before `submitAction()`, applies via `buildPack()` into a receive-pack
  request whose old-sha CAS is the queue-time expectation, and reverts by ref rollback; simulated
  reads of pending pushes come from `GitCache.get()`. The only GitLab-specific bytes are the URL
  (`{GITLAB_API_URL}/{path_with_namespace}.git/git-{upload,receive}-pack`) and the Basic-auth
  username (`oauth2`, where GitHub uses `x-access-token`). plans/worktrees.md §3 remains the
  design record for all of this; nothing there is re-decided here.
- **Kit extraction is behavior-neutral and lands first, in the same PR.** `git-transport.ts`
  moves verbatim (its comments stop saying "GitHub" where the protocol is generic, and the
  `filterSpecForHints` limits are documented as "verified against GitHub; conservative for
  others"). `git-diff.ts` moves with vendor-neutral type names (`GitDiffFile`, `GitDiffHunk`,
  `GitDiffLine`); `gatekeeper-github/src/types.d.ts` keeps its `GitHubPullRequestDiff*` names as
  aliases so the agent-facing API is unchanged. `git-commits.ts` splits: `isCommitOid`,
  `parseGitCommitPayload`, `parseGitIdentity`, `commitDetailsFromGitObject` (taking a
  `commitUrl(oid)` callback instead of a repo URL), `CommitAdvertiser`, `advertiseCommits`,
  `CommitAdvertisingCursor` move to `./git-objects`; the four `normalize*Response` REST adapters
  and `actorFromUser` stay in github. Existing node tests move with their subjects. Kit gains the
  `diff` dependency. The github package's diff is deletions plus import rewrites — reviewable on
  its own in the first two commits.
- **Reviews are draft notes + `bulk_publish`; all three GitHub decisions are supported.** GitLab
  has no "review" object in REST, but the Draft Notes API — what its own UI's "Submit review"
  uses — composes into one: create one draft note per diff comment (`POST …/draft_notes` with
  `position`), then `POST …/draft_notes/bulk_publish` with the review body as its `note` (the
  documented "summary note" parameter — no separate draft for the summary) and, for
  `decision: "requestChanges"`, `reviewer_state: requested_changes` (documented: "sets the review
  state after publishing. Does not record a formal approval"). `decision: "approve"` publishes
  with `reviewer_state: reviewed` and then calls `POST …/approve` with `sha: revision.headSha`,
  which the docs guarantee 409s on a stale head — so an approval never lands on a head the agent
  didn't review. `decision: "comment"` publishes with `reviewer_state: reviewed`. So
  `GitLabReviewDecision = "comment" | "approve" | "requestChanges"`, the same enum as GitHub. Two
  documented caveats travel into the JSDoc: `requested_changes` *blocks merging* only on
  Premium/Ultimate (17.2+; on Free it is a visible reviewer state, nothing more), and `bulk_publish`
  publishes **every** draft the token's user has on that MR — see the watch-for.
- **Merge options are GitLab's.** GitHub's `method: merge|squash|rebase` is replaced by
  `squash?: boolean` and `removeSourceBranch?: boolean` (plus `commitMessage?`,
  `squashCommitMessage?`, `expectedHeadSha?` → `sha`). Merge *method* is a project setting in
  GitLab, not a per-merge choice; exposing one would be a lie the API can't keep.
- **`merge()` binds the head it was asked to merge.** One deliberate divergence from GitHub,
  whose merge sends `sha` only when the agent supplies `expectedHeadSha`: an approver approves
  "merge !N" at one moment and the merge applies at another, against whatever head exists then,
  so commits pushed in between (a collaborator's, or the agent's own through another approved
  push) would merge unreviewed. `push()` already binds `expectedOldSha` at queue time for exactly
  this class of race. So `prepareMergeMergeRequest` reads the merge request's current source head
  (an observation the session records, as for every other mutation's preparatory read), binds
  it as `sha` unless the agent supplied its own, and names it in the approval description; GitLab
  answers 409 if the head has moved, the agent re-reads, and the human approves merging the new
  state — the correct outcome. For a provisional merge request the bound head is the simulated
  one (the queued push's commit), which is the head it will have once created. GitHub's merge
  should do the same; see Punted.
- **`close()` takes no reason.** GitLab issues have no `state_reason`; the parameter would be
  ignored. Dropped rather than accepted-and-discarded.
- **Discussion is user-authored notes; approvals are MR metadata.** `readDiscussion()` returns
  non-system, non-diff notes as `kind: "comment"` entries. System notes ("added label", "approved
  this merge request", "mentioned in !12") are excluded — they are audit noise in GitHub terms,
  which never surfaces them either. There is no `kind: "review"` entry (no review object to
  back it); instead `GitLabMergeRequestDetails.approvedBy: GitLabActor[]` comes from
  `GET …/approvals`. Diff-anchored discussions are `readDiffThreads()`'s domain, as on GitHub.
- **Provisional references are kind-aware.** GitHub rewrites `#~N` → `#N`. GitLab references
  issues as `#N` and merge requests as `!N`, so `~N` is a provisional *issue* when written `#~N`
  and a provisional *MR* when written `!~N`; both grammars are rewritten on apply, each against
  its own kind's `provisional:*` record. `getIssue("~1")` and `getMergeRequest("~1")` are
  disjoint lookups, as they are on GitHub.
- **Assignees are usernames, resolved at prepare time.** GitLab's create/update APIs take
  `assignee_ids`; the agent-facing API takes usernames (what agents see in results and URLs).
  `prepareCreateIssue` resolves each via `GET /users?username=` — an observation, recorded as
  such — and fails fast on an unknown one, so the queued action already carries ids and apply
  cannot fail on a typo the agent could have fixed.
- **Caching is TTL-only with the conditional-GET structure retained.** GitLab REST does not
  reliably send `ETag`s; the `Cached<T>.etag` field stays optional and the `#loadCachedWithEtag`
  helper stays (a 304 path that is simply never taken is cheaper to review than a re-shaped cache
  layer), but no test asserts on 304 behaviour and TTLs do the work.
- **Redirects are never followed; a 3xx from the API is "the project has moved" or "Access
  answered".** The docs' "Redirects" section says a renamed or transferred project answers at its
  old path with `301` and a `Location` naming the *numeric-id* URL. A default `fetch` follows
  that — and per the Fetch spec a followed 301 turns a `POST` into a `GET`, so `createIssue` on a
  moved project would silently become an issue *listing* and report success. `request()`
  therefore uses `redirect: "manual"` and maps any 3xx to a `GitLabApiError`, choosing its
  message by the `Location`'s *path*: `/api/v4/…` is the rename (re-bind the connection), anything
  else is an access proxy answering instead of GitLab (the service token is not admitted). By
  path rather than host because GitLab spells the rename's `Location` with its configured
  external URL — the browser-facing host — which differs from the requested host exactly in the
  split-hostname Access layout this gatekeeper exists for. (Following redirects only for GET
  was considered and rejected: a moved project should be re-bound once, not read through a stale
  path forever.) The git smart-HTTP requests use the same setting: a 302 there is Access or a
  login page, not GitLab, and the error should say so rather than fail in the pkt-line parser.
- **Tree-by-oid has no REST fallback; the simulation degrades.** GitHub's simulated MR diff over
  queued pushes falls back to `GET /git/trees/{sha}` when a tree isn't in the workspace cache.
  GitLab's tree endpoint is path-and-ref addressed, not oid addressed, so `TreeDiffSource.getTree`
  returns `null` for a tree the cache lacks and the existing `TreeUnavailableError` path degrades
  the read to the remote (un-simulated) details with a warn log — the failure mode GitHub already
  handles. Blobs by oid *are* available (`GET /repository/blobs/:sha`). Pulling a missing tree
  through the gatekeeper's own upload-pack path is feasible — the docs list
  `uploadpack.allowAnySHA1InWant` among Gitaly-set values and partial clone needs it — but punted
  for scope.
- **A thread is read whole from the discussions endpoint, not incrementally from notes.** The
  first design mirrored GitHub's incremental discussion sync onto GitLab's notes endpoint (a
  watermark walk over `order_by=updated_at&sort=desc`, since notes have no `since`). Review
  caught what the docs say plainly: "items of type DiscussionNote are not returned as part of the
  Note API" — the notes listing omits every *reply*, so `readDiscussion()` would have shown only
  the first comment of every thread. The discussions endpoint has the replies but takes no
  `order_by`, `sort`, or `since` at all, so there is nothing to sync incrementally against.
  `readDiscussion()` therefore reads every discussion (cached 30 s, the same fetch
  `readDiffThreads()` already makes), flattens the notes, drops GitLab's `system` activity and,
  on a merge request, the diff-anchored notes, and orders oldest first. A very long thread costs
  pages of `per_page=100`, not correctness; if it shows up, the remedy is a bounded window over
  the flattened list, not the notes endpoint.
- **`baseSha` means the target branch head at diff time; `mergeBaseSha` means the merge base.**
  These are GitHub's field meanings and they are kept — but GitLab's `diff_refs` names them the
  other way round (`base_sha` = merge base, `start_sha` = target head). The mapping is
  `start_sha → baseSha`, `base_sha → mergeBaseSha`, `head_sha → headSha`, written once in one
  helper (`revisionFromDiffRefs`) with a test that pins it, because this inversion is the single
  most likely bug in the port.

## Current-state anchors (for orientation)

- **Reference implementation**: `packages/gatekeeper-github/src/github.ts` (~5.6k lines): HTTP
  entrypoint (nonce-gated connect URL → `authorize` redirect; `/oauth` callback → `acceptAuthCode`
  → `connectHandoffPageHtml`), `GatekeeperVendor`, `UserAccount` DO (single non-expiring token,
  `stagedCredentials` for reconnect via `gatekeeper-kit/credential-stage`), `GatekeeperUserImpl`
  (`getGatekeeperClassFor` parses `owner/repo[/issues|pull/N]`), `GitHubVerifier`
  (`hasRepoAccess`), `GitHubGatekeeperImpl` DO (caches, action records, provisional ids,
  overlays, discussion/review-comment sync state, branch-head simulation, tree-diff source,
  `gitPull`, `applyAction`/`rejectAction`/`revertAction`, strategy-B `addObserver`), session
  `RpcTarget`s (`GitHubRepoSessionImpl`, `GitHubIssueImpl`, `GitHubPullRequestImpl`) with
  `SessionGitCache`/`AdvertisingCursor`. `github-api.ts` (1.4k lines) is the HTTP client:
  `request()` with bearer/basic auth, `*Conditional` GETs, OAuth exchange/revoke, and the two
  smart-HTTP POSTs. `storage-schema.md` documents the DO key layout (partly stale: it says
  `pendingAction:` where the code uses `action:`; the GitLab one will be written from the code).
- **Git contract** (`workshop-shared/src/gatekeeper.ts`): `GitOid`, `GitObjectType`,
  `GitCache` (`get`/`has`/`stat`/`put`/`advertiseCommit`/`buildPack`/`consumePack`/`isAncestor`),
  `GitPullHints`, `Gatekeeper.gitPull?(oids, cache, hints)`, `Gatekeeper.applyAction(action,
  cache)`, `ActionDescription.pushedCommits`, `ObservationAuthorizer.getGitCache()`. The
  overseer pulls from `meta.onRemote[0] ?? meta.pullableFrom[0]` (`overseer.ts` ~2370), i.e.
  from whichever gatekeeper advertised or proved the object — which is why every commit-id-bearing
  read must advertise. The agent-facing worktree API is `workshop-backend/src/worktree-binding.d.ts`.
- **Git layer** (`gatekeeper-github/src/git-{transport,commits,diff}.ts`): pkt-line codec,
  protocol-v2 fetch composer (`buildGitFetchRequest`, `filterSpecForHints`, no `have`s),
  sideband demux → `GitPackSink.consumePack`, `pullGitObjectsIntoCache(fetchUploadPack, oids,
  hints, cache)`, classic receive-pack composer (`buildRefUpdateRequest`, `report-status` only, no
  side-band), `pushGitRefUpdate(fetchReceivePack, update, pack)`, `GitRefUpdateRejectedError`,
  `emptyPackBytes`; git commit/tree object parsers; `diffGitTrees`/`diffTextLines` over a
  `TreeDiffSource`. Only their doc comments mention GitHub.
- **Kit** (`packages/gatekeeper-kit`): leaf modules with explicit subpath exports, JSDoc on every
  public symbol, README inventory, node tests for pure logic (`AGENTS.md` there). No git code
  today. Dependencies: `backend-utils`, `workshop-shared`, `jose`.
- **Registration is name-derived and config-gated.** `run-dev-server.ts` and
  `manifest-lib.ts:readDeployablePackages` pick up any `packages/gatekeeper-*` with a
  `wrangler.jsonc`; the backend and router discover `GATEKEEPER_*` bindings by prefix; the router
  forwards `/gatekeeper/gitlab/*` to the worker; `BASE_URL` is `…/gatekeeper/gitlab` in dev and
  `$PUBLIC_BASE_URL/gatekeeper/gitlab` in the manifest. `manifest-lib.test.ts` requires a fixture
  bundle per deployable package (`scripts/release/testdata/fixture-bundles/<pkg>/*.js`) and a
  golden regen. `run-dev-server.ts:SHARED_GATEKEEPER_CREDS` maps `<VENDOR>_CLIENT_ID/SECRET` dev
  env vars into `CLIENT_ID`/`CLIENT_SECRET`.
- **Configurator runtime** (`packages/configurator-ui`): `Autocomplete`/`TextInput`/`Field`/
  `Section`; spec `{initial, initialValuesFromResourceUrl?, isReady?, resourceUrl, render}`;
  `resourceUrl()` and `initialValuesFromResourceUrl()` both receive the `ui` capability, which is
  how a GitLab configurator learns the instance URL (GitHub's hardcode `https://github.com/`).
  UI modules are transpiled per file with only `@gadgets/configurator-ui` and type-only imports
  stripped, so they can't import runtime helpers.
- **Resource resolution is first-match** (`resolveRequestedResource` in `gatekeeper.ts`;
  `user.ts:281` for filters), against `SupportedResource.urlPattern` via `URLPattern`, with a
  trailing-slash tolerance wrapper.
- **The internal stub** (`gadgets-internal/packages/gatekeeper-gitlab`): read-only
  `searchIssues`/`searchMergeRequests`/`searchProjects`, PKCE + rotating refresh (unlocked),
  service-token headers on every upstream request, a separate API hostname, strategy-C observers
  from `gatekeeper-shared/observers`, path-prefix scoping, a free-text path configurator, inbound
  Access-JWT check, migration `v0: [UserAccount, GitLabGatekeeperImpl]`. Its plumbing (which
  upstream hostname, which headers) is the specification for §2's instance configuration.
- **How the internal deployment consumes public gatekeepers**: it discovers them in the
  submodule (`findGatekeepers(PUBLIC_PACKAGES_DIR)`), generates `wrangler.prod.jsonc` /
  `wrangler.staging.jsonc` from `PACKAGE_OVERRIDES[pkg]` (`vars` included, flowing to staging
  too), and — because its Vault→secret CI component can't reach submodule packages — gives each
  OAuth gatekeeper a dedicated deploy job that deploys then `wrangler secret put`s from Vault
  (the zoominfo/slack pattern). Its submodule currently predates `gatekeeper-kit` entirely.

## Design

### 1. Kit extraction (gatekeeper-kit + gatekeeper-github)

- `packages/gatekeeper-kit/src/git-transport.ts` — `git-transport.ts` verbatim. Comment edits
  only: the module header's "came from GitHub over TLS" and `filterSpecForHints`'s "GitHub
  rejects" become "the upstream" / "verified live against GitHub; other servers may accept more,
  and honouring them is an optimisation, not a correctness change". Export list unchanged.
- `packages/gatekeeper-kit/src/git-objects.ts` — from `git-commits.ts`: `isCommitOid`,
  `ParsedGitCommit` (over a new neutral `GitCommitIdentity = {name?, email?, date?}`),
  `parseGitCommitPayload`, `parseGitIdentity`, `commitDetailsFromGitObject(oid, payload,
  commitUrl: (oid) => string)` returning a neutral `GitCommitDetails` (no `authorAccount`),
  `CommitAdvertiser`, `advertiseCommits`, `CommitAdvertisingCursor`. `Cursor<T>` is imported from
  `workshop-shared/gatekeeper`.
- `packages/gatekeeper-kit/src/git-diff.ts` — `git-diff.ts` with `GitDiffFile`/`GitDiffHunk`/
  `GitDiffLine`; `TreeDiffSource`, `diffGitTrees`, `changedPathsBetweenTrees`, `diffTextLines`,
  `parseGitTreePayload`, `treeEntryKind`, the three `MAX_*` constants, `TreeUnavailableError`.
  Kit `package.json` gains `"diff": "catalog:"`.
- Subpath exports `./git-transport`, `./git-objects`, `./git-diff`; README inventory rows; JSDoc
  already present, audited for the "every public symbol" rule. `__tests__/git-transport.test.ts`,
  `git-diff.test.ts`, and the object-parsing half of `git-commits.test.ts` move to the kit's node
  project; the `normalize*` half stays in github.
- `gatekeeper-github`: delete the three files; import from the kit; `types.d.ts` aliases
  `GitHubPullRequestDiffFile = GitDiffFile` etc. so the agent-visible text is unchanged (the
  `.d.ts` is served to agents, so the alias is written out rather than re-exported); `git-commits.ts`
  shrinks to the REST adapters + `actorFromUser` + a `commitDetailsFromGitObject` wrapper that
  supplies GitHub's `/commit/` URL and `authorAccount: null`.

### 2. Instance configuration and the HTTP layer (gitlab-api.ts)

- `Env` adds `GITLAB_URL?`, `GITLAB_API_URL?`, `CF_ACCESS_CLIENT_ID?`, `CF_ACCESS_CLIENT_SECRET?`
  beside `BASE_URL`, `CLIENT_ID`, `CLIENT_SECRET`. Three pure helpers in `gitlab.ts`:
  `instanceUrl(env)` (browser-facing origin, trailing slashes stripped, default
  `https://gitlab.com`), `apiOrigin(env)` (`GITLAB_API_URL ?? instanceUrl`), and
  `upstreamHeaders(env)` (`{}` or the two `CF-Access-*` headers). `GitLabApi`'s constructor takes
  `{apiOrigin, headers, getToken}` so tests construct it against a mock origin, and so the
  `GatekeeperUserImpl`/DO/verifier all build it the same way (`#api()` helper).
- `request()` mirrors github's: `Accept: application/json`, `User-Agent: Cloudflare-Gadgets`,
  bearer auth via `getToken`, `AbortSignal.timeout(30s)`, `okStatuses`, **`redirect: "manual"`**
  (3xx → "project moved" error; see the locked decision), and error-body parsing that handles
  the three documented shapes — `{"message": "404 …"}`, the validation hash
  `{"message": {"field": ["…"]}}`, and OAuth-style `{"error", "error_description"}` — into
  `GitLabApiError { status, details, isAuthError: status === 401 }`; a `429` appends the
  documented `Retry-After`. Project paths are passed already URL-encoded
  (`encodeURIComponent(pathWithNamespace)`) — GitLab's `:id` is either the numeric id or the
  encoded full path, and we always use the path; branch and tag names are encoded whole, slashes
  included, per the docs' `my%2Fbranch` rule. Pagination keeps GitHub's "short page means
  exhausted" rule (the `StreamingCursor` is untouched), which is also the only rule that works:
  the docs omit `x-total`/`x-total-pages` above 10,000 results and on the Commits API always.
- **OAuth helpers**: `buildAuthorizeUrl(instanceUrl, {clientId, redirectUri, scopes, state,
  codeChallenge})`, `exchangeAuthCode(apiOrigin, headers, {code, clientId, clientSecret,
  redirectUri, codeVerifier})` → `GitLabOAuthGrant { accessToken, refreshToken, expiresAt }`
  (`expiresAt` from the response's `expires_in` — never a hard-coded 7200, since admins can
  change it from 19.1; the documented response has no `scope` field, so requested scopes are
  recorded by the caller), `refreshAccessToken(...)` (sends `redirect_uri` too, per the
  documented example) → grant or `{ revoked: true }` on a 4xx whose body is
  `error: "invalid_grant"`, `revokeToken(apiOrigin, headers, token, clientId, clientSecret)`
  (called for both tokens — the docs don't say revoking one revokes the other), and
  `fetchCurrentUser(apiOrigin, headers, token)` → `{ username, name, avatarUrl, email?,
  confirmedAt? }` for both `describe()` and `getAuthenticatedEmail()`. All POSTs are
  `application/x-www-form-urlencoded`.
- **Endpoint mapping** (GitHub → GitLab v4; `P` = URL-encoded project path):

  | Purpose | GitHub | GitLab |
  |---|---|---|
  | viewer | `GET /user` | `GET /user` |
  | verified email | `GET /user/emails` | `GET /user` (`email` when `confirmed_at` non-null; `userinfo` rejected — its `email` needs a *public* email) |
  | project metadata | `GET /repos/{o}/{r}` | `GET /projects/P` (`path_with_namespace`, `namespace.full_path`, `default_branch`, `visibility`, `description`, `web_url`, `permissions`) |
  | project access probe | same | same, reading `permissions.{project,group}_access.access_level` (404 for hidden projects; `null`/`null` for a non-member) |
  | configurator: my projects | `GET /user/repos`, `GET /search/repositories` | `GET /projects?membership=true&search=&search_namespaces=true&order_by=last_activity_at&simple=true` |
  | issue | `GET …/issues/{n}` | `GET /projects/P/issues/{iid}?with_labels_details=true` |
  | list / search issues | `GET …/issues`, `GET /search/issues` | `GET /projects/P/issues?state&labels&author_username&assignee_username[]&order_by&sort&search&with_labels_details=true` (`search` covers title+description; the project endpoint has no `in`; `order_by` ∈ `created_at`, `updated_at`, `popularity`, …) |
  | create issue | `POST …/issues` | `POST /projects/P/issues {title, description, labels, assignee_ids}` (multiple assignees are Premium/Ultimate; Free honours one) |
  | title / body / state | `PATCH …/issues/{n}` | `PUT /projects/P/issues/{iid} {title, description, state_event: close\|reopen}` |
  | labels | `POST`/`PUT …/labels` | `PUT /projects/P/issues/{iid} {add_labels, remove_labels}` |
  | notes list | `GET …/comments?since` | `GET /projects/P/issues/{iid}/notes?order_by=updated_at&sort=desc` |
  | note create / edit / delete | `POST`/`PATCH`/`DELETE …/comments` | `POST`/`PUT`/`DELETE /projects/P/issues/{iid}/notes[/{id}]` |
  | resolve username | — | `GET /users?username=` |
  | MR | `GET …/pulls/{n}` | `GET /projects/P/merge_requests/{iid}?with_labels_details=true` (`diff_refs`, `sha`, `draft`, `has_conflicts`, `detailed_merge_status`, `changes_count` (string, `"1000+"` when capped), `source_project_id`/`target_project_id`, `reviewers`, `user.can_merge`, `blocking_discussions_resolved`; `diff_refs`/`changes_count` are single-GET only and empty until populated asynchronously after create) |
  | MR approvals | `GET …/reviews` | `GET /projects/P/merge_requests/{iid}/approvals` (`approved_by[].user`; Free tier) |
  | list / search MRs | `GET …/pulls` + client-side scan | `GET /projects/P/merge_requests?state&source_branch&target_branch&labels&author_username&assignee_username[]&wip=yes\|no&order_by&sort&search&in` (`wip` works everywhere; the `draft` boolean filter is 19.0+ and `wip` is deprecated there — switch when the floor allows) |
  | create MR | `POST …/pulls` | `POST /projects/P/merge_requests {source_branch, target_branch, title, description, remove_source_branch, squash}` (no `draft` param exists — `Draft:` title prefix; recognised prefixes `Draft:`, `[Draft]`, `(Draft)`) |
  | MR title / body / state / labels | issue endpoints | `PUT /projects/P/merge_requests/{iid}` (same fields as issues) |
  | MR notes | issue comments | `GET`/`POST …/merge_requests/{iid}/notes` (`type: null \| DiscussionNote \| DiffNote`, `system`) |
  | diff threads | `GET …/pulls/{n}/comments` | `GET …/merge_requests/{iid}/discussions` (notes with `position`, `resolvable`, `resolved`) |
  | submit review | `POST …/pulls/{n}/reviews` | `POST …/draft_notes {note, position[…]}` ×N, then `POST …/draft_notes/bulk_publish {note: <summary>, reviewer_state: reviewed\|requested_changes}`; approve: additionally `POST …/approve {sha}` (409 on a stale `sha`) |
  | reply to thread | `POST …/comments/{id}/replies` | `POST …/discussions/{discussion_id}/notes {body}` |
  | delete diff note | `DELETE /pulls/comments/{id}` | `DELETE …/merge_requests/{iid}/notes/{id}` |
  | MR files | `GET …/pulls/{n}/files` | `GET …/merge_requests/{iid}/diffs?page&per_page` (`diff`, `old_path`, `new_path`, `a_mode`, `b_mode`, `new_file`, `renamed_file`, `deleted_file`, `generated_file`, `too_large`, `collapsed` (18.4+); `changes` is deprecated since 15.7) |
  | MR commits | `GET …/pulls/{n}/commits` | `GET …/merge_requests/{iid}/commits` |
  | merge | `PUT …/pulls/{n}/merge` | `PUT …/merge_requests/{iid}/merge {squash, squash_commit_message, merge_commit_message, should_remove_source_branch, sha}` — documented codes: 405 cannot merge, 409 `sha` mismatch, 422 branch cannot be merged, 401 no permission (no 406) |
  | compare | `GET …/compare/{b}...{h}` | `GET /projects/P/repository/compare?from&to` (`commits` always complete; `diffs` may be incomplete when `compare_timeout`; **no merge base in the response**) |
  | merge base | `merge_base_commit` on compare | `GET /projects/P/repository/merge_base?refs[]=&refs[]=` |
  | branches | `GET …/branches[/{name}]` | `GET /projects/P/repository/branches[/{name}]?search` (`commit.id`, `protected`, `default`, `can_push`; name encoded whole, `feature%2Fx`) |
  | tags | `GET …/tags` | `GET /projects/P/repository/tags` (use `commit.id` — for annotated tags `target` is the tag object) |
  | commit / resolve ref | `GET …/commits/{ref}` (+ `sha` media type) | `GET /projects/P/repository/commits/{ref}` (branch or tag name, or sha — abbreviated resolution is implied by the docs' own `merge_base` example, confirmed live; `id`, `parent_ids`, `author_*`, `committer_*`, `stats` on single GET; no sha-only media type, so `resolveRef` and `getCommit` share one cached read) |
  | history | `GET …/commits?sha&path&author&since&until` | `GET /projects/P/repository/commits?ref_name&path&author&since&until&first_parent` (never returns `x-total`) |
  | tree by oid | `GET …/git/trees/{sha}` | **none** (path+ref only) |
  | blob by oid | `GET …/git/blobs/{sha}` | `GET /projects/P/repository/blobs/{sha}` (`size`, base64 `content`) |
  | git fetch | `POST github.com/{o}/{r}.git/git-upload-pack`, Basic `x-access-token:` | `POST {apiOrigin}/{path}.git/git-upload-pack`, Basic `oauth2:<token>` (the documented username), `Git-Protocol: version=2` (v2 "enabled by default in GitLab for HTTP requests") |
  | git push | `…/git-receive-pack` | same host/auth, classic protocol; requires the `write_repository` scope |
  | authorize | `github.com/login/oauth/authorize` | `{instanceUrl}/oauth/authorize?response_type=code&scope=&state=&code_challenge=&code_challenge_method=S256` |
  | token / refresh / revoke | `…/login/oauth/access_token`, `DELETE /applications/{id}/token` | `{apiOrigin}/oauth/token` (`grant_type=authorization_code` + `code_verifier`; `grant_type=refresh_token` + `redirect_uri`), `{apiOrigin}/oauth/revoke {client_id, client_secret, token}` |

  Every cell above is taken from the current GitLab documentation (see [Verification](#verification)).
  The `author` history filter and `with_labels_details` carry no "introduced in" note on the
  current pages, which means they predate the docs' history window (~3 major versions) and are
  safe on any supported instance; the version-gated items are listed under Verification.

### 3. Accounts and OAuth (UserAccount, GatekeeperVendor, GatekeeperUserImpl)

- **Connect URL and callback** exactly as GitHub's: `connectAccount()` mints a `UserAccount`,
  stores `callback`, `requestedScopes`, `ephemeral`, an initiation nonce with a 10-minute
  lifetime and a 1-hour self-destruct alarm, and returns `${BASE_URL}/${doId}/${nonce}`. Visiting
  it → `beginOAuthFlow()` swaps in an OAuth-stage nonce **and generates the PKCE verifier**
  (stored beside the nonce, one per flow) → 302 to `{instanceUrl}/oauth/authorize` with
  `state = ${doId}:${oauthNonce}`, `code_challenge`, `code_challenge_method=S256`, `scope`.
  `/oauth` callback → `acceptAuthCode(code, oauthNonce)` verifies the nonce in constant time,
  deletes it and the verifier, exchanges the code (with `code_verifier`), and either stages the
  grant (`reconnect` flows → `stageCredentials` → `callback.reconnectComplete(stageId)`) or writes
  it live and calls `callback.complete(GatekeeperUserImpl({props}))`; the browser lands on
  `connectHandoffPageHtml`. Auth-only grants set the 2-minute alarm. All from
  `gatekeeper-kit/connect-pages` and `credential-stage`; nothing hand-rolled.
- **Grant storage**: `accessToken`, `accessTokenExpiresAt`, `refreshToken`, `scopes`,
  `expiredNotified`, `stagedCredentials` (kit key). `commitReconnect(stageId)` writes all four
  grant keys. The scope guard lives in `ensureResources()`, not `getAccessToken()`: a grant whose
  recorded `scopes` (missing → empty) lack `api` or `write_repository` is answered with the
  `reconnect()` URL, and reads the grant can serve are never refused (auth-only grants never get
  here — they're consumed via `getAuthenticatedEmail` and destroyed).
- **Refresh** per the locked decision: `Mutex` (as `gatekeeper-google`), fast path when
  `expiresAt − now > ACCESS_TOKEN_EXPIRY_SAFETY_MS`, in-lock re-check, `refreshAccessToken`,
  `ctx.storage.transactionSync` writing both tokens and the new expiry, `#mintFailure` cooldown
  on non-`invalid_grant` errors, `credentialsExpired()` (once, via `expiredNotified`) on
  `invalid_grant`. `revoke()` revokes the *refresh* token (which invalidates the pair), logs on
  failure, `deleteAll()`.
- **`GatekeeperVendor.describe()`**: `displayName: "GitLab"`, `url: instanceUrl(env)`, the
  GitLab logo (from the internal stub's `gitlab-logo.svg`), `tagline: "Triage issues, review
  merge requests, and push to projects"`, `providesAuth: true`.
- **`GatekeeperUserImpl`**: `describe()` from `GET /user` (`name`, `username`, `avatar_url`);
  `getAuthenticatedEmail()` from the same `GET /user`: `email` when `confirmed_at` is non-null,
  else `null`; `getSupportedResources()`
  builds the three patterns from `instanceUrl(env)`; `getGatekeeperClassFor(url)` requires the
  URL's origin to equal `instanceUrl(env)`, splits the path on `/-/`, takes the left side as
  `projectPath` (≥ 2 segments) and the right side as `issues/N` | `merge_requests/N` | nothing →
  `resourceKind: "issue" | "mergeRequest" | "project"`; `startResourceConfigurator` per pattern;
  `reconnect()`/`commitReconnect()`/`revoke()`/`ensureResources()` as GitHub; `getVerifier()`
  mints `GitLabVerifier({props: {userObjectId}})`.

### 4. Resources, URL patterns, DO props, configurators

- Patterns (built at call time from `instanceUrl`), **ordered most-specific first** because
  `resolveRequestedResource` is first-match and `:project+` also matches the longer URLs:
  1. `{instanceUrl}/:project+/-/merge_requests/:iid` — "GitLab Merge Request"
  2. `{instanceUrl}/:project+/-/issues/:iid` — "GitLab Issue"
  3. `{instanceUrl}/:project+` — "GitLab Project"
  `getGatekeeperClassFor` is authoritative regardless of which pattern the UI picked. A test
  pins the ordering by resolving an MR URL and asserting the MR resource.
- `GitLabGatekeeperImplProps = { userObjectId, resourceKind: "project" | "issue" | "mergeRequest",
  projectPath, iid? }`. `projectPath` is the full `path_with_namespace` (never the numeric id —
  it's what appears in URLs and what the observer probe needs). `#projectRef()` builds
  `GitLabProjectRef { path, name, namespace, url }` from it.
- **Configurators** mirror GitHub's three, with two GitLab adaptations. `GitLabProjectConfiguratorUI.
  listProjects(query)` uses the membership listing (empty query) or `search=` +
  `search_namespaces=true` (non-empty), and falls back to an exact `GET /projects/P` when the query
  parses as a path or an instance URL (`parseProjectPath`, which splits on `/-/` and strips the
  instance origin). Issue and MR UIs add an `Autocomplete` fed by the `search=` listings, with
  `#N`/`!N` numeric fallbacks. Because the UI module can't read env, the `ui` capability gains
  `instanceUrl(): Promise<string>`, and both `resourceUrl()` and `initialValuesFromResourceUrl()`
  use it (`resourceUrl` is allowed to be async; `initialValuesFromResourceUrl` can also derive the
  origin from `resourceUrlPattern`). Round-trip test: `resourceUrl(initialValuesFromResourceUrl(u))
  === u` for nested-group URLs.

### 5. Session API (`types.d.ts`) — the review artifact

`types.d.ts` is written first and reviewed before §6 begins (the write-gatekeeper skill's API
gate; it applies within a single PR as a review checkpoint on the commit). It is GitHub's
`types.d.ts` transposed, method for method, with this divergence table as its changelog. JSDoc
follows the skill's rule: what the method does, parameters, result shape, errors — no approval
queue, no caching, no OAuth.

| GitHub | GitLab | Why |
|---|---|---|
| `GitHubRepo` / `GitHubRepoRef {owner, name, fullName, url}` | `GitLabProject` / `GitLabProjectRef {path, name, namespace, url}` | nested namespaces; `owner` has no meaning |
| `GitHubPullRequest`, `createPullRequest`, `getPullRequest`, `listPullRequests`, `searchPullRequests` | `GitLabMergeRequest`, `createMergeRequest`, `getMergeRequest`, `listMergeRequests`, `searchMergeRequests` | vocabulary |
| `head` / `base` (`GitHubPullRequestBranchRef {ref, sha, repo}`) | `source` / `target` (`GitLabBranchRef {branch, sha, project}`) | vocabulary; forks via `source_project_id` |
| `GitHubIssueState = "open" \| "closed"` | issues `"opened" \| "closed"`; MRs `GitLabMergeRequestState = "opened" \| "closed" \| "merged" \| "locked"` | GitLab states; `merged` is a state, not `merged: boolean` |
| `close(reason?: "completed" \| "notPlanned")` | `close()` | no `state_reason` |
| `GitHubPullRequestSummary.merged: boolean`, `.draft` | `state === "merged"`; `draft` kept | as above |
| `createPullRequest({head, base, draft})` | `createMergeRequest({sourceBranch, targetBranch, draft, removeSourceBranch?, squash?})` | GitLab MR options |
| `merge({method, commitTitle, commitMessage, expectedHeadSha})` | `merge({squash?, removeSourceBranch?, commitMessage?, squashCommitMessage?, expectedHeadSha?})` | merge method is a project setting |
| `GitHubReviewDecision = "comment" \| "approve" \| "requestChanges"` | same three values | `bulk_publish` takes `reviewer_state: reviewed \| requested_changes`; "requested changes" blocks merging only on Premium/Ultimate 17.2+ (JSDoc says so) |
| `GitHubDiscussionEntry` `kind: "comment" \| "review"` | `kind: "comment"` only; `GitLabMergeRequestDetails.approvedBy: GitLabActor[]` | no review object; approvals are metadata |
| `GitHubDiffThread {id, target, isOutdated, isResolved?, comments}` | same shape; `isOutdated` becomes `isOutdated?` computed as `position.head_sha !== diff_refs.head_sha` | REST has no outdated flag; documented as approximate |
| `replyToDiffComment(commentId, body)` | same signature | note id → discussion id resolved internally |
| — | `resolveDiffThread(threadId)` / `unresolveDiffThread(threadId)` | GitLab-native, cheap (`PUT …/discussions/:id?resolved=`); both are actions |
| `GitHubDiffCommentTarget` line/file, `side: "old" \| "new"`, `startLine` | same shape | maps to `position{base_sha, start_sha, head_sha, old_path, new_path, old_line, new_line, line_range}`; `position_type: "text" \| "file"` (both documented, no version gate); both paths are always required; multi-line needs `line_range.start/end.{line_code, type}` where `line_code = sha1(path) + "_" + old + "_" + new` — computed in the DO |
| `GitHubPullRequestDetails.mergeable?`, `requestedReviewers`, `commits`, `additions`, `deletions`, `changedFiles` | `mergeStatus: string` (`detailed_merge_status`, 25 documented values), `hasConflicts`, `canMerge` (`user.can_merge`), `reviewers`, `approvedBy`, `changedFiles?` (from `changes_count`: a string, `"1000+"` when capped → `1000` with `changedFilesTruncated: true`; `undefined` while GitLab is still populating it after create); **no `additions`/`deletions` on details** | MR JSON has no line counts; `readDiff()` still reports per-file counts |
| `GitHubCommitSummary.authorAccount` | dropped | commit JSON has no linked account |
| `GitHubIssueFilter.sort: "created" \| "updated" \| "comments"` | issues `"created" \| "updated" \| "popularity"`; MRs `"created" \| "updated"` | GitLab `order_by` (`popularity` = upvotes; `merged_at` is 17.2+ and left out) |
| `GitHubPullRequestFilter.head: "user:ref"` | `sourceBranch: string`, `targetBranch: string` | no cross-fork branch spec in the list filter |
| `GitHubPullRequestSearch.merged?: boolean` | folded into `state` | `merged` is a state |
| `GitHubCreateIssueOptions.assignees: string[]` (logins) | `assignees: string[]` (usernames) | same shape; resolved to ids at prepare |
| `#~N` provisional references | `#~N` (issue) and `!~N` (MR) | GitLab reference grammar |
| `GitHubPullRequestRevision {baseSha, headSha, mergeBaseSha?}` | `GitLabMergeRequestRevision` same names, same meanings | mapped from `diff_refs` via `revisionFromDiffRefs` (see locked decision) |
| `GitHubPullRequestDiffFile`/`Hunk`/`Line` | `GitLabDiffFile`/`Hunk`/`Line` = kit's `GitDiffFile`/… | shared |

Everything else — `Cursor<T>`, page options, `listBranches`/`listTags`/`resolveRef`/`getCommit`/
`listCommits`/`push` on the project, `getDetails`/`setTitle`/`setBody`/`addLabels`/
`removeLabels`/`reopen`/`readDiscussion`/`postComment` on issues, `readDiff`/`readDiffThreads`/
`postReview`/`listCommits`/`getMergeBase` on MRs, the worktree-oriented JSDoc ("mount a commit as
a worktree", "push then createMergeRequest back to back") — is GitHub's text with the nouns
swapped.

### 6. Gatekeeper DO: caching, actions, simulation (GitLabGatekeeperImpl)

Structure and method inventory follow `GitHubGatekeeperImpl` one-for-one; the private-method list
in `github.ts` is the checklist. Divergences:

- **Action union** — same members with GitLab names: `createIssue`, `createMergeRequest`,
  `setTitle`, `setBody`, `addLabels`, `removeLabels`, `changeState`, `postComment`, `postReview`,
  `replyToDiffComment`, `resolveDiffThread`, `mergeMergeRequest`, `push`. `BaseAction` carries
  `projectPath` instead of `owner`/`repo`. `EntityKind = "issue" | "mergeRequest"`; mutations on
  MRs go to the MR endpoints (GitHub routes them through issue endpoints — a simplification, not
  a complication).
- **Apply**: `createIssue` → `POST` with pre-resolved `assignee_ids`; `createMergeRequest` →
  `POST` (title prefixed `Draft: ` when `draft` and not already prefixed), a `409` surfaced
  verbatim (the generic REST meaning is "a conflicting resource already exists" — an MR for these
  branches), the GitHub "approve the push first" guard kept for a `400`/`409` when the source
  branch has a queued push; `changeState` → `PUT {state_event}`; `addLabels`/`removeLabels` →
  `PUT {add_labels}` / `{remove_labels}` — atomic deltas, so a label a human added meanwhile is
  never clobbered; `previousLabels` is captured for revert; `postComment` → `POST …/notes`,
  revert info `{type: "note", kind, noteId}`;
  `postReview` → `approve {sha: revision.headSha}` first for `"approve"` (the one step with a
  compare-and-swap and the one whose failure is expected — a 409 for a moved head — so it runs
  before anything is posted and a retry is clean; recorded as `progress.approved`), then N
  `POST …/draft_notes`, then `bulk_publish {note: body, reviewer_state}` — or, if `GET
  …/draft_notes` shows drafts we did not create, per-draft `PUT …/draft_notes/:id/publish` so a
  human's parked drafts are left alone. Every step records itself on the action record
  (`progress.{approved, publishedComments, draftIds, summaryPosted}`) so a retry resumes: it
  skips the comments already published, deletes the drafts it created but never published (never
  mistaking them for the user's), recreates the rest, and posts the summary only if it has not. No `(target, body)`
  matching of provisional diff-comment ids to real notes: the session refuses replies to
  provisional ids, so the aliases would have no reader (GitHub's come free with the review
  POST's response; here they would cost a round-trip); `replyToDiffComment` → resolve note id →
  discussion id (`discussions` lookup) → `POST …/discussions/:id/notes`; `resolveDiffThread` → `PUT …/discussions/:id {resolved: true}`;
  `mergeMergeRequest` → `PUT …/merge` with `sha` bound at prepare (see Locked), mapping the
  documented codes — `405` "cannot merge"
  (re-read `detailed_merge_status` and quote it: `conflict`, `not_approved`,
  `discussions_not_resolved`, `draft_status`, `need_rebase`, … — and, since CI is not exposed in
  v1, `ci_must_pass`/`ci_still_running` say "the pipeline has not passed yet; pipeline status is
  not available through this connection — check it in GitLab"), `409` "the head moved since you
  read it" (`sha` mismatch), `422` "the branch cannot be merged", `401` "no permission to merge";
  `push` → §7. Every branch ends `#markActionApproved` + `#clearCaches()`.
- **Revert**: `setTitle`/`setBody`/`changeState` → `PUT` with the previous value;
  `addLabels` → `PUT {remove_labels}` of only the labels the action *introduced* (those not in
  `previousLabels`), `removeLabels` → `PUT {add_labels}` of only those it *removed* (those in
  `previousLabels`) — the naive inverse would strip a label that was already there; `postComment` /
  `replyToDiffComment` → `DELETE …/notes/:id`; `resolveDiffThread` → `PUT …?resolved=false`;
  `push` → ref rollback (§7); `createIssue`, `createMergeRequest`, `postReview`,
  `mergeMergeRequest` → "cannot be automatically reverted". (An approval *can* be undone with
  `POST …/unapprove`, but a review's published notes cannot, so `postReview` stays
  non-revertible as a unit.)
- **Reject cascades**: identical (`#rejectActionsForResource`, `#rejectReplyDependencyChain`,
  `#rejectMergeRequestsForMissingBranches`).
- **Overlay** (`#overlayIssueLike`): identical, plus `mergeMergeRequest` sets
  `state: "merged"` (GitHub: `state: "closed", merged: true`) and `changeState` to `reopened` from
  `merged` is refused at prepare time (GitLab won't reopen a merged MR).
- **Listing/search**: `#listIssueSummaries` and `#searchIssueSummaries` collapse into one path —
  GitLab's list endpoint *is* the search endpoint (`search=` + `in=`) — as do the MR pair. The
  GitHub client-side PR scan (`#searchPullSummaries`' buffered upstream walk) is deleted; so is
  `github-search.ts`'s scope-assertion, since a project-scoped endpoint can't leak another
  project's rows.
- **Discussion**: `#getDiscussion` reads `…/notes` for both kinds, dropping `system: true` and
  `type === "DiffNote"` rows; the pull-request two-stream merge (comments ⨝ reviews) is gone.
  `#fetchRemoteDiscussionComments` flattens the cached discussions (locked decision). `#fetchRemoteDiffThreads`
  reads `…/discussions`, keeps discussions whose first note has a `position`, and maps
  `position` → `GitLabDiffCommentTarget` (`new_line` → `side: "new"`, else `old_line` →
  `"old"`; `line_range.start` → `startLine`/`startSide`; `position_type === "file"` → file target).
- **Diff**: `#getDiff` streams `…/diffs` pages through `#normalizeDiffFile` (`new_file` →
  `added`, `deleted_file` → `removed`, `renamed_file` → `renamed` with `previousPath: old_path`,
  else `modified`; an empty `diff` on a non-empty change → `diffOmitted: true`); additions/
  deletions per file are counted from the parsed hunks (the kit's `parsePatch`-equivalent lives
  in the DO as on GitHub). `revision` from `revisionFromDiffRefs(mr.diff_refs)`. `#getMergeBaseCached`
  calls `/repository/merge_base` (immutable cache, keyed by both shas) — no compare trick.
- **Caches**: same `Cached<T>`/generation scheme and TTLs; ETags optional and expected absent.
  Cache key families renamed where the entity is (`mr:`, `list-mrs:`, `mr-diffs:`,
  `mr-commits:`); the incremental sync state that survives cache clears is `discussionComments:*`
  (as GitHub) and `diffDiscussions:*` (GitHub's `pullReviewComments:*`). All documented in
  `storage-schema.md` from the code, not from GitHub's doc.

### 7. Git operations — worktree support

Unchanged in design from plans/worktrees.md §3 and from `GitHubGatekeeperImpl`; the port
substitutes transport endpoints and REST lookups:

- **Advertising**: `GitLabProjectSessionImpl` and `GitLabMergeRequestImpl` own a
  `SessionGitCache`; `listBranches` (`commit.id`), `listTags` (`commit.id`), `resolveRef`,
  `getCommit`, `listCommits`, MR `getDetails` (`sha`, `diff_refs.*`), `readDiff` (revision shas),
  `getMergeBase`, MR `listCommits`, `listMergeRequests`/`searchMergeRequests` (source/target
  shas) all advertise, with the cache-served / simulated carve-out via `isSimulatedCommitId`.
- **`gitPull(oids, cache, hints)`**: `pullGitObjectsIntoCache(body => api.fetchGitUploadPack(
  projectPath, body), oids, hints, cache)`; `fetchGitUploadPack` POSTs to
  `{apiOrigin}/{path}.git/git-upload-pack` with `Git-Protocol: version=2`, Basic `oauth2:<token>`,
  the upstream Access headers, and the 120s budget. The token is fetched immediately before the
  request (it may be minutes from expiry; the pack streams well within the 2-hour window).
- **`push(branch, commitId, {force?})`**: `preparePush` reads the live branch head (`GET
  …/repository/branches/:name`, 404 → `ZERO_OID`), overlays queued pushes via
  `#simulateBranchHead`, no-ops when already at `commitId`, checks `isAncestor` unless `force` or
  creating, queues `{branch, expectedOldSha, newSha, force}` with `pushedCommits: [commitId]`.
  Apply: `cache.buildPack()` → `pushGitRefUpdate(body => api.fetchGitReceivePack(projectPath,
  body), …)`; `GitRefUpdateRejectedError` → re-read head; equal to `newSha` → desired-state
  success, else "branch moved / was created" (GitLab's pre-receive hook text — protected
  branch, push rules — is appended from the `ng` status line so the agent sees *why*). Revert:
  rollback to `expectedOldSha`, or delete when the push created the branch.
- **Simulation**: `#simulateBranchHead`, `#collectPendingChain` (`isCommitOnRemote` via `GET
  …/commits/:sha`, 404 → false), `#simulatedMergeRequestComparison` (`/repository/compare` for the
  anchored part + `diffGitTrees` for the pending chain, merge base from `/merge_base`),
  `#treeDiffSource` (`getTree`: cache only, else `null`; `getBlob`: cache, else
  `/repository/blobs/:sha` under `MAX_DIFF_BLOB_BYTES`), `#overlaySimulatedMergeRequestHead`,
  `#overlayMergeRequestSummaryHead`, injected created branches in `listBranches` with
  `revalidateInjected`, `#filterPendingCommitsForListing`. `#servedSimulatedCommitIds` and the
  `MAX_PENDING_CHAIN_COMMITS` cap carry over.
- **Fork MRs**: a source branch in another project (`source_project_id !== target_project_id`)
  is never overlaid (GitHub checks `head.repo.fullName !== this.#repoFullName()`; here
  `source.project.path !== projectPath`), and a push targets only the bound project.

### 8. Observers

Strategy B, as GitHub: `GitLabVerifierApi extends GatekeeperUserVerifier { hasProjectAccess(
projectPath): Promise<boolean> }`; `GitLabVerifier` probes `GET /projects/P` with the observer's
own token; `addObserver` throws when it returns `false`; `removeObserver` is a no-op. Issue and
MR bindings inherit the project ACL. The internal stub's strategy-C tracker is not carried over
(no group scope, §Locked).

Two tightenings over GitHub's "a 200 means read access", both grounded in GitLab's documentation
and both places where GitHub's model, carried over unexamined, would leak:

- **Repository read is not implied by seeing the project.** GitLab's **Guest** role can "view and
  comment on issues" on a private project but "cannot push code or access repository". A 200 on
  the project alone would admit an observer to cached git data they cannot read on GitLab.
- **Project visibility is not implied to cover everything in it.** "You can create confidential
  issues in a public project"; a confidential issue is visible only to Planner+ (Reporter+ before
  17.7), and an *internal note* — on an issue, epic, or merge request, public project or not — is
  visible only to Reporter+. A non-member on a public project would be admitted to confidential
  issues and internal notes the owner's token read. GitHub has no counterpart: a public repo's
  issues and comments are all public, which is why its probe can stop at "can read the repo".

So the probe requires **membership at Reporter (20) or above**, whatever the visibility: the
documented ladder is 5 Minimal, 10 Guest, 15 Planner, 20 Reporter, 25 Security Manager, 30
Developer, 40 Maintainer, 50 Owner, and Reporter is the lowest role that sees everything a binding
can disclose. It reads that from the observer's **effective membership** — `GET /user` for their
id, then `GET /projects/P/members/all?user_ids[]=:id`, documented as "including members inherited
or invited through ancestor groups" and returning "only their membership with the highest
`access_level` … the effective permission of the user" — never from the project's `permissions`
object. The list form with the documented `user_ids` filter, rather than `members/all/:user_id`:
its non-member answer is a documented shape (`[]`) that was verified live, where the single-member
form's 404 is neither documented nor reachable through the tooling used to check. A spot check on the internal instance (as one user, five `cloudflare/…` group projects in
three subgroups) is why: `permissions` read `project_access: 50` on the one project with a
*direct* membership and `null`/`null` on the other four, where `members/all` showed the same user
as an inherited Developer. On that project ~90% of members (75 of 86) hold their access by
inheritance, so a `permissions`-based probe would have denied nearly every legitimate observer
once the visibility branch was gone — and before that had admitted them for the wrong reason. The
same check confirmed the probe's inputs: a genuine non-member (a user-namespace project) reads
`[]`, the inherited Developer one row at 30, a nonexistent id `[]`. A
membership still `awaiting` acceptance is not one; 404 (non-member, or a project the token cannot
see) and 403 → `false`; anything else rethrows.

Over-strictness is accepted where the ladder is finer than our threshold: Planner (15) sees
confidential issues and gains private-repository read in 18.7+, and a per-role custom permission
could too — both are denied here, which under `excludeObservers` semantics blocks an observation
rather than leaking one. So is the non-member collaborator on a public open-source project: they
can observe once the owner grants them Reporter, and until then a workspace that never read a
confidential issue still denies them. That trade is the right way round — the alternative,
stripping confidential issues and internal notes from what the gatekeeper discloses so that the
public-project admission becomes sound, would take a headline GitLab feature (security triage in
confidential issues) away from every owner to serve the rarer case.

### 9. Tests

Same two-project layout as GitHub (`vitest.config.ts` node, `vitest.worker.config.ts` workerd
with `capnwebValidate()`, `assert-workerd.ts`, a `TestHooks` DO reaching the gatekeeper through
`ctx.facets`). As built — the per-commit list under Commit sequence names each file's scenarios:

- Node: `gitlab-api.test.ts` — path encoding for nested namespaces and branch names with
  slashes; every endpoint's query composition; the two redirect messages, by path; the error-body
  shapes; OAuth bodies, PKCE, `invalid_grant` classification; Access headers present iff both
  secrets set; `oauth2` basic-auth username on both git POSTs; the capped raw blob read; the
  members filter and highest-row fold. `gitlab-normalize.test.ts` — REST→API mapping,
  `revisionFromDiffRefs`, `parseResourceUrl` round trips including `/-/` splitting, the
  line-position walk with each line's kind.
  `configurator-url.test.ts` — each configurator's `resourceUrl` round-trips through
  `parseResourceUrl`, and every pre-fill parser agrees with it.
- Workerd, GitLab faked at `fetch`: `account.test.ts` (refresh rotation and collapse, terminal vs
  transient failure, a stub-era grant still served, `ensureResources` answering an under-scoped
  grant with the reconnect URL, a disconnect racing the code exchange, identity),
  `resources.test.ts` (pattern order incl. tab suffixes, URL parsing, stale props, the membership
  probe: Reporter admitted however held, Guest/Planner/non-member/awaiting denied, `permissions`
  never consulted), `reads.test.ts` (every read's shape, the `diff_refs` inversion, MR commit
  order, discussion filtering, threads), `actions.test.ts` (provisional create/read/apply/resolve,
  reject cascades, each mutation's simulation/apply/revert including label-revert deltas, the
  review publish path in all three shapes and every line kind's position, the review's retry and
  discard paths, empty reviews refused, an already-applied action re-delivered, a touched issue on
  a full listing page, the merge head bound and its error mapping), `push.test.ts` (CAS binding,
  stacking, no-op, non-ff refusal, branch creation, simulated heads in every read, the pending
  chain in listings, the simulated MR comparison and its degradation, apply/desired-state/revert,
  cascade to dependent MRs, the v2 fetch), `session-git.test.ts` (every commit-id-bearing read
  advertises, simulated ids withheld, the preparatory observations before push and merge).
- Kit: the moved node tests, unchanged apart from import paths and the neutral type names.

### 10. Deployment integration (public repo)

- `wrangler.jsonc`: name `gatekeeper-gitlab`, `main` via `capnweb-validate`, compatibility date
  and flags as GitHub's, Text rules for `.txt`/`.svg`, `migrations: [{tag: "v0",
  new_sqlite_classes: ["UserAccount", "GitLabGatekeeperImpl"]}]`, observability block. No `vars`
  block (defaults live in code so an absent var means gitlab.com).
- `deploy-inputs.json`: `CLIENT_ID` (`consoleUrl: https://gitlab.com/-/user_settings/applications`,
  setup steps naming the redirect URI, the `api`, `write_repository` and `read_user` scopes, and
  "Confidential" checked),
  `CLIENT_SECRET`. `redirectUriTemplate: "{PUBLIC_BASE_URL}/gatekeeper/gitlab/oauth"`.
- `README.md`: modeled on GitHub's — OAuth app creation on gitlab.com, `.env`, optional
  sign-in via `AUTH_GATEKEEPERS=…,gitlab`, a **Self-hosted instances** section (`GITLAB_URL`,
  `GITLAB_API_URL`, the Access service-token pair, the note that the OAuth app on the instance
  must allow the redirect URI and scopes), troubleshooting (`invalid_grant` after long idle =
  refresh token expired → reconnect; `redirect_uri` mismatch; "not configured").
- `run-dev-server.ts:SHARED_GATEKEEPER_CREDS` gains `"gatekeeper-gitlab": { id: "GITLAB_CLIENT_ID",
  secret: "GITLAB_CLIENT_SECRET" }`. `scripts/release/testdata/fixture-bundles/gatekeeper-gitlab/
  gitlab.js` + `UPDATE_GOLDEN=1` regen. `staging-config.test.ts`'s `>= 16` floor is unaffected.
- `packages/gatekeeper-gitlab/vite.config.ts` re-exports the shared configurator config wrapped
  with `withVitestTask(..., ["vitest run", "vitest run -c vitest.worker.config.ts"])`, exactly as
  GitHub's.
- Repo docs: AGENTS.md's package list gains a `gatekeeper-gitlab` bullet (instance config, the
  `diff_refs` inversion, the tree-by-oid gap); the write-gatekeeper skill's reference list gains
  it as "GitHub mirror with rotating credentials and instance configuration".

### 11. What the internal deployment needs from this package

Kept abstract here; the concrete hostnames, Vault paths, and job definitions are in the internal
repo's companion plan. The public package must, and does, provide: a worker named
`gatekeeper-gitlab` with DO classes `UserAccount` and `GitLabGatekeeperImpl` under tag `v0`
(in-place upgrade of the stub's worker); `vars` `GITLAB_URL` / `GITLAB_API_URL` settable per
deployment; secrets `CLIENT_ID` / `CLIENT_SECRET` / `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`;
the `/gatekeeper/gitlab/oauth` callback path; and fail-closed handling of the stub's leftover
`read_api` grants and `{scopePath}` props. The internal PR bumps the submodule past this one
(its first bump past the kit's introduction), deletes its stub, adds the `PACKAGE_OVERRIDES`
entry and a dedicated deploy-then-`secret put` job, and updates the OAuth app's redirect URI and
scopes.

## Constants (tunable, named in one place)

- `ACCESS_TOKEN_EXPIRY_SAFETY_MS` — refresh when less than this remains (60 s; GitLab tokens live
  7200 s).
- `MINT_FAILURE_COOLDOWN_MS` — back-off after a non-terminal refresh failure (60 s, as google).
- `ENTITY_CACHE_TTL_MS` / `LIST_CACHE_TTL_MS` / `IMMUTABLE_CACHE_TTL_MS` / `VIEWER_CACHE_TTL_MS`,
  `DISCUSSION_SYNC_OVERLAP_MS`, `DISCUSSION_SYNC_BAIL_LIMIT`, `MAX_REPLY_TARGET_HOPS`,
  `MAX_PENDING_CHAIN_COMMITS` — GitHub's values.
- `REQUEST_TIMEOUT_MS` (30 s), `GIT_TIMEOUT_MS` (120 s) — GitHub's values.
- `DEFAULT_INSTANCE_URL = "https://gitlab.com"`.

## Verification

No pre-implementation spikes. Every API-shape question was answered from the current GitLab
documentation (a full pass over the OAuth2/OIDC, Users, Projects, Issues, Notes, Discussions,
Draft Notes, Merge Requests, Approvals, Repositories, Commits, Branches, Tags, REST-pagination and
roles pages), and the remaining unknowns are either deployment facts no token could answer or
questions whose answers matter only to punted work. Confidence is built in layers instead:

1. **Doc-derived fixtures.** The workerd suites fake GitLab at `fetch` with the documentation's
   own example responses (§2's table cites where each came from), labelled `source: docs` in the
   fixture files. At each live checkpoint below they are replaced by captured responses and the
   label flips to `source: live`; a fixture still labelled `docs` after checkpoint 2 is a review
   finding.
2. **Live checkpoint 1 — read-only, after commit 4**, against a throwaway gitlab.com project
   with a personal `api`-scoped token standing in for the OAuth grant: every observation method
   end to end, plus the documented ambiguities that only a live call settles — does `GET /user`
   under a `read_user`-scoped token include the private `email` (decides the sign-in scope,
   §Locked); is an abbreviated sha accepted by `GET …/commits/:sha` (the docs imply it via their
   `merge_base` example); how a binary file appears in `…/diffs` (undocumented — assume empty
   `diff`); `with_labels_details` and `permissions` shapes as documented.
3. **Live checkpoint 2 — actions and git, after commit 6**: the OAuth flow itself against a
   registered gitlab.com application (PKCE + `client_secret`, refresh rotation, revoke);
   push/fetch through our own smart-HTTP framing with an OAuth token holding `api
   write_repository`; draft notes → `bulk_publish` with `reviewer_state`; `approve` with a stale
   `sha` (409); `position_type: file`; the exact pre-receive text on a protected-branch push
   (only ever passed through, never matched); a moved project's 301.
4. **Staging soak (internal plan)**: the deployment facts — the Access service token on the
   `.git/` paths of the service-token hostname, our User-Agent against the WAF, the instance
   version against the gates below, and the stub-era reconnect path.

**Documentation findings that changed the design** (each is now a locked decision or table cell
above): Git-over-HTTPS for OAuth tokens is documented for `read_repository`/`write_repository`
only, so connections request `api write_repository`; OIDC `email` claims need a *public* email,
so identity comes from `GET /user`; `bulk_publish` carries `reviewer_state: requested_changes`,
so `requestChanges` is in v1 and the review body rides `bulk_publish`'s `note`; renamed projects
answer `301` to a numeric-id URL, so `redirect: "manual"`; `changes_count` caps at `"1000+"`;
`/merge` has no documented 406; the project issues endpoint has no `in` param; the token response
has no `scope` field, so requested scopes are recorded; `x-total` is unreliable, so page-length
is the exhaustion signal; `diff_refs.base_sha` is confirmed to be the merge base and
`start_sha` the target head.

**Version gates to check against the target instance** (the internal instance — version to be
read from its `/help` page; gitlab.com is always current): `draft` list filter 19.0 (we use `wip`, works
everywhere); `collapsed`/`too_large` on `/diffs` 18.4 (both optional in our reader); "requested
changes blocks merge" 17.2 Premium/Ultimate (state is set regardless); `auto_merge` 17.11 (CI
follow-up); `order_by=merged_at` 17.2 (not used); Planner role 17.7 and its private-repo read
18.7 (probe denies it either way). Everything else we use predates the docs' history window and
needs no check.

**Dropped as irrelevant to v1**: Gitaly's acceptance of `tree:<depth≥1>`/`combine:` filter specs
(our transport sends only the universally valid `blob:none`/`blob:limit`/`tree:0`; GitLab
documents partial clone, which implies `uploadpack.allowFilter`, and the docs list
`uploadpack.allowAnySHA1InWant` among Gitaly-set values, so blob wants by sha work as partial
clone requires — tree-by-oid pull-through is therefore *feasible* on GitLab, and stays punted for
scope, not feasibility).

## Known edge cases / watch-fors

- **`diff_refs` inversion.** GitLab's `base_sha` is the merge base and `start_sha` the target
  head; our `baseSha` is the target head. One helper, one test, and a comment at every use site
  that says which is which. Getting this wrong makes `getMergeBase()` return the wrong commit
  and every worktree review diff against the wrong parent — silently.
- **Refresh-token rotation under concurrency.** Two callers racing a refresh must not each
  redeem the same refresh token: the second redemption fails (`invalid_grant`) and, worse, GitLab
  may revoke the family. The mutex plus in-lock re-read is what prevents it; the workerd test
  drives N concurrent `getAccessToken()` calls against a fake token endpoint that counts
  redemptions and asserts exactly one.
- **Expired-while-idle accounts.** A refresh token unused for long enough (instance-configured;
  gitlab.com's default is generous) dies with `invalid_grant`. That is the normal
  `credentialsExpired()` → reconnect path, but the first symptom is an agent read failing days
  after the last one succeeded; the error text should say "reconnect", not "401".
- **Stale stub state after the internal cutover.** `read_api` grants and `{scopePath}` props
  (locked decision). Both paths are tested: a stub-era grant still serves `describe()` and
  answers `ensureResources()` with the reconnect URL; stale props throw the reconnect message
  and nothing else.
- **`:project+` over-matching.** The project pattern matches issue and MR URLs; only the
  resource ordering keeps the modal pre-selecting the right one. The ordering test guards it, and
  `getGatekeeperClassFor` never trusts the pattern.
- **Project renames and transfers.** `projectPath` in props goes stale when a project moves,
  and the API answers the old path with a documented `301` whose `Location` is the numeric-id
  URL (see the redirects locked decision for why that must never be followed). The binding then
  fails with "project moved — re-bind", the same exposure GitHub has with `owner/repo`. Not
  solved here; noted so nobody reaches for the numeric id in a hurry — that would break the
  observer probe's path-based ACL check and every URL builder.
- **`line_code` for multi-line diff comments is computed, not fetched.** GitLab's documented
  form is `<SHA1 of the file path>_<old_line>_<new_line>`; each `line_range` endpoint also needs
  `type: "new" | "old"`. The DO derives it with `crypto.subtle.digest("SHA-1", path)` from the
  target's `startLine`/`line` and `side`; a node test pins the derivation against the docs'
  example (`588440f66559714280628a4f9799f0c4eb880a4a_10_10` for `package.json`).
- **The documented token response has no `scope`.** So granted scopes cannot be read back from
  the exchange; `UserAccount` records the scopes it *requested*, and the stale-stub guard keys on
  that record's absence. If a deployer's OAuth application is registered with fewer scopes than
  requested, GitLab rejects the authorize request outright rather than silently narrowing, so the
  record is trustworthy.
- **`GET /user` under `read_user` may omit the private `email`.** The scope is documented as
  exposing the "public email"; the `/user` example is scope-agnostic. Live checkpoint 1 decides;
  the fallback is `read_api` for the transient sign-in grant. Either way the check is `email` +
  non-null `confirmed_at`, never `public_email` (which the user chose to publish, not the provider
  verified).
- **Branch names with slashes** in `GET …/repository/branches/:name` must be encoded per
  segment-as-a-whole (`encodeURIComponent` of the full name, slashes included) — GitLab expects
  `feature%2Fx`, the opposite of GitHub's per-segment join. Test pins it.
- **Long threads read whole.** `readDiscussion()` fetches every discussion page (100 per page)
  before answering, since the endpoint cannot be walked incrementally (locked decision). A
  thousand-comment issue is ten pages per uncached read. Revisit with a bounded window if it
  shows up.
- **`with_labels_details` doubles payload size** on list endpoints. Acceptable at
  `per_page=100`; if list latency becomes a problem, fetch details lazily on `getDetails()` only.
- **Draft notes are per-user drafts on the MR.** `bulk_publish` is documented as publishing
  "all pending draft notes for a merge request that belong to the user" — including drafts the
  human left in the web UI. Apply therefore `GET`s `…/draft_notes` first; if any draft is not one
  it just created, it publishes its own individually (`PUT …/draft_notes/:id/publish`, documented)
  and posts the summary as a plain note with the `reviewer_state` still set via an empty
  `bulk_publish` only when no foreign drafts remain — otherwise the summary goes out as an
  ordinary `POST …/notes` and the reviewer state is left unset, with the JSDoc noting that a
  parked human draft downgrades the review to comments. Rare enough not to design around further.
- **Access service token on the git endpoints.** If the Access application in front of the
  instance covers only `/api/v4`, git fetch/push will 302 to a login page and the pkt-line
  parser will fail on HTML. `fetchGitUploadPack` checks `Content-Type` before streaming and
  reports "Access blocked the git endpoint" rather than a parse error.
- **`Draft:` prefix collisions.** GitLab documents three recognised prefixes — `Draft:`,
  `[Draft]`, `(Draft)` (legacy `WIP:` is no longer documented). Creating with `draft: true` when
  the title already carries one must not double-prefix; setting a title later that drops the
  prefix un-drafts the MR (documented: "Remove `[Draft]`, `Draft:` or `(Draft)` from the
  beginning of the title") — noted on `setTitle`.
- **Rate limits.** gitlab.com documents 2,000 authenticated API requests/min per user and 400/min
  on `GET /projects/:id`; self-managed limits are off by default and admin-set. The cache and the
  cursors' page sizes keep us far below. A 429 carries `Retry-After` (and `RateLimit-*` headers);
  it is surfaced as-is with the wait in the message. Note the documented 429 for rate-limited
  `search` queries on the MR list.
- **Asynchronous fields after create.** `diff_refs` and `changes_count` are documented as empty
  right after an MR is created and "populate asynchronously". A `readDiff()` or `getMergeBase()`
  immediately after `createMergeRequest` is applied may see them empty; the DO retries the single
  GET once after a short delay before falling back to `/merge_base` + `sha` (which are always
  available) to build the revision itself.

## Commit sequence

Two PRs. Within the public PR, commits are ordered so the kit refactor is reviewable apart from
the new package and the new package's API is reviewable before its implementation (AGENTS.md's
kernel bar doesn't apply — no `workshop-backend`/`workshop-shared` lines change — but the same
"small reviewable units" discipline does). Each commit keeps the packages it modifies green.

**PR A — public repo**

1. **plan** — this document.
2. **kit: move the git layer out of gatekeeper-github** — `git-transport`, `git-objects`,
   `git-diff` with their node tests, README inventory rows, `diff` dependency; github imports
   them, its `git-commits.ts` shrinks to the REST adapters plus a wrapper over the kit's
   `commitDetailsFromGitObject`. One commit rather than add-then-switch so git's rename detection
   holds and the reviewable diff is the comment edits and the split, not a 600-line addition
   followed by a 600-line deletion. `types.d.ts` is untouched: its `GitHubPullRequestDiff*` types
   are structurally identical to the kit's `GitDiff*`, and the agent-facing text must stay
   self-contained. Behavior-neutral; github's full suite is the proof.
3. **gitlab: package skeleton + API design** — `package.json`, `tsconfig.json`, `vite.config.ts`,
   both vitest configs, `wrangler.jsonc`, `deploy-inputs.json`, logo, `text-modules.d.ts`,
   `observability.ts`, **`types.d.ts` + `types.txt`** (the review artifact, §5), `README.md`,
   `storage-schema.md` skeleton, and `gitlab-api.ts` with its node tests (§2, incl. OAuth
   helpers, PKCE, Access headers, git POST framing). Nothing yet implements `Gatekeeper`.
   **Review checkpoint: `types.d.ts` is approved before commit 4 is written.** The doc-derived
   fixtures (Verification, layer 1) land here.
4. **gitlab: accounts, resources, configurators, read-only sessions** — HTTP entrypoint,
   `GatekeeperVendor`, `UserAccount` (PKCE, refresh under mutex, staging, scope guard),
   `GatekeeperUserImpl`, `GitLabVerifier`, `GitLabGatekeeperImpl` with caches and every
   *observation* method (metadata, issue/MR details, listings and search, discussion, diff,
   diff threads, branches, tags, commits, ref resolution, merge base — all advertising), the three
   configurators, `addObserver`/`removeObserver`. `applyAction`/`rejectAction`/`revertAction`
   throw "no actions yet". Workerd: `TestHooks` harness, `refresh.test.ts`,
   `resource-order.test.ts`, `session-git.test.ts` (reads), stale-props/scope guards.
5. **gitlab: actions and simulation** — the action union, `submitActionForApproval`,
   provisional ids and `#~N`/`!~N` rewriting, all `prepare*`, `applyAction`/`rejectAction`/
   `revertAction` for every non-push action, overlays, reject cascades, discussion/diff-thread
   incremental sync state, draft-note reviews and approval, thread replies and resolution,
   merge. Workerd: `review.test.ts`, action lifecycle matrix (queue → simulate → apply → revert;
   reject cascades), watermark sync.
6. **gitlab: git pull, push, and push simulation** — `gitPull`, `preparePush`/apply/revert,
   `#simulateBranchHead`, pending-chain collection, simulated MR comparison and head overlays,
   injected created branches, `isSimulatedCommitId` carve-outs. Workerd: `push.test.ts`,
   `mr-simulation.test.ts`, protected-branch rejection text.
7. **repo plumbing and docs** — `SHARED_GATEKEEPER_CREDS`, manifest fixture bundle + golden
   regen, AGENTS.md bullet, write-gatekeeper skill reference. (Small; may fold into 3.)

**PR B — internal repo** (companion plan there has the specifics)

1. **submodule bump** past PR A's merge, `pnpm-workspace.yaml`/lockfile as the bump requires,
   `pnpm --dir public install`, generated configs regenerated.
2. **cutover** — delete `packages/gatekeeper-gitlab`; `PACKAGE_OVERRIDES["gatekeeper-gitlab"]`
   with the two instance vars; replace the two `wrangler-secret` component jobs with a
   `deploy-gatekeeper-gitlab` job (zoominfo pattern) pushing all four secrets from Vault (the
   OAuth pair is new to Vault); `deploy-public` `needs:` updated; staging secrets by hand; OAuth
   app redirect URI + scopes updated on the instance; README/AGENTS/`gatekeeper-shared/README.md`
   stale-flow cleanup; the root `vite.config.ts` lint comment that cites the stub's parked
   scaffolding.

## Punted / future work (deliberately kept open)

- **Group-scoped bindings** ("all projects under `group/`"): strategy-C observers over
  per-project sets (the kit's `ObserverTracker` is the tool), `listProjects`/`searchProjects` on
  a `GitLabGroup` session, a fourth `urlPattern`. The internal stub's one feature not carried.
- **`unapprove()`** (`POST …/unapprove`, documented) and reviewer assignment (`reviewer_ids` on
  create/update) — both trivial, both omitted for GitHub parity.
- **CI/CD — deliberately excluded from v1, to be added to both gatekeepers by a separate plan.**
  GitHub's gatekeeper has no Actions/checks support, and this port keeps parity rather than
  letting GitLab run ahead. What that costs, so the follow-up is scoped honestly: after
  `push()` → `createMergeRequest()` the agent cannot learn whether the pipeline passed
  (`head_pipeline` is on the MR object we already fetch — the field is dropped, not unavailable),
  cannot read a job log to diagnose a failure, cannot retry/cancel/play jobs, cannot merge with
  "when pipeline succeeds", and `getCommit()` cannot report a commit's status. The follow-up
  plan covers pipeline/job reads (with a tail-capped log read), the cheap non-revertible actions
  (`retry`/`cancel`/`play`), `autoMerge` on `merge()`, and the GitHub equivalents (check runs,
  workflow runs, job logs, re-run). Documented starting points: `head_pipeline` on the single-MR
  GET (with `status`, `web_url`, `detailed_status`), `last_pipeline` on the single-commit GET,
  `auto_merge` on `/merge` (17.11), and `GET /jobs/:id/trace`, whose size and `Range` behaviour
  the docs don't cover.
- **Honouring both pull hints at once** if Gitaly accepts `combine:` / `tree:<depth≥1>` — the
  docs list only `blob:none`, `blob:limit` and `sparse:oid` for partial clone; a live probe would
  settle it. A GitLab-specific `filterSpecForHints` variant in the kit, selected by the
  gatekeeper.
- **Tree-by-oid pull-through** for the simulated MR diff, if Gitaly permits non-tip tree
  `want`s: the DO's `#treeDiffSource.getTree` would issue a filtered upload-pack for the one
  tree instead of returning `null`.
- **Numeric project id alongside the path** in props, refreshed on first read, to survive
  renames/transfers — needs an answer for the observer probe and URL builders first.
- **Lazy label details** if `with_labels_details` list payloads prove heavy.
- **`autoMerge`** (`merge_when_pipeline_succeeds` / `auto_merge`) on `merge()`; `rebase()` on
  the MR session (`PUT …/rebase`, async — needs polling).
- **Reactions / emoji awards, milestones, iterations, epics, time tracking, work items** — GitLab
  has a lot of surface neither gatekeeper touches.
- **Inbound Access-JWT verification** as an opt-in for deployments that want defence in depth
  at the worker (would want a kit module shared with the internal repo's `access-jwt.ts`).
- **A shared `GitHubApi`/`GitLabApi` HTTP-client base in the kit** — the `request()`/
  `conditionalGet()`/error-class trio is now duplicated twice; a third copy is when it earns a
  module.
- **`gatekeeper-kit/credentials` for both git gatekeepers.** Review asked why `UserAccount`
  hand-rolls its refresh mutex, cooldown, superseded-write check, and disconnect-during-exchange
  guard when `CredentialCoordinator`/`CredentialSource` exist for exactly that. Considered and
  deferred, for reasons that should be settled before either gatekeeper adopts it: (1) the kit
  heals a `401` by refreshing before it will call a grant dead, so GitLab's permission-`401`s
  (merge, approve) would each burn a single-use refresh rotation and surface as "credentials
  changed" — the per-endpoint classification above is needed with or without the kit, and once
  it is there the kit's heal is not what fixes that case; (2) `discardMint` revokes a fenced-out
  refresh token, and RFC 7009 lets a provider treat that as revoking the whole grant — whether
  GitLab does is a live-checkpoint question the kit's own docs say to answer first; (3) the
  coordinator owns a canonical `credentials` record, so adoption is a storage migration on top of
  the stub-era one; (4) no production gatekeeper has adopted it yet. The `grantId` fence above
  is the kit's identity fence in miniature; adopting the kit would replace it, not add to it.
- **Replies to provisional diff comments, in both gatekeepers.** Each session's
  `replyToDiffComment()` refuses a `~` id up front, so the machinery behind it — the
  `diffAlias:` keys written at apply, the hop-bounded chain walk in the reply resolver, and the
  reject cascade over reply chains — is unreachable in GitHub and GitLab alike. GitLab does not
  write the aliases for review comments (GitHub's come free with the review POST's response;
  here they would cost a discussions round-trip and a signature match), but otherwise mirrors
  the dead paths for parity. Either lift the gate in both, making a reply to a not-yet-published
  review comment queue behind its parent, or delete the paths in both.
- **Approval descriptions that show what will be posted, in both gatekeepers.**
  `ActionDescription.description` "must include all details that might be relevant to consider
  before approving", yet `postComment`, `setBody`, and `postReview` describe the action without
  the Markdown it will post — the approver approves a comment without seeing it. GitHub's
  descriptions are identical, and the approval UI should not differ between connectors, so this
  is one change to both: include the body (or a bounded excerpt of it) in the description.
- **Bounded output from the kit's wholesale diff.** `git-diff.ts`'s `wholesaleDiff` runs when a
  file's change exceeds jsdiff's caps and emits *every* changed line as removed-plus-added: a
  fully rewritten 1 MiB file of 30k lines becomes 60k line objects to the agent, which is what
  `diffOmitted` exists for. One condition — past the per-file line cap, omit rather than emit —
  in shared kit code both gatekeepers run, so it lands as its own change rather than inside the
  behaviour-neutral move.
- **The same fixes in gatekeeper-github.** Reviewing this port surfaced gaps the mirror inherited
  and, in some cases, GitHub has worse: `applyAction` is retry-idempotent only for `push` (an
  already-applied action of any type should report success, not "no longer pending");
  `getGitBlob` buffers the whole base64 body before its size check (GitHub serves raw blobs under
  the `application/vnd.github.raw` media type, which can be read with a byte cap); the issue
  listing filters pull requests and touched issues *inside* `fetchPage`, so a full page reads
  short and `StreamingCursor` stops before the next — every page with a pull request on it
  truncates the listing; `/pull/:number` does not match `/pull/7/files`, so a URL to a PR tab
  preselects the whole repository; `merge()` binds no head (see the locked decision above); and
  `#storeCached` stamps the cache generation at *store* time, so a read whose fetch was in flight
  while an `applyAction` ran to completion is stored as if it reflected the mutation and hides it
  for the cache's lifetime (capture the generation before the loader; skip the store if it moved);
  and `#collectPendingChain` marks only the first-parent chain as simulated, so a local merge's
  side parent is advertised as remote-known, omitted from the push pack, and the push rejected.
- **`confidential` on `GitLabIssueSummary`.** Reporter-and-above observers may see confidential
  issues, and an agent that knows an issue is confidential can avoid quoting it into a public
  merge request description. A one-field addition to the approved API, deferred to its own review.
