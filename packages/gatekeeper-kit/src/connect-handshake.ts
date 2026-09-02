import {
  constantTimeEqual,
  generateNonce,
  INITIATION_NONCE_LIFETIME_MS,
  isLiveNonce,
  NONCE_BYTES,
  OAUTH_NONCE_LIFETIME_MS,
  type TimedNonce,
} from "./connect-nonce";
import type { KvMutable } from "./kv";

/** The Durable Object KV surface this module needs. */
export type ConnectNonceKv = KvMutable;

/** KV key holding the in-flight connect nonce. Unchanged from every current gatekeeper. */
export const NONCE_KEY = "nonce";

const OAUTH_COOKIE_PREFIX = "__Host-gatekeeper-oauth-";
const NON_HEX = /[^0-9a-f]/;
const OAUTH_COOKIE_MAX_AGE = Math.ceil(OAUTH_NONCE_LIFETIME_MS / 1000);
const OAUTH_COOKIE_SECURITY = "Secure; HttpOnly; SameSite=Lax";

function isNonce(value: string): boolean {
  return value.length === NONCE_BYTES * 2 && !NON_HEX.test(value);
}

function oauthCookieName(nonce: string): string | undefined {
  return isNonce(nonce) ? OAUTH_COOKIE_PREFIX + nonce : undefined;
}

/**
 * Creates an OAuth browser-binding cookie. Its secret is independent of OAuth state, which leaves the
 * browser during the redirect.
 * @param nonce OAuth callback nonce.
 * @param cookieSecret Browser-binding secret.
 * @returns A hardened `Set-Cookie` value.
 */
export function oauthBrowserCookie(nonce: string, cookieSecret: string): string {
  if (!isNonce(cookieSecret)) throw new TypeError("Invalid OAuth cookie secret.");
  const name = oauthCookieName(nonce);
  if (!name) throw new TypeError("Invalid OAuth nonce.");
  return `${name}=${cookieSecret}; Path=/; `
    + `Max-Age=${OAUTH_COOKIE_MAX_AGE}; ${OAUTH_COOKIE_SECURITY}`;
}

/**
 * Expires an OAuth browser-binding cookie.
 * @param nonce OAuth callback nonce.
 * @returns A clearing `Set-Cookie` value, or `undefined` for an invalid nonce.
 */
export function clearOAuthBrowserCookie(nonce: string): string | undefined {
  const name = oauthCookieName(nonce);
  if (!name) return undefined;
  return `${name}=; Path=/; Max-Age=0; ${OAUTH_COOKIE_SECURITY}`;
}

/**
 * Reads the browser-binding secret for an OAuth nonce.
 * @param req OAuth callback request.
 * @param nonce OAuth callback nonce.
 * @returns The cookie secret, or `undefined` when absent.
 */
export function readOAuthBrowserCookie(req: Request, nonce: string): string | undefined {
  const name = oauthCookieName(nonce);
  if (!name) return undefined;
  const prefix = `${name}=`;
  for (const pair of req.headers.get("cookie")?.split(";") ?? []) {
    const cookie = pair.trim();
    if (cookie.startsWith(prefix)) return cookie.slice(prefix.length);
  }
  return undefined;
}

/** Stages in the two-step connect handshake. */
export type ConnectStage = "initiation" | "oauth";

/** Fields the record owns; provider metadata may not redeclare them. */
const RESERVED_KEYS = ["value", "expiresAt", "stage", "cookieSecret"] as const;

/** Reserved record fields that provider metadata may not declare. */
export type NonceExtra = { [K in (typeof RESERVED_KEYS)[number]]?: never };

/** Stored state for one connect attempt. `cookieSecret` exists only during OAuth. */
export type StoredNonce<Extra extends object = Record<never, never>> = TimedNonce &
  { stage: ConnectStage; cookieSecret?: string } & Extra;

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

/** The provider's `state` value for one attempt, and the secret its browser cookie carries. */
export type OAuthAttempt = { oauthNonce: string; cookieSecret: string };

/**
 * Advances a valid connect attempt to OAuth.
 * @param kv Durable Object nonce storage.
 * @param initiationNonce Nonce carried by the connect link.
 * @param now Current Unix time in milliseconds.
 * @param extra Provider metadata to retain through the callback.
 * @returns The OAuth nonce and cookie secret, or `null` when invalid.
 */
export function advanceToOAuth<Extra extends object>(
  kv: ConnectNonceKv,
  initiationNonce: string,
  now: number,
  extra?: Extra & NonceExtra,
): OAuthAttempt | null {
  // A reserved key would be silently overwritten by the record's own fields.
  if (extra) rejectReservedKeys(extra);

  const stored = kv.get<StoredNonce>(NONCE_KEY);
  if (stored?.stage !== "initiation" || !isLiveNonce(stored, initiationNonce, now)) return null;

  const attempt = { oauthNonce: generateNonce(), cookieSecret: generateNonce() };
  kv.put(NONCE_KEY, {
    ...extra,
    value: attempt.oauthNonce,
    expiresAt: now + OAUTH_NONCE_LIFETIME_MS,
    stage: "oauth",
    cookieSecret: attempt.cookieSecret,
  } satisfies StoredNonce);
  return attempt;
}

/**
 * Claims a valid OAuth callback.
 * @param kv Durable Object nonce storage.
 * @param oauthNonce Provider-returned nonce.
 * @param cookieSecret Browser-binding secret.
 * @param now Current Unix time in milliseconds.
 * @returns Stored provider metadata, or `null` when invalid.
 */
export function claimOAuth<Extra extends object = Record<never, never>>(
  kv: ConnectNonceKv,
  oauthNonce: string,
  cookieSecret: string,
  now: number,
): StoredNonce<Extra> | null {
  const stored = kv.get<StoredNonce<Extra>>(NONCE_KEY);
  if (stored?.stage !== "oauth" || !isLiveNonce(stored, oauthNonce, now)) return null;
  // Checked before the delete, so a forged cookie leaves the live attempt claimable, exactly as a
  // wrong nonce does. Absent on a record an earlier deploy wrote, which fails closed.
  if (stored.cookieSecret === undefined || !constantTimeEqual(stored.cookieSecret, cookieSecret)) {
    return null;
  }

  kv.delete(NONCE_KEY);
  // The secret is the record's, not the caller's: it must not travel on to the token exchange.
  delete stored.cookieSecret;
  return stored;
}
