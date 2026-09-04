import { createZip, crc32 } from "./zip.js";
import { loadHtmlEntities } from "./html-entities.js";

const encoder = new TextEncoder();
const WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const OFFICE_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const CONTENT_WIDTH_PIXELS = 691.2;
const CONTENT_HEIGHT_PIXELS = 931.2;
const EMUS_PER_PIXEL = 9525;
const IMAGE_MASK_THRESHOLD = 2 * 1024 * 1024;

export const DOCX_LIMITS = Object.freeze({
  blocks: 50_000,
  htmlBytes: 16 * 1024 * 1024,
  nodes: 100_000,
  depth: 128,
  textCharacters: 4 * 1024 * 1024,
  paragraphs: 25_000,
  runs: 100_000,
  relationships: 2_048,
  images: 128,
  imageEncodedBytes: 8 * 1024 * 1024,
  imageDecodedBytes: 6 * 1024 * 1024,
  aggregateImageEncodedBytes: 24 * 1024 * 1024,
  aggregateImageDecodedBytes: 18 * 1024 * 1024,
  imageDimension: 16_384,
  imagePixels: 40_000_000,
  aggregateImagePixels: 100_000_000,
  imageFrames: 1_000,
  aggregateImageFrames: 4_000,
});

const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param",
  "source", "track", "wbr",
]);
const IGNORED_CONTENT_TAGS = new Set([
  "head", "script", "style", "template", "noscript", "iframe", "object", "embed", "svg", "math",
]);
const BLOCK_TAGS = new Set([
  "p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "ul", "ol", "li",
  "table", "tr", "hr",
]);
const P_CLOSING_TAGS = new Set([
  "address", "article", "aside", "blockquote", "div", "dl", "fieldset", "footer", "form", "h1", "h2",
  "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "main", "menu", "nav", "ol", "p", "pre",
  "section", "table", "ul",
]);
const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const STORED_ATTRIBUTES = [
  "style", "class", "href", "src", "alt", "width", "height", "face", "size", "color", "start", "value",
  "data-doc-indent",
];

function cleanXml(value) {
  const input = String(value ?? "");
  let result = "";
  for (let index = 0; index < input.length; ++index) {
    const code = input.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = input.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) result += input[index] + input[++index];
      else result += "\ufffd";
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      result += "\ufffd";
    } else if (code === 9 || code === 10 || code === 13 ||
        (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd)) {
      result += code === 0xfffe || code === 0xffff ? "\ufffd" : input[index];
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

function relationshipAttribute(value) {
  return xmlAttribute(value);
}

function decodeHtmlEntities(value, namedEntities) {
  return String(value).replace(/&(#(?:[xX][0-9a-fA-F]+|\d+)|[0-9A-Za-z]+);/g, (match, entity) => {
    if (!entity.startsWith("#")) {
      return Object.hasOwn(namedEntities, entity) ? namedEntities[entity] : match;
    }
    const hexadecimal = entity[1]?.toLowerCase() === "x";
    const codePoint = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
    if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10ffff ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff)) return "\ufffd";
    return String.fromCodePoint(codePoint);
  });
}

const DATA_IMAGE_PATTERN = /data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=]+/gi;

function maskImageSources(source) {
  let marker = null;
  const images = [];
  const html = source.replace(DATA_IMAGE_PATTERN, (image) => {
    const payloadLength = image.length - image.indexOf(",") - 1;
    if (payloadLength < IMAGE_MASK_THRESHOLD) return image;
    if (!marker) {
      for (let attempt = 0; attempt < 2; ++attempt) {
        const candidate = `docx-masked-image-${crypto.randomUUID()}:`;
        if (!source.includes(candidate)) {
          marker = candidate;
          break;
        }
      }
      if (!marker) throw new Error("DOCX source could not reserve an image marker.");
    }
    const token = `${marker}${images.length}:`;
    images.push(image);
    return token;
  });
  return {html, images, pattern: marker && new RegExp(`${marker}(\\d+):`, "g")};
}

function restoreImageSources(value, masked) {
  if (!masked.images.length) return value;
  return value.replace(masked.pattern, (match, index) => masked.images[Number(index)] ?? match);
}

function textStream(iterable) {
  const iterator = iterable[Symbol.iterator]();
  return new ReadableStream({
    pull(controller) {
      const result = iterator.next();
      if (result.done) controller.close();
      else controller.enqueue(encoder.encode(result.value));
    },
    cancel(reason) {
      if (iterator.return) iterator.return(reason);
    },
  });
}

function normalizeSnapshot(document) {
  const source = document && typeof document === "object" ? document : {};
  const sourceBlocks = Array.isArray(source.blocks) ? source.blocks : null;
  if (sourceBlocks && sourceBlocks.length > DOCX_LIMITS.blocks) {
    throw new Error(`DOCX block count exceeds the ${DOCX_LIMITS.blocks}-block export limit.`);
  }
  const fragments = [];
  let htmlBytes = 0;
  for (const value of sourceBlocks || [source.legacyContent]) {
    const fragment = String(sourceBlocks ? value?.html ?? "" : value ?? "");
    htmlBytes += encoder.encode(fragment).byteLength;
    if (htmlBytes > DOCX_LIMITS.htmlBytes) {
      throw new Error(`DOCX source HTML exceeds the ${DOCX_LIMITS.htmlBytes}-byte export limit.`);
    }
    fragments.push(fragment);
  }
  const title = String(source.title ?? "");
  if (title.length > 8192) throw new Error("DOCX title exceeds the 8,192-character export limit.");
  return {fragments, title, modified: modifiedTimestamp(source.lastModified)};
}

function modifiedTimestamp(value) {
  if (value == null || value === "" || (typeof value !== "number" && typeof value !== "string")) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function retainedAttribute(element, name, namedEntities, masked) {
  let value = element.getAttribute(name);
  if (value == null) return null;
  value = restoreImageSources(value, masked);
  const maximum = name === "src" ? DOCX_LIMITS.imageEncodedBytes + 128 : name === "style" ? 65_536 : 8192;
  if (value.length <= maximum) return decodeHtmlEntities(value, namedEntities);
  if (name === "src" && /^data:/i.test(value)) {
    throw new Error(`DOCX image encoded data exceeds the ${DOCX_LIMITS.imageEncodedBytes}-byte per-image limit.`);
  }
  if (name === "style") throw new Error("DOCX inline style exceeds the 65,536-character export limit.");
  return null;
}

function closeImpliedElements(stack, tag) {
  const close = (tags) => {
    for (let index = stack.length - 1; index > 0; --index) {
      if (tags.has(stack[index].tag)) {
        stack.length = index;
        return;
      }
    }
  };
  const closeWithin = (tags, boundaries) => {
    for (let index = stack.length - 1; index > 0; --index) {
      if (boundaries.has(stack[index].tag)) return;
      if (tags.has(stack[index].tag)) {
        stack.length = index;
        return;
      }
    }
  };
  if (P_CLOSING_TAGS.has(tag)) close(new Set(["p"]));
  if (tag === "li") closeWithin(new Set(["li"]), new Set(["ul", "ol"]));
  if (tag === "dt" || tag === "dd") closeWithin(new Set(["dt", "dd"]), new Set(["dl"]));
  if (HEADING_TAGS.has(tag)) close(HEADING_TAGS);
  if (tag === "tr") closeWithin(new Set(["tr"]), new Set(["table"]));
  if (tag === "td" || tag === "th") closeWithin(new Set(["td", "th"]), new Set(["tr", "table"]));
}

async function parseHtml(fragments, namedEntities) {
  const root = {tag: "#document", attrs: {}, children: []};
  let nodeCount = 0;
  let textCharacters = 0;
  let failure = null;

  const countNode = () => {
    if (++nodeCount > DOCX_LIMITS.nodes) {
      throw new Error(`DOCX HTML node count exceeds the ${DOCX_LIMITS.nodes}-node export limit.`);
    }
  };
  for (const source of fragments) {
    const masked = maskImageSources(source);
    const html = masked.html;
    const stack = [root];
    let pendingText = "";
    let pendingParent = null;
    const rewriter = new HTMLRewriter().on("*", {
      element(element) {
        if (failure) return;
        try {
          countNode();
          const tag = element.tagName.toLowerCase();
          closeImpliedElements(stack, tag);
          if (stack.length > DOCX_LIMITS.depth) {
            throw new Error(`DOCX HTML nesting exceeds the ${DOCX_LIMITS.depth}-level export limit.`);
          }
          const attrs = {};
          for (const name of STORED_ATTRIBUTES) {
            const value = retainedAttribute(element, name, namedEntities, masked);
            if (value != null) attrs[name] = value;
          }
          const node = {tag, attrs, children: []};
          stack.at(-1).children.push(node);
          if (!VOID_TAGS.has(tag)) {
            try {
              element.onEndTag(() => {
                const index = stack.lastIndexOf(node);
                if (index >= 0) stack.length = index;
              });
              stack.push(node);
            } catch (error) {
              if (element.namespaceURI === "http://www.w3.org/1999/xhtml") throw error;
            }
          }
        } catch (error) {
          failure = error;
        }
      },
    }).onDocument({
      text(text) {
        if (failure) return;
        try {
          if (!pendingText && text.text) {
            countNode();
            pendingParent = stack.at(-1);
          }
          pendingText += text.text;
          if (!text.lastInTextNode || !pendingText) return;
          const decoded = decodeHtmlEntities(restoreImageSources(pendingText, masked), namedEntities);
          textCharacters += decoded.length;
          if (textCharacters > DOCX_LIMITS.textCharacters) {
            throw new Error(`DOCX text exceeds the ${DOCX_LIMITS.textCharacters}-character export limit.`);
          }
          const children = pendingParent.children;
          if (typeof children.at(-1) === "string") children[children.length - 1] += decoded;
          else children.push(decoded);
          pendingText = "";
          pendingParent = null;
        } catch (error) {
          failure = error;
        }
      },
    });
    const output = rewriter.transform(new Response(html, {headers: {"content-type": "text/html; charset=utf-8"}}));
    await output.body.pipeTo(new WritableStream());
    if (failure) throw failure;
    root.children.push({tag: "#boundary", attrs: {}, children: []});
  }
  return root;
}

function cssDeclarations(node) {
  if (node.css) return node.css;
  const source = node.attrs?.style || "";
  const declarations = [];
  let start = 0;
  let quote = "";
  let parentheses = 0;
  const add = (part) => {
    const colon = part.indexOf(":");
    if (colon < 0 || declarations.length >= 256) return;
    const name = part.slice(0, colon).trim().toLowerCase();
    const value = part.slice(colon + 1).trim();
    if (name && value) declarations.push([name, value]);
  };
  for (let index = 0; index <= source.length; ++index) {
    const character = source[index];
    if (quote) {
      if (character === quote && source[index - 1] !== "\\") quote = "";
    } else if (character === "\"" || character === "'") {
      quote = character;
    } else if (character === "(") {
      ++parentheses;
    } else if (character === ")" && parentheses) {
      --parentheses;
    } else if ((character === ";" || index === source.length) && !parentheses) {
      add(source.slice(start, index));
      start = index + 1;
    }
  }
  node.css = declarations;
  return declarations;
}

function cssColor(value) {
  const input = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(input)?.[1];
  if (hex) {
    if (hex.length <= 4) return (hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2]).toUpperCase();
    return hex.slice(0, 6).toUpperCase();
  }
  const rgb = /^rgba?\(\s*([^)]*)\)$/i.exec(input)?.[1];
  if (!rgb) return null;
  const parts = rgb.includes(",") ? rgb.split(",") : rgb.split(/\s+(?:\/\s*)?/);
  if (parts.length < 3) return null;
  const channels = parts.slice(0, 3).map((part) => {
    const text = part.trim();
    const number = Number.parseFloat(text);
    if (!Number.isFinite(number)) return null;
    const result = text.endsWith("%") ? number * 2.55 : number;
    return result >= 0 && result <= 255 ? Math.round(result) : null;
  });
  if (channels.some((channel) => channel == null)) return null;
  return channels.map((channel) => channel.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function fontFamily(value) {
  const first = value.split(",", 1)[0].trim().replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2");
  const lower = first.toLowerCase();
  if (["inherit", "unset", "revert", "revert-layer"].includes(lower)) return undefined;
  if (["initial", "ui-sans-serif", "system-ui", "-apple-system", "sans-serif"].includes(lower)) return "Arial";
  if (["ui-serif", "serif"].includes(lower)) return "Georgia";
  if (["ui-monospace", "monospace"].includes(lower)) return "Courier New";
  const clean = cleanXml(first).replace(/[\r\n\t]/g, " ").trim();
  return clean && clean.length <= 100 ? clean : null;
}

function halfPoints(value) {
  const match = /^(-?(?:\d+(?:\.\d*)?|\.\d+))\s*(px|pt)?$/i.exec(value.trim());
  if (!match) return null;
  let points = Number(match[1]);
  if (match[2]?.toLowerCase() !== "pt") points *= 0.75;
  if (!Number.isFinite(points) || points < 1 || points > 200) return null;
  return Math.max(2, Math.round(points * 2));
}

function htmlFontSize(value) {
  const level = Math.round(Number(value));
  return [0, 16, 20, 24, 28, 36, 48, 72][level] || null;
}

function applyTextDecoration(format, value) {
  const lower = value.toLowerCase();
  if (/\bnone\b/.test(lower)) {
    format.underline = false;
    format.strike = false;
    return;
  }
  format.underline = /\bunderline\b/.test(lower);
  format.strike = /\bline-through\b/.test(lower);
}

function deriveFormat(parent, node) {
  const format = {...parent};
  if (["strong", "b"].includes(node.tag)) format.bold = true;
  if (["em", "i"].includes(node.tag)) format.italic = true;
  if (node.tag === "u") format.underline = true;
  if (["s", "strike", "del"].includes(node.tag)) format.strike = true;
  if (node.tag === "code") format.font = "Courier New";
  if (node.tag === "font") {
    if (node.attrs.face) {
      const font = fontFamily(node.attrs.face);
      if (font !== undefined) format.font = font;
    }
    const size = htmlFontSize(node.attrs.size);
    if (size) format.size = size;
    const color = cssColor(node.attrs.color || "");
    if (color) format.color = color;
  }
  for (const [name, value] of cssDeclarations(node)) {
    const lower = value.toLowerCase();
    if (name === "font-family") {
      const font = fontFamily(value);
      if (font !== undefined) format.font = font;
    } else if (name === "font-size") {
      if (lower === "initial") format.size = 22;
      else if (!["inherit", "unset"].includes(lower)) {
        const size = halfPoints(value);
        if (size) format.size = size;
      }
    } else if (name === "font-weight") {
      if (["normal", "initial"].includes(lower)) format.bold = false;
      else if (lower === "bold" || lower === "bolder") format.bold = true;
      else if (lower !== "unset" && /^\d+$/.test(lower)) format.bold = Number(lower) >= 600;
    } else if (name === "font-style") {
      if (["normal", "initial"].includes(lower)) format.italic = false;
      else if (lower === "italic" || lower === "oblique") format.italic = true;
    } else if (name === "text-decoration" || name === "text-decoration-line") {
      if (lower !== "inherit") applyTextDecoration(format, value);
    } else if (name === "color") {
      if (lower === "initial") format.color = "1D1D20";
      else if (!["inherit", "unset"].includes(lower)) {
        const color = cssColor(value);
        if (color) format.color = color;
      }
    } else if (name === "background-color") {
      if (["transparent", "initial", "unset"].includes(lower)) format.shading = null;
      else if (lower !== "inherit") {
        const color = cssColor(value);
        if (color) format.shading = color;
      }
    }
  }
  return format;
}

function cssLengthTwips(value) {
  const match = /^(-?(?:\d+(?:\.\d*)?|\.\d+))\s*(px|pt|in|cm|mm)?$/i.exec(value.trim());
  if (!match) return null;
  const number = Number(match[1]);
  const unit = (match[2] || "px").toLowerCase();
  const twips = unit === "in" ? number * 1440 : unit === "cm" ? number * 1440 / 2.54
    : unit === "mm" ? number * 1440 / 25.4 : unit === "pt" ? number * 20 : number * 15;
  return Number.isFinite(twips) ? Math.round(twips) : null;
}

function cssBoxLeft(value) {
  const parts = value.trim().split(/\s+/);
  if (!parts.length || parts.length > 4) return null;
  return parts.length === 1 ? parts[0] : parts.length === 4 ? parts[3] : parts[1];
}

function isEditorIndentation(node) {
  if (node.tag !== "blockquote") return false;
  if (Object.hasOwn(node.attrs, "data-doc-indent")) return true;
  let borderless = false;
  let paddingless = false;
  let left = null;
  let marginSignature = false;
  for (const [name, value] of cssDeclarations(node)) {
    if (name === "border") borderless = value.trim().toLowerCase() === "none";
    if (name === "border-left") borderless = false;
    if (name === "padding") {
      const parts = value.trim().split(/\s+/);
      paddingless = parts.length >= 1 && parts.length <= 4 && parts.every((part) => cssLengthTwips(part) === 0);
    }
    if (name === "padding-left") paddingless = false;
    if (name === "margin") {
      const parts = value.trim().split(/\s+/);
      marginSignature = parts.length === 4 && parts.slice(0, 3).every((part) => cssLengthTwips(part) === 0);
      left = marginSignature ? parts[3] : null;
    }
    if (name === "margin-left") marginSignature = false;
  }
  const twips = left == null ? null : cssLengthTwips(left);
  return borderless && paddingless && marginSignature && twips != null && twips > 0;
}

function lineSpacing(value, format) {
  const lower = value.trim().toLowerCase();
  if (/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(lower)) {
    const multiple = Number(lower);
    return multiple >= 0.5 && multiple <= 10 ? {line: Math.round(multiple * 240), lineRule: "auto"} : null;
  }
  if (/^(?:\d+(?:\.\d*)?|\.\d+)%$/.test(lower)) {
    const percent = Number.parseFloat(lower);
    return percent >= 50 && percent <= 1000 ? {line: Math.round(percent * 2.4), lineRule: "auto"} : null;
  }
  const twips = cssLengthTwips(value);
  if (twips != null && twips > 0 && twips <= 20_000) return {line: twips, lineRule: "exact"};
  if (lower === "normal") {
    const sizePoints = (format.size || 22) / 2;
    return {line: Math.round(sizePoints * 1.2 * 20), lineRule: "exact"};
  }
  return null;
}

function deriveParagraph(parent, node, format) {
  const paragraph = {...parent};
  const relativeIndent = isEditorIndentation(node);
  for (const [name, value] of cssDeclarations(node)) {
    const lower = value.toLowerCase();
    if (name === "text-align") {
      if (["left", "start", "initial"].includes(lower)) paragraph.alignment = "left";
      else if (lower === "center" || lower === "right" || lower === "justify") paragraph.alignment = lower;
    } else if (name === "margin" || name === "margin-left") {
      const source = name === "margin" ? cssBoxLeft(value) : value;
      const sourceLower = source?.toLowerCase();
      if (["initial", "unset"].includes(sourceLower)) paragraph.left = 0;
      else if (source && sourceLower !== "inherit") {
        const left = cssLengthTwips(source);
        if (left != null) {
          const inherited = relativeIndent ? parent.left || 0 : 0;
          paragraph.left = Math.max(0, Math.min(14_400, inherited + left));
        }
      }
    } else if (name === "padding-left") {
      const padding = cssLengthTwips(value);
      if (padding != null) paragraph.left = Math.max(0, Math.min(14_400, (paragraph.left || 0) + padding));
    } else if (name === "text-indent") {
      if (lower === "initial") paragraph.firstLine = 0;
      else if (!["inherit", "unset"].includes(lower)) {
        const firstLine = cssLengthTwips(value);
        if (firstLine != null) paragraph.firstLine = Math.max(-7200, Math.min(7200, firstLine));
      }
    } else if (name === "line-height" && !["inherit", "unset"].includes(lower)) {
      const spacing = lineSpacing(lower === "initial" ? "normal" : value, format);
      if (spacing) Object.assign(paragraph, spacing);
    }
  }
  return paragraph;
}

function formatKey(format) {
  return [format.bold, format.italic, format.underline, format.strike, format.font, format.size,
    format.color, format.shading].join("|");
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
  if (!["http:", "https:", "mailto:", "tel:"].includes(url.protocol.toLowerCase())) return null;
  if (url.username || url.password) return null;
  if ((url.protocol === "http:" || url.protocol === "https:") && !url.hostname) return null;
  return url.href;
}

function uint16be(bytes, offset) {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function uint32be(bytes, offset) {
  return ((bytes[offset] * 0x1000000) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3]) >>> 0;
}

function uint16le(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function uint24le(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function uint32le(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)) >>> 0;
}

function ascii(bytes, offset, length) {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function pngDimensions(bytes) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 45 || signature.some((value, index) => bytes[index] !== value)) return null;
  let dimensions = null;
  let seenImageData = false;
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = uint32be(bytes, offset);
    const data = offset + 8;
    const end = data + length;
    if (length > bytes.length - data - 4) return null;
    const kind = ascii(bytes, offset + 4, 4);
    if (crc32(bytes.subarray(offset + 4, end)) !== uint32be(bytes, end)) return null;
    if (offset === 8) {
      if (kind !== "IHDR" || length !== 13) return null;
      dimensions = {width: uint32be(bytes, data), height: uint32be(bytes, data + 4)};
    } else if (kind === "IDAT") {
      seenImageData = true;
    } else if (kind === "IEND") {
      return length === 0 && end + 4 === bytes.length && seenImageData ? dimensions : null;
    }
    offset = end + 4;
  }
  return null;
}

function skipGifSubBlocks(bytes, offset) {
  while (offset < bytes.length) {
    const length = bytes[offset++];
    if (!length) return offset;
    if (length > bytes.length - offset) return -1;
    offset += length;
  }
  return -1;
}

function gifDimensions(bytes) {
  if (bytes.length < 14 || !["GIF87a", "GIF89a"].includes(ascii(bytes, 0, 6))) return null;
  const width = uint16le(bytes, 6);
  const height = uint16le(bytes, 8);
  let maximumWidth = width;
  let maximumHeight = height;
  let framePixels = 0;
  let frames = 0;
  let offset = 13;
  if (bytes[10] & 0x80) offset += 3 * (2 << (bytes[10] & 0x07));
  if (offset > bytes.length) return null;
  while (offset < bytes.length) {
    const marker = bytes[offset++];
    if (marker === 0x3b) {
      return frames && offset === bytes.length
        ? {width, height, maximumWidth, maximumHeight, pixels: Math.max(width * height, framePixels), frames} : null;
    }
    if (marker === 0x21) {
      if (offset >= bytes.length) return null;
      ++offset;
      offset = skipGifSubBlocks(bytes, offset);
      if (offset < 0) return null;
      continue;
    }
    if (marker !== 0x2c || offset + 9 > bytes.length) return null;
    const frameWidth = uint16le(bytes, offset + 4);
    const frameHeight = uint16le(bytes, offset + 6);
    if (!frameWidth || !frameHeight) return null;
    maximumWidth = Math.max(maximumWidth, frameWidth);
    maximumHeight = Math.max(maximumHeight, frameHeight);
    framePixels += frameWidth * frameHeight;
    if (++frames > DOCX_LIMITS.imageFrames) {
      throw new Error(`DOCX GIF frame count exceeds the ${DOCX_LIMITS.imageFrames}-frame per-image limit.`);
    }
    const packed = bytes[offset + 8];
    offset += 9;
    if (packed & 0x80) offset += 3 * (2 << (packed & 0x07));
    if (offset >= bytes.length) return null;
    ++offset;
    offset = skipGifSubBlocks(bytes, offset);
    if (offset < 0) return null;
  }
  return null;
}

function jpegDimensions(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let dimensions = null;
  for (let offset = 2; offset + 3 < bytes.length;) {
    if (bytes[offset++] !== 0xff) return null;
    while (bytes[offset] === 0xff) ++offset;
    const marker = bytes[offset++];
    if (marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (offset + 1 >= bytes.length) return null;
    const length = uint16be(bytes, offset);
    if (length < 2 || offset + length > bytes.length) return null;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 7) return null;
      dimensions = {width: uint16be(bytes, offset + 5), height: uint16be(bytes, offset + 3)};
    }
    if (marker === 0xda) {
      return length >= 6 && dimensions && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9 ? dimensions : null;
    }
    offset += length;
  }
  return null;
}

function webpFrameDimensions(bytes, offset, end) {
  let dimensions = null;
  while (offset + 8 <= end) {
    const kind = ascii(bytes, offset, 4);
    const length = uint32le(bytes, offset + 4);
    const data = offset + 8;
    if (length > end - data) return null;
    if (kind === "VP8 " && length >= 10 && bytes[data + 3] === 0x9d &&
        bytes[data + 4] === 0x01 && bytes[data + 5] === 0x2a) {
      if (dimensions) return null;
      dimensions = {width: uint16le(bytes, data + 6) & 0x3fff, height: uint16le(bytes, data + 8) & 0x3fff};
    } else if (kind === "VP8L" && length >= 5 && bytes[data] === 0x2f) {
      if (dimensions) return null;
      dimensions = {
        width: 1 + bytes[data + 1] + ((bytes[data + 2] & 0x3f) << 8),
        height: 1 + (bytes[data + 2] >> 6) + (bytes[data + 3] << 2) + ((bytes[data + 4] & 0x0f) << 10),
      };
    }
    offset = data + length + (length & 1);
  }
  return offset === end ? dimensions : null;
}

function webpDimensions(bytes) {
  if (bytes.length < 30 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP" ||
      uint32le(bytes, 4) + 8 !== bytes.length) return null;
  let extendedDimensions = null;
  let seenImageData = false;
  let maximumWidth = 0;
  let maximumHeight = 0;
  let framePixels = 0;
  let frames = 0;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const kind = ascii(bytes, offset, 4);
    const length = uint32le(bytes, offset + 4);
    const data = offset + 8;
    if (length > bytes.length - data) return null;
    if (kind === "VP8X" && length >= 10) {
      extendedDimensions = {
        width: 1 + bytes[data + 4] + (bytes[data + 5] << 8) + (bytes[data + 6] << 16),
        height: 1 + bytes[data + 7] + (bytes[data + 8] << 8) + (bytes[data + 9] << 16),
      };
    }
    if (kind === "VP8 " && length >= 10 && bytes[data + 3] === 0x9d && bytes[data + 4] === 0x01 && bytes[data + 5] === 0x2a) {
      seenImageData = true;
      if (!extendedDimensions) {
        extendedDimensions = {width: uint16le(bytes, data + 6) & 0x3fff, height: uint16le(bytes, data + 8) & 0x3fff};
      }
    }
    if (kind === "VP8L" && length >= 5 && bytes[data] === 0x2f) {
      seenImageData = true;
      if (!extendedDimensions) {
        extendedDimensions = {
          width: 1 + bytes[data + 1] + ((bytes[data + 2] & 0x3f) << 8),
          height: 1 + (bytes[data + 2] >> 6) + (bytes[data + 3] << 2) + ((bytes[data + 4] & 0x0f) << 10),
        };
      }
    }
    if (kind === "ANMF" && length >= 16) {
      const frameWidth = 1 + uint24le(bytes, data + 6);
      const frameHeight = 1 + uint24le(bytes, data + 9);
      const encoded = webpFrameDimensions(bytes, data + 16, data + length);
      if (!encoded || encoded.width !== frameWidth || encoded.height !== frameHeight) return null;
      maximumWidth = Math.max(maximumWidth, frameWidth);
      maximumHeight = Math.max(maximumHeight, frameHeight);
      framePixels = Math.min(Number.MAX_SAFE_INTEGER, framePixels + frameWidth * frameHeight);
      if (++frames > DOCX_LIMITS.imageFrames) {
        throw new Error(`DOCX animation frame count exceeds the ${DOCX_LIMITS.imageFrames}-frame per-image limit.`);
      }
      seenImageData = true;
    }
    offset = data + length + (length & 1);
  }
  if (!seenImageData || !extendedDimensions) return null;
  return {
    ...extendedDimensions,
    maximumWidth: Math.max(extendedDimensions.width, maximumWidth),
    maximumHeight: Math.max(extendedDimensions.height, maximumHeight),
    pixels: Math.max(extendedDimensions.width * extendedDimensions.height, framePixels),
    frames,
  };
}

function decodedImage(source, totals) {
  const comma = source.indexOf(",");
  if (comma < 0) return null;
  const metadata = /^data:(image\/(?:png|jpe?g|gif|webp));base64$/i.exec(source.slice(0, comma));
  if (!metadata) return null;
  const payload = source.slice(comma + 1);
  if (payload.length > DOCX_LIMITS.imageEncodedBytes) {
    throw new Error(`DOCX image encoded data exceeds the ${DOCX_LIMITS.imageEncodedBytes}-byte per-image limit.`);
  }
  if (totals.encoded + payload.length > DOCX_LIMITS.aggregateImageEncodedBytes) {
    throw new Error(`DOCX image encoded data exceeds the ${DOCX_LIMITS.aggregateImageEncodedBytes}-byte aggregate limit.`);
  }
  totals.encoded += payload.length;
  if (!payload || payload.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payload)) return null;
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  const decodedLength = payload.length / 4 * 3 - padding;
  if (decodedLength > DOCX_LIMITS.imageDecodedBytes) {
    throw new Error(`DOCX image decoded data exceeds the ${DOCX_LIMITS.imageDecodedBytes}-byte per-image limit.`);
  }
  if (totals.decoded + decodedLength > DOCX_LIMITS.aggregateImageDecodedBytes) {
    throw new Error(`DOCX image decoded data exceeds the ${DOCX_LIMITS.aggregateImageDecodedBytes}-byte aggregate limit.`);
  }
  totals.decoded += decodedLength;
  let bytes;
  try {
    bytes = Uint8Array.fromBase64(payload);
  } catch {
    return null;
  }
  if (bytes.byteLength !== decodedLength) return null;
  const declaredMime = metadata[1].toLowerCase();
  const mime = declaredMime === "image/jpg" ? "image/jpeg" : declaredMime;
  const dimensions = mime === "image/png" ? pngDimensions(bytes) : mime === "image/jpeg" ? jpegDimensions(bytes)
    : mime === "image/gif" ? gifDimensions(bytes) : webpDimensions(bytes);
  if (!dimensions || !dimensions.width || !dimensions.height) return null;
  const maximumWidth = dimensions.maximumWidth || dimensions.width;
  const maximumHeight = dimensions.maximumHeight || dimensions.height;
  if (maximumWidth > DOCX_LIMITS.imageDimension || maximumHeight > DOCX_LIMITS.imageDimension) {
    throw new Error(`DOCX image dimensions exceed the ${DOCX_LIMITS.imageDimension}-pixel per-axis limit.`);
  }
  const pixels = dimensions.pixels || dimensions.width * dimensions.height;
  if (pixels > DOCX_LIMITS.imagePixels) {
    throw new Error(`DOCX image pixel count exceeds the ${DOCX_LIMITS.imagePixels}-pixel per-image limit.`);
  }
  if (totals.pixels + pixels > DOCX_LIMITS.aggregateImagePixels) {
    throw new Error(`DOCX image pixel count exceeds the ${DOCX_LIMITS.aggregateImagePixels}-pixel aggregate limit.`);
  }
  totals.pixels += pixels;
  const frames = dimensions.frames || 0;
  if (totals.frames + frames > DOCX_LIMITS.aggregateImageFrames) {
    throw new Error(`DOCX animation frame count exceeds the ${DOCX_LIMITS.aggregateImageFrames}-frame aggregate limit.`);
  }
  totals.frames += frames;
  return {
    bytes, mime, width: dimensions.width, height: dimensions.height,
    extension: mime === "image/jpeg" ? "jpg" : mime.slice("image/".length),
  };
}

function imageWidth(node) {
  let source = node.attrs.width || "";
  for (const [name, value] of cssDeclarations(node)) if (name === "width") source = value;
  const percent = /^(\d+(?:\.\d+)?)%$/.exec(source.trim());
  if (percent) {
    const value = Number(percent[1]);
    return value > 0 && value <= 1000 ? CONTENT_WIDTH_PIXELS * value / 100 : null;
  }
  const twips = cssLengthTwips(source);
  return twips != null && twips > 0 ? twips / 15 : null;
}

class DocumentBuilder {
  constructor(snapshot) {
    this.title = snapshot.title;
    this.modified = snapshot.modified;
    this.paragraphs = [];
    this.runCount = 0;
    this.relationships = [];
    this.hyperlinks = new Map();
    this.imagesBySource = new Map();
    this.images = [];
    this.imageTotals = {encoded: 0, decoded: 0, pixels: 0, frames: 0};
    this.imageOccurrences = 0;
    this.drawingCount = 0;
    this.numbering = [];
  }

  paragraph(options = {}) {
    if (this.paragraphs.length >= DOCX_LIMITS.paragraphs) {
      throw new Error(`DOCX paragraph count exceeds the ${DOCX_LIMITS.paragraphs}-paragraph export limit.`);
    }
    const paragraph = {style: "Normal", runs: [], ...options, hasContent: false, trailingSpace: false, lineStart: true};
    this.paragraphs.push(paragraph);
    return paragraph;
  }

  relationship(type, target, targetMode) {
    if (this.relationships.length >= DOCX_LIMITS.relationships - 2) {
      throw new Error(`DOCX relationship count exceeds the ${DOCX_LIMITS.relationships}-relationship export limit.`);
    }
    const relationship = {id: `rId${this.relationships.length + 3}`, type, target, targetMode};
    this.relationships.push(relationship);
    return relationship.id;
  }

  hyperlink(target) {
    if (!target) return null;
    let id = this.hyperlinks.get(target);
    if (!id) {
      id = this.relationship("hyperlink", target, "External");
      this.hyperlinks.set(target, id);
    }
    return id;
  }

  addRun(paragraph, run) {
    if (run.type === "text" && !run.text) return;
    const last = paragraph.runs.at(-1);
    if (run.type === "text" && last?.type === "text" && last.key === run.key && last.hyperlink === run.hyperlink) {
      last.text += run.text;
    } else {
      if (++this.runCount > DOCX_LIMITS.runs) {
        throw new Error(`DOCX run count exceeds the ${DOCX_LIMITS.runs}-run export limit.`);
      }
      paragraph.runs.push(run);
    }
    paragraph.hasContent = true;
    paragraph.trailingSpace = run.type === "text" && run.text.endsWith(" ");
    paragraph.lineStart = run.type === "break";
  }

  text(paragraph, value, format, hyperlinkTarget, preformatted = false) {
    let text = cleanXml(value);
    if (!preformatted) {
      text = text.replace(/[\t\n\f\r ]+/g, " ");
      if ((paragraph.lineStart || paragraph.trailingSpace) && text.startsWith(" ")) text = text.slice(1);
      if (text.endsWith(" ")) paragraph.trailingSpace = true;
    }
    if (!text) return;
    const hyperlink = this.hyperlink(hyperlinkTarget);
    this.addRun(paragraph, {type: "text", text, format, key: formatKey(format), hyperlink});
  }

  break(paragraph) {
    this.addRun(paragraph, {type: "break"});
    paragraph.trailingSpace = false;
  }

  tab(paragraph) {
    this.addRun(paragraph, {type: "tab"});
    paragraph.trailingSpace = false;
  }

  list(kind, level, start) {
    const id = this.numbering.length + 1;
    this.numbering.push({id, kind, level, start});
    return id;
  }

  image(paragraph, node, format, hyperlinkTarget) {
    if (++this.imageOccurrences > DOCX_LIMITS.images) {
      throw new Error(`DOCX image count exceeds the ${DOCX_LIMITS.images}-image export limit.`);
    }
    const source = node.attrs.src || "";
    const knownSource = this.imagesBySource.has(source);
    let image = this.imagesBySource.get(source);
    if (!knownSource && /^data:/i.test(source)) {
      const decoded = decodedImage(source, this.imageTotals);
      if (decoded) {
        const mediaId = this.images.length + 1;
        const name = `image${mediaId}.${decoded.extension}`;
        image = {
          ...decoded, name, relationship: this.relationship("image", `media/${name}`),
        };
        this.images.push(image);
      }
      this.imagesBySource.set(source, image || null);
    }
    const alt = cleanXml(node.attrs.alt || "").slice(0, 8192);
    if (!image) {
      this.text(paragraph, alt || "[Image unavailable]", format, hyperlinkTarget, false);
      return;
    }
    const requestedWidth = imageWidth(node);
    let width = Math.min(CONTENT_WIDTH_PIXELS, requestedWidth || image.width);
    let height = width * image.height / image.width;
    if (height > CONTENT_HEIGHT_PIXELS) {
      width *= CONTENT_HEIGHT_PIXELS / height;
      height = CONTENT_HEIGHT_PIXELS;
    }
    const drawingId = ++this.drawingCount;
    this.addRun(paragraph, {
      type: "image", image, drawingId, alt, hyperlink: this.hyperlink(hyperlinkTarget),
      cx: Math.max(1, Math.round(width * EMUS_PER_PIXEL)),
      cy: Math.max(1, Math.round(height * EMUS_PER_PIXEL)),
    });
  }
}

function hasBlockChild(node) {
  return node.children.some((child) => typeof child !== "string" && BLOCK_TAGS.has(child.tag));
}

function paragraphOptions(style, paragraph) {
  return {
    style,
    alignment: paragraph.alignment,
    left: paragraph.left,
    firstLine: paragraph.firstLine,
    line: paragraph.line,
    lineRule: paragraph.lineRule,
  };
}

function appendInline(builder, paragraph, child, format, paragraphFormat, hyperlinkTarget, preformatted) {
  if (typeof child === "string") {
    builder.text(paragraph, child, format, hyperlinkTarget, preformatted);
    return;
  }
  if (IGNORED_CONTENT_TAGS.has(child.tag) || child.tag === "link" || child.tag === "meta") return;
  const nextFormat = deriveFormat(format, child);
  const nextParagraph = deriveParagraph(paragraphFormat, child, nextFormat);
  if (child.tag === "br") {
    builder.break(paragraph);
    return;
  }
  if (child.tag === "img") {
    builder.image(paragraph, child, nextFormat, hyperlinkTarget);
    return;
  }
  let nextHyperlink = hyperlinkTarget;
  if (child.tag === "a") nextHyperlink = canonicalHyperlink(child.attrs.href);
  const block = BLOCK_TAGS.has(child.tag) && !["li"].includes(child.tag);
  if (block && paragraph.hasContent && child.tag !== "hr") builder.break(paragraph);
  for (const grandchild of child.children) {
    appendInline(builder, paragraph, grandchild, nextFormat, nextParagraph, nextHyperlink, preformatted || child.tag === "pre");
  }
  if (block && paragraph.hasContent && child.tag !== "hr") builder.break(paragraph);
}

function appendChildren(builder, paragraph, node, format, paragraphFormat, preformatted = false) {
  for (const child of node.children) {
    appendInline(builder, paragraph, child, format, paragraphFormat, null, preformatted);
  }
}

function tableRows(node, rows = []) {
  for (const child of node.children) {
    if (typeof child === "string") continue;
    if (child.tag === "table" && child !== node) continue;
    if (child.tag === "tr") rows.push(child);
    else tableRows(child, rows);
  }
  return rows;
}

function convertTable(builder, node, format, paragraphFormat, style) {
  const rows = tableRows(node);
  if (!rows.length) {
    const paragraph = builder.paragraph(paragraphOptions(style, paragraphFormat));
    appendChildren(builder, paragraph, node, format, paragraphFormat);
    return;
  }
  for (const row of rows) {
    const paragraph = builder.paragraph(paragraphOptions(style, deriveParagraph(paragraphFormat, row, format)));
    const cells = row.children.filter((child) => typeof child !== "string" && ["td", "th"].includes(child.tag));
    for (let index = 0; index < cells.length; ++index) {
      if (index) builder.tab(paragraph);
      const cell = cells[index];
      const cellFormat = deriveFormat(format, cell);
      appendChildren(builder, paragraph, cell, cellFormat, paragraphFormat);
    }
  }
}

function convertList(builder, node, inheritedFormat, inheritedParagraph, depth, style) {
  const format = deriveFormat(inheritedFormat, node);
  const paragraphFormat = deriveParagraph(inheritedParagraph, node, format);
  const listItems = node.children.filter((child) => typeof child !== "string" && child.tag === "li");
  const directText = node.children.filter((child) => typeof child === "string" && child.trim());
  if (!listItems.length && !directText.length) {
    for (const child of node.children) {
      if (typeof child !== "string" && ["ul", "ol"].includes(child.tag)) {
        convertList(builder, child, format, paragraphFormat, depth + 1, style);
      }
    }
    return;
  }
  const level = Math.min(8, Math.max(0, depth));
  const kind = node.tag === "ol" ? "decimal" : "bullet";
  const parseOrdinal = (value) => {
    const source = String(value || "").trim();
    if (!/^[+-]?\d+$/.test(source)) return null;
    const ordinal = Number(source);
    return Number.isSafeInteger(ordinal) && ordinal >= -0x80000000 && ordinal <= 0x7fffffff ? ordinal : null;
  };
  let numId = builder.list(kind, level, kind === "decimal" ? parseOrdinal(node.attrs.start) : null);
  if (directText.length) {
    const paragraph = builder.paragraph({...paragraphOptions(style, paragraphFormat), list: {numId, level}});
    for (const text of directText) builder.text(paragraph, text, format, null);
  }
  for (const item of listItems) {
    const itemStart = kind === "decimal" ? parseOrdinal(item.attrs.value) : null;
    if (itemStart != null) numId = builder.list(kind, level, itemStart);
    const itemFormat = deriveFormat(format, item);
    const itemParagraph = deriveParagraph(paragraphFormat, item, itemFormat);
    let paragraph = builder.paragraph({...paragraphOptions(style, itemParagraph), list: {numId, level}});
    for (const child of item.children) {
      if (typeof child !== "string" && ["ul", "ol"].includes(child.tag)) {
        convertList(builder, child, itemFormat, itemParagraph, depth + 1, style);
        paragraph = null;
        continue;
      }
      if (typeof child !== "string" && (BLOCK_TAGS.has(child.tag) || hasBlockChild(child))) {
        const marker = paragraph;
        const markerIndex = marker ? builder.paragraphs.length - 1 : -1;
        const blockStart = builder.paragraphs.length;
        convertBlock(builder, child, itemFormat, itemParagraph, style, depth + 1);
        const added = builder.paragraphs.slice(blockStart);
        if (added.length) {
          const reuseMarker = marker && !marker.hasContent && !added[0].list;
          if (reuseMarker) {
            builder.paragraphs.splice(markerIndex, 1);
            added[0].list = {numId, level};
          }
          for (const continuation of added.slice(reuseMarker ? 1 : 0)) {
            if (!continuation.list && continuation.listContinuation == null) continuation.listContinuation = level;
          }
          paragraph = null;
        }
        continue;
      }
      if (!paragraph && typeof child === "string" && !child.replace(/[\t\n\f\r ]/g, "")) continue;
      paragraph ||= builder.paragraph({...paragraphOptions(style, itemParagraph), listContinuation: level});
      appendInline(builder, paragraph, child, itemFormat, itemParagraph, null, false);
    }
  }
}

function blockStyle(node) {
  if (node.tag === "h1" && (node.attrs.class || "").split(/\s+/).includes("doc-title")) return "Title";
  if (node.tag === "h1") return "Heading1";
  if (node.tag === "h2") return "Heading2";
  if (["h3", "h4", "h5", "h6"].includes(node.tag)) return "Heading3";
  if (node.tag === "blockquote" && !isEditorIndentation(node)) return "Quote";
  if (node.tag === "pre") return "CodeBlock";
  return "Normal";
}

function convertBlock(builder, node, inheritedFormat, inheritedParagraph, inheritedStyle = "Normal", listDepth = 0) {
  if (IGNORED_CONTENT_TAGS.has(node.tag) || ["link", "meta"].includes(node.tag)) return;
  const format = deriveFormat(inheritedFormat, node);
  const paragraphFormat = deriveParagraph(inheritedParagraph, node, format);
  if (["ul", "ol"].includes(node.tag)) {
    convertList(builder, node, inheritedFormat, inheritedParagraph, listDepth, inheritedStyle);
  } else if (node.tag === "table") {
    convertTable(builder, node, format, paragraphFormat, inheritedStyle);
  } else if (node.tag === "hr") {
    builder.paragraph({...paragraphOptions(inheritedStyle, paragraphFormat), horizontalRule: true});
  } else if (node.tag === "img") {
    const paragraph = builder.paragraph(paragraphOptions(inheritedStyle, paragraphFormat));
    builder.image(paragraph, node, format, null);
  } else if (hasBlockChild(node)) {
    const style = blockStyle(node);
    convertFlow(builder, node.children, format, paragraphFormat, style === "Normal" ? inheritedStyle : style, listDepth);
  } else if (node.tag === "li") {
    const paragraph = builder.paragraph(paragraphOptions(inheritedStyle, paragraphFormat));
    appendChildren(builder, paragraph, node, format, paragraphFormat);
  } else {
    const style = blockStyle(node);
    const paragraph = builder.paragraph(paragraphOptions(style === "Normal" ? inheritedStyle : style, paragraphFormat));
    appendChildren(builder, paragraph, node, format, paragraphFormat, node.tag === "pre");
  }
}

function convertFlow(builder, children, inheritedFormat = {}, inheritedParagraph = {}, inheritedStyle = "Normal", listDepth = 0) {
  let loose = null;
  for (const child of children) {
    if (typeof child === "string") {
      if (!child.replace(/[\t\n\f\r ]/g, "")) continue;
      loose ||= builder.paragraph(paragraphOptions(inheritedStyle, inheritedParagraph));
      builder.text(loose, child, inheritedFormat, null);
      continue;
    }
    if (child.tag === "#boundary") {
      loose = null;
      continue;
    }
    if (IGNORED_CONTENT_TAGS.has(child.tag) || ["link", "meta"].includes(child.tag)) continue;
    if (BLOCK_TAGS.has(child.tag) || child.tag === "img") {
      loose = null;
      convertBlock(builder, child, inheritedFormat, inheritedParagraph, inheritedStyle, listDepth);
    } else if (hasBlockChild(child)) {
      loose = null;
      const format = deriveFormat(inheritedFormat, child);
      const paragraphFormat = deriveParagraph(inheritedParagraph, child, format);
      convertFlow(builder, child.children, format, paragraphFormat, inheritedStyle, listDepth);
    } else {
      loose ||= builder.paragraph(paragraphOptions(inheritedStyle, inheritedParagraph));
      appendInline(builder, loose, child, inheritedFormat, inheritedParagraph, null, false);
    }
  }
}

function runProperties(format, hyperlink) {
  const properties = [];
  if (hyperlink) properties.push('<w:rStyle w:val="Hyperlink"/>');
  if (format?.font) {
    const font = xmlAttribute(format.font);
    properties.push(`<w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:eastAsia="${font}" w:cs="${font}"/>`);
  }
  if (format?.bold != null) properties.push(format.bold ? "<w:b/><w:bCs/>" : '<w:b w:val="0"/><w:bCs w:val="0"/>');
  if (format?.italic != null) properties.push(format.italic ? "<w:i/><w:iCs/>" : '<w:i w:val="0"/><w:iCs w:val="0"/>');
  if (format?.strike != null) properties.push(format.strike ? "<w:strike/>" : '<w:strike w:val="0"/>');
  if (format?.color) properties.push(`<w:color w:val="${format.color}"/>`);
  if (format?.size) properties.push(`<w:sz w:val="${format.size}"/><w:szCs w:val="${format.size}"/>`);
  if (format?.underline != null) properties.push(`<w:u w:val="${format.underline ? "single" : "none"}"/>`);
  if (format?.shading) properties.push(`<w:shd w:val="clear" w:color="auto" w:fill="${format.shading}"/>`);
  return properties.length ? `<w:rPr>${properties.join("")}</w:rPr>` : "";
}

function* textRunXml(run) {
  if (run.hyperlink) yield `<w:hyperlink r:id="${run.hyperlink}" w:history="1">`;
  yield `<w:r>${runProperties(run.format, run.hyperlink)}`;
  let start = 0;
  const emitText = function* (text) {
    for (let offset = 0; offset < text.length;) {
      let end = Math.min(text.length, offset + 16_384);
      if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) --end;
      yield `<w:t xml:space="preserve">${xmlText(text.slice(offset, end))}</w:t>`;
      offset = end;
    }
  };
  for (let index = 0; index < run.text.length; ++index) {
    const character = run.text[index];
    if (character !== "\n" && character !== "\r" && character !== "\t") continue;
    yield* emitText(run.text.slice(start, index));
    if (character === "\t") yield "<w:tab/>";
    else {
      if (character === "\r" && run.text[index + 1] === "\n") ++index;
      yield "<w:br/>";
    }
    start = index + 1;
  }
  yield* emitText(run.text.slice(start));
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
  if (spacing.length) {
    properties.push(`<w:spacing ${spacing.join(" ")}/>`);
  }
  let left = paragraph.left;
  if (paragraph.list && left != null) left += (paragraph.list.level + 1) * 420;
  if (paragraph.listContinuation != null) left = (left || 0) + (paragraph.listContinuation + 1) * 420;
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

function* numberingXml(numbering) {
  yield `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="${WORD_NS}">`;
  for (const [abstractId, kind] of [[0, "bullet"], [1, "decimal"]]) {
    yield `<w:abstractNum w:abstractNumId="${abstractId}"><w:multiLevelType w:val="multilevel"/>`;
    for (let level = 0; level < 9; ++level) {
      const text = kind === "decimal" ? `%${level + 1}.` : ["&#x2022;", "&#x25E6;", "&#x25AA;"][level % 3];
      yield `<w:lvl w:ilvl="${level}"><w:start w:val="1"/><w:numFmt w:val="${kind}"/>` +
        `<w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:tabs><w:tab w:val="num" w:pos="${(level + 1) * 420}"/></w:tabs>` +
        `<w:ind w:left="${(level + 1) * 420}" w:hanging="240"/></w:pPr></w:lvl>`;
    }
    yield "</w:abstractNum>";
  }
  for (const item of numbering) {
    yield `<w:num w:numId="${item.id}"><w:abstractNumId w:val="${item.kind === "bullet" ? 0 : 1}"/>`;
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
    const mime = extension === "jpg" ? "image/jpeg" : `image/${extension}`;
    xml += `<Default Extension="${extension}" ContentType="${mime}"/>`;
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
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    `<Relationship Id="rId3" Type="${OFFICE_REL_NS}/extended-properties" Target="docProps/app.xml"/></Relationships>`;
}

function* documentRelationships(model) {
  yield `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PACKAGE_REL_NS}">`;
  yield `<Relationship Id="rId1" Type="${OFFICE_REL_NS}/styles" Target="styles.xml"/>`;
  if (model.numbering.length) yield `<Relationship Id="rId2" Type="${OFFICE_REL_NS}/numbering" Target="numbering.xml"/>`;
  for (const relationship of model.relationships) {
    yield `<Relationship Id="${relationship.id}" Type="${OFFICE_REL_NS}/${relationship.type}" ` +
      `Target="${relationshipAttribute(relationship.target)}"${relationship.targetMode ? ` TargetMode="${relationship.targetMode}"` : ""}/>`;
  }
  yield "</Relationships>";
}

function coreProperties(model) {
  const modified = model.modified
    ? `<dcterms:modified xsi:type="dcterms:W3CDTF">${model.modified}</dcterms:modified>` : "";
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${xmlText(model.title)}</dc:title>${modified}</cp:coreProperties>`;
}

function appProperties() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
    'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
    '<Application>Gadgets Workspace Docs</Application></Properties>';
}

export async function documentToDocx(document) {
  const snapshot = normalizeSnapshot(document);
  const namedEntities = await loadHtmlEntities();
  const tree = await parseHtml(snapshot.fragments, namedEntities);
  snapshot.fragments = null;
  const model = new DocumentBuilder(snapshot);
  convertFlow(model, tree.children);
  if (!model.paragraphs.length) model.paragraph();
  model.imagesBySource.clear();

  const entries = [
    {name: "[Content_Types].xml", data: contentTypes(model)},
    {name: "_rels/.rels", data: rootRelationships()},
    {name: "docProps/core.xml", data: coreProperties(model)},
    {name: "docProps/app.xml", data: appProperties()},
    {name: "word/document.xml", data: () => textStream(documentXml(model))},
    {name: "word/styles.xml", data: stylesXml()},
  ];
  if (model.numbering.length) {
    entries.push({name: "word/numbering.xml", data: () => textStream(numberingXml(model.numbering))});
  }
  entries.push({name: "word/_rels/document.xml.rels", data: () => textStream(documentRelationships(model))});
  for (const image of model.images) entries.push({name: `word/media/${image.name}`, data: image.bytes});
  return createZip(entries);
}
