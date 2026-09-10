// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEBOUNCE_MS, RETRY_BASE_MS, RETRY_MAX_MS, type SaveOutcome, SaveScheduler, retryDelay } from "../src/save-scheduler.ts";

function setup(options: { readOnly?: boolean; debounceMs?: number } = {}) {
  const statuses: string[] = [];
  const messages: string[] = [];
  const outcomes: Array<SaveOutcome | Error> = [];
  let dirty = false;
  const save = vi.fn(async (): Promise<SaveOutcome> => {
    const next = outcomes.shift() ?? "saved";
    if (next instanceof Error) throw next;
    if (next === "saved") dirty = false;
    return next;
  });
  const scheduler = new SaveScheduler({
    save,
    isDirty: () => dirty,
    onStatus: (status, message) => {
      statuses.push(status);
      messages.push(message);
    },
    ...options,
  });
  return { scheduler, save, statuses, messages, outcomes, dirty: (value: boolean) => { dirty = value; } };
}

describe("retryDelay", () => {
  it("doubles from the base up to the cap", () => {
    expect(retryDelay(0)).toBe(RETRY_BASE_MS);
    expect(retryDelay(1)).toBe(RETRY_BASE_MS);
    expect(retryDelay(2)).toBe(RETRY_BASE_MS * 2);
    expect(retryDelay(5)).toBe(RETRY_BASE_MS * 16);
    expect(retryDelay(20)).toBe(RETRY_MAX_MS);
  });
});

describe("SaveScheduler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("debounces a burst into one save and reports saving then saved", async () => {
    const { scheduler, save, statuses, dirty } = setup();
    dirty(true);
    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 10);
    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 10);
    expect(save).not.toHaveBeenCalled();
    expect(scheduler.busy).toBe(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(save).toHaveBeenCalledTimes(1);
    expect(statuses).toEqual(["saving", "saving", "saved"]);
    expect(scheduler.busy).toBe(false);
  });

  it("re-sends at once after a conflict", async () => {
    const { scheduler, save, statuses, messages, outcomes } = setup();
    outcomes.push("conflict");
    await scheduler.flush();
    expect(statuses).toEqual(["conflict", "saving"]);
    expect(messages[0]).toBe("Resolving concurrent edit…");
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS);
    expect(save).toHaveBeenCalledTimes(2);
    expect(statuses.at(-1)).toBe("saved");
  });

  it("backs off after failures and resets once a save lands", async () => {
    const { scheduler, save, statuses, outcomes } = setup();
    outcomes.push(new Error("network"), new Error("network"), new Error("network"));
    await scheduler.flush();
    expect(statuses).toEqual(["offline"]);
    expect(scheduler.failures).toBe(1);
    await vi.advanceTimersByTimeAsync(retryDelay(1));
    expect(save).toHaveBeenCalledTimes(2);
    expect(scheduler.failures).toBe(2);
    await vi.advanceTimersByTimeAsync(retryDelay(2) - 1);
    expect(save).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(3);
    expect(scheduler.failures).toBe(3);
    await vi.advanceTimersByTimeAsync(retryDelay(3));
    expect(save).toHaveBeenCalledTimes(4);
    expect(scheduler.failures).toBe(0);
    expect(statuses.at(-1)).toBe("saved");
    expect(scheduler.busy).toBe(false);
  });

  it("keeps the failure on the status line until the retry starts", async () => {
    const { scheduler, save, statuses, messages, outcomes } = setup();
    outcomes.push(new Error("network"));
    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(save).toHaveBeenCalledTimes(1);
    // Nothing is in flight during the backoff, so nothing says "Saving…" until the retry does.
    expect(statuses).toEqual(["saving", "offline"]);
    expect(messages.at(-1)).toBe("Save failed — retrying");
    await vi.advanceTimersByTimeAsync(retryDelay(1) - 1);
    expect(statuses).toEqual(["saving", "offline"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(2);
    expect(statuses).toEqual(["saving", "offline", "saving", "saved"]);
  });

  it("folds a flush during a save into one more save", async () => {
    const { scheduler, save } = setup();
    let release!: (outcome: SaveOutcome) => void;
    save.mockImplementationOnce(() => new Promise<SaveOutcome>((resolve) => { release = resolve; }));
    const first = scheduler.flush();
    await scheduler.flush();
    await scheduler.flush();
    expect(save).toHaveBeenCalledTimes(1);
    release("saved");
    await first;
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("saves again when the gadget is dirty after a save, but not after a pending outcome", async () => {
    const { scheduler, save, statuses, outcomes, dirty } = setup();
    outcomes.push("pending");
    dirty(true);
    await scheduler.flush();
    expect(statuses).toEqual(["conflict"]);
    await vi.advanceTimersByTimeAsync(RETRY_MAX_MS);
    expect(save).toHaveBeenCalledTimes(1);

    save.mockImplementationOnce(async () => "saved");
    await scheduler.flush();
    // Still dirty (the mock above did not clear it): one more save follows.
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS);
    expect(save).toHaveBeenCalledTimes(3);
  });

  it("never saves for a reader", async () => {
    const { scheduler, save, statuses, dirty } = setup({ readOnly: true });
    dirty(true);
    scheduler.schedule();
    await scheduler.flush();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2);
    expect(save).not.toHaveBeenCalled();
    expect(statuses).toEqual([]);
  });

  it("can be cancelled", async () => {
    const { scheduler, save } = setup({ debounceMs: 50 });
    scheduler.schedule();
    scheduler.cancel();
    expect(scheduler.busy).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(save).not.toHaveBeenCalled();
  });
});
