// Renders one page of a PDF to grey pixels with PDFium, cut into bands. Every call is synchronous
// and whole: the document is opened, one page of it rendered and copied out, and the instance's
// memory put back to what it was before the document, all before the call returns. So one PDFium
// instance serves every document in the isolate, one call at a time, and holds nothing of any of
// them between calls. What a call may cost is a count the build keeps itself: it is ended when it
// has passed the start of a function or of a loop more times than it was given.

import {
  HOLD_IDLE_MS, RENDER_LIMITS, type RenderedBand, type RenderedPage, type RenderLimits, type RenderOptions,
  type RenderRefusalReason,
} from "./api";
import { instantiatePdfium, PdfiumAbort, type PdfiumInstance } from "./pdfium-loader";
import type { PdfiumModules } from "./pdfium-module";

const FPDF_ERR_PASSWORD = 4;
const FPDFBITMAP_GRAY = 1;
const FPDF_PAGEOBJ_IMAGE = 3;
const FPDF_PAGEOBJ_FORM = 5;
/**
 * The render flag that draws annotations with the page: a stamp, writing in ink and a note typed
 * onto the page are on the page as a reader shows it, and are no part of its content stream. A
 * form's fields are annotations too, and are drawn by PDFium's form layer, after the page.
 */
const FPDF_ANNOT = 0x01;
/** The version of FPDF_FORMFILLINFO that names no callback of an XFA form. */
const FORM_INFO_VERSION = 1;
/** Bytes enough for an FPDF_FORMFILLINFO of either version, every callback of which is left null. */
const FORM_INFO_BYTES = 256;
const FPDF_RENDER_TOBECONTINUED = 1;
const FPDF_RENDER_DONE = 2;
/** How far from where an even cut would fall a cut may move, as a share of the page's height. */
const CUT_WINDOW = 0.06;
/** The fewest rows on end that hold writing when they are a line of it. */
const LINE_ROWS = 3;
/**
 * How far above the page's least inked row a row's ink has to stand to hold writing, as a share
 * of the way from that row to the page's most inked one.
 */
const LINE_INK = 0.05;
/** How far from the ground a pixel has to be to be writing and not the ground's own grain. */
const WRITING_LEVELS = 64;
/** The narrowest strip of ground taken for the space between two columns, as a share of the page's width. */
const GUTTER_WIDTH = 0.015;
/**
 * How far above a cut, and as far below it, that strip has to run, as a share of the page's
 * height: some three lines of ordinary type each way.
 */
const GUTTER_RUN = 0.05;
/**
 * The share of the page's width at either side in which no such strip is looked for: a margin is
 * not the space between two columns, whatever lies in it.
 */
const GUTTER_MARGIN = 0.2;
/**
 * The least of the page's width that writing beside such a strip is spread over when it is a
 * column: the labels of a chart's axis, line numbers and a punched hole are narrower.
 */
const COLUMN_WIDTH = 0.1;
/** The lowest resolution a page that ran out of memory is tried again at. */
const RETRY_FLOOR_DPI = 72;
/** Work enough for putting the instance back, which is two short calls into it. */
const RESTORE_WORK = 1_000_000;
/** The most the work counter, a signed 32-bit number, can be set to. */
const MAX_WORK = 0x7fffffff;

/**
 * The one instance, ready for a document: the library started, the two callbacks in its function
 * table and the structures that name them allocated, and the memory it had at that moment kept.
 */
type Arena = {
  instance: PdfiumInstance;
  /** The memory's bytes up to the last that was not zero, when the instance was ready. */
  image: Uint8Array;
  /** The stack pointer at that moment. */
  stack: number;
  /** FPDF_FILEACCESS { m_FileLen, m_GetBlock, m_Param }. */
  access: number;
  /** IFSDK_PAUSE { version, NeedToPauseNow, user }. */
  pauser: number;
  /** Sixty-four bytes for what PDFium writes through a pointer. */
  scratch: number;
  /** FPDF_FORMFILLINFO { version, callbacks }: no callback, since a form is only drawn. */
  formInfo: number;
};

/** The reasons that are of the PDF as a whole: after one of them no page of it is rendered. */
const WHOLE_PDF: ReadonlySet<RenderRefusalReason> = new Set([
  "start", "released", "file-size", "size-mismatch", "room", "encrypted", "unreadable", "page-count", "empty-work",
]);

/** A PDF, or a page of it, that was not rendered. Carries a reason word and sizes, no text. */
export class RenderRefusal extends Error {
  /** Why, as a word. */
  readonly reason: RenderRefusalReason;
  /**
   * Whether it is one page that was not rendered, and the PDF's other pages still can be. It is
   * never so when the pages were being counted, whatever the reason.
   */
  ofPage: boolean;
  /** The instance's memory when the render ended, in bytes; 0 when no instance was reached. */
  heapBytes = 0;
  /** The work the call had done when it ended. */
  work = 0;
  /**
   * `cause` is what making the instance ready threw, for `start` alone: it names an import or a
   * memory size, never anything of a document.
   */
  constructor(reason: RenderRefusalReason, cause?: unknown) {
    super(`The PDF could not be rendered (${reason}).`, cause === undefined ? undefined : { cause });
    this.reason = reason;
    this.ofPage = !WHOLE_PDF.has(reason);
  }
}

/** What gave a hold back: whoever had it, or the renderer, for another PDF, after it sat idle. */
export type HoldRelease = "disposed" | "idle";

/**
 * What is held for one PDF while its pages are rendered: the file's bytes and room for one
 * page's pixels, in memory that is given back the moment it is released, and its allowance of
 * work that leaves nothing to send.
 */
export type RenderHold = {
  /** The PDF's bytes as they are held, zero where none have been put. Empty once released. */
  readonly file: Uint8Array;
  /**
   * Puts `piece`, the PDF's next bytes as they arrive, in the file from byte `at`. It counts as
   * a call: a hold that has gone {@link HOLD_IDLE_MS} without either is taken back when another
   * PDF needs its room. Throws a {@link RenderRefusal}: `size-mismatch` for bytes past the
   * file's end, and `released` for a hold that was given back.
   */
  fill(piece: Uint8Array, at: number): void;
  /** How many pages the PDF has, by its page tree. Throws a {@link RenderRefusal}, never one of a page. */
  countPages(): number;
  /**
   * Page `index`, from 0 in the page tree's order, rendered over the page before it and cut as
   * `options` say; each band's pixels are a copy. Throws a {@link RenderRefusal}, and a
   * `RangeError` for a page the PDF does not have or a number of bands that is never cut.
   */
  renderPage(index: number, options: RenderOptions): RenderedPage;
  /** Gives everything back. A second call does nothing. */
  release(): void;
};

/** Renders the pages of PDFs held in memory, one call at a time, holding nothing between calls. */
export type Renderer = {
  /**
   * Room for a PDF of `fileBytes` bytes to be rendered, counted against the limit on what is
   * held. `released` is told what gave the hold back, at the moment it is given back, once.
   * Throws a {@link RenderRefusal} for a size that is never rendered and when there is no room,
   * and whatever making the memory throws when it cannot be had, before anything is counted
   * for it.
   */
  hold(fileBytes: number, released?: (by: HoldRelease) => void): RenderHold;
};

/** What a hold has: its memory, cut three ways, and the work its PDF may still spend on nothing. */
type Held = {
  buffer: ArrayBuffer;
  /** What it is charged against the limit on what is held: the buffer's length until it is released. */
  bytes: number;
  /** Each row's ink, for the page drawn last: how far the row's pixels are from its ground, summed. */
  ink: Uint32Array;
  file: Uint8Array;
  pixels: Uint8Array;
  emptyLeft: number;
  /** When it was last filled or called, by the renderer's clock. */
  touched: number;
  released: boolean;
  release(by: HoldRelease): void;
};

/** Wraps one call into PDFium, so that what it did not finish is a refusal and never a result. */
type Call = <R>(run: () => R) => R;

/** What one try at a page saw of it, for the try that may follow. */
type Seen = {
  /** The resolution of the page's densest image, 0 when it draws none whose size could be read. */
  imageDpi: number;
  /** Whether painting began. */
  painting: boolean;
  /** The work the try took. */
  work: number;
  /** Whether the try is a second one. */
  second: boolean;
};

/**
 * A renderer over `modules`, held to `limits`. It makes one instance with `instantiate` the first
 * time it is called and keeps it; an instance that could not be made ready is not made again.
 * Each call opens the document, does its one thing and returns plain values, and on every way
 * out puts the instance back as it was when it was ready: every byte of its memory zeroed and
 * its first image copied back, its stack pointer put back. An instance is its memory, its
 * globals and its function table, and its code can write only the first two, so that is the
 * instance as it was: nothing of the document, its pages or its pixels is left for the next call
 * to find, whether this one ended, failed, aborted, trapped or ran out of work. No call yields,
 * so no two overlap and nothing else runs while a document is open. `now` is the clock holds
 * are aged by; no render is timed.
 */
export function pdfRenderer(
  modules: PdfiumModules, limits: RenderLimits = RENDER_LIMITS, instantiate = instantiatePdfium,
  now: () => number = () => Date.now(),
): Renderer {
  let arena: Arena | undefined;
  /** Why the instance could not be made ready, once that has happened: it is not tried again. */
  let failed: RenderRefusal | undefined;
  /** Bytes counted against the limit on what is held, and the holds they are counted for. */
  let held = 0;
  let holds = new Set<Held>();
  /** The document PDFium is reading, during a call only. */
  let reading: Uint8Array | undefined;
  /** How many of one row's pixels are at each grey level, while its ink is summed: all zero between rows. */
  let levels = new Uint32Array(256);

  let ready = (): Arena => {
    let instance = instantiate(modules.pdfium, limits.heapBytes);
    let x = instance.exports;
    // PDFium calls back through C function pointers, which are entries of its function table.
    let thunks = new WebAssembly.Instance(modules.thunks, {
      e: {
        // int m_GetBlock(void* param, unsigned long position, unsigned char* buffer, unsigned long size)
        r: (_param: number, position: number, buffer: number, size: number) => {
          position >>>= 0;
          size >>>= 0;
          if (!reading || position + size > reading.byteLength) return 0;
          instance.spend(size);
          new Uint8Array(x.memory.buffer, buffer, size).set(reading.subarray(position, position + size));
          return 1;
        },
        // FPDF_BOOL NeedToPauseNow(IFSDK_PAUSE*): always, so that the steps are counted here.
        p: () => 1,
      },
    }).exports;
    let table = x.__indirect_function_table;
    let first = table.grow(2);
    table.set(first, thunks.r);
    table.set(first + 1, thunks.p);
    // FPDF_LIBRARY_CONFIG, version 2, all else zero: no font paths, no V8, Brotli left off.
    let config = x.calloc!(1, 32);
    new Int32Array(x.memory.buffer, config, 1)[0] = 2;
    x.FPDF_InitLibraryWithConfig!(config);
    x.free!(config);
    let access = x.calloc!(1, 12);
    new Uint32Array(x.memory.buffer, access, 3).set([0, first, 0]);
    let pauser = x.calloc!(1, 12);
    new Int32Array(x.memory.buffer, pauser, 3).set([1, first + 1, 0]);
    let scratch = x.calloc!(1, 64);
    let formInfo = x.calloc!(1, FORM_INFO_BYTES);
    new Int32Array(x.memory.buffer, formInfo, 1)[0] = FORM_INFO_VERSION;
    let memory = new Uint8Array(x.memory.buffer);
    let last = memory.length;
    while (last > 0 && memory[last - 1] === 0) last--;
    return { instance, image: memory.slice(0, last), stack: x.emscripten_stack_get_current!(), access, pauser, scratch, formInfo,
    };
  };

  let restore = (own: Arena): void => {
    let x = own.instance.exports;
    x.work.value = RESTORE_WORK;
    x._emscripten_stack_restore!(own.stack);
    x._emscripten_tempret_set!(0);
    let memory = new Uint8Array(x.memory.buffer);
    memory.fill(0, own.image.length);
    memory.set(own.image);
    own.instance.host.aborted = false;
  };

  /**
   * Runs `use` with `hold`'s PDF open in the instance and at most `work` to do, and puts the
   * instance back however it ends. `call` wraps each call into PDFium: running out of work, a
   * growth refused, an abort or a trap during it ends the render with a refusal, never with a
   * result that may be missing something. `spent` is told the work it took.
   */
  let within = <T>(
    hold: Held, work: number, spent: (work: number) => void,
    use: (own: Arena, document: number, call: Call) => T,
  ): T => {
    if (hold.released) throw new RenderRefusal("released");
    hold.touched = now();
    if (failed) throw failed;
    if (hold.emptyLeft <= 0) throw new RenderRefusal("empty-work");
    work = Math.min(work, MAX_WORK);
    if (work <= 0) throw new RenderRefusal("work");
    let own: Arena;
    try {
      own = arena ??= ready();
    } catch (error) {
      // No second instance is made after one that could not be made ready: a WebAssembly memory
      // that is dropped is not given back when it is dropped, so at most one ever is.
      throw failed = new RenderRefusal("start", error);
    }
    let { exports: x, host } = own.instance;
    let call: Call = <R>(run: () => R): R => {
      let refused = host.refusedGrowths;
      let result: R;
      try {
        result = run();
      } catch (error) {
        if (error instanceof RenderRefusal) throw error;
        if ((x.work.value as number) <= 0) throw new RenderRefusal("work");
        if (host.refusedGrowths > refused) throw new RenderRefusal("memory");
        if (error instanceof PdfiumAbort) throw new RenderRefusal("abort");
        // A fault inside PDFium, or a stack it ran out of.
        if (error instanceof WebAssembly.RuntimeError || error instanceof RangeError) throw new RenderRefusal("trap");
        throw error;
      }
      // A decoder refused memory may leave its image out and say nothing.
      if (host.refusedGrowths > refused) throw new RenderRefusal("memory");
      return result;
    };
    let used = () => work - Math.max(0, x.work.value as number);
    reading = hold.file;
    x.work.value = work;
    try {
      new Uint32Array(x.memory.buffer, own.access, 1)[0] = hold.file.byteLength;
      let document = call(() => x.FPDF_LoadCustomDocument!(own.access, 0));
      if (document === 0) {
        throw new RenderRefusal(call(() => x.FPDF_GetLastError!()) === FPDF_ERR_PASSWORD ? "encrypted" : "unreadable");
      }
      // PDFium opens a file encrypted with an empty password; an encrypted PDF is refused all the same.
      if (call(() => x.FPDF_GetSecurityHandlerRevision!(document)) !== -1) throw new RenderRefusal("encrypted");
      return use(own, document, call);
    } catch (error) {
      if (error instanceof RenderRefusal) {
        error.heapBytes = x.memory.buffer.byteLength;
        error.work = used();
      }
      throw error;
    } finally {
      spent(used());
      reading = undefined;
      restore(own);
    }
  };

  let pageCount = (x: PdfiumInstance["exports"], document: number, call: Call): number => {
    let pages = call(() => x.FPDF_GetPageCount!(document));
    if (pages > limits.pages) throw new RenderRefusal("page-count");
    return pages;
  };

  /**
   * One try at a page, at `dpi`, with at most `work` to do, cut as `options` say. `seen` is told
   * the resolution of the page's densest image, whether painting began, and the work the try
   * took; it says whether the try is a second one.
   */
  let attempt = (
    hold: Held, index: number, options: RenderOptions, dpi: number, work: number, seen: Seen,
  ): RenderedPage =>
    within(hold, work, took => { seen.work = took; }, (own, document, call) => {
      let { exports: x } = own.instance;
      let { scratch, pauser } = own;
      if (index >= pageCount(x, document, call)) throw new RangeError(`The PDF has no page ${index}.`);
      let sized = call(() => x.FPDF_GetPageSizeByIndexF!(document, index, scratch));
      let points = new Float32Array(x.memory.buffer, scratch, 2);
      let pointsWide = points[0]!, pointsHigh = points[1]!;
      if (!sized || !(pointsWide > 0 && pointsHigh > 0) || !Number.isFinite(pointsWide * pointsHigh)) {
        throw new RenderRefusal("page-size");
      }
      // The scale comes from the pixel limits, never from the page's size alone.
      let scale = Math.min(dpi / 72, Math.sqrt(limits.pagePixels / (pointsWide * pointsHigh)),
        limits.sidePixels / pointsWide, limits.sidePixels / pointsHigh);
      // A second try is half the first, rounded down: a JPEG 2000 image is decoded at a smaller
      // size only when no pixel more than that size is asked of it.
      let pixelsOf = (length: number) =>
        Math.max(1, seen.second ? Math.floor(length * scale) : Math.round(length * scale));
      let width = pixelsOf(pointsWide), height = pixelsOf(pointsHigh);
      // Rounding may add part of a row or a column to a page that is already at the limit.
      while (width * height > limits.pagePixels) height--;

      // Loading a page parses its whole content stream, and every form it draws each time it
      // draws it: the work counter is what ends that.
      let page = call(() => x.FPDF_LoadPage!(document, index));
      if (page === 0) throw new RenderRefusal("page-load");
      // The form layer, which draws what a form's fields hold. Nothing is done with it but
      // drawing: no script of the document's runs, and it is gone with the rest of the document
      // when the instance is put back. A document it cannot be made for is drawn without it.
      let form = call(() => x.FPDFDOC_InitFormFillEnvironment!(document, own.formInfo));
      if (form !== 0) call(() => x.FORM_OnAfterLoadPage!(page, form));

      // What the page would have PDFium decode, read before it paints anything. Only so many
      // objects are looked at: a page with more is painted all the same, within the memory and
      // the work it is allowed.
      let objects = 0, images = 0, imagePixels = 0;
      /** Whether every object was looked at: none left out for their number or their depth. */
      let surveyed = true;
      call(() => {
        let visit = (object: number, depth: number) => {
          objects++;
          let type = x.FPDFPageObj_GetType!(object);
          if (type === FPDF_PAGEOBJ_IMAGE) {
            images++;
            if (!x.FPDFImageObj_GetImagePixelSize!(object, scratch, scratch + 4)) throw new RenderRefusal("image-pixels");
            let sides = new Uint32Array(x.memory.buffer, scratch, 2);
            let pixels = sides[0]! * sides[1]!;
            imagePixels += pixels;
            if (pixels > limits.imagePixels || imagePixels > limits.pageImagePixels) throw new RenderRefusal("image-pixels");
            if (x.FPDFPageObj_GetBounds!(object, scratch + 8, scratch + 12, scratch + 16, scratch + 20)) {
              // Left, bottom, right, top, in points.
              let bounds = new Float32Array(x.memory.buffer, scratch + 8, 4);
              let area = (bounds[2]! - bounds[0]!) * (bounds[3]! - bounds[1]!);
              if (area > 0) seen.imageDpi = Math.max(seen.imageDpi, Math.sqrt(pixels / area) * 72);
            }
          } else if (type === FPDF_PAGEOBJ_FORM && depth < limits.formDepth) {
            let inside = x.FPDFFormObj_CountObjects!(object);
            for (let i = 0; i < inside && within(); i++) visit(x.FPDFFormObj_GetObject!(object, i), depth + 1);
          } else if (type === FPDF_PAGEOBJ_FORM) {
            surveyed = false;
          }
        };
        /** Whether another object may be looked at: when not, the look is not of all of them. */
        let within = () => objects < limits.pageObjects || (surveyed = false);
        let count = x.FPDFPage_CountObjects!(page);
        for (let i = 0; i < count && within(); i++) visit(x.FPDFPage_GetObject!(page, i), 0);
        // What an annotation or a form's field shows is drawn from an appearance of its own,
        // which is none of the page's objects: a page that carries any may draw an image there.
        if (x.FPDFPage_GetAnnotCount!(page) > 0) surveyed = false;
      });

      // A page that is shown turned is painted as its content lies and turned as its rows are
      // copied out: PDFium decodes an image it has to turn at its full size, which for a JPEG
      // 2000 page is several times the memory the same page takes upright.
      let turns = call(() => x.FPDFPage_GetRotation!(page)) & 3;
      let across = turns & 1 ? height : width, down = turns & 1 ? width : height;

      // One bitmap of a strip's rows, filled again for each strip: the page's bitmap never exists.
      seen.painting = true;
      let stripRows = Math.max(1, Math.min(down, Math.floor(limits.stripBytes / across)));
      let bitmap = call(() => x.FPDFBitmap_CreateEx!(across, stripRows, FPDFBITMAP_GRAY, 0, 0));
      if (bitmap === 0) throw new RenderRefusal("memory");
      let shown = hold.pixels.subarray(0, width * height);
      let ink = hold.ink.subarray(0, height);
      let steps = 0, strips = 0;
      for (let top = 0; top < down; top += stripRows) {
        let rows = Math.min(stripRows, down - top);
        call(() => x.FPDFBitmap_FillRect!(bitmap, 0, 0, across, rows, 0xffffffff));
        let status = call(() => x.FPDF_RenderPageBitmap_Start!(bitmap, page, 0, -top, across, down, (4 - turns) & 3, FPDF_ANNOT, pauser));
        while (status === FPDF_RENDER_TOBECONTINUED) {
          if (++steps > limits.steps) throw new RenderRefusal("steps");
          status = call(() => x.FPDF_RenderPage_Continue!(page, pauser));
        }
        call(() => x.FPDF_RenderPage_Close!(page));
        if (status !== FPDF_RENDER_DONE) throw new RenderRefusal("render");
        if (form !== 0) call(() => x.FPDF_FFLDraw!(form, bitmap, page, 0, -top, across, down, (4 - turns) & 3, FPDF_ANNOT));
        let buffer = call(() => x.FPDFBitmap_GetBuffer!(bitmap)), stride = call(() => x.FPDFBitmap_GetStride!(bitmap));
        let heap = new Uint8Array(x.memory.buffer);
        for (let y = 0; y < rows; y++) {
          let from = buffer + y * stride, row = top + y;
          if (turns === 0) {
            shown.set(heap.subarray(from, from + across), row * width);
          } else if (turns === 1) {
            // A quarter turn clockwise: this row is a column, counted from the right.
            for (let c = 0, to = down - 1 - row; c < across; c++, to += width) shown[to] = heap[from + c]!;
          } else if (turns === 2) {
            for (let c = 0, to = (down - 1 - row) * width + across - 1; c < across; c++, to--) shown[to] = heap[from + c]!;
          } else {
            for (let c = 0, to = (across - 1) * width + row; c < across; c++, to -= width) shown[to] = heap[from + c]!;
          }
        }
        strips++;
      }
      // Each row's ink, from the page as it is shown: how far its pixels are from the row's
      // ground, the level that half of them are at or under. What is written on a row stands
      // out from what it is written on, so a row between two lines of writing has the least
      // whether the page is dark on light or light on dark, and whether or not its ground is
      // one level all the way down. On a white ground it is the darkness of the row's pixels.
      for (let y = 0, at = 0; y < height; y++) {
        for (let end = at + width; at < end; at++) levels[shown[at]!]!++;
        let ground = 0, under = levels[0]!;
        while (under * 2 < width) under += levels[++ground]!;
        let stands = 0;
        for (let level = 0; level < 256; level++) stands += levels[level]! * Math.abs(level - ground);
        ink[y] = stands;
        levels.fill(0);
      }
      // A page set in columns is not cut across them: its bands' texts are joined in order, so
      // each column would come back in pieces between the pieces of the others.
      let barred = (row: number) => partsColumns(shown, width, height, row);
      let cuts = cutRows(ink, options.bands, limits.bandRows, barred);
      if (options.denseLines !== undefined) cuts = cutDense(cuts, ink, options.denseLines, limits.bands, barred);
      let bands = cuts.slice(1).map((end, band): RenderedBand => {
        let top = cuts[band]!;
        let written = 0;
        for (let row = top; row < end; row++) written += ink[row]!;
        // A band has pixels when one of them is anything but white, whatever its rows stand on.
        // They are copied: the hold's are the page only until it draws the next.
        for (let at = top * width, last = end * width; at < last; at++) {
          if (shown[at] !== 255) return { top, rows: end - top, ink: written, pixels: shown.slice(top * width, last) };
        }
        return { top, rows: end - top, ink: written };
      });
      return {
        width, height, bands, blank: bands.every(band => !band.pixels), images, surveyed, dpi: scale * 72,
        reduced: false,
        cost: { heapBytes: x.memory.buffer.byteLength, objects, imagePixels, steps, strips, work: 0 },
      };
    });

  return {
    hold(fileBytes, released) {
      if (!(fileBytes > 0 && fileBytes <= limits.fileBytes)) throw new RenderRefusal("file-size");
      let inkBytes = 4 * limits.sidePixels;
      let bytes = inkBytes + fileBytes + limits.pagePixels;
      if (held + bytes > limits.heldBytes) {
        // A hold whose caller went away without letting go is taken back when it stands in the
        // way: the clock moves between events, though never during a render. Its caller may be
        // there still, reading one page for long, and has to open its PDF again: so none is
        // taken back unless that makes the room, and then the longest idle first, and no more
        // of them than it takes.
        let idle = [...holds].filter(hold => now() - hold.touched > HOLD_IDLE_MS)
          .toSorted((a, b) => a.touched - b.touched);
        let given = idle.reduce((sum, hold) => sum + hold.bytes, 0);
        if (held - given + bytes > limits.heldBytes) throw new RenderRefusal("room");
        for (let hold of idle) {
          if (held + bytes <= limits.heldBytes) break;
          hold.release("idle");
        }
      }
      // Memory that can be made smaller is given back when it is: at once, and whoever still
      // has a view of it is left with nothing.
      let buffer = new ArrayBuffer(bytes, { maxByteLength: bytes });
      held += bytes;
      let own: Held = {
        buffer, bytes, ink: new Uint32Array(buffer, 0, limits.sidePixels),
        file: new Uint8Array(buffer, inkBytes, fileBytes),
        pixels: new Uint8Array(buffer, inkBytes + fileBytes, limits.pagePixels),
        emptyLeft: limits.emptyWork, touched: now(), released: false,
        release(by) {
          if (own.released) return;
          own.released = true;
          held -= bytes;
          holds.delete(own);
          buffer.resize(0);
          released?.(by);
        },
      };
      holds.add(own);
      return {
        file: own.file,
        fill(piece, at) {
          if (own.released) throw new RenderRefusal("released");
          if (at + piece.byteLength > fileBytes) throw new RenderRefusal("size-mismatch");
          own.file.set(piece, at);
          own.touched = now();
        },
        countPages() {
          try {
            return within(own, limits.work, work => { own.emptyLeft -= work; },
              ({ instance }, document, call) => pageCount(instance.exports, document, call));
          } catch (error) {
            // What ends the count ends every page's render: each begins by opening the PDF and
            // counting its pages, as this does.
            if (error instanceof RenderRefusal) error.ofPage = false;
            throw error;
          }
        },
        renderPage(index, options) {
          if (!Number.isInteger(index) || index < 0) throw new RangeError(`The PDF has no page ${index}.`);
          if (!Number.isInteger(options.bands) || options.bands < 1 || options.bands > limits.bands) {
            throw new RangeError(`A page is cut into 1 to ${limits.bands} bands, not ${options.bands}.`);
          }
          let seen: Seen = { imageDpi: 0, painting: false, work: 0, second: false };
          let second: Seen = { imageDpi: 0, painting: false, work: 0, second: true };
          try {
            let page: RenderedPage;
            try {
              page = attempt(own, index, options, limits.dpi, limits.work, seen);
            } catch (error) {
              // A page that ran out of memory while it was painted is tried once more, with the
              // work the first try left, at half the resolution of its densest image, or of the
              // first try when that is lower: a JPEG 2000 image is decoded at a size that suits.
              let again = Math.min(limits.dpi, seen.imageDpi || limits.dpi) / 2;
              if (!(error instanceof RenderRefusal) || error.reason !== "memory" || !seen.painting || again < RETRY_FLOOR_DPI) {
                throw error;
              }
              page = attempt(own, index, options, again, limits.work - seen.work, second);
              page.reduced = true;
            }
            page.cost.work = seen.work + second.work;
            // A page with ink is sent to a model, which takes its time; one without is not.
            if (page.blank) own.emptyLeft -= page.cost.work;
            return page;
          } catch (error) {
            if (error instanceof RenderRefusal) error.work = seen.work + second.work;
            own.emptyLeft -= seen.work + second.work;
            throw error;
          }
        },
        release: () => own.release("disposed"),
      };
    },
  };
}

/**
 * The rows at which a page is cut into bands, from each row's ink (how far its pixels are from
 * the row's ground, summed): each band's first row, beginning with 0, then the page's height.
 * There are at most `bands` bands, and fewer for a page that has not `bandRows` rows for each. A
 * cut is made at the row where it and the row above it hold the least ink between them, within
 * 6% of the page's height either side of where an even cut would fall and below the cut before;
 * of equals, the nearest to the even cut. So a band may be shorter than `bandRows`, by as far as
 * its cuts moved. A cut that `barred` says may not be made at its row is left out, and the bands
 * either side of it are one.
 */
export function cutRows(
  ink: ArrayLike<number>, bands: number, bandRows: number, barred: (row: number) => boolean = () => false,
): number[] {
  let height = ink.length;
  bands = Math.max(1, Math.min(bands, Math.floor(height / bandRows)));
  let cuts = [0];
  let reach = Math.floor(height * CUT_WINDOW);
  for (let k = 1; k < bands; k++) {
    let even = Math.round((k * height) / bands);
    let from = Math.max(cuts[cuts.length - 1]! + 1, even - reach);
    let to = Math.min(height - 1, even + reach);
    let best = -1, least = Infinity;
    for (let y = from; y <= to; y++) {
      let weight = ink[y]! + ink[y - 1]!;
      if (weight < least || (weight === least && Math.abs(y - even) < Math.abs(best - even))) {
        least = weight;
        best = y;
      }
    }
    if (best > cuts[cuts.length - 1]! && !barred(best)) cuts.push(best);
  }
  cuts.push(height);
  return cuts;
}

/**
 * `cuts`, as {@link cutRows} gives them, with each band that holds more than `lines` lines of
 * writing cut once more, while the page has fewer than `bands` bands: at the row where it and the
 * row above it hold the least ink between them, within 6% of the page's height either side of
 * the band's middle and inside the band, and not where `barred` says no cut may be made. No band
 * is cut twice.
 *
 * A line of writing is a run of at least three rows that hold writing, between rows that do not:
 * a rule drawn across the page is thinner. A row holds writing when its ink is more than a
 * twentieth of the way from the page's least inked row to its most inked one, so that the grain
 * of a scan, which every row has, is no writing, and a line of one word is.
 */
export function cutDense(
  cuts: number[], ink: ArrayLike<number>, lines: number, bands: number,
  barred: (row: number) => boolean = () => false,
): number[] {
  let height = ink.length;
  let least = Infinity, most = 0;
  for (let y = 0; y < height; y++) {
    least = Math.min(least, ink[y]!);
    most = Math.max(most, ink[y]!);
  }
  let writing = least + (most - least) * LINE_INK;
  let reach = Math.floor(height * CUT_WINDOW);
  /** How many more bands the page may have. */
  let room = bands - (cuts.length - 1);
  let out = [0];
  for (let band = 1; band < cuts.length; band++) {
    let top = cuts[band - 1]!, end = cuts[band]!;
    let held = 0;
    for (let y = top, rows = 0; y < end; y++) {
      rows = ink[y]! > writing ? rows + 1 : 0;
      if (rows === LINE_ROWS) held++;
    }
    if (room > 0 && held > lines) {
      let middle = (top + end) >> 1;
      let best = -1, fewest = Infinity;
      for (let y = Math.max(top + 1, middle - reach); y <= Math.min(end - 1, middle + reach); y++) {
        let weight = ink[y]! + ink[y - 1]!;
        if (weight < fewest || (weight === fewest && Math.abs(y - middle) < Math.abs(best - middle))) {
          fewest = weight;
          best = y;
        }
      }
      if (best > top && !barred(best)) {
        out.push(best);
        room--;
      }
    }
    out.push(end);
  }
  return out;
}

/**
 * Whether a cut above row `row` of a page, `height` rows of `width` grey bytes in `pixels`, would
 * part its columns. Bands are read one after another, each across the whole of the page's
 * width, so what is right of the space between two columns above a cut would be read before
 * what is left of it below: a page set in columns would come back with its columns in pieces,
 * turn about. The space between two columns is a strip of the page's ground, 1.5% of its width
 * across and nowhere in the fifth of the page at either side, that runs at least 5% of its
 * height above the cut and as far below it. A cut parts columns when such a strip has writing
 * to its right above the cut and to its left below it, in the rows it runs through and no
 * nearer its ends than half that 5%, each over at least a tenth of the page's width: a line
 * across the page ends a strip and lies beside none, and a narrow mark is no column. What stands
 * beside a paragraph a tenth of the page across with such a strip between them, as a stamp may,
 * is a column by this: the page is cut into fewer bands for it, and nothing of it is left out.
 *
 * The ground is the level half of the pixels of `row` are at or under, and writing is a pixel
 * more than a quarter of the range from it, so a rule across the strip ends it as a line of
 * writing does: the columns of a table drawn with rules are not these, and those of one drawn
 * without them are.
 */
export function partsColumns(pixels: Uint8Array, width: number, height: number, row: number): boolean {
  let gutter = Math.max(1, Math.round(width * GUTTER_WIDTH));
  let column = Math.max(1, Math.round(width * COLUMN_WIDTH));
  let run = Math.max(1, Math.round(height * GUTTER_RUN));
  if (row < run || height - row < run) return false;
  let levels = new Uint32Array(256);
  for (let at = row * width, end = at + width; at < end; at++) levels[pixels[at]!]!++;
  let ground = 0, under = levels[0]!;
  while (under * 2 < width) under += levels[++ground]!;

  // How many rows each column is clear of writing for, up from the cut and down from it.
  let above = new Uint16Array(width), below = new Uint16Array(width);
  let clear = (rows: Uint16Array, first: number, step: number, most: number) => {
    rows.fill(most);
    for (let reached = 0, open = width; reached < most && open > 0; reached++) {
      for (let x = 0, at = (first + reached * step) * width; x < width; x++, at++) {
        if (rows[x] === most && Math.abs(pixels[at]! - ground) > WRITING_LEVELS) {
          rows[x] = reached;
          open--;
        }
      }
    }
  };
  clear(above, row - 1, -1, row);
  clear(below, row, 1, height - row);

  let inside = run >> 1;
  let last = Math.floor(width * (1 - GUTTER_MARGIN)) - gutter;
  for (let left = Math.ceil(width * GUTTER_MARGIN); left <= last; left++) {
    let up = row, down = height - row;
    for (let x = left; x < left + gutter; x++) {
      up = Math.min(up, above[x]!);
      down = Math.min(down, below[x]!);
    }
    if (up < run || down < run) continue;
    let rightAbove = 0, leftBelow = 0;
    for (let x = left + gutter; x < width; x++) if (above[x]! + inside < up) rightAbove++;
    for (let x = 0; x < left; x++) if (below[x]! + inside < down) leftBelow++;
    if (rightAbove >= column && leftBelow >= column) return true;
  }
  return false;
}
