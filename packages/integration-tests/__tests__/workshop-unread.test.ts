import { afterAll, beforeAll, expect, it } from "vitest";
import type {
  ChatReadState,
  UnreadStateSubscriber,
  UserUnreadState,
} from "@gadgets/workshop-shared/api";
import { type Harness, startHarness } from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { mockChatCompletion } from "../src/mock-model.js";
import {
  RpcTarget,
  connect,
  logIn,
  nextUsernames,
  signUp,
  stubFor,
  waitFor,
} from "../src/rpc-client.js";

class UnreadRecorder extends RpcTarget implements UnreadStateSubscriber {
  state: UserUnreadState | undefined;
  async updated(state: UserUnreadState): Promise<void> {
    this.state = state;
  }
  async chatUpdated(workspaceId: string, chatId: number, chat: ChatReadState | null,
      counts: Pick<UserUnreadState, "unreadChatCount" | "unreadMessageCount">): Promise<void> {
    if (!this.state) return;
    const chats = this.state.chats.filter(item => item.workspaceId !== workspaceId || item.chatId !== chatId);
    if (chat) chats.push(chat);
    this.state = {...this.state, ...counts, chats};
  }
}

const receipt = (chat: ChatReadState) => ({
  workspaceId: chat.workspaceId,
  chatId: chat.chatId,
  readThroughSequence: chat.readThroughSequence,
  readToken: chat.readToken,
  throughSequence: chat.latestSequence,
});
let harness: Harness | undefined;
const network = new NetworkInterceptor({ handlers: [mockChatCompletion("Test chat")] });
beforeAll(async () => {
  network.install();
  harness = await startHarness({ gatekeepers: [] });
});
afterAll(async () => {
  try {
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

it("synchronizes real timeline cursors across WebSocket sessions without leaking use-only chats", async () => {
  if (!harness) throw new Error("Workshop harness did not start");
  const [ownerName, builderName, viewerName] = nextUsernames(
    "unreadowner",
    "unreadbuilder",
    "unreadviewer",
  );
  using publicApi = connect(harness.url);
  using secondPublic = connect(harness.url);
  using builderPublic = connect(harness.url);
  using viewerPublic = connect(harness.url);
  using owner = await signUp(publicApi, ownerName);
  using secondDevice = await logIn(secondPublic, ownerName);
  using builder = await signUp(builderPublic, builderName);
  using viewer = await signUp(viewerPublic, viewerName);
  const first = new UnreadRecorder(),
    second = new UnreadRecorder();
  using firstStub = stubFor(first);
  using secondStub = stubFor(second);
  using _first = await owner.subscribeToUnreadState(firstStub);
  using _second = await secondDevice.subscribeToUnreadState(secondStub);
  await waitFor("both initial unread snapshots", async () =>
    first.state && second.state ? true : null,
  );

  using workspace = await owner.newGadget();
  const { id: workspaceId } = await workspace.getMetadata();
  const chatId = await workspace.newChat("First persisted item", null);
  const initial = await waitFor("the newly persisted thread", async () => {
    const chat = (await owner.getUnreadState()).chats.find((item) => item.chatId === chatId);
    return chat && chat.latestSequence >= 0 ? chat : null;
  });
  expect(initial.readThroughSequence).toBe(-1);
  expect(initial.unreadMessageCount).toBe(1);
  expect(initial.latestMessagePreview).toBe("First persisted item");
  expect(initial.latestActivityAt).toBeInstanceOf(Date);
  await secondDevice.markChatRead(receipt(initial));
  await waitFor("cross-device read delivery", async () =>
    first.state?.unreadChatCount === 0 &&
    second.state?.unreadChatCount === 0 &&
    first.state?.chats.length === 1
      ? true
      : null,
  );

  await workspace.sendChatMessage(chatId, "Second persisted item", null);
  const next = await waitFor("new activity beyond the read pointer", async () => {
    const chat = (await owner.getUnreadState()).chats.find((item) => item.chatId === chatId);
    return chat && chat.latestSequence > initial.latestSequence ? chat : null;
  });
  expect(next.latestMessagePreview).toBe("Second persisted item");
  expect(next.unreadMessageCount).toBe(1);
  await owner.markChatsRead([receipt(initial)]);
  expect(await owner.getUnreadState()).toMatchObject({ unreadChatCount: 1, unreadMessageCount: 1 });
  await owner.markChatRead(receipt(next));
  const read = (await secondDevice.getUnreadState()).chats.find(chat => chat.chatId === chatId)!;
  await secondDevice.markChatUnread(workspaceId, chatId, initial.latestSequence, read.readThroughSequence, read.readToken);
  await owner.markChatRead(receipt(next)); // stale automatic read from the other device
  await waitFor("the manual unread boundary on both devices", async () =>
    first.state?.chats[0]?.readThroughSequence === initial.latestSequence - 1 &&
    second.state?.chats[0]?.readThroughSequence === initial.latestSequence - 1 ? true : null,
  );
  expect(first.state?.chats[0]?.readThroughSequence).toBe(initial.latestSequence - 1);
  expect(first.state?.unreadMessageCount).toBe(2);

  await workspace.addCollaborator(builderName, "build");
  await workspace.addCollaborator(viewerName, "use");
  using _builderWorkspace = await builder.openGadget(workspaceId);
  using _viewerWorkspace = await viewer.openGadget(workspaceId);
  await waitFor("a build collaborator's independent cursor", async () =>
    (await builder.getUnreadState()).chats.length === 1 ? true : null,
  );
  expect((await viewer.getUnreadState()).chats).toEqual([]);
  await builder.markChatsRead((await builder.getUnreadState()).chats.map(receipt));
  expect((await builder.getUnreadState()).unreadChatCount).toBe(0);
  expect((await owner.getUnreadState()).unreadChatCount).toBe(1);

  const builderUpdates = new UnreadRecorder(), viewerUpdates = new UnreadRecorder();
  using builderStub = stubFor(builderUpdates);
  using viewerStub = stubFor(viewerUpdates);
  using _builderUpdates = await builder.subscribeToUnreadState(builderStub);
  using _viewerUpdates = await viewer.subscribeToUnreadState(viewerStub);
  await waitFor("collaborators' initial snapshots", async () =>
    builderUpdates.state?.unreadMessageCount === 0 && viewerUpdates.state?.chats.length === 0
      ? true : null,
  );

  // No polling/reopening the workspace: ordinary message fanout must drive every user's badges.
  await workspace.sendChatMessage(chatId, "Third persisted item\nNot part of the preview", null);
  await waitFor("the same message reaching both users' live subscriptions", async () =>
    first.state?.unreadMessageCount === 3 && second.state?.unreadMessageCount === 3 &&
    builderUpdates.state?.unreadMessageCount === 1 ? true : null,
  );
  const third = first.state!.chats[0];
  expect(third.latestMessagePreview).toBe("Third persisted item");
  expect(builderUpdates.state!.chats[0]).toMatchObject({
    latestSequence: third.latestSequence, latestMessagePreview: "Third persisted item",
    readThroughSequence: next.latestSequence, unreadMessageCount: 1,
  });
  expect(viewerUpdates.state!.chats).toEqual([]);

  await secondDevice.markChatRead({...receipt(third), throughSequence: next.latestSequence});
  await waitFor("an observed partial read leaving the later message unread", async () =>
    first.state?.unreadMessageCount === 1 && second.state?.unreadMessageCount === 1 ? true : null,
  );
  const partial = (await owner.getUnreadState()).chats.find(chat => chat.chatId === chatId)!;
  await owner.markChatRead(receipt(partial));
  await waitFor("the owner's read clearing both devices but not the collaborator", async () =>
    first.state?.unreadMessageCount === 0 && second.state?.unreadMessageCount === 0 ? true : null,
  );
  expect(builderUpdates.state!.unreadMessageCount).toBe(1);

  await workspace.setChatTitle(chatId, "Renamed thread");
  await waitFor("the renamed unread thread", async () =>
    second.state?.chats[0]?.chatTitle === "Renamed thread" ? true : null,
  );
  await workspace.deleteChat(chatId);
  await waitFor("thread removal on every device", async () =>
    first.state?.chats.length === 0 &&
    second.state?.chats.length === 0 &&
    (await builder.getUnreadState()).chats.length === 0
      ? true
      : null,
  );
  const other = await workspace.newChat("Another thread", null);
  await waitFor("another unread thread", async () =>
    (await owner.getUnreadState()).chats.some((chat) => chat.chatId === other) &&
    (await builder.getUnreadState()).chats.some((chat) => chat.chatId === other) ? true : null,
  );
  // Deletion returns after owner cleanup; collaborator cleanup is durable background work.
  // A session holding an open workspace is intentionally disconnected by its restart. Observe
  // eventual cleanup from a separate session, like a hidden native badge listener.
  using backgroundPublic = connect(harness.url);
  using backgroundBuilder = await logIn(backgroundPublic, builderName);
  await workspace.deleteSelf();
  await waitFor("workspace removal", async () =>
    first.state?.chats.length === 0 && second.state?.chats.length === 0 &&
    (await backgroundBuilder.getUnreadState()).unreadMessageCount === 0 &&
    (await backgroundBuilder.getUnreadState()).chats.length === 0 ? true : null,
  );
});
