// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  stashPendingChatThinkingLevel,
  takePendingChatThinkingLevel,
} from "./pendingChatThinkingLevel";

// Not `sessionStorage.clear()` -- jsdom's Storage implementation in this environment doesn't
// expose it (see the known-failing homePromptFlow.test.tsx). `removeItem` is implemented, so we
// track the keys we touch and remove them individually.
const usedKeys = new Set<string>();
function stash(chatId: number, level: Parameters<typeof stashPendingChatThinkingLevel>[1]) {
  usedKeys.add(`pendingChatThinkingLevel:${chatId}`);
  stashPendingChatThinkingLevel(chatId, level);
}

afterEach(() => {
  for (const key of usedKeys) sessionStorage.removeItem(key);
  usedKeys.clear();
});

describe("pendingChatThinkingLevel (Home -> workspace navigation handoff)", () => {
  it("round-trips a stashed level for its exact chat id", () => {
    stash(42, "max");
    expect(takePendingChatThinkingLevel(42)).toBe("max");
  });

  it("is consumed exactly once, so it can never apply twice", () => {
    stash(42, "xhigh");
    expect(takePendingChatThinkingLevel(42)).toBe("xhigh");
    expect(takePendingChatThinkingLevel(42)).toBeUndefined();
  });

  it("returns undefined when nothing was stashed for that chat id", () => {
    expect(takePendingChatThinkingLevel(999)).toBeUndefined();
  });

  it("keeps different chat ids independent, so two new-chat tabs can't cross-contaminate", () => {
    stash(1, "low");
    stash(2, "max");
    expect(takePendingChatThinkingLevel(2)).toBe("max");
    expect(takePendingChatThinkingLevel(1)).toBe("low");
  });

  it("ignores a foreign or corrupted value rather than handing it to the backend", () => {
    const key = "pendingChatThinkingLevel:5";
    usedKeys.add(key);
    sessionStorage.setItem(key, "not-a-real-level");
    expect(takePendingChatThinkingLevel(5)).toBeUndefined();
  });
});
