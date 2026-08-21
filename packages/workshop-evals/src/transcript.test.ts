import type { AiChatMessage, AiToolCall } from "@gadgets/workshop-shared/api";
import { describe, expect, it } from "vitest";
import { canonicalTranscript, collectDiagnostics } from "./transcript.js";

const timestamp = new Date("2026-08-18T00:00:00.000Z");
const user = { type: "user", id: "ana@example.com", name: "Ana" } as const;
const agent = { type: "agent", id: "glm-5.2", name: "GLM" } as const;

function message(
    sequence: number,
    author: typeof user | typeof agent,
    text: string,
    toolCalls?: AiToolCall[]): AiChatMessage {
  return {
    chatId: 1,
    sequence,
    timestamp,
    author,
    type: "message",
    message: text,
    ...(toolCalls === undefined ? {} : { toolCalls }),
  };
}

function errorMessage(sequence: number, text: string): AiChatMessage {
  return { chatId: 1, sequence, timestamp, author: agent, type: "error", message: text };
}

const readFile: AiToolCall = {
  toolCallId: "c1",
  toolName: "readFile",
  input: { filename: "server.js" },
};

const failedEdit: AiToolCall = {
  toolCallId: "c2",
  toolName: "editFile",
  input: { filename: "client.js", textToReplace: "a", replacement: "b" },
  error: "no such file",
};

describe("canonicalTranscript", () => {
  it("pairs every tool call with its result", () => {
    const events = canonicalTranscript([
      message(1, user, "build it"),
      message(2, agent, "done", [readFile]),
    ]);
    expect(events.map(event => event.type))
        .toEqual(["message", "message", "tool_call", "tool_result"]);
    expect(events.at(0)).toMatchObject({ role: "user", content: "build it" });
    expect(events.at(2)).toMatchObject({ name: "readFile", arguments: { filename: "server.js" } });
  });

  it("carries a tool failure into the result event", () => {
    const events = canonicalTranscript([message(1, agent, "", [failedEdit])]);
    expect(events.at(1)).toMatchObject({ error: { name: "Error", message: "no such file" } });
  });

  it("drops empty assistant text but keeps its tool calls", () => {
    const events = canonicalTranscript([message(1, agent, "", [readFile])]);
    expect(events.map(event => event.type)).toEqual(["tool_call", "tool_result"]);
  });

  it("ignores messages that are not chat turns", () => {
    expect(canonicalTranscript([errorMessage(1, "ran out of turns")])).toEqual([]);
  });
});

describe("collectDiagnostics", () => {
  it("counts tool calls and keeps only the failures", () => {
    const diagnostics = collectDiagnostics([message(1, agent, "", [readFile, failedEdit])]);
    expect(diagnostics.toolCalls).toBe(2);
    expect(diagnostics.toolErrors).toEqual([{ tool: "editFile", message: "no such file" }]);
    expect(diagnostics.agentErrors).toEqual([]);
  });

  it("collects errors posted into chat history", () => {
    expect(collectDiagnostics([errorMessage(1, "ran out of turns")]).agentErrors)
        .toEqual(["ran out of turns"]);
  });

  it("truncates an unbounded message", () => {
    const diagnostics = collectDiagnostics([errorMessage(1, "x".repeat(5_000))]);
    expect(diagnostics.agentErrors.at(0)).toHaveLength(2_003);
  });
});
