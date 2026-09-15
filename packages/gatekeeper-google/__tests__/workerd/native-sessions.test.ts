import { RpcStub, RpcTarget } from "cloudflare:workers";
import type {
  ActionDescription, ApprovalQueue, GitCache, HookController, HookDescription,
  ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleDocsApi } from "../../src/docs-api";
import { DriveApi } from "../../src/drive-api";
import { GoogleDriveSessionImpl } from "../../src/google";
import { GoogleSheetsApi } from "../../src/sheets-api";

const DOC_MIME = "application/vnd.google-apps.document";
const SHEET_MIME = "application/vnd.google-apps.spreadsheet";
const FOLDER_MIME = "application/vnd.google-apps.folder";
let providerUrls: string[];
/** The document the provider currently serves; a test may replace it mid-session. */
let providerTabs: unknown[];
/** Absent for a document the caller cannot edit, as Google returns it. */
let providerRevision: string | undefined;

async function getAccessToken(): Promise<string> {
  return "access-token";
}

class TestApprovalQueue extends RpcTarget implements ApprovalQueue {
  readonly observations: ObservationDescription[] = [];

  async authorizeObservation(description: ObservationDescription): Promise<void> {
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
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    urls.push(url.toString());
    if (url.hostname === "www.googleapis.com" && url.pathname.endsWith("/drive/v3/files")) {
      return Response.json({ files: [providerFile("doc-1", DOC_MIME)] });
    }
    if (url.hostname === "www.googleapis.com" && url.pathname.includes("/drive/v3/files/")) {
      const id = decodeURIComponent(url.pathname.split("/").at(-1)!);
      const mimeType = id === "doc-1" ? DOC_MIME : SHEET_MIME;
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

function newSession() {
  const queue = new TestApprovalQueue();
  const queueStub: RpcStub<ApprovalQueue> = new RpcStub(queue);
  return {
    queue,
    session: new RpcStub(new GoogleDriveSessionImpl(
      new DriveApi(getAccessToken),
      new GoogleDocsApi(getAccessToken),
      new GoogleSheetsApi(getAccessToken),
      { kind: "account" },
      queueStub,
      async fileIds => ({ pendingSets: fileIds, commit() {} }),
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

  it("returns the existing Sheet target with bounded range validation", async () => {
    using session = newSession().session;
    using sheet = await session.openGoogleSheet("sheet-1");

    await expect(Promise.resolve(sheet.readRange("A:A")))
      .rejects.toThrow(/Invalid or unbounded A1 range/);
    expect(providerUrls.some(url => new URL(url).hostname === "sheets.googleapis.com"))
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
      if (url.pathname === "/batch/drive/v3") {
        return batchResponse(String(init?.body ?? ""), nodes);
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
          documentId: "doc-1",
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
      return Response.json({
        spreadsheetId: "sheet-1",
        properties: { title: "Forecast" },
        sheets: [{ properties: { sheetId: 0, title: "Sheet1", index: 0 } }],
      });
    }));
    return nativeCalls;
  }

  function folderSession(nodes: Map<string, Node>) {
    const queue = new TestApprovalQueue();
    return {
      queue,
      session: new RpcStub(new GoogleDriveSessionImpl(
        new DriveApi(getAccessToken),
        new GoogleDocsApi(getAccessToken),
        new GoogleSheetsApi(getAccessToken),
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
    expect(nativeCalls).toEqual([]);
  });

  // The window the postcheck exists for: the move lands while the Docs call is in flight, so only a
  // second look after the read can catch it — and the content must reach neither the approval queue
  // nor the caller.
  it("discards content when the move lands during the provider read", async () => {
    const nodes = subtree();
    installFolderProvider(nodes, () => {
      nodes.set("doc-1", { id: "doc-1", mimeType: DOC_MIME, parents: ["elsewhere"], trashed: false });
    });
    const { queue, session } = folderSession(nodes);
    using scoped = session;
    using doc = await scoped.openGoogleDoc("doc-1");
    const authorizedBefore = queue.observations.length;

    await expect(Promise.resolve(doc.getContent()))
      .rejects.toThrow(OUTSIDE);
    expect(queue.observations).toHaveLength(authorizedBefore);
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
