/** Number of random bytes in every gatekeeper connect nonce. */
export const NONCE_BYTES = 32;

/** How long an initiation nonce remains valid. */
export const INITIATION_NONCE_LIFETIME_MS = 10 * 60 * 1000;

/** How long an OAuth callback nonce remains valid. */
export const OAUTH_NONCE_LIFETIME_MS = 10 * 60 * 1000;

/** How long an incomplete account connection remains alive. */
export const CONNECT_TIMEOUT_MS = 60 * 60 * 1000;

/** Safety margin used when deciding whether an access token remains usable. */
export const ACCESS_TOKEN_SAFETY_MS = 60 * 1000;

/** Hoisted: `constantTimeEqual` runs on the auth path, and a per-call encoder is pure overhead. */
const encoder = new TextEncoder();

/**
 * Encode bytes as lowercase hexadecimal. Hand-rolled rather than `Uint8Array.toHex()`, which this
 * package's Node suite does not have (`workshop-backend` can use it: workerd only).
 */
export function hexEncode(bytes: Uint8Array): string {
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Generate a cryptographically random connect nonce. */
export function generateNonce(): string {
  return hexEncode(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
}

/**
 * Compare two strings without data-dependent timing when their lengths match. An ill-formed string
 * is refused: UTF-8 maps every lone surrogate to U+FFFD, so `"\uD800"` and `"\uD801"` encode alike,
 * and a capability check may not report distinct strings as equal.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (!a.isWellFormed() || !b.isWellFormed()) return false;
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;
  return crypto.subtle.timingSafeEqual(bufA, bufB);
}

/** A single-use secret and the instant it stops being valid. */
export type TimedNonce = { value: string; expiresAt: number };

/**
 * True when `stored` exists, has not expired at `now`, and matches `presented`.
 *
 * `stored` comes from unvalidated storage, so the shape is checked before comparing: an absent
 * `value` encodes to the same empty buffer an empty `presented` does, which would make a corrupt
 * record admit. The clock is checked for the same reason — `NaN` loses every comparison, so it
 * would read as unexpired. A capability check may not have a fail-open branch.
 */
export function isLiveNonce(
  stored: TimedNonce | undefined,
  presented: string,
  now: number,
): boolean {
  if (typeof stored?.value !== "string" || stored.value === "") return false;
  if (typeof presented !== "string" || presented === "") return false;
  if (!Number.isFinite(stored.expiresAt) || !Number.isFinite(now)) return false;
  if (now >= stored.expiresAt) return false;
  return constantTimeEqual(stored.value, presented);
}
