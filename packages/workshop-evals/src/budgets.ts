export const EVAL_AGENT_BUDGET_MS = 28 * 60_000;
/** Shared by a task's turns. Differential and dataset checks make hundreds of RPC calls per turn. */
export const EVAL_VERIFICATION_BUDGET_MS = 4 * 60_000;
export const EVAL_TEST_TIMEOUT_MS = 40 * 60_000;
