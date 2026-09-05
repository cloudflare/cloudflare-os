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

// The sigil keeps a named cache's keys out of the unnamed layout, whatever the name.
const NAMED_PREFIX = `${CACHE_PREFIX}@`;

const CACHE_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * Durable TTL cache partitioned by authority and generation. In-flight loads are stored only when
 * both still match, so reconnects and invalidations cannot restore stale values. Every unnamed
 * instance over one storage shares a single key and generation namespace — two of them with
 * colliding `cached()` keys serve each other's values, and either one's `invalidateAll()` clears
 * both — so give each logical cache family a `name`.
 * @example
 * ```ts
 * #cache = KvTtlCache.partitionedBy(this.ctx.storage.kv, this.#creds);
 *
 * listProjects() {
 *   return this.#cache.cached("projects", 60_000,
 *     () => this.#creds.run(creds => this.#api.listProjects(creds), { replayable: true }));
 * }
 * ```
 */
export class KvTtlCache {
  readonly #kv: CacheKv;
  readonly #authority: () => string | undefined;
  readonly #prefix: string;
  readonly #loads = new SingleFlight();

  /**
   * Creates a durable TTL cache. Authority must change on reconnect but remain stable across token
   * refresh; `undefined` (unknown authority) bypasses the cache entirely, since a value stored or
   * served without a partition could cross a reconnect.
   * @param kv Durable Object cache storage.
   * @param authority Returns the current opaque cache partition, or `undefined` when unknown.
   * @param options `name` gives this cache its own keys and generation, so it neither collides
   * with nor is invalidated by another cache over the same storage.
   */
  constructor(kv: CacheKv, authority: () => string | undefined, options: { name?: string } = {}) {
    this.#kv = kv;
    this.#authority = authority;
    const { name } = options;
    if (name !== undefined && !CACHE_NAME.test(name)) {
      throw new Error(`Cache name "${name}" must match ${CACHE_NAME.source}.`);
    }
    // Unnamed keeps the layout every ported gatekeeper already has in storage.
    this.#prefix = name === undefined ? CACHE_PREFIX : `${NAMED_PREFIX}${name}:`;
  }

  /**
   * Creates a cache partitioned by the source's authority, read per use and never captured, so the
   * partition follows the source's live value and an unknown authority bypasses. For an authority
   * composed of more dimensions, use the constructor; per-kind scoping belongs in key segments.
   * @param kv Durable Object cache storage.
   * @param source Live authority to partition entries by.
   * @param options `name` gives this cache its own keys and generation.
   * @returns A cache partitioned by the source's authority.
   */
  static partitionedBy(
    kv: CacheKv,
    source: AuthoritySource,
    options: { name?: string } = {},
  ): KvTtlCache {
    return new KvTtlCache(kv, () => source.authority(), options);
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
    const entryKey = `${this.#prefix}entry:${key}`;
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
    this.#kv.put(`${this.#prefix}generation`, this.#generation() + 1);
  }

  /** @returns The current cache generation. */
  #generation(): number {
    return this.#kv.get<number>(`${this.#prefix}generation`) ?? 0;
  }
}
