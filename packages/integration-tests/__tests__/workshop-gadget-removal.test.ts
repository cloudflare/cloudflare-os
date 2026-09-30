import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { AiChatMetadata, AiChatSubscriber } from "@gadgets/workshop-shared/api";
import { diffFiles, type CodeContent } from "@gadgets/workshop-shared/code-change";
import type { TestSession } from "../fixtures/gatekeeper-test/src/test-gatekeeper.js";
import {
  hookServer, startTestGatekeeperHarness, TEST_VENDOR_ID, testControl, type Harness,
} from "../src/harness.js";
import { SCRIPTED_MODEL_ID, scriptedModelRouter } from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  connect, listConnectedAccounts, nextUsernames, RpcTarget, signUp, stubFor, waitFor,
  waitForIdleChat, WorkpieceRecorder,
} from "../src/rpc-client.js";

let harness: Harness;
const models = scriptedModelRouter();
const network = new NetworkInterceptor({ handlers: [models.handler] });

beforeAll(async () => {
  network.install();
  harness = await startTestGatekeeperHarness({ enableGadgetExecution: true });
});

afterAll(async () => {
  try {
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

const watchCode = (key: string) => `import { restore } from "cloudflare:workers";
export default async function(self, env) {
  await env.TEST_AMBIENT.watch(${JSON.stringify(key)}, await env.HOOKED[restore]({ type: "value-hook" }));
}`;

const CLIENT_V1 = `document.body.textContent = "blueprint v1";\n`;
const CLIENT_DRAFT = `document.body.textContent = "draft";\n`;

class ChatMetadataRecorder extends RpcTarget implements AiChatSubscriber {
  readonly metadataEvents: AiChatMetadata[] = [];
  streamGeneration(): void {}
  metadata(metadata: AiChatMetadata): void { this.metadataEvents.push(metadata); }
  deleted(): void {}
  message(): void {}
  changeApplied(): void {}
  stream(): void {}
}

/** The client.js edit from `before` to `after` in gadget `gadgetId`. */
const clientEdit = (gadgetId: number, before: string, after: string) => {
  const content = (text: string): CodeContent => new Map([[gadgetId, new Map([["client.js", text]])]]);
  return diffFiles(content(before), content(after));
};

it.concurrent("removing a gadget tears down its hook and draft proposals but spares shared connections and its blueprint", async () => {
  const [username] = nextUsernames("gadgetremove");
  const hookKey = `${username}:removed`;
  const model = models.script([
    {
      toolCalls: [
        { id: "create", name: "createGadget", arguments: { title: "Removal target", bindingName: "HOOKED" } },
        {
          id: "server",
          name: "writeFile",
          arguments: { workpiece: "HOOKED", filename: "server.js", content: hookServer("TEST_AMBIENT") },
        },
        {
          id: "client",
          name: "writeFile",
          arguments: { workpiece: "HOOKED", filename: "client.js", content: CLIENT_V1 },
        },
        {
          id: "bind",
          name: "setGadgetBinding",
          arguments: { gadget: "HOOKED", source: "TEST_AMBIENT", name: "TEST_AMBIENT" },
        },
      ],
    },
    { text: "Built." },
    { toolCall: { id: "watch", name: "executeCode", arguments: { code: watchCode(hookKey) } } },
    { text: "Watching." },
  ]);

  using publicApi = connect(harness.url);
  using api = await signUp(publicApi, username);
  await api.addModel(model.userModel.profile, model.userModel.config);
  await api.provisionAmbientAccount(TEST_VENDOR_ID);
  const account = await waitFor("the ambient account", async () =>
    (await listConnectedAccounts(api)).find(a => a.vendorId === TEST_VENDOR_ID) ?? null);
  using ws = await api.newGadget();

  const workpieces = new WorkpieceRecorder();
  const chatMetadata = new ChatMetadataRecorder();
  using workpiecesStub = stubFor(workpieces);
  using chatMetadataStub = stubFor(chatMetadata);
  using _workpieces = await ws.subscribeToWorkpieces(workpiecesStub);
  using _chatMetadata = await ws.subscribeToChat(chatMetadataStub);
  await workpieces.loaded;

  // Build the gadget, merge it, and have it watch the hook key.
  const buildChat = await ws.newChat("Build the removable gadget.", SCRIPTED_MODEL_ID);
  await waitFor("the build turn", async () => model.requests.length === 2 || null);
  await waitForIdleChat(ws, buildChat);
  expect(await ws.mergeChanges(buildChat)).toEqual({ outcome: "merged" });
  await ws.sendChatMessage(buildChat, "Watch the removal key.", SCRIPTED_MODEL_ID);
  await waitFor("the watch turn", async () => model.requests.length === 4 || null);
  await waitForIdleChat(ws, buildChat);

  const { id: targetId, commitId: targetHead } = await waitFor("the committed removal target", async () => {
    const summary = [...workpieces.summaries.values()].find(summary =>
      summary.type === "gadget" && summary.title === "Removal target");
    return summary?.type === "gadget" && summary.commitId !== undefined
      ? { id: summary.id, commitId: summary.commitId } : null;
  });
  using removed = await ws.getGadget(targetId);

  // Dependents: an enabled hook, another gadget sharing its connection, a published blueprint,
  // and an open draft editing its client.js.
  const hook = (await ws.listHooks()).find(h => h.description.title === `Test hook ${hookKey}`);
  if (!hook) throw new Error(`No hook listed for ${hookKey}`);
  await ws.enableHook(hook.id);

  using gatekeeper = await ws.newGatekeeper(
      account.id, "https://gadgets-test.example/things/removal-source");
  if (!gatekeeper) throw new Error("The test connection was not created");
  const gatekeeperId = await gatekeeper.getId();
  using survivor = await ws.createGadget("Survivor", undefined, "SURVIVOR");
  await removed.bind("DATA", gatekeeperId);
  await survivor.bind("DATA", gatekeeperId);

  const blueprint = await removed.createBlueprint("Removed source", "Source removal regression");

  const draftChat = await ws.newChat("Draft", null);
  expect(await ws.submitCodeChange(draftChat, {
    generation: 0, revision: 0, clientId: "draft", seq: 1,
    pins: [{ gadgetId: targetId, baseCommit: targetHead }],
    change: clientEdit(targetId, CLIENT_V1, CLIENT_DRAFT),
  })).toEqual({ generation: 0, revision: 1 });
  expect((await ws.listChats()).find(chat => chat.id === draftChat)?.proposedChangeWorkpieces)
      .toEqual([targetId]);

  const eventsBefore = chatMetadata.metadataEvents.length;
  await removed.remove();

  // The survivor keeps the shared connection.
  expect(await survivor.listBindings()).toContainEqual(
      expect.objectContaining({ name: "DATA", target: gatekeeperId }));
  using binding = await survivor.getBinding("DATA");
  if (!binding) throw new Error("The survivor lost its DATA binding");
  using session = await binding.openSession() as RpcStub<TestSession>;
  expect(await session.readValue()).toBe(42);

  // The hook is deleted, the gatekeeper is told, and a fire is refused.
  expect(await ws.listHooks()).toEqual([]);
  expect(await testControl(harness, "hook-state", { key: hookKey }))
      .toMatchObject({ disableCount: 1 });
  expect(await testControl(harness, "fire-hook", { key: hookKey, value: 101 }))
      .toEqual({ error: "Hook has been deleted or disabled." });

  // The draft stops proposing the removed gadget, and subscribers are told so.
  await waitFor("the draft's post-removal metadata", async () =>
    chatMetadata.metadataEvents.slice(eventsBefore).find(meta =>
      meta.id === draftChat && meta.proposedChangeWorkpieces === undefined) ?? null);
  expect((await ws.listChats()).find(chat => chat.id === draftChat)?.proposedChangeWorkpieces)
      .toBeUndefined();

  // A reopened gadget, or a still-open editor's next edit, fails cleanly.
  await expect(ws.getGadget(targetId)).rejects.toThrow(`No such gadget: ${targetId}`);
  await expect(ws.submitCodeChange(draftChat, {
    generation: 0, revision: 1, clientId: "draft", seq: 2,
    change: clientEdit(targetId, CLIENT_DRAFT, CLIENT_V1),
  })).rejects.toThrow(`Code change touches a nonexistent gadget: ${targetId}`);

  // A published blueprint is a snapshot: it outlives its source but can't be refreshed from it.
  expect(await ws.listBlueprints()).toContainEqual(expect.objectContaining({ id: blueprint.id }));
  using installed = await api.newGadgetFromBlueprint(blueprint.id, {});
  const { defaultGadgetId } = await installed.getMetadata();
  if (defaultGadgetId === undefined) throw new Error("The installed blueprint has no gadget");
  using installedGadget = await installed.getGadget(defaultGadgetId);
  expect(await installedGadget.getUiBundle()).toEqual({ jsCode: CLIENT_V1 });
  await expect(ws.updateBlueprint(blueprint.id, { updateCode: true }))
      .rejects.toThrow(`No such gadget: ${targetId}`);
  await installed.deleteSelf();
});
