// Builds the small PDFs the renderer's tests render. One 96 x 64 pattern, drawn by a formula, is
// stored each way a scan's page is, on a page of 96 x 64 points, so that at 72 dpi a page is its
// image and a render can be held to the pattern pixel for pixel. The encodings that cannot be
// written here (fax, JPEG 2000) are embedded as a few kilobytes of base64. The hostile shapes are
// PDFs of a few kilobytes, built from text, that pass every check of a size or a count of their
// own and cost a call into PDFium as much as they can.

import { deflateSync } from "node:zlib";

/** The pattern's size in pixels, and in points the size of the page it is put on. */
export const PATTERN_WIDTH = 96;
/** See {@link PATTERN_WIDTH}. */
export const PATTERN_HEIGHT = 64;

/**
 * Whether the pattern has a mark at a pixel: a corner mark, three bars, an upright and a
 * diagonal. Turned, mirrored or cut short, it shows.
 */
function marked(x: number, y: number): boolean {
  return (x < 12 && y < 6) || (y % 16 >= 10 && y % 16 < 13 && x >= 16 && x < 80) ||
    (x >= 84 && x < 88 && y >= 8 && y < 56) || (Math.abs(x - y) <= 1 && x >= 20 && x < 60);
}

/** The pattern's pixels, row by row, each what `grey` gives for it. */
function drawn(grey: (x: number, y: number) => number): Uint8Array {
  let pixels = new Uint8Array(PATTERN_WIDTH * PATTERN_HEIGHT);
  for (let y = 0; y < PATTERN_HEIGHT; y++) {
    for (let x = 0; x < PATTERN_WIDTH; x++) pixels[y * PATTERN_WIDTH + x] = grey(x, y);
  }
  return pixels;
}

/** The pattern as black marks on white, a grey byte a pixel: what a one-bit page renders to. */
export const PATTERN_MARKS = drawn((x, y) => marked(x, y) ? 0 : 255);
/**
 * The same marks in black on paper that shades across the page, so that an image with levels
 * has them: what the lossless grey images render to.
 */
export const PATTERN_SHADED = drawn((x, y) => marked(x, y) ? 0 : 240 - (x >> 3) - (y >> 3));

/**
 * {@link PATTERN_MARKS} as Group 4 fax data, 74 bytes. Pillow wrote the marks as a Group 4 TIFF
 * whose 0 bits are white (`compression="group4"`, photometric interpretation 0, all 64 rows in
 * one strip), and this is that one strip taken out of the file.
 */
export const FAX_BASE64 =
  "JqH//8c7EPzUB4b//x///Ihe/fb7fb7fNQHhv//Ji7fb7fb7fb7fb7fb7fb5qA8N//5Lbt9vt9vt9vt9vt9vtjbmoDw3/jwAQAQ=";

/**
 * {@link PATTERN_SHADED} as a lossless grey JPEG 2000 file, 1,893 bytes: Pillow's
 * `save(…, "JPEG2000", irreversible=False)`, read back and found equal to the pattern.
 */
export const JPX_BASE64 = [
  "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",
  "I4jwueiFNRppDpHmCWRZf//Z",
].join("");

/** The side, in pixels, of the image {@link SQUARE_JPX_BASE64} holds. */
export const SQUARE_SIDE = 2048;
/**
 * A 2048 x 2048 lossless grey JPEG 2000 codestream of one black square on white, from a quarter
 * to a half of the way along each side, 2,048 bytes: small as a file and large to decode. A JPEG
 * 2000 image is decoded at half its size, a quarter and so on when that is enough for a render,
 * so a page of it needs less memory at a lower resolution. Pillow's `save(…, "JPEG2000",
 * irreversible=False, no_jp2=True, num_resolutions=8, codeblock_size=(64, 64))`.
 */
export const SQUARE_JPX_BASE64 = [
  "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",
  "Y8t0+JkRWX/4UDAJrVyAvxLQN5F//9k=",
].join("");

/** The bytes `base64` stands for. */
export function decoded(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), character => character.charCodeAt(0));
}

/** `text` as bytes, one a character: PDF syntax is written in the first 256. */
function latin1(text: string): Uint8Array {
  return Uint8Array.from(text, character => character.charCodeAt(0));
}

/** `text` over and over, cut off at `bytes` bytes. */
function repeated(text: string, bytes: number): Uint8Array {
  let out = new Uint8Array(bytes);
  out.set(latin1(text).subarray(0, bytes));
  for (let filled = Math.min(text.length, bytes); filled < bytes; filled *= 2) {
    out.copyWithin(filled, 0, Math.min(filled, bytes - filled));
  }
  return out;
}

/** One JBIG2 segment: its number, its type, no segments referred to, page 1, its length, its data. */
function segment(number: number, type: number, data: Uint8Array): Uint8Array {
  let out = new Uint8Array(11 + data.byteLength);
  let view = new DataView(out.buffer);
  view.setUint32(0, number);
  out[4] = type;
  out[6] = 1;
  view.setUint32(7, data.byteLength);
  out.set(data, 11);
  return out;
}

/**
 * The states of the arithmetic coder JBIG2 and JPEG 2000 share (the MQ coder): for each, the
 * chance given to the less probable symbol, the state after a more probable symbol, the state
 * after a less probable one, and whether that one makes the two change places.
 */
const MQ_STATES: [qe: number, afterMore: number, afterLess: number, switches: number][] = [
  [0x5601, 1, 1, 1], [0x3401, 2, 6, 0], [0x1801, 3, 9, 0], [0x0ac1, 4, 12, 0], [0x0521, 5, 29, 0],
  [0x0221, 38, 33, 0], [0x5601, 7, 6, 1], [0x5401, 8, 14, 0], [0x4801, 9, 14, 0], [0x3801, 10, 14, 0],
  [0x3001, 11, 17, 0], [0x2401, 12, 18, 0], [0x1c01, 13, 20, 0], [0x1601, 29, 21, 0], [0x5601, 15, 14, 1],
  [0x5401, 16, 14, 0], [0x5101, 17, 15, 0], [0x4801, 18, 16, 0], [0x3801, 19, 17, 0], [0x3401, 20, 18, 0],
  [0x3001, 21, 19, 0], [0x2801, 22, 19, 0], [0x2401, 23, 20, 0], [0x2201, 24, 21, 0], [0x1c01, 25, 22, 0],
  [0x1801, 26, 23, 0], [0x1601, 27, 24, 0], [0x1401, 28, 25, 0], [0x1201, 29, 26, 0], [0x1101, 30, 27, 0],
  [0x0ac1, 31, 28, 0], [0x09c1, 32, 29, 0], [0x08a1, 33, 30, 0], [0x0521, 34, 31, 0], [0x0441, 35, 32, 0],
  [0x02a1, 36, 33, 0], [0x0221, 37, 34, 0], [0x0141, 38, 35, 0], [0x0111, 39, 36, 0], [0x0085, 40, 37, 0],
  [0x0049, 41, 38, 0], [0x0025, 42, 39, 0], [0x0015, 43, 40, 0], [0x0009, 44, 41, 0], [0x0005, 45, 42, 0],
  [0x0001, 45, 43, 0], [0x5601, 46, 46, 0],
];

/**
 * The pattern's marks coded arithmetically, as a scanner's JBIG2 is: the data of a generic
 * region under template 0 with its adaptive pixels where the standard puts them, so that each
 * pixel is coded in the context of the sixteen before it, on its own row and the two above.
 */
function arithmeticMarks(): Uint8Array {
  let black = (x: number, y: number) =>
    x >= 0 && x < PATTERN_WIDTH && y >= 0 && PATTERN_MARKS[y * PATTERN_WIDTH + x] === 0 ? 1 : 0;
  let state = new Uint8Array(1 << 16), more = new Uint8Array(1 << 16);
  // The byte before the first is the coder's own, and is left out of what it wrote.
  let bytes = [0];
  let a = 0x8000, c = 0, left = 12;
  let byteOut = () => {
    let last = bytes.length - 1;
    if (bytes[last] !== 0xff && c >= 0x8000000) {
      bytes[last]!++;
      c &= 0x7ffffff;
    }
    if (bytes[last] === 0xff) {
      bytes.push(c >>> 20);
      c &= 0xfffff;
      left = 7;
    } else {
      bytes.push(c >>> 19);
      c &= 0x7ffff;
      left = 8;
    }
  };
  let renormalize = () => {
    do {
      a <<= 1;
      c <<= 1;
      if (--left === 0) byteOut();
    } while ((a & 0x8000) === 0);
  };
  for (let y = 0; y < PATTERN_HEIGHT; y++) {
    for (let x = 0; x < PATTERN_WIDTH; x++) {
      let context = 0;
      for (let dx = -2; dx <= 2; dx++) context = context << 1 | black(x + dx, y - 2);
      for (let dx = -3; dx <= 3; dx++) context = context << 1 | black(x + dx, y - 1);
      for (let dx = -4; dx <= -1; dx++) context = context << 1 | black(x + dx, y);
      let [qe, afterMore, afterLess, switches] = MQ_STATES[state[context]!]!;
      a -= qe;
      if (black(x, y) === more[context]) {
        if (a & 0x8000) {
          c += qe;
          continue;
        }
        if (a < qe) a = qe;
        else c += qe;
        state[context] = afterMore;
      } else {
        if (a < qe) c += qe;
        else a = qe;
        if (switches) more[context]! ^= 1;
        state[context] = afterLess;
      }
      renormalize();
    }
  }
  // What is left of the code is written out, then the marker that ends it.
  let upper = c + a;
  c |= 0xffff;
  if (c >= upper) c -= 0x8000;
  for (let i = 0; i < 2; i++) {
    c = c * 2 ** left;
    byteOut();
  }
  if (bytes.at(-1) !== 0xff) bytes.push(0xff);
  bytes.push(0xac);
  return Uint8Array.from(bytes.slice(1));
}

/**
 * Data for the pattern as JBIG2 in the form a PDF embeds: a page information segment, then one
 * generic region. `data` is the region's as MMR, which is Group 4 fax, with 59 bytes of headers
 * around it; or coded arithmetically, when `arithmetic`, under template 0, whose four adaptive
 * pixels the region then names.
 */
export function jbig2Of(data: Uint8Array, arithmetic = false): Uint8Array {
  let adaptive = arithmetic ? Uint8Array.of(3, 0xff, 0xfd, 0xff, 2, 0xfe, 0xfe, 0xfe) : new Uint8Array(0);
  let info = new Uint8Array(19), region = new Uint8Array(18 + adaptive.byteLength + data.byteLength);
  new DataView(info.buffer).setUint32(0, PATTERN_WIDTH);
  new DataView(info.buffer).setUint32(4, PATTERN_HEIGHT);
  // The page's default pixel is 0 and a region's pixels replace it.
  info[16] = 0x01;
  new DataView(region.buffer).setUint32(0, PATTERN_WIDTH);
  new DataView(region.buffer).setUint32(4, PATTERN_HEIGHT);
  // The region's flags: coded as MMR, or arithmetically under template 0.
  region[17] = arithmetic ? 0x00 : 0x01;
  region.set(adaptive, 18);
  region.set(data, 18 + adaptive.byteLength);
  let page = segment(0, 48, info), generic = segment(1, 38, region);
  let out = new Uint8Array(page.byteLength + generic.byteLength);
  out.set(page);
  out.set(generic, page.byteLength);
  return out;
}

/** One object of a PDF. */
export type PdfObject = {
  id: number;
  /**
   * The object as written, or for a stream its dictionary's entries, to which `/Length` is
   * added, and `/Filter /FlateDecode` unless the stream is `raw`.
   */
  dict: string;
  /** A stream's data. It is deflated on its way into the file unless `raw`. */
  stream?: Uint8Array;
  /** Whether `stream` is already as the file stores it, by a filter `dict` names when it has one. */
  raw?: boolean;
};

/**
 * A PDF of `objects`, of which object 1 is the catalog, with a cross-reference table. `trailer`
 * adds entries to the trailer dictionary as written, such as an `/Encrypt` reference.
 */
export function pdfOf(objects: PdfObject[], trailer = ""): Uint8Array {
  let parts: Uint8Array[] = [];
  let size = 0;
  let push = (part: string | Uint8Array) => {
    let bytes = typeof part === "string" ? latin1(part) : part;
    parts.push(bytes);
    size += bytes.byteLength;
  };
  let offsets: number[] = [];
  push("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n");
  for (let object of objects) {
    offsets[object.id] = size;
    if (object.stream) {
      let data = object.raw ? object.stream : deflateSync(object.stream, { level: 9 });
      let filter = object.raw ? "" : " /Filter /FlateDecode";
      push(`${object.id} 0 obj\n<< ${object.dict}${filter} /Length ${data.byteLength} >>\nstream\n`);
      push(data);
      push("\nendstream\nendobj\n");
    } else {
      push(`${object.id} 0 obj\n${object.dict}\nendobj\n`);
    }
  }
  let last = Math.max(...objects.map(object => object.id));
  let xref = size;
  push(`xref\n0 ${last + 1}\n0000000000 65535 f \n`);
  for (let id = 1; id <= last; id++) {
    let offset = offsets[id];
    push(offset === undefined ? "0000000000 65535 f \n" : `${String(offset).padStart(10, "0")} 00000 n \n`);
  }
  push(`trailer\n<< /Size ${last + 1} /Root 1 0 R${trailer} >>\nstartxref\n${xref}\n%%EOF\n`);
  let out = new Uint8Array(size);
  let at = 0;
  for (let part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

/** An image as a PDF stores it: its dictionary's entries besides the type, and its data. */
export type ScanImage = { dict: string; data: Uint8Array };

/** One page of a scan: the images its resources name, as `/Im0`, `/Im1` and so on, and what it draws. */
export type ScanPage = {
  images: ScanImage[];
  /** The content stream, as written. */
  content: string;
  /** The page's own `/Rotate`, when it has one. */
  rotate?: number;
  /** The page's size in points, 96 x 64 unless given. */
  size?: [width: number, height: number];
};

/** What a page of the pattern's size draws to show `/Im0` across the whole of itself. */
export const DRAWN_WHOLE = `q ${PATTERN_WIDTH} 0 0 ${PATTERN_HEIGHT} 0 0 cm /Im0 Do Q`;

/** A dictionary's `/Rotate` entry, when there is a `rotate` to write. */
function turned(rotate: number | undefined): string {
  return rotate === undefined ? "" : ` /Rotate ${rotate}`;
}

/**
 * A PDF of `pages`, each 96 x 64 points unless it says otherwise. Page `n`'s object is followed
 * by its content and then its images. `order` lists the pages as the page tree is to name them,
 * by their place in `pages`, when that is not the file's order; `rotate` is a `/Rotate` on the
 * page tree's root, which its pages inherit; `trailer` adds entries to the trailer dictionary.
 */
export function scannedPdf(
  pages: ScanPage[], options: { order?: number[]; rotate?: number; trailer?: string } = {},
): Uint8Array {
  let next = 3;
  let ids = pages.map(page => {
    let id = next;
    next += 2 + page.images.length;
    return id;
  });
  let kids = (options.order ?? pages.map((_, i) => i)).map(i => `${ids[i]} 0 R`).join(" ");
  let objects: PdfObject[] = [
    { id: 1, dict: "<< /Type /Catalog /Pages 2 0 R >>" },
    { id: 2, dict: `<< /Type /Pages /Count ${pages.length}${turned(options.rotate)} /Kids [${kids}] >>` },
  ];
  pages.forEach((page, i) => {
    let id = ids[i]!;
    let [width, height] = page.size ?? [PATTERN_WIDTH, PATTERN_HEIGHT];
    let named = page.images.map((_, n) => `/Im${n} ${id + 2 + n} 0 R`).join(" ");
    objects.push({
      id,
      dict: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}]${turned(page.rotate)} ` +
        `/Contents ${id + 1} 0 R /Resources << /XObject << ${named} >> >> >>`,
    });
    objects.push({ id: id + 1, dict: "", stream: latin1(page.content), raw: true });
    page.images.forEach((image, n) => objects.push({
      id: id + 2 + n, dict: `/Type /XObject /Subtype /Image ${image.dict}`, stream: image.data, raw: true,
    }));
  });
  return pdfOf(objects, options.trailer);
}

/** A page that shows `image` across the whole of itself, or draws `content` with it as `/Im0`. */
export function onePage(image: ScanImage, content = DRAWN_WHOLE): ScanPage {
  return { images: [image], content };
}

const PATTERN_SIZE = `/Width ${PATTERN_WIDTH} /Height ${PATTERN_HEIGHT}`;
const ONE_BIT_GREY = `${PATTERN_SIZE} /ColorSpace /DeviceGray /BitsPerComponent 1`;

/** The marks as Group 4 fax, or `data` in their place under the same dictionary. */
export function faxImage(data = decoded(FAX_BASE64)): ScanImage {
  let parms = `<< /K -1 /Columns ${PATTERN_WIDTH} /Rows ${PATTERN_HEIGHT} >>`;
  return { dict: `${ONE_BIT_GREY} /Filter /CCITTFaxDecode /DecodeParms ${parms}`, data };
}

/** The marks as JBIG2: the fax data in an MMR generic region. */
export function jbig2Image(): ScanImage {
  return { dict: `${ONE_BIT_GREY} /Filter /JBIG2Decode`, data: jbig2Of(decoded(FAX_BASE64)) };
}

/** The marks as JBIG2 coded arithmetically, which is how scanners write it. */
export function arithmeticJbig2Image(): ScanImage {
  return { dict: `${ONE_BIT_GREY} /Filter /JBIG2Decode`, data: jbig2Of(arithmeticMarks(), true) };
}

/** The shaded pattern as lossless JPEG 2000. */
export function jpxImage(): ScanImage {
  return {
    dict: `${PATTERN_SIZE} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /JPXDecode`,
    data: decoded(JPX_BASE64),
  };
}

/** The marks as rows of one-bit samples, 1 for white: what a one-bit grey image holds. */
export function patternBits(): Uint8Array {
  let rowBytes = Math.ceil(PATTERN_WIDTH / 8);
  let out = new Uint8Array(rowBytes * PATTERN_HEIGHT);
  for (let y = 0; y < PATTERN_HEIGHT; y++) {
    for (let x = 0; x < PATTERN_WIDTH; x++) {
      if (PATTERN_MARKS[y * PATTERN_WIDTH + x] === 255) out[y * rowBytes + (x >> 3)]! |= 0x80 >> (x & 7);
    }
  }
  return out;
}

/** The marks as deflated one-bit samples whose dictionary says of them what `entries` does. */
export function bitsImage(entries = "/ColorSpace /DeviceGray"): ScanImage {
  return {
    dict: `${PATTERN_SIZE} ${entries} /BitsPerComponent 1 /Filter /FlateDecode`,
    data: deflateSync(patternBits()),
  };
}

/** A grey image of `width` x `height` deflated 8-bit `samples`. */
export function greyImage(samples: Uint8Array, width: number, height: number): ScanImage {
  return {
    dict: `/Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`,
    data: deflateSync(samples),
  };
}

/** A one-page PDF of the marks as Group 4 fax. */
export function faxPdf(): Uint8Array {
  return scannedPdf([onePage(faxImage())]);
}

/** A one-page PDF of the marks as JBIG2. */
export function jbig2Pdf(): Uint8Array {
  return scannedPdf([onePage(jbig2Image())]);
}

/** A one-page PDF of the shaded pattern as lossless JPEG 2000. */
export function jpxPdf(): Uint8Array {
  return scannedPdf([onePage(jpxImage())]);
}

/** `pixels`, `width` x `height`, turned clockwise by `quarters` quarter turns: as a `/Rotate` shows a page. */
export function turnedClockwise(pixels: Uint8Array, width: number, height: number, quarters: number): Uint8Array {
  let out = new Uint8Array(pixels.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let value = pixels[y * width + x]!;
      if (quarters === 1) out[x * height + (height - 1 - y)] = value;
      else if (quarters === 2) out[(height - 1 - y) * width + (width - 1 - x)] = value;
      else if (quarters === 3) out[(width - 1 - x) * height + y] = value;
      else out[y * width + x] = value;
    }
  }
  return out;
}

const CATALOG: PdfObject = { id: 1, dict: "<< /Type /Catalog /Pages 2 0 R >>" };
const ONE_PAGE_TREE: PdfObject = { id: 2, dict: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" };

/** A page object of a PDF built from text: `size` points, with `entries` as its other entries. */
function textPage(id: number, entries: string, size = "612 792"): PdfObject {
  return { id, dict: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${size}] ${entries} >>` };
}

/**
 * `objects` as a PDF, with one small image after them that no page draws: the scan routes a PDF
 * to the renderer for an image like it, so these are files the renderer is given.
 */
function withUndrawnImage(objects: PdfObject[]): Uint8Array {
  let image: PdfObject = {
    id: Math.max(...objects.map(object => object.id)) + 1,
    dict: "/Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceGray /BitsPerComponent 8",
    stream: new Uint8Array(64),
  };
  return pdfOf([...objects, image]);
}

/**
 * A US Letter page filled `count` times over, each fill half transparent and multiplied into
 * what is under it: every fill is blended into every pixel of the page.
 */
export function blendedFills(count: number): Uint8Array {
  return withUndrawnImage([
    CATALOG, ONE_PAGE_TREE,
    textPage(3, "/Resources << /ExtGState << /G << /ca 0.5 /BM /Multiply >> >> >> /Contents 4 0 R"),
    { id: 4, dict: "", stream: latin1(`/G gs\n${"0.9 g 0 0 612 792 re f\n".repeat(count)}`) },
  ]);
}

/** A US Letter page painted `count` times with a radial shading that reaches past its edges. */
export function radialShadings(count: number): Uint8Array {
  let shading = "<< /ShadingType 3 /ColorSpace /DeviceGray /Coords [306 396 0 306 396 900] /Extend [true true] " +
    "/Function << /FunctionType 2 /Domain [0 1] /C0 [0.95] /C1 [1] /N 3.7 >> >>";
  return withUndrawnImage([
    CATALOG, ONE_PAGE_TREE, textPage(3, "/Resources << /Shading << /S 5 0 R >> >> /Contents 4 0 R"),
    { id: 4, dict: "", stream: latin1("/S sh\n".repeat(count)) },
    { id: 5, dict: shading },
  ]);
}

/**
 * A US Letter page that draws one form `times` times, the form `formBytes` bytes of `q Q`: a
 * form's content is parsed again each time it is drawn, and all of it when the page is loaded.
 */
export function formDrawnAgain(times: number, formBytes: number): Uint8Array {
  return withUndrawnImage([
    CATALOG, ONE_PAGE_TREE, textPage(3, "/Resources << /XObject << /F 5 0 R >> >> /Contents 4 0 R"),
    { id: 4, dict: "", stream: latin1("/F Do\n".repeat(times)) },
    { id: 5, dict: "/Type /XObject /Subtype /Form /BBox [0 0 612 792]", stream: repeated("q Q\n", formBytes) },
  ]);
}

/**
 * A US Letter page that draws a form `fan` times, which draws the next `fan` times, and so on
 * for `levels` levels of forms, the innermost `formBytes` bytes of `q Q`.
 */
export function nestedForms(fan: number, levels: number, formBytes: number): Uint8Array {
  let draws = latin1("/F Do\n".repeat(fan));
  let objects = [
    CATALOG, ONE_PAGE_TREE, textPage(3, "/Resources << /XObject << /F 10 0 R >> >> /Contents 4 0 R"),
    { id: 4, dict: "", stream: draws },
  ];
  for (let level = 0; level < levels; level++) {
    let innermost = level === levels - 1;
    objects.push({
      id: 10 + level,
      dict: "/Type /XObject /Subtype /Form /BBox [0 0 612 792] " +
        `/Resources << /XObject << /F ${11 + level} 0 R >> >>`,
      stream: innermost ? repeated("q Q\n", formBytes) : draws,
    });
  }
  return withUndrawnImage(objects);
}

/** `pages` US Letter pages that all have one content stream, `contentBytes` bytes of `q Q`: every page is blank. */
export function sharedContentPages(pages: number, contentBytes: number): Uint8Array {
  let kids = Array.from({ length: pages }, (_, i) => `${10 + i} 0 R`).join(" ");
  return withUndrawnImage([
    CATALOG, { id: 2, dict: `<< /Type /Pages /Kids [${kids}] /Count ${pages} >>` },
    { id: 4, dict: "", stream: repeated("q Q\n", contentBytes) },
    ...Array.from({ length: pages }, (_, i) => textPage(10 + i, "/Contents 4 0 R")),
  ]);
}

/**
 * A page of the pattern's size that draws nothing and carries a stamp: an annotation whose
 * appearance fills the page's left half with black.
 */
export function stampedPdf(): Uint8Array {
  let half = `${PATTERN_WIDTH / 2} ${PATTERN_HEIGHT}`;
  return pdfOf([
    CATALOG, ONE_PAGE_TREE,
    textPage(3, "/Contents 4 0 R /Annots [5 0 R]", `${PATTERN_WIDTH} ${PATTERN_HEIGHT}`),
    { id: 4, dict: "", stream: latin1("q Q\n") },
    { id: 5, dict: `<< /Type /Annot /Subtype /Stamp /Rect [0 0 ${half}] /F 4 /AP << /N 6 0 R >> >>` },
    { id: 6, dict: `/Type /XObject /Subtype /Form /BBox [0 0 ${half}]`, stream: latin1(`0 g 0 0 ${half} re f\n`) },
  ]);
}

/**
 * A page of the pattern's size that draws nothing and holds one field of a form, a text field
 * whose appearance fills the page's left half with black.
 */
export function filledFieldPdf(): Uint8Array {
  let half = `${PATTERN_WIDTH / 2} ${PATTERN_HEIGHT}`;
  return pdfOf([
    { id: 1, dict: "<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [5 0 R] >> >>" }, ONE_PAGE_TREE,
    textPage(3, "/Contents 4 0 R /Annots [5 0 R]", `${PATTERN_WIDTH} ${PATTERN_HEIGHT}`),
    { id: 4, dict: "", stream: latin1("q Q\n") },
    {
      id: 5,
      dict: `<< /Type /Annot /Subtype /Widget /FT /Tx /T (entered) /V (9001) /Rect [0 0 ${half}] /F 4 /P 3 0 R ` +
        "/AP << /N 6 0 R >> >>",
    },
    { id: 6, dict: `/Type /XObject /Subtype /Form /BBox [0 0 ${half}]`, stream: latin1(`0 g 0 0 ${half} re f\n`) },
  ]);
}

/** A page of the pattern's size whose content stream is `content`, deflated, and which names no image. */
export function drawnPdf(content: Uint8Array | string): Uint8Array {
  return pdfOf([
    CATALOG, ONE_PAGE_TREE, textPage(3, "/Contents 4 0 R", `${PATTERN_WIDTH} ${PATTERN_HEIGHT}`),
    { id: 4, dict: "", stream: typeof content === "string" ? latin1(content) : content },
  ]);
}

/**
 * A page of the pattern's size that draws a form, which draws the next, `depth` forms deep; the
 * innermost fills the page's left half with black.
 */
export function nestedFill(depth: number): Uint8Array {
  let size = `${PATTERN_WIDTH} ${PATTERN_HEIGHT}`;
  let objects = [
    CATALOG, ONE_PAGE_TREE, textPage(3, "/Resources << /XObject << /F 10 0 R >> >> /Contents 4 0 R", size),
    { id: 4, dict: "", stream: latin1("/F Do\n") },
  ];
  for (let level = 0; level < depth; level++) {
    let innermost = level === depth - 1;
    objects.push({
      id: 10 + level,
      dict: `/Type /XObject /Subtype /Form /BBox [0 0 ${size}]` +
        (innermost ? "" : ` /Resources << /XObject << /F ${11 + level} 0 R >> >>`),
      stream: latin1(innermost ? `0 g 0 0 ${PATTERN_WIDTH / 2} ${PATTERN_HEIGHT} re f\n` : "/F Do\n"),
    });
  }
  return pdfOf(objects);
}

/** A content stream of `bytes` bytes of short strokes, which deflates to a thousandth of that. */
export function strokes(bytes: number): Uint8Array {
  return repeated("0 0 m 1 1 l S\n", bytes);
}

/** A page of the pattern's size that writes a word in Helvetica, which the file names and does not embed. */
export function unembeddedFontPdf(): Uint8Array {
  let font = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  return pdfOf([
    CATALOG, ONE_PAGE_TREE,
    textPage(3, `/Resources << /Font << /F1 ${font} >> >> /Contents 4 0 R`, `${PATTERN_WIDTH} ${PATTERN_HEIGHT}`),
    { id: 4, dict: "", stream: latin1("BT /F1 24 Tf 8 20 Td (Scan) Tj ET\n") },
  ]);
}

/**
 * The fax page's PDF encrypted by the standard security handler as its first revision has it
 * (40-bit RC4), every stream under its object's key: two files, made once and kept as they
 * were written. The first has an empty password for its user and its owner, so it opens for
 * anyone and is encrypted all the same.
 */
const ENCRYPTED_OPEN_BASE64 =
  "JVBERi0xLjcKJeLjz9MKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoK" +
  "PDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2Ug" +
  "L1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA5NiA2NF0gL1Jlc291cmNlcyA8PCAvWE9iamVjdCA8PCAvSW0wIDUgMCBS" +
  "ID4+ID4+IC9Db250ZW50cyA0IDAgUiA+PgplbmRvYmoKNCAwIG9iago8PCAgL0xlbmd0aCAyOCA+PgpzdHJlYW0Kw5ETeiPF" +
  "PdWXCvjta5UAGRM2Pr8Dnt+zplBDzwplbmRzdHJlYW0KZW5kb2JqCjUgMCBvYmoKPDwgL1R5cGUgL1hPYmplY3QgL1N1YnR5" +
  "cGUgL0ltYWdlIC9XaWR0aCA5NiAvSGVpZ2h0IDY0IC9Db2xvclNwYWNlIC9EZXZpY2VHcmF5IC9CaXRzUGVyQ29tcG9uZW50" +
  "IDEgL0ZpbHRlciAvQ0NJVFRGYXhEZWNvZGUgL0RlY29kZVBhcm1zIDw8IC9LIC0xIC9Db2x1bW5zIDk2IC9Sb3dzIDY0ID4+" +
  "IC9MZW5ndGggNzQgPj4Kc3RyZWFtCsPYDGV36/RUv59ywyWWcjngT65yVlccM8wwhaHZebet6LCwVRIYerp+cDjll0uwsFnI" +
  "cB5L/d1g+5/gTTatUCv2vZUguIVZRvA+CmVuZHN0cmVhbQplbmRvYmoKNiAwIG9iago8PCAvRmlsdGVyIC9TdGFuZGFyZCAv" +
  "ViAxIC9SIDIgL08gPDIwNTVjNzU2YzcyZTFhZDcwMjYwOGU4MTk2YWNhZDQ0N2FkMzJkMTdjZmY1ODMyMzVmNmRkMTVmZWQ3" +
  "ZGFiNjc+IC9VIDxmNGM2YTIyMzQ5ZDY2OGRlMjZmNWFiYTI2ODM5YmJjM2ZhNTNlODI5ZGU5YThkYmE4YzI0OGI3MDFiMWZj" +
  "NzIwPiAvUCAtNCA+PgplbmRvYmoKeHJlZgowIDcKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDE1IDAwMDAwIG4gCjAw" +
  "MDAwMDAwNjQgMDAwMDAgbiAKMDAwMDAwMDEyMSAwMDAwMCBuIAowMDAwMDAwMjQ5IDAwMDAwIG4gCjAwMDAwMDAzMjggMDAw" +
  "MDAgbiAKMDAwMDAwMDYxOCAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDcgL1Jvb3QgMSAwIFIgL0VuY3J5cHQgNiAwIFIg" +
  "L0lEIFs8MDJhOTlkMmU5MjIxMjgzYmM2ZWFmZTA1NGQ4YjEzNzI+IDwwMmE5OWQyZTkyMjEyODNiYzZlYWZlMDU0ZDhiMTM3" +
  "Mj5dID4+CnN0YXJ0eHJlZgo4MTMKJSVFT0YK";
/** The second has "a password nobody is asked for" for both, and does not open without it. */
const ENCRYPTED_LOCKED_BASE64 =
  "JVBERi0xLjcKJeLjz9MKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoK" +
  "PDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2Ug" +
  "L1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA5NiA2NF0gL1Jlc291cmNlcyA8PCAvWE9iamVjdCA8PCAvSW0wIDUgMCBS" +
  "ID4+ID4+IC9Db250ZW50cyA0IDAgUiA+PgplbmRvYmoKNCAwIG9iago8PCAgL0xlbmd0aCAyOCA+PgpzdHJlYW0KIZjB0crW" +
  "ZSUnmMrEvqRgR3zyyQBIxrLXT7PBfgplbmRzdHJlYW0KZW5kb2JqCjUgMCBvYmoKPDwgL1R5cGUgL1hPYmplY3QgL1N1YnR5" +
  "cGUgL0ltYWdlIC9XaWR0aCA5NiAvSGVpZ2h0IDY0IC9Db2xvclNwYWNlIC9EZXZpY2VHcmF5IC9CaXRzUGVyQ29tcG9uZW50" +
  "IDEgL0ZpbHRlciAvQ0NJVFRGYXhEZWNvZGUgL0RlY29kZVBhcm1zIDw8IC9LIC0xIC9Db2x1bW5zIDk2IC9Sb3dzIDY0ID4+" +
  "IC9MZW5ndGggNzQgPj4Kc3RyZWFtCoG8A8WClcN0BOaDVo0YUPCmNRq628DQzPhrOlT6QshthDWyiZdcOnLFXGpA7PmCKk/m" +
  "BJaKfgyvZK4k1hQ1mm0ReZhi4C9N0v4JCmVuZHN0cmVhbQplbmRvYmoKNiAwIG9iago8PCAvRmlsdGVyIC9TdGFuZGFyZCAv" +
  "ViAxIC9SIDIgL08gPDYwY2MyZGZkOGYwOTg5YjUxMzc4MDE0NGI4NWYzOWE0NTIwN2ZiZDM3OWJlODFiZjgzYjY0NmI0ODU5" +
  "YjYxYjE+IC9VIDw3ZTY3YTVhN2FhOTAzMDhkNzM5ODUyYWU1YTRlM2FkY2JjODY3YWI2MjFlNWFhMzI5MDZhOTdkMDE4Yjg3" +
  "OTJhPiAvUCAtNCA+PgplbmRvYmoKeHJlZgowIDcKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDE1IDAwMDAwIG4gCjAw" +
  "MDAwMDAwNjQgMDAwMDAgbiAKMDAwMDAwMDEyMSAwMDAwMCBuIAowMDAwMDAwMjQ5IDAwMDAwIG4gCjAwMDAwMDAzMjggMDAw" +
  "MDAgbiAKMDAwMDAwMDYxOCAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDcgL1Jvb3QgMSAwIFIgL0VuY3J5cHQgNiAwIFIg" +
  "L0lEIFs8MDJhOTlkMmU5MjIxMjgzYmM2ZWFmZTA1NGQ4YjEzNzI+IDwwMmE5OWQyZTkyMjEyODNiYzZlYWZlMDU0ZDhiMTM3" +
  "Mj5dID4+CnN0YXJ0eHJlZgo4MTMKJSVFT0YK";

/** The encrypted fax page's PDF: the one that opens without a password, or the `locked` one. */
export function encryptedPdf(locked = false): Uint8Array {
  return decoded(locked ? ENCRYPTED_LOCKED_BASE64 : ENCRYPTED_OPEN_BASE64);
}
