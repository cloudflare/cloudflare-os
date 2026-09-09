// Converts a document snapshot (the persisted HTML blocks) into a streamed DOCX package.
//
// The HTML is parsed into a small tree with HTMLRewriter, then walked once. Paragraphs are opened
// lazily by the first inline content they receive and closed by block boundaries, so block
// structure never has to be inferred ahead of time. Each fragment is handed to the rewriter as one
// in-memory body, which keeps lol-html from having to buffer a token across writes (its parsing
// buffer is capped at 3 MiB, well below a data-URL image attribute).

import { createZip } from "./zip.js";
import { loadHtmlEntities } from "./html-entities.js";

const encoder = new TextEncoder();
const WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const OFFICE_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
// US Letter with the 0.65in margins declared in the section properties, at 96 px/in.
const CONTENT_WIDTH_PIXELS = 691.2;
const CONTENT_HEIGHT_PIXELS = 931.2;
const EMUS_PER_PIXEL = 9525;
const TWIPS_PER_PIXEL = 15;
const LIST_INDENT_TWIPS = 420;
const TEXT_CHUNK_SIZE = 64 * 1024;

export const DOCX_LIMITS = Object.freeze({
  htmlCharacters: 32 * 1024 * 1024,
  nodes: 200_000,
  depth: 128,
  hyperlinks: 4096,
  images: 128,
  imageBytes: 8 * 1024 * 1024,
  totalImageBytes: 24 * 1024 * 1024,
});

const IGNORED_TAGS = new Set([
  "head", "title", "meta", "link", "script", "style", "template", "noscript", "iframe", "object",
  "embed", "svg", "math",
]);
// Elements that end the current paragraph on entry and exit. Table cells are deliberately absent:
// rows are flattened to one paragraph with tab-separated cells.
const BLOCK_TAGS = new Set([
  "address", "article", "aside", "blockquote", "dd", "details", "div", "dl", "dt", "fieldset",
  "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup",
  "hr", "li", "main", "nav", "ol", "p", "pre", "section", "summary", "table", "tbody", "tfoot",
  "thead", "tr", "ul",
]);
const HEADING_STYLES = {h1: "Heading1", h2: "Heading2", h3: "Heading3", h4: "Heading3", h5: "Heading3", h6: "Heading3"};
// Blocks that take up space even when empty, unlike a bare `div`.
const PARAGRAPH_TAGS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre"]);
const BULLET_GLYPHS = ["&#x2022;", "&#x25E6;", "&#x25AA;"];
// Word numbering formats, indexed by abstract numbering id; `<ol type>` maps onto the last four.
const LIST_KINDS = ["bullet", "decimal", "lowerLetter", "upperLetter", "lowerRoman", "upperRoman"];
const LIST_TYPES = {a: "lowerLetter", A: "upperLetter", i: "lowerRoman", I: "upperRoman"};
// The only attributes the walk reads; everything else is dropped at parse time.
const STORED_ATTRIBUTES = ["style", "class", "hidden", "open", "href", "src", "alt", "width", "type", "start", "value", "face", "size", "color"];

// --- XML text ----------------------------------------------------------------------------------

// Replaces characters XML 1.0 cannot carry (control characters, lone surrogates) with U+FFFD.
function cleanXml(value) {
  const input = String(value ?? "");
  let result = "";
  for (let index = 0; index < input.length; ++index) {
    const code = input.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = input.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) result += input[index] + input[++index];
      else result += "\ufffd";
    } else if (code === 9 || code === 10 || code === 13 ||
        (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd)) {
      result += input[index];
    } else {
      result += "\ufffd";
    }
  }
  return result;
}

function xmlText(value) {
  return cleanXml(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function xmlAttribute(value) {
  return xmlText(value).replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

// lol-html hands text and attribute values through with their character references intact.
function decodeHtmlEntities(value, namedEntities) {
  return value.replace(/&(#(?:[xX][0-9a-fA-F]+|\d+)|[0-9A-Za-z]+);/g, (match, entity) => {
    if (entity[0] !== "#") return Object.hasOwn(namedEntities, entity) ? namedEntities[entity] : match;
    const hexadecimal = entity[1] === "x" || entity[1] === "X";
    const codePoint = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
    if (codePoint <= 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return "\ufffd";
    return String.fromCodePoint(codePoint);
  });
}

// Encodes a string generator into ~64 KiB byte chunks; `highWaterMark: 0` keeps generation lazy
// until the archive reaches this part.
function textStream(generator) {
  return new ReadableStream({
    pull(controller) {
      const parts = [];
      let length = 0;
      while (length < TEXT_CHUNK_SIZE) {
        const result = generator.next();
        if (result.done) {
          if (parts.length) controller.enqueue(encoder.encode(parts.join("")));
          controller.close();
          return;
        }
        parts.push(result.value);
        length += result.value.length;
      }
      controller.enqueue(encoder.encode(parts.join("")));
    },
    cancel(reason) {
      generator.return(reason);
    },
  }, {highWaterMark: 0});
}

// --- HTML parsing ------------------------------------------------------------------------------

function normalizeSnapshot(document) {
  const source = document && typeof document === "object" ? document : {};
  const blocks = Array.isArray(source.blocks) ? source.blocks.map((block) => block?.html) : [source.legacyContent];
  const fragments = [];
  let htmlCharacters = 0;
  for (const value of blocks) {
    const fragment = String(value ?? "");
    if (!fragment) continue;
    htmlCharacters += fragment.length;
    if (htmlCharacters > DOCX_LIMITS.htmlCharacters) {
      throw new Error(`DOCX source HTML exceeds the ${DOCX_LIMITS.htmlCharacters}-character export limit.`);
    }
    fragments.push(fragment);
  }
  const modified = source.lastModified == null ? NaN : new Date(source.lastModified).getTime();
  return {
    fragments,
    title: String(source.title ?? "").slice(0, 1024),
    modified: Number.isFinite(modified) ? new Date(modified).toISOString() : null,
  };
}

// lol-html only reports explicit end tags, so the end tags HTML lets authors omit are closed here:
// `tag` closes any open element in `closes` unless one in `within` is reached first.
function closeImplied(stack, tag) {
  const [closes, within] = tag === "li" ? [["li"], ["ul", "ol"]]
    : tag === "td" || tag === "th" ? [["td", "th"], ["tr", "table"]]
    : tag === "dt" || tag === "dd" ? [["dt", "dd"], ["dl"]]
    : tag === "tr" ? [["tr"], ["table"]]
    : tag === "thead" || tag === "tbody" || tag === "tfoot" ? [["thead", "tbody", "tfoot"], ["table"]]
    : tag === "a" ? [["a"], []]
    : HEADING_STYLES[tag] ? [["p", ...Object.keys(HEADING_STYLES)], []]
    : BLOCK_TAGS.has(tag) ? [["p"], []] : [[], []];
  for (let index = stack.length - 1; index > 0 && closes.length; --index) {
    const open = stack[index].tag;
    if (closes.includes(open)) {
      stack.length = index;
      return;
    }
    if (within.includes(open)) return;
  }
}

// Parses each fragment into `{tag, attrs, children}` nodes (text children are decoded strings),
// wrapped in a synthetic `div` so separate blocks never share a paragraph.
async function parseHtml(fragments, namedEntities) {
  const root = {tag: "#document", attrs: {}, children: []};
  let nodeCount = 0;
  const countNode = () => {
    if (++nodeCount > DOCX_LIMITS.nodes) {
      throw new Error(`DOCX HTML node count exceeds the ${DOCX_LIMITS.nodes}-node export limit.`);
    }
  };
  // An exception thrown inside a handler is reported by the runtime as uncaught as well as failing
  // the transform, so handlers record it and it is rethrown once the fragment has been consumed.
  let failure = null;
  const guarded = (handler) => (token) => {
    if (failure) return;
    try {
      handler(token);
    } catch (error) {
      failure = error;
    }
  };
  for (const fragment of fragments) {
    const wrapper = {tag: "div", attrs: {}, children: []};
    root.children.push(wrapper);
    const stack = [wrapper];
    let pendingText = "";
    const rewriter = new HTMLRewriter().on("*", {
      element: guarded((element) => {
        countNode();
        const tag = element.tagName.toLowerCase();
        closeImplied(stack, tag);
        if (stack.length > DOCX_LIMITS.depth) {
          throw new Error(`DOCX HTML nesting exceeds the ${DOCX_LIMITS.depth}-level export limit.`);
        }
        const attrs = {};
        for (const name of STORED_ATTRIBUTES) {
          const value = element.getAttribute(name);
          if (value != null) attrs[name] = decodeHtmlEntities(value, namedEntities);
        }
        const node = {tag, attrs, children: []};
        stack.at(-1).children.push(node);
        try {
          element.onEndTag(() => {
            const index = stack.lastIndexOf(node);
            if (index > 0) stack.length = index;
          });
        } catch {
          return; // Void or self-closing: nothing can nest inside it.
        }
        stack.push(node);
      }),
    }).onDocument({
      // A text node arrives in chunks that may split a character reference, so it is decoded whole.
      text: guarded((text) => {
        pendingText += text.text;
        if (!text.lastInTextNode || !pendingText) return;
        const decoded = decodeHtmlEntities(pendingText, namedEntities);
        pendingText = "";
        const children = stack.at(-1).children;
        if (typeof children.at(-1) === "string") {
          children[children.length - 1] += decoded;
        } else {
          countNode();
          children.push(decoded);
        }
      }),
    });
    await rewriter.transform(new Response(fragment)).body.pipeTo(new WritableStream());
    if (failure) throw failure;
  }
  return root;
}

// --- CSS ---------------------------------------------------------------------------------------

// Returns `[name, value]` pairs in cascade order: later declarations win, and `!important` ones are
// moved after the rest so a plain later declaration cannot override them.
function cssDeclarations(style) {
  const declarations = [];
  // Inline styles are short; a huge one is not worth allocating a declaration per fragment for.
  for (const part of String(style || "").slice(0, 8192).split(";")) {
    const colon = part.indexOf(":");
    if (colon < 0) continue;
    const name = part.slice(0, colon).trim().toLowerCase();
    const important = /!important\s*$/i.test(part);
    const value = (important ? part.slice(colon + 1, part.lastIndexOf("!")) : part.slice(colon + 1)).trim();
    if (name && value && !["inherit", "unset", "initial"].includes(value.toLowerCase())) {
      declarations.push({name, value, important});
    }
  }
  return declarations.sort((a, b) => a.important - b.important).map(({name, value}) => [name, value]);
}

// Returns an RRGGBB hex string for `#rgb(a)`, `#rrggbb(aa)`, and `rgb()`/`rgba()` colors, "" for a
// fully transparent color, and null for anything else.
function cssColor(value) {
  const input = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(input)?.[1];
  if (hex) {
    if (hex.length === 4 && hex[3] === "0") return "";
    if (hex.length === 8 && hex.slice(6) === "00") return "";
    if (hex.length <= 4) return (hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2]).toUpperCase();
    return hex.slice(0, 6).toUpperCase();
  }
  const rgb = /^rgba?\(([^)]*)\)$/.exec(input)?.[1];
  if (!rgb) return null;
  const parts = rgb.split(/\s*[,/]\s*|\s+/);
  const channels = parts.slice(0, 3).map((part) => {
    const number = Number.parseFloat(part);
    const channel = part.endsWith("%") ? number * 2.55 : number;
    return channel >= 0 && channel <= 255 ? Math.round(channel) : NaN;
  });
  if (channels.length < 3 || channels.some(Number.isNaN)) return null;
  if (parts[3] !== undefined && Number.parseFloat(parts[3]) === 0) return "";
  return channels.map((channel) => channel.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function fontFamily(value) {
  const first = value.split(",", 1)[0].trim().replace(/^(["'])(.*)\1$/, "$2");
  switch (first.toLowerCase()) {
    case "ui-sans-serif": case "system-ui": case "-apple-system": case "sans-serif": return "Arial";
    case "ui-serif": case "serif": return "Georgia";
    case "ui-monospace": case "monospace": return "Courier New";
    default: return first.length <= 100 ? first : null;
  }
}

function cssLength(value, twipsPerPixel = TWIPS_PER_PIXEL) {
  const match = /^(-?(?:\d+\.?\d*|\.\d+))\s*(px|pt|in|cm|mm)?$/i.exec(value.trim());
  if (!match) return null;
  const number = Number(match[1]);
  const unit = (match[2] || "px").toLowerCase();
  const inches = unit === "in" ? number : unit === "cm" ? number / 2.54 : unit === "mm" ? number / 25.4
    : unit === "pt" ? number / 72 : number / 96;
  return Math.round(inches * 96 * twipsPerPixel);
}

// Font size in half-points, as Word stores it.
function halfPoints(value) {
  const twips = cssLength(value);
  return twips != null && twips >= 20 && twips <= 4000 ? Math.round(twips / 10) : null;
}

// `<font size="1..7">` in half-points.
function htmlFontSize(value) {
  return [0, 16, 20, 24, 28, 36, 48, 72][Math.round(Number(value))] || null;
}

// Left component of a `margin`/`padding` shorthand.
function cssBoxLeft(value) {
  const parts = value.trim().split(/\s+/);
  return parts.length > 4 ? null : parts[parts.length === 4 ? 3 : parts.length === 1 ? 0 : 1];
}

// --- Semantic model ----------------------------------------------------------------------------

// Blink's Increase Indent wraps the block in a borderless blockquote; a blockquote whose winning
// left border is visible is a quotation. A border declaration is visible when it names a line
// style, borderless when it is `none`/`hidden` or a bare width, and ignored when it is invalid.
function isIndentation(node, declarations) {
  if (node.tag !== "blockquote") return false;
  let borderless = false;
  for (const [name, value] of declarations) {
    if (name !== "border" && name !== "border-left") continue;
    const lower = value.trim().toLowerCase();
    if (/\b(?:solid|dashed|dotted|double|groove|ridge|inset|outset)\b/.test(lower)) borderless = false;
    else if (/\b(?:none|hidden)\b/.test(lower) || cssLength(lower) != null) borderless = true;
  }
  return borderless;
}

function blockStyle(node, declarations) {
  if (node.tag === "h1" && /(?:^|\s)doc-title(?:\s|$)/.test(node.attrs.class || "")) return "Title";
  if (node.tag === "blockquote") return isIndentation(node, declarations) ? null : "Quote";
  if (node.tag === "pre") return "CodeBlock";
  return HEADING_STYLES[node.tag] ?? null;
}

function deriveFormat(parent, node, declarations) {
  const format = {...parent};
  switch (node.tag) {
    case "strong": case "b": format.bold = true; break;
    case "em": case "i": format.italic = true; break;
    case "u": format.underline = true; break;
    case "s": case "strike": case "del": format.strike = true; break;
    case "code": format.font = "Courier New"; break;
    case "font": {
      const font = node.attrs.face && fontFamily(node.attrs.face);
      if (font) format.font = font;
      const size = htmlFontSize(node.attrs.size);
      if (size) format.size = size;
      const color = node.attrs.color && cssColor(node.attrs.color);
      if (color) format.color = color;
      break;
    }
  }
  for (const [name, value] of declarations) {
    const lower = value.toLowerCase();
    if (name === "font-family") {
      const font = fontFamily(value);
      if (font) format.font = font;
    } else if (name === "font-size") {
      const size = halfPoints(value);
      if (size) format.size = size;
    } else if (name === "font-weight") {
      if (lower === "normal") format.bold = false;
      else if (lower === "bold" || lower === "bolder") format.bold = true;
      else if (/^\d+$/.test(lower)) format.bold = Number(lower) >= 600;
    } else if (name === "font-style") {
      if (lower === "normal") format.italic = false;
      else if (lower === "italic" || lower === "oblique") format.italic = true;
    } else if (name === "text-decoration" || name === "text-decoration-line") {
      format.underline = /\bunderline\b/.test(lower);
      format.strike = /\bline-through\b/.test(lower);
    } else if (name === "color") {
      const color = cssColor(value);
      if (color) format.color = color;
    } else if (name === "background-color") {
      const color = lower === "transparent" ? "" : cssColor(value);
      if (color != null) format.shading = color || null;
    }
  }
  return format;
}

// A value the browser accepts but Word cannot express (percentages, font-relative units).
const UNREPRESENTABLE_LENGTH = /^-?(?:\d+\.?\d*|\.\d+)(?:%|r?em|ch|ex|v(?:w|h|min|max))$/i;

// Winning indent in twips after `value`: a length replaces `previous`, an unrepresentable value
// clears it, and an invalid declaration is dropped as the browser drops it. `auto` is valid for
// margins only.
function indentValue(value, previous, allowAuto) {
  const twips = cssLength(value);
  if (twips != null) return twips;
  const trimmed = value.trim();
  return UNREPRESENTABLE_LENGTH.test(trimmed) || (allowAuto && /^auto$/i.test(trimmed)) ? null : previous;
}

function deriveParagraph(parent, declarations) {
  const paragraph = {...parent};
  // Declarations on one element cascade: the last one that parses wins, and only it adds to the
  // indent (an invalid declaration is dropped, as the browser drops it).
  let marginLeft = null;
  let paddingLeft = null;
  for (const [name, value] of declarations) {
    const lower = value.toLowerCase();
    if (name === "text-align") {
      if (lower === "left" || lower === "start") paragraph.alignment = "left";
      else if (lower === "center" || lower === "right" || lower === "justify") paragraph.alignment = lower;
    } else if (name === "margin-left" || name === "margin") {
      marginLeft = indentValue(name === "margin" ? cssBoxLeft(value) ?? "" : value, marginLeft, true);
    } else if (name === "padding-left" || name === "padding") {
      paddingLeft = indentValue(name === "padding" ? cssBoxLeft(value) ?? "" : value, paddingLeft, false);
    } else if (name === "text-indent") {
      const twips = cssLength(value);
      if (twips != null) paragraph.firstLine = Math.max(-7200, Math.min(7200, twips));
    } else if (name === "line-height") {
      const multiple = /^\d*\.?\d+$/.test(lower) ? Number(lower) : lower.endsWith("%") ? Number.parseFloat(lower) / 100 : NaN;
      if (multiple >= 0.5 && multiple <= 10) {
        paragraph.line = Math.round(multiple * 240);
        paragraph.lineRule = "auto";
      } else if (lower === "normal") {
        delete paragraph.line;
        delete paragraph.lineRule;
      } else {
        const twips = cssLength(value);
        if (twips > 0 && twips <= 20_000) {
          paragraph.line = twips;
          paragraph.lineRule = "exact";
        }
      }
    }
  }
  for (const twips of [marginLeft, paddingLeft]) {
    if (twips != null) paragraph.left = Math.max(0, Math.min(14_400, (paragraph.left || 0) + twips));
  }
  return paragraph;
}

function canonicalHyperlink(value) {
  const target = String(value || "").trim();
  if (!target || target.length > 4096 || /[\u0000-\u001f\u007f]/.test(target)) return null;
  let url;
  try {
    url = new URL(target);
  } catch {
    return null;
  }
  if (!["http:", "https:", "mailto:", "tel:"].includes(url.protocol) || url.username || url.password) return null;
  if ((url.protocol === "http:" || url.protocol === "https:") && !url.hostname) return null;
  // Word truncates hyperlinks around 2,080 characters, and percent-encoding can grow the target.
  return url.href.length <= 2048 ? url.href : null;
}

// --- Images ------------------------------------------------------------------------------------

// Reads the intrinsic size from the container header; returns null when the bytes do not carry the
// declared format's signature.
function imageDimensions(mime, bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (offset, length) => String.fromCharCode(...bytes.subarray(offset, offset + length));
  const uint24 = (offset) => bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
  if (mime === "image/png") {
    if (bytes.length < 24 || view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a || ascii(12, 4) !== "IHDR") return null;
    return {width: view.getUint32(16), height: view.getUint32(20)};
  }
  if (mime === "image/gif") {
    if (bytes.length < 10 || !["GIF87a", "GIF89a"].includes(ascii(0, 6))) return null;
    return {width: view.getUint16(6, true), height: view.getUint16(8, true)};
  }
  if (mime === "image/webp") {
    if (bytes.length < 30 || ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WEBP") return null;
    switch (ascii(12, 4)) {
      case "VP8X": return {width: 1 + uint24(24), height: 1 + uint24(27)};
      case "VP8 ": return {width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff};
      case "VP8L": return {
        width: 1 + (bytes[21] | ((bytes[22] & 0x3f) << 8)),
        height: 1 + ((bytes[22] >> 6) | (bytes[23] << 2) | ((bytes[24] & 0x0f) << 10)),
      };
      default: return null;
    }
  }
  // JPEG: walk the segments to the first start-of-frame marker.
  if (bytes.length < 4 || view.getUint16(0) !== 0xffd8) return null;
  for (let offset = 2; offset + 9 <= bytes.length;) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    if (marker === 0xff) {
      ++offset;
    } else if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      offset += 2;
    } else if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return {width: view.getUint16(offset + 7), height: view.getUint16(offset + 5)};
    } else if (marker === 0xda || marker === 0xd9) {
      return null;
    } else {
      offset += 2 + view.getUint16(offset + 2);
    }
  }
  return null;
}

// Width in twips for a `width` attribute or declaration: percentages of the content width, lengths,
// `auto` (intrinsic, null); undefined when the value is invalid.
function widthTwips(value) {
  const trimmed = String(value).trim();
  const percent = /^(\d+(?:\.\d+)?)%$/.exec(trimmed);
  if (percent) return CONTENT_WIDTH_PIXELS * TWIPS_PER_PIXEL * Math.min(100, Number(percent[1])) / 100;
  if (trimmed.toLowerCase() === "auto") return null;
  return cssLength(trimmed) ?? undefined;
}

// Requested display width in pixels from the `width` attribute or inline style (last valid
// declaration wins), or null when none applies.
function requestedWidth(node) {
  let twips = widthTwips(node.attrs.width || "") ?? null;
  for (const [name, value] of cssDeclarations(node.attrs.style)) {
    if (name !== "width") continue;
    const next = widthTwips(value);
    if (next !== undefined) twips = next;
  }
  return twips != null && twips >= 0 ? twips / TWIPS_PER_PIXEL : null;
}

// --- Document builder --------------------------------------------------------------------------

class DocumentBuilder {
  constructor() {
    this.paragraphs = [];
    this.current = null;
    this.relationships = [];
    this.hyperlinkIds = new Map();
    this.images = [];
    this.imagesBySource = new Map();
    this.imageBytes = 0;
    this.imageCount = 0;
    this.numbering = [];
  }

  // Returns the open paragraph, opening one from the context if none is. The first paragraph
  // opened inside a list item carries its number; later ones are indented continuations.
  open(context) {
    if (this.current) return this.current;
    const paragraph = {...context.paragraph, style: context.style, runs: [], pendingBreaks: 0, endsWithSpace: true};
    if (context.list?.marked) paragraph.continuation = context.list.level;
    else if (context.list) {
      paragraph.list = context.list;
      context.list.marked = true;
    }
    this.paragraphs.push(paragraph);
    this.current = paragraph;
    return paragraph;
  }

  // Only the last trailing line break is non-rendering in HTML; the ones before it are blank lines.
  close() {
    const paragraph = this.current;
    for (let count = paragraph?.pendingBreaks - 1; count > 0; --count) paragraph.runs.push({type: "break"});
    this.current = null;
  }

  addRun(context, run) {
    const paragraph = this.open(context);
    for (; paragraph.pendingBreaks > 0; --paragraph.pendingBreaks) paragraph.runs.push({type: "break"});
    const last = paragraph.runs.at(-1);
    if (run.type === "text" && last?.type === "text" && last.key === run.key && last.hyperlink === run.hyperlink) {
      last.text += run.text;
    } else {
      paragraph.runs.push(run);
    }
    paragraph.endsWithSpace = run.type === "text" && run.text.endsWith(" ");
  }

  text(context, value) {
    const text = cleanXml(value);
    if (context.preformatted) {
      // Newlines stay in the run and become `<w:br/>` when the XML is written.
      this.textRun(context, text.replace(/\r\n?/g, "\n"));
      return;
    }
    let collapsed = text.replace(/[\t\n\f\r ]+/g, " ");
    // Whitespace between blocks is not content; whitespace at the start of a paragraph or after a
    // space or break collapses away.
    if (!this.current && collapsed === " ") return;
    if ((this.current?.endsWithSpace ?? true) && collapsed.startsWith(" ")) collapsed = collapsed.slice(1);
    if (collapsed) this.textRun(context, collapsed);
  }

  textRun(context, text) {
    const format = context.format;
    const key = [format.bold, format.italic, format.underline, format.strike, format.font, format.size,
      format.color, format.shading].join("|");
    this.addRun(context, {type: "text", text, format, key, hyperlink: this.hyperlink(context.hyperlink)});
  }

  // Text after a line break starts a new line, so leading whitespace collapses away there too.
  break(context) {
    const paragraph = this.open(context);
    ++paragraph.pendingBreaks;
    paragraph.endsWithSpace = true;
  }

  relationship(type, target, targetMode) {
    const id = `rId${this.relationships.length + 3}`;
    this.relationships.push({id, type, target, targetMode});
    return id;
  }

  // Relationships are allocated when content is emitted under the link, not when `<a>` is seen.
  hyperlink(target) {
    if (!target) return null;
    let id = this.hyperlinkIds.get(target);
    if (!id) {
      if (this.hyperlinkIds.size >= DOCX_LIMITS.hyperlinks) {
        throw new Error(`DOCX hyperlink count exceeds the ${DOCX_LIMITS.hyperlinks}-target export limit.`);
      }
      id = this.relationship("hyperlink", target, "External");
      this.hyperlinkIds.set(target, id);
    }
    return id;
  }

  list(kind, level, start) {
    const id = this.numbering.length + 1;
    this.numbering.push({id, kind, level, start});
    return id;
  }

  // Decodes and validates a data-URL image, embedding each distinct source once.
  decodeImage(source) {
    if (this.imagesBySource.has(source)) return this.imagesBySource.get(source);
    let image = null;
    const match = /^data:image\/(png|jpe?g|gif|webp);base64,([A-Za-z0-9+/=]+)$/i.exec(source);
    if (match) {
      const payload = match[2];
      const decodedBytes = Math.floor(payload.length * 3 / 4) - (payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0);
      if (decodedBytes > DOCX_LIMITS.imageBytes) {
        throw new Error(`DOCX image exceeds the ${DOCX_LIMITS.imageBytes}-byte per-image export limit.`);
      }
      if (this.imageBytes + decodedBytes > DOCX_LIMITS.totalImageBytes) {
        throw new Error(`DOCX images exceed the ${DOCX_LIMITS.totalImageBytes}-byte aggregate export limit.`);
      }
      this.imageBytes += decodedBytes;
      let bytes = null;
      try {
        bytes = Uint8Array.fromBase64(payload);
      } catch {}
      const extension = match[1].toLowerCase() === "jpg" ? "jpeg" : match[1].toLowerCase();
      const dimensions = bytes && imageDimensions(`image/${extension}`, bytes);
      if (dimensions?.width > 0 && dimensions.height > 0) {
        const name = `image${this.images.length + 1}.${extension === "jpeg" ? "jpg" : extension}`;
        image = {...dimensions, bytes, name, extension, relationship: this.relationship("image", `media/${name}`)};
        this.images.push(image);
      }
    }
    this.imagesBySource.set(source, image);
    return image;
  }

  image(context, node) {
    const requested = requestedWidth(node);
    if (requested === 0) return; // Sized away in the editor; nothing is displayed.
    if (++this.imageCount > DOCX_LIMITS.images) {
      throw new Error(`DOCX image count exceeds the ${DOCX_LIMITS.images}-image export limit.`);
    }
    const image = this.decodeImage(node.attrs.src || "");
    const alt = cleanXml((node.attrs.alt || "").slice(0, 8192));
    if (!image) {
      // External and blob URLs cannot be fetched from here; keep the picture's place visible.
      this.text(context, alt || "[Image unavailable]");
      return;
    }
    let width = Math.min(CONTENT_WIDTH_PIXELS, requested || image.width);
    let height = width * image.height / image.width;
    if (height > CONTENT_HEIGHT_PIXELS) {
      width *= CONTENT_HEIGHT_PIXELS / height;
      height = CONTENT_HEIGHT_PIXELS;
    }
    this.addRun(context, {
      type: "image", image, alt, hyperlink: this.hyperlink(context.hyperlink), drawingId: this.imageCount,
      cx: Math.max(1, Math.round(width * EMUS_PER_PIXEL)),
      cy: Math.max(1, Math.round(height * EMUS_PER_PIXEL)),
    });
  }
}

// Walks the parsed tree, threading an inherited context: run formatting, paragraph properties,
// paragraph style, hyperlink target, preformatting, and the enclosing list.
function walk(builder, node, parent) {
  const tag = node.tag;
  if (IGNORED_TAGS.has(tag) || "hidden" in node.attrs) return;
  const declarations = cssDeclarations(node.attrs.style);
  if (declarations.findLast(([name]) => name === "display")?.[1].toLowerCase() === "none") return;
  // Editor images are `display: block`, so each one stands in its own paragraph. Inside a table
  // cell, blocks flatten into the row paragraph, separated by line breaks.
  const block = !parent.inCell && (BLOCK_TAGS.has(tag) || (tag === "img" && /(?:^|\s)doc-image(?:\s|$)/.test(node.attrs.class || "")));
  const context = {
    ...parent,
    format: deriveFormat(parent.format, node, declarations),
    // Alignment, indentation, and line height only apply to block containers.
    paragraph: block ? deriveParagraph(parent.paragraph, declarations) : parent.paragraph,
    style: blockStyle(node, declarations) ?? parent.style,
  };
  if (block) builder.close();
  if (parent.inCell && BLOCK_TAGS.has(tag)) {
    const paragraph = builder.current;
    const last = paragraph?.runs.at(-1);
    if (last && last.type !== "tab" && !paragraph.pendingBreaks) builder.break(context);
  }
  switch (tag) {
    case "br":
      builder.break(context);
      return;
    case "img":
      builder.image(context, node);
      if (block) builder.close();
      return;
    case "hr":
      builder.open(context).horizontalRule = true;
      builder.close();
      return;
    case "pre": {
      context.preformatted = true;
      // HTML renders neither the newline right after `<pre>` nor the one right before `</pre>`.
      const first = node.children[0];
      if (typeof first === "string") node.children[0] = first.replace(/^\r?\n/, "");
      const last = node.children.at(-1);
      if (typeof last === "string") node.children[node.children.length - 1] = last.replace(/\r?\n$/, "");
      break;
    }
    case "a":
      context.hyperlink = canonicalHyperlink(node.attrs.href) ?? parent.hyperlink;
      break;
    case "ul":
    case "ol":
      // The numbering instance is allocated by the first item, so an empty list defines none.
      context.listKind = tag === "ol" ? LIST_TYPES[node.attrs.type] || "decimal" : "bullet";
      context.listStart = ordinal(node.attrs.start);
      context.level = Math.min(8, parent.level == null ? 0 : parent.level + 1);
      context.numId = null;
      // A nested list inside an item that has no content of its own still shows the item's marker.
      if (parent.list && !parent.list.marked) builder.open(parent);
      break;
    case "li": {
      if (parent.listKind == null) break;
      // A `value` restarts numbering for this item and those that follow it in the same list.
      const value = context.listKind === "bullet" ? null : ordinal(node.attrs.value);
      if (value != null || parent.numId == null) {
        parent.numId = builder.list(context.listKind, context.level, value ?? parent.listStart);
      }
      context.list = {numId: parent.numId, level: context.level, marked: false};
      break;
    }
    case "tr":
      context.cells = 0;
      break;
    case "td":
    case "th":
      if (parent.cells++) builder.addRun(context, {type: "tab"});
      context.inCell = true;
      break;
  }
  const paragraphCount = builder.paragraphs.length;
  // A collapsed `<details>` shows only its summary.
  const children = tag === "details" && !("open" in node.attrs)
    ? node.children.filter((child) => child.tag === "summary") : node.children;
  for (const child of children) {
    if (typeof child === "string") builder.text(context, child);
    else walk(builder, child, context);
  }
  // An empty list item still shows its marker, and an empty paragraph-like block still takes space.
  const empty = (tag === "li" && context.list && !context.list.marked) ||
    (PARAGRAPH_TAGS.has(tag) && builder.paragraphs.length === paragraphCount);
  if (empty) builder.open(context);
  if (block) builder.close();
}

function ordinal(value) {
  const number = Number(String(value ?? "").trim() || NaN);
  return Number.isInteger(number) && Math.abs(number) <= 0x7fffffff ? number : null;
}

// --- WordprocessingML --------------------------------------------------------------------------

function runProperties(format, hyperlink) {
  const properties = [];
  if (hyperlink) properties.push('<w:rStyle w:val="Hyperlink"/>');
  if (format.font) {
    const font = xmlAttribute(format.font);
    properties.push(`<w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:eastAsia="${font}" w:cs="${font}"/>`);
  }
  if (format.bold != null) properties.push(format.bold ? "<w:b/><w:bCs/>" : '<w:b w:val="0"/><w:bCs w:val="0"/>');
  if (format.italic != null) properties.push(format.italic ? "<w:i/><w:iCs/>" : '<w:i w:val="0"/><w:iCs w:val="0"/>');
  if (format.strike != null) properties.push(format.strike ? "<w:strike/>" : '<w:strike w:val="0"/>');
  if (format.color) properties.push(`<w:color w:val="${format.color}"/>`);
  if (format.size) properties.push(`<w:sz w:val="${format.size}"/><w:szCs w:val="${format.size}"/>`);
  if (format.underline != null) properties.push(`<w:u w:val="${format.underline ? "single" : "none"}"/>`);
  if (format.shading) properties.push(`<w:shd w:val="clear" w:color="auto" w:fill="${format.shading}"/>`);
  return properties.length ? `<w:rPr>${properties.join("")}</w:rPr>` : "";
}

// Text is emitted in bounded `<w:t>` slices, with tabs and newlines (preformatted text) as `<w:tab/>`
// and `<w:br/>`, scanning one chunk at a time so a huge run never becomes a huge string or array.
function* textRunXml(run) {
  if (run.hyperlink) yield `<w:hyperlink r:id="${run.hyperlink}" w:history="1">`;
  yield `<w:r>${runProperties(run.format, run.hyperlink)}`;
  const text = run.text;
  for (let offset = 0; offset < text.length;) {
    const character = text[offset];
    if (character === "\t" || character === "\n") {
      yield character === "\t" ? "<w:tab/>" : "<w:br/>";
      ++offset;
      continue;
    }
    const chunk = text.slice(offset, offset + TEXT_CHUNK_SIZE);
    const separator = chunk.search(/[\t\n]/);
    let length = separator < 0 ? chunk.length : separator;
    if (offset + length < text.length && (chunk.charCodeAt(length - 1) & 0xfc00) === 0xd800) --length;
    yield `<w:t xml:space="preserve">${xmlText(chunk.slice(0, length))}</w:t>`;
    offset += length;
  }
  yield "</w:r>";
  if (run.hyperlink) yield "</w:hyperlink>";
}

function imageRunXml(run) {
  const alt = xmlAttribute(run.alt);
  const name = xmlAttribute(run.image.name);
  const hyperlink = run.hyperlink ? `<a:hlinkClick r:id="${run.hyperlink}"/>` : "";
  return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">` +
    `<wp:extent cx="${run.cx}" cy="${run.cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>` +
    `<wp:docPr id="${run.drawingId}" name="${name}" descr="${alt}">${hyperlink}</wp:docPr>` +
    `<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic><pic:nvPicPr><pic:cNvPr id="${run.drawingId}" name="${name}" descr="${alt}"/>` +
    `<pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${run.image.relationship}"/>` +
    `<a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr>` +
    `<a:xfrm><a:off x="0" y="0"/><a:ext cx="${run.cx}" cy="${run.cy}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>` +
    `</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
}

function paragraphProperties(paragraph) {
  const properties = [`<w:pStyle w:val="${paragraph.style}"/>`];
  if (paragraph.list) {
    properties.push(`<w:numPr><w:ilvl w:val="${paragraph.list.level}"/><w:numId w:val="${paragraph.list.numId}"/></w:numPr>`);
  }
  if (paragraph.horizontalRule) {
    properties.push('<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="D9D9D9"/></w:pBdr>');
  }
  const spacing = [];
  if (paragraph.horizontalRule) spacing.push('w:before="330"', 'w:after="330"');
  if (paragraph.line) spacing.push(`w:line="${paragraph.line}"`, `w:lineRule="${paragraph.lineRule}"`);
  if (spacing.length) properties.push(`<w:spacing ${spacing.join(" ")}/>`);
  let left = paragraph.left;
  if (paragraph.list && left != null) left += (paragraph.list.level + 1) * LIST_INDENT_TWIPS;
  if (paragraph.continuation != null) left = (left || 0) + (paragraph.continuation + 1) * LIST_INDENT_TWIPS;
  if (left != null || paragraph.firstLine != null) {
    const attributes = [];
    if (left != null) attributes.push(`w:left="${left}"`);
    if (paragraph.firstLine > 0) attributes.push(`w:firstLine="${paragraph.firstLine}"`);
    if (paragraph.firstLine < 0) attributes.push(`w:hanging="${-paragraph.firstLine}"`);
    properties.push(`<w:ind ${attributes.join(" ")}/>`);
  }
  if (paragraph.alignment && paragraph.alignment !== "left") {
    properties.push(`<w:jc w:val="${paragraph.alignment === "justify" ? "both" : paragraph.alignment}"/>`);
  }
  return `<w:pPr>${properties.join("")}</w:pPr>`;
}

function* documentXml(model) {
  yield `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${WORD_NS}" ` +
    `xmlns:r="${OFFICE_REL_NS}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ` +
    `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
    `xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>`;
  for (const paragraph of model.paragraphs) {
    yield `<w:p>${paragraphProperties(paragraph)}`;
    for (const run of paragraph.runs) {
      if (run.type === "text") yield* textRunXml(run);
      else if (run.type === "break") yield "<w:r><w:br/></w:r>";
      else if (run.type === "tab") yield "<w:r><w:tab/></w:r>";
      else yield imageRunXml(run);
    }
    yield "</w:p>";
  }
  yield '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="936" w:right="936" w:bottom="936" w:left="936" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>';
  yield "</w:body></w:document>";
}

// Paragraph and character styles mirroring the editor's stylesheet.
function stylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="${WORD_NS}">` +
    '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Arial" w:cs="Arial"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:color w:val="1D1D20"/></w:rPr></w:rPrDefault>' +
    '<w:pPrDefault><w:pPr><w:spacing w:after="180" w:line="360" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="180" w:line="360" w:lineRule="auto"/></w:pPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="10"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="0" w:after="60"/></w:pPr><w:rPr><w:b/><w:bCs/><w:sz w:val="45"/><w:szCs w:val="45"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="330" w:after="120"/></w:pPr><w:rPr><w:b/><w:bCs/><w:sz w:val="39"/><w:szCs w:val="39"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="270" w:after="90"/></w:pPr><w:rPr><w:b/><w:bCs/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="90"/></w:pPr><w:rPr><w:b/><w:bCs/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="E1632E"/></w:pBdr><w:spacing w:before="60" w:after="180"/><w:ind w:left="240" w:right="240"/></w:pPr><w:rPr><w:color w:val="6B6B73"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="CodeBlock"><w:name w:val="Code Block"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:pBdr><w:top w:val="single" w:sz="4" w:color="D9D9D7"/><w:left w:val="single" w:sz="4" w:color="D9D9D7"/><w:bottom w:val="single" w:sz="4" w:color="D9D9D7"/><w:right w:val="single" w:sz="4" w:color="D9D9D7"/></w:pBdr><w:shd w:val="clear" w:color="auto" w:fill="F3F3F1"/><w:spacing w:after="180" w:line="360" w:lineRule="auto"/><w:ind w:left="240" w:right="240"/></w:pPr><w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:eastAsia="Courier New" w:cs="Courier New"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>' +
    '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/><w:rPr><w:color w:val="E1632E"/><w:u w:val="single"/></w:rPr></w:style>' +
    "</w:styles>";
}

// One abstract definition per list kind; each HTML list gets its own numbering instance so
// numbering restarts where the document restarts it.
function* numberingXml(numbering) {
  yield `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="${WORD_NS}">`;
  for (const kind of new Set(numbering.map((item) => item.kind))) {
    yield `<w:abstractNum w:abstractNumId="${LIST_KINDS.indexOf(kind)}"><w:multiLevelType w:val="multilevel"/>`;
    for (let level = 0; level < 9; ++level) {
      const text = kind === "bullet" ? BULLET_GLYPHS[level % 3] : `%${level + 1}.`;
      const indent = (level + 1) * LIST_INDENT_TWIPS;
      yield `<w:lvl w:ilvl="${level}"><w:start w:val="1"/><w:numFmt w:val="${kind}"/>` +
        `<w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:tabs><w:tab w:val="num" w:pos="${indent}"/></w:tabs>` +
        `<w:ind w:left="${indent}" w:hanging="240"/></w:pPr></w:lvl>`;
    }
    yield "</w:abstractNum>";
  }
  for (const item of numbering) {
    yield `<w:num w:numId="${item.id}"><w:abstractNumId w:val="${LIST_KINDS.indexOf(item.kind)}"/>`;
    if (item.start != null) {
      yield `<w:lvlOverride w:ilvl="${item.level}"><w:startOverride w:val="${item.start}"/></w:lvlOverride>`;
    }
    yield "</w:num>";
  }
  yield "</w:numbering>";
}

function contentTypes(model) {
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>';
  for (const extension of [...new Set(model.images.map((image) => image.extension))].sort()) {
    xml += `<Default Extension="${extension === "jpeg" ? "jpg" : extension}" ContentType="image/${extension}"/>`;
  }
  xml += '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>';
  if (model.numbering.length) {
    xml += '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>';
  }
  return xml + "</Types>";
}

function rootRelationships() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PACKAGE_REL_NS}">` +
    `<Relationship Id="rId1" Type="${OFFICE_REL_NS}/officeDocument" Target="word/document.xml"/>` +
    `<Relationship Id="rId2" Type="${PACKAGE_REL_NS}/metadata/core-properties" Target="docProps/core.xml"/>` +
    `<Relationship Id="rId3" Type="${OFFICE_REL_NS}/extended-properties" Target="docProps/app.xml"/></Relationships>`;
}

function* documentRelationships(model) {
  yield `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PACKAGE_REL_NS}">`;
  yield `<Relationship Id="rId1" Type="${OFFICE_REL_NS}/styles" Target="styles.xml"/>`;
  if (model.numbering.length) yield `<Relationship Id="rId2" Type="${OFFICE_REL_NS}/numbering" Target="numbering.xml"/>`;
  for (const relationship of model.relationships) {
    yield `<Relationship Id="${relationship.id}" Type="${OFFICE_REL_NS}/${relationship.type}" ` +
      `Target="${xmlAttribute(relationship.target)}"${relationship.targetMode ? ` TargetMode="${relationship.targetMode}"` : ""}/>`;
  }
  yield "</Relationships>";
}

function coreProperties(snapshot) {
  const modified = snapshot.modified
    ? `<dcterms:modified xsi:type="dcterms:W3CDTF">${snapshot.modified}</dcterms:modified>` : "";
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${xmlText(snapshot.title)}</dc:title>${modified}</cp:coreProperties>`;
}

function appProperties() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
    'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
    '<Application>Gadgets Workspace Docs</Application></Properties>';
}

/**
 * Converts a document snapshot into a DOCX package, returned as a byte stream. The snapshot is
 * fully converted to the in-memory model before the stream is returned; only ZIP compression is
 * deferred to the reader.
 */
export async function documentToDocx(document) {
  const snapshot = normalizeSnapshot(document);
  const tree = await parseHtml(snapshot.fragments, await loadHtmlEntities());
  const model = new DocumentBuilder();
  walk(model, tree, {format: {}, paragraph: {}, style: "Normal"});
  if (!model.paragraphs.length) model.paragraphs.push({style: "Normal", runs: []});

  const entries = [
    {name: "[Content_Types].xml", data: contentTypes(model)},
    {name: "_rels/.rels", data: rootRelationships()},
    {name: "docProps/core.xml", data: coreProperties(snapshot)},
    {name: "docProps/app.xml", data: appProperties()},
    {name: "word/document.xml", data: textStream(documentXml(model))},
    {name: "word/styles.xml", data: stylesXml()},
  ];
  if (model.numbering.length) entries.push({name: "word/numbering.xml", data: textStream(numberingXml(model.numbering))});
  entries.push({name: "word/_rels/document.xml.rels", data: textStream(documentRelationships(model))});
  for (const image of model.images) entries.push({name: `word/media/${image.name}`, data: new Blob([image.bytes]).stream()});
  return createZip(entries);
}
