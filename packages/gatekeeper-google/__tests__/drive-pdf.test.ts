import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deflateSync } from "node:zlib";
import {
  pdfToText, releasedAtEnd, TRANSCRIPTION_IDLE_MS, type PdfPageRange, type PdfRangeReader,
} from "../src/drive-pdf";
import type { AiFetcher } from "../src/workers-ai-markdown";
import { imagePdf, type BuiltPdf, type PdfImage } from "./pdf-fixture";
import {
  BYTES, byteStream, conversionJson, eventResponse, fakeAi, formatLastJson, markdownJson,
  sentImage, splitResponse, streamedResponse, tokenEvents,
} from "./workers-ai-fixture";

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

const OPTIONS = { conversionOptions: { pdf: { metadata: false, images: { convert: false } } } };

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
  let result = await pdfToText(fakeAi(response).ai, undefined, byteStream(BYTES).stream);
  return { hasText: result.hasText, text: await read(result) };
}

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("pdfToText", () => {
  it("converts under a fixed name with metadata and images off", async () => {
    let { ai, sent } = fakeAi(streamedResponse(markdownJson(LARGE_PDF)));

    let result = await pdfToText(ai, undefined, byteStream(BYTES).stream);
    expect(result.hasText).toBe(true);
    expect(await read(result)).toBe("### Page 1\nLarge file probe text\n\n");

    expect(sent).toHaveLength(1);
    expect(sent[0]!.json.files.map(({ name, mimeType }) => ({ name, mimeType })))
      .toEqual([{ name: "file.pdf", mimeType: "application/pdf" }]);
    expect(sent[0]!.json.options).toEqual(OPTIONS);
  });

  it("routes through the named AI Gateway only when one is set", async () => {
    let { ai, sent } = fakeAi(() => streamedResponse(markdownJson(LARGE_PDF)));

    await pdfToText(ai, "instance-gateway", byteStream(BYTES).stream);
    await pdfToText(ai, "", byteStream(BYTES).stream);

    expect(sent[0]!.json.options).toEqual({ gateway: { id: "instance-gateway" }, ...OPTIONS });
    expect(sent[1]!.json.options).toEqual(OPTIONS);
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

  it("finds the text wherever the response is split", async () => {
    let data = `${PREAMBLE}### Page 1\n\n### Page 2\nWords é 😀\n`;
    let json = markdownJson(data);
    let expected = { hasText: true, text: "### Page 2\nWords é 😀\n" };
    let length = new TextEncoder().encode(json).byteLength;
    for (let cut = 1; cut < length; cut++) {
      expect(await convert(splitResponse(json, cut))).toEqual(expected);
    }
  });

  it("reads a format that comes after the text", async () => {
    expect(await convert(streamedResponse(formatLastJson(TEXT_PDF))))
      .toEqual({ hasText: true, text: TEXT_PDF.slice(PREAMBLE.length) });
    expect(await convert(streamedResponse(formatLastJson(SCANNED_PDF)))).toEqual({ hasText: false, text: "" });
  });

  it("logs a conversion's size and whether it had text, never its text", async () => {
    let info = vi.mocked(console.info);
    let { ai } = fakeAi(streamedResponse(markdownJson(TEXT_PDF)));

    let result = await pdfToText(ai, undefined, byteStream(BYTES, [100]).stream);
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

    let result = await pdfToText(fakeAi(response).ai, undefined, byteStream(BYTES).stream);

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
    let result = await pdfToText(fakeAi(response).ai, undefined, byteStream(BYTES).stream);
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
    let result = await pdfToText(fakeAi(new Response(body)).ai, undefined, byteStream(BYTES).stream);
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

    let result = await pdfToText(ai, undefined, byteStream(BYTES).stream);

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

    let result = await pdfToText(fakeAi(new Response(body)).ai, undefined, byteStream(BYTES).stream);

    let error = await read(result).catch((caught: unknown) => caught);
    expect((error as Error).message).toBe(CONVERSION_FAILED);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: "google.drive.pdf.failed" }));
  });

  it("errors the text when a format after it is not a text format", async () => {
    let warn = vi.mocked(console.warn);
    let response = streamedResponse(formatLastJson(TEXT_PDF, "error"), 64);

    let result = await pdfToText(fakeAi(response).ai, undefined, byteStream(BYTES).stream);

    expect(result.hasText).toBe(true);
    await expect(read(result)).rejects.toThrow(CONVERSION_FAILED);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: "google.drive.pdf.failed" }));
  });
});

describe("releasedAtEnd", () => {
  /** A text of `pieces`, then whatever `after` does, and how often it was let go and cancelled. */
  function held(pieces: string[], after: (controller: ReadableStreamDefaultController<Uint8Array>) => void) {
    let state = { released: 0, cancelled: 0, pulls: 0 };
    let source = new ReadableStream<Uint8Array>({
      pull(controller) {
        let piece = pieces[state.pulls++];
        if (piece === undefined) return after(controller);
        controller.enqueue(new TextEncoder().encode(piece));
      },
      cancel() { state.cancelled++; },
    }, { highWaterMark: 0 });
    return { state, text: releasedAtEnd(source, () => { state.released++; }) };
  }

  it("lets go once the text has been read to its end, and reads no further ahead than asked", async () => {
    let { state, text } = held(["one ", "two"], controller => controller.close());
    let reader = text.getReader();
    expect(state.pulls).toBe(0);
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("one ");
    await settled();
    expect(state).toMatchObject({ pulls: 1, released: 0 });
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("two");
    await settled();
    expect(state).toMatchObject({ pulls: 2, released: 0 });
    expect((await reader.read()).done).toBe(true);
    expect(state).toMatchObject({ released: 1, cancelled: 0 });
  });

  it("lets go once when the text fails, passing the failure on", async () => {
    let failure = new Error("page read refused");
    let { state, text } = held(["one "], controller => controller.error(failure));
    let reader = text.getReader();
    await reader.read();
    await expect(reader.read()).rejects.toBe(failure);
    expect(state.released).toBe(1);
  });

  it("lets go when the text fails while nothing is reading it", async () => {
    let fail!: (error: Error) => void;
    let released = 0;
    releasedAtEnd(new ReadableStream<Uint8Array>({
      start(controller) { fail = error => controller.error(error); },
    }), () => { released++; });
    fail(new Error("sat idle"));
    await Promise.resolve();
    expect(released).toBe(1);
  });

  it("cancels the text and lets go once when cancelled, unread or while a read waits", async () => {
    let unread = held(["one "], () => undefined);
    await unread.text.cancel();
    expect(unread.state).toMatchObject({ pulls: 0, released: 1, cancelled: 1 });

    // The text never produces its second piece.
    let waiting = held(["one "], () => undefined);
    let reader = waiting.text.getReader();
    await reader.read();
    let pending = reader.read();
    await vi.waitFor(() => expect(waiting.state.pulls).toBe(2));
    await reader.cancel();
    expect((await pending).done).toBe(true);
    expect(waiting.state).toMatchObject({ released: 1, cancelled: 1 });
  });
});

describe("pdfToText's failures", () => {
  it("fails in its own words when Workers AI cannot convert the file", async () => {
    let warn = vi.mocked(console.warn);
    let { ai } = fakeAi(streamedResponse(conversionJson({ format: "error", error: PROVIDER_ERROR })));

    let error = await pdfToText(ai, undefined, byteStream(BYTES).stream).catch((caught: unknown) => caught);

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

    let error = await pdfToText(ai, undefined, byteStream(BYTES).stream).catch((caught: unknown) => caught);

    expect((error as Error).message).toBe(CONVERSION_FAILED);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      event: "google.drive.pdf.failed", httpStatus: 400, providerCode: 6006,
    }));
    expect(JSON.stringify(warn.mock.calls)).not.toContain("Error converting");
  });

  it("fails in its own words when the binding throws", async () => {
    let warn = vi.mocked(console.warn);
    let { ai } = fakeAi(new Error("6006: Error converting to markdown"));

    let error = await pdfToText(ai, undefined, byteStream(BYTES).stream).catch((caught: unknown) => caught);

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
    await expect(pdfToText(ai, undefined, byteStream(BYTES).stream)).rejects.toThrow(CONVERSION_FAILED);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: "google.drive.pdf.failed" }));
  });

  it("treats an unknown output format as a failure", async () => {
    let { ai } = fakeAi(streamedResponse(markdownJson("text", "html")));
    await expect(pdfToText(ai, undefined, byteStream(BYTES).stream)).rejects.toThrow(CONVERSION_FAILED);
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

const TRANSCRIPTION_FAILED = "Google Drive's PDF could not be transcribed.";
/** What the model reads on each page of the scan. */
const PAGES = [["Harbour Ledger", " Review"], ["Lot 55-0193-G", "\n\n18,442.07 florins"], ["Signatories"]];
const TRANSCRIBED =
  "### Page 1\nHarbour Ledger Review\n\n### Page 2\nLot 55-0193-G\n\n18,442.07 florins\n\n### Page 3\nSignatories";

function scanPage(seed: number, overrides: Partial<PdfImage> = {}): PdfImage {
  let data = Uint8Array.from({ length: 700 + seed }, (_, i) => (i * 7 + seed) % 256);
  return { data, width: 1275, height: 1650, ...overrides };
}

/** A three-page scan, each page one JPEG. */
const SCAN = imagePdf([scanPage(1), scanPage(2), scanPage(3)]);

/**
 * A binding that converts every PDF to `markdown` and answers the nth transcription with
 * `pages[n]`: the text's pieces, or a response to give instead.
 */
function ocrAi(pages: (string[] | Response)[] = PAGES, markdown = SCANNED_PDF) {
  let transcribed = 0;
  let { ai, sent } = fakeAi(request => {
    if (request.url.includes("markdown")) return streamedResponse(markdownJson(markdown), 64);
    let page = pages[transcribed++]!;
    return page instanceof Response ? page : eventResponse(tokenEvents(page));
  });
  let images = () => sent.filter(request => !request.url.includes("markdown"));
  return { ai, sent, images };
}

/** Why pages in an encoding that is not read, named `encoding`, are refused. */
function unread(encoding: string): string {
  return `its pages are stored in an image encoding that is not read yet, ${
    encoding}; only JPEG pages are, and deflated grey or RGB ones that a PNG can hold as they are stored`;
}

/** Why a PDF with a page-sized mask in an encoding that is not read, named `encoding`, is refused. */
function maskUnread(encoding: string): string {
  return "a mask the size of a page, which is where a layered scan keeps its text, is stored in an " +
    `image encoding that is not read yet, ${encoding}`;
}

/** A one-page scan whose page is `rows` of 8-bit grey samples as `data`, deflated or said to be. */
function greyScan(data: Uint8Array, width: number, height: number, extra?: string): BuiltPdf {
  return imagePdf([{ data, width, height, filter: "/FlateDecode", colorSpace: "/DeviceGray", ...(extra ? { extra } : {}) }]);
}

/** A pause long enough for anything begun ahead of what was asked for to show. */
function settled(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 20));
}

/** A range reader over `pdf` that notes each range asked of it. */
function ranges(pdf: BuiltPdf) {
  let asked: PdfPageRange[] = [];
  let readRange: PdfRangeReader = async range => {
    asked.push(range);
    return byteStream(pdf.bytes.slice(range.offset, range.offset + range.length), [100]).stream;
  };
  return { asked, readRange };
}

/**
 * Reads a text on until all that has been read of it, `text` included, ends with `end`, and
 * returns that. A text that ends first fails the test here: a read of an ended text answers at
 * once, so waiting for `end` alone would spin without ever letting the test time out.
 */
async function readThrough(
  reader: ReadableStreamDefaultReader<Uint8Array>, end: string, text = "",
): Promise<string> {
  let decoder = new TextDecoder();
  while (!text.endsWith(end)) {
    let piece = await reader.read();
    if (piece.done) throw new Error(`The text ended before ${JSON.stringify(end)}, as ${JSON.stringify(text)}.`);
    text += decoder.decode(piece.value, { stream: true });
  }
  return text;
}

/** Everything logged, as one string. */
function everythingLogged(): string {
  return JSON.stringify([console.info, console.warn].flatMap(log => vi.mocked(log).mock.calls));
}

describe("pdfToText transcribing a scanned PDF", () => {
  it("transcribes each page image, in the file's order, under page headings", async () => {
    let { ai, images } = ocrAi();
    let { asked, readRange } = ranges(SCAN);

    let result = await pdfToText(ai, "team-gateway", byteStream(SCAN.bytes, [333]).stream, readRange);
    expect(result).toMatchObject({ hasText: false, transcribed: true });
    // Nothing is read or transcribed until the text is.
    expect(asked).toEqual([]);
    expect(await read(result)).toBe(TRANSCRIBED);

    expect(asked).toEqual(SCAN.images.map((image, i) => ({
      page: i + 1, ...image, fileSize: SCAN.bytes.byteLength,
    })));
    expect(images().map(request => sentImage(request))).toEqual(SCAN.images.map(({ offset, length }) => ({
      mimeType: "image/jpeg", bytes: SCAN.bytes.slice(offset, offset + length),
    })));
    expect(images().every(request => request.url.includes("/ai-gateway/run"))).toBe(true);
  });

  it("logs counts, sizes and encodings, and never the transcription", async () => {
    let info = vi.mocked(console.info);
    let { ai } = ocrAi();
    await read(await pdfToText(ai, undefined, byteStream(SCAN.bytes).stream, ranges(SCAN).readRange));

    expect(info).toHaveBeenCalledWith(expect.objectContaining({
      event: "google.drive.pdf.transcribing", pdfBytes: SCAN.bytes.byteLength, ocrPages: 3,
    }));
    expect(info).toHaveBeenCalledWith(expect.objectContaining({
      event: "google.drive.pdf.page_transcribed", page: 2, imageBytes: 702, imageEncoding: "jpeg",
    }));
    for (let word of ["Harbour", "55-0193", "florins", "Signatories"]) expect(everythingLogged()).not.toContain(word);
  });

  it("sends a losslessly compressed page as a PNG", async () => {
    let rows = Uint8Array.from({ length: 300 * 200 }, (_, i) => i % 251);
    let pdf = imagePdf([{
      data: new Uint8Array(deflateSync(rows)), width: 300, height: 200,
      filter: "/FlateDecode", colorSpace: "/DeviceGray",
    }]);
    let { ai, images } = ocrAi([["grey page"]]);

    let result = await pdfToText(ai, undefined, byteStream(pdf.bytes).stream, ranges(pdf).readRange);
    expect(await read(result)).toBe("### Page 1\ngrey page");
    let { mimeType, bytes } = sentImage(images()[0]!);
    expect(mimeType).toBe("image/png");
    expect(String.fromCharCode(...bytes.subarray(1, 4))).toBe("PNG");
    expect(new DataView(bytes.buffer).getUint32(16)).toBe(300);
  });

  // Retried for Node's inflating on another thread; see the same case in pdf-png.test.ts.
  it("transcribes a deflated page whose length counts the line end after its data", { retry: 3 }, async () => {
    let rows = Uint8Array.from({ length: 300 * 200 }, (_, i) => (i * i) % 251);
    let data = new Uint8Array(deflateSync(rows));
    let pdf = imagePdf([{
      data, width: 300, height: 200, filter: "/FlateDecode", colorSpace: "/DeviceGray",
      declaredLength: data.byteLength + 1,
    }]);
    let { ai, images } = ocrAi([["grey page"]]);
    let { asked, readRange } = ranges(pdf);

    let result = await pdfToText(ai, undefined, byteStream(pdf.bytes).stream, readRange);
    expect(await read(result)).toBe("### Page 1\ngrey page");
    expect(asked).toMatchObject([{ length: data.byteLength + 1 }]);
    expect(sentImage(images()[0]!).mimeType).toBe("image/png");
    expect(vi.mocked(console.warn)).not.toHaveBeenCalled();
  });

  it.each([
    ["does not inflate", Uint8Array.from({ length: 400 }, (_, i) => i % 251)],
    ["is cut short", new Uint8Array(deflateSync(new Uint8Array(300 * 200))).slice(0, -6)],
    ["holds more rows than the page has", new Uint8Array(deflateSync(new Uint8Array(64 << 20)))],
  ])("fails a page whose deflated data %s in its own words, saying which", async (_label, data) => {
    let pdf = greyScan(data, 300, 200);
    let { ai, images } = ocrAi([["never read"]]);
    let result = await pdfToText(ai, undefined, byteStream(pdf.bytes).stream, ranges(pdf).readRange);
    expect(result.transcribed).toBe(true);
    await expect(read(result)).rejects.toThrow(TRANSCRIPTION_FAILED);
    // The request broke off with the image, so the model was given nothing to read.
    expect(images()).toEqual([]);
    expect(vi.mocked(console.warn).mock.calls).toEqual([[expect.objectContaining({
      event: "google.drive.pdf.transcription_failed", page: 1, imageEncoding: "lossless",
    })]]);
  });

  it("returns a PDF's own text without transcribing anything", async () => {
    let { ai, images } = ocrAi(PAGES, LARGE_PDF);
    let { asked, readRange } = ranges(SCAN);
    let result = await pdfToText(ai, undefined, byteStream(SCAN.bytes).stream, readRange);
    expect(result).toMatchObject({ hasText: true, transcribed: false });
    expect(await read(result)).toBe("### Page 1\nLarge file probe text\n\n");
    expect(asked).toEqual([]);
    expect(images()).toEqual([]);
  });

  it("transcribes nothing unless asked to", async () => {
    let { ai, images } = ocrAi();
    let result = await pdfToText(ai, undefined, byteStream(SCAN.bytes).stream);
    expect(result).toMatchObject({ hasText: false, transcribed: false });
    expect(await read(result)).toBe("");
    expect(images()).toEqual([]);
  });

  it("returns no text for a PDF with neither text nor page images", async () => {
    let { ai, images } = ocrAi();
    let pdf = imagePdf([scanPage(1, { width: 64, height: 64 })]);
    let result = await pdfToText(ai, undefined, byteStream(pdf.bytes).stream, ranges(pdf).readRange);
    expect(result).toMatchObject({ hasText: false, transcribed: false });
    expect(await read(result)).toBe("");
    expect(images()).toEqual([]);
  });

  it.each([
    ["an encrypted PDF", imagePdf([scanPage(1)], { trailer: "/Encrypt 9 0 R" }), "it is encrypted", undefined],
    ["fax-encoded pages", imagePdf([scanPage(1), scanPage(2, { filter: "/CCITTFaxDecode" })]),
      unread("fax (CCITT)"), "fax"],
    ["JBIG2 pages", imagePdf([scanPage(1, { filter: "/JBIG2Decode" })]), unread("JBIG2"), "jbig2"],
    ["JPEG 2000 pages", imagePdf([scanPage(1, { filter: "/JPXDecode" })]), unread("JPEG 2000"), "jpeg2000"],
    ["pages in an unknown encoding", imagePdf([scanPage(1, { filter: "/LZWDecode" })]),
      unread("one this cannot read"), "other"],
    // The parameters may name a predictor, which would change how the rows are to be read.
    ["deflated pages whose parameters are in an object of their own",
      imagePdf([scanPage(1, { filter: "/FlateDecode", extra: "/DecodeParms 30 0 R" })]),
      unread("one this cannot read"), "other"],
    ["a page image that is not where the file says", imagePdf([scanPage(1, { declaredLength: 50 })]),
      "a page image is not where the file says it is", "jpeg"],
    ["a page image too large to send", imagePdf([scanPage(1, { data: new Uint8Array(12 * 1024 * 1024 + 1) })]),
      "a page image is too large", "jpeg"],
    // 144 MB of rows, whatever its few bytes of data hold.
    ["a deflated page with more rows than are inflated", greyScan(new Uint8Array(40), 12_000, 12_000),
      "a page image is too large", "lossless"],
    // The second page's image is object 9: the mask that holds what the first's colour layer does not.
    ["a layered scan whose text is a JBIG2 mask", imagePdf([scanPage(1, { extra: "/SMask 9 0 R" }),
      scanPage(2, { filter: "/JBIG2Decode", colorSpace: "/DeviceGray", bitsPerComponent: 1 })]),
      maskUnread("JBIG2"), "jbig2"],
    ["a page stored as nothing but a fax stencil",
      imagePdf([scanPage(1, { filter: "/CCITTFaxDecode", bitsPerComponent: 1, extra: "/ImageMask true" })]),
      maskUnread("fax (CCITT)"), "fax"],
  ])("refuses %s before transcribing anything", async (_label, pdf, why, imageEncoding) => {
    let { ai, images } = ocrAi();
    let { asked, readRange } = ranges(pdf);
    await expect(pdfToText(ai, undefined, byteStream(pdf.bytes, [65_536]).stream, readRange))
      .rejects.toThrow(`The PDF has no text of its own, and ${why}, so it cannot be transcribed.`);
    expect(asked).toEqual([]);
    expect(images()).toEqual([]);
    expect(vi.mocked(console.info)).toHaveBeenCalledWith(expect.objectContaining({
      event: "google.drive.pdf.untranscribable", ...(imageEncoding ? { imageEncoding } : {}),
    }));
  });

  it("refuses a PDF with more page images than it keeps", async () => {
    let one = "<< /Subtype /Image /Width 600 /Height 800 /Filter /DCTDecode /Length 1 >>\nstream\nx\nendstream\nendobj\n";
    let text = "%PDF-1.4\n";
    for (let i = 1; i <= 2001; i++) text += `${i} 0 obj\n${one}`;
    let { ai, images } = ocrAi();
    await expect(pdfToText(ai, undefined, byteStream(new TextEncoder().encode(text)).stream, ranges(SCAN).readRange))
      .rejects.toThrow("it has more than 2000 page images");
    expect(images()).toEqual([]);
  });

  it("accepts a deflated page of many rows that are passed on as they are", async () => {
    let { ai, images } = ocrAi([["wide"]]);
    let pdf = greyScan(new Uint8Array(40), 12_000, 12_000, "/DecodeParms << /Predictor 15 /Columns 12000 >>");
    let result = await pdfToText(ai, undefined, byteStream(pdf.bytes).stream, ranges(pdf).readRange);
    expect(await read(result)).toBe("### Page 1\nwide");
    expect(images()).toHaveLength(1);
  });

  it("refuses when the conversion answered before the PDF had all been sent, and lets the PDF go", async () => {
    let ai = {
      fetch: async () => streamedResponse(markdownJson(SCANNED_PDF)),
    } as unknown as AiFetcher;
    let pdf = byteStream(SCAN.bytes, [100]);
    await expect(pdfToText(ai, undefined, pdf.stream, ranges(SCAN).readRange))
      .rejects.toThrow(CONVERSION_FAILED);
    expect(pdf.state.cancelled).toBe(true);
  });

  it("does not take a PDF cancelled partway for one read to its end", async () => {
    let cancelled = false;
    let sent = 0;
    // Gives the first of the PDF, with no page image in it yet, then nothing more.
    let pdf = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent === 0) controller.enqueue(SCAN.bytes.slice(0, sent = SCAN.images[0]!.offset - 200));
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    // Reads what there is of the upload, drops the rest as a runtime does once it has answered,
    // and says the PDF has no text.
    let ai = {
      fetch: async (_url: string, init: RequestInit) => {
        let body = (init.body as ReadableStream<Uint8Array>).getReader();
        await body.read();
        await body.read();
        void body.read();
        await settled();
        await body.cancel();
        return streamedResponse(markdownJson(SCANNED_PDF));
      },
    } as unknown as AiFetcher;
    await expect(pdfToText(ai, undefined, pdf, ranges(SCAN).readRange)).rejects.toThrow(CONVERSION_FAILED);
    expect(cancelled).toBe(true);
  });

  it("lets the PDF go when its conversion fails with part of it unsent", async () => {
    let ai = {
      fetch: async (_url: string, init: RequestInit) => {
        await (init.body as ReadableStream<Uint8Array>).getReader().read();
        return new Response("{}", { status: 400 });
      },
    } as unknown as AiFetcher;
    let pdf = byteStream(SCAN.bytes, [100]);
    await expect(pdfToText(ai, undefined, pdf.stream, ranges(SCAN).readRange)).rejects.toThrow(CONVERSION_FAILED);
    expect(pdf.state.cancelled).toBe(true);
  });

  it("reads a page from the file only once the text has been read up to it", async () => {
    let { ai, images } = ocrAi();
    let { asked, readRange } = ranges(SCAN);
    let result = await pdfToText(ai, undefined, byteStream(SCAN.bytes).stream, readRange);
    let reader = result.text.getReader();
    let text = "";
    let readUntil = async (end: string) => {
      text = await readThrough(reader, end, text);
    };

    await readUntil("### Page 1\n");
    expect(asked.map(range => range.page)).toEqual([1]);
    // All of the first page's text, and nothing of the second: it is not begun ahead.
    await readUntil("Harbour Ledger Review");
    await settled();
    expect(asked.map(range => range.page)).toEqual([1]);
    expect(images()).toHaveLength(1);
    await readUntil("### Page 2\n");
    await settled();
    expect(asked.map(range => range.page)).toEqual([1, 2]);

    await reader.cancel();
    await settled();
    expect(asked.map(range => range.page)).toEqual([1, 2]);
    expect(images()).toHaveLength(2);
  });

  it("asks nothing of the model when cancelled while a page is being read from the file", async () => {
    let { ai, images } = ocrAi();
    let image = byteStream(SCAN.bytes.slice(SCAN.images[0]!.offset, SCAN.images[0]!.offset + 700), [100]);
    let asked = 0;
    let opened!: () => void;
    let result = await pdfToText(ai, undefined, byteStream(SCAN.bytes).stream, async () => {
      asked++;
      await new Promise<void>(resolve => { opened = resolve; });
      return image.stream;
    });
    let reader = result.text.getReader();
    let first = reader.read();
    await vi.waitFor(() => expect(asked).toBe(1));

    let cancelling = reader.cancel();
    opened();
    await cancelling;
    expect(await first).toEqual({ done: true, value: undefined });
    await settled();
    expect(image.state.cancelled).toBe(true);
    expect(images()).toEqual([]);
    expect(asked).toBe(1);
  });

  it("lets go of an answer the model gives to a request already given up", async () => {
    let response = { cancelled: false };
    let answer!: (response: Response) => void;
    let ai = {
      fetch: async (url: string, init: RequestInit) => {
        if (url.includes("markdown")) {
          await new Response(init.body).arrayBuffer();
          return streamedResponse(markdownJson(SCANNED_PDF), 64);
        }
        return new Promise<Response>(resolve => { answer = resolve; });
      },
    } as unknown as AiFetcher;
    let { asked, readRange } = ranges(SCAN);
    let result = await pdfToText(ai, undefined, byteStream(SCAN.bytes).stream, readRange);
    let reader = result.text.getReader();
    let first = reader.read();
    await vi.waitFor(() => expect(answer).toBeDefined());

    await reader.cancel();
    answer(new Response(new ReadableStream<Uint8Array>({
      cancel() { response.cancelled = true; },
    })));
    expect(await first).toEqual({ done: true, value: undefined });
    await settled();
    expect(response.cancelled).toBe(true);
    expect(asked).toHaveLength(1);
  });

  it("begins no further page when cancelled as a page's answer ends", async () => {
    // The first page's answer, whole, in a response that takes a while to let go.
    let letGo!: () => void;
    let cancelling = false;
    let events = new TextEncoder().encode(tokenEvents(PAGES[0]!));
    let sent = false;
    let slow = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) controller.enqueue(events);
        sent = true;
      },
      cancel() {
        cancelling = true;
        return new Promise<void>(resolve => { letGo = resolve; });
      },
    }, { highWaterMark: 0 }));
    let { ai, images } = ocrAi([slow]);
    let { asked, readRange } = ranges(SCAN);
    let result = await pdfToText(ai, undefined, byteStream(SCAN.bytes).stream, readRange);
    let reader = result.text.getReader();
    await readThrough(reader, "Harbour Ledger Review");

    let next = reader.read();
    await vi.waitFor(() => expect(cancelling).toBe(true));
    let cancelled = reader.cancel();
    letGo();
    await cancelled;
    expect(await next).toEqual({ done: true, value: undefined });
    await settled();
    expect(asked.map(range => range.page)).toEqual([1]);
    expect(images()).toHaveLength(1);
  });

  it("stops the page in progress when cancelled", async () => {
    let response = { cancelled: false };
    let endless = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode(tokenEvents(["more "]).split("data: [DONE]")[0]));
      },
      cancel() { response.cancelled = true; },
    }, { highWaterMark: 0 }));
    let { ai } = ocrAi([endless]);
    let { asked, readRange } = ranges(SCAN);
    let result = await pdfToText(ai, undefined, byteStream(SCAN.bytes).stream, readRange);
    let reader = result.text.getReader();
    await reader.read();
    await reader.read();
    await reader.cancel();
    expect(response.cancelled).toBe(true);
    expect(asked).toHaveLength(1);
  });

  const IDLE = "The PDF's transcription went unread, or the model stopped answering, for a minute; read the PDF again.";

  it("ends a page the model stops answering partway, after a minute, and says only which", async () => {
    vi.useFakeTimers();
    let response = { cancelled: false, pulls: 0 };
    // One piece of the answer, then nothing more.
    let stalled = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (response.pulls++ === 0) {
          controller.enqueue(new TextEncoder().encode(tokenEvents(["Harbour "]).split("data: [DONE]")[0]));
        }
      },
      cancel() { response.cancelled = true; },
    }, { highWaterMark: 0 }));
    let { ai, images } = ocrAi([stalled]);
    let { asked, readRange } = ranges(SCAN);
    let result = await pdfToText(ai, undefined, byteStream(SCAN.bytes).stream, readRange);
    let reader = result.text.getReader();
    await reader.read();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("Harbour ");

    let outcome: unknown = "waiting";
    reader.read().then(() => { outcome = "read"; }, (error: unknown) => { outcome = error; });
    await vi.advanceTimersByTimeAsync(TRANSCRIPTION_IDLE_MS - 1);
    expect(outcome).toBe("waiting");
    expect(response.cancelled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toEqual(new Error(IDLE));
    expect(response.cancelled).toBe(true);
    expect(asked).toHaveLength(1);
    expect(images()).toHaveLength(1);
    expect(vi.mocked(console.warn).mock.calls).toEqual([[expect.objectContaining({
      event: "google.drive.pdf.transcription_idle", page: 1, imageEncoding: "jpeg",
    })]]);
    expect(everythingLogged()).not.toContain("Harbour");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives up a request the model never answers, and its image, after a minute", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    let ai = {
      fetch: async (url: string, init: RequestInit) => {
        if (url.includes("markdown")) {
          await new Response(init.body).arrayBuffer();
          return streamedResponse(markdownJson(SCANNED_PDF), 64);
        }
        signal = init.signal!;
        return new Promise<Response>((_, reject) => {
          signal!.addEventListener("abort", () => reject(signal!.reason));
        });
      },
    } as unknown as AiFetcher;
    let image = byteStream(SCAN.bytes.slice(SCAN.images[0]!.offset, SCAN.images[0]!.offset + 700), [100]);
    let result = await pdfToText(ai, undefined, byteStream(SCAN.bytes).stream, async () => image.stream);
    let read = result.text.getReader().read();
    let outcome: unknown = "waiting";
    read.then(() => { outcome = "read"; }, (error: unknown) => { outcome = error; });

    await vi.advanceTimersByTimeAsync(TRANSCRIPTION_IDLE_MS - 1);
    expect(signal!.aborted).toBe(false);
    expect(outcome).toBe("waiting");
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toEqual(new Error(IDLE));
    expect(signal!.aborted).toBe(true);
    expect(image.state.cancelled).toBe(true);
    // Only the idling is logged, not the request it ended as a failure of its own.
    expect(vi.mocked(console.warn).mock.calls.map(([logged]) => (logged as { event: string }).event))
      .toEqual(["google.drive.pdf.transcription_idle"]);
  });

  it("ends a transcription nobody reads after a minute, having read no page", async () => {
    vi.useFakeTimers();
    let { ai, images } = ocrAi();
    let { asked, readRange } = ranges(SCAN);
    let result = await pdfToText(ai, undefined, byteStream(SCAN.bytes).stream, readRange);
    await vi.advanceTimersByTimeAsync(TRANSCRIPTION_IDLE_MS);
    await expect(result.text.getReader().read()).rejects.toThrow(IDLE);
    expect(asked).toEqual([]);
    expect(images()).toEqual([]);
  });

  it("ends a transcription left unread after its last page was cut off", async () => {
    vi.useFakeTimers();
    let scan = imagePdf([scanPage(1)]);
    let { ai } = ocrAi([eventResponse(tokenEvents(["cut"], "length"))]);
    let result = await pdfToText(ai, undefined, byteStream(scan.bytes).stream, ranges(scan).readRange);
    let reader = result.text.getReader();
    await readThrough(reader, "cut off.]");

    await vi.advanceTimersByTimeAsync(TRANSCRIPTION_IDLE_MS);
    await expect(reader.read()).rejects.toThrow(IDLE);
    expect(vi.getTimerCount()).toBe(0);
    // No page was in progress, so none is named.
    expect(vi.mocked(console.warn).mock.calls).toEqual([[expect.not.objectContaining({ page: expect.anything() })]]);
    expect(vi.mocked(console.warn).mock.calls[0]![0]).toMatchObject({ event: "google.drive.pdf.transcription_idle" });
  });

  it("keeps a transcription that is read slower than a minute a page, but never idle for one", async () => {
    vi.useFakeTimers();
    let { ai } = ocrAi();
    let result = await pdfToText(ai, undefined, byteStream(SCAN.bytes).stream, ranges(SCAN).readRange);
    let reader = result.text.getReader();
    let decoder = new TextDecoder();
    let text = "";
    for (;;) {
      await vi.advanceTimersByTimeAsync(TRANSCRIPTION_IDLE_MS - 1);
      let piece = await reader.read();
      if (piece.done) break;
      text += decoder.decode(piece.value, { stream: true });
    }
    expect(text).toBe(TRANSCRIBED);
    // Read to its end, it leaves no timer behind.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves no timer behind when cancelled or failed", async () => {
    vi.useFakeTimers();
    let cancelled = await pdfToText(ocrAi().ai, undefined, byteStream(SCAN.bytes).stream, ranges(SCAN).readRange);
    expect(vi.getTimerCount()).toBe(1);
    await cancelled.text.cancel();
    expect(vi.getTimerCount()).toBe(0);

    let refused = new Response("{}", { status: 500 });
    let failed = await pdfToText(ocrAi([refused]).ai, undefined, byteStream(SCAN.bytes).stream, ranges(SCAN).readRange);
    await expect(new Response(failed.text).text()).rejects.toThrow("could not be transcribed");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives up a page's request, and its image, when cancelled before the model answers", async () => {
    let signal: AbortSignal | undefined;
    let ai = {
      fetch: async (url: string, init: RequestInit) => {
        if (url.includes("markdown")) {
          await new Response(init.body).arrayBuffer();
          return streamedResponse(markdownJson(SCANNED_PDF), 64);
        }
        // The model never answers; the request ends only by being given up.
        signal = init.signal!;
        return new Promise<Response>((_, reject) => {
          signal!.addEventListener("abort", () => reject(signal!.reason));
        });
      },
    } as unknown as AiFetcher;
    let image = byteStream(SCAN.bytes.slice(SCAN.images[0]!.offset, SCAN.images[0]!.offset + 700), [100]);
    let asked: PdfPageRange[] = [];
    let readRange: PdfRangeReader = async range => {
      asked.push(range);
      return image.stream;
    };
    let result = await pdfToText(ai, undefined, byteStream(SCAN.bytes).stream, readRange);
    let reader = result.text.getReader();
    let read = reader.read();
    await vi.waitFor(() => expect(signal).toBeDefined());
    expect(signal!.aborted).toBe(false);

    await reader.cancel();
    expect(signal!.aborted).toBe(true);
    expect(image.state.cancelled).toBe(true);
    expect(await read).toEqual({ done: true, value: undefined });
    expect(asked).toHaveLength(1);
    expect(vi.mocked(console.warn)).not.toHaveBeenCalled();
  });

  it("errors the text in its own words when a page cannot be transcribed", async () => {
    let warn = vi.mocked(console.warn);
    let refused = new Response(JSON.stringify({ internalCode: 8006, message: "secret upstream text" }), { status: 400 });
    let { ai } = ocrAi([PAGES[0]!, refused]);
    let result = await pdfToText(ai, undefined, byteStream(SCAN.bytes).stream, ranges(SCAN).readRange);

    let reader = result.text.getReader();
    let text = "";
    let error = await (async () => {
      for (;;) {
        let chunk = await reader.read();
        if (chunk.done) return undefined;
        text += new TextDecoder().decode(chunk.value);
      }
    })().catch((caught: unknown) => caught);
    expect(text).toBe("### Page 1\nHarbour Ledger Review");
    expect((error as Error).message).toBe(TRANSCRIPTION_FAILED);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      event: "google.drive.pdf.transcription_failed", page: 2, imageBytes: 702, imageEncoding: "jpeg",
      httpStatus: 400, providerCode: 8006,
    }));
    expect(everythingLogged()).not.toContain("secret");
  });

  it("errors the text when the model's answer breaks off, without logging what it said", async () => {
    let brokeOff = eventResponse(tokenEvents(["Lot 55-0193-G"]).split("data: [DONE]")[0]!);
    let { ai } = ocrAi([PAGES[0]!, brokeOff]);
    let result = await pdfToText(ai, undefined, byteStream(SCAN.bytes).stream, ranges(SCAN).readRange);
    await expect(read(result)).rejects.toThrow(TRANSCRIPTION_FAILED);
    expect(vi.mocked(console.warn)).toHaveBeenCalledWith(expect.objectContaining({
      event: "google.drive.pdf.transcription_failed", page: 2,
    }));
    expect(everythingLogged()).not.toContain("55-0193");
  });

  it("passes on a page read's own failure, such as a refused or changed file, as it is", async () => {
    let { ai, images } = ocrAi();
    let changed = new Error("The Drive file changed while it was being read; read it again.");
    let { readRange } = ranges(SCAN);
    let result = await pdfToText(ai, undefined, byteStream(SCAN.bytes).stream,
      range => range.page === 2 ? Promise.reject(changed) : readRange(range));
    await expect(read(result)).rejects.toBe(changed);
    expect(images()).toHaveLength(1);
    expect(vi.mocked(console.warn)).not.toHaveBeenCalled();
  });

  it("marks a page whose transcription the model was stopped partway through", async () => {
    let { ai } = ocrAi([eventResponse(tokenEvents(["row | row"], "length")), ["next"]]);
    let pdf = imagePdf([scanPage(1), scanPage(2)]);
    let result = await pdfToText(ai, undefined, byteStream(pdf.bytes).stream, ranges(pdf).readRange);
    expect(await read(result)).toBe(
      "### Page 1\nrow | row\n\n[The transcription of this page was cut off.]\n\n### Page 2\nnext");
  });
});
