import { describe, expect, it } from "vitest";
import {
  ACCESS_TOKEN_SAFETY_MS,
  CONNECT_TIMEOUT_MS,
  constantTimeEqual,
  generateNonce,
  hexEncode,
  INITIATION_NONCE_LIFETIME_MS,
  isLiveNonce,
  NONCE_BYTES,
  OAUTH_NONCE_LIFETIME_MS,
  type TimedNonce,
} from "../../src/connect-nonce";
import { NONCE_KEY } from "../../src/connect-handshake";

// Pin storage keys and user-visible security windows independently of their exports.
describe("wire-visible constants", () => {
  it("pins the durable key and every published duration", () => {
    expect(NONCE_KEY).toBe("nonce");
    expect(NONCE_BYTES).toBe(32);
    expect(INITIATION_NONCE_LIFETIME_MS).toBe(10 * 60 * 1000);
    expect(OAUTH_NONCE_LIFETIME_MS).toBe(10 * 60 * 1000);
    expect(CONNECT_TIMEOUT_MS).toBe(60 * 60 * 1000);
    expect(ACCESS_TOKEN_SAFETY_MS).toBe(60 * 1000);
  });
});

describe("isLiveNonce", () => {
  const live = { value: "abc", expiresAt: 200 };

  it("accepts only a live, matching, well-formed record", () => {
    expect(isLiveNonce(live, "abc", 100)).toBe(true);
    expect(isLiveNonce(live, "abd", 100)).toBe(false);
    expect(isLiveNonce(live, "abc", 200)).toBe(false);
    expect(isLiveNonce(undefined, "abc", 100)).toBe(false);
  });

  it("fails closed on a record storage cannot vouch for", () => {
    // An absent value encodes to the same empty buffer an empty presentation does, so a corrupt
    // record would otherwise admit.
    expect(isLiveNonce({ expiresAt: 200 } as unknown as TimedNonce, "", 100)).toBe(false);
    expect(isLiveNonce({ value: "", expiresAt: 200 }, "", 100)).toBe(false);
    expect(isLiveNonce(live, "", 100)).toBe(false);
    expect(isLiveNonce({ value: "abc" } as unknown as TimedNonce, "abc", 100)).toBe(false);
    expect(isLiveNonce({ value: 7, expiresAt: 200 } as unknown as TimedNonce, "7", 100)).toBe(false);
    // NaN loses every comparison, so an unusable clock would read as not-yet-expired.
    expect(isLiveNonce(live, "abc", Number.NaN)).toBe(false);
    expect(isLiveNonce(live, "abc", -Infinity)).toBe(false);
  });
});

describe("connect nonce primitives", () => {
  it("generates distinct 32-byte lowercase hexadecimal nonces", () => {
    const first = generateNonce();
    const second = generateNonce();

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toMatch(/^[0-9a-f]{64}$/);
    expect(second).not.toBe(first);
  });

  it("pads every byte to two hex digits", () => {
    expect(hexEncode(new Uint8Array([0, 1, 15, 16, 255]))).toBe("00010f10ff");
  });

  it("compares equal strings and rejects differing values or lengths", () => {
    expect(constantTimeEqual("same", "same")).toBe(true);
    expect(constantTimeEqual("same", "diff")).toBe(false);
    expect(constantTimeEqual("same", "shorter")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
    // UTF-8 maps both lone surrogates to U+FFFD, so encoded bytes alone would report them equal.
    expect(constantTimeEqual("\uD800", "\uD801")).toBe(false);
    expect(constantTimeEqual("\uD800", "\uD800")).toBe(false);
  });
});
