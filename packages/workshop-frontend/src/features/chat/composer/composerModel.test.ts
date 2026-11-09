import { describe, expect, it } from "vitest";
import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import { modelLabel } from "./composerModel";

const models: AiChatAuthorInfo[] = [
  { type: "agent", id: "claude-opus-5-5", name: "Claude Opus 5.5" },
];

describe("modelLabel", () => {
  it("labels an offered model by its listed name", () => {
    expect(modelLabel(models, { id: "claude-opus-5-5", name: "Stale name" })).toBe("Claude Opus 5.5");
  });

  // An existing chat can still be on a model the picker has since hidden.
  it("labels a model the list doesn't offer by the chat's own name for it", () => {
    expect(modelLabel(models, { id: "claude-opus-5", name: "Claude Opus 5" })).toBe("Claude Opus 5");
  });

  it("falls back to the raw id when no name is known", () => {
    expect(modelLabel(models, { id: "claude-opus-5" })).toBe("claude-opus-5");
  });

  it("names the no-agent choice", () => {
    expect(modelLabel(models, null)).toBe("No agent");
  });
});
