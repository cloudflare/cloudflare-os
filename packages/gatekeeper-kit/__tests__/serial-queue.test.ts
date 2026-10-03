import { describe, expect, it } from "vitest";
import { SerialTaskQueue } from "../src/serial-queue";

describe("SerialTaskQueue", () => {
  it("runs operations in submission order, isolating rejections", async () => {
    const queue = new SerialTaskQueue();
    const slow = Promise.withResolvers<void>();
    const order: string[] = [];

    const first = queue.run(async () => {
      await slow.promise;
      order.push("first");
    });
    const failing = queue.run(async () => { throw new Error("boom"); });
    const last = queue.run(async () => void order.push("last"));

    expect(order).toEqual([]);
    slow.resolve();
    await expect(failing).rejects.toThrow("boom");
    await Promise.all([first, last]);
    expect(order).toEqual(["first", "last"]);
  });
});
