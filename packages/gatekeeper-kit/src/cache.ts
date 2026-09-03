/** Principal-partitioned Durable Object TTL caching. */

import type { KvReadWrite } from "./kv";
import { requirePositiveInt } from "./positive-int";
import { SingleFlight } from "./single-flight";

/** The Durable Object KV surface used by the cache. */
export type CacheKv = KvReadWrite;

/** What `KvTtlCache.partitionedBy` reads the cache authority from. */
export type AuthoritySource = {
  /**
   * @returns The current opaque, non-secret authority covering the principal, resource scope, and
   * policy, or `undefined` when unknown.
   */
  authority(): string | undefined;
};

type CacheEntry<T> = {
  value: T;
  fetchedAt: number;
  generation: number;
  authority: string;
};

const CACHE_PREFIX = "cache:";

/**
 * Durable TTL cache partitioned by authority and generation. In-flight loads are stored only when
 * both still match, so reconnects and invalidations cannot restore stale values.
 *
 * @example
 * ```ts
 * #cache = KvTtlCache.partitionedBy(this.ctx.storage.kv, this.#creds);
 *
 * listProjects() {
 *   return this.#cache.cached("projects", 60_000,
 *     () => this.#creds.run(creds => this.#api.listProjects(creds)));
 * }
 * ```
 */
export class KvTtlCache {
  readonly #kv: CacheKv;
  readonly #authority: () => string | undefined;
  readonly #loads = new SingleFlight();

  /**
   * Creates a durable TTL cache. Authority must change on reconnect but remain stable across token
   * refresh; `undefined` (unknown authority) bypasses the cache entirely, since a value stored or
   * served without a partition could cross a reconnect.
   * @param kv Durable Object cache storage.
   * @param authority Returns the current opaque cache partition, or `undefined` when unknown.
   */
  constructor(kv: CacheKv, authority: () => string | undefined) {
    this.#kv = kv;
    this.#authority = authority;
  }

  /**
   * Creates a cache partitioned by the source's authority, read per use and never captured, so the
   * partition follows the source's live value and an unknown authority bypasses. For an authority
   * composed of more dimensions, use the constructor; per-kind scoping belongs in key segments.
   * @param kv Durable Object cache storage.
   * @param source Live authority to partition entries by.
   * @returns A cache partitioned by the source's authority.
   */
  static partitionedBy(kv: CacheKv, source: AuthoritySource): KvTtlCache {
    return new KvTtlCache(kv, () => source.authority());
  }

  /**
   * Returns or loads a cached value. A load overtaken by invalidation returns to its caller but is not
   * cached; a load under an unknown authority is neither shared nor cached.
   * @param key Cache key within the authority partition.
   * @param ttlMs Maximum entry age in milliseconds.
   * @param load Loads a fresh value after a miss.
   * @returns The cached or loaded value.
   */
  async cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    requirePositiveInt("ttlMs", ttlMs);
    const authority = this.#authority();
    if (authority === undefined) return load();
    const entryKey = `${CACHE_PREFIX}entry:${key}`;
    const generation = this.#generation();
    const entry = this.#kv.get<CacheEntry<T>>(entryKey);
    if (entry?.authority === authority && entry.generation === generation
      && Date.now() - entry.fetchedAt < ttlMs) {
      return entry.value;
    }

    // Include generation and authority so stale and current callers never share a load.
    const loadKey = JSON.stringify([generation, authority, key]);
    return this.#loads.run(loadKey, async () => {
      const value = await load();
      if (this.#generation() === generation && this.#authority() === authority) {
        this.#kv.put<CacheEntry<T>>(entryKey,
          { value, fetchedAt: Date.now(), generation, authority });
      }
      return value;
    });
  }

  /** Invalidates every cached entry by advancing the shared generation. */
  invalidateAll(): void {
    this.#kv.put(`${CACHE_PREFIX}generation`, this.#generation() + 1);
  }

  /** @returns The current cache generation. */
  #generation(): number {
    return this.#kv.get<number>(`${CACHE_PREFIX}generation`) ?? 0;
  }
}
