import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HOLD_IDLE_MS, RENDER_LIMITS, type PdfRendering, type RenderRefused } from "../../src/api";
import { pdfiumModules } from "../../src/pdfium-module";
import { pdfRenderer } from "../../src/renderer";
import { PdfRenderer } from "../../src/worker";
import { bitsImage, encryptedPdf, faxPdf, onePage, scannedPdf } from "../pdf-render-fixture";

// The Worker called as another Worker calls it: through a service binding to its entrypoint, so
// that the stream, the document's stub, its disposal and every answer cross the binding. The
// pool's Worker is the renderer itself, and it shares the tests' clock, console and modules.

/** How many of the fixture's PDFs an isolate has room for: each is charged a page's pixels besides its file. */
const ROOM_FOR = 8;

/**
 * `bytes` as a stream that is fed `chunk` of them at a time, each when the one before it was
 * taken. `taken` says whether all of them were, or the stream was let go of first.
 */
function streamOf(bytes: Uint8Array, chunk = 4096) {
  let { readable, writable } = new IdentityTransformStream();
  let writer = writable.getWriter();
  let feed = async () => {
    for (let at = 0; at < bytes.byteLength; at += chunk) await writer.write(bytes.subarray(at, at + chunk));
    await writer.close();
  };
  return { stream: readable as ReadableStream<Uint8Array>, taken: feed().then(() => true, () => false) };
}

/** The answer to opening `pdf` as `size` bytes, which is its own size unless given. */
function answerTo(pdf: Uint8Array, size = pdf.byteLength) {
  return env.PDF_RENDERER.open(streamOf(pdf).stream, size);
}

/** What the tests opened: disposed after each, since a PDF left open keeps its room from the next test. */
let left: Disposable[] = [];

/**
 * `pdf` opened, over the binding unless by `renderer`. A dispose reaches the renderer some time
 * after it is sent, so an open that finds no room is tried again until what earlier tests let go
 * of has been given back.
 */
function opened(pdf: Uint8Array, renderer: PdfRendering = env.PDF_RENDERER) {
  return vi.waitFor(async () => {
    let answer = await renderer.open(streamOf(pdf).stream, pdf.byteLength);
    if ("refused" in answer) throw new Error(`The PDF was refused (${answer.refused}).`);
    left.push(answer.document);
    return answer;
  }, { timeout: 5000 });
}

/** `answer` when it is a page: a refusal fails the test. */
function rendered<T extends object>(answer: T): Exclude<T, { refused: unknown }> {
  if ("refused" in answer) throw new Error(`The page was refused (${String(answer.refused)}).`);
  return answer as Exclude<T, { refused: unknown }>;
}

/** What `call` rejects with, as its name and message, which are what cross the binding of an error. */
function thrown(call: PromiseLike<unknown>): Promise<string | undefined> {
  return Promise.resolve(call).then(() => undefined, (error: Error) => `${error.name}: ${error.message}`);
}

/** More bytes than the binding takes of a stream nobody reads. */
const UNREAD = new Uint8Array(8 * 1024 * 1024);

/** A refusal that reached no instance. */
function unstarted(refused: RenderRefused["refused"]): RenderRefused {
  return { refused, ofPage: false, heapBytes: 0, work: 0 };
}

/** A page whose one image declares more pixels than a page's images may. */
function oversizedPage() {
  let image = bitsImage();
  return onePage({ ...image, dict: image.dict.replace("/Width 96 /Height 64", "/Width 65535 /Height 65535") });
}

/** A line of the Worker's log, by what every line has. */
type LogLine = { component: string; event: string; message: string };

/** The lines the Worker logs from here to the end of the test, in the order it logs them. */
function logLines(): LogLine[] {
  let lines: LogLine[] = [];
  for (let level of ["info", "warn"] as const) {
    vi.spyOn(console, level).mockImplementation((line: LogLine) => { lines.push(line); });
  }
  return lines;
}

/** The line that says `event` with `fields`, and with nothing else. */
function logLine(event: string, fields: object): LogLine {
  return { component: "pdf-renderer", event: `pdf-renderer.${event}`, message: expect.any(String) as string, ...fields };
}

/** The lines of `lines` that say a PDF's room was given back. */
function givenBack(lines: LogLine[]): LogLine[] {
  return lines.filter(line => line.event === "pdf-renderer.released");
}

afterEach(() => {
  vi.restoreAllMocks();
  for (let document of left.splice(0)) document[Symbol.dispose]();
});

describe("the entrypoint, over a service binding", () => {
  it("opens a PDF from a stream, a few bytes at a time, and renders its page as the renderer does", async () => {
    let pdf = scannedPdf([onePage(bitsImage()), { images: [], content: "" }]);
    let answer = await env.PDF_RENDERER.open(streamOf(pdf, 100).stream, pdf.byteLength);
    if ("refused" in answer) throw new Error(`The PDF was refused (${answer.refused}).`);
    left.push(answer.document);
    expect(answer.pages).toBe(2);
    let page = rendered(await answer.document.renderPage(0, { bands: 1 }));
    // The same page from a renderer of the test's own, which no binding is between.
    let hold = pdfRenderer(await pdfiumModules()).hold(pdf.byteLength);
    hold.fill(pdf, 0);
    let direct = hold.renderPage(0, { bands: 1 });
    hold.release();
    expect([page.width, page.height, page.bands.length]).toEqual([200, 133, 1]);
    expect(page.bands[0]!.pixels).toBeInstanceOf(Uint8Array);
    expect({ ...page, cost: undefined }).toEqual({ ...direct, cost: undefined });
    expect(page.cost.work).toBe(direct.cost.work);
    // A band with nothing on it comes without pixels.
    expect(await answer.document.renderPage(1, { bands: 1 })).toMatchObject({
      blank: true, bands: [{ top: 0, rows: 133, ink: 0 }],
    });
  });

  it("answers what it refuses a PDF for as a value, and keeps no room for it", async () => {
    let pdf = faxPdf();
    let notPdf = new TextEncoder().encode("not a PDF at all");
    let empty = streamOf(UNREAD), large = streamOf(UNREAD);
    // A size that is never rendered is refused before a byte is read, and the stream let go.
    expect(await env.PDF_RENDERER.open(empty.stream, 0)).toEqual(unstarted("file-size"));
    expect(await env.PDF_RENDERER.open(large.stream, RENDER_LIMITS.fileBytes + 1)).toEqual(unstarted("file-size"));
    expect([await empty.taken, await large.taken]).toEqual([false, false]);
    // A stream that ends short of its size, and one that goes past it.
    expect(await answerTo(pdf, pdf.byteLength + 1)).toEqual(unstarted("size-mismatch"));
    expect(await answerTo(pdf, pdf.byteLength - 1)).toEqual(unstarted("size-mismatch"));
    expect(await answerTo(notPdf)).toMatchObject({ refused: "unreadable", ofPage: false });
    expect(await answerTo(encryptedPdf())).toMatchObject({ refused: "encrypted", ofPage: false });
    let tooMany = scannedPdf(Array.from({ length: RENDER_LIMITS.pages + 1 }, () => ({ images: [], content: "" })));
    let counted = await answerTo(tooMany);
    expect(counted).toMatchObject({ refused: "page-count", ofPage: false });
    // What opening it cost is said with the refusal.
    expect((counted as RenderRefused).work).toBeGreaterThan(0);
    expect((counted as RenderRefused).heapBytes).toBeGreaterThan(0);
    // A PDF whose pages could not be counted is refused whole, though for a reason that is of a
    // page when a page is asked for: here, with less work allowed than opening it takes.
    let work = RENDER_LIMITS.work;
    RENDER_LIMITS.work = 1000;
    try {
      expect(await answerTo(pdf)).toMatchObject({ refused: "work", ofPage: false, work: 1000 });
    } finally {
      RENDER_LIMITS.work = work;
    }
    // None of them holds anything: as many PDFs as ever fit.
    for (let n = 0; n < ROOM_FOR; n++) expect((await opened(pdf)).pages).toBe(1);
  });

  it("throws a failure of the stream itself, and keeps no room for it", async () => {
    let pdf = faxPdf();
    let { readable, writable } = new IdentityTransformStream();
    let writer = writable.getWriter();
    let failed = writer.write(pdf.subarray(0, 100)).then(() => writer.abort(new Error("the read failed")));
    expect(await thrown(env.PDF_RENDERER.open(readable, pdf.byteLength))).toMatch(/^Error: /);
    await failed;
    for (let n = 0; n < ROOM_FOR; n++) expect((await opened(pdf)).pages).toBe(1);
  });

  it("refuses a PDF there is no room for, and has room for it once another is disposed", async () => {
    let pdf = faxPdf();
    let documents = [];
    for (let n = 0; n < ROOM_FOR; n++) documents.push((await opened(pdf)).document);
    let refused = streamOf(UNREAD);
    expect(await env.PDF_RENDERER.open(refused.stream, pdf.byteLength)).toEqual(unstarted("room"));
    expect(await refused.taken).toBe(false);
    documents[3]![Symbol.dispose]();
    expect((await opened(pdf)).pages).toBe(1);
    // And for no more than that one: the others are open still.
    expect(await answerTo(pdf)).toEqual(unstarted("room"));
    expect(await documents[0]!.renderPage(0, { bands: 1 })).toMatchObject({ blank: false });
  });

  it("takes back the room of a PDF that went two minutes without a call, when another needs it, and of no more", async () => {
    let pdf = faxPdf();
    let clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    let documents = [];
    for (let n = 0; n < ROOM_FOR; n++) documents.push((await opened(pdf)).document);
    let lines = logLines();
    let [kept, ...idle] = documents;
    clock.mockReturnValue(1_000_000 + HOLD_IDLE_MS);
    expect(await answerTo(pdf)).toEqual(unstarted("room"));
    // A call is what keeps a document.
    expect(await kept!.renderPage(0, { bands: 1 })).toMatchObject({ blank: false });
    clock.mockReturnValue(1_000_000 + HOLD_IDLE_MS + 1);
    expect((await opened(pdf)).pages).toBe(1);
    // One of the seven made the room, so the other six are open still.
    let answers = [];
    for (let document of idle) answers.push(await document.renderPage(0, { bands: 1 }));
    let taken = answers.flatMap((answer, index) => "refused" in answer ? [index] : []);
    expect(taken).toHaveLength(1);
    expect(answers[taken[0]!]).toEqual(unstarted("released"));
    expect(await kept!.renderPage(0, { bands: 1 })).toMatchObject({ blank: false });
    // Disposing the one that was taken back gives no room a second time, and a call is what
    // kept the six, too: there is no room for another now.
    idle[taken[0]!]![Symbol.dispose]();
    expect(await answerTo(pdf)).toEqual(unstarted("room"));
    // The one was said to be taken back, once.
    expect(givenBack(lines)).toEqual([logLine("released", { releasedBy: "idle" })]);
  });

  it("answers a page it does not render as a value, and renders the page after it", async () => {
    let { document, pages } = await opened(scannedPdf([oversizedPage(), onePage(bitsImage())]));
    expect(pages).toBe(2);
    let refused = await document.renderPage(0, { bands: 1 });
    expect(refused).toMatchObject({ refused: "image-pixels", ofPage: true });
    expect((refused as RenderRefused).heapBytes).toBeGreaterThan(0);
    expect(await document.renderPage(1, { bands: 1 })).toMatchObject({ blank: false, images: 1 });
  });

  it("throws for a page the PDF does not have, for bands a page is never cut into, and for arguments of another type", async () => {
    let { document } = await opened(faxPdf());
    expect(await thrown(document.renderPage(1, { bands: 1 }))).toBe("RangeError: The PDF has no page 1.");
    expect(await thrown(document.renderPage(-1, { bands: 1 }))).toBe("RangeError: The PDF has no page -1.");
    for (let bands of [0, RENDER_LIMITS.bands + 1, 1.5]) {
      expect(await thrown(document.renderPage(0, { bands })))
        .toBe(`RangeError: A page is cut into 1 to ${RENDER_LIMITS.bands} bands, not ${bands}.`);
    }
    // The types are held to before the renderer is reached.
    expect(await thrown(document.renderPage("0" as never, { bands: 1 }))).toMatch(/^TypeError: .*renderPage\[0\]/);
    expect(await thrown(document.renderPage(0, { bands: "1" } as never))).toMatch(/^TypeError: .*renderPage\[1\]\.bands/);
    expect(await thrown(document.renderPage(0, { bands: 1, denseLines: "9" } as never)))
      .toMatch(/^TypeError: .*renderPage\[1\]\.denseLines/);
    // A call refused for its types leaves its stream unread, so the one handed over is empty.
    expect(await thrown(env.PDF_RENDERER.open(new Blob([]).stream(), "700" as never))).toMatch(/^TypeError: .*open\[1\]/);
    // The document is none the worse for them.
    expect(await document.renderPage(0, { bands: RENDER_LIMITS.bands })).toMatchObject({ blank: false });
  });

  it("logs what it opened, rendered, refused and gave back, in numbers and fixed words and nothing else", async () => {
    // With as many PDFs open as fit, none that an earlier test opened is still to be given back.
    let filling = [];
    for (let n = 0; n < ROOM_FOR; n++) filling.push((await opened(faxPdf())).document);
    let lines = logLines();
    for (let document of filling) document[Symbol.dispose]();
    let released = logLine("released", { releasedBy: "disposed" });
    await vi.waitFor(() => expect(lines).toEqual(filling.map(() => released)));

    let pdf = scannedPdf([onePage(bitsImage()), { images: [], content: "" }, oversizedPage()]);
    let { document } = await opened(pdf);
    let page = rendered(await document.renderPage(0, { bands: 1 }));
    let blank = rendered(await document.renderPage(1, { bands: 1 }));
    let undrawn = await document.renderPage(2, { bands: 1 }) as RenderRefused;
    let unread = await answerTo(new TextEncoder().encode("not a PDF at all")) as RenderRefused;
    document[Symbol.dispose]();
    let sized = { width: 200, height: 133, bands: 1, dpi: 150, reduced: false };
    await vi.waitFor(() => expect(lines.slice(ROOM_FOR)).toEqual([
      logLine("opened", { pdfBytes: pdf.byteLength, pages: 3 }),
      logLine("page_rendered", { page: 1, ...sized, blank: false, images: 1, ...page.cost }),
      logLine("page_rendered", { page: 2, ...sized, blank: true, images: 0, ...blank.cost }),
      logLine("refused", { reason: "image-pixels", page: 3, heapBytes: undrawn.heapBytes, work: undrawn.work }),
      // A PDF that was not opened is refused, and is not said to be given back.
      logLine("refused", { reason: "unreadable", heapBytes: unread.heapBytes, work: unread.work }),
      released,
    ]));
  });

  it("answers anything but a call of the entrypoint with a 404", async () => {
    let response = await SELF.fetch("https://renderer.invalid/");
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
  });
});

// An invocation over the binding is the runtime's, and nothing says when it ends. One the test
// makes for the entrypoint can be waited for.
describe("the entrypoint, called in an invocation of the test's", () => {
  it("keeps the invocation that opened a PDF until its document is disposed, and ends it then", async () => {
    let invocation = createExecutionContext();
    let { document } = await opened(faxPdf(), new PdfRenderer(invocation, env));
    let ended = waitOnExecutionContext(invocation).then(() => true);
    expect(await Promise.race([ended, new Promise(resolve => setTimeout(resolve, 50, false))])).toBe(false);
    document[Symbol.dispose]();
    expect(await ended).toBe(true);
  });
});
