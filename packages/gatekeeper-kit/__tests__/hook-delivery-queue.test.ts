import * as fc from "fast-check";
import { PROPERTY_RUN_OPTIONS } from "@gadgets/scripts/property-runs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DELIVERED_RETENTION_MS, DeliveryTimeout, HookDeliveryQueue, MAX_DELIVERY_ATTEMPTS,
  disposeStubs, type Deliver, type RunReport,
} from "../src/hook-delivery-queue";
import { fakeKv, type FakeKv } from "./fake-kv";

const MINUTE = 60_000;
/** How long the queue waits on one attempt (T_kit). */
const T_KIT = 4 * MINUTE;
/** How long a run keeps starting deliveries. */
const START_BUDGET = 2 * MINUTE;
/** The queue's pool: attempts in flight at once, per hook once it has delivered, and per run. */
const [MAX_IN_FLIGHT, MAX_PER_HOOK, MAX_STARTS_PER_RUN] = [20, 4, 200];
/** Due entries one run reads, the passed-over rows a hung hook keeps, and the rows one run trims. */
const [READ_BUDGET, BACKLOG_KEEP, MAX_TRIMMED_PER_RUN] = [50_000, 1_000, 2_000];
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
/** Settles after `ms` on the fake clock, rejecting with `error` if given. */
const after = (ms: number, error?: unknown) =>
  new Promise<void>((resolve, reject) => setTimeout(() => error === undefined ? resolve() : reject(error), ms));
const report = (counts: Partial<RunReport>): RunReport => ({
  started: 0, delivered: 0, failed: 0, dispatchTimeouts: 0, deliverTimeouts: 0, dropped: 0, trimmed: 0,
  readBudgetReached: false, ...counts,
});
/** Advances the fake clock until `running` settles. */
async function settled<T>(running: Promise<T>): Promise<T> {
  let done = false;
  running.then(() => { done = true; }, () => { done = true; });
  // eslint-disable-next-line no-unmodified-loop-condition -- running's callbacks raise this.
  while (!done) await vi.advanceTimersByTimeAsync(MINUTE);
  return running;
}
/** `count` rows for `hook`, oldest first, named `m00000` on in the order they were queued. */
function backlog(queue: HookDeliveryQueue<string>, hook: string, count: number): void {
  for (let i = 0; i < count; i++) queue.enqueue(hook, `m${String(i).padStart(5, "0")}`, `${hook}${i}`, Date.now() - count + i);
}

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
    // The count is the row's first write in a run, and a failed attempt's retry its second. `a` is
    // started first, so it is in flight when `b`'s write throws.
    if (stage === "counting") failNext(/^msg:b:/);
    const running = queue.run(Date.now(), async hook => {
      if (hook === "a") return other.promise;
      failNext(/^msg:b:/);
      throw new Error("the gadget failed");
    });
    let rejected = false;
    running.catch(() => { rejected = true; });

    await vi.advanceTimersByTimeAsync(0);
    expect(rejected).toBe(false);
    other.resolve();
    await expect(running).rejects.toThrow("storage is full");
    expect(kv.get("msg:a:m1")).toEqual({ deliveredAt: Date.now() });
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

  describe("the pool", () => {
    it("delivers a backlog and many single-row hooks in one run, the backlog's slots growing after its first delivery", async () => {
      const queue = newQueue();
      backlog(queue, "big", 40);
      for (let i = 0; i < 20; i++) queue.enqueue(`small${i}`, "m1", `small${i}`, Date.now());
      const inFlight = new Map<string, number>();
      const bigInFlight: number[] = [];
      let most = 0;
      const delivered: string[] = [];

      await settled(queue.run(Date.now(), async (hook, message) => {
        inFlight.set(hook, (inFlight.get(hook) ?? 0) + 1);
        if (hook === "big") bigInFlight.push(inFlight.get(hook)!);
        most = Math.max(most, [...inFlight.values()].reduce((sum, n) => sum + n));
        await after(1_000);
        inFlight.set(hook, inFlight.get(hook)! - 1);
        delivered.push(message);
      }));

      expect(delivered.toSorted()).toEqual([
        ...Array.from({ length: 40 }, (_, i) => `big${i}`), ...Array.from({ length: 20 }, (_, i) => `small${i}`),
      ].toSorted());
      expect(bigInFlight[0]).toBe(1);
      expect(Math.max(...bigInFlight)).toBe(MAX_PER_HOOK);
      expect(most).toBe(MAX_IN_FLIGHT);
    });

    it("keeps healthy hooks flowing while hung hooks hold one slot each", async () => {
      const queue = newQueue();
      for (let i = 0; i < 5; i++) backlog(queue, `hung${i}`, 10);
      for (let i = 0; i < 100; i++) queue.enqueue(`healthy${i}`, "m1", "healthy", Date.now());
      const deliver = vi.fn(async (hook: string) => hook.startsWith("hung") ? hang() : after(1_000));

      await settled(queue.run(Date.now(), deliver));

      const called = deliver.mock.calls.map(([hook]) => hook);
      expect(called.filter(hook => hook.startsWith("healthy"))).toHaveLength(100);
      expect(called.filter(hook => hook.startsWith("hung")).toSorted()).toEqual(["hung0", "hung1", "hung2", "hung3", "hung4"]);
    });

    // Only a dispatch timeout can pause a hook within its run: T_kit always passes after the start
    // window has closed.
    it("starts nothing more for a hook whose firing timed out, and one in the next run", async () => {
      const queue = newQueue();
      backlog(queue, "slow", 3);
      const deliver = vi.fn(() => after(30_000, new DeliveryTimeout("dispatch")));

      // A firing that never came frees its slot at 30 s, which the hook doesn't get back.
      await settled(queue.run(Date.now(), deliver));
      expect(deliver).toHaveBeenCalledOnce();
      expect(queue.nextDue()).toBeLessThanOrEqual(Date.now());

      deliver.mockImplementation(hang);
      await settled(queue.run(Date.now(), deliver));
      expect(deliver).toHaveBeenCalledTimes(2);
    });

    it("reaches a healthy hook behind a hung hook's backlog of 10,000 rows in the same run", async () => {
      const queue = newQueue();
      backlog(queue, "hung", 10_000);
      queue.enqueue("healthy", "m1", "healthy", Date.now());
      const delivered: string[] = [];

      const running = queue.run(Date.now(), async hook => {
        if (hook === "hung") return hang();
        delivered.push(hook);
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(delivered).toEqual(["healthy"]);
      await settled(running);
    });

    describe("trimming a hung hook's backlog", () => {
      const row = (i: number) => `msg:hung:m${String(i).padStart(5, "0")}`;

      it.each([
        ["beyond its newest rows", 1 + BACKLOG_KEEP + 50, 50],
        ["up to the run's limit", 1 + BACKLOG_KEEP + MAX_TRIMMED_PER_RUN + 500, MAX_TRIMMED_PER_RUN],
      ])("drops rows %s once its delivery times out", async (_, count, trimmed) => {
        const kv = fakeKv();
        const reports: RunReport[] = [];
        const queue = newQueue(kv, r => reports.push(r));
        backlog(queue, "hung", count);

        await settled(queue.run(Date.now(), hang));

        expect(reports).toEqual([report({ started: 1, deliverTimeouts: 1, trimmed })]);
        // The oldest go, never tried, so their rows are deleted.
        expect(kv.get(row(trimmed))).toBeUndefined();
        expect(kv.get(row(trimmed + 1))).toMatchObject({ attempts: 0 });
        expect(kv.keys().filter(key => key.startsWith("queue:due:"))).toHaveLength(count - trimmed);
      });

      it("drops nothing when the firing never came", async () => {
        const kv = fakeKv();
        const reports: RunReport[] = [];
        const queue = newQueue(kv, r => reports.push(r));
        backlog(queue, "hung", 1 + BACKLOG_KEEP + 50);

        await settled(queue.run(Date.now(), () => after(30_000, new DeliveryTimeout("dispatch"))));

        expect(reports).toEqual([report({ started: 1, dispatchTimeouts: 1 })]);
        expect(kv.keys().filter(key => key.startsWith("queue:due:"))).toHaveLength(1 + BACKLOG_KEEP + 50);
      });

      it("neither finishes nor counts a passed-over row deleted or finished meanwhile", async () => {
        const kv = fakeKv();
        const reports: RunReport[] = [];
        const queue = newQueue(kv, r => reports.push(r));
        backlog(queue, "hung", 1 + BACKLOG_KEEP + 50);

        const running = queue.run(Date.now(), hang);
        await vi.advanceTimersByTimeAsync(0);
        kv.delete(row(1));
        const finished = { deliveredAt: Date.now() - MINUTE };
        kv.put(row(2), finished);
        await settled(running);

        expect(reports).toEqual([report({ started: 1, deliverTimeouts: 1, trimmed: 48 })]);
        expect(kv.get(row(1))).toBeUndefined();
        expect(kv.get(row(2))).toEqual(finished);
      });

      it("forgets a row it never tried, and remembers one it did", async () => {
        const kv = fakeKv();
        const queue = newQueue(kv);
        backlog(queue, "hung", 1 + BACKLOG_KEEP + 2);
        kv.put(row(1), { message: "tried", attempts: 1, at: Date.now() - BACKLOG_KEEP - 2 });

        await settled(queue.run(Date.now(), hang));
        expect(kv.get(row(1))).toEqual({ deliveredAt: Date.now() });
        expect(kv.get(row(2))).toBeUndefined();

        // A duplicate push of the tried one is ignored, and the untried one queued again.
        queue.enqueue("hung", "m00001", "again", Date.now());
        queue.enqueue("hung", "m00002", "again", Date.now());
        expect(kv.get(row(1))).toEqual({ deliveredAt: Date.now() });
        expect(kv.get(row(2))).toEqual({ message: "again", attempts: 0, at: Date.now() });
      });

      it("leaves the timed-out row refiled when a trim write throws", async () => {
        const { kv, failNext } = faultyKv();
        const queue = newQueue(kv);
        backlog(queue, "hung", 1 + BACKLOG_KEEP + 2);
        // Tried, so the trim finishes it: its first write is the finished entry.
        kv.put(row(1), { message: "tried", attempts: 1, at: Date.now() - BACKLOG_KEEP - 2 });
        failNext(/^queue:finished:/);

        await expect(settled(queue.run(Date.now(), hang))).rejects.toThrow("storage is full");

        expect(kv.get(row(0))).toEqual({ message: "hung0", attempts: 1, at: Date.now() + MINUTE });
      });
    });

    describe("waking on enqueue()", () => {
      it("starts a row queued mid-run at once", async () => {
        const queue = newQueue();
        queue.enqueue("hung", "m1", "hung", Date.now());
        const delivered: string[] = [];
        const running = queue.run(Date.now(), async (hook, message) => {
          if (hook === "hung") return hang();
          delivered.push(message);
        });
        await vi.advanceTimersByTimeAsync(1);

        queue.enqueue("late", "m1", "late", Date.now());
        await vi.advanceTimersByTimeAsync(0);

        expect(delivered).toEqual(["late"]);
        await settled(running);
      });

      it("leaves a row queued behind the scan's position to the next run", async () => {
        const queue = newQueue();
        queue.enqueue("zz", "m1", "hung", Date.now());
        const deliver = vi.fn(async (hook: string) => hook === "zz" ? hang() : undefined);
        const running = queue.run(Date.now(), deliver);
        await vi.advanceTimersByTimeAsync(0);

        // The scan has read its millisecond up to `zz`.
        queue.enqueue("aa", "m1", "early", Date.now());
        await settled(running);
        expect(calls(deliver)).toEqual([["zz", "hung"]]);

        await settled(queue.run(Date.now(), deliver));
        expect(calls(deliver)).toEqual([["zz", "hung"], ["aa", "early"]]);
      });

      it("leaves a retry that comes due while the pool is full to the next run", async () => {
        const kv = fakeKv();
        const queue = newQueue(kv);
        for (let i = 0; i < MAX_IN_FLIGHT; i++) queue.enqueue(`hung${i}`, "m1", "hung", Date.now());
        kv.put("msg:retry:m1", { message: "retry", attempts: 1, at: Date.now() + MINUTE });
        kv.put(entry("due", Date.now() + MINUTE, "retry:m1"), true);
        const deliver = vi.fn(async (hook: string) => hook.startsWith("hung") ? hang() : undefined);

        await settled(queue.run(Date.now(), deliver));
        expect(deliver).toHaveBeenCalledTimes(MAX_IN_FLIGHT);

        await settled(queue.run(Date.now(), deliver));
        expect(calls(deliver).slice(MAX_IN_FLIGHT)).toEqual([["retry", "retry"]]);
      });
    });

    describe("budgets", () => {
      it("starts nothing once the start window has closed, and leaves the rest to the next run", async () => {
        const queue = newQueue();
        for (let i = 0; i < MAX_IN_FLIGHT + 5; i++) queue.enqueue(`hook${i}`, "m1", "message", Date.now());
        const deliver = vi.fn(() => after(START_BUDGET + MINUTE));

        await settled(queue.run(Date.now(), deliver));
        expect(deliver).toHaveBeenCalledTimes(MAX_IN_FLIGHT);

        await settled(queue.run(Date.now(), deliver));
        expect(deliver).toHaveBeenCalledTimes(MAX_IN_FLIGHT + 5);
      });

      it("starts at most MAX_STARTS_PER_RUN, and leaves the rest to the next run", async () => {
        const queue = newQueue();
        for (let i = 0; i < MAX_STARTS_PER_RUN + 50; i++) queue.enqueue(`hook${i}`, "m1", "message", Date.now());
        const deliver = vi.fn(async () => {});

        await settled(queue.run(Date.now(), deliver));
        expect(deliver).toHaveBeenCalledTimes(MAX_STARTS_PER_RUN);
        expect(queue.nextDue()).toBeLessThanOrEqual(Date.now());

        await settled(queue.run(Date.now(), deliver));
        expect(deliver).toHaveBeenCalledTimes(MAX_STARTS_PER_RUN + 50);
      });

      it("reports a scan that stopped at READ_BUDGET", async () => {
        const reports: RunReport[] = [];
        const queue = newQueue(fakeKv(), r => reports.push(r));
        backlog(queue, "hung", READ_BUDGET);
        queue.enqueue("unreached", "m1", "unreached", Date.now());
        const deliver = vi.fn(async (hook: string) => hook === "hung" ? hang() : undefined);

        await settled(queue.run(Date.now(), deliver));

        expect(calls(deliver).map(([hook]) => hook)).toEqual(["hung"]);
        expect(reports).toEqual([expect.objectContaining({ readBudgetReached: true })]);
      });
    });

    it("always starts something in the run after one that leaves a row due", async () => {
      type Behavior = "delivers" | "fails" | "hangs" | "dispatch" | "slow";
      const behavior = fc.constantFrom<Behavior>("delivers", "fails", "hangs", "dispatch", "slow");
      const act: Record<Behavior, () => Promise<void>> = {
        delivers: async () => {},
        fails: async () => { throw new Error("the gadget failed"); },
        hangs: hang,
        dispatch: () => after(30_000, new DeliveryTimeout("dispatch")),
        slow: () => after(3 * MINUTE),
      };
      await fc.assert(fc.asyncProperty(
        fc.array(fc.record({
          rows: fc.integer({ min: 1, max: 40 }),
          attempts: fc.integer({ min: 0, max: MAX_DELIVERY_ATTEMPTS }),
          first: behavior,
          later: behavior,
        }), { minLength: 1, maxLength: 30 }),
        async hooks => {
          const kv = fakeKv();
          const reports: RunReport[] = [];
          const queue = newQueue(kv, r => reports.push(r));
          hooks.forEach(({ rows, attempts }, h) => {
            for (let i = 0; i < rows; i++) {
              kv.put(`msg:h${h}:m${i}`, { message: "message", attempts, at: Date.now() - i });
              kv.put(entry("due", Date.now() - i, `h${h}:m${i}`), true);
            }
          });
          kv.put(INDEXED, true);
          const behaving = (pick: "first" | "later") => (hook: string) => act[hooks[Number(hook.slice(1))][pick]]();

          await settled(queue.run(Date.now(), behaving("first")));
          const next = queue.nextDue();
          if (next === undefined || next > Date.now()) return;
          const deliver = vi.fn(behaving("later"));
          reports.length = 0;
          await settled(queue.run(Date.now(), deliver));
          expect(deliver.mock.calls.length + (reports[0]?.dropped ?? 0)).toBeGreaterThan(0);
        },
      ), { ...PROPERTY_RUN_OPTIONS, numRuns: 40 });
    });
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
