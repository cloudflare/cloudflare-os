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

/** Installs a fetch stub and returns the URLs and headers it was called with. */
function stubFetch(responses: Response[] | (() => Response)) {
  let calls: { url: URL; headers: Headers }[] = [];
  let queue = Array.isArray(responses) ? [...responses] : null;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url: new URL(url), headers: new Headers(init.headers) });
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
