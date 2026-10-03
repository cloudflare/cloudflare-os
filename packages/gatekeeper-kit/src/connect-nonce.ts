/** Nonce generation, comparison, and expiry for gatekeeper connect flows. */

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

const encoder = new TextEncoder();

/**
 * Encodes bytes as lowercase hexadecimal without `Uint8Array.toHex()`, which Node tests lack.
 * @param bytes Bytes to encode.
 * @returns Lowercase hexadecimal.
 */
export function hexEncode(bytes: Uint8Array): string {
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/** @returns A cryptographically random connect nonce. */
export function generateNonce(): string {
  return hexEncode(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
}

/**
 * Compares well-formed strings without data-dependent timing. Ill-formed UTF-16 is rejected because
 * distinct lone surrogates encode to the same bytes.
 * @param a First string.
 * @param b Second string.
 * @returns Whether the strings match.
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
 * Validates and compares a stored nonce. Persisted values are untrusted, so malformed records and
 * non-finite clocks fail closed.
 * @param stored Persisted nonce and expiry.
 * @param presented Nonce supplied by the caller.
 * @param now Current Unix time in milliseconds.
 * @returns Whether the nonce is present, live, and equal.
 *
 * @example
 * ```ts
 * const stored = ctx.storage.kv.get<TimedNonce>("nonce");
 * if (!isLiveNonce(stored, callbackState, Date.now())) {
 *   return new Response("This connection has expired.", { status: 400 });
 * }
 * ctx.storage.kv.delete("nonce");
 * ```
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
