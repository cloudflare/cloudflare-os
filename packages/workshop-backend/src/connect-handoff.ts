// The connect handoff: how a finished gatekeeper connect flow is bound to the browser that started
// it. A connect URL is a bearer capability, so the gatekeeper's final page navigates the popup to the
// Workshop's own /connect/handoff page with a single-use ticket in the URL fragment. That page
// redeems the ticket over the popup's own authenticated session
// (UserDurableObject.completeConnectHandoff) together with the nonce the Workshop tab put into the
// popup's sessionStorage when the flow started, and only then is the staged grant activated.

/**
 * How long a staged connect / reconnect waits for its ticket. The handoff page delivers the ticket
 * the instant it loads, so anything not redeemed within this window was opened somewhere the
 * Workshop could not reach, and the staged grant is dropped (and, for a connect, revoked).
 */
export const PENDING_HANDOFF_LIFETIME_MS = 2 * 60 * 1000;

/**
 * How long a started flow's nonce stays redeemable. A ticket can legitimately arrive up to the
 * gatekeepers' initiation-nonce lifetime (10 minutes, e.g. spent on an endpoint form) plus the fresh
 * OAuth-nonce lifetime (10 minutes, at the consent screen) plus the handoff lifetime (2 minutes)
 * after the flow started; rounded up.
 */
export const CONNECT_FLOW_LIFETIME_MS = 30 * 60 * 1000;

/**
 * The Workshop origin the completion page navigates the popup to with its ticket. Comes from
 * deployment configuration only: a request's `Origin` header or anything the client asserts could
 * route the ticket to an attacker-controlled origin, so neither is consulted. Fails closed when
 * unset.
 */
export function handoffTargetOrigin(env: Cloudflare.Env): string {
  if (!env.PUBLIC_BASE_URL) {
    throw new Error("PUBLIC_BASE_URL is not configured, so account connections cannot complete.");
  }
  return new URL(env.PUBLIC_BASE_URL).origin;
}

/**
 * Mint a 256-bit bearer secret plus the SHA-256 (hex) under which it is stored, so a leaked storage
 * dump reveals nothing redeemable. Shared by session tokens, handoff tickets and flow nonces.
 */
export async function newSecretToken(): Promise<{ secret: Uint8Array; hash: string }> {
  let secret = new Uint8Array(32);
  crypto.getRandomValues(secret);
  return { secret, hash: await hashSecret(secret) };
}

/** SHA-256 hex of a secret, the form in which secrets are looked up at rest. */
export async function hashSecret(secret: Uint8Array): Promise<string> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", secret)).toHex();
}

/**
 * The hash under which a secret presented by a client is looked up, or undefined when the value is
 * not the 64 lowercase hex characters a ticket or nonce takes (nothing is stored under such a key).
 */
export function hashPresentedSecret(hex: string): Promise<string> | undefined {
  return /^[0-9a-f]{64}$/.test(hex) ? hashSecret(Uint8Array.fromHex(hex)) : undefined;
}
