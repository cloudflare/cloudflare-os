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
2. The client opens `url` in a pop-up (the gatekeeper's self-closing OAuth window) and calls
   `attempt.wait()`, which blocks on the `PendingLogin` DO.
3. When the gatekeeper finishes, it calls `complete(user)`. The callback reads
   `user.getAuthenticatedEmail()`, resolves/creates the email-keyed `UserDurableObject`, mints a
   session, and delivers the `"<email>:<secret>"` token to the `PendingLogin` DO — which resolves the
   awaiting RPC.
4. The client stores the token and authenticates as usual.

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

- `PendingLogin` (DO) — short-lived bridge between a gatekeeper login pop-up and the waiting browser,
  reached via `ctx.exports` (no explicit binding). Holds no durable storage: the in-flight
  `attempt.wait()` keeps it alive, and it's evicted once the login completes or the client disposes
  the `attempt` stub.

## Code layout

```
auth/
├── config.ts         # AUTH_GATEKEEPERS allowlist; password-auth toggle
├── auth-vendors.ts    # GATEKEEPER_<NAME> binding lookup helpers
└── login-flow.ts      # PendingLogin DO + LoginConnectCallbackImpl
```

Client-side: `ServerConfigContext` exposes `authVendors` and `passwordAuthEnabled`;
`components/auth/OAuthButtons` renders the sign-in options (pop-up + `attempt.wait()`).
