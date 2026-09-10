import { describe, expect, it, vi } from "vitest";
import type { ContextApi } from "../../src/context-types";
import { moveSkillNavigatorNode } from "./moveSkillNavigatorNode";

type MoveApi = Pick<ContextApi, "moveContextDocument">;

const createApi = (): MoveApi => ({
  moveContextDocument: vi.fn(),
});

describe("moveSkillNavigatorNode", () => {
  it("uses the collection prefix move within one collection", async () => {
    const context = createApi();

    await moveSkillNavigatorNode(context, {
      collectionId: "one",
      path: "skills/release",
    }, {
      collectionId: "one",
      directoryPath: "teams",
    });

    expect(context.moveContextDocument).toHaveBeenCalledWith(
      "one",
      "skills/release",
      "teams/release",
    );
  });

  it("ignores reordering within the same directory", async () => {
    const context = createApi();

    await moveSkillNavigatorNode(context, {
      collectionId: "one",
      path: "skills/release",
    }, {
      collectionId: "one",
      directoryPath: "skills",
    });

    expect(context.moveContextDocument).not.toHaveBeenCalled();
  });

  it("rejects moves across collections", async () => {
    const context = createApi();

    await expect(moveSkillNavigatorNode(context, {
      collectionId: "one",
      path: "skills/release",
    }, {
      collectionId: "two",
      directoryPath: "skills",
    })).rejects.toThrow("between collections is not supported");
    expect(context.moveContextDocument).not.toHaveBeenCalled();
  });
});
