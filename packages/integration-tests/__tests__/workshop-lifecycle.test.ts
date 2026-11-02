import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  getOpenWorkspaceErrorCode, OPEN_WORKSPACE_ERROR_CODES, type AuthenticatedApi,
} from "@gadgets/workshop-shared/api";
import { settleRestart, type Harness, startHarness } from "../src/harness.js";
import { mockChatCompletion } from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, logIn, nextUsernames, signUp, waitFor } from "../src/rpc-client.js";

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

async function rejectedOpen(
    authenticated: RpcStub<AuthenticatedApi>, workspaceId: string): Promise<unknown> {
  try {
    using _workspace = await authenticated.openWorkspace(workspaceId);
  } catch (error) {
    return error;
  }
  throw new Error("Expected workspace open to fail");
}

it.concurrent("lists workspace metadata after activity and removes it after deletion", async () => {
  const owner = username();
  using publicApi = connect(requireHarness().url);
  using authenticated = await signUp(publicApi, owner);
  using workspace = await authenticated.newWorkspace();
  const { id } = await workspace.getMetadata();
  expect(await authenticated.listWorkspaces()).not.toContainEqual(expect.objectContaining({ id }));

  await workspace.setTitle("Renamed Workspace");
  await authenticated.setWorkspacePinned(id, true);
  await workspace.newChat("Record this without running an agent", null);

  const listed = await waitFor("the active workspace to appear in the user's list", async () => {
    const workspaces = await authenticated.listWorkspaces();
    return workspaces.some(entry => entry.id === id) ? workspaces : null;
  });
  expect(listed).toContainEqual(expect.objectContaining({
    id,
    title: "Renamed Workspace",
    pinned: true,
  }));

  await workspace.deleteSelf();
  // Deleting restarts the workspace DO about 100ms out (Overseer.scheduleAccessRestart), severing
  // the WebSocket of every session that still holds it -- except the deleter's, which has nothing
  // to reopen. `workspace` stays held through the restart, so this session must survive it.
  await settleRestart();
  await waitFor("the deleted workspace to disappear from the user's list", async () =>
    (await authenticated.listWorkspaces()).some(entry => entry.id === id) ? null : true);
});

it.concurrent("persists an ordered human-only chat without starting an agent", async () => {
  using publicApi = connect(requireHarness().url);
  using authenticated = await signUp(publicApi, username());
  using workspace = await authenticated.newWorkspace();

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
  expect((await workspace.getChatHistory(chatId)).messages).toEqual([]);
  await workspace.deleteSelf();
});

it.concurrent("Git blob uploads are reusable, workspace-local, and downloadable only through their chat",
    async () => {
  using publicApi = connect(requireHarness().url);
  using authenticated = await signUp(publicApi, username());
  using ws = await authenticated.newWorkspace();

  const content = new TextEncoder().encode("only chat A");
  const oid = await ws.uploadBlob(content);
  expect(await ws.uploadBlob(content)).toBe(oid);
  const sent = {oid, mimeType: "text/plain", name: "a.txt"};
  const chatA = await ws.newChat("With attachment", null, undefined, [sent]);
  const chatB = await ws.newChat("Without attachment", null);
  const message = (await ws.getChatHistory(chatA)).messages.find(m => m.type === "message");
  if (message?.type !== "message" || !message.attachments?.length) throw new Error("Missing attachment");
  const attachmentId = message.attachments[0].id;

  expect(new TextDecoder().decode(await ws.getChatAttachmentContent(chatA, attachmentId))).toBe("only chat A");
  await expect(ws.getChatAttachmentContent(chatB, attachmentId)).rejects.toThrow("Chat attachment not found.");

  await ws.sendChatMessage(chatB, "Reuse uploaded bytes", null, undefined, [sent]);
  using otherWorkspace = await authenticated.newWorkspace();
  await expect(otherWorkspace.newChat("Unknown blob", null, undefined, [sent]))
    .rejects.toThrow("Unknown Git blob.");
  await otherWorkspace.deleteSelf();

  await ws.deleteSelf();
});

it.concurrent("creates, renames, reopens, and removes a Gadget capability", async () => {
  using publicApi = connect(requireHarness().url);
  using authenticated = await signUp(publicApi, username());
  using workspace = await authenticated.newWorkspace();

  using gadget = await workspace.createGadget("Status", undefined, "STATUS");
  const gadgetId = await gadget.getId();
  expect(await gadget.getTitle()).toBe("Status");

  await gadget.setTitle("Updated Status");
  using reopened = await workspace.getGadget(gadgetId);
  expect(await reopened.getTitle()).toBe("Updated Status");
  await expect(workspace.createGadget("Conflict", undefined, "STATUS"))
    .rejects.toThrow('already a gadget named "STATUS"');

  await gadget.remove();
  await expect(workspace.getGadget(gadgetId)).rejects.toThrow(`No such gadget: ${gadgetId}`);
  await workspace.deleteSelf();
});

it.concurrent("only the owner deletes a workspace, and later opens say why", async () => {
  const [owner, collaborator, stranger] = nextUsernames(
      "deleteowner", "deletecollaborator", "deletestranger");
  if (!owner || !collaborator || !stranger) throw new Error("Failed to allocate test usernames");

  using ownerPublic = connect(requireHarness().url);
  using collaboratorPublic = connect(requireHarness().url);
  using strangerPublic = connect(requireHarness().url);
  using ownerApi = await signUp(ownerPublic, owner);
  using collaboratorApi = await signUp(collaboratorPublic, collaborator);
  using strangerApi = await signUp(strangerPublic, stranger);
  using ownerWorkspace = await ownerApi.newWorkspace();
  const workspaceId = (await ownerWorkspace.getMetadata()).id;
  if (!await ownerWorkspace.addCollaborator(collaborator, "build")) {
    throw new Error(`Failed to share the workspace with ${collaborator}`);
  }
  using collaboratorWorkspace = await collaboratorApi.openWorkspace(workspaceId);

  await expect(collaboratorWorkspace.deleteSelf())
      .rejects.toThrow("Only the workspace owner can delete it.");
  const denied = await rejectedOpen(strangerApi, workspaceId);
  expect(getOpenWorkspaceErrorCode(denied)).toBe(OPEN_WORKSPACE_ERROR_CODES.workspaceAccessDenied);
  expect(Object.prototype.propertyIsEnumerable.call(denied, "code")).toBe(true);
  expect(denied).toMatchObject({ message: "You don't have access to this workspace." });

  collaboratorWorkspace[Symbol.dispose]();
  await ownerWorkspace.deleteSelf();
  ownerWorkspace[Symbol.dispose]();
  await settleRestart();

  using reconnected = connect(requireHarness().url);
  using reopenedCollaborator = await logIn(reconnected, collaborator);
  const missing = await rejectedOpen(reopenedCollaborator, workspaceId);
  expect(getOpenWorkspaceErrorCode(missing)).toBe(OPEN_WORKSPACE_ERROR_CODES.workspaceNotFound);
  expect(Object.prototype.propertyIsEnumerable.call(missing, "code")).toBe(true);
  expect(missing).toMatchObject({ message: "Workspace not found." });
});
