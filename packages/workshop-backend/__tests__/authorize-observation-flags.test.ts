// authorizeObservation sets `containsRestrictedData` and `ownerInvitesOnly` one-way, and setting
// ownerInvitesOnly revokes access for people the owner did not add directly. (That a refused read
// latches neither flag is covered in observer-ledger.test.ts.)
//
// Runs against a real OverseerDurableObject (the TEST_OVERSEER binding).

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

describe("authorizeObservation's containsRestrictedData and ownerInvitesOnly flags", () => {
  it("sets ownerInvitesOnly only for observations that carry the flag", async () => {
    let stub = env.TEST_OVERSEER.getByName("owner-invites-only-flag");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = getImpl(instance);
      seedGatekeeper(impl, 1);

      // containsRestrictedData alone restricts the workspace but leaves share links working.
      await impl.authorizeObservation(1, {
        title: "Read a thing", description: "d", containsRestrictedData: true, subresources: [],
      }, { from: "user" });
      expect(impl.storage.containsRestrictedData.get()).toBe(true);
      expect(impl.storage.ownerInvitesOnly.get()).toBe(false);

      await impl.authorizeObservation(1, {
        title: "Read a thing", description: "d", containsRestrictedData: true,
        ownerInvitesOnly: true, subresources: [],
      }, { from: "user" });
      expect(impl.storage.ownerInvitesOnly.get()).toBe(true);

      // The flag is enforced by the memoized sharing manager.
      let sharing = await impl.getSharingManager();
      await expect(sharing.createShareLink({
        caller: { profileId: OWNER, isOwner: true }, grant: "workspace",
      })).rejects.toThrow(/Share links are disabled/);
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
      // listing cleanup off the network.
      let restarts: string[] = [];
      impl.scheduleAccessRestart = async (reason: string) => { restarts.push(reason); };
      impl.refreshAffectedCollaboratorListings = async () => {};

      await impl.authorizeObservation(1, {
        title: "Read a thing", description: "d", ownerInvitesOnly: true, subresources: [],
      }, { from: "user" });

      // Dave joined through a link, so he loses access: the workspace restarts and his observer
      // record is torn down. Bob, whom the owner added directly, keeps both.
      expect(restarts).toHaveLength(1);
      let sharing = await impl.getSharingManager();
      expect(sharing.getEffectiveAccess("dave")).toBeUndefined();
      expect(sharing.getEffectiveAccess("bob")).toEqual({ role: "build" });
      expect(impl.storage.observers.get("dave")).toBeUndefined();
      expect(impl.storage.observers.get("bob")).toBeDefined();

      // Setting the flag again changes nothing, so it restarts nothing.
      await impl.authorizeObservation(1, {
        title: "Read a thing", description: "d", ownerInvitesOnly: true, subresources: [],
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
        title: "Read a thing", description: "d", ownerInvitesOnly: true, subresources: [],
      }, { from: "user" });

      expect(impl.storage.ownerInvitesOnly.get()).toBe(true);
      expect(restarts).toEqual([]);
      expect((await impl.getSharingManager()).getEffectiveAccess("bob"))
          .toEqual({ role: "use", gadgetIds: "all" });
    });
  });
});
