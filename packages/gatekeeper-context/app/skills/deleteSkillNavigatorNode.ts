import type { ContextApi } from "../../src/context-types";

type DeleteApi = Pick<
  ContextApi,
  "deleteContextCollection" | "deleteContextSkill" | "deleteContextDocumentTree"
>;

/** Target for deleting a skill, folder, or collection from the navigator. */
export type SkillNavigatorDeleteTarget =
  | { type: "skill"; collectionId: string; path: string }
  | { type: "directory"; collectionId: string; path: string }
  | { type: "collection"; collectionId: string };

/** Delete a skill, folder, or collection the viewer has write access to. */
export const deleteSkillNavigatorNode = async (
  context: DeleteApi,
  target: SkillNavigatorDeleteTarget,
): Promise<void> => {
  if (target.type === "collection") {
    await context.deleteContextCollection(target.collectionId);
    return;
  }

  if (target.type === "skill") {
    await context.deleteContextSkill(target.collectionId, target.path);
    return;
  }
  await context.deleteContextDocumentTree(target.collectionId, target.path);
};
