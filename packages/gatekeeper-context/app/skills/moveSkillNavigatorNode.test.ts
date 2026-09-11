import { describe, expect, it, vi } from "vitest";
import type { ContextApi } from "../../src/context-types";
import { moveSkillNavigatorNode } from "./moveSkillNavigatorNode";

type MoveApi = Pick<ContextApi, "moveContextSkill">;

const createApi = (): MoveApi => ({ moveContextSkill: vi.fn() });

describe("moveSkillNavigatorNode", () => {
  it("moves the complete skill directory into an existing legacy folder", async () => {
    const context = createApi();

    await moveSkillNavigatorNode(context, {
      collectionId: "one",
      manifestPath: "skills/release/SKILL.md",
      directoryPath: "skills/release",
    }, {
      collectionId: "one",
      directoryPath: "teams",
    });

    expect(context.moveContextSkill).toHaveBeenCalledWith(
      "one",
      "skills/release/SKILL.md",
      "teams",
    );
  });

  it("moves a skill from a legacy folder to the collection root", async () => {
    const context = createApi();

    await moveSkillNavigatorNode(context, {
      collectionId: "one",
      manifestPath: "skills/release/SKILL.md",
      directoryPath: "skills/release",
    }, {
      collectionId: "one",
      directoryPath: "",
    });

    expect(context.moveContextSkill).toHaveBeenCalledWith("one", "skills/release/SKILL.md", "");
  });

  it("moves a collection-root manifest into a legacy folder", async () => {
    const context = createApi();

    await moveSkillNavigatorNode(context, {
      collectionId: "one",
      manifestPath: "SKILL.md",
      directoryPath: "",
    }, {
      collectionId: "one",
      directoryPath: "legacy",
    });

    expect(context.moveContextSkill).toHaveBeenCalledWith("one", "SKILL.md", "legacy");
  });

  it("rejects moves across collections", async () => {
    const context = createApi();

    await expect(moveSkillNavigatorNode(context, {
      collectionId: "one",
      manifestPath: "release/SKILL.md",
      directoryPath: "release",
    }, {
      collectionId: "two",
      directoryPath: "",
    })).rejects.toThrow("between collections is not supported");
    expect(context.moveContextSkill).not.toHaveBeenCalled();
  });
});
