/**
 * The bytes a drawing of a slide needs beside its model: the pictures Google keeps for it, and
 * the fonts its text is set in. A frame that draws a slide has no network, so both reach it through
 * the session.
 */

import { readBytesCapped } from "@gadgets/gatekeeper-kit/response-body";
import { cappedStream } from "./byte-stream";
import type { SlidePictureBytes } from "./slides-rendering-types";

const REQUEST_TIMEOUT_MS = 30_000;

/** The largest picture a session returns: one drawn across a whole slide runs to about 1 MiB. */
export const MAX_PICTURE_BYTES = 6 * 1024 * 1024;
/** A slide's width in pixels where it is drawn largest, on a high-density screen. */
const SLIDE_PIXELS = 1600;
const MIN_PICTURE_PIXELS = 200;
const MAX_PICTURE_PIXELS = 2048;

const CONTENT_HOST_SUFFIX = ".googleusercontent.com";
// An uploaded picture's address is on Docs, which redirects it once to the image host.
const REDIRECT_HOST = "docs.google.com";
// The image host's size option, ending the path: `=s2048` serves the picture with its longer side
// at most 2048 pixels.
const SIZE_OPTION = /=s\d+$/;
// What the image host answers for an address that has lapsed: it lasts 30 minutes.
const LAPSED = new Set([400, 403, 404, 410]);
const PICTURE_TYPES: { mimeType: string; at: number; bytes: number[] }[] = [
  { mimeType: "image/png", at: 0, bytes: [0x89, 0x50, 0x4e, 0x47] },
  { mimeType: "image/jpeg", at: 0, bytes: [0xff, 0xd8, 0xff] },
  { mimeType: "image/gif", at: 0, bytes: [0x47, 0x49, 0x46, 0x38] },
  { mimeType: "image/webp", at: 8, bytes: [0x57, 0x45, 0x42, 0x50] },
];
/** As much of a picture's start as tells its type. */
const PICTURE_HEAD_BYTES = 12;

/**
 * How many pixels long to fetch the longer side of a picture whose longer side is drawn `side`
 * long on a slide `slideWidth` wide.
 */
export function picturePixels(side: number, slideWidth: number): number {
  let pixels = Math.ceil(side / slideWidth * SLIDE_PIXELS / 100) * 100;
  return Number.isFinite(pixels)
    ? Math.min(MAX_PICTURE_PIXELS, Math.max(MIN_PICTURE_PIXELS, pixels)) : SLIDE_PIXELS;
}

// A picture's address is a bearer URL, so it is fetched only from Google's own hosts.
function googleUrl(address: string | null | undefined, base?: URL): URL {
  let url = URL.parse(address ?? "", base);
  let onGoogle = url?.protocol === "https:" &&
    (url.hostname.endsWith(CONTENT_HOST_SUFFIX) || url.hostname === REDIRECT_HOST);
  if (!url || !onGoogle) throw new Error("Google Slides returned a picture address outside Google");
  return url;
}

function sized(url: URL, pixels: number): URL {
  if (url.hostname === REDIRECT_HOST || !SIZE_OPTION.test(url.pathname)) return url;
  let resized = new URL(url);
  resized.pathname = url.pathname.replace(SIZE_OPTION, `=s${pixels}`);
  return resized;
}

/**
 * Opens the picture Google serves at `contentUrl`, its longer side at most `pixels` where its
 * host can resize it, or returns undefined when the address has lapsed. Throws when Google fails
 * to serve it for any other reason, which a new address would not mend. No credentials are sent,
 * as the address is the authority.
 */
export async function downloadPicture(
  contentUrl: string, pixels: number,
): Promise<SlidePictureBytes | undefined> {
  let get = (url: URL) => fetch(sized(url, pixels), {
    redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  let from = googleUrl(contentUrl);
  let response = await get(from);
  if (from.hostname === REDIRECT_HOST && response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    response = await get(googleUrl(response.headers.get("location"), from));
  }
  if (!response.ok) {
    await response.body?.cancel();
    if (LAPSED.has(response.status)) return undefined;
    throw new Error(`readPicture: Google did not serve this picture [http=${response.status}].`);
  }
  let tooLarge = "readPicture: this picture is larger than 6 MB.";
  if (Number(response.headers.get("content-length")) > MAX_PICTURE_BYTES || !response.body) {
    await response.body?.cancel();
    throw new Error(response.body ? tooLarge : "readPicture: Google returned no picture.");
  }
  // Its start says what the picture is, so that much is read before any of it is handed on.
  let reader = response.body.getReader();
  let head = new Uint8Array();
  while (head.byteLength < PICTURE_HEAD_BYTES) {
    let { done, value } = await reader.read();
    if (done) break;
    let read = new Uint8Array(head.byteLength + value.byteLength);
    read.set(head);
    read.set(value, head.byteLength);
    head = read;
  }
  let type = PICTURE_TYPES.find(({ at, bytes: magic }) => magic.every((byte, i) => head[at + i] === byte));
  if (!type) {
    await reader.cancel();
    throw new Error("readPicture: this picture's format cannot be read.");
  }
  return { mimeType: type.mimeType, content: cappedStream(reader, MAX_PICTURE_BYTES, tooLarge, head) };
}

const FONTS_CSS = "https://fonts.googleapis.com/css2";
const FONTS_HOST = "fonts.gstatic.com";
/** A font for one script is under 1 MiB; one for Chinese, Japanese or Korean is refused. */
const MAX_FONT_BYTES = 3 * 1024 * 1024;
const MAX_FONT_CSS_BYTES = 64 * 1024;
// The names Google Fonts gives its families: nothing a request could carry anything else in.
const FAMILY = /^[A-Za-z0-9][A-Za-z0-9 ]{0,62}$/;
// How a font file starts: TrueType, OpenType, or either compressed.
const FONT_TYPES = ["\u0000\u0001\u0000\u0000", "OTTO", "true", "wOFF", "wOF2"];
/** As many bytes of fonts as an isolate keeps: about the fonts of two dozen decks. */
export const MAX_CACHED_FONT_BYTES = 16 * 1024 * 1024;

// Fonts are public and never change under one address, so every session of this isolate shares
// what has been fetched: the bytes, as a promise made for one session cannot be awaited by another.
const fonts = new Map<string, Uint8Array>();

/** Whether Google Fonts could have a family of this name, at this weight. */
export function isFontRequest(family: string, weight: number): boolean {
  return FAMILY.test(family) && Number.isInteger(weight / 100) && weight >= 100 && weight <= 900;
}

async function fetchFont(family: string, weight: number, italic: boolean): Promise<Uint8Array> {
  let css = new URL(FONTS_CSS);
  css.searchParams.set("family", `${family}:ital,wght@${italic ? 1 : 0},${weight}`);
  let signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  // Asked with no browser's name, Google Fonts answers with one file holding every script.
  let sheet = await fetch(css, { redirect: "manual", signal });
  if (!sheet.ok) {
    await sheet.body?.cancel();
    throw new Error(`readFont: Google Fonts does not serve "${family}" at weight ${weight}` +
      `${italic ? " italic" : ""}.`);
  }
  let rules = new TextDecoder().decode(await readBytesCapped(sheet, MAX_FONT_CSS_BYTES));
  let file = URL.parse(/src:\s*url\(([^)\s]+)\)/.exec(rules)?.[1] ?? "");
  if (file?.protocol !== "https:" || file.hostname !== FONTS_HOST) {
    throw new Error("readFont: Google Fonts returned no font file.");
  }
  let response = await fetch(file, { redirect: "manual", signal });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`readFont: the font download failed [http=${response.status}].`);
  }
  let bytes = await readBytesCapped(response, MAX_FONT_BYTES);
  let start = String.fromCharCode(...bytes.subarray(0, 4));
  if (!FONT_TYPES.includes(start)) throw new Error("readFont: Google Fonts returned no font file.");
  return bytes;
}

/**
 * The file of one font of a family Google Fonts serves, which is public: the family's name is all
 * the request carries. Throws when Google Fonts has no such font, or it is larger than 3 MiB.
 */
export async function downloadFont(family: string, weight: number, italic: boolean): Promise<Uint8Array> {
  let key = `${family}\u0000${weight}\u0000${italic}`;
  let font = fonts.get(key);
  if (font) return font;
  font = await fetchFont(family, weight, italic);
  fonts.set(key, font);
  // The oldest go first.
  let kept = [...fonts.values()].reduce((sum, { byteLength }) => sum + byteLength, 0);
  for (let [oldest, { byteLength }] of fonts) {
    if (kept <= MAX_CACHED_FONT_BYTES) break;
    fonts.delete(oldest);
    kept -= byteLength;
  }
  return font;
}
