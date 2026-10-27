// Plain-text family: decoding bytes of unknown provenance to a string, and reducing HTML to text.

/**
 * Decodes text, honouring a UTF-8 or UTF-16 byte order mark and assuming UTF-8 without one.
 * Invalid sequences become U+FFFD rather than failing. UTF-16BE is byte-swapped and decoded as
 * UTF-16LE, which every runtime's `TextDecoder` supports.
 */
export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16le").decode(swapBytePairs(bytes.subarray(2)));
  // The UTF-8 decoder strips a UTF-8 BOM itself.
  return new TextDecoder("utf-8").decode(bytes);
}

/** At most `max` UTF-16 units of `text`, never ending in half of a surrogate pair. */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

function swapBytePairs(bytes: Uint8Array): Uint8Array {
  const swapped = new Uint8Array(bytes.length);
  for (let index = 0; index + 1 < bytes.length; index += 2) {
    swapped[index] = bytes[index + 1]!;
    swapped[index + 1] = bytes[index]!;
  }
  if (bytes.length % 2 === 1) swapped[bytes.length - 1] = bytes[bytes.length - 1]!;
  return swapped;
}

/** Elements whose content is never readable text. */
const HIDDEN_ELEMENTS = ["script", "style", "head", "noscript", "template", "svg"];
const BLOCK_ELEMENT = /^\/?(p|div|br|hr|h[1-6]|ul|ol|tr|table|section|article|header|footer|nav|aside|main|blockquote|pre|dd|dt|dl|figure|figcaption|form|title)$/i;

const HTML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", reg: "®", trade: "™", hellip: "…",
  mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", bull: "•", middot: "·", euro: "€",
};

/**
 * Reduces HTML to readable text: drops comments and non-content elements, turns block boundaries
 * into line breaks and list items into bullets, strips the remaining tags and decodes entities.
 * Every pass is linear (`indexOf` scans and regexes that cannot backtrack across a `<`), so a
 * hostile page cannot make it quadratic. The result is text, never markup to be rendered.
 */
export function htmlToText(html: string): string {
  let text = removeBetween(removeBetween(html, "<!--", "-->"), "<!", ">");
  for (const element of HIDDEN_ELEMENTS) text = removeElement(text, element);
  text = text.replace(/<(\/?[A-Za-z][^<>\s/]*)(?:[\s/][^<>]*)?>/g, (_tag, name: string) => {
    if (/^li$/i.test(name)) return "\n- ";
    if (/^\/?(td|th)$/i.test(name)) return "\t";
    return BLOCK_ELEMENT.test(name) ? "\n" : "";
  });
  return collapseWhitespace(decodeHtmlEntities(text));
}

function removeBetween(text: string, open: string, close: string): string {
  let out = "";
  let at = 0;
  for (;;) {
    const start = text.indexOf(open, at);
    if (start === -1) return out + text.slice(at);
    out += text.slice(at, start);
    const end = text.indexOf(close, start + open.length);
    if (end === -1) return out;
    at = end + close.length;
  }
}

/** Removes `<name ...>...</name>` spans, case-insensitively, through to the end if unclosed. */
function removeElement(text: string, name: string): string {
  const lower = text.toLowerCase();
  let out = "";
  let at = 0;
  for (;;) {
    const start = findTag(lower, `<${name}`, at);
    if (start === -1) return out + text.slice(at);
    out += text.slice(at, start);
    const end = lower.indexOf(`</${name}`, start);
    if (end === -1) return out;
    const close = lower.indexOf(">", end);
    if (close === -1) return out;
    at = close + 1;
  }
}

/** The next `<name` that is the whole tag name (not `<scripts` for `<script`). */
function findTag(lower: string, prefix: string, from: number): number {
  for (let at = lower.indexOf(prefix, from); at !== -1; at = lower.indexOf(prefix, at + 1)) {
    const next = lower[at + prefix.length];
    if (next === undefined || next === ">" || next === "/" || /\s/.test(next)) return at;
  }
  return -1;
}

function decodeHtmlEntities(text: string): string {
  return text.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z]{2,8}));/g, (match, decimal: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (name) return HTML_ENTITIES[name.toLowerCase()] ?? match;
    const codePoint = decimal ? Number.parseInt(decimal, 10) : Number.parseInt(hex!, 16);
    const valid = codePoint > 0 && codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff);
    return valid ? String.fromCodePoint(codePoint) : "�";
  });
}

function collapseWhitespace(text: string): string {
  return text
    .split("\n")
    .map(line => line.replace(/[ \t\f\v\r ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
