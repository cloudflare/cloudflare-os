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

### Frontend asset variant — a build-time choice, not a setting

`VITE_CF_ACCESS_MODE` is compiled into the frontend bundle, so it **cannot be changed at deploy
time**. Every release therefore ships two asset variants and a deployment selects one:

| Variant | For | |
|---|---|---|
| `password` | **Self-hosted and airgapped deployments** | Renders the password login and `/signup`. |
| `access` | Deployments behind Cloudflare Access | Delegates auth to Access; no login page of its own. |

**An airgapped deployment must use `password`.** With the `access` variant and no Cloudflare in
front, the app calls `authenticateFromCfAccess()`, which throws because `CF_ACCESS_AUD` is unset —
so the page renders "Authenticating…" forever and `/signup` redirects away, leaving no way to
create a first user. It looks like a hang rather than a misconfiguration, which is what makes it
worth stating plainly.

The variants are content-addressed and share whatever bytes are identical, so carrying both costs
far less than double.

### Single sign-on (`gatekeeper-oidc`)

Set on the connector, not the backend. See
[`packages/gatekeeper-oidc/README.md`](../packages/gatekeeper-oidc/README.md).

| Variable | Required | Meaning |
|---|---|---|
| `OIDC_ISSUER` | yes | Issuer base URL, no trailing slash. Endpoints come from its discovery document. |
| `OIDC_CLIENT_ID` | yes | Confidential client registered for this deployment. |
| `OIDC_CLIENT_SECRET` | yes | That client's secret. |
| `OIDC_SCOPES` | no | Extra scopes; `openid` and `email` are always requested. |
| `OIDC_GROUPS_CLAIM` | no | Claim to read group membership from, for org separation. There is no standard name, so this is configuration rather than a constant. Unset means this deployment does not use org separation at all. |
| `OIDC_ORG_PREFIX` | no | Optional prefix marking which groups are orgs, e.g. with `fieldos-` set, the group `fieldos-legal` yields org `legal`. Users are typically in many groups unrelated to FieldOS, so most deployments that set `OIDC_GROUPS_CLAIM` will want this too. |

Add `oidc` to `AUTH_GATEKEEPERS` to surface the button. The provider must issue a **verified**
email — sign-in is refused when `email_verified` is not `true`, because accounts are keyed by email.

#### Org resolution

Org separation is off unless `OIDC_GROUPS_CLAIM` is set. When it is set, a missing or ambiguous
claim resolves to **no org, never a default org** — a user is either placed in exactly one org or
placed in none; there is no fallback org that soaks up the unresolved cases. Concretely:

- If the claim is absent, empty, or not a string/array, the user has no org.
- If more than one group matches (after applying `OIDC_ORG_PREFIX`), the user has no org. Picking
  one of several matches would make access depend on the IdP's serialization order for the claim,
  which is not something to build authorization on.

**Microsoft Entra: this is a hard requirement, not a tip.** Above 200 groups (JWT tokens) or 150
groups (SAML), Entra omits the groups claim entirely and substitutes a pointer to Microsoft Graph
for the full list — which an airgapped deployment cannot reach. A user in 250 groups then looks
identical to a user in zero groups: no claim, no org. **Entra deployments must be configured to
emit only the groups assigned to the application** (via the app registration's group claims
configuration), not the user's full group membership, or affected users will silently lose org
access.

Keycloak emits group membership as paths (a leading `/`, e.g. `/fieldos-legal`); the connector
strips the leading slash before matching, so `OIDC_ORG_PREFIX` does not need to account for it.

Where the groups claim comes from, per provider:

- **Keycloak**: not included by default — add a "Group Membership" mapper to the client's client
  scope, and use the path (with or without leading slash) as the group name.
- **Okta**: add a Groups claim to the authorization server's claims, filtered to the groups you
  want visible to this application.
- **Authentik**: group names are available via a scope mapping that includes `groups` in the token.
- **Entra**: configure the app registration's optional claims / group claims to emit only
  application-assigned groups — see the hard requirement above.

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
| `BLUEPRINTS`, `AVATARS`, `CONTEXT_COLLECTIONS` | KV: blueprint metadata, avatar images, context collections | `packages/fieldos-runtime` — workerd ships the binding's client half only |
| `BLUEPRINT_CONTENT` | R2: blueprint archives and screenshots | `packages/fieldos-runtime`. **Not MinIO** — see below |
| `LOADER` | Worker Loader: **the gadget sandbox** | Native to workerd; requires the `--experimental` CLI flag |
| `ASSETS` (on `router`) | The frontend single-page app | `packages/fieldos-runtime` wrapping a capnp `disk` service; workerd has no `assets` binding type |
| `BROWSER` | Browser Rendering, for gadget PDF export | Optional — both call sites degrade with a clear error. Self-hosted Chrome later |
| `WORKERS_AI` | Document→Markdown for the `webFetch` tool only — **not** inference | Optional; fails soft to plain text. `webFetch` is near-moot on an isolated network |
| `PRODUCT_ANALYTICS` | Optional analytics pipeline | No-ops when unbound |
| `PUBLIC_BASE_URL` | The deployment's public origin | — |

**KV and R2 need a server, not a store.** `kvNamespace` and `r2Bucket` are `ServiceDesignator`s in
workerd's schema: the runtime converts binding calls into HTTP requests aimed at a service you
provide, and provides none itself. So "any KV store will do" is not quite right — the store has to
speak workerd's binding protocol. `packages/fieldos-runtime` implements it.

**MinIO cannot back `BLUEPRINT_CONTENT`.** An earlier version of this table said "R2's API is
S3-compatible". That is true of R2's *S3 endpoint* and false of the *binding* this code uses, which
speaks a private protocol. Pointing the binding at MinIO does not work, and the S3-backed R2 that
Miniflare ships inverts the dependency — it would mean running MinIO as a second server process
inside the airgapped deployment.

**`WORKERS_AI` is not inference and not HTML-only.** It is `toMarkdown()`, which also converts PDF,
DOCX, XLSX and ODT. It fails soft: unsupported types return null and the caller falls back to plain
text. It is a `wrapped` binding over a module compiled into workerd whose only inner binding is a
fetcher, so a local converter can serve it later with no application change.

## Observability

| Binding | Behaviour when unbound |
|---|---|
| `FRONTEND_ERROR_REPORTER` | The `/api/client-errors` endpoint becomes a no-op |
| `FRONTEND_ERROR_RATE_LIMITER` | Same; both must be bound for reporting to dispatch |
| `ERROR_REPORTER` | `reportIssue()` no-ops. Not declared in any checked-in config |

Logging goes through `@gadgets/backend-utils/logger`, which emits one structured object per call
with a stable `component` and `event` — already the right shape for indexing, though nothing
consumes it yet. Under standalone workerd it lands on stdout, so a log shipper is the collection
path. There is no OTLP exporter; traces are Cloudflare-specific and unavailable off-platform.

*(An earlier version of this section said "all logging is plain `console.*`". That predated the
structured logger; only a handful of raw `console.` calls remain in the backend.)*

## Known gaps

- **No admin UI for session bounds yet.** The `AdminConfig` fields exist and resolve correctly; the
  dashboard controls arrive with the wider admin panel work. Env vars work today.
- **Admin revocation targets a named user.** There is no user directory — user objects are
  addressed by name — so "revoke every session globally" is not implementable without building one.
  Worth stating to an accreditation reviewer as a scope boundary.
