import { env } from "cloudflare:workers";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { RpcStub, RpcTarget } from "capnweb";
import { describe, expect, it, vi } from "vitest";
import type { ChatReadReceipt, UnreadStateSubscriber, UserUnreadState } from "@gadgets/workshop-shared/api";
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
const setup = async (user = env.TEST_USER.getByName(crypto.randomUUID())) => {
  const workspace = env.TEST_OVERSEER.getByName(crypto.randomUUID());
  const workspaceId = workspace.id.toString();
  await user.newWorkspace(workspaceId, "Workspace");
  await withImpl(workspace, async impl => {
    impl.storage.version.put(OVERSEER_STORAGE_VERSION);
    impl.storage.chatMeta.put({id: 1, title: "Demo", started: new Date(), lastActive: new Date()});
    impl.storage.ownerId.put(user.id.toString());
    impl.ownerId = user.id.toString();
  });
  return {user, workspace, workspaceId};
};
type Fixture = Awaited<ReturnType<typeof setup>>;
const write = (impl: Impl, sequence: number, message = "Hello", chatId = 1) => {
  impl.storage.chats.put({chatId, sequence, timestamp: new Date(1_000 + sequence),
    author: {type: "agent", id: "test", name: "Test"}, type: "message", message});
  impl.storage.nextChatSequences.put({...impl.storage.nextChatSequences.get(chatId), chatId, nextSequence: sequence + 1});
};
const append = (fixture: Fixture, sequence: number, message = "Hello") =>
  withImpl(fixture.workspace, async impl => { write(impl, sequence, message); await impl.deliverDirtyChats(); });
const cursor = (fixture: Fixture) => runInDurableObject(fixture.user, (_instance, ctx) =>
  makeUserStorage(ctx.storage).chatReadCursors.get(`${fixture.workspaceId}:1`));
const outbox = (fixture: Fixture) => runInDurableObject(fixture.user, (_instance, ctx) =>
  [...makeUserStorage(ctx.storage).notificationOutbox.list()]);
const drained = (fixture: Fixture) => vi.waitFor(async () => expect(await outbox(fixture)).toEqual([]));
const receipt = (fixture: Fixture, throughSequence: number): ChatReadReceipt =>
  ({workspaceId: fixture.workspaceId, chatId: 1, throughSequence});
const progress = (first = 1, latest = first): ChatMessageProgress => ({
  firstMessageSequence: first, firstVisibleSequence: first, latestVisibleSequence: latest, notifications: [],
});
const event = (sequence: number) => ({id: crypto.randomUUID(), sequence,
  kind: "taskCompleted" as const, chatTitle: "Demo"});
const notificationBaselines = (fixture: Fixture) => withImpl(fixture.workspace, async impl =>
  [...impl.storage.chatMeta.list()].map(meta => ({chatId: meta.id,
    notifiedThroughSequence: impl.nextChatSequencePeek(meta.id) - 1,
    readThroughVisibleSequence: impl.storage.nextChatSequences.get(meta.id)?.visibleThroughSequence ?? 0})));
const addReader = async (fixture: Fixture) => {
  const owner = {type: "user" as const, id: `owner-${fixture.user.id.toString()}`, name: "Owner"};
  const profile = {type: "user" as const, id: `reader-${crypto.randomUUID()}`, name: "Reader"};
  const reader = env.TEST_USER.getByName(profile.id);
  await runInDurableObject(fixture.user, (_instance, ctx) => makeUserStorage(ctx.storage).profile.put(owner));
  await runInDurableObject(reader, (_instance, ctx) => makeUserStorage(ctx.storage).profile.put(profile));
  await withImpl(fixture.workspace, async impl => {
    impl.storage.collaborators.put({profile,
      addedBy: [{type: "user", sharer: owner.id, role: "build", created: new Date()}]});
  });
  await reader.recordSharedWorkspaceOpen(fixture.workspaceId, "Workspace", owner, "build", await notificationBaselines(fixture));
  return {reader, owner, profile};
};

// Fault at the source's real dispatch/ACK boundary, not the test-pool RPC wrapper.
const interceptDelivery = (impl: Impl,
  dispatch: (user: DurableObjectStub<UserDurableObject>,
    ...args: Parameters<UserDurableObject["messageArrived"]>) => Promise<void>,
) => {
  const original = impl.users;
  impl.users = new Proxy(original, {
    get(target, key) {
      if (key === "get") return (id: DurableObjectId) => new Proxy(target.get(id), {
        get(user, member) {
          if (member === "messageArrived") return (...args: Parameters<UserDurableObject["messageArrived"]>) => dispatch(user, ...args);
          return Reflect.get(user, member);
        },
      });
      if (key === "idFromString") return (id: string) => target.idFromString(id);
      if (key === "idFromName") return (name: string) => target.idFromName(name);
      return Reflect.get(target, key);
    },
  });
  return () => { impl.users = original; };
};

describe("persisted visible positions", () => {
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
      impl.storage.chatMeta.put({...impl.storage.chatMeta.get(1)!, title: "Renamed"});
      await impl.deliverDirtyChats();
      write(impl, 10); write(impl, 15);
      await impl.deliverDirtyChats();
      expect(scan).not.toHaveBeenCalled();
      expect(impl.storage.chats.get(chatKey(1, 4))?.visibleThroughSequence).toBeUndefined();
    });
    expect(await cursor(fixture)).toMatchObject({readThroughSequence: 9, readThroughVisibleSequence: 0, unreadCount: 2});
    await fixture.user.markChatUnread(fixture.workspaceId, 1, 0);
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

describe("local counts and explicit read boundaries", () => {
  it("uses one indexed seek for read commands, never counts raw gaps, and makes unchanged reads no-ops", async () => {
    const fixture = await setup();
    await append(fixture, 0); await append(fixture, 6, ""); await append(fixture, 12);
    expect((await fixture.user.getUnreadState()).unreadMessageCount).toBe(2);
    await withImpl(fixture.workspace, async impl => {
      using seek = vi.spyOn(impl.storage.chats, "list");
      await impl.users.get(impl.users.idFromString(fixture.user.id.toString())).markChatRead(receipt(fixture, 6));
      expect(seek).toHaveBeenCalledOnce();
      expect(seek.mock.calls[0]?.[0]).toMatchObject({reverse: true, limit: 1});
    });
    expect(await cursor(fixture)).toMatchObject({readThroughSequence: 6, readThroughVisibleSequence: 1, unreadCount: 1});
    await fixture.user.markChatRead(receipt(fixture, 12));
    await fixture.user.markChatRead(receipt(fixture, 0)); // monotonic
    await runInDurableObject(fixture.user, async instance => {
      using put = vi.spyOn(Reflect.get(instance, "storage").chatReadCursors, "put");
      using source = vi.spyOn(OverseerDurableObject.prototype, "getChatReadPositionForUser");
      await instance.getUnreadState(); await instance.getUnreadState();
      await instance.markChatRead(receipt(fixture, 12));
      await instance.markChatUnread(fixture.workspaceId, 1, 13);
      expect(put).not.toHaveBeenCalled(); expect(source).not.toHaveBeenCalled();
      await expect(instance.markChatRead(receipt(fixture, 13))).rejects.toThrow("Invalid timeline sequence");
    });
    expect(await cursor(fixture)).toMatchObject({readThroughSequence: 12, unreadCount: 0});
  });

  it("applies read/unread in processing order across eviction, without tokens", async () => {
    const fixture = await setup(); await append(fixture, 0);
    await fixture.user.markChatRead(receipt(fixture, 0));
    await fixture.user.markChatUnread(fixture.workspaceId, 1, 0);
    expect(await cursor(fixture)).toMatchObject({unreadCount: 1});
    await evictDurableObject(fixture.user);
    await fixture.user.markChatRead(receipt(fixture, 0));
    expect(await cursor(fixture)).toMatchObject({readThroughSequence: 0, unreadCount: 0});
  });

  it("preserves new arrivals while a read command awaits the source", async () => {
    const fixture = await setup(); await append(fixture, 0);
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const original = OverseerDurableObject.prototype.getChatReadPositionForUser;
    using _source = vi.spyOn(OverseerDurableObject.prototype, "getChatReadPositionForUser")
      .mockImplementationOnce(async function(...args) {
        const state = await original.apply(this, args);
        entered.resolve(); await release.promise; return state;
      });
    await runInDurableObject(fixture.user, async instance => {
      const read = instance.markChatRead(receipt(fixture, 0));
      try { await entered.promise; await append(fixture, 5); }
      finally { release.resolve(); }
      await read;
    });
    expect(await cursor(fixture)).toMatchObject({readThroughVisibleSequence: 1, latestVisibleSequence: 2, unreadCount: 1});
  });

  it("rehydrates all local counts without workspace RPCs or writes, independently of metadata", async () => {
    const fixture = await setup(); const other = await setup(fixture.user);
    await append(fixture, 0); await append(other, 0); await append(other, 2);
    await evictDurableObject(fixture.user);
    using source = vi.spyOn(OverseerDurableObject.prototype, "getChatReadPositionForUser").mockRejectedValue(new Error("No source"));
    using heads = vi.spyOn(OverseerDurableObject.prototype, "getChatHeadsForUser").mockRejectedValue(new Error("Metadata unavailable"));
    await runInDurableObject(fixture.user, async instance => {
      using put = vi.spyOn(Reflect.get(instance, "storage").chatReadCursors, "put");
      expect(await instance.getUnreadState()).toMatchObject({unreadChatCount: 2, unreadMessageCount: 3});
      expect(put).not.toHaveBeenCalled();
      await expect(instance.getChatHeads(fixture.workspaceId)).rejects.toThrow("Metadata unavailable");
      expect((await instance.getUnreadState()).unreadMessageCount).toBe(3);
    });
    expect(source).not.toHaveBeenCalled(); expect(heads).toHaveBeenCalledOnce();
  });

  it("publishes a local snapshot then single-thread deltas, with a tombstone on deletion", async () => {
    const fixture = await setup();
    const snapshots: UserUnreadState[] = [], deltas: Parameters<UnreadStateSubscriber["chatUpdated"]>[] = [];
    class Subscriber extends RpcTarget implements UnreadStateSubscriber {
      async updated(state: UserUnreadState) { snapshots.push(state); }
      async chatUpdated(...args: Parameters<UnreadStateSubscriber["chatUpdated"]>) { deltas.push(args); }
    }
    using callback = new RpcStub(new Subscriber());
    using _subscription = await fixture.user.subscribeToUnreadState(callback);
    await append(fixture, 0);
    await vi.waitFor(() => expect(deltas.at(-1)?.[3].unreadMessageCount).toBe(1));
    expect(snapshots).toHaveLength(1);
    await withImpl(fixture.workspace, async impl => { impl.storage.chatMeta.delete(1); await impl.deliverDirtyChats(); });
    await vi.waitFor(() => expect(deltas.at(-1)?.[2]).toBeNull());
    expect(await cursor(fixture)).toMatchObject({deleted: true, unreadCount: 0});
  });
});

describe("durable forward handoff", () => {
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
    expect((await failing.getUnreadState()).unreadMessageCount).toBe(1);
  });

  it("broadcasts new arrivals without replaying healthy users' older batch", async () => {
    const fixture = await setup(); const {reader} = await addReader(fixture);
    const alerts = [event(0), event(5)];
    using publish = vi.spyOn(UserDurableObject.prototype, "publishNotification").mockResolvedValue(undefined);
    await withImpl(fixture.workspace, async impl => {
      const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
      const restore = interceptDelivery(impl, async (user, ...args) => {
        if (user.id.toString() === reader.id.toString()) {
          entered.resolve(); await release.promise; throw new Error("Unavailable recipient");
        }
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
        expect(impl.storage.dirtyChats.get(1)).toMatchObject({
          firstMessageSequence: 5, firstVisibleSequence: 2,
          failedRecipients: [{userId: reader.id.toString(), firstMessageSequence: 0, firstVisibleSequence: 1}],
        });
        expect(await impl.ctx.storage.getAlarm()).toBeLessThanOrEqual(Date.now() + 1_000);
      } finally { release.resolve(); restore(); }
      const packets = new Map<string, ChatMessageProgress | null>();
      const finish = interceptDelivery(impl, async (user, ...args) => {
        packets.set(user.id.toString(), args[2]); await user.messageArrived(...args);
      });
      try { await impl.deliverDirtyChats(); } finally { finish(); }
      expect(packets.get(fixture.user.id.toString())).toMatchObject({firstMessageSequence: 5, firstVisibleSequence: 2,
        notifications: [{id: alerts[1].id}]});
      expect(packets.get(reader.id.toString())).toMatchObject({firstMessageSequence: 0, firstVisibleSequence: 1});
      expect(impl.storage.dirtyChats.get(1)).toBeUndefined();
    });
    await drained(fixture);
    expect(publish.mock.calls.map(([alert]) => alert.id)).toEqual(alerts.map(alert => alert.id));
    expect((await reader.getUnreadState()).unreadMessageCount).toBe(2);
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
    expect((await reader.getUnreadState()).unreadMessageCount).toBe(1);
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
        const user = impl.users.get(impl.users.idFromString(fixture.user.id.toString()));
        if (command === "read") await user.markChatRead(receipt(fixture, 0));
        else await user.markChatUnread(fixture.workspaceId, 1, 0);
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
      expect((await reader.getUnreadState()).unreadMessageCount).toBe(1);
      await append(fixture, 5);
      const other = await setup(fixture.user); await append(other, 0);
      expect((await fixture.user.getUnreadState()).unreadMessageCount).toBe(3);
      await runInDurableObject(fixture.user, async instance => {
        const retry = instance.alarm();
        const read = instance.markChatRead(receipt(fixture, 0));
        expect((await instance.getUnreadState()).unreadMessageCount).toBe(3);
        expect(publish).toHaveBeenCalledOnce(); // alarm and read wait on the same thread mutex
        release.resolve(); await Promise.all([retry, read]);
      });
    } finally { release.resolve(); }
    await drained(fixture);
    expect(publish).toHaveBeenCalledOnce();
    expect(await cursor(fixture)).toMatchObject({readThroughSequence: 0, unreadCount: 1, notifiedThroughSequence: 0});
  });

  it("leaves newer source mutations dirty while an older batch is in flight", async () => {
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
        expect(impl.storage.dirtyChats.get(1)).toBeDefined();
      } finally { release.resolve(); restore(); }
      await impl.deliverDirtyChats();
      expect(impl.storage.dirtyChats.get(1)).toBeUndefined();
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
        await vi.waitFor(async () => expect((await healthy.getUnreadState()).unreadMessageCount).toBe(1));
        expect(impl.storage.dirtyChats.get(1)).toBeDefined();
        release.resolve(); await pending;
      } finally { release.resolve(); restore(); }
    });
  });
});

describe("recipient-owned notification outbox", () => {
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
    using source = vi.spyOn(OverseerDurableObject.prototype, "getChatReadPositionForUser").mockRejectedValue(new Error("No callback"));
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
    expect(source).not.toHaveBeenCalled();
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
    await vi.waitFor(async () => expect(await cursor(fixture)).toMatchObject({notifiedThroughSequence: 1}));
    expect((await outbox(fixture)).map(alert => alert.id)).toEqual([alerts[1].id, alerts[2].id]);
    failed = false;
    await evictDurableObject(fixture.user); await runDurableObjectAlarm(fixture.user); await drained(fixture);
    expect(received).toEqual([alerts[0].id, alerts[1].id, alerts[1].id, alerts[2].id]);
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
    await expect(runDurableObjectAlarm(fixture.user)).rejects.toThrow("Unavailable");
    expect(await alarm()).toBe(now + 30_000);
    publish.mockResolvedValue(undefined); now += 30_000;
    await runDurableObjectAlarm(fixture.user); await drained(fixture);
    expect(await alarm()).toBeNull();
  });
});

describe("source authorization and removal", () => {
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
    expect((await reader.getUnreadState()).unreadMessageCount).toBe(2);
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
    await append(fixture, 0); await reader.markChatRead(receipt(readerFixture, 0));
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
    await reader.recordSharedWorkspaceOpen(fixture.workspaceId, "Workspace", owner, "build", await notificationBaselines(fixture));
    expect((await reader.getUnreadState()).unreadMessageCount).toBe(1);
    await withImpl(fixture.workspace, async impl => {
      write(impl, 2);
      impl.storage.chatNotifications.put({...accepted, chatId: 1, userId: reader.id.toString()});
      await impl.deliverDirtyChats();
    });
    await drained(readerFixture);
    expect(publish.mock.calls.map(([alert]) => alert.id)).toEqual([accepted.id]);
    expect((await reader.getUnreadState()).unreadMessageCount).toBe(2);
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
    expect(await fixture.user.getUnreadState()).toEqual({chats: [], unreadChatCount: 0, unreadMessageCount: 0});
    if (removal === "thread") expect(await cursor(fixture)).toMatchObject({deleted: true});
    else expect(await cursor(fixture)).toBeUndefined();
  });

  it("does not recreate state when an old read finishes after removal and readmission", async () => {
    const fixture = await setup(); const {reader, owner} = await addReader(fixture);
    const readerFixture = {...fixture, user: reader}; await append(fixture, 0);
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const original = OverseerDurableObject.prototype.getChatReadPositionForUser;
    using _source = vi.spyOn(OverseerDurableObject.prototype, "getChatReadPositionForUser")
      .mockImplementationOnce(async function(...args) {
        const state = await original.apply(this, args); entered.resolve(); await release.promise; return state;
      });
    await runInDurableObject(reader, async instance => {
      const read = instance.markChatRead(receipt(readerFixture, 0));
      try {
        await entered.promise;
        await instance.forgetSharedWorkspace(fixture.workspaceId);
        await instance.recordSharedWorkspaceOpen(fixture.workspaceId, "Workspace", owner, "build", []);
      } finally { release.resolve(); }
      await read;
    });
    expect(await cursor(readerFixture)).toBeUndefined();
  });

  it("keeps independent private horizons and removes revoked collaborator state", async () => {
    const fixture = await setup(); const {reader, profile} = await addReader(fixture);
    await append(fixture, 0); await fixture.user.markChatRead(receipt(fixture, 0));
    expect((await fixture.user.getUnreadState()).unreadMessageCount).toBe(0);
    expect((await reader.getUnreadState()).unreadMessageCount).toBe(1);
    await withImpl(fixture.workspace, async impl => {
      impl.storage.collaborators.delete(profile.id);
      await impl.refreshAffectedCollaboratorListings([{profile, oldRole: "build", newRole: null}]);
    });
    expect(await reader.getUnreadState()).toEqual({chats: [], unreadChatCount: 0, unreadMessageCount: 0});
    expect(await reader.getChatHeads(fixture.workspaceId)).toBeNull();
  });
});
