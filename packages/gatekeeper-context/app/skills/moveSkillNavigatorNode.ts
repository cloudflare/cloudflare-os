import type { ContextApi } from "../../src/context-types";

type MoveApi = Pick<ContextApi, "moveContextDocument">;

export type SkillNavigatorMoveSource = {
  collectionId: string;
  path: string;
};

export type SkillNavigatorMoveTarget = {
  collectionId: string;
  directoryPath: string;
};

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const directoryName = (path: string) => {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
};

/** Moves a skill subtree using the collection's atomic prefix move. */
export const moveSkillNavigatorNode = async (
  context: MoveApi,
  source: SkillNavigatorMoveSource,
  target: SkillNavigatorMoveTarget,
): Promise<void> => {
  if (source.collectionId !== target.collectionId) {
    throw new Error("Moving items between collections is not supported.");
  }
  if (directoryName(source.path) === target.directoryPath) return;

  const destinationPath = target.directoryPath
    ? `${target.directoryPath}/${baseName(source.path)}`
    : baseName(source.path);
  await context.moveContextDocument(source.collectionId, source.path, destinationPath);
};
