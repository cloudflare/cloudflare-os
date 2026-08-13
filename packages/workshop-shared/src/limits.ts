// Limits, usage, and free-tier constants shared between the Workshop client and server.
//
// These power the optional "Cloudflare limits" flow (enabled by the ENABLE_CLOUDFLARE_LIMITS
// server config). When that flow is disabled (the default, e.g. for self-hosted deployments),
// none of these limits apply and users have unlimited access.

/**
 * Default minimum Cloudflare AI Gateway balance (USD) required to keep using the service once a
 * user has exhausted their free daily allowance and connected their own Cloudflare account. The
 * server may override this via the MINIMUM_CLOUDFLARE_BALANCE env var.
 */
export const MINIMUM_CLOUDFLARE_BALANCE = 2.0;

/** Default number of LLM calls a user may make per (calendar) day on the free tier. */
export const DEFAULT_DAILY_LLM_CALL_LIMIT = 100;

/** User-facing message for an insufficient connected-account balance. */
export function insufficientBalanceMessage(minimum: number = MINIMUM_CLOUDFLARE_BALANCE): string {
  return `Cloudflare AI Gateway balance is below $${minimum}. Please add credits or use BYOK.`;
}

/** User-facing messages for limit violations. */
export const LIMIT_ERROR_MESSAGES = {
  USAGE_LIMIT_EXCEEDED:
    "Free usage limit reached. Connect your Cloudflare account or use your own API keys to continue.",
  NO_CLOUDFLARE_TOKEN:
    "Free usage limit reached. Connect your Cloudflare account to continue.",
} as const;

/** The window over which the free-tier limit is measured. */
export type LimitWindowKind = "daily" | "rolling";

/** Returns true if the given balance meets the minimum required to proceed. */
export function hasMinimumBalance(
  balance: number | null | undefined,
  minimum: number = MINIMUM_CLOUDFLARE_BALANCE,
): boolean {
  if (balance === null || balance === undefined) return false;
  return balance >= minimum;
}

/** Result of deciding whether a request may proceed. */
export interface CanProceedResult {
  /** Whether the request is allowed to proceed at all. */
  allowed: boolean;
  /** Human-readable reason when not allowed (or guidance when BYOK is required). */
  reason?: string;
  /**
   * Whether the request should be served using the user's own keys / gateway rather than the
   * platform's. True once the user has exhausted the free tier but can still proceed via BYOK.
   */
  shouldUseByok: boolean;
}

/**
 * Pure decision function: given whether the user is within their free-tier limit, whether they
 * have connected a Cloudflare account (token), and their gateway balance, decide whether the
 * request may proceed and whose credentials to use.
 *
 * Rules:
 *   1. Connected + balance >= minimum  -> proceed, billed to the user's own gateway (BYOK),
 *      regardless of the free-tier count. The platform is never charged for connected+funded users.
 *   2. Otherwise, within the free tier  -> proceed, platform-funded. This includes connected users
 *      whose balance is below the minimum (e.g. $0): they keep using the daily free allowance.
 *   3. Otherwise (free tier exhausted) -> blocked, prompting to connect (if not connected) or to
 *      add credits (if connected but out of balance).
 */
export function canProceedWithRequest(data: {
  withinLimits: boolean;
  hasUserToken: boolean;
  balance?: number | null;
  /** Minimum required balance (USD). Defaults to MINIMUM_CLOUDFLARE_BALANCE. */
  minimumBalance?: number;
}): CanProceedResult {
  const { withinLimits, hasUserToken, balance } = data;
  const minimumBalance = data.minimumBalance ?? MINIMUM_CLOUDFLARE_BALANCE;

  // Connected with sufficient balance: bill the user's own gateway, even within the free tier.
  if (hasUserToken && hasMinimumBalance(balance, minimumBalance)) {
    return { allowed: true, shouldUseByok: true };
  }

  // Otherwise fall back to the platform free tier while it lasts. A connected user whose balance is
  // below the minimum (incl. $0) still gets the daily free allowance here.
  if (withinLimits) {
    return { allowed: true, shouldUseByok: false };
  }

  // Free tier exhausted and the user can't (yet) cover usage themselves.
  // NOTE: `shouldUseByok` is only meaningful when `allowed` is true (it selects whose credentials to
  // use). When `allowed` is false the request won't run at all, so the value is a don't-care; callers
  // must check `allowed` first.
  if (!hasUserToken) {
    return {
      allowed: false,
      reason: LIMIT_ERROR_MESSAGES.NO_CLOUDFLARE_TOKEN,
      shouldUseByok: true,
    };
  }

  // Connected but out of balance: prompt to add credits.
  return {
    allowed: false,
    reason: insufficientBalanceMessage(minimumBalance),
    shouldUseByok: true,
  };
}
