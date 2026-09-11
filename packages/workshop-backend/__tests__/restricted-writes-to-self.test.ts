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

// A restricted observation attributed to `gatekeeperId` plus the latch, as authorizeObservation
// writes them on code that records no producers (so the set is reconciled from the log).
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
      expect(impl.storage.restrictedProducerIds.get()).toBeNull();

      await impl.authorizeObservation(1, restricted, CALLER);
      expect(impl.storage.restrictedProducerIds.get()).toEqual({ ids: [1], through: 0 });
      await impl.authorizeObservation(2, restricted, CALLER);
      await impl.authorizeObservation(1, restricted, CALLER);
      expect(impl.storage.restrictedProducerIds.get()).toEqual({ ids: [1, 2], through: 0 });
      expect(impl.isRestrictedProducer(1)).toBe(true);
      expect(impl.isRestrictedProducer(2)).toBe(true);
      // A miss reconciles from the log: the watermark advances, the set is unchanged.
      expect(impl.isRestrictedProducer(3)).toBe(false);
      expect(impl.storage.restrictedProducerIds.get()).toEqual({ ids: [1, 2], through: 3 });
    });
  });

  it("backfills from the action log on a workspace latched before the set was recorded", async () => {
    let stub = env.TEST_OVERSEER.getByName("producers-backfilled");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = getImpl(instance);
      seedGatekeeper(impl, 1);
      seedGatekeeper(impl, 2);
      // Record and latch only, the way the log looked before producers were recorded.
      seedRestrictedObservation(impl, 1, 100);
      expect(impl.storage.restrictedProducerIds.get()).toBeNull();

      await impl.submitAction(1, 0, pokeDescription(), CALLER);
      expect(actionStates(impl)).toEqual([{ gatekeeperId: 1, state: "pending" }]);
      // The reconcile persisted what the scan found and its watermark; later hits skip the log.
      expect(impl.storage.restrictedProducerIds.get()).toEqual({ ids: [1], through: 101 });
      await expect(impl.submitAction(2, 0, pokeDescription(), CALLER))
          .rejects.toThrow(/only perform actions on those same connections/i);
    });
  });

  it("reconciles a producer the log records but the set omits (rollback)", async () => {
    let stub = env.TEST_OVERSEER.getByName("producers-rollback");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = getImpl(instance);
      seedGatekeeper(impl, 1);
      seedGatekeeper(impl, 2);
      seedGatekeeper(impl, 3);
      let restricted = { title: "Read", description: "Read.", containsRestrictedData: true };
      await impl.authorizeObservation(1, restricted, CALLER);
      // Then a rollback to code that latches without recording the producer read through 2.
      seedRestrictedObservation(impl, 2, 100);
      expect(impl.storage.restrictedProducerIds.get()).toEqual({ ids: [1], through: 0 });

      // The miss on 2 reconciles from the watermark and finds it, so the write is not refused.
      await impl.submitAction(2, 0, pokeDescription(), CALLER);
      expect(actionStates(impl)).toEqual([{ gatekeeperId: 2, state: "pending" }]);
      expect(impl.storage.restrictedProducerIds.get()).toEqual({ ids: [1, 2], through: 101 });
      await expect(impl.submitAction(3, 0, pokeDescription(), CALLER))
          .rejects.toThrow(/only perform actions on those same connections/i);
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

  it("refuses everything when the latch is set with no derivable producer", async () => {
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
