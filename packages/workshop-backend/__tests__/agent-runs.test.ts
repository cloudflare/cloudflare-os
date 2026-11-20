// What a workspace records of its agents' runs: the spawner each run is of, which is its agent;
// the chat or gadget that started it; listChats() paged and filtered over the chatMeta byListing
// index, including chats written before it existed; and listAgentSpawners() with every gadget
// bound to each.

import { describe, expect, it } from "vitest";
import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { createTypedStorage, collection } from "@gadgets/typed-storage";
import type {
  AgentSpawnerConfig, AiChatAuthorInfo, AiChatMetadata, Overseer,
} from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { AgentSpawnerBinding } from "../src/agent-spawner-binding";
import {
  OVERSEER_STORAGE_VERSION, migrateToChatIndexes, type OverseerMigrationHost,
} from "../src/storage-schema/overseer-migrations";
import {
  makeOverseerStorage, type GatekeeperCaller, type StoredChatMetadata,
} from "../src/storage-schema/overseer-storage";
import { createWorkshopLogger } from "../src/observability";
import { openFakeOverseer } from "./fixtures.js";
import { makeMockStorage } from "./mock-storage.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const OWNER_USER_ID = "owner-user-do";
const OWNER: AiChatAuthorInfo = { type: "user", id: "owner@example.com", name: "Owner" };

// A workspace owned by OWNER_USER_ID, its users faked, with the real client opened as the owner.
// Spawners have no model, so a spawn writes its chat and starts no turn.
async function withClient(fn: (impl: any, client: Overseer) => Promise<void>): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`agent-runs-${crypto.randomUUID()}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
    let impl = (instance as unknown as { impl: any }).impl;
    impl.storage.version.put(OVERSEER_STORAGE_VERSION);
    impl.ownerId = OWNER_USER_ID;
    impl.users = {
      idFromString: (id: string) => id,
      get: () => ({
        id: OWNER_USER_ID, whoami: async () => OWNER, messageArrived: async () => {},
        getChatContext: async () => ({ profile: OWNER }), recordSharedWorkspaceOpen: async () => {},
      }),
    };
    impl.wrapUserDo = (user: unknown) => user;
    impl.ensureAmbientCapsules = async () => {};
    impl.syncDirectory = () => {};
    impl.markListingDirty = () => {};
    let client = await instance.open(OWNER_USER_ID, OWNER.id, new NativeRpcStub<() => void>(() => {}));
    await fn(impl, client);
  });
}

function seedGadget(impl: any, id: number): void {
  impl.storage.gadgets.put(
      { type: "gadget", id, title: `G${id}`, created: new Date(0), bindingName: `G${id}`, bindings: {} });
}

async function addSpawner(impl: any, displayName: string): Promise<number> {
  let config: Omit<AgentSpawnerConfig, "env"> = { displayName, modelId: null };
  let cls = impl.ctx.exports.AgentSpawnerGatekeeper({ props: { config, creatorUserId: OWNER_USER_ID } });
  using client = await impl.addGatekeeper(cls, { type: "agentSpawner", config }, OWNER_USER_ID, undefined, {});
  return await client.getId();
}

// Spawns a run through the spawner's session, as `caller` reaches it, and returns its metadata.
async function spawn(impl: any, spawnerId: number, caller: GatekeeperCaller, title: string)
    : Promise<AiChatMetadata> {
  using binding: AgentSpawnerBinding =
      await impl.startGatekeeperSession({ type: "gatekeeper", id: spawnerId }, caller);
  await binding.spawn(title, "Do the task.");
  return [...impl.storage.chatMeta.list()].find((meta: AiChatMetadata) => meta.title === title);
}

describe("agent runs", () => {
  it("record the gadget that started one, and none when a chat's agent did",
      () => withClient(async impl => {
    seedGadget(impl, 100);
    let spawnerId = await addSpawner(impl, "Triage");

    let fromChat = await spawn(impl, spawnerId, { from: "agent", chatId: 7 }, "From a chat");
    expect(fromChat).toMatchObject({ spawnerId });
    expect(fromChat).not.toHaveProperty("spawnedByGadgetId");

    // A hook firing into a gadget wakes its code as kept, whose bindings call as the gadget.
    let fromGadget = await spawn(impl, spawnerId, { from: "gadget", gadgetId: 100 }, "Woken");
    expect(fromGadget).toMatchObject({ spawnerId, spawnedByGadgetId: 100 });
  }));

  it("are their spawner's, and each spawner is listed with every gadget bound to it",
      () => withClient(async (impl, client) => {
    seedGadget(impl, 100);
    seedGadget(impl, 101);
    let triage = await addSpawner(impl, "Triage");
    let other = await addSpawner(impl, "Other");
    impl.bindWorkpiece(100, "AGENT", triage);
    impl.bindWorkpiece(101, "HELPER", triage);
    impl.bindWorkpiece(100, "HELPER_TOO", other);
    let run = await spawn(impl, triage, { from: "gadget", gadgetId: 100 }, "Run");

    expect((await client.listChats({ spawnerId: triage })).map(({ id }) => id)).toEqual([run.id]);
    expect(await client.listChats({ spawnerId: other })).toEqual([]);
    expect(await client.listAgentSpawners()).toEqual([
      { id: triage, config: { displayName: "Triage", modelId: null },
        bindings: [{ gadgetId: 100, name: "AGENT" }, { gadgetId: 101, name: "HELPER" }] },
      { id: other, config: { displayName: "Other", modelId: null },
        bindings: [{ gadgetId: 100, name: "HELPER_TOO" }] },
    ]);
    let bindings = await (await client.getGadget(100)).listBindings();
    expect(bindings.map(({ name, kind }) => [name, kind]))
        .toEqual([["AGENT", "agentSpawner"], ["HELPER_TOO", "agentSpawner"]]);
  }));
});

describe("listChats", () => {
  // The chatMeta collection as it was before byListing was declared.
  function preIndexStorage(mock: DurableObjectStorage) {
    return createTypedStorage(mock, {
      collections: {
        chatMeta: collection<StoredChatMetadata>()({
          primaryKey: "id",
          uniqueIndexes: { byLastActive: (meta: StoredChatMetadata) => meta.lastActive.valueOf() },
        }),
      },
    });
  }
  const chat = (id: number, more: Partial<AiChatMetadata> = {}): StoredChatMetadata =>
    ({ id, title: `Chat ${id}`, started: new Date(id), lastActive: new Date(id), ...more });

  it("pages by kind and spawner, over chats written before the index", async () => {
    let mock = makeMockStorage();
    let legacy = preIndexStorage(mock);
    legacy.chatMeta.put(chat(1));
    legacy.chatMeta.put(chat(2, { spawnerName: "Triage", spawnerId: 10 }));
    legacy.chatMeta.put(chat(3, { spawnerName: "Gone" }));                   // before spawnerId
    legacy.chatMeta.put(chat(4, { spawnerName: "Other", spawnerId: 11 }));

    let storage = makeOverseerStorage(mock);
    storage.version.put(7);
    migrateToChatIndexes({
      storage, ctx: { storage: mock }, logger: createWorkshopLogger("test.agent-runs"),
    } as unknown as OverseerMigrationHost);
    expect(storage.version.get()).toBe(8);

    // Written since, through the index.
    storage.chatMeta.put(chat(5, { spawnerName: "Triage", spawnerId: 10 }));
    storage.chatMeta.put(chat(6));

    let client = await openFakeOverseer(storage, { impl: { chatMetaForClient: (meta: unknown) => meta } });
    let ids = (chats: AiChatMetadata[]) => chats.map(({ id }) => id);
    expect(ids(await client.listChats())).toEqual([6, 5, 4, 3, 2, 1]);
    expect(ids(await client.listChats({ kind: "chats" }))).toEqual([6, 1]);
    expect(ids(await client.listChats({ kind: "runs", limit: 3 }))).toEqual([5, 4, 3]);
    expect(ids(await client.listChats({ kind: "runs", beforeId: 3, limit: 3 }))).toEqual([2]);
    expect(ids(await client.listChats({ spawnerId: 10, limit: 1 }))).toEqual([5]);
    expect(ids(await client.listChats({ spawnerId: 10, beforeId: 5, limit: 2 }))).toEqual([2]);
    expect(ids(await client.listChats({ spawnerId: 11 }))).toEqual([4]);
    expect(await client.listChats({ spawnerId: 12 })).toEqual([]);
    await expect(client.listChats({ limit: 0 })).rejects.toThrow(/positive integer/);

    let use = await openFakeOverseer(storage, { role: "use" });
    await expect(use.listChats({ kind: "runs" })).rejects.toThrow(/Unauthorized/);
    await expect(use.listAgentSpawners()).rejects.toThrow(/Unauthorized/);
  });
});
