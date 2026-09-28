import { afterAll, beforeAll, expect, it } from "vitest";
import type { AiModelConfig } from "@gadgets/workshop-shared/api";
import { loadAllChatHistory } from "../src/agent-session.js";
import { type Harness, startHarness } from "../src/harness.js";
import { scriptedChatCompletions } from "../src/mock-model.js";
import { type Handler, NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, nextUsernames, signUp, waitForIdleChat } from "../src/rpc-client.js";

const MODEL_ORIGIN = "https://model-secrets.test";
const TOKEN = "model-token-secret";
const HEADER_SECRET = "header-secret";

const model = scriptedChatCompletions([{ text: "Secrets retained." }]);
const providerRequests: { authorization: string | null; providerSecret: string | null }[] = [];
// The only handler, so a request sent anywhere else is recorded as unmocked.
const recordingHandler: Handler = (url, method, headers, request) => {
  if (url.origin !== MODEL_ORIGIN) return null;
  providerRequests.push({
    authorization: headers.get("authorization"),
    providerSecret: headers.get("x-provider-secret"),
  });
  return model.handler(url, method, headers, request);
};
const network = new NetworkInterceptor({ handlers: [recordingHandler] });

let harness: Harness | undefined;

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

it("editing a model keeps its secrets usable without returning them", async () => {
  if (harness === undefined) throw new Error("Workshop harness did not start");
  const [name] = nextUsernames("modelsecrets");
  using publicApi = connect(harness.url);
  using api = await signUp(publicApi, name);
  // Gateway routing ignores a model's own credentials.
  expect(await api.getAiConfig()).toEqual({ enabled: false });

  const PROFILE = { type: "agent" as const, id: "secret-model", name: "Secret model" };
  const config: AiModelConfig = {
    provider: "ollama",
    model: "secret-model",
    apiUrl: MODEL_ORIGIN,
    apiToken: TOKEN,
    extraHeaders: { "X-Provider-Secret": HEADER_SECRET, "X-Empty": "" },
  };
  await api.addModel(PROFILE, config);
  const redacted = { ...config, apiToken: null, extraHeaders: { "X-Provider-Secret": null, "X-Empty": "" } };
  expect(await api.getModelConfig(PROFILE.id)).toEqual({ profile: PROFILE, config: redacted });

  const RENAMED = { ...PROFILE, name: "Renamed secret model" };
  await api.updateModel(RENAMED, { ...redacted, contextWindow: 1000 });
  expect(await api.listModels()).toContainEqual(RENAMED);
  expect(await api.getModelConfig(PROFILE.id))
      .toEqual({ profile: RENAMED, config: { ...redacted, contextWindow: 1000 } });

  await expect(api.updateModel(RENAMED,
      { ...redacted, contextWindow: 1000, apiUrl: "https://attacker.test" }))
      .rejects.toThrow(/since the provider or API URL changed/);

  using ws = await api.newGadget();
  const chatId = await ws.newChat("Prove the saved credentials work.", PROFILE.id);
  await waitForIdleChat(ws, chatId);
  const history = await loadAllChatHistory(before => ws.getChatHistory(chatId, before));
  expect(history.filter(message => message.type === "message" && message.author.type === "agent"))
      .toEqual([expect.objectContaining({ message: "Secrets retained." })]);
  expect(model.requests).toHaveLength(1);
  for (const request of providerRequests) {
    expect(request).toEqual({ authorization: `Bearer ${TOKEN}`, providerSecret: HEADER_SECRET });
  }
});
