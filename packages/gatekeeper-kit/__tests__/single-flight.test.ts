import { describe, expect, it, vi } from "vitest";
import { SingleFlight } from "../src/single-flight";

describe("SingleFlight", () => {
  it("joins concurrent callers of one key and starts afresh once it settles", async () => {
    const flights = new SingleFlight();
    const pending = Promise.withResolvers<string>();
    const start = vi.fn(() => pending.promise);

    const joined = [flights.run("k", start), flights.run("k", start)];
    expect(start).toHaveBeenCalledOnce();

    pending.resolve("value");
    expect(await Promise.all(joined)).toEqual(["value", "value"]);

    // The entry is released on settle, so the next caller pays for its own round trip.
    expect(await flights.run("k", async () => "second")).toBe("second");
    expect(start).toHaveBeenCalledOnce();
  });

  it("keeps distinct keys independent", async () => {
    const flights = new SingleFlight();
    const first = Promise.withResolvers<string>();

    const a = flights.run("a", () => first.promise);
    const b = flights.run("b", async () => "b");

    expect(await b).toBe("b");
    first.resolve("a");
    expect(await a).toBe("a");
  });

  it("shares a rejection with every joined caller and releases the key", async () => {
    const flights = new SingleFlight();
    const failing = Promise.withResolvers<string>();

    const joined = [flights.run("k", () => failing.promise), flights.run("k", () => failing.promise)];
    failing.reject(new Error("boom"));

    for (const attempt of joined) await expect(attempt).rejects.toThrow("boom");
    expect(await flights.run("k", async () => "retried")).toBe("retried");
  });

  it("stops offering a forgotten key without disturbing the callers already joined", async () => {
    const flights = new SingleFlight();
    const stale = Promise.withResolvers<string>();

    const joined = flights.run("k", () => stale.promise);
    flights.forget("k");
    const fresh = flights.run("k", async () => "fresh");

    stale.resolve("stale");
    expect(await joined).toBe("stale");
    expect(await fresh).toBe("fresh");
  });

  it("starts the work in the caller's own turn, before any await", async () => {
    const flights = new SingleFlight();
    let started = false;

    // A Durable Object writes and then joins a flight in one uninterrupted step, so `run` must not
    // defer `start` to a microtask.
    const running = flights.run("k", async () => {
      started = true;
      return "value";
    });
    expect(started).toBe(true);
    expect(await running).toBe("value");
  });
});
