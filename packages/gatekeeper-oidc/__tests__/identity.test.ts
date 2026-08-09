import { describe, expect, it } from "vitest";
import type { JWTPayload } from "jose";
import { discoverEndpoints, identityFromClaims, resolveScopes } from "../src/identity.js";

const claims = (over: Partial<JWTPayload> = {}): JWTPayload => ({
  sub: "user-123",
  email: "alice@corp.example",
  email_verified: true,
  ...over,
});

describe("resolveScopes", () => {
  it("adds the scopes the flow cannot work without", () => {
    expect(resolveScopes("profile")).toBe("profile openid email");
  });

  it("does not duplicate scopes already configured", () => {
    expect(resolveScopes("openid email profile")).toBe("openid email profile");
  });

  it("handles an empty configuration", () => {
    expect(resolveScopes("")).toBe("openid email");
  });
});

describe("identityFromClaims", () => {
  it("extracts a verified identity", () => {
    expect(identityFromClaims(claims({ exp: 1_800_000_000 }))).toEqual({
      email: "alice@corp.example",
      subject: "user-123",
      expiresAt: new Date(1_800_000_000 * 1000),
    });
  });

  // Accounts are keyed by email, so casing differences must not mint a second account.
  it("lower-cases the email", () => {
    expect(identityFromClaims(claims({ email: "Alice@Corp.Example" })).email)
        .toBe("alice@corp.example");
  });

  // The core security property: an unverified address would let anyone who can register
  // victim@corp at a permissive IdP sign in as that Workshop user.
  it("rejects an unverified email", () => {
    expect(() => identityFromClaims(claims({ email_verified: false })))
        .toThrow(/unverified/);
  });

  // Absent must mean unverified — some IdPs omit the claim rather than sending false.
  it("rejects a missing email_verified claim", () => {
    let payload = claims();
    delete payload.email_verified;
    expect(() => identityFromClaims(payload)).toThrow(/unverified/);
  });

  // A string "true" is not a boolean true; a loose check here would accept it.
  it("rejects a non-boolean email_verified claim", () => {
    expect(() => identityFromClaims(claims({ email_verified: "true" })))
        .toThrow(/unverified/);
  });

  it.each([undefined, "", "not-an-email", 42])("rejects email claim %o", value => {
    let payload = claims();
    if (value === undefined) delete payload.email; else payload.email = value;
    expect(() => identityFromClaims(payload)).toThrow(/email claim/);
  });

  it("rejects a missing subject", () => {
    let payload = claims();
    delete payload.sub;
    expect(() => identityFromClaims(payload)).toThrow(/subject/);
  });

  it("tolerates an absent exp", () => {
    expect(identityFromClaims(claims()).expiresAt).toBeUndefined();
  });
});

describe("discoverEndpoints", () => {
  const issuer = "https://idp.corp.example";
  const wellFormed = {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks`,
  };
  const respondWith = (body: unknown, status = 200) =>
      (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("extracts the endpoints", async () => {
    await expect(discoverEndpoints(issuer, respondWith(wellFormed))).resolves.toEqual({
      authorization: `${issuer}/authorize`,
      token: `${issuer}/token`,
      jwks: `${issuer}/jwks`,
    });
  });

  it("tolerates a trailing slash on the configured issuer", async () => {
    await expect(discoverEndpoints(`${issuer}/`, respondWith(wellFormed))).resolves.toBeDefined();
  });

  // Trusting a document that names a different issuer would mean verifying tokens against the
  // wrong keys.
  it("rejects an issuer mismatch", async () => {
    await expect(discoverEndpoints(issuer, respondWith({
      ...wellFormed, issuer: "https://evil.example",
    }))).rejects.toThrow(/declares issuer/);
  });

  // Defence in depth: a tampered document must not redirect token exchange off-issuer.
  it("rejects an endpoint on another origin", async () => {
    await expect(discoverEndpoints(issuer, respondWith({
      ...wellFormed, token_endpoint: "https://evil.example/token",
    }))).rejects.toThrow(/not on the issuer's origin/);
  });

  it("rejects a plaintext endpoint", async () => {
    await expect(discoverEndpoints("http://idp.corp.example", respondWith({
      ...wellFormed,
      issuer: "http://idp.corp.example",
      authorization_endpoint: "http://idp.corp.example/authorize",
      token_endpoint: "http://idp.corp.example/token",
      jwks_uri: "http://idp.corp.example/jwks",
    }))).rejects.toThrow(/must use https/);
  });

  it.each(["authorization_endpoint", "token_endpoint", "jwks_uri"])(
      "rejects a document missing %s", async field => {
    let doc: Record<string, unknown> = { ...wellFormed };
    delete doc[field];
    await expect(discoverEndpoints(issuer, respondWith(doc))).rejects.toThrow(new RegExp(field));
  });

  it("reports an unreachable issuer clearly", async () => {
    await expect(discoverEndpoints(issuer, respondWith({}, 404)))
        .rejects.toThrow(/discovery failed/);
  });
});
