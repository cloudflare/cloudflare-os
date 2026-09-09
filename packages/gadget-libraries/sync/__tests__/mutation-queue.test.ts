// @vitest-environment node
import { describe, expect, it } from "vitest";

import { MutationQueue } from "../src/mutation-queue.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("MutationQueue", () => {
  it("runs work in call order, each seeing what the last one left", async () => {
    const queue = new MutationQueue();
    let state = 0;
    const log: number[] = [];
    const bump = (by: number) =>
      queue.run(async () => {
        const seen = state;
        await tick();
        state = seen + by;
        log.push(state);
        return state;
      });
    const results = await Promise.all([bump(1), bump(10), bump(100)]);
    expect(results).toEqual([1, 11, 111]);
    expect(log).toEqual([1, 11, 111]);
  });

  it("delivers a rejection to its caller alone and keeps going", async () => {
    const queue = new MutationQueue();
    const failed = queue.run(async () => {
      throw new Error("boom");
    });
    const next = queue.run(() => "after");
    await expect(failed).rejects.toThrow("boom");
    await expect(next).resolves.toBe("after");
  });

  it("accepts synchronous work", async () => {
    const queue = new MutationQueue();
    await expect(queue.run(() => 7)).resolves.toBe(7);
  });
});
