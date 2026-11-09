import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  ADMIN_ACCESS_ERROR_CODES, ADMIN_PASSKEY_CHALLENGE_LIFETIME_SECONDS, ADMIN_WRITE_ERROR_CODES,
  ADMIN_WRITE_REQUEST_LIFETIME_SECONDS, ADMIN_WRITE_SETTLE_SECONDS, MAX_ADMIN_AUDIT_ARG_LENGTH,
  getAdminWriteErrorCode,
  type AdminPasskeyAssertion, type AdminPasskeyChallenge, type AdminPasskeyRefusal,
  type AdminWriteRecord,
} from "@gadgets/workshop-shared/api";
import { auditOwnerId, type AdminWriteActor } from "../src/admin-access.js";
import type { AdminSettings } from "../src/admin-settings.js";
import { adminWriteDigest, type StoredAdminWrite } from "../src/admin-writes.js";
import { MAX_CREDENTIAL_ID_LENGTH } from "../src/webauthn.js";
import { ADMIN, OTHER_ADMIN, adminWritesHarness } from "./admin-writes-harness";
import { softwareAuthenticator, type Tamper } from "./software-authenticator";

const ORIGIN = "https://workshop.example";
const DAY_MS = 24 * 60 * 60 * 1000;
const SETTLE_MS = ADMIN_WRITE_SETTLE_SECONDS * 1000;
const DEMOTED = "Its requester is no longer a deployment admin.";
const ANSWER_LOST =
    "The workspace's answer never arrived, so whether the write was applied is unknown.";
const BASE64URL = { alphabet: "base64url", omitPadding: true } as const;
const { passkeyRefused, passkeyRequired, requestNotFound, requestNotPending } =
    ADMIN_WRITE_ERROR_CODES;

type Authenticator = Awaited<ReturnType<typeof softwareAuthenticator>>;

let harness: ReturnType<typeof adminWritesHarness>;
// ADMIN's passkey and OTHER_ADMIN's, each enrolled, and one pending request made by ADMIN.
let passkeyA: Authenticator;
let passkeyB: Authenticator;
let made: StoredAdminWrite;
let warned: MockInstance<typeof console.warn>;

beforeEach(async () => {
  // Every refusal is logged for operators.
  warned = vi.spyOn(console, "warn").mockImplementation(() => {});
  harness = adminWritesHarness();
  passkeyA = await enrol(ADMIN);
  passkeyB = await enrol(OTHER_ADMIN);
  made = await requestWrite();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await harness.inDo((_settings, state) => state.storage.deleteAlarm());
});

function actor(admin: string): AdminWriteActor {
  return { admin, sessionId: `session of ${admin}`, via: "api" };
}

/** Enrols a fresh passkey for `admin` through the whole ceremony. */
async function enrol(admin: string): Promise<Authenticator> {
  const passkey = await softwareAuthenticator({ origin: ORIGIN });
  await harness.inDo(async settings => settings.addAdminPasskey(
      "Laptop", await passkey.register(settings.beginAdminPasskeyEnrolment(admin)),
      { ...actor(admin), method: "addAdminPasskey" }));
  return passkey;
}

/** Makes a request through the object, as AdminApiImpl builds one, and returns it as stored:
 * made by ADMIN from the CLI unless `overrides` say otherwise. */
async function requestWrite(overrides: Partial<StoredAdminWrite> = {})
    : Promise<StoredAdminWrite> {
  const requestedAt = new Date();
  const request: StoredAdminWrite = {
    id: crypto.randomUUID(), workspaceId: "a".repeat(64), workspaceTitle: "Quarterly report",
    workspaceOwner: "bob@example.test", action: "deleteChat", args: { chatId: 3 },
    reason: "Ticket 7: chat is stuck", requestedBy: ADMIN, via: "cli",
    sessionId: "session of the requester", requestedAt,
    expiresAt: new Date(requestedAt.getTime() + ADMIN_WRITE_REQUEST_LIFETIME_SECONDS * 1000),
    state: "pending",
    ...overrides,
  };
  await harness.inDo(settings => settings.requestWorkspaceWrite(request));
  return request;
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

const codeOf = async (call: Promise<unknown>) => getAdminWriteErrorCode(await rejection(call));

/** Begins `admin`'s approval of request `id`. */
function begin(admin = ADMIN, id = made.id): Promise<AdminPasskeyChallenge> {
  return harness.inDo(settings => settings.beginWorkspaceWriteApproval(id, admin));
}

/** Begins `admin`'s approval of request `id` and has `passkey` answer it, falsified by
 * `tamper`. */
async function answer(passkey: Authenticator, admin = ADMIN, id = made.id, tamper?: Tamper)
    : Promise<AdminPasskeyAssertion> {
  return passkey.assert(await begin(admin, id), tamper);
}

/** Sends `assertion` as `admin`'s approval of request `id`. */
function approve(assertion: AdminPasskeyAssertion, admin = ADMIN, id = made.id, more?: object) {
  return harness.inDo(
      settings => settings.approveWorkspaceWrite(id, assertion, actor(admin)), more);
}

/** Sends `assertion` as `admin`'s approval of request `id`, returning the code it is refused
 * with. */
function refusal(assertion: AdminPasskeyAssertion, admin = ADMIN, id = made.id, more?: object) {
  return harness.inDo(
      settings => codeOf(settings.approveWorkspaceWrite(id, assertion, actor(admin))), more);
}

/** The request as it is stored, read without a sweep. */
const stored = (id = made.id) =>
    harness.inDo(settings => harness.storageOf(settings).adminWrites.get(id));
const storedPasskey = (passkey: Authenticator) =>
    harness.inDo(settings => harness.storageOf(settings).adminPasskeys.get(passkey.credentialId));
const storedChallenges = () =>
    harness.inDo(settings => [...harness.storageOf(settings).adminPasskeyChallenges.list()]);

/** The write records of request `id`, in the order they were appended. */
const recordsOf = (id = made.id) => harness.appended
    .filter((record): record is AdminWriteRecord => record.kind === "write")
    .filter(record => record.requestId === id);
const eventsOf = (id = made.id) => recordsOf(id).map(record => record.event);

/** The record of `request`'s step `event`, taken by `by`, with the event's own fields in
 * `extra`. */
function recordOf(request: StoredAdminWrite, event: AdminWriteRecord["event"],
    by: AdminWriteActor, extra: object = {}): unknown {
  return {
    kind: "write", at: expect.any(Date), ...by, requestId: request.id, event,
    workspaceId: request.workspaceId, workspaceOwner: request.workspaceOwner,
    workspaceTitle: request.workspaceTitle, method: request.action, args: { chatId: 3 },
    reason: request.reason, requestedBy: request.requestedBy, ...extra,
  };
}

/** The record of `admin`'s refused attempt on `request`: the check it failed and, when the answer
 * named one of that admin's own, the passkey. */
function refusedRecord(request: StoredAdminWrite, admin: string, check: AdminPasskeyRefusal,
    passkey?: Authenticator): unknown {
  return recordOf(request, "refused", actor(admin),
      { refusal: check, ...(passkey && { passkey: passkey.credentialId }) });
}

const requesterOf = ({ requestedBy: admin, sessionId, via }: StoredAdminWrite) =>
    ({ admin, sessionId, via });

/** Moves a stored request's expiry into the past, as time passing would. */
function age(settings: AdminSettings, id: string): void {
  const writes = harness.storageOf(settings).adminWrites;
  writes.put({ ...writes.get(id)!, expiresAt: new Date(Date.now() - 1000) });
}

/** `assertion` with the last bit of its signature flipped. */
function withFlippedSignature(assertion: AdminPasskeyAssertion): AdminPasskeyAssertion {
  const signature = Uint8Array.fromBase64(assertion.signature, BASE64URL);
  signature[signature.length - 1] ^= 1;
  return { ...assertion, signature: signature.toBase64(BASE64URL) };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

/** Runs `hook` in the middle of every assertion's verification from here on: once everything
 * about the answer but its signature has been checked, and before the request is claimed. */
function duringVerification(hook: () => void): void {
  const verify = crypto.subtle.verify.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, "verify").mockImplementation((...args) => {
    hook();
    return verify(...args);
  });
}

describe("beginWorkspaceWriteApproval", () => {
  it("issues a challenge that ends with the request's digest, for the caller's own passkeys",
      async () => {
    const before = Date.now();
    const challenge = await begin();
    const after = Date.now();

    // 32 random bytes and the 32 of the digest, as unpadded base64url.
    expect(challenge.challenge).toMatch(/^[A-Za-z0-9_-]{86}$/);
    const bytes = Uint8Array.fromBase64(challenge.challenge, BASE64URL);
    expect(bytes).toHaveLength(64);
    expect(bytes.subarray(32)).toStrictEqual(await adminWriteDigest(made));
    expect(challenge.rpId).toBe("workshop.example");
    // Never OTHER_ADMIN's passkey.
    expect(challenge.credentialIds).toEqual([passkeyA.credentialId]);

    const lifetime = ADMIN_PASSKEY_CHALLENGE_LIFETIME_SECONDS * 1000;
    expect(challenge.expiresAt.getTime()).toBeGreaterThanOrEqual(before + lifetime);
    expect(challenge.expiresAt.getTime()).toBeLessThanOrEqual(after + lifetime);
    expect(await storedChallenges()).toStrictEqual([{
      key: `approve:${ADMIN}`, challenge: challenge.challenge, subject: made.id,
      expiresAt: challenge.expiresAt.getTime(),
    }]);
    // Beginning answers nothing, so it is not recorded.
    expect(eventsOf()).toEqual(["requested"]);
    expect(await stored()).toStrictEqual(made);
  });

  it("issues a fresh challenge each time, replacing the caller's last and nobody else's",
      async () => {
    const first = await begin();
    const theirs = await begin(OTHER_ADMIN);
    const second = await begin();
    expect(second.challenge).not.toBe(first.challenge);
    // The random half differs, and the digest half is the same request's.
    expect(second.challenge.slice(-42)).toBe(first.challenge.slice(-42));
    expect(theirs.credentialIds).toEqual([passkeyB.credentialId]);
    expect((await storedChallenges()).map(({ key, challenge }) => [key, challenge])).toEqual([
      [`approve:${ADMIN}`, second.challenge], [`approve:${OTHER_ADMIN}`, theirs.challenge],
    ]);
  });

  it("never lets a challenge outlast its request", async () => {
    const soon = await requestWrite({ expiresAt: new Date(Date.now() + 60_000) });
    const challenge = await begin(ADMIN, soon.id);
    expect(challenge.expiresAt).toStrictEqual(soon.expiresAt);
    expect((await storedChallenges())[0]!.expiresAt).toBe(soon.expiresAt.getTime());
  });

  it("refuses an admin who has enrolled no passkey", async () => {
    const third = "third-admin@example.test";
    expect(await harness.inDo(
        settings => codeOf(settings.beginWorkspaceWriteApproval(made.id, third)),
        { ADMINS: [ADMIN, OTHER_ADMIN, third] })).toBe(passkeyRequired);
    expect(await storedChallenges()).toEqual([]);
    expect(eventsOf()).toEqual(["requested"]);
  });

  it("refuses a denied or an expired request, recording nothing of its own", async () => {
    const expired = await requestWrite();
    await harness.inDo(async settings => {
      await settings.denyWorkspaceWrite(made.id, actor(OTHER_ADMIN));
      age(settings, expired.id);
      expect(await codeOf(settings.beginWorkspaceWriteApproval(made.id, ADMIN)))
          .toBe(requestNotPending);
      expect(await codeOf(settings.beginWorkspaceWriteApproval(expired.id, ADMIN)))
          .toBe(requestNotPending);
    });
    expect(await storedChallenges()).toEqual([]);
    // The expiry is the sweep's record, written in the requester's name.
    expect(eventsOf()).toEqual(["requested", "denied"]);
    expect(eventsOf(expired.id)).toEqual(["requested", "expired"]);
  });

  it("finds nothing to approve under an unknown id", async () => {
    expect(await harness.inDo(settings =>
        codeOf(settings.beginWorkspaceWriteApproval(crypto.randomUUID(), ADMIN))))
        .toBe(requestNotFound);
    expect(await storedChallenges()).toEqual([]);
  });

  it("refuses while PUBLIC_BASE_URL is unset, storing no challenge", async () => {
    expect(await harness.inDo(
        settings => codeOf(settings.beginWorkspaceWriteApproval(made.id, ADMIN)),
        { PUBLIC_BASE_URL: undefined })).toBe(ADMIN_WRITE_ERROR_CODES.originUnset);
    expect(await storedChallenges()).toEqual([]);
  });
});

describe("approveWorkspaceWrite", () => {
  it("spends the request: approved by the actor, with the passkey that signed", async () => {
    const assertion = await answer(passkeyA);
    const before = Date.now();
    const approved = await approve(assertion);
    const after = Date.now();

    expect(approved).toStrictEqual({
      ...made, state: "approved", resolvedBy: ADMIN, resolvedAt: expect.any(Date),
      approver: { ...actor(ADMIN), passkey: passkeyA.credentialId },
    });
    expect(approved.resolvedAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(approved.resolvedAt!.getTime()).toBeLessThanOrEqual(after);
    expect(await stored()).toStrictEqual(approved);

    // The passkey's use is stored: the counter its assertion reported, and when.
    const passkey = (await storedPasskey(passkeyA))!;
    expect(passkey.signCount).toBe(2);
    expect(passkey.lastUsed!.getTime()).toBeGreaterThanOrEqual(before);
    expect(passkey.lastUsed!.getTime()).toBeLessThanOrEqual(after);
    expect((await storedPasskey(passkeyB))!.lastUsed).toBeUndefined();

    // The challenge is spent, and the approval itself is not recorded here: the workspace
    // records "approved" before it changes anything.
    expect(await storedChallenges()).toEqual([]);
    expect(eventsOf()).toEqual(["requested"]);
    expect(warned).not.toHaveBeenCalled();
    // The alarm is due when the workspace's answer would be overdue.
    expect(await harness.inDo((_settings, state) => state.storage.getAlarm()))
        .toBe(approved.resolvedAt!.getTime() + SETTLE_MS);
  });

  it("is resolved by the admin who approved it, not by the one who asked", async () => {
    // ADMIN's request, approved by OTHER_ADMIN with OTHER_ADMIN's passkey.
    expect(made.requestedBy).toBe(ADMIN);
    const approved = await approve(await answer(passkeyB, OTHER_ADMIN), OTHER_ADMIN);

    expect(approved).toStrictEqual({
      ...made, state: "approved", resolvedBy: OTHER_ADMIN, resolvedAt: expect.any(Date),
      approver: { ...actor(OTHER_ADMIN), passkey: passkeyB.credentialId },
    });
    expect(await stored()).toStrictEqual(approved);
    // Only the passkey that signed was used.
    expect((await storedPasskey(passkeyB))!.lastUsed).toBeInstanceOf(Date);
    expect((await storedPasskey(passkeyA))!.lastUsed).toBeUndefined();

    // The closing record is the approver's too, and still says who asked.
    await harness.inDo(settings => settings.settleWorkspaceWrite(made.id, {}));
    expect(recordsOf().slice(1)).toStrictEqual(
        [recordOf(made, "applied", actor(OTHER_ADMIN), { passkey: passkeyB.credentialId })]);
  });

  it("spends the challenge before it sweeps, so also when the sweep cannot finish", async () => {
    const overdue = await requestWrite();
    const assertion = await answer(passkeyA);
    await harness.inDo(async settings => {
      age(settings, overdue.id);
      // The sweep stops at the overdue request, whose expiry it cannot record.
      harness.audit.fail = true;
      expect(await rejection(settings.approveWorkspaceWrite(made.id, assertion, actor(ADMIN))))
          .toStrictEqual(new Error("audit log unavailable"));
    });
    expect(await storedChallenges()).toEqual([]);
    expect(await stored()).toStrictEqual(made);
    expect(eventsOf()).toEqual(["requested"]);

    // With the log back, the same answer finds its challenge spent.
    harness.audit.fail = false;
    expect(await refusal(assertion)).toBe(passkeyRefused);
    expect(recordsOf().slice(1)).toStrictEqual([refusedRecord(made, ADMIN, "challenge", passkeyA)]);
    expect(await stored()).toStrictEqual(made);
    expect((await storedPasskey(passkeyA))!.lastUsed).toBeUndefined();
    expect(eventsOf(overdue.id)).toEqual(["requested", "expired"]);
  });
});

describe("a refused approval", () => {
  // A challenge of the right shape that the server never issued.
  const NEVER_ISSUED = "A".repeat(86);

  it.each<[string, AdminPasskeyRefusal, Tamper, boolean?]>([
    ["made on another origin", "origin", { origin: "https://evil.example" }],
    ["signed for another relying party", "relyingParty", { rpId: "evil.example" }],
    ["made without user verification", "userVerification", { userVerified: false }],
    ["over a challenge the server never issued", "challenge", { challenge: NEVER_ISSUED }],
    // The passkey's counter is 1 since its enrolment.
    ["whose counter did not rise", "counter", { signCount: 1 }],
    ["with one signature bit flipped", "signature", {}, true],
  ])("leaves the request pending, spends the challenge and is recorded: an answer %s",
      async (_label, check, tamper, flip) => {
    let assertion = await answer(passkeyA, ADMIN, made.id, tamper);
    if (flip) assertion = withFlippedSignature(assertion);

    expect(await refusal(assertion)).toBe(passkeyRefused);
    expect(await stored()).toStrictEqual(made);
    expect(await storedChallenges()).toEqual([]);
    // Who tried, through which session, the check that failed and the passkey the answer named.
    expect(recordsOf()).toStrictEqual([
      recordOf(made, "requested", requesterOf(made)),
      refusedRecord(made, ADMIN, check, passkeyA),
    ]);
    // Operators are told the check, and nothing of the answer.
    expect(warned.mock.calls.map(([entry]) => entry)).toEqual([expect.objectContaining(
        { event: "admin.write.approval.refused", reason: check })]);
    expect(JSON.stringify(warned.mock.calls)).not.toContain(assertion.signature);

    // The same answer sent again finds its challenge spent.
    expect(await refusal(assertion)).toBe(passkeyRefused);
    expect(recordsOf().slice(2)).toStrictEqual([refusedRecord(made, ADMIN, "challenge", passkeyA)]);
    expect(await stored()).toStrictEqual(made);

    // A refused answer stores no use of the passkey.
    const passkey = (await storedPasskey(passkeyA))!;
    expect(passkey.signCount).toBe(1);
    expect(passkey.lastUsed).toBeUndefined();
  });

  it("is still a refusal when its record cannot be appended, and the record is written later",
      async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const assertion = await answer(passkeyA, ADMIN, made.id, { userVerified: false });
    harness.audit.fail = true;
    const before = Date.now();
    expect(await refusal(assertion)).toBe(passkeyRefused);
    expect(logged.mock.calls.map(([entry]) => entry)).toEqual([expect.objectContaining(
        { event: "admin.audit.append.failed", operation: "deleteChat" })]);
    // Still pending, with the record owed and the alarm due for it, not for the expiry.
    const owed = { ...actor(ADMIN), refusal: "userVerification", passkey: passkeyA.credentialId };
    expect(await stored()).toStrictEqual({ ...made, refusals: [owed] });
    expect(await storedChallenges()).toEqual([]);
    expect(eventsOf()).toEqual(["requested"]);
    const alarm = await harness.inDo((_settings, state) => state.storage.getAlarm());
    expect(alarm).toBeGreaterThanOrEqual(before + 30_000);
    expect(alarm).toBeLessThan(made.expiresAt.getTime());

    // While the log stays down the record stays owed, and no call fails for it.
    expect(await harness.inDo(settings => settings.getWorkspaceWrite(made.id)))
        .toStrictEqual({ ...made, refusals: [owed] });
    expect(eventsOf()).toEqual(["requested"]);

    // Once the log is back the next sweep writes it, and the request can still be approved with
    // a fresh challenge.
    harness.audit.fail = false;
    expect((await approve(await answer(passkeyA))).state).toBe("approved");
    expect(recordsOf().slice(1)).toStrictEqual(
        [refusedRecord(made, ADMIN, "userVerification", passkeyA)]);
    expect(await stored()).not.toHaveProperty("refusals");
  });

  it("keeps a resolved request until the record of a replay it owes is written", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const assertion = await answer(passkeyA);
    await approve(assertion);
    await harness.inDo(settings => settings.settleWorkspaceWrite(made.id, {}));
    harness.audit.fail = true;
    expect(await refusal(assertion)).toBe(requestNotPending);
    const owed = { ...actor(ADMIN), refusal: "challenge", passkey: passkeyA.credentialId };

    await harness.inDo(async settings => {
      const writes = harness.storageOf(settings).adminWrites;
      expect(writes.get(made.id)!.refusals).toStrictEqual([owed]);
      // A day after it was resolved, when it would be forgotten.
      writes.put({ ...writes.get(made.id)!, resolvedAt: new Date(Date.now() - DAY_MS - 1000) });
      await settings.alarm();
      expect(writes.get(made.id)!.refusals).toStrictEqual([owed]);

      harness.audit.fail = false;
      await settings.alarm();
      expect(writes.get(made.id)).toBeUndefined();
    });
    expect(recordsOf().at(-1)).toStrictEqual(refusedRecord(made, ADMIN, "challenge", passkeyA));
    expect(eventsOf()).toEqual(["requested", "applied", "refused"]);
  });

  it("keeps the first ten refusals owed while the log is down, each written once", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    harness.audit.fail = true;
    for (let attempt = 0; attempt < 11; attempt++) {
      expect(await refusal(await answer(passkeyA, ADMIN, made.id, { userVerified: false })))
          .toBe(passkeyRefused);
    }
    expect((await stored())!.refusals).toHaveLength(10);
    expect(eventsOf()).toEqual(["requested"]);

    harness.audit.fail = false;
    await harness.inDo(async settings => {
      await settings.alarm();
      await settings.alarm();
    });
    expect(await stored()).toStrictEqual(made);
    expect(recordsOf().slice(1)).toStrictEqual(Array.from(
        { length: 10 }, () => refusedRecord(made, ADMIN, "userVerification", passkeyA)));
  });

  it("records a replay: the assertion that approved a request, sent again for it", async () => {
    const assertion = await answer(passkeyA);
    const approved = await approve(assertion);
    const used = await storedPasskey(passkeyA);

    expect(await refusal(assertion)).toBe(requestNotPending);
    expect(recordsOf()).toStrictEqual([
      recordOf(made, "requested", requesterOf(made)),
      refusedRecord(made, ADMIN, "challenge", passkeyA),
    ]);
    expect(await stored()).toStrictEqual(approved);

    // Once the request is settled too, after its closing record.
    const applied = await harness.inDo(settings => settings.settleWorkspaceWrite(made.id, {}));
    expect(await refusal(assertion)).toBe(requestNotPending);
    expect(eventsOf()).toEqual(["requested", "refused", "applied", "refused"]);
    expect(recordsOf().at(-1)).toStrictEqual(refusedRecord(made, ADMIN, "challenge", passkeyA));
    expect(await stored()).toStrictEqual(applied);
    expect(applied.approver).toStrictEqual(approved.approver);
    // The passkey's counter and last use are those of the approval.
    expect(await storedPasskey(passkeyA)).toStrictEqual(used);
  });

  it("refuses the assertion that approved one request when it is sent for another", async () => {
    const second = await requestWrite();
    const assertion = await answer(passkeyA);
    await approve(assertion);

    expect(await refusal(assertion, ADMIN, second.id)).toBe(passkeyRefused);
    expect(recordsOf(second.id)).toStrictEqual([
      recordOf(second, "requested", requesterOf(second)),
      refusedRecord(second, ADMIN, "challenge", passkeyA),
    ]);
    expect(await stored(second.id)).toStrictEqual(second);
    expect(eventsOf()).toEqual(["requested"]);
  });

  it("records an attempt on a denied request, and one on an expired request", async () => {
    const expired = await requestWrite();
    const onDenied = await answer(passkeyA);
    await harness.inDo(settings => settings.denyWorkspaceWrite(made.id, actor(OTHER_ADMIN)));
    expect(await refusal(onDenied)).toBe(requestNotPending);
    expect(recordsOf()).toStrictEqual([
      recordOf(made, "requested", requesterOf(made)),
      recordOf(made, "denied", actor(OTHER_ADMIN)),
      refusedRecord(made, ADMIN, "challenge", passkeyA),
    ]);
    expect((await stored())!.state).toBe("denied");

    // The attempt's own sweep ends the overdue request first, in its requester's name.
    const onExpired = await answer(passkeyA, ADMIN, expired.id);
    await harness.inDo(settings => age(settings, expired.id));
    expect(await refusal(onExpired, ADMIN, expired.id)).toBe(requestNotPending);
    expect(recordsOf(expired.id)).toStrictEqual([
      recordOf(expired, "requested", requesterOf(expired)),
      recordOf(expired, "expired", requesterOf(expired)),
      refusedRecord(expired, ADMIN, "challenge", passkeyA),
    ]);
    expect((await stored(expired.id))!.state).toBe("expired");
    expect((await storedPasskey(passkeyA))!.lastUsed).toBeUndefined();
  });

  it("finds nothing under an id that names no request, and records nothing", async () => {
    const assertion = await answer(passkeyA);
    const records = harness.appended.length;
    for (let id of [crypto.randomUUID(), "", "nope", "x".repeat(5000)]) {
      expect(await refusal(assertion, ADMIN, id)).toBe(requestNotFound);
    }
    expect(harness.appended).toHaveLength(records);
    expect(await stored()).toStrictEqual(made);
    // The answer spent the caller's challenge all the same.
    expect(await storedChallenges()).toEqual([]);
  });
});

describe("whose passkey, and which request", () => {
  it("refuses another admin's credential, and an assertion sent through another admin",
      async () => {
    // OTHER_ADMIN's own challenge, answered with ADMIN's authenticator.
    const stolen = await answer(passkeyA, OTHER_ADMIN);
    expect(await refusal(stolen, OTHER_ADMIN)).toBe(passkeyRefused);
    // ADMIN's answer to ADMIN's own challenge, sent by OTHER_ADMIN, who has none outstanding.
    const theirs = await answer(passkeyA);
    expect(await refusal(theirs, OTHER_ADMIN)).toBe(passkeyRefused);

    // Each is recorded as OTHER_ADMIN's attempt, and names no passkey: the credential is not
    // OTHER_ADMIN's.
    expect(recordsOf().slice(1)).toStrictEqual([
      refusedRecord(made, OTHER_ADMIN, "credential"),
      refusedRecord(made, OTHER_ADMIN, "challenge"),
    ]);
    expect(await stored()).toStrictEqual(made);
    expect((await storedPasskey(passkeyA))!.lastUsed).toBeUndefined();

    // ADMIN's challenge is ADMIN's alone: OTHER_ADMIN's attempt did not spend it.
    expect((await approve(theirs)).approver).toStrictEqual(
        { ...actor(ADMIN), passkey: passkeyA.credentialId });
  });

  it("lets a former admin's passkey approve nothing", async () => {
    // ADMIN is no longer an admin. A request of ADMIN's own would have ended with that.
    const former = { ADMINS: [OTHER_ADMIN] };
    const request = await requestWrite({ requestedBy: OTHER_ADMIN });
    const challenge = await harness.inDo(
        settings => settings.beginWorkspaceWriteApproval(request.id, OTHER_ADMIN), former);
    expect(challenge.credentialIds).toEqual([passkeyB.credentialId]);
    // The passkey stays stored.
    expect(await storedPasskey(passkeyA)).toMatchObject({ admin: ADMIN });

    expect(await refusal(await passkeyA.assert(challenge), OTHER_ADMIN, request.id, former))
        .toBe(passkeyRefused);
    expect(recordsOf(request.id).slice(1)).toStrictEqual(
        [refusedRecord(request, OTHER_ADMIN, "credential")]);
    expect(await stored(request.id)).toStrictEqual(request);
    expect((await storedPasskey(passkeyA))!.lastUsed).toBeUndefined();
  });

  it.each<[string, Partial<StoredAdminWrite>]>([
    ["arguments", { args: { chatId: 4 } }],
    ["reason", { reason: "Ticket 7: chat is stuck." }],
    ["workspace", { workspaceId: "b".repeat(64) }],
    ["workspace's owner", { workspaceOwner: "mallory@example.test" }],
  ])("refuses a request whose %s changed after the challenge was issued",
      async (_label, change) => {
    const assertion = await answer(passkeyA);
    const tampered = { ...made, ...change };
    await harness.inDo(settings => harness.storageOf(settings).adminWrites.put(tampered));

    expect(await refusal(assertion)).toBe(passkeyRefused);
    expect(await stored()).toStrictEqual(tampered);
    // The passkey signed the request the admin was shown, which this no longer is.
    expect(recordsOf().at(-1)).toMatchObject(
        { event: "refused", refusal: "challenge", admin: ADMIN, passkey: passkeyA.credentialId });
    expect(eventsOf()).toEqual(["requested", "refused"]);
    expect((await storedPasskey(passkeyA))!.lastUsed).toBeUndefined();
  });

  it("checks whose passkey answered before which request the challenge was issued for",
      async () => {
    // OTHER_ADMIN's own challenge, answered with ADMIN's authenticator, for a request that has
    // changed since.
    const stolen = await answer(passkeyA, OTHER_ADMIN);
    const tampered = { ...made, reason: "Ticket 7: chat is stuck." };
    await harness.inDo(settings => harness.storageOf(settings).adminWrites.put(tampered));

    expect(await refusal(stolen, OTHER_ADMIN)).toBe(passkeyRefused);
    // Either check would refuse it. The record names the one that comes first, and no passkey:
    // the credential is not OTHER_ADMIN's.
    expect(recordsOf().slice(1)).toStrictEqual(
        [refusedRecord(tampered, OTHER_ADMIN, "credential")]);
    expect(await stored()).toStrictEqual(tampered);
  });

  it("does not approve one request with the challenge issued for another", async () => {
    const other = await requestWrite();
    const assertion = await answer(passkeyA);

    expect(await refusal(assertion, ADMIN, other.id)).toBe(passkeyRefused);
    expect(recordsOf(other.id).slice(1)).toStrictEqual(
        [refusedRecord(other, ADMIN, "challenge", passkeyA)]);
    expect(await stored(other.id)).toStrictEqual(other);
    // The request the challenge was issued for is untouched, and nothing of it was recorded.
    expect(await stored()).toStrictEqual(made);
    expect(eventsOf()).toEqual(["requested"]);
  });

  it("approves only with the challenge begun last", async () => {
    const first = await answer(passkeyA);
    await begin();
    expect(await refusal(first)).toBe(passkeyRefused);
    expect(recordsOf().slice(1)).toStrictEqual([refusedRecord(made, ADMIN, "challenge", passkeyA)]);

    await begin();
    expect((await approve(await answer(passkeyA))).state).toBe("approved");
  });

  it("refuses a passkey removed since the challenge was issued", async () => {
    const assertion = await answer(passkeyA);
    await harness.inDo(
        settings => harness.storageOf(settings).adminPasskeys.delete(passkeyA.credentialId));

    expect(await refusal(assertion)).toBe(passkeyRefused);
    // No passkey of the caller's is named: the one the answer names is gone.
    expect(recordsOf().slice(1)).toStrictEqual([refusedRecord(made, ADMIN, "credential")]);
    expect(await stored()).toStrictEqual(made);
  });

  it("refuses an over-long credential id without using it as a storage key", async () => {
    const assertion = await answer(passkeyA);
    const credentialId = "A".repeat(MAX_CREDENTIAL_ID_LENGTH + 1);
    expect(credentialId).toHaveLength(1365);
    await harness.inDo(async settings => {
      const get = vi.spyOn(harness.storageOf(settings).adminPasskeys, "get");
      expect(await codeOf(settings.approveWorkspaceWrite(
          made.id, { ...assertion, credentialId }, actor(ADMIN)))).toBe(passkeyRefused);
      expect(get).not.toHaveBeenCalled();
    });
    expect(recordsOf().slice(1)).toStrictEqual([refusedRecord(made, ADMIN, "credential")]);
    expect(await stored()).toStrictEqual(made);

    // One of the longest length accepted is looked up.
    await begin();
    const longest = "A".repeat(MAX_CREDENTIAL_ID_LENGTH);
    await harness.inDo(async settings => {
      const get = vi.spyOn(harness.storageOf(settings).adminPasskeys, "get");
      expect(await codeOf(settings.approveWorkspaceWrite(
          made.id, { ...assertion, credentialId: longest }, actor(ADMIN)))).toBe(passkeyRefused);
      expect(get.mock.calls).toEqual([[longest]]);
    });
  });

  it("names a passkey with a long credential id as the audit log keeps one", async () => {
    // ADMIN's key, stored under an id longer than a record keeps whole.
    const credentialId = `${passkeyA.credentialId}${"A".repeat(300)}`;
    await harness.inDo(settings => {
      const passkeys = harness.storageOf(settings).adminPasskeys;
      passkeys.put({ ...passkeys.get(passkeyA.credentialId)!, id: credentialId });
    });
    const kept = auditOwnerId(credentialId);
    expect(kept).toHaveLength(MAX_ADMIN_AUDIT_ARG_LENGTH);
    expect(kept).toMatch(/…#[0-9a-f]{20}$/);

    const unverified = await answer(passkeyA, ADMIN, made.id, { userVerified: false });
    expect(await refusal({ ...unverified, credentialId })).toBe(passkeyRefused);
    expect(recordsOf().at(-1)).toMatchObject({ event: "refused", passkey: kept });

    const approved = await approve({ ...(await answer(passkeyA)), credentialId });
    expect(approved.approver.passkey).toBe(kept);
    await harness.inDo(settings => settings.settleWorkspaceWrite(made.id, {}));
    expect(recordsOf().at(-1)).toMatchObject({ event: "applied", passkey: kept });
  });
});

describe("an approval racing something else", () => {
  it("refuses a request that runs out while its assertion is verified, and leaves it to the sweep",
      async () => {
    const assertion = await answer(passkeyA);
    await harness.inDo(async settings => {
      const now = vi.spyOn(Date, "now");
      duringVerification(() => now.mockReturnValue(made.expiresAt.getTime()));
      expect(await codeOf(settings.approveWorkspaceWrite(made.id, assertion, actor(ADMIN))))
          .toBe(requestNotPending);
      expect(now).toHaveReturnedWith(made.expiresAt.getTime());
      // Still stored as pending: ending it is the sweep's, which records it first.
      expect(harness.storageOf(settings).adminWrites.get(made.id)).toStrictEqual(made);
      expect(eventsOf()).toEqual(["requested", "refused"]);
      expect((await settings.getWorkspaceWrite(made.id)).state).toBe("expired");
    });
    expect(recordsOf().slice(1)).toStrictEqual([
      refusedRecord(made, ADMIN, "challenge", passkeyA),
      recordOf(made, "expired", requesterOf(made)),
    ]);
    expect((await storedPasskey(passkeyA))!.lastUsed).toBeUndefined();
  });

  it("claims the request only if it is still pending once the assertion is verified",
      async () => {
    const assertion = await answer(passkeyA);
    // What a transition that did not wait its turn would have stored meanwhile.
    const denied: StoredAdminWrite =
        { ...made, state: "denied", resolvedBy: OTHER_ADMIN, resolvedAt: new Date() };
    await harness.inDo(async settings => {
      const writes = harness.storageOf(settings).adminWrites;
      duringVerification(() => writes.put(denied));
      expect(await codeOf(settings.approveWorkspaceWrite(made.id, assertion, actor(ADMIN))))
          .toBe(requestNotPending);
      expect(writes.get(made.id)).toStrictEqual(denied);
    });
    expect(recordsOf().slice(1)).toStrictEqual(
        [refusedRecord(made, ADMIN, "challenge", passkeyA)]);
    expect(await storedPasskey(passkeyA)).toMatchObject({ signCount: 1 });
    expect((await storedPasskey(passkeyA))!.lastUsed).toBeUndefined();
  });

  it("refuses a passkey removed while its assertion is verified", async () => {
    const assertion = await answer(passkeyA);
    await harness.inDo(async settings => {
      const passkeys = harness.storageOf(settings).adminPasskeys;
      duringVerification(() => passkeys.delete(passkeyA.credentialId));
      expect(await codeOf(settings.approveWorkspaceWrite(made.id, assertion, actor(ADMIN))))
          .toBe(passkeyRefused);
      // A removed passkey does not come back.
      expect(passkeys.get(passkeyA.credentialId)).toBeUndefined();
    });
    // It was the caller's own when the answer named it.
    expect(recordsOf().slice(1)).toStrictEqual(
        [refusedRecord(made, ADMIN, "credential", passkeyA)]);
    expect(await stored()).toStrictEqual(made);
  });

  it("approves a request once when two admins approve it at the same time", async () => {
    const fromA = await answer(passkeyA);
    const fromB = await answer(passkeyB, OTHER_ADMIN);
    // Both are started before either is awaited.
    const [won, lost] = await harness.inDo(settings => Promise.allSettled([
      settings.approveWorkspaceWrite(made.id, fromA, actor(ADMIN)),
      settings.approveWorkspaceWrite(made.id, fromB, actor(OTHER_ADMIN)),
    ]));

    expect(won).toMatchObject({ status: "fulfilled", value: {
      state: "approved", resolvedBy: ADMIN,
      approver: { ...actor(ADMIN), passkey: passkeyA.credentialId },
    } });
    expect(lost.status).toBe("rejected");
    expect(getAdminWriteErrorCode((lost as PromiseRejectedResult).reason))
        .toBe(requestNotPending);
    expect(await stored()).toStrictEqual((won as PromiseFulfilledResult<unknown>).value);
    // The loser's attempt is the one record, and only the winner's passkey was used.
    expect(recordsOf().slice(1)).toStrictEqual(
        [refusedRecord(made, OTHER_ADMIN, "challenge", passkeyB)]);
    expect((await storedPasskey(passkeyA))!.lastUsed).toBeInstanceOf(Date);
    expect(await storedPasskey(passkeyB)).toMatchObject({ signCount: 1 });
    expect((await storedPasskey(passkeyB))!.lastUsed).toBeUndefined();
  });

  it("ends a request whose requester is no longer an admin before anyone approves it",
      async () => {
    const assertion = await answer(passkeyB, OTHER_ADMIN);
    const demoted = { ADMINS: [OTHER_ADMIN] };
    expect(await harness.inDo(
        settings => codeOf(settings.beginWorkspaceWriteApproval(made.id, OTHER_ADMIN)), demoted))
        .toBe(requestNotPending);
    expect(await refusal(assertion, OTHER_ADMIN, made.id, demoted)).toBe(requestNotPending);

    expect(await stored()).toStrictEqual(
        { ...made, state: "expired", resolvedAt: expect.any(Date), error: DEMOTED });
    expect(recordsOf().slice(1)).toStrictEqual([
      recordOf(made, "expired", requesterOf(made), { error: DEMOTED }),
      refusedRecord(made, OTHER_ADMIN, "challenge", passkeyB),
    ]);
    expect((await storedPasskey(passkeyB))!.lastUsed).toBeUndefined();
  });

  it("lets a denial that is being recorded win over an approval started meanwhile", async () => {
    const assertion = await answer(passkeyA);
    const release = Promise.withResolvers<void>();
    let appending = 0;
    harness.audit.before = async () => {
      appending++;
      await release.promise;
    };
    await harness.inDo(async settings => {
      const writes = harness.storageOf(settings).adminWrites;
      const denial = settings.denyWorkspaceWrite(made.id, actor(OTHER_ADMIN));
      const approval = codeOf(settings.approveWorkspaceWrite(made.id, assertion, actor(ADMIN)));

      // The denial holds its append open, and the approval has not looked at the request.
      await tick();
      await tick();
      expect(appending).toBe(1);
      expect(writes.get(made.id)?.state).toBe("pending");

      release.resolve();
      await denial;
      expect(await approval).toBe(requestNotPending);
      expect(writes.get(made.id)).toStrictEqual(
          { ...made, state: "denied", resolvedBy: OTHER_ADMIN, resolvedAt: expect.any(Date) });
    });
    // "denied" is the request's only closing record, and the attempt follows it.
    expect(recordsOf().slice(1)).toStrictEqual([
      recordOf(made, "denied", actor(OTHER_ADMIN)),
      refusedRecord(made, ADMIN, "challenge", passkeyA),
    ]);
  });

  it("lets an approval that is being verified win over a denial started meanwhile", async () => {
    const assertion = await answer(passkeyA);
    await harness.inDo(async settings => {
      const approval = settings.approveWorkspaceWrite(made.id, assertion, actor(ADMIN));
      const denial = codeOf(settings.denyWorkspaceWrite(made.id, actor(OTHER_ADMIN)));
      expect((await approval).resolvedBy).toBe(ADMIN);
      expect(await denial).toBe(requestNotPending);
    });
    // No "denied" record exists.
    expect(eventsOf()).toEqual(["requested"]);
    expect(await stored()).toMatchObject({ state: "approved", resolvedBy: ADMIN });
  });
});

/** Approves `made` as ADMIN with ADMIN's passkey, and returns it as stored. */
async function approveMade() {
  return approve(await answer(passkeyA));
}

/** The closing record of `made`: in its approver's name, with the passkey that approved it. */
function closingRecord(event: "applied" | "failed", extra: object): unknown {
  return recordOf(made, event, actor(ADMIN), { passkey: passkeyA.credentialId, ...extra });
}

const errorEvents = (logged: MockInstance<typeof console.error>) =>
    logged.mock.calls.map(([entry]) => (entry as { event?: string }).event);

describe("settleWorkspaceWrite", () => {
  it("stores \"applied\" with what the workspace reported, then records it as the approver's",
      async () => {
    const request = await approveMade();
    const outcome = "2 rejected, 0 could not be rejected, 0 still pending";
    await harness.inDo(async (settings, state) => {
      const writes = harness.storageOf(settings).adminWrites;
      let storedAtAppend: unknown;
      harness.audit.before = async () => { storedAtAppend = writes.get(made.id); };
      const settled = await settings.settleWorkspaceWrite(made.id, { outcome });

      // The answer is stored first, marked until its record is written.
      expect(storedAtAppend).toStrictEqual(
          { ...request, state: "applied", outcome, unrecorded: true });
      expect(settled).toStrictEqual({ ...request, state: "applied", outcome });
      expect(writes.get(made.id)).toStrictEqual(settled);
      // Kept a day from when it was approved.
      expect(await state.storage.getAlarm()).toBe(request.resolvedAt!.getTime() + DAY_MS);
    });
    expect(recordsOf().slice(1)).toStrictEqual([closingRecord("applied", { outcome })]);
  });

  it("records an answer that reports nothing with no outcome", async () => {
    const request = await approveMade();
    const settled = await harness.inDo(settings => settings.settleWorkspaceWrite(made.id, {}));
    expect(settled).toStrictEqual({ ...request, state: "applied" });
    expect(recordsOf().slice(1)).toStrictEqual([closingRecord("applied", {})]);
  });

  it("stores \"failed\" with the workspace's error, cut as the audit log cuts text", async () => {
    const request = await approveMade();
    const error = "e".repeat(MAX_ADMIN_AUDIT_ARG_LENGTH + 40);
    const cut = `${"e".repeat(MAX_ADMIN_AUDIT_ARG_LENGTH - 1)}…`;
    const settled = await harness.inDo(
        settings => settings.settleWorkspaceWrite(made.id, { error }));
    expect(settled).toStrictEqual({ ...request, state: "failed", error: cut });
    expect(await stored()).toStrictEqual(settled);
    expect(recordsOf().slice(1)).toStrictEqual([closingRecord("failed", { error: cut })]);
  });

  it("settles once: a second answer changes and records nothing", async () => {
    await approveMade();
    await harness.inDo(async settings => {
      const first = await settings.settleWorkspaceWrite(made.id, { outcome: "done" });
      expect(await settings.settleWorkspaceWrite(made.id, { error: "too late" }))
          .toStrictEqual(first);
      expect(harness.storageOf(settings).adminWrites.get(made.id)).toStrictEqual(first);
    });
    expect(eventsOf()).toEqual(["requested", "applied"]);
  });

  it("leaves alone a request that was not approved, and finds none under an unknown id",
      async () => {
    await harness.inDo(async settings => {
      expect(await settings.settleWorkspaceWrite(made.id, { outcome: "done" }))
          .toStrictEqual(made);
      await settings.denyWorkspaceWrite(made.id, actor(OTHER_ADMIN));
      const denied = harness.storageOf(settings).adminWrites.get(made.id);
      expect(await settings.settleWorkspaceWrite(made.id, { error: "failed" }))
          .toStrictEqual(denied);
      expect(await codeOf(settings.settleWorkspaceWrite(crypto.randomUUID(), {})))
          .toBe(requestNotFound);
    });
    expect(eventsOf()).toEqual(["requested", "denied"]);
  });

  it("stores the answer while another request's expiry cannot be recorded", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const request = await approveMade();
    const overdue = await requestWrite();
    await harness.inDo(async settings => {
      age(settings, overdue.id);
      harness.audit.fail = true;
      // No sweep comes first: one would stop at the overdue request, and throw.
      expect(await settings.settleWorkspaceWrite(made.id, { outcome: "done" })).toStrictEqual(
          { ...request, state: "applied", outcome: "done", unrecorded: true });
      expect(harness.storageOf(settings).adminWrites.get(overdue.id)?.state).toBe("pending");
    });
    expect(eventsOf()).toEqual(["requested"]);
  });

  it("owes the record of a write that failed too, while it cannot be written", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const request = await approveMade();
    const failed = { ...request, state: "failed", error: "No such chat." };
    await harness.inDo(async settings => {
      harness.audit.fail = true;
      expect(await settings.settleWorkspaceWrite(made.id, { error: "No such chat." }))
          .toStrictEqual({ ...failed, unrecorded: true });
      harness.audit.fail = false;
      await settings.alarm();
      expect(harness.storageOf(settings).adminWrites.get(made.id)).toStrictEqual(failed);
    });
    expect(recordsOf().slice(1)).toStrictEqual(
        [closingRecord("failed", { error: "No such chat." })]);
  });

  it("stores the answer though its record cannot be written, and records it once it can",
      async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const request = await approveMade();
    await harness.inDo(async (settings, state) => {
      const writes = harness.storageOf(settings).adminWrites;
      harness.audit.fail = true;
      const before = Date.now();
      const settled = await settings.settleWorkspaceWrite(made.id, { outcome: "done" });
      const owed = { ...request, state: "applied", outcome: "done", unrecorded: true };
      expect(settled).toStrictEqual(owed);
      expect(writes.get(made.id)).toStrictEqual(owed);
      expect(errorEvents(logged)).toEqual(["admin.audit.append.failed"]);
      // The alarm comes back for the record, no sooner than its retry delay.
      const alarm = await state.storage.getAlarm();
      expect(alarm).toBeGreaterThanOrEqual(before + 30_000);
      expect(alarm).toBeLessThanOrEqual(Date.now() + 30_000);

      // Until the record is written the request is kept, however long ago it was resolved, and
      // a sweep that cannot write it fails as one that cannot record an expiry does.
      const resolvedAt = new Date(Date.now() - DAY_MS - 1000);
      writes.put({ ...settled, resolvedAt });
      await settings.alarm();
      expect(writes.get(made.id)).toStrictEqual({ ...owed, resolvedAt });
      expect(errorEvents(logged)).toEqual(
          ["admin.audit.append.failed", "admin.write.sweep.failed"]);
      expect(await rejection(settings.getWorkspaceWrite(made.id)))
          .toStrictEqual(new Error("audit log unavailable"));
      // A second answer does not stand in for the record.
      expect(await settings.settleWorkspaceWrite(made.id, { error: "too late" }))
          .toStrictEqual({ ...owed, resolvedAt });
      expect(eventsOf()).toEqual(["requested"]);

      harness.audit.fail = false;
      await settings.alarm();
      expect(writes.get(made.id)).toStrictEqual(
          { ...request, state: "applied", outcome: "done", resolvedAt });
      expect(eventsOf()).toEqual(["requested", "applied"]);

      // Recorded, and resolved more than a day ago: the next pass forgets it, recording nothing.
      await settings.alarm();
      expect(writes.get(made.id)).toBeUndefined();
      expect(await state.storage.getAlarm()).toBeNull();
    });
    expect(recordsOf().slice(1)).toStrictEqual([closingRecord("applied", { outcome: "done" })]);
  });
});

describe("an approved request whose workspace never answers", () => {
  it("stays approved until ADMIN_WRITE_SETTLE_SECONDS have passed, then fails", async () => {
    expect(ADMIN_WRITE_SETTLE_SECONDS).toBe(900);
    const request = await approveMade();
    const due = request.resolvedAt!.getTime() + SETTLE_MS;
    await harness.inDo(async (settings, state) => {
      const writes = harness.storageOf(settings).adminWrites;
      const now = vi.spyOn(Date, "now");
      await settings.alarm();
      expect(await state.storage.getAlarm()).toBe(due);
      now.mockReturnValue(due - 1);
      await settings.alarm();
      expect((await settings.getWorkspaceWrite(made.id))).toStrictEqual(request);
      expect(eventsOf()).toEqual(["requested"]);

      now.mockReturnValue(due);
      await settings.alarm();
      const failed = { ...request, state: "failed", error: ANSWER_LOST };
      expect(writes.get(made.id)).toStrictEqual(failed);
      // Kept a day from when it was approved.
      expect(await state.storage.getAlarm()).toBe(request.resolvedAt!.getTime() + DAY_MS);

      // An answer arriving afterwards changes nothing: the request is never run or settled again.
      expect(await settings.settleWorkspaceWrite(made.id, { outcome: "done" }))
          .toStrictEqual(failed);
      expect(writes.get(made.id)).toStrictEqual(failed);
    });
    // Recorded in the approver's name, with the passkey that approved.
    expect(recordsOf().slice(1)).toStrictEqual([closingRecord("failed", { error: ANSWER_LOST })]);
  });

  it("is failed by whichever call sweeps first, and never forgotten while approved",
      async () => {
    const request = await approveMade();
    // Longer ago than a resolved request is kept.
    const resolvedAt = new Date(Date.now() - DAY_MS - 1000);
    const read = await harness.inDo(settings => {
      harness.storageOf(settings).adminWrites.put({ ...request, resolvedAt });
      return settings.getWorkspaceWrite(made.id);
    });
    expect(read).toStrictEqual({ ...request, resolvedAt, state: "failed", error: ANSWER_LOST });
    expect(eventsOf()).toEqual(["requested", "failed"]);
  });

  it("is stored as failed though that cannot be recorded, and recorded once it can", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const request = await approveMade();
    const resolvedAt = new Date(Date.now() - SETTLE_MS - 1000);
    await harness.inDo(async (settings, state) => {
      const writes = harness.storageOf(settings).adminWrites;
      writes.put({ ...request, resolvedAt });
      harness.audit.fail = true;
      const before = Date.now();
      await settings.alarm();
      const failed = { ...request, resolvedAt, state: "failed", error: ANSWER_LOST };
      expect(writes.get(made.id)).toStrictEqual({ ...failed, unrecorded: true });
      expect(errorEvents(logged)).toEqual(["admin.write.sweep.failed"]);
      expect(await state.storage.getAlarm()).toBeGreaterThanOrEqual(before + 30_000);
      expect(await state.storage.getAlarm()).toBeLessThanOrEqual(Date.now() + 30_000);

      harness.audit.fail = false;
      await settings.alarm();
      expect(writes.get(made.id)).toStrictEqual(failed);
      await settings.alarm();
    });
    expect(eventsOf()).toEqual(["requested", "failed"]);
  });
});

// AdminApiImpl asks the same of the session Worker's environment before it calls. This object's
// can be newer: a session outlives the config its Worker started with.
describe("the object's own environment", () => {
  it.each([
    ["an admin who is no longer one", { ADMINS: [OTHER_ADMIN] }, ADMIN_ACCESS_ERROR_CODES.notAdmin],
    ["every admin while writes are off", { ADMIN_WORKSPACE_WRITES: "off" },
     ADMIN_WRITE_ERROR_CODES.writesOff],
  ] as const)("lets %s begin and approve nothing, spending and recording nothing",
      async (_who, vars, code) => {
    const theirs = await requestWrite({ requestedBy: OTHER_ADMIN });
    // Answered while ADMIN could still approve.
    const assertion = await answer(passkeyA, ADMIN, theirs.id);
    const challenges = await storedChallenges();

    const begun = await harness.inDo(settings => rejection(
        settings.beginWorkspaceWriteApproval(theirs.id, ADMIN)), vars);
    expect(begun).toMatchObject({ code });
    const approved = await harness.inDo(settings => rejection(
        settings.approveWorkspaceWrite(theirs.id, assertion, actor(ADMIN))), vars);
    expect(approved).toMatchObject({ code });

    expect(eventsOf(theirs.id)).toEqual(["requested"]);
    expect(await stored(theirs.id)).toStrictEqual(theirs);
    expect(await storedChallenges()).toStrictEqual(challenges);
    expect((await storedPasskey(passkeyA))!.lastUsed).toBeUndefined();
  });
});
