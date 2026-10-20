// A Drive PDF's text, from Workers AI's markdown conversion, streamed in both directions.

import { readTextPrefix } from "@gadgets/gatekeeper-kit/response-body";
import type { DrivePdfText } from "./drive-types";
import { obsContext } from "./observability";

const logger = obsContext.createLogger({ component: "gatekeeper.google.drive.pdf", vendorId: "google" });

/** The longest text one PDF read returns; past it the text is cut and marked truncated. */
export const MAX_PDF_TEXT_CHARS = 1_000_000;

/** Converts one PDF, read from a stream, to its text. */
export type PdfConverter = (pdf: ReadableStream<Uint8Array>) => Promise<DrivePdfText>;

/** The Workers AI binding's passthrough to its own services, which `Ai`'s type does not declare. */
export type AiFetcher = Pick<Fetcher, "fetch">;

/**
 * Where the binding's `toMarkdown()` posts. That method takes a `Blob` and base64-encodes it into
 * one JSON string, holding the whole file several times over; posting the same JSON here lets the
 * file stream through instead.
 */
const TO_MARKDOWN_URL = "https://workers-binding.ai/to-everything/markdown/transformer";

/**
 * The name every PDF is converted under. The conversion heads its output with the input's name, so
 * a fixed one keeps Drive file names out of both the request and the text.
 */
const PDF_NAME = "file.pdf";
/** What the conversion puts before a PDF's pages once its metadata block is turned off. */
const PREAMBLE = `# ${PDF_NAME}\n## Contents\n`;
const PAGE_HEADING = /^### Page \d+$/gm;
const CONVERSION_FAILED = "Google Drive's file could not be converted from PDF.";
/** Bytes of a failed conversion's response read for its error code. */
const MAX_ERROR_BYTES = 1024;
/**
 * Characters of the converted text read before the rest is dropped: the cap, plus the preamble and
 * some leading whitespace that come off before the cap is measured.
 */
const MAX_DATA_CHARS = PREAMBLE.length + MAX_PDF_TEXT_CHARS + 1024;
/** Characters kept of any other string field of the response. */
const MAX_FIELD_CHARS = 1024;
/** Input bytes base64-encoded per string conversion, a multiple of 3 so no piece pads. */
const BASE64_STEP = 0x6000;

/**
 * Converts a PDF with the Workers AI binding, through AI Gateway `gatewayId` when one is named.
 * Neither the PDF nor the whole converted text is ever held: the PDF is encoded into the request as
 * it arrives, and the response is read only up to {@link MAX_PDF_TEXT_CHARS} of text before it is
 * cancelled. Its images are not described (an image-only page yields no text; nothing is OCR'd),
 * so the conversion makes no billed model call. A failed conversion is logged by status and error
 * code only, never by the service's text, and reported in our words; a failure of the PDF stream
 * itself (such as a file over the size limit) is thrown as it is.
 */
export async function pdfToText(
  ai: AiFetcher, gatewayId: string | undefined, pdf: ReadableStream<Uint8Array>,
): Promise<DrivePdfText> {
  let pdfBytes = 0;
  let sourceError: { error: unknown } | undefined;
  let options = {
    ...(gatewayId ? { gateway: { id: gatewayId } } : {}),
    conversionOptions: { pdf: { metadata: false, images: { convert: false } } },
  };
  let { body, cancelPdf } = requestBody(pdf, options, {
    onBytes: count => { pdfBytes += count; },
    onError: error => { sourceError = { error }; },
  });
  let failed = async (
    detail: { error: unknown } | { httpStatus: number; providerCode?: number },
  ): Promise<never> => {
    // A fetch holds the body locked, so the download is released through its reader instead.
    await cancelPdf();
    if (sourceError) throw sourceError.error;
    logger.warn("Workers AI failed to convert a PDF", {
      event: "google.drive.pdf.failed", pdfBytes, ...detail,
    });
    throw new Error(CONVERSION_FAILED);
  };

  let response: Response;
  try {
    response = await ai.fetch(TO_MARKDOWN_URL, {
      method: "POST", headers: { "Content-Type": "application/json" }, body,
    });
  } catch (error) {
    return failed({ error });
  }
  if (!response.ok || !response.body) {
    // Only the service's numeric error code is kept from its answer, never its text.
    let prefix = await readTextPrefix(response, MAX_ERROR_BYTES).catch(() => "");
    let code = /"code"\s*:\s*(\d+)/.exec(prefix)?.[1];
    return failed({ httpStatus: response.status, ...(code ? { providerCode: Number(code) } : {}) });
  }
  let conversion: Conversion;
  try {
    conversion = await readConversion(response.body);
  } catch (error) {
    return failed({ error });
  }
  if (conversion.format !== "markdown" && conversion.format !== "text") {
    return failed({
      error: conversion.format === "error" ? "the service could not convert the file"
        : "the service answered in an unexpected format",
    });
  }
  let text = pdfMarkdown(conversion.data ?? "", conversion.dataOverflow);
  logger.info("converted a Drive PDF", {
    event: "google.drive.pdf.converted", pdfBytes, textChars: text.markdown.length,
    hasText: text.hasText, truncated: text.truncated,
  });
  return text;
}

/**
 * The conversion request's JSON body, `{"files":[{name, mimeType, data}],"options":…}`, with `data`
 * base64-encoded from `pdf` one chunk at a time as the request is sent. Cancelling the body cancels
 * `pdf`; `cancelPdf` does so too while the body is locked to a request, and does nothing once `pdf`
 * has been read to its end.
 */
function requestBody(
  pdf: ReadableStream<Uint8Array>,
  options: object,
  hooks: { onBytes(count: number): void; onError(error: unknown): void },
): { body: ReadableStream<Uint8Array>; cancelPdf(): Promise<void> } {
  let encoder = new TextEncoder();
  let reader = pdf.getReader();
  let started = false;
  // The 0-2 bytes left over from the previous chunk, since base64 encodes whole 3-byte groups.
  let carry = new Uint8Array(0);
  let body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!started) {
        started = true;
        controller.enqueue(encoder.encode(
          `{"files":[{"name":${JSON.stringify(PDF_NAME)},"mimeType":"application/pdf","data":"`));
        return;
      }
      // A pull that enqueues nothing is not called again, so read until there is something to
      // send: a chunk smaller than a whole group only adds to the carry.
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (error) {
          hooks.onError(error);
          throw error;
        }
        if (chunk.done) {
          controller.enqueue(encoder.encode(`${base64(carry)}"}],"options":${JSON.stringify(options)}}`));
          controller.close();
          return;
        }
        hooks.onBytes(chunk.value.byteLength);
        let joined = new Uint8Array(carry.byteLength + chunk.value.byteLength);
        joined.set(carry);
        joined.set(chunk.value, carry.byteLength);
        let whole = joined.byteLength - joined.byteLength % 3;
        carry = joined.slice(whole);
        if (whole > 0) {
          controller.enqueue(encoder.encode(base64(joined.subarray(0, whole))));
          return;
        }
      }
    },
    cancel: reason => reader.cancel(reason),
  });
  return { body, cancelPdf: () => reader.cancel().catch(() => undefined) };
}

function base64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.byteLength; i += BASE64_STEP) {
    out += btoa(String.fromCharCode(...bytes.subarray(i, i + BASE64_STEP)));
  }
  return out;
}

/** The fields of the response's first `result` entry that a conversion is judged by. */
type Conversion = { format?: string; data?: string; dataOverflow: boolean };

/** A string the scanner keeps, as what, and up to how many characters. */
type Kept = { field: "format" | "data" | "key"; max: number };

/** A container the reader is inside: an object and the key being read, or an array and its index. */
type Frame = { kind: "object"; key?: string } | { kind: "array"; index: number };

/**
 * Reads `{"result":[{format, data, …}], …}` from a response stream, keeping only those two
 * string fields of the first result and at most {@link MAX_DATA_CHARS} of `data`. Once `data` has
 * overflowed and `format` is known the rest of the response is cancelled unread.
 */
async function readConversion(stream: ReadableStream<Uint8Array>): Promise<Conversion> {
  let reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let json = new StreamingFields();
  try {
    for (;;) {
      let chunk = await reader.read();
      if (chunk.done) break;
      json.feed(chunk.value);
      if (json.result.dataOverflow && json.result.format !== undefined) {
        await reader.cancel().catch(() => undefined);
        return json.result;
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (!json.complete) throw new Error("The conversion response ended early.");
  return json.result;
}

const STRING_RUN = /[^"\\]*/y;
const LITERAL_RUN = /[^,}\]\s]*/y;
const ESCAPES: Record<string, string> = {
  '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t",
};

/**
 * An incremental JSON scanner that walks any document but keeps only the strings at
 * `result[0].{format,data}`, each capped. It checks structure only as far as walking needs;
 * the response comes from the binding, and nothing read here decides anything but the text.
 */
class StreamingFields {
  result: Conversion = { dataOverflow: false };
  complete = false;
  #stack: Frame[] = [];
  #state: "value" | "valueOrEnd" | "keyOrEnd" | "key" | "colon" | "after" | "string" | "escape" |
    "unicode" | "literal" = "value";
  /** Whether the string being read is a key rather than a value. */
  #isKey = false;
  /** The string being read, when it is kept, and how it is kept. */
  #buffer = "";
  #keep: Kept | undefined;
  #hex = "";

  feed(text: string): void {
    let i = 0;
    while (i < text.length) {
      let ch = text[i]!;
      switch (this.#state) {
        case "string": {
          STRING_RUN.lastIndex = i;
          let run = STRING_RUN.exec(text)![0];
          this.#append(run);
          i += run.length;
          if (i >= text.length) return;
          if (text[i] === "\\") this.#state = "escape";
          else this.#endString();
          i++;
          continue;
        }
        case "escape":
          if (ch === "u") {
            this.#hex = "";
            this.#state = "unicode";
          } else {
            this.#append(ESCAPES[ch] ?? ch);
            this.#state = "string";
          }
          i++;
          continue;
        case "unicode":
          this.#hex += ch;
          if (this.#hex.length === 4) {
            this.#append(String.fromCharCode(parseInt(this.#hex, 16)));
            this.#state = "string";
          }
          i++;
          continue;
        case "literal": {
          LITERAL_RUN.lastIndex = i;
          i += LITERAL_RUN.exec(text)![0].length;
          if (i < text.length) this.#state = "after";
          continue;
        }
      }
      if (ch === " " || ch === "\n" || ch === "\r" || ch === "\t") {
        i++;
        continue;
      }
      switch (this.#state) {
        case "valueOrEnd":
          if (ch === "]") {
            this.#close();
            break;
          }
        // falls through
        case "value":
          if (ch === "{") {
            this.#stack.push({ kind: "object" });
            this.#state = "keyOrEnd";
          } else if (ch === "[") {
            this.#stack.push({ kind: "array", index: 0 });
            this.#state = "valueOrEnd";
          } else if (ch === '"') {
            this.#startString(false);
          } else {
            this.#state = "literal";
            continue;
          }
          break;
        case "keyOrEnd":
          if (ch === "}") this.#close();
          else this.#startString(true);
          break;
        case "key":
          this.#startString(true);
          break;
        case "colon":
          this.#state = "value";
          break;
        case "after": {
          let top = this.#stack.at(-1);
          if (ch === "}" || ch === "]") {
            this.#close();
          } else if (top?.kind === "array") {
            top.index++;
            this.#state = "value";
          } else {
            this.#state = "key";
          }
          break;
        }
      }
      i++;
    }
  }

  #startString(isKey: boolean): void {
    this.#isKey = isKey;
    this.#buffer = "";
    this.#keep = isKey ? { field: "key", max: MAX_FIELD_CHARS } : this.#keptField();
    this.#state = "string";
  }

  /** The field a value string at the current position is kept as, if any. */
  #keptField(): Kept | undefined {
    let [root, result, entry] = this.#stack;
    if (this.#stack.length !== 3 || root?.kind !== "object" || root.key !== "result" ||
        result?.kind !== "array" || result.index !== 0 || entry?.kind !== "object") {
      return undefined;
    }
    if (entry.key === "data") return { field: "data", max: MAX_DATA_CHARS };
    if (entry.key === "format") return { field: "format", max: MAX_FIELD_CHARS };
    return undefined;
  }

  #append(text: string): void {
    if (!this.#keep || text === "") return;
    let room = this.#keep.max - this.#buffer.length;
    if (text.length > room) {
      this.#buffer += text.slice(0, room);
      // The rest of the response may go unread, so the kept text is final now.
      if (this.#keep.field === "data") {
        this.result.data = this.#buffer;
        this.result.dataOverflow = true;
      }
    } else {
      this.#buffer += text;
    }
  }

  #endString(): void {
    if (this.#isKey) {
      let top = this.#stack.at(-1);
      if (top?.kind === "object") top.key = this.#buffer;
      this.#state = "colon";
      return;
    }
    let field = this.#keep?.field;
    if (field === "data" || field === "format") this.result[field] = this.#buffer;
    this.#state = "after";
  }

  #close(): void {
    this.#stack.pop();
    this.#state = "after";
    if (this.#stack.length === 0) this.complete = true;
  }
}

/**
 * The conversion's output for one PDF as agent text: without the file heading and "## Contents"
 * line it opens with, keeping the "### Page N" headings between pages. A PDF whose pages hold
 * nothing but those headings has no text layer. `overflow` says the output went on past what was
 * read, so the text is truncated whatever its length.
 */
export function pdfMarkdown(data: string, overflow = false): DrivePdfText {
  let body = data.startsWith(PREAMBLE) ? data.slice(PREAMBLE.length) : data;
  let hasText = body.replace(PAGE_HEADING, "").trim() !== "";
  if (!hasText) return { markdown: "", hasText, truncated: overflow };
  let markdown = overflow ? body.trimStart() : body.trim();
  if (!overflow && markdown.length <= MAX_PDF_TEXT_CHARS) return { markdown, hasText, truncated: false };
  let end = Math.min(markdown.length, MAX_PDF_TEXT_CHARS);
  // Never leave half of a surrogate pair at the end.
  let last = markdown.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { markdown: markdown.slice(0, end), hasText, truncated: true };
}
