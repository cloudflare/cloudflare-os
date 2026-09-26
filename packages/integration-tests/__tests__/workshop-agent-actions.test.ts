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
import { accountLabel, connect, logIn, nextUsernames, signUp, waitFor } from "../src/rpc-client.js";

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

const writeValues = (...values: number[]): ChatCompletionStep => ({
  toolCall: {
    id: "write-test-value",
    name: "executeCode",
    arguments: {
      code: `export default async function(self, env) { console.log(${
        values.map(value => `await env.TEST_AMBIENT.writeValue(${value})`).join(", ")}); }`,
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

/** The owner's workspace on a separate connection, for decisions that must not await a resume. */
async function withOwnerWorkspace<T>(
    username: string, fn: (ws: RpcStub<Overseer>) => Promise<T>): Promise<T> {
  using publicApi = connect(harness.url);
  using api = await logIn(publicApi, username);
  const [workspace] = await waitFor("the session's workspace", async () => {
    const workspaces = await api.listGadgets();
    return workspaces.length > 0 ? workspaces : null;
  });
  using ws = await api.openGadget(workspace.id);
  return await fn(ws);
}

/** Removing a collaborator is the product's workspace restart. */
async function restartWorkspace(ws: RpcStub<Overseer>) {
  const [collaborator] = nextUsernames("restartcollaborator");
  using publicApi = connect(harness.url);
  using _api = await signUp(publicApi, collaborator);
  const added = await ws.addCollaborator(collaborator, "build");
  if (!added) throw new Error(`Failed to share the workspace with ${collaborator}`);
  await ws.removeCollaborator(added.profile.id, []);
}

async function expectIdle(ws: RpcStub<Overseer>) {
  expect((await ws.listChats()).map(chat => chat.activeAgent)).toEqual([undefined]);
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
  await withOwnerWorkspace(session.username, async ws => {
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

  await withOwnerWorkspace(session.username, async ws => {
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

  await withOwnerWorkspace(session.username, ws =>
    expect(ws.approveAction(first.id)).rejects.toThrow("Action is not pending"));
  expect((await actionState(label)).applyCount).toBe(2);
});

it.concurrent.each(["retry", "reject"] as const)(
    "a failed apply stays pending until the user chooses %s", async choice => {
  const model = models.script([writeValues(9), { text: "The retried value is applied." }]);
  await using session = await openSession(model, `agentfail${choice}`);
  const label = labelOf(session);

  await session.runTurn("Set the test value to 9.");
  const [action] = await waitForPendingActions(session, 1);
  await failNextApply(label, "Test apply failed");
  await withOwnerWorkspace(session.username, async ws => {
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
    await withOwnerWorkspace(session.username, async ws => {
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

  await withOwnerWorkspace(session.username, restartWorkspace);
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
