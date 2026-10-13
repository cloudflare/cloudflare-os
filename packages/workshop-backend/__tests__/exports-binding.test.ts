import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { AiChatMessage, WorkpieceId } from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { Exports } from "../src/exports-binding";
import type { UserDurableObject } from "../src/user";
import type {
  ChatBindingEntry, GatekeeperCaller, OverseerStorage,
} from "../src/storage-schema/overseer-storage";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

// Exercises the env.EXPORTS binding (exports-session.ts): which gadgets it can name, and that its
// name is reserved in chat scopes like env.GIT's. A real export through it is exercised end to end
// in the integration suite (workshop-changes.test.ts).

// The slice of the (unexported) OverseerImpl these tests drive.
type Impl = {
  storage: OverseerStorage;
  ownerId?: string;
  users: DurableObjectNamespace<UserDurableObject>;
  makeBindingLoopback(target: unknown, caller: GatekeeperCaller): unknown;
  getEnvForAgent(chatId: number, bindings: Record<string, ChatBindingEntry>,
                 executionId: string): Record<string, unknown>;
  startGatekeeperSession(target: unknown, caller: GatekeeperCaller): Promise<Exports>;
  prepareChatBindings(chatId: number, chatMessages: AiChatMessage[]): Promise<unknown>;
  getChatAgentContext(chatId: number): { bindings?: Record<string, WorkpieceId> };
  chatScopeNames(chatId: number, chatMessages?: Iterable<AiChatMessage>): Set<string>;
};

const CHAT_ID = 1;
const AGENT: GatekeeperCaller = { from: "agent", chatId: CHAT_ID };

let doCounter = 0;
async function withImpl(fn: (impl: Impl, instance: OverseerDurableObject) => Promise<void>)
    : Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`exports-binding-${++doCounter}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    // `impl` is private to the durable object and OverseerImpl is unexported; these tests reach
    // into it deliberately, through the slice they drive.
    const instanceWithImpl = instance as unknown as { impl: Impl };
    let impl = instanceWithImpl.impl;
    impl.storage.title.put("My Workspace");
    impl.storage.chatMeta.put(
        { id: CHAT_ID, title: "Chat", started: new Date(0), lastActive: new Date(0) });
    await fn(impl, instance);
  });
}

function seedGadget(impl: Impl, id: WorkpieceId, bindingName = `G${id}`): void {
  impl.storage.gadgets.put(
      { type: "gadget", id, title: "G", created: new Date(0), bindingName, bindings: {} });
}

describe("env.EXPORTS", () => {
  it("can name exactly the gadget bindings of the env it is in", () => withImpl(async impl => {
    // Observe the loopback targets rather than opaque service stubs.
    impl.makeBindingLoopback = (target: unknown) => target;
    seedGadget(impl, 100);
    seedGadget(impl, 101);
    let agentEnv = impl.getEnvForAgent(CHAT_ID, {
      APP: { type: "workpiece", id: 100 },
      GONE: { type: "workpiece", id: 999 },
    }, "exec-1");
    expect(agentEnv.EXPORTS).toEqual({ type: "exports", gadgets: { APP: 100 } });

    // A gadget in the workspace but not in the env is out of reach, by its name or any other.
    let exports = await impl.startGatekeeperSession({ type: "exports", gadgets: { APP: 100 } }, AGENT);
    for (let name of ["G101", "GONE", "constructor", "__proto__"]) {
      await expect(exports.getFormats(name)).rejects.toThrow(`There is no gadget named "${name}"`);
      await expect(exports.export(name, "html")).rejects.toThrow(`There is no gadget named "${name}"`);
    }
    // One with no server code offers nothing to export.
    expect(await exports.getFormats("APP")).toEqual([]);
  }));

  it("is shadowed by a chat binding of the same name", () => withImpl(async impl => {
    impl.makeBindingLoopback = (target: unknown) => target;
    seedGadget(impl, 100);
    expect(impl.getEnvForAgent(CHAT_ID, { EXPORTS: { type: "workpiece", id: 100 } }, "exec-1")
        .EXPORTS).toEqual({ type: "gadget", id: 100 });
  }));

  it("is served only to the agent", () => withImpl(async impl => {
    // Refused as the session opens (the loopback turns this into the call's rejection).
    expect(() => impl.startGatekeeperSession(
        { type: "exports", gadgets: {} }, { from: "gadget", gadgetId: 100 }))
        .toThrow("only available to the agent's executeCode");
  }));

  it("reserves its name in new chat seeds, renaming a legacy entry", () => withImpl(async impl => {
    seedGadget(impl, 100, "EXPORTS");
    expect(impl.chatScopeNames(CHAT_ID)).toContain("EXPORTS_2");
    await impl.prepareChatBindings(CHAT_ID, []);
    expect(impl.getChatAgentContext(CHAT_ID).bindings).toEqual({ EXPORTS_2: 100 });
  }));

  it("keeps a gadget's recorded name when renaming a legacy seed", () => withImpl(async impl => {
    seedGadget(impl, 100, "EXPORTS");
    impl.storage.gadgets.put({
      type: "gadget", id: 101, title: "New", created: new Date(0), bindingName: "EXPORTS_2",
      bindings: {}, pending: { chatId: CHAT_ID },
    });
    const creation: AiChatMessage = {
      chatId: CHAT_ID, sequence: 0, timestamp: new Date(0),
      author: { type: "user", id: "owner@example.com", name: "Owner" }, type: "changes",
      createdGadgets: [{ gadgetId: 101, title: "New", bindingName: "EXPORTS_2" }],
    };
    impl.storage.chats.put(creation);
    expect(impl.chatScopeNames(CHAT_ID)).toContain("EXPORTS_3");
    await impl.prepareChatBindings(CHAT_ID, [creation]);
    expect(impl.getChatAgentContext(CHAT_ID).bindings).toEqual({ EXPORTS_3: 100 });
  }));

  it("preserves a legacy shadow in a previously frozen chat seed", () => withImpl(async impl => {
    seedGadget(impl, 100, "EXPORTS");
    impl.storage.chatContext.put({ chatId: CHAT_ID, bindings: { EXPORTS: 100 } });
    await impl.prepareChatBindings(CHAT_ID, []);
    expect(impl.getChatAgentContext(CHAT_ID).bindings).toEqual({ EXPORTS: 100 });
  }));

  it("remaps an old spawner's reserved names before freezing its new chat", () =>
      withImpl(async (impl, instance) => {
    impl.ownerId = impl.users.newUniqueId().toString();
    seedGadget(impl, 100);
    seedGadget(impl, 101);
    seedGadget(impl, 102);
    await instance.spawnAgent("Spawned", "Export the configured app", {
      displayName: "Legacy spawner", modelId: null, env: { EXPORTS: 100, EXPORTS_2: 101 },
    });
    const spawned = [...impl.storage.chatMeta.list()].find(chat => chat.spawnerName !== undefined)!;
    await impl.prepareChatBindings(spawned.id, []);
    expect(impl.getChatAgentContext(spawned.id).bindings)
        .toEqual({ EXPORTS_2: 101, EXPORTS_3: 100 });
  }));
});
