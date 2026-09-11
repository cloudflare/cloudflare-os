// authorizeObservation's restricted-data latch is one-way and is set only once the observation is
// actually delivered. The exclusion gate is decided first, across an awaited cross-worker fan-out,
// so an observation the exclusion blocks must leave no trace -- no latch, no record -- and one it
// admits latches and records in the same synchronous block after the teardown completes.
//
// Runs against a real OverseerDurableObject (the TEST_OVERSEER binding); the gatekeeper facet is
// the only fake.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const OWNER = "alice";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  let promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function getImpl(instance: OverseerDurableObject): any {
  let impl = (instance as unknown as { impl: any }).impl;
  // The sharing manager resolves collaborator reachability from the owner; seed the cached
  // profile id so no User DO round trip is attempted.
  impl.ownerProfileId = OWNER;
  return impl;
}

function seedGatekeeper(impl: any, id: number): void {
  impl.storage.gatekeepers.put({
    id,
    resourceTitle: `Connection ${id}`,
    class: {} as any,
  });
}

const RESTRICTED_EXCLUDING_MALLORY = {
  title: "Read a thing",
  description: "The test read a thing.",
  containsRestrictedData: true,
  excludeObservers: ["obs-m"],
};

describe("authorizeObservation's restricted-data latch", () => {
  it("latches and records only after the exclusion teardown admits the observation", async () => {
    let stub = env.TEST_OVERSEER.getByName("restricted-latch-teardown-window");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = getImpl(instance);
      seedGatekeeper(impl, 1);
      // Mallory holds an observer record but no reachable role: the named exclusion admits the
      // observation and schedules her teardown.
      impl.storage.observers.put(
          { profileId: "mallory", observerId: "obs-m", accountChoices: { 1: 10 } });

      // The cross-worker teardown parks, holding the observation mid-flight before any decision
      // the delivery rests on has been made.
      let held = deferred();
      impl.getGatekeeperFacet = () => ({
        removeObserver: async () => { await held.promise; },
      });

      let observation = impl.authorizeObservation(
          1, RESTRICTED_EXCLUDING_MALLORY, { from: "user" });
      await tick();

      // Nothing is delivered while the teardown is in flight, so nothing has latched: a teardown
      // that ends in refusal must leave no trace.
      expect(impl.storage.containsRestrictedData.get()).toBe(false);
      expect(impl.storage.restrictedProducerIds.get()).toBeNull();

      held.resolve();
      await expect(observation).resolves.toBeUndefined();

      // Delivery: the latch, the producer and the record landed together.
      expect(impl.storage.containsRestrictedData.get()).toBe(true);
      expect(impl.storage.restrictedProducerIds.get()).toEqual({ ids: [1], through: 0 });

      // The teardown still ran (mallory is no longer set up to observe).
      expect(impl.storage.observers.get("mallory")).toBeUndefined();
      let records = [...impl.storage.actions.list()];
      expect(records).toHaveLength(1);
      expect(records[0].type).toBe("observation");
    });
  });

  it("leaves no trace when the exclusion gate blocks the observation", async () => {
    let stub = env.TEST_OVERSEER.getByName("restricted-latch-exclusion-blocked");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = getImpl(instance);
      seedGatekeeper(impl, 1);
      // Mallory is a current collaborator: the exclusion gate is the only thing blocking this
      // observation.
      impl.storage.collaborators.put({
        profile: { id: "mallory", name: "Mallory" },
        addedBy: [{ type: "user", sharer: OWNER, created: new Date(), role: "build" }],
      });
      impl.storage.observers.put(
          { profileId: "mallory", observerId: "obs-m", accountChoices: { 1: 10 } });

      await expect(impl.authorizeObservation(
          1, RESTRICTED_EXCLUDING_MALLORY, { from: "user" }))
          .rejects.toThrow(/not permitted to see/);

      // The blocked observation delivered no data, so the workspace is not restricted: no latch,
      // no action record -- and mallory, still authorized, was not torn down.
      expect(impl.storage.containsRestrictedData.get()).toBe(false);
      expect(impl.storage.restrictedProducerIds.get()).toBeNull();
      expect([...impl.storage.actions.list()]).toHaveLength(0);
      expect(impl.storage.observers.get("mallory")).toBeDefined();
    });
  });
});
