import { describe, expect, it, vi } from "vitest";
import type { ContextApi } from "../../src/context-types";
import { deleteSkillNavigatorNode } from "./deleteSkillNavigatorNode";

type DeleteApi = Pick<
  ContextApi,
  "deleteContextCollection" | "deleteContextSkill" | "deleteContextDocumentTree"
>;

const createApi = (): DeleteApi => ({
  deleteContextCollection: vi.fn(),
  deleteContextSkill: vi.fn(),
  deleteContextDocumentTree: vi.fn(),
});

describe("deleteSkillNavigatorNode", () => {
  it("deletes a skill's complete directory", async () => {
    const context = createApi();

    await deleteSkillNavigatorNode(context, {
      type: "skill",
      collectionId: "collection",
      path: "teams/review/SKILL.md",
    });

    expect(context.deleteContextSkill).toHaveBeenCalledWith(
      "collection",
      "teams/review/SKILL.md",
    );
  });

  it("deletes a complete directory subtree", async () => {
    const context = createApi();

    await deleteSkillNavigatorNode(context, {
      type: "directory",
      collectionId: "collection",
      path: "teams",
    });

    expect(context.deleteContextDocumentTree).toHaveBeenCalledWith("collection", "teams");
  });

  it("deletes a collection-root skill manifest directly", async () => {
    const context = createApi();

    await deleteSkillNavigatorNode(context, {
      type: "skill",
      collectionId: "collection",
      path: "SKILL.md",
    });

    expect(context.deleteContextSkill).toHaveBeenCalledWith("collection", "SKILL.md");
    expect(context.deleteContextDocumentTree).not.toHaveBeenCalled();
  });
});
