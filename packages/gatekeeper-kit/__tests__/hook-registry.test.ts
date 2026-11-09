import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DELIVERED_RETENTION_MS } from "../src/hook-delivery-queue";
import { HookRegistry } from "../src/hook-registry";
import { fakeKv, type FakeKv } from "./fake-kv";

const MINUTE = 60_000;

/** `fakeKv`, holding capabilities by reference: a clone can't carry a stub's methods. */
function kvHoldingStubs(): FakeKv {
  const kv = fakeKv();
  const stubs = new Map<string, unknown>();
  return {
    ...kv,
    get: <T>(key: string) => (stubs.get(key) ?? kv.get(key)) as T | undefined,
    put: (key, value) => key.startsWith("caps:") ? void stubs.set(key, value) : kv.put(key, value),
    delete: key => {
      stubs.delete(key);
      kv.delete(key);
    },
  };
}

/** A hook's stubs, recording what the registry disposes and what its delivery is handed. */
function hook() {
  const disposed: string[] = [];
  const disposable = (name: string) => ({ [Symbol.dispose]: () => void disposed.push(name) });
  const firing = { callback: { name: "callback" }, approvalQueue: { name: "queue" }, ...disposable("firing") };
  const deliver = vi.fn(async (..._args: unknown[]) => {});
  const capabilities = {
    delivery: { deliver, ...disposable("delivery") },
    initiator: { startHook: vi.fn(async () => firing), ...disposable("initiator") },
  };
  return { capabilities: capabilities as never, startHook: capabilities.initiator.startHook, deliver, firing, disposed };
}

const registry = (kv = kvHoldingStubs(), onDrop = () => {}) =>
  new HookRegistry<never, string, { repo: string }>(kv, onDrop);

describe("HookRegistry", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000_000 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("lists each enabled hook by its bare key, and releases the stubs a replacement supersedes", () => {
    const hooks = registry();
    const [first, second] = [hook(), hook()];
    hooks.set("a", { repo: "one" }, first.capabilities);
    hooks.set("b", { repo: "two" }, hook().capabilities);

    hooks.set("a", { repo: "three" }, second.capabilities);

    expect(hooks.entries()).toEqual([["a", { repo: "three" }], ["b", { repo: "two" }]]);
    expect(first.disposed).toEqual(["delivery", "initiator"]);
    expect(second.disposed).toEqual([]);
  });

  it("refuses a key the queue could not tell from a message id", () => {
    const kv = kvHoldingStubs();

    expect(() => registry(kv).set("a:b", { repo: "one" }, hook().capabilities)).toThrow(TypeError);
    expect(kv.keys()).toEqual([]);
  });

  it("starts a firing and hands it to the hook's delivery with the message", async () => {
    const hooks = registry();
    const { capabilities, deliver, firing, disposed } = hook();
    hooks.set("a", { repo: "one" }, capabilities);
    hooks.enqueue("a", "m1", "message", Date.now());

    await hooks.run(Date.now());

    expect(deliver.mock.calls).toEqual([[firing.callback, firing.approvalQueue, "message"]]);
    expect(disposed.toSorted()).toEqual(["delivery", "firing", "initiator"]);
  });

  it("retries a delivery that throws, having released what it read", async () => {
    const hooks = registry();
    const { capabilities, deliver, disposed } = hook();
    deliver.mockRejectedValueOnce(new Error("the gadget failed"));
    hooks.set("a", { repo: "one" }, capabilities);
    hooks.enqueue("a", "m1", "message", Date.now());

    await hooks.run(Date.now());
    expect(disposed.toSorted()).toEqual(["delivery", "firing", "initiator"]);
    expect(hooks.nextDue()).toBe(Date.now() + MINUTE);

    await hooks.run(hooks.nextDue()!);
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it("returns what a removed hook was registered with, and ends its deliveries even if enabled again", async () => {
    const hooks = registry();
    const [removed, enabledAgain] = [hook(), hook()];
    hooks.set("a", { repo: "one" }, removed.capabilities);
    hooks.enqueue("a", "m1", "message", Date.now());

    expect(hooks.remove("a")).toEqual({ repo: "one" });
    expect(hooks.remove("a")).toBeUndefined();
    expect(hooks.entries()).toEqual([]);
    expect(removed.disposed).toEqual(["delivery", "initiator"]);

    hooks.set("a", { repo: "one" }, enabledAgain.capabilities);
    await hooks.run(Date.now());
    expect(enabledAgain.startHook).not.toHaveBeenCalled();
  });

  it("finishes a message queued for a hook that is not enabled, without retrying it", async () => {
    const onDrop = vi.fn();
    const hooks = registry(kvHoldingStubs(), onDrop);
    hooks.enqueue("gone", "m1", "message", Date.now());

    await hooks.run(Date.now());

    expect(hooks.nextDue()).toBe(Date.now() + DELIVERED_RETENTION_MS);
    expect(onDrop).not.toHaveBeenCalled();
  });
});
