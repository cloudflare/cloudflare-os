// Workers AI's markdown conversion, streamed in both directions: the source is encoded into the
// request as it arrives, and the converted text is read from the response as it is wanted, so
// neither is ever held whole.

import { readTextPrefix } from "@gadgets/gatekeeper-kit/response-body";

/** The Workers AI binding's passthrough to its own services, which `Ai`'s type does not declare. */
export type AiFetcher = Pick<Fetcher, "fetch">;

/**
 * Where the binding's `toMarkdown()` posts. That method takes a `Blob` and base64-encodes it into
 * one JSON string, holding the whole file several times over; posting the same JSON here lets the
 * file stream through instead.
 */
const TO_MARKDOWN_URL = "https://workers-binding.ai/to-everything/markdown/transformer";

const TEXT_FORMATS = new Set(["markdown", "text"]);
/** Bytes of a failed conversion's response read for its error code. */
const MAX_ERROR_BYTES = 1024;
/** Characters kept of any string field of the response other than the text. */
const MAX_FIELD_CHARS = 1024;

/**
 * One file to convert: the name and MIME type the service is told, and its bytes. The conversion
 * heads its output with the name, so a caller that must keep a file's real name out of it passes
 * a fixed one.
 */
export type MarkdownSource = { name: string; mimeType: string; body: ReadableStream<Uint8Array> };

/**
 * Why a conversion failed, in terms safe to log: an error of ours or the binding's, or the
 * service's HTTP status and numeric error code. Never the service's own text.
 */
export type ConversionFailure = { error: unknown } | { httpStatus: number; providerCode?: number };

/** A failed conversion, with why it failed and how much of the source had been sent. */
export class MarkdownConversionError extends Error {
  constructor(readonly failure: ConversionFailure, readonly sentBytes: number) {
    super("Workers AI could not convert the file.");
  }
}

/** A conversion's text, read from the service's response only as it is asked for. */
export type MarkdownConversion = {
  /** Bytes of the source sent so far. */
  readonly sentBytes: number;
  /**
   * The next piece of the text, never empty, or `undefined` once the response has ended whole in
   * a text format. Throws a {@link MarkdownConversionError} once the response breaks, ends early or
   * names any other format, having released the response and the source.
   */
  next(): Promise<string | undefined>;
  /** Stops reading the response and the source. */
  cancel(reason?: unknown): Promise<void>;
};

/**
 * Converts `source` to Markdown with the Workers AI binding, `options` being `toMarkdown()`'s
 * (`gateway`, `conversionOptions`). Resolves once the service answers, before any of the text is
 * read. A failed request rejects with a {@link MarkdownConversionError}, and a failure of the
 * source stream itself with that failure as it is; either way the source is released.
 */
export async function convertToMarkdown(
  ai: AiFetcher, source: MarkdownSource, options: object,
): Promise<MarkdownConversion> {
  let { body, sent, cancelSource } = requestBody(source, options);
  let fail = async (failure: ConversionFailure): Promise<never> => {
    // A fetch holds the body locked, so the source is released through its reader instead.
    await cancelSource();
    if (sent.error) throw sent.error.error;
    throw new MarkdownConversionError(failure, sent.bytes);
  };

  let response: Response;
  try {
    response = await ai.fetch(TO_MARKDOWN_URL, {
      method: "POST", headers: { "Content-Type": "application/json" }, body,
    });
  } catch (error) {
    return fail({ error });
  }
  if (!response.ok || !response.body) {
    // Only the service's numeric error code is kept from its answer, never its text.
    let prefix = await readTextPrefix(response, MAX_ERROR_BYTES).catch(() => "");
    let code = /"code"\s*:\s*(\d+)/.exec(prefix)?.[1];
    return fail({ httpStatus: response.status, ...(code ? { providerCode: Number(code) } : {}) });
  }
  let reader = new ConversionReader(response.body);
  return {
    get sentBytes() { return sent.bytes; },
    async next() {
      try {
        return await reader.next();
      } catch (error) {
        await reader.cancel();
        return fail({ error });
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
      await cancelSource();
    },
  };
}

/**
 * The conversion request's JSON body, `{"files":[{name, mimeType, data}],"options":…}`, with `data`
 * base64-encoded from the source one chunk at a time as the request is sent. `sent` counts the
 * source's bytes read and keeps the error the source itself failed with, if any. Cancelling the
 * body cancels the source; `cancelSource` does so too while the body is locked to a request, and
 * does nothing once the source has been read to its end.
 */
function requestBody(source: MarkdownSource, options: object): {
  body: ReadableStream<Uint8Array>;
  sent: { bytes: number; error?: { error: unknown } };
  cancelSource(): Promise<void>;
} {
  let encoder = new TextEncoder();
  let reader = source.body.getReader();
  let sent: { bytes: number; error?: { error: unknown } } = { bytes: 0 };
  // The 0-2 bytes left over from the previous chunk, since base64 encodes whole 3-byte groups.
  let carry = new Uint8Array(0);
  let body = new ReadableStream<Uint8Array>({
    start(controller) {
      let file = `"name":${JSON.stringify(source.name)},"mimeType":${JSON.stringify(source.mimeType)}`;
      controller.enqueue(encoder.encode(`{"files":[{${file},"data":"`));
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
  return { body, sent, cancelSource: () => reader.cancel().catch(() => undefined) };
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
