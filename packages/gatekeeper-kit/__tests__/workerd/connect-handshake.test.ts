import { describe, expect, it } from "vitest";
import {
  advanceToOAuth,
  claimOAuth,
  isConnectAttempted,
  markConnectAttempted,
  NONCE_KEY,
  peekOAuth,
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

  it("carries initiation metadata to the claim, with OAuth-stage metadata taking precedence", () => {
    const kv = makeKv();
    putInitiation(kv, "init", 100, { firstConnect: true, scopes: ["read"] });

    const oauthNonce = advanceToOAuth(kv, "init", 101, { scopes: ["read", "write"], verifier: "pkce" });

    expect(claimOAuth<{ firstConnect: true; scopes: string[]; verifier: string }>(kv, oauthNonce!, 102))
      .toMatchObject({ firstConnect: true, scopes: ["read", "write"], verifier: "pkce", stage: "oauth" });
  });

  it("refuses metadata that would silently lose a reserved field", () => {
    const kv = makeKv();
    putInitiation(kv, "init", 100);

    expect(() => advanceToOAuth(kv, "init", 101, { stage: "oauth" } as never))
      .toThrow(/reserved key "stage"/);
    // Rejected before the attempt was consumed, so the user's link still works.
    expect(advanceToOAuth(kv, "init", 101)).not.toBeNull();
  });

  it("refuses initiation metadata that would lose a reserved field", () => {
    const kv = makeKv();

    expect(() => putInitiation(kv, "init", 100, { expiresAt: 0 } as never)).toThrow(/reserved key "expiresAt"/);
    expect(kv.get(NONCE_KEY)).toBeUndefined();
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

describe("once-only complete()", () => {
  it("shares the connectAttempted marker gatekeepers already store", () => {
    // A hand-rolled account's stored marker must keep its connect closed after adopting the kit.
    const legacy = makeKv();
    legacy.put("connectAttempted", true);
    expect(isConnectAttempted(legacy)).toBe(true);

    const kv = makeKv();
    expect(isConnectAttempted(kv)).toBe(false);
    markConnectAttempted(kv);
    expect(kv.get("connectAttempted")).toBe(true);
  });
});

// A pasted-key form checks its nonce, asks the provider, and claims only once the key is good.
describe("checking an attempt before claiming it", () => {
  const EXPIRY = 101 + 10 * 60 * 1000;
  function shown(kv: ConnectNonceKv): string {
    putInitiation(kv, "init", 100, { firstConnect: true });
    return advanceToOAuth(kv, "init", 101, { startedUnder: "g1" })!;
  }

  it("reads the attempt and leaves it claimable, however often", () => {
    const kv = makeKv();
    const nonce = shown(kv);
    const before = kv.get(NONCE_KEY);

    expect(peekOAuth(kv, nonce, 102)).toMatchObject({ firstConnect: true, startedUnder: "g1", stage: "oauth" });
    expect(peekOAuth(kv, nonce, 103)).not.toBeNull();
    expect(kv.get(NONCE_KEY)).toEqual(before);
    expect(claimOAuth(kv, nonce, 104)).toMatchObject({ firstConnect: true, startedUnder: "g1" });
    expect(peekOAuth(kv, nonce, 105)).toBeNull();
  });

  it("refuses what a claim would refuse", () => {
    const kv = makeKv();
    putInitiation(kv, "init", 100);
    expect(peekOAuth(kv, "init", 101)).toBeNull();
    const nonce = advanceToOAuth(kv, "init", 101)!;
    expect(peekOAuth(kv, "wrong", 102)).toBeNull();
    expect(peekOAuth(kv, "", 102)).toBeNull();
    expect(peekOAuth(kv, nonce, EXPIRY)).toBeNull();
    expect(peekOAuth(kv, nonce, Number.NaN)).toBeNull();
    expect(peekOAuth(makeKv(), nonce, 102)).toBeNull();
  });

  // What can happen while the provider is asked: each ends the attempt at the claim.
  it.each([
    ["a newer link is made", (kv: ConnectNonceKv) => putInitiation(kv, "newer", 103)],
    ["a newer link is opened", (kv: ConnectNonceKv) => {
      putInitiation(kv, "newer", 103);
      advanceToOAuth(kv, "newer", 104);
    }],
    ["a newer attempt is claimed", (kv: ConnectNonceKv) => {
      putInitiation(kv, "newer", 103);
      claimOAuth(kv, advanceToOAuth(kv, "newer", 104)!, 105);
    }],
    ["the nonce is deleted, as a disconnect does", (kv: ConnectNonceKv) => kv.delete(NONCE_KEY)],
  ])("fails the claim when %s between the check and the claim", (_name, meanwhile) => {
    const kv = makeKv();
    const nonce = shown(kv);
    expect(peekOAuth(kv, nonce, 102)).not.toBeNull();
    meanwhile(kv);
    expect(claimOAuth(kv, nonce, 106)).toBeNull();
  });

  it("fails the claim when the attempt expires between the check and the claim", () => {
    const kv = makeKv();
    const nonce = shown(kv);
    expect(peekOAuth(kv, nonce, EXPIRY - 1)).not.toBeNull();
    expect(claimOAuth(kv, nonce, EXPIRY)).toBeNull();
    expect(kv.get<StoredNonce>(NONCE_KEY)?.expiresAt).toBe(EXPIRY);
  });

  it("lets only one of two submissions that both passed the check claim", () => {
    const kv = makeKv();
    const nonce = shown(kv);
    expect(peekOAuth(kv, nonce, 102)).not.toBeNull();
    expect(peekOAuth(kv, nonce, 102)).not.toBeNull();
    expect(claimOAuth(kv, nonce, 103)).not.toBeNull();
    expect(claimOAuth(kv, nonce, 103)).toBeNull();
    expect(kv.get(NONCE_KEY)).toBeUndefined();
  });

  it("returns the stored metadata at the claim, whatever was done to the checked copy", () => {
    const kv = makeKv();
    const nonce = shown(kv);
    const checked = peekOAuth<{ startedUnder: string }>(kv, nonce, 102)!;
    checked.startedUnder = "forged";
    checked.expiresAt = EXPIRY + 60_000;
    expect(claimOAuth(kv, nonce, EXPIRY)).toBeNull();
    expect(claimOAuth<{ startedUnder: string }>(kv, nonce, EXPIRY - 1)?.startedUnder).toBe("g1");
  });
});
