import { afterAll, beforeAll, expect, it } from "vitest";
import type {
  GadgetResponse, SubmitExternalMessageInput, SubmitExternalMessageResult,
} from "@gadgets/workshop-shared/external-message-gateway";
import {
  startTestGatekeeperHarness, TEST_GATEKEEPER_WORKER, type Harness,
} from "../src/harness.js";
import { scriptedModelRouter } from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, logIn, nextUsernames, signUp, waitFor } from "../src/rpc-client.js";

let harness: Harness;
const models = scriptedModelRouter();
const network = new NetworkInterceptor({ handlers: [models.handler] });

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

async function control<T>(route: string, body: unknown): Promise<T> {
  const response = await harness.fetchWorker(
      TEST_GATEKEEPER_WORKER, `http://gatekeeper-test.test/control/${route}`,
      { method: "POST", body: JSON.stringify(body) });
  if (response.status !== 200) {
    throw new Error(`${route} failed with ${response.status}: ${await response.text()}`);
  }
  return await response.json() as T;
}

function submitExternalMessage(input: Omit<SubmitExternalMessageInput, "chatGatewayRpcTarget">) {
  return control<SubmitExternalMessageResult>("submit-external-message", input);
}

/** Distinct reply texts: delivery is at-least-once, so a reply may repeat but never differ. */
async function replies(messageKey: string): Promise<string[]> {
  const { responses } = await control<{ responses: GadgetResponse[] }>(
      "gadget-responses", { messageKey });
  return [...new Set(responses.map(response => response.text))];
}

const awaitReplies = (messageKey: string) => waitFor(`a reply to ${messageKey}`, async () => {
  const texts = await replies(messageKey);
  return texts.length > 0 ? texts : null;
});

async function externalGadgetId(gadgetKey: string): Promise<string> {
  return (await control<{ gadgetId: string }>("external-gadget-id", { gadgetKey })).gadgetId;
}

it.concurrent("an external message gets one reply, and a reused idempotency key starts nothing",
    async () => {
  const model = models.script([{ text: "First reply." }, { text: "Second reply." }]);
  const [owner] = nextUsernames("owner");
  const gadgetKey = `${owner}-gadget`;
  const chatKey = `${owner}-chat`;
  const firstKey = `${owner}-m1`;
  const secondKey = `${owner}-m2`;
  using publicApi = connect(harness.url);
  using api = await signUp(publicApi, owner);
  await api.addModel(model.userModel.profile, model.userModel.config);

  const firstInput = {
    callerEmail: owner,
    gadgetKey,
    chatKey,
    messageKey: firstKey,
    gadgetTitle: gadgetKey,
    prompt: "Hello",
  };
  const first = await submitExternalMessage(firstInput);
  if (!first.accepted) throw new Error(`External message was rejected: ${first.message}`);
  expect(await awaitReplies(firstKey)).toEqual(["First reply."]);

  await expect(submitExternalMessage(firstInput)).resolves.toEqual({
    accepted: true,
    chatPath: first.chatPath,
  });

  const second = await submitExternalMessage({
    ...firstInput,
    messageKey: secondKey,
    prompt: "Again",
  });
  expect(second).toEqual({ accepted: true, chatPath: first.chatPath });
  expect(await awaitReplies(secondKey)).toEqual(["Second reply."]);

  expect(model.requests).toHaveLength(2);
  expect(await replies(firstKey)).toEqual(["First reply."]);
  expect(model.remainingSteps()).toBe(0);
});

it.concurrent("deleting the chat while a reply is pending sends the terminal text", async () => {
  const model = models.script([{ pending: true }]);
  const [owner] = nextUsernames("owner");
  const gadgetKey = `${owner}-gadget`;
  const chatKey = `${owner}-chat`;
  const messageKey = `${owner}-m1`;
  using publicApi = connect(harness.url);
  using api = await signUp(publicApi, owner);
  await api.addModel(model.userModel.profile, model.userModel.config);

  const result = await submitExternalMessage({
    callerEmail: owner,
    gadgetKey,
    chatKey,
    messageKey,
    gadgetTitle: gadgetKey,
    prompt: "Wait for a reply",
  });
  if (!result.accepted) throw new Error(`External message was rejected: ${result.message}`);
  await waitFor("the pending model request", async () => model.requests.length === 1 ? true : null);

  const gadgetId = await externalGadgetId(gadgetKey);
  const chatId = Number(new URL(result.chatPath, harness.url).searchParams.get("chat"));
  if (!Number.isInteger(chatId)) throw new Error(`Invalid external chat path: ${result.chatPath}`);
  using freshPublicApi = connect(harness.url);
  using freshApi = await logIn(freshPublicApi, owner);
  using ws = await freshApi.openGadget(gadgetId);
  await ws.deleteChat(chatId);

  expect(await awaitReplies(messageKey))
      .toEqual(["The chat was deleted before the agent responded."]);
  expect(model.requests).toHaveLength(1);
});
