import { afterEach, describe, expect, it, vi } from "vitest";
import { exchangeAuthCode } from "../src/google-api";

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
