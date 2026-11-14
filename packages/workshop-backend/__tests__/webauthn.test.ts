import { beforeAll, describe, expect, it } from "vitest";
import type {
  AdminPasskeyChallenge, AdminPasskeyRegistration,
} from "@gadgets/workshop-shared/api";
import {
  MAX_CREDENTIAL_ID_LENGTH, PasskeyError, verifyPasskeyAssertion, verifyPasskeyRegistration,
  type PasskeyExpectation, type PasskeyKey,
} from "../src/webauthn";
import { softwareAuthenticator, type Tamper } from "./software-authenticator";

const ORIGIN = "https://workshop.example";
const RP_ID = "workshop.example";

type Authenticator = Awaited<ReturnType<typeof softwareAuthenticator>>;

function encode(bytes: Uint8Array): string {
  return bytes.toBase64({ alphabet: "base64url", omitPadding: true });
}

function decode(text: string): Uint8Array {
  return Uint8Array.fromBase64(text, { alphabet: "base64url" });
}

function random(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

function join(...parts: Uint8Array[]): Uint8Array {
  let joined = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let at = 0;
  for (let part of parts) {
    joined.set(part, at);
    at += part.length;
  }
  return joined;
}

/** A base64url value with `fill` bytes after it, so that it holds `length` bytes. */
function padded(text: string, length: number, fill: number): string {
  let bytes = decode(text);
  return encode(join(bytes, new Uint8Array(length - bytes.length).fill(fill)));
}

/** A DER ECDSA signature with leading zeros on its two integers, so that the sequence holds
 * `length` bytes. */
function zeroPadded(der: Uint8Array, length: number): Uint8Array {
  let r = der.subarray(4, 4 + der[3]);
  let s = der.subarray(6 + der[3]);
  let rLength = Math.floor(length / 2) - 2;
  let sLength = length - rLength - 4;
  return join(
      Uint8Array.of(0x30, length, 0x02, rLength), new Uint8Array(rLength - r.length), r,
      Uint8Array.of(0x02, sLength), new Uint8Array(sLength - s.length), s);
}

/** A challenge as the server issues one, and what an answer to it must name. */
function issue(challenge = encode(random(32))):
    { challenge: AdminPasskeyChallenge; expected: PasskeyExpectation } {
  return {
    challenge: {
      challenge, rpId: RP_ID, credentialIds: [], expiresAt: new Date(Date.now() + 60_000),
    },
    expected: { challenge, origin: ORIGIN, rpId: RP_ID },
  };
}

/** The backup flags a passkey may report: one that can be synced between devices sets BE, and
 * sets BS as well once it is. */
const BACKUP_FLAGS: [string, number][] = [
  ["can be backed up", 0x08],
  ["is backed up", 0x18],
];

/** The refusal an attempt ends in, or "accepted". Anything but a PasskeyError is rethrown. */
async function refusalOf(attempt: Promise<unknown>): Promise<string> {
  try {
    await attempt;
  } catch (error) {
    if (error instanceof PasskeyError) return error.refusal;
    throw error;
  }
  return "accepted";
}

/** Enrols the authenticator's passkey and returns what the server keeps of it. */
async function enrol(authenticator: Authenticator): Promise<PasskeyKey> {
  let { challenge, expected } = issue();
  return await verifyPasskeyRegistration(await authenticator.register(challenge), expected);
}

it("bounds a credential id at the base64url length of 1023 bytes", () => {
  expect(MAX_CREDENTIAL_ID_LENGTH).toBe(1364);
  expect(encode(new Uint8Array(1023))).toHaveLength(MAX_CREDENTIAL_ID_LENGTH);
});

it("keeps the refusal out of the error's message", async () => {
  let authenticator = await softwareAuthenticator({ origin: ORIGIN });
  let { challenge, expected } = issue();
  let error = await verifyPasskeyRegistration(
      await authenticator.register(challenge, { origin: "https://elsewhere.example" }), expected)
      .catch((thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(PasskeyError);
  expect((error as PasskeyError).refusal).toBe("origin");
  expect((error as PasskeyError).message).not.toContain("origin");
});

describe.each([
  { name: "ES256", algorithm: -7 },
  { name: "RS256", algorithm: -257 },
] as const)("$name passkeys", ({ algorithm }) => {
  let authenticator: Authenticator;
  let another: Authenticator;

  beforeAll(async () => {
    authenticator = await softwareAuthenticator({ origin: ORIGIN, algorithm });
    another = await softwareAuthenticator({ origin: ORIGIN, algorithm });
  });

  /** The refusal of a registration that is valid but for what `falsify` changes in it, or
   * "accepted". */
  async function refusalWith(
      falsify: (registration: AdminPasskeyRegistration) => Partial<AdminPasskeyRegistration>,
  ): Promise<string> {
    let { challenge, expected } = issue();
    let registration = await authenticator.register(challenge);
    expect(await refusalOf(verifyPasskeyRegistration(registration, expected))).toBe("accepted");
    return await refusalOf(verifyPasskeyRegistration(
        { ...registration, ...falsify(registration) }, expected));
  }

  describe("registration", () => {
    it("is accepted, returning the reported key, its algorithm and the count", async () => {
      let { challenge, expected } = issue();
      let registration = await authenticator.register(challenge);
      // The helper puts an empty CBOR map where the COSE key goes, so an accepted registration
      // shows that the bytes after the credential id are not read.
      expect(decode(registration.authenticatorData).at(-1)).toBe(0xa0);

      let key = await verifyPasskeyRegistration(registration, expected);
      expect(key.publicKey).toEqual(decode(registration.publicKey));
      expect(key.algorithm).toBe(algorithm);
      expect(key.signCount).toBeGreaterThan(0);
      expect(key.signCount)
          .toBe(new DataView(decode(registration.authenticatorData).buffer).getUint32(33));
    });

    it.each<[string, Tamper, string]>([
      ["a wrong challenge", { challenge: encode(random(32)) }, "challenge"],
      ["a wrong origin", { origin: "https://elsewhere.example" }, "origin"],
      ["an origin that differs only by its port", { origin: `${ORIGIN}:8443` }, "origin"],
      ["a cross-origin frame", { crossOrigin: true }, "origin"],
      ["a wrong relying party", { rpId: "elsewhere.example" }, "relyingParty"],
      ["missing user verification", { userVerified: false }, "userVerification"],
      ["missing user presence", { userPresent: false }, "userPresence"],
      ["the type of an assertion", { type: "webauthn.get" }, "type"],
      ["a backed-up flag on a credential that cannot be backed up", { flags: 0x10 }, "malformed"],
    ])("is refused for %s", async (_what, tamper, refusal) => {
      let { challenge, expected } = issue();
      let registration = await authenticator.register(challenge, tamper);
      expect(await refusalOf(verifyPasskeyRegistration(registration, expected))).toBe(refusal);
    });

    it.each(BACKUP_FLAGS)("is accepted for a passkey that %s", async (_what, flags) => {
      let { challenge, expected } = issue();
      let registration = await authenticator.register(challenge, { flags });
      expect(decode(registration.authenticatorData)[32] & 0x18).toBe(flags);
      expect(await refusalOf(verifyPasskeyRegistration(registration, expected))).toBe("accepted");
    });

    it("is refused for a relying party hash that differs only in its last byte", async () => {
      expect(await refusalWith(registration => {
        let data = decode(registration.authenticatorData);
        data[31] ^= 0x01;
        return { authenticatorData: encode(data) };
      })).toBe("relyingParty");
    });

    it("is refused for a credential id that differs from the authenticator data's", async () => {
      expect(await refusalWith(() => ({ credentialId: encode(random(32)) }))).toBe("credential");
      // The longest id allowed is still compared, and still differs.
      let longest = encode(random(1023));
      expect(longest).toHaveLength(MAX_CREDENTIAL_ID_LENGTH);
      expect(await refusalWith(() => ({ credentialId: longest }))).toBe("credential");
    });

    it("is refused for a credential id that is the attested one but for a byte", async () => {
      // One byte more, one byte less, and the last byte changed: the ids are compared whole.
      let id = decode(authenticator.credentialId);
      expect(id).toHaveLength(32);
      let changed = id.slice();
      changed[31] ^= 0x01;
      for (let named of [join(id, Uint8Array.of(0)), id.subarray(0, 31), changed]) {
        expect(await refusalWith(() => ({ credentialId: encode(named) }))).toBe("credential");
      }
    });

    it("is accepted for the shortest and the longest credential id", async () => {
      // The longest id's length, 0x03ff, takes both of the two bytes it is written in.
      for (let length of [1, 1023]) {
        let id = random(length);
        expect(await refusalWith(registration => ({
          authenticatorData: encode(join(
              decode(registration.authenticatorData).subarray(0, 37 + 16),
              Uint8Array.of(length >> 8, length & 0xff), id, Uint8Array.of(0xa0))),
          credentialId: encode(id),
        }))).toBe("accepted");
      }
    });

    it("is refused unread for a credential id over the bound", async () => {
      // One byte over the bound is two characters over it.
      let oneOver = encode(random(1024));
      expect(oneOver).toHaveLength(MAX_CREDENTIAL_ID_LENGTH + 2);
      expect(await refusalWith(() => ({ credentialId: oneOver }))).toBe("malformed");
      let tooLong = encode(random(1026));
      expect(tooLong).toHaveLength(1368);
      expect(await refusalWith(() => ({ credentialId: tooLong }))).toBe("malformed");
    });

    it("is refused for a credential id that is not wholly in the authenticator data", async () => {
      // The data is cut 20 bytes into its 32-byte id, and the answer names those 20 bytes.
      expect(await refusalWith(registration => {
        let data = decode(registration.authenticatorData);
        return {
          authenticatorData: encode(data.subarray(0, 37 + 18 + 20)),
          credentialId: encode(data.subarray(37 + 18, 37 + 18 + 20)),
        };
      })).toBe("credential");
    });

    it("is refused for an empty credential id", async () => {
      expect(await refusalWith(registration => ({
        authenticatorData: encode(join(
            decode(registration.authenticatorData).subarray(0, 37 + 16),
            Uint8Array.of(0, 0, 0xa0))),
        credentialId: "",
      }))).toBe("credential");
    });

    it("is refused for an algorithm that is not accepted", async () => {
      expect(await refusalWith(() => ({ publicKeyAlgorithm: -8 }))).toBe("algorithm");
    });

    it("is refused for a public key that is not SPKI", async () => {
      expect(await refusalWith(() => ({ publicKey: encode(random(91)) }))).toBe("algorithm");
    });

    it("is refused for a key of the other algorithm", async () => {
      expect(await refusalWith(() => ({ publicKeyAlgorithm: algorithm === -7 ? -257 : -7 })))
          .toBe("algorithm");
    });

    it("is refused for a 1024-bit RSA key", async () => {
      let weak = await crypto.subtle.generateKey(
          { name: "RSASSA-PKCS1-v1_5", modulusLength: 1024,
            publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
          true, ["sign", "verify"]) as CryptoKeyPair;
      let publicKey = encode(new Uint8Array(
          await crypto.subtle.exportKey("spki", weak.publicKey) as ArrayBuffer));
      expect(await refusalWith(() => ({ publicKey, publicKeyAlgorithm: -257 }))).toBe("algorithm");
    });

    it("is refused for base64url that is not canonical", async () => {
      // Padded, in the standard alphabet, and with bits set past the last whole byte.
      expect(await refusalWith(() => ({ clientDataJSON: "e30=" }))).toBe("malformed");
      expect(await refusalWith(() => ({ authenticatorData: "+/+/" }))).toBe("malformed");
      expect(await refusalWith(() => ({ publicKey: "AB" }))).toBe("malformed");
      expect(await refusalWith(registration => (
          { authenticatorData: `${registration.authenticatorData}=` }))).toBe("malformed");
      expect(await refusalWith(registration => (
          { credentialId: `${registration.credentialId}=` }))).toBe("malformed");
    });

    it("is refused for client data that is not a JSON object", async () => {
      for (let text of ["", "null", "[]", "\"webauthn.create\"", "{"]) {
        let clientDataJSON = encode(new TextEncoder().encode(text));
        expect(await refusalWith(() => ({ clientDataJSON }))).toBe("malformed");
      }
    });

    it("is refused for client data that is not UTF-8", async () => {
      // One stray byte inside a string of a member nothing reads: JSON to a lenient decoder.
      let text = new TextEncoder();
      expect(await refusalWith(registration => ({
        clientDataJSON: encode(join(
            text.encode("{\"extra\":\""), Uint8Array.of(0xff), text.encode("\","),
            decode(registration.clientDataJSON).subarray(1))),
      }))).toBe("malformed");
    });

    it("is accepted for client data after a byte order mark, as UTF-8 decoding strips one",
        async () => {
      expect(await refusalWith(registration => ({
        clientDataJSON: encode(join(
            Uint8Array.of(0xef, 0xbb, 0xbf), decode(registration.clientDataJSON))),
      }))).toBe("accepted");
    });

    it("is accepted for client data that does not say whether it crossed origins", async () => {
      // The member is optional, and only its being true tells of a frame.
      expect(await refusalWith(registration => {
        let client = JSON.parse(new TextDecoder().decode(decode(registration.clientDataJSON)));
        expect(client.crossOrigin).toBe(false);
        delete client.crossOrigin;
        return { clientDataJSON: encode(new TextEncoder().encode(JSON.stringify(client))) };
      })).toBe("accepted");
    });

    it("is refused for client data that names a top origin", async () => {
      expect(await refusalWith(registration => {
        let client = JSON.parse(new TextDecoder().decode(decode(registration.clientDataJSON)));
        return { clientDataJSON: encode(new TextEncoder().encode(
            JSON.stringify({ ...client, topOrigin: ORIGIN }))) };
      })).toBe("origin");
    });

    it("is refused for truncated authenticator data", async () => {
      for (let length of [0, 36, 37, 37 + 17]) {
        expect(await refusalWith(({ authenticatorData }) => (
            { authenticatorData: encode(decode(authenticatorData).subarray(0, length)) })))
            .toBe("malformed");
      }
    });

    it("is refused for authenticator data without attested credential data", async () => {
      expect(await refusalWith(registration => {
        let data = decode(registration.authenticatorData);
        data[32] &= ~0x40;
        return { authenticatorData: encode(data) };
      })).toBe("malformed");
    });

    it("is accepted with extension data after the attested credential data", async () => {
      // An authenticator may report extension output when a passkey is made. It follows the COSE
      // key, so it is not read either.
      let { challenge, expected } = issue();
      let registration = await authenticator.register(
          challenge, { flags: 0x80, trailing: Uint8Array.of(0xa0) });
      expect(decode(registration.authenticatorData)[32] & 0x80).toBe(0x80);
      expect(await refusalOf(verifyPasskeyRegistration(registration, expected))).toBe("accepted");
    });

    it("is refused for a field one byte over its bound", async () => {
      // Client data keeps its meaning with spaces after it, and nothing after the credential id
      // is read, so both are accepted at their bounds.
      expect(await refusalWith(registration => (
          { clientDataJSON: padded(registration.clientDataJSON, 4096, 0x20) }))).toBe("accepted");
      expect(await refusalWith(registration => (
          { clientDataJSON: padded(registration.clientDataJSON, 4097, 0x20) }))).toBe("malformed");
      expect(await refusalWith(registration => (
          { authenticatorData: padded(registration.authenticatorData, 2048, 0) })))
          .toBe("accepted");
      expect(await refusalWith(registration => (
          { authenticatorData: padded(registration.authenticatorData, 2049, 0) })))
          .toBe("malformed");
      // A key at the bound is read, and found not to be one.
      expect(await refusalWith(() => ({ publicKey: encode(random(1024)) }))).toBe("algorithm");
      expect(await refusalWith(() => ({ publicKey: encode(random(1025)) }))).toBe("malformed");
    });
  });

  describe("assertion", () => {
    it("is accepted 40 times in a row, the count rising each time", async () => {
      let passkey = await enrol(authenticator);
      for (let turn = 0; turn < 40; turn++) {
        let { challenge, expected } = issue();
        let signCount = await verifyPasskeyAssertion(
            await authenticator.assert(challenge), passkey, expected);
        expect(signCount).toBe(passkey.signCount + 1);
        passkey = { ...passkey, signCount };
      }
    });

    it.each<[string, Tamper, string]>([
      ["a wrong challenge", { challenge: encode(random(32)) }, "challenge"],
      ["a wrong origin", { origin: "https://elsewhere.example" }, "origin"],
      ["a cross-origin frame", { crossOrigin: true }, "origin"],
      ["a wrong relying party", { rpId: "elsewhere.example" }, "relyingParty"],
      ["missing user verification", { userVerified: false }, "userVerification"],
      ["missing user presence", { userPresent: false }, "userPresence"],
      ["the type of a registration", { type: "webauthn.create" }, "type"],
      ["attested credential data", { flags: 0x40 }, "malformed"],
      ["a byte after the fixed part with no extensions flagged", { trailing: Uint8Array.of(0) },
        "malformed"],
      ["a backed-up flag on a credential that cannot be backed up", { flags: 0x10 }, "malformed"],
    ])("is refused for %s", async (_what, tamper, refusal) => {
      let passkey = await enrol(authenticator);
      let { challenge, expected } = issue();
      let assertion = await authenticator.assert(challenge, tamper);
      expect(await refusalOf(verifyPasskeyAssertion(assertion, passkey, expected))).toBe(refusal);
    });

    it("is refused for a challenge that differs only in the digest it ends with", async () => {
      let passkey = await enrol(authenticator);
      let nonce = random(32);
      let { challenge, expected } = issue(encode(join(nonce, random(32))));
      let assertion = await authenticator.assert(
          challenge, { challenge: encode(join(nonce, random(32))) });
      expect(await refusalOf(verifyPasskeyAssertion(assertion, passkey, expected)))
          .toBe("challenge");
    });

    it("is refused for a challenge that differs only in the nonce it starts with", async () => {
      // The answer to another challenge for the same request. From a passkey that keeps no count,
      // the nonce is all that tells the two answers apart.
      let passkey = await enrol(authenticator);
      let digest = random(32);
      let { challenge, expected } = issue(encode(join(random(32), digest)));
      let assertion = await authenticator.assert(
          challenge, { challenge: encode(join(random(32), digest)) });
      expect(await refusalOf(verifyPasskeyAssertion(assertion, passkey, expected)))
          .toBe("challenge");
    });

    it("is refused when replayed", async () => {
      let passkey = await enrol(authenticator);
      let { challenge, expected } = issue();
      let assertion = await authenticator.assert(challenge);
      let signCount = await verifyPasskeyAssertion(assertion, passkey, expected);
      expect(await refusalOf(
          verifyPasskeyAssertion(assertion, { ...passkey, signCount }, expected))).toBe("counter");
    });

    it("is refused for a count that did not rise", async () => {
      let passkey = await enrol(authenticator);
      for (let signCount of [passkey.signCount, passkey.signCount - 1, 0]) {
        let { challenge, expected } = issue();
        let assertion = await authenticator.assert(challenge, { signCount });
        expect(await refusalOf(verifyPasskeyAssertion(assertion, passkey, expected)))
            .toBe("counter");
      }
    });

    it("is accepted with a count that sets the top of its 32 bits", async () => {
      // The count is unsigned: 2^31 is a rise, and so is the largest count after it.
      let passkey = await enrol(authenticator);
      for (let signCount of [0x80000000, 0xffffffff]) {
        let { challenge, expected } = issue();
        let assertion = await authenticator.assert(challenge, { signCount });
        expect(await verifyPasskeyAssertion(assertion, passkey, expected)).toBe(signCount);
        passkey = { ...passkey, signCount };
      }
    });

    it.each(BACKUP_FLAGS)("is accepted from a passkey that %s", async (_what, flags) => {
      let passkey = await enrol(authenticator);
      let { challenge, expected } = issue();
      let assertion = await authenticator.assert(challenge, { flags });
      expect(decode(assertion.authenticatorData)[32] & 0x18).toBe(flags);
      expect(await verifyPasskeyAssertion(assertion, passkey, expected))
          .toBe(passkey.signCount + 1);
    });

    it("is accepted repeatedly from an authenticator that keeps no count", async () => {
      let passkey = { ...await enrol(authenticator), signCount: 0 };
      for (let turn = 0; turn < 3; turn++) {
        let { challenge, expected } = issue();
        let assertion = await authenticator.assert(challenge, { signCount: 0 });
        expect(await verifyPasskeyAssertion(assertion, passkey, expected)).toBe(0);
      }
    });

    it("is refused under another authenticator's key", async () => {
      let passkey = await enrol(authenticator);
      let { challenge, expected } = issue();
      let assertion = await another.assert(challenge, { signCount: passkey.signCount + 1 });
      expect(await refusalOf(verifyPasskeyAssertion(assertion, passkey, expected)))
          .toBe("signature");
    });

    it("is refused for one flipped signature bit", async () => {
      let passkey = await enrol(authenticator);
      let { challenge, expected } = issue();
      let assertion = await authenticator.assert(challenge);
      let signature = decode(assertion.signature);
      signature[signature.length - 1] ^= 0x01;
      expect(await refusalOf(verifyPasskeyAssertion(
          { ...assertion, signature: encode(signature) }, passkey, expected))).toBe("signature");
    });

    it("is refused for signed bytes that were changed afterwards", async () => {
      let passkey = await enrol(authenticator);
      let { challenge, expected } = issue();
      let assertion = await authenticator.assert(challenge);
      // The count is covered by the signature, so raising it after the fact breaks it.
      let data = decode(assertion.authenticatorData);
      data[36] ^= 0x01;
      expect(await refusalOf(verifyPasskeyAssertion(
          { ...assertion, authenticatorData: encode(data) }, passkey, expected))).toBe("signature");
      // So is the client data: a space after it changes its hash, not its meaning.
      let clientDataJSON = encode(join(decode(assertion.clientDataJSON), Uint8Array.of(0x20)));
      expect(await refusalOf(verifyPasskeyAssertion(
          { ...assertion, clientDataJSON }, passkey, expected))).toBe("signature");
    });

    it("is refused for bytes after the signature", async () => {
      let passkey = await enrol(authenticator);
      let { challenge, expected } = issue();
      let assertion = await authenticator.assert(challenge);
      let signature = encode(join(decode(assertion.signature), Uint8Array.of(0)));
      // A DER signature is refused as it is read, a bare RSA one when it does not verify.
      expect(await refusalOf(
          verifyPasskeyAssertion({ ...assertion, signature }, passkey, expected)))
          .toBe(algorithm === -7 ? "malformed" : "signature");
    });

    it("is refused unread for a signature one byte over its bound", async () => {
      let passkey = await enrol(authenticator);
      let { challenge, expected } = issue();
      let assertion = await authenticator.assert(challenge);
      // A signature at the bound is read: a DER one is refused as it is read, a bare RSA one when
      // it does not verify.
      expect(await refusalOf(verifyPasskeyAssertion(
          { ...assertion, signature: encode(random(1024)) }, passkey, expected)))
          .toBe(algorithm === -7 ? "malformed" : "signature");
      expect(await refusalOf(verifyPasskeyAssertion(
          { ...assertion, signature: encode(random(1025)) }, passkey, expected))).toBe("malformed");
    });

    it("is refused unread for client data or authenticator data one byte over its bound",
        async () => {
      let passkey = await enrol(authenticator);
      let { challenge, expected } = issue();
      let assertion = await authenticator.assert(challenge);
      // Client data at its bound is read: the spaces after it change its hash, so the signature
      // does not verify.
      expect(await refusalOf(verifyPasskeyAssertion(
          { ...assertion, clientDataJSON: padded(assertion.clientDataJSON, 4096, 0x20) },
          passkey, expected))).toBe("signature");
      expect(await refusalOf(verifyPasskeyAssertion(
          { ...assertion, clientDataJSON: padded(assertion.clientDataJSON, 4097, 0x20) },
          passkey, expected))).toBe("malformed");
      // The authenticator data is padded before it is signed, as extension data, so at its bound
      // it is accepted.
      let atBound = await authenticator.assert(
          challenge, { flags: 0x80, trailing: new Uint8Array(2048 - 37) });
      expect(decode(atBound.authenticatorData)).toHaveLength(2048);
      expect(await refusalOf(verifyPasskeyAssertion(atBound, passkey, expected))).toBe("accepted");
      let oneOver = await authenticator.assert(
          challenge, { flags: 0x80, trailing: new Uint8Array(2049 - 37) });
      expect(decode(oneOver.authenticatorData)).toHaveLength(2049);
      expect(await refusalOf(verifyPasskeyAssertion(oneOver, passkey, expected)))
          .toBe("malformed");
    });

    it("is refused under a stored key of an algorithm that is not accepted", async () => {
      let passkey = await enrol(authenticator);
      let { challenge, expected } = issue();
      let assertion = await authenticator.assert(challenge);
      expect(await refusalOf(verifyPasskeyAssertion(
          assertion, { ...passkey, algorithm: -8 }, expected))).toBe("algorithm");
    });

    it("is accepted with extension data when the extensions flag is set", async () => {
      let passkey = await enrol(authenticator);
      let { challenge, expected } = issue();
      let assertion = await authenticator.assert(
          challenge, { flags: 0x80, trailing: Uint8Array.of(0xa0) });
      expect(decode(assertion.authenticatorData)).toHaveLength(38);
      expect(await verifyPasskeyAssertion(assertion, passkey, expected))
          .toBe(passkey.signCount + 1);
    });

    it("never reads the credential id the answer names", async () => {
      let passkey = await enrol(authenticator);
      let { challenge, expected } = issue();
      let assertion = { ...await authenticator.assert(challenge), credentialId: "not base64url!" };
      expect(await verifyPasskeyAssertion(assertion, passkey, expected))
          .toBe(passkey.signCount + 1);
    });
  });
});

describe("an ES256 signature's DER encoding", () => {
  let authenticator: Authenticator;

  beforeAll(async () => {
    authenticator = await softwareAuthenticator({ origin: ORIGIN });
  });

  /** The refusal of an assertion whose signature `rewrite` replaced, or "accepted". */
  async function refusalWith(rewrite: (der: Uint8Array) => Uint8Array): Promise<string> {
    let passkey = await enrol(authenticator);
    let { challenge, expected } = issue();
    let assertion = await authenticator.assert(challenge);
    let signature = encode(rewrite(decode(assertion.signature)));
    return await refusalOf(verifyPasskeyAssertion({ ...assertion, signature }, passkey, expected));
  }

  it("is accepted with an integer shorter than 32 bytes", async () => {
    let passkey = await enrol(authenticator);
    // About one signature in 128 has an r or an s whose top byte is zero.
    for (let attempt = 0; attempt < 5000; attempt++) {
      let { challenge, expected } = issue();
      let assertion = await authenticator.assert(challenge);
      let der = decode(assertion.signature);
      if (Math.min(der[3], der[5 + der[3]]) >= 32) continue;
      expect(await verifyPasskeyAssertion(assertion, passkey, expected))
          .toBeGreaterThan(passkey.signCount);
      return;
    }
    expect.unreachable("no signature in 5000 had a short integer");
  });

  it("is accepted with further leading zeros on its integers", async () => {
    // As many as a short-form length holds.
    expect(await refusalWith(der => zeroPadded(der, 0x7f))).toBe("accepted");
  });

  it("is refused as malformed for a length that only the long form holds", async () => {
    // 0x80 and 0x81 are the sequence's true lengths here, and are not short-form lengths.
    expect(await refusalWith(der => zeroPadded(der, 0x80))).toBe("malformed");
    expect(await refusalWith(der => zeroPadded(der, 0x81))).toBe("malformed");
  });

  it.each<[string, (der: Uint8Array) => Uint8Array]>([
    ["no bytes", () => new Uint8Array(0)],
    ["another outer tag", der => join(Uint8Array.of(0x31), der.subarray(1))],
    ["a long-form length", der => join(Uint8Array.of(0x30, 0x81, der[1]), der.subarray(2))],
    ["an outer length that stops short of the end",
      der => join(Uint8Array.of(0x30, der[1] - 1), der.subarray(2))],
    ["another integer tag",
      der => join(der.subarray(0, 2), Uint8Array.of(0x03), der.subarray(3))],
    ["an integer that runs past the end", der => {
      let longer = der.slice();
      longer[5 + der[3]] += 1;
      return longer;
    }],
    ["only one integer",
      der => join(Uint8Array.of(0x30, 2 + der[3]), der.subarray(2, 4 + der[3]))],
    ["a second integer that is only a tag", der => join(
        Uint8Array.of(0x30, 3 + der[3]), der.subarray(2, 4 + der[3]), Uint8Array.of(0x02))],
    ["a third integer",
      der => join(Uint8Array.of(0x30, der[1] + 3), der.subarray(2), Uint8Array.of(0x02, 1, 1))],
    ["an integer of 33 significant bytes", () => join(
        Uint8Array.of(0x30, 38, 0x02, 33), new Uint8Array(33).fill(1), Uint8Array.of(0x02, 1, 1))],
  ])("is refused as malformed for %s", async (_what, rewrite) => {
    expect(await refusalWith(rewrite)).toBe("malformed");
  });

  it("is refused, not thrown on, for integers that are zero", async () => {
    expect(await refusalWith(() => Uint8Array.of(0x30, 6, 0x02, 1, 0, 0x02, 1, 0)))
        .toBe("signature");
    expect(await refusalWith(() => Uint8Array.of(0x30, 4, 0x02, 0, 0x02, 0))).toBe("signature");
  });
});
