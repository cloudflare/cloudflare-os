import { afterEach, describe, expect, it, vi } from "vitest";
import { Semaphore } from "../src/mutex";

describe("Semaphore", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("hands a waiter the permit another gives back, first come first served", async () => {
    let semaphore = new Semaphore(2);
    let first = await semaphore.acquire(1_000);
    let second = await semaphore.acquire(1_000);
    let order: string[] = [];
    let third = semaphore.acquire(1_000).then(release => { order.push("third"); return release; });
    let fourth = semaphore.acquire(1_000).then(release => { order.push("fourth"); return release; });
    await Promise.resolve();
    expect(order).toEqual([]);

    first!();
    expect(await third).toBeTypeOf("function");
    expect(order).toEqual(["third"]);
    second!();
    expect(await fourth).toBeTypeOf("function");
  });

  it("gives a permit back once, however often its release is called", async () => {
    let semaphore = new Semaphore(1);
    let release = await semaphore.acquire(1_000);
    release!();
    release!();

    expect(await semaphore.acquire(1_000)).toBeTypeOf("function");
    // A second permit would have come from the repeated release.
    vi.useFakeTimers();
    let extra = semaphore.acquire(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await extra).toBeUndefined();
  });

  it("gives up after the wait, and is not handed a permit afterwards", async () => {
    vi.useFakeTimers();
    let semaphore = new Semaphore(1);
    let held = await semaphore.acquire(1_000);
    let impatient = semaphore.acquire(1_000);
    let patient = semaphore.acquire(5_000);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(await impatient).toBeUndefined();

    // The permit passes over the waiter that left, to the one still waiting, and is not lost.
    held!();
    let release = await patient;
    expect(release).toBeTypeOf("function");
    release!();
    expect(await semaphore.acquire(1_000)).toBeTypeOf("function");
  });
});
