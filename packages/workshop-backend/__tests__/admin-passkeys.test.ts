import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ADMIN_ACCESS_ERROR_CODES, ADMIN_PASSKEY_CHALLENGE_LIFETIME_SECONDS, ADMIN_WRITE_ERROR_CODES,
  MAX_ADMIN_PASSKEYS, MAX_ADMIN_PASSKEY_NAME_LENGTH, getAdminWriteErrorCode,
  type AdminPasskeyAssertion, type AdminPasskeyRegistration, type AdminSettingMethod,
} from "@gadgets/workshop-shared/api";
import { auditOwnerId, type AdminSettingActor } from "../src/admin-access.js";
import type { AdminSettings } from "../src/admin-settings.js";
import type { AdminPasskeyRecord } from "../src/storage-schema/admin-settings-storage.js";
import { MAX_CREDENTIAL_ID_LENGTH } from "../src/webauthn.js";
import { ADMIN, OTHER_ADMIN, adminWritesHarness } from "./admin-writes-harness";
import { softwareAuthenticator, type Tamper } from "./software-authenticator";

const ORIGIN = "https://workshop.example";
const NO_SUCH_PASSKEY = "You have no such passkey.";
const LIMIT = `An admin can enrol at most ${MAX_ADMIN_PASSKEYS} passkeys. Remove one first.`;
// A challenge of the right shape that the server never issued.
const NEVER_ISSUED = "A".repeat(43);

type Harness = ReturnType<typeof adminWritesHarness>;
type Authenticator = Awaited<ReturnType<typeof softwareAuthenticator>>;

afterEach(() => {
  vi.restoreAllMocks();
});

const authenticator = () => softwareAuthenticator({ origin: ORIGIN });

function actor(admin: string, method: AdminSettingMethod): AdminSettingActor {
  return { admin, sessionId: `session of ${admin}`, via: "api", method };
}

/** What `call` rejects with. Awaited inside the Durable Object, so the error is the one thrown. */
async function rejection(call: Promise<unknown>): Promise<unknown> {
  try {
    await call;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the call to reject.");
}

/** Silences the logger and returns the checks its `admin.passkey.refused` lines name, in order. */
function refusalLog(): { reasons(): unknown[]; lines(): Record<string, unknown>[] } {
  const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
  const lines = () => warned.mock.calls.map(([entry]) => entry as Record<string, unknown>)
      .filter(entry => entry.event === "admin.passkey.refused");
  return { lines, reasons: () => lines().map(entry => entry.reason) };
}

const isRefused = (error: unknown) =>
    getAdminWriteErrorCode(error) === ADMIN_WRITE_ERROR_CODES.passkeyRefused;

/** Sends `registration` as `admin`'s enrolment, returning what it is refused with. */
function refusedEnrolment(harness: Harness, registration: AdminPasskeyRegistration,
    admin = ADMIN, name = "Laptop"): Promise<unknown> {
  return harness.inDo(settings => rejection(
      settings.addAdminPasskey(name, registration, actor(admin, "addAdminPasskey"))));
}

/** Enrols `passkey` for `admin` through the whole ceremony. */
function enrol(harness: Harness, passkey: Authenticator, admin = ADMIN, name = "Laptop") {
  return harness.inDo(async settings => settings.addAdminPasskey(
      name, await passkey.register(settings.beginAdminPasskeyEnrolment(admin)),
      actor(admin, "addAdminPasskey")));
}

/** Begins `admin`'s removal of passkey `id` and has `signer` answer it, falsified by `tamper`. */
function removalAssertion(harness: Harness, id: string, signer: Authenticator, admin = ADMIN,
    tamper?: Tamper): Promise<AdminPasskeyAssertion> {
  return harness.inDo(async settings =>
      signer.assert(await settings.beginAdminPasskeyRemoval(id, admin), tamper));
}

/** Sends `assertion` as `admin`'s removal of passkey `id`, returning what it is refused with. */
function refusedRemoval(harness: Harness, id: string, assertion: AdminPasskeyAssertion,
    admin = ADMIN, more?: object): Promise<unknown> {
  return harness.inDo(settings => rejection(
      settings.removeAdminPasskey(id, assertion, actor(admin, "removeAdminPasskey"))), more);
}

/** Removes `admin`'s passkey `id` through the whole ceremony, signed by `signer`. */
async function remove(harness: Harness, id: string, signer: Authenticator, admin = ADMIN) {
  const assertion = await removalAssertion(harness, id, signer, admin);
  await harness.inDo(settings =>
      settings.removeAdminPasskey(id, assertion, actor(admin, "removeAdminPasskey")));
}

const listed = (harness: Harness, more?: object) =>
    harness.inDo(settings => settings.listAdminPasskeys(), more);
const storedPasskeys = (harness: Harness) =>
    harness.inDo(settings => [...harness.storageOf(settings).adminPasskeys.list()]);
const storedChallenges = (harness: Harness) =>
    harness.inDo(settings => [...harness.storageOf(settings).adminPasskeyChallenges.list()]);

/** Stores a passkey that no authenticator holds, as an earlier enrolment would have left it. */
function seedPasskey(harness: Harness, settings: AdminSettings,
    passkey: Pick<AdminPasskeyRecord, "id" | "admin"> & Partial<AdminPasskeyRecord>): void {
  harness.storageOf(settings).adminPasskeys.put({
    name: "Seeded", publicKey: new Uint8Array(), algorithm: -7, signCount: 0,
    created: new Date(), ...passkey,
  });
}

/** Stores `count` passkeys for ADMIN that no authenticator holds. */
function seedPasskeys(harness: Harness, count: number) {
  return harness.inDo(settings => {
    for (let i = 0; i < count; i++) {
      seedPasskey(harness, settings, { id: `seeded-${i}`, admin: ADMIN });
    }
  });
}

/** `registration` as an authenticator whose credential id is `id` would have made it: the id
 * replaced where the answer names it and where the authenticator data attests it. */
function withCredentialId(registration: AdminPasskeyRegistration, id: Uint8Array)
    : AdminPasskeyRegistration {
  const base64url = { alphabet: "base64url", omitPadding: true } as const;
  const data = Uint8Array.fromBase64(registration.authenticatorData, base64url);
  // The fixed part and the AAGUID are kept; then the id's length, the id, and an empty COSE map.
  const attested = new Uint8Array(53 + 2 + id.length + 1);
  attested.set(data.subarray(0, 53));
  attested.set([id.length >> 8, id.length & 0xff], 53);
  attested.set(id, 55);
  attested[55 + id.length] = 0xa0;
  return {
    ...registration, credentialId: id.toBase64(base64url),
    authenticatorData: attested.toBase64(base64url),
  };
}

describe("enrolling a passkey", () => {
  it("issues a challenge for the deployment's host name, stored for five minutes", async () => {
    const harness = adminWritesHarness();
    const before = Date.now();
    const challenge = await harness.inDo(settings => settings.beginAdminPasskeyEnrolment(ADMIN));
    const after = Date.now();

    expect(challenge.rpId).toBe("workshop.example");
    expect(challenge.credentialIds).toEqual([]);
    // 32 random bytes, as unpadded base64url.
    expect(challenge.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const lifetime = ADMIN_PASSKEY_CHALLENGE_LIFETIME_SECONDS * 1000;
    expect(challenge.expiresAt.getTime()).toBeGreaterThanOrEqual(before + lifetime);
    expect(challenge.expiresAt.getTime()).toBeLessThanOrEqual(after + lifetime);
    expect(await storedChallenges(harness)).toStrictEqual([{
      key: `enrol:${ADMIN}`, challenge: challenge.challenge,
      expiresAt: challenge.expiresAt.getTime(),
    }]);
  });

  it("names the host without its port, and accepts a registration made on that origin",
      async () => {
    const harness = adminWritesHarness({ PUBLIC_BASE_URL: "http://localhost:3000" });
    const local = await softwareAuthenticator({ origin: "http://localhost:3000" });
    const challenge = await harness.inDo(settings => settings.beginAdminPasskeyEnrolment(ADMIN));
    expect(challenge.rpId).toBe("localhost");

    const passkey = await harness.inDo(async settings => settings.addAdminPasskey(
        "Laptop", await local.register(challenge), actor(ADMIN, "addAdminPasskey")));
    expect(passkey.id).toBe(local.credentialId);
  });

  it("records a good registration before storing it, and lists it without key material",
      async () => {
    const harness = adminWritesHarness();
    const passkey = await authenticator();
    const registration = await harness.inDo(async settings =>
        passkey.register(settings.beginAdminPasskeyEnrolment(ADMIN)));

    let storedAtAppend: number | undefined;
    const before = Date.now();
    const enrolled = await harness.inDo(settings => {
      harness.audit.before = async () => {
        storedAtAppend = [...harness.storageOf(settings).adminPasskeys.list()].length;
      };
      return settings.addAdminPasskey("  Laptop  ", registration, actor(ADMIN, "addAdminPasskey"));
    });

    expect(storedAtAppend).toBe(0);
    expect(harness.appended).toStrictEqual([{
      kind: "setting", at: expect.any(Date), admin: ADMIN, sessionId: `session of ${ADMIN}`,
      via: "api", method: "addAdminPasskey",
      changes: [{
        setting: "adminPasskeys", key: passkey.credentialId,
        after: JSON.stringify({ admin: ADMIN, algorithm: -7, name: "Laptop" }),
      }],
    }]);
    // The record holds nothing of the registration but the credential's id.
    const record = JSON.stringify(harness.appended);
    expect(record).not.toContain(registration.publicKey);
    expect(record).not.toContain(registration.authenticatorData);
    expect(record).not.toContain(registration.clientDataJSON);

    const expected = { id: passkey.credentialId, admin: ADMIN, name: "Laptop",
                       created: expect.any(Date) };
    expect(enrolled).toStrictEqual(expected);
    expect(enrolled.created.getTime()).toBeGreaterThanOrEqual(before);
    expect(await listed(harness)).toStrictEqual([expected]);
    // What is stored keeps the key, to verify the passkey's assertions with.
    expect(await storedPasskeys(harness)).toStrictEqual([{
      ...expected, publicKey: Uint8Array.fromBase64(registration.publicKey,
          { alphabet: "base64url" }), algorithm: -7, signCount: 1,
    }]);
    // The challenge was spent, and the next one excludes the passkey it enrolled.
    expect(await storedChallenges(harness)).toEqual([]);
    const next = await harness.inDo(settings => settings.beginAdminPasskeyEnrolment(ADMIN));
    expect(next.credentialIds).toEqual([passkey.credentialId]);
    const others = await harness.inDo(
        settings => settings.beginAdminPasskeyEnrolment(OTHER_ADMIN));
    expect(others.credentialIds).toEqual([]);
  });

  it("records the longest credential ids by their start and a digest, which keeps them apart",
      async () => {
    const harness = adminWritesHarness();
    const passkey = await authenticator();
    // Two ids of WebAuthn's longest length that differ in their last byte alone.
    const ids = [1, 2].map(last => new Uint8Array(1023).fill(7).with(1022, last));
    const enrolled: string[] = [];
    for (let id of ids) {
      const { id: credentialId } = await harness.inDo(async settings => settings.addAdminPasskey(
          "Security key",
          withCredentialId(await passkey.register(settings.beginAdminPasskeyEnrolment(ADMIN)), id),
          actor(ADMIN, "addAdminPasskey")));
      expect(credentialId).toHaveLength(MAX_CREDENTIAL_ID_LENGTH);
      enrolled.push(credentialId);
    }
    expect((await listed(harness)).map(listing => listing.id).toSorted())
        .toEqual(enrolled.toSorted());

    // The same authenticator's key signs for both, so it confirms the removal of the first.
    const assertion = await removalAssertion(harness, enrolled[0]!, passkey);
    await harness.inDo(settings => settings.removeAdminPasskey(
        enrolled[0]!, { ...assertion, credentialId: enrolled[1]! },
        actor(ADMIN, "removeAdminPasskey")));
    expect((await listed(harness)).map(listing => listing.id)).toEqual([enrolled[1]]);

    const keys = harness.appended.map(record => "changes" in record && record.changes[0]!.key);
    expect(keys).toEqual([auditOwnerId(enrolled[0]!), auditOwnerId(enrolled[1]!),
                          auditOwnerId(enrolled[0]!)]);
    expect(keys[0]).toHaveLength(256);
    expect(keys[0]).toContain("…#");
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("lists passkeys by admin, then by enrolment time, former admins' included", async () => {
    const harness = adminWritesHarness();
    await harness.inDo(settings => {
      seedPasskey(harness, settings,
          { id: "a", admin: OTHER_ADMIN, created: new Date("2026-03-01T00:00:00Z") });
      seedPasskey(harness, settings,
          { id: "b", admin: ADMIN, created: new Date("2026-02-01T00:00:00Z") });
      seedPasskey(harness, settings, { id: "c", admin: "former@example.test" });
      seedPasskey(harness, settings, {
        id: "d", admin: ADMIN, created: new Date("2026-01-01T00:00:00Z"),
        lastUsed: new Date("2026-04-01T00:00:00Z"),
      });
    });
    const passkeys = await listed(harness);
    expect(passkeys.map(passkey => passkey.id)).toEqual(["d", "b", "c", "a"]);
    expect(passkeys[0]).toStrictEqual({
      id: "d", admin: ADMIN, name: "Seeded", created: new Date("2026-01-01T00:00:00Z"),
      lastUsed: new Date("2026-04-01T00:00:00Z"),
    });
  });

  it.each([
    ["a challenge the server never issued", { challenge: NEVER_ISSUED }, "challenge"],
    ["another origin", { origin: "https://elsewhere.example" }, "origin"],
    ["another relying party", { rpId: "elsewhere.example" }, "relyingParty"],
    ["no user verification", { userVerified: false }, "userVerification"],
  ] as const)("refuses a registration with %s, storing and recording nothing",
      async (_label, tamper, reason) => {
    const harness = adminWritesHarness();
    const log = refusalLog();
    const passkey = await authenticator();
    const challenge = await harness.inDo(settings => settings.beginAdminPasskeyEnrolment(ADMIN));
    const registration = await passkey.register(challenge, tamper);

    expect(isRefused(await refusedEnrolment(harness, registration))).toBe(true);
    expect(log.reasons()).toEqual([reason]);
    // The line says which check failed and nothing of the answer.
    const line = JSON.stringify(log.lines());
    for (let value of [registration.credentialId, registration.clientDataJSON,
                       registration.authenticatorData, registration.publicKey]) {
      expect(line).not.toContain(value);
    }
    expect(await listed(harness)).toEqual([]);
    expect(harness.appended).toEqual([]);

    // The refused answer spent the challenge, so a good answer to it is refused too.
    expect(await storedChallenges(harness)).toEqual([]);
    expect(isRefused(await refusedEnrolment(harness, await passkey.register(challenge))))
        .toBe(true);
    expect(log.reasons()).toEqual([reason, "challenge"]);
    expect(await listed(harness)).toEqual([]);
  });

  it("refuses a registration that answers another admin's challenge", async () => {
    const harness = adminWritesHarness();
    const log = refusalLog();
    const passkey = await authenticator();
    const theirs = await harness.inDo(settings => {
      settings.beginAdminPasskeyEnrolment(ADMIN);
      return settings.beginAdminPasskeyEnrolment(OTHER_ADMIN);
    });

    expect(isRefused(await refusedEnrolment(harness, await passkey.register(theirs)))).toBe(true);
    expect(log.reasons()).toEqual(["challenge"]);
    expect(await listed(harness)).toEqual([]);
    expect(harness.appended).toEqual([]);
    // Only the caller's own challenge was spent.
    expect((await storedChallenges(harness)).map(challenge => challenge.key))
        .toEqual([`enrol:${OTHER_ADMIN}`]);
  });

  it("answers a challenge until the moment it expires, and not from then on", async () => {
    for (let [age, accepted] of [[-1, true], [0, false]] as const) {
      const harness = adminWritesHarness();
      const log = refusalLog();
      const passkey = await authenticator();
      const challenge = await harness.inDo(
          settings => settings.beginAdminPasskeyEnrolment(ADMIN));
      const registration = await passkey.register(challenge);

      vi.spyOn(Date, "now").mockReturnValue(challenge.expiresAt.getTime() + age);
      const outcome = await harness.inDo(settings => settings.addAdminPasskey(
          "Laptop", registration, actor(ADMIN, "addAdminPasskey")).then(() => "enrolled", isRefused));
      expect(outcome).toBe(accepted ? "enrolled" : true);
      expect(log.reasons()).toEqual(accepted ? [] : ["challenge"]);
      expect(await listed(harness)).toHaveLength(accepted ? 1 : 0);
      expect(harness.appended).toHaveLength(accepted ? 1 : 0);
      expect(await storedChallenges(harness)).toEqual([]);
      vi.restoreAllMocks();
    }
  });

  it("refuses a registration presented twice: its challenge is spent", async () => {
    const harness = adminWritesHarness();
    const log = refusalLog();
    const passkey = await authenticator();
    const registration = await harness.inDo(async settings =>
        passkey.register(settings.beginAdminPasskeyEnrolment(ADMIN)));
    await harness.inDo(settings =>
        settings.addAdminPasskey("Laptop", registration, actor(ADMIN, "addAdminPasskey")));

    expect(isRefused(await refusedEnrolment(harness, registration))).toBe(true);
    expect(log.reasons()).toEqual(["challenge"]);
    expect(await listed(harness)).toHaveLength(1);
    expect(harness.appended).toHaveLength(1);
  });

  it("refuses a credential another admin has enrolled", async () => {
    const harness = adminWritesHarness();
    const log = refusalLog();
    const passkey = await authenticator();
    await enrol(harness, passkey, ADMIN);

    const registration = await harness.inDo(async settings =>
        passkey.register(settings.beginAdminPasskeyEnrolment(OTHER_ADMIN)));
    expect(isRefused(await refusedEnrolment(harness, registration, OTHER_ADMIN))).toBe(true);
    expect(log.reasons()).toEqual(["credential"]);
    expect((await listed(harness)).map(({ id, admin }) => ({ id, admin })))
        .toEqual([{ id: passkey.credentialId, admin: ADMIN }]);
    expect(harness.appended).toHaveLength(1);
  });

  it("rejects a blank or over-long name before the challenge is spent", async () => {
    const harness = adminWritesHarness();
    const passkey = await authenticator();
    const registration = await harness.inDo(async settings =>
        passkey.register(settings.beginAdminPasskeyEnrolment(ADMIN)));

    for (let name of ["", "   ", "n".repeat(MAX_ADMIN_PASSKEY_NAME_LENGTH + 1)]) {
      expect(await refusedEnrolment(harness, registration, ADMIN, name))
          .toBeInstanceOf(TypeError);
    }
    expect(await listed(harness)).toEqual([]);
    expect(harness.appended).toEqual([]);
    expect(await storedChallenges(harness)).toHaveLength(1);

    // The longest name is accepted, once trimmed.
    const longest = "n".repeat(MAX_ADMIN_PASSKEY_NAME_LENGTH);
    const enrolled = await harness.inDo(settings => settings.addAdminPasskey(
        ` ${longest} `, registration, actor(ADMIN, "addAdminPasskey")));
    expect(enrolled.name).toBe(longest);
  });

  it("replaces the challenge outstanding when another enrolment begins", async () => {
    const harness = adminWritesHarness();
    const log = refusalLog();
    const passkey = await authenticator();
    const [first, second] = await harness.inDo(settings =>
        [settings.beginAdminPasskeyEnrolment(ADMIN), settings.beginAdminPasskeyEnrolment(ADMIN)]);
    expect(second.challenge).not.toBe(first.challenge);
    expect((await storedChallenges(harness)).map(challenge => challenge.challenge))
        .toEqual([second.challenge]);

    expect(isRefused(await refusedEnrolment(harness, await passkey.register(first)))).toBe(true);
    expect(log.reasons()).toEqual(["challenge"]);
    expect(await listed(harness)).toEqual([]);
  });
});

describe("beginning a passkey's removal", () => {
  it("throws for an id that names no passkey of the caller's, storing no challenge", async () => {
    const harness = adminWritesHarness();
    const theirs = await authenticator();
    await enrol(harness, theirs, OTHER_ADMIN);

    for (let id of ["unknown", "x".repeat(MAX_CREDENTIAL_ID_LENGTH + 1), theirs.credentialId]) {
      const error = await harness.inDo(
          settings => rejection(settings.beginAdminPasskeyRemoval(id, ADMIN)));
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(NO_SUCH_PASSKEY);
      expect(getAdminWriteErrorCode(error)).toBeUndefined();
    }
    expect(await storedChallenges(harness)).toEqual([]);
  });

  it("issues a challenge that ends with the SHA-256 of the id, naming the caller's own passkeys",
      async () => {
    const harness = adminWritesHarness();
    const [mine, another, theirs] =
        [await authenticator(), await authenticator(), await authenticator()];
    await enrol(harness, mine);
    await enrol(harness, another);
    await enrol(harness, theirs, OTHER_ADMIN);

    const challenge = await harness.inDo(
        settings => settings.beginAdminPasskeyRemoval(mine.credentialId, ADMIN));
    expect(challenge.rpId).toBe("workshop.example");
    expect(challenge.challenge).toMatch(/^[A-Za-z0-9_-]{86}$/);
    const bytes = Uint8Array.fromBase64(challenge.challenge, { alphabet: "base64url" });
    const digest = new Uint8Array(await crypto.subtle.digest(
        "SHA-256", new TextEncoder().encode(mine.credentialId)));
    expect(bytes.subarray(32)).toStrictEqual(digest);
    expect(challenge.credentialIds.toSorted())
        .toEqual([mine.credentialId, another.credentialId].toSorted());
    expect(await storedChallenges(harness)).toStrictEqual([{
      key: `remove:${ADMIN}`, challenge: challenge.challenge, subject: mine.credentialId,
      expiresAt: challenge.expiresAt.getTime(),
    }]);

    // Two challenges for one passkey share the digest and nothing before it.
    const again = await harness.inDo(
        settings => settings.beginAdminPasskeyRemoval(mine.credentialId, ADMIN));
    expect(again.challenge.slice(43)).toBe(challenge.challenge.slice(43));
    expect(again.challenge.slice(0, 42)).not.toBe(challenge.challenge.slice(0, 42));
    expect(await storedChallenges(harness)).toHaveLength(1);
  });
});

describe("removing a passkey", () => {
  it("records the removal of an admin's only passkey, signed by itself, before it is gone",
      async () => {
    const harness = adminWritesHarness();
    const passkey = await authenticator();
    await enrol(harness, passkey);
    const assertion = await removalAssertion(harness, passkey.credentialId, passkey);
    harness.appended.length = 0;

    let storedAtAppend: number | undefined;
    await harness.inDo(settings => {
      harness.audit.before = async () => {
        storedAtAppend = [...harness.storageOf(settings).adminPasskeys.list()].length;
      };
      return settings.removeAdminPasskey(
          passkey.credentialId, assertion, actor(ADMIN, "removeAdminPasskey"));
    });

    expect(storedAtAppend).toBe(1);
    expect(harness.appended).toStrictEqual([{
      kind: "setting", at: expect.any(Date), admin: ADMIN, sessionId: `session of ${ADMIN}`,
      via: "api", method: "removeAdminPasskey",
      changes: [{
        setting: "adminPasskeys", key: passkey.credentialId,
        before: JSON.stringify({ admin: ADMIN, algorithm: -7, name: "Laptop" }),
      }],
    }]);
    expect(await storedPasskeys(harness)).toEqual([]);
    expect(await storedChallenges(harness)).toEqual([]);
  });

  it("removes one of two passkeys signed by the other, storing the signer's use", async () => {
    const harness = adminWritesHarness();
    const [target, signer] = [await authenticator(), await authenticator()];
    await enrol(harness, target, ADMIN, "Old laptop");
    await enrol(harness, signer, ADMIN, "Phone");
    expect((await listed(harness)).some(passkey => "lastUsed" in passkey)).toBe(false);

    const before = Date.now();
    await remove(harness, target.credentialId, signer);

    const stored = await storedPasskeys(harness);
    expect(stored.map(passkey => passkey.id)).toEqual([signer.credentialId]);
    // The signer's enrolment was its first ceremony and this assertion its second.
    expect(stored[0]!.signCount).toBe(2);
    expect(stored[0]!.lastUsed!.getTime()).toBeGreaterThanOrEqual(before);
    expect(await listed(harness)).toStrictEqual([{
      id: signer.credentialId, admin: ADMIN, name: "Phone", created: expect.any(Date),
      lastUsed: stored[0]!.lastUsed,
    }]);
    expect(harness.appended.at(-1)).toMatchObject({
      method: "removeAdminPasskey",
      changes: [{
        setting: "adminPasskeys", key: target.credentialId,
        before: JSON.stringify({ admin: ADMIN, algorithm: -7, name: "Old laptop" }),
      }],
    });
  });

  it("lets nobody remove another admin's passkey, whatever the answer", async () => {
    const harness = adminWritesHarness();
    const log = refusalLog();
    const [theirs, mine] = [await authenticator(), await authenticator()];
    await enrol(harness, theirs, ADMIN);
    await enrol(harness, mine, OTHER_ADMIN);
    harness.appended.length = 0;

    // A good assertion by the caller's own passkey, over a challenge begun for that passkey.
    const own = await removalAssertion(harness, mine.credentialId, mine, OTHER_ADMIN);
    // The owner's own good assertion for the passkey, sent by someone else.
    const stolen = await removalAssertion(harness, theirs.credentialId, theirs, ADMIN);
    for (let assertion of [own, stolen]) {
      const error = await refusedRemoval(harness, theirs.credentialId, assertion, OTHER_ADMIN);
      expect((error as Error).message).toBe(NO_SUCH_PASSKEY);
      expect(getAdminWriteErrorCode(error)).toBeUndefined();
    }
    expect(log.reasons()).toEqual([]);
    expect(harness.appended).toEqual([]);
    expect((await listed(harness)).map(passkey => passkey.id).toSorted())
        .toEqual([theirs.credentialId, mine.credentialId].toSorted());

    // Once its admin has left the deployment the passkey stays, and is still nobody else's.
    const former = { ADMINS: [OTHER_ADMIN] };
    expect((await listed(harness, former)).map(passkey => passkey.admin)).toContain(ADMIN);
    const begun = await harness.inDo(settings => rejection(
        settings.beginAdminPasskeyRemoval(theirs.credentialId, OTHER_ADMIN)), former);
    expect((begun as Error).message).toBe(NO_SUCH_PASSKEY);
    const error = await refusedRemoval(harness, theirs.credentialId, own, OTHER_ADMIN, former);
    expect((error as Error).message).toBe(NO_SUCH_PASSKEY);
    expect(harness.appended).toEqual([]);
    expect((await listed(harness, former)).map(passkey => passkey.id))
        .toContain(theirs.credentialId);
  });

  it.each([
    ["a challenge the server never issued", { challenge: NEVER_ISSUED }, "challenge"],
    ["another origin", { origin: "https://elsewhere.example" }, "origin"],
    ["another relying party", { rpId: "elsewhere.example" }, "relyingParty"],
    ["no user verification", { userVerified: false }, "userVerification"],
  ] as const)("refuses an assertion with %s, and again when it is replayed",
      async (_label, tamper, reason) => {
    const harness = adminWritesHarness();
    const log = refusalLog();
    const passkey = await authenticator();
    await enrol(harness, passkey);
    harness.appended.length = 0;
    const id = passkey.credentialId;
    const assertion = await removalAssertion(harness, id, passkey, ADMIN, tamper);

    expect(isRefused(await refusedRemoval(harness, id, assertion))).toBe(true);
    expect(log.reasons()).toEqual([reason]);
    const line = JSON.stringify(log.lines());
    for (let value of Object.values(assertion)) expect(line).not.toContain(value);

    // The challenge was spent, so the same answer sent again is refused for having none.
    expect(await storedChallenges(harness)).toEqual([]);
    expect(isRefused(await refusedRemoval(harness, id, assertion))).toBe(true);
    expect(log.reasons()).toEqual([reason, "challenge"]);
    expect(harness.appended).toEqual([]);
    expect((await listed(harness)).map(listing => listing.id)).toEqual([id]);
  });

  it("refuses a challenge begun for one passkey as the answer to another's removal", async () => {
    const harness = adminWritesHarness();
    const log = refusalLog();
    const [first, second] = [await authenticator(), await authenticator()];
    await enrol(harness, first);
    await enrol(harness, second);
    harness.appended.length = 0;

    const assertion = await removalAssertion(harness, first.credentialId, first);
    expect(isRefused(await refusedRemoval(harness, second.credentialId, assertion))).toBe(true);
    expect(log.reasons()).toEqual(["challenge"]);
    expect(harness.appended).toEqual([]);
    expect(await listed(harness)).toHaveLength(2);
  });

  it("refuses an answer made with another admin's passkey", async () => {
    const harness = adminWritesHarness();
    const log = refusalLog();
    const [theirs, mine] = [await authenticator(), await authenticator()];
    await enrol(harness, theirs, ADMIN);
    await enrol(harness, mine, OTHER_ADMIN);
    harness.appended.length = 0;

    // The caller's own challenge, answered by the other admin's authenticator.
    const foreign = await removalAssertion(harness, mine.credentialId, theirs, OTHER_ADMIN);
    expect(isRefused(await refusedRemoval(harness, mine.credentialId, foreign, OTHER_ADMIN)))
        .toBe(true);
    expect(log.reasons()).toEqual(["credential"]);

    // The other admin's good assertion, with no challenge of the caller's outstanding.
    const valid = await removalAssertion(harness, theirs.credentialId, theirs, ADMIN);
    expect(isRefused(await refusedRemoval(harness, mine.credentialId, valid, OTHER_ADMIN)))
        .toBe(true);
    expect(log.reasons()).toEqual(["credential", "challenge"]);

    expect(harness.appended).toEqual([]);
    expect(await listed(harness)).toHaveLength(2);
    // The other admin's challenge is still theirs to answer.
    await harness.inDo(settings => settings.removeAdminPasskey(
        theirs.credentialId, valid, actor(ADMIN, "removeAdminPasskey")));
    expect((await listed(harness)).map(passkey => passkey.id)).toEqual([mine.credentialId]);
  });

  it("refuses an assertion sent under the id of a passkey that did not sign it", async () => {
    const harness = adminWritesHarness();
    const log = refusalLog();
    const [signer, named] = [await authenticator(), await authenticator()];
    await enrol(harness, signer);
    await enrol(harness, named);
    harness.appended.length = 0;

    const assertion = await removalAssertion(harness, signer.credentialId, signer);
    expect(isRefused(await refusedRemoval(
        harness, signer.credentialId, { ...assertion, credentialId: named.credentialId })))
        .toBe(true);
    expect(log.reasons()).toEqual(["signature"]);
    expect(harness.appended).toEqual([]);
    expect(await listed(harness)).toHaveLength(2);
  });

  it("refuses the assertion that removed a passkey when it is sent again", async () => {
    const harness = adminWritesHarness();
    const passkey = await authenticator();
    await enrol(harness, passkey);
    const assertion = await removalAssertion(harness, passkey.credentialId, passkey);
    await harness.inDo(settings => settings.removeAdminPasskey(
        passkey.credentialId, assertion, actor(ADMIN, "removeAdminPasskey")));
    harness.appended.length = 0;

    const error = await refusedRemoval(harness, passkey.credentialId, assertion);
    expect((error as Error).message).toBe(NO_SUCH_PASSKEY);
    expect(harness.appended).toEqual([]);
  });

  it("leaves a passkey another admin enrolled under the id while the removal was being recorded",
      async () => {
    const harness = adminWritesHarness();
    const [mine, theirs] = [await authenticator(), await authenticator()];
    await enrol(harness, mine);
    const id = mine.credentialId;
    const appending = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    const enrolledMeanwhile = await harness.inDo(async settings => {
      const removal = async () => settings.removeAdminPasskey(
          id, await mine.assert(await settings.beginAdminPasskeyRemoval(id, ADMIN)),
          actor(ADMIN, "removeAdminPasskey"));
      harness.audit.before = () => { appending.resolve(); return release.promise; };
      const held = removal();
      await appending.promise;

      // Held at its audit append, past its checks. A second removal of the passkey completes, and
      // the other admin then enrols a credential that carries its id.
      harness.audit.before = undefined;
      await removal();
      await settings.addAdminPasskey(
          "Theirs",
          withCredentialId(
              await theirs.register(settings.beginAdminPasskeyEnrolment(OTHER_ADMIN)),
              Uint8Array.fromBase64(id, { alphabet: "base64url" })),
          actor(OTHER_ADMIN, "addAdminPasskey"));
      const stored = [...harness.storageOf(settings).adminPasskeys.list()];
      release.resolve();
      await held;
      return stored;
    });

    expect(enrolledMeanwhile).toMatchObject([{ id, admin: OTHER_ADMIN, name: "Theirs" }]);
    expect(await storedPasskeys(harness)).toStrictEqual(enrolledMeanwhile);
    expect(harness.appended.map(record => "method" in record && record.method)).toEqual(
        ["addAdminPasskey", "removeAdminPasskey", "addAdminPasskey", "removeAdminPasskey"]);
  });

  it("does not bring back a signer removed while the removal it confirmed was being recorded",
      async () => {
    const harness = adminWritesHarness();
    const [target, signer] = [await authenticator(), await authenticator()];
    await enrol(harness, target, ADMIN, "Old laptop");
    await enrol(harness, signer, ADMIN, "Phone");
    harness.appended.length = 0;
    const appending = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    await harness.inDo(async settings => {
      const removal = async (id: string) => settings.removeAdminPasskey(
          id, await signer.assert(await settings.beginAdminPasskeyRemoval(id, ADMIN)),
          actor(ADMIN, "removeAdminPasskey"));
      harness.audit.before = () => { appending.resolve(); return release.promise; };
      const held = removal(target.credentialId);
      await appending.promise;

      // Held at its audit append, its assertion verified. The signer removes itself meanwhile.
      harness.audit.before = undefined;
      await removal(signer.credentialId);
      release.resolve();
      await held;
    });

    // The held removal took its target and stored nothing of the signer's use.
    expect(await storedPasskeys(harness)).toEqual([]);
    expect(harness.appended.map(record => "changes" in record && record.changes[0]!.key))
        .toEqual([signer.credentialId, target.credentialId]);
  });

  it("stores no use on a passkey another admin enrolled under the signer's id while the removal " +
      "was being recorded", async () => {
    const harness = adminWritesHarness();
    const [target, signer, theirs] =
        [await authenticator(), await authenticator(), await authenticator()];
    await enrol(harness, target, ADMIN, "Old laptop");
    await enrol(harness, signer, ADMIN, "Phone");
    const appending = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    const enrolledMeanwhile = await harness.inDo(async settings => {
      const removal = async (id: string) => settings.removeAdminPasskey(
          id, await signer.assert(await settings.beginAdminPasskeyRemoval(id, ADMIN)),
          actor(ADMIN, "removeAdminPasskey"));
      harness.audit.before = () => { appending.resolve(); return release.promise; };
      const held = removal(target.credentialId);
      await appending.promise;

      // Held at its audit append, its assertion verified. The signer removes itself, and the other
      // admin then enrols a credential that carries the signer's id.
      harness.audit.before = undefined;
      await removal(signer.credentialId);
      await settings.addAdminPasskey(
          "Theirs",
          withCredentialId(
              await theirs.register(settings.beginAdminPasskeyEnrolment(OTHER_ADMIN)),
              Uint8Array.fromBase64(signer.credentialId, { alphabet: "base64url" })),
          actor(OTHER_ADMIN, "addAdminPasskey"));
      const stored = harness.storageOf(settings).adminPasskeys.get(signer.credentialId);
      release.resolve();
      await held;
      return stored;
    });

    // The held removal took its target, and the passkey under its signer's id confirmed nothing:
    // it is stored as it was enrolled, with its own counter and no use.
    expect(enrolledMeanwhile).toMatchObject({ admin: OTHER_ADMIN, name: "Theirs", signCount: 1 });
    expect(enrolledMeanwhile).not.toHaveProperty("lastUsed");
    expect(await storedPasskeys(harness)).toStrictEqual([enrolledMeanwhile]);
  });

  it("keeps a passkey's higher counter when two removals it signed finish out of order",
      async () => {
    const harness = adminWritesHarness();
    const [first, second, signer] =
        [await authenticator(), await authenticator(), await authenticator()];
    await enrol(harness, first, ADMIN, "Old laptop");
    await enrol(harness, second, ADMIN, "Old phone");
    await enrol(harness, signer, ADMIN, "Key");
    const appending = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    await harness.inDo(async settings => {
      const removal = async (id: string) => settings.removeAdminPasskey(
          id, await signer.assert(await settings.beginAdminPasskeyRemoval(id, ADMIN)),
          actor(ADMIN, "removeAdminPasskey"));
      harness.audit.before = () => { appending.resolve(); return release.promise; };
      const held = removal(first.credentialId);
      await appending.promise;

      // Held at its audit append, its assertion verified. The signer's next assertion confirms a
      // second removal, which finishes first.
      harness.audit.before = undefined;
      await removal(second.credentialId);
      release.resolve();
      await held;
    });

    const stored = await storedPasskeys(harness);
    expect(stored.map(passkey => passkey.id)).toEqual([signer.credentialId]);
    // The signer's enrolment was its first ceremony, the held removal's assertion its second and
    // the overtaking one's its third.
    expect(stored[0]!.signCount).toBe(3);
  });

  it("answers a removal challenge until the moment it expires, and not from then on",
      async () => {
    for (let [age, accepted] of [[-1, true], [0, false]] as const) {
      const harness = adminWritesHarness();
      const log = refusalLog();
      const passkey = await authenticator();
      await enrol(harness, passkey);
      const challenge = await harness.inDo(
          settings => settings.beginAdminPasskeyRemoval(passkey.credentialId, ADMIN));
      const assertion = await passkey.assert(challenge);

      vi.spyOn(Date, "now").mockReturnValue(challenge.expiresAt.getTime() + age);
      const outcome = await harness.inDo(settings => settings.removeAdminPasskey(
          passkey.credentialId, assertion, actor(ADMIN, "removeAdminPasskey"))
          .then(() => "removed", isRefused));
      expect(outcome).toBe(accepted ? "removed" : true);
      expect(log.reasons()).toEqual(accepted ? [] : ["challenge"]);
      expect(await listed(harness)).toHaveLength(accepted ? 0 : 1);
      expect(harness.appended).toHaveLength(accepted ? 2 : 1);
      vi.restoreAllMocks();
    }
  });
});

describe("the limit on an admin's passkeys", () => {
  it("refuses an enrolment past it, which counts only the admin's own passkeys", async () => {
    const harness = adminWritesHarness();
    await seedPasskeys(harness, MAX_ADMIN_PASSKEYS - 1);
    const [mine, theirs] = [await authenticator(), await authenticator()];

    // The challenge is given while a place is left, which is taken before it is answered.
    const error = await harness.inDo(async settings => {
      const registration = await mine.register(settings.beginAdminPasskeyEnrolment(ADMIN));
      seedPasskey(harness, settings, { id: "seeded-last", admin: ADMIN });
      return rejection(settings.addAdminPasskey(
          "One more", registration, actor(ADMIN, "addAdminPasskey")));
    });
    expect((error as Error).message).toBe(LIMIT);
    expect(getAdminWriteErrorCode(error)).toBeUndefined();
    expect(await storedPasskeys(harness)).toHaveLength(MAX_ADMIN_PASSKEYS);
    expect(harness.appended).toEqual([]);

    await enrol(harness, theirs, OTHER_ADMIN);
    expect(await storedPasskeys(harness)).toHaveLength(MAX_ADMIN_PASSKEYS + 1);
    expect(harness.appended).toHaveLength(1);
  });

  it("gives an admin who holds that many no challenge to make another passkey with", async () => {
    const harness = adminWritesHarness();
    await seedPasskeys(harness, MAX_ADMIN_PASSKEYS);

    const error = await harness.inDo(async settings =>
        rejection((async () => settings.beginAdminPasskeyEnrolment(ADMIN))()));
    expect((error as Error).message).toBe(LIMIT);
    expect(await storedChallenges(harness)).toEqual([]);

    // Another admin's own count is what their challenge depends on.
    const theirs = await harness.inDo(settings => settings.beginAdminPasskeyEnrolment(OTHER_ADMIN));
    expect(theirs.credentialIds).toEqual([]);
  });

  it("holds when two enrolments race for the last place", async () => {
    const harness = adminWritesHarness();
    await seedPasskeys(harness, MAX_ADMIN_PASSKEYS - 1);
    const [held, quick] = [await authenticator(), await authenticator()];
    const appending = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    const error = await harness.inDo(async settings => {
      const registration = await held.register(settings.beginAdminPasskeyEnrolment(ADMIN));
      harness.audit.before = () => { appending.resolve(); return release.promise; };
      const first = rejection(
          settings.addAdminPasskey("Held", registration, actor(ADMIN, "addAdminPasskey")));
      await appending.promise;

      // Held at its audit append, past its first check. Another enrolment takes the last place.
      harness.audit.before = undefined;
      await settings.addAdminPasskey(
          "Quick", await quick.register(settings.beginAdminPasskeyEnrolment(ADMIN)),
          actor(ADMIN, "addAdminPasskey"));
      release.resolve();
      return await first;
    });

    expect((error as Error).message).toBe(LIMIT);
    const stored = await storedPasskeys(harness);
    expect(stored).toHaveLength(MAX_ADMIN_PASSKEYS);
    expect(stored.map(passkey => passkey.id)).toContain(quick.credentialId);
    expect(stored.map(passkey => passkey.id)).not.toContain(held.credentialId);
    // The enrolment refused at its second check has left its record, which is of the attempt.
    expect(harness.appended.map(record => "changes" in record && record.changes[0]!.key).toSorted())
        .toEqual([held.credentialId, quick.credentialId].toSorted());
  });

  it("stores a credential once when two enrolments of it race", async () => {
    const harness = adminWritesHarness();
    const log = refusalLog();
    const passkey = await authenticator();
    const appending = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    const error = await harness.inDo(async settings => {
      const registration = await passkey.register(settings.beginAdminPasskeyEnrolment(ADMIN));
      harness.audit.before = () => { appending.resolve(); return release.promise; };
      const first = rejection(
          settings.addAdminPasskey("Held", registration, actor(ADMIN, "addAdminPasskey")));
      await appending.promise;

      harness.audit.before = undefined;
      await settings.addAdminPasskey(
          "Quick", await passkey.register(settings.beginAdminPasskeyEnrolment(ADMIN)),
          actor(ADMIN, "addAdminPasskey"));
      release.resolve();
      return await first;
    });

    expect(isRefused(error)).toBe(true);
    expect(log.reasons()).toEqual(["credential"]);
    expect((await listed(harness)).map(({ id, name }) => ({ id, name })))
        .toEqual([{ id: passkey.credentialId, name: "Quick" }]);
    expect(harness.appended).toHaveLength(2);
  });
});

describe("a passkey change whose record cannot be written", () => {
  it("is refused, leaving storage as it was apart from the spent challenge", async () => {
    const harness = adminWritesHarness();
    const [enrolled, refused] = [await authenticator(), await authenticator()];
    await enrol(harness, enrolled);
    const before = await storedPasskeys(harness);
    harness.appended.length = 0;
    harness.audit.fail = true;

    const registration = await harness.inDo(async settings =>
        refused.register(settings.beginAdminPasskeyEnrolment(ADMIN)));
    const enrolment = await refusedEnrolment(harness, registration);
    expect((enrolment as Error).message).toBe("audit log unavailable");
    expect(await storedPasskeys(harness)).toStrictEqual(before);
    expect(await storedChallenges(harness)).toEqual([]);

    const assertion = await removalAssertion(harness, enrolled.credentialId, enrolled);
    const removal = await refusedRemoval(harness, enrolled.credentialId, assertion);
    expect((removal as Error).message).toBe("audit log unavailable");
    // Neither the removal nor the signer's use was stored.
    expect(await storedPasskeys(harness)).toStrictEqual(before);
    expect(await storedChallenges(harness)).toEqual([]);
    expect(harness.appended).toEqual([]);
  });
});

describe("a deployment with no PUBLIC_BASE_URL", () => {
  it("refuses both challenges, storing neither", async () => {
    const harness = adminWritesHarness();
    const passkey = await authenticator();
    await enrol(harness, passkey);
    const unset = { PUBLIC_BASE_URL: undefined };

    const enrolment = await harness.inDo(settings => {
      try {
        settings.beginAdminPasskeyEnrolment(ADMIN);
      } catch (error) {
        return error;
      }
    }, unset);
    expect(getAdminWriteErrorCode(enrolment)).toBe(ADMIN_WRITE_ERROR_CODES.originUnset);
    const removal = await harness.inDo(settings => rejection(
        settings.beginAdminPasskeyRemoval(passkey.credentialId, ADMIN)), unset);
    expect(getAdminWriteErrorCode(removal)).toBe(ADMIN_WRITE_ERROR_CODES.originUnset);
    expect(await storedChallenges(harness)).toEqual([]);
  });
});

// AdminApiImpl asks the same of the session Worker's environment before it calls. This object's
// can be newer: a session outlives the config its Worker started with.
describe("the object's own environment", () => {
  const OFF = { ADMIN_WORKSPACE_WRITES: undefined };
  const FORMER = { ADMINS: [OTHER_ADMIN] };

  it("still lists a passkey and removes it through the whole ceremony while writes are off",
      async () => {
    const harness = adminWritesHarness();
    const passkey = await authenticator();
    await enrol(harness, passkey);
    expect((await listed(harness, OFF)).map(listing => listing.id))
        .toEqual([passkey.credentialId]);

    await harness.inDo(async settings => settings.removeAdminPasskey(
        passkey.credentialId,
        await passkey.assert(await settings.beginAdminPasskeyRemoval(passkey.credentialId, ADMIN)),
        actor(ADMIN, "removeAdminPasskey")), OFF);
    expect(await listed(harness, OFF)).toEqual([]);
    expect(harness.appended.map(record => "method" in record && record.method))
        .toEqual(["addAdminPasskey", "removeAdminPasskey"]);
  });

  it.each([
    ["while writes are off", OFF, ADMIN_WRITE_ERROR_CODES.writesOff],
    ["for an admin who is no longer one", FORMER, ADMIN_ACCESS_ERROR_CODES.notAdmin],
  ] as const)("enrols nothing %s, and leaves the challenge unspent", async (_when, vars, code) => {
    const harness = adminWritesHarness();
    const passkey = await authenticator();
    // Answered while ADMIN could still enrol.
    const registration = await harness.inDo(
        async settings => passkey.register(settings.beginAdminPasskeyEnrolment(ADMIN)));
    const challenges = await storedChallenges(harness);

    const begun = await harness.inDo(async settings =>
        rejection((async () => settings.beginAdminPasskeyEnrolment(ADMIN))()), vars);
    expect(begun).toMatchObject({ code });
    const added = await harness.inDo(settings => rejection(
        settings.addAdminPasskey("Laptop", registration, actor(ADMIN, "addAdminPasskey"))), vars);
    expect(added).toMatchObject({ code });

    expect(await storedPasskeys(harness)).toEqual([]);
    expect(await storedChallenges(harness)).toStrictEqual(challenges);
    expect(harness.appended).toEqual([]);
  });

  it("lets a former admin remove no passkey, their own included", async () => {
    const harness = adminWritesHarness();
    const passkey = await authenticator();
    await enrol(harness, passkey);
    // Answered while ADMIN was still an admin.
    const assertion = await removalAssertion(harness, passkey.credentialId, passkey);
    const challenges = await storedChallenges(harness);

    const begun = await harness.inDo(settings => rejection(
        settings.beginAdminPasskeyRemoval(passkey.credentialId, ADMIN)), FORMER);
    expect(begun).toMatchObject({ code: ADMIN_ACCESS_ERROR_CODES.notAdmin });
    const removed = await refusedRemoval(harness, passkey.credentialId, assertion, ADMIN, FORMER);
    expect(removed).toMatchObject({ code: ADMIN_ACCESS_ERROR_CODES.notAdmin });

    expect((await listed(harness, FORMER)).map(listing => listing.id))
        .toEqual([passkey.credentialId]);
    expect(await storedChallenges(harness)).toStrictEqual(challenges);
    expect(harness.appended).toHaveLength(1);
  });
});
