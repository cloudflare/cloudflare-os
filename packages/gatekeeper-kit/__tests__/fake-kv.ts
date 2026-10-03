/**
 * Durable Object KV fake. Cloning catches in-place mutation and reference comparisons; sorted scans
 * match KV's key order rather than `Map` insertion order. Writes are recorded for ordering assertions.
 */
export type FakeKv = {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
  delete(key: string): void;
  list<T>(options: { prefix: string; startAfter?: string; limit?: number }): Iterable<[string, T]>;
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
    list: <T>({ prefix, startAfter, limit }:
      { prefix: string; startAfter?: string; limit?: number }) => {
      const found = [...values.entries()]
        .filter(([key]) => key.startsWith(prefix)
          && (startAfter === undefined || key > startAfter))
        .toSorted(byKey)
        .map(([key, value]) => [key, structuredClone(value)] as [string, T]);
      return limit === undefined ? found : found.slice(0, limit);
    },
    writes,
    keys: () => [...values.keys()].toSorted(),
  };
}
