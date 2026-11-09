import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Overseer } from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { UserDurableObject } from "../src/user.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

// The Workshop's Agents tab: listing a workspace's agent spawners, and renaming one or changing
// its model.
describe("agent spawners", () => {
  it("lists a spawner with its access, and renames it for the agents it starts next", async () => {
    let user = env.TEST_USER.getByName(crypto.randomUUID());
    let workspace = env.TEST_OVERSEER.getByName(crypto.randomUUID());
    await user.newWorkspace(workspace.id.toString(), "Workspace");
    await runInDurableObject(workspace, async (instance: OverseerDurableObject) => {
      let impl = instance.impl;
      let ownerId = user.id.toString();
      impl.ownerId = ownerId;
      impl.storage.ownerId.put(ownerId);
      impl.ensureAmbientCapsules = async () => {};
      impl.markOutputsDirty = () => {};

      using notifyClosed = new NativeRpcStub<() => void>(() => {});
      using client: Overseer = await instance.open(ownerId, "owner-profile", notifyClosed) as never;
      using spawner = await client.newAgentSpawnerGatekeeper({displayName: "Triage", modelId: null, env: {}});
      let id = await spawner.getId();

      expect(await client.listAgentSpawners()).toEqual([
        {gatekeeperId: id, displayName: "Triage", modelId: null, gadgetIds: [], access: []},
      ]);

      await client.updateAgentSpawner(id, {displayName: "  Inbox triage ", modelId: null});
      expect((await client.listAgentSpawners())[0]).toMatchObject({displayName: "Inbox triage"});
      expect(impl.storage.gatekeepers.get(id)?.resourceTitle).toBe("Inbox triage");

      await expect(client.updateAgentSpawner(id, {displayName: " ", modelId: null}))
          .rejects.toThrow(/needs a name/);
      await expect(client.updateAgentSpawner(id + 100, {displayName: "x", modelId: null}))
          .rejects.toThrow(/No such agent/);
    });
  });
});
