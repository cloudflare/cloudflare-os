# Running Gadgets as a public, multi-user service

By default the Workshop uses built-in username/password accounts (or Cloudflare Access) and gives
every user unlimited AI usage — ideal for self-hosting. It can optionally run as a public,
multi-user service instead: users sign in with Google, GitHub, or Cloudflare, every account gets a
free daily allowance of AI usage, and once that runs out they connect their own Cloudflare account
and top up credits in the Cloudflare dashboard (their account is then billed for further usage).

Sign-in is provided by **authentication gatekeepers**: each auth-capable gatekeeper (Google, GitHub,
Cloudflare) uses its single OAuth app both to authenticate the user (by verified email) and to
connect the account's capabilities. There's no single switch — the pieces turn on independently:

| Configure | Effect |
| --- | --- |
| `AUTH_GATEKEEPERS=cloudflare,google,github` | Allowlists which connected gatekeepers may be used to sign in. Each shows a "Continue with …" button alongside username/password. |
| Each gatekeeper's OAuth credentials (on the gatekeeper Worker) | Required for that gatekeeper to actually authenticate. In dev, seeded from `GOOGLE_*` / `GITHUB_*` / `CLOUDFLARE_OAUTH_*` shell vars (see `run-dev-server.ts`). |
| `ENABLE_CLOUDFLARE_LIMITS=true` | Enables the free daily limit + Cloudflare-credits top-up flow. Billing reads a token from the connected Cloudflare gatekeeper. |
| `DISABLE_PASSWORD_AUTH=true` | Hides username/password, leaving gatekeeper sign-in only (ignored unless `AUTH_GATEKEEPERS` is non-empty, to avoid lockout). |

The primary account key is always the user's **verified email**: signing in with any allowlisted
gatekeeper that yields the same verified email maps to the same account.

For local development, set the required variables in a root `.dev.vars` file (gitignored,
`KEY=VALUE` per line); `pnpm run dev-server` loads it automatically. A minimal example:

```
ENABLE_CLOUDFLARE_LIMITS=true
PUBLIC_BASE_URL=http://localhost:8787
AUTH_GATEKEEPERS=cloudflare,google,github

# Each gatekeeper's OAuth app (client id/secret). In dev these seed the gatekeeper Workers:
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
CLOUDFLARE_OAUTH_CLIENT_ID=...
CLOUDFLARE_OAUTH_CLIENT_SECRET=...

# Platform AI Gateway used for the free tier:
CF_AI_GATEWAY=your-gateway
CF_AI_GATEWAY_PROVIDERS=anthropic,openai,google

# Required whenever CF_AI_GATEWAY is set:
CF_AI_GATEWAY_ACCOUNT_ID=...
# Required unless the WORKERS_AI binding carries gateway traffic (see below); always required
# for the google provider:
CF_AI_GATEWAY_API_TOKEN=...
```

Gateway mode always requires `CF_AI_GATEWAY_ACCOUNT_ID`, plus a transport for gateway requests.
When the `WORKERS_AI` binding is present, the binding is that transport by default: its requests
are pre-authenticated in-account, so inference and cost-log reads need no API token. This is only
valid when the Gateway lives in the Worker's **own** account — binding requests can't reach
another account's Gateway, and the Worker cannot verify where the Gateway lives at runtime — so
deployments whose Gateway is in a different account must set `CF_AI_GATEWAY_USE_BINDING=false` to
opt out and route over HTTPS instead. Keep `WORKERS_AI` bound when you do: it is also what the
webFetch tool's document-to-Markdown conversion runs on, so unbinding it opts out of far more than
the gateway transport. Without the binding transport, set
`CF_AI_GATEWAY_API_TOKEN` — a token with AI Gateway Run and Read permissions so Gadgets can
execute models and report their costs (over HTTPS the Gateway may live in the Worker's own
account or a different one). The token stays required for the `google` provider regardless of the
binding (the model SDK adapter refuses the binding's fetch — note the platform config above enables
it, so the platform server itself still needs the token). Every provider, Workers AI included,
routes through the same Gateway.

When using `CF_AI_GATEWAY*` in local development, start the server with
`pnpm run dev-server -- --use-workers-ai-binding` so the server has a `WORKERS_AI` binding for
the webFetch tool's document-to-Markdown conversion and for the gateway transport above (without
it, gateway traffic falls back to HTTPS with `CF_AI_GATEWAY_API_TOKEN`). If your dev Gateway
lives in a different account than the binding, also set `CF_AI_GATEWAY_USE_BINDING=false` — keep
`--use-workers-ai-binding` on, since the Markdown conversion still needs the binding.

Each gatekeeper's OAuth app must be registered with that gatekeeper's redirect URI (replace the host
with `PUBLIC_BASE_URL`):

- GitHub: `${PUBLIC_BASE_URL}/gatekeeper/github/oauth`
- Google: `${PUBLIC_BASE_URL}/gatekeeper/google/oauth`
- Cloudflare: `${PUBLIC_BASE_URL}/gatekeeper/cloudflare/oauth`

See [docs/oauth-signin.md](oauth-signin.md) and [docs/ai-gateway-billing.md](ai-gateway-billing.md)
for the full list of options, the free-tier / top-up behavior, and the storage bindings involved.
