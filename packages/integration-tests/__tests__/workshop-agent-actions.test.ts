import { afterAll, beforeAll, expect, it } from "vitest";
import { z } from "zod";
import { openAgentSession, type WorkshopAgentSession } from "../src/agent-session.js";
import {
  startTestGatekeeperHarness, TEST_GATEKEEPER_WORKER, TEST_VENDOR_ID, type Harness,
} from "../src/harness.js";
import {
  scriptedChatCompletions, SCRIPTED_MODEL_CONFIG, SCRIPTED_MODEL_ID,
  SCRIPTED_MODEL_PROFILE,
} from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { accountLabel, waitFor } from "../src/rpc-client.js";

let harness: Harness;
const model = scriptedChatCompletions([
  {
    toolCall: {
      id: "write-test-value",
      name: "executeCode",
      arguments: {
        code: "export default async function(self, env) { console.log(await env.TEST_AMBIENT.writeValues([7, 8])); }",
      },
    },
  },
  { text: "The test value was updated." },
]);
const network = new NetworkInterceptor({ handlers: [model.handler] });

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

it("holds a scripted agent write until the user approves it", async () => {
  await using session = await openAgentSession(harness.url, {
    modelId: SCRIPTED_MODEL_ID,
    userModel: { profile: SCRIPTED_MODEL_PROFILE, config: SCRIPTED_MODEL_CONFIG },
    ambientVendorIds: [TEST_VENDOR_ID],
    usernamePrefix: "agentaction",
  });
  const label = accountLabel(session.connectedAccount(TEST_VENDOR_ID));

  const firstTurn = await session.runTurn("Set the test values to 7 and 8.");
  const pending = (await waitForPendingActions(session, 2)).toSorted((a, b) => a.id - b.id);
  const [first, second] = pending;
  if (first === undefined || second === undefined) throw new Error("Expected two pending actions");
  expect(firstTurn.outcome).toEqual({ status: "completed" });
  expect(pending).toEqual([
    expect.objectContaining({
      type: "action",
      state: "pending",
      description: expect.objectContaining({ title: "Set the test value to 7", awaitDecision: true }),
    }),
    expect.objectContaining({
      type: "action",
      state: "pending",
      description: expect.objectContaining({ title: "Set the test value to 8", awaitDecision: true }),
    }),
  ]);
  expect(await actionState(label)).toEqual({
    pending: [{ id: 1, value: 7 }, { id: 2, value: 8 }],
    applyCount: 0,
  });
  expect(model.requests).toHaveLength(1);
  expect(firstTurn.history.some(message =>
    message.type === "message" && message.author.type === "agent" &&
    message.message === "The test value was updated.")).toBe(false);

  await expect(session.approveActionsAndWait([first.id, first.id]))
    .rejects.toThrow("Action IDs must be unique");
  await expect(session.approveActionsAndWait([first.id, 999_999]))
    .rejects.toThrow("Actions are not pending");
  expect((await actionState(label)).applyCount).toBe(0);

  const resumed = await session.approveActionsAndWait([first.id, second.id]);
  expect(resumed.outcome).toEqual({ status: "completed" });
  expect(await actionState(label)).toEqual({ pending: [], value: 8, applyCount: 2 });
  const approved = (await session.listActions({ filter: "action" })).entries;
  expect(approved).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: first.id, state: "approved", type: "action" }),
    expect.objectContaining({ id: second.id, state: "approved", type: "action" }),
  ]));
  for (const entry of approved) {
    if (entry.type !== "action") throw new Error("Approved test action was not an action record");
    expect(entry.resolvedBy).toMatchObject({ type: "user", id: session.username });
  }
  expect(model.requests).toHaveLength(2);
  expect(model.requests[1]).toMatchObject({
    messages: expect.arrayContaining([
      expect.objectContaining({
        role: "assistant",
        tool_calls: expect.arrayContaining([
          expect.objectContaining({
            id: "write-test-value",
            type: "function",
            function: expect.objectContaining({
              name: "executeCode",
              arguments: expect.stringContaining("writeValue"),
            }),
          }),
        ]),
      }),
      expect.objectContaining({
        role: "tool",
        tool_call_id: "write-test-value",
        content: expect.stringMatching(/1.*2/),
      }),
    ]),
  });
  expect(resumed.history).toEqual(expect.arrayContaining([
    expect.objectContaining({
      type: "message",
      author: expect.objectContaining({ type: "agent" }),
      message: "The test value was updated.",
    }),
  ]));
  await expect(session.approveActionsAndWait([first.id])).rejects.toThrow();
  expect((await actionState(label)).applyCount).toBe(2);
  expect(model.remainingSteps()).toBe(0);
});

async function waitForPendingActions(session: WorkshopAgentSession, count: number) {
  return waitFor(`${count} test actions to enter the approval queue`, async () => {
    const entries = (await session.listActions({ filter: "pending" })).entries;
    return entries.length === count ? entries : null;
  });
}
