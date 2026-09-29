import { afterAll, beforeAll, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import { z } from "zod";
import type { ActionState, AiChatMessage, Overseer } from "@gadgets/workshop-shared/api";
import { openAgentSession, type WorkshopAgentSession } from "../src/agent-session.js";
import {
  startTestGatekeeperHarness, TEST_GATEKEEPER_WORKER, TEST_VENDOR_ID, type Harness,
} from "../src/harness.js";
import {
  SCRIPTED_MODEL_ID, scriptedModelRouter, type ChatCompletionStep, type RoutedScriptedModel,
} from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  accountLabel, restartWorkspace, streamGeneration, waitFor, withOwnerWorkspace,
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

const TEST_ACTION_STATE = z.object({
  pending: z.array(z.object({ id: z.number(), value: z.number() })),
  value: z.number().optional(),
  applyCount: z.number(),
});
type TestActionState = z.infer<typeof TEST_ACTION_STATE>;

async function actionState(label: string): Promise<TestActionState> {
  const response = await harness.fetchWorker(
      TEST_GATEKEEPER_WORKER, "http://gatekeeper-test.test/control/action-state",
      { method: "POST", body: JSON.stringify({ label }) });
  if (response.status !== 200) {
    throw new Error(`Reading test action state failed with ${response.status}: ${await response.text()}`);
  }
  return TEST_ACTION_STATE.parse(await response.json());
}

async function failNextApply(label: string, reason: string): Promise<void> {
  const response = await harness.fetchWorker(
      TEST_GATEKEEPER_WORKER, "http://gatekeeper-test.test/control/fail-next-apply",
      { method: "POST", body: JSON.stringify({ label, reason }) });
  if (response.status !== 204) {
    throw new Error(`Arming an apply failure failed with ${response.status}: ${await response.text()}`);
  }
}

// Each write is one writeValue() call's argument list.
const writeValues = (...writes: (number | string)[]): ChatCompletionStep => ({
  toolCall: {
    id: "write-test-value",
    name: "executeCode",
    arguments: {
      code: `export default async function(self, env) { console.log(${
        writes.map(args => `await env.TEST_AMBIENT.writeValue(${args})`).join(", ")}); }`,
    },
  },
});

const openSession = (model: RoutedScriptedModel, usernamePrefix: string) =>
  openAgentSession(harness.url, {
    modelId: SCRIPTED_MODEL_ID,
    userModel: model.userModel,
    ambientVendorIds: [TEST_VENDOR_ID],
    usernamePrefix,
  });

const labelOf = (session: WorkshopAgentSession) =>
  accountLabel(session.connectedAccount(TEST_VENDOR_ID));

async function expectIdle(ws: RpcStub<Overseer>) {
  expect((await ws.listChats()).map(chat => chat.activeAgent)).toEqual([undefined]);
}

const SET_VALUE = { tag: "set-value", label: "Set value" };

// Auto-approval applies after its RPC returns, so wait for the turn it resumes to finish.
async function waitForResumedTurn(ws: RpcStub<Overseer>, model: RoutedScriptedModel) {
  await waitFor("the resumed turn to finish", async () =>
    model.remainingSteps() === 0 && !(await ws.listChats())[0]?.activeAgent || null);
}

async function waitForPendingActions(session: WorkshopAgentSession, count: number) {
  return waitFor(`${count} test actions to enter the approval queue`, async () => {
    const { entries } = await session.listActions({ filter: "pending" });
    return entries.length === count ? entries.toSorted((a, b) => a.id - b.id) : null;
  });
}

async function actionStatus(session: WorkshopAgentSession, id: number) {
  const { entries } = await session.listActions({ filter: "action" });
  const entry = entries.find(candidate => candidate.id === id);
  if (entry?.type !== "action") throw new Error(`No action record ${id}`);
  return { state: entry.state, resolvedBy: entry.resolvedBy };
}

const decidedBy = (session: WorkshopAgentSession, state: ActionState) =>
  ({ state, resolvedBy: { type: "user", id: session.username } });

const agentSaid = (history: AiChatMessage[], text: string) => history.filter(message =>
  message.type === "message" && message.author.type === "agent" && message.message === text).length;

it.concurrent("rejecting an action discards it and leaves the agent stopped", async () => {
  const model = models.script([writeValues(7), { text: "This must not run." }]);
  await using session = await openSession(model, "agentreject");
  const label = labelOf(session);

  await session.runTurn("Set the test value to 7.");
  const [action] = await waitForPendingActions(session, 1);
  await withOwnerWorkspace(harness.url, session.username, async ws => {
    await ws.rejectAction(action.id);
    await expectIdle(ws);
  });

  expect(await actionState(label)).toEqual({ pending: [], applyCount: 0 });
  expect(await actionStatus(session, action.id)).toMatchObject(decidedBy(session, "rejected"));
  expect(model.requests).toHaveLength(1);
  expect(model.remainingSteps()).toBe(1);
});

it.concurrent("approving every held write applies each and resumes the agent once", async () => {
  const model = models.script([writeValues(7, 8), { text: "Both values are applied." }]);
  await using session = await openSession(model, "agentapprove");
  const label = labelOf(session);

  const firstTurn = await session.runTurn("Set the test values to 7 and 8.");
  const [first, second] = await waitForPendingActions(session, 2);
  expect(firstTurn.outcome).toEqual({ status: "completed" });
  expect([first, second]).toMatchObject([
    { description: { title: "Set the test value to 7" } },
    { description: { title: "Set the test value to 8" } },
  ]);
  expect(await actionState(label)).toEqual({
    pending: [{ id: 1, value: 7 }, { id: 2, value: 8 }],
    applyCount: 0,
  });
  expect(model.requests).toHaveLength(1);

  await withOwnerWorkspace(harness.url, session.username, async ws => {
    await ws.approveAction(first.id);
    await expectIdle(ws);
  });
  expect(await actionState(label)).toEqual({ pending: [{ id: 2, value: 8 }], value: 7, applyCount: 1 });
  expect(model.requests).toHaveLength(1);

  const resumed = await session.approveActionsAndWait([second.id]);
  expect(resumed.outcome).toEqual({ status: "completed" });
  expect(await actionState(label)).toEqual({ pending: [], value: 8, applyCount: 2 });
  for (const { id } of [first, second]) {
    expect(await actionStatus(session, id)).toMatchObject(decidedBy(session, "approved"));
  }
  expect(model.requests).toHaveLength(2);
  expect(model.remainingSteps()).toBe(0);
  expect(agentSaid(resumed.history, "Both values are applied.")).toBe(1);

  await withOwnerWorkspace(harness.url, session.username, ws =>
    expect(ws.approveAction(first.id)).rejects.toThrow("Action is not pending"));
  expect((await actionState(label)).applyCount).toBe(2);
});

it.concurrent("approving a held write while its code runs lets the agent carry on", async () => {
  const model = models.script([
    { toolCall: { id: "write-then-wait", name: "executeCode", arguments: {
      // The wait keeps the tool running while the test approves the write.
      code: "export default async function(self, env) { " +
          "await env.TEST_AMBIENT.writeValue(7); await scheduler.wait(2000); }",
    } } },
    { text: "The value is applied." },
  ]);
  await using session = await openSession(model, "agentmidtool");

  const turn = session.runTurn("Set the test value to 7.");
  const [action] = await waitForPendingActions(session, 1);
  await withOwnerWorkspace(harness.url, session.username, ws => ws.approveAction(action.id));
  expect(agentSaid((await turn).history, "The value is applied.")).toBe(1);
});

it.concurrent("always approving a held write's kind applies it and resumes the agent", async () => {
  const model = models.script([
    writeValues("7, { autoApprovable: true }"), { text: "The value is applied." },
  ]);
  await using session = await openSession(model, "agentalways");
  const label = labelOf(session);

  await session.runTurn("Set the test value to 7.");
  const [action] = await waitForPendingActions(session, 1);
  expect(model.requests).toHaveLength(1);

  await withOwnerWorkspace(harness.url, session.username, async ws => {
    await ws.setAutoApprovedActionKind(action.gatekeeperId!, SET_VALUE);
    await waitForResumedTurn(ws, model);
  });
  expect(await actionState(label)).toEqual({ pending: [], value: 7, applyCount: 1 });
  expect(await actionStatus(session, action.id)).toMatchObject(decidedBy(session, "approved"));
  expect(model.requests).toHaveLength(2);
});

it.concurrent.each(["approve", "reject"] as const)(
    "an always-approved write queued behind a held one applies once the user chooses %s",
    async decision => {
  const model = models.script([
    writeValues(7), writeValues("8, { autoApprovable: true }"), { text: "The value is applied." },
  ]);
  await using session = await openSession(model, `agentqueued${decision}`);
  const label = labelOf(session);

  await session.runTurn("Set the test value to 7.");
  const [held] = await waitForPendingActions(session, 1);
  await withOwnerWorkspace(harness.url, session.username, ws =>
      ws.setAutoApprovedActionKind(held.gatekeeperId!, SET_VALUE));

  await session.runTurn("Set the test value to 8.");
  await waitForPendingActions(session, 2);
  expect(model.requests).toHaveLength(2);

  await withOwnerWorkspace(harness.url, session.username, async ws => {
    await (decision === "approve" ? ws.approveAction(held.id) : ws.rejectAction(held.id));
    await waitForResumedTurn(ws, model);
  });
  expect(await actionState(label))
      .toEqual({ pending: [], value: 8, applyCount: decision === "approve" ? 2 : 1 });
  expect(model.requests).toHaveLength(3);
});

it.concurrent("approving an older turn's held write leaves a newer finished turn ended", async () => {
  const secondUrl = "https://gadgets-test.example/things/second";
  const model = models.script([
    writeValues(7),
    { toolCall: { id: "request-second", name: "requestConnection", arguments: {
      vendorId: TEST_VENDOR_ID, resourceUrl: secondUrl, reason: "Set the second value.",
      bindingName: "SECOND",
    } } },
    { toolCall: { id: "write-second", name: "executeCode", arguments: {
      code: "export default async function(self, env) { " +
          "await env.SECOND.writeValue(8, { autoApprovable: true }); }",
    } } },
    { text: "The second value is applied." },
  ]);
  await using session = await openSession(model, "agentolder");

  await session.runTurn("Set the test value to 7.");
  const [held] = await waitForPendingActions(session, 1);
  const { history } = await session.runTurn("Set the second value to 8.");
  const request = history.find(message => message.type === "connectionRequest");
  if (request?.type !== "connectionRequest") throw new Error("The agent did not request a connection");

  await withOwnerWorkspace(harness.url, session.username, async ws => {
    using second = await ws.newGatekeeper(session.connectedAccount(TEST_VENDOR_ID).id, secondUrl);
    if (!second) throw new Error("Failed to create the second connection");
    const secondId = await second.getId();
    await ws.setAutoApprovedActionKind(secondId, SET_VALUE);
    await ws.acceptConnectionRequest(request.requestId, { gatekeeperId: secondId });
    await waitForResumedTurn(ws, model);

    await ws.approveAction(held.id);
    await expectIdle(ws);
  });
  expect(model.requests).toHaveLength(4);
});

it.concurrent.each(["retry", "reject"] as const)(
    "a failed apply stays pending until the user chooses %s", async choice => {
  const model = models.script([writeValues(9), { text: "The retried value is applied." }]);
  await using session = await openSession(model, `agentfail${choice}`);
  const label = labelOf(session);

  await session.runTurn("Set the test value to 9.");
  const [action] = await waitForPendingActions(session, 1);
  await failNextApply(label, "Test apply failed");
  await withOwnerWorkspace(harness.url, session.username, async ws => {
    await expect(ws.approveAction(action.id)).rejects.toThrow("Test apply failed");
    await expectIdle(ws);
  });
  expect(await actionStatus(session, action.id)).toEqual({ state: "pending" });
  expect(await actionState(label)).toEqual({ pending: [{ id: 1, value: 9 }], applyCount: 0 });
  expect(model.requests).toHaveLength(1);

  if (choice === "retry") {
    const resumed = await session.approveActionsAndWait([action.id]);
    expect(resumed.outcome).toEqual({ status: "completed" });
    expect(await actionState(label)).toEqual({ pending: [], value: 9, applyCount: 1 });
    expect(await actionStatus(session, action.id)).toMatchObject(decidedBy(session, "approved"));
    expect(model.requests).toHaveLength(2);
    expect(agentSaid(resumed.history, "The retried value is applied.")).toBe(1);
  } else {
    await withOwnerWorkspace(harness.url, session.username, async ws => {
      await ws.rejectAction(action.id);
      await expectIdle(ws);
    });
    expect(await actionState(label)).toEqual({ pending: [], applyCount: 0 });
    expect(await actionStatus(session, action.id)).toMatchObject(decidedBy(session, "rejected"));
    expect(model.requests).toHaveLength(1);
    expect(model.remainingSteps()).toBe(1);
  }
});

it.concurrent("approving after a workspace restart applies and resumes once", async () => {
  const model = models.script([writeValues(11), { text: "The restarted approval is applied." }]);
  await using session = await openSession(model, "agentrestart");
  const label = labelOf(session);

  await session.runTurn("Set the test value to 11.");
  const [action] = await waitForPendingActions(session, 1);
  const held = { pending: [{ id: 1, value: 11 }], applyCount: 0 };
  expect(await actionState(label)).toEqual(held);
  expect(model.requests).toHaveLength(1);

  await withOwnerWorkspace(harness.url, session.username, ws => restartWorkspace(harness.url, ws));
  await waitFor("the restart to drop the session", async () => session.connectionDrops > 0 || null);

  expect((await session.listActions({ filter: "pending" })).entries.map(e => e.id))
      .toEqual([action.id]);
  expect(await actionState(label)).toEqual(held);
  expect(model.requests).toHaveLength(1);

  const resumed = await session.approveActionsAndWait([action.id]);
  expect(resumed.outcome).toEqual({ status: "completed" });
  expect(await actionState(label)).toEqual({ pending: [], value: 11, applyCount: 1 });
  expect(await actionStatus(session, action.id)).toMatchObject(decidedBy(session, "approved"));
  expect(model.requests).toHaveLength(2);
  expect(model.remainingSteps()).toBe(0);
  expect(agentSaid(resumed.history, "The restarted approval is applied.")).toBe(1);
});

it.concurrent("a turn interrupted by a workspace restart resumes and completes", async () => {
  const model = models.script([
    {
      toolCall: {
        id: "compute",
        name: "executeCode",
        arguments: { code: "export default async function() { return 6 * 7; }" },
      },
    },
    { pending: true },
    { text: "The answer is 42." },
  ]);
  await using session = await openSession(model, "agentrecovery");

  const turning = session.runTurn("What is 6 times 7?");
  await waitFor("the pending model request", async () => model.requests.length === 2 || null);
  const before = await withOwnerWorkspace(harness.url, session.username, async ws => {
    const generation = await streamGeneration(ws);
    await restartWorkspace(harness.url, ws);
    return generation;
  });

  expect((await turning).outcome).toEqual({ status: "completed" });
  expect(model.requests).toHaveLength(3);
  expect(model.remainingSteps()).toBe(0);
  expect(model.requests[2]).toEqual(model.requests[1]);
  await withOwnerWorkspace(harness.url, session.username, async ws => {
    await expectIdle(ws);
    expect(await streamGeneration(ws)).not.toBe(before);
  });
});
