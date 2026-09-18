import { z } from "zod";
import { afterAll, beforeAll, expect, it } from "vitest";
import { openAgentSession } from "../src/agent-session.js";
import { startTestGatekeeperHarness, type Harness } from "../src/harness.js";
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
  // One step writes the file and reads it back: the read sees the write.
  { toolCalls: [
    { id: "write", name: "writeFile",
      arguments: { workpiece: "NOTES", filename: "notes.txt", content: "secret = 42\n" } },
    { id: "read", name: "readFile",
      arguments: { workpiece: "NOTES", filename: "notes.txt" } },
  ] },
  { text: "Done." },
  // After the rewind, the write no longer counts as having read the file: an edit without a
  // fresh read is refused, and the model is told to read first.
  { toolCall: { id: "edit", name: "editFile",
                arguments: { workpiece: "NOTES", filename: "notes.txt",
                             textToReplace: "secret", replacement: "answer" } } },
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

it("forgets a step's reads and writes when the user reverts it", async () => {
  await using session = await openAgentSession(harness.url, {
    modelId: SCRIPTED_MODEL_ID,
    userModel: { profile: SCRIPTED_MODEL_PROFILE, config: SCRIPTED_MODEL_CONFIG },
  });

  const result = await session.runTurn("Write the secret, then read it back.");
  expect(result.outcome).toEqual({ status: "completed" });
  expect(toolResultText(model.requests[2], "read")).toBe("secret = 42\n");

  // The step's edit lands in a "changes" message written after the tool-call message; reverting
  // the step starts there. The read result must not outlive the content it saw.
  const stepChanges = result.history.find(msg =>
    msg.type === "changes" && msg.author.type === "agent" && msg.change !== undefined);
  if (stepChanges === undefined) throw new Error("No agent changes message in history");
  await session.revertChanges(stepChanges.sequence);

  const second = await session.runTurn("Anything else?");
  expect(second.outcome).toEqual({ status: "completed" });
  expect(toolResultText(model.requests[3], "read")).toMatch(/elided from the chat history/);
  expect(toolResultText(model.requests[3], "read")).not.toContain("secret = 42");
  expect(toolResultText(model.requests[4], "edit"))
      .toContain("You must read a file before you can edit it.");
  expect(model.remainingSteps()).toBe(0);
});
