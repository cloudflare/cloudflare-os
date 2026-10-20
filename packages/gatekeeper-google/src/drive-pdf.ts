// A Drive PDF's text, from Workers AI's markdown conversion, streamed in both directions: neither
// the PDF nor its text is ever held whole.

import { PDF_MIME_TYPE } from "./drive-session";
import type { DrivePdfText } from "./drive-types";
import { obsContext } from "./observability";
import {
  convertToMarkdown, MarkdownConversionError, type AiFetcher, type MarkdownConversion,
} from "./workers-ai-markdown";

const logger = obsContext.createLogger({ component: "gatekeeper.google.drive.pdf", vendorId: "google" });

/**
 * Converts one PDF, read from a stream, to its text. It may resolve before reading `pdf` to its end,
 * so a caller that checks the file after converting it must see the end itself.
 */
export type PdfConverter = (pdf: ReadableStream<Uint8Array>) => Promise<DrivePdfText>;

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

/**
 * Converts a PDF with the Workers AI binding, through AI Gateway `gatewayId` when one is named.
 * The PDF is encoded into the request as it arrives, and the response is read only until its text
 * begins, which settles `hasText`; the text then streams from the response as it is read, without
 * the file heading, "## Contents" line, and pages before the first with text. Its images are not
 * described (an image-only page yields no text; nothing is OCR'd), so the conversion makes no
 * billed model call. A failed conversion is logged by status and error code only, never by the
 * service's text, and reported in our words, by a throw before the text begins or by erroring the
 * stream after; a failure of the PDF stream itself (such as the download breaking off) is thrown
 * as it is.
 */
export async function pdfToText(
  ai: AiFetcher, gatewayId: string | undefined, pdf: ReadableStream<Uint8Array>,
): Promise<DrivePdfText> {
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
    return { text: new ReadableStream({ start: controller => controller.close() }), hasText };
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
  return { text, hasText };
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
