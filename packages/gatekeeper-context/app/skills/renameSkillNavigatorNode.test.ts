import { describe, expect, it, vi } from "vitest";
import type { ContextApi } from "../../src/context-types";
import { renamedSkillManifestPath, renameSkillNavigatorNode } from "./renameSkillNavigatorNode";

type RenameApi = Pick<ContextApi, "renameContextSkill">;

const createApi = (): RenameApi => ({
  renameContextSkill: vi.fn(),
});

describe("renameSkillNavigatorNode", () => {
  it("delegates an atomic skill rename to the collection", async () => {
    const context = createApi();

    await renameSkillNavigatorNode(context, {
      type: "skill",
      collectionId: "collection",
      path: "teams/review/SKILL.md",
    }, "audit");

    expect(context.renameContextSkill).toHaveBeenCalledWith(
      "collection",
      "teams/review/SKILL.md",
      "audit",
    );
  });
});

describe("renamedSkillManifestPath", () => {
  it("preserves the skill's parent directory", () => {
    expect(renamedSkillManifestPath("legacy/review/SKILL.md", "audit"))
      .toBe("legacy/audit/SKILL.md");
  });

  it("puts a collection-root manifest in its named directory", () => {
    expect(renamedSkillManifestPath("SKILL.md", "audit")).toBe("audit/SKILL.md");
  });
});
