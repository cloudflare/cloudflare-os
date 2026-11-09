import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { MAX_PAGE_IMAGES, PdfImageScan, type PdfImages } from "../src/pdf-images";
import { imagePdf, type PdfImage } from "./pdf-fixture";

/** Bytes standing for an image's data: every byte value, and the keywords a careless scan trips on. */
function data(length: number, seed = 1): Uint8Array {
  let bytes = Uint8Array.from({ length }, (_, i) => (i * 7 + seed * 13) % 256);
  let keywords = new TextEncoder().encode(" 9 0 obj << /Length 3 >> stream\nendobj ");
  if (length >= 100) bytes.set(keywords, 20);
  return bytes;
}

function page(overrides: Partial<PdfImage> = {}): PdfImage {
  return { data: data(900), width: 1275, height: 1650, ...overrides };
}

/** A page stored as deflated samples, 1,000 pixels wide. */
function lossless(extra: string, colorSpace: string, bitsPerComponent = 8): PdfImage {
  return page({ filter: "/FlateDecode", colorSpace, bitsPerComponent, extra, width: 1000 });
}

/** Scans `bytes` fed in chunks of the given sizes, cycling. */
function scan(bytes: Uint8Array, sizes: number[] = [bytes.byteLength]): PdfImages {
  let scanner = new PdfImageScan();
  for (let at = 0, turn = 0; at < bytes.byteLength; turn++) {
    let size = sizes[turn % sizes.length]!;
    scanner.feed(bytes.subarray(at, at + size));
    at += size;
  }
  return scanner.end();
}

function pdf(text: string): Uint8Array {
  return Uint8Array.from(text, ch => ch.charCodeAt(0));
}

const IMAGE = "/Type /XObject /Subtype /Image /Width 600 /Height 800 /BitsPerComponent 8";
/** What ends a revision of a file: an incremental update is written after it. */
const REVISION_END = "xref\n0 1\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n";

/** Object `id` as a page-sized image holding `body`, with `extra` dictionary entries as written. */
function imageObject(id: number, body: string, extra = "/Filter /DCTDecode"): string {
  return `${id} 0 obj\n<< ${IMAGE} ${extra} /Length ${body.length} >>\nstream\n${body}\nendstream\nendobj\n`;
}

/** What each page image found in `bytes` holds, as text, or "damaged". */
function stored(bytes: Uint8Array, sizes?: number[]): string[] {
  return scan(bytes, sizes).images.map(({ offset, length, damaged }) =>
    damaged ? "damaged" : String.fromCharCode(...bytes.slice(offset, offset + length)));
}

/** Every way of feeding `bytes`: whole, in small chunks, and cut once at each place. */
function cuts(bytes: Uint8Array): number[][] {
  return [[bytes.byteLength], [1], [7], [64],
    ...Array.from({ length: bytes.byteLength - 1 }, (_, i) => [i + 1, bytes.byteLength])];
}

/** How long scanning `bytes` in chunks of `size` takes, in milliseconds. */
function scanTime(bytes: Uint8Array, size: number): number {
  let started = performance.now();
  scan(bytes, [size]);
  return performance.now() - started;
}

setFlagsFromString("--expose-gc");
const collectGarbage = runInNewContext("gc") as () => void;

/**
 * How many bytes of heap a scan holds once it has been fed `count` pieces of a file, each made
 * as it is fed so that the file itself is never held, in chunks of `size` bytes.
 */
function heldAfter(count: number, piece: (i: number) => string, size: number): number {
  collectGarbage();
  let before = process.memoryUsage().heapUsed;
  let scanner = new PdfImageScan();
  let chunk = new Uint8Array(size);
  let filled = 0;
  for (let i = 0; i < count; i++) {
    let text = piece(i);
    for (let at = 0; at < text.length; at++) {
      chunk[filled++] = text.charCodeAt(at);
      if (filled === size) {
        scanner.feed(chunk);
        filled = 0;
      }
    }
  }
  scanner.feed(chunk.subarray(0, filled));
  collectGarbage();
  let held = process.memoryUsage().heapUsed - before;
  // The scan is in use up to here, so what it holds is.
  expect(scanner.end().bytes).toBeGreaterThan(0);
  return held;
}

describe("PdfImageScan", () => {
  it("records where each page image sits, however the file is cut into chunks", () => {
    let built = imagePdf([page(), page({ data: data(1300, 2) }), page({ data: data(40, 3) })]);
    for (let sizes of [[built.bytes.byteLength], [1], [2], [3], [7], [64], [5, 1, 300], [1024]]) {
      let found = scan(built.bytes, sizes);
      expect(found.images.map(({ offset, length }) => ({ offset, length }))).toEqual(built.images);
      expect(found).toMatchObject({ encrypted: false, more: false, bytes: built.bytes.byteLength });
      expect(found.images[0]).toEqual({
        ...built.images[0], width: 1275, height: 1650, encoding: "jpeg", damaged: false,
      });
    }
    let [first] = built.images;
    expect(built.bytes.slice(first!.offset, first!.offset + first!.length)).toEqual(data(900));
  });

  it("reads a length kept in an object after the stream, at every chunk size", () => {
    let built = imagePdf([page({ indirectLength: true }), page({ indirectLength: true, data: data(77, 4) })]);
    for (let sizes of [[built.bytes.byteLength], [1], [3], [10], [11], [64]]) {
      let found = scan(built.bytes, sizes);
      expect(found.images.map(({ offset, length, damaged }) => ({ offset, length, damaged })))
        .toEqual(built.images.map(image => ({ ...image, damaged: false })));
    }
  });

  it("leaves unsettled data whose end, as found, is not where a later length object says", () => {
    // Data may hold the word itself: here, where a JPEG keeps a comment.
    let withWord = data(900);
    withWord.set(new TextEncoder().encode("\nendstream\n"), 40);
    let built = imagePdf([page({ indirectLength: true, data: withWord }), page({ indirectLength: true })]);
    for (let sizes of [[built.bytes.byteLength], [1], [7]]) {
      let found = scan(built.bytes, sizes);
      expect(found.images.map(({ offset, damaged }) => ({ offset, damaged }))).toEqual([
        { offset: built.images[0]!.offset, damaged: true },
        { offset: built.images[1]!.offset, damaged: false },
      ]);
    }
    // The same data with its length in the dictionary is read whole.
    let direct = imagePdf([page({ data: withWord })]);
    expect(scan(direct.bytes).images[0]).toMatchObject({ ...direct.images[0], damaged: false });
  });

  it("reads an object defined again, as an incremental update does, once and in its first place", () => {
    let image = imageObject;
    let first = `%PDF-1.4\n${image(5, "first")}${image(9, "another")}`;
    let end = REVISION_END;
    let found = (text: string, sizes?: number[]) => stored(pdf(text), sizes);
    for (let sizes of [undefined, [1], [9]]) {
      expect(found(first + end, sizes)).toEqual(["first", "another"]);
      // Replaced by another image, by an image too small to be a page, and by no image at all.
      expect(found(first + end + image(5, "replacement") + end, sizes)).toEqual(["replacement", "another"]);
      expect(found(first + end + image(5, "small").replace("/Width 600", "/Width 60") + end, sizes))
        .toEqual(["another"]);
      expect(found(`${first}${end}5 0 obj\n<< /Length 4 >>\nstream\ntext\nendstream\nendobj\n${end}`, sizes))
        .toEqual(["another"]);
      expect(found(`${first}${end}5 0 obj\nnull\nendobj\n9 0 obj\n[ 1 2 ]\nendobj\n${end}`, sizes)).toEqual([]);
    }
  });

  it("reads a stream defined again by the length object defined again after it", () => {
    let withLength = (id: number, dict: string, body: string) =>
      `${id} 0 obj\n<< ${dict} /Length ${id + 1} 0 R >>\nstream\n${body}\nendstream\nendobj\n` +
      `${id + 1} 0 obj\n${body.length}\nendobj\n`;
    let image = (body: string) => withLength(5, `${IMAGE} /Filter /DCTDecode`, body);
    // The length the first revision gave is shorter than the data that replaces it, and longer.
    for (let [first, second] of [["first-image", "the-replacement-image"], ["the-first-image-was-long", "tiny"]]) {
      let bytes = pdf(`%PDF-1.4\n${image(first!)}${REVISION_END}${image(second!)}${imageObject(9, "another")}${REVISION_END}`);
      for (let sizes of cuts(bytes)) expect(stored(bytes, sizes)).toEqual([second, "another"]);
    }
    // A stream that is no image is passed by its own length too, and not on into the image after it.
    let content = (body: string) => withLength(3, "", body);
    let bytes = pdf(`%PDF-1.4\n${content("q ".repeat(200))}${REVISION_END}${content("q Q")}${imageObject(9, "another")}`);
    for (let sizes of [undefined, [1], [9]]) expect(stored(bytes, sizes)).toEqual(["another"]);
  });

  it("forgets what an object was noted as once it is defined again as something else", () => {
    let flate = (space: string) => imageObject(5, "rows", `/ColorSpace ${space} /Filter /FlateDecode`);
    let encodings = (text: string) => {
      let bytes = pdf(`%PDF-1.4\n${text}`);
      let whole = scan(bytes);
      for (let sizes of [[1], [9]]) expect(scan(bytes, sizes)).toEqual(whole);
      return whole.images.map(({ encoding, png, damaged }) => damaged ? "damaged" : `${encoding} ${png?.colorType}`);
    };
    let grey = "7 0 obj\n/DeviceGray\nendobj\n";
    expect(encodings(flate("7 0 R") + grey)).toEqual(["lossless 0"]);
    // A colour space defined again as one a PNG cannot hold, as no colour space, and as another.
    for (let again of ["[/Indexed /DeviceRGB 1 <ffffff000000>]", "/DeviceCMYK", "null", "42",
      "<< /Length 1 >>\nstream\nx\nendstream"]) {
      let update = `7 0 obj\n${again}\nendobj\n`;
      expect(encodings(flate("7 0 R") + grey + REVISION_END + update)).toEqual(["other undefined"]);
      expect(encodings(grey + REVISION_END + update + flate("7 0 R"))).toEqual(["other undefined"]);
    }
    expect(encodings(flate("7 0 R") + grey + REVISION_END + "7 0 obj\n/DeviceRGB\nendobj\n")).toEqual(["lossless 2"]);
    // A colour profile defined again as a stream that says nothing of its components.
    let profile = (dict: string) => `8 0 obj\n<< ${dict} /Length 1 >>\nstream\nx\nendstream\nendobj\n`;
    expect(encodings(flate("[/ICCBased 8 0 R]") + profile("/N 3"))).toEqual(["lossless 2"]);
    expect(encodings(flate("[/ICCBased 8 0 R]") + profile("/N 3") + REVISION_END + profile(""))).toEqual(["other undefined"]);
    // A length object defined again as no number: the data's end is found instead.
    let awaiting = `5 0 obj\n<< ${IMAGE} /Filter /DCTDecode /Length 6 0 R >>\nstream\nDATA\nendstream\nendobj\n`;
    expect(encodings(`${awaiting}6 0 obj\n99\nendobj\n`)).toEqual(["damaged"]);
    expect(encodings(`${awaiting}6 0 obj\n99\nendobj\n${REVISION_END}6 0 obj\nnull\nendobj\n`)).toEqual(["jpeg undefined"]);
  });

  it("counts an image defined again once towards the most it keeps", () => {
    let one = (id: number) =>
      `${id} 0 obj\n<< ${IMAGE} /Filter /DCTDecode /Length 1 >>\nstream\nx\nendstream\nendobj\n`;
    let text = "%PDF-1.4\n";
    for (let id = 1; id <= MAX_PAGE_IMAGES; id++) text += one(id);
    for (let id = 1; id <= 50; id++) text += one(id);
    let found = scan(pdf(text));
    expect(found.more).toBe(false);
    expect(found.images).toHaveLength(MAX_PAGE_IMAGES);
    expect(scan(pdf(text + one(MAX_PAGE_IMAGES + 1))).more).toBe(true);
  });

  it("takes the end found over a later length object that falls short of it by more than a line end", () => {
    // A writer that counted a JPEG and then added two bytes to it before "endstream".
    for (let [lineEnd, counted] of [["\n", 6], ["\r\n", 6], ["", 5], ["\n", 2]] as const) {
      let bytes = pdf(`%PDF-1.4\n8 0 obj\n<< ${IMAGE} /Filter /DCTDecode /Length 9 0 R >>\n` +
        `stream\nabcdefXY${lineEnd}endstream\nendobj\n9 0 obj\n${counted}\nendobj\n`);
      for (let sizes of [[bytes.byteLength], [1], [5]]) {
        let [image] = scan(bytes, sizes).images;
        expect(image).toMatchObject({ length: 8, damaged: false });
        expect(String.fromCharCode(...bytes.slice(image!.offset, image!.offset + 8))).toBe("abcdefXY");
      }
    }
  });

  it("reads what an update appends straight after a file's end marker with no line end", () => {
    let first = `%PDF-1.4\n${imageObject(5, "first")}xref\n0 1\ntrailer\n<< /Root 1 0 R >>\n%%EOF`;
    for (let sizes of [undefined, [1], [3], [7], [40]]) {
      // An image added, and the first one defined again.
      expect(stored(pdf(first + imageObject(6, "added") + REVISION_END), sizes)).toEqual(["first", "added"]);
      expect(stored(pdf(first + imageObject(5, "replacement") + REVISION_END), sizes)).toEqual(["replacement"]);
      // A comment that only begins like the marker still hides its line.
      expect(stored(pdf(`${first}\n%%EO ${imageObject(6, "hidden")}${REVISION_END}`), sizes)).toEqual(["first"]);
    }
  });

  it("reads a length kept in an object before the stream", () => {
    let bytes = pdf(`%PDF-1.4\n7 0 obj\n5\nendobj\n8 0 obj\n<< ${IMAGE} /Filter /DCTDecode ` +
      `/ColorSpace /DeviceRGB /Length 7 0 R >>\nstream\nab\ncd\nendstream\nendobj\n`);
    let [image] = scan(bytes).images;
    expect(image).toMatchObject({ length: 5, damaged: false });
    expect(String.fromCharCode(...bytes.slice(image!.offset, image!.offset + 5))).toBe("ab\ncd");
  });

  it("finds the end of data whose length object it never sees, less the line end before it", () => {
    for (let [lineEnd, length] of [["\n", 5], ["\r\n", 5], ["", 5], ["\n\n", 6]] as const) {
      let bytes = pdf(`8 0 obj\n<< ${IMAGE} /Filter /DCTDecode /Length 99 0 R >>\n` +
        `stream\r\nab\ncd${lineEnd}endstream\nendobj\n`);
      for (let sizes of [[bytes.byteLength], [1], [4]]) {
        expect(scan(bytes, sizes).images[0]).toMatchObject({ length, damaged: false });
      }
    }
  });

  it("marks an image whose data is not as long as the file says", () => {
    for (let declaredLength of [899, 902, 5, 100_000]) {
      let built = imagePdf([page({ declaredLength }), page({ data: data(300, 5) })]);
      let found = scan(built.bytes, [50]);
      expect(found.images[0]!.damaged).toBe(true);
      // A length that runs past the next object swallows it; one that falls short does not.
      if (declaredLength < 2000) expect(found.images[1]).toMatchObject({ ...built.images[1], damaged: false });
    }
  });

  it("names each encoding in our own words", () => {
    let encodings = [
      ["/DCTDecode", "jpeg"], ["[/DCTDecode]", "jpeg"], ["[ /DCTDecode ]", "jpeg"],
      ["/CCITTFaxDecode", "fax"], ["/JBIG2Decode", "jbig2"], ["/JPXDecode", "jpeg2000"],
      ["/LZWDecode", "other"], ["[/FlateDecode /DCTDecode]", "other"],
      ["[/ASCII85Decode /DCTDecode]", "other"], ["", "other"], ["12 0 R", "other"],
    ] as const;
    let built = imagePdf(encodings.map(([filter]) => page({ filter })));
    expect(scan(built.bytes, [100]).images.map(image => image.encoding))
      .toEqual(encodings.map(([, encoding]) => encoding));
  });

  it("describes deflated grey and RGB rows as a PNG's", () => {
    let built = imagePdf([
      lossless("", "/DeviceRGB"),
      lossless("", "/DeviceGray", 1),
      lossless("/DecodeParms << /Predictor 15 /Colors 3 /Columns 1000 >>", "/DeviceRGB"),
      lossless("/DecodeParms [ << /Predictor 12 /Columns 1000 /BitsPerComponent 1 >> ]", "[/CalGray << /WhitePoint [1 1 1] >>]", 1),
      // A colour space behind a reference, and a profile that follows the image using it.
      lossless("", "35 0 R"),
      lossless("", "[/ICCBased 36 0 R]", 16),
      lossless("/DecodeParms null", "/DeviceRGB"),
      lossless("/DecodeParms [null]", "/DeviceRGB"),
    ], { objects: ["[/ICCBased 36 0 R]", "<< /N 3 /Alternate /DeviceRGB /Length 2 >>\nstream\nxx\nendstream"] });
    expect(scan(built.bytes, [33]).images.map(({ encoding, png }) => ({ encoding, png }))).toEqual([
      { encoding: "lossless", png: { colorType: 2, bitDepth: 8, rowBytes: 3000, filtered: false } },
      { encoding: "lossless", png: { colorType: 0, bitDepth: 1, rowBytes: 125, filtered: false } },
      { encoding: "lossless", png: { colorType: 2, bitDepth: 8, rowBytes: 3000, filtered: true } },
      { encoding: "lossless", png: { colorType: 0, bitDepth: 1, rowBytes: 125, filtered: true } },
      { encoding: "lossless", png: { colorType: 2, bitDepth: 8, rowBytes: 3000, filtered: false } },
      { encoding: "lossless", png: { colorType: 2, bitDepth: 16, rowBytes: 6000, filtered: false } },
      { encoding: "lossless", png: { colorType: 2, bitDepth: 8, rowBytes: 3000, filtered: false } },
      { encoding: "lossless", png: { colorType: 2, bitDepth: 8, rowBytes: 3000, filtered: false } },
    ]);
  });

  it("rounds a row of samples smaller than a byte up to whole bytes", () => {
    let built = imagePdf([
      page({ filter: "/FlateDecode", colorSpace: "/DeviceGray", bitsPerComponent: 1, width: 2550 }),
      page({ filter: "/FlateDecode", colorSpace: "/DeviceGray", bitsPerComponent: 2, width: 301 }),
      page({ filter: "/FlateDecode", colorSpace: "/DeviceGray", bitsPerComponent: 4, width: 301 }),
    ]);
    expect(scan(built.bytes).images.map(image => image.png!.rowBytes)).toEqual([319, 76, 151]);
  });

  it("follows a colour space kept as a name in an object of its own", () => {
    // Object 15 follows the three pages, as the first of `objects`.
    let built = imagePdf([lossless("", "15 0 R"), lossless("", "16 0 R", 1), lossless("", "17 0 R")],
      { objects: ["/DeviceRGB", "/DeviceGray", "/DeviceCMYK"] });
    expect(scan(built.bytes, [50]).images.map(({ encoding, png }) => ({ encoding, colorType: png?.colorType })))
      .toEqual([{ encoding: "lossless", colorType: 2 }, { encoding: "lossless", colorType: 0 },
        { encoding: "other", colorType: undefined }]);
  });

  it("leaves unread the deflated images a PNG cannot hold", () => {
    let built = imagePdf([
      lossless("", "/DeviceCMYK"),
      lossless("", "[/Indexed /DeviceRGB 255 <00ff00>]"),
      lossless("", "/DeviceRGB", 4),
      lossless("", "30 0 R"),
      lossless("/DecodeParms << /Predictor 2 /Colors 3 /Columns 1000 >>", "/DeviceRGB"),
      lossless("/DecodeParms << /Predictor 15 /Colors 3 /Columns 999 >>", "/DeviceRGB"),
      lossless("/DecodeParms << /Predictor 15 /Columns 1000 >>", "/DeviceRGB"),
      // Parameters that are not here to be read may name a predictor.
      lossless("/DecodeParms 30 0 R", "/DeviceRGB"),
      lossless("/DecodeParms [30 0 R]", "/DeviceRGB"),
      lossless("/DecodeParms 15", "/DeviceRGB"),
    ]);
    expect(scan(built.bytes).images.map(image => image.encoding)).toEqual(Array(10).fill("other"));
  });

  it("passes over masks, the images used as masks, and images too small to be a page", () => {
    let built = imagePdf([
      page({ extra: "/SMask 7 0 R" }),
      page({ colorSpace: "/DeviceGray" }),   // Object 9: the first page's soft mask.
      page({ extra: "/ImageMask true" }),
      page({ width: 199 }),
      page({ height: 120, width: 120 }),
      page({ width: 200, height: 200 }),
    ]);
    // Page i's image is object 5 + 4i, so the mask is named by the number of the second.
    let bytes = pdf(String.fromCharCode(...built.bytes).replace("/SMask 7 0 R", "/SMask 9 0 R"));
    expect(scan(bytes).images.map(image => image.width)).toEqual([1275, 200]);
  });

  it("counts no mask towards the most page images it keeps, wherever the file holds it", () => {
    let masked = (count: number, maskFirst: boolean) => {
      let text = "%PDF-1.4\n";
      for (let i = 0; i < count; i++) {
        let image = `${2 * i + 1} 0 obj\n<< ${IMAGE} /Filter /DCTDecode /SMask ${2 * i + 2} 0 R /Length 1 >>\n` +
          "stream\nx\nendstream\nendobj\n";
        let mask = `${2 * i + 2} 0 obj\n<< ${IMAGE} /ColorSpace /DeviceGray /Filter /FlateDecode /Length 1 >>\n` +
          "stream\ny\nendstream\nendobj\n";
        text += maskFirst ? mask + image : image + mask;
      }
      let { images, more } = scan(pdf(text), [65_536]);
      return { images: images.length, jpeg: images.every(image => image.encoding === "jpeg"), more };
    };
    for (let maskFirst of [false, true]) {
      expect(masked(1001, maskFirst)).toEqual({ images: 1001, jpeg: true, more: false });
      expect(masked(MAX_PAGE_IMAGES, maskFirst)).toEqual({ images: MAX_PAGE_IMAGES, jpeg: true, more: false });
      expect(masked(MAX_PAGE_IMAGES + 1, maskFirst)).toEqual({ images: MAX_PAGE_IMAGES, jpeg: true, more: true });
    }
  });

  it("has room for both masks of every page image while they are yet to be named", () => {
    let mask = (id: number) =>
      `${id} 0 obj\n<< ${IMAGE} /ColorSpace /DeviceGray /Filter /FlateDecode /Length 1 >>\nstream\ny\nendstream\nendobj\n`;
    let image = (i: number) => `${3 * i + 1} 0 obj\n<< ${IMAGE} /Filter /DCTDecode /SMask ${3 * i + 2} 0 R ` +
      `/Mask ${3 * i + 3} 0 R /Length 1 >>\nstream\nx\nendstream\nendobj\n`;
    let pages = Array.from({ length: MAX_PAGE_IMAGES }, (_, i) => i);
    for (let text of [
      // Each image's masks just before it, and every mask before any image.
      pages.map(i => mask(3 * i + 2) + mask(3 * i + 3) + image(i)).join(""),
      pages.map(i => mask(3 * i + 2) + mask(3 * i + 3)).join("") + pages.map(image).join(""),
    ]) {
      let found = scan(pdf(`%PDF-1.4\n${text}`), [65_536]);
      expect(found.images.map(({ encoding }) => encoding)).toEqual(Array(MAX_PAGE_IMAGES).fill("jpeg"));
      expect(found.more).toBe(false);
    }
  });

  it("notes a mask as large as a page that is stored as fax or JBIG2, wherever the file holds it", () => {
    let layer = (id: number, extra: string) =>
      `${id} 0 obj\n<< ${IMAGE} ${extra} /Length 1 >>\nstream\nx\nendstream\nendobj\n`;
    let found = (...objects: string[]) => {
      let bytes = pdf(`%PDF-1.4\n${objects.join("")}`);
      let whole = scan(bytes);
      for (let sizes of [[1], [7]]) expect(scan(bytes, sizes)).toEqual(whole);
      return { images: whole.images.map(({ encoding }) => encoding), maskEncoding: whole.maskEncoding };
    };
    let background = layer(5, "/Filter /DCTDecode");
    let foreground = layer(6, "/Filter /DCTDecode /SMask 7 0 R");
    // A layered scan, whose text is the mask over its colour layers.
    let text = layer(7, "/ColorSpace /DeviceGray /Filter /JBIG2Decode");
    expect(found(background, foreground, text)).toEqual({ images: ["jpeg", "jpeg"], maskEncoding: "jbig2" });
    expect(found(text, background, foreground)).toEqual({ images: ["jpeg", "jpeg"], maskEncoding: "jbig2" });
    expect(found(background, layer(6, "/Filter /DCTDecode /Mask 7 0 R"), text))
      .toEqual({ images: ["jpeg", "jpeg"], maskEncoding: "jbig2" });
    // A stencil, over a background and as the whole of a black-and-white page.
    let stencil = layer(7, "/ImageMask true /Filter /CCITTFaxDecode /DecodeParms << /K -1 /Columns 600 >>");
    expect(found(background, stencil)).toEqual({ images: ["jpeg"], maskEncoding: "fax" });
    expect(found(stencil)).toEqual({ images: [], maskEncoding: "fax" });
    // A mask stored another way, or too small to be a page's, is passed over and nothing more.
    let plain = { images: ["jpeg", "jpeg"], maskEncoding: undefined };
    expect(found(background, foreground, layer(7, "/ColorSpace /DeviceGray /Filter /FlateDecode"))).toEqual(plain);
    expect(found(layer(7, "/ColorSpace /DeviceGray /Filter /JPXDecode"), background, foreground)).toEqual(plain);
    expect(found(background, layer(6, "/Filter /DCTDecode"), layer(7, "/ImageMask true /Filter /FlateDecode")))
      .toEqual(plain);
    expect(found(background, foreground, text.replace("/Width 600", "/Width 60"))).toEqual(plain);
  });

  it("forgets how a mask was stored once its object is defined again", () => {
    let found = (...objects: string[]) => {
      let bytes = pdf(`%PDF-1.4\n${objects.join("")}`);
      let whole = scan(bytes);
      for (let sizes of [[1], [7]]) expect(scan(bytes, sizes)).toEqual(whole);
      return { images: whole.images.map(({ encoding }) => encoding), maskEncoding: whole.maskEncoding };
    };
    let stencil = (id: number, filter: string) => imageObject(id, "x", `/ImageMask true /Filter ${filter}`);
    let fax = stencil(5, "/CCITTFaxDecode");
    expect(found(fax)).toEqual({ images: [], maskEncoding: "fax" });
    // Defined again as a page, and as nothing.
    expect(found(fax, REVISION_END, imageObject(5, "x"))).toEqual({ images: ["jpeg"], maskEncoding: undefined });
    expect(found(fax, imageObject(9, "x"), REVISION_END, "5 0 obj\nnull\nendobj\n"))
      .toEqual({ images: ["jpeg"], maskEncoding: undefined });
    // Another such mask that the file still has is still noted.
    expect(found(fax, stencil(7, "/JBIG2Decode"), REVISION_END, imageObject(5, "x")))
      .toEqual({ images: ["jpeg"], maskEncoding: "jbig2" });
    // A layered scan's mask defined again in an encoding that needs no noting, and in one that does.
    let layers = imageObject(5, "x") + imageObject(6, "x", "/Filter /DCTDecode /SMask 7 0 R");
    let mask = (filter: string) => imageObject(7, "x", `/ColorSpace /DeviceGray /Filter ${filter}`);
    for (let objects of [[layers, mask("/JBIG2Decode")], [mask("/JBIG2Decode"), layers]]) {
      expect(found(...objects)).toEqual({ images: ["jpeg", "jpeg"], maskEncoding: "jbig2" });
      expect(found(...objects, REVISION_END, mask("/FlateDecode")))
        .toEqual({ images: ["jpeg", "jpeg"], maskEncoding: undefined });
      expect(found(...objects, REVISION_END, mask("/CCITTFaxDecode")))
        .toEqual({ images: ["jpeg", "jpeg"], maskEncoding: "fax" });
    }
  });

  it("reads past blanks left between the stream keyword and the line end before its data", () => {
    let image = (id: number, start: string, body: string) =>
      `${id} 0 obj\n<< ${IMAGE} /Filter /DCTDecode /Length ${body.length} >>\nstream${start}${body}\nendstream\nendobj\n`;
    for (let start of [" \n", " \r\n", "\t\n", "  \r\n", "\0\f      \r", "\r", "\n", "\r\n"]) {
      // Data with a parenthesis left open, which read as an object's text hides all that follows it.
      let bytes = pdf(`%PDF-1.4\n${image(5, start, "first (page")}${image(6, "\n", "second")}`);
      for (let sizes of cuts(bytes)) expect(stored(bytes, sizes)).toEqual(["first (page", "second"]);
    }
    // Data that itself begins with blanks and a line end, after a line end, keeps them.
    let bytes = pdf(`%PDF-1.4\n${image(5, "\n", "  \nrows")}`);
    for (let sizes of cuts(bytes)) expect(stored(bytes, sizes)).toEqual(["  \nrows"]);
  });

  it("takes an object's header inside a comment for none, however long the comment", () => {
    let built = imagePdf([page(), page({ data: data(300, 2) })]);
    let text = String.fromCharCode(...built.bytes);
    let hidden = `99 0 obj << ${IMAGE} /Filter /DCTDecode /Length 6 >> stream`;
    for (let comment of [
      // What reads as an image whose data is the comments that follow, and as an object left open.
      `% ${hidden}\n%ABC\n%endstream\n%endobj\n`, `%${"-".repeat(100)} ${hidden}\r%ABC\r%endstream\r%endobj\r`,
      "% see 12 0 obj\n", "%% Original object ID: 12 0\n", `%${"-".repeat(100)}12 0 obj\r\n`,
    ]) {
      // Before the file's own first line, and between two of its objects.
      for (let bytes of [pdf(comment + text), pdf(text.replace("endobj\n", `endobj\n${comment}`))]) {
        let places = built.images.map(({ offset, length }) => ({ offset: offset + comment.length, length }));
        for (let sizes of [[bytes.byteLength], [1], [7], [16], [64], [4096]]) {
          expect(scan(bytes, sizes).images.map(({ offset, length }) => ({ offset, length }))).toEqual(places);
        }
      }
    }
    // An object that follows a comment on a line of its own is read.
    let bytes = pdf(`%PDF-1.4\n% a note\n${imageObject(5, "DATA")}%%EOF\n${imageObject(6, "MORE")}`);
    for (let sizes of cuts(bytes)) expect(stored(bytes, sizes)).toEqual(["DATA", "MORE"]);
  });

  it("reads a name whose characters are spelled as their hex codes", () => {
    let found = (dict: string) => {
      let bytes = pdf(`%PDF-1.4\n5 0 obj\n<< ${dict} >>\nstream\nDATA\nendstream\nendobj\n`);
      let whole = scan(bytes);
      expect(scan(bytes, [1])).toEqual(whole);
      return whole;
    };
    let size = "/Height 800 /BitsPerComponent 8";
    expect(found(`/Sub#74ype /Im#61ge /Wid#74h 600 ${size} /Filter /DCT#44ecode /Len#67th 4`).images)
      .toMatchObject([{ length: 4, encoding: "jpeg", damaged: false }]);
    expect(found(`/Subtype /Image /Width 600 ${size} /Filter /#46lateDecode /ColorSpace /Device#47ray /Length 4`).images)
      .toMatchObject([{ encoding: "lossless", png: { colorType: 0 } }]);
    // A stencil and an encryption are known for what they are however they are spelled.
    expect(found(`/Subtype /Image /Width 600 ${size} /Image#4dask true /Filter /CCITTFaxDecode /Length 4`))
      .toMatchObject({ images: [], maskEncoding: "fax" });
    expect(found("/Type /XRef /Enc#72ypt 4 0 R /Length 4").encrypted).toBe(true);
    // A "#" that two hex digits do not follow is itself.
    expect(found(`/Subtype /Image /Width 600 ${size} /Filter /DCT#4 /Length 4`).images)
      .toMatchObject([{ encoding: "other" }]);
  });

  it("is not misled by keywords inside strings, comments and nested dictionaries", () => {
    let bytes = pdf(`1 0 obj\n<< /Title (a stream\n 2 0 obj endobj \\) endstream) /K <</A [1 2 (x)]>> >>\nendobj\n` +
      `2 0 obj\n% endobj stream\n<< ${IMAGE} /Filter /DCTDecode /Length 4 /Note (stream\n) >>\r\nstream\r\nDATA\r\nendstream endobj\n`);
    for (let sizes of [[bytes.byteLength], [1], [9]]) {
      expect(scan(bytes, sizes).images).toMatchObject([{ length: 4, encoding: "jpeg", damaged: false }]);
    }
  });

  it("takes a keyword inside a string for no object's end, however long the object", () => {
    // A string longer than any object that is read, holding what reads as an image.
    let hidden = ` 9 0 obj << ${IMAGE} /Filter /DCTDecode /Length 4 >> stream\nDATA\nendstream\nendobj\n`;
    let built = imagePdf([page()]);
    for (let title of [`${"a".repeat(70_000)}${hidden}`, `${hidden}${"a".repeat(70_000)}`, hidden]) {
      let bytes = pdf(`1 0 obj\n<< /Title (${title}) >>\nendobj\n` + String.fromCharCode(...built.bytes));
      for (let sizes of [[bytes.byteLength], [1], [4096], [16_384], [65_536]]) {
        let offset = built.images[0]!.offset + bytes.byteLength - built.bytes.byteLength;
        expect(scan(bytes, sizes).images).toMatchObject([{ offset, length: 900, damaged: false }]);
      }
    }
  });

  it("reads each object once, whatever keywords it holds", () => {
    let image = `<< ${IMAGE} /Filter /DCTDecode /Length 4 >>\nstream\nDATA\nendstream\nendobj\n`;
    let hostile = [
      // Headers of objects that never end, each inside the last.
      "1 0 obj(endobj ".repeat(8000),
      "1 0 obj ".repeat(100_000),
      // Objects that are no value, each with thousands of keywords that might have ended one.
      `1 0 obj(${"endobj ".repeat(9400)}) `.repeat(8),
      `1 0 obj\n[ ${"1 ".repeat(16_000)}${"endobj ".repeat(4600)}`.repeat(4),
      `1 0 obj ${"stream\n".repeat(9000)}`.repeat(4),
    ];
    for (let text of hostile) {
      let bytes = pdf(`%PDF-1.7\n${text}\n7 0 obj\n${image}`);
      for (let size of [4096, 65_536, bytes.byteLength]) expect(scanTime(bytes, size)).toBeLessThan(1000);
    }
    // A dictionary that is one, for all the keywords in its string, is still read.
    let noted = pdf(`2 0 obj\n<< ${IMAGE} /Filter /DCTDecode /Length 4 /Note (${"stream\n".repeat(8000)}) >>\n` +
      "stream\nDATA\nendstream\nendobj\n");
    expect(scanTime(noted, 4096)).toBeLessThan(1000);
    expect(scan(noted, [4096]).images).toMatchObject([{ length: 4, encoding: "jpeg", damaged: false }]);
  });

  it("holds a few numbers of each object, however large the object or the file", () => {
    let nested = "<<>>".repeat(15_000);
    let megabyte = 1024 * 1024;
    // Images whose dictionaries, and arrays whose items, are as large as an object may be.
    expect(heldAfter(40, i => `${i + 1} 0 obj<</Subtype/Image/Width 200/Height 200/Length 0/X[${nested}]>>` +
      "stream\n\nendstream endobj\n", 4096)).toBeLessThan(8 * megabyte);
    expect(heldAfter(40, i => `${i + 1} 0 obj[[${nested}]]endobj\n`, 4096)).toBeLessThan(8 * megabyte);
    // Images that each name a mask of their own.
    expect(heldAfter(400_000, i => `1 0 obj<</Subtype/Image/Mask ${3_000_000_000 + i} 0 R>>stream\nendstream\n`,
      65_536)).toBeLessThan(8 * megabyte);
    // Page images whose dictionaries hold a long name, each in a chunk of its own.
    let pixels = "x".repeat(30_000);
    expect(heldAfter(2000, i => `${i + 1} 0 obj\n<< ${IMAGE} /Filter /DCTDecode /Length 30000 >>\n` +
      `stream\n${pixels}\nendstream\nendobj\n`, 65_536)).toBeLessThan(8 * megabyte);
    expect(heldAfter(2000, i => `${i + 1} 0 obj[/${"A".repeat(24)}]endobj\n${" ".repeat(16_000)}`, 16_384))
      .toBeLessThan(8 * megabyte);
  });

  it("finds an object's header the same however the file is cut, up to eight spaces between its parts", () => {
    let image = `<< ${IMAGE} /Filter /DCTDecode /Length 4 >>\nstream\nDATA\nendstream\nendobj\n`;
    for (let [gap, found] of [[1, 1], [8, 1], [9, 0], [36, 0], [70, 0]] as const) {
      for (let header of [`1${" ".repeat(gap)}0 obj`, `1 0${" ".repeat(gap)}obj`, `1234567890${"\n".repeat(gap)}12345 obj`]) {
        let bytes = pdf(`%PDF-1.7\n${header}\n${image}`);
        for (let size of [bytes.byteLength, 1, 16, 64]) expect(scan(bytes, [size]).images).toHaveLength(found);
        // Cut once, at every place.
        for (let cut = 1; cut < 9 + header.length + 2; cut++) {
          expect(scan(bytes, [cut, bytes.byteLength]).images).toHaveLength(found);
        }
      }
    }
  });

  it("recovers after an object too large to be read", () => {
    let filler = `1 0 obj\n[ ${"1234567 ".repeat(20_000)}]\nendobj\n`;
    let built = imagePdf([page()]);
    let bytes = pdf(filler + String.fromCharCode(...built.bytes));
    expect(scan(bytes, [4096]).images).toMatchObject([{ offset: built.images[0]!.offset + filler.length, length: 900 }]);
  });

  it("notes an encrypted file, from a trailer or a cross-reference stream", () => {
    expect(scan(imagePdf([page()], { trailer: "/Encrypt 99 0 R" }).bytes, [13]).encrypted).toBe(true);
    let bytes = pdf("5 0 obj\n<< /Type /XRef /Size 6 /Encrypt 4 0 R /Length 3 >>\nstream\nabc\nendstream\nendobj\n");
    expect(scan(bytes, [5]).encrypted).toBe(true);
    // Spelled with a hex code, and after a string whose "%" reads as a comment's start.
    for (let trailer of ["/Enc#72ypt 99 0 R", "/ID [(a%b) (c)] /Encrypt 99 0 R", "/ID [(a%b) (c)] /#45ncrypt 99 0 R"]) {
      let built = imagePdf([page()], { trailer });
      for (let sizes of [[built.bytes.byteLength], [1], [13]]) expect(scan(built.bytes, sizes).encrypted).toBe(true);
    }
    // The word in an object of its own, or in stream data, says nothing.
    let plain = pdf("5 0 obj\n<< /Length 9 >>\nstream\n/Encrypt \nendstream\nendobj\n6 0 obj\n(/Encrypt)\nendobj\n");
    expect(scan(plain, [5]).encrypted).toBe(false);
  });

  it("keeps a bounded number of page images and says when there were more", () => {
    let one = `<< ${IMAGE} /Filter /DCTDecode /Length 1 >>\nstream\nx\nendstream\nendobj\n`;
    let text = "";
    for (let i = 1; i <= MAX_PAGE_IMAGES + 3; i++) text += `${i} 0 obj\n${one}`;
    let found = scan(pdf(text), [65_536]);
    expect(found.images).toHaveLength(MAX_PAGE_IMAGES);
    expect(found.more).toBe(true);
  });

  it("finds nothing in a file with no images, or one that is not a PDF", () => {
    expect(scan(pdf("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF")))
      .toEqual({ images: [], more: false, encrypted: false, bytes: 76 });
    expect(scan(data(5000), [17]).images).toEqual([]);
    expect(scan(new Uint8Array(0))).toEqual({ images: [], more: false, encrypted: false, bytes: 0 });
  });
});
