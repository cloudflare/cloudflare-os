import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  getOpenWorkspaceErrorCode, OPEN_WORKSPACE_ERROR_CODES, type AffectedCollaborator,
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
    using _workspace = await authenticated.openWorkspace(workspaceId, shareKey);
  } catch (error) {
    denied = error;
  }
  if (denied === undefined) throw new Error("Expected workspace open to fail");
  expect(getOpenWorkspaceErrorCode(denied)).toBe(OPEN_WORKSPACE_ERROR_CODES.workspaceAccessDenied);
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

const affectedAccess = (affected: AffectedCollaborator[]) => affected
    .map(({ profile, oldAccess, newAccess }) => ({ id: profile.id, oldAccess, newAccess }))
    .toSorted((a, b) => a.id.localeCompare(b.id));

const gadgetAccess = (...gadgetIds: WorkpieceId[]) =>
  ({ role: "use", gadgetIds: gadgetIds.toSorted((a, b) => a - b) });

async function expectOpenDeniedAfterRestart(
    username: string, workspaceId: string, shareKey?: string): Promise<void> {
  const result = await waitFor("revoked workspace access after restart", async () => {
    try {
      return await withAuthenticated(username, async authenticated => {
        try {
          using _workspace = await authenticated.openWorkspace(workspaceId, shareKey);
        } catch (error) {
          return getOpenWorkspaceErrorCode(error) === OPEN_WORKSPACE_ERROR_CODES.workspaceAccessDenied
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
        using workspace = await authenticated.openWorkspace(workspaceId);
        return workspace.listShareLinks();
      });
    } catch {
      return null;
    }
  });
}

it.concurrent("grants and revokes a collaborator's access to one gadget", async () => {
  const [ownerName, collaboratorName, intruderName] = usernames(
      "owner", "collaborator", "intruder");
  if (!ownerName || !collaboratorName || !intruderName) throw new Error("Missing test username");

  const { workspaceId, sharedId, affected } = await (async () => {
    using ownerPublic = connect(requireHarness().url);
    using collaboratorPublic = connect(requireHarness().url);
    using intruderPublic = connect(requireHarness().url);
    using owner = await signUp(ownerPublic, ownerName);
    using collaborator = await signUp(collaboratorPublic, collaboratorName);
    using intruder = await signUp(intruderPublic, intruderName);
    using workspace = await owner.newWorkspace();
    const id = await activate(workspace);
    using gadget = await workspace.createGadget("App", undefined, "APP");
    const gadgetId = await gadget.getId();

    await expectOpenDenied(intruder, id);

    const added = await workspace.addCollaborator(collaboratorName, { gadgetId }, "reviewer");
    expect(added).toMatchObject({
      profile: { id: collaboratorName },
      access: gadgetAccess(gadgetId),
    });
    if (added === null) throw new Error("Collaborator was not added");

    using collaboratorWorkspace = await collaborator.openWorkspace(id);
    expect(await collaboratorWorkspace.getMetadata()).toMatchObject({
      id,
      role: "use",
    });
    await expect(collaboratorWorkspace.setTitle("Forbidden rename")).rejects.toThrow(USE_ONLY);
    using _shared = await collaboratorWorkspace.getGadget(gadgetId);
    return {
      workspaceId: id,
      sharedId: gadgetId,
      affected: await workspace.removeCollaborator(added.profile.id, []),
    };
  })();

  expect(affectedAccess(affected)).toEqual([
    { id: collaboratorName, oldAccess: gadgetAccess(sharedId), newAccess: null },
  ]);
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
  const workspace = setup.use(await owner.newWorkspaceFromBlueprint(document.blueprintId, {}));
  const { id: workspaceId, defaultGadgetId } = await workspace.getMetadata();
  if (defaultGadgetId === undefined) throw new Error("Output workspace has no default Gadget");

  const added = await workspace.addCollaborator(collaboratorName, "build");
  if (added === null) throw new Error("Collaborator was not added");
  setup.use(await collaborator.openWorkspace(workspaceId));

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

it.concurrent("revoking one gadget removes only it from the collaborator's Outputs and workspace",
    async () => {
  const [ownerName, collaboratorName] = usernames("gadgetoutputsowner", "gadgetoutputsviewer");
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
  const workspace = setup.use(await owner.newWorkspaceFromBlueprint(document.blueprintId, {}));
  const { id: workspaceId, defaultGadgetId } = await workspace.getMetadata();
  if (defaultGadgetId === undefined) throw new Error("Output workspace has no default Gadget");
  const otherId = await setup.use(await workspace.createGadget("Other", undefined, "OTHER")).getId();

  const added = await workspace.addCollaborator(collaboratorName, { gadgetId: defaultGadgetId });
  if (added === null) throw new Error("Collaborator was not added");
  expect(await workspace.addCollaborator(collaboratorName, { gadgetId: otherId }))
      .toMatchObject({ access: gadgetAccess(defaultGadgetId, otherId) });
  setup.use(await collaborator.openWorkspace(workspaceId));

  // The index lists every gadget the collaborator holds, whether or not it presents an output.
  const listed = (outputs: { workspaceId: string, workpieceId: WorkpieceId }[]) => outputs
      .filter(output => output.workspaceId === workspaceId)
      .map(output => output.workpieceId)
      .toSorted((a, b) => a - b);
  const shared = await waitFor("the shared document in the collaborator's outputs", async () => {
    const { outputs } = await collaborator.listOutputs();
    return listed(outputs).length === 2 ? outputs : null;
  });
  expect(listed(shared)).toEqual([defaultGadgetId, otherId].toSorted((a, b) => a - b));
  expect(shared.find(output => output.workpieceId === defaultGadgetId)?.output)
      .toMatchObject({ id: "document" });

  const affected = await workspace.removeCollaborator(added.profile.id, [], defaultGadgetId);
  expect(affectedAccess(affected)).toEqual([{
    id: collaboratorName,
    oldAccess: gadgetAccess(defaultGadgetId, otherId),
    newAccess: gadgetAccess(otherId),
  }]);
  setup.dispose();

  const remaining = await waitFor("the revoked document to leave the collaborator's outputs",
      async () => {
    try {
      const { outputs } = await withAuthenticated(collaboratorName, authenticated =>
        authenticated.listOutputs());
      return listed(outputs).includes(defaultGadgetId) ? null : listed(outputs);
    } catch {
      return null;
    }
  });
  expect(remaining).toEqual([otherId]);
  // The workspace restarted for the narrowing; the gadget they kept is still theirs.
  const reopened = await waitFor("the narrowed collaborator to reopen the workspace", async () => {
    try {
      return await withAuthenticated(collaboratorName, async authenticated => {
        using reopenedWorkspace = await authenticated.openWorkspace(workspaceId);
        using _other = await reopenedWorkspace.getGadget(otherId);
        return {
          role: (await reopenedWorkspace.getMetadata()).role,
          revoked: await reopenedWorkspace.getGadget(defaultGadgetId)
              .then(() => null, (error: unknown) => (error as Error).message),
        };
      });
    } catch {
      return null;
    }
  });
  expect(reopened).toEqual({ role: "use", revoked: `No such gadget: ${defaultGadgetId}` });
});

it.concurrent("revokes every key and recipient of one gadget's share link", async () => {
  const [ownerName, firstName, secondName] = usernames("linkowner", "first", "second");
  if (!ownerName || !firstName || !secondName) throw new Error("Missing test username");

  const { workspaceId, link, copied, affected } = await (async () => {
    using ownerPublic = connect(requireHarness().url);
    using firstPublic = connect(requireHarness().url);
    using secondPublic = connect(requireHarness().url);
    using owner = await signUp(ownerPublic, ownerName);
    using first = await signUp(firstPublic, firstName);
    using second = await signUp(secondPublic, secondName);
    using workspace = await owner.newWorkspace();
    const id = await activate(workspace);
    using shared = await workspace.createGadget("Shared", undefined, "SHARED");
    using unshared = await workspace.createGadget("Unshared", undefined, "UNSHARED");
    const gadgetId = await shared.getId();
    const unsharedId = await unshared.getId();

    const shareLink = await workspace.createShareLink({ gadgetId }, "review link");
    const copiedKey = await workspace.newShareLinkKey(shareLink.linkId);
    expect(await workspace.listShareLinks()).toContainEqual(expect.objectContaining({
      linkId: shareLink.linkId,
      note: "review link",
      role: "use",
      gadgetId,
    }));

    using firstWorkspace = await first.openWorkspace(id, shareLink.key);
    using secondWorkspace = await second.openWorkspace(id, copiedKey.key);
    expect(await firstWorkspace.getMetadata()).toMatchObject({ role: "use" });
    expect(await secondWorkspace.getMetadata()).toMatchObject({ role: "use" });
    // Redeeming the link grants its one gadget and nothing else in the workspace.
    using _firstShared = await firstWorkspace.getGadget(gadgetId);
    await expect(secondWorkspace.getGadget(unsharedId))
        .rejects.toThrow(`No such gadget: ${unsharedId}`);
    expect(affectedAccess(await workspace.previewRevokeShareLink(shareLink.linkId))).toEqual(
        [firstName, secondName].toSorted().map(name =>
          ({ id: name, oldAccess: gadgetAccess(gadgetId), newAccess: null })));
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
    const workspace = stack.use(await owner.newWorkspace());
    const workspaceId = await activate(workspace);
    const bobInfo = await workspace.addCollaborator(bobName!, "build");
    if (bobInfo === null) throw new Error(`Failed to share with ${bobName}`);
    using bobPublic = connect(requireHarness().url);
    using bob = await logIn(bobPublic, bobName!);
    using bobWorkspace = await bob.openWorkspace(workspaceId);
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
    oldAccess: { role: "build" },
    newAccess: null,
  }));
  expect(keptAffected.map(({ profile }) => profile.id)).not.toContain(kept.carolId);
  await settleRestart();

  using keptCarolPublic = connect(requireHarness().url);
  using keptCarol = await logIn(keptCarolPublic, carolName!);
  using keptCarolWorkspace = await keptCarol.openWorkspace(kept.workspaceId);
  expect(await keptCarolWorkspace.getMetadata()).toMatchObject({ role: "build" });

  const preview = affectedAccess(
      await dropped.workspace.previewRemoveCollaborator(dropped.bobId));
  const droppedAffected = await dropped.workspace.removeCollaborator(dropped.bobId, []);
  await settleRestart();

  expect(affectedAccess(droppedAffected)).toEqual(preview);
  expect(affectedAccess(droppedAffected)).toContainEqual({
    id: dropped.carolId,
    oldAccess: { role: "build" },
    newAccess: null,
  });
  using droppedCarolPublic = connect(requireHarness().url);
  using droppedCarol = await logIn(droppedCarolPublic, carolName!);
  await expectOpenDenied(droppedCarol, dropped.workspaceId);
});

it.concurrent("losing a build path falls back to the owner's direct gadget grant", async () => {
  const [ownerName, bobName, carolName] = usernames("fallbackowner", "fallbackbob", "fallbackcarol");
  using ownerPublic = connect(requireHarness().url);
  using bobPublic = connect(requireHarness().url);
  using carolPublic = connect(requireHarness().url);
  using owner = await signUp(ownerPublic, ownerName!);
  using bob = await signUp(bobPublic, bobName!);
  using carol = await signUp(carolPublic, carolName!);
  using workspace = await owner.newWorkspace();
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
    using bobWorkspace = await bob.openWorkspace(workspaceId);
    const carolInfo = await bobWorkspace.addCollaborator(carolName!, "build");
    if (carolInfo === null) throw new Error(`Failed to share with ${carolName}`);
  }
  if (!await workspace.addCollaborator(carolName!, { gadgetId })) {
    throw new Error(`Failed to add ${carolName}'s direct gadget grant`);
  }
  {
    using carolWorkspace = await carol.openWorkspace(workspaceId);
    expect(await carolWorkspace.getMetadata()).toMatchObject({ role: "build" });
  }

  const affected = await workspace.removeCollaborator(bobInfo.profile.id, []);
  expect(affectedAccess(affected)).toContainEqual({
    id: carolName!,
    oldAccess: { role: "build" },
    newAccess: gadgetAccess(gadgetId),
  });
  await settleRestart();

  using freshCarolPublic = connect(requireHarness().url);
  using freshCarol = await logIn(freshCarolPublic, carolName!);
  using freshWorkspace = await freshCarol.openWorkspace(workspaceId);
  expect(await freshWorkspace.getMetadata()).toMatchObject({ role: "use" });
  await expect(freshWorkspace.setTitle("x")).rejects.toThrow(USE_ONLY);
  await expect(freshWorkspace.newChat("hi", null)).rejects.toThrow(USE_ONLY);
  using freshGadget = await freshWorkspace.getGadget(gadgetId);
  expect(await freshGadget.getUiBundle()).toEqual(ownerBundle);
});
