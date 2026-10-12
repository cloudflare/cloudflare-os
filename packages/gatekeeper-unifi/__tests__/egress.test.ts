// Pacing and caching, which keep a binding's requests inside a console's budget.

import { describe, expect, it } from "vitest";
import { ResponseCache, TokenBucket } from "../src/egress";

/** A clock tests advance by hand; `sleep` advances it instead of waiting. */
function clock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => { now += ms; },
    sleep: async (ms: number) => { now += ms; },
  };
}

describe("TokenBucket", () => {
  it("allows a burst up to capacity, then paces requests at the refill rate", async () => {
    const t = clock();
    const bucket = new TokenBucket({ capacity: 3, refillMs: 1000 }, t.now);
    for (let i = 0; i < 3; i++) expect(await bucket.take(0, t.sleep)).toBe(0);
    // The fourth must wait a full refill period; within budget, it waits and succeeds.
    const before = t.now();
    expect(await bucket.take(5000, t.sleep)).toBe(0);
    expect(t.now() - before).toBe(1000);
  });

  it("fails fast, reporting the wait, when the wait would exceed the caller's patience", async () => {
    const t = clock();
    const bucket = new TokenBucket({ capacity: 1, refillMs: 10_000 }, t.now);
    expect(await bucket.take(0, t.sleep)).toBe(0);
    expect(await bucket.take(5000, t.sleep)).toBe(10_000);
  });

  it("refills while idle, but never beyond capacity", async () => {
    const t = clock();
    const bucket = new TokenBucket({ capacity: 2, refillMs: 100 }, t.now);
    await bucket.take(0, t.sleep);
    await bucket.take(0, t.sleep);
    t.advance(60_000);
    expect(await bucket.take(0, t.sleep)).toBe(0);
    expect(await bucket.take(0, t.sleep)).toBe(0);
    expect(await bucket.take(0, t.sleep)).toBe(100);
  });

  it("stops issuing tokens while blocked by a 429", async () => {
    const t = clock();
    const bucket = new TokenBucket({ capacity: 10, refillMs: 100 }, t.now);
    bucket.block(t.now() + 6000);
    expect(await bucket.take(5000, t.sleep)).toBe(6000);
    t.advance(6000);
    expect(await bucket.take(5000, t.sleep)).toBe(0);
  });
});

describe("ResponseCache", () => {
  it("serves a fresh answer without loading again, and reloads once it is stale", async () => {
    const t = clock();
    const cache = new ResponseCache<number>(t.now);
    let loads = 0;
    const load = async () => ++loads;
    expect(await cache.get("console:a", "k", 5000, load, () => true)).toBe(1);
    expect(await cache.get("console:a", "k", 5000, load, () => true)).toBe(1);
    t.advance(5001);
    expect(await cache.get("console:a", "k", 5000, load, () => true)).toBe(2);
  });

  it("shares one load between concurrent misses", async () => {
    const cache = new ResponseCache<string>();
    let loads = 0;
    let release!: (value: string) => void;
    const load = () => { loads++; return new Promise<string>(resolve => { release = resolve; }); };
    const both = Promise.all([cache.get("g", "k", 1000, load, () => true), cache.get("g", "k", 1000, load, () => true)]);
    release("answer");
    expect(await both).toEqual(["answer", "answer"]);
    expect(loads).toBe(1);
  });

  it("doesn't keep answers `keep` refuses, such as failures", async () => {
    const cache = new ResponseCache<{ ok: boolean }>();
    let loads = 0;
    const load = async () => ({ ok: ++loads > 1 });
    expect(await cache.get("g", "k", 1000, load, r => r.ok)).toEqual({ ok: false });
    expect(await cache.get("g", "k", 1000, load, r => r.ok)).toEqual({ ok: true });
    expect(loads).toBe(2);
  });

  it("drops a console's answers when it is written to, and only that console's", async () => {
    const cache = new ResponseCache<number>();
    let loads = 0;
    const load = async () => ++loads;
    await cache.get("console:a", "a", 60_000, load, () => true);
    await cache.get("console:b", "b", 60_000, load, () => true);
    cache.invalidate("console:a");
    expect(await cache.get("console:a", "a", 60_000, load, () => true)).toBe(3);
    expect(await cache.get("console:b", "b", 60_000, load, () => true)).toBe(2);
  });

  it("doesn't store an answer loaded across a write, which may predate it", async () => {
    const cache = new ResponseCache<number>();
    let release!: (value: number) => void;
    const pending = cache.get("g", "k", 60_000, () => new Promise<number>(resolve => { release = resolve; }), () => true);
    cache.invalidate("g");
    release(1);
    expect(await pending).toBe(1);
    let reloads = 0;
    expect(await cache.get("g", "k", 60_000, async () => { reloads++; return 2; }, () => true)).toBe(2);
    expect(reloads).toBe(1);
  });

  it("stays bounded", async () => {
    const cache = new ResponseCache<number>(Date.now, 3);
    for (let i = 0; i < 10; i++) await cache.get("g", `k${i}`, 60_000, async () => i, () => true);
    let reloaded = false;
    await cache.get("g", "k0", 60_000, async () => { reloaded = true; return 0; }, () => true);
    expect(reloaded).toBe(true);
  });
});
