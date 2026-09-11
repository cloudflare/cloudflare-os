import type { ContextApi } from "../../src/context-types";
import type { ContextDocumentSummary } from "../../src/context-types";

/** Target for deleting a skill, folder, or collection from the navigator. */
export type SkillNavigatorDeleteTarget =
  | { type: "skill"; collectionId: string; path: string }
  | { type: "directory"; collectionId: string; path: string }
  | { type: "collection"; collectionId: string };

/** Delete a skill, folder, or collection the viewer has write access to. */
export const deleteSkillNavigatorNode = async (
  context: ContextApi,
  documents: ReadonlyMap<string, readonly ContextDocumentSummary[]>,
  target: SkillNavigatorDeleteTarget,
): Promise<void> => {
  if (target.type === "collection") {
    await context.deleteContextCollection(target.collectionId);
    return;
  }

  if (target.type === "directory") {
    const collectionDocuments = documents.get(target.collectionId) ?? [];
    const toDelete = collectionDocuments.filter(
      (document) => document.path === target.path
        || document.path.startsWith(`${target.path}/`),
    );
    await Promise.all(toDelete.map((document) =>
      context.deleteContextDocument(target.collectionId, document.path),
    ));
    return;
  }

  await context.deleteContextDocument(target.collectionId, target.path);
};
