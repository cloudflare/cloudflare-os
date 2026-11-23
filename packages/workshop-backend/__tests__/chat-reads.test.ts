// What a workspace answers of one chat without reading it whole: what it has
// (listChatArtifacts(), paged over the chats artifactsByChat index, and getChatAttachment()),
// over messages written before the indexes existed, which the version-8 migration leaves to
// each chat's first such read; what the chat still asks (pendingRequestsByChat, which the
// workspace summary reads), which the migration backfills from each chat's current decision
// segment alone; and that a session shared only to use a gadget is told none of it.

import { describe, expect, it, vi } from "vitest";
import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { createTypedStorage, collection } from "@gadgets/typed-storage";
import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import { CHAT_ARTIFACT_PAGE_SIZE, type OverseerDurableObject } from "../src/overseer.js";
import { migrateToChatIndexes, type OverseerMigrationHost } from "../src/storage-schema/overseer-migrations";
import {
  chatKey, makeOverseerStorage, type OverseerStorage, type StoredChatMessage,
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
const AGENT: AiChatAuthorInfo = { type: "agent", id: "model", name: "Agent" };
const CHAT_ID = 1;
// The chat's first message, which sends the old upload: older than any one page of history.
const OLD_FILE = "11111111-1111-4111-8111-111111111111";
// Every legacy prompt carries this much text, as a long transcript's tool results and changes do.
const BULK = "x".repeat(16_384);

// The chats collection as it was before version 8 declared its non-unique indexes.
const legacyChats = (storage: DurableObjectStorage) => createTypedStorage(storage, {
  collections: {
    chats: collection<StoredChatMessage>()({
      primaryKey: (msg: StoredChatMessage) => chatKey(msg.chatId, msg.sequence),
      uniqueIndexes: { byTimestamp: (msg: StoredChatMessage) => msg.timestamp.valueOf() },
    }),
  },
}).chats;

let timestamp = 0;
const message = (chatId: number, sequence: number, author: AiChatAuthorInfo, body: object) =>
  ({ chatId, sequence, timestamp: new Date(++timestamp), author, ...body }) as StoredChatMessage;
const upload = (chatId: number, sequence: number, ...ids: string[]) => message(chatId, sequence, OWNER, {
  type: "message", message: BULK,
  attachments: ids.map(id => ({ id, name: `${id}.csv`, mimeType: "text/csv", size: sequence })),
});
const request = (chatId: number, sequence: number, requestId: string) => message(chatId, sequence, AGENT, {
  type: "connectionRequest", requestId, vendorId: "github", vendorName: "GitHub", reason: "To read", state: "pending",
});

// Migrates `storage` from version 7, counting the chat messages it reads.
function migrate(storage: OverseerStorage, ctx: { storage: DurableObjectStorage }): number {
  let read = 0;
  let list = storage.chats.list.bind(storage.chats);
  let spy = vi.spyOn(storage.chats, "list").mockImplementation(function* (options?: object) {
    for (let msg of list(options)) { read++; yield msg; }
  });
  try {
    storage.version.put(7);
    migrateToChatIndexes({
      storage, ctx, logger: createWorkshopLogger("test.chat-reads"),
    } as unknown as OverseerMigrationHost);
  } finally {
    spy.mockRestore();
  }
  expect(storage.version.get()).toBe(8);
  return read;
}

describe("the version-8 migration", () => {
  it("reads each chat back to its last decision boundary only, and indexes what that asks", () => {
    let mock = makeMockStorage();
    let legacy = legacyChats(mock);
    // Asked by a turn that was stopped, and then 200 prompts.
    legacy.put(request(CHAT_ID, 0, "1:stale"));
    for (let sequence = 1; sequence <= 200; sequence++) legacy.put(upload(CHAT_ID, sequence, crypto.randomUUID()));
    legacy.put(request(CHAT_ID, 201, "1:current"));
    legacy.put(upload(CHAT_ID + 1, 0, crypto.randomUUID()));
    let storage = makeOverseerStorage(mock);
    for (let id of [CHAT_ID, CHAT_ID + 1]) {
      storage.chatMeta.put({ id, title: `Chat ${id}`, started: new Date(id), lastActive: new Date(id) });
    }
    storage.nextChatId.put(CHAT_ID + 2);

    // The current request and the prompt before it; chat 2's prompt alone.
    expect(migrate(storage, { storage: mock })).toBe(3);
    expect([...storage.chats.pendingRequestsByChat.list()].map(msg => "requestId" in msg && msg.requestId))
      .toEqual(["1:current"]);
    expect([...storage.chats.artifactsByChat.list()]).toEqual([]);
    expect(storage.chatArtifactsIndexedFrom.get()).toBe(CHAT_ID + 2);

    // The request it left out can still be decided, after the one it indexed.
    for (let sequence of [201, 0]) {
      storage.chats.put({ ...storage.chats.get(chatKey(CHAT_ID, sequence))!, state: "denied" } as StoredChatMessage);
    }
    expect([...storage.chats.pendingRequestsByChat.list()]).toEqual([]);
  });
});

describe("one chat's reads", () => {
  it("answers for chats from before the index as a full rebuild would, reading each once", () =>
      runInDurableObject(env.TEST_OVERSEER.getByName(crypto.randomUUID()),
          async (instance: OverseerDurableObject, ctx) => {
    let impl = instance.impl;
    let owner = {
      id: OWNER_USER_ID,
      whoami: async () => OWNER,
      getChatContext: async () => ({ profile: OWNER }),
      setWorkspaceLastActive: async () => {},
    };
    // Fakes the owner's user DO and the side effects this test does not exercise.
    Object.assign(impl, {
      ownerId: OWNER_USER_ID,
      ensureAmbientCapsules: async () => {},
      markListingDirty: () => {},
      startAgent: () => {},
      users: { idFromString: (id: string) => id, idFromName: () => OWNER_USER_ID, get: () => owner },
    });

    // Chat 1 sends an old upload, more than a page of uploads after it, and creates gadget 10
    // and gadget 99, since deleted; chat 2 sends two files and asks for a connection.
    let legacy = legacyChats(ctx.storage);
    let sequence = 0;
    legacy.put(upload(CHAT_ID, sequence++, OLD_FILE));
    for (let i = 0; i < CHAT_ARTIFACT_PAGE_SIZE; i++) legacy.put(upload(CHAT_ID, sequence++, crypto.randomUUID()));
    legacy.put(message(CHAT_ID, sequence++, AGENT, { type: "changes", createdGadgets: [
      { gadgetId: 10, title: "Made", bindingName: "MADE" }, { gadgetId: 99, title: "Gone", bindingName: "GONE" },
    ] }));
    legacy.put(message(CHAT_ID, sequence++, OWNER, { type: "message", message: "thanks" }));
    let deletedFile = crypto.randomUUID();
    legacy.put(upload(CHAT_ID + 1, 0, deletedFile, crypto.randomUUID()));
    legacy.put(request(CHAT_ID + 1, 1, "2:r"));
    impl.storage.gadgets.put({ type: "gadget", id: 10, title: "Made", created: new Date(0),
      bindingName: "MADE", bindings: {} });
    for (let id of [CHAT_ID, CHAT_ID + 1]) {
      impl.storage.chatMeta.put({ id, title: `Chat ${id}`, started: new Date(id), lastActive: new Date(id) });
      impl.storage.nextChatSequences.put({ chatId: id, nextSequence: id === CHAT_ID ? sequence : 2,
        notificationParticipants: [] });
    }
    impl.storage.nextChatId.put(CHAT_ID + 2);
    migrate(impl.storage, ctx);

    using notifyClosed = new NativeRpcStub<() => void>(() => {});
    using client = await instance.open(OWNER_USER_ID, OWNER.id, notifyClosed);
    let read = async () => {
      let pages = [await client.listChatArtifacts(CHAT_ID)];
      for (let after; (after = pages.at(-1)!.nextAfterSequence) !== undefined;) {
        pages.push(await client.listChatArtifacts(CHAT_ID, after));
      }
      return { pages, old: await client.getChatAttachment(CHAT_ID, OLD_FILE) };
    };
    // A chat created since, whose messages are indexed as they are written.
    let fresh = await client.newChat("Fresh", null);
    let freshFile = crypto.randomUUID();
    impl.storage.chats.put({ ...upload(fresh, impl.nextChatSequence(fresh), freshFile),
      timestamp: impl.getChatTimestamp() });

    let listed = 0;
    let list = impl.storage.chats.list.bind(impl.storage.chats);
    let spy = vi.spyOn(impl.storage.chats, "list").mockImplementation(function* (options?: object) {
      for (let msg of list(options)) { listed++; yield msg; }
    });
    let lazy, again;
    try {
      expect((await client.listChatArtifacts(fresh)).artifacts).toMatchObject([{ attachment: { id: freshFile } }]);
      expect(await client.getChatAttachment(fresh, freshFile)).toMatchObject({ id: freshFile });
      expect(listed).toBe(0);
      lazy = await read();
      // The first read indexed the old chat's messages, once.
      expect(listed).toBe(sequence);
      again = await read();
      expect(listed).toBe(sequence);
    } finally {
      spy.mockRestore();
    }
    expect(impl.storage.chatArtifactsBackfilled.get(CHAT_ID)).toEqual({ chatId: CHAT_ID });
    expect(impl.storage.chatArtifactsBackfilled.get(fresh)).toBeUndefined();
    expect(lazy.pages.map(({ artifacts }) => artifacts.length)).toEqual([CHAT_ARTIFACT_PAGE_SIZE, 2]);
    expect(lazy.pages[1].artifacts.at(-1)).toMatchObject({ type: "workpiece", workpiece: { id: 10 } });
    expect(lazy.old).toEqual({ id: OLD_FILE, name: `${OLD_FILE}.csv`, mimeType: "text/csv", size: 0, sequence: 0 });
    expect(again).toEqual(lazy);

    // Deleting a chat never read takes out what the index left out of it, and leaves no mark.
    await client.deleteChat(CHAT_ID + 1);
    let deleted = { artifacts: await client.listChatArtifacts(CHAT_ID + 1),
      file: await client.getChatAttachment(CHAT_ID + 1, deletedFile) };
    expect(deleted).toEqual({ artifacts: { artifacts: [], connections: [], nextAfterSequence: undefined },
      file: undefined });
    expect(impl.storage.chatArtifactsBackfilled.get(CHAT_ID + 1)).toBeUndefined();
    expect([...impl.storage.chats.pendingRequestsByChat.list()]).toEqual([]);

    impl.storage.chats.artifactsByChat.rebuild();
    expect(await read()).toEqual(lazy);
    expect({ artifacts: await client.listChatArtifacts(CHAT_ID + 1),
      file: await client.getChatAttachment(CHAT_ID + 1, deletedFile) }).toEqual(deleted);

    // Deleting a chat read before drops its mark with it.
    await client.deleteChat(CHAT_ID);
    expect(impl.storage.chatArtifactsBackfilled.get(CHAT_ID)).toBeUndefined();
    expect([...impl.storage.chats.artifactsByChat.list()].map(({ chatId }) => chatId)).toEqual([fresh, fresh]);
  }));

  it("tells a session shared only to use a gadget none of it", async () => {
    let storage = makeOverseerStorage(makeMockStorage());
    storage.chatMeta.put({ id: CHAT_ID, title: "Chat", started: new Date(1), lastActive: new Date(1) });
    let client = await openFakeOverseer(storage, { role: "use" });
    await expect(client.getChatMetadata(CHAT_ID)).rejects.toThrow(/Unauthorized/);
    await expect(client.listChatArtifacts(CHAT_ID)).rejects.toThrow(/Unauthorized/);
    await expect(client.getChatAttachment(CHAT_ID, OLD_FILE)).rejects.toThrow(/Unauthorized/);
  });
});
