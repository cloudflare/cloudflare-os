import { env } from "cloudflare:workers";
import {
  COMMON_SLOTS, SUBSERVICE_V1_SLOTS, type BlobSlot, type DoubleSlot,
} from "@gadgets/observability/metrics";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { defineUpstream, type UpstreamFetch } from "../src/upstream";
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

// The client the two paths are compared with. Nothing of PRIVATE may reach a metric.
const COUNTED = {
  ...BASE,
  client: { method: "basic", id: "client-1", secret: "s3cret-value" },
  headers: { "User-Agent": "kit-suite" },
} satisfies OAuthClientOptions;
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const PRIVATE = [
  "client-1", "s3cret-value", "the-code", "the-verifier", "the-refresh-token", "vendor.example",
  "device_code", "Basic", "kit-suite",
];
// The reason the caller of an aborted request aborts with.
const STOP = new Error("stop");

// What one call of `fetch` was handed, the signal aside.
type Handed = {
  input: unknown;
  keys: string[];
  method: string | undefined;
  redirect: string | undefined;
  headers: [string, string][];
  body: string;
  form: boolean;
  signalled: boolean;
};

/** A fake endpoint recording what `fetch` is handed, answered by `respond`. */
function endpoint(respond: (init: RequestInit) => Response | Promise<Response>) {
  const handed: Handed[] = [];
  const fetch: UpstreamFetch = async (input, init = {}) => {
    handed.push({
      input,
      keys: Object.keys(init).toSorted(),
      method: init.method,
      redirect: init.redirect,
      headers: [...new Headers(init.headers)],
      body: String(init.body),
      form: init.body instanceof URLSearchParams,
      signalled: init.signal instanceof AbortSignal,
    });
    return respond(init);
  };
  return { handed, fetch };
}

/** An answer that never comes: it fails with the reason of the request's signal once that aborts. */
function unanswered(init: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const { signal } = init;
    if (!signal) return reject(new Error("The request was handed no signal."));
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason));
  });
}

/** A 200 whose body never ends: it fails with the reason of the request's signal once that aborts. */
function stalled(init: RequestInit): Response {
  const { signal } = init;
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      signal?.addEventListener("abort", () => controller.error(signal.reason));
    },
  }));
}

type Settled = { returned: unknown } | { threw: unknown };

/** What a call returned or threw, an error being what its caller can tell of it. */
function told(settled: Settled): Settled {
  if ("returned" in settled) return settled;
  const { threw } = settled;
  if (threw === STOP) return { threw: "the caller's reason itself" };
  if (threw instanceof OAuthResponseError) {
    return { threw: {
      type: "OAuthResponseError", message: threw.message, httpStatus: threw.httpStatus,
      oauthError: threw.oauthError, description: threw.description,
    } };
  }
  if (threw instanceof Error) {
    return { threw: { type: threw.constructor.name, name: threw.name, message: threw.message } };
  }
  return settled;
}

// One call of the client, with its caller's signal.
type Run = (client: OAuthClient, signal: AbortSignal) => Promise<unknown>;

function tokenRequest(grantType?: string): Run {
  const params = { code: "the-code", ...(grantType === undefined ? {} : { grant_type: grantType }) };
  return (client, signal) => client.request("token", params, { signal });
}

// Each call, the operation it is counted as, and whether its method requires an access token.
const CALLS: [call: string, operation: string, tokenRequired: boolean, run: Run][] = [
  ["exchangeCode", "token.exchange", true, (client, signal) => client.exchangeCode({
    code: "the-code", redirectUri: REDIRECT_URI, codeVerifier: "the-verifier", signal })],
  ["refresh", "token.refresh", true, (client, signal) => client.refresh({
    refreshToken: "the-refresh-token", scopes: ["read"], signal })],
  ["revoke", "token.revoke", false, (client, signal) => client.revoke({
    token: "the-refresh-token", tokenTypeHint: "refresh_token", signal })],
  ['request("token") for authorization_code', "token.exchange", false,
    tokenRequest("authorization_code")],
  ['request("token") for refresh_token', "token.refresh", false, tokenRequest("refresh_token")],
  ['request("token") for client_credentials', "token.client", false,
    tokenRequest("client_credentials")],
  ['request("token") for a grant type outside the table', "token.request", false,
    tokenRequest(DEVICE_GRANT)],
  ['request("token") for the grant type "constructor"', "token.request", false,
    tokenRequest("constructor")],
  ['request("token") with no grant type', "token.request", false, tokenRequest()],
  ['request("revocation")', "token.revoke", false, (client, signal) =>
    client.request("revocation", { token: "the-refresh-token" }, { signal })],
  ['request("revocation") with a grant type of the table', "token.revoke", false, (client, signal) =>
    client.request("revocation", { token: "the-refresh-token", grant_type: "authorization_code" },
      { signal })],
];

// A point's outcome, reason and HTTP status.
type Counted = [outcome: string, reason: string, httpStatus: number];

// What an endpoint does with a request, and what that makes of a call: the error it throws
// (none: it returns) and the point an upstream counts it as (none: it is not counted).
type Scenario = {
  name: string;
  options?: Pick<OAuthClientOptions, "timeoutMs" | "maxResponseBytes">;
  respond: (init: RequestInit, abort: () => void) => Response | Promise<Response>;
  expected: (tokenRequired: boolean) => { threw?: unknown; counted?: Counted };
};

function rejected(httpStatus: number, oauthError?: string, description?: string) {
  const malformed = oauthError === undefined && httpStatus === 200;
  return {
    type: "OAuthResponseError",
    message: malformed
      ? "Vendor returned a malformed OAuth response."
      : `Vendor rejected the OAuth request (HTTP ${httpStatus}${oauthError ? `, ${oauthError}` : ""}).`,
    httpStatus, oauthError, description,
  };
}

const SCENARIOS: Scenario[] = [
  {
    name: "with tokens",
    respond: () => json({ access_token: "at", token_type: "bearer", refresh_token: "rt2",
      expires_in: 3600, scope: "read write" }),
    expected: () => ({ counted: ["success", "", 200] }),
  },
  {
    name: "with a 400 and an OAuth error",
    respond: () => json({ error: "invalid_grant", error_description: "expired" }, 400),
    expected: () => ({
      threw: rejected(400, "invalid_grant", "expired"), counted: ["error", "http", 400] }),
  },
  {
    name: "with a 429",
    respond: () => json({ error: "slow_down" }, 429),
    expected: () => ({ threw: rejected(429, "slow_down"), counted: ["refused", "rate", 429] }),
  },
  {
    name: "with a 200 carrying an error",
    respond: () => json({ error: "bad_verification_code" }),
    expected: () => ({
      threw: rejected(200, "bad_verification_code"), counted: ["error", "api", 200] }),
  },
  {
    name: "with a 200 and no access token",
    respond: () => json({ token_type: "bearer" }),
    expected: tokenRequired => tokenRequired
      ? { threw: rejected(200), counted: ["error", "api", 200] }
      : { counted: ["success", "", 200] },
  },
  {
    name: "with a redirect",
    respond: () => new Response(null,
      { status: 307, headers: { Location: "https://attacker.example/token" } }),
    expected: () => ({ threw: rejected(307), counted: ["error", "http", 307] }),
  },
  {
    name: "with an oversized body",
    options: { maxResponseBytes: 16 },
    respond: () => json({ access_token: "a".repeat(100) }),
    expected: () => ({
      threw: { type: "ResponseTooLargeError", name: "Error",
        message: "The server's response exceeded 16 bytes." },
      counted: ["error", "parse", 200],
    }),
  },
  {
    name: "by nothing before its timeout",
    options: { timeoutMs: 10 },
    respond: unanswered,
    expected: () => ({
      threw: expect.objectContaining({ name: "TimeoutError" }), counted: ["error", "timeout", 0] }),
  },
  {
    name: "with a body its timeout cuts off",
    options: { timeoutMs: 10 },
    respond: stalled,
    expected: () => ({
      threw: expect.objectContaining({ name: "TimeoutError" }), counted: ["error", "timeout", 200] }),
  },
  {
    name: "with a body its caller's abort cuts off",
    respond: (init, abort) => {
      setTimeout(abort, 1);
      return stalled(init);
    },
    expected: () => ({ threw: "the caller's reason itself" }),
  },
  {
    name: "by nothing before its caller aborts",
    respond: (init, abort) => {
      const pending = unanswered(init);
      abort();
      return pending;
    },
    expected: () => ({ threw: "the caller's reason itself" }),
  },
];

/** Runs one call on a client built over a fake endpoint's `fetch`. */
async function attempt(
  client: (fetch: UpstreamFetch) => OAuthClient, respond: Scenario["respond"], run: Run,
): Promise<{ handed: Handed[]; settled: Settled }> {
  const controller = new AbortController();
  const { handed, fetch } = endpoint(init => respond(init, () => controller.abort(STOP)));
  const settled = await run(client(fetch), controller.signal).then(
    (returned): Settled => ({ returned }), (threw): Settled => ({ threw }));
  return { handed, settled };
}

/** A written point's value in one column. */
function column(point: AnalyticsEngineDataPoint, slot: BlobSlot | DoubleSlot) {
  const values = slot.startsWith("blob") ? point.blobs : point.doubles;
  return values?.[Number(slot.replace(/\D+/, "")) - 1];
}

/** Tokens answered after 30 ms, unless the signal the request was handed aborts first. */
function slow(init: RequestInit): Promise<Response> {
  return Promise.race([
    unanswered(init),
    new Promise<Response>(resolve => setTimeout(() => resolve(json({ access_token: "at" })), 30)),
  ]);
}

// Other ways a client authenticates and encodes its body than `COUNTED`'s.
const SECRET_IN_BODY = { method: "post", id: "client-1", secret: "s3cret-value" } as const;
const CLIENTS: [name: string, options: Pick<OAuthClientOptions, "client" | "bodyEncoding">][] = [
  ["form-encoded basic credentials",
    { client: { method: "basic", id: "client-1", secret: "s3cret+/=value", encoding: "form" } }],
  ["its secret in the body", { client: SECRET_IN_BODY }],
  ["no secret", { client: { method: "none", id: "client-1" } }],
  ["a JSON body", { client: COUNTED.client, bodyEncoding: "json" }],
  ["its secret in a JSON body", { client: SECRET_IN_BODY, bodyEncoding: "json" }],
];

/** Answers with tokens. */
function withTokens(): Response {
  return json({ access_token: "at", refresh_token: "rt2", expires_in: 3600 });
}

/** A module factory for a module that `oauth-client` may not load. */
function refused(module: string) {
  return () => {
    throw new Error(`oauth-client loaded ${module}`);
  };
}

describe("OAuthClient through an upstream", () => {
  const ambient = env as { METRICS?: AnalyticsEngineDataset; SUBSERVICE_METRICS?: string };
  let points: AnalyticsEngineDataPoint[];

  beforeEach(() => {
    points = [];
    ambient.METRICS = { writeDataPoint: point => { if (point) points.push(point); } };
    ambient.SUBSERVICE_METRICS = "true";
    // One instant for both paths, so that the expiry of the tokens they return is the same.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
  });

  afterEach(() => {
    delete ambient.METRICS;
    delete ambient.SUBSERVICE_METRICS;
    vi.useRealTimers();
    vi.doUnmock("../src/upstream");
    vi.doUnmock("node:async_hooks");
    vi.doUnmock("cloudflare:workers");
    vi.resetModules();
  });

  // Each point written, as its source, service, operation, outcome, reason and HTTP status.
  function written() {
    return points.map(point => [
      SUBSERVICE_V1_SLOTS.source, SUBSERVICE_V1_SLOTS.service, SUBSERVICE_V1_SLOTS.operation,
      COMMON_SLOTS.outcome, SUBSERVICE_V1_SLOTS.reason, SUBSERVICE_V1_SLOTS.httpStatus,
    ].map(slot => column(point, slot)));
  }

  describe.each(SCENARIOS)("answered $name", ({ options, respond, expected }) => {
    it.each(CALLS)("%s hands fetch the same request, settles the same, and is counted as %s",
      async (_, operation, tokenRequired, run) => {
        const { threw, counted } = expected(tokenRequired);

        const plain = await attempt(
          fetch => new OAuthClient({ ...COUNTED, ...options, fetch }), respond, run);
        expect(points).toEqual([]);
        const through = await attempt(fetch => new OAuthClient({
          ...COUNTED, ...options, upstream: defineUpstream({ vendorId: "vendor", fetch }),
        }), respond, run);

        expect(plain.handed).toHaveLength(1);
        expect(plain.handed[0]).toMatchObject({
          method: "POST", redirect: "manual", signalled: true,
          keys: ["body", "headers", "method", "redirect", "signal"],
        });
        expect(through.handed).toEqual(plain.handed);

        expect(Object.keys(plain.settled)).toEqual([threw === undefined ? "returned" : "threw"]);
        if (threw !== undefined) expect(told(plain.settled)).toEqual({ threw });
        expect(told(through.settled)).toEqual(told(plain.settled));

        expect(written()).toEqual(counted === undefined
          ? [] : [["gatekeeper.vendor.api", "vendor", operation, ...counted]]);
        for (const secret of PRIVATE) expect(JSON.stringify(points)).not.toContain(secret);
      });
  });

  describe.each(CLIENTS)("of a client with %s", (_name, options) => {
    it.each(CALLS)("%s hands fetch the same request and returns the same", async (_, operation, __, run) => {
      const plain = await attempt(
        fetch => new OAuthClient({ ...COUNTED, ...options, fetch }), withTokens, run);
      const through = await attempt(fetch => new OAuthClient({
        ...COUNTED, ...options, upstream: defineUpstream({ vendorId: "vendor", fetch }),
      }), withTokens, run);

      expect(plain.handed).toHaveLength(1);
      // The request is this client's own, and not that of the client the table above runs on.
      expect(plain.handed[0].form).toBe(options.bodyEncoding !== "json");
      expect(plain.handed[0].headers.some(([name]) => name === "authorization"))
        .toBe(options.client.method === "basic");
      expect(plain.handed[0].body.includes("s3cret-value")).toBe(options.client.method === "post");
      expect(through.handed).toEqual(plain.handed);
      expect(Object.keys(plain.settled)).toEqual(["returned"]);
      expect(through.settled).toEqual(plain.settled);
      expect(written()).toEqual([["gatekeeper.vendor.api", "vendor", operation, "success", "", 200]]);
    });
  });

  it.each([undefined, null])(
    'sends a request("token") whose parameters are %s, with an upstream and without', async params => {
      const plain = endpoint(() => json({}));
      const through = endpoint(() => json({}));
      const clients = [
        new OAuthClient({ ...COUNTED, client: SECRET_IN_BODY, fetch: plain.fetch }),
        new OAuthClient({
          ...COUNTED, client: SECRET_IN_BODY,
          upstream: defineUpstream({ vendorId: "vendor", fetch: through.fetch }),
        }),
      ];

      // What a caller that is not type-checked may pass.
      for (const client of clients) {
        expect(await Reflect.apply(client.request, client, ["token", params])).toEqual({});
      }

      expect(plain.handed).toHaveLength(1);
      expect(plain.handed[0].body).toBe("client_id=client-1&client_secret=s3cret-value");
      expect(through.handed).toEqual(plain.handed);
      expect(written()).toEqual([["gatekeeper.vendor.api", "vendor", "token.request", "success", "", 200]]);
    });

  it("cancels the body of a redirect once, with an upstream and without", async () => {
    let cancels = 0;
    const { fetch } = endpoint(() => new Response(
      new ReadableStream<Uint8Array>({ cancel() { cancels++; } }),
      { status: 307, headers: { Location: "https://attacker.example/token" } }));

    const plain = await responseError(
      new OAuthClient({ ...BASE, fetch }).refresh({ refreshToken: "rt" }));
    expect(cancels).toBe(1);
    const through = await responseError(new OAuthClient({
      ...BASE, upstream: defineUpstream({ vendorId: "vendor", fetch }),
    }).refresh({ refreshToken: "rt" }));

    expect(cancels).toBe(2);
    expect([plain.httpStatus, through.httpStatus]).toEqual([307, 307]);
  });

  it("returns the tokens of a client without one", async () => {
    const { fetch } = endpoint(() => json({ access_token: "at", refresh_token: "rt2",
      expires_in: 3600, scope: "read write" }));
    const client = new OAuthClient({ ...BASE, upstream: defineUpstream({ vendorId: "vendor", fetch }) });

    expect(await client.exchangeCode({ code: "c", redirectUri: REDIRECT_URI })).toEqual({
      accessToken: "at", refreshToken: "rt2", expiresAt: 1_000_000 + 3_600_000,
      scopes: ["read", "write"],
      raw: { access_token: "at", refresh_token: "rt2", expires_in: 3600, scope: "read write" },
    });
  });

  it("refuses an upstream beside a fetch", () => {
    const { fetch } = endpoint(() => json({ access_token: "at" }));
    expect(() => new OAuthClient({ ...BASE, fetch, upstream: defineUpstream({ vendorId: "vendor" }) }))
      .toThrow("Pass upstream or fetch, not both");
  });

  it("sends once and refuses redirects under an upstream that retries and follows them", async () => {
    const { handed, fetch } = endpoint(() =>
      new Response("down", { status: 503, headers: { "Retry-After": "0" } }));
    const upstream = defineUpstream({
      vendorId: "vendor", service: "identity", fetch, redirect: "follow",
      retry: { baseDelayMs: 0, retryable: () => true },
    });

    const error = await responseError(
      new OAuthClient({ ...BASE, upstream }).refresh({ refreshToken: "rt" }));

    expect(error.httpStatus).toBe(503);
    expect(handed.map(sent => sent.redirect)).toEqual(["manual"]);
    expect(written()).toEqual([
      ["gatekeeper.vendor.api", "identity", "token.refresh", "error", "http", 503],
    ]);
  });

  it("times a request by its own timeoutMs under an upstream with a shorter one", async () => {
    const plain = endpoint(slow);
    const through = endpoint(slow);
    const upstream = defineUpstream({ vendorId: "vendor", fetch: through.fetch, timeoutMs: 1 });

    const tokens = await new OAuthClient({ ...BASE, fetch: plain.fetch }).refresh({ refreshToken: "rt" });
    expect(await new OAuthClient({ ...BASE, upstream }).refresh({ refreshToken: "rt" }))
      .toEqual(tokens);

    // A caller that gives no signal: `fetch` is handed the timeout's alone, on both paths.
    expect(plain.handed).toHaveLength(1);
    expect(plain.handed[0].signalled).toBe(true);
    expect(through.handed).toEqual(plain.handed);
  });

  it("sends with the upstream's fetch, the global read at each request", async () => {
    const client = new OAuthClient({ ...BASE, upstream: defineUpstream({ vendorId: "vendor" }) });
    const stubbed = provider();
    vi.stubGlobal("fetch", stubbed.fetch);

    await client.refresh({ refreshToken: "rt" });

    expect(stubbed.calls).toHaveLength(1);
    expect(written()).toEqual([
      ["gatekeeper.vendor.api", "vendor", "token.refresh", "success", "", 200],
    ]);
  });

  it("loads without the upstream leaf, node:async_hooks or cloudflare:workers", async () => {
    vi.resetModules();
    vi.doMock("../src/upstream", refused("./upstream"));
    vi.doMock("node:async_hooks", refused("node:async_hooks"));
    vi.doMock("cloudflare:workers", refused("cloudflare:workers"));

    const loaded = await import("../src/oauth-client");
    const { calls, fetch } = provider();
    await new loaded.OAuthClient({ ...BASE, fetch }).refresh({ refreshToken: "rt" });

    expect(loaded.OAuthClient).not.toBe(OAuthClient);
    expect(calls).toHaveLength(1);
  });
});
