import type { ContextDocumentSummary } from "../../src/context-types";
import { stringify as stringifyYaml } from "yaml";

const SKILL_NAME_MAX_LENGTH = 64;
const SKILL_DESCRIPTION_MAX_LENGTH = 1024;
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Formats user input as a lowercase, hyphen-separated skill identifier. */
export const formatSkillName = (value: string): string => value
  .toLowerCase()
  .replace(/[^a-z0-9\s-]/g, "")
  .trimStart()
  .replace(/\s+/g, "-")
  .replace(/-+/g, "-");

const dirName = (path: string) => {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
};

const joinPath = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

/** Build the markdown body for a new skill manifest. */
export const makeSkillManifestBody = (name: string, description: string) =>
  `---\n${stringifyYaml({ name, description }).trimEnd()}\n---\n`;

/** Whether a string is a valid skill identifier (kebab-case, max 64 chars). */
export const isValidSkillName = (name: string): boolean =>
  name.length > 0
  && name.length <= SKILL_NAME_MAX_LENGTH
  && SKILL_NAME_PATTERN.test(name);

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
    candidate = `${name}-${index}`;
    index++;
  }
  return candidate;
};

/** Location for a newly created skill manifest. */
export type NewSkillLocation = {
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
  const directory = uniqueSkillDirectory(documents, collectionId, parentDir, name);
  return {
    directory,
    path: joinPath(parentDir, `${directory}/SKILL.md`),
  };
};
