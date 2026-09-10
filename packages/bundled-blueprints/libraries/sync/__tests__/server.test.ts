// @vitest-environment node
// The server entry assembled the way a gadget's Durable Object assembles it: a queue in front of
// storage, versioned upserts on the stored items, a registry fanning the result out. The entry
// imports nothing from the runtime, so nothing is mocked; the stubs are the shape the RPC layer
// delivers.

import { describe, expect, it } from "vitest";

import { MutationQueue, type PresenceEvent, SubscriberRegistry, type SubscriberStub, applyVersioned, normalizeCollaborator } from "../server.ts";

interface Block {
  id: string;
  html: string;
  version: number;
}

interface Callbacks {
  operation(event: { revision: number; upserts: Block[] }): void;
  presence(event: PresenceEvent): void;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The smallest gadget: blocks under versions, everyone told about each accepted batch and each other. */
class Gadget {
  readonly #queue = new MutationQueue();
  readonly #subscribers = new SubscriberRegistry<Callbacks, { clientId: string; name: string; color: string }>({
    join: (subscriber, who) => subscriber.presence({ type: "join", ...who }),
    leave: (subscriber, who) => subscriber.presence({ type: "leave", clientId: who.clientId }),
  });
  #stored = { revision: 0, blocks: [] as Block[] };

  applyOperation(upserts: Array<{ id: string; html: string; baseVersion: number }>) {
    return this.#queue.run(async () => {
      await tick();
      const outcome = applyVersioned(this.#stored.blocks, { upserts });
      if (!outcome.changed) return { status: outcome.status, revision: this.#stored.revision, conflicts: outcome.conflicts };
      this.#stored = { revision: this.#stored.revision + 1, blocks: Array.from(outcome.items.values()) };
      await this.#subscribers.broadcast((subscriber) => subscriber.operation({ revision: this.#stored.revision, upserts: outcome.accepted }));
      return { status: outcome.status, revision: this.#stored.revision, conflicts: outcome.conflicts };
    });
  }

  subscribe(subscriber: Callbacks, client: unknown) {
    this.#subscribers.add(subscriber, normalizeCollaborator(client as never));
    return this.#stored;
  }

  get size() {
    return this.#subscribers.size;
  }
}

function fakeStub() {
  const received: unknown[] = [];
  const stub = {
    received,
    async operation(event: unknown) { received.push(event); },
    async presence(event: unknown) { received.push(event); },
    dup() { return this; },
    onRpcBroken() {},
    [Symbol.dispose]() {},
  };
  return stub as typeof stub & Callbacks & SubscriberStub;
}

describe("sync/server", () => {
  it("serializes overlapping operations, versions their items and tells every subscriber", async () => {
    const gadget = new Gadget();
    const ada = fakeStub();
    const bob = fakeStub();
    gadget.subscribe(ada, { clientId: "ada", name: "Ada", color: "#111111" });
    gadget.subscribe(bob, { clientId: "bob", name: "  ", color: "nope" });
    await tick();
    expect(ada.received).toEqual([
      { type: "join", clientId: "ada", name: "Ada", color: "#111111" },
      { type: "join", clientId: "bob", name: "Guest", color: "#e1632e" },
    ]);
    ada.received.length = 0;
    bob.received.length = 0;

    const [first, second] = await Promise.all([
      gadget.applyOperation([{ id: "a", html: "<p>one</p>", baseVersion: 0 }]),
      gadget.applyOperation([{ id: "a", html: "<p>two</p>", baseVersion: 0 }]),
    ]);
    expect(first).toMatchObject({ status: "applied", revision: 1, conflicts: [] });
    expect(second).toMatchObject({ status: "conflict", revision: 1 });
    expect(second.conflicts).toEqual([{ id: "a", reason: "stale", current: { id: "a", html: "<p>one</p>", version: 1 } }]);
    expect(ada.received).toEqual([{ revision: 1, upserts: [{ id: "a", html: "<p>one</p>", version: 1 }] }]);
    expect(bob.received).toEqual(ada.received);
    expect(gadget.size).toBe(2);
  });
});
