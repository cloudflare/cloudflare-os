/**
 * Wall-clock ceiling for one eval test, mirrored into `vitest.eval.config.ts`.
 *
 * Vitest's timeout is the backstop that stops a wedged run, so the per-turn agent budget below is
 * derived from it rather than chosen independently: a task whose turns could outlast the test would
 * be killed by Vitest with its earlier turns' passing checks already recorded and then discarded.
 */
export const EVAL_TEST_TIMEOUT_MS = 30 * 60_000;

/** Reserved for workerd startup, verification, source capture, and Gateway log polling. */
const OVERHEAD_MS = 6 * 60_000;

/** Longest any single turn may run, so that a whole task still fits inside the test timeout. */
export function agentTurnTimeoutMs(turns: number): number {
  if (!Number.isInteger(turns) || turns < 1) {
    throw new Error("An eval task must declare at least one turn");
  }
  return Math.floor((EVAL_TEST_TIMEOUT_MS - OVERHEAD_MS) / turns);
}
