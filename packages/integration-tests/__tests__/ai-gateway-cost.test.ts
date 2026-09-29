import { afterAll, beforeAll, expect, it } from "vitest";
import { startHarness, type Harness } from "../src/harness.js";
import { SCRIPTED_MODEL_ID, scriptedChatCompletions } from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, nextUsernames, signUp, waitFor, waitForIdleChat } from "../src/rpc-client.js";

const LOG_URL = "https://api.cloudflare.com/client/v4/accounts/gateway-account-id/ai-gateway/gateways/" +
    "platform-gateway/logs/scripted-log-id";

const model = scriptedChatCompletions([{ text: "Charged reply." }]);
let logReads = 0;
const network = new NetworkInterceptor({
  handlers: [async (url, method, headers, request) => {
    if (method === "GET" && url.href === LOG_URL) {
      // Logs land after the response, so the first read misses and the Workshop must retry.
      return logReads++ === 0
        ? new Response("not yet", { status: 404 })
        : Response.json({ success: true, result: { cost: 1.25 } });
    }
    const response = await model.handler(url, method, headers, request);
    return response && new Response(response.body, {
      status: response.status,
      headers: { ...Object.fromEntries(response.headers), "cf-aig-log-id": "scripted-log-id" },
    });
  }],
});
let harness: Harness;

beforeAll(async () => {
  network.install();
  harness = await startHarness({
    gatekeepers: [],
    // The HTTPS transport reads the log with a plain fetch the interceptor answers.
    patchWorkshop: config => {
      config.vars = {
        ...config.vars,
        CF_AI_GATEWAY: "platform-gateway",
        CF_AI_GATEWAY_ACCOUNT_ID: "gateway-account-id",
        CF_AI_GATEWAY_API_TOKEN: "read-run-token",
        CF_AI_GATEWAY_USE_BINDING: "false",
        CF_AI_GATEWAY_PROVIDERS: "cloudflare",
      };
    },
  });
});

afterAll(async () => {
  try {
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

it("a chat is charged the AI Gateway log's cost in place of the estimate", async () => {
  using publicApi = connect(harness.url);
  using api = await signUp(publicApi, nextUsernames("gatewaycost")[0]!);
  using ws = await api.newGadget();

  const chatId = await ws.newChat("What does this cost?", SCRIPTED_MODEL_ID);
  await waitForIdleChat(ws, chatId);
  await waitFor("the gateway cost", async () =>
    (await ws.listChats()).find(chat => chat.id === chatId)?.totalCost === 1.25 || null);
  expect((await ws.getMetadata()).totalCost).toBe(1.25);
  expect(logReads).toBe(2);
});
