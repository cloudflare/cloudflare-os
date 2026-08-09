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

// Minimum connected-account balance (USD) required to proceed via BYOK once the free tier is spent.
export function getMinimumCloudflareBalance(env: Cloudflare.Env): number {
  return readNumber(env.MINIMUM_CLOUDFLARE_BALANCE, MINIMUM_CLOUDFLARE_BALANCE);
}

// Whether the AI Gateway billing flow (free-tier limits + Cloudflare-connect top-up) is enabled.
// Disabled by default; when off, usage is unlimited and no balance checks occur (self-hosted).
export function isCloudflareLimitsEnabled(env: Cloudflare.Env): boolean {
  return env.ENABLE_CLOUDFLARE_LIMITS === "true";
}

// Whether per-user daily call quotas are enforced WITHOUT any billing. This is the airgapped
// deployment's throttle: there is no money and no Cloudflare account, but an admin still wants to
// stop one user exhausting a shared local inference cluster. Implies no balance lookup, no BYOK,
// and no top-up UI -- the daily counter applies to every user uniformly.
//
// Ignored when ENABLE_CLOUDFLARE_LIMITS is on, since that path already enforces the same counter
// (plus the balance bypass) and enabling both would be ambiguous.
export function isUsageQuotaOnlyEnabled(env: Cloudflare.Env): boolean {
  return !isCloudflareLimitsEnabled(env) && env.ENABLE_USAGE_QUOTAS === "true";
}
