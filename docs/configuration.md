# Deployment configuration

Environment variables for a FieldOS deployment, and which are safe to leave unset.

Two rules explain most of the layout:

- **Authentication and authorization settings are env-driven, never admin-editable.** They must not
  be weakenable from a compromised admin session. Everything "soft" — branding, agent instructions,
  which connectors are offered — lives in `AdminConfig` and is edited from the admin panel instead.
- **Session bounds are the one bridge between the two.** The env vars set a *ceiling*; an admin may
  tighten below it and can never exceed it.

## Identity and access

| Variable | Default | Meaning |
|---|---|---|
| `ADMINS` | none | Array of usernames with admin rights. An admin with no entry here has none. |
| `AUTH_GATEKEEPERS` | unset | Comma-separated vendor ids offered as sign-in buttons, e.g. `oidc`. Only vendors advertising `providesAuth` are eligible. Unset means password login only. |
| `DISABLE_PASSWORD_AUTH` | `false` | `"true"` hides username/password login. Ignored unless at least one auth gatekeeper is allowlisted, so a deployment cannot lock everyone out. |

### Single sign-on (`gatekeeper-oidc`)

Set on the connector, not the backend. See
[`packages/gatekeeper-oidc/README.md`](../packages/gatekeeper-oidc/README.md).

| Variable | Required | Meaning |
|---|---|---|
| `OIDC_ISSUER` | yes | Issuer base URL, no trailing slash. Endpoints come from its discovery document. |
| `OIDC_CLIENT_ID` | yes | Confidential client registered for this deployment. |
| `OIDC_CLIENT_SECRET` | yes | That client's secret. |
| `OIDC_SCOPES` | no | Extra scopes; `openid` and `email` are always requested. |

Add `oidc` to `AUTH_GATEKEEPERS` to surface the button. The provider must issue a **verified**
email — sign-in is refused when `email_verified` is not `true`, because accounts are keyed by email.

### Cloudflare Access

Only relevant when running behind Cloudflare Access. An airgapped deployment leaves both unset and
uses password login or OIDC.

| Variable | Meaning |
|---|---|
| `CF_ACCESS_AUD` | Application audience tag. Setting it enables Access authentication. |
| `CF_ACCESS_ISS` | Team domain; its JWKS verifies the assertion. |

Note this path carries **no session record** — authority is the per-request JWT, and its lifetime
belongs to the identity provider, so the session bounds below do not apply to it.

## Sessions

| Variable | Default | Meaning |
|---|---|---|
| `SESSION_MAX_LIFETIME_HOURS` | `12` | Ceiling on absolute session lifetime, from sign-in. Never extended by activity. |
| `SESSION_MAX_IDLE_MINUTES` | `60` | Ceiling on the idle window, refreshed by user-driven activity. |

Both are **ceilings**. An admin may configure shorter values; anything longer is clamped, and
lowering a ceiling tightens existing deployments immediately without rewriting stored config. A
non-positive or unparseable value falls back to the default — `0` never means "no expiry".

Defaults suit a classified-network deployment, where accreditation regimes generally expect idle
timeouts in the tens of minutes and re-authentication at least daily. Raise them for a
lower-sensitivity deployment; the ceiling exists so the decision is an operator's, not an admin's.

Where an external IdP issues the session, its expiry wins when shorter, but is still clamped to
these ceilings — a permissive IdP cannot mint an effectively immortal session.

## Usage limits

Two independent modes. `ENABLE_CLOUDFLARE_LIMITS` is the upstream billing flow and is irrelevant
off-platform; `ENABLE_USAGE_QUOTAS` is the airgapped equivalent with no money involved.

| Variable | Default | Meaning |
|---|---|---|
| `ENABLE_USAGE_QUOTAS` | `false` | `"true"` enforces a per-user daily call cap with no billing: no balance lookup, no BYOK, no top-up UI. Ignored when `ENABLE_CLOUDFLARE_LIMITS` is on. |
| `DAILY_LLM_CALL_LIMIT` | `100` | Calls per user per UTC day. |
| `ENABLE_CLOUDFLARE_LIMITS` | `false` | Upstream free-tier + Cloudflare AI Gateway top-up flow. Leave unset off-platform. |
| `MINIMUM_CLOUDFLARE_BALANCE` | — | Only meaningful with the above. |

Typical airgapped setting: `ENABLE_USAGE_QUOTAS=true`, `DAILY_LLM_CALL_LIMIT=250`, leaving
`ENABLE_CLOUDFLARE_LIMITS` unset.

The limit is currently one global number. Per-user or per-role limits would be an `AdminConfig`
change.

## Model inference

Not env-driven: models are configured per user or per deployment as records carrying a provider and
an optional `apiUrl`. For a local endpoint use the `ollama` provider — which defaults to
`http://localhost:11434` and sends no `Authorization` header when no key is set — pointed at any
OpenAI-compatible server (vLLM, TGI, Ollama). No code changes are needed for local inference.

`CF_AI_GATEWAY*` routes inference through Cloudflare AI Gateway and is opt-in; leave unset. When
unset, providers are reached directly and the gateway code path is skipped entirely.

## Storage and platform bindings

| Binding | Purpose | Self-hosted substitute |
|---|---|---|
| `BLUEPRINTS`, `AVATARS` | KV: blueprint metadata, avatar images | Any KV store; volumes are small |
| `BLUEPRINT_CONTENT` | R2: blueprint archives and screenshots | MinIO or any S3-compatible store — R2's API is S3-compatible |
| `LOADER` | Worker Loader: **the gadget sandbox** | Native to workerd; requires the `--experimental` CLI flag |
| `BROWSER` | Browser Rendering, for gadget PDF export | Optional — both call sites degrade with a clear error. Self-hosted Chrome later |
| `WORKERS_AI` | HTML→Markdown for the `webFetch` tool only — **not** inference | Any local Markdown converter; `webFetch` is near-moot on an isolated network |
| `PRODUCT_ANALYTICS` | Optional analytics pipeline | No-ops when unbound |
| `PUBLIC_BASE_URL` | The deployment's public origin | — |

## Observability

| Binding | Behaviour when unbound |
|---|---|
| `FRONTEND_ERROR_REPORTER` | The `/api/client-errors` endpoint becomes a no-op |
| `FRONTEND_ERROR_RATE_LIMITER` | Same; both must be bound for reporting to dispatch |
| `ERROR_REPORTER` | `reportIssue()` no-ops. Not declared in any checked-in config |

All logging is plain `console.*`, so under standalone workerd it goes to stdout — tail it with a
log shipper. There is no OTLP exporter; traces are Cloudflare-specific and unavailable off-platform.

## Known gaps

- **No admin UI for session bounds yet.** The `AdminConfig` fields exist and resolve correctly; the
  dashboard controls arrive with the wider admin panel work. Env vars work today.
- **Admin revocation targets a named user.** There is no user directory — user objects are
  addressed by name — so "revoke every session globally" is not implementable without building one.
  Worth stating to an accreditation reviewer as a scope boundary.
