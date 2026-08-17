# Gatekeeper Cloudflare

This package provides Cloudflare OAuth integration for Gadgets. For now it serves two purposes:

- **Sign-in:** when `cloudflare` is in the deployment's `AUTH_GATEKEEPERS` allowlist, "Continue with
  Cloudflare" appears on the login page. Sign-in requests only minimal scopes
  (`offline_access user-details.read`) to read the account email (verified by Cloudflare, via the
  `/user` API), which becomes the user's identity. The sign-in grant is transient (discarded right
  after the email is read).
- **AI Gateway billing:** when a user connects Cloudflare (or signs in and later connects it), the
  full scopes are requested and the connection persists. The Workshop then reads a usable access
  token from it (`getUsableAccessToken`) to power the [AI Gateway billing](../../docs/ai-gateway-billing.md)
  flow — reading the credit balance and routing BYOK inference through the account's default AI
  Gateway.

Resource capabilities for gadgets/agents (Workers logs, R2, etc.) will be added later.

`openid` is intentionally **not** requested — the Cloudflare dashboard OAuth client isn't permitted
that scope; identity comes from the `/user` API (`user-details.read`).

## Setting Up Cloudflare OAuth Credentials

You need a Cloudflare dashboard OAuth client (client id + secret). The dashboard OAuth endpoints and
scopes are hardcoded in `src/oauth.ts`, so you only configure the client id/secret and register the
redirect URI.

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
user enables billing by connecting Cloudflare, which requests the full scopes
(`offline_access aig.read aig.run user-details.read account-settings.read`).

### Step 4: Verify Setup

1. Start the application in dev mode (see the root README.md).
2. On the login page, click **Continue with Cloudflare**.
3. A pop-up opens to the Cloudflare authorization page; approve it.
4. The pop-up closes and you're signed in, identified by your Cloudflare account email.
5. To use AI Gateway credits, open **Usage & billing** in settings and **Connect Cloudflare** (this
   requests the fuller billing scopes).

## Troubleshooting

### "redirect_uri ... does not match any of the ... pre-registered redirect urls"

The redirect URI isn't registered on the OAuth client. Register exactly
`http://localhost:8787/gatekeeper/cloudflare/oauth` (or your `PUBLIC_BASE_URL` equivalent) — no
trailing slash, `http` not `https` for localhost.

### "Not configured" page during authorization

`CLIENT_ID` / `CLIENT_SECRET` are missing. Ensure they're set (per-package `.env` or seeded from the
root `.dev.vars`), then restart the dev server.
