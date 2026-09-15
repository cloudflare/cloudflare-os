// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { type PresenceHooks, SubscriberRegistry, type SubscriberStub } from "../src/subscribers.ts";

interface Callbacks {
  operation(event: { revision: number }): void;
  presence(event: { type: "join" | "leave"; clientId: string }): void;
}

interface Who {
  clientId: string;
}

/**
 * A subscriber as the RPC layer would deliver it: the callbacks record what they were told, `dup`
 * hands back the same object (marking that it was kept), and the broken-connection handler can be
 * fired by the test.
 */
function fakeStub(failOn: (event: unknown) => boolean = () => false) {
  const received: unknown[] = [];
  let broken: ((error: unknown) => void) | null = null;
  const stub = {
    dups: 0,
    disposed: 0,
    received,
    async operation(event: { revision: number }) {
      if (failOn(event)) throw new Error("gone");
      received.push(event);
    },
    async presence(event: { type: "join" | "leave"; clientId: string }) {
      if (failOn(event)) throw new Error("gone");
      received.push(event);
    },
    dup() {
      this.dups++;
      return this;
    },
    onRpcBroken(handler: (error: unknown) => void) {
      broken = handler;
    },
    [Symbol.dispose]() {
      this.disposed++;
    },
    break() {
      broken?.(new Error("disconnected"));
    },
  };
  return stub as typeof stub & Callbacks & SubscriberStub;
}

const hooks: PresenceHooks<Callbacks, Who> = {
  join: (subscriber, who) => subscriber.presence({ type: "join", clientId: who.clientId }),
  leave: (subscriber, who) => subscriber.presence({ type: "leave", clientId: who.clientId }),
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("SubscriberRegistry", () => {
  it("keeps a dup of each subscriber, seeds a newcomer with the others, then announces it", async () => {
    const registry = new SubscriberRegistry<Callbacks, Who>(hooks);
    const ada = fakeStub();
    const bob = fakeStub();
    registry.add(ada, { clientId: "ada" });
    await settle();
    expect(ada.dups).toBe(1);
    // Alone: nothing to be seeded with, and its own join comes back to it.
    expect(ada.received).toEqual([{ type: "join", clientId: "ada" }]);

    registry.add(bob, { clientId: "bob" });
    expect(registry.size).toBe(2);
    expect(registry.members()).toEqual([{ clientId: "ada" }, { clientId: "bob" }]);
    // Announcements wait for the subscribing call to return.
    expect(bob.received).toEqual([]);
    await settle();
    expect(bob.received).toEqual([{ type: "join", clientId: "ada" }, { type: "join", clientId: "bob" }]);
    expect(ada.received.at(-1)).toEqual({ type: "join", clientId: "bob" });
  });

  it("broadcasts to everyone, drops a failing subscriber and tells the rest it left", async () => {
    const registry = new SubscriberRegistry<Callbacks, Who>(hooks);
    const ada = fakeStub();
    const bob = fakeStub((event) => typeof event === "object" && event !== null && "revision" in event);
    registry.add(ada, { clientId: "ada" });
    registry.add(bob, { clientId: "bob" });
    await settle();
    ada.received.length = 0;

    registry.broadcast((subscriber) => subscriber.operation({ revision: 2 }));
    await settle();
    expect(ada.received).toEqual([{ revision: 2 }, { type: "leave", clientId: "bob" }]);
    expect(registry.members()).toEqual([{ clientId: "ada" }]);
    expect(bob.disposed).toBe(1);
  });

  it("drops a subscriber whose connection broke, once, and announces it", async () => {
    const registry = new SubscriberRegistry<Callbacks, Who>(hooks);
    const ada = fakeStub();
    const bob = fakeStub();
    registry.add(ada, { clientId: "ada" });
    registry.add(bob, { clientId: "bob" });
    await settle();
    ada.received.length = 0;

    bob.break();
    bob.break();
    await settle();
    expect(registry.size).toBe(1);
    expect(bob.disposed).toBe(1);
    expect(ada.received).toEqual([{ type: "leave", clientId: "bob" }]);
  });

  it("removes a subscriber on request", async () => {
    const registry = new SubscriberRegistry<Callbacks, Who>(hooks);
    const ada = fakeStub();
    const bob = fakeStub();
    registry.add(ada, { clientId: "ada" });
    const handle = registry.add(bob, { clientId: "bob" });
    await settle();
    ada.received.length = 0;

    expect(registry.remove(handle)).toBe(true);
    expect(registry.remove(handle)).toBe(false);
    await settle();
    expect(registry.size).toBe(1);
    expect(bob.disposed).toBe(1);
    expect(ada.received).toEqual([{ type: "leave", clientId: "bob" }]);
  });

  it("seeds a newcomer past a failure, then drops it and announces its leave", async () => {
    const join = vi.fn(hooks.join);
    const registry = new SubscriberRegistry<Callbacks, Who>({ ...hooks, join });
    const ada = fakeStub();
    const bob = fakeStub();
    // Fails the seed that names ada, whichever order the seeds run in.
    const failing = fakeStub((event) => (event as { clientId: string }).clientId === "ada");
    registry.add(ada, { clientId: "ada" });
    registry.add(bob, { clientId: "bob" });
    await settle();
    join.mockClear();
    ada.received.length = 0;

    registry.add(failing, { clientId: "zed" });
    expect(registry.size).toBe(3);
    await settle();
    // Both seeds are attempted, ada's failure notwithstanding; the newcomer is then dropped. Its
    // join was never broadcast, but its leave is: it was a member while it seeded, and anyone who
    // subscribed in that window was seeded with it (see the next case).
    expect(join.mock.calls.filter(([subscriber]) => subscriber === failing).map(([, who]) => who)).toEqual([{ clientId: "ada" }, { clientId: "bob" }]);
    expect(join.mock.calls.filter(([subscriber]) => subscriber !== failing)).toEqual([]);
    expect(failing.received).toEqual([{ type: "join", clientId: "bob" }]);
    expect(registry.members()).toEqual([{ clientId: "ada" }, { clientId: "bob" }]);
    expect(failing.disposed).toBe(1);
    expect(ada.received).toEqual([{ type: "leave", clientId: "zed" }]);

    // Its connection breaking afterwards has nothing left to drop or announce.
    failing.break();
    await settle();
    expect(failing.disposed).toBe(1);
    expect(ada.received).toEqual([{ type: "leave", clientId: "zed" }]);
  });

  it("tells a subscriber seeded with a newcomer that then failed its own seed that it left", async () => {
    const registry = new SubscriberRegistry<Callbacks, Who>(hooks);
    const ada = fakeStub();
    const bob = fakeStub();
    const failing = fakeStub((event) => (event as { clientId: string }).clientId === "ada");
    registry.add(ada, { clientId: "ada" });
    await settle();

    // bob subscribes while zed is still seeding: zed is a member, so bob is seeded with it.
    registry.add(failing, { clientId: "zed" });
    registry.add(bob, { clientId: "bob" });
    expect(registry.members()).toEqual([{ clientId: "ada" }, { clientId: "zed" }, { clientId: "bob" }]);
    await settle();

    // zed's seed failure drops it; bob, who heard of it, hears that it left rather than keeping a
    // phantom until its own roster expires it.
    const zedEvents = bob.received.filter((event) => (event as { clientId: string }).clientId === "zed");
    expect(zedEvents).toEqual([{ type: "join", clientId: "zed" }, { type: "leave", clientId: "zed" }]);
    expect(bob.received.at(-1)).toEqual({ type: "join", clientId: "bob" });
    expect(registry.members()).toEqual([{ clientId: "ada" }, { clientId: "bob" }]);
    expect(failing.disposed).toBe(1);
  });

  it("does not announce a newcomer removed before its announcement ran", async () => {
    const registry = new SubscriberRegistry<Callbacks, Who>(hooks);
    const ada = fakeStub();
    const bob = fakeStub();
    registry.add(ada, { clientId: "ada" });
    await settle();
    ada.received.length = 0;

    const handle = registry.add(bob, { clientId: "bob" });
    expect(registry.remove(handle)).toBe(true);
    await settle();
    expect(ada.received).toEqual([{ type: "leave", clientId: "bob" }]);
    expect(bob.received).toEqual([]);
  });

  it("is a plain fan-out without presence hooks", async () => {
    const registry = new SubscriberRegistry<Callbacks>();
    const ada = fakeStub();
    const bob = fakeStub((event) => typeof event === "object" && event !== null && "revision" in event);
    registry.add(ada);
    registry.add(bob);
    await settle();
    expect(ada.received).toEqual([]);
    registry.broadcast((subscriber) => subscriber.operation({ revision: 1 }));
    await settle();
    expect(ada.received).toEqual([{ revision: 1 }]);
    expect(registry.size).toBe(1);
  });

  it("delivers in call order without waiting, so a hung subscriber holds up nobody and a callback may re-enter", async () => {
    const registry = new SubscriberRegistry<Callbacks, Who>(hooks);
    const ada = fakeStub();
    const hung = fakeStub();
    hung.operation = () => new Promise(() => {});
    // A callback that calls back into the object: it broadcasts again from inside its delivery.
    const reentrant = fakeStub();
    const inner = reentrant.operation.bind(reentrant);
    reentrant.operation = async (event) => {
      await inner(event);
      if (event.revision === 1) registry.broadcast((subscriber) => subscriber.operation({ revision: 2 }));
    };
    registry.add(ada, { clientId: "ada" });
    registry.add(hung, { clientId: "hung" });
    registry.add(reentrant, { clientId: "re" });
    await settle();
    ada.received.length = 0;
    reentrant.received.length = 0;

    // Returns at once: nothing here waits on `hung`.
    registry.broadcast((subscriber) => subscriber.operation({ revision: 1 }));
    expect(ada.received).toEqual([{ revision: 1 }]);
    await settle();
    expect(ada.received).toEqual([{ revision: 1 }, { revision: 2 }]);
    expect(reentrant.received).toEqual([{ revision: 1 }, { revision: 2 }]);
    expect(registry.size).toBe(3);
    expect(hung.disposed).toBe(0);
  });

  it("drops a subscriber whose callback throws synchronously, like one whose promise rejects", async () => {
    const registry = new SubscriberRegistry<Callbacks, Who>(hooks);
    const ada = fakeStub();
    const thrower = fakeStub();
    thrower.operation = () => { throw new Error("sync failure"); };
    registry.add(ada, { clientId: "ada" });
    registry.add(thrower, { clientId: "thrower" });
    await settle();
    ada.received.length = 0;

    registry.broadcast((subscriber) => subscriber.operation({ revision: 1 }));
    await settle();
    expect(registry.has(thrower)).toBe(false);
    expect(registry.has(ada)).toBe(true);
    expect(thrower.disposed).toBe(1);
    expect(ada.received).toEqual([{ revision: 1 }, { type: "leave", clientId: "thrower" }]);
  });
});
