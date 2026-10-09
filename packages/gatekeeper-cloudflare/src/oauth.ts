// OAuth 2.0 (authorization-code + PKCE) for the Cloudflare dashboard, over the kit's OAuthClient.
// The token endpoint expects client credentials via HTTP Basic auth; PKCE binds the redeemed code
// to a short-lived verifier stored in the UserAccount DO.

// Cloudflare's dashboard OAuth endpoints. Stable across deployments; overridable via env for
// staging/testing against a non-production dashboard.
const CF_OAUTH_AUTH_URL = "https://dash.cloudflare.com/oauth2/auth";
const CF_OAUTH_TOKEN_URL = "https://dash.cloudflare.com/oauth2/token";

import {
  createPkce, isInvalidGrant, OAuthClient, OAuthResponseError, type OAuthTokens,
} from "@gadgets/gatekeeper-kit/oauth-client";
import { observabilityScopesForResources } from "./resources.js";

/**
 * Scopes for the AI Gateway billing/BYOK flow: read account details and route inference
 * through the user's own AI Gateway. We deliberately do NOT request "openid" — the dashboard OAuth
 * client isn't permitted it; identity comes from user-details.read (the /user API). offline_access
 * yields a refresh token; account-settings.read is required to enumerate the user's account(s).
 */
export const BILLING_SCOPES = [
  "offline_access",
  "aig.read",
  "aig.run",
  "user-details.read",
  "account-settings.read",
];

/** Persistent billing scopes plus the explicitly selected gadget resources. */
export function persistentScopesForResources(resourceUrlPatterns?: string[]): string[] {
  return [...BILLING_SCOPES, ...observabilityScopesForResources(resourceUrlPatterns)];
}

/**
 * Minimal scopes for sign-in only: a refresh token + the /user identity read. Used in "auth" mode
 * (the resulting grant is transient).
 */
export const AUTH_SCOPES = [
  "offline_access",
  "user-details.read",
];

export interface CloudflareOAuthConfig {
  clientId: string;
  clientSecret: string;
  authUrl: string;
  tokenUrl: string;
  redirectUri: string;
}

/**
 * Build the OAuth config from the gatekeeper's env. `redirectUri` is the gatekeeper's own /oauth
 * endpoint. Returns null if the client credentials aren't configured.
 */
export function getOAuthConfig(
  clientId: string | undefined, clientSecret: string | undefined, baseUrl: string,
): CloudflareOAuthConfig | null {
  if (!clientId || !clientSecret) return null;
  return {
    clientId,
    clientSecret,
    authUrl: CF_OAUTH_AUTH_URL,
    tokenUrl: CF_OAUTH_TOKEN_URL,
    redirectUri: `${baseUrl}/oauth`,
  };
}

function oauthClient(config: CloudflareOAuthConfig): OAuthClient {
  return new OAuthClient({
    label: "Cloudflare",
    client: { method: "basic", id: config.clientId, secret: config.clientSecret },
    tokenEndpoint: config.tokenUrl,
    authorizationEndpoint: config.authUrl,
    defaultExpiresIn: 3600,
  });
}

/** Generate a PKCE verifier and its S256 challenge. */
export async function generatePkce(): Promise<{ verifier: string; challenge: string }> {
  const { codeVerifier, codeChallenge } = await createPkce();
  return { verifier: codeVerifier, challenge: codeChallenge };
}

export function buildAuthorizeUrl(
  config: CloudflareOAuthConfig, state: string, challenge: string, scopes: string[],
): string {
  return oauthClient(config).authorizationUrl({
    redirectUri: config.redirectUri, state, scopes, codeChallenge: challenge,
  }).toString();
}

/** Exchange an authorization code (with its PKCE verifier) for tokens. */
export function exchangeCode(
  config: CloudflareOAuthConfig, code: string, verifier: string,
): Promise<OAuthTokens> {
  return oauthClient(config).exchangeCode({ code, redirectUri: config.redirectUri, codeVerifier: verifier });
}

/** Refresh an access token using a refresh token. */
export function refreshTokens(config: CloudflareOAuthConfig, refreshToken: string): Promise<OAuthTokens> {
  return oauthClient(config).refresh({ refreshToken });
}

/**
 * Whether a refresh failure proves the grant is dead. Wider than the kit's `isInvalidGrant`: how
 * Cloudflare rejects a revoked grant is unverified, so every OAuth error in a 4xx but 429 keeps
 * marking the account expired until a live test justifies narrowing it. A 4xx without one, such as
 * a WAF challenge, comes from in front of the token endpoint and says nothing about the grant.
 * `invalid_client` is excluded: it is this deployment's client failing authentication, so a bad
 * `CLIENT_SECRET` would expire every account at once, and no reconnect could fix it.
 */
export function isGrantDeath(error: unknown): boolean {
  return isInvalidGrant(error) || (error instanceof OAuthResponseError
    && error.oauthError !== undefined && error.oauthError !== "invalid_client"
    && error.httpStatus >= 400 && error.httpStatus < 500 && error.httpStatus !== 429);
}
