import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CredentialCoordinator,
  CredentialsExpiredError,
  isCredentialsExpired,
} from "../src/credentials";
import { isNoAccessError } from "../src/http-errors";
import {
  createPkce,
  isInvalidGrant,
  mergeOAuthTokens,
  OAuthClient,
  type OAuthClientOptions,
  type OAuthGrant,
  OAuthResponseError,
  oauthRefresh,
  parseTokenResponse,
  pkceChallenge,
} from "../src/oauth-client";
import { ResponseTooLargeError } from "../src/response-body";
import { fakeKv } from "./fake-kv";

const TOKEN_URL = "https://vendor.example/oauth/token";
const REDIRECT_URI = "https://gatekeeper.example/oauth";
const BASE = {
  label: "Vendor",
  client: { method: "basic", id: "client", secret: "secret" },
  tokenEndpoint: TOKEN_URL,
  authorizationEndpoint: "https://vendor.example/oauth/authorize",
  revocationEndpoint: "https://vendor.example/oauth/revoke",
} satisfies OAuthClientOptions;

type Call = { url: string; init: RequestInit; headers: Headers; body: string };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  });
}

/** A fake provider endpoint recording every request it answers. */
function provider(respond: (call: Call) => Response | Promise<Response> = () =>
  json({ access_token: "at" })) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    const call = { url, init, headers: new Headers(init.headers), body: String(init.body) };
    calls.push(call);
    return respond(call);
  };
  return { calls, fetch };
}

function form(call: Call): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(call.body));
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected a rejection.");
}

async function responseError(promise: Promise<unknown>): Promise<OAuthResponseError> {
  const error = await rejection(promise);
  expect(error).toBeInstanceOf(OAuthResponseError);
  return error as OAuthResponseError;
}

/** A fetch that never answers, rejecting only when its signal aborts. */
function hanging(_: string, init: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
  });
}

function refreshFor(respond: (call: Call) => Response | Promise<Response>) {
  const { calls, fetch } = provider(respond);
  return { calls, client: new OAuthClient({ ...BASE, fetch }) };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("OAuthClient configuration", () => {
  it.each([
    ["http://vendor.example/token", /must use HTTPS/],
    ["https://user:pass@vendor.example/token", /credentials or a fragment/],
    ["https://vendor.example/token#frag", /credentials or a fragment/],
    ["https://vendor.example/token#", /credentials or a fragment/],
    ["/oauth/token", /absolute URL/],
  ])("rejects the endpoint %s", (tokenEndpoint, message) => {
    expect(() => new OAuthClient({ ...BASE, tokenEndpoint })).toThrow(message);
  });

  it("validates optional endpoints too", () => {
    expect(() => new OAuthClient({ ...BASE, revocationEndpoint: "http://vendor.example/revoke" }))
      .toThrow(/revocationEndpoint must use HTTPS/);
    expect(() => new OAuthClient({ ...BASE, authorizationEndpoint: "not a url" }))
      .toThrow(/authorizationEndpoint must be an absolute URL/);
  });

  it.each(["Authorization", "content-TYPE"])("rejects the reserved header %s", header => {
    expect(() => new OAuthClient({ ...BASE, headers: { [header]: "x" } }))
      .toThrow(`reserved key "${header.toLowerCase()}"`);
  });

  it.each([
    { timeoutMs: 0 },
    { maxResponseBytes: -1 },
    { defaultExpiresIn: 1.5 },
    { scopeSeparator: "" },
  ])("rejects %o", invalid => {
    expect(() => new OAuthClient({ ...BASE, ...invalid })).toThrow();
  });

  it("rejects a raw Basic client id containing a colon, which the server would split at", () => {
    expect(() => new OAuthClient({ ...BASE, client: { method: "basic", id: "app:1", secret: "s" } }))
      .toThrow(/may not contain ":"/);
  });

  it("keeps the endpoint's query string", async () => {
    const { calls, fetch } = provider();
    await new OAuthClient({ ...BASE, tokenEndpoint: `${TOKEN_URL}?tenant=a`, fetch })
      .exchangeCode({ code: "c", redirectUri: REDIRECT_URI });
    expect(calls[0].url).toBe(`${TOKEN_URL}?tenant=a`);
  });

  it("requires the endpoint a method uses", async () => {
    const client = new OAuthClient({ ...BASE, authorizationEndpoint: undefined,
      revocationEndpoint: undefined });
    expect(() => client.authorizationUrl({ redirectUri: REDIRECT_URI, state: "s" }))
      .toThrow("Vendor has no authorization endpoint configured.");
    await expect(client.revoke({ token: "t" }))
      .rejects.toThrow("Vendor has no revocation endpoint configured.");
  });
});

describe("OAuthClient request shape", () => {
  it("sends Basic credentials as the raw base64 of UTF-8 id:secret", async () => {
    const { calls, fetch } = provider();
    await new OAuthClient({ ...BASE, client: { method: "basic", id: "client", secret: "sëcret" },
      fetch }).exchangeCode({ code: "the-code", redirectUri: REDIRECT_URI, codeVerifier: "v" });

    const [{ url, init, headers }] = calls;
    expect(url).toBe(TOKEN_URL);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    expect(headers.get("Authorization")).toBe("Basic Y2xpZW50OnPDq2NyZXQ=");
    expect(headers.get("Accept")).toBe("application/json");
    expect(headers.get("Content-Type")).toBe("application/x-www-form-urlencoded");
    expect(form(calls[0])).toEqual({
      grant_type: "authorization_code",
      code: "the-code",
      redirect_uri: REDIRECT_URI,
      code_verifier: "v",
    });
  });

  it("form-encodes Basic credentials on request, and only inside the header", async () => {
    const { calls, fetch } = provider();
    const client = new OAuthClient({ ...BASE, fetch,
      client: { method: "basic", id: "app:1", secret: "a+b/c= ë", encoding: "form" } });
    await client.refresh({ refreshToken: "rt" });

    // What an RFC 6749 §2.3.1 server does: split at the first colon, then form-decode each half.
    const credentials = atob(calls[0].headers.get("Authorization")!.slice("Basic ".length));
    const [id, secret] = credentials.split(":").map(half => new URLSearchParams(`v=${half}`).get("v"));
    expect([id, secret]).toEqual(["app:1", "a+b/c= ë"]);
    expect(client.authorizationUrl({ redirectUri: REDIRECT_URI, state: "s" })
      .searchParams.get("client_id")).toBe("app:1");
  });

  it("sends post credentials in the body", async () => {
    const { calls, fetch } = provider();
    await new OAuthClient({ ...BASE, client: { method: "post", id: "client", secret: "secret" },
      fetch }).refresh({ refreshToken: "rt" });
    expect(calls[0].headers.has("Authorization")).toBe(false);
    expect(form(calls[0])).toEqual({
      grant_type: "refresh_token", refresh_token: "rt", client_id: "client", client_secret: "secret",
    });
  });

  it("sends only the client id for a public client", async () => {
    const { calls, fetch } = provider();
    await new OAuthClient({ ...BASE, client: { method: "none", id: "client" }, fetch })
      .refresh({ refreshToken: "rt" });
    expect(calls[0].headers.has("Authorization")).toBe(false);
    expect(form(calls[0])).toEqual({
      grant_type: "refresh_token", refresh_token: "rt", client_id: "client",
    });
  });

  it("encodes JSON bodies and forwards extra headers", async () => {
    const { calls, fetch } = provider();
    await new OAuthClient({ ...BASE, client: { method: "post", id: "client", secret: "secret" },
      bodyEncoding: "json", headers: { "Notion-Version": "2022-06-28" }, fetch })
      .exchangeCode({ code: "c", redirectUri: REDIRECT_URI, params: { owner: "user" } });
    expect(calls[0].headers.get("Content-Type")).toBe("application/json");
    expect(calls[0].headers.get("Notion-Version")).toBe("2022-06-28");
    expect(JSON.parse(calls[0].body)).toEqual({
      owner: "user",
      grant_type: "authorization_code",
      code: "c",
      redirect_uri: REDIRECT_URI,
      client_id: "client",
      client_secret: "secret",
    });
  });

  it("joins refresh scopes and omits an empty set", async () => {
    const { calls, fetch } = provider();
    const client = new OAuthClient({ ...BASE, scopeSeparator: ",", fetch });
    await client.refresh({ refreshToken: "rt", scopes: ["read", "write"] });
    await client.refresh({ refreshToken: "rt", scopes: [] });
    expect(form(calls[0]).scope).toBe("read,write");
    expect("scope" in form(calls[1])).toBe(false);
  });

  it("reports requested refresh scopes the response omits, and only those", async () => {
    let reported: string | undefined;
    const client = new OAuthClient({ ...BASE, fetch: provider(() =>
      json(reported === undefined ? { access_token: "at" } : { access_token: "at", scope: reported }),
    ).fetch });
    const requested = ["read"];

    const tokens = await client.refresh({ refreshToken: "rt", scopes: requested });
    expect(tokens.scopes).toEqual(["read"]);
    expect(tokens.scopes).not.toBe(requested);
    expect(tokens.raw).toEqual({ access_token: "at" });
    expect("scopes" in await client.refresh({ refreshToken: "rt" })).toBe(false);
    expect("scopes" in await client.refresh({ refreshToken: "rt", scopes: [] })).toBe(false);

    reported = "read write";
    expect((await client.refresh({ refreshToken: "rt", scopes: requested })).scopes)
      .toEqual(["read", "write"]);
  });

  it.each(["client_secret", "grant_type", "redirect_uri", "code_verifier", "scope"])(
    "rejects the reserved body parameter %s without a request", async key => {
      const { calls, fetch } = provider();
      const client = new OAuthClient({ ...BASE, fetch });
      await expect(client.exchangeCode({ code: "c", redirectUri: REDIRECT_URI,
        params: { [key]: "x" } })).rejects.toThrow(`reserved key "${key}"`);
      await expect(client.revoke({ token: "t", params: { [key]: "x" } }))
        .rejects.toThrow(`reserved key "${key}"`);
      expect(calls).toHaveLength(0);
    });

  it("leaves request() unreserved and skips the access-token check", async () => {
    const { calls, fetch } = provider(() => json({ authed_user: { access_token: "user" } }));
    const body = await new OAuthClient({ ...BASE, fetch })
      .request("token", { code: "c", scope: "chat:write" });
    expect(body).toEqual({ authed_user: { access_token: "user" } });
    expect(form(calls[0])).toEqual({ code: "c", scope: "chat:write" });
    expect(calls[0].headers.get("Authorization")).toMatch(/^Basic /);
  });

  it("calls fetch detached and reads the global at request time", async () => {
    const fetch = vi.fn(async () => json({ access_token: "at" }));
    await new OAuthClient({ ...BASE, fetch }).refresh({ refreshToken: "rt" });
    expect(fetch.mock.contexts).toEqual([undefined]);

    const global = new OAuthClient(BASE);
    const stubbed = provider();
    vi.stubGlobal("fetch", stubbed.fetch);
    await global.refresh({ refreshToken: "rt" });
    expect(stubbed.calls).toHaveLength(1);
  });
});

describe("PKCE", () => {
  it("creates an S256 pair from 32 bytes by default", async () => {
    const pkce = await createPkce();
    expect(pkce.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pkce.codeChallenge).toBe(await pkceChallenge(pkce.codeVerifier));
    expect(pkce.codeChallengeMethod).toBe("S256");
    expect((await createPkce()).codeVerifier).not.toBe(pkce.codeVerifier);
  });

  it("bounds the verifier at 32 to 96 bytes", async () => {
    expect((await createPkce({ verifierBytes: 96 })).codeVerifier).toHaveLength(128);
    for (const verifierBytes of [31, 97, 32.5]) {
      await expect(createPkce({ verifierBytes })).rejects.toThrow(/32 to 96/);
    }
  });

  it("matches the RFC 7636 Appendix B vector", async () => {
    expect(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"))
      .toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it.each(["a".repeat(42), "a".repeat(129), `${"a".repeat(42)}+`])(
    "rejects the verifier %s", async verifier => {
      await expect(pkceChallenge(verifier)).rejects.toThrow(/43 to 128/);
    });
});

describe("authorizationUrl", () => {
  it("keeps the endpoint query and sets the owned parameters", () => {
    const url = new OAuthClient({ ...BASE,
      authorizationEndpoint: "https://vendor.example/oauth/authorize?tenant=a" })
      .authorizationUrl({ redirectUri: REDIRECT_URI, state: "st", scopes: ["read", "write"],
        codeChallenge: "ch", params: { prompt: "consent" } });
    expect(url.origin + url.pathname).toBe("https://vendor.example/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      tenant: "a",
      prompt: "consent",
      response_type: "code",
      client_id: "client",
      redirect_uri: REDIRECT_URI,
      state: "st",
      scope: "read write",
      code_challenge: "ch",
      code_challenge_method: "S256",
    });
  });

  it("uses the scope separator and omits absent scopes and challenge", () => {
    const client = new OAuthClient({ ...BASE, scopeSeparator: "," });
    expect(client.authorizationUrl({ redirectUri: REDIRECT_URI, state: "s", scopes: ["a", "b"] })
      .searchParams.get("scope")).toBe("a,b");
    const bare = client.authorizationUrl({ redirectUri: REDIRECT_URI, state: "s", scopes: [] });
    expect([...bare.searchParams.keys()])
      .toEqual(["response_type", "client_id", "redirect_uri", "state"]);
  });

  it.each(["state", "client_id", "code_challenge_method"])("rejects the reserved %s", key => {
    expect(() => new OAuthClient(BASE).authorizationUrl({ redirectUri: REDIRECT_URI, state: "s",
      params: { [key]: "x" } })).toThrow(`reserved key "${key}"`);
  });
});

describe("parseTokenResponse", () => {
  const requestedAt = 1_000_000;

  it.each<[string, unknown, number | undefined, number | undefined]>([
    ["a number", 3600, undefined, requestedAt + 3_600_000],
    ["a numeric string", "3600", undefined, requestedAt + 3_600_000],
    ["absent", undefined, undefined, undefined],
    ["absent with a default", undefined, 600, requestedAt + 600_000],
    ["zero", 0, undefined, undefined],
    ["zero with a default", 0, 600, requestedAt + 600_000],
    ["negative", -5, undefined, undefined],
    ["garbage", "soon", 600, requestedAt + 600_000],
    ["an exponent string", "1e3", undefined, undefined],
    ["overflowing in milliseconds", 1e308, 600, requestedAt + 600_000],
  ])("reads expires_in as %s", (_, expires_in, defaultExpiresIn, expiresAt) => {
    const tokens = parseTokenResponse({ access_token: "at", expires_in },
      { requestedAt, defaultExpiresIn });
    expect(tokens.expiresAt).toBe(expiresAt);
    expect("expiresAt" in tokens).toBe(expiresAt !== undefined);
  });

  it("keeps absent scopes absent and splits present ones", () => {
    expect("scopes" in parseTokenResponse({ access_token: "at" }, { requestedAt })).toBe(false);
    expect(parseTokenResponse({ access_token: "at", scope: " read  write " }, { requestedAt })
      .scopes).toEqual(["read", "write"]);
    expect(parseTokenResponse({ access_token: "at", scope: "" }, { requestedAt }).scopes)
      .toEqual([]);
    expect(parseTokenResponse({ access_token: "at", scope: "a,b" },
      { requestedAt, scopeSeparator: "," }).scopes).toEqual(["a", "b"]);
  });

  it("picks the standard fields and keeps the whole body as raw", () => {
    const body = { access_token: "at", token_type: "bearer", refresh_token: "rt",
      id_token: "id", instance_url: "https://x.example" };
    expect(parseTokenResponse(body, { requestedAt })).toEqual({
      accessToken: "at", tokenType: "bearer", refreshToken: "rt", idToken: "id", raw: body,
    });
    expect("refreshToken" in parseTokenResponse({ access_token: "at", refresh_token: "" },
      { requestedAt })).toBe(false);
  });

  it("requires an access token", () => {
    expect(() => parseTokenResponse({ token_type: "bearer" }, { requestedAt }))
      .toThrow(/no access_token/);
  });

  it("anchors expiresAt at the request's start", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(requestedAt);
    const { fetch } = provider(() => {
      vi.setSystemTime(requestedAt + 5_000);
      return json({ access_token: "at", expires_in: 60 });
    });
    const tokens = await new OAuthClient({ ...BASE, fetch }).refresh({ refreshToken: "rt" });
    expect(tokens.expiresAt).toBe(requestedAt + 60_000);
  });

  it("applies the client's default lifetime", async () => {
    const { fetch } = provider(() => json({ access_token: "at" }));
    const before = Date.now();
    const tokens = await new OAuthClient({ ...BASE, defaultExpiresIn: 3600, fetch })
      .refresh({ refreshToken: "rt" });
    expect(tokens.expiresAt).toBeGreaterThanOrEqual(before + 3_600_000);
  });
});

describe("OAuthResponseError", () => {
  const failing = (response: () => Response) =>
    new OAuthClient({ ...BASE, fetch: async () => response() });

  it.each<[string, () => Response, boolean]>([
    ["a 400 invalid_grant", () => json({ error: "invalid_grant" }, 400), true],
    ["a 401 invalid_client", () => json({ error: "invalid_client" }, 401), false],
    ["a 503 invalid_grant", () => json({ error: "invalid_grant" }, 503), false],
    ["a 429 invalid_grant", () => json({ error: "invalid_grant" }, 429), false],
    ["a 400 without a body", () => new Response(null, { status: 400 }), false],
  ])("classifies %s", async (_, response, grantDeath) => {
    const error = await responseError(failing(response).refresh({ refreshToken: "rt" }));
    expect(isInvalidGrant(error)).toBe(grantDeath);
  });

  it("carries the status and a validated code", async () => {
    const error = await responseError(failing(() => json({ error: "invalid_grant" }, 400))
      .refresh({ refreshToken: "rt" }));
    expect(error.name).toBe("OAuthResponseError");
    expect(error.httpStatus).toBe(400);
    expect(error.oauthError).toBe("invalid_grant");
    expect(error.message).toBe("Vendor rejected the OAuth request (HTTP 400, invalid_grant).");
  });

  it.each([
    ["no access token", {}],
    ["an empty access token", { access_token: "" }],
    ["a null access token", { access_token: null }],
  ])("detects an error-bearing 2xx with %s", async (_, token) => {
    const error = await responseError(failing(() => json({ error: "bad_verification_code", ...token }))
      .exchangeCode({ code: "c", redirectUri: REDIRECT_URI }));
    expect(error.httpStatus).toBe(200);
    expect(error.oauthError).toBe("bad_verification_code");
    expect(isInvalidGrant(error)).toBe(false);
  });

  it.each<[string, () => Response]>([
    ["a missing access token", () => json({ token_type: "bearer" })],
    ["an empty access token", () => json({ access_token: "" })],
    ["a non-JSON body", () => new Response("<html>ok</html>")],
    ["a JSON array", () => json([{ access_token: "at" }])],
  ])("treats %s as malformed, never grant death", async (_, response) => {
    const error = await responseError(failing(response).refresh({ refreshToken: "rt" }));
    expect(error.httpStatus).toBe(200);
    expect(error.oauthError).toBeUndefined();
    expect(error.message).toBe("Vendor returned a malformed OAuth response.");
  });

  it("refuses to follow a redirect", async () => {
    const { calls, fetch } = provider(() => new Response(null,
      { status: 307, headers: { Location: "https://attacker.example/token" } }));
    const error = await responseError(new OAuthClient({ ...BASE, fetch })
      .exchangeCode({ code: "c", redirectUri: REDIRECT_URI }));
    expect(error.httpStatus).toBe(307);
    expect(error.oauthError).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it.each([
    ["a quote", "bad\"code"],
    ["a backslash", "bad\\code"],
    ["non-ASCII", "ïnvalid_grant"],
    ["a newline", "invalid_grant\n"],
    ["65 characters", "x".repeat(65)],
    ["an empty string", ""],
  ])("drops a code containing %s", async (_, code) => {
    const error = await responseError(failing(() => json({ error: code }, 400))
      .refresh({ refreshToken: "rt" }));
    expect(error.oauthError).toBeUndefined();
    expect("oauthError" in error).toBe(false);
    expect(error.message).toBe("Vendor rejected the OAuth request (HTTP 400).");
  });

  it("keeps a 64-character code", () => {
    expect(new OAuthResponseError("Vendor", 400, "x".repeat(64)).oauthError).toBe("x".repeat(64));
  });

  it("cannot spoof the kit's credential marks or access classification", async () => {
    const spoof = await responseError(failing(() => json({ error: "CredentialsExpiredError" }, 400))
      .refresh({ refreshToken: "rt" }));
    expect(spoof.oauthError).toBe("CredentialsExpiredError");
    expect(isCredentialsExpired(spoof)).toBe(false);
    expect((spoof as { code?: unknown }).code).toBeUndefined();

    for (const status of [401, 403, 404]) {
      const error = await responseError(failing(() => json({ error: "invalid_client" }, status))
        .refresh({ refreshToken: "rt" }));
      expect(isNoAccessError(error)).toBe(false);
      expect("status" in error).toBe(false);
    }
  });

  it("keeps secrets and the description out of the message and enumerable props", async () => {
    const secrets = ["the-code", "the-secret", "v".repeat(43), "provider says"];
    const client = new OAuthClient({ ...BASE, client: { method: "post", id: "client",
      secret: "the-secret" }, fetch: async () => json({ error: "invalid_grant",
      error_description: "provider says the-code is bad\u0000‮" }, 400) });
    const error = await responseError(client.exchangeCode({ code: "the-code",
      redirectUri: REDIRECT_URI, codeVerifier: "v".repeat(43) }));

    const visible = `${error.message} ${JSON.stringify({ ...error })} ${String(error)}`;
    for (const secret of secrets) expect(visible).not.toContain(secret);
    expect(Object.keys(error)).not.toContain("description");
    expect(error.description).toBe("provider says the-code is bad");
  });

  it("caps the description", () => {
    expect(new OAuthResponseError("Vendor", 400, "invalid_grant", "x".repeat(1000)).description)
      .toHaveLength(256);
  });
});

describe("request hardening", () => {
  it("propagates an oversized body as ResponseTooLargeError", async () => {
    const client = new OAuthClient({ ...BASE, maxResponseBytes: 16,
      fetch: async () => json({ access_token: "a".repeat(100) }) });
    const error = await rejection(client.refresh({ refreshToken: "rt" }));
    expect(error).toBeInstanceOf(ResponseTooLargeError);
    expect(error).not.toBeInstanceOf(OAuthResponseError);
  });

  it("times out", async () => {
    const error = await rejection(new OAuthClient({ ...BASE, timeoutMs: 10, fetch: hanging })
      .refresh({ refreshToken: "rt" }));
    expect((error as Error).name).toBe("TimeoutError");
  });

  it("times out a revoke", async () => {
    const error = await rejection(new OAuthClient({ ...BASE, timeoutMs: 10, fetch: hanging })
      .revoke({ token: "rt" }));
    expect((error as Error).name).toBe("TimeoutError");
  });

  it("propagates the caller's abort reason as the same instance", async () => {
    const controller = new AbortController();
    const reason = new Error("stop");
    const pending = new OAuthClient({ ...BASE, fetch: hanging })
      .refresh({ refreshToken: "rt", signal: controller.signal });
    controller.abort(reason);
    expect(await rejection(pending)).toBe(reason);
  });

  it("propagates a network error as the same instance", async () => {
    const failure = new TypeError("fetch failed");
    const client = new OAuthClient({ ...BASE, fetch: () => Promise.reject(failure) });
    expect(await rejection(client.exchangeCode({ code: "c", redirectUri: REDIRECT_URI })))
      .toBe(failure);
  });
});

describe("revoke", () => {
  it("posts an RFC 7009 request and accepts an empty 200", async () => {
    const { calls, fetch } = provider(() => new Response(null, { status: 200 }));
    await expect(new OAuthClient({ ...BASE, fetch })
      .revoke({ token: "rt", tokenTypeHint: "refresh_token" })).resolves.toBeUndefined();
    expect(calls[0].url).toBe("https://vendor.example/oauth/revoke");
    expect(calls[0].headers.get("Authorization")).toMatch(/^Basic /);
    expect(form(calls[0])).toEqual({ token: "rt", token_type_hint: "refresh_token" });
  });

  it("accepts a non-JSON 200", async () => {
    await expect(new OAuthClient({ ...BASE, fetch: async () => new Response("revoked") })
      .revoke({ token: "rt" })).resolves.toBeUndefined();
  });

  it.each<[string, () => Response, string | undefined]>([
    ["a 503", () => new Response("down", { status: 503 }), undefined],
    ["a 400 unsupported_token_type", () => json({ error: "unsupported_token_type" }, 400),
      "unsupported_token_type"],
  ])("rejects %s", async (_, response, oauthError) => {
    const error = await responseError(new OAuthClient({ ...BASE, fetch: async () => response() })
      .revoke({ token: "rt" }));
    expect(error.oauthError).toBe(oauthError);
  });
});

type Grant = OAuthGrant & { accountId: string };

describe("mergeOAuthTokens", () => {
  const current: Grant = { accountId: "a", accessToken: "old", refreshToken: "rt1",
    scopes: ["read"], expiresAt: 5 };

  it("keeps an unrotated refresh token and unreported scopes, never spreading tokens", () => {
    expect(mergeOAuthTokens(current, { accessToken: "new", expiresAt: 10, tokenType: "bearer",
      idToken: "id", raw: { access_token: "new" } }))
      .toEqual({ accountId: "a", accessToken: "new", refreshToken: "rt1", scopes: ["read"],
        expiresAt: 10 });
  });

  it("stores a rotated refresh token and reported scopes", () => {
    expect(mergeOAuthTokens(current, { accessToken: "new", refreshToken: "rt2",
      scopes: ["read", "write"], raw: {} }))
      .toEqual({ accountId: "a", accessToken: "new", refreshToken: "rt2",
        scopes: ["read", "write"] });
  });

  it("removes a stale expiresAt the response does not replace", () => {
    expect("expiresAt" in mergeOAuthTokens(current, { accessToken: "new", raw: {} })).toBe(false);
  });
});

function expired(overrides: Partial<Grant> = {}): Grant {
  return { accountId: "a", accessToken: "old", refreshToken: "rt1", scopes: ["read"],
    expiresAt: Date.now() - 1, ...overrides };
}

describe("oauthRefresh with CredentialCoordinator", () => {
  function coordinated(respond: (call: Call) => Response | Promise<Response>,
    options: { isGrantDeath?: (error: OAuthResponseError) => boolean } = {}) {
    const { calls, client } = refreshFor(respond);
    const creds = new CredentialCoordinator<Grant>(fakeKv(), { expiresAt: g => g.expiresAt });
    const refresh = oauthRefresh<Grant>(client, {
      refreshToken: g => g.refreshToken,
      merge: mergeOAuthTokens,
      expiredMessage: "Reconnect your Vendor account.",
      ...options,
    });
    return { calls, creds, refresh };
  }

  it("merges the refresh and does not refresh again", async () => {
    const { calls, creds, refresh } = coordinated(() => json({ access_token: "new",
      expires_in: 3600 }));
    creds.connect(expired());
    const before = Date.now();

    const grant = await creds.fresh(refresh);
    expect(grant).toMatchObject({ accountId: "a", accessToken: "new", refreshToken: "rt1",
      scopes: ["read"] });
    expect(grant.expiresAt).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(creds.stored()).toEqual(grant);
    expect(form(calls[0])).toEqual({ grant_type: "refresh_token", refresh_token: "rt1" });

    await creds.fresh(refresh);
    expect(calls).toHaveLength(1);
  });

  it("stores a rotated refresh token", async () => {
    const { creds, refresh } = coordinated(() => json({ access_token: "new",
      refresh_token: "rt2", scope: "read write", expires_in: 3600 }));
    creds.connect(expired());
    expect(await creds.fresh(refresh))
      .toMatchObject({ refreshToken: "rt2", scopes: ["read", "write"] });
  });

  it("does not hot-loop when the response omits the lifetime", async () => {
    const { calls, creds, refresh } = coordinated(() => json({ access_token: "new" }));
    creds.connect(expired());
    await creds.fresh(refresh);
    await creds.fresh(refresh);
    expect(calls).toHaveLength(1);
    expect("expiresAt" in creds.stored()!).toBe(false);
  });

  it("marks invalid_grant as death with the provider error as cause", async () => {
    const { calls, creds, refresh } = coordinated(() => json({ error: "invalid_grant" }, 400));
    creds.connect(expired());

    const error = await rejection(creds.fresh(refresh));
    expect(error).toBeInstanceOf(CredentialsExpiredError);
    expect((error as Error).message).toBe("Reconnect your Vendor account.");
    expect((error as Error).cause).toBeInstanceOf(OAuthResponseError);
    expect(((error as Error).cause as OAuthResponseError).oauthError).toBe("invalid_grant");

    expect(isCredentialsExpired(await rejection(creds.fresh(refresh)))).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("lets isGrantDeath widen the default", async () => {
    const { creds, refresh } = coordinated(() => json({ error: "invalid_client" }, 401),
      { isGrantDeath: error => isInvalidGrant(error) || error.oauthError === "invalid_client" });
    creds.connect(expired());
    expect(isCredentialsExpired(await rejection(creds.fresh(refresh)))).toBe(true);
  });

  it("rethrows a transient failure unchanged and keeps the grant live", async () => {
    const { calls, creds, refresh } = coordinated(() => json({ error: "invalid_grant" }, 503));
    creds.connect(expired());

    const error = await responseError(creds.fresh(refresh));
    expect(error.httpStatus).toBe(503);
    expect(isCredentialsExpired(error)).toBe(false);
    await rejection(creds.fresh(refresh));
    expect(calls).toHaveLength(2);
  });

  it("rethrows a network error as the same instance", async () => {
    const failure = new TypeError("fetch failed");
    const { creds, refresh } = coordinated(() => Promise.reject(failure));
    creds.connect(expired());
    expect(await rejection(creds.fresh(refresh))).toBe(failure);
  });

  it("expires a grant with no refresh token without a request", async () => {
    const { calls, creds, refresh } = coordinated(() => json({ access_token: "new" }));
    creds.connect(expired({ refreshToken: undefined }));
    const error = await rejection(creds.fresh(refresh));
    expect(error).toBeInstanceOf(CredentialsExpiredError);
    expect(calls).toHaveLength(0);
  });

  it("adds per-refresh scopes and parameters", async () => {
    const { calls, client } = refreshFor(() => json({ access_token: "new" }));
    const refresh = oauthRefresh<Grant>(client, {
      refreshToken: g => g.refreshToken,
      merge: mergeOAuthTokens,
      request: g => ({ scopes: g.scopes, params: { resource: "https://api.example" } }),
      expiredMessage: "Reconnect.",
    });
    await refresh(expired());
    expect(form(calls[0])).toEqual({ resource: "https://api.example", grant_type: "refresh_token",
      refresh_token: "rt1", scope: "read" });
  });

  it("records a narrowing the response does not restate", async () => {
    const { client } = refreshFor(() => json({ access_token: "new" }));
    const refresh = oauthRefresh<Grant>(client, {
      refreshToken: g => g.refreshToken,
      merge: mergeOAuthTokens,
      request: () => ({ scopes: ["read"] }),
      expiredMessage: "Reconnect.",
    });
    expect((await refresh(expired({ scopes: ["read", "write"] }))).scopes).toEqual(["read"]);
  });
});
