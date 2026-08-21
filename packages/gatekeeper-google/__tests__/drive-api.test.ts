import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DRIVE_FILE_FIELDS, DriveApi, DriveApiDisabledError, buildDriveQuery, escapeDriveQueryLiteral,
} from "../src/drive-api";

/** Google's real error envelope for an API that is not enabled on the project. */
const API_DISABLED_BODY = JSON.stringify({
  error: {
    code: 403,
    message: "Google Drive API has not been used in project 1234 before or it is disabled.",
    errors: [{ domain: "usageLimits", reason: "accessNotConfigured" }],
  },
});

/** Installs a fetch stub and returns the requests it was called with. */
function stubFetch(responses: Response[] | (() => Response)) {
  let calls: { url: URL; headers: Headers; method?: string; body?: string }[] = [];
  let queue = Array.isArray(responses) ? [...responses] : null;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({
      url: new URL(url),
      headers: new Headers(init.headers),
      method: init.method,
      ...(init.body === undefined || init.body === null ? {} : { body: String(init.body) }),
    });
    if (queue) {
      let next = queue.shift();
      if (!next) throw new Error("unexpected extra fetch");
      return next;
    }
    return (responses as () => Response)();
  });
  return calls;
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

const api = (token = "tok") => new DriveApi(async () => token);

function batchResponse(results: { status: number; body?: string }[]): Response {
  let boundary = "drive_test_boundary";
  let body = results.map((result, index) => [
    `--${boundary}`,
    "Content-Type: application/http",
    `Content-ID: <response-item-${index}>`,
    "",
    `HTTP/1.1 ${result.status} Test`,
    "Content-Type: application/json",
    "",
    result.body ?? "{}",
  ].join("\r\n")).join("\r\n") + `\r\n--${boundary}--\r\n`;
  return new Response(body, { headers: { "Content-Type": `multipart/mixed; boundary=${boundary}` } });
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("escapeDriveQueryLiteral", () => {
  it("leaves an ordinary value alone", () => {
    expect(escapeDriveQueryLiteral("Quarterly Report")).toBe("Quarterly Report");
  });

  // A name that closes the literal could append its own clauses and read outside the scope.
  it("escapes a quote so it cannot close the literal", () => {
    expect(escapeDriveQueryLiteral("Bob's notes")).toBe("Bob\\'s notes");
  });

  it("escapes backslashes before quotes, so an escape cannot be neutralized", () => {
    expect(escapeDriveQueryLiteral("a\\'b")).toBe("a\\\\\\'b");
  });

  it("defuses an injected clause", () => {
    let injected = "x' or name contains 'secret";
    expect(buildDriveQuery({ nameContains: injected }))
      .toBe("trashed = false and name contains 'x\\' or name contains \\'secret'");
  });
});

describe("buildDriveQuery", () => {
  it("always excludes trashed files", () => {
    expect(buildDriveQuery({})).toBe("trashed = false");
  });

  it("ANDs the mime type and the name fragment", () => {
    expect(buildDriveQuery({ mimeType: "application/vnd.google-apps.document", nameContains: "q3" }))
      .toBe(
        "trashed = false and mimeType = 'application/vnd.google-apps.document' " +
        "and name contains 'q3'");
  });

  it("ignores a blank or whitespace-only name fragment", () => {
    expect(buildDriveQuery({ nameContains: "   " })).toBe("trashed = false");
  });

  it("trims the name fragment", () => {
    expect(buildDriveQuery({ nameContains: "  q3  " })).toBe("trashed = false and name contains 'q3'");
  });
  it("ANDs every structured search filter and ORs MIME types", () => {
    expect(buildDriveQuery({
      nameContains: "Quarter",
      fullTextContains: "budget",
      mimeTypes: ["application/pdf", "text/plain"],
      modifiedAfter: "2026-01-01T00:00:00Z",
      modifiedBefore: "2026-02-01T00:00:00Z",
      directParentId: "folder-1",
    })).toBe(
      "trashed = false and name contains 'Quarter' and fullText contains 'budget' and " +
      "(mimeType = 'application/pdf' or mimeType = 'text/plain') and " +
      "modifiedTime > '2026-01-01T00:00:00Z' and " +
      "modifiedTime < '2026-02-01T00:00:00Z' and 'folder-1' in parents",
    );
  });
});

describe("listFiles", () => {
  it("requests the field mask that DriveFile describes", async () => {
    let calls = stubFetch([jsonResponse({ files: [] })]);
    await api().listFiles();
    expect(calls[0].url.searchParams.get("fields")).toBe(DRIVE_FILE_FIELDS);
  });

  it("sends the bearer token", async () => {
    let calls = stubFetch([jsonResponse({ files: [] })]);
    await api("secret-token").listFiles();
    expect(calls[0].headers.get("Authorization")).toBe("Bearer secret-token");
  });

  it("includes shared drives", async () => {
    let calls = stubFetch([jsonResponse({ files: [] })]);
    await api().listFiles();
    let params = calls[0].url.searchParams;
    expect(params.get("supportsAllDrives")).toBe("true");
    expect(params.get("includeItemsFromAllDrives")).toBe("true");
  });

  it("defaults to the hundred most recently modified", async () => {
    let calls = stubFetch([jsonResponse({ files: [] })]);
    await api().listFiles();
    expect(calls[0].url.searchParams.get("pageSize")).toBe("100");
    expect(calls[0].url.searchParams.get("orderBy")).toBe("modifiedTime desc");
  });

  it("omits the page token on the first request", async () => {
    let calls = stubFetch([jsonResponse({ files: [] })]);
    await api().listFiles();
    expect(calls[0].url.searchParams.has("pageToken")).toBe(false);
  });

  it("forwards a page token when given one", async () => {
    let calls = stubFetch([jsonResponse({ files: [] })]);
    await api().listFiles({ pageToken: "next" });
    expect(calls[0].url.searchParams.get("pageToken")).toBe("next");
  });

  it("returns the files and the continuation token", async () => {
    stubFetch([jsonResponse({ files: [{ id: "1", name: "a" }], nextPageToken: "p2" })]);
    expect(await api().listFiles())
      .toEqual({ files: [{ id: "1", name: "a" }], nextPageToken: "p2" });
  });

  it("treats a response with no files array as an empty page", async () => {
    stubFetch([jsonResponse({})]);
    expect(await api().listFiles()).toEqual({ files: [] });
  });

  it("omits nextPageToken on the last page rather than reporting it undefined", async () => {
    stubFetch([jsonResponse({ files: [] })]);
    expect("nextPageToken" in await api().listFiles()).toBe(false);
  });
  it("targets one shared-drive corpus when requested", async () => {
    let calls = stubFetch([jsonResponse({ files: [] })]);
    await api().listFiles({ corpora: "drive", driveId: "shared-1" });
    let params = calls[0].url.searchParams;
    expect(params.get("corpora")).toBe("drive");
    expect(params.get("driveId")).toBe("shared-1");
    expect(params.get("spaces")).toBe("drive");
  });

  it("can preserve Drive relevance order by omitting orderBy", async () => {
    let calls = stubFetch([jsonResponse({ files: [] })]);
    await api().listFiles({ orderBy: null });
    expect(calls[0].url.searchParams.has("orderBy")).toBe(false);
  });
  it("rejects malformed file metadata instead of trusting Google's response", async () => {
    stubFetch([jsonResponse({ files: [{ id: 42, name: "not-valid" }] })]);
    await expect(api().listFiles()).rejects.toThrow("Invalid Google Drive file response");
  });
});

describe("listDrives", () => {
  it("returns shared-drive picker options and forwards pagination", async () => {
    let calls = stubFetch([jsonResponse({
      drives: [{ id: "drive-1", name: "Product" }], nextPageToken: "p2",
    })]);

    expect(await api().listDrives({ pageToken: "p1" })).toEqual({
      drives: [{ id: "drive-1", name: "Product" }], nextPageToken: "p2",
    });
    expect(calls[0].url.pathname).toBe("/drive/v3/drives");
    expect(calls[0].url.searchParams.get("pageSize")).toBe("100");
    expect(calls[0].url.searchParams.get("pageToken")).toBe("p1");
  });

  it("rejects malformed shared-drive metadata", async () => {
    stubFetch([jsonResponse({ drives: [{ id: "drive-1", name: false }] })]);
    await expect(api().listDrives()).rejects.toThrow("Invalid Google shared-drive response");
  });
});

describe("metadata lookup", () => {
  it("gets one file with shared-drive support and the public metadata fields", async () => {
    let file = {
      id: "file/1", name: "Plan", mimeType: "application/pdf",
      modifiedTime: "2026-01-02T03:04:05Z",
    };
    let calls = stubFetch([jsonResponse(file)]);

    expect(await api().getFile("file/1")).toEqual(file);
    expect(calls[0].url.pathname).toBe("/drive/v3/files/file%2F1");
    expect(calls[0].url.searchParams.get("supportsAllDrives")).toBe("true");
    let fields = calls[0].url.searchParams.get("fields");
    expect(fields).toContain("shortcutDetails");
    expect(fields).not.toMatch(/createdTime|photoLink|iconLink|thumbnailLink/);
  });

  it("gets current shared-drive metadata by stable ID", async () => {
    let calls = stubFetch([jsonResponse({ id: "drive/1", name: "Current name" })]);
    expect(await api().getDrive("drive/1")).toEqual({ id: "drive/1", name: "Current name" });
    expect(calls[0].url.pathname).toBe("/drive/v3/drives/drive%2F1");
  });
  it("cancels an oversized JSON response before reading the remaining stream", async () => {
    let pulls = 0;
    let cancelled = false;
    let body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls <= 3) controller.enqueue(new Uint8Array(3_000_000));
        else controller.close();
      },
      cancel() { cancelled = true; },
    });
    stubFetch([new Response(body)]);

    await expect(api().listFiles()).rejects.toThrow("Google Drive response was too large");
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(4);
  });
});

describe("bulk access verification", () => {
  it("maps fresh files.get outcomes back to the requested ID order", async () => {
    let calls = stubFetch([batchResponse([
      { status: 200 }, { status: 403 }, { status: 404 },
    ])]);
    await expect(api().checkFileAccess(["one", "two", "three"]))
      .resolves.toEqual([true, false, false]);
    expect(calls[0].url.href).toBe("https://www.googleapis.com/batch/drive/v3");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toContain("GET /drive/v3/files/one?fields=id&supportsAllDrives=true");
  });

  it("limits each Google batch to 100 file IDs without imposing a total cap", async () => {
    let calls = stubFetch([
      batchResponse(Array.from({ length: 100 }, () => ({ status: 200 }))),
      batchResponse([{ status: 200 }]),
    ]);
    await expect(api().checkFileAccess(
      Array.from({ length: 101 }, (_, index) => `file-${index}`),
    )).resolves.toHaveLength(101);
    expect(calls).toHaveLength(2);
    expect(calls.map(call => call.body?.match(/GET \/drive\/v3\/files\//g)?.length))
      .toEqual([100, 1]);
  });

  it("checks no Google endpoint for an empty file set", async () => {
    let calls = stubFetch([]);
    await expect(api().checkFileAccess([])).resolves.toEqual([]);
    expect(calls).toEqual([]);
  });

  it("distinguishes an API-disabled inner response", async () => {
    stubFetch([batchResponse([{ status: 403, body: API_DISABLED_BODY }])]);
    await expect(api().checkFileAccess(["one"]))
      .rejects.toBeInstanceOf(DriveApiDisabledError);
  });

  it("does not infer API disablement from unstructured error text", async () => {
    let body = JSON.stringify({ error: { message: "accessNotConfigured" } });
    stubFetch([batchResponse([{ status: 403, body }])]);
    await expect(api().checkFileAccess(["one"])).resolves.toEqual([false]);
  });

  it("cancels an oversized batch response before reading the remaining stream", async () => {
    let pulls = 0;
    let cancelled = false;
    let body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls <= 3) controller.enqueue(new Uint8Array(600_000));
        else controller.close();
      },
      cancel() { cancelled = true; },
    });
    stubFetch([new Response(body, {
      headers: { "Content-Type": "multipart/mixed; boundary=response_boundary" },
    })]);

    await expect(api().checkFileAccess(["one"]))
      .rejects.toThrow("Google Drive batch response was too large");
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(4);
  });

  it("fails a transient inner response instead of reporting an access denial", async () => {
    stubFetch([batchResponse([{ status: 429 }])]);
    await expect(api().checkFileAccess(["one"]))
      .rejects.toThrow("Google Drive batch subrequest failed: 429");
  });
});

describe("error handling", () => {
  it("distinguishes the API-not-enabled 403 by Google's reason, which the admin must fix", async () => {
    stubFetch([new Response(API_DISABLED_BODY, { status: 403 })]);
    await expect(api().listFiles()).rejects.toBeInstanceOf(DriveApiDisabledError);
  });

  it("does not mistake another 403 for the API being disabled", async () => {
    stubFetch([new Response(JSON.stringify({
      error: { errors: [{ reason: "insufficientPermissions" }] },
    }), { status: 403 })]);
    let error = await api().listFiles().catch(e => e);
    expect(error).not.toBeInstanceOf(DriveApiDisabledError);
    expect(error.message).toBe("Google Drive API request failed: 403 (insufficientPermissions)");
  });

  it("reports the status alone when Google declared no reason", async () => {
    stubFetch([new Response("{}", { status: 404 })]);
    await expect(api().listFiles())
      .rejects.toThrow("Google Drive API request failed: 404");
  });

  // The provider's prose can quote the `q` we sent, and this error reaches a UI that may forward
  // it to the error reporter.
  it("never puts the response body in the error", async () => {
    let body = JSON.stringify({
      error: {
        message: "Invalid query: name contains 'Acme Q3 acquisition'",
        errors: [{ reason: "invalid" }],
      },
    });
    stubFetch([new Response(body, { status: 400 })]);
    let error = await api().listFiles().catch(e => e);
    expect(error.message).toBe("Google Drive API request failed: 400 (invalid)");
    expect(error.message).not.toContain("Acme");
  });

  it("survives a non-JSON error body", async () => {
    stubFetch([new Response("<html>400 Bad Request</html>", { status: 400 })]);
    await expect(api().listFiles())
      .rejects.toThrow("Google Drive API request failed: 400");
  });

  it("survives an empty error body", async () => {
    stubFetch([new Response("", { status: 403 })]);
    let error = await api().listFiles().catch(e => e);
    expect(error).not.toBeInstanceOf(DriveApiDisabledError);
    expect(error.message).toBe("Google Drive API request failed: 403");
  });

  it("ignores a reason that is not a plain identifier", async () => {
    stubFetch([new Response(JSON.stringify({
      error: { errors: [{ reason: "not an identifier: leaked 'secret'" }] },
    }), { status: 400 })]);
    let error = await api().listFiles().catch(e => e);
    expect(error.message).toBe("Google Drive API request failed: 400");
  });

  it("ignores a non-string reason", async () => {
    stubFetch([new Response(JSON.stringify({
      error: { errors: [{ reason: { nested: true } }] },
    }), { status: 400 })]);
    await expect(api().listFiles())
      .rejects.toThrow("Google Drive API request failed: 400");
  });

  // A body large enough that parsing it whole would be the expensive part of failing.
  it("caps how much of an oversized body it parses", async () => {
    let padded = "x".repeat(64 * 1024);
    stubFetch([new Response(JSON.stringify({
      error: { message: padded, errors: [{ reason: "invalid" }] },
    }), { status: 400 })]);
    let error = await api().listFiles().catch(e => e);
    // Truncation makes the JSON unparseable, so no reason survives — and no body leaks either.
    expect(error.message).toBe("Google Drive API request failed: 400");
    expect(error.message).not.toContain("x");
  });
});

// Bypassing fetchWithAuthRetry was the bug that motivated this module: the configurator talked to
// Drive with a raw fetch, so a stale token 401'd instead of refreshing.
describe("auth retry", () => {
  it("refreshes once on a 401 and replays the request", async () => {
    let issued = ["stale", "fresh"];
    let drive = new DriveApi(async opts => issued[opts?.forceRefresh ? 1 : 0]);
    let calls = stubFetch([
      new Response("expired", { status: 401 }),
      jsonResponse({ files: [{ id: "1", name: "a" }] }),
    ]);

    expect((await drive.listFiles()).files).toHaveLength(1);
    expect(calls.map(call => call.headers.get("Authorization")))
      .toEqual(["Bearer stale", "Bearer fresh"]);
  });

  it("tells the authority which token was rejected", async () => {
    let requests: unknown[] = [];
    let drive = new DriveApi(async opts => {
      requests.push(opts);
      return opts?.forceRefresh ? "fresh" : "stale";
    });
    stubFetch([new Response("expired", { status: 401 }), jsonResponse({ files: [] })]);

    await drive.listFiles();
    expect(requests).toEqual([undefined, { forceRefresh: true, staleToken: "stale" }]);
  });

  it("gives up rather than looping when the refreshed token is also rejected", async () => {
    let drive = new DriveApi(async () => "tok");
    let calls = stubFetch(() => new Response("expired", { status: 401 }));

    await expect(drive.listFiles()).rejects.toThrow("401");
    expect(calls).toHaveLength(2);
  });

  it("retries a 429, which a raw fetch would have surfaced as a failure", async () => {
    let drive = new DriveApi(async () => "tok");
    let calls = stubFetch([
      new Response("slow down", { status: 429, headers: { "Retry-After": "0" } }),
      jsonResponse({ files: [{ id: "1", name: "a" }] }),
    ]);

    expect((await drive.listFiles()).files).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it("retries a 5xx, then reports it sanitized once the budget runs out", async () => {
    let drive = new DriveApi(async () => "tok");
    let calls = stubFetch(() => new Response(JSON.stringify({
      error: { errors: [{ reason: "backendError" }] },
    }), { status: 503 }));

    await expect(drive.listFiles())
      .rejects.toThrow("Google Drive API request failed: 503 (backendError)");
    expect(calls).toHaveLength(3);
  });
});
