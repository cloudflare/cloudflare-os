import { afterAll, beforeAll, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import type {
  AiChatMessage, AiChatMetadata, AiChatSubscriber, AuthenticatedApi, Overseer,
} from "@gadgets/workshop-shared/api";
import { loadAllChatHistory } from "../src/agent-session.js";
import {
  settleRestart, startTestGatekeeperHarness, TEST_VENDOR_ID, type Harness,
} from "../src/harness.js";
import {
  SCRIPTED_MODEL_ID, scriptedModelRouter, type ChatCompletionStep, type RoutedScriptedModel,
} from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  connect, listConnectedAccounts, nextUsernames, restartWorkspace, RpcTarget, signUp, stubFor,
  waitFor, waitForIdleChat, withOwnerWorkspace,
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

/** The chat metadata a subscriber is told of, in order. */
class MetadataRecorder extends RpcTarget implements AiChatSubscriber {
  readonly states: AiChatMetadata[] = [];
  streamGeneration() {}
  metadata(chat: AiChatMetadata) { this.states.push(chat); }
  deleted() {}
  message() {}
  changeApplied() {}
  stream() {}
}

const queued = (chat: AiChatMetadata | undefined) => chat?.queuedSteers?.map(steer => steer.text);

/** Signs up a fresh user and starts a chat whose agent runs `script`, steering it once. */
async function steerChat(usernamePrefix: string, script: readonly ChatCompletionStep[],
    test: (ws: RpcStub<Overseer>, chatId: number, model: RoutedScriptedModel,
           api: RpcStub<AuthenticatedApi>) => Promise<void>) {
  const model = models.script(script);
  const [username] = nextUsernames(usernamePrefix);
  using publicApi = connect(harness.url);
  using api = await signUp(publicApi, username!);
  await api.addModel(model.userModel.profile, model.userModel.config);
  using ws = await api.newWorkspace();
  const chatId = await ws.newChat(PROMPT, SCRIPTED_MODEL_ID);
  await waitFor("the first model request", async () => model.requests.length === 1 || null);
  await ws.sendChatMessage(chatId, STEER, SCRIPTED_MODEL_ID);
  await test(ws, chatId, model, api);
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

it.concurrent("every member sees the queued steers, and stopping the agent drops them all",
    async () => {
  const theirs = "Add a streak counter.";
  await steerChat("steerstop", [{ pending: true }, { text: "Started over." }],
      async (ws, chatId, model) => {
    const [name] = nextUsernames("steerstopcollaborator");
    using publicApi = connect(harness.url);
    // A collaborator without the running turn's model can still steer it.
    using api = await signUp(publicApi, name!);
    if (!await ws.addCollaborator(name!, "build")) throw new Error(`Failed to share with ${name}`);
    using shared = await api.openWorkspace((await ws.getMetadata()).id);
    const before = (await shared.listChats()).find(chat => chat.id === chatId);
    expect(queued(before)).toEqual([STEER]);

    const live = new MetadataRecorder();
    using liveStub = stubFor(live);
    using _live = await shared.subscribeToChat(liveStub);
    await shared.sendChatMessage(chatId, theirs, SCRIPTED_MODEL_ID);
    const both = await waitFor("both steers on a live subscription", async () =>
      live.states.findLast(chat => chat.id === chatId && chat.queuedSteers?.length === 2) ?? null);
    const [prompt] = await history(ws, chatId);
    expect(both.queuedSteers).toEqual([
      { text: STEER, author: prompt?.author },
      { text: theirs, author: expect.objectContaining({ type: "user" }) },
    ]);
    expect(both.queuedSteers?.[1]?.author.id).not.toBe(prompt?.author.id);

    // A session that reconnects catches up on the queue it missed.
    const replay = new MetadataRecorder();
    using replayStub = stubFor(replay);
    using _replay = await shared.subscribeToChat(replayStub, before?.lastActive);
    await waitFor("both steers on a resubscription", async () =>
      queued(replay.states.findLast(chat => chat.id === chatId))?.length === 2 || null);

    await ws.stopAgent(chatId);
    await waitForIdleChat(ws, chatId);
    await waitFor("the emptied queue on the live subscription", async () => {
      const last = live.states.findLast(chat => chat.id === chatId);
      return last && !last.activeAgent && !last.queuedSteers ? last : null;
    });
    expect(model.requests).toHaveLength(1);

    await ws.sendChatMessage(chatId, "Start over.", SCRIPTED_MODEL_ID);
    await waitFor("the next turn's model request", async () => model.requests.length === 2 || null);
    await waitForIdleChat(ws, chatId);

    expect(JSON.stringify(model.requests[1])).not.toContain(STEER);
    expect(JSON.stringify(model.requests[1])).not.toContain(theirs);
    expect(transcript(await history(ws, chatId))).toEqual([
      prompted(PROMPT),
      prompted("Start over."),
      reply("Started over."),
    ]);
  });
});

it.concurrent("a steer the failed turn never read waits for the user to retry", async () => {
  // A request the turn does not retry, so it ends on the error without reading the steer.
  const failure = Promise.withResolvers<void>();
  await steerChat("steerfailed", [
    { error: { status: 400, message: "scripted invalid request" }, after: failure.promise },
    { text: "Switched to a dark theme." },
  ], async (ws, chatId, model) => {
    failure.resolve();
    await waitForIdleChat(ws, chatId);
    expect(model.requests).toHaveLength(1);
    // The steer is logged before the error, so the error stays last and Retry shows.
    const failed = await history(ws, chatId);
    expect(failed.at(-1)?.type).toBe("error");
    expect(failed.at(-2)).toMatchObject({ type: "message", message: STEER, steered: true });

    await ws.retryAgent(chatId, SCRIPTED_MODEL_ID);
    await waitFor("the retry's model request", async () => model.requests.length === 2 || null);
    await waitForIdleChat(ws, chatId);
    expect(JSON.stringify(model.requests[1])).toContain(STEER);
    expect(transcript(await history(ws, chatId))).toEqual([
      prompted(PROMPT),
      steered(STEER),
      reply("Switched to a dark theme."),
    ]);
  });
});

it.concurrent("a steer sent before the turn stops on a decision is read when it resumes",
    async () => {
  const request = Promise.withResolvers<void>();
  await steerChat("steerdecision", [
    { toolCall: { id: "connect", name: "requestConnection", arguments: {
      vendorId: TEST_VENDOR_ID, reason: "Store the habits.", bindingName: "HABITS",
    } }, after: request.promise },
    { text: "Dark, and stored." },
  ], async (ws, chatId, model, api) => {
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

    await api.provisionAmbientAccount(TEST_VENDOR_ID);
    const account = await waitFor("the test account", async () =>
      (await listConnectedAccounts(api)).find(entry => entry.vendorId === TEST_VENDOR_ID) ?? null);
    using connection = await ws.newGatekeeper(account.id, "https://gadgets-test.example/things/habits");
    if (!connection) throw new Error("Failed to create the test connection");
    await ws.acceptConnectionRequest(card.requestId, { gatekeeperId: await connection.getId() });
    await waitFor("the resumed turn's model request", async () => model.requests.length === 2 || null);
    await waitForIdleChat(ws, chatId);
    expect(JSON.stringify(model.requests[1])).toContain(STEER);
    expect(transcript(await history(ws, chatId))).toEqual([
      prompted(PROMPT),
      reply(""),
      steered(STEER),
      reply("Dark, and stored."),
    ]);
  });
});

it.concurrent("a steer sent while the chat compacts prompts the next turn", async () => {
  const summary = Promise.withResolvers<void>();
  const model = models.script([
    { text: "Built the tracker." },
    { text: "Summary.", after: summary.promise },
    { text: "Switched to a dark theme." },
  ]);
  const [username] = nextUsernames("steercompact");
  using publicApi = connect(harness.url);
  using api = await signUp(publicApi, username!);
  await api.addModel(model.userModel.profile, model.userModel.config);
  using ws = await api.newWorkspace();
  const chatId = await ws.newChat(PROMPT, SCRIPTED_MODEL_ID);
  await waitFor("the first model request", async () => model.requests.length === 1 || null);
  await waitForIdleChat(ws, chatId);

  // Compaction ends the turn without asking for steers, so this one outlives it.
  await ws.sendChatMessage(
      chatId, { id: { builtin: true, commandId: "compact" }, args: "" }, SCRIPTED_MODEL_ID);
  await waitFor("the summary request", async () => model.requests.length === 2 || null);
  await ws.sendChatMessage(chatId, STEER, SCRIPTED_MODEL_ID);
  summary.resolve();
  await waitFor("the next turn's model request", async () => model.requests.length === 3 || null);
  await waitForIdleChat(ws, chatId);

  expect(JSON.stringify(model.requests[2])).toContain(STEER);
  expect(transcript(await history(ws, chatId))).toEqual([
    prompted(PROMPT),
    reply("Built the tracker."),
    prompted(STEER),
    reply("Switched to a dark theme."),
  ]);
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

it.concurrent("a steer read after the agent's answer is answered after a restart", async () => {
  const answer = Promise.withResolvers<void>();
  const { username, chatId, model } = await steerChat("steerrestartlate", [
    { text: "Built the tracker.", after: answer.promise },
    { pending: true },
    { text: "Switched to a dark theme." },
  ], async (ws, _chatId, scripted) => {
    answer.resolve();
    await waitFor("the steer's model request", async () => scripted.requests.length === 2 || null);
    await restartWorkspace(harness.url, ws);
    await settleRestart();
  });

  await withOwnerWorkspace(harness.url, username, async ws => {
    await waitFor("the resumed turn's model request", async () =>
      model.requests.length === 3 || null);
    await waitForIdleChat(ws, chatId);

    expect(JSON.stringify(model.requests[2])).toContain(STEER);
    expect(transcript(await history(ws, chatId))).toEqual([
      prompted(PROMPT),
      reply("Built the tracker."),
      steered(STEER),
      reply("Switched to a dark theme."),
    ]);
  });
});
