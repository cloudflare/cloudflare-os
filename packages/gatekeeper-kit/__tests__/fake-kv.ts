/**
 * A stand-in for the Durable Object KV surface the kit's modules take.
 *
 * A plain `Map` is not a faithful fake, and both differences hide real bugs (each verified by
 * probing `ctx.storage.kv` under workerd rather than assumed):
 *
 * - **Every write and every read clones.** `kv.put(k, obj)` then mutating `obj` does not change what
 *   is stored, `kv.get(k)` never returns the object that was written, and two `get`s of one key
 *   return different objects. A fake that hands back references lets a module mutate stored state in
 *   place while a test still reports "one write", and would let a regression from opaque-identity
 *   comparison to reference equality pass.
 * - **`list` is ordered lexicographically, not by insertion.** Real scans yield `…:10` before `…:2`,
 *   so a fake preserving insertion order silently satisfies any test that should have caught a
 *   missing numeric sort.
 *
 * Clone failures propagate rather than handing the value back: real KV rejects them too. A stub is
 * the exception real KV stores by reference, but no test stores one, so there is no hatch for it.
 * Key ordering is UTF-16 here, UTF-8 in production; they agree on the ASCII prefixes and numeric
 * ids the kit writes, and no kit reader depends on order.
 */
export type FakeKv = {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
  delete(key: string): void;
  list<T>(options: { prefix: string }): Iterable<[string, T]>;
  /** Test-only: every key ever written, in write order, including repeats. */
  readonly writes: string[];
  /** Test-only: the keys currently present, lexicographically. */
  keys(): string[];
};

const byKey = ([a]: [string, unknown], [b]: [string, unknown]): number =>
  a < b ? -1 : a > b ? 1 : 0;

export function fakeKv(): FakeKv {
  const values = new Map<string, unknown>();
  const writes: string[] = [];
  return {
    get: <T>(key: string) => {
      const stored = values.get(key);
      return stored === undefined ? undefined : structuredClone(stored) as T;
    },
    put: (key, value) => {
      writes.push(key);
      values.set(key, structuredClone(value));
    },
    delete: (key: string) => void values.delete(key),
    list: <T>({ prefix }: { prefix: string }) =>
      [...values.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .toSorted(byKey)
        .map(([key, value]) => [key, structuredClone(value)] as [string, T]),
    writes,
    keys: () => [...values.keys()].toSorted(),
  };
}
