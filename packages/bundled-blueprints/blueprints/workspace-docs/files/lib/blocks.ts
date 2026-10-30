// ── Block specs ⇄ HTML (matching what the editor itself produces) ────────────
// The block API's model, for the server: an agent describes blocks as simple
// specs or Markdown, and they are turned into exactly the HTML the editor
// writes for the same content, so an agent's block and a typed one are
// indistinguishable. Also here: splitting HTML into top-level blocks, the
// unsafe-markup filter, and the reverse direction the block listings use
// (a block's type, and its Markdown via ./markdown.ts).
import type { BlockContent, BlockDescription, BlockPosition, BlockSource, StoredBlock } from "./protocol.ts";
import { closesFence, decodeHtml, htmlToMarkdown, readHtmlAttribute } from "./markdown.ts";

/**
 * A block spec as an agent passes it: `{ type, text | html | items | rows | src | code | markdown,
 * ... }`, every field unchecked until it is read.
 */
export type BlockSpec = Record<string, unknown>;

/** What a spec's `type` (or its fields, when it has none) resolves to. */
export type BlockKind = "p" | "h1" | "h2" | "h3" | "quote" | "code" | "divider" | "ul" | "ol" | "todo" | "image" | "table" | "html";

/** An object as it arrives over RPC, before its fields are checked. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function newBlockId(): string {
  return "b_" + crypto.randomUUID();
}

export function indexOfBlock(list: BlockContent[], id: unknown): number {
  const at = list.findIndex((b) => b.id === String(id));
  if (at < 0) throw new Error("Unknown block id: " + id);
  return at;
}

export function resolvePosition(list: BlockContent[], { afterId, beforeId, index }: BlockPosition): number {
  if (afterId !== undefined && afterId !== null) return indexOfBlock(list, afterId) + 1;
  if (beforeId !== undefined && beforeId !== null) return indexOfBlock(list, beforeId);
  if (index !== undefined && index !== null) {
    const n = Math.trunc(Number(index));
    if (!Number.isFinite(n)) throw new Error("index must be a number");
    return Math.max(0, Math.min(list.length, n < 0 ? list.length + 1 + n : n));
  }
  return list.length;
}

/**
 * Whether two blocks' HTML is the same content: the editor saves a block with its root's
 * `data-block-id`, which HTML built from a spec doesn't carry.
 */
export function sameBlockHtml(a: string, b: string): boolean {
  return a === b || withoutBlockId(a) === withoutBlockId(b);
}
const withoutBlockId = (html: string) => html.replace(/^(\s*<[a-z0-9]+\b[^>]*?)\s+data-block-id="[^"]*"/i, "$1");

// Line up a new list of block HTML against the current blocks: identical
// blocks are matched (longest common subsequence), and between matches the
// leftovers pair up in order as in-place updates.
export function mergeBlockList(old: BlockContent[], htmls: string[]): BlockContent[] {
  const n = old.length, m = htmls.length, w = m + 1;
  const oldKeys = old.map((b) => withoutBlockId(b.html)), newKeys = htmls.map(withoutBlockId);
  const same = (i: number, j: number) => oldKeys[i] === newKeys[j];
  const dp = (n + 1) * w <= 4e6 ? new Uint32Array((n + 1) * w) : null;
  if (dp) for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i * w + j] = same(i, j) ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
  const out: BlockContent[] = [];
  let oldRun: BlockContent[] = [], newRun: string[] = [];
  const flush = () => {
    newRun.forEach((html, k) => out.push(k < oldRun.length ? { id: oldRun[k].id, html } : { id: newBlockId(), html }));
    oldRun = [];
    newRun = [];
  };
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && same(i, j)) { flush(); out.push(old[i]); i++; j++; }
    else if (j < m && (i >= n || !dp || dp[i * w + j + 1] >= dp[(i + 1) * w + j])) newRun.push(htmls[j++]);
    else oldRun.push(old[i++]);
  }
  flush();
  return out;
}

// Spec fields that carry content (as opposed to `type` alone).
export const CONTENT_FIELDS = ["text", "html", "items", "rows", "src", "url", "code", "markdown"];

// `updateBlock({ id, type })`: the block's own content in the new type. Text
// blocks keep their inline markup (and alignment), lists swap their kind.
export function retypeSpec(html: string, type: unknown): BlockSpec {
  const kind = blockKind(type);
  const current = blockTypeOf(html);
  const m = /^\s*<([a-z0-9]+)\b([^>]*)>([\s\S]*)<\/\1>\s*$/i.exec(String(html));
  const style = m && /\sstyle\s*=/i.test(m[2]) && !/margin/.test(readHtmlAttribute(m[2], "style")) ? ` style="${escapeHtml(readHtmlAttribute(m[2], "style"))}"` : "";
  const inner = m ? m[3] : "";
  const textual = ["p", "h1", "h2", "h3", "quote"];
  const lists = ["ul", "ol", "todo"];
  if (m && textual.includes(current) && !/<(p|div|h[1-6]|ul|ol|pre|table|blockquote)\b/i.test(inner)) {
    if (textual.includes(kind)) return { type: "html", html: `<${kind === "quote" ? "blockquote" : kind}${style}>${inner.trim() ? inner : "<br>"}</${kind === "quote" ? "blockquote" : kind}>` };
    if (lists.includes(kind)) return { type: kind, items: [{ html: inner }] };
    if (kind === "code") return { type: "code", text: decodeHtml(stripTags(inner.replace(/<br\s*\/?>/gi, "\n"))) };
  }
  if (m && current === "code" && (textual.includes(kind) || lists.includes(kind))) {
    const lines = stripTags(inner.replace(/<br\s*\/?>/gi, "\n")).replace(/\n$/, "").split("\n").map((line) => escapeHtml(decodeHtml(line)));
    if (lists.includes(kind)) return { type: kind, items: lines.map((line) => ({ html: line })) };
    const tag = kind === "quote" ? "blockquote" : kind;
    return { type: "html", html: `<${tag}>${lines.join("<br>") || "<br>"}</${tag}>` };
  }
  if (m && lists.includes(current) && lists.includes(kind)) {
    const open = kind === "ol" ? "<ol>" : kind === "todo" ? '<ul class="checklist">' : "<ul>";
    const body = kind === "todo" ? inner : inner.replace(/\sdata-checked\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
    return { type: "html", html: open + body + (kind === "ol" ? "</ol>" : "</ul>") };
  }
  if (current === kind) return { type: "html", html: String(html) };
  throw new Error(`Can't turn this ${current} block into ${kind} by type alone: pass its new content too (text, items, rows…).`);
}

// An empty paragraph, whatever its attributes (the editor saves its block id on it).
export function isEmptyLine(html: string): boolean {
  return /^<p\b[^>]*>(?:<br\s*\/?>)?<\/p>$/i.test(String(html).trim());
}

// The text of `html` with every tag removed, repeatedly, so a tag split by another can't remain.
function stripTags(html: string): string {
  for (let prev = ""; prev !== html; ) {
    prev = html;
    html = html.replace(/<[^>]*>/g, "");
  }
  return html;
}

export const TYPE_ALIASES: Record<string, BlockKind> = {
  p: "p", text: "p", paragraph: "p",
  h1: "h1", h2: "h2", h3: "h3", heading: "h2", title: "h1",
  quote: "quote", blockquote: "quote",
  code: "code", pre: "code",
  divider: "divider", hr: "divider", rule: "divider",
  ul: "ul", bullets: "ul", bulleted: "ul", list: "ul",
  ol: "ol", numbers: "ol", numbered: "ol",
  todo: "todo", todos: "todo", checklist: "todo", tasks: "todo",
  image: "image", img: "image",
  table: "table", grid: "table",
  html: "html",
};

// Block-level HTML can't sit inside a <p>; an untyped spec carrying it is an html block.
function isBlockHtml(html: unknown): boolean {
  return typeof html === "string" && /^\s*<(p|h[1-6]|ul|ol|blockquote|pre|hr|table|div|figure|section|article|dl)\b/i.test(html);
}

// What an untyped spec is, judging by its fields.
export function fallbackKind(spec: unknown): BlockKind {
  if (!isRecord(spec)) return "p";
  if (Array.isArray(spec.items)) return "ul";
  if (Array.isArray(spec.rows)) return "table";
  if (spec.src !== undefined || spec.url !== undefined) return "image";
  if (isBlockHtml(spec.html)) return "html";
  return "p";
}

// Split HTML into top-level blocks: the editor holds exactly one element per
// block, so several elements (or loose text) in one html spec must become
// several blocks, or all but the first would be invisible.
const SPLIT_BLOCK_TAGS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "blockquote", "pre", "hr", "div", "table", "figure", "section", "article", "header", "footer", "aside", "nav", "dl", "address", "details", "main"]);
const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

export function splitTopLevelHtml(html: string): string[] {
  const pieces = splitPieces(html).map((piece) => piece.html);
  return pieces.length ? pieces : ["<p><br></p>"];
}

// The top-level pieces of `html`: each block element as written, and each run of loose inline
// content (`run`) wrapped in a <p>; runs with nothing visible are dropped.
function splitPieces(html: string): { html: string; run: boolean }[] {
  const pieces: { html: string; run: boolean }[] = [];
  let inline = "";
  const flushInline = () => {
    if (inline.replace(/<br\s*\/?>|<!--[\s\S]*?-->|&nbsp;|\s/gi, "")) pieces.push({ html: "<p>" + inline.trim() + "</p>", run: true });
    inline = "";
  };
  const re = /<!--[\s\S]*?-->|<\/?([a-z][a-z0-9-]*)\b[^>]*>|[^<]+|</gi;
  let top: string | null = null, depth = 0, start = 0, m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const token = m[0], tag = m[1]?.toLowerCase(), closing = token[1] === "/";
    if (!top) {
      if (tag && !closing && SPLIT_BLOCK_TAGS.has(tag)) {
        flushInline();
        if (VOID_TAGS.has(tag) || token.endsWith("/>")) { pieces.push({ html: token, run: false }); continue; }
        top = tag; depth = 1; start = m.index;
      } else inline += token;
      continue;
    }
    if (tag !== top || VOID_TAGS.has(tag)) continue;
    depth += closing ? -1 : 1;
    if (!depth) { pieces.push({ html: html.slice(start, m.index + token.length), run: false }); top = null; }
  }
  if (top) pieces.push({ html: html.slice(start), run: false });
  flushInline();
  return pieces;
}

// ── Stored blocks from older editors ──────────────────────────────────────
// The editor shows a block as the first element its HTML parses to. Earlier
// Docs editors saved shapes that don't survive that: Chrome's list command
// builds a list inside a paragraph (`<p><ol>…</ol></p>`, which the parser
// splits into an empty `<p>` and the list), and an image inserted at the top
// level was saved bare (`<img …>`). Both looked right only until a reload,
// while the content stayed in storage. repairBlockHtml rebuilds such a block
// as the blocks the browser would show, the way the editor's own
// unnestBlocks/wrapLooseNodes do: inline runs stay in a copy of their line
// (`<p style="text-align: center">`), each nested block becomes its own.
// It returns `[html]` unchanged for a block that is already sound.

const LINE_OPEN = /^<(p|h[1-6])\b([^>]*)>/i;

function hasInlineContent(html: string): boolean {
  return /<(img|br)\b/i.test(html) || !!decodeHtml(stripTags(html)).replace(/[\s​]/g, "");
}

export function repairBlockHtml(html: string, depth = 0): string[] {
  const source = String(html);
  const top = splitTopLevelHtml(source);
  const pieces = top.length === 1 && top[0] === source.trim() ? [source] : top;
  const out: string[] = [];
  for (const piece of pieces) {
    const open = LINE_OPEN.exec(piece);
    const tag = open?.[1].toLowerCase();
    const close = tag ? new RegExp(`</${tag}\\s*>\\s*$`, "i").exec(piece) : null;
    const inner = open && close ? piece.slice(open[0].length, close.index) : "";
    if (!open || !close || depth > 4 || !splitPieces(inner).some((part) => !part.run)) {
      out.push(piece);
      continue;
    }
    // A line with blocks nested in it: its inline runs keep the line's tag and attributes
    // (all but the block id, which the first piece takes over), and every block is its own.
    const attributes = open[2].replace(/\sdata-block-id\s*=\s*("[^"]*"|'[^']*'|[^\s>]*)/gi, "");
    for (const part of splitPieces(inner)) {
      if (part.run && !hasInlineContent(part.html)) continue;
      out.push(...repairBlockHtml(part.run ? `<${tag}${attributes}>${part.html.slice(3, -4)}</${tag}>` : part.html, depth + 1));
    }
  }
  return out.length ? out : ["<p><br></p>"];
}

export function blockKind(type: unknown, fallback: BlockKind = "p"): BlockKind {
  if (type === undefined || type === null || type === "") return fallback;
  const kind = TYPE_ALIASES[String(type).toLowerCase()];
  if (!kind) throw new Error(`Unknown block type "${type}". Use one of: p, h1, h2, h3, quote, code, divider, ul, ol, todo, image, table, html.`);
  return kind;
}

// { type: "table", rows: [["Name", "Role"], ["Ada", "Engineer"]], header?: true, widths?: [30, 70] }
// Cells are inline Markdown (or { text } / { html }); "\n" is a line break in a cell.
// The first row is the header unless header is false; short rows are padded.
function tableHtml(spec: BlockSpec): string {
  const rows: unknown[][] = Array.isArray(spec.rows) ? spec.rows.filter(Array.isArray) : [];
  if (!rows.length) throw new Error('A table needs rows: [["a", "b"], ["c", "d"]].');
  const cols = Math.min(64, Math.max(...rows.map((r) => r.length), 1));
  const header = spec.header !== false;
  const cell = (raw: unknown, tag: string) => {
    const value = raw === undefined || raw === null ? "" : raw;
    const content = isRecord(value) ? inlineContent(value) : inlineContent({ text: String(value) });
    return `<${tag}>${content}</${tag}>`;
  };
  const row = (r: unknown[], tag: string) => "<tr>" + Array.from({ length: cols }, (_, i) => cell(r[i], tag)).join("") + "</tr>";
  const body = header ? rows.slice(1) : rows;
  const widths = Array.isArray(spec.widths) && spec.widths.length === cols && spec.widths.every((w) => Number(w) > 0) ? spec.widths.map(Number) : null;
  const sum = widths ? widths.reduce((a, b) => a + b, 0) : 0;
  const colgroup = widths ? "<colgroup>" + widths.map((w) => `<col style="width: ${Math.round(w / sum * 1e3) / 10}%;">`).join("") + "</colgroup>" : "";
  return "<table>" + colgroup + (header ? "<thead>" + row(rows[0], "th") + "</thead>" : "") + "<tbody>" + (body.length ? body : [[]]).map((r) => row(r, "td")).join("") + "</tbody></table>";
}

// GFM pipe tables. A delimiter cell is one or more dashes, with optional alignment colons (`:-:`).
const PIPE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
function isPipeTableStart(lines: string[], i: number): boolean {
  return lines[i].includes("|") && i + 1 < lines.length && lines[i + 1].includes("|") && PIPE_SEPARATOR.test(lines[i + 1]);
}
function pipeCells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|").replace(/<br\s*\/?>/gi, "\n"));
}

/** The specs `blocks` and `markdown` stand for, in order: Markdown and multi-element html specs expand to several. */
export function specsFrom({ blocks, markdown }: BlockSource): unknown[] {
  const specs: unknown[] = [];
  const list: unknown[] = Array.isArray(blocks) ? blocks : blocks !== undefined && blocks !== null ? [blocks] : [];
  for (const spec of list) {
    if (spec === undefined || spec === null) continue;
    // A { markdown } entry may stand for several blocks.
    if (isRecord(spec) && typeof spec.markdown === "string" && spec.type === undefined) specs.push(...markdownToSpecs(spec.markdown));
    // An html spec holding several top-level elements becomes several blocks.
    else if (isRecord(spec) && blockKind(spec.type, fallbackKind(spec)) === "html") specs.push(...splitTopLevelHtml(stripUnsafe(String(spec.html ?? "")).trim()).map((html) => ({ type: "html", html })));
    else specs.push(spec);
  }
  if (typeof markdown === "string") specs.push(...markdownToSpecs(markdown));
  return specs;
}

export function escapeHtml(value: unknown): string {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function safeUrl(url: unknown, { image = false } = {}): string | null {
  const u = String(url || "").trim();
  if (image) return /^(https?:\/\/|data:image\/(png|jpe?g|gif|webp|avif);)/i.test(u) ? u : null;
  if (/^(https?:|mailto:|tel:|#|\/)/i.test(u)) return u;
  return /^[a-z][a-z0-9+.-]*:/i.test(u) ? null : u;
}

// Code spans, taken out first: what is inside one is literal, escapes too.
// Outside one, a backslash keeps a backtick from opening a span. A span closes
// on a run of as many backticks as opened it, and one space just inside both
// ends is padding.
function codeSpans(s: string, keep: (html: string) => string): string {
  let out = "";
  for (let i = 0; i < s.length;) {
    if (s[i] === "\\") { out += s.slice(i, i + 2); i += 2; continue; }
    if (s[i] !== "`") { out += s[i++]; continue; }
    let j = i;
    while (s[j] === "`") j++;
    const fence = s.slice(i, j), close = new RegExp(`(?<!\`)${fence}(?!\`)`, "g");
    close.lastIndex = j;
    const end = close.exec(s)?.index ?? -1;
    const c = s.slice(j, end);
    if (end < 0 || c.includes("\n")) { out += fence; i = j; continue; }
    out += keep("<code>" + escapeHtml(/^ .*[^ ].* $/.test(c) ? c.slice(1, -1) : c) + "</code>");
    i = end + fence.length;
  }
  return out;
}

// Inline Markdown -> the editor's own markup (<b>, <i>, <s>, <code>, <a>, <img>). The <strong>,
// <em> and <del> that htmlToMarkdown writes where asterisks would pair wrongly are read back too.
function inlineMarkdown(text: unknown): string {
  const stash: string[] = [];
  const keep = (html: string) => "\0" + (stash.push(html) - 1) + "\0";
  let s = String(text ?? "").replace(/\0/g, "");
  s = codeSpans(s, keep);
  s = s.replace(/!\[((?:\\.|[^\]\\\n])*)\]\(<?([^)\s>]+)>?\)/g, (m, alt: string, url: string) => {
    const src = url.includes("\0") ? null : safeUrl(url, { image: true });
    return src ? keep('<img class="doc-image" src="' + escapeHtml(src) + '" alt="' + escapeHtml(alt.replace(/\\([\\[\]])/g, "$1")) + '">') : m;
  });
  s = s.replace(/\\([!-/:-@[-`{-~])/g, (_, c: string) => keep(escapeHtml(c)));
  // A label may hold a line break (but not a blank line), and a URL in it is
  // its text, not another link.
  s = s.replace(/\[((?:[^\]\n]|\n(?!\s*\n))+)\]\(([^)\s]+)\)/g, (m, label: string, url: string) => {
    // A code span inside the URL was already taken out; such a link stays text.
    const href = url.includes("\0") ? null : safeUrl(url);
    const text = label.replace(/https?:\/\/[^\s<\0*~]*[^\s<\0.,;:!?)\]'"*_~]/g, (u) => keep(escapeHtml(u)));
    return href ? keep('<a href="' + escapeHtml(href) + '">') + text + keep("</a>") : m;
  });
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<\0]+[^\s<\0.,;:!?)\]'"])/g, (_, pre: string, url: string) => pre + keep('<a href="' + escapeHtml(url) + '">' + escapeHtml(url) + "</a>"));
  s = escapeHtml(s).replace(/&lt;(\/?)(strong|em|del)&gt;/g, (_, close: string, tag: string) => `<${close}${{ strong: "b", em: "i", del: "s" }[tag]}>`);
  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<b>$1</b>").replace(/__(?=\S)([\s\S]*?\S)__/g, "<b>$1</b>");
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<s>$1</s>");
  s = s.replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\*)/g, "$1<i>$2</i>").replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, "$1<i>$2</i>");
  s = s.replace(/\n/g, "<br>");
  return s.replace(/\0(\d+)\0/g, (_, i: string) => stash[Number(i)]);
}

function inlineContent(spec: BlockSpec): string {
  const html = spec.html !== undefined && spec.html !== null ? stripUnsafe(String(spec.html)) : inlineMarkdown(spec.text ?? "");
  return html.trim() ? html : "<br>";
}

/**
 * `html` without what the editor drops when it shows a block (client.ts `scrubElement`): unsafe
 * elements (scripts, styles, frames, plugins, forms, `svg`/`math`, `noscript`, `template`) with
 * their content, event handlers, `srcdoc`, `contenteditable`, `id`/`name`, and script URLs. Read
 * the way a browser tokenizes HTML, in one pass, so an attribute that only looks quoted
 * (`<img "x onerror=…>`) is still found and a crafted input costs linear time. Markup the editor
 * itself serializes comes back unchanged: everything kept is copied as written.
 */
export function stripUnsafe(html: string): string {
  const src = String(html);
  const closers = new Map<string, number>();
  let out = "";
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt < 0) { out += src.slice(i); break; }
    out += src.slice(i, lt);
    const next = src[lt + 1] ?? "";
    if (src.startsWith("<!--", lt)) {
      // A comment, inert to the end: `<!-->`, `<!--->`, or the first `-->` / `--!>` after it.
      const end = src.startsWith("<!-->", lt) ? lt + 5 : src.startsWith("<!--->", lt) ? lt + 6 : commentEnd(src, lt + 4);
      out += src.slice(lt, end);
      i = end;
      continue;
    }
    if (next === "!" || next === "?" || next === "/" && !isAsciiLetter(src[lt + 2])) {
      // A bogus comment, to the next `>`.
      const gt = src.indexOf(">", lt);
      const end = gt < 0 ? src.length : gt + 1;
      out += src.slice(lt, end);
      i = end;
      continue;
    }
    const closing = next === "/";
    if (!isAsciiLetter(closing ? src[lt + 2] : next)) { out += "<"; i = lt + 1; continue; }
    const tag = readTag(src, lt + (closing ? 2 : 1));
    // A browser drops a tag still open where the input ends.
    if (!tag) break;
    const name = tag.name.toLowerCase();
    i = tag.end;
    if (closing) {
      if (!UNSAFE_ELEMENTS.has(name)) out += "</" + tag.name + ">";
      continue;
    }
    if (RAW_TEXT_ELEMENTS.has(name) || UNSAFE_ELEMENTS.has(name)) {
      const close = name === "plaintext" ? -1 : findCloser(src, name, i, closers);
      const closeTag = close < 0 ? null : readTag(src, close + 2);
      // Without an end tag, what follows is read as markup and cleaned as such: an unsafe
      // element loses only its start tag.
      const end = closeTag ? closeTag.end : name === "plaintext" ? src.length : i;
      if (!UNSAFE_ELEMENTS.has(name)) out += cleanTag(tag) + src.slice(i, end);
      i = end;
      continue;
    }
    out += cleanTag(tag);
  }
  return out;
}

const UNSAFE_ELEMENTS = new Set(["script", "style", "iframe", "frame", "frameset", "object", "embed", "link", "meta", "base", "form", "input", "button", "textarea", "title", "select", "svg", "math", "noscript", "template"]);
// Elements whose content a browser reads as text up to their end tag (the unsafe ones aside):
// copied as written, since tags inside them are not tags.
const RAW_TEXT_ELEMENTS = new Set(["xmp", "noembed", "noframes", "plaintext"]);
const URL_ATTRS = new Set(["href", "src", "xlink:href", "action", "formaction"]);
// `id` and `name` would make an element a named property of window or document (see client.ts).
const DROPPED_ATTRS = new Set(["srcdoc", "contenteditable", "id", "name"]);

function isAsciiLetter(c: string | undefined): boolean {
  return c !== undefined && /^[a-z]$/i.test(c);
}

function commentEnd(src: string, from: number): number {
  const a = src.indexOf("-->", from), b = src.indexOf("--!>", from);
  if (a < 0 && b < 0) return src.length;
  return a >= 0 && (b < 0 || a < b) ? a + 3 : b + 4;
}

// Where `</name` (ended by space, `/` or `>`) next occurs at or after `from`, or -1. Searches only
// move forward, so each name's last answer is kept, and the input is read once per name.
function findCloser(src: string, name: string, from: number, cache: Map<string, number>): number {
  const known = cache.get(name);
  if (known !== undefined && (known < 0 || known >= from)) return known;
  const re = new RegExp("</" + name + "(?=[\\s/>])", "gi");
  re.lastIndex = from;
  const at = re.exec(src)?.index ?? -1;
  cache.set(name, at);
  return at;
}

/** A tag as read: its name, each attribute's source text, a trailing `/`, and the index after `>`. */
interface ReadTag {
  name: string;
  attrs: { name: string; source: string; value: string | null }[];
  selfClose: boolean;
  end: number;
}

const isTagSpace = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";

// The tag whose name starts at `at`, tokenized as a browser does (quotes count only after `=`),
// or null when the input ends inside it.
function readTag(src: string, at: number): ReadTag | null {
  let i = at;
  while (i < src.length && !isTagSpace(src[i]) && src[i] !== "/" && src[i] !== ">") i++;
  const tag: ReadTag = { name: src.slice(at, i), attrs: [], selfClose: false, end: 0 };
  for (;;) {
    while (i < src.length && (isTagSpace(src[i]) || src[i] === "/")) {
      tag.selfClose = src[i] === "/";
      i++;
    }
    if (i >= src.length) return null;
    if (src[i] === ">") { tag.end = i + 1; return tag; }
    tag.selfClose = false;
    const start = i;
    i++; // A name may begin with "=".
    while (i < src.length && !isTagSpace(src[i]) && src[i] !== "/" && src[i] !== ">" && src[i] !== "=") i++;
    const name = src.slice(start, i);
    let j = i;
    while (j < src.length && isTagSpace(src[j])) j++;
    let value: string | null = null;
    if (src[j] === "=") {
      j++;
      while (j < src.length && isTagSpace(src[j])) j++;
      const quote = src[j];
      if (quote === '"' || quote === "'") {
        const close = src.indexOf(quote, j + 1);
        if (close < 0) return null;
        value = src.slice(j + 1, close);
        i = close + 1;
      } else if (src[j] === ">") {
        value = "";
        i = j;
      } else {
        const v = j;
        while (j < src.length && !isTagSpace(src[j]) && src[j] !== ">") j++;
        value = src.slice(v, j);
        i = j;
      }
    }
    tag.attrs.push({ name, source: src.slice(start, i), value });
  }
}

// A kept start tag, written with only its safe attributes, each as it was written.
function cleanTag(tag: ReadTag): string {
  let out = "<" + tag.name;
  for (const { name, source, value } of tag.attrs) {
    const attr = name.toLowerCase();
    // Event handlers (onclick, and <img/onerror=…>) never survive.
    if (attr.startsWith("on") || DROPPED_ATTRS.has(attr)) continue;
    if (value !== null && URL_ATTRS.has(attr) && isScriptUrl(value)) continue;
    out += " " + source;
  }
  return out + (tag.selfClose ? " /" : "") + ">";
}

// A URL attribute's source value as a browser decodes it, then as client.ts tests it. Named
// references decodeHtml doesn't know are dropped (`java&Tab;script:`), all but `&colon;`.
function isScriptUrl(source: string): boolean {
  const value = decodeHtml(source.replace(/&colon;?/gi, ":").replace(/&(?!(?:#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);)[a-z][a-z0-9]*;?/gi, ""));
  return /^(javascript|vbscript|data:text)/i.test(value.replace(/[\s\u0000-\u001f]+/g, ""));
}

/** The block HTML one spec stands for (a bare string is a paragraph of inline Markdown). */
export function specHtml(input: unknown): string {
  const spec: BlockSpec = typeof input === "string" ? { type: "p", text: input } : isRecord(input) ? input : { type: "p", text: String(input) };
  if (typeof spec.markdown === "string" && spec.type === undefined) {
    const [first] = markdownToSpecs(spec.markdown);
    return specHtml(first || { type: "p", text: "" });
  }
  const kind = blockKind(spec.type, fallbackKind(spec));
  switch (kind) {
    case "p": return "<p>" + inlineContent(spec) + "</p>";
    case "h1": case "h2": case "h3": return `<${kind}>${inlineContent(spec)}</${kind}>`;
    case "quote": return "<blockquote>" + inlineContent(spec) + "</blockquote>";
    case "code": {
      const code = String(spec.text ?? spec.code ?? "").replace(/\n$/, "");
      return "<pre>" + (code ? escapeHtml(code) : "<br>") + "</pre>";
    }
    case "divider": return "<hr>";
    case "table": return tableHtml(spec);
    case "image": {
      const src = safeUrl(spec.src ?? spec.url, { image: true });
      if (!src) throw new Error("An image needs an https:// or data:image src.");
      const width = Number(spec.width) > 0 ? ` style="width:${Math.round(Number(spec.width))}px;height:auto;"` : "";
      return `<p><img class="doc-image" draggable="true" src="${escapeHtml(src)}" alt="${escapeHtml(spec.alt ?? "Image")}"${width}></p>`;
    }
    case "html": {
      const html = stripUnsafe(String(spec.html ?? "")).trim();
      return html || "<p><br></p>";
    }
    default: {
      // { type: "ul", text: "a\nb" } is a list of two items.
      const items = spec.items ?? (spec.text !== undefined ? String(spec.text).split("\n").map((text) => ({ text, checked: spec.checked })) : []);
      return listHtml(kind, items, false);
    }
  }
}

const isListKind = (kind: unknown): kind is "ul" | "ol" | "todo" => kind === "ul" || kind === "ol" || kind === "todo";
function listHtml(kind: BlockKind, items: unknown, inChecklist: boolean): string {
  const tag = kind === "ol" ? "ol" : "ul";
  const cls = kind === "todo" && !inChecklist ? ' class="checklist"' : "";
  const rows = (Array.isArray(items) && items.length ? items : [""]).map((raw: unknown) => {
    const item: BlockSpec = typeof raw === "string" ? { text: raw } : isRecord(raw) ? raw : { text: raw === null || raw === undefined ? "" : String(raw) };
    const checked = (kind === "todo" || inChecklist) && item.checked ? ' data-checked="true"' : "";
    const childKind = Array.isArray(item.items) && item.items.length ? blockKind(item.listType ?? item.type, kind) : null;
    // Consecutive children of one kind make one nested list (see MarkdownItem.run).
    const runs: { kind: BlockKind; items: unknown[] }[] = [];
    if (childKind) for (const child of item.items as unknown[]) {
      const run = isRecord(child) && isListKind(child.run) ? child.run : isListKind(childKind) ? childKind : kind;
      if (runs.at(-1)?.kind === run) runs.at(-1)!.items.push(child);
      else runs.push({ kind: run, items: [child] });
    }
    const nested = runs.map((r) => listHtml(r.kind, r.items, inChecklist || kind === "todo")).join("");
    const body = { ...item, type: undefined };
    const content = inlineContent(body);
    return `<li${checked}>${content === "<br>" && nested ? "" : content}${nested}</li>`;
  });
  return `<${tag}${cls}>${rows.join("")}</${tag}>`;
}

/** One item of a Markdown list, with the items nested under it. */
interface MarkdownItem {
  text: string;
  checked: boolean;
  items?: MarkdownItem[];
  listType?: BlockKind;
  /** The kind of the nested list it is in, when that isn't its parent's `listType`. */
  run?: BlockKind;
}

// Block-level Markdown -> specs: headings, paragraphs, (nested) bulleted,
// numbered and task lists, quotes, fenced code, dividers and images.
export function markdownToSpecs(markdown: unknown): BlockSpec[] {
  // Tabs count as four spaces of indentation, except in fenced code, which is kept as written.
  const raw = String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n");
  const lines = raw.map((line) => line.replace(/\t/g, "    "));
  const specs: BlockSpec[] = [];
  // An empty item ("-", "2.", "- [ ]") is still an item.
  const LIST = /^(\s*)([-*+]|\d{1,9}[.)])(?:\s+|$)(?:\[([ xX])\](?:\s+|$))?(.*)$/;
  let para: string[] = [];
  const flush = () => {
    if (para.length) specs.push({ type: "p", text: para.join("\n") });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) { flush(); continue; }
    const fence = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      for (i++; i < lines.length && !closesFence(lines[i], fence[1]); i++) body.push(raw[i]);
      specs.push({ type: "code", text: body.join("\n") });
      continue;
    }
    if (isPipeTableStart(lines, i)) {
      flush();
      const rows = [pipeCells(line)];
      for (i += 2; i < lines.length && lines[i].trim() && lines[i].includes("|"); i++) rows.push(pipeCells(lines[i]));
      i--;
      specs.push({ type: "table", rows, header: true });
      continue;
    }
    // A closing run of #s needs a space before it: "Learn C#" keeps its #.
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/.exec(line);
    if (heading) { flush(); specs.push({ type: "h" + Math.min(3, heading[1].length), text: heading[2] }); continue; }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); specs.push({ type: "divider" }); continue; }
    const image = /^\s*!\[([^\]]*)\]\(([^)\s]+)\)\s*$/.exec(line);
    if (image && safeUrl(image[2], { image: true })) { flush(); specs.push({ type: "image", alt: image[1], src: image[2] }); continue; }
    if (/^\s{0,3}>/.test(line)) {
      flush();
      const quote: string[] = [];
      for (; i < lines.length && /^\s{0,3}>/.test(lines[i]); i++) quote.push(lines[i].replace(/^\s{0,3}>\s?/, ""));
      i--;
      specs.push({ type: "quote", text: quote.join("\n") });
      continue;
    }
    if (LIST.test(line)) {
      flush();
      // One list block per run of top-level items of the same kind and
      // marker (a new marker, `1)` after `1.`, starts a new list); deeper
      // indentation nests under the item above.
      let block: { type: BlockKind; items: MarkdownItem[]; marker?: string } | null = null;
      let levels: { indent: number; items: MarkdownItem[]; parent?: MarkdownItem }[] = [];
      for (; i < lines.length; i++) {
        const l = lines[i];
        if (!l.trim()) {
          let j = i + 1;
          while (j < lines.length && !lines[j].trim()) j++;
          if (j < lines.length && LIST.test(lines[j])) continue;
          break;
        }
        const m = LIST.exec(l);
        if (!m) {
          if (/^\s{2,}\S/.test(l) && levels.length) {
            const items = levels[levels.length - 1].items;
            const last = items[items.length - 1];
            // An indented line continues the item after a line break.
            last.text = last.text.replace(/\s+$/, "") + "\n" + l.trim();
            continue;
          }
          break;
        }
        const indent = m[1].length;
        const kind: BlockKind = m[3] !== undefined ? "todo" : /\d/.test(m[2]) ? "ol" : "ul";
        const marker = m[2].slice(-1);
        const item: MarkdownItem = { text: m[4], checked: m[3] !== undefined && m[3] !== " " };
        let level = levels[levels.length - 1];
        if (level && indent > level.indent) {
          const parent = level.items[level.items.length - 1];
          parent.items = parent.items || [];
          parent.listType = parent.listType || kind;
          levels.push({ indent, items: parent.items, parent });
          level = levels[levels.length - 1];
        } else {
          while (levels.length > 1 && indent < level.indent) { levels.pop(); level = levels[levels.length - 1]; }
        }
        if (!level || levels.length === 1 && block && (block.type !== kind || block.marker !== marker)) {
          block = { type: kind, items: [], marker };
          specs.push({ type: kind, items: block.items });
          levels = [{ indent, items: block.items }];
          level = levels[0];
        }
        // A nested run of another kind (a bulleted list after a numbered one
        // under the same item) stays a list of its own.
        if (level.parent && kind !== level.parent.listType) item.run = kind;
        level.items.push(item);
      }
      i--;
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return specs;
}

// Toggle the nth top-level <li> of a list block.
export function setItemChecked(html: string, n: number, checked: boolean): string {
  if (!/^\s*<ul\b[^>]*\bchecklist\b/i.test(html)) throw new Error("That block is not a to-do list.");
  const re = /<(\/?)(li|ul|ol)\b[^>]*>/gi;
  let depth = 0, count = -1, m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const closing = m[1] === "/", tag = m[2].toLowerCase();
    if (tag !== "li") { depth += closing ? -1 : 1; continue; }
    if (closing || depth !== 1) continue;
    if (++count !== n) continue;
    const open = m[0].replace(/\sdata-checked\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i, "");
    const next = checked ? open.replace(/^<li/i, '<li data-checked="true"') : open;
    return html.slice(0, m.index) + next + html.slice(m.index + m[0].length);
  }
  throw new Error("No item " + n + " in that list.");
}

/** A block's type as the block API names it: p, h1-h3, quote, code, divider, ul, ol, todo, image, table, or another tag's name. */
export function blockTypeOf(html: string): string {
  const m = /^\s*<([a-z0-9]+)([^>]*)>/i.exec(String(html));
  const tag = m ? m[1].toLowerCase() : "";
  const attributes = m ? m[2] : "";
  switch (tag) {
    case "h1": case "h2": case "h3": return tag;
    case "h4": case "h5": case "h6": return "h3";
    case "ul": return /(^|\s)checklist(\s|$)/.test(readHtmlAttribute(attributes, "class")) ? "todo" : "ul";
    case "ol": return "ol";
    case "blockquote": return /margin/.test(readHtmlAttribute(attributes, "style")) ? "p" : "quote";
    case "pre": return "code";
    case "hr": return "divider";
    case "p": case "div": return /<img\b/i.test(html) && !String(html).replace(/<[^>]*>/g, "").replace(/&nbsp;|\s|​/g, "") ? "image" : "p";
    default: return tag || "p";
  }
}

export function describeBlock(block: StoredBlock, withHtml: boolean): BlockDescription {
  const out: BlockDescription = { id: block.id, type: blockTypeOf(block.html), markdown: htmlToMarkdown(block.html, { abbreviateImages: true }).trim(), version: block.version };
  if (withHtml) out.html = block.html;
  return out;
}
