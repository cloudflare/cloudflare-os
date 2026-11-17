// submitAction refusals: under the restricted-data latch, a push that sends what its approver
// could not read; and any action on a removed connection.
// Runs against a real OverseerDurableObject (the TEST_OVERSEER binding); records are seeded
// directly through the impl.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { ActionDescription } from "@gadgets/workshop-shared/gatekeeper";
import { encodeGitTree, encodeLooseObject, gitObjectOid } from "../src/git-codec";

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

const POKE: ActionDescription = {
  title: "Poke the thing",
  description: "The test poked the thing.",
  // What a real gatekeeper asserts when its text shows everything the action will send.
  descriptionIsComplete: true,
  implementsRevert: false,
  autoApprovable: false,
  actionKind: { tag: "poke", label: "Pokes" },
};

function actionStates(impl: any): Array<{ gatekeeperId: number; state: string }> {
  return [...impl.storage.actions.list()]
      .filter((rec: any) => rec.type === "action")
      .map((rec: any) => ({ gatekeeperId: rec.gatekeeperId, state: rec.state }));
}

describe("submitAction refusals", () => {
  it("refuses a push that sends a file that is not text while restricted, even one claiming " +
      "a complete description", async () => {
    let stub = env.TEST_OVERSEER.getByName("restricted-actions-push");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = getImpl(instance);
      seedGatekeeper(impl, 1);
      // A commit the connection's remote has and, on it, a local commit that adds an image.
      let commit = (tree: string, parents: string[]) => new TextEncoder().encode(
          `tree ${tree}\n${parents.map(parent => `parent ${parent}\n`).join("")}` +
          "author Test <test@example.com> 1700000000 +0000\n" +
          "committer Test <test@example.com> 1700000000 +0000\n\nchange\n");
      let store = (type: "blob" | "tree" | "commit", payload: Uint8Array) => {
        let oid = gitObjectOid(type, payload);
        impl.storage.gitObjects.put({ oid, data: encodeLooseObject(type, payload) });
        return oid;
      };
      let empty = await impl.gitCache.putFromGatekeeper(1, "tree", new Uint8Array(0));
      let base = await impl.gitCache.putFromGatekeeper(1, "commit", commit(empty, []));
      let image = store("blob", Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0));
      let tree = store("tree", encodeGitTree([{ mode: "100644", name: "logo.png", oid: image }]));
      let head = store("commit", commit(tree, [base]));
      seedRestrictedObservation(impl, 1, 100);
      let nextActionId = impl.storage.nextActionId.get();

      // What a push sends is its commits, whatever its description claims to show.
      await expect(impl.submitAction(1, 0, { ...POKE, pushedCommits: [head] }, CALLER))
          .rejects.toThrow(`"logo.png" in commit ${head} is not UTF-8 text`);
      expect(actionStates(impl)).toEqual([]);
      expect([...impl.storage.gitObjectMetadata.byPendingPushAction.list()]).toEqual([]);
      expect(impl.storage.nextActionId.get()).toBe(nextActionId);
    });
  });

  it("refuses an action on a removed connection, writing no record", async () => {
    let stub = env.TEST_OVERSEER.getByName("restricted-actions-removed");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      let impl = getImpl(instance);
      seedGatekeeper(impl, 1);
      impl.storage.gatekeepers.delete(1);
      let nextActionId = impl.storage.nextActionId.get();

      await expect(impl.submitAction(1, 0, POKE, CALLER))
          .rejects.toThrow(/has been removed from this workspace/i);
      expect(actionStates(impl)).toEqual([]);
      expect(impl.storage.nextActionId.get()).toBe(nextActionId);
    });
  });
});
