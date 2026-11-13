import type { AiFetcher } from "../src/workers-ai-markdown";

if (!("toBase64" in Uint8Array.prototype)) {
  // oxlint-disable-next-line eslint/no-extend-native -- Node's Uint8Array has no toBase64 yet; workerd's, which the conversion runs on, does.
  Object.defineProperty(Uint8Array.prototype, "toBase64", {
    value(this: Uint8Array) {
      return Buffer.from(this.buffer, this.byteOffset, this.byteLength).toString("base64");
    },
  });
}

/** 1,000 bytes covering every byte value, so base64 framing errors show. */
export const BYTES = Uint8Array.from({ length: 1000 }, (_, i) => (i * 7) % 256);

/** A conversion request as the fake binding received it. */
export type Sent = {
  url: string;
  init: RequestInit;
  json: { files: { name: string; mimeType: string; data: string }[]; options: unknown };
};

/** `bytes` as a stream that hands them out in chunks of the given sizes, cycling. */
export function byteStream(bytes: Uint8Array, sizes: number[] = [bytes.byteLength || 1]) {
  let offset = 0, turn = 0;
  let state = { cancelled: false };
  let stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) return controller.close();
      let size = sizes[turn++ % sizes.length]!;
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
    cancel() { state.cancelled = true; },
  });
  return { stream, state };
}

/** A response whose body streams `text` out `size` bytes at a time. */
export function streamedResponse(text: string, size = 7, status = 200) {
  let bytes = new TextEncoder().encode(text);
  return new Response(byteStream(bytes, [size]).stream, {
    status, headers: { "Content-Type": "application/json" },
  });
}

/** A response whose body is `text` cut into two chunks at byte `cut`. */
export function splitResponse(text: string, cut: number) {
  let bytes = new TextEncoder().encode(text);
  return new Response(byteStream(bytes, [cut, bytes.byteLength]).stream);
}

export function conversionJson(result: Record<string, unknown>): string {
  return JSON.stringify({
    result: [{ id: "conversion-1", name: "file.pdf", mimeType: "application/pdf", ...result }],
    success: true,
  });
}

export function markdownJson(data: string, format = "markdown"): string {
  return conversionJson({ format, tokens: 9, data });
}

/** A conversion response whose `format` follows its `data`. */
export function formatLastJson(data: string, format = "markdown"): string {
  return `{"result":[{"id":"c","data":${JSON.stringify(data)},"format":"${format}"}],"success":true}`;
}

/**
 * A fake binding: reads the request body the way the service does, then answers. A body that
 * errors while being read makes `fetch` reject, as the real one does.
 */
export function fakeAi(answer: Response | Error | ((sent: Sent) => Response)) {
  let sent: Sent[] = [];
  let ai = {
    fetch: async (url: string, init: RequestInit) => {
      let json = JSON.parse(await new Response(init.body).text()) as Sent["json"];
      let request = { url, init, json };
      sent.push(request);
      if (answer instanceof Error) throw answer;
      return typeof answer === "function" ? answer(request) : answer;
    },
  } as unknown as AiFetcher;
  return { ai, sent };
}

/** The body of a vision request, as far as the tests read it. */
export type VisionJson = {
  inputs: {
    messages: { role: string; content: { type: string; text?: string; image_url?: { url: string } }[] }[];
    [setting: string]: unknown;
  };
  options: unknown;
};

/** The image a vision request carried: its data URI's MIME type, and its bytes. */
export function sentImage(sent: Sent): { mimeType: string; bytes: Uint8Array } {
  let { inputs } = sent.json as unknown as VisionJson;
  let url = inputs.messages[0]!.content.find(part => part.type === "image_url")!.image_url!.url;
  let [, mimeType, data] = /^data:([^;]+);base64,(.*)$/.exec(url)!;
  return { mimeType: mimeType!, bytes: decodeBase64(data!) };
}

/** One event of a model's streamed answer. */
function event(delta: object, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "a", object: "chat.completion.chunk", model: "@cf/google/gemma-4-26b-a4b-it",
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }],
    usage: { prompt_tokens: 0, completion_tokens: 1 }, p: "abc",
  })}\n\n`;
}

/**
 * A model's streamed answer as Workers AI sends it: an opening event, one per piece of text, a
 * closing one carrying `finish`, the usage summary, and `[DONE]`.
 */
export function tokenEvents(pieces: string[], finish = "stop"): string {
  return event({ reasoning_content: null, role: "assistant", content: "" }) +
    pieces.map(content => event({ content })).join("") +
    event({ content: "" }, finish) +
    `data: ${JSON.stringify({ id: "a", choices: [], usage: {} })}\n\n` +
    `data: ${JSON.stringify({ response: "", usage: { prompt_tokens: 318, completion_tokens: 340 } })}\n\n` +
    "data: [DONE]\n\n";
}

/** A response streaming server-sent `events` out `size` bytes at a time. */
export function eventResponse(events: string, size = 11, status = 200) {
  let bytes = new TextEncoder().encode(events);
  return new Response(byteStream(bytes, [size]).stream, {
    status, headers: { "Content-Type": "text/event-stream" },
  });
}

export function decodeBase64(data: string): Uint8Array {
  return Uint8Array.from(atob(data), ch => ch.charCodeAt(0));
}
