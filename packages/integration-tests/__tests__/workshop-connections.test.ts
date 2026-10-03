import { afterAll, beforeAll, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import type { AiChatMessage, ConnectedAccountsSubscriber } from "@gadgets/workshop-shared/api";
import type { AccountDescription } from "@gadgets/workshop-shared/gatekeeper";
import type { TestSession } from "../fixtures/gatekeeper-test/src/test-gatekeeper.js";
import { loadAllChatHistory, openAgentSession } from "../src/agent-session.js";
import {
  startTestGatekeeperHarness, TEST_VENDOR_ID, testActionState, testControl, type Harness,
} from "../src/harness.js";
import {
  SCRIPTED_MODEL_ID, scriptedModelRouter, type ChatCompletionStep, type RoutedScriptedModel,
} from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  accountLabel, connect, listConnectedAccounts, nextUsernames, restartWorkspace, RpcTarget,
  signUp, stubFor, waitFor, waitForIdleChat, withOwnerWorkspace, type ConnectedAccount,
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

const actionState = (label: string) => testActionState(harness, label);

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

function connectionCardFor(history: AiChatMessage[], bindingName: string) {
  const card = history.find(message =>
    message.type === "connectionRequest" && message.bindingName === bindingName);
  if (!card || card.type !== "connectionRequest") {
    throw new Error(`No connection request for ${bindingName}`);
  }
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

it.concurrent("the agent resumes once, only after every connection request of its turn is accepted",
    async () => {
  const FIRST = {
    ...REQUEST,
    resourceUrl: "https://gadgets-test.example/things/first",
    bindingName: "FIRST_THING",
  };
  const SECOND = {
    ...REQUEST,
    resourceUrl: "https://gadgets-test.example/things/second",
    bindingName: "SECOND_THING",
  };
  const model = models.script([
    { toolCalls: [
      { id: "first", name: "requestConnection", arguments: FIRST },
      { id: "second", name: "requestConnection", arguments: SECOND },
    ] },
    { text: "Both connections are ready." },
  ]);
  await using session = await openSession(model, "connectionbarrier");

  const turn = await session.runTurn("Connect both things.");
  expect(turn.outcome).toEqual({ status: "completed" });
  expect(turn.history.filter(message => message.type === "connectionRequest")).toHaveLength(2);
  const first = connectionCardFor(turn.history, "FIRST_THING");
  const second = connectionCardFor(turn.history, "SECOND_THING");
  expect(first.state).toBe("pending");
  expect(second.state).toBe("pending");
  expect(first.requestId).not.toBe(second.requestId);
  expect(model.requests).toHaveLength(1);
  const { chatId } = first;

  await withOwnerWorkspace(harness.url, session.username, async ws => {
    const account = session.connectedAccount(TEST_VENDOR_ID);
    using firstGatekeeper = await ws.newGatekeeper(account.id, FIRST.resourceUrl);
    using secondGatekeeper = await ws.newGatekeeper(account.id, SECOND.resourceUrl);
    if (!firstGatekeeper || !secondGatekeeper) throw new Error("Failed to create the test connections");
    const [firstId, secondId] = await Promise.all([firstGatekeeper.getId(), secondGatekeeper.getId()]);

    await ws.acceptConnectionRequest(first.requestId, { gatekeeperId: firstId });
    // Resuming marks the chat active before acceptConnectionRequest returns, so idle means the barrier held.
    expect((await ws.listChats()).find(chat => chat.id === chatId)?.activeAgent).toBeUndefined();
    const partial = await loadAllChatHistory(before => ws.getChatHistory(chatId, before));
    expect(connectionCardFor(partial, "FIRST_THING"))
        .toMatchObject({ state: "accepted", gatekeeperId: firstId });
    expect(connectionCardFor(partial, "SECOND_THING")).toMatchObject({ state: "pending" });
    expect(model.requests).toHaveLength(1);

    await ws.acceptConnectionRequest(second.requestId, { gatekeeperId: secondId });
    await waitForIdleChat(ws, chatId);
    const settled = await loadAllChatHistory(before => ws.getChatHistory(chatId, before));
    expect(connectionCardFor(settled, "FIRST_THING"))
        .toMatchObject({ state: "accepted", gatekeeperId: firstId });
    expect(connectionCardFor(settled, "SECOND_THING"))
        .toMatchObject({ state: "accepted", gatekeeperId: secondId });
    expect(settled.filter(message => message.type === "message" && message.author.type === "agent" &&
      message.message === "Both connections are ready.")).toHaveLength(1);
  });

  expect(model.requests).toHaveLength(2);
  expect(JSON.stringify(model.requests[1])).toContain("env.FIRST_THING");
  expect(JSON.stringify(model.requests[1])).toContain("env.SECOND_THING");
  expect(model.remainingSteps()).toBe(0);
});

it.concurrent("a connection request left pending across a workspace restart is decided exactly once",
    async () => {
  const model = models.script([requestConnection, { text: "Connection restored." }]);
  await using session = await openSession(model, "connectionrestart");

  const first = await session.runTurn("Connect the requested thing.");
  expect(first.outcome).toEqual({ status: "completed" });
  const pending = connectionCard(first.history);
  expect(pending.state).toBe("pending");

  await withOwnerWorkspace(harness.url, session.username, ws => restartWorkspace(harness.url, ws));
  await waitFor("the restart to drop the session", async () => session.connectionDrops > 0 || null);

  await withOwnerWorkspace(harness.url, session.username, async ws => {
    // A turn that ended on a decision is not an active agent, so restart recovery must not resume it.
    expect((await ws.listChats()).find(chat => chat.id === pending.chatId)?.activeAgent).toBeUndefined();
    expect(model.requests).toHaveLength(1);
    const restarted = await loadAllChatHistory(before => ws.getChatHistory(pending.chatId, before));
    expect(restarted.filter(message => message.type === "connectionRequest")).toEqual([
      expect.objectContaining({
        requestId: pending.requestId,
        state: "pending",
        bindingName: REQUEST.bindingName,
        resourceUrl: REQUEST.resourceUrl,
      }),
    ]);

    using chosen = await ws.newGatekeeper(
        session.connectedAccount(TEST_VENDOR_ID).id, "https://gadgets-test.example/things/restart-chosen");
    if (!chosen) throw new Error("Failed to create the test connection");
    const chosenId = await chosen.getId();
    await ws.acceptConnectionRequest(pending.requestId, { gatekeeperId: chosenId });
    await waitForIdleChat(ws, pending.chatId);

    const decided = await loadAllChatHistory(before => ws.getChatHistory(pending.chatId, before));
    expect(decided.filter(message => message.type === "connectionRequest")).toEqual([
      expect.objectContaining({ requestId: pending.requestId, state: "accepted", gatekeeperId: chosenId }),
    ]);
    expect(decided.filter(message => message.type === "message" && message.author.type === "agent" &&
      message.message === "Connection restored.")).toHaveLength(1);
  });

  expect(model.requests).toHaveLength(2);
  expect(JSON.stringify(model.requests[1])).toContain("env.REQUESTED_THING");
  expect(model.remainingSteps()).toBe(0);
});

/** What the Connectors page hears while it stays open. */
class ConnectorsPage extends RpcTarget implements ConnectedAccountsSubscriber {
  readonly added: ConnectedAccount[] = [];
  readonly removed: number[] = [];
  add(id: number, description: AccountDescription, _vendor: unknown, _resources: unknown,
      credentialsValid: boolean, vendorId: string) {
    this.added.push({ id, description, credentialsValid, vendorId });
  }
  remove(id: number) { this.removed.push(id); }
  ready() {}
}

it.concurrent("disconnecting an account from the Connectors page removes it and revokes it",
    async () => {
  const [username] = nextUsernames("disconnect");
  using publicApi = connect(harness.url);
  using api = await signUp(publicApi, username!);
  const page = new ConnectorsPage();
  using pageStub = stubFor(page);
  using _subscription = await api.subscribeConnectedAccounts(pageStub);

  await api.provisionAmbientAccount(TEST_VENDOR_ID);
  const account = await waitFor("the new account to appear on the page", async () =>
    page.added.find(added => added.vendorId === TEST_VENDOR_ID) ?? null);
  await api.disconnectAccount(account.id);

  await waitFor("the account to leave the page", async () =>
    page.removed.includes(account.id) || null);
  expect((await listConnectedAccounts(api)).map(listed => listed.id)).not.toContain(account.id);
  expect(await testControl(harness, "revocation-count", { label: accountLabel(account) }))
      .toEqual({ count: 1 });
});
