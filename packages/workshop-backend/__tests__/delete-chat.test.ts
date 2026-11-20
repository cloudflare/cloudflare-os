// Overseer.deleteChat() over a transcript of several pages: it deletes every message, the committed
// attachment content they reference, and their index entries, reading one bounded page at a time.

import { describe, expect, it, vi } from "vitest";
import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import { CHAT_DELETE_PAGE_SIZE, type OverseerDurableObject } from "../src/overseer.js";
import type { StoredChatMessage } from "../src/storage-schema/overseer-storage.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const OWNER_USER_ID = "owner-user-do";
const OWNER: AiChatAuthorInfo = { type: "user", id: "olive@example.com", name: "Olive" };

describe("deleteChat", () => {
  it("deletes a multi-page transcript, its attachments and index entries, a page at a time", () =>
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
    using notifyClosed = new NativeRpcStub<() => void>(() => {});
    using client = await instance.open(OWNER_USER_ID, OWNER.id, notifyClosed);

    let chatId = await client.newChat("Start", null);
    let other = await client.newChat("Other", null);
    let put = (id: number, msg: object) => impl.storage.chats.put({
      chatId: id, sequence: impl.nextChatSequence(id), timestamp: impl.getChatTimestamp(),
      author: OWNER, ...msg,
    } as StoredChatMessage);
    let attach = (id: number) => {
      let fileId = crypto.randomUUID();
      impl.storage.chatAttachmentContent.put(
          { fileId, data: new Uint8Array([1]), state: { type: "committed", chatId: id } });
      put(id, { type: "message", message: "file",
        attachments: [{ id: fileId, name: "a.txt", mimeType: "text/plain", size: 1 }] });
      return fileId;
    };
    let files: string[] = [];
    for (let i = 0; i < 2 * CHAT_DELETE_PAGE_SIZE + 5; i++) {
      if (i % 10 === 0) files.push(attach(chatId));
      else put(chatId, { type: "message", message: `m${i}` });
    }
    put(chatId, { type: "connectionRequest", requestId: "r", vendorId: "v", vendorName: "V",
      reason: "Needed", state: "pending" });
    let kept = attach(other);
    put(other, { type: "connectionRequest", requestId: "o", vendorId: "v", vendorName: "V",
      reason: "Needed", state: "pending" });

    // How many messages each listing of the chats collection buffers.
    let listed: number[] = [];
    let list = impl.storage.chats.list.bind(impl.storage.chats);
    let spy = vi.spyOn(impl.storage.chats, "list").mockImplementation(function* (options?: object) {
      let count = 0;
      for (let msg of list(options)) { count++; yield msg; }
      listed.push(count);
    });
    try {
      await client.deleteChat(chatId);
    } finally {
      spy.mockRestore();
    }

    expect(Math.max(...listed)).toBeLessThanOrEqual(CHAT_DELETE_PAGE_SIZE);
    expect(listed.length).toBeGreaterThan(2);
    let remaining = [...impl.storage.chats.list()] as StoredChatMessage[];
    expect(remaining.filter(msg => msg.chatId === chatId)).toEqual([]);
    expect(remaining.some(msg => msg.chatId === other)).toBe(true);
    for (let fileId of files) expect(impl.storage.chatAttachmentContent.get(fileId)).toBeUndefined();
    expect(impl.storage.chatAttachmentContent.get(kept)).toBeDefined();
    expect([...impl.storage.chats.pendingRequestsByChat.list()].map(({ chatId: id }) => id))
        .toEqual([other]);
    expect([...impl.storage.chats.artifactsByChat.list()].map(({ chatId: id }) => id))
        .toEqual([other, other]);
  }));
});
