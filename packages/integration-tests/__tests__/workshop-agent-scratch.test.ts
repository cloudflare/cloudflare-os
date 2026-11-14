import { z } from "zod";
import { afterAll, beforeAll, expect, it } from "vitest";
import { openAgentSession } from "../src/agent-session.js";
import { startTestGatekeeperHarness, TEST_VENDOR_ID, type Harness } from "../src/harness.js";
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

// The fixture gatekeeper's text, "scan line 1" onwards: 58,893 characters, well past the
// 32K-character cap on what the model sees of one result. It never passes through the model:
// the code pipes the gatekeeper's stream into the worktree.
const LINES = 4000;
const pipe = (id: string, filename: string, failAtLine?: number) => ({
  toolCall: { id, name: "executeCode", arguments: { code: `
export default async function(self, env) {
  const { text } = await env.TEST_AMBIENT.readText(${LINES}, ${failAtLine});
  try {
    await env.SCAN.writeBytes("${filename}", text);
    console.log("written");
  } catch {
    console.log("rejected");
  }
  console.log((await env.SCAN.listFiles()).map(entry => entry.path).join(" "));
}` } },
});

let harness: Harness;
const model = scriptedChatCompletions([
  { toolCall: { id: "create", name: "createWorktree",
                arguments: { title: "Scan", bindingName: "SCAN" } } },
  pipe("pipe", "scan.md"),
  { toolCall: { id: "read-window", name: "readFile",
                arguments: { workpiece: "SCAN", filename: "scan.md", startLine: 2000, lineCount: 3 } } },
  { toolCall: { id: "grep", name: "grep",
                arguments: { workpiece: "SCAN", pattern: "^scan line 3999$" } } },
  pipe("pipe-broken", "broken.md", 2500),
  { text: "Done." },
  { text: "Still done." },
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

it("pipes a long text into an empty worktree and reads it by window and grep", async () => {
  await using session = await openAgentSession(harness.url, {
    modelId: SCRIPTED_MODEL_ID,
    userModel: { profile: SCRIPTED_MODEL_PROFILE, config: SCRIPTED_MODEL_CONFIG },
    ambientVendorIds: [TEST_VENDOR_ID],
  });

  const result = await session.runTurn("Read the scan.");
  expect(result.outcome).toEqual({ status: "completed" });
  expect(model.requests).toHaveLength(6);

  // The worktree was created with no commit, and held nothing until the stream was written.
  const created = toolResultText(model.requests[1], "create");
  expect(JSON.parse(created)).toEqual({
    worktreeId: expect.any(Number), changeId: 0, baseCommit: expect.stringMatching(/^[0-9a-f]{40}$/),
  });
  expect(toolResultText(model.requests[2], "pipe")).toBe("written\nscan.md");

  // The window and the search answer from the file.
  const window = "scan line 2000\nscan line 2001\nscan line 2002\n\n" +
      `[lines 2000-2002 of ${LINES}; next startLine: 2003]`;
  expect(toolResultText(model.requests[3], "read-window")).toBe(window);
  expect(toolResultText(model.requests[4], "grep")).toBe("scan.md:3999:scan line 3999");

  // A stream that errors partway rejects writeBytes() and leaves no file.
  expect(toolResultText(model.requests[5], "pipe-broken")).toBe("rejected\nscan.md");
  const written = result.history.flatMap(message =>
    message.type === "changes" ? Object.values(message.change ?? {}).flat() : [])
      .map(([path]) => path);
  expect(written).toEqual(["scan.md"]);

  // A second turn replays the history: the same creation, window and search.
  const second = await session.runTurn("Anything else?");
  expect(second.outcome).toEqual({ status: "completed" });
  expect(model.requests).toHaveLength(7);
  expect(toolResultText(model.requests[6], "create")).toBe(created);
  expect(toolResultText(model.requests[6], "read-window")).toBe(window);
  expect(toolResultText(model.requests[6], "grep")).toBe("scan.md:3999:scan line 3999");

  // No request carried the text: only the lines of the window and the search.
  for (const request of model.requests) {
    expect(JSON.stringify(request).match(/scan line \d+/g)?.length ?? 0).toBeLessThan(10);
  }
  expect(model.remainingSteps()).toBe(0);
});
