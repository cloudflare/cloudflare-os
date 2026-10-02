import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  getOpenGadgetErrorCode, OPEN_GADGET_ERROR_CODES, type AffectedCollaborator,
  type AuthenticatedApi, type Overseer, type UiBundle, type WorkpieceId,
} from "@gadgets/workshop-shared/api";
import { diffFiles, type CodeContent } from "@gadgets/workshop-shared/code-change";
import { settleRestart, type Harness, startHarness } from "../src/harness.js";
import { mockChatCompletion } from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  connect, logIn, nextUsernames, signUp, stubFor, waitFor, WorkpieceRecorder,
} from "../src/rpc-client.js";

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

const headOf = (workpieces: WorkpieceRecorder, gadgetId: WorkpieceId, after?: string) =>
  waitFor(`a new head for gadget ${gadgetId}`, async () => {
    const summary = workpieces.summaries.get(gadgetId);
    return summary?.type === "gadget" && summary.commitId !== undefined &&
        summary.commitId !== after ? summary.commitId : null;
  });

const ui = (gadgetId: WorkpieceId, text?: string): CodeContent =>
  new Map([[gadgetId, new Map(text === undefined ? [] : [["client.js", text]])]]);

const MAINLINE_UI = "export default 'mainline';\n";
const USE_ONLY = "Unauthorized: this collaborator only has permission to use the gadget's UI.";

const affectedRoles = (affected: AffectedCollaborator[]) => affected
    .map(({ profile, oldRole, newRole }) => ({ id: profile.id, oldRole, newRole }))
    .toSorted((a, b) => a.id.localeCompare(b.id));

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
    await expect(collaboratorWorkspace.setTitle("Forbidden rename")).rejects.toThrow(USE_ONLY);
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

it.concurrent("a collaborator's Outputs page follows their access", async () => {
  const [ownerName, collaboratorName] = usernames("outputsowner", "outputscollaborator");
  if (!ownerName || !collaboratorName) throw new Error("Missing test username");

  // Released before the revocation restart lands; `using` covers early failures.
  using setup = new DisposableStack();
  const owner = setup.use(await signUp(setup.use(connect(requireHarness().url)), ownerName));
  const collaborator = setup.use(
      await signUp(setup.use(connect(requireHarness().url)), collaboratorName));
  const formats = await waitFor("bundled output formats to install", async () => {
    const offers = await owner.listOutputFormats();
    return offers.length > 0 ? offers : null;
  });
  const document = formats.find(format => format.output.id === "document");
  if (document === undefined) throw new Error("Document output format is not installed");
  const workspace = setup.use(await owner.newGadgetFromBlueprint(document.blueprintId, {}));
  const { id: workspaceId, defaultGadgetId } = await workspace.getMetadata();
  if (defaultGadgetId === undefined) throw new Error("Output workspace has no default Gadget");

  const added = await workspace.addCollaborator(collaboratorName, "build");
  if (added === null) throw new Error("Collaborator was not added");
  setup.use(await collaborator.openGadget(workspaceId));

  const shared = await waitFor("the shared document in the collaborator's outputs", async () =>
    (await collaborator.listOutputs()).outputs.find(output =>
      output.workspaceId === workspaceId && output.workpieceId === defaultGadgetId) ?? null);
  expect(shared.output).toMatchObject({ id: "document" });

  await workspace.removeCollaborator(added.profile.id, []);
  setup.dispose();

  await waitFor("the revoked document to leave the collaborator's outputs", async () => {
    try {
      const { outputs } = await withAuthenticated(collaboratorName, authenticated =>
        authenticated.listOutputs());
      return outputs.some(output => output.workspaceId === workspaceId) ? null : true;
    } catch {
      return null;
    }
  });
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

it.concurrent("removing a sharer keeps or drops the people they shared with", async () => {
  const [ownerName, bobName, carolName] = usernames("chainowner", "chainbob", "chaincarol");
  for (const username of [ownerName, bobName, carolName]) {
    using publicApi = connect(requireHarness().url);
    using _authenticated = await signUp(publicApi, username!);
  }

  const prepareWorkspace = async () => {
    using stack = new DisposableStack();
    const ownerPublic = stack.use(connect(requireHarness().url));
    const owner = stack.use(await logIn(ownerPublic, ownerName!));
    const workspace = stack.use(await owner.newGadget());
    const workspaceId = await activate(workspace);
    const bobInfo = await workspace.addCollaborator(bobName!, "build");
    if (bobInfo === null) throw new Error(`Failed to share with ${bobName}`);
    using bobPublic = connect(requireHarness().url);
    using bob = await logIn(bobPublic, bobName!);
    using bobWorkspace = await bob.openGadget(workspaceId);
    const carolInfo = await bobWorkspace.addCollaborator(carolName!, "build");
    if (carolInfo === null) throw new Error(`Failed to share with ${carolName}`);
    const resources = stack.move();
    return {
      workspace,
      workspaceId,
      bobId: bobInfo.profile.id,
      carolId: carolInfo.profile.id,
      [Symbol.dispose]: () => resources.dispose(),
    };
  };

  using kept = await prepareWorkspace();
  using dropped = await prepareWorkspace();

  const keptAffected = await kept.workspace.removeCollaborator(kept.bobId, [kept.carolId]);
  expect(keptAffected).toContainEqual(expect.objectContaining({
    profile: expect.objectContaining({ id: kept.bobId }),
    oldRole: "build",
    newRole: null,
  }));
  expect(keptAffected.map(({ profile }) => profile.id)).not.toContain(kept.carolId);
  await settleRestart();

  using keptCarolPublic = connect(requireHarness().url);
  using keptCarol = await logIn(keptCarolPublic, carolName!);
  using keptCarolWorkspace = await keptCarol.openGadget(kept.workspaceId);
  expect(await keptCarolWorkspace.getMetadata()).toMatchObject({ role: "build" });

  const preview = affectedRoles(
      await dropped.workspace.previewRemoveCollaborator(dropped.bobId));
  const droppedAffected = await dropped.workspace.removeCollaborator(dropped.bobId, []);
  await settleRestart();

  expect(affectedRoles(droppedAffected)).toEqual(preview);
  expect(affectedRoles(droppedAffected)).toContainEqual({
    id: dropped.carolId,
    oldRole: "build",
    newRole: null,
  });
  using droppedCarolPublic = connect(requireHarness().url);
  using droppedCarol = await logIn(droppedCarolPublic, carolName!);
  await expectOpenDenied(droppedCarol, dropped.workspaceId);
});

it.concurrent("losing a build path falls back to the owner's direct use grant", async () => {
  const [ownerName, bobName, carolName] = usernames("fallbackowner", "fallbackbob", "fallbackcarol");
  using ownerPublic = connect(requireHarness().url);
  using bobPublic = connect(requireHarness().url);
  using carolPublic = connect(requireHarness().url);
  using owner = await signUp(ownerPublic, ownerName!);
  using bob = await signUp(bobPublic, bobName!);
  using carol = await signUp(carolPublic, carolName!);
  using workspace = await owner.newGadget();
  const workspaceId = (await workspace.getMetadata()).id;

  let gadgetId: WorkpieceId;
  let ownerBundle: UiBundle | null;
  {
    const workpieces = new WorkpieceRecorder();
    using workpiecesStub = stubFor(workpieces);
    using _workpieces = await workspace.subscribeToWorkpieces(workpiecesStub);
    await workpieces.loaded;

    using gadget = workspace.createGadget("App", undefined, "APP");
    gadgetId = await gadget.getId();
    const empty = await headOf(workpieces, gadgetId);
    const seed = await workspace.newChat("Seed", null);
    await workspace.submitCodeChange(seed, {
      generation: 0,
      revision: 0,
      clientId: "seed",
      seq: 1,
      pins: [{ gadgetId, baseCommit: empty }],
      change: diffFiles(ui(gadgetId), ui(gadgetId, MAINLINE_UI)),
    });
    expect(await workspace.mergeChanges(seed)).toEqual({ outcome: "merged" });
    await headOf(workpieces, gadgetId, empty);
    ownerBundle = await gadget.getUiBundle();
    expect(ownerBundle).toEqual({ jsCode: MAINLINE_UI });
  }

  const bobInfo = await workspace.addCollaborator(bobName!, "build");
  if (bobInfo === null) throw new Error(`Failed to share with ${bobName}`);
  {
    using bobWorkspace = await bob.openGadget(workspaceId);
    const carolInfo = await bobWorkspace.addCollaborator(carolName!, "build");
    if (carolInfo === null) throw new Error(`Failed to share with ${carolName}`);
  }
  if (!await workspace.addCollaborator(carolName!, "use")) {
    throw new Error(`Failed to add ${carolName}'s direct use grant`);
  }
  {
    using carolWorkspace = await carol.openGadget(workspaceId);
    expect(await carolWorkspace.getMetadata()).toMatchObject({ role: "build" });
  }

  const affected = await workspace.removeCollaborator(bobInfo.profile.id, []);
  expect(affectedRoles(affected)).toContainEqual({
    id: carolName!,
    oldRole: "build",
    newRole: "use",
  });
  await settleRestart();

  using freshCarolPublic = connect(requireHarness().url);
  using freshCarol = await logIn(freshCarolPublic, carolName!);
  using freshWorkspace = await freshCarol.openGadget(workspaceId);
  expect(await freshWorkspace.getMetadata()).toMatchObject({ role: "use" });
  await expect(freshWorkspace.setTitle("x")).rejects.toThrow(USE_ONLY);
  await expect(freshWorkspace.newChat("hi", null)).rejects.toThrow(USE_ONLY);
  using freshGadget = await freshWorkspace.getGadget(gadgetId);
  expect(await freshGadget.getUiBundle()).toEqual(ownerBundle);
});
