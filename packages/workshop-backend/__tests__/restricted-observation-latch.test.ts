// authorizeObservation's restricted-data gates. The exclusion gate is decided before anything
// else: the restricted-mode latch is one-way, so an observation the exclusion blocks must leave
// no trace -- no latch, no record, sharing untouched. The decisions the delivery rests on (the
// removed-connection refusal, the unverifiable-producer refusal, the latch, the record) all run
// *after* the exclusion teardown's awaited cross-worker fan-out, in one synchronous block, so a
// removal landing mid-teardown refuses the observation rather than slipping past a pre-latched
// producer. And a restricted observation arriving through an already-removed connection (an
// in-flight facet RPC can outlive removeGatekeeper) is refused rather than latched: with zero
// collaborators nothing else would stop it, and latching a missing producer id would permanently
// brick sharing via assertNewSharingAllowed's missing-record branch.
//
// The last case covers the one producer admission cannot enforce: a connection with no vendor
// account behind it is in nobody's verification scope, so no collaborator is ever asked about it.
//
// Runs against a real OverseerDurableObject (the TEST_OVERSEER binding, like
// restricted-producer-removal.test.ts); the gatekeeper facet is the only fake.

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
    creationSpec: {
      type: "gatekeeper",
      vendorId: "testvendor",
      resourceUrl: `https://example.com/${id}`,
      typeUrlPattern: "https://*",
    },
  });
}

const RESTRICTED_EXCLUDING_MALLORY = {
  title: "Read a thing",
  description: "The test read a thing.",
  containsRestrictedData: true,
  excludeObservers: ["obs-m"],
};

describe("authorizeObservation's restricted-data gates", () => {
  it("latches and records only after the exclusion teardown admits the observation", async () => {
    let stub = env.TEST_OVERSEER.getByName("restricted-latch-teardown-window");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = getImpl(instance);
      seedGatekeeper(impl, 1);
      // An outstanding share link keeps the workspace "shared" for
      // removalBlockedByRestrictedData.
      impl.storage.shareKeys.put({
        id: "link-1", created: new Date(), createdBy: OWNER, role: "build",
      });
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

      held.resolve();
      await expect(observation).resolves.toBeUndefined();

      // Delivery: the latch and the record landed together, and everything keyed on the latch
      // now holds.
      expect(impl.storage.containsRestrictedData.get()).toBe(true);
      expect(impl.removalBlockedByRestrictedData(1, await impl.getSharingManager())).toBe(true);

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
      // Mallory is a current collaborator, verified against the producer: nothing else stands in
      // this observation's way, so the exclusion gate is the only thing blocking it.
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
      // sharing still grantable, no action record -- and mallory, still authorized, was not torn
      // down.
      expect(impl.storage.containsRestrictedData.get()).toBe(false);
      expect(() => impl.assertNewSharingAllowed()).not.toThrow();
      expect([...impl.storage.actions.list()]).toHaveLength(0);
      expect(impl.storage.observers.get("mallory")).toBeDefined();
    });
  });

  it("refuses the observation when the connection is removed mid-teardown", async () => {
    let stub = env.TEST_OVERSEER.getByName("restricted-latch-removed-mid-teardown");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = getImpl(instance);
      seedGatekeeper(impl, 1);
      impl.storage.observers.put(
          { profileId: "mallory", observerId: "obs-m", accountChoices: { 1: 10 } });

      let held = deferred();
      impl.getGatekeeperFacet = () => ({
        removeObserver: async () => { await held.promise; },
      });

      let observation = impl.authorizeObservation(
          1, RESTRICTED_EXCLUDING_MALLORY, { from: "user" });
      await tick();

      // The latch isn't set during the teardown, so removalBlockedByRestrictedData doesn't
      // protect the producer in this window; the connection is removed out from under the
      // in-flight observation.
      impl.storage.gatekeepers.delete(1);

      held.resolve();
      // The post-teardown re-read catches the removal: refused, and nothing latched or recorded.
      await expect(observation).rejects.toThrow(/has been removed/);
      expect(impl.storage.containsRestrictedData.get()).toBe(false);
      expect([...impl.storage.actions.list()]).toHaveLength(0);
    });
  });

  it("refuses restricted data through a removed connection instead of bricking sharing", async () => {
    let stub = env.TEST_OVERSEER.getByName("restricted-latch-missing-producer");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = getImpl(instance);
      // No gatekeeper record: the in-flight facet RPC outlived removeGatekeeper. With zero
      // collaborators nothing else refuses it, so only this guard stands between the observation
      // and latching a missing producer id.
      await expect(impl.authorizeObservation(1, {
        title: "Read a thing",
        description: "The test read a thing.",
        containsRestrictedData: true,
      }, { from: "user" })).rejects.toThrow(/has been removed/);

      // A blocked observation delivered no data: the workspace must not be left restricted --
      // and above all must not be left permanently unshareable by latching a missing producer.
      expect(impl.storage.containsRestrictedData.get()).toBe(false);
      expect(() => impl.assertNewSharingAllowed()).not.toThrow();
    });
  });

  it("refuses an unverifiable producer's restricted data on a shared workspace", async () => {
    let stub = env.TEST_OVERSEER.getByName("restricted-latch-unverifiable-shared");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = getImpl(instance);
      // An AI model binding has no vendor account behind it, so #inScopeGatekeepers skips it and
      // no collaborator is ever asked to verify against it -- the one producer admission cannot
      // enforce, and the only one this check still refuses.
      impl.storage.gatekeepers.put({
        id: 1,
        resourceTitle: "Claude",
        class: {} as any,
        creationSpec: {
          type: "aiModel", modelId: "m", provider: "anthropic", modelName: "claude",
        },
      });
      impl.storage.collaborators.put({
        profile: { id: "mallory", name: "Mallory" },
        addedBy: [{ type: "user", sharer: OWNER, created: new Date(), role: "build" }],
      });

      await expect(impl.authorizeObservation(1, {
        title: "Read a thing",
        description: "The test read a thing.",
        containsRestrictedData: true,
      }, { from: "user" })).rejects.toThrow(/cannot verify anyone's access/);

      // Refused, so nothing latched: the owner can still unshare and read it.
      expect(impl.storage.containsRestrictedData.get()).toBe(false);
      expect([...impl.storage.actions.list()]).toHaveLength(0);
    });
  });

  it("admits an unverifiable producer's restricted data on a solo workspace", async () => {
    let stub = env.TEST_OVERSEER.getByName("restricted-latch-unverifiable-solo");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = getImpl(instance);
      impl.storage.gatekeepers.put({
        id: 1,
        resourceTitle: "Claude",
        class: {} as any,
        creationSpec: {
          type: "aiModel", modelId: "m", provider: "anthropic", modelName: "claude",
        },
      });

      // Nobody to under-verify: the owner reads their own data, and the latch is what keeps it
      // that way.
      await expect(impl.authorizeObservation(1, {
        title: "Read a thing",
        description: "The test read a thing.",
        containsRestrictedData: true,
      }, { from: "user" })).resolves.toBeUndefined();

      expect(impl.storage.containsRestrictedData.get()).toBe(true);
      expect(() => impl.assertNewSharingAllowed()).toThrow();
    });
  });
});
