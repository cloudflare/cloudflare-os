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
  is authorized as an observation, and Worker bindings inject an immutable service filter and
  defensively discard foreign-service events. Distributed trace summaries are account-only because
  their names, timing, services, and counts describe the whole cross-service trace; a Worker binding
  can still retrieve its own events for a known trace ID.

Observability connections request `workers-observability.read`. The OAuth client must allow that
scope or Cloudflare will omit/reject it. Existing billing-only connections can add the grant when the
user first selects an observability resource. Cloudflare exposes account and Worker resource choices,
but both map to this one indivisible OAuth scope; resource bindings provide the finer capability
boundary after connection.

Workers telemetry is retained by Cloudflare for at most seven days. Queries default to the last hour,
and the Worker picker searches the full retention window. Suggested bindings are
`CLOUDFLARE_OBSERVABILITY` for account access and `WORKER_OBSERVABILITY` for one Worker.

`openid` is intentionally **not** requested — the Cloudflare dashboard OAuth client isn't permitted
that scope; identity comes from the `/user` API (`user-details.read`).

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
