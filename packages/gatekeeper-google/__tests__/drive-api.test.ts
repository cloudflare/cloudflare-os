import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMMENT_WRITE_MAX_MS, DRIVE_FILE_ITEM_FIELDS, DriveApi, DriveApiDisabledError,
  DriveApiRequestError, FOLDER_MIME_TYPE, MAX_COMMENT_BYTES, MAX_QUERY_PARENTS, MY_DRIVE_ROOT,
  buildDriveQuery, conversionError, driveWriteFailure, escapeDriveQueryLiteral, isDriveCommentId,
  isDriveFileId, isDrivePermissionId, isFileInvisible, isInsufficientScope, lacksFileContentAccess,
  type DriveConversionSource, type DriveGivableRole,
} from "../src/drive-api";

/** Google's real error envelope for an API that is not enabled on the project. */
const API_DISABLED_BODY = JSON.stringify({
  error: {
    code: 403,
    message: "Google Drive API has not been used in project 1234 before or it is disabled.",
    errors: [{ domain: "usageLimits", reason: "accessNotConfigured" }],
  },
});

/** Google's error envelope for a token that lacks a scope the request needs. */
const MISSING_SCOPE_BODY = JSON.stringify({
  error: { code: 403, errors: [{ domain: "global", reason: "insufficientPermissions" }] },
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

/**
 * A batch response shaped like a real one: every part's body is followed by a blank line before the
 * next boundary. Omitting that line made the parser's old last-chunk body extraction look correct.
 */
function batchResponse(results: { status: number; body?: string; contentId?: string }[]): Response {
  let boundary = "drive_test_boundary";
  let body = results.map((result, index) => [
    `--${boundary}`,
    "Content-Type: application/http",
    `Content-ID: <${result.contentId ?? `response-item-${index}`}>`,
    "",
    `HTTP/1.1 ${result.status} Test`,
    "Content-Type: application/json",
    "",
    result.body ?? "{}",
    "",
  ].join("\r\n")).join("\r\n") + `\r\n--${boundary}--\r\n`;
  return new Response(body, { headers: { "Content-Type": `multipart/mixed; boundary=${boundary}` } });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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
    expect(buildDriveQuery({ namePrefix: injected }))
      .toBe("trashed = false and name contains 'x\\' or name contains \\'secret'");
  });
});

describe("buildDriveQuery", () => {
  it("always excludes trashed files", () => {
    expect(buildDriveQuery({})).toBe("trashed = false");
  });

  it("ANDs the MIME type and name prefix", () => {
    expect(buildDriveQuery({ mimeType: "application/vnd.google-apps.document", namePrefix: "q3" }))
      .toBe(
        "trashed = false and mimeType = 'application/vnd.google-apps.document' " +
        "and name contains 'q3'");
  });

  it("ignores a blank or whitespace-only name prefix", () => {
    expect(buildDriveQuery({ namePrefix: "   " })).toBe("trashed = false");
  });

  it("trims name prefixes before emitting Drive's prefix-only contains operator", () => {
    expect(buildDriveQuery({ namePrefix: "  q3  " })).toBe("trashed = false and name contains 'q3'");
  });
  it("ANDs every structured search filter and ORs MIME types", () => {
    expect(buildDriveQuery({
      namePrefix: "Quarter",
      fullTextContains: "budget",
      mimeTypes: ["application/pdf", "text/plain"],
      modifiedAfter: "2026-01-01T00:00:00Z",
      modifiedBefore: "2026-02-01T00:00:00Z",
      directParentIds: ["folder-1"],
    })).toBe(
      "trashed = false and name contains 'Quarter' and fullText contains 'budget' and " +
      "(mimeType = 'application/pdf' or mimeType = 'text/plain') and " +
      "modifiedTime > '2026-01-01T00:00:00Z' and " +
      "modifiedTime < '2026-02-01T00:00:00Z' and 'folder-1' in parents",
    );
  });

  it("ANDs mimeType with mimeTypes rather than dropping it", () => {
    expect(buildDriveQuery({
      mimeType: "application/pdf",
      mimeTypes: ["text/plain", "text/csv"],
    })).toBe(
      "trashed = false and mimeType = 'application/pdf' and " +
      "(mimeType = 'text/plain' or mimeType = 'text/csv')",
    );
  });

  it("escapes each newly interpolated search value", () => {
    expect(buildDriveQuery({
      fullTextContains: "Ada's \\note",
      mimeTypes: ["app/x-'a", "app/x-\\b"],
      modifiedAfter: "2026-'01",
      modifiedBefore: "2026-\\02",
      directParentIds: ["folder-'1\\"],
    })).toBe(
      "trashed = false and fullText contains 'Ada\\'s \\\\note' and " +
      "(mimeType = 'app/x-\\'a' or mimeType = 'app/x-\\\\b') and " +
      "modifiedTime > '2026-\\'01' and " +
      "modifiedTime < '2026-\\\\02' and " +
      "'folder-\\'1\\\\' in parents",
    );
  });

  it("ORs every parent so one query spans several proven folders", () => {
    expect(buildDriveQuery({ directParentIds: ["a", "b", "c"] })).toBe(
      "trashed = false and ('a' in parents or 'b' in parents or 'c' in parents)",
    );
  });

  // Dropping an empty narrowing widens the read to the whole binding, which is the opposite of
  // what was asked. Omitting the field is how a caller asks for that.
  it.each([[[]], [["  "]]])("refuses a parent set naming nothing: %j", parents => {
    expect(() => buildDriveQuery({ directParentIds: parents }))
      .toThrow(/must name at least one parent/);
  });

  // Drive documents no `q` length limit, so the cap is ours: an OR group long enough to trip the
  // provider would fail with an opaque 400 after the batched parent proof had already passed.
  it("refuses more parents than one query carries", () => {
    let ids = Array.from({ length: MAX_QUERY_PARENTS + 1 }, (_, index) => `f${index}`);
    expect(() => buildDriveQuery({ directParentIds: ids })).toThrow(/at most 50 parents/);
    expect(buildDriveQuery({ directParentIds: ids.slice(0, MAX_QUERY_PARENTS) }))
      .toContain("'f49' in parents");
  });
});

describe("listFiles", () => {
  it("requests the field mask that DriveFile describes", async () => {
    let calls = stubFetch([jsonResponse({ files: [] })]);
    await api().listFiles();
    expect(calls[0].url.searchParams.get("fields"))
      .toBe(`incompleteSearch,nextPageToken,files(${DRIVE_FILE_ITEM_FIELDS})`);
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

  it("describes malformed response sizes as UTF-16 code units", async () => {
    stubFetch([new Response("é")]);
    await expect(api().listFiles()).rejects
      .toThrow("Google Drive response was not valid JSON (1 UTF-16 code units)");
  });

  it("omits nextPageToken on the last page rather than reporting it undefined", async () => {
    stubFetch([jsonResponse({ files: [] })]);
    expect("nextPageToken" in await api().listFiles()).toBe(false);
  });
  it("targets one shared-drive corpus when requested", async () => {
    let calls = stubFetch([jsonResponse({ files: [] })]);
    await api().listFiles({ corpus: { kind: "drive", driveId: "shared-1" } });
    let params = calls[0].url.searchParams;
    expect(params.get("corpora")).toBe("drive");
    expect(params.get("driveId")).toBe("shared-1");
    expect(params.get("spaces")).toBe("drive");
  });

  it("defaults to the user corpus and never sends a dangling driveId", async () => {
    let calls = stubFetch([jsonResponse({ files: [] })]);
    await api().listFiles();
    expect(calls[0].url.searchParams.get("corpora")).toBe("user");
    expect(calls[0].url.searchParams.has("driveId")).toBe(false);
  });

  it("spans every corpus the account can reach without a dangling driveId", async () => {
    let calls = stubFetch([jsonResponse({ files: [] })]);
    await api().listFiles({ corpus: { kind: "allDrives" } });
    let params = calls[0].url.searchParams;
    expect(params.get("corpora")).toBe("allDrives");
    expect(params.get("supportsAllDrives")).toBe("true");
    expect(params.get("includeItemsFromAllDrives")).toBe("true");
    expect(params.has("driveId")).toBe(false);
  });

  // A cross-corpus search Drive declares incomplete is not safely presentable as a complete
  // result, so it fails here rather than reaching a caller that cannot tell.
  it("refuses a search Drive reports as incomplete", async () => {
    stubFetch([jsonResponse({ incompleteSearch: true, files: [{ id: "1", name: "a" }] })]);
    await expect(api().listFiles({ corpus: { kind: "allDrives" } })).rejects
      .toThrow("Google Drive could not complete this search. Try again.");
  });

  it("accepts a search Drive reports as complete", async () => {
    stubFetch([jsonResponse({ incompleteSearch: false, files: [{ id: "1", name: "a" }] })]);
    expect(await api().listFiles()).toEqual({ files: [{ id: "1", name: "a" }] });
  });

  it("rejects a non-boolean completeness claim instead of guessing", async () => {
    stubFetch([jsonResponse({ incompleteSearch: "true", files: [] })]);
    await expect(api().listFiles()).rejects.toThrow("Invalid Google Drive incompleteSearch");
  });

  it("sends the assembled query as the Drive q parameter", async () => {
    let calls = stubFetch([jsonResponse({ files: [] })]);
    await api().listFiles({
      namePrefix: "Quarter",
      fullTextContains: "budget",
      mimeTypes: ["application/pdf"],
      directParentIds: ["folder-1"],
    });
    expect(calls[0].url.searchParams.get("q")).toBe(
      "trashed = false and name contains 'Quarter' and fullText contains 'budget' and " +
      "(mimeType = 'application/pdf') and 'folder-1' in parents",
    );
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

describe("metadata lookup", () => {
  it("gets one file with shared-drive support and the public metadata fields", async () => {
    let file = {
      id: "file/1", name: "Plan", mimeType: "application/pdf",
      modifiedTime: "2026-01-02T03:04:05Z", trashed: false,
      capabilities: { canListChildren: true, canDownload: false },
    };
    let calls = stubFetch([jsonResponse(file)]);
    expect(await api().getFile("file/1")).toEqual(file);
    expect(calls[0].url.pathname).toBe("/drive/v3/files/file%2F1");
    expect(calls[0].url.searchParams.get("supportsAllDrives")).toBe("true");
    expect(calls[0].url.searchParams.get("fields")).toBe(DRIVE_FILE_ITEM_FIELDS);
    expect(DRIVE_FILE_ITEM_FIELDS.split(",")).toContain("trashed");
    expect(DRIVE_FILE_ITEM_FIELDS).toContain("capabilities(canListChildren,canDownload,canAddChildren)");
    expect(DRIVE_FILE_ITEM_FIELDS).not.toMatch(/createdTime|photoLink|iconLink|thumbnailLink/);
  });

  it("rejects a non-boolean canDownload capability", async () => {
    stubFetch([jsonResponse({ id: "file-1", name: "Plan", capabilities: { canDownload: "no" } })]);
    await expect(api().getFile("file-1")).rejects
      .toThrow("Invalid Google Drive file capabilities.canDownload");
  });

  it("round-trips the shared-drive and shortcut fields DriveSession scopes on", async () => {
    let file = {
      id: "file-1",
      name: "Plan",
      mimeType: "application/pdf",
      modifiedTime: "2026-01-02T03:04:05Z",
      driveId: "drive-1",
      parents: ["folder-1"],
      owners: [{ displayName: "Ada", emailAddress: "ada@example.com" }],
      shortcutDetails: { targetId: "target-1", targetMimeType: "text/plain" },
      webViewLink: "https://drive.google.com/file/d/file-1/view",
      trashed: true,
    };
    stubFetch([jsonResponse(file)]);
    expect(await api().getFile("file-1")).toEqual(file);
  });

  it("rejects a non-boolean trashed field", async () => {
    stubFetch([jsonResponse({ id: "file-1", name: "Plan", trashed: "false" })]);
    await expect(api().getFile("file-1")).rejects
      .toThrow("Invalid Google Drive file trashed");
  });

  it("drops unrequested provider fields from a file response", async () => {
    let file = {
      id: "file-1",
      name: "Plan",
      driveId: "drive-1",
      parents: ["folder-1"],
      owners: [{ displayName: "Ada", emailAddress: "ada@example.com" }],
      shortcutDetails: { targetId: "target-1", targetMimeType: "text/plain" },
      webViewLink: "https://drive.google.com/file/d/file-1/view",
      permissions: [{ role: "reader" }],
      description: "should not leak",
    };
    stubFetch([jsonResponse(file)]);
    expect(await api().getFile("file-1")).toEqual({
      id: "file-1",
      name: "Plan",
      driveId: "drive-1",
      parents: ["folder-1"],
      owners: [{ displayName: "Ada", emailAddress: "ada@example.com" }],
      shortcutDetails: { targetId: "target-1", targetMimeType: "text/plain" },
      webViewLink: "https://drive.google.com/file/d/file-1/view",
    });
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
    await expect(api().checkObservations(["one", "two", "three"].map(fileId => ({ kind: "file" as const, fileId }))))
      .resolves.toEqual([true, false, false]);
    expect(calls[0].url.href).toBe("https://www.googleapis.com/batch/drive/v3");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toContain(
      "GET /drive/v3/files/one?fields=id%2CmimeType%2Cparents%2CdriveId%2Ctrashed%2Ccapabilities");
  });

  it("refuses metadata-only access when the bound folder must be listable", async () => {
    stubFetch([batchResponse([{
      status: 200,
      body: JSON.stringify({
        id: "folder", capabilities: { canListChildren: false },
      }),
    }])]);

    await expect(api().checkObservations([{kind: "folder", fileId: "folder"}]))
      .resolves.toEqual([false]);
  });

  it("concatenates batch outcomes in request order across the 100-file chunk boundary", async () => {
    let calls = stubFetch([
      batchResponse([
        ...Array.from({ length: 99 }, () => ({ status: 200 })),
        { status: 404 },
      ]),
      batchResponse([{ status: 403 }]),
    ]);
    await expect(api().checkObservations(Array.from({ length: 101 }, (_, index) => `file-${index}`).map(fileId => ({ kind: "file" as const, fileId })))).resolves.toEqual([
      ...Array.from({ length: 99 }, () => true),
      false,
      false,
    ]);
    expect(calls).toHaveLength(2);
    expect(calls.map(call => call.body?.match(/GET \/drive\/v3\/files\//g)?.length))
      .toEqual([100, 1]);
  });

  it("checks no Google endpoint for an empty file set", async () => {
    let calls = stubFetch([]);
    await expect(api().checkObservations([].map(fileId => ({ kind: "file" as const, fileId })))).resolves.toEqual([]);
    expect(calls).toEqual([]);
  });

  it("distinguishes an API-disabled inner response", async () => {
    stubFetch([batchResponse([{ status: 403, body: API_DISABLED_BODY }])]);
    await expect(api().checkObservations(["one"].map(fileId => ({ kind: "file" as const, fileId }))))
      .rejects.toBeInstanceOf(DriveApiDisabledError);
  });

  it.each(["dailyLimitExceeded", "rateLimitExceeded", "userRateLimitExceeded"])(
    "fails loud when a batch subrequest returns quota reason %s",
    async reason => {
      let body = JSON.stringify({ error: { errors: [{ reason }] } });
      stubFetch([batchResponse([{ status: 403, body }])]);
      await expect(api().checkObservations(["one"].map(fileId => ({ kind: "file" as const, fileId }))))
        .rejects.toThrow("Google Drive batch subrequest failed: 403");
    },
  );

  it("does not infer API disablement from unstructured error text", async () => {
    let body = JSON.stringify({ error: { message: "accessNotConfigured" } });
    stubFetch([batchResponse([{ status: 403, body }])]);
    await expect(api().checkObservations(["one"].map(fileId => ({ kind: "file" as const, fileId })))).resolves.toEqual([false]);
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

    await expect(api().checkObservations(["one"].map(fileId => ({ kind: "file" as const, fileId }))))
      .rejects.toThrow("Google Drive batch response was too large");
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(4);
  });

  it("fails a transient inner response instead of reporting an access denial", async () => {
    stubFetch([batchResponse([{ status: 429 }])]);
    await expect(api().checkObservations(["one"].map(fileId => ({ kind: "file" as const, fileId }))))
      .rejects.toThrow("Google Drive batch subrequest failed: 429");
  });

  it("rejects a batch response whose Content-Type carries no boundary", async () => {
    stubFetch([new Response("x", { headers: { "Content-Type": "multipart/mixed" } })]);
    await expect(api().checkObservations(["one"].map(fileId => ({ kind: "file" as const, fileId }))))
      .rejects.toThrow("Invalid Google Drive batch response boundary");
  });

  it("rejects a truncated batch with fewer parts than files", async () => {
    stubFetch([batchResponse([{ status: 200 }])]);
    await expect(api().checkObservations(["one", "two"].map(fileId => ({ kind: "file" as const, fileId }))))
      .rejects.toThrow("Google Drive batch response did not contain one result per file");
  });

  it("surfaces an outer non-ok batch POST", async () => {
    let calls = stubFetch(() => new Response("{}", { status: 500 }));
    await expect(api().checkObservations(["one"].map(fileId => ({ kind: "file" as const, fileId }))))
      .rejects.toThrow("Google Drive API request failed: 500");
    expect(calls).toHaveLength(3);
  });

  it("wraps the batch POST in a multipart envelope matching its Content-Type boundary", async () => {
    let calls = stubFetch([batchResponse([{ status: 200 }])]);
    await api().checkObservations(["one"].map(fileId => ({ kind: "file" as const, fileId })));
    let contentType = calls[0].headers.get("Content-Type") ?? "";
    let boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType)?.slice(1).find(Boolean);
    expect(boundary).toBeTruthy();
    expect(calls[0].body?.startsWith(`--${boundary}`)).toBe(true);
    expect(calls[0].body?.endsWith(`--${boundary}--\r\n`)).toBe(true);
  });

  it("retries a 429 on the batch POST, which is a read-only files.get envelope", async () => {
    let calls = stubFetch([
      new Response("slow down", { status: 429, headers: { "Retry-After": "0" } }),
      batchResponse([{ status: 200 }]),
    ]);
    await expect(api().checkObservations(["one"].map(fileId => ({ kind: "file" as const, fileId })))).resolves.toEqual([true]);
    expect(calls).toHaveLength(2);
  });

  it("refreshes once when a batch subrequest 401s and does not treat it as denial", async () => {
    let token = "stale";
    let requests: unknown[] = [];
    let drive = new DriveApi(async opts => {
      requests.push(opts);
      if (opts?.forceRefresh) token = "fresh";
      return token;
    });
    let calls = stubFetch([
      batchResponse([{ status: 401 }]),
      batchResponse([{ status: 200 }]),
    ]);
    await expect(drive.checkObservations(["one"].map(fileId => ({ kind: "file" as const, fileId })))).resolves.toEqual([true]);
    expect(calls).toHaveLength(2);
    expect(calls.map(call => call.headers.get("Authorization")))
      .toEqual(["Bearer stale", "Bearer fresh"]);
    expect(requests).toEqual([
      undefined,
      { forceRefresh: true, staleToken: "stale" },
      undefined,
    ]);
  });

  it("throws when a batch subrequest still 401s after the forced-refresh replay", async () => {
    let token = "stale";
    let drive = new DriveApi(async opts => {
      if (opts?.forceRefresh) token = "fresh";
      return token;
    });
    let calls = stubFetch([
      batchResponse([{ status: 401 }]),
      batchResponse([{ status: 401 }]),
    ]);
    await expect(drive.checkObservations(["one"].map(fileId => ({ kind: "file" as const, fileId }))))
      .rejects.toThrow("Google Drive batch subrequest failed: 401");
    expect(calls).toHaveLength(2);
  });

  // The batch POST answers 200 around a part refused for a missing scope, so the 403 reload of the
  // token a reconnect stored never runs on its own, and a token memoized before the reconnect would
  // read as every file being denied.
  it("reloads the stored token once when a batch subrequest lacks a scope and does not treat it as denial", async () => {
    let token = "narrow";
    let requests: unknown[] = [];
    let drive = new DriveApi(async opts => {
      requests.push(opts);
      if (opts?.reloadStored) token = "widened";
      return token;
    });
    let calls = stubFetch([
      batchResponse([{ status: 403, body: MISSING_SCOPE_BODY }]),
      batchResponse([{ status: 200 }]),
    ]);
    await expect(drive.checkObservations([{ kind: "file", fileId: "one" }])).resolves.toEqual([true]);
    expect(calls.map(call => call.headers.get("Authorization")))
      .toEqual(["Bearer narrow", "Bearer widened"]);
    expect(requests).toEqual([undefined, { reloadStored: true }, undefined]);
  });

  it("keeps a missing scope a denial, replaying nothing, when the stored token is unchanged", async () => {
    let requests: unknown[] = [];
    let drive = new DriveApi(async opts => {
      requests.push(opts);
      return "tok";
    });
    let calls = stubFetch([batchResponse([{ status: 403, body: MISSING_SCOPE_BODY }])]);
    await expect(drive.checkObservations([{ kind: "file", fileId: "one" }])).resolves.toEqual([false]);
    // One reload asked for, and no mint: the same token would be refused again.
    expect(requests).toEqual([undefined, { reloadStored: true }]);
    expect(calls).toHaveLength(1);
  });

  it("reloads the stored token once only, and for no other denial", async () => {
    let token = "narrow";
    let requests: unknown[] = [];
    let drive = new DriveApi(async opts => {
      requests.push(opts);
      if (opts?.reloadStored) token = "widened";
      return token;
    });
    let calls = stubFetch([
      batchResponse([{ status: 403, body: MISSING_SCOPE_BODY }]),
      batchResponse([{ status: 403, body: MISSING_SCOPE_BODY }]),
      batchResponse([{ status: 403 }, { status: 404 }]),
    ]);
    await expect(drive.checkObservations([{ kind: "file", fileId: "one" }])).resolves.toEqual([false]);
    expect(calls).toHaveLength(2);
    requests.length = 0;
    await expect(drive.checkObservations(
      ["one", "two"].map(fileId => ({ kind: "file" as const, fileId })))).resolves.toEqual([false, false]);
    expect(requests).toEqual([undefined]);
  });

  it("places batch parts by Content-ID rather than positional order", async () => {
    stubFetch([batchResponse([
      { status: 403, contentId: "response-item-1" },
      { status: 200, contentId: "response-item-0" },
      { status: 404, contentId: "response-item-2" },
    ])]);
    await expect(api().checkObservations(["one", "two", "three"].map(fileId => ({ kind: "file" as const, fileId }))))
      .resolves.toEqual([true, false, false]);
  });

  it("rejects a batch part whose Content-ID does not name a requested file", async () => {
    stubFetch([batchResponse([{ status: 200, contentId: "response-item-7" }])]);
    await expect(api().checkObservations(["one"].map(fileId => ({ kind: "file" as const, fileId }))))
      .rejects.toThrow("Google Drive batch response part had an unrecognised Content-ID");
  });
  it("distinguishes listable folder units from ordinary file units", async () => {
    stubFetch([batchResponse([
      {
        status: 200,
        body: JSON.stringify({
          id: "folder", mimeType: FOLDER_MIME_TYPE, trashed: false,
          capabilities: { canListChildren: true },
        }),
      },
      {
        status: 200,
        body: JSON.stringify({ id: "file", mimeType: "application/pdf", trashed: false }),
      },
      {
        status: 200,
        body: JSON.stringify({
          id: "closed", mimeType: FOLDER_MIME_TYPE, trashed: false,
          capabilities: { canListChildren: false },
        }),
      },
    ])]);

    await expect(api().checkObservations([
      {kind: "folder", fileId: "folder"},
      {kind: "file", fileId: "file"},
      {kind: "folder", fileId: "closed"},
    ])).resolves.toEqual([true, true, false]);
  });

  // A viewer of a file whose downloading is restricted still reads its metadata, so only
  // canDownload tells content apart; Drive leaves it out unless asked, which must not pass.
  it("passes a content unit only when the observer may download the file", async () => {
    const calls = stubFetch([batchResponse([true, false, undefined].map(canDownload => ({
      status: 200,
      body: JSON.stringify({ id: "file", mimeType: "application/zip", capabilities: { canDownload } }),
    })))]);

    await expect(api().checkObservations(Array.from({ length: 3 }, () => ({ kind: "content", fileId: "file" }))))
      .resolves.toEqual([true, false, false]);
    expect(decodeURIComponent(calls[0].body ?? "")).toContain("capabilities(canListChildren,canDownload)");
  });

});

/** The one mask a scope proof and an observer check read a file through. */
const SCOPE_MASK = "id,mimeType,parents,driveId,trashed," +
  "capabilities(canListChildren,canComment,canShare,canAddChildren,canMoveItemWithinDrive," +
  "canEdit)";

describe("folder scope nodes", () => {
  const node = (id: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ id, mimeType: FOLDER_MIME_TYPE, parents: ["p"], trashed: false, ...extra });

  it("parses ancestry facts and asks only for the fields a proof decides from", async () => {
    let calls = stubFetch([batchResponse([
      { status: 200, body: node("one", {
        driveId: "drive-1", capabilities: { canListChildren: true },
      }) },
    ])]);

    await expect(api().getScopeNodes(["one"])).resolves.toEqual([{
      id: "one", mimeType: FOLDER_MIME_TYPE, parents: ["p"], trashed: false,
      driveId: "drive-1", canListChildren: true,
    }]);
    expect(calls[0].body).toContain(`fields=${encodeURIComponent(SCOPE_MASK)}`);
    expect(calls[0].body).not.toContain("name");
  });

  it("places nodes by Content-ID rather than positional order", async () => {
    stubFetch([batchResponse([
      { status: 200, body: node("two"), contentId: "response-item-1" },
      { status: 200, body: node("one"), contentId: "response-item-0" },
    ])]);

    await expect(api().getScopeNodes(["one", "two"]))
      .resolves.toEqual([expect.objectContaining({ id: "one" }), expect.objectContaining({ id: "two" })]);
  });

  it("keeps positions across the 100-file chunk boundary", async () => {
    stubFetch([
      batchResponse([
        ...Array.from({ length: 99 }, (_, index) => ({ status: 200, body: node(`file-${index}`) })),
        { status: 404 },
      ]),
      batchResponse([{ status: 200, body: node("file-100") }]),
    ]);

    let nodes = await api().getScopeNodes(
      Array.from({ length: 101 }, (_, index) => `file-${index}`));
    expect(nodes).toHaveLength(101);
    expect(nodes[98]).toEqual(expect.objectContaining({ id: "file-98" }));
    expect(nodes[99]).toBeUndefined();
    expect(nodes[100]).toEqual(expect.objectContaining({ id: "file-100" }));
  });

  it.each([403, 404])("reports only an inaccessible file (%i) as a hole", async status => {
    stubFetch([batchResponse([{ status }])]);
    await expect(api().getScopeNodes(["one"])).resolves.toEqual([undefined]);
  });

  // A quota, outage, or account-wide block answered as "not a descendant" would silently shrink a
  // listing, which is the one failure shape a scope check must never produce.
  it.each([
    ["quota", 403, JSON.stringify({ error: { errors: [{ reason: "userRateLimitExceeded" }] } })],
    // Google's domainPolicy denies the app every file, so no single file's membership follows.
    ["an account-wide policy block", 403,
      JSON.stringify({ error: { errors: [{ reason: "domainPolicy" }] } })],
    ["rate limiting", 429, "{}"],
    ["a server error", 503, "{}"],
  ])("throws on %s rather than reporting a hole", async (_label, status, body) => {
    stubFetch([batchResponse([{ status, body }])]);
    await expect(api().getScopeNodes(["one"])).rejects.toThrow(/batch subrequest failed/);
  });

  it("throws when the API is not enabled for the project", async () => {
    stubFetch([batchResponse([{ status: 403, body: API_DISABLED_BODY }])]);
    await expect(api().getScopeNodes(["one"])).rejects.toBeInstanceOf(DriveApiDisabledError);
  });

  // The echo is what ties a node's facts to the file whose membership they decide.
  it("throws when a part's body answers for another file", async () => {
    stubFetch([batchResponse([{ status: 200, body: node("other") }])]);
    await expect(api().getScopeNodes(["one"]))
      .rejects.toThrow("Google Drive batch response did not echo the requested file ID");
  });

  // The live failure: a body terminated by a blank line before the boundary made the old parser
  // read the empty trailing chunk as the body, so every *successful* subrequest threw. Spelled out
  // byte by byte rather than through `batchResponse`, so a fixture that drifts cannot hide it.
  it("reads a body that a conforming emitter terminates with a blank line", async () => {
    let boundary = "conforming_boundary";
    let text = [
      `--${boundary}`,
      "Content-Type: application/http",
      "Content-ID: <response-item-0>",
      "",
      "HTTP/1.1 200 OK",
      "Content-Type: application/json; charset=UTF-8",
      "",
      node("one"),
      "",
      `--${boundary}--`,
      "",
    ].join("\r\n");
    stubFetch([new Response(text, {
      headers: { "Content-Type": `multipart/mixed; boundary=${boundary}` },
    })]);

    await expect(api().getScopeNodes(["one"]))
      .resolves.toEqual([expect.objectContaining({ id: "one", parents: ["p"] })]);
  });

  it.each([
    ["a non-string parent", JSON.stringify({ id: "one", parents: [7] })],
    ["a non-boolean trashed", JSON.stringify({ id: "one", trashed: "no" })],
  ])("throws on %s", async (_label, body) => {
    stubFetch([batchResponse([{ status: 200, body }])]);
    await expect(api().getScopeNodes(["one"])).rejects.toThrow();
  });

  it.each([["malformed", "not json"], ["empty", ""], ["non-ASCII", "é"]])(
    "reports %s JSON with its UTF-16 size", async (_label, body) => {
      stubFetch([batchResponse([{ status: 200, body }])]);
      await expect(api().getScopeNodes(["one"])).rejects.toThrow(
        `Google Drive batch response part was not valid JSON (${body.length} UTF-16 code units)`);
    });

  it("replays once after an inner 401, then gives up", async () => {
    let tokens = ["stale", "fresh"];
    let drive = new DriveApi(async () => tokens.shift() ?? "fresh");
    let calls = stubFetch([
      batchResponse([{ status: 401 }]),
      batchResponse([{ status: 200, body: node("one") }]),
    ]);

    await expect(drive.getScopeNodes(["one"]))
      .resolves.toEqual([expect.objectContaining({ id: "one" })]);
    expect(calls.map(call => call.headers.get("Authorization")))
      .toEqual(["Bearer stale", "Bearer fresh"]);
  });

  it("issues no request for an empty list", async () => {
    let calls = stubFetch([]);
    await expect(api().getScopeNodes([])).resolves.toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe("error handling", () => {
  it("distinguishes the API-not-enabled 403 by Google's reason, which the admin must fix", async () => {
    stubFetch([new Response(API_DISABLED_BODY, { status: 403 })]);
    await expect(api().listFiles()).rejects.toBeInstanceOf(DriveApiDisabledError);
  });

  it("preserves an ordinary 403 as a status-bearing request error", async () => {
    stubFetch([new Response(JSON.stringify({
      error: { errors: [{ reason: "insufficientPermissions" }] },
    }), { status: 403 })]);
    let error = await api().listFiles().catch(e => e);
    expect(error).toBeInstanceOf(DriveApiRequestError);
    expect(error).toMatchObject({ status: 403, reason: "insufficientPermissions" });
    expect(error.message).toBe("Google Drive API request failed: 403 (insufficientPermissions)");
  });

  // A folder inside a shared drive can be shared directly with a non-member, who then holds a
  // listable folder in a drive corpus they cannot query. The bare reason code says none of that.
  it("explains a shared-drive membership refusal, keeping the reason for callers", async () => {
    stubFetch([new Response(JSON.stringify({
      error: { errors: [{ reason: "teamDriveMembershipRequired" }] },
    }), { status: 403 })]);
    let error = await api().listFiles({ corpus: { kind: "drive", driveId: "drive-1" } })
      .catch(e => e);
    expect(error).toMatchObject({ status: 403, reason: "teamDriveMembershipRequired" });
    expect(error.message).toBe(
      "Google Drive API request failed: 403 (the connected account is not a member of the " +
      "shared drive this item belongs to)");
  });

  it("preserves an ordinary 404 without a provider reason", async () => {
    stubFetch([new Response("{}", { status: 404 })]);
    let error = await api().listFiles().catch(e => e);
    expect(error).toBeInstanceOf(DriveApiRequestError);
    expect(error).toMatchObject({ status: 404, reason: undefined });
    expect(error.message).toBe("Google Drive API request failed: 404");
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
    let drive = new DriveApi(async opts => opts?.forceRefresh ? "fresh" : "tok");
    let calls = stubFetch(() => new Response("expired", { status: 401 }));

    await expect(drive.listFiles()).rejects.toThrow("401");
    expect(calls).toHaveLength(2);
  });

  // A resource whose scopes grew leaves this Durable Object memoizing a token minted under the
  // narrower grant. Only the token a reconnect stored can fix the 403, and minting cannot produce it.
  it("replays a 403 once with the stored token when a reconnect changed it", async () => {
    let drive = new DriveApi(async opts => opts?.reloadStored ? "widened" : "narrow");
    let calls = stubFetch([
      new Response("insufficient scopes", { status: 403 }),
      jsonResponse({ files: [{ id: "1", name: "a" }] }),
    ]);

    expect((await drive.listFiles()).files).toHaveLength(1);
    expect(calls.map(call => call.headers.get("Authorization")))
      .toEqual(["Bearer narrow", "Bearer widened"]);
  });

  it("surfaces a 403 without replaying it when the stored token is unchanged", async () => {
    let requests: unknown[] = [];
    let drive = new DriveApi(async opts => {
      requests.push(opts);
      return "tok";
    });
    let calls = stubFetch(() => new Response("insufficient scopes", { status: 403 }));

    await expect(drive.listFiles()).rejects.toThrow("403");
    // One reload asked for, and no mint: an insufficient grant must not buy a token exchange per
    // call, and the same token would 403 again anyway.
    expect(requests).toEqual([undefined, { reloadStored: true }]);
    expect(calls).toHaveLength(1);
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

const SHEET = "application/vnd.google-apps.spreadsheet";
const DOC = "application/vnd.google-apps.document";
const SLIDES = "application/vnd.google-apps.presentation";

/** Google's refusal prose, which no error or log of ours may repeat. */
const PROVIDER_PROSE = "The user has exceeded their Drive storage quota for Acme Q3.xlsx";

const providerError = (status: number, reason: string) => new Response(JSON.stringify({
  error: { code: status, message: PROVIDER_PROSE, errors: [{ reason, message: PROVIDER_PROSE }] },
}), { status });

const copied = (overrides: Record<string, unknown> = {}) => jsonResponse({
  id: "copy-1", name: "Budget", mimeType: SHEET, parents: ["folder-1"],
  appProperties: { gadgetsConvertedFrom: "src-1" }, ...overrides,
});

describe("conversion source", () => {
  it("asks for its own field mask, leaving the agent-facing mask alone", async () => {
    let calls = stubFetch([jsonResponse({
      id: "src-1", name: "Budget.xlsx", mimeType: "application/vnd.ms-excel", trashed: false,
      parents: ["folder-1"], modifiedTime: "2026-10-01T00:00:00Z", size: "2048",
      capabilities: { canCopy: true }, owners: [{ emailAddress: "someone@example.com" }],
    })]);

    let source = await api().getConversionSource("src-1");

    expect(calls[0].url.pathname).toBe("/drive/v3/files/src-1");
    expect(calls[0].url.searchParams.get("fields")).toBe(
      "id,name,mimeType,modifiedTime,size,parents,driveId,trashed,capabilities(canCopy)");
    expect(calls[0].url.searchParams.get("supportsAllDrives")).toBe("true");
    expect(source).toEqual({
      id: "src-1", name: "Budget.xlsx", mimeType: "application/vnd.ms-excel", trashed: false,
      parents: ["folder-1"], modifiedTime: "2026-10-01T00:00:00Z", size: "2048", canCopy: true,
    });
    expect(DRIVE_FILE_ITEM_FIELDS).not.toContain("canCopy");
  });

  it("rejects a non-boolean canCopy instead of guessing", async () => {
    stubFetch([jsonResponse({ id: "src-1", name: "a", capabilities: { canCopy: "yes" } })]);
    await expect(api().getConversionSource("src-1")).rejects.toThrow("canCopy");
  });
});

describe("copyAsNative", () => {
  it.each([
    ["spreadsheet", SHEET],
    ["document", DOC],
    ["presentation", SLIDES],
  ])("POSTs a %s copy with the name, type, parent and app properties", async (_kind, mimeType) => {
    let calls = stubFetch([copied({ mimeType })]);
    let appProperties = { gadgetsConvertedFrom: "src-1", gadgetsSourceModified: "2026-10-01T00:00:00Z" };

    let copy = await api().copyAsNative("src-1", {
      name: "Budget", mimeType, parents: ["folder-1"], appProperties,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url.origin + calls[0].url.pathname)
      .toBe("https://www.googleapis.com/drive/v3/files/src-1/copy");
    expect(calls[0].url.searchParams.get("supportsAllDrives")).toBe("true");
    expect(calls[0].url.searchParams.get("fields")).toContain("appProperties");
    expect(JSON.parse(calls[0].body!)).toEqual({
      name: "Budget", mimeType, parents: ["folder-1"], appProperties,
    });
    expect(copy).toMatchObject({ id: "copy-1", name: "Budget", mimeType });
  });

  it("never replays a copy whose response was a 5xx, which may still have made one", async () => {
    let calls = stubFetch(() => new Response("{}", { status: 503 }));
    await expect(api().copyAsNative("src-1", { name: "a", mimeType: SHEET, parents: ["root"], appProperties: {} }))
      .rejects.toMatchObject({ status: 503 });
    expect(calls).toHaveLength(1);
  });

  it("never replays a copy lost to a network error", async () => {
    let attempts = 0;
    vi.stubGlobal("fetch", async () => {
      attempts++;
      throw new TypeError("network connection lost");
    });
    await expect(api().copyAsNative("src-1", { name: "a", mimeType: SHEET, parents: ["root"], appProperties: {} }))
      .rejects.toThrow("network connection lost");
    expect(attempts).toBe(1);
  });

  it("refuses a copy Drive made of another type than asked", async () => {
    stubFetch([copied({ mimeType: "application/vnd.ms-excel" })]);
    await expect(api().copyAsNative("src-1", { name: "a", mimeType: SHEET, parents: ["root"], appProperties: {} }))
      .rejects.toThrow("different type");
  });
});

const source = (overrides: Partial<DriveConversionSource> = {}): DriveConversionSource => ({
  id: "src-1", name: "Budget.xlsx", parents: ["folder-1"], modifiedTime: "2026-10-01T00:00:00Z",
  ...overrides,
});

describe("makeNativeCopy", () => {

  it("copies beside the original when its folder takes new files", async () => {
    let calls = stubFetch([jsonResponse({ capabilities: { canAddChildren: true } }), copied()]);

    let made = await api().makeNativeCopy(source(), "Budget", SHEET);

    expect(made.location).toBe("besideOriginal");
    expect(calls[0].url.pathname).toBe("/drive/v3/files/folder-1");
    expect(calls[0].url.searchParams.get("fields")).toBe("capabilities(canAddChildren)");
    expect(calls[0].url.searchParams.get("supportsAllDrives")).toBe("true");
    expect(JSON.parse(calls[1].body!)).toEqual({
      name: "Budget", mimeType: SHEET, parents: ["folder-1"],
      appProperties: { gadgetsConvertedFrom: "src-1", gadgetsSourceModified: "2026-10-01T00:00:00Z" },
    });
  });

  it.each([
    ["cannot take new files", () => jsonResponse({ capabilities: { canAddChildren: false } })],
    ["cannot be read", () => providerError(404, "notFound")],
    ["reports no capability", () => jsonResponse({})],
  ])("copies into My Drive's root when the original's folder %s", async (_case, folder) => {
    let calls = stubFetch([folder(), copied({ parents: ["0AJroot"] })]);

    let made = await api().makeNativeCopy(source(), "Budget", SHEET);

    expect(made.location).toBe("myDrive");
    expect(calls).toHaveLength(2);
    // Named outright: a copy sent without parents would inherit the original's folder.
    expect(JSON.parse(calls[1].body!).parents).toEqual(["root"]);
  });

  it("copies into My Drive's root, asking about no folder, when the source has no parent", async () => {
    let calls = stubFetch([copied({ parents: ["0AJroot"] })]);

    let made = await api().makeNativeCopy(source({ parents: undefined }), "Budget", SHEET);

    expect(made.location).toBe("myDrive");
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].body!).parents).toEqual(["root"]);
  });

  it("refuses a source larger than Drive converts into the type, before copying", async () => {
    let calls = stubFetch([jsonResponse({ maxImportSizes: { [DOC]: "10485760", [SHEET]: "104857600" } })]);

    await expect(api().makeNativeCopy(source({ size: "10485761" }), "Report", DOC))
      .rejects.toThrow("This file is 11 MB, larger than the 10 MB Google Drive converts into this format.");
    expect(calls).toHaveLength(1);
    expect(calls[0].url.pathname).toBe("/drive/v3/about");
    expect(calls[0].url.searchParams.get("fields")).toBe("maxImportSizes");
  });

  it("copies a source within the limit", async () => {
    let calls = stubFetch([
      jsonResponse({ maxImportSizes: { [DOC]: "10485760" } }),
      jsonResponse({ capabilities: { canAddChildren: true } }),
      copied({ mimeType: DOC }),
    ]);
    await expect(api().makeNativeCopy(source({ size: "10485760" }), "Report", DOC))
      .resolves.toMatchObject({ location: "besideOriginal" });
    expect(calls.map(call => call.method ?? "GET")).toEqual(["GET", "GET", "POST"]);
  });

  it.each([
    ["is refused", () => providerError(403, "forbidden")],
    ["answers with something unreadable", () => new Response("not json", { status: 200 })],
  ])("copies without the size check, and says so, when Drive's limit read %s", async (_case, about) => {
    let warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let calls = stubFetch([about(), jsonResponse({ capabilities: { canAddChildren: true } }), copied()]);

    await expect(api().makeNativeCopy(source({ size: "999999999" }), "Budget", SHEET))
      .resolves.toMatchObject({ location: "besideOriginal" });

    expect(calls.map(call => call.method ?? "GET")).toEqual(["GET", "GET", "POST"]);
    let logged = warn.mock.calls.map(args => JSON.stringify(args)).join("\n");
    expect(logged).toContain("google.office.import-size.unavailable");
    expect(logged).not.toContain("Acme");
  });

  it("skips the size check when the source has no size or Drive names no limit", async () => {
    let unsized = stubFetch([jsonResponse({ capabilities: { canAddChildren: true } }), copied()]);
    await api().makeNativeCopy(source(), "Budget", SHEET);
    expect(unsized.some(call => call.url.pathname.endsWith("/about"))).toBe(false);

    let unlisted = stubFetch([
      jsonResponse({ maxImportSizes: { [DOC]: "10" } }),
      jsonResponse({ capabilities: { canAddChildren: true } }),
      copied(),
    ]);
    await expect(api().makeNativeCopy(source({ size: "999999999" }), "Budget", SHEET))
      .resolves.toMatchObject({ location: "besideOriginal" });
    expect(unlisted).toHaveLength(3);
  });

  it("leaves out the source-modified property when Drive gave no modification time", async () => {
    let calls = stubFetch([copied()]);
    await api().makeNativeCopy(source({ parents: undefined, modifiedTime: undefined }), "Budget", SHEET);
    expect(JSON.parse(calls[0].body!).appProperties).toEqual({ gadgetsConvertedFrom: "src-1" });
  });
});

describe("converted copies lookup", () => {
  it("escapes the source ID in the internal app-property clause", () => {
    expect(buildDriveQuery({ mimeType: SHEET }, { convertedFrom: "a'b\\c" })).toBe(
      `trashed = false and mimeType = '${SHEET}' and ` +
      "appProperties has { key='gadgetsConvertedFrom' and value='a\\'b\\\\c' }");
  });

  it("adds no app-property clause to an ordinary query", () => {
    expect(buildDriveQuery({ namePrefix: "gadgetsConvertedFrom" })).not.toContain("appProperties");
  });

  it("searches every drive and keeps only live, editable copies of the source in the native type", async () => {
    let editable = { capabilities: { canEdit: true } };
    let calls = stubFetch([jsonResponse({
      files: [
        { id: "a", name: "Budget", mimeType: SHEET, trashed: false, createdTime: "2026-10-02T00:00:00Z",
          appProperties: { gadgetsConvertedFrom: "src-1" }, ...editable },
        { id: "b", name: "Other", mimeType: SHEET, trashed: false,
          appProperties: { gadgetsConvertedFrom: "src-2" }, ...editable },
        { id: "c", name: "Budget", mimeType: DOC, trashed: false,
          appProperties: { gadgetsConvertedFrom: "src-1" }, ...editable },
        { id: "d", name: "Budget", mimeType: SHEET, trashed: true,
          appProperties: { gadgetsConvertedFrom: "src-1" }, ...editable },
        // Another user of the deployment's copy in a folder shared with this account.
        { id: "e", name: "Budget", mimeType: SHEET, trashed: false,
          appProperties: { gadgetsConvertedFrom: "src-1" }, capabilities: { canEdit: false } },
        { id: "f", name: "Budget", mimeType: SHEET, trashed: false,
          appProperties: { gadgetsConvertedFrom: "src-1" } },
      ],
    })]);

    let copies = await api().findConvertedCopies("src-1", SHEET);

    expect(copies.map(copy => copy.id)).toEqual(["a"]);
    expect(copies[0].canEdit).toBe(true);
    expect(copies[0].createdTime).toBe("2026-10-02T00:00:00Z");
    let params = calls[0].url.searchParams;
    expect(params.get("q")).toBe(buildDriveQuery({ mimeType: SHEET }, { convertedFrom: "src-1" }));
    expect(params.get("corpora")).toBe("allDrives");
    expect(params.get("includeItemsFromAllDrives")).toBe("true");
    expect(params.get("supportsAllDrives")).toBe("true");
    expect(params.get("fields")).toContain("appProperties");
    expect(params.get("fields")).toContain("capabilities(canEdit)");
  });

  it("rejects app properties that are not strings", async () => {
    stubFetch([jsonResponse({ files: [{ id: "a", name: "a", appProperties: { n: 1 } }] })]);
    await expect(api().findConvertedCopies("src-1", SHEET)).rejects.toThrow("appProperties");
  });
});

/** The error a copy Google refuses with `status` and `reason` fails with. */
async function failedCopy(status: number, reason: string): Promise<unknown> {
  stubFetch([providerError(status, reason)]);
  return api().copyAsNative("src-1", { name: "a", mimeType: SHEET, parents: ["root"], appProperties: {} })
    .catch(error => error);
}

describe("conversion errors", () => {

  it.each([
    [404, "notFound", "Google Drive could not find this file, or the connected account cannot open it."],
    [403, "cannotCopyFile", "The owner of this file has turned off copying, so Google Drive cannot copy it."],
    [403, "storageQuotaExceeded", "The connected Google account has no Drive storage left for the copy."],
    [403, "userRateLimitExceeded", "Google Drive is limiting requests from this account. Try again in a minute."],
    [429, "rateLimitExceeded", "Google Drive is limiting requests from this account. Try again in a minute."],
    [403, "insufficientPermissions", "The connected Google account has not granted access to copy Drive files."],
    [400, "badRequest", "Google Drive could not make the copy [http=400]."],
  ])("explains a %i %s in its own words", async (status, reason, message) => {
    let explained = conversionError(await failedCopy(status, reason)) as Error;
    expect(explained.message).toBe(message);
    expect(explained.message).not.toContain("Acme");
  });

  it("recognizes only a 403 insufficientPermissions as a missing scope", async () => {
    expect(isInsufficientScope(await failedCopy(403, "insufficientPermissions"))).toBe(true);
    expect(isInsufficientScope(await failedCopy(403, "cannotCopyFile"))).toBe(false);
    expect(isInsufficientScope(new Error("insufficientPermissions"))).toBe(false);
  });

  it("returns an error that is not a Drive HTTP failure unchanged", () => {
    let error = new Error("This file is 11 MB");
    expect(conversionError(error)).toBe(error);
  });
});

/**
 * A body that counts what is read from it and records its cancellation. With no high-water mark
 * nothing is pulled until a reader asks.
 */
function countedBody(chunkBytes: number) {
  let state = { pulls: 0, cancelled: false };
  let body = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.pulls += 1;
      controller.enqueue(new Uint8Array(chunkBytes));
    },
    cancel() {
      state.cancelled = true;
    },
  }, { highWaterMark: 0 });
  return { body, state };
}

/** What `alt=media` answers a token holding only `drive.metadata.readonly`, verbatim but the IDs. */
const NOT_AUTHORIZED_TO_FILE_BODY = {
  error: {
    code: 403,
    message: "The user has not granted the app 123456789 read access to the file pdf-1.",
    errors: [{
      message: "The user has not granted the app 123456789 read access to the file pdf-1.",
      domain: "global",
      reason: "appNotAuthorizedToFile",
      location: "Authorization",
      locationType: "header",
    }],
  },
};

/** Reads a stream to the end, as the conversion request does. */
async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe("openDownload", () => {
  it("streams the file from alt=media across all drives, reading nothing until pulled", async () => {
    let bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    let calls = stubFetch([new Response(bytes, {
      headers: { "Content-Type": "application/pdf", "Content-Length": "4" },
    })]);

    let stream = await api().openDownload("file-1_A");
    expect(await drain(stream)).toEqual(bytes);

    expect(calls).toHaveLength(1);
    expect(calls[0].url.origin + calls[0].url.pathname)
      .toBe("https://www.googleapis.com/drive/v3/files/file-1_A");
    expect(Object.fromEntries(calls[0].url.searchParams))
      .toEqual({ alt: "media", supportsAllDrives: "true" });
    expect(calls[0].headers.get("Authorization")).toBe("Bearer tok");
  });

  it("reads at most a chunk ahead of the caller, and stops when the caller cancels", async () => {
    let { body, state } = countedBody(1024);
    // The size Drive declares for a 270 MB PDF: no size is refused, and nothing is read for it.
    stubFetch([new Response(body, { headers: { "Content-Length": String(270 * 1024 * 1024) } })]);

    let stream = await api().openDownload("file-1");
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(state.pulls).toBeLessThanOrEqual(1);

    let reader = stream.getReader();
    for (let i = 0; i < 3; i++) await reader.read();
    expect(state.pulls).toBeLessThanOrEqual(4);
    await reader.cancel();
    expect(state.cancelled).toBe(true);
  });

  it("hands back an empty stream for a response without a body", async () => {
    stubFetch([new Response(null, { status: 200 })]);
    expect(await drain(await api().openDownload("file-1"))).toEqual(new Uint8Array());
  });

  it("refuses an ID that is not a Drive file ID without a request", async () => {
    let calls = stubFetch([]);
    for (let id of ["", "../about", "file 1", "a/b", "x".repeat(257)]) {
      await expect(api().openDownload(id)).rejects.toThrow("Not a Google Drive file ID.");
    }
    expect(calls).toEqual([]);
  });

  it("reports a download Drive refuses for want of content access", async () => {
    stubFetch([jsonResponse(NOT_AUTHORIZED_TO_FILE_BODY, 403)]);

    let error = await api().openDownload("pdf-1").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DriveApiRequestError);
    expect(error).toMatchObject({ status: 403, reason: "appNotAuthorizedToFile" });
    expect((error as Error).message).not.toContain("123456789");
    expect(lacksFileContentAccess(error)).toBe(true);
    // The Office flow's missing-scope check keeps its narrower meaning.
    expect(isInsufficientScope(error)).toBe(false);
  });

  it("maps a missing file through the usual Drive failure", async () => {
    stubFetch([jsonResponse({
      error: { code: 404, message: "File not found: pdf-1.", errors: [{ reason: "notFound" }] },
    }, 404)]);

    let error = await api().openDownload("pdf-1").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DriveApiRequestError);
    expect(error).toMatchObject({ status: 404, reason: "notFound" });
    expect(lacksFileContentAccess(error)).toBe(false);
  });
});

describe("downloadRange", () => {
  const BYTES = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const bytesOf = async (content: ReadableStream<Uint8Array>) =>
    new Uint8Array(await new Response(content).arrayBuffer());

  /** A 206 for `bytes=start-end` of {@link BYTES}, as Drive answers a range it honours. */
  function partial(start: number, end: number, total = BYTES.byteLength): Response {
    return new Response(BYTES.slice(start, end + 1), {
      status: 206,
      headers: { "Content-Range": `bytes ${start}-${end}/${total}` },
    });
  }

  it("asks alt=media across all drives for exactly the requested bytes", async () => {
    let calls = stubFetch([partial(3, 6)]);

    let { content, length, fileSize } = await api().downloadRange("file-1_A", 3, 4);

    expect(await bytesOf(content)).toEqual(new Uint8Array([3, 4, 5, 6]));
    expect(length).toBe(4);
    expect(fileSize).toBe(10);
    expect(calls[0].url.origin + calls[0].url.pathname)
      .toBe("https://www.googleapis.com/drive/v3/files/file-1_A");
    expect(Object.fromEntries(calls[0].url.searchParams))
      .toEqual({ alt: "media", supportsAllDrives: "true" });
    expect(calls[0].headers.get("Range")).toBe("bytes=3-6");
    expect(calls[0].headers.get("Authorization")).toBe("Bearer tok");
  });

  it("reports no file size when Drive does not give one", async () => {
    stubFetch([new Response(BYTES.slice(0, 2), {
      status: 206, headers: { "Content-Range": "bytes 0-1/*" },
    })]);
    expect((await api().downloadRange("file-1", 0, 2)).fileSize).toBeUndefined();
  });

  // The caller can then refuse the answer on its headers, before reading any of it.
  it("reports how many bytes a range that ends early says it carries", async () => {
    stubFetch([partial(3, 5)]);

    expect(await api().downloadRange("file-1", 3, 4)).toEqual(
      expect.objectContaining({ length: 3, fileSize: 10 }));
  });

  it("opens a whole-file answer to a range from the start, reading none of it", async () => {
    let { body, state } = countedBody(4);
    stubFetch([new Response(body)]);

    let { content, length, fileSize } = await api().downloadRange("file-1", 0, 6);
    expect(length).toBeUndefined();

    expect(fileSize).toBeUndefined();
    expect(state.pulls).toBe(0);
    await content.cancel();
    expect(state.cancelled).toBe(true);
  });

  it("takes a whole-file answer's file size from its length, unless it was encoded", async () => {
    stubFetch([
      new Response(BYTES, { headers: { "Content-Length": "10" } }),
      new Response(BYTES, { headers: { "Content-Length": "4", "Content-Encoding": "gzip" } }),
    ]);

    expect((await api().downloadRange("file-1", 0, 4)).fileSize).toBe(10);
    expect((await api().downloadRange("file-1", 0, 4)).fileSize).toBeUndefined();
  });

  // The body of a file of any size is read at the caller's pace, so only Drive's wait to begin
  // answering can be timed: a timer still running would cut a long download short.
  it("times the wait for Drive to begin its answer, and nothing after it", async () => {
    vi.useFakeTimers();
    let signals: AbortSignal[] = [];
    let answers = [() => new Promise<Response>(() => {}), async () => partial(0, 9)];
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
      let signal = init.signal!;
      signals.push(signal);
      return Promise.race([
        answers.shift()!(),
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
      ]);
    });

    let silent = api().downloadRange("file-1", 0, 10).catch((caught: unknown) => caught);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await silent).toMatchObject({ name: "TimeoutError" });

    let { content } = await api().downloadRange("file-1", 0, 10);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(signals[1].aborted).toBe(false);
    expect(await bytesOf(content)).toEqual(BYTES);
  });

  it.each([
    ["a whole-file answer to a range starting later", () => new Response(BYTES)],
    ["a partial answer starting elsewhere", () => partial(0, 3)],
    ["a partial answer that does not say where it starts", () => new Response(BYTES, { status: 206 })],
  ])("refuses %s, which would misplace every byte", async (_name, answer) => {
    stubFetch([answer()]);
    await expect(api().downloadRange("file-1", 5, 3))
      .rejects.toThrow("Google Drive did not return the requested byte range.");
  });

  it("refuses an ID that is not a Drive file ID without a request", async () => {
    let calls = stubFetch([]);
    await expect(api().downloadRange("../about", 0, 1)).rejects.toThrow("Not a Google Drive file ID.");
    expect(calls).toEqual([]);
  });

  it("explains Drive's download refusals, which leave the caller nothing to act on", async () => {
    stubFetch([
      jsonResponse({ error: { code: 403, errors: [{ reason: "cannotDownloadFile" }] } }, 403),
      jsonResponse({ error: { code: 403, errors: [{ reason: "cannotDownloadAbusiveFile" }] } }, 403),
    ]);

    let restricted = await api().downloadRange("file-1", 0, 1).catch((caught: unknown) => caught);
    let abusive = await api().downloadRange("file-1", 0, 1).catch((caught: unknown) => caught);

    expect(restricted).toMatchObject({ status: 403, reason: "cannotDownloadFile" });
    expect((restricted as Error).message).toBe("Google Drive API request failed: 403 (the " +
      "connected account is not allowed to download this file; its owner or administrator has " +
      "restricted downloading it)");
    expect((abusive as Error).message).toBe("Google Drive API request failed: 403 (Google " +
      "identified this file as malware or spam, so only its owner can download it)");
  });
});

describe("lacksFileContentAccess", () => {
  it("recognizes a 403 appNotAuthorizedToFile or insufficientPermissions only", () => {
    expect(lacksFileContentAccess(new DriveApiRequestError(403, "appNotAuthorizedToFile"))).toBe(true);
    expect(lacksFileContentAccess(new DriveApiRequestError(403, "insufficientPermissions"))).toBe(true);
    expect(lacksFileContentAccess(new DriveApiRequestError(403, "cannotDownloadFile"))).toBe(false);
    expect(lacksFileContentAccess(new DriveApiRequestError(403))).toBe(false);
    expect(lacksFileContentAccess(new DriveApiRequestError(401, "appNotAuthorizedToFile"))).toBe(false);
    expect(lacksFileContentAccess(new Error("appNotAuthorizedToFile"))).toBe(false);
  });
});

/** Google's error envelope, shaped as Drive answers comment requests. */
const googleError = (status: number, reason: string, message: string, location?: string) =>
  jsonResponse({
    error: {
      code: status, message,
      errors: [{ message, domain: "global", reason, ...(location ? { location, locationType: "parameter" } : {}) }],
    },
  }, status);

const REPLY_MASK = "id,content,author(displayName,me),createdTime,modifiedTime,deleted,action";
const COMMENT_MASK =
  `id,content,quotedFileContent,author(displayName,me),createdTime,modifiedTime,resolved,deleted,replies(${REPLY_MASK})`;

/** A comment as Drive returns it, `htmlContent` included; `resolved` is absent until resolved once. */
const apiComment = (overrides: Record<string, unknown> = {}) => ({
  id: "doco.AbCdEfGhIjKlMnOpQrStUv",
  content: "Is this final?",
  htmlContent: "Is this final?",
  author: { displayName: "Ada", me: true },
  createdTime: "2026-10-20T10:00:00.000Z",
  modifiedTime: "2026-10-20T10:00:00.000Z",
  deleted: false,
  replies: [],
  ...overrides,
});

const apiReply = (overrides: Record<string, unknown> = {}) => ({
  id: "doco.ZyXwVuTsRqPoNmLkJiHgFe",
  content: "Yes.",
  htmlContent: "Yes.",
  author: { displayName: "Ada", me: true },
  createdTime: "2026-10-20T10:05:00.000Z",
  modifiedTime: "2026-10-20T10:05:00.000Z",
  deleted: false,
  ...overrides,
});

describe("comment IDs", () => {
  it("accepts Docs, Sheets and Slides comment IDs and refuses anything that could reshape a path", () => {
    expect(isDriveCommentId("doco.AbCdEfGhIjKlMnOpQrStUv")).toBe(true);
    expect(isDriveCommentId("AAACJHl12Cw")).toBe(true);
    for (let id of ["", "a/b", "a?b", "a#b", "pending:1", "x".repeat(257), "a b", "..", "."]) {
      expect(isDriveCommentId(id)).toBe(false);
    }
  });
});

describe("canComment", () => {
  it("asks for the comment capability alone, across shared drives", async () => {
    let calls = stubFetch([jsonResponse({ capabilities: { canComment: true } })]);
    await expect(api().canComment("doc-1")).resolves.toBe(true);
    expect(calls[0].url.pathname).toBe("/drive/v3/files/doc-1");
    expect(calls[0].url.searchParams.get("fields")).toBe("capabilities(canComment)");
    expect(calls[0].url.searchParams.get("supportsAllDrives")).toBe("true");
  });

  it("reads a missing or false capability as no", async () => {
    stubFetch([jsonResponse({ capabilities: { canComment: false } }), jsonResponse({})]);
    await expect(api().canComment("doc-1")).resolves.toBe(false);
    await expect(api().canComment("doc-1")).resolves.toBe(false);
  });

  it("rejects a non-boolean capability", async () => {
    stubFetch([jsonResponse({ capabilities: { canComment: "yes" } })]);
    await expect(api().canComment("doc-1")).rejects.toThrow("canComment");
  });

  it("makes no request for an ID that is not a Drive file ID", async () => {
    let calls = stubFetch([]);
    await expect(api().canComment("../x")).rejects.toThrow("Not a Google Drive file ID.");
    expect(calls).toHaveLength(0);
  });
});

describe("listComments", () => {
  it("lists a page of comments with the comment mask, parsing Drive's shape", async () => {
    let calls = stubFetch([jsonResponse({
      comments: [
        apiComment({ replies: [apiReply({ action: "resolve", content: "", htmlContent: "" })], resolved: true }),
        apiComment({ id: "AAACJHl12Cw", author: { displayName: "Bob", me: false } }),
      ],
      nextPageToken: "next",
    })]);

    let page = await api().listComments("doc-1");

    expect(calls[0].method).toBeUndefined();
    expect(calls[0].url.origin + calls[0].url.pathname)
      .toBe("https://www.googleapis.com/drive/v3/files/doc-1/comments");
    expect(Object.fromEntries(calls[0].url.searchParams)).toEqual({
      pageSize: "100", fields: `nextPageToken,comments(${COMMENT_MASK})`,
    });
    expect(page).toEqual({
      comments: [
        {
          id: "doco.AbCdEfGhIjKlMnOpQrStUv", content: "Is this final?",
          author: { displayName: "Ada", me: true },
          createdTime: "2026-10-20T10:00:00.000Z", modifiedTime: "2026-10-20T10:00:00.000Z",
          resolved: true, deleted: false,
          replies: [{
            id: "doco.ZyXwVuTsRqPoNmLkJiHgFe", content: "", author: { displayName: "Ada", me: true },
            createdTime: "2026-10-20T10:05:00.000Z", modifiedTime: "2026-10-20T10:05:00.000Z",
            deleted: false, action: "resolve",
          }],
        },
        {
          id: "AAACJHl12Cw", content: "Is this final?", author: { displayName: "Bob", me: false },
          createdTime: "2026-10-20T10:00:00.000Z", modifiedTime: "2026-10-20T10:00:00.000Z",
          resolved: false, deleted: false, replies: [],
        },
      ],
      nextPageToken: "next",
    });
  });

  it("reads the passage a comment is attached to as text, and none from any other shape", async () => {
    stubFetch([jsonResponse({
      comments: [
        // A selection as Drive returns it: named references for `& " < >`, numeric for the rest.
        apiComment({
          quotedFileContent: {
            mimeType: "text/html",
            value: "Tom &amp; Jerry said &quot;&lt;hello&gt;&quot; to Andr&#233;&#39;s caf&#233;.",
          },
        }),
        apiComment({
          quotedFileContent: { mimeType: "text/html", value: "&amp;lt; &#x1F600; &nbsp; &#0; &#55357;" },
        }),
        apiComment({ quotedFileContent: { mimeType: "text/plain", value: "R&amp;D" } }),
        apiComment({ quotedFileContent: { mimeType: "text/html", value: "" } }),
        apiComment({ quotedFileContent: "May" }),
        apiComment({ quotedFileContent: { value: 7 } }),
        apiComment(),
      ],
    })]);

    let { comments } = await api().listComments("doc-1");

    expect(comments).toHaveLength(7);
    expect(comments[0].quotedText).toBe("Tom & Jerry said \"<hello>\" to André's café.");
    // One pass, the hexadecimal form read, and a name outside the four, a zero and a surrogate
    // left as written.
    expect(comments[1].quotedText).toBe("&lt; \u{1F600} &nbsp; &#0; &#55357;");
    expect(comments[2].quotedText).toBe("R&amp;D");
    for (let comment of comments.slice(3)) expect(comment).not.toHaveProperty("quotedText");
  });

  // A number past U+10FFFF names no character, and turning one into a string throws.
  it("leaves a reference past the last code point as written, rather than failing the page", async () => {
    let value = "&#1114112; &#9999999; &#x110000; &#xFFFFFF;";
    stubFetch([jsonResponse({
      comments: [apiComment({ quotedFileContent: { mimeType: "text/html", value } })],
    })]);

    let { comments } = await api().listComments("doc-1");

    expect(comments[0].quotedText).toBe(value);
  });

  it("forwards the page token and the inclusive start time", async () => {
    let calls = stubFetch([jsonResponse({ comments: [] })]);
    await expect(api().listComments("doc-1", {
      pageToken: "p2", startModifiedTime: "2026-10-20T09:59:58.000Z",
    })).resolves.toEqual({ comments: [] });
    expect(calls[0].url.searchParams.get("pageToken")).toBe("p2");
    expect(calls[0].url.searchParams.get("startModifiedTime")).toBe("2026-10-20T09:59:58.000Z");
  });

  it("treats a response with no comments as an empty page", async () => {
    stubFetch([jsonResponse({})]);
    await expect(api().listComments("doc-1")).resolves.toEqual({ comments: [] });
  });

  it("keeps a deleted comment's missing content as empty text", async () => {
    stubFetch([jsonResponse({ comments: [apiComment({ content: undefined, deleted: true })] })]);
    let { comments } = await api().listComments("doc-1");
    expect(comments[0]).toMatchObject({ content: "", deleted: true });
  });

  it.each([
    ["a comments field that is not an array", { comments: {} }],
    ["a comment without an ID", { comments: [apiComment({ id: undefined })] }],
    ["a comment without a creation time", { comments: [apiComment({ createdTime: undefined })] }],
    ["non-string content", { comments: [apiComment({ content: 7 })] }],
    ["a non-boolean resolved", { comments: [apiComment({ resolved: "true" })] }],
    ["an author that is not an object", { comments: [apiComment({ author: "Ada" })] }],
    ["a non-boolean author.me", { comments: [apiComment({ author: { displayName: "Ada", me: 1 } })] }],
    ["replies that are not an array", { comments: [apiComment({ replies: {} })] }],
    ["a reply with an unknown action", { comments: [apiComment({ replies: [apiReply({ action: "delete" })] })] }],
    ["a non-string page token", { comments: [], nextPageToken: 3 }],
  ])("rejects %s", async (_case, body) => {
    stubFetch([jsonResponse(body)]);
    await expect(api().listComments("doc-1")).rejects.toThrow(/^Invalid Google Drive/);
  });

  it("surfaces an unknown file as Drive's 404", async () => {
    stubFetch([googleError(404, "notFound", "File not found: nope.", "fileId")]);
    let error = await api().listComments("nope").catch(caught => caught);
    expect(error).toMatchObject({ status: 404, reason: "notFound" });
    expect(isFileInvisible(error)).toBe(true);
  });

  it("makes no request for an ID that is not a Drive file ID", async () => {
    let calls = stubFetch([]);
    await expect(api().listComments("a/b")).rejects.toThrow("Not a Google Drive file ID.");
    expect(calls).toHaveLength(0);
  });
});

describe("getComment", () => {
  it("reads one comment with the comment mask", async () => {
    let calls = stubFetch([jsonResponse(apiComment({ resolved: true }))]);
    await expect(api().getComment("doc-1", "doco.AbCdEfGhIjKlMnOpQrStUv"))
      .resolves.toMatchObject({ id: "doco.AbCdEfGhIjKlMnOpQrStUv", resolved: true, replies: [] });
    expect(calls[0].url.pathname).toBe("/drive/v3/files/doc-1/comments/doco.AbCdEfGhIjKlMnOpQrStUv");
    expect(Object.fromEntries(calls[0].url.searchParams)).toEqual({ fields: COMMENT_MASK });
  });

  it("refuses a body answering for another comment", async () => {
    stubFetch([jsonResponse(apiComment({ id: "other" }))]);
    await expect(api().getComment("doc-1", "doco.AbCdEfGhIjKlMnOpQrStUv"))
      .rejects.toThrow("Google Drive returned a different comment");
  });

  it("surfaces an unknown comment as Drive's 404", async () => {
    stubFetch([googleError(404, "notFound", "Comment not found: missing.", "commentId")]);
    await expect(api().getComment("doc-1", "missing")).rejects.toMatchObject({ status: 404, reason: "notFound" });
  });

  it("makes no request for a comment ID that could reshape the path", async () => {
    let calls = stubFetch([]);
    await expect(api().getComment("doc-1", "x/replies")).rejects.toThrow("Not a Google Drive comment ID.");
    await expect(api().getComment("doc-1", "pending:abc")).rejects.toThrow("Not a Google Drive comment ID.");
    await expect(api().getComment("a?b", "c1")).rejects.toThrow("Not a Google Drive file ID.");
    expect(calls).toHaveLength(0);
  });
});

describe("listReplies", () => {
  it("lists a page of replies with the reply mask", async () => {
    let calls = stubFetch([jsonResponse({
      replies: [apiReply(), apiReply({ id: "r2", action: "reopen", content: "Not yet." })],
      nextPageToken: "more",
    })]);

    let page = await api().listReplies("doc-1", "c1", { pageToken: "p2" });

    expect(calls[0].url.pathname).toBe("/drive/v3/files/doc-1/comments/c1/replies");
    expect(Object.fromEntries(calls[0].url.searchParams)).toEqual({
      pageSize: "100", fields: `nextPageToken,replies(${REPLY_MASK})`, pageToken: "p2",
    });
    expect(page.nextPageToken).toBe("more");
    expect(page.replies.map(reply => [reply.id, reply.action, reply.content]))
      .toEqual([["doco.ZyXwVuTsRqPoNmLkJiHgFe", undefined, "Yes."], ["r2", "reopen", "Not yet."]]);
    expect(page.replies[0]).not.toHaveProperty("action");
  });

  it("rejects a malformed reply", async () => {
    stubFetch([jsonResponse({ replies: [apiReply({ deleted: "no" })] })]);
    await expect(api().listReplies("doc-1", "c1")).rejects.toThrow("Invalid Google Drive reply deleted");
  });

  it("makes no request for an invalid comment ID", async () => {
    let calls = stubFetch([]);
    await expect(api().listReplies("doc-1", "")).rejects.toThrow("Not a Google Drive comment ID.");
    expect(calls).toHaveLength(0);
  });
});

describe("createComment", () => {
  it("POSTs the content alone, never an anchor or quoted file content, with the comment mask", async () => {
    let content = "\"the budget\"\n\nIs this final?\n\nhttps://docs.google.com/document/d/doc-1/edit?tab=t.0#heading=h.x";
    let calls = stubFetch([jsonResponse(apiComment({ content }))]);

    let made = await api().createComment("doc-1", content);

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url.origin + calls[0].url.pathname)
      .toBe("https://www.googleapis.com/drive/v3/files/doc-1/comments");
    expect(Object.fromEntries(calls[0].url.searchParams)).toEqual({ fields: COMMENT_MASK });
    expect(calls[0].headers.get("Content-Type")).toBe("application/json");
    expect(calls[0].headers.get("Authorization")).toBe("Bearer tok");
    expect(JSON.parse(calls[0].body!)).toEqual({ content });
    expect(calls[0].body).not.toMatch(/anchor|quotedFileContent/);
    expect(made).toMatchObject({ id: "doco.AbCdEfGhIjKlMnOpQrStUv", content, resolved: false });
  });

  it("sends the content byte for byte", async () => {
    let content = "line1\r\nline2 with trailing spaces   \n\ttabbed\nnfd e\u0301 nfc \u00e9 " +
      "emoji \u{1F600} zwj \u200d nbsp\u00a0end  \n\n\n";
    let calls = stubFetch([jsonResponse(apiComment({ content }))]);
    await api().createComment("doc-1", content);
    expect(JSON.parse(calls[0].body!).content).toBe(content);
  });

  it("refuses empty or whitespace-only content, which Drive would post as an empty comment", async () => {
    let calls = stubFetch([]);
    await expect(api().createComment("doc-1", "")).rejects.toThrow("The comment is empty.");
    await expect(api().createComment("doc-1", " \n")).rejects.toThrow("The comment is empty.");
    expect(calls).toHaveLength(0);
  });

  it("refuses content over Google's UTF-8 byte limit without a request", async () => {
    let calls = stubFetch([jsonResponse(apiComment()), jsonResponse(apiComment())]);
    await api().createComment("doc-1", "a".repeat(MAX_COMMENT_BYTES));
    await api().createComment("doc-1", "\u00e9".repeat(2048));
    await expect(api().createComment("doc-1", "\u00e9".repeat(2049)))
      .rejects.toThrow("The comment is 4098 bytes of UTF-8; Google Drive allows at most 4096.");
    expect(calls).toHaveLength(2);
  });

  it("makes no request for an ID that is not a Drive file ID", async () => {
    let calls = stubFetch([]);
    await expect(api().createComment("x/y", "Hi")).rejects.toThrow("Not a Google Drive file ID.");
    expect(calls).toHaveLength(0);
  });

  it("never replays a write answered with a 5xx, or lost to the network", async () => {
    let calls = stubFetch(() => new Response("{}", { status: 503 }));
    await expect(api().createComment("doc-1", "Hi")).rejects.toMatchObject({ status: 503 });
    expect(calls).toHaveLength(1);

    let attempts = 0;
    vi.stubGlobal("fetch", async () => {
      attempts++;
      throw new TypeError("network connection lost");
    });
    await expect(api().createComment("doc-1", "Hi")).rejects.toThrow("network connection lost");
    expect(attempts).toBe(1);
  });

  it("refuses an unreadable success body after the write went through", async () => {
    stubFetch([new Response("not json", { status: 200 })]);
    let error = await api().createComment("doc-1", "Hi").catch(caught => caught);
    expect(error.message).toMatch(/not valid JSON/);
    expect(driveWriteFailure(error, { repeatable: false })).toBe("unknown");
  });
});

describe("the time a comment write may take", () => {
  // A 401 buys one attempt on a refreshed token and a 403 one on the stored token, once each.
  it.each([
    ["a comment", (drive: DriveApi) => drive.createComment("doc-1", "Hi")],
    ["a reply", (drive: DriveApi) => drive.createReply("doc-1", "c1", { content: "Yes." })],
  ] as const)("gives %s three attempts at most, each with a timeout, COMMENT_WRITE_MAX_MS in all", async (_what, write) => {
    let timeout = vi.spyOn(AbortSignal, "timeout");
    let calls = stubFetch([401, 403, 401].map(status => new Response("{}", { status })));
    let drive = new DriveApi(async opts =>
      opts?.forceRefresh ? "refreshed" : opts?.reloadStored ? "stored" : "tok");

    await expect(write(drive)).rejects.toMatchObject({ status: 401 });

    expect(calls.map(call => call.headers.get("Authorization")))
      .toEqual(["Bearer tok", "Bearer refreshed", "Bearer stored"]);
    let budgets = timeout.mock.calls.map(([ms]) => ms);
    expect(budgets).toHaveLength(3);
    expect(budgets.reduce((total, ms) => total + ms, 0)).toBe(COMMENT_WRITE_MAX_MS);
  });
});

describe("createReply", () => {
  it("POSTs a plain reply's content with the reply mask", async () => {
    let calls = stubFetch([jsonResponse(apiReply())]);
    let reply = await api().createReply("doc-1", "doco.AbCdEfGhIjKlMnOpQrStUv", { content: "Yes." });
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url.pathname).toBe("/drive/v3/files/doc-1/comments/doco.AbCdEfGhIjKlMnOpQrStUv/replies");
    expect(Object.fromEntries(calls[0].url.searchParams)).toEqual({ fields: REPLY_MASK });
    expect(JSON.parse(calls[0].body!)).toEqual({ content: "Yes." });
    expect(reply).toEqual({
      id: "doco.ZyXwVuTsRqPoNmLkJiHgFe", content: "Yes.", author: { displayName: "Ada", me: true },
      createdTime: "2026-10-20T10:05:00.000Z", modifiedTime: "2026-10-20T10:05:00.000Z", deleted: false,
    });
  });

  it("reports the reopen Drive adds to a reply on a resolved comment", async () => {
    stubFetch([jsonResponse(apiReply({ action: "reopen" }))]);
    await expect(api().createReply("doc-1", "c1", { content: "Yes." }))
      .resolves.toMatchObject({ action: "reopen" });
  });

  it("resolves with no content field at all, and Drive stores empty content", async () => {
    let calls = stubFetch([jsonResponse(apiReply({ action: "resolve", content: "", htmlContent: "" }))]);
    let reply = await api().createReply("doc-1", "c1", { action: "resolve" });
    expect(JSON.parse(calls[0].body!)).toEqual({ action: "resolve" });
    expect(reply).toMatchObject({ action: "resolve", content: "" });
  });

  it("resolves with content when given", async () => {
    let calls = stubFetch([jsonResponse(apiReply({ action: "resolve", content: "Fixed." }))]);
    await api().createReply("doc-1", "c1", { content: "Fixed.", action: "resolve" });
    expect(JSON.parse(calls[0].body!)).toEqual({ content: "Fixed.", action: "resolve" });
  });

  it("refuses a plain reply without content, a blank one, or an oversized one, without a request", async () => {
    let calls = stubFetch([]);
    await expect(api().createReply("doc-1", "c1", {})).rejects.toThrow("The reply is empty.");
    await expect(api().createReply("doc-1", "c1", { content: "  " })).rejects.toThrow("The reply is empty.");
    await expect(api().createReply("doc-1", "c1", { content: " ", action: "resolve" }))
      .rejects.toThrow("The reply is empty.");
    await expect(api().createReply("doc-1", "c1", { content: "a".repeat(MAX_COMMENT_BYTES + 1) }))
      .rejects.toThrow("The reply is 4097 bytes");
    expect(calls).toHaveLength(0);
  });

  it("makes no request for an invalid file or comment ID", async () => {
    let calls = stubFetch([]);
    await expect(api().createReply("doc-1", "pending:1", { content: "Yes." }))
      .rejects.toThrow("Not a Google Drive comment ID.");
    await expect(api().createReply("", "c1", { content: "Yes." }))
      .rejects.toThrow("Not a Google Drive file ID.");
    expect(calls).toHaveLength(0);
  });
});

/** The error a comment Drive answers with `response` fails with. */
async function failedComment(response: Response): Promise<unknown> {
  stubFetch([response]);
  return api().createComment("doc-1", "Hi").catch(error => error);
}

describe("driveWriteFailure, for a write that cannot be repeated", () => {
  it.each([
    ["an unknown file", googleError(404, "notFound", "File not found: doc-1.", "fileId")],
    ["an unknown comment", googleError(404, "notFound", "Comment not found: c1.", "commentId")],
    ["a view-only user", googleError(403, "insufficientFilePermissions",
      "The user does not have sufficient permissions for file doc-1.")],
    ["content over the limit", googleError(403, "commentLengthLimitExceeded",
      "Comment content is limited to 4096 bytes in UTF-8 encoding.")],
    ["a token without the scope", googleError(403, "insufficientPermissions", "Insufficient Permission")],
    ["a domain policy", googleError(403, "domainPolicy", "The domain administrators have disabled Drive apps.")],
    ["a disabled API", jsonResponse(JSON.parse(API_DISABLED_BODY), 403)],
  ])("knows %s posted nothing", async (_case, response) => {
    expect(driveWriteFailure(await failedComment(response), { repeatable: false })).toBe("absent");
  });

  it.each([
    ["a per-user rate limit", googleError(403, "userRateLimitExceeded", "User Rate Limit Exceeded")],
    ["a project rate limit", googleError(403, "rateLimitExceeded", "Rate Limit Exceeded")],
    ["a 429", googleError(429, "rateLimitExceeded", "Too Many Requests")],
  ])("reads %s as retryable", async (_case, response) => {
    expect(driveWriteFailure(await failedComment(response), { repeatable: false }))
      .toBe("rateLimited");
  });

  it.each([
    // Drive answered this 400 having created the comment.
    ["a 400 for an invalid fields mask", googleError(400, "invalidParameter", "Invalid field selection notAField", "fields")],
    ["a 400 bad request", googleError(400, "badRequest", "Bad Request")],
    ["a 500", new Response("{}", { status: 500 })],
    ["a 503 with an unreadable body", new Response("<html>", { status: 503 })],
  ])("proves nothing from %s", async (_case, response) => {
    expect(driveWriteFailure(await failedComment(response), { repeatable: false })).toBe("unknown");
  });

  it("proves nothing from a network failure or a timeout", () => {
    expect(driveWriteFailure(new TypeError("network connection lost"), { repeatable: false }))
      .toBe("unknown");
    expect(driveWriteFailure(
      new DOMException("The operation timed out.", "TimeoutError"), { repeatable: false }))
      .toBe("unknown");
  });

  it("reads a 401 that survived the token refresh as posting nothing", () => {
    expect(driveWriteFailure(new DriveApiRequestError(401), { repeatable: false })).toBe("absent");
  });
});

describe("the comment capability on a scope node", () => {
  it("carries canComment on a scope node", async () => {
    stubFetch([batchResponse([
      { status: 200, body: JSON.stringify({ id: "doc-1", parents: ["p"], capabilities: { canComment: true } }) },
    ])]);
    await expect(api().getScopeNodes(["doc-1"])).resolves.toEqual([
      { id: "doc-1", parents: ["p"], canComment: true },
    ]);
  });
});

describe("the capabilities a scope node carries for sharing and moves", () => {
  it("reads the capabilities a sharing or move proof decides from", async () => {
    let calls = stubFetch([batchResponse([
      { status: 200, body: JSON.stringify({
        id: "folder-1", mimeType: FOLDER_MIME_TYPE, parents: ["p"], driveId: "drive-1",
        trashed: false,
        capabilities: {
          canListChildren: true, canComment: true, canShare: true, canAddChildren: true,
          canMoveItemWithinDrive: true,
        },
      }) },
      { status: 200, body: JSON.stringify({
        id: "doc-1", parents: ["folder-1"], trashed: false,
        capabilities: { canShare: false, canAddChildren: false, canMoveItemWithinDrive: false },
      }) },
      { status: 200, body: JSON.stringify({ id: "doc-2", capabilities: {} }) },
    ])]);

    await expect(api().getScopeNodes(["folder-1", "doc-1", "doc-2"])).resolves.toStrictEqual([
      {
        id: "folder-1", mimeType: FOLDER_MIME_TYPE, driveId: "drive-1", parents: ["p"],
        trashed: false, canListChildren: true, canComment: true, canShare: true,
        canAddChildren: true, canMoveItemWithinDrive: true,
      },
      {
        id: "doc-1", parents: ["folder-1"], trashed: false, canShare: false,
        canAddChildren: false, canMoveItemWithinDrive: false,
      },
      // A part that carries no capability has none, which every caller reads as "cannot".
      { id: "doc-2" },
    ]);
    for (let id of ["folder-1", "doc-1", "doc-2"]) {
      expect(calls[0].body).toContain(
        `GET /drive/v3/files/${id}?fields=${encodeURIComponent(SCOPE_MASK)}&supportsAllDrives=true`);
    }
  });

  it.each(["canShare", "canAddChildren", "canMoveItemWithinDrive"])(
    "rejects a %s that is not a boolean instead of guessing", async capability => {
      stubFetch([batchResponse([
        { status: 200, body: JSON.stringify({ id: "doc-1", capabilities: { [capability]: "yes" } }) },
      ])]);
      await expect(api().getScopeNodes(["doc-1"])).rejects.toThrow(capability);
    });

  // Observations ask with a mask of their own, which names none of these capabilities.
  it("answers file and folder observations as before, whatever capabilities a node carries", async () => {
    let calls = stubFetch([batchResponse([
      // A file unit is the part being allowed, whatever capabilities it carries.
      { status: 200, body: JSON.stringify({ id: "file", mimeType: "application/pdf", trashed: false }) },
      { status: 200, body: JSON.stringify({
        id: "folder", mimeType: FOLDER_MIME_TYPE, trashed: false,
        capabilities: { canListChildren: true, canShare: false, canAddChildren: false },
      }) },
      { status: 200, body: JSON.stringify({
        id: "closed", mimeType: FOLDER_MIME_TYPE, trashed: false,
        capabilities: { canListChildren: false, canShare: true, canAddChildren: true },
      }) },
      { status: 200, body: JSON.stringify({
        id: "binned", mimeType: FOLDER_MIME_TYPE, trashed: true,
        capabilities: { canListChildren: true },
      }) },
      { status: 404, body: JSON.stringify({ error: { errors: [{ reason: "notFound" }] } }) },
      { status: 404, body: JSON.stringify({ error: { errors: [{ reason: "notFound" }] } }) },
    ])]);

    await expect(api().checkObservations([
      { kind: "file", fileId: "file" },
      { kind: "folder", fileId: "folder" },
      { kind: "folder", fileId: "closed" },
      { kind: "folder", fileId: "binned" },
      { kind: "file", fileId: "gone-file" },
      { kind: "folder", fileId: "gone-folder" },
    ])).resolves.toEqual([true, true, false, false, false, false]);
    expect(calls).toHaveLength(1);
    let asked = decodeURIComponent(calls[0].body ?? "");
    expect(asked).toContain("GET /drive/v3/files/file?fields=id,mimeType,parents,driveId,trashed," +
      "capabilities(canListChildren,canDownload)&supportsAllDrives=true");
    expect(asked).not.toContain("canShare");

    stubFetch([batchResponse([
      { status: 403, body: JSON.stringify({ error: { errors: [{ reason: "userRateLimitExceeded" }] } }) },
    ])]);
    await expect(api().checkObservations([{ kind: "file", fileId: "file" }]))
      .rejects.toThrow("Google Drive batch subrequest failed: 403");
  });
});

describe("the My Drive root alias", () => {
  it("is the alias Drive itself takes, which has the shape of a file ID", async () => {
    expect(MY_DRIVE_ROOT).toBe("root");
    expect(isDriveFileId(MY_DRIVE_ROOT)).toBe(true);

    // So a move names the root by it, as either parent.
    let calls = stubFetch([
      jsonResponse({ id: "F", parents: ["root-id"] }), jsonResponse({ id: "F", parents: ["T"] }),
    ]);
    await expect(api().swapParent("F", { addParent: MY_DRIVE_ROOT, removeParent: "S" }))
      .resolves.toStrictEqual({ id: "F", parents: ["root-id"] });
    await expect(api().swapParent("F", { addParent: "T", removeParent: MY_DRIVE_ROOT }))
      .resolves.toStrictEqual({ id: "F", parents: ["T"] });
    expect(calls.map(call => call.url.search)).toEqual([
      "?addParents=root&removeParents=S&fields=id%2Cparents&supportsAllDrives=true",
      "?addParents=T&removeParents=root&fields=id%2Cparents&supportsAllDrives=true",
    ]);
  });
});

describe("canShare", () => {
  it("asks for the sharing capability alone, across shared drives", async () => {
    let calls = stubFetch([jsonResponse({ capabilities: { canShare: true } })]);
    await expect(api().canShare("doc-1")).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url.pathname).toBe("/drive/v3/files/doc-1");
    expect(Object.fromEntries(calls[0].url.searchParams))
      .toEqual({ fields: "capabilities(canShare)", supportsAllDrives: "true" });
  });

  it("reads a missing or false capability as no", async () => {
    stubFetch([
      jsonResponse({ capabilities: { canShare: false } }), jsonResponse({ capabilities: {} }),
      jsonResponse({}),
    ]);
    await expect(api().canShare("doc-1")).resolves.toBe(false);
    await expect(api().canShare("doc-1")).resolves.toBe(false);
    await expect(api().canShare("doc-1")).resolves.toBe(false);
  });

  it("rejects a non-boolean capability", async () => {
    stubFetch([jsonResponse({ capabilities: { canShare: "yes" } })]);
    await expect(api().canShare("doc-1")).rejects.toThrow("canShare");
  });

  it("passes on a file the account cannot see as Drive's own failure", async () => {
    stubFetch([googleError(404, "notFound", "File not found: doc-1.", "fileId")]);
    await expect(api().canShare("doc-1")).rejects.toMatchObject({ status: 404, reason: "notFound" });
  });

  it("makes no request for an ID that is not a Drive file ID", async () => {
    let calls = stubFetch([]);
    await expect(api().canShare("../x")).rejects.toThrow("Not a Google Drive file ID.");
    expect(calls).toHaveLength(0);
  });
});

/**
 * The one mask every permission read and write sends. `permissionDetails` whole: a selection of
 * its members is a mask Drive was never seen to take.
 */
const PERMISSION_MASK =
  "id,type,role,emailAddress,domain,displayName,allowFileDiscovery,deleted,view,permissionDetails";

/** Parameters and fields that would carry authority this client never uses. */
const NEVER_SENT = [
  "transferOwnership", "useDomainAdminAccess", "moveToNewOwnersRoot", "enforceSingleParent",
  "removeExpiration",
];

type RecordedCall = ReturnType<typeof stubFetch>[number];

/** Asserts a request names no ownership transfer, admin override or expiry anywhere. */
function expectNoAuthority(call: RecordedCall): void {
  for (let name of NEVER_SENT) expect(call.url.searchParams.has(name)).toBe(false);
  for (let name of [...NEVER_SENT, "expirationTime"]) {
    expect(call.body ?? "").not.toContain(name);
    expect(call.url.searchParams.get("fields") ?? "").not.toContain(name);
  }
}

/** A detail as Drive sends it for an item outside a shared drive. */
const fileDetail = (role: string, inherited: boolean) => ({ permissionType: "file", role, inherited });

/** The owner of a file inside their own folder: one permission, two sources. */
const OWNER_PERMISSION = {
  id: "10000000000000000001", displayName: "Ada", type: "user",
  permissionDetails: [fileDetail("writer", true), fileDetail("owner", false)],
  emailAddress: "ada@example.com", role: "owner", deleted: false,
};
const USER_PERMISSION = {
  id: "10000000000000000002", displayName: "Bob", type: "user",
  permissionDetails: [fileDetail("writer", false)],
  emailAddress: "bob@example.com", role: "writer", deleted: false,
};
const LINK_PERMISSION = {
  id: "anyoneWithLink", type: "anyone", role: "reader", allowFileDiscovery: false,
  permissionDetails: [fileDetail("reader", false)],
};
const SEARCHABLE_LINK_PERMISSION = {
  id: "anyone", type: "anyone", role: "reader", allowFileDiscovery: true,
  permissionDetails: [fileDetail("reader", false)],
};
const DOMAIN_PERMISSION = {
  id: "10000000000000000003", displayName: "Example Org", type: "domain",
  permissionDetails: [fileDetail("reader", false)],
  role: "reader", allowFileDiscovery: false, domain: "example.org",
};

const OWNER_RECORD = {
  id: "10000000000000000001", type: "user", role: "owner", emailAddress: "ada@example.com",
  displayName: "Ada", deleted: false,
  details: [{ role: "writer", inherited: true }, { role: "owner", inherited: false }],
};
const USER_RECORD = {
  id: "10000000000000000002", type: "user", role: "writer", emailAddress: "bob@example.com",
  displayName: "Bob", deleted: false, details: [{ role: "writer", inherited: false }],
};
const LINK_RECORD = {
  id: "anyoneWithLink", type: "anyone", role: "reader", allowFileDiscovery: false,
  deleted: false, details: [{ role: "reader", inherited: false }],
};
const SEARCHABLE_LINK_RECORD = {
  id: "anyone", type: "anyone", role: "reader", allowFileDiscovery: true,
  deleted: false, details: [{ role: "reader", inherited: false }],
};
const DOMAIN_RECORD = {
  id: "10000000000000000003", type: "domain", role: "reader", domain: "example.org",
  displayName: "Example Org", allowFileDiscovery: false, deleted: false,
  details: [{ role: "reader", inherited: false }],
};

/** A permission of a view of the file, as Drive's reference and its roles guide each give one. */
const view = (extra: Record<string, unknown>) => ({
  id: "anyoneWithLink", type: "anyone", allowFileDiscovery: false, ...extra,
});

/** The permissions one page parses to. */
async function listed(permissions: unknown[]) {
  stubFetch([jsonResponse({ permissions })]);
  return (await api().listPermissions("doc-1")).permissions;
}

describe("permission IDs", () => {
  it("accepts a person's number and both link IDs, and refuses anything that could reshape a path", () => {
    for (let id of ["10000000000000000002", "anyoneWithLink", "anyone", "a_b-C9", "x".repeat(128)]) {
      expect(isDrivePermissionId(id)).toBe(true);
    }
    for (let id of ["", "a/b", "a?b", "a#b", "pending:1", "..", ".", "a b", "bob@example.com",
      "x".repeat(129)]) {
      expect(isDrivePermissionId(id)).toBe(false);
    }
  });
});

describe("listPermissions", () => {
  it("lists a page of permissions with the permission mask, parsing Drive's shapes", async () => {
    let calls = stubFetch([jsonResponse({
      permissions: [OWNER_PERMISSION, USER_PERMISSION, LINK_PERMISSION, DOMAIN_PERMISSION],
      nextPageToken: "page-2",
    })]);

    let page = await api().listPermissions("doc-1");

    // Strict, so a detail Drive sent without `inheritedFrom` has no such key, and nothing a
    // record does not declare (a detail's `permissionType` among it) rides along.
    expect(page).toStrictEqual({
      permissions: [OWNER_RECORD, USER_RECORD, LINK_RECORD, DOMAIN_RECORD],
      nextPageToken: "page-2",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBeUndefined();
    expect(calls[0].url.origin + calls[0].url.pathname)
      .toBe("https://www.googleapis.com/drive/v3/files/doc-1/permissions");
    expect(Object.fromEntries(calls[0].url.searchParams)).toEqual({
      pageSize: "100", supportsAllDrives: "true",
      fields: `nextPageToken,permissions(${PERMISSION_MASK})`,
    });
    expectNoAuthority(calls[0]);
  });

  it("parses a link that can be found by searching, which Drive lists under its other ID", async () => {
    // One file never lists both forms of anyone's access, so this is a page of its own.
    await expect(listed([
      OWNER_PERMISSION, USER_PERMISSION, SEARCHABLE_LINK_PERMISSION, DOMAIN_PERMISSION,
    ])).resolves.toStrictEqual([OWNER_RECORD, USER_RECORD, SEARCHABLE_LINK_RECORD, DOMAIN_RECORD]);
  });

  it("keeps every source of a shared drive member's access, in Drive's order", async () => {
    await expect(listed([{
      id: "10000000000000000004", type: "user", role: "writer", emailAddress: "cy@example.com",
      deleted: false,
      permissionDetails: [
        { permissionType: "member", role: "reader", inherited: true, inheritedFrom: "drive-1" },
        { permissionType: "file", role: "writer", inherited: true, inheritedFrom: "folder-1" },
        { permissionType: "file", role: "writer", inherited: false },
      ],
    }])).resolves.toStrictEqual([{
      id: "10000000000000000004", type: "user", role: "writer", emailAddress: "cy@example.com",
      deleted: false,
      details: [
        { role: "reader", inherited: true, inheritedFrom: "drive-1" },
        { role: "writer", inherited: true, inheritedFrom: "folder-1" },
        { role: "writer", inherited: false },
      ],
    }]);
  });

  it("takes Drive's own top-level role, and a permission without details as given on the file", async () => {
    await expect(listed([
      { id: "10000000000000000005", type: "group", role: "fileOrganizer",
        emailAddress: "team@example.com", deleted: false,
        permissionDetails: [fileDetail("reader", false), fileDetail("organizer", true)] },
      { id: "10000000000000000006", type: "user", role: "commenter" },
      { id: "10000000000000000007", type: "user", role: "reader", permissionDetails: [] },
    ])).resolves.toStrictEqual([
      { id: "10000000000000000005", type: "group", role: "fileOrganizer",
        emailAddress: "team@example.com", deleted: false,
        details: [{ role: "reader", inherited: false }, { role: "organizer", inherited: true }] },
      // No address either: Drive withholds one by leaving it out.
      { id: "10000000000000000006", type: "user", role: "commenter", deleted: false,
        details: [{ role: "commenter", inherited: false }] },
      { id: "10000000000000000007", type: "user", role: "reader", deleted: false,
        details: [{ role: "reader", inherited: false }] },
    ]);
  });

  it("reads an empty address, domain or name as none, and a deleted account as deleted", async () => {
    await expect(listed([{
      id: "10000000000000000008", type: "user", role: "reader", emailAddress: "", domain: "",
      displayName: "", deleted: true, permissionDetails: [fileDetail("reader", false)],
    }])).resolves.toStrictEqual([{
      id: "10000000000000000008", type: "user", role: "reader", deleted: true,
      details: [{ role: "reader", inherited: false }],
    }]);
  });

  it("never reads an expiry", async () => {
    await expect(listed([{ ...USER_PERMISSION, expirationTime: "2027-01-01T00:00:00.000Z" }]))
      .resolves.toStrictEqual([USER_RECORD]);
  });

  it("forwards the page token, and omits it on the first request and on the last page", async () => {
    let calls = stubFetch([jsonResponse({ permissions: [USER_PERMISSION] })]);
    await expect(api().listPermissions("doc-1", { pageToken: "page-2" }))
      .resolves.toStrictEqual({ permissions: [USER_RECORD] });
    expect(calls[0].url.searchParams.get("pageToken")).toBe("page-2");

    calls = stubFetch([jsonResponse({})]);
    await expect(api().listPermissions("doc-1")).resolves.toStrictEqual({ permissions: [] });
    expect(calls[0].url.searchParams.has("pageToken")).toBe(false);
  });

  it.each([
    ["a missing id", { type: "user", role: "reader" }],
    ["an empty id", { id: "", type: "user", role: "reader" }],
    ["a type Drive does not list", { id: "1", type: "member", role: "reader" }],
    ["a role Drive does not list", { id: "1", type: "user", role: "editor" }],
    ["a published view's role on a permission of the file", { id: "1", type: "anyone", role: "publishedReader" }],
    ["a detail without inherited", {
      id: "1", type: "user", role: "reader", permissionDetails: [{ permissionType: "file", role: "reader" }],
    }],
    ["a member's detail without inherited", {
      id: "1", type: "user", role: "reader", permissionDetails: [{ permissionType: "member", role: "reader" }],
    }],
    ["a detail whose role Drive does not list", {
      id: "1", type: "user", role: "reader", permissionDetails: [fileDetail("editor", false)],
    }],
    ["a detail whose inheritedFrom is not a string", {
      id: "1", type: "user", role: "reader",
      permissionDetails: [{ permissionType: "file", role: "reader", inherited: true, inheritedFrom: 7 }],
    }],
    ["details that are not a list", { id: "1", type: "user", role: "reader", permissionDetails: {} }],
    ["an address that is not a string", { id: "1", type: "user", role: "reader", emailAddress: 7 }],
    ["a searchable flag that is not a boolean", {
      id: "anyone", type: "anyone", role: "reader", allowFileDiscovery: "true",
    }],
    ["a permission that is not an object", "10000000000000000002"],
  ])("refuses a permission it cannot read: %s", async (_case, permission) => {
    await expect(listed([USER_PERMISSION, permission]))
      .rejects.toThrow(/^Invalid Google Drive permission/);
  });

  it("refuses a page whose permissions are not a list", async () => {
    stubFetch([jsonResponse({ permissions: {} })]);
    await expect(api().listPermissions("doc-1"))
      .rejects.toThrow("Invalid Google Drive permissions list response");
  });

  it("reads a shared drive's membership as inherited, whatever its flag", async () => {
    let member = { id: "10000000000000000004", type: "user", role: "reader", deleted: false };

    // Read as Drive flagged it, this would be access given on the file, which a role change or a
    // removal could then be sent for.
    await expect(listed([{
      ...member, permissionDetails: [{ permissionType: "member", role: "reader", inherited: false }],
    }])).resolves.toStrictEqual([{ ...member, details: [{ role: "reader", inherited: true }] }]);

    await expect(listed([{
      ...member, role: "writer",
      permissionDetails: [
        { permissionType: "member", role: "reader", inherited: false },
        { permissionType: "file", role: "writer", inherited: false },
      ],
    }])).resolves.toStrictEqual([{
      ...member, role: "writer",
      details: [{ role: "reader", inherited: true }, { role: "writer", inherited: false }],
    }]);

    await expect(listed([{
      ...member,
      permissionDetails: [
        { permissionType: "member", role: "reader", inherited: false, inheritedFrom: "drive-1" },
      ],
    }])).resolves.toStrictEqual([{
      ...member, details: [{ role: "reader", inherited: true, inheritedFrom: "drive-1" }],
    }]);
  });

  it("leaves out a permission that belongs to a view, whatever it carries", async () => {
    // Read as a permission of the file, the first would fail the whole page.
    for (let second of [
      view({ view: "published", role: "publishedReader" }),
      view({ view: "published", role: "reader", permissionDetails: [fileDetail("reader", false)] }),
      view({ view: "metadata", role: "reader" }),
      // Nothing else of it is read, so nothing else of it can fail the page.
      { view: "published" },
    ]) {
      await expect(listed([OWNER_PERMISSION, second, USER_PERMISSION]))
        .resolves.toStrictEqual([OWNER_RECORD, USER_RECORD]);
    }

    stubFetch([jsonResponse({
      permissions: [view({ view: "published", role: "publishedReader" })], nextPageToken: "page-2",
    })]);
    await expect(api().listPermissions("doc-1"))
      .resolves.toStrictEqual({ permissions: [], nextPageToken: "page-2" });
  });

  it("surfaces a file the account cannot share as Drive's 403", async () => {
    stubFetch([googleError(403, "insufficientFilePermissions",
      "The user does not have sufficient permissions for file doc-1.")]);
    await expect(api().listPermissions("doc-1"))
      .rejects.toMatchObject({ status: 403, reason: "insufficientFilePermissions" });
  });

  it("makes no request for an ID that is not a Drive file ID", async () => {
    let calls = stubFetch([]);
    await expect(api().listPermissions("x/y")).rejects.toThrow("Not a Google Drive file ID.");
    expect(calls).toHaveLength(0);
  });
});

/** What one recorded request asked, in the parts a permission or move call is pinned by. */
const asked = (call: RecordedCall) => ({
  method: call.method,
  url: call.url.origin + call.url.pathname,
  query: Object.fromEntries(call.url.searchParams),
  body: call.body === undefined ? undefined : JSON.parse(call.body) as unknown,
});

const PERMISSIONS_URL = "https://www.googleapis.com/drive/v3/files/doc-1/permissions";

describe("createPermission", () => {
  it("shares with each kind of grantee exactly as asked", async () => {
    let calls = stubFetch([
      jsonResponse(USER_PERMISSION), jsonResponse({
        id: "10000000000000000005", type: "group", role: "commenter",
        emailAddress: "team@example.com", deleted: false,
        permissionDetails: [fileDetail("commenter", false)],
      }),
      jsonResponse({ ...DOMAIN_PERMISSION, allowFileDiscovery: true }),
      jsonResponse(LINK_PERMISSION), jsonResponse(SEARCHABLE_LINK_PERMISSION),
    ]);

    await expect(api().createPermission(
      "doc-1", { type: "user", role: "writer", emailAddress: "bob@example.com" },
      { notify: true, message: "For your review." })).resolves.toStrictEqual(USER_RECORD);
    await expect(api().createPermission(
      "doc-1", { type: "group", role: "commenter", emailAddress: "team@example.com" },
      { notify: false })).resolves.toMatchObject({ id: "10000000000000000005", type: "group" });
    await expect(api().createPermission(
      "doc-1", { type: "domain", role: "reader", domain: "example.org", allowFileDiscovery: true },
      { notify: false })).resolves.toStrictEqual({ ...DOMAIN_RECORD, allowFileDiscovery: true });
    await expect(api().createPermission("doc-1", { type: "anyone", role: "reader" }, { notify: false }))
      .resolves.toStrictEqual(LINK_RECORD);
    await expect(api().createPermission(
      "doc-1", { type: "anyone", role: "commenter", allowFileDiscovery: true }, { notify: false }))
      .resolves.toStrictEqual(SEARCHABLE_LINK_RECORD);

    expect(calls.map(asked)).toStrictEqual([
      {
        method: "POST", url: PERMISSIONS_URL,
        query: {
          sendNotificationEmail: "true", emailMessage: "For your review.",
          supportsAllDrives: "true", fields: PERMISSION_MASK,
        },
        body: { type: "user", role: "writer", emailAddress: "bob@example.com" },
      },
      {
        method: "POST", url: PERMISSIONS_URL,
        query: { sendNotificationEmail: "false", supportsAllDrives: "true", fields: PERMISSION_MASK },
        body: { type: "group", role: "commenter", emailAddress: "team@example.com" },
      },
      {
        method: "POST", url: PERMISSIONS_URL,
        query: { sendNotificationEmail: "false", supportsAllDrives: "true", fields: PERMISSION_MASK },
        body: { type: "domain", role: "reader", domain: "example.org", allowFileDiscovery: true },
      },
      {
        method: "POST", url: PERMISSIONS_URL,
        query: { sendNotificationEmail: "false", supportsAllDrives: "true", fields: PERMISSION_MASK },
        // Said outright, so a public link is never searchable by Drive's default.
        body: { type: "anyone", role: "reader", allowFileDiscovery: false },
      },
      {
        method: "POST", url: PERMISSIONS_URL,
        query: { sendNotificationEmail: "false", supportsAllDrives: "true", fields: PERMISSION_MASK },
        body: { type: "anyone", role: "commenter", allowFileDiscovery: true },
      },
    ]);
    for (let call of calls) {
      expect(call.headers.get("Content-Type")).toBe("application/json");
      expect(call.headers.get("Authorization")).toBe("Bearer tok");
      expectNoAuthority(call);
    }
  });

  it("sends only what the grantee's kind takes", async () => {
    let calls = stubFetch([jsonResponse(USER_PERMISSION), jsonResponse(DOMAIN_PERMISSION)]);
    await api().createPermission("doc-1", {
      type: "user", role: "reader", emailAddress: "bob@example.com", domain: "example.org",
      allowFileDiscovery: true,
    }, { notify: false });
    await api().createPermission("doc-1", {
      type: "domain", role: "reader", emailAddress: "bob@example.com", domain: "example.org",
    }, { notify: false });
    expect(calls.map(call => asked(call).body)).toStrictEqual([
      { type: "user", role: "reader", emailAddress: "bob@example.com" },
      { type: "domain", role: "reader", domain: "example.org", allowFileDiscovery: false },
    ]);
  });

  it("refuses an email for a domain or for anyone before asking Google", async () => {
    let calls = stubFetch([]);
    let domain = { type: "domain", role: "reader", domain: "example.org" } as const;
    let anyone = { type: "anyone", role: "reader" } as const;
    for (let grant of [domain, anyone]) {
      await expect(api().createPermission("doc-1", grant, { notify: true }))
        .rejects.toThrow("Only a user or a group can be emailed about access.");
      await expect(api().createPermission("doc-1", grant, { notify: false, message: "Hello" }))
        .rejects.toThrow("Only a user or a group can be emailed about access.");
      await expect(api().createPermission("doc-1", grant, { notify: true, message: "Hello" }))
        .rejects.toThrow("Only a user or a group can be emailed about access.");
    }
    expect(calls).toHaveLength(0);
  });

  it("refuses an answer that is a view's permission, or none it can read", async () => {
    stubFetch([
      jsonResponse({ id: "anyoneWithLink", type: "anyone", role: "publishedReader", view: "published" }),
      jsonResponse({ id: "1", type: "user", role: "editor" }),
      new Response("not json", { status: 200 }),
    ]);
    let grant = { type: "anyone", role: "reader" } as const;
    await expect(api().createPermission("doc-1", grant, { notify: false }))
      .rejects.toThrow(/^Invalid Google Drive permission/);
    await expect(api().createPermission("doc-1", grant, { notify: false }))
      .rejects.toThrow(/^Invalid Google Drive permission/);
    // The share went through all the same, so the outcome is open.
    let error: unknown = await api().createPermission("doc-1", grant, { notify: false })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ message: expect.stringMatching(/not valid JSON/) });
    expect(driveWriteFailure(error, { repeatable: true })).toBe("unknown");
  });

  it("makes no request for an ID that is not a Drive file ID", async () => {
    let calls = stubFetch([]);
    await expect(api().createPermission("x/y", { type: "anyone", role: "reader" }, { notify: false }))
      .rejects.toThrow("Not a Google Drive file ID.");
    expect(calls).toHaveLength(0);
  });
});

/** A role past what the type allows, as a role read back from Drive can be. */
const role = (name: string) => name as DriveGivableRole;

describe("updatePermission and deletePermission", () => {
  it("changes and removes a permission by its ID", async () => {
    let calls = stubFetch([
      jsonResponse({ ...USER_PERMISSION, role: "reader", permissionDetails: [fileDetail("reader", false)] }),
      new Response(null, { status: 204 }),
      googleError(404, "notFound", "Permission not found: 10000000000000000002.", "permissionId"),
      googleError(403, "cannotDeletePermission", "The authenticated user cannot delete the permission."),
    ]);

    await expect(api().updatePermission("doc-1", "10000000000000000002", "reader")).resolves
      .toStrictEqual({ ...USER_RECORD, role: "reader", details: [{ role: "reader", inherited: false }] });
    await expect(api().deletePermission("doc-1", "10000000000000000002")).resolves.toBeUndefined();
    // Drive answers 404 for a permission that is gone and for a file the account cannot see
    // alike, so it is a failure like any other, never "already removed".
    await expect(api().deletePermission("doc-1", "10000000000000000002"))
      .rejects.toMatchObject({ status: 404, reason: "notFound" });
    await expect(api().deletePermission("doc-1", "10000000000000000001"))
      .rejects.toMatchObject({ status: 403, reason: "cannotDeletePermission" });

    expect(asked(calls[0])).toStrictEqual({
      method: "PATCH", url: `${PERMISSIONS_URL}/10000000000000000002`,
      query: { fields: PERMISSION_MASK, supportsAllDrives: "true" }, body: { role: "reader" },
    });
    expect(calls[0].body).toBe("{\"role\":\"reader\"}");
    expect(calls[0].headers.get("Content-Type")).toBe("application/json");
    expect(asked(calls[1])).toStrictEqual({
      method: "DELETE", url: `${PERMISSIONS_URL}/10000000000000000002`,
      query: { supportsAllDrives: "true" }, body: undefined,
    });
    expect(calls[1].headers.has("Content-Type")).toBe(false);
    for (let call of calls) expectNoAuthority(call);
  });

  it("addresses anyone's access under either of Drive's IDs for it", async () => {
    let calls = stubFetch([jsonResponse(LINK_PERMISSION), new Response(null, { status: 204 })]);
    // Drive answers under the ID of the form that exists, whichever one was asked.
    await expect(api().updatePermission("doc-1", "anyone", "reader")).resolves.toStrictEqual(LINK_RECORD);
    await api().deletePermission("doc-1", "anyoneWithLink");
    expect(calls.map(call => call.url.pathname)).toEqual([
      "/drive/v3/files/doc-1/permissions/anyone", "/drive/v3/files/doc-1/permissions/anyoneWithLink",
    ]);
  });

  it("refuses an ID that is not a permission's or a file's before any request", async () => {
    let calls = stubFetch([]);
    for (let id of ["1/2", "pending:3", "", "..", "bob@example.com"]) {
      await expect(api().updatePermission("doc-1", id, "reader"))
        .rejects.toThrow("Not a Google Drive access ID.");
      await expect(api().deletePermission("doc-1", id)).rejects.toThrow("Not a Google Drive access ID.");
    }
    await expect(api().updatePermission("x/y", "anyone", "reader"))
      .rejects.toThrow("Not a Google Drive file ID.");
    await expect(api().deletePermission("x/y", "anyone")).rejects.toThrow("Not a Google Drive file ID.");
    expect(calls).toHaveLength(0);
  });

  it("refuses an answer that is a view's permission", async () => {
    stubFetch([jsonResponse({ ...LINK_PERMISSION, view: "published" })]);
    await expect(api().updatePermission("doc-1", "anyoneWithLink", "reader"))
      .rejects.toThrow(/^Invalid Google Drive permission/);
  });

  it("never gives or sets a role above writer", async () => {
    let calls = stubFetch([]);
    let refusal = "Only reader, commenter or writer can be given.";
    await expect(api().createPermission(
      "doc-1", { type: "user", role: role("owner"), emailAddress: "bob@example.com" },
      { notify: false })).rejects.toThrow(refusal);
    await expect(api().updatePermission("doc-1", "10000000000000000002", role("organizer")))
      .rejects.toThrow(refusal);
    await expect(api().updatePermission("doc-1", "10000000000000000002", role("fileOrganizer")))
      .rejects.toThrow(refusal);
    await expect(api().updatePermission("doc-1", "10000000000000000002", role("owner")))
      .rejects.toThrow(refusal);
    await expect(api().updatePermission("doc-1", "10000000000000000002", role("")))
      .rejects.toThrow(refusal);
    expect(calls).toHaveLength(0);
  });
});

describe("swapParent", () => {
  it("moves a file by swapping one parent for another", async () => {
    let calls = stubFetch([jsonResponse({ id: "F", parents: ["T"] })]);

    await expect(api().swapParent("F", { addParent: "T", removeParent: "S" }))
      .resolves.toStrictEqual({ id: "F", parents: ["T"] });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].url.href).toBe("https://www.googleapis.com/drive/v3/files/F" +
      "?addParents=T&removeParents=S&fields=id%2Cparents&supportsAllDrives=true");
    expect(calls[0].body).toBe("{}");
    expect(calls[0].headers.get("Content-Type")).toBe("application/json");
    expectNoAuthority(calls[0]);
  });

  it("hands back whatever parents Drive holds afterwards, for the caller to judge", async () => {
    stubFetch([jsonResponse({ id: "F", parents: ["S", "T"] })]);
    await expect(api().swapParent("F", { addParent: "T", removeParent: "S" }))
      .resolves.toStrictEqual({ id: "F", parents: ["S", "T"] });
  });

  it.each([
    ["for another file", { id: "G", parents: ["T"] }],
    ["without the file's parents", { id: "F" }],
    ["with no parent at all", { id: "F", parents: [] }],
    ["with parents that are not IDs", { id: "F", parents: [7] }],
    ["that is not an object", "F"],
  ])("refuses an answer %s", async (_case, answer) => {
    stubFetch([jsonResponse(answer)]);
    let error: unknown = await api().swapParent("F", { addParent: "T", removeParent: "S" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    // The move was made all the same, so nothing about it reads as refused.
    expect(driveWriteFailure(error, { repeatable: true })).toBe("unknown");
  });

  it("never sends one parent without the other, or an ID that is not a file's", async () => {
    let calls = stubFetch([]);
    for (let move of [
      { addParent: "T", removeParent: "" }, { addParent: "", removeParent: "S" },
      { addParent: "T/x", removeParent: "S" }, { addParent: "T", removeParent: "S&x=1" },
    ]) {
      await expect(api().swapParent("F", move)).rejects.toThrow("Not a Google Drive file ID.");
    }
    await expect(api().swapParent("x/y", { addParent: "T", removeParent: "S" }))
      .rejects.toThrow("Not a Google Drive file ID.");
    expect(calls).toHaveLength(0);
  });
});

/** Each sharing change and the move, as one call on `drive`. */
const REPEATABLE_WRITES = [
  ["a share", (drive: DriveApi) => drive.createPermission(
    "doc-1", { type: "anyone", role: "reader" }, { notify: false })],
  ["a role change", (drive: DriveApi) => drive.updatePermission("doc-1", "anyone", "reader")],
  ["a removal", (drive: DriveApi) => drive.deletePermission("doc-1", "anyone")],
  ["a move", (drive: DriveApi) => drive.swapParent("F", { addParent: "T", removeParent: "S" })],
] as const;

describe("how a sharing change or a move is sent", () => {
  it.each(REPEATABLE_WRITES)(
    "sends %s once, with a timeout, whatever a 5xx or the network says", async (_what, write) => {
      let timeout = vi.spyOn(AbortSignal, "timeout");
      let calls = stubFetch(() => new Response("{}", { status: 503 }));
      await expect(write(api())).rejects.toMatchObject({ status: 503 });
      expect(calls).toHaveLength(1);
      expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([COMMENT_WRITE_MAX_MS / 3]);

      calls = stubFetch(() => new Response("{}", { status: 429 }));
      await expect(write(api())).rejects.toMatchObject({ status: 429 });
      expect(calls).toHaveLength(1);

      let attempts = 0;
      vi.stubGlobal("fetch", async () => {
        attempts++;
        throw new TypeError("network connection lost");
      });
      await expect(write(api())).rejects.toThrow("network connection lost");
      expect(attempts).toBe(1);
    });

  it.each(REPEATABLE_WRITES)(
    "sends %s once when the provider answers one token whatever is asked", async (_what, write) => {
      // A refresh or a reload that hands back the token Google just refused buys no second
      // request.
      for (let status of [401, 403]) {
        let calls = stubFetch(() => new Response("{}", { status }));
        await expect(write(new DriveApi(async () => "one-token"))).rejects.toMatchObject({ status });
        expect(calls.map(call => call.headers.get("Authorization"))).toEqual(["Bearer one-token"]);
      }
    });
});

describe("getAccountIdentity", () => {
  it("reads the connected account's identity, with or without its address", async () => {
    let calls = stubFetch([
      jsonResponse({ user: { permissionId: "10000000000000000001", emailAddress: "ada@example.com" } }),
      jsonResponse({ user: { permissionId: "10000000000000000001" } }),
      jsonResponse({ user: { permissionId: "10000000000000000001", emailAddress: "" } }),
      jsonResponse({ user: { permissionId: "10000000000000000001", emailAddress: 7 } }),
      jsonResponse({ user: { emailAddress: "ada@example.com" } }),
      jsonResponse({ user: { permissionId: "", emailAddress: "ada@example.com" } }),
      jsonResponse({ user: { permissionId: 7 } }),
      jsonResponse({}),
    ]);

    await expect(api().getAccountIdentity()).resolves.toStrictEqual({
      permissionId: "10000000000000000001", emailAddress: "ada@example.com",
    });
    // Every caller tells the account by its ID; the address is only asked for.
    for (let _withoutAddress of [1, 2, 3]) {
      await expect(api().getAccountIdentity())
        .resolves.toStrictEqual({ permissionId: "10000000000000000001" });
    }
    for (let _withoutId of [1, 2, 3, 4]) {
      await expect(api().getAccountIdentity())
        .rejects.toThrow("Invalid Google Drive account identity response");
    }

    expect(calls[0].method).toBeUndefined();
    expect(calls[0].url.origin + calls[0].url.pathname)
      .toBe("https://www.googleapis.com/drive/v3/about");
    expect(Object.fromEntries(calls[0].url.searchParams))
      .toEqual({ fields: "user(permissionId,emailAddress)" });
  });

  it("passes on a token with no Drive scope as the missing scope", async () => {
    stubFetch([new Response(MISSING_SCOPE_BODY, { status: 403 })]);
    let error: unknown = await api().getAccountIdentity().catch((caught: unknown) => caught);
    expect(isInsufficientScope(error)).toBe(true);
  });
});

/** The error a Drive request answered `status` and `reason` fails with. */
const failed = (status: number, reason?: string) => new DriveApiRequestError(status, reason);

/** The error a role change fails with, answered by the next stubbed response. */
const failedRoleChange = () => api().updatePermission("doc-1", "anyone", "reader")
  .catch((caught: unknown) => caught);

describe("driveWriteFailure", () => {
  it("classifies a failed write by whether it can be repeated", () => {
    // A write that cannot be repeated may have been made behind any 400.
    for (let reason of ["invalid", "invalidSharingRequest", "badRequest", "somethingNew", undefined,
      "invalidParameter"]) {
      expect(driveWriteFailure(failed(400, reason), { repeatable: false })).toBe("unknown");
    }
    // One that can is refused by a 400, a reason nothing here knows included.
    for (let reason of ["invalid", "invalidSharingRequest", "badRequest", "somethingNew", undefined]) {
      expect(driveWriteFailure(failed(400, reason), { repeatable: true })).toBe("absent");
    }
    // The one 400 Google answers for a write it has made: a response mask it does not accept.
    expect(driveWriteFailure(failed(400, "invalidParameter"), { repeatable: true })).toBe("unknown");

    // A repeatable write goes out under one token nothing refreshes, so its 401 says only that
    // the token lapsed; any other write's has been tried under a refreshed token by then.
    expect(driveWriteFailure(failed(401), { repeatable: true })).toBe("unauthorized");
    expect(driveWriteFailure(failed(401, "authError"), { repeatable: true })).toBe("unauthorized");
    expect(driveWriteFailure(failed(401), { repeatable: false })).toBe("absent");
  });

  it.each([true, false])("answers alike whether or not the write can be repeated (%s)", repeatable => {
    let classify = (error: unknown) => driveWriteFailure(error, { repeatable });
    for (let reason of ["sharingRateLimitExceeded", "rateLimitExceeded", "userRateLimitExceeded",
      "dailyLimitExceeded"]) {
      expect(classify(failed(403, reason))).toBe("rateLimited");
    }
    expect(classify(failed(429))).toBe("rateLimited");
    expect(classify(failed(429, "rateLimitExceeded"))).toBe("rateLimited");

    for (let reason of ["notFound", undefined]) expect(classify(failed(404, reason))).toBe("absent");
    for (let reason of ["insufficientFilePermissions", "insufficientPermissions", "domainPolicy",
      "shareOutNotPermitted", "cannotDeletePermission", "cannotModifyInheritedPermission",
      "forbidden", "somethingNew", undefined]) {
      expect(classify(failed(403, reason))).toBe("absent");
    }
    expect(classify(new DriveApiDisabledError("the Google Drive API is not enabled")))
      .toBe("absent");

    for (let status of [500, 502, 503, 504]) expect(classify(failed(status))).toBe("unknown");
    expect(classify(new TypeError("network connection lost"))).toBe("unknown");
    expect(classify(new DOMException("The operation timed out.", "TimeoutError"))).toBe("unknown");
    expect(classify(new Error("Google Drive response was not valid JSON (8 UTF-16 code units)")))
      .toBe("unknown");
    expect(classify(undefined)).toBe("unknown");
  });

  it("classifies what Drive really answers a sharing change", async () => {
    stubFetch([
      googleError(400, "invalid", "The specified domain is invalid or not applicable for the given permission type."),
      googleError(400, "invalidParameter", "Invalid field selection notAField", "fields"),
      googleError(403, "sharingRateLimitExceeded", "Rate limit exceeded. User message: \"Sorry\""),
      new Response(API_DISABLED_BODY, { status: 403 }),
    ]);
    expect(driveWriteFailure(await failedRoleChange(), { repeatable: true })).toBe("absent");
    expect(driveWriteFailure(await failedRoleChange(), { repeatable: true })).toBe("unknown");
    expect(driveWriteFailure(await failedRoleChange(), { repeatable: true })).toBe("rateLimited");
    expect(driveWriteFailure(await failedRoleChange(), { repeatable: true })).toBe("absent");
  });
});
