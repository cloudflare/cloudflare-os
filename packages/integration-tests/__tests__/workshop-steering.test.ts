import { afterAll, beforeAll, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import type { AiChatMessage, Overseer } from "@gadgets/workshop-shared/api";
import { loadAllChatHistory } from "../src/agent-session.js";
import {
  settleRestart, startTestGatekeeperHarness, TEST_VENDOR_ID, type Harness,
} from "../src/harness.js";
import {
  SCRIPTED_MODEL_ID, scriptedModelRouter, type ChatCompletionStep, type RoutedScriptedModel,
} from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  connect, nextUsernames, restartWorkspace, signUp, waitFor, waitForIdleChat, withOwnerWorkspace,
} from "../src/rpc-client.js";

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

const PROMPT = "Build a habit tracker.";
const STEER = "Make it dark, with an orange accent.";

const history = (ws: RpcStub<Overseer>, chatId: number) =>
  loadAllChatHistory(before => ws.getChatHistory(chatId, before));

const transcript = (messages: AiChatMessage[]) => messages.flatMap(message =>
  message.type === "message"
    ? [{ author: message.author.type, text: message.message, steered: message.steered }]
    : []);

const prompted = (text: string) => ({ author: "user", text, steered: undefined });
const steered = (text: string) => ({ author: "user", text, steered: true });
const reply = (text: string) => ({ author: "agent", text, steered: undefined });

/** Signs up a fresh user and starts a chat whose agent runs `script`, steering it once. */
async function steerChat(usernamePrefix: string, script: readonly ChatCompletionStep[],
    test: (ws: RpcStub<Overseer>, chatId: number, model: RoutedScriptedModel) => Promise<void>) {
  const model = models.script(script);
  const [username] = nextUsernames(usernamePrefix);
  using publicApi = connect(harness.url);
  using api = await signUp(publicApi, username!);
  await api.addModel(model.userModel.profile, model.userModel.config);
  using ws = await api.newGadget();
  const chatId = await ws.newChat(PROMPT, SCRIPTED_MODEL_ID);
  await waitFor("the first model request", async () => model.requests.length === 1 || null);
  await ws.sendChatMessage(chatId, STEER, SCRIPTED_MODEL_ID);
  await test(ws, chatId, model);
  return { username: username!, chatId, model };
}

it.concurrent("a message sent while the agent works is read at its next step", async () => {
  const answer = Promise.withResolvers<void>();
  await steerChat("steerstep", [
    { text: "Building the tracker.", after: answer.promise },
    { text: "Switched to a dark theme." },
  ], async (ws, chatId, model) => {
    answer.resolve();
    await waitForIdleChat(ws, chatId);

    expect(model.requests).toHaveLength(2);
    expect(JSON.stringify(model.requests[1])).toContain(STEER);
    expect(model.remainingSteps()).toBe(0);
    expect(transcript(await history(ws, chatId))).toEqual([
      prompted(PROMPT),
      reply("Building the tracker."),
      steered(STEER),
      reply("Switched to a dark theme."),
    ]);
  });
});

it.concurrent("stopping the agent discards the steers it never read and hands them back",
    async () => {
  await steerChat("steerstop", [{ pending: true }, { text: "Started over." }],
      async (ws, chatId, model) => {
    expect(await ws.stopAgent(chatId)).toEqual([STEER]);
    await waitForIdleChat(ws, chatId);
    expect(model.requests).toHaveLength(1);

    await ws.sendChatMessage(chatId, "Start over.", SCRIPTED_MODEL_ID);
    await waitFor("the next turn's model request", async () => model.requests.length === 2 || null);
    await waitForIdleChat(ws, chatId);

    expect(JSON.stringify(model.requests[1])).not.toContain(STEER);
    expect(transcript(await history(ws, chatId))).toEqual([
      prompted(PROMPT),
      prompted("Start over."),
      reply("Started over."),
    ]);
  });
});

it.concurrent("stopping the agent sends a collaborator's unread steer as the next prompt",
    async () => {
  const theirs = "Add a streak counter.";
  await steerChat("steerstopshared", [{ pending: true }, { text: "Added a streak counter." }],
      async (ws, chatId, model) => {
    const [name] = nextUsernames("steerstopcollaborator");
    using publicApi = connect(harness.url);
    using api = await signUp(publicApi, name!);
    await api.addModel(model.userModel.profile, model.userModel.config);
    if (!await ws.addCollaborator(name!, "build")) throw new Error(`Failed to share with ${name}`);
    using shared = await api.openGadget((await ws.getMetadata()).id);
    await shared.sendChatMessage(chatId, theirs, SCRIPTED_MODEL_ID);

    expect(await ws.stopAgent(chatId)).toEqual([STEER]);
    await waitFor("the next turn's model request", async () => model.requests.length === 2 || null);
    await waitForIdleChat(ws, chatId);

    expect(JSON.stringify(model.requests[1])).toContain(theirs);
    expect(JSON.stringify(model.requests[1])).not.toContain(STEER);
    expect(transcript(await history(ws, chatId))).toEqual([
      prompted(PROMPT),
      prompted(theirs),
      reply("Added a streak counter."),
    ]);
  });
});

it.concurrent("a steer the turn never read prompts the next turn", async () => {
  // A request the turn does not retry, so it ends on the error without reading the steer.
  const failure = Promise.withResolvers<void>();
  await steerChat("steerdrain", [
    { error: { status: 400, message: "scripted invalid request" }, after: failure.promise },
    { text: "Switched to a dark theme." },
  ], async (ws, chatId, model) => {
    failure.resolve();
    await waitFor("the steer's own turn", async () => model.requests.length === 2 || null);
    await waitForIdleChat(ws, chatId);

    expect(JSON.stringify(model.requests[1])).toContain(STEER);
    const messages = await history(ws, chatId);
    const error = messages.findIndex(message => message.type === "error");
    const steer = messages.findIndex(message => message.type === "message" && message.message === STEER);
    expect(error).toBeGreaterThan(-1);
    expect(steer).toBeGreaterThan(error);
    expect(transcript(messages)).toEqual([
      prompted(PROMPT),
      prompted(STEER),
      reply("Switched to a dark theme."),
    ]);
  });
});

it.concurrent("a steer sent before the turn stops on a decision waits for that decision",
    async () => {
  const request = Promise.withResolvers<void>();
  await steerChat("steerdecision", [
    { toolCall: { id: "connect", name: "requestConnection", arguments: {
      vendorId: TEST_VENDOR_ID, reason: "Store the habits.", bindingName: "HABITS",
    } }, after: request.promise },
    { text: "Dark, and without the connection." },
  ], async (ws, chatId, model) => {
    request.resolve();
    const card = await waitFor("the connection request", async () =>
      (await history(ws, chatId)).find(message => message.type === "connectionRequest") ?? null);
    if (card.type !== "connectionRequest") throw new Error("Not a connection request");
    await waitForIdleChat(ws, chatId);

    expect(model.requests).toHaveLength(1);
    expect(transcript(await history(ws, chatId))).toEqual([
      prompted(PROMPT),
      reply(""), // the step that requested the connection
      steered(STEER),
    ]);

    await ws.denyConnectionRequest(card.requestId);
    await ws.sendChatMessage(chatId, "Go on.", SCRIPTED_MODEL_ID);
    await waitFor("the next turn's model request", async () => model.requests.length === 2 || null);
    await waitForIdleChat(ws, chatId);
    expect(JSON.stringify(model.requests[1])).toContain(STEER);
  });
});

it.concurrent("a steer waiting when the workspace restarts is read by the resumed turn",
    async () => {
  const { username, chatId, model } = await steerChat("steerrestart", [
    { pending: true },
    { text: "Switched to a dark theme." },
  ], async ws => {
    await restartWorkspace(harness.url, ws);
    await settleRestart();
  });

  await withOwnerWorkspace(harness.url, username, async ws => {
    await waitFor("the resumed turn's model request", async () =>
      model.requests.length === 2 || null);
    await waitForIdleChat(ws, chatId);

    expect(JSON.stringify(model.requests[1])).toContain(STEER);
    expect(transcript(await history(ws, chatId))).toEqual([
      prompted(PROMPT),
      steered(STEER),
      reply("Switched to a dark theme."),
    ]);
  });
});
