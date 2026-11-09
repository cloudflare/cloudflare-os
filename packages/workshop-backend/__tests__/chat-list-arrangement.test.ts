import { describe, expect, it } from "vitest";
import { makeOverseerStorage } from "../src/storage-schema/overseer-storage";
import { makeMockStorage } from "./mock-storage";
import { openFakeOverseer } from "./fixtures";

const STARTED = new Date(1700000000000);

// Real chat metadata storage with chats 1-3, the first two filed under "Board deck". Each
// lastActive differs, as the table's index requires.
function storageWithChats() {
  let storage = makeOverseerStorage(makeMockStorage());
  for (let id of [1, 2, 3]) {
    storage.chatMeta.put({
      id, title: `Chat ${id}`, started: STARTED, lastActive: new Date(STARTED.valueOf() + id),
      ...(id < 3 ? { folder: "Board deck" } : {}),
    });
  }
  return storage;
}

describe("arranging the chat list", () => {
  it("changes only the placement fields given, without moving the chat in recency order",
      async () => {
    let storage = storageWithChats();
    let client = await openFakeOverseer(storage);

    await client.setChatPlacement(1, { pinned: true });
    expect(storage.chatMeta.get(1)).toMatchObject({
      pinned: true, folder: "Board deck", lastActive: new Date(STARTED.valueOf() + 1),
    });

    await client.setChatPlacement(1, { folder: "Vendors" });
    expect(storage.chatMeta.get(1)).toMatchObject({ pinned: true, folder: "Vendors" });

    await client.setChatPlacement(1, { pinned: false, folder: null });
    expect(storage.chatMeta.get(1)).not.toHaveProperty("pinned");
    expect(storage.chatMeta.get(1)).not.toHaveProperty("folder");
  });

  it("renames a folder by refiling all of its chats, and deletes it with null", async () => {
    let storage = storageWithChats();
    let client = await openFakeOverseer(storage);
    await client.setChatPlacement(3, { folder: "Vendors" });

    await client.renameChatFolder("Board deck", "Investor deck");
    expect([1, 2, 3].map(id => storage.chatMeta.get(id)!.folder))
        .toStrictEqual(["Investor deck", "Investor deck", "Vendors"]);

    await client.renameChatFolder("Investor deck", null);
    expect([1, 2, 3].map(id => storage.chatMeta.get(id)!.folder))
        .toStrictEqual([undefined, undefined, "Vendors"]);
  });

  it("refuses blank folder names and unknown chats", async () => {
    let storage = storageWithChats();
    let client = await openFakeOverseer(storage);

    await expect(client.setChatPlacement(3, { folder: "  " })).rejects.toThrow(/blank/);
    await expect(client.renameChatFolder("Board deck", "")).rejects.toThrow(/blank/);
    expect(storage.chatMeta.get(1)!.folder).toBe("Board deck");
    await expect(client.setChatPlacement(99, { pinned: true })).rejects.toThrow(/No such chatId/);
  });
});
