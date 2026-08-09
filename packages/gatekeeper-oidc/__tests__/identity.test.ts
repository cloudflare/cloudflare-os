import { describe, expect, it } from "vitest";
import type { JWTPayload } from "jose";
import {
  discoverEndpoints, identityFromClaims, resolveOrg, resolveScopes,
} from "../src/identity.js";

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

describe("resolveOrg", () => {
  const withPrefix = { claim: "groups", prefix: "fieldos-" };

  it("resolves the single matching group", () => {
    expect(resolveOrg(claims({ groups: ["fieldos-legal"] }), withPrefix)).toBe("legal");
  });

  it("ignores groups that do not carry the prefix", () => {
    expect(resolveOrg(claims({
      groups: ["all-staff", "vpn-users", "fieldos-legal", "printer-access"],
    }), withPrefix)).toBe("legal");
  });

  // Keycloak emits group *paths*, so a leading slash must not defeat the prefix match.
  it("tolerates Keycloak's leading slash", () => {
    expect(resolveOrg(claims({ groups: ["/fieldos-legal"] }), withPrefix)).toBe("legal");
  });

  it("accepts a single string as well as an array", () => {
    expect(resolveOrg(claims({ groups: "fieldos-legal" }), withPrefix)).toBe("legal");
  });

  it("lower-cases so casing cannot fork an org", () => {
    expect(resolveOrg(claims({ groups: ["fieldos-Legal"] }), withPrefix)).toBe("legal");
  });

  it("treats a repeated group as one, not an ambiguity", () => {
    expect(resolveOrg(claims({ groups: ["fieldos-legal", "fieldos-legal"] }), withPrefix))
        .toBe("legal");
  });

  // Picking the first would make access depend on an IdP's serialization order.
  it("refuses to choose between two orgs", () => {
    expect(resolveOrg(claims({ groups: ["fieldos-legal", "fieldos-eng"] }), withPrefix))
        .toBeUndefined();
  });

  // THE central safety property. Above 200 groups Entra omits the claim entirely and points at
  // Microsoft Graph, unreachable airgapped — so a user in 250 groups looks exactly like this.
  // Defaulting here would put them in someone else's org.
  it("yields no org when the claim is absent", () => {
    expect(resolveOrg(claims(), withPrefix)).toBeUndefined();
  });

  it.each([[[]], [""], [null], [42], [{}]])("yields no org for claim value %o", value => {
    expect(resolveOrg(claims({ groups: value }), withPrefix)).toBeUndefined();
  });

  it("yields no org when no group carries the prefix", () => {
    expect(resolveOrg(claims({ groups: ["all-staff"] }), withPrefix)).toBeUndefined();
  });

  it("yields no org for a bare prefix with nothing after it", () => {
    expect(resolveOrg(claims({ groups: ["fieldos-"] }), withPrefix)).toBeUndefined();
  });

  // Unconfigured means the deployment does not use org separation at all.
  it("yields no org when no claim is configured", () => {
    expect(resolveOrg(claims({ groups: ["fieldos-legal"] }), {})).toBeUndefined();
  });

  it("uses every group when no prefix is configured", () => {
    expect(resolveOrg(claims({ groups: ["legal"] }), { claim: "groups" })).toBe("legal");
    expect(resolveOrg(claims({ groups: ["legal", "eng"] }), { claim: "groups" })).toBeUndefined();
  });

  it("reads whichever claim is configured", () => {
    expect(resolveOrg(claims({ department: ["fieldos-legal"] }), {
      claim: "department", prefix: "fieldos-",
    })).toBe("legal");
  });
});

describe("identityFromClaims org wiring", () => {
  it("carries the resolved org", () => {
    expect(identityFromClaims(claims({ groups: ["fieldos-legal"] }), {
      claim: "groups", prefix: "fieldos-",
    }).orgId).toBe("legal");
  });

  it("leaves org undefined when org resolution is not configured", () => {
    expect(identityFromClaims(claims({ groups: ["fieldos-legal"] })).orgId).toBeUndefined();
  });

  // A user who cannot be placed in an org must still be able to sign in; they simply reach nothing
  // org-scoped. Refusing the login instead would turn a misconfigured claim into an outage.
  it("still signs in a user with no resolvable org", () => {
    let identity = identityFromClaims(claims(), { claim: "groups", prefix: "fieldos-" });
    expect(identity.email).toBe("alice@corp.example");
    expect(identity.orgId).toBeUndefined();
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
