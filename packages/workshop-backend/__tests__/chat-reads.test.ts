// What a workspace answers of one chat: a file sent in it (getChatAttachment(), which reads the
// chat's messages); what the chat still asks (pendingRequestsByChat, which the workspace summary
// reads), which the version-8 migration backfills from each chat's current decision segment
// alone; and that a session shared only to use a gadget is told none of it.

import { describe, expect, it, vi } from "vitest";
import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { createTypedStorage, collection } from "@gadgets/typed-storage";
import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";
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

    // The request it left out can still be decided, after the one it indexed.
    for (let sequence of [201, 0]) {
      storage.chats.put({ ...storage.chats.get(chatKey(CHAT_ID, sequence))!, state: "denied" } as StoredChatMessage);
    }
    expect([...storage.chats.pendingRequestsByChat.list()]).toEqual([]);
  });
});

describe("one chat's reads", () => {
  it("finds a file sent in the chat by its id, and nothing in another or a deleted chat", () =>
      runInDurableObject(env.TEST_OVERSEER.getByName(crypto.randomUUID()),
          async (instance: OverseerDurableObject) => {
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

    // Chat 1 sends the old upload and then more; chat 2 sends another file.
    impl.storage.chats.put(upload(CHAT_ID, 0, OLD_FILE));
    impl.storage.chats.put(upload(CHAT_ID, 1, crypto.randomUUID()));
    let otherFile = crypto.randomUUID();
    impl.storage.chats.put(upload(CHAT_ID + 1, 0, otherFile));
    for (let id of [CHAT_ID, CHAT_ID + 1]) {
      impl.storage.chatMeta.put({ id, title: `Chat ${id}`, started: new Date(id), lastActive: new Date(id) });
      impl.storage.nextChatSequences.put({ chatId: id, nextSequence: id === CHAT_ID ? 2 : 1,
        notificationParticipants: [] });
    }
    impl.storage.nextChatId.put(CHAT_ID + 2);

    using notifyClosed = new NativeRpcStub<() => void>(() => {});
    using client = await instance.open(OWNER_USER_ID, OWNER.id, notifyClosed);
    expect(await client.getChatAttachment(CHAT_ID, OLD_FILE))
      .toEqual({ id: OLD_FILE, name: `${OLD_FILE}.csv`, mimeType: "text/csv", size: 0, sequence: 0 });
    expect(await client.getChatAttachment(CHAT_ID, otherFile)).toBeUndefined();
    expect(await client.getChatAttachment(CHAT_ID, crypto.randomUUID())).toBeUndefined();
    await expect(client.getChatAttachment(CHAT_ID, "not-an-id")).rejects.toThrow();

    await client.deleteChat(CHAT_ID + 1);
    expect(await client.getChatAttachment(CHAT_ID + 1, otherFile)).toBeUndefined();
  }));

  it("tells a session shared only to use a gadget none of it", async () => {
    let storage = makeOverseerStorage(makeMockStorage());
    storage.chatMeta.put({ id: CHAT_ID, title: "Chat", started: new Date(1), lastActive: new Date(1) });
    let client = await openFakeOverseer(storage, { role: "use" });
    await expect(client.getChatMetadata(CHAT_ID)).rejects.toThrow(/Unauthorized/);
    await expect(client.getChatAttachment(CHAT_ID, OLD_FILE)).rejects.toThrow(/Unauthorized/);
  });
});
