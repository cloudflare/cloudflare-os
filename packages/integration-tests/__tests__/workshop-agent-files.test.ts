import { z } from "zod";
import { afterAll, beforeAll, expect, it } from "vitest";
import { openAgentSession } from "../src/agent-session.js";
import { startTestGatekeeperHarness, type Harness } from "../src/harness.js";
import {
  scriptedChatCompletions, SCRIPTED_MODEL_CONFIG, SCRIPTED_MODEL_ID,
  SCRIPTED_MODEL_PROFILE,
} from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";

// What the model sees of each tool result: the `tool` message that answers the call in the
// request that follows it.
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

const NOTES = Array.from({ length: 12 }, (_, i) =>
  i === 3 || i === 8 ? `line ${i + 1} has the needle` : `line ${i + 1}`).join("\n") + "\n";
// Well past the 32K-character cap on what the model sees of one result: 500 lines of 80 chars.
const BIG_LINE = "0123456789".repeat(8);
const BIG = Array.from({ length: 500 }, () => BIG_LINE).join("\n") + "\n";

let harness: Harness;
const model = scriptedChatCompletions([
  { toolCall: { id: "create", name: "createGadget",
                arguments: { title: "Notes", bindingName: "NOTES" } } },
  { toolCall: { id: "write-notes", name: "writeFile",
                arguments: { workpiece: "NOTES", filename: "notes.txt", content: NOTES } } },
  { toolCall: { id: "grep-notes", name: "grep",
                arguments: { workpiece: "NOTES", pattern: "needle", path: "notes.txt" } } },
  { toolCall: { id: "grep-all", name: "grep",
                arguments: { workpiece: "NOTES", pattern: "^line 1" } } },
  { toolCall: { id: "read-window", name: "readFile",
                arguments: { workpiece: "NOTES", filename: "notes.txt", startLine: 8, lineCount: 3 } } },
  { toolCall: { id: "write-big", name: "writeFile",
                arguments: { workpiece: "NOTES", filename: "big.txt", content: BIG } } },
  { toolCall: { id: "read-big", name: "readFile",
                arguments: { workpiece: "NOTES", filename: "big.txt" } } },
  { text: "Done." },
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

it("searches files, reads them by window, and bounds what the model sees", async () => {
  await using session = await openAgentSession(harness.url, {
    modelId: SCRIPTED_MODEL_ID,
    userModel: { profile: SCRIPTED_MODEL_PROFILE, config: SCRIPTED_MODEL_CONFIG },
  });

  const result = await session.runTurn("Set up the notes.");
  expect(result.outcome).toEqual({ status: "completed" });
  expect(model.requests).toHaveLength(8);

  // A single-file search omits the path, like `grep -n` on one file; a whole-workpiece search
  // prefixes it.
  expect(toolResultText(model.requests[3], "grep-notes"))
      .toBe("4:line 4 has the needle\n9:line 9 has the needle");
  expect(toolResultText(model.requests[4], "grep-all"))
      .toBe("notes.txt:1:line 1\nnotes.txt:10:line 10\nnotes.txt:11:line 11\nnotes.txt:12:line 12");

  expect(toolResultText(model.requests[5], "read-window"))
      .toBe("line 8\nline 9 has the needle\nline 10\n\n[lines 8-10 of 12; next startLine: 11]");

  // The unwindowed read of the big file comes back as whole lines under the cap, not the file.
  const big = toolResultText(model.requests[7], "read-big");
  expect(big.length).toBeLessThanOrEqual(32 * 1024);
  const note = /\n\n\[lines 1-(\d+) of 500; next startLine: (\d+)\]$/.exec(big);
  if (note === null) throw new Error(`big.txt read has no window note: ${big.slice(-100)}`);
  const shown = Number(note[1]);
  expect(Number(note[2])).toBe(shown + 1);
  expect(big.slice(0, note.index)).toBe(Array.from({ length: shown }, () => BIG_LINE).join("\n"));

  // Delivered history records the search but not its output: for a worktree that would be
  // repository content, and the UI shows only the call.
  const grepCalls = result.history.flatMap(msg =>
    msg.type === "message" ? (msg.toolCalls ?? []).filter(tc => tc.toolName === "grep") : []);
  expect(grepCalls).toEqual([
    expect.objectContaining({ input: { workpiece: "NOTES", pattern: "needle", path: "notes.txt" } }),
    expect.objectContaining({ input: { workpiece: "NOTES", pattern: "^line 1" } }),
  ]);
  for (const call of grepCalls) expect(call).not.toHaveProperty("output");

  // A second turn replays the history: the model sees the same bounded results it saw live.
  const second = await session.runTurn("Anything else?");
  expect(second.outcome).toEqual({ status: "completed" });
  expect(model.requests).toHaveLength(9);
  expect(toolResultText(model.requests[8], "grep-notes"))
      .toBe("4:line 4 has the needle\n9:line 9 has the needle");
  expect(toolResultText(model.requests[8], "read-window"))
      .toBe("line 8\nline 9 has the needle\nline 10\n\n[lines 8-10 of 12; next startLine: 11]");
  expect(toolResultText(model.requests[8], "read-big")).toBe(big);
  expect(model.remainingSteps()).toBe(0);
});
