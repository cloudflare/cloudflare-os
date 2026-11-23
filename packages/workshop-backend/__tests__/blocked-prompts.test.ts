import { describe, expect, it } from "vitest";
import type { AiChatMessage } from "@gadgets/workshop-shared/api";
import { blockedPromptSequences, unansweredInput } from "../src/blocked-prompts.js";

const USER = { type: "user" } as AiChatMessage["author"];
const AGENT = { type: "agent" } as AiChatMessage["author"];

// A log from records written as [type, author?, extra?], numbered in order.
function log(...records: [string, AiChatMessage["author"]?, object?][]): AiChatMessage[] {
  return records.map(([type, author = USER, extra = {}], sequence) => ({
    sequence, timestamp: new Date(0), author, type, message: "", ...extra,
  }) as unknown as AiChatMessage);
}

describe("blockedPromptSequences", () => {
  it("leaves out the user's input since the agent last spoke, edits and uploads included", () => {
    let messages = log(
      ["message"],                                        // 0: answered
      ["message", AGENT],                                 // 1
      ["message"],                                        // 2: the injection
      ["changes"],                                        // 3: its upload
      ["error", AGENT, { code: "prompt_blocked", blockedBefore: 4 }],
      ["message"],                                        // 5: the next message
    );
    expect([...blockedPromptSequences(messages)]).toEqual([2, 3]);
  });

  it("keeps steers the blocked request never read", () => {
    let messages = log(
      ["message", AGENT],
      ["message"],                                        // 1: blocked
      ["message", USER, { steered: true }],               // 2: logged with the error
      ["error", AGENT, { code: "prompt_blocked", blockedBefore: 2 }],
      ["message", AGENT],
    );
    expect([...blockedPromptSequences(messages)]).toEqual([1]);
  });

  it("leaves everything in place for other errors and agent edits", () => {
    let messages = log(
      ["message"],
      ["changes", AGENT],
      ["error", AGENT, { message: "429 slow down" }],
      ["message"],
    );
    expect(blockedPromptSequences(messages).size).toBe(0);
  });
});

describe("unansweredInput", () => {
  it("is the input since the agent last spoke or a block covered it", () => {
    expect(unansweredInput(log(["message"], ["message", AGENT], ["message"], ["changes"])))
        .toEqual([2, 3]);
    expect(unansweredInput(log(["message"], ["message", AGENT]))).toEqual([]);
    expect(unansweredInput(log(
        ["message"], ["error", AGENT, { code: "prompt_blocked", blockedBefore: 1 }])))
        .toEqual([]);
  });
});
