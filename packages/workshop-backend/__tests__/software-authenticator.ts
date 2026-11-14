// A software WebAuthn authenticator for tests: one WebCrypto key pair that answers enrolment and
// confirmation challenges as a browser and its authenticator would, and can falsify one part of an
// answer on request. It uses only crypto.subtle, btoa and typed arrays, so it runs in workerd and
// in Node alike.

import type {
  AdminPasskeyAssertion, AdminPasskeyChallenge, AdminPasskeyRegistration,
} from "@gadgets/workshop-shared/api";

/** What a test may falsify in one ceremony. `flags` are OR-ed into the authenticator data's flag
 * byte, and `trailing` is appended to the authenticator data, both before signing. */
export type Tamper = {
  type?: string;
  challenge?: string;
  origin?: string;
  crossOrigin?: boolean;
  rpId?: string;
  userPresent?: boolean;
  userVerified?: boolean;
  signCount?: number;
  flags?: number;
  trailing?: Uint8Array;
};

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  let joined = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let at = 0;
  for (let part of parts) {
    joined.set(part, at);
    at += part.length;
  }
  return joined;
}

// A text's UTF-8 bytes in a buffer of their own: the one shape that Node's and the Workers'
// typings of crypto.subtle both take.
function utf8(text: string): Uint8Array<ArrayBuffer> {
  return concat(new TextEncoder().encode(text));
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (let byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

// One unsigned big-endian number as a DER INTEGER: its leading zeros dropped, then one put back
// when the top bit is set, which would otherwise read as a sign.
function derInteger(value: Uint8Array): Uint8Array {
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) start++;
  let digits = value.subarray(start);
  if (digits[0] & 0x80) digits = concat(Uint8Array.of(0), digits);
  return concat(Uint8Array.of(0x02, digits.length), digits);
}

// WebCrypto's ECDSA signature, the 64-byte `r || s`, as the DER sequence an authenticator sends.
function ecdsaSignatureToDer(raw: Uint8Array): Uint8Array {
  let integers = concat(derInteger(raw.subarray(0, 32)), derInteger(raw.subarray(32)));
  return concat(Uint8Array.of(0x30, integers.length), integers);
}

/**
 * Makes an authenticator holding one passkey for `origin`: ES256 (-7) unless `algorithm` says
 * RS256 (-257). Its signature counter goes up by one with every ceremony. A tampered assertion is
 * still signed over its tampered bytes, so a refusal comes from the check the tampering targets
 * and not from a broken signature.
 */
export async function softwareAuthenticator(
    options: { origin: string; algorithm?: -7 | -257 },
): Promise<{
  credentialId: string;
  register(challenge: AdminPasskeyChallenge, tamper?: Tamper): Promise<AdminPasskeyRegistration>;
  assert(challenge: AdminPasskeyChallenge, tamper?: Tamper): Promise<AdminPasskeyAssertion>;
}> {
  let ecdsa = (options.algorithm ?? -7) === -7;
  let keys = await crypto.subtle.generateKey(
      ecdsa
          ? { name: "ECDSA", namedCurve: "P-256" }
          : { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
              publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true, ["sign", "verify"]) as CryptoKeyPair;
  let id = crypto.getRandomValues(new Uint8Array(32));
  let credentialId = base64url(id);
  let signCount = 0;

  function clientData(type: string, challenge: AdminPasskeyChallenge, tamper: Tamper) {
    return utf8(JSON.stringify({
      type: tamper.type ?? type,
      challenge: tamper.challenge ?? challenge.challenge,
      origin: tamper.origin ?? options.origin,
      crossOrigin: tamper.crossOrigin ?? false,
    }));
  }

  // The authenticator data: the relying party id's hash, the flags, the counter, then the
  // attested credential data when the ceremony creates the passkey.
  async function authenticatorData(
      challenge: AdminPasskeyChallenge, tamper: Tamper, attested?: Uint8Array) {
    signCount++;
    let flags = ((tamper.userPresent ?? true) ? 0x01 : 0) |
        ((tamper.userVerified ?? true) ? 0x04 : 0) | (attested ? 0x40 : 0) | (tamper.flags ?? 0);
    let counter = new Uint8Array(4);
    new DataView(counter.buffer).setUint32(0, tamper.signCount ?? signCount);
    return concat(
        await sha256(utf8(tamper.rpId ?? challenge.rpId)), Uint8Array.of(flags), counter,
        attested ?? new Uint8Array(0), tamper.trailing ?? new Uint8Array(0));
  }

  return {
    credentialId,

    async register(challenge, tamper = {}) {
      // A zero AAGUID, the id's length and the id, then an empty CBOR map where the COSE key goes.
      let attested = concat(
          new Uint8Array(16), Uint8Array.of(id.length >> 8, id.length & 0xff), id,
          Uint8Array.of(0xa0));
      let publicKey = await crypto.subtle.exportKey("spki", keys.publicKey) as ArrayBuffer;
      return {
        credentialId,
        clientDataJSON: base64url(clientData("webauthn.create", challenge, tamper)),
        authenticatorData: base64url(await authenticatorData(challenge, tamper, attested)),
        publicKey: base64url(new Uint8Array(publicKey)),
        publicKeyAlgorithm: ecdsa ? -7 : -257,
      };
    },

    async assert(challenge, tamper = {}) {
      let clientDataJSON = clientData("webauthn.get", challenge, tamper);
      let data = await authenticatorData(challenge, tamper);
      let signature = new Uint8Array(await crypto.subtle.sign(
          ecdsa ? { name: "ECDSA", hash: "SHA-256" } : { name: "RSASSA-PKCS1-v1_5" },
          keys.privateKey, concat(data, await sha256(clientDataJSON))));
      return {
        credentialId,
        clientDataJSON: base64url(clientDataJSON),
        authenticatorData: base64url(data),
        signature: base64url(ecdsa ? ecdsaSignatureToDer(signature) : signature),
      };
    },
  };
}
