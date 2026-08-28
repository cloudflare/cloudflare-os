import { z } from "zod";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { AiChatAuthorInfo, AiModelConfig } from "@gadgets/workshop-shared/api";
import {
  startTestGatekeeperHarness, TEST_VENDOR_ID, type Harness,
} from "../src/harness.js";
import { scriptedChatCompletions } from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, listConnectedAccounts, nextUsernames, signUp, waitFor } from "../src/rpc-client.js";

const MODEL_ID = "@cf/zai-org/glm-5.2";
const MODEL_PROFILE: AiChatAuthorInfo = { type: "agent", id: MODEL_ID, name: "Scripted model" };
const MODEL_CONFIG: AiModelConfig = {
  provider: "cloudflare",
  model: MODEL_ID,
  accountId: "test-account",
  apiToken: "test-token",
};

const CHAT_REQUEST = z.object({
  messages: z.array(z.object({
    role: z.string(),
    content: z.string().nullish(),
    tool_call_id: z.string().optional(),
    tool_calls: z.array(z.object({
      id: z.string(),
      type: z.literal("function"),
      function: z.object({ name: z.string(), arguments: z.string() }),
    })).optional(),
  })),
  tools: z.array(z.object({
    type: z.literal("function"),
    function: z.object({
      name: z.string(),
      description: z.string(),
      parameters: z.object({
        type: z.literal("object"),
        properties: z.record(z.string(), z.object({
          type: z.string().optional(),
          description: z.string().optional(),
        })),
        required: z.array(z.string()).optional(),
      }),
    }),
  })).optional(),
});

let harness: Harness;
const model = scriptedChatCompletions([
  {
    toolCall: {
      id: "read-test-value",
      name: "executeCode",
      arguments: {
        code: "export default async function(self, env) { console.log(await env.TEST_AMBIENT.readValue()); }",
      },
    },
  },
  { text: "The test value is 42." },
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

it("runs a scripted agent tool call through an ambient gatekeeper", async () => {
  using publicApi = connect(harness.url);
  const [username] = nextUsernames("agent");
  if (username === undefined) throw new Error("Failed to allocate an agent-test username");
  using authenticated = await signUp(publicApi, username);

  await authenticated.addModel(MODEL_PROFILE, MODEL_CONFIG);
  await authenticated.setQuickModel(null);
  await authenticated.setPreferredModel(MODEL_ID);
  await authenticated.completeOnboarding();
  await authenticated.provisionAmbientAccount(TEST_VENDOR_ID);
  await waitFor("the ambient test account to be provisioned", async () =>
    (await listConnectedAccounts(authenticated)).some(account => account.vendorId === TEST_VENDOR_ID)
      ? true : null);

  using workspace = await authenticated.newGadget();
  const chatId = await workspace.newChat("Read the test value and tell me what it is.", MODEL_ID);
  const history = await waitFor("the scripted agent to return its final answer", async () => {
    const current = await workspace.getChatHistory(chatId);
    const error = current.messages.find(message => message.type === "error");
    if (error !== undefined) throw new Error(`The scripted agent failed: ${error.message}`);
    return current.messages.some(message =>
      message.type === "message" && message.author.type === "agent" &&
      message.message === "The test value is 42.") ? current : null;
  });
  expect(model.requests).toHaveLength(2);
  const firstRequest = CHAT_REQUEST.parse(model.requests[0]);
  expect(firstRequest.messages).toContainEqual(expect.objectContaining({
    role: "user",
    content: expect.stringContaining("Read the test value"),
  }));
  expect(firstRequest.tools).toContainEqual(expect.objectContaining({
    type: "function",
    function: expect.objectContaining({
      name: "executeCode",
      description: expect.stringContaining("JavaScript"),
      parameters: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description: expect.stringContaining("self-contained JavaScript module"),
          },
        },
        required: ["code"],
      },
    }),
  }));
  const secondRequest = CHAT_REQUEST.parse(model.requests[1]);
  expect(secondRequest.messages).toContainEqual(expect.objectContaining({
    role: "assistant",
    tool_calls: expect.arrayContaining([
      expect.objectContaining({
        id: "read-test-value",
        type: "function",
        function: expect.objectContaining({
          name: "executeCode",
          arguments: expect.stringContaining("TEST_AMBIENT"),
        }),
      }),
    ]),
  }));
  expect(secondRequest.messages).toContainEqual(expect.objectContaining({
    role: "tool",
    tool_call_id: "read-test-value",
    content: expect.stringContaining("42"),
  }));
  expect(history.messages).toEqual(expect.arrayContaining([
    expect.objectContaining({
      type: "message",
      author: expect.objectContaining({ type: "agent" }),
      toolCalls: expect.arrayContaining([
        expect.objectContaining({ toolName: "executeCode", output: expect.stringContaining("42") }),
      ]),
    }),
    expect.objectContaining({
      type: "message",
      author: expect.objectContaining({ type: "agent" }),
      message: "The test value is 42.",
    }),
  ]));
  await waitFor("the scripted agent to become idle", async () => {
    const chat = (await workspace.listChats()).find(entry => entry.id === chatId);
    return chat !== undefined && chat.activeAgent === undefined ? true : null;
  });
  expect((await workspace.listActions({ filter: "observation" })).entries).toContainEqual(
      expect.objectContaining({
        type: "observation",
        description: expect.objectContaining({ title: "Read the test value" }),
      }));
  expect(model.remainingSteps()).toBe(0);
});
