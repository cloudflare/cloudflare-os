import { afterAll, beforeAll, expect, it } from "vitest";
import { type Harness, startHarness } from "../src/harness.js";
import { mockChatCompletion } from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, nextUsernames, signUp, waitFor } from "../src/rpc-client.js";

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

function requireHarness(): Harness {
  if (harness === undefined) throw new Error("Workshop harness did not start");
  return harness;
}

function username(): string {
  const value = nextUsernames("functional").at(0);
  if (value === undefined) throw new Error("Failed to allocate a test username");
  return value;
}

it.concurrent("lists workspace metadata after activity and removes it after deletion", async () => {
  using publicApi = connect(requireHarness().url);
  using authenticated = await signUp(publicApi, username());
  using workspace = await authenticated.newGadget();
  const { id } = await workspace.getMetadata();
  expect(await authenticated.listGadgets()).not.toContainEqual(expect.objectContaining({ id }));

  await workspace.setTitle("Renamed Workspace");
  await workspace.setPinned(true);
  await workspace.newChat("Record this without running an agent", null);

  const listed = await waitFor("the active workspace to appear in the user's list", async () => {
    const workspaces = await authenticated.listGadgets();
    return workspaces.some(entry => entry.id === id) ? workspaces : null;
  });
  expect(listed).toContainEqual(expect.objectContaining({
    id,
    title: "Renamed Workspace",
    pinned: true,
  }));

  await workspace.deleteSelf();
  workspace[Symbol.dispose]();
  await waitFor("the deleted workspace to disappear from the user's list", async () =>
    (await authenticated.listGadgets()).some(entry => entry.id === id) ? null : true);
});

it.concurrent("persists an ordered human-only chat without starting an agent", async () => {
  using publicApi = connect(requireHarness().url);
  using authenticated = await signUp(publicApi, username());
  using workspace = await authenticated.newGadget();

  const chatId = await workspace.newChat("First message", null);
  await workspace.sendChatMessage(chatId, "Second message", null);

  const history = await workspace.getChatHistory(chatId);
  expect(history.messages.map(message =>
    message.type === "message" ? message.message : message.type)).toEqual([
    "First message",
    "Second message",
  ]);
  const chats = await workspace.listChats();
  expect(chats).toEqual([expect.objectContaining({ id: chatId })]);
  expect(chats[0]?.activeAgent).toBeUndefined();

  await workspace.deleteChat(chatId);
  expect(await workspace.listChats()).toEqual([]);
  await workspace.deleteSelf();
});

it.concurrent("creates, renames, reopens, and removes a Gadget capability", async () => {
  using publicApi = connect(requireHarness().url);
  using authenticated = await signUp(publicApi, username());
  using workspace = await authenticated.newGadget();

  using gadget = await workspace.createGadget("Status", undefined, "STATUS");
  const gadgetId = await gadget.getId();
  expect(await gadget.getTitle()).toBe("Status");

  await gadget.setTitle("Updated Status");
  using reopened = await workspace.getGadget(gadgetId);
  expect(await reopened.getTitle()).toBe("Updated Status");
  await expect(workspace.createGadget("Conflict", undefined, "STATUS"))
    .rejects.toThrow('already a gadget named "STATUS"');

  await gadget.remove();
  await expect(workspace.getGadget(gadgetId)).rejects.toThrow();
  await workspace.deleteSelf();
});
