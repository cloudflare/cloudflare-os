import { describe, expect, it } from "vitest";
import {
  advanceToOAuth,
  claimOAuth,
  clearOAuthBrowserCookie,
  oauthBrowserCookie,
  putInitiation,
  readOAuthBrowserCookie,
  type ConnectNonceKv,
  type StoredNonce,
} from "../../src/connect-handshake";
import { INITIATION_NONCE_LIFETIME_MS } from "../../src/connect-nonce";
import { fakeKv } from "../fake-kv";

const SECRET = "b".repeat(64);

function makeKv(): ConnectNonceKv {
  return fakeKv();
}

/** An OAuth-stage record as `advanceToOAuth` writes one, minus whatever a case overrides. */
function putOAuth(kv: ConnectNonceKv, record: Partial<StoredNonce> = {}): void {
  kv.put<StoredNonce>("nonce",
    { value: "oauth", expiresAt: 200, stage: "oauth", cookieSecret: SECRET, ...record });
}

describe("two-stage connect handshake", () => {
  it("advances and claims a nonce exactly once while preserving extra state", () => {
    const kv = makeKv();
    putInitiation(kv, "init", 100);

    const attempt = advanceToOAuth(kv, "init", 101, { verifier: "pkce" });
    expect(attempt).not.toBeNull();
    expect(advanceToOAuth(kv, "init", 101)).toBeNull();

    const claimed = claimOAuth<{ verifier: string }>(
      kv, attempt!.oauthNonce, attempt!.cookieSecret, 102);
    expect(claimed?.verifier).toBe("pkce");
    // The secret is the record's own; a caller that read it back could leak it onward.
    expect(claimed).not.toHaveProperty("cookieSecret");
    expect(claimOAuth(kv, attempt!.oauthNonce, attempt!.cookieSecret, 102)).toBeNull();
  });

  it("mints an independent secret per attempt", () => {
    const kv = makeKv();
    putInitiation(kv, "init", 100);
    const attempt = advanceToOAuth(kv, "init", 101)!;
    // Deriving it from the nonce would make it computable by anyone holding the callback URL.
    expect(attempt.cookieSecret).not.toBe(attempt.oauthNonce);
    expect(attempt.cookieSecret).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses metadata that would silently lose a reserved field", () => {
    const kv = makeKv();
    putInitiation(kv, "init", 100);

    expect(() => advanceToOAuth(kv, "init", 101, { stage: "oauth" } as never))
      .toThrow(/reserved key "stage"/);
    expect(() => advanceToOAuth(kv, "init", 101, { cookieSecret: "x" } as never))
      .toThrow(/reserved key "cookieSecret"/);
    // Rejected before the attempt was consumed, so the user's link still works.
    expect(advanceToOAuth(kv, "init", 101)).not.toBeNull();
  });

  it("rejects an absent initiation nonce", () => {
    expect(advanceToOAuth(makeKv(), "init", 100)).toBeNull();
  });

  it("rejects the wrong stage", () => {
    const kv = makeKv();
    kv.put<StoredNonce>("nonce", { value: "init", expiresAt: 200, stage: "oauth" });
    expect(advanceToOAuth(kv, "init", 100)).toBeNull();
  });

  it("rejects the wrong value without consuming the attempt", () => {
    const kv = makeKv();
    putInitiation(kv, "init", 100);
    expect(advanceToOAuth(kv, "wrong", 100)).toBeNull();
    expect(advanceToOAuth(kv, "init", 100)).not.toBeNull();
  });

  it("rejects exactly at expiry and accepts one millisecond before", () => {
    const expired = makeKv();
    putInitiation(expired, "init", 100);
    expect(advanceToOAuth(expired, "init", 100 + INITIATION_NONCE_LIFETIME_MS)).toBeNull();

    const live = makeKv();
    putInitiation(live, "init", 100);
    expect(advanceToOAuth(live, "init", 99 + INITIATION_NONCE_LIFETIME_MS)).not.toBeNull();
  });

  it("rejects absent, wrong-stage, wrong-value, and expired OAuth claims", () => {
    expect(claimOAuth(makeKv(), "oauth", SECRET, 100)).toBeNull();

    const wrongStage = makeKv();
    putOAuth(wrongStage, { stage: "initiation" });
    expect(claimOAuth(wrongStage, "oauth", SECRET, 100)).toBeNull();

    const wrongValue = makeKv();
    putOAuth(wrongValue);
    expect(claimOAuth(wrongValue, "wrong", SECRET, 100)).toBeNull();

    const expired = makeKv();
    putOAuth(expired, { expiresAt: 100 });
    expect(claimOAuth(expired, "oauth", SECRET, 100)).toBeNull();
  });

  it("refuses a forged browser cookie, and a record written before secrets existed", () => {
    // A callback URL holder knows the nonce but not the secret -- and a wrong secret must not
    // consume the attempt, or holding the URL would be enough to burn the user's live link.
    const forged = makeKv();
    putOAuth(forged);
    expect(claimOAuth(forged, "oauth", "c".repeat(64), 100)).toBeNull();
    expect(forged.get("nonce")).toBeDefined();
    expect(claimOAuth(forged, "oauth", SECRET, 100)).not.toBeNull();

    const legacy = makeKv();
    putOAuth(legacy, { cookieSecret: undefined });
    expect(claimOAuth(legacy, "oauth", SECRET, 100)).toBeNull();
    expect(claimOAuth(legacy, "oauth", "", 100)).toBeNull();
  });

  it("leaves a live attempt claimable after a wrong claim, and consumes it exactly once", () => {
    // Every rejection above is satisfied by an implementation that deletes the record BEFORE
    // validating it, which would let one bad callback burn the user's live link. What separates the
    // two is whether the attempt survives a wrong claim.
    const kv = makeKv();
    putOAuth(kv);

    expect(claimOAuth(kv, "wrong", SECRET, 100)).toBeNull();
    expect(kv.get("nonce")).toBeDefined();

    // The real callback still arrives and works...
    expect(claimOAuth(kv, "oauth", SECRET, 100)).not.toBeNull();
    // ...and is single-use, so a replay of the same URL finds nothing.
    expect(claimOAuth(kv, "oauth", SECRET, 100)).toBeNull();
    expect(kv.get("nonce")).toBeUndefined();
  });
});

describe("OAuth browser binding", () => {
  const nonce = "a".repeat(64);
  const cookieName = `__Host-gatekeeper-oauth-${nonce}`;
  const request = (cookie?: string) => new Request("https://workshop.example/oauth",
    cookie === undefined ? undefined : { headers: { Cookie: cookie } });

  it("carries the attempt secret, not a value the callback URL reveals", () => {
    expect(oauthBrowserCookie(nonce, SECRET)).toBe(
      `${cookieName}=${SECRET}; Path=/; Max-Age=600; Secure; HttpOnly; SameSite=Lax`,
    );
    expect(readOAuthBrowserCookie(request(`other=x; ${cookieName}=${SECRET}`), nonce))
      .toBe(SECRET);
    expect(readOAuthBrowserCookie(request(), nonce)).toBeUndefined();
    expect(readOAuthBrowserCookie(request(`${cookieName}=${SECRET}`), "b".repeat(64)))
      .toBeUndefined();
  });

  it("expires the browser binding with the same host-only cookie attributes", () => {
    expect(clearOAuthBrowserCookie(nonce)).toBe(
      `${cookieName}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`,
    );
  });

  it("fails closed for malformed callback nonces and secrets", () => {
    expect(() => oauthBrowserCookie("bad; Path=/", SECRET)).toThrow("Invalid OAuth nonce");
    expect(() => oauthBrowserCookie(nonce, "x; Path=/")).toThrow("Invalid OAuth cookie secret");
    // Clearing degrades like reading: it is added to every terminal response, including the ones
    // refusing a malformed `state`, so a throw here would 500 the refusal page.
    expect(clearOAuthBrowserCookie("bad")).toBeUndefined();
    expect(readOAuthBrowserCookie(request("__Host-gatekeeper-oauth-bad=1"), "bad"))
      .toBeUndefined();
  });
});
