import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DELIVERED_RETENTION_MS, DeliveryTimeout, HookDeliveryQueue, MAX_DELIVERIES_PER_RUN, MAX_DELIVERY_ATTEMPTS,
  disposeStubs, type Deliver, type RunReport,
} from "../src/hook-delivery-queue";
import { fakeKv, type FakeKv } from "./fake-kv";

const MINUTE = 60_000;
/** How long the queue waits on one attempt (T_kit). */
const T_KIT = 4 * MINUTE;
/** Set once the queue has indexed its rows (see the module's storage notes). */
const INDEXED = "queue:indexed";
/** What a finished `m1` leaves: its row, and the index entry by which it is forgotten a day later. */
const FINISHED_M1 = ["msg:hook:m1", expect.stringMatching(/^queue:finished:\d{15}:hook:m1$/), INDEXED];

const newQueue = <Message = string>(kv: FakeKv = fakeKv(), onRunReport: (report: RunReport) => void = () => {}) =>
  new HookDeliveryQueue<Message>(kv, { onRunReport });
/** The index entry for `msg:{row}` filed under `time`. */
const entry = (index: "due" | "finished", time: number, row: string) =>
  `queue:${index}:${String(time).padStart(15, "0")}:${row}`;
/** The hook and message of each call, without the signal. */
const calls = (deliver: { mock: { calls: unknown[][] } }) => deliver.mock.calls.map(call => call.slice(0, 2));
const hang = () => new Promise<never>(() => {});
const report = (counts: Partial<RunReport>): RunReport =>
  ({ started: 0, delivered: 0, failed: 0, dispatchTimeouts: 0, deliverTimeouts: 0, dropped: 0, ...counts });

/** `fakeKv`, whose next put of a key matching `failNext()`'s pattern throws, as a full database does. */
function faultyKv() {
  const kv = fakeKv();
  let fault: RegExp | undefined;
  const faulty: FakeKv = {
    ...kv,
    put: (key, value) => {
      if (fault?.test(key)) {
        fault = undefined;
        throw new Error("storage is full");
      }
      kv.put(key, value);
    },
  };
  return { kv: faulty, failNext: (pattern: RegExp) => { fault = pattern; } };
}

describe("HookDeliveryQueue", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000_000 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("delivers each queued message once, and collapses a duplicate push", async () => {
    const queue = newQueue();
    queue.enqueue("hook", "m1", "first", Date.now());
    queue.enqueue("hook", "m1", "duplicate", Date.now());
    const deliver = vi.fn(async () => {});

    await queue.run(Date.now(), deliver);
    queue.enqueue("hook", "m1", "redelivered", Date.now());
    await queue.run(Date.now(), deliver);

    expect(calls(deliver)).toEqual([["hook", "first"]]);
  });

  it("retries a failed delivery with backoff, then drops it after the last attempt", async () => {
    const reports: RunReport[] = [];
    const queue = newQueue(fakeKv(), r => reports.push(r));
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
    expect(reports).toHaveLength(MAX_DELIVERY_ATTEMPTS);
    expect(reports.at(-1)).toEqual(report({ started: 1, failed: 1, dropped: 1 }));
    // Finished, so only its expiry remains due.
    expect(queue.nextDue()).toBe(Date.now() + DELIVERED_RETENTION_MS);
  });

  it("finishes a cancelled hook's pending messages, which still collapse duplicates", async () => {
    const queue = newQueue();
    queue.enqueue("a", "m1", "for a", Date.now());
    queue.enqueue("b", "m1", "for b", Date.now());
    queue.cancel("a");
    queue.enqueue("a", "m1", "for a again", Date.now());
    const deliver = vi.fn(async () => {});

    await queue.run(Date.now(), deliver);

    expect(calls(deliver)).toEqual([["b", "for b"]]);
  });

  it("finishes a cancelled hook's live row once, and deletes the entries its rows have outlived", () => {
    const kv = fakeKv();
    const now = Date.now();
    kv.put(INDEXED, true);
    // Finished, with an entry from before it was.
    kv.put("msg:hook:done", { deliveredAt: now - MINUTE });
    kv.put(entry("finished", now - MINUTE, "hook:done"), true);
    kv.put(entry("due", now - 2 * MINUTE, "hook:done"), true);
    // Refiled, with the entry it was filed under before.
    kv.put("msg:hook:live", { message: "message", attempts: 1, at: now + MINUTE });
    kv.put(entry("due", now - 2 * MINUTE, "hook:live"), true);
    kv.put(entry("due", now + MINUTE, "hook:live"), true);

    newQueue(kv).cancel("hook");

    expect(kv.get("msg:hook:done")).toEqual({ deliveredAt: now - MINUTE });
    expect(kv.get("msg:hook:live")).toEqual({ deliveredAt: now });
    expect(kv.writes.filter(key => key === "msg:hook:live")).toHaveLength(2);
    expect(kv.keys()).toEqual([
      "msg:hook:done", "msg:hook:live",
      entry("finished", now - MINUTE, "hook:done"), entry("finished", now, "hook:live"), INDEXED,
    ]);
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
    const queue = newQueue(kv);
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

  it.each(["succeeds", "fails"])("leaves a row deleted and queued again alone when the old row's attempt %s", async outcome => {
    const kv = fakeKv();
    const queue = newQueue(kv);
    queue.enqueue("hook", "m1", "first", Date.now());
    const delivering = Promise.withResolvers<void>();
    const running = queue.run(Date.now(), () => delivering.promise);

    kv.delete("msg:hook:m1");
    queue.enqueue("hook", "m1", "second", Date.now());
    if (outcome === "succeeds") delivering.resolve();
    else delivering.reject(new Error("the gadget failed"));
    await running;

    expect(kv.get("msg:hook:m1")).toEqual({ message: "second", attempts: 0, at: Date.now() });
    expect(queue.nextDue()).toBe(Date.now());
  });

  it("takes up the rows gatekeeper-google's queue stored before the move, as it wrote them", async () => {
    const kv = fakeKv();
    kv.put("msg:hook:retrying", { message: "retrying", attempts: 1, at: Date.now() });
    kv.put("msg:hook:last", { message: "last", attempts: MAX_DELIVERY_ATTEMPTS - 1, at: Date.now() });
    kv.put("msg:hook:finished", { deliveredAt: Date.now() - MINUTE });
    const reports: RunReport[] = [];
    const queue = newQueue(kv, r => reports.push(r));
    const deliver = vi.fn(async () => { throw new Error("the gadget failed"); });

    // A finished row still collapses a duplicate push.
    queue.enqueue("hook", "finished", "again", Date.now());
    await queue.run(Date.now(), deliver);

    // A stored count is of failures, so a row stored at the last but one still gets one call.
    expect(calls(deliver)).toEqual([["hook", "last"], ["hook", "retrying"]]);
    // Each attempt count carried on: the second attempt's backoff, and the last attempt dropped.
    expect(kv.get("msg:hook:retrying")).toEqual({ message: "retrying", attempts: 2, at: Date.now() + 2 * MINUTE });
    expect(kv.get("msg:hook:last")).toEqual({ deliveredAt: Date.now() });
    expect(reports).toEqual([report({ started: 2, failed: 2, dropped: 1 })]);
  });

  describe("counting each attempt before its call", () => {
    /** Starts a run over `kv` whose instance is then reset, leaving its call unsettled. */
    const cutOff = (kv: FakeKv) => void newQueue(kv).run(Date.now(), hang);

    it("drops a row whose last attempt was cut off, without calling it again", async () => {
      const kv = fakeKv();
      kv.put("msg:hook:m1", { message: "message", attempts: MAX_DELIVERY_ATTEMPTS - 1, at: Date.now() });
      cutOff(kv);
      const reports: RunReport[] = [];
      const deliver = vi.fn(async () => {});

      await newQueue(kv, r => reports.push(r)).run(Date.now(), deliver);

      expect(deliver).not.toHaveBeenCalled();
      expect(kv.get("msg:hook:m1")).toEqual({ deliveredAt: Date.now() });
      expect(kv.keys().filter(key => key.startsWith("queue:due:"))).toEqual([]);
      expect(reports).toEqual([report({ dropped: 1 })]);
    });

    it("retries a row cut off mid-attempt at once, as its next attempt", async () => {
      const kv = fakeKv();
      kv.put("msg:hook:m1", { message: "message", attempts: 2, at: Date.now() });
      cutOff(kv);
      const deliver = vi.fn(async () => { throw new Error("the gadget failed"); });

      await newQueue(kv).run(Date.now(), deliver);

      expect(deliver).toHaveBeenCalledOnce();
      // The fourth attempt's backoff.
      expect(kv.get("msg:hook:m1")).toEqual({ message: "message", attempts: 4, at: Date.now() + 8 * MINUTE });
    });
  });

  it("counts a delivery that never settles as timed out at T_kit, and aborts its signal then", async () => {
    const kv = fakeKv();
    const reports: RunReport[] = [];
    const queue = newQueue(kv, r => reports.push(r));
    queue.enqueue("hook", "m1", "message", Date.now());
    let signal: AbortSignal | undefined;
    const running = queue.run(Date.now(), (_hook, _message, given) => {
      signal = given;
      return hang();
    });

    // The deadline is a timer: moving the clock alone doesn't trip it.
    vi.setSystemTime(Date.now() + 60 * MINUTE);
    await vi.advanceTimersByTimeAsync(T_KIT - 1);
    expect(signal?.aborted).toBe(false);
    expect(reports).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    await running;
    expect(signal?.reason).toEqual(new DeliveryTimeout("deliver"));
    expect(reports).toEqual([report({ started: 1, deliverTimeouts: 1 })]);
    expect(kv.get("msg:hook:m1")).toEqual({ message: "message", attempts: 1, at: Date.now() + MINUTE });
  });

  it.each(["counting", "settling"])("rejects a run whose storage throws %s an attempt only once every other attempt has settled", async stage => {
    const { kv, failNext } = faultyKv();
    const reports: RunReport[] = [];
    const queue = newQueue(kv, r => reports.push(r));
    queue.enqueue("a", "m1", "message", Date.now());
    queue.enqueue("b", "m1", "message", Date.now());
    const other = Promise.withResolvers<void>();
    // The count is the row's first write in a run, and a failed attempt's retry its second.
    if (stage === "counting") failNext(/^msg:a:/);
    const running = queue.run(Date.now(), async hook => {
      if (hook === "b") return other.promise;
      failNext(/^msg:a:/);
      throw new Error("the gadget failed");
    });
    let rejected = false;
    running.catch(() => { rejected = true; });

    await vi.advanceTimersByTimeAsync(0);
    expect(rejected).toBe(false);
    other.resolve();
    await expect(running).rejects.toThrow("storage is full");
    expect(kv.get("msg:b:m1")).toEqual({ deliveredAt: Date.now() });
    // A run with a failed delivery is reported before the throw.
    expect(reports).toHaveLength(stage === "settling" ? 1 : 0);
  });

  it.each<[string, Deliver<string>]>([
    ["throws synchronously", () => { throw new Error("the gadget failed"); }],
    ["rejects with a string", () => Promise.reject("delivered")],
    ["rejects with a success's shape", () => Promise.reject({ ok: true })],
  ])("retries a delivery that %s", async (_, deliver) => {
    const kv = fakeKv();
    const reports: RunReport[] = [];
    const queue = newQueue(kv, r => reports.push(r));
    queue.enqueue("hook", "m1", "message", Date.now());

    await queue.run(Date.now(), deliver);

    expect(kv.get("msg:hook:m1")).toEqual({ message: "message", attempts: 1, at: Date.now() + MINUTE });
    expect(reports).toEqual([report({ started: 1, failed: 1 })]);
  });

  it.each<[string, RegExp, "succeeds" | "fails" | undefined]>([
    ["queueing it files its index entry", /^queue:due:/, undefined],
    ["queueing it stores its row", /^msg:/, undefined],
    ["a retry files its index entry", /^queue:due:/, "fails"],
    ["a retry stores its row", /^msg:/, "fails"],
    ["finishing it files its index entry", /^queue:finished:/, "succeeds"],
    ["finishing it stores its row", /^msg:/, "succeeds"],
  ])("leaves a message due when %s, and the write throws", async (_, pattern, outcome) => {
    const { kv, failNext } = faultyKv();
    const queue = newQueue(kv);
    const deliver = vi.fn(async () => {});
    if (outcome === undefined) {
      failNext(pattern);
      expect(() => queue.enqueue("hook", "m1", "message", Date.now())).toThrow("storage is full");
    } else {
      queue.enqueue("hook", "m1", "message", Date.now());
      await expect(queue.run(Date.now(), async () => {
        failNext(pattern);
        if (outcome === "fails") throw new Error("the gadget failed");
      })).rejects.toThrow("storage is full");
    }

    queue.enqueue("hook", "m1", "message", Date.now());
    await queue.run(Date.now(), deliver);

    expect(calls(deliver)).toEqual([["hook", "message"]]);
  });

  it("reports a run once, with its counts, and only when something went wrong", async () => {
    const kv = fakeKv();
    const reports: RunReport[] = [];
    const queue = newQueue(kv, r => reports.push(r));
    queue.enqueue("clean", "m1", "message", Date.now());
    await queue.run(Date.now(), async () => {});
    expect(reports).toEqual([]);

    kv.put("msg:last:m1", { message: "last", attempts: MAX_DELIVERY_ATTEMPTS - 1, at: Date.now() });
    kv.put(entry("due", Date.now(), "last:m1"), true);
    for (const hook of ["delivers", "fails", "hangs", "dispatch"]) queue.enqueue(hook, "m1", hook, Date.now());
    const running = queue.run(Date.now(), async (hook, message) => {
      if (hook === "delivers") return;
      if (hook === "hangs") return hang();
      if (hook === "dispatch") throw new DeliveryTimeout("dispatch");
      throw new Error(`the gadget failed on ${message}`);
    });
    await vi.advanceTimersByTimeAsync(T_KIT);
    await running;

    expect(reports).toEqual([
      report({ started: 5, delivered: 1, failed: 2, dispatchTimeouts: 1, deliverTimeouts: 1, dropped: 1 }),
    ]);
  });

  it("starts at most MAX_DELIVERIES_PER_RUN deliveries, oldest first", async () => {
    const queue = newQueue<number>();
    for (let i = MAX_DELIVERIES_PER_RUN; i >= 0; i--) queue.enqueue("hook", `m${i}`, i, Date.now() - i);
    const delivered: number[] = [];

    await queue.run(Date.now(), async (_hook, message) => { delivered.push(message); });

    expect(delivered).toHaveLength(MAX_DELIVERIES_PER_RUN);
    expect(delivered).not.toContain(0);
    expect(queue.nextDue()).toBe(Date.now());
  });

  it("forgets finished messages once the dedupe window has passed", async () => {
    const kv = fakeKv();
    const queue = newQueue(kv);
    queue.enqueue("hook", "m1", "message", Date.now());
    await queue.run(Date.now(), async () => {});

    vi.setSystemTime(Date.now() + DELIVERED_RETENTION_MS);
    await queue.run(Date.now(), async () => {});

    expect(kv.keys()).toEqual([INDEXED]);
    expect(queue.nextDue()).toBeUndefined();
  });

  it("goes by a row as it is now, not an index entry its row has outlived", async () => {
    const kv = fakeKv();
    const queue = newQueue(kv);
    queue.enqueue("hook", "m1", "first", Date.now());
    // Deleted alone, then queued again under the same key, due an hour later.
    kv.delete("msg:hook:m1");
    queue.enqueue("hook", "m1", "second", Date.now() + 60 * MINUTE);
    const deliver = vi.fn(async () => {});

    await queue.run(Date.now(), deliver);
    expect(deliver).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 60 * MINUTE);
    await queue.run(Date.now(), deliver);
    expect(calls(deliver)).toEqual([["hook", "second"]]);
  });

  it("reads only what has come due on a run, not the day of finished messages it remembers", async () => {
    const kv = fakeKv();
    const queue = newQueue(kv);
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

    await newQueue(counted).run(Date.now(), deliver);
    expect(calls(deliver)).toEqual([["hook", "message"]]);
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
