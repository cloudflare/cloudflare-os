// Overseer.getAmbientGatekeeper(): the workspace's record for one of the owner's auto-provisioned
// accounts, found by vendor, so that setup can bind it into a gadget (an agent gets it without).

import { describe, expect, it } from "vitest";
import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { Overseer } from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

let doCounter = 0;
async function withClient(fn: (impl: any, client: Overseer, reconciles: () => number) => Promise<void>) {
  let stub = env.TEST_OVERSEER.getByName(`ambient-gatekeeper-${++doCounter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    let ownerId = impl.users.newUniqueId().toString();
    impl.ownerId = ownerId;
    let reconciles = 0;
    impl.ensureAmbientCapsules = async () => { reconciles++; };
    impl.markOutputsDirty = () => {};
    impl.getGatekeeperFacet = async () => ({});
    using notifyClosed = new NativeRpcStub<() => void>(() => {});
    using client = await instance.open(ownerId, "owner-profile", notifyClosed);
    await fn(impl, client, () => reconciles);
  });
}

describe("getAmbientGatekeeper", () => {
  it("finds the ambient record by vendor, ignoring other gatekeepers", () => withClient(async (impl, client) => {
    impl.storage.gatekeepers.put({ id: 4, resourceTitle: "Repo", class: {} as any });
    impl.storage.gatekeepers.put({ id: 5, resourceTitle: "Skills", class: {} as any,
                                   creationSpec: { type: "ambient", vendorId: "context", accountId: 1 } });
    impl.storage.gatekeepers.put({ id: 6, resourceTitle: "Scheduled Tasks", class: {} as any,
                                   creationSpec: { type: "ambient", vendorId: "scheduler", accountId: 2 } });
    using gatekeeper = await client.getAmbientGatekeeper("scheduler");
    expect(await gatekeeper!.getId()).toBe(6);
  }));

  it("reconciles again for an account provisioned since the workspace opened, else answers null",
      () => withClient(async (impl, client, reconciles) => {
    let before = reconciles();
    impl.ensureAmbientCapsules = async () => {
      impl.storage.gatekeepers.put({ id: 7, resourceTitle: "Scheduled Tasks", class: {} as any,
                                     creationSpec: { type: "ambient", vendorId: "scheduler", accountId: 3 } });
    };
    using gatekeeper = await client.getAmbientGatekeeper("scheduler");
    expect(await gatekeeper!.getId()).toBe(7);

    impl.ensureAmbientCapsules = async () => {};
    expect(await client.getAmbientGatekeeper("context")).toBeNull();
    expect(reconciles()).toBe(before);
  }));
});
