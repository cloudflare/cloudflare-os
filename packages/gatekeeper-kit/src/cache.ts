import type { KvReadWrite } from "./kv";
import { requirePositiveInt } from "./positive-int";
import { SingleFlight } from "./single-flight";

/** The Durable Object KV surface used by the cache. */
export type CacheKv = KvReadWrite;

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
 */
export class KvTtlCache {
  readonly #kv: CacheKv;
  readonly #authority: () => string;
  readonly #loads = new SingleFlight();

  /**
   * Creates a durable TTL cache. Authority must change on reconnect but remain stable across token
   * refresh.
   * @param kv Durable Object cache storage.
   * @param authority Returns the current opaque cache partition.
   */
  constructor(kv: CacheKv, authority: () => string) {
    this.#kv = kv;
    this.#authority = authority;
  }

  /**
   * Returns or loads a cached value. A load overtaken by invalidation returns to its caller but is not
   * cached.
   * @param key Cache key within the authority partition.
   * @param ttlMs Maximum entry age in milliseconds.
   * @param load Loads a fresh value after a miss.
   * @returns The cached or loaded value.
   */
  async cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    requirePositiveInt("ttlMs", ttlMs);
    const entryKey = `${CACHE_PREFIX}entry:${key}`;
    const generation = this.#generation();
    const authority = this.#authority();
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
