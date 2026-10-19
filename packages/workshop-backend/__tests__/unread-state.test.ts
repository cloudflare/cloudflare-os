import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { RpcStub, RpcTarget } from "capnweb";
import { describe, expect, it, vi } from "vitest";
import type { ChatReadState, UnreadStateSubscriber, UserUnreadState } from "@gadgets/workshop-shared/api";
import type { UserDurableObject } from "../src/user.js";
import type { OverseerDurableObject } from "../src/overseer.js";
import { makeUserStorage } from "../src/storage-schema/user-storage.js";
import { OVERSEER_STORAGE_VERSION } from "../src/storage-schema/overseer-migrations.js";
import { chatKey } from "../src/storage-schema/overseer-storage.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}
type Impl = OverseerDurableObject["impl"];
const withImpl = <T>(stub: DurableObjectStub<OverseerDurableObject>, fn: (impl: Impl) => Promise<T>) =>
  runInDurableObject(stub, instance => fn(instance.impl));
const author = {type: "agent" as const, id: "test", name: "Test"};
const setup = async (existingUser?: DurableObjectStub<UserDurableObject>) => {
  const user = existingUser ?? env.TEST_USER.getByName(crypto.randomUUID());
  const workspace = env.TEST_OVERSEER.getByName(crypto.randomUUID());
  const workspaceId = workspace.id.toString();
  await user.newGadget(workspaceId, "Workspace");
  await withImpl(workspace, async impl => {
    impl.storage.version.put(OVERSEER_STORAGE_VERSION);
    impl.storage.ownerId.put(user.id.toString());
    impl.ownerId = user.id.toString();
    impl.storage.chatMeta.put({id: 1, title: "Demo", started: new Date(), lastActive: new Date()});
  });
  return {user, workspace, workspaceId};
};
type Fixture = Awaited<ReturnType<typeof setup>>;
const sharedWorkspace = async (role: "build" | "use" = "build") => {
  const fixture = await setup();
  const ownerProfile = {type: "user" as const, id: "owner@example.com", name: "Owner"};
  const profile = {type: "user" as const, id: "reader@example.com", name: "Reader"};
  const reader = env.TEST_USER.getByName(crypto.randomUUID());
  await runInDurableObject(fixture.user, instance => { instance.storage.profile.put(ownerProfile); });
  await runInDurableObject(reader, instance => { instance.storage.profile.put(profile); });
  // The listing intentionally predates reader enrollment, and may be stale after a downgrade.
  await reader.recordSharedGadgetOpen(fixture.workspaceId, "Workspace", ownerProfile, "build");
  await withImpl(fixture.workspace, async impl => {
    impl.storage.collaborators.put({profile,
      addedBy: [{type: "user", sharer: ownerProfile.id, role, created: new Date()}]});
    expect(impl.storage.unreadReaders.get(reader.id.toString())).toBeUndefined();
  });
  return {...fixture, reader, profile};
};
const append = async ({workspace}: Fixture, sequence: number, text = "Hello", chatId = 1) =>
  withImpl(workspace, async impl => {
    impl.storage.chats.put({chatId, sequence, timestamp: new Date(10_000 + chatId * 1_000 + sequence),
      author, type: "message", message: text});
    await impl.deliverChatTimelines(true);
  });
const chat = async (user: DurableObjectStub<UserDurableObject>): Promise<ChatReadState> =>
  (await user.getUnreadState()).chats[0];
const receipt = (workspaceId: string, throughSequence: number, readEpoch = 0) =>
  ({workspaceId, chatId: 1, throughSequence, readEpoch});
const persisted = (user: DurableObjectStub<UserDurableObject>) =>
  runInDurableObject(user, (_instance, ctx) => [...ctx.storage.kv.list()]);
class Subscriber extends RpcTarget implements UnreadStateSubscriber {
  constructor(private receive: (state: UserUnreadState) => void) { super(); }
  async updated(state: UserUnreadState): Promise<void> { this.receive(state); }
}

describe("user-owned horizons and durable workspace summaries", () => {
  it.each([0, 1])("enrolls an existing build listing during reconstruction with %i initial messages", async (initialMessages) => {
    const fixture = await sharedWorkspace();
    const {reader, profile} = fixture;
    if (initialMessages) await append(fixture, 0);

    // A listing saved before rollout must join fanout without opening a workspace session.
    expect((await reader.getUnreadState()).unreadMessageCount).toBe(initialMessages);
    const version = await withImpl(fixture.workspace, async impl => {
      expect(impl.storage.unreadReaders.get(reader.id.toString())?.profileId).toBe(profile.id);
      await impl.deliverChatTimelines(true);
      return impl.storage.chatTimelineVersion.get();
    });
    await evictDurableObject(reader);
    expect((await reader.getUnreadState()).unreadMessageCount).toBe(initialMessages);
    await withImpl(fixture.workspace, async impl => {
      expect(impl.storage.chatTimelineVersion.get()).toBe(version);
    });

    await append(fixture, initialMessages, "New message after reconstruction");
    expect(await chat(reader)).toMatchObject({unreadMessageCount: initialMessages + 1,
      latestMessagePreview: "New message after reconstruction"});
    await withImpl(fixture.workspace, async impl => {
      impl.storage.chatMeta.delete(1);
      await impl.deliverChatTimelines(true);
    });
    expect((await reader.getUnreadState()).chats).toEqual([]);
  });

  it("does not enroll a stale build listing when its collaborator has only use access", async () => {
    const fixture = await sharedWorkspace("use");
    const {reader} = fixture;
    await append(fixture, 0);
    expect((await reader.getUnreadState()).chats).toEqual([]);
    await withImpl(fixture.workspace, async impl => {
      expect(impl.storage.unreadReaders.get(reader.id.toString())).toBeUndefined();
    });
  });

  it.each([false, true])("refreshes unread on reopening a dismissed shared workspace (reset before delivery: %s)", async (reset) => {
    const fixture = await sharedWorkspace();
    const {reader, profile} = fixture;
    await append(fixture, 0, "Existing unread message");
    const received: UserUnreadState[] = [];
    using subscriber = new RpcStub(new Subscriber(state => received.push(state)));
    using _subscription = await reader.subscribeToUnreadState(subscriber);
    await withImpl(fixture.workspace, impl => impl.deliverChatTimelines(true));
    await vi.waitFor(() => expect(received.at(-1)?.unreadMessageCount).toBe(1));

    await reader.forgetSharedGadget(fixture.workspaceId);
    await vi.waitFor(() => expect(received.at(-1)?.chats).toEqual([]));
    await runInDurableObject(fixture.workspace, async instance => {
      expect(instance.impl.storage.unreadReaders.get(reader.id.toString())).toBeDefined();
      using _capsules = vi.spyOn(instance.impl, "ensureAmbientCapsules").mockResolvedValue(undefined);
      using paused = reset ? vi.spyOn(instance.impl, "deliverChatTimelines").mockResolvedValue(undefined) : undefined;
      using notify = new NativeRpcStub(() => {});
      const client = await instance.open(reader.id.toString(), profile.id, notify);
      try {
        if (reset) {
          await vi.waitFor(() => expect(paused).toHaveBeenCalled());
          expect(instance.impl.storage.unreadReaders.get(reader.id.toString())?.timelineVersion)
            .toBeUndefined();
        }
      } finally {
        client[Symbol.dispose]();
      }
    });
    if (reset) {
      await evictDurableObject(fixture.workspace);
      await withImpl(fixture.workspace, impl => {
        impl.storage.chatTimelineRetryAt.put(0); // Run the persisted fallback alarm when due.
        return impl.runAlarmTasks();
      });
    }
    // No new message, resubscription or getUnreadState() may repair the warm User DO.
    await vi.waitFor(() => expect(received.at(-1)).toMatchObject({unreadMessageCount: 1,
      chats: [{workspaceId: fixture.workspaceId, chatId: 1, latestSequence: 0,
        latestMessagePreview: "Existing unread message", readThroughSequence: -1, readEpoch: 0}]}));
    await append(fixture, 1, "Later message");
    await vi.waitFor(() => expect(received.at(-1)).toMatchObject({unreadMessageCount: 2,
      chats: [{latestMessagePreview: "Later message"}]}));
  });

  it("counts visible messages rather than sparse timeline entries or distinct threads", async () => {
    const fixture = await setup();
    await append(fixture, 0);
    await withImpl(fixture.workspace, async impl => {
      impl.storage.chats.put({chatId: 1, sequence: 1, timestamp: new Date(10_001), author,
        type: "message", message: "", reasoning: "Not a message"});
      impl.storage.chats.put({chatId: 1, sequence: 2, timestamp: new Date(10_002), author,
        type: "message", message: "Hidden expansion", generatedBySlashCommandSequence: 0});
    });
    await append(fixture, 3, "Second visible message");
    expect(await chat(fixture.user)).toMatchObject({latestSequence: 3, unreadMessageCount: 2});
    expect(await fixture.user.getUnreadState()).toMatchObject({unreadChatCount: 1, unreadMessageCount: 2});
    await fixture.user.markChatRead(receipt(fixture.workspaceId, 1));
    expect((await chat(fixture.user)).unreadMessageCount).toBe(1);
    await append(fixture, 8, "Third visible message");
    await fixture.user.markChatRead(receipt(fixture.workspaceId, 3));
    expect(await chat(fixture.user)).toMatchObject({readThroughSequence: 3, unreadMessageCount: 1});
  });

  it("writes only the changed workspace summary on arrival and skips duplicate deliveries", async () => {
    const fixture = await setup();
    await append(fixture, 0);
    const other = await setup(fixture.user);
    await append(other, 0);
    const before = await persisted(fixture.user);
    await append(fixture, 1, "Latest preview\nSecret extra text");
    const arrival = await persisted(fixture.user);
    const previous = new Map(before);
    expect(arrival.filter(([key, value]) => JSON.stringify(previous.get(key)) !== JSON.stringify(value))
      .map(([key]) => key)).toEqual([`workspaceChatSummaries:${fixture.workspaceId}`]);
    expect((await fixture.user.getUnreadState()).chats.find(chat => chat.workspaceId === fixture.workspaceId))
      .toMatchObject({unreadMessageCount: 2, latestMessagePreview: "Latest preview"});
    const duplicate = await withImpl(fixture.workspace, async impl => ({
      version: impl.storage.chatTimelineVersion.get(), heads: impl.chatTimelineHeads(),
    }));
    await runInDurableObject(fixture.user, async instance => {
      using put = vi.spyOn(instance.storage.workspaceChatSummaries, "put");
      await instance.syncWorkspaceChats(fixture.workspaceId, duplicate.version, duplicate.heads);
      expect(put).not.toHaveBeenCalled();
    });
    expect(await persisted(fixture.user)).toEqual(arrival);
    await runInDurableObject(fixture.user, async instance => {
      using load = vi.spyOn(instance, "loadWorkspaceChats");
      await instance.markChatRead(receipt(fixture.workspaceId, 1));
      expect(load).not.toHaveBeenCalled();
    });
    const after = await persisted(fixture.user);
    const beforeRead = new Map(arrival);
    const changedKeys = after.filter(([key, value]) => JSON.stringify(beforeRead.get(key)) !== JSON.stringify(value))
      .map(([key]) => key);
    expect(changedKeys.some(key => key.startsWith("chatReadCursors"))).toBe(true);
    expect(changedKeys.every(key => key.startsWith("chatReadCursors") ||
      key === `workspaceChatSummaries:${fixture.workspaceId}`)).toBe(true);
    await append(fixture, 2);
    expect((await fixture.user.getUnreadState()).chats.find(chat => chat.workspaceId === fixture.workspaceId)
      ?.unreadMessageCount).toBe(1);
  });

  it("fences stale reads and repeated manual-unread commands across devices", async () => {
    const fixture = await setup();
    for (let sequence = 0; sequence <= 4; sequence++) await append(fixture, sequence);
    await fixture.user.markChatRead(receipt(fixture.workspaceId, 4));
    await fixture.user.markChatUnread(fixture.workspaceId, 1, 2, 0);
    await fixture.user.markChatRead(receipt(fixture.workspaceId, 4));
    expect(await chat(fixture.user)).toMatchObject({readThroughSequence: 1, readEpoch: 1, unreadMessageCount: 3});
    await fixture.user.markChatRead(receipt(fixture.workspaceId, 3, 1));
    await fixture.user.markChatUnread(fixture.workspaceId, 1, 2, 0);
    expect(await chat(fixture.user)).toMatchObject({readThroughSequence: 3, readEpoch: 1, unreadMessageCount: 1});
  });

  it.each([1, 2])("accepts an observed boundary ahead of fanout for thread %i", async chatId => {
    const fixture = await setup();
    await append(fixture, 3);
    await withImpl(fixture.workspace, async impl => {
      using paused = vi.spyOn(impl, "deliverChatTimelines").mockResolvedValue(undefined);
      if (chatId === 2) impl.storage.chatMeta.put({id: chatId, title: "New thread",
        started: new Date(), lastActive: new Date()});
      impl.storage.chats.put({chatId, sequence: 8, timestamp: new Date(), author,
        type: "message", message: "Observed directly before unread delivery"});
      await vi.waitFor(() => expect(paused).toHaveBeenCalled());
    });
    await fixture.user.markChatRead({...receipt(fixture.workspaceId, 8), chatId});
    await withImpl(fixture.workspace, impl => impl.deliverChatTimelines(true));
    await evictDurableObject(fixture.user);
    expect((await fixture.user.getUnreadState()).chats.find(chat => chat.chatId === chatId))
      .toMatchObject({latestSequence: 8, readThroughSequence: 8, unreadMessageCount: 0});
    await append(fixture, 12, "Not observed", chatId);
    expect((await fixture.user.getUnreadState()).chats.find(chat => chat.chatId === chatId))
      .toMatchObject({readThroughSequence: 8, unreadMessageCount: 1});
  });

  it.each(["read", "unread"])("re-resolves %s counts if history changes while a sparse lookup waits", async action => {
    const fixture = await setup();
    for (const sequence of [0, 3, 8]) await append(fixture, sequence);
    await withImpl(fixture.workspace, async impl => {
      impl.storage.chatMeta.put({id: 2, title: "Other thread", started: new Date(), lastActive: new Date()});
    });
    for (const sequence of [0, 3, 8]) await append(fixture, sequence, "Other message", 2);
    if (action === "unread") await fixture.user.markChatRead(receipt(fixture.workspaceId, 8));
    const stale = await withImpl(fixture.workspace, async impl => ({
      version: impl.storage.chatTimelineVersion.get(),
      heads: impl.chatTimelineHeads([action === "read" ? 2 : 1],
        [{chatId: action === "read" ? 2 : 1, sequence: action === "read" ? 3 : 7}]),
    }));
    const update = await withImpl(fixture.workspace, async impl => {
      using paused = vi.spyOn(impl, "deliverChatTimelines").mockResolvedValue(undefined);
      impl.storage.chats.delete(chatKey(1, 0));
      await vi.waitFor(() => expect(paused).toHaveBeenCalled());
      return {version: impl.storage.chatTimelineVersion.get(), heads: impl.chatTimelineHeads()};
    });
    await runInDurableObject(fixture.user, async instance => {
      const fetched = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
      using _load = vi.spyOn(instance, "loadWorkspaceChats").mockImplementationOnce(async () => {
        fetched.resolve();
        await release.promise;
        return stale;
      });
      // Thread 1 resolves locally for read, while thread 2's partial lookup holds the batch.
      const result = action === "read" ? instance.markChatsRead([
        receipt(fixture.workspaceId, 8), {...receipt(fixture.workspaceId, 3), chatId: 2},
      ]) : instance.markChatUnread(fixture.workspaceId, 1, 8, 0);
      await fetched.promise;
      await instance.syncWorkspaceChats(fixture.workspaceId, update.version, update.heads, []);
      release.resolve();
      await result;
    });
    await evictDurableObject(fixture.user);
    await append(fixture, 12);
    expect((await fixture.user.getUnreadState()).chats.find(chat => chat.chatId === 1))
      .toMatchObject(action === "read" ? {readThroughSequence: 8, unreadMessageCount: 1} :
        {readThroughSequence: 7, readEpoch: 1, unreadMessageCount: 2});
  });

  it.each(["delete", "hide"])("repairs persisted counts when a previously read message is changed by %s", async change => {
    const fixture = await setup();
    for (const sequence of [0, 3, 8]) await append(fixture, sequence);
    await fixture.user.markChatRead(receipt(fixture.workspaceId, 3));
    await withImpl(fixture.workspace, async impl => {
      const key = chatKey(1, 0);
      const message = impl.storage.chats.get(key)!;
      if (change === "delete") impl.storage.chats.delete(key);
      else impl.storage.chats.put({...message, type: "message", message: ""});
      await impl.deliverChatTimelines(true);
    });
    expect(await chat(fixture.user)).toMatchObject({readThroughSequence: 3, unreadMessageCount: 1});
    await evictDurableObject(fixture.user);
    await evictDurableObject(fixture.workspace);
    await append(fixture, 12);
    expect(await chat(fixture.user)).toMatchObject({readThroughSequence: 3, unreadMessageCount: 2});
  });

  it("retries a history recount rather than overwrite a concurrent read's count", async () => {
    const fixture = await setup();
    for (const sequence of [0, 3, 8]) await append(fixture, sequence);
    await fixture.user.markChatRead(receipt(fixture.workspaceId, 0));
    const update = await withImpl(fixture.workspace, async impl => {
      using paused = vi.spyOn(impl, "deliverChatTimelines").mockResolvedValue(undefined);
      impl.storage.chats.delete(chatKey(1, 0));
      await vi.waitFor(() => expect(paused).toHaveBeenCalled());
      return {version: impl.storage.chatTimelineVersion.get(), heads: impl.chatTimelineHeads()};
    });
    await runInDurableObject(fixture.user, async instance => {
      const fetched = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
      const load = instance.loadWorkspaceChats.bind(instance);
      using _load = vi.spyOn(instance, "loadWorkspaceChats").mockImplementationOnce(async (...args) => {
        const state = await load(...args);
        fetched.resolve();
        await release.promise;
        return state;
      });
      const syncing = expect(instance.syncWorkspaceChats(fixture.workspaceId, update.version, update.heads, []))
        .rejects.toThrow("Unread horizon changed");
      await fetched.promise;
      await instance.markChatRead(receipt(fixture.workspaceId, 8));
      release.resolve();
      await syncing;
    });
    await withImpl(fixture.workspace, impl => impl.deliverChatTimelines(true));
    await evictDurableObject(fixture.user);
    await append(fixture, 12);
    expect(await chat(fixture.user)).toMatchObject({readThroughSequence: 8, unreadMessageCount: 1});
  });

  it.each([false, true])("rolls back horizons and counts together when a summary write fails (after put: %s)", async afterPut => {
    const fixture = await setup();
    await append(fixture, 0);
    const before = await persisted(fixture.user);
    await runInDurableObject(fixture.user, async instance => {
      const summaries = instance.storage.workspaceChatSummaries;
      const put = summaries.put.bind(summaries);
      using _fail = vi.spyOn(summaries, "put").mockImplementationOnce(summary => {
        if (afterPut) put(summary);
        throw new Error("Summary write failed");
      });
      await expect(instance.markChatRead(receipt(fixture.workspaceId, 0))).rejects.toThrow("Summary write failed");
      expect((await instance.getUnreadState()).chats[0]).toMatchObject({readThroughSequence: -1, unreadMessageCount: 1});
    });
    expect(await persisted(fixture.user)).toEqual(before);
    await evictDurableObject(fixture.user);
    expect(await chat(fixture.user)).toMatchObject({readThroughSequence: -1, unreadMessageCount: 1});
    await fixture.user.markChatRead(receipt(fixture.workspaceId, 0));
    await evictDurableObject(fixture.user);
    expect(await chat(fixture.user)).toMatchObject({readThroughSequence: 0, unreadMessageCount: 0});
  });

  it("rehydrates heads, previews, sparse counts and epochs locally after real user and workspace eviction", async () => {
    const fixture = await setup();
    await append(fixture, 0);
    await append(fixture, 4);
    await fixture.user.markChatRead(receipt(fixture.workspaceId, 4));
    await fixture.user.markChatUnread(fixture.workspaceId, 1, 4, 0);
    const before = await persisted(fixture.user);
    await evictDurableObject(fixture.user);
    await evictDurableObject(fixture.workspace);
    await runInDurableObject(fixture.user, async instance => {
      using load = vi.spyOn(instance, "loadWorkspaceChats").mockRejectedValue(new Error("Must not query source"));
      expect((await instance.getUnreadState()).chats[0]).toMatchObject({readThroughSequence: 3, readEpoch: 1,
        unreadMessageCount: 1, latestSequence: 4, latestMessagePreview: "Hello"});
      expect(load).not.toHaveBeenCalled();
    });
    expect(await persisted(fixture.user)).toEqual(before);
    await fixture.user.markChatRead(receipt(fixture.workspaceId, 4)); // stale device
    expect((await chat(fixture.user)).unreadMessageCount).toBe(1);
    await fixture.user.markChatRead(receipt(fixture.workspaceId, 4, 1));
    expect((await chat(fixture.user)).unreadMessageCount).toBe(0);
  });

  it("keeps the saved projection until pending fanout arrives and rejects old deliveries after a user reset", async () => {
    const fixture = await setup();
    await append(fixture, 0);
    await fixture.user.markChatRead(receipt(fixture.workspaceId, 0));
    const stale = await withImpl(fixture.workspace, async impl => ({
      version: impl.storage.chatTimelineVersion.get(), heads: impl.chatTimelineHeads(),
    }));
    await evictDurableObject(fixture.user);
    await withImpl(fixture.workspace, async impl => {
      using paused = vi.spyOn(impl, "deliverChatTimelines").mockResolvedValue(undefined);
      impl.storage.chats.put({chatId: 1, sequence: 3, timestamp: new Date(), author,
        type: "message", message: "Persisted before dispatch"});
      await vi.waitFor(() => expect(paused).toHaveBeenCalled());
    });
    expect(await chat(fixture.user)).toMatchObject({latestSequence: 0, unreadMessageCount: 0});
    await withImpl(fixture.workspace, impl => impl.deliverChatTimelines(true));
    expect(await chat(fixture.user)).toMatchObject({latestSequence: 3, unreadMessageCount: 1});
    await fixture.user.syncWorkspaceChats(fixture.workspaceId, stale.version, stale.heads);
    expect(await chat(fixture.user)).toMatchObject({latestSequence: 3, unreadMessageCount: 1});
  });

  it("durably cleans up a saved horizon when pending fanout delivers a thread deletion", async () => {
    const fixture = await setup();
    await append(fixture, 0);
    await fixture.user.markChatRead(receipt(fixture.workspaceId, 0));
    await evictDurableObject(fixture.user);
    await withImpl(fixture.workspace, async impl => {
      using paused = vi.spyOn(impl, "deliverChatTimelines").mockResolvedValue(undefined);
      impl.storage.chatMeta.delete(1);
      await vi.waitFor(() => expect(paused).toHaveBeenCalled());
    });
    expect((await fixture.user.getUnreadState()).chats).toHaveLength(1);
    await withImpl(fixture.workspace, impl => impl.deliverChatTimelines(true));
    await evictDurableObject(fixture.user);
    expect((await fixture.user.getUnreadState()).chats).toEqual([]);
    expect(await runInDurableObject(fixture.user, (instance) =>
      instance.storage.chatReadCursors.get(`${fixture.workspaceId}:1`))).toBeUndefined();
  });

  it("merges an arrival racing cold reconstruction before delivering the resulting count", async () => {
    const fixture = await setup();
    await append(fixture, 0);
    const snapshot = await withImpl(fixture.workspace, async impl => ({
      version: impl.storage.chatTimelineVersion.get(), heads: impl.chatTimelineHeads(),
    }));
    await evictDurableObject(fixture.user);
    await runInDurableObject(fixture.user, async instance => {
      // Only a missing summary (upgrade/repair), not ordinary eviction, reconstructs remotely.
      instance.storage.workspaceChatSummaries.delete(fixture.workspaceId);
    });
    await evictDurableObject(fixture.user);
    await runInDurableObject(fixture.user, async instance => {
      const fetched = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
      using _load = vi.spyOn(instance, "loadWorkspaceChats").mockImplementationOnce(async () => {
        fetched.resolve();
        await release.promise;
        return snapshot;
      });
      const initial = instance.getUnreadState();
      await fetched.promise;
      const delivery = instance.syncWorkspaceChats(fixture.workspaceId, snapshot.version + 1,
        [{...snapshot.heads[0], latestSequence: 4, messageCount: 2}], []);
      release.resolve();
      await Promise.all([initial, delivery]);
      expect(await instance.getUnreadState()).toMatchObject({unreadMessageCount: 2});
    });
  });

  it("streams counts to both devices without persisting broadcast revisions", async () => {
    const fixture = await setup();
    await append(fixture, 0);
    const first: UserUnreadState[] = [], second: UserUnreadState[] = [];
    using a = new RpcStub(new Subscriber(state => first.push(state)));
    using b = new RpcStub(new Subscriber(state => second.push(state)));
    using _one = await fixture.user.subscribeToUnreadState(a);
    using _two = await fixture.user.subscribeToUnreadState(b);
    await append(fixture, 2);
    await vi.waitFor(() => expect(first.at(-1)?.unreadMessageCount).toBe(2));
    await fixture.user.markChatRead(receipt(fixture.workspaceId, 2));
    await vi.waitFor(() => expect(second.at(-1)?.unreadMessageCount).toBe(0));
    expect(second.at(-1)).toEqual(first.at(-1));
    expect(await runInDurableObject(fixture.user, (_instance, ctx) => ctx.storage.kv.get("unreadRevision"))).toBeUndefined();
  });

  it("does not acknowledge a partial read when the source count lookup fails", async () => {
    const fixture = await setup();
    for (const sequence of [0, 3, 8]) await append(fixture, sequence);
    const before = await persisted(fixture.user);
    await runInDurableObject(fixture.user, async instance => {
      using _load = vi.spyOn(instance, "loadWorkspaceChats")
        .mockRejectedValueOnce(new Error("Workspace temporarily unavailable"));
      await expect(instance.markChatRead(receipt(fixture.workspaceId, 3)))
        .rejects.toThrow("Workspace temporarily unavailable");
    });
    expect(await persisted(fixture.user)).toEqual(before);
    expect(await chat(fixture.user)).toMatchObject({readThroughSequence: -1, unreadMessageCount: 3});
    await fixture.user.markChatRead(receipt(fixture.workspaceId, 3));
    expect(await chat(fixture.user)).toMatchObject({readThroughSequence: 3, unreadMessageCount: 1});
  });

  it("waits for cold reconstruction, labels a failed workspace unknown, and retries without losing healthy updates", async () => {
    const fixture = await setup();
    await append(fixture, 0);
    await fixture.user.markChatRead(receipt(fixture.workspaceId, 0));
    await append(fixture, 3);
    const healthy = await setup(fixture.user);
    await append(healthy, 0);
    await evictDurableObject(fixture.user);
    await runInDurableObject(fixture.user, instance => {
      instance.storage.workspaceChatSummaries.delete(fixture.workspaceId);
    });
    await evictDurableObject(fixture.user);
    const received: UserUnreadState[] = [];
    using subscriber = new RpcStub(new Subscriber(state => received.push(state)));
    await runInDurableObject(fixture.user, async instance => {
      const fetched = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
      const load = instance.loadWorkspaceChats.bind(instance);
      using _load = vi.spyOn(instance, "loadWorkspaceChats").mockImplementation(async (id, ...args) => {
        if (id !== fixture.workspaceId) return load(id, ...args);
        fetched.resolve();
        await release.promise;
        throw new Error("Workspace temporarily unavailable");
      });
      const subscribing = instance.subscribeToUnreadState(subscriber);
      await fetched.promise;
      expect(received).toEqual([]);
      release.resolve();
      using _subscription = await subscribing;
      await vi.waitFor(() => expect(received.length).toBeGreaterThan(0));
      expect(received.at(-1)).toMatchObject({unreadMessageCount: 1,
        unavailableWorkspaceIds: [fixture.workspaceId], chats: [{workspaceId: healthy.workspaceId}]});
      expect(received.at(-1)?.chats.some(chat => chat.workspaceId === fixture.workspaceId)).toBe(false);
      const state = (await instance.loadWorkspaceChats(healthy.workspaceId))!;
      await instance.syncWorkspaceChats(healthy.workspaceId, state.version + 1,
        [{...state.heads[0], latestSequence: 1, messageCount: 2}], []);
      await vi.waitFor(() => expect(received.at(-1)?.unreadMessageCount).toBe(2));
    });
    received.length = 0;
    using _subscription = await fixture.user.subscribeToUnreadState(subscriber);
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toMatchObject({unreadMessageCount: 3});
    expect(received[0].unavailableWorkspaceIds).toBeUndefined();
    expect(received[0].chats.find(chat => chat.workspaceId === fixture.workspaceId))
      .toMatchObject({readThroughSequence: 0, latestSequence: 3, unreadMessageCount: 1});
  });

  it("bulk read advances healthy workspaces while reporting another workspace's failed lookup", async () => {
    const first = await setup(), second = await setup(first.user);
    for (const fixture of [first, second]) {
      await append(fixture, 0);
      await append(fixture, 3);
    }
    await runInDurableObject(first.user, async instance => {
      const load = instance.loadWorkspaceChats.bind(instance);
      using _load = vi.spyOn(instance, "loadWorkspaceChats").mockImplementation((id, ...args) => {
        if (id === first.workspaceId) return Promise.reject(new Error("Needs repair"));
        return load(id, ...args);
      });
      await expect(instance.markChatsRead([receipt(first.workspaceId, 0), receipt(second.workspaceId, 0)]))
        .rejects.toThrow("Needs repair");
    });
    const state = await first.user.getUnreadState();
    expect(state.chats.find(chat => chat.workspaceId === first.workspaceId)?.readThroughSequence).toBe(-1);
    expect(state.chats.find(chat => chat.workspaceId === second.workspaceId)?.readThroughSequence).toBe(0);
    await first.user.markChatsRead([receipt(first.workspaceId, 0), receipt(second.workspaceId, 0)]);
    expect((await first.user.getUnreadState()).unreadMessageCount).toBe(2);
  });

  it("bulk-reads observed horizons across workspaces without swallowing later messages or epochs", async () => {
    const first = await setup(), second = await setup(first.user);
    await append(first, 0);
    await append(second, 0);
    const observed = (await first.user.getUnreadState()).chats.map(chat =>
      receipt(chat.workspaceId, chat.latestSequence, chat.readEpoch));
    await append(first, 3);
    await first.user.markChatUnread(second.workspaceId, 1, 0, 0);
    await first.user.markChatsRead(observed);
    expect(await first.user.getUnreadState()).toMatchObject({unreadChatCount: 2, unreadMessageCount: 2});
    const before = await first.user.getUnreadState();
    await first.user.markChatsRead(observed);
    expect(await first.user.getUnreadState()).toEqual(before);
  });

  it("merges repeated receipts for a thread before resolving its sparse message count", async () => {
    const fixture = await setup();
    for (const sequence of [0, 3, 8, 12]) await append(fixture, sequence);
    await withImpl(fixture.workspace, async impl => {
      impl.storage.chatMeta.put({id: 2, title: "Other thread", started: new Date(), lastActive: new Date()});
    });
    await append(fixture, 1, "Other thread", 2);
    await runInDurableObject(fixture.user, async instance => {
      using put = vi.spyOn(instance.storage.workspaceChatSummaries, "put");
      await instance.markChatsRead([receipt(fixture.workspaceId, 0), receipt(fixture.workspaceId, 8),
        {...receipt(fixture.workspaceId, 1), chatId: 2}]);
      expect(put).toHaveBeenCalledTimes(1);
    });
    expect(await chat(fixture.user)).toMatchObject({readThroughSequence: 8, unreadMessageCount: 1});
  });

  it("rejects invalid bulk commands before writing any horizon, and keeps users isolated", async () => {
    const fixture = await setup(), other = await setup();
    await append(fixture, 0);
    await runInDurableObject(fixture.user, async instance => {
      await expect(instance.markChatsRead([receipt(fixture.workspaceId, 0), receipt(fixture.workspaceId, -2)]))
        .rejects.toThrow("Invalid timeline");
      await expect(instance.markChatUnread(fixture.workspaceId, 1, 1, 0)).rejects.toThrow("Invalid timeline");
    });
    expect((await chat(fixture.user)).readThroughSequence).toBe(-1);
    expect((await other.user.getUnreadState()).unreadMessageCount).toBe(0);
    await fixture.user.deleteGadget(fixture.workspaceId);
    expect((await fixture.user.getUnreadState()).chats).toEqual([]);
  });

  it("keeps the historical upgrade baseline read and preserves legacy horizons while rebuilding summaries", async () => {
    const fixture = await setup();
    await append(fixture, 0);
    await withImpl(fixture.workspace, async impl => impl.storage.unreadBaseline.put({1: 0}));
    await runInDurableObject(fixture.user, (_instance, ctx) => {
      makeUserStorage(ctx.storage).chatReadStates.put({workspaceId: fixture.workspaceId, chatId: 1,
        chatTitle: "Obsolete", latestSequence: 999, latestMessagePreview: "Must not persist",
        readThroughSequence: 0, readEpoch: 2, unreadMessageCount: 1});
    });
    await evictDurableObject(fixture.user);
    expect(await chat(fixture.user)).toMatchObject({readThroughSequence: 0, readEpoch: 2,
      unreadMessageCount: 0, latestSequence: 0, latestMessagePreview: "Hello"});
    await append(fixture, 5);
    expect((await chat(fixture.user)).unreadMessageCount).toBe(1);
    const rows = await persisted(fixture.user);
    expect(rows.some(([key]) => key.startsWith("chatReadStates:"))).toBe(false);
  });
});
