import { describe, expect, it } from "vitest";
import type { AiFetcher } from "../src/workers-ai-markdown";
import { transcribeImage, TranscriptionError, type Transcription } from "../src/workers-ai-vision";
import {
  BYTES, byteStream, eventResponse, fakeAi, sentImage, tokenEvents, type VisionJson,
} from "./workers-ai-fixture";

const RUN_URL = "https://workers-binding.ai/run?version=3";
const GATEWAY_RUN_URL = "https://workers-binding.ai/ai-gateway/run?version=3";
const PAGE = ["Harbour Ledger", " Review\n\n", "Lot 55-0193-G, ", "18,442.07 florins."];

function jpeg(body: ReadableStream<Uint8Array> = byteStream(BYTES).stream) {
  return { mimeType: "image/jpeg" as const, body };
}

/** Every piece of a transcription's text, joined. */
async function drain(transcription: Transcription): Promise<string> {
  let text = "";
  for (let piece = await transcription.next(); piece !== undefined; piece = await transcription.next()) {
    expect(piece).not.toBe("");
    text += piece;
  }
  return text;
}

/** The text a transcription answered with `events` gives. */
async function textOf(events: string, size?: number): Promise<string> {
  return drain(await transcribeImage(fakeAi(eventResponse(events, size)).ai, undefined, jpeg()));
}

async function failure(run: Promise<unknown>): Promise<TranscriptionError> {
  let error = await run.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(TranscriptionError);
  return error as TranscriptionError;
}

describe("transcribeImage", () => {
  it("posts the image as a data URI to the model, with thinking off", async () => {
    let { ai, sent } = fakeAi(eventResponse(tokenEvents(PAGE)));

    let transcription = await transcribeImage(ai, undefined, jpeg(byteStream(BYTES, [1, 2, 300]).stream));
    expect(await drain(transcription)).toBe(PAGE.join(""));
    expect(transcription).toMatchObject({ sentBytes: BYTES.byteLength, truncated: false });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(RUN_URL);
    expect(sent[0]!.init.method).toBe("POST");
    expect(sent[0]!.init.headers).toEqual({
      "Content-Type": "application/json",
      "cf-consn-sdk-version": "2.0.0",
      "cf-consn-model-id": "@cf/google/gemma-4-26b-a4b-it",
    });
    expect(sentImage(sent[0]!)).toEqual({ mimeType: "image/jpeg", bytes: BYTES });
    let { inputs, options } = sent[0]!.json as unknown as VisionJson;
    expect(options).toEqual({});
    let { messages, ...settings } = inputs;
    expect(settings).toEqual({
      temperature: 0, max_tokens: 8192, stream: true,
      chat_template_kwargs: { enable_thinking: false },
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe("user");
    expect(messages[0]!.content.map(part => part.type)).toEqual(["text", "image_url"]);
    expect(messages[0]!.content[0]!.text).toContain("Transcribe");
  });

  it("goes through the named AI Gateway's endpoint", async () => {
    let { ai, sent } = fakeAi(eventResponse(tokenEvents(PAGE)));
    await drain(await transcribeImage(ai, "team-gateway", { mimeType: "image/png", body: byteStream(BYTES).stream }));
    expect(sent[0]!.url).toBe(GATEWAY_RUN_URL);
    expect((sent[0]!.json as unknown as VisionJson).options).toEqual({ gateway: { id: "team-gateway" } });
    expect(sentImage(sent[0]!).mimeType).toBe("image/png");
  });

  it("asks for a band of a page in the page's words and a sentence more, with the page's settings", async () => {
    let requests: VisionJson[] = [];
    for (let options of [undefined, {}, { band: true }]) {
      let { ai, sent } = fakeAi(eventResponse(tokenEvents(PAGE)));
      expect(await drain(await transcribeImage(ai, undefined, jpeg(), undefined, options))).toBe(PAGE.join(""));
      requests.push(sent[0]!.json as unknown as VisionJson);
    }
    let [page, , band] = requests.map(request => request.inputs.messages[0]!.content[0]!.text!);
    expect(page).toContain("this scanned page");
    expect(page).not.toContain("image or a link");
    // The page's prompt, and one sentence more before its last.
    let added = " Never write an image or a link: of a stamp, a logo or a picture, write only the words printed in it.";
    let last = " If the page has no text, reply with nothing at all.";
    expect(page.endsWith(last)).toBe(true);
    expect(band).toBe(page.slice(0, -last.length) + added + last);
    expect(requests[1]).toEqual(requests[0]);
    // Nothing is sent that would vary the answer of an image asked for twice: no seed.
    let { messages: _messages, ...settings } = requests[2]!.inputs;
    expect(settings).toEqual({
      temperature: 0, max_tokens: 8192, stream: true,
      chat_template_kwargs: { enable_thinking: false },
    });
  });

  it("reads the text whatever the size of the response's chunks", async () => {
    let pieces = ["Tab\tle | \"quoted\" \\ back", "slash\n", "é ü 你好 ", "😀", " end"];
    for (let size of [1, 2, 3, 5, 64, 100_000]) {
      expect(await textOf(tokenEvents(pieces), size)).toBe(pieces.join(""));
    }
  });

  it("keeps the halves of a surrogate pair sent in two events together", async () => {
    // In chunks small enough that the first half is read before the second has come.
    for (let size of [1, 11, 64]) {
      let transcription = await transcribeImage(
        fakeAi(eventResponse(tokenEvents(["a\ud83d", "\ude00b"]), size)).ai, undefined, jpeg());
      let pieces: string[] = [];
      for (let piece = await transcription.next(); piece !== undefined; piece = await transcription.next()) {
        pieces.push(piece);
      }
      expect(pieces).toEqual(["a", "😀b"]);
    }
  });

  it("passes over what the model thinks, and takes text sent as bare responses", async () => {
    let thinking = `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "I need", reasoning: "to" } }] })}\n\n`;
    expect(await textOf(`${thinking}${tokenEvents(["text"])}`)).toBe("text");
    expect(await textOf(`: comment\nevent: x\ndata: {"response":"plain "}\r\ndata:{"response":"events"}\n\ndata: [DONE]\n`))
      .toBe("plain events");
  });

  it("gives no text for a page the model finds none on", async () => {
    expect(await textOf(tokenEvents([]))).toBe("");
  });

  it("says when the model was stopped at its output limit", async () => {
    let transcription = await transcribeImage(
      fakeAi(eventResponse(tokenEvents(["cut"], "length"))).ai, undefined, jpeg());
    expect(await drain(transcription)).toBe("cut");
    expect(transcription.truncated).toBe(true);
  });

  it("stops reading the response once the model says it is done", async () => {
    let state = { cancelled: false, pulls: 0 };
    let events = new TextEncoder().encode(tokenEvents(["all"]));
    let body = new ReadableStream<Uint8Array>({
      pull(controller) {
        // Sends the whole answer, then never ends.
        if (state.pulls++ === 0) controller.enqueue(events);
      },
      cancel() { state.cancelled = true; },
    }, { highWaterMark: 0 });
    expect(await drain(await transcribeImage(fakeAi(new Response(body)).ai, undefined, jpeg()))).toBe("all");
    expect(state.cancelled).toBe(true);
  });

  it("reports a refused request by its status and error code only", async () => {
    let image = byteStream(BYTES);
    let body = JSON.stringify({
      name: "AiError", internalCode: 8006, httpCode: 400,
      message: "AiError: Invalid data for body - secret page text",
    });
    let error = await failure(transcribeImage(
      fakeAi(new Response(body, { status: 400 })).ai, undefined, jpeg(image.stream)));
    expect(error.failure).toEqual({ httpStatus: 400, providerCode: 8006 });
    expect(error.message).toBe("Workers AI could not transcribe the image.");
    expect(JSON.stringify(error.failure)).not.toContain("secret");
    expect(error.sentBytes).toBe(BYTES.byteLength);
  });

  it("reports a request the binding throws on, and releases the image", async () => {
    let image = byteStream(BYTES, [10]);
    let thrown = new Error("Network connection lost.");
    let ai = { fetch: async () => { throw thrown; } } as unknown as AiFetcher;
    let error = await failure(transcribeImage(ai, undefined, jpeg(image.stream)));
    expect(error.failure).toEqual({ error: thrown });
    expect(image.state.cancelled).toBe(true);
  });

  it("gives up a request the service has not answered when aborted, and releases the image", async () => {
    let image = byteStream(BYTES, [10]);
    let request = new AbortController();
    let ai = {
      fetch: (_url: string, { signal }: RequestInit) => new Promise<Response>((_, reject) => {
        signal!.addEventListener("abort", () => reject(signal!.reason));
      }),
    } as unknown as AiFetcher;
    let pending = failure(transcribeImage(ai, undefined, jpeg(image.stream), request.signal));
    let reason = new Error("no longer wanted");
    request.abort(reason);
    expect(image.state.cancelled).toBe(true);
    expect((await pending).failure).toEqual({ error: reason });
  });

  // Each but the first goes on to say it is done, so that only what came before fails it.
  it.each([
    ["ends before saying it is done", tokenEvents(["partial"]).replace("data: [DONE]\n\n", ""),
      "The model's response ended early."],
    ["reports an error partway", tokenEvents(["partial"]).replace("data: [DONE]", 'data: {"error":"secret upstream text"}\n\ndata: [DONE]'),
      "The model reported an error partway through."],
    ["reports errors partway", tokenEvents(["partial"]).replace("data: [DONE]", 'data: {"errors":[{"message":"secret"}]}\n\ndata: [DONE]'),
      "The model reported an error partway through."],
    // Text a JSON parser quotes in its own error.
    ["holds an event that is not JSON", `data: {"response":"partial"}\n\ndata: Lot 55-0193-G secret\n\ndata: [DONE]\n\n`,
      "The model's response held an event that is not JSON."],
  ])("fails, without the service's words, on a response that %s", async (_label, events, message) => {
    let transcription = await transcribeImage(fakeAi(eventResponse(events)).ai, undefined, jpeg());
    let error = await failure(drain(transcription));
    expect((error.failure as { error: Error }).error.message).toBe(message);
    expect(error.sentBytes).toBe(BYTES.byteLength);
  });

  it("fails on a response that is not a stream of events, holding no more of it than a line may be", async () => {
    let response = { cancelled: false, pulls: 0 };
    // A megabyte with no line end in it, which then ends.
    let body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (response.pulls++ === 10) controller.close();
        else controller.enqueue(new Uint8Array(100_000).fill(120));
      },
      cancel() { response.cancelled = true; },
    }, { highWaterMark: 0 });
    let transcription = await transcribeImage(fakeAi(new Response(body)).ai, undefined, jpeg());
    let error = await failure(drain(transcription));
    expect((error.failure as { error: Error }).error.message).toBe("The model's response is not a stream of events.");
    // Given up, and let go, at the first piece that makes the line longer than one may be.
    expect(response.pulls).toBe(3);
    expect(response.cancelled).toBe(true);
  });

  it.each([
    ["reports an error", 'data: {"error":"secret upstream text"}\n\n'],
    ["holds an event that is not JSON", "data: Lot 55-0193-G secret\n\n"],
  ])("lets go of a response that %s and stays open, and of the image", async (_label, event) => {
    let response = { cancelled: false, pulls: 0 };
    let events = new TextEncoder().encode(`data: {"response":"partial"}\n\n${event}`);
    let body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (response.pulls++ === 0) controller.enqueue(events);
      },
      cancel() { response.cancelled = true; },
    }, { highWaterMark: 0 });
    // The service answers before it has read the whole image.
    let image = byteStream(BYTES, [10]);
    let ai = {
      fetch: async (_url: string, init: RequestInit) => {
        await (init.body as ReadableStream<Uint8Array>).getReader().read();
        return new Response(body);
      },
    } as unknown as AiFetcher;

    let transcription = await transcribeImage(ai, undefined, jpeg(image.stream));
    await failure(drain(transcription));
    expect(response.cancelled).toBe(true);
    expect(image.state.cancelled).toBe(true);
  });

  it("throws the image stream's own error as it is", async () => {
    let brokeOff = new Error("The Google Drive download failed.");
    let sentChunk = false;
    let body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sentChunk) throw brokeOff;
        sentChunk = true;
        controller.enqueue(BYTES);
      },
    });
    await expect(transcribeImage(fakeAi(eventResponse(tokenEvents(PAGE))).ai, undefined, jpeg(body)))
      .rejects.toBe(brokeOff);
  });

  it("releases the response and the image when cancelled", async () => {
    let response = { cancelled: false };
    let body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new TextEncoder().encode(tokenEvents(["more "]).split("data: [DONE]")[0])); },
      cancel() { response.cancelled = true; },
    }, { highWaterMark: 0 });
    // The service answers before it has read the whole image.
    let image = byteStream(BYTES, [10]);
    let ai = {
      fetch: async (_url: string, init: RequestInit) => {
        await (init.body as ReadableStream<Uint8Array>).getReader().read();
        return new Response(body);
      },
    } as unknown as AiFetcher;

    let transcription = await transcribeImage(ai, undefined, jpeg(image.stream));
    expect(await transcription.next()).toBe("more ");
    await transcription.cancel();
    expect(response.cancelled).toBe(true);
    expect(image.state.cancelled).toBe(true);
  });
});
