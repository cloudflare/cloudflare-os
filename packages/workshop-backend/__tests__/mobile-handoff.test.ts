import { describe, expect, it } from "vitest";
import { sealMobileHandoff } from "../src/auth/mobile-handoff";

const state = "abcdefab-0000-0000-0000-000000000001";
const context = new TextEncoder().encode("cloudflare-os-mobile-handoff-v1");

function decode(value: string): Uint8Array {
  const raw = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(raw, char => char.charCodeAt(0));
}

function encode(value: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(value)))
      .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

describe("mobile session handoff", () => {
  it("only the initiating app key and state can decrypt the session", async () => {
    const appKey = await crypto.subtle.generateKey(
        { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
    const appPublic = encode(await crypto.subtle.exportKey("raw", appKey.publicKey) as ArrayBuffer);
    const sealed = await sealMobileHandoff(appPublic, state, { accessJwt: "sensitive-jwt" });
    expect(JSON.stringify(sealed)).not.toContain("sensitive-jwt");
    const serverPublic = await crypto.subtle.importKey(
        "raw", decode(sealed.publicKey), { name: "ECDH", namedCurve: "P-256" }, false, []);
    const bits = await crypto.subtle.deriveBits(
        { name: "ECDH", public: serverPublic } as SubtleCryptoDeriveKeyAlgorithm & { public: CryptoKey },
        appKey.privateKey, 256);
    const material = await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: decode(sealed.salt), info: context }, material,
        { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    const algorithm = { name: "AES-GCM", iv: decode(sealed.iv),
      additionalData: new TextEncoder().encode(state) };
    const decrypted = await crypto.subtle.decrypt(algorithm, key, decode(sealed.ciphertext));
    expect(JSON.parse(new TextDecoder().decode(decrypted))).toMatchObject({ accessJwt: "sensitive-jwt" });
    await expect(crypto.subtle.decrypt({ ...algorithm, additionalData: new TextEncoder().encode(
      "abcdefab-0000-0000-0000-000000000002") }, key, decode(sealed.ciphertext)))
      .rejects.toThrow();
  });

  it("rejects malformed public keys before any session can be transferred", async () => {
    await expect(sealMobileHandoff("not-a-key", state, { sessionToken: "secret" }))
      .rejects.toThrow("Invalid mobile handoff key");
  });
});
