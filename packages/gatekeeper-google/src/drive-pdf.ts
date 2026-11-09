// A Drive PDF's text, from Workers AI's markdown conversion, streamed in both directions: neither
// the PDF nor its text is ever held whole. A scanned PDF has no text to convert, so when asked its
// page images are transcribed by a vision model instead, one at a time, as the text is read.

import { PDF_MIME_TYPE } from "./drive-session";
import type { DrivePdfText } from "./drive-types";
import { obsContext } from "./observability";
import { MAX_PAGE_IMAGES, PdfImageScan, type PdfImages, type PdfPageImage } from "./pdf-images";
import { ImageDataError, pngFromDeflated } from "./pdf-png";
import {
  convertToMarkdown, MarkdownConversionError, type AiFetcher, type MarkdownConversion,
} from "./workers-ai-markdown";
import { transcribeImage, TranscriptionError, type Transcription } from "./workers-ai-vision";

const logger = obsContext.createLogger({ component: "gatekeeper.google.drive.pdf", vendorId: "google" });

/** One page image's place in a PDF: `length` bytes from `offset`, in a file of `fileSize` bytes. */
export type PdfPageRange = { page: number; offset: number; length: number; fileSize: number };

/**
 * Reads one page image's bytes from the PDF a conversion was given, some time after it. The file
 * may have changed since, so the reader refuses a file that is no longer `fileSize` bytes long.
 */
export type PdfRangeReader = (range: PdfPageRange) => Promise<ReadableStream<Uint8Array>>;

/**
 * Converts one PDF, read from a stream, to its text. It may resolve before reading `pdf` to its end,
 * so a caller that checks the file after converting it must see the end itself. With `readRange`,
 * a PDF that has no text has its page images transcribed, each read through it.
 */
export type PdfConverter = (
  pdf: ReadableStream<Uint8Array>, readRange?: PdfRangeReader,
) => Promise<DrivePdfText>;

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
/**
 * The largest page image sent to be transcribed, as it is stored and as the PNG made of it.
 * Workers AI refuses a request body somewhere between a 12 MiB and a 16 MiB image, and a scanned
 * page is a few megabytes at most.
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

/**
 * Why a scanned PDF cannot be transcribed, in our words. It says things of the file's content
 * (that it has no text of its own, and how its pages are stored), so a caller that authorizes
 * what a read discloses has this to authorize as it has the text.
 */
export class TranscriptionRefusal extends Error {}

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
 * With `readRange`, the PDF's page images are located as its bytes go by, and when it proves to
 * have no text they are transcribed instead: see {@link transcription}. A PDF with any text of
 * its own is returned as that text, and no model is called. One whose pages cannot be
 * transcribed is refused before any is, with a {@link TranscriptionRefusal}.
 */
export async function pdfToText(
  ai: AiFetcher, gatewayId: string | undefined, pdf: ReadableStream<Uint8Array>,
  readRange?: PdfRangeReader,
): Promise<DrivePdfText> {
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
    throw reported(error);
  }
  let first = start.text;
  let hasText = first !== undefined;
  logger.info("converted a Drive PDF", {
    event: "google.drive.pdf.converted", pdfBytes: conversion.sentBytes, hasText,
  });
  if (!hasText) {
    // A conversion that answered before the PDF ended leaves page images unlocated, and the
    // PDF still open.
    if (scan && !scanned) {
      await conversion.cancel();
      throw new Error(CONVERSION_FAILED);
    }
    let pages = scan ? pageImages(scan.end()) : undefined;
    if (!pages || pages.images.length === 0) {
      let text = new ReadableStream<Uint8Array>({ start: controller => controller.close() });
      return { text, hasText, transcribed: false };
    }
    logger.info("transcribing a scanned Drive PDF", {
      event: "google.drive.pdf.transcribing", pdfBytes: pages.bytes, ocrPages: pages.images.length,
    });
    return { text: transcription(ai, gatewayId, pages, readRange!), hasText, transcribed: true };
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
        if (!cancelled) controller.error(reported(error));
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
  return { text, hasText, transcribed: false };
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
 * The page images of a scanned PDF as they can be transcribed, or a {@link TranscriptionRefusal}
 * when they cannot all be: the file is encrypted, a page image is not where the file says, is
 * too large as stored or as the rows that would be inflated, or is in an encoding that is not
 * read. Only JPEG images are, and deflated grey or RGB ones whose rows a PNG can hold. A mask as
 * large as a page that is stored as fax or JBIG2 refuses the PDF as a page stored so does: it is
 * where the text of a layered scan's pages is, and its other layers would be read without it.
 */
function pageImages(found: PdfImages): PdfImages {
  let refuse = (why: string, encoding?: PdfPageImage["encoding"]): never => {
    logger.info("a scanned Drive PDF cannot be transcribed", {
      event: "google.drive.pdf.untranscribable", pdfBytes: found.bytes,
      ocrPages: found.images.length, ...(encoding ? { imageEncoding: encoding } : {}),
    });
    throw new TranscriptionRefusal(
      `The PDF has no text of its own, and ${why}, so it cannot be transcribed.`);
  };
  if (found.encrypted) refuse("it is encrypted");
  if (found.more) refuse(`it has more than ${MAX_PAGE_IMAGES} page images`);
  if (found.maskEncoding) {
    refuse("a mask the size of a page, which is where a layered scan keeps its text, is stored in " +
      `an image encoding that is not read yet, ${UNREAD_ENCODINGS[found.maskEncoding]}`,
      found.maskEncoding);
  }
  for (let image of found.images) {
    let { encoding } = image;
    if (encoding !== "jpeg" && encoding !== "lossless") {
      refuse(`its pages are stored in an image encoding that is not read yet, ${
        UNREAD_ENCODINGS[encoding]}; only JPEG pages are, and deflated grey or RGB ones that a ` +
        "PNG can hold as they are stored", encoding);
    }
    if (image.damaged) refuse("a page image is not where the file says it is", encoding);
    let inflated = image.png && !image.png.filtered ? image.height * image.png.rowBytes : 0;
    if (image.length > MAX_IMAGE_BYTES || inflated > MAX_INFLATED_BYTES) {
      refuse("a page image is too large", encoding);
    }
  }
  return found;
}

/**
 * The transcription of a scanned PDF's `pages`, as UTF-8 Markdown under the "### Page N" headings
 * a conversion gives, numbered in the order the file stores the images. Nothing is done until it
 * is read, and then one page at a time: a page's image is read from the file through `readRange`
 * and encoded into a vision model's request as it arrives, and the model's text is passed on as
 * it is produced, so the next page is not asked for until this one has been read to its end, and
 * neither an image nor a page's text is held whole. Cancelling it stops the page in progress,
 * giving up its request when the model has not answered yet, and reads no more. So does
 * {@link TRANSCRIPTION_IDLE_MS} with nothing moving, counted from now, which errors the text: a
 * cancel sent over RPC is not delivered while a read is waiting on the model, so a model that
 * stalls would otherwise hold the page's request, and whatever the text's reads rely on, for good.
 *
 * A failed transcription is logged by page, size and status only, never by the service's text,
 * and errors the stream in our words, and so does a page image whose data proves not to be what
 * the file says of it; a failure of a page's read is passed on as it is.
 */
function transcription(
  ai: AiFetcher, gatewayId: string | undefined, { images, bytes: fileSize }: PdfImages,
  readRange: PdfRangeReader,
): ReadableStream<Uint8Array> {
  let encoder = new TextEncoder();
  /** The page being transcribed, from 0, and its transcription once the model has answered. */
  let index = 0;
  let current: Transcription | undefined;
  /** Gives up the request for the page in progress. */
  let request = new AbortController();
  /** Whether the text was cancelled or sat idle, either of which stops the page in progress. */
  let ended = false;
  /** When the text last moved: asked for, or handed over. */
  let moved = Date.now();
  let timer!: ReturnType<typeof setTimeout>;
  let end = async (reason?: unknown) => {
    ended = true;
    clearTimeout(timer);
    request.abort(reason);
    await current?.cancel(reason);
  };
  let fields = () => ({ page: index + 1, imageEncoding: images[index]!.encoding });
  let begin = async (): Promise<Transcription> => {
    let image = images[index]!;
    let { offset, length } = image;
    let data = await readRange({ page: index + 1, offset, length, fileSize });
    if (ended) {
      await data.cancel().catch(() => undefined);
      throw new Error("cancelled");
    }
    request = new AbortController();
    return transcribeImage(ai, gatewayId, image.png
      ? { mimeType: "image/png", body: pngFromDeflated(data, image, image.png, MAX_IMAGE_BYTES) }
      : { mimeType: "image/jpeg", body: data }, request.signal);
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
        logger.warn("a Drive PDF's transcription sat idle", {
          event: "google.drive.pdf.transcription_idle", ...(index < images.length ? fields() : {}),
        });
      };
      timer = setTimeout(check, TRANSCRIPTION_IDLE_MS);
    },
    async pull(controller) {
      moved = Date.now();
      let give = (text: string) => {
        moved = Date.now();
        controller.enqueue(encoder.encode(text));
      };
      try {
        // A pull that enqueues nothing is not called again, so go on until there is text.
        for (;;) {
          if (!current) {
            if (index === images.length) {
              clearTimeout(timer);
              return controller.close();
            }
            let begun = await begin();
            if (ended) return await begun.cancel();
            current = begun;
            return give(`${index > 0 ? "\n\n" : ""}### Page ${index + 1}\n`);
          }
          let piece = await current.next();
          // Ended while the page's answer was being let go: no further page is begun.
          if (ended) return;
          if (piece !== undefined) return give(piece);
          logger.info("transcribed a Drive PDF page", {
            event: "google.drive.pdf.page_transcribed", imageBytes: current.sentBytes, ...fields(),
          });
          let cutOff = current.truncated;
          current = undefined;
          index++;
          if (cutOff) return give(CUT_OFF);
        }
      } catch (error) {
        // Ending the text ends a read in progress as if the response had broken off.
        if (ended) return;
        clearTimeout(timer);
        let failure = error instanceof TranscriptionError
          ? { imageBytes: error.sentBytes, ...error.failure }
          : error instanceof ImageDataError ? { error } : undefined;
        if (!failure) return controller.error(error);
        logger.warn("a Drive PDF page could not be transcribed", {
          event: "google.drive.pdf.transcription_failed", ...fields(), ...failure,
        });
        controller.error(new Error(TRANSCRIPTION_FAILED));
      }
    },
    cancel: end,
  }, { highWaterMark: 0 });
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
 * {@link CONVERSION_FAILED}; anything else, such as the PDF stream's own failure, is kept as it is.
 */
function reported(error: unknown): unknown {
  if (!(error instanceof MarkdownConversionError)) return error;
  logger.warn("Workers AI failed to convert a PDF", {
    event: "google.drive.pdf.failed", pdfBytes: error.sentBytes, ...error.failure,
  });
  return new Error(CONVERSION_FAILED);
}

/**
 * Finds where a conversion's text begins: past the preamble at the very start, blank lines, and
 * "### Page N" headings of the pages before the first with text. It holds only the line being read
 * (from its first character that is not whitespace, at most {@link MAX_HEADING_CHARS} of it), the
 * last heading seen, and what remains of the piece in which the text begins.
 */
class TextStart {
  /**
   * The text from the last heading before it on, or from its own line when no heading came first,
   * once found.
   */
  text: string | undefined;
  /** Characters of the preamble matched so far, or -1 once it has been passed or ruled out. */
  #preamble = 0;
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
    this.#heading = this.#line;
    return false;
  }

  #found(rest: string): void {
    this.text = `${this.#heading === undefined ? "" : `${this.#heading}\n`}${this.#line}${rest}`;
  }
}
