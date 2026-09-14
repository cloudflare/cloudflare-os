import { z } from "zod";
import { afterAll, beforeAll, expect, it } from "vitest";
import { openAgentSession } from "../src/agent-session.js";
import { startTestGatekeeperHarness, TEST_VENDOR_ID, type Harness } from "../src/harness.js";
import {
  scriptedChatCompletions, SCRIPTED_MODEL_CONFIG, SCRIPTED_MODEL_ID,
  SCRIPTED_MODEL_PROFILE,
} from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";

const TOOL_MESSAGES = z.object({
  messages: z.array(z.object({
    role: z.string(),
    content: z.string().nullish(),
    tool_call_id: z.string().optional(),
  })),
});

function toolResultText(request: unknown, toolCallId: string): string {
  const message = TOOL_MESSAGES.parse(request).messages
      .find(entry => entry.role === "tool" && entry.tool_call_id === toolCallId);
  if (message?.content == null) throw new Error(`No tool result for ${toolCallId}`);
  return message.content;
}

let harness: Harness;
const model = scriptedChatCompletions([
  { toolCall: { id: "create", name: "createGadget",
                arguments: { title: "Notes", bindingName: "NOTES" } } },
  // One step writes the file, reads and searches it, and requests a connection. The read and
  // the search see the write. The request makes the barrier record a "connectionRequest"
  // message between this step's tool-call message and its "changes" message, so the two are
  // not adjacent in the log.
  { toolCalls: [
    { id: "write", name: "writeFile",
      arguments: { workpiece: "NOTES", filename: "notes.txt", content: "secret = 42\n" } },
    { id: "read", name: "readFile",
      arguments: { workpiece: "NOTES", filename: "notes.txt" } },
    { id: "grep", name: "grep",
      arguments: { workpiece: "NOTES", pattern: "secret" } },
    { id: "connect", name: "requestConnection",
      arguments: { vendorId: TEST_VENDOR_ID, reason: "to test", bindingName: "THINGS" } },
  ] },
  { text: "Still done." },
]);
const network = new NetworkInterceptor({ handlers: [model.handler] });

beforeAll(async () => {
  network.install();
  harness = await startTestGatekeeperHarness();
});

afterAll(async () => {
  try {
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

it("elides a step's reads and searches when the user reverts the step", async () => {
  await using session = await openAgentSession(harness.url, {
    modelId: SCRIPTED_MODEL_ID,
    userModel: { profile: SCRIPTED_MODEL_PROFILE, config: SCRIPTED_MODEL_CONFIG },
    usernamePrefix: "revertelide",
  });

  // The connection request ends the turn after the step persists, before the model sees the
  // step's results; it sees them only when the next turn replays the history.
  const result = await session.runTurn("Write the secret, read it back, and connect.");
  expect(result.outcome).toEqual({ status: "completed" });
  expect(model.requests).toHaveLength(2);
  expect(result.history.slice(-3).map(msg => msg.type))
      .toEqual(["message", "connectionRequest", "changes"]);

  // Reverting the step starts at its "changes" message. The read result must not outlive the
  // content it saw, even with the request record between the two messages.
  const stepChanges = result.history.at(-1);
  if (stepChanges === undefined) throw new Error("No history");
  await session.revertChanges(stepChanges.sequence);

  const second = await session.runTurn("Anything else?");
  expect(second.outcome).toEqual({ status: "completed" });
  for (const id of ["read", "grep"]) {
    expect(toolResultText(model.requests[2], id)).toMatch(/elided from the chat history/);
    expect(toolResultText(model.requests[2], id)).not.toContain("secret = 42");
  }
  expect(model.remainingSteps()).toBe(0);
});
