import { afterAll, beforeAll, expect, it } from "vitest";
import { z } from "zod";
import type { AiChatAuthorInfo, AiModelConfig } from "@gadgets/workshop-shared/api";
import {
  startTestGatekeeperHarness, TEST_GATEKEEPER_WORKER, TEST_VENDOR_ID, type Harness,
} from "../src/harness.js";
import { scriptedChatCompletions } from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  accountLabel, connect, listConnectedAccounts, nextUsernames, signUp, waitFor,
} from "../src/rpc-client.js";

const MODEL_ID = "@cf/zai-org/glm-5.2";
const MODEL_PROFILE: AiChatAuthorInfo = { type: "agent", id: MODEL_ID, name: "Scripted model" };
const MODEL_CONFIG: AiModelConfig = {
  provider: "cloudflare",
  model: MODEL_ID,
  accountId: "test-account",
  apiToken: "test-token",
};

let harness: Harness;
const model = scriptedChatCompletions([
  {
    toolCall: {
      id: "write-test-value",
      name: "executeCode",
      arguments: {
        code: "export default async function(self, env) { console.log(await env.TEST_AMBIENT.writeValue(7)); }",
      },
    },
  },
  { text: "The test value was updated." },
]);
const network = new NetworkInterceptor([model.handler]);

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
  using publicApi = connect(harness.url);
  const [username] = nextUsernames("agentaction");
  if (username === undefined) throw new Error("Failed to allocate an action-test username");
  using authenticated = await signUp(publicApi, username);

  await authenticated.addModel(MODEL_PROFILE, MODEL_CONFIG);
  await authenticated.setQuickModel(null);
  await authenticated.setPreferredModel(MODEL_ID);
  await authenticated.completeOnboarding();
  await authenticated.provisionAmbientAccount(TEST_VENDOR_ID);
  const account = await waitFor("the ambient test account to be provisioned", async () =>
    (await listConnectedAccounts(authenticated)).find(entry => entry.vendorId === TEST_VENDOR_ID)
      ?? null);
  const label = accountLabel(account);

  using workspace = await authenticated.newGadget();
  const chatId = await workspace.newChat("Set the test value to 7.", MODEL_ID);
  const pending = await waitFor("the test action to enter the approval queue", async () => {
    const entries = (await workspace.listActions({ filter: "pending" })).entries;
    return entries.length === 1 ? entries[0] : null;
  });

  expect(pending).toMatchObject({
    type: "action",
    state: "pending",
    description: {
      title: "Set the test value to 7",
      awaitDecision: true,
      implementsRevert: false,
    },
  });
  expect(await actionState(label)).toEqual({
    pending: [{ id: 1, value: 7 }],
    applyCount: 0,
  });
  await waitFor("the agent turn to suspend for approval", async () => {
    const chat = (await workspace.listChats()).find(entry => entry.id === chatId);
    return chat !== undefined && chat.activeAgent === undefined ? true : null;
  });
  expect(model.requests).toHaveLength(1);
  const suspendedHistory = await workspace.getChatHistory(chatId);
  expect(suspendedHistory.messages.some(message =>
    message.type === "message" && message.author.type === "agent" &&
    message.message === "The test value was updated.")).toBe(false);

  await workspace.approveAction(pending.id);
  const history = await waitFor("the scripted agent to continue after approval", async () => {
    const current = await workspace.getChatHistory(chatId);
    const error = current.messages.find(message => message.type === "error");
    if (error !== undefined) throw new Error(`The scripted agent failed: ${error.message}`);
    return current.messages.some(message =>
      message.type === "message" && message.author.type === "agent" &&
      message.message === "The test value was updated.") ? current : null;
  });

  expect(await actionState(label)).toEqual({ pending: [], value: 7, applyCount: 1 });
  const [approved] = (await workspace.listActions({ filter: "action" })).entries;
  expect(approved).toMatchObject({ id: pending.id, state: "approved", type: "action" });
  if (approved?.type !== "action") throw new Error("Approved test action was not an action record");
  expect(approved.resolvedBy).toMatchObject({ type: "user", id: username });
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
        content: expect.stringContaining("1"),
      }),
    ]),
  });
  expect(history.messages).toEqual(expect.arrayContaining([
    expect.objectContaining({
      type: "message",
      author: expect.objectContaining({ type: "agent" }),
      message: "The test value was updated.",
    }),
  ]));
  await expect(workspace.approveAction(pending.id)).rejects.toThrow();
  expect((await actionState(label)).applyCount).toBe(1);
  expect(model.remainingSteps()).toBe(0);
});
