// A small HTML-to-Markdown converter, for SharePoint pages and (after outlook-content.ts cleans it)
// mail: paragraphs, headings, emphasis, links, lists, tables, quotes, code, and line breaks. It
// tokenizes rather than parses, never evaluates anything, and drops what it does not know (scripts
// and styles with their content), so any HTML is safe to feed it. The output is for an agent to
// read, not to render.

/** Named character references decoded. Numeric references are always decoded; unknown names are kept. */
const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", bull: "•", middot: "·", copy: "©", reg: "®", trade: "™",
};

/** Decodes character references in text. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (match, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X" ? Number.parseInt(ref.slice(2), 16) : Number.parseInt(ref.slice(1), 10);
      // Lone surrogates and NUL become the replacement character rather than invalid strings.
      return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : "�";
    }
    return ENTITIES[ref.toLowerCase()] ?? match;
  });
}

/** One piece of tokenized HTML: raw (undecoded) text, an opening tag with decoded attributes, or a closing tag. */
export type Token =
  | { type: "text"; text: string }
  | { type: "open"; tag: string; attrs: Record<string, string>; selfClosing: boolean }
  | { type: "close"; tag: string };

const RAW_TEXT = new Set(["script", "style", "template", "noscript", "iframe", "svg", "math"]);
/** Elements that never have content or a closing tag. */
export const VOID: ReadonlySet<string> = new Set(["br", "hr", "img", "input", "meta", "link", "area", "base", "col", "embed", "source", "track", "wbr"]);

function parseAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
    attrs[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attrs;
}

/** Splits HTML into tags and text, skipping comments, doctypes, and raw-text elements' content. */
export function tokenize(html: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < html.length) {
    const lt = html.indexOf("<", index);
    if (lt === -1) {
      tokens.push({ type: "text", text: html.slice(index) });
      break;
    }
    if (lt > index) tokens.push({ type: "text", text: html.slice(index, lt) });
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      index = end === -1 ? html.length : end + 3;
      continue;
    }
    const gt = html.indexOf(">", lt + 1);
    if (gt === -1) {
      tokens.push({ type: "text", text: html.slice(lt) });
      break;
    }
    const inner = html.slice(lt + 1, gt);
    index = gt + 1;
    if (inner.startsWith("!") || inner.startsWith("?")) continue;
    const close = /^\/\s*([a-z][a-z0-9-]*)/i.exec(inner);
    if (close) {
      tokens.push({ type: "close", tag: close[1].toLowerCase() });
      continue;
    }
    const open = /^([a-z][a-z0-9-]*)([\s\S]*)$/i.exec(inner);
    if (!open) {
      tokens.push({ type: "text", text: `<${inner}>` });
      continue;
    }
    const tag = open[1].toLowerCase();
    const selfClosing = open[2].trimEnd().endsWith("/") || VOID.has(tag);
    if (RAW_TEXT.has(tag) && !selfClosing) {
      // Searched case-insensitively in place: lower-casing the whole document per element is slow,
      // and can change its length (İ becomes two characters), which would misplace the index.
      const closing = new RegExp(`</${tag}`, "gi");
      closing.lastIndex = index;
      const end = closing.exec(html)?.index ?? -1;
      index = end === -1 ? html.length : html.indexOf(">", end) + 1 || html.length;
      continue;
    }
    tokens.push({ type: "open", tag, attrs: parseAttributes(open[2]), selfClosing });
  }
  return tokens;
}

/** Escapes text so Markdown reads it literally, without escaping what cannot be misread. */
function escapeMarkdown(text: string): string {
  return text
    .replace(/([\\`*_[\]<>|])/g, "\\$1")
    // A list number is escaped at its period, `1\.`: a backslash before a digit would be a literal one.
    .replace(/^(\s*)(?:([#>+-])|(\d+)\.)(\s)/gm, (_, space: string, mark: string | undefined, number: string | undefined, after: string) =>
      `${space}${mark !== undefined ? `\\${mark}` : `${number}\\.`}${after}`);
}

/** Whether a link target may be shown: http(s), mailto, or a relative path. Never `javascript:`. */
function safeHref(href: string | undefined): string | undefined {
  if (!href) return undefined;
  const trimmed = href.trim();
  if (!/^(https?:|mailto:)/i.test(trimmed) && !/^[/#?.]/.test(trimmed)) return undefined;
  // Characters that would end the link target early, or a table cell, are percent-encoded;
  // `encodeURIComponent` leaves parentheses alone.
  return trimmed.replace(/[()|\s]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

type ListFrame = { ordered: boolean; index: number };

/** Lists and quotes nested deeper than this indent or prefix no further: output would otherwise grow with the square of the depth. */
const MAX_NESTING = 32;

/**
 * `text` without its trailing spaces and tabs (other whitespace kept), in one pass; `/[ \t]+$/`
 * backtracks quadratically over a long run of spaces that stops short of the end.
 */
export function trimTrailingBlanks(text: string): string {
  let end = text.length;
  while (end > 0 && (text[end - 1] === " " || text[end - 1] === "\t")) end--;
  return text.slice(0, end);
}

/**
 * Converts HTML to Markdown. Whitespace is collapsed as a browser would, block elements become
 * paragraphs, and tables become GitHub-style tables (cell line breaks become spaces).
 */
export function htmlToMarkdown(html: string): string {
  const tokens = tokenize(html);
  const out: string[] = [];
  let line = "";
  const lists: ListFrame[] = [];
  let pre = 0;
  let quote = 0;
  const links: (string | undefined)[] = [];
  let table: { rows: string[][]; row: string[] | null; cell: string | null; header: boolean } | null = null;
  // Tables inside a table's cell: Markdown can't nest them, so their text flows into the cell.
  let nested = 0;

  const write = (text: string) => {
    if (table?.cell !== null && table?.cell !== undefined) table.cell += text;
    else line += text;
  };
  const prefix = () => "> ".repeat(Math.min(quote, MAX_NESTING));
  // A paragraph break: empty, or inside a quote the bare marker, so the quote continues past it.
  const isBreak = (text: string | undefined) => text !== undefined && /^[> ]*$/.test(text);
  const flush = () => {
    // Leading spaces are a list's indentation or code's: whitespace text is already collapsed away.
    const text = trimTrailingBlanks(line);
    if (text.trim() !== "") out.push(prefix() + text);
    line = "";
  };
  const block = () => {
    flush();
    if (out.length > 0 && !isBreak(out[out.length - 1])) out.push(prefix().trimEnd());
  };

  for (const token of tokens) {
    if (token.type === "text") {
      const decoded = decodeEntities(token.text);
      if (pre > 0) write(decoded);
      else {
        const collapsed = decoded.replace(/\s+/g, " ");
        const current = table?.cell ?? line;
        write(current === "" || /\s$/.test(current) ? escapeMarkdown(collapsed.replace(/^ /, "")) : escapeMarkdown(collapsed));
      }
      continue;
    }
    const { tag } = token;
    if (token.type === "open") {
      switch (tag) {
        case "p": case "div": case "section": case "article": case "header": case "footer": case "figure":
          if (!table) block();
          break;
        case "h1": case "h2": case "h3": case "h4": case "h5": case "h6":
          block();
          line = `${"#".repeat(Number(tag[1]))} `;
          break;
        case "br":
          if (table?.cell != null) table.cell += " ";
          else if (pre > 0) line += "\n";
          else flush();
          break;
        case "hr": block(); out.push("---"); out.push(""); break;
        case "strong": case "b": write("**"); break;
        case "em": case "i": write("_"); break;
        case "s": case "strike": case "del": write("~~"); break;
        case "code": if (pre === 0) write("`"); break;
        case "pre": block(); pre++; out.push(`${prefix()}\`\`\``); break;
        case "blockquote": block(); quote++; break;
        case "a": {
          const href = safeHref(token.attrs.href);
          links.push(href);
          if (href) write("[");
          break;
        }
        case "img": {
          const alt = token.attrs.alt?.trim();
          write(alt ? `[image: ${escapeMarkdown(alt)}]` : "[image]");
          break;
        }
        case "ul": case "ol": flush(); lists.push({ ordered: tag === "ol", index: 0 }); break;
        case "li": {
          flush();
          const frame = lists[lists.length - 1] ?? { ordered: false, index: 0 };
          frame.index++;
          line = `${"  ".repeat(Math.max(0, Math.min(lists.length, MAX_NESTING) - 1))}${frame.ordered ? `${frame.index}.` : "-"} `;
          break;
        }
        case "table":
          if (table) nested++;
          else { block(); table = { rows: [], row: null, cell: null, header: false }; }
          break;
        case "tr": if (table && nested === 0) table.row = []; break;
        case "th": case "td":
          if (nested > 0) write(" ");
          else if (table) { table.cell = ""; if (tag === "th" && table.rows.length === 0) table.header = true; }
          break;
      }
      continue;
    }
    switch (tag) {
      case "p": case "div": case "section": case "article": case "header": case "footer": case "figure":
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6":
        if (!table) block();
        break;
      case "strong": case "b": write("**"); break;
      case "em": case "i": write("_"); break;
      case "s": case "strike": case "del": write("~~"); break;
      case "code": if (pre === 0) write("`"); break;
      case "pre": flush(); pre = Math.max(0, pre - 1); out.push(`${prefix()}\`\`\``); out.push(""); break;
      case "blockquote":
        flush();
        if (quote > 0 && out[out.length - 1] === prefix().trimEnd()) out.pop();
        quote = Math.max(0, quote - 1);
        block();
        break;
      case "a": {
        const href = links.pop();
        if (href) write(`](${href})`);
        break;
      }
      case "ul": case "ol": flush(); lists.pop(); if (lists.length === 0) block(); break;
      case "li": flush(); break;
      case "th": case "td":
        if (nested > 0) break;
        // Cell text is already escaped, pipes included.
        if (table?.row && table.cell !== null) table.row.push(table.cell.trim());
        if (table) table.cell = null;
        break;
      case "tr":
        if (nested > 0) break;
        if (table?.row) table.rows.push(table.row);
        if (table) table.row = null;
        break;
      case "table": {
        if (nested > 0) {
          nested--;
          break;
        }
        if (table && table.rows.length > 0) {
          const width = Math.max(...table.rows.map(row => row.length));
          const pad = (row: string[]) => `| ${[...row, ...Array<string>(width - row.length).fill("")].join(" | ")} |`;
          const [head, ...body] = table.header ? table.rows : [Array<string>(width).fill(""), ...table.rows];
          out.push(prefix() + pad(head));
          out.push(prefix() + `| ${Array<string>(width).fill("---").join(" | ")} |`);
          for (const row of body) out.push(prefix() + pad(row));
          out.push("");
        }
        table = null;
        break;
      }
    }
  }
  flush();
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
