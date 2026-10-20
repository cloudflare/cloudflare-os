import { env } from "cloudflare:workers";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { RpcStub, RpcTarget } from "capnweb";
import { describe, expect, it, vi } from "vitest";
import type { ChatReadReceipt, UnreadStateSubscriber, UserUnreadState } from "@gadgets/workshop-shared/api";
import { UserDurableObject } from "../src/user.js";
import type { OverseerDurableObject } from "../src/overseer.js";
import { makeUserStorage } from "../src/storage-schema/user-storage.js";
import { OVERSEER_STORAGE_VERSION } from "../src/storage-schema/overseer-migrations.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
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
const receipt = async (fixture: Fixture, throughSequence: number, readThroughSequence = -1): Promise<ChatReadReceipt> => {
  const chat = (await fixture.user.getUnreadState()).chats.find(item => item.chatId === 1)!;
  return {...chat, throughSequence, readThroughSequence};
};
const settled = async (fixture: Fixture) => vi.waitFor(async () => {
  const row = await cursor(fixture);
  expect(row).toBeDefined();
  expect(row?.unreadDirty || row?.notificationsDirty).toBeFalsy();
});
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
  await reader.recordSharedGadgetOpen(fixture.workspaceId, "Workspace", owner, "build");
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
  it("counts messages rather than sequence gaps; commits horizon/count together; rejects stale receipts", async () => {
    const fixture = await setup();
    await append(fixture, 0, "First line\nSecond line");
    await append(fixture, 6, "");
    await append(fixture, 12, "Latest");
    expect(await fixture.user.getUnreadState()).toMatchObject({unreadMessageCount: 2,
      chats: [{latestSequence: 12, latestMessagePreview: "Latest", unreadMessageCount: 2}]});
    await fixture.user.markChatRead(await receipt(fixture, 0));
    expect(await cursor(fixture)).toMatchObject({readThroughSequence: 0, unreadCount: 1});
    await fixture.user.markChatRead(await receipt(fixture, 12, 0));
    expect(await cursor(fixture)).toMatchObject({readThroughSequence: 12, unreadCount: 0});
    await fixture.user.markChatUnread(fixture.workspaceId, 1, 0, 12, (await receipt(fixture, 0)).readToken);
    expect(await cursor(fixture)).toMatchObject({readThroughSequence: -1, unreadCount: 2});
    await fixture.user.markChatRead(await receipt(fixture, 12, 12));
    expect(await cursor(fixture)).toMatchObject({readThroughSequence: -1, unreadCount: 2});
  });

  it("does not write read state for reads, repeated receipts, or unchanged UI hydration", async () => {
    const fixture = await setup();
    await append(fixture, 0);
    const observed = await receipt(fixture, 0);
    await fixture.user.markChatRead(observed);
    await settled(fixture);
    await runInDurableObject(fixture.user, async (instance, ctx) => {
      using write = vi.spyOn(Reflect.get(instance, "storage").chatReadCursors, "put");
      await instance.getUnreadState();
      await instance.getUnreadState();
      await instance.markChatRead(observed);
      expect(write).not.toHaveBeenCalled();
    });
  });

  it.each([false, true])("rejects a delayed receipt after the horizon returns to its old value (reset: %s)", async reset => {
    const fixture = await setup();
    await append(fixture, 0);
    const delayed = await receipt(fixture, 0);
    await fixture.user.markChatRead(delayed);
    const rewindToken = (await receipt(fixture, 0)).readToken;
    await fixture.user.markChatUnread(fixture.workspaceId, 1, 0, 0, rewindToken);
    await settled(fixture);
    if (reset) await evictDurableObject(fixture.user);
    // Hydrating creates a new token after reset; neither that nor ABA revives the old receipt.
    const fresh = await receipt(fixture, 0);
    expect(fresh.readToken).not.toBe(delayed.readToken);
    await fixture.user.markChatRead(delayed);
    expect(await cursor(fixture)).toMatchObject({readThroughSequence: -1, unreadCount: 1});
    await fixture.user.markChatRead(fresh);
    // A delayed retry of the old explicit rewind must not undo the newer read either.
    await fixture.user.markChatUnread(fixture.workspaceId, 1, 0, 0, rewindToken);
    expect(await cursor(fixture)).toMatchObject({readThroughSequence: 0, unreadCount: 0});
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
    const observed = await receipt(fixture, 0);
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

  it("does not clear a newer mutation that arrived during fanout", async () => {
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
      } finally { restore(); }
      await impl.deliverDirtyChats();
      expect(impl.storage.dirtyChats.get(1)).toBeUndefined();
    });
    expect(await cursor(fixture)).toMatchObject({unreadCount: 1});
  });

  it("repairs a User DO reset after dirty intent was persisted but before counting", async () => {
    const fixture = await setup();
    await append(fixture, 0);
    await settled(fixture);
    await runInDurableObject(fixture.user, (_instance, ctx) => {
      const storage = makeUserStorage(ctx.storage);
      const row = storage.chatReadCursors.get(`${fixture.workspaceId}:1`)!;
      storage.chatReadCursors.put({...row, unreadCount: 0, unreadDirty: true, notificationsDirty: true});
      ctx.storage.setAlarm(Date.now() + 30_000);
    });
    await evictDurableObject(fixture.user);
    await runDurableObjectAlarm(fixture.user);
    await settled(fixture);
    expect(await cursor(fixture)).toMatchObject({unreadCount: 1});
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
    await fixture.user.markChatRead(await receipt(fixture, 0));
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
    await reader.markChatRead(await receipt(readerFixture, 0));
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
    await reader.recordSharedGadgetOpen(fixture.workspaceId, "Workspace", owner, "build");
    await settled(readerFixture);
    expect(await reader.getUnreadState()).toMatchObject({unreadMessageCount: 1,
      chats: [{latestSequence: 1, readThroughSequence: 0, unreadMessageCount: 1}]});
    expect(await cursor(readerFixture)).toMatchObject({readThroughSequence: 0, notifiedThroughSequence: 1});
    expect(delivered.mock.calls.map(([event]) => event.id)).toEqual([oldId, newId]);
    await vi.waitFor(() => expect(counts.at(-1)).toBe(1));
    await runInDurableObject(reader, async instance => {
      using write = vi.spyOn(Reflect.get(instance, "storage").chatReadCursors, "put");
      await instance.recordSharedGadgetOpen(fixture.workspaceId, "Workspace", owner, "build");
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
    await withImpl(fixture.workspace, async impl => {
      impl.storage.chatNotifications.put({id: ids[0], chatId: 1, sequence: 0,
        userId: reader.id.toString(), kind: "taskCompleted"});
      await impl.deliverDirtyChats();
    });
    await settled(readerFixture);
    await reader.forgetSharedGadget(fixture.workspaceId);
    await reader.recordSharedGadgetOpen(fixture.workspaceId, "Workspace", owner, "build");
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
