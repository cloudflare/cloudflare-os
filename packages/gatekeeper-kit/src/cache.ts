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

/**
 * Where entries and the generation counter live. Fixed: a resource's cache families are segments
 * within the caller's own `key` (`page:…`, `schema:…`), and their freshness is already per-read.
 */
const CACHE_PREFIX = "cache:";

/**
 * Durable cache for stable, read-only provider metadata, partitioned by authority and keyed within a
 * generation the caller bumps when an applied action may have invalidated everything (a schema
 * change, say) -- cheaper and more complete than tracking which entries a write touched.
 *
 * Filling is the cache's own job rather than a get/put pair at each call site, because the load
 * spans an await: an applied action can bump the generation, or a reconnect replace the authority,
 * while one is in flight -- and a value stamped with whichever was current when it *returns* would
 * reinstate exactly what that change invalidated, then serve it for the whole `ttlMs`.
 */
export class KvTtlCache {
  readonly #kv: CacheKv;
  readonly #authority: () => string;
  readonly #loads = new SingleFlight();

  /**
   * `authority` names the principal a read belongs to: an opaque, non-secret identity covering the
   * account, resource scope, and every policy that can change provider output, never an email or
   * display value. It must survive a token refresh: `CredentialCoordinator.identity()` rotates on
   * every refresh and would discard the cache each time the grant is renewed --
   * `connectionGeneration()` is the account-side source built to survive it. Deliberate
   * invalidation is `invalidateAll()`'s job.
   *
   * Read per call, not captured: an in-place reconnect replaces the grant under a live instance,
   * and a frozen authority would then stamp the new principal's data with the old identity.
   */
  constructor(kv: CacheKv, authority: () => string) {
    this.#kv = kv;
    this.#authority = authority;
  }

  /**
   * The cached value, or `load()`'s -- kept for later callers, and shared with concurrent ones.
   *
   * The generation and the authority are both read before the load and again after it. A change in
   * between means the value describes a state that change declared stale, so it is handed to this
   * caller (which asked before it) but not stored.
   *
   * `T` is asserted, not checked: one key holds one type for the life of the deployment, since a
   * generation bump does not protect a shape that changed across deploys. `ttlMs` is the reader's
   * choice, so two callers may disagree about whether the same entry is fresh. `load` must resolve
   * to a structured-cloneable value: the store happens in its continuation, so a value KV refuses
   * fails this call after the provider round trip.
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

    // Keyed by both, so a load started before either moved is never shared with a caller that
    // arrived after. Encoded rather than joined: an authority may itself contain the delimiter.
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

  /**
   * Invalidate every entry at once. The generation remains shared across authorities: that may
   * over-invalidate, while authority-stamped entries already prevent under-invalidation.
   */
  invalidateAll(): void {
    this.#kv.put(`${CACHE_PREFIX}generation`, this.#generation() + 1);
  }

  #generation(): number {
    return this.#kv.get<number>(`${CACHE_PREFIX}generation`) ?? 0;
  }
}
