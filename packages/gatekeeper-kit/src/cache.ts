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
   * served without a partition could cross a reconnect. An owner that installs credentials itself
   * may instead keep the authority constant while connected and call {@link invalidateAll} on
   * every install.
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
   * @param ttlMs Maximum entry age in milliseconds, counted from when the load that fetched it
   * started, or a function giving it for the value an entry holds, so that some answers are trusted
   * longer than others. The function is asked whenever an entry is consulted, so it governs entries
   * already stored.
   * @param load Loads a fresh value after a miss.
   * @returns The cached or loaded value.
   * @throws Error when a TTL is not a positive safe integer.
   */
  async cached<T>(
    key: string, ttlMs: number | ((value: T) => number), load: () => Promise<T>,
  ): Promise<T> {
    const [value] = await this.cachedMany([key], ttlMs, async () => [await load()]);
    return value;
  }

  /**
   * Returns or loads cached values for several keys at once, in `keys` order (duplicates
   * included), loading the missing keys in batches of at most `batchSize`, one batch at a time.
   * Each batch is stored as it returns, so a batch that fails keeps what the batches before it
   * loaded; the batches after it are not loaded, and fail with its error, as does any other caller
   * that joined one of their keys. Each entry is stored, expired, coalesced and fenced as
   * {@link cached} does it, and the two share in-flight loads: a key another caller is already
   * loading is joined rather than reloaded, and a key this call loads is joined by later callers
   * of either method.
   * @param keys Cache keys within the authority partition.
   * @param ttlMs Maximum entry age in milliseconds, or a function giving it for the value an entry
   * holds, as {@link cached} takes it.
   * @param load Loads fresh values for one batch of missing keys, each once and in first-seen
   * order, and returns one value per key, in the same order. Not called when nothing is missing. A
   * load that throws stores none of its values, so it should make one provider request.
   * @param options `batchSize` is the most keys one load is given, such as the most one provider
   * request takes; by default every missing key goes to one load.
   * @returns The cached or loaded value for each key.
   * @throws Error when `load` returns a different number of values than it was given keys, or
   * when a TTL or `batchSize` is not a positive safe integer.
   */
  async cachedMany<T>(
    keys: readonly string[], ttlMs: number | ((value: T) => number),
    load: (keys: string[]) => Promise<T[]>, options: { batchSize?: number } = {},
  ): Promise<T[]> {
    if (typeof ttlMs === "number") requirePositiveInt("ttlMs", ttlMs);
    const batchSize = options.batchSize === undefined
      ? Infinity : requirePositiveInt("batchSize", options.batchSize);
    const authority = await this.#authority();
    if (authority === undefined) {
      const unique = [...new Set(keys)];
      const loaded = new Map<string, T>();
      for (let start = 0; start < unique.length; start += batchSize) {
        const batch = unique.slice(start, start + batchSize);
        const values = await loadExactly(load, batch);
        batch.forEach((key, index) => loaded.set(key, values[index]));
      }
      return keys.map(key => loaded.get(key) as T);
    }

    const generation = this.#generation();
    const flights = loads(this.#kv);
    const results = new Map<string, T | Promise<T>>();
    // Keyed by the storage entry plus generation and authority: stale and current callers never
    // share a load, and two named caches over one storage never share one either.
    const loadKeys = new Map<string, string>();
    // Classified before anything is claimed, so a throw here (a TTL refused for some entry's value)
    // strands no claim for later callers to join.
    for (const key of keys) {
      if (results.has(key) || loadKeys.has(key)) continue;
      const entryKey = `${this.#prefix}entry:${key}`;
      const entry = this.#kv.get<CacheEntry<T>>(entryKey);
      if (isFresh(entry, authority, generation, ttlMs)) results.set(key, entry.value);
      else loadKeys.set(key, JSON.stringify([entryKey, generation, authority]));
    }
    // Claimed in the same synchronous turn, so no other caller can start a load for a key between
    // this call finding it missing and claiming it. Each joins another caller's load of its key, or
    // claims the key for one of this call's batches. Batches are cut from the claimed keys alone,
    // so fresh and joined keys never take a place in one.
    const missing: string[] = [];
    const batches: PromiseWithResolvers<T[]>[] = [];
    for (const [key, loadKey] of loadKeys) {
      results.set(key, flights.run(loadKey, () => {
        const index = missing.push(key) - 1;
        const batch = batches[Math.floor(index / batchSize)] ??= Promise.withResolvers<T[]>();
        return batch.promise.then(values => values[index % batchSize]);
      }));
    }
    if (missing.length > 0) {
      void this.#loadBatches(missing, batches, batchSize, generation, authority, ttlMs, load);
    }
    return Promise.all(keys.map(key => results.get(key)!));
  }

  /**
   * Loads and stores `missing` one batch after another, settling each of `batches` with its slice.
   * A failed batch fails itself and every batch after it, which are never loaded.
   */
  async #loadBatches<T>(
    missing: string[], batches: PromiseWithResolvers<T[]>[], batchSize: number,
    generation: number, authority: string, ttlMs: number | ((value: T) => number),
    load: (keys: string[]) => Promise<T[]>,
  ): Promise<void> {
    for (const [index, batch] of batches.entries()) {
      try {
        const keys = missing.slice(index * batchSize, (index + 1) * batchSize);
        batch.resolve(await this.#loadAndStore(keys, generation, authority, ttlMs, load));
      } catch (error) {
        for (const failed of batches.slice(index)) failed.reject(error);
        return;
      }
    }
  }

  /**
   * Loads `keys` together and stores each value, unless the generation or authority moved during
   * the load: such a load returns to its callers but is not cached. A value the TTL function
   * refuses fails the load, rather than being stored and refused at every later read.
   */
  async #loadAndStore<T>(
    keys: string[], generation: number, authority: string,
    ttlMs: number | ((value: T) => number), load: (keys: string[]) => Promise<T[]>,
  ): Promise<T[]> {
    // Stamped before the load, not after it or the fence read that follows: the provider answered
    // somewhere in between, and a loader making several requests learned its first answer long
    // before it returned, so a later stamp would serve that answer past its TTL.
    const fetchedAt = Date.now();
    const values = await loadExactly(load, keys);
    if (typeof ttlMs === "function") {
      for (const value of values) requirePositiveInt("ttlMs", ttlMs(value));
    }
    let current: string | undefined;
    try {
      current = await this.#authority();
    } catch {
      // The load succeeded and its callers are owed it; an unreadable fence only blocks caching.
      return values;
    }
    // The generation read is the last synchronous act before the writes, so an `invalidateAll()`
    // landing during the authority read cannot be written past.
    if (this.#generation() === generation && current === authority) {
      keys.forEach((key, index) => {
        this.#kv.put<CacheEntry<T>>(`${this.#prefix}entry:${key}`,
          { value: values[index], fetchedAt, generation, authority });
      });
    }
    return values;
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

/**
 * Whether `entry` was stored under `authority` and `generation` and is younger than the TTL its
 * value is given.
 */
function isFresh<T>(
  entry: CacheEntry<T> | undefined, authority: string, generation: number,
  ttlMs: number | ((value: T) => number),
): entry is CacheEntry<T> {
  if (entry?.authority !== authority || entry.generation !== generation) return false;
  const ttl = typeof ttlMs === "number" ? ttlMs : requirePositiveInt("ttlMs", ttlMs(entry.value));
  return Date.now() - entry.fetchedAt < ttl;
}

/** Calls `load`, refusing an answer that does not hold one value per key. */
async function loadExactly<T>(
  load: (keys: string[]) => Promise<T[]>, keys: string[],
): Promise<T[]> {
  // A copy, so a loader that consumes its argument cannot shorten the list the answer is checked
  // against.
  const values = await load([...keys]);
  if (values.length !== keys.length) {
    throw new Error("A batched cache load returned a different number of values than keys.");
  }
  return values;
}
