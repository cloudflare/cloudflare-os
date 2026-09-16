// Single-use secrets in the connect flow, and the timings that bound them.
//
// The connect handshake is reached over plain HTTP with no session of its own, so the URL path is
// the authorization: whoever holds the nonce is treated as the person who started the flow. Shared
// so a connector cannot quietly weaken the handshake with a shorter nonce or a longer lifetime.

import { hexEncode } from "./util.js";

/**
 * Length of a connect nonce. 32 bytes (64 hex characters) is far beyond guessing, and the connect
 * handler checks the encoded length before doing any work.
 */
export const NONCE_BYTES = 32;

/** How long a link handed to the user stays usable. Long enough to read, short enough to matter. */
export const INITIATION_NONCE_LIFETIME_MS = 10 * 60 * 1000;

/** How long an in-flight OAuth authorization may take before its state is discarded. */
export const OAUTH_NONCE_LIFETIME_MS = 10 * 60 * 1000;

/** Margin before an access token's stated expiry at which it is refreshed anyway. */
export const ACCESS_TOKEN_SAFETY_MS = 60 * 1000;

/**
 * Assumed access-token lifetime when the server states none. `expires_in` is optional per RFC 6749,
 * and an unknown expiry has to be treated as near rather than as never.
 */
export const DEFAULT_TOKEN_LIFETIME_S = 60 * 60;

/** How long an account that never finished connecting waits before deleting itself. */
export const CONNECT_TIMEOUT_MS = 60 * 60 * 1000;

export function generateNonce(): string {
  return hexEncode(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
}

/**
 * Compares two hex-encoded nonces without leaking how far the match got.
 *
 * The length check is not a leak: nonce length is fixed and public.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
