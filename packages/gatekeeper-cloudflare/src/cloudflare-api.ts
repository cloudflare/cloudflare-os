// Thin client over the Cloudflare REST API used by the gatekeeper: resolve the account's identity
// (email) and enumerate accounts. All calls use the user's OAuth access token and are sent through
// `cloudflareUpstream` (cloudflare-upstream.ts), which times every attempt out, sends a GET again
// after a transient failure, follows no redirect and counts each attempt as a subservice metric
// point.

import type { AnsweredWith, CallAnswer } from "@gadgets/gatekeeper-kit/upstream";
import { CLOUDFLARE_API_BASE, cloudflareUpstream } from "./cloudflare-upstream.js";
import { VENDOR_ID } from "./vendor.js";
import { obsContext } from "./observability.js";

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

/**
 * What a GET read: what `accept` returned of its envelope, which is null for an answer the caller
 * is given as a failure, or what `accept` threw on an envelope it could not read. That is not
 * thrown where it is caught, so that the upstream counts the answer by what was read of it.
 */
type CfRead<R> = { value: R | null; threw?: undefined } | { value?: undefined; threw: { error: unknown } };

/**
 * How a GET that was read is counted: a 2xx that reports a failure, holds no result, or holds one
 * the request's own reading refuses or throws on, is an error of the API. Any other answer is
 * counted by its status.
 */
function countedAs(read: CfRead<unknown>, { status }: AnsweredWith): CallAnswer | undefined {
  const failed = read.threw !== undefined || read.value === null;
  return failed && status >= 200 && status < 300 ? { outcome: "error", reason: "api" } : undefined;
}

/**
 * One GET, returning what `accept` reads of its envelope. Null for an answer that is no 2xx, a
 * redirect included, which is logged, for an envelope that reports a failure or holds no result,
 * and for one `accept` refuses with a null: each is counted as `countedAs` says, so that what the
 * caller is given as a failure is counted as one. What `accept` throws is counted so too, and is
 * thrown to the caller as it is.
 */
async function cfRequest<T, R>(
  token: string, path: string, accept: (envelope: CfEnvelope<T>) => R | null,
): Promise<R | null> {
  const read = await cloudflareUpstream.read<CfRead<R>>(`${CLOUDFLARE_API_BASE}${path}`, {
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
  }, async resp => {
    if (!resp.ok) {
      logger.error("cf-gatekeeper GET failed", {
        event: "cloudflare.api.get.failed",
        path, status: resp.status, statusText: resp.statusText,
      });
      return { value: null };
    }
    const data = await resp.json() as CfEnvelope<T>;
    if (!data.success || data.result === undefined) return { value: null };
    try {
      return { value: accept(data) };
    } catch (error) {
      return { threw: { error } };
    }
  }, countedAs);
  if (read.threw) throw read.threw.error;
  return read.value;
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
  return cfRequest<
    { id?: string; email?: string; first_name?: string; last_name?: string } | null, CloudflareIdentity
  >(token, "/user", ({ result: r }) => {
    if (!r || !r.id || !r.email) return null;
    const name = [r.first_name, r.last_name].filter(Boolean).join(" ").trim();
    return {
      id: String(r.id),
      email: r.email,
      displayName: name || r.email.split("@")[0],
    };
  });
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
  // The pages of one walk are summed: one metric point per kind of answer, however many pages.
  return cloudflareUpstream.summed(() => walkAccounts(token));
}

/** One page of `/accounts`: its accounts, and the page size and total the provider reports. */
type AccountsPage = { accounts: CloudflareAccount[]; perPage?: number; total?: number };

/** Walks `/accounts` page by page, to its end or the page cap. */
async function walkAccounts(token: string): Promise<CloudflareAccount[]> {
  const accounts: CloudflareAccount[] = [];
  for (let page = 1; page <= MAX_ACCOUNT_PAGES; page++) {
    const query = new URLSearchParams({
      page: String(page),
      per_page: String(ACCOUNTS_PER_PAGE),
    });
    const listed = await cfRequest<Array<{ id: string; name: string }> | null, AccountsPage>(
      token, `/accounts?${query}`,
      ({ result, result_info }) => result
        ? {
          accounts: result.map(entry => ({ accountId: entry.id, accountName: entry.name })),
          perPage: result_info?.per_page,
          total: result_info?.total_count,
        }
        : null,
    );
    // A failed page mid-walk returns what was gathered rather than nothing: a partial account list is
    // more useful than none, and the failure is already logged by `cfRequest`.
    if (!listed) break;
    accounts.push(...listed.accounts);
    // The provider reports the page size it actually used, which may be lower than requested.
    const perPage = listed.perPage ?? ACCOUNTS_PER_PAGE;
    if (listed.accounts.length < perPage) break;
    const total = listed.total;
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
