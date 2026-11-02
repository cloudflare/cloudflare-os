// Markdown, parsed into the blocks the Office writers lay out: CommonMark's block structure with the
// GitHub extensions agents use (tables, strikethrough, task lists), and nothing that needs a renderer
// to execute. Raw HTML is kept as text, except `<br>`. Links are kept only when their target is
// http(s) or mailto, so a written document never carries a script or file link the agent made up.

import type { TextStyle } from "./markdown";

/** A run of text, a line break, or a link around runs. */
export type MdInline =
  | { readonly kind: "text"; readonly text: string; readonly style: TextStyle }
  | { readonly kind: "break" }
  | { readonly kind: "link"; readonly href: string; readonly children: readonly MdInline[] };

/** One block of a document. */
export type MdBlock =
  | { readonly kind: "heading"; readonly level: 1 | 2 | 3 | 4 | 5 | 6; readonly inlines: readonly MdInline[] }
  | { readonly kind: "paragraph"; readonly inlines: readonly MdInline[] }
  | { readonly kind: "list"; readonly ordered: boolean; readonly start: number; readonly items: readonly MdListItem[] }
  | { readonly kind: "quote"; readonly blocks: readonly MdBlock[] }
  | { readonly kind: "code"; readonly language?: string; readonly text: string }
  | { readonly kind: "table"; readonly align: readonly MdAlign[]; readonly header: readonly (readonly MdInline[])[]; readonly rows: readonly (readonly (readonly MdInline[])[])[] }
  | { readonly kind: "rule" };

/** A list item: its blocks (a paragraph, then perhaps more paragraphs or a nested list), and a task box. */
export interface MdListItem {
  readonly blocks: readonly MdBlock[];
  /** Set for a task list item: `- [x] done`. */
  readonly checked?: boolean;
}

/** A table column's alignment, from its delimiter row; null when unspecified. */
export type MdAlign = "left" | "center" | "right" | null;

const PLAIN: TextStyle = { bold: false, italic: false, strike: false, code: false };

/** The most nesting a document may have, so a hostile string can't recurse without bound. */
const MAX_DEPTH = 16;

/** Parses Markdown into blocks. Never throws: anything it doesn't recognize is text. */
export function parseMarkdown(markdown: string): MdBlock[] {
  // oxlint-disable-next-line no-control-regex -- NUL can't appear in XML, so it is replaced
  const text = markdown.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").replace(/\u0000/g, "�");
  return parseBlocks(text.split("\n"), 0);
}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const LIST_ITEM = /^( {0,3})([-*+]|(\d{1,9})[.)])(?:([ \t]+)(.*))?$/;
const TABLE_DELIMITER = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;

function parseBlocks(lines: readonly string[], depth: number): MdBlock[] {
  const blocks: MdBlock[] = [];
  let at = 0;
  while (at < lines.length) {
    const line = lines[at]!;
    if (line.trim() === "") {
      at++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const indent = line.length - line.trimStart().length;
      const body: string[] = [];
      at++;
      while (at < lines.length && !new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}[ \\t]*$`).test(lines[at]!)) {
        body.push(stripIndent(lines[at]!, indent));
        at++;
      }
      at++;
      blocks.push({ kind: "code", text: body.join("\n"), ...(fence[2] ? { language: fence[2] } : {}) });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1]!.length as 1, inlines: parseInlines(heading[2] ?? "") });
      at++;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ kind: "rule" });
      at++;
      continue;
    }

    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (at < lines.length && lines[at]!.trim() !== "") {
        const quoted = QUOTE.exec(lines[at]!);
        // A line without `>` continues the quote's paragraph ("lazy continuation").
        inner.push(quoted ? quoted[1]! : lines[at]!);
        at++;
      }
      blocks.push(depth < MAX_DEPTH ? { kind: "quote", blocks: parseBlocks(inner, depth + 1) } : paragraphOf(inner));
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const parsed = parseList(lines, at, depth);
      blocks.push(parsed.list);
      at = parsed.next;
      continue;
    }

    if (line.includes("|") && at + 1 < lines.length && TABLE_DELIMITER.test(lines[at + 1]!) && lines[at + 1]!.includes("-")) {
      const header = splitRow(line);
      const delimiter = splitRow(lines[at + 1]!);
      if (header.length === delimiter.length) {
        const align = delimiter.map(cell => {
          const left = cell.startsWith(":"), right = cell.endsWith(":");
          return left && right ? "center" : right ? "right" : left ? "left" : null;
        });
        at += 2;
        const rows: MdInline[][][] = [];
        while (at < lines.length && lines[at]!.trim() !== "" && lines[at]!.includes("|") && !startsBlock(lines[at]!)) {
          const cells = splitRow(lines[at]!);
          rows.push(header.map((_, index) => parseInlines(cells[index] ?? "")));
          at++;
        }
        blocks.push({ kind: "table", align, header: header.map(cell => parseInlines(cell)), rows });
        continue;
      }
    }

    // A paragraph: lines until a blank line or the start of another block.
    const paragraph: string[] = [line];
    at++;
    while (at < lines.length && lines[at]!.trim() !== "") {
      const next = lines[at]!;
      const setext = SETEXT.exec(next);
      if (setext) {
        blocks.push({ kind: "heading", level: setext[1]![0] === "=" ? 1 : 2, inlines: parseInlines(paragraph.map(part => part.trim()).join(" ")) });
        paragraph.length = 0;
        at++;
        break;
      }
      if (startsBlock(next)) break;
      paragraph.push(next);
      at++;
    }
    if (paragraph.length > 0) blocks.push(paragraphOf(paragraph));
  }
  return blocks;
}

/** Whether a line interrupts a paragraph. An ordered item interrupts only when it starts at 1. */
function startsBlock(line: string): boolean {
  if (FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line)) return true;
  const item = LIST_ITEM.exec(line);
  return item !== null && item[5] !== undefined && item[5].trim() !== "" && (item[3] === undefined || item[3] === "1");
}

function paragraphOf(lines: readonly string[]): MdBlock {
  // A line ending in two spaces or a backslash breaks; other line ends are spaces.
  const inlines: MdInline[] = [];
  lines.forEach((raw, index) => {
    const last = index === lines.length - 1;
    const hard = !last && (/ {2,}$/.test(raw) || raw.endsWith('\\'));
    const line = (index === 0 ? raw.trimStart() : raw.trim()).replace(/\\$/, last ? "\\" : "").replace(/ +$/, "");
    inlines.push(...parseInlines(line));
    if (!last) inlines.push(hard ? { kind: "break" } : { kind: "text", text: " ", style: PLAIN });
  });
  return { kind: "paragraph", inlines: mergeText(inlines) };
}

function parseList(lines: readonly string[], start: number, depth: number): { list: MdBlock; next: number } {
  const first = LIST_ITEM.exec(lines[start]!)!;
  const ordered = first[3] !== undefined;
  const marker = ordered ? first[2]!.slice(-1) : first[2]!;
  const items: MdListItem[] = [];
  let at = start;
  while (at < lines.length) {
    const item = LIST_ITEM.exec(lines[at]!);
    if (!item || (item[3] !== undefined) !== ordered || (ordered ? item[2]!.slice(-1) : item[2]) !== marker) break;
    // The item's content starts after the marker and its spaces; continuation lines indent to it.
    const contentIndent = item[1]!.length + item[2]!.length + Math.min(Math.max(item[4]?.length ?? 1, 1), 4);
    const body: string[] = [item[5] ?? ""];
    at++;
    while (at < lines.length) {
      const next = lines[at]!;
      if (next.trim() === "") {
        // A blank line continues the item only if what follows is indented into it.
        let peek = at + 1;
        while (peek < lines.length && lines[peek]!.trim() === "") peek++;
        if (peek < lines.length && indentOf(lines[peek]!) >= contentIndent) {
          for (; at < peek; at++) body.push("");
          continue;
        }
        break;
      }
      if (indentOf(next) >= contentIndent) {
        body.push(stripIndent(next, contentIndent));
        at++;
        continue;
      }
      // An unindented line continues the paragraph unless it starts a block of its own.
      if (startsBlock(next) || LIST_ITEM.test(next)) break;
      body.push(next.trim());
      at++;
    }
    const task = /^\[([ xX])\][ \t]+/.exec(body[0]!);
    if (task) body[0] = body[0]!.slice(task[0].length);
    const blocks = depth < MAX_DEPTH ? parseBlocks(body, depth + 1) : [paragraphOf(body)];
    items.push({ blocks, ...(task ? { checked: task[1] !== " " } : {}) });
    // A blank line between items is allowed; anything else after one ends the list.
    let peek = at;
    while (peek < lines.length && lines[peek]!.trim() === "") peek++;
    if (peek > at && peek < lines.length && LIST_ITEM.test(lines[peek]!) && indentOf(lines[peek]!) < contentIndent) at = peek;
  }
  return { list: { kind: "list", ordered, start: ordered ? Math.min(Number(first[3]), 999_999_999) : 1, items }, next: at };
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function stripIndent(line: string, count: number): string {
  let removed = 0;
  while (removed < count && line[removed] === " ") removed++;
  return line.slice(removed);
}

/** A table row's cells, without the outer pipes; `\|` stays in its cell. */
function splitRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|") && !trimmed.endsWith("\\|")) trimmed = trimmed.slice(0, -1);
  const cells: string[] = [];
  let cell = "";
  for (let index = 0; index < trimmed.length; index++) {
    const char = trimmed[index]!;
    if (char === "\\" && trimmed[index + 1] === "|") {
      cell += "|";
      index++;
    } else if (char === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell.trim());
  return cells;
}

// -- inlines ------------------------------------------------------------------------------------

const ESCAPABLE = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;

/** Parses a paragraph's text into runs, links and breaks. */
function parseInlines(text: string): MdInline[] {
  return mergeText(inlinesOf(text, PLAIN, 0));
}

function inlinesOf(text: string, style: TextStyle, depth: number): MdInline[] {
  const out: MdInline[] = [];
  let plain = "";
  const flush = () => {
    if (plain) out.push({ kind: "text", text: plain, style });
    plain = "";
  };
  let at = 0;
  while (at < text.length) {
    const char = text[at]!;
    const rest = text.slice(at);

    if (char === "\\" && at + 1 < text.length && ESCAPABLE.test(text[at + 1]!)) {
      plain += text[at + 1];
      at += 2;
      continue;
    }

    if (char === "`") {
      const ticks = /^`+/.exec(rest)![0];
      const close = text.indexOf(ticks, at + ticks.length);
      if (close !== -1 && text[close + ticks.length] !== "`") {
        flush();
        let code = text.slice(at + ticks.length, close).replace(/\n/g, " ");
        if (/^ .* $/.test(code) && code.trim() !== "") code = code.slice(1, -1);
        out.push({ kind: "text", text: code, style: { ...style, code: true } });
        at = close + ticks.length;
        continue;
      }
      plain += ticks;
      at += ticks.length;
      continue;
    }

    const br = /^<br\s*\/?>/i.exec(rest);
    if (br) {
      flush();
      out.push({ kind: "break" });
      at += br[0].length;
      continue;
    }

    const autolink = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(rest);
    if (autolink) {
      flush();
      const href = safeHref(autolink[1]!);
      out.push(href
        ? { kind: "link", href, children: [{ kind: "text", text: autolink[1]!.replace(/^mailto:/i, ""), style }] }
        : { kind: "text", text: autolink[1]!, style });
      at += autolink[0].length;
      continue;
    }

    if (char === "!" && text[at + 1] === "[") {
      const link = linkAt(text, at + 1);
      if (link) {
        // An image can't be fetched into the file, so its description stands in for it.
        flush();
        if (link.label.trim()) out.push({ kind: "text", text: link.label, style: { ...style, italic: true } });
        at = link.end;
        continue;
      }
    }

    if (char === "[") {
      const link = linkAt(text, at);
      if (link && depth < MAX_DEPTH) {
        flush();
        const children = inlinesOf(link.label, style, depth + 1);
        const href = safeHref(link.destination);
        if (href) out.push({ kind: "link", href, children: mergeText(children) });
        else out.push(...children);
        at = link.end;
        continue;
      }
    }

    const bare = /^https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"*_~]/i.exec(rest);
    if (bare && (at === 0 || /[\s(]/.test(text[at - 1]!))) {
      flush();
      out.push({ kind: "link", href: bare[0], children: [{ kind: "text", text: bare[0], style }] });
      at += bare[0].length;
      continue;
    }

    if ((char === "*" || char === "_" || char === "~") && depth < MAX_DEPTH) {
      const emphasis = emphasisAt(text, at);
      if (emphasis) {
        flush();
        const inner: TextStyle = {
          ...style,
          ...(emphasis.marker === "~~" ? { strike: true } : {}),
          ...(emphasis.marker.length === 2 && emphasis.marker !== "~~" ? { bold: true } : {}),
          ...(emphasis.marker.length === 1 ? { italic: true } : {}),
          ...(emphasis.marker.length === 3 ? { bold: true, italic: true } : {}),
        };
        out.push(...inlinesOf(text.slice(at + emphasis.marker.length, emphasis.close), inner, depth + 1));
        at = emphasis.close + emphasis.marker.length;
        continue;
      }
    }

    plain += char;
    at++;
  }
  flush();
  return out;
}

/** A `[label](destination "title")` starting at `[`, or null. */
function linkAt(text: string, open: number): { label: string; destination: string; end: number } | null {
  let depth = 0;
  let close = -1;
  for (let index = open; index < text.length; index++) {
    const char = text[index];
    if (char === "\\") index++;
    else if (char === "[") depth++;
    else if (char === "]" && --depth === 0) {
      close = index;
      break;
    }
  }
  if (close === -1 || text[close + 1] !== "(") return null;
  let parens = 0;
  for (let index = close + 2; index < text.length; index++) {
    const char = text[index];
    if (char === "\\") index++;
    else if (char === "(") parens++;
    else if (char === ")" && parens-- === 0) {
      const inside = text.slice(close + 2, index).trim();
      const destination = /^<([^>]*)>/.exec(inside)?.[1] ?? inside.split(/\s+/)[0] ?? "";
      return { label: text.slice(open + 1, close), destination, end: index + 1 };
    }
  }
  return null;
}

/** Emphasis opening at `at`: its marker and where it closes, or null if it doesn't close. */
function emphasisAt(text: string, at: number): { marker: string; close: number } | null {
  const run = /^(\*+|_+|~~)/.exec(text.slice(at))?.[1];
  if (!run) return null;
  const marker = run.startsWith("~") ? "~~" : run.slice(0, Math.min(run.length, 3));
  const after = text[at + marker.length];
  // An opener must be followed by non-space; `_` must also not sit inside a word (snake_case).
  if (after === undefined || /\s/.test(after)) return null;
  if (marker[0] === "_" && at > 0 && /[\p{L}\p{N}]/u.test(text[at - 1]!)) return null;
  for (let close = text.indexOf(marker, at + marker.length); close !== -1; close = text.indexOf(marker, close + 1)) {
    if (close === at + marker.length) continue;
    if (/\s/.test(text[close - 1]!) || text[close - 1] === "\\") continue;
    if (marker[0] === "_" && /[\p{L}\p{N}]/u.test(text[close + marker.length] ?? "")) continue;
    // A single `*` must not close on part of a `**`.
    if (marker.length === 1 && text[close + 1] === marker && text[close - 1] !== marker) continue;
    return { marker, close };
  }
  return null;
}

/** A link target a document may carry: http(s) or mailto, with no spaces or control characters. */
export function safeHref(target: string): string | undefined {
  const trimmed = target.trim();
  // oxlint-disable-next-line no-control-regex -- a link with control characters is refused
  if (!/^(?:https?:\/\/|mailto:)/i.test(trimmed) || /[\s\u0000-\u001f]/.test(trimmed)) return undefined;
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:" ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

/** Joins adjacent text runs that share a style, so a writer emits one run where the source had one. */
function mergeText(inlines: readonly MdInline[]): MdInline[] {
  const out: MdInline[] = [];
  for (const inline of inlines) {
    const last = out.at(-1);
    if (inline.kind === "text" && last?.kind === "text" && sameStyle(last.style, inline.style)) {
      out[out.length - 1] = { kind: "text", text: last.text + inline.text, style: last.style };
    } else if (inline.kind !== "text" || inline.text !== "") {
      out.push(inline);
    }
  }
  return out;
}

function sameStyle(a: TextStyle, b: TextStyle): boolean {
  return a.bold === b.bold && a.italic === b.italic && a.strike === b.strike && a.code === b.code;
}

/** The plain text of inlines: what a reader would see, without formatting. */
export function plainText(inlines: readonly MdInline[]): string {
  return inlines.map(inline => inline.kind === "text" ? inline.text : inline.kind === "break" ? "\n" : plainText(inline.children)).join("");
}

/**
 * The text with each link's destination after its text, as "text (href)": what an approver sees of
 * content that will carry links, so no destination is written unseen.
 */
export function textWithLinks(inlines: readonly MdInline[]): string {
  return inlines.map(inline => inline.kind === "text" ? inline.text : inline.kind === "break" ? "\n"
    : `${textWithLinks(inline.children)} (${inline.href})`).join("");
}
