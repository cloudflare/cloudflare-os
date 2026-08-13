// Configuration for the free-tier LLM-call rate limit.

import { DEFAULT_DAILY_LLM_CALL_LIMIT } from "@gadgets/workshop-shared/limits";

/**
 * Result of a daily-quota check/consume. The per-user daily counter lives on the UserDurableObject
 * (see consumeDailyLlmCall / checkDailyLlmCount).
 */
export interface DailyQuotaResult {
  /**
   * Whether the call was permitted: for `consume`, this is the pre-count decision (i.e. there was
   * still allowance BEFORE this call). `used`/`remaining` below reflect the state AFTER this call.
   */
  withinLimits: boolean;
  /** Calls remaining in the current window after this operation. */
  remaining: number;
  /** The configured daily limit. */
  limit: number;
  /** Calls used so far in the current window, including this call when `consume` counted it. */
  used: number;
  /** ISO timestamp when the window resets (next UTC midnight). */
  resetAt: string;
}

/**
 * Resolve the per-user daily LLM-call limit from the environment, falling back to the shared
 * default. A non-positive or unparseable value falls back to the default.
 */
export function getDailyLlmCallLimit(env: Cloudflare.Env): number {
  const raw = env.DAILY_LLM_CALL_LIMIT;
  if (!raw) return DEFAULT_DAILY_LLM_CALL_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_DAILY_LLM_CALL_LIMIT;
  return parsed;
}

/** The UTC calendar day key (YYYY-MM-DD) for a given time. */
export function utcDayKey(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

/** ISO timestamp of the next UTC midnight after `at` -- when the daily window resets. */
export function nextUtcMidnightIso(at: Date = new Date()): string {
  const next = new Date(Date.UTC(
    at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1, 0, 0, 0, 0,
  ));
  return next.toISOString();
}
