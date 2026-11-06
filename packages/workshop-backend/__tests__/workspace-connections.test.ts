import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { Gatekeeper } from "@gadgets/workshop-shared/gatekeeper";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { GatekeeperRecord } from "../src/storage-schema/overseer-storage.js";
import { openFakeOverseer } from "./fixtures.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

type Impl = OverseerDurableObject["impl"];
const fakeClass = {} as GatekeeperRecord["class"];
let counter = 0;

async function withImpl(run: (impl: Impl) => Promise<void>): Promise<void> {
  const stub = env.TEST_OVERSEER.getByName(`workspace-connections-${++counter}`);
  await runInDurableObject(stub, instance => run(instance["impl"]));
}

function openClient(impl: Impl) {
  return openFakeOverseer({ gatekeepers: impl.storage.gatekeepers }, { impl: {
    gatekeeperUsable: (id: number) => impl.gatekeeperUsable(id),
    creationPending: (id: number) => impl.creationPending(id),
    getGatekeeperFacet: (id: number) => impl.getGatekeeperFacet(id),
    removeGatekeeper: (id: number) => impl.removeGatekeeper(id),
  } });
}

describe("Overseer.listConnections", () => {
  it("lists orphaned, legacy, built-in, model, spawner and pending connections without facet RPCs",
      () => withImpl(async impl => {
    const facet = vi.fn(() => { throw new Error("Inventory must not call gatekeeper facets"); });
    impl.getGatekeeperFacet = facet;
    const records: GatekeeperRecord[] = [
      { id: 1, class: fakeClass, resourceTitle: "Legacy", resourceUrl: "https://legacy.example" },
      { id: 2, class: fakeClass, resourceTitle: "Orphan", resourceUrl: "https://example.com/2",
        creationSpec: { type: "gatekeeper", vendorId: "Example",
          resourceUrl: "https://example.com/2", typeUrlPattern: "https://example.com/:id" } },
      { id: 3, class: fakeClass, resourceTitle: "Model",
        creationSpec: { type: "aiModel", modelId: "model", provider: "example", modelName: "model" } },
      { id: 4, class: fakeClass, resourceTitle: "Spawner",
        creationSpec: { type: "agentSpawner", config: { displayName: "Spawner", modelId: null } } },
      { id: 5, class: fakeClass, resourceTitle: "Built-in",
        creationSpec: { type: "ambient", vendorId: "context", accountId: 1 } },
      { id: 6, class: fakeClass, resourceTitle: "Pending",
        creationSpec: { type: "gatekeeper", vendorId: "example", typeUrlPattern: "example://new/*" } },
      { id: 7, class: fakeClass, resourceTitle: "After pending" },
    ];
    for (const record of records) impl.storage.gatekeepers.put(record);
    impl.storage.actions.put({
      id: 1, gatekeeperId: 6, type: "action", action: "create", state: "pending",
      caller: { from: "agent", chatId: 1 }, createdAt: new Date(0),
      description: { title: "Create", description: "Create", implementsRevert: false },
    });
    const client = await openClient(impl);

    expect(await client.listConnections()).toEqual([
      { target: 1, resourceTitle: "Legacy", resourceUrl: "https://legacy.example",
        alwaysAvailable: false, awaitingApproval: false },
      { target: 2, resourceTitle: "Orphan", resourceUrl: "https://example.com/2", vendorId: "Example",
        typeUrlPattern: "https://example.com/:id", alwaysAvailable: false, awaitingApproval: false },
      { target: 3, resourceTitle: "Model", alwaysAvailable: false, awaitingApproval: false },
      { target: 4, resourceTitle: "Spawner", alwaysAvailable: false, awaitingApproval: false },
      { target: 5, resourceTitle: "Built-in", vendorId: "context",
        alwaysAvailable: true, awaitingApproval: false },
      { target: 6, resourceTitle: "Pending", vendorId: "example", typeUrlPattern: "example://new/*",
        alwaysAvailable: false, awaitingApproval: true },
      { target: 7, resourceTitle: "After pending", alwaysAvailable: false, awaitingApproval: false },
    ]);
    expect(facet).not.toHaveBeenCalled();
  }));

  it("omits connections removed through the existing GatekeeperClient.remove capability",
      () => withImpl(async impl => {
    impl.storage.gatekeepers.put({ id: 1, class: fakeClass, resourceTitle: "Remove me" });
    const client = await openClient(impl);
    // A facet is needed to mint the existing removal capability, not to enumerate inventory.
    impl.getGatekeeperFacet = async () => ({}) as Fetcher<Gatekeeper<unknown>>;
    const connection = await client.getGatekeeperById(1);
    expect((await client.listConnections()).map(info => info.target)).toEqual([1]);

    await connection.remove();

    expect(await client.listConnections()).toEqual([]);
  }));
});
