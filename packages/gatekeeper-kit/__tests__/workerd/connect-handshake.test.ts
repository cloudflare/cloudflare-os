import { describe, expect, it } from "vitest";
import {
  advanceToOAuth,
  claimOAuth,
  isConnectAttempted,
  markConnectAttempted,
  NONCE_KEY,
  putInitiation,
  reofferOAuth,
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

describe("reoffering a claimed attempt", () => {
  const OAUTH_STAGE_EXPIRY = 101 + 10 * 60 * 1000;
  function claimed(kv: ConnectNonceKv) {
    putInitiation(kv, "init", 100, { firstConnect: true });
    const first = advanceToOAuth(kv, "init", 101, { startedUnder: "g1" })!;
    const claim = claimOAuth<{ firstConnect: true; startedUnder: string }>(kv, first, 102, { retryable: true })!;
    return { first, claim };
  }

  it("mints a new nonce that claims the same attempt once, and leaves the old one dead", () => {
    const kv = makeKv();
    const { first, claim } = claimed(kv);

    const second = reofferOAuth(kv, claim, 103);
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(claimOAuth(kv, first, 104)).toBeNull();
    expect(claimOAuth(kv, second!, 104)).toMatchObject({ firstConnect: true, startedUnder: "g1", stage: "oauth" });
    expect(claimOAuth(kv, second!, 104)).toBeNull();
  });

  it("keeps the attempt's original expiry however often it is reoffered", () => {
    const kv = makeKv();
    let { claim } = claimed(kv);
    for (let now = 200; now < 205; now++) {
      const nonce = reofferOAuth(kv, claim, now)!;
      expect(kv.get<StoredNonce>(NONCE_KEY)?.expiresAt).toBe(OAUTH_STAGE_EXPIRY);
      claim = claimOAuth(kv, nonce, now, { retryable: true })!;
    }
    const last = reofferOAuth(kv, claim, OAUTH_STAGE_EXPIRY - 1)!;
    expect(claimOAuth(kv, last, OAUTH_STAGE_EXPIRY)).toBeNull();
  });

  it("refuses an attempt that has expired", () => {
    const kv = makeKv();
    const { claim } = claimed(kv);
    expect(reofferOAuth(kv, claim, OAUTH_STAGE_EXPIRY)).toBeNull();
    expect(reofferOAuth(kv, claim, Number.NaN)).toBeNull();
    expect(kv.get(NONCE_KEY)).toBeUndefined();
  });

  it("gives way to a connect link stored since the claim", () => {
    const kv = makeKv();
    const { claim } = claimed(kv);
    putInitiation(kv, "newer", 103);

    expect(reofferOAuth(kv, claim, 104)).toBeNull();
    expect(advanceToOAuth(kv, "newer", 105)).not.toBeNull();
  });

  // The slot is empty after the newer attempt's own claim, as it was after the older one's.
  it("gives way to a newer attempt that has itself been claimed", () => {
    const kv = makeKv();
    const { claim: older } = claimed(kv);
    putInitiation(kv, "newer", 103);
    const newer = claimOAuth(kv, advanceToOAuth(kv, "newer", 104)!, 105, { retryable: true })!;

    expect(reofferOAuth(kv, older, 106)).toBeNull();
    const again = reofferOAuth(kv, newer, 106);
    expect(again).not.toBeNull();
    expect(claimOAuth(kv, again!, 107)).not.toBeNull();
  });

  it("gives way to a newer attempt whose claim was not retryable", () => {
    const kv = makeKv();
    const { claim: older } = claimed(kv);
    putInitiation(kv, "newer", 103);
    expect(claimOAuth(kv, advanceToOAuth(kv, "newer", 104)!, 105)).not.toBeNull();

    expect(reofferOAuth(kv, older, 106)).toBeNull();
  });

  it("refuses a claim that was not made retryable, or is reoffered twice", () => {
    const kv = makeKv();
    putInitiation(kv, "init", 100);
    const plain = claimOAuth(kv, advanceToOAuth(kv, "init", 101)!, 102)!;
    expect(reofferOAuth(kv, plain, 103)).toBeNull();

    const { claim } = claimed(kv);
    expect(reofferOAuth(kv, claim, 104)).not.toBeNull();
    kv.delete(NONCE_KEY);
    expect(reofferOAuth(kv, claim, 105)).toBeNull();
  });

  it("refuses a record that is not a claimed attempt", () => {
    const kv = makeKv();
    const { claim } = claimed(kv);
    expect(reofferOAuth(kv, { ...claim, stage: "initiation" }, 103)).toBeNull();
  });
});
