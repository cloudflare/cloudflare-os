import { describe, expect, it } from "vitest";
import {
  type AiFetcher, convertToMarkdown, type MarkdownConversion, MarkdownConversionError,
} from "../src/workers-ai-markdown";
import {
  BYTES, byteStream, conversionJson, decodeBase64, fakeAi, formatLastJson, markdownJson,
  splitResponse, streamedResponse,
} from "./workers-ai-fixture";

const TO_MARKDOWN_URL = "https://workers-binding.ai/to-everything/markdown/transformer";
const OPTIONS = { conversionOptions: { pdf: { metadata: false } } };

function source(body: ReadableStream<Uint8Array>) {
  return { name: "doc.pdf", mimeType: "application/pdf", body };
}

/** Every piece of a conversion's text, joined. */
async function drain(conversion: MarkdownConversion): Promise<string> {
  let text = "";
  for (let piece = await conversion.next(); piece !== undefined; piece = await conversion.next()) {
    expect(piece).not.toBe("");
    text += piece;
  }
  return text;
}

/** The text a conversion answering `response` gives. */
async function textOf(response: Response): Promise<string> {
  let conversion =
    await convertToMarkdown(fakeAi(response).ai, source(byteStream(BYTES).stream), OPTIONS);
  return drain(conversion);
}

/** The failure a promise rejects with, which must be a {@link MarkdownConversionError}. */
async function failureOf(promise: Promise<unknown>) {
  let error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(MarkdownConversionError);
  return error as MarkdownConversionError;
}

describe("convertToMarkdown's request", () => {
  it("streams the source to the binding's conversion service as toMarkdown's JSON", async () => {
    let { ai, sent } = fakeAi(streamedResponse(markdownJson("text")));
    // Chunk sizes that leave 0, 1 and 2 bytes over a 3-byte base64 group.
    let pdf = byteStream(BYTES, [1, 2, 4, 5, 64, 3]).stream;
    let conversion = await convertToMarkdown(ai, source(pdf), OPTIONS);

    expect(conversion.sentBytes).toBe(BYTES.byteLength);
    expect(sent).toHaveLength(1);
    let [{ url, init, json }] = sent;
    expect(url).toBe(TO_MARKDOWN_URL);
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
    expect(init.body).toBeInstanceOf(ReadableStream);
    expect(json.files.map(({ name, mimeType }) => ({ name, mimeType })))
      .toEqual([{ name: "doc.pdf", mimeType: "application/pdf" }]);
    expect(decodeBase64(json.files[0]!.data)).toEqual(BYTES);
    expect(json.options).toEqual(OPTIONS);
  });

  it("encodes a source that arrives one byte at a time, and an empty and a one-byte one", async () => {
    let cases: [Uint8Array, number[] | undefined][] =
      [[BYTES, [1]], [new Uint8Array(), undefined], [Uint8Array.of(0xff), undefined]];
    for (let [bytes, sizes] of cases) {
      let { ai, sent } = fakeAi(streamedResponse(markdownJson("text")));
      await convertToMarkdown(ai, source(byteStream(bytes, sizes).stream), OPTIONS);
      expect(decodeBase64(sent[0]!.json.files[0]!.data)).toEqual(bytes);
    }
  });

  it("cancels the source when the request body is cancelled", async () => {
    let { stream, state } = byteStream(BYTES, [10]);
    let ai = {
      fetch: async (_url: string, init: RequestInit) => {
        let reader = (init.body as ReadableStream<Uint8Array>).getReader();
        await reader.read();
        await reader.read();
        await reader.cancel();
        throw new Error("request aborted");
      },
    } as unknown as AiFetcher;

    await failureOf(convertToMarkdown(ai, source(stream), OPTIONS));
    expect(state.cancelled).toBe(true);
  });
});

describe("convertToMarkdown's response", () => {
  it("decodes escapes and multi-byte characters split anywhere in the response", async () => {
    // The response as it is on the wire: JSON escapes, \u escapes (one a surrogate pair), and raw
    // multi-byte UTF-8.
    let data = String.raw`Quote \" slash \\ \/ tab\t café é 😀 😀 end\n`;
    let json = `{"result":[{"id":"c","format":"markdown","tokens":1,"data":"${data}"}],"success":true}`;
    let expected = 'Quote " slash \\ / tab\t café é 😀 😀 end\n';
    let length = new TextEncoder().encode(json).byteLength;
    for (let cut = 1; cut < length; cut++) {
      expect(await textOf(splitResponse(json, cut))).toBe(expected);
    }
    for (let size of [1, 2, 3, 5]) {
      expect(await textOf(streamedResponse(json, size))).toBe(expected);
    }
  });

  it("reads only the fields of the first result, wherever they fall", async () => {
    let json = JSON.stringify({
      data: "top-level data",
      result: [
        { meta: { data: "nested", format: "error" }, data: "Real", tokens: 3, format: "markdown" },
        { format: "error", error: "second result", data: "other" },
      ],
      success: true,
    });
    expect(await textOf(streamedResponse(json, 4))).toBe("Real");
  });

  it("accepts a format that comes after the text, and plain-text output", async () => {
    expect(await textOf(streamedResponse(formatLastJson("Late format")))).toBe("Late format");
    expect(await textOf(streamedResponse(markdownJson("Plain", "text")))).toBe("Plain");
  });

  it("reads the response only as the text is asked for, and cancels it with the conversion", async () => {
    let state = { pulls: 0, cancelled: false };
    let body = new ReadableStream<Uint8Array>({
      pull(controller) {
        state.pulls++;
        controller.enqueue(new TextEncoder().encode(
          state.pulls === 1 ? '{"result":[{"format":"markdown","data":"' : `line ${state.pulls}\\n`));
      },
      cancel() { state.cancelled = true; },
    }, { highWaterMark: 0 });
    let conversion = await convertToMarkdown(
      fakeAi(new Response(body)).ai, source(byteStream(BYTES).stream), OPTIONS);
    expect(state.pulls).toBeLessThanOrEqual(1);

    expect(await conversion.next()).toBe("line 2\n");
    expect(state.pulls).toBeLessThanOrEqual(3);
    await conversion.cancel();
    expect(state.cancelled).toBe(true);
  });
});

describe("convertToMarkdown's failures", () => {
  it("fails with the service's status and code, never its text, on an HTTP error", async () => {
    let { ai } = fakeAi(streamedResponse(
      '{"errors":[{"message":"Error converting to markdown","code":6006}],"success":false}', 7, 400));

    let error = await failureOf(convertToMarkdown(ai, source(byteStream(BYTES).stream), OPTIONS));

    expect(error.failure).toEqual({ httpStatus: 400, providerCode: 6006 });
    expect(error.sentBytes).toBe(BYTES.byteLength);
    expect(error.message).not.toContain("Error converting");
  });

  it("fails with the binding's error when it throws", async () => {
    let thrown = new Error("binding failed");
    let error = await failureOf(
      convertToMarkdown(fakeAi(thrown).ai, source(byteStream(BYTES).stream), OPTIONS));
    expect(error.failure).toEqual({ error: thrown });
  });

  it.each([
    ["names a format that is not text",
      conversionJson({ format: "error", error: "Invalid PDF: Invalid PDF structure." })],
    ["names an unknown format", markdownJson("text", "html")],
    ["ends before its JSON closes", '{"result":[{"format":"markdown","data":"partial'],
    ["ends without a format", '{"result":[{"data":"text"}],"success":true}'],
  ])("fails reading a response that %s, without the service's text", async (_label, json) => {
    let error = await failureOf(textOf(streamedResponse(json, 5)));
    expect(String((error.failure as { error: unknown }).error)).not.toContain("Invalid PDF");
  });

  it("fails after the text it gave when a later format is not text", async () => {
    await failureOf(textOf(streamedResponse(formatLastJson("Some text", "error"), 64)));
  });

  it.each([
    ["the binding throws mid-upload", "throw"],
    ["the service answers an error before reading the source", "error"],
  ])("releases the source when %s", async (_label, outcome) => {
    let { stream, state } = byteStream(BYTES, [10]);
    let ai = {
      fetch: async (_url: string, init: RequestInit) => {
        let reader = (init.body as ReadableStream<Uint8Array>).getReader();
        await reader.read();
        await reader.read();
        // The request keeps the body locked, as a real fetch does while it runs.
        if (outcome === "throw") throw new Error("binding failed");
        return streamedResponse('{"errors":[{"code":429}]}', 7, 429);
      },
    } as unknown as AiFetcher;

    await failureOf(convertToMarkdown(ai, source(stream), OPTIONS));
    expect(state.cancelled).toBe(true);
  });

  it("throws the source's own error, such as a download breaking off, as it is", async () => {
    let brokeOff = new Error("The Google Drive download failed.");
    let sentChunk = false;
    let body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sentChunk) throw brokeOff;
        sentChunk = true;
        controller.enqueue(BYTES);
      },
    });

    let { ai } = fakeAi(streamedResponse(markdownJson("text")));
    await expect(convertToMarkdown(ai, source(body), OPTIONS)).rejects.toBe(brokeOff);
  });
});
