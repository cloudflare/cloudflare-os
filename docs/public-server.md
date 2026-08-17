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

# Required whenever CF_AI_GATEWAY is set (all inference goes over HTTPS with tokens):
CF_AI_GATEWAY_ACCOUNT_ID=...
CF_AI_GATEWAY_API_TOKEN=...

# To send Workers AI straight to its REST endpoint (no gateway, no cost logs):
CF_AI_GATEWAY_WAI_DIRECT=true
```

Gateway mode always requires `CF_AI_GATEWAY_ACCOUNT_ID` and `CF_AI_GATEWAY_API_TOKEN`; the token
needs AI Gateway Run and Read permissions so Gadgets can execute models and report their costs
(the Gateway may live in the Worker's own account or a different one). Workers AI defaults to the
same Gateway ID; set `CF_AI_GATEWAY_WAI` to route it through a different Gateway in the same
account, or `CF_AI_GATEWAY_WAI_DIRECT=true` to bypass gateways and call the Workers AI REST
endpoint directly (using the same account/token pair; such requests produce no cost logs).

When using `CF_AI_GATEWAY*` in local development, start the server with
`pnpm run dev-server -- --use-workers-ai-binding` so the webFetch tool's document-to-Markdown
conversion still has a `WORKERS_AI` binding. (Inference itself no longer uses the binding; it goes
over HTTPS with the tokens above.)

Each gatekeeper's OAuth app must be registered with that gatekeeper's redirect URI (replace the host
with `PUBLIC_BASE_URL`):

- GitHub: `${PUBLIC_BASE_URL}/gatekeeper/github/oauth`
- Google: `${PUBLIC_BASE_URL}/gatekeeper/google/oauth`
- Cloudflare: `${PUBLIC_BASE_URL}/gatekeeper/cloudflare/oauth`

See [docs/oauth-signin.md](oauth-signin.md) and [docs/ai-gateway-billing.md](ai-gateway-billing.md)
for the full list of options, the free-tier / top-up behavior, and the storage bindings involved.
