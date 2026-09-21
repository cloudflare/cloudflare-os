// Thin client over the Cloudflare REST API used by the top-up flow: enumerate the user's accounts
// and read the account's AI Gateway credit balance.
//
// All calls use the user's OAuth access token (obtained via the connect flow).
//
// Note: connected-user inference is routed through the account's auto-created "default" AI Gateway
// (see ai-models.ts), billed via Unified Billing. We only ever need the account id here — no gateway
// is listed or chosen.

import { createWorkshopLogger } from "../../observability";

const API_BASE = "https://api.cloudflare.com/client/v4";
const logger = createWorkshopLogger("workshop.ai.gateway.billing");

interface CfEnvelope<T> {
  success: boolean;
  result?: T;
  result_info?: { per_page?: number; total_count?: number };
}

export interface CloudflareAccount {
  accountId: string;
  accountName: string;
}

async function cfRequest<T>(token: string, path: string): Promise<CfEnvelope<T> | null> {
  const resp = await fetch(`${API_BASE}${path}`, {
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (!resp.ok) {
    logger.error("cf-account GET failed", {
      event: "cloudflare.account.get.failed",
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

// `/accounts` is paginated and defaults to 20 per page, so an unpaginated GET hides every account
// after the first 20 and the user cannot pick one of them to bill.
const ACCOUNTS_PER_PAGE = 50;
// Bounds the walk at 500 accounts, since the loop is driven by the provider's own paging.
const MAX_ACCOUNT_PAGES = 10;

/** List every account the token can access. Requires the `account-settings.read` OAuth scope. */
export async function listAccounts(token: string): Promise<CloudflareAccount[]> {
  let accounts: CloudflareAccount[] = [];
  for (let page = 1; page <= MAX_ACCOUNT_PAGES; page++) {
    let query = new URLSearchParams({
      page: String(page),
      per_page: String(ACCOUNTS_PER_PAGE),
    });
    let envelope = await cfRequest<Array<{ id: string; name: string }>>(
      token, `/accounts?${query}`,
    );
    // A page that fails mid-walk yields what was gathered: a partial list beats none, and cfRequest
    // has already logged the failure.
    if (!envelope?.result) break;
    let result = envelope.result;
    accounts.push(...result.map((a) => ({ accountId: a.id, accountName: a.name })));
    let perPage = envelope.result_info?.per_page ?? ACCOUNTS_PER_PAGE;
    if (result.length < perPage) break;
    let total = envelope.result_info?.total_count;
    if (total !== undefined && accounts.length >= total) break;
  }
  return accounts;
}

/**
 * Fetch the account's AI Gateway credit balance in USD. Returns null on any upstream failure so
 * callers can distinguish "unknown" from a genuine $0 balance.
 */
export async function fetchCreditBalance(token: string, accountId: string): Promise<number | null> {
  const result = await cfGet<{ balance?: number }>(
    token, `/accounts/${accountId}/ai-gateway-billing/credit_balance`,
  );
  if (!result || typeof result.balance !== "number") return null;
  // The API reports the balance in cents.
  return result.balance / 100;
}
