// Configuration for the optional AI Gateway billing feature: a per-user free daily allowance, and
// (once exhausted) billing through the user's own connected Cloudflare AI Gateway. OFF by default.

import { MINIMUM_CLOUDFLARE_BALANCE } from "@gadgets/workshop-shared/limits";

// Parse a positive-number env var (USD amount / count), falling back to a default.
function readNumber(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

/** Minimum connected-account balance (USD) required to proceed via BYOK once the free tier is spent. */
export function getMinimumCloudflareBalance(env: Cloudflare.Env): number {
  return readNumber(env.MINIMUM_CLOUDFLARE_BALANCE, MINIMUM_CLOUDFLARE_BALANCE);
}

/**
 * Whether the AI Gateway billing flow (free-tier limits + Cloudflare-connect top-up) is enabled.
 * Disabled by default; when off, usage is unlimited and no balance checks occur (self-hosted).
 */
export function isCloudflareLimitsEnabled(env: Cloudflare.Env): boolean {
  return env.ENABLE_CLOUDFLARE_LIMITS === "true";
}
