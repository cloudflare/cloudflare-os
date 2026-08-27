import { z } from "zod";
import { afterAll, beforeAll, expect, it } from "vitest";
import { openAgentSession } from "../src/agent-session.js";
import {
  startTestGatekeeperHarness, TEST_VENDOR_ID, type Harness,
} from "../src/harness.js";
import {
  scriptedChatCompletions, SCRIPTED_MODEL_CONFIG, SCRIPTED_MODEL_ID,
  SCRIPTED_MODEL_PROFILE,
} from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { waitFor } from "../src/rpc-client.js";

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
const READ_TEST_VALUE =
    "export default async function(self, env) { console.log(await env.TEST_AMBIENT.readValue()); }";
const model = scriptedChatCompletions([
  {
    toolCall: {
      id: "read-test-value",
      name: "executeCode",
      arguments: {
        code: READ_TEST_VALUE,
      },
    },
  },
  { text: "The test value is 42." },
  {
    toolCall: {
      id: "read-test-value-again",
      name: "executeCode",
      arguments: { code: READ_TEST_VALUE },
    },
  },
  { text: "The test value is still 42." },
  { error: { status: 503, message: "scripted provider outage" } },
  { pending: true },
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

it("keeps multi-turn history and returns provider errors", async () => {
  await using session = await openAgentSession(harness.url, {
    modelId: SCRIPTED_MODEL_ID,
    userModel: { profile: SCRIPTED_MODEL_PROFILE, config: SCRIPTED_MODEL_CONFIG },
    ambientVendorIds: [TEST_VENDOR_ID],
  });
  const requestsBefore = model.requests.length;
  const preCancelled = new AbortController();
  preCancelled.abort();
  const cancelledBeforeDispatch = await session.runTurn("Do not send this prompt.", {
    signal: preCancelled.signal,
  });
  expect(cancelledBeforeDispatch.outcome).toEqual({
    status: "cancelled",
    message: "Agent activation was cancelled",
  });
  expect(model.requests).toHaveLength(requestsBefore);

  const result = await session.runTurn("Read the test value and tell me what it is.");

  expect(result.outcome).toEqual({ status: "completed" });
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
  expect(result.history).toEqual(expect.arrayContaining([
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
  expect((await session.listActions({ filter: "observation" })).entries).toContainEqual(
      expect.objectContaining({
        type: "observation",
        description: expect.objectContaining({ title: "Read the test value" }),
      }));
  const cancelledAfterTurn = new AbortController();
  cancelledAfterTurn.abort();
  const retained = await session.runTurn("Do not send this repeated prompt.", {
    signal: cancelledAfterTurn.signal,
  });
  expect(retained.outcome.status).toBe("cancelled");
  expect(retained.history).toEqual(result.history);
  expect(retained.workpieces).toEqual(result.workpieces);
  expect(retained.usage).toEqual(result.usage);
  expect(model.requests).toHaveLength(2);
  const second = await session.runTurn("Check the test value again.");
  expect(second.outcome).toEqual({ status: "completed" });
  expect(model.requests).toHaveLength(4);
  expect(second.history).toEqual(expect.arrayContaining([
    expect.objectContaining({
      type: "message",
      author: expect.objectContaining({ type: "user" }),
      message: "Check the test value again.",
    }),
    expect.objectContaining({
      type: "message",
      author: expect.objectContaining({ type: "agent" }),
      message: "The test value is still 42.",
    }),
  ]));
  const failed = await session.runTurn("Trigger the scripted provider failure.");
  expect(failed.outcome).toMatchObject({
    status: "error",
    message: expect.stringContaining("scripted provider outage"),
  });
  expect(failed.history).toEqual(expect.arrayContaining([
    expect.objectContaining({
      type: "error",
      message: expect.stringContaining("scripted provider outage"),
    }),
  ]));
  expect(model.requests).toHaveLength(5);
  const controller = new AbortController();
  const cancelling = session.runTurn("Trigger a model request that never resolves.", {
    timeoutMs: 40_000,
    signal: controller.signal,
  });
  await waitFor("the pending model request", () =>
    Promise.resolve(model.requests.length === 6 ? true : null));
  controller.abort();
  const cancelled = await cancelling;
  expect(cancelled.outcome).toMatchObject({ status: "cancelled" });
  expect(() => session.runTurn("Do not run this turn.")).toThrow("cannot continue");
  expect(model.remainingSteps()).toBe(0);
});
