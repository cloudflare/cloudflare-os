import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { WorkpieceId } from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { GadgetExports } from "../src/exports-binding";
import type {
  GatekeeperCaller, GatekeeperRecord, OverseerStorage,
} from "../src/storage-schema/overseer-storage";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

// Exercises the `exports` session behind gadget bindings (exports-session.ts). A real export
// through it is exercised end to end in the integration suite (workshop-changes.test.ts).

// The slice of the (unexported) OverseerImpl these tests drive.
type Impl = {
  storage: OverseerStorage;
  startGatekeeperSession(target: unknown, caller: GatekeeperCaller): Promise<GadgetExports>;
  describeBinding(envName: string, id: WorkpieceId): Promise<string>;
};

const CHAT_ID = 1;
const AGENT: GatekeeperCaller = { from: "agent", chatId: CHAT_ID };

let doCounter = 0;
async function withImpl(fn: (impl: Impl) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`exports-binding-${++doCounter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    // `impl` is private to the durable object and OverseerImpl is unexported; these tests reach
    // into it deliberately, through the slice they drive.
    const instanceWithImpl = instance as unknown as { impl: Impl };
    let impl = instanceWithImpl.impl;
    impl.storage.title.put("My Workspace");
    impl.storage.chatMeta.put(
        { id: CHAT_ID, title: "Chat", started: new Date(0), lastActive: new Date(0) });
    // Never instantiated: these tests only route to and describe the gatekeeper.
    const unusedClass = {} as unknown as GatekeeperRecord["class"];
    impl.storage.gatekeepers.put({ id: 5, resourceTitle: "DB", class: unusedClass });
    impl.storage.gadgets.put({
      type: "gadget", id: 100, title: "App", created: new Date(0), bindingName: "APP",
      bindings: { DB: { target: 5 } },
    });
    await fn(impl);
  });
}

describe("gadget bindings in the agent's env", () => {

  it("export only the agent's chat, and only to the agent", () => withImpl(async impl => {
    // A gadget with no server code offers nothing to export.
    let exports = await impl.startGatekeeperSession({ type: "exports", id: 100 }, AGENT);
    expect(await exports.getFormats()).toEqual([]);

    // Refused as the session opens (the loopback turns this into the call's rejection).
    expect(() => impl.startGatekeeperSession(
        { type: "exports", id: 100 }, { from: "gadget", gadgetId: 100 }))
        .toThrow("only available to the agent's executeCode");
  }));

  it("are described with both properties", () => withImpl(async impl => {
    let description = await impl.describeBinding("env.APP", 100);
    expect(description).toContain("`env.APP.rpc` is an RPC stub");
    expect(description).toContain("export interface GadgetExports");
    expect(description).not.toContain("BEGIN AGENT API");
  }));
});
