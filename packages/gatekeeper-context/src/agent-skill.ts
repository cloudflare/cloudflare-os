import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { SlashCommandDescriptor } from "@gadgets/workshop-shared/gatekeeper";
import type { EnabledCollectionInfo } from "./context-types.js";
import { encodeDocId } from "./context-types.js";

const AGENT_SKILL_NAME_MAX_LENGTH = 64;

/** Fields read from SKILL.md frontmatter. */
export type SkillManifestMetadata = {
  name: string;
  description: string;
};

export type SkillIndexEntry = {
  path: string;
  skillName: string;
  description: string;
};

/** Skills grouped by collection. */
export type CollectionSkills = {
  collection: EnabledCollectionInfo;
  skills: SkillIndexEntry[];
};

/** Build slash command entries for the picker. */
export function buildAgentSkillCommands(
    loaded: CollectionSkills[]): SlashCommandDescriptor[] {
  let commands: SlashCommandDescriptor[] = [];
  for (let {collection, skills} of loaded) {
    for (let skill of skills) {
      let id = encodeDocId(collection.id, skill.path);
      commands.push({
        id,
        name: skill.skillName,
        description: skill.description,
        resourceLabel: `${collection.title} · ${skill.path}`,
      });
    }
  }
  return commands;
}

/** Build Agent Catalog entries. Their IDs can be passed to ContextLibrary.read(). */
export function buildAgentSkillCatalogEntries(
    loaded: CollectionSkills[]): Array<{id: string, title: string, description: string}> {
  let entries: Array<{id: string, title: string, description: string}> = [];
  for (let {collection, skills} of loaded) {
    for (let skill of skills) {
      entries.push({
        id: encodeDocId(collection.id, skill.path),
        title: skill.skillName,
        description: `Agent Skill. Read with env[N].read(id) and ` +
          `console.log(document.content). ${skill.description}`,
      });
    }
  }
  return entries.toSorted((left, right) =>
    left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
}

/**
 * Context builds this complete message. Workshop stores it as normal chat text.
 * $ARGUMENT uses the raw command text. If missing, the text is appended after the skill.
 */
export function buildAgentSkillMessage(content: string, args: string): string {
  let usesArgument = /\$ARGUMENT(?![A-Za-z0-9_[])/.test(content);
  let expanded = content.replace(/\$ARGUMENT(?![A-Za-z0-9_[])/g, () => args);
  let message = `<agent_skill>\n${expanded}\n</agent_skill>`;
  return !usesArgument && args ? `${message}\n\nARGUMENT: ${args}` : message;
}

const SkillFrontmatterSchema = z.object({
  name: z.string()
      .min(1, "Skill name is required.")
      .max(AGENT_SKILL_NAME_MAX_LENGTH, "Skill name must be at most 64 characters.")
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/,
          "Skill name must use lowercase letters, numbers, and single hyphens."),
  description: z.string()
      .transform(value => value.trim())
      .pipe(z.string()
          .min(1, "Skill description is required.")
          .max(1024, "Skill description must be at most 1024 characters.")),
}).passthrough();

/** Check whether the last path segment is exactly SKILL.md. */
export function isSkillManifestPath(path: string): boolean {
  return path.split("/").at(-1) === "SKILL.md";
}

function isFrontmatterFence(line: string): boolean {
  return line.startsWith("---") && line.slice(3).trim() === "";
}

function readFrontmatterYaml(source: string): string {
  let text = source.startsWith("\uFEFF") ? source.slice(1) : source;
  let lines = text.split(/\r?\n/);
  if (!isFrontmatterFence(lines[0] ?? "")) {
    throw new Error("Skill manifest must start with YAML frontmatter.");
  }

  let end = lines.findIndex((line, index) => index > 0 && isFrontmatterFence(line));
  if (end < 0) {
    throw new Error("Skill manifest frontmatter is not closed.");
  }
  return lines.slice(1, end).join("\n");
}

function parseFrontmatter(source: string): unknown {
  let yaml = readFrontmatterYaml(source);
  try {
    return parseYaml(yaml);
  } catch {
    throw new Error("Skill frontmatter is not valid YAML.");
  }
}

function formatFrontmatterError(error: z.ZodError): string {
  let issue = error.issues[0];
  if (issue?.path[0] === "name" && issue.code === "invalid_type") return "Skill name is required.";
  if (issue?.path[0] === "description" && issue.code === "invalid_type") {
    return "Skill description is required.";
  }
  if (issue?.path.length === 0 && issue.code === "invalid_type") {
    return "Skill frontmatter must be a mapping.";
  }
  return issue?.message ?? "Skill frontmatter is invalid.";
}

/** Read and validate the skill frontmatter. */
export function parseSkillManifest(path: string, source: string): SkillManifestMetadata {
  if (!isSkillManifestPath(path)) {
    throw new Error("Skill manifest filename must be SKILL.md.");
  }
  let result = SkillFrontmatterSchema.safeParse(parseFrontmatter(source));
  if (!result.success) throw new Error(formatFrontmatterError(result.error));

  return {
    name: result.data.name,
    description: result.data.description,
  };
}
