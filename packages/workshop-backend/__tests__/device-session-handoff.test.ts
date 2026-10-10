import { describe, expect, it } from "vitest";
import type { DeviceSessionTransfer } from "@gadgets/workshop-shared/api";
import {
  DEVICE_HANDOFF_LIFETIME_MS,
  sealDeviceSessionHandoff,
} from "../src/auth/device-session-handoff";

const state = "ABCDEFab-0000-0000-0000-000000000001";
const context = new TextEncoder().encode("cloudflare-os-device-session-v1");

describe("device session handoff encryption", () => {
  it("only the initiating app key and opaque state can decrypt the credential", async () => {
    const appKey = await crypto.subtle.generateKey(
        { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
    const appPublic = new Uint8Array(
        await crypto.subtle.exportKey("raw", appKey.publicKey) as ArrayBuffer)
        .toBase64({ alphabet: "base64url" });
    const before = Date.now();
    const sealed = await sealDeviceSessionHandoff(
        appPublic, state, { kind: "cloudflare-access", token: "sensitive-jwt" });
    expect(JSON.stringify(sealed)).not.toContain("sensitive-jwt");
    const serverPublic = await crypto.subtle.importKey(
        "raw", Uint8Array.fromBase64(sealed.publicKey, { alphabet: "base64url" }),
        { name: "ECDH", namedCurve: "P-256" }, false, []);
    const bits = await crypto.subtle.deriveBits(
        { name: "ECDH", public: serverPublic } as
          SubtleCryptoDeriveKeyAlgorithm & { public: CryptoKey },
        appKey.privateKey, 256);
    const material = await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256",
          salt: Uint8Array.fromBase64(sealed.salt, { alphabet: "base64url" }), info: context },
        material, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    const algorithm = {
      name: "AES-GCM",
      iv: Uint8Array.fromBase64(sealed.iv, { alphabet: "base64url" }),
      additionalData: new TextEncoder().encode(state),
    };
    const decrypted = await crypto.subtle.decrypt(
        algorithm, key,
        Uint8Array.fromBase64(sealed.ciphertext, { alphabet: "base64url" }));
    const transfer = JSON.parse(new TextDecoder().decode(decrypted)) as DeviceSessionTransfer;
    expect(transfer.credential).toEqual({ kind: "cloudflare-access", token: "sensitive-jwt" });
    expect(transfer.expiresAt).toBeGreaterThanOrEqual(before + DEVICE_HANDOFF_LIFETIME_MS);
    expect(transfer.expiresAt).toBeLessThanOrEqual(Date.now() + DEVICE_HANDOFF_LIFETIME_MS);
    await expect(crypto.subtle.decrypt({
      ...algorithm,
      additionalData: new TextEncoder().encode("another-opaque-state-value"),
    }, key, Uint8Array.fromBase64(sealed.ciphertext, { alphabet: "base64url" })))
      .rejects.toThrow();
  });

  it("rejects short states and malformed public keys before transfer", async () => {
    await expect(sealDeviceSessionHandoff(
        "not-a-key", state, { kind: "workshop", token: "secret", expiresAt: Date.now() }))
      .rejects.toThrow("Invalid device handoff key");
    await expect(sealDeviceSessionHandoff(
        "A".repeat(87), "short", { kind: "workshop", token: "secret", expiresAt: Date.now() }))
      .rejects.toThrow("Invalid device sign-in state");
  });
});
