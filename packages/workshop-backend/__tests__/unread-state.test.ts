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
const setup = async () => {
  const user = env.TEST_USER.getByName(crypto.randomUUID());
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
const receipt = (fixture: Fixture, throughSequence: number, readThroughSequence = -1): ChatReadReceipt =>
  ({workspaceId: fixture.workspaceId, chatId: 1, throughSequence, readThroughSequence});
const settled = async (fixture: Fixture) => vi.waitFor(async () => {
  const row = await cursor(fixture);
  expect(row).toBeDefined();
  expect(row?.unreadDirty || row?.notificationsDirty).toBeFalsy();
});

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
    await fixture.user.markChatRead(receipt(fixture, 0));
    expect(await cursor(fixture)).toMatchObject({readThroughSequence: 0, unreadCount: 1});
    await fixture.user.markChatRead(receipt(fixture, 12, 0));
    expect(await cursor(fixture)).toMatchObject({readThroughSequence: 12, unreadCount: 0});
    await fixture.user.markChatUnread(fixture.workspaceId, 1, 0, 12);
    expect(await cursor(fixture)).toMatchObject({readThroughSequence: -1, unreadCount: 2});
    await fixture.user.markChatRead(receipt(fixture, 12, 12));
    expect(await cursor(fixture)).toMatchObject({readThroughSequence: -1, unreadCount: 2});
  });

  it("does not write read state for reads, repeated receipts, or unchanged UI hydration", async () => {
    const fixture = await setup();
    await append(fixture, 0);
    await fixture.user.markChatRead(receipt(fixture, 0));
    await settled(fixture);
    await runInDurableObject(fixture.user, async (instance, ctx) => {
      using write = vi.spyOn(Reflect.get(instance, "storage").chatReadCursors, "put");
      await instance.getUnreadState();
      await instance.getUnreadState();
      await instance.markChatRead(receipt(fixture, 0, 0));
      expect(write).not.toHaveBeenCalled();
    });
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
      const read = user.markChatRead(receipt(fixture, 0));
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
    const owner = {type: "user" as const, id: `owner-${crypto.randomUUID()}`, name: "Owner"};
    const profile = {type: "user" as const, id: `reader-${crypto.randomUUID()}`, name: "Reader"};
    const reader = env.TEST_USER.getByName(profile.id);
    await runInDurableObject(fixture.user, (_instance, ctx) => makeUserStorage(ctx.storage).profile.put(owner));
    await runInDurableObject(reader, (_instance, ctx) => makeUserStorage(ctx.storage).profile.put(profile));
    await reader.recordSharedGadgetOpen(fixture.workspaceId, "Workspace", owner, "build");
    await withImpl(fixture.workspace, async impl => {
      impl.storage.collaborators.put({profile,
        addedBy: [{type: "user", sharer: owner.id, role: "build", created: new Date()}]});
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
});

describe("ordered notification catch-up", () => {
  const candidates = (fixture: Fixture, ids = [1, 2, 3].map(() => crypto.randomUUID())) => withImpl(fixture.workspace, async impl => {
    for (const sequence of [1, 2, 3]) impl.storage.chatNotifications.put({id: ids[sequence - 1], chatId: 1, sequence,
      userId: fixture.user.id.toString(), kind: "taskCompleted"});
    await impl.deliverDirtyChats();
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
});
