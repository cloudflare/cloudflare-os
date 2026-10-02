import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isDoResetError, isLoopLimitError, retryOnDoReset, wrapDoStubForTelemetry,
} from "../src/do-retry";
import { createWorkshopLogger } from "../src/observability";

// Synthetic errors shaped like workerd's tagged rejections (jsg/util.c++). Local aborts reject
// flagless (pinned by the "user-DO reset flags" integration test), so the predicates and the
// retry path are exercised here with the production shapes.
function resetError(flags: Record<string, unknown>): Error {
  return Object.assign(new Error("Durable Object reset."), flags);
}

// The shape a production storage-timeout reset arrives in: a dead incarnation, flagged overloaded.
const PRODUCTION_RESET = { remote: true, overloaded: true, durableObjectReset: true };

describe("isDoResetError", () => {
  it("matches the durableObjectReset flag", () => {
    expect(isDoResetError(resetError({ durableObjectReset: true }))).toBe(true);
  });

  it("matches the retryable flag (connection lost)", () => {
    expect(isDoResetError(resetError({ retryable: true }))).toBe(true);
  });

  it("matches the production storage-timeout shape (overloaded reset)", () => {
    expect(isDoResetError(resetError(PRODUCTION_RESET))).toBe(true);
  });

  it("rejects overload without a reset (live object shedding load)", () => {
    expect(isDoResetError(resetError({ remote: true, overloaded: true }))).toBe(false);
  });

  it("rejects unflagged and malformed values", () => {
    expect(isDoResetError(new Error("some app error"))).toBe(false);
    expect(isDoResetError(resetError({ durableObjectReset: "yes" }))).toBe(false);
    expect(isDoResetError(resetError({ retryable: 1 }))).toBe(false);
    expect(isDoResetError(null)).toBe(false);
    expect(isDoResetError(undefined)).toBe(false);
    expect(isDoResetError("boom")).toBe(false);
  });
});

// The runtime's two "Subrequest depth limit exceeded" messages. They report different counters,
// and only the first is cleared by restarting the calling object.
const LOOP_LIMIT_MESSAGE =
    "Subrequest depth limit exceeded. This request looped back into the Workers runtime too " +
    "many times. This can happen e.g. if you have a Worker or Durable Object that calls other " +
    "Workers or objects recursively.";
const STAGE_LIMIT_MESSAGE =
    "Subrequest depth limit exceeded. This request passed through too many Workers stages " +
    "within the Workers runtime while being handled.";

describe("isLoopLimitError", () => {
  it("matches the runtime's looped-back rejection", () => {
    expect(isLoopLimitError(new Error(LOOP_LIMIT_MESSAGE))).toBe(true);
  });

  it("rejects the wording quoted inside another message", () => {
    expect(isLoopLimitError(new Error(`No such model: ${LOOP_LIMIT_MESSAGE}`))).toBe(false);
  });

  it("rejects the sibling too-many-stages rejection", () => {
    expect(isLoopLimitError(new Error(STAGE_LIMIT_MESSAGE))).toBe(false);
  });

  it("rejects other errors", () => {
    expect(isLoopLimitError(new Error("some app error"))).toBe(false);
    expect(isLoopLimitError(new Error("Subrequest depth limit exceeded."))).toBe(false);
    expect(isLoopLimitError(resetError(PRODUCTION_RESET))).toBe(false);
  });

  it("rejects values that are not an Error, even carrying the text", () => {
    expect(isLoopLimitError(LOOP_LIMIT_MESSAGE)).toBe(false);
    expect(isLoopLimitError({ message: LOOP_LIMIT_MESSAGE })).toBe(false);
    expect(isLoopLimitError(null)).toBe(false);
    expect(isLoopLimitError(undefined)).toBe(false);
  });

  it("rejects an Error whose message is not a string", () => {
    expect(isLoopLimitError(Object.assign(new Error(), { message: 42 }))).toBe(false);
    expect(isLoopLimitError(Object.assign(new Error(), { message: undefined }))).toBe(false);
    expect(isLoopLimitError(Object.assign(new Error(), { message: [LOOP_LIMIT_MESSAGE] })))
        .toBe(false);
  });
});

// ---------------------------------------------------------------------------------------
// wrapDoStubForTelemetry's onRejection. A plain object stands in for the stub: the wrapper needs
// only its `id` and whichever members are reached through it.

function wrappedStub(members: Record<string, unknown>) {
  const reported: unknown[] = [];
  const stub = wrapDoStubForTelemetry(
      { id: { toString: () => "user-do-id" }, ...members } as any, undefined,
      e => reported.push(e));
  return { stub, reported };
}

describe("wrapDoStubForTelemetry onRejection", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is called once with a rejection, which is rethrown by identity", async () => {
    const error = new Error("some app error");
    const { stub, reported } = wrappedStub({ read: async () => { throw error; } });

    await expect(stub.read()).rejects.toBe(error);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toBe(error);
  });

  it("is called for a DO reset as well, alongside the reset telemetry", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = resetError(PRODUCTION_RESET);
    const { stub, reported } = wrappedStub({ read: async () => { throw error; } });

    await expect(stub.read()).rejects.toBe(error);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toBe(error);
    const surfaced = warn.mock.calls.map(([entry]) => entry as Record<string, unknown>)
        .filter(entry => entry.event === "user_do.reset.surfaced");
    expect(surfaced).toEqual(
        [expect.objectContaining({ operation: "read", durableObjectId: "user-do-id" })]);
  });

  it("is not called for a resolving call, a synchronous return or a non-function property",
      async () => {
    const error = new Error("some app error");
    const { stub, reported } = wrappedStub({
      read: async () => "ok",
      name: () => "sync",
      limit: 3,
      fail: async () => { throw error; },
    });

    expect(await stub.read()).toBe("ok");
    expect(stub.name()).toBe("sync");
    expect(stub.limit).toBe(3);
    expect(reported).toEqual([]);

    // The same wrapper does report the one call that rejects.
    await expect(stub.fail()).rejects.toBe(error);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toBe(error);
  });
});

// ---------------------------------------------------------------------------------------
// retryOnDoReset. Thunks are the whole harness: counting invocations asserts the retry (and
// single-retry) behavior, and identity checks on rejections pin the flag contract the frontend
// classifier (workshop-frontend's rpcErrors.ts) depends on. The logger writes through console,
// so `user_do.reset.recovered` is observed by spying on console.info.

function failingThunk(errors: unknown[], value = "ok") {
  let calls = 0;
  const call = () => {
    const error = errors[calls++];
    return error === undefined ? Promise.resolve(value) : Promise.reject(error);
  };
  return { call, count: () => calls };
}

function recoveredEvents(spy: ReturnType<typeof vi.spyOn>): number {
  return spy.mock.calls.filter(
      ([entry]) => (entry as { event?: unknown })?.event === "user_do.reset.recovered").length;
}

function spies() {
  vi.spyOn(Math, "random").mockReturnValue(0);  // pin the jitter to a zero wait
  return vi.spyOn(console, "info").mockImplementation(() => {});
}

describe("retryOnDoReset", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes a resolving call through: one invocation, no log", async () => {
    const info = spies();
    const thunk = failingThunk([]);

    expect(await retryOnDoReset(thunk.call)).toBe("ok");
    expect(thunk.count()).toBe(1);
    expect(recoveredEvents(info)).toBe(0);
  });

  it("recovers from the production reset shape: two invocations, one recovery log", async () => {
    const info = spies();
    const thunk = failingThunk([resetError(PRODUCTION_RESET)]);

    expect(await retryOnDoReset(thunk.call)).toBe("ok");
    expect(thunk.count()).toBe(2);
    expect(recoveredEvents(info)).toBe(1);
  });

  it("attributes the recovery to the caller's logger when one is passed", async () => {
    const info = spies();
    const thunk = failingThunk([resetError(PRODUCTION_RESET)]);

    const log = createWorkshopLogger("workshop.overseer").with({ gadgetId: "g1" });
    expect(await retryOnDoReset(thunk.call, log)).toBe("ok");
    const recovered = info.mock.calls.map(([entry]) => entry as Record<string, unknown>)
        .filter(entry => entry.event === "user_do.reset.recovered");
    expect(recovered).toEqual(
        [expect.objectContaining({ component: "workshop.overseer", gadgetId: "g1" })]);
  });

  it("waits a jittered delay bounded by the retry window", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.spyOn(console, "info").mockImplementation(() => {});
    const wait = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
    const thunk = failingThunk([resetError(PRODUCTION_RESET)]);

    expect(await retryOnDoReset(thunk.call)).toBe("ok");
    expect(wait).toHaveBeenCalledExactlyOnceWith(0.5 * 250);  // Math.random() * RETRY_JITTER_MS
  });

  it("retries a bare retryable rejection (connection lost)", async () => {
    const info = spies();
    const thunk = failingThunk([resetError({ retryable: true })]);

    expect(await retryOnDoReset(thunk.call)).toBe("ok");
    expect(thunk.count()).toBe(2);
    expect(recoveredEvents(info)).toBe(1);
  });

  it("does not retry retryable+overloaded (live object shedding load)", async () => {
    const info = spies();
    const error = resetError({ retryable: true, overloaded: true });
    const thunk = failingThunk([error]);

    await expect(retryOnDoReset(thunk.call)).rejects.toBe(error);  // identity, flags intact
    expect(thunk.count()).toBe(1);
    expect(recoveredEvents(info)).toBe(0);
  });

  it("does not retry a flagless error (the local-abort shape)", async () => {
    const info = spies();
    const error = new Error("Durable Object reset.");
    const thunk = failingThunk([error]);

    await expect(retryOnDoReset(thunk.call)).rejects.toBe(error);
    expect(thunk.count()).toBe(1);
    expect(recoveredEvents(info)).toBe(0);
  });

  it("does not retry an app error", async () => {
    const info = spies();
    const error = new Error("some app error");
    const thunk = failingThunk([error]);

    await expect(retryOnDoReset(thunk.call)).rejects.toBe(error);
    expect(thunk.count()).toBe(1);
    expect(recoveredEvents(info)).toBe(0);
  });

  it("retries exactly once: a second rejection propagates by identity, flags intact", async () => {
    const info = spies();
    const first = resetError(PRODUCTION_RESET);
    const second = resetError(PRODUCTION_RESET);
    const thunk = failingThunk([first, second]);

    let caught: unknown;
    try {
      await retryOnDoReset(thunk.call);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(second);  // the retry's own rejection, not a re-wrap
    expect(thunk.count()).toBe(2);  // single retry by construction
    // The frontend classifier reads the flags as own enumerable props; pin that they survive.
    expect({ ...(caught as object) }).toMatchObject(PRODUCTION_RESET);
    expect(recoveredEvents(info)).toBe(0);
  });
});
