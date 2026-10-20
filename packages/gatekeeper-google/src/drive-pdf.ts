// A Drive PDF's text, from Workers AI's markdown conversion, streamed in both directions: neither
// the PDF nor its text is ever held whole.

import { readTextPrefix } from "@gadgets/gatekeeper-kit/response-body";
import { PDF_MIME_TYPE } from "./drive-session";
import type { DrivePdfText } from "./drive-types";
import { obsContext } from "./observability";

const logger = obsContext.createLogger({ component: "gatekeeper.google.drive.pdf", vendorId: "google" });

/**
 * Converts one PDF, read from a stream, to its text. It may resolve before reading `pdf` to its end,
 * so a caller that checks the file after converting it must see the end itself.
 */
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
const PAGE_HEADING = /^### Page \d+$/;
/** Characters of one line held while looking for text, more than any page heading has. */
const MAX_HEADING_CHARS = 32;
const TEXT_FORMATS = new Set(["markdown", "text"]);
/** The one error a failed conversion is reported with, whatever the service said. */
export const CONVERSION_FAILED = "Google Drive's file could not be converted from PDF.";
/** Bytes of a failed conversion's response read for its error code. */
const MAX_ERROR_BYTES = 1024;
/** Characters kept of any string field of the response other than the text. */
const MAX_FIELD_CHARS = 1024;

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
  let { body, sent, cancelPdf } = requestBody(pdf, options);
  let logFailure = (detail: FailureDetail) => {
    logger.warn("Workers AI failed to convert a PDF", {
      event: "google.drive.pdf.failed", pdfBytes: sent.bytes, ...detail,
    });
  };
  let failed = async (detail: FailureDetail): Promise<never> => {
    // A fetch holds the body locked, so the download is released through its reader instead.
    await cancelPdf();
    if (sent.error) throw sent.error.error;
    logFailure(detail);
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
  let conversion = new ConversionReader(response.body);
  let start = new TextStart();
  try {
    while (start.text === undefined) {
      let data = await conversion.next();
      if (data === undefined) {
        start.end();
        break;
      }
      start.feed(data);
    }
  } catch (error) {
    await conversion.cancel();
    return failed({ error });
  }
  let first = start.text;
  let hasText = first !== undefined;
  logger.info("converted a Drive PDF", {
    event: "google.drive.pdf.converted", pdfBytes: sent.bytes, hasText,
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
        if (cancelled) return;
        logFailure({ error });
        controller.error(new Error(CONVERSION_FAILED));
        await conversion.cancel();
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

/** What a failed conversion is logged with: the error, or the service's status and error code. */
type FailureDetail = { error: unknown } | { httpStatus: number; providerCode?: number };

/**
 * The conversion request's JSON body, `{"files":[{name, mimeType, data}],"options":…}`, with `data`
 * base64-encoded from `pdf` one chunk at a time as the request is sent. `sent` counts the PDF's
 * bytes read and keeps the error `pdf` itself failed with, if any. Cancelling the body cancels
 * `pdf`; `cancelPdf` does so too while the body is locked to a request, and does nothing once `pdf`
 * has been read to its end.
 */
function requestBody(pdf: ReadableStream<Uint8Array>, options: object): {
  body: ReadableStream<Uint8Array>;
  sent: { bytes: number; error?: { error: unknown } };
  cancelPdf(): Promise<void>;
} {
  let encoder = new TextEncoder();
  let reader = pdf.getReader();
  let sent: { bytes: number; error?: { error: unknown } } = { bytes: 0 };
  // The 0-2 bytes left over from the previous chunk, since base64 encodes whole 3-byte groups.
  let carry = new Uint8Array(0);
  let body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(
        `{"files":[{"name":${JSON.stringify(PDF_NAME)},"mimeType":"${PDF_MIME_TYPE}","data":"`));
    },
    async pull(controller) {
      // A pull that enqueues nothing is not called again, so read until there is something to
      // send: a chunk smaller than a whole group only adds to the carry.
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (error) {
          sent.error = { error };
          throw error;
        }
        if (chunk.done) {
          controller.enqueue(encoder.encode(`${carry.toBase64()}"}],"options":${JSON.stringify(options)}}`));
          controller.close();
          return;
        }
        sent.bytes += chunk.value.byteLength;
        let joined = new Uint8Array(carry.byteLength + chunk.value.byteLength);
        joined.set(carry);
        joined.set(chunk.value, carry.byteLength);
        let whole = joined.byteLength - joined.byteLength % 3;
        carry = joined.slice(whole);
        if (whole > 0) {
          controller.enqueue(encoder.encode(joined.subarray(0, whole).toBase64()));
          return;
        }
      }
    },
    cancel: reason => reader.cancel(reason),
  });
  return { body, sent, cancelPdf: () => reader.cancel().catch(() => undefined) };
}

/**
 * The text of a conversion response, `{"result":[{format, data, …}], …}`, read from its stream a
 * chunk at a time. Only `result[0].format` is kept; `result[0].data` is handed on as it is decoded.
 */
class ConversionReader {
  #reader: ReadableStreamDefaultReader<Uint8Array>;
  #decoder = new TextDecoder();
  #fields = new StreamingFields(data => { this.#data += data; });
  /** Text decoded but not yet returned by {@link next}. */
  #data = "";
  #ended = false;

  constructor(body: ReadableStream<Uint8Array>) {
    this.#reader = body.getReader();
  }

  /**
   * The next piece of the text, never empty, or `undefined` once the response has ended whole in a
   * text format. Throws once the response breaks, ends early, or names any other format.
   */
  async next(): Promise<string | undefined> {
    for (;;) {
      // The halves of a surrogate pair can arrive apart, as two \u escapes, and are kept together
      // so that neither is encoded alone.
      let end = this.#data.length;
      let last = this.#data.charCodeAt(end - 1);
      if (!this.#ended && last >= 0xd800 && last <= 0xdbff) end -= 1;
      if (end > 0) {
        let data = this.#data.slice(0, end);
        this.#data = this.#data.slice(end);
        return data;
      }
      if (this.#ended) {
        if (!this.#fields.complete) throw new Error("The conversion response ended early.");
        if (this.#fields.format === undefined) {
          throw new Error("the service answered in an unexpected format");
        }
        return undefined;
      }
      let chunk = await this.#reader.read();
      if (chunk.done) this.#ended = true;
      this.#feed(chunk.done ? this.#decoder.decode()
        : this.#decoder.decode(chunk.value, { stream: true }));
    }
  }

  /** Stops reading the response. */
  async cancel(reason?: unknown): Promise<void> {
    await this.#reader.cancel(reason).catch(() => undefined);
  }

  #feed(text: string): void {
    this.#fields.feed(text);
    let format = this.#fields.format;
    if (format !== undefined && !TEXT_FORMATS.has(format)) {
      throw new Error(format === "error" ? "the service could not convert the file"
        : "the service answered in an unexpected format");
    }
  }
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

const STRING_RUN = /[^"\\]*/y;
const LITERAL_RUN = /[^,}\]\s]*/y;
const ESCAPES: Record<string, string> = {
  '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t",
};

/** A container the reader is inside: an object and the key being read, or an array and its index. */
type Frame = { kind: "object"; key?: string } | { kind: "array"; index: number };

/**
 * An incremental JSON scanner that walks any document but keeps only the string at
 * `result[0].format`, capped, and hands the string at `result[0].data` to `onData` as it is
 * decoded. It checks structure only as far as walking needs; the response comes from the binding,
 * and nothing read here decides anything but the text.
 */
class StreamingFields {
  format: string | undefined;
  complete = false;
  #onData: (data: string) => void;
  #stack: Frame[] = [];
  #state: "value" | "valueOrEnd" | "keyOrEnd" | "key" | "colon" | "after" | "string" | "escape" |
    "unicode" | "literal" = "value";
  /** What the string being read is kept as, if anything. */
  #keep: "key" | "format" | "data" | undefined;
  /** The key or format being read. */
  #buffer = "";
  #hex = "";

  constructor(onData: (data: string) => void) {
    this.#onData = onData;
  }

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
    this.#buffer = "";
    this.#keep = isKey ? "key" : this.#keptField();
    this.#state = "string";
  }

  /** The field a value string at the current position is kept as, if any. */
  #keptField(): "format" | "data" | undefined {
    let [root, result, entry] = this.#stack;
    if (this.#stack.length !== 3 || root?.kind !== "object" || root.key !== "result" ||
        result?.kind !== "array" || result.index !== 0 || entry?.kind !== "object") {
      return undefined;
    }
    return entry.key === "data" || entry.key === "format" ? entry.key : undefined;
  }

  #append(text: string): void {
    if (text === "") return;
    if (this.#keep === "data") this.#onData(text);
    else if (this.#keep) this.#buffer += text.slice(0, MAX_FIELD_CHARS - this.#buffer.length);
  }

  #endString(): void {
    if (this.#keep === "key") {
      let top = this.#stack.at(-1);
      if (top?.kind === "object") top.key = this.#buffer;
      this.#state = "colon";
      return;
    }
    if (this.#keep === "format") this.format = this.#buffer;
    this.#state = "after";
  }

  #close(): void {
    this.#stack.pop();
    this.#state = "after";
    if (this.#stack.length === 0) this.complete = true;
  }
}
