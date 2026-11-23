// Images in slides: Markdown image lines, the pixel size of PNG, JPEG and GIF data (so a picture
// keeps its aspect ratio), and the media parts pictures embed.
//
// An image is a line of its own: `![Quarterly revenue chart](Reports/q3-chart.png)`. The caller
// resolves each reference (`imageRefs` lists them) and passes the bytes in; an image inside a
// paragraph or list item stays its description, as the rest of the Office writers do.

import { OpcPackage } from "./pptx-package";

/** The image formats a slide can embed. */
export type PptxImageType = "image/png" | "image/jpeg" | "image/gif";

/** An image's bytes. */
export interface PptxImage {
  readonly bytes: Uint8Array;
  readonly mimeType: PptxImageType;
}

/** Image bytes by the reference an image line names. */
export type PptxImages = ReadonlyMap<string, PptxImage>;

/** An image line, as the slide planner sees it once the Markdown is parsed. */
export interface ImageReference {
  readonly ref: string;
  readonly alt: string;
}

const IMAGE_LINE = /^ {0,3}!\[((?:[^\]\\]|\\.)*)\]\((.*)\)[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** The token an image line becomes before parsing; HTML stays text in the parser, so it survives intact. */
export const IMAGE_TOKEN = /^<!--gadgets-image:(\d+)-->$/;

/** Splits `ref "title"` and `<ref>` destinations into the reference alone. */
function destination(raw: string): string {
  let value = raw.trim();
  const titled = /^(.*?)\s+(?:"[^"]*"|'[^']*')$/.exec(value);
  if (titled) value = titled[1]!.trim();
  if (value.startsWith("<") && value.endsWith(">")) value = value.slice(1, -1);
  return value;
}

/**
 * Rewrites the Markdown so the parser keeps what slides need from it: each image line becomes a
 * token paragraph, and `+++` column breaks and `<!-- layout: ... -->` directives stand as
 * paragraphs of their own. Code blocks are left alone.
 */
export function prepareMarkdown(markdown: string): { markdown: string; images: ImageReference[] } {
  const images: ImageReference[] = [];
  const out: string[] = [];
  let fence: string | undefined;
  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const opener = FENCE.exec(line);
    if (fence) {
      if (opener && opener[1]![0] === fence[0] && opener[1]!.length >= fence.length && line.trim() === opener[1]) fence = undefined;
      out.push(line);
      continue;
    }
    if (opener) {
      fence = opener[1]!;
      out.push(line);
      continue;
    }
    const image = IMAGE_LINE.exec(line);
    if (image) {
      images.push({ alt: image[1]!.replace(/\\(.)/g, "$1"), ref: destination(image[2]!) });
      out.push("", `<!--gadgets-image:${images.length - 1}-->`, "");
    } else if (/^[ \t]*\+\+\+[ \t]*$/.test(line) || /^[ \t]*<!--\s*layout\s*:.*-->[ \t]*$/i.test(line)) {
      out.push("", line.trim(), "");
    } else {
      out.push(line);
    }
  }
  return { markdown: out.join("\n"), images };
}

/** The image references in Markdown, each once, in the order they appear. */
export function imageRefs(markdown: string): string[] {
  return [...new Set(prepareMarkdown(markdown).images.map(image => image.ref))];
}

/** Slide content that can't be written as asked: a missing image, an unknown layout, too many columns. The message says what to change. */
export class SlideContentError extends Error {
  override readonly name = "SlideContentError";
}

/** Width and height in pixels, read from the image's own header. Throws `SlideContentError` when the bytes aren't the type claimed. */
export function imageSize(image: PptxImage, ref: string): { width: number; height: number } {
  const { bytes, mimeType } = image;
  const size = mimeType === "image/png" ? pngSize(bytes) : mimeType === "image/jpeg" ? jpegSize(bytes) : gifSize(bytes);
  if (!size || size.width <= 0 || size.height <= 0) {
    throw new SlideContentError(`The image ${JSON.stringify(ref)} isn't a valid ${mimeType.slice(6).toUpperCase()} file.`);
  }
  return size;
}

function pngSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || signature.some((value, index) => bytes[index] !== value)) return undefined;
  if (String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR") return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function gifSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 10 || String.fromCharCode(...bytes.subarray(0, 4)) !== "GIF8") return undefined;
  return { width: bytes[6]! | (bytes[7]! << 8), height: bytes[8]! | (bytes[9]! << 8) };
}

function jpegSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return undefined;
    const marker = bytes[at + 1]!;
    if (marker === 0xff) {
      at++;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    const length = (bytes[at + 2]! << 8) | bytes[at + 3]!;
    // Start-of-frame markers, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: (bytes[at + 5]! << 8) | bytes[at + 6]!, width: (bytes[at + 7]! << 8) | bytes[at + 8]! };
    }
    at += 2 + length;
  }
  return undefined;
}

const EXTENSIONS: Record<PptxImageType, string> = { "image/png": "png", "image/jpeg": "jpeg", "image/gif": "gif" };
/** The relationship type of an embedded picture. */
const IMAGE_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";

/** Media parts written in this package, by reference, so an image used twice is stored once. */
export class MediaStore {
  readonly #parts = new Map<string, string>();

  constructor(private readonly pkg: OpcPackage, private readonly images: PptxImages | undefined) {}

  /** The image a reference names. Throws `SlideContentError` when the caller didn't supply it or it can't be used. */
  get(ref: string): PptxImage & { width: number; height: number } {
    const image = this.images?.get(ref);
    if (!image) {
      throw new SlideContentError(`The image ${JSON.stringify(ref)} wasn't provided. Every image line (![description](reference)) needs its file.`);
    }
    if (!(image.mimeType in EXTENSIONS)) throw new SlideContentError(`The image ${JSON.stringify(ref)} is ${image.mimeType}; slides take PNG, JPEG or GIF.`);
    return { ...image, ...imageSize(image, ref) };
  }

  /** Relates the image from `source`, writing its media part the first time. Returns the blip markup. */
  blip(source: string, ref: string): string {
    const image = this.get(ref);
    let part = this.#parts.get(ref);
    if (part === undefined) {
      const extension = EXTENSIONS[image.mimeType];
      part = this.pkg.freeName("ppt/media/image", `.${extension}`);
      this.pkg.set(part, image.bytes);
      this.pkg.setDefault(extension, image.mimeType);
      this.#parts.set(ref, part);
    }
    return `<a:blip r:embed="${this.pkg.relate(source, IMAGE_REL, part)}"/>`;
  }
}
