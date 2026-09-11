import type { ContextApi, ContextDocumentSummary } from "../../src/context-types";

/** Target for renaming a skill, folder, or collection from the navigator. */
export type SkillNavigatorRenameTarget =
  | { type: "skill"; collectionId: string; path: string }
  | { type: "directory"; collectionId: string; path: string }
  | { type: "collection"; collectionId: string };

const dirName = (path: string) => {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
};

const joinPath = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Rewrite the `name` field inside the first YAML frontmatter block. */
const updateSkillManifestName = (body: string, newName: string): string => {
  const match = body.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return body;
  const frontmatter = match[1].replace(/^name: .+$/m, `name: ${newName}`);
  return `---\n${frontmatter}\n---${body.slice(match[0].length)}`;
};

/** Rename a skill, folder, or collection the viewer has write access to. */
export const renameSkillNavigatorNode = async (
  context: ContextApi,
  documents: ReadonlyMap<string, readonly ContextDocumentSummary[]>,
  target: SkillNavigatorRenameTarget,
  newName: string,
): Promise<void> => {
  if (target.type === "collection") {
    await context.updateContextCollection(target.collectionId, { title: newName });
    return;
  }

  if (target.type === "directory") {
    const collectionDocuments = documents.get(target.collectionId) ?? [];
    const toMove = collectionDocuments.filter(
      (document) => document.path === target.path
        || document.path.startsWith(`${target.path}/`),
    );
    const prefixPattern = new RegExp(`^${escapeRegex(target.path)}(?:/|$)`);
    await Promise.all(toMove.map(async (document) => {
      const moved = document.path.replace(prefixPattern, `${newName}/`);
      const newPath = moved.replace(/\/$/, "");
      await context.moveContextDocument(target.collectionId, document.path, newPath);
    }));
    return;
  }

  const doc = await context.getContextDocument(target.collectionId, target.path);
  if (!doc) throw new Error("Skill not found.");

  const skillDir = dirName(target.path);
  const parentDir = dirName(skillDir);
  const newPath = joinPath(parentDir, `${newName}/SKILL.md`);

  if (newPath !== target.path) {
    await context.moveContextDocument(target.collectionId, target.path, newPath);
  }

  await context.putContextDocument(target.collectionId, newPath, {
    description: doc.description,
    body: updateSkillManifestName(doc.body, newName),
    contentType: doc.contentType,
  });
};
