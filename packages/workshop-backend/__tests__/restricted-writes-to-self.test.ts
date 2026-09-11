// submitAction's writes-to-self carve-out: a latched workspace may act only on the connections
// that produced its restricted data, never auto-approved, and never on a removed connection.
// Runs against a real OverseerDurableObject (the TEST_OVERSEER binding); records are seeded
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

// A restricted observation attributed to `gatekeeperId` plus the producer and the latch, as
// authorizeObservation writes them.
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
  impl.storage.restrictedProducerIds.put(
      [...impl.storage.restrictedProducerIds.get(), gatekeeperId]);
  impl.storage.containsRestrictedData.put(true);
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

describe("the recorded producer set", () => {
  it("records each producer beside the latch, once", async () => {
    let stub = env.TEST_OVERSEER.getByName("producers-recorded");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = getImpl(instance);
      seedGatekeeper(impl, 1);
      seedGatekeeper(impl, 2);
      let restricted = { title: "Read", description: "Read.", containsRestrictedData: true };
      expect(impl.storage.restrictedProducerIds.get()).toEqual([]);

      await impl.authorizeObservation(1, restricted, CALLER);
      expect(impl.storage.restrictedProducerIds.get()).toEqual([1]);
      await impl.authorizeObservation(2, restricted, CALLER);
      await impl.authorizeObservation(1, restricted, CALLER);
      expect(impl.storage.restrictedProducerIds.get()).toEqual([1, 2]);
    });
  });
});

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

      // Not auto-approved even by an explicit drain: the action stays a manual gate.
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
      // The producer is removed but still in restrictedProducerIds; membership alone must not
      // admit a write nobody could approve or reject.
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

  it("refuses everything when the latch is set with no recorded producer", async () => {
    let stub = env.TEST_OVERSEER.getByName("writes-to-self-empty-producers");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = getImpl(instance);
      seedGatekeeper(impl, 1);
      // Should be impossible (producer and latch are written together), so fail closed.
      impl.storage.containsRestrictedData.put(true);

      await expect(impl.submitAction(1, 0, pokeDescription(), CALLER))
          .rejects.toThrow(/only perform actions on those same connections/i);
      expect(actionStates(impl)).toEqual([]);
    });
  });
});
