import {afterAll, beforeAll, expect, it} from "vitest";
import {loadAllChatHistory} from "../src/agent-session.js";
import {startHarness, TEST_GATEKEEPER_BINDING, TEST_GATEKEEPER_DIR, TEST_VENDOR_ID,
  type Harness} from "../src/harness.js";
import {SCRIPTED_MODEL_ID, scriptedModelRouter} from "../src/mock-model.js";
import {NetworkInterceptor} from "../src/network-interceptor.js";
import {connect, nextUsernames, signUp, stubFor, waitFor, waitForIdleChat,
  WorkpieceRecorder} from "../src/rpc-client.js";

let harness: Harness;
const models = scriptedModelRouter();
const network = new NetworkInterceptor({handlers: [models.handler]});

beforeAll(async () => {
  network.install();
  harness = await startHarness({
    gatekeepers: [{binding: TEST_GATEKEEPER_BINDING, dir: TEST_GATEKEEPER_DIR}],
    enableGadgetExecution: true,
    patchWorkshop: config => {
      config.vars = {...config.vars, AGENT_INTEGRATION_GRANTS:
        JSON.stringify({[TEST_VENDOR_ID]: {worktreeReplica: true}})};
    },
  });
});
afterAll(async () => {
  try {
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally { network.uninstall(); }
});

it("exports a worktree from code mode and returns changes without an agent-context callback", async () => {
  using publicApi = connect(harness.url);
  using api = await signUp(publicApi, nextUsernames("export")[0]!);
  await api.provisionAmbientAccount(TEST_VENDOR_ID);
  using ws = await api.newWorkspace();
  const workpieces = new WorkpieceRecorder();
  using subscriber = stubFor(workpieces);
  using _subscription = await ws.subscribeToWorkpieces(subscriber);
  await workpieces.loaded;
  using seed = ws.createGadget("Seed", undefined, "SEED");
  const seedId = await seed.getId();
  const baseCommit = await waitFor("the seed commit", async () => {
    const summary = workpieces.summaries.get(seedId);
    return summary?.type === "gadget" ? summary.commitId ?? null : null;
  });
  const model = models.script([
    {toolCall: {id: "create", name: "createWorktree", arguments: {
      title: "Repo", bindingName: "REPO", commitId: baseCommit,
    }}},
    {toolCall: {id: "export", name: "executeCode", arguments: {code: `
      export default async function(self, env) {
        const input = await env.REPO.exportTo("TEST_AMBIENT");
        const response = await input.packs[0].fetch("https://export.invalid/");
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (new TextDecoder().decode(bytes.slice(0, 4)) !== "PACK") throw new Error("Not a raw Git pack");
        await input.writeback.submitChanges("return", [{path: "returned.txt", change: {set: "from container"}}], true);
        console.log(input.binding, "pack received");
      }`}}},
    {toolCall: {id: "read", name: "executeCode", arguments: {code: `
      export default async function(self, env) {
        console.log(await env.REPO.readFile("returned.txt"));
      }`}}},
    {text: "Done."},
  ]);
  await api.addModel(model.userModel.profile, model.userModel.config);
  const chatId = await ws.newChat("Export and return changes.", SCRIPTED_MODEL_ID);
  await waitFor("the model's final request", async () => model.requests.length === 4 || null);
  await waitForIdleChat(ws, chatId);
  const history = await loadAllChatHistory(before => ws.getChatHistory(chatId, before));
  const outputs = history.flatMap(message => message.type === "message" ? message.toolCalls ?? [] : [])
    .filter(call => call.toolName === "executeCode").map(call => call.output);
  expect(outputs).toEqual([expect.stringContaining("REPO pack received"),
    expect.stringContaining("from container")]);
  expect(model.remainingSteps()).toBe(0);
});
