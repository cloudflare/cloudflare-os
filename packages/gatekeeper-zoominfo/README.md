# Gatekeeper ZoomInfo

This package provides [ZoomInfo](https://www.zoominfo.com) integration for Gadgets via ZoomInfo's
GTM (go-to-market) API, using OAuth2 (Authorization Code + PKCE).

It exposes a single **whole-account** resource (`https://app.zoominfo.com/`): a session scoped to one
connected ZoomInfo account's OAuth grant and package entitlements. Through it a gadget can:

- **Lookup** — resolve controlled filter values (industries, intent topics, scoop types, …) and
  discover the enrich fields the account is entitled to.
- **Search** (free) — companies, contacts, intent signals, scoops, and news, with full firmographic
  and technographic filter fidelity.
- **Enrich** (consumes credits) — turn matched records into full detail: companies, contacts,
  corporate hierarchy, hashtags, intent, scoops, and news.
- **Copilot** — company/contact lookalikes, contact recommendations, AI account summaries (+ ask),
  and curated company insight signals.
- **Usage** — read the account's credit/limit counters.

A connected account corresponds to the ZoomInfo user who authorizes the OAuth consent flow, whom
the gatekeeper identifies by the `sub` claim of the ID token ZoomInfo's token endpoint returns with
every grant. ZoomInfo is **not** offered as a "Continue with…" sign-in method
(`getAuthenticatedEmail()` returns `null`).

## Creating the OAuth app

1. In the [ZoomInfo Developer Portal](https://api.zoominfo.com/), create an OAuth application.
2. Set the **Redirect URI** to your deployment's callback (replace the host with your base URL):

   ```
   ${BASE_URL}/gatekeeper/zoominfo/oauth
   ```

   For local development that is `http://localhost:8787/gatekeeper/zoominfo/oauth`.
3. Enable all API scopes the account is entitled to. The gatekeeper requests exactly the scopes
   ZoomInfo's authorization server recognizes:

   ```
   api:data:company  api:data:contact  api:data:intent  api:data:news  api:data:scoops
   api:recommendations:read  api:account-summary:read  api:insights:read
   ```

   There is no `lookup` scope — lookup/enrich-field reference data comes with the data scopes.
4. Copy the **Client ID** and **Client Secret**.

> Use the OAuth app's **Client ID + Client Secret**. The `authorization_code` exchange posts them to
> the token endpoint as HTTP Basic auth (form-urlencoded), with PKCE (S256) and refresh-token
> rotation.

## Configuration

The gatekeeper Worker reads `CLIENT_ID` and `CLIENT_SECRET`. In local development these are seeded
from the root `.dev.vars` by `run-dev-server.ts`:

```
ZOOMINFO_CLIENT_ID=<oauth app client id>
ZOOMINFO_CLIENT_SECRET=<oauth app client secret>
```

Optional overrides read by the Worker:

- `BASE_URL` — the gatekeeper's public base (default `http://localhost:8787/gatekeeper/zoominfo`);
  the OAuth redirect is `${BASE_URL}/oauth`.
- `ZOOMINFO_API_BASE_URL` — the ZoomInfo API root (default `https://api.zoominfo.com/gtm`).

## Notes & limitations

- **Credits.** Search, lookup, recommendations, insights, and account summaries are free. Enrichment
  consumes ZoomInfo credits (roughly one per newly-enriched record; already-owned records and
  no-match/error results are free). `getCreditUsage()` is the authoritative source for accounting —
  the per-record `creditCharged` flag is a display-only upper bound, because ZoomInfo often omits
  management status from enrich responses and so over-reports records served for free.
- **Approvals.** Reads are logged as observations. Each `enrich*` call is submitted to the approval
  queue and spends credits only once a human approves it; results are fetched afterward via
  `getEnrichmentResult(ticket)`. Enrichments are **not** simulated — the action carries
  `awaitDecision`, so the agent turn suspends until the decision rather than reading back
  un-enriched state. An approval made while the account can't get a token (or its user isn't
  known) spends nothing and fails, leaving the enrichment pending to approve again after
  reconnecting.
- **Intent/scoop company targeting.** Intent and scoop *search* filter by firmographics only —
  ZoomInfo has no company-identity inputs there. To pull intent or scoops for a specific known
  company, use `enrichIntent` / `enrichScoops` (which take a company identifier). The API surface and
  a runtime guard both enforce this with a clear message instead of ZoomInfo's opaque 400.
- **`state` vs `country`.** These are mutually exclusive: ZoomInfo silently ignores `state` when
  `country` is also set and returns the whole country. The gatekeeper rejects the combination up
  front rather than returning broadened results with no signal. `state` already scopes to the
  US/Canada, so pass just one.
- **Entitlements.** Every call is scoped to the account's package: ZoomInfo returns only the fields
  and datasets the account is entitled to; unentitled fields come back empty.
- **Sharing.** ZoomInfo data is private to the connection's owner. Every read reports a ZoomInfo
  user as the observation subresource `user/<userId>`: the one whose token returned its data, or,
  for a pending or rejected enrichment, which holds nothing ZoomInfo returned, the one the
  connection acts for now. `userId` is the ID token's `sub` (never an email or display name, which
  can change), and `verifyObserverAccess()` allows no collaborator to read one, not even one
  connected as the same ZoomInfo user. `addObserver()` still refuses every observer, which keeps
  what was read before reads reported their user private. Malformed or unsupported subresource IDs
  fail the whole check.
- **Identity and reconnects.** A grant whose ID token names no user, or names it for another
  client, is refused at connect. A connection made before the gatekeeper kept the user's ID learns
  it from the ID token of its next token refresh, which happens early for that purpose; if ZoomInfo
  doesn't identify the user there, reads fail and the account asks to be reconnected. A refresh
  naming a different user than the connection's fails the same way, and one a reconnect or
  disconnect overtakes is dropped rather than stored over what replaced it. Reconnecting as another
  ZoomInfo user is allowed, and new reads then report that user, while what the binding already
  holds keeps the user it came from: an enrichment result reports the user whose token retrieved
  it, and a cached lookup is served only to the user it was fetched as. Enrichment results stored
  before the gatekeeper recorded their user aren't returned (request them again); cached lookups
  from then are fetched again.

## Troubleshooting

### "ZoomInfo Gatekeeper Not Configured" during authorization

`CLIENT_ID` or `CLIENT_SECRET` is missing. Ensure `ZOOMINFO_CLIENT_ID` / `ZOOMINFO_CLIENT_SECRET`
are set in the root `.dev.vars`, then restart the dev server.

### `invalid_scope` on the authorization page

A requested scope isn't recognized by ZoomInfo's authorization server. Confirm the app has the eight
scopes listed above enabled and that no others are being requested.

### Redirect URI mismatch

The redirect URI sent must exactly match one registered on the app. Confirm the portal has
`${BASE_URL}/gatekeeper/zoominfo/oauth` (for local dev,
`http://localhost:8787/gatekeeper/zoominfo/oauth`, no trailing slash).

### "ZoomInfo did not return a refresh token"

The OAuth app isn't issuing refresh tokens. Enable the refresh-token grant for the app in the
Developer Portal and reconnect — the gatekeeper needs a refresh token to keep the long-lived session
alive after the access token expires.
