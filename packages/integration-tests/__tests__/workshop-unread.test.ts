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
    if (!this.state || state.revision > this.state.revision) this.state = state;
  }
}

const receipt = (chat: ChatReadState) => ({
  workspaceId: chat.workspaceId,
  chatId: chat.chatId,
  readEpoch: chat.readEpoch,
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
    first.state?.revision === 0 && second.state?.revision === 0 ? true : null,
  );

  using workspace = await owner.newGadget();
  const { id: workspaceId } = await workspace.getMetadata();
  const chatId = await workspace.newChat("First persisted item", null);
  const initial = await waitFor("the newly persisted thread", async () => {
    const chat = (await owner.getUnreadState()).chats.find((item) => item.chatId === chatId);
    return chat && chat.latestSequence >= 0 ? chat : null;
  });
  expect(initial.readThroughSequence).toBe(-1);
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
  await owner.markChatsRead([receipt(initial)]);
  expect((await owner.getUnreadState()).unreadChatCount).toBe(1);
  await owner.markChatRead(receipt(next));
  await secondDevice.markChatUnread(workspaceId, chatId, initial.latestSequence, next.readEpoch);
  await owner.markChatRead(receipt(next)); // stale automatic read from the other device
  await waitFor("the manual unread boundary on both devices", async () =>
    first.state?.chats[0]?.readEpoch === 1 && second.state?.chats[0]?.readEpoch === 1 ? true : null,
  );
  expect(first.state?.chats[0]?.readThroughSequence).toBe(initial.latestSequence - 1);

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
    (await owner.getUnreadState()).chats.some((chat) => chat.chatId === other) ? true : null,
  );
  await workspace.deleteSelf();
  await waitFor("workspace removal", async () =>
    (await owner.getUnreadState()).chats.length === 0 ? true : null,
  );
});
