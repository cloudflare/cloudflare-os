import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mapConcurrent } from "./map-concurrent.ts";

// A deferred promise plus the resolve/reject handles, so a test can hold tasks open and observe
// how many are in flight.
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("mapConcurrent", () => {
  it("returns results in the input's order, not completion order", async () => {
    const gates = [deferred<string>(), deferred<string>(), deferred<string>()];
    const all = mapConcurrent([0, 1, 2], 3, i => gates[i].promise);
    // Resolve backwards: the slowest item is first in the input.
    gates[2].resolve("c");
    gates[1].resolve("b");
    gates[0].resolve("a");
    assert.deepEqual(await all, ["a", "b", "c"]);
  });

  it("runs no more than `limit` tasks at a time", async () => {
    let inFlight = 0;
    let peak = 0;
    const results = await mapConcurrent(Array.from({ length: 20 }, (_, i) => i), 4, async i => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise(resolve => setImmediate(resolve));
      inFlight--;
      return i * 2;
    });
    assert.equal(peak, 4);
    assert.deepEqual(results, Array.from({ length: 20 }, (_, i) => i * 2));
  });

  it("runs every remaining task after one rejects", async () => {
    const started: number[] = [];
    await assert.rejects(
      mapConcurrent([0, 1, 2, 3], 1, async i => {
        started.push(i);
        if (i === 0) throw new Error("first failed");
        return i;
      }),
      /first failed/);
    assert.deepEqual(started, [0, 1, 2, 3]);
  });

  it("rethrows a lone failure unwrapped", async () => {
    const boom = new Error("boom");
    await assert.rejects(
      mapConcurrent([1, 2], 2, async i => { if (i === 1) throw boom; return i; }),
      (error: unknown) => error === boom);
  });

  it("aggregates multiple failures", async () => {
    await assert.rejects(
      mapConcurrent([1, 2, 3], 2, async i => {
        if (i !== 2) throw new Error(`failed ${i}`);
        return i;
      }),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors.length, 2);
        assert.match(error.message, /2 of 3 tasks failed/);
        return true;
      });
  });

  it("accepts an empty list", async () => {
    assert.deepEqual(await mapConcurrent([], 4, async () => 1), []);
  });

  it("rejects a nonsensical limit", async () => {
    await assert.rejects(mapConcurrent([1], 0, async i => i), RangeError);
    await assert.rejects(mapConcurrent([1], 1.5, async i => i), RangeError);
  });
});
