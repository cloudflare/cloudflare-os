// Minimal synchronous Durable Object KV surfaces used by the kit. Implementations must preserve
// `ctx.storage.kv` write ordering and implicit transaction semantics.

/** Typed reads and writes by key. */
export type KvReadWrite = {
  /**
   * Reads a value by key.
   * @param key Storage key.
   * @returns The stored value, or `undefined`.
   */
  get<T>(key: string): T | undefined;
  /**
   * Writes a value by key.
   * @param key Storage key.
   * @param value Value to store.
   */
  put<T>(key: string, value: T): void;
};

/** Reads, writes, and removal. */
export type KvMutable = KvReadWrite & {
  /**
   * Deletes a value by key.
   * @param key Storage key.
   */
  delete(key: string): void;
};

/** Reads, writes, removal, and a prefix scan. */
export type KvScannable = KvMutable & {
  /**
   * Scans entries by key prefix.
   * @param options Prefix to scan.
   * @returns Matching key-value pairs.
   */
  list<T>(options: { prefix: string }): Iterable<[string, T]>;
};
