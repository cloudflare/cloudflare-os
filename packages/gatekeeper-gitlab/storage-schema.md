# GitLab gatekeeper storage schema

Durable Object storage layout for `UserAccount` and `GitLabGatekeeperImpl`. Written from the code
as each piece lands; the GitHub gatekeeper's `storage-schema.md` is the shape this mirrors.

## UserAccount

| Key | Value | Notes |
|---|---|---|
| `callback` | `Fetcher<GatekeeperConnectCallback>` | Stored at connect; used for `complete`, `reconnectComplete`, `credentialsExpired`. |
| `nonce` | `{ value, expiresAt, stage: "initiation" \| "oauth", reconnect?: true }` | Two-stage connect nonce. |
| `codeVerifier` | `string` | PKCE verifier, written with the `oauth`-stage nonce and deleted at code exchange. |
| `requestedScopes` | `string[]` | Scopes requested for this flow (auth-only or full). |
| `ephemeral` | `boolean` | Auth-only sign-in grant; self-destructs two minutes after `complete()`. |
| `accessToken` | `string` | Current access token. |
| `accessTokenExpiresAt` | `number` | Epoch ms, from the token response's `expires_in`. |
| `refreshToken` | `string` | Current refresh token. Rotates on every refresh; the new value is written with the new access token in one transaction. |
| `scopes` | `string[]` | Scopes the live grant was requested with. Absent on stub-era accounts, which is the reconnect trigger. |
| `expiredNotified` | `boolean` | `credentialsExpired()` sent once. |
| `stagedCredentials` | kit `credential-stage` record | A reconnect's grant, until `commitReconnect(stageId)`. |

## GitLabGatekeeperImpl

Filled in with commits 4–6.
