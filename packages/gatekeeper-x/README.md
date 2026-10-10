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
| X Post | `https://x.com/<user>/status/<id>` | One post and its conversation: read, reply, like, repost, bookmark, hide replies. |
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

## Push notifications

Gadgets can hear of posts as they happen: `XAccountSession.subscribeMentions()` and
`subscribeReplies()`, `XPost.subscribeReplies()` for one of the account's own posts, and
`XProfile.subscribePosts()` / `XUser.subscribePosts()` for a user's new posts. X delivers them
through the X Activity API to one webhook per deployment, `{WEBHOOK_ORIGIN}/gatekeeper/x/webhook`.

They are off until the deployment sets both of these on the worker, outside the deploy wizard:

- `WEBHOOK_ORIGIN`: the deployment's public https origin, with no port (X refuses ports). Behind
  Cloudflare Access, add a bypass for `/gatekeeper/x/webhook`, which X calls directly; every
  delivery is verified against the app's client secret.
- `X_APP_BEARER_TOKEN` (a secret): the X app's app-only bearer token, from the Developer Console's
  "Keys and tokens". X's webhook endpoints take only that token, and it subscribes to watched users'
  public posts.

Until both are set, `subscribe*()` refuses with "Push notifications aren't set up on this
deployment." In development, `pnpm dev-server` passes both through from the shell or the root
`.dev.vars`; point `WEBHOOK_ORIGIN` at a tunnel to the dev server.

Costs and limits to know:

- **X bills every delivered post as a post read**, whether or not a gadget acts on it, and the
  connection's daily read limit cannot stop it. Disabling a hook, or disconnecting the account, ends
  the subscription once no other hook needs it.
- Subscriptions are per X user and event type, so a connection costs at most two (mentions and
  replies), plus one per watched user, however many hooks share them. X's self-serve tier allows
  1,500 per app.
- X never delivers protected accounts' posts, and reports only *direct* replies to the account's
  own posts.
- A delivery X makes while this deployment is unreachable is lost: the gatekeeper does not yet ask
  X to replay what it missed (`POST /2/webhooks/replay`).

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

A collaborator can observe a workspace that reads X only with an X connection of their own (and,
for a Post or List binding, one that can see the bound post or List). What the account reads that
is private to it -- bookmarks, likes, mutes, private Lists, and posts by protected accounts -- is
shown only to collaborators connected as the same X user. See `docs/observers.md`.

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

### "X never confirmed whether this post was published, so it may already be on X and can't be rejected."

An approval sent the post, and X's answer was lost. Approve it again: the gatekeeper first checks the
account's recent posts and records the post if it landed, so it is never posted twice. Revert it
afterwards if it shouldn't stay.

### "Push notifications aren't set up on this deployment."

The worker lacks `WEBHOOK_ORIGIN` or `X_APP_BEARER_TOKEN`; see [Push notifications](#push-notifications).
A `WEBHOOK_ORIGIN` that isn't a bare https origin without a port is refused when a hook subscribes.

### The callback URI does not match

X compares the callback exactly. It must be the deployment's `{PUBLIC_BASE_URL}/gatekeeper/x/oauth`,
with the same scheme, host and port the gatekeeper's `BASE_URL` uses.
