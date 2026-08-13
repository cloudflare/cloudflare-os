// Thin client over the Cloudflare REST API used by the gatekeeper: resolve the account's identity
// (email) and enumerate accounts. All calls use the user's OAuth access token.

import { VENDOR_ID } from "./vendor.js";
import { obsContext } from "./observability.js";

const API_BASE = "https://api.cloudflare.com/client/v4";

const logger = obsContext.createLogger({
  component: "gatekeeper.cloudflare", vendorId: VENDOR_ID,
});

interface CfEnvelope<T> {
  success: boolean;
  result?: T;
}

async function cfGet<T>(token: string, path: string): Promise<T | null> {
  const resp = await fetch(`${API_BASE}${path}`, {
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (!resp.ok) {
    logger.error("cf-gatekeeper GET failed", {
      event: "cloudflare.api.get.failed",
      path, status: resp.status, statusText: resp.statusText,
    });
    return null;
  }
  const data = await resp.json() as CfEnvelope<T>;
  if (!data.success || data.result === undefined) return null;
  return data.result;
}

export interface CloudflareIdentity {
  /** Cloudflare user id (stable). */
  id: string;
  /** Account email — verified by Cloudflare, so safe to use as a sign-in identity. */
  email: string;
  displayName: string;
}

/**
 * Resolve the connected user's identity via the /user API (requires `user-details.read`). We use
 * this rather than an OIDC userinfo endpoint because the dashboard OAuth client isn't permitted the
 * `openid` scope. Returns null if the email is missing.
 */
export async function fetchIdentity(token: string): Promise<CloudflareIdentity | null> {
  const r = await cfGet<{ id?: string; email?: string; first_name?: string; last_name?: string }>(
    token, "/user",
  );
  if (!r || !r.id || !r.email) return null;
  const name = [r.first_name, r.last_name].filter(Boolean).join(" ").trim();
  return {
    id: String(r.id),
    email: r.email,
    displayName: name || r.email.split("@")[0],
  };
}

export interface CloudflareAccount {
  accountId: string;
  accountName: string;
}

/** List the accounts the token can access. Requires `account-settings.read`. */
export async function listAccounts(token: string): Promise<CloudflareAccount[]> {
  const result = await cfGet<Array<{ id: string; name: string }>>(token, "/accounts");
  if (!result) return [];
  return result.map((a) => ({ accountId: a.id, accountName: a.name }));
}
