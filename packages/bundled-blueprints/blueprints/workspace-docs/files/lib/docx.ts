// ─────────────────────────────────────────────────────────────────────────────
// Word export: the persisted document (block HTML + shared settings) as a
// native .docx package.
//
// The stored blocks are the editor's own HTML, so the export reads them the way
// the page renders them rather than through Markdown: headings, paragraphs with
// their alignment and indentation, inline formatting and palette colours,
// links, nested bulleted / numbered / to-do lists (native Word numbering and
// clickable checkboxes), quotes, code blocks, dividers, embedded images at
// their on-page size, and tables with their column widths and header row. The
// look mirrors the editor's stylesheet (typeface, sizes, spacing, colours) on a
// US Letter page.
//
// Sections:
//   1. Limits, units & XML helpers
//   2. HTML parsing (a small tolerant parser: the input is stored block HTML,
//      which the server has put through stripUnsafe)
//   3. Inline formatting (CSS / tags / palette classes -> run properties)
//   4. Blocks -> WordprocessingML (paragraphs, lists, tables, images)
//   5. Package parts (styles, numbering, settings, properties) and the entry point
// ─────────────────────────────────────────────────────────────────────────────

import { type ZipEntry, createZip } from "@gadgets/bundled-blueprints/libraries/zip/server";

/* ═══════════════════════ 1. Limits, units & XML ════════════════════════════ */

/** What one export may hold; past these it fails with a message rather than exhausting memory. */
export const DOCX_LIMITS = Object.freeze({
  blocks: 20000,
  htmlCharacters: 64 * 1024 * 1024,
  nodes: 400000,
  depth: 200,
  images: 500,
  imageBytes: 16 * 1024 * 1024,
  totalImageBytes: 96 * 1024 * 1024,
  hyperlinks: 10000,
  tableCells: 400000,
});

export const DOCX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** The parts of a stored document the export reads. */
export interface DocxSource {
  /** The blocks in order, or `null` for a document from before blocks (then `legacyContent` is read). */
  blocks?: { html: string }[] | null;
  /** A document from before blocks: one HTML string. */
  legacyContent?: string;
  lastModified?: number | null;
}

/** The document's shared presentation settings. */
export interface DocxSettings {
  font?: string;
  wide?: boolean;
}

// US Letter, 1in margins: the content box is 6.5in wide.
const PAGE = { w: 12240, h: 15840, margin: 1440 };
const CONTENT_TWIPS = PAGE.w - 2 * PAGE.margin;
const CONTENT_HEIGHT_TWIPS = PAGE.h - 2 * PAGE.margin;
const EMU_PER_TWIP = 635;
// The editor's measure (column width) in CSS px, normal and "full width". An
// image's on-page width is a share of the measure, and keeps that share of the
// Word page's content width.
const MEASURE_PX = { normal: 700, wide: 980 };

interface Typeface {
  font: string;
  size: number;
  line: number;
}

// The three shared typefaces (settings.font), mirroring the editor's
// --doc-font / --doc-size / --doc-lh: the editor's 16px sans body maps to 11pt.
const TYPEFACES: Record<"sans" | "serif" | "mono", Typeface> = {
  sans: { font: "Arial", size: 11, line: 1.65 },
  serif: { font: "Georgia", size: 12, line: 1.6 },
  mono: { font: "Courier New", size: 10, line: 1.7 },
};
// Courier New: the monospace face Word, Google Docs, LibreOffice and Apple's readers all have.
const MONO_FONT = "Courier New";

// A CSS line-height as a Word "multiple" line rule (240ths of single
// spacing). Word's single spacing is the font's own line height, about 1.15em
// for these faces, where CSS's 1 is exactly 1em.
const cssLine = (lineHeight: number): number => Math.round(lineHeight / 1.15 * 240);

// Editor colours (light palette; exports always use it).
const INK = "1B1B1F";
const INK_2 = "46464E";
const MUTED = "7B7B84";
const FAINT = "ABABB3";
const ACCENT = "E1632E";
const LINE = "EBEBEC"; //        rgba(24,24,32,.08) on white
const LINE_STRONG = "DADADC"; // rgba(24,24,32,.15) on white
const CODE_BG = "F3F3F4"; //     rgba(24,24,32,.05) on white
const INLINE_CODE_BG = "F0F0F1";
const TABLE_HEAD = "F7F7F8"; //  rgba(24,24,32,.034) on white
const MARK_BG = "FBEFC4";

// The editor's palette (client.ts PALETTE): [text, highlight] in the light theme.
const PALETTE: Record<string, [text: string, highlight: string]> = {
  gray: ["787774", "EBEBE9"],
  brown: ["9F6B53", "F1E5DF"],
  orange: ["D9730D", "FBE4CF"],
  yellow: ["B7891C", "FBEFC4"],
  green: ["448361", "DDEDE3"],
  blue: ["337EA9", "DBEAF5"],
  purple: ["9065B0", "EBE3F3"],
  pink: ["C14C8A", "F6DFEB"],
  red: ["D44C47", "FADEDC"],
};

// Characters XML 1.0 cannot carry become U+FFFD (with the u flag a surrogate
// range matches only unpaired surrogates).
const INVALID_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff￾￿]/gu;
const xmlText = (value: string): string =>
  value.replace(INVALID_XML, "�").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const xmlAttr = (value: string): string => xmlText(value).replace(/"/g, "&quot;");
const clampNumber = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
// Word's font sizes run from 1pt to 1638pt.
const halfPoints = (pt: number): number => clampNumber(Math.round(pt * 2), 2, 3276);

/* ═══════════════════════════ 2. HTML parsing ═══════════════════════════════ */

interface ElementNode {
  tag: string;
  attrs: Record<string, string>;
  children: HtmlNode[];
}
interface TextNode {
  text: string;
}
type HtmlNode = ElementNode | TextNode;

const isElement = (node: HtmlNode): node is ElementNode => "tag" in node;

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
// Content that never renders as document text.
const IGNORED_TAGS = new Set(["head", "title", "meta", "link", "script", "style", "template", "noscript", "iframe", "object", "embed", "svg", "math", "canvas", "audio", "video", "select", "button", "input", "textarea"]);
const RAW_TEXT_TAGS = new Set(["script", "style", "textarea", "title"]);
// An open <p> is closed by any of these starting (the HTML parser's rule).
const CLOSES_P = new Set(["address", "article", "aside", "blockquote", "details", "div", "dl", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "main", "menu", "nav", "ol", "p", "pre", "section", "table", "ul"]);
// Opening one of these implicitly closes an open sibling of the listed tags,
// stopping at the given boundary elements.
const IMPLIED_END: Record<string, { close: string[]; stop: string[] }> = {
  li: { close: ["li"], stop: ["ul", "ol", "menu"] },
  dt: { close: ["dt", "dd"], stop: ["dl"] },
  dd: { close: ["dt", "dd"], stop: ["dl"] },
  tr: { close: ["tr", "td", "th"], stop: ["table", "thead", "tbody", "tfoot"] },
  td: { close: ["td", "th"], stop: ["tr", "table"] },
  th: { close: ["td", "th"], stop: ["tr", "table"] },
  thead: { close: ["thead", "tbody", "tfoot", "tr", "td", "th"], stop: ["table"] },
  tbody: { close: ["thead", "tbody", "tfoot", "tr", "td", "th"], stop: ["table"] },
  tfoot: { close: ["thead", "tbody", "tfoot", "tr", "td", "th"], stop: ["table"] },
  option: { close: ["option"], stop: ["select"] },
};

// Named character references: the browser's serializer only writes &amp; &lt;
// &gt; &quot; and &nbsp;, so this covers those plus what hand-written (agent)
// HTML commonly uses. Numeric references are always decoded.
const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", ensp: " ", emsp: " ", thinsp: " ",
  zwsp: "​", zwnj: "‌", zwj: "‍", shy: "­", ndash: "–", mdash: "—", minus: "−",
  hellip: "…", mldr: "…", lsquo: "‘", rsquo: "’", sbquo: "‚", ldquo: "“", rdquo: "”",
  bdquo: "„", laquo: "«", raquo: "»", lsaquo: "‹", rsaquo: "›", prime: "′", Prime: "″",
  bull: "•", middot: "·", sdot: "⋅", times: "×", divide: "÷", plusmn: "±", deg: "°",
  micro: "µ", para: "¶", sect: "§", copy: "©", reg: "®", trade: "™", euro: "€",
  pound: "£", yen: "¥", cent: "¢", curren: "¤", larr: "←", rarr: "→", uarr: "↑",
  darr: "↓", harr: "↔", lArr: "⇐", rArr: "⇒", hArr: "⇔", le: "≤", ge: "≥", ne: "≠",
  asymp: "≈", equiv: "≡", infin: "∞", sum: "∑", prod: "∏", radic: "√", part: "∂",
  frac12: "½", frac14: "¼", frac34: "¾", sup1: "¹", sup2: "²", sup3: "³", ordf: "ª",
  ordm: "º", iexcl: "¡", iquest: "¿", check: "✓", cross: "✗", star: "☆", starf: "★",
  hearts: "♥", spades: "♠", clubs: "♣", diams: "♦", dagger: "†", Dagger: "‡", permil: "‰",
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", lambda: "λ", mu: "μ",
  pi: "π", sigma: "σ", tau: "τ", phi: "φ", omega: "ω", Delta: "Δ", Sigma: "Σ", Omega: "Ω",
  agrave: "à", aacute: "á", acirc: "â", atilde: "ã", auml: "ä", aring: "å", aelig: "æ",
  ccedil: "ç", egrave: "è", eacute: "é", ecirc: "ê", euml: "ë", igrave: "ì", iacute: "í",
  icirc: "î", iuml: "ï", ntilde: "ñ", ograve: "ò", oacute: "ó", ocirc: "ô", otilde: "õ",
  ouml: "ö", oslash: "ø", ugrave: "ù", uacute: "ú", ucirc: "û", uuml: "ü", yacute: "ý",
  yuml: "ÿ", szlig: "ß", Agrave: "À", Aacute: "Á", Acirc: "Â", Atilde: "Ã", Auml: "Ä",
  Aring: "Å", AElig: "Æ", Ccedil: "Ç", Egrave: "È", Eacute: "É", Ecirc: "Ê", Euml: "Ë",
  Igrave: "Ì", Iacute: "Í", Icirc: "Î", Iuml: "Ï", Ntilde: "Ñ", Ograve: "Ò", Oacute: "Ó",
  Ocirc: "Ô", Otilde: "Õ", Ouml: "Ö", Oslash: "Ø", Ugrave: "Ù", Uacute: "Ú", Ucirc: "Û",
  Uuml: "Ü", Yacute: "Ý", oelig: "œ", OElig: "Œ", scaron: "š", Scaron: "Š",
};

function decodeEntities(value: string): string {
  if (!value.includes("&")) return value;
  return value.replace(/&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[A-Za-z][A-Za-z0-9]{1,31});?/g, (match, entity: string) => {
    if (entity[0] === "#") {
      const hex = entity[1] === "x" || entity[1] === "X";
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!(code > 0) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "�";
      return String.fromCodePoint(code);
    }
    return Object.hasOwn(ENTITIES, entity) && match.endsWith(";") ? ENTITIES[entity]! : match;
  });
}

function parseAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of source.matchAll(pattern)) {
    const name = match[1]!.toLowerCase();
    if (!Object.hasOwn(attrs, name)) attrs[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attrs;
}

class ParseBudget {
  nodes = 0;
  take(): void {
    if (++this.nodes > DOCX_LIMITS.nodes) {
      throw new Error(`The document is too large to export as Word (more than ${DOCX_LIMITS.nodes} nodes).`);
    }
  }
}

// Parses an HTML fragment into element and text nodes, with the browser's
// implied-end-tag rules for the elements a document holds.
function parseHtml(html: string, budget: ParseBudget): ElementNode {
  const root: ElementNode = { tag: "#root", attrs: {}, children: [] };
  const stack: ElementNode[] = [root];
  const top = (): ElementNode => stack[stack.length - 1]!;
  const closeTo = (index: number): void => { stack.length = Math.max(1, index); };
  const findOpen = (tag: string, stop: string[] = []): number => {
    for (let i = stack.length - 1; i > 0; i--) {
      if (stack[i]!.tag === tag) return i;
      if (stop.includes(stack[i]!.tag)) return -1;
    }
    return -1;
  };
  let lowered: string | null = null;
  const tokens = /<!--[\s\S]*?(?:-->|$)|<![^>]*>?|<\?[^>]*>?|<\/?[A-Za-z][^\s\/>]*(?:[^>"']|"[^"]*"|'[^']*')*>|[^<]+|</g;
  let match: RegExpExecArray | null;
  while ((match = tokens.exec(html))) {
    const token = match[0];
    if (token[0] !== "<" || token === "<") {
      budget.take();
      top().children.push({ text: decodeEntities(token) });
      continue;
    }
    if (token.startsWith("<!") || token.startsWith("<?")) continue;
    const tag = /^<\/?([A-Za-z][^\s\/>]*)/.exec(token)![1]!.toLowerCase();
    if (token[1] === "/") {
      if (tag === "p" && findOpen("p") < 0) {
        // "</p>" with no open <p> makes an empty paragraph, as in browsers.
        top().children.push({ tag: "p", attrs: {}, children: [] });
      } else if (tag === "br") {
        top().children.push({ tag: "br", attrs: {}, children: [] });
      } else {
        const at = findOpen(tag);
        if (at > 0) closeTo(at);
      }
      continue;
    }
    budget.take();
    if (stack.length > DOCX_LIMITS.depth) throw new Error("The document is nested too deeply to export as Word.");
    const selfClosing = token.endsWith("/>");
    const attrs = parseAttributes(token.slice(tag.length + 1, selfClosing ? -2 : -1));
    if (CLOSES_P.has(tag)) {
      const p = findOpen("p", ["td", "th", "li", "blockquote", "div", "table"]);
      if (p > 0) closeTo(p);
    }
    if (/^h[1-6]$/.test(tag) && /^h[1-6]$/.test(top().tag)) stack.pop();
    const implied = IMPLIED_END[tag];
    if (implied) {
      for (const name of implied.close) {
        const at = findOpen(name, implied.stop);
        if (at > 0) { closeTo(at); break; }
      }
    }
    const node: ElementNode = { tag, attrs, children: [] };
    top().children.push(node);
    if (RAW_TEXT_TAGS.has(tag)) {
      // Skip to the matching end tag; the content is never rendered.
      lowered ??= html.toLowerCase();
      const end = lowered.indexOf("</" + tag, tokens.lastIndex);
      tokens.lastIndex = end < 0 ? html.length : end;
      continue;
    }
    if (!VOID_TAGS.has(tag) && !selfClosing) stack.push(node);
  }
  return root;
}

/* ═════════════════════════ 3. Inline formatting ════════════════════════════ */

/** Run formatting, inherited down the tree and written as <w:rPr>. */
interface RunFormat {
  style?: "Hyperlink" | "InlineCode";
  font?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  caps?: boolean;
  smallCaps?: boolean;
  code?: boolean;
  link?: boolean;
  color?: string;
  shade?: string;
  size?: number;
  vertAlign?: "superscript" | "subscript";
}

const NAMED_COLORS: Record<string, string> = {
  black: "000000", white: "FFFFFF", red: "FF0000", green: "008000", blue: "0000FF", yellow: "FFFF00", orange: "FFA500",
  purple: "800080", gray: "808080", grey: "808080", silver: "C0C0C0", maroon: "800000", navy: "000080", teal: "008080",
  olive: "808000", lime: "00FF00", aqua: "00FFFF", cyan: "00FFFF", fuchsia: "FF00FF", magenta: "FF00FF", pink: "FFC0CB",
  brown: "A52A2A", gold: "FFD700", indigo: "4B0082", violet: "EE82EE", darkgray: "A9A9A9", darkgrey: "A9A9A9",
  lightgray: "D3D3D3", lightgrey: "D3D3D3", darkred: "8B0000", darkgreen: "006400", darkblue: "00008B", crimson: "DC143C",
  coral: "FF7F50", salmon: "FA8072", tomato: "FF6347", khaki: "F0E68C", lavender: "E6E6FA", beige: "F5F5DC",
};

// A CSS colour as RRGGBB, composited over white when translucent; null for
// transparent, inherited or unparseable values.
function cssColor(value: string | undefined): string | null {
  const v = (value ?? "").trim().toLowerCase();
  if (!v || ["transparent", "inherit", "initial", "currentcolor", "unset"].includes(v)) return null;
  if (Object.hasOwn(NAMED_COLORS, v)) return NAMED_COLORS[v]!;
  let rgb: number[];
  let alpha = 1;
  let m = /^#([0-9a-f]{3,8})$/.exec(v);
  if (m) {
    let hex = m[1]!;
    if (hex.length === 3 || hex.length === 4) hex = [...hex].map((c) => c + c).join("");
    if (hex.length !== 6 && hex.length !== 8) return null;
    rgb = [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
    if (hex.length === 8) alpha = Number.parseInt(hex.slice(6, 8), 16) / 255;
  } else if ((m = /^rgba?\(\s*([\d.]+%?)[\s,]+([\d.]+%?)[\s,]+([\d.]+%?)(?:[\s,\/]+([\d.]+%?))?\s*\)$/.exec(v))) {
    const channel = (s: string): number => s.endsWith("%") ? parseFloat(s) * 2.55 : parseFloat(s);
    rgb = [m[1]!, m[2]!, m[3]!].map(channel);
    if (m[4] != null) alpha = m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
  } else {
    return null;
  }
  if (!(alpha > 0)) return null;
  alpha = Math.min(1, alpha);
  return rgb.map((c) => Math.round(clampNumber(c, 0, 255) * alpha + 255 * (1 - alpha)).toString(16).padStart(2, "0"))
    .join("").toUpperCase();
}

function parseStyle(style: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (style ?? "").split(";")) {
    const colon = part.indexOf(":");
    if (colon < 0) continue;
    const name = part.slice(0, colon).trim().toLowerCase();
    const value = part.slice(colon + 1).replace(/!important/i, "").trim();
    if (name && value) out[name] = value;
  }
  return out;
}

// A CSS length in points. `em`, `rem` and `%` resolve against `emPt`; CSS px
// are scaled so the editor's 16px body text lands on the export's body size.
function cssLengthPt(value: string | undefined, emPt: number, basePt: number): number | null {
  const m = /^(-?[\d.]+)(px|pt|em|rem|%|in|cm|mm)?$/.exec((value ?? "").trim().toLowerCase());
  if (!m) return null;
  const n = parseFloat(m[1]!);
  if (!Number.isFinite(n)) return null;
  switch (m[2]) {
    case "pt": return n;
    case "em": case "rem": return n * emPt;
    case "%": return n / 100 * emPt;
    case "in": return n * 72;
    case "cm": return n * 72 / 2.54;
    case "mm": return n * 72 / 25.4;
    default: return n * basePt / 16; // px, and unitless
  }
}

const FONT_SIZE_KEYWORDS: Record<string, number> = {
  "xx-small": 0.6, "x-small": 0.75, small: 0.89, medium: 1, large: 1.2, "x-large": 1.5, "xx-large": 2, "xxx-large": 3, smaller: 0.83, larger: 1.2,
};
// <font size="1".."7">, relative to the body size.
const LEGACY_FONT_SIZES = [0, 0.63, 0.82, 1, 1.13, 1.5, 2, 3];

// The run formatting an element adds to what it inherits.
function inlineFormat(node: ElementNode, fmt: RunFormat, basePt: number): RunFormat {
  const next: RunFormat = { ...fmt };
  switch (node.tag) {
    case "b": case "strong": next.bold = true; break;
    case "i": case "em": case "cite": case "dfn": case "var": next.italic = true; break;
    case "u": case "ins": next.underline = true; break;
    case "s": case "strike": case "del": next.strike = true; break;
    case "code": case "kbd": case "samp": case "tt": next.code = true; break;
    case "sup": next.vertAlign = "superscript"; break;
    case "sub": next.vertAlign = "subscript"; break;
    case "mark": next.shade ??= MARK_BG; break;
    case "small": next.size = (next.size ?? basePt) * 0.85; break;
    case "big": next.size = (next.size ?? basePt) * 1.2; break;
    case "font": {
      const color = cssColor(node.attrs.color);
      if (color) next.color = color;
      const size = Number.parseInt(node.attrs.size ?? "", 10);
      if (size >= 1 && size <= 7) next.size = basePt * LEGACY_FONT_SIZES[size]!;
      if (node.attrs.face) next.font = cleanFontFamily(node.attrs.face);
      break;
    }
  }
  for (const cls of (node.attrs.class ?? "").split(/\s+/)) {
    const tc = /^tc-([a-z]+)$/.exec(cls), hl = /^hl-([a-z]+)$/.exec(cls);
    if (tc) {
      if (Object.hasOwn(PALETTE, tc[1]!)) next.color = PALETTE[tc[1]!]![0];
      else if (tc[1] === "default") delete next.color;
    }
    if (hl) {
      if (Object.hasOwn(PALETTE, hl[1]!)) next.shade = PALETTE[hl[1]!]![1];
      else if (hl[1] === "default") delete next.shade;
    }
  }
  const css = parseStyle(node.attrs.style);
  const color = cssColor(css.color);
  if (color) next.color = color;
  const background = css["background-color"] ?? css.background;
  if (background) {
    const shade = cssColor(background.split(/\s+(?![^(]*\))/)[0]);
    if (shade && shade !== "FFFFFF") next.shade = shade;
    else if (/^(transparent|none)$/i.test(background.trim())) delete next.shade;
  }
  const weight = css["font-weight"];
  if (weight) {
    if (/^(bold|bolder)$/i.test(weight) || Number(weight) >= 600) next.bold = true;
    else if (/^(normal|lighter)$/i.test(weight) || Number(weight) < 600) next.bold = false;
  }
  if (css["font-style"]) next.italic = /italic|oblique/i.test(css["font-style"]);
  const decoration = css["text-decoration"] ?? css["text-decoration-line"];
  if (decoration) {
    if (/underline/i.test(decoration)) next.underline = true;
    if (/line-through/i.test(decoration)) next.strike = true;
    if (/^none$/i.test(decoration.trim())) { next.underline = false; next.strike = false; }
  }
  if (css["vertical-align"] === "super") next.vertAlign = "superscript";
  else if (css["vertical-align"] === "sub") next.vertAlign = "subscript";
  const fontSize = css["font-size"]?.trim().toLowerCase();
  if (fontSize) {
    const current = next.size ?? basePt;
    const keyword = FONT_SIZE_KEYWORDS[fontSize];
    const pt = keyword !== undefined
      ? keyword * (fontSize.endsWith("er") ? current : basePt)
      : cssLengthPt(fontSize, current, basePt);
    if (pt !== null && pt > 0) next.size = clampNumber(pt, 1, 400);
  }
  if (css["font-family"]) next.font = cleanFontFamily(css["font-family"]);
  if (css["text-transform"] === "uppercase") next.caps = true;
  if (css["font-variant"] === "small-caps") next.smallCaps = true;
  return next;
}

// The first family of a CSS font list; generic families map to the export's faces.
function cleanFontFamily(value: string): string | undefined {
  const first = (value.split(",")[0] ?? "").trim().replace(/^["']|["']$/g, "");
  const generic: Record<string, string> = {
    serif: "Georgia", "sans-serif": "Arial", monospace: MONO_FONT, "ui-monospace": MONO_FONT,
    "system-ui": "Arial", "ui-sans-serif": "Arial", "ui-serif": "Georgia",
  };
  return (generic[first.toLowerCase()] ?? first).slice(0, 31) || undefined;
}

// <w:rPr>, children in the schema's order.
function runProperties(fmt: RunFormat): string {
  const parts: string[] = [];
  if (fmt.style) parts.push(`<w:rStyle w:val="${fmt.style}"/>`);
  const font = fmt.code && !fmt.font ? MONO_FONT : fmt.font;
  if (font) parts.push(`<w:rFonts w:ascii="${xmlAttr(font)}" w:hAnsi="${xmlAttr(font)}" w:cs="${xmlAttr(font)}"/>`);
  if (fmt.bold) parts.push("<w:b/><w:bCs/>");
  else if (fmt.bold === false) parts.push(`<w:b w:val="0"/><w:bCs w:val="0"/>`);
  if (fmt.italic) parts.push("<w:i/><w:iCs/>");
  else if (fmt.italic === false) parts.push(`<w:i w:val="0"/><w:iCs w:val="0"/>`);
  if (fmt.caps) parts.push("<w:caps/>");
  if (fmt.smallCaps) parts.push("<w:smallCaps/>");
  if (fmt.strike) parts.push("<w:strike/>");
  if (fmt.color) parts.push(`<w:color w:val="${fmt.color}"/>`);
  if (fmt.size) parts.push(`<w:sz w:val="${halfPoints(fmt.size)}"/><w:szCs w:val="${halfPoints(fmt.size)}"/>`);
  if (fmt.underline) parts.push(`<w:u w:val="single"/>`);
  else if (fmt.underline === false && fmt.link) parts.push(`<w:u w:val="none"/>`);
  if (fmt.shade) parts.push(`<w:shd w:val="clear" w:color="auto" w:fill="${fmt.shade}"/>`);
  if (fmt.vertAlign) parts.push(`<w:vertAlign w:val="${fmt.vertAlign}"/>`);
  return parts.length ? `<w:rPr>${parts.join("")}</w:rPr>` : "";
}

/* ═════════════════════ 4. Blocks -> WordprocessingML ═══════════════════════ */

type ParagraphStyle = "Title" | "Heading1" | "Heading2" | "Heading3" | "Quote" | "ListParagraph" | "TableList" | "Code" |
  "Divider" | "Caption" | "TableText";

const HEADING_STYLE: Record<string, ParagraphStyle> = {
  h1: "Heading1", h2: "Heading2", h3: "Heading3", h4: "Heading3", h5: "Heading3", h6: "Heading3",
};
// Everything else (inline elements, and images, which get a paragraph of their
// own in `paragraph`) is inline content.
const BLOCK_TAGS = new Set(["p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "menu", "li", "blockquote", "pre", "hr", "table", "figure", "figcaption", "section", "article", "header", "footer", "aside", "nav", "main", "address", "details", "summary", "dl", "dt", "dd", "hgroup", "fieldset", "legend", "form", "caption", "thead", "tbody", "tfoot", "tr", "td", "th"]);
const isBlockNode = (node: HtmlNode): node is ElementNode => isElement(node) && BLOCK_TAGS.has(node.tag);
const LIST_TAGS = /^(ul|ol|menu)$/;
// The indentation wrapper Chrome's "indent" command makes: a blockquote whose
// style resets the border and sets a left margin. The editor's CSS draws no
// quote rule for it (`blockquote[style*="margin"]`).
const isIndentWrapper = (node: ElementNode): boolean => node.tag === "blockquote" && /margin/i.test(node.attrs.style ?? "");

function bytesFromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

type ImageType = "png" | "jpeg" | "gif" | "webp";

// Intrinsic pixel size of a PNG / JPEG / GIF / WebP, read from its header.
function imageSize(bytes: Uint8Array, type: ImageType): { w: number; h: number } | null {
  const at = (i: number): number => bytes[i] ?? 0;
  const u16be = (i: number): number => (at(i) << 8) | at(i + 1);
  const u16le = (i: number): number => at(i) | (at(i + 1) << 8);
  const u24le = (i: number): number => at(i) | (at(i + 1) << 8) | (at(i + 2) << 16);
  const u32be = (i: number): number => ((at(i) << 24) | (at(i + 1) << 16) | (at(i + 2) << 8) | at(i + 3)) >>> 0;
  if (type === "png" && bytes.length > 24) return { w: u32be(16), h: u32be(20) };
  if (type === "gif" && bytes.length > 10) return { w: u16le(6), h: u16le(8) };
  if (type === "webp" && bytes.length > 30) {
    const chunk = String.fromCharCode(at(12), at(13), at(14), at(15));
    if (chunk === "VP8 ") return { w: u16le(26) & 0x3fff, h: u16le(28) & 0x3fff };
    if (chunk === "VP8L") {
      return { w: 1 + (((at(22) & 0x3f) << 8) | at(21)), h: 1 + (((at(24) & 0xf) << 10) | (at(23) << 2) | ((at(22) & 0xc0) >> 6)) };
    }
    if (chunk === "VP8X") return { w: 1 + u24le(24), h: 1 + u24le(27) };
  }
  if (type === "jpeg") {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (at(i) !== 0xff) { i++; continue; }
      const marker = at(i + 1);
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      // SOFn (not DHT, JPG or DAC): height then width.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { w: u16be(i + 7), h: u16be(i + 5) };
      }
      i += 2 + u16be(i + 2);
    }
  }
  return null;
}

type ListKind = "bullet" | "check" | "decimal" | "lowerLetter" | "upperLetter" | "lowerRoman" | "upperRoman";

/** One list's numbering: each list restarts its own count. */
interface ListInstance {
  numId: number;
  /** For a numbered list, the number format at its own level. */
  kind: ListKind;
  start: number;
  /** The nesting level the list starts at. */
  level: number;
  /** A bulleted list: the bullet (index into BULLETS) at its own level, and its count of enclosing <ul>s. */
  bullet?: number;
  ulDepth?: number;
  /** A numbered list: its count of enclosing <ol>s. */
  olDepth?: number;
}

/** The lists enclosing a list, which decide its marker as the editor's CSS does. */
interface ListAncestry {
  ul: number;
  ol: number;
  any: number;
}

/**
 * The paragraph context a block inherits: indentation (twips), quote nesting,
 * alignment, list numbering, run formatting, and the width available.
 */
interface BlockState {
  width: number;
  indent?: number;
  quote?: number;
  /** Inside a quote: where its rule is drawn (twips from the margin). */
  quoteRule?: number;
  align?: string | null;
  style?: ParagraphStyle;
  fmt?: RunFormat;
  pre?: boolean;
  checklist?: boolean;
  numbering?: { numId: number; level: number } | null;
  listIndent?: number;
  hanging?: number;
  contextualSpacing?: boolean;
  /** Runs that open the paragraph (a to-do item's checkbox). */
  prefix?: string;
}

/** What `paragraph` writes: style, properties and inherited formatting. */
interface ParagraphOptions {
  style: ParagraphStyle | null;
  fmt: RunFormat;
  pPr: string;
  maxTwips: number;
  pre: boolean;
  prefix: string;
}

/** Inline collection state while one paragraph's runs are built. */
interface InlineContext {
  runs: string[];
  pre: boolean;
  atLineStart: boolean;
  lastSpace: boolean;
  /** In a code block, the column the next character lands in (for expanding tabs). */
  column: number;
  /** The paragraph's text colour, which a link's runs repeat. */
  ink: string;
  maxTwips: number;
  /** Ends the paragraph so far; `image` then writes the picture's own paragraph. */
  flush(): void;
  flushImage(drawing: string): void;
}

interface Relationship {
  id: string;
  type: string;
  target: string;
  external: boolean;
}

interface Media {
  name: string;
  bytes: Uint8Array;
  type: ImageType;
}

const REL_HYPERLINK = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink";
const REL_IMAGE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";
const LINE_BREAK = "<w:r><w:br/></w:r>";
const TABLE_SPACER = `<w:p><w:pPr><w:pStyle w:val="TableSpacer"/></w:pPr></w:p>`;
// A cell's side padding in twips: .72em of the table's .9375em text.
const cellPadX = (basePt: number): number => Math.round(0.72 * 0.9375 * basePt * 20);
const CHECK_HANGING = 360;
const BULLET_HANGING = 300;
const ORDERED_HANGING = 360;
const QUOTE_INDENT = 200;
// A code block's side padding (twips), from the box's edge to its text.
const CODE_PAD_X = 180;
const CODE_PAD_Y = 140;
// A CSS indent (points) in twips, at most the page's width: a larger one would only push the
// text off the page, and past Word's range.
const indentTwips = (pt: number): number => clampNumber(Math.round(pt * 20), 0, CONTENT_TWIPS);
const listLeft = (depth: number): number => 360 + (depth - 1) * 360 + 60;

class DocxWriter {
  readonly face: Typeface;
  readonly basePt: number;
  readonly measurePx: number;
  readonly out: string[] = [];
  readonly relationships: Relationship[] = [];
  readonly media: Media[] = [];
  readonly lists: ListInstance[] = [];
  checkboxes = 0;
  #mediaByUrl = new Map<string, { size: { w: number; h: number }; rel: string }>();
  #hyperlinks = new Map<string, string>();
  #imageBytes = 0;
  #tableCells = 0;
  #nextRel = 10;
  #nextDrawing = 1;

  constructor(settings: DocxSettings) {
    this.face = TYPEFACES[settings.font as keyof typeof TYPEFACES] ?? TYPEFACES.sans;
    this.basePt = this.face.size;
    this.measurePx = settings.wide ? MEASURE_PX.wide : MEASURE_PX.normal;
  }

  #rel(type: string, target: string, external = false): string {
    const id = "rId" + this.#nextRel++;
    this.relationships.push({ id, type, target, external });
    return id;
  }

  #length(value: string | undefined, emPt = this.basePt): number | null {
    return cssLengthPt(value, emPt, this.basePt);
  }

  // ── Inline content ─────────────────────────────────────────────────────────
  // Collects runs into `ctx.runs`, with whitespace collapsed the way the page
  // renders it.
  #inline(node: HtmlNode, fmt: RunFormat, ctx: InlineContext): void {
    if (!isElement(node)) {
      // Zero-width spaces (the editor's caret escapes) and control characters render as nothing.
      let text = node.text.replace(/[​﻿\u0000-\u0008\u000b\u000e-\u001f\u007f]/g, "");
      if (!ctx.pre) {
        text = text.replace(/[ \t\n\r\f]+/g, " ");
        if (text.startsWith(" ") && (ctx.atLineStart || ctx.lastSpace)) text = text.slice(1);
        if (!text) return;
        ctx.lastSpace = text.endsWith(" ");
        ctx.atLineStart = false;
      } else if (!text) {
        return;
      } else {
        text = expandTabs(text, ctx);
      }
      this.#textRun(text.replace(/ /g, " "), fmt, ctx);
      return;
    }
    const tag = node.tag;
    if (IGNORED_TAGS.has(tag) || tag === "wbr") return;
    if (tag === "br") {
      ctx.runs.push(LINE_BREAK);
      ctx.atLineStart = true;
      ctx.lastSpace = false;
      ctx.column = 0;
      return;
    }
    if (tag === "img") { this.#image(node, ctx); return; }
    const next = inlineFormat(node, fmt, this.basePt);
    if (tag === "a") {
      // Only a link Word can follow looks like one; an unsafe href is dropped.
      const href = safeHref(node.attrs.href);
      const before = ctx.runs.length;
      const linkFmt: RunFormat = href ? { ...next, link: true } : next;
      if (href && !linkFmt.style && !fmt.code) linkFmt.style = "Hyperlink";
      // The text colour is written out: Apple's readers paint a link with no
      // colour of its own blue, where the page keeps the text's colour.
      if (href) linkFmt.color ??= ctx.ink;
      for (const child of node.children) this.#inline(child, linkFmt, ctx);
      if (href && ctx.runs.length > before && this.#hyperlinks.size < DOCX_LIMITS.hyperlinks) {
        let id = this.#hyperlinks.get(href);
        if (!id) {
          id = this.#rel(REL_HYPERLINK, href, true);
          this.#hyperlinks.set(href, id);
        }
        const inner = ctx.runs.splice(before).join("");
        ctx.runs.push(`<w:hyperlink r:id="${id}" w:history="1">${inner}</w:hyperlink>`);
      }
      return;
    }
    if (next.code && !fmt.code && !ctx.pre) next.style = "InlineCode";
    for (const child of node.children) this.#inline(child, next, ctx);
  }

  #textRun(text: string, fmt: RunFormat, ctx: InlineContext): void {
    let body = "";
    for (const part of text.split(/(\t|\n)/)) {
      if (part === "\t") body += "<w:tab/>";
      else if (part === "\n") body += "<w:br/>";
      else if (part) body += `<w:t xml:space="preserve">${xmlText(part)}</w:t>`;
    }
    if (body) ctx.runs.push(`<w:r>${runProperties(fmt)}${body}</w:r>`);
  }

  // ── Images ─────────────────────────────────────────────────────────────────
  // An embedded (data URL) PNG / JPEG / GIF / WebP as an inline picture; null
  // for anything that can't be embedded.
  #imageDrawing(node: ElementNode, maxTwips: number): string | null {
    const src = node.attrs.src ?? "";
    const m = /^data:image\/(png|jpe?g|gif|webp);base64,([A-Za-z0-9+/=\s]+)$/i.exec(src);
    if (!m) return null;
    let entry = this.#mediaByUrl.get(src);
    if (!entry) {
      if (this.media.length >= DOCX_LIMITS.images) return null;
      const type = m[1]!.toLowerCase().replace("jpg", "jpeg") as ImageType;
      let bytes: Uint8Array;
      try {
        bytes = bytesFromBase64(m[2]!.replace(/\s+/g, ""));
      } catch {
        return null;
      }
      if (bytes.length > DOCX_LIMITS.imageBytes || this.#imageBytes + bytes.length > DOCX_LIMITS.totalImageBytes) return null;
      const size = imageSize(bytes, type);
      if (!size || !size.w || !size.h) return null;
      this.#imageBytes += bytes.length;
      const name = `image${this.media.length + 1}.${type}`;
      this.media.push({ name, bytes, type });
      entry = { size, rel: this.#rel(REL_IMAGE, "media/" + name) };
      this.#mediaByUrl.set(src, entry);
    }
    // On-page width: the style's px (or the width attribute), as a share of the
    // editor's measure; else the image's natural size.
    const css = parseStyle(node.attrs.style);
    // A size that is not a positive number (`0`, `.px`) says nothing.
    const positive = (n: number): number | null => n > 0 && Number.isFinite(n) ? n : null;
    const px = (v: string | undefined): number | null => {
      const n = /^([\d.]+)(px)?$/.exec((v ?? "").trim());
      return n ? positive(parseFloat(n[1]!)) : null;
    };
    const pctMatch = /^([\d.]+)%$/.exec((css.width ?? "").trim());
    const pct = pctMatch ? positive(parseFloat(pctMatch[1]!)) : null;
    const widthPx = px(css.width) ?? px(node.attrs.width);
    let widthTwips = pct ? CONTENT_TWIPS * clampNumber(pct, 1, 100) / 100
      : (widthPx ?? entry.size.w) / this.measurePx * CONTENT_TWIPS;
    widthTwips = Math.min(widthTwips, maxTwips);
    const heightPx = px(css.height) ?? (css.height ? null : px(node.attrs.height));
    let heightTwips = heightPx && widthPx ? widthTwips * heightPx / widthPx : widthTwips * entry.size.h / entry.size.w;
    if (heightTwips > CONTENT_HEIGHT_TWIPS) {
      widthTwips *= CONTENT_HEIGHT_TWIPS / heightTwips;
      heightTwips = CONTENT_HEIGHT_TWIPS;
    }
    const cx = Math.max(1, Math.round(widthTwips * EMU_PER_TWIP));
    const cy = Math.max(1, Math.round(heightTwips * EMU_PER_TWIP));
    // The page's 6px corner radius, as roundRect's adjustment: a share of the
    // shorter side, where 50000 is a half.
    const radius = 6 / this.measurePx * CONTENT_TWIPS * EMU_PER_TWIP;
    const corner = Math.min(50000, Math.round(radius / Math.min(cx, cy) * 100000));
    const id = this.#nextDrawing++;
    const alt = xmlAttr((node.attrs.alt ?? "").slice(0, 1000));
    return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${id}" name="Picture ${id}" descr="${alt}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${id}" name="Picture ${id}" descr="${alt}"/><pic:cNvPicPr><a:picLocks noChangeAspect="1" noChangeArrowheads="1"/></pic:cNvPicPr></pic:nvPicPr><pic:blipFill><a:blip r:embed="${entry.rel}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr bwMode="auto"><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val ${corner}"/></a:avLst></a:prstGeom><a:ln w="6350"><a:solidFill><a:srgbClr val="${LINE}"/></a:solidFill></a:ln></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
  }

  #image(node: ElementNode, ctx: InlineContext): void {
    const drawing = this.#imageDrawing(node, ctx.maxTwips);
    if (drawing) {
      // Block-level in the editor (img.doc-image is display: block): the
      // picture gets a paragraph of its own, between the text around it.
      if (ctx.runs.length) ctx.flush();
      ctx.flushImage(drawing);
      return;
    }
    const alt = (node.attrs.alt ?? "").trim();
    if (alt) this.#textRun(`[${alt}]`, { italic: true, color: MUTED }, ctx);
  }

  // ── Paragraphs ─────────────────────────────────────────────────────────────
  // Writes one paragraph (or several, when pictures split it) of inline nodes.
  // A list item's marker goes on its first paragraph only (one of its own when
  // a picture comes first); the rest continue the item at its text indent.
  #paragraph(children: HtmlNode[], options: ParagraphOptions): void {
    const { style, fmt, pPr } = options;
    const continued = continuationPPr(pPr);
    let prefix = options.prefix;
    let emitted = false;
    const write = (paragraphStyle: ParagraphStyle | null, props: string, runs: string): void => {
      this.out.push(paragraphXml(paragraphStyle, props, prefix + runs));
      prefix = "";
      emitted = true;
    };
    const ctx: InlineContext = {
      runs: [], pre: options.pre, atLineStart: true, lastSpace: false, column: 0, maxTwips: options.maxTwips,
      ink: style === "Quote" ? INK_2 : style === "Caption" ? MUTED : INK,
      flush() {
        trimTrailingBreaks(this.runs);
        write(style, emitted ? continued : pPr, this.runs.join(""));
        this.runs = [];
        this.atLineStart = true;
        this.lastSpace = false;
        this.column = 0;
      },
      flushImage(drawing) {
        if (!emitted && (prefix || continued !== pPr)) write(style, pPr, "");
        write(style === "Code" ? null : style, imagePPr(pPr), drawing);
      },
    };
    for (const child of children) this.#inline(child, fmt, ctx);
    trimTrailingBreaks(ctx.runs);
    if (ctx.runs.length || !emitted) write(style, emitted ? continued : pPr, ctx.runs.join(""));
  }

  // ── Blocks ─────────────────────────────────────────────────────────────────
  blocks(nodes: HtmlNode[], state: BlockState): void {
    let loose: HtmlNode[] = [];
    // Inline content outside any block (loose text, a top-level image) is a
    // paragraph of its own, as the page lays it out.
    const flushLoose = (): void => {
      const meaningful = loose.some((n) => isElement(n) ? n.tag !== "br" || loose.length > 1 : n.text.replace(/[\s​]+/g, ""));
      if (meaningful) this.#paragraph(loose, this.#paragraphOptions(state, null));
      loose = [];
    };
    for (const node of nodes) {
      if (isElement(node) && IGNORED_TAGS.has(node.tag)) continue;
      if (isBlockNode(node)) {
        flushLoose();
        this.#block(node, state);
      } else if (isElement(node) && node.tag === "img") {
        flushLoose();
        this.#paragraph([node], this.#paragraphOptions(state, null));
      } else {
        loose.push(node);
      }
    }
    flushLoose();
  }

  #paragraphOptions(state: BlockState, node: ElementNode | null,
      { style = state.style ?? null, extraFmt = {} }: { style?: ParagraphStyle | null; extraFmt?: RunFormat } = {}): ParagraphOptions {
    const css = node ? parseStyle(node.attrs.style) : {};
    const align = alignmentOf(css["text-align"] ?? node?.attrs.align) ?? state.align;
    let indent = state.indent ?? 0;
    for (const prop of ["margin-left", "padding-left"]) {
      const pt = this.#length(css[prop]);
      if (pt !== null && pt > 0) indent += indentTwips(pt);
    }
    const firstLine = this.#length(css["text-indent"]);
    const fmt: RunFormat = { ...state.fmt, ...extraFmt, ...(node ? blockLevelFormat(node, this.basePt) : {}) };
    const leftTwips = indent + QUOTE_INDENT * (state.quote ?? 0) + (state.listIndent ?? 0);
    // <w:pPr> children, in the schema's order.
    const pPr: string[] = [];
    if (state.numbering) pPr.push(`<w:numPr><w:ilvl w:val="${state.numbering.level}"/><w:numId w:val="${state.numbering.numId}"/></w:numPr>`);
    if (state.quote) {
      // Word draws the rule its border spacing left of the paragraph's first
      // line, so the spacing puts it at the quote's own x for every paragraph
      // inside (a list item's hangs further out).
      const textX = Math.max(0, leftTwips) - (state.hanging ?? 0);
      const space = clampNumber(Math.round((textX - (state.quoteRule ?? 0)) / 20), 0, 31);
      pPr.push(`<w:pBdr><w:left w:val="single" w:sz="12" w:space="${space}" w:color="${LINE_STRONG}"/></w:pBdr>`);
    }
    // A hanging marker (a number, bullet or to-do checkbox) is followed by a tab to the text's indent.
    if (state.hanging) pPr.push(`<w:tabs><w:tab w:val="left" w:pos="${leftTwips}"/></w:tabs>`);
    const ind: string[] = [];
    if (leftTwips > 0 || state.hanging) ind.push(`w:left="${Math.max(0, leftTwips)}"`);
    if (state.hanging) ind.push(`w:hanging="${state.hanging}"`);
    else if (firstLine) ind.push(firstLine > 0 ? `w:firstLine="${indentTwips(firstLine)}"` : `w:hanging="${indentTwips(-firstLine)}"`);
    if (ind.length) pPr.push(`<w:ind ${ind.join(" ")}/>`);
    if (state.contextualSpacing) pPr.push("<w:contextualSpacing/>");
    if (align) pPr.push(`<w:jc w:val="${align}"/>`);
    return {
      style, fmt, pPr: pPr.join(""),
      maxTwips: Math.max(720, state.width - Math.max(0, leftTwips)),
      pre: state.pre ?? false,
      prefix: state.prefix ?? "",
    };
  }

  #block(node: ElementNode, state: BlockState): void {
    const tag = node.tag;
    const css = parseStyle(node.attrs.style);
    const heading = HEADING_STYLE[tag];
    if (heading) {
      const title = tag === "h1" && /(^|\s)doc-title(\s|$)/.test(node.attrs.class ?? "");
      this.#paragraph(node.children, this.#paragraphOptions(state, node, { style: title ? "Title" : heading }));
      return;
    }
    switch (tag) {
      case "p": case "dt": case "summary": case "legend": case "caption":
        this.#paragraph(node.children, this.#paragraphOptions(state, node, { extraFmt: tag === "dt" || tag === "summary" ? { bold: true } : {} }));
        return;
      case "figcaption":
        this.#paragraph(node.children, this.#paragraphOptions(state, node, { style: "Caption" }));
        return;
      case "hr":
        this.out.push(paragraphXml("Divider", this.#paragraphOptions(state, null).pPr, ""));
        return;
      case "pre":
        this.#code(node, state);
        return;
      case "blockquote": {
        const align = alignmentOf(css["text-align"]) ?? state.align;
        if (isIndentWrapper(node)) {
          const margin = css["margin-left"] ?? (css.margin ?? "").split(/\s+/)[3] ?? "40px";
          const pt = this.#length(margin) ?? 0;
          this.blocks(node.children, { ...state, indent: (state.indent ?? 0) + indentTwips(pt), align });
        } else {
          // The quote's colour is carried in the runs too, so the lists and
          // code inside it (other styles) are muted like the page's.
          const first = this.out.length;
          this.blocks(node.children, {
            ...state, quote: (state.quote ?? 0) + 1, style: "Quote", align,
            quoteRule: (state.indent ?? 0) + QUOTE_INDENT * (state.quote ?? 0) + (state.listIndent ?? 0),
            fmt: { color: INK_2, ...state.fmt, ...blockLevelFormat(node, this.basePt) },
          });
          // A quote isn't split across pages (as in print): its paragraphs
          // keep with the next, the last one ending the chain.
          for (let i = first; i < this.out.length - 1; i++) {
            this.out[i] = withKeepNext(this.out[i]!);
          }
        }
        return;
      }
      case "ul": case "ol": case "menu":
        this.#list(node, state, 0, null, NO_LISTS);
        return;
      case "li":
        // A stray item outside a list reads as a bulleted item.
        this.#list({ tag: "ul", attrs: {}, children: [node] }, state, 0, null, NO_LISTS);
        return;
      case "table":
        this.#table(node, state);
        return;
      case "dd":
        this.blocks(node.children, { ...state, indent: (state.indent ?? 0) + 560 });
        return;
      case "thead": case "tbody": case "tfoot": case "tr": case "td": case "th":
        // Table parts outside a table: their content as plain blocks.
        this.blocks(node.children, state);
        return;
      default: {
        // div, section, figure, …: a container, or a paragraph when it holds only inline content.
        const next: BlockState = {
          ...state,
          align: alignmentOf(css["text-align"] ?? node.attrs.align) ?? state.align,
          fmt: { ...state.fmt, ...blockLevelFormat(node, this.basePt) },
        };
        const margin = this.#length(css["margin-left"] ?? css["padding-left"]);
        if (margin) next.indent = (state.indent ?? 0) + indentTwips(margin);
        if (node.children.some(isBlockNode)) this.blocks(node.children, next);
        else if (node.children.length) this.#paragraph(node.children, this.#paragraphOptions(next, null));
      }
    }
  }

  // ── Code blocks ────────────────────────────────────────────────────────────
  // A code block is a one-cell table, shaded, its cell margins the page's
  // padding. A paragraph's shading and borders (the padding) leave a hairline
  // seam between them in Word for the web, at some zoom on every side; a cell
  // fills evenly. In a quote it stays a paragraph, so the quote's rule runs
  // down its left: there the padding is borders in the box's colour, in
  // whole pixels (6pt and 7.5pt), which keeps the seam out at 100%.
  #code(node: ElementNode, state: BlockState): void {
    if (state.quote) {
      const options = this.#paragraphOptions({ ...state, pre: true }, node, { style: "Code" });
      const side = (name: string, points: number): string => `<w:${name} w:val="single" w:sz="${points * 8}" w:space="0" w:color="${CODE_BG}"/>`;
      options.pPr = withSpacing(options.pPr.replace(/<w:pBdr>(.*?)<\/w:pBdr>/,
        (_, left: string) => `<w:pBdr>${side("top", 6)}${left}${side("bottom", 6)}${side("right", 7.5)}</w:pBdr><w:shd w:val="clear" w:color="auto" w:fill="${CODE_BG}"/>`)
        .replace(/<w:ind /, `<w:ind w:right="${CODE_PAD_X}" `), { before: Math.round(0.6 * this.basePt * 20), after: Math.round(1.2 * this.basePt * 20) });
      this.#paragraph(node.children, options);
      return;
    }
    const leftTwips = (state.indent ?? 0) + (state.listIndent ?? 0);
    const width = Math.max(1440, state.width - leftTwips);
    const tblPr = [`<w:tblStyle w:val="CodeBox"/><w:tblW w:w="${width}" w:type="dxa"/>`];
    if (leftTwips > 0) tblPr.push(`<w:tblInd w:w="${leftTwips}" w:type="dxa"/>`);
    tblPr.push(`<w:tblLayout w:type="fixed"/><w:tblLook w:val="0000" w:firstRow="0" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="1" w:noVBand="1"/>`);
    // Kept whole on a page, as in the PDF (a block taller than a page still breaks).
    this.out.push(`<w:tbl><w:tblPr>${tblPr.join("")}</w:tblPr><w:tblGrid><w:gridCol w:w="${width}"/></w:tblGrid><w:tr><w:trPr><w:cantSplit/></w:trPr><w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="${CODE_BG}"/></w:tcPr>`);
    this.#paragraph(node.children, this.#paragraphOptions({ width: width - 2 * CODE_PAD_X, pre: true, fmt: state.fmt ?? {} }, node, { style: "Code" }));
    // The page's gap below the block (the spacer paragraph's line is 6pt).
    this.out.push("</w:tc></w:tr></w:tbl>", `<w:p><w:pPr><w:pStyle w:val="TableSpacer"/><w:spacing w:after="${Math.max(0, Math.round(1.2 * this.basePt * 20) - 120)}"/></w:pPr></w:p>`);
  }

  // ── Lists ──────────────────────────────────────────────────────────────────
  // Every top-level list gets its own numbering, so numbered lists restart as
  // they do on the page; nested bulleted lists are levels of their parent's.
  // `ancestry` counts the lists around this one, which pick its marker.
  #list(node: ElementNode, state: BlockState, level: number, inherited: ListInstance | null, ancestry: ListAncestry): void {
    const ordered = node.tag === "ol";
    const checklist = /(^|\s)checklist(\s|$)/.test(node.attrs.class ?? "") || !!state.checklist;
    const kind: ListKind = checklist ? "check" : ordered ? orderedKind(node, ancestry.ol) : "bullet";
    let instance = inherited;
    if (!instance || instance.kind !== kind || ordered) {
      const start = Number.parseInt(node.attrs.start ?? "", 10);
      // Word counts from 0 to 32767.
      instance = { numId: this.lists.length + 1, kind, level, start: ordered && Number.isFinite(start) ? clampNumber(start, 0, 32767) : 1 };
      if (kind === "bullet") Object.assign(instance, { bullet: bulletIndex(ancestry), ulDepth: ancestry.ul });
      if (ordered) instance.olDepth = ancestry.ol;
      this.lists.push(instance);
    }
    const inner: ListAncestry = { ul: ancestry.ul + (ordered ? 0 : 1), ol: ancestry.ol + (ordered ? 1 : 0), any: ancestry.any + 1 };
    const before = this.out.length;
    for (const item of node.children) {
      if (!isElement(item)) {
        if (item.text.trim()) this.#paragraph([item], this.#paragraphOptions({ ...state, listIndent: listLeft(level + 1) }, null));
        continue;
      }
      if (LIST_TAGS.test(item.tag)) {
        // A list straight inside a list (how the browser indents an item):
        // a bulleted one continues this list's bullets a level down.
        const sameBullets = instance.kind === "bullet" && item.tag !== "ol" && !/checklist/.test(item.attrs.class ?? "");
        this.#list(item, { ...state, checklist: checklist || undefined }, level + 1, sameBullets ? instance : null, inner);
        continue;
      }
      if (item.tag !== "li") continue;
      // The item's own line is its leading inline content; lists and blocks follow it.
      const inline: HtmlNode[] = [], nested: ElementNode[] = [];
      for (const child of item.children) {
        if (nested.length || isBlockNode(child)) {
          if (isElement(child)) nested.push(child);
          else if (child.text.trim()) nested.push({ tag: "p", attrs: {}, children: [child] });
        } else {
          inline.push(child);
        }
      }
      const checked = checklist && item.attrs["data-checked"] === "true";
      const itemState: BlockState = {
        ...state,
        fmt: { ...state.fmt, ...blockLevelFormat(item, this.basePt), ...(checked ? { strike: true, color: MUTED } : {}) },
        // In a table cell, a list keeps the cell's smaller text.
        style: state.style === "TableText" ? "TableList" : "ListParagraph",
        align: alignmentOf(parseStyle(item.attrs.style)["text-align"]) ?? state.align,
        numbering: checklist ? null : { numId: instance.numId, level: Math.min(level, 8) },
        // The indent is written out even for numbered items (it matches the
        // numbering level's), so an enclosing quote or indent adds to it
        // rather than replacing it.
        listIndent: listLeft(level + 1),
        hanging: checklist ? CHECK_HANGING : ordered ? ORDERED_HANGING : BULLET_HANGING,
        contextualSpacing: true,
        // A to-do item's checkbox hangs in the indent, like the page's box.
        prefix: checklist ? this.#checkbox(checked) : "",
      };
      // An item whose first content is a paragraph (`<li><p>…`) takes that as its line.
      const hasInline = inline.some((n) => isElement(n) || n.text.trim());
      const leading = !hasInline && nested[0] && /^(p|div|h[1-6])$/.test(nested[0].tag) ? nested.shift()! : null;
      // A heading there keeps its heading style (and its place in the outline), as on the page.
      const leadingHeading = leading ? HEADING_STYLE[leading.tag] : undefined;
      if (leading && leadingHeading && itemState.numbering) {
        // Word draws the number in the paragraph mark's formatting, which is
        // the heading's; the page's marker is the item's: body size, plain
        // and muted (`li::marker`).
        const options = this.#paragraphOptions(itemState, leading, { style: leadingHeading });
        const body = halfPoints(this.basePt * (state.style === "TableText" ? 0.9375 : 1));
        options.pPr += `<w:rPr><w:b w:val="0"/><w:bCs w:val="0"/><w:color w:val="${MUTED}"/><w:sz w:val="${body}"/><w:szCs w:val="${body}"/></w:rPr>`;
        this.#paragraph(leading.children, options);
      } else if (leading) this.#paragraph(leading.children, this.#paragraphOptions(itemState, leading, leadingHeading ? { style: leadingHeading } : {}));
      else this.#paragraph(inline, this.#paragraphOptions(itemState, null));
      for (const child of nested) {
        if (LIST_TAGS.test(child.tag)) {
          const sameBullets = instance.kind === "bullet" && child.tag !== "ol" && !/checklist/.test(child.attrs.class ?? "");
          // A to-do list inside an item starts past the item's own text
          // indent (its padding, 1.7em, plus the list's 1.6em), where one
          // straight inside the list (Tab's) is a level in: 1.6em.
          const indent = checklist ? (state.indent ?? 0) + Math.round(3.3 * this.basePt * 20) - (listLeft(2) - listLeft(1)) : state.indent;
          this.#list(child, { ...state, indent, checklist: checklist || undefined }, level + 1, sameBullets ? instance : null, inner);
        } else {
          this.blocks([child], { ...state, listIndent: listLeft(level + 1), contextualSpacing: true });
        }
      }
    }
    // The page keeps a list's bottom margin (.8em) from what follows, another
    // list included; its items are spaced tightly (contextual spacing), so the
    // last one, which leaves that off, also drops its space before (unless it
    // is a picture, which keeps its margin).
    const last = this.out.length - 1;
    if (!ancestry.any && last >= before && this.out[last]!.startsWith("<w:p>")) {
      const picture = this.out[last]!.includes("<w:drawing>");
      this.out[last] = paragraphWithSpacing(this.out[last]!, { ...(picture ? {} : { before: 0 }), after: Math.round(0.8 * this.basePt * 20) }, true);
    }
  }

  // A clickable Word checkbox (a content control), and the tab to the item's text.
  #checkbox(checked: boolean): string {
    const id = ++this.checkboxes;
    const glyph = checked ? "☒" : "☐";
    const rPr = `<w:rPr><w:rFonts w:ascii="MS Gothic" w:eastAsia="MS Gothic" w:hAnsi="MS Gothic" w:cs="Segoe UI Symbol"/><w:color w:val="${checked ? ACCENT : FAINT}"/></w:rPr>`;
    return `<w:sdt><w:sdtPr>${rPr}<w:id w:val="${id}"/><w14:checkbox><w14:checked w14:val="${checked ? 1 : 0}"/><w14:checkedState w14:val="2612" w14:font="MS Gothic"/><w14:uncheckedState w14:val="2610" w14:font="MS Gothic"/></w14:checkbox></w:sdtPr><w:sdtContent><w:r>${rPr}<w:t>${glyph}</w:t></w:r></w:sdtContent></w:sdt><w:r><w:tab/></w:r>`;
  }

  // ── Tables ─────────────────────────────────────────────────────────────────
  #table(node: ElementNode, state: BlockState): void {
    const rows: { node: ElementNode; header: boolean }[] = [];
    const cols: ElementNode[] = [];
    const visit = (parent: ElementNode, section: string): void => {
      for (const child of parent.children) {
        if (!isElement(child)) continue;
        if (child.tag === "tr") rows.push({ node: child, header: section === "thead" });
        else if (/^(thead|tbody|tfoot)$/.test(child.tag)) visit(child, child.tag);
        else if (child.tag === "colgroup") cols.push(...child.children.filter((c): c is ElementNode => isElement(c) && c.tag === "col"));
        else if (child.tag === "col") cols.push(child);
      }
    };
    visit(node, "tbody");
    if (!rows.length) return;
    // The editor never writes spans; agent HTML may.
    const grid = rows.map((row) => row.node.children.filter((c): c is ElementNode => isElement(c) && (c.tag === "td" || c.tag === "th")));
    const columnCount = Math.max(tableColumns(grid), 1, cols.length);
    // Every row is written out to the full width, so spans could multiply a few cells into millions.
    this.#tableCells += rows.length * columnCount;
    if (this.#tableCells > DOCX_LIMITS.tableCells) {
      throw new Error(`The document's tables are too large to export as Word (more than ${DOCX_LIMITS.tableCells} cells).`);
    }
    const leftTwips = (state.indent ?? 0) + (state.listIndent ?? 0) + QUOTE_INDENT * (state.quote ?? 0);
    const width = Math.max(1440, state.width - leftTwips);
    // Column widths: <col style="width:%"> shares, else even.
    const declared = Array.from({ length: columnCount }, (_, i) => {
      const w = parseStyle(cols[i]?.attrs.style).width ?? cols[i]?.attrs.width;
      const m = /^([\d.]+)\s*(%|px)?$/.exec((w ?? "").trim());
      return m ? parseFloat(m[1]!) : 0;
    });
    const known = declared.filter((s) => s > 0);
    const fallback = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 1;
    const shares = declared.map((s) => s > 0 ? s : fallback);
    const total = shares.reduce((a, b) => a + b, 0);
    const widths = shares.map((s) => Math.max(240, Math.round(s / total * width)));
    // Header rows: the <thead>'s, else a first row made only of <th> cells.
    let headerRows = rows.filter((row) => row.header).length;
    if (!headerRows && grid[0]!.length && grid[0]!.every((c) => c.tag === "th")) headerRows = 1;
    const css = parseStyle(node.attrs.style);
    const tblPr = [`<w:tblStyle w:val="DocTable"/><w:tblW w:w="${widths.reduce((a, b) => a + b, 0)}" w:type="dxa"/>`];
    if (css["margin-left"] === "auto" && css["margin-right"] === "auto") tblPr.push(`<w:jc w:val="center"/>`);
    if (leftTwips > 0) tblPr.push(`<w:tblInd w:w="${leftTwips}" w:type="dxa"/>`);
    tblPr.push(`<w:tblLayout w:type="fixed"/><w:tblLook w:val="${headerRows ? "0420" : "0400"}" w:firstRow="${headerRows ? 1 : 0}" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="1" w:noVBand="1"/>`);
    this.out.push(`<w:tbl><w:tblPr>${tblPr.join("")}</w:tblPr><w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join("")}</w:tblGrid>`);
    // Row spans: a cell continues down its columns as vMerge "continue" cells.
    const carry: { remaining: number; width: number; span: number }[] = [];
    rows.forEach((_, r) => {
      const isHeaderRow = r < headerRows;
      // Rows never split across pages, as in the PDF, and the header rows
      // repeat at the top of each page a table runs onto.
      this.out.push(`<w:tr><w:trPr><w:cantSplit/>${isHeaderRow ? "<w:tblHeader/>" : ""}</w:trPr>`);
      const cells = grid[r]!;
      let ci = 0;
      for (let col = 0; col < columnCount;) {
        const continued = carry[col];
        if (continued && continued.remaining > 0) {
          continued.remaining--;
          this.out.push(`<w:tc><w:tcPr><w:tcW w:w="${continued.width}" w:type="dxa"/>${continued.span > 1 ? `<w:gridSpan w:val="${continued.span}"/>` : ""}<w:vMerge/></w:tcPr><w:p/></w:tc>`);
          col += continued.span;
          continue;
        }
        const cell = cells[ci++];
        if (!cell) {
          // Short rows are padded, as on the page.
          this.out.push(`<w:tc><w:tcPr><w:tcW w:w="${widths[col]}" w:type="dxa"/></w:tcPr><w:p/></w:tc>`);
          col++;
          continue;
        }
        const span = Math.min(spanOf(cell, "colspan"), columnCount - col);
        const rowSpan = Math.min(spanOf(cell, "rowspan"), rows.length - r);
        const cellWidth = widths.slice(col, col + span).reduce((a, b) => a + b, 0);
        if (rowSpan > 1) carry[col] = { remaining: rowSpan - 1, width: cellWidth, span };
        const cellCss = parseStyle(cell.attrs.style);
        const tcPr = [`<w:tcW w:w="${cellWidth}" w:type="dxa"/>`];
        if (span > 1) tcPr.push(`<w:gridSpan w:val="${span}"/>`);
        if (rowSpan > 1) tcPr.push(`<w:vMerge w:val="restart"/>`);
        const fill = cssColor(cellCss["background-color"] ?? cellCss.background) ?? (isHeaderRow ? TABLE_HEAD : null);
        if (fill) tcPr.push(`<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>`);
        const valign = ({ middle: "center", bottom: "bottom" } as Record<string, string>)[(cellCss["vertical-align"] ?? cell.attrs.valign ?? "").toLowerCase()];
        if (valign) tcPr.push(`<w:vAlign w:val="${valign}"/>`);
        this.out.push(`<w:tc><w:tcPr>${tcPr.join("")}</w:tcPr>`);
        const before = this.out.length;
        this.blocks(cell.children, {
          width: cellWidth - 2 * cellPadX(this.basePt),
          align: alignmentOf(cellCss["text-align"] ?? cell.attrs.align),
          fmt: { ...(cell.tag === "th" || isHeaderRow ? { bold: true } : {}), ...blockLevelFormat(cell, this.basePt) },
          style: "TableText",
        });
        // A cell must hold at least one paragraph.
        if (this.out.length === before) this.out.push(paragraphXml("TableText", "", ""));
        // Nor does a cell's last block keep its bottom margin (`td > :last-child`).
        else if (this.out[this.out.length - 1]!.startsWith("<w:p>")) this.out[this.out.length - 1] = paragraphWithSpacing(this.out[this.out.length - 1]!, { after: 0 });
        this.out.push("</w:tc>");
        col += span;
      }
      this.out.push("</w:tr>");
    });
    // Word needs a paragraph after a table (in a cell too), or merges it with the next.
    this.out.push("</w:tbl>", TABLE_SPACER);
  }
}

// The columns a table's cells fill: a row's cells start after the columns that
// cells above still span down into. Stops counting once the table is past the
// export's cell limit, which the caller then refuses.
function tableColumns(grid: ElementNode[][]): number {
  const covered: number[] = []; // per column, the rows a cell above still covers
  let most = 0;
  for (const cells of grid) {
    let col = 0;
    for (const cell of cells) {
      while (covered[col]! > 0) col++;
      const span = spanOf(cell, "colspan"), down = spanOf(cell, "rowspan");
      for (let k = 0; k < span; k++) covered[col + k] = down;
      col += span;
      most = Math.max(most, col);
      if (most * grid.length > DOCX_LIMITS.tableCells) return most;
    }
    for (let k = 0; k < covered.length; k++) if (covered[k]! > 0) covered[k] = covered[k]! - 1;
  }
  return most;
}
function spanOf(cell: ElementNode, name: "colspan" | "rowspan"): number {
  const n = Number.parseInt(cell.attrs[name] ?? "", 10);
  return Number.isFinite(n) && n > 1 ? Math.min(n, 1000) : 1;
}

const NO_LISTS: ListAncestry = { ul: 0, ol: 0, any: 0 };

// A numbered list's format, as the editor's CSS gives it: an inline
// list-style-type wins; else a top-level list takes its type attribute, and a
// list inside one or more numbered lists is lower-alpha, then lower-roman
// (`ol ol`, `ol ol ol`) however deep it goes.
function orderedKind(node: ElementNode, olDepth: number): ListKind {
  const css = parseStyle(node.attrs.style)["list-style-type"];
  const type = olDepth ? undefined : node.attrs.type;
  if (type === "a" || css === "lower-alpha" || css === "lower-latin") return "lowerLetter";
  if (type === "A" || css === "upper-alpha" || css === "upper-latin") return "upperLetter";
  if (type === "i" || css === "lower-roman") return "lowerRoman";
  if (type === "I" || css === "upper-roman") return "upperRoman";
  if (css === "decimal" || !olDepth) return "decimal";
  return olDepth === 1 ? "lowerLetter" : "lowerRoman";
}

// A bulleted list's marker (index into BULLETS): the editor's CSS makes a
// list inside one <ul> circle and inside two or more square (`ul ul`,
// `ul ul ul`); otherwise the browser's own rule applies, counting enclosing
// lists of either kind.
function bulletIndex(ancestry: ListAncestry): number {
  return Math.min(2, ancestry.ul || ancestry.any);
}

function alignmentOf(value: string | undefined): string | null {
  const align: Record<string, string> = { center: "center", right: "right", end: "right", justify: "both" };
  return align[(value ?? "").trim().toLowerCase()] ?? null;
}

// Run formatting a block element applies to its content (its style attribute and classes).
function blockLevelFormat(node: ElementNode, basePt: number): RunFormat {
  return inlineFormat({ tag: "span", attrs: { style: node.attrs.style ?? "", class: node.attrs.class ?? "" }, children: [] }, {}, basePt);
}

function paragraphXml(style: ParagraphStyle | null, pPr: string, runs: string): string {
  const props = (style ? `<w:pStyle w:val="${style}"/>` : "") + pPr;
  return `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ""}${runs}</w:p>`;
}

// The paragraph properties for the rest of a list item: no marker and no hanging indent.
function continuationPPr(pPr: string): string {
  return pPr.replace(/<w:numPr>.*?<\/w:numPr>|<w:tabs>.*?<\/w:tabs>/g, "").replace(/ w:hanging="\d+"/g, "").replace(/<w:ind\/>/, "");
}

// A picture's paragraph keeps the block's left indentation (a list item's text
// indent, a quote's rule) but not its marker, hanging indent or alignment: the
// page's picture is a block of its own, at the left of the text column, under
// the item's text. Nor its line spacing, which would clip the picture to one
// line's height.
function imagePPr(pPr: string): string {
  const props = pPr.replace(/<w:numPr>.*?<\/w:numPr>|<w:tabs>.*?<\/w:tabs>|<w:jc [^>]*\/>|<w:contextualSpacing\/>/g, "")
    .replace(/ w:(hanging|firstLine)="\d+"/g, "").replace(/<w:ind\/>/, "");
  return withSpacing(props, { before: 160, after: 160, line: 240, lineRule: "auto" });
}

// <w:pPr> children with the given <w:spacing> attributes merged in, at the
// schema's position (after tabs, before ind / contextualSpacing / jc / rPr).
function withSpacing(pPr: string, attrs: Record<string, string | number>): string {
  const merged: Record<string, string> = {};
  const existing = /<w:spacing ([^>]*)\/>/.exec(pPr);
  for (const m of (existing?.[1] ?? "").matchAll(/w:(\w+)="([^"]*)"/g)) merged[m[1]!] = m[2]!;
  for (const [name, value] of Object.entries(attrs)) merged[name] = String(value);
  const spacing = `<w:spacing ${Object.entries(merged).map(([name, value]) => `w:${name}="${value}"`).join(" ")}/>`;
  const rest = pPr.replace(/<w:spacing [^>]*\/>/, "");
  const at = rest.search(/<w:(ind|contextualSpacing|jc|rPr)\b/);
  return at < 0 ? rest + spacing : rest.slice(0, at) + spacing + rest.slice(at);
}

// A written paragraph with spacing attributes merged in; `separate` also turns
// off its style's contextual spacing, so the spacing holds next to a
// paragraph of the same style (the next list).
function paragraphWithSpacing(xml: string, attrs: Record<string, string | number>, separate = false): string {
  const m = /^<w:p>(?:<w:pPr>(.*?)<\/w:pPr>)?/.exec(xml);
  if (!m) return xml;
  let props = withSpacing(m[1] ?? "", attrs);
  if (separate) {
    props = props.replace(/<w:contextualSpacing\/>/, "");
    const at = props.search(/<w:(jc|rPr)\b/);
    const off = `<w:contextualSpacing w:val="0"/>`;
    props = at < 0 ? props + off : props.slice(0, at) + off + props.slice(at);
  }
  return `<w:p><w:pPr>${props}</w:pPr>` + xml.slice(m[0].length);
}

// A written paragraph that keeps with the next one (others pass through).
function withKeepNext(xml: string): string {
  if (!xml.startsWith("<w:p>") || xml.includes("<w:keepNext/>")) return xml;
  if (!xml.startsWith("<w:p><w:pPr>")) return "<w:p><w:pPr><w:keepNext/></w:pPr>" + xml.slice(5);
  return xml.replace(/^<w:p><w:pPr>(<w:pStyle [^>]*\/>)?/, (_, style = "") => `<w:p><w:pPr>${style}<w:keepNext/>`);
}

// A code block's tabs, as the page shows them (tab-size: 2): spaces to the
// next stop, since Word's tab stops are half an inch apart.
function expandTabs(text: string, ctx: InlineContext): string {
  let out = "";
  for (const ch of text) {
    if (ch === "\t") {
      const spaces = 2 - (ctx.column % 2);
      out += " ".repeat(spaces);
      ctx.column += spaces;
    } else {
      out += ch;
      ctx.column = ch === "\n" ? 0 : ctx.column + 1;
    }
  }
  return out;
}

// The page shows nothing for a <br> that ends a block (it only gives an empty
// line its height), so neither does the export.
function trimTrailingBreaks(runs: string[]): void {
  while (runs[runs.length - 1] === LINE_BREAK) runs.pop();
}

function safeHref(href: string | undefined): string | null {
  const value = (href ?? "").trim();
  if (/^(https?:|mailto:|tel:)/i.test(value)) {
    try {
      return new URL(value).href;
    } catch {
      return /^(mailto:|tel:)/i.test(value) ? value : null;
    }
  }
  if (/^www\./i.test(value)) return "https://" + value;
  return null;
}

/* ═════════════════ 5. Package parts and the entry point ════════════════════ */

const XML_HEAD = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`;
const W_NS = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;
const DOC_NS = `xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" mc:Ignorable="w14"`;

// Paragraph and character styles mirroring the editor's stylesheet.
function stylesXml(face: Typeface): string {
  const base = face.size;
  const font = face.font;
  const mono = face === TYPEFACES.mono;
  const pt = (em: number): number => halfPoints(base * em);
  const twips = (em: number, size = base): number => Math.round(em * size * 20);
  const fonts = (name: string): string => `<w:rFonts w:ascii="${name}" w:eastAsia="${name}" w:hAnsi="${name}" w:cs="${name}"/>`;
  const size = (halves: number): string => `<w:sz w:val="${halves}"/><w:szCs w:val="${halves}"/>`;
  const heading = (id: string, name: string, level: number, em: number, before: number, after: number, line: number): string =>
    `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="${twips(before, base * em)}" w:after="${twips(after, base * em)}" w:line="${cssLine(line)}" w:lineRule="auto"/><w:outlineLvl w:val="${level}"/></w:pPr><w:rPr><w:b/><w:bCs/><w:color w:val="${INK}"/><w:spacing w:val="${Math.round(-0.02 * base * em * 20)}"/>${size(pt(em))}</w:rPr></w:style>`;
  const tableBorder = (side: string, sz: number, color: string): string => `<w:${side} w:val="single" w:sz="${sz}" w:space="0" w:color="${color}"/>`;
  const cellPadY = twips(0.42, base * 0.9375);
  return XML_HEAD + `<w:styles ${W_NS}>` +
    `<w:docDefaults><w:rPrDefault><w:rPr>${fonts(font)}<w:color w:val="${INK}"/>${size(pt(1))}<w:lang w:val="en-US" w:eastAsia="en-US" w:bidi="ar-SA"/></w:rPr></w:rPrDefault>` +
    `<w:pPrDefault><w:pPr><w:spacing w:after="${twips(0.8)}" w:line="${cssLine(face.line)}" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>` +
    // The font is repeated on Normal: some readers (Apple's) ignore docDefaults' fonts.
    `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:rPr>${fonts(font)}</w:rPr></w:style>` +
    `<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/><w:unhideWhenUsed/></w:style>` +
    `<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>` +
    `<w:style w:type="numbering" w:default="1" w:styleId="NoList"><w:name w:val="No List"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/></w:style>` +
    `<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="10"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="0" w:after="${twips(0.3, base * 2.3)}" w:line="270" w:lineRule="auto"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:bCs/><w:color w:val="${INK}"/><w:spacing w:val="${Math.round(-0.028 * base * 2.3 * 20)}"/><w:kern w:val="28"/>${size(pt(2.3))}</w:rPr></w:style>` +
    heading("Heading1", "heading 1", 0, 1.875, 1.5, 0.42, 1.22) +
    heading("Heading2", "heading 2", 1, 1.4, 1.45, 0.38, 1.3) +
    heading("Heading3", "heading 3", 2, 1.15, 1.3, 0.3, 1.4) +
    `<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="29"/><w:qFormat/><w:pPr><w:keepLines/><w:spacing w:after="${twips(0.4)}"/><w:ind w:left="${twips(1)}"/></w:pPr><w:rPr><w:color w:val="${INK_2}"/></w:rPr></w:style>` +
    `<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="34"/><w:qFormat/><w:pPr><w:spacing w:before="${twips(0.22)}" w:after="${twips(0.22)}"/><w:contextualSpacing/></w:pPr></w:style>` +
    `<w:style w:type="paragraph" w:styleId="TableList"><w:name w:val="Table List"/><w:basedOn w:val="TableText"/><w:uiPriority w:val="41"/><w:pPr><w:spacing w:before="${twips(0.22, base * 0.9375)}" w:after="${twips(0.22, base * 0.9375)}"/><w:contextualSpacing/></w:pPr></w:style>` +
    `<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code Block"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="39"/><w:qFormat/><w:pPr><w:keepLines/><w:spacing w:before="0" w:after="0" w:line="${cssLine(1.6)}" w:lineRule="auto"/></w:pPr><w:rPr>${fonts(MONO_FONT)}<w:noProof/>${size(halfPoints(base * 13.5 / 16 * (mono ? 1.1 : 1)))}</w:rPr></w:style>` +
    `<w:style w:type="table" w:styleId="CodeBox"><w:name w:val="Code Box"/><w:basedOn w:val="TableNormal"/><w:uiPriority w:val="39"/><w:tblPr><w:tblCellMar><w:top w:w="${CODE_PAD_Y}" w:type="dxa"/><w:left w:w="${CODE_PAD_X}" w:type="dxa"/><w:bottom w:w="${CODE_PAD_Y}" w:type="dxa"/><w:right w:w="${CODE_PAD_X}" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>` +
    `<w:style w:type="paragraph" w:styleId="Divider"><w:name w:val="Divider"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="40"/><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="${LINE_STRONG}"/></w:pBdr><w:spacing w:before="${twips(1.4)}" w:after="${twips(2)}" w:line="120" w:lineRule="exact"/></w:pPr><w:rPr>${size(8)}</w:rPr></w:style>` +
    `<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="35"/><w:unhideWhenUsed/><w:qFormat/><w:pPr><w:spacing w:after="${twips(0.8)}"/></w:pPr><w:rPr><w:color w:val="${MUTED}"/>${size(pt(0.85))}</w:rPr></w:style>` +
    `<w:style w:type="paragraph" w:styleId="TableText"><w:name w:val="Table Text"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="41"/><w:qFormat/><w:pPr><w:spacing w:before="0" w:after="0" w:line="${cssLine(1.5)}" w:lineRule="auto"/></w:pPr><w:rPr>${size(pt(0.9375))}</w:rPr></w:style>` +
    `<w:style w:type="paragraph" w:styleId="TableSpacer"><w:name w:val="Table Spacer"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="42"/><w:semiHidden/><w:pPr><w:spacing w:before="0" w:after="${twips(0.6)}" w:line="120" w:lineRule="exact"/></w:pPr><w:rPr>${size(4)}</w:rPr></w:style>` +
    // Links look as on the page: the text colour, underlined in the accent.
    `<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:basedOn w:val="DefaultParagraphFont"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/><w:rPr><w:u w:val="single" w:color="${ACCENT}"/></w:rPr></w:style>` +
    `<w:style w:type="character" w:styleId="InlineCode"><w:name w:val="Inline Code"/><w:basedOn w:val="DefaultParagraphFont"/><w:uiPriority w:val="39"/><w:qFormat/><w:rPr>${fonts(MONO_FONT)}<w:noProof/>${size(halfPoints(base * (mono ? 0.95 : 0.86)))}<w:shd w:val="clear" w:color="auto" w:fill="${INLINE_CODE_BG}"/></w:rPr></w:style>` +
    `<w:style w:type="table" w:styleId="DocTable"><w:name w:val="Document Table"/><w:basedOn w:val="TableNormal"/><w:uiPriority w:val="59"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:tblPr><w:tblBorders>${tableBorder("top", 6, LINE_STRONG)}${tableBorder("left", 6, LINE_STRONG)}${tableBorder("bottom", 6, LINE_STRONG)}${tableBorder("right", 6, LINE_STRONG)}${tableBorder("insideH", 4, LINE)}${tableBorder("insideV", 4, LINE)}</w:tblBorders><w:tblCellMar><w:top w:w="${cellPadY}" w:type="dxa"/><w:left w:w="${cellPadX(base)}" w:type="dxa"/><w:bottom w:w="${cellPadY}" w:type="dxa"/><w:right w:w="${cellPadX(base)}" w:type="dxa"/></w:tblCellMar></w:tblPr>` +
      `<w:tblStylePr w:type="firstRow"><w:rPr><w:b/><w:bCs/></w:rPr><w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="${TABLE_HEAD}"/></w:tcPr></w:tblStylePr></w:style>` +
    `</w:styles>`;
}

// Each list gets an abstract numbering of its own (not just a numbering
// instance with a start override), so every reader restarts the count as the
// page does. A list's own level has the marker the page shows (see
// orderedKind / bulletIndex); the levels below it follow the editor's CSS
// (circle, then square for good; lower-alpha, then lower-roman for good),
// which is what Word shows if the user indents an item further.
const BULLETS = ["•", "◦", "▪"];
const ORDERED_CYCLE: Record<Exclude<ListKind, "bullet" | "check">, string[]> = {
  decimal: ["decimal", "lowerLetter", "lowerRoman"],
  lowerLetter: ["lowerLetter", "lowerRoman", "decimal"],
  upperLetter: ["upperLetter", "upperRoman", "decimal"],
  lowerRoman: ["lowerRoman", "decimal", "lowerLetter"],
  upperRoman: ["upperRoman", "decimal", "upperLetter"],
};

function numberingXml(lists: ListInstance[]): string {
  const level = (list: ListInstance, ilvl: number): string => {
    const ind = `<w:pPr><w:ind w:left="${listLeft(ilvl + 1)}" w:hanging="${list.kind === "bullet" ? BULLET_HANGING : ORDERED_HANGING}"/></w:pPr>`;
    if (list.kind === "bullet" || list.kind === "check") {
      const below = ilvl - list.level;
      const bullet = below === 0 ? list.bullet ?? 0 : below > 0 ? Math.min(2, (list.ulDepth ?? 0) + below) : ilvl % 3;
      return `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="${BULLETS[bullet]}"/><w:lvlJc w:val="left"/>${ind}<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial" w:hint="default"/><w:color w:val="${MUTED}"/></w:rPr></w:lvl>`;
    }
    const start = ilvl === list.level ? list.start : 1;
    const below = ilvl - list.level;
    const format = below === 0 ? list.kind
      : below > 0 ? ((list.olDepth ?? 0) + below === 1 ? "lowerLetter" : "lowerRoman")
      : ORDERED_CYCLE[list.kind][ilvl % 3];
    return `<w:lvl w:ilvl="${ilvl}"><w:start w:val="${start}"/><w:numFmt w:val="${format}"/><w:lvlText w:val="%${ilvl + 1}."/><w:lvlJc w:val="left"/>${ind}<w:rPr><w:color w:val="${MUTED}"/></w:rPr></w:lvl>`;
  };
  // To-do lists draw their own checkboxes and need no numbering.
  const numbered = lists.filter((l) => l.kind !== "check");
  const abstracts = numbered.map((list) =>
    `<w:abstractNum w:abstractNumId="${list.numId}"><w:nsid w:val="${(0x1a2b0000 + list.numId).toString(16).toUpperCase()}"/><w:multiLevelType w:val="hybridMultilevel"/>${Array.from({ length: 9 }, (_, i) => level(list, i)).join("")}</w:abstractNum>`).join("");
  const nums = numbered.map((list) => `<w:num w:numId="${list.numId}"><w:abstractNumId w:val="${list.numId}"/></w:num>`).join("");
  return XML_HEAD + `<w:numbering ${W_NS}>${abstracts}${nums}</w:numbering>`;
}

const SETTINGS_XML = XML_HEAD + `<w:settings ${W_NS} xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="w14"><w:zoom w:percent="100"/><w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/><w:compatSetting w:name="overrideTableStyleFontSizeAndJustification" w:uri="http://schemas.microsoft.com/office/word" w:val="1"/><w:compatSetting w:name="enableOpenTypeFeatures" w:uri="http://schemas.microsoft.com/office/word" w:val="1"/><w:compatSetting w:name="doNotFlipMirrorIndents" w:uri="http://schemas.microsoft.com/office/word" w:val="1"/></w:compat></w:settings>`;

// Font metadata lets a reader without the face pick a close substitute.
const FONT_METADATA: Record<string, string> = {
  Arial: `<w:panose1 w:val="020B0604020202020204"/><w:charset w:val="00"/><w:family w:val="swiss"/><w:pitch w:val="variable"/>`,
  Georgia: `<w:panose1 w:val="02040502050405020303"/><w:charset w:val="00"/><w:family w:val="roman"/><w:pitch w:val="variable"/>`,
  "Courier New": `<w:panose1 w:val="02070309020205020404"/><w:charset w:val="00"/><w:family w:val="modern"/><w:pitch w:val="fixed"/>`,
  "MS Gothic": `<w:altName w:val="MS Gothic"/><w:panose1 w:val="020B0609070205080204"/><w:charset w:val="80"/><w:family w:val="modern"/><w:pitch w:val="fixed"/>`,
};

function fontTableXml(fonts: Set<string>): string {
  return XML_HEAD + `<w:fonts ${W_NS}>${[...fonts].map((f) => `<w:font w:name="${xmlAttr(f)}">${FONT_METADATA[f] ?? ""}</w:font>`).join("")}</w:fonts>`;
}

function coreXml(title: string, modified: number): string {
  const date = new Date(Number.isFinite(modified) && modified > 0 ? modified : Date.now()).toISOString().replace(/\.\d{3}Z$/, "Z");
  return XML_HEAD + `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xmlText(title)}</dc:title><dcterms:created xsi:type="dcterms:W3CDTF">${date}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${date}</dcterms:modified></cp:coreProperties>`;
}

const APP_XML = XML_HEAD + `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Docs</Application><DocSecurity>0</DocSecurity></Properties>`;

function contentTypesXml(media: Media[]): string {
  const types = new Set(media.map((m) => m.type));
  const word = "application/vnd.openxmlformats-officedocument.wordprocessingml";
  return XML_HEAD + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
    [...types].map((t) => `<Default Extension="${t}" ContentType="image/${t}"/>`).join("") +
    `<Override PartName="/word/document.xml" ContentType="${word}.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="${word}.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="${word}.numbering+xml"/><Override PartName="/word/settings.xml" ContentType="${word}.settings+xml"/><Override PartName="/word/fontTable.xml" ContentType="${word}.fontTable+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;
}

const ROOT_RELS = XML_HEAD + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`;

function documentRelsXml(relationships: Relationship[]): string {
  const office = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const fixed = `<Relationship Id="rId1" Type="${office}/styles" Target="styles.xml"/><Relationship Id="rId2" Type="${office}/numbering" Target="numbering.xml"/><Relationship Id="rId3" Type="${office}/settings" Target="settings.xml"/><Relationship Id="rId4" Type="${office}/fontTable" Target="fontTable.xml"/>`;
  return XML_HEAD + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${fixed}${relationships.map((r) =>
    `<Relationship Id="${r.id}" Type="${r.type}" Target="${xmlAttr(r.target)}"${r.external ? ` TargetMode="External"` : ""}/>`).join("")}</Relationships>`;
}

// The other exports hide a document's trailing blank lines (client.ts), so the
// Word export drops them too.
function isBlankBlock(html: string): boolean {
  return /^\s*<(p|h[1-6]|div)\b[^>]*>(\s|<br\s*\/?>|&nbsp;|​)*<\/\1>\s*$/i.test(html);
}

// The document's first line, as the editor titles its tab. The stored `title` is not
// read: no editor shows it, so it can be stale.
function documentTitle(fragments: string[]): string {
  for (const fragment of fragments) {
    const text = decodeEntities(fragment.replace(/<[^>]*>/g, " ")).replace(/[\s​]+/g, " ").trim();
    if (text) return text.slice(0, 200);
  }
  return "Untitled document";
}

/**
 * Builds the .docx package for a stored document and its shared settings, as a
 * stream. Throws if the document exceeds {@link DOCX_LIMITS}.
 */
export function documentToDocx(source: DocxSource, settings: DocxSettings = {}): ReadableStream<Uint8Array> {
  const fragments = source.blocks ? source.blocks.map((b) => b.html) : [source.legacyContent ?? ""];
  if (fragments.length > DOCX_LIMITS.blocks) {
    throw new Error(`The document has too many blocks to export as Word (more than ${DOCX_LIMITS.blocks}).`);
  }
  if (fragments.reduce((n, f) => n + f.length, 0) > DOCX_LIMITS.htmlCharacters) {
    throw new Error("The document is too large to export as Word.");
  }
  while (fragments.length && isBlankBlock(fragments[fragments.length - 1]!)) fragments.pop();
  const writer = new DocxWriter(settings);
  const budget = new ParseBudget();
  for (const fragment of fragments) writer.blocks(parseHtml(fragment, budget).children, { width: CONTENT_TWIPS });
  if (!writer.out.length) writer.out.push("<w:p/>");
  // The page sets its first block flush with the top (`.editor > :first-child`).
  if (writer.out[0]!.startsWith("<w:p>")) writer.out[0] = paragraphWithSpacing(writer.out[0]!, { before: 0 });
  const body = writer.out.join("");
  const sectPr = `<w:sectPr><w:pgSz w:w="${PAGE.w}" w:h="${PAGE.h}"/><w:pgMar w:top="${PAGE.margin}" w:right="${PAGE.margin}" w:bottom="${PAGE.margin}" w:left="${PAGE.margin}" w:header="720" w:footer="720" w:gutter="0"/><w:cols w:space="720"/></w:sectPr>`;
  const fonts = new Set([writer.face.font, MONO_FONT, "Arial"]);
  if (writer.checkboxes) fonts.add("MS Gothic");
  for (const m of body.matchAll(/w:ascii="([^"]+)"/g)) fonts.add(decodeEntities(m[1]!));
  const entries: ZipEntry[] = [
    { name: "[Content_Types].xml", data: contentTypesXml(writer.media) },
    { name: "_rels/.rels", data: ROOT_RELS },
    { name: "docProps/core.xml", data: coreXml(documentTitle(fragments), Number(source.lastModified)) },
    { name: "docProps/app.xml", data: APP_XML },
    { name: "word/document.xml", data: XML_HEAD + `<w:document ${DOC_NS}><w:body>${body}${sectPr}</w:body></w:document>` },
    { name: "word/styles.xml", data: stylesXml(writer.face) },
    { name: "word/numbering.xml", data: numberingXml(writer.lists) },
    { name: "word/settings.xml", data: SETTINGS_XML },
    { name: "word/fontTable.xml", data: fontTableXml(fonts) },
    { name: "word/_rels/document.xml.rels", data: documentRelsXml(writer.relationships) },
    ...writer.media.map((m) => ({ name: "word/media/" + m.name, data: new Blob([m.bytes]).stream() })),
  ];
  return createZip(entries);
}
