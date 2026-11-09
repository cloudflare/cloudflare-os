import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AiChatAuthorInfo, Overseer } from "@gadgets/workshop-shared/api";
import type { UserDurableObject } from "../src/user.js";
import type { OverseerDurableObject } from "../src/overseer.js";
import { OVERSEER_STORAGE_VERSION } from "../src/storage-schema/overseer-migrations.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

// Covers what the Workshop's Library, workspace page and chat details read: archiving a chat out
// of the user's recents, starring apps, chats and files, and listing the files attached in chats.

type Impl = OverseerDurableObject["impl"];
const AGENT: AiChatAuthorInfo = {type: "agent", id: "test", name: "Test"};

const withImpl = <T>(stub: DurableObjectStub<OverseerDurableObject>, fn: (impl: Impl) => Promise<T>) =>
  runInDurableObject(env.TEST_OVERSEER.get(stub.id), instance => fn(instance.impl));

// A user with one workspace holding chat 1, which has had a message delivered to the user.
const setup = async () => {
  const user = env.TEST_USER.getByName(crypto.randomUUID());
  const workspace = env.TEST_OVERSEER.getByName(crypto.randomUUID());
  const workspaceId = workspace.id.toString();
  await user.newWorkspace(workspaceId, "Workspace");
  await withImpl(workspace, async impl => {
    impl.storage.version.put(OVERSEER_STORAGE_VERSION);
    impl.storage.chatMeta.put({id: 1, title: "Demo", started: new Date(), lastActive: new Date()});
    impl.storage.ownerId.put(user.id.toString());
    impl.ownerId = user.id.toString();
    impl.storage.chats.put({chatId: 1, sequence: 0, timestamp: new Date(1_000), author: AGENT,
      type: "message", message: "Hello"});
    impl.storage.nextChatSequences.put({chatId: 1, nextSequence: 1});
    await impl.deliverDirtyChats();
  });
  return {user, workspace, workspaceId};
};

describe("archiving a chat", () => {
  it("marks the user's thread archived until it is unarchived, without touching its unread count", async () => {
    const {user, workspaceId} = await setup();
    const thread = async () => (await user.getChatThreads()).find(t => t.chatId === 1);
    const before = await thread();
    expect(before).toBeDefined();
    expect(before?.archived).toBeUndefined();

    await user.setChatArchived(workspaceId, 1, true);
    expect(await thread()).toMatchObject({archived: true, unreadMessageCount: before!.unreadMessageCount});

    await user.setChatArchived(workspaceId, 1, false);
    expect((await thread())?.archived).toBeUndefined();
  });

  it("refuses a workspace the user doesn't have", async () => {
    const {user} = await setup();
    await runInDurableObject(user, instance =>
      expect(instance.setChatArchived("not-a-workspace", 1, true)).rejects.toThrow(/No such workspace/));
  });
});

describe("favorites", () => {
  it("records apps, chats and files with only the fields their kind defines, newest first", async () => {
    const {user, workspaceId} = await setup();
    await user.setFavorite({kind: "file", workspaceId, chatId: 1, fileId: "f", title: "a.png",
      mimeType: "image/png"}, true);
    await user.setFavorite({kind: "chat", workspaceId, chatId: 1, title: "Demo",
      // A field a chat doesn't define is not stored.
      mimeType: "text/plain"}, true);
    await user.setFavorite({kind: "app", workspaceId, workpieceId: 3, title: "Todo",
      output: {noun: "App", icon: "app"} as never}, true);

    const favorites = await user.listFavorites();
    expect(favorites.map(f => f.kind)).toEqual(["app", "chat", "file"]);
    expect(favorites[1]).toEqual({kind: "chat", workspaceId, chatId: 1, title: "Demo",
      starred: expect.any(Date)});
    expect(favorites[2]).toMatchObject({fileId: "f", mimeType: "image/png"});
  });

  it("unstars an item, and keeps a chat's star apart from its files'", async () => {
    const {user, workspaceId} = await setup();
    await user.setFavorite({kind: "chat", workspaceId, chatId: 1, title: "Demo"}, true);
    await user.setFavorite({kind: "file", workspaceId, chatId: 1, fileId: "f", title: "a.png"}, true);

    await user.setFavorite({kind: "chat", workspaceId, chatId: 1, title: "Demo"}, false);
    expect((await user.listFavorites()).map(f => f.kind)).toEqual(["file"]);
  });

  it("refuses to star something in a workspace the user doesn't have", async () => {
    const {user} = await setup();
    await runInDurableObject(user, instance =>
      expect(instance.setFavorite({kind: "chat", workspaceId: "elsewhere", chatId: 1, title: "x"}, true))
        .rejects.toThrow(/No such workspace/));
  });
});

describe("listing a workspace's chat files", () => {
  it("lists committed attachments that recorded their file, newest first, by chat", async () => {
    const workspace = env.TEST_OVERSEER.getByName(crypto.randomUUID());
    await runInDurableObject(workspace, async (instance: OverseerDurableObject) => {
      const impl = instance.impl;
      const ownerId = impl.users.newUniqueId().toString();
      impl.ownerId = ownerId;
      impl.ensureAmbientCapsules = async () => {};
      impl.markOutputsDirty = () => {};
      impl.storage.chatMeta.put({id: 1, title: "One", started: new Date(1), lastActive: new Date(1)});
      impl.storage.chatMeta.put({id: 2, title: "Two", started: new Date(2), lastActive: new Date(2)});
      const committed = (fileId: string, chatId: number, attached?: number) =>
        impl.storage.chatAttachmentContent.put({fileId, state: {type: "committed", chatId,
          ...(attached === undefined ? {} : {file: {name: `${fileId}.txt`, mimeType: "text/plain", size: 3, attached}})}});
      committed("old", 1, 1_000);
      committed("new", 2, 2_000);
      committed("unrecorded", 1);
      // A file whose chat was deleted is left out.
      committed("orphan", 9, 3_000);

      using notifyClosed = new NativeRpcStub<() => void>(() => {});
      using client: Overseer = await instance.open(ownerId, "owner-profile", notifyClosed) as never;
      expect((await client.listChatFiles()).map(f => f.id)).toEqual(["new", "old"]);
      expect(await client.listChatFiles(1)).toEqual([{chatId: 1, id: "old", name: "old.txt",
        mimeType: "text/plain", size: 3, attached: new Date(1_000)}]);
    });
  });
});

describe("listing a chat's connections", () => {
  it("lists the chat's own, then the workspace's, then the always-available, each once", async () => {
    let workspace = env.TEST_OVERSEER.getByName(crypto.randomUUID());
    await runInDurableObject(workspace, async (instance: OverseerDurableObject) => {
      let impl = instance.impl;
      let ownerId = impl.users.newUniqueId().toString();
      impl.ownerId = ownerId;
      impl.ensureAmbientCapsules = async () => {};
      impl.markOutputsDirty = () => {};
      let gatekeeper = (id: number, title: string, creationSpec: object) =>
        impl.storage.gatekeepers.put({id, resourceTitle: title, class: {} as never, creationSpec: creationSpec as never});
      gatekeeper(10, "Gmail", {type: "gatekeeper", vendorId: "google", resourceUrl: "https://mail", typeUrlPattern: "https://*"});
      gatekeeper(11, "Docs", {type: "gatekeeper", vendorId: "google", resourceUrl: "https://docs", typeUrlPattern: "https://*"});
      gatekeeper(12, "Web Search", {type: "ambient", vendorId: "websearch"});
      impl.storage.chatMeta.put({id: 1, title: "One", started: new Date(1), lastActive: new Date(1)});
      let request = (sequence: number, gatekeeperId: number, state: string) => impl.storage.chats.put({
        chatId: 1, sequence, timestamp: new Date(sequence), author: AGENT, type: "connectionRequest",
        requestId: `r${sequence}`, vendorId: "google", vendorName: "Google", reason: "", state,
        gatekeeperId, bindingName: `B${sequence}`,
      } as never);
      request(0, 10, "accepted");
      request(1, 11, "denied");
      // An app's connection the chat also accepted is listed as the chat's, once.
      impl.defaultBindingList = () => ({DOCS: 11, GMAIL: 10});

      using notifyClosed = new NativeRpcStub<() => void>(() => {});
      using client: Overseer = await instance.open(ownerId, "owner-profile", notifyClosed) as never;
      expect(await client.listChatConnections(1)).toEqual([
        {gatekeeperId: 10, title: "Gmail", vendorId: "google", name: "B0", scope: "chat"},
        {gatekeeperId: 11, title: "Docs", vendorId: "google", name: "DOCS", scope: "workspace"},
        {gatekeeperId: 12, title: "Web Search", vendorId: "websearch", scope: "always"},
      ]);
      await expect(client.listChatConnections(2)).rejects.toThrow(/No such chat/);

      // A connection the chat only read through, never asked for, is the chat's too.
      gatekeeper(13, "Q4 Plan", {type: "gatekeeper", vendorId: "google", resourceUrl: "https://docs/q4", typeUrlPattern: "https://*"});
      impl.storage.actions.put({
        id: 0, type: "observation", gatekeeperId: 13, caller: {from: "agent", chatId: 1},
        resourceTitle: "Q4 Plan", createdAt: new Date(2), state: "approved",
        description: {title: "Read Google Doc", description: ""},
      } as never);
      impl.storage.chats.put({
        chatId: 1, sequence: 2, timestamp: new Date(2), author: AGENT, type: "action", actionId: 0,
      } as never);
      expect((await client.listChatConnections(1)).map(entry => [entry.gatekeeperId, entry.scope]))
          .toEqual([[10, "chat"], [13, "chat"], [11, "workspace"], [12, "always"]]);
    });
  });
});
