import { describe, expect, it } from "vitest";
import { KeyedConcurrencyLimiter } from "../src/concurrency-limiter.js";

describe("KeyedConcurrencyLimiter", () => {
  it("caps each key separately and hands slots to waiters in order", async () => {
    let limiter = new KeyedConcurrencyLimiter(2);
    let a1 = limiter.tryAcquire("a")!;
    let a2 = limiter.tryAcquire("a")!;
    expect(limiter.tryAcquire("a")).toBeUndefined();
    expect(limiter.tryAcquire("b")).toBeDefined();

    let order: number[] = [];
    let w1 = limiter.acquire("a").then(r => { order.push(1); return r; });
    let w2 = limiter.acquire("a").then(r => { order.push(2); return r; });
    expect(limiter.stats("a")).toEqual({ active: 2, waiting: 2 });

    a1();
    a1(); // idempotent: must not free a second slot
    let r1 = await w1;
    expect(limiter.stats("a")).toEqual({ active: 2, waiting: 1 });
    a2();
    let r2 = await w2;
    expect(order).toEqual([1, 2]);
    r1();
    r2();
    expect(limiter.stats("a")).toEqual({ active: 0, waiting: 0 });
  });

  it("rejects a non-positive limit", () => {
    expect(() => new KeyedConcurrencyLimiter(0)).toThrow(RangeError);
  });
});
