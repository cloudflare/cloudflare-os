/** The initiation-to-OAuth nonce handoff for gatekeeper connect flows. */

import {
  generateNonce,
  INITIATION_NONCE_LIFETIME_MS,
  isLiveNonce,
  OAUTH_NONCE_LIFETIME_MS,
  type TimedNonce,
} from "./connect-nonce";

/** The Durable Object KV surface this module needs. */
export type ConnectNonceKv = {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
  delete(key: string): void;
};

/** KV key holding the in-flight connect nonce. Unchanged from every current gatekeeper. */
export const NONCE_KEY = "nonce";

/** Stages in the two-step connect handshake. */
export type ConnectStage = "initiation" | "oauth";

/** Fields the record owns; provider metadata may not redeclare them. */
const RESERVED_KEYS = ["value", "expiresAt", "stage"] as const;

/** Reserved record fields that provider metadata may not declare. */
export type NonceExtra = { [K in (typeof RESERVED_KEYS)[number]]?: never };

/** A stored nonce and optional provider-owned state for one connect attempt. */
export type StoredNonce<Extra extends object = Record<never, never>> = TimedNonce &
  { stage: ConnectStage } & Extra;

function rejectReservedKeys(extra: object): void {
  for (const key of RESERVED_KEYS) {
    if (key in extra) {
      throw new Error(`Connect attempt metadata may not carry the reserved key "${key}".`);
    }
  }
}

/**
 * Stores a connect-flow initiation nonce.
 * @param kv Durable Object nonce storage.
 * @param initiationNonce Nonce carried by the connect link.
 * @param now Current Unix time in milliseconds.
 */
export function putInitiation(kv: ConnectNonceKv, initiationNonce: string, now: number): void {
  kv.put<StoredNonce>(NONCE_KEY, {
    value: initiationNonce,
    expiresAt: now + INITIATION_NONCE_LIFETIME_MS,
    stage: "initiation",
  });
}

/**
 * Advances a valid connect attempt to OAuth.
 * @param kv Durable Object nonce storage.
 * @param initiationNonce Nonce carried by the connect link.
 * @param now Current Unix time in milliseconds.
 * @param extra Provider metadata to retain through the callback.
 * @returns The OAuth nonce, or `null` when invalid.
 *
 * @example
 * ```ts
 * putInitiation(ctx.storage.kv, linkNonce, Date.now());
 *
 * // On form submission, rotate the link nonce and retain callback state in one write.
 * const state = advanceToOAuth(
 *   ctx.storage.kv, linkNonce, Date.now(), { codeVerifier, returnTo },
 * );
 * if (state === null) {
 *   return htmlResponse(errorPageHtml("Connection expired", "Start again."), 400);
 * }
 * return Response.redirect(authorizationUrl({ state }));
 * ```
 */
export function advanceToOAuth<Extra extends object>(
  kv: ConnectNonceKv,
  initiationNonce: string,
  now: number,
  extra?: Extra & NonceExtra,
): string | null {
  // A reserved key would be silently overwritten by the record's own fields.
  if (extra) rejectReservedKeys(extra);

  const stored = kv.get<StoredNonce>(NONCE_KEY);
  if (stored?.stage !== "initiation" || !isLiveNonce(stored, initiationNonce, now)) return null;

  const oauthNonce = generateNonce();
  kv.put(NONCE_KEY, {
    ...extra,
    value: oauthNonce,
    expiresAt: now + OAUTH_NONCE_LIFETIME_MS,
    stage: "oauth",
  } satisfies StoredNonce);
  return oauthNonce;
}

/**
 * Claims a valid OAuth callback.
 * @param kv Durable Object nonce storage.
 * @param oauthNonce Provider-returned nonce.
 * @param now Current Unix time in milliseconds.
 * @returns Stored provider metadata, or `null` when invalid.
 */
export function claimOAuth<Extra extends object = Record<never, never>>(
  kv: ConnectNonceKv,
  oauthNonce: string,
  now: number,
): StoredNonce<Extra> | null {
  const stored = kv.get<StoredNonce<Extra>>(NONCE_KEY);
  if (stored?.stage !== "oauth" || !isLiveNonce(stored, oauthNonce, now)) return null;

  kv.delete(NONCE_KEY);
  return stored;
}
