// Markdown rendering shared by the converters: inline text with emphasis and links, GFM tables, and
// block joining with an output budget. Text is escaped only where Markdown would otherwise read it
// as syntax, so ordinary prose (snake_case, "2 * 3", C:\paths) comes through as written.

/** Character formatting the converters carry into Markdown. */
export interface TextStyle {
  readonly bold: boolean;
  readonly italic: boolean;
  readonly strike: boolean;
  /** Monospace text, rendered as a code span. */
  readonly code: boolean;
}

/** No formatting. */
export const PLAIN: TextStyle = { bold: false, italic: false, strike: false, code: false };

/** A piece of a paragraph. `href` is an already-vetted link target (see `safeLinkTarget`). */
export type Inline =
  | { readonly kind: "text"; readonly text: string; readonly style: TextStyle; readonly href?: string }
  /** Markdown the converter has already produced and escaped, such as an image or footnote reference. */
  | { readonly kind: "markdown"; readonly markdown: string; readonly href?: string }
  | { readonly kind: "break" };

/** Renders a paragraph's inlines, joining adjacent runs that share formatting so markers don't stutter. */
export function renderInlines(inlines: readonly Inline[], lineBreak: string): string {
  let out = "";
  for (const group of groupByLink(mergeRuns(inlines))) {
    const inner = group.inlines.map(inline => renderInline(inline, lineBreak)).join("");
    out += group.href && inner.trim() ? `[${inner}](${group.href})` : inner;
  }
  return out;
}

function renderInline(inline: Inline, lineBreak: string): string {
  switch (inline.kind) {
    case "break": return lineBreak;
    case "markdown": return inline.markdown;
    case "text": return styled(inline.text, inline.style);
  }
}

function mergeRuns(inlines: readonly Inline[]): Inline[] {
  const merged: Inline[] = [];
  for (const inline of inlines) {
    const last = merged[merged.length - 1];
    if (inline.kind === "text" && last?.kind === "text" && last.href === inline.href && sameStyle(last.style, inline.style)) {
      merged[merged.length - 1] = { ...last, text: last.text + inline.text };
    } else if (inline.kind !== "text" || inline.text !== "") {
      merged.push(inline);
    }
  }
  return merged;
}

function sameStyle(a: TextStyle, b: TextStyle): boolean {
  return a.bold === b.bold && a.italic === b.italic && a.strike === b.strike && a.code === b.code;
}

function groupByLink(inlines: readonly Inline[]): { href: string | undefined; inlines: Inline[] }[] {
  const groups: { href: string | undefined; inlines: Inline[] }[] = [];
  for (const inline of inlines) {
    // A line break never sits inside link text: a link destination can't follow a newline cleanly.
    const href = inline.kind === "break" ? undefined : inline.href;
    const last = groups[groups.length - 1];
    if (last && last.href === href) last.inlines.push(inline);
    else groups.push({ href, inlines: [inline] });
  }
  return groups;
}

/**
 * Wraps text in emphasis markers. Markers go inside any leading or trailing whitespace, since
 * CommonMark does not treat `** bold**` as emphasis.
 */
function styled(text: string, style: TextStyle): string {
  const core = text.trim();
  if (core === "") return text;
  const leading = text.slice(0, text.indexOf(core));
  const trailing = text.slice(leading.length + core.length);
  let body = style.code ? codeSpan(core) : escapeMarkdownText(core);
  if (style.strike) body = `~~${body}~~`;
  if (style.italic) body = `*${body}*`;
  if (style.bold) body = `**${body}**`;
  return leading + body + trailing;
}

/** A code span fenced with more backticks than the text contains in a row. */
function codeSpan(text: string): string {
  let longestRun = 0;
  for (const match of text.matchAll(/`+/g)) longestRun = Math.max(longestRun, match[0].length);
  const fence = "`".repeat(longestRun + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;
const ALPHANUMERIC = /[\p{L}\p{N}]/u;

/**
 * Escapes the characters that would start inline Markdown syntax here: emphasis, code, links, raw
 * HTML, entities and strikethrough. Line-start syntax (headings, lists, quotes) is handled by
 * `escapeLineStarts` once a block's lines are known.
 */
export function escapeMarkdownText(text: string): string {
  return text.replace(/[\\`*_[\]<&~]/g, (char, offset: number) => {
    const before = text[offset - 1] ?? " ";
    const after = text[offset + 1] ?? " ";
    switch (char) {
      case "\\": return ASCII_PUNCTUATION.test(after) ? "\\\\" : char;
      case "*": return /\s/.test(before) && /\s/.test(after) ? char : "\\*";
      // Underscores inside a word never form emphasis, so snake_case stays readable.
      case "_": return ALPHANUMERIC.test(before) && ALPHANUMERIC.test(after) ? char : "\\_";
      case "<": return /[A-Za-z/!?]/.test(after) ? "\\<" : char;
      case "&": return /^&#?[A-Za-z0-9]+;/.test(text.slice(offset)) ? "\\&" : char;
      // A lone tilde ("~5 minutes") cannot form strikethrough; one touching other text can.
      case "~": return /\s/.test(before) && /[\s\d]/.test(after) ? char : "\\~";
      default: return `\\${char}`;
    }
  });
}

/**
 * Escapes what would make a line of a paragraph change the document's structure: an ATX heading,
 * a block quote, or a setext underline (which would turn the line above into a heading). Text
 * that merely looks like a list item ("1. Design review" typed by hand) is left alone: rendering
 * it as a list matches what the author meant, and the escape would only be noise to a reader.
 */
export function escapeLineStarts(markdown: string): string {
  return markdown.split("\n").map(line => line.replace(/^(\s*)(#{1,6}(?:\s|$)|>|[-=]+\s*$)/, "$1\\$2")).join("\n");
}

const SAFE_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/**
 * A link target fit to emit, or undefined. Only web and mail links are kept: a `javascript:` or
 * `file:` target from an untrusted document must not become a clickable link wherever the
 * Markdown is rendered. Characters that would end the destination early are percent-encoded.
 */
export function safeLinkTarget(target: string): string | undefined {
  let url: URL;
  try {
    url = new URL(target.trim());
  } catch {
    return undefined;
  }
  if (!SAFE_SCHEMES.has(url.protocol)) return undefined;
  return encodeLinkDestination(url.href);
}

/** Percent-encodes the characters that would end or break a Markdown link destination. */
function encodeLinkDestination(destination: string): string {
  return destination.replace(/[\s()<>]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

/** An image placeholder: the description as alt text, pointing at the image's part when known. */
export function imagePlaceholder(description: string | undefined, partName: string | undefined): string {
  const alt = escapeMarkdownText((description ?? "").replace(/\s+/g, " ").trim()) || "image";
  return `![${alt}](${partName ? encodeLinkDestination(partName) : ""})`;
}

/** Columns beyond this are dropped: a hostile table could otherwise pad every row out to thousands. */
const MAX_TABLE_COLUMNS = 64;

/**
 * Renders rows of cell Markdown as a GFM table. GFM needs a header row, so the first row is used
 * as one. Short rows are padded; pipes are escaped (GFM honours `\|` even inside code spans), and
 * newlines become `<br>` since a row must stay on one line. Rows stop once the table passes
 * `maxChars`.
 */
export function renderTable(rows: readonly (readonly string[])[], maxChars = Number.POSITIVE_INFINITY): string {
  if (rows.length === 0) return "";
  const width = Math.min(MAX_TABLE_COLUMNS, rows.reduce((widest, row) => Math.max(widest, row.length), 1));
  const line = (cells: readonly string[]) =>
    `| ${Array.from({ length: width }, (_, index) => tableCell(cells[index] ?? "")).join(" | ")} |`;
  let out = `${line(rows[0]!)}\n|${" --- |".repeat(width)}`;
  for (let index = 1; index < rows.length && out.length <= maxChars; index++) out += `\n${line(rows[index]!)}`;
  return out;
}

function tableCell(markdown: string): string {
  return joinLines(markdown.trim().replace(/\|/g, "\\|"), "<br>");
}

/**
 * Replaces each run of whitespace that holds a newline with `separator`, in one pass. The pattern
 * `\s*\n\s*` says the same thing but backtracks quadratically over a long run of spaces.
 */
export function joinLines(markdown: string, separator: string): string {
  return markdown.replace(/\s+/g, whitespace => whitespace.includes("\n") ? separator : whitespace);
}

/** A rendered block. Consecutive list items are joined by one newline; everything else by a blank line. */
export interface Block {
  readonly kind: "list-item" | "other";
  readonly markdown: string;
}

/** Collects blocks up to a character budget, after which further blocks are dropped. */
export class MarkdownWriter {
  #out = "";
  #previous: Block["kind"] | undefined;
  #truncated = false;

  constructor(private readonly maxChars: number = Number.POSITIVE_INFINITY) {}

  /** False once the budget is spent; the caller can stop producing blocks. */
  get hasRoom(): boolean {
    return !this.#truncated;
  }

  /** Characters left in the budget. */
  get remaining(): number {
    return Math.max(0, this.maxChars - this.#out.length);
  }

  get truncated(): boolean {
    return this.#truncated;
  }

  push(block: Block): void {
    if (this.#truncated || block.markdown.trim() === "") return;
    if (this.#previous !== undefined) this.#out += this.#previous === "list-item" && block.kind === "list-item" ? "\n" : "\n\n";
    this.#out += block.markdown;
    this.#previous = block.kind;
    if (this.#out.length > this.maxChars) this.#truncated = true;
  }

  toString(): string {
    return this.#out;
  }
}
