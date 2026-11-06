# Gatekeeper X

Connects X (formerly Twitter) accounts to Gadgets. A gadget can read an account's timelines,
mentions, search, bookmarks and likes, and draft posts, threads, replies, likes, reposts, follows,
mutes and List changes. Nothing reaches X until a user approves it; every draft is shown to the
gadget as if it had already happened, so a gadget keeps working while it waits. See
`plans/x-gatekeeper.md` for the design record.

Four resource types, each its own grant:

| Resource | Link | What it reaches |
|---|---|---|
| X Account | `https://x.com/settings/account` | The whole account. |
| X Post | `https://x.com/<user>/status/<id>` | One post and its conversation: read, like, repost, bookmark; reply where X allows it (to the account's own posts, or posts that mention or quote it); hide replies in conversations the account started. |
| X List | `https://x.com/i/lists/<id>` | One List's posts and members; its details and members, if the account owns it. |
| X Profile | `https://x.com/<user>` | One user's public profile and posts. Read-only. |

The account resource's link names no user, so a blueprint that binds it binds whichever account
re-resolves it.

## What it costs

X's API is pay-per-use, billed to the X app's prepaid credits: the deployment pays for every user's
reads and posts. As of October 2026:

| Request | Price |
|---|---|
| A post read | $0.005 |
| A user read (a profile, or a post's author) | $0.010 |
| A post created | $0.015 |
| A post containing a link | $0.20 |

X bills each resource once per UTC day, however often it is read. For example, a daily digest of
200 posts costs $1-3 a day depending on how many distinct authors it shows, and a single post with a
link costs $0.20, which approval descriptions point out.

Two limits keep a gadget from running up the bill:

- **A daily read limit per connection**, set by the deployment's `X_DAILY_READ_LIMIT` var: the
  billable resources one connection may read per UTC day, across every binding and gadget using it.
  The default is 2,000 (about $10 a day at the post-read price); `0` removes the limit. Reads past
  it fail with a message naming when it resets.
- **Approvals** bound writes: nothing is posted, liked or followed without a user approving it.
  Bookmarks, mutes and hidden replies are billed too, and the daily read limit does not cover
  them: once a user auto-approves one of those kinds, only X's per-account rate limit and the
  app's spending limit bound it.

Reads are cached briefly (a post for 5 minutes, a profile for an hour, a listing's first page for a
minute), so a gadget polling one page pays at most once a minute.

## Setting up an X app

1. In the [X Developer Console](https://console.x.com), create a Project and an App.
2. Under **User authentication settings**, enable OAuth 2.0 with the type **Web App, Automated App
   or Bot** and the permission **Read and write**.
3. Set the **Callback URI** to `{PUBLIC_BASE_URL}/gatekeeper/x/oauth`, and give the app a website
   URL.
4. Buy credits, and set a spending limit.
5. Copy the **OAuth 2.0 Client ID** and **Client Secret** (not the API key and secret, which are for
   OAuth 1.0a) into the deployment's `CLIENT_ID` and `CLIENT_SECRET`.

### Local development

Export `X_CLIENT_ID` and `X_CLIENT_SECRET` in your shell or the root `.dev.vars`; `pnpm dev-server`
maps them into the worker's `CLIENT_ID` and `CLIENT_SECRET`, and passes `X_DAILY_READ_LIMIT`
through when it is set.

Register `http://localhost:8787/gatekeeper/x/oauth` as a callback. If the console refuses
`localhost`, register `http://127.0.0.1:8787/gatekeeper/x/oauth` instead and start the dev server
with `VITE_BACKEND_HOST=127.0.0.1:8787`, so the callback the gatekeeper sends matches.

## Obligations that come with an X app

X's developer agreement puts these on the app's owner, not on Gadgets:

- **AI-generated replies need X's prior approval.** An app that replies to posts with AI-generated
  content must be approved by X before it does. Replies drafted by agents are sent only after a user
  approves each one, but X still counts them as the app's.
- **Automated accounts must say so.** An account run by an agent must carry X's "Automated" label,
  set in the account's settings.
- **Likes, follows, reposts and posts must be the user's own.** X forbids automating them. That is
  why only bookmarks, mutes and hiding replies can be auto-approved: they are private to the account
  or reversible moderation. Everything else waits for a user to approve it.

## Sharing a workspace

Public reads -- public posts, profiles, public Lists, and an unprotected account's followers and
following -- report `[]`, so the X gatekeeper adds no provider-access restriction to them. The
Workshop still requires collaborators to choose an X account/verifier for an in-scope binding;
this does **not** enable account-free workspace admission. New bindings make no extra credential
or bound-post/List visibility probe in `addObserver()`.

What the account reads that is private to it -- bookmarks, likes, mutes, private Lists, a protected
account's follow graph and home timeline, and any page containing a protected author's post **or
a post whose author's privacy X did not report** -- reports `user/<id>`, the numeric ID of the X user
the connection is pinned to. Only collaborators connected as that same X user can observe it. The
identity comparison makes no billed resource read; refreshing expired credentials may contact X.
See `docs/observers.md`.

Post and List connection cards show only the resource's ID and link, never post text, List names or
member counts. These descriptions can be seen without read authorization, so private details are
returned only by session reads subject to the checks above. Describing these bindings makes no
billed request to X, and discards the description an older binding cached in the gatekeeper. The
Workshop's own copy of that older description, taken when the binding was made, is not refreshed:
it can still name a protected author or a private List.

Action previews are visible outside read authorization too. Provider-private or unknown-author
post text and author metadata are redacted, including reply targets and posts quoting or reposting
protected authors; provider-private List names are replaced by IDs, even while a pending change
would make the List public. What the workspace wrote -- drafts, changes, and the account's own
pending posts and Lists -- stays visible for approval. Definitely public provider context can
still be shown.

Sharing requirements follow data read from X, never data the workspace wrote, so no action or
draft adds one. **Post and List bindings made before this change are same-X-account-only**, even
for public reads: the Workshop's copy of their description and their action previews may hold what
X returned about a private post or List, which only the Workshop can sanitize. Their history export
is `user/<id>` until it does. This replaces the bound-post/List visibility probe that admitted
anyone who could see it. Older Account and Profile bindings keep only their recorded legacy private
reads (`observed:owner`). `addObserver()` checks those reads, and legacy Post/List bindings, against
the collaborator's stored X identity, which fails if their connection has expired; otherwise it
makes no credential or visibility check. Newly minted bindings carry immutable
`redactsActionPreviews: true` props.
A legacy Post or List binding without a stored pinned identity fails closed.

## Troubleshooting

### "The X connection has expired or was revoked. Reconnect the X account."

X refused the connection's refresh token: the user revoked the app in X's settings, the app's
credentials changed, or the refresh token was used twice. Reconnect the account from the Workshop's
Connections page.

### "That's a different X account"

The reconnect was authorized by another X user than the one the connection was made for. A
connection stays pinned to its X user; sign in to X as that user and reconnect, or connect the other
account separately.

### "This X connection has used today's 2,000 reads; the limit resets at 00:00 UTC."

The connection reached the deployment's daily read limit. Wait for the reset, or raise
`X_DAILY_READ_LIMIT`.

### "The X API credits for this deployment are used up, or its spending limit was reached."

The X app's prepaid credits ran out, or its spending limit was hit. Add credits or raise the limit in
the X Developer Console.

### "X's rate limit for this request is used up for this account."

X limits each endpoint per account per 15 minutes; the message names when the window resets. The
gatekeeper never retries on its own.

### "X did not confirm whether this post was published."

An approval sent the post, and X's answer was lost. Approve it again: the gatekeeper first checks the
account's recent posts and records the post if it landed, so it is never posted twice. Revert it
afterwards if it shouldn't stay. Rejecting it instead withdraws the request, but a post X already
made stays on the account.

### The callback URI does not match

X compares the callback exactly. It must be the deployment's `{PUBLIC_BASE_URL}/gatekeeper/x/oauth`,
with the same scheme, host and port the gatekeeper's `BASE_URL` uses.
