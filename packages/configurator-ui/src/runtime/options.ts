import type { ConfiguratorUIOption } from "../index.ts";

/** Most options any one control shows. */
export const MAX_OPTIONS = 200;
/** Longest display string kept; longer ones are clipped. */
export const MAX_TEXT_LENGTH = 240;
/**
 * Longest identifier (option value, node id) accepted. Identifiers are never clipped -- a clipped id
 * names a different resource -- so a longer one drops its option instead.
 */
export const MAX_ID_LENGTH = 2048;
/** How long typing pauses before a search goes out. */
export const SEARCH_DEBOUNCE_MS = 180;

/** Where a control's load of its options stands. */
export type OptionsState =
  | { status: "loading" }
  | { status: "ready"; options: ConfiguratorUIOption[] }
  | { status: "failed"; message: string };

// Control characters and bidirectional formatting. Titles come from third parties (a shared file's
// name, a channel's topic), and these let one visually reorder or hide text around it -- `U+202E`
// can make "fdp.exe" read as "exe.pdf".
const INVISIBLE_CONTROLS = /[\p{Cc}\p{Bidi_Control}]/gu;

/** Third-party text made safe to display, or undefined when there is none. */
export const displayText = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const text = value.replace(INVISIBLE_CONTROLS, "").slice(0, MAX_TEXT_LENGTH);
  return text.length > 0 ? text : undefined;
};

/** An identifier exactly as given, or undefined when it is not one the runtime will carry. */
export const identifier = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH ? value : undefined;

/**
 * The options a control shows. The overflow policy is per control, and deliberately has no default.
 * "truncate" suits a suggestion list, where stopping early is an inconvenience. "refuse" suits a
 * list that states what a grant covers, where silently dropping entries would misstate it.
 */
export const sanitizeOptions = (
  options: unknown,
  overflow: "truncate" | "refuse",
): ConfiguratorUIOption[] => {
  if (!Array.isArray(options)) return [];
  let kept: unknown[] = options;
  if (kept.length > MAX_OPTIONS) {
    if (overflow === "refuse") {
      throw new Error(`Configurator controls support at most ${MAX_OPTIONS} options.`);
    }
    kept = kept.slice(0, MAX_OPTIONS);
  }
  return kept.flatMap(option => {
    if (!option || typeof option !== "object") return [];
    const { value: rawValue, title: rawTitle, subtitle, meta } = option as Record<string, unknown>;
    const value = identifier(rawValue);
    const title = displayText(rawTitle);
    if (!value || !title) return [];
    return [{ value, title, subtitle: displayText(subtitle), meta: displayText(meta) }];
  });
};

/** Configurator values are flat strings, so multi-select state travels as a comma-separated list. */
export const splitList = (value: string | null | undefined): string[] =>
  typeof value === "string" ? value.split(",").map(entry => entry.trim()).filter(Boolean) : [];

export const checkboxSelection = (
  options: readonly ConfiguratorUIOption[],
  value: string | null | undefined,
  allSelected: boolean,
): Set<string> => new Set(allSelected ? options.map(option => option.value) : splitList(value));

/** The loaded options, plus any selected value no longer among them, so it can still be cleared. */
export const withUnavailableOptions = (
  options: readonly ConfiguratorUIOption[],
  value: string | null | undefined,
): ConfiguratorUIOption[] => {
  const available = new Set(options.map(option => option.value));
  return [...options, ...splitList(value)
    .filter(selected => !available.has(selected))
    .map(selected => ({ value: selected, title: `${selected} (unavailable)` }))];
};

/** A rejected load's message, for showing in place of the options it failed to load. */
export const failureMessage = (error: unknown, fallback: string): string =>
  displayText(error instanceof Error ? error.message : typeof error === "string" ? error : undefined)
    ?? fallback;
