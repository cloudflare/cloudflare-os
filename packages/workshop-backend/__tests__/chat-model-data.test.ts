import { describe, expect, it } from "vite-plus/test";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import type { AiToolCall } from "@gadgets/workshop-shared/api";
import { makeStoredAssistantMessage, rehydrateStoredAssistantMessage } from "../src/agent.js";

// A representative completed step: signed thinking, redacted thinking, signed text, and two tool
// calls (one with a Google-style thought signature). Extra fields unknown to the Workshop stand in
// for properties future pi-ai versions may add; the snapshot must retain them by default.
function makeAssistantMessage(): AssistantMessage {
  return {
    role: "assistant",
    content: [
      {type: "thinking", thinking: "Let me look at the file.", thinkingSignature: "sig-think-1"},
      {type: "thinking", thinking: "[Reasoning redacted]", thinkingSignature: "opaque-blob",
       redacted: true},
      {type: "text", text: "Reading the file now.", textSignature: "sig-text-1"},
      {type: "toolCall", id: "call_1", name: "readFile",
       arguments: {filename: "main.js"}, thoughtSignature: "sig-thought-1"},
      {type: "toolCall", id: "call_2", name: "executeCode",
       arguments: {code: "1 + 1"},
       futureBlockField: "kept",
      } as AssistantMessage["content"][number],
    ],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-x",
    responseId: "resp_123",
    usage: {
      input: 10, output: 20, cacheRead: 0, cacheWrite: 0,
      totalTokens: 30, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0},
    },
    stopReason: "toolUse",
    timestamp: 1234567890,
    futureMessageField: {kept: true},
  } as AssistantMessage;
}

// The display-side tool-call records persisted with the same step, holding the arguments the
// snapshot elides.
function makeToolCallRecords(): AiToolCall[] {
  return [
    {toolCallId: "call_1", toolName: "readFile", input: {filename: "main.js"}},
    {toolCallId: "call_2", toolName: "executeCode", input: {code: "1 + 1"}},
  ];
}

describe("makeStoredAssistantMessage", () => {
  it("copies everything except tool-call arguments", () => {
    let message = makeAssistantMessage();
    let stored = makeStoredAssistantMessage(message);

    for (let block of stored.content) {
      expect(block).not.toHaveProperty("arguments");
    }

    // Everything else -- including fields this code doesn't know about -- survives verbatim.
    let expected = structuredClone(message) as {content: Record<string, unknown>[]};
    for (let block of expected.content) delete block.arguments;
    expect(stored).toEqual(expected);
  });
});

describe("rehydrateStoredAssistantMessage", () => {
  it("reproduces the original message exactly", () => {
    let message = makeAssistantMessage();
    let stored = makeStoredAssistantMessage(message);

    let result =
        rehydrateStoredAssistantMessage(structuredClone(stored), makeToolCallRecords(), 1, 2);

    expect(result).toEqual(message);
  });

  it("returns undefined when a tool-call record is missing", () => {
    let stored = makeStoredAssistantMessage(makeAssistantMessage());

    let result = rehydrateStoredAssistantMessage(
        stored, makeToolCallRecords().slice(0, 1), 1, 2);

    expect(result).toBeUndefined();
  });
});

function makeModel(overrides: Partial<Model<"anthropic-messages">>): Model<"anthropic-messages"> {
  return {
    id: "claude-x",
    provider: "anthropic",
    api: "anthropic-messages",
    input: ["text", "image"],
    ...overrides,
  } as Model<"anthropic-messages">;
}

function rehydrated(): AssistantMessage {
  let message = rehydrateStoredAssistantMessage(
      makeStoredAssistantMessage(makeAssistantMessage()), makeToolCallRecords(), 1, 2);
  expect(message).toBeDefined();
  return message!;
}

// Pins the pi-ai behavior the snapshot's provenance triple exists to trigger: replaying history
// stamped with the true producing model makes transformMessages reflect same-model reasoning
// verbatim and apply its cross-model conversions when the chat has switched models.
describe("transformMessages over rehydrated history", () => {
  it("keeps reasoning verbatim for the producing model", () => {
    let [result] = transformMessages([rehydrated()], makeModel({}));

    expect(result).toEqual(rehydrated());
  });

  it("applies cross-model conversions after a model switch", () => {
    let [result] = transformMessages([rehydrated()], makeModel({id: "claude-y"}));

    expect(result.role).toBe("assistant");
    let content = (result as AssistantMessage).content;
    // Unencrypted thinking becomes plain text; the redacted block is dropped entirely.
    expect(content.filter(block => block.type === "thinking")).toEqual([]);
    expect(content.filter(block => block.type === "text").map(block => block.text)).toEqual([
      "Let me look at the file.",
      "Reading the file now.",
    ]);
    // Thought signatures are stripped from tool calls, but the calls themselves survive.
    let toolCalls = content.filter(block => block.type === "toolCall");
    expect(toolCalls.map(block => block.id)).toEqual(["call_1", "call_2"]);
    for (let toolCall of toolCalls) {
      expect(toolCall).not.toHaveProperty("thoughtSignature");
    }
  });
});
