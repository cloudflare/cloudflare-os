import { afterEach, describe, expect, it, vi } from "vitest";
import { KvTtlCache, type AuthoritySource, type CacheKv } from "../src/cache";
import { CredentialSource } from "../src/credentials";
import { fakeKv } from "./fake-kv";

function makeKv(): CacheKv {
  return fakeKv();
}

afterEach(() => void vi.useRealTimers());

describe("KvTtlCache", () => {
  it("loads once, then serves the entry until its TTL elapses", async () => {
    vi.useFakeTimers();
    const cache = new KvTtlCache(makeKv(), () => "authority");
    const load = vi.fn(async () => ({ name: "acme" }));

    expect(await cache.cached("project", 1000, load)).toEqual({ name: "acme" });
    vi.advanceTimersByTime(999);
    expect(await cache.cached("project", 1000, load)).toEqual({ name: "acme" });
    expect(load).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(1);
    expect(await cache.cached("project", 1000, load)).toEqual({ name: "acme" });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("reloads every entry after invalidating all", async () => {
    const cache = new KvTtlCache(makeKv(), () => "authority");
    await cache.cached("a", 60_000, async () => 1);
    await cache.cached("b", 60_000, async () => 2);

    cache.invalidateAll();
    expect(await cache.cached("a", 60_000, async () => 3)).toBe(3);
    expect(await cache.cached("b", 60_000, async () => 4)).toBe(4);

    // Reloaded against the new generation, so the entry is live again.
    expect(await cache.cached("a", 60_000, async () => 5)).toBe(3);
  });

  it("does not store a value invalidated during a load", async () => {
    const cache = new KvTtlCache(makeKv(), () => "authority");
    const { promise, resolve } = Promise.withResolvers<number>();

    const loading = cache.cached("schema", 60_000, () => promise);
    cache.invalidateAll();
    resolve(1);

    // This caller asked before invalidation, so it still receives what it waited for.
    expect(await loading).toBe(1);
    // The entry was not kept: it describes the state the invalidation declared stale.
    expect(await cache.cached("schema", 60_000, async () => 2)).toBe(2);
  });

  it("bypasses reads and writes while the authority is unknown", async () => {
    // Pre-first-credential-fetch: serving or storing here could cross principals.
    const kv = makeKv();
    let authority: string | undefined = "a";
    const cache = new KvTtlCache(kv, () => authority);
    await cache.cached("project", 60_000, async () => "from a");

    authority = undefined;
    // A stored entry is not served, and every caller loads for itself.
    expect(await cache.cached("project", 60_000, async () => "unpartitioned 1"))
      .toBe("unpartitioned 1");
    expect(await cache.cached("project", 60_000, async () => "unpartitioned 2"))
      .toBe("unpartitioned 2");

    // Nothing was stored either: back under a known authority, its own entry still stands.
    authority = "a";
    expect(await cache.cached("project", 60_000, async () => "fresh a")).toBe("from a");
  });

  it("does not store a load whose authority became unknown mid-flight", async () => {
    const kv = makeKv();
    let authority: string | undefined = "a";
    const cache = new KvTtlCache(kv, () => authority);
    const { promise, resolve } = Promise.withResolvers<string>();

    const loading = cache.cached("project", 60_000, () => promise);
    authority = undefined;
    resolve("mid-expiry");
    expect(await loading).toBe("mid-expiry");

    authority = "a";
    expect(await cache.cached("project", 60_000, async () => "fresh a")).toBe("fresh a");
  });

  it("does not serve an entry written under another authority", async () => {
    const kv = makeKv();
    const authorityA = new KvTtlCache(kv, () => "a");
    const authorityB = new KvTtlCache(kv, () => "b");
    await authorityA.cached("project", 60_000, async () => "from a");
    const load = vi.fn(async () => "from b");

    expect(await authorityB.cached("project", 60_000, load)).toBe("from b");
    expect(load).toHaveBeenCalledOnce();
  });

  it("follows a reconnect under one live instance, in both directions", async () => {
    // The two-instance case above passes with an authority captured at construction; an in-place
    // reconnect, which replaces the grant while this cache stays alive, does not.
    const kv = makeKv();
    let authority = "a";
    const cache = new KvTtlCache(kv, () => authority);
    await cache.cached("project", 60_000, async () => "from a");

    authority = "b";
    expect(await cache.cached("project", 60_000, async () => "from b")).toBe("from b");

    // And B's value was not stamped as A's: going back to A must not serve it.
    authority = "a";
    expect(await cache.cached("project", 60_000, async () => "from a again")).toBe("from a again");
  });

  it("discards a value whose authority was replaced during the load", async () => {
    const kv = makeKv();
    let authority = "a";
    const cache = new KvTtlCache(kv, () => authority);
    const { promise, resolve } = Promise.withResolvers<string>();

    const loading = cache.cached("project", 60_000, () => promise);
    authority = "b";
    resolve("mid-reconnect");
    // Handed to the caller that asked before the change, as a generation bump is...
    expect(await loading).toBe("mid-reconnect");

    // ...and not stored under the authority the load began with. Asserted before any read under
    // "b", which would overwrite the entry and hide a mis-stamp.
    authority = "a";
    expect(await cache.cached("project", 60_000, async () => "fresh a")).toBe("fresh a");
  });

  it("does not share an in-flight load across a reconnect", async () => {
    const kv = makeKv();
    let authority = "a";
    const cache = new KvTtlCache(kv, () => authority);
    const { promise, resolve } = Promise.withResolvers<string>();

    const underA = cache.cached("project", 60_000, () => promise);
    authority = "b";
    // Coalescing must not hand B a value fetched with A's credentials.
    const underB = cache.cached("project", 60_000, async () => "from b");
    resolve("from a");

    expect(await underA).toBe("from a");
    expect(await underB).toBe("from b");
  });

  it("coalesces concurrent loads for one key", async () => {
    const cache = new KvTtlCache(makeKv(), () => "authority");
    const { promise, resolve } = Promise.withResolvers<number>();
    const load = vi.fn(() => promise);

    const first = cache.cached("project", 60_000, load);
    const second = cache.cached("project", 60_000, load);
    expect(load).toHaveBeenCalledOnce();
    resolve(1);

    await expect(Promise.all([first, second])).resolves.toEqual([1, 1]);
  });

  it("refuses a ttl that would silently disable or freeze the entry", async () => {
    const cache = new KvTtlCache(makeKv(), () => "authority");
    const load = vi.fn(async () => 1);

    // `Infinity` is the dangerous one: it never expires, so a stale entry is served for good.
    await expect(cache.cached("a", Infinity, load)).rejects.toThrow("ttlMs must be a positive");
    await expect(cache.cached("a", NaN, load)).rejects.toThrow("ttlMs must be a positive");
    await expect(cache.cached("a", 0, load)).rejects.toThrow("ttlMs must be a positive");
    expect(load).not.toHaveBeenCalled();
  });
});

describe("KvTtlCache.partitionedBy", () => {
  it("follows the source's authority: hit, bypass while unknown, miss after a change", async () => {
    let authority: string | undefined = "gen-a";
    const source: AuthoritySource = { authority: () => authority };
    const cache = KvTtlCache.partitionedBy(makeKv(), source);
    const load = vi.fn(async () => "from a");

    expect(await cache.cached("project", 60_000, load)).toBe("from a");
    expect(await cache.cached("project", 60_000, load)).toBe("from a");
    expect(load).toHaveBeenCalledOnce();

    authority = undefined;
    expect(await cache.cached("project", 60_000, async () => "unpartitioned"))
      .toBe("unpartitioned");

    authority = "gen-b";
    expect(await cache.cached("project", 60_000, async () => "from b")).toBe("from b");
  });

  function connectedSource() {
    const account = { identity: "id-a", generation: "gen-a" };
    const source = new CredentialSource<{ token: string }>({
      account: () => ({
        getCredentials: async () =>
          ({ creds: { token: "live" }, identity: account.identity, generation: account.generation }),
        noteCredentialsExpired: async () => {},
      }),
      isAuthError: error => error instanceof Error && error.message === "401",
      expiredMessage: "Reconnect the account.",
    });
    return { source, account };
  }

  it("partitions by a real source's connection across expiry and reconnect", async () => {
    const { source, account } = connectedSource();
    const cache = KvTtlCache.partitionedBy(makeKv(), source);
    const load = vi.fn(async () => "from a");

    // A fetch establishes the partition, and reads under it hit.
    await source.get();
    expect(await cache.cached("project", 60_000, load)).toBe("from a");
    expect(await cache.cached("project", 60_000, load)).toBe("from a");
    expect(load).toHaveBeenCalledOnce();

    // A reported expiry drops the partition: the cache bypasses rather than serves the dead grant.
    await expect(source.run(async () => { throw new Error("401"); }))
      .rejects.toThrow("Reconnect the account.");
    expect(await cache.cached("project", 60_000, async () => "unpartitioned"))
      .toBe("unpartitioned");

    // The account rotates on reconnect; the next fetch moves the cache to the new partition, so
    // the old principal's entries are misses.
    account.identity = "id-b";
    account.generation = "gen-b";
    await source.get();
    expect(await cache.cached("project", 60_000, async () => "from b")).toBe("from b");
  });

  it("keeps bypassing when a refetch returns the dead grant", async () => {
    const { source, account } = connectedSource();
    const cache = KvTtlCache.partitionedBy(makeKv(), source);

    await source.get();
    expect(await cache.cached("project", 60_000, async () => "from a")).toBe("from a");
    await expect(source.run(async () => { throw new Error("401"); }))
      .rejects.toThrow("Reconnect the account.");

    // The account keeps the grant until reconnect, so the refetch returns the same identity;
    // adopting its generation would let hit-only paths serve the dead partition unchecked.
    await source.get();
    expect(await cache.cached("project", 60_000, async () => "bypassed")).toBe("bypassed");

    account.identity = "id-b";
    account.generation = "gen-b";
    await source.get();
    expect(await cache.cached("project", 60_000, async () => "from b")).toBe("from b");
  });

  it("serves the last-seen partition until a fetch observes a reconnect", async () => {
    const { source, account } = connectedSource();
    const cache = KvTtlCache.partitionedBy(makeKv(), source);

    await source.get();
    expect(await cache.cached("project", 60_000, async () => "from a")).toBe("from a");

    // A silent in-place reconnect with no fetch since: the authority is last-seen, so the old
    // partition keeps hitting until the next credential read — the accepted TTL-bounded window.
    account.identity = "id-b";
    account.generation = "gen-b";
    expect(await cache.cached("project", 60_000, async () => "unseen")).toBe("from a");

    await source.get();
    expect(await cache.cached("project", 60_000, async () => "from b")).toBe("from b");
  });
});
