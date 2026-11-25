import { afterEach, describe, expect, it, vi } from "vitest";
import { DOCUMENT_FIELDS, GoogleDocsApi, type GoogleDocsTab } from "../src/docs-api";
import { GOOGLE_SHEET_MIME_TYPE } from "../src/drive-session";
import { explainUnopenedFile } from "../src/office-conversion";
import { GoogleSheetsApi, type SheetArea } from "../src/sheets-api";
import { GoogleSlidesApi } from "../src/slides-api";
import { GoogleApiError, readGoogleJson } from "../src/google-response";
import { docsGetResponse } from "./docs-fields";
import { printedAsGoogle } from "./slides-provider";

const token = async () => "access-token";

/** Google's answer to a read whose field mask it does not take. */
const REFUSED_FIELDS = {
  error: { code: 400, status: "INVALID_ARGUMENT", message: "Request contains an invalid argument." },
};

/** The field mask a request to the stubbed `fetch` carried, or `null` for none. */
function fieldMaskOf(init: RequestInit | undefined): string | null {
  return new Headers(init?.headers).get("X-Goog-FieldMask");
}

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

/**
 * A document's answer of `bytes` bytes of valid JSON, sent in chunks of 64 KiB, with how many
 * of its bytes have been asked for.
 */
function documentAnswer(bytes: number, headers?: Record<string, string>) {
  const open = `${JSON.stringify(docResponse()).slice(0, -1)},"padding":"`;
  const body = new TextEncoder().encode(`${open}${"a".repeat(bytes - open.length - 2)}"}`);
  expect(body.length).toBe(bytes);
  let sent = 0;
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(body.subarray(sent, sent += 64 * 1024));
      if (sent >= bytes) controller.close();
    },
  }), { headers });
  return { response, sent: () => Math.min(sent, bytes) };
}

/**
 * What `getDocument` makes of `answer`, a `documentAnswer`'s: the document or what it threw, how
 * many requests it made, and the length of each text of the answer the JSON parser was handed
 * meanwhile. A text is the answer's where it begins as the answer does or holds a kilobyte of
 * its padding: the test runner parses texts of its own (a source map, at a first error).
 */
async function readDocument(answer: Response) {
  const fetch = vi.fn(async () => answer);
  vi.stubGlobal("fetch", fetch);
  const parse = vi.spyOn(JSON, "parse");
  const outcome: unknown = await new GoogleDocsApi(token).getDocument("doc-1").catch(value => value);
  const parsed = parse.mock.calls.map(([text]) => text)
    .filter(text => text.startsWith("{\"documentId\"") || text.includes("a".repeat(1024)))
    .map(text => text.length);
  parse.mockRestore();
  return { outcome, parsed, fetches: fetch.mock.calls.length };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("native Google content API safety", () => {
  it("requests tab content and normalizes a single-tab document", async () => {
    let requestedUrl: string | undefined;
    let requestedFields: string | null | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requestedUrl = input instanceof Request ? input.url : input.toString();
      requestedFields = fieldMaskOf(init);
      return Response.json(docResponse());
    }));

    await expect(new GoogleDocsApi(token).getDocument("doc-1")).resolves.toEqual({
      documentId: "doc-1",
      title: "Quarterly plan",
      revisionId: "revision-1",
      tabs: [normalizedTab("tab-1", "Main")],
    });
    expect(requestedUrl).toBe(
      "https://docs.googleapis.com/v1/documents/doc-1?includeTabsContent=true&prettyPrint=false",
    );
    expect(requestedFields).toBe(DOCUMENT_FIELDS);
  });

  it("reads a document once more without the mask when Google refuses the mask", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) =>
      fieldMaskOf(init) === null
        ? Response.json(docResponse())
        : Response.json(REFUSED_FIELDS, { status: 400 }));
    vi.stubGlobal("fetch", fetch);

    await expect(new GoogleDocsApi(token).getDocument("doc-1")).resolves.toEqual({
      documentId: "doc-1",
      title: "Quarterly plan",
      revisionId: "revision-1",
      tabs: [normalizedTab("tab-1", "Main")],
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map(([, init]) => fieldMaskOf(init))).toEqual([DOCUMENT_FIELDS, null]);
    expect(fetch.mock.calls[1][0]).toBe(fetch.mock.calls[0][0]);
    expect(error).toHaveBeenCalledOnce();
    expect(error.mock.calls[0]?.[0]).toMatchObject({
      component: "gatekeeper.google.docs",
      event: "google.doc.read.fields-refused",
      fallback: "unmasked",
      httpStatus: 400,
      operation: "get document",
      providerStatus: "INVALID_ARGUMENT",
      error: expect.stringContaining("Google Docs get document failed [http=400]"),
      vendorId: "google",
    });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ event: "google.api.request.failed" });
    // Neither line holds the mask, the document's title, its ID or Google's prose.
    const logged = JSON.stringify([error.mock.calls, warn.mock.calls]);
    for (const held of ["tabProperties", "Quarterly plan", "doc-1", "invalid argument"]) {
      expect(logged).not.toContain(held);
    }
  });

  it("reads a document with its suggestions once more without the mask when Google refuses it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) =>
      fieldMaskOf(init) === null
        ? Response.json(docResponse())
        : Response.json(REFUSED_FIELDS, { status: 400 }));
    vi.stubGlobal("fetch", fetch);

    await expect(new GoogleDocsApi(token).getDocumentWithSuggestions("doc-1"))
      .resolves.toMatchObject({ document: { documentId: "doc-1" }, suggestions: [] });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][0]).toBe(fetch.mock.calls[0][0]);
    expect(fieldMaskOf(fetch.mock.calls[1][1])).toBeNull();
    // The unmasked read keeps the suggestions inline and the compact answer.
    let asked = new URL(String(fetch.mock.calls[1][0]));
    expect(asked.searchParams.get("suggestionsViewMode")).toBe("SUGGESTIONS_INLINE");
    expect(asked.searchParams.get("prettyPrint")).toBe("false");
    expect(error.mock.calls[0]?.[0]).toMatchObject({
      event: "google.doc.read.fields-refused", operation: "get document with suggestions",
    });
  });

  it("reads once more after a 400 that is not JSON", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) =>
      fieldMaskOf(init) === null
        ? Response.json(docResponse())
        : new Response("<html>", { status: 400 }));
    vi.stubGlobal("fetch", fetch);

    await expect(new GoogleDocsApi(token).getDocument("doc-1"))
      .resolves.toMatchObject({ documentId: "doc-1" });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledOnce();
    expect(error.mock.calls[0]?.[0]).toMatchObject({
      event: "google.doc.read.fields-refused", httpStatus: 400,
    });
    expect(error.mock.calls[0]?.[0]).not.toHaveProperty("providerStatus");
  });

  it("gives the caller the unmasked read's error, and does not read a third time", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetch = vi.fn(async () => Response.json(REFUSED_FIELDS, { status: 400 }));
    vi.stubGlobal("fetch", fetch);

    const failure = await new GoogleDocsApi(token).getDocument("doc-1").catch(value => value);

    expect(failure).toBeInstanceOf(GoogleApiError);
    expect(failure).toMatchObject({
      message: "Google Docs get document failed [http=400]",
      httpStatus: 400,
      providerStatus: "INVALID_ARGUMENT",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["a 403", 403, { error: { code: 403, status: "PERMISSION_DENIED" } }],
    ["a 404", 404, { error: { code: 404, status: "NOT_FOUND" } }],
    ["a file that is not a Google Doc", 400, { error: { code: 400, status: "FAILED_PRECONDITION" } }],
  ] as const)("does not read again for a failure that is not the mask's: %s", async (
    _name, status, body,
  ) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetch = vi.fn(async () => Response.json(body, { status }));
    vi.stubGlobal("fetch", fetch);

    const failure = await new GoogleDocsApi(token).getDocument("doc-1").catch(value => value);

    expect(failure).toBeInstanceOf(GoogleApiError);
    expect(failure).toMatchObject({
      message: `Google Docs get document failed [http=${status}]`,
      httpStatus: status,
      providerStatus: body.error.status,
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();
  });

  it("does not read again when the masked answer is another document's", async () => {
    const fetch = vi.fn(async () => Response.json({ ...docResponse(), documentId: "doc-2" }));
    vi.stubGlobal("fetch", fetch);

    await expect(new GoogleDocsApi(token).getDocument("doc-1"))
      .rejects.toThrow("Google Docs returned a different document");
    expect(fetch).toHaveBeenCalledOnce();
  });

  // The limit is on the bytes read: an answer is refused by the length it declares or, where
  // it declares none, by the running total of its chunks, so the parser is handed no text of it.
  it("refuses an answer past the limit before parsing any of it", async () => {
    const LIMIT = 10 * 1024 * 1024;
    for (const declared of [false, true]) {
      const answer = documentAnswer(
        LIMIT + 1, declared ? { "Content-Length": String(LIMIT + 1) } : undefined);
      const { outcome, parsed, fetches } = await readDocument(answer.response);

      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toBe("Google Docs response exceeded the 10485760-byte limit.");
      expect(parsed).toEqual([]);
      // The refusal is not a refused mask: nothing is asked again.
      expect(fetches).toBe(1);
      // A declared length refuses the answer unread, but for what the stream had ready; with
      // none, the chunk that passes the limit does.
      if (declared) expect(answer.sent()).toBeLessThanOrEqual(2 * 64 * 1024);
      else expect(answer.sent()).toBe(LIMIT + 1);
    }

    // An answer of exactly the limit is read, and the parser is handed all of it.
    const { outcome, parsed } = await readDocument(documentAnswer(LIMIT).response);
    expect(outcome).toMatchObject({ documentId: "doc-1", tabs: [normalizedTab("tab-1", "Main")] });
    expect(parsed).toEqual([LIMIT]);
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

  it("reads the IDs of a document's top-level tabs and nothing else", async () => {
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
      docsGetResponse(new URL(input.toString()), new Headers(init?.headers), docResponse([
        rawTab("overview", "Overview", [rawTab("details", "Details")]),
        rawTab("appendix", "Appendix"),
      ])));
    vi.stubGlobal("fetch", fetch);

    await expect(new GoogleDocsApi(token).getTopLevelTabIds("doc-1"))
      .resolves.toEqual(["overview", "appendix"]);

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(
      "https://docs.googleapis.com/v1/documents/doc-1?includeTabsContent=true&prettyPrint=false" +
        "&fields=documentId%2Ctabs(tabProperties(tabId))",
    );
    expect(fieldMaskOf(init)).toBeNull();
  });

  it.each([
    ["another document", { documentId: "doc-2", tabs: [{ tabProperties: { tabId: "solo" } }] },
      "Google Docs returned a different document"],
    ["no tab", { documentId: "doc-1", tabs: [] }, "Google Docs returned no document tab"],
    ["no list of tabs", { documentId: "doc-1" }, "Google Docs returned no document tab"],
    ["a tab without an ID", {
      documentId: "doc-1", tabs: [{ tabProperties: { tabId: "solo" } }, { tabProperties: {} }],
    }, "Google Docs returned an invalid tab"],
    ["a tab with an empty ID", { documentId: "doc-1", tabs: [{ tabProperties: { tabId: "" } }] },
      "Google Docs returned an invalid tab"],
    ["a tab that is not an object", { documentId: "doc-1", tabs: [null] },
      "Google Docs returned an invalid tab"],
  ] as const)("refuses tab IDs of %s", async (_case, answer, message) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(answer)));

    await expect(new GoogleDocsApi(token).getTopLevelTabIds("doc-1")).rejects.toThrow(message);
  });

  it("does not read the IDs again when Google refuses the read", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetch = vi.fn(async () => Response.json(REFUSED_FIELDS, { status: 400 }));
    vi.stubGlobal("fetch", fetch);

    const failure = await new GoogleDocsApi(token).getTopLevelTabIds("doc-1").catch(value => value);

    expect(failure).toBeInstanceOf(GoogleApiError);
    expect(failure).toMatchObject({
      message: "Google Docs get tab IDs failed [http=400]",
      httpStatus: 400,
      providerStatus: "INVALID_ARGUMENT",
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();
  });

  it("revision-locks marked writes and returns the range ID and the requests' replies", async () => {
    let requestInit: RequestInit | undefined;
    const added = { addDocumentTab: { tabProperties: { tabId: "t.new", title: "New", index: 1 } } };
    vi.stubGlobal("fetch", vi.fn(async (
      _input: string | URL | Request, init?: RequestInit,
    ) => {
      requestInit = init;
      return Response.json({
        replies: [{ createNamedRange: { namedRangeId: "range-1" } }, added],
        writeControl: { requiredRevisionId: "revision-2" },
      });
    }));
    const request = { addDocumentTab: { tabProperties: { title: "New" } } };

    const result = await new GoogleDocsApi(token).batchUpdate(
      "doc-1", [request], "revision-1",
      { name: "gadgets-write-1", rangeStart: 1, tabId: "metrics" },
    );

    expect(result).toEqual({ revisionId: "revision-2", writeMarkerId: "range-1", replies: [added] });
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

  it("deletes a named range by exact ID in its tab, without write control", async () => {
    let requestedUrl: string | undefined;
    let requestInit: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn(async (
      input: string | URL | Request, init?: RequestInit,
    ) => {
      requestedUrl = input instanceof Request ? input.url : input.toString();
      requestInit = init;
      return Response.json({});
    }));

    await new GoogleDocsApi(token).deleteNamedRange("doc-1", "range-1", "t.2");

    expect(requestedUrl).toBe(
      "https://docs.googleapis.com/v1/documents/doc-1:batchUpdate",
    );
    expect(JSON.parse(String(requestInit?.body))).toEqual({
      requests: [{ deleteNamedRange: { namedRangeId: "range-1", tabsCriteria: { tabIds: ["t.2"] } } }],
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

  it("carries the HTTP status of a failed request", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const status of [400, 404, 503]) {
      const failure = await readGoogleJson(new Response("<html>", { status }), {
        provider: "Google Docs", operation: "get document", maxBytes: 1024,
      }).catch(value => value);
      expect(failure).toBeInstanceOf(GoogleApiError);
      expect(failure).toMatchObject({ httpStatus: status, providerStatus: undefined });
    }
    // An error made without an answer has none.
    expect(new GoogleApiError("Google Docs get document failed", "NOT_FOUND").httpStatus)
      .toBeUndefined();
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

  it("keeps Google's status but not its prose when Sheets cannot open a file", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      error: {
        code: 400,
        status: "FAILED_PRECONDITION",
        message: "This operation is not supported for this document",
      },
    }, { status: 400 })));

    const error = await new GoogleSheetsApi(token).getSpreadsheet("sheet-1").catch(value => value);

    expect(error).toBeInstanceOf(GoogleApiError);
    expect(error).toMatchObject({
      providerStatus: "FAILED_PRECONDITION",
      message: "Google Sheets get spreadsheet failed [http=400]",
    });
  });

  // A 403 without reasons says the account can't open the file only when Google's whole error
  // was read; one cut off says nothing about what Google gave.
  it("says whether a refusal's error body was read, in the error and in the log", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      error: { code: 403, message: "The caller does not have permission" },
    }, { status: 403 })));
    const read = await new GoogleDocsApi(token).getDocumentMetadata("doc-1").catch(value => value);
    expect(read).toBeInstanceOf(GoogleApiError);
    expect(read).toMatchObject({ providerReasons: [], providerErrorRead: true });
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ providerErrorRead: true });

    warn.mockClear();
    vi.useFakeTimers();
    try {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('{"error": {"code": 403')); },
      }), { status: 403 })));
      const failed = new GoogleDocsApi(token).getDocumentMetadata("doc-1").catch(value => value);
      await vi.advanceTimersByTimeAsync(2000);
      const cutOff = await failed;
      expect(cutOff).toBeInstanceOf(GoogleApiError);
      expect(cutOff).toMatchObject({ providerReasons: [], providerErrorRead: false });
      expect(warn.mock.calls[0]?.[0]).not.toHaveProperty("providerErrorRead");

      // A body that parses but never ends is cut off all the same.
      vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('{"error": {"code": 403}}')); },
      }), { status: 403 })));
      const stalled = new GoogleDocsApi(token).getDocumentMetadata("doc-1").catch(value => value);
      await vi.advanceTimersByTimeAsync(2000);
      expect(await stalled).toMatchObject({ providerReasons: [], providerErrorRead: false });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("explainUnopenedFile for a spreadsheet", () => {
  const unopened = new GoogleApiError(
    "Google Sheets get spreadsheet failed [http=400]", "FAILED_PRECONDITION");
  const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

  it("tells the caller to convert a file Drive says is not a Google Sheet", async () => {
    const explained = await explainUnopenedFile("sheets", unopened, async () => XLSX_MIME_TYPE);

    expect(explained).toBeInstanceOf(Error);
    expect((explained as Error).message)
      .toMatch(/is an Office file, such as \.xlsx.*offers to make a Google Sheets copy/);
  });

  it("keeps the original error for a native Google Sheet", async () => {
    await expect(explainUnopenedFile("sheets", unopened, async () => GOOGLE_SHEET_MIME_TYPE))
      .resolves.toBe(unopened);
  });

  it("keeps the original error when Drive cannot say what the file is", async () => {
    await expect(explainUnopenedFile("sheets", unopened, async () => {
      throw new Error("Google Drive get file failed [http=403]");
    })).resolves.toBe(unopened);
    await expect(explainUnopenedFile("sheets", unopened, async () => undefined))
      .resolves.toBe(unopened);
  });

  it("does not ask Drive about any other failure", async () => {
    const denied = new GoogleApiError(
      "Google Sheets get spreadsheet failed [http=403]", "PERMISSION_DENIED");
    const mimeType = vi.fn(async () => XLSX_MIME_TYPE);

    await expect(explainUnopenedFile("sheets", denied, mimeType)).resolves.toBe(denied);
    expect(mimeType).not.toHaveBeenCalled();
  });
});

/** Answers every request with `body`, printed as Google prints it, and lists the URLs asked. */
function answerAsGoogle(body: unknown): string[] {
  let urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    let url = input instanceof Request ? input.url : input.toString();
    urls.push(url);
    return printedAsGoogle(new URL(url), Response.json(body));
  }));
  return urls;
}

describe("compact JSON", () => {
  const slides = new GoogleSlidesApi(token);
  const sheets = new GoogleSheetsApi(token);
  const CELL: SheetArea = { sheetId: 0, rect: { startRow: 0, endRow: 1, startColumn: 0, endColumn: 1 } };
  /** A sheet's answer holding data that starts at `CELL`. */
  const GRID = { sheets: [{ properties: { sheetId: 0, title: "Data" }, data: [{}] }] };
  const DECK = { presentationId: "deck-1" };

  it.each([
    { name: "Slides getPresentation", read: () => slides.getPresentation("deck-1"), body: DECK },
    { name: "Slides getPresentationTitle", read: () => slides.getPresentationTitle("deck-1"), body: DECK },
    { name: "Slides getOutline", read: () => slides.getOutline("deck-1"), body: DECK },
    { name: "Slides getSlide", read: () => slides.getSlide("deck-1", "s1"), body: { objectId: "s1" } },
    { name: "Slides getLayout", read: () => slides.getLayout("deck-1", "l1"), body: { objectId: "l1" } },
    {
      name: "Slides getThumbnail",
      // The image is fetched next, and is no PNG here.
      read: () => slides.getThumbnail("deck-1", "s1", "MEDIUM").catch(() => undefined),
      body: { contentUrl: "https://lh3.googleusercontent.com/thumbnail" },
    },
    { name: "Sheets getSpreadsheet", read: () => sheets.getSpreadsheet("sheet-1"), body: sheetBody() },
    { name: "Sheets getMetadata", read: () => sheets.getMetadata("sheet-1"), body: sheetBody() },
    { name: "Sheets readRanges", read: () => sheets.readRanges("sheet-1", ["Data!A1"]), body: {} },
    { name: "Sheets readEntered", read: () => sheets.readEntered("sheet-1", [CELL]), body: GRID },
    {
      name: "Sheets readAreas",
      read: () => sheets.readAreas("sheet-1", [CELL], "formatted"),
      body: { valueRanges: [{ dataFilters: [{ gridRange: { endRowIndex: 1, endColumnIndex: 1 } }] }] },
    },
    { name: "Sheets readFormats", read: () => sheets.readFormats("sheet-1", "Data!A1"), body: GRID },
    { name: "Sheets readFormatAreas", read: () => sheets.readFormatAreas("sheet-1", [CELL]), body: GRID },
    {
      name: "Sheets getDeveloperMetadata",
      read: () => sheets.getDeveloperMetadata("sheet-1", 7), body: { metadataValue: "kept" },
    },
  ])("asks Google for compact JSON: $name", async ({ read, body }) => {
    let urls = answerAsGoogle(body);

    await read();

    expect(new URL(urls[0]).searchParams.get("prettyPrint")).toBe("false");
  });

  it("reads a slide page that fits its cap only as compact JSON", async () => {
    let side = { magnitude: 3_000_000, unit: "EMU" };
    let slide = {
      objectId: "s1",
      pageElements: Array.from({ length: 5_500 }, (_element, at) => ({
        objectId: `element-${at}`,
        size: { width: side, height: side },
        transform: { scaleX: 1, scaleY: 1, translateX: 311_700 + at, translateY: 1_152_475, unit: "EMU" },
      })),
    };
    let cap = 2 * 1024 * 1024;
    expect(JSON.stringify(slide).length).toBeLessThan(cap);
    expect(`${JSON.stringify(slide, null, 2)}\n`.length).toBeGreaterThan(cap);
    answerAsGoogle(slide);

    await expect(slides.getSlide("deck-1", "s1")).resolves.toEqual(slide);
  });

  it("reads values that fit the cap only as compact JSON", async () => {
    let values = Array.from({ length: 500 }, (_row, r) => Array.from({ length: 100 }, (_cell, c) =>
      `${r}:${c}`.padEnd(95, "x")));
    let body = {
      spreadsheetId: "sheet-1",
      valueRanges: [{ range: "Data!A1:CV500", majorDimension: "ROWS", values }],
    };
    let cap = 5 * 1024 * 1024;
    expect(JSON.stringify(body).length).toBeLessThan(cap);
    expect(`${JSON.stringify(body, null, 2)}\n`.length).toBeGreaterThan(cap);
    answerAsGoogle(body);

    await expect(sheets.readRanges("sheet-1", ["Data!A1:CV500"])).resolves.toEqual([
      { range: "Data!A1:CV500", values },
    ]);
  });
});
