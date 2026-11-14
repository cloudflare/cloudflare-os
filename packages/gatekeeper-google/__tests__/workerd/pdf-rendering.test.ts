import { env } from "cloudflare:test";
import type { PdfRendering, RenderedBand } from "@gadgets/pdf-renderer/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pdfToText, type PdfRangeReader } from "../../src/drive-pdf";
import { READ_AHEAD } from "../../src/pdf-read-ahead";
import { faxMarks, imagePdf } from "../pdf-fixture";
import {
  byteStream, eventResponse, fakeAi, markdownJson, sentImage, streamedResponse, tokenEvents,
} from "../workers-ai-fixture";

// A scanned PDF read through the renderer Worker as a deployment binds it: the file streamed
// over the service binding to the renderer's own entrypoint, its pages drawn by the PDFium build,
// and the document held and let go across the binding. Only the model is a fake. The pool's
// Worker exports the renderer, so it shares the tests' console.

/** The renderer, by the binding the gatekeeper is given. */
const RENDERER = env.PDF_RENDERER as unknown as PdfRendering;
/** A two-page scan stored as fax, each page the same marks. */
const SCAN = imagePdf([faxMarks(), faxMarks()]);
/** What Workers AI's conversion answers for a PDF with no text of its own. */
const SCANNED_MARKDOWN = "# file.pdf\n## Contents\n### Page 1\n\n\n\n\n### Page 2\n\n\n";
/** What it answers for a PDF whose first page has text and whose second has none. */
const MIXED_MARKDOWN = "# file.pdf\n## Contents\n### Page 1\nCover sheet of the ledger\n\n\n\n### Page 2\n\n\n";

/** The rows a grey PNG holds, inflated, without their filter bytes. */
async function pngRows(png: Uint8Array): Promise<{ width: number; rows: Uint8Array }> {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const width = view.getUint32(16), height = view.getUint32(20);
  expect([png[24], png[25]]).toEqual([8, 0]);
  const data: Uint8Array[] = [];
  for (let at = 8; at < png.byteLength; at += 12 + view.getUint32(at)) {
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    if (type === "IDAT") data.push(png.subarray(at + 8, at + 8 + view.getUint32(at)));
  }
  const inflated = new Blob(data).stream().pipeThrough(new DecompressionStream("deflate"));
  const filtered = new Uint8Array(await new Response(inflated).arrayBuffer());
  expect(filtered.byteLength).toBe(height * (width + 1));
  const rows = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    rows.set(filtered.subarray(y * (width + 1) + 1, (y + 1) * (width + 1)), y * width);
  }
  return { width, rows };
}

/**
 * How long a wait on the renderer may take. The first PDF opened in a run makes the PDFium
 * instance ready, and on a busy machine that alone takes longer than the second a wait is given
 * unless it says otherwise.
 */
const RENDERER_WAIT = { timeout: 10_000 };

/** Whether `a` and `b` hold the same bytes. */
function same(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && a.every((byte, i) => byte === b[i]);
}

/**
 * The bands of page 1 of {@link SCAN} as the renderer cuts it when asked as the reader asks, and
 * the page's width. The document it is asked of has been let go, and the renderer has said so,
 * by the time this returns.
 */
async function firstPageBands(): Promise<{ width: number; bands: RenderedBand[] }> {
  const before = released();
  // A document that an earlier test let go may not have given its room back yet.
  const opened = await vi.waitFor(async () => {
    const answer = await RENDERER.open(byteStream(SCAN.bytes).stream, SCAN.bytes.byteLength);
    if ("refused" in answer) throw new Error(`The PDF was refused (${answer.refused}).`);
    return answer;
  }, RENDERER_WAIT);
  const page = await opened.document.renderPage(0, { bands: 4, denseLines: 14 });
  opened.document[Symbol.dispose]();
  await vi.waitFor(() => expect(released()).toBe(before + 1), RENDERER_WAIT);
  if ("refused" in page) throw new Error(`The page was refused (${page.refused}).`);
  return { width: page.width, bands: page.bands };
}

/**
 * A model that converts every PDF to `markdown`, which has no text unless given, and reads each
 * band as its place among `bands`, from 1. `sent` are those places, in the order the bands'
 * requests were read. No band is answered until `together` of them have been sent.
 */
function bandModel(page: { width: number; bands: RenderedBand[] }, markdown = SCANNED_MARKDOWN, together = 0) {
  const sent: number[] = [];
  let allSent!: () => void;
  const all = new Promise<void>(resolve => { allSent = resolve; });
  const { ai } = fakeAi(request => {
    if (request.url.includes("markdown")) return streamedResponse(markdownJson(markdown), 64);
    const { mimeType, bytes } = sentImage(request);
    expect(mimeType).toBe("image/png");
    const answer = pngRows(bytes).then(({ width, rows }) => {
      expect(width).toBe(page.width);
      const place = page.bands.findIndex(band => band.pixels !== undefined && same(band.pixels, rows)) + 1;
      sent.push(place);
      if (sent.length >= together) allSent();
      return all.then(() => eventResponse(tokenEvents([`band ${place}`])));
    });
    // The fake binding awaits what it is given.
    return answer as unknown as Response;
  });
  return { ai, sent };
}

/** A reader of {@link SCAN} that notes the ranges asked of it. */
function ranges() {
  const asked: { page?: number; offset: number; length: number }[] = [];
  const readRange: PdfRangeReader = async ({ page, offset, length }) => {
    asked.push({ ...(page === undefined ? {} : { page }), offset, length });
    return byteStream(SCAN.bytes.slice(offset, offset + length), [4096]).stream;
  };
  return { asked, readRange };
}

/** A line of a log, as far as these tests read one. */
type LogLine = { event?: string; releasedBy?: string };
/** What the gatekeeper and the renderer have logged since the test began, by level. */
let logs: { info: LogLine[]; warn: LogLine[] };
/** How many pages may be begun and not yet given, before a test sets it. */
const PAGES_AHEAD = READ_AHEAD.pages;

/** How often the renderer has said that it gave a PDF's room back because its document was disposed. */
function released(): number {
  return logs.info.filter(({ event, releasedBy }) =>
    event === "pdf-renderer.released" && releasedBy === "disposed").length;
}

beforeEach(() => {
  logs = { info: [], warn: [] };
  vi.spyOn(console, "info").mockImplementation((line: LogLine) => { logs.info.push(line); });
  vi.spyOn(console, "warn").mockImplementation((line: LogLine) => { logs.warn.push(line); });
});

afterEach(() => {
  READ_AHEAD.pages = PAGES_AHEAD;
  vi.restoreAllMocks();
});

describe("pdfToText with the renderer Worker behind its binding", () => {
  it("renders a scan's pages, sends each band the renderer cut and puts their texts together", async () => {
    const page = await firstPageBands();
    expect(page.bands.filter(band => band.pixels).length).toBeGreaterThan(1);
    const before = released();
    const { ai, sent } = bandModel(page);
    const { asked, readRange } = ranges();

    const result = await pdfToText(ai, undefined, byteStream(SCAN.bytes).stream, readRange, RENDERER);
    expect(result).toMatchObject({ hasText: false, transcribed: true, rereads: true });
    expect(asked).toEqual([]);
    const inked = page.bands.flatMap((band, i) => band.pixels ? [i + 1] : []);
    const text = inked.map(place => `band ${place}`).join("\n");
    expect(await new Response(result.text).text()).toBe(`### Page 1\n${text}\n\n### Page 2\n${text}`);

    expect(asked).toEqual([{ offset: 0, length: SCAN.bytes.byteLength }]);
    // Every band that has pixels was sent, once for each page, as the rows the renderer gave.
    expect(sent.toSorted()).toEqual([...inked, ...inked].toSorted());
    // The document was let go across the binding, once.
    await vi.waitFor(() => expect(released()).toBe(before + 1), RENDERER_WAIT);
    expect(logs.warn).toEqual([]);
  });

  it("has the bands of both pages before the model before the first page is given, and gives the pages in their order", async () => {
    const page = await firstPageBands();
    const inked = page.bands.flatMap((band, i) => band.pixels ? [i + 1] : []);
    const before = released();
    // No band is answered until those of both pages have been sent.
    const { ai, sent } = bandModel(page, SCANNED_MARKDOWN, 2 * inked.length);
    const { asked, readRange } = ranges();

    const result = await pdfToText(ai, undefined, byteStream(SCAN.bytes).stream, readRange, RENDERER);
    const text = inked.map(place => `band ${place}`).join("\n");
    expect(await new Response(result.text).text()).toBe(`### Page 1\n${text}\n\n### Page 2\n${text}`);

    expect(sent.toSorted()).toEqual([...inked, ...inked].toSorted());
    expect(asked).toEqual([{ offset: 0, length: SCAN.bytes.byteLength }]);
    await vi.waitFor(() => expect(released()).toBe(before + 1), RENDERER_WAIT);
    expect(logs.warn).toEqual([]);
  });

  it("lets the document go across the binding when the text is cancelled partway", async () => {
    // No page is begun ahead, so that the second is not drawn, and the document let go, first.
    READ_AHEAD.pages = 1;
    const page = await firstPageBands();
    const before = released();
    const { ai, sent } = bandModel(page);
    const { asked, readRange } = ranges();

    const result = await pdfToText(ai, undefined, byteStream(SCAN.bytes).stream, readRange, RENDERER);
    const reader = result.text.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("### Page 1\nband 1");
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(released()).toBe(before);

    await reader.cancel();
    await vi.waitFor(() => expect(released()).toBe(before + 1), RENDERER_WAIT);
    // The second page was never rendered or sent.
    expect(sent).toHaveLength(page.bands.filter(band => band.pixels).length);
    expect(asked).toHaveLength(1);
    expect(logs.info.filter(({ event }) => event === "pdf-renderer.page_rendered")).toHaveLength(2);
  });

  it("reads the page without text of a PDF that has text from its image, into the PDF's own text", async () => {
    const page = await firstPageBands();
    const before = released();
    const { ai, sent } = bandModel(page, MIXED_MARKDOWN);
    const { asked, readRange } = ranges();

    const result = await pdfToText(ai, undefined, byteStream(SCAN.bytes).stream, readRange, RENDERER);
    expect(result).toMatchObject({ hasText: true, transcribed: false, rereads: true });
    expect(asked).toEqual([]);
    const inked = page.bands.flatMap((band, i) => band.pixels ? [i + 1] : []);
    expect(await new Response(result.text).text()).toBe(
      "### Page 1\nCover sheet of the ledger\n\n\n\n### Page 2\n" +
      "[This page has no text of its own: what follows was read from its image by a vision model, which can misread.]" +
      `\n\n${inked.map(place => `band ${place}`).join("\n")}\n\n`);

    // The file was read whole once, only its second page was rendered, and each of that page's
    // bands sent as the rows the renderer gave.
    expect(asked).toEqual([{ offset: 0, length: SCAN.bytes.byteLength }]);
    expect(logs.info.filter(({ event }) => event === "pdf-renderer.page_rendered")).toHaveLength(2);
    expect(sent.toSorted()).toEqual(inked);
    // The document was let go across the binding, once.
    await vi.waitFor(() => expect(released()).toBe(before + 1), RENDERER_WAIT);
    expect(logs.warn).toEqual([]);
  });

  it("fails the text as a changed file when the file read again is not the size it was", async () => {
    const page = await firstPageBands();
    const { ai, sent } = bandModel(page);
    const result = await pdfToText(ai, undefined, byteStream(SCAN.bytes).stream,
      async () => byteStream(SCAN.bytes.slice(0, -1), [4096]).stream, RENDERER);
    await expect(new Response(result.text).text())
      .rejects.toThrow("The Drive file changed while it was being read; read it again.");
    expect(sent).toEqual([]);
  });
});
