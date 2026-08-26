import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  getOpenGadgetErrorCode, OPEN_GADGET_ERROR_CODES, type AuthenticatedApi, type Overseer,
} from "@gadgets/workshop-shared/api";
import { type Harness, startHarness } from "../src/harness.js";
import { mockChatCompletion } from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, nextUsernames, signUp } from "../src/rpc-client.js";

let harness: Harness | undefined;
const network = new NetworkInterceptor([mockChatCompletion("Test chat")]);

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

function usernames(...prefixes: string[]): string[] {
  const values = nextUsernames(...prefixes);
  if (values.length !== prefixes.length) throw new Error("Failed to allocate test usernames");
  return values;
}

async function expectOpenDenied(
    authenticated: RpcStub<AuthenticatedApi>, workspaceId: string, shareKey?: string): Promise<void> {
  let denied: unknown;
  try {
    using _workspace = await authenticated.openGadget(workspaceId, shareKey);
  } catch (error) {
    denied = error;
  }
  if (denied === undefined) throw new Error("Expected workspace open to fail");
  expect(getOpenGadgetErrorCode(denied)).toBe(OPEN_GADGET_ERROR_CODES.workspaceAccessDenied);
}

async function activate(workspace: RpcStub<Overseer>): Promise<string> {
  const { id } = await workspace.getMetadata();
  await workspace.newChat("Make this workspace visible without an agent", null);
  return id;
}

it.concurrent("grants and revokes a use-only collaborator", async () => {
  const [ownerName, collaboratorName, intruderName] = usernames(
      "owner", "collaborator", "intruder");
  if (!ownerName || !collaboratorName || !intruderName) throw new Error("Missing test username");

  using ownerPublic = connect(requireHarness().url);
  using collaboratorPublic = connect(requireHarness().url);
  using intruderPublic = connect(requireHarness().url);
  using owner = await signUp(ownerPublic, ownerName);
  using collaborator = await signUp(collaboratorPublic, collaboratorName);
  using intruder = await signUp(intruderPublic, intruderName);
  using workspace = await owner.newGadget();
  const workspaceId = await activate(workspace);

  await expectOpenDenied(intruder, workspaceId);

  const added = await workspace.addCollaborator(collaboratorName, "use", "reviewer");
  expect(added).toMatchObject({
    profile: { id: collaboratorName },
    role: "use",
  });
  if (added === null) throw new Error("Collaborator was not added");

  using collaboratorWorkspace = await collaborator.openGadget(workspaceId);
  expect(await collaboratorWorkspace.getMetadata()).toMatchObject({
    id: workspaceId,
    role: "use",
  });
  await expect(collaboratorWorkspace.setTitle("Forbidden rename")).rejects.toThrow();

  const affected = await workspace.removeCollaborator(added.profile.id, []);
  expect(affected).toContainEqual(expect.objectContaining({
    profile: expect.objectContaining({ id: collaboratorName }),
    oldRole: "use",
    newRole: null,
  }));
  await expectOpenDenied(collaborator, workspaceId);
  await workspace.deleteSelf();
});

it.concurrent("revokes every key and recipient of one share link", async () => {
  const [ownerName, firstName, secondName] = usernames("linkowner", "first", "second");
  if (!ownerName || !firstName || !secondName) throw new Error("Missing test username");

  using ownerPublic = connect(requireHarness().url);
  using firstPublic = connect(requireHarness().url);
  using secondPublic = connect(requireHarness().url);
  using owner = await signUp(ownerPublic, ownerName);
  using first = await signUp(firstPublic, firstName);
  using second = await signUp(secondPublic, secondName);
  using workspace = await owner.newGadget();
  const workspaceId = await activate(workspace);

  const link = await workspace.createShareLink("use", "review link");
  const copied = await workspace.newShareLinkKey(link.linkId);
  expect(await workspace.listShareLinks()).toContainEqual(expect.objectContaining({
    linkId: link.linkId,
    note: "review link",
    role: "use",
  }));

  using firstWorkspace = await first.openGadget(workspaceId, link.key);
  using secondWorkspace = await second.openGadget(workspaceId, copied.key);
  expect(await firstWorkspace.getMetadata()).toMatchObject({ role: "use" });
  expect(await secondWorkspace.getMetadata()).toMatchObject({ role: "use" });

  const preview = await workspace.previewRevokeShareLink(link.linkId);
  expect(preview.map(user => user.profile.id).toSorted()).toEqual([firstName, secondName].toSorted());
  const affected = await workspace.revokeShareLink(link.linkId, []);
  expect(affected.map(user => user.profile.id).toSorted()).toEqual([firstName, secondName].toSorted());
  expect(await workspace.listShareLinks()).toEqual([]);

  await expectOpenDenied(first, workspaceId, link.key);
  await expectOpenDenied(second, workspaceId, copied.key);
  await workspace.deleteSelf();
});
