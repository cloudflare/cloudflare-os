# X gatekeeper

X (formerly Twitter) — account / post / List / read-only profile resources over plain `fetch` (the
`twitter-api-v2` package breaks on Workers). `plans/x-gatekeeper.md` is the design record. X's API is
pay-per-use and bills every resource a read returns, so cost is part of the design and easy to undo
by accident:

- Every read goes through the gatekeeper's `#read`, which reserves against the connection's daily
  read limit (`X_DAILY_READ_LIMIT`, counted per UTC day in the `UserAccount` DO across all of the
  connection's bindings) and settles with what X returned. Listings use `XCursor`, one X request per
  `next()`, never the kit's `TokenCursor`, which refills a short page with up to ten more billed
  requests.
- Only bookmark, mute and hide are `autoApprovable`: X's developer policy forbids automating likes,
  follows, reposts and posts. Do not widen that list.
- A connection is pinned to the X user it was made as (a reconnect as anyone else is refused and its
  new grant revoked), and actions are fenced on that X user's ID rather than the connection
  generation, so a same-user reconnect to widen scopes does not strand pending actions.
- Observer checks make no billed X resource reads. Every read reports `[]` or, when private to the
  account or holding a post whose author's privacy X omitted, `user/<pinned X user ID>`.
  `verifyObserverAccess()` compares that ID with the observer account's stored pin; token refresh
  may still contact X. Public `[]` does not remove the Workshop's account/verifier-choice requirement.
  Do not add a billed probe of the bound post, List or author.
- Post/List `describe()` is visible without observation authorization. Return only the bound ID and
  canonical link, discard legacy cached descriptions, and never fetch snippets or List metadata
  there; private data belongs behind session read authorization.
- Action descriptions are also unguarded disclosures: redact private/unknown-author post text,
  author metadata and author-bearing URLs, including quoted/reposted posts and reply targets;
  redact provider-private List names even while a pending change would make the List public.
  Never redact what the workspace wrote (drafts, changes, its own pending posts and Lists).
- Sharing requirements follow data read from X, never actions or drafts the workspace wrote. New
  bindings carry immutable `redactsActionPreviews: true`. Older Post/List bindings remain
  same-pinned-user-only and export `user/<pinned X user ID>` (missing pins throw), because the
  Workshop's copy of their description and their action previews may hold private post/List
  details until the Workshop sanitizes them. Older Account and Profile bindings export only a
  recorded `observed:owner` read.
- Publishing is `claimBeforeApply`, and a send whose outcome X never reported is reconciled inline on
  the next apply (an attempt marker, then a look at the account's posts from around the attempt,
  binding only a unique match on text, links, media and reply parent), because the kit's
  `ActionOutcomeUnknownError` is terminal. Creating a List is reconciled the same way. Rejecting a
  publish or List creation withdraws it, and anything X already published stays.
- X is renaming "tweet" to "post" on the wire and both spellings occur; `x-normalize.ts` reads both.
  The configurators copy URL grammar from `x-urls.ts`, and `__tests__/configurator-url.test.ts` keeps
  the copies in step.
