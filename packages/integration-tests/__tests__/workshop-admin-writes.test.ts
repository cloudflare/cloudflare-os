import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  ADMIN_WRITE_ERROR_CODES, getAdminAccessErrorCode, getAdminWriteErrorCode,
  type ActionLogEntry, type ActionsSubscriber, type AdminAccessErrorCode, type AdminApi,
  type AdminPasskey, type AdminPasskeyChallenge, type AdminWriteAction, type AdminWriteArgs,
  type AdminWriteErrorCode, type AdminWriteRecord, type AdminWriteRequest, type AuthenticatedApi,
  type Overseer, type WorkpieceId,
} from "@gadgets/workshop-shared/api";
import {
  softwareAuthenticator, type Tamper,
} from "../../workshop-backend/__tests__/software-authenticator.js";
import type { TestSession } from "../fixtures/gatekeeper-test/src/test-gatekeeper.js";
import { loadAllChatHistory } from "../src/agent-session.js";
import {
  ADMIN_USERNAME, settleRestart, startHarness, TEST_GATEKEEPER_BINDING, TEST_GATEKEEPER_DIR,
  TEST_VENDOR_ID, testActionState, type Harness,
} from "../src/harness.js";
import { SCRIPTED_MODEL_ID, scriptedModelRouter } from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  accountLabel, connect, listConnectedAccounts, logIn, nextUsernames, RpcTarget, signUp,
  streamGeneration, stubFor, waitFor, waitForIdleChat,
} from "../src/rpc-client.js";

// A second deployment admin, whom the redeploy that ends this file removes from ADMINS.
const SECOND_ADMIN = "approver";
// The harness's PUBLIC_BASE_URL, and the relying party it gives: its host name.
const ORIGIN = "http://workshop.test";
const RP_ID = "workshop.test";
const REASON = "The owner asked support to clear this up";
const NO_SUCH_PASSKEY = "You have no such passkey.";
const { passkeyRefused, passkeyRequired, requestNotPending, workspaceUnlisted, writesOff } =
    ADMIN_WRITE_ERROR_CODES;
// A challenge no server issued, for an answer that only has to be well formed.
const UNISSUED: AdminPasskeyChallenge = {
  challenge: "AAAA", rpId: RP_ID, credentialIds: [], expiresAt: new Date(0),
};

type Authenticator = Awaited<ReturnType<typeof softwareAuthenticator>>;
type Loose = Record<string, (...args: unknown[]) => Promise<unknown>>;

// The switch is read at startup, passkeys and the audit log are deployment-wide and the last case
// redeploys, so this file owns its harness, runs serially, and its cases run in order: a passkey
// enrolled in one approves in the next.
const models = scriptedModelRouter();
const network = new NetworkInterceptor({ handlers: [models.handler] });
const fileScope = new DisposableStack();
let harness: Harness;
let admin: RpcStub<AdminApi>;
let second: RpcStub<AdminApi>;
let adminKey: Authenticator;
let secondKey: Authenticator;
// The second admin's request to delete a chat, made before they have a passkey and approved once
// they do.
let carried: AdminWriteRequest;
let carriedWs: RpcStub<Overseer>;
let carriedChatId: number;

async function adminApiOf(username: string): Promise<RpcStub<AdminApi>> {
  const api = fileScope.use(await signUp(fileScope.use(connect(harness.url)), username));
  const stub = await api.getAdminApi();
  if (stub === null) throw new Error(`The admin API was unavailable to ${username}`);
  return fileScope.use(stub);
}

beforeAll(async () => {
  network.install();
  harness = await startHarness({
    // The test connection, for the write that rejects a queue of actions.
    gatekeepers: [{ binding: TEST_GATEKEEPER_BINDING, dir: TEST_GATEKEEPER_DIR }],
    patchWorkshop: config => {
      config.vars = {
        ...config.vars, ADMINS: [ADMIN_USERNAME, SECOND_ADMIN], ADMIN_WORKSPACE_WRITES: "on",
      };
    },
  });
  admin = await adminApiOf(ADMIN_USERNAME);
  second = await adminApiOf(SECOND_ADMIN);
});

afterAll(async () => {
  try {
    fileScope.dispose();
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

/** The code `call` is refused with, of either admin family; throws if it succeeds. */
async function codeOf(call: PromiseLike<unknown>)
    : Promise<AdminWriteErrorCode | AdminAccessErrorCode | undefined> {
  try {
    await call;
  } catch (error) {
    return getAdminWriteErrorCode(error) ?? getAdminAccessErrorCode(error);
  }
  throw new Error("The call was not refused");
}

/** Enrols `authenticator`'s passkey for `api`'s admin, falsifying `tamper` in its answer. */
async function enrol(api: RpcStub<AdminApi>, authenticator: Authenticator, name: string,
                     tamper?: Tamper): Promise<AdminPasskey> {
  const challenge = await api.beginAdminPasskeyEnrolment();
  return await api.addAdminPasskey(name, await authenticator.register(challenge, tamper));
}

/**
 * One approval ceremony for `requestId` by `api`'s admin, answered by `authenticator`: resolves
 * the request as the approval left it. `tamper` falsifies part of the answer, and may be derived
 * from the challenge.
 */
async function approve(api: RpcStub<AdminApi>, authenticator: Authenticator, requestId: string,
                       tamper?: Tamper | ((challenge: AdminPasskeyChallenge) => Tamper))
    : Promise<AdminWriteRequest> {
  const challenge = await api.beginWorkspaceWriteApproval(requestId);
  const falsified = typeof tamper === "function" ? tamper(challenge) : tamper;
  return await api.approveWorkspaceWrite(
      requestId, await authenticator.assert(challenge, falsified));
}

/** Every record the deployment-wide audit log holds of the request, oldest first. */
async function writeRecords(requestId: string): Promise<AdminWriteRecord[]> {
  const found: AdminWriteRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await admin.listAdminAudit({ kind: "write", limit: 200, cursor });
    for (const record of page.records) {
      if (record.kind === "write" && record.requestId === requestId) found.push(record);
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return found.toReversed();
}

/** The steps the audit log holds of the request, oldest first. */
async function stepsOf(requestId: string): Promise<AdminWriteRecord["event"][]> {
  return (await writeRecords(requestId)).map(record => record.event);
}

/** Every enrolled passkey with the admin it belongs to, as `api` lists them. */
async function passkeyOwners(api: RpcStub<AdminApi>) {
  return (await api.listAdminPasskeys())
      .map(passkey => ({ id: passkey.id, admin: passkey.admin }));
}

/** The setting records of passkey removals, newest first. */
async function removals(api: RpcStub<AdminApi> = admin) {
  return (await api.listAdminAudit({ kind: "setting", method: "removeAdminPasskey" })).records;
}

/** `challenge` with one bit of its second half flipped: the digest of what the answer confirms. */
function withAlteredDigest(challenge: string): string {
  const bytes = Buffer.from(challenge, "base64url");
  bytes[bytes.length - 1]! ^= 1;
  return bytes.toString("base64url");
}

type Seeded = {
  owner: RpcStub<AuthenticatedApi>;
  ownerName: string;
  ws: RpcStub<Overseer>;
  id: string;
  title: string;
};

/**
 * A fresh owner's workspace, titled, once the deployment directory lists it under that title: a
 * write can be requested only for a workspace the directory lists, and the request keeps the title
 * and owner listed then.
 */
async function listedWorkspace(stack: DisposableStack, prefix: string): Promise<Seeded> {
  const [ownerName] = nextUsernames(prefix);
  const owner = stack.use(await signUp(stack.use(connect(harness.url)), ownerName!));
  const ws = stack.use(await owner.newWorkspace());
  const title = `Workspace of ${ownerName}`;
  await ws.setTitle(title);
  const id = (await ws.getMetadata()).id;
  await waitFor(`${title} to be listed`, async () =>
    (await admin.listWorkspaces({ owner: ownerName })).workspaces
        .some(workspace => workspace.id === id && workspace.title === title) || null);
  return { owner, ownerName: ownerName!, ws, id, title };
}

/** The entries of a workspace's action log that are an admin's writes, newest first. */
async function adminEntries(ws: RpcStub<Overseer>) {
  return (await ws.listActions()).entries
      .flatMap(entry => entry.type === "action" && entry.byAdmin ? [entry] : []);
}

/**
 * What a workspace's action log shows of an approved write: that `approver`, a deployment admin,
 * did it, what it is (`title`), and the request's reason, word for word.
 */
function entryOf(request: AdminWriteRequest, title: string,
                 { approver = ADMIN_USERNAME }: { approver?: string } = {}) {
  return expect.objectContaining({
    type: "action", byAdmin: true, state: "approved", resourceTitle: "Deployment admin",
    resolvedBy: expect.objectContaining({ id: approver }),
    description: expect.objectContaining({
      title,
      fields: [
        { label: "Reason", kind: "text", value: request.reason },
        { label: "Request", kind: "inline", value: request.id },
      ],
    }),
  });
}

class ActionsRecorder extends RpcTarget implements ActionsSubscriber {
  readonly entries: ActionLogEntry[] = [];
  entry(record: ActionLogEntry): void { this.entries.push(record); }
  ready(): void {}
}

it("refuses the write and passkey methods to a non-admin, whose capabilities run no write",
    async () => {
  using stack = new DisposableStack();
  const { owner, ownerName, ws, id } = await listedWorkspace(stack, "writesnonadmin");
  const chatId = await ws.newChat("hello", null);
  expect(await owner.getAdminApi()).toBeNull();

  const stray = await softwareAuthenticator({ origin: ORIGIN });
  const registration = await stray.register(UNISSUED);
  const assertion = await stray.assert(UNISSUED);
  const noRequest = crypto.randomUUID();
  // None of these is on AuthenticatedApi: they are reachable only through an AdminApi.
  const loose = owner as unknown as Loose;
  const calls: [string, unknown[]][] = [
    ["requestWorkspaceWrite", [id, "deleteChat", { chatId }, REASON]],
    ["getWorkspaceWrite", [noRequest]],
    ["denyWorkspaceWrite", [noRequest]],
    ["beginWorkspaceWriteApproval", [noRequest]],
    ["approveWorkspaceWrite", [noRequest, assertion]],
    ["listAdminPasskeys", []],
    ["beginAdminPasskeyEnrolment", []],
    ["addAdminPasskey", ["Stray", registration]],
    ["beginAdminPasskeyRemoval", [stray.credentialId]],
    ["removeAdminPasskey", [stray.credentialId, assertion]],
  ];
  for (const [method, args] of calls) {
    await expect(loose[method]!(...args), method).rejects.toThrow();
  }

  // The bypass is on the Overseer's Durable Object, never on a capability a user holds. The grant
  // is one the workspace would run if the method were reachable.
  const looseWs = ws as unknown as Loose;
  await expect(looseWs.applyAdminWrite!({
    requestId: crypto.randomUUID(), action: "deleteChat", args: { chatId }, reason: REASON,
    requestedBy: ADMIN_USERNAME, expiresAt: new Date(Date.now() + 60_000),
    workspaceOwner: ownerName, admin: ADMIN_USERNAME, sessionId: "session", via: "api",
    passkey: "passkey",
  })).rejects.toThrow();

  expect((await ws.listChats()).map(chat => chat.id)).toContain(chatId);
  expect(await adminEntries(ws)).toEqual([]);
  expect((await admin.listAdminAudit({ kind: "write", workspace: id })).records).toEqual([]);
});

it("enrols a passkey, recorded without its key, and refuses a registration that fails a check",
    async () => {
  adminKey = await softwareAuthenticator({ origin: ORIGIN });
  const challenge = await admin.beginAdminPasskeyEnrolment();
  expect(challenge).toEqual({
    challenge: expect.any(String), rpId: RP_ID, credentialIds: [], expiresAt: expect.any(Date),
  });
  const registration = await adminKey.register(challenge);

  // Neither the listing nor the record holds the public key.
  const listed = {
    id: adminKey.credentialId, admin: ADMIN_USERNAME, name: "Laptop", created: expect.any(Date),
  };
  expect(await admin.addAdminPasskey("Laptop", registration)).toEqual(listed);
  expect(await admin.listAdminPasskeys()).toEqual([listed]);
  const enrolments = async () =>
    (await admin.listAdminAudit({ kind: "setting", method: "addAdminPasskey" })).records;
  expect(await enrolments()).toEqual([{
    kind: "setting", at: expect.any(Date), admin: ADMIN_USERNAME,
    sessionId: expect.any(String), via: "api", method: "addAdminPasskey",
    changes: [{
      setting: "adminPasskeys", key: adminKey.credentialId,
      after: JSON.stringify({ admin: ADMIN_USERNAME, algorithm: -7, name: "Laptop" }),
    }],
  }]);

  // Each answered by an authenticator of its own, so that what is refused is the check and not a
  // credential already enrolled.
  const falsified: Tamper[] = [{ userVerified: false }, { origin: "http://elsewhere.test" }];
  for (const tamper of falsified) {
    const stray = await softwareAuthenticator({ origin: ORIGIN });
    expect(await codeOf(enrol(admin, stray, "Stray", tamper)), JSON.stringify(tamper))
        .toBe(passkeyRefused);
  }
  // The accepted registration, sent again: its challenge is spent.
  expect(await codeOf(admin.addAdminPasskey("Laptop again", registration))).toBe(passkeyRefused);
  expect(await admin.listAdminPasskeys()).toEqual([listed]);
  expect(await enrolments()).toHaveLength(1);
});

it("lets an admin with no passkey approve nothing, and remove nobody's passkey", async () => {
  const { ws, id } = await listedWorkspace(fileScope, "writescarried");
  carriedWs = ws;
  carriedChatId = await ws.newChat("hello", null);
  carried = await second.requestWorkspaceWrite(id, "deleteChat", { chatId: carriedChatId }, REASON);
  expect(await codeOf(second.beginWorkspaceWriteApproval(carried.id))).toBe(passkeyRequired);

  await expect(second.beginAdminPasskeyRemoval(adminKey.credentialId))
      .rejects.toThrow(NO_SUCH_PASSKEY);
  // A good answer to the removal challenge the passkey's own admin was given, and an answer to no
  // challenge at all: neither removes it for another admin.
  const own = await adminKey.assert(await admin.beginAdminPasskeyRemoval(adminKey.credentialId));
  for (const assertion of [own, await adminKey.assert(UNISSUED)]) {
    await expect(second.removeAdminPasskey(adminKey.credentialId, assertion))
        .rejects.toThrow(NO_SUCH_PASSKEY);
  }

  expect((await second.getWorkspaceWrite(carried.id)).state).toBe("pending");
  expect(await stepsOf(carried.id)).toEqual(["requested"]);
  expect((await admin.listAdminPasskeys()).map(passkey => passkey.id))
      .toEqual([adminKey.credentialId]);
  expect(await removals()).toEqual([]);
});

it("approves nothing with another admin's passkey", async () => {
  secondKey = await softwareAuthenticator({ origin: ORIGIN });
  await enrol(second, secondKey, "Phone");

  // The challenge is the second admin's and outstanding, and the answer verifies under the first
  // admin's key: only the passkey's owner is wrong.
  const challenge = await second.beginWorkspaceWriteApproval(carried.id);
  expect(challenge.credentialIds).toEqual([secondKey.credentialId]);
  expect(await codeOf(second.approveWorkspaceWrite(carried.id, await adminKey.assert(challenge))))
      .toBe(passkeyRefused);
  expect((await second.getWorkspaceWrite(carried.id)).state).toBe("pending");
  expect((await carriedWs.listChats()).map(chat => chat.id)).toContain(carriedChatId);
  const refused = (await writeRecords(carried.id)).at(-1)!;
  expect(refused).toMatchObject({
    event: "refused", admin: SECOND_ADMIN, requestedBy: SECOND_ADMIN, refusal: "credential",
  });
  // The credential the answer named is not the second admin's.
  expect(refused.passkey).toBeUndefined();

  expect((await approve(second, secondKey, carried.id)).state).toBe("applied");
  expect((await carriedWs.listChats()).map(chat => chat.id)).not.toContain(carriedChatId);
  const records = await writeRecords(carried.id);
  expect(records.map(record => record.event))
      .toEqual(["requested", "refused", "approved", "applied"]);
  for (const record of records.slice(2)) {
    expect(record).toMatchObject({ admin: SECOND_ADMIN, passkey: secondKey.credentialId });
  }
  expect(await adminEntries(carriedWs))
      .toEqual([entryOf(carried, `Delete chat ${carriedChatId}`, { approver: SECOND_ADMIN })]);
});

it("runs an approved write, recorded step by step and entered in the workspace's action log",
    async () => {
  using stack = new DisposableStack();
  const { ws, id, title, ownerName } = await listedWorkspace(stack, "writesowner");
  const chatId = await ws.newChat("hello", null);
  // Subscribed before the write, as a member who has the workspace open is.
  const seen = new ActionsRecorder();
  stack.use(await ws.subscribeToActions(stack.use(stubFor(seen))));

  const request = await admin.requestWorkspaceWrite(id, "deleteChat", { chatId }, REASON);
  expect(request).toEqual({
    id: expect.any(String), workspaceId: id, workspaceTitle: title, workspaceOwner: ownerName,
    action: "deleteChat", args: { chatId }, reason: REASON, requestedBy: ADMIN_USERNAME,
    via: "api", requestedAt: expect.any(Date), expiresAt: expect.any(Date),
    approvalUrl: `${ORIGIN}/admin/approve/${request.id}`, state: "pending",
  });
  // Requesting changes nothing.
  expect((await ws.listChats()).map(chat => chat.id)).toContain(chatId);
  expect(await adminEntries(ws)).toEqual([]);

  expect(await approve(admin, adminKey, request.id)).toMatchObject({
    id: request.id, state: "applied", resolvedBy: ADMIN_USERNAME, resolvedAt: expect.any(Date),
  });
  expect((await ws.listChats()).map(chat => chat.id)).not.toContain(chatId);

  const records = await writeRecords(request.id);
  expect(records.map(record => record.event)).toEqual(["requested", "approved", "applied"]);
  // The second is the workspace's own, with the title and owner it gives itself.
  for (const record of records) {
    expect(record, record.event).toMatchObject({
      kind: "write", requestId: request.id, workspaceId: id, workspaceOwner: ownerName,
      workspaceTitle: title, method: "deleteChat", args: { chatId }, reason: REASON,
      requestedBy: ADMIN_USERNAME, admin: ADMIN_USERNAME, via: "api",
    });
  }
  // The passkey that approved, named as the record of its enrolment keys it.
  const enrolment = (await admin.listAdminAudit(
      { kind: "setting", method: "addAdminPasskey", admin: ADMIN_USERNAME })).records[0];
  const passkey = enrolment?.kind === "setting" ? enrolment.changes[0]?.key : undefined;
  expect(passkey).toBe(adminKey.credentialId);
  expect(records.map(record => record.passkey)).toEqual([undefined, passkey, passkey]);

  // What the workspace's members see: that an admin did it, and why.
  const shown = entryOf(request, `Delete chat ${chatId}`);
  const entries = await adminEntries(ws);
  expect(entries).toEqual([shown]);
  expect(entries[0]!.gatekeeperId).toBeUndefined();
  await waitFor("the subscriber to be shown the write", async () => seen.entries.length || null);
  expect(seen.entries).toEqual([shown]);
});

/** Runs `fn` while the deployment-wide audit log can be read and takes no record. */
async function withAuditLogFaulted<T>(fn: () => Promise<T>): Promise<T> {
  // Addresses the deployment-wide log, which is always getByName("").
  const storage = await harness.server.getWorker("workshop-backend")
      .getDurableObjectStorage("AdminAuditDurableObject", { name: "" });
  try {
    await storage.exec(`CREATE TRIGGER admin_audit_unavailable BEFORE INSERT ON admin_audit
        BEGIN SELECT RAISE(ABORT, 'admin audit unavailable'); END`);
    return await fn();
  } finally {
    await storage.exec("DROP TRIGGER IF EXISTS admin_audit_unavailable");
  }
}

it("changes nothing when the write's record cannot be written", async () => {
  using stack = new DisposableStack();
  const { ws, id } = await listedWorkspace(stack, "writesunaudited");
  const chatId = await ws.newChat("hello", null);
  // Made before the log is faulted: a request whose own record cannot be written is refused.
  const request = await admin.requestWorkspaceWrite(id, "deleteChat", { chatId }, REASON);

  const failed = await withAuditLogFaulted(async () => {
    const answered = await approve(admin, adminKey, request.id);
    // The workspace records before it changes anything, so it changed nothing. The closing
    // record is owed for as long as the log takes none.
    expect((await ws.listChats()).map(chat => chat.id)).toContain(chatId);
    expect(await adminEntries(ws)).toEqual([]);
    expect(await stepsOf(request.id)).toEqual(["requested"]);
    return answered;
  });
  expect(failed).toMatchObject({ state: "failed", error: expect.any(String) });

  // Written once the log works again: by this read, or by the alarm that retries it.
  expect((await admin.getWorkspaceWrite(request.id)).state).toBe("failed");
  const records = await writeRecords(request.id);
  expect(records.map(record => record.event)).toEqual(["requested", "failed"]);
  expect(records[1]).toMatchObject({
    admin: ADMIN_USERNAME, passkey: adminKey.credentialId, error: failed.error,
  });
  // The approval spent the request all the same: it leaves "pending" once.
  expect(await codeOf(admin.beginWorkspaceWriteApproval(request.id))).toBe(requestNotPending);
  expect((await ws.listChats()).map(chat => chat.id)).toContain(chatId);
});

it("refuses a replayed and a falsified approval, recording each", async () => {
  using stack = new DisposableStack();
  const { ws, id } = await listedWorkspace(stack, "writesreplay");
  const firstChat = await ws.newChat("first", null);
  const otherChat = await ws.newChat("other", null);
  const first = await admin.requestWorkspaceWrite(id, "deleteChat", { chatId: firstChat }, REASON);
  const other = await admin.requestWorkspaceWrite(id, "deleteChat", { chatId: otherChat }, REASON);
  const chatIds = async () => (await ws.listChats()).map(chat => chat.id);
  const refusedFor = (refusal: AdminWriteRecord["refusal"]) => ({
    event: "refused", admin: ADMIN_USERNAME, refusal, passkey: adminKey.credentialId,
  });

  const assertion = await adminKey.assert(await admin.beginWorkspaceWriteApproval(first.id));
  expect((await admin.approveWorkspaceWrite(first.id, assertion)).state).toBe("applied");
  expect(await chatIds()).not.toContain(firstChat);

  // The answer that approved one request, sent for another whose own challenge is outstanding.
  await admin.beginWorkspaceWriteApproval(other.id);
  expect(await codeOf(admin.approveWorkspaceWrite(other.id, assertion))).toBe(passkeyRefused);
  expect((await writeRecords(other.id)).at(-1)).toMatchObject(refusedFor("challenge"));

  // And sent again for the request it approved, which is run once.
  expect(await codeOf(admin.approveWorkspaceWrite(first.id, assertion))).toBe(requestNotPending);
  const replayed = await writeRecords(first.id);
  expect(replayed.map(record => record.event))
      .toEqual(["requested", "approved", "applied", "refused"]);
  expect(replayed.at(-1)).toMatchObject(refusedFor("challenge"));
  expect(await adminEntries(ws)).toHaveLength(1);

  // Each signed over what it falsifies, so the signature holds and the named check refuses it.
  const falsified: [AdminWriteRecord["refusal"], Parameters<typeof approve>[3]][] = [
    ["challenge", challenge => ({ challenge: withAlteredDigest(challenge.challenge) })],
    ["origin", { origin: "http://elsewhere.test" }],
    ["userVerification", { userVerified: false }],
  ];
  const steps: AdminWriteRecord["event"][] = ["requested", "refused"];
  for (const [refusal, tamper] of falsified) {
    expect(await codeOf(approve(admin, adminKey, other.id, tamper)), refusal)
        .toBe(passkeyRefused);
    steps.push("refused");
    const records = await writeRecords(other.id);
    expect(records.map(record => record.event), refusal).toEqual(steps);
    expect(records.at(-1), refusal).toMatchObject(refusedFor(refusal));
    expect((await admin.getWorkspaceWrite(other.id)).state, refusal).toBe("pending");
    expect(await chatIds(), refusal).toContain(otherChat);
    expect(await adminEntries(ws), refusal).toHaveLength(1);
  }

  expect((await approve(admin, adminKey, other.id)).state).toBe("applied");
  expect(await chatIds()).not.toContain(otherChat);
  expect(await stepsOf(other.id)).toEqual([...steps, "approved", "applied"]);
  expect(await adminEntries(ws)).toHaveLength(2);
});

it("records a denial, and an approval of what was denied", async () => {
  using stack = new DisposableStack();
  const { ws, id } = await listedWorkspace(stack, "writesdenied");
  const chatId = await ws.newChat("hello", null);
  const request = await admin.requestWorkspaceWrite(id, "deleteChat", { chatId }, REASON);

  // Any admin denies a request, with no ceremony.
  await second.denyWorkspaceWrite(request.id);
  expect(await admin.getWorkspaceWrite(request.id))
      .toMatchObject({ state: "denied", resolvedBy: SECOND_ADMIN });
  const denied = await writeRecords(request.id);
  expect(denied.map(record => record.event)).toEqual(["requested", "denied"]);
  expect(denied[1]).toMatchObject({ admin: SECOND_ADMIN, requestedBy: ADMIN_USERNAME });
  expect(await codeOf(second.denyWorkspaceWrite(request.id))).toBe(requestNotPending);

  // Beginning answers nothing, so it records nothing. An answer is an attempt, and is recorded.
  expect(await codeOf(admin.beginWorkspaceWriteApproval(request.id))).toBe(requestNotPending);
  expect(await stepsOf(request.id)).toEqual(["requested", "denied"]);
  expect(await codeOf(admin.approveWorkspaceWrite(request.id, await adminKey.assert(UNISSUED))))
      .toBe(requestNotPending);
  const records = await writeRecords(request.id);
  expect(records.map(record => record.event)).toEqual(["requested", "denied", "refused"]);
  expect(records[2]).toMatchObject({
    admin: ADMIN_USERNAME, refusal: "challenge", passkey: adminKey.credentialId,
  });
  expect((await ws.listChats()).map(chat => chat.id)).toContain(chatId);
  expect(await adminEntries(ws)).toEqual([]);

  // Expiry is the one ending this suite does not reach: it cannot age a stored request, and it
  // does not wait out the ten minutes one stays pending. The backend's unit suites
  // admin-write-requests.test.ts and admin-write-approval.test.ts cover it.
});

it("removes a passkey only for its own admin, confirmed with a passkey of theirs", async () => {
  const listedIds = async () => (await admin.listAdminPasskeys()).map(passkey => passkey.id);
  const both = [adminKey.credentialId, secondKey.credentialId];

  // The first admin holds a passkey and still removes nobody else's, not even with a good answer
  // by it to a removal challenge of their own.
  await expect(admin.beginAdminPasskeyRemoval(secondKey.credentialId))
      .rejects.toThrow(NO_SUCH_PASSKEY);
  const own = await adminKey.assert(await admin.beginAdminPasskeyRemoval(adminKey.credentialId));
  await expect(admin.removeAdminPasskey(secondKey.credentialId, own))
      .rejects.toThrow(NO_SUCH_PASSKEY);
  expect(await listedIds()).toEqual(both);
  expect(await removals()).toEqual([]);

  // The second admin's own challenge, answered by the first admin's passkey.
  const borrowed = await adminKey.assert(
      await second.beginAdminPasskeyRemoval(secondKey.credentialId));
  expect(await codeOf(second.removeAdminPasskey(secondKey.credentialId, borrowed)))
      .toBe(passkeyRefused);
  expect(await listedIds()).toEqual(both);
  expect(await removals()).toEqual([]);

  const assertion = await secondKey.assert(
      await second.beginAdminPasskeyRemoval(secondKey.credentialId));
  await second.removeAdminPasskey(secondKey.credentialId, assertion);
  expect(await listedIds()).toEqual([adminKey.credentialId]);
  expect(await removals()).toEqual([{
    kind: "setting", at: expect.any(Date), admin: SECOND_ADMIN, sessionId: expect.any(String),
    via: "api", method: "removeAdminPasskey",
    changes: [{
      setting: "adminPasskeys", key: secondKey.credentialId,
      before: JSON.stringify({ admin: SECOND_ADMIN, algorithm: -7, name: "Phone" }),
    }],
  }]);

  // The accepted answer, sent again: the passkey it removed is nobody's.
  await expect(second.removeAdminPasskey(secondKey.credentialId, assertion))
      .rejects.toThrow(NO_SUCH_PASSKEY);
  expect(await removals()).toHaveLength(1);
});

/**
 * Requests a write to workspace `id` and approves it, both as the first admin, and expects the
 * workspace to have run it. Resolves the request as the approval left it, and what the workspace's
 * action log shows of it (see entryOf()).
 */
async function runWrite(id: string, action: AdminWriteAction, args: AdminWriteArgs,
                        title: string) {
  const request = await admin.requestWorkspaceWrite(id, action, args, REASON);
  const settled = await approve(admin, adminKey, request.id);
  expect(settled, action).toMatchObject({ state: "applied" });
  return { settled, entry: entryOf(request, title) };
}

it("restarts a workspace, ending its sessions, with its entry in the action log", async () => {
  using stack = new DisposableStack();
  const { ws, id, ownerName } = await listedWorkspace(stack, "writesrestart");

  // A restart ends the owner's whole RPC session, so the entry is read on another.
  let broken = false;
  ws.onRpcBroken(() => { broken = true; });
  const generation = await streamGeneration(ws);
  const { entry } = await runWrite(id, "restartWorkspace", {}, "Restart the workspace");
  await waitFor("the owner's session to end", async () => broken || null);
  await expect(ws.listChats()).rejects.toThrow();
  const session = stack.use(await stack.use(
      await logIn(stack.use(connect(harness.url)), ownerName)).openWorkspace(id));
  expect(await streamGeneration(session)).not.toBe(generation);
  expect(await adminEntries(session)).toEqual([entry]);
});

it("runs the writes that need a connection or a model", async () => {
  using stack = new DisposableStack();
  const model = models.script([{ pending: true }]);
  const { owner, ownerName, ws, id } = await listedWorkspace(stack, "writesconnected");
  await owner.addModel(model.userModel.profile, model.userModel.config);
  await owner.provisionAmbientAccount(TEST_VENDOR_ID);
  const account = (await listConnectedAccounts(owner))
      .find(candidate => candidate.vendorId === TEST_VENDOR_ID);
  if (account === undefined) throw new Error("The test account was not provisioned");
  const label = accountLabel(account);
  const connection = await ws.newGatekeeper(
      account.id, `https://gadgets-test.example/things/${ownerName}`);
  if (connection === null) throw new Error("The test connection was not created");
  stack.use(connection);
  const connectionId: WorkpieceId = await connection.getId();
  const values = stack.use(await connection.openSession() as RpcStub<TestSession>);
  const shown: unknown[] = [];

  // A stuck queue: two writes held for a decision nobody makes.
  await values.writeValues([7, 8]);
  const pending = async () => (await ws.listActions({ filter: "pending" })).entries;
  await waitFor("both writes to be pending", async () => (await pending()).length === 2 || null);
  expect((await testActionState(harness, label)).pending).toHaveLength(2);
  const rejection = await runWrite(id, "rejectPendingActions", { gatekeeperId: connectionId },
      `Reject the pending actions of connection ${connectionId}`);
  shown.unshift(rejection.entry);
  expect(rejection.settled.outcome).toBe("Rejected 2 pending actions; 0 remain.");
  expect(await pending()).toEqual([]);
  // Each rejected in the admin's name, and reported to the connection's gatekeeper, which drops
  // what it held for them.
  const queued = (await ws.listActions()).entries
      .filter(entry => entry.type === "action" && entry.gatekeeperId === connectionId);
  expect(queued).toEqual([1, 2].map(() => expect.objectContaining({
    state: "rejected", resolvedBy: expect.objectContaining({ id: ADMIN_USERNAME }),
  })));
  expect(await testActionState(harness, label)).toMatchObject({ pending: [], applyCount: 0 });
  expect(await adminEntries(ws)).toEqual(shown);

  // A turn whose model never answers, stopped: the chat goes idle, its turn ended as stopped. A
  // message the owner sent meanwhile, which the agent never read, stays in the chat as theirs: no
  // client stopped the turn to put it back in a draft.
  const stuck = await ws.newChat("Never answered", SCRIPTED_MODEL_ID);
  const stuckChat = async () => (await ws.listChats()).find(chat => chat.id === stuck);
  await waitFor("the unanswered model request", async () => model.requests.length === 1 || null);
  expect((await stuckChat())?.activeAgent).toBeDefined();
  await ws.sendChatMessage(stuck, "Also add a streak counter.", SCRIPTED_MODEL_ID);
  await waitFor("the queued message", async () =>
    (await stuckChat())?.queuedSteers?.length === 1 || null);
  shown.unshift((await runWrite(id, "stopAgent", { chatId: stuck },
      `Stop the agent in chat ${stuck}`)).entry);
  await waitForIdleChat(ws, stuck);
  const stopped = await loadAllChatHistory(before => ws.getChatHistory(stuck, before));
  expect(stopped.at(-1)).toMatchObject({ type: "error", code: "stopped" });
  expect(stopped).toContainEqual(expect.objectContaining({
    type: "message", message: "Also add a streak counter.", steered: true,
    author: expect.objectContaining({ type: "user" }),
  }));
  expect((await stuckChat())?.queuedSteers).toBeUndefined();
  expect(await adminEntries(ws)).toEqual(shown);
});

it("makes no request of an action that is not one of ADMIN_WRITE_ACTIONS", async () => {
  using stack = new DisposableStack();
  const { ws, id } = await listedWorkspace(stack, "writesunlisted");
  // The server's validator throws, and capnweb delivers the throw as a rejection that keeps its
  // TypeError.
  await expect(admin.requestWorkspaceWrite(id, "deleteWorkspace" as never, {}, REASON))
      .rejects.toThrow(TypeError);
  expect((await admin.listAdminAudit({ kind: "write", workspace: id })).records).toEqual([]);
  expect((await ws.getMetadata()).id).toBe(id);
});

it("refuses a workspace that is gone, and fails a write to one deleted after its request",
    async () => {
  using stack = new DisposableStack();
  const gone = await listedWorkspace(stack, "writesgone");
  await gone.ws.deleteSelf();
  await settleRestart();
  // Deleting it took it out of the directory, which is all a request reads of a workspace.
  expect(await codeOf(admin.requestWorkspaceWrite(gone.id, "restartWorkspace", {}, REASON)))
      .toBe(workspaceUnlisted);
  expect((await admin.listAdminAudit({ kind: "write", workspace: gone.id })).records).toEqual([]);

  const { ws, id } = await listedWorkspace(stack, "writesdeleted");
  const request = await admin.requestWorkspaceWrite(id, "restartWorkspace", {}, REASON);
  await ws.deleteSelf();
  await settleRestart();
  // The Overseer keeps its records in typed storage over the KV API, whose table _cf_KV an
  // object's first write creates and deleteAll() drops, so the table is there only if something
  // was written since the deletion. Miniflare's own tables, which any visit creates, are left
  // out, and _cf_KV itself cannot be read, hence sqlite_master.
  const tables = async () => {
    const storage = await harness.server.getWorker("workshop-backend")
        .getDurableObjectStorage("OverseerDurableObject", { id });
    const rows = await storage.exec<{ name: string }>(`SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT GLOB '__miniflare*' ORDER BY name`);
    return rows.map(row => row.name);
  };
  const before = await tables();
  expect(before).not.toContain("_cf_KV");

  // Approved, and refused by a workspace that is no longer there: nothing was recorded
  // "approved", and the id was not brought back to life.
  expect(await approve(admin, adminKey, request.id))
      .toMatchObject({ state: "failed", error: "Workspace not found." });
  expect(await stepsOf(request.id)).toEqual(["requested", "failed"]);
  expect(await tables()).toEqual(before);
});

it("keeps passkeys through writes being turned off, and a former admin's, which do nothing",
    async () => {
  await enrol(second, secondKey, "Phone");
  const firstAdmins = { id: adminKey.credentialId, admin: ADMIN_USERNAME };
  const formerAdmins = { id: secondKey.credentialId, admin: SECOND_ADMIN };
  expect(await passkeyOwners(admin)).toEqual([firstAdmins, formerAdmins]);

  // The second admin is one no longer, and ADMIN_WORKSPACE_WRITES is left unset.
  await harness.redeployWorkshop(config => {
    config.vars = { ...config.vars, ADMINS: [ADMIN_USERNAME] };
  });

  // The redeploy restarts every Worker, ending every session open at the time.
  using stack = new DisposableStack();
  const logInAfresh = (username: string) => waitFor(`${username} to log in again`, async () => {
    try {
      return stack.use(await logIn(stack.use(connect(harness.url)), username));
    } catch {
      return null;
    }
  });
  // With no admin API, no approval or removal method is within the former admin's reach.
  expect(await (await logInAfresh(SECOND_ADMIN)).getAdminApi()).toBeNull();
  const fresh = await (await logInAfresh(ADMIN_USERNAME)).getAdminApi();
  if (fresh === null) throw new Error("The admin API was unavailable after the redeploy");
  stack.use(fresh);

  expect((await fresh.getSettings()).adminWorkspaceWrites).toBe(false);
  expect(await codeOf(
      fresh.requestWorkspaceWrite(carried.workspaceId, "restartWorkspace", {}, REASON)))
      .toBe(writesOff);
  expect(await codeOf(fresh.beginAdminPasskeyEnrolment())).toBe(writesOff);

  // Both passkeys are still stored. The former admin's is nobody else's to remove.
  expect(await passkeyOwners(fresh)).toEqual([firstAdmins, formerAdmins]);
  await expect(fresh.beginAdminPasskeyRemoval(secondKey.credentialId))
      .rejects.toThrow(NO_SUCH_PASSKEY);

  // An admin still removes their own while writes are off.
  const assertion = await adminKey.assert(
      await fresh.beginAdminPasskeyRemoval(adminKey.credentialId));
  await fresh.removeAdminPasskey(adminKey.credentialId, assertion);
  expect(await passkeyOwners(fresh)).toEqual([formerAdmins]);
  expect((await removals(fresh))[0]).toMatchObject({
    kind: "setting", admin: ADMIN_USERNAME, method: "removeAdminPasskey",
    changes: [{ setting: "adminPasskeys", key: adminKey.credentialId }],
  });
});
