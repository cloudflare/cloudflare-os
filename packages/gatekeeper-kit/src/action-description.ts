/**
 * Approver-facing action descriptions that reproduce their content verbatim.
 *
 * An approver deciding whether an action may leave the workspace can only vouch for text they can
 * read. `ActionDescriptionBuilder` collects each content-bearing value of an action as an
 * `ActionField`, which approval surfaces show literally rather than as Markdown, tracks one byte
 * budget across the prose and every field, and sets `descriptionIsComplete` on the result only when
 * nothing was dropped. The sanitizers below are for untrusted text that has to sit in the
 * description's own prose, such as a provider-chosen name inside a sentence; they trade fidelity
 * for safety and are never used for content the approver is asked to review.
 */

import type {
  ActionDescription, ActionField, ActionFieldSyntax,
} from "@gadgets/workshop-shared/gatekeeper";

/**
 * Longest description the builder renders, in UTF-8 bytes of prose and fields together. The
 * overseer stores each action record (title, description, caller, timestamps, kind) as one Durable
 * Object value, and such values are limited to 128 KiB after serialization. Staying below 96 KiB
 * leaves room for the record's other fields, the fields' structure, and the storage wrapper.
 */
export const MAX_ACTION_DESCRIPTION_BYTES = 96 * 1024;

/** Longest untrusted value shown inline in prose, in characters. */
export const MAX_INLINE_TEXT = 120;

/** Longest action title, in characters. */
export const MAX_TITLE_LENGTH = 200;

/** The description fields of an `ActionDescription`, ready to spread into one. */
export type RenderedDescription =
  Pick<ActionDescription, "description" | "fields"> & { descriptionIsComplete?: true };

/** What `ActionDescriptionBuilder.file` shows of bytes the approver cannot read as text. */
export type FileDescription = Omit<Extract<ActionField, { kind: "file" }>, "label" | "kind" | "truncated">;

// Bytes charged to each field beyond its label and value, for the keys and punctuation of its
// serialized form, and to each list item for its quotes and separator.
const FIELD_OVERHEAD = 128;
const ITEM_OVERHEAD = 3;

// Characters a surface cannot show: NUL and the other C0 and C1 controls render as nothing or as a
// replacement glyph, except tab and line feed, which display as themselves. Default-ignorable code
// points (zero-width spaces, word joiners, the byte order mark, the bidirectional formatting
// characters and the like) render as nothing too, so `admin\u200B@x.com` reads as `admin@x.com`,
// and the bidi controls can reorder the text around them so it reads as something else.
const CONTROL_CHARS = "\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F";
const INVISIBLE_CHARS = `${CONTROL_CHARS}\\p{Default_Ignorable_Code_Point}`;
// Short values (`inline`, `list`, file names) and JSON strings escape or reroute every invisible
// character, so an identifier or address shows its exact code points.
const INVISIBLE = new RegExp(`[${INVISIBLE_CHARS}]`, "u");
const INVISIBLE_GLOBAL = new RegExp(`[${INVISIBLE_CHARS}]`, "gu");
// Text keeps only the invisibles that belong to an emoji, since those render as part of a visible
// glyph: a zero-width joiner between two emoji, a presentation selector right after one, a keycap's
// selector, and the tag characters of the three RGI subdivision flags (England, Scotland, Wales).
// Every other invisible character reroutes the text to JSON, because each can hide data in text the
// approver reads as whole: tag characters spell out ASCII, variation selectors carry a byte apiece,
// and joiners between letters or soft hyphens encode bits. Persian and Indic text that uses the
// joiners is therefore shown as JSON. A presentation selector after an emoji can still carry one
// bit per emoji, a channel as small as the visible emoji count.
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

// A carriage return displays as part of a line break at best. Text whose every line break is CRLF
// is still exact once the surface says so (it notes CRLF from the value itself); a bare CR, or a
// mix of CRLF and LF, is not.
function hasInexactLineBreaks(text: string): boolean {
  return text.includes("\r") && /\r(?!\n)|(?<!\r)\n/.test(text);
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

// JSON text for `value`, with every invisible character escaped so the text displays and decodes
// to exactly the value, or `undefined` for a value JSON cannot represent. `JSON.stringify` escapes
// C0 controls but not DEL, C1 or the default-ignorables; those can only occur inside strings, where
// a `\u` escape decodes to the same character. An astral match (a tag character) is escaped as its
// surrogate pair.
function toJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value, null, 2)?.replace(INVISIBLE_GLOBAL, c =>
      Array.from({ length: c.length }, (_, i) =>
        `\\u${c.charCodeAt(i).toString(16).padStart(4, "0")}`).join(""));
  } catch {
    return undefined;
  }
}

// A value shown on one line reproduces exactly: no line break, no edge whitespace or tab or run of
// spaces a reader would miss, and short enough to read at a glance.
function fitsInline(value: string): boolean {
  return value.length <= MAX_INLINE_TEXT && !/[\r\n\t]| {2}/.test(value) && value.trim() === value;
}

/**
 * Accumulates what an approver reads before deciding, under a single byte budget: the gatekeeper's
 * own prose, and one `ActionField` per value the action will send. Labels and prose are the
 * gatekeeper's words; values appear only in fields, which approval surfaces show literally.
 *
 * A value a field cannot show exactly as its kind (an invisible character, a carriage return that
 * is not part of a CRLF line break) is rerouted to a `json` field, which escapes it. A field that
 * does not fit is truncated, or omitted once the budget is spent, and either case leaves
 * `descriptionIsComplete` unset on the result of `finish()`.
 */
export class ActionDescriptionBuilder {
  readonly #maxBytes: number;
  readonly #prose: string[] = [];
  readonly #fields: ActionField[] = [];
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

  // Budget left for a field's value once its label and structure are charged.
  #room(label: string): number {
    return this.#maxBytes - this.#bytes - FIELD_OVERHEAD - byteLength(label);
  }

  #push(field: ActionField, valueBytes: number): void {
    this.#bytes += FIELD_OVERHEAD + byteLength(field.label) + valueBytes;
    this.#fields.push(field);
  }

  // Records a field dropped for lack of room. The first is kept as an empty stub naming it; later
  // ones are only counted, and `finish()` reports the count in one line of prose, since some field
  // counts are chosen by the agent. Neither is budgeted: the gap between the default budget and the
  // storage limit absorbs one stub and one line.
  #omit(label: string, totalBytes: number): void {
    this.#complete = false;
    if (this.#omittedOne) {
      this.#omittedAfterFirst++;
      return;
    }
    this.#omittedOne = true;
    this.#fields.push({ label, kind: "inline", value: "", truncated: { shownBytes: 0, totalBytes } });
  }

  // A text-like value, cut to the room left when it does not fit.
  #text(label: string, value: string, field: (value: string) => ActionField): void {
    const totalBytes = byteLength(value);
    const room = this.#room(label);
    if (totalBytes <= room) {
      this.#push(field(value), totalBytes);
      return;
    }
    const { text: shown } = truncateToBytes(value, room);
    if (shown === "") {
      this.#omit(label, totalBytes);
      return;
    }
    const shownBytes = byteLength(shown);
    this.#complete = false;
    this.#push({ ...field(shown), truncated: { shownBytes, totalBytes } }, shownBytes);
  }

  /**
   * Adds the gatekeeper's own Markdown: a summary sentence, a warning, a provenance line. Never
   * cut, since it is trusted text the gatekeeper keeps short, but counted against the budget:
   * overflowing it leaves the description incomplete.
   *
   * Prose is for the gatekeeper's own words only. Agent- or provider-supplied text interpolated
   * here could open an HTML block the chat renderer hides, so such a value goes in a field
   * (`inline`, `verbatim`, `json`, `list`), or through `codeSpan` or `plainInline` when it is only
   * a label the approver does not need exactly.
   */
  prose(markdown: string): this {
    const bytes = byteLength(markdown) + (this.#prose.length ? 2 : 0);
    if (this.#bytes + bytes > this.#maxBytes) this.#complete = false;
    this.#bytes += bytes;
    this.#prose.push(markdown);
    return this;
  }

  /**
   * Adds a short value, such as an ID or an address. A value one line cannot show exactly (line
   * breaks, edge whitespace, tabs or runs of spaces, or too long to read at a glance) becomes a
   * `text` field instead, and one with control or invisible characters, or with carriage returns
   * that are not CRLF line breaks, a `json` string, so the field stays complete either way. Kept
   * whole or omitted, never cut.
   */
  inline(label: string, value: string): this {
    if (INVISIBLE.test(value) || hasInexactLineBreaks(value)) return this.json(label, value);
    if (!fitsInline(value)) return this.verbatim(label, value);
    const bytes = byteLength(value);
    if (bytes > this.#room(label)) this.#omit(label, bytes);
    else this.#push({ label, kind: "inline", value }, bytes);
    return this;
  }

  /**
   * Adds text the approver must read in full, line breaks included. Text with control or invisible
   * characters other than those inside emoji, or with carriage returns that are not CRLF line
   * breaks, becomes a `json` string instead, so it is shown exactly.
   * @param syntax The language the text is written in, when it has one.
   */
  verbatim(label: string, text: string, syntax?: ActionFieldSyntax): this {
    if (hasUndisplayable(text) || hasInexactLineBreaks(text)) return this.json(label, text);
    this.#text(label, text, value =>
      syntax ? { label, kind: "text", value, syntax } : { label, kind: "text", value });
    return this;
  }

  /**
   * Adds a value as pretty-printed JSON. Control and invisible characters are escaped, so the text
   * always displays and decodes to exactly the value. A value JSON cannot represent (a cycle, a
   * bigint, `undefined`) is named in the prose as undisplayable and leaves the description
   * incomplete.
   */
  json(label: string, value: unknown): this {
    const text = toJson(value);
    if (text === undefined) {
      this.#complete = false;
      return this.prose(`**${label}:** _(could not be displayed)_`);
    }
    this.#text(label, text, json => ({ label, kind: "json", value: json }));
    return this;
  }

  /**
   * Adds a list of short values, one per row. An item containing a line break would read as two,
   * and one with control or invisible characters would not display exactly, so such a list is
   * rendered as JSON instead. A list that does not fit keeps as many whole items as do.
   */
  list(label: string, items: readonly string[]): this {
    if (items.some(item => /[\r\n]/.test(item) || INVISIBLE.test(item))) {
      return this.json(label, items);
    }
    const room = this.#room(label);
    const shown: string[] = [];
    let shownBytes = 0;
    let charged = 0;
    for (const item of items) {
      const bytes = byteLength(item);
      if (charged + bytes + ITEM_OVERHEAD > room) break;
      shown.push(item);
      shownBytes += bytes;
      charged += bytes + ITEM_OVERHEAD;
    }
    if (shown.length === items.length) {
      this.#push({ label, kind: "list", items: shown }, charged);
      return this;
    }
    const totalBytes = items.reduce((sum, item) => sum + byteLength(item), 0);
    if (shown.length === 0) {
      this.#omit(label, totalBytes);
      return this;
    }
    this.#complete = false;
    this.#push({ label, kind: "list", items: shown, truncated: { shownBytes, totalBytes } }, charged);
    return this;
  }

  /**
   * Adds bytes named rather than shown: a file's name, media type, size and digest. Bytes the
   * gatekeeper re-sends unchanged from the same provider (`origin: "provider"`) count as shown;
   * bytes from this workspace (`origin: "agent"`) leave the description incomplete, since the
   * approver cannot read them. Approval surfaces show a name or media type with control or
   * invisible characters escaped, so it is exact either way. Kept whole or omitted.
   */
  file(label: string, file: FileDescription): this {
    const bytes = byteLength(file.name) + byteLength(file.mediaType) +
      byteLength(file.sha256 ?? "") + String(file.size).length;
    if (bytes > this.#room(label)) {
      this.#omit(label, bytes);
      return this;
    }
    if (file.origin === "agent") this.#complete = false;
    // Built from its known members, so nothing else a caller's object carries (a `label`, `kind`
    // or `truncated` the type does not admit) reaches the field.
    const { name, mediaType, size, sha256, origin } = file;
    this.#push({
      label, kind: "file", name, mediaType, size, ...(sha256 !== undefined ? { sha256 } : {}), origin,
    }, bytes);
    return this;
  }

  /**
   * Renders the description. `descriptionIsComplete` is present, and `true`, only when every
   * field was shown in full; the key is absent otherwise, so spreading the result into an
   * `ActionDescription` puts nothing on the wire for an incomplete one. So is `fields` when there
   * are none.
   */
  finish(): RenderedDescription {
    const n = this.#omittedAfterFirst;
    const prose = n > 0
      ? [...this.#prose,
        `_(${n} more field${n === 1 ? "" : "s"} omitted: description limit reached)_`]
      : this.#prose;
    return {
      description: prose.join("\n\n"),
      ...(this.#fields.length ? { fields: [...this.#fields] } : {}),
      ...(this.#complete ? { descriptionIsComplete: true as const } : {}),
    };
  }
}

/** Starts a description, optionally with opening prose. */
export function buildDescription(intro?: string): ActionDescriptionBuilder {
  return new ActionDescriptionBuilder(intro);
}

/**
 * Neutralizes Markdown fences in untrusted text about to be placed inside one, or quoted in prose.
 * Without it a value can close the fence and continue in the description's own voice. Content the
 * approver reviews goes in an `ActionDescriptionBuilder` field instead, which needs no escaping.
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
