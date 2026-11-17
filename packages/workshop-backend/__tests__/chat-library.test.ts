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

  it("stars a connected service's file by its subject, keeping only its title", async () => {
    const {user, workspaceId} = await setup();
    await user.setFavorite({kind: "external", workspaceId, subjectId: "doc-1", title: "Plan",
      // A field an external file doesn't define is not stored.
      mimeType: "text/plain"}, true);
    expect(await user.listFavorites()).toEqual([{kind: "external", workspaceId, subjectId: "doc-1",
      title: "Plan", starred: expect.any(Date)}]);

    await user.setFavorite({kind: "external", workspaceId, subjectId: "doc-1", title: "Plan"}, false);
    expect(await user.listFavorites()).toEqual([]);
  });

  it("refuses to star something in a workspace the user doesn't have", async () => {
    const {user} = await setup();
    await runInDurableObject(user, instance =>
      expect(instance.setFavorite({kind: "chat", workspaceId: "elsewhere", chatId: 1, title: "x"}, true))
        .rejects.toThrow(/No such workspace/));
  });
});

describe("library removals", () => {
  it("records each kind with only the fields it defines, and puts an item back", async () => {
    const {user, workspaceId} = await setup();
    await user.setLibraryRemoved({kind: "external", workspaceId, subjectId: "doc1",
      // A field the kind doesn't define is not stored.
      title: "Plan"} as never, true);
    await user.setLibraryRemoved({kind: "file", workspaceId, chatId: 1, fileId: "f"}, true);
    await user.setLibraryRemoved({kind: "app", workspaceId, workpieceId: 3}, true);

    const removals = await user.listLibraryRemovals();
    expect(removals).toHaveLength(3);
    expect(removals.find(r => r.kind === "external")).toEqual(
      {kind: "external", workspaceId, subjectId: "doc1", removed: expect.any(Date)});

    await user.setLibraryRemoved({kind: "file", workspaceId, chatId: 1, fileId: "f"}, false);
    expect((await user.listLibraryRemovals()).map(r => r.kind).toSorted()).toEqual(["app", "external"]);
  });

  it("refuses to remove something in a workspace the user doesn't have", async () => {
    const {user} = await setup();
    await runInDurableObject(user, instance =>
      expect(instance.setLibraryRemoved({kind: "app", workspaceId: "elsewhere", workpieceId: 1}, true))
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

describe("listing a workspace's connections", () => {
  it("lists every connection to a service, with the gadgets bound to it and the chats that used it", async () => {
    let workspace = env.TEST_OVERSEER.getByName(crypto.randomUUID());
    await runInDurableObject(workspace, async (instance: OverseerDurableObject) => {
      let impl = instance.impl;
      let ownerId = impl.users.newUniqueId().toString();
      impl.ownerId = ownerId;
      impl.ensureAmbientCapsules = async () => {};
      impl.markOutputsDirty = () => {};
      let gatekeeper = (id: number, title: string, creationSpec: object) =>
        impl.storage.gatekeepers.put({id, resourceTitle: title, class: {} as never, creationSpec: creationSpec as never});
      gatekeeper(10, "Q4 Plan", {type: "gatekeeper", vendorId: "Google", resourceUrl: "https://docs/q4", typeUrlPattern: "https://docs/:id"});
      gatekeeper(11, "Unused", {type: "gatekeeper", vendorId: "github", typeUrlPattern: "https://github.com/:o/:r"});
      gatekeeper(12, "Web Search", {type: "ambient", vendorId: "websearch", accountId: 1});
      // Not connections to a service.
      gatekeeper(13, "A model", {type: "aiModel", modelId: "m", provider: "p", modelName: "n"});
      let gadget = (id: number, bindings: object, pending?: object) => impl.storage.gadgets.put({
        type: "gadget", id, title: `G${id}`, created: new Date(0), bindingName: `G${id}`, bindings: bindings as never,
        ...(pending ? {pending: pending as never} : {}),
      });
      gadget(100, {PLAN: {target: 10}, DRAFT: {target: 11, pending: {chatId: 1}}});
      gadget(101, {PLAN: {target: 10}});
      // One still being made in a chat binds nothing yet.
      gadget(102, {SEARCH: {target: 12}}, {chatId: 1});
      impl.storage.chatMeta.put({id: 1, title: "One", started: new Date(1), lastActive: new Date(1)});
      let action = (id: number, gatekeeperId: number, caller: object) => impl.storage.actions.put({
        id, type: "observation", gatekeeperId, caller, createdAt: new Date(id), state: "approved",
        description: {title: "Read", description: ""},
      } as never);
      action(0, 10, {from: "agent", chatId: 1});
      action(1, 10, {from: "gadget", gadgetId: 100, chatId: 1});
      // A deleted chat's, and a hook's, which has none.
      action(2, 12, {from: "agent", chatId: 9});
      action(3, 12, {from: "hook", gadgetId: 100});
      // A doc the agent has only asked to create is not there yet.
      gatekeeper(14, "Not made yet", {type: "gatekeeper", vendorId: "google", typeUrlPattern: "https://docs/:id"});
      impl.storage.actions.put({
        id: 4, type: "action", action: "create", gatekeeperId: 14, caller: {from: "agent", chatId: 1},
        createdAt: new Date(4), state: "pending", description: {title: "Create", description: ""},
      } as never);

      using notifyClosed = new NativeRpcStub<() => void>(() => {});
      using client: Overseer = await instance.open(ownerId, "owner-profile", notifyClosed) as never;
      expect(await client.listConnections()).toEqual([
        {gatekeeperId: 10, title: "Q4 Plan", vendorId: "google", typeUrlPattern: "https://docs/:id",
          resourceUrl: "https://docs/q4", gadgetIds: [100, 101], chatIds: [1]},
        {gatekeeperId: 11, title: "Unused", vendorId: "github", typeUrlPattern: "https://github.com/:o/:r",
          gadgetIds: [], chatIds: []},
        {gatekeeperId: 12, title: "Web Search", vendorId: "websearch", ambient: true, gadgetIds: [], chatIds: []},
      ]);
    });
  });

  it("loses a resource a deleted chat's agent asked to create, rejected, and keeps the rest", async () => {
    let workspace = env.TEST_OVERSEER.getByName(crypto.randomUUID());
    await runInDurableObject(workspace, async (instance: OverseerDurableObject) => {
      let impl = instance.impl;
      let ownerId = impl.users.newUniqueId().toString();
      impl.ownerId = ownerId;
      impl.ensureAmbientCapsules = async () => {};
      impl.markOutputsDirty = () => {};
      impl.traceAgentActionApproval = () => {};
      for (let [id, chatId] of [[10, 1], [11, 2]]) {
        impl.storage.chatMeta.put({id: chatId, title: `Chat ${chatId}`, started: new Date(chatId), lastActive: new Date(chatId)});
        impl.storage.gatekeepers.put({id, resourceTitle: "Plan", class: {} as never,
          creationSpec: {type: "gatekeeper", vendorId: "google", typeUrlPattern: "https://docs/:id"} as never});
        impl.storage.actions.put({
          id, type: "action", action: "create", gatekeeperId: id, caller: {from: "agent", chatId},
          createdAt: new Date(id), state: "pending", description: {title: "Create", description: ""},
        } as never);
      }

      using notifyClosed = new NativeRpcStub<() => void>(() => {});
      using client: Overseer = await instance.open(ownerId, "owner-profile", notifyClosed) as never;
      await client.deleteChat(1);
      expect(impl.storage.gatekeepers.get(10)).toBeUndefined();
      expect(impl.storage.actions.get(10)).toMatchObject({state: "rejected"});
      // Another chat's is still waiting on its decision.
      expect(impl.storage.gatekeepers.get(11)).toBeDefined();
      expect(impl.storage.actions.get(11)).toMatchObject({state: "pending"});
    });
  });
});

describe("a gadget's own activity", () => {
  it("is noted when it is used or changed, at most once a minute, and goes into the outputs index", async () => {
    let workspace = env.TEST_OVERSEER.getByName(crypto.randomUUID());
    await runInDurableObject(workspace, async (instance: OverseerDurableObject) => {
      let impl = instance.impl;
      impl.markOutputsDirty = () => {};
      impl.storage.gadgets.put({type: "gadget", id: 100, title: "Tip Jar", created: new Date(0), bindingName: "TIP_JAR", bindings: {}});
      impl.storage.gadgets.put({type: "gadget", id: 101, title: "Draft", created: new Date(0), bindingName: "DRAFT", bindings: {}, pending: {chatId: 1}});
      let lastActive = (id: number) => impl.outputsSnapshot().find(({workpieceId}) => workpieceId === id)?.lastActive;
      // Not used since it was made, the index has nothing to say, and its workspace's time stands in.
      expect(lastActive(100)).toBeUndefined();

      impl.touchGadget(100, new Date(60_000));
      expect(lastActive(100)).toEqual(new Date(60_000));
      impl.touchGadget(100, new Date(90_000));
      expect(lastActive(100)).toEqual(new Date(60_000));
      impl.touchGadget(100, new Date(120_000));
      expect(lastActive(100)).toEqual(new Date(120_000));

      // One still being made in a chat is no output yet, and is not noted.
      impl.touchGadget(101, new Date(120_000));
      expect(impl.storage.gadgets.get(101)).not.toHaveProperty("lastActive");
    });
  });
});
