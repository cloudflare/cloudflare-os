import type { MobileHandoff } from "@gadgets/workshop-shared/api";

const CONTEXT = new TextEncoder().encode("cloudflare-os-mobile-handoff-v1");
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decode(value: string): Uint8Array {
  if (!BASE64URL.test(value)) throw new Error("Invalid mobile handoff key.");
  try {
    const raw = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
    return Uint8Array.from(raw, char => char.charCodeAt(0));
  } catch {
    throw new Error("Invalid mobile handoff key.");
  }
}

/** Seal a short-lived browser session for the native app's per-attempt P-256 key. */
export async function sealMobileHandoff(
    publicKey: string, state: string,
    session: { sessionToken?: string; accessJwt?: string; accessExpiresAt?: number },
): Promise<MobileHandoff> {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(state)) {
    throw new Error("Invalid mobile sign-in state.");
  }
  const publicBytes = decode(publicKey);
  if (publicBytes.length !== 65 || publicBytes[0] !== 4) {
    throw new Error("Invalid mobile handoff key.");
  }
  const recipient = await crypto.subtle.importKey(
      "raw", publicBytes, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ephemeral = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  // Workers' generated Crypto types call the standard ECDH `public` field `$public`.
  const secret = await crypto.subtle.deriveBits(
      { name: "ECDH", public: recipient } as SubtleCryptoDeriveKeyAlgorithm & { public: CryptoKey },
      ephemeral.privateKey, 256);
  const material = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt, info: CONTEXT }, material,
      { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(state) }, key,
      new TextEncoder().encode(JSON.stringify({
        ...session,
        expiresAt: Date.now() + 2 * 60_000,
      })));
  return {
    publicKey: encode(new Uint8Array(
        await crypto.subtle.exportKey("raw", ephemeral.publicKey) as ArrayBuffer)),
    salt: encode(salt), iv: encode(iv), ciphertext: encode(new Uint8Array(ciphertext)),
  };
}
