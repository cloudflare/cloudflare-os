# Sign-in via authentication gatekeepers

Sign-in is provided by **authentication gatekeepers** — gatekeepers that advertise `providesAuth`
and can return a provider-verified email. Each such gatekeeper uses a single OAuth app for both
sign-in and (when the user later connects it) its capabilities, so there's only one OAuth app per
provider — no separate "login" vs. "gatekeeper" apps.

It's an optional, **additive** feature: for each allowlisted, auth-capable gatekeeper a "Continue
with …" button appears **alongside** the normal username/password form. Off by default — with an
empty allowlist the Workshop behaves as before (username/password, or Cloudflare Access).

The deployment opts gatekeepers into sign-in via the `AUTH_GATEKEEPERS` allowlist (comma-separated
vendor ids). Set `DISABLE_PASSWORD_AUTH=true` to hide username/password and offer gatekeeper sign-in
only (ignored unless the allowlist is non-empty, to avoid locking everyone out).

## Identity: keyed by verified email

The primary account key is always the user's **verified email**. Signing in with any allowlisted
gatekeeper that yields the same verified email resolves to the same account — its `UserDurableObject`
is addressed by `idFromName(email)` (the same scheme as Cloudflare Access). Each gatekeeper must only
return an email the provider has verified (Google `email_verified`, a GitHub primary+verified email,
the Cloudflare account email); otherwise it returns null and can't be used to sign in.

## Incremental scopes

Sign-in requests only the **minimal scopes** needed to verify the user's email (e.g. GitHub
`read:user user:email`, Google `openid email profile`, Cloudflare `offline_access user-details.read`),
and the gatekeeper grant created for login is **transient** — it self-destructs shortly after the
email is read, so signing in never leaves a broad authorization lying around. The fuller capability
scopes (repos, Gmail/Docs, AI Gateway billing) are requested only later, when the user explicitly
**connects the gatekeeper** (`connectAccount(vendorId)` with the default `scopes: "full"`), which is
what persists a usable connected account. `GatekeeperVendor.connectAccount` takes
`{ scopes: "auth" | "full" }` to choose between the two.

## Sign-in flow

1. The client calls `PublicApi.startGatekeeperLogin(vendorId)`. The backend creates a short-lived
   `PendingLogin` DO, hands the gatekeeper a `LoginConnectCallbackImpl`, and returns the gatekeeper's
   OAuth `url` plus an `attempt` stub (a capability wrapping the `PendingLogin` DO — no login id is
   exposed to the client).
2. The client opens `url` as a pop-up, keeping itself as the pop-up's opener.
3. When the gatekeeper finishes, it calls `complete(user)`. The callback reads
   `user.getAuthenticatedEmail()`, resolves/creates the email-keyed `UserDurableObject`, mints a
   session, and parks the `"<email>:<secret>"` token in the `PendingLogin` DO under the hash of a
   fresh handoff ticket. `complete()` returns that ticket, and the gatekeeper's final page posts it to
   its opener — exactly as the connect-account flow does (`connectHandoffPageHtml` in gatekeeper-kit).
4. The opener calls `attempt.claim(ticket)`; the `PendingLogin` DO releases the token only for the
   matching ticket, once. This is what binds the session to the browser that started the attempt:
   the sign-in URL is a bearer capability, so whoever holds `attempt` without the ticket (an attacker
   who phished a victim into finishing the flow) gets nothing, and the unclaimed token is wiped after
   two minutes.
5. The client stores the token and authenticates as usual.

Sign-in does **not** persist a connected account: the minimal-scope grant is only used to read the
email and is then discarded by the gatekeeper. To use a gatekeeper's capabilities (repos, Gmail/Docs)
or Cloudflare AI Gateway billing, the user explicitly **connects** it afterward (which requests the
full scopes and persists the connection).

## Configuration

```
PUBLIC_BASE_URL=https://your-host
AUTH_GATEKEEPERS=cloudflare,google,github   # which gatekeepers may sign users in (order = button order)

# Optional: gatekeeper sign-in only (hide username/password).
DISABLE_PASSWORD_AUTH=true
```

OAuth app credentials live on the **gatekeeper Workers**, not the backend. Register each gatekeeper's
OAuth app with its own redirect URI:

- Google: `${PUBLIC_BASE_URL}/gatekeeper/google/oauth`
- GitHub: `${PUBLIC_BASE_URL}/gatekeeper/github/oauth`
- Cloudflare: `${PUBLIC_BASE_URL}/gatekeeper/cloudflare/oauth`

In local dev, `run-dev-server.ts` seeds each gatekeeper's `CLIENT_ID`/`CLIENT_SECRET` from
`GOOGLE_*` / `GITHUB_*` / `CLOUDFLARE_OAUTH_*` shell vars.

## Storage / bindings

- `PendingLogin` (DO) — short-lived bridge between a gatekeeper login pop-up and the browser that
  started the attempt, reached via `ctx.exports` (no explicit binding). Stores the delivered token
  under the ticket's hash until `claim()` consumes it; an alarm wipes an unclaimed result after two
  minutes.

## Code layout

```
auth/
├── config.ts         # AUTH_GATEKEEPERS allowlist; password-auth toggle
├── auth-vendors.ts    # GATEKEEPER_<NAME> binding lookup helpers
└── login-flow.ts      # PendingLogin DO + LoginConnectCallbackImpl
```

Client-side: `ServerConfigContext` exposes `authVendors` and `passwordAuthEnabled`;
`components/auth/OAuthButtons` renders the sign-in options (pop-up + handoff ticket + `attempt.claim()`).
