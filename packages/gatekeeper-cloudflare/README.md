# Gatekeeper Cloudflare

This package provides Cloudflare OAuth integration for Gadgets. It serves four purposes:

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
  is authorized as an observation, and Worker bindings inject an immutable service filter and
  defensively discard foreign-service events. Distributed trace summaries are account-only because
  their names, timing, services, and counts describe the whole cross-service trace; a Worker binding
  can still retrieve its own events for a known trace ID.
- **Notifications:** account-scoped generic webhooks, approved workspace callbacks, and subscriber
  handoff. See setup below.

Observability connections request `workers-observability.read`. The OAuth client must allow that
scope or Cloudflare will omit/reject it. Existing billing-only connections can add the grant when the
user first selects an observability resource. Cloudflare exposes account and Worker resource choices,
but both map to this one indivisible OAuth scope; resource bindings provide the finer capability
boundary after connection.

Workers telemetry is retained by Cloudflare for at most seven days. Queries default to the last hour,
and the Worker picker searches the full retention window. Suggested bindings are
`CLOUDFLARE_OBSERVABILITY` for account access and `WORKER_OBSERVABILITY` for one Worker.

### Sharing a gadget that reads telemetry

A binding is not transferable. When a gadget with an observability binding is shared, each
collaborator is admitted only if **their own** connected Cloudflare account can read that resource
(`addObserver` checks it against their credentials, not the owner's). A collaborator without access is
refused, and a verification that fails for any other reason — a 5xx, a transport error — is also a
refusal rather than an admission.

### What a Worker binding trusts, and what it re-checks

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
second line of defence to add. It rests entirely on the injected filter. The fix that would work —
grouping by `$metadata.service` and keeping this binding's own group, whose value *is* the correctly
scoped answer even for a median — changes `limit` and `orderBy` semantics for every caller, so it is a
follow-up rather than a footnote.

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
redirect URI. Ensure the client's scope allowlist includes `workers-observability.read` when this
deployment offers Workers Observability resources.

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
Cloudflare gadget resources also requests `workers-observability.read`.

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

## Cloudflare Notifications

Notifications are another resource of the **existing Cloudflare connector**, using its OAuth
connection and incremental grants. There is no separate Notifications vendor, worker, OAuth client,
or billing/sign-in flow. The account resource is `https://dash.cloudflare.com/<accountId>/notifications`.

### Set up a subscription

1. Allow **Notifications Write** (`notifications.write`) on your Cloudflare OAuth client. Make it
   optional if that client also supports sign-in or billing. Existing connections request this grant
   when the Notifications resource is first selected; billing-only and auth-only grants do not gain it.
   A connection that selects no specific resources requests every resource scope, including this one,
   so allow it on the OAuth client before upgrading a deployment.
2. Add **Cloudflare Notifications** to a workspace and select the account.
3. Register a persistent callback with one Cloudflare alert type, then enable the resulting hook in
   **Connections**. Enabling creates an authenticated generic webhook destination and an enabled
   Cloudflare notification policy for that alert type. Hooks for the same type share the policy.
4. Use Cloudflare's **Save and Test** to verify ingress. `getStatus()` reports destination and policy
   IDs, plus last test and receive times. It never returns credentials.

```ts
await env.CLOUDFLARE_NOTIFICATIONS.subscribe(callback, {
  alertType: "incident_alert",
});
// callback implements: onNotification(notification): Promise<void>
const health = await env.CLOUDFLARE_NOTIFICATIONS.getStatus();
```

The alert type must be available to the connected Cloudflare account. Policies are created without
filters, so alert types that require them (for example, per-zone or per-health-check alerts) are not
supported yet; enabling such a hook fails with the provider's error codes.

The callback receives the bound account and notification time, optional alert type, policy/name/text/correlation/event-state metadata,
and the original product-specific `data`. Cloudflare's documented payload may omit `account_id`,
`policy_id`, or `alert_type`; when `account_id` is present, it must match the bound account. An alert
with neither `policy_id` nor `alert_type` receives HTTP 500 while hooks are active, because it cannot
be routed without risking delivery to the wrong subscription.

### Delivery and lifecycle

The gatekeeper's HTTP entrypoint verifies `cf-webhook-auth` in one of 256 credential shards before reading the body or
contacting the account receiver. The receiver verifies it again, accepts Cloudflare's documented
`{"text":"…"}` test message, and checks any reported account ID. Request bodies are capped at
512 KiB while streaming, not after an unbounded allocation. API keys are random 256-bit values;
only their SHA-256 verifier is retained locally. Provider requests are fixed-origin, bounded,
time-limited, and do not follow redirects.

A successful event returns **204 after all matching subscribers accept it**. Callback or authorization
failure returns **500**, allowing ANS to retry. There is no local delivery queue, retry loop, or alarm.
Callbacks should accept events promptly, for example by creating an agent task; long-running work and
errors after that handoff belong to the consumer. The gatekeeper waits for the real callback result
instead of racing it against a timer that could allow overlapping retries.

Successful handoffs are remembered per subscriber, so an ANS retry skips subscribers that already
accepted the event. A SHA-256 of the JSON envelope identifies duplicates while keeping different
policies and start/end events distinct. Receipts contain no payloads and are retained for up to 15 days,
bounded to the newest 10,000 receipts per connection/account. Concurrent duplicates share a handoff.
A crash or timeout after a callback commits can still cause redelivery: use `notification.id` to make
side effects idempotent. Delivery order is not guaranteed, and delivery stops if ANS exhausts its retries.

A connection supports 100 hooks. Each callback is preceded by a Cloudflare-specific Workshop
observation describing the bound account, reported alert type, policy ID, and event state.
Notification status and delivered alerts are marked as restricted data, so observing either latches
the workspace against sharing. Notifications bindings are private to their owner. Disabling a hook
stops future handoffs and removes the managed policy when no other hook uses its alert type. The shared
webhook remains for other policies. If that removal fails, the next hook enabled on the connection
retries it. Disconnecting Cloudflare stops ingress and delivery, then removes this connection's
provider resources. Transient cleanup failures retain credentials for retry. If the grant has expired
or no longer has access to the account, provider resources cannot be removed, so disconnect completes
locally and logs `notification.revoke.cleanup.skipped`; delete the `Cloudflare OS` destination and
policies in the dashboard. Provider-side setup is reconciled by the exact webhook URL, allowing recovery from
interrupted creation without taking over similarly named destinations owned by other connections.
Policies are reconciled by a connection-specific description and matching alert type and destination.
Existing user-created policies are not rewritten by setup.

This binding exposes no gadget-initiated writes. Destination and policy creation happen only after the
user approves and enables the hook in Connections; disabling the last hook for a type removes its policy.
Consequently it submits observations for status reads and deliveries, but has no action to submit
through `ActionDescription`.

### Local development

Run `pnpm run-local`, then open `http://localhost:8787`. To connect a real Cloudflare account, create a
private OAuth client in **Manage account → OAuth clients** with response type **Code**, grants
**Authorization Code + Refresh Token**, authentication **Client Secret Basic**, and callback:

```text
http://localhost:8787/gatekeeper/cloudflare/oauth
```

Allow User Details Read, Account Settings Read, AI Gateway Read/Run, Workers Observability Read, and
Notifications Write. Keep resource scopes optional. Put credentials in the root **gitignored**
`.dev.vars` (do not commit it):

```dotenv
CLOUDFLARE_OAUTH_CLIENT_ID=<client ID>
CLOUDFLARE_OAUTH_CLIENT_SECRET=<client secret>
```

### Live notification testing

Use a deployed test instance with a public HTTPS address for real ANS delivery. Configure the test
OAuth client with the deployed callback URL (`https://<test-host>/gatekeeper/cloudflare/oauth`)
and store its credentials using the deployment's normal secret configuration. `BASE_URL` must
resolve to this Worker's public HTTPS address. If notification ingress uses a different public
hostname or path, set `NOTIFICATIONS_WEBHOOK_BASE_URL` to that base address and route it to the same
Worker. The notification address must use HTTPS on port 443, without URL credentials, query, or
fragment; Cloudflare only dispatches generic webhooks to public ports 80 or 443. If the deployment is
behind Cloudflare Access, add a bypass for the webhook path (`<base>/webhooks/*`): ANS cannot present
Access credentials, and each request is authenticated by `cf-webhook-auth` instead.

Connect the test Cloudflare account, enable a notification subscription, and use **Save and Test** on
its webhook destination in Cloudflare. Confirm that the test timestamp appears in the connection's
Details. For event delivery, trigger the policy created for that alert type and verify the
subscriber receives it. Test a failing subscriber to verify HTTP 500 and ANS redelivery, then confirm
successful subscribers are not invoked again.

Local development remains useful for UI changes and automated tests; live webhook verification runs
against the deployed instance.

References: [generic webhook schema](https://developers.cloudflare.com/notifications/reference/webhook-payload-schema/),
[webhook setup](https://developers.cloudflare.com/notifications/get-started/configure-webhooks/),
[OAuth clients](https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/),
[webhook API](https://developers.cloudflare.com/api/resources/alerting/subresources/destinations/subresources/webhooks/methods/create/),
[policy API](https://developers.cloudflare.com/api/resources/alerting/subresources/policies/methods/create/).
