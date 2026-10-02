import { afterAll, beforeAll, expect, it } from "vitest";
import type { AiChatMessage, AiChatSubscriber } from "@gadgets/workshop-shared/api";
import { loadAllChatHistory, openAgentSession } from "../src/agent-session.js";
import {
  settleRestart, startTestGatekeeperHarness, TEST_VENDOR_ID, testActionState, type Harness,
} from "../src/harness.js";
import {
  SCRIPTED_MODEL_ID, scriptedModelRouter, type RoutedScriptedModel,
} from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  accountLabel, connect, logIn, nextUsernames, restartWorkspace, RpcTarget, signUp, stubFor,
  waitFor, waitForIdleChat, withOwnerWorkspace, WorkpieceRecorder,
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

it.concurrent("a transient provider failure is retried, and the turn answers without an error",
    async () => {
  const model = models.script([
    { error: { status: 503, message: "scripted provider outage" } },
    { text: "Answered after a retry." },
  ]);
  const [owner] = nextUsernames("transientowner");
  using publicApi = connect(harness.url);
  using api = await signUp(publicApi, owner!);
  await api.addModel(model.userModel.profile, model.userModel.config);
  using ws = await api.newGadget();

  const chatId = await ws.newChat("Prompt once", SCRIPTED_MODEL_ID);
  await waitFor("the retried model request", async () => model.requests.length === 2 || null);
  await waitForIdleChat(ws, chatId);
  const history = await loadAllChatHistory(before => ws.getChatHistory(chatId, before));
  expect(history.filter(message => message.type === "error")).toEqual([]);
  expect(messageTexts(history)).toEqual(["Prompt once", "Answered after a retry."]);
});

it.concurrent(
    "a provider failure leaves the chat idle, retry answers once, and a busy chat refuses messages",
    async () => {
  const outage = { error: { status: 500, message: "scripted provider outage" } };
  // The turn retries the failed request twice before it reports the error.
  const model = models.script([
    outage, outage, outage,
    { text: "Retry succeeded." },
    { pending: true },
  ]);
  const [owner] = nextUsernames("recoveryowner");
  using publicApi = connect(harness.url);
  using api = await signUp(publicApi, owner!);
  await api.addModel(model.userModel.profile, model.userModel.config);
  using ws = await api.newGadget();

  const chatId = await ws.newChat("Prompt once", SCRIPTED_MODEL_ID);
  await waitFor("the failed model requests", async () => model.requests.length === 3 || null);
  await waitForIdleChat(ws, chatId);
  let history = await loadAllChatHistory(before => ws.getChatHistory(chatId, before));
  expect(history.filter(message =>
    message.type === "message" && message.author.type === "user" &&
    message.message === "Prompt once")).toHaveLength(1);
  expect(history.filter(message =>
    message.type === "error" && message.message.includes("scripted provider outage")))
    .toHaveLength(1);

  await ws.retryAgent(chatId, SCRIPTED_MODEL_ID);
  await waitFor("the retry model request", async () => model.requests.length === 4 || null);
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
  expect(JSON.stringify(model.requests[3])).toContain("Prompt once");

  try {
    await ws.sendChatMessage(chatId, "Hold open", SCRIPTED_MODEL_ID);
    await waitFor("the pending model request", async () => model.requests.length === 5 || null);
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

const messageTexts = (messages: AiChatMessage[]) =>
  messages.flatMap(message => message.type === "message" ? [message.message] : []);

it.concurrent("a chat over its context budget compacts, and history pages across the checkpoint",
    async () => {
  // Long enough to fill the retained tail alone, so the compaction cut lands exactly on it.
  const secondPrompt = "Second question. " + "Keep this turn verbatim. ".repeat(80);
  const model = models.script([
    // Over 85% of the scripted model's 229,376-token input budget, so turn 2 compacts first.
    { text: "First reply.", usage: { prompt_tokens: 195_000, completion_tokens: 1, total_tokens: 195_001 } },
    { text: "Summary of the first turn." },
    { text: "Second reply." },
  ]);
  const [owner] = nextUsernames("compactowner");
  using publicApi = connect(harness.url);
  using api = await signUp(publicApi, owner!);
  await api.addModel(model.userModel.profile, model.userModel.config);
  using ws = await api.newGadget();

  const chatId = await ws.newChat("First question", SCRIPTED_MODEL_ID);
  await waitFor("the first model request", async () => model.requests.length === 1 || null);
  await waitForIdleChat(ws, chatId);
  await ws.sendChatMessage(chatId, secondPrompt, SCRIPTED_MODEL_ID);
  await waitFor("the summary and resumed requests", async () => model.requests.length === 3 || null);
  await waitForIdleChat(ws, chatId);
  expect(model.remainingSteps()).toBe(0);

  const [, summary, resumed] = model.requests.map(request => JSON.stringify(request));
  expect(summary).toContain("Create the context handoff now. Do not continue the conversation.");
  expect(summary).toContain("First question");
  expect(summary).toContain("First reply.");
  expect(resumed).toContain("<prior_conversation");
  expect(resumed).toContain("Summary of the first turn.");
  expect(resumed).toContain("Second question.");
  expect(resumed).not.toContain("First question");

  const tail = await ws.getChatHistory(chatId);
  expect(tail.compacted?.summary).toBe("Summary of the first turn.");
  expect(messageTexts(tail.messages)).toEqual([secondPrompt, "Second reply."]);
  const boundary = tail.compacted!.to;
  const older = await ws.getChatHistory(chatId, boundary);
  expect(older.compacted).toBeUndefined();
  expect(messageTexts(older.messages)).toEqual(["First question", "First reply."]);
  expect(older.messages.every(message => message.sequence < boundary)).toBe(true);
  expect(tail.messages.every(message => message.sequence >= boundary)).toBe(true);
  expect(messageTexts(await loadAllChatHistory(before => ws.getChatHistory(chatId, before))))
    .toEqual(["First question", "First reply.", secondPrompt, "Second reply."]);
});

it.concurrent("switching models keeps history, refuses a deleted model, and recovers with another",
    async () => {
  const outage = { error: { status: 500, message: "scripted provider outage" } };
  const modelA = models.script([{ text: "A's first reply." }, outage, outage, outage]);
  const modelB = models.script([{ text: "B saw model A's history." }, { text: "B retried the chat." }]);
  // Every script shares SCRIPTED_MODEL_ID; B keeps its routed accountId under its own model id.
  const MODEL_B_ID = "scripted-model-b";
  const [owner] = nextUsernames("modellifecycleowner");
  using publicApi = connect(harness.url);
  using api = await signUp(publicApi, owner!);
  await api.addModel(modelA.userModel.profile, modelA.userModel.config);
  await api.addModel(
      { ...modelB.userModel.profile, id: MODEL_B_ID, name: "Scripted model B" },
      { ...modelB.userModel.config, model: MODEL_B_ID });
  using ws = await api.newGadget();
  await api.setQuickModel(SCRIPTED_MODEL_ID);
  expect(await api.getQuickModel()).toBe(SCRIPTED_MODEL_ID);
  await api.setPreferredModel(SCRIPTED_MODEL_ID);
  expect(await api.getPreferredModel()).toBe(SCRIPTED_MODEL_ID);

  const chatId = await ws.newChat("Ask model A.", SCRIPTED_MODEL_ID);
  const history = () => loadAllChatHistory(before => ws.getChatHistory(chatId, before));
  const settled = async (model: RoutedScriptedModel, requests: number) => {
    await waitFor(`request ${requests}`, async () => model.requests.length === requests || null);
    await waitForIdleChat(ws, chatId);
  };
  await settled(modelA, 1);
  await ws.sendChatMessage(chatId, "Ask model B.", MODEL_B_ID);
  await settled(modelB, 1);
  const switched = JSON.stringify(modelB.requests[0]);
  for (const text of ["Ask model A.", "A's first reply.", "Ask model B."]) {
    expect(switched).toContain(text);
  }
  // The user switches back to A, whose provider fails, and deletes it.
  await ws.sendChatMessage(chatId, "Ask model A again.", SCRIPTED_MODEL_ID);
  await settled(modelA, 4);

  await api.deleteModel(SCRIPTED_MODEL_ID);
  expect(await api.getQuickModel()).toBeNull();

  const beforeRefused = await history();
  await expect(ws.sendChatMessage(chatId, "This must not be saved.", SCRIPTED_MODEL_ID))
    .rejects.toThrow(`No such model: ${SCRIPTED_MODEL_ID}`);
  expect(await history()).toEqual(beforeRefused);
  expect(modelA.requests).toHaveLength(4);

  // Retry answers the failed turn's message; after a completed reply it would have nothing to do.
  await ws.retryAgent(chatId, MODEL_B_ID);
  await settled(modelB, 2);
  expect(messageTexts(await history())).toEqual([
    "Ask model A.", "A's first reply.", "Ask model B.", "B saw model A's history.",
    "Ask model A again.", "B retried the chat.",
  ]);
});

it.concurrent("approving after the waiting chat's model was deleted applies once without resuming",
    async () => {
  const model = models.script([
    { toolCall: {
      id: "write-test-value",
      name: "executeCode",
      arguments: {
        code: "export default async function(self, env) { console.log(await env.TEST_AMBIENT.writeValue(13)); }",
      },
    } },
    { text: "This must not run." },
  ]);
  await using session = await openAgentSession(harness.url, {
    modelId: SCRIPTED_MODEL_ID,
    userModel: model.userModel,
    ambientVendorIds: [TEST_VENDOR_ID],
    usernamePrefix: "deletedapprovalmodel",
  });
  const label = accountLabel(session.connectedAccount(TEST_VENDOR_ID));

  expect((await session.runTurn("Set the test value to 13.")).outcome)
    .toEqual({ status: "completed" });
  const [action] = await waitFor("the test write to await approval", async () => {
    const { entries } = await session.listActions({ filter: "pending" });
    return entries.length === 1 ? entries : null;
  });
  expect(action).toMatchObject({ description: { title: "Set the test value to 13" } });
  {
    using publicApi = connect(harness.url);
    using api = await logIn(publicApi, session.username);
    await api.deleteModel(SCRIPTED_MODEL_ID);
  }

  await withOwnerWorkspace(harness.url, session.username, async ws => {
    // What the approval call should then report is undecided, so only its effects are asserted.
    await Promise.allSettled([ws.approveAction(action!.id)]);
    const [chat] = await ws.listChats();
    await waitForIdleChat(ws, chat!.id);
  });
  expect((await session.listActions({ filter: "action" })).entries)
    .toContainEqual(expect.objectContaining({ id: action!.id, state: "approved" }));
  expect(await testActionState(harness, label)).toEqual({ pending: [], value: 13, applyCount: 1 });
  expect(model.requests).toHaveLength(1);
  expect(model.remainingSteps()).toBe(1);
});
