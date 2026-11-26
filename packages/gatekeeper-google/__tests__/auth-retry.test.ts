import { env } from "cloudflare:workers";
import {
  COMMON_SLOTS, SUBSERVICE_V1_SLOTS, subserviceTally, type BlobSlot, type DoubleSlot,
  type SubserviceTally,
} from "@gadgets/observability/metrics";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessTokenCache, fetchWithAuthRetry, type AccessTokenRequest } from "../src/auth-retry";
import { GOOGLE_API_SOURCE, summedInto } from "../src/call-metrics";
import { ChatApi } from "../src/chat-api";
import { DriveApi } from "../src/drive-api";
import { getGoogleAccountProfile } from "../src/google-api";

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
    vi.useRealTimers();
    vi.restoreAllMocks();
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
      async () => `token-${++minted}`,
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
      async () => "token");
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
      async () => "token");

    expect(response.status).toBe(200);
    expect(requests).toBe(2);
  });

  // A caller that stops waiting for an answer stops waiting out the pause before a retry too.
  it("ends a retry's pause once its caller's signal aborts, sending nothing more", async () => {
    let answers: [string, () => Response][] = [
      ["a 503", () => new Response(null, { status: 503, headers: { "Retry-After": "10" } })],
      ["a network failure", () => { throw new TypeError("network down"); }],
    ];
    // Half the longest first pause, so that the abort always comes during it.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    for (let [what, answer] of answers) {
      vi.useFakeTimers();
      let requests = 0;
      vi.stubGlobal("fetch", async () => { requests++; return answer(); });
      let caller = new AbortController();
      let failed: unknown;
      fetchWithAuthRetry(
        "https://www.googleapis.com/drive/v3/files/file-1", { signal: caller.signal },
        async () => "token").catch((error: unknown) => { failed = error; });
      await vi.advanceTimersByTimeAsync(0);
      expect(requests, what).toBe(1);

      let reason = new Error("stop");
      caller.abort(reason);
      await vi.advanceTimersByTimeAsync(0);

      expect(failed, what).toBe(reason);
      expect(vi.getTimerCount(), what).toBe(0);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(requests, what).toBe(1);
      vi.useRealTimers();
    }
  });

  // A mint can take as long as the authority does; the caller's deadline still holds.
  it("ends a wait for a token once its caller's signal aborts", async () => {
    let never = new Promise<string>(() => {});
    let cases: [string, number, (opts?: AccessTokenRequest) => Promise<string>][] = [
      ["the first token", 200, async () => never],
      ["a refreshed token", 401, async opts => opts?.forceRefresh ? never : "stale"],
      ["a reloaded token", 403, async opts => opts?.reloadStored ? never : "token"],
    ];
    for (let [what, status, provider] of cases) {
      let asked = vi.fn(provider);
      let requests = 0;
      vi.stubGlobal("fetch", async () => { requests++; return new Response("{}", { status }); });
      let caller = new AbortController();
      let failed: unknown;
      fetchWithAuthRetry(
        "https://www.googleapis.com/drive/v3/files/file-1", { signal: caller.signal }, asked,
      ).catch((error: unknown) => { failed = error; });
      await vi.waitFor(() => expect(asked, what).toHaveBeenCalledTimes(status === 200 ? 1 : 2));

      let reason = new Error("stop");
      caller.abort(reason);

      await vi.waitFor(() => expect(failed, what).toBe(reason));
      expect(requests, what).toBe(status === 200 ? 0 : 1);
    }
  });

  // The refused answer is let go, but neither a cancel that stalls nor one that fails with the
  // body's own error may hold up or replace what the call rejects with.
  it("rejects with the abort's reason whatever letting go of the refused answer does", async () => {
    let never = new Promise<string>(() => {});
    let providers: [number, (opts?: AccessTokenRequest) => Promise<string>][] = [
      [401, async opts => opts?.forceRefresh ? never : "stale"],
      [403, async opts => opts?.reloadStored ? never : "token"],
    ];
    for (let [status, provider] of providers) {
      let cancels = 0;
      let bodies: [string, () => ReadableStream<Uint8Array>][] = [
        ["a cancel that stalls", () => new ReadableStream<Uint8Array>({
          cancel: () => { cancels++; return new Promise<void>(() => {}); },
        })],
        ["a body that has failed", () => new ReadableStream<Uint8Array>({
          start: controller => controller.error(new Error("body failed")),
        })],
      ];
      for (let [body, stream] of bodies) {
        let what = `${status}, ${body}`;
        let asked = vi.fn(provider);
        vi.stubGlobal("fetch", async () => new Response(stream(), { status }));
        let caller = new AbortController();
        let failed: unknown;
        fetchWithAuthRetry(
          "https://www.googleapis.com/drive/v3/files/file-1", { signal: caller.signal }, asked,
        ).catch((error: unknown) => { failed = error; });
        await vi.waitFor(() => expect(asked, what).toHaveBeenCalledTimes(2));

        let reason = new Error("stop");
        caller.abort(reason);

        await vi.waitFor(() => expect(failed, what).toBe(reason));
      }
      expect(cancels, `${status}: the refused answer is let go`).toBe(1);
    }
  });

  // Letting go of a refused answer is never waited on, so a cancel that stalls holds up nothing.
  it("sends its retry or replay without waiting to let go of the refused answer", async () => {
    let stalled = () => new ReadableStream<Uint8Array>({ cancel: () => new Promise<void>(() => {}) });
    let cases: [string, () => Response, (opts?: AccessTokenRequest) => Promise<string>][] = [
      ["a 503's retry", () => new Response(stalled(), { status: 503, headers: { "Retry-After": "1" } }),
        async () => "token"],
      ["a 401's replay", () => new Response(stalled(), { status: 401 }),
        async opts => opts?.forceRefresh ? "fresh" : "stale"],
      ["a 403's replay", () => new Response(stalled(), { status: 403 }),
        async opts => opts?.reloadStored ? "granted" : "token"],
    ];
    for (let [what, refused, provider] of cases) {
      vi.useFakeTimers();
      let requests = 0;
      vi.stubGlobal("fetch", async () => requests++ === 0 ? refused() : new Response("{}"));
      let answered: number | undefined;
      void fetchWithAuthRetry("https://www.googleapis.com/drive/v3/files/file-1", {}, provider)
        .then(response => { answered = response.status; });
      // The 503's pause is the second its Retry-After asks for.
      await vi.advanceTimersByTimeAsync(1000);
      expect(requests, what).toBe(2);
      expect(answered, what).toBe(200);
      vi.useRealTimers();
    }
  });

  it("does not replay a 401 when the provider cannot refresh its token", async () => {
    let requests = 0;
    vi.stubGlobal("fetch", async () => { requests++; return new Response(null, { status: 401 }); });
    let response = await fetchWithAuthRetry("https://chat.googleapis.com/v1/spaces", {}, async () => "fixed");
    expect(response.status).toBe(401);
    expect(requests).toBe(1);
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
      FILE_URL, {}, async () => "token", { operation: "files.get" });

    expect(response.status).toBe(200);
    expect(calls()).toEqual([
      ["google-drive", "files.get", "refused", "rate", 429],
      ["google-drive", "files.get", "success", "", 200],
    ]);
    expect(points.map(point => column(point, SUBSERVICE_V1_SLOTS.source)))
        .toEqual([GOOGLE_API_SOURCE, GOOGLE_API_SOURCE]);
    expect(points.map(point => column(point, COMMON_SLOTS.durationMs))).toEqual([250, 250]);
  });

  it("counts a request given no operation under its HTTP method", async () => {
    answering(200, 200);

    await fetchWithAuthRetry(FILE_URL, {}, async () => "token");
    await fetchWithAuthRetry(FILE_URL, { method: "patch", body: "{}" }, async () => "token");

    expect(calls()).toEqual([
      ["google-drive", "GET", "success", "", 200],
      ["google-drive", "PATCH", "success", "", 200],
    ]);
  });

  // A rejected request was a request too, though the caller never sees its answer.
  it("counts a 401, a 403 and the request replayed with another token", async () => {
    answering(401, 403, 200);
    let minted = 0;

    let response = await fetchWithAuthRetry(
      FILE_URL, { method: "POST", body: "{}" }, async () => `token-${++minted}`);

    expect(response.status).toBe(200);
    expect(calls()).toEqual([
      ["google-drive", "POST", "error", "http", 401],
      ["google-drive", "POST", "error", "http", 403],
      ["google-drive", "POST", "success", "", 200],
    ]);
  });

  it("counts an answer below 400 as a success and a 5xx as an error, retried or not", async () => {
    answering(302, 500, 503, 200);

    await fetchWithAuthRetry(FILE_URL, { method: "POST" }, async () => "token");
    await fetchWithAuthRetry(FILE_URL, { method: "POST" }, async () => "token");
    await fetchWithAuthRetry(FILE_URL, {}, async () => "token");

    expect(calls()).toEqual([
      ["google-drive", "POST", "success", "", 302],
      ["google-drive", "POST", "error", "http", 500],
      ["google-drive", "GET", "error", "http", 503],
      ["google-drive", "GET", "success", "", 200],
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

    let response = await fetchWithAuthRetry(FILE_URL, {}, async () => "token");

    expect(response.status).toBe(200);
    expect(calls()).toEqual([
      ["google-drive", "GET", "error", "network", 0],
      ["google-drive", "GET", "success", "", 200],
    ]);
    expect(points.map(point => column(point, COMMON_SLOTS.durationMs))).toEqual([250, 250]);
  });

  it("does not count a request its caller's own signal aborted", async () => {
    let fetch = unanswered();
    let caller = new AbortController();
    let response = fetchWithAuthRetry(
      FILE_URL, { signal: caller.signal }, async () => "token", { timeoutMs: 60_000 });
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
    let response = fetchWithAuthRetry(FILE_URL, { signal: wait.signal }, async () => "token");
    let outcome = expect(response).rejects.toThrow("too slow");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    wait.abort(new DOMException("too slow", "TimeoutError"));

    await outcome;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(calls()).toEqual([["google-drive", "GET", "error", "timeout", 0]]);
  });

  it("counts a Drive range read that Drive never answers", async () => {
    vi.useFakeTimers();
    unanswered();

    let read = new DriveApi(async () => "token").downloadRange("file-1", 0, 100);
    let outcome = expect(read).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(60_000);

    await outcome;
    expect(calls()).toEqual([["google-drive", "GET", "error", "timeout", 0]]);
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
    let response = fetchWithAuthRetry(FILE_URL, { signal: wait.signal }, async () => "token");
    let outcome = expect(response).rejects.toThrow("too slow");
    await vi.advanceTimersByTimeAsync(500);
    wait.abort(new DOMException("too slow", "TimeoutError"));
    await vi.advanceTimersByTimeAsync(500);

    await outcome;
    expect(sent).toBe(1);
    expect(calls()).toEqual([["google-drive", "GET", "error", "http", 503]]);

    let minting = new AbortController();
    await expect(fetchWithAuthRetry(FILE_URL, { signal: minting.signal }, async () => {
      minting.abort(new DOMException("too slow", "TimeoutError"));
      return "token";
    })).rejects.toThrow("too slow");
    expect(sent).toBe(1);
    expect(calls()).toHaveLength(1);
  });

  it("counts a request that threw by whether its own timeout fired", async () => {
    let unaborted = new AbortController().signal;
    unanswered();
    await expect(fetchWithAuthRetry(
      FILE_URL, { method: "POST", signal: unaborted }, async () => "token", { timeoutMs: 5 },
    )).rejects.toThrow();
    vi.stubGlobal("fetch", async () => { throw new TypeError("network down"); });
    await expect(fetchWithAuthRetry(
      FILE_URL, { method: "POST", signal: unaborted }, async () => "token", { timeoutMs: 60_000 },
    )).rejects.toThrow("network down");

    expect(calls()).toEqual([
      ["google-drive", "POST", "error", "timeout", 0],
      ["google-drive", "POST", "error", "network", 0],
    ]);
  });

  it("writes nothing inside `summedInto` until the tally is flushed", async () => {
    answering(200, 200);
    let tally = subserviceTally();

    await summedInto(tally, async () => {
      await fetchWithAuthRetry(FILE_URL, {}, async () => "token");
      await fetchWithAuthRetry(FILE_URL, {}, async () => "token");
    });
    expect(calls()).toEqual([]);

    tally.flush();
    expect(calls()).toEqual([["google-drive", "GET", "success", "", 200]]);
    expect(column(points[0], SUBSERVICE_V1_SLOTS.calls)).toBe(2);
  });

  it("writes nothing with the variable off, and answers the same", async () => {
    vi.stubGlobal("fetch", async () => new Response("answer", { status: 404 }));
    let on = await fetchWithAuthRetry(FILE_URL, {}, async () => "token");
    expect(calls()).toEqual([["google-drive", "GET", "error", "http", 404]]);

    ambient.SUBSERVICE_METRICS = "false";
    let off = await fetchWithAuthRetry(FILE_URL, {}, async () => "token");
    delete ambient.SUBSERVICE_METRICS;
    let unset = await fetchWithAuthRetry(FILE_URL, {}, async () => "token");
    ambient.SUBSERVICE_METRICS = "true";
    delete ambient.METRICS;
    let unbound = await fetchWithAuthRetry(FILE_URL, {}, async () => "token");

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
      fetchWithAuthRetry(FILE_URL, {}, async () => "token"));
    expect(response.status).toBe(200);

    vi.stubGlobal("fetch", async () => { throw new TypeError("network down"); });
    await expect(summedInto(broken, () =>
      fetchWithAuthRetry(FILE_URL, { method: "POST" }, async () => "token"),
    )).rejects.toThrow("network down");
  });

  it("counts a Chat request under the name its helper holds", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ name: "spaces/AAAA", formattedText: "hi" }));
    let chat = new ChatApi(async () => "token");

    await chat.getSpace("spaces/AAAA");
    await chat.updateMessageText("spaces/AAAA/messages/BBB.CCC", "hi");

    expect(calls()).toEqual([
      ["google-chat", "spaces.get", "success", "", 200],
      ["google-chat", "messages.patch", "success", "", 200],
    ]);
  });
});
