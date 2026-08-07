// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import type { ThinkingLevel } from "@gadgets/workshop-shared/api";
import { effectiveThinkingLevel } from "./ChatInterface";

// The full ordered set a model with no thinkingLevelMap opinion (or an unrecognized model)
// supports -- mirrors workshop-shared/thinking-level's THINKING_LEVEL_ORDER.
const PERMISSIVE: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

describe("effectiveThinkingLevel (thinking-level picker clamping)", () => {
  it("passes a preference through unchanged when the model supports it", () => {
    expect(effectiveThinkingLevel("max", PERMISSIVE)).toBe("max");
  });

  it("defaults to DEFAULT_THINKING_LEVEL (\"high\") when nothing has been chosen for this chat yet", () => {
    expect(effectiveThinkingLevel(undefined, PERMISSIVE)).toBe("high");
  });

  it("clamps down to the highest supported level when the model changes to a more restrictive one", () => {
    // Simulates: the user picks "max" while a permissive model is selected. ChatInterface's
    // per-chat map remembers that raw preference; ChatInput re-derives the effective level on
    // every render rather than storing a separately-maintained "corrected" value.
    const preference: ThinkingLevel = "max";
    expect(effectiveThinkingLevel(preference, PERMISSIVE)).toBe("max");

    // Switching to a model whose thinkingLevelMap only offers off/low/medium (xhigh/high/minimal
    // all explicitly excluded) clamps the effective level down to the highest one still supported.
    const restrictive: ThinkingLevel[] = ["off", "low", "medium"];
    expect(effectiveThinkingLevel(preference, restrictive)).toBe("medium");
  });

  it("switching back to a permissive model restores the original preference, not the clamped value", () => {
    // The clamp never mutates the stored preference (see ChatInput: onThinkingLevelChange only
    // fires on an explicit user pick), so re-deriving against the permissive list again recovers
    // the user's original choice.
    const preference: ThinkingLevel = "max";
    expect(effectiveThinkingLevel(preference, ["off", "low", "medium"])).toBe("medium");
    expect(effectiveThinkingLevel(preference, PERMISSIVE)).toBe("max");
  });

  it("keeps walking downward past multiple consecutively-unsupported levels", () => {
    expect(effectiveThinkingLevel("xhigh", ["off", "minimal"])).toBe("minimal");
  });

  it("falls back to off for a model that supports no reasoning at all", () => {
    expect(effectiveThinkingLevel("high", ["off"])).toBe("off");
  });

  it("clamps upward, not just downward, when the model excludes exactly the requested level " +
      "(mirrors a real model like Fable 5, whose thinkingLevelMap excludes \"off\")", () => {
    // A model that cannot have thinking disabled: the picker still needs *some* selectable level
    // when "off" is requested (e.g. the user's stored preference from a different, permissive
    // model), so the clamp walks up toward "max" for the nearest supported level rather than
    // failing or falling further down than "off" itself allows.
    const cannotDisableThinking: ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];
    expect(effectiveThinkingLevel("off", cannotDisableThinking)).toBe("minimal");
  });

  // ChatInput passes the exact same `shownThinkingLevel = effectiveThinkingLevel(...)` value to
  // both the picker's active option and the onSend() call (see ChatInterface.tsx) -- so the
  // displayed selection and what's actually sent can never diverge. This test documents that
  // guarantee at the function level: calling it twice with identical inputs always agrees.
  it("is deterministic, so the displayed selection and the value sent to sendChatMessage always agree", () => {
    const preference: ThinkingLevel = "xhigh";
    const supported: ThinkingLevel[] = ["off", "low", "medium", "high"];
    const displayed = effectiveThinkingLevel(preference, supported);
    const sentToServer = effectiveThinkingLevel(preference, supported);
    expect(sentToServer).toBe(displayed);
    expect(displayed).toBe("high");
  });
});
