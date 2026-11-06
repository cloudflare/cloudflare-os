import { afterEach, describe, expect, it, vi } from "vitest";
import { KvTtlCache, type AuthoritySource, type CacheKv } from "../src/cache";
import { CredentialsExpiredError, CredentialSource } from "../src/credentials";
import { fakeKv } from "./fake-kv";

function makeKv(): CacheKv {
  return fakeKv();
}

/** Trusts an allowed answer ten times longer than a denial. */
function accessTtl(allowed: boolean): number {
  return allowed ? 10_000 : 1000;
}

function connectedSource() {
  const account = { identity: "id-a", generation: "gen-a", connected: true };
  const getCredentials = vi.fn(async () => {
    if (!account.connected) throw new Error("account not connected");
    return {
      creds: { token: "live" },
      identity: account.identity,
      generation: account.generation,
    };
  });
  const source = new CredentialSource<{ token: string }>({
    account: () => ({ getCredentials, reportCredentialsRejected: async () => "expired" as const }),
    isAuthError: error => error instanceof Error && error.message === "401",
    expiredMessage: "Reconnect.",
  });
  return { source, account, getCredentials };
}

afterEach(() => void vi.useRealTimers());

describe("KvTtlCache", () => {
  it("loads once, then serves the entry until its TTL elapses", async () => {
    vi.useFakeTimers();
    const cache = new KvTtlCache(makeKv(), () => "authority", { legacyUnnamed: true });
    const load = vi.fn(async () => ({ name: "acme" }));

    expect(await cache.cached("project", 1000, load)).toEqual({ name: "acme" });
    vi.advanceTimersByTime(999);
    expect(await cache.cached("project", 1000, load)).toEqual({ name: "acme" });
    expect(load).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(1);
    expect(await cache.cached("project", 1000, load)).toEqual({ name: "acme" });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("dates the entry from the load, not from the fence read that follows it", async () => {
    // `cacheAuthority()` is a live account read that can itself refresh credentials. Stamping the
    // entry when that returns would hand the caller the whole TTL again on top of the wait.
    vi.useFakeTimers();
    const fence = Promise.withResolvers<void>();
    let reads = 0;
    const cache = new KvTtlCache(makeKv(), async () => {
      // The entry read runs first; only the one after `load()` is parked.
      if (++reads === 2) await fence.promise;
      return "authority";
    }, { legacyUnnamed: true });

    const loading = cache.cached("project", 60_000, async () => "loaded");
    // The load has resolved and the fence read is parked; the clock runs while it waits.
    await vi.advanceTimersByTimeAsync(30_000);
    fence.resolve();
    expect(await loading).toBe("loaded");

    // 30s of the 60s window went to the fence read, so the entry expires 30s from now, not 60s.
    await vi.advanceTimersByTimeAsync(31_000);
    const reload = vi.fn(async () => "reloaded");
    expect(await cache.cached("project", 60_000, reload)).toBe("reloaded");
  });

  it("dates a batch from when its load started, however long the loader takes", async () => {
    // A loader that splits its keys into sequential requests learns its first answer long before
    // it returns. Dating the entries from the return would serve that answer past its TTL.
    vi.useFakeTimers();
    const cache = new KvTtlCache(makeKv(), () => "authority", { name: "access" });
    const answered = Promise.withResolvers<string[]>();
    const loading = cache.cachedMany(["a", "b"], 15_000, () => answered.promise);
    await vi.advanceTimersByTimeAsync(10_000);
    answered.resolve(["a", "b"]);
    expect(await loading).toEqual(["a", "b"]);

    const reload = vi.fn(async (keys: string[]) => keys.map(key => `${key} again`));
    await vi.advanceTimersByTimeAsync(4999);
    expect(await cache.cachedMany(["a", "b"], 15_000, reload)).toEqual(["a", "b"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await cache.cachedMany(["a", "b"], 15_000, reload)).toEqual(["a again", "b again"]);
  });

  it("leaves no load claimed when a later key's TTL is refused", async () => {
    const cache = new KvTtlCache(makeKv(), () => "authority", { name: "access" });
    await cache.cached("existing", 60_000, async () => false);

    // The cached `false` is refused a TTL, after "missing" was found absent.
    await expect(cache.cachedMany<boolean>(["missing", "existing"], allowed => allowed ? 60_000 : 0,
      async keys => keys.map(() => true))).rejects.toThrow("ttlMs must be a positive");
    // A claim stranded by that throw would leave this joining a load that never settles.
    expect(await cache.cached("missing", 60_000, async () => true)).toBe(true);
  });

  it("coalesces one key across instances over the same storage", async () => {
    // A facet that builds its cache per call has two instances over one namespace. Coalescing per
    // instance would let both load, and the slower one overwrite the newer entry afterwards.
    const kv = makeKv();
    const cache = () => new KvTtlCache(kv, () => "authority", { name: "projects" });
    const load = vi.fn(async () => "loaded");

    const both = await Promise.all([
      cache().cached("project", 60_000, load),
      cache().cached("project", 60_000, load),
    ]);

    expect(both).toEqual(["loaded", "loaded"]);
    expect(load).toHaveBeenCalledOnce();
  });

  it("keeps two named caches over one storage from sharing a load", async () => {
    const kv = makeKv();
    const projects = new KvTtlCache(kv, () => "authority", { name: "projects" });
    const issues = new KvTtlCache(kv, () => "authority", { name: "issues" });

    // Concurrent, so a load key missing the cache's own prefix would collapse them into one.
    expect(await Promise.all([
      projects.cached("a", 60_000, async () => "from projects"),
      issues.cached("a", 60_000, async () => "from issues"),
    ])).toEqual(["from projects", "from issues"]);
  });

  it("reloads every entry after invalidating all", async () => {
    const cache = new KvTtlCache(makeKv(), () => "authority", { legacyUnnamed: true });
    await cache.cached("a", 60_000, async () => 1);
    await cache.cached("b", 60_000, async () => 2);

    cache.invalidateAll();
    expect(await cache.cached("a", 60_000, async () => 3)).toBe(3);
    expect(await cache.cached("b", 60_000, async () => 4)).toBe(4);

    // Reloaded against the new generation, so the entry is live again.
    expect(await cache.cached("a", 60_000, async () => 5)).toBe(3);
  });

  it("does not store a value invalidated during a load", async () => {
    const cache = new KvTtlCache(makeKv(), () => "authority", { legacyUnnamed: true });
    const { promise, resolve } = Promise.withResolvers<number>();
    const load = vi.fn(() => promise);

    const loading = cache.cached("schema", 60_000, load);
    // Inside the load, not before it: the authority read precedes it, so an invalidation landing
    // earlier is one this load already reflects.
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
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
    const cache = new KvTtlCache(kv, () => authority, { legacyUnnamed: true });
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
    const cache = new KvTtlCache(kv, () => authority, { legacyUnnamed: true });
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
    const authorityA = new KvTtlCache(kv, () => "a", { legacyUnnamed: true });
    const authorityB = new KvTtlCache(kv, () => "b", { legacyUnnamed: true });
    await authorityA.cached("project", 60_000, async () => "from a");
    const load = vi.fn(async () => "from b");

    expect(await authorityB.cached("project", 60_000, load)).toBe("from b");
    expect(load).toHaveBeenCalledOnce();
  });

  it("keeps named caches over one storage from colliding or invalidating each other", async () => {
    // Two logical families with a natural key in common: unnamed, each would serve the other's
    // value on a hit, and either one's invalidateAll would clear both.
    const kv = makeKv();
    const issues = new KvTtlCache(kv, () => "authority", { name: "issues" });
    const pages = new KvTtlCache(kv, () => "authority", { name: "pages" });

    expect(await issues.cached("home", 60_000, async () => "issue")).toBe("issue");
    expect(await pages.cached("home", 60_000, async () => "page")).toBe("page");

    issues.invalidateAll();
    expect(await issues.cached("home", 60_000, async () => "issue again")).toBe("issue again");
    expect(await pages.cached("home", 60_000, async () => "page again")).toBe("page");
  });

  it("keeps a named cache clear of the unnamed layout ports already have in storage", async () => {
    const kv = makeKv();
    const ported = new KvTtlCache(kv, () => "authority", { legacyUnnamed: true });
    // "entry" is the name that would collide without the sigil: `cache:entry:generation` is the
    // unnamed cache's own entry for the key "generation", and `cache:entry:entry:home` is its
    // entry for "entry:home".
    const named = new KvTtlCache(kv, () => "authority", { name: "entry" });

    expect(await ported.cached("home", 60_000, async () => "legacy")).toBe("legacy");
    expect(await ported.cached("generation", 60_000, async () => "counter-shaped")).toBe(
      "counter-shaped");
    expect(await named.cached("home", 60_000, async () => "named")).toBe("named");
    named.invalidateAll();

    // Both survive the other's writes, and the unnamed layout is byte-for-byte what ports have.
    expect(await ported.cached("home", 60_000, async () => "legacy again")).toBe("legacy");
    expect(await ported.cached("generation", 60_000, async () => "again")).toBe("counter-shaped");
    expect(kv.get("cache:entry:home")).toBeDefined();
    expect(kv.get("cache:@entry:entry:home")).toBeDefined();
  });

  it("refuses a name that would not survive the key it is spliced into", () => {
    for (const name of ["", "has:colon", "spaced name"]) {
      expect(() => new KvTtlCache(makeKv(), () => "authority", { name })).toThrow(/Cache name/);
    }
  });

  it("follows a reconnect under one live instance, in both directions", async () => {
    // The two-instance case above passes with an authority captured at construction; an in-place
    // reconnect, which replaces the grant while this cache stays alive, does not.
    const kv = makeKv();
    let authority = "a";
    const cache = new KvTtlCache(kv, () => authority, { legacyUnnamed: true });
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
    const cache = new KvTtlCache(kv, () => authority, { legacyUnnamed: true });
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
    const cache = new KvTtlCache(kv, () => authority, { legacyUnnamed: true });
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
    const cache = new KvTtlCache(makeKv(), () => "authority", { legacyUnnamed: true });
    const { promise, resolve } = Promise.withResolvers<number>();
    const load = vi.fn(() => promise);

    const first = cache.cached("project", 60_000, load);
    const second = cache.cached("project", 60_000, load);
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    resolve(1);

    await expect(Promise.all([first, second])).resolves.toEqual([1, 1]);
  });

  it("loads only the missing keys of a batch, together, and answers in the order asked", async () => {
    const cache = new KvTtlCache(makeKv(), () => "authority", { name: "access" });
    await cache.cached("a", 60_000, async () => "cached a");
    const load = vi.fn(async (keys: string[]) => keys.map(key => `loaded ${key}`));

    expect(await cache.cachedMany(["b", "a", "c", "b"], 60_000, load))
      .toEqual(["loaded b", "cached a", "loaded c", "loaded b"]);
    expect(load).toHaveBeenCalledExactlyOnceWith(["b", "c"]);

    // Each key was stored on its own, so a differently shaped batch reuses them.
    expect(await cache.cachedMany(["c", "b"], 60_000, load)).toEqual(["loaded c", "loaded b"]);
    expect(load).toHaveBeenCalledOnce();
  });

  it("cuts batches from the missing keys alone, loading one batch at a time", async () => {
    const cache = new KvTtlCache(makeKv(), () => "authority", { name: "access" });
    await cache.cachedMany(["a", "c"], 60_000, async keys => keys.map(key => `cached ${key}`));
    let loading = 0;
    const load = vi.fn(async (keys: string[]) => {
      expect(++loading).toBe(1);
      await Promise.resolve();
      loading--;
      return keys.map(key => `loaded ${key}`);
    });

    expect(await cache.cachedMany(["a", "b", "c", "d", "e"], 60_000, load, { batchSize: 2 }))
      .toEqual(["cached a", "loaded b", "cached c", "loaded d", "loaded e"]);
    expect(load.mock.calls).toEqual([[["b", "d"]], [["e"]]]);
  });

  it("keeps the batches before one that failed, and loads none after it", async () => {
    const cache = new KvTtlCache(makeKv(), () => "authority", { name: "access" });
    const failing = vi.fn(async ([key]: string[]) => {
      if (key === "b") throw new Error("b failed");
      return [key];
    });

    await expect(cache.cachedMany(["a", "b", "c"], 60_000, failing, { batchSize: 1 }))
      .rejects.toThrow("b failed");
    expect(failing.mock.calls).toEqual([[["a"]], [["b"]]]);

    const retry = vi.fn(async (keys: string[]) => keys);
    expect(await cache.cachedMany(["a", "b", "c"], 60_000, retry, { batchSize: 1 }))
      .toEqual(["a", "b", "c"]);
    expect(retry.mock.calls).toEqual([[["b"]], [["c"]]]);
  });

  it("batches the keys it loads without a known authority", async () => {
    const cache = new KvTtlCache(makeKv(), () => undefined, { name: "access" });
    const load = vi.fn(async (keys: string[]) => keys);

    expect(await cache.cachedMany(["a", "b", "a", "c"], 60_000, load, { batchSize: 2 }))
      .toEqual(["a", "b", "a", "c"]);
    expect(load.mock.calls).toEqual([[["a", "b"]], [["c"]]]);
  });

  it("refuses a batch size that is not a positive integer", async () => {
    const cache = new KvTtlCache(makeKv(), () => "authority", { name: "access" });

    await expect(cache.cachedMany(["a"], 60_000, async keys => keys, { batchSize: 0 }))
      .rejects.toThrow("batchSize must be a positive");
  });

  it("fails a load whose value its TTL refuses, storing nothing", async () => {
    const cache = new KvTtlCache(makeKv(), () => "authority", { name: "access" });
    const ttl = (allowed: boolean) => allowed ? 60_000 : 0;

    await expect(cache.cachedMany(["key"], ttl, async () => [false]))
      .rejects.toThrow("ttlMs must be a positive");
    // Stored, the refused value would fail every later read of the key without loading it again.
    expect(await cache.cachedMany(["key"], ttl, async () => [true])).toEqual([true]);
  });

  it("joins a key another caller is loading, and lets later callers join its own", async () => {
    const cache = new KvTtlCache(makeKv(), () => "authority", { name: "access" });
    const single = Promise.withResolvers<string>();
    const batch = Promise.withResolvers<string[]>();
    const loadOne = vi.fn(() => single.promise);
    const loadMany = vi.fn(() => batch.promise);

    const a = cache.cached("a", 60_000, loadOne);
    await vi.waitFor(() => expect(loadOne).toHaveBeenCalledOnce());
    const both = cache.cachedMany(["a", "b"], 60_000, loadMany);
    await vi.waitFor(() => expect(loadMany).toHaveBeenCalledExactlyOnceWith(["b"]));
    const b = cache.cached("b", 60_000, async () => "b loaded twice");

    single.resolve("a");
    batch.resolve(["b"]);
    await expect(Promise.all([a, both, b])).resolves.toEqual(["a", ["a", "b"], "b"]);
  });

  it("refuses a batch answer of the wrong length, storing none of it", async () => {
    const cache = new KvTtlCache(makeKv(), () => "authority", { name: "access" });

    await expect(cache.cachedMany(["a", "b"], 60_000, async () => ["a"]))
      .rejects.toThrow("different number of values");
    expect(await cache.cachedMany(["a", "b"], 60_000, async keys => keys)).toEqual(["a", "b"]);
  });

  it("does not store a batch whose authority was replaced during the load", async () => {
    let authority = "a";
    const cache = new KvTtlCache(makeKv(), () => authority, { name: "access" });
    const { promise, resolve } = Promise.withResolvers<string[]>();

    const loading = cache.cachedMany(["x", "y"], 60_000, () => promise);
    authority = "b";
    resolve(["from a", "from a"]);
    expect(await loading).toEqual(["from a", "from a"]);

    authority = "a";
    expect(await cache.cachedMany(["x", "y"], 60_000, async keys => keys.map(() => "fresh a")))
      .toEqual(["fresh a", "fresh a"]);
  });

  it("expires each entry by the TTL its value is given", async () => {
    vi.useFakeTimers();
    const cache = new KvTtlCache(makeKv(), () => "authority", { name: "access" });
    const load = vi.fn(async (keys: string[]) => keys.map(key => key === "allowed"));

    expect(await cache.cachedMany(["allowed", "denied"], accessTtl, load)).toEqual([true, false]);
    vi.advanceTimersByTime(999);
    await cache.cachedMany(["allowed", "denied"], accessTtl, load);
    expect(load).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(1);
    await cache.cachedMany(["allowed", "denied"], accessTtl, load);
    expect(load).toHaveBeenLastCalledWith(["denied"]);

    vi.advanceTimersByTime(8999);
    await cache.cachedMany(["allowed"], accessTtl, load);
    expect(load).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    await cache.cachedMany(["allowed"], accessTtl, load);
    expect(load).toHaveBeenLastCalledWith(["allowed"]);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("refuses a ttl that would silently disable or freeze the entry", async () => {
    const cache = new KvTtlCache(makeKv(), () => "authority", { legacyUnnamed: true });
    const load = vi.fn(async () => 1);

    // `Infinity` is the dangerous one: it never expires, so a stale entry is served for good.
    await expect(cache.cached("a", Infinity, load)).rejects.toThrow("ttlMs must be a positive");
    await expect(cache.cached("a", NaN, load)).rejects.toThrow("ttlMs must be a positive");
    await expect(cache.cached("a", 0, load)).rejects.toThrow("ttlMs must be a positive");
    // One chosen by the value is checked for each entry it is asked about.
    await cache.cached("b", 60_000, async () => 2);
    await expect(cache.cached("b", () => Infinity, load)).rejects.toThrow("ttlMs must be a positive");
    expect(load).not.toHaveBeenCalled();
  });
});

describe("KvTtlCache.partitionedBy", () => {
  it("repartitions on a reconnect no fetch has observed yet", async () => {
    let generation = "gen-a";
    const source: AuthoritySource = { cacheAuthority: async () => generation };
    const cache = KvTtlCache.partitionedBy(makeKv(), source, { legacyUnnamed: true });
    const load = vi.fn(async () => "from a");

    expect(await cache.cached("project", 60_000, load)).toBe("from a");
    expect(await cache.cached("project", 60_000, load)).toBe("from a");
    expect(load).toHaveBeenCalledOnce();

    // A last-seen partition would have served "from a" for the rest of the entry's TTL.
    generation = "gen-b";
    expect(await cache.cached("project", 60_000, async () => "from b")).toBe("from b");
  });

  it("returns a load whose fence moved during it, without caching the value", async () => {
    let generation = "gen-a";
    const kv = fakeKv();
    const cache = KvTtlCache.partitionedBy(kv, { cacheAuthority: async () => generation }, { legacyUnnamed: true });
    const { promise, resolve } = Promise.withResolvers<string>();

    const loading = cache.cached("project", 60_000, () => promise);
    generation = "gen-b";
    resolve("from a");

    expect(await loading).toBe("from a");
    expect(kv.keys()).toEqual([]);
  });

  it("caches nothing when an invalidation lands during the post-load fence read", async () => {
    // The generation must be read after that await. Read before it, this value would be written
    // under a generation the invalidation had already retired.
    const kv = fakeKv();
    const parked = Promise.withResolvers<void>();
    let reads = 0;
    const cache = KvTtlCache.partitionedBy(kv, {
      cacheAuthority: async () => {
        if (++reads === 2) await parked.promise;
        return "gen-a";
      },
    }, { legacyUnnamed: true });

    const loading = cache.cached("project", 60_000, async () => "loaded");
    await vi.waitFor(() => expect(reads).toBe(2));
    cache.invalidateAll();
    parked.resolve();

    expect(await loading).toBe("loaded");
    expect(kv.keys()).toEqual(["cache:generation"]);
  });

  it("partitions a real source by the connection its account fences reads under", async () => {
    const { source, account } = connectedSource();
    const cache = KvTtlCache.partitionedBy(makeKv(), source, { legacyUnnamed: true });
    const load = vi.fn(async () => "from a");

    expect(await cache.cached("project", 60_000, load)).toBe("from a");
    expect(await cache.cached("project", 60_000, load)).toBe("from a");
    expect(load).toHaveBeenCalledOnce();

    // An in-place reconnect with no fetch in between: the hit reads the fence, so it misses.
    account.identity = "id-b";
    account.generation = "gen-b";
    expect(await cache.cached("project", 60_000, async () => "from b")).toBe("from b");
  });

  it("shares one account credential read between concurrent hits", async () => {
    const { source, getCredentials } = connectedSource();
    const cache = KvTtlCache.partitionedBy(makeKv(), source, { legacyUnnamed: true });
    await cache.cached("project", 60_000, async () => "from a");
    getCredentials.mockClear();
    const load = vi.fn(async () => "reloaded");

    expect(await Promise.all([
      cache.cached("project", 60_000, load),
      cache.cached("project", 60_000, load),
    ])).toEqual(["from a", "from a"]);
    expect(getCredentials).toHaveBeenCalledOnce();
    expect(load).not.toHaveBeenCalled();
  });

  it("bypasses cached data while the source refuses to vouch for an expired grant", async () => {
    const { source, account } = connectedSource();
    const cache = KvTtlCache.partitionedBy(makeKv(), source, { legacyUnnamed: true });
    expect(await cache.cached("project", 60_000, async () => "from a")).toBe("from a");

    // The account may keep serving a dead grant until reconnect. The source already knows that
    // identity is dead, so a cache hit must not hide the outage for the rest of the entry's TTL.
    await expect(source.run(async () => { throw new Error("401"); }))
      .rejects.toThrow(CredentialsExpiredError);
    const load = vi.fn(async () => "reloaded");
    expect(await cache.cached("project", 60_000, load)).toBe("reloaded");
    expect(load).toHaveBeenCalledOnce();

    account.identity = "id-b";
    account.generation = "gen-b";
    expect(await cache.cached("project", 60_000, async () => "from b")).toBe("from b");
  });

  it("propagates a disconnected account rather than serving or bypassing", async () => {
    const { source, account } = connectedSource();
    const cache = KvTtlCache.partitionedBy(makeKv(), source, { legacyUnnamed: true });
    const load = vi.fn(async () => "from a");

    account.connected = false;
    await expect(cache.cached("project", 60_000, load)).rejects.toThrow("account not connected");
    expect(load).not.toHaveBeenCalled();
  });

  it("returns a load the account can no longer vouch for, uncached", async () => {
    const { source, account } = connectedSource();
    const kv = fakeKv();
    const cache = KvTtlCache.partitionedBy(kv, source, { legacyUnnamed: true });

    const loaded = await cache.cached("project", 60_000, async () => {
      account.connected = false;
      return "from a";
    });

    expect(loaded).toBe("from a");
    expect(kv.keys()).toEqual([]);
  });
});
