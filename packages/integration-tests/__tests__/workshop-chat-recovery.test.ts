import { afterAll, beforeAll, expect, it } from "vitest";
import type { AiChatMessage, AiChatSubscriber } from "@gadgets/workshop-shared/api";
import { loadAllChatHistory } from "../src/agent-session.js";
import { settleRestart, startTestGatekeeperHarness, type Harness } from "../src/harness.js";
import {
  SCRIPTED_MODEL_ID, scriptedModelRouter, type RoutedScriptedModel,
} from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  connect, logIn, nextUsernames, restartWorkspace, RpcTarget, signUp, stubFor, waitFor,
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

class ChatRecorder extends RpcTarget implements AiChatSubscriber {
  readonly generations: number[] = [];
  readonly messages: AiChatMessage[] = [];

  streamGeneration(generation: number): void { this.generations.push(generation); }
  message(message: AiChatMessage): void { this.messages.push(message); }
  metadata(): void {}
  deleted(): void {}
  changeApplied(): void {}
  stream(): void {}
}

async function recordFirstTurn(username: string, model: RoutedScriptedModel) {
  using publicApi = connect(harness.url);
  using api = await signUp(publicApi, username);
  await api.addModel(model.userModel.profile, model.userModel.config);
  using ws = await api.newGadget();
  const { id: workspaceId } = await ws.getMetadata();
  const recorder = new ChatRecorder();
  using recorderStub = stubFor(recorder);
  using _subscription = await ws.subscribeToChat(recorderStub);

  const chatId = await ws.newChat("First", SCRIPTED_MODEL_ID);
  await waitFor("the first model request", async () => model.requests.length === 1 || null);
  await waitForIdleChat(ws, chatId);
  await waitFor("the first reply on the original subscription", async () =>
    recorder.messages.some(message =>
      message.type === "message" && message.author.type === "agent" &&
      message.message === "First reply.") || null);

  const seen = [...recorder.messages];
  const lastSeen = seen.at(-1)?.timestamp;
  const generation = recorder.generations[0];
  if (lastSeen === undefined || generation === undefined) {
    throw new Error("The initial chat subscription did not receive its complete first turn");
  }
  return { chatId, generation, lastSeen, seen, workspaceId };
}

it.concurrent(
    "a provider failure leaves the chat idle, retry answers once, and a busy chat refuses messages",
    async () => {
  const model = models.script([
    { error: { status: 500, message: "scripted provider outage" } },
    { text: "Retry succeeded." },
    { pending: true },
  ]);
  const [owner] = nextUsernames("recoveryowner");
  using publicApi = connect(harness.url);
  using api = await signUp(publicApi, owner!);
  await api.addModel(model.userModel.profile, model.userModel.config);
  using ws = await api.newGadget();

  const chatId = await ws.newChat("Prompt once", SCRIPTED_MODEL_ID);
  await waitFor("the failed model request", async () => model.requests.length === 1 || null);
  await waitForIdleChat(ws, chatId);
  let history = await loadAllChatHistory(before => ws.getChatHistory(chatId, before));
  expect(history.filter(message =>
    message.type === "message" && message.author.type === "user" &&
    message.message === "Prompt once")).toHaveLength(1);
  expect(history.filter(message =>
    message.type === "error" && message.message.includes("scripted provider outage")))
    .toHaveLength(1);

  await ws.retryAgent(chatId, SCRIPTED_MODEL_ID);
  await waitFor("the retry model request", async () => model.requests.length === 2 || null);
  await waitForIdleChat(ws, chatId);
  history = await loadAllChatHistory(before => ws.getChatHistory(chatId, before));
  expect(history.filter(message =>
    message.type === "message" && message.author.type === "user" &&
    message.message === "Prompt once")).toHaveLength(1);
  expect(history.filter(message =>
    message.type === "message" && message.author.type === "agent" &&
    message.message === "Retry succeeded.")).toHaveLength(1);
  expect(history).toContainEqual(expect.objectContaining({
    type: "error",
    message: expect.stringContaining("scripted provider outage"),
  }));
  expect(JSON.stringify(model.requests[1])).toContain("Prompt once");

  try {
    await ws.sendChatMessage(chatId, "Hold open", SCRIPTED_MODEL_ID);
    await waitFor("the pending model request", async () => model.requests.length === 3 || null);
    await expect(ws.sendChatMessage(chatId, "Rejected", SCRIPTED_MODEL_ID))
      .rejects.toThrow("Agent is running, wait for it to finish.");
    history = await loadAllChatHistory(before => ws.getChatHistory(chatId, before));
    expect(history).not.toContainEqual(expect.objectContaining({
      type: "message",
      message: "Rejected",
    }));
  } finally {
    await ws.stopAgent(chatId);
  }
});

it.concurrent("stopping a running agent keeps its completed steps and leaves the chat usable",
    async () => {
  const model = models.script([
    { toolCall: {
      id: "create", name: "createGadget", arguments: { title: "Notes", bindingName: "NOTES" },
    } },
    { toolCall: {
      id: "write",
      name: "writeFile",
      arguments: { workpiece: "NOTES", filename: "notes.txt", content: "kept\n" },
    } },
    { pending: true },
    { text: "I can continue." },
  ]);
  const [owner] = nextUsernames("stopowner");
  using publicApi = connect(harness.url);
  using api = await signUp(publicApi, owner!);
  await api.addModel(model.userModel.profile, model.userModel.config);
  using ws = await api.newGadget();
  const workpieces = new WorkpieceRecorder();
  using workpiecesStub = stubFor(workpieces);
  using _workpieces = await ws.subscribeToWorkpieces(workpiecesStub);
  await workpieces.loaded;

  const chatId = await ws.newChat("Write the notes.", SCRIPTED_MODEL_ID);
  // Request 3 means both tool steps have been saved at their step boundaries.
  await waitFor("the pending third step", async () => model.requests.length === 3 || null);
  await ws.stopAgent(chatId);
  await waitForIdleChat(ws, chatId);

  const history = await loadAllChatHistory(before => ws.getChatHistory(chatId, before));
  const gadgetId = history.flatMap(message =>
    message.type === "changes" ? message.createdGadgets ?? [] : [])[0]?.gadgetId;
  if (gadgetId === undefined) throw new Error("The stopped turn recorded no created gadget");
  expect(await ws.mergeChanges(chatId)).toEqual({ outcome: "merged" });
  const commitId = await waitFor("the merged gadget head", async () => {
    const summary = workpieces.summaries.get(gadgetId);
    return summary?.type === "gadget" && summary.commitId !== undefined ? summary.commitId : null;
  });
  expect(await ws.readFilesAtCommit(commitId, ["notes.txt"]))
    .toEqual([["notes.txt", { kind: "text", text: "kept\n" }]]);

  await ws.sendChatMessage(chatId, "Continue.", SCRIPTED_MODEL_ID);
  await waitFor("the continued model request", async () => model.requests.length === 4 || null);
  await waitForIdleChat(ws, chatId);
  const continued = await loadAllChatHistory(before => ws.getChatHistory(chatId, before));
  expect(continued.filter(message =>
    message.type === "message" && message.author.type === "agent" &&
    message.message === "I can continue.")).toHaveLength(1);
  expect(model.remainingSteps()).toBe(0);
});

it.concurrent("resubscribing during a running turn replays exactly what history lacks", async () => {
  const model = models.script([
    { text: "First reply." },
    { toolCall: {
      id: "working",
      name: "executeCode",
      arguments: { code: "export default async function() { console.log('working'); }" },
    } },
    { pending: true },
  ]);
  const [owner] = nextUsernames("droprecoveryowner");
  const first = await recordFirstTurn(owner!, model);

  using publicApi = connect(harness.url);
  using api = await logIn(publicApi, owner!);
  using ws = await api.openGadget(first.workspaceId);
  try {
    await ws.sendChatMessage(first.chatId, "Second", SCRIPTED_MODEL_ID);
    await waitFor("the pending second turn", async () => model.requests.length === 3 || null);

    using replayPublicApi = connect(harness.url);
    using replayApi = await logIn(replayPublicApi, owner!);
    using replayWs = await replayApi.openGadget(first.workspaceId);
    const replay = new ChatRecorder();
    using replayStub = stubFor(replay);
    using _replaySubscription = await replayWs.subscribeToChat(replayStub, first.lastSeen);
    const canonical = await loadAllChatHistory(
        before => replayWs.getChatHistory(first.chatId, before));
    await waitFor("the missing chat messages to replay", async () =>
      first.seen.length + replay.messages.length >= canonical.length || null);

    const sequences = [...first.seen, ...replay.messages].map(message => message.sequence);
    expect(sequences).toEqual(canonical.map(message => message.sequence));
    expect(new Set(sequences).size).toBe(sequences.length);
  } finally {
    await ws.stopAgent(first.chatId);
  }
});

it.concurrent("resubscribing after a workspace restart replays exactly what history lacks", async () => {
  const model = models.script([
    { text: "First reply." },
    { text: "Second reply." },
  ]);
  const [owner] = nextUsernames("restartrecoveryowner");
  const first = await recordFirstTurn(owner!, model);

  {
    using publicApi = connect(harness.url);
    using api = await logIn(publicApi, owner!);
    using ws = await api.openGadget(first.workspaceId);
    await ws.sendChatMessage(first.chatId, "Second", SCRIPTED_MODEL_ID);
    await waitFor("the second model request", async () => model.requests.length === 2 || null);
    await waitForIdleChat(ws, first.chatId);
    await restartWorkspace(harness.url, ws);
    await settleRestart();
  }

  using publicApi = connect(harness.url);
  using api = await logIn(publicApi, owner!);
  using ws = await api.openGadget(first.workspaceId);
  const replay = new ChatRecorder();
  using replayStub = stubFor(replay);
  using _replaySubscription = await ws.subscribeToChat(replayStub, first.lastSeen);
  const canonical = await loadAllChatHistory(before => ws.getChatHistory(first.chatId, before));
  await waitFor("the post-restart chat messages to replay", async () =>
    first.seen.length + replay.messages.length >= canonical.length || null);

  const sequences = [...first.seen, ...replay.messages].map(message => message.sequence);
  expect(sequences).toEqual(canonical.map(message => message.sequence));
  expect(new Set(sequences).size).toBe(sequences.length);
  expect(replay.generations[0]).toEqual(expect.any(Number));
  expect(replay.generations[0]).not.toBe(first.generation);
});
