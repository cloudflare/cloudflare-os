const cache = new WeakMap<Uint8Array, Map<unknown, Promise<unknown>>>();

/**
 * The result of parsing a file, computed once per file and parser, for a previewer to read with
 * `use()`. The promise has to outlive the component: one that suspends while mounting keeps no
 * state, so a promise made during render would be made again on every attempt.
 */
export const derivedFrom = <T>(
  bytes: Uint8Array,
  derive: (bytes: Uint8Array) => Promise<T>,
): Promise<T> => {
  let derived = cache.get(bytes);
  if (!derived) cache.set(bytes, derived = new Map());
  let result = derived.get(derive) as Promise<T> | undefined;
  if (!result) derived.set(derive, result = derive(bytes));
  return result;
};
