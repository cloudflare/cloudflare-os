/** Connect-flow handshake state: the initiation-to-OAuth nonce handoff and the once-only `complete()`. */

import {
  generateNonce,
  INITIATION_NONCE_LIFETIME_MS,
  isLiveNonce,
  OAUTH_NONCE_LIFETIME_MS,
  type TimedNonce,
} from "./connect-nonce";
import type { KvMutable } from "./kv";

/** The Durable Object KV surface this module needs. */
export type ConnectNonceKv = KvMutable;

/** KV key holding the in-flight connect nonce. Unchanged from every current gatekeeper. */
export const NONCE_KEY = "nonce";

// Unchanged from the gatekeepers that already record the attempt.
const CONNECT_ATTEMPTED_KEY = "connectAttempted";

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
 * Claims a valid OAuth callback. The claim is irrevocable: the nonce is consumed whatever happens
 * next, so a consumer whose `complete()` or credential persistence fails after the provider
 * exchange must roll back anything it just persisted itself — the storage shape is provider-owned,
 * and a second callback with the same nonce will not arrive.
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

/**
 * Whether this account has called `GatekeeperConnectCallback.complete()`. Each call stages another
 * Workshop ticket, and an unredeemed ticket revokes the account, so a second call can destroy the
 * connection the first made, even when the first threw or lost its reply. Refuse the connect when
 * this is true.
 * @param kv Durable Object storage.
 * @returns Whether the account's one `complete()` was attempted.
 */
export function isConnectAttempted(kv: ConnectNonceKv): boolean {
  return kv.get<boolean>(CONNECT_ATTEMPTED_KEY) === true;
}

/**
 * Records the account's one `complete()` attempt. Re-check `isConnectAttempted`, write the live
 * credential, and mark with no `await` among them, then await `complete()`. Never cleared; revoking
 * the account deletes it with the rest of storage.
 * @param kv Durable Object storage.
 *
 * @example
 * ```ts
 * if (isConnectAttempted(kv)) return refuse();
 * creds.connect(grant);
 * markConnectAttempted(kv);
 * const handoff = await callback.complete(user);
 * ```
 */
export function markConnectAttempted(kv: ConnectNonceKv): void {
  kv.put(CONNECT_ATTEMPTED_KEY, true);
}
