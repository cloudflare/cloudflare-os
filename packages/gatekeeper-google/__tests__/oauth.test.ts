import { afterEach, describe, expect, it, vi } from "vitest";
import { exchangeAuthCode, getAccessToken, getGoogleAccountProfile } from "../src/google-api";

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
  // A JSON parse error quotes the body, and this one is logged when a grant's holder is recorded.
  it("says a malformed answer was not JSON, without quoting it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("sub=ada token=abc", { status: 200 })));
    await expect(getGoogleAccountProfile("access-token"))
      .rejects.toThrow(/^Google user info was not JSON\.$/);
  });
});
