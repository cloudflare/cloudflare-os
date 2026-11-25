// UserSubscriptions delivers to each listener one at a time, in order; a listener too far behind
// gets one fresh snapshot in place of its queue (or is dropped, with no snapshot), and a failed
// delivery drops it.

import { describe, expect, it } from "vitest";
import { RpcTarget, type RpcStub } from "capnweb";
import {
  MAX_PENDING_DELIVERIES, MAX_SUBSCRIPTIONS, UserSubscriptions,
} from "../src/user-subscriptions.js";

class Listener extends RpcTarget {}

type FakeStub = { disposed: boolean, dup(): FakeStub, onRpcBroken(): void, [Symbol.dispose](): void };

// A local stand-in for a listener's stub, recording whether it was disposed.
function fakeStub(): FakeStub {
  let stub: FakeStub = {
    disposed: false,
    dup: () => stub,
    onRpcBroken: () => {},
    [Symbol.dispose]() { stub.disposed = true; },
  };
  return stub;
}

function fakeCtx() {
  let pending: Promise<unknown>[] = [];
  let ctx = { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } };
  return { ctx: ctx as unknown as DurableObjectState, settled: () => Promise.all(pending) };
}

function asStub(stub: FakeStub): RpcStub<Listener> {
  return stub as unknown as RpcStub<Listener>;
}

describe("UserSubscriptions", () => {
  it("delivers to a listener in order, one at a time", async () => {
    let { ctx, settled } = fakeCtx();
    let subs = new UserSubscriptions<Listener>(ctx, "test");
    let log: string[] = [];
    let inFlight = 0;
    let record = (name: string) => async () => {
      expect(++inFlight).toBe(1);
      await scheduler.wait(1);
      log.push(name);
      inFlight--;
    };
    subs.add(asStub(fakeStub()), record("snapshot"), undefined);
    for (let i = 0; i < 3; i++) subs.send(record(`delta ${i}`));
    await settled();
    expect(log).toEqual(["snapshot", "delta 0", "delta 1", "delta 2"]);
  });

  it("collapses an overflowed queue to one snapshot, queuing no deltas behind it", async () => {
    let { ctx, settled } = fakeCtx();
    let subs = new UserSubscriptions<Listener>(ctx, "test");
    let release = Promise.withResolvers<void>();
    let log: string[] = [];
    let first = true;
    subs.add(asStub(fakeStub()), async () => {
      if (first) { first = false; await release.promise; }
      log.push("snapshot");
    }, undefined);
    // The first snapshot is in flight; these fill the queue, then overflow it, then follow it.
    for (let i = 0; i < MAX_PENDING_DELIVERIES + 10; i++) {
      subs.send(async () => { log.push(`delta ${i}`); });
    }
    release.resolve();
    await settled();
    expect(log).toEqual(["snapshot", "snapshot"]);
    expect(subs.size).toBe(1);
  });

  it("releases a listener without a snapshot whose queue overflows", async () => {
    let { ctx, settled } = fakeCtx();
    let subs = new UserSubscriptions<Listener>(ctx, "test");
    let stub = fakeStub();
    subs.add(asStub(stub), null, undefined);
    let release = Promise.withResolvers<void>();
    let delivered = 0;
    for (let i = 0; i <= MAX_PENDING_DELIVERIES + 1; i++) {
      subs.send(async () => { if (i === 0) await release.promise; delivered++; });
    }
    expect(subs.size).toBe(0);
    expect(stub.disposed).toBe(true);
    release.resolve();
    await settled();
    // Only the delivery already in flight completes.
    expect(delivered).toBe(1);
  });

  it(`throws on the subscription past ${MAX_SUBSCRIPTIONS}`, () => {
    let { ctx } = fakeCtx();
    let subs = new UserSubscriptions<Listener>(ctx, "test");
    for (let i = 0; i < MAX_SUBSCRIPTIONS; i++) subs.add(asStub(fakeStub()), null, undefined);
    expect(() => subs.add(asStub(fakeStub()), null, undefined)).toThrow(/At most/);
    expect(subs.size).toBe(MAX_SUBSCRIPTIONS);
  });

  it("releases a listener whose delivery fails", async () => {
    let { ctx, settled } = fakeCtx();
    let subs = new UserSubscriptions<Listener>(ctx, "test");
    let stub = fakeStub();
    let delivered: string[] = [];
    subs.add(asStub(stub), null, undefined);
    subs.send(async () => { throw new Error("gone"); });
    subs.send(async () => { delivered.push("after"); });
    await settled();
    expect(subs.size).toBe(0);
    expect(stub.disposed).toBe(true);
    expect(delivered).toEqual([]);
  });
});
