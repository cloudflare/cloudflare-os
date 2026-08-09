// The authorization-code flow: nonce handling, the authorize URL, and the code exchange.
//
// Kept separate from identity.ts (which verifies what the provider says) so the flow's own
// anti-replay rules can be read and tested on their own.

import { OidcConfig, OidcEndpoints, resolveScopes } from "./identity.js";

const NONCE_BYTES = 32;

// Both stages are short-lived: the user is in the middle of a redirect, not coming back tomorrow.
export const INITIATION_NONCE_LIFETIME_MS = 10 * 60 * 1000;
export const OAUTH_NONCE_LIFETIME_MS = 10 * 60 * 1000;

/**
 * A nonce plus the stage it belongs to.
 *
 * Two stages, following the same pattern as the other OAuth connectors here. The `initiation`
 * nonce is minted when the Workshop asks for a URL and spent when the user actually visits it;
 * only then is the `oauth` nonce minted and carried through the redirect as `state`. Splitting
 * them means a captured authorize URL cannot be replayed after its first use, and a captured
 * callback URL cannot be replayed at all.
 */
export interface StoredNonce {
  value: string;
  expiresAt: number;
  stage: "initiation" | "oauth";
}

export function generateNonce(): string {
  // Hand-rolled rather than `Uint8Array.prototype.toHex`, which workerd has but older runtimes
  // (including the Node the tests run under) do not. Same approach as mcp-shared/src/util.ts.
  return [...crypto.getRandomValues(new Uint8Array(NONCE_BYTES))]
      .map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Compares two nonces without leaking their contents through timing.
 *
 * `crypto.subtle.timingSafeEqual` is a workerd extension rather than standard WebCrypto, so it is
 * absent under a plain Node test runner. The fallback is a real constant-time comparison, not a
 * test stub: it accumulates the XOR of every byte and branches only on length, which is already
 * public. Production runs the workerd path.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;

  let subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (a: ArrayBufferView, b: ArrayBufferView) => boolean;
  };
  if (subtle.timingSafeEqual) return subtle.timingSafeEqual(bufA, bufB);

  let diff = 0;
  for (let i = 0; i < bufA.byteLength; i++) diff |= bufA[i] ^ bufB[i];
  return diff === 0;
}

/** Whether a stored nonce matches, is unexpired, and is at the expected stage. */
export function nonceIsValid(
  stored: StoredNonce | undefined | null,
  presented: string,
  stage: StoredNonce["stage"],
  now: number = Date.now(),
): boolean {
  if (!stored || stored.stage !== stage || now >= stored.expiresAt) return false;
  return constantTimeEqual(stored.value, presented);
}

/**
 * Builds the provider's authorize URL.
 *
 * `state` carries the oauth-stage nonce so the callback can be tied back to this DO, and `nonce`
 * is the OIDC replay guard the provider echoes into the ID token.
 */
export function authorizeUrl(args: {
  endpoints: OidcEndpoints;
  config: OidcConfig;
  redirectUri: string;
  state: string;
  idTokenNonce: string;
}): string {
  let url = new URL(args.endpoints.authorization);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", args.config.clientId);
  url.searchParams.set("redirect_uri", args.redirectUri);
  url.searchParams.set("scope", resolveScopes(args.config.scopes));
  url.searchParams.set("state", args.state);
  url.searchParams.set("nonce", args.idTokenNonce);
  return url.toString();
}

/** The ID token returned by a successful code exchange. */
export interface TokenResponse {
  idToken: string;
}

/**
 * Exchanges an authorization code for tokens.
 *
 * Credentials go in the POST body rather than an Authorization header: `client_secret_post` is
 * the form every targeted IdP accepts, whereas support for `client_secret_basic` varies with how
 * the client was registered.
 *
 * Only the ID token is kept. This connector authenticates and nothing else — it holds no resource
 * scopes, so an access token would be a credential stored for no purpose.
 */
export async function exchangeCode(args: {
  code: string;
  endpoints: OidcEndpoints;
  config: OidcConfig;
  redirectUri: string;
  fetchImpl?: typeof fetch;
}): Promise<TokenResponse> {
  let body = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: args.redirectUri,
    client_id: args.config.clientId,
    client_secret: args.config.clientSecret,
  });

  let response = await (args.fetchImpl ?? fetch)(args.endpoints.token, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json",
    },
    body,
  });

  if (!response.ok) {
    // The provider's error body can echo the code or client_secret, so it is deliberately not
    // included here — the status is enough to distinguish a misconfigured client from a
    // network-level failure.
    throw new Error(`Token exchange failed (HTTP ${response.status}).`);
  }

  let payload = await response.json() as Record<string, unknown>;
  if (typeof payload.id_token !== "string" || !payload.id_token) {
    throw new Error(
        "The identity provider did not return an id_token. Ensure the client is configured for " +
        "the OIDC authorization-code flow with the 'openid' scope.");
  }
  return { idToken: payload.id_token };
}
