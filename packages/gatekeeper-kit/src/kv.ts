/**
 * Minimal synchronous Durable Object KV surfaces. Implementations preserve `ctx.storage.kv` write
 * order and implicit transactions.
 */

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

/**
 * Reads, writes, and removes values.
 *
 * @example
 * ```ts
 * function revoke(kv: KvMutable): void {
 *   kv.delete("credentials");
 *   kv.put("revokedAt", Date.now());
 * }
 * ```
 */
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
