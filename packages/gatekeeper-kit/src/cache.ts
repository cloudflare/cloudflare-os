/** Principal-partitioned Durable Object TTL caching. */

import type { KvReadWrite } from "./kv";
import { requirePositiveInt } from "./positive-int";
import { perStorage } from "./per-storage";
import { SingleFlight } from "./single-flight";

/** The Durable Object KV surface used by the cache. */
export type CacheKv = KvReadWrite;

/** What `KvTtlCache.partitionedBy` asks for the current cache partition. */
export type AuthoritySource = {
  /**
   * @returns The live connection fence, or `undefined` when the source cannot vouch for one. Read
   * per use, so a reconnect repartitions before the next hit rather than at the next provider call.
   */
  cacheAuthority(): Promise<string | undefined>;
};

type CacheEntry<T> = {
  value: T;
  fetchedAt: number;
  generation: number;
  authority: string;
};

// Coalesced per storage, not per instance: a facet that builds its cache per call would
// otherwise let an older load overwrite a newer entry after the post-load fence read.
const loads = perStorage(() => new SingleFlight());

const CACHE_PREFIX = "cache:";

// The sigil keeps a named cache's keys out of the unnamed layout, whatever the name.
const NAMED_PREFIX = `${CACHE_PREFIX}@`;

const CACHE_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * Which keyspace a cache owns. `name` is what new code passes; `legacyUnnamed` takes the shared
 * pre-kit layout, and only a port with entries already in storage should.
 */
export type CacheNamespace =
  | { name: string; legacyUnnamed?: never }
  | { name?: never; legacyUnnamed: true };

/**
 * Durable TTL cache partitioned by authority and generation. In-flight loads are stored only when
 * both still match, so reconnects and invalidations cannot restore stale values.
 *
 * Every cache needs a `name`, which gives it its own keys and generation. Two caches sharing one
 * would serve each other's values for colliding `cached()` keys, and either one's
 * `invalidateAll()` would clear both; `legacyUnnamed` opts into that shared layout, and only a
 * port with entries already in storage should.
 * @example
 * ```ts
 * #cache = KvTtlCache.partitionedBy(this.ctx.storage.kv, this.#creds, { name: "projects" });
 *
 * listProjects() {
 *   return this.#cache.cached("projects", 60_000,
 *     () => this.#creds.run(creds => this.#api.listProjects(creds), { replayable: true }));
 * }
 * ```
 */
export class KvTtlCache {
  readonly #kv: CacheKv;
  readonly #authority: () => string | undefined | Promise<string | undefined>;
  readonly #prefix: string;

  /**
   * Creates a durable TTL cache. Authority must change on reconnect but remain stable across token
   * refresh; `undefined` (unknown authority) bypasses the cache entirely, since a value stored or
   * served without a partition could cross a reconnect.
   * @param kv Durable Object cache storage.
   * @param authority Returns the current opaque cache partition, or `undefined` when unknown. May
   * be synchronous, for an authority that is genuinely local.
   * @param options `name` gives this cache its own keys and generation; `legacyUnnamed` takes the
   * shared pre-kit layout instead. Exactly one is required.
   */
  constructor(
    kv: CacheKv,
    authority: () => string | undefined | Promise<string | undefined>,
    options: CacheNamespace,
  ) {
    this.#kv = kv;
    this.#authority = authority;
    const { name } = options;
    if (name !== undefined && !CACHE_NAME.test(name)) {
      throw new Error(`Cache name "${name}" must match ${CACHE_NAME.source}.`);
    }
    this.#prefix = name === undefined ? CACHE_PREFIX : `${NAMED_PREFIX}${name}:`;
  }

  /**
   * Creates a cache partitioned by the source's live fence, read on every use and never captured.
   * A hit therefore costs one account credential read — which may itself run a normal credential
   * refresh — and avoids the provider request the entry exists to cache. A source that cannot vouch
   * for the fetched credentials answers `undefined` and the cache bypasses rather than serving an
   * entry the current principal may no longer own; a disconnected account propagates its own error
   * instead. For an authority composed of more dimensions, use the constructor; per-kind scoping
   * belongs in key segments.
   * @param kv Durable Object cache storage.
   * @param source Live authority to partition entries by.
   * @param options `name` gives this cache its own keys and generation, or `legacyUnnamed` for a
   * port's existing shared layout.
   * @returns A cache partitioned by the source's live connection generation.
   */
  static partitionedBy(
    kv: CacheKv,
    source: AuthoritySource,
    options: CacheNamespace,
  ): KvTtlCache {
    return new KvTtlCache(kv, () => source.cacheAuthority(), options);
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
    const authority = await this.#authority();
    if (authority === undefined) return load();
    const entryKey = `${this.#prefix}entry:${key}`;
    const generation = this.#generation();
    const entry = this.#kv.get<CacheEntry<T>>(entryKey);
    if (entry?.authority === authority && entry.generation === generation
      && Date.now() - entry.fetchedAt < ttlMs) {
      return entry.value;
    }

    // Keyed by the storage entry plus generation and authority: stale and current callers never
    // share a load, and two named caches over one storage never share one either.
    const loadKey = JSON.stringify([entryKey, generation, authority]);
    return loads(this.#kv).run(loadKey, async () => {
      const value = await load();
      // Stamped now, not after the fence read: that read is a live account round trip, and dating
      // the entry from its completion would extend the caller's TTL by however long it took.
      const fetchedAt = Date.now();
      let current: string | undefined;
      try {
        current = await this.#authority();
      } catch {
        // The load succeeded and its caller is owed it; an unreadable fence only blocks caching.
        return value;
      }
      // The generation read is the last synchronous act before the write, so an `invalidateAll()`
      // landing during the authority read cannot be written past.
      if (this.#generation() === generation && current === authority) {
        this.#kv.put<CacheEntry<T>>(entryKey, { value, fetchedAt, generation, authority });
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
