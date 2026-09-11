const SKILL_NAME_MAX_LENGTH = 64;
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Presents a skill metadata name as a human-readable title. */
export const humanizeSkillName = (name: string): string => name
  .split("-")
  .filter(Boolean)
  .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
  .join(" ");

/** Removes characters that cannot contribute to an Agent Skills metadata name. */
export const sanitizeSkillTitle = (title: string): string => title
  .normalize("NFKD")
  .replace(/[\u0300-\u036f]/g, "")
  .replace(/[^A-Za-z0-9\s-]+/g, " ")
  .replace(/\s+/g, " ");

/** Converts a human-readable title to an Agent Skills metadata name. */
export const skillNameFromTitle = (title: string): string => sanitizeSkillTitle(title)
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "");

/** Whether a string satisfies the Agent Skills name-field constraints. */
export const isValidSkillName = (name: string): boolean =>
  name.length > 0
  && name.length <= SKILL_NAME_MAX_LENGTH
  && SKILL_NAME_PATTERN.test(name);
