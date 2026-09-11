import type { ContextApi } from "../../src/context-types";

type RenameApi = Pick<ContextApi, "renameContextSkill">;

const dirName = (path: string) => {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
};

const joinPath = (dir: string, name: string) => dir ? `${dir}/${name}` : name;

/** Returns the manifest path produced by renaming a skill. */
export const renamedSkillManifestPath = (manifestPath: string, newName: string): string => {
  const skillDirectory = dirName(manifestPath);
  return joinPath(dirName(skillDirectory), `${newName}/SKILL.md`);
};

/** Target for renaming a skill, folder, or collection from the navigator. */
export type SkillNavigatorRenameTarget =
  { type: "skill"; collectionId: string; path: string };

/** Rename a skill, folder, or collection the viewer has write access to. */
export const renameSkillNavigatorNode = async (
  context: RenameApi,
  target: SkillNavigatorRenameTarget,
  newName: string,
): Promise<void> => {
  await context.renameContextSkill(target.collectionId, target.path, newName);
};
