import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DELIVERED_RETENTION_MS, HookDeliveryQueue, MAX_DELIVERIES_PER_RUN, MAX_DELIVERY_ATTEMPTS, disposeStubs,
} from "../src/hook-delivery-queue";
import { fakeKv } from "./fake-kv";

const MINUTE = 60_000;

describe("HookDeliveryQueue", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000_000 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("delivers each queued message once, and collapses a duplicate push", async () => {
    const queue = new HookDeliveryQueue<string>(fakeKv(), () => {});
    queue.enqueue("hook", "m1", "first", Date.now());
    queue.enqueue("hook", "m1", "duplicate", Date.now());
    const deliver = vi.fn(async () => {});

    await queue.run(Date.now(), deliver);
    queue.enqueue("hook", "m1", "redelivered", Date.now());
    await queue.run(Date.now(), deliver);

    expect(deliver.mock.calls).toEqual([["hook", "first"]]);
  });

  it("retries a failed delivery with backoff, then drops it after the last attempt", async () => {
    const onDrop = vi.fn();
    const queue = new HookDeliveryQueue<string>(fakeKv(), onDrop);
    queue.enqueue("hook", "m1", "message", Date.now());
    const deliver = vi.fn(async () => { throw new Error("the gadget failed"); });

    await queue.run(Date.now(), deliver);
    expect(queue.nextDue()).toBe(Date.now() + MINUTE);
    // Not due yet: nothing is attempted.
    await queue.run(Date.now(), deliver);
    expect(deliver).toHaveBeenCalledTimes(1);

    for (let attempt = 2; attempt <= MAX_DELIVERY_ATTEMPTS; attempt++) {
      vi.setSystemTime(queue.nextDue()!);
      await queue.run(Date.now(), deliver);
    }
    expect(deliver).toHaveBeenCalledTimes(MAX_DELIVERY_ATTEMPTS);
    expect(onDrop).toHaveBeenCalledOnce();
    // Finished, so only its expiry remains due.
    expect(queue.nextDue()).toBe(Date.now() + DELIVERED_RETENTION_MS);
  });

  it("finishes a cancelled hook's pending messages, which still collapse duplicates", async () => {
    const queue = new HookDeliveryQueue<string>(fakeKv(), () => {});
    queue.enqueue("a", "m1", "for a", Date.now());
    queue.enqueue("b", "m1", "for b", Date.now());
    queue.cancel("a");
    queue.enqueue("a", "m1", "for a again", Date.now());
    const deliver = vi.fn(async () => {});

    await queue.run(Date.now(), deliver);

    expect(deliver.mock.calls).toEqual([["b", "for b"]]);
  });

  it("starts at most MAX_DELIVERIES_PER_RUN deliveries, oldest first", async () => {
    const queue = new HookDeliveryQueue<number>(fakeKv(), () => {});
    for (let i = MAX_DELIVERIES_PER_RUN; i >= 0; i--) queue.enqueue("hook", `m${i}`, i, Date.now() - i);
    const delivered: number[] = [];

    await queue.run(Date.now(), async (_hook, message) => { delivered.push(message); });

    expect(delivered).toHaveLength(MAX_DELIVERIES_PER_RUN);
    expect(delivered).not.toContain(0);
    expect(queue.nextDue()).toBe(Date.now());
  });

  it("forgets finished messages once the dedupe window has passed", async () => {
    const kv = fakeKv();
    const queue = new HookDeliveryQueue<string>(kv, () => {});
    queue.enqueue("hook", "m1", "message", Date.now());
    await queue.run(Date.now(), async () => {});

    vi.setSystemTime(Date.now() + DELIVERED_RETENTION_MS);
    await queue.run(Date.now(), async () => {});

    expect(kv.keys()).toEqual([]);
    expect(queue.nextDue()).toBeUndefined();
  });
});

describe("disposeStubs", () => {
  it("disposes each value that is disposable", () => {
    const dispose = vi.fn();
    disposeStubs({ delivery: { [Symbol.dispose]: dispose }, initiator: { [Symbol.dispose]: dispose }, other: {} });
    disposeStubs(undefined);
    expect(dispose).toHaveBeenCalledTimes(2);
  });
});
