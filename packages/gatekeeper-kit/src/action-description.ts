/**
 * Approver-facing action descriptions that reproduce their content verbatim.
 *
 * An approver deciding whether an action may leave the workspace can only vouch for text they can
 * read. `ActionDescriptionBuilder` renders each content-bearing field of an action into a fenced
 * block whose bytes are exactly the field's value, tracks one byte budget across every field, and
 * sets `descriptionIsComplete` on the result only when nothing was dropped. The sanitizers below
 * are for untrusted text that has to sit in the description's own prose, such as a provider-chosen
 * name inside a sentence; they trade fidelity for safety and are never used for content the
 * approver is asked to review.
 */

import type { ActionDescription } from "@gadgets/workshop-shared/gatekeeper";

/**
 * Longest description the builder renders, in UTF-8 bytes. The overseer stores each action record
 * (title, description, caller, timestamps, kind) as one Durable Object value, and such values are
 * limited to 128 KiB after serialization. Staying below 96 KiB leaves room for the record's other
 * fields and for the storage wrapper.
 */
export const MAX_ACTION_DESCRIPTION_BYTES = 96 * 1024;

/** Longest untrusted value shown inline in prose, in characters. */
export const MAX_INLINE_TEXT = 120;

/** Longest action title, in characters. */
export const MAX_TITLE_LENGTH = 200;

/** The description fields of an `ActionDescription`, ready to spread into one. */
export type RenderedDescription =
  Pick<ActionDescription, "description"> & { descriptionIsComplete?: true };

// Bytes reserved beside each field for its truncation note, so the note itself fits the budget.
const TRUNCATION_NOTE_RESERVE = 80;

// Characters a fenced block cannot show: CommonMark replaces NUL with U+FFFD, and the other C0 and
// C1 controls render as nothing at all. Tab and line feed display as themselves; carriage return
// is a line ending to CommonMark, and `lineEndingNote` handles it. Default-ignorable code points
// (zero-width spaces, word joiners, the byte order mark, the bidirectional formatting characters
// and the like) render as nothing too, so `admin\u200B@x.com` reads as `admin@x.com`, and the bidi
// controls can reorder the text around them so it reads as something else.
const CONTROL_CHARS = "\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F";
const INVISIBLE_CHARS = `${CONTROL_CHARS}\\p{Default_Ignorable_Code_Point}`;
// Short values (`inline`, `list`) and JSON strings escape or reroute every invisible character, so
// an identifier or address shows its exact code points.
const INVISIBLE = new RegExp(`[${INVISIBLE_CHARS}]`, "u");
const INVISIBLE_GLOBAL = new RegExp(`[${INVISIBLE_CHARS}]`, "gu");
// Prose in a fenced block keeps only the invisibles that belong to an emoji, since those render as
// part of a visible glyph: a zero-width joiner between two emoji, a presentation selector right
// after one, a keycap's selector, and the tag characters of the three RGI subdivision flags
// (England, Scotland, Wales). Every other invisible character flags the block, because each can
// hide data in text the approver reads as whole: tag characters spell out ASCII, variation
// selectors carry a byte apiece, and joiners between letters or soft hyphens encode bits. Persian
// and Indic text that uses the joiners therefore gets the note; `json` shows it exactly. A
// presentation selector after an emoji can still carry one bit per emoji, a channel as small as
// the visible emoji count.
const EMOJI_INVISIBLES = new RegExp([
  "(?<=\\p{Extended_Pictographic}[\\uFE0F\\u{1F3FB}-\\u{1F3FF}]?)\\u200D(?=\\p{Extended_Pictographic})",
  "(?<=\\p{Extended_Pictographic})[\\uFE0E\\uFE0F]",
  "(?<=[0-9#*])\\uFE0F(?=\\u20E3)",
  "(?<=\\u{1F3F4})\\u{E0067}\\u{E0062}" +
    "(?:\\u{E0065}\\u{E006E}\\u{E0067}|\\u{E0073}\\u{E0063}\\u{E0074}|\\u{E0077}\\u{E006C}\\u{E0073})" +
    "\\u{E007F}",
].join("|"), "gu");

function hasUndisplayable(text: string): boolean {
  return INVISIBLE.test(text.replace(EMOJI_INVISIBLES, ""));
}

const CONTROL_NOTE = "_Contains invisible or control characters that cannot be displayed._";

const CRLF_NOTE = "_Line breaks are CRLF (carriage return + line feed), shown as plain line breaks._";

const CR_NOTE = "_Contains carriage returns that cannot be displayed exactly._";

// CommonMark reads CR, LF and CRLF alike as a line ending, even inside a fenced block, so each
// displays as the same line break. Text whose every line break is CRLF is still exact once a note
// says so; any other text with a carriage return is not. Text without one needs no note.
function lineEndingNote(text: string): { note: string; exact: boolean } | undefined {
  if (!text.includes("\r")) return undefined;
  return /\r(?!\n)|(?<!\r)\n/.test(text)
    ? { note: CR_NOTE, exact: false }
    : { note: CRLF_NOTE, exact: true };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function byteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

/**
 * Cuts `text` to at most `maxBytes` of UTF-8, on a code point boundary.
 * @returns The (possibly shortened) text and whether anything was removed.
 */
export function truncateToBytes(text: string, maxBytes: number):
    { text: string; truncated: boolean } {
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= maxBytes) return { text, truncated: false };
  let cut = Math.max(0, maxBytes);
  // A continuation byte is 10xxxxxx; step back to the start of the code point it belongs to.
  while (cut > 0 && (bytes[cut]! & 0xc0) === 0x80) cut--;
  return { text: decoder.decode(bytes.subarray(0, cut)), truncated: true };
}

// The shortest backtick fence that `text` cannot close: one longer than its longest run, and at
// least the three CommonMark requires. The bytes inside then need no escaping at all.
function fenceFor(text: string): string {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return "`".repeat(Math.max(3, longest + 1));
}

// A value a code span reproduces exactly: no backtick, no line break, no edge whitespace CommonMark
// would strip, no tab or run of spaces the Workshop's code spans would collapse, and short enough
// to read on one line.
function fitsInline(value: string): boolean {
  return value.length <= MAX_INLINE_TEXT && !/[`\r\n\t]| {2}/.test(value) &&
    value.trim() === value;
}

/**
 * Accumulates the Markdown an approver reads before deciding, one field at a time, under a single
 * byte budget. Labels and prose are the gatekeeper's own words; values are whatever the action
 * will send, and appear only in fields.
 *
 * Content fields (`verbatim`, `json`, `list`, and `inline` when the value needs a block) render
 * inside a fenced code block, so the approver sees exact bytes and nothing in them renders as
 * Markdown, images or links included. A field that does not fit is truncated with a note, or
 * omitted once the budget is spent, and either case leaves `descriptionIsComplete` unset on the
 * result of `finish()`.
 */
export class ActionDescriptionBuilder {
  readonly #maxBytes: number;
  readonly #parts: string[] = [];
  #bytes = 0;
  #complete = true;
  #omittedOne = false;
  #omittedAfterFirst = 0;

  /**
   * @param intro Optional opening prose, added as by `prose()`.
   * @param options.maxBytes Byte budget for the whole description; defaults to
   *   `MAX_ACTION_DESCRIPTION_BYTES`.
   */
  constructor(intro?: string, options: { maxBytes?: number } = {}) {
    this.#maxBytes = options.maxBytes ?? MAX_ACTION_DESCRIPTION_BYTES;
    if (intro !== undefined) this.prose(intro);
  }

  #push(part: string): void {
    // Parts are joined with a blank line; count the separator with the part it precedes.
    this.#bytes += byteLength(part) + (this.#parts.length ? 2 : 0);
    this.#parts.push(part);
  }

  // Records a field dropped for lack of room. The first is named in a placeholder; later ones are
  // only counted, and `finish()` reports the count on one line.
  #omit(label: string): void {
    this.#complete = false;
    if (this.#omittedOne) {
      this.#omittedAfterFirst++;
      return;
    }
    this.#omittedOne = true;
    this.#push(`**${label}:** _(omitted: description limit reached)_`);
  }

  // A whole field, or its placeholder when even that no longer fits. Placeholders are not
  // themselves budgeted, but there are at most two short lines of them however many fields are
  // dropped, which the gap between the default budget and the storage limit absorbs.
  #field(label: string, part: string): void {
    if (this.#bytes + byteLength(part) + 2 > this.#maxBytes) {
      this.#omit(label);
      return;
    }
    this.#push(part);
  }

  /**
   * Adds the gatekeeper's own Markdown: a summary sentence, a warning, a provenance line. Never
   * cut, since it is trusted text the gatekeeper keeps short, but counted against the budget:
   * overflowing it leaves the description incomplete.
   *
   * Prose is for the gatekeeper's own words only. Agent- or provider-supplied text interpolated
   * here could open an HTML block the chat renderer hides, taking the fields after it along, so
   * such a value goes in a field (`inline`, `verbatim`, `json`, `list`), or through `codeSpan` or
   * `plainInline` when it is only a label the approver does not need exactly.
   */
  prose(markdown: string): this {
    if (this.#bytes + byteLength(markdown) + (this.#parts.length ? 2 : 0) > this.#maxBytes) {
      this.#complete = false;
    }
    this.#push(markdown);
    return this;
  }

  /**
   * Adds a short value on the label's line, as a code span. A value a code span cannot reproduce
   * exactly (backticks, line breaks, edge whitespace, tabs or runs of spaces, or too long for one
   * line) is rendered as a fenced block instead, and one with control or invisible characters, or
   * with carriage returns a block cannot show exactly, as a JSON string, so the field stays complete either way.
   */
  inline(label: string, value: string): this {
    if (value === "") {
      this.#field(label, `**${label}:** _(empty)_`);
    } else if (INVISIBLE.test(value) || lineEndingNote(value)?.exact === false) {
      this.json(label, value);
    } else if (fitsInline(value)) {
      this.#field(label, `**${label}:** \`${value}\``);
    } else {
      this.verbatim(label, value);
    }
    return this;
  }

  /**
   * Adds a field whose value the approver must read in full, as a fenced block containing exactly
   * `text`. The fence is chosen so the text cannot close it. Text whose every line break is CRLF
   * gets a note saying so, since the block shows each as a plain line break. Text with control
   * or invisible characters a block cannot show, or any other text with a carriage return, is rendered all the
   * same, with a note, and leaves the description incomplete; use `json` for such a value to show
   * it exactly.
   * @param lang Optional info string for syntax highlighting, such as `"json"` or `"sql"`.
   */
  verbatim(label: string, text: string, lang = ""): this {
    if (text === "") {
      this.#field(label, `**${label}:** _(empty)_`);
      return this;
    }
    const heading = `**${label}:**\n\n`;
    const fence = fenceFor(text);
    const framing = byteLength(heading) + byteLength(fence) * 2 + byteLength(lang) + 2 + 2;
    const controls = hasUndisplayable(text);
    const lineEndings = lineEndingNote(text);
    const reserve = TRUNCATION_NOTE_RESERVE + (controls ? byteLength(CONTROL_NOTE) + 2 : 0) +
      (lineEndings ? byteLength(lineEndings.note) + 2 : 0);
    const room = this.#maxBytes - this.#bytes - framing - reserve;
    if (room <= 0) {
      this.#omit(label);
      return this;
    }
    const total = byteLength(text);
    const { text: shown, truncated } = truncateToBytes(text, room);
    let block = `${heading}${fence}${lang}\n${shown}\n${fence}`;
    if (truncated) {
      block += `\n\n_Truncated: showing ${byteLength(shown)} of ${total} bytes._`;
      this.#complete = false;
    }
    if (controls) {
      block += `\n\n${CONTROL_NOTE}`;
      this.#complete = false;
    }
    if (lineEndings) {
      block += `\n\n${lineEndings.note}`;
      if (!lineEndings.exact) this.#complete = false;
    }
    this.#push(block);
    return this;
  }

  /**
   * Adds a value as pretty-printed JSON in a fenced block. Control and invisible characters are escaped, so
   * the block always displays and decodes to exactly the value. A value JSON cannot represent (a cycle,
   * a bigint, `undefined`) is reported as undisplayable and leaves the description incomplete.
   */
  json(label: string, value: unknown): this {
    let text: string | undefined;
    try {
      // `JSON.stringify` escapes C0 controls but not DEL, C1 or the default-ignorables; those can
      // only occur inside strings, where a `\u` escape decodes to the same character. An astral
      // match (a tag character) is escaped as its surrogate pair.
      text = JSON.stringify(value, null, 2)?.replace(INVISIBLE_GLOBAL, c =>
        Array.from({ length: c.length }, (_, i) =>
          `\\u${c.charCodeAt(i).toString(16).padStart(4, "0")}`).join(""));
    } catch {
      text = undefined;
    }
    if (text === undefined) {
      this.#field(label, `**${label}:** _(could not be displayed)_`);
      this.#complete = false;
      return this;
    }
    return this.verbatim(label, text, "json");
  }

  /**
   * Adds a list of short values, one per line in a fenced block. An item containing a line break
   * would read as two, and one with control or invisible characters would not display
   * exactly, so such a list is rendered as JSON instead.
   */
  list(label: string, items: readonly string[]): this {
    if (items.length === 0) {
      this.#field(label, `**${label}:** _(none)_`);
      return this;
    }
    if (items.some(item => /[\r\n]/.test(item) || INVISIBLE.test(item))) {
      return this.json(label, items);
    }
    return this.verbatim(label, items.join("\n"));
  }

  /**
   * Renders the description. `descriptionIsComplete` is present, and `true`, only when every
   * field was shown in full; the key is absent otherwise, so spreading the result into an
   * `ActionDescription` puts nothing on the wire for an incomplete one.
   */
  finish(): RenderedDescription {
    const n = this.#omittedAfterFirst;
    const parts = n > 0
      ? [...this.#parts,
        `_(${n} more field${n === 1 ? "" : "s"} omitted: description limit reached)_`]
      : this.#parts;
    const description = parts.join("\n\n");
    return this.#complete ? { description, descriptionIsComplete: true } : { description };
  }
}

/** Starts a description, optionally with opening prose. */
export function buildDescription(intro?: string): ActionDescriptionBuilder {
  return new ActionDescriptionBuilder(intro);
}

/**
 * Neutralizes Markdown fences in untrusted text about to be placed inside one, or quoted in prose.
 * Without it a value can close the fence and continue in the description's own voice. Content the
 * approver reviews goes through `ActionDescriptionBuilder.verbatim` instead, which needs no
 * escaping.
 */
export function defuseFences(text: string): string {
  return text.replace(/`{3,}/g, "'''");
}

/**
 * Renders untrusted prose safely inside a description, block-quoted. Left alone, a provider's own
 * text can write its own field lines and argue its case in the description's voice, so fences and
 * headings are neutralized and the text is capped.
 */
export function quoteUntrusted(text: string, max: number): string {
  // CommonMark ends a line at CR, LF or CRLF; a bare CR left in would start an unquoted line.
  const cleaned = defuseFences(text.replace(/\r\n?/g, "\n"))
    // Repeated, since one strip leaves `##` as `#` -- still a heading, at heading weight, in the
    // description the approver reads.
    .replace(/^[ \t]*[#>]+[ \t]*/gm, "")
    .trim();
  const clipped = cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
  return clipped.split("\n").map(line => `> ${line}`).join("\n");
}

/**
 * Renders untrusted text inside a bounded Markdown code span.
 *
 * Backticks are dropped and whitespace is flattened so the value cannot escape into prose. Lossy:
 * use `ActionDescriptionBuilder.inline` for a value the approver must see exactly.
 */
export function codeSpan(text: string, max = MAX_INLINE_TEXT): string {
  const cleaned = text.replace(/`/g, "").replace(/\s+/g, " ").trim();
  const clipped = cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
  return `\`${clipped || "(unnamed)"}\``;
}

/**
 * Renders untrusted text as inline prose, removing characters that could forge Markdown structure.
 * Lossy, like `codeSpan`.
 */
export function plainInline(text: string, max = MAX_INLINE_TEXT): string {
  const cleaned = text.replace(/[`*_[\]()#>|]/g, "").replace(/\s+/g, " ").trim();
  const clipped = cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
  return clipped || "(unnamed)";
}

/** Flattens untrusted text onto one line and caps it, for an action's title. */
export function sanitizeTitle(text: string, max = MAX_TITLE_LENGTH): string {
  return text.replace(/[\r\n]+/g, " ").slice(0, max);
}
