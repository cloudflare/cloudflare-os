import { env } from "cloudflare:workers";
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
const interceptDispatch = (
  impl: Impl,
  intercept: (
    user: DurableObjectStub<UserDurableObject>,
    args: Parameters<UserDurableObject["syncWorkspaceChats"]>,
  ) => Promise<void>,
) => {
  const original = impl.users;
  let calls = 0;
  impl.users = new Proxy(original, {
    get(target, key) {
      if (key === "idFromString") return (id: string) => target.idFromString(id);
      if (key === "get")
        return (id: DurableObjectId) =>
          new Proxy(target.get(id), {
            get(user, method) {
              if (method === "syncWorkspaceChats") {
                return async (...args: Parameters<UserDurableObject["syncWorkspaceChats"]>) => {
                  calls++;
                  await intercept(user, args);
                };
              }
              return Reflect.get(user, method);
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

const failDispatch = (impl: Impl, afterApply: boolean) =>
  interceptDispatch(impl, async (user, args) => {
    if (afterApply) await user.syncWorkspaceChats(...args);
    throw new Error(afterApply ? "ACK lost" : "before dispatch");
  });

const interceptRemoval = (
  impl: Impl,
  intercept: (user: DurableObjectStub<UserDurableObject>, workspaceId: string) => Promise<void>,
) => {
  const original = impl.users;
  impl.users = new Proxy(original, {
    get(target, key) {
      if (key === "idFromString") return (id: string) => target.idFromString(id);
      if (key === "get") return (id: DurableObjectId) => new Proxy(target.get(id), {
        get(user, method) {
          if (method === "deleteGadget") return (workspaceId: string) => intercept(user, workspaceId);
          return Reflect.get(user, method);
        },
      });
      return Reflect.get(target, key);
    },
  });
  return () => { impl.users = original; };
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
    impl.storage.chatTimelineOutbox.put({ sequence: 1, userId: id.toString() });
    // Model the persisted alarm that queueing schedules, without letting it fire during the test.
    await impl.ctx.storage.setAlarm(Date.now() + 60_000);
    return id.toString();
  });
  return { stub, recipientId };
};

describe("durable unread projection outbox", () => {
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
        latestMessagePreview: "x".repeat(240), latestActivityAt: new Date(+timestamp + 2), latestSequence: 4,
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
      await user.newGadget(impl.ctx.id.toString(), "Workspace");
      await user.syncWorkspaceChats(impl.ctx.id.toString(), 0, [
        { chatId: 1, chatTitle: "Old", latestSequence: 0 },
      ]);
      impl.storage.unreadReaders.put({ userId: id, profileId: "reader@example.com" });
      using verify = vi.spyOn(impl, "authorizeCollaborator").mockResolvedValue(null);
      // A sharing write alone journals cleanup; no later message or browser click is required.
      impl.storage.shareKeys.put({ id: "changed-key", alias: "revoked-link" });
      await impl.deliverChatTimelines();
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

  it.each(["authorization", "dispatch"])("isolates a recipient's %s failure and defers its retry", async (failure) => {
    const { stub, recipientId } = await setup();
    await withImpl(stub, async (impl) => {
      const ids = [recipientId, ...Array.from({length: 2}, () =>
        impl.users.idFromName(crypto.randomUUID()).toString())].toSorted();
      // Put the failing reader before both a healthy reader and the owner in outbox order.
      impl.ownerId = ids[2];
      impl.storage.ownerId.put(ids[2]);
      for (const id of ids) {
        await impl.users.get(impl.users.idFromString(id)).newGadget(impl.ctx.id.toString(), "Workspace");
        if (id !== impl.ownerId) impl.storage.unreadReaders.put({userId: id, profileId: id});
        impl.storage.chatTimelineOutbox.put({sequence: 1, userId: id});
      }
      using verify = vi.spyOn(impl, "authorizeCollaborator").mockImplementation(async (profileId) => {
        if (failure === "authorization" && profileId === ids[0]) throw new Error("needs repair");
        return "build";
      });
      const dispatch = interceptDispatch(impl, async (user, args) => {
        if (failure === "dispatch" && user.id.toString() === ids[0]) throw new Error("needs repair");
        await user.syncWorkspaceChats(...args);
      });
      try {
        await expect(impl.deliverChatTimelines(true)).rejects.toThrow("needs repair");
        for (const id of ids.slice(1)) {
          expect((await impl.users.get(impl.users.idFromString(id)).getUnreadState()).unreadChatCount).toBe(1);
        }
        expect([...impl.storage.chatTimelineOutbox.list()]).toEqual([{sequence: 1, userId: ids[0]}]);
        expect(impl.storage.chatTimelineRetryAt.get()).toBeGreaterThan(Date.now());
        const attempts = verify.mock.calls.length;
        await impl.deliverChatTimelines();
        expect(verify).toHaveBeenCalledTimes(attempts);
      } finally {
        dispatch.restore();
      }
    });
  });

  it.each(["before dispatch", "lost ACK", "outbox cleanup", "storage deletion"])(
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
        const remove = impl.storage.chatTimelineOutbox.delete.bind(impl.storage.chatTimelineOutbox);
        using _cleanup = vi.spyOn(impl.storage.chatTimelineOutbox, "delete").mockImplementation((userId) => {
          if (userId === id && boundary === "outbox cleanup") throw new Error(boundary);
          return remove(userId);
        });
        using _deleteAll = vi.spyOn(impl.ctx.storage, "deleteAll");
        if (boundary === "storage deletion") _deleteAll.mockRejectedValueOnce(new Error(boundary));
        try {
          await expect(impl.deleteWorkspace()).rejects.toThrow(boundary);
          expect(impl.storage.deletingWorkspace.get()).toBe(true);
          expect(impl.storage.chatMeta.get(1)).toBeDefined();
          expect((await reader.getUnreadState()).unreadChatCount).toBe(boundary === "before dispatch" ? 1 : 0);
          // The owner's cleanup proceeds even when a collaborator fails.
          expect((await impl.users.get(impl.users.idFromString(recipientId)).getUnreadState()).chats).toEqual([]);
          impl.storage.chatTimelineRetryAt.put(0);
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
        expect([...impl.storage.chatTimelineOutbox.list()]).toEqual([]);
        const reader = impl.users.get(impl.users.idFromString(readerId));
        await reader.syncWorkspaceChats(impl.ctx.id.toString(), 999, [
          {chatId: 1, chatTitle: "Delayed", latestSequence: 2},
        ]);
        expect((await reader.getUnreadState()).chats).toEqual([]);
      });
    },
  );

  it("delivers persisted intent after real Overseer eviction without replaying OS/push alerts", async () => {
    const { stub, recipientId } = await setup();
    using alerts = vi.spyOn(UserDurableObject.prototype, "publishNotification");
    await evictDurableObject(stub);
    await runDurableObjectAlarm(stub);
    await withImpl(stub, async (impl) => {
      const user = impl.users.get(impl.users.idFromString(recipientId));
      expect((await user.getUnreadState()).unreadChatCount).toBe(1);
      expect([...impl.storage.chatTimelineOutbox.list()]).toEqual([]);
    });
    expect(alerts).not.toHaveBeenCalled();
  });

  it("reconstructs recipient fanout from persisted dirty intent after eviction", async () => {
    const { stub, recipientId } = await setup();
    await withImpl(stub, async (impl) => {
      impl.storage.chatTimelineOutbox.delete(recipientId);
      impl.storage.chatTimelineDirty.put(true);
    });
    await evictDurableObject(stub);
    await runDurableObjectAlarm(stub);
    await withImpl(stub, async (impl) => {
      expect(
        (await impl.users.get(impl.users.idFromString(recipientId)).getUnreadState())
          .unreadChatCount,
      ).toBe(1);
      expect(impl.storage.chatTimelineDirty.get()).toBe(false);
      expect([...impl.storage.chatTimelineOutbox.list()]).toEqual([]);
    });
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
      expect([...impl.storage.chatTimelineOutbox.list()]).toEqual([]);
    });
  });

  it("persists a bounded retry deadline when dispatch fails, then recovers after eviction", async () => {
    const { stub, recipientId } = await setup();
    await withImpl(stub, async (impl) => {
      const failure = failDispatch(impl, false);
      try {
        await expect(impl.deliverChatTimelines()).rejects.toThrow("before dispatch");
        expect([...impl.storage.chatTimelineOutbox.list()]).toHaveLength(1);
        expect(impl.storage.chatTimelineRetryAt.get()).toBeGreaterThan(Date.now());
        await impl.deliverChatTimelines();
        expect(failure.calls()).toBe(1);
        // Advance the persisted deadline instead of changing workerd's clock.
        impl.storage.chatTimelineRetryAt.put(0);
      } finally {
        failure.restore();
      }
    });
    await evictDurableObject(stub);
    await runDurableObjectAlarm(stub);
    await withImpl(stub, async (impl) => {
      expect(
        (await impl.users.get(impl.users.idFromString(recipientId)).getUnreadState())
          .unreadChatCount,
      ).toBe(1);
      expect([...impl.storage.chatTimelineOutbox.list()]).toEqual([]);
    });
  });

  it("deduplicates an accepted effect whose ACK was lost, even if the user reads before retry", async () => {
    const { stub, recipientId } = await setup();
    await withImpl(stub, async (impl) => {
      const failure = failDispatch(impl, true);
      try {
        await expect(impl.deliverChatTimelines()).rejects.toThrow("ACK lost");
      } finally {
        failure.restore();
      }
      const user = impl.users.get(impl.users.idFromString(recipientId));
      expect((await user.getUnreadState()).revision).toBe(1);
      await user.markChatRead({
        workspaceId: impl.ctx.id.toString(),
        chatId: 1,
        throughSequence: 1,
        readEpoch: 0,
      });
      impl.storage.chatTimelineRetryAt.put(0);
    });
    await evictDurableObject(stub);
    await runDurableObjectAlarm(stub);
    await withImpl(stub, async (impl) => {
      expect(
        await impl.users.get(impl.users.idFromString(recipientId)).getUnreadState(),
      ).toMatchObject({ revision: 2, unreadChatCount: 0, chats: [{ readThroughSequence: 1 }] });
      expect([...impl.storage.chatTimelineOutbox.list()]).toEqual([]);
    });
  });

  it("reconciles an ACK received before local outbox cleanup failed", async () => {
    const { stub, recipientId } = await setup();
    await withImpl(stub, async (impl) => {
      using _ = vi.spyOn(impl.storage.chatTimelineOutbox, "delete").mockImplementationOnce(() => {
        throw new Error("cleanup interrupted");
      });
      await expect(impl.deliverChatTimelines()).rejects.toThrow("cleanup interrupted");
      expect(
        (await impl.users.get(impl.users.idFromString(recipientId)).getUnreadState()).revision,
      ).toBe(1);
      expect([...impl.storage.chatTimelineOutbox.list()]).toHaveLength(1);
      impl.storage.chatTimelineRetryAt.put(0);
    });
    await evictDurableObject(stub);
    await runDurableObjectAlarm(stub);
    await withImpl(stub, async (impl) => {
      const state = await impl.users.get(impl.users.idFromString(recipientId)).getUnreadState();
      expect([state.revision, state.unreadChatCount]).toEqual([1, 1]);
      expect([...impl.storage.chatTimelineOutbox.list()]).toEqual([]);
    });
  });

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
      expect([...impl.storage.chatTimelineOutbox.list()]).toEqual([]);
    });
  });
});
