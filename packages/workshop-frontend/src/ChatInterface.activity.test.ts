// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import type {
  AiChatAuthorInfo, AiChatMessage, AiChatMessageBody, AiChatMetadata, AiToolCall,
} from "@gadgets/workshop-shared/api";
import { chatActivity } from "./ChatInterface";

const USER: AiChatAuthorInfo = { type: "user", id: "ada@example.com", name: "Ada" };
const AGENT: AiChatAuthorInfo = { type: "agent", id: "test-model", name: "Test" };

const IDLE: AiChatMetadata = { id: 1, title: "Chat", started: new Date(0), lastActive: new Date(0) };
const RUNNING: AiChatMetadata = { ...IDLE, activeAgent: AGENT };

function message(sequence: number, author: AiChatAuthorInfo, body: AiChatMessageBody): AiChatMessage {
  return { chatId: 1, sequence, timestamp: new Date(sequence * 1000), author, ...body };
}

function text(sequence: number, author: AiChatAuthorInfo): AiChatMessage {
  return message(sequence, author, { type: "message", message: "hello" });
}

function connectionRequest(sequence: number, state: "pending" | "accepted"): AiChatMessage {
  return message(sequence, AGENT, {
    type: "connectionRequest", requestId: "r1", vendorId: "github", vendorName: "GitHub",
    reason: "To read the repo", state,
  });
}

function streaming(overrides: { compacting?: boolean, text?: string, reasoning?: string,
                                tools?: { name: AiToolCall["toolName"], target?: string }[] }) {
  return {
    compacting: overrides.compacting ?? false,
    text: overrides.text ?? "",
    reasoning: overrides.reasoning ?? "",
    toolCalls: (overrides.tools ?? []).map(({ name, target }, i) => ({
      toolCallId: `call-${i}`, toolName: name, target, code: "", output: "", finished: false,
    })),
  };
}

describe("chatActivity", () => {
  it("names what a running agent streams, compaction first, then tools, text, reasoning", () => {
    const all = streaming({
      compacting: true, text: "Sure", reasoning: "hmm", tools: [{ name: "executeCode" }],
    });
    expect(chatActivity(RUNNING, all, undefined, 0))
      .toEqual({ face: "working", status: "Compacting", needsYou: false });
    expect(chatActivity(RUNNING, { ...all, compacting: false }, undefined, 0).status)
      .toBe("Running code");
    expect(chatActivity(RUNNING, streaming({ text: "Sure", reasoning: "hmm" }), undefined, 0))
      .toEqual({ face: "working", status: "Responding", needsYou: false });
    expect(chatActivity(RUNNING, streaming({ reasoning: "hmm" }), undefined, 0))
      .toEqual({ face: "thinking", status: "Thinking", needsYou: false });
  });

  it("labels tool calls as the transcript's in-progress row does", () => {
    expect(chatActivity(RUNNING, streaming({ tools: [{ name: "editFile", target: "App.tsx" }] }),
                        undefined, 0).status).toBe("Editing App.tsx");
    expect(chatActivity(RUNNING, streaming({ tools: [{ name: "listBlueprints" }] }), undefined, 0)
      .status).toBe("Listing blueprints");
  });

  it("thinks only before the turn's first output, not in the gap after its last step", () => {
    const afterPrompt = [text(0, USER)];
    expect(chatActivity(RUNNING, undefined, afterPrompt, 0))
      .toEqual({ face: "thinking", status: "Thinking", needsYou: false });

    const afterLastStep = [text(0, USER), text(1, AGENT)];
    expect(chatActivity(RUNNING, undefined, afterLastStep, 0))
      .toEqual({ face: "working", status: "Working", needsYou: false });

    // A chat this session never opened holds only what arrived live, high in a sparse array.
    const liveOnly: AiChatMessage[] = [];
    liveOnly[40] = text(40, USER);
    expect(chatActivity(RUNNING, undefined, liveOnly, 0).face).toBe("thinking");
  });

  it("keeps a running agent's face while the user owes it an approval, and says so first", () => {
    expect(chatActivity(RUNNING, streaming({ tools: [{ name: "webFetch" }] }), undefined, 2))
      .toEqual({ face: "working", status: "Needs approval · Fetching web page", needsYou: true });
  });

  it("waits on the user for approvals, and for a connection the current turn requested", () => {
    expect(chatActivity(IDLE, undefined, undefined, 1))
      .toEqual({ face: "waiting", status: "Needs approval", needsYou: true });

    const asked = [text(0, USER), connectionRequest(1, "pending"), text(2, AGENT)];
    expect(chatActivity(IDLE, undefined, asked, 0))
      .toEqual({ face: "waiting", status: "Needs a connection", needsYou: true });

    const answered = [text(0, USER), connectionRequest(1, "accepted"), text(2, AGENT)];
    expect(chatActivity(IDLE, undefined, answered, 0)).toEqual({ face: "idle", needsYou: false });

    // The user moved on: a request from an earlier turn no longer holds this one up.
    const earlierTurn = [connectionRequest(0, "pending"), text(1, USER), text(2, AGENT)];
    expect(chatActivity(IDLE, undefined, earlierTurn, 0)).toEqual({ face: "idle", needsYou: false });
  });

  it("shows proposed changes for review once nothing is owed", () => {
    const proposing: AiChatMetadata = { ...IDLE, proposedChangeWorkpieces: [3] };
    expect(chatActivity(proposing, undefined, undefined, 0))
      .toEqual({ face: "review", status: "Pending changes", needsYou: false });
    expect(chatActivity(proposing, undefined, undefined, 1).face).toBe("waiting");
  });
});
