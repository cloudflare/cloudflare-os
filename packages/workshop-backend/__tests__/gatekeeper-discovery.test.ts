import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubserviceCallInput } from "@gadgets/observability/metrics";
import { TimeoutError } from "../src/do-retry";

const { recorded } = vi.hoisted(() => ({ recorded: [] as SubserviceCallInput[] }));
vi.mock(import("@gadgets/observability/metrics"), async original => ({
  ...await original(),
  recordSubserviceCall: (call: SubserviceCallInput) => { recorded.push(call); },
}));

const { askVendor, DISCOVERY_TIMEOUT_MS } = await import("../src/gatekeeper-discovery");

const POINT = {
  source: "workshop.gatekeeper.discovery", service: "gatekeeper.example", operation: "discovery",
  detail: "list",
};

describe("askVendor", () => {
  beforeEach(() => {
    recorded.length = 0;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("answers as the gatekeeper does and records a success with its duration", async () => {
    let asking = askVendor("list", "example", async () => {
      await new Promise(resolve => setTimeout(resolve, 250));
      return "answer";
    });
    await vi.advanceTimersByTimeAsync(250);
    await expect(asking).resolves.toBe("answer");
    expect(recorded).toEqual([{ ...POINT, outcome: "success", durationMs: 250 }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rethrows what the gatekeeper threw and records the reason threw", async () => {
    let error = new Error("directory throttled");
    await expect(askVendor("list", "example", async () => { throw error; })).rejects.toBe(error);
    expect(recorded).toEqual([{ ...POINT, outcome: "error", reason: "threw", durationMs: 0 }]);
  });

  it("counts a synchronous throw as threw, not as an unbounded wait", async () => {
    let error = new Error("no such method");
    await expect(askVendor("filter", "example", () => { throw error; })).rejects.toBe(error);
    expect(recorded).toEqual(
        [{ ...POINT, detail: "filter", outcome: "error", reason: "threw", durationMs: 0 }]);
  });

  it("gives up on a gatekeeper that never answers once the bound passes, recording timeout", async () => {
    let outcome: unknown;
    let asking = askVendor("ambient", "example", () => new Promise<never>(() => {}))
        .catch(err => { outcome = err; });
    await vi.advanceTimersByTimeAsync(DISCOVERY_TIMEOUT_MS - 1);
    expect(outcome).toBeUndefined();
    expect(recorded).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await asking;
    expect(outcome).toBeInstanceOf(TimeoutError);
    expect(recorded).toEqual([{
      ...POINT, detail: "ambient", outcome: "error", reason: "timeout",
      durationMs: DISCOVERY_TIMEOUT_MS,
    }]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
