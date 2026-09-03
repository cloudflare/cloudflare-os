/** Process-local coordination state keyed by a stable storage object. */

/**
 * Creates one process-local value per storage object. Callers must pass a stable object, and the
 * factory must not return `undefined`, which is the cache-miss sentinel.
 * @param create Value factory.
 * @returns A stable per-storage getter.
 *
 * @example
 * ```ts
 * const refreshes = perStorage(() => new SingleFlight());
 * return refreshes(ctx.storage.kv).run(
 *   "credentials",
 *   () => refreshCredentials(),
 * );
 * ```
 */
export function perStorage<T>(create: () => T): (kv: WeakKey) => T {
  const state = new WeakMap<WeakKey, T>();
  return kv => {
    let value = state.get(kv);
    if (value === undefined) state.set(kv, value = create());
    return value;
  };
}
