import { afterEach, describe, expect, it, vi } from "vitest";
import { GoogleDocsApi, type GoogleDocsTab } from "../src/docs-api";
import { GoogleSheetsApi } from "../src/sheets-api";
import { readGoogleJson } from "../src/google-response";

const token = async () => "access-token";

type RawTab = {
  tabProperties: { tabId: string; title: string };
  documentTab?: Pick<GoogleDocsTab, "body"> & Partial<Pick<GoogleDocsTab, "lists" | "namedRanges">>;
  childTabs?: RawTab[];
};

/** The section break every real document body opens with. */
const EMPTY_BODY = { content: [{ startIndex: 0, endIndex: 1, sectionBreak: {} }] };

/** One provider tab, with the body and collections a fresh tab really returns. */
function rawTab(tabId: string, title: string, childTabs?: RawTab[]): RawTab {
  return {
    tabProperties: { tabId, title },
    documentTab: { body: EMPTY_BODY, lists: {}, namedRanges: {} },
    ...childTabs ? { childTabs } : {},
  };
}

function docResponse(tabs: RawTab[] = [rawTab("tab-1", "Main")]) {
  return { documentId: "doc-1", title: "Quarterly plan", revisionId: "revision-1", tabs };
}

/** The normalized counterpart of `rawTab`, with ancestry the caller states explicitly. */
function normalizedTab(
  tabId: string,
  title: string,
  position: Partial<Pick<GoogleDocsTab, "parentTabId" | "index" | "nestingLevel">> = {},
): GoogleDocsTab {
  return {
    tabId, title, index: 0, nestingLevel: 0, ...position,
    body: EMPTY_BODY, lists: {}, namedRanges: {},
  };
}

function sheetBody() {
  return {
    spreadsheetId: "sheet-1",
    properties: { title: "Forecast" },
    sheets: [],
  };
}

function oversizedResponse(cancel: () => void): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("{}"));
    },
    cancel,
  });
  return new Response(body, {
    headers: { "Content-Length": String(100 * 1024 * 1024) },
  });
}

function chunkedResponse(cancel: () => void): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2]));
      controller.enqueue(new Uint8Array([3, 4]));
    },
    cancel,
  });
  return new Response(body);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("native Google content API safety", () => {
  it("requests tab content and normalizes a single-tab document", async () => {
    let requestedUrl: string | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      requestedUrl = input instanceof Request ? input.url : input.toString();
      return Response.json(docResponse());
    }));

    await expect(new GoogleDocsApi(token).getDocument("doc-1")).resolves.toEqual({
      documentId: "doc-1",
      title: "Quarterly plan",
      revisionId: "revision-1",
      tabs: [normalizedTab("tab-1", "Main")],
    });
    expect(requestedUrl).toBe(
      "https://docs.googleapis.com/v1/documents/doc-1?includeTabsContent=true",
    );
  });

  it("requests tab-agnostic metadata for a multi-tab document", async () => {
    let requestedUrl: string | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      requestedUrl = input instanceof Request ? input.url : input.toString();
      return Response.json({
        documentId: "doc-1", title: "Quarterly plan", revisionId: "revision-1",
      });
    }));

    await expect(new GoogleDocsApi(token).getDocumentMetadata("doc-1")).resolves.toEqual({
      documentId: "doc-1",
      title: "Quarterly plan",
      revisionId: "revision-1",
    });
    expect(requestedUrl).toBe(
      "https://docs.googleapis.com/v1/documents/doc-1?fields=documentId,title,revisionId",
    );
  });

  it("rejects a metadata response for another document ID", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      documentId: "doc-2", title: "Quarterly plan",
    })));

    await expect(new GoogleDocsApi(token).getDocumentMetadata("doc-1"))
      .rejects.toThrow("Google Docs returned a different document");
  });

  it("rejects a document response for another ID", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      ...docResponse(), documentId: "doc-2",
    })));

    await expect(new GoogleDocsApi(token).getDocument("doc-1"))
      .rejects.toThrow("Google Docs returned a different document");
  });

  it("flattens the tab tree in preorder with derived ancestry", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(docResponse([
      rawTab("overview", "Overview", [rawTab("details", "Details", [
        rawTab("metrics", "Metrics"),
      ])]),
      rawTab("appendix", "Appendix"),
    ]))));

    await expect(new GoogleDocsApi(token).getDocument("doc-1")).resolves.toMatchObject({
      tabs: [
        normalizedTab("overview", "Overview"),
        normalizedTab("details", "Details", { parentTabId: "overview", nestingLevel: 1 }),
        normalizedTab("metrics", "Metrics", { parentTabId: "details", nestingLevel: 2 }),
        normalizedTab("appendix", "Appendix", { index: 1 }),
      ],
    });
  });

  it("keeps each tab's body, lists and named ranges to itself", async () => {
    const documentTab = {
      body: { content: [{ startIndex: 0, endIndex: 1, sectionBreak: {} }] },
      lists: { L1: { listProperties: { nestingLevels: [{ glyphSymbol: "\u25cf" }] } } },
      namedRanges: { mark: { namedRanges: [{ namedRangeId: "range-1", name: "mark" }] } },
    };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(docResponse([
      { ...rawTab("overview", "Overview"), documentTab },
      rawTab("appendix", "Appendix"),
    ]))));

    const { tabs } = await new GoogleDocsApi(token).getDocument("doc-1");

    expect(tabs[0]).toMatchObject(documentTab);
    expect(tabs[1]).toMatchObject({ body: EMPTY_BODY, lists: {}, namedRanges: {} });
  });

  it("defaults absent tab collections to empty", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(docResponse([{
      tabProperties: { tabId: "solo", title: "Solo" },
      documentTab: { body: EMPTY_BODY },
    }]))));

    await expect(new GoogleDocsApi(token).getDocument("doc-1")).resolves.toMatchObject({
      tabs: [normalizedTab("solo", "Solo")],
    });
  });

  it.each([
    ["no tabs", [], "Google Docs returned no document tab"],
    ["a duplicate tab ID", [rawTab("dup", "One"), rawTab("dup", "Two")],
      "Google Docs returned a duplicate tab ID"],
    ["an empty tab ID", [rawTab("", "Nameless")], "Google Docs returned an invalid tab"],
    ["a missing title", [{ tabProperties: { tabId: "solo" } }],
      "Google Docs returned an invalid tab"],
    ["a tab without content", [{ tabProperties: { tabId: "solo", title: "Solo" } }],
      "Google Docs returned an invalid tab"],
    ["a malformed body", [{
      tabProperties: { tabId: "solo", title: "Solo" },
      documentTab: { body: { content: "text" } },
    }], "Google Docs returned an invalid tab"],
    ["malformed child tabs", [{
      ...rawTab("solo", "Solo"), childTabs: {},
    }], "Google Docs returned an invalid tab"],
    ["an empty body", [{
      tabProperties: { tabId: "solo", title: "Solo" },
      documentTab: { body: { content: [] } },
    }], "Google Docs returned an invalid tab"],
    ["malformed named ranges", [{
      tabProperties: { tabId: "solo", title: "Solo" },
      documentTab: { body: EMPTY_BODY, namedRanges: [] },
    }], "Google Docs returned an invalid tab"],
  ] as const)("rejects a response with %s", async (_case, tabs, message) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(
      docResponse(tabs as unknown as RawTab[]),
    )));

    await expect(new GoogleDocsApi(token).getDocument("doc-1")).rejects.toThrow(message);
  });

  it("revision-locks marked writes and returns the created range ID", async () => {
    let requestInit: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn(async (
      _input: string | URL | Request, init?: RequestInit,
    ) => {
      requestInit = init;
      return Response.json({
        replies: [{ createNamedRange: { namedRangeId: "range-1" } }],
        writeControl: { requiredRevisionId: "revision-2" },
      });
    }));
    const request = { insertText: { text: "hello", location: { index: 1, tabId: "metrics" } } };

    const result = await new GoogleDocsApi(token).batchUpdate(
      "doc-1", [request], "revision-1",
      { name: "gadgets-write-1", rangeStart: 1, tabId: "metrics" },
    );

    expect(result).toEqual({ revisionId: "revision-2", writeMarkerId: "range-1" });
    expect(JSON.parse(String(requestInit?.body))).toEqual({
      requests: [
        {
          createNamedRange: {
            name: "gadgets-write-1",
            range: { startIndex: 1, endIndex: 2, tabId: "metrics" },
          },
        },
        request,
      ],
      writeControl: { requiredRevisionId: "revision-1" },
    });
  });

  it("deletes a named range by exact ID without write control", async () => {
    let requestedUrl: string | undefined;
    let requestInit: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn(async (
      input: string | URL | Request, init?: RequestInit,
    ) => {
      requestedUrl = input instanceof Request ? input.url : input.toString();
      requestInit = init;
      return Response.json({});
    }));

    await new GoogleDocsApi(token).deleteNamedRange("doc-1", "range-1");

    expect(requestedUrl).toBe(
      "https://docs.googleapis.com/v1/documents/doc-1:batchUpdate",
    );
    expect(JSON.parse(String(requestInit?.body))).toEqual({
      requests: [{ deleteNamedRange: { namedRangeId: "range-1" } }],
    });
  });
  it("cancels an unknown-length response once streamed bytes exceed the limit", async () => {
    const cancel = vi.fn();

    await expect(readGoogleJson(chunkedResponse(cancel), {
      provider: "Google Test", operation: "read", maxBytes: 3,
    })).rejects.toThrow(/response exceeded/);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("logs bounded provider diagnostics without provider prose", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = Response.json({
      error: {
        code: 403,
        status: "PERMISSION_DENIED",
        message: "secret provider response prose",
        errors: [{ reason: "accessNotConfigured", message: "secret nested prose" }],
        details: [
          { reason: "SERVICE_DISABLED" },
          { reason: "unsafe provider reason prose" },
        ],
      },
    }, { status: 403 });

    await expect(readGoogleJson(response, {
      provider: "Google Sheets", operation: "get spreadsheet", maxBytes: 1024,
    })).rejects.toThrow("Google Sheets get spreadsheet failed [http=403]");

    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      component: "gatekeeper.google.api",
      event: "google.api.request.failed",
      httpStatus: 403,
      operation: "get spreadsheet",
      provider: "Google Sheets",
      providerCode: 403,
      providerReasons: ["accessNotConfigured", "SERVICE_DISABLED"],
      providerStatus: "PERMISSION_DENIED",
      vendorId: "google",
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret provider");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("unsafe provider reason prose");
  });
  it.each([
    ["Docs", () => new GoogleDocsApi(token).getDocument("doc-1"), docResponse()],
    ["Sheets", () => new GoogleSheetsApi(token).getSpreadsheet("sheet-1"), sheetBody()],
  ] as const)("wires a finite timeout for %s reads", async (_provider, read, body) => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(body)));

    await read();

    expect(timeout).toHaveBeenCalledWith(30_000);
  });

  it.each([
    ["Docs", () => new GoogleDocsApi(token).getDocument("doc-1")],
    ["Sheets", () => new GoogleSheetsApi(token).getSpreadsheet("sheet-1")],
  ] as const)("cancels an oversized successful %s response", async (_provider, read) => {
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => oversizedResponse(cancel)));

    await expect(read()).rejects.toThrow(/response exceeded/);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([
    ["Docs", () => new GoogleDocsApi(token).getDocument("doc-1"),
      "Google Docs get document failed [http=403]"],
    ["Sheets", () => new GoogleSheetsApi(token).getSpreadsheet("sheet-1"),
      "Google Sheets get spreadsheet failed [http=403]"],
  ] as const)("redacts %s provider response prose", async (_provider, read, expected) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      error: { message: "secret provider response prose" },
    }, { status: 403 })));

    const error = await read().catch(value => value as Error);

    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("Expected provider read to fail");
    expect(error.message).toBe(expected);
    expect(error.message).not.toContain("secret provider");
  });
});
