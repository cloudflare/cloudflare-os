import { describe, expect, it } from "vitest";
import type { AiChatAuthorInfo, AiChatMessage, AiChatMessageBody } from "@gadgets/workshop-shared/api";
import { unansweredInput } from "../src/blocked-prompts.js";

const USER: AiChatAuthorInfo = { type: "user", id: "owner@example.com", name: "Owner" };
const AGENT: AiChatAuthorInfo = { type: "agent", id: "model", name: "Model" };

// A chat log, oldest first, of records written as [author, body] and numbered in that order.
function log(...records: [AiChatAuthorInfo, AiChatMessageBody][]): AiChatMessage[] {
  return records.map(([author, body], sequence) =>
      ({ chatId: 1, sequence, timestamp: new Date(0), author, ...body }));
}

const said = (message: string): AiChatMessageBody => ({ type: "message", message });
const TOOL_STEP: AiChatMessageBody = {
  type: "message", message: "",
  toolCalls: [{ toolCallId: "fetch", toolName: "webFetch", input: { url: "https://example.com" } }],
};

// What a request sent now would carry that no answered request has.
const carried = (messages: AiChatMessage[]) => unansweredInput(messages.toReversed());

describe("unansweredInput", () => {
  it("is what the user added since the agent's last reply", () => {
    expect(carried(log(
      [USER, said("Hi")],                                       // 0: answered
      [AGENT, said("Hello.")],                                  // 1
      [USER, said("The injection")],                            // 2
      [USER, { type: "changes" }],                              // 3: its upload
    ))).toEqual([3, 2]);
  });

  it("is nothing once the agent has replied", () => {
    expect(carried(log([USER, said("Hi")], [AGENT, said("Hello.")]))).toEqual([]);
  });

  it("includes a step that called tools, whose results no request has carried", () => {
    expect(carried(log(
      [USER, said("Fetch the page")],                           // 0: answered by the step
      [AGENT, TOOL_STEP],                                       // 1
      [AGENT, { type: "changes" }],                             // 2: the step's own edits
      [USER, { type: "message", message: "And hurry", steered: true }],  // 3: read after it
    ))).toEqual([3, 1]);
  });

  it("includes a call's arguments, and none of what replay writes itself", () => {
    expect(carried(log(
      [AGENT, said("Done.")],
      [USER, { type: "agentCallback", methodName: "onMail", argsSummary: "[0]: ..." }],  // 1
      [USER, { type: "revert", revertFrom: 0 }],
      [AGENT, { type: "agentNudge", text: "Continue." }],
      [AGENT, { type: "error", message: "429 slow down" }],
    ))).toEqual([1]);
  });

  it("leaves out what an earlier block names, and keeps what that request never carried", () => {
    expect(carried(log(
      [AGENT, TOOL_STEP],                                       // 0
      [USER, said("The injection")],                            // 1
      [USER, { type: "changes" }],                              // 2: made while it was out
      [AGENT, { type: "error", message: "blocked", code: "prompt_blocked", blockedInput: [1, 0] }],
      [USER, said("Try this instead")],                         // 4
    ))).toEqual([4, 2]);
  });
});
