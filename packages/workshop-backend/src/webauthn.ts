// Verifies WebAuthn passkey registrations and assertions, over WebCrypto alone.
//
// The browser hands over everything this needs already decoded: the public key as DER
// SubjectPublicKeyInfo, its COSE algorithm number and the raw authenticator data. No attestation is
// asked for, so there is no CBOR and no X.509 to parse, and what is left to check is short enough
// to read line by line. The module is pure: it reads no storage and issues no challenge. Its
// callers do both, and tell it what a ceremony's answer must name.

import type {
  AdminPasskeyAssertion, AdminPasskeyRefusal, AdminPasskeyRegistration,
} from "@gadgets/workshop-shared/api";

/** A refused ceremony. `refusal` never reaches the caller, who is told only `passkeyRefused`; a
 * refused approval's audit record keeps it. */
export class PasskeyError extends Error {
  constructor(readonly refusal: AdminPasskeyRefusal) {
    super("The passkey answer was refused.");
  }
}

/** The longest credential id accepted, in base64url characters: WebAuthn bounds an id at 1023
 * bytes. Checked before an id is decoded or used as a storage key. */
export const MAX_CREDENTIAL_ID_LENGTH = 1364;

/** What a ceremony's answer must name: the challenge as issued (unpadded base64url), and the
 * deployment's origin and relying party id. */
export type PasskeyExpectation = { challenge: string; origin: string; rpId: string };

/** What the server keeps of a passkey to verify its assertions. */
export type PasskeyKey = { publicKey: Uint8Array; algorithm: number; signCount: number };

// The most bytes each field of an answer may hold. The RPC validator bounds no string's size, so
// decode() refuses a longer one by its length, before reading it.
const MAX_CLIENT_DATA_BYTES = 4096;
const MAX_AUTHENTICATOR_DATA_BYTES = 2048;
const MAX_SIGNATURE_BYTES = 1024;
const MAX_PUBLIC_KEY_BYTES = 1024;
const MAX_CREDENTIAL_ID_BYTES = 1023;

// The authenticator data's flags (WebAuthn "Authenticator Data").
const USER_PRESENT = 0x01;
const USER_VERIFIED = 0x04;
const BACKUP_ELIGIBLE = 0x08;
const BACKED_UP = 0x10;
const ATTESTED_CREDENTIAL = 0x40;
const EXTENSIONS = 0x80;

// The authenticator data's fixed part: the relying party id's hash (32 bytes), the flags (1) and
// the signature counter (4).
const FLAGS_OFFSET = 32;
const COUNTER_OFFSET = 33;
const FIXED_LENGTH = 37;

// The COSE algorithms accepted, by number: ES256 and RS256. `der` says the authenticator sends
// the signature as a DER sequence, where WebCrypto verifies the bare `r || s`.
const ALGORITHMS = new Map<number, {
  import: SubtleCryptoImportKeyAlgorithm;
  verify: SubtleCryptoSignAlgorithm;
  der: boolean;
}>([
  [-7, {
    import: { name: "ECDSA", namedCurve: "P-256" },
    verify: { name: "ECDSA", hash: "SHA-256" },
    der: true,
  }],
  [-257, {
    import: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    verify: { name: "RSASSA-PKCS1-v1_5" },
    der: false,
  }],
]);

// Decodes a field of at most `maxBytes` bytes from unpadded base64url, accepting only the one
// spelling an encoder produces.
function decode(text: string, maxBytes: number): Uint8Array {
  if (text.length > Math.ceil(maxBytes * 4 / 3)) throw new PasskeyError("malformed");
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.fromBase64(text, { alphabet: "base64url", lastChunkHandling: "loose" });
  } catch {
    throw new PasskeyError("malformed");
  }
  if (bytes.toBase64({ alphabet: "base64url", omitPadding: true }) !== text) {
    throw new PasskeyError("malformed");
  }
  return bytes;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

// The checks a registration and an assertion share: what the browser says it did (the client
// data), then what the authenticator says it did (the authenticator data's fixed part). Returns
// the flags, the signature counter and the bytes after the fixed part.
async function ceremony(
    type: "webauthn.create" | "webauthn.get", clientDataJSON: Uint8Array,
    authenticatorData: Uint8Array, expected: PasskeyExpectation,
): Promise<{ flags: number; signCount: number; rest: Uint8Array }> {
  let client: unknown;
  try {
    client = JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(clientDataJSON));
  } catch {
    throw new PasskeyError("malformed");
  }
  if (typeof client !== "object" || client === null || Array.isArray(client)) {
    throw new PasskeyError("malformed");
  }
  let { type: answered, challenge, origin, crossOrigin, topOrigin } =
      client as Record<string, unknown>;
  if (answered !== type) throw new PasskeyError("type");
  if (challenge !== expected.challenge) throw new PasskeyError("challenge");
  // A confirmation is never made from a frame, so a top origin of any value is refused too.
  if (origin !== expected.origin || crossOrigin === true || topOrigin !== undefined) {
    throw new PasskeyError("origin");
  }

  if (authenticatorData.length < FIXED_LENGTH) throw new PasskeyError("malformed");
  let rpIdHash = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(expected.rpId)));
  if (!sameBytes(rpIdHash, authenticatorData.subarray(0, FLAGS_OFFSET))) {
    throw new PasskeyError("relyingParty");
  }
  let flags = authenticatorData[FLAGS_OFFSET];
  if (!(flags & USER_PRESENT)) throw new PasskeyError("userPresence");
  if (!(flags & USER_VERIFIED)) throw new PasskeyError("userVerification");
  // A credential that cannot be backed up cannot be backed up already.
  if (!(flags & BACKUP_ELIGIBLE) && (flags & BACKED_UP)) throw new PasskeyError("malformed");
  let signCount = new DataView(authenticatorData.buffer, authenticatorData.byteOffset)
      .getUint32(COUNTER_OFFSET);
  return { flags, signCount, rest: authenticatorData.subarray(FIXED_LENGTH) };
}

// Imports a passkey's public key for verification. A key of an algorithm that is not accepted,
// one that is not a key of the algorithm it names, and an RSA key under 2048 bits are all refused
// "algorithm".
async function importKey(publicKey: Uint8Array, algorithmNumber: number) {
  let algorithm = ALGORITHMS.get(algorithmNumber);
  if (algorithm === undefined) throw new PasskeyError("algorithm");
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey("spki", publicKey, algorithm.import, false, ["verify"]);
  } catch {
    throw new PasskeyError("algorithm");
  }
  if ("modulusLength" in key.algorithm && key.algorithm.modulusLength < 2048) {
    throw new PasskeyError("algorithm");
  }
  return { key, algorithm };
}

// Rewrites an ECDSA signature from the DER `SEQUENCE { INTEGER r, INTEGER s }` an authenticator
// sends to the 64-byte `r || s` WebCrypto verifies. A P-256 signature never needs a long-form
// length, so the sequence's must be short-form, which leaves no room for a long-form one inside
// it.
function ecdsaSignatureFromDer(der: Uint8Array): Uint8Array {
  if (der.length < 2 || der[0] !== 0x30 || der[1] >= 0x80 || der[1] !== der.length - 2) {
    throw new PasskeyError("malformed");
  }
  let raw = new Uint8Array(64);
  let at = 2;
  for (let end of [32, 64]) {
    if (at + 2 > der.length || der[at] !== 0x02) throw new PasskeyError("malformed");
    let next = at + 2 + der[at + 1];
    if (next > der.length) throw new PasskeyError("malformed");
    let integer = der.subarray(at + 2, next);
    while (integer[0] === 0) integer = integer.subarray(1);
    if (integer.length > 32) throw new PasskeyError("malformed");
    raw.set(integer, end - integer.length);
    at = next;
  }
  if (at !== der.length) throw new PasskeyError("malformed");
  return raw;
}

/** Checks a registration (WebAuthn "Registering a New Credential", for attestation "none") and
 * returns the key to keep: the one the browser reported (getPublicKey()). It is not compared with
 * the COSE key inside the authenticator data: with attestation "none" nothing signs a
 * registration, so both are whatever the enrolling session presents and the comparison would bind
 * nothing. What binds a passkey is that every later assertion must verify under this key. Throws
 * PasskeyError. */
export async function verifyPasskeyRegistration(
    registration: AdminPasskeyRegistration, expected: PasskeyExpectation): Promise<PasskeyKey> {
  let { flags, signCount, rest } = await ceremony(
      "webauthn.create", decode(registration.clientDataJSON, MAX_CLIENT_DATA_BYTES),
      decode(registration.authenticatorData, MAX_AUTHENTICATOR_DATA_BYTES), expected);

  // The attested credential data: a 16-byte AAGUID, the credential id's length in two bytes, the
  // id, then the COSE key, which is not read.
  if (!(flags & ATTESTED_CREDENTIAL) || rest.length < 18) throw new PasskeyError("malformed");
  let idLength = rest[16] << 8 | rest[17];
  let id = rest.subarray(18, 18 + idLength);
  // The id the answer names must be the one attested, whole and not empty. decode() bounds the
  // named one, so an attested id over WebAuthn's bound equals none it accepts.
  let named = decode(registration.credentialId, MAX_CREDENTIAL_ID_BYTES);
  if (idLength < 1 || id.length !== idLength || !sameBytes(id, named)) {
    throw new PasskeyError("credential");
  }

  let publicKey = decode(registration.publicKey, MAX_PUBLIC_KEY_BYTES);
  await importKey(publicKey, registration.publicKeyAlgorithm);
  return { publicKey, algorithm: registration.publicKeyAlgorithm, signCount };
}

/** Checks an assertion made by `passkey` (WebAuthn "Verifying an Authentication Assertion") and
 * returns its signature counter, to store. Never reads `assertion.credentialId`: finding the
 * passkey, and whose it is, is the caller's job. Throws PasskeyError. */
export async function verifyPasskeyAssertion(assertion: AdminPasskeyAssertion, passkey: PasskeyKey,
    expected: PasskeyExpectation): Promise<number> {
  let clientDataJSON = decode(assertion.clientDataJSON, MAX_CLIENT_DATA_BYTES);
  let authenticatorData = decode(assertion.authenticatorData, MAX_AUTHENTICATOR_DATA_BYTES);
  let { flags, signCount, rest } =
      await ceremony("webauthn.get", clientDataJSON, authenticatorData, expected);

  // An assertion carries no attested credential data, and nothing after the fixed part unless it
  // flags extensions. Those are accepted unread: the signature covers them.
  if ((flags & ATTESTED_CREDENTIAL) || (rest.length > 0 && !(flags & EXTENSIONS))) {
    throw new PasskeyError("malformed");
  }

  let { key, algorithm } = await importKey(passkey.publicKey, passkey.algorithm);
  let signature = decode(assertion.signature, MAX_SIGNATURE_BYTES);
  if (algorithm.der) signature = ecdsaSignatureFromDer(signature);
  // What the authenticator signed: its data, then the SHA-256 of the client data.
  let signed = new Uint8Array(authenticatorData.length + 32);
  signed.set(authenticatorData);
  signed.set(new Uint8Array(await crypto.subtle.digest("SHA-256", clientDataJSON)),
      authenticatorData.length);
  if (!await crypto.subtle.verify(algorithm.verify, key, signature, signed)) {
    throw new PasskeyError("signature");
  }

  // An authenticator that keeps a counter raises it with every assertion, so one that did not rise
  // is a replay or a clone. One that keeps none always reports zero.
  if ((passkey.signCount !== 0 || signCount !== 0) && signCount <= passkey.signCount) {
    throw new PasskeyError("counter");
  }
  return signCount;
}
