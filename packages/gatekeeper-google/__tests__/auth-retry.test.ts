import { env } from "cloudflare:workers";
import type { CallAnswer } from "@gadgets/gatekeeper-kit/upstream";
import {
  COMMON_SLOTS, SUBSERVICE_V1_SLOTS, type BlobSlot, type DoubleSlot,
} from "@gadgets/observability/metrics";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AccessTokenCache, fetchWithAuthRetry, readWithAuthRetry, type AccessTokenRequest,
} from "../src/auth-retry";
import { BigQueryApi } from "../src/bigquery-api";
import { GoogleCalendarApi } from "../src/calendar-api";
import { ChatApi } from "../src/chat-api";
import { GoogleDocsApi } from "../src/docs-api";
import { DriveApi } from "../src/drive-api";
import {
  exchangeAuthCode, getAccessToken, getGoogleAccountProfile, getGoogleVerifiedEmail, GmailApi,
  revokeGoogleToken,
} from "../src/google-api";
import { GoogleSheetsApi } from "../src/sheets-api";
import { GoogleSlidesApi } from "../src/slides-api";
import { googleUpstream, type NamedOperation } from "../src/upstream";

// The options of a request whose token never changes.
const TOKEN = { getAccessToken: async () => "token" };

// A `parse` that reads an answer as its status, and an `answer` that counts a 404 so read as a
// success and says nothing of any other status.
const statusOf = (response: Response) => response.status;
const absentIsSuccess = (status: number): CallAnswer | undefined =>
  status === 404 ? { outcome: "success" } : undefined;

/** A stub authority recording every request, answering with whatever token it currently holds. */
function authority(initial: string) {
  let requests: (AccessTokenRequest | undefined)[] = [];
  let stored = initial;
  let cache = new AccessTokenCache(async opts => {
    requests.push(opts);
    return { token: stored, expires: new Date(Date.now() + 3600_000) };
  });
  return {
    cache,
    requests,
    /** What a reconnect does: replace the stored token, telling no gatekeeper about it. */
    restore(token: string) { stored = token; },
  };
}

describe("AccessTokenCache", () => {
  it("answers repeat calls from the memo", async () => {
    let account = authority("tok");

    expect(await account.cache.get()).toBe("tok");
    expect(await account.cache.get()).toBe("tok");
    expect(account.requests).toHaveLength(1);
  });

  it("picks up a token stored since it memoized, without asking for a mint", async () => {
    let account = authority("narrow");
    expect(await account.cache.get()).toBe("narrow");
    account.restore("widened");

    expect(await account.cache.get()).toBe("narrow");
    expect(await account.cache.get({ reloadStored: true })).toBe("widened");

    expect(account.requests).toEqual([undefined, { reloadStored: true }]);
  });

  it("memoizes the reloaded token, so one 403 costs one round trip", async () => {
    let account = authority("narrow");
    await account.cache.get();
    account.restore("widened");
    await account.cache.get({ reloadStored: true });

    expect(await account.cache.get()).toBe("widened");
    expect(account.requests).toHaveLength(2);
  });
});

describe("fetchWithAuthRetry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Unlike a stream, a byte-array body survives being sent and can be replayed after a 401.
  it("replays a byte-array body once after a 401 refresh", async () => {
    let bodies: string[] = [];
    let tokens: (string | null)[] = [];
    let status = 401;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit = {}) => {
      bodies.push(new TextDecoder().decode(init.body as Uint8Array));
      tokens.push(new Headers(init.headers).get("Authorization"));
      let current = status;
      status = 200;
      return new Response("{}", { status: current });
    });
    let minted = 0;
    let response = await fetchWithAuthRetry(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      { method: "POST", body: new TextEncoder().encode("payload") },
      { getAccessToken: async () => `token-${++minted}` },
    );

    expect(response.status).toBe(200);
    expect(bodies).toEqual(["payload", "payload"]);
    expect(tokens).toEqual(["Bearer token-1", "Bearer token-2"]);
  });

  it("refreshes after a 401 once, and answers the 401 of the refreshed token", async () => {
    let tokens: (string | null)[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit = {}) => {
      tokens.push(new Headers(init.headers).get("Authorization"));
      return new Response(null, { status: 401 });
    });
    let asked: (AccessTokenRequest | undefined)[] = [];
    // A provider that mints another token each time it is asked, so only the rule stops a replay.
    let provider = async (opts?: AccessTokenRequest) => {
      asked.push(opts);
      return `token-${asked.length}`;
    };

    let response = await fetchWithAuthRetry(
      "https://chat.googleapis.com/v1/spaces", {}, { getAccessToken: provider });

    expect(response.status).toBe(401);
    expect(tokens).toEqual(["Bearer token-1", "Bearer token-2"]);
    expect(asked).toEqual([undefined, { forceRefresh: true, staleToken: "token-1" }]);
  });

  it("does not replay a 401 when the provider cannot refresh its token", async () => {
    let requests = 0;
    vi.stubGlobal("fetch", async () => { requests++; return new Response(null, { status: 401 }); });
    let response = await fetchWithAuthRetry("https://chat.googleapis.com/v1/spaces", {}, { getAccessToken: async () => "fixed" });
    expect(response.status).toBe(401);
    expect(requests).toBe(1);
  });

  it("replays a 403 once with the stored token where that changed, minting nothing", async () => {
    let tokens: (string | null)[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit = {}) => {
      tokens.push(new Headers(init.headers).get("Authorization"));
      return new Response(null, { status: 403 });
    });
    let asked: (AccessTokenRequest | undefined)[] = [];
    let stored = "narrow";
    let provider = async (opts?: AccessTokenRequest) => {
      asked.push(opts);
      return opts?.reloadStored ? stored : "narrow";
    };

    // The stored token is the one refused: the grant itself is insufficient.
    let unchanged = await fetchWithAuthRetry(
      "https://chat.googleapis.com/v1/spaces", { method: "POST", body: "{}" }, { getAccessToken: provider });
    // A reconnect stored another, which is sent once, and whose own 403 is the answer.
    stored = "widened";
    let regranted = await fetchWithAuthRetry(
      "https://chat.googleapis.com/v1/spaces", { method: "POST", body: "{}" }, { getAccessToken: provider });

    expect([unchanged.status, regranted.status]).toEqual([403, 403]);
    expect(tokens).toEqual(["Bearer narrow", "Bearer narrow", "Bearer widened"]);
    expect(asked).toEqual([undefined, { reloadStored: true }, undefined, { reloadStored: true }]);
  });

  it("asks for a token once, and sends it with every retry", async () => {
    let tokens: (string | null)[] = [];
    let statuses = [503, 500, 200];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit = {}) => {
      tokens.push(new Headers(init.headers).get("Authorization"));
      return new Response(null, { status: statuses.shift(), headers: { "Retry-After": "0" } });
    });
    let provider = vi.fn(async () => "token");

    let response = await fetchWithAuthRetry("https://chat.googleapis.com/v1/spaces", {}, { getAccessToken: provider });

    expect(response.status).toBe(200);
    expect(tokens).toEqual(["Bearer token", "Bearer token", "Bearer token"]);
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("follows no redirect unless the request says so, and hands on the mode it is given", async () => {
    let modes: (string | undefined)[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit = {}) => {
      modes.push(init.redirect);
      return new Response("{}");
    });

    await fetchWithAuthRetry("https://chat.googleapis.com/v1/spaces", {}, TOKEN);
    await fetchWithAuthRetry("https://chat.googleapis.com/v1/spaces", { redirect: "follow" }, TOKEN);
    await fetchWithAuthRetry(
      "https://lh3.googleusercontent.com/thumb", { redirect: "manual" },
      { getAccessToken: null, operation: "thumbnail.download" });
    await new DriveApi(async () => "token").openDownload("file-1");
    await new ChatApi(async () => "token").downloadAttachment("spaces/AAAA/messages/BBB.CCC/attachments/DDD");

    expect(modes).toEqual(["manual", "follow", "manual", "follow", "follow"]);
  });

  it("sends a request with no token provider as given, and replays no 401 or 403", async () => {
    let sent: Headers[] = [];
    let statuses = [401, 403];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      sent.push(new Headers(init.headers));
      return new Response(null, { status: statuses.shift()! });
    });
    let request = { headers: { "Content-Range": "bytes 0-1/2" }, body: new Uint8Array(2) };

    let rejected = await fetchWithAuthRetry(
      "https://www.googleapis.com/upload/drive/v3/files?upload_id=session-1",
      { ...request, method: "PUT" }, { getAccessToken: null });
    let refused = await fetchWithAuthRetry(
      "https://oauth2.googleapis.com/revoke", { ...request, method: "POST" },
      { getAccessToken: null });

    expect([rejected.status, refused.status]).toEqual([401, 403]);
    expect(sent.map(headers => Object.fromEntries(headers))).toEqual([
      { "content-range": "bytes 0-1/2" }, { "content-range": "bytes 0-1/2" },
    ]);
  });

  it("sends once a request that is not safe to send twice, or is given one attempt", async () => {
    let requests = 0;
    vi.stubGlobal("fetch", async () => {
      requests++;
      return new Response(null, { status: requests % 2 ? 503 : 429, headers: { "Retry-After": "0" } });
    });
    const SESSION = "https://www.googleapis.com/upload/drive/v3/files?upload_id=session-1";

    for (let method of ["POST", "PUT", "DELETE"]) {
      await fetchWithAuthRetry(SESSION, { method, body: "{}" }, { getAccessToken: null });
    }
    await fetchWithAuthRetry(
      "https://lh3.googleusercontent.com/thumb", {},
      { getAccessToken: null, retries: 1, operation: "thumbnail.download" });
    await fetchWithAuthRetry("https://www.googleapis.com/oauth2/v3/userinfo", {}, { ...TOKEN, retries: 1 });

    expect(requests).toBe(5);
  });

  it("refreshes an invalidated profile token before checking the account subject", async () => {
    const provider = vi.fn(async (opts?: AccessTokenRequest) => opts?.forceRefresh ? "fresh" : "stale");
    vi.stubGlobal("fetch", async (_input: string, init: RequestInit) =>
      new Headers(init.headers).get("Authorization") === "Bearer fresh"
        ? Response.json({sub: "original-account"}) : new Response(null, {status: 401}));
    expect(await getGoogleAccountProfile(provider)).toEqual({sub: "original-account"});
    expect(provider).toHaveBeenLastCalledWith({forceRefresh: true, staleToken: "stale"});
  });
});

describe("fetchWithAuthRetry metrics", () => {
  const FILE_URL = "https://www.googleapis.com/drive/v3/files/file-1";
  let ambient = env as { METRICS?: AnalyticsEngineDataset; SUBSERVICE_METRICS?: string };
  let points: AnalyticsEngineDataPoint[];
  beforeEach(() => {
    points = [];
    ambient.METRICS = { writeDataPoint: point => { points.push(point!); } };
    ambient.SUBSERVICE_METRICS = "true";
  });
  afterEach(() => {
    delete ambient.METRICS;
    delete ambient.SUBSERVICE_METRICS;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // A written point's value in one column.
  function column(point: AnalyticsEngineDataPoint, slot: BlobSlot | DoubleSlot) {
    let values = slot.startsWith("blob") ? point.blobs! : point.doubles!;
    return values[Number(slot.replace(/\D+/, "")) - 1];
  }

  // Each point written, as its service, operation, outcome, reason and HTTP status.
  function calls() {
    return points.map(point => [
      SUBSERVICE_V1_SLOTS.service, SUBSERVICE_V1_SLOTS.operation, COMMON_SLOTS.outcome,
      SUBSERVICE_V1_SLOTS.reason, SUBSERVICE_V1_SLOTS.httpStatus,
    ].map(slot => column(point, slot)));
  }

  // A fetch that answers with each of `statuses` in turn, asking for no wait before a retry.
  function answering(...statuses: number[]) {
    vi.stubGlobal("fetch", async () =>
      new Response("{}", { status: statuses.shift()!, headers: { "Retry-After": "0" } }));
  }

  // A fetch that is never answered, and fails with its signal's reason once that aborts.
  function unanswered() {
    let fetch = vi.fn((_url: string, init: RequestInit = {}) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
      }));
    vi.stubGlobal("fetch", fetch);
    return fetch;
  }

  it("counts a refused request and its retry, each under the operation given", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let statuses = [429, 200];
    vi.stubGlobal("fetch", async () => {
      now += 250;
      return new Response("{}", { status: statuses.shift()!, headers: { "Retry-After": "0" } });
    });

    let response = await fetchWithAuthRetry(
      FILE_URL, {}, { ...TOKEN, operation: "files.get.batch" });

    expect(response.status).toBe(200);
    expect(calls()).toEqual([
      ["google-drive", "files.get.batch", "refused", "rate", 429],
      ["google-drive", "files.get.batch", "success", "", 200],
    ]);
    expect(googleUpstream.source).toBe("gatekeeper.google.api");
    expect(points.map(point => column(point, SUBSERVICE_V1_SLOTS.source)))
        .toEqual([googleUpstream.source, googleUpstream.source]);
    expect(points.map(point => column(point, COMMON_SLOTS.durationMs))).toEqual([250, 250]);
  });

  it("names a request given no operation from its method and URL, or by its method alone", async () => {
    answering(200, 200);

    await fetchWithAuthRetry(FILE_URL, {}, TOKEN);
    await fetchWithAuthRetry(FILE_URL, { method: "patch", body: "{}" }, TOKEN);

    expect(calls()).toEqual([
      ["google-drive", "files.get", "success", "", 200],
      ["google-drive", "files.patch", "success", "", 200],
    ]);
    // A URL that does not say what its request does, which is why its one caller names it.
    expect(googleUpstream.operationOf("post", "https://www.googleapis.com/batch/drive/v3")).toBe("POST");
  });

  // A rejected request was a request too, though the caller never sees its answer.
  it("counts a 401, a 403 and the request replayed with another token", async () => {
    answering(401, 403, 200);
    let minted = 0;

    let response = await fetchWithAuthRetry(
      FILE_URL, { method: "POST", body: "{}" }, { getAccessToken: async () => `token-${++minted}` });

    expect(response.status).toBe(200);
    expect(calls()).toEqual([
      ["google-drive", "files.create", "error", "http", 401],
      ["google-drive", "files.create", "error", "http", 403],
      ["google-drive", "files.create", "success", "", 200],
    ]);
  });

  it("counts a redirect as an error but of a request that follows them, and a 5xx as an error, retried or not", async () => {
    answering(302, 302, 500, 503, 200);

    await fetchWithAuthRetry(FILE_URL, { method: "POST" }, TOKEN);
    await fetchWithAuthRetry(`${FILE_URL}?alt=media`, { redirect: "follow" }, TOKEN);
    await fetchWithAuthRetry(FILE_URL, { method: "POST" }, TOKEN);
    await fetchWithAuthRetry(FILE_URL, {}, TOKEN);

    expect(calls()).toEqual([
      ["google-drive", "files.create", "error", "http", 302],
      ["google-drive", "files.get.media", "success", "", 302],
      ["google-drive", "files.create", "error", "http", 500],
      ["google-drive", "files.get", "error", "http", 503],
      ["google-drive", "files.get", "success", "", 200],
    ]);
  });

  // Google's own rule: the client's default leaves a 500 and a 501 alone.
  it("sends a request that is safe to send twice again after a 429 and any 5xx, three times in all", async () => {
    answering(500, 501, 599, 429, 500, 500, 500, 500);

    let read = await fetchWithAuthRetry(FILE_URL, {}, TOKEN);
    let marked = await fetchWithAuthRetry(
      FILE_URL, { method: "POST", body: "{}" }, { ...TOKEN, idempotent: true, retries: 2 });
    let write = await fetchWithAuthRetry(FILE_URL, { method: "POST", body: "{}" }, TOKEN);
    let once = await fetchWithAuthRetry(FILE_URL, {}, { ...TOKEN, retries: 1 });
    let none = await fetchWithAuthRetry(FILE_URL, {}, { getAccessToken: null, retries: 1 });

    expect([read.status, marked.status, write.status, once.status, none.status])
        .toEqual([599, 500, 500, 500, 500]);
    expect(calls()).toEqual([
      ["google-drive", "files.get", "error", "http", 500],
      ["google-drive", "files.get", "error", "http", 501],
      ["google-drive", "files.get", "error", "http", 599],
      ["google-drive", "files.create", "refused", "rate", 429],
      ["google-drive", "files.create", "error", "http", 500],
      ["google-drive", "files.create", "error", "http", 500],
      ["google-drive", "files.get", "error", "http", 500],
      ["google-drive", "files.get", "error", "http", 500],
    ]);
  });

  it("counts a Drive range read that Drive never answers", async () => {
    vi.useFakeTimers();
    unanswered();

    let read = new DriveApi(async () => "token").downloadRange("file-1", 0, 100);
    let outcome = expect(read).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(60_000);

    await outcome;
    expect(calls()).toEqual([["google-drive", "files.get.media", "error", "timeout", 0]]);
  });

  it("counts a request that threw by whether its own timeout fired", async () => {
    let unaborted = new AbortController().signal;
    unanswered();
    await expect(fetchWithAuthRetry(
      FILE_URL, { method: "POST", signal: unaborted }, { ...TOKEN, timeoutMs: 5 },
    )).rejects.toThrow();
    vi.stubGlobal("fetch", async () => { throw new TypeError("network down"); });
    await expect(fetchWithAuthRetry(
      FILE_URL, { method: "POST", signal: unaborted }, { ...TOKEN, timeoutMs: 60_000 },
    )).rejects.toThrow("network down");

    expect(calls()).toEqual([
      ["google-drive", "files.create", "error", "timeout", 0],
      ["google-drive", "files.create", "error", "network", 0],
    ]);
  });

  it("counts the 499 of an upload session's cancel as its success, and of no other request", async () => {
    const SESSION = "https://www.googleapis.com/upload/drive/v3/files?upload_id=session-1";
    answering(499, 499, 200, 302, 404);
    let cancel = { getAccessToken: null, operation: "upload.cancel" } as const;
    await fetchWithAuthRetry(SESSION, { method: "DELETE" }, cancel);
    await fetchWithAuthRetry(SESSION, { method: "PUT" }, { getAccessToken: null, operation: "upload.send" });
    // Any other answer to the cancel below 400 is its success, though it follows no redirect.
    for (let answers = 0; answers < 3; answers++) await fetchWithAuthRetry(SESSION, { method: "DELETE" }, cancel);
    expect(calls()).toEqual([
      ["google-drive", "upload.cancel", "success", "", 499],
      ["google-drive", "upload.send", "error", "http", 499],
      ["google-drive", "upload.cancel", "success", "", 200],
      ["google-drive", "upload.cancel", "success", "", 302],
      ["google-drive", "upload.cancel", "error", "http", 404],
    ]);
  });

  it("counts a redirect answered to a request that follows none as an error", async () => {
    const THUMBNAIL = "https://lh3.googleusercontent.com/thumb";
    const SESSION = "https://www.googleapis.com/upload/drive/v3/files?upload_id=session-1";
    let put = { method: "PUT", redirect: "manual" } as const;
    let named = (operation: NamedOperation) => ({ getAccessToken: null, retries: 1, operation });
    answering(302, 302, 302, 308, 308, 308);
    for (let answers = 0; answers < 2; answers++) {
      await fetchWithAuthRetry(THUMBNAIL, { redirect: "manual" }, named("thumbnail.download"));
      await fetchWithAuthRetry(SESSION, put, named("upload.send"));
      await fetchWithAuthRetry(SESSION, put, named("upload.getStatus"));
    }
    expect(calls()).toEqual([
      ["google-other", "thumbnail.download", "error", "http", 302],
      ["google-drive", "upload.send", "error", "http", 302],
      ["google-drive", "upload.getStatus", "error", "http", 302],
      ["google-other", "thumbnail.download", "error", "http", 308],
      // Drive asks for more of an upload with a 308, which is no redirect and no failure.
      ["google-drive", "upload.send", "success", "", 308],
      ["google-drive", "upload.getStatus", "success", "", 308],
    ]);
  });

  // None but the verified-email read carries a token, and each is sent once.
  it("counts each request made at sign-in and for a thumbnail once, with a token only where it has one", async () => {
    let sent: [string, string | null][] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init: RequestInit) => {
      sent.push([new URL(url).hostname, new Headers(init.headers).get("Authorization")]);
      return Response.json({}, { status: 503 });
    });
    // Only the request is looked at, not what its caller makes of the answer.
    let asked = (answer: Promise<unknown>) => answer.catch(() => {});

    await asked(exchangeAuthCode("code", "client", "secret", "https://example.com/callback"));
    await asked(getAccessToken("refresh", "client", "secret"));
    await asked(getGoogleVerifiedEmail("signed-in"));
    await asked(revokeGoogleToken("refresh"));
    vi.stubGlobal("fetch", async (url: string | URL, init: RequestInit) => {
      sent.push([new URL(url).hostname, new Headers(init.headers).get("Authorization")]);
      return Response.json({ contentUrl: "https://lh7-us.googleusercontent.com/slidesz/thumb" });
    });
    await asked(new GoogleSlidesApi(async () => "token").getThumbnail("deck-1", "slide-1", "LARGE"));

    expect(sent).toEqual([
      ["oauth2.googleapis.com", null],
      ["oauth2.googleapis.com", null],
      ["www.googleapis.com", "Bearer signed-in"],
      ["oauth2.googleapis.com", null],
      ["slides.googleapis.com", "Bearer token"],
      ["lh7-us.googleusercontent.com", null],
    ]);
    expect(calls().map(([service, operation, , , status]) => [service, operation, status])).toEqual([
      ["google-oauth", "token.exchange", 503],
      ["google-oauth", "token.refresh", 503],
      ["google-oauth", "userinfo.get", 503],
      ["google-oauth", "revoke", 503],
      ["google-slides", "thumbnail.get", 200],
      ["google-other", "thumbnail.download", 200],
    ]);
  });

  it("counts an attempt as the request's `answer` says, with a token and without", async () => {
    answering(404, 404, 403);

    await readWithAuthRetry(FILE_URL, {}, TOKEN, statusOf, absentIsSuccess);
    await readWithAuthRetry(FILE_URL, {}, { getAccessToken: null }, statusOf, absentIsSuccess);
    await readWithAuthRetry(FILE_URL, {}, { getAccessToken: null }, statusOf, absentIsSuccess);

    expect(calls()).toEqual([
      ["google-drive", "files.get", "success", "", 404],
      ["google-drive", "files.get", "success", "", 404],
      // What `answer` says nothing of is counted by its status.
      ["google-drive", "files.get", "error", "http", 403],
    ]);
  });

  // A token Google does not hold is revoked, which is all a revocation is for.
  it("counts a revocation answered 400 `invalid_token` as its success", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ error: "invalid_token" }, { status: 400 }));

    await expect(revokeGoogleToken("refresh")).resolves.toBeUndefined();

    expect(calls()).toEqual([["google-oauth", "revoke", "success", "", 400]]);
  });

  it.each([
    ["another OAuth error", () => Response.json({ error: "invalid_request" }, { status: 400 }),
      "Failed to revoke token: invalid_request"],
    ["a JSON body that cannot be read",
      () => new Response("<html>", { status: 400, headers: { "Content-Type": "application/json" } }), SyntaxError],
    ["a JSON body that holds no error", () => Response.json(null, { status: 400 }), TypeError],
    ["a body that is not JSON", () => new Response("invalid_token", { status: 400, statusText: "Bad Request" }),
      "Failed to revoke token: 400 Bad Request"],
  ])("counts a revocation answered 400 with %s as an error", async (_name, answer, failure) => {
    vi.stubGlobal("fetch", async () => answer());

    await expect(revokeGoogleToken("refresh")).rejects.toThrow(failure);

    expect(calls()).toEqual([["google-oauth", "revoke", "error", "http", 400]]);
  });

  it.each([
    ["is no 400", () => Response.json({ error: "invalid_token" }, { status: 403 }),
      "Failed to revoke token: invalid_token", 403],
    ["does not say its body is JSON", () => new Response("invalid_token", { status: 400, statusText: "Bad Request" }),
      "Failed to revoke token: 400 Bad Request", 400],
  ])("reads no body to count a revocation's answer that %s", async (_name, answer, failure, status) => {
    let copied = vi.spyOn(Response.prototype, "clone");
    vi.stubGlobal("fetch", async () => answer());

    await expect(revokeGoogleToken("refresh")).rejects.toThrow(failure);

    expect(calls()).toEqual([["google-oauth", "revoke", "error", "http", status]]);
    expect(copied).not.toHaveBeenCalled();
  });

  it("counts a Chat request under the name its helper once passed", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ name: "spaces/AAAA", formattedText: "hi" }));
    let chat = new ChatApi(async () => "token");

    await chat.getSpace("spaces/AAAA");
    await chat.updateMessageText("spaces/AAAA/messages/BBB.CCC", "hi");

    expect(calls()).toEqual([
      ["google-chat", "spaces.get", "success", "", 200],
      ["google-chat", "messages.patch", "success", "", 200],
    ]);
  });

  it("names a request of each client, whose helpers pass no name", async () => {
    vi.stubGlobal("fetch", async () => Response.json({}));
    let token = async () => "token";
    // Only the request is looked at, not what a client makes of an empty answer.
    let asked = (answer: Promise<unknown>) => answer.catch(() => {});
    let drive = new DriveApi(token);
    let sheets = new GoogleSheetsApi(token);
    let slides = new GoogleSlidesApi(token);
    let chat = new ChatApi(token);

    await asked(new GmailApi("me@example.com", token).listDrafts(1));
    await asked(getGoogleAccountProfile(token));
    await asked(drive.getFile("file-1"));
    await asked(drive.listComments("file-1"));
    await asked(drive.createComment("file-1", "hi"));
    await asked(drive.openDownload("file-1"));
    await asked(drive.getScopeNodes(["file-1"]));
    await asked(new GoogleCalendarApi(token).getEvent("primary", "event-1"));
    await asked(new BigQueryApi(token).getDataset("project", "dataset"));
    await asked(new GoogleDocsApi(token).getRevisionId("doc-1"));
    await asked(new GoogleDocsApi(token).replyToSuggestion("doc-1", "suggestion-1", "hi"));
    await asked(sheets.getSpreadsheet("sheet-1"));
    await asked(sheets.getDeveloperMetadata("sheet-1", 1));
    await asked(slides.getPresentationTitle("deck-1"));
    await asked(slides.getSlide("deck-1", "slide-1"));
    await asked(slides.batchUpdate("deck-1", [], "revision-1"));
    await asked(chat.searchDirectory("a"));
    await asked(chat.profileNames(["users/1"]));
    await asked(chat.downloadAttachment("media-1"));

    expect(calls().map(([service, operation]) => [service, operation])).toEqual([
      ["google-gmail", "drafts.list"],
      ["google-oauth", "userinfo.get"],
      ["google-drive", "files.get"],
      ["google-drive", "comments.list"],
      ["google-drive", "comments.create"],
      ["google-drive", "files.get.media"],
      // A batch's URL does not say what is in it, so its one caller names it.
      ["google-drive", "files.get.batch"],
      ["google-calendar", "events.get"],
      ["google-bigquery", "datasets.get"],
      ["google-docs", "documents.get"],
      ["google-docs", "documents.batchUpdate"],
      ["google-sheets", "spreadsheets.get"],
      ["google-sheets", "developerMetadata.get"],
      ["google-slides", "presentations.get"],
      ["google-slides", "pages.get"],
      ["google-slides", "presentations.batchUpdate"],
      ["google-people", "people.searchDirectoryPeople"],
      ["google-people", "people.batchGet"],
      ["google-chat", "media.get.media"],
    ]);
  });
});

// Each request `work` makes: its name, the timeout it asks the client for (undefined for the
// client's 30 seconds, null for none) and the redirect mode `fetch` is handed. Every request is
// answered once, by `answer`, and what `work` makes of the answers is not looked at. It spies on
// the client and stubs `fetch`, which its caller restores.
async function requested(
  work: () => Promise<unknown>,
  answer: (url: URL, method: string) => Response = () => Response.json({}),
) {
  // A request goes through `request`, or through `read` where its answer is counted by its body.
  let asked = [vi.spyOn(googleUpstream, "request"), vi.spyOn(googleUpstream, "read")];
  for (let spy of asked) spy.mockClear();
  let modes: (string | undefined)[] = [];
  vi.stubGlobal("fetch", async (url: string | URL, init: RequestInit = {}) => {
    modes.push(init.redirect);
    return answer(new URL(url), init.method ?? "GET");
  });
  await work().catch(() => {});
  let sent = asked.flatMap(spy => spy.mock.calls.map(([input, init], at) =>
    ({ order: spy.mock.invocationCallOrder[at], input, init: init ?? {} })));
  return sent.toSorted((one, other) => one.order - other.order).map(({ input, init }, at) => [
    init.operation ?? googleUpstream.operationOf(init.method, input instanceof Request ? input.url : input),
    init.timeoutMs, modes[at],
  ]);
}

describe("the timeout and redirect mode each kind of request asks for", () => {
  const SESSION = "https://www.googleapis.com/upload/drive/v3/files?upload_id=session-1";
  const DEFAULT = undefined;
  const token = TOKEN.getAccessToken;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("gives a stream read for as long as it takes no timeout, and follows its download's redirect", async () => {
    let attachment = {
      key: "part-1", messageId: "abc123", attachmentId: "def456",
      info: { filename: "a.pdf", mimeType: "application/pdf", size: 3, disposition: null, readable: true },
    };

    expect(await requested(() => new DriveApi(token).downloadRange("file-1", 0, 100)))
        .toEqual([["files.get.media", null, "follow"]]);
    expect(await requested(() => new GmailApi("me@example.com", token).openAttachmentContent(attachment)))
        .toEqual([["attachments.get", null, "manual"]]);
  });

  it("gives a request that carries a file, a message or an attachment whole a longer timeout", async () => {
    let drive = new DriveApi(token);
    let gmail = new GmailApi("me@example.com", token);
    let attachment = {
      key: "part-1", messageId: "abc123", attachmentId: "def456",
      info: { filename: "a.pdf", mimeType: "application/pdf", size: 3, disposition: null, readable: true },
    };
    let copy = { name: "Copy", mimeType: "application/vnd.google-apps.document", parents: ["folder-1"], appProperties: {} };

    expect(await requested(async () => {
      await drive.openDownload("file-1");
      await new ChatApi(token).downloadAttachment("spaces/AAAA/messages/BBB.CCC/attachments/DDD");
      await gmail.getAttachmentContent(attachment).catch(() => {});
      await gmail.getMessage("abc123").catch(() => {});
      await gmail.getMessageFull("abc123").catch(() => {});
      await gmail.getDraft("abc123").catch(() => {});
      await gmail.getDraftFull("abc123").catch(() => {});
      await gmail.sendRawMessage("raw").catch(() => {});
      await gmail.createDraft("raw").catch(() => {});
      await gmail.updateDraft("abc123", "raw").catch(() => {});
      await gmail.sendDraft("abc123", "raw").catch(() => {});
      await drive.copyAsNative("file-1", copy).catch(() => {});
    })).toEqual([
      ["files.get.media", 60_000, "follow"],
      ["media.get.media", 60_000, "follow"],
      ["attachments.get", 60_000, "manual"],
      ["messages.get", 60_000, "manual"],
      ["messages.get", 60_000, "manual"],
      ["drafts.get", 60_000, "manual"],
      ["drafts.get", 60_000, "manual"],
      ["messages.send", 120_000, "manual"],
      ["drafts.create", 120_000, "manual"],
      ["drafts.update", 120_000, "manual"],
      ["drafts.send", 120_000, "manual"],
      ["files.copy", 120_000, "manual"],
    ]);
  });

  it("times an upload session's requests by what each does, and follows no redirect of theirs", async () => {
    let file = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(3));
        controller.close();
      },
    });

    expect(await requested(
      () => new DriveApi(token).uploadConverted(
        file, "application/msword", "application/vnd.google-apps.document", { name: "Doc", parents: ["folder-1"] }),
      (url, method) => {
        // The session opens, refuses the file's one chunk, and is cancelled.
        if (method === "POST") return new Response(null, { headers: { Location: SESSION } });
        return method === "PUT" ? Response.json({}, { status: 403 }) : new Response(null, { status: 499 });
      },
    )).toEqual([
      ["files.create.resumable", 30_000, "manual"],
      ["upload.send", 120_000, "manual"],
      ["upload.cancel", 5_000, "manual"],
    ]);
  });

  it("keeps the timeout a client states for its own requests", async () => {
    expect(await requested(async () => {
      await new DriveApi(token).createComment("file-1", "hi").catch(() => {});
      await new BigQueryApi(token).getDataset("project", "dataset").catch(() => {});
    })).toEqual([
      ["comments.create", 20_000, "manual"],
      ["datasets.get", 70_000, "manual"],
    ]);
  });

  it("follows no redirect of a thumbnail's download, and leaves an ordinary read the client's timeout", async () => {
    expect(await requested(
      () => new GoogleSlidesApi(token).getThumbnail("deck-1", "slide-1", "LARGE"),
      () => Response.json({ contentUrl: "https://lh7-us.googleusercontent.com/slidesz/thumb" }),
    )).toEqual([
      ["thumbnail.get", 30_000, "manual"],
      ["thumbnail.download", 30_000, "manual"],
    ]);
    expect(await requested(async () => {
      await new GmailApi("me@example.com", token).listDrafts(1).catch(() => {});
      await new ChatApi(token).getSpace("spaces/AAAA").catch(() => {});
      await new GoogleCalendarApi(token).getEvent("primary", "event-1").catch(() => {});
      await new DriveApi(token).getFile("file-1").catch(() => {});
    })).toEqual([
      ["drafts.list", DEFAULT, "manual"],
      ["spaces.get", DEFAULT, "manual"],
      ["events.get", DEFAULT, "manual"],
      ["files.get", DEFAULT, "manual"],
    ]);
  });
});
