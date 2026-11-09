// A page image transcribed by a Workers AI vision model, streamed in both directions: the image is
// encoded into the request as it arrives, and the text is read from the response as it is wanted,
// so neither is ever held whole.

import { readTextPrefix } from "@gadgets/gatekeeper-kit/response-body";
import { base64JsonBody, type AiFetcher, type ConversionFailure } from "./workers-ai-markdown";

const MODEL = "@cf/google/gemma-4-26b-a4b-it";
/**
 * Where the binding's `run()` posts, directly and through an AI Gateway. That method takes its
 * input as one object, image included; posting the same JSON here lets the image stream through.
 */
const RUN_URL = "https://workers-binding.ai/run?version=3";
const GATEWAY_RUN_URL = "https://workers-binding.ai/ai-gateway/run?version=3";

const PROMPT = "Transcribe the text of this scanned page exactly as it is printed, in reading " +
  "order. Write each paragraph on one line, headings and lists as Markdown, and tables as " +
  "Markdown tables. Do not describe the page, comment on it, or correct what it says. If the " +
  "page has no text, reply with nothing at all.";
/** Enough for the densest page; what a model stuck repeating itself is stopped at. */
const MAX_TOKENS = 8192;
/**
 * The model's settings. `temperature: 0` because a transcription is not to be varied. Thinking is
 * off because, measured on scanned pages, it tripled the tokens and the time a page takes (about
 * 1,100 tokens against 340) and held the text back until it was over, without making a poor scan
 * any better read: it saved a word or two on clean pages only.
 */
const SETTINGS = {
  temperature: 0, max_tokens: MAX_TOKENS, stream: true,
  chat_template_kwargs: { enable_thinking: false },
};

/** Bytes of a failed request's response read for its error code. */
const MAX_ERROR_BYTES = 1024;
/** Characters of one line of the response held; a line carries one token. */
const MAX_LINE_CHARS = 256 * 1024;

/** One image to transcribe. */
export type ImageSource = { mimeType: "image/jpeg" | "image/png"; body: ReadableStream<Uint8Array> };

/** A failed transcription, with why it failed and how much of the image had been sent. */
export class TranscriptionError extends Error {
  constructor(readonly failure: ConversionFailure, readonly sentBytes: number) {
    super("Workers AI could not transcribe the image.");
  }
}

/** A transcription's text, read from the model's response only as it is asked for. */
export type Transcription = {
  /** Bytes of the image sent so far. */
  readonly sentBytes: number;
  /** Whether the model was stopped at its output limit, so the text ends early. Known once `next` has returned `undefined`. */
  readonly truncated: boolean;
  /**
   * The next piece of the text, never empty, or `undefined` once the response has ended whole.
   * Throws a {@link TranscriptionError} once the response breaks or ends early, having released
   * the response and the image.
   */
  next(): Promise<string | undefined>;
  /** Stops reading the response and the image. */
  cancel(reason?: unknown): Promise<void>;
};

/**
 * Has the vision model transcribe `image` with the Workers AI binding, through AI Gateway
 * `gatewayId` when one is named. Resolves once the service answers, before any of the text is
 * read. A failed request rejects with a {@link TranscriptionError}, and a failure of the image
 * stream itself with that failure as it is; either way the image is released. Aborting `signal`
 * gives up a request the service has not answered yet, which fails as any other, and releases
 * the image at once.
 */
export async function transcribeImage(
  ai: AiFetcher, gatewayId: string | undefined, image: ImageSource, signal?: AbortSignal,
): Promise<Transcription> {
  // {"inputs":{"messages":[{role, content:[{text}, {image_url:{url}}]}], …settings},"options":…}
  let text = JSON.stringify({ type: "text", text: PROMPT });
  let options = gatewayId ? { gateway: { id: gatewayId } } : {};
  let { body, sent, cancelSource } = base64JsonBody(
    `{"inputs":{"messages":[{"role":"user","content":[${text},{"type":"image_url","image_url":` +
      `{"url":"data:${image.mimeType};base64,`,
    image.body,
    `"}}]}],${JSON.stringify(SETTINGS).slice(1, -1)}},"options":${JSON.stringify(options)}}`);
  let fail = async (failure: ConversionFailure): Promise<never> => {
    // A fetch holds the body locked, so the image is released through its reader instead.
    await cancelSource();
    if (sent.error) throw sent.error.error;
    throw new TranscriptionError(failure, sent.bytes);
  };
  signal?.addEventListener("abort", () => void cancelSource(), { once: true });

  let response: Response;
  try {
    response = await ai.fetch(gatewayId ? GATEWAY_RUN_URL : RUN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "cf-consn-sdk-version": "2.0.0",
        "cf-consn-model-id": MODEL,
      },
      body,
      signal,
    });
  } catch (error) {
    return fail({ error });
  }
  if (!response.ok || !response.body) {
    // Only the service's numeric error code is kept from its answer, never its text.
    let prefix = await readTextPrefix(response, MAX_ERROR_BYTES).catch(() => "");
    let code = /"(?:internalCode|code)"\s*:\s*(\d+)/.exec(prefix)?.[1];
    return fail({ httpStatus: response.status, ...(code ? { providerCode: Number(code) } : {}) });
  }
  let reader = new TokenReader(response.body);
  return {
    get sentBytes() { return sent.bytes; },
    get truncated() { return reader.truncated; },
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

/** What is read of one event of the response; a model's answer comes in either shape. */
type TokenEvent = {
  choices?: { delta?: { content?: unknown }; finish_reason?: unknown }[];
  response?: unknown;
  error?: unknown;
  errors?: unknown;
};

/**
 * The text of a streamed model response: server-sent events, each `data: ` line a JSON object
 * carrying the next piece of text, ended by `data: [DONE]`. Only the answer's text is kept; what
 * a model thinks before answering comes in a field of its own and is passed over.
 */
class TokenReader {
  truncated = false;
  #reader: ReadableStreamDefaultReader<Uint8Array>;
  #decoder = new TextDecoder();
  /** The line being read. */
  #line = "";
  /** Text read but not yet returned by {@link next}. */
  #text = "";
  #done = false;
  #ended = false;

  constructor(body: ReadableStream<Uint8Array>) {
    this.#reader = body.getReader();
  }

  /**
   * The next piece of the text, never empty, or `undefined` once the response has said it is done.
   * Throws once the response breaks, reports an error, or ends without saying so.
   */
  async next(): Promise<string | undefined> {
    for (;;) {
      // The halves of a surrogate pair can arrive in two events and are kept together so that
      // neither is encoded alone.
      let end = this.#text.length;
      let last = this.#text.charCodeAt(end - 1);
      if (!this.#done && !this.#ended && last >= 0xd800 && last <= 0xdbff) end -= 1;
      if (end > 0) {
        let text = this.#text.slice(0, end);
        this.#text = this.#text.slice(end);
        return text;
      }
      if (this.#done) {
        await this.cancel();
        return undefined;
      }
      if (this.#ended) throw new Error("The model's response ended early.");
      let chunk = await this.#reader.read();
      if (chunk.done) this.#ended = true;
      let lines = (this.#line + (chunk.done ? `${this.#decoder.decode()}\n`
        : this.#decoder.decode(chunk.value, { stream: true }))).split("\n");
      this.#line = lines.pop()!;
      if (this.#line.length > MAX_LINE_CHARS) throw new Error("The model's response is not a stream of events.");
      for (let line of lines) this.#event(line);
    }
  }

  /** Stops reading the response. */
  async cancel(reason?: unknown): Promise<void> {
    await this.#reader.cancel(reason).catch(() => undefined);
  }

  #event(line: string): void {
    if (this.#done || !line.startsWith("data:")) return;
    let data = line.slice("data:".length).trim();
    if (data === "[DONE]") {
      this.#done = true;
      return;
    }
    let event: TokenEvent;
    try {
      event = JSON.parse(data) as TokenEvent;
    } catch {
      // The parser's own message would quote the text.
      throw new Error("The model's response held an event that is not JSON.");
    }
    if (typeof event !== "object" || event === null) return;
    if (event.error !== undefined || event.errors !== undefined) {
      throw new Error("The model reported an error partway through.");
    }
    if (!Array.isArray(event.choices)) {
      if (typeof event.response === "string") this.#text += event.response;
      return;
    }
    let choice = event.choices[0];
    if (typeof choice?.delta?.content === "string") this.#text += choice.delta.content;
    if (choice?.finish_reason === "length") this.truncated = true;
  }
}
