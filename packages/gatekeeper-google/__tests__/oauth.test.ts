import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exchangeAuthCode, getAccessToken, getGoogleAccountDescription, getGoogleAccountProfile,
  revokeGoogleToken,
} from "../src/google-api";

const OAUTH_REDIRECT_URI = "https://gatekeeper-google.gadgets-staging.workers.dev/oauth";

afterEach(() => vi.unstubAllGlobals());

describe("Google OAuth callback", () => {
  it("sends the selected redirect URI unchanged during code exchange", async () => {
    const calls: RequestInit[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init ?? {});
      return Response.json({
        access_token: "access-token",
        refresh_token: "refresh-token",
        expires_in: 3600,
        scope: "openid",
      });
    }));

    await exchangeAuthCode(
      "code",
      "client-id",
      "client-secret",
      OAUTH_REDIRECT_URI,
    );

    const body = calls[0]?.body;
    expect(body).toBeInstanceOf(URLSearchParams);
    expect((body as URLSearchParams).get("redirect_uri")).toBe(OAUTH_REDIRECT_URI);
  });
});

describe("Google access token refresh", () => {
  function refuse(body: unknown, status = 400) {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(body, { status })));
    return getAccessToken("refresh-token", "client-id", "client-secret");
  }

  it("reports a revoked or expired grant, with the subtype Google gives for it", async () => {
    expect(await refuse({ error: "invalid_grant", error_description: "Token has been expired or revoked." }))
      .toEqual({ ok: false, reason: "revoked" });
    expect(await refuse({
      error: "invalid_grant", error_description: "reauth related error (invalid_rapt)",
      error_subtype: "invalid_rapt",
    })).toEqual({ ok: false, reason: "revoked", subtype: "invalid_rapt" });
  });

  it("keeps a subtype only when it is a code, never prose or another type", async () => {
    for (const error_subtype of ["Sign in again to continue", "", 7, { code: "invalid_rapt" }, null]) {
      expect(await refuse({ error: "invalid_grant", error_subtype }))
        .toEqual({ ok: false, reason: "revoked" });
    }
  });

  it("reports a scope an admin blocked, and throws on any other refusal", async () => {
    expect(await refuse({ error: "admin_policy_enforced", error_description: "blocked scope" }))
      .toEqual({ ok: false, reason: "policyBlocked", detail: "blocked scope" });
    await expect(refuse({ error: "invalid_client", error_description: "Unauthorized" }, 401))
      .rejects.toThrow("Failed to refresh access token [http=401 error=invalid_client]");
  });

  // A token endpoint's answer that is not JSON is not quoted either, refused or not.
  it("says a malformed token answer was not JSON, without quoting it", async () => {
    const malformed = (status: number) => vi.stubGlobal("fetch", vi.fn(async () => new Response(
      "{token=abc", { status, headers: { "Content-Type": "application/json" } })));
    malformed(503);
    await expect(getAccessToken("refresh-token", "client-id", "client-secret"))
      .rejects.toThrow(/^Failed to refresh access token \[http=503\]$/);
    malformed(200);
    await expect(getAccessToken("refresh-token", "client-id", "client-secret"))
      .rejects.toThrow(/^Google's token endpoint did not answer with JSON\.$/);
  });

  // A refusal's message is logged, so it carries Google's code and none of what Google wrote.
  it("keeps Google's description and any other body out of a refusal's error", async () => {
    await expect(refuse({ error: "invalid_client", error_description: "client secret-123 is wrong" }, 401))
      .rejects.toThrow(/^Failed to refresh access token \[http=401 error=invalid_client\]$/);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("upstream said token=abc", { status: 503 })));
    await expect(getAccessToken("refresh-token", "client-id", "client-secret"))
      .rejects.toThrow(/^Failed to refresh access token \[http=503\]$/);
  });
});

describe("Google user info", () => {
  it("ends a description's round trip that Google never answers when the caller's signal does", async () => {
    // Google never answers, until the request is aborted.
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      }));
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    const described = getGoogleAccountDescription("access-token", controller.signal);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    controller.abort(new Error("timed out"));
    await expect(described).rejects.toThrow("timed out");
  });

  // Its reason phrase is the server's own words, so a failure gives its status alone.
  it("gives a failure's status without its reason phrase", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503, statusText: "token=abc" })));
    await expect(getGoogleAccountProfile("access-token"))
      .rejects.toThrow(/^Failed to fetch user info \[http=503\]$/);
  });

  // A JSON parse error quotes the body, and this one is logged when a grant's holder is recorded.
  it("says a malformed answer was not JSON, without quoting it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("sub=ada token=abc", { status: 200 })));
    await expect(getGoogleAccountProfile("access-token"))
      .rejects.toThrow(/^Google user info was not JSON\.$/);
  });

  // Only a parse error says nothing true of the answer: a read the caller gave up on says so.
  it("gives the caller's reason for a read of the answer it gave up on", async () => {
    const controller = new AbortController();
    // The answer's head arrives; its body never does, until the read is given up.
    const fetch = vi.fn(async () => new Response(new ReadableStream({
      start: stream => controller.signal.addEventListener("abort", () => stream.error(controller.signal.reason)),
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    const profile = getGoogleAccountProfile("access-token", controller.signal);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    controller.abort(new Error("timed out"));
    await expect(profile).rejects.toThrow("timed out");
  });
});

describe("Google token revocation", () => {
  const answer = (body: string, init: ResponseInit) =>
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, init)));
  const json = { "Content-Type": "application/json" };

  // A failed revocation is logged, so its error carries Google's code and none of what Google wrote.
  it("keeps Google's words and any other body out of a failure's error", async () => {
    answer(JSON.stringify({ error: "token=abc was refused" }), { status: 400, headers: json });
    await expect(revokeGoogleToken("refresh-token")).rejects.toThrow(/^Failed to revoke token \[http=400\]$/);
    answer(JSON.stringify({ error: "unsupported_token_type" }), { status: 400, headers: json });
    await expect(revokeGoogleToken("refresh-token"))
      .rejects.toThrow(/^Failed to revoke token \[http=400 error=unsupported_token_type\]$/);
    answer("{ token=abc", { status: 503, headers: json });
    await expect(revokeGoogleToken("refresh-token")).rejects.toThrow(/^Failed to revoke token \[http=503\]$/);
    answer("upstream said token=abc", { status: 503, statusText: "token=abc" });
    await expect(revokeGoogleToken("refresh-token")).rejects.toThrow(/^Failed to revoke token \[http=503\]$/);
  });

  it("takes a token Google already does not know as revoked", async () => {
    answer(JSON.stringify({ error: "invalid_token" }), { status: 400, headers: json });
    await expect(revokeGoogleToken("refresh-token")).resolves.toBeUndefined();
  });
});
