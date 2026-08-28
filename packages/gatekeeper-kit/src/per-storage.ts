// Isolate-local state keyed by a storage object's identity: the fences and coalescers every module
// instance over one Durable Object's storage must share. Callers pass `ctx.storage.kv` itself,
// never a per-request wrapper -- two wrappers over one storage would each get their own state and
// fence separately.

/** A getter minting one `create()` result per storage object. */
export function perStorage<T>(create: () => T): (kv: WeakKey) => T {
  const state = new WeakMap<WeakKey, T>();
  return kv => {
    let value = state.get(kv);
    if (value === undefined) state.set(kv, value = create());
    return value;
  };
}
