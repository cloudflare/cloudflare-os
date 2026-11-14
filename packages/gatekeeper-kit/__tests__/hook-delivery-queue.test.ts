import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DELIVERED_RETENTION_MS, HookDeliveryQueue, MAX_DELIVERIES_PER_RUN, MAX_DELIVERY_ATTEMPTS, disposeStubs,
} from "../src/hook-delivery-queue";
import { fakeKv, type FakeKv } from "./fake-kv";

const MINUTE = 60_000;
/** Set once the queue has indexed its rows (see the module's storage notes). */
const INDEXED = "queue:indexed";
/** What a finished `m1` leaves: its row, and the index entry by which it is forgotten a day later. */
const FINISHED_M1 = ["msg:hook:m1", expect.stringMatching(/^queue:finished:\d{15}:hook:m1$/), INDEXED];

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

  it.each<[string, "succeeds" | "fails", (queue: HookDeliveryQueue<string>, kv: FakeKv) => void, unknown[]]>([
    // Disabling the hook: its row is finished, and indexed for forgetting, so a duplicate push
    // still collapses.
    ["cancelled", "fails", queue => queue.cancel("hook"), FINISHED_M1],
    ["cancelled", "succeeds", queue => queue.cancel("hook"), FINISHED_M1],
    // Its driver forgetting every hook, as disconnecting the account does: its index entry goes too.
    ["deleted", "fails", (_queue, kv) => kv.delete("msg:hook:m1"), [INDEXED]],
    ["deleted", "succeeds", (_queue, kv) => kv.delete("msg:hook:m1"), [INDEXED]],
  ])("neither retries nor revives a message whose row is %s while its attempt %s", async (_, outcome, end, kept) => {
    const kv = fakeKv();
    const queue = new HookDeliveryQueue<string>(kv, () => {});
    queue.enqueue("hook", "m1", "message", Date.now());
    const deliver = vi.fn(async () => {
      end(queue, kv);
      if (outcome === "fails") throw new Error("the gadget failed");
    });

    await queue.run(Date.now(), deliver);
    // Past any retry's backoff.
    vi.setSystemTime(Date.now() + 2 * 60 * MINUTE);
    await queue.run(Date.now(), deliver);

    expect(deliver).toHaveBeenCalledOnce();
    expect(kv.keys()).toEqual(kept);
  });

  it("takes up the rows gatekeeper-google's queue stored before the move, as it wrote them", async () => {
    const kv = fakeKv();
    kv.put("msg:hook:retrying", { message: "retrying", attempts: 1, at: Date.now() });
    kv.put("msg:hook:last", { message: "last", attempts: MAX_DELIVERY_ATTEMPTS - 1, at: Date.now() });
    kv.put("msg:hook:finished", { deliveredAt: Date.now() - MINUTE });
    const onDrop = vi.fn();
    const queue = new HookDeliveryQueue<string>(kv, onDrop);
    const deliver = vi.fn(async () => { throw new Error("the gadget failed"); });

    // A finished row still collapses a duplicate push.
    queue.enqueue("hook", "finished", "again", Date.now());
    await queue.run(Date.now(), deliver);

    expect(deliver.mock.calls).toEqual([["hook", "last"], ["hook", "retrying"]]);
    // Each attempt count carried on: the second attempt's backoff, and the last attempt dropped.
    expect(kv.get("msg:hook:retrying")).toEqual({ message: "retrying", attempts: 2, at: Date.now() + 2 * MINUTE });
    expect(kv.get("msg:hook:last")).toEqual({ deliveredAt: Date.now() });
    expect(onDrop).toHaveBeenCalledOnce();
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

    expect(kv.keys()).toEqual([INDEXED]);
    expect(queue.nextDue()).toBeUndefined();
  });

  it("goes by a row as it is now, not an index entry its row has outlived", async () => {
    const kv = fakeKv();
    const queue = new HookDeliveryQueue<string>(kv, () => {});
    queue.enqueue("hook", "m1", "first", Date.now());
    // Deleted alone, then queued again under the same key, due an hour later.
    kv.delete("msg:hook:m1");
    queue.enqueue("hook", "m1", "second", Date.now() + 60 * MINUTE);
    const deliver = vi.fn(async () => {});

    await queue.run(Date.now(), deliver);
    expect(deliver).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 60 * MINUTE);
    await queue.run(Date.now(), deliver);
    expect(deliver.mock.calls).toEqual([["hook", "second"]]);
  });

  it("reads only what has come due on a run, not the day of finished messages it remembers", async () => {
    const kv = fakeKv();
    const queue = new HookDeliveryQueue<string>(kv, () => {});
    for (let i = 0; i < 1000; i++) queue.enqueue("hook", `old${i}`, "delivered", Date.now());
    while (queue.nextDue()! <= Date.now()) await queue.run(Date.now(), async () => {});
    queue.enqueue("hook", "new", "message", Date.now());
    let read = 0;
    const counted: FakeKv = {
      ...kv,
      get: <T>(key: string) => {
        read++;
        return kv.get<T>(key);
      },
      list: <T>(options: Parameters<FakeKv["list"]>[0]) => {
        const found = [...kv.list<T>(options)];
        read += found.length;
        return found;
      },
    };
    const deliver = vi.fn(async () => {});

    await new HookDeliveryQueue<string>(counted, () => {}).run(Date.now(), deliver);
    expect(deliver.mock.calls).toEqual([["hook", "message"]]);
    expect(read).toBeLessThan(10);
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
