import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import { z } from "zod";
import type {
  AiChatMetadata, AiChatSubscriber, ChatGadgetPinRecord, GadgetClient, Overseer, PublicApi,
  TreeNode, WorkpieceId,
} from "@gadgets/workshop-shared/api";
import { diffFiles, type CodeContent } from "@gadgets/workshop-shared/code-change";
import {
  buildSnapshotContent, serializeArchive,
} from "../../bundled-blueprints/__tests__/archives.js";
import type { TestSession } from "../fixtures/gatekeeper-test/src/test-gatekeeper.js";
import { loadAllChatHistory } from "../src/agent-session.js";
import {
  bundleBlueprints, startHarness, startTestGatekeeperHarness, TEST_VENDOR_ID, testActionState,
  type Harness,
} from "../src/harness.js";
import {
  scriptedModelRouter, SCRIPTED_MODEL_ID, type ChatCompletionStep,
} from "../src/mock-model.js";
import { NetworkInterceptor, type Handler } from "../src/network-interceptor.js";
import {
  accountLabel, connect, listConnectedAccounts, logIn, nextUsernames, RpcTarget, signUp, stubFor,
  waitFor, waitForIdleChat, WorkpieceRecorder,
} from "../src/rpc-client.js";

let harness: Harness | undefined;
const models = scriptedModelRouter();
// Workers AI /run responses for the classifier test's account, served in order.
const CLASSIFIER_ACCOUNT = "classifier-account";
const classifierResponses: Response[] = [];
const classifierHandler: Handler = (url, method) =>
  method === "POST" && url.pathname === `/client/v4/accounts/${CLASSIFIER_ACCOUNT}/ai/run`
    ? classifierResponses.shift() ?? null : null;
const network = new NetworkInterceptor({ handlers: [models.handler, classifierHandler] });

beforeAll(async () => {
  network.install();
  harness = await startTestGatekeeperHarness({ enableGadgetExecution: true });
});

afterAll(async () => {
  try {
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
    await harness?.server.close();
  }
});

function requireHarness(): Harness {
  if (harness === undefined) throw new Error("Workshop harness did not start");
  return harness;
}

function username(prefix: string): string {
  const value = nextUsernames(prefix).at(0);
  if (value === undefined) throw new Error("Failed to allocate a test username");
  return value;
}

function treePaths(nodes: TreeNode[], prefix = ""): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    const path = prefix ? `${prefix}/${node.name}` : node.name;
    if (node.kind === "dir") {
      paths.push(...treePaths(node.children, path));
    } else {
      paths.push(path);
    }
  }
  return paths;
}

const files = (gadgetId: number, path: string, text?: string): CodeContent =>
  new Map([[gadgetId, new Map(text === undefined ? [] : [[path, text]])]]);

const edit = (gadgetId: number, path: string, before: string | undefined, after: string) =>
  diffFiles(files(gadgetId, path, before), files(gadgetId, path, after));

const headOf = (workpieces: WorkpieceRecorder, gadgetId: WorkpieceId, after?: string) =>
  waitFor(`a new head for gadget ${gadgetId}`, async () => {
    const summary = workpieces.summaries.get(gadgetId);
    return summary?.type === "gadget" && summary.commitId !== undefined &&
        summary.commitId !== after ? summary.commitId : null;
  });

const CSV_EXPORT_SERVER =
    `import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";\n` +
    `export class Gadget extends DurableObject {}\n` +
    `export class ExportHandler extends WorkerEntrypoint {\n` +
    `  async getExportFormats(_gadget) {\n` +
    `    return [{ id: "csv", label: "CSV", mode: "server", contentType: "text/csv", fileExtension: ".csv" }];\n` +
    `  }\n` +
    `  async export(_gadget, id) {\n` +
    `    if (id !== "csv") throw new Error(\`Unsupported export format: \${id}\`);\n` +
    `    return new Response("a,b\\n1,2\\n").body;\n` +
    `  }\n` +
    `}\n`;

const LLM_SERVER =
    `import { DurableObject } from "cloudflare:workers";\n` +
    `export class Gadget extends DurableObject {\n` +
    `  async ask(prompt) { return await this.env.LLM.run({ prompt }); }\n` +
    `}\n`;

/** Ask an `LLM_SERVER` gadget's mainline server. */
async function ask(gadget: RpcStub<GadgetClient>, prompt: string): Promise<string> {
  using facet = await gadget.connectToGadget() as RpcStub<{ ask(prompt: string): string }>;
  return await facet.ask(prompt);
}

const CLASSIFIER_SERVER =
    `import { DurableObject } from "cloudflare:workers";\n` +
    `export class Gadget extends DurableObject {\n` +
    `  async classify(request) { return await this.env.CLASSIFIER.classify(request); }\n` +
    `}\n`;

const userPrompt = (content: string) =>
  expect.objectContaining({ messages: [{ role: "user", content }] });

/** Merge a one-file edit into mainline through a human-only chat; returns the new head. */
async function commitText(ws: RpcStub<Overseer>, workpieces: WorkpieceRecorder,
                          gadgetId: WorkpieceId, head: string, path: string,
                          before: string | undefined, after: string): Promise<string> {
  const chatId = await ws.newChat("Edit", null);
  await ws.submitCodeChange(chatId, {
    generation: 0, revision: 0, clientId: "edit", seq: 1,
    pins: [{ gadgetId, baseCommit: head }], change: edit(gadgetId, path, before, after),
  });
  expect(await ws.mergeChanges(chatId)).toEqual({ outcome: "merged" });
  return headOf(workpieces, gadgetId, head);
}

async function committedText(ws: RpcStub<Overseer>, gadgetId: WorkpieceId, path: string) {
  const workpieces = new WorkpieceRecorder();
  using stub = stubFor(workpieces);
  using _subscription = await ws.subscribeToWorkpieces(stub);
  await workpieces.loaded;
  const commitId = await headOf(workpieces, gadgetId);
  return (await ws.readFilesAtCommit(commitId, [path]))[0]?.[1];
}

/** A gadget's code: its files, by path. */
type Code = Record<string, string>;

// Three versions of a blueprint, and what a gadget made from one adds of its own.
const V1: Code = { "client.js": "one\n", "lib.js": "export const answer = 42;\n" };
const V2: Code = { ...V1, "client.js": "two\n" };
const V3: Code = { ...V1, "client.js": "three\n" };
const NOTES: Code = { "notes.txt": "mine\n" };

/** What a blueprint merge leaves of lines that the gadget and the blueprint both changed. */
const conflict = (ours: string, base: string, theirs: string) =>
  `<<<<<<< this gadget\n${ours}||||||| base\n${base}=======\n${theirs}>>>>>>> blueprint\n`;

const toolCall = (name: string, args: Record<string, unknown>): ChatCompletionStep =>
  ({ toolCall: { id: `call-${name}`, name, arguments: args } });

const CHAT_REQUEST = z.object({
  messages: z.array(z.object({ role: z.string(), content: z.string().nullish() })),
});

/** What a chat subscriber is told of the workspace's chats, in order. */
class ChatRecorder extends RpcTarget implements AiChatSubscriber {
  readonly states: AiChatMetadata[] = [];
  streamGeneration() {}
  metadata(chat: AiChatMetadata) { this.states.push(chat); }
  deleted() {}
  message() {}
  changeApplied() {}
  stream() {}
}

/** What the workspace tells one of its members of a committed gadget, as of now. */
async function gadgetNow(ws: RpcStub<Overseer>, gadgetId: WorkpieceId) {
  const workpieces = new WorkpieceRecorder();
  using stub = stubFor(workpieces);
  using _subscription = await ws.subscribeToWorkpieces(stub);
  await workpieces.loaded;
  const summary = workpieces.summaries.get(gadgetId);
  if (summary?.type !== "gadget" || summary.commitId === undefined) {
    throw new Error(`Gadget ${gadgetId} has no committed head`);
  }
  return { ...summary, commitId: summary.commitId };
}

async function codeAt(ws: RpcStub<Overseer>, commitId: string): Promise<Code> {
  const paths = treePaths(await ws.listTree(commitId));
  const code: Code = {};
  for (const [path, file] of await ws.readFilesAtCommit(commitId, paths)) {
    if (file.kind !== "text") throw new Error(`${path} at ${commitId} is ${file.kind}`);
    code[path] = file.text;
  }
  return code;
}

const parentsOf = async (ws: RpcStub<Overseer>, commitId: string) =>
  (await ws.getCommitLog(commitId, 1))[0]?.parents;

/** Make `code` the whole of a gadget's committed code, through a human-only chat. */
async function commitCode(ws: RpcStub<Overseer>, gadgetId: WorkpieceId, code: Code)
    : Promise<string> {
  const content = (of: Code): CodeContent => new Map([[gadgetId, new Map(Object.entries(of))]]);
  const { commitId: head } = await gadgetNow(ws, gadgetId);
  const chatId = await ws.newChat("Edit", null);
  await ws.submitCodeChange(chatId, {
    generation: 0, revision: 0, clientId: "edit", seq: 1, pins: [{ gadgetId, baseCommit: head }],
    change: diffFiles(content(await codeAt(ws, head)), content(code)),
  });
  expect(await ws.mergeChanges(chatId)).toEqual({ outcome: "merged" });
  return (await gadgetNow(ws, gadgetId)).commitId;
}

/** A new gadget, `APP`, holding `code`. */
async function createApp(ws: RpcStub<Overseer>, code: Code): Promise<WorkpieceId> {
  using app = ws.createGadget("App", undefined, "APP");
  const gadgetId = await app.getId();
  await commitCode(ws, gadgetId, code);
  return gadgetId;
}

async function defaultGadget(ws: RpcStub<Overseer>): Promise<WorkpieceId> {
  const { defaultGadgetId } = await ws.getMetadata();
  if (defaultGadgetId === undefined) throw new Error("Workspace has no default Gadget");
  return defaultGadgetId;
}

/** The release that a blueprint offers, once that is other than `after`. */
const releaseOf = (publicApi: RpcStub<PublicApi>, blueprintId: string, after?: string) =>
  waitFor(`a new release of blueprint ${blueprintId}`, async () => {
    const commitId = (await publicApi.getBlueprint(blueprintId))?.metadata.commitId;
    return commitId !== undefined && commitId !== after ? commitId : null;
  });

/** Publish a gadget as a new blueprint: its id, and its first release. */
async function publish(publicApi: RpcStub<PublicApi>, ws: RpcStub<Overseer>,
                       gadgetId: WorkpieceId, title: string) {
  using gadget = await ws.getGadget(gadgetId);
  const { id } = await gadget.createBlueprint(title, `${title}, for a test`);
  return { blueprintId: id, gadgetId, release: await releaseOf(publicApi, id) };
}

/** Commit `code` to a published gadget and release it as its blueprint's next version. */
async function republish(publicApi: RpcStub<PublicApi>, ws: RpcStub<Overseer>,
                         { blueprintId, gadgetId }: { blueprintId: string; gadgetId: WorkpieceId },
                         code: Code): Promise<string> {
  const previous = await releaseOf(publicApi, blueprintId);
  await commitCode(ws, gadgetId, code);
  await ws.updateBlueprint(blueprintId, { updateCode: true });
  return releaseOf(publicApi, blueprintId, previous);
}

/** Apply a blueprint to a gadget, expecting a proposal: its chat, and the record of it there. */
async function propose(
    ws: RpcStub<Overseer>, gadget: RpcStub<GadgetClient>, blueprintId: string,
    options: { modelId: string | null; allowUnrelated?: boolean } = { modelId: null }) {
  const result = await gadget.applyBlueprint(blueprintId, options);
  if (result.outcome !== "proposed") {
    throw new Error(`Applying the blueprint was "${result.outcome}", not proposed`);
  }
  const { chatId } = result;
  const history = await loadAllChatHistory(before => ws.getChatHistory(chatId, before));
  const [message] = history.flatMap(entry => entry.type === "changes" ? [entry] : []);
  const [merge, ...others] = message?.blueprintMerges ?? [];
  if (message === undefined || merge === undefined || others.length > 0) {
    throw new Error(`Chat ${chatId} does not open with the proposal of one blueprint`);
  }
  return { chatId, message, merge };
}

/**
 * The merge commit of a proposal, as its message's pin declares it: the chat's content starts
 * there, and `head` is what it merged.
 */
function mergeCommitOf(message: { pins?: ChatGadgetPinRecord[] }, gadgetId: WorkpieceId,
                       head: string): string {
  const [pin, ...others] = message.pins ?? [];
  if (pin === undefined || others.length > 0) throw new Error("The proposal declares no one pin");
  expect(pin).toEqual({ gadgetId, baseCommit: expect.any(String), mergedCommit: head });
  return pin.baseCommit;
}

/** Accept a chat's proposed changes, and report what that left of the gadget. */
async function accept(ws: RpcStub<Overseer>, chatId: number, gadgetId: WorkpieceId) {
  expect(await ws.mergeChanges(chatId)).toEqual({ outcome: "merged" });
  return gadgetNow(ws, gadgetId);
}

it.concurrent("publishes, instantiates, and deletes an owned blueprint", async () => {
  using publicApi = connect(requireHarness().url);
  using authenticated = await signUp(publicApi, username("blueprint"));
  const formats = await waitFor("bundled output formats to install", async () => {
    const offers = await authenticated.listOutputFormats();
    return offers.length > 0 ? offers : null;
  });
  const document = formats.find(format => format.output.id === "document");
  if (document === undefined) throw new Error("Document output format is not installed");
  using sourceWorkspace = await authenticated.newGadgetFromBlueprint(document.blueprintId, {});
  const sourceMetadata = await sourceWorkspace.getMetadata();
  const sourceGadgetId = sourceMetadata.defaultGadgetId;
  if (sourceGadgetId === undefined) throw new Error("Source workspace has no default Gadget");
  using sourceGadget = await sourceWorkspace.getGadget(sourceGadgetId);

  const blueprint = await sourceGadget.createBlueprint("Starter", "Deterministic starter");
  expect(await sourceWorkspace.listBlueprints()).toContainEqual(expect.objectContaining({
    id: blueprint.id,
    title: "Starter",
    description: "Deterministic starter",
  }));

  const owned = await waitFor("the published blueprint to reach the owner's list", async () => {
    const blueprints = await authenticated.listOwnBlueprints();
    return blueprints.some(entry => entry.id === blueprint.id) ? blueprints : null;
  });
  expect(owned).toContainEqual(expect.objectContaining({
    id: blueprint.id,
    source: {
      type: "workspace",
      workspaceId: sourceMetadata.id,
      workspaceTitle: sourceMetadata.title,
    },
  }));
  using installedWorkspace = await authenticated.newGadgetFromBlueprint(blueprint.id, {});
  const installedMetadata = await installedWorkspace.getMetadata();
  const installedGadgetId = installedMetadata.defaultGadgetId;
  if (installedGadgetId === undefined) throw new Error("Installed workspace has no default Gadget");
  using installedGadget = await installedWorkspace.getGadget(installedGadgetId);
  expect(await installedGadget.getTitle()).toBe("Starter");

  await sourceWorkspace.deleteBlueprint(blueprint.id);
  await waitFor("the deleted blueprint to leave the owner's list", async () =>
    (await authenticated.listOwnBlueprints()).some(entry => entry.id === blueprint.id)
      ? null
      : true);
  await installedWorkspace.deleteSelf();
  await sourceWorkspace.deleteSelf();
});

it.concurrent("creates and removes an indexed standard output", async () => {
  using publicApi = connect(requireHarness().url);
  using authenticated = await signUp(publicApi, username("output"));
  const formats = await waitFor("bundled output formats to install", async () => {
    const offers = await authenticated.listOutputFormats();
    return offers.length > 0 ? offers : null;
  });
  const document = formats.find(format => format.output.id === "document");
  if (document === undefined) throw new Error("Document output format is not installed");
  expect(document.requiresSetup).toBe(false);

  using workspace = await authenticated.newGadgetFromBlueprint(document.blueprintId, {});
  const metadata = await workspace.getMetadata();
  const gadgetId = metadata.defaultGadgetId;
  if (gadgetId === undefined) throw new Error("Output workspace has no default Gadget");

  const indexed = await waitFor("the document to appear in the output index", async () => {
    const result = await authenticated.listOutputs();
    return result.outputs.some(output =>
      output.workspaceId === metadata.id && output.workpieceId === gadgetId)
      ? result.outputs
      : null;
  });
  expect(indexed).toContainEqual(expect.objectContaining({
    workspaceId: metadata.id,
    workpieceId: gadgetId,
    output: expect.objectContaining({ id: "document" }),
  }));

  using gadget = await workspace.getGadget(gadgetId);
  await gadget.remove();
  await waitFor("the removed document to leave the output index", async () =>
    (await authenticated.listOutputs()).outputs.some(output =>
      output.workspaceId === metadata.id && output.workpieceId === gadgetId)
      ? null
      : true);
  await workspace.deleteSelf();
});

it.concurrent("republishing a blueprint changes future installs, not existing ones", async () => {
  using publicApi = connect(requireHarness().url);
  using authenticated = await signUp(publicApi, username("republish"));
  using source = await authenticated.newGadget();
  const workpieces = new WorkpieceRecorder();
  using workpiecesStub = stubFor(workpieces);
  using _subscription = await source.subscribeToWorkpieces(workpiecesStub);
  await workpieces.loaded;
  using app = source.createGadget("App", undefined, "APP");
  const gadgetId = await app.getId();
  const empty = await headOf(workpieces, gadgetId);
  const v1Head = await commitText(source, workpieces, gadgetId, empty, "app.txt", undefined, "v1\n");

  const blueprint = await app.createBlueprint("Republished", "Versioned starter");
  const { version } = (await waitFor("the published blueprint", () =>
    publicApi.getBlueprint(blueprint.id))).metadata;

  async function install() {
    const workspace = await authenticated.newGadgetFromBlueprint(blueprint.id, {});
    const { defaultGadgetId } = await workspace.getMetadata();
    if (defaultGadgetId === undefined) throw new Error("Installed workspace has no default Gadget");
    return { workspace, gadgetId: defaultGadgetId };
  }

  await commitText(source, workpieces, gadgetId, v1Head, "app.txt", "v1\n", "v2\n");
  expect((await publicApi.getBlueprint(blueprint.id))?.metadata.version).toBe(version);
  const copyA = await install();
  expect(await committedText(copyA.workspace, copyA.gadgetId, "app.txt"))
      .toEqual({ kind: "text", text: "v1\n" });

  await source.updateBlueprint(blueprint.id, { updateCode: true });
  await waitFor("the republished blueprint version", async () =>
    (await publicApi.getBlueprint(blueprint.id))?.metadata.version === version + 1 || null);

  const copyB = await install();
  expect(await committedText(copyB.workspace, copyB.gadgetId, "app.txt"))
      .toEqual({ kind: "text", text: "v2\n" });
  expect(await committedText(copyA.workspace, copyA.gadgetId, "app.txt"))
      .toEqual({ kind: "text", text: "v1\n" });

  for (const { workspace } of [copyA, copyB]) {
    await workspace.deleteSelf();
    workspace[Symbol.dispose]();
  }
  await source.deleteSelf();
});

it.concurrent("a blueprint archive keeps DATA's annotation, and installs bind the installer's account", async () => {
  const [publisher, installer] = nextUsernames("blueprintpublisher", "blueprintinstaller");
  if (!publisher || !installer) throw new Error("Failed to allocate test usernames");

  using publisherPublic = connect(requireHarness().url);
  using publisherApi = await signUp(publisherPublic, publisher);
  await publisherApi.provisionAmbientAccount(TEST_VENDOR_ID);
  const publisherAccount = (await listConnectedAccounts(publisherApi))
      .find(account => account.vendorId === TEST_VENDOR_ID);
  if (!publisherAccount) throw new Error("Publisher's test account was not provisioned");
  const formats = await waitFor("bundled output formats to install", async () => {
    const offers = await publisherApi.listOutputFormats();
    return offers.length > 0 ? offers : null;
  });
  const document = formats.find(format => format.output.id === "document");
  if (!document) throw new Error("Document output format is not installed");
  using sourceWorkspace = await publisherApi.newGadgetFromBlueprint(document.blueprintId, {});
  const sourceWorkpieces = new WorkpieceRecorder();
  using sourceWorkpiecesStub = stubFor(sourceWorkpieces);
  using _sourceWorkpieces = await sourceWorkspace.subscribeToWorkpieces(sourceWorkpiecesStub);
  await sourceWorkpieces.loaded;
  const sourceGadgets = [...sourceWorkpieces.summaries.values()]
      .filter(summary => summary.type === "gadget");
  expect(sourceGadgets).toHaveLength(1);
  const sourceSummary = sourceGadgets[0];
  if (!sourceSummary || sourceSummary.type !== "gadget" || !sourceSummary.commitId) {
    throw new Error("Source workspace has no committed default Gadget");
  }
  expect((await sourceWorkspace.getMetadata()).defaultGadgetId).toBe(sourceSummary.id);
  using sourceGadget = await sourceWorkspace.getGadget(sourceSummary.id);
  using decoy = await sourceWorkspace.newGatekeeper(
      publisherAccount.id, "https://gadgets-test.example/things/decoy");
  using data = await sourceWorkspace.newGatekeeper(
      publisherAccount.id, "https://gadgets-test.example/things/source");
  if (!decoy || !data) throw new Error("Failed to create the publisher's test connections");
  await sourceGadget.bind("DATA", await data.getId());
  const annotation = {
    title: "Source data", description: "Connect the source test thing.", suggestValue: true,
  };
  await sourceGadget.setBlueprintAnnotation("DATA", annotation);
  expect(await sourceGadget.getBlueprintAnnotation("DATA")).toEqual(annotation);
  const blueprint = await sourceGadget.createBlueprint(
      "Bound", "Blueprint with a DATA binding");

  using installerPublic = connect(requireHarness().url);
  using installerApi = await signUp(installerPublic, installer);
  const importedId = await installerApi.importBlueprint(
      await publisherPublic.downloadBlueprint(blueprint.id));
  expect((await installerPublic.getBlueprint(importedId))?.metadata.bindings).toEqual({
    DATA: {
      title: "Source data",
      description: "Connect the source test thing.",
      type: "gatekeeper",
      gatekeeperName: TEST_VENDOR_ID,
      typeUrlPattern: "https://gadgets-test.example/things/*",
      resourceUrl: "https://gadgets-test.example/things/source",
    },
  });
  await installerApi.provisionAmbientAccount(TEST_VENDOR_ID);
  const installerAccount = (await listConnectedAccounts(installerApi))
      .find(account => account.vendorId === TEST_VENDOR_ID);
  if (!installerAccount) throw new Error("Installer's test account was not provisioned");
  using installedWorkspace = await installerApi.newGadgetFromBlueprint(importedId, {
    DATA: {
      type: "gatekeeper",
      accountId: installerAccount.id,
      resourceUrl: "https://gadgets-test.example/things/installed",
    },
  });
  const installedWorkpieces = new WorkpieceRecorder();
  using installedWorkpiecesStub = stubFor(installedWorkpieces);
  using _installedWorkpieces = await installedWorkspace.subscribeToWorkpieces(installedWorkpiecesStub);
  await installedWorkpieces.loaded;
  const installedGadgets = [...installedWorkpieces.summaries.values()]
      .filter(summary => summary.type === "gadget");
  expect(installedGadgets).toHaveLength(1);
  const installedSummary = installedGadgets[0];
  if (!installedSummary || installedSummary.type !== "gadget" || !installedSummary.commitId) {
    throw new Error("Installed workspace has no committed default Gadget");
  }
  expect((await installedWorkspace.getMetadata()).defaultGadgetId).toBe(installedSummary.id);
  using installedGadget = await installedWorkspace.getGadget(installedSummary.id);
  using binding = await installedGadget.getBinding("DATA");
  if (!binding) throw new Error("Installed Gadget has no DATA binding");
  expect(await binding.getCreationSpec()).toMatchObject({
    type: "gatekeeper",
    vendorId: TEST_VENDOR_ID,
    resourceUrl: "https://gadgets-test.example/things/installed",
  });

  using session = await binding.openSession() as RpcStub<TestSession>;
  const write = session.writeValue(17);
  const [pending] = await waitFor("the installed connection's action", async () => {
    const { entries } = await installedWorkspace.listActions({ filter: "pending" });
    return entries.length === 1 ? entries : null;
  });
  await installedWorkspace.approveAction(pending.id);
  await write;
  expect(await testActionState(requireHarness(), accountLabel(installerAccount)))
      .toEqual({ pending: [], value: 17, applyCount: 1 });
  expect(await testActionState(requireHarness(), accountLabel(publisherAccount)))
      .toEqual({ pending: [], applyCount: 0 });

  const sourcePaths = treePaths(await sourceWorkspace.listTree(sourceSummary.commitId));
  const installedPaths = treePaths(await installedWorkspace.listTree(installedSummary.commitId));
  expect(installedPaths).toEqual(sourcePaths);
  expect(await installedWorkspace.readFilesAtCommit(installedSummary.commitId, installedPaths))
      .toEqual(await sourceWorkspace.readFilesAtCommit(sourceSummary.commitId, sourcePaths));

  await installedWorkspace.deleteSelf();
  await sourceWorkspace.deleteSelf();
});

it.concurrent("an update from a gadget's blueprint merges with its own changes, on accept",
    async () => {
  using publicApi = connect(requireHarness().url);
  using api = await signUp(publicApi, username("update"));
  using source = await api.newGadget();
  const blueprint = await publish(publicApi, source, await createApp(source, V1), "Updated");
  const { blueprintId, release: r1 } = blueprint;

  // The gadget's history is its own from the start: an empty root, into which its head merges
  // the release it was made from.
  using ws = await api.newGadgetFromBlueprint(blueprintId, {});
  const gadgetId = await defaultGadget(ws);
  using gadget = await ws.getGadget(gadgetId);
  const made = await gadgetNow(ws, gadgetId);
  expect(made.upstream).toEqual({ blueprintId, commitId: r1 });
  expect(await codeAt(ws, made.commitId)).toEqual(V1);
  const [root, ...merged] = await parentsOf(ws, made.commitId) ?? [];
  expect(merged).toEqual([r1]);
  expect(await ws.getCommitLog(root!, 1)).toEqual([
    expect.objectContaining({ oid: root, parents: [], message: "Create gadget: Updated\n" }),
  ]);
  expect(await ws.listTree(root!)).toEqual([]);
  expect(await gadget.applyBlueprint(blueprintId, { modelId: null }))
      .toEqual({ outcome: "upToDate" });

  // Both sides change the same line, and the gadget adds a file of its own.
  const r2 = await republish(publicApi, source, blueprint, V2);
  const own = await commitCode(ws, gadgetId, { ...V1, "client.js": "mine\n", ...NOTES });

  const { chatId, message, merge } = await propose(ws, gadget, blueprintId);
  expect(merge).toEqual({
    gadgetId, blueprintId, title: "Updated", version: 2, commitId: r2, kind: "merge",
    baseCommit: r1, conflictPaths: ["client.js"],
  });
  const chat = (await ws.listChats()).find(entry => entry.id === chatId);
  expect(chat).toMatchObject({
    title: "Update from blueprint: Updated", proposedChangeWorkpieces: [gadgetId],
  });
  expect(chat?.activeAgent).toBeUndefined();

  // The merge is a commit of the gadget and the release, at which the chat is pinned. The
  // message that records the proposal carries no change of its own.
  const conflicted = conflict("mine\n", "one\n", "two\n");
  const mergeCommit = mergeCommitOf(message, gadgetId, own);
  expect(message.change).toBeUndefined();
  expect(await parentsOf(ws, mergeCommit)).toEqual([own, r2]);
  expect(await codeAt(ws, mergeCommit)).toEqual({ ...V2, "client.js": conflicted, ...NOTES });

  // The merge is there to preview, and the gadget is as it was until it is accepted.
  expect(await gadget.getUiBundle(chatId)).toEqual({ jsCode: conflicted });
  expect(await gadget.getUiBundle()).toEqual({ jsCode: "mine\n" });
  expect(await gadgetNow(ws, gadgetId)).toEqual({ ...made, commitId: own });

  const { generation, revision } = chat!.codeBase!;
  await ws.submitCodeChange(chatId, {
    generation, revision, clientId: "resolve", seq: 1,
    change: edit(gadgetId, "client.js", conflicted, "mine and two\n"),
  });
  // The resolution is committed on the merge, which keeps the release in the gadget's history.
  const updated = await accept(ws, chatId, gadgetId);
  expect(updated.upstream).toEqual({ blueprintId, commitId: r2 });
  expect(await parentsOf(ws, updated.commitId)).toEqual([mergeCommit]);
  expect(await codeAt(ws, updated.commitId))
      .toEqual({ ...V2, "client.js": "mine and two\n", ...NOTES });
  expect(await gadget.applyBlueprint(blueprintId, { modelId: null }))
      .toEqual({ outcome: "upToDate" });

  await ws.deleteSelf();
  await source.deleteSelf();
});

it.concurrent("a gadget switches to a blueprint built on an earlier release of the one it follows",
    async () => {
  const [alice, bob, carol] = nextUsernames("alice", "bob", "carol");
  if (!alice || !bob || !carol) throw new Error("Failed to allocate test usernames");
  const A1: Code = { "client.js": "alice 1\n" };
  const A2: Code = { "client.js": "alice 2\n" };
  const A3: Code = { "client.js": "alice 3\n" };
  const CAROLS: Code = { "carol.js": "carol\n" };
  const README: Code = { "README.md": "Bob's fork\n" };

  using alicePublic = connect(requireHarness().url);
  using aliceApi = await signUp(alicePublic, alice);
  using aliceWs = await aliceApi.newGadget();
  const alices = await publish(alicePublic, aliceWs, await createApp(aliceWs, A1), "Alice's");
  const a2 = await republish(alicePublic, aliceWs, alices, A2);

  // Bob builds on Alice's second release. He adds his file in a chat that he brings up to date
  // with a change of his own made meanwhile, so his gadget's history holds a merge that is not
  // of a release: of mainline and a snapshot of the chat's files.
  using bobPublic = connect(requireHarness().url);
  using bobApi = await signUp(bobPublic, bob);
  using bobWs = await bobApi.newGadgetFromBlueprint(alices.blueprintId, {});
  const bobGadget = await defaultGadget(bobWs);
  const { commitId: bobsStart } = await gadgetNow(bobWs, bobGadget);
  const bobsChat = await bobWs.newChat("Add my file", null);
  await bobWs.setChatTitle(bobsChat, "Bob's file");
  await bobWs.submitCodeChange(bobsChat, {
    generation: 0, revision: 0, clientId: "bob", seq: 1,
    pins: [{ gadgetId: bobGadget, baseCommit: bobsStart }],
    change: edit(bobGadget, "bob.js", undefined, "bob 1\n"),
  });
  const bobsMainline = await commitCode(bobWs, bobGadget, { ...A2, ...README });
  expect(await bobWs.updateChatFromMainline(bobsChat)).toEqual({ conflictPaths: [] });
  expect(await bobWs.mergeChanges(bobsChat)).toEqual({ outcome: "merged" });
  const bobsMerge = (await gadgetNow(bobWs, bobGadget)).commitId;
  expect(await codeAt(bobWs, bobsMerge)).toEqual({ ...A2, ...README, "bob.js": "bob 1\n" });
  const [mainlineSide, chatSide, ...more] = await parentsOf(bobWs, bobsMerge) ?? [];
  expect([mainlineSide, more]).toEqual([bobsMainline, []]);
  expect(await bobWs.getCommitLog(chatSide!, 1)).toEqual([expect.objectContaining(
      { parents: [bobsStart], message: "Chat before update: Bob's file\n" })]);

  // He publishes the result as a blueprint of his own. Its first release merges Alice's into a
  // root that is the blueprint's own, and names nothing else: the merge his chat made is his.
  const bobs = await publish(bobPublic, bobWs, bobGadget, "Bob's");
  const b1 = bobs.release;
  const [b0, ...built] = await parentsOf(bobWs, b1) ?? [];
  expect(built).toEqual([a2]);
  expect(await bobWs.getCommitLog(b0!, 1)).toEqual([
    expect.objectContaining({ oid: b0, parents: [], message: "Release 0: Bob's\n" }),
  ]);

  // Carol's gadget is from Alice's third release, and has a change of its own.
  const a3 = await republish(alicePublic, aliceWs, alices, A3);
  using carolPublic = connect(requireHarness().url);
  using carolApi = await signUp(carolPublic, carol);
  using ws = await carolApi.newGadgetFromBlueprint(alices.blueprintId, {});
  const gadgetId = await defaultGadget(ws);
  using gadget = await ws.getGadget(gadgetId);
  const made = await gadgetNow(ws, gadgetId);
  expect(made.upstream).toEqual({ blueprintId: alices.blueprintId, commitId: a3 });
  const c1 = await commitCode(ws, gadgetId, { ...A3, ...CAROLS });

  // What her gadget and Bob's blueprint have in common is Alice's second release. Her workspace
  // was only ever sent that release's commit: its files come with Bob's blueprint. Against it,
  // Alice's later change is Carol's to keep and Bob's addition is his.
  const switching = await propose(ws, gadget, bobs.blueprintId);
  expect(switching.merge).toEqual({
    gadgetId, blueprintId: bobs.blueprintId, title: "Bob's", version: 1, commitId: b1,
    kind: "merge", baseCommit: a2, conflictPaths: [],
  });
  const switchMerge = mergeCommitOf(switching.message, gadgetId, c1);
  const switched = await accept(ws, switching.chatId, gadgetId);
  expect(switched.upstream).toEqual({ blueprintId: bobs.blueprintId, commitId: b1 });
  expect(switched.commitId).toBe(switchMerge);
  expect(await parentsOf(ws, switched.commitId)).toEqual([c1, b1]);
  expect(await codeAt(ws, switched.commitId)).toEqual(
      { ...A3, ...README, "bob.js": "bob 1\n", ...CAROLS });

  // Her gadget's history is now its own four commits, the last of them the merge she accepted,
  // and every release of both blueprints, the two that both lines lead to among them. None of
  // Bob's own commits came with his blueprint.
  const [root] = await parentsOf(ws, made.commitId) ?? [];
  expect((await ws.getCommitLog(switched.commitId)).map(commit => commit.oid).toSorted()).toEqual(
      [switched.commitId, c1, made.commitId, root, a3, a2, alices.release, b1, b0].toSorted());

  // The merge is in her gadget's history, which is where Bob's next release finds its base.
  const b2 = await republish(bobPublic, bobWs, bobs, { ...A2, ...README, "bob.js": "bob 2\n" });
  const updating = await propose(ws, gadget, bobs.blueprintId);
  expect(updating.merge).toMatchObject(
      { version: 2, commitId: b2, kind: "merge", baseCommit: b1, conflictPaths: [] });
  const updated = await accept(ws, updating.chatId, gadgetId);
  expect(await parentsOf(ws, updated.commitId)).toEqual([switched.commitId, b2]);
  expect(await codeAt(ws, updated.commitId)).toEqual(
      { ...A3, ...README, "bob.js": "bob 2\n", ...CAROLS });

  await ws.deleteSelf();
  await bobWs.deleteSelf();
  await aliceWs.deleteSelf();
});

it.concurrent("a gadget with no lineage takes a blueprint only over a base the caller allows",
    async () => {
  using publicApi = connect(requireHarness().url);
  using api = await signUp(publicApi, username("unrelated"));
  using source = await api.newGadget();
  const blueprint = await publish(publicApi, source, await createApp(source, V1), "Unrelated");
  const { blueprintId, release: r1 } = blueprint;

  // A gadget built by hand follows no blueprint, as its upstream says by naming none, and its
  // history holds none. The UI offers such a gadget no update, but applying a blueprint to it
  // is not refused.
  using ws = await api.newGadget();
  const gadgetId = await createApp(ws, { "client.js": "mine\n" });
  using gadget = await ws.getGadget(gadgetId);
  const first = await gadgetNow(ws, gadgetId);
  expect(first.upstream).toEqual({});
  const own = await commitCode(ws, gadgetId, { "client.js": "mine\n", ...NOTES });

  const chats = await ws.listChats();
  expect(await gadget.applyBlueprint(blueprintId, { modelId: null }))
      .toEqual({ outcome: "unrelated" });
  expect(await ws.listChats()).toEqual(chats);

  // The base is a guess: the first code the gadget had. Its client.js is in that guess, so
  // the blueprint's takes its place with no conflict, which is what the caller has allowed.
  const { chatId, merge } =
      await propose(ws, gadget, blueprintId, { modelId: null, allowUnrelated: true });
  expect(merge).toEqual({
    gadgetId, blueprintId, title: "Unrelated", version: 1, commitId: r1, kind: "merge",
    baseCommit: first.commitId, conflictPaths: [], unverifiedBase: true,
  });
  const related = await accept(ws, chatId, gadgetId);
  expect(related.upstream).toEqual({ blueprintId, commitId: r1 });
  expect(await parentsOf(ws, related.commitId)).toEqual([own, r1]);
  expect(await codeAt(ws, related.commitId)).toEqual({ ...V1, ...NOTES });

  // The gadget has lineage now, so the next release merges against this one, unasked.
  const r2 = await republish(publicApi, source, blueprint, V2);
  const next = await propose(ws, gadget, blueprintId);
  expect(next.merge).toEqual({
    gadgetId, blueprintId, title: "Unrelated", version: 2, commitId: r2, kind: "merge",
    baseCommit: r1, conflictPaths: [],
  });

  await ws.deleteSelf();
  await source.deleteSelf();
});

it.concurrent("the agent reviews a merge in one turn, and is never called for a fast-forward",
    async () => {
  const model = models.script([
    toolCall("readFile", { workpiece: "GADGET", filename: "client.js" }),
    toolCall("writeFile", { workpiece: "GADGET", filename: "client.js", content: "both\n" }),
    { text: "I kept both changes to client.js." },
  ]);
  using publicApi = connect(requireHarness().url);
  using api = await signUp(publicApi, username("review"));
  await api.addModel(model.userModel.profile, model.userModel.config);
  using source = await api.newGadget();
  const blueprint = await publish(publicApi, source, await createApp(source, V1), "Reviewed");
  const { blueprintId } = blueprint;
  using ws = await api.newGadgetFromBlueprint(blueprintId, {});
  const gadgetId = await defaultGadget(ws);
  using gadget = await ws.getGadget(gadgetId);
  const chats = new ChatRecorder();
  using chatsStub = stubFor(chats);
  using _chats = await ws.subscribeToChat(chatsStub);
  const agentsOf = (chatId: number) =>
    chats.states.flatMap(chat => chat.id === chatId && chat.activeAgent ? [chat.activeAgent] : []);

  // The gadget has no changes of its own for the next release to disagree with, so there is
  // nothing for an agent to check. The chat is never active: accepting would refuse if it were.
  const r2 = await republish(publicApi, source, blueprint, V2);
  const forward = await propose(ws, gadget, blueprintId, { modelId: SCRIPTED_MODEL_ID });
  expect(forward.merge).toMatchObject({ kind: "fastForward", commitId: r2 });
  const forwarded = await accept(ws, forward.chatId, gadgetId);
  expect(await codeAt(ws, forwarded.commitId)).toEqual(V2);
  expect(agentsOf(forward.chatId)).toEqual([]);
  expect(model.requests).toEqual([]);

  // Now it has one, to the line that the release after changes. The turn starts with the chat.
  const own = await commitCode(ws, gadgetId, { ...V2, "client.js": "mine\n" });
  const r3 = await republish(publicApi, source, blueprint, V3);
  const { chatId, message, merge } =
      await propose(ws, gadget, blueprintId, { modelId: SCRIPTED_MODEL_ID });
  expect(merge).toMatchObject(
      { kind: "merge", commitId: r3, baseCommit: r2, conflictPaths: ["client.js"] });
  const merged = mergeCommitOf(message, gadgetId, own);
  await waitForIdleChat(ws, chatId);
  expect(agentsOf(chatId)).toContainEqual(model.userModel.profile);

  // What prompts the turn is the record of the proposal, described: nobody sent a message.
  expect(model.remainingSteps()).toBe(0);
  expect(model.requests).toHaveLength(3);
  const [first, second] = model.requests.map(request => CHAT_REQUEST.parse(request).messages);
  const [prompt, ...prompts] = first!.filter(entry => entry.role === "user");
  expect(prompts).toEqual([]);
  for (const said of [
    'The user applied version 3 of the blueprint "Reviewed" to the gadget `env.GADGET`',
    `* base, the version the two have in common: ${r2}\n` +
        `* this gadget, before the merge: ${own}\n* blueprint: ${r3}\n`,
    'Files with conflicts:\n* "client.js"\n',
  ]) {
    expect(prompt?.content).toContain(said);
  }
  expect(second!.find(entry => entry.role === "tool")?.content)
      .toContain(conflict("mine\n", "two\n", "three\n"));

  // One model step is one message from the agent, and nobody else has said anything.
  const history = await loadAllChatHistory(before => ws.getChatHistory(chatId, before));
  expect(history.filter(entry => entry.type === "error")).toEqual([]);
  const messages = history.flatMap(entry => entry.type === "message" ? [entry] : []);
  expect(messages.map(entry => entry.author.type)).toEqual(["agent", "agent", "agent"]);
  expect(messages.at(-1)?.message).toBe("I kept both changes to client.js.");
  expect(await gadget.getUiBundle(chatId)).toEqual({ jsCode: "both\n" });

  const reviewed = await accept(ws, chatId, gadgetId);
  expect(reviewed.upstream).toEqual({ blueprintId, commitId: r3 });
  expect(await parentsOf(ws, reviewed.commitId)).toEqual([merged]);
  expect(await parentsOf(ws, merged)).toEqual([own, r3]);
  expect(await codeAt(ws, reviewed.commitId)).toEqual({ ...V3, "client.js": "both\n" });
  expect(model.requests).toHaveLength(3);

  await ws.deleteSelf();
  await source.deleteSelf();
});

it.concurrent("a bundled blueprint reinstalled with new files updates a gadget made from the old",
    async () => {
  const blueprintId = "bundled.fixture";
  const bundled = (version: number, code: Code) =>
    bundleBlueprints([{ blueprintId, title: "Bundled", version, files: code }]);
  const user = username("bundled");

  // A deployment of its own: installing other files takes a redeploy, which restarts the Worker
  // under every session it has.
  const deployment = await startHarness({ gatekeepers: [], patchWorkshop: bundled(1, V1) });
  try {
    const { workspaceId, gadgetId, r1, own } = await (async () => {
      using publicApi = connect(deployment.url);
      using api = await signUp(publicApi, user);
      const release = await releaseOf(publicApi, blueprintId);
      using ws = await api.newGadgetFromBlueprint(blueprintId, {});
      const id = await defaultGadget(ws);
      expect((await gadgetNow(ws, id)).upstream).toEqual({ blueprintId, commitId: release });
      return {
        workspaceId: (await ws.getMetadata()).id, gadgetId: id, r1: release,
        own: await commitCode(ws, id, { ...V1, ...NOTES }),
      };
    })();

    await deployment.redeployWorkshop(bundled(2, V2));

    using publicApi = connect(deployment.url);
    using api = await logIn(publicApi, user);
    const r2 = await releaseOf(publicApi, blueprintId, r1);
    using ws = await api.openGadget(workspaceId);
    using gadget = await ws.getGadget(gadgetId);
    expect(await gadgetNow(ws, gadgetId))
        .toMatchObject({ commitId: own, upstream: { blueprintId, commitId: r1 } });

    // Nothing in the two releases connects them: each is a commit of its files and no more. They
    // are versions of one blueprint because they were installed under the id the gadget follows,
    // so the one it took is the base, and the caller is asked to allow nothing.
    const { chatId, merge } = await propose(ws, gadget, blueprintId);
    expect(merge).toEqual({
      gadgetId, blueprintId, title: "Bundled", version: 2, commitId: r2, kind: "merge",
      baseCommit: r1, conflictPaths: [],
    });
    expect(await parentsOf(ws, r1)).toEqual([]);
    expect(await parentsOf(ws, r2)).toEqual([]);

    const updated = await accept(ws, chatId, gadgetId);
    expect(updated.upstream).toEqual({ blueprintId, commitId: r2 });
    expect(await parentsOf(ws, updated.commitId)).toEqual([own, r2]);
    expect(await codeAt(ws, updated.commitId)).toEqual({ ...V2, ...NOTES });
    expect(await gadget.applyBlueprint(blueprintId, { modelId: null }))
        .toEqual({ outcome: "upToDate" });
  } finally {
    await deployment.server.close();
  }
});

const bytesOf = async (stream: ReadableStream<Uint8Array>) =>
  new Uint8Array(await new Response(stream).arrayBuffer());

const streamOf = (bytes: Uint8Array): ReadableStream<Uint8Array> => new Response(bytes).body!;

/** The container version in a `.gadget` archive's header, which says what form its content takes. */
const archiveVersion = (archive: Uint8Array) =>
  new DataView(archive.buffer, archive.byteOffset, archive.byteLength).getUint32(8);

it.concurrent("an archive of either version imports and instantiates", async () => {
  using publicApi = connect(requireHarness().url);
  using api = await signUp(publicApi, username("archive"));

  // Version 1 is what a blueprint was exported as before its releases were commits: a snapshot
  // of its files. It is stored as it came, and downloads as what is stored.
  const exported = new Date(0).toISOString();
  const legacyId = await api.importBlueprint(streamOf(serializeArchive(1, {
    title: "Legacy", description: "Exported long ago",
    author: { type: "user", id: "legacy@gadgets-test.example", name: "Legacy" },
    created: exported, version: 3, lastUpdated: exported, bindings: {},
  }, buildSnapshotContent(new Map(Object.entries(V1))))));
  const legacy = (await publicApi.getBlueprint(legacyId))?.metadata;
  expect(legacy).toMatchObject({ title: "Legacy", version: 3 });
  expect(legacy?.commitId).toBeUndefined();
  expect(archiveVersion(await bytesOf(await publicApi.downloadBlueprint(legacyId)))).toBe(1);

  // A gadget made from it still gets a release to follow: a commit of the snapshot's files, in
  // which form the gadget's history holds it like any other.
  using fromLegacy = await api.newGadgetFromBlueprint(legacyId, {});
  const legacyGadget = await gadgetNow(fromLegacy, await defaultGadget(fromLegacy));
  expect(await codeAt(fromLegacy, legacyGadget.commitId)).toEqual(V1);
  expect(legacyGadget.upstream?.blueprintId).toBe(legacyId);
  const snapshot = legacyGadget.upstream!.commitId!;
  expect((await parentsOf(fromLegacy, legacyGadget.commitId))?.slice(1)).toEqual([snapshot]);
  expect(await parentsOf(fromLegacy, snapshot)).toEqual([]);
  expect(await codeAt(fromLegacy, snapshot)).toEqual(V1);

  // Version 2 holds a release as it is, so an upload of a download is the same release under
  // another id.
  using source = await api.newGadget();
  const original = await publish(publicApi, source, await createApp(source, V1), "Exported");
  const archive = await bytesOf(await publicApi.downloadBlueprint(original.blueprintId));
  expect(archiveVersion(archive)).toBe(2);
  const copyId = await api.importBlueprint(streamOf(archive));
  expect(copyId).not.toBe(original.blueprintId);
  expect((await publicApi.getBlueprint(copyId))?.metadata)
      .toMatchObject({ title: "Exported", version: 1, commitId: original.release });

  using fromCopy = await api.newGadgetFromBlueprint(copyId, {});
  const copied = await gadgetNow(fromCopy, await defaultGadget(fromCopy));
  expect(copied.upstream).toEqual({ blueprintId: copyId, commitId: original.release });
  expect(await codeAt(fromCopy, copied.commitId)).toEqual(V1);

  // So a gadget made from the original already has what the copy offers. Applying the copy
  // proposes only to follow it, which changes no code and pins nothing: the record of the
  // proposal is all there is to accept.
  using ws = await api.newGadgetFromBlueprint(original.blueprintId, {});
  const gadgetId = await defaultGadget(ws);
  using gadget = await ws.getGadget(gadgetId);
  const before = await gadgetNow(ws, gadgetId);
  const { chatId, message, merge } = await propose(ws, gadget, copyId);
  expect(merge).toEqual({
    gadgetId, blueprintId: copyId, title: "Exported", version: 1, commitId: original.release,
    kind: "follow", conflictPaths: [],
  });
  expect(message.change).toBeUndefined();
  expect(message.pins).toBeUndefined();
  expect((await ws.listChats()).find(chat => chat.id === chatId)?.proposedChangeWorkpieces ?? [])
      .toEqual([]);
  expect(await accept(ws, chatId, gadgetId))
      .toEqual({ ...before, upstream: { blueprintId: copyId, commitId: original.release } });
  expect(await gadget.applyBlueprint(copyId, { modelId: null })).toEqual({ outcome: "upToDate" });

  for (const workspace of [ws, fromCopy, source, fromLegacy]) await workspace.deleteSelf();
});

it.concurrent("only a gadget's builders are told which blueprint it follows", async () => {
  const [owner, viewer] = nextUsernames("followowner", "followviewer");
  if (!owner || !viewer) throw new Error("Failed to allocate test usernames");
  using ownerPublic = connect(requireHarness().url);
  using ownerApi = await signUp(ownerPublic, owner);
  using source = await ownerApi.newGadget();
  const { blueprintId, release } =
      await publish(ownerPublic, source, await createApp(source, V1), "Followed");
  using ws = await ownerApi.newGadgetFromBlueprint(blueprintId, {});
  const gadgetId = await defaultGadget(ws);
  const built = await gadgetNow(ws, gadgetId);
  expect(built.upstream).toEqual({ blueprintId, commitId: release });

  // A blueprint's id is a link to its code, which someone who may only use the gadget cannot
  // otherwise read.
  using viewerPublic = connect(requireHarness().url);
  using viewerApi = await signUp(viewerPublic, viewer);
  if (!await ws.addCollaborator(viewer, "use")) throw new Error(`Failed to share with ${viewer}`);
  using useWs = await viewerApi.openGadget((await ws.getMetadata()).id);
  const { upstream: _upstream, ...used } = built;
  expect(await gadgetNow(useWs, gadgetId)).toEqual(used);

  await ws.deleteSelf();
  await source.deleteSelf();
});

// This stream is the gadget's own export, not a `.gadget` archive; the importable round trip is
// the blueprint archive test above.
it.concurrent("a gadget's ExportHandler lists and streams its format", async () => {
  using publicApi = connect(requireHarness().url);
  using api = await signUp(publicApi, username("gadgetexport"));
  using ws = await api.newGadget();
  const workpieces = new WorkpieceRecorder();
  using workpiecesStub = stubFor(workpieces);
  using _subscription = await ws.subscribeToWorkpieces(workpiecesStub);
  await workpieces.loaded;
  using app = ws.createGadget("App", undefined, "APP");
  const gadgetId = await app.getId();
  await commitText(ws, workpieces, gadgetId, await headOf(workpieces, gadgetId),
      "server.js", undefined, CSV_EXPORT_SERVER);

  expect(await app.getExportFormats()).toEqual([
    { id: "csv", label: "CSV", mode: "server", contentType: "text/csv", fileExtension: ".csv" },
  ]);
  expect(await new Response(await app.export("csv")).text()).toBe("a,b\n1,2\n");

  await ws.deleteSelf();
});

// Both users register the same model ID, backed by different scripted accounts, so only the
// installer's own configuration can produce the installer's reply.
it.concurrent("a gadget's LLM binding runs on its bound model, and an install uses the installer's",
    async () => {
  const [publisher, installer] = nextUsernames("llmpublisher", "llminstaller");
  if (!publisher || !installer) throw new Error("Failed to allocate test usernames");
  const publisherModel = models.script([{ text: "Publisher's summary." }]);
  const installerModel = models.script([{ text: "Installer's summary." }]);

  using publisherPublic = connect(requireHarness().url);
  using publisherApi = await signUp(publisherPublic, publisher);
  await publisherApi.addModel(publisherModel.userModel.profile, publisherModel.userModel.config);
  using source = await publisherApi.newGadget();
  const workpieces = new WorkpieceRecorder();
  using workpiecesStub = stubFor(workpieces);
  using _subscription = await source.subscribeToWorkpieces(workpiecesStub);
  await workpieces.loaded;
  using app = source.createGadget("Summarizer", undefined, "APP");
  const gadgetId = await app.getId();
  await commitText(source, workpieces, gadgetId, await headOf(workpieces, gadgetId),
      "server.js", undefined, LLM_SERVER);
  using llm = await source.newAiModelGatekeeper(publisherModel.userModel.profile.id);
  await app.bind("LLM", await llm.getId());

  expect(await ask(app, "Summarize the publisher's notes.")).toBe("Publisher's summary.");
  expect(publisherModel.requests).toEqual([userPrompt("Summarize the publisher's notes.")]);
  const blueprint = await app.createBlueprint("Summarizer", "Summarizes with an LLM");

  using installerPublic = connect(requireHarness().url);
  using installerApi = await signUp(installerPublic, installer);
  await installerApi.addModel(installerModel.userModel.profile, installerModel.userModel.config);
  using installed = await installerApi.newGadgetFromBlueprint(blueprint.id, {
    LLM: { type: "aiModel", modelId: installerModel.userModel.profile.id },
  });
  const { defaultGadgetId } = await installed.getMetadata();
  if (defaultGadgetId === undefined) throw new Error("Installed workspace has no default Gadget");
  using installedApp = await installed.getGadget(defaultGadgetId);

  expect(await ask(installedApp, "Summarize the installer's notes.")).toBe("Installer's summary.");
  expect(installerModel.requests).toEqual([userPrompt("Summarize the installer's notes.")]);
  expect(publisherModel.requests).toHaveLength(1);

  await installed.deleteSelf();
  await source.deleteSelf();
});

it.concurrent("a gadget's classifier binding answers its questions", async () => {
  using publicApi = connect(requireHarness().url);
  using api = await signUp(publicApi, username("classifier"));
  const profile = { type: "agent" as const, id: "my-clef", name: "Clef" };
  await api.addModel(profile, {
    provider: "cloudflare", model: "@cf/cloudflare/clef",
    accountId: CLASSIFIER_ACCOUNT, apiToken: "test-token",
  });
  using ws = await api.newGadget();
  const workpieces = new WorkpieceRecorder();
  using workpiecesStub = stubFor(workpieces);
  using _subscription = await ws.subscribeToWorkpieces(workpiecesStub);
  await workpieces.loaded;
  using app = ws.createGadget("Triage", undefined, "APP");
  const gadgetId = await app.getId();
  await commitText(ws, workpieces, gadgetId, await headOf(workpieces, gadgetId),
      "server.js", undefined, CLASSIFIER_SERVER);
  using classifier = await ws.newAiModelGatekeeper(profile.id);
  await app.bind("CLASSIFIER", await classifier.getId());
  using facet = await app.connectToGadget() as RpcStub<{ classify(request: unknown): unknown }>;
  const request = {
    state: { message: "My order never arrived." },
    questions: {
      refund: { type: "bool", instructions: "Do they want a refund?", criteria: { true: "Yes", false: "No" } },
    },
  };

  classifierResponses.push(Response.json({
    success: true, result: { model: "clef", answers: { refund: { type: "noul", noul: 0.9 } } },
  }));
  expect(await facet.classify(request)).toEqual({ refund: { type: "bool", probability: 0.9 } });
  classifierResponses.push(Response.json({
    success: false, errors: [{ code: 5006, message: "Invalid input" }],
  }, { status: 400 }));
  await expect(facet.classify(request)).rejects.toThrow("Invalid input");

  const blueprint = await app.createBlueprint("Triage", "Triages with a classifier");
  const published = await waitFor("the published blueprint", () => publicApi.getBlueprint(blueprint.id));
  expect(published.metadata.bindings.CLASSIFIER).toMatchObject({ type: "aiModel", classifier: true });
  await ws.deleteSelf();
});
