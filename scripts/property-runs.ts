// fast-check options shared by the property-based suites: integration-tests' and gatekeeper-kit's
// under Node, and workshop-backend's inside workerd, whose vitest config forwards
// `FAST_CHECK_SEED` as a binding that `nodejs_compat` copies into `process.env`.

/**
 * `FAST_CHECK_SEED` pins every property's seed, so a run generates the same cases each time; CI
 * sets it. Unset, fast-check draws a fresh seed whenever the suite actually runs (a cached task
 * replays its last result instead) and prints it with any failure, along with the `path` of the
 * shrunk counterexample, so a local failure can be replayed.
 */
function seedFromEnv(): { seed?: number } {
  const raw = process.env.FAST_CHECK_SEED;
  if (!raw) return {};
  const seed = Number(raw);
  if (!Number.isSafeInteger(seed)) throw new Error(`FAST_CHECK_SEED must be an integer, got "${raw}"`);
  return { seed };
}

/**
 * Options for every property's `fc.assert()`.
 *
 * A run over real RPC costs hundreds of milliseconds, and so does every shrink attempt. The time
 * limit keeps such a property's shrink inside its test timeout; it reports the smallest
 * counterexample found by then. An interrupt before any failure still fails, rather than silently
 * passing on fewer runs.
 */
export const PROPERTY_RUN_OPTIONS = {
  interruptAfterTimeLimit: 90_000,
  markInterruptAsFailure: true,
  ...seedFromEnv(),
} as const;
