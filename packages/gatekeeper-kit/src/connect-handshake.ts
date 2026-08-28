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

/**
 * The record's own fields, forbidden in provider metadata. The record stays flat rather than
 * nesting metadata under a property, because the flat shape is what keeps records written by
 * existing gatekeepers readable — so the reserved keys are excluded instead of the shape changed.
 * Intersected with the caller's own type rather than used as a constraint, which would make it a
 * weak type and defeat inference.
 */
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

/** Record the initiation nonce carried by the link handed to the user. */
export function putInitiation(kv: ConnectNonceKv, initiationNonce: string, now: number): void {
  kv.put<StoredNonce>(NONCE_KEY, {
    value: initiationNonce,
    expiresAt: now + INITIATION_NONCE_LIFETIME_MS,
    stage: "initiation",
  });
}

/**
 * Consume the initiation nonce and mint the OAuth-stage nonce in one uninterruptible step.
 * Returns null when the presented nonce is absent, expired, of the wrong stage, or does not match.
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
 * Consume the OAuth-stage nonce, returning the record it replaced (so callers can read `extra`
 * off it) or null when it does not validate. Deletes the record on success. `Extra` is the caller's
 * assertion about what it stored, like every other typed read of durable storage.
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
