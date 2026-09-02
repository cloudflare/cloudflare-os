/**
 * Creates one value per storage object.
 * @param create Value factory.
 * @returns A stable per-storage getter.
 */
export function perStorage<T>(create: () => T): (kv: WeakKey) => T {
  const state = new WeakMap<WeakKey, T>();
  return kv => {
    let value = state.get(kv);
    if (value === undefined) state.set(kv, value = create());
    return value;
  };
}
