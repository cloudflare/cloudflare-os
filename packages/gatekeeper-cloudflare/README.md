# Gatekeeper Cloudflare

This package provides Cloudflare OAuth integration for Gadgets. It serves three purposes:

- **Sign-in:** when `cloudflare` is in the deployment's `AUTH_GATEKEEPERS` allowlist, "Continue with
  Cloudflare" appears on the login page. The grant reads the account email (verified by Cloudflare,
  via the `/user` API), which becomes the user's identity. Cloudflare sign-in also establishes the
  persistent billing-only connection described below.
- **AI Gateway billing:** when a user connects Cloudflare or signs in with it, the billing scopes are
  requested and the connection persists. The Workshop then reads a usable access
  token from it (`getUsableAccessToken`) to power the [AI Gateway billing](../../docs/ai-gateway-billing.md)
  flow — reading the credit balance and routing BYOK inference through the account's default AI
  Gateway.
- **Workers Observability:** gadgets can receive read-only access to logs, events, invocations,
  aggregate metrics, and traces either across an account or restricted to one Worker. Every result
  is authorized as an observation, and Worker bindings stay pinned to the Worker's immutable ID,
  injecting that Worker's name and versions as filters and defensively discarding any event from
  another version. Distributed trace summaries are account-only because their names, timing,
  services, and counts describe the whole cross-service trace; a Worker binding can still retrieve
  its own events for a known trace ID.

Observability connections request `workers-observability.read`, and a connection that may bind a
single Worker also requests `workers-tail.read`, which lets it read the Worker's ID, name and
versions. The OAuth client must allow both scopes or Cloudflare will omit/reject them. Existing
billing-only connections can add the grant when the user first selects an observability resource,
and a connection granted only `workers-observability.read` (as every one was before Worker bindings
needed the second scope) is asked for `workers-tail.read` the first time it connects a Worker.
Cloudflare exposes account and Worker resource choices; resource bindings provide the finer
capability boundary after connection.

Workers telemetry is retained by Cloudflare for at most seven days. Queries default to the last hour,
and the Worker picker searches the full retention window. Suggested bindings are
`CLOUDFLARE_OBSERVABILITY` for account access and `WORKER_OBSERVABILITY` for one Worker.

### Sharing a gadget that reads telemetry

A binding is not transferable. Every read reports what it disclosed as a subresource,
`account/<accountId>` for an account binding and `account/<accountId>/worker/<workerId>` for a
Worker binding, and the Workshop admits a collaborator to what was read only if **their own**
connected Cloudflare account can read it (`verifyObserverAccess` checks their credentials, not the
owner's). An account needs a telemetry read to succeed in it; a Worker needs that and the Worker,
looked up by its ID, to be visible, so the check follows the Worker the binding was granted rather
than whichever Worker now has its name. A connection without the scopes for a resource type is
refused without asking Cloudflare. A collaborator without access is refused, and a verification that
fails for any other reason — a 5xx, a transport error — is an error rather than an admission.

Each collaborator's answers are cached in their own connected account and reused across every
workspace: an allowed answer for up to 15 minutes and a denial for up to 15 seconds, until their
credentials are next installed. Cloudflare does not say when a role changes, so access revoked in
Cloudflare can still admit a collaborator for up to 15 minutes, and a new grant is noticed within 15
seconds. `addObserver` still requires the binding's own subresource on every admission, for reads
made before reads reported one.

### What a Worker binding trusts, and what it re-checks

Telemetry names the Worker that emitted an event only by the name it had then
(`$metadata.service`), and a name is freed by a rename and can be taken by a new Worker. So a Worker
binding records the Worker's immutable ID (the Workers API's `id`, the legacy Scripts API's `tag`)
when it is created, and each read resolves that ID to the Worker's current name and its versions.
The query requires both, and every event that comes back is re-checked against the versions:
`$workers.scriptVersion.id` names a version, and a version belongs to one Worker for good. An event
from another Worker that held or took the name is dropped; telemetry the Worker recorded under a
name it no longer has is not asked for, since the query names the current one (though the version
re-check would keep any the provider returned anyway, as the Worker's own); and once the Worker is
deleted the binding reads nothing, whoever takes its name. A Worker binding created before bindings
recorded the Worker ID cannot tell its Worker from a later one, so it refuses to read until the
connection is removed and the Worker connected again; its collaborators must still be able to read
the whole account's telemetry, since its earlier reads went to whichever Worker had the name at the
time.

The scope filter is prepended to every query, but a filter the provider *accepted* is not evidence it
*applied* it — three separate behaviours here return wrong-but-plausible data with no error. So events
are re-filtered on the way out, and a single foreign event is treated as proof the filter was dropped:
the provider's `count` is withheld (it would be a count of the whole account's matching telemetry) and
the event is logged at `error`. `statistics` is kept, because it describes what our query cost rather
than how much matched, and callers are told to read it for cost.

The re-check is deliberately not a hard failure. The events returned are filtered and therefore safe,
and this provider has surprised us often enough that turning a hypothetical disclosure into a
guaranteed outage would be the worse trade.

`calculate()` is the exception, and knowingly so: an aggregate cannot be un-mixed, so there is no
second line of defence to add. It rests entirely on the injected conditions: the provider filtering
`query` by `$metadata.service` is verified against a live account and keeps an aggregate to one
name, while the version condition that keeps it to one Worker rests on the documented
`$workers.scriptVersion.id` field. The fix that would work — grouping by version and keeping this
binding's own groups — changes `limit` and `orderBy` semantics for every caller, so it is a follow-up
rather than a footnote.

### Why discovery sometimes costs a query

Cloudflare's `telemetry/keys` and `telemetry/values` endpoints ignore the `filters` array they accept:
verified against a live account, they answer for the whole account no matter what is passed. A
Worker-scoped binding therefore cannot use them — they would disclose every field name and value in
the account. Whenever a discovery call has to be constrained (a Worker binding, or any caller-supplied
filter), the answer is derived instead from a filtered `telemetry/query` events sample, which the
provider does filter correctly. Unconstrained account-wide discovery still uses the cheap endpoints.

> Unresolved: whether the `workers-observability.read` scope alone is accepted, or whether Cloudflare
> requires the Workers Observability **Write** permission to read telemetry. This has not been
> verified against a live token; if reads 403 on a correctly-scoped grant, that is the first thing to
> check.
>
> Also unverified against a live account, and taken from Cloudflare's API reference: that the
> Workers API accepts an OAuth token's `workers-tail.read` for `workers/workers/<id>` and its
> `versions` (the reference lists Workers Tail Read among the permissions both accept); that its
> `id` is the legacy Scripts API's `tag`; and that every Worker event carries a filterable
> `$workers.scriptVersion.id` matching the versions list. If the last is wrong, a Worker binding
> returns no events rather than another Worker's, and an aggregate either matches nothing or, should
> the provider ignore the version condition, is kept to the Worker's current name alone.

### Two names for one field

A log's own structured fields are returned nested under `source` but are **indexed under their bare
name**: `logger.warn(msg, {event: "x"})` comes back as `source.event` and is queried as `event`.
Confirmed both ways — `telemetry/keys` on a live account reports `event`/`component`/`level` and no
`source.*` key at all, and the [Workers Logs
docs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) show
`console.log({user_id: 123})` being filtered as `user_id`.

This matters because the provider accepts an unknown filter key, matches nothing, and returns an empty
page with no error. So discovery reports indexed names (`observability-discovery.ts`), and
`observabilityFieldKey` additionally accepts a `source.`-prefixed key as an alias wherever a caller
names a field — filters, `calculations`, `groupBys`, `listValues` — because copying a path out of a
`listEvents` result is the obvious thing to do and used to fail silently.

`openid` is intentionally **not** requested — the Cloudflare dashboard OAuth client isn't permitted
that scope; identity comes from the `/user` API (`user-details.read`).

### Why an error's text never reaches the log

`summarizeFilter` deliberately keeps filter *values* out of the audit trail — they are caller text.
But a provider error message can quote that same value straight back, so logging the message would
readmit through the error path exactly what the audit path excludes. `CloudflareObservabilityApiError`
therefore carries Cloudflare's numeric `codes` alongside the message: the request log names the
codes, and the message travels only to the caller who caused it.

The codes are not the discriminator, though — Cloudflare can return a message with no numeric code
at all, so the error records separately whether the message is *its* or *ours*, and only ours is
logged. A provider failure carrying no codes is therefore logged as a bare status, which is the
fail-closed answer: the status still says what happened without quoting anyone's filter back.

### Listing accounts is a walk, not a request

`/accounts` is paginated and defaults to **20** per page, so a single GET silently returns a truncated
list — an account past the first page simply cannot be picked, with nothing to indicate why. The
account picker's substring match also stays client-side: `name` is the only documented server-side
filter and whether it matches exactly or by substring is not specified, so pushing it down would trade
a visible truncation for an invisible one.

## Setting Up Cloudflare OAuth Credentials

You need a Cloudflare dashboard OAuth client (client id + secret). The dashboard OAuth endpoints and
scopes are hardcoded in `src/oauth.ts`, so you only configure the client id/secret and register the
redirect URI. Ensure the client's scope allowlist includes `workers-observability.read` and
`workers-tail.read` when this deployment offers Workers Observability resources.

### Step 1: Register the redirect URI

The gatekeeper's OAuth redirect URI is:

```
${BASE_URL}/oauth
```

where `BASE_URL` defaults to `http://localhost:8787/gatekeeper/cloudflare` in dev — i.e. the full
redirect URI is:

```
http://localhost:8787/gatekeeper/cloudflare/oauth
```

Register **exactly** this (replace the host with your `PUBLIC_BASE_URL` when not running locally) as
an allowed/pre-registered redirect URL on the Cloudflare OAuth client. If it isn't registered you'll
get an `invalid_request` error: _"the 'redirect_uri' parameter does not match any of the OAuth 2.0
Client's pre-registered redirect urls."_

### Step 2: Configure Your Local Environment

Create a `.env` file in this package's directory (`packages/gatekeeper-cloudflare/.env`):

```bash
CLIENT_ID=your-client-id-here
CLIENT_SECRET=your-client-secret-here
```

In local dev, `run-dev-server.ts` will also seed these from `CLOUDFLARE_OAUTH_CLIENT_ID` /
`CLOUDFLARE_OAUTH_CLIENT_SECRET` if you'd rather set them in the root `.dev.vars`. A per-package
`.env` takes precedence and keeps the credential with the gatekeeper that uses it.

> **Note**: The `.env` file is gitignored and should never be committed.

### Step 3: (Optional) Enable Cloudflare sign-in / billing

To offer "Continue with Cloudflare" on the login page, add `cloudflare` to the deployment's
`AUTH_GATEKEEPERS` allowlist (e.g. in the root `.dev.vars`):

```
AUTH_GATEKEEPERS=cloudflare,google,github
```

The order controls the order of the login buttons. For the AI Gateway billing / top-up flow, also
set `ENABLE_CLOUDFLARE_LIMITS=true` (see [AI Gateway billing](../../docs/ai-gateway-billing.md)); a
user enables billing by connecting Cloudflare, which requests the billing scopes
(`offline_access aig.read aig.run user-details.read account-settings.read`). Connecting all
Cloudflare gadget resources also requests `workers-observability.read` and `workers-tail.read`.

### Step 4: Verify Setup

1. Start the application in dev mode (see the root README.md).
2. On the login page, click **Continue with Cloudflare**.
3. A pop-up opens to the Cloudflare authorization page; approve it.
4. The pop-up closes and you're signed in, identified by your Cloudflare account email.
5. To use AI Gateway credits, open **Usage & billing** in settings and **Connect Cloudflare** (this
   requests billing scopes only).

## Troubleshooting

### "redirect_uri ... does not match any of the ... pre-registered redirect urls"

The redirect URI isn't registered on the OAuth client. Register exactly
`http://localhost:8787/gatekeeper/cloudflare/oauth` (or your `PUBLIC_BASE_URL` equivalent) — no
trailing slash, `http` not `https` for localhost.

### "Not configured" page during authorization

`CLIENT_ID` / `CLIENT_SECRET` are missing. Ensure they're set (per-package `.env` or seeded from the
root `.dev.vars`), then restart the dev server.
