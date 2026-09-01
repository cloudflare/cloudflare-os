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

/** Nonce-shaped, and so cookie-safe by construction. */
function isNonce(value: string): boolean {
  return value.length === NONCE_BYTES * 2 && !NON_HEX.test(value);
}

function oauthCookieName(nonce: string): string | undefined {
  return isNonce(nonce) ? OAUTH_COOKIE_PREFIX + nonce : undefined;
}

/**
 * A `Set-Cookie` value binding the OAuth callback to the browser that began the redirect. The value
 * is the attempt's `cookieSecret`, never the nonce or a constant: the nonce travels to the provider
 * as `state`, so a cookie derived from it would be forgeable by anyone holding the callback URL.
 */
export function oauthBrowserCookie(nonce: string, cookieSecret: string): string {
  if (!isNonce(cookieSecret)) throw new TypeError("Invalid OAuth cookie secret.");
  const name = oauthCookieName(nonce);
  if (!name) throw new TypeError("Invalid OAuth nonce.");
  return `${name}=${cookieSecret}; Path=/; `
    + `Max-Age=${OAUTH_COOKIE_MAX_AGE}; ${OAUTH_COOKIE_SECURITY}`;
}

/**
 * A `Set-Cookie` value expiring the browser binding after the OAuth callback, or `undefined` when
 * `nonce` names no cookie. Degrades rather than throws, like `readOAuthBrowserCookie`: this is
 * added to every terminal response, including the ones refusing a malformed `state`.
 */
export function clearOAuthBrowserCookie(nonce: string): string | undefined {
  const name = oauthCookieName(nonce);
  if (!name) return undefined;
  return `${name}=; Path=/; Max-Age=0; ${OAUTH_COOKIE_SECURITY}`;
}

/** The browser-binding secret this callback presents, if any. Absence is refusable before the
 *  account DO is touched; `claimOAuth` holds the secret needed to verify the value. */
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

/**
 * The record's own fields, forbidden in provider metadata. The record stays flat rather than
 * nesting metadata under a property, because the flat shape is what keeps records written by
 * existing gatekeepers readable — so the reserved keys are excluded instead of the shape changed.
 * Intersected with the caller's own type rather than used as a constraint, which would make it a
 * weak type and defeat inference.
 */
export type NonceExtra = { [K in (typeof RESERVED_KEYS)[number]]?: never };

/** A stored nonce and optional provider-owned state for one connect attempt. `cookieSecret` is
 *  present only at the OAuth stage; the initiation link has its own navigation fence. */
export type StoredNonce<Extra extends object = Record<never, never>> = TimedNonce &
  { stage: ConnectStage; cookieSecret?: string } & Extra;

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

/** The provider's `state` value for one attempt, and the secret its browser cookie carries. */
export type OAuthAttempt = { oauthNonce: string; cookieSecret: string };

/**
 * Consume the initiation nonce and mint the OAuth-stage nonce in one uninterruptible step.
 * Returns null when the presented nonce is absent, expired, of the wrong stage, or does not match.
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
 * Consume the OAuth-stage nonce, returning the record it replaced (so callers can read `extra`
 * off it) or null when it does not validate. Deletes the record on success. `Extra` is the caller's
 * assertion about what it stored, like every other typed read of durable storage.
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
