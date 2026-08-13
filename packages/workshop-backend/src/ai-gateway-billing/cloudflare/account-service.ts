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
}

export interface CloudflareAccount {
  accountId: string;
  accountName: string;
}

async function cfGet<T>(token: string, path: string): Promise<T | null> {
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
  return data.result;
}

/** List the accounts the token can access. Requires the `account-settings.read` OAuth scope. */
export async function listAccounts(token: string): Promise<CloudflareAccount[]> {
  const result = await cfGet<Array<{ id: string; name: string }>>(token, "/accounts");
  if (!result) return [];
  return result.map((a) => ({ accountId: a.id, accountName: a.name }));
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
