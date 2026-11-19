import { describe, expect, it, vi } from "vitest";
import { RpcTarget, env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { detachRpcResult, limitedSessionProxy, releasingSessionProxy, type OverseerDurableObject } from "../src/overseer.js";
import { KeyedConcurrencyLimiter } from "../src/concurrency-limiter.js";
import type { GatekeeperCaller } from "../src/storage-schema/overseer-storage";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

// GatekeeperLoopback opens a fresh session on the overseer for every binding method call. The
// session must be released when the call settles: left to the garbage collector it pins the
// session, its approval queue and the overseer-side RPC call for hours, and a workspace whose
// scheduled gadgets make a few hundred binding calls a run grows the isolate past its memory
// limit (seen in production as "Worker exceeded memory limit." on every open loopback).
//
// The local runtime refuses to dispatch through the loopback's Proxy entrypoint ("prototype does
// not implement"), so these tests drive releasingSessionProxy, the wrapper the loopback returns,
// over a real overseer RPC session with real stub disposal.

type Impl = {
  startGatekeeperSession(target: unknown, caller: GatekeeperCaller): Promise<unknown>;
};

const CALLER = { from: "gadget", gadgetId: 1, chatId: 1 } as GatekeeperCaller;
const TARGET = { type: "gatekeeper", id: 5 };

class Counter extends RpcTarget {
  value = 7;
  read() { return this.value; }
}

class FakeSession extends RpcTarget {
  constructor(private onDispose: () => void, private fail = false) { super(); }
  ping(n: number) {
    if (this.fail) throw new Error("upstream failed");
    return { pong: n };
  }
  rows(n: number) {
    return { rows: Array.from({ length: n }, (_, i) => ({ i, label: `row ${i}` })) };
  }
  counter() { return { counter: new Counter() }; }
  [Symbol.dispose]() { this.onDispose(); }
}

let counter = 0;

// An overseer whose session opener is replaced by `open`, reached over RPC as the loopback does.
async function overseerWith(open: Impl["startGatekeeperSession"]): Promise<any> {
  let stub = env.TEST_OVERSEER.getByName(`gatekeeper-loopback-${++counter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    (instance as unknown as { impl: Impl }).impl.startGatekeeperSession = open;
  });
  return stub;
}

function signal(): { fire: () => void, fired: Promise<"fired" | "timeout"> } {
  let fire!: () => void;
  let p = new Promise<"fired">(r => fire = () => r("fired"));
  let fired = Promise.race([p, new Promise<"timeout">(r => setTimeout(() => r("timeout"), 1500))]);
  return { fire, fired };
}

describe("GatekeeperLoopback session", () => {
  it("is not released by a plain call (the leak this guards against)", async () => {
    let disposed = signal();
    let overseer = await overseerWith(async () => new FakeSession(disposed.fire));
    let session = overseer.startGatekeeperSession(TARGET, CALLER);
    expect(await session.ping(1)).toEqual({ pong: 1 });
    expect(await disposed.fired).toBe("timeout");
  });

  it("is released once a call returns", async () => {
    let disposed = signal();
    let overseer = await overseerWith(async () => new FakeSession(disposed.fire));
    let loopback = releasingSessionProxy(overseer.startGatekeeperSession(TARGET, CALLER));
    expect(await loopback.ping(1)).toEqual({ pong: 1 });
    expect(await disposed.fired).toBe("fired");
  });

  it("is released when the call throws, and the error still reaches the caller", async () => {
    let disposed = signal();
    let overseer = await overseerWith(async () => new FakeSession(disposed.fire, true));
    let loopback = releasingSessionProxy(overseer.startGatekeeperSession(TARGET, CALLER));
    await expect(loopback.ping(1)).rejects.toThrow(/upstream failed/);
    expect(await disposed.fired).toBe("fired");
  });

  it("passes a failure to open the session through to the caller", async () => {
    let overseer = await overseerWith(async () => { throw new Error("restarting"); });
    let loopback = releasingSessionProxy(overseer.startGatekeeperSession(TARGET, CALLER));
    await expect(loopback.ping(1)).rejects.toThrow(/restarting/);
  });

  it("leaves promise methods and symbols untouched", async () => {
    let overseer = await overseerWith(async () => new FakeSession(() => {}));
    let session = overseer.startGatekeeperSession(TARGET, CALLER);
    let loopback = releasingSessionProxy(session);
    expect(loopback.then).toBe(Reflect.get(session, "then", session));
    expect(Object.getPrototypeOf(loopback)).not.toBe(Object.getPrototypeOf(session));
    await loopback.ping(1);
  });
});

describe("GatekeeperLoopback concurrency cap", () => {
  it("runs a fan-out past the cap in waves and releases every slot", async () => {
    let open = 0, peak = 0, disposed = 0;
    let overseer = await overseerWith(async () => {
      open++;
      peak = Math.max(peak, open);
      return new FakeSession(() => { open--; disposed++; });
    });
    let limiter = new KeyedConcurrencyLimiter(4);
    let calls = Array.from({ length: 20 }, (_, i) =>
        limitedSessionProxy(limiter, "ws", () => overseer.startGatekeeperSession(TARGET, CALLER))
            .ping(i));
    let results = await Promise.all(calls);
    expect(results.map((r: any) => r.pong)).toEqual(Array.from({ length: 20 }, (_, i) => i));
    await vi.waitFor(() => expect(limiter.stats("ws")).toEqual({ active: 0, waiting: 0 }));
    // Remote disposal lands asynchronously, so allow it to catch up before counting.
    await vi.waitFor(() => expect(disposed).toBe(20));
    expect(peak).toBeLessThanOrEqual(4);
  });

  it("frees the slot when opening the session fails", async () => {
    let overseer = await overseerWith(async () => { throw new Error("restarting"); });
    let limiter = new KeyedConcurrencyLimiter(1);
    let make = () =>
        limitedSessionProxy(limiter, "ws", () => overseer.startGatekeeperSession(TARGET, CALLER));
    await expect(make().ping(1)).rejects.toThrow(/restarting/);
    await expect(make().ping(2)).rejects.toThrow(/restarting/);
    await vi.waitFor(() => expect(limiter.stats("ws")).toEqual({ active: 0, waiting: 0 }));
  });
});

// The loopback returns the result of its own RPC call to the overseer. Returned as received, that
// result keeps the loopback invocation open until the gadget's execution context ends (hours, for
// a facet), holding the payload in the loopback isolate; this filled the isolate past its memory
// limit on 2026-11-19. Reproduced in workerd with a relay entrypoint: returning the received result
// ended the relay with the caller's context, returning a structured clone ended it on return.
describe("GatekeeperLoopback results", () => {
  it("returns a plain copy of a data result, detached from the RPC call", async () => {
    let overseer = await overseerWith(async () => new FakeSession(() => {}));
    let raw = await overseer.startGatekeeperSession(TARGET, CALLER).rows(3);
    expect(typeof raw[Symbol.dispose]).toBe("function");

    let loopback = releasingSessionProxy(overseer.startGatekeeperSession(TARGET, CALLER));
    let result = await loopback.rows(3);
    expect(result).toEqual({ rows: [0, 1, 2].map(i => ({ i, label: `row ${i}` })) });
    expect(result[Symbol.dispose]).toBeUndefined();
  });

  it("passes a result holding a stub through unchanged, so the stub still works", async () => {
    let overseer = await overseerWith(async () => new FakeSession(() => {}));
    let loopback = releasingSessionProxy(overseer.startGatekeeperSession(TARGET, CALLER));
    let result = await loopback.counter();
    expect(await result.counter.read()).toBe(7);
    result[Symbol.dispose]();
  });

  it("leaves primitives and non-RPC values alone", () => {
    expect(detachRpcResult(5)).toBe(5);
    expect(detachRpcResult(null)).toBe(null);
    let plain = { a: 1 };
    expect(detachRpcResult(plain)).toBe(plain);
  });

  it("disposes the original once it has a copy, and keeps an uncloneable value", () => {
    let disposed = 0;
    let data = { a: [1, 2], [Symbol.dispose]() { disposed++; } };
    let copy = detachRpcResult(data);
    expect(copy).toEqual({ a: [1, 2] });
    expect(copy).not.toBe(data);
    expect(disposed).toBe(1);

    let withFn = { f: () => 1, [Symbol.dispose]() { disposed++; } };
    expect(detachRpcResult(withFn)).toBe(withFn);
    expect(disposed).toBe(1);
  });
});
