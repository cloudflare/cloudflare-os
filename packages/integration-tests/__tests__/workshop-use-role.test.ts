import { afterAll, beforeAll, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import type {
  ActionLogEntry, ActionsSubscriber, AiChatSubscriber, GadgetClient, Overseer, WorkpieceId,
  WorkpieceSummary, WorkpiecesSubscriber,
} from "@gadgets/workshop-shared/api";
import { diffFiles, type CodeContent } from "@gadgets/workshop-shared/code-change";
import type { TestSession } from "../fixtures/gatekeeper-test/src/test-gatekeeper.js";
import { startTestGatekeeperHarness, TEST_VENDOR_ID, type Harness } from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  connect, listConnectedAccounts, nextUsernames, RpcTarget, signUp, stubFor, waitFor,
} from "../src/rpc-client.js";

let harness: Harness;
const network = new NetworkInterceptor();

beforeAll(async () => {
  network.install();
  harness = await startTestGatekeeperHarness();
});

afterAll(async () => {
  try {
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

class WorkpieceRecorder extends RpcTarget implements WorkpiecesSubscriber {
  readonly summaries = new Map<WorkpieceId, WorkpieceSummary>();
  readonly #loaded = Promise.withResolvers<void>();
  readonly loaded = this.#loaded.promise;
  entry(summary: WorkpieceSummary): void { this.summaries.set(summary.id, summary); }
  removed(id: WorkpieceId): void { this.summaries.delete(id); }
  ready(): void { this.#loaded.resolve(); }
}

class ActionRecorder extends RpcTarget implements ActionsSubscriber {
  readonly entries: ActionLogEntry[] = [];
  readonly #ready = Promise.withResolvers<void>();
  readonly loaded = this.#ready.promise;
  entry(record: ActionLogEntry) { this.entries.push(record); }
  ready() { this.#ready.resolve(); }
}

class ChatSink extends RpcTarget implements AiChatSubscriber {
  streamGeneration() {}
  metadata() {}
  deleted() {}
  message() {}
  changeApplied() {}
  stream() {}
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
const DRAFT_UI = "export default 'draft';\n";
const COMMIT = "0".repeat(40);
const DENIED = "Unauthorized: this collaborator only has permission to use the gadget's UI.";

type Calls<T> = Record<string, (target: T) => unknown>;

/** Each call's outcome by name: "allowed", or the error message it was refused with. */
async function outcomes<T>(calls: Calls<T>, target: T) {
  const names = Object.keys(calls);
  const settled = await Promise.allSettled(names.map(name => calls[name]!(target)));
  return Object.fromEntries(settled.map((result, i) => [names[i]!,
    result.status === "fulfilled" ? "allowed"
      : result.reason instanceof Error ? result.reason.message : String(result.reason)]));
}

const allDenied = (calls: object) =>
  Object.fromEntries(Object.keys(calls).map(name => [name, DENIED]));

// What renders the gadget UI, plus the inert action/console reads. Everything else must be
// classified below, so a new Overseer or GadgetClient method fails to compile until it is.
type UseSurface = "getMetadata" | "subscribeToMetadata" | "subscribeToPresence" |
    "subscribeToWorkpieces" | "getGadget" | "listActions" | "subscribeToActions" |
    "subscribeToConsoleLogs";

const DENIED_OVERSEER: Record<Exclude<keyof Overseer, keyof RpcTarget | UseSurface>,
    (ws: RpcStub<Overseer>) => unknown> = {
  setTitle: ws => ws.setTitle("Title"),
  setPinned: ws => ws.setPinned(true),
  deleteSelf: ws => ws.deleteSelf(),
  createGadget: ws => ws.createGadget("App"),
  listTree: ws => ws.listTree(COMMIT),
  readFilesAtCommit: ws => ws.readFilesAtCommit(COMMIT, ["client.js"]),
  getCommitLog: ws => ws.getCommitLog(COMMIT),
  submitCodeChange: ws => ws.submitCodeChange(1, {
    generation: 0, revision: 0, clientId: "use", seq: 1, change: diffFiles(new Map(), new Map()),
  }),
  getGatekeeperById: ws => ws.getGatekeeperById(1),
  newGatekeeper: ws => ws.newGatekeeper(1, "https://gadgets-test.example/things/use-denied"),
  newAiModelGatekeeper: ws => ws.newAiModelGatekeeper("model"),
  newAgentSpawnerGatekeeper: ws =>
    ws.newAgentSpawnerGatekeeper({ displayName: "Spawner", modelId: null, env: {} }),
  approveAction: ws => ws.approveAction(0),
  rejectAction: ws => ws.rejectAction(0),
  listHooks: ws => ws.listHooks(),
  enableHook: ws => ws.enableHook(0),
  disableHook: ws => ws.disableHook(0),
  deleteHook: ws => ws.deleteHook(0),
  setAutoApprovedActionKind: ws =>
    ws.setAutoApprovedActionKind(1, { tag: "set-value", label: "Set value" }),
  removeAutoApprovedActionKind: ws => ws.removeAutoApprovedActionKind(1, "set-value"),
  listAutoApprovedActionKinds: ws => ws.listAutoApprovedActionKinds(),
  listPreApprovableActions: ws => ws.listPreApprovableActions(),
  acceptConnectionRequest: ws => ws.acceptConnectionRequest("request", { gatekeeperId: 1 }),
  denyConnectionRequest: ws => ws.denyConnectionRequest("request"),
  listChats: ws => ws.listChats(),
  listModels: ws => ws.listModels(),
  getChatHistory: ws => ws.getChatHistory(1),
  getChatMessage: ws => ws.getChatMessage(1, 0),
  subscribeToChat: async ws => {
    using sink = stubFor(new ChatSink());
    return await ws.subscribeToChat(sink);
  },
  listSlashCommands: ws => ws.listSlashCommands(),
  newChat: ws => ws.newChat("Hello", null),
  sendChatMessage: ws => ws.sendChatMessage(1, "Hello", null),
  uploadChatAttachment: ws =>
    ws.uploadChatAttachment({ mimeType: "text/plain", content: new Uint8Array() }, null),
  getChatAttachmentContent: ws => ws.getChatAttachmentContent(1, "attachment"),
  deleteChatAttachment: ws => ws.deleteChatAttachment("attachment"),
  setChatTitle: ws => ws.setChatTitle(1, "Title"),
  mergeChanges: ws => ws.mergeChanges(1),
  updateChatFromMainline: ws => ws.updateChatFromMainline(1),
  revertChanges: ws => ws.revertChanges(1, 0),
  finalizeChatDraft: ws => ws.finalizeChatDraft(1),
  discardChatDraftChanges: ws => ws.discardChatDraftChanges(1),
  deleteChat: ws => ws.deleteChat(1),
  stopAgent: ws => ws.stopAgent(1),
  retryAgent: ws => ws.retryAgent(1, "model"),
  listBlueprints: ws => ws.listBlueprints(),
  updateBlueprint: ws => ws.updateBlueprint("blueprint", { title: "Title" }),
  deleteBlueprint: ws => ws.deleteBlueprint("blueprint"),
  retryBlueprintPublish: ws => ws.retryBlueprintPublish("blueprint"),
  listObserverRequirements: ws => ws.listObserverRequirements("build"),
  listCollaborators: ws => ws.listCollaborators(),
  addCollaborator: ws => ws.addCollaborator("someone", "build"),
  removeCollaborator: ws => ws.removeCollaborator("someone", []),
  previewRemoveCollaborator: ws => ws.previewRemoveCollaborator("someone"),
  createShareLink: ws => ws.createShareLink("build"),
  newShareLinkKey: ws => ws.newShareLinkKey("link"),
  listShareLinks: ws => ws.listShareLinks(),
  updateShareLink: ws => ws.updateShareLink("link"),
  revokeShareLink: ws => ws.revokeShareLink("link", []),
  previewRevokeShareLink: ws => ws.previewRevokeShareLink("link"),
};

const deniedGadget = (chatId: number): Record<
    Exclude<keyof GadgetClient, keyof RpcTarget | "getId" | "getTitle">,
    (gadget: RpcStub<GadgetClient>) => unknown> => ({
  setTitle: g => g.setTitle("Title"),
  remove: g => g.remove(),
  getUiBundle: g => g.getUiBundle(chatId),
  connectToGadget: g => g.connectToGadget(chatId),
  getExportFormats: g => g.getExportFormats(chatId),
  export: g => g.export("format", chatId),
  listBindings: g => g.listBindings(),
  getBinding: g => g.getBinding("DATA"),
  bind: g => g.bind("DATA", 1),
  bindWithSuggestedName: g => g.bindWithSuggestedName(1),
  unbind: g => g.unbind("DATA"),
  renameBinding: g => g.renameBinding("DATA", "OTHER"),
  getBlueprintAnnotation: g => g.getBlueprintAnnotation("DATA"),
  setBlueprintAnnotation: g => g.setBlueprintAnnotation("DATA", { title: "Data", description: "" }),
  createBlueprint: g => g.createBlueprint(),
});

it("a use collaborator reaches only the mainline gadget UI", async () => {
  const [owner, viewer] = nextUsernames("useowner", "useviewer");
  using ownerPublic = connect(harness.url);
  using ownerApi = await signUp(ownerPublic, owner!);
  await ownerApi.provisionAmbientAccount(TEST_VENDOR_ID);
  const account = await waitFor("the test account", async () =>
    (await listConnectedAccounts(ownerApi)).find(a => a.vendorId === TEST_VENDOR_ID) ?? null);
  using ws = await ownerApi.newGadget();
  const workspaceId = (await ws.getMetadata()).id;
  const workpieces = new WorkpieceRecorder();
  using workpiecesStub = stubFor(workpieces);
  using _workpieces = await ws.subscribeToWorkpieces(workpiecesStub);
  await workpieces.loaded;

  using gadget = ws.createGadget("App", undefined, "APP");
  const gadgetId = await gadget.getId();
  const empty = await headOf(workpieces, gadgetId);
  const seed = await ws.newChat("Seed", null);
  await ws.submitCodeChange(seed, {
    generation: 0, revision: 0, clientId: "seed", seq: 1, pins: [{ gadgetId, baseCommit: empty }],
    change: diffFiles(ui(gadgetId), ui(gadgetId, MAINLINE_UI)),
  });
  expect(await ws.mergeChanges(seed)).toEqual({ outcome: "merged" });
  const mainline = await headOf(workpieces, gadgetId, empty);
  const draft = await ws.newChat("Draft", null);
  await ws.submitCodeChange(draft, {
    generation: 0, revision: 0, clientId: "draft", seq: 1,
    pins: [{ gadgetId, baseCommit: mainline }],
    change: diffFiles(ui(gadgetId, MAINLINE_UI), ui(gadgetId, DRAFT_UI)),
  });
  expect(await gadget.getUiBundle(draft)).toEqual({ jsCode: DRAFT_UI });

  // Left unbound, so the viewer's open needs no observer verification.
  using gatekeeper = await ws.newGatekeeper(
      account.id, "https://gadgets-test.example/things/use-role");
  if (!gatekeeper) throw new Error("Failed to create the test connection");
  using session = await gatekeeper.openSession() as RpcStub<TestSession>;
  await session.writeValue(1);
  expect((await ws.listActions()).entries).toHaveLength(1);

  using viewerPublic = connect(harness.url);
  using viewerApi = await signUp(viewerPublic, viewer!);
  if (!await ws.addCollaborator(viewer!, "use")) throw new Error(`Failed to share with ${viewer}`);
  using useWs = await viewerApi.openGadget(workspaceId);
  using useGadget = await useWs.getGadget(gadgetId);

  expect(await outcomes(DENIED_OVERSEER, useWs)).toEqual(allDenied(DENIED_OVERSEER));
  const gadgetCalls = deniedGadget(draft);
  expect(await outcomes(gadgetCalls, useGadget)).toEqual(allDenied(gadgetCalls));
  expect(await useGadget.getUiBundle()).toEqual({ jsCode: MAINLINE_UI });

  expect(await useWs.listActions()).toEqual({ entries: [] });
  expect(await useWs.listActions({ filter: "pending" })).toEqual({ entries: [] });
  const actions = new ActionRecorder();
  using actionsStub = stubFor(actions);
  using _actions = await useWs.subscribeToActions(actionsStub, new Date(0));
  await actions.loaded;
  await session.writeValue(2);
  // Anything the write delivered to the viewer's connection arrives before this reply.
  await useWs.getMetadata();
  expect(actions.entries).toEqual([]);
});
