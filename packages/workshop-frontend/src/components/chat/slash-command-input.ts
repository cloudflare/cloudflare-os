import type {SlashCommandChoice} from "@gadgets/workshop-shared/api";
import type {ComposerRange} from "./composer-tokens";

export type ParsedSlashCommandInput = {
  /** Text between `/` and the first whitespace, lowercased for matching. */
  query: string;
  /** Range occupied by the command token. */
  tokenStart: number;
  tokenEnd: number;
  /** Index where text following the command begins (after whitespace). */
  tailStart: number;
  /** Text following the command token. */
  tail: string;
};

/**
 * Parses the `/command` token at the cursor. A command may appear anywhere at a word boundary;
 * `//` is treated as a literal slash, not a command. Whitespace immediately before the cursor is
 * skipped back over, so typing `/command ` still resolves the command.
 */
export function parseSlashCommandInput(
    input: string, cursorPosition: number): ParsedSlashCommandInput | null {
  let probe = Math.max(0, Math.min(cursorPosition, input.length));
  while (probe > 0 && /\s/.test(input[probe - 1])) probe--;

  let tokenStart = probe;
  while (tokenStart > 0 && !/\s/.test(input[tokenStart - 1])) tokenStart--;
  let tokenEnd = probe;
  while (tokenEnd < input.length && !/\s/.test(input[tokenEnd])) tokenEnd++;

  if (input[tokenStart] !== "/" || input[tokenStart + 1] === "/") return null;

  let tailStart = tokenEnd;
  while (tailStart < input.length && /\s/.test(input[tailStart])) tailStart++;
  return {
    query: input.slice(tokenStart + 1, tokenEnd).toLowerCase(),
    tokenStart,
    tokenEnd,
    tailStart,
    tail: input.slice(tailStart),
  };
}

/**
 * Identifies the command token at the cursor, or null if the cursor isn't on one. Two positions
 * with the same key parse the same way, so callers can treat them as interchangeable.
 */
export function slashCommandTokenKey(input: string, cursorPosition: number): string | null {
  let parsed = parseSlashCommandInput(input, cursorPosition);
  return parsed && `${parsed.tokenStart}:${input.slice(parsed.tokenStart, parsed.tokenEnd)}`;
}

/** Removes the command token from the text sent as the command's arguments. */
export function stripSlashCommandToken(input: string, token: ComposerRange)
    : { args: string; commandPosition: number } {
  let before = input.slice(0, token.start);
  let after = input.slice(token.start + token.length);
  if (/\s$/.test(before) && /^\s/.test(after)) after = after.slice(1);
  let joined = before + after;

  // Where the command was, in the string that remains -- what the transcript needs to show it back
  // in place. Measured after the leading trim, and clamped because a trailing trim can leave the
  // seam past the end (a command typed last).
  let leadingTrim = joined.length - joined.trimStart().length;
  let args = joined.trim();
  return {
    args,
    commandPosition: Math.min(Math.max(before.length - leadingTrim, 0), args.length),
  };
}

/** Entries whose name exactly equals the parsed token. */
export function exactSlashCommandMatches(
    commands: SlashCommandChoice[], parsed: ParsedSlashCommandInput): SlashCommandChoice[] {
  return commands.filter(command => command.name.toLowerCase() === parsed.query);
}

/** Filters a loaded catalog for display in the picker. */
export function filterSlashCommandCatalog(
    catalog: SlashCommandChoice[], query: string): SlashCommandChoice[] {
  query = query.toLowerCase();
  let matches = catalog.filter(choice => !query ||
    choice.name.toLowerCase().includes(query) ||
    choice.description.toLowerCase().includes(query) ||
    choice.providerLabel.toLowerCase().includes(query) ||
    choice.resourceLabel?.toLowerCase().includes(query));
  return matches;
}
