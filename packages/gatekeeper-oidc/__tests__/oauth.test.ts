import { describe, expect, it } from "vitest";
import {
  authorizeUrl, constantTimeEqual, exchangeCode, generateNonce, nonceIsValid,
  OAUTH_NONCE_LIFETIME_MS, type StoredNonce,
} from "../src/oauth.js";

const config = {
  issuer: "https://idp.corp.example",
  clientId: "field-os",
  clientSecret: "s3cret",
  scopes: "",
};
const endpoints = {
  authorization: "https://idp.corp.example/authorize",
  token: "https://idp.corp.example/token",
  jwks: "https://idp.corp.example/jwks",
};
const redirectUri = "https://field.corp.example/gatekeeper/oidc/callback";

describe("generateNonce", () => {
  it("produces 32 bytes of hex", () => {
    expect(generateNonce()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not repeat", () => {
    let seen = new Set(Array.from({ length: 50 }, () => generateNonce()));
    expect(seen.size).toBe(50);
  });
});

describe("constantTimeEqual", () => {
  it("matches identical values", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
  });

  it.each([["abc", "abd"], ["abc", "ab"], ["", "a"]])("rejects %o vs %o", (a, b) => {
    expect(constantTimeEqual(a, b)).toBe(false);
  });
});

describe("nonceIsValid", () => {
  const now = 1_000_000;
  const stored: StoredNonce = { value: "nonce-a", expiresAt: now + 1000, stage: "oauth" };

  it("accepts a matching, unexpired nonce at the right stage", () => {
    expect(nonceIsValid(stored, "nonce-a", "oauth", now)).toBe(true);
  });

  it("rejects a mismatched value", () => {
    expect(nonceIsValid(stored, "nonce-b", "oauth", now)).toBe(false);
  });

  // The stage check is what stops an authorize URL being replayed as a callback, and vice versa.
  it("rejects the right nonce at the wrong stage", () => {
    expect(nonceIsValid(stored, "nonce-a", "initiation", now)).toBe(false);
  });

  it("rejects an expired nonce", () => {
    expect(nonceIsValid(stored, "nonce-a", "oauth", now + 1000)).toBe(false);
  });

  it.each([undefined, null])("rejects %o storage", value => {
    expect(nonceIsValid(value, "nonce-a", "oauth", now)).toBe(false);
  });
});

describe("authorizeUrl", () => {
  const url = () => new URL(authorizeUrl({
    endpoints, config, redirectUri, state: "state-1", idTokenNonce: "nonce-1",
  }));

  it("targets the provider's authorization endpoint", () => {
    expect(url().origin + url().pathname).toBe(endpoints.authorization);
  });

  it("requests an authorization code for our client", () => {
    expect(url().searchParams.get("response_type")).toBe("code");
    expect(url().searchParams.get("client_id")).toBe("field-os");
    expect(url().searchParams.get("redirect_uri")).toBe(redirectUri);
  });

  it("carries both the state and the ID-token nonce", () => {
    expect(url().searchParams.get("state")).toBe("state-1");
    expect(url().searchParams.get("nonce")).toBe("nonce-1");
  });

  // Sign-in is impossible without these two, so they are added whatever the deployment configures.
  it("always requests openid and email", () => {
    let scopes = url().searchParams.get("scope")!.split(" ");
    expect(scopes).toContain("openid");
    expect(scopes).toContain("email");
  });

  it("keeps configured scopes alongside the required ones", () => {
    let withGroups = new URL(authorizeUrl({
      endpoints, config: { ...config, scopes: "groups" },
      redirectUri, state: "s", idTokenNonce: "n",
    }));
    expect(withGroups.searchParams.get("scope")!.split(" ")).toEqual(
        expect.arrayContaining(["groups", "openid", "email"]));
  });

  it("does not leak the client secret into the URL", () => {
    expect(url().toString()).not.toContain(config.clientSecret);
  });
});

describe("exchangeCode", () => {
  const ok = (body: unknown) => (async () =>
      new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

  it("returns the id_token", async () => {
    await expect(exchangeCode({
      code: "abc", endpoints, config, redirectUri, fetchImpl: ok({ id_token: "jwt" }),
    })).resolves.toEqual({ idToken: "jwt" });
  });

  it("posts the code and client credentials as a form", async () => {
    let seen: { url?: string; body?: string; method?: string } = {};
    let capture = (async (url: string, init: RequestInit) => {
      seen = { url, method: init.method, body: String(init.body) };
      return new Response(JSON.stringify({ id_token: "jwt" }), { status: 200 });
    }) as unknown as typeof fetch;

    await exchangeCode({ code: "the-code", endpoints, config, redirectUri, fetchImpl: capture });

    expect(seen.url).toBe(endpoints.token);
    expect(seen.method).toBe("POST");
    let form = new URLSearchParams(seen.body);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("the-code");
    expect(form.get("redirect_uri")).toBe(redirectUri);
    expect(form.get("client_id")).toBe(config.clientId);
    expect(form.get("client_secret")).toBe(config.clientSecret);
  });

  // A provider error body can echo the code or the client secret back at us.
  it("does not include the provider's error body in the thrown message", async () => {
    let leaky = (async () => new Response(
        JSON.stringify({ error: "invalid_client", client_secret: config.clientSecret }),
        { status: 401 })) as unknown as typeof fetch;

    await expect(exchangeCode({ code: "c", endpoints, config, redirectUri, fetchImpl: leaky }))
        .rejects.toThrow(/HTTP 401/);
    await expect(exchangeCode({ code: "c", endpoints, config, redirectUri, fetchImpl: leaky }))
        .rejects.not.toThrow(new RegExp(config.clientSecret));
  });

  // A plain OAuth response (no openid scope) has no identity in it.
  it("rejects a response with no id_token", async () => {
    await expect(exchangeCode({
      code: "c", endpoints, config, redirectUri, fetchImpl: ok({ access_token: "at" }),
    })).rejects.toThrow(/did not return an id_token/);
  });
});

describe("nonce lifetimes", () => {
  it("are short enough to bound a redirect, not a session", () => {
    expect(OAUTH_NONCE_LIFETIME_MS).toBeLessThanOrEqual(15 * 60 * 1000);
  });
});
