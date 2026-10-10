# Plan: X (Twitter) gatekeeper — read, publish and engage on X, with every public act approved

**Status: design proposal — not implemented.** The open questions were answered on 2026-10-10
([Decisions from review](#decisions-from-review-2026-10-10)). What remains before code is review
of §5's `types.d.ts` sketch: per the gatekeeper workflow nothing past the package skeleton is
built until it is approved. X API facts are from docs.x.com (OpenAPI `2.170`) as retrieved
2026-10-10; the ones the design leans on without anyone having seen them live are collected under
[Verification](#verification).

## Goal

Ship `packages/gatekeeper-x`: a gatekeeper that connects a user's X account over OAuth 2.0 and
lets agents and gadgets

- **read** — the home timeline, mentions, the account's own posts, bookmarks and likes, recent
  search, a post with its replies and quotes, user profiles, and Lists;
- **publish** — posts and threads (text, up to four images, polls), replies, and deletions;
- **engage** — like, repost, bookmark, follow, mute, hide replies, and manage owned Lists;

at four granularities — the whole account, one post's conversation, one List, and one other
user's public profile (read-only) — with every side effect queued for approval and simulated until
it is decided.

Two properties set X apart from most gatekeepers so far, and most decisions below follow from
them:

1. **Every request costs the deployment operator money.** The X API is pay-per-usage only:
   credits are bought up front and debited per resource read ($0.005 a post, $0.010 a user) and
   per write ($0.015 a post, **$0.200 a post containing a link**), deduplicated per resource per
   UTC day. One developer app — the operator's — pays for every user of the deployment. Caching,
   page sizes, what the account DO remembers and what an observer check may call are therefore
   cost decisions here, not just latency ones.
2. **X's developer policy constrains automation directly.** Likes must be "directly initiated by
   the authenticated user" and automated following is prohibited; automated replies are allowed
   only after the user engaged first, and AI-generated replies need X's *prior approval*;
   unsolicited mentions and DMs are prohibited. The approval queue is therefore not only our
   security boundary but the mechanism that makes each engagement user-initiated — which rules out
   auto-approval for almost every action kind (§6).

Delivered as **two PRs**: PR A is the gatekeeper (accounts, resources, reads, actions, observers);
PR B adds push hooks through X's Activity API. See [Commit sequence](#commit-sequence). Neither
touches `workshop-backend` or `workshop-shared`: gatekeepers are discovered from their bindings.

## Locked decisions

- **X's vocabulary, X as the vendor.** Package `gatekeeper-x`, vendor id `x`, display name "X",
  routes under `/gatekeeper/x/`, bindings `X_ACCOUNT` / `X_POST` / `X_LIST`. The agent API says
  Post, Repost, Like, Bookmark and List — docs.x.com's terms — with "formerly Tweet" said once in
  the JSDoc for the model's benefit. The wire still says `tweets` (`/2/tweets`,
  `in_reply_to_tweet_id`); that stays inside `x-api.ts`.

- **Plain `fetch`, no SDK.** About 30 endpoints, all JSON over HTTPS with a bearer token. The
  popular `twitter-api-v2` package fails on Workers — it re-gunzips bodies `fetch` already decoded
  (internal page "twitter-api-v2 package x Workers (zlib issue)") — and X's own XDK is a general
  client we would wrap anyway. One `x-api.ts` owns requests, the fixed field and expansion sets,
  pagination, error mapping and rate-limit headers, as `gitlab-api.ts` does.

- **OAuth 2.0 Authorization Code with PKCE, user context only.** The X app is a confidential
  client ("Web App, Automated App or Bot"): `S256` challenges, HTTP Basic client authentication
  at `https://api.x.com/2/oauth2/token`, the browser sent to `https://x.com/i/oauth2/authorize`,
  RFC 7009 revocation at `/2/oauth2/revoke`. `offline.access` is always requested — without it X
  issues no refresh token and access ends after two hours. No OAuth 1.0a and, in PR A, no
  app-only bearer token: every call is made as the user, so X's per-user rate limits and
  visibility rules (protected accounts) apply on their own. The authorization code lives **30
  seconds**, so the callback claims its nonce and exchanges at once; nothing slow may sit between.

- **Kit-first.** A greenfield port onto a plain REST API with no git surface is the right first
  *full* consumer of `gatekeeper-kit`: `connect-handshake`, `OAuthClient` + `createPkce` +
  `oauthRefresh`/`mergeOAuthTokens`, `CredentialCoordinator` + `CredentialSource`,
  `credential-stage`, `credential-expiry`, `defineActions` / `ActionJournal` / `ProvisionalIds` /
  `replaySimulation`, `ActionFileStore`, `KvTtlCache`, `ObservationGate` +
  `trackedCollectionObservers`, and `buildDescription` (`TokenCursor` was dropped as built; see
  [As built](#as-built-2026-10-10)). Several
  of these have no production consumer yet — GitLab hand-writes its equivalents — so where one
  doesn't fit, the implementation steps down one rung as USAGE.md prescribes and records why in
  `storage-schema.md`, rather than forking silently. Rationale: AGENTS.md's "reuse existing
  mechanisms over parallel ones", and the kit's conformance gatekeeper already exercises these
  paths.

- **Refresh tokens are treated as single-use and rotating.** The docs are silent; community
  reports say X rotates them, and designing for rotation is safe either way:
  `CredentialCoordinator` coalesces an account's concurrent refreshes into one redemption and
  commits the rotated pair before returning. `discardMint` stays unset until live testing shows
  revoking one refresh token doesn't revoke the whole grant ([Verification](#verification)).

- **A connection is pinned to its X user ID.** The callback reads `/2/users/me` before anything is
  stored; a reconnect or `ensureResources` flow that comes back as a different X user is refused —
  its new grant revoked, the error page naming both handles. A silently switched account would
  publish the user's approved posts from the wrong identity, the worst failure this gatekeeper can
  have. Actions are fenced on this pinned ID rather than the connection generation (USAGE.md's
  stable-account fence), so a scope-widening reconnect doesn't strand pending posts.

- **Cost is a design constraint.** Concretely:
  - the account DO caches the connected identity, so `describe()`, the verifier's identity answer
    and approval titles cost nothing, and re-reads it at most daily;
  - listings default to **20** results per page, not X's 100;
  - repeated reads are cached for minutes — never longer than X's 24-hour deletion rule allows;
  - one fixed field set, with only the author and referenced-post expansions (a post without its
    author's handle is useless to an agent);
  - the gatekeeper never polls on its own;
  - the README gives operators the price list and points them at X's console spending limit.

  On top of that, every connection has a daily read limit the deployment configures (§8).

- **Four granularities.** **X Account** (the `https://*` catch-all); **X Post** — one post *and
  its conversation*, the natural unit of "watch the replies to my announcement and draft answers";
  **X List** — a curated feed, the natural unit of "summarize my AI-researchers List every
  morning"; **X Profile** — one user's public profile and posts, **read-only**, the narrowest grant
  for "give me a daily digest of @someone": it reveals nothing about the connected account and can
  do nothing. DMs are excluded outright: unsolicited DMs break policy, X is moving DMs to
  end-to-end-encrypted XChat, legacy DM reads allow 15 requests per 15 minutes, and the data would
  need strategy A plus `containsRestrictedData`.

- **Both hosts, one canonical form.** Users and models still paste `twitter.com` links. Every
  pattern accepts `x.com` and `twitter.com` (with or without `www.`/`mobile.`), and
  `ResourceDescription.url` is always canonical `https://x.com/…`. This is a correctness issue,
  not polish: `resolveRequestedResource` falls back to the catch-all, so a `twitter.com` post URL
  that missed the Post pattern would open the *whole-account* configurator. A test asserts it
  never does (§4).

- **The Account's canonical URL names no one: `https://x.com/settings/account`.** A profile URL
  means the read-only Profile binding — *including the connected user's own*, the narrower
  reading — so the Account needs a URL no narrower pattern matches. It must not name a user
  either: blueprint instantiation re-resolves a stored `resourceUrl` under whichever account the
  instantiating user picks (`workshop-backend/src/server.ts:525` → `getGatekeeperClassFor`), and
  `https://x.com/<alice>` re-resolved under Bob's account would turn an Account binding into a
  Profile binding of Alice, breaking gadget code written against `XAccountSession`.
  `/settings/account` is X's own "your account" page, so it means whoever resolves it.

- **Listings return data; capabilities are minted from IDs.** Cursors yield plain `XPostInfo` /
  `XUserInfo` / `XListInfo`; capabilities come from synchronous getters (`getPost(id)`,
  `getUser(username)`, `getList(id)`) that fetch nothing until used and pipeline. That spares a
  stub per row on pages agents walk by the hundred (Spotify's shape, not Slack's
  entry-plus-capability). The Post binding keeps its authority to one conversation:
  `getConversationPost(id)` refuses, on first use, any post outside it.

- **Scopes follow resources** (Slack's table, §3). `resourceUrlPatterns: []` means base scopes
  only, omitted means everything, `ensureResources` widens to the union of granted and needed, and
  granted scopes are read back from the token response's `scope` and reported as
  `grantedResourceUrlPatterns`.

- **Images only, captured at submit, uploaded at apply.** An agent-supplied image goes into an
  `ActionFileStore` when the post is submitted and reaches `POST /2/media/upload` only once the
  post is approved: uploading earlier would be an unapproved side effect, and X's media IDs expire
  (`expires_after_secs`). The approval shows each image's name, type, size, SHA-256 and verbatim
  alt text, but the approver cannot see the pixels, so such a description is never complete. GIF
  and video need chunked upload and asynchronous processing and are deferred.

- **A thread is one action.** `createThread(drafts)` is approved as a whole, every post's text
  verbatim in one description — approving five related actions in the right order is a trap.
  Apply posts in order and records progress, so a retry after a mid-thread failure resumes rather
  than reposting. Chained replies to a provisional post (`~N`) still work, as dependent actions.

- **Nothing public-facing is auto-approvable.** Per X's policy, likes, follows, reposts, replies
  and posts are never `autoApprovable`. The only kinds a user may opt into auto-approving are
  **bookmarks** (private, reversible, explicitly fine to automate), **mutes** (private,
  reversible) and **hiding replies** (reversible moderation X itself demonstrates automating).

- **Replies ship, with the policy warning on the operator.** X requires its *prior approval* for
  apps that post AI-generated replies. The README and the deploy wizard's setup steps say so; every
  reply is still approved by the user, one at a time, and nothing else gates the method.

- **Unknown outcomes are reconciled, never blindly retried.** `POST /2/tweets` has no idempotency
  key. Creates are `claimBeforeApply` and each send leaves an attempt marker; before retrying an
  attempt whose outcome is unknown, apply looks for an exact match among the account's posts since
  the attempt and binds it if found. X's duplicate-content refusal is a backstop, not the
  mechanism.

- **Simulation overlays reads; caches are never mutated.** Pending actions live only in the
  journal and every read replays them over what it fetched (Spotify and GitLab's approach);
  submit, apply and reject invalidate caches but never edit them.

- **One observer rule for all four bindings: public, or the owner's.** Public posts and profiles
  are readable by any collaborator with their own X account, which observers must connect anyway.
  Bookmarks, likes, mute state, private Lists and anything written by a protected account are
  **owner-private**: only an observer connected as the *same* X user may see them — which is
  exactly a team sharing a brand account. Strategy C over one synthetic collection, with a
  per-binding baseline check (§7).

- **Rate limits and exhausted credits are their own errors.** Neither is a credential failure and
  neither ever reaches `credentialsExpired`; both messages are display-safe and say when to retry,
  or that the operator must add credits.

- **Out of v1:** quote posts (`quote_tweet_id` is Enterprise-only), edits (a 30-minute,
  Premium-only window fights approval latency), GIF and video, DMs, blocks (Enterprise-only), and
  Sign in with X. Reasons under [Punted](#punted--future-work-deliberately-kept-open).

- **Hooks come from the X Activity API, in PR B.** The Account Activity API is deprecated and
  allows three subscriptions on pay-per-use; the X Activity API (XAA) delivers mentions, replies,
  a watched user's new posts and `oauth.revoke` by signed webhook, with a 1,500-subscription cap on
  the self-serve tier (§9). As with GitHub's hooks, they are configured outside the wizard
  (`WEBHOOK_ORIGIN` and an app-level `X_APP_BEARER_TOKEN`); until both are set, subscribing is
  refused and everything else works.

- **X content retained in workspaces is accepted.** X's terms want content deleted within 24 hours
  of its deletion on X. The gatekeeper's own caches stay well inside that; observation logs and
  agent transcripts keep what was read, inside a workspace that is not publicly viewable.

## Current-state anchors (for orientation)

- **Contract:** `packages/workshop-shared/src/gatekeeper.ts` — `ActionDescription` (:1361;
  `descriptionIsComplete`, `autoApprovable`, `actionKind`), `ObservationDescription` (:1222),
  `resolveRequestedResource` (:329), whose catch-all fallback is why patterns must cover both
  hosts.
- **Kit:** `packages/gatekeeper-kit/USAGE.md` recipes — OAuth + PKCE + coordinator, reconnect
  staging, local-first revoke, action staging + simulation, tracked observers — with the
  executable reference in `__tests__/workerd/conformance/gatekeeper.ts`.
- **`gatekeeper-gitlab`**: the reference for the kit handshake + PKCE, the rotating-refresh
  coordinator, `PreviewOAuth`, and the workerd test layout (`__tests__/workerd/account.test.ts:103`,
  "collapses concurrent callers into exactly one redemption").
- **`gatekeeper-slack`**: the resource → scope table, `[]`-versus-omitted, union
  `ensureResources`, `grantedResourceUrlPatterns` (`slack.ts:137-188`, `:653-675`).
- **`gatekeeper-spotify`**: read-time overlays for library and follow state and provisional `~N`
  playlists (`spotify.ts:1493-1638`). Not its refresh path, which has no single-flight.
- **Google Chat** (`gatekeeper-google/src/chat.ts`): posting with approvals — pending-message
  identity, attempt markers, refusing rejection once a send was attempted, revert as delete,
  per-kind `autoApprovable`.
- **`gatekeeper-confluence`**: agent-supplied bytes captured in an `ActionFileStore` and uploaded
  at apply (`confluence.ts:1176-1186`, `confluence-actions.ts:172-190`).
- **Hooks**: `gatekeeper-github/src/github-hooks.ts` and `gatekeeper-gitlab/src/gitlab-hooks.ts` —
  webhook → verify raw bytes → dedupe → `HookDeliveryQueue` → `startHook` → facet re-check.
- **Registration** needs no backend change (config-gated discovery). Touch points: dev
  credentials in `SHARED_GATEKEEPER_CREDS` (`scripts/run-dev-server.ts:473`), the release fixture
  bundle and golden (`scripts/release/manifest-lib.test.ts`), wizard inputs in
  `deploy-inputs.json`.
- **Observers**: `docs/observers.md` §9.2 is the strategy table to extend.

## Design

### 1. Package layout

```
packages/gatekeeper-x/
├── src/
│   ├── x.ts                fetch handler (connect link, /oauth, PR B: /webhook), GatekeeperVendor,
│   │                       UserAccount, GatekeeperUserImpl, XVerifier
│   ├── x-env.ts            Env, constants, SupportedResources, resource → scope table
│   ├── x-urls.ts           URL parsing and canonical links
│   ├── x-text.ts           weighted text length, links and mentions, duplicate comparison
│   ├── x-api.ts            XApi: request(), field/expansion sets, pages, errors
│   ├── x-normalize.ts      wire JSON → XPostInfo/XUserInfo/XListInfo (both tweet/post spellings)
│   ├── x-credentials.ts    what the account shares: public grant, identity, read limit, credentials
│   ├── x-gatekeeper.ts     XGatekeeperImpl DO (one class, four kinds): journal, provisional IDs,
│   │                       caches, observer gate, apply/reject/revert
│   ├── x-sessions.ts       XAccountSessionImpl, XPostImpl, XProfileImpl, XUserImpl, XListImpl
│   ├── x-cursor.ts         XCursor: one X request per page (as built, §As built)
│   ├── x-actions.ts        defineActions table: payloads, describe, apply, revert data
│   ├── x-simulation.ts     one overlay per listing (§6)
│   ├── x-configurators.ts  + configurator/x-{account,post,list,profile}-configurator-{ui.tsx,types.d.ts}
│   ├── types.d.ts          + types.txt symlink
│   └── observability.ts, text-modules.d.ts, x-logo.svg
├── storage-schema.md, README.md, deploy-inputs.json
├── cloudflare.config.ts    (wrangler.jsonc generated)
└── package.json, tsconfig.json, vite.config.ts (withTests), vitest{,.worker}.config.ts, __tests__/
```

Migrations `v0: [UserAccount, XGatekeeperImpl]`; PR B adds its hook DOs. Facet props:
`{ userObjectId, resourceKind: "account" | "post" | "list" | "profile", postId?, listId?,
username? }`; a Profile facet pins the user ID it resolves on first use. Compatibility flags
`allow_irrevocable_stub_storage` (tracked observers persist verifier stubs) and `nodejs_als`
(observability context). Session impls are all `@validateRpc()`, hold no tokens, and reach the DO
only through a narrow host.

### 2. The HTTP layer (`x-api.ts`)

One `request(method, path, {query, body, token})`: bearer token, 30 s timeout, bodies through
`readTextCapped`, redirects never followed. Errors: **401** is an auth error (the only thing
`CredentialSource.isAuthError` accepts); **429** becomes `XRateLimitError` carrying
`x-rate-limit-reset` — unless the problem `type` is `…/usage-capped`, which becomes
`XCreditsError`; other 4xx become `XApiError` with X's `title`/`detail`. A 200 can carry partial
`errors[]` (rows X couldn't hydrate); those rows are dropped and logged by type, never by content.

Endpoints (per-user limits per 15 minutes unless noted; prices from X's pay-per-usage table. Reads
and post creation are priced explicitly there; the other write rows map onto its classes — "User
Interaction: Create", "Interaction: Delete", "Content: Manage" — by name only, and the Developer
Console is authoritative):

| Purpose | Endpoint | Scopes beyond `tweet.read users.read` | Limit | Billed |
|---|---|---|---|---|
| Identity | `GET /2/users/me` | — | 75 | $0.010 |
| Home timeline | `GET /2/users/:id/timelines/reverse_chronological` | — | 180 | $0.005/post |
| Mentions | `GET /2/users/:id/mentions` | — | 300 | $0.005/post |
| A user's posts | `GET /2/users/:id/tweets` | — | 900 | $0.005/post |
| Search; replies (`in_reply_to_tweet_id:`); conversation (`conversation_id:`) | `GET /2/tweets/search/recent` | — | 300 | $0.005/post |
| Post lookup | `GET /2/tweets/:id`, `GET /2/tweets?ids=` | — | 900 / 5,000 | $0.005/post |
| Quotes | `GET /2/tweets/:id/quote_tweets` | — | 75 | $0.005/post |
| Bookmarks | `GET /2/users/:id/bookmarks` | `bookmark.read` | 180 | $0.005/post |
| Liked posts | `GET /2/users/:id/liked_tweets` | `like.read` | 75 | $0.005/post |
| Following / followers | `GET /2/users/:id/following`, `…/followers` | `follows.read` | 300 | $0.010/user |
| User lookup (+ `connection_status`) | `GET /2/users/by/username/:u`, `GET /2/users/:id` | — | 900 | $0.010/user |
| List, its posts, members | `GET /2/lists/:id`, `…/tweets`, `…/members` | `list.read` | 75 / 900 / 900 | $0.005, /post, /user |
| Owned Lists | `GET /2/users/:id/owned_lists` | `list.read` | **15** | $0.005/list |
| Post, reply | `POST /2/tweets` | `tweet.write` | 100 (10,000/day per app) | $0.015; **$0.200 with a URL** |
| Delete post | `DELETE /2/tweets/:id` | `tweet.write` | 50 | delete class |
| Like / unlike | `POST /2/users/:id/likes`, `DELETE …/likes/:tid` | `like.write` | 50 (1,000/day) | $0.015 / $0.010 |
| Repost / undo | `POST /2/users/:id/retweets`, `DELETE …/retweets/:tid` | `tweet.write` | 50 | $0.015 / $0.010 |
| Bookmark / remove | `POST /2/users/:id/bookmarks`, `DELETE …/bookmarks/:tid` | `bookmark.write` | 50 | $0.005 |
| Follow / unfollow | `POST /2/users/:id/following`, `DELETE /2/users/:src/following/:dst` | `follows.write` | 50 | $0.015 / $0.010 |
| Mute / unmute | `POST /2/users/:id/muting`, `DELETE /2/users/:src/muting/:dst` | `mute.write` | 50 | $0.015 / $0.005 |
| Hide / unhide reply | `PUT /2/tweets/:id/hidden` | `tweet.moderate.write` | 50 | $0.005 |
| Manage Lists, members | `POST /2/lists`, `PUT`/`DELETE /2/lists/:id`, `POST`/`DELETE /2/lists/:id/members[/:uid]` | `list.write` | 300 | $0.010 / $0.005 |
| Image, alt text | `POST /2/media/upload` (`tweet_image`), `POST /2/media/metadata` | `media.write` | 500 | — / $0.005 |

Every post read requests one fixed field and expansion set — in the docs' spelling, fields
`created_at, author_id, conversation_id, in_reply_to_user_id, referenced_tweets, attachments,
entities, public_metrics, lang, possibly_sensitive, reply_settings, note_tweet` and expansions
`author_id, referenced_tweets.id, referenced_tweets.id.author_id, attachments.media_keys,
attachments.poll_ids` — held as one constant. Its final spelling is settled at live checkpoint 0:
OpenAPI `2.170`'s `post.fields` enum lists `note_post` and omits `author_id` and
`referenced_tweets` altogether (§8 on the renames).

### 3. Accounts and OAuth

- **Connect.** `connectAccount(callback, options)` creates a `UserAccount`, `generateNonce()`, and
  `setCallback(callback, nonce, scopesFor(options?.resourceUrlPatterns))` — storing the callback,
  arming the one-hour self-destruct alarm, `putInitiation`. It returns
  `${BASE_URL}/${doId}/${nonce}`. `options.scopes === "auth"` is ignored: X is not a sign-in
  provider in v1.
- **Link hit.** `createPkce()`; `advanceToOAuth(kv, nonce, now, {codeVerifier, redirectUri,
  startedUnder: creds.connectionGeneration(), reconnect, scopes})`; redirect to
  `client.authorizationUrl({redirectUri, state, scopes, codeChallenge})`, with `PreviewOAuth`
  wrapping the state for preview deployments as GitLab does.
- **Callback** (`/oauth`): `handleCallback` (relaying if needed) → `claimOAuth`, consuming the
  nonce even on `?error=` → `exchangeCode` → `GET /2/users/me` (`id, username, name,
  profile_image_url, protected, verified, subscription_type`). First connect:
  `creds.connect(grant, {ifGeneration})`, store the identity, `callback.complete(user)` with **no**
  `expiresAt` — the account refreshes on its own, and passing the access-token expiry would mark
  it invalid after two hours (Slack's current bug). Reconnect / `ensureResources`: refuse if
  `me.id` differs from the stored ID; otherwise `stageCredentials` → `reconnectComplete(stageId)`,
  and later `commitReconnect(stageId)` → `commitStagedCredentials` → `creds.connect`.
- **Grant** `{accessToken, refreshToken, expiresAt, scopes}`, refreshed through
  `creds.snapshot(oauthRefresh(client, {merge: mergeOAuthTokens, isGrantDeath, expiredMessage}),
  {notify})`. `isGrantDeath` is `isInvalidGrant`, widened only by error evidence seen live. Grant
  death calls `notifyCredentialsExpiredOnce`.
- **Facets** use `CredentialSource({account, isAuthError: 401 only, expiredMessage})`. Reads
  `run(op, {replayable: true})`; a write is replayable only if it is idempotent at X (like,
  bookmark, follow, mute and hide are; create and delete are not).
- **`describe()`** returns `{displayName: name, uniqueName: "@" + username, avatar: {url:
  profileImageUrl}, grantedResourceUrlPatterns}` from the stored identity; one `/2/users/me`
  refreshes it when older than 24 hours, falling back to the stored copy on failure.
- **`revoke()`** is local-first: capture the stored and staged grants, `creds.clear()`,
  `deleteAlarm()`, `deleteAll()`; then, best effort and bounded (`AbortSignal.timeout` in
  `waitUntil`), `client.revoke` the refresh token, then the access token.
- **`getAuthenticatedEmail()`** returns `null`; **`getVerifier()`** returns
  `ctx.exports.XVerifier({props: {userObjectId}})`.
- **Scopes.** Always `tweet.read users.read offline.access`, plus:

  | Resource | Adds |
  |---|---|
  | X Account | `tweet.write like.read like.write bookmark.read bookmark.write follows.read follows.write mute.write list.read list.write media.write tweet.moderate.write` |
  | X Post | `tweet.write like.write bookmark.write media.write tweet.moderate.write` |
  | X List | `list.read list.write` |
  | X Profile | nothing — the base scopes suffice |

  A resource counts as granted only when all its scopes were (Slack's
  `grantedResourcesFromScopes`). Mute *state* comes from the `connection_status` user field, so
  `mute.read` is left out — unless X withholds `muting` there without it (Verification), in which
  case the Account row gains it.

### 4. Resources, URL patterns, configurators

`HOST` below abbreviates `{(www|mobile).}?(x|twitter).com`; `TABS` abbreviates X's profile tabs,
`with_replies|media|highlights|articles|followers|following|verified_followers`.

| Resource | `urlPattern` (intent) | Canonical `ResourceDescription.url` |
|---|---|---|
| X Post | `https://HOST/*/status/:postId{/*}?` | `https://x.com/<author>/status/<id>` |
| X List | `https://HOST/i/lists/:listId{/*}?` | `https://x.com/i/lists/<id>` |
| X Profile | `https://HOST/:username([A-Za-z0-9_]{1,15}){/(TABS)}?` | `https://x.com/<username>` |
| X Account | `https://*` | `https://x.com/settings/account` |

- **The patterns are intents; `configurator-url.test.ts` is the contract.** Hosts are limited to
  `x.com` and `twitter.com` with an optional `www.`/`mobile.`, so `docs.x.com` or
  `developer.x.com` match nothing. The Post pattern's leading `*` is deliberate: a bare
  `/:username/status/:id` would miss X's `/i/web/status/:id` links, which would then fall through
  to the catch-all. The Profile pattern takes only a valid handle plus a known tab, so the
  Account's `/settings/account` matches nothing narrower. Under both workerd's and the frontend's
  URLPattern, the test must show every form of a post (`/i/web/status`, `/i/status`, `/photo/1`,
  share query strings), List and profile URL resolving through `resolveRequestedResource` to its
  own resource, and `/settings/account` to the catch-all. If the hostname alternation isn't
  portable, the fallback stays safe: the Account resource stops being a catch-all and takes
  `https://x.com/settings/account` as its pattern, so an unmatched URL fails closed with the
  pattern list instead of widening — at the cost that agents must then name that URL to request
  the whole account.
- **`getGatekeeperClassFor(url)`** is authoritative. It canonicalizes the host, then:
  `/settings/account` → the account; `/:user/status/:id`, `/i/web/status/:id` and
  `/i/status/:id` → a post (the ID 1–19 digits); `/i/lists/:id` → a List; `/:handle`, optionally
  followed by a tab → a Profile — the connected user's own handle included, as the narrower
  reading. A first segment X reserves (`home`, `explore`, `search`, `notifications`, `messages`,
  `settings`, `compose`, `i`, …) is never a handle. Anything else throws. Nothing widens silently,
  unlike Spotify's "any other URL is the account".
- **Descriptions.** Account: title `@username`, snippet the display name. Post: title
  `Post by @author`, snippet its first 100 characters. Profile: title `@username`, snippet the
  display name and follower count. List: its name, `List by @owner · N members`. Whatever a
  description needs is fetched once and kept in the facet, since `describe()` must not cost on
  every open.
- **Configurators.** *Account*: a static confirmation, like Spotify's, whose `resourceUrl()` is
  the constant `https://x.com/settings/account`. *Post*: a `TextInput` for the post URL, parsed and
  canonicalized in the frame with no RPC (a preview would cost a read);
  `initialValuesFromResourceUrl` and `resourceUrl` are inverses. *Profile*: a `TextInput` taking
  `@handle`, `handle` or a profile URL, checked against the handle grammar and the reserved list,
  also with no RPC; prefill is automatic because the value key is `username`. *List*: an
  `Autocomplete` over `ui.listLists(query)` — owned Lists for an empty query, a pasted URL or ID
  resolved directly, prefill automatic because the value key is `listId`. The owned-Lists endpoint
  allows **15 calls per 15 minutes**, so the helper caches for five minutes.

### 5. Session API (`types.d.ts`) — the review artifact

What follows is the proposed agent-facing file, JSDoc trimmed for review. Like every gatekeeper's
it is self-contained (`Cursor` copied in) and never mentions approvals: correct simulation keeps
them invisible.

```ts
/** Forward-only paginated results. Call `next()` until it returns `null`; a page can be empty
 *  before the end. Dispose the cursor when finished, including when stopping early. */
export interface Cursor<T> { next(): Promise<T[] | null>; }

/** Results per page, 1–100. Defaults to 20. */
export type XPageOptions = { pageSize?: number };
/** Exclusive bounds for time-ordered listings. Pass the newest ID already seen as `sinceId` to
 *  fetch only newer posts. */
export type XTimeRangeOptions = XPageOptions & {
  sinceId?: string; untilId?: string; startTime?: Date; endTime?: Date;
};
export type XTimelineOptions = XTimeRangeOptions & { excludeReplies?: boolean; excludeReposts?: boolean };
export type XSearchOptions = XTimeRangeOptions & { sortOrder?: "recency" | "relevancy" };

export type XUserSummary = {
  id: string;
  /** Handle, without the "@". */
  username: string;
  name: string;
  verified: boolean;
  /** Only approved followers can see this user's posts. */
  protected: boolean;
  profileImageUrl?: string;
};
export type XUserInfo = XUserSummary & {
  url: string; description: string; location?: string; website?: string; createdAt: Date;
  followersCount: number; followingCount: number; postCount: number; listedCount: number;
  /** How the connected account relates to this user. Absent for the connected account itself and
   *  through an "X Profile" grant. */
  relationship?: { following: boolean; followedBy: boolean };
};

export type XReplySettings = "everyone" | "following" | "mentionedUsers" | "verified" | "subscribers";
/** A post another post reposts, quotes, or replies to. */
export type XReferencedPost = { id: string; url: string; text: string; author: XUserSummary; createdAt: Date };
export type XMediaInfo = {
  type: "photo" | "video" | "animated_gif";
  /** The image for photos; a preview image for videos and GIFs. */
  url?: string; altText?: string; width?: number; height?: number; durationMs?: number;
};

/** A post (formerly called a tweet). */
export type XPostInfo = {
  /** The post's ID. A post published in this session that X has not yet assigned an ID carries a
   *  temporary ID starting with "~", accepted anywhere this API takes a post ID. */
  id: string;
  /** Link on x.com; absent while the ID is temporary. */
  url?: string;
  /** Full text, also for long posts. Links appear in t.co form; see `links`. */
  text: string;
  author: XUserSummary;
  createdAt: Date;
  /** ID of the post that started the conversation (this post's own ID if it did). */
  conversationId: string;
  replyTo?: { postId: string; userId: string };
  repostOf?: XReferencedPost;
  quoteOf?: XReferencedPost;
  /** Mentioned usernames, without "@". */
  mentions: string[];
  hashtags: string[];
  /** Links in the text, expanded from t.co. */
  links: { url: string; title?: string }[];
  media: XMediaInfo[];
  poll?: { options: { label: string; votes: number }[]; endsAt: Date; open: boolean };
  metrics: { likes: number; reposts: number; replies: number; quotes: number; bookmarks: number; impressions: number };
  replySettings: XReplySettings;
  lang?: string;
  possiblySensitive: boolean;
};

export type XImageAttachment = {
  /** JPEG, PNG, or WEBP bytes, at most 5 MB. */
  data: Uint8Array;
  mediaType: "image/jpeg" | "image/png" | "image/webp";
  /** Describes the image for people who can't see it; at most 1,000 characters. */
  altText?: string;
};
/** A new post or reply. */
export type XPostDraft = {
  /** At most 280 characters (25,000 for X Premium accounts); each link counts as 23. May be empty
   *  when `images` are given. */
  text: string;
  /** Up to 4 images. Not combinable with `poll`. */
  images?: XImageAttachment[];
  /** 2–4 options of 1–25 characters, open for 5 minutes to 7 days. */
  poll?: { options: string[]; durationMinutes: number };
  /** Who may reply. Defaults to "everyone". */
  replySettings?: XReplySettings;
  /** Set when an attached image was generated by AI; X then labels the post. */
  madeWithAi?: boolean;
};

export type XListInfo = {
  id: string; url: string; name: string; description: string; private: boolean;
  owner: XUserSummary; memberCount: number; followerCount: number; createdAt: Date;
};

/** One post. From `XAccountSession.getPost()` or `getConversationPost()`, or granted as the
 *  "X Post" resource — which reaches that post's conversation and nothing else. Dispose when done. */
export interface XPost {
  /** Throws if the post was deleted or the connected account can't see it. */
  getInfo(): Promise<XPostInfo>;
  /** Direct replies from the last 7 days, newest first. */
  listReplies(options?: XTimeRangeOptions): Promise<Cursor<XPostInfo>>;
  /** Every post in this post's conversation from the last 7 days, newest first. */
  listConversation(options?: XTimeRangeOptions): Promise<Cursor<XPostInfo>>;
  listQuotes(options?: XPageOptions): Promise<Cursor<XPostInfo>>;
  /** Another post in this conversation, e.g. a reply. Fetches nothing until used; throws on use if
   *  the post belongs to a different conversation. */
  getConversationPost(postId: string): XPost;
  /** Reply as the connected account; returns the reply. */
  reply(draft: XPostDraft): Promise<XPost>;
  like(): Promise<void>;
  unlike(): Promise<void>;
  repost(): Promise<void>;
  undoRepost(): Promise<void>;
  /** Bookmarks are private to the connected account. */
  bookmark(): Promise<void>;
  removeBookmark(): Promise<void>;
  /** Permanently delete; only the connected account's own posts. */
  delete(): Promise<void>;
  /** Hide this reply in a conversation the connected account started. Hidden replies still appear
   *  in this API's listings. */
  hide(): Promise<void>;
  unhide(): Promise<void>;
}

/** One user's public profile and posts, read-only. Granted as the "X Profile" resource, through
 *  which nothing about the connected account is visible. Dispose when done. */
export interface XProfile {
  getInfo(): Promise<XUserInfo>;
  /** The user's posts, newest first, up to their most recent 3,200. */
  listPosts(options?: XTimelineOptions): Promise<Cursor<XPostInfo>>;
}

/** One user as the connected account sees them: their profile plus the account's relationship to
 *  them. From `XAccountSession.getUser()` / `getUserById()`. Dispose when done. */
export interface XUser extends XProfile {
  /** Whether the connected account has muted this user. */
  isMuted(): Promise<boolean>;
  /** Following a protected account sends a follow request instead. */
  follow(): Promise<void>;
  unfollow(): Promise<void>;
  mute(): Promise<void>;
  unmute(): Promise<void>;
}

/** One List. From `XAccountSession.getList()` / `createList()`, or granted as the "X List"
 *  resource. Only Lists the connected account owns can be changed. Dispose when done. */
export interface XList {
  getInfo(): Promise<XListInfo>;
  /** Posts from the List's members, newest first. */
  listPosts(options?: XPageOptions): Promise<Cursor<XPostInfo>>;
  listMembers(options?: XPageOptions): Promise<Cursor<XUserInfo>>;
  /** `username` may include the "@". */
  addMember(username: string): Promise<void>;
  removeMember(username: string): Promise<void>;
  update(changes: { name?: string; description?: string; private?: boolean }): Promise<void>;
  /** Permanently delete the List. */
  delete(): Promise<void>;
}

/** The connected X account, granted as the "X Account" resource. */
export interface XAccountSession {
  getProfile(): Promise<XUserInfo>;

  /** Posts from accounts the connected account follows, newest first: the last 7 days, at most
   *  3,200 posts. */
  listHomeTimeline(options?: XTimelineOptions): Promise<Cursor<XPostInfo>>;
  /** Posts mentioning the connected account, newest first; at most the latest 800. */
  listMentions(options?: XTimeRangeOptions): Promise<Cursor<XPostInfo>>;
  listMyPosts(options?: XTimelineOptions): Promise<Cursor<XPostInfo>>;
  /** Posts from the last 7 days matching X search syntax, e.g.
   *  `"workers ai" from:cloudflare -is:retweet`; at most 512 characters. */
  searchPosts(query: string, options?: XSearchOptions): Promise<Cursor<XPostInfo>>;
  /** Most recently bookmarked first. */
  listBookmarks(options?: XPageOptions): Promise<Cursor<XPostInfo>>;
  listLikedPosts(options?: XPageOptions): Promise<Cursor<XPostInfo>>;
  listFollowing(options?: XPageOptions): Promise<Cursor<XUserInfo>>;
  listFollowers(options?: XPageOptions): Promise<Cursor<XUserInfo>>;
  listOwnedLists(options?: XPageOptions): Promise<Cursor<XListInfo>>;

  /** By ID or x.com / twitter.com URL. These getters fetch nothing until used. */
  getPost(idOrUrl: string): XPost;
  /** By username (with or without "@") or profile URL. */
  getUser(usernameOrUrl: string): XUser;
  /** By numeric ID, which unlike a username never changes. */
  getUserById(userId: string): XUser;
  getList(idOrUrl: string): XList;

  /** Publish a post as the connected account; returns the new post. */
  createPost(draft: XPostDraft): Promise<XPost>;
  /** Publish a thread — each draft replying to the one before; at most 25 posts. */
  createThread(drafts: XPostDraft[]): Promise<XPost[]>;
  createList(name: string, options?: { description?: string; private?: boolean }): Promise<XList>;
}
```

Shape notes for review:

- **Capabilities are nouns, data is `*Info`.** `XPost` / `XProfile` / `XUser` / `XList` are
  stubs; `XPostInfo` / `XUserInfo` / `XListInfo` are values. The Post binding's session *is* an
  `XPost`, the List binding's an `XList`, the Profile binding's an `XProfile`, so logic written
  against one works whether reached broadly or through a fine-grained grant (Spotify's playlist
  rule).
- **`XUser` extends `XProfile`.** The Account binding's `getUser()` returns the same reads plus the
  connected account's relationship and actions, so a digest written against `XProfile` runs on
  either grant, and the Profile grant is that interface with every write and every fact about the
  connected account taken away.
- **No `isLiked()` / `isBookmarked()` / `isReposted()`.** X's v2 post object carries no per-viewer
  engagement flags (v1.1's `favorited` is gone); answering would mean scanning liked posts at a
  read per row. Following and mute state *are* answerable (`connection_status`), so `XUserInfo`
  and `isMuted()` expose them.
- **Replies and conversations are search-backed** (`in_reply_to_tweet_id:` / `conversation_id:`),
  hence "the last 7 days" in the JSDoc; full-archive search is punted.
- **`relationship` omits pending follow requests and blocks**: a request to a protected account
  reads as `following: false` until accepted (Known edge cases), and this API neither reads nor
  makes blocks (blocking is Enterprise-only).
- **Hooks are not in this file yet**; PR B adds `subscribeMentions` / `subscribeReplies` /
  `subscribePosts` (§9) and goes through the same review.

### 6. Gatekeeper DO: actions, simulation, caching

**Action kinds** — one `defineActions` table, fenced on the pinned X user ID (the Profile binding
submits none):

| `actionKind.tag` | Label | Methods | Apply | Revert | Auto |
|---|---|---|---|---|---|
| `x.post.create` | Publish posts | `createPost`, `createThread` | upload images → alt text → `POST /2/tweets`; a thread in order, with progress | delete what was posted, newest first | no |
| `x.post.reply` | Reply to posts | `XPost.reply` | `POST /2/tweets` with `reply.in_reply_to_tweet_id` | delete the reply | no |
| `x.post.delete` | Delete posts | `XPost.delete` | `DELETE /2/tweets/:id` | — permanent | no |
| `x.post.like` | Like posts | `like`, `unlike` | likes endpoints | inverse | no |
| `x.post.repost` | Repost posts | `repost`, `undoRepost` | retweets endpoints | inverse | no |
| `x.post.bookmark` | Bookmark posts | `bookmark`, `removeBookmark` | bookmarks endpoints | inverse | **yes** |
| `x.post.hide` | Hide replies | `hide`, `unhide` | `PUT /2/tweets/:id/hidden` | inverse | **yes** |
| `x.user.follow` | Follow accounts | `follow`, `unfollow` | following endpoints | inverse | no |
| `x.user.mute` | Mute accounts | `mute`, `unmute` | muting endpoints | inverse | **yes** |
| `x.list.manage` | Manage Lists | `createList`, `XList.update`, `XList.delete` | lists endpoints | create → delete; update → restore the snapshot taken at apply; delete → — | no |
| `x.list.members` | Manage List members | `addMember`, `removeMember` | members endpoints | inverse | no |

**Descriptions** (kit builder; titles through `sanitizeTitle`, labels through `plainInline`,
content always in fields). Every title names the acting account — users connect personal and brand
accounts side by side.

- *Publish*: "Publish a post on X as @handle." + verbatim **Post** (a thread: **Post 1** … **Post
  N**) + list **Mentions** + list **Links**, with the prose note "Contains links; X bills link posts
  at a higher rate." + per image a `file` field (`origin: "agent"`) and verbatim **Alt text** +
  **Poll options** and inline duration + inline **Who can reply** + inline **Made with AI**.
  Complete exactly when there are no images.
- *Reply*: adds inline **Replying to** (the parent's URL, or "your pending post ~N") and verbatim
  **Their post** — context the approver needs, not something sent.
- *Engagement*: "Like a post by @author on X as @handle." + the post's URL and verbatim text.
  *Delete*: "Permanently delete this post from X." + its verbatim text.

**Submit-time validation**, so the queue never holds something X will refuse: weighted text length
(twitter-text rules: a URL counts 23, wide code points 2) against 280, or 25,000 when
`subscription_type` isn't `None`; empty text without images; a poll with images; more than four
images; image bytes whose magic number disagrees with `mediaType`, or over 5 MB; a thread over 25
posts; text identical to another pending post (X refuses duplicates); a reply where the cached
parent's `reply_settings` excludes the account.

**Dependencies.** A post created in this session gets a provisional ID `~N` from
`ProvisionalIds`; replying to, liking, reposting, bookmarking or deleting it is a dependent action
(`dependsOn`). Applying a dependent first is a retryable "Approve the post it depends on first";
a terminal failure or rejection of the create cascades to its dependents, and `rejectAction`
returns `{restart: true}` when anything was simulated on top of it.

**Reconciliation.** `x.post.create` and `x.post.reply` are `claimBeforeApply`; each send records
`{attemptedAt, textDigest}` before `POST /2/tweets`. An attempt whose outcome is unknown is
reconciled on the next apply with `GET /2/users/:id/tweets?start_time=<attemptedAt>&max_results=5`
— a read for the gatekeeper's own purposes, so not an observation — binding an exact text match
and otherwise posting. Rejecting an attempted create is refused as Chat does ("this may already be
on X — approve it again, then delete it").

**Simulation** — overlays replayed in submission order over each read:

| Pending action | Reflected in |
|---|---|
| create, thread, reply | `getPost("~N").getInfo()`; prepended on the first page of `listMyPosts` and of the parent's `listReplies` / `listConversation`, without slicing, so no real row is lost (Spotify's lesson) |
| delete | dropped from every listing; `getInfo()` throws not-found |
| like / unlike | `listLikedPosts` (prepend / drop) |
| repost / undo | `listMyPosts` (a synthesized repost row / drop) |
| bookmark / remove | `listBookmarks` |
| follow / unfollow | `listFollowing`; `XUserInfo.relationship.following` |
| mute / unmute | `XUser.isMuted()` |
| List create / update / delete / members | `listOwnedLists`, `XList.getInfo()`, `listMembers` |

`metrics` counts are not adjusted — they lag real actions on X too — and hidden state isn't
simulated because X reports none; neither needs `awaitDecision`, since no read contradicts the
action.

**Caching** — `KvTtlCache.partitionedBy` the credential source, so a reconnect can't serve the
previous grant's rows; every TTL is far inside X's 24-hour deletion rule:

| Cache | TTL |
|---|---|
| Post by ID (also filled from listings) | 5 min |
| User by ID / username | 1 h |
| List metadata | 15 min |
| A listing page, keyed by endpoint + params + token | 60 s — absorbs gadgets polling one first page |
| Identity (account DO) | 24 h |
| Observer verdicts, positive only (§7) | 1 h |

**Media.** `ActionFileStore` with `maxFileBytes` 5 MiB and `maxTotalBytes` 64 MiB across pending
posts, `pruneUnreferenced` before each capture, refs released when a record retires. Apply uploads
each image (`media_category: tweet_image`), sets alt text through `/2/media/metadata`, then posts
with `media.media_ids` and `made_with_ai`.

### 7. Observers

Each read is classified before it is authorized:

- **Owner-private** if it comes from an inherently private source — bookmarks, likes,
  `isMuted()`, a private List's details, posts or members, and a protected connected account's
  follow graph, whether read as its follow lists or edge by edge as the `relationship` a profile
  read reports — or returns any post written by a protected account (including all the
  connected account's own posts when it is protected).
  Privacy is X's, never the simulated value: a pending change that would make a private List
  public leaves it owner-private until X has made it public. And missing evidence is not
  privacy's absence: a post whose author X did not expand, or expanded without `protected` (a
  200 can omit expansions it failed to hydrate), counts as a protected account's, as does a
  connected account whose identity X returned without it; a List X returned without `private`
  counts as private.
- **Public** otherwise: public posts, every profile (X shows protected accounts' profiles; only
  their posts are hidden), public Lists, and an unprotected account's followers and following.

Owner-private reads authorize against one synthetic collection, `owner`; public reads use the
`baseline` scope; the kit's `trackedCollectionObservers` does the bookkeeping.

| Binding | Strategy | `verifyBaseline` (every open) | Access to `owner` |
|---|---|---|---|
| X Account | C | — (public data needs only the X account every observer must connect) | the observer's X user ID is the bound one |
| X Post | C | the observer's X account can see the bound post | same |
| X List | C | the observer's X account can see the bound List | same |
| X Profile | C | — (a public profile needs only an X account) | same — for a protected user's posts |

`XVerifier` is a `WorkerEntrypoint` over the observer's own `UserAccount`. `getXUserId()` answers
from the stored identity, once the connection's credentials prove usable — no call unless the
access token needs refreshing, and null for a grant X refused for good. `canViewPost(id)` / `canViewList(id)` ask X with the
observer's token through `probeAccess` (401/403/404 → `false`; anything else throws, so the open
fails loudly). Each probe costs a read, so positive verdicts are cached per (observer, resource)
for an hour; negatives never are.

Why not D, as Spotify is: X's likes have been private since 2024, bookmarks always were, and a
protected account's posts exist to be seen only by approved followers — a shared gadget
re-displaying any of them leaks. Why not A: almost everything on X is public, and a team sharing a
brand account is the main sharing case; this rule serves both. Accepted over-permissiveness: an
author who has blocked the observer — X hides that author's posts from them — can still be read
through the gadget; checking every author per observer per read would cost a read each, and what
leaks is public.

### 8. Errors, rate limits, cost controls

- **What the agent sees.** Rate limit: "X's rate limit for this request is used up for this
  account. It resets at HH:MM UTC." — never an automatic retry (a request must not sleep for
  minutes). The planned in-memory reset map for failing later calls fast was dropped as built: a
  refused request costs nothing at X, and a map per isolate would not span the account's bindings
  anyway. Credits: "The X API credits
  for this deployment are used up, or its spending limit was reached; ask the administrator." Not
  found, not visible, reply restricted, duplicate content, too long: plain sentences from X's
  `detail`.
- **Apply failures.** Rate limits and credits are retryable plain errors; X's 400/403 refusals are
  `ActionApplyError` (terminal, dependents stranded); unknown outcomes as §6.
- **The `tweet` → `post` rename is mid-flight on the wire.** OpenAPI `2.170` says `post.fields`,
  `referenced_posts`, `edit_history_post_ids`, `post_count`, `note_post`; the docs' examples and
  every XAA payload say `tweet.fields`, `referenced_tweets`, `edit_history_tweet_ids`,
  `tweet_count`. The normalizer accepts both spellings everywhere; which request parameter the live
  API honours is a verification item. Long posts' full text comes from `note_tweet` / `note_post`,
  never the truncated `text`.
- **Logging.** `createLogger({component: "gatekeeper.x", vendorId: "x"})` with events such as
  `x.token.refresh`, `x.api.rate_limited`, `x.api.credits_exhausted`, `x.action.reconciled`,
  `x.hydration.dropped`. Never post text, search queries, third parties' handles, or tokens.
- **Metrics.** One `x.api.billable` count per billable call, by billing class (counts only), so
  operators can line the Analytics Engine dataset up against X's console.
- **Daily read limit, per connection, set by the deployment.** The `UserAccount` DO counts
  billable read resources per UTC day — X's own dedupe window — so every binding and gadget on a
  connection draws on one budget. A read reserves its page size before fetching and settles with
  what came back; at the limit reads fail with a display-safe message naming the reset ("This X
  connection has used today's 2,000 reads; the limit resets at 00:00 UTC."). Writes are already
  bounded by approvals. The deployment sets the limit with the `X_DAILY_READ_LIMIT` worker var —
  in-code default 2,000, `0` for none — the way GitLab's `GITLAB_URL` is set, not as a wizard
  input: `DeployInput` (`scripts/release/manifest-lib.ts:150`) has no default or optional flag, so
  every install would have to type a number. Making it editable from an admin page, with each
  user's usage shown, is a follow-up (Punted).

### 9. Hooks (PR B)

PR B adds `XAccountSession.subscribeMentions(hook)` and `subscribeReplies(hook)` (replies to any of
the account's posts), `XPost.subscribeReplies(hook)` for the account's own posts, and
`XProfile.subscribePosts(hook)` for a user's new posts, delivering
`XPostHook.receivePost(post, reason)`; `hook` is a persistent stub made with `ctx.restore()`.

- **Configuration**, as for GitHub's hooks: `WEBHOOK_ORIGIN` (a var) and `X_APP_BEARER_TOKEN` (a
  secret) are set on the worker outside the wizard, and passed through in dev by
  `PASSTHROUGH_GATEKEEPER_VARS`. Until both are set, every `subscribe*` refuses with "Push
  notifications aren't set up on this deployment" and the webhook route is inert. If live
  checkpoint 2 shows `client_credentials` with the OAuth 2.0 client yields a usable app token, the
  token var becomes unnecessary.

- **Delivery** is XAA by webhook: one per deployment, at `{WEBHOOK_ORIGIN}/gatekeeper/x/webhook`
  (https, and no port — X refuses ports). `GET` answers the CRC with `{response_token: "sha256=" +
  base64(HMAC-SHA256(CLIENT_SECRET, crc_token))}`. `POST` verifies
  `X-Twitter-Webhooks-Signature-OAuth2` (the same HMAC over the raw body) in constant time, reads at
  most 5 MiB, and only enqueues, to answer inside X's 10 seconds.
- **Registration.** An `XWebhookRegistry` singleton DO keeps the webhook registered and valid
  (`/2/webhooks` list / create / `PUT` to revalidate, checked hourly) using `X_APP_BEARER_TOKEN`,
  since those endpoints take only an app-only bearer token.
- **Subscriptions** are per (X user, event type) — `post.mention.create` and `post.reply.create`
  — created with the user's own token, as these are private events, and never with a `post_id`
  qualifier: XAA rejects a qualified subscription overlapping an unqualified one, and the
  self-serve tier's 1,500-subscription cap must cover a whole deployment, so each connected X user
  costs at most two subscriptions however many hooks bind. Per-post filtering happens on our side.
  A watched user's `post.create` is a *public* event, so the registry subscribes with the app
  token, once per watched user however many hooks watch them; each delivered post is billed as a
  post read. `oauth.revoke` takes no filter, so it is one app-wide subscription, also the
  registry's.
- **Routing.** An `XActivityRouter` DO named by X user ID holds the subscription IDs and every
  `(UserAccount, hookKey)` registration — two Workshop users may connect one X account — and fans
  each event out to each registration's `HookDeliveryQueue`, deduped by `event_uuid`. Then the
  GitHub pipeline: `initiator.startHook()`, re-check the binding's scope in the facet (the bound
  conversation for a Post binding), classify (§7), observe, `receivePost`.
- `oauth.revoke` is routed by the revoking user's ID to every `UserAccount` connected as that X
  user, each calling `credentialsExpired()`. Posts the connected account authored are dropped from
  every hook, and its own posts can't be watched, so a hook can't answer itself. Billing is per delivered event (a post read each).
  XAA never delivers protected accounts' posts, and `post.reply.create` fires only for *direct*
  replies to the subscribed user's own posts — both said in the hook JSDoc.

### 10. Tests

- **Node** (`__tests__/*.test.ts`): `x-normalize` against doc-derived fixtures labelled
  `source: "docs" | "live"` (both field spellings, `note_tweet`, partial `errors[]`, protected
  authors, reposts and quotes); weighted length (URLs, CJK, emoji, ZWJ sequences); URL
  canonicalization (every host form, `/i/web/status`, suffixes like `/photo/1`, query strings);
  `x-api` error mapping (429 rate-limit versus usage-capped, 401, partial errors, no redirects);
  descriptions (fields carry all content; images make a description incomplete; titles name the
  account); the resource → scope table (`[]` versus omitted).
- **Configurator** (`configurator-url.test.ts`): every post, List and profile URL form (every
  tab, `@handle`, both hosts) resolves through `resolveRequestedResource` to its own resource,
  never the catch-all; `/settings/account` resolves to the catch-all; reserved first segments
  never yield a Profile; the connected user's own handle yields a Profile, not the Account;
  `resourceUrl` and `initialValuesFromResourceUrl` round-trip.
- **Workerd** (`__tests__/workerd/`, a `TestHooks` DO reaching the facet through `ctx.facets`, a
  `vi.stubGlobal("fetch")` fake X API):
  - *account*: eight concurrent token reads → exactly one redemption; `invalid_grant` terminal;
    a reconnect as another X user refused and its grant revoked; an overtaken reconnect;
    local-first revoke; `describe()` makes no call inside 24 hours.
  - *reads*: the classification of each read as owner-private or public; cursor walks; cache
    partitioning across a reconnect; the rate-limit fast-fail; the daily limit reserving,
    settling and resetting at UTC midnight across two bindings of one connection.
  - *resources*: `/settings/account` resolved under a second account yields *that* account's
    Account binding (the blueprint path); a Profile binding exposes no write method and no
    `relationship`; a renamed user keeps resolving through the pinned ID.
  - *actions*: every kind's apply, revert and reject; thread progress resumes after a mid-thread
    failure; dependents of `~N`; the cascade and `{restart: true}`; reconciliation binding a match
    after an injected timeout; an auto-approval racing `submitAction`; media captured, uploaded
    only at apply, and pruned.
  - *observers*: public-only workspaces admit any X observer; `owner` admits only the same X user;
    the Post / List baselines; positive verdict caching.
- **Release**: fixture bundle `scripts/release/testdata/fixture-bundles/gatekeeper-x/x.js`, then
  `UPDATE_GOLDEN=1 node --test scripts/release/manifest-lib.test.ts`.

### 11. Deployment integration

- **`deploy-inputs.json`**: `CLIENT_ID` ("OAuth 2.0 Client ID") with `consoleUrl`
  `https://console.x.com`, `redirectUriTemplate` `{PUBLIC_BASE_URL}/gatekeeper/x/oauth`, and setup
  steps: create a Project and App; enable OAuth 2.0 user authentication as "Web App, Automated App
  or Bot" with "Read and write" permission; set the callback URL and a website; buy credits and
  set a spending limit; and note that X requires its prior approval before an app posts
  AI-generated replies. Then `CLIENT_SECRET`.
- **Dev**: `"gatekeeper-x": { id: "X_CLIENT_ID", secret: "X_CLIENT_SECRET" }` in
  `SHARED_GATEKEEPER_CREDS`; PR B adds `WEBHOOK_ORIGIN` and `X_APP_BEARER_TOKEN` to
  `PASSTHROUGH_GATEKEEPER_VARS`. The README covers registering
  `http://127.0.0.1:8787/gatekeeper/x/oauth` as a callback, and a tunnel for webhooks.
- **README**: setup; the price list and worked examples (a 200-post daily digest is about $1–3 a
  day with authors; a link post $0.20); the policy obligations operators carry (AI-generated
  replies need X's prior approval; automated accounts must carry X's "Automated" label; likes and
  follows must stay user-initiated, which is why they are never auto-approved); troubleshooting
  entries titled with the literal error messages.
- **Docs**: three rows in `docs/observers.md` §9.2, the root README's gatekeeper list, and an
  AGENTS.md bullet for the cost and policy points a future editor must not undo.
- **Kernel**: none.

## Constants (tunable, named in one place)

`DEFAULT_PAGE_SIZE` 20 and `MAX_PAGE_SIZE` 100; `MAX_THREAD_POSTS` 25; `MAX_IMAGES_PER_POST` 4;
`MAX_IMAGE_BYTES` 5 MiB; `PENDING_MEDIA_BYTES` 64 MiB; `TEXT_LIMIT` 280 and
`TEXT_LIMIT_PREMIUM` 25,000; `URL_WEIGHT` 23; `RECONCILE_LOOKBACK` 5 posts; `POST_TTL_MS` 5 min,
`USER_TTL_MS` 1 h, `LIST_TTL_MS` 15 min, `PAGE_TTL_MS` 60 s, `IDENTITY_TTL_MS` 24 h,
`VERDICT_TTL_MS` 1 h; `OWNED_LISTS_UI_TTL_MS` 5 min; `DEFAULT_DAILY_READ_LIMIT` 2,000 (overridden
by `X_DAILY_READ_LIMIT`); `PROFILE_TABS` and `RESERVED_FIRST_SEGMENTS` (§4); the field and
expansion sets of §2.

## Verification

1. **Doc-derived fixtures** for every normalizer and error path, labelled `source: "docs"`.
2. **Live checkpoint 0 — before commit 2** (an hour, a scratch X app, a few dollars of credits):
   these change the credential and cost design, so they are settled first.
   - Does a refresh rotate the refresh token, and what does a spent or revoked one return (is it
     `invalid_grant`)? Does the token response carry `scope`?
   - Does revoking one refresh token revoke the whole grant (decides `discardMint`)?
   - Does a second authorization of the same X user through the same app — two Workshop users on
     one brand account, or a reconnect — invalidate the first grant?
   - Which spelling does the live API honour: `tweet.fields` or `post.fields`, `referenced_tweets`
     or `referenced_posts`?
   - Are `includes` expansions billed per resource? (Usage endpoint and console deltas.)
   - The exact shapes of the usage-capped, no-credits and spending-limit errors.
   - Whether `http://127.0.0.1` callback URLs are accepted.
   - Whether `connection_status` reports `muting` without the `mute.read` scope.
3. **Live checkpoint 1 — after commit 5**: every action against a scratch account, plus revert;
   weighted-length limits for a non-Premium account; the duplicate-content error; whether an
   x.com link alone triggers the with-URL rate; following a protected account (pending);
   reconciliation with an injected timeout; observers with a second connected account.
4. **Live checkpoint 2 — PR B**: CRC and signature against a real webhook; subscriptions created
   with a user token; delivery, `event_uuid` dedupe, `oauth.revoke`; whether `/2/webhooks` accepts
   a bearer obtained by `client_credentials` with the OAuth 2.0 client ID and secret.
5. **Staging soak**: a week on the internal deployment with spend watched through
   `GET /2/usage/tweets`.

**Documentation findings that shaped the design**: quote posting is Enterprise-only; blocking
users is Enterprise-only; the Account Activity API is deprecated, with three subscriptions on
pay-per-use; edits are allowed for 30 minutes (though XAA's sample payload shows an hour); media
IDs expire; the authorization code lives 30 seconds; replies and conversations are only reachable
through 7-day search.

## Known edge cases / watch-fors

- **The 30-second authorization code.** Nothing may run between claiming the nonce and the
  exchange — in particular not `/2/users/me`, which comes after.
- **One rate limit per X user.** Limits are per user, shared by every gadget and every Workshop
  user on that X account; a busy digest gadget can exhaust the home-timeline limit (180 per 15
  minutes) for everyone else on it.
- **IDs are strings.** Snowflakes exceed 2^53; nothing parses them as numbers.
- **Your own profile URL means the Profile binding.** Pasting it grants read-only access to your
  public posts; full access is the X Account option in the same picker.
- **Handles change; IDs don't.** A Profile binding pins the user ID it first resolved, so a rename
  keeps it working and its canonical URL follows the new handle at the next `describe()`. An old
  handle someone else later claims never redirects the binding to a stranger.
- **7-day windows.** Search, replies and conversations reach back 7 days; the home timeline 3,200
  posts or 7 days; mentions the latest 800; a user's posts the latest 3,200.
- **Protected accounts.** Following one sends a request, so `following` stays `false` until
  accepted; their posts are owner-private (§7); XAA never delivers them.
- **Edited posts get new IDs.** An X Post binding follows the ID it was made with; the docs
  disagree on whether an old ID returns the latest version, so `getInfo()` reports what X returns.
- **Duplicates.** X refuses a post identical to a recent one; submit-time validation catches
  pending duplicates, and apply maps X's refusal to a plain message.
- **Text limits depend on the account.** `subscription_type` is read at connect and refreshed
  daily; a downgrade can make an approved long post fail at apply (a terminal, plain error).
- **Reply restrictions.** A parent whose `reply_settings` excludes the account fails at apply if
  the cached parent predates the change.
- **Links are expensive** — $0.20 against $0.015 — and presumably any URL counts, x.com links
  included (to confirm at checkpoint 1); the approval says so and the README warns operators.
- **Followers / following cost $0.010 a user.** A walk through 5,000 followers is $50; the
  default page size and the daily limit are the guard.
- **Hidden replies stay listed**: X exposes no hidden state.
- **Webhooks (PR B)**: no ports in the URL; a CRC every 30 minutes once unvalidated for 24 hours;
  marked invalid after 28 hours of failures — the registry's hourly check revalidates.

## Commit sequence

PR A lands the gatekeeper in reviewable layers; PR B adds hooks.

**PR A — the gatekeeper**

1. **x: package skeleton + API design** — `package.json`, `tsconfig.json`, `vite.config.ts`, both
   vitest configs, `cloudflare.config.ts` (and the generated `wrangler.jsonc`),
   `deploy-inputs.json`, logo, `text-modules.d.ts`, `observability.ts`, **`types.d.ts` +
   `types.txt`** (§5), `README.md`, `storage-schema.md` skeleton, `x-api.ts` and `x-normalize.ts`
   with their node tests and doc fixtures, the release fixture + golden, the dev credential
   mapping. Nothing implements `Gatekeeper` yet. **Review checkpoint: `types.d.ts` approved before
   commit 2; live checkpoint 0 settled before commit 2.**
2. **x: accounts and OAuth** — `UserAccount`, `GatekeeperVendor`, `GatekeeperUserImpl`,
   `XVerifier` identity, scopes, `ensureResources`, reconnect + identity pinning, revoke; workerd
   account tests.
3. **x: resources and configurators** — URL canonicalization, patterns, `getGatekeeperClassFor`,
   the four configurators; configurator tests.
4. **x: reads, caching, observers, read limit** — the read side of every session (the Profile
   binding is complete here), `TokenCursor` walks, `KvTtlCache`, classification +
   `ObservationGate`, verifier probes, the daily read limit; workerd read, resource and observer
   tests.
5. **x: actions and simulation** — journal, provisional IDs, descriptions, apply / reject / revert
   for every kind, threads, reconciliation, overlays; workerd action tests.
6. **x: images** — `ActionFileStore` capture, sniffing, apply-time upload and alt text; tests.
7. **docs** — `docs/observers.md` rows, the root README list, the AGENTS.md bullet.

**PR B — hooks**

8. **x: webhook endpoint and registry** — the `WEBHOOK_ORIGIN` / `X_APP_BEARER_TOKEN`
   configuration (inert without them), CRC, signature verification, `XWebhookRegistry`; tests.
9. **x: subscriptions, routing, delivery** — `XActivityRouter`, `HookDeliveryQueue`, facet
   re-checks, the hook types in `types.d.ts` (`subscribeMentions`, `subscribeReplies`,
   `subscribePosts`; reviewed again); workerd hook tests. Live checkpoint 2 waits on the app
   token.

## Punted / future work (deliberately kept open)

- **An admin-editable read limit, and a usage page.** The account could declare `providesUi` and
  serve a page through `startAppUi({isAdmin})` — the Scheduler and Context Library precedent —
  showing each user their connection's reads today and letting admins change the limit live, with
  no worker var and no kernel change.
- **Edits.** The 30-minute window and Premium-only rule fight approval latency, and every edit
  mints a new ID; delete-and-repost covers the common case.
- **Quote posts** — Enterprise-only on X; reading quotes is supported.
- **GIF and video** — chunked upload (`initialize` / `append` / `finalize`), asynchronous
  processing polled through `GET /2/media/upload`, and files up to 8 GB that cannot live in DO
  storage.
- **DMs / XChat**, **bookmark folders**, **post analytics** (non-public metrics and insights),
  **full-archive search** for older conversations, **Spaces, Communities, Community Notes,
  Articles, Trends, News**, **blocks** (Enterprise-only).
- **Sign in with X** would add X as a way to log in to the Workshop itself, beside the existing
  sign-in providers (`providesAuth`, enabled per deployment through `AUTH_GATEKEEPERS`). It
  changes nothing about what agents can do with X, so it neither helps nor hurts this design, and
  adding it later needs no rework. It would need X's "Request email from users" permission (privacy
  policy and terms URLs on the X app), proof that `confirmed_email` is provider-verified, and a
  paid user read per sign-in.
- **Scheduled posts** — "approve now, publish at 9:00": a facet alarm holding an approved post
  until its time; pairs naturally with `gatekeeper-scheduler`.
- **Image previews in the approval UI** — the largest UX gap for image posts, and a kernel change
  (an image-capable `ActionField`), so a separate PR.
- **Estimated charges in approvals and a deployment spend view** fed by `GET /2/usage/tweets` —
  kernel/admin work.
- **A shared HTTP-client base in the kit** — GitHub, GitLab and now X each carry a `request()` +
  error-class pair; this is the third copy.

## Decisions from review (2026-10-10)

1. **Name: `gatekeeper-x`.**
2. **Granularities: Account, Post, List, and a read-only Profile** of any user (§4, §5). This is
   why the Account's canonical URL became `https://x.com/settings/account`.
3. **A daily read limit per connection, configured by the deployment** (§8): the
   `X_DAILY_READ_LIMIT` worker var over an in-code default of 2,000. An admin-editable limit is a
   follow-up.
4. **Replies ship, with a warning** to operators in the README and the wizard's setup steps.
5. **Push notifications are in (PR B).** The app-level bearer token will be acquired later; until
   it is set, hooks are refused and everything else works, so PR B can land before the token
   exists and only its live checkpoint waits.
6. **Retained X content is accepted**: what observation logs and transcripts keep stays inside a
   workspace that is not publicly viewable, and the gatekeeper's caches stay inside X's 24-hour
   rule.
7. **Sign in with X: deferred.** It is orthogonal to the agent features, so leaving it out costs
   nothing now and adding it later needs no rework (Punted).
8. **No X pre-approval gate** before the internal deployment uses this.

Nothing remains open except the `types.d.ts` review.

## As built (2026-10-10)

PR A is implemented in `packages/gatekeeper-x` (183 Node tests, 89 workerd tests). Where the build
departed from the design above:

- **`XCursor`, not the kit's `TokenCursor`.** `TokenCursor` fills a short page by fetching up to
  ten more provider pages per `next()`, and on X every row fetched is billed. `x-cursor.ts` keeps
  the kit cursors' contract -- each page authorized before it leaves, a refused page held and
  offered again without re-reading -- with exactly one X request per `next()`. Search continues with
  `next_token`; every other listing with `pagination_token`.
- **Reconciliation is inline.** The kit's `ActionOutcomeUnknownError` is terminal, so it cannot carry
  "check, then post". A send instead writes an attempt marker (`attempt:<id>:<index>`: the send's
  time and the media IDs it attached) before `POST /2/tweets`; a lost answer or a 5xx leaves the
  action pending with a plain error, and the next apply first reads the account's posts dated from
  10 s before the attempt to 5 minutes after it (`max_results=100`). It binds a post only when
  exactly one matches the draft's reply parent, `comparableText`, link destinations
  (`expanded_url`, through `comparableUrl`), poll and media IDs. None sends again; more than one,
  or a window too full for one page, ends the action with `ActionOutcomeUnknownError`, since
  binding the wrong post would have a revert delete it. A duplicate refusal says the send made
  nothing, so it is reconciled only against an earlier send X never confirmed, never against posts
  that were already there; a first send refused that way fails. While a marker or thread progress
  exists, `reject` is refused ("it may already be on X"). A terminal failure part-way through a
  thread names the posts already published. `x.list.manage`'s creation is reconciled the same
  way, since `POST /2/lists` has no idempotency key either: against every page of the account's
  owned Lists (X cannot filter them by date), on name, description, privacy and a `created_at` in
  the window. Lists can share all of those, so the matching Lists already there are read before
  the first send and never bound, at the cost of one owned-Lists read per creation.
- **Revocation is narrower than §3.** A grant is revoked only when it provably shares no
  authorization with a live one: another X user's (a refused reconnect), a first connect the
  Workshop never took, and what a disconnect leaves. A same-user reconnect's leftover is dropped
  unrevoked, and `discardMint` stays unset, until checkpoint 0 shows whether revoking one refresh
  token revokes the user's others.
- **`x-credentials.ts`** holds what the account shares with the rest of the Worker -- the public
  grant, the pinned identity, the read reservation, `accountSource` and `withinReadLimit` -- so the
  facet and configurator modules use them without an import cycle through `x.ts`. Every read the
  gatekeeper, the List picker and the observer probes make goes through `withinReadLimit`.
- **No 429 fail-fast map** (§8).
- **The pins live in the facet.** `pinnedUserId` (first use; a connection that comes to name
  another user is refused, and it is the action fence) and a Profile binding's `profileUserId`
  (first lookup by handle). A Post, List or Profile `describe()` is fetched once and stored.
- **The auto-approval catalog is per binding**: an account binding offers bookmark, mute and hide;
  a Post binding bookmark and hide; List and Profile bindings nothing, since they can submit none.
- **Housekeeping runs from `applyAction`**, at most every six hours: retained actions older than 30
  days are retired, and orphaned progress and attempt markers swept. Orphaned images are pruned
  before each capture, after an hour's grace.
- **Configurator `ui` capabilities**: the account, post and profile frames share an empty
  `XPlaceholderConfiguratorUI`; only the List picker reads X (owned Lists cached 5 minutes in the
  capability).
- **The Profile pattern admits X's reserved pages** (`/home`, `/explore`), since URLPattern cannot
  exclude them case-insensitively. The Workshop may therefore pre-select the Profile resource for
  such a link; `getGatekeeperClassFor` and the profile configurator both refuse it, so it fails
  closed. `configurator-url.test.ts` pins that.

### PR B as built

PR B is implemented on `dancarter/x-gatekeeper-hooks`, stacked on `dancarter/github-hooks` for the
kit's `HookDeliveryQueue` and the hook contract, which are not on `main` yet (26 workerd hook tests).
It follows `gatekeeper-github`'s hooks rather than §9 where the two differ:

- **Three Durable Objects, not two.** A per-account `XHookDriver` holds the account's enabled hooks
  and the delivery queue, as GitHub's driver does, so disconnecting the account cancels everything
  of its in one call. The `XActivityRouter` per X user holds only the subscriptions and which
  accounts watch each, and fans events out to their drivers; a subscription nothing watches is kept
  until X confirms deleting it, retried from the router's alarm. `XWebhookRegistry` is as planned.
- **Hooks are bound GitHub's way.** `subscribe*()` mints a `ctx.restore()` delivery stub into an
  `XHookController` loopback entrypoint, nothing is stored until the user enables the hook, each
  delivery takes a fresh firing from `startHook()`, and the facet re-checks every event against the
  binding (the binding's scope beats the stub's parameters) before authorizing it through the
  binding's observer gate and calling `receivePost`.
- **The event is `XPostEvent { id, reason, info, post? }`**, delivered to `XPostHook.receivePost`,
  with an `XPost` capability for account and Post bindings (confined to the conversation for a Post
  binding) and none for a Profile binding. A post X delivers without its author, or without saying
  whether they are protected, is completed with one cached user read, and kept from observers
  connected as other X users if that read fails (the reads' `authorsUnverified` fence).
- **Unverified X behaviour, handled defensively:** the duplicate-subscription refusal (any 409, or
  "duplicate" in its type, title or message, adopts the existing subscription through
  `GET /2/activity/subscriptions`, narrowed by `user_id` since X lists at most 1,000 a page); the
  shapes of `GET`/`POST /2/webhooks`; and whether a delivery batches events (`data` may be an
  object or an array).
- **Not done:** recovering missed deliveries through `POST /2/webhooks/replay`; re-checking
  subscriptions at X (the registry checks the webhook hourly, but a subscription X drops without an
  `oauth.revoke` stays recorded until a hook is enabled again); and counting delivered events
  against the daily read limit (they are billed regardless, so the README says so).

Still to do: live checkpoints 0 and 1 (an X app with credits), and live checkpoint 2 for PR B, which
waits on the app's bearer token.
