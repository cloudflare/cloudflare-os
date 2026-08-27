import type { AiChatAuthorInfo, AiChatMessage } from "@gadgets/workshop-shared/api";
import { expect, it } from "vitest";
import { measureHistory, toTranscriptEvents } from "./transcript.js";

const user: AiChatAuthorInfo = { type: "user", id: "user", name: "User" };
const agent: AiChatAuthorInfo = { type: "agent", id: "model", name: "Model" };
const gadget: AiChatAuthorInfo = { type: "gadget", id: "gadget-owner", name: "Spawner" };

it("normalizes Workshop messages and failed tools", () => {
  const history: AiChatMessage[] = [{
    chatId: 1,
    sequence: 0,
    timestamp: new Date(0),
    author: user,
    type: "message",
    message: "Build it",
  }, {
    chatId: 1,
    sequence: 1,
    timestamp: new Date(1),
    author: agent,
    type: "message",
    message: "Trying",
    toolCalls: [{
      toolCallId: "call-1",
      toolName: "listBlueprints",
      input: {},
      error: "catalog unavailable",
    }],
  }, {
    chatId: 1,
    sequence: 2,
    timestamp: new Date(2),
    author: agent,
    type: "error",
    message: "model stopped",
  }];

  expect(toTranscriptEvents(history)).toMatchObject([
    { type: "message", role: "user", content: "Build it" },
    { type: "message", role: "assistant", content: "Trying" },
    { type: "tool_call", id: "call-1", name: "listBlueprints" },
    {
      type: "tool_result",
      toolCallId: "call-1",
      name: "listBlueprints",
      error: { message: "catalog unavailable" },
    },
  ]);
  expect(measureHistory(history)).toEqual({
    modelTurns: 1,
    toolCalls: 1,
    toolErrors: 1,
  });
});

it("keeps every model-visible input in the trajectory", () => {
  const history: AiChatMessage[] = [{
    chatId: 1,
    sequence: 0,
    timestamp: new Date(0),
    author: user,
    type: "message",
    message: "Build it",
  }, {
    chatId: 1,
    sequence: 1,
    timestamp: new Date(1),
    author: agent,
    type: "message",
    message: "Working",
  }, {
    chatId: 1,
    sequence: 2,
    timestamp: new Date(2),
    author: gadget,
    type: "message",
    message: "Gadget-authored prompt",
  }, {
    chatId: 1,
    sequence: 3,
    timestamp: new Date(3),
    author: agent,
    type: "agentCallback",
    methodName: "run",
    argsSummary: "[1]",
  }, {
    chatId: 1,
    sequence: 4,
    timestamp: new Date(4),
    author: agent,
    type: "message",
    message: "Handling callback",
  }, {
    chatId: 1,
    sequence: 5,
    timestamp: new Date(5),
    author: agent,
    type: "agentNudge",
    text: "Callbacks are still open",
  }, {
    chatId: 1,
    sequence: 6,
    timestamp: new Date(6),
    author: agent,
    type: "message",
    message: "Continuing",
  }];

  const events = toTranscriptEvents(history);
  expect(events).toMatchObject([
    { type: "message", role: "user", content: "Build it" },
    { type: "message", role: "assistant", content: "Working" },
    { type: "message", role: "user", content: "Gadget-authored prompt" },
    { type: "message", role: "user", content: expect.stringMatching(/self\.run\(\).*\[1\]/s) },
    { type: "message", role: "assistant", content: "Handling callback" },
    { type: "message", role: "user", content: "Callbacks are still open" },
    { type: "message", role: "assistant", content: "Continuing" },
  ]);
});

it("stamps canonical sequence and timestamp metadata on every event", () => {
  const history: AiChatMessage[] = [{
    chatId: 1,
    sequence: 2,
    timestamp: new Date(2),
    author: user,
    type: "message",
    message: "Start",
  }, {
    chatId: 1,
    sequence: 3,
    timestamp: new Date(3),
    author: agent,
    type: "message",
    message: "Done",
  }, {
    chatId: 1,
    sequence: 4,
    timestamp: new Date(4),
    author: agent,
    type: "agentNudge",
    text: "Try again",
  }];

  expect(toTranscriptEvents(history)).toMatchObject([
    {
      type: "message",
      role: "user",
      content: "Start",
      metadata: { sequence: 2, timestamp: new Date(2).toISOString() },
    },
    {
      type: "message",
      role: "assistant",
      content: "Done",
      metadata: { sequence: 3, timestamp: new Date(3).toISOString() },
    },
    {
      type: "message",
      role: "user",
      content: "Try again",
      metadata: { sequence: 4, timestamp: new Date(4).toISOString() },
    },
  ]);
});

it("excludes display-only and non-model records", () => {
  const history: AiChatMessage[] = [{
    chatId: 1,
    sequence: 0,
    timestamp: new Date(0),
    author: user,
    type: "slashCommand",
    request: { command: "summarize" } as never,
  }, {
    chatId: 1,
    sequence: 1,
    timestamp: new Date(1),
    author: agent,
    type: "error",
    message: "model stopped",
  }];

  expect(toTranscriptEvents(history)).toEqual([]);
});

it("keeps batched tool calls before their results", () => {
  const history: AiChatMessage[] = [{
    chatId: 1,
    sequence: 0,
    timestamp: new Date(0),
    author: agent,
    type: "message",
    message: "",
    toolCalls: [{
      toolCallId: "call-1",
      toolName: "listBlueprints",
      input: {},
      error: "first failed",
    }, {
      toolCallId: "call-2",
      toolName: "listBlueprints",
      input: {},
      error: "second failed",
    }],
  }];

  expect(toTranscriptEvents(history).map(event =>
    event.type === "tool_call" ? `call:${event.id}`
      : event.type === "tool_result" ? `result:${event.toolCallId}` : event.type))
    .toEqual(["call:call-1", "call:call-2", "result:call-1", "result:call-2"]);
});
