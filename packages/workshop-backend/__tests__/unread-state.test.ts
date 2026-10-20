import { env } from "cloudflare:workers";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { RpcStub, RpcTarget } from "capnweb";
import { describe, expect, it, vi } from "vitest";
import type { ChatReadReceipt, UnreadStateSubscriber, UserUnreadState } from "@gadgets/workshop-shared/api";
import { UserDurableObject } from "../src/user.js";
import type { OverseerDurableObject } from "../src/overseer.js";
import { makeUserStorage } from "../src/storage-schema/user-storage.js";
import { OVERSEER_STORAGE_VERSION } from "../src/storage-schema/overseer-migrations.js";
import type { GatekeeperUserPickerTestHooks } from "./test-worker.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
    TEST_GATEKEEPER_USER_PICKER: DurableObjectNamespace<GatekeeperUserPickerTestHooks>;
  }
}
type Impl = OverseerDurableObject["impl"];
const withImpl = <T>(stub: DurableObjectStub<OverseerDurableObject>, fn: (impl: Impl) => Promise<T>) =>
  runInDurableObject(stub, instance => fn(instance.impl));
const setup = async (user = env.TEST_USER.getByName(crypto.randomUUID())) => {
  const workspace = env.TEST_OVERSEER.getByName(crypto.randomUUID());
  const workspaceId = workspace.id.toString();
  await user.newGadget(workspaceId, "Workspace");
  await withImpl(workspace, async impl => {
    impl.storage.version.put(OVERSEER_STORAGE_VERSION);
    impl.storage.chatMeta.put({id: 1, title: "Demo", started: new Date(), lastActive: new Date()});
    impl.storage.ownerId.put(user.id.toString());
    impl.ownerId = user.id.toString();
  });
  return {user, workspace, workspaceId};
};
type Fixture = Awaited<ReturnType<typeof setup>>;
const append = (fixture: Fixture, sequence: number, message = "Hello") =>
  withImpl(fixture.workspace, async impl => {
    impl.storage.chats.put({chatId: 1, sequence, timestamp: new Date(1_000 + sequence),
      author: {type: "agent", id: "test", name: "Test"}, type: "message", message});
    impl.storage.nextChatSequences.put({chatId: 1, nextSequence: sequence + 1});
    await impl.deliverDirtyChats();
  });
const cursor = (fixture: Fixture) => runInDurableObject(fixture.user, (_instance, ctx) =>
  makeUserStorage(ctx.storage).chatReadCursors.get(`${fixture.workspaceId}:1`));
const receipt = (fixture: Fixture, throughSequence: number): ChatReadReceipt =>
  ({workspaceId: fixture.workspaceId, chatId: 1, throughSequence});
const settled = async (fixture: Fixture) => vi.waitFor(async () => {
  const row = await cursor(fixture);
  expect(row).toBeDefined();
  expect(row?.unreadDirty || row?.notificationsDirty).toBeFalsy();
});
const notificationBaselines = (fixture: Fixture) => withImpl(fixture.workspace, async impl =>
  [...impl.storage.chatMeta.list()].map(meta => ({chatId: meta.id,
    notifiedThroughSequence: impl.nextChatSequencePeek(meta.id) - 1})));
const addReader = async (fixture: Fixture) => {
  const owner = {type: "user" as const, id: `owner-${crypto.randomUUID()}`, name: "Owner"};
  const profile = {type: "user" as const, id: `reader-${crypto.randomUUID()}`, name: "Reader"};
  const reader = env.TEST_USER.getByName(profile.id);
  await runInDurableObject(fixture.user, (_instance, ctx) => makeUserStorage(ctx.storage).profile.put(owner));
  await runInDurableObject(reader, (_instance, ctx) => makeUserStorage(ctx.storage).profile.put(profile));
  await withImpl(fixture.workspace, async impl => {
    impl.storage.collaborators.put({profile,
      addedBy: [{type: "user", sharer: owner.id, role: "build", created: new Date()}]});
  });
  await reader.recordSharedGadgetOpen(fixture.workspaceId, "Workspace", owner, "build",
    await notificationBaselines(fixture));
  return {reader, owner, profile};
};

// Fault at the source's real dispatch/ACK boundary, rather than in the test-pool wrapper.
const interceptDelivery = (impl: Impl,
  dispatch: (user: DurableObjectStub<UserDurableObject>, workspaceId: string, chatId: number) => Promise<void>,
) => {
  const original = impl.users;
  impl.users = new Proxy(original, {
    get(target, key) {
      if (key === "get") return (id: DurableObjectId) => new Proxy(target.get(id), {
        get(user, member) {
          if (member === "messageArrived") return (workspaceId: string, chatId: number) =>
            dispatch(user, workspaceId, chatId);
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

describe("private horizons and coalesced dirty threads", () => {
  it("counts messages rather than sequence gaps; commits horizon/count together; keeps reads monotonic", async () => {
    const fixture = await setup();
    await append(fixture, 0, "First line\nSecond line");
    await append(fixture, 6, "");
    await append(fixture, 12, "Latest");
    expect(await fixture.user.getUnreadState()).toMatchObject({unreadMessageCount: 2,
      chats: [{latestSequence: 12, latestMessagePreview: "Latest", unreadMessageCount: 2}]});
    await fixture.user.markChatRead(receipt(fixture, 0));
    expect(await cursor(fixture)).toMatchObject({readThroughSequence: 0, unreadCount: 1});
    await fixture.user.markChatRead(receipt(fixture, 12));
    expect(await cursor(fixture)).toMatchObject({readThroughSequence: 12, unreadCount: 0});
    await fixture.user.markChatUnread(fixture.workspaceId, 1, 0);
    expect(await cursor(fixture)).toMatchObject({readThroughSequence: -1, unreadCount: 2});
    await fixture.user.markChatRead(receipt(fixture, 12));
    await fixture.user.markChatRead(receipt(fixture, 0));
    expect(await cursor(fixture)).toMatchObject({readThroughSequence: 12, unreadCount: 0});
  });

  it("does not write read state for reads, repeated receipts, or unchanged UI hydration", async () => {
    const fixture = await setup();
    await append(fixture, 0);
    const observed = receipt(fixture, 0);
    await fixture.user.markChatRead(observed);
    await settled(fixture);
    await runInDurableObject(fixture.user, async instance => {
      using write = vi.spyOn(Reflect.get(instance, "storage").chatReadCursors, "put");
      await instance.getUnreadState();
      await instance.getUnreadState();
      await instance.markChatRead(observed);
      await instance.markChatUnread(fixture.workspaceId, 1, 1);
      expect(write).not.toHaveBeenCalled();
    });
  });

  it("accepts observed non-countable timeline boundaries but rejects future receipts", async () => {
    const fixture = await setup();
    await append(fixture, 0);
    await withImpl(fixture.workspace, async impl => {
      impl.storage.chats.put({chatId: 1, sequence: 1, timestamp: new Date(), type: "error",
        author: {type: "agent", id: "test", name: "Test"}, message: "Turn failed"});
      impl.storage.nextChatSequences.put({chatId: 1, nextSequence: 2});
    });
    await fixture.user.markChatRead(receipt(fixture, 1));
    expect(await cursor(fixture)).toMatchObject({readThroughSequence: 1, unreadCount: 0});
    await fixture.user.markChatUnread(fixture.workspaceId, 1, 1);
    expect(await cursor(fixture)).toMatchObject({readThroughSequence: 0, unreadCount: 0});
    await runInDurableObject(fixture.user, async instance => {
      await expect(instance.markChatRead(receipt(fixture, 2))).rejects.toThrow("Invalid timeline sequence");
    });
    expect(await cursor(fixture)).toMatchObject({readThroughSequence: 0, unreadCount: 0});
  });

  it.each([false, true])("applies read/unread commands in processing order (reset: %s)", async reset => {
    const fixture = await setup();
    await append(fixture, 0);
    const delayed = receipt(fixture, 0);
    await fixture.user.markChatRead(delayed);
    await fixture.user.markChatUnread(fixture.workspaceId, 1, 0);
    await settled(fixture);
    if (reset) await evictDurableObject(fixture.user);
    // Even a previously dispatched read applies if it is processed after the manual unread.
    await fixture.user.markChatRead(delayed);
    expect(await cursor(fixture)).toMatchObject({readThroughSequence: 0, unreadCount: 0});
    await fixture.user.markChatUnread(fixture.workspaceId, 1, 0);
    expect(await cursor(fixture)).toMatchObject({readThroughSequence: -1, unreadCount: 1});
  });

  it("broadcasts removal of an unavailable workspace even when it has no cursors", async () => {
    const fixture = await setup();
    const {reader} = await addReader(fixture);
    // Empty the initial admission row to exercise metadata failure before any thread was loaded.
    await runInDurableObject(reader, (_instance, ctx) => {
      makeUserStorage(ctx.storage).chatReadCursors.byWorkspace.delete(fixture.workspaceId);
    });
    await evictDurableObject(reader);
    const {OverseerDurableObject} = await import("../src/overseer.js");
    using _unavailable = vi.spyOn(OverseerDurableObject.prototype, "getChatHeadsForUser")
      .mockRejectedValue(new Error("temporarily unavailable"));
    const snapshots: UserUnreadState[] = [];
    class Subscriber extends RpcTarget implements UnreadStateSubscriber {
      async updated(state: UserUnreadState) { snapshots.push(state); }
      async chatUpdated() {}
    }
    using callback = new RpcStub(new Subscriber());
    using _subscription = await reader.subscribeToUnreadState(callback);
    await vi.waitFor(() => expect(snapshots.at(-1)?.unavailableWorkspaceIds).toEqual([fixture.workspaceId]));
    await reader.forgetSharedGadget(fixture.workspaceId);
    await vi.waitFor(() => expect(snapshots.at(-1)).toEqual({chats: [], unreadChatCount: 0, unreadMessageCount: 0}));
    expect(await reader.getUnreadState()).toEqual(snapshots.at(-1));
  });

  it("rehydrates counts after real eviction without recounting source history", async () => {
    const fixture = await setup();
    await append(fixture, 0);
    await settled(fixture);
    await evictDurableObject(fixture.user);
    using recount = vi.spyOn((await import("../src/overseer.js")).OverseerDurableObject.prototype,
      "getChatStateForUser").mockRejectedValue(new Error("no recount"));
    expect((await fixture.user.getUnreadState()).unreadMessageCount).toBe(1);
    expect(recount).not.toHaveBeenCalled();
  });

  it("serializes a read against an in-flight count so the old count cannot overwrite the new horizon", async () => {
    const fixture = await setup();
    await append(fixture, 0);
    await settled(fixture);
    const observed = receipt(fixture, 0);
    const {OverseerDurableObject} = await import("../src/overseer.js");
    const original = OverseerDurableObject.prototype.getChatStateForUser;
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
    let first = true;
    using _count = vi.spyOn(OverseerDurableObject.prototype, "getChatStateForUser")
      .mockImplementation(async function(...args) {
        if (first) { first = false; entered.resolve(); await gate.promise; }
        return original.apply(this, args);
      });
    await withImpl(fixture.workspace, async impl => {
      const user = impl.users.get(impl.users.idFromString(fixture.user.id.toString()));
      const update = user.messageArrived(fixture.workspaceId, 1);
      await entered.promise;
      const read = user.markChatRead(observed);
      gate.resolve();
      await Promise.all([update, read]);
    });
    expect(await cursor(fixture)).toMatchObject({readThroughSequence: 0, unreadCount: 0});
  });

  it.each([false, true])("coalesces snapshot/alarm recalculations across awaits (dirty: %s)", async dirty => {
    const fixture = await setup();
    if (dirty) { await append(fixture, 0); await settled(fixture); }
    const {OverseerDurableObject} = await import("../src/overseer.js");
    const original = OverseerDurableObject.prototype.getChatStateForUser;
    const originalHeads = OverseerDurableObject.prototype.getChatHeadsForUser;
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const refreshed = Promise.withResolvers<void>();
    let metadataReads = 0;
    using _metadata = vi.spyOn(OverseerDurableObject.prototype, "getChatHeadsForUser")
      .mockImplementation(async function(...args) {
        const heads = await originalHeads.apply(this, args);
        if (++metadataReads === 2) refreshed.resolve();
        return heads;
      });
    using recount = vi.spyOn(OverseerDurableObject.prototype, "getChatStateForUser")
      .mockImplementation(async function(...args) {
        entered.resolve();
        await release.promise;
        return original.apply(this, args);
      });
    await runInDurableObject(fixture.user, async instance => {
      if (dirty) {
        const storage = Reflect.get(instance, "storage") as ReturnType<typeof makeUserStorage>;
        const row = storage.chatReadCursors.get(`${fixture.workspaceId}:1`)!;
        storage.chatReadCursors.put({...row, unreadDirty: true});
      }
      const first = instance.getUnreadState();
      await entered.promise;
      const second = instance.getUnreadState();
      try {
        await refreshed.promise;
        // Deliver the second metadata response while the first calculation is still suspended.
        await new Promise(resolve => setTimeout(resolve, 0));
      } finally { release.resolve(); }
      const [one, two] = await Promise.all([first, second, instance.alarm()]);
      expect(one.unreadMessageCount).toBe(dirty ? 1 : 0);
      expect(two).toEqual(one);
    });
    expect(recount).toHaveBeenCalledOnce();
  });

  it("sends a single-thread delta with totals, and removes deleted threads", async () => {
    const fixture = await setup();
    const snapshots: UserUnreadState[] = [];
    const deltas: Parameters<UnreadStateSubscriber["chatUpdated"]>[] = [];
    class Subscriber extends RpcTarget implements UnreadStateSubscriber {
      async updated(state: UserUnreadState) { snapshots.push(state); }
      async chatUpdated(...args: Parameters<UnreadStateSubscriber["chatUpdated"]>) { deltas.push(args); }
    }
    using callback = new RpcStub(new Subscriber());
    using _subscription = await fixture.user.subscribeToUnreadState(callback);
    await append(fixture, 0);
    await vi.waitFor(() => expect(deltas.at(-1)?.[3].unreadMessageCount).toBe(1));
    expect(snapshots).toHaveLength(1);
    await withImpl(fixture.workspace, async impl => {
      impl.storage.chatMeta.delete(1);
      await impl.deliverDirtyChats();
    });
    await vi.waitFor(() => expect(deltas.at(-1)?.[2]).toBeNull());
    expect(await cursor(fixture)).toBeUndefined();
  });

  it("publishes snapshot-discovered threads and renames before their delayed fanout", async () => {
    const fixture = await setup();
    await append(fixture, 0);
    await settled(fixture);
    const snapshots: UserUnreadState[] = [];
    class Subscriber extends RpcTarget implements UnreadStateSubscriber {
      async updated(state: UserUnreadState) { snapshots.push(state); }
      async chatUpdated() {}
    }
    using callback = new RpcStub(new Subscriber());
    using _subscription = await fixture.user.subscribeToUnreadState(callback);
    await vi.waitFor(() => expect(snapshots.at(-1)?.unreadMessageCount).toBe(1));
    await withImpl(fixture.workspace, async impl => {
      const gate = Promise.withResolvers<void>();
      const restore = interceptDelivery(impl, async (user, workspaceId, chatId) => {
        await gate.promise;
        await user.messageArrived(workspaceId, chatId);
      });
      try {
        impl.storage.chatMeta.put({id: 2, title: "New thread", started: new Date(), lastActive: new Date(2_000)});
        impl.storage.chats.put({chatId: 2, sequence: 0, timestamp: new Date(), type: "message",
          author: {type: "agent", id: "test", name: "Test"}, message: "New message"});
        impl.storage.chatMeta.put({...impl.storage.chatMeta.get(1)!, title: "Renamed"});
        // Another device refreshes while source delivery is still pending.
        const user = impl.users.get(impl.users.idFromString(fixture.user.id.toString()));
        const refreshed = await user.getUnreadState();
        expect(refreshed.unreadMessageCount).toBe(2);
        await vi.waitFor(() => expect(snapshots.at(-1)).toEqual(refreshed));
      } finally { gate.resolve(); restore(); }
      await impl.deliverDirtyChats();
    });
    await vi.waitFor(() => expect(snapshots.at(-1)?.chats).toEqual(expect.arrayContaining([
      expect.objectContaining({chatId: 1, chatTitle: "Renamed"}),
      expect.objectContaining({chatId: 2, unreadMessageCount: 1}),
    ])));
    const count = snapshots.length;
    await fixture.user.getUnreadState();
    expect(snapshots).toHaveLength(count);
  });

  it.each([false, true])("recovers source eviction (lost ACK: %s)", async lostAck => {
    const fixture = await setup();
    await withImpl(fixture.workspace, async impl => {
      const restore = interceptDelivery(impl, async (user, workspaceId, chatId) => {
        if (lostAck) await user.messageArrived(workspaceId, chatId);
        throw new Error("injected lost dispatch/ACK");
      });
      try {
        impl.storage.chats.put({chatId: 1, sequence: 0, timestamp: new Date(), type: "message",
          author: {type: "agent", id: "test", name: "Test"}, message: "Durable"});
        await expect(impl.deliverDirtyChats()).rejects.toThrow("injected");
        expect(impl.storage.dirtyChats.get(1)).toBeDefined();
        expect(await impl.ctx.storage.getAlarm()).not.toBeNull();
      } finally { restore(); }
    });
    await evictDurableObject(fixture.workspace);
    await runDurableObjectAlarm(fixture.workspace);
    expect(await cursor(fixture)).toMatchObject({unreadCount: 1});
    await withImpl(fixture.workspace, async impl => expect([...impl.storage.dirtyChats.list()]).toEqual([]));
  });

  it("does not consume an undelivered alert when a snapshot beats delayed fanout", async () => {
    const fixture = await setup();
    const id = crypto.randomUUID();
    using delivered = vi.spyOn(UserDurableObject.prototype, "publishNotification").mockResolvedValue(undefined);
    await withImpl(fixture.workspace, async impl => {
      const release = Promise.withResolvers<void>();
      const restore = interceptDelivery(impl, async (user, workspaceId, chatId) => {
        await release.promise;
        await user.messageArrived(workspaceId, chatId);
      });
      try {
        impl.storage.chats.put({chatId: 1, sequence: 0, timestamp: new Date(), type: "message",
          author: {type: "agent", id: "test", name: "Test"}, message: "Finished"});
        impl.storage.chatNotifications.put({id, chatId: 1, sequence: 0,
          userId: fixture.user.id.toString(), kind: "taskCompleted"});
        const user = impl.users.get(impl.users.idFromString(fixture.user.id.toString()));
        expect((await user.getUnreadState()).unreadMessageCount).toBe(1);
      } finally { release.resolve(); restore(); }
      await impl.deliverDirtyChats();
    });
    await settled(fixture);
    expect(delivered.mock.calls.map(([event]) => event.id)).toEqual([id]);
    expect(await cursor(fixture)).toMatchObject({notifiedThroughSequence: 0});
  });

  it("preserves a newer recounted head when an older metadata response arrives", async () => {
    const fixture = await setup();
    await append(fixture, 0, "Old");
    await settled(fixture);
    await fixture.user.getUnreadState();
    const {OverseerDurableObject} = await import("../src/overseer.js");
    const original = OverseerDurableObject.prototype.getChatHeadsForUser;
    const captured = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    using _heads = vi.spyOn(OverseerDurableObject.prototype, "getChatHeadsForUser")
      .mockImplementationOnce(async function(...args) {
        const heads = await original.apply(this, args);
        captured.resolve();
        await release.promise;
        return heads;
      });
    await withImpl(fixture.workspace, async impl => {
      const user = impl.users.get(impl.users.idFromString(fixture.user.id.toString()));
      const snapshot = user.getUnreadState();
      await captured.promise;
      try {
        impl.storage.chats.put({chatId: 1, sequence: 1, timestamp: new Date(2_000), type: "message",
          author: {type: "agent", id: "test", name: "Test"}, message: "New"});
        await impl.deliverDirtyChats();
      } finally { release.resolve(); }
      expect((await snapshot).chats[0]).toMatchObject({latestSequence: 1,
        latestMessagePreview: "New", unreadMessageCount: 2});
    });
  });

  it("fetches counts and notification candidates together once per dirty thread", async () => {
    const fixture = await setup();
    await fixture.user.getUnreadState();
    const {OverseerDurableObject} = await import("../src/overseer.js");
    using count = vi.spyOn(OverseerDurableObject.prototype, "getChatStateForUser");
    await withImpl(fixture.workspace, async impl => {
      for (let sequence = 0; sequence < 20; sequence++) {
        impl.storage.chats.put({chatId: 1, sequence, timestamp: new Date(1_000 + sequence), type: "message",
          author: {type: "agent", id: "test", name: "Test"}, message: "Unread"});
      }
      await impl.deliverDirtyChats();
    });
    await settled(fixture);
    expect(await cursor(fixture)).toMatchObject({unreadCount: 20});
    expect(count).toHaveBeenCalledOnce();
  });

  it("holds the same thread mutex through notification delivery, snapshots and read commands", async () => {
    const fixture = await setup();
    await append(fixture, 0);
    await settled(fixture);
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    using delivered = vi.spyOn(UserDurableObject.prototype, "publishNotification").mockImplementation(async () => {
      entered.resolve();
      await release.promise;
    });
    const {OverseerDurableObject} = await import("../src/overseer.js");
    using count = vi.spyOn(OverseerDurableObject.prototype, "getChatStateForUser");
    await withImpl(fixture.workspace, async impl => {
      const user = impl.users.get(impl.users.idFromString(fixture.user.id.toString()));
      impl.storage.chatNotifications.put({id: crypto.randomUUID(), chatId: 1, sequence: 1,
        userId: fixture.user.id.toString(), kind: "taskCompleted"});
      const delivery = impl.deliverDirtyChats();
      await entered.promise;
      const snapshot = user.getUnreadState(), read = user.markChatRead(receipt(fixture, 0));
      try {
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(count).toHaveBeenCalledOnce();
      } finally { release.resolve(); }
      await Promise.all([delivery, snapshot, read]);
    });
    expect(delivered).toHaveBeenCalledOnce();
    expect(count).toHaveBeenCalledTimes(2); // One dirty calculation, then the explicit read command.
    expect(await cursor(fixture)).toMatchObject({readThroughSequence: 0, unreadCount: 0,
      notifiedThroughSequence: 1});
  });

  it("keeps new dirtiness that arrives while the locked calculation is awaiting a source response", async () => {
    const fixture = await setup();
    await append(fixture, 0);
    await settled(fixture);
    const {OverseerDurableObject} = await import("../src/overseer.js");
    const original = OverseerDurableObject.prototype.getChatStateForUser;
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    using count = vi.spyOn(OverseerDurableObject.prototype, "getChatStateForUser")
      .mockImplementationOnce(async function(...args) {
        const state = await original.apply(this, args);
        entered.resolve();
        await release.promise;
        return state;
      });
    await withImpl(fixture.workspace, async impl => {
      const user = impl.users.get(impl.users.idFromString(fixture.user.id.toString()));
      const first = user.messageArrived(fixture.workspaceId, 1);
      await entered.promise;
      impl.storage.chats.put({chatId: 1, sequence: 1, timestamp: new Date(), type: "message",
        author: {type: "agent", id: "test", name: "Test"}, message: "During recount"});
      const second = user.messageArrived(fixture.workspaceId, 1);
      try { await vi.waitFor(() => expect(count).toHaveBeenCalledOnce()); }
      finally { release.resolve(); }
      await Promise.all([first, second, impl.deliverDirtyChats()]);
    });
    await settled(fixture);
    expect(await cursor(fixture)).toMatchObject({unreadCount: 2});
  });

  it.each(["reopen", "reauth"])("parks confirmed denial without polling until %s", async signal => {
    const fixture = await setup();
    const {reader, owner, profile} = await addReader(fixture);
    const readerFixture = {...fixture, user: reader};
    await withImpl(fixture.workspace, async impl => {
      impl.storage.gatekeepers.put({id: 7, resourceTitle: "New connection", class: {} as never,
        creationSpec: {type: "gatekeeper", vendorId: "testvendor", resourceUrl: "https://example.com/7",
          typeUrlPattern: "https://*"}});
    });
    await append(fixture, 0);
    expect(await cursor(readerFixture)).toMatchObject({unreadDirty: true, notificationsDirty: true});
    const {OverseerDurableObject} = await import("../src/overseer.js");
    using count = vi.spyOn(OverseerDurableObject.prototype, "getChatStateForUser");
    using heads = vi.spyOn(OverseerDurableObject.prototype, "getChatHeadsForUser");
    await runInDurableObject(reader, instance => instance.alarm());
    await reader.getUnreadState();
    await runInDurableObject(reader, instance => instance.alarm());
    expect(count).not.toHaveBeenCalled();
    expect(heads).not.toHaveBeenCalled();
    expect(await runInDurableObject(reader, (_instance, ctx) => ctx.storage.getAlarm())).toBeNull();
    let accountId: number | undefined;
    if (signal === "reauth") {
      accountId = await env.TEST_GATEKEEPER_USER_PICKER.getByName(crypto.randomUUID())
        .addAccount(profile.id, "testvendor", `${profile.id}-account`);
      await reader.markCredentialsRestored(accountId);
      await vi.waitFor(() => expect(heads).toHaveBeenCalledOnce());
      expect(await reader.getUnreadState()).toMatchObject({chats: [], unreadMessageCount: 0});
      expect(count).not.toHaveBeenCalled(); // Restored credentials alone grant no workspace access.
    }
    await withImpl(fixture.workspace, async impl => {
      impl.storage.observers.put({profileId: profile.id, observerId: crypto.randomUUID(), accountChoices: {7: 1}});
    });
    if (signal === "reauth") await reader.markCredentialsRestored(accountId!);
    else await reader.recordSharedGadgetOpen(fixture.workspaceId, "Workspace", owner, "build",
      await notificationBaselines(fixture));
    await settled(readerFixture);
    expect((await reader.getUnreadState()).unreadMessageCount).toBe(1);
    expect(count).toHaveBeenCalledOnce();
  });

  it("schedules a prompt alarm for a newer mutation that arrived during fanout", async () => {
    const fixture = await setup();
    await withImpl(fixture.workspace, async impl => {
      let first = true;
      const restore = interceptDelivery(impl, async (user, workspaceId, chatId) => {
        await user.messageArrived(workspaceId, chatId);
        if (first) {
          first = false;
          impl.storage.chats.put({chatId: 1, sequence: 1, timestamp: new Date(), type: "message",
            author: {type: "agent", id: "test", name: "Test"}, message: "Arrived during ACK"});
        }
      });
      try {
        impl.markChatDirty(1);
        await impl.deliverDirtyChats();
        expect(impl.storage.dirtyChats.get(1)).toBeDefined();
        expect(await impl.ctx.storage.getAlarm()).toBeLessThanOrEqual(Date.now() + 1_100);
      } finally { restore(); }
    });
    await runDurableObjectAlarm(fixture.workspace);
    await withImpl(fixture.workspace, async impl => {
      expect(impl.storage.dirtyChats.get(1)).toBeUndefined();
    });
    expect(await cursor(fixture)).toMatchObject({unreadCount: 1});
  });

  it.each(["count", "notification"])("recovers a reset while %s holds the thread mutex", async phase => {
    const fixture = await setup();
    await append(fixture, 0);
    await settled(fixture);
    const {OverseerDurableObject} = await import("../src/overseer.js");
    const original = OverseerDurableObject.prototype.getChatStateForUser;
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const notificationId = crypto.randomUUID();
    let first = true;
    using recount = vi.spyOn(OverseerDurableObject.prototype, "getChatStateForUser")
      .mockImplementation(async function(...args) {
        if (first && phase === "count") { first = false; entered.resolve(); await release.promise; }
        const state = await original.apply(this, args);
        return phase === "notification" && state && state !== "denied" ? {...state,
          notifications: [{id: notificationId, chatId: 1, sequence: 0,
            userId: fixture.user.id.toString(), kind: "taskCompleted" as const}]} : state;
      });
    using notifications = vi.spyOn(UserDurableObject.prototype, "publishNotification").mockImplementation(async () => {
      if (first && phase === "notification") { first = false; entered.resolve(); await release.promise; }
    });
    try {
      await expect(runInDurableObject(fixture.user, async (instance, ctx) => {
        void instance.messageArrived(fixture.workspaceId, 1).catch(() => {});
        await entered.promise;
        expect(makeUserStorage(ctx.storage).chatReadCursors.get(`${fixture.workspaceId}:1`))
          .toMatchObject(phase === "count" ? {unreadDirty: true} :
            {notifiedThroughSequence: -1, notificationsDirty: true});
        expect(await ctx.storage.getAlarm()).not.toBeNull();
        ctx.abort("Injected recount reset");
      })).rejects.toThrow("Injected recount reset");
    } finally { release.resolve(); }
    fixture.user = env.TEST_USER.get(fixture.user.id);
    await runDurableObjectAlarm(fixture.user);
    await settled(fixture);
    expect(await cursor(fixture)).toMatchObject({unreadCount: 1});
    expect(recount.mock.calls.length).toBeGreaterThan(1);
    if (phase === "notification") {
      expect(notifications.mock.calls.map(([event]) => event.id)).toEqual([notificationId, notificationId]);
      expect(await cursor(fixture)).toMatchObject({notifiedThroughSequence: 0});
      expect(recount.mock.calls.at(-1)?.[3]).toBeNull(); // Recovery retries delivery without rescanning counts.
    }
  });

  it("fans out to two users with independent horizons without re-registering observers", async () => {
    const fixture = await setup();
    const {reader, profile} = await addReader(fixture);
    await withImpl(fixture.workspace, async impl => {
      using admission = vi.spyOn(impl, "ensureObserver");
      impl.markChatDirty(1);
      await impl.deliverDirtyChats();
      expect(admission).not.toHaveBeenCalled();
    });
    await append(fixture, 0);
    await fixture.user.markChatRead(receipt(fixture, 0));
    expect((await fixture.user.getUnreadState()).unreadMessageCount).toBe(0);
    expect((await reader.getUnreadState()).unreadMessageCount).toBe(1);
    await withImpl(fixture.workspace, async impl => { impl.storage.collaborators.delete(profile.id); });
    expect(await reader.getUnreadState()).toMatchObject({chats: [], unreadMessageCount: 0});
    await reader.updateSharedGadgetRole(fixture.workspaceId, "use");
    expect(await reader.getUnreadState()).toMatchObject({chats: [], unreadMessageCount: 0});
  });

  it.each([
    {snapshotFirst: false, reset: false},
    {snapshotFirst: true, reset: false},
    {snapshotFirst: true, reset: true},
  ])("preserves horizons and catches up after admission (snapshot first: $snapshotFirst, reset: $reset)",
      async ({snapshotFirst, reset}) => {
    const fixture = await setup();
    const {reader, owner, profile} = await addReader(fixture);
    const readerFixture = {...fixture, user: reader};
    using delivered = vi.spyOn(UserDurableObject.prototype, "publishNotification").mockResolvedValue(undefined);
    const oldId = crypto.randomUUID(), newId = crypto.randomUUID();
    await append(fixture, 0);
    await reader.markChatRead(receipt(readerFixture, 0));
    await withImpl(fixture.workspace, async impl => {
      impl.storage.chatNotifications.put({id: oldId, chatId: 1, sequence: 0,
        userId: reader.id.toString(), kind: "taskCompleted"});
      await impl.deliverDirtyChats();
    });
    await settled(readerFixture);
    expect(await cursor(readerFixture)).toMatchObject({readThroughSequence: 0, notifiedThroughSequence: 0});
    await withImpl(fixture.workspace, async impl => {
      impl.storage.gatekeepers.put({id: 7, resourceTitle: "New connection", class: {} as never,
        creationSpec: {type: "gatekeeper", vendorId: "testvendor", resourceUrl: "https://example.com/7",
          typeUrlPattern: "https://*"}});
    });
    if (snapshotFirst) expect(await reader.getUnreadState()).toMatchObject({chats: [], unreadMessageCount: 0});
    await append(fixture, 1, "Arrived while admission was needed");
    await withImpl(fixture.workspace, async impl => {
      impl.storage.chatNotifications.put({id: newId, chatId: 1, sequence: 1,
        userId: reader.id.toString(), kind: "taskCompleted"});
      await impl.deliverDirtyChats();
    });
    if (reset) await evictDurableObject(reader);
    expect(await reader.getUnreadState()).toMatchObject({chats: [], unreadMessageCount: 0});
    expect(await cursor(readerFixture)).toMatchObject({readThroughSequence: 0, notifiedThroughSequence: 0,
      unreadDirty: true, notificationsDirty: true});
    expect(delivered.mock.calls.map(([event]) => event.id)).toEqual([oldId]);

    const counts: number[] = [];
    class Subscriber extends RpcTarget implements UnreadStateSubscriber {
      async updated(state: UserUnreadState) { counts.push(state.unreadMessageCount); }
      async chatUpdated(...args: Parameters<UnreadStateSubscriber["chatUpdated"]>) {
        counts.push(args[3].unreadMessageCount);
      }
    }
    using callback = new RpcStub(new Subscriber());
    using _subscription = await reader.subscribeToUnreadState(callback);
    await withImpl(fixture.workspace, async impl => {
      impl.storage.observers.put({profileId: profile.id, observerId: crypto.randomUUID(), accountChoices: {7: 1}});
    });
    await reader.recordSharedGadgetOpen(fixture.workspaceId, "Workspace", owner, "build",
      await notificationBaselines(fixture));
    await settled(readerFixture);
    expect(await reader.getUnreadState()).toMatchObject({unreadMessageCount: 1,
      chats: [{latestSequence: 1, readThroughSequence: 0, unreadMessageCount: 1}]});
    expect(await cursor(readerFixture)).toMatchObject({readThroughSequence: 0, notifiedThroughSequence: 1});
    expect(delivered.mock.calls.map(([event]) => event.id)).toEqual([oldId, newId]);
    await vi.waitFor(() => expect(counts.at(-1)).toBe(1));
    const baselines = await notificationBaselines(fixture);
    await runInDurableObject(reader, async instance => {
      using write = vi.spyOn(Reflect.get(instance, "storage").chatReadCursors, "put");
      await instance.recordSharedGadgetOpen(fixture.workspaceId, "Workspace", owner, "build", baselines);
      await instance.getUnreadState();
      expect(write).not.toHaveBeenCalled();
    });
  });
});

describe("ordered notification catch-up", () => {
  const candidates = (fixture: Fixture, ids = [1, 2, 3].map(() => crypto.randomUUID())) => withImpl(fixture.workspace, async impl => {
    for (const sequence of [1, 2, 3]) impl.storage.chatNotifications.put({id: ids[sequence - 1], chatId: 1, sequence,
      userId: fixture.user.id.toString(), kind: "taskCompleted"});
    await impl.deliverDirtyChats();
  });

  it.each([false, true])("does not replay historical alerts after dismissal/readmission (reset: %s)", async reset => {
    const fixture = await setup();
    const {reader, owner} = await addReader(fixture);
    const readerFixture = {...fixture, user: reader};
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    using delivered = vi.spyOn(UserDurableObject.prototype, "publishNotification").mockResolvedValue(undefined);
    await append(fixture, 0);
    await withImpl(fixture.workspace, async impl => {
      impl.storage.chatNotifications.put({id: ids[0], chatId: 1, sequence: 0,
        userId: reader.id.toString(), kind: "taskCompleted"});
      await impl.deliverDirtyChats();
    });
    await settled(readerFixture);
    await reader.forgetSharedGadget(fixture.workspaceId);
    await reader.recordSharedGadgetOpen(fixture.workspaceId, "Workspace", owner, "build",
      await notificationBaselines(fixture));
    // No unread API call is necessary to establish the durable notification baseline.
    expect(await cursor(readerFixture)).toMatchObject({notifiedThroughSequence: 0});
    if (reset) await evictDurableObject(reader);
    await withImpl(fixture.workspace, async impl => {
      impl.storage.chatNotifications.put({id: ids[1], chatId: 1, sequence: 1,
        userId: reader.id.toString(), kind: "taskCompleted"});
      await impl.deliverDirtyChats();
    });
    await settled(readerFixture);
    expect(delivered.mock.calls.map(([event]) => event.id)).toEqual(ids);
  });

  it.each([false, true])("serializes admission and snapshot initialization (snapshot first: %s)", async snapshotFirst => {
    const fixture = await setup();
    const {reader, owner} = await addReader(fixture);
    const readerFixture = {...fixture, user: reader};
    await append(fixture, 0);
    await reader.forgetSharedGadget(fixture.workspaceId);
    const id = crypto.randomUUID();
    await withImpl(fixture.workspace, async impl => {
      impl.storage.chatNotifications.put({id, chatId: 1, sequence: 0,
        userId: reader.id.toString(), kind: "taskCompleted"});
      await impl.deliverDirtyChats();
    });
    const {OverseerDurableObject} = await import("../src/overseer.js");
    const original = OverseerDurableObject.prototype.getChatStateForUser;
    const captured = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    using count = vi.spyOn(OverseerDurableObject.prototype, "getChatStateForUser")
      .mockImplementationOnce(async function(...args) {
        const state = await original.apply(this, args);
        captured.resolve();
        await release.promise;
        return state;
      });
    if (snapshotFirst) await runInDurableObject(reader, instance => {
      // A listing can survive an interrupted initial setup, while its first count is still absent.
      const storage = Reflect.get(instance, "storage") as ReturnType<typeof makeUserStorage>;
      storage.gadgets.put({id: fixture.workspaceId, title: "Workspace",
        created: new Date(), owner, role: "build"});
    });
    await withImpl(fixture.workspace, async impl => {
      const user = impl.users.get(impl.users.idFromString(reader.id.toString()));
      const admit = () => user.recordSharedGadgetOpen(fixture.workspaceId, "Workspace", owner, "build",
        [{chatId: 1, notifiedThroughSequence: 0}]);
      const first = snapshotFirst ? user.getUnreadState() : admit();
      await captured.promise;
      const second = snapshotFirst ? admit() : user.getUnreadState();
      release.resolve();
      await Promise.all([first, second]);
    });
    expect(await cursor(readerFixture)).toMatchObject({notifiedThroughSequence: 0});
    expect(count).toHaveBeenCalledOnce();
  });

  it("delivers all three coalesced events in order before advancing notifiedThroughSequence", async () => {
    const fixture = await setup();
    await append(fixture, 0);
    const ids = [1, 2, 3].map(() => crypto.randomUUID());
    {
      using delivered = vi.spyOn(UserDurableObject.prototype, "publishNotification").mockResolvedValue(undefined);
      await candidates(fixture, ids);
      await vi.waitFor(async () => expect(await cursor(fixture)).toMatchObject({notifiedThroughSequence: 3}));
      expect(delivered.mock.calls.map(([event]) => event.id)).toEqual(ids);
    }
    await evictDurableObject(fixture.user);
    await fixture.user.messageArrived(fixture.workspaceId, 1);
    await settled(fixture);
    expect(await cursor(fixture)).toMatchObject({notifiedThroughSequence: 3});
  });

  it("replays a lost ACK with the same event ID and resumes from the persisted horizon", async () => {
    const fixture = await setup();
    await append(fixture, 0);
    const received: string[] = [];
    const ids = [1, 2, 3].map(() => crypto.randomUUID());
    {
      using _delivered = vi.spyOn(UserDurableObject.prototype, "publishNotification").mockImplementation(async event => {
        received.push(event.id);
        if (event.id === ids[1]) throw new Error("lost ACK after effect");
      });
      await candidates(fixture, ids);
      await vi.waitFor(async () => expect(await cursor(fixture)).toMatchObject({
        notifiedThroughSequence: 1, notificationsDirty: true,
      }));
    }
    {
      using _delivered = vi.spyOn(UserDurableObject.prototype, "publishNotification").mockImplementation(async event => {
        received.push(event.id);
      });
      await evictDurableObject(fixture.user);
      await runDurableObjectAlarm(fixture.user);
      await settled(fixture);
    }
    expect(received).toEqual([ids[0], ids[1], ids[1], ids[2]]);
    expect(await cursor(fixture)).toMatchObject({notifiedThroughSequence: 3});
  });

  it("consumes policy-muted notifications rather than retrying them forever", async () => {
    const fixture = await setup();
    await fixture.user.setWorkspaceNotificationMute(fixture.workspaceId, {indefinite: true});
    await candidates(fixture);
    await settled(fixture);
    expect(await cursor(fixture)).toMatchObject({notifiedThroughSequence: 3, unreadCount: 0});
  });

  it("does not postpone a failed thread's retry for other activity, and retries again after another failure", async () => {
    const fixture = await setup();
    const other = await setup(fixture.user);
    await append(fixture, 0);
    await append(other, 0);
    await settled(fixture);
    await settled(other);
    let now = Date.now();
    using _clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    using delivery = vi.spyOn(UserDurableObject.prototype, "publishNotification")
      .mockRejectedValue(new Error("notification service temporarily unavailable"));
    await candidates(fixture);
    await vi.waitFor(() => expect(delivery).toHaveBeenCalled());
    const deadline = () => runInDurableObject(fixture.user, (_instance, ctx) => ctx.storage.getAlarm());
    const firstDeadline = await deadline();
    now += 29_000;
    await append(other, 1);
    await settled(other);
    expect(await deadline()).toBeLessThanOrEqual(firstDeadline!);
    expect(await cursor(fixture)).toMatchObject({notificationsDirty: true, notifiedThroughSequence: -1});
    now = firstDeadline!;
    await expect(runDurableObjectAlarm(fixture.user)).rejects.toThrow("temporarily unavailable");
    expect(await deadline()).toBe(now + 30_000);
    delivery.mockResolvedValue(undefined);
    now += 30_000;
    await runDurableObjectAlarm(fixture.user);
    await settled(fixture);
    expect(await cursor(fixture)).toMatchObject({notifiedThroughSequence: 3});
    expect(await deadline()).toBeNull();
  });
});
