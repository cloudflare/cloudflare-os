// What a workspace answers of one chat without reading it whole: what it has
// (listChatArtifacts(), paged over the chats artifactsByChat index, and getChatAttachment()),
// over messages written before the indexes existed, which also index what the chat still asks
// (pendingRequestsByChat, which the workspace summary reads); and that a session shared only to
// use a gadget is told none of it.

import { describe, expect, it } from "vitest";
import { createTypedStorage, collection } from "@gadgets/typed-storage";
import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import { CHAT_ARTIFACT_PAGE_SIZE } from "../src/overseer.js";
import { migrateToChatIndexes, type OverseerMigrationHost } from "../src/storage-schema/overseer-migrations";
import {
  chatKey, makeOverseerStorage, type StoredChatMessage,
} from "../src/storage-schema/overseer-storage";
import { createWorkshopLogger } from "../src/observability";
import { openFakeOverseer } from "./fixtures.js";
import { makeMockStorage } from "./mock-storage.js";

const OWNER: AiChatAuthorInfo = { type: "user", id: "owner@example.com", name: "Owner" };
const CHAT_ID = 1;
// The chat's first message, which sends the old upload: older than any one page of history.
const OLD_FILE = "11111111-1111-4111-8111-111111111111";

const text = (sequence: number): StoredChatMessage =>
  ({ chatId: CHAT_ID, sequence, timestamp: new Date(sequence), author: OWNER, type: "message", message: `m${sequence}` });
const upload = (sequence: number, id: string): StoredChatMessage => ({
  ...text(sequence),
  attachments: [{ id, name: `file-${sequence}.csv`, mimeType: "text/csv", size: sequence }],
} as StoredChatMessage);

// A chat of `count` messages, every one sending a file, the first OLD_FILE, and before them
// a connection request still pending, all written before the indexes existed and then migrated.
function seed(count: number) {
  let mock = makeMockStorage();
  let legacy = createTypedStorage(mock, {
    collections: {
      chats: collection<StoredChatMessage>()({ primaryKey: (msg: StoredChatMessage) => chatKey(msg.chatId, msg.sequence) }),
    },
  });
  legacy.chats.put({
    chatId: CHAT_ID, sequence: 0, timestamp: new Date(0), author: { type: "agent", id: "m", name: "Agent" },
    type: "connectionRequest", requestId: "r0", vendorId: "github", vendorName: "GitHub", state: "pending",
  } as StoredChatMessage);
  for (let sequence = 1; sequence <= count; sequence++) {
    legacy.chats.put(upload(sequence, sequence === 1 ? OLD_FILE : crypto.randomUUID()));
  }
  let storage = makeOverseerStorage(mock);
  storage.version.put(7);
  migrateToChatIndexes({
    storage, ctx: { storage: mock }, logger: createWorkshopLogger("test.chat-reads"),
  } as unknown as OverseerMigrationHost);
  expect(storage.version.get()).toBe(8);
  return storage;
}

describe("one chat's reads", () => {
  it("pages what the chat has at the page boundary, and finds an old upload by id", async () => {
    let storage = seed(CHAT_ARTIFACT_PAGE_SIZE + 1);
    // Written since: a message with nothing to list does not count against a page.
    storage.chats.put(text(CHAT_ARTIFACT_PAGE_SIZE + 2));
    let client = await openFakeOverseer(storage);

    let first = await client.listChatArtifacts(CHAT_ID);
    expect(first.artifacts).toHaveLength(CHAT_ARTIFACT_PAGE_SIZE);
    expect(first.artifacts[0]).toMatchObject({ type: "attachment", attachment: { id: OLD_FILE, sequence: 1 } });
    expect(first.nextAfterSequence).toBe(CHAT_ARTIFACT_PAGE_SIZE);
    expect(first.connections).toEqual([]);

    let last = await client.listChatArtifacts(CHAT_ID, first.nextAfterSequence);
    expect(last.artifacts.map(({ type }) => type)).toEqual(["attachment"]);
    expect(last.nextAfterSequence).toBeUndefined();
    expect(last.connections).toBeUndefined();

    expect(await client.getChatAttachment(CHAT_ID, OLD_FILE))
      .toEqual({ id: OLD_FILE, name: "file-1.csv", mimeType: "text/csv", size: 1, sequence: 1 });
    expect(await client.getChatAttachment(CHAT_ID + 1, OLD_FILE)).toBeUndefined();
  });

  it("indexes a request still pending, however far back it was asked", () => {
    let storage = seed(60);
    expect([...storage.chats.pendingRequestsByChat.get(CHAT_ID)])
      .toMatchObject([{ type: "connectionRequest", requestId: "r0", sequence: 0 }]);
    expect([...storage.chats.pendingRequestsByChat.get(CHAT_ID + 1)]).toEqual([]);
  });

  it("tells a session shared only to use a gadget none of it", async () => {
    let client = await openFakeOverseer(seed(1), { role: "use" });
    await expect(client.getChatMetadata(CHAT_ID)).rejects.toThrow(/Unauthorized/);
    await expect(client.listChatArtifacts(CHAT_ID)).rejects.toThrow(/Unauthorized/);
    await expect(client.getChatAttachment(CHAT_ID, OLD_FILE)).rejects.toThrow(/Unauthorized/);
  });
});
