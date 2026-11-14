/** A Durable Object KV fake: values cloned on the way in and out, and scans in key order. */
export type FakeKv = {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
  delete(key: string): void;
  list<T>(options: { prefix: string; startAfter?: string; limit?: number }): Iterable<[string, T]>;
};

export function fakeKv(): FakeKv {
  const values = new Map<string, unknown>();
  return {
    get: <T>(key: string) => {
      const stored = values.get(key);
      return stored === undefined ? undefined : structuredClone(stored) as T;
    },
    put: (key, value) => void values.set(key, structuredClone(value)),
    delete: key => void values.delete(key),
    list: <T>({ prefix, startAfter, limit }: { prefix: string; startAfter?: string; limit?: number }) => {
      const found = [...values.entries()]
        .filter(([key]) => key.startsWith(prefix) && (startAfter === undefined || key > startAfter))
        .toSorted(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, value]) => [key, structuredClone(value)] as [string, T]);
      return limit === undefined ? found : found.slice(0, limit);
    },
  };
}
