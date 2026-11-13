import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { RpcStub, RpcTarget } from "capnweb";
import * as fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { PROPERTY_RUN_OPTIONS } from "@gadgets/scripts/property-runs";
import type { AiChatAuthorInfo, ChatReadState, UnreadStateSubscriber, UnreadSummaryUpdate, UserUnreadState } from "@gadgets/workshop-shared/api";
import { UserDurableObject, type ChatMessageProgress } from "../src/user.js";
import { OverseerDurableObject } from "../src/overseer.js";
import { makeUserStorage } from "../src/storage-schema/user-storage.js";
import { chatKey } from "../src/storage-schema/overseer-storage.js";
import { OVERSEER_STORAGE_VERSION } from "../src/storage-schema/overseer-migrations.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}
type Impl = OverseerDurableObject["impl"];
const withImpl = <T>(stub: DurableObjectStub<OverseerDurableObject>, fn: (impl: Impl) => Promise<T>) =>
  runInDurableObject(env.TEST_OVERSEER.get(stub.id), instance => fn(instance.impl));
// Most tests exercise already-participating users; default-policy tests opt out explicitly.
const setup = async (user?: DurableObjectStub<UserDurableObject>, participating = true) => {
  if (!user) {
    const id = crypto.randomUUID();
    user = env.TEST_USER.getByName(id);
    await runInDurableObject(user, (_instance, ctx) => makeUserStorage(ctx.storage).profile.put({type: "user", id, name: "Owner"}));
  }
  const profile = await user.whoami();
  const workspace = env.TEST_OVERSEER.getByName(crypto.randomUUID());
  const workspaceId = workspace.id.toString();
  await user.newWorkspace(workspaceId, "Workspace");
  await withImpl(workspace, async impl => {
    impl.storage.version.put(OVERSEER_STORAGE_VERSION);
    impl.storage.chatMeta.put({id: 1, title: "Demo", started: new Date(), lastActive: new Date()});
    impl.storage.nextChatSequences.put({chatId: 1, nextSequence: 0, notificationParticipants: participating ? [profile.id] : []});
    impl.storage.ownerId.put(user!.id.toString());
    impl.ownerId = user!.id.toString();
  });
  return {user, workspace, workspaceId};
};
type Fixture = Awaited<ReturnType<typeof setup>>;
const write = (impl: Impl, sequence: number, message = "Hello", chatId = 1,
  author: AiChatAuthorInfo = {type: "agent", id: "test", name: "Test"}) => {
  impl.storage.chats.put({chatId, sequence, timestamp: new Date(1_000 + sequence),
    author, type: "message", message});
  impl.storage.nextChatSequences.put({...impl.storage.nextChatSequences.get(chatId), chatId, nextSequence: sequence + 1});
};
const append = (fixture: Fixture, sequence: number, message = "Hello") =>
  withImpl(fixture.workspace, async impl => { write(impl, sequence, message); await impl.deliverDirtyChats(); });
const cursor = (fixture: Fixture) => runInDurableObject(fixture.user, (_instance, ctx) =>
  makeUserStorage(ctx.storage).chatReadCursors.get(`${fixture.workspaceId}:1`));
const outbox = (fixture: Fixture) => runInDurableObject(fixture.user, (_instance, ctx) =>
  [...makeUserStorage(ctx.storage).notificationOutbox.list()]);
const drained = (fixture: Fixture) => vi.waitFor(async () => expect(await outbox(fixture)).toEqual([]));
const setRead = (fixture: Fixture, sequence: number | undefined, rewind = false, chatId = 1) =>
  withImpl(fixture.workspace, impl => impl.setChatReadHorizon(fixture.user.id.toString(), chatId, sequence, rewind));
const progress = (first = 1, latest = first): ChatMessageProgress => ({
  head: {chatTitle: "Demo", latestSequence: first, latestMessagePreview: "Hello"},
  headUpdatedAt: new Date(0), hasParticipated: true,
  firstMessageSequence: first, firstVisibleSequence: first, latestVisibleSequence: latest, notifications: [],
});
const event = (sequence: number) => ({id: crypto.randomUUID(), sequence,
  kind: "taskCompleted" as const, chatTitle: "Demo"});
const notificationBaselines = (fixture: Fixture, user = fixture.user) => withImpl(fixture.workspace, async impl =>
  [...impl.storage.chatMeta.list()].map(meta => ({chatId: meta.id,
    head: impl.chatHead(meta.id),
    headUpdatedAt: meta.lastActive,
    hasParticipated: impl.hasChatParticipation(meta.id, user.id.toString()),
    notifiedThroughSequence: impl.nextChatSequencePeek(meta.id) - 1,
    readThroughVisibleSequence: impl.storage.nextChatSequences.get(meta.id)?.visibleThroughSequence ?? 0})));
const addReader = async (fixture: Fixture, participating = true) => {
  const owner = await fixture.user.whoami();
  const profile = {type: "user" as const, id: `reader-${crypto.randomUUID()}`, name: "Reader"};
  const reader = env.TEST_USER.getByName(profile.id);
  await runInDurableObject(fixture.user, (_instance, ctx) => makeUserStorage(ctx.storage).profile.put(owner));
  await runInDurableObject(reader, (_instance, ctx) => makeUserStorage(ctx.storage).profile.put(profile));
  await withImpl(fixture.workspace, async impl => {
    if (participating) {
      const counter = impl.storage.nextChatSequences.get(1)!;
      impl.storage.nextChatSequences.put({...counter, notificationParticipants: [...counter.notificationParticipants ?? [], profile.id]});
    }
    impl.storage.collaborators.put({profile,
      addedBy: [{type: "user", sharer: owner.id, role: "build", created: new Date()}]});
  });
  await reader.recordSharedWorkspaceOpen(fixture.workspaceId, "Workspace", owner, "build", await notificationBaselines(fixture, reader));
  return {reader, owner, profile};
};

// Fault at the source's real dispatch/ACK boundary, not the test-pool RPC wrapper.
const interceptUsers = (impl: Impl,
  intercept: (user: DurableObjectStub<UserDurableObject>, method: PropertyKey) => unknown,
) => {
  const original = impl.users;
  impl.users = new Proxy(original, {
    get(target, key) {
      if (key === "get") return (id: DurableObjectId) => new Proxy(target.get(id), {
        get(user, member) {
          return intercept(user, member) ?? Reflect.get(user, member);
        },
      });
      if (key === "idFromString") return (id: string) => target.idFromString(id);
      if (key === "idFromName") return (name: string) => target.idFromName(name);
      return Reflect.get(target, key);
    },
  });
  return () => { impl.users = original; };
};
const interceptDelivery = (impl: Impl,
  dispatch: (user: DurableObjectStub<UserDurableObject>,
    ...args: Parameters<UserDurableObject["messageArrived"]>) => Promise<void>,
) => interceptUsers(impl, (user, method) => method === "messageArrived"
  ? (...args: Parameters<UserDurableObject["messageArrived"]>) => dispatch(user, ...args) : undefined);

describe("persisted visible positions", () => {
  it("coalesces a synchronous batch into one background fanout pass", async () => {
    const fixture = await setup();
    await withImpl(fixture.workspace, async impl => {
      using delivery = vi.spyOn(impl, "deliverDirtyChats");
      for (let sequence = 0; sequence < 20; sequence++) write(impl, sequence);
      await vi.waitFor(() => expect(delivery).toHaveBeenCalledOnce());
      await delivery.mock.results[0].value;
    });
    expect(await cursor(fixture)).toMatchObject({unreadCount: 20});
  });

  it("numbers visible messages densely and stamps non-visible boundaries without allocating again on updates", async () => {
    const fixture = await setup();
    await withImpl(fixture.workspace, async impl => {
      write(impl, 0); write(impl, 4, "   ");
      impl.storage.chats.put({chatId: 1, sequence: 7, timestamp: new Date(1_007), type: "error",
        author: {type: "agent", id: "test", name: "Test"}, message: "Failed tool"});
      impl.storage.chats.put({chatId: 1, sequence: 10, timestamp: new Date(1_010), type: "message",
        author: {type: "agent", id: "test", name: "Test"}, message: "Expansion", generatedBySlashCommandSequence: 0});
      write(impl, 12, "Second");
      const old = impl.storage.chats.get(chatKey(1, 12))!;
      impl.storage.chats.put({...old, timestamp: new Date()});
      impl.storage.chats.put({chatId: 1, sequence: 13, timestamp: new Date(1_013), type: "message",
        author: {type: "agent", id: "test", name: "Test"}, message: "",
        attachments: [{id: crypto.randomUUID(), mimeType: "image/png", size: 1}]});
      expect([...impl.storage.chats.list()].map(row => row.visibleThroughSequence)).toEqual([1, 1, 1, 1, 2, 3]);
      for (const message of impl.storage.chats.list()) {
        expect(impl.hydrateChatMessageForClient(message)).not.toHaveProperty("visibleThroughSequence");
      }
      // Raw allocator must preserve the dense prefix too.
      impl.nextChatSequence(1);
      expect(impl.storage.nextChatSequences.get(1)).toMatchObject({visibleThroughSequence: 3, trackingStartSequence: 0});
      await impl.deliverDirtyChats();
    });
    expect(await cursor(fixture)).toMatchObject({readThroughVisibleSequence: 0, latestVisibleSequence: 3, unreadCount: 3});
  });

  it("treats old unnumbered history as read, with no backfill or history scan on first arrival", async () => {
    const fixture = await setup();
    await withImpl(fixture.workspace, async impl => {
      impl.ownerId = undefined;
      impl.storage.version.put(6);
      write(impl, 0, "Old"); write(impl, 4, "Old tail");
      impl.ownerId = fixture.user.id.toString();
    });
    await evictDurableObject(fixture.workspace);
    await withImpl(fixture.workspace, async impl => {
      expect(impl.storage.version.get()).toBe(OVERSEER_STORAGE_VERSION);
      using scan = vi.spyOn(impl.storage.chats, "list");
      impl.storage.chatMeta.put({...impl.storage.chatMeta.get(1)!, title: "Renamed", lastActive: impl.getChatTimestamp()});
      await impl.deliverDirtyChats();
      write(impl, 10); write(impl, 15);
      await impl.deliverDirtyChats();
      expect(scan).not.toHaveBeenCalled();
      expect(impl.storage.chats.get(chatKey(1, 4))?.visibleThroughSequence).toBeUndefined();
    });
    expect(await cursor(fixture)).toMatchObject({readThroughSequence: 9, readThroughVisibleSequence: 0, unreadCount: 2});
    await setRead(fixture, 0, true);
    expect(await cursor(fixture)).toMatchObject({readThroughVisibleSequence: 0, unreadCount: 2});
  });

  it("synthesizes a missing horizon immediately before the first ordinal, including coalesced packets", async () => {
    const fixture = await setup();
    await fixture.user.messageArrived(fixture.workspaceId, 1, progress(4, 6));
    expect(await cursor(fixture)).toMatchObject({readThroughVisibleSequence: 3, latestVisibleSequence: 6, unreadCount: 3});
    await fixture.user.messageArrived(fixture.workspaceId, 1, progress(4, 6));
    await fixture.user.messageArrived(fixture.workspaceId, 1, progress(2, 4));
    expect(await cursor(fixture)).toMatchObject({readThroughVisibleSequence: 3, latestVisibleSequence: 6, unreadCount: 3});
  });
});

describe("chat notification preferences", () => {
  it("publishes a direct mute before participation even though the effective default is already off", async () => {
    const fixture = await setup(undefined, false);
    await append(fixture, 0);
    const snapshots: UserUnreadState[] = [], deltas: Parameters<UnreadStateSubscriber["chatUpdated"]>[] = [];
    class Subscriber extends RpcTarget implements UnreadStateSubscriber {
      async updated(state: UserUnreadState) { snapshots.push(state); }
      async summaryUpdated() {}
      async chatUpdated(...args: Parameters<UnreadStateSubscriber["chatUpdated"]>) { deltas.push(args); }
    }
    using callback = new RpcStub(new Subscriber());
    {
      using _subscription = await fixture.user.subscribeToUnreadState({workspaceId: fixture.workspaceId}, callback);
      await vi.waitFor(() => expect(snapshots).toHaveLength(1));
      expect(snapshots[0].chats[0]).toMatchObject({notificationsEnabled: false});
      expect(snapshots[0].chats[0].notificationsEnabledOverride).toBeUndefined();
      await withImpl(fixture.workspace, impl => impl.setChatNotificationsEnabled(fixture.user.id.toString(), 1, false));
      await vi.waitFor(() => expect(deltas.at(-1)?.[2]).toMatchObject({notificationsEnabled: false,
        notificationsEnabledOverride: false, unreadMessageCount: 1, readThroughSequence: -1}));
    }
    expect(await fixture.user.getWorkspaceUnreadState(fixture.workspaceId)).toMatchObject([
      {notificationsEnabled: false, notificationsEnabledOverride: false},
    ]);
    expect(await fixture.user.getUnreadThreads()).toEqual([]);
    expect((await fixture.user.getUnreadSummary()).unreadMessageCount).toBe(0);
    await withImpl(fixture.workspace, impl => impl.setChatNotificationsEnabled(fixture.user.id.toString(), 1, true));
    expect(await fixture.user.getUnreadThreads()).toMatchObject([
      {notificationsEnabled: true, notificationsEnabledOverride: true, unreadMessageCount: 1, readThroughSequence: -1},
    ]);
  });

  it.each([
    {missing: "source chat", error: "No such chatId"},
    {missing: "user chat", error: "Chat has been deleted"},
    {missing: "user workspace", error: "Workspace is not available"},
  ])("rejects a preference change when its $missing is gone", async ({missing, error}) => {
    const fixture = await setup();
    await append(fixture, 0);
    if (missing === "source chat") {
      await withImpl(fixture.workspace, async impl => { impl.storage.chatMeta.delete(1); });
    } else if (missing === "user chat") {
      await fixture.user.messageArrived(fixture.workspaceId, 1, null);
    } else {
      await fixture.user.workspaceRemoved(fixture.workspaceId);
    }
    await expect(withImpl(fixture.workspace,
      impl => impl.setChatNotificationsEnabled(fixture.user.id.toString(), 1, false))).rejects.toThrow(error);
  });

  it("accepts repeated preference changes when the chat still exists", async () => {
    const fixture = await setup();
    await withImpl(fixture.workspace, impl => impl.setChatNotificationsEnabled(fixture.user.id.toString(), 1, false));
    const before = await cursor(fixture);
    await withImpl(fixture.workspace, impl => impl.setChatNotificationsEnabled(fixture.user.id.toString(), 1, false));
    expect(await cursor(fixture)).toEqual(before);
  });

  it.each(["read", "alarm"] as const)("consumes legacy queued alerts for a muted chat on %s", async recovery => {
    const fixture = await setup(undefined, false);
    await withImpl(fixture.workspace, impl => impl.setChatNotificationsEnabled(fixture.user.id.toString(), 1, false));
    await append(fixture, 0);
    const alert = {...event(0), kind: "permissionRequested" as const};
    using publish = vi.spyOn(UserDurableObject.prototype, "publishNotification").mockResolvedValue();
    await runInDurableObject(fixture.user, async (instance, ctx) => {
      // Seed through the live collections so the hydrated queue headers stay in sync.
      const storage = instance["storage"];
      const current = storage.chatReadCursors.get(`${fixture.workspaceId}:1`)!;
      // Recover an older queued delivery after the user explicitly muted the chat.
      storage.chatReadCursors.put({...current, notifiedThroughSequence: -1});
      storage.notificationOutbox.put({...alert, workspaceId: fixture.workspaceId, chatId: 1,
        expiresAt: new Date(Date.now() + 60_000), failedSubscriptions: ["offline-device"]});
      await ctx.storage.setAlarm(Date.now() + 30_000);
    });
    if (recovery === "read") await setRead(fixture, 0);
    else {
      await evictDurableObject(fixture.user);
      await runDurableObjectAlarm(fixture.user);
    }
    expect(await outbox(fixture)).toEqual([]);
    expect(await cursor(fixture)).toMatchObject({notifiedThroughSequence: 0,
      unreadCount: recovery === "read" ? 0 : 1});
    expect(publish).not.toHaveBeenCalled();
    expect(await runInDurableObject(fixture.user, (_instance, ctx) => ctx.storage.getAlarm())).toBeNull();
  });

  it.each([false, true])("preserves a collaborator's delayed first arrival across preference and reopen (enabled: %s)", async enabled => {
    const fixture = await setup(); const {reader, owner} = await addReader(fixture);
    await withImpl(fixture.workspace, async impl => {
      impl.storage.chatMeta.put({id: 2, title: "New chat", started: new Date(), lastActive: new Date()});
      await impl.deliverDirtyChats();
      await impl.setChatNotificationsEnabled(reader.id.toString(), 2, enabled);
      const restore = interceptDelivery(impl, async (user, ...args) => {
        if (user.id.equals(reader.id)) throw new Error("Reader temporarily unavailable");
        await user.messageArrived(...args);
      });
      try {
        write(impl, 0, "First arrival", 2);
        await expect(impl.deliverDirtyChats()).rejects.toThrow("Reader temporarily unavailable");
      } finally {
        restore();
      }
    });
    await evictDurableObject(reader);
    await reader.recordSharedWorkspaceOpen(fixture.workspaceId, "Workspace", owner, "build", await notificationBaselines(fixture, reader));
    await withImpl(fixture.workspace, impl => impl.deliverDirtyChats());
    expect((await reader.getWorkspaceUnreadState(fixture.workspaceId)).find(chat => chat.chatId === 2))
      .toMatchObject({notificationsEnabled: enabled, readThroughSequence: -1, unreadMessageCount: 1});
    expect(await reader.getUnreadThreads()).toMatchObject(enabled ? [{chatId: 2, unreadMessageCount: 1}] : []);
    expect((await reader.getUnreadSummary()).unreadMessageCount).toBe(enabled ? 1 : 0);
  });

  it.each([false, true])("does not enroll legacy history through a preference and metadata update (enabled: %s)", async enabled => {
    const fixture = await setup();
    await withImpl(fixture.workspace, async impl => {
      impl.ownerId = undefined;
      impl.storage.version.put(6);
      write(impl, 0, "Old"); write(impl, 99, "Old tail");
      impl.ownerId = fixture.user.id.toString();
    });
    await evictDurableObject(fixture.workspace);
    await withImpl(fixture.workspace, async impl => {
      await impl.deliverDirtyChats();
      await impl.setChatNotificationsEnabled(fixture.user.id.toString(), 1, enabled);
    });
    await evictDurableObject(fixture.user);
    await withImpl(fixture.workspace, async impl => {
      impl.storage.chatMeta.put({...impl.storage.chatMeta.get(1)!, title: "Renamed", lastActive: impl.getChatTimestamp()});
      await impl.deliverDirtyChats();
    });
    expect(await cursor(fixture)).toMatchObject({notificationsEnabled: enabled, unreadCount: 0});
    expect((await cursor(fixture))?.readThroughVisibleSequence).toBeUndefined();
    await append(fixture, 100, "First tracked message");
    expect(await cursor(fixture)).toMatchObject({readThroughSequence: 99, readThroughVisibleSequence: 0,
      latestVisibleSequence: 1, unreadCount: 1, head: {chatTitle: "Renamed"}});
    expect((await fixture.user.getUnreadSummary()).unreadMessageCount).toBe(enabled ? 1 : 0);
  });

  it.each([false, true])("keeps a delayed own message read across a preference update (enabled: %s)", async enabled => {
    const fixture = await setup(); const {owner} = await addReader(fixture);
    await withImpl(fixture.workspace, async impl => {
      write(impl, 0, "Mine", 1, owner); await impl.deliverDirtyChats();
      const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
      const restore = interceptDelivery(impl, async (user, ...args) => {
        if (user.id.equals(fixture.user.id)) { entered.resolve(); await release.promise; }
        await user.messageArrived(...args);
      });
      try {
        write(impl, 4, "Mine while fanout waits", 1, owner);
        const delivery = impl.deliverDirtyChats();
        await entered.promise;
        await impl.setChatNotificationsEnabled(fixture.user.id.toString(), 1, enabled);
        release.resolve(); await delivery;
      } finally {
        release.resolve(); restore();
      }
    });
    await evictDurableObject(fixture.user);
    expect(await cursor(fixture)).toMatchObject({readThroughSequence: 4, readThroughVisibleSequence: 2,
      latestVisibleSequence: 2, unreadCount: 0, notificationsEnabled: enabled});
    await withImpl(fixture.workspace, async impl => {
      impl.markChatDirty(1, 4, 2); await impl.deliverDirtyChats();
    });
    expect(await cursor(fixture)).toMatchObject({readThroughSequence: 4, unreadCount: 0});
    expect((await fixture.user.getUnreadSummary()).unreadMessageCount).toBe(0);
  });

  it.each([false, true])("defaults nonparticipants to muted badges, inbox and completion alerts across eviction (spawned: %s)", async spawned => {
    const fixture = await setup(undefined, false);
    const {reader} = await addReader(fixture, false);
    using publish = vi.spyOn(UserDurableObject.prototype, "publishNotification").mockResolvedValue();
    await withImpl(fixture.workspace, async impl => {
      if (spawned) impl.storage.chatMeta.put({...impl.storage.chatMeta.get(1)!, spawnerName: "Spawner"});
      write(impl, 0, "Task");
      write(impl, 1, "Done");
      impl.storage.chatNotifications.put({id: crypto.randomUUID(), chatId: 1, sequence: 1,
        userId: fixture.user.id.toString(), kind: "taskCompleted"});
      await impl.deliverDirtyChats();
      expect([...impl.storage.chats.list()]).toHaveLength(2);
    });
    await evictDurableObject(fixture.workspace);
    await append(fixture, 2, "Later callback");
    for (const user of [fixture.user, reader]) {
      expect((await user.getUnreadSummary()).unreadMessageCount).toBe(0);
      expect(await user.getUnreadThreads()).toEqual([]);
      expect(await user.getWorkspaceUnreadState(fixture.workspaceId)).toMatchObject([
        {chatId: 1, readThroughSequence: -1, unreadMessageCount: 3, notificationsEnabled: false},
      ]);
    }
    await setRead(fixture, 0);
    expect(await cursor(fixture)).toMatchObject({readThroughSequence: 0, unreadCount: 2});
    expect(await setRead(fixture, 0, true)).toBe(true);
    expect(await cursor(fixture)).toMatchObject({readThroughSequence: -1, unreadCount: 3});
    expect((await fixture.user.getUnreadSummary()).unreadMessageCount).toBe(0);
    expect(await outbox(fixture)).toEqual([]);
    expect(publish).not.toHaveBeenCalled();
  });

  it.each([false, true])("delivers and recovers approvals for nonparticipants without subscribing them (spawned: %s)", async spawned => {
    const original = await setup(undefined, false);
    const {reader, owner} = await addReader(original, false);
    const fixture = {...original, user: reader};
    const approval = {...event(0), kind: "permissionRequested" as const};
    using publish = vi.spyOn(UserDurableObject.prototype, "publishNotification")
      .mockRejectedValue(new Error("Device offline"));
    await withImpl(fixture.workspace, async impl => {
      if (spawned) impl.storage.chatMeta.put({...impl.storage.chatMeta.get(1)!, spawnerName: "Spawner"});
      write(impl, 0, "Waiting for approval");
      for (const alert of [approval, event(0)]) impl.storage.chatNotifications.put({
        ...alert, chatId: 1, userId: fixture.user.id.toString()});
      await impl.deliverDirtyChats();
    });
    await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
    expect(await outbox(fixture)).toMatchObject([{id: approval.id}]);
    await setRead(fixture, 0);
    await withImpl(fixture.workspace, async impl => {
      write(impl, 1, "Another automated result");
      impl.storage.chatNotifications.put({...event(1), chatId: 1, userId: fixture.user.id.toString()});
      await impl.deliverDirtyChats();
    });
    await fixture.user.recordSharedWorkspaceOpen(fixture.workspaceId, "Workspace", owner, "build", await notificationBaselines(fixture));
    expect(await outbox(fixture)).toMatchObject([{id: approval.id}]);
    publish.mockResolvedValue(undefined);
    await evictDurableObject(fixture.user);
    await runDurableObjectAlarm(fixture.user);
    await drained(fixture);
    expect(publish.mock.calls.map(([alert]) => alert.id)).toEqual([approval.id, approval.id]);
    await withImpl(fixture.workspace, async impl => {
      impl.markChatDirty(1, 0, 1); await impl.deliverDirtyChats();
    });
    await drained(fixture);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(await cursor(fixture)).toMatchObject({hasParticipated: false, readThroughSequence: 0, unreadCount: 1});
    for (const user of [original.user, reader]) {
      expect(await user.getUnreadThreads()).toEqual([]);
      expect((await user.getUnreadSummary()).unreadMessageCount).toBe(0);
    }
  });

  it.each([false, true])("preserves unread history with private overrides and only future alerts (spawned: %s)", async spawned => {
    const fixture = await setup();
    if (spawned) await withImpl(fixture.workspace, async impl => {
      impl.storage.chatMeta.put({...impl.storage.chatMeta.get(1)!, spawnerName: "Spawner"});
    });
    const {reader} = await addReader(fixture);
    using publish = vi.spyOn(UserDurableObject.prototype, "publishNotification").mockResolvedValue();
    await append(fixture, 0, "Existing activity");
    const setEnabled = (enabled: boolean) => withImpl(fixture.workspace,
      impl => impl.setChatNotificationsEnabled(fixture.user.id.toString(), 1, enabled));
    await setEnabled(false);
    await evictDurableObject(fixture.user);
    await withImpl(fixture.workspace, async impl => {
      write(impl, 1, "Muted activity");
      for (const kind of ["taskCompleted", "permissionRequested"] as const) {
        impl.storage.chatNotifications.put({id: crypto.randomUUID(), chatId: 1, sequence: 1,
          userId: fixture.user.id.toString(), kind});
      }
      await impl.deliverDirtyChats();
    });
    expect(await outbox(fixture)).toEqual([]);
    expect(await cursor(fixture)).toMatchObject({notifiedThroughSequence: 1});
    expect(publish).not.toHaveBeenCalled();
    expect((await fixture.user.getWorkspaceUnreadState(fixture.workspaceId))[0])
      .toMatchObject({notificationsEnabled: false, readThroughSequence: -1, unreadMessageCount: 2});
    expect((await fixture.user.getUnreadSummary()).unreadMessageCount).toBe(0);
    await setEnabled(true);
    expect((await fixture.user.getUnreadSummary()).unreadMessageCount).toBe(2);
    expect(publish).not.toHaveBeenCalled();
    await evictDurableObject(fixture.user);
    await withImpl(fixture.workspace, async impl => {
      write(impl, 2, "Future activity");
      impl.storage.chatNotifications.put({id: crypto.randomUUID(), chatId: 1, sequence: 2,
        userId: fixture.user.id.toString(), kind: "permissionRequested"});
      await impl.deliverDirtyChats();
    });
    await drained(fixture);
    await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
    expect((await fixture.user.getWorkspaceUnreadState(fixture.workspaceId))[0])
      .toMatchObject({notificationsEnabled: true, readThroughSequence: -1, unreadMessageCount: 3});
    expect((await reader.getWorkspaceUnreadState(fixture.workspaceId))[0])
      .toMatchObject({notificationsEnabled: true, unreadMessageCount: 3});
    // Retrying the same preference must not consume activity that arrived since it was enabled.
    await setEnabled(true);
    expect((await fixture.user.getUnreadSummary()).unreadMessageCount).toBe(3);
    await setEnabled(false);
    expect((await fixture.user.getUnreadSummary()).unreadMessageCount).toBe(0);
    await setRead(fixture, 0);
    await setEnabled(true);
    await fixture.user.messageArrived(fixture.workspaceId, 1, {...progress(2), notifications: [event(2)]});
    await drained(fixture);
    expect((await fixture.user.getUnreadSummary()).unreadMessageCount).toBe(2);
    expect(publish).toHaveBeenCalledOnce();
  });

  it("clears a normal chat's queued permission alert when muted and never retries it after unmuting", async () => {
    const fixture = await setup(undefined, false);
    using publish = vi.spyOn(UserDurableObject.prototype, "publishNotification")
      .mockRejectedValue(new Error("Push unavailable"));
    await withImpl(fixture.workspace, async impl => {
      write(impl, 0);
      impl.storage.chatNotifications.put({id: crypto.randomUUID(), chatId: 1, sequence: 0,
        userId: fixture.user.id.toString(), kind: "permissionRequested"});
      await impl.deliverDirtyChats();
    });
    await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
    expect(await outbox(fixture)).toHaveLength(1);
    await withImpl(fixture.workspace, impl => impl.setChatNotificationsEnabled(fixture.user.id.toString(), 1, false));
    expect(await outbox(fixture)).toEqual([]);
    await evictDurableObject(fixture.user);
    await withImpl(fixture.workspace, impl => impl.setChatNotificationsEnabled(fixture.user.id.toString(), 1, true));
    await runDurableObjectAlarm(fixture.user);
    expect(publish).toHaveBeenCalledOnce();
  });

  it("preserves explicit opt-in across eviction and collaborator admission", async () => {
    const fixture = await setup(undefined, false);
    const {reader, owner} = await addReader(fixture, false);
    await append(fixture, 0);
    await withImpl(fixture.workspace, async impl => {
      await impl.setChatNotificationsEnabled(fixture.user.id.toString(), 1, true);
      impl.storage.chatMeta.put({...impl.storage.chatMeta.get(1)!, spawnerName: "Spawner"});
    });
    await evictDurableObject(fixture.workspace);
    await withImpl(fixture.workspace, impl => impl.deliverDirtyChats());
    await append(fixture, 1);
    await reader.recordSharedWorkspaceOpen(fixture.workspaceId, "Workspace", owner, "build", await notificationBaselines(fixture, reader));
    expect((await fixture.user.getWorkspaceUnreadState(fixture.workspaceId))[0])
      .toMatchObject({notificationsEnabled: true, unreadMessageCount: 2});
    expect((await reader.getWorkspaceUnreadState(fixture.workspaceId))[0])
      .toMatchObject({notificationsEnabled: false, unreadMessageCount: 2});
  });

  it.each([false, true])("keeps existing chats subscribed without history backfill (spawned: %s)", async spawned => {
    const fixture = await setup(undefined, false);
    await withImpl(fixture.workspace, async impl => {
      if (spawned) impl.storage.chatMeta.put({...impl.storage.chatMeta.get(1)!, spawnerName: "Spawner"});
      // Existing chats have no participation policy marker, regardless of their authors.
      impl.storage.nextChatSequences.put({chatId: 1, nextSequence: 0});
    });
    const {reader, owner, profile} = await addReader(fixture, false);
    await append(fixture, 0, "Existing activity");
    for (const user of [fixture.user, reader]) {
      expect((await user.getWorkspaceUnreadState(fixture.workspaceId))[0])
        .toMatchObject({notificationsEnabled: true, unreadMessageCount: 1});
    }
    await withImpl(fixture.workspace, impl => impl.setChatNotificationsEnabled(fixture.user.id.toString(), 1, false));
    await evictDurableObject(fixture.workspace);
    await evictDurableObject(reader);
    await withImpl(fixture.workspace, async impl => {
      expect(impl.storage.version.get()).toBe(7);
      expect(impl.storage.nextChatSequences.get(1)?.notificationParticipants).toBeUndefined();
      expect([...impl.storage.dirtyChats.list()]).toEqual([]);
      using scan = vi.spyOn(impl.storage.chats, "list");
      write(impl, 1, "Owner keeps participating while muted", 1, owner);
      write(impl, 2, "Reader keeps participating", 1, profile);
      write(impl, 3, "Agent replies");
      await impl.deliverDirtyChats();
      expect(scan).not.toHaveBeenCalled();
      expect(impl.storage.nextChatSequences.get(1)?.notificationParticipants).toBeUndefined();
    });
    expect((await fixture.user.getWorkspaceUnreadState(fixture.workspaceId))[0])
      .toMatchObject({notificationsEnabled: false, unreadMessageCount: 4});
    expect(await fixture.user.getUnreadThreads()).toEqual([]);
    expect(await reader.getUnreadThreads()).toMatchObject([{chatId: 1, unreadMessageCount: 4}]);
  });

  it("keeps existing private cursors subscribed without waking their workspace", async () => {
    const fixture = await setup();
    await fixture.user.messageArrived(fixture.workspaceId, 1, {...progress(1), hasParticipated: undefined});
    await evictDurableObject(fixture.user);
    expect((await fixture.user.getUnreadSummary()).unreadMessageCount).toBe(1);
    expect(await fixture.user.getUnreadThreads()).toMatchObject([{chatId: 1, notificationsEnabled: true}]);
  });

  it("does not let delayed nonparticipation undo a first message's opt-in", async () => {
    const fixture = await setup(undefined, false);
    await fixture.user.messageArrived(fixture.workspaceId, 1, {...progress(1), hasParticipated: false});
    expect((await fixture.user.getUnreadSummary()).unreadMessageCount).toBe(0);
    await fixture.user.messageArrived(fixture.workspaceId, 1, progress(2));
    await fixture.user.messageArrived(fixture.workspaceId, 1, {...progress(1), hasParticipated: false});
    expect((await fixture.user.getWorkspaceUnreadState(fixture.workspaceId))[0])
      .toMatchObject({notificationsEnabled: true, unreadMessageCount: 2});
  });

  it.each([false, true])("opts in only the first human participant, including coalesced replies (spawned: %s)", async spawned => {
    const fixture = await setup(undefined, false);
    const {reader, owner} = await addReader(fixture, false);
    await withImpl(fixture.workspace, async impl => {
      if (spawned) impl.storage.chatMeta.put({...impl.storage.chatMeta.get(1)!, spawnerName: "Spawner"});
      write(impl, 0, "Automated activity");
      await impl.deliverDirtyChats();
    });
    expect(await fixture.user.getUnreadThreads()).toEqual([]);
    await withImpl(fixture.workspace, async impl => {
      write(impl, 1, "I want to join in", 1, owner);
      write(impl, 2, "Agent response");
      await impl.deliverDirtyChats();
    });
    await evictDurableObject(fixture.user);
    expect(await fixture.user.getUnreadThreads()).toMatchObject([{chatId: 1, unreadMessageCount: 3}]);
    expect(await reader.getUnreadThreads()).toEqual([]);
    expect((await reader.getWorkspaceUnreadState(fixture.workspaceId))[0])
      .toMatchObject({notificationsEnabled: false, unreadMessageCount: 3});
    expect(await cursor(fixture)).toMatchObject({hasParticipated: true});
    expect((await cursor(fixture))?.notificationsEnabled).toBeUndefined();
    await withImpl(fixture.workspace, impl => impl.setChatNotificationsEnabled(fixture.user.id.toString(), 1, false));
    await evictDurableObject(fixture.workspace);
    await withImpl(fixture.workspace, async impl => {
      write(impl, 3, "Still participating, still muted", 1, owner);
      write(impl, 4, "Another reply");
      await impl.deliverDirtyChats();
    });
    expect(await fixture.user.getUnreadThreads()).toEqual([]);
    expect(await cursor(fixture)).toMatchObject({hasParticipated: true, notificationsEnabled: false, unreadCount: 5});
  });

  it("keeps a mute chosen before first participation, including slash commands", async () => {
    const fixture = await setup(undefined, false);
    const owner = await fixture.user.whoami();
    await withImpl(fixture.workspace, async impl => {
      await impl.setChatNotificationsEnabled(fixture.user.id.toString(), 1, false);
      impl.storage.chats.put({chatId: 1, sequence: 0, timestamp: new Date(), author: owner,
        type: "slashCommand", request: {id: {gatekeeperId: 1, commandId: "test"}, args: ""}});
      await impl.deliverDirtyChats();
    });
    expect(await cursor(fixture)).toMatchObject({hasParticipated: true, notificationsEnabled: false, unreadCount: 0});
    expect((await fixture.user.getWorkspaceUnreadState(fixture.workspaceId))[0].notificationsEnabled).toBe(false);
  });

});

describe("local counts and explicit read boundaries", () => {
  it("consumes a single own message only when caught up, preserving counts for gaps and other readers", async () => {
    const fixture = await setup(); const {reader, owner} = await addReader(fixture);
    for (const sequence of [0, 4]) {
      await withImpl(fixture.workspace, async impl => {
        write(impl, sequence, "Mine", 1, owner); await impl.deliverDirtyChats();
      });
      expect(await cursor(fixture)).toMatchObject({readThroughSequence: sequence, unreadCount: 0});
    }
    expect((await reader.getUnreadSummary()).unreadMessageCount).toBe(2);
    await setRead(fixture, 0, true);
    await withImpl(fixture.workspace, async impl => {
      write(impl, 8, "Mine while behind", 1, owner); await impl.deliverDirtyChats();
    });
    expect(await cursor(fixture)).toMatchObject({readThroughSequence: -1, unreadCount: 3});
    await setRead(fixture, 8);
    await withImpl(fixture.workspace, async impl => {
      write(impl, 12, "Incoming"); write(impl, 16, "Mine after incoming", 1, owner);
      await impl.deliverDirtyChats();
    });
    expect(await cursor(fixture)).toMatchObject({readThroughSequence: 8, unreadCount: 2});
    await setRead(fixture, 16); await evictDurableObject(fixture.user);
    await withImpl(fixture.workspace, async impl => {
      write(impl, 20, "Mine after reset", 1, owner); await impl.deliverDirtyChats();
    });
    expect(await cursor(fixture)).toMatchObject({readThroughSequence: 20, unreadCount: 0});
    expect((await reader.getUnreadSummary()).unreadMessageCount).toBe(6);
  });

  it("does not scan expirations or touch alarms for count-only arrivals and read commands", async () => {
    const fixture = await setup(); await append(fixture, 0);
    await runInDurableObject(fixture.user, async (instance, ctx) => {
      using get = vi.spyOn(ctx.storage, "getAlarm");
      using set = vi.spyOn(ctx.storage, "setAlarm");
      using remove = vi.spyOn(ctx.storage, "deleteAlarm");
      using expirations = vi.spyOn(Reflect.get(instance, "storage").sessions, "list");
      await instance.messageArrived(fixture.workspaceId, 1, progress(2));
      await setRead(fixture, 0);
      await setRead(fixture, 0, true);
      expect(get).not.toHaveBeenCalled();
      expect(set).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
      expect(expirations).not.toHaveBeenCalled();
    });
  });

  it("uses one indexed seek for read commands, never counts raw gaps, and makes unchanged reads no-ops", async () => {
    const fixture = await setup();
    await append(fixture, 0); await append(fixture, 6, ""); await append(fixture, 12);
    expect((await fixture.user.getUnreadSummary()).unreadMessageCount).toBe(2);
    await withImpl(fixture.workspace, async impl => {
      using seek = vi.spyOn(impl.storage.chats, "list");
      await impl.setChatReadHorizon(fixture.user.id.toString(), 1, 6, false);
      expect(seek).toHaveBeenCalledOnce();
      expect(seek.mock.calls[0]?.[0]).toMatchObject({reverse: true, limit: 1});
    });
    expect(await cursor(fixture)).toMatchObject({readThroughSequence: 6, readThroughVisibleSequence: 1, unreadCount: 1});
    await setRead(fixture, 12);
    await setRead(fixture, 0); // monotonic
    await runInDurableObject(fixture.user, async instance => {
      using put = vi.spyOn(Reflect.get(instance, "storage").chatReadCursors, "put");
      await instance.getUnreadSummary(); await instance.getUnreadSummary();
      await setRead(fixture, 12);
      expect(await setRead(fixture, 13, true)).toBe(false);
      expect(put).not.toHaveBeenCalled();
      await expect(setRead(fixture, 13)).rejects.toThrow("Invalid timeline sequence");
    });
    expect(await cursor(fixture)).toMatchObject({readThroughSequence: 12, unreadCount: 0});
    expect(await setRead(fixture, 1, true)).toBe(true);
    expect(await setRead(fixture, 1, true)).toBe(false);
    expect(await cursor(fixture)).toMatchObject({readThroughSequence: 0, unreadCount: 1});
    await setRead(fixture, undefined);
    expect(await cursor(fixture)).toMatchObject({readThroughSequence: 12, unreadCount: 0});
    await setRead(fixture, undefined, true);
    expect(await cursor(fixture)).toMatchObject({readThroughSequence: 11, unreadCount: 1});
  });

  it("applies read/unread in processing order across eviction, without tokens", async () => {
    const fixture = await setup(); await append(fixture, 0);
    await setRead(fixture, 0);
    await setRead(fixture, 0, true);
    expect(await cursor(fixture)).toMatchObject({unreadCount: 1});
    await evictDurableObject(fixture.user);
    await setRead(fixture, 0);
    expect(await cursor(fixture)).toMatchObject({readThroughSequence: 0, unreadCount: 0});
  });

  it("commits read commands independently of failed alert delivery", async () => {
    const fixture = await setup();
    using publish = vi.spyOn(UserDurableObject.prototype, "publishNotification")
      .mockRejectedValue(new Error("Provider unavailable"));
    await withImpl(fixture.workspace, async impl => {
      write(impl, 0);
      impl.storage.chatNotifications.put({...event(0), chatId: 1, userId: fixture.user.id.toString()});
      await impl.deliverDirtyChats();
    });
    await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
    await expect(setRead(fixture, 0)).resolves.toBe(true);
    expect(await cursor(fixture)).toMatchObject({readThroughSequence: 0, unreadCount: 0});
    await expect(setRead(fixture, 0, true)).resolves.toBe(true);
    expect(await cursor(fixture)).toMatchObject({readThroughSequence: -1, unreadCount: 1});
    expect(publish).toHaveBeenCalledOnce();
    expect(await outbox(fixture)).toHaveLength(1);
  });

  it("preserves new arrivals before a translated read boundary is applied", async () => {
    const fixture = await setup(); await append(fixture, 0);
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const original = UserDurableObject.prototype.applyReadHorizon;
    using _source = vi.spyOn(UserDurableObject.prototype, "applyReadHorizon")
      .mockImplementationOnce(async function(...args) {
        entered.resolve(); await release.promise; return original.apply(this, args);
      });
    await runInDurableObject(fixture.user, async instance => {
      const read = setRead(fixture, 0);
      try { await entered.promise; await append(fixture, 5); }
      finally { release.resolve(); }
      await read;
    });
    expect(await cursor(fixture)).toMatchObject({readThroughVisibleSequence: 1, latestVisibleSequence: 2, unreadCount: 1});
  });

  it.each([false, true])("preserves an own-message read advance before applying a translated boundary unless explicitly rewinding: %s", async rewind => {
    const fixture = await setup(); await append(fixture, 0);
    await setRead(fixture, 0);
    await withImpl(fixture.workspace, async impl => { write(impl, 1, ""); });
    const author = await fixture.user.whoami();
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const original = UserDurableObject.prototype.applyReadHorizon;
    using source = vi.spyOn(UserDurableObject.prototype, "applyReadHorizon")
      .mockImplementationOnce(async function(...args) {
        entered.resolve(); await release.promise; return original.apply(this, args);
      });
    await runInDurableObject(fixture.user, async instance => {
      const read = rewind ? setRead(fixture, 2, true) : setRead(fixture, 1);
      try {
        await entered.promise;
        await withImpl(fixture.workspace, async impl => { write(impl, 2, "Own message", 1, author); await impl.deliverDirtyChats(); });
      } finally { release.resolve(); }
      await read;
    });
    expect(await cursor(fixture)).toMatchObject({readThroughSequence: rewind ? 1 : 2,
      readThroughVisibleSequence: rewind ? 1 : 2, latestVisibleSequence: 2, unreadCount: rewind ? 1 : 0});
    expect(source).toHaveBeenCalledOnce();
  });

  it("rehydrates all local counts without workspace RPCs or writes, independently of metadata", async () => {
    const fixture = await setup(); const other = await setup(fixture.user);
    await append(fixture, 0); await append(other, 0); await append(other, 2);
    await evictDurableObject(fixture.user);
    await runInDurableObject(fixture.user, async instance => {
      using put = vi.spyOn(Reflect.get(instance, "storage").chatReadCursors, "put");
      expect(await instance.getUnreadSummary()).toMatchObject({unreadChatCount: 2, unreadMessageCount: 3});
      expect(await instance.getUnreadThreads()).toEqual([
        expect.objectContaining({workspaceId: other.workspaceId, chatTitle: "Demo", latestSequence: 2,
          latestMessagePreview: "Hello", latestActivityAt: new Date(1_002), unreadMessageCount: 2}),
        expect.objectContaining({workspaceId: fixture.workspaceId, latestSequence: 0, unreadMessageCount: 1}),
      ]);
      expect(await instance.getWorkspaceUnreadState(other.workspaceId)).toEqual([
        {workspaceId: other.workspaceId, chatId: 1, readThroughSequence: -1, unreadMessageCount: 2, notificationsEnabled: true},
      ]);
      expect(await instance.getWorkspaceUnreadState("not-listed")).toEqual([]);
      expect(await instance.getUnreadSummary()).toEqual({unreadChatCount: 2, unreadMessageCount: 3,
        workspaces: expect.arrayContaining([
          {workspaceId: fixture.workspaceId, unreadChatCount: 1, unreadMessageCount: 1},
          {workspaceId: other.workspaceId, unreadChatCount: 1, unreadMessageCount: 2},
        ])});
      expect(put).not.toHaveBeenCalled();
      expect((await instance.getUnreadSummary()).unreadMessageCount).toBe(3);
    });
  });

  it("serves every unread query and bulk command with workspace access disabled, including after eviction", async () => {
    const fixture = await setup(), other = await setup(fixture.user);
    await append(fixture, 0); await append(fixture, 4); await append(other, 0);
    await evictDurableObject(fixture.user);
    await runInDurableObject(fixture.user, async (instance, ctx) => {
      const original = Reflect.get(instance, "ctx");
      const localOnly = new Proxy(original, {get(target, key) {
        if (key === "exports") throw new Error("Unread operation accessed another DO");
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      }});
      Object.defineProperty(instance, "ctx", {value: localOnly, configurable: true});
      try {
        expect((await instance.getUnreadThreads()).length).toBe(2);
        expect((await instance.getWorkspaceUnreadState(fixture.workspaceId)).length).toBe(1);
        expect((await instance.getUnreadSummary()).unreadMessageCount).toBe(3);
        await instance.markWorkspaceRead(fixture.workspaceId);
        expect((await instance.getUnreadSummary()).unreadMessageCount).toBe(1);
        using put = vi.spyOn(Reflect.get(instance, "storage").chatReadCursors, "put");
        await instance.markWorkspaceRead(fixture.workspaceId);
        expect(put).not.toHaveBeenCalled();
        await instance.markAllRead();
        expect((await instance.getUnreadSummary()).unreadMessageCount).toBe(0);
        expect(put).toHaveBeenCalledOnce();
        await instance.markAllRead();
        expect(put).toHaveBeenCalledOnce();
      } finally { Object.defineProperty(instance, "ctx", {value: original, configurable: true}); }
    });
    await append(fixture, 8);
    expect(await cursor(fixture)).toMatchObject({readThroughSequence: 4, unreadCount: 1});
  });

  it.each(["workspace", "all"] as const)("publishes one scoped replacement for a bulk %s read and none for a no-op", async action => {
    const fixture = await setup();
    for (let chatId = 1; chatId <= 20; chatId++) await fixture.user.messageArrived(fixture.workspaceId, chatId, progress(1));
    const receive = vi.fn<(state?: UserUnreadState) => void>();
    class Subscriber extends RpcTarget implements UnreadStateSubscriber {
      async updated(state: UserUnreadState) { receive(state); }
      async summaryUpdated() { receive(); }
      async chatUpdated() { receive(); }
    }
    using callback = new RpcStub(new Subscriber());
    using _subscription = await fixture.user.subscribeToUnreadState({workspaceId: fixture.workspaceId}, callback);
    await vi.waitFor(() => expect(receive).toHaveBeenCalledOnce());
    receive.mockClear();
    const mark = () => action === "workspace" ? fixture.user.markWorkspaceRead(fixture.workspaceId) : fixture.user.markAllRead();
    await mark();
    await vi.waitFor(() => expect(receive).toHaveBeenCalled());
    expect(receive).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      unreadMessageCount: 0, chats: expect.arrayContaining([
        expect.objectContaining({chatId: 1, unreadMessageCount: 0}),
        expect.objectContaining({chatId: 20, unreadMessageCount: 0}),
      ]),
    }));
    await mark();
    expect(receive).toHaveBeenCalledOnce();
  });

  it("copies inbox metadata without tail scans and publishes renames without changing read horizons", async () => {
    const fixture = await setup();
    const deltas: Parameters<UnreadStateSubscriber["chatUpdated"]>[] = [];
    class Subscriber extends RpcTarget implements UnreadStateSubscriber {
      async updated() {}
      async summaryUpdated() {}
      async chatUpdated(...args: Parameters<UnreadStateSubscriber["chatUpdated"]>) { deltas.push(args); }
    }
    using callback = new RpcStub(new Subscriber());
    using _subscription = await fixture.user.subscribeToUnreadState({workspaceId: fixture.workspaceId}, callback);
    await withImpl(fixture.workspace, async impl => {
      using scan = vi.spyOn(impl.storage.chats, "list");
      write(impl, 0, " \nFirst line\nSecond line");
      write(impl, 2, ""); // Internal/non-visible activity must not replace the preview or date.
      await impl.deliverDirtyChats();
      impl.storage.chatMeta.put({...impl.storage.chatMeta.get(1)!, title: "Renamed", lastActive: impl.getChatTimestamp()});
      await impl.deliverDirtyChats();
      expect(scan).not.toHaveBeenCalled();
    });
    await vi.waitFor(() => expect(deltas).toHaveLength(2));
    expect(await fixture.user.getUnreadThreads()).toEqual([
      {workspaceId: fixture.workspaceId, chatId: 1, readThroughSequence: -1, unreadMessageCount: 1, notificationsEnabled: true,
        chatTitle: "Renamed", latestSequence: 0, latestMessagePreview: "First line", latestActivityAt: new Date(1_000)},
    ]);
    // A repeated ACK-lost packet doesn't rewrite the row or emit another invalidation.
    const head = (await cursor(fixture))!.head!;
    await runInDurableObject(fixture.user, async instance => {
      using put = vi.spyOn(Reflect.get(instance, "storage").chatReadCursors, "put");
      await instance.messageArrived(fixture.workspaceId, 1, {...progress(1), firstMessageSequence: 0, head});
      expect(put).not.toHaveBeenCalled();
    });
    expect(deltas).toHaveLength(2);
    await append(fixture, 4, "x".repeat(260));
    await fixture.user.messageArrived(fixture.workspaceId, 1, {...progress(1), firstMessageSequence: 0, head});
    expect((await fixture.user.getUnreadThreads())[0]).toMatchObject({latestSequence: 4,
      latestActivityAt: new Date(1_004), latestMessagePreview: "x".repeat(240), unreadMessageCount: 2});
  });

  it("does not overwrite a delivered rename with metadata captured by an earlier reopen", async () => {
    const fixture = await setup();
    const {reader, owner} = await addReader(fixture);
    await append(fixture, 0);
    await setRead({...fixture, user: reader}, 0);
    await append(fixture, 1);
    const captured = await notificationBaselines(fixture, reader);
    await withImpl(fixture.workspace, async impl => {
      impl.storage.chatMeta.put({...impl.storage.chatMeta.get(1)!, title: "Renamed", lastActive: impl.getChatTimestamp()});
      await impl.deliverDirtyChats();
    });
    expect((await reader.getUnreadThreads())[0]?.chatTitle).toBe("Renamed");
    await runInDurableObject(reader, async instance => {
      using put = vi.spyOn(Reflect.get(instance, "storage").chatReadCursors, "put");
      await instance.recordSharedWorkspaceOpen(fixture.workspaceId, "Workspace", owner, "build", captured);
      await instance.messageArrived(fixture.workspaceId, 1, {head: captured[0].head!, headUpdatedAt: captured[0].headUpdatedAt!,
        latestVisibleSequence: captured[0].readThroughVisibleSequence, notifications: []});
      expect(put).not.toHaveBeenCalled();
    });
    await evictDurableObject(reader);
    expect(await reader.getUnreadThreads()).toEqual([
      expect.objectContaining({chatTitle: "Renamed", readThroughSequence: 0, unreadMessageCount: 1, notificationsEnabled: true}),
    ]);
  });

  it("repairs a rename skipped during admission denial when the collaborator reopens", async () => {
    const fixture = await setup();
    const {reader, owner} = await addReader(fixture);
    await append(fixture, 0);
    await setRead({...fixture, user: reader}, 0);
    await append(fixture, 1);
    await withImpl(fixture.workspace, async impl => {
      using _admission = vi.spyOn(impl, "mayReadChatState")
        .mockImplementation(async userId => userId === fixture.user.id.toString());
      impl.storage.chatMeta.put({...impl.storage.chatMeta.get(1)!, title: "Renamed", lastActive: impl.getChatTimestamp()});
      await impl.deliverDirtyChats();
      expect([...impl.storage.dirtyChats.list()]).toEqual([]); // Denied deliveries are intentionally skipped.
    });
    expect((await reader.getUnreadThreads())[0]?.chatTitle).toBe("Demo");
    await reader.recordSharedWorkspaceOpen(fixture.workspaceId, "Workspace", owner, "build", await notificationBaselines(fixture, reader));
    await evictDurableObject(reader);
    expect(await reader.getUnreadThreads()).toEqual([
      expect.objectContaining({chatTitle: "Renamed", latestSequence: 1, readThroughSequence: 0, unreadMessageCount: 1, notificationsEnabled: true}),
    ]);
  });

  it("scopes statuses and rollups locally, retaining read rows but dropping deleted/revoked inbox entries", async () => {
    const fixture = await setup();
    const other = await setup(fixture.user);
    await append(fixture, 0); await append(other, 0);
    await withImpl(fixture.workspace, async impl => {
      impl.storage.chatMeta.put({id: 2, title: "Second", started: new Date(), lastActive: new Date()});
      write(impl, 2, "Second thread", 2);
      await impl.setChatNotificationsEnabled(fixture.user.id.toString(), 2, true);
      await impl.deliverDirtyChats();
    });
    expect(await fixture.user.getUnreadSummary()).toEqual({unreadChatCount: 3, unreadMessageCount: 3,
      workspaces: expect.arrayContaining([
        {workspaceId: fixture.workspaceId, unreadChatCount: 2, unreadMessageCount: 2},
        {workspaceId: other.workspaceId, unreadChatCount: 1, unreadMessageCount: 1},
      ])});
    await setRead(fixture, 0);
    expect(await fixture.user.getWorkspaceUnreadState(fixture.workspaceId)).toEqual([
      {workspaceId: fixture.workspaceId, chatId: 1, unreadMessageCount: 0, readThroughSequence: 0, notificationsEnabled: true},
      {workspaceId: fixture.workspaceId, chatId: 2, unreadMessageCount: 1, readThroughSequence: 1,
        notificationsEnabled: true, notificationsEnabledOverride: true},
    ]);
    await fixture.user.messageArrived(fixture.workspaceId, 2, null);
    expect((await fixture.user.getUnreadSummary()).workspaces).toEqual([
      {workspaceId: other.workspaceId, unreadChatCount: 1, unreadMessageCount: 1},
    ]);
    await fixture.user.workspaceRemoved(other.workspaceId);
    expect(await fixture.user.getUnreadThreads()).toEqual([]);
    expect(await fixture.user.getUnreadSummary()).toEqual({unreadChatCount: 0, unreadMessageCount: 0, workspaces: []});
  });

  it("removes muted chats from inbox snapshots and deltas while preserving workspace catch-up state", async () => {
    const fixture = await setup();
    await append(fixture, 0);
    const snapshots: UserUnreadState[] = [], deltas: Parameters<UnreadStateSubscriber["chatUpdated"]>[] = [];
    class Subscriber extends RpcTarget implements UnreadStateSubscriber {
      async updated(state: UserUnreadState) { snapshots.push(state); }
      async summaryUpdated() {}
      async chatUpdated(...args: Parameters<UnreadStateSubscriber["chatUpdated"]>) { deltas.push(args); }
    }
    using callback = new RpcStub(new Subscriber());
    using _subscription = await fixture.user.subscribeToUnreadState("unread", callback);
    await vi.waitFor(() => expect(snapshots[0]?.chats).toHaveLength(1));
    const before = (await fixture.user.getWorkspaceUnreadState(fixture.workspaceId))[0];
    await withImpl(fixture.workspace, impl => impl.setChatNotificationsEnabled(fixture.user.id.toString(), 1, false));
    await vi.waitFor(() => expect(deltas.at(-1)?.[2]).toBeNull());
    expect(await fixture.user.getUnreadThreads()).toEqual([]);
    expect((await fixture.user.getWorkspaceUnreadState(fixture.workspaceId))[0])
      .toEqual({...before, notificationsEnabled: false, notificationsEnabledOverride: false});
    using _mutedSnapshot = await fixture.user.subscribeToUnreadState("unread", callback);
    await vi.waitFor(() => expect(snapshots.at(-1)?.chats).toEqual([]));
    await withImpl(fixture.workspace, impl => impl.setChatNotificationsEnabled(fixture.user.id.toString(), 1, true));
    await vi.waitFor(() => expect(deltas.at(-1)?.[2]).toEqual({...before, notificationsEnabledOverride: true}));
    expect(await fixture.user.getUnreadThreads()).toMatchObject([{chatId: 1, unreadMessageCount: 1}]);
  });

  it("publishes a local snapshot then single-thread deltas, with a tombstone on deletion", async () => {
    const fixture = await setup();
    const snapshots: UserUnreadState[] = [], deltas: Parameters<UnreadStateSubscriber["chatUpdated"]>[] = [];
    class Subscriber extends RpcTarget implements UnreadStateSubscriber {
      async updated(state: UserUnreadState) { snapshots.push(state); }
      async summaryUpdated() {}
      async chatUpdated(...args: Parameters<UnreadStateSubscriber["chatUpdated"]>) { deltas.push(args); }
    }
    using callback = new RpcStub(new Subscriber());
    using _subscription = await fixture.user.subscribeToUnreadState({workspaceId: fixture.workspaceId}, callback);
    await append(fixture, 0);
    await vi.waitFor(() => expect(deltas.at(-1)?.[3].unreadMessageCount).toBe(1));
    expect(snapshots).toHaveLength(1);
    await withImpl(fixture.workspace, async impl => { impl.storage.chatMeta.delete(1); await impl.deliverDirtyChats(); });
    await vi.waitFor(() => expect(deltas.at(-1)?.[2]).toBeNull());
    expect(await cursor(fixture)).toMatchObject({deleted: true, unreadCount: 0});
  });

  it("scopes initial rows, deltas and bulk replacements while keeping global rollups current", async () => {
    const fixture = await setup(), other = await setup(fixture.user);
    await append(fixture, 0); await append(other, 0);
    await setRead(fixture, 0);
    await withImpl(fixture.workspace, async impl => {
      impl.storage.chatMeta.put({id: 2, title: "Unread", started: new Date(), lastActive: new Date()});
      write(impl, 2, "New thread", 2);
      await impl.setChatNotificationsEnabled(fixture.user.id.toString(), 2, true);
      await impl.deliverDirtyChats();
    });
    class Subscriber extends RpcTarget implements UnreadStateSubscriber {
      snapshots: UserUnreadState[] = [];
      summaries: Parameters<UnreadStateSubscriber["summaryUpdated"]>[0][] = [];
      deltas: Parameters<UnreadStateSubscriber["chatUpdated"]>[] = [];
      async updated(state: UserUnreadState) { this.snapshots.push(state); }
      async summaryUpdated(summary: Parameters<UnreadStateSubscriber["summaryUpdated"]>[0]) { this.summaries.push(summary); }
      async chatUpdated(...args: Parameters<UnreadStateSubscriber["chatUpdated"]>) { this.deltas.push(args); }
    }
    const summary = new Subscriber(), workspace = new Subscriber(), inbox = new Subscriber();
    using summaryStub = new RpcStub(summary), workspaceStub = new RpcStub(workspace), inboxStub = new RpcStub(inbox);
    using _summary = await fixture.user.subscribeToUnreadState("summary", summaryStub);
    using _workspace = await fixture.user.subscribeToUnreadState({workspaceId: fixture.workspaceId}, workspaceStub);
    using _inbox = await fixture.user.subscribeToUnreadState("unread", inboxStub);
    await vi.waitFor(() => expect(inbox.snapshots).toHaveLength(1));
    expect(summary.snapshots[0]).toMatchObject({chats: [], unreadMessageCount: 2, workspaces: expect.any(Array)});
    expect(workspace.snapshots[0].chats).toEqual(await fixture.user.getWorkspaceUnreadState(fixture.workspaceId));
    expect(workspace.snapshots[0].chats).toHaveLength(2); // Includes its fully read thread, not other workspaces.
    expect(inbox.snapshots[0].chats).toHaveLength(2);
    expect(inbox.snapshots[0].chats.every(chat => chat.unreadMessageCount > 0)).toBe(true);

    await append(other, 2);
    await vi.waitFor(() => expect(workspace.summaries.at(-1)?.unreadMessageCount).toBe(3));
    expect(workspace.deltas).toEqual([]);
    expect(summary.deltas).toEqual([]);
    expect(summary.summaries.at(-1)?.workspace).toEqual({workspaceId: other.workspaceId,
      unreadChatCount: 1, unreadMessageCount: 2});
    expect(inbox.deltas.at(-1)?.[0]).toBe(other.workspaceId);

    await setRead(fixture, 2, false, 2);
    await vi.waitFor(() => expect(inbox.deltas.at(-1)?.slice(0, 3)).toEqual([fixture.workspaceId, 2, null]));
    expect(workspace.deltas.at(-1)?.[2]).toMatchObject({chatId: 2, unreadMessageCount: 0});
    await setRead(fixture, 0, true);
    await vi.waitFor(() => expect(inbox.deltas.at(-1)?.[2]).toMatchObject({chatId: 1, unreadMessageCount: 1}));

    await fixture.user.workspaceRemoved(other.workspaceId);
    await vi.waitFor(() => expect(inbox.snapshots).toHaveLength(2));
    expect(summary.snapshots.at(-1)?.chats).toEqual([]);
    expect(workspace.snapshots.at(-1)?.chats).toHaveLength(2);
    expect(inbox.snapshots.at(-1)?.chats).toEqual([expect.objectContaining({workspaceId: fixture.workspaceId, chatId: 1})]);
  });
});

describe("durable forward handoff", () => {
  it("bounds deletion fanout, retains only a stalled recipient, and finishes physical cleanup after eviction", async () => {
    const fixture = await setup(); const {reader} = await addReader(fixture); await append(fixture, 0);
    const stalled = Promise.withResolvers<void>();
    await withImpl(fixture.workspace, async impl => {
      const restore = interceptUsers(impl, (user, method) =>
        method === "workspaceRemoved" && user.id.toString() === reader.id.toString()
          ? () => stalled.promise : undefined);
      try {
        impl.beginDeletion(new Set([fixture.user.id.toString(), reader.id.toString()]));
        await impl.deliverUserUpdates();
        expect(impl.ownerId).toBeUndefined();
        expect(impl.storage.deleting.get()).toBe(true);
        expect([...impl.storage.pendingUserUpdates.list()].map(row => row.userId)).toEqual([reader.id.toString()]);
        expect(impl.storage.chats.get(chatKey(1, 0))).toBeDefined();
        expect(await impl.ctx.storage.getAlarm()).not.toBeNull();
      } finally { restore(); stalled.resolve(); }
    });
    expect(await fixture.user.getWorkspace(fixture.workspaceId)).toBeNull();
    await runInDurableObject(fixture.workspace, async instance => {
      using closed = new NativeRpcStub<() => void>(() => {});
      await expect(instance.open(reader.id.toString(), "reader", closed)).rejects.toThrow();
    });
    await evictDurableObject(fixture.workspace);
    await withImpl(fixture.workspace, async impl => {
      await impl.deliverUserUpdates();
      expect(impl.storage.deleting.get()).toBe(false);
      expect([...impl.storage.chats.list()]).toEqual([]);
      expect([...impl.storage.pendingUserUpdates.list()]).toEqual([]);
      expect(await impl.ctx.storage.getAlarm()).toBeNull();
    });
    expect(await reader.getWorkspace(fixture.workspaceId)).toBeNull();
  });

  it("switches a pending revocation drain to workspace deletion before dispatch", async () => {
    const fixture = await setup(); const {reader, profile} = await addReader(fixture);
    await withImpl(fixture.workspace, async impl => {
      impl.storage.pendingUserUpdates.put({userId: reader.id.toString(), profileId: profile.id, role: null});
      const drain = impl.deliverUserUpdates();
      impl.beginDeletion(new Set([fixture.user.id.toString(), reader.id.toString()]));
      await drain;
      expect([...impl.storage.pendingUserUpdates.list()]).toEqual([]);
      expect([...impl.storage.chatMeta.list()]).toEqual([]);
    });
    expect(await fixture.user.getWorkspace(fixture.workspaceId)).toBeNull();
    expect(await reader.getWorkspace(fixture.workspaceId)).toBeNull();
  });

  it("recovers a reset after removal ACKs but before physical deletion without resending callbacks", async () => {
    const fixture = await setup(); await append(fixture, 0);
    using removed = vi.spyOn(UserDurableObject.prototype, "workspaceRemoved");
    await withImpl(fixture.workspace, async impl => {
      using _wipe = vi.spyOn(impl.ctx.storage, "deleteAll").mockRejectedValue(new Error("Interrupted wipe"));
      impl.beginDeletion(new Set([fixture.user.id.toString()]));
      await expect(impl.deliverUserUpdates()).rejects.toThrow("Interrupted wipe");
      expect([...impl.storage.pendingUserUpdates.list()]).toEqual([]);
      expect(impl.storage.deleting.get()).toBe(true);
    });
    await expect(runInDurableObject(fixture.workspace, (_instance, ctx) => ctx.abort("Reset before wipe")))
      .rejects.toThrow("Reset before wipe");
    await withImpl(fixture.workspace, async impl => {
      await impl.deliverUserUpdates();
      expect([...impl.storage.chats.list()]).toEqual([]);
      expect(await impl.ctx.storage.getAlarm()).toBeNull();
    });
    expect(removed).toHaveBeenCalledOnce();
  });

  it("does not recreate fanout work when a handoff fails after workspace deletion", async () => {
    const fixture = await setup();
    await runInDurableObject(fixture.workspace, async instance => {
      const impl = instance.impl;
      using _ambient = vi.spyOn(impl, "ensureAmbientCapsules").mockResolvedValue(undefined);
      using _outputs = vi.spyOn(impl, "markOutputsDirty").mockImplementation(() => {});
      using _restart = vi.spyOn(impl, "scheduleAccessRestart").mockResolvedValue(undefined);
      using closed = new NativeRpcStub<() => void>(() => {});
      using client = await instance.open(fixture.user.id.toString(), "owner", closed);
      // The test-pool caller cannot accept an RPC callback while deletion holds the input gate.
      Reflect.get(client, "notifyClosed")[Symbol.dispose]();
      Reflect.set(client, "notifyClosed", Object.assign(async () => {}, {[Symbol.dispose]: () => {}}));
      const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
      const restore = interceptDelivery(impl, async () => {
        entered.resolve(); await release.promise; throw new Error("Late recipient failure");
      });
      try {
        write(impl, 0);
        const delivery = impl.deliverDirtyChats().catch(() => {});
        await entered.promise;
        using removeListing = vi.spyOn(UserDurableObject.prototype, "deleteWorkspace");
        await Promise.all([client.deleteSelf(), client.deleteSelf()]);
        expect(removeListing).toHaveBeenCalledOnce();
        expect([...impl.storage.dirtyChats.list()]).toEqual([]);
        release.resolve();
        await delivery;
        expect([...impl.storage.dirtyChats.list()]).toEqual([]);
      } finally { release.resolve(); restore(); }
    });
    await expect(runInDurableObject(fixture.workspace, (_instance, ctx) => {
      ctx.abort("Reset deleted workspace");
    })).rejects.toThrow("Reset deleted workspace");
    fixture.workspace = env.TEST_OVERSEER.get(fixture.workspace.id);
    await withImpl(fixture.workspace, async impl => {
      await impl.deliverDirtyChats();
      expect([...impl.storage.dirtyChats.list()]).toEqual([]);
      expect(await impl.ctx.storage.getAlarm()).toBeNull();
    });
  });

  it("adds no recipient checkpoint write when all recipients ACK", async () => {
    const fixture = await setup(); await addReader(fixture); await addReader(fixture);
    await withImpl(fixture.workspace, async impl => {
      using put = vi.spyOn(impl.storage.dirtyChats, "put");
      using remove = vi.spyOn(impl.storage.dirtyChats, "delete");
      write(impl, 0);
      await impl.deliverDirtyChats();
      expect(put).toHaveBeenCalledOnce(); // The original dirty marker, not recipient bookkeeping.
      expect(put.mock.calls[0][0]).not.toHaveProperty("failedRecipients");
      expect(put.mock.calls[0][0]).not.toHaveProperty("retryOnly");
      expect(remove).toHaveBeenCalledOnce();
      expect(impl.storage.dirtyChats.get(1)).toBeUndefined();
    });
  });

  it("checkpoints only failures and retries only those users after source eviction", async () => {
    const fixture = await setup(); await addReader(fixture);
    const {reader: failing} = await addReader(fixture);
    await withImpl(fixture.workspace, async impl => {
      const attempts: string[] = [];
      const restore = interceptDelivery(impl, async (user, ...args) => {
        attempts.push(user.id.toString());
        if (user.id.toString() === failing.id.toString()) throw new Error("Unavailable recipient");
        await user.messageArrived(...args);
      });
      try {
        write(impl, 0);
        await expect(impl.deliverDirtyChats()).rejects.toThrow("Unavailable recipient");
        expect(attempts).toHaveLength(3);
        expect(impl.storage.dirtyChats.get(1)).toMatchObject({retryOnly: true, failedRecipients: [
          {userId: failing.id.toString(), firstMessageSequence: 0, firstVisibleSequence: 1},
        ]});
        attempts.length = 0;
        await impl.deliverDirtyChats({retryFailures: false});
        expect(attempts).toEqual([]);
        using put = vi.spyOn(impl.storage.dirtyChats, "put");
        await expect(impl.deliverDirtyChats()).rejects.toThrow("Unavailable recipient");
        expect(attempts).toEqual([failing.id.toString()]);
        expect(put).not.toHaveBeenCalled(); // An unchanged repeated failure needs no rewrite.
      } finally { restore(); }
    });
    await evictDurableObject(fixture.workspace);
    await withImpl(fixture.workspace, async impl => {
      const attempts: string[] = [];
      const restore = interceptDelivery(impl, async (user, ...args) => {
        attempts.push(user.id.toString()); await user.messageArrived(...args);
      });
      try { await impl.deliverDirtyChats(); } finally { restore(); }
      expect(attempts).toEqual([failing.id.toString()]);
      expect(impl.storage.dirtyChats.get(1)).toBeUndefined();
    });
    expect((await failing.getUnreadSummary()).unreadMessageCount).toBe(1);
  });

  it("broadcasts new arrivals without replaying healthy users' older batch", async () => {
    const fixture = await setup(); const {reader} = await addReader(fixture);
    const alerts = [event(0), event(5)];
    using publish = vi.spyOn(UserDurableObject.prototype, "publishNotification").mockResolvedValue(undefined);
    await withImpl(fixture.workspace, async impl => {
      const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
      const healthy: ChatMessageProgress[] = [];
      const restore = interceptDelivery(impl, async (user, ...args) => {
        if (user.id.toString() === reader.id.toString()) {
          entered.resolve(); await release.promise; throw new Error("Unavailable recipient");
        }
        healthy.push(args[2]!);
        await user.messageArrived(...args);
      });
      try {
        write(impl, 0);
        impl.storage.chatNotifications.put({...alerts[0], chatId: 1, userId: fixture.user.id.toString()});
        const first = impl.deliverDirtyChats();
        await entered.promise;
        write(impl, 5);
        impl.storage.chatNotifications.put({...alerts[1], chatId: 1, userId: fixture.user.id.toString()});
        release.resolve(); await expect(first).rejects.toThrow("Unavailable recipient");
        await vi.waitFor(() => expect(impl.storage.dirtyChats.get(1)).toMatchObject({retryOnly: true,
          failedRecipients: [{userId: reader.id.toString(), firstMessageSequence: 0, firstVisibleSequence: 1}],
        }));
        expect(healthy).toMatchObject([{firstMessageSequence: 0},
          {firstMessageSequence: 5, firstVisibleSequence: 2, notifications: [{id: alerts[1].id}]}]);
      } finally { release.resolve(); restore(); }
      const packets = new Map<string, ChatMessageProgress | null>();
      const finish = interceptDelivery(impl, async (user, ...args) => {
        packets.set(user.id.toString(), args[2]); await user.messageArrived(...args);
      });
      try { await impl.deliverDirtyChats(); } finally { finish(); }
      expect(packets.has(fixture.user.id.toString())).toBe(false);
      expect(packets.get(reader.id.toString())).toMatchObject({firstMessageSequence: 0, firstVisibleSequence: 1});
      expect(impl.storage.dirtyChats.get(1)).toBeUndefined();
    });
    await drained(fixture);
    expect(publish.mock.calls.map(([alert]) => alert.id)).toEqual(alerts.map(alert => alert.id));
    expect((await reader.getUnreadSummary()).unreadMessageCount).toBe(2);
  });

  it("can replay before the failure checkpoint on a real reset, without duplicate recipient effects", async () => {
    const fixture = await setup(); const {reader} = await addReader(fixture);
    const accepted = Promise.withResolvers<void>(), stalled = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const alert = event(0);
    using publish = vi.spyOn(UserDurableObject.prototype, "publishNotification").mockResolvedValue(undefined);
    using arrive = vi.spyOn(UserDurableObject.prototype, "messageArrived");
    try {
      await expect(runInDurableObject(fixture.workspace, async (instance, ctx) => {
        const impl = instance.impl;
        interceptDelivery(impl, async (user, ...args) => {
          if (user.id.toString() === reader.id.toString()) { stalled.resolve(); await release.promise; }
          await user.messageArrived(...args);
          if (user.id.toString() === fixture.user.id.toString()) accepted.resolve();
        });
        write(impl, 0);
        impl.storage.chatNotifications.put({...alert, chatId: 1, userId: fixture.user.id.toString()});
        void impl.deliverDirtyChats().catch(() => {});
        await Promise.all([accepted.promise, stalled.promise]);
        expect(impl.storage.dirtyChats.get(1)?.failedRecipients).toBeUndefined();
        ctx.abort("Reset before failure checkpoint");
      })).rejects.toThrow("Reset before failure checkpoint");
    } finally { release.resolve(); }
    await drained(fixture);
    fixture.workspace = env.TEST_OVERSEER.get(fixture.workspace.id);
    await runDurableObjectAlarm(fixture.workspace); await drained(fixture);
    const deliveriesToOwner = arrive.mock.contexts.filter(instance =>
      Reflect.get(instance, "ctx").id.toString() === fixture.user.id.toString());
    expect(deliveriesToOwner).toHaveLength(2);
    expect(publish.mock.calls.map(([notification]) => notification.id)).toEqual([alert.id]);
    expect((await reader.getUnreadSummary()).unreadMessageCount).toBe(1);
  });

  it.each([false, true])("replays a coalesced batch after real source eviction (ACK lost: %s)", async lostAck => {
    const fixture = await setup(); const alerts = [event(10), event(15)];
    using publish = vi.spyOn(UserDurableObject.prototype, "publishNotification").mockResolvedValue(undefined);
    await withImpl(fixture.workspace, async impl => {
      const restore = interceptDelivery(impl, async (user, ...args) => {
        if (lostAck) await user.messageArrived(...args);
        throw new Error("Interrupted handoff");
      });
      try {
        for (const alert of alerts) {
          write(impl, alert.sequence);
          impl.storage.chatNotifications.put({...alert, chatId: 1, userId: fixture.user.id.toString()});
        }
        await expect(impl.deliverDirtyChats()).rejects.toThrow("Interrupted handoff");
        expect(impl.storage.dirtyChats.get(1)).toMatchObject({retryOnly: true,
          failedRecipients: [{userId: fixture.user.id.toString(), firstMessageSequence: 10, firstVisibleSequence: 1}]});
      } finally { restore(); }
    });
    if (lostAck) await drained(fixture);
    await evictDurableObject(fixture.workspace);
    await runDurableObjectAlarm(fixture.workspace);
    await drained(fixture);
    expect(await cursor(fixture)).toMatchObject({readThroughSequence: 9, readThroughVisibleSequence: 0, unreadCount: 2,
      notifiedThroughSequence: 15});
    expect(publish.mock.calls.map(([alert]) => alert.id)).toEqual(alerts.map(alert => alert.id));
  });

  it.each(["read", "unread"] as const)("does not consume pending alerts when %s beats first fanout", async command => {
    const fixture = await setup(); const alert = event(0);
    using publish = vi.spyOn(UserDurableObject.prototype, "publishNotification").mockResolvedValue(undefined);
    await withImpl(fixture.workspace, async impl => {
      const release = Promise.withResolvers<void>();
      const restore = interceptDelivery(impl, async (user, ...args) => { await release.promise; await user.messageArrived(...args); });
      try {
        write(impl, 0);
        impl.storage.chatNotifications.put({...alert, chatId: 1, userId: fixture.user.id.toString()});
        if (command === "read") await setRead(fixture, 0);
        else await setRead(fixture, 0, true);
      } finally { release.resolve(); restore(); }
      await impl.deliverDirtyChats();
    });
    await drained(fixture);
    expect(publish.mock.calls.map(([notification]) => notification.id)).toEqual([alert.id]);
    expect(await cursor(fixture)).toMatchObject({unreadCount: command === "read" ? 0 : 1});
  });

  it("ACKs counts and queued intent without waiting for an alert, and progresses other recipients/threads", async () => {
    const fixture = await setup(); const {reader} = await addReader(fixture);
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const alert = event(0);
    using publish = vi.spyOn(UserDurableObject.prototype, "publishNotification").mockImplementation(async notification => {
      if (notification.id === alert.id) { entered.resolve(); await release.promise; }
    });
    try {
      await withImpl(fixture.workspace, async impl => {
        write(impl, 0);
        impl.storage.chatNotifications.put({...alert, chatId: 1, userId: fixture.user.id.toString()});
        await impl.deliverDirtyChats();
        expect(impl.storage.dirtyChats.get(1)).toBeUndefined();
      });
      await entered.promise;
      expect(await cursor(fixture)).toMatchObject({unreadCount: 1, notifiedThroughSequence: -1});
      expect(await outbox(fixture)).toHaveLength(1);
      expect((await reader.getUnreadSummary()).unreadMessageCount).toBe(1);
      await append(fixture, 5);
      const other = await setup(fixture.user); await append(other, 0);
      expect((await fixture.user.getUnreadSummary()).unreadMessageCount).toBe(3);
      await runInDurableObject(fixture.user, async instance => {
        const retry = instance.alarm();
        const read = setRead(fixture, 0);
        await read;
        expect((await instance.getUnreadSummary()).unreadMessageCount).toBe(2);
        expect(publish).toHaveBeenCalledOnce(); // Concurrent drains still share the delivery mutex.
        release.resolve(); await retry;
      });
    } finally { release.resolve(); }
    await drained(fixture);
    expect(publish).toHaveBeenCalledOnce();
    expect(await cursor(fixture)).toMatchObject({readThroughSequence: 0, unreadCount: 1, notifiedThroughSequence: 0});
  });

  it("delivers mutations arriving during an older fanout without waiting for another alarm", async () => {
    const fixture = await setup();
    await withImpl(fixture.workspace, async impl => {
      const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
      const restore = interceptDelivery(impl, async (user, ...args) => {
        entered.resolve(); await release.promise; await user.messageArrived(...args);
      });
      try {
        write(impl, 0);
        const first = impl.deliverDirtyChats();
        await entered.promise; write(impl, 5);
        release.resolve(); await first;
        await vi.waitFor(() => expect(impl.storage.dirtyChats.get(1)).toBeUndefined());
      } finally { release.resolve(); restore(); }
    });
    expect(await cursor(fixture)).toMatchObject({unreadCount: 2});
  });

  it("fans out to healthy users while one recipient has not ACKed", async () => {
    const fixture = await setup(); const {reader} = await addReader(fixture);
    await withImpl(fixture.workspace, async impl => {
      const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
      const restore = interceptDelivery(impl, async (user, ...args) => {
        if (user.id.toString() === fixture.user.id.toString()) { entered.resolve(); await release.promise; }
        await user.messageArrived(...args);
      });
      try {
        write(impl, 0);
        const pending = impl.deliverDirtyChats();
        await entered.promise;
        const healthy = impl.users.get(impl.users.idFromString(reader.id.toString()));
        await vi.waitFor(async () => expect((await healthy.getUnreadSummary()).unreadMessageCount).toBe(1));
        expect(impl.storage.dirtyChats.get(1)).toBeDefined();
        await expect(pending).rejects.toThrow("User DO handoff timed out");
        expect(impl.storage.dirtyChats.get(1)?.failedRecipients?.map(row => row.userId))
          .toEqual([fixture.user.id.toString()]);
      } finally { release.resolve(); restore(); }
      await impl.deliverDirtyChats();
      expect(impl.storage.dirtyChats.get(1)).toBeUndefined();
    });
  });
});

describe("recipient-owned notification outbox", () => {
  it("keeps independent alerts at one message position through delivery, reset and replay", async () => {
    const fixture = await setup();
    const alerts = [{...event(0), kind: "permissionRequested" as const}, event(0)];
    using publish = vi.spyOn(UserDurableObject.prototype, "publishNotification")
      .mockRejectedValue(new Error("Unavailable"));
    await withImpl(fixture.workspace, async impl => {
      write(impl, 0);
      for (let alert of alerts) impl.storage.chatNotifications.put({
        ...alert, chatId: 1, userId: fixture.user.id.toString(),
      });
      await impl.deliverDirtyChats();
      expect([...impl.storage.chatNotifications.list()]).toHaveLength(2);
    });
    await vi.waitFor(() => expect(publish).toHaveBeenCalled());
    expect(await outbox(fixture)).toHaveLength(2);
    const ordered = alerts.toSorted((a, b) => a.id.localeCompare(b.id));
    publish.mockClear();
    publish.mockImplementation(async alert => {
      if (alert.id === ordered[1].id) throw new Error("Lost second ACK");
    });
    await runDurableObjectAlarm(fixture.user);
    expect((await outbox(fixture)).map(alert => alert.id)).toEqual([ordered[1].id]);
    expect((await cursor(fixture))!.notifiedEventIds).toEqual([ordered[0].id]);
    publish.mockResolvedValue(undefined);
    await evictDurableObject(fixture.user);
    await fixture.user.getUnreadSummary(); await drained(fixture);
    expect(new Set(publish.mock.calls.map(([alert]) => alert.id))).toEqual(new Set(alerts.map(alert => alert.id)));
    await evictDurableObject(fixture.user);
    const packet = {...progress(1), firstMessageSequence: 0, notifications: alerts};
    await fixture.user.messageArrived(fixture.workspaceId, 1, packet);
    expect(await outbox(fixture)).toEqual([]);
    expect(publish).toHaveBeenCalledTimes(3);
    const late = event(0);
    await fixture.user.messageArrived(fixture.workspaceId, 1, {...packet, notifications: [late]});
    await drained(fixture);
    expect(publish).toHaveBeenCalledTimes(4);
    expect(new Set((await cursor(fixture))!.notifiedEventIds)).toEqual(new Set([...alerts, late].map(alert => alert.id)));
  });

  it("preserves retry deadlines across replay and eviction without blocking a newer alert", async () => {
    const fixture = await setup(); const first = event(1), second = event(2);
    let now = Date.now();
    using _clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    using publish = vi.spyOn(UserDurableObject.prototype, "publishNotification").mockImplementation(async alert => {
      if (alert.id === first.id) throw new Error("Unavailable");
    });
    const packet = {...progress(1), notifications: [first]};
    await fixture.user.messageArrived(fixture.workspaceId, 1, packet);
    await vi.waitFor(() => expect(publish).toHaveBeenCalled());
    const deadline = (await outbox(fixture))[0].expiresAt.getTime();
    expect(deadline).toBe(now + 10 * 60_000);
    now += 60_000;
    await fixture.user.messageArrived(fixture.workspaceId, 1, packet);
    expect((await outbox(fixture))[0].expiresAt.getTime()).toBe(deadline);
    await fixture.user.messageArrived(fixture.workspaceId, 1, {...progress(2), notifications: [second]});
    await vi.waitFor(async () => expect(await cursor(fixture)).toMatchObject({notifiedThroughSequence: 2}));
    expect(publish.mock.calls.map(([alert]) => alert.id)).toEqual([first.id, second.id]);
    now = deadline;
    publish.mockClear();
    await evictDurableObject(fixture.user);
    await fixture.user.getUnreadSummary();
    await drained(fixture);
    expect(publish).not.toHaveBeenCalled();
    expect(await cursor(fixture)).toMatchObject({notifiedThroughSequence: 2, unreadCount: 2});
    await fixture.user.messageArrived(fixture.workspaceId, 1, packet);
    expect(await outbox(fixture)).toEqual([]);
    expect(await runInDurableObject(fixture.user, (_instance, ctx) => ctx.storage.getAlarm())).toBeNull();
  });

  it("consumes an alert whose final failed attempt reaches its persisted deadline", async () => {
    const fixture = await setup(); const alert = event(1);
    let now = Date.now();
    using _clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    using publish = vi.spyOn(UserDurableObject.prototype, "publishNotification").mockImplementation(async (_alert, deadline) => {
      now = deadline!;
      throw new Error("Attempt timed out");
    });
    await fixture.user.messageArrived(fixture.workspaceId, 1, {...progress(1), notifications: [alert]});
    await drained(fixture);
    expect(publish).toHaveBeenCalledOnce();
    expect(await cursor(fixture)).toMatchObject({notifiedThroughSequence: 1, unreadCount: 1});
  });

  it("keeps each alert in raw order even at the same visible prefix, deduplicating queued and completed replays", async () => {
    const fixture = await setup(); const alerts = [event(1), event(4), event(9)];
    const packet = {...progress(1), notifications: alerts};
    using publish = vi.spyOn(UserDurableObject.prototype, "publishNotification").mockRejectedValue(new Error("Provider unavailable"));
    await fixture.user.messageArrived(fixture.workspaceId, 1, packet);
    await vi.waitFor(() => expect(publish).toHaveBeenCalled());
    expect((await outbox(fixture)).map(alert => alert.id)).toEqual(alerts.map(alert => alert.id));
    await fixture.user.messageArrived(fixture.workspaceId, 1, packet);
    expect(await outbox(fixture)).toHaveLength(3);
    publish.mockResolvedValue(undefined); publish.mockClear();
    await runDurableObjectAlarm(fixture.user); await drained(fixture);
    expect(publish.mock.calls.map(([alert]) => alert.id)).toEqual(alerts.map(alert => alert.id));
    await evictDurableObject(fixture.user);
    await fixture.user.messageArrived(fixture.workspaceId, 1, packet); await drained(fixture);
    expect(publish).toHaveBeenCalledTimes(3);
    expect(await cursor(fixture)).toMatchObject({unreadCount: 1, notifiedThroughSequence: 9});
  });

  it("recovers a real reset during delivery from the local queue, using the same UUID and no source reads", async () => {
    const fixture = await setup(); const alert = event(1);
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    let first = true;
    using publish = vi.spyOn(UserDurableObject.prototype, "publishNotification").mockImplementation(async () => {
      if (first) { first = false; entered.resolve(); await release.promise; }
    });
    try {
      await expect(runInDurableObject(fixture.user, async (instance, ctx) => {
        await instance.messageArrived(fixture.workspaceId, 1, {...progress(1), notifications: [alert]});
        await entered.promise;
        const storage = makeUserStorage(ctx.storage);
        expect([...storage.notificationOutbox.list()]).toHaveLength(1);
        expect(storage.chatReadCursors.get(`${fixture.workspaceId}:1`)).toMatchObject({unreadCount: 1, notifiedThroughSequence: 0});
        expect(await ctx.storage.getAlarm()).not.toBeNull();
        ctx.abort("Injected delivery reset");
      })).rejects.toThrow("Injected delivery reset");
    } finally { release.resolve(); }
    fixture.user = env.TEST_USER.get(fixture.user.id);
    await runDurableObjectAlarm(fixture.user); await drained(fixture);
    expect(publish.mock.calls.map(([notification]) => notification.id)).toEqual([alert.id, alert.id]);
    expect(await cursor(fixture)).toMatchObject({notifiedThroughSequence: 1, unreadCount: 1});
  });

  it("checkpoints successful alerts individually and retries a lost provider ACK without fetching candidates", async () => {
    const fixture = await setup(); const alerts = [event(1), event(2), event(3)];
    const received: string[] = [];
    let failed = true;
    using _publish = vi.spyOn(UserDurableObject.prototype, "publishNotification").mockImplementation(async alert => {
      received.push(alert.id);
      if (failed && alert.id === alerts[1].id) throw new Error("Lost ACK after effect");
    });
    await fixture.user.messageArrived(fixture.workspaceId, 1, {...progress(1, 3), notifications: alerts});
    await vi.waitFor(async () => expect(await cursor(fixture)).toMatchObject({notifiedThroughSequence: 3}));
    expect((await outbox(fixture)).map(alert => alert.id)).toEqual([alerts[1].id]);
    failed = false;
    await evictDurableObject(fixture.user); await runDurableObjectAlarm(fixture.user); await drained(fixture);
    expect(received).toEqual([alerts[0].id, alerts[1].id, alerts[2].id, alerts[1].id]);
    expect(await cursor(fixture)).toMatchObject({notifiedThroughSequence: 3});
  });

  it("consumes intentional mute skips rather than retrying forever", async () => {
    const fixture = await setup(); await fixture.user.setWorkspaceNotificationMute(fixture.workspaceId, {indefinite: true});
    const alert = event(1);
    await fixture.user.messageArrived(fixture.workspaceId, 1, {...progress(1), notifications: [alert]});
    await drained(fixture);
    expect(await cursor(fixture)).toMatchObject({notifiedThroughSequence: 1, unreadCount: 1});
  });

  it("does not postpone a failed queue's retry for unrelated activity", async () => {
    const fixture = await setup(); const other = await setup(fixture.user);
    let now = Date.now();
    using _clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    using publish = vi.spyOn(UserDurableObject.prototype, "publishNotification").mockRejectedValue(new Error("Unavailable"));
    await fixture.user.messageArrived(fixture.workspaceId, 1, {...progress(1), notifications: [event(1)]});
    await vi.waitFor(() => expect(publish).toHaveBeenCalled());
    const alarm = () => runInDurableObject(fixture.user, (_instance, ctx) => ctx.storage.getAlarm());
    const deadline = (await alarm())!;
    now += 29_000; await append(other, 0);
    expect(await alarm()).toBeLessThanOrEqual(deadline);
    now = deadline;
    await runDurableObjectAlarm(fixture.user);
    expect(await alarm()).toBe(now + 30_000);
    publish.mockResolvedValue(undefined); now += 30_000;
    await runDurableObjectAlarm(fixture.user); await drained(fixture);
    expect(await alarm()).toBeNull();
  });
});

describe("source authorization and removal", () => {
  it("persists failed revocation cleanup and purges accepted alerts after source eviction", async () => {
    const fixture = await setup(); const {reader, profile} = await addReader(fixture); await append(fixture, 0);
    const readerFixture = {...fixture, user: reader};
    using publish = vi.spyOn(UserDurableObject.prototype, "publishNotification").mockRejectedValue(new Error("Unavailable"));
    await reader.messageArrived(fixture.workspaceId, 1, {...progress(2), notifications: [event(1)]});
    await vi.waitFor(() => expect(publish).toHaveBeenCalled());
    await withImpl(fixture.workspace, async impl => {
      const restore = interceptUsers(impl, (_user, method) => method === "forgetSharedWorkspace"
        ? async () => { throw new Error("Cleanup unavailable"); } : undefined);
      try {
        impl.storage.collaborators.delete(profile.id);
        await impl.refreshAffectedCollaboratorListings([{profile, addedBy: [], oldAccess: {role: "build"}, newAccess: null}]);
        expect([...impl.storage.pendingUserUpdates.list()]).toHaveLength(1);
      } finally { restore(); }
      const recipients: string[] = [];
      const delivery = interceptDelivery(impl, async (user, ...args) => {
        recipients.push(user.id.toString()); await user.messageArrived(...args);
      });
      try { write(impl, 1); await impl.deliverDirtyChats(); } finally { delivery(); }
      expect(recipients).not.toContain(reader.id.toString());
    });
    expect(await outbox(readerFixture)).toHaveLength(1);
    await evictDurableObject(fixture.workspace);
    await withImpl(fixture.workspace, async impl => {
      await impl.deliverUserUpdates();
      expect([...impl.storage.pendingUserUpdates.list()]).toEqual([]);
    });
    expect(await outbox(readerFixture)).toEqual([]);
    expect(await reader.getWorkspaceUnreadState(fixture.workspaceId)).toEqual([]);
  });

  it("does not revisit a denied user after another recipient failed and admission is restored", async () => {
    const fixture = await setup(); const {reader, profile} = await addReader(fixture);
    const skipped = event(0), accepted = event(1);
    using publish = vi.spyOn(UserDurableObject.prototype, "publishNotification").mockResolvedValue(undefined);
    await withImpl(fixture.workspace, async impl => {
      impl.storage.gatekeepers.put({id: 7, resourceTitle: "New connection", class: {} as never,
        creationSpec: {type: "gatekeeper", vendorId: "testvendor", resourceUrl: "https://example.com/7", typeUrlPattern: "https://*"}});
      const restore = interceptDelivery(impl, async () => { throw new Error("Owner unavailable"); });
      try {
        write(impl, 0);
        impl.storage.chatNotifications.put({...skipped, chatId: 1, userId: reader.id.toString()});
        await expect(impl.deliverDirtyChats()).rejects.toThrow("Owner unavailable");
        expect(impl.storage.dirtyChats.get(1)?.failedRecipients?.map(({userId}) => userId))
          .toEqual([fixture.user.id.toString()]);
      } finally { restore(); }
      impl.storage.observers.put({profileId: profile.id, observerId: crypto.randomUUID(), accountChoices: {7: 1}});
      const attempts: string[] = [];
      const retry = interceptDelivery(impl, async (user, ...args) => {
        attempts.push(user.id.toString()); await user.messageArrived(...args);
      });
      try { await impl.deliverDirtyChats(); } finally { retry(); }
      expect(attempts).toEqual([fixture.user.id.toString()]);
      expect(publish).not.toHaveBeenCalled();
      write(impl, 1);
      impl.storage.chatNotifications.put({...accepted, chatId: 1, userId: reader.id.toString()});
      await impl.deliverDirtyChats();
    });
    await drained({...fixture, user: reader});
    expect(publish.mock.calls.map(([alert]) => alert.id)).toEqual([accepted.id]);
    expect((await reader.getUnreadSummary()).unreadMessageCount).toBe(2);
  });

  it("drops a failed recipient when they are no longer a collaborator", async () => {
    const fixture = await setup(); const {reader, profile} = await addReader(fixture);
    await withImpl(fixture.workspace, async impl => {
      const restore = interceptDelivery(impl, async (user, ...args) => {
        if (user.id.toString() === reader.id.toString()) throw new Error("Unavailable recipient");
        await user.messageArrived(...args);
      });
      try {
        write(impl, 0);
        await expect(impl.deliverDirtyChats()).rejects.toThrow("Unavailable recipient");
      } finally { restore(); }
      impl.storage.collaborators.delete(profile.id);
      const attempts: string[] = [];
      const retry = interceptDelivery(impl, async (user, ...args) => {
        attempts.push(user.id.toString()); await user.messageArrived(...args);
      });
      try { await impl.deliverDirtyChats(); } finally { retry(); }
      expect(attempts).toEqual([]);
      expect(impl.storage.dirtyChats.get(1)).toBeUndefined();
    });
  });

  it("skips denied-period alerts at the source, then catches counts up without replaying those alerts", async () => {
    const fixture = await setup(); const {reader, owner, profile} = await addReader(fixture);
    const readerFixture = {...fixture, user: reader};
    using publish = vi.spyOn(UserDurableObject.prototype, "publishNotification").mockResolvedValue(undefined);
    await append(fixture, 0); await setRead({...readerFixture, user: reader}, 0);
    const skipped = event(1), accepted = event(2);
    await withImpl(fixture.workspace, async impl => {
      impl.storage.gatekeepers.put({id: 7, resourceTitle: "New connection", class: {} as never,
        creationSpec: {type: "gatekeeper", vendorId: "testvendor", resourceUrl: "https://example.com/7", typeUrlPattern: "https://*"}});
      using admission = vi.spyOn(impl, "ensureObserver");
      write(impl, 1);
      impl.storage.chatNotifications.put({...skipped, chatId: 1, userId: reader.id.toString()});
      await impl.deliverDirtyChats();
      expect(impl.storage.dirtyChats.get(1)).toBeUndefined();
      expect(admission).not.toHaveBeenCalled();
    });
    await evictDurableObject(reader);
    expect(await cursor(readerFixture)).toMatchObject({unreadCount: 0, readThroughSequence: 0});
    expect(await outbox(readerFixture)).toEqual([]);
    await withImpl(fixture.workspace, async impl => {
      impl.storage.observers.put({profileId: profile.id, observerId: crypto.randomUUID(), accountChoices: {7: 1}});
    });
    await reader.recordSharedWorkspaceOpen(fixture.workspaceId, "Workspace", owner, "build", await notificationBaselines(fixture, reader));
    expect((await reader.getUnreadSummary()).unreadMessageCount).toBe(1);
    await withImpl(fixture.workspace, async impl => {
      write(impl, 2);
      impl.storage.chatNotifications.put({...accepted, chatId: 1, userId: reader.id.toString()});
      await impl.deliverDirtyChats();
    });
    await drained(readerFixture);
    expect(publish.mock.calls.map(([alert]) => alert.id)).toEqual([accepted.id]);
    expect((await reader.getUnreadSummary()).unreadMessageCount).toBe(2);
  });

  it.each(["thread", "workspace", "use"] as const)("clears queued intent on %s removal and rejects delayed deliveries after eviction", async removal => {
    const fixture = await setup(); const alert = event(1);
    if (removal === "use") fixture.user = (await addReader(fixture)).reader;
    using publish = vi.spyOn(UserDurableObject.prototype, "publishNotification").mockRejectedValue(new Error("Unavailable"));
    const packet = {...progress(1), notifications: [alert]};
    await fixture.user.messageArrived(fixture.workspaceId, 1, packet);
    await vi.waitFor(() => expect(publish).toHaveBeenCalled());
    if (removal === "thread") await fixture.user.messageArrived(fixture.workspaceId, 1, null);
    else if (removal === "workspace") await fixture.user.workspaceRemoved(fixture.workspaceId);
    else await fixture.user.updateSharedWorkspaceRole(fixture.workspaceId, "use");
    await evictDurableObject(fixture.user);
    await fixture.user.messageArrived(fixture.workspaceId, 1, packet);
    expect(await outbox(fixture)).toEqual([]);
    expect(await fixture.user.getUnreadSummary()).toEqual({workspaces: [], unreadChatCount: 0, unreadMessageCount: 0});
    expect(await fixture.user.getWorkspaceUnreadState(fixture.workspaceId)).toEqual([]);
    if (removal === "thread") expect(await cursor(fixture)).toMatchObject({deleted: true});
    else expect(await cursor(fixture)).toBeUndefined();
  });

  it.each(["thread", "workspace", "all"] as const)("does not carry a %s read into a new workspace admission", async action => {
    const fixture = await setup(); const {reader, owner} = await addReader(fixture);
    const notifying = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    using _publish = vi.spyOn(UserDurableObject.prototype, "publishNotification").mockImplementation(async () => {
      notifying.resolve(); await release.promise;
    });
    try {
      await runInDurableObject(reader, async (instance, ctx) => {
        const packet = {...progress(1), notifications: [event(1)]};
        await instance.messageArrived(fixture.workspaceId, 1, packet);
        await notifying.promise;
        const pending = action === "workspace" ? instance.markWorkspaceRead(fixture.workspaceId) :
          action === "all" ? instance.markAllRead() : instance.applyReadHorizon(fixture.workspaceId, 1, {
          ...packet, readThroughSequence: 1, readThroughVisibleSequence: 1, notificationBaseline: 0,
        }, false);
        await instance.forgetSharedWorkspace(fixture.workspaceId);
        await instance.recordSharedWorkspaceOpen(fixture.workspaceId, "Workspace", owner, "build", []);
        await instance.messageArrived(fixture.workspaceId, 1, progress(10));
        await instance.messageArrived(fixture.workspaceId, 1, progress(11));
        release.resolve(); await pending;
        expect(makeUserStorage(ctx.storage).chatReadCursors.get(`${fixture.workspaceId}:1`))
          .toMatchObject({readThroughSequence: 9, unreadCount: 2});
      });
    } finally { release.resolve(); }
  });

  it.each(["workspace", "all"] as const)("keeps arrivals after a %s read unread", async action => {
    const fixture = await setup();
    const notifying = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    using _publish = vi.spyOn(UserDurableObject.prototype, "publishNotification").mockImplementation(async () => {
      notifying.resolve(); await release.promise;
    });
    try {
      await runInDurableObject(fixture.user, async instance => {
        await instance.messageArrived(fixture.workspaceId, 1, {...progress(1), notifications: [event(1)]});
        await notifying.promise;
        const pending = action === "workspace" ? instance.markWorkspaceRead(fixture.workspaceId) : instance.markAllRead();
        await instance.messageArrived(fixture.workspaceId, 1, {...progress(5, 2), firstVisibleSequence: 2});
        release.resolve(); await pending;
        expect(await instance.getWorkspaceUnreadState(fixture.workspaceId))
          .toEqual([{workspaceId: fixture.workspaceId, chatId: 1, readThroughSequence: 1, unreadMessageCount: 1, notificationsEnabled: true}]);
      });
    } finally { release.resolve(); }
  });

  it("keeps independent private horizons and removes revoked collaborator state", async () => {
    const fixture = await setup(); const {reader, profile} = await addReader(fixture);
    await append(fixture, 0); await setRead(fixture, 0);
    expect((await fixture.user.getUnreadSummary()).unreadMessageCount).toBe(0);
    expect((await reader.getUnreadSummary()).unreadMessageCount).toBe(1);
    await withImpl(fixture.workspace, async impl => {
      impl.storage.collaborators.delete(profile.id);
      await impl.refreshAffectedCollaboratorListings([{profile, addedBy: [], oldAccess: {role: "build"}, newAccess: null}]);
    });
    expect(await reader.getUnreadSummary()).toEqual({workspaces: [], unreadChatCount: 0, unreadMessageCount: 0});
    expect(await reader.getWorkspaceUnreadState(fixture.workspaceId)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Property: unread counts while two people and the agent use three chats in two workspaces, and
// the platform loses, repeats and delays the workspaces' handoffs to the users. fast-check
// generates the steps (see `step`). After each one, for both users, every stored row has
// `unreadCount = latestVisibleSequence - readThroughVisibleSequence` with the model's values, the
// queries list those counts, the summaries are their sums, and a subscriber that folded the
// deltas holds what a snapshot would. A stuck or wrong badge is the first thing every user sees.
//
// The model is docs/user-unread-state.md. A workspace counts each chat's visible messages. A user
// has, per chat, the highest count a handoff or read command brought them and how many of those
// they read. A handoff carries the count rather than a difference, so a repeated or older one
// changes nothing, and the only message that reads itself is a caught-up user's own next one. A
// read command goes through the workspace, so it brings the current count; a bulk read knows only
// what the user already received. Once a user is told a chat is deleted, it stays deleted.
// Scenarios a seed might miss are pinned as `examples`.
describe("unread counts property", () => {
  // What became of one handoff: acknowledged, lost on the way, delivered with its ACK lost, or
  // held up past the handoff limit until a "land" step picks it.
  type Fate = "ack" | "lost" | "noAck" | "late";
  const user = fc.nat({max: 1}), workspace = fc.nat({max: 1}), chat = fc.constantFrom(0, 0, 1, 2);
  const fate = fc.constantFrom<Fate>("ack", "ack", "ack", "ack", "lost", "noAck", "late"), fates = fc.tuple(fate, fate);
  // `user`, `chat` and `workspace` index the lists in replay(); the first chat gets half the steps.
  // A message is `by` a user or the agent, whose "tool" records are not visible. `at` and `pick`
  // choose, modulo the count, among what is there when the step runs: for "read" any record on
  // screen, for "unread" a message. Without `at` the command is the thread menu's, which names no
  // record; "readAll" without `workspace` reads everything. "retry" is a workspace's alarm retrying
  // its failed handoffs. Resets and evictions are the slow steps, so they are the rare ones.
  const step = fc.oneof(
    {weight: 8, arbitrary: fc.record({kind: fc.constant("post" as const), chat, fates,
      by: fc.constantFrom<number | "agent" | "tool">(0, 1, "agent", "agent", "tool")})},
    {weight: 2, arbitrary: fc.record({kind: fc.constant("delete" as const), chat, fates})},
    {weight: 6, arbitrary: fc.record({kind: fc.constantFrom("read" as const, "unread" as const), user, chat,
      at: fc.nat({max: 7})}, {requiredKeys: ["kind", "user", "chat"]})},
    {weight: 2, arbitrary: fc.record({kind: fc.constant("readAll" as const), user, workspace}, {requiredKeys: ["kind", "user"]})},
    {weight: 1, arbitrary: fc.record({kind: fc.constant("resetUser" as const), user})},
    {weight: 3, arbitrary: fc.record({kind: fc.constant("retry" as const), workspace})},
    {weight: 1, arbitrary: fc.record({kind: fc.constant("evictWorkspace" as const), workspace})},
    {weight: 3, arbitrary: fc.record({kind: fc.constant("land" as const), pick: fc.nat({max: 7})})},
  );
  type Step = typeof step extends fc.Arbitrary<infer T> ? T : never;
  // A handoff's content: the chat's visible count and which user, if any, wrote its latest visible
  // message. Null once the chat is deleted.
  type Packet = {head: number; author?: number} | null;
  // `records` says which raw sequences are visible. A run numbers its records across chats, as
  // `write` derives a workspace-unique timestamp from the sequence, so each chat has gaps.
  type Chat = {workspace: number; chatId: number; records: boolean[]; author?: number; deleted?: true; failed: Set<number>};
  type Row = {head: number; read: number; deleted?: true};

  class Folded extends RpcTarget implements UnreadStateSubscriber {
    state?: UserUnreadState;
    first = Promise.withResolvers<void>();
    async updated(state: UserUnreadState) { this.state = state; this.first.resolve(); }
    async summaryUpdated({workspace, ...totals}: UnreadSummaryUpdate) {
      const others = this.state!.workspaces.filter(row => row.workspaceId !== workspace.workspaceId);
      this.state = {...this.state!, ...totals, workspaces: workspace.unreadChatCount ? [...others, workspace] : others};
    }
    async chatUpdated(workspaceId: string, chatId: number, chat: ChatReadState | null, summary: UnreadSummaryUpdate) {
      const others = this.state!.chats.filter(row => row.workspaceId !== workspaceId || row.chatId !== chatId);
      this.state = {...this.state!, chats: chat ? [...others, chat] : others};
      await this.summaryUpdated(summary);
    }
  }
  const unordered = (state: UserUnreadState) => ({...state, chats: new Set(state.chats), workspaces: new Set(state.workspaces)});
  const sum = (counts: number[]) => ({unreadChatCount: counts.filter(Boolean).length,
    unreadMessageCount: counts.reduce((total, count) => total + count, 0)});

  async function replay(steps: Step[]) {
    const first = await setup(), {reader, owner, profile} = await addReader(first), second = await setup(first.user);
    // A second chat in the first workspace, and the collaborator in the second workspace too.
    await withImpl(first.workspace, async impl => {
      impl.storage.chatMeta.put({id: 2, title: "Second", started: new Date(), lastActive: new Date()});
      impl.storage.nextChatSequences.put({chatId: 2, nextSequence: 0, notificationParticipants: [owner.id, profile.id]});
      await impl.deliverDirtyChats();
    });
    await withImpl(second.workspace, async impl => {
      impl.storage.collaborators.put({profile, addedBy: [{type: "user", sharer: owner.id, role: "build", created: new Date()}]});
      const counter = impl.storage.nextChatSequences.get(1)!;
      impl.storage.nextChatSequences.put({...counter, notificationParticipants: [owner.id, profile.id]});
    });
    await reader.recordSharedWorkspaceOpen(second.workspaceId, "Workspace", owner, "build", await notificationBaselines(second, reader));
    const workspaces = [first, second], users = [first.user, reader], authors = [owner, profile];
    // The owner watches the first workspace's chat list and the collaborator the inbox.
    const scopes = [{workspaceId: first.workspaceId}, "unread"] as const;
    const chats: Chat[] = [[0, 1], [0, 2], [1, 1]].map(([workspace, chatId]) => ({workspace, chatId, records: [], failed: new Set()}));
    const rows = users.map(() => chats.map((): Row => ({head: 0, read: 0})));
    const late: {user: number; chat: number; packet: Packet; args: Parameters<UserDurableObject["messageArrived"]>}[] = [];
    let nextSequence = 0;
    const key = (chat: Chat) => `${workspaces[chat.workspace].workspaceId}:${chat.chatId}`;
    // How many of a chat's records through raw sequence `through` are visible.
    const visible = (chat: Chat, through = chat.records.length - 1) => chat.records.slice(0, through + 1).filter(Boolean).length;
    const packetFor = (chat: Chat): Packet => chat.deleted ? null : {head: visible(chat), author: chat.author};
    const receive = (user: number, chat: number, packet: Packet) => {
      const row = rows[user][chat];
      if (row.deleted) return;
      if (!packet) { row.deleted = true; return; }
      const caughtUp = row.head === row.read;
      row.head = Math.max(row.head, packet.head);
      if (caughtUp && row.head === row.read + 1 && packet.author === user) row.read = row.head;
    };

    const subscribe = async (user: number) => {
      const folded = new Folded(), callback = new RpcStub(folded);
      const subscription = await users[user].subscribeToUnreadState(scopes[user], callback);
      await folded.first.promise;
      return {folded, [Symbol.dispose]() { subscription[Symbol.dispose](); callback[Symbol.dispose](); }};
    };
    const subscriptions = [await subscribe(0), await subscribe(1)];

    // Make a change in a chat's workspace and fan it out, each user's handoff meeting its fate.
    // As after any write, failures parked on the workspace's other chats wait for the alarm.
    const fanOut = async (chat: Chat, fates: Fate[], change: (impl: Impl) => void) => {
      const index = chats.indexOf(chat), packet = packetFor(chat);
      await withImpl(workspaces[chat.workspace].workspace, async impl => {
        const restore = interceptDelivery(impl, async (stub, ...args) => {
          const user = users.findIndex(candidate => candidate.id.toString() === stub.id.toString());
          if (fates[user] === "late") late.push({user, chat: index, packet, args});
          else if (fates[user] !== "lost") await stub.messageArrived(...args);
          if (fates[user] !== "ack") throw new Error("Handoff failed");
        });
        try {
          change(impl);
          await impl.deliverDirtyChats({retryFailures: false})
            .catch(error => { if (fates.every(fate => fate === "ack")) throw error; });
        } finally { restore(); }
      });
      fates.forEach((fate, user) => {
        if (fate === "ack" || fate === "noAck") receive(user, index, packet);
        if (fate === "ack") chat.failed.delete(user); else chat.failed.add(user);
      });
    };

    const run = async (step: Step) => {
      switch (step.kind) {
        case "post": {
          const chat = chats[step.chat], shown = step.by !== "tool", author = typeof step.by === "number" ? step.by : undefined;
          if (chat.deleted) break;
          const sequence = nextSequence++;
          chat.records[sequence] = shown;
          if (shown) chat.author = author;
          await fanOut(chat, shown ? step.fates : [], impl => write(impl, sequence, shown ? "Hello" : "", chat.chatId,
            author === undefined ? undefined : authors[author]));
          break;
        }
        case "delete": {
          const chat = chats[step.chat];
          if (chat.deleted) break;
          chat.deleted = true;
          await fanOut(chat, step.fates, impl => { impl.storage.chatMeta.delete(chat.chatId); });
          break;
        }
        case "read": case "unread": {
          const chat = chats[step.chat], row = rows[step.user][step.chat], rewind = step.kind === "unread";
          const messages = chat.records.flatMap((shown, sequence) => shown ? [sequence] : []);
          const offered = rewind ? messages : chat.records.flatMap((_, sequence) => [sequence]);
          const at = step.at === undefined ? undefined : offered[step.at % offered.length];
          await setRead({...workspaces[chat.workspace], user: users[step.user]}, at, rewind, chat.chatId);
          const boundary = at ?? messages.at(-1) ?? -1;
          if (chat.deleted || (rewind && boundary < 0)) break;
          row.read = rewind ? visible(chat, boundary - 1) : Math.max(row.read, visible(chat, boundary));
          row.head = Math.max(row.head, visible(chat));
          break;
        }
        case "readAll":
          await (step.workspace === undefined ? users[step.user].markAllRead()
            : users[step.user].markWorkspaceRead(workspaces[step.workspace].workspaceId));
          for (const [index, row] of rows[step.user].entries()) {
            if (step.workspace === undefined || chats[index].workspace === step.workspace) row.read = row.head;
          }
          break;
        // A subscribed client pins its user's object, so it goes away only by a reset.
        case "resetUser":
          subscriptions[step.user][Symbol.dispose]();
          await expect(runInDurableObject(users[step.user], (_instance, ctx) => ctx.abort("Reset"))).rejects.toThrow("Reset");
          users[step.user] = env.TEST_USER.get(users[step.user].id);
          subscriptions[step.user] = await subscribe(step.user);
          break;
        // An evicted workspace with failed handoffs is next woken by the alarm that retries them.
        case "retry": case "evictWorkspace": {
          if (step.kind === "evictWorkspace") await evictDurableObject(workspaces[step.workspace].workspace);
          const pending = chats.filter(chat => chat.workspace === step.workspace && chat.failed.size);
          const armed = await runDurableObjectAlarm(workspaces[step.workspace].workspace);
          if (pending.length) expect(armed, "failed handoffs keep the workspace's alarm armed").toBe(true);
          for (const chat of pending) {
            for (const user of chat.failed) receive(user, chats.indexOf(chat), packetFor(chat));
            chat.failed.clear();
          }
          break;
        }
        case "land": {
          if (!late.length) break;
          const [handoff] = late.splice(step.pick % late.length, 1);
          await users[handoff.user].messageArrived(...handoff.args);
          receive(handoff.user, handoff.chat, handoff.packet);
          break;
        }
      }
    };

    const check = async (label: string) => {
      for (const [user, stub] of users.entries()) {
        const {stored, summary, listed} = await runInDurableObject(stub, async (instance, ctx) => ({
          stored: chats.map(chat => makeUserStorage(ctx.storage).chatReadCursors.get(key(chat))),
          summary: await instance.getUnreadSummary(),
          listed: (await Promise.all(workspaces.map(({workspaceId}) => instance.getWorkspaceUnreadState(workspaceId)))).flat(),
        }));
        const counts = rows[user].map(row => row.deleted ? 0 : row.head - row.read);
        const rollups = workspaces.map(({workspaceId}, workspace) =>
          ({workspaceId, ...sum(counts.filter((_, index) => chats[index].workspace === workspace))}));
        expect({
          // Per chat: latest, read, unread, and the visible count through the raw read position,
          // which ties the divider the UI draws there to the count.
          stored: stored.map((cursor, chat) => cursor?.deleted ? `deleted, ${cursor.unreadCount} unread` :
            [cursor?.latestVisibleSequence ?? 0, cursor?.readThroughVisibleSequence ?? 0, cursor?.unreadCount ?? 0,
              visible(chats[chat], cursor?.readThroughSequence ?? -1)]),
          listed: Object.fromEntries(listed.map(state => [`${state.workspaceId}:${state.chatId}`, state.unreadMessageCount])),
          summary: unordered({...summary, chats: []}),
        }, `${label}: user ${user}`).toEqual({
          stored: rows[user].map((row, chat) => row.deleted ? "deleted, 0 unread" : [row.head, row.read, counts[chat], row.read]),
          // The queries list every tracked chat that is not deleted, read ones included.
          listed: Object.fromEntries(chats.flatMap((chat, index) =>
            stored[index] && !rows[user][index].deleted ? [[key(chat), counts[index]]] : [])),
          summary: unordered({...sum(counts), workspaces: rollups.filter(rollup => rollup.unreadChatCount), chats: []}),
        });
        const scope = scopes[user], inScope = (state: ChatReadState) =>
          scope === "unread" ? state.unreadMessageCount > 0 : state.workspaceId === scope.workspaceId;
        await vi.waitFor(() => expect(unordered(subscriptions[user].folded.state!), `${label}: user ${user}'s folded deltas`)
          .toEqual(unordered({...summary, chats: listed.filter(inScope)})), {interval: 2});
      }
    };

    try {
      await check("start");
      for (const [index, step] of steps.entries()) {
        await run(step);
        await check(`step ${index} ${JSON.stringify(step)}`);
      }
      // Once the retries are through, everything still on its way is old news.
      await run({kind: "retry", workspace: 0}); await run({kind: "retry", workspace: 1});
      while (late.length) await run({kind: "land", pick: 0});
      await check("settled");
      for (const [user, {folded}] of subscriptions.entries()) {
        using fresh = await subscribe(user);
        expect(unordered(folded.state!), `user ${user}'s folded deltas`).toEqual(unordered(fresh.folded.state!));
      }
    } finally { for (const subscription of subscriptions) subscription[Symbol.dispose](); }
  }

  const [OWNER, READER] = [0, 1], acked: [Fate, Fate] = ["ack", "ack"];
  const examples: [Step[]][] = [
    // Redelivery after mark-unread. The owner's message read itself when it arrived; they mark it
    // unread, and the workspace, which missed the ACK, hands it over again. It stays unread.
    [[
      {kind: "post", chat: 0, by: OWNER, fates: ["noAck", "ack"]},
      {kind: "unread", user: OWNER, chat: 0},
      {kind: "retry", workspace: 0},
    ]],
    // A reset between a fan-out and a read, and an older handoff landing after a newer one. The
    // owner's first handoff is held up, the second brings both messages, and they read through the
    // tool record between the two: one message is left, whenever the first handoff lands. The
    // collaborator reads everything; reading through an earlier record then takes nothing back.
    [[
      {kind: "post", chat: 0, by: "agent", fates: ["late", "ack"]},
      {kind: "post", chat: 0, by: "tool", fates: acked},
      {kind: "post", chat: 0, by: READER, fates: acked},
      {kind: "resetUser", user: OWNER},
      {kind: "read", user: OWNER, chat: 0, at: 1},
      {kind: "land", pick: 0},
      {kind: "read", user: READER, chat: 0},
      {kind: "read", user: READER, chat: 0, at: 0},
    ]],
    // A chat deleted during a pending retry. The collaborator is told at once, so their held-up
    // handoff from before the deletion changes nothing, even after a reset. The owner is not, and
    // goes on counting the message until the evicted workspace's retry brings the deletion.
    [[
      {kind: "post", chat: 1, by: "agent", fates: ["noAck", "late"]},
      {kind: "post", chat: 0, by: "agent", fates: acked},
      {kind: "delete", chat: 1, fates: ["lost", "ack"]},
      {kind: "resetUser", user: READER},
      {kind: "land", pick: 0},
      {kind: "unread", user: OWNER, chat: 1},
      {kind: "evictWorkspace", workspace: 0},
    ]],
  ];

  it("keeps every user's counts, summaries and subscribers on what the workspaces handed over and the user read", async () => {
    using _warnings = vi.spyOn(console, "warn").mockImplementation(() => {}); // One per failed handoff.
    await fc.assert(fc.asyncProperty(fc.array(step, {minLength: 1, maxLength: 24, size: "max"}), replay),
      {...PROPERTY_RUN_OPTIONS, numRuns: 60, examples});
  }, 120_000);
});
