// ─────────────────────────────────────────────────────────────────────────────
// Paste: clipboard HTML and plain text, rebuilt as the editor's own markup.
//
// Used by client.ts for paste and drop. Kept apart from the editor so the
// conversions can be tested on their own; it needs a DOM (DOMParser,
// document.createElement) and nothing else of the page.
//
//   sanitizePastedHtml   Google Docs, Word, Notion, Slack, GitHub, any web page
//   textToHtml           plain text: a TSV grid, Markdown, or plain lines
//
// The output holds only what the editor writes itself: p, h1–h3, blockquote,
// pre, ul/ol(.checklist)/li, table, hr, img.doc-image, and the inline b, i, u,
// s, code, a and palette-class spans (tc-*, hl-*). Fonts, sizes and any other
// styling are dropped.
// ─────────────────────────────────────────────────────────────────────────────

import { closesFence } from "./markdown.ts";

/** What the paste conversions need from the editor. */
export interface PasteContext {
  /** The palette colour names (`blue`, …, and `default`) a tc-/hl- class may carry. */
  colorKeys: ReadonlySet<string>;
  /** Rebuilds a pasted <img> as the editor's image, or null to drop it. */
  image(src: Element): HTMLElement | null;
}

/** The inline formatting pasted HTML carries down to a run of text. */
interface InlineFormat {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  code?: boolean;
  link?: string;
  tc?: string;
  hl?: string;
}

const isElement = (n: Node | null | undefined): n is HTMLElement => !!n && n.nodeType === 1;
const isText = (n: Node | null | undefined): n is Text => !!n && n.nodeType === 3;

export function escapeHtml(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
export function normalizeHref(url: string | null | undefined): string {
  let href = String(url || "").trim();
  if (!href) return "";
  // Script and data links (pasted, or typed) aren't links at all.
  if (/^(javascript|vbscript|data|file):/i.test(href.replace(/[\s\u0000-\u001f]+/g, ""))) return "";
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(href)) return "mailto:" + href;
  if (!/^(https?:|mailto:|tel:|#|\/)/i.test(href)) href = "https://" + href;
  return href;
}

// ── Colours ──────────────────────────────────────────────────────────────
// The editor stores colours as palette classes, never literals, so they
// re-tint in dark mode. A literal colour from Google Docs or Word is mapped to
// the palette entry nearest in hue. Neutral colours (black, greys, white) and
// faint ones map to none: they are the source's body text and page, not
// emphasis -- and the editor's own copied text carries its theme's text colour
// as a literal.
const NAMED_COLORS: Record<string, string> = {
  black: "#000000", white: "#ffffff", gray: "#808080", grey: "#808080", silver: "#c0c0c0",
  red: "#ff0000", maroon: "#800000", orange: "#ffa500", yellow: "#ffff00", olive: "#808000",
  lime: "#00ff00", green: "#008000", teal: "#008080", aqua: "#00ffff", cyan: "#00ffff",
  blue: "#0000ff", navy: "#000080", purple: "#800080", fuchsia: "#ff00ff", magenta: "#ff00ff",
  pink: "#ffc0cb", brown: "#a52a2a", darkred: "#8b0000", darkblue: "#00008b", darkgreen: "#006400",
  darkyellow: "#808000", darkcyan: "#008b8b", darkmagenta: "#8b008b", lightgray: "#d3d3d3",
};
// Hue anchors (degrees) of the palette's chromatic entries.
const HUES: [string, number][] = [["red", 0], ["orange", 28], ["yellow", 50], ["green", 130], ["blue", 210], ["purple", 275], ["pink", 318], ["red", 360]];
/** A CSS colour as [r, g, b, alpha], or null when it is not a plain colour. */
function parseColor(value: string): [number, number, number, number] | null {
  const v = value.trim().toLowerCase();
  const hex = NAMED_COLORS[v] ?? v;
  let m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(hex);
  if (m) return [parseInt(m[1] + m[1], 16), parseInt(m[2] + m[2], 16), parseInt(m[3] + m[3], 16), 1];
  m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/.exec(hex);
  if (m) return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16), m[4] ? parseInt(m[4], 16) / 255 : 1];
  m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(v);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : Number(m[4])];
  return null;
}
/**
 * The palette name nearest a literal colour: undefined for a neutral or faint
 * one (it clears an outer colour), null for a value that is not a colour.
 */
export function paletteColorOf(value: string, kind: "tc" | "hl"): string | undefined | null {
  if (/^(transparent|none|initial|inherit|unset|currentcolor|windowtext|auto)$/i.test(value.trim())) return undefined;
  const rgba = parseColor(value);
  if (!rgba) return null;
  const [r, g, b] = rgba.slice(0, 3).map((x) => x / 255);
  if (rgba[3] < 0.3) return undefined;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (s < 0.25 || l < 0.12 || l > (kind === "hl" ? 0.97 : 0.92)) return undefined;
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  // Dark oranges and reds read as brown.
  if (kind === "tc" && h >= 10 && h <= 45 && l < 0.4) return "brown";
  return HUES.reduce((best, cur) => Math.abs(cur[1] - h) < Math.abs(best[1] - h) ? cur : best)[0];
}
function cssColor(css: string, prop: "color" | "background"): string | null {
  // `background` also matches Word's shorthand (`background:yellow`).
  const re = prop === "color" ? /(?:^|;)\s*color\s*:\s*([^;]+)/ : /(?:^|;)\s*background(?:-color)?\s*:\s*([^;]+)/;
  const m = re.exec(css);
  if (!m) return null;
  // The first word of a shorthand that is a colour.
  for (const part of m[1].replace(/!important/, "").match(/#[0-9a-f]+|rgba?\([^)]*\)|[a-z]+/gi) ?? []) {
    if (paletteColorOf(part, prop === "color" ? "tc" : "hl") !== null) return part;
  }
  return null;
}

// ── Inline formatting ────────────────────────────────────────────────────
function fmtOf(node: Element, ctx: InlineFormat, pc: PasteContext): InlineFormat {
  const css = (node.getAttribute("style") || "").toLowerCase();
  const cls = node.getAttribute("class") || "";
  const tag = node.tagName;
  const n = { ...ctx };
  if (tag === "B" || tag === "STRONG") n.bold = true;
  if (tag === "I" || tag === "EM") n.italic = true;
  if (tag === "U" || tag === "INS") n.underline = true;
  if (tag === "S" || tag === "STRIKE" || tag === "DEL") n.strike = true;
  if (tag === "CODE" || tag === "TT" || tag === "KBD") n.code = true;
  if (tag === "A") n.link = node.getAttribute("href") || ctx.link;
  if (/font-weight:\s*(bold|[6-9]00)/.test(css)) n.bold = true;
  else if (/font-weight:\s*(normal|[1-4]00)/.test(css)) n.bold = false;
  if (/font-style:\s*italic/.test(css)) n.italic = true;
  else if (/font-style:\s*normal/.test(css)) n.italic = false;
  if (/text-decoration[^;]*underline/.test(css)) n.underline = true;
  if (/text-decoration[^;]*line-through/.test(css)) n.strike = true;
  // A link's colour is the source's link style, not emphasis.
  const color = n.link ? null : cssColor(css, "color") ?? (tag === "FONT" ? node.getAttribute("color") : null);
  if (color !== null) n.tc = paletteColorOf(color, "tc") ?? undefined;
  const background = cssColor(css, "background");
  if (background !== null) n.hl = paletteColorOf(background, "hl") ?? undefined;
  const tc = cls.match(/\btc-([a-z]+)/), hl = cls.match(/\bhl-([a-z]+)/);
  if (tc && pc.colorKeys.has(tc[1])) n.tc = tc[1];
  if (hl && pc.colorKeys.has(hl[1])) n.hl = hl[1];
  if (n.tc && !pc.colorKeys.has(n.tc)) n.tc = undefined;
  if (n.hl && !pc.colorKeys.has(n.hl)) n.hl = undefined;
  return n;
}
function wrapInline(text: string, ctx: InlineFormat): Node {
  let node: Node = document.createTextNode(text);
  const wrap = (tag: string) => { const w = document.createElement(tag); w.appendChild(node); node = w; };
  if (ctx.code) wrap("code");
  if (ctx.strike) wrap("s");
  if (ctx.underline) wrap("u");
  if (ctx.italic) wrap("i");
  if (ctx.bold) wrap("b");
  const classes = [ctx.tc && ctx.tc !== "default" ? "tc-" + ctx.tc : "", ctx.hl && ctx.hl !== "default" ? "hl-" + ctx.hl : ""].filter(Boolean).join(" ");
  if (classes) {
    const span = document.createElement("span");
    span.className = classes;
    span.appendChild(node);
    node = span;
  }
  const href = ctx.link && normalizeHref(ctx.link);
  if (href) {
    const a = document.createElement("a");
    a.href = href;
    a.appendChild(node);
    node = a;
  }
  return node;
}

// ── HTML ─────────────────────────────────────────────────────────────────
// Elements that hold blocks (or are blocks): anything else is inline.
const BLOCKS = new Set(["P", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "PRE", "UL", "OL", "LI", "DIV", "TABLE", "THEAD", "TBODY", "TFOOT", "TR", "TD", "TH", "HR",
  "SECTION", "ARTICLE", "HEADER", "FOOTER", "ASIDE", "NAV", "MAIN", "FIGURE", "FIGCAPTION", "DL", "DT", "DD", "DETAILS", "SUMMARY", "ADDRESS", "CENTER"]);
// Blocks written as one line of text. A <dt> is the term, so it is bold.
const LINE_BLOCKS = new Set(["P", "H1", "H2", "H3", "H4", "H5", "H6", "DT", "DD", "FIGCAPTION", "SUMMARY", "ADDRESS"]);
const SKIP = new Set(["STYLE", "SCRIPT", "META", "TITLE", "HEAD", "LINK", "TEMPLATE", "NOSCRIPT", "SVG", "MATH", "IFRAME", "OBJECT", "BUTTON", "SELECT", "TEXTAREA"]);
const holdsBlocks = (node: Element): boolean => Array.from(node.children).some((c) => BLOCKS.has(c.tagName) || holdsBlocks(c) && !SKIP.has(c.tagName));
const hasContent = (n: Element) => !!n.textContent?.trim() || !!n.querySelector("img");

// Word's list paragraph: `style="mso-list:l0 level2 lfo1"`, its marker ("·",
// "o", "1.") in a `mso-list:Ignore` span that only Word's own renderer hides.
const WORD_LIST = /mso-list:\s*l\d+\s+level(\d+)/i;
const WORD_LIST_TAGS = /^(P|DIV|LI)$/;
const ORDERED_MARKER = /^\(?([0-9]+|[a-z]|[ivxlcdm]+)[.)]$/i;
function wordListItem(node: Node): { level: number; ordered: boolean } | null {
  if (!isElement(node) || !WORD_LIST_TAGS.test(node.tagName)) return null;
  const m = WORD_LIST.exec(node.getAttribute("style") || "");
  if (!m) return null;
  const marker = node.querySelector('[style*="mso-list:ignore" i], [style*="mso-list: ignore" i]');
  let text = "";
  if (marker) { text = marker.textContent || ""; marker.remove(); }
  else {
    // No marker span: strip a leading marker from the text itself.
    const first = document.createTreeWalker(node, NodeFilter.SHOW_TEXT).nextNode() as Text | null;
    const lead = first && /^[\s ]*(\S{1,5})[\s ]+/.exec(first.data);
    if (first && lead && (ORDERED_MARKER.test(lead[1]) || /^[·•▪◦§o\-–*]$/.test(lead[1]))) { text = lead[1]; first.data = first.data.slice(lead[0].length); }
  }
  return { level: Math.max(1, Number(m[1])), ordered: ORDERED_MARKER.test(text.replace(/[\s ]+/g, "")) };
}

/** Pasted HTML rebuilt as the editor's own markup. */
export function sanitizePastedHtml(html: string, pc: PasteContext): string {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const result = document.createElement("div");
  function appendInline(src: Node, target: Node, ctx: InlineFormat) {
    src.childNodes.forEach((child) => appendInlineNode(child, target, ctx));
  }
  function appendInlineNode(child: Node, target: Node, ctx: InlineFormat) {
    if (isText(child)) { if (child.data) target.appendChild(wrapInline(child.data, ctx)); }
    else if (isElement(child)) {
      const tag = child.tagName;
      if (tag === "BR") target.appendChild(document.createElement("br"));
      else if (tag === "IMG") { const img = pc.image(child); if (img) target.appendChild(img); }
      else if (tag === "HR" || SKIP.has(tag)) return;
      else appendInline(child, target, fmtOf(child, ctx, pc));
    }
  }
  // Lines of a block that holds blocks (a list item, a cell): its inline
  // formatting is kept and each inner block becomes a line (<br>).
  function inlineLines(src: Node, target: Node, ctx: InlineFormat, skip: (el: Element) => boolean = () => false) {
    src.childNodes.forEach((child) => {
      if (isText(child)) { if (child.data.trim() || target.childNodes.length) target.appendChild(wrapInline(child.data, ctx)); return; }
      if (!isElement(child) || SKIP.has(child.tagName) || skip(child)) return;
      const tag = child.tagName;
      if (tag === "BR") { target.appendChild(document.createElement("br")); return; }
      if (tag === "IMG") { const img = pc.image(child); if (img) target.appendChild(img); return; }
      if (BLOCKS.has(tag) && tag !== "TD" && tag !== "TH") {
        if (target.childNodes.length && target.lastChild!.nodeName !== "BR") target.appendChild(document.createElement("br"));
        if (tag === "PRE") { appendPreLines(child, target); return; }
      }
      inlineLines(child, target, fmtOf(child, ctx, pc), skip);
    });
  }
  function appendPreLines(pre: Element, target: Node) {
    preText(pre).split("\n").forEach((line, i) => {
      if (i) target.appendChild(document.createElement("br"));
      if (line) target.appendChild(wrapInline(line, { code: true }));
    });
  }
  // A to-do item: GitHub's task list (<input type=checkbox>) or Notion's (.checkbox-on/off).
  function checkboxOf(li: Element): boolean | null {
    const box = Array.from(li.querySelectorAll('input[type="checkbox" i], .checkbox')).find((b) => b.closest("li") === li);
    if (!box) return null;
    return box.tagName === "INPUT" ? box.hasAttribute("checked") : box.classList.contains("checkbox-on");
  }
  function processList(src: Element, ctx: InlineFormat): HTMLElement {
    const list = document.createElement(src.tagName === "OL" ? "ol" : "ul");
    const items = Array.from(src.children).filter((c) => c.tagName === "LI");
    const checks = items.map(checkboxOf);
    const checklist = src.classList.contains("checklist") || items.length > 0 && checks.every((c) => c !== null);
    if (checklist) list.className = "checklist";
    // Google Docs writes a nested list as a sibling item list (<ul><li/><ul>…</ul></ul>),
    // and each item's depth as aria-level on flat lists; both nest under the item above.
    const levels: { level: number; list: HTMLElement }[] = [{ level: Number(items[0]?.getAttribute("aria-level")) || 1, list }];
    const lastItem = (l: HTMLElement) => (l.lastElementChild as HTMLElement | null) ?? l.appendChild(document.createElement("li"));
    Array.from(src.children).forEach((child) => {
      if (child.tagName === "UL" || child.tagName === "OL") { lastItem(levels.at(-1)!.list).appendChild(processList(child, ctx)); return; }
      if (child.tagName !== "LI") return;
      const li = document.createElement("li");
      if (child.getAttribute("data-checked") === "true" || checklist && checks[items.indexOf(child)]) li.setAttribute("data-checked", "true");
      const nested: Element[] = [];
      inlineLines(child, li, ctx, (g) => {
        if (g.tagName === "UL" || g.tagName === "OL") { nested.push(g); return true; }
        return checklist && (g.tagName === "INPUT" || g.classList.contains("checkbox"));
      });
      // The space between a dropped checkbox and the text.
      if (li.firstChild && isText(li.firstChild)) li.firstChild.data = li.firstChild.data.replace(/^\s+/, "");
      if (li.firstChild && isText(li.firstChild) && !li.firstChild.data) li.firstChild.remove();
      while (li.lastChild?.nodeName === "BR") li.lastChild.remove();
      nested.forEach((n) => li.appendChild(processList(n, ctx)));
      const level = Number(child.getAttribute("aria-level")) || levels[0].level;
      while (levels.length > 1 && level < levels.at(-1)!.level) levels.pop();
      if (level > levels.at(-1)!.level) {
        const sub = document.createElement(list.tagName === "OL" ? "ol" : "ul");
        if (checklist) sub.className = "checklist";
        lastItem(levels.at(-1)!.list).appendChild(sub);
        levels.push({ level, list: sub });
      }
      levels.at(-1)!.list.appendChild(li);
    });
    return list;
  }
  // Consecutive Word list paragraphs, nested by their level.
  function wordList(paras: { node: Element; level: number; ordered: boolean }[], ctx: InlineFormat, out: Node) {
    const stack: { level: number; ordered: boolean; list: HTMLElement }[] = [];
    for (const { node, level, ordered } of paras) {
      while (stack.length && stack.at(-1)!.level > level) stack.pop();
      if (stack.length && stack.at(-1)!.level === level && stack.at(-1)!.ordered !== ordered) stack.pop();
      if (!stack.length || stack.at(-1)!.level < level) {
        const list = document.createElement(ordered ? "ol" : "ul");
        if (stack.length) {
          const parent = stack.at(-1)!.list;
          ((parent.lastElementChild as HTMLElement | null) ?? parent.appendChild(document.createElement("li"))).appendChild(list);
        } else out.appendChild(list);
        stack.push({ level, ordered, list });
      }
      const li = document.createElement("li");
      appendInline(node, li, fmtOf(node, ctx, pc));
      // The marker's tab: the spaces Word left between it and the text.
      if (li.firstChild && isText(li.firstChild)) li.firstChild.data = li.firstChild.data.replace(/^[\s ]+/, "");
      stack.at(-1)!.list.appendChild(li);
    }
  }
  // Any table (Sheets, Excel, Docs, the web) becomes a plain grid: spans are
  // flattened, short rows padded, and a header row kept only if it was one.
  // Centred and right-aligned cells keep their alignment.
  function cleanTable(src: HTMLTableElement, ctx: InlineFormat) {
    const rows = Array.from(src.rows || []);
    if (!rows.length) return null;
    const first = rows[0];
    const header = first.parentElement?.tagName === "THEAD" || first.cells.length > 0 && Array.from(first.cells).every((c) => c.tagName === "TH");
    // Per column, the rows below that a cell above still spans into: they get
    // an empty cell there, so the row's own cells stay in their columns.
    const covered: number[] = [];
    const grid = rows.map((row, i) => {
      const tag = header && i === 0 ? "th" : "td";
      const out: HTMLElement[] = [];
      const skipCovered = () => { while (covered[out.length]! > 0) out.push(document.createElement(tag)); };
      for (const cell of row.cells) {
        skipCovered();
        const at = out.length;
        const n = document.createElement(tag);
        inlineLines(cell, n, fmtOf(cell, ctx, pc));
        while (n.lastChild?.nodeName === "BR" && n.childNodes.length > 1) n.lastChild.remove();
        const align = (/text-align:\s*(center|right)/i.exec(cell.getAttribute("style") || "")?.[1] ?? cell.getAttribute("align") ?? "").toLowerCase();
        if (align === "center" || align === "right") n.style.textAlign = align;
        out.push(n);
        for (let k = 1; k < Math.min(cell.colSpan || 1, 20); k++) out.push(document.createElement(tag));
        const down = Math.min(cell.rowSpan || 1, rows.length - i);
        for (let k = at; k < out.length; k++) covered[k] = down;
      }
      skipCovered();
      for (let k = 0; k < covered.length; k++) if (covered[k]! > 0) covered[k] = covered[k]! - 1;
      return out;
    });
    const cols = Math.max(...grid.map((r) => r.length));
    if (!cols) return null;
    const table = document.createElement("table");
    const body = document.createElement("tbody");
    grid.forEach((cells, i) => {
      const tag = header && i === 0 ? "th" : "td";
      while (cells.length < cols) cells.push(document.createElement(tag));
      for (const c of cells) if (!c.firstChild) c.appendChild(document.createElement("br"));
      const tr = document.createElement("tr");
      tr.append(...cells);
      if (header && i === 0) { const thead = document.createElement("thead"); thead.appendChild(tr); table.appendChild(thead); }
      else body.appendChild(tr);
    });
    if (!body.rows.length) {
      const tr = document.createElement("tr");
      for (let c = 0; c < cols; c++) tr.appendChild(document.createElement("td")).appendChild(document.createElement("br"));
      body.appendChild(tr);
    }
    table.appendChild(body);
    return table;
  }
  // A quote holds lines only, so a quote of several blocks becomes a quote
  // per paragraph, with its lists, code and tables kept between them.
  function processQuote(node: Element, ctx: InlineFormat, out: Node) {
    const inner = document.createElement("div");
    processNodes(Array.from(node.childNodes), ctx, inner);
    for (const block of Array.from(inner.children)) {
      if (/^(P|H[1-3])$/.test(block.tagName)) {
        const q = document.createElement("blockquote");
        q.append(...block.childNodes);
        out.appendChild(q);
      } else out.appendChild(block);
    }
  }
  function processNodes(nodes: Node[], ctx: InlineFormat, out: Node) {
    // A run of inline nodes between blocks is one paragraph.
    let run: Node[] = [];
    const flush = () => {
      const p = document.createElement("p");
      for (const n of run) appendInlineNode(n, p, ctx);
      run = [];
      while (p.firstChild?.nodeName === "BR") p.firstChild.remove();
      while (p.lastChild?.nodeName === "BR") p.lastChild.remove();
      if (hasContent(p)) out.appendChild(p);
    };
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (node.nodeType === 8) continue;
      if (isText(node) || isElement(node) && !BLOCKS.has(node.tagName) && !SKIP.has(node.tagName) && !holdsBlocks(node)) { run.push(node); continue; }
      flush();
      if (!isElement(node) || SKIP.has(node.tagName)) continue;
      const tag = node.tagName;
      // (Only an element Word lists are made of starts one: a heading styled as a list item doesn't.)
      if (WORD_LIST_TAGS.test(tag) && WORD_LIST.test(node.getAttribute("style") || "")) {
        const paras: { node: Element; level: number; ordered: boolean }[] = [];
        for (; i < nodes.length; i++) {
          const n = nodes[i];
          if (isText(n) && !n.data.trim() || n.nodeType === 8) continue;
          const item = wordListItem(n);
          if (!item) break;
          paras.push({ node: n as Element, ...item });
        }
        i--;
        wordList(paras, ctx, out);
        continue;
      }
      if (tag === "TABLE") { const t = cleanTable(node as HTMLTableElement, fmtOf(node, ctx, pc)); if (t) out.appendChild(t); continue; }
      if (tag === "HR") { out.appendChild(document.createElement("hr")); continue; }
      if (tag === "UL" || tag === "OL") { out.appendChild(processList(node, ctx)); continue; }
      if (tag === "PRE") {
        const pre = document.createElement("pre");
        pre.textContent = preText(node).replace(/\n$/, "");
        if (pre.textContent.trim()) out.appendChild(pre);
        continue;
      }
      if (tag === "BLOCKQUOTE" && holdsBlocks(node)) { processQuote(node, fmtOf(node, ctx, pc), out); continue; }
      // A line: a paragraph, heading or quote, or a <div> of inline content
      // (an empty one, <div><br></div>, is a blank line in Apple Notes).
      if (tag === "BLOCKQUOTE" || (LINE_BLOCKS.has(tag) || tag === "DIV") && !holdsBlocks(node)) {
        const block = document.createElement(/^H[1-3]$/.test(tag) ? tag.toLowerCase() : /^H[4-6]$/.test(tag) ? "h3" : tag === "BLOCKQUOTE" ? "blockquote" : "p");
        const next = fmtOf(node, ctx, pc);
        appendInline(node, block, tag === "DT" ? { ...next, bold: true } : next);
        while (block.lastChild?.nodeName === "BR" && block.childNodes.length > 1) block.lastChild.remove();
        if (hasContent(block) || block.querySelector("br")) out.appendChild(block);
        continue;
      }
      processNodes(Array.from(node.childNodes), fmtOf(node, ctx, pc), out);
    }
    flush();
  }
  processNodes(Array.from(parsed.body.childNodes), {}, result);
  return result.innerHTML;
}
// A code block's text: its <br>s and per-line <div>s (Slack, code editors) are newlines.
function preText(pre: Element): string {
  let s = "";
  const walk = (n: Node) => {
    if (isText(n)) { s += n.data; return; }
    if (!isElement(n)) return;
    if (n.tagName === "BR") { s += "\n"; return; }
    const line = /^(DIV|P|LI)$/.test(n.tagName);
    if (line && s && !s.endsWith("\n")) s += "\n";
    n.childNodes.forEach(walk);
    if (line && !s.endsWith("\n")) s += "\n";
  };
  pre.childNodes.forEach(walk);
  return s;
}
/**
 * HTML a code editor (VS Code, a terminal) puts beside its plain text: the
 * text in monospace, `white-space: pre`, coloured by syntax. The plain text is
 * the content, and Markdown in it is read as Markdown.
 */
export function isCodeEditorHtml(html: string): boolean {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const root = Array.from(doc.body.children).filter((c) => !SKIP.has(c.tagName));
  if (root.length !== 1 || root[0].tagName === "PRE") return false;
  const css = (root[0].getAttribute("style") || "").toLowerCase();
  return /white-space:\s*pre/.test(css) && /font-family:[^;]*mono/.test(css) && !doc.body.querySelector("a, b, strong, i, em, u, ul, ol, table, h1, h2, h3, h4, h5, h6, img, blockquote");
}

// ── Plain text ───────────────────────────────────────────────────────────
// Plain text that looks like Markdown is pasted as formatted content.
export function inlineMarkdown(s: string): string {
  // Code spans and link tags are set aside while emphasis is read, so a `*` or `_` in code or
  // in a URL (`https://x.com/_a_`) is never taken for emphasis.
  const stash: string[] = [];
  const keep = (html: string) => `\u0000${stash.push(html) - 1}\u0000`;
  let out = escapeHtml(String(s).replace(/\u0000/g, "")).replace(/`([^`]+)`/g, (_, c: string) => keep(`<code>${c}</code>`));
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, t: string, u: string) => {
    const href = u.includes("\u0000") ? "" : normalizeHref(u);
    return href ? keep(`<a href="${href}">`) + t + keep("</a>") : m;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/__([^_]+)__/g, "<b>$1</b>");
  out = out.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, "$1<i>$2</i>").replace(/(^|[^_\w])_([^_\s][^_]*?)_(?!\w)/g, "$1<i>$2</i>");
  out = out.replace(/~~([^~]+)~~/g, "<s>$1</s>");
  return out.replace(/\u0000(\d+)\u0000/g, (_, i: string) => stash[Number(i)]);
}
const LIST_LINE = /^(\s*)([-*+]|\d+[.)])\s+(?:\[( |x|X)\]\s+)?(.*)$/;
function looksLikeMarkdown(text: string) {
  return /^(#{1,6}\s|\s*[-*+]\s|\s*\d+[.)]\s|>\s?|```|\s*[-*_]{3,}\s*$)/m.test(text) || /\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\s]+\)|`[^`\n]+`/.test(text) || /\|.*\n\s*\|?\s*:?-+:?\s*\|/.test(text);
}
// Markdown tables: "| a | b |" rows under a "| --- | :-: |" delimiter row,
// whose colons set each column's alignment.
const PIPE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const startsPipeTable = (lines: string[], i: number) => lines[i].includes("|") && i + 1 < lines.length && PIPE_SEP.test(lines[i + 1]) && lines[i + 1].includes("|");
export function pipeCells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}
type Align = "center" | "right" | null;
const alignOf = (cell: string): Align => /^:-+:$/.test(cell) ? "center" : /^-+:$/.test(cell) ? "right" : null;
// Cells are inline Markdown, or ready HTML when `raw`.
export function tableHtmlFrom(head: string[] | null, body: string[][], raw = false, aligns: Align[] = []): string {
  const cols = Math.max(head?.length || 0, ...body.map((r) => r.length), 1);
  const html = (s: string | undefined) => raw ? String(s ?? "") : inlineMarkdown(s ?? "").replace(/&lt;br\s*\/?&gt;/gi, "<br>");
  const open = (tag: string, i: number) => aligns[i] ? `<${tag} style="text-align: ${aligns[i]};">` : `<${tag}>`;
  const row = (cells: string[], tag: string) => "<tr>" + Array.from({ length: cols }, (_, i) => `${open(tag, i)}${html(cells[i]).trim() ? html(cells[i]) : "<br>"}</${tag}>`).join("") + "</tr>";
  return "<table>" + (head ? "<thead>" + row(head, "th") + "</thead>" : "") + "<tbody>" + (body.length ? body : [[]]).map((r) => row(r, "td")).join("") + "</tbody></table>";
}
// Tab-separated text (a spreadsheet copied as plain text): every line has
// the same number of columns, at least two.
export function parseTsv(text: string): string[][] | null {
  const t = String(text || "").replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  if (!t.includes("\t")) return null;
  const rows = t.split("\n").map((l) => l.split("\t"));
  const n = rows[0].length;
  return n >= 2 && rows.every((r) => r.length === n) ? rows : null;
}
// A quote of several Markdown blocks: a quote per paragraph, lists and code between.
function quoteHtml(inner: string) {
  const body = new DOMParser().parseFromString(inner, "text/html").body;
  return Array.from(body.children, (b) => b.tagName === "P" || /^H[1-3]$/.test(b.tagName) ? `<blockquote>${b.innerHTML}</blockquote>` : b.outerHTML).join("");
}
export function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  let html = "", i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^`{3,}/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !closesFence(lines[i], fence[0])) body.push(lines[i++]);
      i++;
      html += `<pre>${escapeHtml(body.join("\n")) || "<br>"}</pre>`;
      continue;
    }
    if (!line.trim()) { i++; continue; }
    if (startsPipeTable(lines, i)) {
      const head = pipeCells(line);
      const aligns = pipeCells(lines[i + 1]).map(alignOf);
      const body: string[][] = [];
      for (i += 2; i < lines.length && lines[i].trim() && lines[i].includes("|"); i++) body.push(pipeCells(lines[i]));
      html += tableHtmlFrom(head, body, false, aligns);
      continue;
    }
    let m: RegExpMatchArray | null;
    if (m = line.match(/^(#{1,6})\s+(.*)$/)) { const l = Math.min(3, m[1].length); html += `<h${l}>${inlineMarkdown(m[2])}</h${l}>`; i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { html += "<hr>"; i++; continue; }
    if (/^>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) body.push(lines[i++].replace(/^>\s?/, ""));
      html += quoteHtml(markdownToHtml(body.join("\n")));
      continue;
    }
    if (LIST_LINE.test(line)) {
      const stack: { indent: number; tag: string; kind: string }[] = [];
      while (i < lines.length && (m = lines[i].match(LIST_LINE))) {
        const indent = m[1].replace(/\t/g, "  ").length;
        const tag = /\d/.test(m[2]) ? "ol" : "ul";
        const check = m[3] !== void 0;
        // A to-do item among bullets starts its own (to-do) list, as the
        // editor has no mixed lists.
        const kind = check && tag === "ul" ? "todo" : tag;
        while (stack.length && indent < stack.at(-1)!.indent) html += `</li></${stack.pop()!.tag}>`;
        const top = stack.at(-1);
        if (top && indent === top.indent && top.kind !== kind) { html += `</li></${stack.pop()!.tag}>`; }
        if (!stack.length || indent > stack.at(-1)!.indent) {
          html += `<${tag}${kind === "todo" ? ' class="checklist"' : ""}>`;
          stack.push({ indent, tag, kind });
        } else html += "</li>";
        html += `<li${check && m[3].toLowerCase() === "x" ? ' data-checked="true"' : ""}>${inlineMarkdown(m[4])}`;
        i++;
      }
      while (stack.length) html += `</li></${stack.pop()!.tag}>`;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|>\s?)/.test(lines[i]) && !LIST_LINE.test(lines[i]) && !startsPipeTable(lines, i)) para.push(inlineMarkdown(lines[i++].trim()));
    html += `<p>${para.join("<br>")}</p>`;
  }
  return html;
}
/** Pasted plain text as HTML: a grid, Markdown, or its lines. */
export function textToHtml(text: string | undefined): string {
  const t = String(text || "").replace(/\r\n?/g, "\n");
  const tsv = parseTsv(t);
  if (tsv && tsv.length >= 2) return tableHtmlFrom(null, tsv.map((r) => r.map(escapeHtml)), true);
  if (looksLikeMarkdown(t)) return markdownToHtml(t);
  const lines = t.split("\n");
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  if (lines.length === 1) return escapeHtml(lines[0]);
  return lines.map((l) => `<p>${l ? escapeHtml(l) : "<br>"}</p>`).join("");
}
