import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  ADMIN_ACCESS_ERROR_CODES, ADMIN_GRANT_ACCOUNT_CACHE_SECONDS, ADMIN_GRANT_ERROR_CODES,
  ADMIN_GRANT_LIFETIME_SECONDS, ADMIN_WRITE_ERROR_CODES, getAdminAccessErrorCode,
  getAdminGrantErrorCode, getAdminWriteErrorCode, MAX_ADMIN_AUDIT_ARG_LENGTH,
  MAX_ADMIN_GRANTS_LISTED,
  type ActionLogEntry, type ActionsSubscriber, type AdminAccessGrant, type AdminAccessRecord,
  type AdminApi, type AdminAuditQuery, type AdminAuditRecord, type AdminPasskeyChallenge,
  type AdminWorkspaceView, type AdminWriteRecord, type AdminWriteRequest, type AuthenticatedApi,
  type NotificationSubscriber, type Overseer, type UserNotification, type WorkpieceId,
} from "@gadgets/workshop-shared/api";
import { diffFiles } from "@gadgets/workshop-shared/code-change";
import { MAX_BUFFERED_BLOB_SIZE } from "@gadgets/workshop-shared/gatekeeper";
import { softwareAuthenticator } from "../../workshop-backend/__tests__/software-authenticator.js";
import type { TestSession } from "../fixtures/gatekeeper-test/src/test-gatekeeper.js";
import {
  ADMIN_USERNAME, startHarness, TEST_GATEKEEPER_BINDING, TEST_GATEKEEPER_DIR, TEST_VENDOR_ID,
  type Harness,
} from "../src/harness.js";
import { SCRIPTED_MODEL_ID, scriptedModelRouter } from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  connect, listConnectedAccounts, logIn, nextUsernames, RpcTarget, signUp, stubFor, waitFor,
  waitForIdleChat, WorkpieceRecorder,
} from "../src/rpc-client.js";

// A second deployment admin, whom the redeploy that ends this file removes from ADMINS.
const SECOND_ADMIN = "approver";
// The harness's PUBLIC_BASE_URL, which a passkey is bound to.
const ORIGIN = "http://workshop.test";
const REASON = "The owner cannot be reached and their gadget is failing";
const END_REASON = "The investigation is over";
// What the owner asks the scripted model, and what it answers: both are in no title.
const QUESTION = "Why did the nightly export stop after the schema change?";
const ANSWER = "The export job still reads the column the schema change removed.";
const NOTES = "Meeting notes: ship the admin grants.\n";
const DRAFT_NOTES = `${NOTES}Draft: review the grant's end.\n`;
const ATTACHMENT = "Agenda for the grants review.\n";
// A text file over MAX_BUFFERED_BLOB_SIZE, which a content read returns as a stream. Its first
// character takes two bytes, so its length in bytes is not its length in characters.
const LARGE_PATH = "large.txt";
const LARGE_TEXT = `é${"a".repeat(MAX_BUFFERED_BLOB_SIZE)}`;
const OBSERVATION_DESCRIPTION =
    "Read the deterministic value exposed by the integration-test gatekeeper.";
// A PNG of one pixel: small enough for a chat page to carry its bytes for a member.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA" +
    "60e6kgAAAABJRU5ErkJggg==", "base64");
const { contentNotRequested, contentOff, grantRequired } = ADMIN_ACCESS_ERROR_CODES;
const { secondAdminRequired } = ADMIN_WRITE_ERROR_CODES;
// A challenge no server issued, for an answer that only has to be well formed.
const UNISSUED: AdminPasskeyChallenge = {
  challenge: "AAAA", rpId: "workshop.test", credentialIds: [], expiresAt: new Date(0),
};

type Authenticator = Awaited<ReturnType<typeof softwareAuthenticator>>;

// The level, the grants' audit records and the passkeys are deployment-wide and the last case
// redeploys, so this file owns its harness, runs serially, and its cases run in order.
const models = scriptedModelRouter();
const network = new NetworkInterceptor({ handlers: [models.handler] });
const fileScope = new DisposableStack();
let harness: Harness;
let admin: RpcStub<AdminApi>;
let second: RpcStub<AdminApi>;
let adminKey: Authenticator;
let secondKey: Authenticator;

// What every deployment of this file runs with, but for its admins: the operator allows content,
// and writes are on, which a request for a second admin's approval is.
const VARS = { ADMIN_WORKSPACE_ACCESS_MAX: "content", ADMIN_WORKSPACE_WRITES: "on" };

async function adminApiOf(username: string): Promise<RpcStub<AdminApi>> {
  const api = fileScope.use(await signUp(fileScope.use(connect(harness.url)), username));
  const stub = await api.getAdminApi();
  if (stub === null) throw new Error(`The admin API was unavailable to ${username}`);
  return fileScope.use(stub);
}

/** Enrols a fresh software passkey for `api`'s admin. */
async function enrolled(api: RpcStub<AdminApi>, name: string): Promise<Authenticator> {
  const authenticator = await softwareAuthenticator({ origin: ORIGIN });
  const challenge = await api.beginAdminPasskeyEnrolment();
  await api.addAdminPasskey(name, await authenticator.register(challenge));
  return authenticator;
}

beforeAll(async () => {
  network.install();
  harness = await startHarness({
    // The test connection, whose observation's description is content a mixed method withholds.
    gatekeepers: [{ binding: TEST_GATEKEEPER_BINDING, dir: TEST_GATEKEEPER_DIR }],
    patchWorkshop: config => {
      config.vars = { ...config.vars, ...VARS, ADMINS: [ADMIN_USERNAME, SECOND_ADMIN] };
    },
  });
  admin = await adminApiOf(ADMIN_USERNAME);
  second = await adminApiOf(SECOND_ADMIN);
  // The cap alone allows nothing: an admin picks the level too.
  await admin.setAdminWorkspaceAccess("content");
  adminKey = await enrolled(admin, "Laptop");
  secondKey = await enrolled(second, "Phone");
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

/** The code `error` carries, of any of the three families a grant can be refused with. */
function refusalCode(error: unknown): string | undefined {
  return getAdminAccessErrorCode(error) ?? getAdminGrantErrorCode(error) ??
      getAdminWriteErrorCode(error);
}

/** The code `call` is refused with; throws if it succeeds. */
async function codeOf(call: PromiseLike<unknown>): Promise<string | undefined> {
  try {
    await call;
  } catch (error) {
    return refusalCode(error);
  }
  throw new Error("The call was not refused");
}

/** The code and message `call` is refused with; throws if it succeeds. */
async function refusalOf(call: PromiseLike<unknown>)
    : Promise<{ code: string | undefined; message: string }> {
  try {
    await call;
  } catch (error) {
    return { code: refusalCode(error), message: error instanceof Error ? error.message : "" };
  }
  throw new Error("The call was not refused");
}

/** How many records the deployment-wide audit log holds, and the number of its newest. */
async function auditRows(): Promise<{ total: number; newest: number | null }> {
  // Addresses the deployment-wide log, which is always getByName("").
  const storage = await harness.server.getWorker("workshop-backend")
      .getDurableObjectStorage("AdminAuditDurableObject", { name: "" });
  const [row] = await storage.exec<{ total: number; newest: number | null }>(
      "SELECT COUNT(*) AS total, MAX(seq) AS newest FROM admin_audit");
  return row!;
}

/** Runs `calls`, expecting the admin audit log to gain no record from them. */
async function unrecorded<T>(calls: () => Promise<T>): Promise<T> {
  const before = await auditRows();
  const result = await calls();
  expect(await auditRows()).toEqual(before);
  return result;
}

/** The newest record of the deployment-wide audit log matching `query`, as `api` lists it. */
async function newestRecord(query: Omit<AdminAuditQuery, "limit"> = {},
                            api: RpcStub<AdminApi> = admin)
    : Promise<AdminAuditRecord | undefined> {
  return (await api.listAdminAudit({ ...query, limit: 1 })).records[0];
}

/** Every record of the deployment-wide audit log about workspace `id`, newest first. */
async function workspaceRecords(id: string, api: RpcStub<AdminApi> = admin)
    : Promise<AdminAuditRecord[]> {
  return (await api.listAdminAudit({ workspace: id, limit: 200 })).records;
}

/** An access record, narrowed. */
function accessRecord(record: AdminAuditRecord | undefined): AdminAccessRecord {
  if (record?.kind !== "workspace") throw new Error("Expected a workspace access record");
  return record;
}

/** The newest record of a call into workspace `id`. */
async function newestCall(id: string, api: RpcStub<AdminApi> = admin): Promise<AdminAccessRecord> {
  return accessRecord(await newestRecord({ workspace: id, kind: "workspace" }, api));
}

/** The records the audit log holds of write request `requestId`, oldest first. */
async function writeRecords(id: string, requestId: string, api: RpcStub<AdminApi> = admin)
    : Promise<AdminWriteRecord[]> {
  const records = (await api.listAdminAudit({ workspace: id, kind: "write", limit: 200 })).records;
  return records
      .flatMap(record => record.kind === "write" && record.requestId === requestId ? [record] : [])
      .toReversed();
}

/** A view of workspace `id` opened for content, which each call still needs a grant for. */
function contentView(id: string, api: RpcStub<AdminApi> = admin)
    : Promise<RpcStub<AdminWorkspaceView>> {
  return api.inspectWorkspace(id, REASON, { access: "content" }) as
      unknown as Promise<RpcStub<AdminWorkspaceView>>;
}

const bytesOf = async (stream: ReadableStream<Uint8Array>) =>
  Buffer.from(await new Response(stream).arrayBuffer());

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** One approval ceremony for `requestId` by `api`'s admin, answered by `authenticator`. */
async function approve(api: RpcStub<AdminApi>, authenticator: Authenticator, requestId: string)
    : Promise<AdminWriteRequest> {
  const challenge = await api.beginWorkspaceWriteApproval(requestId);
  return await api.approveWorkspaceWrite(requestId, await authenticator.assert(challenge));
}

/** The id of the grant an applied "grantContentAccess" request gave, as its outcome names it. */
function grantIdOf(request: AdminWriteRequest): string {
  const named = /^grant (\S+) until (\S+)$/.exec(request.outcome ?? "");
  if (named === null) throw new Error(`The request's outcome names no grant: ${request.outcome}`);
  return named[1]!;
}

type Member = { api: RpcStub<AuthenticatedApi>; name: string };

/** A fresh user. */
async function newUser(stack: DisposableStack, prefix: string): Promise<Member> {
  const [name] = nextUsernames(prefix);
  return { api: stack.use(await signUp(stack.use(connect(harness.url)), name!)), name: name! };
}

type Seeded = {
  owner: RpcStub<AuthenticatedApi>;
  ownerName: string;
  ws: RpcStub<Overseer>;
  id: string;
  title: string;
};

/**
 * A workspace of `owner`'s (a fresh user's unless one is given), titled, once the deployment
 * directory lists it under that title: a write can be requested only for a workspace the
 * directory lists. `api` is the admin capability that reads the directory.
 */
async function newWorkspace(stack: DisposableStack, prefix: string, owner?: Member,
                            api: RpcStub<AdminApi> = admin): Promise<Seeded> {
  const { api: ownerApi, name } = owner ?? await newUser(stack, prefix);
  const ws = stack.use(await ownerApi.newWorkspace());
  const id = (await ws.getMetadata()).id;
  const title = `Workspace ${id.slice(0, 8)} of ${name}`;
  await ws.setTitle(title);
  await waitFor(`${title} to be listed`, async () =>
    (await api.listWorkspaces({ owner: name })).workspaces
        .some(workspace => workspace.id === id && workspace.title === title) || null);
  return { owner: ownerApi, ownerName: name, ws, id, title };
}

const headOf = (workpieces: WorkpieceRecorder, gadgetId: WorkpieceId, after?: string) =>
  waitFor(`a new head for gadget ${gadgetId}`, async () => {
    const summary = workpieces.summaries.get(gadgetId);
    return summary?.type === "gadget" && summary.commitId !== undefined &&
        summary.commitId !== after ? summary.commitId : null;
  });

type Populated = Seeded & {
  /** A chat holding QUESTION, which the owner asked, and ANSWER: the scripted model's in a fresh
   * owner's workspace, the owner's own in a further workspace of theirs. */
  chatId: number;
  gadgetId: WorkpieceId;
  /** The gadget's head: the commit that holds notes.txt. */
  head: string;
  /** A chat whose first message carries one attachment, a.txt, holding ATTACHMENT. */
  attachmentChatId: number;
  /** That attachment's id. */
  attachmentId: string;
  /** A chat whose changes are not accepted: DRAFT_NOTES in notes.txt, and LARGE_PATH added. */
  draftChatId: number;
};

/**
 * A workspace holding content of each kind a view reads: a chat the scripted model answered in,
 * an observation through a test connection, a gadget whose head holds notes.txt, a chat with an
 * attachment, and a chat whose changes to the gadget are not accepted, a file over
 * MAX_BUFFERED_BLOB_SIZE among them.
 */
async function populatedWorkspace(stack: DisposableStack, prefix: string, owner?: Member)
    : Promise<Populated> {
  const seeded = await newWorkspace(stack, prefix, owner);
  const { owner: api, ws } = seeded;
  // The fake vendor mints the account with no sign-in. Its one observation is described in the
  // action log, which is content.
  await api.provisionAmbientAccount(TEST_VENDOR_ID);
  const account = (await listConnectedAccounts(api))
      .find(candidate => candidate.vendorId === TEST_VENDOR_ID);
  if (account === undefined) throw new Error("The test account was not provisioned");
  const connection = await ws.newGatekeeper(
      account.id, `https://gadgets-test.example/things/${seeded.id.slice(0, 8)}`);
  if (connection === null) throw new Error("The test connection was not created");
  stack.use(connection);
  const session = stack.use(await connection.openSession() as RpcStub<TestSession>);
  expect(await session.readValue()).toBe(42);

  let chatId: number;
  if (owner === undefined) {
    const model = models.script([{ text: ANSWER }]);
    await api.addModel(model.userModel.profile, model.userModel.config);
    chatId = await ws.newChat(QUESTION, SCRIPTED_MODEL_ID);
    await waitForIdleChat(ws, chatId);
  } else {
    // A user's model answers one script, which their first workspace used.
    chatId = await ws.newChat(QUESTION, null);
    await ws.sendChatMessage(chatId, ANSWER, null);
  }

  // Seeded without a model: a human-only chat submits the file at the empty head, and accepting
  // it commits it.
  const workpieces = new WorkpieceRecorder();
  stack.use(await ws.subscribeToWorkpieces(stack.use(stubFor(workpieces))));
  await workpieces.loaded;
  const gadget = stack.use(ws.createGadget("Notes", undefined, "NOTES"));
  const gadgetId = await gadget.getId();
  const empty = await headOf(workpieces, gadgetId);
  const seedChatId = await ws.newChat("Seed", null);
  await ws.submitCodeChange(seedChatId, {
    generation: 0, revision: 0, clientId: "seed", seq: 1,
    pins: [{ gadgetId, baseCommit: empty }],
    change: diffFiles(new Map([[gadgetId, new Map()]]),
        new Map([[gadgetId, new Map([["notes.txt", NOTES]])]])),
  });
  expect(await ws.mergeChanges(seedChatId)).toEqual({ outcome: "merged" });
  const head = await headOf(workpieces, gadgetId, empty);

  const oid = await ws.uploadBlob(new TextEncoder().encode(ATTACHMENT));
  const attachmentChatId = await ws.newChat(
      "With attachment", null, undefined, [{ oid, mimeType: "text/plain", name: "a.txt" }]);
  const attachmentId = await firstAttachmentId(ws, attachmentChatId);

  const draftChatId = await ws.newChat("Draft", null);
  await ws.submitCodeChange(draftChatId, {
    generation: 0, revision: 0, clientId: "draft", seq: 1,
    pins: [{ gadgetId, baseCommit: head }],
    change: diffFiles(new Map([[gadgetId, new Map([["notes.txt", NOTES]])]]),
        new Map([[gadgetId, new Map([["notes.txt", DRAFT_NOTES], [LARGE_PATH, LARGE_TEXT]])]])),
  });
  return { ...seeded, chatId, gadgetId, head, attachmentChatId, attachmentId, draftChatId };
}

/** The id of the one attachment the first message of chat `chatId` carries. */
async function firstAttachmentId(ws: RpcStub<Overseer>, chatId: number): Promise<string> {
  const sent = (await ws.getChatHistory(chatId)).messages
      .find(message => message.type === "message");
  if (sent?.type !== "message" || !sent.attachments?.length) {
    throw new Error("The attachment was not sent");
  }
  return sent.attachments[0]!.id;
}

type ContentRead =
    [AdminAccessRecord["method"], AdminAccessRecord["args"], () => PromiseLike<unknown>];

/** One call of each of the five methods that answer with content alone, each naming something
 * the workspace holds, with the arguments its record keeps. */
function contentReads(view: RpcStub<AdminWorkspaceView>, populated: Populated): ContentRead[] {
  const { chatId, gadgetId, head, attachmentChatId, attachmentId, draftChatId } = populated;
  return [
    ["getChat", { chatId }, () => view.getChat(chatId)],
    ["readChatAttachment", { chatId: attachmentChatId, id: attachmentId },
     async () => bytesOf(await view.readChatAttachment(attachmentChatId, attachmentId))],
    ["readFile", { gadgetId, path: "notes.txt" }, () => view.readFile(gadgetId, "notes.txt")],
    ["readFileAtCommit", { commitId: head, path: "notes.txt" },
     () => view.readFileAtCommit(head, "notes.txt")],
    ["readPendingFile", { chatId: draftChatId, gadgetId, path: "notes.txt" },
     () => view.readPendingFile(draftChatId, gadgetId, "notes.txt")],
  ];
}

/**
 * Expects each of the five content reads on `view` to be refused with `refused`, and each
 * refusal to be recorded as one: what the view was opened for, the level in force, nothing
 * exposed and no grant.
 */
async function expectRefused(view: RpcStub<AdminWorkspaceView>, populated: Populated,
    refused: NonNullable<AdminAccessRecord["refused"]>,
    recorded: Pick<AdminAccessRecord, "requested" | "access">): Promise<void> {
  for (const [method, args, call] of contentReads(view, populated)) {
    expect(await codeOf(call()), method).toBe(refused);
    const record = await newestCall(populated.id);
    expect(record, method).toMatchObject({ method, refused, exposed: "metadata", ...recorded });
    expect(record.args, method).toEqual(args);
    expect(record, method).not.toHaveProperty("grantId");
  }
}

class ActionsRecorder extends RpcTarget implements ActionsSubscriber {
  readonly entries: ActionLogEntry[] = [];
  entry(record: ActionLogEntry): void { this.entries.push(record); }
  ready(): void {}
}

class NotificationRecorder extends RpcTarget implements NotificationSubscriber {
  readonly notifications: UserNotification[] = [];
  async notify(notification: UserNotification): Promise<void> {
    this.notifications.push(notification);
  }
}

it("lets only a workspace's owner give, renew, list and end a grant, none of it in the audit log",
    async () => {
  using stack = new DisposableStack();
  const { ws, id, ownerName } = await newWorkspace(stack, "grantowner");
  const member = await newUser(stack, "grantmember");
  expect(await ws.addCollaborator(member.name, "workspace")).not.toBeNull();
  const shared = stack.use(await member.api.openWorkspace(id));
  using view = await admin.inspectWorkspace(id, REASON);
  const listed = async () => (await view.describe()).grants;
  expect(await listed()).toEqual([]);

  // An owner's grant is the owner's own record: the audit log records what admins do.
  const renewed = await unrecorded(async () => {
    const grant = await ws.grantAdminAccess();
    expect(grant).toEqual({
      id: expect.any(String), level: "content", source: "owner", scope: "workspace",
      grantedBy: { id: ownerName, name: ownerName }, grantedAt: expect.any(Date),
      expiresAt: expect.any(Date),
    });
    expect(grant.expiresAt.getTime() - grant.grantedAt.getTime())
        .toBe(ADMIN_GRANT_LIFETIME_SECONDS * 1000);

    // Any number of times: each moves the end, and none is counted.
    let latest = grant;
    for (let round = 0; round < 6; round++) {
      await sleep(2);
      const next = await ws.renewAdminAccess(grant.id);
      expect(next).toEqual({ ...grant, expiresAt: expect.any(Date) });
      expect(next.expiresAt.getTime()).toBeGreaterThan(latest.expiresAt.getTime());
      latest = next;
    }
    expect(await ws.listAdminGrants()).toEqual([latest]);

    // A collaborator does everything else in the workspace, and none of this.
    const refused = "Only the workspace owner can give admins access to it.";
    await expect(shared.grantAdminAccess()).rejects.toThrow(refused);
    await expect(shared.renewAdminAccess(grant.id)).rejects.toThrow(refused);
    await expect(shared.revokeAdminAccess(grant.id)).rejects.toThrow(refused);
    await expect(shared.listAdminGrants()).rejects.toThrow(refused);
    expect(await ws.listAdminGrants()).toEqual([latest]);
    return latest;
  });
  // Where an admin learns of it: among the live grants of the workspace they inspect.
  expect(await listed()).toEqual([renewed]);

  try {
    // Below "content" nothing is given or renewed, and what was given can still be ended.
    await admin.setAdminWorkspaceAccess("metadata");
    const ended = await unrecorded(async () => {
      expect(await codeOf(ws.grantAdminAccess())).toBe(contentOff);
      expect(await codeOf(ws.renewAdminAccess(renewed.id))).toBe(contentOff);
      expect(await ws.listAdminGrants()).toEqual([renewed]);
      await ws.revokeAdminAccess(renewed.id);
      const [kept, ...others] = await ws.listAdminGrants();
      expect(others).toEqual([]);
      return kept;
    });
    expect(ended).toEqual({
      ...renewed, revokedAt: expect.any(Date), revokedBy: { id: ownerName, name: ownerName },
    });
    expect(await listed()).toEqual([]);

    await unrecorded(async () => {
      // Ending an ended grant changes nothing, an ended one is not renewed, and an id that names
      // no grant of the owner's is refused.
      await ws.revokeAdminAccess(renewed.id);
      expect(await ws.listAdminGrants()).toEqual([ended]);
      const { notFound } = ADMIN_GRANT_ERROR_CODES;
      expect(await codeOf(ws.renewAdminAccess(renewed.id))).toBe(notFound);
      expect(await codeOf(ws.revokeAdminAccess(crypto.randomUUID()))).toBe(notFound);
    });
  } finally {
    await admin.setAdminWorkspaceAccess("content");
  }
});

it("bounds what it answers about the grants of an owner with a very long name", async () => {
  using stack = new DisposableStack();
  // A display name has no bound of its own, and an owner gives grants without limit. The name is
  // set first: a session keeps the profile its user had when it opened the workspace.
  const user = await newUser(stack, "grantmany");
  await user.api.setOwnDisplayName("N".repeat(1_000_000));
  const { ownerName, ws, id } = await newWorkspace(stack, "grantmany", user);
  const chatId = await ws.newChat("hello", null);
  const given: AdminAccessGrant[] = [];
  for (let round = 0; round < 30; round++) {
    given.push(await ws.grantAdminAccess());
    // Each is given at a time of its own, so that "newest" names one order.
    await sleep(2);
  }
  const newest = given.toReversed().slice(0, MAX_ADMIN_GRANTS_LISTED);
  expect(newest).toHaveLength(20);
  const name = `${"N".repeat(MAX_ADMIN_AUDIT_ARG_LENGTH - 1)}…`;
  expect(name).toHaveLength(256);

  using view = await contentView(id);
  const { grants } = await view.describe();
  expect(grants.map(grant => grant.id)).toEqual(newest.map(grant => grant.id));
  for (const grant of grants) expect(grant.grantedBy).toEqual({ id: ownerName, name });
  // What the owner reads of them is bounded the same way.
  expect(await ws.listAdminGrants()).toEqual(grants);

  // Any one lets content be read, listed or not.
  const page = await view.getChat(chatId);
  expect(page.messages).toContainEqual(expect.objectContaining({ message: "hello" }));
  const record = await newestCall(id);
  expect(record).toMatchObject({ method: "getChat", exposed: "content" });
  expect(given.map(grant => grant.id)).toContain(record.grantId);
});

it("reads content only through a view opened for it, under a live grant, recording each read",
    async () => {
  using stack = new DisposableStack();
  const populated = await populatedWorkspace(stack, "grantcontent");
  const {
    ws, id, chatId, gadgetId, head, attachmentChatId, attachmentId, draftChatId,
  } = populated;
  // What the owner reads of the chat: their question and the model's answer.
  const ownerPage = await ws.getChatHistory(chatId);
  for (const message of [QUESTION, ANSWER]) {
    expect(ownerPage.messages)
        .toContainEqual(expect.objectContaining({ type: "message", message }));
  }

  // Opening for content needs the level, and no grant yet: each call looks for one.
  using metadata = await admin.inspectWorkspace(id, REASON);
  using content = await contentView(id);
  expect(await content.describe()).toMatchObject({ access: "content", grants: [] });
  const asked = { requested: "content", access: "content" } as const;
  await expectRefused(content, populated, grantRequired, asked);

  const grant = await ws.grantAdminAccess();
  // A view opened to look at metadata reads nothing more because a grant happens to be live.
  await expectRefused(metadata, populated, contentNotRequested,
      { requested: "metadata", access: "content" });

  // Each call that checks its answer does so before its record is read.
  const reads: [AdminAccessRecord["method"], () => Promise<void>][] = [
    // An admin's page is the owner's: this chat carries no image.
    ["getChat", async () => expect(await content.getChat(chatId)).toEqual(ownerPage)],
    ["readChatAttachment", async () => {
      const stream = await content.readChatAttachment(attachmentChatId, attachmentId);
      expect((await bytesOf(stream)).toString()).toBe(ATTACHMENT);
    }],
    ["readFile", async () =>
      expect(await content.readFile(gadgetId, "notes.txt")).toEqual({ kind: "text", text: NOTES })],
    ["readFileAtCommit", async () =>
      expect(await content.readFileAtCommit(head, "notes.txt"))
          .toEqual({ kind: "text", text: NOTES })],
    // The draft's text, not the committed one.
    ["readPendingFile", async () =>
      expect(await content.readPendingFile(draftChatId, gadgetId, "notes.txt"))
          .toEqual({ kind: "text", text: DRAFT_NOTES })],
    // A file over MAX_BUFFERED_BLOB_SIZE arrives as a stream of its bytes, read here to its end.
    ["readPendingFile", async () => {
      const file = await content.readPendingFile(draftChatId, gadgetId, LARGE_PATH);
      if (file.kind !== "stream") throw new Error(`Expected a stream, not ${file.kind}`);
      const expected = Buffer.from(LARGE_TEXT);
      expect(file.byteLength).toBe(expected.byteLength);
      expect(file.byteLength).toBeGreaterThan(LARGE_TEXT.length);
      // Compared outside the matcher, whose failure would print both texts whole.
      expect((await bytesOf(file.content)).equals(expected)).toBe(true);
    }],
  ];
  for (const [method, read] of reads) {
    await read();
    const record = await newestCall(id);
    expect(record, method)
        .toMatchObject({ method, ...asked, exposed: "content", grantId: grant.id });
    expect(record.refused, method).toBeUndefined();
  }
  // The content reads are listed apart, newest first.
  const exposed = (await admin.listAdminAudit({ workspace: id, exposed: "content" })).records;
  expect(exposed.map(record => accessRecord(record).method))
      .toEqual(reads.map(([method]) => method).toReversed());

  // A grant its owner ends is seen by the very next call of a view that is still open.
  await ws.revokeAdminAccess(grant.id);
  await expectRefused(content, populated, grantRequired, asked);

  const regranted = await ws.grantAdminAccess();
  const readNotes = () => content.readFile(gadgetId, "notes.txt");
  expect(await readNotes()).toEqual({ kind: "text", text: NOTES });
  try {
    // A grant never widens the level: lowered, it withholds on the next call although the grant
    // is live, and no view is opened for content.
    await admin.setAdminWorkspaceAccess("metadata");
    await expectRefused(content, populated, contentOff,
        { requested: "content", access: "metadata" });
    expect(await codeOf(contentView(id))).toBe(contentOff);
    const refusedOpen = await newestCall(id);
    expect(refusedOpen).toMatchObject({
      method: "inspectWorkspace", refused: contentOff, access: "metadata", exposed: "metadata",
    });
    expect(refusedOpen).not.toHaveProperty("grantId");
  } finally {
    await admin.setAdminWorkspaceAccess("content");
  }
  // The grant was live throughout, and reads again once the level is back.
  expect(await readNotes()).toEqual({ kind: "text", text: NOTES });
  expect(await newestCall(id))
      .toMatchObject({ method: "readFile", exposed: "content", grantId: regranted.id });

  // Every refusal above is in the log, as a record that says so: four rounds of the five
  // methods, and the open.
  const refusals = (await workspaceRecords(id)).map(accessRecord)
      .flatMap(record => record.refused === undefined ? [] : [record.refused]);
  expect(refusals.toReversed()).toEqual([
    ...Array<string>(5).fill(grantRequired), ...Array<string>(5).fill(contentNotRequested),
    ...Array<string>(5).fill(grantRequired), ...Array<string>(5).fill(contentOff), contentOff,
  ]);
});

/** One call of each of three mixed methods and of one that answers with metadata alone, each
 * with the record it left. */
async function mixedAnswers(view: RpcStub<AdminWorkspaceView>, populated: Populated) {
  const { id, gadgetId, head } = populated;
  const records: AdminAccessRecord[] = [];
  const recorded = async <T>(answer: T): Promise<T> => {
    records.push(await newestCall(id));
    return answer;
  };
  const actions = await recorded(await view.listActions());
  const log = await recorded(await view.getCommitLog(head));
  const description = await recorded(await view.describe());
  const files = await recorded(await view.listFiles(gadgetId));
  return {
    observation: actions.entries.find(entry => entry.type === "observation"),
    log,
    gadget: description.workpieces.find(workpiece => workpiece.id === gadgetId),
    files,
    records,
  };
}

it("answers a mixed method as metadata without a grant, and with content under one", async () => {
  using stack = new DisposableStack();
  const populated = await populatedWorkspace(stack, "grantmixed");
  const { ws, id, head } = populated;
  const ownerLog = await ws.getCommitLog(head);
  expect(ownerLog.length).toBeGreaterThan(1);
  for (const commit of ownerLog) expect(commit.message, commit.oid).not.toBe("");

  // On a view opened for content with no grant, a mixed method is not refused: it answers as
  // the "metadata" level does, and its record says nothing was exposed.
  using view = await contentView(id);
  const withheld = await mixedAnswers(view, populated);
  expect(withheld.observation?.description)
      .toEqual({ title: "Read the test value", description: "" });
  expect(withheld.log).toEqual(ownerLog.map(commit => ({ ...commit, message: "" })));
  expect(withheld.gadget).not.toHaveProperty("upstream");
  expect(withheld.files).toEqual([{ name: "notes.txt", kind: "file" }]);
  expect(withheld.records.map(record => record.method))
      .toEqual(["listActions", "getCommitLog", "describe", "listFiles"]);
  for (const record of withheld.records) {
    expect(record, record.method)
        .toMatchObject({ requested: "content", access: "content", exposed: "metadata" });
    expect(record, record.method).not.toHaveProperty("grantId");
    expect(record.refused, record.method).toBeUndefined();
  }
  expect(JSON.stringify(withheld).includes(OBSERVATION_DESCRIPTION)).toBe(false);

  const grant = await ws.grantAdminAccess();
  const shown = await mixedAnswers(view, populated);
  expect(shown.observation?.description).toMatchObject({
    title: "Read the test value", description: OBSERVATION_DESCRIPTION,
  });
  expect(shown.log).toEqual(ownerLog);
  // A gadget built from scratch follows no blueprint, which its `upstream` says with no id.
  expect(shown.gadget).toMatchObject({ upstream: {} });
  expect(shown.files).toEqual(withheld.files);
  // A record carries the grant when the call was allowed content, whether or not its answer held
  // any. A method that answers with metadata alone never looks for one.
  expect(shown.records.map(({ method, exposed, grantId }) => ({ method, exposed, grantId })))
      .toEqual([
        { method: "listActions", exposed: "content", grantId: grant.id },
        { method: "getCommitLog", exposed: "content", grantId: grant.id },
        { method: "describe", exposed: "metadata", grantId: grant.id },
        { method: "listFiles", exposed: "metadata", grantId: undefined },
      ]);
});

it("reads content under the owner's account-wide grant, which is never copied into a workspace",
    async () => {
  using stack = new DisposableStack();
  const older = await populatedWorkspace(stack, "grantaccount");
  const user: Member = { api: older.owner, name: older.ownerName };
  expect(await user.api.getAccountAdminGrant()).toBeNull();
  using olderView = await contentView(older.id);
  expect(await codeOf(olderView.getChat(older.chatId))).toBe(grantRequired);

  // One record in the owner's account, set through their own API, and theirs alone.
  const grant = await unrecorded(async () => {
    const given = await user.api.grantAccountAdminAccess();
    expect(given).toEqual({
      id: expect.any(String), level: "content", source: "owner", scope: "account",
      grantedBy: { id: user.name, name: user.name }, grantedAt: expect.any(Date),
      expiresAt: expect.any(Date),
    });
    await sleep(2);
    // Given again while live, it is renewed under its id.
    const renewed = await user.api.grantAccountAdminAccess();
    expect(renewed).toEqual({ ...given, expiresAt: expect.any(Date) });
    expect(renewed.expiresAt.getTime()).toBeGreaterThan(given.expiresAt.getTime());
    expect(await user.api.getAccountAdminGrant()).toEqual(renewed);
    return renewed;
  });

  // The same view's next call answers: a workspace does not keep the answer that there is no
  // grant, so there is no minute to wait.
  const page = await olderView.getChat(older.chatId);
  expect(page.messages).toContainEqual(expect.objectContaining({ message: ANSWER }));
  expect(await newestCall(older.id))
      .toMatchObject({ method: "getChat", exposed: "content", grantId: grant.id });

  // It covers a workspace made after it was given.
  const newer = await populatedWorkspace(stack, "grantaccount", user);
  using newerView = await contentView(newer.id);
  const views: [Populated, RpcStub<AdminWorkspaceView>][] =
      [[older, olderView], [newer, newerView]];
  for (const [workspace, view] of views) {
    for (const [method, , read] of contentReads(view, workspace)) {
      await read();
      expect(await newestCall(workspace.id), method)
          .toMatchObject({ method, exposed: "content", grantId: grant.id });
    }
    const mixed = await mixedAnswers(view, workspace);
    expect(mixed.observation?.description.description).toBe(OBSERVATION_DESCRIPTION);
    expect(mixed.records[0])
        .toMatchObject({ method: "listActions", exposed: "content", grantId: grant.id });

    // The grant is never copied into a workspace. A workspace keeps its grants in its object's
    // key-value storage, which the harness cannot read, so this is what its two readers show:
    // an admin's view lists every live grant the workspace stores, from either source, and the
    // owner's listing every grant of theirs it stores, live or ended.
    expect((await view.describe()).grants).toEqual([]);
    expect(await workspace.ws.listAdminGrants()).toEqual([]);
  }
  expect(await user.api.getAccountAdminGrant()).toEqual(grant);

  // A view opened for metadata never asks the owner's account for a grant. A call that had
  // asked would have recorded the grant's id, which is what a real server can show; that
  // liveAccountAdminGrant() itself is not called is counted where the account is a stub, in
  // workshop-backend's admin-workspace-view.test.ts. The account is not idle either way:
  // describe() and listShareLinks() read the owner's profile from it.
  using metadata = await admin.inspectWorkspace(newer.id, REASON);
  const calls: [string, () => PromiseLike<unknown>][] = [
    // A mixed method, and one that answers with metadata alone and reads no profile.
    ["listChats", () => metadata.listChats()],
    ["listFiles", () => metadata.listFiles(newer.gadgetId)],
  ];
  for (const [method, call] of calls) {
    await call();
    const record = await newestCall(newer.id);
    expect(record, method)
        .toMatchObject({ method, requested: "metadata", access: "content", exposed: "metadata" });
    expect(record, method).not.toHaveProperty("grantId");
    expect(record.refused, method).toBeUndefined();
  }
});

it("stops reading under the account-wide grant within a minute of its revocation", async () => {
  using stack = new DisposableStack();
  const { owner, ws, id } = await newWorkspace(stack, "grantrevoked");
  const chatId = await ws.newChat("hello", null);
  const grant = await owner.grantAccountAdminAccess();
  using view = await contentView(id);
  const read = () => view.getChat(chatId).then(() => undefined, refusalCode);
  // The workspace asks its owner's account here, and relies on the answer from this moment.
  expect(await read()).toBeUndefined();
  expect(await newestCall(id)).toMatchObject({ exposed: "content", grantId: grant.id });

  await unrecorded(() => owner.revokeAccountAdminAccess());
  const revoked = Date.now();
  expect(await owner.getAccountAdminGrant()).toEqual({
    ...grant, revokedAt: expect.any(Date), revokedBy: grant.grantedBy,
  });

  // No timer ends it: the first call made once the answer is too old asks again. The harness
  // runs on real time, so this waits the bound out, asking as seldom as shows it was kept.
  const bound = ADMIN_GRANT_ACCOUNT_CACHE_SECONDS * 1000;
  const refused = await waitFor("content to stop after the revocation", async () => {
    await sleep(2_000);
    return await read() ?? null;
  }, bound + 15_000);
  expect(refused).toBe(grantRequired);
  expect(Date.now() - revoked).toBeLessThan(bound + 5_000);
  const record = await newestCall(id);
  expect(record).toMatchObject({ method: "getChat", refused: grantRequired, exposed: "metadata" });
  expect(record).not.toHaveProperty("grantId");

  // A grant given afterwards is found by the next call.
  const again = await owner.grantAccountAdminAccess();
  expect(again.id).not.toBe(grant.id);
  expect(await read()).toBeUndefined();
  expect(await newestCall(id)).toMatchObject({ exposed: "content", grantId: again.id });
});

/** The attachments the messages of a chat page carry, in order. */
const attachmentsOf = (page: Awaited<ReturnType<Overseer["getChatHistory"]>>) =>
  page.messages.flatMap(message => message.type === "message" ? message.attachments ?? [] : []);

it("gives an admin a chat page with no inline image, and the image's bytes as a stream",
    async () => {
  using stack = new DisposableStack();
  const { ws, id } = await newWorkspace(stack, "grantimage");
  const oid = await ws.uploadBlob(new Uint8Array(PNG));
  const chatId = await ws.newChat(
      "With image", null, undefined, [{ oid, mimeType: "image/png", name: "shot.png" }]);
  const attachmentId = await firstAttachmentId(ws, chatId);
  await ws.grantAdminAccess();

  // A member's page carries a small image's bytes, so that their client renders it at once.
  const [ownerCopy] = attachmentsOf(await ws.getChatHistory(chatId));
  expect(ownerCopy?.id).toBe(attachmentId);
  expect(Buffer.from(ownerCopy!.content!).equals(PNG)).toBe(true);

  // An admin's page names the image and holds none of it: its bytes are read, and recorded, with
  // readChatAttachment().
  using view = await contentView(id);
  const [adminCopy] = attachmentsOf(await view.getChat(chatId));
  const { content: _content, ...reference } = ownerCopy!;
  expect(adminCopy).toEqual(reference);
  expect(adminCopy).not.toHaveProperty("content");
  expect((await bytesOf(await view.readChatAttachment(chatId, attachmentId))).equals(PNG))
      .toBe(true);
  expect(await newestCall(id)).toMatchObject({
    method: "readChatAttachment", args: { chatId, id: attachmentId }, exposed: "content",
  });
});

it("gives a grant by a second admin's approval, which only an admin ends", async () => {
  using stack = new DisposableStack();
  const { ws, id, title, ownerName } = await newWorkspace(stack, "grantapproved");
  const chatId = await ws.newChat("hello", null);
  using view = await contentView(id);
  const read = () => view.getChat(chatId);
  expect(await codeOf(read())).toBe(grantRequired);

  // Any admin asks, through the write machinery as it stands, with no argument but the reason.
  const request = await admin.requestWorkspaceWrite(id, "grantContentAccess", {}, REASON);
  expect(request).toMatchObject({
    workspaceId: id, action: "grantContentAccess", args: {}, reason: REASON,
    requestedBy: ADMIN_USERNAME, state: "pending",
  });

  // The approver is not the requester: no challenge is issued to them, and an answer they send
  // all the same is refused before any passkey check, and recorded. The harness signs in
  // password accounts only, whose names are stored lowercased, so two accounts that differ by
  // the case of their letters alone cannot exist here: that one admin under two casings is the
  // requester is covered in workshop-backend's admin-write-approval.test.ts.
  expect(await codeOf(admin.beginWorkspaceWriteApproval(request.id))).toBe(secondAdminRequired);
  expect(await codeOf(
      admin.approveWorkspaceWrite(request.id, await adminKey.assert(UNISSUED))))
      .toBe(secondAdminRequired);
  expect((await writeRecords(id, request.id)).at(-1)).toMatchObject({
    event: "refused", admin: ADMIN_USERNAME, requestedBy: ADMIN_USERNAME, refusal: "requester",
  });
  expect((await admin.getWorkspaceWrite(request.id)).state).toBe("pending");
  expect(await codeOf(read())).toBe(grantRequired);

  const applied = await approve(second, secondKey, request.id);
  expect(applied).toMatchObject({ id: request.id, state: "applied", resolvedBy: SECOND_ADMIN });
  const grantId = grantIdOf(applied);
  // Where an admin sees it: among the live grants of the workspace, with who asked and why.
  const [grant, ...others] = (await view.describe()).grants;
  expect(others).toEqual([]);
  expect(grant).toEqual({
    id: grantId, level: "content", source: "admins", scope: "workspace",
    grantedBy: { id: SECOND_ADMIN, name: SECOND_ADMIN }, requestedBy: ADMIN_USERNAME,
    requestId: request.id, reason: REASON, grantedAt: expect.any(Date),
    expiresAt: expect.any(Date),
  });
  expect(grant!.expiresAt.getTime() - grant!.grantedAt.getTime())
      .toBe(ADMIN_GRANT_LIFETIME_SECONDS * 1000);
  expect(applied.outcome).toBe(`grant ${grantId} until ${grant!.expiresAt.toISOString()}`);

  expect((await read()).messages).toContainEqual(expect.objectContaining({ message: "hello" }));
  expect(await newestCall(id)).toMatchObject({ method: "getChat", exposed: "content", grantId });
  const steps = await writeRecords(id, request.id);
  expect(steps.map(step => step.event)).toEqual(["requested", "refused", "approved", "applied"]);
  expect(steps.at(-1)).toMatchObject({
    admin: SECOND_ADMIN, passkey: secondKey.credentialId, outcome: applied.outcome,
  });

  // An owner's grant is the owner's to end, and an approval's an admin's: never renewed, it is
  // ended with a reason, by any admin, whatever the level.
  const { notFound } = ADMIN_GRANT_ERROR_CODES;
  const own = await ws.grantAdminAccess();
  expect(await codeOf(second.endWorkspaceGrant(id, own.id, END_REASON))).toBe(notFound);
  await ws.revokeAdminAccess(own.id);
  await expect(second.endWorkspaceGrant(id, grantId, "  ")).rejects.toThrow();
  expect((await view.describe()).grants).toEqual([grant]);
  try {
    await admin.setAdminWorkspaceAccess("metadata");
    await admin.endWorkspaceGrant(id, grantId, END_REASON);
  } finally {
    await admin.setAdminWorkspaceAccess("content");
  }
  const revoked = (await writeRecords(id, request.id)).at(-1)!;
  expect(revoked).toMatchObject({
    kind: "write", event: "revoked", admin: ADMIN_USERNAME, via: "api", requestId: request.id,
    workspaceId: id, workspaceOwner: ownerName, workspaceTitle: title,
    method: "grantContentAccess", args: {}, reason: REASON, requestedBy: ADMIN_USERNAME,
    endReason: END_REASON,
  });
  expect(revoked.passkey).toBeUndefined();
  expect(await codeOf(read())).toBe(grantRequired);
  expect((await view.describe()).grants).toEqual([]);
  // An ended grant is not ended twice, and the refusal records nothing.
  await unrecorded(async () =>
    expect(await codeOf(second.endWorkspaceGrant(id, grantId, END_REASON))).toBe(notFound));

  // What the log holds of the request is its steps, each a write record: of the workspace's
  // records, those that are no call of a view are these five.
  const recorded = (await workspaceRecords(id)).filter(record => record.kind !== "workspace");
  expect(recorded.toReversed()).toEqual(await writeRecords(id, request.id));
  expect(recorded.toReversed().map(record => record.kind === "write" && record.event))
      .toEqual(["requested", "refused", "approved", "applied", "revoked"]);
});

it("shows a workspace's owner nothing of an approval's grant", async () => {
  using stack = new DisposableStack();
  const { owner, ws, id } = await newWorkspace(stack, "grantunseen");
  const chatId = await ws.newChat("hello", null);
  // Subscribed before anything happens, as a member who has the workspace open is.
  const actions = new ActionsRecorder();
  stack.use(await ws.subscribeToActions(stack.use(stubFor(actions))));
  const notifications = new NotificationRecorder();
  stack.use(await owner.subscribeToNotifications(stack.use(stubFor(notifications))));
  // What the owner can read that a write to their workspace, or a grant on it, could change.
  const seen = async () => ({
    actions: await ws.listActions(), grants: await ws.listAdminGrants(),
    metadata: await ws.getMetadata(), unread: await owner.getUnreadSummary(),
    account: await owner.getAccountAdminGrant(),
  });
  let before: Record<string, unknown> = await seen();
  const unseen = async (step: string) => {
    expect(await seen(), step).toEqual(before);
    expect(actions.entries, step).toEqual([]);
    expect(notifications.notifications, step).toEqual([]);
  };

  const request = await admin.requestWorkspaceWrite(id, "grantContentAccess", {}, REASON);
  await unseen("the request");
  const grantId = grantIdOf(await approve(second, secondKey, request.id));
  await unseen("the approval");
  using view = await contentView(id);
  await view.getChat(chatId);
  expect(await newestCall(id)).toMatchObject({ exposed: "content", grantId });
  await view.listActions();
  await unseen("the reads");
  const stored = (await view.describe()).grants;
  expect(stored).toEqual([expect.objectContaining({ id: grantId, source: "admins" })]);

  // The owner cannot learn that the grant exists by probing: its id is refused exactly as an id
  // that names nothing is, by code and by message.
  const { notFound } = ADMIN_GRANT_ERROR_CODES;
  const probes = async (step: string) => {
    const calls = [(grant: string) => ws.revokeAdminAccess(grant),
                   (grant: string) => ws.renewAdminAccess(grant)];
    for (const call of calls) {
      const unknown = await refusalOf(call(crypto.randomUUID()));
      expect(unknown.code, step).toBe(notFound);
      expect(await refusalOf(call(grantId)), step).toEqual(unknown);
    }
  };
  // The owner's own grant calls see and touch their own grants alone, and record nothing.
  const ownCalls = (step: string) => unrecorded(async () => {
    const own = await ws.grantAdminAccess();
    await ws.renewAdminAccess(own.id);
    const listed = await ws.listAdminGrants();
    expect(listed[0], step).toMatchObject({ id: own.id, source: "owner" });
    expect(listed.map(grant => grant.source), step).not.toContain("admins");
    await ws.revokeAdminAccess(own.id);
  });

  await probes("while the grant is live");
  await ownCalls("while the grant is live");
  // The approval's stored record is as it was: the view lists it whole while it is live. (The
  // workspace keeps its grants in its object's key-value storage, which the harness cannot read.)
  expect((await view.describe()).grants).toEqual(stored);
  // The owner's listing changed by their own grant, and by nothing else.
  before = { ...before, grants: [expect.objectContaining({ source: "owner" })] };
  await unseen("the owner's own grant");
  before = await seen();

  await second.endWorkspaceGrant(id, grantId, END_REASON);
  await unseen("the ending");
  const steps = await writeRecords(id, request.id);
  expect(steps.map(step => step.event)).toEqual(["requested", "approved", "applied", "revoked"]);

  // Once it is ended its record is in no listing, so what shows it untouched is what an admin
  // can still ask of it: it stays ended, and its steps in the log are the same four.
  await probes("after the grant was ended");
  await ownCalls("after the grant was ended");
  expect(await codeOf(admin.endWorkspaceGrant(id, grantId, END_REASON))).toBe(notFound);
  expect(await writeRecords(id, request.id)).toEqual(steps);
  expect((await view.describe()).grants).toEqual([]);
  expect(actions.entries).toEqual([]);
  expect(notifications.notifications).toEqual([]);

  // The other writes stay visible: one run on the same workspace enters its action log.
  const stop = await admin.requestWorkspaceWrite(id, "stopAgent", { chatId }, REASON);
  expect((await approve(admin, adminKey, stop.id)).state).toBe("applied");
  const entries = (await ws.listActions()).entries
      .flatMap(entry => entry.type === "action" && entry.byAdmin ? [entry] : []);
  expect(entries).toEqual([expect.objectContaining({
    type: "action", byAdmin: true, state: "approved",
    description: expect.objectContaining({ title: `Stop the agent in chat ${chatId}` }),
  })]);
  await waitFor("the subscriber to be shown the write", async () => actions.entries.length || null);
  expect(actions.entries).toEqual(entries);
});

it("leaves a deployment with one admin only the owner's grant", async () => {
  await harness.redeployWorkshop(config => {
    config.vars = { ...config.vars, ...VARS, ADMINS: [ADMIN_USERNAME] };
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
  // The former second admin has no admin API, so no approval method is within their reach.
  expect(await (await logInAfresh(SECOND_ADMIN)).getAdminApi()).toBeNull();
  const lone = await (await logInAfresh(ADMIN_USERNAME)).getAdminApi();
  if (lone === null) throw new Error("The admin API was unavailable after the redeploy");
  stack.use(lone);
  expect((await lone.getSettings()).adminWorkspaceAccess)
      .toEqual({ effective: "content", chosen: "content", max: "content" });

  const { ws, id } = await newWorkspace(stack, "grantlone", undefined, lone);
  const chatId = await ws.newChat("hello", null);
  // A request can be made, and nobody can approve it: the one admin is its requester.
  const request = await lone.requestWorkspaceWrite(id, "grantContentAccess", {}, REASON);
  expect(request.state).toBe("pending");
  expect(await codeOf(lone.beginWorkspaceWriteApproval(request.id))).toBe(secondAdminRequired);
  expect(await codeOf(lone.approveWorkspaceWrite(request.id, await adminKey.assert(UNISSUED))))
      .toBe(secondAdminRequired);
  expect((await lone.getWorkspaceWrite(request.id)).state).toBe("pending");
  expect((await writeRecords(id, request.id, lone)).map(step => step.event))
      .toEqual(["requested", "refused"]);

  using view = await contentView(id, lone);
  expect((await view.describe()).grants).toEqual([]);
  expect(await codeOf(view.getChat(chatId))).toBe(grantRequired);
  // What is left is the owner's grant.
  const grant = await ws.grantAdminAccess();
  expect((await view.getChat(chatId)).messages)
      .toContainEqual(expect.objectContaining({ message: "hello" }));
  expect(await newestCall(id, lone)).toMatchObject({ exposed: "content", grantId: grant.id });
});
