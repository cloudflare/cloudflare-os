import { createZip, crc32 } from "./zip.js";

const encoder = new TextEncoder();
const PML_NS = "http://schemas.openxmlformats.org/presentationml/2006/main";
const DML_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const CONTENT_TYPE_NS = "http://schemas.openxmlformats.org/package/2006/content-types";

const SLIDE_WIDTH = 12192000;
const SLIDE_HEIGHT = 6858000;
const PX_TO_EMU = 10160;
const PX_TO_LINE_EMU = PX_TO_EMU;
const PX_TO_POINT = PX_TO_EMU / 12700;
const MAX_DRAWING_COORDINATE = 2147483647;

const MAX_SLIDES = 500;
const MAX_BLOCKS_PER_SLIDE = 1000;
const MAX_TOTAL_BLOCKS = 10000;
const MAX_TEXT_LENGTH = 1000000;
const MAX_TOTAL_TEXT_LENGTH = 8000000;
const MAX_LINE_BREAKS = 10000;
const MAX_TOTAL_LINE_BREAKS = 50000;
const MAX_HIGHLIGHT_TERMS = 128;
const MAX_HIGHLIGHT_WORK = 8000000;
const MAX_MEDIA_COUNT = 256;
const MAX_MEDIA_ENCODED_BYTES = 24 * 1024 * 1024;
const MAX_TOTAL_MEDIA_ENCODED_BYTES = 96 * 1024 * 1024;
const MAX_MEDIA_DECODED_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_MEDIA_DECODED_BYTES = 64 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 8192;
const MAX_IMAGE_PIXELS = 16777216;
const MAX_TOTAL_IMAGE_PIXELS = 67108864;

const COLORS = {
  page: "F5F1EB",
  surface: "FFF9EF",
  surfaceSoft: "FFF4E6",
  text: "2B0B05",
  muted: "7B6254",
  subtle: "A89082",
  border: "EAD6C4",
  borderLight: "F2E3D5",
  orange: "FF5F2E",
  ruby: "FF6633",
  tangerine: "F6821F",
  mango: "FBAD41",
};

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeXml(value) {
  const input = String(value ?? "");
  let output = "";
  for (let i = 0; i < input.length; ++i) {
    const code = input.charCodeAt(i);
    if (code === 13) {
      if (input.charCodeAt(i + 1) === 10) ++i;
      output += "\n";
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const low = input.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) output += input[i] + input[++i];
      else output += "\ufffd";
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      output += "\ufffd";
    } else if (code === 9 || code === 10 ||
        (code >= 0x20 && code <= 0xd7ff) ||
        (code >= 0xe000 && code <= 0xfffd && code !== 0xfffe && code !== 0xffff)) {
      output += input[i];
    } else {
      output += "\ufffd";
    }
  }
  return output;
}

function xmlAttribute(value) {
  return normalizeXml(value).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function* escapedTextChunks(value) {
  let chunk = "";
  for (const character of value) {
    if (character === "&") chunk += "&amp;";
    else if (character === "<") chunk += "&lt;";
    else if (character === ">") chunk += "&gt;";
    else chunk += character;
    if (chunk.length >= 16384) {
      yield chunk;
      chunk = "";
    }
  }
  if (chunk) yield chunk;
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

function primitiveNumber(value) {
  if (typeof value !== "number" && typeof value !== "string") return NaN;
  if (typeof value === "string" && value.trim() === "") return NaN;
  return Number(value);
}

function numberOr(value, fallback, minimum = -Infinity, maximum = Infinity) {
  const number = primitiveNumber(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, number));
}

function cssNumber(value, fallback, minimum, maximum) {
  if (!value) return fallback;
  return numberOr(value, fallback, minimum, maximum);
}

function opacity(value, fallback = 1) {
  return numberOr(value, fallback, 0, 1);
}

function positionPixels(value, fallback = 0) {
  return numberOr(value, fallback,
    -MAX_DRAWING_COORDINATE / PX_TO_EMU,
    MAX_DRAWING_COORDINATE / PX_TO_EMU);
}

function sizePixels(value, fallback) {
  return numberOr(value, fallback, 0, MAX_DRAWING_COORDINATE / PX_TO_EMU);
}

function emuPosition(value) {
  return Math.max(-MAX_DRAWING_COORDINATE,
    Math.min(MAX_DRAWING_COORDINATE, Math.round(value * PX_TO_EMU)));
}

function emuSize(value) {
  return Math.max(1, Math.min(MAX_DRAWING_COORDINATE, Math.round(Math.max(0, value) * PX_TO_EMU)));
}

function emuLength(value) {
  return Math.max(0, Math.min(MAX_DRAWING_COORDINATE, Math.round(Math.max(0, value) * PX_TO_EMU)));
}

function boxFromPixels(x, y, width, height) {
  return {
    x: emuPosition(positionPixels(x)),
    y: emuPosition(positionPixels(y)),
    width: emuSize(sizePixels(width, 1)),
    height: emuSize(sizePixels(height, 1)),
  };
}

function blockBox(block, defaultWidth, defaultHeight) {
  return boxFromPixels(
    positionPixels(block.x),
    positionPixels(block.y),
    sizePixels(block.w, defaultWidth),
    sizePixels(block.h, defaultHeight),
  );
}

function parseColor(value, fallback = null) {
  let input = typeof value === "string" ? value.trim() : "";
  if (!input && fallback) input = fallback;
  if (input.toLowerCase() === "transparent") return null;
  const match = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(input);
  if (!match) return fallback && input !== fallback ? parseColor(fallback) : null;
  let hex = match[1];
  if (hex.length === 3 || hex.length === 4) {
    hex = Array.from(hex, character => character + character).join("");
  }
  return {
    rgb: hex.slice(0, 6).toUpperCase(),
    alpha: hex.length === 8 ? parseInt(hex.slice(6), 16) / 255 : 1,
  };
}

function solidFill(color, shapeOpacity = 1) {
  if (!color) return "<a:noFill/>";
  const alpha = Math.round(opacity(shapeOpacity) * color.alpha * 100000);
  const alphaXml = alpha === 100000 ? "" : `<a:alpha val="${alpha}"/>`;
  return `<a:solidFill><a:srgbClr val="${color.rgb}">${alphaXml}</a:srgbClr></a:solidFill>`;
}

function lineXml(color, widthPixels = 0, dashed = false, shapeOpacity = 1, arrow = false) {
  const width = Math.max(0, Math.min(MAX_DRAWING_COORDINATE,
    Math.round(numberOr(widthPixels, 0, 0, 1000) * PX_TO_LINE_EMU)));
  if (!color || width === 0) return "<a:ln><a:noFill/></a:ln>";
  let xml = `<a:ln w="${width}" cap="rnd">${solidFill(color, shapeOpacity)}`;
  xml += `<a:prstDash val="${dashed ? "dash" : "solid"}"/>`;
  if (arrow) xml += '<a:headEnd type="none"/><a:tailEnd type="triangle" w="sm" len="sm"/>';
  return xml + "</a:ln>";
}

function gradientFill(stops, angle = 0, shapeOpacity = 1) {
  let xml = '<a:gradFill rotWithShape="1"><a:gsLst>';
  for (const stop of stops) {
    const color = parseColor(stop.color, "#000000");
    const alpha = Math.round(opacity(shapeOpacity) * color.alpha * 100000);
    xml += `<a:gs pos="${stop.position}"><a:srgbClr val="${color.rgb}">`;
    if (alpha !== 100000) xml += `<a:alpha val="${alpha}"/>`;
    xml += "</a:srgbClr></a:gs>";
  }
  return xml + `</a:gsLst><a:lin ang="${angle}" scaled="1"/></a:gradFill>`;
}

function presetGeometry(preset, radius, width, height) {
  if (preset !== "roundRect") return `<a:prstGeom prst="${preset}"><a:avLst/></a:prstGeom>`;
  const shortSide = Math.max(1, Math.min(width, height));
  const adjustment = Math.round(Math.max(0, Math.min(50000, radius / shortSide * 100000)));
  return `<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val ${adjustment}"/></a:avLst></a:prstGeom>`;
}

function transformXml(box, extra = "") {
  return `<a:xfrm${extra}><a:off x="${box.x}" y="${box.y}"/><a:ext cx="${box.width}" cy="${box.height}"/></a:xfrm>`;
}

function nextShapeId(state) {
  return state.nextShapeId++;
}

function shapeXml(state, name, box, options = {}) {
  const id = nextShapeId(state);
  const preset = options.preset || "rect";
  const fill = options.fill === undefined ? "<a:noFill/>" : options.fill;
  const line = options.line || "<a:ln><a:noFill/></a:ln>";
  const descr = options.descr == null ? "" : ` descr="${xmlAttribute(options.descr)}"`;
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${xmlAttribute(name)}"${descr}/>` +
    `<p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${transformXml(box)}` +
    `${presetGeometry(preset, options.radius || 0, box.width / PX_TO_EMU, box.height / PX_TO_EMU)}` +
    `${fill}${line}</p:spPr></p:sp>`;
}

function* linesOf(text) {
  let start = 0;
  while (true) {
    const end = text.indexOf("\n", start);
    if (end < 0) {
      yield text.slice(start);
      return;
    }
    yield text.slice(start, end);
    start = end + 1;
  }
}

function fontSizeHundredths(pixels) {
  return Math.max(100, Math.min(400000,
    Math.round(cssNumber(pixels, 12, 1, 1000) * PX_TO_POINT * 100)));
}

function letterSpacingHundredths(value, fontPixels) {
  if (typeof value === "number") {
    return Math.round(numberOr(value, 0, -50, 50) * PX_TO_POINT * 100);
  }
  if (typeof value !== "string") return 0;
  const match = /^\s*(-?(?:\d+(?:\.\d*)?|\.\d+))\s*(em|px)\s*$/i.exec(value);
  if (!match) return 0;
  const amount = Number(match[1]);
  const points = match[2].toLowerCase() === "em"
    ? amount * fontPixels * PX_TO_POINT
    : amount * PX_TO_POINT;
  return Math.round(Math.max(-40, Math.min(40, points)) * 100);
}

function runProperties(style, colorOverride) {
  const color = colorOverride || style.color;
  const size = fontSizeHundredths(style.fontSize);
  const bold = numberOr(style.weight, 400) >= 600 ? ' b="1"' : ' b="0"';
  const spacing = letterSpacingHundredths(style.letterSpacing, style.fontSize);
  const spacingXml = spacing ? ` spc="${spacing}"` : "";
  return `lang="en-US" sz="${size}"${bold}${spacingXml} dirty="0"` +
    `>${solidFill(color)}<a:latin typeface="Arial"/><a:ea typeface="Arial"/><a:cs typeface="Arial"/>`;
}

function highlightedSegments(line, terms, normalColor) {
  if (!terms.length || !line) return [{text: line, color: normalColor}];
  const marks = new Uint8Array(line.length);
  for (const term of terms) {
    for (let offset = 0; offset <= line.length - term.length;) {
      const found = line.indexOf(term, offset);
      if (found < 0) break;
      marks.fill(1, found, found + term.length);
      offset = found + Math.max(1, term.length);
    }
  }
  const segments = [];
  let start = 0;
  while (start < line.length) {
    let end = start + 1;
    while (end < line.length && marks[end] === marks[start]) ++end;
    segments.push({
      text: line.slice(start, end),
      color: marks[start] ? parseColor("#FF5F2E") : normalColor,
    });
    start = end;
  }
  return segments.length ? segments : [{text: "", color: normalColor}];
}

function* paragraphXml(text, style, options = {}) {
  const alignment = {left: "l", center: "ctr", right: "r"}[style.align] || "l";
  const lineHeight = Math.round(cssNumber(style.lineHeight, 1.2, 0.5, 4) * 100000);
  let properties = `<a:pPr algn="${alignment}" fontAlgn="base"`;
  if (options.bullet) properties += ` marL="${Math.round(18 * PX_TO_EMU)}" indent="-${Math.round(18 * PX_TO_EMU)}"`;
  properties += `><a:lnSpc><a:spcPct val="${lineHeight}"/></a:lnSpc>`;
  if (options.spacingAfter) {
    properties += `<a:spcAft><a:spcPts val="${Math.round(options.spacingAfter * PX_TO_POINT * 100)}"/></a:spcAft>`;
  }
  if (options.bullet) {
    properties += `<a:buClr><a:srgbClr val="${COLORS.tangerine}"/></a:buClr>` +
      '<a:buSzPts val="480"/><a:buFont typeface="Arial"/><a:buChar char="&#x25CF;"/>';
  } else {
    properties += "<a:buNone/>";
  }
  properties += "</a:pPr>";
  yield `<a:p>${properties}`;
  let firstLine = true;
  for (const line of linesOf(text)) {
    if (!firstLine) yield "<a:br/>";
    firstLine = false;
    const segments = highlightedSegments(line, options.highlightTerms || [], style.color);
    for (const segment of segments) {
      if (!segment.text) continue;
      yield `<a:r><a:rPr ${runProperties(style, segment.color)}</a:rPr><a:t xml:space="preserve">`;
      yield* escapedTextChunks(segment.text);
      yield "</a:t></a:r>";
    }
  }
  yield `<a:endParaRPr ${runProperties(style)}</a:endParaRPr></a:p>`;
}

function* textShapeXml(state, name, box, style, source, options = {}) {
  const id = nextShapeId(state);
  const descr = options.descr == null ? "" : ` descr="${xmlAttribute(options.descr)}"`;
  const preset = options.preset || "rect";
  const fill = options.fill === undefined ? "<a:noFill/>" : options.fill;
  const line = options.line || "<a:ln><a:noFill/></a:ln>";
  const insets = options.insets || {};
  const anchor = options.anchor === "middle" ? "ctr" : options.anchor === "bottom" ? "b" : "t";
  const wrap = options.wrap === false ? "none" : "square";
  yield `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${xmlAttribute(name)}"${descr}/>` +
    '<p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>' + transformXml(box) +
    presetGeometry(preset, options.radius || 0, box.width / PX_TO_EMU, box.height / PX_TO_EMU) +
    fill + line + '</p:spPr><p:txBody>' +
    `<a:bodyPr wrap="${wrap}" anchor="${anchor}" lIns="${emuLength(insets.left || 0)}" ` +
    `rIns="${emuLength(insets.right || 0)}" tIns="${emuLength(insets.top || 0)}" ` +
    `bIns="${emuLength(insets.bottom || 0)}"><a:noAutofit/></a:bodyPr><a:lstStyle/>`;
  if (source.items) {
    for (let i = 0; i < source.items.length; ++i) {
      yield* paragraphXml(source.items[i], style, {
        bullet: true,
        spacingAfter: i + 1 < source.items.length ? source.spacingAfter : 0,
      });
    }
    if (!source.items.length) yield* paragraphXml("", style);
  } else {
    yield* paragraphXml(source.text, style, {highlightTerms: source.highlightTerms || []});
  }
  yield "</p:txBody></p:sp>";
}

function boundedText(value, label, limits, maximum = MAX_TEXT_LENGTH) {
  let text = "";
  if (typeof value === "string") text = value;
  else if (typeof value === "number" || typeof value === "boolean") text = String(value);
  if (text.length > maximum) {
    throw new Error(`${label} is too long for PowerPoint export (${text.length} characters; maximum ${maximum}).`);
  }
  limits.totalText += text.length;
  if (limits.totalText > MAX_TOTAL_TEXT_LENGTH) {
    throw new Error(`Deck text is too large for PowerPoint export (maximum ${MAX_TOTAL_TEXT_LENGTH} characters total).`);
  }
  let lineBreaks = 0;
  for (let i = 0; i < text.length; ++i) {
    if (text.charCodeAt(i) === 13) {
      ++lineBreaks;
      if (text.charCodeAt(i + 1) === 10) ++i;
    } else if (text.charCodeAt(i) === 10) {
      ++lineBreaks;
    }
  }
  if (lineBreaks > MAX_LINE_BREAKS) {
    throw new Error(`${label} has too many line breaks for PowerPoint export (maximum ${MAX_LINE_BREAKS}).`);
  }
  limits.totalLineBreaks += lineBreaks;
  if (limits.totalLineBreaks > MAX_TOTAL_LINE_BREAKS) {
    throw new Error(`Deck text has too many line breaks for PowerPoint export (maximum ${MAX_TOTAL_LINE_BREAKS} total).`);
  }
  return normalizeXml(text);
}

function sourceScalar(value) {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value
    : undefined;
}

function decodedBase64Length(payload) {
  if (!payload || payload.length % 4 !== 0) return null;
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return payload.length / 4 * 3 - padding;
}

const BASE64_VALUES = new Int16Array(128).fill(-1);
for (let i = 0; i < 26; ++i) {
  BASE64_VALUES[65 + i] = i;
  BASE64_VALUES[97 + i] = 26 + i;
}
for (let i = 0; i < 10; ++i) BASE64_VALUES[48 + i] = 52 + i;
BASE64_VALUES[43] = 62;
BASE64_VALUES[47] = 63;

function decodeBase64(payload, length) {
  const bytes = new Uint8Array(length);
  let output = 0;
  for (let offset = 0; offset < payload.length; offset += 4) {
    const a = BASE64_VALUES[payload.charCodeAt(offset)];
    const b = BASE64_VALUES[payload.charCodeAt(offset + 1)];
    const thirdPadding = payload[offset + 2] === "=";
    const fourthPadding = payload[offset + 3] === "=";
    const c = thirdPadding ? 0 : BASE64_VALUES[payload.charCodeAt(offset + 2)];
    const d = fourthPadding ? 0 : BASE64_VALUES[payload.charCodeAt(offset + 3)];
    if (a < 0 || b < 0 || c < 0 || d < 0 || (thirdPadding && !fourthPadding) ||
        (offset + 4 !== payload.length && (thirdPadding || fourthPadding)) ||
        (thirdPadding && (b & 15) !== 0) || (fourthPadding && !thirdPadding && (c & 3) !== 0)) {
      return null;
    }
    const value = (a << 18) | (b << 12) | (c << 6) | d;
    if (output < length) bytes[output++] = value >>> 16;
    if (output < length) bytes[output++] = value >>> 8 & 255;
    if (output < length) bytes[output++] = value & 255;
  }
  return output === length ? bytes : null;
}

function readUint32(bytes, offset) {
  return (bytes[offset] * 0x1000000 + (bytes[offset + 1] << 16) +
    (bytes[offset + 2] << 8) + bytes[offset + 3]) >>> 0;
}

function pngDimensions(bytes) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 24 || !signature.every((value, index) => bytes[index] === value)) return null;
  let dimensions = null;
  let sawImageData = false;
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = readUint32(bytes, offset);
    const dataEnd = offset + 8 + length;
    if (dataEnd + 4 > bytes.length) return null;
    if (crc32(bytes.subarray(offset + 4, dataEnd)) !== readUint32(bytes, dataEnd)) return null;
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    if (offset === 8) {
      if (type !== "IHDR" || length !== 13) return null;
      const width = readUint32(bytes, offset + 8);
      const height = readUint32(bytes, offset + 12);
      if (!width || !height) return null;
      dimensions = {width, height};
    } else if (type === "IDAT") {
      sawImageData ||= length > 0;
    } else if (type === "IEND") {
      return length === 0 && sawImageData && dataEnd + 4 === bytes.length ? dimensions : null;
    }
    offset = dataEnd + 4;
  }
  return null;
}

function jpegDimensions(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff ||
      bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) return null;
  const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
    0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let dimensions = null;
  let sawScanData = false;
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    while (offset < bytes.length && bytes[offset] === 0xff) ++offset;
    if (offset >= bytes.length) return null;
    const marker = bytes[offset++];
    if (marker === 0xd9) {
      return dimensions && sawScanData && offset === bytes.length ? dimensions : null;
    }
    if (marker === 0x00 || marker === 0xd8) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= bytes.length) return null;
    const segmentLength = bytes[offset] << 8 | bytes[offset + 1];
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return null;
    if (startOfFrame.has(marker)) {
      if (segmentLength < 8) return null;
      const height = bytes[offset + 3] << 8 | bytes[offset + 4];
      const width = bytes[offset + 5] << 8 | bytes[offset + 6];
      if (!width || !height) return null;
      dimensions = {width, height};
    }
    if (marker === 0xda) {
      offset += segmentLength;
      let scanBytes = 0;
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) {
          ++scanBytes;
          ++offset;
          continue;
        }
        const markerOffset = offset;
        while (offset < bytes.length && bytes[offset] === 0xff) ++offset;
        if (offset >= bytes.length) return null;
        const scanMarker = bytes[offset];
        if (scanMarker === 0x00) {
          ++scanBytes;
          ++offset;
          continue;
        }
        if (scanMarker >= 0xd0 && scanMarker <= 0xd7) {
          ++offset;
          continue;
        }
        if (!scanBytes) return null;
        sawScanData = true;
        offset = markerOffset;
        break;
      }
      continue;
    }
    offset += segmentLength;
  }
  return null;
}

function equalBytes(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  for (let i = 0; i < left.byteLength; ++i) if (left[i] !== right[i]) return false;
  return true;
}

function findOrAddMedia(bytes, mime, dimensions, mediaState) {
  const checksum = crc32(bytes);
  const key = `${bytes.byteLength}:${checksum}`;
  const candidates = mediaState.byChecksum.get(key) || [];
  for (const media of candidates) {
    if (equalBytes(media.bytes, bytes)) return media;
  }
  if (mediaState.media.length >= MAX_MEDIA_COUNT) {
    throw new Error(`Deck contains too many embedded images for PowerPoint export (maximum ${MAX_MEDIA_COUNT}).`);
  }
  const totalPixels = mediaState.totalPixels + dimensions.width * dimensions.height;
  if (totalPixels > MAX_TOTAL_IMAGE_PIXELS) {
    throw new Error(`Deck images exceed the ${MAX_TOTAL_IMAGE_PIXELS}-pixel aggregate limit.`);
  }
  mediaState.totalPixels = totalPixels;
  const extension = mime === "image/png" ? "png" : "jpeg";
  const media = {
    index: mediaState.media.length + 1,
    extension,
    mime,
    width: dimensions.width,
    height: dimensions.height,
    bytes,
  };
  mediaState.media.push(media);
  candidates.push(media);
  mediaState.byChecksum.set(key, candidates);
  return media;
}

function prepareImageSource(value, label, limits, mediaState) {
  if (typeof value !== "string" || value === "") return {placeholder: "No image"};
  if (value.length > MAX_MEDIA_ENCODED_BYTES + 64) {
    throw new Error(`${label} exceeds the ${MAX_MEDIA_ENCODED_BYTES}-byte encoded-image limit.`);
  }
  const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]*={0,2})$/.exec(value);
  if (!match) {
    boundedText(value, label, limits);
    return {placeholder: value.startsWith("data:") ? "Unsupported or malformed image" : "Remote image not included"};
  }
  const cached = mediaState.bySource.get(value);
  if (cached) return cached;
  const payload = match[2];
  if (payload.length > MAX_MEDIA_ENCODED_BYTES) {
    throw new Error(`${label} exceeds the ${MAX_MEDIA_ENCODED_BYTES}-byte encoded-image limit.`);
  }
  limits.encodedBytes += payload.length;
  if (limits.encodedBytes > MAX_TOTAL_MEDIA_ENCODED_BYTES) {
    throw new Error(`Deck images exceed the ${MAX_TOTAL_MEDIA_ENCODED_BYTES}-byte aggregate encoded-image limit.`);
  }
  const decodedLength = decodedBase64Length(payload);
  if (decodedLength == null) {
    const result = {placeholder: "Malformed image data"};
    mediaState.bySource.set(value, result);
    return result;
  }
  if (decodedLength > MAX_MEDIA_DECODED_BYTES) {
    throw new Error(`${label} expands beyond the ${MAX_MEDIA_DECODED_BYTES}-byte decoded-image limit.`);
  }
  limits.decodedBytes += decodedLength;
  if (limits.decodedBytes > MAX_TOTAL_MEDIA_DECODED_BYTES) {
    throw new Error(`Deck images exceed the ${MAX_TOTAL_MEDIA_DECODED_BYTES}-byte aggregate decoded-image limit.`);
  }
  const bytes = decodeBase64(payload, decodedLength);
  const mime = `image/${match[1]}`;
  const dimensions = bytes && (mime === "image/png" ? pngDimensions(bytes) : jpegDimensions(bytes));
  if (!bytes || !dimensions) {
    const result = {placeholder: "Malformed image data"};
    mediaState.bySource.set(value, result);
    return result;
  }
  if (dimensions.width > MAX_IMAGE_DIMENSION || dimensions.height > MAX_IMAGE_DIMENSION) {
    throw new Error(`${label} is ${dimensions.width} x ${dimensions.height}; each image dimension must be at most ${MAX_IMAGE_DIMENSION}px.`);
  }
  if (dimensions.width * dimensions.height > MAX_IMAGE_PIXELS) {
    throw new Error(`${label} is ${dimensions.width} x ${dimensions.height}; images may contain at most ${MAX_IMAGE_PIXELS} pixels.`);
  }
  const result = {media: findOrAddMedia(bytes, mime, dimensions, mediaState)};
  mediaState.bySource.set(value, result);
  return result;
}

function prepareBlock(source, slideIndex, blockIndex, limits, mediaState) {
  const blockSource = isRecord(source) ? source : {};
  const propsSource = isRecord(blockSource.props) ? blockSource.props : {};
  const label = `Slide ${slideIndex + 1}, block ${blockIndex + 1}`;
  const type = boundedText(blockSource.type, `${label} type`, limits) || "unknown";
  const text = (key, maximum) => boundedText(propsSource[key], `${label} ${key}`, limits, maximum);
  const props = {};
  switch (type) {
    case "sectionLabel":
      props.text = text("text").toUpperCase();
      break;
    case "logo":
      props.text = propsSource.text == null ? "Workspace" : text("text");
      props.variant = text("variant");
      props.scale = sourceScalar(propsSource.scale);
      props.accentDot = propsSource.accentDot;
      break;
    case "gadgetsMark":
      props.size = text("size");
      break;
    case "title": {
      props.text = text("text");
      props.fontSize = sourceScalar(propsSource.fontSize);
      props.weight = sourceScalar(propsSource.weight);
      props.color = text("color");
      props.letterSpacing = text("letterSpacing");
      props.lineHeight = sourceScalar(propsSource.lineHeight);
      const highlight = text("highlight");
      props.highlightTerms = [...new Set(highlight.split(",").map(term => term.trim()).filter(Boolean))];
      if (props.highlightTerms.length > MAX_HIGHLIGHT_TERMS) {
        throw new Error(`${label} has too many title highlight terms (maximum ${MAX_HIGHLIGHT_TERMS}).`);
      }
      if (props.text.length * props.highlightTerms.length > MAX_HIGHLIGHT_WORK) {
        throw new Error(`${label} title highlights are too complex for PowerPoint export.`);
      }
      break;
    }
    case "subtitle":
    case "text":
      props.text = text("text");
      props.fontSize = sourceScalar(propsSource.fontSize);
      props.weight = sourceScalar(propsSource.weight);
      props.color = text("color");
      props.align = text("align");
      props.lineHeight = sourceScalar(propsSource.lineHeight);
      break;
    case "bulletList":
      props.text = text("text");
      props.treatment = text("treatment");
      break;
    case "card":
      props.eyebrow = text("eyebrow");
      props.title = text("title");
      props.body = text("body");
      break;
    case "box":
      props.title = text("title");
      props.body = text("body");
      props.dashed = propsSource.dashed;
      break;
    case "tonePill":
      props.tone = text("tone");
      props.text = text("text").toUpperCase();
      break;
    case "divider":
      props.color = text("color");
      props.opacity = sourceScalar(propsSource.opacity);
      break;
    case "shape":
      props.kind = text("kind");
      props.fill = text("fill");
      props.stroke = text("stroke");
      props.strokeWidth = sourceScalar(propsSource.strokeWidth);
      props.radius = sourceScalar(propsSource.radius);
      props.opacity = sourceScalar(propsSource.opacity);
      break;
    case "image":
      props.fit = text("fit");
      props.radius = sourceScalar(propsSource.radius);
      props.alt = text("alt");
      props.image = prepareImageSource(propsSource.src, `${label} image`, limits, mediaState);
      break;
    case "svg":
      props.markup = text("markup");
      props.fit = text("fit");
      props.background = text("background");
      props.brandBar = /viewBox=["']0 0 1200 12["']/.test(props.markup.trim()) &&
        props.markup.includes("#FF6633") && props.markup.includes("#F6821F") &&
        props.markup.includes("#FBAD41");
      break;
    case "arrow":
      props.x1 = sourceScalar(propsSource.x1);
      props.y1 = sourceScalar(propsSource.y1);
      props.x2 = sourceScalar(propsSource.x2);
      props.y2 = sourceScalar(propsSource.y2);
      props.color = text("color");
      props.label = text("label");
      props.dashed = propsSource.dashed;
      props.width = sourceScalar(propsSource.width);
      break;
    default:
      break;
  }
  return {
    type,
    x: sourceScalar(blockSource.x),
    y: sourceScalar(blockSource.y),
    w: sourceScalar(blockSource.w),
    h: sourceScalar(blockSource.h),
    props,
  };
}

function prepareDeck(deck) {
  const limits = {totalText: 0, totalLineBreaks: 0, encodedBytes: 0, decodedBytes: 0};
  const mediaState = {media: [], bySource: new Map(), byChecksum: new Map(), totalPixels: 0};
  const validDeck = isRecord(deck) && Array.isArray(deck.slides) && deck.slides.length > 0;
  const sourceSlides = validDeck ? deck.slides : [{}];
  if (sourceSlides.length > MAX_SLIDES) {
    throw new Error(`Deck has ${sourceSlides.length} slides; PowerPoint export supports at most ${MAX_SLIDES}.`);
  }
  let totalBlocks = 0;
  const slides = Array.from(sourceSlides, (source, slideIndex) => {
    const slideSource = isRecord(source) ? source : {};
    const sourceBlocks = Array.isArray(slideSource.blocks) ? slideSource.blocks : [];
    if (sourceBlocks.length > MAX_BLOCKS_PER_SLIDE) {
      throw new Error(`Slide ${slideIndex + 1} has ${sourceBlocks.length} blocks; the export limit is ${MAX_BLOCKS_PER_SLIDE} per slide.`);
    }
    totalBlocks += sourceBlocks.length;
    if (totalBlocks > MAX_TOTAL_BLOCKS) {
      throw new Error(`Deck has more than ${MAX_TOTAL_BLOCKS} blocks, the PowerPoint export limit.`);
    }
    const backgroundSource = isRecord(slideSource.background) ? slideSource.background : null;
    const background = backgroundSource ? {
      color: boundedText(backgroundSource.color, `Slide ${slideIndex + 1} background color`, limits),
      inset: backgroundSource.inset,
      coverOrange: backgroundSource.coverOrange,
    } : null;
    const blocks = Array.from(sourceBlocks, (block, blockIndex) =>
      prepareBlock(block, slideIndex, blockIndex, limits, mediaState));
    const relationshipByMedia = new Map();
    const relationships = [];
    for (const block of blocks) {
      const media = block.props.image?.media;
      if (!media) continue;
      let relationshipId = relationshipByMedia.get(media.index);
      if (!relationshipId) {
        relationshipId = `rId${relationships.length + 2}`;
        relationshipByMedia.set(media.index, relationshipId);
        relationships.push({id: relationshipId, media});
      }
      block.props.relationshipId = relationshipId;
    }
    return {background, blocks, relationships};
  });
  return {slides, media: mediaState.media};
}

function pixelBox(block, defaultWidth, defaultHeight) {
  return {
    x: positionPixels(block.x),
    y: positionPixels(block.y),
    width: sizePixels(block.w, defaultWidth),
    height: sizePixels(block.h, defaultHeight),
  };
}

function codePointLength(value) {
  let length = 0;
  const iterator = value[Symbol.iterator]();
  while (!iterator.next().done) ++length;
  return length;
}

function estimateTextHeight(text, width, fontSize, lineHeight) {
  const charactersPerLine = Math.max(1, Math.floor(Math.max(1, width) / Math.max(1, fontSize * 0.52)));
  let lines = 0;
  for (const line of linesOf(text)) {
    lines += Math.max(1, Math.ceil(codePointLength(line) / charactersPerLine));
  }
  return Math.max(fontSize * lineHeight, lines * fontSize * lineHeight + 2);
}

function naturalTextWidth(text, fontSize, letterSpacing = 0) {
  return Math.max(fontSize * 0.5,
    codePointLength(text.replace(/\n/g, "")) * fontSize * 0.56 + Math.max(0, codePointLength(text) - 1) * letterSpacing);
}

function* coverArtworkXml(state) {
  const fullSlide = {x: 0, y: 0, width: SLIDE_WIDTH, height: SLIDE_HEIGHT};
  yield shapeXml(state, "Cover gradient", fullSlide, {
    fill: gradientFill([
      {position: 0, color: "#FF5115"},
      {position: 56000, color: "#FF861F"},
      {position: 100000, color: "#FFC02C"},
    ], 2700000),
  });
}

function* renderSectionLabel(state, block, name) {
  const props = block.props;
  const width = block.w == null ? Math.max(80, naturalTextWidth(props.text, 10, 0.5) + 4) : sizePixels(block.w, 200);
  const box = blockBox({...block, w: width}, width, 14);
  const style = {
    fontSize: 10, weight: 600, letterSpacing: "0.05em", lineHeight: 1,
    color: parseColor("#FF6633"), align: "left",
  };
  yield* textShapeXml(state, name, box, style, {text: props.text}, {wrap: false});
}

function* renderLogo(state, block, name) {
  const props = block.props;
  const scale = cssNumber(props.scale, 1, 0.01, 20);
  const text = props.text;
  const fontSize = 24 * scale;
  const textWidth = naturalTextWidth(text, fontSize, -0.02 * fontSize) + 8 * scale;
  const textBox = boxFromPixels(positionPixels(block.x), positionPixels(block.y), textWidth, 29 * scale);
  const color = props.variant === "dark" ? parseColor("#000000") : parseColor("#FFFFFF");
  yield* textShapeXml(state, `${name} wordmark`, textBox, {
    fontSize, weight: 700, letterSpacing: "-0.02em", lineHeight: 1,
    color, align: "left",
  }, {text}, {wrap: false});
  if (props.accentDot !== false) {
    const dot = boxFromPixels(
      positionPixels(block.x) + textWidth,
      positionPixels(block.y) + 18 * scale,
      6 * scale,
      6 * scale,
    );
    yield shapeXml(state, `${name} accent dot`, dot, {
      preset: "ellipse",
      fill: solidFill(parseColor("#F6821F")),
    });
  }
}

function* renderGadgetsMark(state, block, name) {
  const small = block.props.size === "small";
  const iconSize = small ? 48 : 59;
  const gap = small ? 18 : 26;
  const fontSize = small ? 40 : 49;
  const x = positionPixels(block.x);
  const y = positionPixels(block.y);
  yield shapeXml(state, `${name} hexagon`, boxFromPixels(x, y, iconSize, iconSize), {
    preset: "hexagon",
    fill: "<a:noFill/>",
    line: lineXml(parseColor("#FF4801"), 10),
  });
  const wordmark = "gadgets";
  yield* textShapeXml(state, `${name} wordmark`,
    boxFromPixels(x + iconSize + gap, y + (iconSize - fontSize) / 2,
      naturalTextWidth(wordmark, fontSize, -0.055 * fontSize) + 8, fontSize + 5), {
      fontSize, weight: 500, letterSpacing: "-0.055em", lineHeight: 1,
      color: parseColor("#140400"), align: "left",
    }, {text: wordmark}, {wrap: false});
}

function* renderTitle(state, block, name) {
  const props = block.props;
  const fontSize = cssNumber(props.fontSize, 42, 1, 1000);
  const lineHeight = cssNumber(props.lineHeight, 1.08, 0.5, 4);
  const width = sizePixels(block.w, 900);
  const height = block.h == null ? estimateTextHeight(props.text, width, fontSize, lineHeight) : sizePixels(block.h, fontSize * lineHeight);
  yield* textShapeXml(state, name, blockBox({...block, w: width, h: height}, width, height), {
    fontSize,
    weight: props.weight || 900,
    letterSpacing: props.letterSpacing || "-0.04em",
    lineHeight,
    color: parseColor(props.color, "#2B0B05"),
    align: "left",
  }, {text: props.text, highlightTerms: props.highlightTerms});
}

function* renderSubtitle(state, block, name) {
  const props = block.props;
  const fontSize = cssNumber(props.fontSize, 19, 1, 1000);
  const lineHeight = cssNumber(props.lineHeight, 1.5, 0.5, 4);
  const width = sizePixels(block.w, 650);
  const height = block.h == null ? estimateTextHeight(props.text, width, fontSize, lineHeight) : sizePixels(block.h, fontSize * lineHeight);
  yield* textShapeXml(state, name, blockBox({...block, w: width, h: height}, width, height), {
    fontSize,
    weight: props.weight || 500,
    lineHeight,
    color: parseColor(props.color, "#7B6254"),
    align: "left",
  }, {text: props.text});
}

function* renderText(state, block, name) {
  const props = block.props;
  const fontSize = cssNumber(props.fontSize, 19, 1, 1000);
  const lineHeight = cssNumber(props.lineHeight, 1.6, 0.5, 4);
  const width = sizePixels(block.w, 400);
  const height = block.h == null ? estimateTextHeight(props.text, width, fontSize, lineHeight) : sizePixels(block.h, fontSize * lineHeight);
  yield* textShapeXml(state, name, blockBox({...block, w: width, h: height}, width, height), {
    fontSize,
    weight: props.weight || 400,
    lineHeight,
    color: parseColor(props.color, "#000000"),
    align: ["left", "center", "right"].includes(props.align) ? props.align : "left",
  }, {text: props.text});
}

function* renderBullets(state, block, name) {
  const compact = block.props.treatment === "compact";
  const fontSize = compact ? 17 : 19;
  const lineHeight = compact ? 1.45 : 1.5;
  const gap = compact ? 8 : 10;
  const items = [];
  for (const line of linesOf(block.props.text)) {
    const item = line.trim();
    if (item) items.push(item);
    if (items.length === 6) break;
  }
  const width = sizePixels(block.w, 850);
  let height = 1;
  for (const item of items) height += estimateTextHeight(item, Math.max(1, width - 18), fontSize, lineHeight) + gap;
  if (items.length) height -= gap;
  if (block.h != null) height = sizePixels(block.h, height);
  yield* textShapeXml(state, name, blockBox({...block, w: width, h: height}, width, height), {
    fontSize, weight: 400, lineHeight, color: parseColor("#000000"), align: "left",
  }, {items, spacingAfter: gap});
}

function* renderCard(state, block, name) {
  const props = block.props;
  const outer = pixelBox(block, 280, 260);
  yield shapeXml(state, `${name} surface`, boxFromPixels(outer.x, outer.y, outer.width, outer.height), {
    preset: "roundRect",
    radius: 2,
    fill: solidFill(parseColor("#FFFFFF")),
    line: lineXml(parseColor("#E5E5E5"), 1),
  });
  const x = outer.x + 20;
  let y = outer.y + 20;
  const width = Math.max(1, outer.width - 40);
  if (props.eyebrow) {
    const height = 12;
    yield* textShapeXml(state, `${name} eyebrow`, boxFromPixels(x, y, width, height), {
      fontSize: 10, weight: 600, letterSpacing: "0.05em", lineHeight: 1.2,
      color: parseColor("#FF6633"), align: "left",
    }, {text: props.eyebrow.toUpperCase()});
    y += height + 12;
  }
  const titleHeight = estimateTextHeight(props.title, width, 18, 1.3);
  yield* textShapeXml(state, `${name} title`, boxFromPixels(x, y, width, titleHeight), {
    fontSize: 18, weight: 600, letterSpacing: "-0.02em", lineHeight: 1.3,
    color: parseColor("#000000"), align: "left",
  }, {text: props.title});
  y += titleHeight + 12;
  yield* textShapeXml(state, `${name} body`,
    boxFromPixels(x, y, width, Math.max(1, outer.y + outer.height - 20 - y)), {
      fontSize: 15, weight: 400, lineHeight: 1.5,
      color: parseColor("#747474"), align: "left",
    }, {text: props.body});
}

function* renderBox(state, block, name) {
  const props = block.props;
  const outer = pixelBox(block, 220, 110);
  yield shapeXml(state, `${name} surface`, boxFromPixels(outer.x, outer.y, outer.width, outer.height), {
    preset: "roundRect",
    radius: 2,
    fill: solidFill(parseColor("#FFFFFF")),
    line: lineXml(parseColor("#E5E5E5"), 1, Boolean(props.dashed)),
  });
  const width = Math.max(1, outer.width - 28);
  const titleHeight = estimateTextHeight(props.title, width, 16, 1.3);
  const bodyHeight = props.body ? estimateTextHeight(props.body, width, 14, 1.45) : 0;
  const contentHeight = titleHeight + (props.body ? 6 + bodyHeight : 0);
  let y = outer.y + Math.max(14, (outer.height - contentHeight) / 2);
  yield* textShapeXml(state, `${name} title`, boxFromPixels(outer.x + 14, y, width, titleHeight), {
    fontSize: 16, weight: 600, letterSpacing: "-0.02em", lineHeight: 1.3,
    color: parseColor("#000000"), align: "left",
  }, {text: props.title});
  if (props.body) {
    y += titleHeight + 6;
    yield* textShapeXml(state, `${name} body`, boxFromPixels(outer.x + 14, y, width, bodyHeight), {
      fontSize: 14, weight: 400, lineHeight: 1.45,
      color: parseColor("#747474"), align: "left",
    }, {text: props.body});
  }
}

function* renderTonePill(state, block, name) {
  const props = block.props;
  const tone = {
    neutral: "#747474",
    tangerine: "#F6821F",
    ruby: "#FF6633",
  }[props.tone] || "#F6821F";
  const width = block.w == null ? naturalTextWidth(props.text, 11, 0.06 * 11) + 24 : sizePixels(block.w, 80);
  const height = block.h == null ? 24 : sizePixels(block.h, 24);
  yield* textShapeXml(state, name, blockBox({...block, w: width, h: height}, width, height), {
    fontSize: 11, weight: 850, letterSpacing: "0.06em", lineHeight: 1,
    color: parseColor(tone), align: "center",
  }, {text: props.text}, {
    preset: "roundRect",
    radius: Math.min(width, height) / 2,
    fill: solidFill(parseColor(tone), 0.12),
    anchor: "middle",
    insets: {left: 12, right: 12, top: 5, bottom: 5},
    wrap: false,
  });
}

function renderDivider(state, block, name) {
  return shapeXml(state, name, blockBox(block, 400, 2), {
    fill: solidFill(parseColor(block.props.color, "#EAD6C4"), opacity(block.props.opacity, 1)),
  });
}

function renderShape(state, block, name) {
  const props = block.props;
  const box = pixelBox(block, 200, 200);
  const radius = cssNumber(props.radius, 0, 0, 100000);
  const preset = props.kind === "ellipse" ? "ellipse" : radius > 0 ? "roundRect" : "rect";
  const shapeOpacity = opacity(props.opacity, 1);
  const width = props.strokeWidth ? numberOr(props.strokeWidth, 0, 0, 1000) : 0;
  return shapeXml(state, name, boxFromPixels(box.x, box.y, box.width, box.height), {
    preset,
    radius,
    fill: solidFill(parseColor(props.fill), shapeOpacity),
    line: lineXml(parseColor(props.stroke), width, false, shapeOpacity),
  });
}

function pictureXml(state, name, box, media, relationshipId, alt, radius, crop) {
  const id = nextShapeId(state);
  const sourceRectangle = crop
    ? `<a:srcRect l="${crop.left}" t="${crop.top}" r="${crop.right}" b="${crop.bottom}"/>`
    : "";
  const preset = radius > 0 ? "roundRect" : "rect";
  return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${xmlAttribute(name)}" descr="${xmlAttribute(alt)}"/>` +
    '<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>' +
    `<p:blipFill><a:blip r:embed="${relationshipId}" cstate="print"/>${sourceRectangle}` +
    '<a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>' + transformXml(box) +
    presetGeometry(preset, radius, box.width / PX_TO_EMU, box.height / PX_TO_EMU) +
    '<a:ln><a:noFill/></a:ln></p:spPr></p:pic>';
}

function imageCrop(media, boxWidth, boxHeight) {
  const imageAspect = media.width / media.height;
  const boxAspect = Math.max(1e-9, boxWidth / Math.max(1e-9, boxHeight));
  if (imageAspect > boxAspect) {
    const crop = Math.round((1 - boxAspect / imageAspect) * 50000);
    return {left: crop, top: 0, right: crop, bottom: 0};
  }
  const crop = Math.round((1 - imageAspect / boxAspect) * 50000);
  return {left: 0, top: crop, right: 0, bottom: crop};
}

function* renderPlaceholder(state, name, block, text, background, defaultWidth = 320, defaultHeight = 180) {
  const box = blockBox(block, defaultWidth, defaultHeight);
  const fill = background
    ? solidFill(parseColor(background))
    : solidFill(parseColor("#7B6254"), 0.06);
  yield* textShapeXml(state, name, box, {
    fontSize: 11, weight: 700, letterSpacing: "0.04em", lineHeight: 1.2,
    color: parseColor("#A89082"), align: "center",
  }, {text}, {
    preset: "roundRect",
    radius: 2,
    fill,
    line: lineXml(parseColor("#7B6254"), 1, true, 0.35),
    anchor: "middle",
    insets: {left: 8, right: 8, top: 4, bottom: 4},
  });
}

function* renderImage(state, block, name) {
  const props = block.props;
  if (!props.image.media) {
    yield* renderPlaceholder(state, name, block, props.image.placeholder, null, 600, 675);
    return;
  }
  const media = props.image.media;
  const target = pixelBox(block, 600, 675);
  let x = target.x;
  let y = target.y;
  let width = target.width;
  let height = target.height;
  let crop = null;
  if (props.fit === "cover") {
    crop = imageCrop(media, width, height);
  } else if (props.fit !== "fill") {
    const imageAspect = media.width / media.height;
    const targetAspect = width / Math.max(1e-9, height);
    if (imageAspect > targetAspect) {
      const fittedHeight = width / imageAspect;
      y += (height - fittedHeight) / 2;
      height = fittedHeight;
    } else {
      const fittedWidth = height * imageAspect;
      x += (width - fittedWidth) / 2;
      width = fittedWidth;
    }
  }
  const radius = cssNumber(props.radius, 0, 0, 100000);
  yield pictureXml(state, name, boxFromPixels(x, y, width, height), media,
    props.relationshipId, props.alt, radius, crop);
}

function* renderSvg(state, block, name) {
  if (block.props.brandBar) {
    yield shapeXml(state, name, blockBox(block, 600, 337.5), {
      fill: gradientFill([
        {position: 0, color: "#FF6633"},
        {position: 50000, color: "#F6821F"},
        {position: 100000, color: "#FBAD41"},
      ]),
    });
    return;
  }
  yield* renderPlaceholder(state, name, block,
    "SVG not included in PowerPoint export", block.props.background, 600, 337.5);
}

function arrowColor(value) {
  return parseColor({
    muted: "#747474",
    tangerine: "#F6821F",
    ruby: "#FF6633",
  }[value] || "#747474");
}

function connectorXml(state, name, x1, y1, x2, y2, color, width, dashed) {
  const id = nextShapeId(state);
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const box = boxFromPixels(left, top, Math.abs(x2 - x1), Math.abs(y2 - y1));
  const flips = `${x2 < x1 ? ' flipH="1"' : ""}${y2 < y1 ? ' flipV="1"' : ""}`;
  return `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${id}" name="${xmlAttribute(name)}"/>` +
    '<p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr>' + transformXml(box, flips) +
    '<a:prstGeom prst="line"><a:avLst/></a:prstGeom>' +
    lineXml(color, width, dashed, 0.85, true) + "</p:spPr></p:cxnSp>";
}

function* renderArrow(state, block, name) {
  const props = block.props;
  const x1 = positionPixels(props.x1, 200);
  const y1 = positionPixels(props.y1, 400);
  const x2 = positionPixels(props.x2, 600);
  const y2 = positionPixels(props.y2, 400);
  const width = props.width ? numberOr(props.width, 2, 0, 1000) : 2;
  const color = arrowColor(props.color || "muted");
  yield connectorXml(state, name, x1, y1, x2, y2, color, width, Boolean(props.dashed));
  if (props.label) {
    const fontSize = 12;
    const labelWidth = naturalTextWidth(props.label, fontSize, 0.02 * fontSize) + 16;
    yield* textShapeXml(state, `${name} label`,
      boxFromPixels((x1 + x2 - labelWidth) / 2, (y1 + y2) / 2 - 8 - fontSize,
        labelWidth, fontSize * 1.3), {
        fontSize, weight: 800, letterSpacing: "0.02em", lineHeight: 1,
        color, align: "center",
      }, {text: props.label});
  }
}

function* renderUnknown(state, block, name) {
  const text = `?: ${block.type}`;
  const width = block.w == null ? naturalTextWidth(text, 12) + 20 : sizePixels(block.w, 120);
  const height = block.h == null ? 27 : sizePixels(block.h, 27);
  yield* textShapeXml(state, name, blockBox({...block, w: width, h: height}, width, height), {
    fontSize: 12, weight: 400, lineHeight: 1, color: parseColor("#FFFFFF"), align: "left",
  }, {text}, {
    preset: "roundRect", radius: 4, fill: solidFill(parseColor("#BB0000")),
    anchor: "middle", insets: {left: 10, right: 10, top: 6, bottom: 6},
  });
}

function* renderBlockXml(state, block, blockIndex) {
  const name = `Block ${blockIndex + 1} ${block.type}`;
  switch (block.type) {
    case "sectionLabel": yield* renderSectionLabel(state, block, name); break;
    case "logo": yield* renderLogo(state, block, name); break;
    case "gadgetsMark": yield* renderGadgetsMark(state, block, name); break;
    case "title": yield* renderTitle(state, block, name); break;
    case "subtitle": yield* renderSubtitle(state, block, name); break;
    case "text": yield* renderText(state, block, name); break;
    case "bulletList": yield* renderBullets(state, block, name); break;
    case "card": yield* renderCard(state, block, name); break;
    case "box": yield* renderBox(state, block, name); break;
    case "tonePill": yield* renderTonePill(state, block, name); break;
    case "divider": yield renderDivider(state, block, name); break;
    case "shape": yield renderShape(state, block, name); break;
    case "image": yield* renderImage(state, block, name); break;
    case "svg": yield* renderSvg(state, block, name); break;
    case "arrow": yield* renderArrow(state, block, name); break;
    default: yield* renderUnknown(state, block, name); break;
  }
}

function slideBackgroundXml(background) {
  const color = parseColor(background?.color, "#F5F1EB");
  return `<p:bg><p:bgPr>${solidFill(color)}<a:effectLst/></p:bgPr></p:bg>`;
}

function groupShapeXml() {
  return '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
    '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
}

function* slideXml(slide) {
  const state = {nextShapeId: 2};
  yield `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="${DML_NS}" xmlns:r="${REL_NS}" xmlns:p="${PML_NS}">`;
  yield `<p:cSld>${slideBackgroundXml(slide.background)}<p:spTree>${groupShapeXml()}`;
  if (slide.background?.coverOrange) yield* coverArtworkXml(state);
  if (!slide.background || slide.background.inset !== false) {
    yield shapeXml(state, "Inset surface", boxFromPixels(16, 16, 1168, 643), {
      preset: "roundRect",
      radius: 16,
      fill: solidFill(parseColor("#FFF9EF")),
      line: lineXml(parseColor("#F2E3D5"), 1),
    });
  }
  for (let i = 0; i < slide.blocks.length; ++i) yield* renderBlockXml(state, slide.blocks[i], i);
  yield '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>';
}

function slideRelationships(slide) {
  let xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PACKAGE_REL_NS}">` +
    `<Relationship Id="rId1" Type="${REL_NS}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`;
  for (const relationship of slide.relationships) {
    xml += `<Relationship Id="${relationship.id}" Type="${REL_NS}/image" ` +
      `Target="../media/image${relationship.media.index}.${relationship.media.extension}"/>`;
  }
  return xml + "</Relationships>";
}

function contentTypes(slides, media) {
  let xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="${CONTENT_TYPE_NS}">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>';
  if (media.some(item => item.extension === "png")) xml += '<Default Extension="png" ContentType="image/png"/>';
  if (media.some(item => item.extension === "jpeg")) xml += '<Default Extension="jpeg" ContentType="image/jpeg"/>';
  xml += '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
    '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
    '<Override PartName="/ppt/presProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presProps+xml"/>' +
    '<Override PartName="/ppt/viewProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml"/>' +
    '<Override PartName="/ppt/tableStyles.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"/>' +
    '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
    '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
    '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>';
  for (let i = 1; i <= slides.length; ++i) {
    xml += `<Override PartName="/ppt/slides/slide${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`;
  }
  return xml + "</Types>";
}

function rootRelationships() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PACKAGE_REL_NS}">` +
    `<Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="ppt/presentation.xml"/>` +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    `<Relationship Id="rId3" Type="${REL_NS}/extended-properties" Target="docProps/app.xml"/>` +
    "</Relationships>";
}

function coreProperties() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    '<dc:title>Workspace Slides</dc:title><dc:creator>Gadgets</dc:creator>' +
    '<cp:lastModifiedBy>Gadgets</cp:lastModifiedBy><cp:revision>1</cp:revision></cp:coreProperties>';
}

function appProperties(slideCount) {
  let titles = `<vt:vector size="${slideCount}" baseType="lpstr">`;
  for (let i = 1; i <= slideCount; ++i) titles += `<vt:lpstr>Slide ${i}</vt:lpstr>`;
  titles += "</vt:vector>";
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
    'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
    '<Application>Gadgets</Application><PresentationFormat>Widescreen</PresentationFormat>' +
    `<Slides>${slideCount}</Slides><Notes>0</Notes><HiddenSlides>0</HiddenSlides>` +
    '<MMClips>0</MMClips><ScaleCrop>false</ScaleCrop>' +
    '<HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Slides</vt:lpstr></vt:variant>' +
    `<vt:variant><vt:i4>${slideCount}</vt:i4></vt:variant></vt:vector></HeadingPairs>` +
    `<TitlesOfParts>${titles}</TitlesOfParts><Company>Cloudflare</Company>` +
    '<LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc><HyperlinksChanged>false</HyperlinksChanged>' +
    '<AppVersion>16.0000</AppVersion></Properties>';
}

function presentationXml(slideCount) {
  let xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:a="${DML_NS}" xmlns:r="${REL_NS}" xmlns:p="${PML_NS}" saveSubsetFonts="1" autoCompressPictures="0">` +
    '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>';
  for (let i = 0; i < slideCount; ++i) {
    xml += `<p:sldId id="${256 + i}" r:id="rId${5 + i}"/>`;
  }
  return xml + `</p:sldIdLst><p:sldSz cx="${SLIDE_WIDTH}" cy="${SLIDE_HEIGHT}" type="screen16x9"/>` +
    '<p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle><a:defPPr>' +
    '<a:defRPr lang="en-US" sz="1800"><a:latin typeface="Arial"/><a:ea typeface="Arial"/><a:cs typeface="Arial"/></a:defRPr>' +
    '</a:defPPr></p:defaultTextStyle></p:presentation>';
}

function presentationRelationships(slideCount) {
  let xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PACKAGE_REL_NS}">` +
    `<Relationship Id="rId1" Type="${REL_NS}/slideMaster" Target="slideMasters/slideMaster1.xml"/>` +
    `<Relationship Id="rId2" Type="${REL_NS}/presProps" Target="presProps.xml"/>` +
    `<Relationship Id="rId3" Type="${REL_NS}/viewProps" Target="viewProps.xml"/>` +
    `<Relationship Id="rId4" Type="${REL_NS}/tableStyles" Target="tableStyles.xml"/>`;
  for (let i = 1; i <= slideCount; ++i) {
    xml += `<Relationship Id="rId${i + 4}" Type="${REL_NS}/slide" Target="slides/slide${i}.xml"/>`;
  }
  return xml + "</Relationships>";
}

function presentationProperties() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentationPr xmlns:a="${DML_NS}" xmlns:r="${REL_NS}" xmlns:p="${PML_NS}"/>`;
}

function viewProperties() {
  const scale = '<p:scale><a:sx n="1" d="1"/><a:sy n="1" d="1"/></p:scale><p:origin x="0" y="0"/>';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:viewPr xmlns:a="${DML_NS}" xmlns:r="${REL_NS}" xmlns:p="${PML_NS}" lastView="sldView">` +
    '<p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr>' +
    `<p:slideViewPr><p:cSldViewPr><p:cViewPr varScale="1">${scale}</p:cViewPr><p:guideLst/></p:cSldViewPr></p:slideViewPr>` +
    `<p:notesTextViewPr><p:cViewPr>${scale}</p:cViewPr></p:notesTextViewPr>` +
    '<p:gridSpacing cx="78028800" cy="78028800"/></p:viewPr>';
}

function tableStyles() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:tblStyleLst xmlns:a="${DML_NS}" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`;
}

function masterTextStyle(size, bold, color) {
  return `<a:lvl1pPr algn="l"><a:defRPr lang="en-US" sz="${size}" b="${bold ? 1 : 0}">` +
    `<a:solidFill><a:srgbClr val="${color}"/></a:solidFill>` +
    '<a:latin typeface="Arial"/><a:ea typeface="Arial"/><a:cs typeface="Arial"/></a:defRPr></a:lvl1pPr>';
}

function slideMaster() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster xmlns:a="${DML_NS}" xmlns:r="${REL_NS}" xmlns:p="${PML_NS}">` +
    `<p:cSld name="Blank Master"><p:spTree>${groupShapeXml()}</p:spTree></p:cSld>` +
    '<p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/>' +
    '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>' +
    `<p:txStyles><p:titleStyle>${masterTextStyle(3200, true, "000000")}</p:titleStyle>` +
    `<p:bodyStyle>${masterTextStyle(1800, false, "000000")}</p:bodyStyle>` +
    `<p:otherStyle>${masterTextStyle(1800, false, "000000")}</p:otherStyle></p:txStyles></p:sldMaster>`;
}

function slideMasterRelationships() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PACKAGE_REL_NS}">` +
    `<Relationship Id="rId1" Type="${REL_NS}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>` +
    `<Relationship Id="rId2" Type="${REL_NS}/theme" Target="../theme/theme1.xml"/>` +
    "</Relationships>";
}

function slideLayout() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout xmlns:a="${DML_NS}" xmlns:r="${REL_NS}" xmlns:p="${PML_NS}" type="blank" preserve="1">` +
    `<p:cSld name="Blank"><p:spTree>${groupShapeXml()}</p:spTree></p:cSld>` +
    '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>';
}

function slideLayoutRelationships() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PACKAGE_REL_NS}">` +
    `<Relationship Id="rId1" Type="${REL_NS}/slideMaster" Target="../slideMasters/slideMaster1.xml"/>` +
    "</Relationships>";
}

function themeXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="${DML_NS}" name="Workspace">` +
    '<a:themeElements><a:clrScheme name="Workspace">' +
    '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>' +
    '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
    '<a:dk2><a:srgbClr val="2B0B05"/></a:dk2><a:lt2><a:srgbClr val="F5F1EB"/></a:lt2>' +
    '<a:accent1><a:srgbClr val="FF6633"/></a:accent1><a:accent2><a:srgbClr val="F6821F"/></a:accent2>' +
    '<a:accent3><a:srgbClr val="FBAD41"/></a:accent3><a:accent4><a:srgbClr val="747474"/></a:accent4>' +
    '<a:accent5><a:srgbClr val="0A95FF"/></a:accent5><a:accent6><a:srgbClr val="9B3FF6"/></a:accent6>' +
    '<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink>' +
    '</a:clrScheme><a:fontScheme name="Arial">' +
    '<a:majorFont><a:latin typeface="Arial"/><a:ea typeface="Arial"/><a:cs typeface="Arial"/>' +
    '<a:font script="Jpan" typeface="Arial"/><a:font script="Hang" typeface="Arial"/>' +
    '<a:font script="Hans" typeface="Arial"/><a:font script="Hant" typeface="Arial"/></a:majorFont>' +
    '<a:minorFont><a:latin typeface="Arial"/><a:ea typeface="Arial"/><a:cs typeface="Arial"/>' +
    '<a:font script="Jpan" typeface="Arial"/><a:font script="Hang" typeface="Arial"/>' +
    '<a:font script="Hans" typeface="Arial"/><a:font script="Hant" typeface="Arial"/></a:minorFont>' +
    '</a:fontScheme><a:fmtScheme name="Workspace">' +
    '<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
    '<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="50000"/><a:satMod val="300000"/></a:schemeClr></a:gs>' +
    '<a:gs pos="100000"><a:schemeClr val="phClr"><a:shade val="50000"/><a:satMod val="200000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="16200000" scaled="1"/></a:gradFill>' +
    '<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:shade val="51000"/><a:satMod val="130000"/></a:schemeClr></a:gs>' +
    '<a:gs pos="80000"><a:schemeClr val="phClr"><a:shade val="93000"/><a:satMod val="130000"/></a:schemeClr></a:gs>' +
    '<a:gs pos="100000"><a:schemeClr val="phClr"><a:shade val="94000"/><a:satMod val="135000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="16200000" scaled="0"/></a:gradFill></a:fillStyleLst>' +
    '<a:lnStyleLst><a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>' +
    '<a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>' +
    '<a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln></a:lnStyleLst>' +
    '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>' +
    '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:tint val="95000"/><a:satMod val="170000"/></a:schemeClr></a:solidFill>' +
    '<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="93000"/><a:satMod val="150000"/><a:shade val="98000"/></a:schemeClr></a:gs>' +
    '<a:gs pos="100000"><a:schemeClr val="phClr"><a:tint val="98000"/><a:satMod val="130000"/><a:shade val="90000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="16200000" scaled="0"/></a:gradFill></a:bgFillStyleLst>' +
    '</a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>';
}

export function deckToPptx(deck) {
  const prepared = prepareDeck(deck);
  const entries = [
    {name: "[Content_Types].xml", data: contentTypes(prepared.slides, prepared.media)},
    {name: "_rels/.rels", data: rootRelationships()},
    {name: "docProps/core.xml", data: coreProperties()},
    {name: "docProps/app.xml", data: appProperties(prepared.slides.length)},
    {name: "ppt/presentation.xml", data: presentationXml(prepared.slides.length)},
    {name: "ppt/_rels/presentation.xml.rels", data: presentationRelationships(prepared.slides.length)},
    {name: "ppt/presProps.xml", data: presentationProperties()},
    {name: "ppt/viewProps.xml", data: viewProperties()},
    {name: "ppt/tableStyles.xml", data: tableStyles()},
    {name: "ppt/slideMasters/slideMaster1.xml", data: slideMaster()},
    {name: "ppt/slideMasters/_rels/slideMaster1.xml.rels", data: slideMasterRelationships()},
    {name: "ppt/slideLayouts/slideLayout1.xml", data: slideLayout()},
    {name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels", data: slideLayoutRelationships()},
    {name: "ppt/theme/theme1.xml", data: themeXml()},
  ];
  for (let i = 0; i < prepared.slides.length; ++i) {
    const slide = prepared.slides[i];
    entries.push({
      name: `ppt/slides/slide${i + 1}.xml`,
      data: () => textStream(slideXml(slide)),
    });
    entries.push({
      name: `ppt/slides/_rels/slide${i + 1}.xml.rels`,
      data: slideRelationships(slide),
    });
  }
  for (const media of prepared.media) {
    entries.push({name: `ppt/media/image${media.index}.${media.extension}`, data: media.bytes});
  }
  return createZip(entries);
}
