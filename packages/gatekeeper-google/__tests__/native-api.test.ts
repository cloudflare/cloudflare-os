import { afterEach, describe, expect, it, vi } from "vitest";
import { GoogleDocsApi } from "../src/docs-api";
import { GoogleSheetsApi } from "../src/sheets-api";
import { readGoogleJson } from "../src/google-response";

const token = async () => "access-token";

function docBody() {
  return {
    documentId: "doc-1",
    title: "Quarterly plan",
    revisionId: "revision-1",
    body: { content: [] },
    lists: {},
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
    ["Docs", () => new GoogleDocsApi(token).getDocument("doc-1"), docBody()],
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
