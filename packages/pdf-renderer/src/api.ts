// What the PDF renderer is asked and what it answers: its limits, a page as it gives one, and
// the words it refuses with. This file imports nothing, so a Worker that calls the renderer over
// its service binding takes these types, and the few numbers it routes by, without the renderer.

/** The limits a render is held to. Every one is a size or a count: none is a time. */
export type RenderLimits = {
  /** The most the PDFium instance's memory may grow to. */
  heapBytes: number;
  /** The largest PDF that is rendered. */
  fileBytes: number;
  /**
   * The most that the PDFs open in an isolate hold between them: each its file, one page's
   * pixels and a count for each of the page's rows.
   */
  heldBytes: number;
  /** The most pages a rendered PDF may have, by its page tree. */
  pages: number;
  /** Pixels an inch a page is rendered at, unless a limit below asks for fewer. */
  dpi: number;
  /** The most pixels a page's render may have, whatever the page's size says. */
  pagePixels: number;
  /** The most pixels either side of a render may have. */
  sidePixels: number;
  /** The most bytes of rows rendered at once: the largest bitmap that exists in the instance. */
  stripBytes: number;
  /** The most page objects looked at before a page is painted, counted through forms. */
  pageObjects: number;
  /** How deep in forms page objects are looked at. */
  formDepth: number;
  /** The most pixels one image may declare. */
  imagePixels: number;
  /** The most pixels all of a page's images may declare together. */
  pageImagePixels: number;
  /** The most times PDFium may be let go on after pausing, over one page. */
  steps: number;
  /**
   * The most work one call may do, in the build's own count: one for each start of a function
   * and each pass of a loop, and one for every 64 bytes moved for it outside its code.
   */
  work: number;
  /**
   * The most work that the calls for one PDF that leave nothing to send to a model may do
   * between them: opening it, pages that come out blank, pages that are not drawn.
   */
  emptyWork: number;
  /** The most bands a page may be asked in, before any is split. */
  bands: number;
  /**
   * The rows a page has to have for each band it is cut into: one with fewer is cut into fewer
   * bands. A band may be shorter than this, by as far as a cut moves from where an even one falls.
   */
  bandRows: number;
};

/**
 * The limits the renderer Worker renders under. It has an isolate's memory to itself, so they are
 * what the measurements of a 64 MiB instance allow: the instance at its cap, the PDFs held and a
 * page crossing the binding come to under 100 MiB.
 */
export const RENDER_LIMITS: RenderLimits = {
  heapBytes: 64 * 1024 * 1024, fileBytes: 16 * 1024 * 1024, heldBytes: 24 * 1024 * 1024,
  pages: 2000, dpi: 150, pagePixels: 3_000_000, sidePixels: 4000, stripBytes: 1024 * 1024,
  pageObjects: 5000, formDepth: 4, imagePixels: 40_000_000, pageImagePixels: 80_000_000,
  steps: 20_000, work: 400_000_000, emptyWork: 20_000_000_000, bands: 8, bandRows: 400,
};

/**
 * How long an open PDF may go without a call before its room can be taken back for another:
 * twice what a transcription may sit idle. A caller whose PDF was taken while one page was read
 * for longer than this is told `released` at its next call, and opens it again.
 */
export const HOLD_IDLE_MS = 120_000;

/** Why a PDF, or a page of it, was not rendered, as a word for logs. Never anything of the file's. */
export type RenderRefusalReason =
  /** The PDFium instance could not be made ready. */
  | "start"
  /** The PDF was closed, or its room taken back, before the call. */
  | "released"
  /** The PDF is larger than is rendered, or empty. */
  | "file-size"
  /** The stream ended before the size it was opened with, or went past it. */
  | "size-mismatch"
  /** The PDFs open in the isolate leave no room for this one. */
  | "room"
  | "encrypted" | "unreadable" | "page-count" | "empty-work"
  | "page-size" | "page-load" | "image-pixels" | "steps" | "work" | "memory" | "abort" | "trap"
  | "render";

/**
 * A PDF, or a page of it, that was not rendered: a value, since an error's own fields do not
 * cross a service binding. It carries a reason word and sizes, and nothing of the document.
 */
export type RenderRefused = {
  refused: RenderRefusalReason;
  /** Whether it is one page that was not rendered, and the PDF's other pages still can be. */
  ofPage: boolean;
  /** The instance's memory when the call ended, in bytes; 0 when no instance was reached. */
  heapBytes: number;
  /** The work the call had done when it ended. */
  work: number;
};

/** How a page is to be cut. */
export type RenderOptions = {
  /**
   * How many bands a page of ordinary height is cut into, from 1 to {@link RenderLimits.bands}:
   * at its least inked rows near where even cuts would fall. A cut that would part the columns
   * of a page set in columns is not made, so such a page has fewer.
   */
  bands: number;
  /**
   * When given, a band that holds more than this many lines of writing is cut once more, at its
   * least inked row near its middle, while the page has fewer than {@link RenderLimits.bands}.
   * Lines are counted from the ink of whole rows, so only on a page that is upright: where
   * writing slopes by more than the space between its lines, as on a scan turned a degree or
   * so, no row lies between two lines, they count as one, and the band is not cut.
   */
  denseLines?: number;
};

/** One band of a rendered page. */
export type RenderedBand = {
  /** Its first row in the page, and how many rows it has. */
  top: number;
  rows: number;
  /**
   * How much writing it holds, as a number to compare with the page's other bands: how far its
   * pixels are from the ground of their rows, summed.
   */
  ink: number;
  /**
   * `rows` rows of the page's width in 8-bit grey, upright, packed. Absent for a band with no
   * pixel that is anything but white: there is nothing in it for a model to read.
   */
  pixels?: Uint8Array;
};

/** One page as rendered. */
export type RenderedPage = {
  width: number;
  height: number;
  /** Its bands from the top down; together they are every row of the page. */
  bands: RenderedBand[];
  /** Whether no pixel of the page is anything but white: none of its bands has pixels. */
  blank: boolean;
  /** How many images the page draws, among the page objects looked at. */
  images: number;
  /**
   * Whether everything the page draws was looked at for `images`. It is not when the page holds
   * more objects than are looked at, draws forms nested deeper than they are followed, or
   * carries annotations, whose appearances are not looked at: the page may then draw images
   * that were not counted.
   */
  surveyed: boolean;
  /** The resolution it was rendered at: lower than asked when a limit or a second try lowered it. */
  dpi: number;
  /** Whether it took a second try at a lower resolution, the first having run out of memory. */
  reduced: boolean;
  /** For logs: the memory the instance has grown to, what the page held, and what it took. */
  cost: { heapBytes: number; objects: number; imagePixels: number; steps: number; strips: number; work: number };
};

/**
 * A PDF open in the renderer: its bytes and room for one page's pixels, held in the renderer's
 * isolate until this is disposed, the caller goes away, or it goes {@link HOLD_IDLE_MS} without
 * a call while another PDF needs the room.
 */
export interface PdfDocument {
  /**
   * Page `index`, from 0 in the page tree's order, or why it was not rendered. A refusal that is
   * not `ofPage` is of the whole PDF: no later page of it will be rendered either.
   */
  renderPage(index: number, options: RenderOptions): Promise<RenderedPage | RenderRefused>;
  /** Gives back everything held for the PDF. A second call does nothing. */
  [Symbol.dispose](): void;
}

/** What the renderer Worker's entrypoint is called with. */
export interface PdfRendering {
  /**
   * Opens a PDF of `size` bytes read from `pdf`, or says why it is not rendered. The stream is
   * read to its end before this answers, and the PDF opened once: so an encrypted or unreadable
   * one, or one with more pages than are rendered, is refused here. `pages` is how many it has,
   * by its page tree. A failure of `pdf` itself is thrown, after the room is given back.
   */
  open(pdf: ReadableStream<Uint8Array>, size: number): Promise<{ document: PdfDocument; pages: number } | RenderRefused>;
}
