import { describe, expect, it, vi } from "vitest";
import {
  CHATGPT_REDIRECT_URI, ChatGptGrantRevoked, chatGptRedirectUri, exchangeCode, parseCallback,
  refreshCredential, startSignIn, type ChatGptCredential, type PendingChatGptSignIn,
} from "../src/chatgpt-oauth.js";

const HOST_ID = "0b6d6c1e-4a6f-4f1e-9a35-5b8d3c1f2e7a";
const SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";

function jwt(claims: object): string {
  let encode = (value: object) => new TextEncoder().encode(JSON.stringify(value))
      .toBase64({alphabet: "base64url", omitPadding: true});
  return `${encode({alg: "none"})}.${encode(claims)}.signature`;
}

// A token endpoint answering every request with `body`, recording what it was sent.
function tokenEndpoint(body: object, status = 200) {
  let requests: URLSearchParams[] = [];
  let fetchFn = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new URLSearchParams(init!.body as URLSearchParams));
    return Response.json(body, { status });
  }) as unknown as typeof fetch;
  return { fetchFn, requests };
}

async function pendingSignIn(redirectUri = CHATGPT_REDIRECT_URI)
    : Promise<{ authorizeUrl: URL; pending: PendingChatGptSignIn }> {
  let { authorizeUrl, pending } = await startSignIn(HOST_ID, redirectUri);
  return { authorizeUrl: new URL(authorizeUrl), pending };
}

function callbackUrl(params: Record<string, string>, redirectUri = CHATGPT_REDIRECT_URI): string {
  let url = new URL(redirectUri);
  url.search = new URLSearchParams(params).toString();
  return url.toString();
}

describe("chatGptRedirectUri", () => {
  // OpenAI accepts only http loopback addresses with a port.
  it.each([
    "http://localhost:8787", "http://localhost:8787/", "http://127.0.0.1:3000/app",
  ])("returns to the Workshop itself when it is served from %s", base => {
    expect(chatGptRedirectUri(base)).toBe(`${new URL(base).origin}/connect/chatgpt`);
  });

  it.each([
    "https://os.example.com/", "https://localhost:8787", "http://localhost", "http://example.com:80",
    "not a url", undefined,
  ])("returns to the loopback address nothing answers for %s", base => {
    expect(chatGptRedirectUri(base)).toBe(CHATGPT_REDIRECT_URI);
  });
});

describe("startSignIn", () => {
  it("asks for direct API access for this agent host, bound by PKCE, state and nonce", async () => {
    let { authorizeUrl, pending } = await pendingSignIn();
    expect(authorizeUrl.origin + authorizeUrl.pathname)
        .toBe("https://auth.openai.com/api/accounts/authorize");
    let params = Object.fromEntries(authorizeUrl.searchParams);
    expect(params).toMatchObject({
      client_id: "dynamic_agent_client",
      agent_name_hint: "Gadgets",
      ext_agent_host_id: `urn:uuid:${HOST_ID}`,
      response_type: "code",
      redirect_uri: CHATGPT_REDIRECT_URI,
      resource: "https://api.openai.com/v1",
      scope: SCOPE,
      state: pending.state,
      nonce: pending.nonce,
      code_challenge_method: "S256",
    });
    let challenge = new Uint8Array(await crypto.subtle.digest(
        "SHA-256", new TextEncoder().encode(pending.verifier)))
        .toBase64({alphabet: "base64url", omitPadding: true});
    expect(params.code_challenge).toBe(challenge);
    expect(pending.expiresAt.valueOf()).toBeGreaterThan(Date.now());
  });

  it("starts each sign-in with fresh secrets", async () => {
    let [a, b] = [await pendingSignIn(), await pendingSignIn()];
    expect(a.pending.state).not.toBe(b.pending.state);
    expect(a.pending.verifier).not.toBe(b.pending.verifier);
    expect(a.pending.nonce).not.toBe(b.pending.nonce);
  });
});

describe("parseCallback", () => {
  it("reads the code and the client ID OpenAI issued", async () => {
    let { pending } = await pendingSignIn();
    expect(parseCallback(
        ` ${callbackUrl({ code: "the-code", state: pending.state, client_id: "issued" })} `,
        pending)).toEqual({ code: "the-code", clientId: "issued" });
  });

  it.each([
    ["something that isn't an address", "not a url", "full address"],
    ["another address", "https://evil.example/auth/callback?code=c", "should start with"],
    ["another port", "http://127.0.0.1:1456/auth/callback?code=c", "should start with"],
  ])("refuses %s", async (_, url, message) => {
    let { pending } = await pendingSignIn();
    expect(() => parseCallback(url, pending)).toThrow(message);
  });

  it("reads the callback from the Workshop's own address, and refuses the loopback one", async () => {
    let redirect = "http://localhost:8787/connect/chatgpt";
    let { authorizeUrl, pending } = await pendingSignIn(redirect);
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(redirect);
    let params = { code: "c", state: pending.state, client_id: "issued" };
    expect(parseCallback(callbackUrl(params, redirect), pending)).toEqual(
        { code: "c", clientId: "issued" });
    expect(() => parseCallback(callbackUrl(params), pending)).toThrow("should start with");
  });

  it("refuses the callback of another sign-in", async () => {
    let { pending } = await pendingSignIn();
    expect(() => parseCallback(
        callbackUrl({ code: "c", state: "other", client_id: "issued" }), pending))
        .toThrow("different sign-in");
  });

  it("reports OpenAI's refusal", async () => {
    let { pending } = await pendingSignIn();
    expect(() => parseCallback(
        callbackUrl({ error: "access_denied", state: pending.state }), pending))
        .toThrow("access_denied");
  });

  it("refuses a callback missing the issued client ID", async () => {
    let { pending } = await pendingSignIn();
    expect(() => parseCallback(callbackUrl({ code: "c", state: pending.state }), pending))
        .toThrow("missing");
  });
});

describe("exchangeCode", () => {
  it("exchanges the code with the PKCE verifier, keeping the email for display", async () => {
    let { pending } = await pendingSignIn();
    let { fetchFn, requests } = tokenEndpoint({
      access_token: "access", refresh_token: "refresh", expires_in: 3600, scope: SCOPE,
      id_token: jwt({ nonce: pending.nonce, email: "me@example.com" }),
    });
    let before = Date.now();
    let credential = await exchangeCode({ code: "the-code", clientId: "issued" }, pending, fetchFn);
    expect(credential).toMatchObject({
      accessToken: "access", refreshToken: "refresh", clientId: "issued", email: "me@example.com",
    });
    // Due a few minutes before OpenAI's expiry.
    expect(credential.expiresAt.valueOf()).toBeGreaterThan(before + 3400_000);
    expect(credential.expiresAt.valueOf()).toBeLessThan(before + 3600_000);
    expect(Object.fromEntries(requests[0])).toEqual({
      grant_type: "authorization_code", client_id: "issued", code: "the-code",
      code_verifier: pending.verifier, redirect_uri: CHATGPT_REDIRECT_URI,
      resource: "https://api.openai.com/v1",
    });
  });

  it("exchanges with the redirect the sign-in started with", async () => {
    let { pending } = await pendingSignIn("http://localhost:8787/connect/chatgpt");
    let { fetchFn, requests } = tokenEndpoint({
      access_token: "access", refresh_token: "refresh", expires_in: 3600, scope: SCOPE,
      id_token: jwt({ nonce: pending.nonce }),
    });
    await exchangeCode({ code: "c", clientId: "issued" }, pending, fetchFn);
    expect(requests[0].get("redirect_uri")).toBe("http://localhost:8787/connect/chatgpt");
  });

  it("refuses an ID token issued for another sign-in", async () => {
    let { pending } = await pendingSignIn();
    let { fetchFn } = tokenEndpoint({
      access_token: "access", refresh_token: "refresh", expires_in: 3600, scope: SCOPE,
      id_token: jwt({ nonce: "another" }),
    });
    await expect(exchangeCode({ code: "c", clientId: "issued" }, pending, fetchFn))
        .rejects.toThrow("did not match");
  });

  it("refuses a grant without direct API access", async () => {
    let { pending } = await pendingSignIn();
    let { fetchFn } = tokenEndpoint({
      access_token: "access", refresh_token: "refresh", expires_in: 3600, scope: "openid email",
      id_token: jwt({ nonce: pending.nonce }),
    });
    await expect(exchangeCode({ code: "c", clientId: "issued" }, pending, fetchFn))
        .rejects.toThrow("access needed");
  });

  it("quotes OpenAI's OAuth error, and nothing else of the response", async () => {
    let { pending } = await pendingSignIn();
    let { fetchFn } = tokenEndpoint(
        { error: "invalid_request", error_description: "bad code", secret: "x" }, 400);
    let error = await exchangeCode({ code: "c", clientId: "issued" }, pending, fetchFn)
        .catch((e: Error) => e);
    expect((error as Error).message).toBe("ChatGPT sign-in failed (400 invalid_request): bad code");
  });
});

describe("refreshCredential", () => {
  const CREDENTIAL: ChatGptCredential = {
    accessToken: "old-access", refreshToken: "old-refresh", expiresAt: new Date(0),
    clientId: "issued", email: "me@example.com",
  };

  it("refreshes with the issued client ID, taking a rotated refresh token", async () => {
    let { fetchFn, requests } = tokenEndpoint({
      access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600, scope: SCOPE,
    });
    expect(await refreshCredential(CREDENTIAL, fetchFn)).toMatchObject({
      accessToken: "new-access", refreshToken: "new-refresh", clientId: "issued",
      email: "me@example.com",
    });
    expect(Object.fromEntries(requests[0])).toEqual({
      grant_type: "refresh_token", client_id: "issued", refresh_token: "old-refresh",
      resource: "https://api.openai.com/v1",
    });
  });

  it("keeps the refresh token when OpenAI does not rotate it", async () => {
    let { fetchFn } = tokenEndpoint({ access_token: "new-access", expires_in: 3600 });
    expect((await refreshCredential(CREDENTIAL, fetchFn)).refreshToken).toBe("old-refresh");
  });

  it("reports a revoked sign-in as such", async () => {
    let { fetchFn } = tokenEndpoint({ error: "invalid_grant" }, 400);
    await expect(refreshCredential(CREDENTIAL, fetchFn)).rejects.toBeInstanceOf(ChatGptGrantRevoked);
  });

  it("reports any other failure as a plain error", async () => {
    let { fetchFn } = tokenEndpoint({ error: "server_error" }, 503);
    let error = await refreshCredential(CREDENTIAL, fetchFn).catch((e: Error) => e);
    expect(error).not.toBeInstanceOf(ChatGptGrantRevoked);
    expect((error as Error).message).toContain("503");
  });
});
