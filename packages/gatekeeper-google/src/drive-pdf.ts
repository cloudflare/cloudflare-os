// A Drive PDF's text, from Workers AI's markdown conversion, streamed in both directions: neither
// the PDF nor its text is ever held whole. A scanned PDF has no text to convert, so its pages are
// transcribed by a vision model instead, ahead of the reader once it reads. A scan small enough
// is read again, whole, into the PDF renderer, which draws each page and cuts it into bands for
// the model to read; a larger one has its page images sent as they are stored. A PDF that has
// text keeps it, and the pages of it that have none are rendered and read the same way, each
// under a line that says so. A deployment can turn the model's reading off: see pdfConverter().
// A Gmail attachment's PDF is read the same way, in words and under log names of its own: see
// PdfSource.

import type { Logger } from "@gadgets/observability/logger";
import {
  RENDER_LIMITS, type PdfDocument, type PdfRendering, type RenderedPage, type RenderRefusalReason,
  type RenderRefused,
} from "@gadgets/pdf-renderer/api";
import { FILE_CHANGED } from "./drive-file-read";
import { PDF_MIME_TYPE } from "./drive-session";
import type { DrivePdfText } from "./drive-types";
import { obsContext, type GoogleObservabilityFields } from "./observability";
import { readBands, REFUSED_PAUSE, refusedCall, refusedPause, type BandCall } from "./pdf-bands";
import { MAX_PAGE_IMAGES, PdfImageScan, type PdfImages, type PdfPageImage } from "./pdf-images";
import { ImageDataError, pngFromDeflated, pngFromSamples } from "./pdf-png";
import { callSlots, pixelRoom, READ_AHEAD, type CallSlots, type PixelHold } from "./pdf-read-ahead";
import {
  convertToMarkdown, MarkdownConversionError, type AiFetcher, type MarkdownConversion,
} from "./workers-ai-markdown";
import { transcribeImage, TranscriptionError, type Transcription } from "./workers-ai-vision";

/** What is logged of a PDF whose pages are rendered, beside the gatekeeper's own fields. */
type RenderLogFields = {
  /** How a PDF without text is transcribed: `stored` or `rendered`. */
  route: string;
  /** Why a PDF, or a page of it, was not rendered, or why it was opened again, as a word. */
  reason: string;
  /** A rendered page's width in pixels. */
  width: number;
  /** A rendered page's height in pixels. */
  height: number;
  /** Which band of a rendered page an image is, from 1. */
  band: number;
  /** How many bands a rendered page is cut into. */
  bands: number;
  /** How many times the model was asked for a band. */
  asks: number;
  /** Why a band was asked for again, as a word. */
  askedAgain: string;
  /** How many times the service refused a band's call, or a stored page's, for rate or capacity. */
  refused: number;
  /** Whether a rendered page has no ink. */
  blank: boolean;
  /** How many images a rendered page draws. */
  images: number;
  /** The resolution a page was rendered at. */
  dpi: number;
  /** Whether a page was rendered on a second try, at a lower resolution. */
  reduced: boolean;
  /** The renderer's memory when a call into it ended, in bytes. */
  heapBytes: number;
  /** The work a call into the renderer took, in the renderer's own count. */
  work: number;
  /** How many of a page's objects were looked at before it was painted. */
  objects: number;
  /** The pixels a page's images declare between them. */
  imagePixels: number;
  /** How many times the renderer was let go on after pausing, over one page. */
  steps: number;
  /** How many strips a page was painted in. */
  strips: number;
};

/** What a PDF's lines are logged by. */
type PdfLogger = Logger<GoogleObservabilityFields & RenderLogFields>;

/** Each source's logger, under a component of its own. */
const loggers: Record<PdfSource["name"], PdfLogger> = {
  drive: obsContext.createLogger({ component: "gatekeeper.google.drive.pdf", vendorId: "google" }),
  gmail: obsContext.createLogger({ component: "gatekeeper.google.gmail.pdf", vendorId: "google" }),
};

/**
 * What logs `source`'s lines. Every line is written in this file as Drive's, which is how Drive's
 * is logged; Gmail's has its event under `google.gmail.pdf.` and says "Gmail PDF attachment"
 * where Drive's says "Drive PDF".
 */
function log(source: PdfSource): Pick<PdfLogger, "info" | "warn"> {
  if (source.name === "drive") return loggers.drive;
  let named = (level: "info" | "warn"): PdfLogger["info"] => (message, details) =>
    loggers.gmail[level](message.replace("Drive PDF", "Gmail PDF attachment"), {
      ...details, event: details.event.replace("google.drive.pdf.", "google.gmail.pdf."),
    });
  return { info: named("info"), warn: named("warn") };
}

/**
 * One part of a PDF: `length` bytes from `offset`, in a file of `fileSize` bytes. `page` is the
 * page image the part is, from 1; absent when the part is the whole file, read to render its pages.
 */
export type PdfPageRange = { page?: number; offset: number; length: number; fileSize: number };

/**
 * Reads one part of the PDF a conversion was given, some time after it. The file may have changed
 * since, so the reader refuses a file that is no longer `fileSize` bytes long. A reader that has
 * bytes to pass over on its way to a page image calls `moved`, when given it, for each piece it
 * passes, so that a long way there is not taken for a text that sits idle.
 */
export type PdfRangeReader = (
  range: PdfPageRange, moved?: () => void,
) => Promise<ReadableStream<Uint8Array>>;

/**
 * A PDF's text as a conversion gives it. `rereads` says whether reading `text` may read the file
 * again, as a transcription does, so that whoever returns the text keeps what those reads rely on
 * until it ends.
 */
export type PdfRead = DrivePdfText & { rereads: boolean };

/**
 * Converts one PDF, read from a stream, to its text. It may resolve before reading `pdf` to its end,
 * so a caller that checks the file after converting it must see the end itself. With `readRange`,
 * a PDF that has no text has its pages transcribed, read through it: the whole file when its
 * pages are rendered, or a page image at a time. One that has text may have its pages without
 * any rendered and read the same way.
 */
export type PdfConverter = (
  pdf: ReadableStream<Uint8Array>, readRange?: PdfRangeReader,
) => Promise<PdfRead>;

/** What PDF reading goes by of the environment of the Worker it runs in. */
export type PdfEnv = {
  /** The Workers AI binding, which `pnpm dev-server` drops unless started with --use-workers-ai-binding. */
  AI?: unknown;
  /** The AI Gateway to go through, when set. */
  CF_AI_GATEWAY?: string;
  /** The Worker that renders the pages of a PDF, which a deployment may be without. */
  PDF_RENDERER?: unknown;
  /** `false` (trimmed, in any case) to have no page read by a vision model; anything else, or unset, reads them. */
  PDF_OCR?: string;
  /**
   * How many model calls one text may have in flight: a decimal integer of at least 1 (trimmed);
   * anything else, or unset, is `READ_AHEAD.calls`.
   */
  PDF_OCR_CALLS?: string;
};

/**
 * The converter a Worker with this environment reads PDFs with ({@link pdfToText}), or `undefined`
 * when it has no `AI` binding to convert with. Under `PDF_OCR=false` it never reads a file again,
 * whatever it is given to do so with: no vision model is called, so a PDF without text comes back
 * with none, and one with text as that text alone. `PDF_OCR_CALLS` is how many model calls one
 * text may have in flight. `source` is where the PDFs are read from.
 */
export function pdfConverter(env: PdfEnv, source: PdfSource = DRIVE_PDF): PdfConverter | undefined {
  // `Ai` declares no `fetch`, but the binding has one; conversion goes through it so it can
  // stream. The generated type of a service binding names no method of the entrypoint behind it.
  let ai = env.AI as AiFetcher | undefined;
  let renderer = env.PDF_RENDERER as PdfRendering | undefined;
  let transcribes = env.PDF_OCR?.trim().toLowerCase() !== "false";
  let named = env.PDF_OCR_CALLS?.trim() ?? "";
  let calls = /^\d+$/.test(named) && Number(named) >= 1 ? Number(named) : undefined;
  return ai && ((pdf, readRange) =>
    pdfToText(ai, env.CF_AI_GATEWAY, pdf, transcribes ? readRange : undefined, renderer, source, calls));
}

/**
 * The name every PDF is converted under. The conversion heads its output with the input's name, so
 * a fixed one keeps Drive file names out of both the request and the text.
 */
const PDF_NAME = "file.pdf";
/** What the conversion puts before a PDF's pages once its metadata block is turned off. */
const PREAMBLE = `# ${PDF_NAME}\n## Contents\n`;
const PAGE_HEADING = /^### Page \d+$/;
/** Characters of one line held while looking for text, more than any page heading has. */
const MAX_HEADING_CHARS = 32;
/** The one error a failed conversion is reported with, whatever the service said. */
export const CONVERSION_FAILED = "Google Drive's file could not be converted from PDF.";
/** The one error a failed transcription is reported with, whatever the service said. */
export const TRANSCRIPTION_FAILED = "Google Drive's PDF could not be transcribed.";

/** Where a PDF is read from: the words its failures are given in, and what its log lines are named. */
export type PdfSource = {
  /** `drive` or `gmail`: events are `google.<name>.pdf.*`, the logger's component `gatekeeper.google.<name>.pdf`. */
  name: "drive" | "gmail";
  /** What a failed conversion is reported with. */
  conversionFailed: string;
  /** What a failed transcription is reported with. */
  transcriptionFailed: string;
  /** What a file that is not what it was when converted is reported with. */
  changed: string;
};

/** A PDF read from Google Drive. */
export const DRIVE_PDF: PdfSource = {
  name: "drive", conversionFailed: CONVERSION_FAILED, transcriptionFailed: TRANSCRIPTION_FAILED,
  changed: FILE_CHANGED,
};

/** A PDF read from a Gmail attachment. */
export const GMAIL_PDF: PdfSource = {
  name: "gmail",
  conversionFailed: "The Gmail attachment could not be converted from PDF.",
  transcriptionFailed: "The Gmail attachment's PDF could not be transcribed.",
  changed: "The Gmail attachment changed while it was being read; read it again.",
};

/**
 * How long a transcription's text may go with nothing moving, whether the model has stopped
 * answering or the reader has stopped reading, before it is ended and what it holds let go.
 */
export const TRANSCRIPTION_IDLE_MS = 60_000;
/** What ends a transcription that sat idle. */
const TRANSCRIPTION_IDLE =
  "The PDF's transcription went unread, or the model stopped answering, for a minute; read the PDF again.";
/** What follows a page whose transcription the model was stopped partway through. */
const CUT_OFF = "\n\n[The transcription of this page was cut off.]";
/** What stands for a rendered page that came out blank and holds an image. */
const BLANK_PAGE = "[This page came out blank: it has nothing on it, or its image could not be read.]";
/** What stands for a page that could not be rendered. */
const UNDRAWN_PAGE = "[This page could not be drawn within the memory and work a page is allowed, so it was not read.]";
/** What follows a page that was rendered on a second try. */
const REDUCED_PAGE =
  "\n\n[This page was read from a drawing at half the usual resolution, which is what its size allowed, so its text may be less exact.]";
/** What ends the text of a PDF the renderer has no room for, or that could not reach it. */
const RENDERER_BUSY = "The PDF's pages cannot be rendered to be read just now; read the PDF again in a minute.";
/** What heads the text read from the image of a page without text, in a PDF that has text. */
const READ_FROM_IMAGE =
  "[This page has no text of its own: what follows was read from its image by a vision model, which can misread.]";
/** What stands for the first page without text that could not be read, in a PDF that has text. */
const UNREAD_PAGES = "[Pages of this PDF that have no text of their own could not be read just now.]";
/**
 * The line breaks on end that come before every page heading of a conversion but the first: two
 * that end the page before, and two between pages.
 */
const HEADING_BREAKS = 4;
/** What a conversion puts under the heading of a page without text that another page follows. */
const NO_TEXT = "\n\n\n\n";
/**
 * The largest image sent to be transcribed: a page image as it is stored, and the PNG made of one
 * or of a rendered band. Workers AI refuses a request body somewhere between a 12 MiB and a 16 MiB
 * image, and a scanned page is a few megabytes at most.
 */
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
/**
 * The most samples a page's rows may come to when they are inflated on the way, which takes time
 * in proportion: more than a 600 dpi A4 page in 8-bit RGB holds (104 MB). Deflated data can be
 * made to hold a thousand times its size, so {@link MAX_IMAGE_BYTES} does not bound this.
 */
const MAX_INFLATED_BYTES = 128 * 1024 * 1024;
/** What the encodings that are not read are called in a refusal. */
const UNREAD_ENCODINGS = {
  fax: "fax (CCITT)", jbig2: "JBIG2", jpeg2000: "JPEG 2000", other: "one this cannot read",
};
/** How many bands a rendered page is asked for in: each is one image for the model to read. */
const BANDS = 4;
/**
 * The lines of writing past which the renderer is asked to cut a band once more, so that a
 * closely written page is read in up to `RENDER_LIMITS.bands` smaller images. Measured on a
 * generated page of small print (1,236 words): in four bands the model got 5 to 8 words wrong
 * and, in two reads of six, left a whole clause out of the tallest band; cut past 14 lines, into
 * six bands, 2 to 4, and no clause, for two calls more. 14 is the largest number that cuts that
 * page; of seven other test pages it cuts only a table's, once. The renderer counts lines only
 * on a page that is upright (see `RenderOptions.denseLines`), so a scan that is turned a degree
 * keeps its four bands.
 */
const DENSE_LINES = 14;
/** Bytes of a rendered band's rows handed to its PNG at a time. */
const BAND_STEP_BYTES = 64 * 1024;

/**
 * Why a scanned PDF cannot be transcribed, in our words. It says things of the file's content
 * (that it has no text of its own, and how its pages are stored), so a caller that authorizes
 * what a read discloses has this to authorize as it has the text.
 */
export class TranscriptionRefusal extends Error {}

/** One page of a transcription, or one piece of a PDF's own text, as a {@link PageSource} gives it. */
type SourcedPage =
  /**
   * The model's answer to the page's image as the file stores it, begun already: the page's
   * text, in pieces, and whether it ends early. `next` throws what the page failed with.
   */
  | { answer: Pick<Transcription, "truncated" | "next"> }
  /** All that comes under the heading of a page that has been read already. */
  | { text: string }
  /** A piece of a text that has its page headings in it: given as it is. */
  | { own: string };

/**
 * Where a text's pages come from: the file's page images as stored, the renderer, or the PDF's
 * own text with the pages that have none read by the renderer.
 */
type PageSource = {
  /**
   * What comes `index`th, from 0: a page, or a piece of a PDF's own text. `undefined` when
   * there is no more. Asked for in order, each only once the text has been read up to it.
   * `signal` is aborted when the text ends first, after which nothing this gives is used, and
   * `moved` is to be called whenever what is waited for moves, so that a page that takes long
   * is not taken for a text that sits idle.
   */
  next(index: number, signal: AbortSignal, moved: () => void): Promise<SourcedPage | undefined>;
  /** What a log line says of what comes `index`th: nothing when it is not known to be a page. */
  fields(index: number): { page?: number; imageEncoding?: string };
  /**
   * Lets go of what the source holds, once what it has in flight has ended. Called when the text
   * ends, however it does, after the signal given to `next` was aborted.
   */
  release(): void;
};

/**
 * Converts a PDF with the Workers AI binding, through AI Gateway `gatewayId` when one is named.
 * The PDF is encoded into the request as it arrives, and the response is read only until its text
 * begins, which settles `hasText`; the text then streams from the response as it is read, without
 * the file heading, "## Contents" line, and pages before the first with text. Its images are not
 * described (an image-only page yields no text), so the conversion makes no billed model call. A
 * failed conversion is logged by status and error code only, never by the service's text, and
 * reported in our words, by a throw before the text begins or by erroring the stream after; a
 * failure of the PDF stream itself (such as the download breaking off) is thrown as it is.
 *
 * With `readRange`, the PDF's images are located as its bytes go by, and when it proves to have
 * no text its pages are transcribed instead: see {@link transcription}. With `renderer`, a PDF
 * of up to {@link RENDER_LIMITS}' `fileBytes` has its pages rendered, whatever images the scan
 * found in it: see {@link renderedPages}. Any other that holds no image of any kind has nothing
 * to transcribe; one that does has its page images
 * sent as they are stored ({@link storedPages}), and is refused before any is, with a
 * {@link TranscriptionRefusal}, when they cannot be: {@link unreadAsStored} says why, and a PDF
 * whose images are all pieces of pages or masks has no page image to send. An encrypted PDF is
 * refused either way.
 *
 * A PDF with text of its own is returned as that text. With `readRange` and `renderer`, one of
 * up to `fileBytes` has its pages without text rendered and read as the text is, whatever
 * images the scan found in it: see {@link mixedPages}. Its text then keeps the heading of every
 * page from the first, is still the document's own (`transcribed` is false), and may read the
 * file again. For any other PDF with text no model is called and nothing is read again.
 *
 * `source` is where the PDF is read from: its failures are given in that source's words, and its
 * log lines go under that source's names. `calls` is how many model calls the text may have in
 * flight, whichever way its pages are read.
 */
export async function pdfToText(
  ai: AiFetcher, gatewayId: string | undefined, pdf: ReadableStream<Uint8Array>,
  readRange?: PdfRangeReader, renderer?: PdfRendering, source: PdfSource = DRIVE_PDF,
  calls = READ_AHEAD.calls,
): Promise<PdfRead> {
  let scan = readRange && new PdfImageScan();
  /** Whether the scan was shown the PDF to its end. */
  let scanned = false;
  if (scan) pdf = watched(pdf, chunk => scan.feed(chunk), () => { scanned = true; });
  /** The text's limiter of model calls, whichever way its pages are read. */
  let slots = callSlots(calls);
  let options = {
    ...(gatewayId ? { gateway: { id: gatewayId } } : {}),
    conversionOptions: { pdf: { metadata: false, images: { convert: false } } },
  };
  let conversion: MarkdownConversion;
  let start = new TextStart();
  try {
    conversion = await convertToMarkdown(
      ai, { name: PDF_NAME, mimeType: PDF_MIME_TYPE, body: pdf }, options);
    while (start.text === undefined) {
      let data = await conversion.next();
      if (data === undefined) {
        start.end();
        break;
      }
      start.feed(data);
    }
  } catch (error) {
    throw reported(error, source);
  }
  let first = start.text;
  let hasText = first !== undefined;
  log(source).info("converted a Drive PDF", {
    event: "google.drive.pdf.converted", pdfBytes: conversion.sentBytes, hasText,
  });
  if (!hasText) {
    // A conversion that answered before the PDF ended leaves page images unlocated, and the
    // PDF still open.
    if (scan && !scanned) {
      await conversion.cancel();
      throw new Error(source.conversionFailed);
    }
    let found = scan?.end();
    if (found?.encrypted) throw refusal(source, found, "it is encrypted");
    let rendered = renderer !== undefined && found !== undefined && found.bytes <= RENDER_LIMITS.fileBytes;
    // The scan sees the images a file stores as objects of their own, a tile or strip of a page
    // and a mask as large as one among them: a file with none has nothing to send as it is
    // stored. Its pages may show something all the same, an image written into a page's content
    // or writing drawn as shapes, and the renderer draws what a page shows, so a file that is
    // rendered is not held to what the scan counted.
    if (!found || (!rendered && found.images.length === 0 && found.pieces === 0 && found.pageMasks === 0)) {
      let text = new ReadableStream<Uint8Array>({ start: controller => controller.close() });
      return { text, hasText, transcribed: false, rereads: false };
    }
    // Settled here for a PDF that is rendered too: should the renderer not take it, its text
    // is read from the stored page images instead, and by then nothing can be said of why not.
    let unread = unreadAsStored(found);
    let stored = !unread && found.images.length > 0;
    let pages: PageSource;
    if (renderer && rendered) {
      pages = renderedPages(
        renderedPdf(ai, gatewayId, found, readRange!, renderer, source, slots), found,
        stored ? storedPages(ai, gatewayId, found, readRange!, slots, source) : undefined, source);
      log(source).info("transcribing a scanned Drive PDF", {
        event: "google.drive.pdf.transcribing", pdfBytes: found.bytes, route: "rendered",
      });
    } else {
      if (unread) throw refusal(source, found, unread.why, unread.encoding);
      if (!stored) {
        throw refusal(source, found, "its pages have to be rendered to be read, which is " + (renderer
          ? `done only for a PDF of up to ${RENDER_LIMITS.fileBytes / (1024 * 1024)} MiB`
          : "not available on this deployment"));
      }
      pages = storedPages(ai, gatewayId, found, readRange!, slots, source);
      log(source).info("transcribing a scanned Drive PDF", {
        event: "google.drive.pdf.transcribing", pdfBytes: found.bytes, ocrPages: found.images.length,
        route: "stored",
      });
    }
    return { text: transcription(pages, source), hasText, transcribed: true, rereads: true };
  }

  // Pages are read into the text only when the scan saw the whole file, and so knows its
  // size, and the text begins under the heading that follows those passed, each of them a page
  // without text's: what came before it is then such pages, from the first, which are given
  // back as a conversion gives them. What images the scan found is not asked: the renderer
  // draws what a page shows, as for a PDF without text.
  let found = renderer && scanned ? scan?.end() : undefined;
  if (found && found.bytes <= RENDER_LIMITS.fileBytes && start.passedEmpty &&
      first!.startsWith(`### Page ${start.passed + 1}\n`)) {
    let pages = mixedPages(
      conversion, start.passed, first!,
      renderedPdf(ai, gatewayId, found, readRange!, renderer!, source, slots), source);
    return { text: transcription(pages, source), hasText, transcribed: false, rereads: true };
  }

  let encoder = new TextEncoder();
  let cancelled = false;
  let text = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let chunk: string | undefined;
      try {
        chunk = first ?? await conversion.next();
      } catch (error) {
        // Cancelling ends a read in progress as if the response had broken off.
        if (!cancelled) controller.error(reported(error, source));
        return;
      }
      first = undefined;
      if (chunk === undefined) controller.close();
      else controller.enqueue(encoder.encode(chunk));
    },
    cancel: reason => {
      cancelled = true;
      return conversion.cancel(reason);
    },
  }, { highWaterMark: 0 });
  return { text, hasText, transcribed: false, rereads: false };
}

/**
 * `pdf`, with each chunk shown to `onChunk` as it is read and `onEnd` called at its end, which
 * being cancelled is not.
 */
function watched(
  pdf: ReadableStream<Uint8Array>, onChunk: (chunk: Uint8Array) => void, onEnd: () => void,
): ReadableStream<Uint8Array> {
  let reader = pdf.getReader();
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let chunk = await reader.read();
      // Cancelling ends a read in progress the way the PDF's own end does.
      if (cancelled) return;
      if (chunk.done) {
        onEnd();
        controller.close();
      } else {
        onChunk(chunk.value);
        controller.enqueue(chunk.value);
      }
    },
    cancel: reason => {
      cancelled = true;
      return reader.cancel(reason);
    },
  }, { highWaterMark: 0 });
}

/**
 * Why the page images of a scanned PDF cannot all be transcribed as they are stored, with the
 * encoding at fault when one is, or `undefined` when they can: there are more than are kept, an
 * update replaced an image that had a mask (what it named may be a page now, and was not kept
 * as one), a page image is not where the file says, is too large as stored or as the rows that would be
 * inflated, or is in an encoding that is not read. Only JPEG images are, and deflated grey or
 * RGB ones whose rows a PNG can hold. A mask as large as a page that is stored as fax or JBIG2
 * counts as a page stored so does: it is where the text of a layered scan's pages is, and its
 * other layers would be read without it. Nothing is logged or thrown here.
 */
function unreadAsStored(
  found: PdfImages,
): { why: string; encoding?: PdfPageImage["encoding"] } | undefined {
  if (found.more) return { why: `it has more than ${MAX_PAGE_IMAGES} page images` };
  if (found.masksRedefined) {
    return { why: "an update to the file replaced an image that had a mask, so which of its images are pages cannot be told" };
  }
  if (found.maskEncoding) {
    return {
      why: "a mask the size of a page, which is where a layered scan keeps its text, is stored in " +
        `an image encoding that is not read yet, ${UNREAD_ENCODINGS[found.maskEncoding]}`,
      encoding: found.maskEncoding,
    };
  }
  for (let image of found.images) {
    let { encoding } = image;
    if (encoding !== "jpeg" && encoding !== "lossless") {
      return {
        why: `its pages are stored in an image encoding that is not read yet, ${
          UNREAD_ENCODINGS[encoding]}; only JPEG pages are, and deflated grey or RGB ones that a ` +
          "PNG can hold as they are stored",
        encoding,
      };
    }
    if (image.damaged) return { why: "a page image is not where the file says it is", encoding };
    let inflated = image.png && !image.png.filtered ? image.height * image.png.rowBytes : 0;
    if (image.length > MAX_IMAGE_BYTES || inflated > MAX_INFLATED_BYTES) {
      return { why: "a page image is too large", encoding };
    }
  }
  return undefined;
}

/**
 * The refusal to transcribe the scanned PDF the scan found because `why`, logged by the file's
 * size, how many page images it holds and the `encoding` at fault, when one is.
 */
function refusal(
  source: PdfSource, found: PdfImages, why: string, encoding?: PdfPageImage["encoding"],
): TranscriptionRefusal {
  log(source).info("a scanned Drive PDF cannot be transcribed", {
    event: "google.drive.pdf.untranscribable", pdfBytes: found.bytes,
    ocrPages: found.images.length, ...(encoding ? { imageEncoding: encoding } : {}),
  });
  return new TranscriptionRefusal(
    `The PDF has no text of its own, and ${why}, so it cannot be transcribed.`);
}

/** A stored page image the model is reading, or has read, ahead of the reader. */
type StoredPage = {
  /** Gives the page up: aborted with the text's signal, and when a page before it fails. */
  abort: AbortController;
  /** Whether the model has answered the page's call. */
  answered: boolean;
  /** The pieces of the answer that the reader is yet to be given, and the characters in them. */
  pieces: string[];
  held: number;
  /** Whether the answer has ended, and whether the model was stopped at its output limit. */
  ended: boolean;
  truncated: boolean;
  /** What the page failed with. */
  failure?: { error: unknown };
};

/**
 * The page images the scan found, as the file stores them, numbered in the order it stores them,
 * each read by the vision model: a JPEG is sent as it stands, and deflated rows wrapped as a PNG
 * without being inflated.
 *
 * Nothing is done until the first page is asked for. From then on up to {@link READ_AHEAD}'s
 * `storedPages` pages are begun and not yet read to their end by the reader, the one it is
 * reading among them. A page is begun by asking its image of the file through `readRange`, a
 * content read of its own, and streaming it into the page's call, which is made in a slot of
 * `slots`. Ranges are asked one at a time, in the pages' order: the next only once the image
 * before it has been read from its range to the end, or its call is over, since a file that is
 * read in one forward pass gives up a range that is unfinished when the next is asked for. The
 * answers then arrive side by side. A page is given once its call has answered, and the pieces
 * of its answer are held, as they arrive, until the reader takes them: with {@link READ_AHEAD}'s
 * `answerChars` characters of it held, no more of an answer is read until the reader has taken
 * some.
 *
 * A call the service refused for rate or capacity (see {@link readBands}) is made again:
 * `slots` is told, and after the pause its refusal has in {@link REFUSED_PAUSE} the page's
 * range is asked for again, which is one more read of the file, and then the model. Refused
 * once more than there are pauses, the page fails; any other failure fails it at once.
 *
 * A page that failed is given as what it failed with when the reader gets to it, after the
 * pages before it: no page after it is begun, and each one that was is given up at once.
 * Aborting the signal `next` is given gives every page up: its range, its call and its answer.
 *
 * A piece of an image that arrives, one `readRange` says it passed over on its way to an image,
 * and a piece of an answer each count as the text moving, but only while the reader waits for a
 * page: what is read ahead does not keep a text that nobody reads.
 */
function storedPages(
  ai: AiFetcher, gatewayId: string | undefined, { images, bytes: fileSize }: PdfImages,
  readRange: PdfRangeReader, slots: CallSlots, source: PdfSource,
): PageSource {
  /** The pages begun and not yet given to the reader. */
  let begun = new Map<number, StoredPage>();
  /** The page to begin next, from 0, and whether a page has failed, after which none is begun. */
  let ahead = 0;
  let failed = false;
  /** The range asked for last, settled once its image was read to the end or its call was over. */
  let ranged: Promise<void> = Promise.resolve();
  /** What the reader is to be told has moved, while it waits for a page. */
  let reader: (() => void) | undefined;
  let touch = () => reader?.();
  /**
   * The reader, while it waits for a page's call to answer or for more of an answer, and each
   * page's call, while it waits for the reader to take some of an answer that is held.
   */
  let waiters: (() => void)[] = [];
  let wait = () => new Promise<void>(resolve => waiters.push(resolve));
  let wake = () => {
    for (let go of waiters.splice(0)) go();
  };
  let fields = (index: number) => images[index] ? { page: index + 1, imageEncoding: images[index].encoding } : {};

  /**
   * Asks for page `index`'s image and has the model read it, to the end of its answer, waiting
   * for the reader whenever as much of the answer is held as may be. `refusals` is how many
   * times the service refused the page's call before this one, and `passed` is called once the
   * image has been read from its range to the end.
   */
  let call = async (index: number, page: StoredPage, refusals: number, passed: () => void) => {
    let image = images[index]!;
    let { signal } = page.abort;
    signal.throwIfAborted();
    let { offset, length } = image;
    let range = await readRange({ page: index + 1, offset, length, fileSize }, touch);
    if (signal.aborted) await range.cancel().catch(() => undefined);
    signal.throwIfAborted();
    // The image is sent as it arrives, and nothing of the text moves until the model answers:
    // each piece that arrives is what shows that a large image is on its way and not stalled.
    let data = watched(range, touch, passed);
    let answer = await transcribeImage(ai, gatewayId, image.png
      ? { mimeType: "image/png", body: pngFromDeflated(data, image, image.png, MAX_IMAGE_BYTES) }
      : { mimeType: "image/jpeg", body: data }, signal);
    // An answer being read is not ended by the signal its request was made with, nor is the
    // wait for its reader.
    let stop = () => {
      void answer.cancel(signal.reason).catch(() => undefined);
      wake();
    };
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    try {
      page.answered = true;
      wake();
      for (let piece = await answer.next(); piece !== undefined; piece = await answer.next()) {
        touch();
        page.pieces.push(piece);
        page.held += piece.length;
        wake();
        while (page.held >= READ_AHEAD.answerChars && !signal.aborted) await wait();
      }
    } finally {
      signal.removeEventListener("abort", stop);
    }
    page.truncated = answer.truncated;
    page.ended = true;
    log(source).info("transcribed a Drive PDF page", {
      event: "google.drive.pdf.page_transcribed", imageBytes: answer.sentBytes, ...fields(index),
      ...(refusals > 0 ? { refused: refusals } : {}),
    });
  };
  /**
   * Reads page `index`: its range is asked for in its turn and its call made in a slot, and both
   * again, after a pause, each time the service refuses the call. When the page fails, those
   * begun after it are given up before the turn passes to the next of them.
   */
  let read = async (index: number, page: StoredPage) => {
    let { signal } = page.abort;
    let own = slots.of(index);
    for (let refusals = 0;; refusals++) {
      /** Ends this range's turn: its image was read to the end, or its call is over. */
      let passed: (() => void) | undefined;
      try {
        await own.run(signal, async () => {
          let before = ranged;
          ranged = new Promise<void>(resolve => { passed = resolve; });
          await before;
          await call(index, page, refusals, passed!);
        });
        own.answered();
        return;
      } catch (error) {
        // What a page that was given up ends with is not a failure of its own.
        if (signal.aborted) throw error;
        let refused = refusedCall(error);
        if (refused) {
          own.refused();
          // A refusal is the service answering: a page being refused is not a text that sits idle.
          touch();
        }
        if (!refused || refusals === REFUSED_PAUSE.ms.length) {
          failed = true;
          for (let [later, other] of begun) {
            if (later <= index) continue;
            other.abort.abort();
            begun.delete(later);
          }
          throw error;
        }
      } finally {
        passed?.();
      }
      await refusedPause(refusals, signal);
    }
  };
  /** Begins page `index`, which the text's `signal` gives up, and a page before it that fails. */
  let begin = (index: number, signal: AbortSignal) => {
    let abort = new AbortController();
    let ended = () => abort.abort(signal.reason);
    signal.addEventListener("abort", ended, { once: true });
    if (signal.aborted) ended();
    let page: StoredPage = { abort, answered: false, pieces: [], held: 0, ended: false, truncated: false };
    begun.set(index, page);
    void read(index, page).catch((error: unknown) => { page.failure = { error }; }).finally(() => {
      signal.removeEventListener("abort", ended);
      wake();
    });
  };

  return {
    async next(index, signal, moved) {
      if (!images[index]) return undefined;
      // The pages before this one have been read to their end: as many as may be are begun.
      let last = failed ? 0 : Math.min(images.length, index + READ_AHEAD.storedPages);
      while (ahead < last) begin(ahead++, signal);
      let page = begun.get(index)!;
      begun.delete(index);
      // What is read ahead moves the text only while its reader waits.
      reader = moved;
      try {
        while (!page.answered) {
          if (page.failure) throw page.failure.error;
          await wait();
        }
      } finally {
        reader = undefined;
      }
      return {
        answer: {
          get truncated() { return page.truncated; },
          async next() {
            while (page.pieces.length === 0) {
              if (page.failure) throw page.failure.error;
              if (page.ended) return undefined;
              await wait();
            }
            let piece = page.pieces.shift()!;
            page.held -= piece.length;
            // An answer held as far as it may be is read on.
            wake();
            return piece;
          },
        },
      };
    },
    fields,
    release: () => undefined,
  };
}

/**
 * Why the renderer did not open a PDF, or went no further with one, as it is logged: the
 * renderer's own word, or `call` when the call to it failed, with the page that was asked for
 * and the renderer's sizes where there are any.
 */
type Unrendered = {
  reason: RenderRefusalReason | "call"; error?: unknown; page?: number; heapBytes?: number; work?: number;
};

/**
 * What came of a page asked for ahead of its reader: what the model read on it; that it has no
 * ink; that it alone could not be drawn; why the PDF was not opened, or is rendered no further;
 * or what reading its bands failed with.
 */
type PageOutcome =
  | { text: string; cutOff: boolean; reduced: boolean }
  | { blank: true; images: number; surveyed: boolean }
  | { undrawn: true }
  | { unrendered: Unrendered }
  | { failed: unknown };

/** The PDF the scan found, as the renderer holds it for one text: see {@link renderedPdf}. */
type RenderedPdf = {
  /** How many pages the PDF has, once it has been opened. */
  readonly pages: number | undefined;
  /**
   * Page `index`, from 0, of the open PDF: as it was drawn, as the refusal of that page alone,
   * or as why the PDF is rendered no further, after which it is no longer open.
   */
  render(
    index: number, signal: AbortSignal, moved: () => void,
  ): Promise<RenderedPage | RenderRefused | Unrendered>;
  /** What the vision model reads on `page`, drawn as page `index`: see {@link readBands}. */
  read(
    page: RenderedPage, index: number, signal: AbortSignal, moved: () => void,
  ): Promise<{ text: string; cutOff: boolean }>;
  /**
   * Says that page `index`, from 0, is wanted, ahead of the text being read up to it. Pages are
   * asked for in ascending order, each once, and no more of them than are to be held: the PDF
   * is opened for the first. `signal` is the text's, and `moved` is called whenever something
   * of the page's moves.
   */
  ahead(index: number, signal: AbortSignal, moved: () => void): void;
  /**
   * What came of page `index`, which was asked for with {@link ahead}, once that is known:
   * `undefined` for a page the PDF does not have. What a read of the file failed with is
   * thrown, a file of another size as a changed one, and so is an end by the text's signal.
   * Pages are taken in the order they were asked for, each once, and none after one that
   * failed.
   */
  take(index: number): Promise<PageOutcome | undefined>;
  /** Lets the PDF go in the renderer, once every page asked for with {@link ahead} has ended. */
  release(): void;
};

/**
 * The PDF the scan found as `renderer` holds it, for the one text that reads pages of it: each
 * page it is asked for is drawn in grey and cut into bands, and each band that has ink is read
 * by the vision model ({@link readBands}), each call in a slot of `slots`, the text's limiter of
 * model calls. Pages are the page tree's, in its order.
 *
 * Nothing is done until a page is asked for. Then the whole file is read through `readRange`, a content
 * read of its own, and streamed to the renderer, which keeps it: the document it answers with is
 * a hold on the file in the renderer's isolate, and nothing of the file stays here. A failure of
 * that read is thrown as it is, whatever the renderer made of the stream breaking off, and a
 * read that was not of as many bytes as the scan counted is thrown as a changed file.
 *
 * A document may be lost while it is open: the renderer's isolate goes away, or the room is
 * taken back for another PDF while a page is being read for long. When a page is asked of a
 * lost document that had rendered a page, the file is read and opened again, once, and the page
 * asked for again; a document that is lost before it rendered any is not opened again.
 *
 * Each document is let go exactly once: when its last page has answered, when it is lost or
 * refuses the PDF as a whole, or when the PDF is released, after whatever was in flight has
 * ended. Aborting the signal a page was asked for with gives up the band calls in flight, and ends an
 * `open` in flight by erroring the stream handed to it, which the call has locked; a page being
 * rendered is left to finish.
 *
 * Pages asked for ahead of the reader are drawn one at a time, in the order they are asked for,
 * each once the text's {@link pixelRoom} has room for a page's pixels, or the reader waits for
 * it. A page that is drawn has its bands read at once, while the next is drawn; its pixels are
 * let go when its bands have been read, have failed or are given up, and what is kept until it
 * is taken is what came of it. When a page fails (the PDF is not opened or is rendered no
 * further, a read of the file fails, or a band cannot be read), no page after it is begun, and
 * each one that was is given up at once: its calls are aborted, and what came of it is never
 * taken. The pages before it go on.
 */
function renderedPdf(
  ai: AiFetcher, gatewayId: string | undefined, found: PdfImages, readRange: PdfRangeReader,
  renderer: PdfRendering, source: PdfSource, slots: CallSlots,
): RenderedPdf {
  /** The PDF open in the renderer, while it is, and how many pages it has once it was opened. */
  let document: PdfDocument | undefined;
  let count: number | undefined;
  /** How many pages the open document has rendered. */
  let rendered = 0;
  /** What is being done with the PDF, or was last, settled either way. */
  let turn: Promise<void> = Promise.resolve();
  let options = { bands: BANDS, denseLines: DENSE_LINES };
  /** The text's budget of drawn pixels, for the pages asked for ahead. */
  let room = pixelRoom();
  /** The pages asked for ahead and not yet taken: what comes of each, and what gives it up. */
  let asked = new Map<number, { outcome: Promise<PageOutcome | undefined>; abort: AbortController }>();
  /** The draw of the page last asked for ahead, settled either way. */
  let draws: Promise<void> = Promise.resolve();
  /** The first page asked for ahead that failed. */
  let failedAt = Infinity;
  /** The page asked for ahead that the reader is waiting for, while it is. */
  let waited: number | undefined;
  let dispose = () => {
    document?.[Symbol.dispose]();
    document = undefined;
  };
  /** Has the model read one band, from a PNG deflated as the request reads it. */
  let call: BandCall = ({ pixels, rows }, width, signal) => transcribeImage(ai, gatewayId, {
    mimeType: "image/png",
    body: pngFromSamples(inSteps(pixels!), { width, height: rows },
      { colorType: 0, bitDepth: 8, rowBytes: width, filtered: false }, MAX_IMAGE_BYTES),
  }, signal, { band: true });

  /** Opens the PDF, `again` being why when it was open before. */
  let open = async (
    signal: AbortSignal, moved: () => void, again?: string,
  ): Promise<Unrendered | undefined> => {
    let data = await readRange({ offset: 0, length: found.bytes, fileSize: found.bytes });
    if (signal.aborted) await data.cancel().catch(() => undefined);
    signal.throwIfAborted();
    let reader = data.getReader();
    let handed!: ReadableStreamDefaultController<Uint8Array>;
    /** Whether the stream handed over has ended, and what the read of the file failed with. */
    let done = false;
    let failure: { error: unknown } | undefined;
    let stream = new ReadableStream<Uint8Array>({
      start(controller) { handed = controller; },
      async pull(controller) {
        try {
          let chunk = await reader.read();
          // Ended while the file was being waited on.
          if (done) return;
          if (chunk.done) {
            done = true;
            return controller.close();
          }
          moved();
          controller.enqueue(chunk.value);
        } catch (error) {
          if (done) return;
          done = true;
          // The call fails with words of its own for a stream that broke off: this is why.
          failure = { error };
          controller.error(error);
        }
      },
      cancel(reason) {
        done = true;
        return reader.cancel(reason);
      },
    }, { highWaterMark: 0 });
    /** Lets the read of the file go, when the stream handed over has not ended. */
    let letGo = (reason?: unknown) => {
      if (done) return false;
      done = true;
      void reader.cancel(reason).catch(() => undefined);
      return true;
    };
    // The call has the stream locked, so it is ended from inside: errored, and the read let go.
    let ended = () => {
      if (letGo(signal.reason)) handed.error(signal.reason);
    };
    signal.addEventListener("abort", ended, { once: true });
    let opened: Awaited<ReturnType<PdfRendering["open"]>> | undefined;
    let unopened: Unrendered | undefined;
    try {
      opened = await renderer.open(stream, found.bytes);
      if ("refused" in opened) unopened = { reason: opened.refused };
    } catch (error) {
      unopened = { reason: "call", error };
    } finally {
      signal.removeEventListener("abort", ended);
    }
    moved();
    // A call that answered without reading the file to its end leaves the read to be let go.
    letGo();
    if (opened && !("refused" in opened)) {
      // One that arrives once the text has ended is let go as this call ends: see `release`.
      document = opened.document;
      count = opened.pages;
      rendered = 0;
    }
    if (failure) throw failure.error;
    signal.throwIfAborted();
    if (unopened?.reason === "size-mismatch") throw new Error(source.changed);
    if (!unopened) {
      log(source).info("rendering a Drive PDF's pages", {
        event: "google.drive.pdf.rendering", pdfBytes: found.bytes, ocrPages: count,
        ...(again ? { reason: again } : {}),
      });
    }
    return unopened;
  };

  /** Notes that page `index` failed: each page after it that was begun is given up at once. */
  let failed = (index: number) => {
    failedAt = Math.min(failedAt, index);
    for (let [later, page] of asked) {
      if (later <= index) continue;
      page.abort.abort();
      asked.delete(later);
    }
  };

  let pdf: RenderedPdf = {
    get pages() { return count; },
    async render(index, signal, moved) {
      let page = index + 1;
      for (;;) {
        let answer: RenderedPage | RenderRefused | undefined;
        let error: unknown;
        try {
          answer = await document!.renderPage(index, options);
        } catch (thrown) {
          error = thrown;
        }
        moved();
        // A page that was being rendered as the text ended is of no use to it.
        signal.throwIfAborted();
        // A page, or the refusal of this page alone, after which those after it are still drawn.
        if (answer && !("refused" in answer && !answer.ofPage)) {
          // Nothing more is asked of the document once its last page has answered.
          if (page === count) dispose();
          if ("refused" in answer) {
            let { refused: reason, heapBytes, work } = answer;
            log(source).warn("a Drive PDF page could not be drawn", {
              event: "google.drive.pdf.page_undrawn", page, reason, heapBytes, work,
            });
            return answer;
          }
          rendered++;
          let { width, height, bands, blank, images, dpi, reduced, cost } = answer;
          log(source).info("rendered a Drive PDF page", {
            event: "google.drive.pdf.page_rendered", page, width, height, bands: bands.length, blank,
            images, dpi, reduced, ...cost,
          });
          return answer;
        }
        dispose();
        let unrendered: Unrendered = answer
          ? { reason: answer.refused, page, heapBytes: answer.heapBytes, work: answer.work }
          : { reason: "call", page, error };
        // Only a document that is lost, having rendered a page, is worth opening again.
        if ((answer && answer.refused !== "released") || rendered === 0) return unrendered;
        let unopened = await open(signal, moved, unrendered.reason);
        if (unopened) return unopened;
      }
    },
    read: (page, index, signal, moved) => readBands(page, call, signal, moved, event => {
      log(source).info("transcribed a band of a Drive PDF page", {
        event: "google.drive.pdf.band_transcribed", page: index + 1, ...event,
      });
    }, slots.of(index)),
    ahead(index, signal, moved) {
      if (index > failedAt) return;
      /** Gives the page up: aborted with the text's signal, and when a page before it fails. */
      let abort = new AbortController();
      let ended = () => abort.abort(signal.reason);
      signal.addEventListener("abort", ended, { once: true });
      if (signal.aborted) ended();
      let fail = () => failed(index);
      let hold: PixelHold | undefined;
      let drawn = draws.then(async () => {
        abort.signal.throwIfAborted();
        hold = await room.reserve(RENDER_LIMITS.pagePixels, abort.signal, () => waited === index);
        if (count === undefined) {
          let unopened = await open(abort.signal, moved);
          if (unopened) return { unrendered: unopened };
        }
        if (index >= count!) return undefined;
        let page = await pdf.render(index, abort.signal, moved);
        return "reason" in page ? { unrendered: page } : page;
      });
      // A page that failed is noted before the next is begun.
      draws = drawn.then(page => { if (page && "unrendered" in page) fail(); }, fail);
      let outcome = drawn.then(async (page): Promise<PageOutcome | undefined> => {
        if (!page || "unrendered" in page) return page;
        if ("refused" in page) return { undrawn: true };
        if (page.blank) return { blank: true, images: page.images, surveyed: page.surveyed };
        // From here on the page's pixels are those of its bands.
        hold!.resize(page.bands.reduce((bytes, band) => bytes + (band.pixels?.byteLength ?? 0), 0));
        try {
          let { text, cutOff } = await pdf.read(page, index, abort.signal, moved);
          return { text, cutOff, reduced: page.reduced };
        } catch (error) {
          fail();
          return { failed: error };
        }
      }).finally(() => {
        hold?.release();
        signal.removeEventListener("abort", ended);
      });
      asked.set(index, { outcome, abort });
      turn = Promise.allSettled([turn, outcome]).then(() => undefined);
    },
    async take(index) {
      waited = index;
      room.recheck();
      try {
        return await asked.get(index)!.outcome;
      } finally {
        waited = undefined;
        asked.delete(index);
      }
    },
    release: () => void turn.then(dispose),
  };
  return pdf;
}

/** Logs why a PDF's pages are not rendered, or not rendered any further, by the reason word. */
function renderFailed(unrendered: Unrendered, source: PdfSource): void {
  log(source).warn("a Drive PDF could not be rendered", {
    event: "google.drive.pdf.render_failed", ...unrendered,
  });
}

/**
 * The pages of a scanned PDF, rendered: see {@link renderedPdf}. A page is given once all of it
 * has been read, as the text under its heading. One that could not be drawn within the
 * renderer's limits, and one that comes out blank though it holds an image, is a line that says
 * so; a blank page with no image is its heading alone; a page drawn at a lower resolution, or
 * whose text ends early, has a line to follow it.
 *
 * Nothing is done until the first page is asked for. From then on every page from the reader's
 * on is asked of `pdf` ahead of the reader ({@link RenderedPdf.ahead}), so that it is drawn and
 * read while the pages before it are: up to {@link READ_AHEAD}'s `pages` are begun and not yet
 * given, the reader's among them. A page that fails, and the text with it, does so when the
 * reader gets to it, after the pages before it.
 *
 * When the renderer has no room, cannot be reached or cannot open the file, and `stored` is
 * given, the page images as they are stored, they are what the text is read from instead
 * ({@link storedPages}). That is settled before any page is given, since stored pages are
 * numbered in the file's order: a text never changes from one to the other partway. Without it
 * the text fails: in words when the renderer finds the file encrypted, had no room or could not
 * be reached, and as a failed transcription otherwise, as it does when the PDF is rendered no
 * further partway.
 */
function renderedPages(
  pdf: RenderedPdf, found: PdfImages, stored: PageSource | undefined, source: PdfSource,
): PageSource {
  /** The stored page images, once they are what the text is read from. */
  let fallback: PageSource | undefined;
  /** The page to ask of `pdf` next, from 0. */
  let ahead = 0;
  /** What the reader is to be told has moved, while it waits for a page. */
  let reader: (() => void) | undefined;
  let touch = () => reader?.();
  /** What the text fails with when the PDF is not rendered, logged by the reason word. */
  let failed = (unrendered: Unrendered, first: boolean): Error => {
    let { reason } = unrendered;
    if (reason === "encrypted") return refusal(source, found, "it is encrypted");
    renderFailed(unrendered, source);
    let busy = reason === "room" || (first && reason === "call");
    return new Error(busy ? RENDERER_BUSY : source.transcriptionFailed);
  };

  return {
    async next(index, signal, moved) {
      if (fallback) return fallback.next(index, signal, moved);
      // How many pages there are is known once the first has been taken.
      let last = Math.min(pdf.pages ?? Infinity, index + READ_AHEAD.pages);
      while (ahead < last) pdf.ahead(ahead++, signal, touch);
      if (index === pdf.pages) return undefined;
      let page: PageOutcome | undefined;
      // What is drawn and read ahead moves the text only while its reader waits.
      reader = moved;
      try {
        page = await pdf.take(index);
      } finally {
        reader = undefined;
      }
      if (!page) return undefined;
      if ("unrendered" in page) {
        // A PDF that has no page count was not opened, which only its first page finds.
        let first = pdf.pages === undefined;
        if (first && stored && page.unrendered.reason !== "encrypted") {
          log(source).warn("a Drive PDF is transcribed as stored, for want of the renderer", {
            event: "google.drive.pdf.renderer_fallback", route: "stored", ...page.unrendered,
          });
          fallback = stored;
          return fallback.next(index, signal, moved);
        }
        throw failed(page.unrendered, first);
      }
      if ("failed" in page) throw page.failed;
      // What is of this page alone is said in its place, and the pages after it are still read.
      if ("undrawn" in page) return { text: UNDRAWN_PAGE };
      // A page without ink has nothing for a model to read; one that holds an image, or may
      // hold one that was not counted, may be a blank side of a sheet, or an image that could
      // not be decoded, and says so.
      if ("blank" in page) return { text: page.images > 0 || !page.surveyed ? BLANK_PAGE : "" };
      return { text: `${page.text}${page.cutOff ? CUT_OFF : ""}${page.reduced ? REDUCED_PAGE : ""}` };
    },
    fields: index => fallback ? fallback.fields(index)
      : pdf.pages !== undefined && index < pdf.pages ? { page: index + 1 } : {},
    release: pdf.release,
  };
}

/**
 * A page of a PDF's own text that has none: its number, from 1, and how many line breaks came
 * after its heading's line, which are all its section held.
 */
type EmptyPage = { page: number; breaks: number };

/**
 * Reads a conversion's text, from its first page heading on, for the pages that have no text.
 * What it is fed comes back as it was, in pieces, but for the line breaks that are all a page's
 * section holds: those are counted, not kept, and stand among the pieces as an
 * {@link EmptyPage}, in whose place the page's text is put when its image is read, or the line
 * breaks given back.
 *
 * A line is a page's heading only when it reads "### Page N" with N one more than the page
 * before, from 1, and comes first of all or after {@link HEADING_BREAKS} line breaks on end.
 * The conversion passes a line of the document's own that reads so as it is, but it follows a
 * line of the page's text or the page's heading directly, where no heading does. A heading is
 * given as soon as its line has ended, and only a line that may yet be the next heading is held.
 */
class PageSections {
  /** The last page whose heading was read. */
  #page = 0;
  /** Line breaks on end before the line being read: as many as a heading follows, to begin with. */
  #breaks = HEADING_BREAKS;
  /** The line being read, from its start, while it may yet be the next page's heading. */
  #line: string | undefined;
  /** Line breaks counted since a page's heading, while its section has held nothing else. */
  #empty: number | undefined;

  /** Reads the next piece of the text. */
  feed(data: string): (string | EmptyPage)[] {
    let pieces: (string | EmptyPage)[] = [];
    let own = "";
    /** Takes `text` for the document's own, after the line breaks counted before it. */
    let take = (text: string) => {
      own += "\n".repeat(this.#empty ?? 0) + text;
      this.#empty = undefined;
      this.#line = undefined;
      this.#breaks = 0;
    };
    for (let at = 0; at < data.length;) {
      let end = data.indexOf("\n", at);
      let part = data.slice(at, end < 0 ? data.length : end);
      at = end < 0 ? data.length : end + 1;
      let heading = `### Page ${this.#page + 1}`;
      if (part !== "") {
        let line = (this.#line ?? "") + part;
        let held = this.#line !== undefined || this.#breaks >= HEADING_BREAKS;
        if (held && heading.startsWith(line)) this.#line = line;
        else take(line);
      }
      if (end < 0) break;
      if (this.#line === heading) {
        if (this.#empty !== undefined) {
          if (own !== "") pieces.push(own);
          pieces.push({ page: this.#page, breaks: this.#empty });
          own = "";
        }
        own += `${heading}\n`;
        this.#page++;
        this.#empty = 0;
        this.#line = undefined;
        this.#breaks = 1;
        continue;
      }
      if (this.#line !== undefined) take(this.#line);
      if (this.#empty === undefined) own += "\n";
      else this.#empty++;
      this.#breaks++;
    }
    if (own !== "") pieces.push(own);
    return pieces;
  }

  /** Reads the end of the text: a line it ends in is text, and a last page may have none. */
  end(): (string | EmptyPage)[] {
    if (this.#line !== undefined) return ["\n".repeat(this.#empty ?? 0) + this.#line];
    return this.#empty === undefined ? [] : [{ page: this.#page, breaks: this.#empty }];
  }
}

/**
 * The text of a PDF that has text of its own, with the pages of it that have none read from
 * their images. It is the conversion's text from its first page heading on: `passed` pages
 * without text, whose headings the search for the text went past and are given again as the
 * conversion gives them, then `first`, then what `conversion` goes on to give. Read through
 * {@link PageSections}, it is passed on as it is, so that a PDF none of whose pages is read from
 * its image has the conversion's text to the byte.
 *
 * From its first read on, the text is read ahead of its reader and held in pieces, while it
 * holds under {@link READ_AHEAD}'s `ownTextChars` characters of the document's own and fewer
 * than its `pages` pages without text are asked for and not yet given. A page whose section
 * holds nothing but line breaks is asked of `pdf` as it is found ({@link RenderedPdf.ahead}), so
 * that it is drawn and read while the text before it is; `pdf` is opened for the first such
 * page, so a PDF whose pages all have text is never read again. When the page is one `pdf` has
 * and is not blank, the vision model reads it, and what it reads takes the place of the line
 * breaks: under {@link READ_FROM_IMAGE} and an empty line, followed by the lines that say it
 * was cut off or drawn at a lower resolution, and by an empty line. A page that is blank, could
 * not be drawn within the renderer's limits, or reads as nothing is left as the conversion gave
 * it.
 *
 * The document's own text is worth more than the pages missing from it, so what keeps a page
 * from being read does not fail the text: a PDF the renderer does not open, or renders no
 * further, and a page the model fails on, are logged by their reason, that page gets
 * {@link UNREAD_PAGES} in place of its text, and no page after it is read: what came of one
 * that was begun is not used. The text does fail with what a read of the file failed with, a
 * changed file included, since it is then the text of another version; and with a failure of
 * the conversion's, in our words: each once the reader has been given all that came before it.
 */
function mixedPages(
  conversion: MarkdownConversion, passed: number, first: string | undefined, pdf: RenderedPdf,
  source: PdfSource,
): PageSource {
  let sections = new PageSections();
  /** What was read of the text and is yet to be given, and whether that was the end of it. */
  let pieces: (string | EmptyPage)[] = [];
  let ended = false;
  /** How many characters of the document's own text are among `pieces`. */
  let held = 0;
  /** The pages without text that were found and are yet to be asked of `pdf`, from 0. */
  let found: number[] = [];
  /** How many pages were asked of `pdf` and are not yet given. */
  let begun = 0;
  /** What reading on in the text failed with, for the reader to be given when it gets there. */
  let failure: { error: unknown } | undefined;
  /** The reading ahead, from the reader's first read on. */
  let looking: Promise<void> | undefined;
  /** What the reader is to be told has moved, while it waits for something. */
  let reader: (() => void) | undefined;
  let touch = () => reader?.();
  /** Those waiting on each other: the reader for a piece, the reading ahead for room. */
  let waiters: (() => void)[] = [];
  let wait = () => new Promise<void>(resolve => waiters.push(resolve));
  let wake = () => {
    for (let go of waiters.splice(0)) go();
  };
  /** How many of the pages before the text's first have been given their headings again. */
  let led = 0;
  /** The page being read from its image, while one is. */
  let page: number | undefined;
  /** Whether no further page is rendered. */
  let gaveUp = false;
  /** Gives up on the pages without text, at one that is given a line to say so. */
  let giveUp = (): string => {
    gaveUp = true;
    found = [];
    begun = 0;
    pdf.release();
    return `${UNREAD_PAGES}\n\n`;
  };

  /** Asks `pdf` for the pages found, as many as may be begun and not yet given. */
  let hand = (signal: AbortSignal) => {
    while (begun < READ_AHEAD.pages && found.length > 0) {
      pdf.ahead(found.shift()!, signal, touch);
      begun++;
    }
  };

  /**
   * Reads on in the text, as far as the next piece of it, or to its end, and asks `pdf` for the
   * pages without text found in it.
   */
  let more = async (signal: AbortSignal) => {
    let data: string | undefined;
    if (led < passed) {
      data = `### Page ${++led}\n${NO_TEXT}`;
    } else if (first !== undefined) {
      data = first;
      first = undefined;
    } else {
      try {
        data = await conversion.next();
      } catch (error) {
        // Ending the text ends a read in progress as if the response had broken off.
        throw signal.aborted ? error : reported(error, source);
      }
      touch();
    }
    // A response that had arrived whole ends, when the text does, as if it had ended of
    // itself: no page is begun for a text that has ended.
    signal.throwIfAborted();
    ended = data === undefined;
    for (let piece of data === undefined ? sections.end() : sections.feed(data)) {
      pieces.push(piece);
      if (typeof piece === "string") held += piece.length;
      else if (!gaveUp) found.push(piece.page - 1);
    }
    hand(signal);
  };

  /** Reads the text ahead of its reader, to its end, waiting whenever no more of it may be held. */
  let look = async (signal: AbortSignal) => {
    try {
      // eslint-disable-next-line no-unmodified-loop-condition -- more() sets this.
      while (!ended) {
        while (held >= READ_AHEAD.ownTextChars || begun >= READ_AHEAD.pages) {
          await wait();
          signal.throwIfAborted();
        }
        await more(signal);
        wake();
      }
    } catch (error) {
      failure = { error };
      wake();
    }
  };

  /** What takes the place of an empty page's line breaks, or `undefined` to leave them. */
  let read = async (index: number, signal: AbortSignal): Promise<string | undefined> => {
    let came: PageOutcome | undefined;
    try {
      came = await pdf.take(index);
    } finally {
      begun--;
    }
    // A page with ink is read whatever it draws: a scan, an image written into its content, or
    // writing drawn as shapes. One that is blank, or could not be drawn, has nothing to show.
    if (!came || "undrawn" in came || "blank" in came) return undefined;
    if ("unrendered" in came) {
      renderFailed(came.unrendered, source);
      return giveUp();
    }
    if ("failed" in came) {
      if (signal.aborted || !transcriptionFailed(came.failed, { page: index + 1 }, source)) throw came.failed;
      return giveUp();
    }
    if (came.text === "") return undefined;
    return `${READ_FROM_IMAGE}\n\n${came.text}${came.cutOff ? CUT_OFF : ""}${came.reduced ? REDUCED_PAGE : ""}\n\n`;
  };

  let next = async (signal: AbortSignal): Promise<SourcedPage | undefined> => {
    looking ??= look(signal);
    for (;;) {
      while (pieces.length === 0) {
        if (failure) throw failure.error;
        if (ended) return undefined;
        await wait();
        signal.throwIfAborted();
      }
      let piece = pieces.shift()!;
      if (typeof piece === "string") {
        held -= piece.length;
        wake();
        return { own: piece };
      }
      page = piece.page;
      let text = gaveUp ? undefined : await read(page - 1, signal);
      page = undefined;
      // What was given makes room for the text to be read on, and for a page more.
      hand(signal);
      wake();
      text ??= "\n".repeat(piece.breaks);
      // A pull that is given nothing is not called again, so go on until there is text.
      if (text !== "") return { own: text };
    }
  };

  return {
    async next(_index, signal, moved) {
      // What is read ahead moves the text only while its reader waits.
      reader = moved;
      try {
        return await next(signal);
      } finally {
        reader = undefined;
      }
    },
    fields: () => page === undefined ? {} : { page },
    release() {
      void conversion.cancel().catch(() => undefined);
      pdf.release();
      wake();
    },
  };
}

/** `bytes` as a stream that hands them over {@link BAND_STEP_BYTES} at a time, as they are read. */
function inSteps(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      let end = Math.min(bytes.byteLength, at + BAND_STEP_BYTES);
      controller.enqueue(bytes.subarray(at, end));
      at = end;
      if (at === bytes.byteLength) controller.close();
    },
  }, { highWaterMark: 0 });
}

/**
 * The transcription of a scanned PDF's `pages`, as UTF-8 Markdown under the "### Page N" headings
 * a conversion gives, numbered as `pages` orders them. Nothing is done until it is read, and
 * `pages` is then asked for one page at a time, each once the page before it has been read to
 * its end: what `pages` does ahead of that is its own. A page whose image is sent as stored
 * comes as the model's answer to it, begun already, and the answer's text is passed on in the
 * pieces it arrived in. A page that `pages` has read already is given whole, in one read.
 * Cancelling it gives up what `pages` has in flight, and reads no more. So does
 * {@link TRANSCRIPTION_IDLE_MS} with nothing moving, counted from now, which errors the text: a
 * cancel sent over RPC is not delivered while a read is waiting on the model, so a model that
 * stalls would otherwise hold its request, and whatever the text's reads rely on, for good.
 *
 * The text of a PDF that has text of its own is read the same way, and ends the same ways.
 * `pages` then gives it in pieces, its page headings in them, and each is passed on as it is.
 *
 * However the text ends, what `pages` has in flight is given up and what it holds let go.
 *
 * A failed transcription is logged by page, size and status only, never by the service's text,
 * and errors the stream in our words, and so does a page image whose data proves not to be what
 * the file says of it; anything else `pages` fails with, such as a failure of a read of the
 * file, is passed on as it is.
 */
function transcription(pages: PageSource, source: PdfSource): ReadableStream<Uint8Array> {
  let encoder = new TextEncoder();
  /**
   * The page being transcribed, from 0, and the model's answer to it while that is being given,
   * when it is one whose image is sent as stored.
   */
  let index = 0;
  let current: Pick<Transcription, "truncated" | "next"> | undefined;
  /** Gives up what `pages` has in flight. */
  let over = new AbortController();
  /** Whether the text was cancelled or sat idle, either of which stops the page in progress. */
  let ended = false;
  /** When the text last moved: asked for, handed over, or something it waits on arriving. */
  let moved = Date.now();
  let timer!: ReturnType<typeof setTimeout>;
  let touch = () => { moved = Date.now(); };
  /** Lets go of what the text holds once it has ended, failed, been cancelled or sat idle. */
  let letGo = (reason?: unknown) => {
    clearTimeout(timer);
    over.abort(reason);
    pages.release();
  };
  let end = (reason?: unknown) => {
    ended = true;
    letGo(reason);
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      // One timer for the whole text, set again only when it fires, as for a file's bytes.
      let check = () => {
        let left = moved + TRANSCRIPTION_IDLE_MS - Date.now();
        if (left > 0) {
          timer = setTimeout(check, left);
          return;
        }
        controller.error(new Error(TRANSCRIPTION_IDLE));
        end();
        // No page is in progress once the last has been transcribed and only its end is unread.
        log(source).warn("a Drive PDF's transcription sat idle", {
          event: "google.drive.pdf.transcription_idle", ...pages.fields(index),
        });
      };
      timer = setTimeout(check, TRANSCRIPTION_IDLE_MS);
    },
    async pull(controller) {
      touch();
      let give = (text: string) => {
        touch();
        controller.enqueue(encoder.encode(text));
      };
      try {
        // A pull that enqueues nothing is not called again, so go on until there is text.
        for (;;) {
          if (!current) {
            let page = await pages.next(index, over.signal, touch);
            // Ended as the page was made ready: nothing more is given or asked for.
            if (ended) return;
            if (!page) {
              letGo();
              return controller.close();
            }
            if ("own" in page) {
              index++;
              return give(page.own);
            }
            let heading = `${index > 0 ? "\n\n" : ""}### Page ${index + 1}\n`;
            if ("text" in page) {
              index++;
              return give(heading + page.text);
            }
            current = page.answer;
            return give(heading);
          }
          let piece = await current.next();
          // Ended while the page's answer was being let go: no further page is begun.
          if (ended) return;
          if (piece !== undefined) return give(piece);
          let cutOff = current.truncated;
          current = undefined;
          index++;
          if (cutOff) return give(CUT_OFF);
        }
      } catch (error) {
        // Ending the text ends a read in progress as if the response had broken off.
        if (ended) return;
        letGo();
        if (!transcriptionFailed(error, pages.fields(index), source)) return controller.error(error);
        controller.error(new Error(source.transcriptionFailed));
      }
    },
    cancel: end,
  }, { highWaterMark: 0 });
}

/**
 * Whether `error` is a page's transcription failing: the model's failure, or a page image whose
 * data is not what was said of it. It is then logged by `fields`, size and status only.
 */
function transcriptionFailed(
  error: unknown, fields: { page?: number; imageEncoding?: string }, source: PdfSource,
): boolean {
  let failure = error instanceof TranscriptionError
    ? { imageBytes: error.sentBytes, ...error.failure }
    : error instanceof ImageDataError ? { error } : undefined;
  if (!failure) return false;
  log(source).warn("a Drive PDF page could not be transcribed", {
    event: "google.drive.pdf.transcription_failed", ...fields, ...failure,
  });
  return true;
}

/**
 * `text`, read only as the result is, with `release` called once it has ended, failed or been
 * cancelled, even while nothing is reading it: for letting go of what a text's reads rely on and
 * nothing else holds.
 */
export function releasedAtEnd(
  text: ReadableStream<Uint8Array>, release: () => void,
): ReadableStream<Uint8Array> {
  let reader = text.getReader();
  void reader.closed.then(release, release);
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let chunk = await reader.read();
      // Cancelled while the text was being waited on.
      if (cancelled) return;
      if (chunk.done) controller.close();
      else controller.enqueue(chunk.value);
    },
    cancel(reason) {
      cancelled = true;
      return reader.cancel(reason);
    },
  }, { highWaterMark: 0 });
}

/**
 * `error` as a PDF read reports it: a failed conversion is logged by why it failed and replaced by
 * `source`'s words for it; anything else, such as the PDF stream's own failure, is kept as it is.
 */
function reported(error: unknown, source: PdfSource): unknown {
  if (!(error instanceof MarkdownConversionError)) return error;
  log(source).warn("Workers AI failed to convert a PDF", {
    event: "google.drive.pdf.failed", pdfBytes: error.sentBytes, ...error.failure,
  });
  return new Error(source.conversionFailed);
}

/**
 * Finds where a conversion's text begins: past the preamble at the very start, blank lines, and
 * "### Page N" headings of the pages before the first with text. It holds only the line being read
 * (from its first character that is not whitespace, at most {@link MAX_HEADING_CHARS} of it), the
 * last heading seen, what it counts of those before it and of the line breaks since it, and what
 * remains of the piece in which the text begins.
 */
class TextStart {
  /**
   * The text from the last heading before it on, or from its own line when no heading came first,
   * once found.
   */
  text: string | undefined;
  /** How many headings came before the last one seen. */
  passed = 0;
  /**
   * Whether the line breaks from each of those headings to the one after it were a page without
   * text's: the heading's own, then {@link NO_TEXT}. A line of a page's own that reads as a
   * heading follows that page's heading, or a line of its text, directly.
   */
  passedEmpty = true;
  /** Characters of the preamble matched so far, or -1 once it has been passed or ruled out. */
  #preamble = 0;
  /** Line breaks read since the last heading. */
  #breaks = 0;
  #line = "";
  /** Whether the line being read began with whitespace, which a heading never does. */
  #indented = false;
  #heading: string | undefined;

  /** Reads the next piece of the conversion's text. */
  feed(data: string): void {
    if (this.#preamble >= 0) {
      let matched = 0;
      while (matched < data.length && this.#preamble + matched < PREAMBLE.length &&
          data[matched] === PREAMBLE[this.#preamble + matched]) {
        matched++;
      }
      this.#preamble += matched;
      data = data.slice(matched);
      if (this.#preamble === PREAMBLE.length) this.#preamble = -1;
      else if (data === "") return;
      else data = this.#leavePreamble() + data;
    }
    this.#scan(data);
  }

  /** Reads the end of the conversion's text. */
  end(): void {
    if (this.#preamble > 0) this.#scan(this.#leavePreamble());
    if (this.text === undefined && this.#lineIsText()) this.#found("");
  }

  /** What was taken for the preamble, read as text after all once the data parts from it. */
  #leavePreamble(): string {
    let matched = PREAMBLE.slice(0, this.#preamble);
    this.#preamble = -1;
    return matched;
  }

  #scan(data: string): void {
    for (let i = 0; i < data.length && this.text === undefined; i++) {
      let ch = data[i]!;
      if (ch === "\n") {
        if (this.#lineIsText()) {
          this.#found(data.slice(i));
        } else {
          this.#line = "";
          this.#indented = false;
          this.#breaks++;
        }
      } else if (this.#line === "" && /\s/.test(ch)) {
        this.#indented = true;
      } else {
        this.#line += ch;
        if (this.#line.length > MAX_HEADING_CHARS) this.#found(data.slice(i + 1));
      }
    }
  }

  /** Whether the line read holds text, noting it as the last heading when it is one. */
  #lineIsText(): boolean {
    if (this.#line === "") return false;
    if (this.#indented || !PAGE_HEADING.test(this.#line)) return true;
    if (this.#heading !== undefined) {
      this.passed++;
      this.passedEmpty &&= this.#breaks === 1 + NO_TEXT.length;
    }
    this.#heading = this.#line;
    this.#breaks = 0;
    return false;
  }

  #found(rest: string): void {
    this.text = `${this.#heading === undefined ? "" : `${this.#heading}\n`}${this.#line}${rest}`;
  }
}
