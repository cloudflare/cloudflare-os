// authorizeObservation sets `containsRestrictedData` (and `ownerInvitesOnly`) one-way, and only once
// the observation is actually delivered. The exclusion gate is decided first, across an awaited
// cross-worker fan-out, so an observation the exclusion blocks must leave no trace -- no flag, no
// record -- and one it admits sets the flags and records in the same synchronous block after the
// teardown completes.
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

describe("authorizeObservation's containsRestrictedData and ownerInvitesOnly flags", () => {
  it("sets containsRestrictedData and records only after the exclusion teardown admits the observation", async () => {
    let stub = env.TEST_OVERSEER.getByName("restricted-flag-teardown-window");
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

      // Nothing is delivered while the teardown is in flight, so no flag is set: a teardown
      // that ends in refusal must leave no trace.
      expect(impl.storage.containsRestrictedData.get()).toBe(false);

      held.resolve();
      await expect(observation).resolves.toBeUndefined();

      // Delivery: the flag and the record landed together.
      expect(impl.storage.containsRestrictedData.get()).toBe(true);

      // The teardown still ran (mallory is no longer set up to observe).
      expect(impl.storage.observers.get("mallory")).toBeUndefined();
      let records = [...impl.storage.actions.list()];
      expect(records).toHaveLength(1);
      expect(records[0].type).toBe("observation");
    });
  });

  it("leaves no trace when the exclusion gate blocks the observation", async () => {
    let stub = env.TEST_OVERSEER.getByName("restricted-flag-exclusion-blocked");
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

      // The blocked observation delivered no data, so the workspace is not restricted: no flag,
      // no action record -- and mallory, still authorized, was not torn down.
      expect(impl.storage.containsRestrictedData.get()).toBe(false);
      expect([...impl.storage.actions.list()]).toHaveLength(0);
      expect(impl.storage.observers.get("mallory")).toBeDefined();
    });
  });

  it("sets ownerInvitesOnly only for observations that carry the flag", async () => {
    let stub = env.TEST_OVERSEER.getByName("owner-invites-only-flag");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = getImpl(instance);
      seedGatekeeper(impl, 1);

      // containsRestrictedData alone restricts the workspace but leaves share links working.
      await impl.authorizeObservation(1, {
        title: "Read a thing", description: "d", containsRestrictedData: true,
      }, { from: "user" });
      expect(impl.storage.containsRestrictedData.get()).toBe(true);
      expect(impl.storage.ownerInvitesOnly.get()).toBe(false);

      await impl.authorizeObservation(1, {
        title: "Read a thing", description: "d", containsRestrictedData: true,
        ownerInvitesOnly: true,
      }, { from: "user" });
      expect(impl.storage.ownerInvitesOnly.get()).toBe(true);

      // The flag is enforced by the memoized sharing manager.
      let sharing = await impl.getSharingManager();
      await expect(sharing.createShareLink({
        caller: { profileId: OWNER, isOwner: true }, role: "use",
      })).rejects.toThrow(/Share links are disabled/);
    });
  });

  it("does not set ownerInvitesOnly when the exclusion gate blocks the observation", async () => {
    let stub = env.TEST_OVERSEER.getByName("owner-invites-only-exclusion-blocked");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = getImpl(instance);
      seedGatekeeper(impl, 1);
      impl.storage.collaborators.put({
        profile: { id: "mallory", name: "Mallory" },
        addedBy: [{ type: "user", sharer: OWNER, created: new Date(), role: "build" }],
      });
      impl.storage.observers.put(
          { profileId: "mallory", observerId: "obs-m", accountChoices: { 1: 10 } });

      await expect(impl.authorizeObservation(
          1, { ...RESTRICTED_EXCLUDING_MALLORY, ownerInvitesOnly: true }, { from: "user" }))
          .rejects.toThrow(/not permitted to see/);

      expect(impl.storage.ownerInvitesOnly.get()).toBe(false);
    });
  });

  it("revokes access for people the owner did not add directly when ownerInvitesOnly is set",
      async () => {
    let stub = env.TEST_OVERSEER.getByName("owner-invites-only-revokes-indirect");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = getImpl(instance);
      seedGatekeeper(impl, 1);
      impl.storage.shareKeys.put({ id: "k1", created: new Date(), createdBy: OWNER, role: "build" });
      impl.storage.collaborators.put({
        profile: { id: "bob", name: "Bob" },
        addedBy: [{ type: "user", sharer: OWNER, created: new Date(), role: "build" }],
      });
      impl.storage.collaborators.put({
        profile: { id: "dave", name: "Dave" },
        addedBy: [{ type: "shareKey", keyId: "k1", created: new Date(), role: "build" }],
      });
      impl.storage.observers.put(
          { profileId: "bob", observerId: "obs-b", accountChoices: { 1: 10 } });
      impl.storage.observers.put(
          { profileId: "dave", observerId: "obs-d", accountChoices: { 1: 11 } });

      // Record the restart rather than aborting the DO under the test, and keep the best-effort
      // cleanup off the network.
      let restarts: string[] = [];
      impl.scheduleAccessRestart = async (reason: string) => { restarts.push(reason); };
      impl.getGatekeeperFacet = () => ({ removeObserver: async () => {} });
      impl.refreshAffectedCollaboratorListings = async () => {};

      await impl.authorizeObservation(1, {
        title: "Read a thing", description: "d", ownerInvitesOnly: true,
      }, { from: "user" });

      // Dave joined through a link, so he loses access: the workspace restarts and his observer
      // record is torn down. Bob, whom the owner added directly, keeps both.
      expect(restarts).toHaveLength(1);
      let sharing = await impl.getSharingManager();
      expect(sharing.getEffectiveRole("dave")).toBeUndefined();
      expect(sharing.getEffectiveRole("bob")).toBe("build");
      expect(impl.storage.observers.get("dave")).toBeUndefined();
      expect(impl.storage.observers.get("bob")).toBeDefined();

      // Setting the flag again changes nothing, so it restarts nothing.
      await impl.authorizeObservation(1, {
        title: "Read a thing", description: "d", ownerInvitesOnly: true,
      }, { from: "user" });
      expect(restarts).toHaveLength(1);
    });
  });

  it("does not restart when only direct collaborators are present", async () => {
    let stub = env.TEST_OVERSEER.getByName("owner-invites-only-direct-only");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = getImpl(instance);
      seedGatekeeper(impl, 1);
      impl.storage.collaborators.put({
        profile: { id: "bob", name: "Bob" },
        addedBy: [{ type: "user", sharer: OWNER, created: new Date(), role: "use" }],
      });

      let restarts: string[] = [];
      impl.scheduleAccessRestart = async (reason: string) => { restarts.push(reason); };

      await impl.authorizeObservation(1, {
        title: "Read a thing", description: "d", ownerInvitesOnly: true,
      }, { from: "user" });

      expect(impl.storage.ownerInvitesOnly.get()).toBe(true);
      expect(restarts).toEqual([]);
      expect((await impl.getSharingManager()).getEffectiveRole("bob")).toBe("use");
    });
  });
});
