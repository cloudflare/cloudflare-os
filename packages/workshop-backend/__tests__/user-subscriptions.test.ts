// UserSubscriptions caps its leases and drops a listener whose delivery fails.

import { describe, expect, it } from "vitest";
import { RpcTarget, type RpcStub } from "capnweb";
import { MAX_SUBSCRIPTIONS, UserSubscriptions } from "../src/user-subscriptions.js";

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
  it(`throws on the subscription past ${MAX_SUBSCRIPTIONS}`, () => {
    let { ctx } = fakeCtx();
    let subs = new UserSubscriptions<Listener>(ctx);
    for (let i = 0; i < MAX_SUBSCRIPTIONS; i++) subs.add(asStub(fakeStub()), null, undefined);
    expect(() => subs.add(asStub(fakeStub()), null, undefined)).toThrow(/At most/);
    expect(subs.size).toBe(MAX_SUBSCRIPTIONS);
  });

  it("releases a listener whose delivery fails", async () => {
    let { ctx, settled } = fakeCtx();
    let subs = new UserSubscriptions<Listener>(ctx);
    let stub = fakeStub();
    subs.add(asStub(stub), null, undefined);
    subs.send(async () => { throw new Error("gone"); });
    await settled();
    expect(subs.size).toBe(0);
    expect(stub.disposed).toBe(true);
  });
});
