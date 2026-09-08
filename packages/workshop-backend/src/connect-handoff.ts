// The connect handoff: how a finished gatekeeper connect flow is bound to the browser that started
// it. A connect URL is a bearer capability, so the gatekeeper's final page delivers a single-use
// ticket to the Workshop — over a same-origin BroadcastChannel for a connect popup (which the
// Workshop disowns before navigating, so the provider never holds its window), or by postMessage to
// its opener for sign-in — and the Workshop activates the staged grant only when that ticket is
// redeemed over the initiating user's own session (UserDurableObject.completeConnectHandoff).

/**
 * How long a staged connect / reconnect waits for its ticket. The handoff page delivers the ticket
 * the instant it loads, so anything not redeemed within this window was opened somewhere the
 * Workshop could not reach, and the staged grant is dropped (and, for a connect, revoked).
 */
export const PENDING_HANDOFF_LIFETIME_MS = 2 * 60 * 1000;

/**
 * The Workshop origin the handoff page must post its ticket to. Comes from deployment configuration
 * only: a request's `Origin` header or anything the client asserts could route the ticket to an
 * attacker-controlled opener, so neither is consulted. Fails closed when unset.
 */
export function handoffTargetOrigin(env: Cloudflare.Env): string {
  if (!env.PUBLIC_BASE_URL) {
    throw new Error("PUBLIC_BASE_URL is not configured, so account connections cannot complete.");
  }
  return new URL(env.PUBLIC_BASE_URL).origin;
}

/**
 * Mint a 256-bit bearer secret plus the SHA-256 (hex) under which it is stored, so a leaked storage
 * dump reveals nothing redeemable. Shared by session tokens and handoff tickets.
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
