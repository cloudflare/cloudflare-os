// Thin client over the Cloudflare REST API used by the gatekeeper: resolve the account's identity
// (email) and enumerate accounts. All calls use the user's OAuth access token.

import { VENDOR_ID } from "./vendor.js";
import { obsContext } from "./observability.js";

const API_BASE = "https://api.cloudflare.com/client/v4";

const logger = obsContext.createLogger({
  component: "gatekeeper.cloudflare", vendorId: VENDOR_ID,
});

interface CfResultInfo {
  page?: number;
  per_page?: number;
  count?: number;
  total_count?: number;
}

interface CfEnvelope<T> {
  success: boolean;
  result?: T;
  result_info?: CfResultInfo;
}

/** One GET, returning the whole envelope so a paginated caller can read `result_info`. */
async function cfRequest<T>(token: string, path: string): Promise<CfEnvelope<T> | null> {
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
  return data;
}

async function cfGet<T>(token: string, path: string): Promise<T | null> {
  return (await cfRequest<T>(token, path))?.result ?? null;
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

// `/accounts` is paginated and defaults to 20 per page, so a single unpaginated GET silently hides
// every account after the first 20 -- they cannot be selected, and a search for one finds nothing.
const ACCOUNTS_PER_PAGE = 50;
// Bounds the walk at 500 accounts. Far past any real user, and a cap is required because the loop is
// driven by the provider's own paging.
const MAX_ACCOUNT_PAGES = 10;

/**
 * List every account the token can access. Requires `account-settings.read`.
 *
 * Deliberately fetches all pages and leaves matching to the caller rather than passing the user's
 * query to the endpoint's `name` parameter: `name` is undocumented as to whether it matches exactly
 * or by substring, and there is no `name.contains` variant, so pushing an exact match server-side
 * would silently break the substring search the configurator offers today.
 */
export async function listAccounts(token: string): Promise<CloudflareAccount[]> {
  const accounts: CloudflareAccount[] = [];
  for (let page = 1; page <= MAX_ACCOUNT_PAGES; page++) {
    const query = new URLSearchParams({
      page: String(page),
      per_page: String(ACCOUNTS_PER_PAGE),
    });
    const envelope = await cfRequest<Array<{ id: string; name: string }>>(
      token, `/accounts?${query}`,
    );
    // A failed page mid-walk returns what was gathered rather than nothing: a partial account list is
    // more useful than none, and the failure is already logged by `cfRequest`.
    if (!envelope?.result) break;
    const result = envelope.result;
    accounts.push(...result.map(entry => ({ accountId: entry.id, accountName: entry.name })));
    // The provider reports the page size it actually used, which may be lower than requested.
    const perPage = envelope.result_info?.per_page ?? ACCOUNTS_PER_PAGE;
    if (result.length < perPage) break;
    const total = envelope.result_info?.total_count;
    if (total !== undefined && accounts.length >= total) break;
    if (page === MAX_ACCOUNT_PAGES) {
      logger.warn("stopped listing Cloudflare accounts at the page cap", {
        event: "cloudflare.accounts.list.truncated",
        accountsListed: accounts.length, totalCount: total,
      });
    }
  }
  return accounts;
}
