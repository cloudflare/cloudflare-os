import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  getOpenGadgetErrorCode, OPEN_GADGET_ERROR_CODES, type AuthenticatedApi, type Overseer,
} from "@gadgets/workshop-shared/api";
import { type Harness, startHarness } from "../src/harness.js";
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

async function withAuthenticated<T>(
    username: string, body: (authenticated: RpcStub<AuthenticatedApi>) => Promise<T>): Promise<T> {
  using publicApi = connect(requireHarness().url);
  using authenticated = await logIn(publicApi, username);
  const result = await body(authenticated);
  return result;
}

async function activate(workspace: RpcStub<Overseer>): Promise<string> {
  const { id } = await workspace.getMetadata();
  await workspace.newChat("Make this workspace visible without an agent", null);
  return id;
}

async function expectOpenDeniedAfterRestart(
    username: string, workspaceId: string, shareKey?: string): Promise<void> {
  const result = await waitFor("revoked workspace access after restart", async () => {
    try {
      return await withAuthenticated(username, async authenticated => {
        try {
          using _workspace = await authenticated.openGadget(workspaceId, shareKey);
        } catch (error) {
          return getOpenGadgetErrorCode(error) === OPEN_GADGET_ERROR_CODES.workspaceAccessDenied
            ? { denied: true }
            : null;
        }
        return { denied: false };
      });
    } catch {
      return null;
    }
  });
  expect(result.denied).toBe(true);
}

async function listShareLinksAfterRestart(username: string, workspaceId: string) {
  return waitFor("owner workspace after revocation restart", async () => {
    try {
      return await withAuthenticated(username, async authenticated => {
        using workspace = await authenticated.openGadget(workspaceId);
        return workspace.listShareLinks();
      });
    } catch {
      return null;
    }
  });
}

it.concurrent("grants and revokes a use-only collaborator", async () => {
  const [ownerName, collaboratorName, intruderName] = usernames(
      "owner", "collaborator", "intruder");
  if (!ownerName || !collaboratorName || !intruderName) throw new Error("Missing test username");

  const { workspaceId, affected } = await (async () => {
    using ownerPublic = connect(requireHarness().url);
    using collaboratorPublic = connect(requireHarness().url);
    using intruderPublic = connect(requireHarness().url);
    using owner = await signUp(ownerPublic, ownerName);
    using collaborator = await signUp(collaboratorPublic, collaboratorName);
    using intruder = await signUp(intruderPublic, intruderName);
    using workspace = await owner.newGadget();
    const id = await activate(workspace);

    await expectOpenDenied(intruder, id);

    const added = await workspace.addCollaborator(collaboratorName, "use", "reviewer");
    expect(added).toMatchObject({
      profile: { id: collaboratorName },
      role: "use",
    });
    if (added === null) throw new Error("Collaborator was not added");

    using collaboratorWorkspace = await collaborator.openGadget(id);
    expect(await collaboratorWorkspace.getMetadata()).toMatchObject({
      id,
      role: "use",
    });
    await expect(collaboratorWorkspace.setTitle("Forbidden rename")).rejects.toThrow();
    return {
      workspaceId: id,
      affected: await workspace.removeCollaborator(added.profile.id, []),
    };
  })();

  expect(affected).toContainEqual(expect.objectContaining({
    profile: expect.objectContaining({ id: collaboratorName }),
    oldRole: "use",
    newRole: null,
  }));
  await expectOpenDeniedAfterRestart(collaboratorName, workspaceId);
});

it.concurrent("revokes every key and recipient of one share link", async () => {
  const [ownerName, firstName, secondName] = usernames("linkowner", "first", "second");
  if (!ownerName || !firstName || !secondName) throw new Error("Missing test username");

  const { workspaceId, link, copied, affected } = await (async () => {
    using ownerPublic = connect(requireHarness().url);
    using firstPublic = connect(requireHarness().url);
    using secondPublic = connect(requireHarness().url);
    using owner = await signUp(ownerPublic, ownerName);
    using first = await signUp(firstPublic, firstName);
    using second = await signUp(secondPublic, secondName);
    using workspace = await owner.newGadget();
    const id = await activate(workspace);

    const shareLink = await workspace.createShareLink("use", "review link");
    const copiedKey = await workspace.newShareLinkKey(shareLink.linkId);
    expect(await workspace.listShareLinks()).toContainEqual(expect.objectContaining({
      linkId: shareLink.linkId,
      note: "review link",
      role: "use",
    }));

    using firstWorkspace = await first.openGadget(id, shareLink.key);
    using secondWorkspace = await second.openGadget(id, copiedKey.key);
    expect(await firstWorkspace.getMetadata()).toMatchObject({ role: "use" });
    expect(await secondWorkspace.getMetadata()).toMatchObject({ role: "use" });
    const preview = await workspace.previewRevokeShareLink(shareLink.linkId);
    expect(preview.map(user => user.profile.id).toSorted()).toEqual([firstName, secondName].toSorted());
    return {
      workspaceId: id,
      link: shareLink,
      copied: copiedKey,
      affected: await workspace.revokeShareLink(shareLink.linkId, []),
    };
  })();

  expect(affected.map(user => user.profile.id).toSorted()).toEqual([firstName, secondName].toSorted());
  await Promise.all([
    expectOpenDeniedAfterRestart(firstName, workspaceId, link.key),
    expectOpenDeniedAfterRestart(secondName, workspaceId, copied.key),
  ]);
  expect(await listShareLinksAfterRestart(ownerName, workspaceId)).toEqual([]);
});
