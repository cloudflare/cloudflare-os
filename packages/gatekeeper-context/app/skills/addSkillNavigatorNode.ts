import type { ContextDocumentSummary } from "../../src/context-types";
import { stringify as stringifyYaml } from "yaml";

const SKILL_DESCRIPTION_MAX_LENGTH = 1024;

const dirName = (path: string) => {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
};

const joinPath = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

/** Build the markdown body for a new skill manifest. */
export const makeSkillManifestBody = (name: string, description: string) =>
  `---\n${stringifyYaml({ name, description }).trimEnd()}\n---\n`;

/** Whether a string is a non-empty skill description within the length limit. */
export const isValidSkillDescription = (description: string): boolean => {
  const trimmed = description.trim();
  return trimmed.length > 0 && trimmed.length <= SKILL_DESCRIPTION_MAX_LENGTH;
};

/** Find a skill directory name under `parentDir` that does not already contain a document. */
export const uniqueSkillDirectory = (
  documents: ReadonlyMap<string, readonly ContextDocumentSummary[]>,
  collectionId: string,
  parentDir: string,
  name: string,
): string => {
  const existing = new Set<string>();
  for (const document of documents.get(collectionId) ?? []) {
    let directory = dirName(document.path);
    while (directory) {
      existing.add(directory);
      directory = dirName(directory);
    }
  }
  let candidate = name;
  let index = 2;
  while (existing.has(joinPath(parentDir, candidate))) {
    const suffix = `-${index}`;
    candidate = `${name.slice(0, 64 - suffix.length).replace(/-+$/g, "")}${suffix}`;
    index++;
  }
  return candidate;
};

/** Location for a newly created skill manifest. */
export type NewSkillLocation = {
  /** The collision-safe metadata name, matching the skill directory name. */
  name: string;
  /** The directory that will hold the manifest, relative to the collection root. */
  directory: string;
  /** The full document path for the manifest, relative to the collection root. */
  path: string;
};

/** Pick a non-colliding path for a new skill under the given parent directory. */
export const buildNewSkillLocation = (
  documents: ReadonlyMap<string, readonly ContextDocumentSummary[]>,
  collectionId: string,
  parentDir: string,
  name: string,
): NewSkillLocation => {
  const nameDirectory = uniqueSkillDirectory(documents, collectionId, parentDir, name);
  const directory = joinPath(parentDir, nameDirectory);
  return {
    name: nameDirectory,
    directory,
    path: `${directory}/SKILL.md`,
  };
};
