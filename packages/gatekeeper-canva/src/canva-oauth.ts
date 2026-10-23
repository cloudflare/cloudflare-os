// OAuth 2.0 (authorization-code + PKCE) for the Canva Connect API, over the kit's OAuthClient.
//
// Canva requires PKCE (S256) on every authorization request, authenticates the client to the token
// endpoint with HTTP Basic credentials, and rotates refresh tokens: each refresh response carries a
// new refresh token and the old one is dead. Access tokens last about four hours.

import {
  createPkce, isInvalidGrant, OAuthClient, type OAuthTokens,
} from "@gadgets/gatekeeper-kit/oauth-client";

const CANVA_AUTHORIZE_URL = "https://www.canva.com/api/oauth/authorize";
const CANVA_TOKEN_URL = "https://api.canva.com/rest/v1/oauth/token";
const CANVA_REVOKE_URL = "https://api.canva.com/rest/v1/oauth/revoke";

/** Access-token lifetime Canva documents, used when a response omits `expires_in`. */
const DEFAULT_ACCESS_TOKEN_LIFETIME_SECONDS = 4 * 60 * 60;

/**
 * Scopes requested during connect. These cover exactly what `CanvaAccountSession` exposes today:
 * profile and capabilities, design listing/metadata, design creation and AI generation, folder
 * browsing, reading image assets, and image transformation (which writes a new asset, hence
 * `asset:write`). `design:content:read` is deliberately absent: nothing reads page content or
 * exports yet, and a consent screen should ask only for what the code uses.
 *
 * Adding a scope here does not widen existing connections: an account connected before the
 * addition keeps its narrower grant until the user reconnects.
 */
export const OAUTH_SCOPES = [
  "profile:read",
  "design:meta:read",
  "design:content:write",
  "asset:read",
  "asset:write",
  "folder:read",
];

export interface CanvaOAuthConfig {
  clientId: string;
  clientSecret: string;
  /** The gatekeeper's own `/oauth` endpoint, registered on the Canva integration. */
  redirectUri: string;
}

/**
 * Build the OAuth config from the gatekeeper's env. Returns null if the client credentials aren't
 * configured, so callers can render a "not configured" page instead of a broken redirect.
 */
export function getOAuthConfig(
  clientId: string | undefined, clientSecret: string | undefined, baseUrl: string,
): CanvaOAuthConfig | null {
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, redirectUri: `${baseUrl}/oauth` };
}

/** The kit client for Canva's token and revocation endpoints, authenticated as this integration. */
export function oauthClient(config: CanvaOAuthConfig): OAuthClient {
  return new OAuthClient({
    label: "Canva",
    client: { method: "basic", id: config.clientId, secret: config.clientSecret },
    tokenEndpoint: CANVA_TOKEN_URL,
    authorizationEndpoint: CANVA_AUTHORIZE_URL,
    revocationEndpoint: CANVA_REVOKE_URL,
    defaultExpiresIn: DEFAULT_ACCESS_TOKEN_LIFETIME_SECONDS,
  });
}

/** Generate a PKCE verifier and its S256 challenge. The verifier is stored until the code exchange. */
export async function generatePkce(): Promise<{ verifier: string; challenge: string }> {
  const { codeVerifier, codeChallenge } = await createPkce();
  return { verifier: codeVerifier, challenge: codeChallenge };
}

/** The URL to send the user's browser to. `state` must be the per-flow nonce the callback checks. */
export function buildAuthorizeUrl(
  config: CanvaOAuthConfig, state: string, challenge: string, scopes: string[],
): string {
  return oauthClient(config).authorizationUrl({
    redirectUri: config.redirectUri, state, scopes, codeChallenge: challenge,
  }).toString();
}

/** Exchange an authorization code (with its PKCE verifier) for tokens. */
export function exchangeCode(
  config: CanvaOAuthConfig, code: string, verifier: string,
): Promise<OAuthTokens> {
  return oauthClient(config).exchangeCode({ code, redirectUri: config.redirectUri, codeVerifier: verifier });
}

/**
 * Refresh an access token. The response carries a rotated refresh token which MUST replace the
 * stored one; callers should go through the account DO so two refreshes never race.
 */
export function refreshTokens(config: CanvaOAuthConfig, refreshToken: string): Promise<OAuthTokens> {
  return oauthClient(config).refresh({ refreshToken });
}

/** Revoke a token at Canva. Best-effort: a failure here only means Canva still lists the grant. */
export function revokeToken(config: CanvaOAuthConfig, token: string): Promise<void> {
  return oauthClient(config).revoke({ token });
}

/**
 * Whether a refresh failure proves the grant is dead, so the account should be marked expired and
 * the user asked to reconnect. `invalid_grant` is the RFC 6749 answer for a revoked, expired, or
 * already-rotated refresh token, and it is what Canva returns. Everything else (network failure, a
 * 5xx, a 429, or `invalid_client` meaning this deployment's own credentials are wrong) leaves the
 * grant as it was, so a transient fault or a misconfiguration never logs every user out at once.
 */
export function isGrantDeath(error: unknown): boolean {
  return isInvalidGrant(error);
}
