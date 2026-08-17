import { afterEach, describe, expect, it, vi } from "vitest";
import { exchangeCode, type CloudflareOAuthConfig } from "../src/oauth";

afterEach(() => vi.unstubAllGlobals());

const config: CloudflareOAuthConfig = {
  clientId: "client",
  clientSecret: "secret",
  authUrl: "https://dash.cloudflare.com/oauth2/auth",
  tokenUrl: "https://dash.cloudflare.com/oauth2/token",
  redirectUri: "https://gatekeeper.example/oauth",
};

describe("Cloudflare OAuth", () => {
  it("returns the scopes granted by the token endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      access_token: "access",
      refresh_token: "refresh",
      expires_in: 3600,
      scope: "offline_access workers-observability.read",
    })));

    const tokens = await exchangeCode(config, "code", "verifier");

    expect(tokens?.scopes).toEqual(["offline_access", "workers-observability.read"]);
  });
});
