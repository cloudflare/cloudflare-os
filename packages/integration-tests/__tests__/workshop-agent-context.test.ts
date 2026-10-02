// What the user hands the agent -- pasted links and attachments -- and what the agent is told about
// the workspace, observed in the requests the scripted model receives.

import { z } from "zod";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import type {
  AiChatMessage, CapsuleSpecifier, GatekeeperClient, Overseer,
} from "@gadgets/workshop-shared/api";
import { loadAllChatHistory } from "../src/agent-session.js";
import { startTestGatekeeperHarness, TEST_VENDOR_ID, type Harness } from "../src/harness.js";
import {
  SCRIPTED_MODEL_ID, scriptedModelRouter, systemPromptOf, type RoutedScriptedModel,
} from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  connect, listConnectedAccounts, nextUsernames, signUp, waitFor, waitForIdleChat,
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

const THINGS = "https://gadgets-test.example/things";

// A fresh owner whose workspace sees the fixture's ambient connection, with no quick model so
// pasted links are named after the gatekeeper's own suggestion.
async function newWorkspace(model: RoutedScriptedModel, usernamePrefix: string) {
  const [username] = nextUsernames(usernamePrefix);
  using stack = new DisposableStack();
  const api = stack.use(await signUp(stack.use(connect(harness.url)), username!));
  await api.addModel(model.userModel.profile, model.userModel.config);
  await api.setQuickModel(null);
  await api.provisionAmbientAccount(TEST_VENDOR_ID);
  const account = await waitFor("the test account to be provisioned", async () =>
    (await listConnectedAccounts(api)).find(entry => entry.vendorId === TEST_VENDOR_ID) ?? null);
  const ws = stack.use(await api.newGadget());
  return Object.assign(stack.move(), { api, account, ws });
}

async function newConnection(ws: RpcStub<Overseer>, accountId: number, name: string)
    : Promise<RpcStub<GatekeeperClient<any>>> {
  const connection = await ws.newGatekeeper(accountId, `${THINGS}/${name}`);
  if (!connection) throw new Error(`Failed to create the ${name} connection`);
  return connection;
}

/** Wait until the model has received `requests` agent requests in all and the chat is idle. */
async function settle(
    ws: RpcStub<Overseer>, model: RoutedScriptedModel, chatId: number, requests: number) {
  await waitFor(`model request ${requests}`, async () => model.requests.length >= requests || null);
  await waitForIdleChat(ws, chatId);
  expect(model.requests).toHaveLength(requests);
}

const history = (ws: RpcStub<Overseer>, chatId: number) =>
  loadAllChatHistory(before => ws.getChatHistory(chatId, before));

// The output of every executeCode call the agent made, in order.
const codeOutputs = (messages: AiChatMessage[]) => messages.flatMap(message =>
  message.type === "message" ? message.toolCalls ?? [] : []).flatMap(call =>
    call.toolName === "executeCode" ? [call.output] : []);

it.concurrent("the agent's prompt follows the workspace's gadgets and bindings", async () => {
  const model = models.script([{ text: "First." }, { text: "Second." }, { text: "Third." }]);
  using owner = await newWorkspace(model, "agentprompt");
  const { api, account, ws } = owner;
  const formats = await waitFor("bundled output formats to install", async () => {
    const offers = await api.listOutputFormats();
    return offers.length > 0 ? offers : null;
  });
  using notes = await ws.createGadget("Meeting notes", undefined, "NOTES");
  using board = await ws.createGadget("Task board", undefined, "BOARD");
  using meetingData = await newConnection(ws, account.id, "meeting-data");
  using boardExtra = await newConnection(ws, account.id, "board-extra");
  await notes.bind("MEETING_DATA", await meetingData.getId());

  const chatA = await ws.newChat("What is in this workspace?", SCRIPTED_MODEL_ID);
  await settle(ws, model, chatA, 1);
  const first = systemPromptOf(model.requests[0]);
  expect(first).toContain("Meeting notes");
  expect(first).toContain("Task board");
  expect(first).toContain("MEETING_DATA");
  expect(first).toContain("env.TEST_AMBIENT");
  for (const format of formats) {
    expect(first).toContain(format.output.noun);
    expect(first).toContain(format.blueprintId);
  }

  // The rename lands on mainline; the binding is only proposed in another chat.
  await board.setTitle("Quarterly roadmap");
  const chatB = await ws.newChat("Give the roadmap the extra data.", null);
  await board.bind("BOARD_EXTRA", await boardExtra.getId(), chatB);
  await ws.sendChatMessage(chatA, "And now?", SCRIPTED_MODEL_ID);
  await settle(ws, model, chatA, 2);
  const second = systemPromptOf(model.requests[1]);
  expect(second).toContain("Quarterly roadmap");
  expect(second).not.toContain("Task board");
  expect(second).not.toContain("BOARD_EXTRA");

  expect(await ws.mergeChanges(chatB)).toEqual({ outcome: "merged" });
  await ws.sendChatMessage(chatA, "And after that change?", SCRIPTED_MODEL_ID);
  await settle(ws, model, chatA, 3);
  expect(systemPromptOf(model.requests[2])).toContain("BOARD_EXTRA");
});

it.concurrent("a pasted link becomes a binding for that chat only", async () => {
  const model = models.script([
    { toolCall: { id: "read-pasted", name: "executeCode", arguments: {
      code: "export default async function(self, env) { " +
        "console.log(await env.TEST_THING.readValue()); }",
    } } },
    { text: "It is 42." },
    { text: "Same thing again." },
    { toolCall: { id: "list-env", name: "executeCode", arguments: {
      code: "export default async function(self, env) { " +
        "console.log(Object.keys(env).join(' ')); }",
    } } },
    { text: "That is everything." },
  ]);
  using owner = await newWorkspace(model, "pastedlink");
  const { account, ws } = owner;
  using app = await ws.createGadget("App", undefined, "APP");
  using pasted = await newConnection(ws, account.id, "pasted");
  const pastedId = await pasted.getId();
  const description = await pasted.describe();
  // The user's message carries a placeholder where the link was pasted.
  const pasting = (message: string): CapsuleSpecifier[] => [{
    position: message.indexOf("[0]"), length: "[0]".length, gatekeeperId: pastedId, description,
    vendorId: TEST_VENDOR_ID,
  }];

  const firstMessage = "Read [0] for me.";
  const chatId = await ws.newChat(firstMessage, SCRIPTED_MODEL_ID, pasting(firstMessage));
  await settle(ws, model, chatId, 2);
  expect(JSON.stringify(model.requests[0])).toContain("env.TEST_THING");
  expect(codeOutputs(await history(ws, chatId))).toEqual([expect.stringContaining("42")]);
  expect((await ws.listActions({ filter: "observation" })).entries).toEqual([
    expect.objectContaining({ type: "observation", gatekeeperId: pastedId }),
  ]);

  const againMessage = "And [0] once more.";
  await ws.sendChatMessage(chatId, againMessage, SCRIPTED_MODEL_ID, pasting(againMessage));
  await settle(ws, model, chatId, 3);
  const capsules = (await history(ws, chatId)).flatMap(message =>
    message.type === "message" && message.author.type === "user" ? [message.capsules] : []);
  expect(capsules).toEqual([
    [expect.objectContaining({ gatekeeperId: pastedId, bindingName: "TEST_THING" })],
    [expect.objectContaining({ gatekeeperId: pastedId, bindingName: "TEST_THING" })],
  ]);

  const otherChat = await ws.newChat("What can you reach?", SCRIPTED_MODEL_ID);
  await settle(ws, model, otherChat, 5);
  expect(JSON.stringify(model.requests[3])).not.toContain("TEST_THING");
  const [envNames] = codeOutputs(await history(ws, otherChat));
  expect(envNames).toContain("TEST_AMBIENT");
  expect(envNames).not.toContain("TEST_THING");

  expect(await app.listBindings()).toEqual([]);
  expect(await app.listBindings(chatId)).toEqual([]);
});

const MODEL_REQUEST = z.object({
  messages: z.array(z.object({
    role: z.string(),
    content: z.union([z.string(), z.array(z.object({ text: z.string().optional() }))]).nullish(),
  })),
});

// The text of each user message in one agent request, its content parts joined.
const userTexts = (request: unknown) => MODEL_REQUEST.parse(request).messages
    .filter(message => message.role === "user")
    .map(({ content }) => typeof content === "string"
      ? content
      : (content ?? []).map(part => part.text ?? "").join(""));

it.concurrent("an attachment reaches the model in its turn and stays in later turns", async () => {
  const notes = "Agenda: ship the attachment test before Friday.";
  const model = models.script([{ text: "Got it." }, { text: "The attachment test." }]);
  using owner = await newWorkspace(model, "attachment");
  const { ws } = owner;
  const upload = await ws.uploadChatAttachment(
      { mimeType: "text/plain", content: new TextEncoder().encode(notes), name: "agenda.txt" },
      SCRIPTED_MODEL_ID);

  const chatId = await ws.newChat("Read the agenda.", SCRIPTED_MODEL_ID, undefined, [upload]);
  await settle(ws, model, chatId, 1);
  const withAttachment = expect.stringMatching(/Read the agenda\.[^]*agenda\.txt[^]*Agenda: ship/);
  expect(userTexts(model.requests[0])).toEqual([withAttachment]);

  await ws.sendChatMessage(chatId, "What is due Friday?", SCRIPTED_MODEL_ID);
  await settle(ws, model, chatId, 2);
  expect(userTexts(model.requests[1])).toEqual([withAttachment, "What is due Friday?"]);
});
