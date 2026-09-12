// submitAction under the restricted-data latch: every action pends for manual approval, on any
// connection, and is never auto-approved; an action on a removed connection is refused outright.
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
const USER = { type: "user", id: "alice", name: "Alice" } as const;

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
// writes them.
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

describe("submitAction under the restricted-data latch", () => {
  it("pends a latched action on any connection, never auto-approved", async () => {
    let stub = env.TEST_OVERSEER.getByName("restricted-actions-pend");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = getImpl(instance);
      seedGatekeeper(impl, 1);
      seedGatekeeper(impl, 2);
      seedRestrictedObservation(impl, 1, 100);
      // A rule that would auto-approve the action on connection 2 were the workspace not latched.
      impl.storage.autoApproveTags.put({
        gatekeeperId: 2,
        actionKind: { tag: "poke", label: "Pokes" },
        enabledBy: USER,
      });

      await impl.submitAction(2, 0, pokeDescription(/* autoApprovable */ true), CALLER);
      await impl.submitAction(1, 0, pokeDescription(), CALLER);
      expect(actionStates(impl)).toEqual([
        { gatekeeperId: 2, state: "pending" },
        { gatekeeperId: 1, state: "pending" },
      ]);

      // Not auto-approved even by an explicit drain: every action stays a manual gate.
      await impl.drainAutoApprovals(2);
      expect(actionStates(impl)).toEqual([
        { gatekeeperId: 2, state: "pending" },
        { gatekeeperId: 1, state: "pending" },
      ]);
    });
  });

  it("applies a pre-latch pending action once approved", async () => {
    let stub = env.TEST_OVERSEER.getByName("restricted-actions-pre-latch");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = getImpl(instance);
      seedGatekeeper(impl, 1);
      seedGatekeeper(impl, 2);

      // Queued while unlatched, on a connection the restricted data never came through.
      await impl.submitAction(2, 0, pokeDescription(), CALLER);
      seedRestrictedObservation(impl, 1, 100);

      let record = [...impl.storage.actions.list()].find((rec: any) => rec.type === "action");
      impl.getGatekeeperFacet = () => ({ async applyAction() {} });
      await impl.applyPendingAction(record, USER, false);
      expect(actionStates(impl)).toEqual([{ gatekeeperId: 2, state: "approved" }]);
    });
  });

  it("refuses an action on a removed connection, writing no record", async () => {
    let stub = env.TEST_OVERSEER.getByName("restricted-actions-removed");
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
});
