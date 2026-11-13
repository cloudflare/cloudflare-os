// A Drive PDF's text, from Workers AI's markdown conversion, streamed in both directions: neither
// the PDF nor its text is ever held whole. A scanned PDF has no text to convert, so its pages are
// transcribed by a vision model instead, one at a time, as the text is read. A scan small enough
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
import { readBands, type BandCall } from "./pdf-bands";
import { MAX_PAGE_IMAGES, PdfImageScan, type PdfImages, type PdfPageImage } from "./pdf-images";
import { ImageDataError, pngFromDeflated, pngFromSamples } from "./pdf-png";
import {
  convertToMarkdown, MarkdownConversionError, type AiFetcher, type MarkdownConversion,
} from "./workers-ai-markdown";
import {
  transcribeImage, TranscriptionError, type ImageSource, type Transcription,
} from "./workers-ai-vision";

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
};

/**
 * The converter a Worker with this environment reads PDFs with ({@link pdfToText}), or `undefined`
 * when it has no `AI` binding to convert with. Under `PDF_OCR=false` it never reads a file again,
 * whatever it is given to do so with: no vision model is called, so a PDF without text comes back
 * with none, and one with text as that text alone. `source` is where the PDFs are read from.
 */
export function pdfConverter(env: PdfEnv, source: PdfSource = DRIVE_PDF): PdfConverter | undefined {
  // `Ai` declares no `fetch`, but the binding has one; conversion goes through it so it can
  // stream. The generated type of a service binding names no method of the entrypoint behind it.
  let ai = env.AI as AiFetcher | undefined;
  let renderer = env.PDF_RENDERER as PdfRendering | undefined;
  let transcribes = env.PDF_OCR?.trim().toLowerCase() !== "false";
  return ai && ((pdf, readRange) =>
    pdfToText(ai, env.CF_AI_GATEWAY, pdf, transcribes ? readRange : undefined, renderer, source));
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
 * The lines of writing past which the renderer is asked to cut a band once more, or `undefined`
 * to ask for no such cut. The renderer counts lines only on a page that is upright (see
 * `RenderOptions.denseLines`), so a number here is to be measured on scans, which seldom are.
 */
const DENSE_LINES = undefined as number | undefined;
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
  /** The page's image as the file stores it: the model's answer to it is the page's text. */
  | { image: ImageSource }
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
 * log lines go under that source's names.
 */
export async function pdfToText(
  ai: AiFetcher, gatewayId: string | undefined, pdf: ReadableStream<Uint8Array>,
  readRange?: PdfRangeReader, renderer?: PdfRendering, source: PdfSource = DRIVE_PDF,
): Promise<PdfRead> {
  let scan = readRange && new PdfImageScan();
  /** Whether the scan was shown the PDF to its end. */
  let scanned = false;
  if (scan) pdf = watched(pdf, chunk => scan.feed(chunk), () => { scanned = true; });
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
        renderedPdf(ai, gatewayId, found, readRange!, renderer, source), found, readRange!, stored, source);
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
      pages = storedPages(found, readRange!);
      log(source).info("transcribing a scanned Drive PDF", {
        event: "google.drive.pdf.transcribing", pdfBytes: found.bytes, ocrPages: found.images.length,
        route: "stored",
      });
    }
    return { text: transcription(ai, gatewayId, pages, source), hasText, transcribed: true, rereads: true };
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
      conversion, start.passed, first!, renderedPdf(ai, gatewayId, found, readRange!, renderer!, source), source);
    return { text: transcription(ai, gatewayId, pages, source), hasText, transcribed: false, rereads: true };
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

/**
 * The page images the scan found, as the file stores them, numbered in the order it stores them.
 * A page's image is read from the file through `readRange` when the text has been read up to
 * it: a JPEG is sent as it stands, and deflated rows wrapped as a PNG without being inflated.
 * Nothing is held between pages, and each piece of an image that arrives counts as the text
 * moving, as does each piece `readRange` says it passed over on its way to one.
 */
function storedPages({ images, bytes: fileSize }: PdfImages, readRange: PdfRangeReader): PageSource {
  return {
    async next(index, signal, moved) {
      let image = images[index];
      if (!image) return undefined;
      let { offset, length } = image;
      let read = await readRange({ page: index + 1, offset, length, fileSize }, moved);
      if (signal.aborted) {
        await read.cancel().catch(() => undefined);
        throw new Error("cancelled");
      }
      // The image is sent as it arrives, and nothing of the text moves until the model answers:
      // each piece that arrives is what shows that a large image is on its way and not stalled.
      let data = watched(read, moved, () => undefined);
      return {
        image: image.png
          ? { mimeType: "image/png", body: pngFromDeflated(data, image, image.png, MAX_IMAGE_BYTES) }
          : { mimeType: "image/jpeg", body: data },
      };
    },
    fields: index => images[index] ? { page: index + 1, imageEncoding: images[index].encoding } : {},
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

/** The PDF the scan found, as the renderer holds it for one text: see {@link renderedPdf}. */
type RenderedPdf = {
  /** How many pages the PDF has, once it has been opened. */
  readonly pages: number | undefined;
  /**
   * Reads the file whole and has the renderer open it, or returns why it did not. What the read
   * of the file failed with is thrown, a file of another size as a changed one, and so is an
   * end by `signal`.
   */
  open(signal: AbortSignal, moved: () => void): Promise<Unrendered | undefined>;
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
  /** Returns `work`, noted as what is being done with the PDF, for {@link release} to wait for. */
  during<T>(work: Promise<T>): Promise<T>;
  /** Lets the PDF go in the renderer, once what {@link during} last noted has ended. */
  release(): void;
};

/**
 * The PDF the scan found as `renderer` holds it, for the one text that reads pages of it: each
 * page it is asked for is drawn in grey and cut into bands, and each band that has ink is read
 * by the vision model ({@link readBands}), a few at a time. Pages are the page tree's, in its
 * order.
 *
 * Nothing is done until it is opened. Then the whole file is read through `readRange`, a content
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
 * ended. Aborting the signal a call was given gives up the band calls in flight, and ends an
 * `open` in flight by erroring the stream handed to it, which the call has locked; a page being
 * rendered is left to finish.
 */
function renderedPdf(
  ai: AiFetcher, gatewayId: string | undefined, found: PdfImages, readRange: PdfRangeReader,
  renderer: PdfRendering, source: PdfSource,
): RenderedPdf {
  /** The PDF open in the renderer, while it is, and how many pages it has once it was opened. */
  let document: PdfDocument | undefined;
  let count: number | undefined;
  /** How many pages the open document has rendered. */
  let rendered = 0;
  /** What is being done with the PDF, or was last, settled either way. */
  let turn: Promise<void> = Promise.resolve();
  let options = { bands: BANDS, ...(DENSE_LINES === undefined ? {} : { denseLines: DENSE_LINES }) };
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

  return {
    get pages() { return count; },
    open: (signal, moved) => open(signal, moved),
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
    }),
    during(work) {
      turn = work.then(() => undefined, () => undefined);
      return work;
    },
    release: () => void turn.then(dispose),
  };
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
 * When the renderer has no room, cannot be reached or cannot open the file, and `stored` says
 * the page images can be sent as they are stored, they are what the text is read from instead
 * ({@link storedPages}). That is settled before any page is given, since stored pages are
 * numbered in the file's order: a text never changes from one to the other partway. Without it
 * the text fails: in words when the renderer finds the file encrypted, had no room or could not
 * be reached, and as a failed transcription otherwise, as it does when the PDF is rendered no
 * further partway.
 */
function renderedPages(
  pdf: RenderedPdf, found: PdfImages, readRange: PdfRangeReader, stored: boolean, source: PdfSource,
): PageSource {
  /** The stored page images, once they are what the text is read from. */
  let fallback: PageSource | undefined;
  /** What the text fails with when the PDF is not rendered, logged by the reason word. */
  let failed = (unrendered: Unrendered, first: boolean): Error => {
    let { reason } = unrendered;
    if (reason === "encrypted") return refusal(source, found, "it is encrypted");
    renderFailed(unrendered, source);
    let busy = reason === "room" || (first && reason === "call");
    return new Error(busy ? RENDERER_BUSY : source.transcriptionFailed);
  };
  let read = async (
    index: number, signal: AbortSignal, moved: () => void,
  ): Promise<SourcedPage | undefined> => {
    if (fallback) return fallback.next(index, signal, moved);
    if (pdf.pages === undefined) {
      let unopened = await pdf.open(signal, moved);
      if (unopened && stored && unopened.reason !== "encrypted") {
        log(source).warn("a Drive PDF is transcribed as stored, for want of the renderer", {
          event: "google.drive.pdf.renderer_fallback", route: "stored", ...unopened,
        });
        fallback = storedPages(found, readRange);
        return fallback.next(index, signal, moved);
      }
      if (unopened) throw failed(unopened, true);
    }
    if (index === pdf.pages) return undefined;
    let page = await pdf.render(index, signal, moved);
    if ("reason" in page) throw failed(page, false);
    // What is of this page alone is said in its place, and the pages after it are still read.
    if ("refused" in page) return { text: UNDRAWN_PAGE };
    // A page without ink has nothing for a model to read; one that holds an image, or may
    // hold one that was not counted, may be a blank side of a sheet, or an image that could
    // not be decoded, and says so.
    if (page.blank) return { text: page.images > 0 || !page.surveyed ? BLANK_PAGE : "" };
    let { text, cutOff } = await pdf.read(page, index, signal, moved);
    return { text: `${text}${cutOff ? CUT_OFF : ""}${page.reduced ? REDUCED_PAGE : ""}` };
  };

  return {
    next: (index, signal, moved) => pdf.during(read(index, signal, moved)),
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
 * A page whose section holds nothing but line breaks, and that `pdf` has, is rendered once the
 * text has been read up to it; `pdf` is opened for the first such page, so a PDF whose pages
 * all have text is never read again. When the page is not blank, the vision model reads it,
 * and what it reads takes the place of the line breaks: under {@link READ_FROM_IMAGE} and an
 * empty line, followed by the lines that say it was cut off or drawn at a lower resolution,
 * and by an empty line. A page that is blank, could not be drawn within the renderer's limits,
 * or reads as nothing is left as the conversion gave it.
 *
 * The document's own text is worth more than the pages missing from it, so what keeps a page
 * from being read does not fail the text: a PDF the renderer does not open, or renders no
 * further, and a page the model fails on, are logged by their reason, that page gets
 * {@link UNREAD_PAGES} in place of its text, and no page after it is rendered. The text does
 * fail with what a read of the file failed with, a changed file included, since it is then the
 * text of another version; and with a failure of the conversion's, in our words.
 */
function mixedPages(
  conversion: MarkdownConversion, passed: number, first: string | undefined, pdf: RenderedPdf,
  source: PdfSource,
): PageSource {
  let sections = new PageSections();
  /** What was read of the text and is yet to be given, and whether that was the end of it. */
  let pieces: (string | EmptyPage)[] = [];
  let ended = false;
  /** How many of the pages before the text's first have been given their headings again. */
  let led = 0;
  /** The page being read from its image, while one is. */
  let page: number | undefined;
  /** Whether no further page is rendered. */
  let gaveUp = false;
  /** Gives up on the pages without text, at one that is given a line to say so. */
  let giveUp = (): string => {
    gaveUp = true;
    pdf.release();
    return `${UNREAD_PAGES}\n\n`;
  };

  /** Reads on in the text, as far as the next piece of it, or to its end. */
  let more = async (signal: AbortSignal, moved: () => void) => {
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
      moved();
    }
    ended = data === undefined;
    pieces = data === undefined ? sections.end() : sections.feed(data);
  };

  /** What takes the place of an empty page's line breaks, or `undefined` to leave them. */
  let read = async (
    index: number, signal: AbortSignal, moved: () => void,
  ): Promise<string | undefined> => {
    if (pdf.pages === undefined) {
      let unopened = await pdf.open(signal, moved);
      if (unopened) {
        renderFailed(unopened, source);
        return giveUp();
      }
    }
    if (index >= pdf.pages!) return undefined;
    let drawn = await pdf.render(index, signal, moved);
    if ("reason" in drawn) {
      renderFailed(drawn, source);
      return giveUp();
    }
    // A page with ink is read whatever it draws: a scan, an image written into its content, or
    // writing drawn as shapes. One that is blank, or could not be drawn, has nothing to show.
    if ("refused" in drawn || drawn.blank) return undefined;
    let text: string, cutOff: boolean;
    try {
      ({ text, cutOff } = await pdf.read(drawn, index, signal, moved));
    } catch (error) {
      if (signal.aborted || !transcriptionFailed(error, { page: index + 1 }, source)) throw error;
      return giveUp();
    }
    if (text === "") return undefined;
    return `${READ_FROM_IMAGE}\n\n${text}${cutOff ? CUT_OFF : ""}${drawn.reduced ? REDUCED_PAGE : ""}\n\n`;
  };

  let next = async (signal: AbortSignal, moved: () => void): Promise<SourcedPage | undefined> => {
    for (;;) {
      while (pieces.length === 0) {
        if (ended) return undefined;
        await more(signal, moved);
        // A response that had arrived whole ends, when the text does, as if it had ended of
        // itself: no page is begun for a text that has ended.
        signal.throwIfAborted();
      }
      let piece = pieces.shift()!;
      if (typeof piece === "string") return { own: piece };
      page = piece.page;
      let text = gaveUp ? undefined : await read(page - 1, signal, moved);
      page = undefined;
      text ??= "\n".repeat(piece.breaks);
      // A pull that is given nothing is not called again, so go on until there is text.
      if (text !== "") return { own: text };
    }
  };

  return {
    next: (_index, signal, moved) => pdf.during(next(signal, moved)),
    fields: () => page === undefined ? {} : { page },
    release() {
      void conversion.cancel().catch(() => undefined);
      pdf.release();
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
 * then one page at a time. A page whose image is sent as stored is encoded into a vision model's
 * request as it arrives from the file, and the model's text is passed on as it is produced, so
 * neither the image nor the page's text is held whole. A page that `pages` has read already is
 * given whole, in one read. Either way the next page is not asked for until this one has been
 * read to its end. Cancelling it stops the page in progress, giving up its request when the
 * model has not answered yet, and reads no more. So does {@link TRANSCRIPTION_IDLE_MS} with
 * nothing moving, counted from now, which errors the text: a cancel sent over RPC is not
 * delivered while a read is waiting on the model, so a model that stalls would otherwise hold
 * the page's request, and whatever the text's reads rely on, for good.
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
function transcription(
  ai: AiFetcher, gatewayId: string | undefined, pages: PageSource, source: PdfSource,
): ReadableStream<Uint8Array> {
  let encoder = new TextEncoder();
  /**
   * The page being transcribed, from 0, and its transcription once the model has answered, when
   * it is one whose image is sent as stored.
   */
  let index = 0;
  let current: Transcription | undefined;
  /** Gives up the request for the page in progress. */
  let request = new AbortController();
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
  let end = async (reason?: unknown) => {
    ended = true;
    letGo(reason);
    request.abort(reason);
    await current?.cancel(reason);
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
        void end().catch(() => undefined);
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
            // Ended as the page was made ready: nothing more is given or asked for, and an image
            // it came with is let go unread.
            if (ended) return page && "image" in page ? await page.image.body.cancel().catch(() => undefined) : undefined;
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
            request = new AbortController();
            let begun = await transcribeImage(ai, gatewayId, page.image, request.signal);
            if (ended) return await begun.cancel();
            current = begun;
            return give(heading);
          }
          let piece = await current.next();
          // Ended while the page's answer was being let go: no further page is begun.
          if (ended) return;
          if (piece !== undefined) return give(piece);
          log(source).info("transcribed a Drive PDF page", {
            event: "google.drive.pdf.page_transcribed", imageBytes: current.sentBytes,
            ...pages.fields(index),
          });
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
