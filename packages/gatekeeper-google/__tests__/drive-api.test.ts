import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DRIVE_FILE_ITEM_FIELDS, DriveApi, DriveApiDisabledError, DriveApiRequestError,
  FOLDER_MIME_TYPE, MAX_QUERY_PARENTS, buildDriveQuery, conversionError,
  escapeDriveQueryLiteral, isInsufficientScope, lacksFileContentAccess,
  type DriveConversionSource,
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
      capabilities: { canListChildren: true },
    };
    let calls = stubFetch([jsonResponse(file)]);
    expect(await api().getFile("file/1")).toEqual(file);
    expect(calls[0].url.pathname).toBe("/drive/v3/files/file%2F1");
    expect(calls[0].url.searchParams.get("supportsAllDrives")).toBe("true");
    expect(calls[0].url.searchParams.get("fields")).toBe(DRIVE_FILE_ITEM_FIELDS);
    expect(DRIVE_FILE_ITEM_FIELDS.split(",")).toContain("trashed");
    expect(DRIVE_FILE_ITEM_FIELDS).toContain("capabilities(canListChildren)");
    expect(DRIVE_FILE_ITEM_FIELDS).not.toMatch(/createdTime|photoLink|iconLink|thumbnailLink/);
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

});

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
    expect(calls[0].body).toContain(`fields=${encodeURIComponent(
      "id,mimeType,parents,driveId,trashed,capabilities(canListChildren)")}`);
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
