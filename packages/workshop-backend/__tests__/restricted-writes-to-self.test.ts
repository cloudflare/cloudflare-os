// submitAction's writes-to-self carve-out: a latched workspace may still submit actions targeting
// the connections that produced its restricted data (sending the data back where it came from
// reveals nothing new), while any other target is refused before a record is written. Latched
// actions are never auto-approved -- even a write-to-self with a matching rule must pend for a
// human (see autoApprovalRule). An action naming a removed connection is refused outright,
// latched or not: a pending action on a dead connection could never be approved or rejected.
//
// Runs against a real OverseerDurableObject (the TEST_OVERSEER binding, like
// restricted-producer-removal.test.ts) so submitAction reads real storage; records are seeded
// directly through the impl.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { ActionDescription } from "@gadgets/workshop-shared/gatekeeper";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const CALLER = { from: "user" } as const;

function getImpl(instance: OverseerDurableObject): any {
  return (instance as unknown as { impl: any }).impl;
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

// A restricted observation attributed to `gatekeeperId`, making it a producer
// (restrictedProducerIds scans the action log for exactly these), plus the latch the same
// authorizeObservation write would set.
function seedRestrictedObservation(impl: any, gatekeeperId: number, actionId: number): void {
  impl.storage.actions.put({
    id: actionId,
    gatekeeperId,
    caller: CALLER,
    createdAt: new Date(),
    state: "approved",
    type: "observation",
    description: {
      title: "Read a thing",
      description: "The test read a thing.",
      containsRestrictedData: true,
    },
  });
  impl.storage.nextActionId.put(actionId + 1);
  impl.storage.prohibitAllSharing.put(true);
}

function pokeDescription(autoApprovable = false): ActionDescription {
  return {
    title: "Poke the thing",
    description: "The test poked the thing.",
    implementsRevert: false,
    actionKind: { tag: "poke", label: "Pokes" },
    ...(autoApprovable ? { autoApprovable: true } : {}),
  };
}

function actionStates(impl: any): Array<{ gatekeeperId: number; state: string }> {
  return [...impl.storage.actions.list()]
      .filter((rec: any) => rec.type === "action")
      .map((rec: any) => ({ gatekeeperId: rec.gatekeeperId, state: rec.state }));
}

describe("submitAction under the restricted-data latch", () => {
  it("pends an unlatched action normally", async () => {
    let stub = env.TEST_OVERSEER.getByName("writes-to-self-unlatched");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = getImpl(instance);
      seedGatekeeper(impl, 1);

      await impl.submitAction(1, 0, pokeDescription(), CALLER);
      expect(actionStates(impl)).toEqual([{ gatekeeperId: 1, state: "pending" }]);
    });
  });

  it("pends a latched write-to-self, and never auto-approves it", async () => {
    let stub = env.TEST_OVERSEER.getByName("writes-to-self-producer");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = getImpl(instance);
      seedGatekeeper(impl, 1);
      seedRestrictedObservation(impl, 1, 100);
      // A rule that would auto-approve this exact action were the workspace not latched.
      impl.storage.autoApproveTags.put({
        gatekeeperId: 1,
        actionKind: { tag: "poke", label: "Pokes" },
        enabledBy: { type: "user", id: "alice", name: "Alice" },
      });

      await impl.submitAction(1, 0, pokeDescription(/* autoApprovable */ true), CALLER);
      expect(actionStates(impl)).toEqual([{ gatekeeperId: 1, state: "pending" }]);

      // Not auto-approved: the submit never schedules a drain while latched, and even an explicit
      // drain refuses (autoApprovalRule) -- the action stays a manual gate.
      await impl.drainAutoApprovals(1);
      expect(actionStates(impl)).toEqual([{ gatekeeperId: 1, state: "pending" }]);
    });
  });

  it("refuses a latched action on a non-producer, writing no record", async () => {
    let stub = env.TEST_OVERSEER.getByName("writes-to-self-non-producer");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = getImpl(instance);
      seedGatekeeper(impl, 1);
      seedGatekeeper(impl, 2);
      seedRestrictedObservation(impl, 1, 100);
      let nextActionId = impl.storage.nextActionId.get();

      await expect(impl.submitAction(2, 0, pokeDescription(), CALLER))
          .rejects.toThrow(/only perform actions on those same connections/i);
      expect(actionStates(impl)).toEqual([]);
      expect(impl.storage.nextActionId.get()).toBe(nextActionId);
    });
  });

  it("refuses a latched action on a removed producer, writing no record", async () => {
    let stub = env.TEST_OVERSEER.getByName("writes-to-self-removed-producer");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = getImpl(instance);
      seedGatekeeper(impl, 1);
      seedRestrictedObservation(impl, 1, 100);
      // The producer is removed, but restrictedProducerIds still contains it (it scans the
      // never-deleted action log). Set membership must not admit the write: a pending action on a
      // removed connection could never be approved or rejected.
      impl.storage.gatekeepers.delete(1);
      let nextActionId = impl.storage.nextActionId.get();

      await expect(impl.submitAction(1, 0, pokeDescription(), CALLER))
          .rejects.toThrow(/has been removed from this workspace/i);
      expect(actionStates(impl)).toEqual([]);
      expect(impl.storage.nextActionId.get()).toBe(nextActionId);
    });
  });

  it("refuses an unlatched action on a removed connection, writing no record", async () => {
    let stub = env.TEST_OVERSEER.getByName("writes-to-self-removed-unlatched");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = getImpl(instance);
      seedGatekeeper(impl, 1);
      impl.storage.gatekeepers.delete(1);
      let nextActionId = impl.storage.nextActionId.get();

      await expect(impl.submitAction(1, 0, pokeDescription(), CALLER))
          .rejects.toThrow(/has been removed from this workspace/i);
      expect(actionStates(impl)).toEqual([]);
      expect(impl.storage.nextActionId.get()).toBe(nextActionId);
    });
  });

  it("refuses everything when the latch is set with no derivable producer", async () => {
    let stub = env.TEST_OVERSEER.getByName("writes-to-self-empty-producers");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = getImpl(instance);
      seedGatekeeper(impl, 1);
      // Should be impossible (the latch and its action record are written together), so fail
      // closed: with no producer to match, every target is refused.
      impl.storage.prohibitAllSharing.put(true);

      await expect(impl.submitAction(1, 0, pokeDescription(), CALLER))
          .rejects.toThrow(/only perform actions on those same connections/i);
      expect(actionStates(impl)).toEqual([]);
    });
  });
});
