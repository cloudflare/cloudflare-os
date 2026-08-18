# AI Gateway billing

An optional flow that gives each user a **free daily allowance** of AI usage and, once that runs
out, bills further usage to the user's **own Cloudflare AI Gateway credits**. Off by default
(`ENABLE_CLOUDFLARE_LIMITS` unset) — usage is then unlimited, as for self-hosted deployments.

## How it works

Each user gets a free allowance of LLM calls per UTC day (default 100), counted on the user's own
`UserDurableObject` (`consumeDailyLlmCall` / `checkDailyLlmCount`). Before each user-initiated agent
turn, the overseer calls `checkUsageAndBalance`:

- **Connected, balance ≥ `$2`** → allowed, routed through the user's own account so usage bills
  their Cloudflare credits — even while free-tier allowance remains. The platform is never charged
  for funded users, and their daily free-tier counter is left untouched.
- **Otherwise, within the free tier** → allowed, served via the platform's configured AI Gateway
  (all providers, Workers AI included). This includes connected users whose balance is below `$2`
  (incl. $0).
- **Free tier exhausted, no Cloudflare account connected** → blocked, with a prompt to connect.
- **Free tier exhausted, connected but balance below `$2`** → blocked, with a prompt to add credits.

The balance shown to users is read live from their Cloudflare AI Gateway billing
(`/ai-gateway-billing/credit_balance`), cached for 5 minutes. Topping up means adding credits in the
[Cloudflare dashboard](https://dash.cloudflare.com/?to=/:account/ai/ai-gateway) — the platform never
holds money.

## Connecting Cloudflare

Billing is tied to the **Cloudflare gatekeeper**: the OAuth tokens live in that gatekeeper's
connection, and the billing flow obtains a usable token from it via `getUsableAccessToken()`. A user
connects Cloudflare either by signing in with it, or — if they signed in another way — via the
"Connect Cloudflare" button, which runs the normal gatekeeper connect flow
(`AuthenticatedApi.connectAccount("cloudflare")`). See [sign-in](./oauth-signin.md) for the OAuth
mechanics and redirect URIs.

The account to bill is auto-selected when the grant sees exactly one account; with several, the user
is prompted to choose one. Billing is account-level (Unified Billing): inference is routed through
the account's auto-created "default" AI Gateway.

## Configuration

```
ENABLE_CLOUDFLARE_LIMITS=true
PUBLIC_BASE_URL=https://your-host
AUTH_GATEKEEPERS=cloudflare       # allow Cloudflare sign-in/connect (plus any others)

# The Cloudflare gatekeeper's OAuth app (client id/secret live on the gatekeeper Worker; in dev
# they're seeded from these shell vars by run-dev-server.ts):
CLOUDFLARE_OAUTH_CLIENT_ID=...
CLOUDFLARE_OAUTH_CLIENT_SECRET=...

# Platform AI Gateway used for the free tier (see existing AI Gateway docs):
CF_AI_GATEWAY=your-gateway
CF_AI_GATEWAY_PROVIDERS=anthropic,openai,google

# Required whenever CF_AI_GATEWAY is set:
CF_AI_GATEWAY_ACCOUNT_ID=...
# Required unless the WORKERS_AI binding carries gateway traffic; always required for the
# google provider:
CF_AI_GATEWAY_API_TOKEN=...
```

Gateway mode always requires `CF_AI_GATEWAY_ACCOUNT_ID` plus a transport: the `WORKERS_AI`
binding when present (binding requests are pre-authenticated, and cost-log reads work through
the binding too), or otherwise an API token with AI Gateway Run and Read permissions — Read
access lets Gadgets retrieve each log's cost for user-visible accounting. The binding transport
only works when the Gateway lives in the Worker's own account, which the Worker can't verify at
runtime — a deployment whose Gateway is in a different account must set
`CF_AI_GATEWAY_USE_BINDING=false` to opt out and use the token transport. That is a flag rather
than an unbinding because `WORKERS_AI` also backs the webFetch tool's document-to-Markdown
conversion (and is hardcoded for every released backend), so removing it would break that instead
of just moving gateway traffic. The token stays required for the `google` provider even when the
binding transport applies. Every provider, Workers AI included, routes through the same Gateway.

The Cloudflare dashboard OAuth endpoints and scopes are **hardcoded** in the Cloudflare gatekeeper
(`packages/gatekeeper-cloudflare/src/oauth.ts`):

- auth: `https://dash.cloudflare.com/oauth2/auth`
- token: `https://dash.cloudflare.com/oauth2/token`
- scopes: `offline_access aig.read aig.run aig.write user-details.read account-settings.read`

Cloudflare gatekeeper redirect URI: `${PUBLIC_BASE_URL}/gatekeeper/cloudflare/oauth`.

Optional (all have sensible defaults):

```
DAILY_LLM_CALL_LIMIT=100        # free-tier LLM calls per user per UTC day
MINIMUM_CLOUDFLARE_BALANCE=2    # min connected-account balance (USD) to proceed via BYOK
```

## Storage / bindings

The free-tier daily LLM-call counter lives on each `UserDurableObject` (no separate binding).

The OAuth tokens live in the connected Cloudflare *gatekeeper* account. Each `UserDurableObject`
stores only lightweight billing state (the selected account id + a cached credit balance, plus the
daily counter) — no tokens.

## Code layout

Server code lives under `packages/workshop-backend/src/ai-gateway-billing/`:

```
ai-gateway-billing/
├── config.ts                     # ENABLE_CLOUDFLARE_LIMITS / minimum-balance readers
├── limits/
│   ├── config.ts                 # daily-limit + calendar-day helpers + DailyQuotaResult
│   └── usage-checker.ts          # checkUsageAndBalance / getUsageInfo (counter lives on UserDurableObject)
└── cloudflare/
    ├── account-service.ts        # CF REST: accounts / balance
    └── connection-service.ts     # token (from CF gatekeeper), account selection, balance cache, BYOK routing
```

Client-side: `ServerConfigContext` exposes `cloudflareLimitsEnabled`; `components/billing/`
(`UsageSettings`, `OutOfCreditsModal`, `AccountSelectionModal`) renders the usage / top-up /
account-selection UI.
