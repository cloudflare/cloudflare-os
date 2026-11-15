// The branch approval model (plans/forking-reality.md), turned on with BRANCH_APPROVAL, against
// a real gatekeeper Worker and real agent turns. The fixture's writes are awaited actions
// (ActionDescription.awaitDecision), so the agent's turn waits on each: approving one applies its
// chat's earlier actions on the connection and the older staged ones, in ID order, through
// applyAction() for a gatekeeper that applies one action at a time; rules apply it at once; and
// discarding the chat rejects it. The kernel's unit tests (branch-approval.test.ts) cover accepts
// of actions nothing waits on.

import { afterAll, beforeAll, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import type { ActionLogEntry, Overseer } from "@gadgets/workshop-shared/api";
import type { TestSession } from "../fixtures/gatekeeper-test/src/test-gatekeeper.js";
import { openAgentSession, type WorkshopAgentSession } from "../src/agent-session.js";
import {
  startTestGatekeeperHarness, TEST_VENDOR_ID, testActionState, type Harness,
} from "../src/harness.js";
import {
  SCRIPTED_MODEL_ID, scriptedModelRouter, type ChatCompletionStep, type RoutedScriptedModel,
} from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { accountLabel, waitFor, withOwnerWorkspace } from "../src/rpc-client.js";

let harness: Harness;
const models = scriptedModelRouter();
const network = new NetworkInterceptor({ handlers: [models.handler] });

beforeAll(async () => {
  network.install();
  harness = await startTestGatekeeperHarness({
    enableGadgetExecution: true,
    patchWorkshop: config => { config.vars = { ...config.vars, BRANCH_APPROVAL: "true" }; },
  });
});

afterAll(async () => {
  try {
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

const SET_VALUE = { tag: "set-value", label: "Set value" };

const executeCode = (code: string): ChatCompletionStep => ({
  toolCall: {
    id: "run",
    name: "executeCode",
    arguments: { code: `export default async function(self, env) { console.log(${code}); }` },
  },
});

const openSession = (model: RoutedScriptedModel, usernamePrefix: string) =>
  openAgentSession(harness.url, {
    modelId: SCRIPTED_MODEL_ID, userModel: model.userModel, ambientVendorIds: [TEST_VENDOR_ID],
    usernamePrefix,
  });

const labelOf = (session: WorkshopAgentSession) =>
  accountLabel(session.connectedAccount(TEST_VENDOR_ID));

async function writes(overseer: RpcStub<Overseer>) {
  const { entries } = await overseer.listActions({ filter: "action" });
  return entries.filter((entry): entry is ActionLogEntry & { type: "action" } =>
    entry.type === "action").toSorted((a, b) => a.id - b.id);
}

// The ambient test connection, which the chat's first read names, and a user's session on it,
// outside any chat, whose writes are staged.
async function stagingSession(overseer: RpcStub<Overseer>) {
  const { entries } = await overseer.listActions({ filter: "observation" });
  using connection = await overseer.getGatekeeperById(entries[0].gatekeeperId!);
  return { gatekeeperId: entries[0].gatekeeperId!,
           session: await connection.openSession() as RpcStub<TestSession> };
}

it.concurrent("approving an awaited write applies the older staged one first, one at a time",
    async () => {
  const model = models.script([
    executeCode("await env.TEST_AMBIENT.readValue()"), { text: "Read." },
    executeCode("await env.TEST_AMBIENT.writeValue(7)"), { text: "Written." },
  ]);
  await using agent = await openSession(model, "branchawait");
  const label = labelOf(agent);
  await agent.runTurn("Read the test value.");
  await withOwnerWorkspace(harness.url, agent.username, async overseer => {
    const staging = await stagingSession(overseer);
    using session = staging.session;
    await session.writeValue(5);

    await agent.runTurn("Set the test value to 7.");
    const [staged, chatWrite] = await writes(overseer);
    expect([staged.chatId, staged.state, chatWrite.state])
        .toEqual([undefined, "pending", "pending"]);
    // Accepting is refused while the agent waits on the write.
    await expect(overseer.mergeChanges(chatWrite.chatId!)).rejects.toThrow("waiting for a decision");

    await agent.approveActionsAndWait([chatWrite.id]);
    expect((await writes(overseer)).map(write => write.state)).toEqual(["approved", "approved"]);
    expect(await testActionState(harness, label)).toEqual({ pending: [], value: 7, applyCount: 2 });
    expect(model.remainingSteps()).toBe(0);
  });
});

it.concurrent("a rule applies an awaited write at once, and the turn carries on", async () => {
  const model = models.script([
    executeCode("await env.TEST_AMBIENT.readValue()"), { text: "Read." },
    executeCode("await env.TEST_AMBIENT.writeValue(7, {autoApprovable: true})"),
    { text: "Written." },
  ]);
  await using agent = await openSession(model, "branchrule");
  const label = labelOf(agent);
  await agent.runTurn("Read the test value.");
  await withOwnerWorkspace(harness.url, agent.username, async overseer => {
    const { gatekeeperId, session } = await stagingSession(overseer);
    session[Symbol.dispose]();
    await overseer.setAutoApprovedActionKind(gatekeeperId, SET_VALUE);

    await agent.runTurn("Set the test value to 7.");
    await waitFor("the write to apply", async () =>
      (await writes(overseer))[0]?.state === "approved" || null);
    expect((await writes(overseer))[0]).toMatchObject({ autoApproved: true });
    expect(await testActionState(harness, label)).toEqual({ pending: [], value: 7, applyCount: 1 });
    await waitFor("the turn to finish", async () =>
      model.remainingSteps() === 0 && !(await overseer.listChats())[0]?.activeAgent || null);
  });
});

it.concurrent("discarding the chat's changes rejects its pending write", async () => {
  const model = models.script([
    executeCode("await env.TEST_AMBIENT.writeValue(7)"), { text: "This must not run." },
  ]);
  await using agent = await openSession(model, "branchdiscard");
  const label = labelOf(agent);
  await agent.runTurn("Set the test value to 7.");
  await withOwnerWorkspace(harness.url, agent.username, async overseer => {
    const [write] = await writes(overseer);
    await overseer.revertChanges(write.chatId!, 0);
    expect((await writes(overseer)).map(entry => entry.state)).toEqual(["rejected"]);
    expect(await testActionState(harness, label)).toEqual({ pending: [], applyCount: 0 });
    expect((await overseer.listChats()).map(chat => chat.activeAgent)).toEqual([undefined]);
    expect(model.remainingSteps()).toBe(1);
  });
});
