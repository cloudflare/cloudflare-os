// What a workspace answers of one chat: a file sent in it (getChatAttachment(), which reads the
// chat's messages), which the version-8 migration reads none of; and that a session shared only to
// use a gadget is told none of it.

import { describe, expect, it, vi } from "vitest";
import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";
import { migrateToChatIndexes, type OverseerMigrationHost } from "../src/storage-schema/overseer-migrations";
import { makeOverseerStorage, type StoredChatMessage } from "../src/storage-schema/overseer-storage";
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
const CHAT_ID = 1;
// The chat's first message, which sends the old upload: older than any one page of history.
const OLD_FILE = "11111111-1111-4111-8111-111111111111";
// Every legacy prompt carries this much text, as a long transcript's tool results and changes do.
const BULK = "x".repeat(16_384);

let timestamp = 0;
const message = (chatId: number, sequence: number, author: AiChatAuthorInfo, body: object) =>
  ({ chatId, sequence, timestamp: new Date(++timestamp), author, ...body }) as StoredChatMessage;
const upload = (chatId: number, sequence: number, ...ids: string[]) => message(chatId, sequence, OWNER, {
  type: "message", message: BULK,
  attachments: ids.map(id => ({ id, name: `${id}.csv`, mimeType: "text/csv", size: sequence })),
});

describe("the version-8 migration", () => {
  it("reads no chat's messages", () => {
    let mock = makeMockStorage();
    let storage = makeOverseerStorage(mock);
    for (let sequence = 0; sequence < 200; sequence++) storage.chats.put(upload(CHAT_ID, sequence, crypto.randomUUID()));
    storage.chatMeta.put({ id: CHAT_ID, title: "Chat", started: new Date(1), lastActive: new Date(1) });
    storage.nextChatId.put(CHAT_ID + 1);
    storage.version.put(7);
    using list = vi.spyOn(storage.chats, "list");
    migrateToChatIndexes({
      storage, ctx: { storage: mock }, logger: createWorkshopLogger("test.chat-reads"),
    } as unknown as OverseerMigrationHost);
    expect(storage.version.get()).toBe(8);
    expect(list).not.toHaveBeenCalled();
  });

  it("records who each live chat asked for a decision", () => {
    let mock = makeMockStorage();
    let storage = makeOverseerStorage(mock);
    for (let chatId of [CHAT_ID, CHAT_ID + 1]) storage.nextChatSequences.put({ chatId, nextSequence: 5 });
    storage.chatMeta.put({ id: CHAT_ID, title: "Chat", started: new Date(1), lastActive: new Date(1) });
    let notify = (chatId: number, sequence: number, userId: string, kind: "permissionRequested" | "taskCompleted") =>
      storage.chatNotifications.put({ id: crypto.randomUUID(), chatId, sequence, userId, kind });
    notify(CHAT_ID, 1, "asked", "permissionRequested");
    notify(CHAT_ID, 3, "asked", "permissionRequested");
    notify(CHAT_ID, 2, "told", "taskCompleted");
    // Its chat is gone.
    notify(CHAT_ID + 1, 1, "asked", "permissionRequested");
    storage.version.put(7);
    let candidates = migrateToChatIndexes({
      storage, ctx: { storage: mock }, logger: createWorkshopLogger("test.chat-reads"),
    } as unknown as OverseerMigrationHost);
    expect(storage.nextChatSequences.get(CHAT_ID)?.askedUsers).toEqual(["asked"]);
    expect(storage.nextChatSequences.get(CHAT_ID + 1)?.askedUsers).toBeUndefined();
    // The live chat that asked is returned for its waiting state to be recorded.
    expect(candidates).toEqual([CHAT_ID]);
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
