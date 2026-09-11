import { Document, isMap, parseDocument } from "yaml";
import { joinFrontmatter, splitFrontmatter } from "../../src/description-extractors";
import type { DecodedUploadFile } from "../uploadFiles";
import { isValidSkillName, skillNameFromTitle } from "./skillName";

/** One browser-selected file, decoded into the storage representation used by Context documents. */
export type SkillUploadFile = DecodedUploadFile;

/** One skill inferred from selected files. */
export type SkillUploadCandidate = {
  id: string;
  label: string;
  manifestBody: string;
  supportingFiles: SkillUploadFile[];
  name: string;
  description: string;
  metadataError: string | null;
};

const baseName = (path: string) => path.split("/").at(-1) ?? path;
const dirName = (path: string) => path.split("/").slice(0, -1).join("/");
const isMarkdownPath = (path: string) => /\.(?:md|markdown)$/i.test(path);

const validateRequiredMetadata = (body: string): void => {
  const { frontmatter } = splitFrontmatter(body);
  if (frontmatter === null) throw new Error("Add a name and description for this skill.");
  const document = parseDocument(frontmatter);
  if (document.errors.length > 0 || !isMap(document.contents)) {
    throw new Error("We couldn't read this skill's details. Review them below.");
  }
  const name = document.get("name");
  const description = document.get("description");
  if (typeof name !== "string") throw new Error("Add a name for this skill.");
  if (!isValidSkillName(name)) {
    throw new Error(name.length > 64
      ? "Shorten this skill's name to 64 characters or fewer."
      : "Review this skill's name before uploading.");
  }
  if (typeof description !== "string" || description.trim().length === 0) {
    throw new Error("Add a description for this skill.");
  }
  if (description.trim().length > 1024) {
    throw new Error("Shorten this skill's description to 1024 characters or fewer.");
  }
};

const normalizeFolderPaths = (files: readonly SkillUploadFile[]) => {
  const roots = files.map((file) => file.path.split("/"));
  const folderName = roots.length > 0 && roots.every((parts) => parts.length > 1)
    && roots.every((parts) => parts[0] === roots[0][0])
    ? roots[0][0]
    : "";
  if (!folderName) return { folderName, files: [...files] };
  return {
    folderName,
    files: files.map((file) => ({ ...file, path: file.path.slice(folderName.length + 1) })),
  };
};

const metadataDefaults = (body: string, fallbackName: string) => {
  const { frontmatter } = splitFrontmatter(body);
  let name = "";
  let description = "";
  if (frontmatter !== null) {
    const document = parseDocument(frontmatter);
    if (document.errors.length === 0 && isMap(document.contents)) {
      const parsedName = document.get("name");
      const parsedDescription = document.get("description");
      if (typeof parsedName === "string") name = parsedName;
      if (typeof parsedDescription === "string") description = parsedDescription;
    }
  }
  if (!isValidSkillName(name)) name = skillNameFromTitle(fallbackName) || "untitled-skill";
  return { name, description };
};

/** Infer standalone skills and complete skill bundles from browser-selected files. */
export const prepareSkillUploads = (
  selectedFiles: readonly SkillUploadFile[],
): SkillUploadCandidate[] => {
  const { folderName, files } = normalizeFolderPaths(selectedFiles);
  const manifests = files.filter((file) => baseName(file.path) === "SKILL.md");
  const manifestRoots = manifests.map((file) => dirName(file.path));
  const belongsToManifest = (path: string) => manifestRoots.some(
    (root) => root === "" || path.startsWith(root + "/"),
  );

  const candidates = manifests.map((manifest) => {
    const root = dirName(manifest.path);
    const nestedRoots = manifestRoots.filter(
      (candidateRoot) => candidateRoot !== root
        && (root === "" || candidateRoot.startsWith(root + "/")),
    );
    const supportingFiles = files.filter((file) => {
      if (file === manifest || (root && !file.path.startsWith(root + "/"))) return false;
      const relativePath = root ? file.path.slice(root.length + 1) : file.path;
      return !nestedRoots.some(
        (nestedRoot) => file.path === `${nestedRoot}/SKILL.md`
          || file.path.startsWith(nestedRoot + "/"),
      ) && relativePath !== "SKILL.md";
    }).map((file) => ({
      ...file,
      path: root ? file.path.slice(root.length + 1) : file.path,
    }));
    const label = root ? baseName(root) : folderName || "SKILL.md";
    let metadataError: string | null = null;
    try {
      validateRequiredMetadata(manifest.body);
    } catch (error) {
      metadataError = error instanceof Error ? error.message : "Skill metadata is invalid.";
    }
    return {
      id: `manifest:${manifest.path}`,
      label,
      manifestBody: manifest.body,
      supportingFiles,
      ...metadataDefaults(manifest.body, label),
      metadataError,
    };
  });

  for (const file of files) {
    if (!isMarkdownPath(file.path) || baseName(file.path) === "SKILL.md"
      || belongsToManifest(file.path)) continue;
    const label = baseName(file.path).replace(/\.(?:md|markdown)$/i, "");
    let metadataError: string | null = null;
    try {
      validateRequiredMetadata(file.body);
    } catch (error) {
      metadataError = error instanceof Error ? error.message : "Skill metadata is invalid.";
    }
    candidates.push({
      id: `standalone:${file.path}`,
      label,
      manifestBody: file.body,
      supportingFiles: [],
      ...metadataDefaults(file.body, label),
      metadataError,
    });
  }

  return candidates;
};

/** Add or repair required skill metadata while preserving valid extra keys and Markdown content. */
export const writeSkillUploadMetadata = (
  body: string,
  name: string,
  description: string,
): string => {
  const { frontmatter, content } = splitFrontmatter(body);
  let document = frontmatter === null ? new Document({}) : parseDocument(frontmatter);
  if (document.errors.length > 0 || !isMap(document.contents)) document = new Document({});
  document.set("name", name);
  document.set("description", description.trim());
  return joinFrontmatter(document.toString().trimEnd(), content);
};
