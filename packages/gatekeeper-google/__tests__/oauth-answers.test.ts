// A request to Google's OAuth service (a code's exchange, a token's refresh and its revocation,
// and the account's profile) is read inside the client's `read`, through `readWithAuthRetry`: its
// attempt is counted by what its answer holds, not by the status that came before it.

import type { CallAnswer } from "@gadgets/gatekeeper-kit/upstream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readWithAuthRetry } from "../src/auth-retry";
import {
  exchangeAuthCode, getAccessToken, getGoogleAccountProfile, getGoogleVerifiedEmail,
  isRefreshToken, revokeGoogleToken,
} from "../src/google-api";
import { unbindWrittenCalls, writtenCalls } from "./written-calls";

const JSON_BODY = { "Content-Type": "application/json" };
const USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";

// Each of the two requests that obtain a token, under the name it is counted by.
const TOKEN_REQUESTS = [
  ["token.exchange", (signal?: AbortSignal) =>
    exchangeAuthCode("code", "client", "secret", "https://example.com/callback", signal)],
  ["token.refresh", (signal?: AbortSignal) => getAccessToken("refresh", "client", "secret", signal)],
] as const;

// Stubs a fetch that answers every request with what `answer` makes, and records each.
function answering(answer: () => Response) {
  let fetch = vi.fn(async (_url: string | URL, _init?: RequestInit) => answer());
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

// An answer whose headers came and whose body fails as it is read.
function lostAfterHeaders(): Response {
  return new Response(new ReadableStream({
    pull(controller) { controller.error(new TypeError("connection lost")); },
  }), { headers: JSON_BODY });
}

// Stubs a fetch whose answers hold a body that never ends: reading one fails with the reason of
// the request's signal once that aborts.
function stalling() {
  let fetch = vi.fn(async (_url: string | URL, init: RequestInit = {}) => {
    let { signal } = init;
    return new Response(new ReadableStream({
      start(controller) {
        signal?.addEventListener("abort", () => controller.error(signal.reason));
      },
    }), { headers: JSON_BODY });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

// A parse that reads an answer's body whole.
const readText = (response: Response) => response.text();

// Counts a parsed answer that says it failed as an error inside a success.
const failedAnswer = (parsed: { failed: boolean }): CallAnswer | undefined =>
  parsed.failed ? { outcome: "error", reason: "api" } : undefined;

afterEach(() => {
  unbindWrittenCalls();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each(TOKEN_REQUESTS)("the answer to %s", (operation, request) => {
  it("is a success where it holds an access token", async () => {
    let written = writtenCalls();
    let fetch = answering(() => Response.json(
      { access_token: "access", refresh_token: "refresh", expires_in: 3600, scope: "openid email" }));

    let granted = await request();

    expect(granted).toMatchObject("ok" in granted
      ? { ok: true, token: { token: "access" } } : { accessToken: { token: "access" } });
    expect(written.answers(/./)).toEqual([[operation, "success", "", 200]]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a page that is no JSON",
      () => new Response("<html>Sign in</html>", { headers: { "Content-Type": "text/html" } })],
    ["JSON that is cut off", () => new Response('{"access_token":"acc', { headers: JSON_BODY })],
    ["JSON that is no object", () => Response.json(null)],
    ["a body lost after its headers", lostAfterHeaders],
  ])("is a failed read where a 200 holds %s, and the request is sent once", async (_what, answer) => {
    let written = writtenCalls();
    let fetch = answering(answer);

    await expect(request()).rejects.toThrow();

    expect(written.answers(/./)).toEqual([[operation, "error", "parse", 200]]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["names an OAuth error", { error: "invalid_grant", error_description: "Bad Request" }],
    ["holds no access token", { expires_in: 3600, scope: "openid" }],
    ["holds an access token that is no string", { access_token: 7, expires_in: 3600 }],
    ["holds an empty access token", { access_token: "", expires_in: 3600 }],
    ["names an OAuth error beside a token", { error: "invalid_scope", access_token: "access", expires_in: 3600 }],
  ])("is an error inside a success where a 200 %s", async (_what, body) => {
    let written = writtenCalls();
    let fetch = answering(() => Response.json(body));

    // What the helper makes of such an answer is its caller's to check.
    await expect(request()).resolves.toBeDefined();

    expect(written.answers(/./)).toEqual([[operation, "error", "api", 200]]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("is counted by its status where that is no success, whatever its body holds", async () => {
    let written = writtenCalls();
    let fetch = answering(() => Response.json({ error: "invalid_client" }, { status: 401 }));

    await expect(request()).rejects.toThrow("invalid_client");

    expect(written.answers(/./)).toEqual([[operation, "error", "http", 401]]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("is a timeout where its caller's timed wait ran out while its body was read", async () => {
    let written = writtenCalls();
    let fetch = stalling();

    await expect(request(AbortSignal.timeout(20))).rejects.toMatchObject({ name: "TimeoutError" });

    expect(written.answers(/./)).toEqual([[operation, "error", "timeout", 200]]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("is not counted where its caller gave the request up while its body was read", async () => {
    let written = writtenCalls();
    let fetch = stalling();
    let caller = new AbortController();

    let asked = expect(request(caller.signal)).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(fetch.mock.results[0]?.type).toBe("return"));
    caller.abort();

    await asked;
    expect(written.answers(/./)).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("the answer to a code's exchange that holds no refresh token", () => {
  it.each([
    ["none", { access_token: "access", expires_in: 3600, scope: "openid" }],
    ["an empty one", { access_token: "access", refresh_token: "", expires_in: 3600 }],
  ])("is an error inside a success where a 200 holds %s, as the connect flow refuses it", async (_what, body) => {
    let written = writtenCalls();
    let fetch = answering(() => Response.json(body));

    let grant = await exchangeAuthCode("code", "client", "secret", "https://example.com/callback");

    // The check the connect flow refuses the grant by.
    expect(isRefreshToken(grant.refreshToken)).toBe(false);
    expect(grant.accessToken.token).toBe("access");
    expect(written.answers(/./)).toEqual([["token.exchange", "error", "api", 200]]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("leaves a refresh that holds none a success", async () => {
    let written = writtenCalls();
    answering(() => Response.json({ access_token: "access", expires_in: 3600 }));

    expect(await getAccessToken("refresh", "client", "secret")).toMatchObject({ ok: true });

    expect(written.answers(/./)).toEqual([["token.refresh", "success", "", 200]]);
  });
});

describe("what the helpers make of a token answer", () => {
  it("is the grant of a code's exchange, with whatever its answer holds", async () => {
    answering(() => Response.json(
      { access_token: "access", refresh_token: "refresh", expires_in: 3600, scope: "openid email" }));
    let before = Date.now();
    let grant = await exchangeAuthCode("code", "client", "secret", "https://example.com/callback");

    expect(grant).toMatchObject({
      accessToken: { token: "access" }, refreshToken: "refresh", grantedScopes: ["openid", "email"],
    });
    expect(grant.accessToken.expires.valueOf()).toBeGreaterThanOrEqual(before + 3600_000);

    answering(() => Response.json({ error: "invalid_grant" }));
    let empty = await exchangeAuthCode("code", "client", "secret", "https://example.com/callback");

    expect(empty.accessToken.token).toBeUndefined();
    expect(empty.accessToken.expires.valueOf()).toBeNaN();
    expect(empty.refreshToken).toBeUndefined();
    expect(empty.grantedScopes).toEqual([]);
  });

  it("is the token of a refresh, with whatever its answer holds", async () => {
    answering(() => Response.json({ access_token: "access", expires_in: 3600 }));
    let before = Date.now();
    let minted = await getAccessToken("refresh", "client", "secret");

    expect(minted).toMatchObject({ ok: true, token: { token: "access" } });
    expect(minted.ok && minted.token.expires.valueOf()).toBeGreaterThanOrEqual(before + 3600_000);

    answering(() => Response.json({ error: "invalid_grant" }));
    let empty = await getAccessToken("refresh", "client", "secret");

    expect(empty.ok && empty.token.token).toBeUndefined();
    expect(empty.ok && empty.token.expires.valueOf()).toBeNaN();
  });

  it.each([
    ["a page that is no JSON",
      () => new Response("<html>", { headers: { "Content-Type": "text/html" } }),
      "Token endpoint didn't return JSON?", SyntaxError],
    ["JSON that is cut off", () => new Response('{"access_token":"acc', { headers: JSON_BODY }),
      SyntaxError, SyntaxError],
    ["JSON that is no object", () => Response.json(null), TypeError, TypeError],
    ["a body lost after its headers", lostAfterHeaders, "connection lost", "connection lost"],
  ])("throws what reading %s threw", async (_what, answer, exchangeFailure, refreshFailure) => {
    answering(answer);

    await expect(exchangeAuthCode("code", "client", "secret", "https://example.com/callback"))
      .rejects.toThrow(exchangeFailure);
    await expect(getAccessToken("refresh", "client", "secret")).rejects.toThrow(refreshFailure);
  });

  it("reports a refused refresh, counted by its status", async () => {
    let written = writtenCalls();
    answering(() => Response.json({ error: "invalid_grant" }, { status: 400 }));

    expect(await getAccessToken("refresh", "client", "secret")).toEqual({ ok: false, reason: "revoked" });

    expect(written.answers(/./)).toEqual([["token.refresh", "error", "http", 400]]);
  });
});

describe("the answer to a read of the account's profile", () => {
  it.each([
    ["a body that is no JSON", () => new Response("<html>"), SyntaxError],
    ["JSON that is no object", () => Response.json(null), TypeError],
    ["a body lost after its headers", lostAfterHeaders, "connection lost"],
  ])("is a failed read where a 200 holds %s", async (_what, answer, failure) => {
    let written = writtenCalls();
    answering(answer);

    await expect(getGoogleAccountProfile("token")).rejects.toThrow(failure);
    await expect(getGoogleVerifiedEmail("token")).rejects.toThrow(failure);

    expect(written.answers(/./)).toEqual([
      ["userinfo.get", "error", "parse", 200], ["userinfo.get", "error", "parse", 200],
    ]);
  });

  it("is a failed read where a profile names no account, and a success where an email is not verified", async () => {
    let written = writtenCalls();
    answering(() => Response.json({ email: "user@example.com", email_verified: false }));

    await expect(getGoogleAccountProfile("token"))
      .rejects.toThrow("Google user info did not include a stable account ID.");
    expect(await getGoogleVerifiedEmail("token")).toBeNull();

    expect(written.answers(/./)).toEqual([
      ["userinfo.get", "error", "parse", 200], ["userinfo.get", "success", "", 200],
    ]);
  });

  it("is a success where it holds the account, and is read once", async () => {
    let written = writtenCalls();
    let fetch = answering(() => Response.json(
      { sub: "account-1", email: "user@example.com", email_verified: true }));

    expect(await getGoogleAccountProfile("token"))
      .toEqual({ sub: "account-1", email: "user@example.com", email_verified: true });
    expect(await getGoogleVerifiedEmail("token")).toBe("user@example.com");

    expect(written.answers(/./)).toEqual([
      ["userinfo.get", "success", "", 200], ["userinfo.get", "success", "", 200],
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("is counted by its status where that is no success, the verified email asked for once", async () => {
    let written = writtenCalls();
    vi.spyOn(Math, "random").mockReturnValue(0);
    let fetch = answering(() => new Response("unavailable", { status: 503, statusText: "Service Unavailable" }));

    await expect(getGoogleVerifiedEmail("token"))
      .rejects.toThrow("Failed to fetch user info: 503 Service Unavailable");
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(getGoogleAccountProfile("token"))
      .rejects.toThrow("Failed to fetch user info: 503 Service Unavailable");

    expect(fetch).toHaveBeenCalledTimes(4);
    expect(written.answers(/./))
      .toEqual(Array.from({ length: 4 }, () => ["userinfo.get", "error", "http", 503]));
  });
});

describe("a read of the account's profile whose body the attempt's timeout cuts off", () => {
  it("is asked again, three times in all, and the verified email once", async () => {
    let written = writtenCalls();
    vi.spyOn(Math, "random").mockReturnValue(0);
    let timeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => timeout(20));
    let fetch = stalling();

    await expect(getGoogleAccountProfile("token")).rejects.toMatchObject({ name: "TimeoutError" });
    expect(fetch).toHaveBeenCalledTimes(3);
    await expect(getGoogleVerifiedEmail("token")).rejects.toMatchObject({ name: "TimeoutError" });

    expect(fetch).toHaveBeenCalledTimes(4);
    expect(written.answers(/./))
      .toEqual(Array.from({ length: 4 }, () => ["userinfo.get", "error", "timeout", 200]));
  });
});

describe("the answer to a revocation", () => {
  it("is a success where its body was read", async () => {
    let written = writtenCalls();
    let fetch = answering(() => Response.json({}));

    await expect(revokeGoogleToken("refresh")).resolves.toBeUndefined();

    expect(written.answers(/./)).toEqual([["revoke", "success", "", 200]]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("is a failed read where a 200's body is lost after its headers, and the request is sent once", async () => {
    let written = writtenCalls();
    let fetch = answering(lostAfterHeaders);

    await expect(revokeGoogleToken("refresh")).rejects.toThrow("connection lost");

    expect(written.answers(/./)).toEqual([["revoke", "error", "parse", 200]]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("is a timeout where its caller's timed wait ran out while its body was read", async () => {
    let written = writtenCalls();
    let fetch = stalling();

    await expect(revokeGoogleToken("refresh", AbortSignal.timeout(20)))
      .rejects.toMatchObject({ name: "TimeoutError" });

    expect(written.answers(/./)).toEqual([["revoke", "error", "timeout", 200]]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reads the body of a 400 once, with no copy made of the answer", async () => {
    let written = writtenCalls();
    let copied = vi.spyOn(Response.prototype, "clone");
    answering(() => Response.json({ error: "invalid_token" }, { status: 400 }));

    await expect(revokeGoogleToken("refresh")).resolves.toBeUndefined();

    expect(written.answers(/./)).toEqual([["revoke", "success", "", 400]]);
    expect(copied).not.toHaveBeenCalled();
  });
});

describe("readWithAuthRetry", () => {
  it("replays a 401 with a refreshed token, and reads the last answer alone", async () => {
    let written = writtenCalls();
    let tokens: (string | null)[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit = {}) => {
      tokens.push(new Headers(init.headers).get("Authorization"));
      return tokens.length === 1
        ? Response.json({ error: "invalid_token" }, { status: 401 }) : Response.json({ sub: "account-1" });
    });
    let minted = 0;
    let read: number[] = [];

    let parsed = await readWithAuthRetry(
      USERINFO_URL, {}, { getAccessToken: async () => `token-${++minted}` },
      async response => {
        read.push(response.status);
        return response.json<{ sub: string }>();
      });

    expect(parsed).toEqual({ sub: "account-1" });
    expect(tokens).toEqual(["Bearer token-1", "Bearer token-2"]);
    expect(read).toEqual([200]);
    expect(written.answers(/./)).toEqual([
      ["userinfo.get", "error", "http", 401], ["userinfo.get", "success", "", 200],
    ]);
  });

  it("sends a request with no token provider as given, under the name it is given", async () => {
    let written = writtenCalls();
    let fetch = answering(() => Response.json({ error: "invalid_grant" }, { status: 401 }));

    let status = await readWithAuthRetry(
      "https://oauth2.googleapis.com/token", { method: "POST", body: "grant_type=refresh_token" },
      { getAccessToken: null, operation: "token.refresh" }, response => response.status);

    expect(status).toBe(401);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(new Headers(fetch.mock.calls[0][1]?.headers).has("Authorization")).toBe(false);
    expect(written.answers(/./)).toEqual([["token.refresh", "error", "http", 401]]);
  });

  it("counts the answer as its hook says of what was parsed, and by its status where that says nothing", async () => {
    let written = writtenCalls();
    answering(() => Response.json({ failed: true }));

    await readWithAuthRetry(USERINFO_URL, {}, { getAccessToken: async () => "token" },
      response => response.json<{ failed: boolean }>(), failedAnswer);
    await readWithAuthRetry(USERINFO_URL, {}, { getAccessToken: async () => "token" },
      async () => ({ failed: false }), failedAnswer);

    expect(written.answers(/./)).toEqual([
      ["userinfo.get", "error", "api", 200], ["userinfo.get", "success", "", 200],
    ]);
  });

  it("asks again for an answer whose body timed out where the request is safe to send twice, and not where it is given one attempt", async () => {
    let written = writtenCalls();
    vi.spyOn(Math, "random").mockReturnValue(0);
    let fetch = stalling();

    await expect(readWithAuthRetry(
      USERINFO_URL, {}, { getAccessToken: async () => "token", timeoutMs: 20 }, readText,
    )).rejects.toMatchObject({ name: "TimeoutError" });
    expect(fetch).toHaveBeenCalledTimes(3);
    await expect(readWithAuthRetry(
      USERINFO_URL, {}, { getAccessToken: async () => "token", timeoutMs: 20, retries: 1 }, readText,
    )).rejects.toMatchObject({ name: "TimeoutError" });

    expect(fetch).toHaveBeenCalledTimes(4);
    expect(written.answers(/./))
      .toEqual(Array.from({ length: 4 }, () => ["userinfo.get", "error", "timeout", 200]));
  });
});
