import { describe, expect, it } from "vitest";
import {
  advanceToOAuth,
  claimOAuth,
  putInitiation,
  type ConnectNonceKv,
  type StoredNonce,
} from "../../src/connect-handshake";
import { INITIATION_NONCE_LIFETIME_MS } from "../../src/connect-nonce";
import { fakeKv } from "../fake-kv";

function makeKv(): ConnectNonceKv {
  return fakeKv();
}

describe("two-stage connect handshake", () => {
  it("advances and claims a nonce exactly once while preserving extra state", () => {
    const kv = makeKv();
    putInitiation(kv, "init", 100);

    const oauthNonce = advanceToOAuth(kv, "init", 101, { verifier: "pkce" });
    expect(oauthNonce).not.toBeNull();
    expect(advanceToOAuth(kv, "init", 101)).toBeNull();

    const claimed = claimOAuth<{ verifier: string }>(kv, oauthNonce!, 102);
    expect(claimed?.verifier).toBe("pkce");
    expect(claimOAuth(kv, oauthNonce!, 102)).toBeNull();
  });

  it("refuses metadata that would silently lose a reserved field", () => {
    const kv = makeKv();
    putInitiation(kv, "init", 100);

    expect(() => advanceToOAuth(kv, "init", 101, { stage: "oauth" } as never))
      .toThrow(/reserved key "stage"/);
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
    expect(claimOAuth(makeKv(), "oauth", 100)).toBeNull();

    const wrongStage = makeKv();
    wrongStage.put<StoredNonce>("nonce", { value: "oauth", expiresAt: 200, stage: "initiation" });
    expect(claimOAuth(wrongStage, "oauth", 100)).toBeNull();

    const wrongValue = makeKv();
    wrongValue.put<StoredNonce>("nonce", { value: "oauth", expiresAt: 200, stage: "oauth" });
    expect(claimOAuth(wrongValue, "wrong", 100)).toBeNull();

    const expired = makeKv();
    expired.put<StoredNonce>("nonce", { value: "oauth", expiresAt: 100, stage: "oauth" });
    expect(claimOAuth(expired, "oauth", 100)).toBeNull();
  });

  it("leaves a live attempt claimable after a wrong claim, and consumes it exactly once", () => {
    // Every rejection above is satisfied by an implementation that deletes the record BEFORE
    // validating it, which would let one bad callback burn the user's live link. What separates the
    // two is whether the attempt survives a wrong claim.
    const kv = makeKv();
    kv.put<StoredNonce>("nonce", { value: "oauth", expiresAt: 200, stage: "oauth" });

    expect(claimOAuth(kv, "wrong", 100)).toBeNull();
    expect(kv.get("nonce")).toBeDefined();

    // The real callback still arrives and works...
    expect(claimOAuth(kv, "oauth", 100)).not.toBeNull();
    // ...and is single-use, so a replay of the same URL finds nothing.
    expect(claimOAuth(kv, "oauth", 100)).toBeNull();
    expect(kv.get("nonce")).toBeUndefined();
  });
});
