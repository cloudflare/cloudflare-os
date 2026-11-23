import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DELIVERED_RETENTION_MS, MAX_DELIVERY_ATTEMPTS } from "../src/hook-delivery-queue";
import { HookRegistry } from "../src/hook-registry";
import { fakeKv, type FakeKv } from "./fake-kv";

const MINUTE = 60_000;

/** A stub as a storage read returns it: the reader's own to dispose, and dead once disposed. */
function copyOf<Stub extends Disposable>(stub: Stub): Stub {
  let disposed = false;
  return new Proxy(stub, {
    get(target, property) {
      if (property === Symbol.dispose) return () => (disposed = true, target[Symbol.dispose]());
      if (disposed) throw new Error("A stub was used after it was disposed.");
      return Reflect.get(target, property);
    },
  });
}

/** `fakeKv`, which can't clone a stub's methods, holding capabilities aside and reading back copies. */
function kvHoldingStubs(): FakeKv {
  const kv = fakeKv();
  const stubs = new Map<string, Record<string, Disposable>>();
  const read = (key: string) => {
    const held = stubs.get(key);
    return held && Object.fromEntries(Object.entries(held).map(([name, stub]) => [name, copyOf(stub)]));
  };
  return {
    ...kv,
    get: <T>(key: string) => (read(key) ?? kv.get(key)) as T | undefined,
    put: (key, value) => key.startsWith("caps:") ? void stubs.set(key, value as never) : kv.put(key, value),
    delete: key => {
      stubs.delete(key);
      kv.delete(key);
    },
  };
}

/** A hook's stubs, recording which copies the registry disposes and what its delivery is handed. */
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

  it("takes up the records a driver stored by hand, and stores its own under the same keys", async () => {
    const kv = kvHoldingStubs();
    const stored = hook();
    kv.put("reg:old", { repo: "one" });
    kv.put("caps:old", stored.capabilities);
    const hooks = registry(kv);

    expect(hooks.entries()).toEqual([["old", { repo: "one" }]]);
    hooks.enqueue("old", "m1", "message", Date.now());
    await hooks.run(Date.now());
    expect(stored.deliver).toHaveBeenCalledTimes(1);

    const added = hook();
    hooks.set("new", { repo: "two" }, added.capabilities);
    expect(kv.get("reg:new")).toEqual({ repo: "two" });
    expect(kv.get("caps:new")).toBeDefined();

    hooks.remove("old");
    expect([kv.get("reg:old"), kv.get("caps:old")]).toEqual([undefined, undefined]);
  });

  it("starts no firing for a message its screen turns away, and retries one whose screen throws", async () => {
    const kv = kvHoldingStubs();
    const screen = vi.fn(async (registration: { repo: string }, _capabilities: unknown, message: string) => {
      if (message === "unknown") throw new Error("can't tell yet");
      return message === registration.repo;
    });
    const hooks = new HookRegistry<never, string, { repo: string }>(kv, () => {}, screen);
    const enabled = hook();
    hooks.set("a", { repo: "one" }, enabled.capabilities);

    for (const message of ["one", "two", "unknown"]) hooks.enqueue("a", message, message, Date.now());
    await hooks.run(Date.now());

    expect(enabled.startHook).toHaveBeenCalledTimes(1);
    expect(enabled.deliver).toHaveBeenCalledWith(enabled.firing.callback, enabled.firing.approvalQueue, "one");
    // Only the one that couldn't be screened is still pending.
    expect(hooks.nextDue()).toBe(Date.now() + MINUTE);
  });

  it("refuses a key the queue could not tell from a message id", () => {
    const kv = kvHoldingStubs();

    expect(() => registry(kv).set("a:b", { repo: "one" }, hook().capabilities)).toThrow(TypeError);
    expect(kv.keys()).toEqual([]);
  });

  it("leaves no registration behind when its stubs can't be stored", () => {
    // The plain fake refuses them as storage refuses a stub with no durable address.
    const kv = fakeKv();

    expect(() => registry(kv).set("a", { repo: "one" }, hook().capabilities)).toThrow();
    expect(kv.keys()).toEqual([]);
  });

  it("releases the stubs it read of a hook whose replacement can't be stored", () => {
    const kv = kvHoldingStubs();
    const enabled = hook();
    registry(kv).set("a", { repo: "one" }, enabled.capabilities);
    const full: FakeKv = { ...kv, put: () => { throw new Error("storage is full"); } };

    expect(() => registry(full).set("a", { repo: "two" }, hook().capabilities)).toThrow("storage is full");
    expect(enabled.disposed).toEqual(["delivery", "initiator"]);
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

  it("joins a run already in flight, where a second would deliver its messages again", async () => {
    const hooks = registry();
    const { capabilities, deliver } = hook();
    const delivering = Promise.withResolvers<void>();
    deliver.mockReturnValueOnce(delivering.promise);
    hooks.set("a", { repo: "one" }, capabilities);
    hooks.enqueue("a", "m1", "message", Date.now());

    const runs = [hooks.run(Date.now()), hooks.run(Date.now())];
    delivering.resolve();
    await Promise.all(runs);

    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("holds a message until it is due, and reports it dropped after its last attempt", async () => {
    const onDrop = vi.fn();
    const hooks = registry(kvHoldingStubs(), onDrop);
    const { capabilities, deliver } = hook();
    deliver.mockRejectedValue(new Error("the gadget failed"));
    hooks.set("a", { repo: "one" }, capabilities);
    hooks.enqueue("a", "m1", "message", Date.now() + MINUTE);

    await hooks.run(Date.now());
    expect(deliver).not.toHaveBeenCalled();

    for (let attempt = 0; attempt < MAX_DELIVERY_ATTEMPTS; attempt++) await hooks.run(hooks.nextDue()!);
    expect(onDrop).toHaveBeenCalledTimes(1);
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
