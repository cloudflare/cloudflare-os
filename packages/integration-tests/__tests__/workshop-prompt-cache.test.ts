// Providers cache a prompt by its prefix: a request reads the cache only as far as it matches an
// earlier request byte for byte. So each request a chat sends must start with the whole of the
// request before it, or everything after the first difference is paid for again.

import { z } from "zod";
import { afterAll, beforeAll, expect, it } from "vitest";
import { openAgentSession } from "../src/agent-session.js";
import {
  startTestGatekeeperHarness, TEST_VENDOR_ID, testControl, type Harness,
} from "../src/harness.js";
import { SCRIPTED_MODEL_ID, scriptedModelRouter, systemPromptOf } from "../src/mock-model.js";
import {
  accountLabel, connect, listConnectedAccounts, nextUsernames, signUp, waitFor, waitForIdleChat,
} from "../src/rpc-client.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";

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

// A chat completions request: its messages, and the fields that shape how the provider renders
// them (tools, model, reasoning options).
const REQUEST = z.looseObject({ messages: z.array(z.unknown()) });

// Compares serialized JSON, so a reordered key counts as a difference, as it does for the cache.
function expectEachRequestExtendsThePrevious(requests: readonly unknown[]) {
  const parsed = requests.map(request => REQUEST.parse(request));
  for (const [index, { messages, ...fields }] of parsed.entries()) {
    const previous = parsed[index - 1];
    if (previous === undefined) continue;
    const { messages: previousMessages, ...previousFields } = previous;
    expect(JSON.stringify(fields), `fields of request ${index}`)
        .toBe(JSON.stringify(previousFields));
    expect(messages.slice(0, previousMessages.length).map(m => JSON.stringify(m)),
        `messages of request ${index}`).toEqual(previousMessages.map(m => JSON.stringify(m)));
  }
}

const READ_TEST_VALUE =
    "export default async function(self, env) { console.log(await env.TEST_AMBIENT.readValue()); }";

it.concurrent("each request starts with the whole request before it", async () => {
  const model = models.script([
    { toolCall: { id: "read-value", name: "executeCode", arguments: { code: READ_TEST_VALUE } } },
    { text: "The test value is 42." },
    { text: "It is still 42." },
  ]);
  await using session = await openAgentSession(harness.url, {
    modelId: SCRIPTED_MODEL_ID,
    userModel: model.userModel,
    ambientVendorIds: [TEST_VENDOR_ID],
  });

  expect((await session.runTurn("Read the test value.")).outcome).toEqual({ status: "completed" });
  expect((await session.runTurn("Is it the same now?")).outcome).toEqual({ status: "completed" });
  expect(model.requests).toHaveLength(3);
  expectEachRequestExtendsThePrevious(model.requests);
});

// The system prompt lists the workspace's gadgets as the chat first saw them. The agent knows of a
// gadget it created from its own tool call.
it.concurrent("creating a gadget keeps each request a prefix of the next", async () => {
  const model = models.script([
    { toolCall: { id: "create", name: "createGadget",
                  arguments: { title: "Meeting notes", bindingName: "NOTES" } } },
    { text: "I created it." },
    { text: "It is there." },
  ]);
  await using session = await openAgentSession(harness.url, {
    modelId: SCRIPTED_MODEL_ID,
    userModel: model.userModel,
  });

  expect((await session.runTurn("Make a notes gadget.")).outcome).toEqual({ status: "completed" });
  await session.acceptChanges();
  expect((await session.runTurn("Is it there?")).outcome).toEqual({ status: "completed" });
  expect(model.requests).toHaveLength(3);
  expectEachRequestExtendsThePrevious(model.requests);
});

// Compaction rewrites the chat's history anyway, so it lists the gadgets as they are, and the
// turns after it keep that list.
it.concurrent("a compaction lists the workspace's gadgets afresh, and later turns keep that list",
    async () => {
  const model = models.script([
    // Over 85% of the scripted model's input budget, so turn 2 compacts first.
    { text: "First reply.", usage: { prompt_tokens: 195_000, completion_tokens: 1, total_tokens: 195_001 } },
    { text: "Summary of the first turn." },
    { text: "Second reply." },
    { text: "Third reply." },
  ]);
  const [owner] = nextUsernames("promptcompact");
  using publicApi = connect(harness.url);
  using api = await signUp(publicApi, owner!);
  await api.addModel(model.userModel.profile, model.userModel.config);
  using ws = await api.newWorkspace();

  const chatId = await ws.newChat("First question", SCRIPTED_MODEL_ID);
  await waitFor("the first model request", async () => model.requests.length === 1 || null);
  await waitForIdleChat(ws, chatId);
  (await ws.createGadget("Meeting notes", undefined, "NOTES"))[Symbol.dispose]();
  await ws.sendChatMessage(chatId, "Second question", SCRIPTED_MODEL_ID);
  await waitFor("the summary and resumed requests", async () => model.requests.length === 3 || null);
  await waitForIdleChat(ws, chatId);

  const [first, , resumed] = model.requests;
  expect(systemPromptOf(first)).not.toContain("Meeting notes");
  expect(JSON.stringify(resumed)).toContain("<prior_conversation");
  expect(systemPromptOf(resumed)).toContain("Meeting notes");

  (await ws.createGadget("Shopping list", undefined, "LIST"))[Symbol.dispose]();
  await ws.sendChatMessage(chatId, "Third question", SCRIPTED_MODEL_ID);
  await waitFor("the third turn's request", async () => model.requests.length === 4 || null);
  await waitForIdleChat(ws, chatId);
  expect(systemPromptOf(model.requests[3])).toEqual(systemPromptOf(resumed));
});

// Give the account's always-available resource a catalog with these skills. Set it before the
// chat's first turn: a resource whose catalog is null once is not asked again.
function setSkills(label: string, skills: string[]): Promise<void> {
  return testControl(harness, "agent-catalog", { label, skills });
}

// The system prompt lists the catalogs as the chat first saw them. A later change reaches the
// agent as a synthetic tool call at the end of the history.
it.concurrent("a catalog change keeps each request a prefix of the next, and the agent is told",
    async () => {
  const model = models.script([{ text: "First reply." }, { text: "Second reply." }]);
  await using session = await openAgentSession(harness.url, {
    modelId: SCRIPTED_MODEL_ID,
    userModel: model.userModel,
    ambientVendorIds: [TEST_VENDOR_ID],
  });
  const label = accountLabel(session.connectedAccount(TEST_VENDOR_ID));

  await setSkills(label, ["Tax rules"]);
  expect((await session.runTurn("First question")).outcome).toEqual({ status: "completed" });
  await setSkills(label, ["Tax rules", "Travel policy"]);
  expect((await session.runTurn("Second question")).outcome).toEqual({ status: "completed" });

  const [first, second] = model.requests;
  expect(systemPromptOf(first)).toContain("Tax rules");
  expectEachRequestExtendsThePrevious(model.requests);
  const messages = REQUEST.parse(second).messages;
  expect(JSON.stringify(messages.at(-3))).toContain("Second question");
  expect(JSON.stringify(messages.at(-1))).toContain("Travel policy");
  expect(JSON.stringify(messages.at(-1))).not.toContain("Tax rules");
});

// An always-available resource the workspace gains after the chat started joins the chat's env on
// its next turn. The system prompt keeps the list the chat started with, so the agent is told.
it.concurrent("a resource gained mid-chat keeps each request a prefix, and the agent can use it",
    async () => {
  const model = models.script([
    { text: "First reply." },
    { toolCall: { id: "read-value", name: "executeCode", arguments: { code: READ_TEST_VALUE } } },
    { text: "The test value is 42." },
  ]);
  await using session = await openAgentSession(harness.url, {
    modelId: SCRIPTED_MODEL_ID,
    userModel: model.userModel,
  });

  expect((await session.runTurn("First question")).outcome).toEqual({ status: "completed" });
  await session.enableAmbientGatekeeper(TEST_VENDOR_ID);
  expect((await session.runTurn("Read the test value.")).outcome).toEqual({ status: "completed" });

  expect(model.requests).toHaveLength(3);
  expectEachRequestExtendsThePrevious(model.requests);
  const [, second, third] = model.requests.map(request => REQUEST.parse(request).messages);
  expect(JSON.stringify(second?.at(-1))).toContain("`env.TEST_AMBIENT` (");
  expect(JSON.stringify(second?.at(-1))).toContain("is now always available");
  expect(JSON.stringify(third?.at(-1))).toContain("42");
});

// `/compact` never prompts the model, so the change is reported on the turn after it, and the
// checkpoint lists the catalogs the summarized turns saw.
it.concurrent("compacting after a catalog change keeps the catalogs the chat saw", async () => {
  const model = models.script([
    { text: "First reply." },
    { text: "Summary of the first turn." },
    { text: "Second reply." },
  ]);
  const [owner] = nextUsernames("catalogcompact");
  using publicApi = connect(harness.url);
  using api = await signUp(publicApi, owner!);
  await api.addModel(model.userModel.profile, model.userModel.config);
  await api.provisionAmbientAccount(TEST_VENDOR_ID);
  const account = await waitFor("the ambient account", async () =>
      (await listConnectedAccounts(api)).find(entry => entry.vendorId === TEST_VENDOR_ID) ?? null);
  const label = accountLabel(account);
  await setSkills(label, ["Tax rules"]);
  using ws = await api.newWorkspace();

  const chatId = await ws.newChat("First question", SCRIPTED_MODEL_ID);
  await waitFor("the first model request", async () => model.requests.length === 1 || null);
  await waitForIdleChat(ws, chatId);
  await setSkills(label, ["Tax rules", "Travel policy"]);
  await ws.sendChatMessage(
      chatId, { id: { builtin: true, commandId: "compact" }, args: "" }, SCRIPTED_MODEL_ID);
  await waitFor("the summary request", async () => model.requests.length === 2 || null);
  await waitForIdleChat(ws, chatId);
  await ws.sendChatMessage(chatId, "Second question", SCRIPTED_MODEL_ID);
  await waitFor("the second turn's request", async () => model.requests.length === 3 || null);
  await waitForIdleChat(ws, chatId);

  const [first, summary, second] = model.requests;
  expect(JSON.stringify(summary)).not.toContain("Travel policy");
  expect(JSON.stringify(second)).toContain("<prior_conversation");
  expect(systemPromptOf(second)).toEqual(systemPromptOf(first));
  const messages = REQUEST.parse(second).messages;
  expect(JSON.stringify(messages.at(-3))).toContain("Second question");
  expect(JSON.stringify(messages.at(-1))).toContain("Travel policy");
});
