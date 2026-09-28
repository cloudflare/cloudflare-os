import { afterAll, beforeAll, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import { z } from "zod";
import type { AiChatMessage } from "@gadgets/workshop-shared/api";
import type { TestSession } from "../fixtures/gatekeeper-test/src/test-gatekeeper.js";
import { loadAllChatHistory, openAgentSession } from "../src/agent-session.js";
import {
  startTestGatekeeperHarness, TEST_GATEKEEPER_WORKER, TEST_VENDOR_ID, type Harness,
} from "../src/harness.js";
import {
  SCRIPTED_MODEL_ID, scriptedModelRouter, type ChatCompletionStep, type RoutedScriptedModel,
} from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { accountLabel, waitFor, waitForIdleChat, withOwnerWorkspace } from "../src/rpc-client.js";

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

const REQUEST = {
  vendorId: TEST_VENDOR_ID,
  resourceUrl: "https://gadgets-test.example/things/requested",
  reason: "Read the requested test value.",
  bindingName: "REQUESTED_THING",
};
const requestConnection: ChatCompletionStep = {
  toolCall: { id: "request", name: "requestConnection", arguments: REQUEST },
};
const writeRequestedThing: ChatCompletionStep = {
  toolCall: {
    id: "write-requested",
    name: "executeCode",
    arguments: {
      code: "export default async function(self, env) { await env.REQUESTED_THING.writeValue(7); }",
    },
  },
};
const bindRequestedThing: ChatCompletionStep = {
  toolCall: {
    id: "bind-requested",
    name: "setGadgetBinding",
    arguments: { gadget: "APP", source: "REQUESTED_THING", name: "RETRY_DATA" },
  },
};

const TEST_ACTION_STATE = z.object({
  pending: z.array(z.object({ id: z.number(), value: z.number() })),
  value: z.number().optional(),
  applyCount: z.number(),
});

async function actionState(label: string) {
  const response = await harness.fetchWorker(
      TEST_GATEKEEPER_WORKER, "http://gatekeeper-test.test/control/action-state",
      { method: "POST", body: JSON.stringify({ label }) });
  if (response.status !== 200) {
    throw new Error(`Reading test action state failed with ${response.status}: ${await response.text()}`);
  }
  return TEST_ACTION_STATE.parse(await response.json());
}

const openSession = (model: RoutedScriptedModel, usernamePrefix: string) =>
  openAgentSession(harness.url, {
    modelId: SCRIPTED_MODEL_ID,
    userModel: model.userModel,
    ambientVendorIds: [TEST_VENDOR_ID],
    usernamePrefix,
  });

function connectionCard(history: AiChatMessage[]) {
  const card = history.find(message => message.type === "connectionRequest");
  if (!card) throw new Error("The agent did not create a connection request");
  return card;
}

it.concurrent("accepting a connection request binds the gatekeeper the user picked", async () => {
  const model = models.script([requestConnection, writeRequestedThing]);
  await using session = await openSession(model, "connectionaccept");

  const first = await session.runTurn("Connect the requested thing.");
  expect(first.outcome).toEqual({ status: "completed" });
  expect(model.requests).toHaveLength(1);
  const pending = connectionCard(first.history);
  expect(pending).toMatchObject({
    state: "pending",
    vendorId: REQUEST.vendorId,
    resourceUrl: REQUEST.resourceUrl,
    bindingName: REQUEST.bindingName,
  });

  await withOwnerWorkspace(harness.url, session.username, async ws => {
    const account = session.connectedAccount(TEST_VENDOR_ID);
    using decoy = await ws.newGatekeeper(account.id, "https://gadgets-test.example/things/decoy");
    using chosen = await ws.newGatekeeper(account.id, "https://gadgets-test.example/things/chosen");
    if (!decoy || !chosen) throw new Error("Failed to create the test connections");
    const [decoyId, chosenId] = await Promise.all([decoy.getId(), chosen.getId()]);
    expect(chosenId).not.toBe(decoyId);

    await ws.acceptConnectionRequest(pending.requestId, { gatekeeperId: chosenId });
    const [write] = await waitFor("the write through the accepted binding", async () => {
      const { entries } = await ws.listActions({ filter: "pending" });
      return entries.length === 1 ? entries : null;
    });
    expect(write).toMatchObject({ type: "action", gatekeeperId: chosenId });
    await waitForIdleChat(ws, pending.chatId);

    const history = await loadAllChatHistory(
        before => ws.getChatHistory(pending.chatId, before));
    expect(connectionCard(history)).toMatchObject({
      state: "accepted",
      gatekeeperId: chosenId,
      bindingName: "REQUESTED_THING",
    });
  });

  expect(JSON.stringify(model.requests[1])).toContain("accepted your connection request");
  expect(JSON.stringify(model.requests[1])).toContain("env.REQUESTED_THING");
  expect(model.remainingSteps()).toBe(0);
});

it.concurrent("denying a connection request leaves the agent stopped", async () => {
  const model = models.script([requestConnection, { text: "Understood." }]);
  await using session = await openSession(model, "connectiondeny");

  const first = await session.runTurn("Connect the requested thing.");
  expect(first.outcome).toEqual({ status: "completed" });
  const pending = connectionCard(first.history);
  await withOwnerWorkspace(harness.url, session.username, async ws => {
    await ws.denyConnectionRequest(pending.requestId);
    const history = await loadAllChatHistory(
        before => ws.getChatHistory(pending.chatId, before));
    expect(connectionCard(history)).toMatchObject({ state: "denied" });
    expect((await ws.listChats()).find(chat => chat.id === pending.chatId)?.activeAgent).toBeUndefined();
  });

  const next = await session.runTurn("Never mind.");
  expect(next.outcome).toEqual({ status: "completed" });
  expect(model.requests).toHaveLength(2);
  expect(JSON.stringify(model.requests[1])).toContain("denied your connection request");
  expect(model.remainingSteps()).toBe(0);
});

it.concurrent("removing a connection cuts off its pending action, its bindings and its sessions",
    async () => {
  const model = models.script([
    {
      toolCall: {
        id: "create-app",
        name: "createGadget",
        arguments: { title: "App", bindingName: "APP" },
      },
    },
    requestConnection,
    writeRequestedThing,
    bindRequestedThing,
    { text: "The connection is gone." },
  ]);
  await using session = await openSession(model, "connectionremove");
  const account = session.connectedAccount(TEST_VENDOR_ID);
  const label = accountLabel(account);

  const first = await session.runTurn("Connect the requested thing.");
  expect(first.outcome).toEqual({ status: "completed" });
  const pending = connectionCard(first.history);
  const appSummary = first.workpieces.find(
      summary => summary.type === "gadget" && summary.title === "App");
  if (!appSummary) throw new Error("The agent did not create APP");
  await session.acceptChanges();

  await withOwnerWorkspace(harness.url, session.username, async ws => {
    using thing = await ws.newGatekeeper(
        account.id, "https://gadgets-test.example/things/removal");
    if (!thing) throw new Error("Failed to create the test connection");
    const thingId = await thing.getId();
    using app = await ws.getGadget(appSummary.id);
    await app.bind("OLD_DATA", thingId);
    expect(await app.listBindings()).toContainEqual(expect.objectContaining({
      name: "OLD_DATA", target: thingId,
    }));
    using stale = await thing.openSession() as RpcStub<TestSession>;

    await ws.acceptConnectionRequest(pending.requestId, { gatekeeperId: thingId });
    const [action] = await waitFor("the requested write to await approval", async () => {
      const { entries } = await ws.listActions({ filter: "pending" });
      return entries.length === 1 ? entries : null;
    });
    await waitForIdleChat(ws, pending.chatId);

    expect(await actionState(label)).toEqual({
      pending: [{ id: expect.any(Number), value: 7 }],
      applyCount: 0,
    });
    await thing.remove();

    expect((await app.listBindings()).some(binding => binding.target === thingId)).toBe(false);
    await expect(ws.approveAction(action.id)).rejects.toThrow(/no such gatekeeper/i);
    expect((await ws.listActions({ filter: "pending" })).entries.map(entry => entry.id))
        .toEqual([action.id]);
    expect(await actionState(label)).toEqual({
      pending: [{ id: expect.any(Number), value: 7 }],
      applyCount: 0,
    });

    await expect(stale.writeValue(8)).rejects.toThrow(
        /^The execution context which hosts this callback is no longer running\.$/);
    expect((await ws.listActions({ filter: "pending" })).entries.map(entry => entry.id))
        .toEqual([action.id]);
    expect(await actionState(label)).toEqual({
      pending: [{ id: expect.any(Number), value: 7 }],
      applyCount: 0,
    });

    const retry = await session.runTurn("Wire the requested connection into APP.");
    expect(retry.outcome).toEqual({ status: "completed" });
    const bindingCall = retry.history.flatMap(message =>
      message.type === "message" ? message.toolCalls ?? [] : [])
        .find(call => call.toolName === "setGadgetBinding");
    if (!bindingCall) throw new Error("The agent did not call setGadgetBinding");
    expect(bindingCall.error).toBe("This resource is no longer available.");
    expect((await app.listBindings()).some(binding => binding.name === "RETRY_DATA")).toBe(false);
  });

  expect(model.remainingSteps()).toBe(0);
});
