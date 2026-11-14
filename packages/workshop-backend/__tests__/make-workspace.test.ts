import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Overseer, WorkspaceMetadata } from "@gadgets/workshop-shared/api";
import type { UserDurableObject } from "../src/user.js";
import type { OverseerDurableObject } from "../src/overseer.js";
import { OVERSEER_STORAGE_VERSION } from "../src/storage-schema/overseer-migrations.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

// A chat started outside any workspace lives in a workspace of its own, which the user can later
// make a named one (Overseer.makeWorkspace()).
describe("making a chat's workspace a named one", () => {
  it("names it and marks it, in the workspace and in the owner's list, and tells whoever watches", async () => {
    const user = env.TEST_USER.getByName(crypto.randomUUID());
    const workspace = env.TEST_OVERSEER.getByName(crypto.randomUUID());
    const workspaceId = workspace.id.toString();
    // As a chat started from Home makes it: unnamed, titled for its chat.
    await user.newWorkspace(workspaceId, "Meeting brief");
    expect((await user.getWorkspace(workspaceId))?.kind).toBeUndefined();

    await runInDurableObject(workspace, async (instance: OverseerDurableObject) => {
      const impl = instance.impl;
      impl.storage.version.put(OVERSEER_STORAGE_VERSION);
      impl.storage.title.put("Meeting brief");
      impl.storage.ownerId.put(user.id.toString());
      impl.ownerId = user.id.toString();
      // Read from admin settings this test has none of.
      impl.sharedViewsAvailable = async () => false;
      impl.ensureAmbientCapsules = async () => {};

      using notifyClosed = new NativeRpcStub<() => void>(() => {});
      using client: Overseer = await instance.open(user.id.toString(), "owner-profile", notifyClosed) as never;
      const seen: WorkspaceMetadata[] = [];
      using watching = new NativeRpcStub((metadata: WorkspaceMetadata) => void seen.push(structuredClone(metadata)));
      using _lease = await client.subscribeToMetadata(watching as never);

      await client.makeWorkspace("Q3 planning");

      expect(await client.getMetadata()).toMatchObject({title: "Q3 planning", kind: "workspace"});
      expect(seen.at(-1)).toMatchObject({title: "Q3 planning", kind: "workspace"});
    });

    expect(await user.getWorkspace(workspaceId)).toMatchObject({title: "Q3 planning", kind: "workspace", lastActive: expect.any(Date)});
  });
});
