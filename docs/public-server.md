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

Which models the Gateway offers is not an environment setting: a deployment admin manages it on the
**Models** tab of `/admin`. The tab lists the catalog this version ships (`SUGGESTED_MODELS` in
`packages/workshop-shared/src/api.ts`) for the providers in `CF_AI_GATEWAY_PROVIDERS`, plus the
models the deployment added, and gives each model one of three modes:

| Mode | Model pickers | Chats and gadget model bindings that already use the model |
| --- | --- | --- |
| **Enabled** | Offered. | Work. |
| **Hidden** | Not offered. | Keep working. |
| **Disabled** | Not offered. | Stop working. |

A chat on a disabled model fails to send, start or retry with `The "<name>" model is disabled on
this deployment by an administrator.`, which the chat shows with the failure, and a gadget model
binding made for the model fails with the same error at its next call. A chat that an external
message continues does not fail: it moves to the user's preferred model if that is offered, and
otherwise to the first model offered. Disabling revokes nothing that is stored, so chats and
bindings work again once the model is enabled or hidden. A disabled model's ID stays reserved: a
user can't add a model of their own under it.

Each model starts in its default mode, which the tab marks `(default)`: the catalog's for a catalog
model (**Hidden** for the ones a newer model supersedes, otherwise **Enabled**) and **Enabled** for
an added one. Only a mode that differs from the default is stored, and the tab marks that model
`Changed`. A model left on its default therefore follows the catalog when the deployment is
upgraded, and choosing the default option again drops the override.

**Add a model**, under **Added by this deployment**, provides a model the catalog doesn't list. It
takes a provider (one in `CF_AI_GATEWAY_PROVIDERS` that AI Gateway serves: `anthropic`, `openai`,
`google` or `cloudflare`), the model ID as the provider's API names it, a display name, the context
window in tokens, and optionally an output limit — both the response cap and the space reserved
for it in the window (Workers AI models default to 32768). The ID and the name may each be up to
200 characters, and the ID must be one that neither the catalog, under any provider, nor another
added model has. An added model starts **Enabled**, takes the three modes like a catalog model, and
is listed in pickers after its provider's catalog models. Users can't edit or delete a model the
deployment provides, in any mode. **Remove** takes an added model out again, along with its mode,
and a chat that names it then fails with `No such model: <id>` until a model is added under that ID
again; a catalog model can't be removed, only hidden or disabled. An added model whose provider
leaves `CF_AI_GATEWAY_PROVIDERS` is neither offered nor listed on the tab, but it stays stored and
keeps its ID, and it returns when the provider does.

This applies in AI Gateway mode only. Without `CF_AI_GATEWAY` each user adds their own models on
their **Providers** page, and the tab holds a notice saying so; it holds the same notice when the
gateway's environment settings are invalid. The Gateway's transport, its credentials and
`CF_AI_GATEWAY_PROVIDERS` stay environment settings.

The modes decide what the deployment offers, and have limits:

- **Disabled alone is not a spend control.** A user can still add a model of their own from one of
  the Gateway's providers, under any ID the deployment's models don't have, and it runs through the
  deployment's Gateway as the deployment's own models do.
- **Disabling does not interrupt a turn in progress.** A model is checked when a turn starts and
  when a gadget's model binding is called, so an agent turn already running on the model finishes
  on it.
- **Removing a model does not shut it off.** It frees the model's ID, and a gadget model binding
  made for the model carries its own provider and model name, so it runs again once the model is
  removed, even if the model was disabled. To shut a model off, disable it and leave it in place.
- **A change is not instant everywhere.** Chats and gadgets read a mirrored copy of the admin
  settings, so a change can take a short time to reach every location.
- **The title model is outside the modes.** Titles are generated by a fixed Workers AI model that no
  mode applies to.

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
