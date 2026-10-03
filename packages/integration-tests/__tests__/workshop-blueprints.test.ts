import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { GadgetClient, Overseer, TreeNode, WorkpieceId } from "@gadgets/workshop-shared/api";
import { diffFiles, type CodeContent } from "@gadgets/workshop-shared/code-change";
import type { TestSession } from "../fixtures/gatekeeper-test/src/test-gatekeeper.js";
import {
  startTestGatekeeperHarness, TEST_VENDOR_ID, testActionState, type Harness,
} from "../src/harness.js";
import { scriptedModelRouter } from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  accountLabel, connect, listConnectedAccounts, nextUsernames, signUp, stubFor, waitFor,
  WorkpieceRecorder,
} from "../src/rpc-client.js";

let harness: Harness | undefined;
const models = scriptedModelRouter();
const network = new NetworkInterceptor({ handlers: [models.handler] });

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
