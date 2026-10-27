import { env } from "cloudflare:test";
import { RpcStub, RpcTarget } from "cloudflare:workers";
import type {
  ActionDescription, ApprovalQueue, GitCache, HookController, HookDescription,
  ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleDocsApi } from "../../src/docs-api";
import { DriveApi } from "../../src/drive-api";
import type { DriveCommentQueue } from "../../src/drive-comments";
import type { DriveBindingScope } from "../../src/drive-session";
import type { PdfConverter } from "../../src/drive-pdf";
import { GoogleDriveSessionImpl } from "../../src/google";
import type { DriveComment, DrivePdfText, DriveSessionSearchQuery } from "../../src/drive-types";
import { DRIVE_COMMENTS_GRANT, GOOGLE_DRIVE_RESOURCE } from "../../src/resources";
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

  async authorizeObservation(description: ObservationDescription): Promise<void> {
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

/** A comment host for sessions these tests never comment through. */
const NO_COMMENTS: DriveCommentQueue = {
  holdsGrant: async () => false,
  submit: async () => { throw new Error("Unexpected comment submission"); },
  undecided: read => read([]),
};

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
      async fileIds => ({ pendingSets: fileIds, commit() {} }),
      () => ({ pendingSets: [], commit() {} }),
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
    expect(queue.observations.map(({ title, description }) => ({ title, description }))).toEqual([
      {
        title: "Open PDF from Google Drive",
        description: "Check current metadata for Drive file pdf-1 and open it as a PDF.",
      },
      { title: "Read PDF from Google Drive", description: "Read the text of Drive file pdf-1." },
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
      .rejects.toThrow("Google Drive API request failed: 403 (cannotDownloadFile)");
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

  function installFolderProvider(nodes: Map<string, Node>, onNativeRead?: () => void) {
    const nativeCalls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (isDownload(url.toString())) {
        nativeCalls.push("download");
        onNativeRead?.();
        return new Response(PDF_BYTES, { headers: { "Content-Type": PDF_MIME } });
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
        return Response.json({ ...node, name: id, modifiedTime: "2026-08-20T12:00:00Z" });
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
        async fileIds => ({ pendingSets: fileIds, commit() {} }),
        () => ({ pendingSets: [], commit() {} }),
        NO_COMMENTS,
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
});


/** A Doc whose second paragraph is the heading the quoted text sits under. */
function headedDoc() {
  let tab = buildTab([
    { runs: ["Plan\n"], namedStyleType: "TITLE" },
    { runs: ["Launch\n"], namedStyleType: "HEADING_1" },
    { runs: ["The launch is in May.\n"] },
    { runs: ["We ship in May and June.\n"] },
  ]);
  let [, title, heading] = tab.body.content;
  title.paragraph!.paragraphStyle.headingId = "h.title";
  heading.paragraph!.paragraphStyle.headingId = "h.launch";
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
  const GRANTED = [GOOGLE_DRIVE_RESOURCE.urlPattern, DRIVE_COMMENTS_GRANT];
  const GRANT_MISSING =
    "Commenting needs a permission this Google account hasn't granted yet. In Workshop, start " +
    "adding a Google Drive connection for this account and choose \"Allow commenting\"; it " +
    "covers every Drive connection on the account, so the dialog can then be closed.";
  const OUTSIDE = "The requested file is outside this Drive binding.";
  const LINK = "https://docs.google.com/document/d/doc-1/edit?tab=t.0#heading=h.launch";
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
      [ROOT, { mimeType: FOLDER_MIME, parents: ["above"], canComment: false }],
      ["inner", { mimeType: FOLDER_MIME, parents: [ROOT], canComment: false }],
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
      if (url.hostname === "docs.googleapis.com") return Response.json(headedDoc());
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

  let facets = 0;

  /** A Drive binding of `scope`, on a TestHooks object of its own. */
  function binding(scope: DriveBindingScope = { kind: "account" }) {
    let facet = `drive-comments-${++facets}`;
    let hooks = env.TEST_HOOKS.getByName(facet);
    let call = (method: string, ...args: unknown[]) => hooks.callDrive(facet, scope, method, args);
    return {
      call,
      callIn: (path: string[], method: string, ...args: unknown[]) =>
        hooks.callDrive(facet, scope, method, args, path),
      queued: async (method: string, ...args: unknown[]) => {
        let outcome = await call(method, ...args);
        if (outcome.error !== undefined) throw new Error(outcome.error);
        if (outcome.actionId === undefined) throw new Error(`${method} queued nothing`);
        return outcome as typeof outcome & { actionId: number };
      },
      comments: async (fileId: string) => {
        let outcome = await call("listComments", fileId);
        if (outcome.error !== undefined) throw new Error(outcome.error);
        return (outcome.value as DriveComment[][]).flat();
      },
      apply: (actionId: number) => hooks.applyDrive(facet, scope, actionId),
      reject: (actionId: number) => hooks.rejectDrive(facet, scope, actionId),
      autoApprovable: () => hooks.driveAutoApprovable(facet, scope),
      orphan: (actionId: number) => hooks.orphanDriveClaim(facet, scope, actionId),
      fail: (actionId: number) => hooks.failDriveAction(facet, scope, actionId),
      restart: () => hooks.restartDrive(facet),
      attempts: () => hooks.driveAttempts(facet, scope),
      age: (actionId: number, ms: number) => hooks.ageDriveAttempt(facet, scope, actionId, ms),
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

    it("asks a connection that has not opted in to allow commenting", async () => {
      await grant([GOOGLE_DRIVE_RESOURCE.urlPattern]);

      let refused = await binding().call("comment", "doc-1", "Looks good.");

      expect(refused.error).toBe(GRANT_MISSING);
      expect(refused.actionId).toBeUndefined();
    });

    it("refuses a file the account can only view, as a withheld answer", async () => {
      let refused = await binding().call("comment", "view-only", "Looks good.");

      expect(refused.error).toBe("The connected account cannot comment on Drive file view-only, " +
        "so its comments cannot be read or added to here.");
      expect(refused.actionId).toBeUndefined();
      expect(refused.observations.at(-1))
        .toBe("Check whether the connected account can comment on Drive file view-only.");
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

    it("refuses to reply to a comment still waiting for approval, asking Google nothing", async () => {
      let refused = await binding().call("reply", "doc-1", "pending:3", "Agreed.");

      expect(refused.error).toBe("That comment is waiting for approval; reply to it once it is posted.");
      expect(provider.requests).toEqual([]);
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

    it("queues a quoted comment as plain text with a link to the heading above the quote", async () => {
      let drive = binding();

      let queued = await drive.queued("comment", "doc-1", "Should this be June?",
        { quote: "The launch is in May." });

      let body = `"The launch is in May."\n\nShould this be June?\n\n${LINK}`;
      expect(queued.value).toEqual({
        id: `pending:${queued.actionId}`, author: { name: "You", me: true }, text: body,
        createdTime: expect.any(String), resolved: false, replies: [], pending: true,
      });
      expect(queued.action).toMatchObject({
        title: "Comment on a Google Drive file",
        actionKind: { tag: "driveComments", label: "Drive comments" },
        autoApprovable: true,
        fields: [
          { label: "File", kind: "inline", value: "doc-1" },
          { label: "Comment", kind: "text", value: body },
        ],
      });
      expect(queued.action!.description).toContain("Google emails the file's owner");
      expect(queued.observations).toContain(
        "Read the text of Google Doc doc-1 to find the quoted text.");
      expect(posts()).toEqual([]);
    });

    it("queues a suggested edit as a comment describing it", async () => {
      let queued = await binding().queued("suggestEdit", "doc-1", "launch is in May",
        "launch is in June", { note: "Marketing moved it." });

      let body = "Suggested edit: replace \"launch is in May\" with \"launch is in June\"\n\n" +
        `Marketing moved it.\n\n${LINK}`;
      expect((queued.value as DriveComment).text).toBe(body);
      expect(queued.action!.fields).toContainEqual({ label: "Comment", kind: "text", value: body });
    });

    it("says a reply to a resolved comment reopens it", async () => {
      let comment = provider.seed("doc-1", { resolved: true });

      let queued = await binding().queued("reply", "doc-1", comment.id, "Still wrong.");

      expect(queued.value).toEqual({
        id: `pending:${queued.actionId}`, author: { name: "You", me: true }, text: "Still wrong.",
        createdTime: expect.any(String), action: "reopen", pending: true,
      });
      expect(queued.action!.description).toContain("This reopens the resolved comment.");
      expect(queued.action!.description).toContain("Ada Lovelace");
      expect(queued.action!.description).toContain("> Is this date right?");
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

    it("authorizes the file, then its comments, before disclosing a page of them", async () => {
      provider.seed("doc-1");

      let listed = await binding().call("listComments", "doc-1");

      expect(listed.observations).toEqual([
        "Check current metadata for Drive file doc-1 to work with its comments.",
        "Check whether the connected account can comment on Drive file doc-1.",
        "Read 1 comment on Drive file doc-1.",
      ]);
      expect((listed.value as DriveComment[][]).flat().map(comment => comment.text))
        .toEqual(["Is this date right?"]);
    });

    it("refuses to list the comments of a file the account can only view", async () => {
      provider.seed("view-only");

      let refused = await binding().call("listComments", "view-only");

      expect(refused.error).toMatch(/cannot comment on Drive file view-only/);
      expect(provider.requests.filter(request => request.endsWith("/comments"))).toEqual([]);
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
      expect(provider.live("doc-1").map(item => item.content))
        .toEqual(["Is this date right?", "Line one\r\nline two"]);
      expect(provider.live("doc-1")[0]).toMatchObject({ resolved: true });
      expect(await drive.attempts()).toEqual({});
    });

    it("binds a comment a refused send posted anyway, without posting it again", async () => {
      let drive = binding();
      let { actionId } = await drive.queued("comment", "doc-1", "Should this be June?");
      provider.nextWrite = "lost";

      expect(await drive.apply(actionId)).toBe("Google Drive did not confirm whether this was " +
        "posted, and it may have been. Approving it again first checks the file's comments, so it " +
        "is not posted twice.");
      expect(Object.keys(await drive.attempts())).toEqual([String(actionId)]);
      expect(await drive.reject(actionId))
        .toBe("This may already be posted on Google Drive; approve it to check.");

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
      expect(recent <= provider.live("doc-1").at(-1)!.createdTime).toBe(true);
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
      expect(await drive.apply(actionId)).toBeNull();
      expect(existing).toMatchObject({ resolved: true });
      expect(existing.replies.map(reply => reply.action)).toEqual(["resolve", "reopen", "resolve"]);
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
      expect(await drive.attempts()).toEqual({});
      expect(await drive.reject(actionId)).toBeNull();
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

    it("reconciles a claim an activation died holding once its send may have gone", async () => {
      let drive = binding();
      let { actionId } = await drive.queued("comment", "doc-1", "Should this be June?");
      provider.nextWrite = "lost";
      expect(await drive.apply(actionId)).toMatch(/did not confirm/);
      await drive.orphan(actionId);
      await drive.restart();

      expect(await drive.reject(actionId))
        .toBe("This may already be posted on Google Drive; approve it to check.");
      expect(await drive.apply(actionId)).toBeNull();
      expect(posts()).toHaveLength(1);
      expect(provider.live("doc-1")).toHaveLength(1);
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
      let queued = await drive.callIn(["inner"], "comment", "inner-doc", "Should this be June?");
      expect(queued.error).toBeUndefined();
      provider.files.set("inner-doc", { mimeType: DOC_MIME, parents: [ROOT], canComment: true });

      expect(await drive.apply(queued.actionId!))
        .toBe("That file is no longer in this connection's scope.");
      expect(posts()).toEqual([]);
    });

    it("applies a folder write while the file is still where it was queued", async () => {
      let drive = binding({ kind: "folder", folderId: ROOT });
      provider.files.set("inner-doc", { mimeType: DOC_MIME, parents: ["inner"], canComment: true });
      let queued = await drive.callIn(["inner"], "comment", "inner-doc", "Should this be June?");

      expect(await drive.apply(queued.actionId!)).toBeNull();
      expect(provider.live("inner-doc")).toHaveLength(1);
    });

    it("refuses a write once the connection stops allowing comments", async () => {
      let drive = binding();
      let { actionId } = await drive.queued("comment", "doc-1", "Should this be June?");
      await grant([GOOGLE_DRIVE_RESOURCE.urlPattern]);

      expect(await drive.apply(actionId)).toBe(GRANT_MISSING);
      expect(posts()).toEqual([]);
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
