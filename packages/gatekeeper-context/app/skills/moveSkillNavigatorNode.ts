import type { ContextApi } from "../../src/context-types";

type MoveApi = Pick<ContextApi, "moveContextSkill">;

/** A skill directory that can move within its collection. */
export type SkillNavigatorMoveSource = {
  collectionId: string;
  manifestPath: string;
  directoryPath: string;
};

/** An existing collection directory that can receive a skill. */
export type SkillNavigatorMoveTarget = {
  collectionId: string;
  directoryPath: string;
};

const dirName = (path: string) => {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
};

/** Moves a complete skill directory between existing folders in one collection. */
export const moveSkillNavigatorNode = async (
  context: MoveApi,
  source: SkillNavigatorMoveSource,
  target: SkillNavigatorMoveTarget,
): Promise<void> => {
  if (source.collectionId !== target.collectionId) {
    throw new Error("Moving skills between collections is not supported.");
  }
  if (dirName(source.directoryPath) === target.directoryPath) return;

  await context.moveContextSkill(
    source.collectionId,
    source.manifestPath,
    target.directoryPath,
  );
};
