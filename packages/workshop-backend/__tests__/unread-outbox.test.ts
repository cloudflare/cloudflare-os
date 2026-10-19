import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { OverseerDurableObject } from "../src/overseer.js";
import { UserDurableObject } from "../src/user.js";
import { OVERSEER_STORAGE_VERSION } from "../src/storage-schema/overseer-migrations.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

type Impl = OverseerDurableObject["impl"];
const withImpl = async <T>(
  stub: DurableObjectStub<OverseerDurableObject>,
  fn: (impl: Impl) => Promise<T>,
) => runInDurableObject(stub, (instance) => fn(Reflect.get(instance, "impl") as Impl));

// Fault at the caller's dispatch/ACK boundary, not by throwing inside the pool's DO wrapper.
const interceptUser = <K extends "syncWorkspaceChats" | "deleteGadget" | "getChatContext">(
  impl: Impl,
  method: K,
  intercept: (
    user: DurableObjectStub<UserDurableObject>,
    ...args: Parameters<UserDurableObject[K]>
  ) => ReturnType<UserDurableObject[K]>,
) => {
  const original = impl.users;
  let calls = 0;
  impl.users = new Proxy(original, {
    get(target, key) {
      if (key === "idFromString") return (id: string) => target.idFromString(id);
      if (key === "get")
        return (id: DurableObjectId) =>
          new Proxy(target.get(id), {
            get(user, key) {
              if (key === method) {
                return (...args: Parameters<UserDurableObject[K]>) => {
                  calls++;
                  return intercept(user, ...args);
                };
              }
              return Reflect.get(user, key);
            },
          });
      return Reflect.get(target, key);
    },
  });
  return {
    calls: () => calls,
    restore: () => {
      impl.users = original;
    },
  };
};

const interceptDispatch = (impl: Impl,
  intercept: (user: DurableObjectStub<UserDurableObject>, args: Parameters<UserDurableObject["syncWorkspaceChats"]>) => Promise<void>,
) => interceptUser(impl, "syncWorkspaceChats", (user, ...args) => intercept(user, args));

const interceptRemoval = (
  impl: Impl,
  intercept: (user: DurableObjectStub<UserDurableObject>, workspaceId: string) => Promise<void>,
) => interceptUser(impl, "deleteGadget", intercept).restore;

const expectAcknowledged = (impl: Impl) => {
  for (const reader of impl.storage.unreadReaders.list()) {
    expect(reader.timelineVersion).toBe(impl.storage.chatTimelineVersion.get());
  }
};

const makeRetriesDue = (impl: Impl) => {
  impl.storage.chatTimelineRetryAt.put(0);
  for (const reader of impl.storage.unreadReaders.list()) {
    if (reader.retryAt !== undefined) impl.storage.unreadReaders.put({...reader, retryAt: 0});
  }
};

const setup = async () => {
  const stub = env.TEST_OVERSEER.getByName(`unread-outbox-${crypto.randomUUID()}`);
  const recipientId = await withImpl(stub, async (impl) => {
    const id = impl.users.idFromName(`unread-recipient-${crypto.randomUUID()}`);
    impl.storage.version.put(OVERSEER_STORAGE_VERSION);
    await impl.users.get(id).newGadget(impl.ctx.id.toString(), "Demo workspace");
    impl.storage.chatMeta.put({
      id: 1,
      title: "Demo",
      started: new Date(),
      lastActive: new Date(),
    });
    impl.storage.chats.put({
      chatId: 1,
      sequence: 1,
      timestamp: new Date(),
      author: { type: "agent", id: "test", name: "Test" },
      type: "message",
      message: "Hello",
    });
    impl.storage.ownerId.put(id.toString());
    impl.ownerId = id.toString();
    impl.storage.chatTimelineVersion.put(1);
    impl.storage.unreadReaders.put({userId: id.toString(), profileId: "owner@example.com"});
    // Model the persisted alarm that queueing schedules, without letting it fire during the test.
    await impl.ctx.storage.setAlarm(Date.now() + 60_000);
    return id.toString();
  });
  return { stub, recipientId };
};

describe("durable unread delivery checkpoints", () => {
  it("journals message deletions without invalidating the caller's open timeline iterator", async () => {
    const {stub, recipientId} = await setup();
    await withImpl(stub, async impl => {
      await impl.deliverChatTimelines(true);
      impl.storage.chats.put({chatId: 1, sequence: 2, timestamp: new Date(1),
        author: {type: "agent", id: "test", name: "Test"}, type: "message", message: "Second"});
      for (const message of impl.storage.chats.list()) impl.storage.chats.deleteRecord(message);
      await impl.deliverChatTimelines(true);
      expect((await impl.users.get(impl.users.idFromString(recipientId)).getUnreadState())
        .unreadMessageCount).toBe(0);
    });
  });

  it("fans out each append with only the changed thread's latest message and cumulative count", async () => {
    const {stub, recipientId} = await setup();
    await withImpl(stub, async impl => {
      const ids = [recipientId, ...Array.from({length: 2}, () => impl.users.idFromName(crypto.randomUUID()).toString())];
      for (const id of ids.slice(1)) {
        await impl.users.get(impl.users.idFromString(id)).newGadget(impl.ctx.id.toString(), "Workspace");
        impl.storage.unreadReaders.put({userId: id, profileId: id});
      }
      using _verify = vi.spyOn(impl, "authorizeCollaborator").mockResolvedValue("build");
      impl.storage.chatMeta.put({id: 2, title: "Unchanged", started: new Date(), lastActive: new Date()});
      impl.storage.chats.put({chatId: 2, sequence: 0, timestamp: new Date(1),
        author: {type: "agent", id: "test", name: "Test"}, type: "message", message: "Other thread"});
      await impl.deliverChatTimelines(true);
      let sends = 0;
      const dispatch = interceptDispatch(impl, async (user, args) => {
        sends++;
        expect(args[2]).toHaveLength(1);
        expect(args[2][0]).toMatchObject({chatId: 1, latestMessagePreview: "x".repeat(240),
          latestAuthor: {type: "agent", id: "test", name: "Test"}});
        expect(args[3]).toEqual([]);
        expect(JSON.stringify(args[2])).not.toContain("Other thread");
        await user.syncWorkspaceChats(...args);
      });
      try {
        for (let sequence = 2; sequence <= 4; sequence++) {
          impl.storage.chats.put({chatId: 1, sequence, timestamp: new Date(100 + sequence),
            author: {type: "agent", id: "test", name: "Test"}, type: "message", message: "x".repeat(500)});
          await impl.deliverChatTimelines(true);
          expect(sends).toBe((sequence - 1) * ids.length);
          for (const id of ids) {
            const state = await impl.users.get(impl.users.idFromString(id)).getUnreadState();
            expect(state.chats.find(chat => chat.chatId === 1)?.unreadMessageCount).toBe(sequence);
          }
        }
      } finally { dispatch.restore(); }
    });
  });

  it("projects only a bounded first line of visible text, skipping reasoning and command expansions", async () => {
    const { stub, recipientId } = await setup();
    await withImpl(stub, async (impl) => {
      const author = { type: "agent" as const, id: "test", name: "Test" };
      const timestamp = new Date("2026-10-15T00:00:00Z");
      impl.storage.chats.put({ chatId: 1, sequence: 2, author, timestamp,
        type: "message", message: `  ${"x".repeat(300)}\nDo not include this line` });
      impl.storage.chats.put({ chatId: 1, sequence: 3, author, timestamp: new Date(+timestamp + 1),
        type: "message", message: "Internal command text", generatedBySlashCommandSequence: 1 });
      impl.storage.chats.put({ chatId: 1, sequence: 4, author, timestamp: new Date(+timestamp + 2),
        type: "message", message: "", reasoning: "Never preview reasoning" });
      await impl.deliverChatTimelines(true);
      const user = impl.users.get(impl.users.idFromString(recipientId));
      expect((await user.getUnreadState()).chats[0]).toMatchObject({
        latestMessagePreview: "x".repeat(240), latestActivityAt: timestamp, latestSequence: 2,
        unreadMessageCount: 2,
      });
      impl.storage.chats.put({ chatId: 1, sequence: 5, author, timestamp: new Date(+timestamp + 3),
        type: "message", message: "\n  Newest first line\r\nSecond line" });
      await impl.deliverChatTimelines(true);
      expect((await user.getUnreadState()).chats[0].latestMessagePreview).toBe("Newest first line");
    });
  });

  it("indexes real timeline appends, renames and deletions through the durable storage chokepoint", async () => {
    const { stub, recipientId } = await setup();
    await withImpl(stub, async (impl) => {
      impl.storage.chatTimelineRetryAt.put(Date.now() + 60_000);
      impl.storage.chatMeta.put({
        id: 1,
        title: "Actual thread",
        started: new Date(),
        lastActive: new Date(),
      });
      impl.storage.chats.put({
        chatId: 1,
        sequence: 2,
        timestamp: new Date(),
        author: { type: "agent", id: "test", name: "Test" },
        type: "message",
        message: "Hello",
      });
      impl.storage.chatTimelineRetryAt.put(0);
      await impl.deliverChatTimelines();
      const user = impl.users.get(impl.users.idFromString(recipientId));
      expect((await user.getUnreadState()).chats).toMatchObject([
        { chatTitle: "Actual thread", latestSequence: 2, readThroughSequence: -1 },
      ]);
      impl.storage.chatMeta.put({ ...impl.storage.chatMeta.get(1)!, title: "Renamed" });
      await impl.deliverChatTimelines(true);
      expect((await user.getUnreadState()).chats[0].chatTitle).toBe("Renamed");
      impl.storage.chatMeta.delete(1);
      await impl.deliverChatTimelines(true);
      expect((await user.getUnreadState()).chats).toEqual([]);
    });
  });

  it("rechecks a disconnected collaborator's build authority before disclosing timeline metadata", async () => {
    const { stub } = await setup();
    await withImpl(stub, async (impl) => {
      const id = impl.users.idFromName(`revoked-reader-${crypto.randomUUID()}`).toString();
      const user = impl.users.get(impl.users.idFromString(id));
      using verify = vi.spyOn(impl, "authorizeCollaborator").mockResolvedValue("build");
      await runInDurableObject(user, instance => {
        instance.storage.profile.put({type: "user", id: "reader@example.com", name: "Reader"});
      });
      await user.newGadget(impl.ctx.id.toString(), "Workspace");
      await user.syncWorkspaceChats(impl.ctx.id.toString(), 0, [
        { chatId: 1, chatTitle: "Old", latestSequence: 0 },
      ]);
      await impl.deliverChatTimelines(true);
      verify.mockClear().mockResolvedValue(null);
      // A sharing write alone journals cleanup; no later message or browser click is required.
      impl.storage.shareKeys.put({ id: "changed-key", alias: "revoked-link" });
      await impl.deliverChatTimelines(true);
      expect(verify).toHaveBeenCalledWith("reader@example.com", expect.anything(), {
        requireRole: "build",
      });
      expect((await user.getUnreadState()).chats).toEqual([]);
      expect(impl.storage.unreadReaders.get(id)).toBeUndefined();
    });
  });

  it("skips observer registration for an empty snapshot, but verifies before sending chat metadata", async () => {
    const { stub } = await setup();
    await withImpl(stub, async (impl) => {
      const id = impl.users.idFromName(`empty-reader-${crypto.randomUUID()}`).toString();
      const user = impl.users.get(impl.users.idFromString(id));
      await user.newGadget(impl.ctx.id.toString(), "Workspace");
      impl.storage.unreadReaders.put({userId: id, profileId: "reader@example.com"});
      using verify = vi.spyOn(impl, "authorizeCollaborator").mockResolvedValue(null);
      const meta = impl.storage.chatMeta.get(1)!;
      impl.storage.chatMeta.delete(1);
      await impl.deliverChatTimelines(true);
      expect(verify).not.toHaveBeenCalled();
      expect((await user.getUnreadState()).chats).toEqual([]);
      impl.storage.chatMeta.put(meta);
      await impl.deliverChatTimelines(true);
      expect(verify).toHaveBeenCalledOnce();
      expect((await user.getUnreadState()).chats).toEqual([]);
    });
  });

  it.each(["authorization", "dispatch"])("backs off a recipient's %s failure across eviction without delaying healthy readers", async (failure) => {
    const { stub, recipientId } = await setup();
    const deferred = await withImpl(stub, async (impl) => {
      const ids = [recipientId, ...Array.from({length: 2}, () =>
        impl.users.idFromName(crypto.randomUUID()).toString())].toSorted();
      // Put the failing reader before both a healthy reader and the owner in delivery order.
      impl.ownerId = ids[2];
      impl.storage.ownerId.put(ids[2]);
      for (const id of ids) {
        await impl.users.get(impl.users.idFromString(id)).newGadget(impl.ctx.id.toString(), "Workspace");
        impl.storage.unreadReaders.put({userId: id, profileId: id});
      }
      let failedAttempts = 0;
      using verify = vi.spyOn(impl, "authorizeCollaborator").mockImplementation(async (profileId) => {
        if (failure === "authorization" && profileId === ids[0]) {
          failedAttempts++;
          throw new Error("needs repair");
        }
        return "build";
      });
      const dispatch = interceptDispatch(impl, async (user, args) => {
        if (failure === "dispatch" && user.id.toString() === ids[0]) {
          failedAttempts++;
          throw new Error("needs repair");
        }
        await user.syncWorkspaceChats(...args);
      });
      try {
        await expect(impl.deliverChatTimelines(true)).rejects.toThrow("needs repair");
        for (const id of ids.slice(1)) {
          expect((await impl.users.get(impl.users.idFromString(id)).getUnreadState()).unreadChatCount).toBe(1);
        }
        expect(impl.storage.unreadReaders.get(ids[0])?.timelineVersion).toBeUndefined();
        for (const id of ids.slice(1)) {
          expect(impl.storage.unreadReaders.get(id)?.timelineVersion).toBe(impl.storage.chatTimelineVersion.get());
        }
        expect(impl.storage.chatTimelineRetryAt.get()).toBeGreaterThan(Date.now());
        const attempts = verify.mock.calls.length;
        await impl.deliverChatTimelines();
        expect(verify).toHaveBeenCalledTimes(attempts);
        expect(impl.storage.unreadReaders.get(ids[0])?.retryDelay).toBe(30_000);
        impl.storage.chats.put({chatId: 1, sequence: 2, timestamp: new Date(),
          author: {type: "agent", id: "test", name: "Test"}, type: "message", message: "Next"});
        await impl.deliverChatTimelines(true);
        expect(failedAttempts).toBe(1);
        for (const id of ids.slice(1)) {
          expect((await impl.users.get(impl.users.idFromString(id)).getUnreadState()).unreadMessageCount).toBe(2);
        }
        using clock = vi.spyOn(Date, "now");
        for (const delay of [60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000, 1_800_000]) {
          clock.mockReturnValue(impl.storage.unreadReaders.get(ids[0])!.retryAt!);
          await expect(impl.deliverChatTimelines(true)).rejects.toThrow("needs repair");
          const reader = impl.storage.unreadReaders.get(ids[0])!;
          expect(reader.retryDelay).toBe(delay);
          expect(reader.retryAt).toBe(Date.now() + delay);
          expect(await impl.ctx.storage.getAlarm()).toBe(reader.retryAt);
        }
        return impl.storage.unreadReaders.get(ids[0])!;
      } finally {
        dispatch.restore();
      }
    });
    await evictDurableObject(stub);
    await withImpl(stub, async impl => {
      await impl.deliverChatTimelines(true);
      expect(impl.storage.unreadReaders.get(deferred.userId)).toEqual(deferred);
      using _verify = vi.spyOn(impl, "authorizeCollaborator").mockResolvedValue("build");
      // Interactive reopening can retry immediately after the user repairs the connection.
      impl.trackUnreadReader(deferred.userId, deferred.profileId, {catchUp: true});
      await impl.deliverChatTimelines(true);
      expectAcknowledged(impl);
      expect(impl.storage.unreadReaders.get(deferred.userId)?.retryAt).toBeUndefined();
      expect(impl.storage.unreadReaders.get(deferred.userId)?.retryDelay).toBeUndefined();
    });
  });

  it("deleteSelf releases the input gate before an in-flight recipient calls back", async () => {
    const {stub, recipientId} = await setup();
    await runInDurableObject(stub, async instance => {
      const impl = instance.impl;
      using _capsules = vi.spyOn(impl, "ensureAmbientCapsules").mockResolvedValue(undefined);
      using _restart = vi.spyOn(impl, "scheduleAccessRestart").mockResolvedValue(undefined);
      using notify = new NativeRpcStub(() => {});
      const client = await instance.open(recipientId, "owner@example.com", notify);
      try {
        await impl.deliverChatTimelines(true);
        const user = impl.users.get(impl.users.idFromString(recipientId));
        const fetched = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
        // Model the cold recipient's callback as a real RPC event addressed to this DO. The
        // dispatch boundary is held until deleteSelf persists its deletion intent.
        const callback = impl.ctx.exports.OverseerDurableObject.get(impl.ctx.id);
        const dispatch = interceptDispatch(impl, async (recipient, args) => {
          fetched.resolve();
          await release.promise;
          await callback.getChatTimelineForUser(recipientId, "owner@example.com", []);
          await recipient.syncWorkspaceChats(...args);
        });
        impl.queueUnreadSnapshot(1);
        const delivery = impl.deliverChatTimelines(true);
        await fetched.promise;
        const deletion = client.deleteSelf();
        try {
          await vi.waitFor(() => expect(impl.storage.deletingWorkspace.get()).toBe(true));
          release.resolve();
          await deletion;
          await delivery;
          expect(await user.getGadget(impl.ctx.id.toString())).toBeNull();
          expect(_restart).toHaveBeenCalledOnce();
        } finally {
          release.resolve();
          await Promise.allSettled([delivery, deletion]);
          dispatch.restore();
        }
      } finally {
        client[Symbol.dispose]();
      }
    });
  });

  it.each([false, true])("deleteSelf closes sessions and recovers failed cleanup (owner unavailable: %s)", async ownerUnavailable => {
    const {stub, recipientId} = await setup();
    await runInDurableObject(stub, async instance => {
      const impl = instance.impl;
      using _capsules = vi.spyOn(impl, "ensureAmbientCapsules").mockResolvedValue(undefined);
      using _restart = vi.spyOn(impl, "scheduleAccessRestart").mockResolvedValue(undefined);
      const notified = vi.fn<() => void>();
      using notify = new NativeRpcStub(notified);
      const client = await instance.open(recipientId, "owner@example.com", notify);
      await impl.deliverChatTimelines(true);
      const deletedOwners: (string | undefined)[] = [];
      using _analytics = vi.spyOn(impl, "recordGadgetAnalytics").mockImplementation(event => {
        if (event.event_name === "gadget_deleted") deletedOwners.push(impl.ownerId);
      });
      const readerId = impl.users.idFromName(crypto.randomUUID()).toString();
      impl.storage.unreadReaders.put({userId: readerId, profileId: "reader@example.com"});
      const restore = interceptRemoval(impl, async (user, id) => {
        if (ownerUnavailable && user.id.toString() === recipientId) throw new Error("Owner unavailable");
        if (user.id.toString() === readerId) throw new Error("Collaborator unavailable");
        await user.deleteGadget(id);
      });
      try {
        const deletion = client.deleteSelf();
        const cleanup = expect(impl.deliverChatTimelines(true)).rejects.toThrow(/unavailable/);
        if (ownerUnavailable) await expect(deletion).rejects.toThrow("Owner unavailable");
        else await expect(deletion).resolves.toBeUndefined();
        await cleanup;
        expect(deletedOwners).toEqual([recipientId]);
        expect(notified).toHaveBeenCalledOnce();
        expect(_restart).toHaveBeenCalledOnce();
        if (!ownerUnavailable) {
          expect(await impl.users.get(impl.users.idFromString(recipientId)).getGadget(impl.ctx.id.toString())).toBeNull();
        }
        expect(impl.storage.deletingWorkspace.get()).toBe(true);
        expect(impl.storage.unreadReaders.get(readerId)).toBeDefined();
        expect(impl.storage.unreadReaders.get(readerId)!.retryAt).toBeGreaterThan(Date.now());
        expect(await impl.ctx.storage.getAlarm()).toBeGreaterThanOrEqual(
          impl.storage.unreadReaders.get(readerId)!.retryAt!);
      } finally {
        restore();
        client[Symbol.dispose]();
      }
    });
    await evictDurableObject(stub);
    await withImpl(stub, async impl => { makeRetriesDue(impl); });
    await runDurableObjectAlarm(stub);
    await withImpl(stub, async impl => { expect(impl.ownerId).toBeUndefined(); });
  });

  it.each(["before dispatch", "lost ACK", "reader cleanup", "storage deletion"])(
    "resumes workspace deletion after eviction at %s without resurrecting collaborator badges",
    async (boundary) => {
      const { stub, recipientId } = await setup();
      const readerId = await withImpl(stub, async (impl) => {
        const id = impl.users.idFromName(crypto.randomUUID()).toString();
        const reader = impl.users.get(impl.users.idFromString(id));
        await reader.newGadget(impl.ctx.id.toString(), "Workspace");
        await reader.syncWorkspaceChats(impl.ctx.id.toString(), 0, impl.chatTimelineHeads());
        impl.storage.unreadReaders.put({userId: id, profileId: "reader@example.com"});
        expect((await reader.getUnreadState()).unreadChatCount).toBe(1);
        const restore = interceptRemoval(impl, async (user, workspaceId) => {
          if (user.id.toString() === id && boundary === "before dispatch") throw new Error(boundary);
          await user.deleteGadget(workspaceId);
          if (user.id.toString() === id && boundary === "lost ACK") throw new Error(boundary);
        });
        const remove = impl.storage.unreadReaders.delete.bind(impl.storage.unreadReaders);
        using _cleanup = vi.spyOn(impl.storage.unreadReaders, "delete").mockImplementation((userId) => {
          if (userId === id && boundary === "reader cleanup") throw new Error(boundary);
          return remove(userId);
        });
        using _deleteAll = vi.spyOn(impl.ctx.storage, "deleteAll");
        if (boundary === "storage deletion") _deleteAll.mockRejectedValueOnce(new Error(boundary));
        try {
          impl.deleteWorkspace();
          await expect(impl.deliverChatTimelines(true)).rejects.toThrow(boundary);
          expect(impl.storage.deletingWorkspace.get()).toBe(true);
          expect(impl.storage.chatMeta.get(1)).toBeDefined();
          expect((await reader.getUnreadState()).unreadChatCount).toBe(boundary === "before dispatch" ? 1 : 0);
          // The owner's cleanup proceeds even when a collaborator fails.
          expect((await impl.users.get(impl.users.idFromString(recipientId)).getUnreadState()).chats).toEqual([]);
          makeRetriesDue(impl);
        } finally {
          restore();
        }
        return id;
      });
      await evictDurableObject(stub);
      await runDurableObjectAlarm(stub);
      await withImpl(stub, async (impl) => {
        expect(impl.ownerId).toBeUndefined();
        expect(impl.storage.chatMeta.get(1)).toBeUndefined();
        expect([...impl.storage.unreadReaders.list()]).toEqual([]);
        const reader = impl.users.get(impl.users.idFromString(readerId));
        await reader.syncWorkspaceChats(impl.ctx.id.toString(), 999, [
          {chatId: 1, chatTitle: "Delayed", latestSequence: 2},
        ]);
        expect((await reader.getUnreadState()).chats).toEqual([]);
      });
    },
  );

  it("does not deliver queued agent calls from the recovery alarm while deletion is pending", async () => {
    const { stub, recipientId } = await setup();
    await withImpl(stub, async (impl) => {
      impl.storage.pendingAgentCalls.put({
        chatId: 1, callId: 0, methodName: "queued", args: [], argsSummary: "",
        initiatorUserId: recipientId, initiatorModelId: "model",
      });
      const restore = interceptRemoval(impl, async () => { throw new Error("cleanup unavailable"); });
      try {
        impl.deleteWorkspace();
        await expect(impl.deliverChatTimelines(true)).rejects.toThrow("cleanup unavailable");
      } finally {
        restore();
      }
    });
    await evictDurableObject(stub);

    using lookup = vi.spyOn(UserDurableObject.prototype, "getChatContext").mockResolvedValue({
      profile: { type: "user", id: "owner", name: "Owner" },
      aiModel: {
        profile: { type: "agent", id: "model", name: "Model" },
        config: { provider: "cloudflare", model: "@cf/test/model", apiToken: "" },
      },
    });
    let restore!: () => void;
    let start!: ReturnType<typeof vi.spyOn<Impl, "startAgent">>;
    await withImpl(stub, async (impl) => {
      restore = interceptRemoval(impl, async () => { throw new Error("cleanup unavailable"); });
      start = vi.spyOn(impl, "startAgent").mockImplementation(() => {});
      makeRetriesDue(impl);
    });
    try {
      await expect(runDurableObjectAlarm(stub)).rejects.toThrow("cleanup unavailable");
      await withImpl(stub, async (impl) => {
        expect(impl.storage.deletingWorkspace.get()).toBe(true);
        expect([...impl.storage.pendingAgentCalls.list()]).toHaveLength(1);
        expect([...impl.storage.chats.list()].map(message => message.type)).toEqual(["message"]);
        expect([...impl.storage.activeAgents.list()]).toEqual([]);
        expect(start).not.toHaveBeenCalled();
        expect(lookup).not.toHaveBeenCalled();
      });
    } finally {
      restore();
      start.mockRestore();
    }

    await withImpl(stub, async (impl) => {
      makeRetriesDue(impl);
      await impl.deliverChatTimelines(true);
      expect(impl.ownerId).toBeUndefined();
      expect([...impl.storage.pendingAgentCalls.list()]).toEqual([]);
    });
  });

  it.each([false, true])("does not resume a committed decision during deletion (active: %s)", async (active) => {
    const {stub, recipientId} = await setup();
    const model = {type: "agent" as const, id: "model", name: "Model"};
    await withImpl(stub, async impl => {
      impl.storage.chats.put({chatId: 1, sequence: 2, timestamp: impl.getChatTimestamp(), author: model,
        type: "connectionRequest", requestId: "connection", vendorId: "test", vendorName: "Test",
        reason: "Read", state: "accepted", gatekeeperId: 1});
      impl.storage.activeAgents.put({chatId: 1, modelId: model.id, initiatorUserId: recipientId,
        initiator: {type: "user", id: "owner", name: "Owner"}, callbackInitiated: false});
      if (active) impl.storage.chatMeta.put({...impl.storage.chatMeta.get(1)!, activeAgent: model});
      const restore = interceptRemoval(impl, async () => { throw new Error("cleanup unavailable"); });
      try {
        impl.deleteWorkspace();
        await expect(impl.deliverChatTimelines(true)).rejects.toThrow("cleanup unavailable");
      } finally {
        restore();
      }
    });
    await evictDurableObject(stub);
    await withImpl(stub, async impl => {
      const before = [...impl.storage.chats.list()];
      impl.resumeAgentAfterDecision(1);
      const restore = interceptRemoval(impl, async () => { throw new Error("cleanup unavailable"); });
      try {
        makeRetriesDue(impl);
        await expect(impl.runAlarmTasks()).rejects.toThrow("cleanup unavailable");
        expect([...impl.storage.chats.list()]).toEqual(before);
        expect(impl.storage.activeAgents.get(1)).toBeDefined();
        expect(impl.storage.chatMeta.get(1)?.activeAgent).toEqual(active ? model : undefined);
      } finally {
        restore();
      }
      makeRetriesDue(impl);
      await impl.deliverChatTimelines(true);
    });
  });

  it("releases a running turn when deletion outlives its setup await", async () => {
    const {stub, recipientId} = await setup();
    await withImpl(stub, async impl => {
      const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
      using cleanup = vi.spyOn(impl, "reconcilePendingGadgets").mockImplementation(async () => {
        entered.resolve();
        await release.promise;
      });
      using materialize = vi.spyOn(impl, "materializeChatChanges");
      const restore = interceptRemoval(impl, async () => { throw new Error("cleanup unavailable"); });
      try {
        impl.startAgent(1, {profile: {type: "agent", id: "model", name: "Model"},
          config: {provider: "cloudflare", model: "@cf/test/model", apiToken: ""}},
          {type: "user", id: "owner", name: "Owner"}, recipientId);
        await entered.promise;
        impl.deleteWorkspace();
        release.resolve();
        await impl.waitForAllAgentsToComplete();
        expect(cleanup).toHaveBeenCalledTimes(1);
        expect(materialize).not.toHaveBeenCalled();
        expect([...impl.storage.activeAgents.list()]).toEqual([]);
        expect([...impl.storage.chats.list()].map(message => message.type)).toEqual(["message"]);
        await expect(impl.deliverChatTimelines(true)).rejects.toThrow("cleanup unavailable");
      } finally {
        release.resolve();
        restore();
      }
      makeRetriesDue(impl);
      await impl.deliverChatTimelines(true);
    });
  });

  it("fences turn startup while deleteAll has cleared deletion intent but has not returned", async () => {
    const { stub, recipientId } = await setup();
    await withImpl(stub, async (impl) => {
      const deleteAll = impl.ctx.storage.deleteAll.bind(impl.ctx.storage);
      let cleared!: () => void;
      const storageCleared = new Promise<void>(resolve => { cleared = resolve; });
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      using _remove = vi.spyOn(impl.ctx.storage, "deleteAll").mockImplementation(async () => {
        await deleteAll();
        cleared();
        await gate;
      });
      impl.deleteWorkspace();
      const deletion = impl.deliverChatTimelines(true);
      try {
        await storageCleared;
        expect(impl.storage.deletingWorkspace.get()).toBe(false);
        impl.startAgent(1, {
          profile: { type: "agent", id: "model", name: "Model" },
          config: { provider: "cloudflare", model: "@cf/test/model", apiToken: "" },
        }, { type: "user", id: "owner", name: "Owner" }, recipientId);
        expect([...impl.storage.activeAgents.list()]).toEqual([]);
      } finally {
        release();
        await deletion;
        await impl.waitForAllAgentsToComplete();
      }
    });
  });

  it.each([true, false])("stops an interrupted turn whose model lookup outlives deletion (model available: %s)", async (available) => {
    const { stub, recipientId } = await setup();
    await withImpl(stub, async (impl) => {
      const initiator = { type: "user" as const, id: "owner", name: "Owner" };
      impl.storage.activeAgents.put({
        chatId: 1, initiatorUserId: recipientId, modelId: "gone-model", initiator,
        callbackInitiated: false,
      });
      impl.storage.chats.put({chatId: 1, sequence: 2, timestamp: impl.getChatTimestamp(),
        author: {type: "agent", id: "gone-model", name: "Model"}, type: "connectionRequest",
        requestId: "connection", vendorId: "test", vendorName: "Test", reason: "Read", state: "pending"});
      impl.storage.nextChatSequences.put({chatId: 1, nextSequence: 3});
    });
    await evictDurableObject(stub);
    await withImpl(stub, async impl => {
      const gate = Promise.withResolvers<void>();
      const lookup = vi.fn(async () => {
        await gate.promise;
        return {
          profile: { type: "user" as const, id: "owner", name: "Owner" },
          ...(available ? { aiModel: {
            profile: { type: "agent" as const, id: "gone-model", name: "Model" },
            config: { provider: "cloudflare" as const, model: "@cf/test/model", apiToken: "" },
          } } : {}),
        };
      });
      const dispatch = interceptUser(impl, "getChatContext", lookup);
      try {
        const message = [...impl.storage.chats.list()].find(message => message.type === "connectionRequest")!;
        impl.storage.chats.put({...message, state: "accepted"});
        impl.resumeAgentAfterDecision(1);
        using cleanup = vi.spyOn(impl, "reconcilePendingGadgets");
        await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(1));
        impl.storage.deletingWorkspace.put(true);
        gate.resolve();
        await impl.waitForAllAgentsToComplete();

        expect(cleanup).not.toHaveBeenCalled();
        expect([...impl.storage.chats.list()].map(message => message.type))
          .toEqual(["message", "connectionRequest", "agentNudge"]);
        expect([...impl.storage.activeAgents.list()]).toEqual([]);
      } finally {
        gate.resolve();
        dispatch.restore();
      }
    });
  });

  it("delivers persisted intent after real Overseer eviction without replaying OS/push alerts", async () => {
    const { stub, recipientId } = await setup();
    using alerts = vi.spyOn(UserDurableObject.prototype, "publishNotification");
    await evictDurableObject(stub);
    await runDurableObjectAlarm(stub);
    await withImpl(stub, async (impl) => {
      const user = impl.users.get(impl.users.idFromString(recipientId));
      expect((await user.getUnreadState()).unreadChatCount).toBe(1);
      expectAcknowledged(impl);
    });
    expect(alerts).not.toHaveBeenCalled();
  });

  it("does not erase activity queued while an earlier snapshot's ACK is in flight", async () => {
    const { stub, recipientId } = await setup();
    await withImpl(stub, async (impl) => {
      let appended = false;
      const dispatch = interceptDispatch(impl, async (user, args) => {
        await user.syncWorkspaceChats(...args);
        if (appended) return;
        appended = true;
        await user.markChatRead({
          workspaceId: impl.ctx.id.toString(),
          chatId: 1,
          throughSequence: 1,
          readEpoch: 0,
        });
        impl.storage.chats.put({
          chatId: 1,
          sequence: 2,
          timestamp: new Date(),
          author: { type: "agent", id: "test", name: "Test" },
          type: "message",
          message: "New activity",
        });
      });
      try {
        await impl.deliverChatTimelines();
        expect(dispatch.calls()).toBe(2);
      } finally {
        dispatch.restore();
      }
      expect(
        await impl.users.get(impl.users.idFromString(recipientId)).getUnreadState(),
      ).toMatchObject({
        unreadChatCount: 1,
        chats: [{ latestSequence: 2, readThroughSequence: 1 }],
      });
      expectAcknowledged(impl);
    });
  });

  it.each(["before dispatch", "lost ACK", "checkpoint write"])(
    "recovers after eviction at %s, without replaying an accepted snapshot or clearing later reads",
    async boundary => {
      const { stub, recipientId } = await setup();
      await withImpl(stub, async (impl) => {
        // Warm the receiver so the ACK boundary is independent of initial enrollment.
        const user = impl.users.get(impl.users.idFromString(recipientId));
        await user.getUnreadState();
        await impl.deliverChatTimelines(true);
        const checkpointBefore = impl.storage.unreadReaders.get(recipientId)!.timelineVersion;
        const dispatch = interceptDispatch(impl, async (user, args) => {
          if (boundary === "before dispatch") throw new Error(boundary);
          await user.syncWorkspaceChats(...args);
          if (boundary === "lost ACK") throw new Error(boundary);
        });
        using checkpoint = vi.spyOn(impl.storage.unreadReaders, "put");
        if (boundary === "checkpoint write") checkpoint.mockImplementationOnce(() => { throw new Error(boundary); });
        impl.storage.chatTimelineRetryAt.put(Date.now() + 60_000);
        impl.storage.chats.put({chatId: 1, sequence: 2, timestamp: impl.getChatTimestamp(),
          author: {type: "agent", id: "test", name: "Test"}, type: "message", message: "New activity"});
        try {
          await expect(impl.deliverChatTimelines(true)).rejects.toThrow(boundary);
          expect(impl.storage.unreadReaders.get(recipientId)?.timelineVersion).toBe(checkpointBefore);
          expect(impl.storage.chatTimelineRetryAt.get()).toBeGreaterThan(Date.now());
          await impl.deliverChatTimelines();
          expect(dispatch.calls()).toBe(1);
        } finally { dispatch.restore(); }
        await user.markChatRead({workspaceId: impl.ctx.id.toString(), chatId: 1, throughSequence: 1, readEpoch: 0});
        await evictDurableObject(user);
        makeRetriesDue(impl);
      });
      await evictDurableObject(stub);
      await runDurableObjectAlarm(stub);
      await withImpl(stub, async (impl) => {
        const state = await impl.users.get(impl.users.idFromString(recipientId)).getUnreadState();
        expect(state).toMatchObject({unreadChatCount: 1, unreadMessageCount: 1,
          chats: [{readThroughSequence: 1, latestSequence: 2, latestMessagePreview: "New activity"}]});
        expectAcknowledged(impl);
      });
    },
  );

  it("does not restore unread state if access was removed while delivery was pending", async () => {
    const { stub, recipientId } = await setup();
    await withImpl(stub, async (impl) => {
      const user = impl.users.get(impl.users.idFromString(recipientId));
      await user.deleteGadget(impl.ctx.id.toString());
    });
    await evictDurableObject(stub);
    await runDurableObjectAlarm(stub);
    await withImpl(stub, async (impl) => {
      expect(
        (await impl.users.get(impl.users.idFromString(recipientId)).getUnreadState())
          .unreadChatCount,
      ).toBe(0);
      expectAcknowledged(impl);
    });
  });
});
