// Resolves AI Gateway billing state for a user's connected Cloudflare account.
//
// The OAuth tokens live in the connected Cloudflare *gatekeeper* account; we obtain a usable access
// token from it (getUsableAccessToken), then resolve which account to bill and read the credit
// balance (with a short cache). Connected-user inference is routed through the account's auto-created
// "default" AI Gateway (see ai-models.ts), billed via Unified Billing.
//
// Operates against a UserDurableObject stub so it can be called from the overseer (usage checks) and
// from the RPC layer (status display).

import { listAccounts, fetchCreditBalance } from "./account-service.js";
import type { UserDurableObject } from "../../user.js";

// Treat a cached balance as fresh for this long.
const CREDITS_CACHE_TTL_MS = 5 * 60 * 1000;

type UserStub = DurableObjectStub<UserDurableObject>;

/** Public-safe connection status for display and for the usage decision. */
export interface CloudflareConnectionStatus {
  connected: boolean;
  accountId?: string;
  accountName?: string;
  balance: number | null;
  /**
   * True when connected but the grant sees multiple Cloudflare accounts and none is chosen yet.
   * The client must prompt the user to select one via selectAccount().
   */
  needsAccountSelection?: boolean;
}

/** A Cloudflare account the connected grant can access. */
export interface CloudflareAccountOption {
  accountId: string;
  accountName: string;
}

/**
 * Routing details to bill a user's own Cloudflare account for inference (BYOK path once the free
 * tier is spent). Inference is routed through the account's "default" AI Gateway.
 */
export interface ByokGatewayRouting {
  accountId: string;
  /** The user's Cloudflare access token, used as the authorization. */
  apiKey: string;
}

/**
 * Connection resolution result. `accessToken`/`accountId` are present only when connected with a
 * resolved account; `accessToken` is sensitive (never send it to the client).
 */
export interface ResolvedConnection {
  status: CloudflareConnectionStatus;
  accessToken?: string;
  accountId?: string;
}

// Get a usable access token from the connected Cloudflare gatekeeper account, or null if the user
// hasn't connected Cloudflare or the connection is broken/expired.
async function getUsableAccessToken(userStub: UserStub): Promise<string | null> {
  // The returned stub is a server-side RPC stub (not an auto-disposed call parameter), so it must be
  // disposed to avoid leaking on every call (this runs on the hot path — see resolveConnection).
  using account = await userStub.getCloudflareGatekeeperAccount();
  if (!account) return null;
  return await account.getUsableAccessToken();
}

/**
 * Resolve connection status + balance (cached when fresh), auto-selecting the account when exactly
 * one is accessible. Also surfaces the usable access token + resolved account id so a hot-path
 * caller can derive BYOK routing without re-reading. Never throws; returns a safe default.
 */
export async function resolveConnection(
  _env: Cloudflare.Env, userStub: UserStub,
): Promise<ResolvedConnection> {
  try {
    // Dispose the connected-account stub at the end of this call (it's a returned RPC stub, not an
    // auto-disposed parameter). This runs on every agent turn and UI refresh.
    using account = await userStub.getCloudflareGatekeeperAccount();
    if (!account) return { status: { connected: false, balance: null } };

    const accessToken = await account.getUsableAccessToken();
    if (!accessToken) {
      // Connected, but the token is broken/expired — treat as connected with unknown balance.
      return { status: { connected: true, balance: null } };
    }

    const billing = await userStub.getCloudflareBilling();
    let accountId = billing?.accountId;
    let accountName = billing?.accountName;
    let needsAccountSelection = false;
    if (!accountId) {
      const accounts = await listAccounts(accessToken);
      if (accounts.length === 1) {
        accountId = accounts[0].accountId;
        accountName = accounts[0].accountName;
        await userStub.setCloudflareAccountSelection(accountId, accountName);
      } else if (accounts.length > 1) {
        needsAccountSelection = true;
      }
    }

    const base = { connected: true as const, accountId, accountName, needsAccountSelection };
    const extra = { accessToken, accountId };

    // Serve a fresh cached balance without hitting the API.
    const cacheAge = billing?.creditsUpdatedAt ? Date.now() - billing.creditsUpdatedAt : Infinity;
    if (cacheAge < CREDITS_CACHE_TTL_MS && billing?.creditsRemaining !== undefined) {
      return { status: { ...base, balance: billing.creditsRemaining ?? null }, ...extra };
    }

    let balance: number | null = billing?.creditsRemaining ?? null;
    if (accountId) {
      const fresh = await fetchCreditBalance(accessToken, accountId);
      if (fresh !== null) {
        balance = fresh;
        await userStub.updateCloudflareCredits(fresh);
      }
    }
    return { status: { ...base, balance }, ...extra };
  } catch {
    return { status: { connected: false, balance: null } };
  }
}

/** Public-safe connection status for display and the usage decision (drops the access token). */
export async function getConnectionStatus(
  env: Cloudflare.Env, userStub: UserStub,
): Promise<CloudflareConnectionStatus> {
  return (await resolveConnection(env, userStub)).status;
}

/**
 * Force-refresh the cached credit balance from Cloudflare, bypassing the TTL. Best effort. Call
 * after a BYOK inference so the next billing decision reflects the spend just incurred.
 */
export async function refreshCachedBalance(_env: Cloudflare.Env, userStub: UserStub): Promise<void> {
  try {
    const token = await getUsableAccessToken(userStub);
    if (!token) return;
    const billing = await userStub.getCloudflareBilling();
    const accountId = billing?.accountId;
    if (!accountId) return;
    const fresh = await fetchCreditBalance(token, accountId);
    if (fresh !== null) await userStub.updateCloudflareCredits(fresh);
  } catch {
    // Best effort — leave the cached value in place.
  }
}

/** List the Cloudflare accounts the connected grant can access. Empty if not connected/usable. */
export async function listConnectedAccounts(
  _env: Cloudflare.Env, userStub: UserStub,
): Promise<CloudflareAccountOption[]> {
  try {
    const token = await getUsableAccessToken(userStub);
    if (!token) return [];
    return await listAccounts(token);
  } catch {
    return [];
  }
}

/** Select which Cloudflare account to bill. Validates it's accessible by the connected grant. */
export async function selectAccount(
  _env: Cloudflare.Env, userStub: UserStub, accountId: string,
): Promise<void> {
  const token = await getUsableAccessToken(userStub);
  if (!token) throw new Error("No usable Cloudflare connection.");
  const accounts = await listAccounts(token);
  const found = accounts.find(a => a.accountId === accountId);
  if (!found) throw new Error("That Cloudflare account was not found in the connected grant.");
  await userStub.setCloudflareAccountSelection(found.accountId, found.accountName);
}
