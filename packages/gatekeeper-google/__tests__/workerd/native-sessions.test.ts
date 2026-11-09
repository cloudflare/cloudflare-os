import { env } from "cloudflare:test";
import { RpcStub, RpcTarget } from "cloudflare:workers";
import type {
  ActionDescription, ApprovalQueue, GitCache, HookController, HookDescription,
  ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleDocsApi } from "../../src/docs-api";
import { DriveApi } from "../../src/drive-api";
import type { DriveQueue } from "../../src/drive-actions";
import { FILE_READ_IDLE_MS } from "../../src/drive-file-read";
import type { DriveBindingScope } from "../../src/drive-session";
import type { PdfConverter } from "../../src/drive-pdf";
import { GoogleDriveSessionImpl } from "../../src/google";
import type {
  DriveComment, DrivePdfText, DriveSessionSearchQuery, GoogleDriveFolderSession,
} from "../../src/drive-types";
import {
  DRIVE_WRITES_GRANT, GOOGLE_DRIVE_RESOURCE, type DriveAccessLevel,
} from "../../src/resources";
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

/** Everything a file read's stream carries. */
async function bytesOf(read: { content: ReadableStream<Uint8Array> }): Promise<Uint8Array> {
  return new Uint8Array(await new Response(read.content).arrayBuffer());
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

/** A comment queue for sessions these tests never comment through. */
const NO_COMMENTS: DriveQueue = {
  access: "read",
  writeRefusal: async () => "Unexpected comment write",
  actor: async () => { throw new Error("Unexpected identity read"); },
  submit: async () => { throw new Error("Unexpected comment submission"); },
  undecided: read => read([]),
  waiting: read => read([]),
};

/** The refusal of a write on a read-only folder or file binding, which ends with the URL to request. */
const READ_ONLY = (url: string) =>
  "This Google Drive connection is read-only, so it cannot make changes. Changes take a " +
  "connection with read and write access, which the user chooses when connecting. Request one " +
  `with this resource URL: ${url}`;

/** The same on an all-of-Drive binding, which names the narrower connections first. */
const READ_ONLY_ACCOUNT =
  "This Google Drive connection is read-only, so it cannot make changes. Changes take a " +
  "connection with read and write access, which the user chooses when connecting. To change " +
  "one file, or the files of one folder, request the narrower " +
  "https://drive.google.com/file/d/<fileId>/view?access=write or " +
  "https://drive.google.com/drive/folders/<folderId>?access=write instead. For all of Drive, " +
  "request this resource URL: https://drive.google.com/drive/my-drive?access=write";

/** The refusal for the file `view-only`, which the connected account can only view. */
const VIEW_ONLY =
  "The connected account can only view Drive file view-only. Google shows a file's comments " +
  "only to accounts that can comment on it, so this file's comments cannot be read or added to " +
  "here.";

/** The refusal for a comment listing by an account that cannot read file content. */
const RECONNECT =
  "This Google account was connected before Drive bindings could read file content. Reconnect " +
  "it in Workshop to read comments.";

/** The refusal for a reply to, or a resolve of, the `pending:` ID of a comment that still waits. */
const STILL_PENDING = "That comment is waiting for approval; reply to it once it is posted.";

/** The refusal for a reply to, or a resolve of, a `pending:` ID that names no waiting comment. */
const PENDING_DECIDED = "That pending ID names no comment waiting for approval. If its comment " +
  "was posted, list the file's comments again and use the comment's Drive ID.";

function newSession(
  convertPdf?: PdfConverter, scope: DriveBindingScope = { kind: "account" },
) {
  const queue = new TestApprovalQueue();
  const queueStub: RpcStub<ApprovalQueue> = new RpcStub(queue);
  return {
    queue,
    session: new RpcStub(new GoogleDriveSessionImpl(
      new DriveApi(getAccessToken),
      new GoogleDocsApi(getAccessToken),
      new GoogleSheetsApi(getAccessToken),
      new GoogleSlidesApi(getAccessToken),
      convertPdf,
      scope,
      queueStub,
      NO_COMMENTS,
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
      id: "doc-1",
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
    expect(queue.observations.map(o => [o.title, o.subresources])).toEqual([
      ["Open Google Slides presentation from Google Drive", ["drive/file/deck-1"]],
      ["Read Google Slides presentation outline", ["slides/presentation/deck-1"]],
      ["Read one Google Slides slide", ["slides/presentation/deck-1"]],
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
      id: "doc-1", title: "Quarterly plan",
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
    const { queue, session } = newSession(converter.convert);
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
    expect(queue.observations.map(({ title, description, subresources }) =>
      ({ title, description, subresources }))).toEqual([
      {
        title: "Open PDF from Google Drive",
        description: "Check current metadata for Drive file pdf-1 and open it as a PDF.",
        subresources: ["drive/file/pdf-1"],
      },
      // The text is the file's content, so a collaborator needs leave to download the PDF to see it.
      {
        title: "Read PDF from Google Drive",
        description: "Read the text of Drive file pdf-1.",
        subresources: ["drive/content/pdf-1"],
      },
    ]);
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

  /** The size of a file too large to be worth holding, served only as a stream a test supplies. */
  const BIG = 64 * 1024 * 1024;
  type ProviderFile = { mimeType: string; content?: Uint8Array; size?: number; canDownload?: boolean };
  const FILES: Record<string, ProviderFile> = {
    "csv-1": { mimeType: "text/csv", content: CSV_BYTES },
    "empty-1": { mimeType: "text/plain", content: new Uint8Array() },
    "big-1": { mimeType: "application/octet-stream", content: new Uint8Array(4_000_010) },
    "stream-1": { mimeType: "application/octet-stream", size: BIG },
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
        ...file.size === undefined ? {} : { size: String(file.size) },
        ...file.canDownload === undefined ? {} : { capabilities: { canDownload: file.canDownload } },
      });
    }));
    return urls;
  }

  beforeEach(() => {
    providerUrls = installFileProvider();
  });

  it("streams a whole small file, authorizing the read before returning it", async () => {
    const { queue, session } = newSession();
    using owned = session;

    const read = await owned.readFile("csv-1");

    expect(read).toEqual({
      mimeType: "text/csv",
      size: CSV_BYTES.byteLength,
      modifiedTime: new Date("2026-08-20T12:00:00Z"),
      offset: 0,
      length: CSV_BYTES.byteLength,
      content: expect.any(ReadableStream),
    });
    expect(await new Response(read.content).text()).toBe("region,amount\nEMEA,120\nAPAC,95\n");
    expect(downloads).toEqual([`bytes=0-${CSV_BYTES.byteLength - 1}`]);
    expect(queue.observations.map(({ title, description, subresources }) =>
      ({ title, description, subresources }))).toEqual([
      {
        title: "Open file from Google Drive",
        description: "Check current metadata for Drive file csv-1 and open it as a file.",
        subresources: ["drive/file/csv-1"],
      },
      // The bytes are the file's content, so a collaborator needs leave to download it to see them.
      {
        title: "Read file from Google Drive",
        description: `Read ${CSV_BYTES.byteLength} bytes of Drive file csv-1, from byte 0.`,
        subresources: ["drive/content/csv-1"],
      },
    ]);
  });

  it("reads a range of a file, clamping one that runs past its end", async () => {
    using session = newSession().session;
    const size = CSV_BYTES.byteLength;

    const middle = await session.readFile("csv-1", { offset: 7, length: 6 });
    const last = await session.readFile("csv-1", { offset: size - 4, length: 100 });

    expect(middle).toEqual(expect.objectContaining({ offset: 7, length: 6 }));
    expect(await bytesOf(middle)).toEqual(CSV_BYTES.slice(7, 13));
    expect(last.length).toBe(4);
    expect(await bytesOf(last)).toEqual(CSV_BYTES.slice(size - 4));
    expect(downloads).toEqual(["bytes=7-12", `bytes=${size - 4}-${size - 1}`]);
  });

  it("returns no bytes at the end of a file, or of an empty one, without downloading", async () => {
    using session = newSession().session;

    const atEnd = await session.readFile("csv-1", { offset: CSV_BYTES.byteLength });
    const empty = await session.readFile("empty-1");

    expect(atEnd.length).toBe(0);
    expect(await bytesOf(atEnd)).toHaveLength(0);
    expect(empty).toEqual(expect.objectContaining({ size: 0, offset: 0, length: 0 }));
    expect(await bytesOf(empty)).toHaveLength(0);
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
    [{ length: 0 }, "length must be a whole number of bytes, at least 1."],
    [{ length: 2.5 }, "length must be a whole number of bytes, at least 1."],
  ])("refuses the range %o before contacting Google", async (options, message) => {
    const { queue, session } = newSession();
    using owned = session;

    await expect(Promise.resolve(owned.readFile("csv-1", options))).rejects.toThrow(message);
    expect(providerUrls).toEqual([]);
    expect(queue.observations).toEqual([]);
  });

  it("reads a file of any size whole when no length is given", async () => {
    using session = newSession().session;

    const whole = await session.readFile("big-1");

    expect(whole.length).toBe(4_000_010);
    expect(await bytesOf(whole)).toHaveLength(4_000_010);
    expect(downloads).toEqual(["bytes=0-4000009"]);
  });

  /** An answer of `chunks` 64 KiB chunks, counting how many Drive was asked for. */
  function chunkedAnswer(chunks: number) {
    const state = { pulls: 0, cancelled: false };
    const chunk = new Uint8Array(65_536);
    const answer = () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (state.pulls++ < chunks) controller.enqueue(chunk);
        else controller.close();
      },
      cancel() {
        state.cancelled = true;
      },
    }, { highWaterMark: 0 }), {
      status: 206, headers: { "Content-Range": `bytes 0-${BIG - 1}/${BIG}` },
    });
    return { state, answer };
  }

  // The file leaves Drive as the caller reads it: RPC reads a little ahead of an idle caller and
  // then waits, so what is held here does not grow with the file.
  it("reads little of an unread stream from Drive, and stops when it is cancelled", async () => {
    const { state, answer } = chunkedAnswer(BIG / 65_536);
    answerDownload = answer;
    using session = newSession().session;

    const read = await session.readFile("stream-1");
    await scheduler.wait(100);
    expect(state.pulls).toBeLessThan(8);

    const reader = read.content.getReader();
    expect((await reader.read()).value?.byteLength).toBeGreaterThan(0);
    await reader.cancel();
    await vi.waitFor(() => expect(state.cancelled).toBe(true));
    expect(state.pulls).toBeLessThan(BIG / 65_536);
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
    ["grew, by a range's total", () => new Response(grown.slice(0, n), {
      status: 206, headers: { "Content-Range": `bytes 0-${n - 1}/${grown.byteLength}` },
    })],
    ["grew, by a whole-file answer's length", () => new Response(grown, {
      headers: { "Content-Length": String(grown.byteLength) },
    })],
    ["shrank, by a whole-file answer's length", () => new Response(shrunk, {
      headers: { "Content-Length": String(shrunk.byteLength) },
    })],
    ["shrank, by a range of unknown total that ends early", () => new Response(shrunk, {
      status: 206, headers: { "Content-Range": `bytes 0-${n - 2}/*` },
    })],
    ["is unchanged, of a range that ends early all the same", () => new Response(shrunk, {
      status: 206, headers: { "Content-Range": `bytes 0-${n - 2}/${n}` },
    })],
  ])("withholds every byte when Drive says the file %s", async (_name, answer) => {
    answerDownload = answer;
    const { queue, session } = newSession();
    using owned = session;

    await expect(Promise.resolve(owned.readFile("csv-1"))).rejects.toThrow(
      "The Drive file changed while it was being read; read it again.");
    expect(queue.observations.map(o => o.title)).toEqual(["Open file from Google Drive"]);
  });

  // Its headers promise the whole range, so only the stream can say otherwise: it fails in place
  // of ending short. Over RPC the failure arrives as a broken stream, without the refusal's words.
  it("fails the stream, after the bytes it had, when the answer ends inside its range", async () => {
    answerDownload = () => new Response(shrunk, {
      status: 206, headers: { "Content-Range": `bytes 0-${n - 1}/${n}` },
    });
    using session = newSession().session;

    const read = await session.readFile("csv-1");
    expect(read.length).toBe(n);
    const reader = read.content.getReader();
    const delivered: number[] = [];
    const failure = await (async () => {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return undefined;
        delivered.push(...chunk.value);
      }
    })().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(new Uint8Array(delivered)).toEqual(shrunk);
  });

  it("withholds the stream when its read is not authorized, ending the download", async () => {
    const { state, answer } = chunkedAnswer(1);
    answerDownload = answer;
    const { queue, session } = newSession();
    using owned = session;
    queue.refuse.add("Read file from Google Drive");

    await expect(Promise.resolve(owned.readFile("stream-1"))).rejects.toThrow("Observation refused");
    expect(downloads).toHaveLength(1);
    expect(state.cancelled).toBe(true);
  });

  // An agent that drops a stream without cancelling it must not hold its download for good.
  it("ends a stream left unread for a minute, letting its download go", async () => {
    const { state, answer } = chunkedAnswer(BIG / 65_536);
    answerDownload = answer;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    using session = newSession().session;
    const read = await session.readFile("stream-1");

    await vi.advanceTimersByTimeAsync(FILE_READ_IDLE_MS - 1_000);
    expect(state.cancelled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    vi.useRealTimers();

    await vi.waitFor(() => expect(state.cancelled).toBe(true));
    await expect(bytesOf(read)).rejects.toThrow();
  });

  // The stream's wait starts when it is handed over. Were it to start with the download, a slow
  // authorization would use it up, and the read would return a stream already ended.
  it("does not count a slow authorization against the stream it returns", async () => {
    const { queue, session } = newSession();
    using owned = session;
    const authorized = Promise.withResolvers<void>();
    queue.holds.set("Read file from Google Drive", authorized.promise);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

    const pending = Promise.resolve(owned.readFile("csv-1"));
    await scheduler.wait(50);
    expect(downloads).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2 * FILE_READ_IDLE_MS);
    authorized.resolve();
    const read = await pending;
    vi.useRealTimers();

    expect(await bytesOf(read)).toEqual(CSV_BYTES);
  });

  // Nothing limits how many a binding reads at once: an open stream costs it a chunk, not a file.
  it("opens as many reads at once as are asked for", async () => {
    using session = newSession().session;

    const reads = await Promise.all(Array.from({ length: 12 }, () => session.readFile("csv-1")));

    expect(downloads).toHaveLength(12);
    for (const read of reads) expect(await bytesOf(read)).toEqual(CSV_BYTES);
  });

  it("reads the bound file of an exact-file binding", async () => {
    using session = newSession(undefined, { kind: "file", fileId: "csv-1" }).session;

    expect(await bytesOf(await session.readFile("csv-1"))).toEqual(CSV_BYTES);
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
   * Answers downloads with PDF_BYTES whole, in two chunks pulled one at a time. `onNativeRead`
   * runs as Google is asked, so a change it makes lands before Google begins its answer;
   * `onLastChunk` runs just before the second chunk is sent, so one it makes lands while the body
   * is still being read.
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
          cancel() {
            nativeCalls.push("download cancelled");
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
        { kind: "folder", folderId: ROOT },
        new RpcStub(queue),
        NO_COMMENTS,
      )),
    };
  }

  const OUTSIDE = "The requested file is outside this Drive binding.";

  it("serves Doc and Sheet reads while the files remain in the subtree", async () => {
    const nodes = subtree();
    installFolderProvider(nodes);
    const { queue, session: owned } = folderSession(nodes);
    using session = owned;

    using doc = await session.openGoogleDoc("doc-1");
    expect((await doc.getMetadata()).title).toBe("doc-1");
    expect(await doc.getContent()).toBe("");
    expect(queue.observations.slice(-2).map(o => o.subresources)).toEqual([
      [`drive/folder/${ROOT}`, "drive/file/doc-1", "docs/document/doc-1"],
      [`drive/folder/${ROOT}`, "drive/file/doc-1", "docs/document/doc-1"],
    ]);

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
    expect(queue.observations.map(o => [o.title, o.subresources])).toEqual([
      ["Open PDF from Google Drive", [`drive/folder/${ROOT}`, "drive/file/pdf-1"]],
      ["Read PDF from Google Drive",
        [`drive/folder/${ROOT}`, "drive/file/pdf-1", "drive/content/pdf-1"]],
    ]);
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

    expect(await bytesOf(await owned.readFile("data-1"))).toEqual(PDF_BYTES);
    expect(nativeCalls).toEqual(["download"]);
    expect(queue.observations.map(o => [o.title, o.subresources])).toEqual([
      ["Open file from Google Drive", [`drive/folder/${ROOT}`, "drive/file/data-1"]],
      ["Read file from Google Drive",
        [`drive/folder/${ROOT}`, "drive/file/data-1", "drive/content/data-1"]],
    ]);
  });

  // The move lands after the file was opened, so only a re-proof taken once Drive is asked for the
  // bytes can see it.
  it("refuses bytes from a file moved out of the folder before Drive answered", async () => {
    const nodes = subtree();
    nodes.set("data-1", dataNode(ROOT));
    const nativeCalls = installFolderProvider(
      nodes, () => nodes.set("data-1", dataNode("elsewhere")));
    const { queue, session } = folderSession(nodes);
    using owned = session;

    await expect(Promise.resolve(owned.readFile("data-1"))).rejects.toThrow(OUTSIDE);
    expect(queue.observations.map(o => o.title)).toEqual(["Open file from Google Drive"]);
    // The answer Drive had begun is let go unread.
    expect(nativeCalls).toEqual(["download", "download cancelled"]);
  });

  // Its size is unchanged, so only the modification time the re-proof reads can show the rewrite.
  it("refuses bytes from a file rewritten at the same size before Drive answered", async () => {
    const nodes = subtree();
    nodes.set("data-1", dataNode(ROOT));
    const nativeCalls = installFolderProvider(nodes, () =>
      nodes.set("data-1", { ...dataNode(ROOT), modifiedTime: "2026-08-21T09:00:00Z" }));
    const { queue, session } = folderSession(nodes);
    using owned = session;

    await expect(Promise.resolve(owned.readFile("data-1"))).rejects.toThrow(
      "The Drive file changed while it was being read; read it again.");
    expect(queue.observations.map(o => o.title)).toEqual(["Open file from Google Drive"]);
    expect(nativeCalls).toEqual(["download", "download cancelled"]);
  });

  // The file was in the folder when Drive began its answer, so the rest of that answer is still
  // read. This takes it that Drive answers from the revision current when it began, which
  // nothing here checks.
  it("finishes a stream whose file leaves the folder after Drive began answering", async () => {
    const nodes = subtree();
    nodes.set("data-1", dataNode(ROOT));
    installFolderProvider(nodes, undefined, () => nodes.set("data-1", dataNode("elsewhere")));
    using session = folderSession(nodes).session;

    expect(await bytesOf(await session.readFile("data-1"))).toEqual(PDF_BYTES);
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

    expect(await bytesOf(await child.readFile("data-1"))).toEqual(PDF_BYTES);
  });
});

/** The text of headedDoc()'s tab from index 1, where a tab's text starts. */
const HEADED_TEXT = "Plan\nLaunch\nThe launch is in May.\nWe ship in May and June.\n";

/** The text of headedDoc()'s tab in `range`. */
function headedText(range: { startIndex: number; endIndex: number }): string {
  return HEADED_TEXT.slice(range.startIndex - 1, range.endIndex - 1);
}

/** A Docs API refusal, as Google answers one. */
function docsError(status: number, rpc: string, message: string): Response {
  return Response.json({ error: { code: status, status: rpc, message } }, { status });
}

/** A Doc whose second paragraph is the heading the quoted text sits under. */
function headedDoc() {
  let tab = buildTab([
    { runs: ["Plan\n"], namedStyleType: "TITLE" },
    { runs: ["Launch\n"], namedStyleType: "HEADING_1" },
    { runs: ["The launch is in May.\n"] },
    { runs: ["We ship in May and June.\n"] },
  ]);
  let [, title, heading] = tab.body.content;
  if (!title.paragraph || !heading.paragraph) throw new Error("The fixture built no headings.");
  title.paragraph.paragraphStyle.headingId = "h.title";
  heading.paragraph.paragraphStyle.headingId = "h.launch";
  return {
    documentId: "doc-1", title: "Plan", revisionId: "revision-1",
    tabs: [{
      tabProperties: { tabId: "t.0", title: "Tab 1" },
      documentTab: { body: tab.body, lists: {}, namedRanges: {} },
      childTabs: [],
    }],
  };
}

/** Records the grants the test user's Google account holds. */
function grant(patterns: string[]): Promise<void> {
  return env.TEST_HOOKS.getByName("grants").setDriveGrants(patterns);
}

// Comment writes through the Drive gatekeeper itself: queued by a session, then applied or
// rejected by the gatekeeper, against a Drive that answers as Google was seen to.
describe("Drive comment actions", () => {
  const ROOT = "folder-root";
  const GRANTED = [GOOGLE_DRIVE_RESOURCE.urlPattern, DRIVE_WRITES_GRANT];
  const GRANT_MISSING =
    "Changes need a permission this Google account hasn't granted, or no longer grants. In " +
    "Workshop, start adding a Google Drive connection for this account, choose all of Drive or a " +
    "folder, then \"Read and write\", and select \"Allow changes\". The permission covers every " +
    "read and write Drive connection on the account, so the dialog can then be closed.";
  const UNCONFIRMED =
    "Google Drive did not confirm whether this was posted, and it may have been. Approving it " +
    "again first checks the file's comments, so it is not posted twice; rejecting it leaves " +
    "anything already posted on the file.";
  const OUTSIDE = "The requested file is outside this Drive binding.";
  const ME = { displayName: "Test User", me: true };
  const ADA = { displayName: "Ada Lovelace", me: false };

  type FakeFile = { mimeType: string; parents: string[]; canComment: boolean };
  type FakeReply = {
    id: string; content: string; author: typeof ME; createdTime: string; modifiedTime: string;
    deleted: boolean; action?: "resolve" | "reopen";
  };
  type FakeComment = {
    id: string; content: string; author: typeof ME; createdTime: string; modifiedTime: string;
    deleted: boolean; replies: FakeReply[];
    /** Absent until the comment is first resolved, as Drive sends it. */
    resolved?: boolean;
    /** The passage a comment made in an editor on a selection is attached to, as Drive sends it. */
    quotedFileContent?: { mimeType: string; value: string };
  };
  type Refusal = { status: number; reason: string; message: string };

  function driveError({ status, reason, message }: Refusal, location?: string): Response {
    return Response.json({
      error: {
        code: status, message,
        errors: [{ message, domain: "global", reason, ...location ? { location, locationType: "parameter" } : {} }],
      },
    }, { status });
  }

  /** Google Drive's files, comments and replies as far as these tests need them, and one Doc. */
  class CommentsProvider {
    readonly files = new Map<string, FakeFile>([
      // Drive says a folder can be commented on, and then answers the comment with a server error.
      [ROOT, { mimeType: FOLDER_MIME, parents: ["above"], canComment: true }],
      ["inner", { mimeType: FOLDER_MIME, parents: [ROOT], canComment: true }],
      ["doc-1", { mimeType: DOC_MIME, parents: [ROOT], canComment: true }],
      ["sheet-1", { mimeType: SHEET_MIME, parents: [ROOT], canComment: true }],
      ["nested-doc", { mimeType: DOC_MIME, parents: ["inner"], canComment: true }],
      ["view-only", { mimeType: DOC_MIME, parents: [ROOT], canComment: false }],
    ]);
    readonly comments = new Map<string, FakeComment[]>();
    /** Every request, as `METHOD path`. */
    readonly requests: string[] = [];
    /** Every comment or reply write, with the field mask it asked to read back. */
    readonly writes: { path: string; fields: string | null; body: Record<string, unknown> }[] = [];
    /** How the next write answers: `lost` posts it and still answers 400; a refusal posts nothing. */
    nextWrite?: "lost" | Refusal;
    /** How every listing of a file's comments answers, when set. */
    listRefusal?: Refusal;
    /** Every Docs `batchUpdate` body, as sent. */
    readonly docsWrites: Record<string, unknown>[] = [];
    /** The suggestions made in `doc-1`, as Docs lists them. */
    readonly suggestions: { suggestionId: string; summaryText: string; createTime: string; replies: string[] }[] = [];
    /** The Doc's revision, which every Docs write moves, as Google's do. */
    revision = 1;
    #ids = 0;

    install(): this {
      vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
        this.#handle(new Request(input, init))));
      return this;
    }

    /** A comment by someone else, already on `fileId`. */
    seed(fileId: string, comment: Partial<FakeComment> = {}): FakeComment {
      let now = new Date().toISOString();
      let seeded: FakeComment = {
        id: this.#id(), content: "Is this date right?", author: ADA, createdTime: now,
        modifiedTime: now, deleted: false, replies: [], ...comment,
      };
      this.#list(fileId).push(seeded);
      return seeded;
    }

    /** Comments `fileId` shows, deleted ones left out. */
    live(fileId: string): FakeComment[] {
      return this.#list(fileId).filter(comment => !comment.deleted);
    }

    #list(fileId: string): FakeComment[] {
      let list = this.comments.get(fileId);
      if (!list) this.comments.set(fileId, list = []);
      return list;
    }

    #id(): string {
      return `doco.${String(++this.#ids).padStart(22, "A")}`;
    }

    #fileJson(id: string, file: FakeFile) {
      return {
        id, name: id, mimeType: file.mimeType, modifiedTime: "2026-10-20T09:00:00Z",
        parents: file.parents, trashed: false,
        capabilities: { canListChildren: file.mimeType === FOLDER_MIME, canComment: file.canComment },
      };
    }

    #batch(body: string): Response {
      let boundary = "comments_batch";
      let ids = [...body.matchAll(/GET \/drive\/v3\/files\/([^?]+)\?/g)]
        .map(match => decodeURIComponent(match[1]));
      let parts = ids.map((id, index) => {
        let file = this.files.get(id);
        return [
          `--${boundary}`, "Content-Type: application/http", `Content-ID: <response-item-${index}>`,
          "", file ? "HTTP/1.1 200 OK" : "HTTP/1.1 404 Not Found", "Content-Type: application/json",
          "", file ? JSON.stringify(this.#fileJson(id, file)) : "{}",
        ].join("\r\n");
      });
      return new Response(`${parts.join("\r\n")}\r\n--${boundary}--\r\n`, {
        headers: { "Content-Type": `multipart/mixed; boundary=${boundary}` },
      });
    }

    async #handle(request: Request): Promise<Response> {
      let url = new URL(request.url);
      this.requests.push(`${request.method} ${url.pathname}`);
      if (url.pathname === "/batch/drive/v3") {
        return this.#batch(new TextDecoder().decode(await request.arrayBuffer()));
      }
      if (url.hostname === "docs.googleapis.com") return this.#docs(url, request);
      let match = /^\/drive\/v3\/files\/([^/]+)(\/comments(?:\/([^/]+)(\/replies)?)?)?$/
        .exec(url.pathname);
      if (!match) throw new Error(`Unexpected provider request: ${url}`);
      let [, rawFileId, commentsPath, rawCommentId, repliesPath] = match;
      let fileId = decodeURIComponent(rawFileId);
      let file = this.files.get(fileId);
      if (!file) {
        return driveError({ status: 404, reason: "notFound", message: `File not found: ${fileId}.` },
          "fileId");
      }
      if (!commentsPath) return Response.json(this.#fileJson(fileId, file));
      if (rawCommentId === undefined) {
        if (request.method === "POST") {
          return this.#write(url, request, fileId, file, body => this.#createComment(fileId, body));
        }
        if (this.listRefusal) return driveError(this.listRefusal);
        // As Google answers an account that can only view the file: none of its comments, its
        // own included, and no error.
        if (!file.canComment) return Response.json({ comments: [] });
        let since = url.searchParams.get("startModifiedTime");
        return Response.json({
          comments: this.live(fileId)
            .filter(comment => since === null || Date.parse(comment.modifiedTime) >= Date.parse(since))
            .map(wireComment),
        });
      }
      let commentId = decodeURIComponent(rawCommentId);
      let comment = this.live(fileId).find(candidate => candidate.id === commentId);
      if (!comment) {
        return driveError({
          status: 404, reason: "notFound", message: `Comment not found: ${commentId}.`,
        }, "commentId");
      }
      if (!repliesPath) return Response.json(wireComment(comment));
      if (request.method === "POST") {
        return this.#write(url, request, fileId, file, body => this.#createReply(comment, body));
      }
      return Response.json({ replies: comment.replies.filter(reply => !reply.deleted).map(wireReply) });
    }

    async #write(
      url: URL, request: Request, fileId: string, file: FakeFile,
      post: (body: Record<string, unknown>) => unknown,
    ): Promise<Response> {
      let body = await request.json() as Record<string, unknown>;
      this.writes.push({ path: url.pathname, fields: url.searchParams.get("fields"), body });
      if (!file.canComment) {
        return driveError({
          status: 403, reason: "insufficientFilePermissions",
          message: `The user does not have sufficient permissions for file ${fileId}.`,
        });
      }
      if (new TextEncoder().encode(String(body.content ?? "")).length > 4096) {
        return driveError({
          status: 403, reason: "commentLengthLimitExceeded",
          message: "Comment content is limited to 4096 bytes in UTF-8 encoding.",
        });
      }
      let outcome = this.nextWrite;
      this.nextWrite = undefined;
      if (outcome !== undefined && outcome !== "lost") return driveError(outcome);
      let created = post(body);
      if (outcome === "lost") {
        return driveError({
          status: 400, reason: "invalidParameter", message: "Invalid field selection notAField",
        }, "fields");
      }
      return Response.json(created);
    }

    /**
     * `doc-1` as Docs serves it, with its suggestions when comments are asked for, and its
     * `batchUpdate`: an anchored comment Drive then lists under the same ID, a suggestion in
     * SUGGEST mode, and a reply on a suggestion, each refused on another revision than the latest.
     */
    async #docs(url: URL, request: Request): Promise<Response> {
      let doc = { ...headedDoc(), revisionId: `revision-${this.revision}` };
      if (request.method === "GET") {
        if (url.searchParams.get("commentsViewMode") !== "COMMENTS_VIEW_MODE_INCLUDED") {
          return Response.json(doc);
        }
        return Response.json({ ...doc, suggestions: this.suggestions.map(suggestion => ({
          suggestionId: suggestion.suggestionId, summaryText: suggestion.summaryText,
          headPost: { content: "", author: { me: true }, createTime: suggestion.createTime },
          replies: suggestion.replies.map(content =>
            ({ content, author: { me: true }, createTime: new Date().toISOString() })),
        })) });
      }
      let body = await request.json() as {
        requests: Record<string, Record<string, unknown>>[];
        writeControl?: { writeMode?: string; requiredRevisionId?: string };
      };
      this.docsWrites.push(body);
      let required = body.writeControl?.requiredRevisionId;
      if (required !== undefined && required !== doc.revisionId) {
        return docsError(400, "INVALID_ARGUMENT", "The required revision ID does not match the latest revision.");
      }
      if (!this.files.get("doc-1")?.canComment) {
        return docsError(403, "PERMISSION_DENIED", "The caller does not have permission");
      }
      let [first, second] = body.requests;
      let now = new Date().toISOString();
      this.revision++;
      if (first.insertComment) {
        let { content, range } = first.insertComment as
          { content: string; range: { startIndex: number; endIndex: number } };
        let comment: FakeComment = {
          id: this.#id(), content, author: ME, createdTime: now, modifiedTime: now, deleted: false,
          replies: [], quotedFileContent: { mimeType: "text/html", value: headedText(range) },
        };
        this.#list("doc-1").push(comment);
        return Response.json({ replies: [{ insertComment: { commentThread: { commentId: comment.id } } }] });
      }
      if (first.addCommentReply) {
        let { suggestionId, post } = first.addCommentReply as { suggestionId: string; post: { content: string } };
        this.suggestions.find(candidate => candidate.suggestionId === suggestionId)?.replies.push(post.content);
        return Response.json({ replies: [{}] });
      }
      if (body.writeControl?.writeMode !== "SUGGEST") throw new Error("An edit was sent as an edit.");
      let old = headedText((first.deleteContentRange as { range: { startIndex: number; endIndex: number } }).range);
      let insert = second?.insertText as { text: string } | undefined;
      let suggestionId = `suggest.${this.#ids++}`;
      this.suggestions.push({
        suggestionId, createTime: now, replies: [],
        summaryText: insert ? `Replace: “${old}” with “${insert.text}”` : `Delete: “${old}”`,
      });
      return Response.json({ replies: body.requests.map(() => ({})),
        suggestionResponses: [{ createdSuggestionIds: [suggestionId] }] });
    }

    #createComment(fileId: string, body: Record<string, unknown>) {
      let now = new Date().toISOString();
      let comment: FakeComment = {
        id: this.#id(), content: String(body.content ?? ""), author: ME, createdTime: now,
        modifiedTime: now, deleted: false, replies: [],
      };
      this.#list(fileId).push(comment);
      return wireComment(comment);
    }

    #createReply(comment: FakeComment, body: Record<string, unknown>) {
      let now = new Date().toISOString();
      // A plain reply to a resolved comment reopens it.
      let action = body.action === "resolve" ? "resolve" as const
        : body.action === "reopen" || comment.resolved ? "reopen" as const : undefined;
      let reply: FakeReply = {
        id: this.#id(), content: String(body.content ?? ""), author: ME, createdTime: now,
        modifiedTime: now, deleted: false, ...action ? { action } : {},
      };
      comment.replies.push(reply);
      comment.modifiedTime = now;
      if (action) comment.resolved = action === "resolve";
      return wireReply(reply);
    }
  }

  function wireReply(reply: FakeReply) {
    return { ...reply, htmlContent: reply.content.replaceAll("\n", "<br>") };
  }

  function wireComment(comment: FakeComment) {
    return {
      ...comment, htmlContent: comment.content.replaceAll("\n", "<br>"),
      replies: comment.replies.map(wireReply),
    };
  }

  /** A method of a Drive session, whichever scope it has. */
  type DriveMethod = keyof GoogleDriveFolderSession;

  let facets = 0;

  /**
   * A Drive binding of `scope`, on a TestHooks object of its own: read and write, unless `access`
   * is `null`, which makes one with no access level. `facet` names an earlier binding's facet, to
   * make a binding over its storage.
   */
  function binding(
    scope: DriveBindingScope = { kind: "account" },
    access: DriveAccessLevel | null = "write",
    facet = `drive-comments-${++facets}`,
  ) {
    let hooks = env.TEST_HOOKS.getByName(facet);
    let props = { scope, ...(access ? { access } : {}) };
    let callIn = (path: string[], method: DriveMethod, ...args: unknown[]) =>
      hooks.callDrive(facet, props, method, args, path);
    let call = (method: DriveMethod, ...args: unknown[]) => callIn([], method, ...args);
    /** The outcome of a call through the folders of `path` that queued a write. */
    let queuedIn = async (path: string[], method: DriveMethod, ...args: unknown[]) => {
      let outcome = await callIn(path, method, ...args);
      if (outcome.error !== undefined) throw new Error(outcome.error);
      let { actionId } = outcome;
      if (actionId === undefined) throw new Error(`${method} queued nothing`);
      return { ...outcome, actionId };
    };
    return {
      facet,
      call,
      callIn,
      queued: (method: DriveMethod, ...args: unknown[]) => queuedIn([], method, ...args),
      queuedIn,
      comments: async (fileId: string) => {
        let outcome = await call("listComments", fileId);
        if (outcome.error !== undefined) throw new Error(outcome.error);
        return (outcome.value as DriveComment[][]).flat();
      },
      apply: (actionId: number) => hooks.applyDrive(facet, props, actionId),
      reject: (actionId: number) => hooks.rejectDrive(facet, props, actionId),
      autoApprovable: () => hooks.driveAutoApprovable(facet, props),
      describe: () => hooks.describeDrive(facet, props),
      types: () => hooks.driveTypes(facet, props),
      orphan: (actionId: number) => hooks.orphanDriveClaim(facet, props, actionId),
      fail: (actionId: number) => hooks.failDriveAction(facet, props, actionId),
      restart: () => hooks.restartDrive(facet),
      attempts: () => hooks.driveAttempts(facet, props),
      age: (actionId: number, ms: number) => hooks.ageDriveAttempt(facet, props, actionId, ms),
    };
  }

  let provider: CommentsProvider;
  beforeEach(async () => {
    provider = new CommentsProvider().install();
    await grant(GRANTED);
  });

  const posts = () => provider.requests.filter(request => request.startsWith("POST /drive/v3/files/"));

  it("declares one auto-approvable kind for every comment write", async () => {
    expect(await binding().autoApprovable()).toEqual([{ tag: "driveComments", label: "Drive comments" }]);
  });

  describe("access level", () => {
    const FOLDER_URL = "https://drive.google.com/drive/folders/folder-root";
    const FILE_URL = "https://drive.google.com/file/d/doc-1/view";

    it("refuses every write on a read-only binding, naming the URL to request, and asks Google nothing", async () => {
      let bindings: [DriveBindingScope, string][] = [
        [{ kind: "account" }, READ_ONLY_ACCOUNT],
        [{ kind: "folder", folderId: ROOT }, READ_ONLY(`${FOLDER_URL}?access=write`)],
        [{ kind: "file", fileId: "doc-1" }, READ_ONLY(`${FILE_URL}?access=write`)],
      ];
      let writes: [DriveMethod, ...unknown[]][] = [
        ["comment", "doc-1", "Hi"],
        ["suggestEdit", "doc-1", "May", "June"],
        ["reply", "doc-1", "doco.x", "Hi"],
        ["resolve", "doc-1", "doco.x"],
      ];

      for (let [scope, message] of bindings) {
        let drive = binding(scope, null);
        for (let [method, ...args] of writes) {
          let refused = await drive.call(method, ...args);

          expect(refused.error, `${scope.kind} ${method}`).toBe(message);
          expect(refused.actionId).toBeUndefined();
          expect(refused.observations).toEqual([]);
        }
      }
      expect(provider.requests).toEqual([]);
    });

    it("names the bound folder's URL from a child folder", async () => {
      let drive = binding({ kind: "folder", folderId: ROOT }, null);

      let refused = await drive.callIn(["inner"], "comment", "nested-doc", "Hi");

      expect(refused.error).toBe(READ_ONLY(`${FOLDER_URL}?access=write`));
      expect(refused.actionId).toBeUndefined();
    });

    it.each<[DriveMethod, unknown[], string]>([
      ["comment", ["doc-1", "Hi", { tabId: "t.0" }],
        "tabId names the tab a quote is in; pass the quote too."],
      ["suggestEdit", ["doc-1", "", "June"], "The text to replace is empty."],
      ["reply", ["doc-1", "pending:3", "Hi"], PENDING_DECIDED],
      ["resolve", ["doc-1", "pending:3"], PENDING_DECIDED],
    ])("refuses a read-only binding's %s before it looks at the arguments", async (method, args, own) => {
      // A read and write binding refuses the argument for its own sake.
      expect((await binding().call(method, ...args)).error).toBe(own);

      let refused = await binding({ kind: "account" }, null).call(method, ...args);

      expect(refused.error).toBe(READ_ONLY_ACCOUNT);
    });

    it("reads any other access value as read-only", async () => {
      let drive = binding({ kind: "account" }, "WRITE" as DriveAccessLevel);

      expect((await drive.call("comment", "doc-1", "Hi")).error).toBe(READ_ONLY_ACCOUNT);
      expect(await drive.autoApprovable()).toEqual([]);
    });

    it("offers a read-only binding no action kind", async () => {
      expect(await binding({ kind: "account" }, null).autoApprovable()).toEqual([]);
    });

    it("lists comments on a read-only binding whose account has not allowed changes", async () => {
      await grant([GOOGLE_DRIVE_RESOURCE.urlPattern]);
      let seeded = provider.seed("doc-1");

      let listed = await binding({ kind: "account" }, null).comments("doc-1");

      expect(listed.map(comment => [comment.id, comment.text]))
        .toEqual([[seeded.id, "Is this date right?"]]);
    });

    it("describes each binding at its level", async () => {
      let account = { kind: "account" } as const;
      let folder = { kind: "folder", folderId: ROOT } as const;
      let file = { kind: "file", fileId: "doc-1" } as const;

      let described = [
        await binding(account, null).describe(), await binding(account).describe(),
        await binding(folder, null).describe(), await binding(folder).describe(),
        await binding(file, null).describe(), await binding(file).describe(),
      ];

      expect(described).toEqual([
        {
          url: "https://drive.google.com/drive/my-drive",
          title: "Google Drive Account",
          snippet: "Read-only: find files anywhere this Google account can read in Drive, read " +
            "native Google Docs, Sheets and Slides, read PDFs' text with readPdf() and any other " +
            "file's bytes with readFile(), and read comments",
          suggestedBindingName: "GOOGLE_DRIVE",
          tsType: "GoogleDriveReadSession",
        },
        {
          url: "https://drive.google.com/drive/my-drive",
          title: "Google Drive Account (read and write)",
          snippet: "Read and write: find files anywhere this Google account can read in Drive, " +
            "read native Google Docs, Sheets and Slides, read PDFs' text with readPdf() and any " +
            "other file's bytes with readFile(), read and queue comments, change who files are " +
            "shared with, and move files",
          suggestedBindingName: "GOOGLE_DRIVE",
          tsType: "GoogleDriveSession",
        },
        {
          url: FOLDER_URL,
          title: "folder-root",
          snippet: "Read-only: list and search direct children, navigate child folders, read " +
            "native Google Docs, Sheets and Slides, read PDFs' text with readPdf() and any other " +
            "file's bytes with readFile(), and read comments on direct children in Drive folder " +
            "\"folder-root\"",
          suggestedBindingName: "GOOGLE_DRIVE_FOLDER",
          tsType: "GoogleDriveFolderReadSession",
        },
        {
          url: FOLDER_URL,
          title: "folder-root (read and write)",
          snippet: "Read and write: list and search direct children, navigate child folders, read " +
            "native Google Docs, Sheets and Slides, read PDFs' text with readPdf() and any other " +
            "file's bytes with readFile(), read and queue comments on direct children, change who " +
            "they and the folder are shared with, and move them within Drive folder " +
            "\"folder-root\"",
          suggestedBindingName: "GOOGLE_DRIVE_FOLDER",
          tsType: "GoogleDriveFolderSession",
        },
        {
          url: FILE_URL,
          title: "doc-1",
          snippet: "Read-only: read metadata and, when native, Google Doc, Sheet or Slides " +
            "content, with readPdf() a PDF's text, or with readFile() the bytes of any other " +
            "file, and comments, from Drive file \"doc-1\"",
          suggestedBindingName: "GOOGLE_DRIVE_FILE",
          tsType: "GoogleDriveReadSession",
        },
        {
          url: FILE_URL,
          title: "doc-1 (read and write)",
          snippet: "Read and write: read metadata and, when native, Google Doc, Sheet or Slides " +
            "content, with readPdf() a PDF's text, or with readFile() the bytes of any other " +
            "file, from Drive file \"doc-1\", read and queue comments on it, and change who it " +
            "is shared with",
          suggestedBindingName: "GOOGLE_DRIVE_FILE",
          tsType: "GoogleDriveFileSession",
        },
      ]);
      for (let { url } of described) expect(url).not.toContain("access");
    });

    it("gives a read-only binding no write types", async () => {
      let readOnly = await binding({ kind: "account" }, null).types();
      let readWrite = await binding().types();

      for (let name of ["interface GoogleDriveReadSession", "interface GoogleDriveFolderReadSession"]) {
        expect(readOnly, name).toContain(name);
        expect(readWrite, name).toContain(name);
      }
      for (let name of ["DriveCommentWrites", "GoogleDriveFileSession", "interface GoogleDriveSession"]) {
        expect(readOnly, name).not.toContain(name);
        expect(readWrite, name).toContain(name);
      }
      expect(readOnly).not.toContain("import type");
      expect(readWrite).not.toContain("import type");
    });

    it("says each binding's access with its scope, whatever the account allows", async () => {
      await grant([GOOGLE_DRIVE_RESOURCE.urlPattern]);
      let folder = binding({ kind: "folder", folderId: ROOT });

      expect((await binding({ kind: "account" }, null).call("getScope")).value)
        .toEqual({ kind: "account", access: "read" });
      expect((await binding().call("getScope")).value).toEqual({ kind: "account", access: "write" });
      expect((await binding({ kind: "file", fileId: "doc-1" }, null).call("getScope")).value)
        .toEqual({ kind: "file", fileId: "doc-1", name: "doc-1", access: "read" });
      let bound = (await folder.call("getScope")).value;
      expect(bound).toEqual({
        kind: "folder", folderId: ROOT, rootFolderId: ROOT, name: ROOT, access: "write",
      });
      // Nothing above the bound folder is named.
      expect(bound).not.toHaveProperty("parentFolderId");
      expect((await folder.callIn(["inner"], "getScope")).value).toEqual({
        kind: "folder", folderId: "inner", rootFolderId: ROOT, parentFolderId: ROOT, name: "inner",
        access: "write",
      });
      expect((await binding({ kind: "account" }, "WRITE" as DriveAccessLevel).call("getScope")).value)
        .toEqual({ kind: "account", access: "read" });
    });
  });

  describe("queueing", () => {
    it("refuses another file of an exact-file binding without asking Google", async () => {
      let drive = binding({ kind: "file", fileId: "doc-1" });

      let refused = await drive.call("comment", "sheet-1", "Looks good.");

      expect(refused.error).toBe(OUTSIDE);
      expect(refused.actionId).toBeUndefined();
      expect(provider.requests).toEqual([]);
    });

    it("refuses a nested file of a folder binding without writing", async () => {
      let drive = binding({ kind: "folder", folderId: ROOT });

      let refused = await drive.call("comment", "nested-doc", "Looks good.");

      expect(refused.error).toBe(OUTSIDE);
      expect(refused.actionId).toBeUndefined();
      expect(posts()).toEqual([]);
    });

    it("tells a read and write binding whose account does not allow changes what to ask for", async () => {
      await grant([GOOGLE_DRIVE_RESOURCE.urlPattern]);

      let refused = await binding().call("comment", "doc-1", "Looks good.");

      expect(refused.error).toBe(GRANT_MISSING);
      expect(refused.actionId).toBeUndefined();
      // The refusal comes before the scope proof.
      expect(refused.observations).toEqual([]);
      expect(provider.requests).toEqual([]);
    });

    it("refuses to comment on a file the account can only view, reporting nothing", async () => {
      let refused = await binding().call("comment", "view-only", "Looks good.");

      expect(refused.error).toBe(VIEW_ONLY);
      expect(refused.actionId).toBeUndefined();
      expect(refused.observations.at(-1))
        .toBe("Check whether the connected account can comment on Drive file view-only.");
      expect(refused.reports).toEqual([
        { title: "Open Google Drive comments", subresources: ["drive/file/view-only"] },
        { title: "Check Google Drive file access", subresources: [] },
      ]);
      expect(posts()).toEqual([]);
    });

    it("refuses to comment on a folder, which Drive would answer with a server error", async () => {
      const REFUSED = "A Google Drive folder cannot take comments.";
      let account = await binding().call("comment", "inner", "Looks good.");
      expect(account.error).toBe(REFUSED);
      expect(account.actionId).toBeUndefined();
      // Only the scope proof's observation: the account is never asked whether it can comment.
      expect(account.reports).toEqual([
        { title: "Open Google Drive comments", subresources: ["drive/file/inner"] },
      ]);

      let folder = await binding({ kind: "folder", folderId: ROOT }).call("comment", "inner", "Hi");
      expect(folder.error).toBe(REFUSED);
      expect(folder.actionId).toBeUndefined();
      expect(posts()).toEqual([]);
    });

    it.each([
      ["an empty comment", ["doc-1", "   "], "The comment is empty."],
      ["a comment over Google's limit", ["doc-1", "é".repeat(2049)],
        "The comment is 4098 bytes of UTF-8; Google Drive allows at most 4096."],
      ["a quote over 500 characters", ["doc-1", "Why?", { quote: "x".repeat(501) }],
        "The quote is 501 characters; at most 500 can be quoted."],
      ["a quote on a Sheet", ["sheet-1", "Why?", { quote: "Revenue" }],
        "Quoting and suggested edits work only on Google Docs."],
      ["a quote the Doc lacks", ["doc-1", "Why?", { quote: "in April" }],
        "That text was not found in tab t.0. Quote it as written, without " +
        "Markdown or HTML formatting, and pass tabId if it is in another tab."],
      ["a quote the Doc has twice", ["doc-1", "Why?", { quote: "May" }],
        "That text appears 2 times; quote more of it so it is unique."],
      ["a tab without a quote", ["doc-1", "Why?", { tabId: "t.0" }],
        "tabId names the tab a quote is in; pass the quote too."],
    ])("refuses %s", async (_name, args, message) => {
      let refused = await binding().call("comment", ...args);

      expect(refused.error).toBe(message);
      expect(refused.actionId).toBeUndefined();
    });

    it("answers a pending ID by whether its comment still waits, asking Google nothing", async () => {
      let drive = binding();
      let waiting = await drive.queued("comment", "doc-1", "Should this be June?");
      let asked = provider.requests.length;
      let id = `pending:${waiting.actionId}`;

      expect((await drive.call("reply", "doc-1", id, "Agreed.")).error).toBe(STILL_PENDING);
      expect((await drive.call("resolve", "doc-1", id)).error).toBe(STILL_PENDING);
      // An ID never issued, and a queued reply's.
      expect((await drive.call("reply", "doc-1", "pending:999", "Agreed.")).error)
        .toBe(PENDING_DECIDED);
      let existing = provider.seed("doc-1");
      let reply = await drive.queued("reply", "doc-1", existing.id, "Yes.");
      asked = provider.requests.length;
      expect((await drive.call("resolve", "doc-1", `pending:${reply.actionId}`)).error)
        .toBe(PENDING_DECIDED);
      expect(provider.requests).toHaveLength(asked);

      // Once the comment is posted, or rejected, its pending ID names nothing that waits, and the
      // posted comment takes a reply under its Drive ID.
      expect(await drive.apply(waiting.actionId)).toBeNull();
      expect((await drive.call("reply", "doc-1", id, "Agreed.")).error).toBe(PENDING_DECIDED);
      let other = await drive.queued("comment", "doc-1", "And this?");
      await drive.reject(other.actionId);
      expect((await drive.call("reply", "doc-1", `pending:${other.actionId}`, "Agreed.")).error)
        .toBe(PENDING_DECIDED);
      let posted = (await drive.comments("doc-1")).find(comment => comment.text === "Should this be June?");
      if (!posted) throw new Error("the comment was not posted");
      await drive.queued("reply", "doc-1", posted.id, "Agreed.");
    });

    it("refuses a second resolve, and a reply, while a resolve of the comment waits", async () => {
      const RESOLVE_PENDING = "That comment already has a resolve waiting for approval. To give " +
        "it a closing reply, have that resolve rejected and resolve again with the reply as the text.";
      const REPLY_RESOLVE_PENDING = "That comment has a resolve waiting for approval, and a reply " +
        "posted after it would reopen the comment. To close the comment with a reply, have that " +
        "resolve rejected and resolve again with the reply as the text; otherwise reply once the " +
        "resolve is decided.";
      let drive = binding();
      let comment = provider.seed("doc-1");
      let other = provider.seed("doc-1", { content: "Typo here." });
      let first = await drive.queued("resolve", "doc-1", comment.id);

      for (let args of [[comment.id], [comment.id, "Done."]]) {
        let second = await drive.call("resolve", "doc-1", ...args);
        expect(second.error).toBe(RESOLVE_PENDING);
        expect(second.actionId).toBeUndefined();
      }
      let asked = provider.requests.length;
      let reply = await drive.call("reply", "doc-1", comment.id, "Thanks.");
      expect(reply.error).toBe(REPLY_RESOLVE_PENDING);
      // The comment itself is not asked for: only the file's scope and the account's right.
      expect(provider.requests.slice(asked).filter(request => request.includes("/comments/")))
        .toEqual([]);
      // Another comment's resolve queues.
      await drive.queued("resolve", "doc-1", other.id);

      // Once the resolve is rejected, a resolve with the closing reply queues, and so does a reply.
      await drive.reject(first.actionId);
      let closing = await drive.queued("resolve", "doc-1", comment.id, "Done.");
      await drive.reject(closing.actionId);
      let plain = await drive.queued("reply", "doc-1", comment.id, "Thanks.");
      expect(plain.value).not.toHaveProperty("action");

      // A reply queued before a resolve is not refused, and both post in that order.
      let resolve = await drive.queued("resolve", "doc-1", comment.id);
      expect(await drive.apply(plain.actionId)).toBeNull();
      expect(await drive.apply(resolve.actionId)).toBeNull();
      expect(comment.resolved).toBe(true);
      // After an applied resolve, a reply queues as one that reopens.
      let reopen = await drive.queued("reply", "doc-1", comment.id, "Not yet.");
      expect(reopen.value).toMatchObject({ action: "reopen" });
    });

    it("refuses to resolve a resolved comment, which Google would accept", async () => {
      let comment = provider.seed("doc-1", { resolved: true });

      let refused = await binding().call("resolve", "doc-1", comment.id);

      expect(refused.error).toBe("That comment is already resolved.");
      expect(refused.actionId).toBeUndefined();
    });

    it("refuses a reply to a comment Drive does not show", async () => {
      let refused = await binding().call("reply", "doc-1", "doco.missing", "Agreed.");

      expect(refused.error).toBe("That comment was not found on this file.");
    });

    it("queues a quoted comment with the text it is attached to, and attaches it through Docs", async () => {
      let drive = binding();

      let queued = await drive.queued("comment", "doc-1", "Should this be June?",
        { quote: "The launch is in May." });

      expect(queued.value).toEqual({
        id: `pending:${queued.actionId}`, author: { displayName: "You", me: true },
        text: "Should this be June?", quotedText: "The launch is in May.",
        createdTime: expect.any(Date), resolved: false, replies: [], pending: true,
      });
      expect(queued.action).toMatchObject({
        title: "Comment on a Google Drive file",
        actionKind: { tag: "driveComments", label: "Drive comments" },
        autoApprovable: true,
        fields: [
          { label: "Comment", kind: "text", value: "Should this be June?" },
          { label: "Quoted text", kind: "text", value: "The launch is in May." },
          { label: "File", kind: "inline", value: "doc-1" },
          // The fake names a file by its ID.
          { label: "File name", kind: "inline", value: "doc-1" },
          { label: "Tab", kind: "inline", value: "t.0" },
        ],
      });
      expect(queued.action?.description).toContain("Google emails the file's owner");
      expect(queued.observations).toContain(
        "Read the text of Google Doc doc-1 to find the quoted text.");
      // A write the account may make adds no observation of its own.
      expect(queued.reports).toEqual([
        { title: "Open Google Drive comments", subresources: ["drive/file/doc-1"] },
        { title: "Read Google Doc content", subresources: ["docs/document/doc-1"] },
      ]);
      expect(posts()).toEqual([]);
      expect(provider.docsWrites).toEqual([]);

      expect(await drive.apply(queued.actionId)).toBeNull();
      // Sent through Docs on the revision read at approval, anchored to the quoted text, which
      // starts at index 13; Drive lists it under the same ID with that text as its quote.
      expect(provider.docsWrites).toEqual([{
        requests: [{ insertComment: { content: "Should this be June?",
          range: { startIndex: 13, endIndex: 34, tabId: "t.0" } } }],
        writeControl: { requiredRevisionId: "revision-1" },
      }]);
      expect(posts()).toEqual([]);
      let [posted] = await drive.comments("doc-1");
      expect(posted).toMatchObject({ text: "Should this be June?", quotedText: "The launch is in May." });
      expect(posted.pending).toBeUndefined();
    });

    it("queues a suggested edit, and makes it a suggestion with its note on it once approved", async () => {
      let drive = binding();
      let queued = await drive.queued("suggestEdit", "doc-1", "launch is in May",
        "launch is in June", { note: "Marketing moved it." });

      expect(queued.value).toEqual({
        id: `pending:${queued.actionId}`, tabId: "t.0", oldText: "launch is in May",
        newText: "launch is in June", note: "Marketing moved it.", createdTime: expect.any(Date),
        pending: true,
      });
      expect(queued.action?.fields?.slice(0, 3)).toEqual([
        { label: "Replace", kind: "text", value: "launch is in May" },
        { label: "With", kind: "text", value: "launch is in June" },
        { label: "Note", kind: "text", value: "Marketing moved it." },
      ]);
      expect(queued.reports).toContainEqual(
        { title: "Read Google Doc content", subresources: ["docs/document/doc-1"] });
      // A suggestion is not a comment: no listing shows it.
      expect(await drive.comments("doc-1")).toEqual([]);

      expect(await drive.apply(queued.actionId)).toBeNull();
      expect(provider.docsWrites).toEqual([
        {
          requests: [
            { deleteContentRange: { range: { startIndex: 17, endIndex: 33, tabId: "t.0" } } },
            { insertText: { location: { index: 17, tabId: "t.0" }, text: "launch is in June" } },
          ],
          writeControl: { writeMode: "SUGGEST", requiredRevisionId: "revision-1" },
        },
        { requests: [{ addCommentReply: { suggestionId: "suggest.0", post: { content: "Marketing moved it." } } }] },
      ]);
      expect(provider.suggestions).toEqual([{
        suggestionId: "suggest.0", summaryText: "Replace: “launch is in May” with “launch is in June”",
        createTime: expect.any(String), replies: ["Marketing moved it."],
      }]);
      expect(posts()).toEqual([]);
      expect(await drive.attempts()).toEqual({});
    });

    it("fails a suggested edit for good, sending nothing, once its text is no longer in the Doc once", async () => {
      let drive = binding();
      let queued = await drive.queued("suggestEdit", "doc-1", "launch is in May", "launch is in June");
      // The text is now there twice.
      let fetch = globalThis.fetch;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        let request = new Request(input, init);
        if (request.method === "GET" && new URL(request.url).hostname === "docs.googleapis.com") {
          let doc = headedDoc();
          let run = doc.tabs[0].documentTab.body.content[4].paragraph!.elements[0];
          run.textRun!.content = "We ship: launch is in May.\n";
          return Response.json(doc);
        }
        return fetch(request);
      });

      expect(await drive.apply(queued.actionId)).toBe("The quoted text is no longer in the Doc " +
        "exactly once, so this can't be attached to it. Queue it again with text the Doc has now.");
      expect(provider.docsWrites).toEqual([]);
    });

    it("refuses a suggested edit as a commenter would be refused one, and sends nothing", async () => {
      let refused = await binding().call("suggestEdit", "view-only", "launch is in May", "June");

      expect(refused.error).toBe(VIEW_ONLY);
      expect(refused.actionId).toBeUndefined();
      expect(provider.docsWrites).toEqual([]);
    });

    it("says a reply to a resolved comment reopens it", async () => {
      let comment = provider.seed("doc-1", { resolved: true });

      let queued = await binding().queued("reply", "doc-1", comment.id, "Still wrong.");

      expect(queued.value).toEqual({
        id: `pending:${queued.actionId}`, author: { displayName: "You", me: true }, text: "Still wrong.",
        createdTime: expect.any(Date), action: "reopen", pending: true,
      });
      expect(queued.action?.description).toContain("This reopens the resolved comment.");
      // The answered comment is someone else's text: it is shown in fields, never in the prose.
      expect(queued.action?.description).not.toContain("Ada Lovelace");
      expect(queued.action?.description).not.toContain("Is this date right?");
      expect(queued.action?.fields).toEqual([
        { label: "Reply", kind: "text", value: "Still wrong." },
        { label: "File", kind: "inline", value: "doc-1" },
        { label: "File name", kind: "inline", value: "doc-1" },
        { label: "Comment", kind: "inline", value: comment.id },
        { label: "Comment author", kind: "inline", value: "Ada Lovelace" },
        { label: "Comment text", kind: "text", value: "Is this date right?" },
      ]);
    });
  });

  describe("pending writes", () => {
    it("shows queued writes until they are decided", async () => {
      let drive = binding();
      let existing = provider.seed("doc-1");
      let other = provider.seed("doc-1", { content: "Typo here." });
      let comment = await drive.queued("comment", "doc-1", "Should this be June?");
      let reply = await drive.queued("reply", "doc-1", existing.id, "Yes, it is.");
      let resolve = await drive.queued("resolve", "doc-1", other.id);

      let shown = await drive.comments("doc-1");

      expect(shown.map(item => [item.id, item.pending ?? false])).toEqual([
        [existing.id, false], [other.id, false], [`pending:${comment.actionId}`, true],
      ]);
      expect(shown[0].replies).toEqual([reply.value]);
      expect(shown[1].replies).toEqual([resolve.value]);
      expect(resolve.value).toMatchObject({ action: "resolve", text: "", pending: true });
      // Resolved only once Drive says so.
      expect(shown[1].resolved).toBe(false);

      expect(await drive.apply(comment.actionId)).toBeNull();
      expect(await drive.apply(resolve.actionId)).toBeNull();
      expect(await drive.reject(reply.actionId)).toBeNull();
      let decided = await drive.comments("doc-1");
      expect(decided.some(item => item.pending)).toBe(false);
      expect(decided.flatMap(item => item.replies).some(item => item.pending)).toBe(false);
      expect(decided.map(item => item.text)).toEqual(
        ["Is this date right?", "Typo here.", "Should this be June?"]);
      expect(decided[1]).toMatchObject({ resolved: true, replies: [{ text: "", action: "resolve" }] });
      expect(decided[0].replies).toEqual([]);
    });

    it("authorizes the file before disclosing a page of its comments, and nothing about comments", async () => {
      provider.seed("doc-1");

      let listed = await binding().call("listComments", "doc-1");

      // The check that the account can comment observes nothing when it passes.
      expect(listed.observations).toEqual([
        "Check current metadata for Drive file doc-1 to work with its comments.",
        "Read 1 comment on Drive file doc-1.",
      ]);
      expect(listed.reports).toEqual([
        { title: "Open Google Drive comments", subresources: ["drive/file/doc-1"] },
        { title: "Read Google Drive comments", subresources: ["drive/file/doc-1"] },
      ]);
      // The file is read for the scope proof, and once more for whether the account can comment.
      expect(provider.requests).toEqual([
        "GET /drive/v3/files/doc-1", "GET /drive/v3/files/doc-1",
        "GET /drive/v3/files/doc-1/comments",
      ]);
      expect((listed.value as DriveComment[][]).flat().map(comment => comment.text))
        .toEqual(["Is this date right?"]);
    });

    it("refuses to list the comments of a file the account can only view, reporting nothing", async () => {
      provider.seed("view-only");

      let refused = await binding().call("listComments", "view-only");

      expect(refused.error).toBe(VIEW_ONLY);
      expect(refused.value).toBeUndefined();
      expect(refused.observations.at(-1))
        .toBe("Check whether the connected account can comment on Drive file view-only.");
      expect(refused.reports).toEqual([
        { title: "Open Google Drive comments", subresources: ["drive/file/view-only"] },
        { title: "Check Google Drive file access", subresources: [] },
      ]);
      // Drive is not asked for the comments: it would answer with none, and no error.
      expect(provider.requests)
        .toEqual(["GET /drive/v3/files/view-only", "GET /drive/v3/files/view-only"]);
    });

    it("reports the document on the page that shows a quoted comment still pending", async () => {
      let drive = binding();
      let { actionId } = await drive.queued("comment", "doc-1", "Should this be June?",
        { quote: "The launch is in May." });

      let listed = await drive.call("listComments", "doc-1");

      expect(listed.reports.at(-1)?.subresources)
        .toEqual(["drive/file/doc-1", "docs/document/doc-1"]);

      expect(await drive.reject(actionId)).toBeNull();
      let withdrawn = await drive.call("listComments", "doc-1");
      expect(withdrawn.reports.at(-1)?.subresources).toEqual(["drive/file/doc-1"]);
    });

    it("reports the document for neither a pending suggested edit, which no page shows, nor a pending comment that quotes nothing", async () => {
      let drive = binding();
      await drive.queued("comment", "doc-1", "Looks good.");

      let plain = await drive.call("listComments", "doc-1");

      expect(plain.reports.at(-1))
        .toEqual({ title: "Read Google Drive comments", subresources: ["drive/file/doc-1"] });

      await drive.queued("suggestEdit", "doc-1", "launch is in May", "launch is in June");
      let suggested = await drive.call("listComments", "doc-1");
      expect(suggested.reports.at(-1)?.subresources).toEqual(["drive/file/doc-1"]);
    });

    it("reports the folder with a child's comments", async () => {
      let listed = await binding({ kind: "folder", folderId: ROOT }).call("listComments", "doc-1");

      // The scope proof's report, then the page's.
      expect(listed.reports.map(report => report.subresources)).toEqual([
        ["drive/folder/folder-root", "drive/file/doc-1"],
        ["drive/folder/folder-root", "drive/file/doc-1"],
      ]);
    });

    it("makes an approval wait for a page being read, so no write shows both posted and pending", async () => {
      let drive = binding();
      let { actionId } = await drive.queued("comment", "doc-1", "Should this be June?");
      let fetch = globalThis.fetch;
      let asked = false;
      let held = Promise.withResolvers<void>();
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        let request = new Request(input, init);
        // The listing's answer is held back until the test lets it go.
        if (request.method === "GET" && new URL(request.url).pathname.endsWith("/doc-1/comments")) {
          asked = true;
          await held.promise;
        }
        return fetch(request);
      });

      let listing = drive.comments("doc-1");
      // Polled, not awaited: a promise the gatekeeper's request settled would resume this test
      // inside the gatekeeper's own I/O context, where it may not call another object.
      await vi.waitFor(() => expect(asked).toBe(true));
      let applying = drive.apply(actionId);
      // Long enough for an approval that does not wait for the page to have sent.
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(posts()).toEqual([]);
      held.resolve();

      expect((await listing).map(item => [item.text, item.pending ?? false]))
        .toEqual([["Should this be June?", true]]);
      expect(await applying).toBeNull();
      expect(posts()).toHaveLength(1);
      expect((await drive.comments("doc-1")).map(item => [item.text, item.pending ?? false]))
        .toEqual([["Should this be June?", false]]);
    });

    it("lists a comment's times as dates, and the passage it is attached to", async () => {
      // Drive escapes the passage as HTML.
      let attached = provider.seed("doc-1", {
        quotedFileContent: { mimeType: "text/html", value: "The launch &amp; the caf&#233;" },
      });
      let plain = provider.seed("doc-1", { content: "Typo here." });

      let listed = await binding().comments("doc-1");

      expect(listed).toHaveLength(2);
      expect(listed[0]).toMatchObject({ quotedText: "The launch & the café" });
      expect(listed[1]).not.toHaveProperty("quotedText");
      for (let [index, seeded] of [attached, plain].entries()) {
        expect(listed[index].createdTime).toEqual(new Date(seeded.createdTime));
        expect(listed[index].modifiedTime).toEqual(new Date(seeded.modifiedTime));
      }
    });

    it.each(["insufficientPermissions", "appNotAuthorizedToFile"])(
      "asks an account that cannot read file content to reconnect, disclosing no page (%s)",
      async reason => {
        provider.seed("doc-1");
        provider.listRefusal = { status: 403, reason, message: "Refused." };

        let refused = await binding({ kind: "account" }, null).call("listComments", "doc-1");

        expect(refused.error).toBe(RECONNECT);
        expect(refused.value).toBeUndefined();
        expect(refused.reports)
          .toEqual([{ title: "Open Google Drive comments", subresources: ["drive/file/doc-1"] }]);
        // The scope proof and the check pass, and the listing is what Drive refuses.
        expect(provider.requests).toEqual([
          "GET /drive/v3/files/doc-1", "GET /drive/v3/files/doc-1",
          "GET /drive/v3/files/doc-1/comments",
        ]);
      });

    it("passes on any other refusal of a listing as Drive's own", async () => {
      provider.seed("doc-1");
      provider.listRefusal = { status: 500, reason: "backendError", message: "Backend Error" };

      let refused = await binding().call("listComments", "doc-1");

      expect(refused.error).toMatch(/500/);
      expect(refused.error).not.toBe(RECONNECT);
      expect(refused.reports)
        .toEqual([{ title: "Open Google Drive comments", subresources: ["drive/file/doc-1"] }]);
    });
  });

  describe("applying", () => {
    it("posts each kind of write exactly as it was approved", async () => {
      let drive = binding();
      let existing = provider.seed("doc-1");
      let comment = await drive.queued("comment", "doc-1", "Line one\r\nline two   \n");
      let reply = await drive.queued("reply", "doc-1", existing.id, "Agreed.");
      let resolve = await drive.queued("resolve", "doc-1", existing.id);

      for (let { actionId } of [comment, reply, resolve]) expect(await drive.apply(actionId)).toBeNull();

      expect(provider.writes.map(({ path, body }) => [path, body])).toEqual([
        ["/drive/v3/files/doc-1/comments", { content: "Line one\r\nline two" }],
        [`/drive/v3/files/doc-1/comments/${existing.id}/replies`, { content: "Agreed." }],
        [`/drive/v3/files/doc-1/comments/${existing.id}/replies`, { action: "resolve" }],
      ]);
      // Drive stores nothing of a write sent without a field mask.
      for (let { fields } of provider.writes) expect(fields).toBeTruthy();
      expect(provider.live("doc-1").map(item => item.content))
        .toEqual(["Is this date right?", "Line one\r\nline two"]);
      expect(provider.live("doc-1")[0]).toMatchObject({ resolved: true });
      expect(await drive.attempts()).toEqual({});
    });

    it("binds a comment a refused send posted anyway, without posting it again", async () => {
      let drive = binding();
      let { actionId } = await drive.queued("comment", "doc-1", "Should this be June?");
      provider.nextWrite = "lost";

      expect(await drive.apply(actionId)).toBe(UNCONFIRMED);
      expect(Object.keys(await drive.attempts())).toEqual([String(actionId)]);
      // The write is still undecided, and nothing has looked for what its send posted: until an
      // approval or a rejection does, a listing shows the posted comment and the pending one.
      expect((await drive.comments("doc-1")).map(item => [item.text, item.pending ?? false]))
        .toEqual([["Should this be June?", false], ["Should this be June?", true]]);

      expect(await drive.apply(actionId)).toBeNull();
      expect(posts()).toHaveLength(1);
      expect(provider.live("doc-1").map(item => item.content)).toEqual(["Should this be June?"]);
      expect(await drive.attempts()).toEqual({});
      expect((await drive.comments("doc-1")).some(item => item.pending)).toBe(false);
    });

    it("binds a reply a refused send posted anyway, without posting it again", async () => {
      let drive = binding();
      let existing = provider.seed("doc-1", { resolved: true });
      let { actionId } = await drive.queued("reply", "doc-1", existing.id, "Still wrong.");
      provider.nextWrite = "lost";

      expect(await drive.apply(actionId)).toMatch(/did not confirm whether this was posted/);
      expect(await drive.apply(actionId)).toBeNull();

      expect(posts()).toHaveLength(1);
      expect(existing.replies).toMatchObject([{ content: "Still wrong.", action: "reopen" }]);
    });

    it("binds only the account's own comment, with the same text, from around the send", async () => {
      let drive = binding();
      let recent = new Date().toISOString();
      let anHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      let sent = "Should this be June?";
      // Each is listed since the send began, and none is what it posted.
      provider.seed("doc-1", { content: sent, author: ADA });
      provider.seed("doc-1", { content: sent, author: ME, createdTime: anHourAgo });
      provider.seed("doc-1", { content: `${sent} `, author: ME });
      let { actionId } = await drive.queued("comment", "doc-1", sent);
      provider.nextWrite = "lost";
      expect(await drive.apply(actionId)).toMatch(/did not confirm/);

      expect(await drive.apply(actionId)).toBeNull();
      expect(posts()).toHaveLength(1);
      let bound = provider.live("doc-1").at(-1);
      expect(bound !== undefined && recent <= bound.createdTime).toBe(true);
    });

    it("binds only the account's own reply, with the same text, from around the send", async () => {
      let drive = binding();
      let anHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      let existing = provider.seed("doc-1");
      existing.replies.push(
        { id: "doco.old", content: "Fixed.", author: ME, createdTime: anHourAgo, modifiedTime: anHourAgo, deleted: false },
        { id: "doco.ada", content: "Fixed.", author: ADA, createdTime: new Date().toISOString(), modifiedTime: new Date().toISOString(), deleted: false },
        { id: "doco.near", content: "Fixed. ", author: ME, createdTime: new Date().toISOString(), modifiedTime: new Date().toISOString(), deleted: false },
      );
      let { actionId } = await drive.queued("reply", "doc-1", existing.id, "Fixed.");
      provider.nextWrite = "lost";
      expect(await drive.apply(actionId)).toMatch(/did not confirm/);

      expect(await drive.apply(actionId)).toBeNull();
      expect(posts()).toHaveLength(1);
      expect(existing.replies).toHaveLength(4);
    });

    it("does not take a reply already on the comment for what a send posted", async () => {
      let drive = binding();
      let existing = provider.seed("doc-1");
      let first = await drive.queued("resolve", "doc-1", existing.id);
      expect(await drive.apply(first.actionId)).toBeNull();
      let reopen = await drive.queued("reply", "doc-1", existing.id, "Not yet.");
      expect(await drive.apply(reopen.actionId)).toBeNull();
      let { actionId } = await drive.queued("resolve", "doc-1", existing.id);
      provider.nextWrite = { status: 503, reason: "backendError", message: "Backend Error" };
      expect(await drive.apply(actionId)).toMatch(/did not confirm/);

      expect(await drive.apply(actionId)).toMatch(/^Google Drive may still be posting this/);
      expect(existing.resolved).toBe(false);

      await drive.age(actionId, 6 * 60 * 1000);
      // Aging moves the marker's time only: the replies it excludes stay excluded.
      expect(await drive.attempts()).toEqual({
        [actionId]: { at: expect.any(Number), existing: [existing.replies[0]?.id] },
      });
      expect(await drive.apply(actionId)).toBeNull();
      expect(existing).toMatchObject({ resolved: true });
      expect(existing.replies.map(reply => reply.action)).toEqual(["resolve", "reopen", "resolve"]);
    });

    it("fails a reply whose comment was edited after it was queued, and denying clears it", async () => {
      let drive = binding();
      let comment = provider.seed("doc-1");
      let { actionId } = await drive.queued("reply", "doc-1", comment.id, "Yes, it is.");
      comment.content = "Is this date still right?";

      let edited = await drive.apply(actionId);
      expect(edited).toBe("That comment was edited after this was queued. Queue it again to " +
        "answer the comment as it is now.");
      expect(posts()).toEqual([]);
      // Approving again answers the same; denying withdraws it, and a new reply then queues.
      expect(await drive.apply(actionId)).toBe(edited);
      await drive.reject(actionId);
      expect((await drive.comments("doc-1")).flatMap(listed => listed.replies)).toEqual([]);
      await drive.queued("reply", "doc-1", comment.id, "Yes, it is.");
    });

    it("stops after three sends Google left unconfirmed that posted nothing, and denying clears it", async () => {
      let drive = binding();
      let { actionId } = await drive.queued("comment", "doc-1", "Should this be June?");
      for (let sends = 1; sends <= 3; sends++) {
        provider.nextWrite = { status: 503, reason: "backendError", message: "Backend Error" };
        expect(await drive.apply(actionId)).toMatch(/did not confirm whether this was posted/);
        expect(posts()).toHaveLength(sends);
        await drive.age(actionId, 6 * 60 * 1000);
      }

      let exhausted = await drive.apply(actionId);
      expect(exhausted).toBe("Google Drive did not accept this in 3 tries, and none of them " +
        "posted it, so it won't be sent again. Reject it to clear it.");
      expect(posts()).toHaveLength(3);
      expect(await drive.attempts()).toEqual({});
      expect(await drive.apply(actionId)).toBe(exhausted);
      expect(posts()).toHaveLength(3);

      await drive.reject(actionId);
      expect((await drive.comments("doc-1")).filter(comment => comment.pending)).toEqual([]);
      // Nothing is left of it: the same comment queues and posts afresh.
      let again = await drive.queued("comment", "doc-1", "Should this be June?");
      expect(await drive.apply(again.actionId)).toBeNull();
      expect(provider.live("doc-1")).toHaveLength(1);
    });

    it("waits out the window rather than send again while Google may still show the send", async () => {
      let drive = binding();
      let { actionId } = await drive.queued("comment", "doc-1", "Should this be June?");
      provider.nextWrite = { status: 503, reason: "backendError", message: "Backend Error" };

      expect(await drive.apply(actionId)).toMatch(/did not confirm whether this was posted/);
      expect(await drive.apply(actionId))
        .toMatch(/^Google Drive may still be posting this, so it wasn't sent again; approve again after \d\d:\d\d UTC\.$/);
      expect(posts()).toHaveLength(1);

      await drive.age(actionId, 6 * 60 * 1000);
      expect(await drive.apply(actionId)).toBeNull();
      expect(posts()).toHaveLength(2);
      expect(provider.live("doc-1")).toHaveLength(1);
      expect(await drive.attempts()).toEqual({});
    });

    it("gives up, as of unknown outcome, when two identical comments could be the send", async () => {
      let drive = binding();
      let { actionId } = await drive.queued("comment", "doc-1", "Should this be June?");
      provider.nextWrite = "lost";
      expect(await drive.apply(actionId)).toMatch(/did not confirm/);
      provider.seed("doc-1", { content: "Should this be June?", author: ME });

      let unknown = await drive.apply(actionId);

      expect(unknown).toMatch(/more than one identical comment/);
      expect(await drive.apply(actionId)).toBe(unknown);
      expect(posts()).toHaveLength(1);
      // The marker of a send that cannot be told stays until the write is withdrawn.
      expect(Object.keys(await drive.attempts())).toEqual([String(actionId)]);
      expect(await drive.reject(actionId)).toBeNull();
      expect(await drive.attempts()).toEqual({});
    });

    it("ends as of unknown outcome when the account lost the right to comment after a send Google left unconfirmed", async () => {
      let drive = binding();
      let { actionId } = await drive.queued("comment", "doc-1", "Should this be June?");
      // The send posts, and its answer is lost.
      provider.nextWrite = "lost";
      expect(await drive.apply(actionId)).toMatch(/did not confirm/);
      expect(provider.live("doc-1")).toHaveLength(1);
      // The file's owner then makes the connected account a viewer: Google lists it nothing.
      let file = provider.files.get("doc-1");
      if (!file) throw new Error("no such file");
      file.canComment = false;
      await drive.age(actionId, 6 * 60 * 1000);

      let blind = await drive.apply(actionId);

      expect(blind).toBe("The connected account can no longer comment on that file, and Google " +
        "Drive shows a file's comments only to accounts that can, so whether this was posted " +
        "can't be checked, and it won't be sent again. Reject it to clear it.");
      expect(posts()).toHaveLength(1);
      // With the right to comment back, approving still answers the same and sends nothing.
      file.canComment = true;
      expect(await drive.apply(actionId)).toBe(blind);
      expect(posts()).toHaveLength(1);
      expect(Object.keys(await drive.attempts())).toEqual([String(actionId)]);
      // Denying clears it; the comment the send posted stays.
      expect(await drive.reject(actionId)).toBeNull();
      expect(await drive.attempts()).toEqual({});
      expect(provider.live("doc-1")).toHaveLength(1);
    });

    it("fails a send Google refused before posting, clearing its marker", async () => {
      let drive = binding();
      let { actionId } = await drive.queued("comment", "doc-1", "Should this be June?");
      provider.nextWrite = {
        status: 403, reason: "insufficientFilePermissions",
        message: "The user does not have sufficient permissions for file doc-1.",
      };

      let failed = await drive.apply(actionId);

      expect(failed).toBe("The connected account can no longer comment on that file.");
      expect(await drive.attempts()).toEqual({});
      expect(await drive.apply(actionId)).toBe(failed);
      expect(posts()).toHaveLength(1);
      expect(provider.live("doc-1")).toEqual([]);
    });

    it("keeps a write pending when Google says the token lacks the scope", async () => {
      let drive = binding();
      let { actionId } = await drive.queued("comment", "doc-1", "Should this be June?");
      provider.nextWrite = {
        status: 403, reason: "insufficientPermissions",
        message: "Request had insufficient authentication scopes.",
      };

      expect(await drive.apply(actionId)).toBe(GRANT_MISSING);
      expect(await drive.attempts()).toEqual({});
      expect(provider.live("doc-1")).toEqual([]);

      expect(await drive.apply(actionId)).toBeNull();
      expect(posts()).toHaveLength(2);
      expect(provider.live("doc-1").map(item => item.content)).toEqual(["Should this be June?"]);
    });

    it("keeps a rate-limited send for a later approval", async () => {
      let drive = binding();
      let { actionId } = await drive.queued("comment", "doc-1", "Should this be June?");
      provider.nextWrite = { status: 403, reason: "userRateLimitExceeded", message: "Rate limit" };

      expect(await drive.apply(actionId)).toBe(
        "Google Drive is limiting requests from this account. Approve it again in a minute.");
      expect(await drive.attempts()).toEqual({});
      expect(await drive.apply(actionId)).toBeNull();
      expect(provider.live("doc-1")).toHaveLength(1);
    });

    it("withdraws a write whose send may have gone, leaving what it posted", async () => {
      let drive = binding();
      let { actionId } = await drive.queued("comment", "doc-1", "Should this be June?");
      provider.nextWrite = "lost";
      expect(await drive.apply(actionId)).toBe(UNCONFIRMED);

      expect(await drive.reject(actionId)).toBeNull();

      expect(await drive.attempts()).toEqual({});
      expect((await drive.comments("doc-1")).map(item => [item.text, item.pending ?? false]))
        .toEqual([["Should this be June?", false]]);
      expect(await drive.apply(actionId)).toMatch(/Unknown pending action/);
      expect(posts()).toHaveLength(1);
    });

    it("reconciles a claim an activation died holding once its send may have gone", async () => {
      let drive = binding();
      let { actionId } = await drive.queued("comment", "doc-1", "Should this be June?");
      provider.nextWrite = "lost";
      expect(await drive.apply(actionId)).toMatch(/did not confirm/);
      await drive.orphan(actionId);
      await drive.restart();

      expect(await drive.apply(actionId)).toBeNull();
      expect(posts()).toHaveLength(1);
      expect(provider.live("doc-1")).toHaveLength(1);
    });

    it("withdraws a claim an activation died holding", async () => {
      let drive = binding();
      let { actionId } = await drive.queued("comment", "doc-1", "Should this be June?");
      provider.nextWrite = "lost";
      expect(await drive.apply(actionId)).toMatch(/did not confirm/);
      await drive.orphan(actionId);
      await drive.restart();

      expect(await drive.reject(actionId)).toBeNull();

      expect(await drive.attempts()).toEqual({});
      expect(posts()).toHaveLength(1);
    });

    it("forgets the markers of writes that cannot be applied again", async () => {
      let drive = binding();
      let { actionId } = await drive.queued("comment", "doc-1", "Should this be June?");
      provider.nextWrite = "lost";
      expect(await drive.apply(actionId)).toMatch(/did not confirm/);
      let kept = await drive.queued("comment", "doc-1", "And this one?");
      provider.nextWrite = "lost";
      expect(await drive.apply(kept.actionId)).toMatch(/did not confirm/);
      await drive.fail(actionId);

      await drive.comments("doc-1");

      expect(Object.keys(await drive.attempts())).toEqual([String(kept.actionId)]);
    });

    it("keeps the marker of a claim an activation died holding across a new session", async () => {
      let drive = binding();
      let { actionId } = await drive.queued("comment", "doc-1", "Should this be June?");
      provider.nextWrite = "lost";
      expect(await drive.apply(actionId)).toBe(UNCONFIRMED);
      await drive.orphan(actionId);
      await drive.restart();

      // The listing starts a session, whose sweep runs first. A claimed write is not among the
      // undecided ones a listing shows, so what the send posted is listed once, as posted.
      expect((await drive.comments("doc-1")).map(item => [item.text, item.pending ?? false]))
        .toEqual([["Should this be June?", false]]);
      expect(Object.keys(await drive.attempts())).toEqual([String(actionId)]);

      expect(await drive.apply(actionId)).toBeNull();
      expect(posts()).toHaveLength(1);
      expect(provider.live("doc-1")).toHaveLength(1);
      expect(await drive.attempts()).toEqual({});
    });

    it("sends a claim an activation died holding before any send went", async () => {
      let drive = binding();
      let { actionId } = await drive.queued("comment", "doc-1", "Should this be June?");
      await drive.orphan(actionId);
      await drive.restart();

      expect(await drive.apply(actionId)).toBeNull();
      expect(posts()).toHaveLength(1);
    });

    it("refuses a write whose file moved out of the folder it was queued in", async () => {
      let drive = binding({ kind: "folder", folderId: ROOT });
      provider.files.set("inner-doc", { mimeType: DOC_MIME, parents: ["inner"], canComment: true });
      let queued = await drive.queuedIn(["inner"], "comment", "inner-doc", "Should this be June?");
      provider.files.set("inner-doc", { mimeType: DOC_MIME, parents: [ROOT], canComment: true });

      expect(await drive.apply(queued.actionId))
        .toBe("That file is no longer in this connection's scope.");
      expect(posts()).toEqual([]);
    });

    it("applies a folder write while the file is still where it was queued", async () => {
      let drive = binding({ kind: "folder", folderId: ROOT });
      provider.files.set("inner-doc", { mimeType: DOC_MIME, parents: ["inner"], canComment: true });
      let queued = await drive.queuedIn(["inner"], "comment", "inner-doc", "Should this be June?");

      expect(await drive.apply(queued.actionId)).toBeNull();
      expect(provider.live("inner-doc")).toHaveLength(1);
    });

    it("keeps an approved write pending while the account does not allow changes, and posts it once it does", async () => {
      let drive = binding();
      let { actionId } = await drive.queued("comment", "doc-1", "Should this be June?");
      await grant([GOOGLE_DRIVE_RESOURCE.urlPattern]);

      expect(await drive.apply(actionId)).toBe(GRANT_MISSING);
      // The write waits rather than failing for good: a later approval asks the account again.
      expect(await drive.apply(actionId)).toBe(GRANT_MISSING);
      expect(posts()).toEqual([]);
      expect(await drive.attempts()).toEqual({});
      expect((await drive.comments("doc-1")).map(item => [item.text, item.pending ?? false]))
        .toEqual([["Should this be June?", true]]);

      await grant(GRANTED);
      expect(await drive.apply(actionId)).toBeNull();
      expect(posts()).toHaveLength(1);
      expect(provider.live("doc-1").map(item => item.content)).toEqual(["Should this be June?"]);
    });

    it("fails an approved write when its binding is read-only at approval", async () => {
      let drive = binding();
      let { actionId } = await drive.queued("comment", "doc-1", "Should this be June?");
      await drive.restart();
      let readOnly = binding({ kind: "account" }, null, drive.facet);

      expect(await readOnly.apply(actionId)).toBe(READ_ONLY_ACCOUNT);
      expect(posts()).toEqual([]);
      expect(await readOnly.apply(actionId)).toBe(READ_ONLY_ACCOUNT);
    });

    it("refuses to resolve a comment someone resolved after it was queued", async () => {
      let drive = binding();
      let existing = provider.seed("doc-1");
      let { actionId } = await drive.queued("resolve", "doc-1", existing.id, "Fixed.");
      existing.resolved = true;

      expect(await drive.apply(actionId)).toBe("That comment is already resolved.");
      expect(posts()).toEqual([]);
    });

    it("refuses a reply that would reopen a comment resolved since it was queued", async () => {
      let drive = binding();
      let existing = provider.seed("doc-1");
      let reply = await drive.queued("reply", "doc-1", existing.id, "Changed to 2026.");
      let resolve = await drive.queued("resolve", "doc-1", existing.id);
      expect(await drive.apply(resolve.actionId)).toBeNull();

      expect(await drive.apply(reply.actionId)).toBe("That comment was resolved after this reply " +
        "was queued, and replying would reopen it. Queue the reply again to reopen it.");
      expect(posts()).toHaveLength(1);
      expect(existing).toMatchObject({ resolved: true });
    });
  });
});
