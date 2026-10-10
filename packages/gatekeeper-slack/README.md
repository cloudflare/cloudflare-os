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

## Org-wide installations

Both workspace and org-wide installations use the connecting user's token; the bot token in an
org OAuth response is never used for reads. Org OAuth can return `team: null`, an `enterprise`
identity, and `is_enterprise_install: true`. Those describe the installation, not a resource's
workspace. In particular, an `E…` enterprise ID must never be used in a `/client/T…` workspace URL.

An org admin must also assign the app to the desired workspaces. Installing it at the org level
alone does not make every workspace available. The workspace picker intersects all pages of
`auth.teams.list` (the app's assignments) with `users.info.enterprise_user.teams` (the connecting
user's memberships). See Slack's [Enterprise development guide](https://docs.slack.dev/enterprise/developing-for-enterprise-orgs/)
and [auth.teams.list reference](https://docs.slack.dev/reference/methods/auth.teams.list/).

Each granted resource still selects exactly one workspace. Workspace and conversation pickers
retain its `T…` ID in the resource URL and Durable Object props. For thread URLs, workspace
installations verify the permalink host against their own workspace's metadata; only org
installations use the Enterprise-only `team.info(domain)` lookup, followed by membership checks.
The agent-facing session API is unchanged.

| API calls | Workspace selector |
| --- | --- |
| `users.conversations`, `users.list`, `search.messages` | `team_id` |
| `team.info` | `team` (not `team_id`) |
| Channel-addressed conversation calls | `client_context_team_id`, plus workspace membership verification |

Passing channel context is not itself an authority grant. Before reading a channel by ID, the
client verifies it belongs to the selected workspace, allowing shared channels linked to that
workspace. Responses without decisive membership metadata (including DMs) must appear in a
workspace-scoped conversation listing. Search matches undergo the same check. Direct user lookup
is limited to the workspace directory; author/mention resolution can still resolve participants
from other workspaces in shared channels.

Observer checks use each collaborator's own credentials and the selected workspace ID, never
enterprise-ID equality. Workspace bindings additionally track the conversations actually read,
excluding collaborators who cannot read newly observed private channels or DMs.

### Upgrading existing connections

Older credentials need not be reconnected solely to learn the installation kind: discovery can
recognize an org token through `auth.test`. Legacy bindings did not retain the workspace from their
URL. On first use, they recover a stored workspace ID, a thread's permalink workspace, or the sole
eligible workspace, then persist that selection separately from credentials. A subsequent reconnect
cannot silently switch a pinned binding to another workspace.

If a legacy org binding has several eligible workspaces and no recoverable selection, it fails
closed: add the resource again and choose its workspace. Old resource URLs containing an `E…` ID
also need to be replaced with a selected `T…` workspace URL.

Legacy conversation-only/thread-only grants may lack the metadata scopes listed below. Reconnect
or grant the resource again to approve the additional scopes; the reconnect flow preserves those
previous resource selections while requesting the new consent. Reads do not treat old scopes as
sufficient. Workspace grants already requested the required scopes.

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
- **Conversation**: `team:read`, conversation read scopes, `search:read`
- **Thread**: `team:read`, conversation read scopes
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
pnpm --filter @gadgets/slack-gatekeeper test:run
```

Node regression tests cover OAuth response shapes, workspace API parameters, shared-channel/DM
boundaries, legacy recovery, reconnects, observer exclusion, and configurator field dependencies.
Validate the Worker RPC schema with `pnpm exec capnweb-validate build --out .wrangler/validate`
from this package before a local Wrangler dry-run.
