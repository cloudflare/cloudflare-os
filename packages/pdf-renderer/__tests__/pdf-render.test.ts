/// <reference types="node" />

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  HOLD_IDLE_MS, RENDER_LIMITS, type RenderedPage, type RenderLimits, type RenderOptions, type RenderRefusalReason,
} from "../src/api";
import { cutDense, cutRows, partsColumns, pdfRenderer, RenderRefusal, type RenderHold } from "../src/renderer";
import { instantiatePdfium, PdfiumAbort, type PdfiumExports, type PdfiumInstance } from "../src/pdfium-loader";
import type { PdfiumModules } from "../src/pdfium-module";
import {
  arithmeticJbig2Image, bitsImage, blendedFills, decoded, drawnPdf, DRAWN_WHOLE, encryptedPdf, FAX_BASE64, faxImage, faxPdf, filledFieldPdf,
  formDrawnAgain,
  greyImage, jbig2Pdf, jpxPdf, nestedFill, nestedForms, onePage, PATTERN_HEIGHT, PATTERN_MARKS, PATTERN_SHADED,
  PATTERN_WIDTH, radialShadings, scannedPdf, sharedContentPages, SQUARE_JPX_BASE64, SQUARE_SIDE, stampedPdf, strokes,
  turnedClockwise, unembeddedFontPdf, type ScanImage,
} from "./pdf-render-fixture";

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIB = 1024 * 1024;

/** A file of the package, compiled. The Worker's types give a module no constructor, since workerd compiles none from bytes. */
function compiled(path: string): WebAssembly.Module {
  return Reflect.construct(WebAssembly.Module, [readFileSync(join(PACKAGE_DIR, path))]) as WebAssembly.Module;
}

/** The modules the Worker imports, compiled once from the same files. */
const MODULES: PdfiumModules = {
  pdfium: compiled("vendor/pdfium/pdfium-metered.wasm"),
  thunks: compiled("src/pdfium-thunks.wasm"),
};

/** The product's limits at the resolution at which a page of the pattern's size is its image. */
const AT_72: RenderLimits = { ...RENDER_LIMITS, dpi: 72 };
/** The memory an instance of the build starts with. */
const START_BYTES = 18_939_904;
/** What a hold is charged for a file of `fileBytes` under the product's limits. */
function charge(fileBytes: number): number {
  return 16_000 + fileBytes + RENDER_LIMITS.pagePixels;
}

/** `instance` with some of its exports replaced, and its other members kept: the renderer needs them. */
function replacing(instance: PdfiumInstance, exports: Record<string, (...args: number[]) => number>): PdfiumInstance {
  return { ...instance, exports: Object.assign(Object.create(null), instance.exports, exports) as PdfiumExports };
}

/**
 * What an instance is between calls: its memory up to the last byte that is not zero, and its
 * table's length; and the file-system calls it has made, none unless given.
 */
type Resting = { image: Uint8Array; tableLength: number; fileCalls?: number };

/** What `instance` is at the moment it is asked, for it to be held to later. */
function resting(instance: PdfiumInstance): Resting {
  let memory = new Uint8Array(instance.exports.memory.buffer);
  let last = memory.length;
  while (last > 0 && memory[last - 1] === 0) last--;
  return { image: memory.slice(0, last), tableLength: instance.exports.__indirect_function_table.length };
}

/**
 * Holds `instance` to `rest`: its memory that copy and zero past it, its function table as long,
 * and no file-system call made but those `rest` counts.
 */
function expectResting(instance: PdfiumInstance, rest: Resting): void {
  let memory = new Uint8Array(instance.exports.memory.buffer);
  expect(Buffer.compare(memory.subarray(0, rest.image.length), rest.image)).toBe(0);
  expect(zeroFrom(memory, rest.image.length)).toBe(true);
  expect(instance.exports.__indirect_function_table.length).toBe(rest.tableLength);
  expect(instance.host.fileCalls).toBe(rest.fileCalls ?? 0);
}

/** Whether `memory` is zero from `from` on. Its length is a whole number of words. */
function zeroFrom(memory: Uint8Array, from: number): boolean {
  let at = from;
  for (; at % 4 !== 0; at++) if (memory[at] !== 0) return false;
  let words = new Uint32Array(memory.buffer, at);
  for (let i = 0; i < words.length; i++) if (words[i] !== 0) return false;
  return true;
}

/** How many pixels of `got` are not what `want` has there; every one, when they are not of one size. */
function differing(got: Uint8Array, want: Uint8Array): number {
  if (got.length !== want.length) return Math.max(got.length, want.length);
  let count = 0;
  for (let i = 0; i < want.length; i++) if (got[i] !== want[i]) count++;
  return count;
}

/** How many of `pixels` are darker than `under`. */
function darker(pixels: Uint8Array, under: number): number {
  let count = 0;
  for (let value of pixels) if (value < under) count++;
  return count;
}

/** The refusal `run` throws. */
function refusal(run: () => unknown): RenderRefusal {
  try {
    run();
  } catch (error) {
    if (error instanceof RenderRefusal) return error;
    throw error;
  }
  throw new Error("nothing was refused");
}

/** A hold on `renderer` for `pdf`, with `pdf` in it. */
function holding(renderer: ReturnType<typeof pdfRenderer>, pdf: Uint8Array): RenderHold {
  let hold = renderer.hold(pdf.byteLength);
  hold.fill(pdf, 0);
  return hold;
}

/** How most tests have a page cut: in two, where it has the rows for it. */
const IN_TWO: RenderOptions = { bands: 2 };

/**
 * A rendered page as most tests look at it: every row of it in `pixels`, white where a band has
 * no pixels of its own, with the rows it was cut at in `bands`, beginning with 0 and ending with
 * its height, and whether each band has pixels in `inked`.
 */
type Drawn = Omit<RenderedPage, "bands"> & { pixels: Uint8Array; bands: number[]; inked: boolean[] };

/** `page` put together again from its bands, which are held to being every row of it, once, in order. */
function drawn(page: RenderedPage): Drawn {
  let pixels = new Uint8Array(page.width * page.height).fill(255);
  let next = 0;
  for (let band of page.bands) {
    expect(band.top).toBe(next);
    expect(band.rows).toBeGreaterThan(0);
    if (band.pixels) {
      expect(band.pixels).toHaveLength(band.rows * page.width);
      pixels.set(band.pixels, band.top * page.width);
    }
    next += band.rows;
  }
  expect(next).toBe(page.height);
  return {
    ...page, pixels, bands: [...page.bands.map(band => band.top), page.height],
    inked: page.bands.map(band => band.pixels !== undefined),
  };
}

/**
 * A renderer whose instances are kept to be looked at, asked as most tests ask one: a hold taken
 * for one call, the file copied into it, and the hold released. `wrap` stands in for the
 * instance, and `now` for the clock.
 */
function watched(
  limits: RenderLimits = AT_72,
  options: { wrap?: (instance: PdfiumInstance) => PdfiumInstance; now?: () => number } = {},
) {
  let instances: PdfiumInstance[] = [];
  let renderer = pdfRenderer(MODULES, limits, (module, maxBytes) => {
    let instance = instantiatePdfium(module, maxBytes);
    instances.push(instance);
    return options.wrap?.(instance) ?? instance;
  }, options.now);
  let held = <T>(pdf: Uint8Array, use: (hold: RenderHold) => T): T => {
    let hold = holding(renderer, pdf);
    try {
      return use(hold);
    } finally {
      hold.release();
    }
  };
  return {
    renderer, instances,
    countPages: (pdf: Uint8Array): number => held(pdf, hold => hold.countPages()),
    renderPage: (pdf: Uint8Array, index = 0, cut = IN_TWO): Drawn =>
      held(pdf, hold => drawn(hold.renderPage(index, cut))),
    /** The page as the renderer gives it. */
    rendered: (pdf: Uint8Array, cut = IN_TWO): RenderedPage => held(pdf, hold => hold.renderPage(0, cut)),
    memory: (): Uint8Array => new Uint8Array(instances[0]!.exports.memory.buffer),
    /**
     * Holds the renderer to having made one instance, and that instance to what one is after the
     * first call made of it: see {@link atRest}.
     */
    expectRestored(): void {
      expect(instances).toHaveLength(1);
      expectResting(instances[0]!, atRest());
    },
  };
}

let rest: Resting | undefined;
/**
 * What an instance is after the first call made of it, taken from a renderer of its own that has
 * made one call. An instance is made ready the same way every time, so this is what every
 * renderer's instance has to be after any call, whatever was rendered with it before.
 */
function atRest(): Resting {
  if (!rest) {
    let own = watched();
    own.countPages(faxPdf());
    rest = resting(own.instances[0]!);
  }
  return rest;
}

/** One renderer for the tests that need nothing of their own: what one leaves, the next would find. */
const shared = watched();

/** The 48 x 32 pixels of the shaded pattern whose corner is at `left`, `top`, as an image of their own. */
function tile(left: number, top: number): ScanImage {
  let samples = new Uint8Array(48 * 32);
  for (let y = 0; y < 32; y++) {
    let from = (top + y) * PATTERN_WIDTH + left;
    samples.set(PATTERN_SHADED.subarray(from, from + 48), y * 48);
  }
  return greyImage(samples, 48, 32);
}

/** The pattern drawn in four tiles of 48 x 32, each an image of its own. */
function tilesPdf(): Uint8Array {
  let corners = [[0, 0], [48, 0], [0, 32], [48, 32]] as const;
  return scannedPdf([{
    images: corners.map(([left, top]) => tile(left, top)),
    content: corners.map(([left, top], n) => `q 48 0 0 32 ${left} ${PATTERN_HEIGHT - 32 - top} cm /Im${n} Do Q`)
      .join(" "),
  }]);
}

/** 6,000 fills of one point, then one of the page's right half: more objects than are looked at before painting. */
function manyFillsPdf(): Uint8Array {
  return drawnPdf(`0 g ${"0 0 1 1 re f ".repeat(6000)}48 0 48 64 re f\n`);
}

/** A page of the pattern's size that shows one deflated grey image of `side` x `side` zeros. */
function blackSquarePdf(side: number): Uint8Array {
  return scannedPdf([onePage(greyImage(new Uint8Array(side * side), side, side))]);
}

/** A page of the pattern's size that is white but for rows `from` up to `to`, which are black. */
function barPdf(from: number, to: number): Uint8Array {
  let samples = new Uint8Array(PATTERN_WIDTH * PATTERN_HEIGHT).fill(255);
  samples.fill(0, from * PATTERN_WIDTH, to * PATTERN_WIDTH);
  return scannedPdf([onePage(greyImage(samples, PATTERN_WIDTH, PATTERN_HEIGHT))]);
}

/**
 * A page of the pattern's size with lines of writing on it: ten rows with a tenth of their
 * pixels at `ink`, side by side in the middle of the row, then two rows with nothing on them,
 * from the top down, so rows 34 and 35 are the one pair of rows within reach of the page's
 * middle that no line crosses. Everything else is at `ground`, which is given the row.
 */
function writtenPdf(ground: (row: number) => number, ink: number): Uint8Array {
  let samples = new Uint8Array(PATTERN_WIDTH * PATTERN_HEIGHT);
  for (let row = 0; row < PATTERN_HEIGHT; row++) {
    for (let x = 0; x < PATTERN_WIDTH; x++) {
      samples[row * PATTERN_WIDTH + x] = row % 12 < 10 && x >= 43 && x < 53 ? ink : ground(row);
    }
  }
  return scannedPdf([onePage(greyImage(samples, PATTERN_WIDTH, PATTERN_HEIGHT))]);
}

/**
 * A page of the pattern's size with lines of writing in each of `columns`, which are pixels
 * from and up to: four black rows, then two with nothing on them, from the top down. Cut in
 * two, its cut falls at row 29: rows 28 and 29, and 34 and 35, are the pairs within reach of
 * the page's middle that no line crosses, and the first found of two as near is kept.
 */
function columnsPdf(columns: [from: number, to: number][]): Uint8Array {
  let samples = new Uint8Array(PATTERN_WIDTH * PATTERN_HEIGHT).fill(255);
  for (let row = 0; row < PATTERN_HEIGHT; row++) {
    if (row % 6 < 4) for (let [from, to] of columns) samples.fill(0, row * PATTERN_WIDTH + from, row * PATTERN_WIDTH + to);
  }
  return scannedPdf([onePage(greyImage(samples, PATTERN_WIDTH, PATTERN_HEIGHT))]);
}

/** The 2048 x 2048 JPEG 2000 square. */
function squareImage(): ScanImage {
  return {
    dict: `/Width ${SQUARE_SIDE} /Height ${SQUARE_SIDE} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /JPXDecode`,
    data: decoded(SQUARE_JPX_BASE64),
  };
}

/** The 2048 x 2048 JPEG 2000 square across a square page of `points` points a side: 8 inches unless given. */
function squarePdf(points = 576): Uint8Array {
  return scannedPdf([{
    images: [squareImage()], content: `q ${points} 0 0 ${points} 0 0 cm /Im0 Do Q`, size: [points, points],
  }]);
}

/** A renderer under `limits` that counts the tries made on it: each opens the document once. */
function counting(limits: RenderLimits) {
  let tries = { count: 0 };
  let renderer = watched(limits, {
    wrap: instance => replacing(instance, {
      FPDF_LoadCustomDocument: (...args) => {
        tries.count++;
        return instance.exports.FPDF_LoadCustomDocument!(...args);
      },
    }),
  });
  return { renderer, tries };
}

/** How often each of `needles` is in `memory`. */
function occurrences(memory: Uint8Array, needles: Uint8Array[]): number[] {
  return needles.map(needle => {
    let found = 0;
    for (let at = memory.indexOf(needle[0]!); at >= 0; at = memory.indexOf(needle[0]!, at + 1)) {
      if (at + needle.length > memory.length) break;
      let i = 1;
      while (i < needle.length && memory[at + i] === needle[i]) i++;
      if (i === needle.length) found++;
    }
    return found;
  });
}

/** The entry of the function table PDFium reads the file through: the first of the two the renderer adds. */
function blockReader({ exports }: PdfiumInstance) {
  let table = exports.__indirect_function_table;
  return table.get(table.length - 2) as (param: number, position: number, buffer: number, size: number) => number;
}

/** A page of 100 rows of ink: cut in two, an even cut would fall at row 50, and may move 6 rows either way. */
function inked(ink: (row: number) => number): number[] {
  return Array.from({ length: 100 }, (_, row) => ink(row));
}

/** `rows` rows with no ink. */
function clear(rows: number): number[] {
  return Array.from({ length: rows }, () => 0);
}

describe("each encoding renders to the pattern, every pixel", () => {
  it.each<[string, () => Uint8Array, Uint8Array]>([
    ["Group 4 fax", faxPdf, PATTERN_MARKS],
    ["JBIG2, an MMR generic region", jbig2Pdf, PATTERN_MARKS],
    ["JBIG2, an arithmetic-coded generic region", () => scannedPdf([onePage(arithmeticJbig2Image())]), PATTERN_MARKS],
    ["lossless JPEG 2000", jpxPdf, PATTERN_SHADED],
    ["deflated 1-bit grey", () => scannedPdf([onePage(bitsImage())]), PATTERN_MARKS],
    [
      "a deflated stencil mask and nothing else",
      () => scannedPdf([onePage(bitsImage("/ImageMask true"), `0 g ${DRAWN_WHOLE}`)]), PATTERN_MARKS,
    ],
    [
      "a palette of two colours",
      () => scannedPdf([onePage(bitsImage("/ColorSpace [/Indexed /DeviceRGB 1 <000000FFFFFF>]"))]), PATTERN_MARKS,
    ],
    // These tiles meet on whole pixels. One whose edge falls between two is drawn a pixel larger,
    // and what it holds is up to a pixel from where it is stored.
    ["2 x 2 tiles of deflated grey that meet on whole pixels", tilesPdf, PATTERN_SHADED],
  ])("%s", (_stored, pdf, pattern) => {
    let page = shared.renderPage(pdf());
    expect([page.width, page.height]).toEqual([PATTERN_WIDTH, PATTERN_HEIGHT]);
    expect(differing(page.pixels, pattern)).toBe(0);
    expect(page).toMatchObject({ blank: false, dpi: 72, reduced: false, bands: [0, PATTERN_HEIGHT] });
    shared.expectRestored();
  });

  it("a stamp on a page that draws nothing is on the page: annotations are drawn with it", () => {
    let page = shared.renderPage(stampedPdf());
    // What the stamp draws is none of the page's objects, so the page is not known to draw no image.
    expect(page).toMatchObject({ blank: false, images: 0, surveyed: false });
    // The stamp's half of every row is black and the other half is the page's white.
    for (let row = 0; row < PATTERN_HEIGHT; row++) {
      let pixels = page.pixels.subarray(row * PATTERN_WIDTH, (row + 1) * PATTERN_WIDTH);
      expect([pixels[0], pixels[PATTERN_WIDTH / 2 - 1], pixels[PATTERN_WIDTH / 2], pixels[PATTERN_WIDTH - 1]])
        .toEqual([0, 0, 255, 255]);
    }
    shared.expectRestored();
  });

  it("what a form's field holds is on the page: the form layer is drawn over it", () => {
    let page = shared.renderPage(filledFieldPdf());
    expect(page).toMatchObject({ blank: false, images: 0, surveyed: false });
    for (let row = 0; row < PATTERN_HEIGHT; row++) {
      let pixels = page.pixels.subarray(row * PATTERN_WIDTH, (row + 1) * PATTERN_WIDTH);
      expect([pixels[0], pixels[PATTERN_WIDTH / 2 - 1], pixels[PATTERN_WIDTH / 2], pixels[PATTERN_WIDTH - 1]])
        .toEqual([0, 0, 255, 255]);
    }
    shared.expectRestored();
  });

  it("a page tree in another order than the file: page 1 is the second stored", () => {
    let white = greyImage(new Uint8Array(PATTERN_WIDTH * PATTERN_HEIGHT).fill(255), PATTERN_WIDTH, PATTERN_HEIGHT);
    let pdf = scannedPdf([onePage(white), onePage(bitsImage())], { order: [1, 0] });
    expect(shared.countPages(pdf)).toBe(2);
    let page = shared.renderPage(pdf, 0);
    expect(differing(page.pixels, PATTERN_MARKS)).toBe(0);
    let second = shared.renderPage(pdf, 1);
    expect(second).toMatchObject({ blank: true, images: 1 });
    expect(second.pixels.every(value => value === 255)).toBe(true);
    shared.expectRestored();
  });
});

describe("a page's bands", () => {
  it("each say whether they have ink, and a blank page's have none", () => {
    // A page of 64 rows is cut in two, at row 32 when the rows about it are alike.
    let cut = watched({ ...AT_72, bandRows: 10 });
    expect(cut.renderPage(barPdf(4, 20))).toMatchObject({ blank: false, bands: [0, 32, 64], inked: [true, false] });
    expect(cut.renderPage(barPdf(40, 44))).toMatchObject({ blank: false, bands: [0, 32, 64], inked: [false, true] });
    expect(cut.renderPage(barPdf(20, 44))).toMatchObject({ blank: false, bands: [0, 32, 64], inked: [true, true] });
    // One black pixel, in the page's last row.
    let dot = new Uint8Array(PATTERN_WIDTH * PATTERN_HEIGHT).fill(255).fill(0, -1);
    expect(cut.renderPage(scannedPdf([onePage(greyImage(dot, PATTERN_WIDTH, PATTERN_HEIGHT))])))
      .toMatchObject({ blank: false, bands: [0, 32, 64], inked: [false, true] });
    expect(cut.renderPage(barPdf(0, 0))).toMatchObject({ blank: true, bands: [0, 32, 64], inked: [false, false] });
    cut.expectRestored();
  });

  it.each<[string, (row: number) => number, number]>([
    ["dark on white", () => 255, 0],
    ["light on black", () => 0, 255],
    ["light on grey", () => 110, 250],
    ["dark on grey", () => 120, 10],
    // The ground darkens faster down the page than a line of writing darkens its rows.
    ["dark on a ground that darkens down the page", row => 255 - Math.round(3.5 * row), 0],
  ])("are cut between two lines of writing that is %s", (_look, ground, ink) => {
    // A page of 64 rows is cut in two within three rows of row 32: of rows 29 to 35, only at
    // row 35 is neither row at the seam in a line.
    let cut = watched({ ...AT_72, bandRows: 10 });
    expect(cut.renderPage(writtenPdf(ground, ink))).toMatchObject({ blank: false, bands: [0, 35, 64], inked: [true, true] });
    cut.expectRestored();
  });

  it("are one when the page is set in columns, and two when its writing is one column", () => {
    let cut = watched({ ...AT_72, bandRows: 10 });
    expect(cut.renderPage(columnsPdf([[10, 86]]))).toMatchObject({ blank: false, bands: [0, 29, 64], inked: [true, true] });
    expect(cut.renderPage(columnsPdf([[10, 40], [56, 86]]))).toMatchObject({ blank: false, bands: [0, 64], inked: [true] });
    cut.expectRestored();
  });

  it("each have their first row, their rows, the ink of their rows, and pixels of their own when any is not white", () => {
    let cut = watched({ ...AT_72, bandRows: 10 });
    // Ten rows in twelve hold ten pixels of writing, each 255 levels from the row's ground.
    let page = cut.rendered(writtenPdf(() => 255, 0));
    expect(page.bands).toHaveLength(2);
    expect(page.bands[0]).toMatchObject({ top: 0, rows: 35, ink: 30 * 10 * 255 });
    expect(page.bands[1]).toMatchObject({ top: 35, rows: 29, ink: 24 * 10 * 255 });
    let whole = drawn(page).pixels;
    expect(Buffer.compare(page.bands[0]!.pixels!, whole.subarray(0, 35 * PATTERN_WIDTH))).toBe(0);
    expect(Buffer.compare(page.bands[1]!.pixels!, whole.subarray(35 * PATTERN_WIDTH))).toBe(0);
    expect(page.bands[0]!.pixels!.buffer).not.toBe(page.bands[1]!.pixels!.buffer);
    // A band with nothing on it has no ink and no pixels, and says so by having none.
    let upper = cut.rendered(barPdf(4, 20));
    expect(upper.bands[1]).toEqual({ top: 32, rows: 32, ink: 0 });
    expect("pixels" in upper.bands[1]!).toBe(false);
    cut.expectRestored();
  });

  it("are as many as are asked for, where the page has the rows for them", () => {
    // A page of 64 rows with nothing on it is cut evenly.
    let cut = watched({ ...AT_72, bandRows: 8 });
    for (let bands = 1; bands <= AT_72.bands; bands++) {
      expect(cut.renderPage(barPdf(0, 0), 0, { bands }).bands)
        .toEqual(Array.from({ length: bands + 1 }, (_, band) => Math.round((band * 64) / bands)));
    }
    // With ten rows to a band it has the rows for six.
    expect(watched({ ...AT_72, bandRows: 10 }).renderPage(barPdf(0, 0), 0, { bands: 8 }).bands).toHaveLength(7);
  });

  it("a number of bands no page is cut into, and a page that is no page, are RangeErrors that open nothing", () => {
    let fresh = watched();
    let hold = holding(fresh.renderer, faxPdf());
    for (let bands of [0, AT_72.bands + 1, 1.5, -1, Number.NaN]) {
      expect(() => hold.renderPage(0, { bands })).toThrow(new RangeError(`A page is cut into 1 to 8 bands, not ${bands}.`));
    }
    for (let index of [-1, 0.5, Number.NaN]) {
      expect(() => hold.renderPage(index, IN_TWO)).toThrow(new RangeError(`The PDF has no page ${index}.`));
    }
    expect(fresh.instances).toHaveLength(0);
    // A page past the last is known only once the PDF is open.
    expect(() => hold.renderPage(1, IN_TWO)).toThrow(new RangeError("The PDF has no page 1."));
    expect(fresh.instances).toHaveLength(1);
    expect(hold.renderPage(0, IN_TWO).blank).toBe(false);
    hold.release();
    fresh.expectRestored();
  });

  it("a band that holds more lines than are asked for is cut once more, where a cut may be made", () => {
    let cut = watched({ ...AT_72, bandRows: 10 });
    // Lines of four rows with two clear rows between them: five above the cut at row 29, six below it.
    let lined = columnsPdf([[10, 86]]);
    expect(cut.renderPage(lined, 0, { bands: 2, denseLines: 6 }).bands).toEqual([0, 29, 64]);
    expect(cut.renderPage(lined, 0, { bands: 2, denseLines: 5 }).bands).toEqual([0, 29, 47, 64]);
    expect(cut.renderPage(lined, 0, { bands: 2, denseLines: 4 }).bands).toEqual([0, 11, 29, 47, 64]);
    // Without the option no band is counted.
    expect(cut.renderPage(lined, 0, { bands: 2 }).bands).toEqual([0, 29, 64]);
    // A page set in columns is not cut across them for its lines either.
    expect(cut.renderPage(columnsPdf([[10, 40], [56, 86]]), 0, { bands: 2, denseLines: 1 }).bands).toEqual([0, 64]);
    cut.expectRestored();
  });

  it("have ink wherever a pixel is not white, though their rows are one level across", () => {
    // Rows of one grey each, none of them white: no row stands out from its own ground.
    let samples = new Uint8Array(PATTERN_WIDTH * PATTERN_HEIGHT);
    for (let row = 0; row < PATTERN_HEIGHT; row++) samples.fill(200 - row, row * PATTERN_WIDTH, (row + 1) * PATTERN_WIDTH);
    let cut = watched({ ...AT_72, bandRows: 10 });
    expect(cut.renderPage(scannedPdf([onePage(greyImage(samples, PATTERN_WIDTH, PATTERN_HEIGHT))])))
      .toMatchObject({ blank: false, bands: [0, 32, 64], inked: [true, true] });
    // Black above the middle and white below it.
    expect(cut.renderPage(barPdf(0, 32))).toMatchObject({ blank: false, bands: [0, 32, 64], inked: [true, false] });
    cut.expectRestored();
  });
});

describe("turned pages", () => {
  it.each([[90, 1], [180, 2], [270, 3]])("a fax page with /Rotate %i is the pattern turned, every pixel", (rotate, quarters) => {
    let page = shared.renderPage(scannedPdf([{ ...onePage(faxImage()), rotate }]));
    expect(differing(page.pixels, turnedClockwise(PATTERN_MARKS, PATTERN_WIDTH, PATTERN_HEIGHT, quarters))).toBe(0);
    expect(page.blank).toBe(false);
    shared.expectRestored();
  });

  it("a page whose /Rotate is inherited from the page tree is the pattern turned, every pixel", () => {
    let page = shared.renderPage(scannedPdf([onePage(faxImage())], { rotate: 90 }));
    expect(differing(page.pixels, turnedClockwise(PATTERN_MARKS, PATTERN_WIDTH, PATTERN_HEIGHT, 1))).toBe(0);
    shared.expectRestored();
  });

  it("a page of 96 x 64 points turned a quarter is 64 wide", () => {
    for (let rotate of [90, 270]) {
      let page = shared.renderPage(scannedPdf([{ ...onePage(faxImage()), rotate }]));
      expect([page.width, page.height]).toEqual([PATTERN_HEIGHT, PATTERN_WIDTH]);
      expect(page.bands).toEqual([0, PATTERN_WIDTH]);
    }
    let upright = shared.renderPage(scannedPdf([{ ...onePage(faxImage()), rotate: 180 }]));
    expect([upright.width, upright.height]).toEqual([PATTERN_WIDTH, PATTERN_HEIGHT]);
  });
});

describe("limits", () => {
  it("the most the product's limits let an isolate hold is under 100 MiB", () => {
    // The instance grown to its cap, which it never gives back; the image it is put back from
    // after each call; the PDFs held; and one page's bands, once as they are copied out and
    // once more as the answer is written for the binding.
    let most = RENDER_LIMITS.heapBytes + atRest().image.length + RENDER_LIMITS.heldBytes + 2 * RENDER_LIMITS.pagePixels;
    expect(most).toBeLessThan(100 * MIB);
  });

  it("a 14,400 point page renders within the pixels a page and a side may have", () => {
    let pdf = scannedPdf([{ ...onePage(bitsImage(), "q 14400 0 0 14400 0 0 cm /Im0 Do Q"), size: [14_400, 14_400] }]);
    let page = shared.renderPage(pdf);
    expect([page.width, page.height]).toEqual([1732, 1732]);
    expect(page.width * page.height).toBeLessThanOrEqual(AT_72.pagePixels);
    expect(Math.max(page.width, page.height)).toBeLessThanOrEqual(AT_72.sidePixels);
    expect(page.dpi).toBeCloseTo(8.66, 2);
    expect(page.blank).toBe(false);
    // Over twice the 400 rows a page has to have for each band, so the page is cut in two.
    expect(page.bands).toHaveLength(3);
    shared.expectRestored();
  });

  it("a page as long as a side may be is not rendered longer", () => {
    let page = shared.renderPage(scannedPdf([{ ...onePage(bitsImage()), size: [10, 14_400] }]));
    expect([page.width, page.height]).toEqual([3, 4000]);
    shared.expectRestored();
  });

  it("a page whose sides round to more pixels than a page may have loses rows until it does not", () => {
    // 1225 x 2449 as it rounds, which is 25 pixels over.
    let page = shared.renderPage(scannedPdf([{ ...onePage(bitsImage()), size: [3000, 6000] }]));
    expect([page.width, page.height]).toEqual([1225, 2448]);
    expect(page.width * page.height).toBeLessThanOrEqual(AT_72.pagePixels);
    shared.expectRestored();
  });

  it("an image that declares 65535 x 65535 is image-pixels, of its page", () => {
    let image = { ...bitsImage(), dict: bitsImage().dict.replace("/Width 96 /Height 64", "/Width 65535 /Height 65535") };
    expect(image.dict).toContain("/Width 65535 /Height 65535");
    let error = refusal(() => shared.renderPage(scannedPdf([onePage(image)])));
    expect(error).toMatchObject({ reason: "image-pixels", ofPage: true });
    expect(error.heapBytes).toBeGreaterThanOrEqual(START_BYTES);
    shared.expectRestored();
  });

  it("6,001 fills, of which the last is past the 5,000 looked at, are painted whole", () => {
    let page = shared.renderPage(manyFillsPdf());
    expect(page.cost.objects).toBe(5000);
    // The page's right half, and the one point every other fill is of.
    expect(darker(page.pixels, 1)).toBe(3073);
    shared.expectRestored();
  });

  it("a form nested five deep, past the four that are looked into, is painted whole", () => {
    let page = shared.renderPage(nestedFill(5));
    expect(page.cost.objects).toBe(5);
    expect(darker(page.pixels, 1)).toBe(3072);
    shared.expectRestored();
  });

  it("a page says whether all of its objects were looked at for images: not past the depth or the number that are", () => {
    expect(shared.renderPage(nestedFill(4))).toMatchObject({ images: 0, surveyed: true });
    // The innermost form is not looked into, so what it draws is not known to hold no image.
    expect(shared.renderPage(nestedFill(5))).toMatchObject({ images: 0, surveyed: false });
    // Four tiles, of which one is looked at.
    expect(shared.renderPage(tilesPdf())).toMatchObject({ images: 4, surveyed: true });
    expect(watched({ ...AT_72, pageObjects: 1 }).renderPage(tilesPdf())).toMatchObject({ images: 1, surveyed: false });
    expect(watched({ ...AT_72, pageObjects: 4 }).renderPage(tilesPdf())).toMatchObject({ images: 4, surveyed: true });
  });

  it("a content stream that inflates past the cap is memory, of its page", () => {
    let error = refusal(() => shared.renderPage(drawnPdf(strokes(64 * MIB))));
    expect(error).toMatchObject({ reason: "memory", ofPage: true });
    expect(error.heapBytes).toBeLessThanOrEqual(AT_72.heapBytes);
    expect(shared.memory().length).toBeLessThanOrEqual(AT_72.heapBytes);
    shared.expectRestored();
  });

  it("what is not a PDF is unreadable, and not of a page", () => {
    let file = new TextEncoder().encode("not a PDF at all");
    for (let call of [() => shared.countPages(file), () => shared.renderPage(file)]) {
      expect(refusal(call)).toMatchObject({ reason: "unreadable", ofPage: false });
      shared.expectRestored();
    }
  });

  it("an /Encrypt entry that names nothing does not keep PDFium from rendering: the scan is what refuses it", () => {
    let page = shared.renderPage(scannedPdf([onePage(bitsImage())], { trailer: " /Encrypt 99 0 R" }));
    expect(differing(page.pixels, PATTERN_MARKS)).toBe(0);
    shared.expectRestored();
  });

  it("an encrypted PDF is encrypted, and not of a page, whether or not it opens without a password", () => {
    for (let pdf of [encryptedPdf(), encryptedPdf(true)]) {
      for (let call of [() => shared.countPages(pdf), () => shared.renderPage(pdf)]) {
        expect(refusal(call)).toMatchObject({ reason: "encrypted", ofPage: false });
        shared.expectRestored();
      }
    }
  });

  it("the encrypted PDF that opens without a password is one PDFium would render: only the refusal keeps it from that", () => {
    let unrefusing = watched(AT_72, { wrap: instance => replacing(instance, { FPDF_GetSecurityHandlerRevision: () => -1 }) });
    expect(differing(unrefusing.renderPage(encryptedPdf()).pixels, PATTERN_MARKS)).toBe(0);
    // One that asks for a password does not open at all.
    expect(refusal(() => unrefusing.renderPage(encryptedPdf(true))).reason).toBe("encrypted");
  });

  it("a page's images are image-pixels when they declare more between them than a page's may, each within its own limit", () => {
    // Four tiles of 48 x 32.
    let within = watched({ ...AT_72, imagePixels: 48 * 32, pageImagePixels: 4 * 48 * 32 });
    let page = within.renderPage(tilesPdf());
    expect(page.cost.imagePixels).toBe(4 * 48 * 32);
    expect(page.images).toBe(4);
    expect(differing(page.pixels, PATTERN_SHADED)).toBe(0);
    let together = watched({ ...AT_72, imagePixels: 48 * 32, pageImagePixels: 4 * 48 * 32 - 1 });
    expect(refusal(() => together.renderPage(tilesPdf()))).toMatchObject({ reason: "image-pixels", ofPage: true });
    together.expectRestored();
    let each = watched({ ...AT_72, imagePixels: 48 * 32 - 1, pageImagePixels: 4 * 48 * 32 });
    expect(refusal(() => each.renderPage(tilesPdf()))).toMatchObject({ reason: "image-pixels", ofPage: true });
    each.expectRestored();
  });

  it("a size over the file limit is file-size from hold(), before any instance is made", () => {
    let fresh = watched();
    for (let fileBytes of [AT_72.fileBytes + 1, 0, -1, Number.NaN]) {
      expect(refusal(() => fresh.renderer.hold(fileBytes))).toMatchObject({ reason: "file-size", ofPage: false, heapBytes: 0 });
    }
    expect(fresh.instances).toHaveLength(0);
    expect(fresh.renderer.hold(AT_72.fileBytes).file).toHaveLength(AT_72.fileBytes);
    expect(fresh.instances).toHaveLength(0);
  });

  it("2,001 pages under a limit of 2,000 is page-count, and a page past the last is a RangeError", () => {
    let blank = { images: [], content: "" };
    let over = scannedPdf(Array.from({ length: 2001 }, () => blank));
    expect(AT_72.pages).toBe(2000);
    for (let call of [() => shared.countPages(over), () => shared.renderPage(over)]) {
      expect(refusal(call)).toMatchObject({ reason: "page-count", ofPage: false });
      shared.expectRestored();
    }
    let atLimit = scannedPdf(Array.from({ length: 2000 }, () => blank));
    expect(shared.countPages(atLimit)).toBe(2000);
    expect(shared.renderPage(atLimit, 1999).blank).toBe(true);
    expect(() => shared.renderPage(atLimit, 2000)).toThrow(new RangeError("The PDF has no page 2000."));
    shared.expectRestored();
  });

  it("a step limit of 1 is steps, of its page", () => {
    let limited = watched({ ...AT_72, steps: 1 });
    // A page that is painted in one step is within it.
    expect(limited.renderPage(faxPdf()).cost.steps).toBe(1);
    limited.expectRestored();
    expect(shared.renderPage(manyFillsPdf()).cost.steps).toBeGreaterThan(1);
    expect(refusal(() => limited.renderPage(manyFillsPdf()))).toMatchObject({ reason: "steps", ofPage: true });
    limited.expectRestored();
    expect(differing(limited.renderPage(faxPdf()).pixels, PATTERN_MARKS)).toBe(0);
  });

  it("a refusal says whether it is of one page, and carries a word and no more", () => {
    let whole: RenderRefusalReason[] = [
      "start", "released", "file-size", "size-mismatch", "room", "encrypted", "unreadable", "page-count", "empty-work",
    ];
    let ofPage: RenderRefusalReason[] = ["page-size", "page-load", "image-pixels", "steps", "work", "memory", "abort", "trap", "render"];
    expect(whole.map(reason => new RenderRefusal(reason).ofPage)).toEqual(whole.map(() => false));
    expect(ofPage.map(reason => new RenderRefusal(reason).ofPage)).toEqual(ofPage.map(() => true));
    let error = new RenderRefusal("memory");
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ message: "The PDF could not be rendered (memory).", heapBytes: 0, work: 0 });
    expect(error.cause).toBeUndefined();
    let cause = new Error("an import is missing");
    expect(new RenderRefusal("start", cause).cause).toBe(cause);
  });
});

describe("work", () => {
  /** A renderer under the product's limits: the shapes are US Letter pages at its 150 dpi. */
  let product = watched(RENDER_LIMITS);
  let alone: Uint8Array | undefined;
  /** Holds the instance to its first image, and the page rendered next to the same page from a renderer of its own. */
  let expectUnharmed = (renderer: ReturnType<typeof watched>) => {
    renderer.expectRestored();
    alone ??= watched(RENDER_LIMITS).renderPage(faxPdf()).pixels;
    let page = renderer.renderPage(faxPdf());
    expect([page.width, page.height, page.blank]).toEqual([200, 133, false]);
    expect(differing(page.pixels, alone)).toBe(0);
    renderer.expectRestored();
  };

  it.each<[string, () => Uint8Array]>([
    ["32 fills under /ca 0.5 /BM /Multiply", () => blendedFills(32)],
    ["4,999 radial shadings", () => radialShadings(4999)],
    ["a form of 4 MiB of q Q drawn 400 times", () => formDrawnAgain(400, 4 * MIB)],
    ["forms nested 10 x 10 x 10 of 0.25 MiB", () => nestedForms(10, 3, MIB / 4)],
  ])("%s is work, of its page, and the instance is as it was", { timeout: 30_000 }, (_shape, pdf) => {
    let file = pdf();
    // A few kilobytes that pass every check of a size or a count of the file's own.
    expect(file.byteLength).toBeLessThan(5000);
    expect(product.countPages(file)).toBe(1);
    let error = refusal(() => product.renderPage(file));
    expect(error).toMatchObject({ reason: "work", ofPage: true });
    expect(error.work).toBeGreaterThan(RENDER_LIMITS.work / 2);
    expect(error.work).toBeLessThanOrEqual(RENDER_LIMITS.work);
    expectUnharmed(product);
  });

  it("one blended fill renders", { timeout: 30_000 }, () => {
    let page = product.renderPage(blendedFills(1));
    expect([page.width, page.height, page.blank]).toEqual([1275, 1650, false]);
    expect(page.cost.work).toBeLessThan(RENDER_LIMITS.work / 10);
    expectUnharmed(product);
  });

  it("pages that leave nothing to send are empty-work once they have used a PDF's allowance", { timeout: 30_000 }, () => {
    let limited = watched({ ...RENDER_LIMITS, emptyWork: 1_000_000_000 });
    let file = sharedContentPages(2000, 12 * MIB);
    let hold = holding(limited.renderer, file);
    expect(hold.countPages()).toBe(2000);
    let blank = 0;
    let error = refusal(() => {
      for (let index = 0; index < 10; index++) {
        let page = hold.renderPage(index, IN_TWO);
        expect(page.blank).toBe(true);
        expect(page.cost.work).toBeLessThanOrEqual(RENDER_LIMITS.work);
        blank++;
      }
    });
    expect(error).toMatchObject({ reason: "empty-work", ofPage: false });
    expect(blank).toBeGreaterThan(0);
    expect(blank).toBeLessThan(10);
    // Counting is refused as a page is: the allowance is the PDF's.
    expect(refusal(() => hold.countPages())).toMatchObject({ reason: "empty-work", ofPage: false });
    hold.release();
    // Another hold of the same file begins with the whole allowance.
    let again = holding(limited.renderer, file);
    expect(again.countPages()).toBe(2000);
    expect(again.renderPage(0, IN_TWO).blank).toBe(true);
    again.release();
    expectUnharmed(limited);
  });

  it("a page with ink does not take from the allowance, and one that is refused does", { timeout: 30_000 }, () => {
    let limited = watched({ ...RENDER_LIMITS, emptyWork: 300_000 });
    let written = holding(limited.renderer, faxPdf());
    let cost = written.renderPage(0, IN_TWO).cost.work;
    // A page of the fixture takes more than half the allowance, so two blank ones would use it up.
    expect(cost).toBeGreaterThan(150_000);
    for (let n = 0; n < 5; n++) expect(written.renderPage(0, IN_TWO).blank).toBe(false);
    written.release();
    let refused = holding(limited.renderer, blendedFills(32));
    expect(refusal(() => refused.renderPage(0, IN_TWO)).reason).toBe("work");
    expect(refusal(() => refused.renderPage(0, IN_TWO)).reason).toBe("empty-work");
    refused.release();
    limited.expectRestored();
  });

  it("a call that runs out of work in its last steps into PDFium is work, as one that runs out sooner is", () => {
    let cost = watched().renderPage(faxPdf()).cost.work;
    // With the page's own cost the counter comes to zero in the last call the page makes, and
    // with a few less in the calls before it: reading where a strip's rows lie, closing the render.
    for (let work = cost - 8; work <= cost; work++) {
      let limited = watched({ ...AT_72, work });
      expect(refusal(() => limited.renderPage(faxPdf())), `${cost - work} short`).toMatchObject({ reason: "work", ofPage: true, work });
      limited.expectRestored();
    }
    let enough = watched({ ...AT_72, work: cost + 1 });
    let page = enough.renderPage(faxPdf());
    expect(page.cost.work).toBe(cost);
    expect(differing(page.pixels, PATTERN_MARKS)).toBe(0);
  });

  it("a file that runs out of work as PDFium is asked why it did not open is work, not unreadable", () => {
    let notPdf = new TextEncoder().encode("not a PDF at all");
    let spent = refusal(() => watched().countPages(notPdf));
    expect(spent).toMatchObject({ reason: "unreadable" });
    expect(spent.work).toBeGreaterThan(0);
    let limited = watched({ ...AT_72, work: spent.work });
    expect(refusal(() => limited.countPages(notPdf))).toMatchObject({ reason: "work", ofPage: false, work: spent.work });
    limited.expectRestored();
    expect(refusal(() => watched({ ...AT_72, work: spent.work + 1 }).countPages(notPdf)).reason).toBe("unreadable");
  });

  it("counting pages takes from the allowance", () => {
    let limited = watched({ ...AT_72, emptyWork: 1 });
    let hold = holding(limited.renderer, faxPdf());
    expect(hold.countPages()).toBe(1);
    let error = refusal(() => hold.countPages());
    expect(error).toMatchObject({ reason: "empty-work", ofPage: false, work: 0 });
    expect(refusal(() => hold.renderPage(0, IN_TWO)).reason).toBe("empty-work");
    hold.release();
    limited.expectRestored();
  });
});

describe("a second try", () => {
  it("draws a page that ran out of memory at half the resolution, and says so", () => {
    let { renderer, tries } = counting({ ...RENDER_LIMITS, heapBytes: 20 * MIB });
    let page = renderer.renderPage(squarePdf());
    expect(tries.count).toBe(2);
    expect([page.width, page.height]).toEqual([600, 600]);
    expect(page).toMatchObject({ reduced: true, dpi: 75, blank: false });
    // The square is a sixteenth of the image.
    let black = darker(page.pixels, 128) / page.pixels.length;
    expect(black).toBeGreaterThan(0.05);
    expect(black).toBeLessThan(0.08);
    expect(page.cost.work).toBeLessThanOrEqual(RENDER_LIMITS.work);
    expect(renderer.memory().length).toBeLessThanOrEqual(20 * MIB);
    renderer.expectRestored();
  });

  it("rounds both sides down on a second try, which a first try rounds to the nearest", () => {
    // 492 points are 1025 pixels at 150 dpi and 512.5 at 75: a quarter of the image's side, and
    // a pixel more would have the image decoded at half its size in place of a quarter.
    let { renderer, tries } = counting({ ...RENDER_LIMITS, heapBytes: 20 * MIB });
    let page = renderer.renderPage(squarePdf(492));
    expect(tries.count).toBe(2);
    expect([page.width, page.height]).toEqual([512, 512]);
    expect(page).toMatchObject({ reduced: true, dpi: 75 });
    let { renderer: roomy, tries: once } = counting({ ...RENDER_LIMITS, heapBytes: 32 * MIB });
    let whole = roomy.renderPage(squarePdf(492));
    expect(once.count).toBe(1);
    expect([whole.width, whole.height]).toEqual([1025, 1025]);
    // A first try at 75 dpi rounds the same page up.
    let first = watched({ ...RENDER_LIMITS, dpi: 75 }).renderPage(squarePdf(492));
    expect([first.width, first.height, first.reduced]).toEqual([513, 513, false]);
  });

  it("draws the same page at the resolution asked when the memory allows it", () => {
    let { renderer, tries } = counting({ ...RENDER_LIMITS, heapBytes: 32 * MIB });
    let page = renderer.renderPage(squarePdf());
    expect(tries.count).toBe(1);
    expect([page.width, page.height]).toEqual([1200, 1200]);
    expect(page).toMatchObject({ reduced: false, dpi: 150, blank: false });
    let black = darker(page.pixels, 128) / page.pixels.length;
    expect(black).toBeGreaterThan(0.05);
    expect(black).toBeLessThan(0.08);
    renderer.expectRestored();
  });

  // A deflated image is held whole at any resolution, so its second try fails as its first did.
  // 25 MB of samples: the 16 MiB an instance has free when it starts would hold a 4000 x 4000 image.
  it("is memory when the second try runs out too, never a blank page", () => {
    let { renderer, tries } = counting({ ...RENDER_LIMITS, heapBytes: 19 * MIB });
    expect(renderer.renderPage(faxPdf()).blank).toBe(false);
    renderer.expectRestored();
    expect(tries.count).toBe(1);
    let error = refusal(() => renderer.renderPage(blackSquarePdf(5000)));
    expect(error).toMatchObject({ reason: "memory", ofPage: true });
    expect(tries.count).toBe(3);
    expect(renderer.memory().length).toBeLessThanOrEqual(19 * MIB);
    renderer.expectRestored();
  });

  it("has the work the first try left, and the page's work is that of both", () => {
    let limits = { ...RENDER_LIMITS, heapBytes: 20 * MIB };
    /** What the counter stood at when each try began, and after the last step into PDFium so far. */
    let began: number[] = [];
    let after = 0;
    let watching = (instance: PdfiumInstance) => replacing(instance, {
      FPDF_LoadCustomDocument: (...args) => {
        began.push(instance.exports.work.value as number);
        return instance.exports.FPDF_LoadCustomDocument!(...args);
      },
      FPDFBitmap_GetStride: bitmap => {
        let stride = instance.exports.FPDFBitmap_GetStride!(bitmap);
        after = instance.exports.work.value as number;
        return stride;
      },
    });
    let page = watched(limits, { wrap: watching }).renderPage(squarePdf());
    expect(page.reduced).toBe(true);
    expect(began).toHaveLength(2);
    expect(began[0]).toBe(limits.work);
    let first = began[0]! - began[1]!;
    expect(first).toBeGreaterThan(0);
    // The first try's work and the second's, which ended at its last strip.
    expect(page.cost.work).toBe(first + (began[1]! - after));
    // With a little more than the first try takes, the second is ended by what is left.
    let short = watched({ ...limits, work: first + 1000 });
    expect(refusal(() => short.renderPage(squarePdf()))).toMatchObject({ reason: "work", ofPage: true, work: first + 1000 });
    short.expectRestored();
  });

  it("is at half the resolution of the page's densest image, when that is under the resolution asked", () => {
    // 2048 pixels across 1024 points are 144 dpi, and a second image beside it, 96 across the same, is 6.75.
    let low = { ...bitsImage() };
    let across = "q 1024 0 0 1024 0 0 cm";
    for (let [images, content] of [
      [[squareImage(), low], `${across} /Im0 Do Q ${across} /Im1 Do Q`],
      [[low, squareImage()], `${across} /Im0 Do Q ${across} /Im1 Do Q`],
    ] as const) {
      let { renderer, tries } = counting({ ...RENDER_LIMITS, heapBytes: 20 * MIB });
      let page = renderer.renderPage(scannedPdf([{ images: [...images], content, size: [1024, 1024] }]));
      expect(tries.count).toBe(2);
      expect(page).toMatchObject({ reduced: true, dpi: 72, images: 2 });
      expect([page.width, page.height]).toEqual([1024, 1024]);
      renderer.expectRestored();
    }
  });

  it("is not made for a page that ran out of memory before any of it was painted", () => {
    let { renderer, tries } = counting(RENDER_LIMITS);
    expect(refusal(() => renderer.renderPage(drawnPdf(strokes(64 * MIB))))).toMatchObject({ reason: "memory", ofPage: true });
    expect(tries.count).toBe(1);
    renderer.expectRestored();
  });

  it("is made for a page whose strip could not be made, which is memory", () => {
    let tries = 0;
    let renderer = watched(RENDER_LIMITS, {
      wrap: instance => replacing(instance, {
        FPDF_LoadCustomDocument: (...args) => {
          tries++;
          return instance.exports.FPDF_LoadCustomDocument!(...args);
        },
        FPDFBitmap_CreateEx: () => 0,
      }),
    });
    // A page that draws no image is tried again at half the resolution asked.
    expect(refusal(() => renderer.renderPage(drawnPdf("0 g 0 0 48 64 re f\n")))).toMatchObject({ reason: "memory", ofPage: true });
    expect(tries).toBe(2);
    renderer.expectRestored();
  });

  it("is not made under 72 dpi: a page asked for at 72 dpi is tried once", () => {
    let { renderer, tries } = counting({ ...AT_72, heapBytes: 19 * MIB });
    expect(refusal(() => renderer.renderPage(blackSquarePdf(5000)))).toMatchObject({ reason: "memory", ofPage: true });
    expect(tries.count).toBe(1);
    renderer.expectRestored();
  });
});

/** A renderer whose instance has `exports` in place of PDFium's own. */
function standingIn(exports: (instance: PdfiumInstance) => Record<string, (...args: number[]) => number>) {
  return watched(AT_72, { wrap: instance => replacing(instance, exports(instance)) });
}

/** An export that writes `sides` where PDFium is asked to write a page's size, and says it did. */
function sized(instance: PdfiumInstance, sides: [number, number]) {
  return {
    FPDF_GetPageSizeByIndexF: (_document: number, _index: number, to: number) => {
      new Float32Array(instance.exports.memory.buffer, to, 2).set(sides);
      return 1;
    },
  };
}

describe("a call into PDFium that does not do what it was asked", () => {
  it.each<[string, RenderRefusalReason, (instance: PdfiumInstance) => number]>([
    ["an abort", "abort", () => {
      throw new PdfiumAbort("PDFium aborted");
    }],
    ["a trap", "trap", () => {
      throw new WebAssembly.RuntimeError("unreachable");
    }],
    ["a stack that ran out", "trap", () => {
      throw new RangeError("Maximum call stack size exceeded");
    }],
    ["a growth refused during a call that returned", "memory", instance => {
      instance.host.refusedGrowths++;
      return 1;
    }],
    ["a growth refused before an abort", "memory", instance => {
      instance.host.refusedGrowths++;
      throw new PdfiumAbort("PDFium aborted");
    }],
    ["a growth refused before a trap", "memory", instance => {
      instance.host.refusedGrowths++;
      throw new WebAssembly.RuntimeError("unreachable");
    }],
    ["a counter at zero, though a growth was refused as well", "work", instance => {
      instance.host.refusedGrowths++;
      instance.exports.work.value = 0;
      throw new WebAssembly.RuntimeError("unreachable");
    }],
    ["a counter at zero at an abort", "work", instance => {
      instance.exports.work.value = 0;
      throw new PdfiumAbort("PDFium ran out of work");
    }],
  ])("%s is %s", (_ending, reason, end) => {
    let renderer = standingIn(instance => ({ FPDF_GetPageCount: () => end(instance) }));
    // It is of a page when a page was asked for. A count of the pages asks for none: what ends
    // it is of the whole PDF.
    for (let [call, ofPage] of [
      [() => renderer.countPages(faxPdf()), false], [() => renderer.renderPage(faxPdf()), true],
    ] as const) {
      let error = refusal(call);
      expect(error).toMatchObject({ reason, ofPage });
      expect(error.work).toBeGreaterThan(0);
      expect(error.work).toBeLessThanOrEqual(AT_72.work);
      renderer.expectRestored();
    }
  });

  it("anything else a call throws is passed on as it is, and the instance is put back all the same", () => {
    let thrown = new TypeError("not PDFium's");
    let renderer = standingIn(() => ({
      FPDF_GetPageCount: () => {
        throw thrown;
      },
    }));
    expect(() => renderer.countPages(faxPdf())).toThrow(thrown);
    renderer.expectRestored();
  });

  it.each<[string, RenderRefusalReason, (instance: PdfiumInstance) => Record<string, (...args: number[]) => number>]>([
    ["a page PDFium cannot size", "page-size", () => ({ FPDF_GetPageSizeByIndexF: () => 0 })],
    ["a page of no width", "page-size", instance => sized(instance, [0, 64])],
    ["a page of less than no height", "page-size", instance => sized(instance, [96, -64])],
    ["a page whose width is no number", "page-size", instance => sized(instance, [Number.NaN, 64])],
    ["a page whose width has no end", "page-size", instance => sized(instance, [Infinity, 64])],
    ["a page PDFium cannot load", "page-load", () => ({ FPDF_LoadPage: () => 0 })],
    // 3 is what PDFium says of a render that failed.
    ["a render PDFium gives up at its start", "render", () => ({ FPDF_RenderPageBitmap_Start: () => 3 })],
    ["a render PDFium gives up after it was let go on", "render", () => ({ FPDF_RenderPage_Continue: () => 3 })],
    ["a strip PDFium cannot make", "memory", () => ({ FPDFBitmap_CreateEx: () => 0 })],
  ])("%s is %s, of its page", (_page, reason, exports) => {
    let renderer = standingIn(exports);
    expect(refusal(() => renderer.renderPage(faxPdf()))).toMatchObject({ reason, ofPage: true });
    // Its pages are counted all the same.
    expect(renderer.countPages(faxPdf())).toBe(1);
    renderer.expectRestored();
  });
});

describe("lifetime", () => {
  it("one instance is made however many calls and holds, and every kind of exit leaves it as the first call did", { timeout: 30_000 }, () => {
    let renderer = watched();
    let alone = watched().renderPage(faxPdf()).pixels;
    expect(renderer.instances).toHaveLength(0);
    expect(differing(renderer.renderPage(faxPdf()).pixels, alone)).toBe(0);
    // The copy every later call is held to is taken here, after the first.
    let instance = renderer.instances[0]!;
    let first = resting(instance);
    expect(first.image.length).toBeGreaterThan(MIB);
    expect(first.image.length).toBeLessThan(START_BYTES);
    expect(renderer.memory().length).toBe(START_BYTES);
    // It is what any renderer's instance is after its first call.
    expect(Buffer.compare(first.image, atRest().image)).toBe(0);
    expect(first.tableLength).toBe(atRest().tableLength);
    let notPdf = new TextEncoder().encode("not a PDF at all");
    let oversized = { ...bitsImage(), dict: bitsImage().dict.replace("/Width 96 /Height 64", "/Width 65535 /Height 65535") };
    let exits: [string, () => unknown, RenderRefusalReason?][] = [
      ["a render", () => renderer.renderPage(jpxPdf())],
      ["a count", () => renderer.countPages(jbig2Pdf())],
      ["a turned page", () => renderer.renderPage(scannedPdf([{ ...onePage(faxImage()), rotate: 90 }]))],
      ["a blank page", () => renderer.renderPage(drawnPdf(""))],
      ["unreadable", () => renderer.countPages(notPdf), "unreadable"],
      ["a page past the last", () => expect(() => renderer.renderPage(faxPdf(), 1)).toThrow(RangeError)],
      ["image-pixels", () => renderer.renderPage(scannedPdf([onePage(oversized)])), "image-pixels"],
      ["memory", () => renderer.renderPage(drawnPdf(strokes(64 * MIB))), "memory"],
      ["work", () => renderer.renderPage(blendedFills(500)), "work"],
    ];
    for (let [exit, run, reason] of exits) {
      if (reason) expect(refusal(run).reason, exit).toBe(reason);
      else run();
      expectResting(instance, first);
      // The next render is the one a renderer of its own makes.
      expect(differing(renderer.renderPage(faxPdf()).pixels, alone), exit).toBe(0);
      expectResting(instance, first);
    }
    expect(renderer.instances).toEqual([instance]);
    expect(instance.host).toMatchObject({ fileCalls: 0, aborted: false });
  });

  it("an instance that cannot be made ready is not made again: every call is start, with its cause", () => {
    let made = 0;
    let trap = new WebAssembly.RuntimeError("unreachable");
    let renderer = pdfRenderer(MODULES, AT_72, (module, maxBytes) => {
      made++;
      // The library's start traps: the instance exists and is not ready.
      return replacing(instantiatePdfium(module, maxBytes), {
        FPDF_InitLibraryWithConfig: () => {
          throw trap;
        },
      });
    });
    let errors: RenderRefusal[] = [];
    for (let call of [
      (hold: RenderHold) => hold.countPages(), (hold: RenderHold) => hold.renderPage(0, IN_TWO),
      (hold: RenderHold) => hold.countPages(),
    ]) {
      let hold = holding(renderer, faxPdf());
      errors.push(refusal(() => call(hold)));
      hold.release();
    }
    expect(errors.map(error => error.reason)).toEqual(["start", "start", "start"]);
    expect(errors.every(error => error.cause === trap)).toBe(true);
    expect(errors.map(error => error.ofPage)).toEqual([false, false, false]);
    expect(made).toBe(1);
  });
});

describe("the file system the build is not given", () => {
  it("is asked for a font the file names and does not embed, is refused, and the page is drawn with one of the build's own", () => {
    let renderer = watched();
    expect(differing(renderer.renderPage(faxPdf()).pixels, PATTERN_MARKS)).toBe(0);
    let instance = renderer.instances[0]!;
    // The control for every count of 0 these tests hold an instance to: this is what raises it.
    expect(instance.host.fileCalls).toBe(0);
    let page = renderer.renderPage(unembeddedFontPdf());
    expect(instance.host.fileCalls).toBeGreaterThan(0);
    expect(page).toMatchObject({ blank: false, images: 0 });
    expect(instance.host.aborted).toBe(false);
    // Nothing of the search is left: the page after it is the page rendered alone.
    let asked = instance.host.fileCalls;
    expect(differing(renderer.renderPage(faxPdf()).pixels, PATTERN_MARKS)).toBe(0);
    expect(instance.host.fileCalls).toBe(asked);
    expectResting(instance, { ...atRest(), fileCalls: asked });
  });
});

describe("isolation", () => {
  it("nothing of a page's pixels is in the memory once its call has returned, or when the next document's ends", () => {
    // 48-byte runs of the JPEG 2000 page's pixels that change value at least six times, each
    // within one row: too many levels in too particular an order to be met by chance.
    let needles: Uint8Array[] = [];
    for (let row of [3, 20, 41, 60]) {
      for (let column of [5, 27, 43]) {
        let run = PATTERN_SHADED.slice(row * PATTERN_WIDTH + column, row * PATTERN_WIDTH + column + 48);
        if (run.reduce((changes, value, i) => changes + (i > 0 && value !== run[i - 1] ? 1 : 0), 0) >= 6) needles.push(run);
      }
    }
    expect(needles.length).toBeGreaterThanOrEqual(6);
    // Putting the instance back begins with its stack pointer: what the memory holds then is
    // what the call left in it.
    let atEnd: number[][] = [];
    let renderer = watched(AT_72, {
      wrap: instance => replacing(instance, {
        _emscripten_stack_restore: stack => {
          atEnd.push(occurrences(new Uint8Array(instance.exports.memory.buffer), needles));
          return instance.exports._emscripten_stack_restore!(stack);
        },
      }),
    });
    expect(differing(renderer.renderPage(jpxPdf()).pixels, PATTERN_SHADED)).toBe(0);
    // The control: the pixels are there to be found when the call ends. Were they not, finding
    // none afterwards would show nothing.
    expect(atEnd).toHaveLength(1);
    expect(atEnd[0]!.every(found => found > 0)).toBe(true);
    expect(occurrences(renderer.memory(), needles)).toEqual(needles.map(() => 0));
    renderer.expectRestored();
    expect(differing(renderer.renderPage(faxPdf()).pixels, PATTERN_MARKS)).toBe(0);
    expect(atEnd).toHaveLength(2);
    expect(atEnd[1]).toEqual(needles.map(() => 0));
    expect(occurrences(renderer.memory(), needles)).toEqual(needles.map(() => 0));
  });

  it("a page whose fax data is cut short, straight after a dense page of another document, is the page rendered alone", () => {
    let truncated = scannedPdf([onePage(faxImage(decoded(FAX_BASE64).subarray(0, 37)))]);
    let alone = watched().renderPage(truncated);
    // What the cut leaves unpainted is where another document's page would show.
    expect(differing(alone.pixels, PATTERN_MARKS)).toBeGreaterThan(0);
    let renderer = watched();
    expect(differing(renderer.renderPage(jpxPdf()).pixels, PATTERN_SHADED)).toBe(0);
    let after = renderer.renderPage(truncated);
    expect(Buffer.compare(after.pixels, alone.pixels)).toBe(0);
    expect([after.width, after.height, after.blank]).toEqual([alone.width, alone.height, alone.blank]);
    renderer.expectRestored();
  });

  it("a page that paints nothing after a dense one is white in every byte", () => {
    let renderer = watched();
    expect(renderer.renderPage(jpxPdf()).blank).toBe(false);
    let page = renderer.renderPage(drawnPdf(""));
    expect(page).toMatchObject({ blank: true, images: 0 });
    expect(page.pixels).toHaveLength(PATTERN_WIDTH * PATTERN_HEIGHT);
    expect(page.pixels.every(value => value === 255)).toBe(true);
  });

  it("the file is read only during a call and only within itself, and what is read is taken from the counter", () => {
    let file = faxPdf();
    let during: { read: number[]; spent: number[]; head: Uint8Array; tail: Uint8Array } | undefined;
    let renderer = watched(AT_72, {
      wrap: instance => replacing(instance, {
        FPDF_GetPageCount: document => {
          let { exports } = instance;
          let read = blockReader(instance);
          let buffer = exports.malloc!(256);
          let bytes = () => new Uint8Array(exports.memory.buffer, buffer, 128).slice();
          let spent: number[] = [];
          let counted = (position: number, size: number) => {
            let before = exports.work.value as number;
            let answer = read(0, position, buffer, size);
            spent.push(before - (exports.work.value as number));
            return answer;
          };
          let whole = [counted(0, 128)];
          let head = bytes();
          whole.push(counted(file.byteLength - 128, 128));
          let tail = bytes();
          // Past the file's end, by a byte and by a position that is no position.
          let answers = [...whole, counted(file.byteLength - 127, 128), counted(-1, 1), counted(file.byteLength, 1)];
          during = { read: answers, spent, head, tail };
          return exports.FPDF_GetPageCount!(document);
        },
      }),
    });
    expect(renderer.countPages(file)).toBe(1);
    expect(during!.read).toEqual([1, 1, 0, 0, 0]);
    // 128 bytes are two units of work, and what is not read costs nothing.
    expect(during!.spent).toEqual([2, 2, 0, 0, 0]);
    expect(Buffer.compare(during!.head, file.subarray(0, 128))).toBe(0);
    expect(Buffer.compare(during!.tail, file.subarray(file.byteLength - 128))).toBe(0);
    // Between calls there is no file to read, though the hold that had it is gone or not.
    let instance = renderer.instances[0]!;
    let hold = holding(renderer.renderer, file);
    expect(blockReader(instance)(0, 0, 4096, 16)).toBe(0);
    expect(hold.countPages()).toBe(1);
    expect(blockReader(instance)(0, 0, 4096, 16)).toBe(0);
    hold.release();
    renderer.expectRestored();
  });

  it("a band's pixels are a copy: neither the hold's memory nor the instance's", () => {
    let renderer = watched();
    let hold = holding(renderer.renderer, jpxPdf());
    let page = hold.renderPage(0, IN_TWO);
    for (let band of page.bands) {
      expect(band.pixels!.buffer).not.toBe(hold.file.buffer);
      expect(band.pixels!.buffer).not.toBe(renderer.instances[0]!.exports.memory.buffer);
      expect(band.pixels!.buffer.byteLength).toBe(band.rows * page.width);
    }
    hold.release();
  });
});

describe("holds", () => {
  it("a hold is charged 16,000 bytes, its file and a page's pixels, in one buffer of its own", () => {
    let exact = pdfRenderer(MODULES, { ...RENDER_LIMITS, heldBytes: charge(1000) });
    let hold = exact.hold(1000);
    expect(hold.file.byteLength).toBe(1000);
    expect(hold.file.buffer.byteLength).toBe(charge(1000));
    expect((hold.file.buffer as ArrayBuffer).maxByteLength).toBe(charge(1000));
    expect(hold.file.every(value => value === 0)).toBe(true);
    expect(refusal(() => pdfRenderer(MODULES, { ...RENDER_LIMITS, heldBytes: charge(1000) - 1 }).hold(1000)))
      .toMatchObject({ reason: "room", ofPage: false, heapBytes: 0, work: 0 });
    expect(charge(RENDER_LIMITS.fileBytes)).toBe(19_793_216);
  });

  it("what does not fit is room, and a PDF at the limit leaves room for one of 0.5 MiB", () => {
    let own = pdfRenderer(MODULES, RENDER_LIMITS);
    own.hold(RENDER_LIMITS.fileBytes);
    expect(refusal(() => own.hold(RENDER_LIMITS.fileBytes)).reason).toBe("room");
    own.hold(MIB / 2);
    expect(refusal(() => own.hold(MIB / 2)).reason).toBe("room");
    // With nothing else held, seven fit.
    let alone = pdfRenderer(MODULES, RENDER_LIMITS);
    for (let n = 0; n < 7; n++) alone.hold(MIB / 2);
    expect(refusal(() => alone.hold(MIB / 2)).reason).toBe("room");
  });

  it("releasing twice gives back once", () => {
    let two = pdfRenderer(MODULES, { ...RENDER_LIMITS, heldBytes: 2 * charge(1000) });
    let first = two.hold(1000);
    two.hold(1000);
    expect(refusal(() => two.hold(1000)).reason).toBe("room");
    first.release();
    first.release();
    two.hold(1000);
    expect(refusal(() => two.hold(1000)).reason).toBe("room");
  });

  it("after release the file is empty and a call is released, and a page rendered before it is as it was", () => {
    let own = pdfRenderer(MODULES, RENDER_LIMITS);
    let hold = holding(own, faxPdf());
    let file = hold.file;
    let page = drawn(hold.renderPage(0, IN_TWO));
    let before = page.pixels.slice();
    expect(before).toHaveLength(200 * 133);
    hold.release();
    expect(file.byteLength).toBe(0);
    expect(hold.file.byteLength).toBe(0);
    expect(differing(page.pixels, before)).toBe(0);
    for (let call of [() => hold.countPages(), () => hold.renderPage(0, IN_TWO)]) {
      expect(refusal(call)).toMatchObject({ reason: "released", ofPage: false });
    }
    // Nothing more is put in it.
    expect(refusal(() => hold.fill(faxPdf(), 0))).toMatchObject({ reason: "released", ofPage: false });
  });

  it("says when it is released and by what, once", () => {
    let clock = 0;
    let aged = pdfRenderer(MODULES, RENDER_LIMITS, undefined, () => clock);
    let said: string[] = [];
    let disposed = aged.hold(1000, by => said.push(`the first: ${by}`));
    let idle = aged.hold(RENDER_LIMITS.fileBytes, by => said.push(`the second: ${by}`));
    expect(said).toEqual([]);
    disposed.release();
    expect(said).toEqual(["the first: disposed"]);
    clock = HOLD_IDLE_MS + 1;
    aged.hold(RENDER_LIMITS.fileBytes);
    expect(said).toEqual(["the first: disposed", "the second: idle"]);
    // Letting go of what was taken back, or of anything twice, says nothing more.
    idle.release();
    disposed.release();
    expect(said).toEqual(["the first: disposed", "the second: idle"]);
  });

  it("is filled a piece at a time, and takes nothing past its size", () => {
    let pdf = faxPdf();
    let hold = pdfRenderer(MODULES, AT_72).hold(pdf.byteLength);
    for (let at = 0; at < pdf.byteLength; at += 100) hold.fill(pdf.subarray(at, at + 100), at);
    expect(Buffer.compare(hold.file, pdf)).toBe(0);
    expect(hold.countPages()).toBe(1);
    for (let fill of [() => hold.fill(Uint8Array.of(0), pdf.byteLength), () => hold.fill(pdf, 1)]) {
      expect(refusal(fill)).toMatchObject({ reason: "size-mismatch", ofPage: false, heapBytes: 0, work: 0 });
    }
    // What was refused is not in it.
    expect(Buffer.compare(hold.file, pdf)).toBe(0);
    hold.release();
  });

  it("two holds' files do not share a buffer", () => {
    let own = pdfRenderer(MODULES, RENDER_LIMITS);
    let first = own.hold(1000), second = own.hold(1000);
    expect(first.file.buffer).not.toBe(second.file.buffer);
    first.file.fill(7);
    expect(second.file.every(value => value === 0)).toBe(true);
    first.release();
    expect(second.file.byteLength).toBe(1000);
  });

  it("a page's bands are as they were once the hold has drawn the next page over it", () => {
    let white = greyImage(new Uint8Array(PATTERN_WIDTH * PATTERN_HEIGHT).fill(255), PATTERN_WIDTH, PATTERN_HEIGHT);
    let own = pdfRenderer(MODULES, AT_72);
    let hold = holding(own, scannedPdf([onePage(bitsImage()), onePage(white)]));
    let first = hold.renderPage(0, IN_TWO);
    expect(differing(drawn(first).pixels, PATTERN_MARKS)).toBe(0);
    let second = hold.renderPage(1, IN_TWO);
    expect(second).toMatchObject({ blank: true, bands: [{ top: 0, rows: PATTERN_HEIGHT, ink: 0 }] });
    expect(second.bands[0]!.pixels).toBeUndefined();
    expect(differing(drawn(first).pixels, PATTERN_MARKS)).toBe(0);
    hold.release();
  });

  it("a hold idle for 120 s keeps its room, and bytes put in it begin the count again", () => {
    let clock = 0;
    let aged = pdfRenderer(MODULES, RENDER_LIMITS, undefined, () => clock);
    let first = aged.hold(RENDER_LIMITS.fileBytes);
    let file = first.file;
    let asked = () => refusal(() => aged.hold(RENDER_LIMITS.fileBytes)).reason;
    clock = 119_000;
    expect(asked()).toBe("room");
    first.fill(Uint8Array.of(0), 0);
    // 111 s after the bytes, 230 s after it was taken.
    clock = 230_000;
    expect(asked()).toBe("room");
    clock = 119_000 + HOLD_IDLE_MS;
    expect(asked()).toBe("room");
    expect(file.byteLength).toBe(RENDER_LIMITS.fileBytes);
    // Past that, it is taken back when its room is asked for.
    clock = 119_000 + HOLD_IDLE_MS + 1;
    expect(aged.hold(RENDER_LIMITS.fileBytes).file).toHaveLength(RENDER_LIMITS.fileBytes);
    expect(file.byteLength).toBe(0);
    expect(refusal(() => first.countPages())).toMatchObject({ reason: "released", ofPage: false });
  });

  it("a hold idle for over 120 s is taken back when its room is asked for, and not when there is room without it", () => {
    let clock = 0;
    let aged = pdfRenderer(MODULES, RENDER_LIMITS, undefined, () => clock);
    let large = aged.hold(8 * MIB);
    let small = aged.hold(1000);
    clock = HOLD_IDLE_MS + 1;
    small.fill(Uint8Array.of(0), 0);
    // There is room for this one beside both, so neither is taken back.
    aged.hold(1000);
    expect(large.file.byteLength).toBe(8 * MIB);
    // This one needs the room the idle hold has; the one that was being filled keeps its own.
    aged.hold(8 * MIB);
    expect(large.file.byteLength).toBe(0);
    expect(small.file.byteLength).toBe(1000);
  });

  it("no idle hold is taken back for a PDF that has no room without them either", () => {
    let clock = 0;
    let aged = pdfRenderer(MODULES, RENDER_LIMITS, undefined, () => clock);
    let said: string[] = [];
    let idle = aged.hold(MIB, by => said.push(by));
    clock = HOLD_IDLE_MS + 1;
    let active = aged.hold(RENDER_LIMITS.fileBytes);
    // Two PDFs at the limit are more than is held, whatever else is given back.
    expect(refusal(() => aged.hold(RENDER_LIMITS.fileBytes)).reason).toBe("room");
    expect(idle.file.byteLength).toBe(MIB);
    expect(said).toEqual([]);
    // It is taken back for one that its room is enough for.
    active.release();
    aged.hold(RENDER_LIMITS.fileBytes);
    aged.hold(MIB);
    expect(idle.file.byteLength).toBe(0);
    expect(said).toEqual(["idle"]);
  });

  it("of several idle holds, the longest idle are taken back, and no more than make the room", () => {
    let clock = 0;
    let aged = pdfRenderer(MODULES, { ...RENDER_LIMITS, heldBytes: 4 * charge(1000) }, undefined, () => clock);
    let holds = [0, 1, 2, 3].map(taken => {
      clock = taken;
      return aged.hold(1000);
    });
    let open = () => holds.map(hold => hold.file.byteLength === 1000);
    // The first had bytes put in it last, so it has been idle the shortest.
    clock = 4;
    holds[0]!.fill(Uint8Array.of(0), 0);
    clock = HOLD_IDLE_MS + 5;
    aged.hold(1000);
    expect(open()).toEqual([true, false, true, true]);
    // Room for two is the room of the two idle longest of those left: the one just taken is not idle.
    aged.hold(1000 + charge(1000));
    expect(open()).toEqual([true, false, false, false]);
    expect(refusal(() => aged.hold(1000 + charge(1000))).reason).toBe("room");
    expect(open()).toEqual([true, false, false, false]);
  });

  it("a call begins the count again as bytes do", () => {
    let clock = 0;
    let aged = pdfRenderer(MODULES, { ...AT_72, heldBytes: charge(faxPdf().byteLength) }, undefined, () => clock);
    let hold = holding(aged, faxPdf());
    let asked = () => refusal(() => aged.hold(1000)).reason;
    clock = 119_000;
    expect(hold.countPages()).toBe(1);
    clock = 119_000 + HOLD_IDLE_MS;
    expect(asked()).toBe("room");
    expect(hold.renderPage(0, IN_TWO).blank).toBe(false);
    clock = 119_000 + 2 * HOLD_IDLE_MS;
    expect(asked()).toBe("room");
    hold.release();
  });
});

describe("cutRows", () => {
  it("cuts at clear rows within reach of the even cut, and at none beyond it", () => {
    // Two clear rows in reach, and two nearer the top that are not.
    expect(cutRows(inked(row => row === 46 || row === 47 || row === 30 || row === 31 ? 0 : 5), 2, 10)).toEqual([0, 47, 100]);
    expect(cutRows(inked(row => row === 30 || row === 31 ? 0 : 5), 2, 10)).toEqual([0, 50, 100]);
    // The reach is 6% of the height either side: rows 44 to 56.
    expect(cutRows(inked(row => row === 42 || row === 43 ? 0 : 5), 2, 10)).toEqual([0, 44, 100]);
    expect(cutRows(inked(row => row === 56 || row === 57 ? 0 : 5), 2, 10)).toEqual([0, 56, 100]);
  });

  it("cuts a table between two rows of text, not at a rule", () => {
    // A rule every five rows, at the even cut among them, and text between the rules.
    expect(cutRows(inked(row => row % 5 === 0 ? 200 : 30), 2, 10)).toEqual([0, 49, 100]);
  });

  it("cuts at the least inked pair of rows when no row is clear", () => {
    expect(cutRows(inked(row => 100 + row), 2, 10)).toEqual([0, 44, 100]);
    expect(cutRows(inked(row => 300 - row), 2, 10)).toEqual([0, 56, 100]);
  });

  it("cuts a page into no more bands than it has the rows for, and leaves a short page as one", () => {
    expect(cutRows(clear(19), 2, 10)).toEqual([0, 19]);
    expect(cutRows(clear(20), 2, 10)).toEqual([0, 10, 20]);
    expect(cutRows(clear(25), 4, 10)).toEqual([0, 13, 25]);
    expect(cutRows(clear(799), RENDER_LIMITS.bands, RENDER_LIMITS.bandRows)).toEqual([0, 799]);
    expect(cutRows(clear(825), RENDER_LIMITS.bands, RENDER_LIMITS.bandRows)).toEqual([0, 413, 825]);
    expect(cutRows([], 2, 10)).toEqual([0, 0]);
  });

  it("makes a band shorter than the rows a page has to have for each, when a cut moves that way", () => {
    // 825 rows are two bands of 400 and more; the one clear pair of rows in reach ends at row 364.
    let ink = Array.from({ length: 825 }, (_, row) => row === 363 || row === 364 ? 0 : 5);
    expect(cutRows(ink, RENDER_LIMITS.bands, RENDER_LIMITS.bandRows)).toEqual([0, 364, 825]);
  });

  it("of rows that tie, cuts at the nearest to the even cut", () => {
    expect(cutRows(inked(() => 0), 2, 10)).toEqual([0, 50, 100]);
    expect(cutRows(inked(() => 7), 4, 10)).toEqual([0, 25, 50, 75, 100]);
    // Clear pairs at 47 and at 52: the nearer wins, and of two as near, the upper.
    expect(cutRows(inked(row => [46, 47, 51, 52].includes(row) ? 0 : 5), 2, 10)).toEqual([0, 52, 100]);
    expect(cutRows(inked(row => [47, 48, 51, 52].includes(row) ? 0 : 5), 2, 10)).toEqual([0, 48, 100]);
  });

  it("leaves out a cut that is barred at its row, and makes the others where they fall", () => {
    let asked: number[] = [];
    let barred = (row: number) => {
      asked.push(row);
      return row === 50;
    };
    expect(cutRows(inked(() => 7), 4, 10, barred)).toEqual([0, 25, 75, 100]);
    // Only the row each cut would be made at is asked about.
    expect(asked).toEqual([25, 50, 75]);
    expect(cutRows(inked(() => 7), 2, 10, () => true)).toEqual([0, 100]);
  });

  it("reads a typed array of ink as it does a plain one", () => {
    let ink = Uint32Array.from(inked(row => row === 53 || row === 54 ? 0 : 0xffffff));
    expect(cutRows(ink, 2, 10)).toEqual([0, 54, 100]);
  });
});

/** A page of `count` lines of writing as its rows' ink: six rows with `ink` on them, then four with none. */
function linesOf(count: number, ink = 100): number[] {
  return Array.from({ length: count * 10 }, (_, row) => row % 10 < 6 ? ink : 0);
}

/** Forty lines of writing on rows that all hold ink, but for the rows in `bare`, which hold none. */
function inkedThrough(bare: number[]): number[] {
  return Array.from({ length: 400 }, (_, row) => bare.includes(row) ? 0 : 100 + (row % 10 < 6 ? 100 : 0));
}

describe("cutDense", () => {
  it("cuts a band that holds more lines than asked, at the clear rows nearest its middle, and no band twice", () => {
    // Two bands of twenty lines each.
    expect(cutDense([0, 200, 400], linesOf(40), 20, 8)).toEqual([0, 200, 400]);
    expect(cutDense([0, 200, 400], linesOf(40), 19, 8)).toEqual([0, 99, 200, 299, 400]);
    // A band far over the count is cut once all the same.
    expect(cutDense([0, 400], linesOf(40), 1, 8)).toEqual([0, 199, 400]);
    // Only the band that is over is cut: fifteen lines, then twenty-five.
    expect(cutDense([0, 150, 400], linesOf(40), 20, 8)).toEqual([0, 150, 277, 400]);
  });

  it("cuts no band once the page has as many bands as it may", () => {
    expect(cutDense([0, 200, 400], linesOf(40), 1, 4)).toEqual([0, 99, 200, 299, 400]);
    expect(cutDense([0, 200, 400], linesOf(40), 1, 3)).toEqual([0, 99, 200, 400]);
    expect(cutDense([0, 200, 400], linesOf(40), 1, 2)).toEqual([0, 200, 400]);
  });

  it("takes a rule, and the grain every row of a scan has, for no line", () => {
    // Rules two rows thick, ten rows apart, and nothing else.
    let ruled = Array.from({ length: 400 }, (_, row) => row % 10 < 2 ? 1000 : 0);
    expect(cutDense([0, 400], ruled, 0, 8)).toEqual([0, 400]);
    // The same lines of writing on rows that all hold some ink, one more than another: forty
    // lines still, and no more.
    let grainy = linesOf(40, 1000).map((ink, row) => ink + 40 + (row % 5) * 5);
    expect(cutDense([0, 400], grainy, 40, 8)).toEqual([0, 400]);
    // The cut is at the two rows between lines that hold the least of it.
    expect(cutDense([0, 400], grainy, 39, 8)).toEqual([0, 197, 400]);
    // Rows that are all alike hold no writing.
    expect(cutDense([0, 400], Array.from({ length: 400 }, () => 500), 0, 8)).toEqual([0, 400]);
    expect(cutDense([0, 0], [], 0, 8)).toEqual([0, 0]);
  });

  it("cuts within reach of the band's middle, and not where a cut is barred", () => {
    // The reach is 6% of the page's height either side: rows 176 to 224 of 400. One clear pair
    // of rows is in it, and one nearer the band's top is not: without the first, the cut is
    // between the two lines nearest the middle.
    expect(cutDense([0, 400], inkedThrough([219, 220, 100, 101]), 1, 8)).toEqual([0, 220, 400]);
    expect(cutDense([0, 400], inkedThrough([100, 101]), 1, 8)).toEqual([0, 199, 400]);
    let asked: number[] = [];
    let barred = (row: number) => {
      asked.push(row);
      return row === 99;
    };
    expect(cutDense([0, 200, 400], linesOf(40), 1, 8, barred)).toEqual([0, 200, 299, 400]);
    expect(asked).toEqual([99, 299]);
  });

  it("reads a typed array of ink as it does a plain one", () => {
    expect(cutDense([0, 400], Uint32Array.from(linesOf(40)), 1, 8)).toEqual([0, 199, 400]);
  });
});

/** The side of the square pages {@link partsColumns} is tried on: a strip is 3 pixels across and runs 10 rows each way. */
const SIDE = 200;
/** A cut on those pages: rows 97 and 98 are between two lines of {@link lines}. */
const CUT = 98;

/** Writes `level` on a page from pixel `from` up to `to`, in rows `top` up to `bottom`. */
type Fill = (from: number, to: number, top: number, bottom: number, level?: number) => void;

/**
 * A page of `SIDE` x `SIDE` pixels at `ground`, for `paint` to write on: black on a light ground
 * and white on a dark one, unless a level is given.
 */
function sheet(paint: (fill: Fill) => void, ground = 255): Uint8Array {
  let pixels = new Uint8Array(SIDE * SIDE).fill(ground);
  paint((from, to, top, bottom, level = ground < 128 ? 255 : 0) => {
    for (let row = top; row < bottom; row++) pixels.fill(level, row * SIDE + from, row * SIDE + to);
  });
  return pixels;
}

/** Lines of writing across pixels `from` up to `to`, in rows `top` up to `bottom`: six rows written, then four not. */
function lines(fill: Fill, from: number, to: number, top = 10, bottom = 190, level?: number): void {
  for (let row = top; row + 6 <= bottom; row += 10) fill(from, to, row, row + 6, level);
}

/** Whether a cut above `row` of one of those pages would part its columns. */
function parts(pixels: Uint8Array, row = CUT): boolean {
  return partsColumns(pixels, SIDE, SIDE, row);
}

/**
 * Two columns of writing down a page at `ground`, `gap` pixels apart, the right one at `level`,
 * with whatever `more` adds.
 */
function twoColumns(options: { ground?: number; gap?: number; level?: number; more?: (fill: Fill) => void } = {}): Uint8Array {
  let { gap = 20 } = options;
  return sheet(fill => {
    lines(fill, 20, 100 - gap / 2);
    lines(fill, 100 + gap / 2, 180, 10, 190, options.level);
    options.more?.(fill);
  }, options.ground);
}

/**
 * A paragraph with two stamps right of it, one above the other and each `across` pixels wide:
 * the paragraph ends short of them, so a strip of the ground runs down between, and there is
 * writing beside it above the cut and below it.
 */
function stampedPage(across: number): Uint8Array {
  return sheet(fill => {
    lines(fill, 20, 110);
    fill(140, 140 + across, 60, 95);
    fill(140, 140 + across, 105, 150);
  });
}

/** Three columns of short lines, as a table's are, with a rule across them under each line when `ruled`. */
function tablePage(ruled: boolean): Uint8Array {
  return sheet(fill => {
    for (let [from, to] of [[20, 60], [80, 120], [140, 180]] as const) lines(fill, from, to);
    if (ruled) for (let row = 7; row < 190; row += 10) fill(20, 180, row, row + 1);
  });
}

describe("partsColumns", () => {
  it("is so between the lines of two columns, and not between those of one", () => {
    expect(parts(twoColumns())).toBe(true);
    expect(parts(sheet(fill => lines(fill, 20, 180)))).toBe(false);
    expect(parts(sheet(() => undefined))).toBe(false);
  });

  it("is so whatever the page's writing stands on", () => {
    expect(parts(twoColumns({ ground: 0 }))).toBe(true);
    expect(parts(twoColumns({ ground: 110 }))).toBe(true);
    // What is no more than a quarter of the range from the ground is its grain, and no writing.
    expect(parts(twoColumns({ level: 255 - 64 }))).toBe(false);
    expect(parts(twoColumns({ level: 255 - 65 }))).toBe(true);
  });

  it("is so only where the column on the right has writing above the cut and the one on the left below it", () => {
    // The right column ends far above the cut: read with the cut's upper band, it would come
    // before the rest of the left one.
    expect(parts(sheet(fill => {
      lines(fill, 20, 90);
      lines(fill, 110, 180, 10, 50);
    }))).toBe(true);
    // The right column begins below the cut, or the left one ends above it: band by band is
    // the order the columns are read in.
    expect(parts(sheet(fill => {
      lines(fill, 20, 90);
      lines(fill, 110, 180, 110, 190);
    }))).toBe(false);
    expect(parts(sheet(fill => {
      lines(fill, 20, 90, 10, 90);
      lines(fill, 110, 180);
    }))).toBe(false);
  });

  it("is not so where the space between the columns runs under ten rows above the cut, or below it", () => {
    // A line across the page ends the space between the columns.
    let crossed = (top: number) => twoColumns({ more: fill => fill(20, 180, top, top + 2) });
    expect(parts(crossed(86))).toBe(true);
    expect(parts(crossed(87))).toBe(false);
    expect(parts(crossed(108))).toBe(true);
    expect(parts(crossed(107))).toBe(false);
    // A page with fewer rows than that above the cut, or below it, has none.
    expect(parts(twoColumns(), 8)).toBe(false);
    expect(parts(twoColumns(), 198)).toBe(false);
  });

  it("is not so in a table drawn with rules, and is in one drawn without", () => {
    expect(parts(tablePage(true))).toBe(false);
    expect(parts(tablePage(false))).toBe(true);
  });

  it("takes a line across the page for the end of the space between two columns, not for writing beside it", () => {
    // A paragraph across the page whose last line reaches lower on the right than on the left,
    // then short lines at the left: one column, with nothing beside what is below the cut.
    expect(parts(sheet(fill => {
      lines(fill, 20, 180, 10, 60);
      fill(20, 100, 60, 66);
      fill(100, 180, 60, 70);
      lines(fill, 20, 60, 80, 190);
    }))).toBe(false);
    // A heading across the page above two columns ends the space between them, and they are columns.
    expect(parts(sheet(fill => {
      fill(20, 180, 10, 30);
      lines(fill, 20, 90, 40, 190);
      lines(fill, 110, 180, 40, 190);
    }))).toBe(true);
  });

  it("looks for no space between columns in the fifth of the page at either side", () => {
    // Notes beside the writing, in the page's margin: the space between them is in it too.
    expect(parts(sheet(fill => {
      lines(fill, 2, 26);
      lines(fill, 36, 180);
    }))).toBe(false);
    // The same notes with the space further in.
    expect(parts(sheet(fill => {
      lines(fill, 2, 26);
      lines(fill, 60, 180);
    }))).toBe(true);
  });

  it("takes writing under a tenth of the page across for no column", () => {
    // Line numbers left of the writing, and something as narrow right of it.
    let beside = (numbers: number, marks: number) => sheet(fill => {
      lines(fill, 45 - numbers, 45);
      lines(fill, 60, 140);
      lines(fill, 155, 155 + marks);
    });
    expect(parts(beside(19, 19))).toBe(false);
    expect(parts(beside(20, 19))).toBe(true);
    expect(parts(beside(19, 20))).toBe(true);
    // A shadow down the page's right edge and a hole punched in its left margin.
    expect(parts(sheet(fill => {
      lines(fill, 60, 140);
      fill(190, 199, 0, SIDE);
      fill(4, 16, 100, 120);
    }))).toBe(false);
  });

  it("takes blocks that stand beside a paragraph, a tenth of the page across, for a column", () => {
    // Nothing in the pixels tells them from a second column: the page is cut into fewer bands.
    expect(parts(stampedPage(20))).toBe(true);
    expect(parts(stampedPage(19))).toBe(false);
  });

  it("is not so where the space between two columns is under three pixels across", () => {
    expect(parts(twoColumns({ gap: 4 }))).toBe(true);
    expect(parts(twoColumns({ gap: 2 }))).toBe(false);
  });
});

describe("the loader", () => {
  it("refuses and counts a growth past the cap, and grows within it by what was asked", () => {
    let { exports, host } = instantiatePdfium(MODULES.pdfium, 64 * MIB);
    expect(exports.memory.buffer.byteLength).toBe(START_BYTES);
    // The first takes what the instance has free and grows for the rest; the second has to grow
    // for all of itself, and Emscripten's own way of growing would take a fifth more on spec.
    expect(exports.malloc!(20 * MIB)).not.toBe(0);
    let before = exports.memory.buffer.byteLength;
    expect(before).toBeLessThanOrEqual(START_BYTES + 20 * MIB);
    expect(exports.malloc!(30 * MIB)).not.toBe(0);
    let grown = exports.memory.buffer.byteLength - before;
    expect(grown).toBeGreaterThanOrEqual(30 * MIB);
    expect(grown).toBeLessThanOrEqual(30 * MIB + 2 * 65_536);
    expect(host.refusedGrowths).toBe(0);
    let size = exports.memory.buffer.byteLength;
    expect(exports.malloc!(64 * MIB)).toBe(0);
    expect(host.refusedGrowths).toBeGreaterThan(0);
    expect(exports.memory.buffer.byteLength).toBe(size);
    expect(host).toMatchObject({ aborted: false, fileCalls: 0 });
  });

  it("throws PdfiumAbort when the build ends itself", () => {
    let { exports, host } = instantiatePdfium(MODULES.pdfium, START_BYTES);
    // With every byte it may have taken, the build cannot make a document and calls abort().
    for (let size of [MIB, 65_536, 1024, 16]) {
      while (exports.malloc!(size) !== 0) { /* until none of that size is left */ }
    }
    expect(host.aborted).toBe(false);
    expect(() => exports.FPDF_CreateNewDocument!()).toThrow(PdfiumAbort);
    expect(host.aborted).toBe(true);
    expect(exports.memory.buffer.byteLength).toBe(START_BYTES);
  });

  it("takes the bytes it moves for the build from the counter before it moves them", () => {
    let { exports } = instantiatePdfium(MODULES.pdfium, 64 * MIB);
    // A block that cannot grow where it is, so that making it larger copies it: the build has
    // its host copy anything of this size.
    let moved = () => {
      let block = exports.malloc!(MIB);
      exports.malloc!(16);
      new Uint8Array(exports.memory.buffer, block, MIB).fill(7);
      return block;
    };
    let first = moved();
    exports.work.value = 1_000_000;
    let larger = exports.realloc!(first, 4 * MIB);
    expect(larger).not.toBe(first);
    expect(new Uint8Array(exports.memory.buffer, larger, MIB).every(value => value === 7)).toBe(true);
    let used = 1_000_000 - (exports.work.value as number);
    // One for every 64 bytes, and a few for the functions that were entered.
    expect(used).toBeGreaterThanOrEqual(MIB / 64);
    expect(used).toBeLessThan(MIB / 64 + 100);
    let second = moved();
    exports.work.value = 1000;
    expect(() => exports.realloc!(second, 4 * MIB)).toThrow(PdfiumAbort);
    expect(exports.work.value).toBe(0);
  });

  it("spend() takes one from the counter for every 64 bytes, and past what is left throws and leaves it at 0", () => {
    let { exports, spend } = instantiatePdfium(MODULES.pdfium, START_BYTES);
    exports.work.value = 10;
    spend(5 * 64);
    expect(exports.work.value).toBe(5);
    spend(1);
    expect(exports.work.value).toBe(4);
    spend(0);
    expect(exports.work.value).toBe(4);
    expect(() => spend(4 * 64)).toThrow(PdfiumAbort);
    expect(exports.work.value).toBe(0);
    exports.work.value = 3;
    expect(() => spend(1000 * 64)).toThrow(PdfiumAbort);
    expect(exports.work.value).toBe(0);
  });
});
