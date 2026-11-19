// How a user connects: an OAuth 2.0 authorization-code grant with PKCE. The provider's endpoints
// and scopes, and the app's client, built from this Worker's secrets.

import { OAuthClient } from "@gadgets/gatekeeper-kit/oauth-client";
import type { PreviewOAuthEnv } from "@gadgets/gatekeeper-kit/preview-oauth";

/** What the connect flow reads from the Worker's environment. */
export type AuthEnv = PreviewOAuthEnv & {
  /** The OAuth app's client ID. */
  CLIENT_ID?: string;
  /** The OAuth app's client secret. */
  CLIENT_SECRET?: string;
};

// STOP(oauth-endpoints): The provider's authorization and token endpoints, and its revocation
// endpoint if it has one (then call it in `UserAccount.revoke`).
/** The browser-facing authorization page. */
export const AUTHORIZE_URL = "https://acme.example/oauth/authorize";
/** The token endpoint, for code exchange and refresh. */
export const TOKEN_URL = "https://acme.example/oauth/token";

// STOP(oauth-scopes): Exactly what the endpoints this gatekeeper calls require. With a generated
// schema, each operation's comment names the scopes the provider's description declares for it.
/** The scopes every connection asks for. */
export const SCOPES = ["items.read", "items.write"] as const;

/** The required scopes a grant lacks. */
export function missingScopes(granted: readonly string[]): string[] {
  const have = new Set(granted);
  return SCOPES.filter(scope => !have.has(scope));
}

// STOP(oauth-token-lifetime): The provider's documented access-token lifetime.
/** The access-token lifetime, for a token response that omits `expires_in`. */
const ACCESS_TOKEN_SECONDS = 60 * 60;

/** Whether the OAuth app's client is configured. */
export function isConfigured(env: AuthEnv): boolean {
  return Boolean(env.CLIENT_ID && env.CLIENT_SECRET);
}

/** The OAuth app's client. */
export function oauthClient(env: AuthEnv): OAuthClient {
  if (!env.CLIENT_ID || !env.CLIENT_SECRET) throw new Error("The Acme Service gatekeeper is not configured.");
  return new OAuthClient({
    label: "Acme Service",
    // STOP(oauth-client-auth): How the token endpoint takes the client's credentials.
    client: { method: "post", id: env.CLIENT_ID, secret: env.CLIENT_SECRET },
    tokenEndpoint: TOKEN_URL,
    authorizationEndpoint: AUTHORIZE_URL,
    defaultExpiresIn: ACCESS_TOKEN_SECONDS,
  });
}
