import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deflateSync, inflateSync } from "node:zlib";
import {
  RENDER_LIMITS, type PdfDocument, type PdfRendering, type RenderedPage, type RenderOptions,
  type RenderRefusalReason, type RenderRefused,
} from "@gadgets/pdf-renderer/api";
import {
  GMAIL_PDF, pdfConverter, pdfToText, releasedAtEnd, TRANSCRIPTION_IDLE_MS, type PdfPageRange,
  type PdfRangeReader,
} from "../src/drive-pdf";
import { REFUSED_PAUSE } from "../src/pdf-bands";
import { forwardRangeReader, type PdfOpener } from "../src/pdf-forward-reader";
import { READ_AHEAD } from "../src/pdf-read-ahead";
import type { AiFetcher } from "../src/workers-ai-markdown";
import { imagePdf, scanPage, type BuiltPdf } from "./pdf-fixture";
import {
  BYTES, byteStream, conversionJson, eventResponse, fakeAi, formatLastJson, markdownJson,
  sentImage, splitResponse, streamedResponse, tokenEvents, type VisionJson,
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
  // The pause before a refused call is made again is off.
  Object.assign(REFUSED_PAUSE, { ms: [0, 0, 0, 0, 0], jitter: 0 });
  // A text's calls are held to four at once, the number these tests were written to.
  READ_AHEAD.calls = 4;
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

  it("transcribes nothing when given nothing to read the file again with", async () => {
    let { ai, images } = ocrAi();
    let result = await pdfToText(ai, undefined, byteStream(SCAN.bytes).stream);
    expect(result).toMatchObject({ hasText: false, transcribed: false });
    expect(await read(result)).toBe("");
    expect(images()).toEqual([]);
  });

  it("returns no text for a PDF with neither text nor an image of any kind", async () => {
    let { ai, images } = ocrAi();
    let pdf = imagePdf([]);
    let result = await pdfToText(ai, undefined, byteStream(pdf.bytes).stream, ranges(pdf).readRange);
    expect(result).toEqual({ text: expect.any(ReadableStream), hasText: false, transcribed: false, rereads: false });
    expect(await read(result)).toBe("");
    expect(images()).toEqual([]);
  });

  it.each([
    ["an image too small to be a page", imagePdf([scanPage(1, { width: 64, height: 64 })])],
    ["a mask as large as a page",
      imagePdf([scanPage(1, { filter: "/FlateDecode", bitsPerComponent: 1, extra: "/ImageMask true" })])],
  ])("refuses a PDF whose only image is %s, since its pages would have to be rendered", async (_label, pdf) => {
    let { ai, images } = ocrAi();
    let { asked, readRange } = ranges(pdf);
    await expect(pdfToText(ai, undefined, byteStream(pdf.bytes).stream, readRange)).rejects.toThrow(
      "The PDF has no text of its own, and its pages have to be rendered to be read, which is not " +
      "available on this deployment, so it cannot be transcribed.");
    expect(asked).toEqual([]);
    expect(images()).toEqual([]);
    expect(vi.mocked(console.info)).toHaveBeenCalledWith(expect.objectContaining({
      event: "google.drive.pdf.untranscribable", pdfBytes: pdf.bytes.byteLength, ocrPages: 0,
    }));
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

  it("refuses a PDF in which an update replaced an image that had a mask: what it named may be a page now", async () => {
    let image = (id: number, extra: string) =>
      `${id} 0 obj\n<< /Subtype /Image /Width 600 /Height 800 /Filter /DCTDecode ${extra}/Length 1 >>\nstream\nx\nendstream\nendobj\n`;
    let end = "xref\n0 1\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n";
    // Image 5 names image 9 as its mask, and is then written again without one.
    let text = `%PDF-1.4\n${image(5, "/SMask 9 0 R ")}${image(9, "")}${end}${image(5, "")}${end}`;
    let { ai, images } = ocrAi();
    await expect(pdfToText(ai, undefined, byteStream(new TextEncoder().encode(text)).stream, ranges(SCAN).readRange))
      .rejects.toThrow("an update to the file replaced an image that had a mask, so which of its images are pages cannot be told");
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

  it("asks nothing of the model for a page whose image arrived just as the text was cancelled", async () => {
    let { ai, images } = ocrAi();
    let range = deferred<ReadableStream<Uint8Array>>();
    let { offset, length } = SCAN.images[0]!;
    let image = byteStream(SCAN.bytes.slice(offset, offset + length));
    let result = await pdfToText(ai, undefined, byteStream(SCAN.bytes).stream, () => range.promise);
    let reader = result.text.getReader();
    let read = reader.read();
    await settled();
    // The image arrives, and the text is cancelled before the read that waited for it goes on.
    range.resolve(image.stream);
    await Promise.resolve();
    await reader.cancel();
    await read.catch(() => undefined);
    await settled();
    expect(images()).toEqual([]);
    expect(image.state.cancelled).toBe(true);
  });

  it("is not taken for idle while a page's stored image keeps arriving, however long all of it takes", async () => {
    vi.useFakeTimers();
    let { ai, images } = ocrAi();
    // Each page's image arrives in four pieces twenty seconds apart: longer in all than a text
    // may sit idle, with nothing of the text moving until the model has the whole image.
    let readRange: PdfRangeReader = async ({ offset, length }) => {
      let quarter = Math.ceil(length / 4);
      let sent = 0;
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (sent === 4) return controller.close();
          await new Promise(resolve => setTimeout(resolve, 20_000));
          controller.enqueue(SCAN.bytes.slice(offset + sent * quarter, Math.min(offset + ++sent * quarter, offset + length)));
        },
      }, { highWaterMark: 0 });
    };
    let result = await pdfToText(ai, undefined, byteStream(SCAN.bytes).stream, readRange);

    let began = Date.now();
    expect(await pumped(read(result), PACE)).toBe(TRANSCRIBED);
    expect(Date.now() - began).toBeGreaterThanOrEqual(3 * 80_000);
    expect(images().map(request => sentImage(request).bytes)).toEqual(
      SCAN.images.map(({ offset, length }) => SCAN.bytes.slice(offset, offset + length)));
    expect(vi.mocked(console.warn)).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

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

const IDLE = "The PDF's transcription went unread, or the model stopped answering, for a minute; read the PDF again.";
const BLANK_PAGE = "[This page came out blank: it has nothing on it, or its image could not be read.]";
const UNDRAWN_PAGE = "[This page could not be drawn within the memory and work a page is allowed, so it was not read.]";
const REDUCED_PAGE = "\n\n[This page was read from a drawing at half the usual resolution, which is what its size " +
  "allowed, so its text may be less exact.]";
const CUT_OFF = "\n\n[The transcription of this page was cut off.]";
const RENDERER_BUSY = "The PDF's pages cannot be rendered to be read just now; read the PDF again in a minute.";
const FILE_CHANGED = "The Drive file changed while it was being read; read it again.";
const ENCRYPTED = "The PDF has no text of its own, and it is encrypted, so it cannot be transcribed.";
/** What a call to a renderer that has gone away throws. */
const LOST = new Error("Network connection lost.");

/** A three-page scan stored as fax, which is not read as stored: its pages have to be rendered. */
const FAX_SCAN = imagePdf([1, 2, 3].map(seed => scanPage(seed, { filter: "/CCITTFaxDecode" })));

/** The range a PDF is read by to be rendered: all of it, as no page's image. */
function whole(pdf: BuiltPdf): PdfPageRange {
  return { offset: 0, length: pdf.bytes.byteLength, fileSize: pdf.bytes.byteLength };
}

/** A refusal as the renderer answers one, of the whole PDF unless `ofPage`. */
function refusedAs(reason: RenderRefusalReason, ofPage = false): RenderRefused {
  return { refused: reason, ofPage, heapBytes: 18_939_904, work: 1000 };
}

const BAND_WIDTH = 20;
const BAND_ROWS = 5;

/**
 * A page as a fake renderer answers with it: a band for each of `shades`, every pixel of it that
 * grey, and a band without pixels for `null`. The fake model reads a band by its grey, so each
 * band of a test has its own.
 */
function drawn(shades: (number | null)[], overrides: Partial<RenderedPage> = {}): RenderedPage {
  return {
    width: BAND_WIDTH, height: shades.length * BAND_ROWS,
    bands: shades.map((shade, i) => ({
      top: i * BAND_ROWS, rows: BAND_ROWS, ink: shade === null ? 0 : 100,
      ...(shade === null ? {} : { pixels: new Uint8Array(BAND_WIDTH * BAND_ROWS).fill(shade) }),
    })),
    blank: shades.every(shade => shade === null), images: 1, surveyed: true, dpi: 150, reduced: false,
    cost: { heapBytes: 18_939_904, objects: 1, imagePixels: 400, steps: 1, strips: 1, work: 1000 },
    ...overrides,
  };
}

/** What a fake document answers for a page: a page or a refusal, at once or when it likes, or a throw. */
type PageAnswer = RenderedPage | RenderRefused | Error | (() => Promise<RenderedPage | RenderRefused>);
type Opened = Awaited<ReturnType<PdfRendering["open"]>>;
/**
 * What a fake renderer does with an `open`: refuses with a word, throws, or whatever a test's own
 * function does with the stream, which is handed `document` to answer with one. `undefined`
 * opens the PDF.
 */
type Opening = RenderRefusalReason | Error
  | ((pdf: ReadableStream<Uint8Array>, document: () => Opened) => Promise<Opened>) | undefined;

/**
 * A renderer in this process. The nth `open` does what `openings[n]` says, and a document
 * answers page `i` with `pages[i]`, or with what `pages` gives for the nth document. `state` is
 * what was asked of it: the bytes and size each `open` got, the pages asked of each document and
 * how often it was disposed, and the order of it all.
 */
function fakeRenderer(pages: PageAnswer[] | ((nth: number) => PageAnswer[]), openings: Opening[] = []) {
  let state = {
    opens: [] as { bytes: Uint8Array; size: number }[],
    documents: [] as { asked: { index: number; options: RenderOptions }[]; disposed: number }[],
    events: [] as string[],
  };
  let document = (): Opened => {
    let own = typeof pages === "function" ? pages(state.documents.length) : pages;
    let held: (typeof state.documents)[number] = { asked: [], disposed: 0 };
    state.documents.push(held);
    let opened: PdfDocument = {
      async renderPage(index, options) {
        held.asked.push({ index, options });
        state.events.push(`render ${index + 1}`);
        let answer = own[index]!;
        if (answer instanceof Error) throw answer;
        return typeof answer === "function" ? answer() : answer;
      },
      [Symbol.dispose]() {
        held.disposed++;
        state.events.push("disposed");
      },
    };
    return { document: opened, pages: own.length };
  };
  let renderer: PdfRendering = {
    async open(pdf, size) {
      let opening = openings[state.opens.length];
      let opened = { bytes: new Uint8Array(0), size };
      state.opens.push(opened);
      state.events.push("open");
      if (typeof opening === "function") return opening(pdf, document);
      // A call that fails never reaches the stream, and room is refused before a byte is read.
      if (opening instanceof Error) throw opening;
      if (opening === "room" || opening === "file-size") return refusedAs(opening);
      opened.bytes = new Uint8Array(await new Response(pdf).arrayBuffer());
      if (opened.bytes.byteLength !== size) return refusedAs("size-mismatch");
      return opening ? refusedAs(opening) : document();
    },
  };
  return { renderer, state };
}

/** The size, layout and rows of samples of a PNG, read back: its image data inflated and its filter bytes taken off. */
function pngRows(png: Uint8Array): { width: number; height: number; grey8: boolean; rows: Uint8Array } {
  let view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let width = view.getUint32(16), height = view.getUint32(20);
  let data: Uint8Array[] = [];
  for (let at = 8; at < png.byteLength; at += 12 + view.getUint32(at)) {
    let type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    if (type === "IDAT") data.push(png.subarray(at + 8, at + 8 + view.getUint32(at)));
  }
  let filtered = new Uint8Array(inflateSync(Buffer.concat(data)));
  expect(filtered.byteLength).toBe(height * (width + 1));
  let rows = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    expect(filtered[y * (width + 1)]).toBe(0);
    rows.set(filtered.subarray(y * (width + 1) + 1, (y + 1) * (width + 1)), y * width);
  }
  return { width, height, grey8: png[24] === 8 && png[25] === 0, rows };
}

/** One band as the fake model was sent it. */
type SentBand = {
  /** The grey of its first pixel, which says which band it is. */
  shade: number;
  width: number;
  height: number;
  grey8: boolean;
  rows: Uint8Array;
  prompt: string;
  url: string;
  signal: AbortSignal;
};

/**
 * A binding that converts every PDF to `markdown`, which has no text unless given, or answers
 * its conversion with a response given instead. It answers a band with what `answer` gives for
 * it (text in pieces, or a response, now or later), and answers the nth image that is no PNG
 * with `PAGES[n]`, as {@link ocrAi} does. `bands` are the bands sent, in the order their
 * requests were read, which is not the page's order when several are in flight.
 */
function bandAi(
  answer: (band: SentBand) => string[] | Response | Promise<Response> = ({ shade }) => [`band ${shade}`],
  markdown: string | Response = SCANNED_PDF,
) {
  let bands: SentBand[] = [];
  let stored = 0;
  let { ai, sent } = fakeAi(request => {
    if (request.url.includes("markdown")) {
      return typeof markdown === "string" ? streamedResponse(markdownJson(markdown), 64) : markdown;
    }
    let { mimeType, bytes } = sentImage(request);
    if (mimeType !== "image/png") return eventResponse(tokenEvents(PAGES[stored++]!));
    let { inputs } = request.json as unknown as VisionJson;
    let band = {
      ...pngRows(bytes), shade: pngRows(bytes).rows[0]!, url: request.url, signal: request.init.signal!,
      prompt: inputs.messages[0]!.content.find(part => part.type === "text")!.text!,
    };
    bands.push(band);
    let given = answer(band);
    // The fake binding awaits what it is given, so an answer may come later.
    return (Array.isArray(given) ? eventResponse(tokenEvents(given)) : given) as Response;
  });
  /** The images sent as they are stored. */
  let images = () => sent.filter(request => !request.url.includes("markdown"))
    .map(sentImage).filter(({ mimeType }) => mimeType !== "image/png");
  return { ai, bands, images };
}

/** `pdf` converted with `renderer` there to render it, and what was read of the file after. */
async function rendering(pdf: BuiltPdf, renderer: PdfRendering, ai = bandAi().ai) {
  let { asked, readRange } = ranges(pdf);
  let result = await pdfToText(ai, undefined, byteStream(pdf.bytes, [65_536]).stream, readRange, renderer);
  return { result, asked };
}

/** Reads a text to its end or its failure: what was read of it, and what it failed with. */
async function readToFailure(result: { text: ReadableStream<Uint8Array> }): Promise<{ text: string; error: unknown }> {
  let reader = result.text.getReader();
  let decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      let piece = await reader.read();
      if (piece.done) return { text, error: undefined };
      text += decoder.decode(piece.value, { stream: true });
    }
  } catch (error) {
    return { text, error };
  }
}

/** The lines logged at `level` with `event`. */
function linesOf(level: "info" | "warn", event: string): Record<string, unknown>[] {
  return vi.mocked(console[level]).mock.calls.map(([line]) => line as Record<string, unknown>)
    .filter(line => line.event === event);
}

/** A promise, and what settles it. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
}

/** The real clock's `setTimeout`, taken before any test fakes the timers. */
const realSetTimeout = setTimeout;

/**
 * How far the faked clock is moved at a time under a text that takes minutes of it, and how long
 * is then waited by the real clock. What is not a timer, a stream's read or a deflate done on
 * another thread, takes real time, however much the machine needs: a faked clock that is moved
 * without waiting for it runs minutes ahead of it, and the text is taken for idle.
 */
const PACE = { step: 250, realMs: 2 };

/**
 * Waits for `promise` under fake timers, `step` milliseconds at a time, so that the timers a PNG
 * is made by fire meanwhile, waiting `realMs` by the real clock after each when that is given.
 */
async function pumped<T>(promise: Promise<T>, { step = 1, realMs = 0 } = {}): Promise<T> {
  let state = { over: false };
  let end = () => { state.over = true; };
  promise.then(end, end);
  while (!state.over) {
    await vi.advanceTimersByTimeAsync(step);
    if (realMs > 0) await new Promise(resolve => realSetTimeout(resolve, realMs));
  }
  return promise;
}

describe("pdfToText routing a PDF without text", () => {
  it("renders it when given a renderer, reading the file whole once the text is read", async () => {
    let { renderer, state } = fakeRenderer([drawn([11, 12]), drawn([21])]);
    let { ai, bands, images } = bandAi();
    let { asked, readRange } = ranges(SCAN);

    let result = await pdfToText(ai, "team-gateway", byteStream(SCAN.bytes, [333]).stream, readRange, renderer);
    expect(result).toEqual({ text: expect.any(ReadableStream), hasText: false, transcribed: true, rereads: true });
    // Nothing is read, opened or sent until the text is read.
    await settled();
    expect(asked).toEqual([]);
    expect(state.events).toEqual([]);
    expect(await read(result)).toBe("### Page 1\nband 11\nband 12\n\n### Page 2\nband 21");

    expect(asked).toEqual([whole(SCAN)]);
    expect(state.opens).toEqual([{ bytes: SCAN.bytes, size: SCAN.bytes.byteLength }]);
    expect(state.documents[0]!.asked).toStrictEqual([
      { index: 0, options: { bands: 4, denseLines: 14 } }, { index: 1, options: { bands: 4, denseLines: 14 } },
    ]);
    // Each band is a grey PNG of its own rows, asked for as a band, and no page image is sent.
    expect(bands.map(({ shade }) => shade).toSorted()).toEqual([11, 12, 21]);
    for (let band of bands) {
      expect(band).toMatchObject({ width: BAND_WIDTH, height: BAND_ROWS, grey8: true });
      expect(band.rows).toEqual(new Uint8Array(BAND_WIDTH * BAND_ROWS).fill(band.shade));
      expect(band.prompt).toContain("Never write an image or a link");
      expect(band.url).toContain("/ai-gateway/run");
    }
    expect(images()).toEqual([]);
    expect(linesOf("info", "google.drive.pdf.transcribing")).toEqual([expect.objectContaining({
      pdfBytes: SCAN.bytes.byteLength, route: "rendered",
    })]);
    expect(linesOf("info", "google.drive.pdf.transcribing")[0]).not.toHaveProperty("ocrPages");
    expect(linesOf("info", "google.drive.pdf.rendering")).toEqual([expect.objectContaining({
      pdfBytes: SCAN.bytes.byteLength, ocrPages: 2,
    })]);
  });

  it("takes an image too small to be a page, or a mask as large as one, for something to render", async () => {
    for (let pdf of [
      imagePdf([scanPage(1, { width: 64, height: 64 })]),
      imagePdf([scanPage(1, { filter: "/FlateDecode", bitsPerComponent: 1, extra: "/ImageMask true" })]),
    ]) {
      let { renderer, state } = fakeRenderer([drawn([11])]);
      let { result } = await rendering(pdf, renderer);
      expect(result).toMatchObject({ hasText: false, transcribed: true, rereads: true });
      expect(await read(result)).toBe("### Page 1\nband 11");
      expect(state.opens).toEqual([{ bytes: pdf.bytes, size: pdf.bytes.byteLength }]);
    }
  });

  it("sends the page images as stored, without the renderer, when the file is larger than is rendered", async () => {
    let { renderer, state } = fakeRenderer([drawn([11])]);
    let { ai, images } = bandAi();
    let limit = RENDER_LIMITS.fileBytes;
    RENDER_LIMITS.fileBytes = SCAN.bytes.byteLength - 1;
    try {
      let { asked, readRange } = ranges(SCAN);
      let result = await pdfToText(ai, undefined, byteStream(SCAN.bytes).stream, readRange, renderer);
      expect(result).toMatchObject({ hasText: false, transcribed: true, rereads: true });
      expect(await read(result)).toBe(TRANSCRIBED);
      expect(asked.map(({ page }) => page)).toEqual([1, 2, 3]);
    } finally {
      RENDER_LIMITS.fileBytes = limit;
    }
    expect(state.events).toEqual([]);
    expect(images()).toHaveLength(3);
    expect(linesOf("info", "google.drive.pdf.transcribing")).toEqual([expect.objectContaining({
      pdfBytes: SCAN.bytes.byteLength, ocrPages: 3, route: "stored",
    })]);
  });

  it("renders a PDF of exactly the largest size that is rendered", async () => {
    let { renderer, state } = fakeRenderer([drawn([11])]);
    let limit = RENDER_LIMITS.fileBytes;
    RENDER_LIMITS.fileBytes = SCAN.bytes.byteLength;
    try {
      let { result } = await rendering(SCAN, renderer);
      expect(await read(result)).toBe("### Page 1\nband 11");
    } finally {
      RENDER_LIMITS.fileBytes = limit;
    }
    expect(state.opens).toHaveLength(1);
  });

  it("refuses a PDF with no page image that is larger than is rendered, saying how large one may be", async () => {
    let { renderer, state } = fakeRenderer([drawn([11])]);
    let pdf = imagePdf([scanPage(1, { data: new Uint8Array(RENDER_LIMITS.fileBytes), width: 64, height: 64 })]);
    let { ai } = bandAi();
    let { asked, readRange } = ranges(pdf);
    await expect(pdfToText(ai, undefined, byteStream(pdf.bytes, [1 << 20]).stream, readRange, renderer))
      .rejects.toThrow("The PDF has no text of its own, and its pages have to be rendered to be read, which is " +
        "done only for a PDF of up to 16 MiB, so it cannot be transcribed.");
    expect(asked).toEqual([]);
    expect(state.events).toEqual([]);
  });

  it("refuses a PDF that is larger than is rendered and not read as stored, in the words of that", async () => {
    let { renderer, state } = fakeRenderer([drawn([11])]);
    let limit = RENDER_LIMITS.fileBytes;
    RENDER_LIMITS.fileBytes = FAX_SCAN.bytes.byteLength - 1;
    try {
      await expect(rendering(FAX_SCAN, renderer)).rejects.toThrow(
        `The PDF has no text of its own, and ${unread("fax (CCITT)")}, so it cannot be transcribed.`);
    } finally {
      RENDER_LIMITS.fileBytes = limit;
    }
    expect(state.events).toEqual([]);
  });

  it("refuses an encrypted PDF as it does without a renderer, opening nothing", async () => {
    let { renderer, state } = fakeRenderer([drawn([11])]);
    let pdf = imagePdf([scanPage(1)], { trailer: "/Encrypt 9 0 R" });
    await expect(rendering(pdf, renderer)).rejects.toThrow(ENCRYPTED);
    expect(state.events).toEqual([]);
    expect(linesOf("info", "google.drive.pdf.untranscribable")).toHaveLength(1);
  });

  it("renders a PDF in which the scan found no image of any kind: a page may show what no image object holds", async () => {
    // An image written into a page's content, and writing drawn as shapes, are no objects of
    // the file for the scan to count, and are on the page as the renderer draws it.
    let { renderer, state } = fakeRenderer([drawn([11])]);
    let { result } = await rendering(imagePdf([]), renderer);
    expect(result).toMatchObject({ hasText: false, transcribed: true, rereads: true });
    expect(await read(result)).toBe("### Page 1\nband 11");
    expect(state.events).toEqual(["open", "render 1", "disposed"]);
  });

  it("has nothing to transcribe in such a PDF that is over the size that is rendered", async () => {
    let { renderer, state } = fakeRenderer([drawn([11])]);
    let pdf = imagePdf([]);
    let limit = RENDER_LIMITS.fileBytes;
    RENDER_LIMITS.fileBytes = pdf.bytes.byteLength - 1;
    try {
      let { result } = await rendering(pdf, renderer);
      expect(result).toMatchObject({ hasText: false, transcribed: false, rereads: false });
      expect(await read(result)).toBe("");
      expect(state.events).toEqual([]);
    } finally {
      RENDER_LIMITS.fileBytes = limit;
    }
  });
});

describe("a PDF the renderer does not open", () => {
  it.each<[string, Opening, string]>([
    ["has no room", "room", "room"],
    ["cannot be reached", LOST, "call"],
    ["cannot read the file", "unreadable", "unreadable"],
    ["counts more pages than it renders", "page-count", "page-count"],
    ["refuses the file's size", "file-size", "file-size"],
    ["could not be started", "start", "start"],
    ["refuses with a word that has no rule of its own", "memory", "memory"],
  ])("is read from its stored page images when the renderer %s and they can be sent", async (_label, opening, reason) => {
    let { renderer, state } = fakeRenderer([drawn([11])], [opening]);
    let { ai, bands, images } = bandAi();
    let download: ReturnType<typeof byteStream> | undefined;
    let { asked, readRange } = ranges(SCAN);
    let result = await pdfToText(ai, undefined, byteStream(SCAN.bytes).stream, async range => {
      if (range.page !== undefined) return readRange(range);
      asked.push(range);
      download = byteStream(SCAN.bytes, [100]);
      return download.stream;
    }, renderer);
    expect(result).toMatchObject({ hasText: false, transcribed: true, rereads: true });

    expect(await read(result)).toBe(TRANSCRIBED);
    expect(asked).toEqual([whole(SCAN), ...SCAN.images.map((image, i) => ({
      page: i + 1, ...image, fileSize: SCAN.bytes.byteLength,
    }))]);
    expect(state.events).toEqual(["open"]);
    // What the renderer did not read of the file is let go.
    if (reason === "room" || reason === "call" || reason === "file-size") expect(download!.state.cancelled).toBe(true);
    expect(bands).toEqual([]);
    expect(images()).toEqual(SCAN.images.map(({ offset, length }) => ({
      mimeType: "image/jpeg", bytes: SCAN.bytes.slice(offset, offset + length),
    })));
    expect(linesOf("warn", "google.drive.pdf.renderer_fallback")).toEqual([expect.objectContaining({
      route: "stored", reason, ...(reason === "call" ? { error: String(LOST) } : {}),
    })]);
    expect(linesOf("info", "google.drive.pdf.page_transcribed")).toHaveLength(3);
  });

  it.each<[string, Opening, string, string]>([
    ["has no room", "room", "room", RENDERER_BUSY],
    ["cannot be reached", LOST, "call", RENDERER_BUSY],
    ["cannot read the file", "unreadable", "unreadable", TRANSCRIPTION_FAILED],
    ["counts more pages than it renders", "page-count", "page-count", TRANSCRIPTION_FAILED],
    ["refuses the file's size", "file-size", "file-size", TRANSCRIPTION_FAILED],
    ["could not be started", "start", "start", TRANSCRIPTION_FAILED],
    ["refuses with a word that has no rule of its own", "memory", "memory", TRANSCRIPTION_FAILED],
  ])("fails the text when the renderer %s and its page images are not read as stored", async (_label, opening, reason, message) => {
    let { renderer, state } = fakeRenderer([drawn([11])], [opening]);
    let { ai, bands, images } = bandAi();
    let { result, asked } = await rendering(FAX_SCAN, renderer, ai);

    expect(await readToFailure(result)).toEqual({ text: "", error: new Error(message) });
    expect(asked).toEqual([whole(FAX_SCAN)]);
    expect(state.events).toEqual(["open"]);
    expect([bands, images()]).toEqual([[], []]);
    expect(linesOf("warn", "google.drive.pdf.render_failed")).toEqual([expect.objectContaining({ reason })]);
    // Why its page images are not read as stored is not said: nothing authorizes it by now.
    expect(everythingLogged()).not.toContain("untranscribable");
    expect(linesOf("warn", "google.drive.pdf.renderer_fallback")).toEqual([]);
  });

  it.each([["can be sent as stored", SCAN], ["cannot", FAX_SCAN]])(
    "fails the text as a changed file when the renderer was sent other than the file's size, whose page images %s",
    async (_label, pdf) => {
      let { renderer } = fakeRenderer([drawn([11])], ["size-mismatch"]);
      let { result, asked } = await rendering(pdf, renderer);
      expect(await readToFailure(result)).toEqual({ text: "", error: new Error(FILE_CHANGED) });
      expect(asked).toEqual([whole(pdf)]);
      expect(vi.mocked(console.warn)).not.toHaveBeenCalled();
    });

  it("fails the text, saying so, when the renderer finds the file encrypted, whatever its page images are", async () => {
    let { renderer } = fakeRenderer([drawn([11])], ["encrypted"]);
    let { ai, images } = bandAi();
    let { result, asked } = await rendering(SCAN, renderer, ai);
    expect(await readToFailure(result)).toEqual({ text: "", error: new Error(ENCRYPTED) });
    expect(asked).toEqual([whole(SCAN)]);
    expect(images()).toEqual([]);
  });

  it("fails the text with what its own read of the file failed with, whatever the renderer made of that", async () => {
    let broke = new Error("The download broke off.");
    let seen: unknown;
    // The renderer is told nothing of why the stream it was handed broke, and says so in its own words.
    let { renderer, state } = fakeRenderer([drawn([11])], [async pdf => {
      seen = await new Response(pdf).arrayBuffer().catch((error: unknown) => error);
      throw new Error("ReadableStream received over RPC disconnected prematurely.");
    }]);
    let { ai, images } = bandAi();
    let sent = 0;
    let result = await pdfToText(ai, undefined, byteStream(SCAN.bytes).stream, async () =>
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent++ === 0) controller.enqueue(SCAN.bytes.slice(0, 100));
          else controller.error(broke);
        },
      }, { highWaterMark: 0 }), renderer);

    let { error } = await readToFailure(result);
    expect(error).toBe(broke);
    expect(seen).toBe(broke);
    // The stored page images do not stand in for a file that could not be read.
    expect(images()).toEqual([]);
    expect(state.documents).toEqual([]);
    expect(vi.mocked(console.warn)).not.toHaveBeenCalled();
  });

  it("passes on a refusal of the whole-file read, such as a changed file, as it is", async () => {
    let { renderer, state } = fakeRenderer([drawn([11])]);
    let changed = new Error(FILE_CHANGED);
    let { ai } = bandAi();
    let result = await pdfToText(ai, undefined, byteStream(SCAN.bytes).stream, () => Promise.reject(changed), renderer);
    await expect(read(result)).rejects.toBe(changed);
    expect(state.events).toEqual([]);
  });
});

describe("a rendered PDF's pages", () => {
  it("renders a page only once the text has been read up to it, and gives each whole in one read", async () => {
    let { renderer, state } = fakeRenderer([drawn([11, 12]), drawn([21, 22])]);
    let { ai, bands } = bandAi();
    let { result } = await rendering(FAX_SCAN, renderer, ai);
    let reader = result.text.getReader();
    let decoder = new TextDecoder();

    expect(decoder.decode((await reader.read()).value)).toBe("### Page 1\nband 11\nband 12");
    await settled();
    expect(state.events).toEqual(["open", "render 1"]);
    expect(bands).toHaveLength(2);
    expect(decoder.decode((await reader.read()).value)).toBe("\n\n### Page 2\nband 21\nband 22");
    expect((await reader.read()).done).toBe(true);
    expect(state.events).toEqual(["open", "render 1", "render 2", "disposed"]);
  });

  it("asks nothing of the model for a band without pixels, and joins the others in the page's order", async () => {
    let { renderer } = fakeRenderer([drawn([11, null, 13, null])]);
    // The first band's answer comes after the third's.
    let late = deferred<Response>();
    let { ai, bands } = bandAi(({ shade }) => {
      if (shade === 11) return late.promise;
      late.resolve(eventResponse(tokenEvents(["first"])));
      return ["third"];
    });
    let { result } = await rendering(FAX_SCAN, renderer, ai);
    expect(await read(result)).toBe("### Page 1\nfirst\nthird");
    expect(bands.map(({ shade }) => shade).toSorted()).toEqual([11, 13]);
  });

  it("says so of a page that could not be drawn, and goes on with the next", async () => {
    let { renderer, state } = fakeRenderer([drawn([11]), refusedAs("memory", true), drawn([31])]);
    let { ai, bands } = bandAi();
    let { result } = await rendering(FAX_SCAN, renderer, ai);
    expect(await read(result)).toBe(`### Page 1\nband 11\n\n### Page 2\n${UNDRAWN_PAGE}\n\n### Page 3\nband 31`);
    expect(bands).toHaveLength(2);
    expect(state.documents[0]).toMatchObject({ disposed: 1 });
    expect(linesOf("warn", "google.drive.pdf.page_undrawn")).toEqual([expect.objectContaining({
      page: 2, reason: "memory", heapBytes: 18_939_904, work: 1000,
    })]);
  });

  it("asks nothing of the model for a blank page, and says so only when it holds an image", async () => {
    let { renderer } = fakeRenderer([
      drawn([null, null]), drawn([null], { images: 0 }), drawn([31]), drawn([null], { images: 0 }),
    ]);
    let { ai, bands } = bandAi();
    let { result } = await rendering(FAX_SCAN, renderer, ai);
    expect(await read(result)).toBe(
      `### Page 1\n${BLANK_PAGE}\n\n### Page 2\n\n\n### Page 3\nband 31\n\n### Page 4\n`);
    expect(bands).toHaveLength(1);
  });

  it("marks a page whose text ends early, and then one that was drawn at a lower resolution", async () => {
    let { renderer } = fakeRenderer([
      drawn([11, 12], { reduced: true, dpi: 75 }), drawn([21], { reduced: true, dpi: 75 }), drawn([31]),
    ]);
    // A band stopped at the output limit both times it is asked for is kept as far as it went.
    let { ai, bands } = bandAi(({ shade }) =>
      shade === 12 ? eventResponse(tokenEvents(["row | row"], "length")) : [`band ${shade}`]);
    let { result } = await rendering(FAX_SCAN, renderer, ai);
    expect(await read(result)).toBe(
      `### Page 1\nband 11\nrow | row${CUT_OFF}${REDUCED_PAGE}\n\n### Page 2\nband 21${REDUCED_PAGE}\n\n### Page 3\nband 31`);
    expect(bands.filter(({ shade }) => shade === 12)).toHaveLength(2);
  });

  it("sends each half of a band that is cut in two as a PNG of that half's own rows", async () => {
    // One band of 90 rows, written on in every row but row 40, where it is cut.
    let rows = 90, cut = 40;
    let pixels = new Uint8Array(BAND_WIDTH * rows).fill(255);
    for (let row = 0; row < rows; row++) if (row !== cut) pixels[row * BAND_WIDTH + 1] = row;
    let page = { ...drawn([]), height: rows, blank: false, bands: [{ top: 0, rows, ink: 100, pixels }] };
    let { renderer } = fakeRenderer([page]);
    // The band's first answer is stopped at the output limit; its halves' answers end whole.
    let { ai, bands } = bandAi(({ height }) => height === rows
      ? eventResponse(tokenEvents(["as far as the limit"], "length")) : [height === cut ? "top" : "bottom"]);
    let { result } = await rendering(imagePdf([scanPage(1, { filter: "/CCITTFaxDecode" })]), renderer, ai);
    expect(await read(result)).toBe("### Page 1\ntop\nbottom");
    expect(bands.map(({ width, height, grey8 }) => ({ width, height, grey8 }))).toEqual([
      { width: BAND_WIDTH, height: rows, grey8: true }, { width: BAND_WIDTH, height: cut, grey8: true },
      { width: BAND_WIDTH, height: rows - cut, grey8: true },
    ]);
    expect(bands[1]!.rows).toEqual(pixels.slice(0, cut * BAND_WIDTH));
    expect(bands[2]!.rows).toEqual(pixels.slice(cut * BAND_WIDTH));
    expect(linesOf("info", "google.drive.pdf.band_transcribed")).toMatchObject([{ band: 1, asks: 3, askedAgain: "truncated" }]);
  });

  it("gives a page whose bands all read as nothing its heading alone", async () => {
    let { renderer } = fakeRenderer([drawn([11, 12]), drawn([21])]);
    let { ai } = bandAi(({ shade }) => shade === 21 ? ["last"] : []);
    let { result } = await rendering(FAX_SCAN, renderer, ai);
    expect(await read(result)).toBe("### Page 1\n\n\n### Page 2\nlast");
  });

  it("fails the text when a page's render refuses the PDF as a whole, logging the reason word and the page", async () => {
    let { renderer, state } = fakeRenderer([drawn([11]), refusedAs("empty-work"), drawn([31])]);
    let { result } = await rendering(SCAN, renderer);
    expect(await readToFailure(result)).toEqual({ text: "### Page 1\nband 11", error: new Error(TRANSCRIPTION_FAILED) });
    expect(state.events).toEqual(["open", "render 1", "render 2", "disposed"]);
    expect(linesOf("warn", "google.drive.pdf.render_failed")).toEqual([expect.objectContaining({
      reason: "empty-work", page: 2, heapBytes: 18_939_904, work: 1000,
    })]);
  });

  it("fails the text when a band cannot be read, having let every other call end, and logs which page", async () => {
    let { renderer, state } = fakeRenderer([drawn([11]), drawn([21, 22, 23]), drawn([31])]);
    let given: AbortSignal[] = [];
    let { ai } = bandAi(({ shade, signal }) => {
      if (shade === 22) return new Response(JSON.stringify({ internalCode: 8006, message: "secret" }), { status: 400 });
      if (shade < 20) return [`band ${shade}`];
      // The page's other bands are never answered: they end when the page is given up.
      given.push(signal);
      return new Promise<Response>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    });
    let { result } = await rendering(FAX_SCAN, renderer, ai);
    expect(await readToFailure(result)).toEqual({ text: "### Page 1\nband 11", error: new Error(TRANSCRIPTION_FAILED) });
    expect(given.every(signal => signal.aborted)).toBe(true);
    expect(state.events).toEqual(["open", "render 1", "render 2", "disposed"]);
    expect(linesOf("warn", "google.drive.pdf.transcription_failed")).toEqual([expect.objectContaining({
      page: 2, httpStatus: 400, providerCode: 8006,
    })]);
    expect(everythingLogged()).not.toContain("secret");
  });

  it("logs sizes, counts, page numbers and reason words, and never the text", async () => {
    let { renderer } = fakeRenderer([drawn([11, null], { reduced: true, dpi: 75 }), drawn([null])]);
    let { ai } = bandAi(() => ["Harbour Ledger"]);
    let { result } = await rendering(FAX_SCAN, renderer, ai);
    await read(result);

    expect(linesOf("info", "google.drive.pdf.page_rendered")).toEqual([
      expect.objectContaining({
        page: 1, width: BAND_WIDTH, height: 2 * BAND_ROWS, bands: 2, blank: false, images: 1, dpi: 75, reduced: true,
        heapBytes: 18_939_904, objects: 1, imagePixels: 400, steps: 1, strips: 1, work: 1000,
      }),
      expect.objectContaining({ page: 2, bands: 1, blank: true }),
    ]);
    let [band] = linesOf("info", "google.drive.pdf.band_transcribed");
    expect(band).toMatchObject({ page: 1, band: 1, bands: 2, asks: 1 });
    expect(band!.imageBytes).toBeGreaterThan(0);
    expect(band).not.toHaveProperty("askedAgain");
    expect(linesOf("info", "google.drive.pdf.band_transcribed")).toHaveLength(1);
    expect(everythingLogged()).not.toContain("Harbour");
  });
});

describe("a rendered PDF whose document is lost", () => {
  it.each<[string, PageAnswer, string]>([
    ["the call for a page fails", LOST, "call"],
    ["a page is answered with the PDF having been released", refusedAs("released"), "released"],
  ])("reads and opens the file again, once, when %s after a page was rendered", async (_label, lost, reason) => {
    let { renderer, state } = fakeRenderer(nth => nth === 0
      ? [drawn([11]), lost, drawn([99])] : [drawn([98]), drawn([21]), drawn([31])]);
    let { result, asked } = await rendering(SCAN, renderer);

    expect(await read(result)).toBe("### Page 1\nband 11\n\n### Page 2\nband 21\n\n### Page 3\nband 31");
    expect(asked).toEqual([whole(SCAN), whole(SCAN)]);
    // The lost document is let go before the file is opened again, and each exactly once.
    expect(state.events).toEqual(["open", "render 1", "render 2", "disposed", "open", "render 2", "render 3", "disposed"]);
    expect(state.documents.map(({ disposed }) => disposed)).toEqual([1, 1]);
    expect(state.opens[1]).toEqual({ bytes: SCAN.bytes, size: SCAN.bytes.byteLength });
    expect(linesOf("info", "google.drive.pdf.rendering")).toEqual([
      expect.not.objectContaining({ reason }), expect.objectContaining({ ocrPages: 3, reason }),
    ]);
    expect(vi.mocked(console.warn)).not.toHaveBeenCalled();
  });

  it.each<[string, PageAnswer[], string, object]>([
    ["its first page", [LOST, drawn([21])], "", { page: 1, reason: "call", error: String(LOST) }],
    ["a page that follows only one that could not be drawn", [refusedAs("memory", true), refusedAs("released")],
      `### Page 1\n${UNDRAWN_PAGE}`, { page: 2, reason: "released" }],
  ])("fails the text, opening nothing again, when a document is lost at %s", async (_label, pages, text, line) => {
    let { renderer, state } = fakeRenderer(pages);
    let { result, asked } = await rendering(SCAN, renderer);
    expect(await readToFailure(result)).toEqual({ text, error: new Error(TRANSCRIPTION_FAILED) });
    expect(asked).toEqual([whole(SCAN)]);
    expect(state.documents.map(({ disposed }) => disposed)).toEqual([1]);
    expect(linesOf("warn", "google.drive.pdf.render_failed")).toEqual([expect.objectContaining(line)]);
  });

  it("fails the text when the page is lost again by the document opened for it", async () => {
    let { renderer, state } = fakeRenderer([drawn([11]), LOST, drawn([31])]);
    let { result, asked } = await rendering(SCAN, renderer);
    expect(await readToFailure(result)).toEqual({ text: "### Page 1\nband 11", error: new Error(TRANSCRIPTION_FAILED) });
    expect(asked).toEqual([whole(SCAN), whole(SCAN)]);
    expect(state.events).toEqual(["open", "render 1", "render 2", "disposed", "open", "render 2", "disposed"]);
    expect(state.documents.map(({ disposed }) => disposed)).toEqual([1, 1]);
  });

  it.each<[string, Opening, string]>([
    ["has no room", "room", RENDERER_BUSY],
    ["cannot be reached", LOST, TRANSCRIPTION_FAILED],
    ["cannot read the file", "unreadable", TRANSCRIPTION_FAILED],
    ["finds the file encrypted", "encrypted", ENCRYPTED],
    ["is given a file of another size", "size-mismatch", FILE_CHANGED],
  ])("fails the text when the renderer %s as the file is opened again, though its page images could be sent", async (_label, opening, message) => {
    let { renderer, state } = fakeRenderer([drawn([11]), refusedAs("released")], [undefined, opening]);
    let { ai, images } = bandAi();
    let { result, asked } = await rendering(SCAN, renderer, ai);

    expect(await readToFailure(result)).toEqual({ text: "### Page 1\nband 11", error: new Error(message) });
    // A text that has given a rendered page is never read on from the stored ones.
    expect(asked).toEqual([whole(SCAN), whole(SCAN)]);
    expect(images()).toEqual([]);
    expect(linesOf("warn", "google.drive.pdf.renderer_fallback")).toEqual([]);
    expect(state.events).toEqual(["open", "render 1", "render 2", "disposed", "open"]);
  });
});

describe("a rendered PDF's idle minute", () => {
  /** Long enough that two on end are more than the minute a text may sit idle. */
  const WAIT_MS = 35_000;
  let wait = () => new Promise<void>(resolve => setTimeout(resolve, WAIT_MS));

  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("is not counted over a file that keeps arriving, a renderer that keeps answering or a band whose text keeps coming", async () => {
    // The renderer takes its time to open the file, and again to render its page.
    let received = 0;
    let { renderer } = fakeRenderer([async () => {
      await wait();
      return drawn([11]);
    }], [async (pdf, document) => {
      received = (await new Response(pdf).arrayBuffer()).byteLength;
      await wait();
      return document();
    }]);
    // The band's answer takes its time to begin, and between its pieces.
    let { ai } = bandAi(async () => {
      await wait();
      let pieces = tokenEvents(["slow", " text"]).split(/(?<=\n\n)/);
      let sent = 0;
      return new Response(new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (sent === pieces.length) return controller.close();
          if (sent === 2 || sent === 3) await wait();
          controller.enqueue(new TextEncoder().encode(pieces[sent++]));
        },
      }, { highWaterMark: 0 }));
    });
    // The file arrives in three pieces, each after a wait.
    let sent = 0;
    let result = await pdfToText(ai, undefined, byteStream(SCAN.bytes).stream, async () =>
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (sent === 3) return controller.close();
          await wait();
          let third = Math.ceil(SCAN.bytes.byteLength / 3);
          controller.enqueue(SCAN.bytes.slice(sent * third, ++sent * third));
        },
      }, { highWaterMark: 0 }), renderer);

    let began = Date.now();
    expect(await pumped(read(result), PACE)).toBe("### Page 1\nslow text");
    expect(Date.now() - began).toBeGreaterThan(7 * WAIT_MS);
    expect(received).toBe(SCAN.bytes.byteLength);
    expect(vi.mocked(console.warn)).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves no timer behind when read to its end, cancelled, failed or read from the stored page images", async () => {
    let ended = await rendering(FAX_SCAN, fakeRenderer([drawn([11]), drawn([21])]).renderer);
    expect(await pumped(read(ended.result))).toBe("### Page 1\nband 11\n\n### Page 2\nband 21");
    expect(vi.getTimerCount()).toBe(0);

    let cancelled = await rendering(FAX_SCAN, fakeRenderer([drawn([11]), drawn([21])]).renderer);
    let reader = cancelled.result.text.getReader();
    await pumped(reader.read());
    expect(vi.getTimerCount()).toBe(1);
    await reader.cancel();
    expect(vi.getTimerCount()).toBe(0);

    let failed = await rendering(FAX_SCAN, fakeRenderer([drawn([11])], ["unreadable"]).renderer);
    expect((await pumped(readToFailure(failed.result))).error).toEqual(new Error(TRANSCRIPTION_FAILED));
    expect(vi.getTimerCount()).toBe(0);

    let stored = await rendering(SCAN, fakeRenderer([drawn([11])], ["room"]).renderer);
    expect(await pumped(read(stored.result))).toBe(TRANSCRIBED);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends a text whose page the renderer does not answer for a minute, and lets the document go once it has", async () => {
    let page = deferred<RenderedPage>();
    let { renderer, state } = fakeRenderer([drawn([11]), () => page.promise]);
    let { ai, bands } = bandAi();
    let { result } = await rendering(FAX_SCAN, renderer, ai);
    let reader = result.text.getReader();
    await pumped(reader.read());

    let outcome: unknown = "waiting";
    reader.read().then(() => { outcome = "read"; }, (error: unknown) => { outcome = error; });
    await vi.advanceTimersByTimeAsync(TRANSCRIPTION_IDLE_MS - 1);
    expect(outcome).toBe("waiting");
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toEqual(new Error(IDLE));
    expect(linesOf("warn", "google.drive.pdf.transcription_idle")).toEqual([expect.objectContaining({ page: 2 })]);
    // The page being rendered is left to finish, and its document let go only then.
    expect(state.documents[0]!.disposed).toBe(0);
    page.resolve(drawn([21]));
    await vi.advanceTimersByTimeAsync(1);
    expect(state.documents[0]!.disposed).toBe(1);
    expect(bands.map(({ shade }) => shade)).toEqual([11]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends a text left unread between two pages for a minute, letting its document go", async () => {
    let { renderer, state } = fakeRenderer([drawn([11]), drawn([21])]);
    let { result } = await rendering(FAX_SCAN, renderer);
    let reader = result.text.getReader();
    await pumped(reader.read());
    expect(state.documents[0]!.disposed).toBe(0);

    await vi.advanceTimersByTimeAsync(TRANSCRIPTION_IDLE_MS);
    await expect(reader.read()).rejects.toThrow(IDLE);
    expect(state.events).toEqual(["open", "render 1", "disposed"]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

/** A band's request that is never answered: it ends when its signal gives it up, which `events` notes. */
function unanswered(events: string[]) {
  return ({ signal }: SentBand) => new Promise<Response>((_, reject) => {
    signal.addEventListener("abort", () => {
      events.push("band given up");
      reject(signal.reason);
    });
  });
}

/** A read of the file that gives its first 100 bytes and then nothing more; `stalled` settles once more is asked for. */
function stalledDownload(bytes: Uint8Array) {
  let state = { cancelled: false };
  let stalled = deferred<void>();
  let sent = false;
  let stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) {
        stalled.resolve();
        return new Promise<void>(() => {});
      }
      sent = true;
      controller.enqueue(bytes.slice(0, 100));
    },
    cancel() { state.cancelled = true; },
  }, { highWaterMark: 0 });
  return { stream, state, stalled: stalled.promise };
}

describe("a rendered PDF's text, however it ends", () => {
  it("lets the document go once its last page has answered, before that page is read, and not again", async () => {
    let { renderer, state } = fakeRenderer([drawn([11]), drawn([21])]);
    let disposedBy: Record<number, number> = {};
    let { ai } = bandAi(({ shade }) => {
      disposedBy[shade] = state.documents[0]!.disposed;
      return [`band ${shade}`];
    });
    let { result } = await rendering(FAX_SCAN, renderer, ai);
    expect(await read(result)).toBe("### Page 1\nband 11\n\n### Page 2\nband 21");
    expect(disposedBy).toEqual({ 11: 0, 21: 1 });
    await settled();
    expect(state.documents.map(({ disposed }) => disposed)).toEqual([1]);
  });

  it("opens nothing for a text that is cancelled unread", async () => {
    let { renderer, state } = fakeRenderer([drawn([11])]);
    let { result, asked } = await rendering(FAX_SCAN, renderer);
    await result.text.cancel();
    await settled();
    expect(asked).toEqual([]);
    expect(state.events).toEqual([]);
  });

  it("lets the document go when cancelled between two pages", async () => {
    let { renderer, state } = fakeRenderer([drawn([11]), drawn([21])]);
    let { result } = await rendering(FAX_SCAN, renderer);
    let reader = result.text.getReader();
    await reader.read();
    await reader.cancel();
    await settled();
    expect(state.events).toEqual(["open", "render 1", "disposed"]);
  });

  it("gives up the band calls in flight when cancelled, and lets the document go once they have ended", async () => {
    let { renderer, state } = fakeRenderer([drawn([11, 12, 13, 14, 15]), drawn([21])]);
    let { ai, bands } = bandAi(unanswered(state.events));
    let { result } = await rendering(FAX_SCAN, renderer, ai);
    let reader = result.text.getReader();
    let pending = reader.read();
    await vi.waitFor(() => expect(bands).toHaveLength(4));

    await reader.cancel("stopped");
    expect((await pending).done).toBe(true);
    await settled();
    expect(state.events).toEqual([
      "open", "render 1", "band given up", "band given up", "band given up", "band given up", "disposed",
    ]);
    // The fifth band, which waited for a call to end, is never asked for.
    expect(bands).toHaveLength(4);
    expect(vi.mocked(console.warn)).not.toHaveBeenCalled();
  });

  it("leaves a page being rendered to finish when cancelled, drops it, and lets the document go then", async () => {
    let page = deferred<RenderedPage>();
    let { renderer, state } = fakeRenderer([() => page.promise, drawn([21])]);
    let { ai, bands } = bandAi();
    let { result } = await rendering(FAX_SCAN, renderer, ai);
    let reader = result.text.getReader();
    void reader.read();
    await vi.waitFor(() => expect(state.events).toEqual(["open", "render 1"]));

    await reader.cancel();
    await settled();
    expect(state.documents[0]!.disposed).toBe(0);
    page.resolve(drawn([11]));
    await settled();
    expect(state.events).toEqual(["open", "render 1", "disposed"]);
    expect(bands).toEqual([]);
  });

  it("does not read the file again for a page whose document is lost once the text has been cancelled", async () => {
    let page = deferred<RenderedPage | RenderRefused>();
    let { renderer, state } = fakeRenderer([drawn([11]), () => page.promise, drawn([31])]);
    let { result, asked } = await rendering(SCAN, renderer);
    let reader = result.text.getReader();
    await reader.read();
    void reader.read();
    await vi.waitFor(() => expect(state.events).toEqual(["open", "render 1", "render 2"]));

    await reader.cancel();
    page.resolve(refusedAs("released"));
    await settled();
    expect(asked).toEqual([whole(SCAN)]);
    expect(state.events).toEqual(["open", "render 1", "render 2", "disposed"]);
    expect(vi.mocked(console.warn)).not.toHaveBeenCalled();
  });

  it.each([
    ["fails as its stream does", false],
    ["answers with a document all the same, which is let go at once", true],
  ])("ends an open in flight by erroring the stream handed to it, and lets its own read go, when the open %s", async (_label, answers) => {
    let seen: unknown[] = [];
    let { renderer, state } = fakeRenderer([drawn([11])], [async (pdf, document) => {
      // The call has the stream locked, as a call over a binding does.
      let reader = pdf.getReader();
      let broke = false;
      try {
        for (;;) if ((await reader.read()).done) break;
      } catch (error) {
        seen.push(error);
        broke = true;
      }
      // The call fails in words of its own for a stream that broke off.
      if (broke && !answers) throw new Error("ReadableStream received over RPC disconnected prematurely.");
      return document();
    }]);
    let download = stalledDownload(FAX_SCAN.bytes);
    let { ai, bands } = bandAi();
    let result = await pdfToText(ai, undefined, byteStream(FAX_SCAN.bytes).stream, async () => download.stream, renderer);
    let reader = result.text.getReader();
    let pending = reader.read();
    await download.stalled;

    await reader.cancel("stopped");
    expect((await pending).done).toBe(true);
    await settled();
    expect(seen).toEqual(["stopped"]);
    expect(download.state.cancelled).toBe(true);
    expect(state.documents).toEqual(answers ? [{ asked: [], disposed: 1 }] : []);
    expect(bands).toEqual([]);
    expect(vi.mocked(console.warn)).not.toHaveBeenCalled();
  });

  it("lets go of a file whose read is answered only after the text was cancelled, opening nothing", async () => {
    let { renderer, state } = fakeRenderer([drawn([11])]);
    let answer = deferred<ReadableStream<Uint8Array>>();
    let { ai } = bandAi();
    let result = await pdfToText(ai, undefined, byteStream(FAX_SCAN.bytes).stream, () => answer.promise, renderer);
    let reader = result.text.getReader();
    void reader.read();
    await settled();

    await reader.cancel();
    let download = byteStream(FAX_SCAN.bytes);
    answer.resolve(download.stream);
    await settled();
    expect(download.state.cancelled).toBe(true);
    expect(state.events).toEqual([]);
  });
});

// What Workers AI's toMarkdown returned for generated PDFs some of whose pages have text and some
// none. A page that is an image alone, or blank, is its heading and line breaks.
/** One page's text in those PDFs, and another's. */
const SHEET_A = "Harbour ledger sheet A\nBerth A was let to the schooner Marrowfen for 14 days at 22.50 florins a day.\n" +
  "The pilot's fee of 31.75 florins was entered against docket DK-5510-AB.\n";
const SHEET_B = SHEET_A.replace("sheet A", "sheet B").replace("Berth A", "Berth B");
/** Five pages: an image, text, an image, text, an image. */
const IMAGE_FIRST_MIDDLE_LAST = `${PREAMBLE}### Page 1\n\n\n\n\n### Page 2\n${SHEET_A}\n\n\n### Page 3\n\n\n\n\n` +
  `### Page 4\n${SHEET_B}\n\n\n### Page 5\n\n\n`;
/** Two images, then text. */
const LEADING_IMAGES = `${PREAMBLE}### Page 1\n\n\n\n\n### Page 2\n\n\n\n\n### Page 3\n${SHEET_A}\n`;
/** Text, then three images. */
const TRAILING_IMAGES = `${PREAMBLE}### Page 1\n${SHEET_A}\n\n\n### Page 2\n\n\n\n\n### Page 3\n\n\n\n\n### Page 4\n\n\n`;
/** Text holding the lines "### Page 2" and "### Page 7", an image, then text. */
const HEADING_IN_TEXT = `${PREAMBLE}### Page 1\nFirst sheet\n### Page 2\na line after a line that looks like a heading\n` +
  "### Page 7\n\n\n\n### Page 2\n\n\n\n\n### Page 3\nindented first line of sheet three\nlast line after two empty lines\n\n";
/** Text, text ending in the line "### Page 3", an image, then text beginning with the line "### Page 4". */
const GAPS_IN_TEXT = `${PREAMBLE}### Page 1\nTop line of sheet one\nsecond line, 120 points lower\n` +
  "third line, 120 points lower again\n\n\n\n### Page 2\nA sheet whose next line is only spaces\n" +
  "and whose last line looks like a heading\n### Page 3\n\n\n\n### Page 3\n\n\n\n\n### Page 4\n### Page 4\n" +
  "a sheet that begins with its own heading-like line\n\n";

const READ_FROM_IMAGE =
  "[This page has no text of its own: what follows was read from its image by a vision model, which can misread.]";
const UNREAD_PAGES = "[Pages of this PDF that have no text of their own could not be read just now.]";
/** A page that has text of its own, in a fake renderer: it is never asked for. */
const TEXT_PAGE = drawn([99]);

/** A conversion's text from its first page heading on. */
function ownText(markdown: string): string {
  return markdown.slice(PREAMBLE.length);
}

/** What stands under the heading of a page whose image the model read as `text`. */
function fromImage(text: string): string {
  return `${READ_FROM_IMAGE}\n\n${text}\n\n`;
}

/**
 * The text of {@link IMAGE_FIRST_MIDDLE_LAST} with these under the headings of its pages 1, 3
 * and 5: the line breaks the conversion gave, unless given.
 */
function sheets(first = "\n\n\n\n", middle = "\n\n\n\n", last = "\n\n"): string {
  return `### Page 1\n${first}### Page 2\n${SHEET_A}\n\n\n### Page 3\n${middle}### Page 4\n${SHEET_B}\n\n\n### Page 5\n${last}`;
}

/** A response that streams `markdown` as a conversion's, 64 bytes at a time, and whether it was cancelled. */
function conversionOf(markdown: string) {
  let { stream, state } = byteStream(new TextEncoder().encode(markdownJson(markdown)), [64]);
  return { response: new Response(stream), state };
}

/**
 * `pdf`, which is {@link SCAN} unless given and holds images, read with `renderer` there when its
 * conversion is `markdown` or answers with the response given, and the model answers its bands
 * with `answer`.
 */
async function mixed(
  markdown: string | Response, renderer: PdfRendering, answer?: Parameters<typeof bandAi>[0], pdf = SCAN,
) {
  let { ai, bands, images } = bandAi(answer, markdown);
  let { asked, readRange } = ranges(pdf);
  let result = await pdfToText(ai, undefined, byteStream(pdf.bytes, [65_536]).stream, readRange, renderer);
  return { result, asked, bands, images };
}

describe("pdfToText reading a PDF that has text, and pages without any", () => {
  it.each([
    ["an image first, in the middle and last", IMAGE_FIRST_MIDDLE_LAST, [1, 3, 5]],
    ["images before its text", LEADING_IMAGES, [1, 2]],
    ["images after its text", TRAILING_IMAGES, [2, 3, 4]],
    ["lines of its own that read as page headings", HEADING_IN_TEXT, [2]],
    ["a line of its own that reads as the next page's heading, last on a page and first on one", GAPS_IN_TEXT, [3]],
  ])("gives the conversion's text to the byte when no page is read from its image, in a PDF with %s", async (_label, markdown, empty) => {
    // Every way a page is left as it was: blank, not drawn, read as nothing, and said to be
    // blank whatever its bands hold.
    let left = [drawn([null]), refusedAs("memory", true), drawn([12]), drawn([13], { blank: true })];
    let { renderer, state } = fakeRenderer(Array.from({ length: 5 }, (_, i) => left[i % left.length]!));
    let { result, asked, bands } = await mixed(markdown, renderer, () => []);

    expect(result).toEqual({ text: expect.any(ReadableStream), hasText: true, transcribed: false, rereads: true });
    expect(await read(result)).toBe(ownText(markdown));
    // Only the pages without text were rendered, from the file read whole once.
    expect(state.documents.map(document => document.asked.map(({ index }) => index + 1))).toEqual([empty]);
    expect(asked).toEqual([whole(SCAN)]);
    // A page that is blank is not shown to the model, whatever its bands hold.
    expect(bands.every(({ shade }) => shade === 12)).toBe(true);
    expect(state.documents[0]!.disposed).toBe(1);
  });

  it.each([
    ["draws no image: an image written into its content, or writing drawn as shapes", { images: 0 }],
    ["may draw an image that was not counted, its objects not having all been looked at", { images: 0, surveyed: false }],
  ])("reads a page with ink that %s", async (_label, page) => {
    let { renderer } = fakeRenderer([TEXT_PAGE, drawn([11], page), TEXT_PAGE]);
    let { result, bands } = await mixed(HEADING_IN_TEXT, renderer);
    expect(await read(result)).toBe(
      ownText(HEADING_IN_TEXT).replace("### Page 2\n\n\n\n\n", `### Page 2\n${fromImage("band 11")}`));
    expect(bands.map(({ shade }) => shade)).toEqual([11]);
  });

  it("reads the pages without text of a PDF in which the scan found no image of any kind", async () => {
    // What a page shows may be no object of the file for the scan to count, so the scan's
    // count does not decide whether its pages without text are drawn.
    let pdf = imagePdf([]);
    let { renderer, state } = fakeRenderer([TEXT_PAGE, drawn([11]), TEXT_PAGE]);
    let { result, asked, bands } = await mixed(HEADING_IN_TEXT, renderer, undefined, pdf);
    expect(result).toMatchObject({ hasText: true, transcribed: false, rereads: true });
    expect(await read(result)).toBe(
      ownText(HEADING_IN_TEXT).replace("### Page 2\n\n\n\n\n", `### Page 2\n${fromImage("band 11")}`));
    expect(asked).toEqual([whole(pdf)]);
    expect(bands.map(({ shade }) => shade)).toEqual([11]);
    expect(state.events).toEqual(["open", "render 2", "disposed"]);
  });

  it("reads nothing again, and opens nothing, for a PDF whose pages all have text", async () => {
    let { renderer, state } = fakeRenderer([TEXT_PAGE, TEXT_PAGE]);
    let markdown = `${PREAMBLE}### Page 1\n${SHEET_A}\n\n\n### Page 2\n${SHEET_B}\n\n`;
    let { result, asked, images } = await mixed(markdown, renderer);
    // It is still a text that may read the file again: nothing says so until it has been read.
    expect(result).toMatchObject({ hasText: true, transcribed: false, rereads: true });
    expect(await read(result)).toBe(ownText(markdown));
    expect([asked, images(), state.events]).toEqual([[], [], []]);
  });

  it("finds the pages without text wherever the response is split", async () => {
    for (let [markdown, empty] of [[HEADING_IN_TEXT, 2], [GAPS_IN_TEXT, 3]] as const) {
      let json = markdownJson(markdown);
      let expected = ownText(markdown).replace(`### Page ${empty}\n\n\n\n\n`, `### Page ${empty}\n${fromImage("band 11")}`);
      expect(expected).toContain(READ_FROM_IMAGE);
      let length = new TextEncoder().encode(json).byteLength;
      for (let cut = 1; cut < length; cut++) {
        let { renderer, state } = fakeRenderer([drawn([11]), drawn([11]), drawn([11]), drawn([11])]);
        let { result } = await mixed(splitResponse(json, cut), renderer);
        expect(await read(result), `cut at ${cut}`).toBe(expected);
        expect(state.documents[0]!.asked.map(({ index }) => index + 1)).toEqual([empty]);
      }
    }
  });

  it("finds them in a response that arrives a few bytes at a time", async () => {
    for (let size = 1; size <= 9; size++) {
      let { renderer, state } = fakeRenderer([drawn([null]), TEXT_PAGE, drawn([null]), TEXT_PAGE, drawn([null])]);
      let { result } = await mixed(streamedResponse(markdownJson(IMAGE_FIRST_MIDDLE_LAST), size), renderer);
      expect(await read(result), `${size} bytes at a time`).toBe(sheets());
      expect(state.documents[0]!.asked.map(({ index }) => index + 1)).toEqual([1, 3, 5]);
    }
  });

  it("reads a first, a middle and a last page without text from their images, each once the text is read up to it", async () => {
    let { renderer, state } = fakeRenderer([drawn([11]), TEXT_PAGE, drawn([31, 32]), TEXT_PAGE, drawn([51])]);
    let { result, asked, bands, images } = await mixed(IMAGE_FIRST_MIDDLE_LAST, renderer);
    expect(result).toEqual({ text: expect.any(ReadableStream), hasText: true, transcribed: false, rereads: true });
    let reader = result.text.getReader();

    // A heading is given as soon as it is known for one, before anything is rendered.
    expect(await readThrough(reader, "\n")).toBe("### Page 1\n");
    await settled();
    expect(asked).toEqual([]);
    expect(state.events).toEqual([]);
    let text = await readThrough(reader, "### Page 3\n", "### Page 1\n");
    expect(text).toBe(`### Page 1\n${fromImage("band 11")}### Page 2\n${SHEET_A}\n\n\n### Page 3\n`);
    await settled();
    expect(state.events).toEqual(["open", "render 1"]);

    text += await new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        let piece = await reader.read();
        if (piece.done) controller.close();
        else controller.enqueue(piece.value);
      },
    })).text();
    expect(text).toBe(sheets(fromImage("band 11"), fromImage("band 31\nband 32"), fromImage("band 51")));
    // The file is read whole once, and the document let go when its last page has answered.
    expect(asked).toEqual([whole(SCAN)]);
    expect(state.events).toEqual(["open", "render 1", "render 3", "render 5", "disposed"]);
    expect(bands.map(({ shade }) => shade).toSorted()).toEqual([11, 31, 32, 51]);
    for (let band of bands) expect(band.prompt).toContain("Never write an image or a link");
    expect(images()).toEqual([]);
    expect(linesOf("info", "google.drive.pdf.rendering")).toEqual([expect.objectContaining({
      pdfBytes: SCAN.bytes.byteLength, ocrPages: 5,
    })]);
    expect(linesOf("info", "google.drive.pdf.page_rendered").map(({ page }) => page)).toEqual([1, 3, 5]);
    expect(vi.mocked(console.warn)).not.toHaveBeenCalled();
    for (let word of ["Harbour", "Marrowfen", "band 11", "no text of its own"]) expect(everythingLogged()).not.toContain(word);
  });

  it("gives a page read from its image as the line that says so, its text, what is to be said of it, and an empty line", async () => {
    // The document has three pages, of which the second was drawn at a lower resolution.
    let { renderer, state } = fakeRenderer([TEXT_PAGE, drawn([21, 22], { reduced: true, dpi: 75 }), drawn([31])]);
    // A band stopped at the output limit both times it is asked for is kept as far as it went.
    let { result } = await mixed(TRAILING_IMAGES, renderer, ({ shade }) =>
      shade === 22 ? eventResponse(tokenEvents(["row | row"], "length")) : [`band ${shade}`]);

    expect(await read(result)).toBe(
      `### Page 1\n${SHEET_A}\n\n\n` +
      `### Page 2\n${READ_FROM_IMAGE}\n\nband 21\nrow | row${CUT_OFF}${REDUCED_PAGE}\n\n` +
      `### Page 3\n${READ_FROM_IMAGE}\n\nband 31\n\n` +
      // A page the document does not have is left as the conversion gave it.
      "### Page 4\n\n\n");
    expect(state.events).toEqual(["open", "render 2", "render 3", "disposed"]);
  });

  it("gives back the headings of the pages before the first with text, and reads those pages", async () => {
    let { renderer } = fakeRenderer([drawn([11]), drawn([21]), TEXT_PAGE]);
    let { result } = await mixed(LEADING_IMAGES, renderer);
    expect(await read(result)).toBe(
      `### Page 1\n${fromImage("band 11")}### Page 2\n${fromImage("band 21")}### Page 3\n${SHEET_A}\n`);
  });

  it("takes a line of the document's own that reads as a page heading for its text", async () => {
    let { renderer, state } = fakeRenderer([TEXT_PAGE, drawn([21]), drawn([31]), TEXT_PAGE]);
    expect(await read((await mixed(HEADING_IN_TEXT, renderer)).result)).toBe(
      "### Page 1\nFirst sheet\n### Page 2\na line after a line that looks like a heading\n### Page 7\n\n\n\n" +
      `### Page 2\n${fromImage("band 21")}### Page 3\nindented first line of sheet three\nlast line after two empty lines\n\n`);
    expect(state.documents[0]!.asked.map(({ index }) => index)).toEqual([1]);

    let gaps = fakeRenderer([TEXT_PAGE, TEXT_PAGE, drawn([31]), TEXT_PAGE]);
    expect(await read((await mixed(GAPS_IN_TEXT, gaps.renderer)).result)).toBe(
      ownText(GAPS_IN_TEXT).replace("### Page 3\n\n\n\n\n", `### Page 3\n${fromImage("band 31")}`));
    expect(gaps.state.documents[0]!.asked.map(({ index }) => index)).toEqual([2]);
  });

  it.each([
    ["line breaks and then text under a heading", "### Page 1\nText\n\n\n\n### Page 2\n\n\nlate text\n\n"],
    ["a line that reads as the heading of a page other than the next, after line breaks alone",
      "### Page 1\nText\n\n\n\n### Page 2\n\n\n\n\n### Page 9\nmore\n\n"],
    ["a line that reads as the next page's heading after one line break fewer than part two pages",
      "### Page 1\nText\n\n\n### Page 2\n\n\n\n\n### Page 3\nmore\n\n"],
    ["a line that reads as the next page's heading and is not ended", "### Page 1\nText\n\n\n\n### Page 2\n\n\n\n\n### Page 3"],
    ["a line that only begins as the next page's heading does", "### Page 1\nText\n\n\n\n### Page 21\n\n\n\n\n### Pag\n"],
  ])("passes on %s as the document's own text, rendering nothing", async (_label, text) => {
    let { renderer, state } = fakeRenderer([drawn([11]), drawn([21]), drawn([31])]);
    let { result } = await mixed(PREAMBLE + text, renderer);
    expect(result).toMatchObject({ hasText: true, transcribed: false, rereads: true });
    expect(await read(result)).toBe(text);
    expect(state.events).toEqual([]);
  });

  it("gives no empty piece for a last page that has no line break to give back", async () => {
    let { renderer, state } = fakeRenderer([TEXT_PAGE, drawn([null])]);
    let { result } = await mixed(`${PREAMBLE}### Page 1\nText\n\n\n\n### Page 2\n`, renderer);
    let reader = result.text.getReader();
    let sizes: number[] = [];
    for (let piece = await reader.read(); !piece.done; piece = await reader.read()) sizes.push(piece.value.byteLength);
    expect(sizes.reduce((sum, size) => sum + size)).toBe("### Page 1\nText\n\n\n\n### Page 2\n".length);
    expect(sizes.every(size => size > 0)).toBe(true);
    expect(state.events).toEqual(["open", "render 2", "disposed"]);
  });

  it.each<[string, PageAnswer[], Opening[], string, string[], object]>([
    ["the renderer has no room for the PDF", [], ["room"], sheets(`${UNREAD_PAGES}\n\n`), ["open"],
      { event: "google.drive.pdf.render_failed", reason: "room" }],
    ["the renderer cannot be reached", [], [LOST], sheets(`${UNREAD_PAGES}\n\n`), ["open"],
      { event: "google.drive.pdf.render_failed", reason: "call", error: String(LOST) }],
    ["the renderer cannot read the file", [], ["unreadable"], sheets(`${UNREAD_PAGES}\n\n`), ["open"],
      { event: "google.drive.pdf.render_failed", reason: "unreadable" }],
    ["the renderer finds the file encrypted", [], ["encrypted"], sheets(`${UNREAD_PAGES}\n\n`), ["open"],
      { event: "google.drive.pdf.render_failed", reason: "encrypted" }],
    ["a page's render refuses the PDF as a whole", [drawn([11]), TEXT_PAGE, refusedAs("empty-work"), TEXT_PAGE, drawn([51])],
      [], sheets(fromImage("band 11"), `${UNREAD_PAGES}\n\n`), ["open", "render 1", "render 3", "disposed"],
      { event: "google.drive.pdf.render_failed", reason: "empty-work", page: 3, heapBytes: 18_939_904, work: 1000 }],
    ["the document is lost before it rendered a page", [LOST, TEXT_PAGE, drawn([31]), TEXT_PAGE, drawn([51])],
      [], sheets(`${UNREAD_PAGES}\n\n`), ["open", "render 1", "disposed"],
      { event: "google.drive.pdf.render_failed", reason: "call", page: 1, error: String(LOST) }],
    ["the document is lost and the renderer has no room to open it again",
      [drawn([11]), TEXT_PAGE, refusedAs("released"), TEXT_PAGE, drawn([51])], [undefined, "room"],
      sheets(fromImage("band 11"), `${UNREAD_PAGES}\n\n`), ["open", "render 1", "render 3", "disposed", "open"],
      { event: "google.drive.pdf.render_failed", reason: "room" }],
    ["the page is lost again by the document opened for it", [drawn([11]), TEXT_PAGE, LOST, TEXT_PAGE, drawn([51])],
      [], sheets(fromImage("band 11"), `${UNREAD_PAGES}\n\n`),
      ["open", "render 1", "render 3", "disposed", "open", "render 3", "disposed"],
      { event: "google.drive.pdf.render_failed", reason: "call", page: 3 }],
    ["the model cannot read a band", [drawn([11]), TEXT_PAGE, drawn([31, 32]), TEXT_PAGE, drawn([51])],
      [], sheets(fromImage("band 11"), `${UNREAD_PAGES}\n\n`), ["open", "render 1", "render 3", "disposed"],
      { event: "google.drive.pdf.transcription_failed", page: 3, httpStatus: 400, providerCode: 8006 }],
  ])("keeps the document's own text when %s: that page gets a line, and no page after it is rendered", async (_label, pages, openings, text, events, line) => {
    let { renderer, state } = fakeRenderer(pages, openings);
    let { result, bands } = await mixed(IMAGE_FIRST_MIDDLE_LAST, renderer, ({ shade }) => shade === 32
      ? new Response(JSON.stringify({ internalCode: 8006, message: "secret" }), { status: 400 }) : [`band ${shade}`]);

    expect(await readToFailure(result)).toEqual({ text, error: undefined });
    expect(state.events).toEqual(events);
    // Each document that was opened is let go once, and no band of a later page is sent.
    expect(state.documents.every(({ disposed }) => disposed === 1)).toBe(true);
    expect(bands.every(({ shade }) => shade < 50)).toBe(true);
    expect(vi.mocked(console.warn).mock.calls).toEqual([[expect.objectContaining(line)]]);
    expect(everythingLogged()).not.toContain("secret");
  });

  it("reads and opens the file again when the document is lost between two pages without text", async () => {
    let { renderer, state } = fakeRenderer(nth => nth === 0
      ? [drawn([11]), TEXT_PAGE, refusedAs("released"), TEXT_PAGE, drawn([99])]
      : [drawn([98]), TEXT_PAGE, drawn([31]), TEXT_PAGE, drawn([51])]);
    let { result, asked } = await mixed(IMAGE_FIRST_MIDDLE_LAST, renderer);
    expect(await read(result)).toBe(sheets(fromImage("band 11"), fromImage("band 31"), fromImage("band 51")));
    expect(asked).toEqual([whole(SCAN), whole(SCAN)]);
    expect(state.events).toEqual([
      "open", "render 1", "render 3", "disposed", "open", "render 3", "render 5", "disposed",
    ]);
    expect(vi.mocked(console.warn)).not.toHaveBeenCalled();
  });

  it("fails the text with what reading the file again for a lost document failed with, a changed file included", async () => {
    let pages = [drawn([11]), TEXT_PAGE, refusedAs("released"), TEXT_PAGE, drawn([51])];
    let given = `### Page 1\n${fromImage("band 11")}### Page 2\n${SHEET_A}\n\n\n### Page 3\n`;
    let broke = new Error("The download broke off.");
    let lost = fakeRenderer(pages);
    let { ai } = bandAi(undefined, IMAGE_FIRST_MIDDLE_LAST);
    let reads = 0;
    let result = await pdfToText(ai, undefined, byteStream(SCAN.bytes).stream, async () => {
      if (reads++ > 0) throw broke;
      return byteStream(SCAN.bytes).stream;
    }, lost.renderer);
    let failed = await readToFailure(result);
    expect(failed.error).toBe(broke);
    expect(failed.text).toBe(given);
    // The lost document is let go once, nothing is opened for it, and no later page is rendered.
    expect(lost.state.events).toEqual(["open", "render 1", "render 3", "disposed"]);

    let changed = fakeRenderer(pages, [undefined, "size-mismatch"]);
    expect(await readToFailure((await mixed(IMAGE_FIRST_MIDDLE_LAST, changed.renderer)).result))
      .toEqual({ text: given, error: new Error(FILE_CHANGED) });
    expect(changed.state.events).toEqual(["open", "render 1", "render 3", "disposed", "open"]);
    expect(vi.mocked(console.warn)).not.toHaveBeenCalled();
  });

  it("lets the document go as soon as no further page is rendered", async () => {
    let { renderer, state } = fakeRenderer([drawn([11]), TEXT_PAGE, drawn([31]), TEXT_PAGE, drawn([51])]);
    let { result } = await mixed(IMAGE_FIRST_MIDDLE_LAST, renderer, () => new Response("{}", { status: 400 }));
    let reader = result.text.getReader();
    expect(await readThrough(reader, `${UNREAD_PAGES}\n\n`)).toBe(`### Page 1\n${UNREAD_PAGES}\n\n`);
    await settled();
    expect(state.events).toEqual(["open", "render 1", "disposed"]);
    await reader.cancel();
  });

  it("fails the text with what its own read of the file failed with, and lets the conversion go", async () => {
    let broke = new Error("The download broke off.");
    let { renderer, state } = fakeRenderer([drawn([11])], [async pdf => {
      await new Response(pdf).arrayBuffer().catch(() => undefined);
      throw new Error("ReadableStream received over RPC disconnected prematurely.");
    }]);
    let conversion = conversionOf(IMAGE_FIRST_MIDDLE_LAST);
    let { ai, bands } = bandAi(undefined, conversion.response);
    let sent = 0;
    let result = await pdfToText(ai, undefined, byteStream(SCAN.bytes).stream, async () =>
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent++ === 0) controller.enqueue(SCAN.bytes.slice(0, 100));
          else controller.error(broke);
        },
      }, { highWaterMark: 0 }), renderer);

    let { text, error } = await readToFailure(result);
    expect(error).toBe(broke);
    expect(text).toBe("### Page 1\n");
    expect(conversion.state.cancelled).toBe(true);
    expect(state.documents).toEqual([]);
    expect(bands).toEqual([]);
    expect(vi.mocked(console.warn)).not.toHaveBeenCalled();
  });

  it("fails the text as a changed file when the file read again is refused as one, or is not the size it was", async () => {
    let changed = new Error(FILE_CHANGED);
    let refused = fakeRenderer([drawn([11])]);
    let { ai } = bandAi(undefined, IMAGE_FIRST_MIDDLE_LAST);
    let result = await pdfToText(ai, undefined, byteStream(SCAN.bytes).stream, () => Promise.reject(changed), refused.renderer);
    expect((await readToFailure(result)).error).toBe(changed);
    expect(refused.state.events).toEqual([]);

    let other = fakeRenderer([drawn([11])], ["size-mismatch"]);
    expect(await readToFailure((await mixed(IMAGE_FIRST_MIDDLE_LAST, other.renderer)).result))
      .toEqual({ text: "### Page 1\n", error: new Error(FILE_CHANGED) });
    expect(other.state.events).toEqual(["open"]);
    expect(vi.mocked(console.warn)).not.toHaveBeenCalled();
  });

  it("fails the text in its own words when the conversion breaks off, letting the document go", async () => {
    let { renderer, state } = fakeRenderer([drawn([11]), TEXT_PAGE, drawn([31]), TEXT_PAGE, drawn([51])]);
    let json = markdownJson(IMAGE_FIRST_MIDDLE_LAST);
    let { result } = await mixed(streamedResponse(json.slice(0, json.indexOf("### Page 4")), 16), renderer);

    let { text, error } = await readToFailure(result);
    expect(error).toEqual(new Error(CONVERSION_FAILED));
    expect(text.startsWith(`### Page 1\n${fromImage("band 11")}### Page 2\n`)).toBe(true);
    await settled();
    expect(state.events).toEqual(["open", "render 1", "disposed"]);
    expect(vi.mocked(console.warn).mock.calls).toEqual([[expect.objectContaining({ event: "google.drive.pdf.failed" })]]);
  });

  it.each<[string, BuiltPdf, number]>([
    ["whose one image is too small to be a page", imagePdf([scanPage(1, { width: 64, height: 64 })]), RENDER_LIMITS.fileBytes],
    ["whose one image is a mask as large as a page",
      imagePdf([scanPage(1, { filter: "/FlateDecode", bitsPerComponent: 1, extra: "/ImageMask true" })]), RENDER_LIMITS.fileBytes],
    ["of exactly the largest size that is rendered", SCAN, SCAN.bytes.byteLength],
  ])("reads the pages without text of a PDF with text %s", async (_label, pdf, fileBytes) => {
    let { renderer, state } = fakeRenderer([TEXT_PAGE, drawn([21]), drawn([null]), drawn([null])]);
    let limit = RENDER_LIMITS.fileBytes;
    RENDER_LIMITS.fileBytes = fileBytes;
    try {
      let { result } = await mixed(TRAILING_IMAGES, renderer, undefined, pdf);
      expect(result).toMatchObject({ hasText: true, transcribed: false, rereads: true });
      expect(await read(result)).toBe(
        ownText(TRAILING_IMAGES).replace("### Page 2\n\n\n\n\n", `### Page 2\n${fromImage("band 21")}`));
    } finally {
      RENDER_LIMITS.fileBytes = limit;
    }
    expect(state.opens).toEqual([{ bytes: pdf.bytes, size: pdf.bytes.byteLength }]);
  });

  it("leaves a PDF with text as it is without a renderer or a size that is rendered", async () => {
    vi.useFakeTimers();
    let { renderer, state } = fakeRenderer([drawn([11])]);
    // The text without the page before its first with text, as it is given unless pages are read into it.
    let text = sheets().slice("### Page 1\n\n\n\n\n".length);
    let unchanged = async (pdf: BuiltPdf, given?: PdfRendering) => {
      let { ai, images } = bandAi(undefined, IMAGE_FIRST_MIDDLE_LAST);
      let { asked, readRange } = ranges(pdf);
      let result = await pdfToText(ai, undefined, byteStream(pdf.bytes).stream, readRange, given);
      expect(result).toEqual({ text: expect.any(ReadableStream), hasText: true, transcribed: false, rereads: false });
      // Nothing is kept for such a text: no timer runs while it is unread.
      expect(vi.getTimerCount()).toBe(0);
      expect(await read(result)).toBe(text);
      expect([asked, images()]).toEqual([[], []]);
    };

    await unchanged(SCAN);
    let limit = RENDER_LIMITS.fileBytes;
    RENDER_LIMITS.fileBytes = SCAN.bytes.byteLength - 1;
    try {
      await unchanged(SCAN, renderer);
    } finally {
      RENDER_LIMITS.fileBytes = limit;
    }
    expect(state.events).toEqual([]);
  });

  it("leaves a PDF with text as it is when the conversion answered before the scan saw the whole file", async () => {
    let { renderer, state } = fakeRenderer([drawn([11])]);
    let sent = 0;
    // Gives the PDF as far as its first page image and the next one's dictionary, then nothing more.
    let pdf = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent === 0) controller.enqueue(SCAN.bytes.slice(0, sent = SCAN.images[1]!.offset));
      },
    }, { highWaterMark: 0 });
    // Reads what there is of the upload, drops the rest, and answers with the PDF's text.
    let ai = {
      fetch: async (_url: string, init: RequestInit) => {
        let body = (init.body as ReadableStream<Uint8Array>).getReader();
        await body.read();
        await body.read();
        void body.read();
        await settled();
        await body.cancel();
        return streamedResponse(markdownJson(IMAGE_FIRST_MIDDLE_LAST));
      },
    } as unknown as AiFetcher;
    let result = await pdfToText(ai, undefined, pdf, ranges(SCAN).readRange, renderer);
    expect(result).toMatchObject({ hasText: true, transcribed: false, rereads: false });
    expect(await read(result)).toBe(sheets().slice("### Page 1\n\n\n\n\n".length));
    expect(state.events).toEqual([]);
  });

  it.each([
    ["is not the one after those before it", "### Page 1\n\n\n\n\n### Page 5\n\n\n\n\n", "### Page 2\nText of its own\n\n"],
    // The first page has text, whose first line reads as the heading of the page after it.
    ["follows the one before it directly", "### Page 1\n", "### Page 2\nhello\n\n\n\n### Page 2\n\n\n\n\n### Page 3\nmore\n\n"],
    ["follows the one before it after one line break fewer than a page without text has",
      "### Page 1\n\n\n\n", "### Page 2\nText of its own\n\n"],
    ["follows the one before it after one line break more than a page without text has",
      "### Page 1\n\n\n\n\n\n", "### Page 2\nText of its own\n\n"],
  ])("leaves a PDF with text as it is when its text begins under a heading that %s", async (_label, before, text) => {
    let { renderer, state } = fakeRenderer([drawn([11]), drawn([21]), drawn([31])]);
    let { result } = await mixed(PREAMBLE + before + text, renderer);
    expect(result).toMatchObject({ hasText: true, transcribed: false, rereads: false });
    expect(await read(result)).toBe(text);
    expect(state.events).toEqual([]);
  });
});

describe("a PDF with text whose pages without any are read, however its text ends", () => {
  /** Long enough that two on end are more than the minute a text may sit idle. */
  const WAIT_MS = 35_000;
  let wait = () => new Promise<void>(resolve => setTimeout(resolve, WAIT_MS));

  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("ends a text nobody reads after a minute, counted from when it was returned, and lets the conversion go", async () => {
    let { renderer, state } = fakeRenderer([drawn([11])]);
    let conversion = conversionOf(IMAGE_FIRST_MIDDLE_LAST);
    let { result, asked } = await mixed(conversion.response, renderer);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(TRANSCRIPTION_IDLE_MS);
    await expect(result.text.getReader().read()).rejects.toThrow(IDLE);
    expect(conversion.state.cancelled).toBe(true);
    expect([asked, state.events]).toEqual([[], []]);
    expect(vi.getTimerCount()).toBe(0);
    expect(linesOf("warn", "google.drive.pdf.transcription_idle")).toEqual([expect.not.objectContaining({ page: expect.anything() })]);
  });

  it("ends a text left unread after a page was read from its image, naming no page, and lets the document go", async () => {
    let { renderer, state } = fakeRenderer([drawn([11]), TEXT_PAGE, drawn([31]), TEXT_PAGE, drawn([51])]);
    let { result } = await mixed(IMAGE_FIRST_MIDDLE_LAST, renderer);
    let reader = result.text.getReader();
    await pumped(readThrough(reader, fromImage("band 11")));
    expect(state.documents[0]!.disposed).toBe(0);

    await vi.advanceTimersByTimeAsync(TRANSCRIPTION_IDLE_MS);
    await expect(reader.read()).rejects.toThrow(IDLE);
    expect(state.events).toEqual(["open", "render 1", "disposed"]);
    expect(linesOf("warn", "google.drive.pdf.transcription_idle")).toEqual([expect.not.objectContaining({ page: expect.anything() })]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("is not taken for idle while the conversion's text keeps arriving, though none of it is yet given", async () => {
    // From the second page's heading to the text's end, the response arrives two bytes at a time,
    // each after a wait: line breaks that are only counted, and headings held until their lines end.
    let json = markdownJson(TRAILING_IMAGES);
    let slow = json.indexOf("### Page 2"), textEnd = json.lastIndexOf('"}]');
    let at = 0;
    let response = new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (at === json.length) return controller.close();
        let end = at < slow ? slow : at < textEnd ? at + 2 : json.length;
        if (end === at + 2) await new Promise(resolve => setTimeout(resolve, WAIT_MS / 2));
        controller.enqueue(new TextEncoder().encode(json.slice(at, end)));
        at = end;
      },
    }, { highWaterMark: 0 }));
    let { renderer } = fakeRenderer([TEXT_PAGE, drawn([null]), drawn([null]), drawn([null])]);
    let { result } = await mixed(response, renderer);

    let began = Date.now();
    expect(await pumped(read(result), PACE)).toBe(ownText(TRAILING_IMAGES));
    expect(Date.now() - began).toBeGreaterThan(10 * WAIT_MS);
    expect(vi.mocked(console.warn)).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("is not taken for idle over a file, a renderer and a band that each take their time", async () => {
    let { renderer } = fakeRenderer([async () => {
      await wait();
      return drawn([11]);
    }, TEXT_PAGE, drawn([null]), TEXT_PAGE, drawn([null])], [async (pdf, document) => {
      await new Response(pdf).arrayBuffer();
      await wait();
      return document();
    }]);
    let { result } = await mixed(IMAGE_FIRST_MIDDLE_LAST, renderer, async () => {
      await wait();
      return eventResponse(tokenEvents(["slow text"]));
    });

    let began = Date.now();
    expect(await pumped(read(result), PACE)).toBe(sheets(fromImage("slow text")));
    expect(Date.now() - began).toBeGreaterThan(3 * WAIT_MS);
    expect(vi.mocked(console.warn)).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends a text whose page the renderer does not answer for a minute, saying which, and lets the document go once it has", async () => {
    let page = deferred<RenderedPage>();
    let { renderer, state } = fakeRenderer([drawn([11]), TEXT_PAGE, () => page.promise, TEXT_PAGE, drawn([51])]);
    let conversion = conversionOf(IMAGE_FIRST_MIDDLE_LAST);
    let { result, bands } = await mixed(conversion.response, renderer);
    let reader = result.text.getReader();
    await pumped(readThrough(reader, "### Page 3\n"));

    let outcome: unknown = "waiting";
    reader.read().then(() => { outcome = "read"; }, (error: unknown) => { outcome = error; });
    await vi.advanceTimersByTimeAsync(TRANSCRIPTION_IDLE_MS - 1);
    expect(outcome).toBe("waiting");
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toEqual(new Error(IDLE));
    expect(linesOf("warn", "google.drive.pdf.transcription_idle")).toEqual([expect.objectContaining({ page: 3 })]);
    // The page being rendered is left to finish, and its document let go only then.
    expect(state.documents[0]!.disposed).toBe(0);
    page.resolve(drawn([31]));
    await vi.advanceTimersByTimeAsync(1);
    expect(state.documents[0]!.disposed).toBe(1);
    expect(bands.map(({ shade }) => shade)).toEqual([11]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives up the band calls in flight when cancelled, then lets the document go, and the conversion at once", async () => {
    let { renderer, state } = fakeRenderer([drawn([11, 12, 13, 14, 15]), TEXT_PAGE, drawn([31]), TEXT_PAGE, drawn([51])]);
    let conversion = conversionOf(IMAGE_FIRST_MIDDLE_LAST);
    let { result, bands } = await mixed(conversion.response, renderer, unanswered(state.events));
    let reader = result.text.getReader();
    await pumped(readThrough(reader, "### Page 1\n"));
    let pending = reader.read();
    while (bands.length < 4) await vi.advanceTimersByTimeAsync(1);

    await reader.cancel("stopped");
    expect((await pending).done).toBe(true);
    expect(conversion.state.cancelled).toBe(true);
    await vi.advanceTimersByTimeAsync(20);
    expect(state.events).toEqual([
      "open", "render 1", "band given up", "band given up", "band given up", "band given up", "disposed",
    ]);
    expect(bands).toHaveLength(4);
    expect(vi.mocked(console.warn)).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("logs no failure when cancelled while the conversion's text is being waited for", async () => {
    let sent = false;
    let json = markdownJson(IMAGE_FIRST_MIDDLE_LAST);
    // The text begins, then the response stalls until it is cancelled.
    let response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) return new Promise<void>(() => {});
        sent = true;
        controller.enqueue(new TextEncoder().encode(json.slice(0, json.indexOf("Berth A"))));
      },
    }, { highWaterMark: 0 }));
    let { renderer, state } = fakeRenderer([drawn([null]), TEXT_PAGE]);
    let { result } = await mixed(response, renderer);
    let reader = result.text.getReader();
    await pumped(readThrough(reader, "sheet A\n"));

    let pending = reader.read();
    await vi.advanceTimersByTimeAsync(1);
    await reader.cancel();
    expect((await pending).done).toBe(true);
    await vi.advanceTimersByTimeAsync(20);
    expect(state.events).toEqual(["open", "render 1", "disposed"]);
    expect(vi.mocked(console.warn)).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each<[string, string, PageAnswer[], string, string[]]>([
    ["with a document open", IMAGE_FIRST_MIDDLE_LAST, [drawn([11]), TEXT_PAGE, drawn([31]), TEXT_PAGE, drawn([51])],
      "### Page 5\n", ["open", "render 1", "render 3", "disposed"]],
    ["with none opened yet", `${PREAMBLE}### Page 1\nText\n\n\n\n### Page 2\n\n\n`, [TEXT_PAGE, drawn([21])], "### Page 2\n", []],
  ])("begins nothing for a last page without text when cancelled once the response has arrived whole but not ended, %s", async (_label, markdown, pages, heading, events) => {
    let sent = false;
    // The whole response arrives at once, and then does not end until it is cancelled.
    let response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) return new Promise<void>(() => {});
        sent = true;
        controller.enqueue(new TextEncoder().encode(markdownJson(markdown)));
      },
    }, { highWaterMark: 0 }));
    let { renderer, state } = fakeRenderer(pages);
    let { result, asked } = await mixed(response, renderer);
    let reader = result.text.getReader();
    await pumped(readThrough(reader, heading));

    let pending = reader.read();
    await vi.advanceTimersByTimeAsync(1);
    await reader.cancel();
    expect((await pending).done).toBe(true);
    await vi.advanceTimersByTimeAsync(20);
    // The last page is neither rendered nor is the file read for it.
    expect(state.events).toEqual(events);
    expect(asked).toEqual(events.length > 0 ? [whole(SCAN)] : []);
    expect(vi.mocked(console.warn)).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("opens nothing for a text that is cancelled unread, and lets the conversion go", async () => {
    let { renderer, state } = fakeRenderer([drawn([11])]);
    let conversion = conversionOf(IMAGE_FIRST_MIDDLE_LAST);
    let { result, asked } = await mixed(conversion.response, renderer);
    await result.text.cancel();
    await vi.advanceTimersByTimeAsync(20);
    expect(conversion.state.cancelled).toBe(true);
    expect([asked, state.events]).toEqual([[], []]);
    expect(vi.getTimerCount()).toBe(0);
    expect(vi.mocked(console.warn)).not.toHaveBeenCalled();
  });

  it("leaves no timer behind when read to its end or failed", async () => {
    let ended = await mixed(IMAGE_FIRST_MIDDLE_LAST, fakeRenderer([drawn([11]), TEXT_PAGE, drawn([31]), TEXT_PAGE, drawn([51])]).renderer);
    expect(await pumped(read(ended.result))).toBe(sheets(fromImage("band 11"), fromImage("band 31"), fromImage("band 51")));
    expect(vi.getTimerCount()).toBe(0);

    let failed = await mixed(IMAGE_FIRST_MIDDLE_LAST, fakeRenderer([drawn([11])], ["size-mismatch"]).renderer);
    expect((await pumped(readToFailure(failed.result))).error).toEqual(new Error(FILE_CHANGED));
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("pdfConverter", () => {
  it("has nothing to convert with in a Worker without the AI binding", () => {
    expect(pdfConverter({})).toBeUndefined();
    expect(pdfConverter({ PDF_OCR: "true" })).toBeUndefined();
  });

  it.each([[undefined], [""], ["true"], ["off"], ["0"]])("transcribes a scan, through the gateway named, with PDF_OCR %j", async value => {
    let { ai, sent, images } = ocrAi();
    let { asked, readRange } = ranges(SCAN);
    let convert = pdfConverter({ AI: ai, CF_AI_GATEWAY: "team-gateway", ...(value === undefined ? {} : { PDF_OCR: value }) })!;

    let result = await convert(byteStream(SCAN.bytes).stream, readRange);
    expect(result).toMatchObject({ hasText: false, transcribed: true, rereads: true });
    expect(await read(result)).toBe(TRANSCRIBED);
    expect(asked).toHaveLength(3);
    expect(images()).toHaveLength(3);
    expect(sent.every(({ json }) => (json.options as { gateway?: { id: string } }).gateway?.id === "team-gateway")).toBe(true);
  });

  it.each([["false"], [" False "], ["FALSE"]])("reads nothing again and calls no model with PDF_OCR %j: a scan comes back empty", async value => {
    let { ai, images } = ocrAi();
    let { asked, readRange } = ranges(SCAN);
    let { renderer, state } = fakeRenderer([drawn([11])]);
    let convert = pdfConverter({ AI: ai, PDF_RENDERER: renderer, PDF_OCR: value })!;

    let result = await convert(byteStream(SCAN.bytes).stream, readRange);
    expect(result).toEqual({ text: expect.any(ReadableStream), hasText: false, transcribed: false, rereads: false });
    expect(await read(result)).toBe("");
    expect([asked, images(), state.events]).toEqual([[], [], []]);
  });

  it("returns a PDF with text as that text alone with PDF_OCR false, its pages without text unread", async () => {
    let { ai, images } = bandAi(undefined, IMAGE_FIRST_MIDDLE_LAST);
    let { asked, readRange } = ranges(SCAN);
    let { renderer, state } = fakeRenderer([drawn([11])]);
    let convert = pdfConverter({ AI: ai, PDF_RENDERER: renderer, PDF_OCR: "false" })!;

    let result = await convert(byteStream(SCAN.bytes).stream, readRange);
    expect(result).toMatchObject({ hasText: true, transcribed: false, rereads: false });
    expect(await read(result)).toBe(sheets().slice("### Page 1\n\n\n\n\n".length));
    expect([asked, images(), state.events]).toEqual([[], [], []]);
  });

  it("renders with the Worker's renderer when it has one", async () => {
    let { ai } = bandAi();
    let { renderer, state } = fakeRenderer([drawn([11])]);
    let result = await pdfConverter({ AI: ai, PDF_RENDERER: renderer })!(
      byteStream(SCAN.bytes).stream, ranges(SCAN).readRange);
    expect(await read(result)).toBe("### Page 1\nband 11");
    expect(state.events).toEqual(["open", "render 1", "disposed"]);
  });
});

const GMAIL_CONVERSION_FAILED = "The Gmail attachment could not be converted from PDF.";
const GMAIL_TRANSCRIPTION_FAILED = "The Gmail attachment's PDF could not be transcribed.";
const GMAIL_CHANGED = "The Gmail attachment changed while it was being read; read it again.";
/** What every line logged of a Gmail attachment's PDF carries. */
const GMAIL_COMPONENT = { component: "gatekeeper.google.gmail.pdf", vendorId: "google" };

/** `pdf` converted as a Gmail attachment, with `renderer` there to render it when one is given. */
function gmailPdf(ai: AiFetcher, pdf = SCAN, renderer?: PdfRendering) {
  return pdfToText(
    ai, undefined, byteStream(pdf.bytes, [65_536]).stream, ranges(pdf).readRange, renderer, GMAIL_PDF);
}

describe("pdfToText reading a Gmail attachment", () => {
  it("fails a conversion in Gmail's words, logged under Gmail's names", async () => {
    let { ai } = fakeAi(streamedResponse(conversionJson({ format: "error", error: PROVIDER_ERROR })));
    await expect(pdfToText(ai, undefined, byteStream(BYTES).stream, undefined, undefined, GMAIL_PDF))
      .rejects.toThrow(new Error(GMAIL_CONVERSION_FAILED));
    expect(vi.mocked(console.warn).mock.calls).toEqual([[expect.objectContaining({
      ...GMAIL_COMPONENT, event: "google.gmail.pdf.failed", message: "Workers AI failed to convert a PDF",
      pdfBytes: BYTES.byteLength,
    })]]);
  });

  it("refuses in Gmail's words a conversion that answered before the PDF had all been sent", async () => {
    let ai = {
      fetch: async () => streamedResponse(markdownJson(SCANNED_PDF)),
    } as unknown as AiFetcher;
    let pdf = byteStream(SCAN.bytes, [100]);
    await expect(pdfToText(ai, undefined, pdf.stream, ranges(SCAN).readRange, undefined, GMAIL_PDF))
      .rejects.toThrow(new Error(GMAIL_CONVERSION_FAILED));
    expect(pdf.state.cancelled).toBe(true);
  });

  it.each([
    ["given as the conversion gives it, with no renderer there", false],
    ["read page by page, with a renderer there for its pages without text", true],
  ])("fails in Gmail's words a text whose conversion breaks off once it began: %s", async (_label, rendered) => {
    let json = markdownJson(TEXT_PDF);
    let { ai } = fakeAi(streamedResponse(json.slice(0, json.indexOf("Page 2")), 16));
    let result = await gmailPdf(ai, SCAN, rendered ? fakeRenderer([TEXT_PAGE, TEXT_PAGE]).renderer : undefined);
    // Only a text that is read page by page may read the file again.
    expect(result).toMatchObject({ hasText: true, transcribed: false, rereads: rendered });
    expect((await readToFailure(result)).error).toEqual(new Error(GMAIL_CONVERSION_FAILED));
    expect(vi.mocked(console.warn).mock.calls).toEqual([[expect.objectContaining({
      ...GMAIL_COMPONENT, event: "google.gmail.pdf.failed", message: "Workers AI failed to convert a PDF",
    })]]);
  });

  it("fails a transcription in Gmail's words, logged under Gmail's names", async () => {
    let refused = new Response(JSON.stringify({ internalCode: 8006 }), { status: 400 });
    let result = await gmailPdf(ocrAi([PAGES[0]!, refused]).ai);
    expect(await readToFailure(result)).toEqual({
      text: "### Page 1\nHarbour Ledger Review", error: new Error(GMAIL_TRANSCRIPTION_FAILED),
    });
    expect(vi.mocked(console.warn).mock.calls).toEqual([[expect.objectContaining({
      ...GMAIL_COMPONENT, event: "google.gmail.pdf.transcription_failed",
      message: "a Gmail PDF attachment page could not be transcribed", page: 2, httpStatus: 400,
    })]]);
  });

  it("fails the text as a changed attachment when the renderer was sent other than the file's size", async () => {
    let { renderer } = fakeRenderer([drawn([11])], ["size-mismatch"]);
    let result = await gmailPdf(bandAi().ai, SCAN, renderer);
    expect(await readToFailure(result)).toEqual({ text: "", error: new Error(GMAIL_CHANGED) });
  });

  it("logs a conversion, a transcription and its pages under Gmail's names", async () => {
    expect(await read(await gmailPdf(ocrAi().ai))).toBe(TRANSCRIBED);
    expect(vi.mocked(console.info).mock.calls.map(([line]) => line)).toEqual([
      expect.objectContaining({
        ...GMAIL_COMPONENT, event: "google.gmail.pdf.converted", message: "converted a Gmail PDF attachment",
        pdfBytes: SCAN.bytes.byteLength, hasText: false,
      }),
      expect.objectContaining({
        ...GMAIL_COMPONENT, event: "google.gmail.pdf.transcribing",
        message: "transcribing a scanned Gmail PDF attachment", ocrPages: 3, route: "stored",
      }),
      ...[1, 2, 3].map(page => expect.objectContaining({
        ...GMAIL_COMPONENT, event: "google.gmail.pdf.page_transcribed",
        message: "transcribed a Gmail PDF attachment page", page,
      })),
    ]);
    expect(vi.mocked(console.warn)).not.toHaveBeenCalled();
  });

  it("converts as a Gmail attachment's the PDFs of a converter made for Gmail", async () => {
    let { ai } = fakeAi(() => streamedResponse(conversionJson({ format: "error", error: PROVIDER_ERROR })));
    await expect(pdfConverter({ AI: ai }, GMAIL_PDF)!(byteStream(BYTES).stream))
      .rejects.toThrow(new Error(GMAIL_CONVERSION_FAILED));
    await expect(pdfConverter({ AI: ai })!(byteStream(BYTES).stream)).rejects.toThrow(new Error(CONVERSION_FAILED));
  });

  it("names Drive in nothing it logs or fails with", async () => {
    /** What each text failed with, or was refused with. */
    let said: unknown[] = [];
    let failure = async (result: Promise<{ text: ReadableStream<Uint8Array> }>) => {
      said.push(await result.then(async given => (await readToFailure(given)).error, (error: unknown) => error));
    };
    let refused = new Response(JSON.stringify({ internalCode: 8006 }), { status: 400 });
    let failing = fakeAi(streamedResponse('{"errors":[{"code":6006}],"success":false}', 7, 400)).ai;

    // A conversion that fails; a scan sent as stored, whose last page the model fails on; an
    // encrypted one; a scan whose second page cannot be drawn, lost at its third and of another
    // size when opened again; one the renderer has no room for, read as stored; and one it
    // cannot read, whose pages are not read as stored.
    await failure(pdfToText(failing, undefined, byteStream(BYTES).stream, undefined, undefined, GMAIL_PDF));
    await failure(gmailPdf(ocrAi([PAGES[0]!, PAGES[1]!, refused]).ai));
    await failure(gmailPdf(ocrAi().ai, imagePdf([scanPage(1)], { trailer: "/Encrypt 9 0 R" })));
    await failure(gmailPdf(bandAi().ai, SCAN, fakeRenderer(
      [drawn([11, 12]), refusedAs("memory", true), refusedAs("released")], [undefined, "size-mismatch"]).renderer));
    await failure(gmailPdf(bandAi().ai, SCAN, fakeRenderer([drawn([11])], ["room"]).renderer));
    await failure(gmailPdf(bandAi().ai, FAX_SCAN, fakeRenderer([drawn([11])], ["unreadable"]).renderer));
    // Scans refused for what they are: stored as fax, and with no page image, where there is no
    // renderer; and one the renderer finds encrypted.
    await failure(gmailPdf(ocrAi().ai, FAX_SCAN));
    await failure(gmailPdf(ocrAi().ai, imagePdf([scanPage(1, { width: 64, height: 64 })])));
    await failure(gmailPdf(bandAi().ai, SCAN, fakeRenderer([], ["encrypted"]).renderer));

    let pages = [drawn([11]), TEXT_PAGE, drawn([31, 32]), TEXT_PAGE, drawn([51])];
    /** A PDF with text and pages without any, read with a renderer there. */
    let withText = (renderer = fakeRenderer(pages).renderer, answer?: Parameters<typeof bandAi>[0]) =>
      gmailPdf(bandAi(answer, IMAGE_FIRST_MIDDLE_LAST).ai, SCAN, renderer);
    // A PDF whose pages without text are read from their images: to its end; the renderer with
    // no room for it; a page's render refusing the PDF as a whole; and the model failing on a
    // band. None of them fails: the last three keep the document's own text.
    await failure(withText());
    await failure(withText(fakeRenderer([], ["room"]).renderer));
    await failure(withText(fakeRenderer([drawn([11]), TEXT_PAGE, refusedAs("empty-work")]).renderer));
    await failure(withText(undefined, ({ shade }) =>
      shade === 32 ? new Response(JSON.stringify({ internalCode: 8006 }), { status: 400 }) : [`band ${shade}`]));
    // And a scan's text, and such a PDF's, that sit unread for a minute.
    vi.useFakeTimers();
    let idle = [await gmailPdf(ocrAi().ai), await withText()];
    await vi.advanceTimersByTimeAsync(TRANSCRIPTION_IDLE_MS);
    for (let text of idle) await failure(Promise.resolve(text));

    expect(said.map(error => (error as Error | undefined)?.message)).toEqual([
      GMAIL_CONVERSION_FAILED, GMAIL_TRANSCRIPTION_FAILED, ENCRYPTED, GMAIL_CHANGED, undefined,
      GMAIL_TRANSCRIPTION_FAILED,
      expect.stringContaining(unread("fax (CCITT)")),
      expect.stringContaining("which is not available on this deployment"), ENCRYPTED,
      undefined, undefined, undefined, undefined,
      IDLE, IDLE,
    ]);
    let lines = [console.info, console.warn].flatMap(log => vi.mocked(log).mock.calls)
      .map(([line]) => line as Record<string, string>);
    // Every kind of line the reader logs is among them, each under Gmail's component.
    expect([...new Set(lines.map(({ event }) => event))].toSorted()).toEqual([
      "band_transcribed", "converted", "failed", "page_rendered", "page_transcribed", "page_undrawn",
      "render_failed", "renderer_fallback", "rendering", "transcribing", "transcription_failed",
      "transcription_idle", "untranscribable",
    ].map(kind => `google.gmail.pdf.${kind}`));
    expect(lines.every(({ component }) => component === GMAIL_COMPONENT.component)).toBe(true);
    // A line that carries an error carries its stack, whose frames name the files of this
    // package, the reader's own among them: none of these lines does.
    expect(lines.some(line => "errorStack" in line)).toBe(false);
    expect(JSON.stringify([lines, said.map(String)])).not.toMatch(/drive/i);
  });
});

/** A file that is only read from its start: `pdf`, handed out by `pull`, and what each open was for. */
function forwardOnly(pdf: BuiltPdf, pull: (at: number) => Uint8Array | Promise<Uint8Array>) {
  let opens: { purpose: Parameters<PdfOpener>[0]; cancelled: boolean }[] = [];
  let open: PdfOpener = async purpose => {
    let opened = { purpose, cancelled: false };
    opens.push(opened);
    let at = 0;
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (at >= pdf.bytes.byteLength) return controller.close();
        let chunk = await pull(at);
        at += chunk.byteLength;
        controller.enqueue(chunk);
      },
      cancel() { opened.cancelled = true; },
    }, { highWaterMark: 0 });
  };
  return { open, opens };
}

describe("pdfToText reading a file that is only read from its start", () => {
  it("transcribes a scan sent as stored through one pass over the file", async () => {
    let { ai, images } = ocrAi();
    let { open, opens } = forwardOnly(SCAN, at => SCAN.bytes.slice(at, at + 100));
    let { readRange, release } = forwardRangeReader(open, GMAIL_PDF);

    let result = await pdfToText(ai, undefined, byteStream(SCAN.bytes, [333]).stream, readRange, undefined, GMAIL_PDF);
    expect(result).toMatchObject({ hasText: false, transcribed: true, rereads: true });
    // The file is not opened until the text is read.
    expect(opens).toEqual([]);
    expect(await read(result)).toBe(TRANSCRIBED);

    expect(images().map(request => sentImage(request))).toEqual(SCAN.images.map(({ offset, length }) => ({
      mimeType: "image/jpeg", bytes: SCAN.bytes.slice(offset, offset + length),
    })));
    expect(opens).toEqual([{ purpose: { page: 1, again: false }, cancelled: false }]);
    release();
    expect(opens[0]!.cancelled).toBe(true);
    expect(vi.mocked(console.warn)).not.toHaveBeenCalled();
  });

  it("does not take a long way to a page image for a text that sits idle", async () => {
    vi.useFakeTimers();
    let { ai } = ocrAi();
    // Thirteen seconds a piece, under what a pass is taken to have stalled at: the first page
    // image is five pieces in, which is more than the minute a text may sit idle.
    let { open, opens } = forwardOnly(SCAN, async at => {
      await new Promise(resolve => setTimeout(resolve, 13_000));
      return SCAN.bytes.slice(at, at + 100);
    });
    expect(SCAN.images[0]!.offset).toBeGreaterThan(400);
    let { readRange } = forwardRangeReader(open, GMAIL_PDF);

    let result = await pdfToText(ai, undefined, byteStream(SCAN.bytes).stream, readRange, undefined, GMAIL_PDF);
    expect(await pumped(read(result), { step: 1000, realMs: 1 })).toBe(TRANSCRIBED);
    expect(opens).toHaveLength(1);
    expect(vi.mocked(console.warn)).not.toHaveBeenCalled();
  });
});
