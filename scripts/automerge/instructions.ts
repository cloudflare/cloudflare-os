// The paths an agent reads as instructions, listed once. Both reviewers read the judge commit's
// version of each (verdict/review-copy.ts), and the gate sends a change to one to a person
// (risk-review-policy.ts), so that no AI decides a change to what AI reviewers follow.

/**
 * File names an agent reads as instructions, matched at any depth and in any case. Even with project
 * config disabled, opencode attaches to each file its read tool returns the AGENTS.md, CLAUDE.md or
 * CONTEXT.md of the directories above it, so a nested one is as live as the root one (measured on
 * opencode 1.19.6, which both reviewers run, on 2026-11-20).
 */
const FILES = ["AGENTS.md", "CLAUDE.md", "CONTEXT.md", "REVIEW.md", "CONTRIBUTING.md", "opencode.json", "opencode.jsonc"];

/** Directories an agent loads skills, agents, tools, plugins or config from, matched at any depth. */
const DIRECTORIES = [".agents", ".opencode", ".claude"];

const fileNames = FILES.map((name) => name.toLowerCase());

const list = new Intl.ListFormat("en", { type: "conjunction" });

/** The list in words, for a reviewer's prompt. */
export const INSTRUCTION_PATHS =
  `every ${list.format(FILES)}, and every file under ${list.format(DIRECTORIES.map((name) => `${name}/`))}`;

/** Whether an agent reads this repository path as instructions. */
export function isInstructionPath(path: string): boolean {
  const segments = path.toLowerCase().split("/");
  return fileNames.includes(segments.at(-1) ?? "") || segments.slice(0, -1).some((segment) => DIRECTORIES.includes(segment));
}
