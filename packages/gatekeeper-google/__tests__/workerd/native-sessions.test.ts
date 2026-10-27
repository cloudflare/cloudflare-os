import { RpcStub, RpcTarget } from "cloudflare:workers";
import type {
  ActionDescription, ApprovalQueue, GitCache, HookController, HookDescription,
  ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleDocsApi } from "../../src/docs-api";
import { DriveApi } from "../../src/drive-api";
import type { DriveBindingScope } from "../../src/drive-session";
import { MAX_CONCURRENT_FILE_READS } from "../../src/drive-file-read";
import { Semaphore } from "../../src/mutex";
import type { PdfConverter } from "../../src/drive-pdf";
import type { DriveObservation } from "../../src/drive-observers";
import { GoogleDriveSessionImpl } from "../../src/google";
import type { DrivePdfText, DriveSessionSearchQuery } from "../../src/drive-types";
import { GoogleSheetsApi } from "../../src/sheets-api";
import type { GoogleSpreadsheetSession } from "../../src/sheets-types";
import { GoogleSlidesApi } from "../../src/slides-api";
import type { GooglePresentationSession } from "../../src/slides-types";
import { buildTab } from "../doc-fixture";
import { formatSheet } from "../sheets-fixture";
import { presentation, shape, SIMPLE_LIGHT, slide, text } from "../slides-fixture";

const DOC_MIME = "application/vnd.google-apps.document";
const SHEET_MIME = "application/vnd.google-apps.spreadsheet";
const SLIDES_MIME = "application/vnd.google-apps.presentation";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const PDF_MIME = "application/pdf";

const PDF_BYTES = new TextEncoder().encode("%PDF-1.4\n1 0 obj\n");
const PDF_MARKDOWN = "### Page 1\nChapter 1";
const PDF_ACCESS_MISSING =
  "This Google account was connected before Drive bindings could read file content. Reconnect " +
  "it in Workshop to read PDFs.";
/** What `alt=media` answers a token holding only `drive.metadata.readonly`. */
const NOT_AUTHORIZED_TO_FILE = {
  error: {
    code: 403,
    message: "The user has not granted the app 123456789 read access to the file pdf-1.",
    errors: [{
      message: "The user has not granted the app 123456789 read access to the file pdf-1.",
      reason: "appNotAuthorizedToFile",
      location: "Authorization",
    }],
  },
};

/**
 * A converter that reads the PDF stream it is given to the end and streams {@link PDF_MARKDOWN},
 * counting the text streams cancelled unread.
 */
function fakeConverter(onConvert?: () => void) {
  const converted: Uint8Array[] = [];
  const state = { cancelled: 0 };
  const convert: PdfConverter = async pdf => {
    converted.push(new Uint8Array(await new Response(pdf).arrayBuffer()));
    onConvert?.();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode(PDF_MARKDOWN));
        controller.close();
      },
      cancel() { state.cancelled++; },
    }, { highWaterMark: 0 });
    return { text: stream, hasText: true };
  };
  return { converted, convert, state };
}

/** Reads a PDF read's text stream, as returned over RPC, to the end. */
async function readText(result: DrivePdfText): Promise<{ text: string; hasText: boolean }> {
  return { text: await new Response(result.text).text(), hasText: result.hasText };
}

function isDownload(url: string): boolean {
  return new URL(url).searchParams.get("alt") === "media";
}

const DECK = presentation([
  slide("s1", [shape("t1", text(["Intro"]), { placeholder: "TITLE" })]),
  slide("s2", [shape("b2", text(["Body"]))], { notes: text(["Say hello"]) }),
]);

/** A `presentations.get` or `presentations.pages.get` answer from {@link DECK}. */
function slidesResponse(url: URL): Response {
  const pageId = url.pathname.match(/\/pages\/([^/]+)$/)?.[1];
  if (pageId === undefined) return Response.json(DECK);
  const page = DECK.slides!.find(s => s.objectId === pageId);
  return page ? Response.json(page) : new Response(null, { status: 404 });
}

let providerUrls: string[];
/** The document the provider currently serves; a test may replace it mid-session. */
let providerTabs: unknown[];
/** Absent for a document the caller cannot edit, as Google returns it. */
let providerRevision: string | undefined;
/** What a file download answers. */
let providerDownload: () => Response;

async function getAccessToken(): Promise<string> {
  return "access-token";
}

class TestApprovalQueue extends RpcTarget implements ApprovalQueue {
  readonly observations: ObservationDescription[] = [];
  /** Titles this queue refuses to authorize. */
  readonly refuse = new Set<string>();
  /** Titles whose authorization waits for the promise mapped to them. */
  readonly holds = new Map<string, Promise<void>>();

  async authorizeObservation(description: ObservationDescription): Promise<void> {
    await this.holds.get(description.title);
    if (this.refuse.has(description.title)) throw new Error("Observation refused");
    this.observations.push(description);
  }

  async getGitCache(): Promise<GitCache> {
    throw new Error("Unexpected git cache access");
  }

  async submitAction(_action: number, _description: ActionDescription): Promise<void> {
    throw new Error("Unexpected action submission");
  }

  async bindHook<Hook extends RpcTarget>(
    _controller: Fetcher<HookController<Hook>>, _callback: RpcStub<Hook>,
    _description: HookDescription,
  ): Promise<void> {
    throw new Error("Unexpected hook binding");
  }
}

function providerFile(id: string, mimeType: string) {
  return {
    id,
    name: id === "doc-1" ? "Quarterly plan" : "Forecast",
    mimeType,
    modifiedTime: "2026-08-20T12:00:00Z",
  };
}

/** One provider tab: the section break every body opens with, then an optional paragraph. */
function docTab(tabId: string, title: string, text: string, childTabs: unknown[] = []) {
  const paragraph = `${text}\n`;
  return {
    tabProperties: { tabId, title },
    documentTab: {
      body: {
        content: [
          { startIndex: 0, endIndex: 1, sectionBreak: {} },
          ...text ? [{
            startIndex: 1,
            endIndex: paragraph.length + 1,
            paragraph: {
              elements: [{
                startIndex: 1,
                endIndex: paragraph.length + 1,
                textRun: { content: paragraph, textStyle: {} },
              }],
              paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
            },
          }] : [],
        ],
      },
      lists: {},
      namedRanges: {},
    },
    childTabs,
  };
}

function tableDocTab() {
  let tab = buildTab([
    { runs: ["Before\n"] },
    { table: [["Owner\n", "Status\n"], ["Alice\n", "Ready\n"]] },
    { runs: ["After\n"] },
  ]);
  return {
    tabProperties: { tabId: "solo", title: "Solo" },
    documentTab: { body: tab.body, lists: {}, namedRanges: {} },
    childTabs: [],
  };
}

/** Two roots, a child and a grandchild — the shape `listTabs()` must flatten in preorder. */
const NESTED_TABS = [
  docTab("overview", "Overview", "Overview body", [
    docTab("details", "Details", "Details body", [
      docTab("metrics", "Metrics", "Metrics body"),
    ]),
  ]),
  docTab("appendix", "Appendix", "Appendix body"),
];

function installProvider(tabs: unknown[] = [docTab("solo", "Solo", "")]) {
  const urls: string[] = [];
  providerTabs = tabs;
  providerRevision = "revision-1";
  providerDownload = () => new Response(PDF_BYTES, {
    headers: { "Content-Type": PDF_MIME, "Content-Length": String(PDF_BYTES.byteLength) },
  });
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    urls.push(url.toString());
    if (url.hostname === "www.googleapis.com" && url.pathname.endsWith("/drive/v3/files")) {
      return Response.json({ files: [providerFile("doc-1", DOC_MIME)] });
    }
    if (url.hostname === "www.googleapis.com" && isDownload(url.toString())) {
      return providerDownload();
    }
    if (url.hostname === "www.googleapis.com" && url.pathname.includes("/drive/v3/files/")) {
      const id = decodeURIComponent(url.pathname.split("/").at(-1)!);
      const mimeType = id === "doc-1" ? DOC_MIME : id === "deck-1" ? SLIDES_MIME
        : id === "pdf-1" ? PDF_MIME : SHEET_MIME;
      return Response.json(providerFile(id, mimeType));
    }
    if (url.hostname === "docs.googleapis.com") {
      return Response.json({
        documentId: "doc-1",
        title: "Quarterly plan",
        ...providerRevision === undefined ? {} : { revisionId: providerRevision },
        tabs: providerTabs,
      });
    }
    if (url.hostname === "slides.googleapis.com") return slidesResponse(url);
    throw new Error(`Unexpected provider request: ${url.origin}${url.pathname}`);
  }));
  return urls;
}

/** Full `documents.get` calls, excluding the lightweight revision check. */
function docFetches(): number {
  return providerUrls.filter(url => {
    const { hostname, searchParams } = new URL(url);
    return hostname === "docs.googleapis.com" && !searchParams.has("fields");
  }).length;
}

function newSession(
  convertPdf?: PdfConverter, scope: DriveBindingScope = { kind: "account" },
) {
  const queue = new TestApprovalQueue();
  const queueStub: RpcStub<ApprovalQueue> = new RpcStub(queue);
  /** The disclosure units of each observation, in order. */
  const prepared: DriveObservation[][] = [];
  return {
    queue,
    prepared,
    session: new RpcStub(new GoogleDriveSessionImpl(
      new DriveApi(getAccessToken),
      new GoogleDocsApi(getAccessToken),
      new GoogleSheetsApi(getAccessToken),
      new GoogleSlidesApi(getAccessToken),
      convertPdf,
      new Semaphore(MAX_CONCURRENT_FILE_READS),
      scope,
      queueStub,
      async units => {
        prepared.push(units);
        return { pendingSets: units, commit() {} };
      },
      () => ({ pendingSets: [], commit() {} }),
    )),
  };
}

beforeEach(() => {
  providerUrls = installProvider();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Drive nested native sessions", () => {
  it("pipelines a Doc call before resolving its disposable child stub", async () => {
    using session = newSession().session;

    const docPromise = session.openGoogleDoc("doc-1");
    const metadataPromise = docPromise.getMetadata();
    using doc = await docPromise;

    expect(await metadataPromise).toEqual({
      title: "Quarterly plan",
      lastModified: new Date("2026-08-20T12:00:00Z"),
    });
    expect(await doc.getContent()).toBe("");
  });

  it("returns table cells from a Drive-opened Doc", async () => {
    providerTabs = [tableDocTab()];
    using session = newSession().session;
    using doc = await session.openGoogleDoc("doc-1");

    await expect(doc.getContent()).resolves.toContain(
      "<tr>\n    <td><p>Alice</p></td>\n    <td><p>Ready</p></td>\n  </tr>",
    );
  });

  it("returns the existing Sheet target with bounded range validation", async () => {
    using session = newSession().session;
    using sheet = await session.openGoogleSheet("sheet-1");

    await expect(Promise.resolve(sheet.readRange("A:A")))
      .rejects.toThrow(/Invalid or unbounded A1 range/);
    await expect(Promise.resolve(sheet.readFormats("A:A")))
      .rejects.toThrow(/Invalid or unbounded A1 range/);
    await expect(Promise.resolve(sheet.readFormats("A1:CV101")))
      .rejects.toThrow("readFormats may request at most 10,000 cells.");
    expect(providerUrls.some(url => new URL(url).hostname === "sheets.googleapis.com"))
      .toBe(false);
  });

  it("opens a native presentation with reads only", async () => {
    const { queue, session } = newSession();
    using owned = session;
    using deck = await owned.openGoogleSlides("deck-1");

    const info = await deck.getPresentation();
    expect(info.slides.map(s => s.id)).toEqual(["s1", "s2"]);
    expect(info.masters).toEqual([
      { id: "master-1", name: "Simple Light", background: "LIGHT1", themeColors: SIMPLE_LIGHT },
    ]);
    expect(info.layouts.map(({ id, name, master }) => ({ id, name, master }))).toEqual([
      { id: "layout-title", name: "Title slide", master: "master-1" },
      { id: "layout-title-body", name: "Title and body", master: "master-1" },
    ]);
    expect((await deck.getSlides(["s2"]))[0].speakerNotes).toBe("Say hello");
    expect(queue.observations.map(o => o.title)).toEqual([
      "Open Google Slides presentation from Google Drive",
      "Read Google Slides presentation outline",
      "Read one Google Slides slide",
    ]);

    // The capability itself has no write method, whatever a caller sends it.
    const writable = deck as unknown as GooglePresentationSession;
    await expect(Promise.resolve(writable.deleteSlide("s1")))
      .rejects.toThrow('The RPC receiver does not implement the method "deleteSlide".');
    await expect(Promise.resolve(writable.updateSlides([
      { op: "editText", slideId: "s1", elementId: "t1", replace: "Changed" },
    ]))).rejects.toThrow('The RPC receiver does not implement the method "updateSlides".');
    expect(queue.observations).toHaveLength(3);
  });

  it("refuses to open a file that is not a presentation as one", async () => {
    using session = newSession().session;

    await expect(Promise.resolve(session.openGoogleSlides("sheet-1")))
      .rejects.toThrow("The requested Drive file is not a Google Slides presentation.");
    expect(providerUrls.some(url => new URL(url).hostname === "slides.googleapis.com"))
      .toBe(false);
  });

  it("gives each child an independently disposable approval-queue stub", async () => {
    const resources = newSession();
    using session = resources.session;
    using doc = await session.openGoogleDoc("doc-1");

    session[Symbol.dispose]();
    await expect(doc.getMetadata()).resolves.toEqual(expect.objectContaining({
      title: "Quarterly plan",
    }));
    expect(resources.queue.observations).toHaveLength(2);

    doc[Symbol.dispose]();
    await expect(Promise.resolve(doc.getContent())).rejects.toThrow();
  });

  it("keeps a returned cursor paging after its session is disposed", async () => {
    const { queue, session } = newSession();
    using cursor = await session.list();

    session[Symbol.dispose]();

    expect(await cursor.next()).toEqual([expect.objectContaining({ id: "doc-1" })]);
    expect(queue.observations.at(-1)?.title).toBe("Read Google Drive metadata");
  });
});

describe("Drive PDF reads", () => {
  it("returns the converted text after authorizing its read", async () => {
    let authorizedAtConversion: string[] = [];
    const converter = fakeConverter(() => {
      authorizedAtConversion = queue.observations.map(o => o.title);
    });
    const { queue, prepared, session } = newSession(converter.convert);
    using owned = session;

    const result = await owned.readPdf("pdf-1");
    expect(authorizedAtConversion).toEqual(["Open PDF from Google Drive"]);
    expect(await readText(result)).toEqual({ text: PDF_MARKDOWN, hasText: true });
    expect(converter.state.cancelled).toBe(0);

    expect(converter.converted).toEqual([PDF_BYTES]);
    const download = new URL(providerUrls.find(isDownload)!);
    expect(download.pathname).toBe("/drive/v3/files/pdf-1");
    expect(download.searchParams.get("supportsAllDrives")).toBe("true");
    // The text is converted before its read is authorized, and authorized before it is returned.
    expect(queue.observations.map(({ title, description }) => ({ title, description }))).toEqual([
      {
        title: "Open PDF from Google Drive",
        description: "Check current metadata for Drive file pdf-1 and open it as a PDF.",
      },
      { title: "Read PDF from Google Drive", description: "Read the text of Drive file pdf-1." },
    ]);
    // The text is the file's content, so a collaborator needs leave to download the PDF to see it.
    expect(prepared).toEqual([[{ kind: "file", fileId: "pdf-1" }], [{ kind: "content", fileId: "pdf-1" }]]);
  });

  it("withholds the text when its read is not authorized, releasing its stream", async () => {
    const converter = fakeConverter();
    const { queue, session } = newSession(converter.convert);
    using owned = session;
    queue.refuse.add("Read PDF from Google Drive");

    await expect(Promise.resolve(owned.readPdf("pdf-1"))).rejects.toThrow("Observation refused");
    expect(converter.converted).toHaveLength(1);
    expect(converter.state.cancelled).toBe(1);
  });

  it("refuses a file that is not a PDF after observing it, without downloading", async () => {
    const converter = fakeConverter();
    const { queue, session } = newSession(converter.convert);
    using owned = session;

    await expect(Promise.resolve(owned.readPdf("doc-1")))
      .rejects.toThrow("The requested Drive file is not a PDF.");
    expect(queue.observations.map(o => o.title)).toEqual(["Open PDF from Google Drive"]);
    expect(providerUrls.some(isDownload)).toBe(false);
    expect(converter.converted).toEqual([]);
  });

  it("refuses an ID outside an exact-file binding before contacting Google", async () => {
    const converter = fakeConverter();
    const { queue, session } = newSession(converter.convert, { kind: "file", fileId: "pdf-1" });
    using owned = session;

    await expect(Promise.resolve(owned.readPdf("pdf-2")))
      .rejects.toThrow("The requested file is outside this Drive binding.");
    expect(providerUrls).toEqual([]);
    expect(queue.observations).toEqual([]);
  });

  it("asks an account connected before content access to reconnect", async () => {
    providerDownload = () => Response.json(NOT_AUTHORIZED_TO_FILE, { status: 403 });
    const converter = fakeConverter();
    const { queue, session } = newSession(converter.convert);
    using owned = session;

    await expect(Promise.resolve(owned.readPdf("pdf-1"))).rejects.toThrow(PDF_ACCESS_MISSING);
    expect(converter.converted).toEqual([]);
    expect(queue.observations.map(o => o.title)).toEqual(["Open PDF from Google Drive"]);
  });

  it("passes other download failures through", async () => {
    providerDownload = () => Response.json(
      { error: { code: 403, errors: [{ reason: "cannotDownloadFile" }] } }, { status: 403 });
    using session = newSession(fakeConverter().convert).session;

    await expect(Promise.resolve(session.readPdf("pdf-1")))
      .rejects.toThrow("Google Drive API request failed: 403 (the connected account is not " +
        "allowed to download this file; its owner or administrator has restricted downloading it)");
  });

  it("says PDF reading is unavailable without a converter, without downloading", async () => {
    const { queue, session } = newSession();
    using owned = session;

    await expect(Promise.resolve(owned.readPdf("pdf-1")))
      .rejects.toThrow("PDF reading is not available on this deployment.");
    expect(providerUrls.some(isDownload)).toBe(false);
    expect(queue.observations.map(o => o.title)).toEqual(["Open PDF from Google Drive"]);
  });

  it("refuses text converted before the download ended, releasing both", async () => {
    const download = { cancelled: false };
    providerDownload = () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(PDF_BYTES); },
      cancel() { download.cancelled = true; },
    }));
    const converted = { cancelled: false };
    const convert: PdfConverter = async () => ({
      text: new ReadableStream({ cancel() { converted.cancelled = true; } }), hasText: true,
    });
    const { queue, session } = newSession(convert);
    using owned = session;

    await expect(Promise.resolve(owned.readPdf("pdf-1")))
      .rejects.toThrow("Google Drive's file could not be converted from PDF.");
    expect(queue.observations.map(o => o.title)).toEqual(["Open PDF from Google Drive"]);
    expect(converted.cancelled).toBe(true);
    expect(download.cancelled).toBe(true);
  });
});

describe("Drive file reads", () => {
  const CSV_BYTES = new TextEncoder().encode("region,amount\nEMEA,120\nAPAC,95\n");
  const FILE_ACCESS_MISSING =
    "This Google account was connected before Drive bindings could read file content. Reconnect " +
    "it in Workshop to read Drive files.";

  type ProviderFile = { mimeType: string; content?: Uint8Array; canDownload?: boolean };
  const FILES: Record<string, ProviderFile> = {
    "csv-1": { mimeType: "text/csv", content: CSV_BYTES },
    "empty-1": { mimeType: "text/plain", content: new Uint8Array() },
    "big-1": { mimeType: "application/octet-stream", content: new Uint8Array(4_000_010) },
    "locked-1": { mimeType: "text/csv", content: CSV_BYTES, canDownload: false },
    "doc-1": { mimeType: DOC_MIME },
    "sheet-1": { mimeType: SHEET_MIME },
    "deck-1": { mimeType: SLIDES_MIME },
    "folder-1": { mimeType: FOLDER_MIME },
    "shortcut-1": { mimeType: "application/vnd.google-apps.shortcut" },
    "form-1": { mimeType: "application/vnd.google-apps.form" },
  };

  /** The `Range` of each download, in order. */
  let downloads: (string | null)[];
  /** Replaces the honoured range a download answers with, when a test sets it. */
  let answerDownload: (() => Response) | undefined;

  /** Serves {@link FILES}: metadata, and each download's requested range as a 206. */
  function installFileProvider(): string[] {
    const urls: string[] = [];
    downloads = [];
    answerDownload = undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      urls.push(url.toString());
      if (url.hostname !== "www.googleapis.com" || !url.pathname.startsWith("/drive/v3/files/")) {
        throw new Error(`Unexpected provider request: ${url.origin}${url.pathname}`);
      }
      const id = decodeURIComponent(url.pathname.split("/").at(-1)!);
      const file = FILES[id];
      if (!file) return Response.json({ error: { code: 404, errors: [{ reason: "notFound" }] } }, { status: 404 });
      if (isDownload(url.toString())) {
        const range = new Headers(init?.headers).get("Range");
        downloads.push(range);
        if (answerDownload) return answerDownload();
        const [, start, end] = range!.match(/^bytes=(\d+)-(\d+)$/)!.map(Number);
        const content = file.content!;
        const last = Math.min(end, content.byteLength - 1);
        return new Response(content.slice(start, last + 1), {
          status: 206,
          headers: { "Content-Range": `bytes ${start}-${last}/${content.byteLength}` },
        });
      }
      return Response.json({
        id,
        name: id,
        mimeType: file.mimeType,
        modifiedTime: "2026-08-20T12:00:00Z",
        ...file.content ? { size: String(file.content.byteLength) } : {},
        ...file.canDownload === undefined ? {} : { capabilities: { canDownload: file.canDownload } },
      });
    }));
    return urls;
  }

  beforeEach(() => {
    providerUrls = installFileProvider();
  });

  it("reads a whole small file, authorizing the read before returning it", async () => {
    const { queue, prepared, session } = newSession();
    using owned = session;

    const read = await owned.readFile("csv-1");

    expect(new TextDecoder().decode(read.content)).toBe("region,amount\nEMEA,120\nAPAC,95\n");
    expect(read).toEqual({
      mimeType: "text/csv",
      size: CSV_BYTES.byteLength,
      modifiedTime: new Date("2026-08-20T12:00:00Z"),
      offset: 0,
      content: expect.any(ArrayBuffer),
    });
    expect(downloads).toEqual([`bytes=0-${CSV_BYTES.byteLength - 1}`]);
    expect(queue.observations.map(({ title, description }) => ({ title, description }))).toEqual([
      {
        title: "Open file from Google Drive",
        description: "Check current metadata for Drive file csv-1 and open it as a file.",
      },
      {
        title: "Read file from Google Drive",
        description: `Read ${CSV_BYTES.byteLength} bytes of Drive file csv-1, from byte 0.`,
      },
    ]);
    // The bytes are the file's content, so a collaborator needs leave to download it to see them.
    expect(prepared).toEqual([[{ kind: "file", fileId: "csv-1" }], [{ kind: "content", fileId: "csv-1" }]]);
  });

  it("reads a large file in ranges, clamping the last one to the end of the file", async () => {
    using session = newSession().session;
    const size = CSV_BYTES.byteLength;

    const middle = await session.readFile("csv-1", { offset: 7, length: 6 });
    const last = await session.readFile("csv-1", { offset: size - 4, length: 100 });

    expect(new Uint8Array(middle.content)).toEqual(CSV_BYTES.slice(7, 13));
    expect(middle.offset).toBe(7);
    expect(new Uint8Array(last.content)).toEqual(CSV_BYTES.slice(size - 4));
    expect(downloads).toEqual(["bytes=7-12", `bytes=${size - 4}-${size - 1}`]);
  });

  it("returns no bytes at the end of a file, or of an empty one, without downloading", async () => {
    using session = newSession().session;

    const atEnd = await session.readFile("csv-1", { offset: CSV_BYTES.byteLength });
    const empty = await session.readFile("empty-1");

    expect(atEnd.content.byteLength).toBe(0);
    expect(empty).toEqual(expect.objectContaining({ size: 0, offset: 0 }));
    expect(empty.content.byteLength).toBe(0);
    expect(downloads).toEqual([]);
  });

  it("refuses an offset past the end of the file without downloading", async () => {
    using session = newSession().session;

    await expect(Promise.resolve(session.readFile("csv-1", { offset: CSV_BYTES.byteLength + 1 })))
      .rejects.toThrow(`offset ${CSV_BYTES.byteLength + 1} is past the end of the Drive file, ` +
        `which is ${CSV_BYTES.byteLength} bytes long.`);
    expect(downloads).toEqual([]);
  });

  it.each([
    [{ offset: -1 }, "offset must be a whole number of bytes, at least 0."],
    [{ offset: 1.5 }, "offset must be a whole number of bytes, at least 0."],
    [{ length: 0 }, "length must be a whole number of bytes from 1 to 4,000,000."],
    [{ length: 4_000_001 }, "length must be a whole number of bytes from 1 to 4,000,000."],
  ])("refuses the range %o before contacting Google", async (options, message) => {
    const { queue, session } = newSession();
    using owned = session;

    await expect(Promise.resolve(owned.readFile("csv-1", options))).rejects.toThrow(message);
    expect(providerUrls).toEqual([]);
    expect(queue.observations).toEqual([]);
  });

  it("reads at most 4,000,000 bytes when no length is given", async () => {
    using session = newSession().session;

    const first = await session.readFile("big-1");

    expect(first.content.byteLength).toBe(4_000_000);
    expect(first.size).toBe(4_000_010);
    expect(downloads).toEqual(["bytes=0-3999999"]);
  });

  it.each([
    ["doc-1", "The requested Drive file is a Google Doc; open it with openGoogleDoc()."],
    ["sheet-1", "The requested Drive file is a Google Sheet; open it with openGoogleSheet()."],
    ["deck-1", "The requested Drive file is a Google Slides presentation; open it with openGoogleSlides()."],
    ["folder-1", "The requested Drive item is a folder, which has no content to read."],
    ["shortcut-1", "The requested Drive item is a shortcut, which is not followed; read its target instead."],
    ["form-1", "The requested Drive file is a Google-native file (application/vnd.google-apps.form) " +
      "with no content to download."],
  ])("refuses %s after observing it, without downloading", async (fileId, message) => {
    const { queue, session } = newSession();
    using owned = session;

    await expect(Promise.resolve(owned.readFile(fileId))).rejects.toThrow(message);
    expect(queue.observations.map(o => o.title)).toEqual(["Open file from Google Drive"]);
    expect(downloads).toEqual([]);
  });

  it("refuses a file Drive does not let the account download, without downloading", async () => {
    using session = newSession().session;

    await expect(Promise.resolve(session.readFile("locked-1"))).rejects.toThrow(
      "Google Drive does not let the connected account download this file; its owner or " +
      "administrator has restricted downloading it.");
    expect(downloads).toEqual([]);
  });

  it("explains a download Drive refuses as malware", async () => {
    answerDownload = () => Response.json(
      { error: { code: 403, errors: [{ reason: "cannotDownloadAbusiveFile" }] } }, { status: 403 });
    using session = newSession().session;

    await expect(Promise.resolve(session.readFile("csv-1"))).rejects.toThrow(
      "Google identified this file as malware or spam, so only its owner can download it");
  });

  it("asks an account connected before content access to reconnect", async () => {
    answerDownload = () => Response.json(NOT_AUTHORIZED_TO_FILE, { status: 403 });
    const { queue, session } = newSession();
    using owned = session;

    await expect(Promise.resolve(owned.readFile("csv-1"))).rejects.toThrow(FILE_ACCESS_MISSING);
    expect(queue.observations.map(o => o.title)).toEqual(["Open file from Google Drive"]);
  });

  it("says the file changed when it shrank past the requested range", async () => {
    answerDownload = () => Response.json(
      { error: { code: 416, errors: [{ reason: "requestedRangeNotSatisfiable" }] } }, { status: 416 });
    using session = newSession().session;

    await expect(Promise.resolve(session.readFile("csv-1", { offset: 4 }))).rejects.toThrow(
      "The Drive file changed while it was being read; read it again.");
  });

  // Its old size and time would make the new bytes look like the whole of the old file, so a
  // file that grew would be taken as read to its end.
  const grown = new TextEncoder().encode("NEWREVISION".repeat(10));
  const shrunk = CSV_BYTES.slice(0, -1);
  const n = CSV_BYTES.byteLength;
  it.each([
    ["the file grew, by a range's total", () => new Response(grown.slice(0, n), {
      status: 206, headers: { "Content-Range": `bytes 0-${n - 1}/${grown.byteLength}` },
    })],
    ["the file grew, by a whole-file answer's length", () => new Response(grown, {
      headers: { "Content-Length": String(grown.byteLength) },
    })],
    ["the file shrank, by a whole-file answer's length", () => new Response(shrunk, {
      headers: { "Content-Length": String(shrunk.byteLength) },
    })],
    ["the file shrank, by a range of unknown total ending early", () => new Response(shrunk, {
      status: 206, headers: { "Content-Range": `bytes 0-${n - 2}/*` },
    })],
    ["Drive ends a range early", () => new Response(shrunk, {
      status: 206, headers: { "Content-Range": `bytes 0-${n - 2}/${n}` },
    })],
  ])("withholds bytes when %s", async (_name, answer) => {
    answerDownload = answer;
    const { queue, session } = newSession();
    using owned = session;

    await expect(Promise.resolve(owned.readFile("csv-1"))).rejects.toThrow(
      "The Drive file changed while it was being read; read it again.");
    expect(queue.observations.map(o => o.title)).toEqual(["Open file from Google Drive"]);
  });

  // Each read keeps its bytes until it is authorized, so authorization holding the first three up
  // must keep a fourth from downloading at all.
  it("holds at most three reads at once, each until its read is authorized", async () => {
    const { queue, session } = newSession();
    using owned = session;
    const authorized = Promise.withResolvers<void>();
    queue.holds.set("Read file from Google Drive", authorized.promise);

    const reads = Array.from({ length: 4 }, () => Promise.resolve(owned.readFile("csv-1")));
    // All four have opened the file, so the fourth is waiting its turn, not merely late.
    await vi.waitFor(() => expect(queue.observations).toHaveLength(4));
    expect(downloads).toHaveLength(3);

    authorized.resolve();
    await Promise.all(reads);
    expect(downloads).toHaveLength(4);
  });

  it("withholds the bytes when their read is not authorized", async () => {
    const { queue, session } = newSession();
    using owned = session;
    queue.refuse.add("Read file from Google Drive");

    await expect(Promise.resolve(owned.readFile("csv-1"))).rejects.toThrow("Observation refused");
    expect(downloads).toHaveLength(1);
  });

  it("reads the bound file of an exact-file binding", async () => {
    using session = newSession(undefined, { kind: "file", fileId: "csv-1" }).session;

    expect(new Uint8Array((await session.readFile("csv-1")).content)).toEqual(CSV_BYTES);
  });

  it("refuses any other ID in an exact-file binding before contacting Google", async () => {
    const { queue, session } = newSession(undefined, { kind: "file", fileId: "csv-1" });
    using owned = session;

    await expect(Promise.resolve(owned.readFile("locked-1")))
      .rejects.toThrow("The requested file is outside this Drive binding.");
    expect(providerUrls).toEqual([]);
    expect(queue.observations).toEqual([]);
  });
});

describe("Drive Doc tab selection", () => {
  beforeEach(() => {
    providerUrls = installProvider(NESTED_TABS);
  });

  it("flattens the tab tree in preorder with derived ancestry", async () => {
    using session = newSession().session;
    using doc = await session.openGoogleDoc("doc-1");

    expect(await doc.listTabs()).toEqual([
      { id: "overview", title: "Overview", index: 0, nestingLevel: 0 },
      { id: "details", title: "Details", parentTabId: "overview", index: 0, nestingLevel: 1 },
      { id: "metrics", title: "Metrics", parentTabId: "details", index: 0, nestingLevel: 2 },
      { id: "appendix", title: "Appendix", index: 1, nestingLevel: 0 },
    ]);
  });

  it("reads only the selected tab and fetches the document once", async () => {
    const { queue, session } = newSession();
    using owned = session;
    using doc = await owned.openGoogleDoc("doc-1");

    await doc.listTabs();
    expect(await doc.getContent("metrics")).toBe("Metrics body\n");
    expect(await doc.getContent("appendix")).toBe("Appendix body\n");

    expect(docFetches()).toBe(1);
    expect(queue.observations.map(({ title }) => title)).toEqual([
      "Open Google Doc from Google Drive", "List Google Doc tabs",
      "Read Google Doc content", "Read Google Doc content",
    ]);
    expect(queue.observations.at(-1)?.description).toContain('tab "Appendix" (appendix)');
  });

  // Reads issued without awaiting the first must share one provider revision, or they can
  // observe different documents and the later response can be the older one.
  it("fetches the document once for concurrent reads", async () => {
    using session = newSession().session;
    using doc = await session.openGoogleDoc("doc-1");

    const [tabs, content] = await Promise.all([doc.listTabs(), doc.getContent("metrics")]);

    expect(tabs).toHaveLength(4);
    expect(content).toBe("Metrics body\n");
    expect(docFetches()).toBe(1);
  });

  // The session is a long-lived stub, so pinning it to the revision of its first read would hide
  // every later collaborator edit -- and the selector error tells the caller to call listTabs(),
  // which could not refresh anything.
  it("sees a collaborator's new tab once the snapshot expires", async () => {
    using session = newSession().session;
    using doc = await session.openGoogleDoc("doc-1");
    expect(await doc.listTabs()).toHaveLength(4);

    providerTabs = [...NESTED_TABS, docTab("addendum", "Addendum", "Addendum body")];
    providerRevision = "revision-2";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60_000);

    expect(await doc.listTabs()).toHaveLength(5);
    expect(await doc.getContent("addendum")).toBe("Addendum body\n");
    expect(docFetches()).toBe(2);
  });

  it("reuses the expired snapshot when the revision is unchanged", async () => {
    using session = newSession().session;
    using doc = await session.openGoogleDoc("doc-1");
    await doc.listTabs();

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60_000);

    expect(await doc.getContent("metrics")).toBe("Metrics body\n");
    expect(docFetches()).toBe(1);
    expect(providerUrls.some(url => new URL(url).searchParams.get("fields") === "revisionId"))
      .toBe(true);
  });

  // Google omits revisionId unless the caller can edit, which is the normal case for a Doc
  // opened read-only through Drive. Two absent revisions must not compare as unchanged.
  it("refetches a document that has no revision ID", async () => {
    providerRevision = undefined;
    using session = newSession().session;
    using doc = await session.openGoogleDoc("doc-1");
    expect(await doc.listTabs()).toHaveLength(4);

    providerTabs = [...NESTED_TABS, docTab("addendum", "Addendum", "Addendum body")];
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60_000);

    expect(await doc.listTabs()).toHaveLength(5);
    expect(docFetches()).toBe(2);
    // Nothing to compare, so the revision probe is not worth a request.
    expect(providerUrls.some(url => new URL(url).searchParams.get("fields") === "revisionId"))
      .toBe(false);
  });

  it("pipelines a tab read before its session stub resolves", async () => {
    using session = newSession().session;

    const docPromise = session.openGoogleDoc("doc-1");
    const contentPromise = docPromise.getContent("details");
    using doc = await docPromise;

    expect(await contentPromise).toBe("Details body\n");
    doc[Symbol.dispose]();
    await expect(Promise.resolve(doc.listTabs())).rejects.toThrow();
  });

  it.each([
    [undefined, "getContent: tabId is required for documents with multiple tabs. " +
      "Call listTabs() to choose a tab."],
    ["ghost", 'getContent: no tab with ID "ghost" exists in this document. ' +
      "Call listTabs() to refresh the tab list."],
  ] as const)("fails closed on selector %s", async (tabId, message) => {
    const { queue, session } = newSession();
    using owned = session;
    using doc = await owned.openGoogleDoc("doc-1");

    await expect(Promise.resolve(doc.getContent(tabId))).rejects.toThrow(message);

    // The selector error says whether a tab exists, so the attempt is itself an observation --
    // recorded, but naming no tab, since none was disclosed.
    expect(queue.observations.at(-1)).toMatchObject({
      title: "Read Google Doc content",
      description: "Read the content of one tab of the document.",
    });
  });
});

// A folder binding's authority is derived from a hierarchy Drive can change under it, so the
// nested sessions it hands out must re-prove membership on every call rather than once at open.
describe("folder-scoped native sessions", () => {
  const ROOT = "folder-root";

  type Node = {
    id: string;
    mimeType: string;
    parents?: string[];
    trashed: boolean;
    /** Bytes of content, for a file that has its own. */
    size?: string;
    modifiedTime?: string;
    capabilities?: { canListChildren: boolean };
  };

  /** The subtree the provider answers from. Tests move files by rewriting `parents` here. */
  function subtree(): Map<string, Node> {
    return new Map<string, Node>([
      [ROOT, { id: ROOT, mimeType: FOLDER_MIME, parents: ["above"], trashed: false,
        capabilities: { canListChildren: true } }],
      ["doc-1", { id: "doc-1", mimeType: DOC_MIME, parents: [ROOT], trashed: false }],
      ["sheet-1", { id: "sheet-1", mimeType: SHEET_MIME, parents: [ROOT], trashed: false }],
    ]);
  }

  /** One multipart `files.get` batch response, echoing each requested ID by Content-ID position. */
  function batchResponse(body: string, nodes: Map<string, Node>): Response {
    const boundary = "folder_batch";
    const ids = [...body.matchAll(/GET \/drive\/v3\/files\/([^?]+)\?/g)]
      .map(match => decodeURIComponent(match[1]));
    const parts = ids.map((id, index) => {
      const node = nodes.get(id);
      return [
        `--${boundary}`,
        "Content-Type: application/http",
        `Content-ID: <response-item-${index}>`,
        "",
        node ? "HTTP/1.1 200 OK" : "HTTP/1.1 404 Not Found",
        "Content-Type: application/json",
        "",
        node ? JSON.stringify(node) : "{}",
      ].join("\r\n");
    });
    return new Response(`${parts.join("\r\n")}\r\n--${boundary}--\r\n`, {
      headers: { "Content-Type": `multipart/mixed; boundary=${boundary}` },
    });
  }

  /**
   * Answers downloads with PDF_BYTES whole, in two chunks pulled one at a time. `onLastChunk`
   * runs just before the second is sent, so a change it makes lands while the body is still
   * being read.
   */
  function installFolderProvider(
    nodes: Map<string, Node>, onNativeRead?: () => void, onLastChunk?: () => void,
  ) {
    const nativeCalls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (isDownload(url.toString())) {
        nativeCalls.push("download");
        onNativeRead?.();
        const half = PDF_BYTES.byteLength >> 1;
        let sent = 0;
        return new Response(new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent++ === 0) return controller.enqueue(PDF_BYTES.slice(0, half));
            onLastChunk?.();
            controller.enqueue(PDF_BYTES.slice(half));
            controller.close();
          },
        }, { highWaterMark: 0 }), { headers: { "Content-Type": PDF_MIME } });
      }
      if (url.pathname === "/batch/drive/v3") {
        return batchResponse(String(init?.body ?? ""), nodes);
      }
      if (url.pathname === "/drive/v3/files") {
        const parents = [...(url.searchParams.get("q") ?? "").matchAll(/'([^']+)' in parents/g)]
          .map(match => match[1]);
        const files = [...nodes.values()].filter(
          node => node.mimeType !== FOLDER_MIME && parents.includes(node.parents?.[0] ?? ""));
        return Response.json({
          files: files.map(node => ({ ...node, name: node.id, modifiedTime: "2026-08-20T12:00:00Z" })),
        });
      }
      if (url.pathname.includes("/drive/v3/files/")) {
        const id = decodeURIComponent(url.pathname.split("/").at(-1)!);
        const node = nodes.get(id);
        if (!node) return Response.json({}, { status: 404 });
        return Response.json({ name: id, modifiedTime: "2026-08-20T12:00:00Z", ...node });
      }
      nativeCalls.push(url.hostname);
      onNativeRead?.();
      if (url.hostname === "docs.googleapis.com") {
        return Response.json({
          documentId: decodeURIComponent(url.pathname.split("/").at(-1)!),
          title: "Quarterly plan",
          revisionId: "revision-1",
          tabs: [docTab("solo", "Solo", "")],
        });
      }
      if (url.pathname.endsWith("/values:batchGet")) {
        return Response.json({
          valueRanges: url.searchParams.getAll("ranges").map(range => ({ range, values: [["x"]] })),
        });
      }
      // A format read: the one bold cell A1.
      if (url.hostname === "sheets.googleapis.com" && url.searchParams.has("ranges")) {
        return Response.json({
          sheets: [formatSheet({ sheetId: 0, title: "Sheet1" }, [
            { startRow: 0, startColumn: 0, formats: [[{ textFormat: { bold: true } }]] },
          ])],
        });
      }
      if (url.hostname === "slides.googleapis.com") return slidesResponse(url);
      return Response.json({
        spreadsheetId: "sheet-1",
        properties: { title: "Forecast" },
        sheets: [{ properties: { sheetId: 0, title: "Sheet1", index: 0 } }],
      });
    }));
    return nativeCalls;
  }

  function folderSession(nodes: Map<string, Node>, convertPdf?: PdfConverter) {
    const queue = new TestApprovalQueue();
    return {
      queue,
      session: new RpcStub(new GoogleDriveSessionImpl(
        new DriveApi(getAccessToken),
        new GoogleDocsApi(getAccessToken),
        new GoogleSheetsApi(getAccessToken),
        new GoogleSlidesApi(getAccessToken),
        convertPdf,
        new Semaphore(MAX_CONCURRENT_FILE_READS),
        { kind: "folder", folderId: ROOT },
        new RpcStub(queue),
        async fileIds => ({ pendingSets: fileIds, commit() {} }),
        () => ({ pendingSets: [], commit() {} }),
      )),
    };
  }

  const OUTSIDE = "The requested file is outside this Drive binding.";

  it("serves Doc and Sheet reads while the files remain in the subtree", async () => {
    const nodes = subtree();
    installFolderProvider(nodes);
    using session = folderSession(nodes).session;

    using doc = await session.openGoogleDoc("doc-1");
    expect((await doc.getMetadata()).title).toBe("doc-1");
    expect(await doc.getContent()).toBe("");

    using sheet = await session.openGoogleSheet("sheet-1");
    expect((await sheet.getSpreadsheet()).title).toBe("Forecast");
    expect((await sheet.readRange("A1:A1")).values).toEqual([["x"]]);
    expect((await sheet.readRanges(["A1:A1", "B1:B1"])).map(r => r.range))
      .toEqual(["A1:A1", "B1:B1"]);

    // Formats are read with `spreadsheets.get` and an A1 range, which the read-only grant allows,
    // and a mask that asks for no cell's value.
    const fetched = vi.mocked(fetch);
    const before = fetched.mock.calls.length;
    expect(await sheet.readFormats("A1:B1"))
      .toEqual({ range: "Sheet1!A1:B1", formats: [[{ bold: true }, null]] });
    const formatUrls = fetched.mock.calls.slice(before)
      .map(([input]) => new URL(input instanceof Request ? input.url : input.toString()))
      .filter(url => url.hostname === "sheets.googleapis.com");
    expect(formatUrls.map(url => [url.pathname, url.searchParams.getAll("ranges")]))
      .toEqual([["/v4/spreadsheets/sheet-1", ["A1:B1"]]]);
    let mask = formatUrls[0].searchParams.get("fields") ?? "";
    expect(mask).toContain("userEnteredFormat(");
    for (let field of ["formattedValue", "effectiveValue", "userEnteredValue", "hyperlink", "note"]) {
      expect(mask).not.toContain(field);
    }

    // The capability itself has no write method, whatever a caller sends it.
    const writable = sheet as unknown as GoogleSpreadsheetSession;
    await expect(Promise.resolve(writable.updateSpreadsheet([
      { op: "writeCells", range: "Sheet1!A1", values: [["changed"]] },
    ]))).rejects.toThrow('The RPC receiver does not implement the method "updateSpreadsheet".');
  });

  // The capability was minted while the file was inside; the move is what revokes it, and it has to
  // revoke an already-open session, not merely the next open. `Promise.resolve` settles each RPC
  // promise into a native one, so its rejection gets a handler attached eagerly.
  it("refuses every Doc read after the document leaves the subtree", async () => {
    const nodes = subtree();
    const nativeCalls = installFolderProvider(nodes);
    using session = folderSession(nodes).session;
    using doc = await session.openGoogleDoc("doc-1");

    nodes.set("doc-1", { id: "doc-1", mimeType: DOC_MIME, parents: ["elsewhere"], trashed: false });
    nativeCalls.length = 0;

    await expect(Promise.resolve(doc.getMetadata())).rejects.toThrow(OUTSIDE);
    await expect(Promise.resolve(doc.getContent())).rejects.toThrow(OUTSIDE);
    // The precheck runs first, so the Docs API is never asked for content we could not disclose.
    expect(nativeCalls).toEqual([]);
  });

  it("refuses every Sheet read after the file leaves the subtree", async () => {
    const nodes = subtree();
    const nativeCalls = installFolderProvider(nodes);
    using session = folderSession(nodes).session;
    using sheet = await session.openGoogleSheet("sheet-1");

    // No parents at all: containment is undecidable, which is not membership.
    nodes.set("sheet-1", { id: "sheet-1", mimeType: SHEET_MIME, parents: [], trashed: false });
    nativeCalls.length = 0;

    await expect(Promise.resolve(sheet.getSpreadsheet())).rejects.toThrow(OUTSIDE);
    await expect(Promise.resolve(sheet.readRange("A1:A1"))).rejects.toThrow(OUTSIDE);
    await expect(Promise.resolve(sheet.readRanges(["A1:A1", "B1:B1"]))).rejects.toThrow(OUTSIDE);
    await expect(Promise.resolve(sheet.readFormats("A1:B1"))).rejects.toThrow(OUTSIDE);
    expect(nativeCalls).toEqual([]);
  });

  it("refuses every Slides read after the presentation leaves the subtree", async () => {
    const nodes = subtree();
    nodes.set("deck-1", { id: "deck-1", mimeType: SLIDES_MIME, parents: [ROOT], trashed: false });
    const nativeCalls = installFolderProvider(nodes);
    using session = folderSession(nodes).session;
    using deck = await session.openGoogleSlides("deck-1");
    expect((await deck.getPresentation()).title).toBe("Quarterly review");

    nodes.set("deck-1",
      { id: "deck-1", mimeType: SLIDES_MIME, parents: ["elsewhere"], trashed: false });
    nativeCalls.length = 0;

    await expect(Promise.resolve(deck.getPresentation())).rejects.toThrow(OUTSIDE);
    await expect(Promise.resolve(deck.getSlides(["s1"]))).rejects.toThrow(OUTSIDE);
    await expect(Promise.resolve(deck.getSlideThumbnail("s1"))).rejects.toThrow(OUTSIDE);
    expect(nativeCalls).toEqual([]);
  });

  // The move lands while the Docs call is in flight. The content reaches neither the approval
  // queue nor the caller, and the moved file stays visible, so nothing is authorized at all.
  it("discards content when the move lands during the provider read", async () => {
    const nodes = subtree();
    installFolderProvider(nodes, () => {
      nodes.set("doc-1", { id: "doc-1", mimeType: DOC_MIME, parents: ["elsewhere"], trashed: false });
    });
    const { queue, session } = folderSession(nodes);
    using scoped = session;
    using doc = await scoped.openGoogleDoc("doc-1");
    const authorizedBefore = queue.observations.length;

    await expect(Promise.resolve(doc.getContent())).rejects.toThrow(OUTSIDE);
    expect(queue.observations.slice(authorizedBefore)).toEqual([]);
  });

  // Every other childFolderIds test drives the core directly. This one crosses the RpcStub, which
  // is where capnweb-validate applies -- the only place that can tell us the field survives the
  // wire and that a malformed one is refused there rather than deep in a query builder.
  it("searches named child folders across the RPC boundary", async () => {
    const nodes = subtree();
    nodes.set("sub-a", { id: "sub-a", mimeType: FOLDER_MIME, parents: [ROOT], trashed: false,
      capabilities: { canListChildren: true } });
    nodes.set("sub-b", { id: "sub-b", mimeType: FOLDER_MIME, parents: [ROOT], trashed: false,
      capabilities: { canListChildren: true } });
    nodes.set("doc-a", { id: "doc-a", mimeType: DOC_MIME, parents: ["sub-a"], trashed: false });
    nodes.set("doc-b", { id: "doc-b", mimeType: DOC_MIME, parents: ["sub-b"], trashed: false });
    installFolderProvider(nodes);
    using session = folderSession(nodes).session;

    using cursor = await session.search({ namePrefix: "doc", childFolderIds: ["sub-a", "sub-b"] });
    expect((await cursor.next())?.map(entry => entry.id)).toEqual(["doc-a", "doc-b"]);
  });

  it("refuses a malformed child folder set at the RPC boundary", async () => {
    const nodes = subtree();
    installFolderProvider(nodes);
    using session = folderSession(nodes).session;

    await expect(Promise.resolve(session.search(
      { namePrefix: "doc", childFolderIds: [7] } as unknown as DriveSessionSearchQuery,
    ))).rejects.toThrow(/childFolderIds/);
  });

  // That refused read captured a revision while the document sat outside the subtree. Serving it
  // from the snapshot once the document returns would disclose content the guard rejected, so the
  // retry has to go back to the provider.
  it("drops the snapshot a refused mid-flight read left behind", async () => {
    const nodes = subtree();
    let pendingMoveOut = true;
    const nativeCalls = installFolderProvider(nodes, () => {
      if (!pendingMoveOut) return;
      pendingMoveOut = false;
      nodes.set("doc-1",
        { id: "doc-1", mimeType: DOC_MIME, parents: ["elsewhere"], trashed: false });
    });
    using session = folderSession(nodes).session;
    using doc = await session.openGoogleDoc("doc-1");

    await expect(Promise.resolve(doc.getContent())).rejects.toThrow(OUTSIDE);
    nodes.set("doc-1", { id: "doc-1", mimeType: DOC_MIME, parents: [ROOT], trashed: false });
    nativeCalls.length = 0;

    await expect(Promise.resolve(doc.getContent())).resolves.toBe("");
    expect(nativeCalls).toEqual(["docs.googleapis.com"]);
  });

  // Reads issued together share one fetch, so no refusal among them may leave that revision
  // reusable by a later read.
  it("leaves nothing reusable when a shared fetch is refused", async () => {
    const nodes = subtree();
    let pendingMoveOut = true;
    const nativeCalls = installFolderProvider(nodes, () => {
      if (!pendingMoveOut) return;
      pendingMoveOut = false;
      nodes.set("doc-1",
        { id: "doc-1", mimeType: DOC_MIME, parents: ["elsewhere"], trashed: false });
    });
    using session = folderSession(nodes).session;
    using doc = await session.openGoogleDoc("doc-1");

    const settled = await Promise.allSettled(
      [Promise.resolve(doc.listTabs()), Promise.resolve(doc.getContent())]);
    expect(settled.map(result => result.status)).toEqual(["rejected", "rejected"]);

    nodes.set("doc-1", { id: "doc-1", mimeType: DOC_MIME, parents: [ROOT], trashed: false });
    nativeCalls.length = 0;

    await expect(Promise.resolve(doc.getContent())).resolves.toBe("");
    expect(nativeCalls).toEqual(["docs.googleapis.com"]);
  });

  it("keeps child-folder and native capabilities alive after their parents are disposed", async () => {
    const nodes = subtree();
    nodes.set("nested", {
      id: "nested", mimeType: FOLDER_MIME, parents: [ROOT], trashed: false,
      capabilities: { canListChildren: true },
    });
    nodes.set("nested-doc", {
      id: "nested-doc", mimeType: DOC_MIME, parents: ["nested"], trashed: false,
    });
    installFolderProvider(nodes);
    const parent = folderSession(nodes).session;
    const child = await parent.openFolder("nested");
    parent[Symbol.dispose]();
    const doc = await child.openGoogleDoc("nested-doc");
    child[Symbol.dispose]();
    using ownedDoc = doc;

    await expect(Promise.resolve(ownedDoc.getContent())).resolves.toBe("");
  });

  it("reads a direct-child PDF, checking its place around the download", async () => {
    const nodes = subtree();
    nodes.set("pdf-1", { id: "pdf-1", mimeType: PDF_MIME, parents: [ROOT], trashed: false });
    const nativeCalls = installFolderProvider(nodes);
    const converter = fakeConverter();
    const { queue, session } = folderSession(nodes, converter.convert);
    using owned = session;

    expect(await readText(await owned.readPdf("pdf-1")))
      .toEqual({ text: PDF_MARKDOWN, hasText: true });
    expect(nativeCalls).toEqual(["download"]);
    expect(queue.observations.map(o => o.title))
      .toEqual(["Open PDF from Google Drive", "Read PDF from Google Drive"]);
  });

  it("refuses a PDF moved out of the folder during the download, authorizing no read", async () => {
    const nodes = subtree();
    nodes.set("pdf-1", { id: "pdf-1", mimeType: PDF_MIME, parents: [ROOT], trashed: false });
    installFolderProvider(nodes, () => {
      nodes.set("pdf-1", { id: "pdf-1", mimeType: PDF_MIME, parents: ["elsewhere"], trashed: false });
    });
    const converter = fakeConverter();
    const { queue, session } = folderSession(nodes, converter.convert);
    using owned = session;

    await expect(Promise.resolve(owned.readPdf("pdf-1"))).rejects.toThrow(OUTSIDE);
    expect(queue.observations.map(o => o.title)).toEqual(["Open PDF from Google Drive"]);
    expect(converter.converted).toEqual([PDF_BYTES]);
    expect(converter.state.cancelled).toBe(1);
  });

  it("refuses a PDF outside the folder without downloading it", async () => {
    const nodes = subtree();
    nodes.set("pdf-1", { id: "pdf-1", mimeType: PDF_MIME, parents: ["elsewhere"], trashed: false });
    const nativeCalls = installFolderProvider(nodes);
    const converter = fakeConverter();
    using session = folderSession(nodes, converter.convert).session;

    await expect(Promise.resolve(session.readPdf("pdf-1"))).rejects.toThrow(OUTSIDE);
    expect(nativeCalls).toEqual([]);
    expect(converter.converted).toEqual([]);
  });

  it("reads PDFs from an opened child folder", async () => {
    const nodes = subtree();
    nodes.set("nested", {
      id: "nested", mimeType: FOLDER_MIME, parents: [ROOT], trashed: false,
      capabilities: { canListChildren: true },
    });
    nodes.set("nested-pdf", { id: "nested-pdf", mimeType: PDF_MIME, parents: ["nested"], trashed: false });
    installFolderProvider(nodes);
    using session = folderSession(nodes, fakeConverter().convert).session;
    using child = await session.openFolder("nested");

    expect(await readText(await child.readPdf("nested-pdf")))
      .toEqual({ text: PDF_MARKDOWN, hasText: true });
  });

  it("refuses to open a native file that is already outside the subtree", async () => {
    const nodes = subtree();
    nodes.set("doc-1", { id: "doc-1", mimeType: DOC_MIME, parents: ["elsewhere"], trashed: false });
    installFolderProvider(nodes);
    using session = folderSession(nodes).session;

    await expect(Promise.resolve(session.openGoogleDoc("doc-1")))
      .rejects.toThrow(OUTSIDE);
  });

  // The folder provider answers every download with PDF_BYTES whole, as Drive may for a range that
  // starts at the beginning, so these read whole files.
  function dataNode(parent: string) {
    return {
      id: "data-1", mimeType: "application/octet-stream", parents: [parent], trashed: false,
      size: String(PDF_BYTES.byteLength),
    };
  }

  it("reads a direct child's bytes, checking its place around the download", async () => {
    const nodes = subtree();
    nodes.set("data-1", dataNode(ROOT));
    const nativeCalls = installFolderProvider(nodes);
    const { queue, session } = folderSession(nodes);
    using owned = session;

    expect(new Uint8Array((await owned.readFile("data-1")).content)).toEqual(PDF_BYTES);
    expect(nativeCalls).toEqual(["download"]);
    expect(queue.observations.map(o => o.title))
      .toEqual(["Open file from Google Drive", "Read file from Google Drive"]);
  });

  // The move lands while the last bytes are still on their way, so only a re-proof taken after the
  // whole range has arrived can see it: one taken when the download merely starts would pass.
  it("refuses bytes from a file moved out of the folder before its last byte arrived", async () => {
    const nodes = subtree();
    nodes.set("data-1", dataNode(ROOT));
    installFolderProvider(nodes, undefined, () => nodes.set("data-1", dataNode("elsewhere")));
    const { queue, session } = folderSession(nodes);
    using owned = session;

    await expect(Promise.resolve(owned.readFile("data-1"))).rejects.toThrow(OUTSIDE);
    expect(queue.observations.map(o => o.title)).toEqual(["Open file from Google Drive"]);
  });

  // Its size is unchanged, so only the modification time the re-proof reads can show the rewrite.
  it("refuses bytes from a file rewritten at the same size during the download", async () => {
    const nodes = subtree();
    nodes.set("data-1", dataNode(ROOT));
    installFolderProvider(nodes, undefined, () =>
      nodes.set("data-1", { ...dataNode(ROOT), modifiedTime: "2026-08-21T09:00:00Z" }));
    const { queue, session } = folderSession(nodes);
    using owned = session;

    await expect(Promise.resolve(owned.readFile("data-1"))).rejects.toThrow(
      "The Drive file changed while it was being read; read it again.");
    expect(queue.observations.map(o => o.title)).toEqual(["Open file from Google Drive"]);
  });

  it("refuses a file outside the folder without downloading it", async () => {
    const nodes = subtree();
    nodes.set("data-1", dataNode("elsewhere"));
    const nativeCalls = installFolderProvider(nodes);
    using session = folderSession(nodes).session;

    await expect(Promise.resolve(session.readFile("data-1"))).rejects.toThrow(OUTSIDE);
    expect(nativeCalls).toEqual([]);
  });

  it("reads files from an opened child folder", async () => {
    const nodes = subtree();
    nodes.set("nested", {
      id: "nested", mimeType: FOLDER_MIME, parents: [ROOT], trashed: false,
      capabilities: { canListChildren: true },
    });
    nodes.set("data-1", dataNode("nested"));
    installFolderProvider(nodes);
    using session = folderSession(nodes).session;
    using child = await session.openFolder("nested");

    expect(new Uint8Array((await child.readFile("data-1")).content)).toEqual(PDF_BYTES);
  });
});
