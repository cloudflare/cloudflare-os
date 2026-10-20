import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AiFetcher, pdfToText } from "../src/drive-pdf";

// What Workers AI's toMarkdown returned for generated PDFs with metadata off and images unconverted.
/** A three-page text PDF, its opening, a page break, and its end. */
const TEXT_PDF =
  "# file.pdf\n## Contents\n### Page 1\nChapter 1: Probe heading\n" +
  "Page 1 line 1: the quick brown fox jumps over the lazy dog.\n" +
  "Page 1 line 61: the quick brown fox jumps over the lazy dog.\n\n\n\n" +
  "### Page 2\nPage 1 line 62: the quick brown fox jumps over the lazy dog.\n\n";
/** An image-only PDF: one page with no text layer. */
const SCANNED_PDF = "# file.pdf\n## Contents\n### Page 1\n\n\n";
/** A 15 MB PDF holding one line of text and one large image. */
const LARGE_PDF = "# file.pdf\n## Contents\n### Page 1\nLarge file probe text\n\n";
const PREAMBLE = "# file.pdf\n## Contents\n";

const PROVIDER_ERROR = "Invalid PDF: Invalid PDF structure.";
const CONVERSION_FAILED = "Google Drive's file could not be converted from PDF.";

const TO_MARKDOWN_URL = "https://workers-binding.ai/to-everything/markdown/transformer";
const OPTIONS = { conversionOptions: { pdf: { metadata: false, images: { convert: false } } } };

type Sent = { url: string; init: RequestInit; json: { files: { name: string; mimeType: string; data: string }[]; options: unknown } };

/** `bytes` as a stream that hands them out in chunks of the given sizes, cycling. */
function pdfStream(bytes: Uint8Array, sizes: number[] = [bytes.byteLength || 1]) {
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
function streamedResponse(text: string, size = 7, status = 200) {
  let bytes = new TextEncoder().encode(text);
  return new Response(pdfStream(bytes, [size]).stream, {
    status, headers: { "Content-Type": "application/json" },
  });
}

/** A response whose body is `text` cut into two chunks at byte `cut`. */
function splitResponse(text: string, cut: number) {
  let bytes = new TextEncoder().encode(text);
  return new Response(pdfStream(bytes, [cut, bytes.byteLength]).stream);
}

function conversionJson(result: Record<string, unknown>): string {
  return JSON.stringify({
    result: [{ id: "conversion-1", name: "file.pdf", mimeType: "application/pdf", ...result }],
    success: true,
  });
}

function markdownJson(data: string, format = "markdown"): string {
  return conversionJson({ format, tokens: 9, data });
}

/**
 * A fake binding: reads the request body the way the service does, then answers. A body that
 * errors while being read makes `fetch` reject, as the real one does.
 */
function fakeAi(answer: Response | Error | ((sent: Sent) => Response)) {
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

/** A conversion response whose `format` follows its `data`. */
function formatLastJson(data: string, format = "markdown"): string {
  return `{"result":[{"id":"c","data":${JSON.stringify(data)},"format":"${format}"}],"success":true}`;
}

/**
 * A response that opens a conversion and then produces lines of text without end, counting the
 * chunks it was asked for.
 */
function endlessResponse() {
  let encoder = new TextEncoder();
  let state = { pulls: 0, cancelled: false };
  let body = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.pulls++;
      controller.enqueue(encoder.encode(state.pulls === 1
        ? `{"result":[{"id":"c","format":"markdown","tokens":1,"data":"${PREAMBLE.replaceAll("\n", "\\n")}`
        : state.pulls === 2 ? "### Page 1\\n" : `line ${state.pulls}\\n`));
    },
    cancel() { state.cancelled = true; },
  }, { highWaterMark: 0 });
  return { response: new Response(body), state };
}

/** The whole streamed text of a conversion. */
async function read(result: { text: ReadableStream<Uint8Array> }): Promise<string> {
  return new Response(result.text).text();
}

/** What a conversion answering `response` streams, and whether it found text. */
async function convert(response: Response) {
  let result = await pdfToText(fakeAi(response).ai, undefined, pdfStream(BYTES).stream);
  return { hasText: result.hasText, text: await read(result) };
}

function decodeBase64(data: string): Uint8Array {
  return Uint8Array.from(atob(data), ch => ch.charCodeAt(0));
}

/** 1,000 bytes covering every byte value, so base64 framing errors show. */
const BYTES = Uint8Array.from({ length: 1000 }, (_, i) => (i * 7) % 256);

if (!("toBase64" in Uint8Array.prototype)) {
  // oxlint-disable-next-line eslint/no-extend-native -- Node's Uint8Array has no toBase64 yet; workerd's, which the conversion runs on, does.
  Object.defineProperty(Uint8Array.prototype, "toBase64", {
    value(this: Uint8Array) {
      return Buffer.from(this.buffer, this.byteOffset, this.byteLength).toString("base64");
    },
  });
}

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pdfToText", () => {
  it("streams the PDF to the conversion service under a fixed name with metadata and images off", async () => {
    let { ai, sent } = fakeAi(streamedResponse(markdownJson(LARGE_PDF)));
    // Chunk sizes that leave 0, 1 and 2 bytes over a 3-byte base64 group.
    let { stream } = pdfStream(BYTES, [1, 2, 4, 5, 64, 3]);

    let result = await pdfToText(ai, undefined, stream);
    expect(result.hasText).toBe(true);
    expect(await read(result)).toBe("### Page 1\nLarge file probe text\n\n");

    expect(sent).toHaveLength(1);
    let [{ url, init, json }] = sent;
    expect(url).toBe(TO_MARKDOWN_URL);
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
    expect(init.body).toBeInstanceOf(ReadableStream);
    expect(json.files).toHaveLength(1);
    expect(json.files[0]!.name).toBe("file.pdf");
    expect(json.files[0]!.mimeType).toBe("application/pdf");
    expect(decodeBase64(json.files[0]!.data)).toEqual(BYTES);
    expect(json.options).toEqual(OPTIONS);
  });

  it("streams a PDF that arrives one byte at a time", async () => {
    let { ai, sent } = fakeAi(streamedResponse(markdownJson(LARGE_PDF)));
    await pdfToText(ai, undefined, pdfStream(BYTES, [1]).stream);
    expect(decodeBase64(sent[0]!.json.files[0]!.data)).toEqual(BYTES);
  });

  it("encodes an empty and a one-byte PDF", async () => {
    for (let bytes of [new Uint8Array(), Uint8Array.of(0xff)]) {
      let { ai, sent } = fakeAi(streamedResponse(markdownJson(LARGE_PDF)));
      await pdfToText(ai, undefined, pdfStream(bytes).stream);
      expect(decodeBase64(sent[0]!.json.files[0]!.data)).toEqual(bytes);
    }
  });

  it("routes through the named AI Gateway only when one is set", async () => {
    let { ai, sent } = fakeAi(() => streamedResponse(markdownJson(LARGE_PDF)));

    await pdfToText(ai, "instance-gateway", pdfStream(BYTES).stream);
    await pdfToText(ai, "", pdfStream(BYTES).stream);

    expect(sent[0]!.json.options).toEqual({ gateway: { id: "instance-gateway" }, ...OPTIONS });
    expect(sent[1]!.json.options).toEqual(OPTIONS);
  });

  it("cancels the PDF when the request body is cancelled", async () => {
    let { stream, state } = pdfStream(BYTES, [10]);
    let ai = {
      fetch: async (_url: string, init: RequestInit) => {
        let reader = (init.body as ReadableStream<Uint8Array>).getReader();
        await reader.read();
        await reader.read();
        await reader.cancel();
        throw new Error("request aborted");
      },
    } as unknown as AiFetcher;

    await expect(pdfToText(ai, undefined, stream)).rejects.toThrow(CONVERSION_FAILED);
    expect(state.cancelled).toBe(true);
  });
});

describe("pdfToText's text", () => {
  it("streams a text PDF's pages without the preamble, keeping its trailing whitespace", async () => {
    expect(await convert(streamedResponse(markdownJson(TEXT_PDF))))
      .toEqual({ hasText: true, text: TEXT_PDF.slice(PREAMBLE.length) });
    expect(await convert(streamedResponse(markdownJson(LARGE_PDF))))
      .toEqual({ hasText: true, text: "### Page 1\nLarge file probe text\n\n" });
  });

  it("reports a scanned PDF as having no text, with an empty stream", async () => {
    expect(await convert(streamedResponse(markdownJson(SCANNED_PDF))))
      .toEqual({ hasText: false, text: "" });
    expect(await convert(streamedResponse(markdownJson(`${PREAMBLE}### Page 1\n\n\n\n\n### Page 2\n \t\n`))))
      .toEqual({ hasText: false, text: "" });
    expect(await convert(streamedResponse(markdownJson("")))).toEqual({ hasText: false, text: "" });
  });

  it("leaves out pages before the first with text, keeping that page's heading", async () => {
    let data = `${PREAMBLE}### Page 1\n\n\n\n### Page 2\n  \n\n### Page 3\n\n  First words\n\n### Page 4\n\nMore\n`;
    expect(await convert(streamedResponse(markdownJson(data), 3)))
      .toEqual({ hasText: true, text: "### Page 3\nFirst words\n\n### Page 4\n\nMore\n" });
  });

  it("keeps output that does not open with the expected preamble", async () => {
    for (let data of [
      "# Quarterly Report.pdf\n## Contents\n### Page 1\nRevenue\n",
      "# file.pdf\nOnly a title line",
      "# file.pdf",
      "Text before any heading\n### Page 1\nMore",
    ]) {
      expect(await convert(streamedResponse(markdownJson(data), 2))).toEqual({ hasText: true, text: data });
    }
  });

  it("accepts plain-text output", async () => {
    expect(await convert(streamedResponse(markdownJson("Plain words", "text"))))
      .toEqual({ hasText: true, text: "Plain words" });
  });

  it("counts a line that only resembles a page heading as text", async () => {
    for (let line of ["### Page one", "  ### Page 1", "### Page 1 ", `### Page ${"1".repeat(40)}`]) {
      expect(await convert(streamedResponse(markdownJson(`${PREAMBLE}### Page 1\n${line}\nrest`), 4)))
        .toEqual({ hasText: true, text: `### Page 1\n${line.trimStart()}\nrest` });
    }
  });

  it("decodes escapes and multi-byte characters split anywhere in the response", async () => {
    // The response as it is on the wire: JSON escapes, \u escapes (one a surrogate pair), and raw
    // multi-byte UTF-8.
    let data = String.raw`# file.pdf\n## Contents\n### Page 1\nQuote \" slash \\ \/ tab\t café \u00e9 😀 \ud83d\ude00 end\n`;
    let json = `{"result":[{"id":"c","format":"markdown","tokens":1,"data":"${data}"}],"success":true}`;
    let expected = { hasText: true, text: '### Page 1\nQuote " slash \\ / tab\t café é 😀 😀 end\n' };
    let length = new TextEncoder().encode(json).byteLength;
    for (let cut = 1; cut < length; cut++) {
      expect(await convert(splitResponse(json, cut))).toEqual(expected);
    }
    for (let size of [1, 2, 3, 5]) {
      expect(await convert(streamedResponse(json, size))).toEqual(expected);
    }
  });

  it("reads only the fields of the first result, wherever they fall", async () => {
    let json = JSON.stringify({
      data: "top-level data",
      result: [
        { meta: { data: "nested", format: "error" }, data: `${PREAMBLE}### Page 1\nReal\n`, tokens: 3, format: "markdown" },
        { format: "error", error: "second result", data: "other" },
      ],
      success: true,
    });
    expect(await convert(streamedResponse(json, 4))).toEqual({ hasText: true, text: "### Page 1\nReal\n" });
  });

  it("reads a format that comes after the text", async () => {
    expect(await convert(streamedResponse(formatLastJson(TEXT_PDF))))
      .toEqual({ hasText: true, text: TEXT_PDF.slice(PREAMBLE.length) });
    expect(await convert(streamedResponse(formatLastJson(SCANNED_PDF)))).toEqual({ hasText: false, text: "" });
  });

  it("logs a conversion's size and whether it had text, never its text", async () => {
    let info = vi.mocked(console.info);
    let { ai } = fakeAi(streamedResponse(markdownJson(TEXT_PDF)));

    let result = await pdfToText(ai, undefined, pdfStream(BYTES, [100]).stream);
    await read(result);

    expect(info).toHaveBeenCalledWith(expect.objectContaining({
      event: "google.drive.pdf.converted", pdfBytes: BYTES.byteLength, hasText: true,
    }));
    let logged = JSON.stringify(info.mock.calls);
    expect(logged).not.toContain("Probe heading");
    expect(logged).not.toContain("quick brown fox");
  });
});

describe("pdfToText's streaming", () => {
  it("returns once the text begins, and reads the rest only as the text is read", async () => {
    let { response, state } = endlessResponse();

    let result = await pdfToText(fakeAi(response).ai, undefined, pdfStream(BYTES).stream);

    expect(result.hasText).toBe(true);
    expect(state.pulls).toBeLessThanOrEqual(4);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(state.pulls).toBeLessThanOrEqual(4);

    let reader = result.text.getReader();
    let decoder = new TextDecoder();
    let text = "";
    for (let i = 0; i < 20; i++) {
      let chunk = await reader.read();
      expect(chunk.done).toBe(false);
      expect(chunk.value!.byteLength).toBeGreaterThan(0);
      text += decoder.decode(chunk.value, { stream: true });
    }
    expect(text.startsWith("### Page 1\nline 3\nline 4\n")).toBe(true);
    expect(state.pulls).toBeLessThanOrEqual(24);

    await reader.cancel();
    expect(state.cancelled).toBe(true);
  });

  it("cancels the response when the text is cancelled unread", async () => {
    let { response, state } = endlessResponse();
    let result = await pdfToText(fakeAi(response).ai, undefined, pdfStream(BYTES).stream);
    await result.text.cancel();
    expect(state.cancelled).toBe(true);
  });

  it("logs no failure when the text is cancelled during a read", async () => {
    let warn = vi.mocked(console.warn);
    let encoder = new TextEncoder();
    let sent = false;
    let body = new ReadableStream<Uint8Array>({
      pull(controller) {
        // The text begins, then the response stalls until it is cancelled.
        if (sent) return new Promise<void>(() => {});
        sent = true;
        controller.enqueue(encoder.encode(`{"result":[{"format":"markdown","data":"${PREAMBLE}### Page 1\\nline 1\\nline`));
      },
    }, { highWaterMark: 0 });
    let result = await pdfToText(fakeAi(new Response(body)).ai, undefined, pdfStream(BYTES).stream);
    let reader = result.text.getReader();
    expect((await reader.read()).done).toBe(false);

    let pending = reader.read();
    await new Promise(resolve => setTimeout(resolve, 0));
    await reader.cancel();

    expect((await pending).done).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it("errors the text in its own words when the response ends after the text began", async () => {
    let warn = vi.mocked(console.warn);
    let json = markdownJson(TEXT_PDF);
    let { ai } = fakeAi(streamedResponse(json.slice(0, json.indexOf("Page 2")), 16));

    let result = await pdfToText(ai, undefined, pdfStream(BYTES).stream);

    expect(result.hasText).toBe(true);
    await expect(read(result)).rejects.toThrow(CONVERSION_FAILED);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      event: "google.drive.pdf.failed", pdfBytes: BYTES.byteLength,
    }));
    expect(JSON.stringify(warn.mock.calls)).not.toContain("quick brown fox");
  });

  it("errors the text in its own words when reading the response fails", async () => {
    let warn = vi.mocked(console.warn);
    let encoder = new TextEncoder();
    let sent = false;
    let body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) throw new Error("connection reset");
        sent = true;
        controller.enqueue(encoder.encode(markdownJson(TEXT_PDF).slice(0, 220)));
      },
    });

    let result = await pdfToText(fakeAi(new Response(body)).ai, undefined, pdfStream(BYTES).stream);

    let error = await read(result).catch((caught: unknown) => caught);
    expect((error as Error).message).toBe(CONVERSION_FAILED);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: "google.drive.pdf.failed" }));
  });

  it("errors the text when a format after it is not a text format", async () => {
    let warn = vi.mocked(console.warn);
    let response = streamedResponse(formatLastJson(TEXT_PDF, "error"), 64);

    let result = await pdfToText(fakeAi(response).ai, undefined, pdfStream(BYTES).stream);

    expect(result.hasText).toBe(true);
    await expect(read(result)).rejects.toThrow(CONVERSION_FAILED);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: "google.drive.pdf.failed" }));
  });
});

describe("pdfToText's failures", () => {
  it("fails in its own words when Workers AI cannot convert the file", async () => {
    let warn = vi.mocked(console.warn);
    let { ai } = fakeAi(streamedResponse(conversionJson({ format: "error", error: PROVIDER_ERROR })));

    let error = await pdfToText(ai, undefined, pdfStream(BYTES).stream).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(CONVERSION_FAILED);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      event: "google.drive.pdf.failed", pdfBytes: BYTES.byteLength,
    }));
    expect(JSON.stringify(warn.mock.calls)).not.toContain(PROVIDER_ERROR);
  });

  it("fails in its own words on an HTTP error, logging its status and code but not its body", async () => {
    let warn = vi.mocked(console.warn);
    let { ai } = fakeAi(streamedResponse(
      '{"errors":[{"message":"Error converting to markdown","code":6006}],"success":false}', 7, 400));

    let error = await pdfToText(ai, undefined, pdfStream(BYTES).stream).catch((caught: unknown) => caught);

    expect((error as Error).message).toBe(CONVERSION_FAILED);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      event: "google.drive.pdf.failed", httpStatus: 400, providerCode: 6006,
    }));
    expect(JSON.stringify(warn.mock.calls)).not.toContain("Error converting");
  });

  it("fails in its own words when the binding throws", async () => {
    let warn = vi.mocked(console.warn);
    let { ai } = fakeAi(new Error("6006: Error converting to markdown"));

    let error = await pdfToText(ai, undefined, pdfStream(BYTES).stream).catch((caught: unknown) => caught);

    expect((error as Error).message).toBe(CONVERSION_FAILED);
    expect((error as Error).message).not.toContain("6006");
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: "google.drive.pdf.failed" }));
  });

  it.each([
    ["inside the preamble", `{"result":[{"id":"c","format":"markdown","data":"# file.pdf\\n## Con`],
    ["inside a page heading", `{"result":[{"id":"c","format":"markdown","data":"# file.pdf\\n## Contents\\n### Pa`],
    ["after the text's string closes", `{"result":[{"id":"c","format":"markdown","data":"${PREAMBLE.replaceAll("\n", "\\n")}"}`],
    ["before any format", `{"result":[{"id":"c","data":"${PREAMBLE.replaceAll("\n", "\\n")}"}],"success":true}`],
  ])("fails on a response that ends or breaks before any text: %s", async (_label, json) => {
    let warn = vi.mocked(console.warn);
    let { ai } = fakeAi(streamedResponse(json, 5));
    await expect(pdfToText(ai, undefined, pdfStream(BYTES).stream)).rejects.toThrow(CONVERSION_FAILED);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: "google.drive.pdf.failed" }));
  });

  it("treats an unknown output format as a failure", async () => {
    let { ai } = fakeAi(streamedResponse(markdownJson("text", "html")));
    await expect(pdfToText(ai, undefined, pdfStream(BYTES).stream)).rejects.toThrow(CONVERSION_FAILED);
  });

  it.each([
    ["the binding throws mid-upload", "throw"],
    ["the service answers an error before reading the PDF", "error"],
  ])("releases the download when %s", async (_label, outcome) => {
    let { stream, state } = pdfStream(BYTES, [10]);
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

    await expect(pdfToText(ai, undefined, stream)).rejects.toThrow(CONVERSION_FAILED);
    expect(state.cancelled).toBe(true);
  });

  it("throws the PDF stream's own error, such as a download breaking off, as it is", async () => {
    let warn = vi.mocked(console.warn);
    let brokeOff = new Error("The Google Drive download failed.");
    let sentChunk = false;
    let pdf = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sentChunk) throw brokeOff;
        sentChunk = true;
        controller.enqueue(BYTES);
      },
    });
    let { ai } = fakeAi(streamedResponse(markdownJson(TEXT_PDF)));

    await expect(pdfToText(ai, undefined, pdf)).rejects.toBe(brokeOff);
    expect(warn).not.toHaveBeenCalled();
  });
});
