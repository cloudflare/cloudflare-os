import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessTokenCache, fetchWithAuthRetry, type AccessTokenRequest } from "../src/auth-retry";
import { getGoogleAccountProfile } from "../src/google-api";
import { timeoutsOnFakeClock } from "./fake-timeouts";

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

  // Chat's hook delivery checks the account through this, so it must not hang on Google.
  it("abandons each attempt at a profile read Google never answers after 10 seconds", async () => {
    vi.useFakeTimers();
    timeoutsOnFakeClock();
    let requests = 0;
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
      requests++;
      return new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
      });
    });

    let profile = expect(getGoogleAccountProfile(async () => "token")).rejects.toMatchObject({name: "TimeoutError"});
    await vi.advanceTimersByTimeAsync(9_999);
    expect(requests).toBe(1);
    // Its three attempts, and at most 1.5 s of backoff between them.
    await vi.advanceTimersByTimeAsync(20_001 + 1_500);
    await profile;
    expect(requests).toBe(3);
  });
});
