/** Credential encrypted for the native app. The native wire format is documented in oauth-signin.md. */
export type DeviceSessionCredential =
  | {
      kind: "workshop";
      /** `<user-id>:<standard-base64-secret>`, accepted by `PublicApi.authenticate()`. */
      token: string;
      /** Server-enforced expiry of this install-local session, in Unix milliseconds. */
      expiresAt: number;
    }
  | {
      kind: "cloudflare-access";
      /** Access application JWT; its `exp` bounds this credential's lifetime. */
      token: string;
    };

/** Plaintext encrypted for one device-session transfer. */
export type DeviceSessionTransfer = {
  credential: DeviceSessionCredential;
  /** Deadline for consuming the transfer, independent of the credential's own lifetime. */
  expiresAt: number;
};

/** Envelope delivered only through the claimed native-app HTTPS callback. */
export type DeviceSessionHandoff = {
  /** Ephemeral P-256 public key, uncompressed and unpadded base64url encoded. */
  publicKey: string;
  /** Random HKDF salt, unpadded base64url encoded. */
  salt: string;
  /** AES-GCM nonce, unpadded base64url encoded. */
  iv: string;
  /** AES-GCM ciphertext and tag, unpadded base64url encoded. */
  ciphertext: string;
};

const CONTEXT = new TextEncoder().encode("cloudflare-os-device-session-v1");
const OPAQUE_STATE = /^[A-Za-z0-9._~-]{16,512}$/;

/** How long a staged device-session transfer can wait for its claimed HTTPS callback. */
export const DEVICE_HANDOFF_LIFETIME_MS = 2 * 60_000;

/** Whether a native app state value satisfies the bounded opaque wire contract. */
export function isDeviceHandoffState(state: string): boolean {
  return OPAQUE_STATE.test(state);
}

function decodePublicKey(value: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.fromBase64(value, {
      alphabet: "base64url",
      lastChunkHandling: "loose",
    });
  } catch {
    throw new Error("Invalid device handoff key.");
  }
  if (bytes.length !== 65 || bytes[0] !== 4 ||
      bytes.toBase64({ alphabet: "base64url", omitPadding: true }) !== value) {
    throw new Error("Invalid device handoff key.");
  }
  return bytes;
}

/**
 * Encrypt a credential for the native app's per-attempt P-256 key. The caller keeps the result
 * server-side until a single-use, top-level callback delivers it to the claimed HTTPS app link.
 */
export async function sealDeviceSessionHandoff(
    publicKey: string,
    state: string,
    credential: DeviceSessionCredential,
    expiresAt = Date.now() + DEVICE_HANDOFF_LIFETIME_MS,
): Promise<DeviceSessionHandoff> {
  if (!isDeviceHandoffState(state)) throw new Error("Invalid device sign-in state.");
  const recipient = await crypto.subtle.importKey(
      "raw", decodePublicKey(publicKey), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ephemeral = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]) as CryptoKeyPair;
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
  const plaintext: DeviceSessionTransfer = { credential, expiresAt };
  const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(state) }, key,
      new TextEncoder().encode(JSON.stringify(plaintext)));
  return {
    publicKey: new Uint8Array(
        await crypto.subtle.exportKey("raw", ephemeral.publicKey) as ArrayBuffer)
        .toBase64({ alphabet: "base64url", omitPadding: true }),
    salt: salt.toBase64({ alphabet: "base64url", omitPadding: true }),
    iv: iv.toBase64({ alphabet: "base64url", omitPadding: true }),
    ciphertext: new Uint8Array(ciphertext).toBase64({ alphabet: "base64url", omitPadding: true }),
  };
}
