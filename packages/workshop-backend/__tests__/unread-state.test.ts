import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { RpcStub, RpcTarget } from "capnweb";
import { describe, expect, it, vi } from "vitest";
import type {
  ChatReadState,
  UnreadStateSubscriber,
  UserUnreadState,
} from "@gadgets/workshop-shared/api";
import type { UserDurableObject } from "../src/user.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

const head = { chatId: 1, chatTitle: "Demo", latestSequence: 9 };
const receipt = (throughSequence = 9, readEpoch = 0) => ({
  workspaceId: "workspace-1",
  chatId: 1,
  throughSequence,
  readEpoch,
});
const user = async () => {
  const stub = env.TEST_USER.getByName(`read-cursors-${crypto.randomUUID()}`);
  await stub.newGadget("workspace-1", "Demo workspace");
  return stub;
};
const cursor = async (stub: DurableObjectStub<UserDurableObject>): Promise<ChatReadState> =>
  (await stub.getUnreadState()).chats[0];

class Subscriber extends RpcTarget implements UnreadStateSubscriber {
  constructor(private readonly receive: (state: UserUnreadState) => void) {
    super();
  }
  async updated(state: UserUnreadState): Promise<void> {
    this.receive(state);
  }
}

describe("user timeline read cursors", () => {
  it("refreshes preview-only changes without changing read positions and retains them after eviction", async () => {
    const stub = await user();
    await stub.syncWorkspaceChats("workspace-1", 1, [head]);
    await stub.markChatRead(receipt(4));
    const latestActivityAt = new Date("2026-10-15T00:00:00Z");
    await stub.syncWorkspaceChats("workspace-1", 2, [{ ...head,
      latestMessagePreview: "First line", latestActivityAt }]);
    await evictDurableObject(stub);
    expect(await cursor(stub)).toMatchObject({
      latestMessagePreview: "First line", latestActivityAt,
      readThroughSequence: 4, readEpoch: 0,
    });
    await stub.syncWorkspaceChats("workspace-1", 3, [{ ...head,
      latestMessagePreview: "Edited line", latestActivityAt }]);
    expect((await cursor(stub)).latestMessagePreview).toBe("Edited line");
    await stub.syncWorkspaceChats("workspace-1", 2, [{ ...head,
      latestMessagePreview: "Stale line", latestActivityAt }]);
    expect((await cursor(stub)).latestMessagePreview).toBe("Edited line");
  });

  it("counts distinct threads and keeps read cursors in the snapshot", async () => {
    const stub = await user();
    expect(await stub.getUnreadState()).toEqual({ revision: 0, unreadChatCount: 0, chats: [] });
    await stub.syncWorkspaceChats("workspace-1", 1, [head, { ...head, chatId: 2 }]);
    await stub.newGadget("workspace-2", "Another workspace");
    await stub.syncWorkspaceChats("workspace-2", 1, [head]);
    expect((await stub.getUnreadState()).unreadChatCount).toBe(3);
    await stub.markChatRead(receipt());
    expect((await stub.getUnreadState()).unreadChatCount).toBe(2);
    expect(await cursor(stub)).toMatchObject({
      latestSequence: 9,
      readThroughSequence: 9,
      readEpoch: 0,
    });
  });

  it("advances partially and never clears messages arriving after the observed boundary", async () => {
    const stub = await user();
    await stub.syncWorkspaceChats("workspace-1", 1, [head]);
    await stub.syncWorkspaceChats("workspace-1", 2, [{ ...head, latestSequence: 12 }]);
    await stub.markChatRead(receipt(4));
    expect(await cursor(stub)).toMatchObject({ readThroughSequence: 4, latestSequence: 12 });
    await stub.markChatRead(receipt(9));
    await stub.markChatRead(receipt(3)); // delayed lower receipt cannot rewind
    expect(await cursor(stub)).toMatchObject({ readThroughSequence: 9, latestSequence: 12 });
    expect((await stub.getUnreadState()).unreadChatCount).toBe(1);
  });

  it("marks unread from an individual item and fences in-flight reads from every device", async () => {
    const stub = await user();
    await stub.syncWorkspaceChats("workspace-1", 1, [head]);
    await stub.markChatRead(receipt());
    await stub.markChatUnread("workspace-1", 1, 4, 0);
    expect(await cursor(stub)).toMatchObject({ readThroughSequence: 3, readEpoch: 1 });
    await stub.markChatRead(receipt()); // another window still at epoch zero
    expect((await cursor(stub)).readThroughSequence).toBe(3);
    await stub.markChatRead(receipt(6, 1));
    expect((await cursor(stub)).readThroughSequence).toBe(6);
    await stub.markChatUnread("workspace-1", 1, 4, 0); // lost ACK retry
    expect((await cursor(stub)).readThroughSequence).toBe(6);
  });

  it("bulk marks workspace/all read from the observed snapshot without swallowing new activity", async () => {
    const stub = await user();
    await stub.syncWorkspaceChats("workspace-1", 1, [head, { ...head, chatId: 2 }]);
    await stub.newGadget("workspace-2", "Another");
    await stub.syncWorkspaceChats("workspace-2", 1, [head]);
    const observed = (await stub.getUnreadState()).chats.map((chat) => ({
      ...chat,
      throughSequence: chat.latestSequence,
    }));
    await stub.syncWorkspaceChats("workspace-1", 2, [
      { ...head, latestSequence: 10 },
      { ...head, chatId: 2 },
    ]);
    await stub.markChatUnread("workspace-1", 2, 2, 0);
    await stub.markChatsRead(observed);
    expect((await stub.getUnreadState()).unreadChatCount).toBe(2);
    expect(
      (await stub.getUnreadState()).chats.find((chat) => chat.chatId === 2)?.readThroughSequence,
    ).toBe(1);
    const before = await stub.getUnreadState();
    await stub.markChatsRead(observed);
    expect(await stub.getUnreadState()).toEqual(before);
  });

  it("deduplicates source snapshots after reading and rejects out-of-order resurrection after deletion", async () => {
    const stub = await user();
    await stub.syncWorkspaceChats("workspace-1", 2, [head]);
    await stub.markChatRead(receipt());
    const read = await stub.getUnreadState();
    await stub.syncWorkspaceChats("workspace-1", 2, [head]);
    await stub.syncWorkspaceChats("workspace-1", 1, [{ ...head, latestSequence: 8 }]);
    expect(await stub.getUnreadState()).toEqual(read);
    await stub.syncWorkspaceChats("workspace-1", 3, []);
    await stub.syncWorkspaceChats("workspace-1", 2, [head]);
    expect((await stub.getUnreadState()).chats).toEqual([]);
  });

  it("baselines historical content on upgrade, while subsequent activity is unread", async () => {
    const stub = await user();
    await stub.syncWorkspaceChats("workspace-1", 1, [{ ...head, initialReadThroughSequence: 9 }]);
    expect((await stub.getUnreadState()).unreadChatCount).toBe(0);
    await stub.syncWorkspaceChats("workspace-1", 2, [
      { ...head, latestSequence: 10, initialReadThroughSequence: 9 },
    ]);
    expect(await cursor(stub)).toMatchObject({ readThroughSequence: 9, latestSequence: 10 });
    expect((await stub.getUnreadState()).unreadChatCount).toBe(1);
  });

  it("does not make empty threads unread", async () => {
    const stub = await user();
    await stub.syncWorkspaceChats("workspace-1", 1, [{ ...head, latestSequence: -1 }]);
    expect((await stub.getUnreadState()).unreadChatCount).toBe(0);
  });

  it("persists newer source fences without broadcasting unchanged public state", async () => {
    const stub = await user();
    await stub.syncWorkspaceChats("workspace-1", 1, [head]);
    const before = await stub.getUnreadState();
    await stub.syncWorkspaceChats("workspace-1", 3, [head]);
    await stub.syncWorkspaceChats("workspace-1", 2, [{ ...head, latestSequence: 10 }]);
    expect(await stub.getUnreadState()).toEqual(before);
  });

  it("publishes cleanup when a shared workspace is downgraded to use-only", async () => {
    const stub = env.TEST_USER.getByName(`read-downgrade-${crypto.randomUUID()}`);
    await stub.recordSharedGadgetOpen(
      "workspace-1",
      "Shared",
      { id: "owner", name: "Owner", type: "user" },
      "build",
    );
    await stub.syncWorkspaceChats("workspace-1", 1, [head]);
    const before = await stub.getUnreadState();
    await stub.updateSharedGadgetRole("workspace-1", "use");
    await stub.syncWorkspaceChats("workspace-1", 2, [{ ...head, latestSequence: 10 }]);
    expect(await stub.getUnreadState()).toEqual({
      revision: before.revision + 1,
      unreadChatCount: 0,
      chats: [],
    });
  });

  it("sends initial snapshots and synchronizes explicit unread and reads across devices", async () => {
    const stub = await user();
    const first: UserUnreadState[] = [],
      second: UserUnreadState[] = [];
    using a = new RpcStub(new Subscriber((state) => first.push(state)));
    using b = new RpcStub(new Subscriber((state) => second.push(state)));
    using _one = await stub.subscribeToUnreadState(a);
    using _two = await stub.subscribeToUnreadState(b);
    await vi.waitFor(() => expect([first.length, second.length]).toEqual([1, 1]));
    await stub.syncWorkspaceChats("workspace-1", 1, [head]);
    await stub.markChatRead(receipt());
    await stub.markChatUnread("workspace-1", 1, 0, 0);
    await vi.waitFor(() => expect([first.length, second.length]).toEqual([4, 4]));
    expect(second[3].chats[0]).toMatchObject({ readThroughSequence: -1, readEpoch: 1 });
    expect(second[3]).toEqual(first[3]);
  });

  it("retains cursors, manual epochs and dedupe fences through real DO eviction", async () => {
    const stub = await user();
    await stub.syncWorkspaceChats("workspace-1", 1, [head]);
    await stub.markChatRead(receipt());
    await stub.markChatUnread("workspace-1", 1, 5, 0);
    await evictDurableObject(stub);
    await stub.syncWorkspaceChats("workspace-1", 1, [head]);
    await stub.markChatRead(receipt());
    expect(await cursor(stub)).toMatchObject({ readThroughSequence: 4, readEpoch: 1 });
    await stub.markChatRead(receipt(9, 1));
    await evictDurableObject(stub);
    expect((await stub.getUnreadState()).unreadChatCount).toBe(0);
  });

  it("cleans up removal and keeps users isolated", async () => {
    const first = await user(),
      second = await user();
    await first.syncWorkspaceChats("workspace-1", 1, [head]);
    expect((await second.getUnreadState()).unreadChatCount).toBe(0);
    await first.deleteGadget("workspace-1");
    await first.syncWorkspaceChats("workspace-1", 2, [head]);
    expect((await first.getUnreadState()).chats).toEqual([]);
  });

  it("rejects invalid timeline positions without partially applying a bulk command", async () => {
    const stub = await user();
    await stub.syncWorkspaceChats("workspace-1", 1, [head]);
    await runInDurableObject(stub, async (instance) => {
      await expect(instance.markChatsRead([receipt(9), receipt(-2)])).rejects.toThrow(
        "Invalid timeline",
      );
      await expect(instance.markChatUnread("workspace-1", 1, 10, 0)).rejects.toThrow(
        "Invalid timeline",
      );
      await expect(instance.markChatUnread("workspace-1", 1, -1, 0)).rejects.toThrow(
        "Invalid timeline",
      );
    });
    expect((await cursor(stub)).readThroughSequence).toBe(-1);
  });
});
