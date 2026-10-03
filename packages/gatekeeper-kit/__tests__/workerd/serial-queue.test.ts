import { describe, expect, it } from "vitest";
import { SerialTaskQueue } from "../../src/serial-queue";

/**
 * Ordering is pure logic and covered in the Node suite. What needs the real runtime is the queue's
 * promise behaviour: the facet base wraps every action resolution in this queue inside a Durable
 * Object, and an unhandled rejection from a failed action only surfaces under workerd.
 */
describe("SerialTaskQueue in workerd", () => {
  it("isolates failures without leaving unhandled rejections behind", async () => {
    const queue = new SerialTaskQueue();
    const gate = Promise.withResolvers<void>();
    const order: string[] = [];

    // Settled together, as a caller must: a rejecting promise held unattached across an await is
    // reported unhandled by the runtime whatever the queue does.
    const settled = Promise.allSettled([
      queue.run(async () => {
        await gate.promise;
        order.push("first");
        throw new Error("apply failed");
      }),
      queue.run(async () => { order.push("second"); throw new Error("reject failed"); }),
      queue.run(async () => { order.push("third"); return "done"; }),
    ]);

    gate.resolve();
    expect(await settled).toEqual([
      { status: "rejected", reason: new Error("apply failed") },
      { status: "rejected", reason: new Error("reject failed") },
      { status: "fulfilled", value: "done" },
    ]);
    expect(order).toEqual(["first", "second", "third"]);
  });

  it("keeps running later operations after one throws synchronously", async () => {
    const queue = new SerialTaskQueue();
    await expect(queue.run(() => { throw new Error("sync throw"); })).rejects.toThrow("sync throw");
    expect(await queue.run(() => 1)).toBe(1);
  });
});
