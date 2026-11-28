// Built-in web search: while the admin's Search provider is the model's provider, a Claude or GPT
// gateway model searches with its provider's own tool, inside its model request, in a chat that
// holds the Web Search gatekeeper's binding. The providers here answer with the
// streams real providers sent (workshop-backend/__tests__/built-in-search.test.ts names each),
// so the Workshop reads what a provider would send and the tests read what a provider would get.
//
// The cases share one deployment and each provider's queue of answers, so they run in order.

import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import { z } from "zod";
import type {
  AdminApi, AiModelConfig, AuthenticatedApi, GatewayModel,
} from "@gadgets/workshop-shared/api";
import {
  WEB_SEARCH_IN_MODEL, WEB_SEARCH_PROVIDER_SETTING, WEB_SEARCH_VENDOR_ID,
} from "@gadgets/workshop-shared/web-search-gatekeeper";
import type { TestSession } from "../fixtures/gatekeeper-test/src/test-gatekeeper.js";
import { loadAllChatHistory } from "../src/agent-session.js";
import {
  ADMIN_USERNAME, startHarness, TEST_GATEKEEPER_BINDING, TEST_GATEKEEPER_DIR, TEST_VENDOR_ID,
  type Harness,
} from "../src/harness.js";
import { SCRIPTED_MODEL_ID, scriptedChatCompletions } from "../src/mock-model.js";
import { NetworkInterceptor, type Handler } from "../src/network-interceptor.js";
import {
  connect, listConnectedAccounts, nextUsernames, RpcTarget, signUp, stubFor, waitFor,
  waitForIdleChat, WorkpieceRecorder,
} from "../src/rpc-client.js";

const FIXTURES = fileURLToPath(new URL(
    "../../workshop-backend/__tests__/built-in-search-fixtures/", import.meta.url));
const fixture = (name: string) => readFileSync(`${FIXTURES}${name}`, "utf8");
const OPENAI_SEARCH = fixture("openai-search.sse.txt");
const CLAUDE_ANSWER = fixture("anthropic-search-answer.sse.txt");
const CLAUDE_ANSWER_CONTENT: unknown = JSON.parse(fixture("anthropic-search-answer.content.json"));
const CLAUDE_TOOL_CALL = fixture("anthropic-search-tool-call.sse.txt");
const CLAUDE_TOOL_CALL_CONTENT: unknown =
    JSON.parse(fixture("anthropic-search-tool-call.content.json"));

const events = <Event extends { type: string }>(sent: Event[]) =>
    sent.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
// Answers with no search, for a request whose answer a test does not read.
const OPENAI_DONE = events([{
  type: "response.completed",
  response: {
    id: "response", status: "completed", output: [],
    usage: { input_tokens: 100, output_tokens: 1, total_tokens: 101 },
  },
}]);
const CLAUDE_DONE = events([
  { type: "message_start", message: {
    id: "msg", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [],
    stop_reason: null, usage: { input_tokens: 100, output_tokens: 0 },
  } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK." } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
  { type: "message_stop" },
]);

const GPT = "gpt-6-luna";
const CLAUDE = "claude-haiku-5-5";
const LOG_URL = "https://api.cloudflare.com/client/v4/accounts/gateway-account-id/ai-gateway/" +
    "gateways/platform-gateway/logs/scripted-log-id";
// What AI Gateway logged for each request, which leaves a search's fee out.
const LOGGED_COST = 1.25;
const SEARCH_FEE = 0.01;

type Body = Record<string, unknown>;
// A queued answer: a stream, sent once `after` settles; what a provider that reads the request
// says to it; or none until the request is aborted.
type Answer = string | { stream: string; after: Promise<void> } | ((body: Body) => Response) |
    "pending";
const SSE = { "content-type": "text/event-stream", "cf-aig-log-id": "scripted-log-id" };

// A provider behind the gateway, which answers each request to `path` with the next queued answer.
function scriptedProvider(path: string) {
  const requests: Body[] = [];
  const answers: Answer[] = [];
  const handler: Handler = async (url, method, _headers, request) => {
    if (method !== "POST" || !url.pathname.endsWith(path)) return null;
    const body: Body = await request.json();
    requests.push(body);
    const answer = answers.shift();
    if (answer === undefined) throw new Error(`${path} received more requests than queued`);
    if (typeof answer === "function") return answer(body);
    if (answer === "pending") {
      const aborted = Promise.withResolvers<Response>();
      request.signal.addEventListener("abort", () => aborted.reject(request.signal.reason),
          { once: true });
      return aborted.promise;
    }
    if (typeof answer !== "string") await answer.after;
    return new Response(typeof answer === "string" ? answer : answer.stream, { headers: SSE });
  };
  return { requests, answers, handler, respond: (...queued: Answer[]) => { answers.push(...queued); } };
}
const openai = scriptedProvider("/openai/responses");
const anthropic = scriptedProvider("/anthropic/v1/messages");
const gatewayLog: Handler = (url, method) => method === "GET" && url.href === LOG_URL
    ? Response.json({ success: true, result: { cost: LOGGED_COST } }) : null;

// The Workers AI model of the turns that are neither GPT's nor Claude's, and of the chats'
// titles: its steps, in the order the cases below take them.
const READ_RESTRICTED = { toolCall: { id: "read-restricted", name: "executeCode", arguments: {
  code: "export default async function(self, env) { console.log(await env.TEST_AMBIENT.readValue(true)); }",
} } };
// A gadget that spawns an agent through the spawner binding a call names.
const SPAWNING_SERVER = `import { DurableObject } from "cloudflare:workers";
export class Gadget extends DurableObject {
  async dispatch(spawner, prompt) {
    await this.env[spawner].spawn("Spawned search", prompt);
  }
}
`;
interface Spawning extends RpcTarget {
  dispatch(spawner: string, prompt: string): Promise<void>;
}
const workersAi = scriptedChatCompletions([
  READ_RESTRICTED, { text: "Read it." },
  { toolCalls: [
    { id: "create-spawning", name: "createGadget",
      arguments: { title: "Spawning", bindingName: "SPAWNING" } },
    { id: "write-spawning", name: "writeFile",
      arguments: { workpiece: "SPAWNING", filename: "server.js", content: SPAWNING_SERVER } },
  ] },
  { text: "Built." },
  { text: "It is 4.167.0." }, READ_RESTRICTED, { text: "Read it." },
]);
const network = new NetworkInterceptor({
  handlers: [gatewayLog, openai.handler, anthropic.handler, workersAi.handler],
});

let harness: Harness;
let admin: RpcStub<AdminApi>;
const fileScope = new DisposableStack();

beforeAll(async () => {
  network.install();
  harness = await startHarness({
    gatekeepers: [
      { binding: TEST_GATEKEEPER_BINDING, dir: TEST_GATEKEEPER_DIR },
      // The fixture gatekeeper again, under Web Search's name: the Workshop tells the Web Search
      // gatekeeper by its binding, and asks it only for its settings and its ambient account.
      {
        binding: WEB_SEARCH_VENDOR_ID.toUpperCase(), dir: TEST_GATEKEEPER_DIR,
        patch: config => { config.name = "gatekeeper-websearch-stand-in"; },
      },
    ],
    enableGadgetExecution: true,
    // The HTTPS transport, whose requests the interceptor answers.
    patchWorkshop: config => {
      config.vars = {
        ...config.vars,
        CF_AI_GATEWAY: "platform-gateway",
        CF_AI_GATEWAY_ACCOUNT_ID: "gateway-account-id",
        CF_AI_GATEWAY_API_TOKEN: "read-run-token",
        CF_AI_GATEWAY_USE_BINDING: "false",
        CF_AI_GATEWAY_PROVIDERS: "cloudflare,openai,anthropic",
      };
    },
  });
  const adminApi = fileScope.use(await signUp(fileScope.use(connect(harness.url)), ADMIN_USERNAME));
  const adminStub = fileScope.use(await adminApi.getAdminApi());
  if (adminStub === null) throw new Error("The deployment admin API was unavailable");
  admin = adminStub;
});

afterAll(async () => {
  try {
    fileScope.dispose();
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
    expect([openai.answers, anthropic.answers, workersAi.remainingSteps()]).toEqual([[], [], 0]);
  } finally {
    network.uninstall();
  }
});

const Tools = z.array(z.looseObject({ type: z.string().optional() }));
const Messages = z.array(z.looseObject({ role: z.string(), content: z.unknown() }));
const Blocks = z.array(z.looseObject({
  type: z.string(), id: z.string().optional(), tool_use_id: z.string().optional(),
}));

// The tools of a request's body, by their `type`: a tool the agent runs itself has none.
const toolTypes = (body: Body | undefined) =>
    Tools.parse(body?.tools ?? []).flatMap(tool => tool.type ?? []);
// The content of each assistant message of an Anthropic request's body, oldest first.
const assistantContents = (body: Body | undefined) => Messages.parse(body?.messages)
    .flatMap(message => message.role === "assistant" ? [message.content] : []);

// Whether Anthropic takes a request's body: no marker, and no search without its result.
function expectSendable(body: Body | undefined): void {
  expect(JSON.stringify(body)).not.toContain("kept-content");
  for (const content of assistantContents(body)) {
    const blocks = Blocks.parse(content);
    const answered = blocks.map(block => block.tool_use_id);
    expect(blocks.filter(block => block.type === "server_tool_use" && !answered.includes(block.id)))
        .toEqual([]);
  }
}

// Chooses the admin's Search provider: WEB_SEARCH_IN_MODEL, or "ceramic", the default.
const chooseSearchProvider = (provider: string) =>
    admin.setGatekeeperSetting(WEB_SEARCH_VENDOR_ID, WEB_SEARCH_PROVIDER_SETTING, provider);

// Gives a user the ambient account of `vendorId`, which their workspaces then bind in each chat.
async function provision(api: RpcStub<AuthenticatedApi>, vendorId: string) {
  await api.provisionAmbientAccount(vendorId);
  return waitFor(`the ${vendorId} account`, async () =>
      (await listConnectedAccounts(api)).find(entry => entry.vendorId === vendorId) ?? null);
}

// GPT's request of a turn, which the queued empty response answers.
async function gptRequest(turn: () => Promise<void>): Promise<Body | undefined> {
  const sent = openai.requests.length;
  openai.respond(OPENAI_DONE);
  await turn();
  await waitFor("GPT's request", async () => openai.requests.length === sent + 1 || null);
  expect(openai.requests).toHaveLength(sent + 1);
  return openai.requests[sent];
}

it("an admin chooses the model's provider for searches, and both model tests send the tool",
    async () => {
  const shown = async () => (await admin.getSettings()).resourceVendors
      .find(vendor => vendor.vendorId === WEB_SEARCH_VENDOR_ID)?.settings;
  const newestRecord = async () =>
      (await admin.listAdminAudit({ kind: "setting", limit: 1 })).records[0];
  expect(await shown()).toMatchObject([{ id: WEB_SEARCH_PROVIDER_SETTING, value: "ceramic" }]);

  // A refused choice is neither stored nor recorded.
  const before = await newestRecord();
  await expect(chooseSearchProvider("bing")).rejects.toThrow();
  await expect(admin.setGatekeeperSetting(WEB_SEARCH_VENDOR_ID, "volume", "ceramic"))
      .rejects.toThrow();
  await expect(admin.setGatekeeperSetting(
      "notinstalled", WEB_SEARCH_PROVIDER_SETTING, WEB_SEARCH_IN_MODEL)).rejects.toThrow();
  expect(await newestRecord()).toEqual(before);
  expect(await shown()).toMatchObject([{ id: WEB_SEARCH_PROVIDER_SETTING, value: "ceramic" }]);

  // Before the choice, a model's test sends no tool.
  const sent = openai.requests.length;
  openai.respond(OPENAI_DONE);
  expect(await admin.testGatewayModel(GPT)).toEqual({ model: GPT, ok: true });
  expect(toolTypes(openai.requests[sent])).toEqual([]);

  await chooseSearchProvider(WEB_SEARCH_IN_MODEL);
  const record = await newestRecord();
  expect(record).toMatchObject({ kind: "setting", method: "setGatekeeperSetting" });
  expect(JSON.stringify(record)).toContain(WEB_SEARCH_IN_MODEL);
  expect(await shown()).toMatchObject(
      [{ id: WEB_SEARCH_PROVIDER_SETTING, value: WEB_SEARCH_IN_MODEL }]);

  // A model's test asks as a turn would, and so does the test of a model before it is added:
  // once with no reasoning level and once at the level it states. A provider's test never does.
  openai.respond(OPENAI_DONE, OPENAI_DONE, OPENAI_DONE, OPENAI_DONE);
  expect(await admin.testGatewayModel(GPT)).toEqual({ model: GPT, ok: true });
  expect(toolTypes(openai.requests[sent + 1])).toEqual(["web_search"]);
  const described: GatewayModel = {
    provider: "openai", id: "gpt-described", name: "GPT Described", contextWindow: 400000,
    capabilities: { reasoningLevels: ["high"] },
  };
  expect((await admin.testNewGatewayModel(described)).map(result => result.ok))
      .toEqual([true, true]);
  expect(openai.requests.slice(sent + 2).map(toolTypes)).toEqual([["web_search"], ["web_search"]]);
  expect((await admin.testGatewayProvider("openai")).ok).toBe(true);
  expect(toolTypes(openai.requests[sent + 4])).toEqual([]);
});

it("a gatekeeper reads the choices stored for its own vendor, and no other vendor's", async () => {
  using publicApi = connect(harness.url);
  using api = await signUp(publicApi, nextUsernames("builtinsearchsettings")[0]!);
  using ws = await api.newWorkspace();
  const webSearchAccount = await provision(api, WEB_SEARCH_VENDOR_ID);
  const testAccount = await provision(api, TEST_VENDOR_ID);
  using webSearch = await ws.newGatekeeper(
      webSearchAccount.id, "https://gadgets-test.example/things/web-search");
  using test = await ws.newGatekeeper(testAccount.id, "https://gadgets-test.example/things/test");
  if (webSearch === null || test === null) throw new Error("A test connection was not created");
  using webSearchSession = await webSearch.openSession() as RpcStub<TestSession>;
  using testSession = await test.openSession() as RpcStub<TestSession>;

  // The Search provider is Web Search's choice. The other vendor declares a setting of the same
  // name, and reads nothing of it.
  expect(await webSearchSession.readAdminSettings())
      .toEqual({ [WEB_SEARCH_PROVIDER_SETTING]: WEB_SEARCH_IN_MODEL });
  expect(await testSession.readAdminSettings()).toEqual({});

  // A choice reaches a session that is already open, and a default is stored as nothing.
  try {
    await admin.setGatekeeperSetting(
        TEST_VENDOR_ID, WEB_SEARCH_PROVIDER_SETTING, WEB_SEARCH_IN_MODEL);
    await chooseSearchProvider("ceramic");
    expect(await testSession.readAdminSettings())
        .toEqual({ [WEB_SEARCH_PROVIDER_SETTING]: WEB_SEARCH_IN_MODEL });
    expect(await webSearchSession.readAdminSettings()).toEqual({});
  } finally {
    await admin.setGatekeeperSetting(TEST_VENDOR_ID, WEB_SEARCH_PROVIDER_SETTING, "ceramic");
    await chooseSearchProvider(WEB_SEARCH_IN_MODEL);
  }
  expect(await testSession.readAdminSettings()).toEqual({});
});

it("a GPT turn's search is in Activity and the chat, and its fee is added to the logged cost",
    async () => {
  using publicApi = connect(harness.url);
  using api = await signUp(publicApi, nextUsernames("builtinsearch")[0]!);
  await provision(api, WEB_SEARCH_VENDOR_ID);
  using ws = await api.newWorkspace();
  openai.respond(OPENAI_SEARCH);
  const sent = openai.requests.length;
  const chatId = await ws.newChat("What is the latest stable release of Wrangler?", GPT);
  await waitForIdleChat(ws, chatId);

  expect(openai.requests.slice(sent).map(toolTypes)).toEqual([["web_search"]]);
  expect(openai.requests[sent]?.max_tool_calls).toBe(5);

  // The search and the page the tool read, newest first, each a row after the step's message.
  const { entries } = await ws.listActions();
  expect(entries.map(entry => [entry.type, entry.state, entry.resourceUrl])).toEqual([
    ["observation", "approved", "https://github.com/cloudflare/workers-sdk/releases"],
    ["observation", "approved", undefined],
  ]);
  expect(JSON.stringify(entries[1])).toContain("Cloudflare Wrangler CLI latest stable release");
  const history = await loadAllChatHistory(before => ws.getChatHistory(chatId, before));
  const answered = history.findIndex(
      message => message.type === "message" && message.author.type === "agent");
  expect(history.slice(answered + 1)).toMatchObject(
      entries.toReversed().map(entry => ({ type: "action", actionId: entry.id })));

  const cost = await waitFor("the logged cost", async () => {
    const total = (await ws.listChats()).find(chat => chat.id === chatId)?.totalCost;
    return total !== undefined && total >= LOGGED_COST ? total : null;
  });
  expect(cost).toBeCloseTo(LOGGED_COST + SEARCH_FEE, 10);
});

it("a chat without Web Search, a restricted workspace, a user's own model and another Search " +
    "provider get no tool", async () => {
  // A user who holds another gatekeeper's ambient account, and not Web Search's.
  using otherPublicApi = connect(harness.url);
  using other = await signUp(otherPublicApi, nextUsernames("builtinsearchnone")[0]!);
  await provision(other, TEST_VENDOR_ID);
  using otherWs = await other.newWorkspace();
  expect(toolTypes(await gptRequest(async () => {
    await waitForIdleChat(otherWs, await otherWs.newChat("Search the web.", GPT));
  }))).not.toContain("web_search");

  using publicApi = connect(harness.url);
  using api = await signUp(publicApi, nextUsernames("builtinsearchoff")[0]!);
  await provision(api, WEB_SEARCH_VENDOR_ID);

  // The tool is offered until the workspace reads restricted data, here on another model's turn.
  using ws = await api.newWorkspace();
  let chatId = -1;
  expect(toolTypes(await gptRequest(async () => {
    chatId = await ws.newChat("What is the latest Wrangler release?", GPT);
    await waitForIdleChat(ws, chatId);
  }))).toContain("web_search");
  await ws.sendChatMessage(chatId, "Read the restricted value.", SCRIPTED_MODEL_ID);
  await waitFor("the other model's turn", async () => workersAi.remainingSteps() === 5 || null);
  await waitForIdleChat(ws, chatId);
  expect((await ws.getMetadata()).containsRestrictedData).toBe(true);
  expect(toolTypes(await gptRequest(async () => {
    await ws.sendChatMessage(chatId, "And the release before it?", GPT);
    await waitFor("GPT's turn", async () => openai.answers.length === 0 || null);
    await waitForIdleChat(ws, chatId);
  }))).not.toContain("web_search");

  // A user cannot give a model of their own the setting.
  const mine = { type: "agent" as const, id: "builtinsearch-mine", name: "Mine" };
  const config: AiModelConfig = { provider: "openai", model: GPT, apiToken: "", webSearch: true };
  await api.addModel(mine, config);
  expect((await api.getModelConfig(mine.id)).config).not.toHaveProperty("webSearch");
  using ownWs = await api.newWorkspace();
  expect(toolTypes(await gptRequest(async () => {
    await waitForIdleChat(ownWs, await ownWs.newChat("Search the web.", mine.id));
  }))).not.toContain("web_search");

  // Under another Search provider, the gateway model's turns carry none either.
  await chooseSearchProvider("ceramic");
  try {
    using offWs = await api.newWorkspace();
    expect(toolTypes(await gptRequest(async () => {
      await waitForIdleChat(offWs, await offWs.newChat("Search the web.", GPT));
    }))).not.toContain("web_search");
  } finally {
    await chooseSearchProvider(WEB_SEARCH_IN_MODEL);
  }
});

// A spawned agent holds the bindings its spawner gave it and those its chat gains, and no other
// of the workspace's.
it("an agent a gadget spawns gets the tool only once its chat holds Web Search, from its " +
    "spawner or pasted by a user", async () => {
  using publicApi = connect(harness.url);
  using api = await signUp(publicApi, nextUsernames("builtinsearchspawn")[0]!);
  await provision(api, WEB_SEARCH_VENDOR_ID);
  using ws = await api.newWorkspace();

  const building = await ws.newChat("Build the spawning gadget.", SCRIPTED_MODEL_ID);
  await waitFor("the gadget's code", async () => workersAi.remainingSteps() === 3 || null);
  await waitForIdleChat(ws, building);
  expect((await ws.mergeChanges(building)).outcome).toBe("merged");
  const workpieces = new WorkpieceRecorder();
  using workpiecesStub = stubFor(workpieces);
  using _workpieces = await ws.subscribeToWorkpieces(workpiecesStub);
  await workpieces.loaded;
  const built = [...workpieces.summaries.values()]
      .find(summary => summary.type === "gadget" && summary.title === "Spawning");
  if (built === undefined) throw new Error("The Spawning gadget was not created");

  // The workspace's ambient record of Web Search, which only an admin's view lists by vendor.
  let webSearchId: number | undefined;
  {
    using view = await admin.inspectWorkspace((await ws.getMetadata()).id, "Built-in search test");
    webSearchId = (await view.listGatekeepers())
        .find(record => record.vendorId === WEB_SEARCH_VENDOR_ID)?.id;
  }
  if (webSearchId === undefined) throw new Error("The workspace holds no Web Search record");
  using webSearch = await ws.getGatekeeperById(webSearchId);

  using gadget = await ws.getGadget(built.id);
  using bare = await ws.newAgentSpawnerGatekeeper(
      { displayName: "Bare spawner", modelId: GPT, env: {} });
  using searching = await ws.newAgentSpawnerGatekeeper(
      { displayName: "Searching spawner", modelId: GPT, env: { WEB_SEARCH: webSearchId } });
  await gadget.bind("BARE", await bare.getId());
  await gadget.bind("SEARCHING", await searching.getId());
  using spawning = await gadget.connectToGadget() as RpcStub<Spawning>;
  // The chat of the agent a spawner's call starts, once its first request is answered.
  const spawnedBy = async (binding: string, spawnerName: string) => {
    await spawning.dispatch(binding, "Search the web.");
    const spawned = await waitFor("the spawned agent's chat", async () =>
        (await ws.listChats()).find(chat => chat.spawnerName === spawnerName) ?? null);
    await waitFor("the spawned agent's request", async () => openai.answers.length === 0 || null);
    await waitForIdleChat(ws, spawned.id);
    return spawned.id;
  };

  let spawnedId = -1;
  expect(toolTypes(await gptRequest(async () => {
    spawnedId = await spawnedBy("BARE", "Bare spawner");
  }))).not.toContain("web_search");

  // The workspace's owner pastes Web Search into that chat, which then holds it.
  const pasting = "Search with [0].";
  expect(toolTypes(await gptRequest(async () => {
    await ws.sendChatMessage(spawnedId, pasting, GPT, { capsules: [{
      position: pasting.indexOf("[0]"), length: "[0]".length, gatekeeperId: webSearchId,
      description: await webSearch.describe(), vendorId: WEB_SEARCH_VENDOR_ID,
    }] });
    await waitFor("the agent's next request", async () => openai.answers.length === 0 || null);
    await waitForIdleChat(ws, spawnedId);
  }))).toContain("web_search");

  // A spawner that gives its agents Web Search.
  expect(toolTypes(await gptRequest(async () => {
    await spawnedBy("SEARCHING", "Searching spawner");
  }))).toContain("web_search");

  // The workspace holds Web Search, and a chat of its own searches in the model.
  expect(toolTypes(await gptRequest(async () => {
    await waitForIdleChat(ws, await ws.newChat("Search the web.", GPT));
  }))).toContain("web_search");
});

// Anthropic refuses a response that thought and searched unless the next request sends it back
// as it was, and pi writes it without the search. So the Workshop keeps what Anthropic sent.
it("a Claude chat goes on after a search: on another model, restricted, and after the admin " +
    "chooses Ceramic again", async () => {
  using publicApi = connect(harness.url);
  using api = await signUp(publicApi, nextUsernames("builtinsearchclaude")[0]!);
  await provision(api, WEB_SEARCH_VENDOR_ID);
  using ws = await api.newWorkspace();
  const sent = anthropic.requests.length;
  anthropic.respond(CLAUDE_ANSWER);
  const chatId = await ws.newChat("What is the latest stable release of Wrangler?", CLAUDE);
  await waitForIdleChat(ws, chatId);

  expect(toolTypes(anthropic.requests[sent])).toEqual(["web_search_20250305"]);
  // One observation, with the row after the answer, which ends with the page it cites.
  const { entries } = await ws.listActions();
  expect(entries).toMatchObject([{ type: "observation", state: "approved" }]);
  expect(JSON.stringify(entries)).toContain("Wrangler CLI latest stable release");
  expect(JSON.stringify(entries)).toContain("https://www.npmjs.com/package/wrangler");
  const [, answer, row] = await loadAllChatHistory(before => ws.getChatHistory(chatId, before));
  expect(answer).toMatchObject({ type: "message", message: expect.stringMatching(
      /\n\nSources: \[npmjs\.com\]\(https:\/\/www\.npmjs\.com\/package\/wrangler\)$/) });
  expect(row).toMatchObject({ type: "action", actionId: entries[0]?.id });
  const cost = await waitFor("the logged cost", async () => {
    const total = (await ws.listChats()).find(chat => chat.id === chatId)?.totalCost;
    return total !== undefined && total >= LOGGED_COST ? total : null;
  });
  expect(cost).toBeCloseTo(LOGGED_COST + SEARCH_FEE, 10);

  // Another model reads the answer without the search, then restricts the workspace.
  const others = workersAi.requests.length;
  await ws.sendChatMessage(chatId, "Which release is that?", SCRIPTED_MODEL_ID);
  await waitFor("the other model's answer", async () => workersAi.remainingSteps() === 2 || null);
  await waitForIdleChat(ws, chatId);
  expect(JSON.stringify(workersAi.requests[others])).toContain("4.167.0");
  expect(JSON.stringify(workersAi.requests[others])).not.toContain("web_search_tool_result");
  expect(JSON.stringify(workersAi.requests[others])).not.toContain("kept-content");
  await ws.sendChatMessage(chatId, "Read the restricted value.", SCRIPTED_MODEL_ID);
  await waitFor("the restricted read", async () => workersAi.remainingSteps() === 0 || null);
  await waitForIdleChat(ws, chatId);
  expect((await ws.getMetadata()).containsRestrictedData).toBe(true);

  // Claude again, with Ceramic as the Search provider too: no tool, and its own response as
  // Anthropic sent it.
  await chooseSearchProvider("ceramic");
  try {
    anthropic.respond(CLAUDE_DONE);
    await ws.sendChatMessage(chatId, "Thanks.", CLAUDE);
    await waitFor("Claude's request", async () => anthropic.requests.length === sent + 2 || null);
    await waitForIdleChat(ws, chatId);
  } finally {
    await chooseSearchProvider(WEB_SEARCH_IN_MODEL);
  }
  const next = anthropic.requests[sent + 1];
  expect(toolTypes(next)).toEqual([]);
  expect(JSON.stringify(assistantContents(next)[0])).toBe(JSON.stringify(CLAUDE_ANSWER_CONTENT));
  expectSendable(next);
  const history = await loadAllChatHistory(before => ws.getChatHistory(chatId, before));
  expect(history.at(-1)).toMatchObject({ type: "message", message: "OK." });
});


it("a steer and Stop after Claude searched beside a tool call leave requests Anthropic takes",
    async () => {
  using publicApi = connect(harness.url);
  using api = await signUp(publicApi, nextUsernames("builtinsearchsteer")[0]!);
  await provision(api, WEB_SEARCH_VENDOR_ID);
  using ws = await api.newWorkspace();
  const sent = anthropic.requests.length;
  const kept = JSON.stringify(CLAUDE_TOOL_CALL_CONTENT);

  // The steer is sent while the response that searches and calls listBlueprints is on its way,
  // so it follows the tool's result. Then the user stops the turn in its next request.
  const answer = Promise.withResolvers<void>();
  anthropic.respond({ stream: CLAUDE_TOOL_CALL, after: answer.promise }, "pending");
  const chatId = await ws.newChat("Find Wrangler's latest release, then list the blueprints.", CLAUDE);
  await waitFor("the first request", async () => anthropic.requests.length === sent + 1 || null);
  await ws.sendChatMessage(chatId, "Check Bun too.", CLAUDE);
  answer.resolve();
  await waitFor("the request after the tool", async () =>
      anthropic.requests.length === sent + 2 || null);
  const steered = anthropic.requests[sent + 1];
  expect(JSON.stringify(steered)).toContain("Check Bun too.");
  expect(JSON.stringify(assistantContents(steered)[0])).toBe(kept);
  expectSendable(steered);

  await ws.stopAgent(chatId);
  await waitForIdleChat(ws, chatId);
  anthropic.respond(CLAUDE_DONE);
  await ws.sendChatMessage(chatId, "Go on.", CLAUDE);
  await waitFor("the turn after Stop", async () => anthropic.requests.length === sent + 3 || null);
  await waitForIdleChat(ws, chatId);
  const resumed = anthropic.requests[sent + 2];
  expect(JSON.stringify(resumed)).toContain("Go on.");
  expect(JSON.stringify(assistantContents(resumed)[0])).toBe(kept);
  expectSendable(resumed);
  expect(anthropic.requests.slice(sent).map(toolTypes))
      .toEqual(Array.from({ length: 3 }, () => ["web_search_20250305"]));
});
