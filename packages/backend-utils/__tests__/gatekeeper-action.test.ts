import { describe, expect, it } from "vitest";
import {
  InvalidationLog,
  SerialTaskQueue,
  displayReason,
  validateApplyThroughArgs,
} from "../src/gatekeeper-action";

type Kv = ConstructorParameters<typeof InvalidationLog>[0];

// Minimal in-memory KV matching the slice of the DO storage API the log uses.
function makeKv(): Kv {
  const map = new Map<string, unknown>();
  return {
    put: (k: string, v: unknown) => void map.set(k, v),
    delete: (k: string) => void map.delete(k),
    list: <T>({ prefix }: { prefix: string }) =>
      [...map.entries()].filter(([k]) => k.startsWith(prefix)) as [string, T][],
  } as unknown as Kv;
}

describe("validateApplyThroughArgs", () => {
  it("deduplicates in-range vetoes", () => {
    expect(validateApplyThroughArgs(5, [2, 2, 5])).toEqual(new Set([2, 5]));
  });

  it("rejects a non-positive or non-integer frontier", () => {
    expect(() => validateApplyThroughArgs(0, [])).toThrow("Invalid action ID");
    expect(() => validateApplyThroughArgs(1.5, [])).toThrow("Invalid action ID");
  });

  it("rejects vetoes above the frontier or out of the integer range", () => {
    expect(() => validateApplyThroughArgs(3, [4])).toThrow("Invalid veto action ID");
    expect(() => validateApplyThroughArgs(3, [0])).toThrow("Invalid veto action ID");
  });
});

describe("InvalidationLog", () => {
  it("reports only entries attributed to the requested vetoes, ascending", () => {
    const log = new InvalidationLog(makeKv());
    log.record(10, 3);
    log.record(4, 3);
    log.record(7, 5);

    expect(log.attributedTo(new Set([3]))).toEqual([
      { action: 4, invalidatedBy: 3 },
      { action: 10, invalidatedBy: 3 },
    ]);
  });

  it("prunes entries below the pending floor but keeps the current request's vetoes", () => {
    const log = new InvalidationLog(makeKv());
    log.record(4, 3);
    log.record(7, 5);

    log.prune(new Set([3]), 4);

    expect(log.attributedTo(new Set([3, 5]))).toEqual([
      { action: 4, invalidatedBy: 3 },
      { action: 7, invalidatedBy: 5 },
    ]);

    log.prune(new Set(), Infinity);

    expect(log.attributedTo(new Set([3, 5]))).toEqual([]);
  });
});

describe("displayReason", () => {
  it("passes through an Error with a message", () => {
    const error = new Error("page was deleted upstream");
    expect(displayReason(error, "fallback")).toBe(error);
  });

  it("wraps non-Error throws in the fallback text", () => {
    expect(displayReason("oops", "Vendor could not apply this action").message)
      .toBe("Vendor could not apply this action: oops");
  });
});

// This package deliberately avoids the full Node type environment (see node-async-hooks.d.ts).
// Tests run under vitest on Node, so type the small `process` surface used here locally.
const nodeProcess = (globalThis as Record<string, unknown>)["process"] as {
  on(event: "unhandledRejection", handler: (reason: unknown) => void): void;
  off(event: "unhandledRejection", handler: (reason: unknown) => void): void;
};

describe("SerialTaskQueue", () => {
  it("runs operations one at a time in submission order", async () => {
    const queue = new SerialTaskQueue();
    const events: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });

    const first = queue.run(async () => {
      events.push("first:start");
      await blocked;
      events.push("first:end");
      return 1;
    });
    const second = queue.run(() => {
      events.push("second");
      return 2;
    });

    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(events).toEqual(["first:start", "first:end", "second"]);
  });

  it("continues after an operation rejects", async () => {
    const queue = new SerialTaskQueue();
    const failed = queue.run(() => { throw new Error("failed"); });
    const recovered = queue.run(() => "recovered");

    await expect(failed).rejects.toThrow("failed");
    await expect(recovered).resolves.toBe("recovered");
  });

  it("preserves order across an asynchronous rejection", async () => {
    const queue = new SerialTaskQueue();
    const events: string[] = [];

    const failed = queue.run(async () => {
      events.push("first");
      await Promise.resolve();
      throw new Error("async failure");
    });
    const second = queue.run(() => {
      events.push("second");
      return "ok";
    });

    await expect(failed).rejects.toThrow("async failure");
    await expect(second).resolves.toBe("ok");
    expect(events).toEqual(["first", "second"]);
  });

  it("does not leak an unhandled rejection from its internal chain", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => void unhandled.push(reason);
    nodeProcess.on("unhandledRejection", onUnhandled);
    try {
      const queue = new SerialTaskQueue();
      // A synchronous throw rejects the queue's chained promises directly, so a missing rejection
      // handler on the internal tail promise would surface here as an unhandled rejection.
      await expect(queue.run(() => { throw new Error("boom"); })).rejects.toThrow("boom");
      // Unhandled rejections are reported asynchronously, after the microtask queue drains.
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      nodeProcess.off("unhandledRejection", onUnhandled);
    }
  });
});
