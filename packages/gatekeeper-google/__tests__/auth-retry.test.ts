import { env } from "cloudflare:workers";
import {
  COMMON_SLOTS, SUBSERVICE_V1_SLOTS, subserviceTally, type BlobSlot, type DoubleSlot,
  type SubserviceTally,
} from "@gadgets/observability/metrics";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessTokenCache, fetchWithAuthRetry, type AccessTokenRequest } from "../src/auth-retry";
import { BigQueryApi } from "../src/bigquery-api";
import { GoogleCalendarApi } from "../src/calendar-api";
import { GOOGLE_API_SOURCE, summedInto } from "../src/call-metrics";
import { ChatApi } from "../src/chat-api";
import { GoogleDocsApi } from "../src/docs-api";
import { DriveApi } from "../src/drive-api";
import {
  exchangeAuthCode, getAccessToken, getGoogleAccountProfile, getGoogleVerifiedEmail, GmailApi,
  revokeGoogleToken,
} from "../src/google-api";
import { GoogleSheetsApi } from "../src/sheets-api";
import { GoogleSlidesApi } from "../src/slides-api";

// The options of a request whose token never changes.
const TOKEN = { getAccessToken: async () => "token" };

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
      "https://chat.googleapis.com/upload/v1/spaces/AAAA/attachments:upload",
      { method: "POST", body: new TextEncoder().encode("payload") },
      { getAccessToken: async () => `token-${++minted}` },
    );

    expect(response.status).toBe(200);
    expect(bodies).toEqual(["payload", "payload"]);
    expect(tokens).toEqual(["Bearer token-1", "Bearer token-2"]);
  });

  // A GET is replayed after a network failure, but an abort is the caller saying to stop.
  it("does not retry a request its caller's own signal aborted", async () => {
    let requests = 0;
    vi.stubGlobal("fetch", (_url: string, init: RequestInit = {}) => {
      requests++;
      return new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
      });
    });
    let caller = new AbortController();
    let response = fetchWithAuthRetry(
      "https://www.googleapis.com/drive/v3/files/file-1", { signal: caller.signal },
      TOKEN);
    let outcome = expect(response).rejects.toThrow("stop");
    await vi.waitFor(() => expect(requests).toBe(1));

    caller.abort(new Error("stop"));

    await outcome;
    expect(requests).toBe(1);
  });

  it("still retries a network failure when the caller's signal has not aborted", async () => {
    let requests = 0;
    vi.stubGlobal("fetch", async () => {
      if (requests++ === 0) throw new TypeError("network down");
      return new Response("{}");
    });

    let response = await fetchWithAuthRetry(
      "https://www.googleapis.com/drive/v3/files/file-1", { signal: new AbortController().signal },
      TOKEN);

    expect(response.status).toBe(200);
    expect(requests).toBe(2);
  });

  it("does not replay a 401 when the provider cannot refresh its token", async () => {
    let requests = 0;
    vi.stubGlobal("fetch", async () => { requests++; return new Response(null, { status: 401 }); });
    let response = await fetchWithAuthRetry("https://chat.googleapis.com/v1/spaces", {}, { getAccessToken: async () => "fixed" });
    expect(response.status).toBe(401);
    expect(requests).toBe(1);
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
    await fetchWithAuthRetry("https://lh3.googleusercontent.com/thumb", {}, { getAccessToken: null, retries: 1 });
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
      FILE_URL, {}, { ...TOKEN, operation: "files.get" });

    expect(response.status).toBe(200);
    expect(calls()).toEqual([
      ["google-drive", "files.get", "refused", "rate", 429],
      ["google-drive", "files.get", "success", "", 200],
    ]);
    expect(points.map(point => column(point, SUBSERVICE_V1_SLOTS.source)))
        .toEqual([GOOGLE_API_SOURCE, GOOGLE_API_SOURCE]);
    expect(points.map(point => column(point, COMMON_SLOTS.durationMs))).toEqual([250, 250]);
  });

  it("names a request given no operation from its method and URL, or by its method alone", async () => {
    answering(200, 200, 200);

    await fetchWithAuthRetry(FILE_URL, {}, TOKEN);
    await fetchWithAuthRetry(FILE_URL, { method: "patch", body: "{}" }, TOKEN);
    // A URL that does not say what its request does.
    await fetchWithAuthRetry(
      "https://www.googleapis.com/batch/drive/v3", { method: "post", body: "" }, TOKEN);

    expect(calls()).toEqual([
      ["google-drive", "files.get", "success", "", 200],
      ["google-drive", "files.patch", "success", "", 200],
      ["google-drive", "POST", "success", "", 200],
    ]);
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

  it("counts an answer below 400 as a success and a 5xx as an error, retried or not", async () => {
    answering(302, 500, 503, 200);

    await fetchWithAuthRetry(FILE_URL, { method: "POST" }, TOKEN);
    await fetchWithAuthRetry(FILE_URL, { method: "POST" }, TOKEN);
    await fetchWithAuthRetry(FILE_URL, {}, TOKEN);

    expect(calls()).toEqual([
      ["google-drive", "files.create", "success", "", 302],
      ["google-drive", "files.create", "error", "http", 500],
      ["google-drive", "files.get", "error", "http", 503],
      ["google-drive", "files.get", "success", "", 200],
    ]);
  });

  it("counts a request that threw and its retry, each with how long it took", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.spyOn(Math, "random").mockReturnValue(0);
    let failures = [new TypeError("network down")];
    vi.stubGlobal("fetch", async () => {
      now += 250;
      if (failures.length > 0) throw failures.shift();
      return new Response("{}");
    });

    let response = await fetchWithAuthRetry(FILE_URL, {}, TOKEN);

    expect(response.status).toBe(200);
    expect(calls()).toEqual([
      ["google-drive", "files.get", "error", "network", 0],
      ["google-drive", "files.get", "success", "", 200],
    ]);
    expect(points.map(point => column(point, COMMON_SLOTS.durationMs))).toEqual([250, 250]);
  });

  it("does not count a request its caller's own signal aborted", async () => {
    let fetch = unanswered();
    let caller = new AbortController();
    let response = fetchWithAuthRetry(
      FILE_URL, { signal: caller.signal }, { ...TOKEN, timeoutMs: 60_000 });
    let outcome = expect(response).rejects.toThrow("stop");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    caller.abort(new Error("stop"));

    await outcome;
    expect(calls()).toEqual([]);
  });

  // A caller that times its own wait for an answer does it through its signal, and has not given
  // the request up: the service did not answer it.
  it("counts a request its caller's signal timed out as a timeout, and does not retry it", async () => {
    let fetch = unanswered();
    let wait = new AbortController();
    let response = fetchWithAuthRetry(FILE_URL, { signal: wait.signal }, TOKEN);
    let outcome = expect(response).rejects.toThrow("too slow");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    wait.abort(new DOMException("too slow", "TimeoutError"));

    await outcome;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(calls()).toEqual([["google-drive", "files.get", "error", "timeout", 0]]);
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

  // The wait can run out between attempts, while a retry pauses or a token is minted. The
  // platform's `fetch` then fails at once with the signal's reason, having sent nothing.
  it("does not count an attempt that began once its caller's wait had run out", async () => {
    vi.useFakeTimers();
    let sent = 0;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit = {}) => {
      init.signal!.throwIfAborted();
      sent++;
      return new Response("{}", { status: 503, headers: { "Retry-After": "1" } });
    });
    let wait = new AbortController();
    let response = fetchWithAuthRetry(FILE_URL, { signal: wait.signal }, TOKEN);
    let outcome = expect(response).rejects.toThrow("too slow");
    await vi.advanceTimersByTimeAsync(500);
    wait.abort(new DOMException("too slow", "TimeoutError"));
    await vi.advanceTimersByTimeAsync(500);

    await outcome;
    expect(sent).toBe(1);
    expect(calls()).toEqual([["google-drive", "files.get", "error", "http", 503]]);

    let minting = new AbortController();
    await expect(fetchWithAuthRetry(FILE_URL, { signal: minting.signal }, { getAccessToken: async () => {
      minting.abort(new DOMException("too slow", "TimeoutError"));
      return "token";
    } })).rejects.toThrow("too slow");
    expect(sent).toBe(1);
    expect(calls()).toHaveLength(1);
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

  it("writes nothing inside `summedInto` until the tally is flushed", async () => {
    answering(200, 200);
    let tally = subserviceTally();

    await summedInto(tally, async () => {
      await fetchWithAuthRetry(FILE_URL, {}, TOKEN);
      await fetchWithAuthRetry(FILE_URL, {}, TOKEN);
    });
    expect(calls()).toEqual([]);

    tally.flush();
    expect(calls()).toEqual([["google-drive", "files.get", "success", "", 200]]);
    expect(column(points[0], SUBSERVICE_V1_SLOTS.calls)).toBe(2);
  });

  it("writes nothing with the variable off, and answers the same", async () => {
    vi.stubGlobal("fetch", async () => new Response("answer", { status: 404 }));
    let on = await fetchWithAuthRetry(FILE_URL, {}, TOKEN);
    expect(calls()).toEqual([["google-drive", "files.get", "error", "http", 404]]);

    ambient.SUBSERVICE_METRICS = "false";
    let off = await fetchWithAuthRetry(FILE_URL, {}, TOKEN);
    delete ambient.SUBSERVICE_METRICS;
    let unset = await fetchWithAuthRetry(FILE_URL, {}, TOKEN);
    ambient.SUBSERVICE_METRICS = "true";
    delete ambient.METRICS;
    let unbound = await fetchWithAuthRetry(FILE_URL, {}, TOKEN);

    expect(points).toHaveLength(1);
    let answer = [on.status, await on.text()];
    for (let other of [off, unset, unbound]) {
      expect([other.status, await other.text()]).toEqual(answer);
    }
  });

  it("answers, or fails as it would have, a request that could not be counted", async () => {
    let broken: SubserviceTally = { add() { throw new Error("no room"); }, flush() {} };
    answering(200);
    let response = await summedInto(broken, () =>
      fetchWithAuthRetry(FILE_URL, {}, TOKEN));
    expect(response.status).toBe(200);

    vi.stubGlobal("fetch", async () => { throw new TypeError("network down"); });
    await expect(summedInto(broken, () =>
      fetchWithAuthRetry(FILE_URL, { method: "POST" }, TOKEN),
    )).rejects.toThrow("network down");
  });

  it("counts the 499 of an upload session's cancel as its success, and of no other request", async () => {
    const SESSION = "https://www.googleapis.com/upload/drive/v3/files?upload_id=session-1";
    answering(499, 499);
    await fetchWithAuthRetry(SESSION, { method: "DELETE" }, { getAccessToken: null, operation: "upload.cancel" });
    await fetchWithAuthRetry(SESSION, { method: "PUT" }, { getAccessToken: null, operation: "upload.send" });
    expect(calls()).toEqual([
      ["google-drive", "upload.cancel", "success", "", 499],
      ["google-drive", "upload.send", "error", "http", 499],
    ]);
  });

  it("counts a redirect answered to a request that follows none as an error", async () => {
    const THUMBNAIL = "https://lh3.googleusercontent.com/thumb";
    const SESSION = "https://www.googleapis.com/upload/drive/v3/files?upload_id=session-1";
    let put = { method: "PUT", redirect: "manual" } as const;
    let named = (operation: string) => ({ getAccessToken: null, retries: 1, operation });
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

  // These were plain fetches once, counted nowhere: none but the verified-email read carries a
  // token, and each is sent once.
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
