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
};

const baseName = (path: string) => path.split("/").at(-1) ?? path;
const dirName = (path: string) => path.split("/").slice(0, -1).join("/");
const isMarkdownPath = (path: string) => /\.(?:md|markdown)$/i.test(path);

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

const descriptionFromMarkdown = (body: string, fallbackName: string): string => {
  const { content } = splitFrontmatter(body);
  for (const block of content.split(/\r?\n\s*\r?\n/)) {
    const trimmed = block
      .split(/\r?\n/)
      .filter((line) => !/^#{1,6}\s/.test(line.trim()))
      .join("\n")
      .trim();
    if (!trimmed || /^```/.test(trimmed)) continue;
    const description = trimmed
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/^[>*+-]\s+/gm, "")
      .replace(/[*_`~]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (description) return description.slice(0, 1024);
  }
  const title = fallbackName.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  return `Instructions for ${title || "this skill"}.`;
};

const metadataDefaults = (body: string, fallbackName: string) => {
  const { frontmatter } = splitFrontmatter(body);
  if (frontmatter === null && /^\uFEFF?---[ \t]*\r?\n/.test(body)) {
    throw new Error(`${fallbackName} has unterminated YAML frontmatter.`);
  }
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
  if (description.trim().length === 0 || description.trim().length > 1024) {
    description = descriptionFromMarkdown(body, fallbackName);
  }
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
    const defaults = metadataDefaults(manifest.body, label);
    return {
      id: `manifest:${manifest.path}`,
      label,
      manifestBody: manifest.body,
      supportingFiles,
      ...defaults,
    };
  });

  for (const file of files) {
    if (!isMarkdownPath(file.path) || baseName(file.path) === "SKILL.md"
      || belongsToManifest(file.path)) continue;
    const label = baseName(file.path).replace(/\.(?:md|markdown)$/i, "");
    const defaults = metadataDefaults(file.body, label);
    candidates.push({
      id: `standalone:${file.path}`,
      label,
      manifestBody: file.body,
      supportingFiles: [],
      ...defaults,
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
