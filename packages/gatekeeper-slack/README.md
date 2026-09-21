# Slack gatekeeper

Mediates a Gadget's **read-only** access to a user's [Slack](https://slack.com) workspace:
channels, direct messages, threads, members, and search. Runs as its own Cloudflare Worker and is
auto-discovered by the backend from its `GATEKEEPER_SLACK` binding.

This gatekeeper is read-only and never sends or modifies Slack data.

## Auth

OAuth 2.0 using a **user token** (`xoxp-…`), requested via `user_scope` (not a bot token) so the
agent sees exactly what the connecting user can see — including private channels, DMs, and search.

Create a Slack app (https://api.slack.com/apps) and provide its client credentials to the worker
as `CLIENT_ID` / `CLIENT_SECRET`. For local dev, `run-dev-server.ts` maps `SLACK_CLIENT_ID` /
`SLACK_CLIENT_SECRET` (e.g. from a root `.dev.vars`) into those vars.

App configuration:

- **Redirect URL** must match `<BASE_URL>/oauth`, which in local dev defaults to
  `http://localhost:8787/gatekeeper/slack/oauth`.
- Enable **token rotation** (OAuth & Permissions → *Token Rotation*). Tokens are then short-lived
  (~12h) and refreshed via `oauth.v2.access?grant_type=refresh_token`. Non-rotating tokens also
  work as a fallback (they're returned as-is).
- Request the **User Token Scopes** the granted resources need (see below). `users:read` is always
  requested for connected-account display and user-name resolution.

## Resources

Access is granted at one of three granularities. Each grantable resource maps to a URL pattern
that drives both consent (which OAuth scopes are requested) and routing:

| Granularity | URL pattern | Session type |
| --- | --- | --- |
| Whole workspace | `https://*` (catch-all whole-instance) | `SlackWorkspaceSession` |
| A conversation (channel, DM, or group DM) | `https://app.slack.com/client/:teamId/:conversationId` | `SlackConversation` |
| A thread | `https://*.slack.com/archives/:conversationId/:messageId` | `SlackThread` |

Workspace grants use the framework's account-wide `https://*` pattern; more-specific conversation
and thread URLs take precedence. Channels and DMs share one "Conversation" grant.

### Scopes per resource (user token scopes)

- **Workspace**: `team:read`, conversation read scopes, `search:read`
- **Conversation**: conversation read scopes, `search:read`
- **Thread**: `channels:history`, `groups:history`, `im:history`, `mpim:history`
- **Always**: `users:read`

where the conversation read scopes are `channels`/`groups`/`im`/`mpim` `:read` + `:history`.

## API

See `src/types.d.ts` for the full Session API (the agent-facing documentation). Highlights:

- `SlackWorkspaceSession`: `getInfo`, `listChannels`, `listDirectMessages`, `listUsers`,
  `getUser`, `getConversation`, `search`
- `SlackConversation`: `getInfo`, `members`, `listMessages`, `getThread`, `search`
  (conversation-scoped search is **hard-restricted** to the bound conversation regardless of query)
- `SlackThread`: `getRoot`, `listReplies`

List and search methods return paginated `Cursor` objects. Known mentions are rendered with readable
names.

## Build

```
pnpm exec vp run -F @gadgets/slack-gatekeeper build
```
