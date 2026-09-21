import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildAuthorizeUrl,
  exchangeCode,
  generatePkce,
  refreshTokens,
  type CloudflareOAuthConfig,
} from "../src/oauth";

afterEach(() => vi.unstubAllGlobals());

const config: CloudflareOAuthConfig = {
  clientId: "client",
  clientSecret: "secret",
  authUrl: "https://dash.cloudflare.com/oauth2/auth",
  tokenUrl: "https://dash.cloudflare.com/oauth2/token",
  redirectUri: "https://gatekeeper.example/oauth",
};

/** Captures the single request `redeem` makes, so the tests can assert on how the code is redeemed. */
function captureRedeem(payload: Record<string, unknown>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return Response.json(payload);
  }));
  return calls;
}

describe("Cloudflare OAuth", () => {
  it("returns the scopes granted by the token endpoint", async () => {
    captureRedeem({
      access_token: "access",
      refresh_token: "refresh",
      expires_in: 3600,
      scope: "offline_access workers-observability.read",
    });

    const tokens = await exchangeCode(config, "code", "verifier");

    expect(tokens?.scopes).toEqual(["offline_access", "workers-observability.read"]);
  });

  it("reports no granted scopes when the provider omits them", async () => {
    // The caller must be able to tell "granted nothing extra" from "granted everything": this is what
    // `handleOAuthCallback` keys its fail-closed scope record on.
    captureRedeem({ access_token: "access", expires_in: 3600 });

    const tokens = await exchangeCode(config, "code", "verifier");

    expect(tokens?.scopes).toBeUndefined();
  });

  it("redeems a code with PKCE and the exact redirect URI, authenticating with Basic auth", async () => {
    const calls = captureRedeem({ access_token: "access", expires_in: 3600 });

    await exchangeCode(config, "the-code", "the-verifier");

    const [call] = calls;
    expect(call!.url).toBe(config.tokenUrl);
    expect(call!.init.method).toBe("POST");
    // Cloudflare's token endpoint takes the client credentials as Basic auth, not form fields, so a
    // regression here fails every connection.
    const headers = call!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${btoa("client:secret")}`);
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    // The verifier and the redirect URI both have to be replayed exactly, or the provider rejects the
    // redemption -- and omitting the verifier would silently drop PKCE's protection.
    expect(Object.fromEntries(call!.init.body as URLSearchParams)).toEqual({
      grant_type: "authorization_code",
      code: "the-code",
      redirect_uri: config.redirectUri,
      code_verifier: "the-verifier",
    });
  });

  it("refreshes without replaying the code or verifier", async () => {
    const calls = captureRedeem({ access_token: "access2", expires_in: 3600 });

    await refreshTokens(config, "the-refresh-token");

    expect(Object.fromEntries(calls[0]!.init.body as URLSearchParams)).toEqual({
      grant_type: "refresh_token",
      refresh_token: "the-refresh-token",
    });
  });

  it("returns null rather than a token on a rejected redemption", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));

    expect(await exchangeCode(config, "code", "verifier")).toBeNull();
  });

  it("returns null when a successful response carries no access token", async () => {
    captureRedeem({ refresh_token: "refresh", expires_in: 3600 });

    expect(await exchangeCode(config, "code", "verifier")).toBeNull();
  });

  it("derives the PKCE challenge as the URL-safe SHA-256 of the verifier", async () => {
    const { verifier, challenge } = await generatePkce();

    // S256, not "plain": the challenge must not be the verifier, and must be its digest.
    expect(challenge).not.toBe(verifier);
    expect(challenge).toMatch(/^[\w-]+$/);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const expected = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    expect(challenge).toBe(expected);
  });

  it("generates a fresh verifier per flow", async () => {
    const [first, second] = await Promise.all([generatePkce(), generatePkce()]);

    expect(first.verifier).not.toBe(second.verifier);
  });

  it("builds an authorize URL that declares S256 and the requested scopes", async () => {
    const url = new URL(buildAuthorizeUrl(config, "state-1", "challenge-1", ["a", "b"]));

    expect(url.origin + url.pathname).toBe(config.authUrl);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "client",
      redirect_uri: config.redirectUri,
      scope: "a b",
      state: "state-1",
      code_challenge: "challenge-1",
      // Downgrading this to "plain" would send the verifier in the clear on the authorize request.
      code_challenge_method: "S256",
    });
    // The client secret authenticates the token call only; it must never appear in a browser redirect.
    expect(url.toString()).not.toContain("secret");
  });
});
