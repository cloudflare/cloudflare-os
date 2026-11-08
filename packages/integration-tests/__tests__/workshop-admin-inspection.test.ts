import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  ADMIN_ACCESS_ERROR_CODES, getAdminAccessErrorCode, getOpenWorkspaceErrorCode,
  MAX_ADMIN_AUDIT_ARG_LENGTH, MAX_DIRECTORY_TEXT_LENGTH, OPEN_WORKSPACE_ERROR_CODES,
  type ActionLogEntry, type ActionsSubscriber, type AdminAccessErrorCode, type AdminAccessRecord,
  type AdminApi, type AdminAuditQuery, type AdminAuditRecord, type AdminViewAccess,
  type AdminWorkspaceAccess, type AuthenticatedApi, type Overseer, type PresenceParticipant,
  type PresenceSubscriber, type WorkpieceId,
} from "@gadgets/workshop-shared/api";
import { diffFiles } from "@gadgets/workshop-shared/code-change";
import { MAX_BUFFERED_BLOB_SIZE } from "@gadgets/workshop-shared/gatekeeper";
import type { TestSession } from "../fixtures/gatekeeper-test/src/test-gatekeeper.js";
import {
  ADMIN_USERNAME, settleRestart, startHarness, TEST_GATEKEEPER_BINDING, TEST_GATEKEEPER_DIR,
  TEST_VENDOR_ID, type Harness,
} from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  connect, listConnectedAccounts, nextUsernames, ObserverConfigRecorder, RpcTarget, signUp,
  stubFor, waitFor, WorkpieceRecorder, type ConnectedAccount,
} from "../src/rpc-client.js";

// A second deployment admin, so that records can be told apart by admin.
const AUDITOR_USERNAME = "auditor";
const REASON = "Support ticket 123";
const NOTES = "Meeting notes: ship the admin audit log.\n";
const DRAFT_NOTES = `${NOTES}Draft: review the audit filters.\n`;
const ATTACHMENT = "Agenda for the audit review.\n";
// A text file over MAX_BUFFERED_BLOB_SIZE, which a view answers as a stream. Its first character
// takes two bytes, so that its length in bytes is not its length in characters.
const LARGE_PATH = "large.txt";
const LARGE_TEXT = `é${"a".repeat(MAX_BUFFERED_BLOB_SIZE)}`;
const OBSERVATION_DESCRIPTION =
    "Read the deterministic value exposed by the integration-test gatekeeper.";
const LINK_NOTE = "For the audit reviewers";
// The kind of the test connection's write, which an auto-approval rule names.
const SET_VALUE = { tag: "set-value", label: "Set value" };

// Admin settings and the audit log are deployment-wide, so this file owns its harness and runs
// serially.
const network = new NetworkInterceptor();
const fileScope = new DisposableStack();
let harness: Harness;
let admin: RpcStub<AdminApi>;
let auditor: RpcStub<AdminApi>;

async function adminApiOf(username: string): Promise<RpcStub<AdminApi>> {
  const api = fileScope.use(await signUp(fileScope.use(connect(harness.url)), username));
  const stub = await api.getAdminApi();
  if (stub === null) throw new Error(`The admin API was unavailable to ${username}`);
  return fileScope.use(stub);
}

beforeAll(async () => {
  network.install();
  harness = await startHarness({
    gatekeepers: [{ binding: TEST_GATEKEEPER_BINDING, dir: TEST_GATEKEEPER_DIR }],
    patchWorkshop: config => {
      config.vars = {
        ...config.vars,
        ADMINS: [ADMIN_USERNAME, AUDITOR_USERNAME],
        ADMIN_WORKSPACE_ACCESS_MAX: "full",
      };
    },
  });
  admin = await adminApiOf(ADMIN_USERNAME);
  auditor = await adminApiOf(AUDITOR_USERNAME);
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

/** The code `call` is refused with; throws if it succeeds. */
async function refusalOf(call: PromiseLike<unknown>): Promise<AdminAccessErrorCode | undefined> {
  try {
    await call;
  } catch (error) {
    return getAdminAccessErrorCode(error);
  }
  throw new Error("The call was not refused");
}

/** The code `call` is refused with, or null when it succeeds: for polling until a refusal. */
async function outcomeOf(call: PromiseLike<unknown>): Promise<AdminAccessErrorCode | undefined | null> {
  try {
    await call;
    return null;
  } catch (error) {
    return getAdminAccessErrorCode(error);
  }
}

/** The newest record of the deployment-wide audit log matching `query`. */
async function newestRecord(query: Omit<AdminAuditQuery, "limit"> = {})
    : Promise<AdminAuditRecord | undefined> {
  return (await admin.listAdminAudit({ ...query, limit: 1 })).records[0];
}

/** Every record of the deployment-wide audit log about workspace `id`, newest first. */
async function workspaceRecords(id: string): Promise<AdminAuditRecord[]> {
  return (await admin.listAdminAudit({ workspace: id, limit: 200 })).records;
}

/** An access record, narrowed. */
function accessRecord(record: AdminAuditRecord | undefined): AdminAccessRecord {
  if (record?.kind !== "workspace") throw new Error("Expected a workspace access record");
  return record;
}

const headOf = (workpieces: WorkpieceRecorder, gadgetId: WorkpieceId, after?: string) =>
  waitFor(`a new head for gadget ${gadgetId}`, async () => {
    const summary = workpieces.summaries.get(gadgetId);
    return summary?.type === "gadget" && summary.commitId !== undefined &&
        summary.commitId !== after ? summary.commitId : null;
  });

type Seeded = {
  owner: RpcStub<AuthenticatedApi>;
  ownerName: string;
  ws: RpcStub<Overseer>;
  id: string;
  title: string;
};

/** A fresh owner's workspace, retitled so that its records can be recognised. */
async function newWorkspace(stack: DisposableStack, prefix: string): Promise<Seeded> {
  const [ownerName] = nextUsernames(prefix);
  const owner = stack.use(await signUp(stack.use(connect(harness.url)), ownerName!));
  const ws = stack.use(await owner.newWorkspace());
  const title = `Workspace of ${ownerName}`;
  await ws.setTitle(title);
  return { owner, ownerName: ownerName!, ws, id: (await ws.getMetadata()).id, title };
}

/** The test account of `api`'s user, which the fake vendor mints with no sign-in. */
async function testAccount(api: RpcStub<AuthenticatedApi>): Promise<ConnectedAccount> {
  await api.provisionAmbientAccount(TEST_VENDOR_ID);
  const account = (await listConnectedAccounts(api))
      .find(candidate => candidate.vendorId === TEST_VENDOR_ID);
  if (account === undefined) throw new Error("The test account was not provisioned");
  return account;
}

type Populated = Seeded & {
  chatId: number;
  gadgetId: WorkpieceId;
  /** The test connection's id. */
  connectionId: WorkpieceId;
  /** The gadget's head before anything was committed to it. */
  empty: string;
  /** The gadget's head once the seed chat was accepted: the commit that holds notes.txt. */
  head: string;
  /** A chat whose first message carries one attachment, a.txt, holding ATTACHMENT. */
  attachmentChatId: number;
  /** That attachment's id. */
  attachmentId: string;
  /** A chat whose changes are not accepted: DRAFT_NOTES in notes.txt, and LARGE_PATH added. */
  draftChatId: number;
  /** The test connection's open session: each readValue() records one more observation. */
  session: RpcStub<TestSession>;
};

/**
 * A workspace holding something of each kind a view reads: an observation through a test
 * connection, a chat whose first message is "hello", a chat with an attachment, a gadget whose
 * head holds notes.txt, and a chat whose changes to that gadget are not accepted. The gadget is
 * seeded without a model: a human-only chat submits the file at the empty head, and accepting it
 * commits it.
 */
async function populatedWorkspace(stack: DisposableStack, prefix: string): Promise<Populated> {
  const seeded = await newWorkspace(stack, prefix);
  const { owner, ws } = seeded;
  const account = await testAccount(owner);
  const connection = await ws.newGatekeeper(
      account.id, "https://gadgets-test.example/things/inspected");
  if (connection === null) throw new Error("The test connection was not created");
  stack.use(connection);
  const session = stack.use(await connection.openSession() as RpcStub<TestSession>);
  expect(await session.readValue()).toBe(42);
  const chatId = await ws.newChat("hello", null);

  const workpieces = new WorkpieceRecorder();
  const workpiecesStub = stack.use(stubFor(workpieces));
  stack.use(await ws.subscribeToWorkpieces(workpiecesStub));
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
  const sent = (await ws.getChatHistory(attachmentChatId)).messages
      .find(message => message.type === "message");
  if (sent?.type !== "message" || !sent.attachments?.length) {
    throw new Error("The attachment was not sent");
  }
  // The message's reference holds more than a view lists of an attachment: its path in the
  // chat's scratch worktree.
  expect(sent.attachments[0]).toHaveProperty("workspacePath");
  const attachmentId = sent.attachments[0]!.id;

  const draftChatId = await ws.newChat("Draft", null);
  await ws.submitCodeChange(draftChatId, {
    generation: 0, revision: 0, clientId: "draft", seq: 1,
    pins: [{ gadgetId, baseCommit: head }],
    change: diffFiles(new Map([[gadgetId, new Map([["notes.txt", NOTES]])]]),
        new Map([[gadgetId, new Map([["notes.txt", DRAFT_NOTES], [LARGE_PATH, LARGE_TEXT]])]])),
  });
  return {
    ...seeded, chatId, gadgetId, connectionId: await connection.getId(), empty, head,
    attachmentChatId, attachmentId, draftChatId, session,
  };
}

class ActionsRecorder extends RpcTarget implements ActionsSubscriber {
  readonly entries: ActionLogEntry[] = [];
  entry(record: ActionLogEntry): void { this.entries.push(record); }
  ready(): void {}
}

class PresenceRecorder extends RpcTarget implements PresenceSubscriber {
  readonly seen = new Set<string>();
  init(participants: PresenceParticipant[]): void {
    for (const participant of participants) this.seen.add(participant.user.id);
  }
  add(participant: PresenceParticipant): void { this.seen.add(participant.user.id); }
  remove(_key: string): void {}
}

it("refuses every admin method to a non-admin", async () => {
  using stack = new DisposableStack();
  const { owner, ownerName, ws, id } = await newWorkspace(stack, "nonadmin");
  expect(await owner.getAdminApi()).toBeNull();
  expect(await owner.amIAdmin()).toBe(false);

  // None of these is on AuthenticatedApi: they are reachable only through an AdminApi.
  const loose = owner as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const calls: [string, unknown[]][] = [
    ["listUsers", [{}]],
    ["listWorkspaces", [{}]],
    ["inspectWorkspace", [id, REASON]],
    ["listAdminAudit", [{}]],
    ["getAdminAuditStats", [{}]],
    ["setAdminWorkspaceAccess", ["full"]],
    ["setAdminAuditRetentionDays", [120]],
  ];
  for (const [method, args] of calls) {
    await expect(loose[method]!(...args), method).rejects.toThrow();
  }

  // The bypass is on the Overseer's Durable Object, never on a capability a user holds.
  const looseWs = ws as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  await expect(looseWs.openForAdmin!(ownerName, REASON, "session", {
    via: "api", requested: "full", access: "full", expiresAt: new Date(Date.now() + 60_000),
  })).rejects.toThrow();
});

it("lists users and workspaces from the deployment directory", async () => {
  using stack = new DisposableStack();
  const [ownerName] = nextUsernames("dirowner");
  const owner = stack.use(await signUp(stack.use(connect(harness.url)), ownerName!, "Dir Owner"));

  const listed = await waitFor("the new user to be listed", async () =>
    (await admin.listUsers({ query: ownerName })).users.find(user => user.id === ownerName) ?? null);
  expect(listed).toEqual({
    id: ownerName, name: "Dir Owner", created: expect.any(Date), lastLogin: expect.any(Date),
    isAdmin: false,
  });
  // Asked through the second admin's capability, which lists the same directory.
  for (const username of [ADMIN_USERNAME, AUDITOR_USERNAME]) {
    const user = await waitFor(`${username} to be listed`, async () =>
      (await auditor.listUsers({ query: username })).users.find(entry => entry.id === username)
          ?? null);
    expect(user.isAdmin).toBe(true);
  }

  const first = stack.use(await owner.newWorkspace());
  const second = stack.use(await owner.newWorkspace());
  const firstId = (await first.getMetadata()).id;
  const secondId = (await second.getMetadata()).id;
  const workspaces = await waitFor("both workspaces to be listed", async () => {
    const page = await admin.listWorkspaces({ owner: ownerName });
    return page.workspaces.length === 2 ? page.workspaces : null;
  });
  expect(workspaces.map(workspace => workspace.id)).toEqual([firstId, secondId].toSorted());
  expect(workspaces.find(workspace => workspace.id === firstId)).toMatchObject({
    id: firstId, title: (await first.getMetadata()).title,
    owner: { id: ownerName, name: "Dir Owner" }, created: expect.any(Date),
  });

  await first.setTitle("Renamed for the directory");
  await waitFor("the rename to be listed", async () =>
    (await admin.listWorkspaces({ owner: ownerName })).workspaces
        .some(workspace => workspace.id === firstId &&
            workspace.title === "Renamed for the directory") || null);

  const pageOne = await admin.listWorkspaces({ owner: ownerName, limit: 1 });
  expect(pageOne.workspaces).toHaveLength(1);
  expect(pageOne.nextCursor).toBeDefined();
  const pageTwo = await admin.listWorkspaces(
      { owner: ownerName, limit: 1, cursor: pageOne.nextCursor });
  expect(pageTwo.workspaces).toHaveLength(1);
  expect(pageTwo.nextCursor).toBeUndefined();
  expect([...pageOne.workspaces, ...pageTwo.workspaces].map(workspace => workspace.id))
      .toEqual([firstId, secondId].toSorted());

  // The directory entry is removed inside deleteSelf(), before its critical section, so the
  // deletion is listed once it returns.
  await first.deleteSelf();
  expect((await admin.listWorkspaces({ owner: ownerName })).workspaces
      .map(workspace => workspace.id)).toEqual([secondId]);

  for (const limit of [0, 201, 1.5]) {
    await expect(admin.listUsers({ limit }), `listUsers limit ${limit}`).rejects.toThrow();
    await expect(admin.listWorkspaces({ limit }), `listWorkspaces limit ${limit}`)
        .rejects.toThrow();
  }
  await expect(admin.listUsers({ query: "two\nlines" })).rejects.toThrow();
  await expect(admin.listWorkspaces({ query: "two\nlines" })).rejects.toThrow();
});

it("records an inspection apart from the workspace, where its members never see it", async () => {
  using stack = new DisposableStack();
  const { ws, id, title, session, ownerName } = await populatedWorkspace(stack, "inspected");

  const actions = new ActionsRecorder();
  const presence = new PresenceRecorder();
  const actionsStub = stack.use(stubFor(actions));
  const presenceStub = stack.use(stubFor(presence));
  stack.use(await ws.subscribeToActions(actionsStub));
  stack.use(await ws.subscribeToPresence(presenceStub));
  const actionsBefore = await ws.listActions();

  {
    using view = await admin.inspectWorkspace(id, REASON);
    const description = await view.describe();
    expect(description).toMatchObject({ id, title, access: "metadata" });
    await view.listChats();
    await view.listActions();
    // The roster the members see: the owner's session is on it, and the view never is.
    const present = (await view.getDiagnostics()).present.map(participant => participant.user.id);
    expect(present).toContain(ownerName);
    expect(present).not.toContain(ADMIN_USERNAME);

    const logged = await workspaceRecords(id);
    expect(logged.map(record => record.method))
        .toEqual(["getDiagnostics", "listActions", "listChats", "describe", "inspectWorkspace"]);
    const sessionId = logged[0]!.sessionId;
    for (const record of logged) {
      expect(record).toMatchObject({
        kind: "workspace", workspaceId: id, workspaceOwner: ownerName, workspaceTitle: title,
        admin: ADMIN_USERNAME, reason: REASON, sessionId, via: "api", requested: "metadata",
        access: "metadata", exposed: "metadata",
      });
      expect(accessRecord(record).refused).toBeUndefined();
    }

    const pages: AdminAuditRecord[][] = [];
    let cursor: string | undefined;
    do {
      const page = await admin.listAdminAudit({ workspace: id, limit: 2, cursor });
      pages.push(page.records);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    expect(pages.map(page => page.length)).toEqual([2, 2, 1]);
    expect(pages.flat()).toEqual(logged);

    expect((await admin.listAdminAudit({ workspace: id, admin: ADMIN_USERNAME })).records)
        .toEqual(logged);
    expect((await admin.listAdminAudit({ workspace: id, admin: AUDITOR_USERNAME })).records)
        .toEqual([]);
    const since = logged[2]!.at;
    expect((await admin.listAdminAudit({ workspace: id, since })).records)
        .toEqual(logged.filter(record => record.at.getTime() >= since.getTime()));

    for (const reason of ["", "   ", "x".repeat(501)]) {
      await expect(admin.inspectWorkspace(id, reason), `reason of ${reason.length}`)
          .rejects.toThrow();
    }
    expect(await workspaceRecords(id)).toEqual(logged);
  }

  // A view that restarted the workspace would end the owner's sessions here.
  await settleRestart();
  expect(await ws.listActions()).toEqual(actionsBefore);
  expect(actions.entries).toEqual([]);
  expect(presence.seen.size).toBeGreaterThan(0);
  expect(presence.seen).not.toContain(ADMIN_USERNAME);

  // The subscription delivers live entries only, so one more observation reaching it shows that it
  // was live throughout the view's calls, and that their absence above is not a silent one.
  expect(await session.readValue()).toBe(42);
  await waitFor("the new observation to reach the subscriber", async () =>
    actions.entries.length > 0 || null);
  expect(actions.entries).toEqual([expect.objectContaining({
    type: "observation", gatekeeperId: expect.any(Number),
    description: expect.objectContaining({ description: OBSERVATION_DESCRIPTION }),
  })]);
});

it("withholds content below full access, and turns inspection off", async () => {
  using stack = new DisposableStack();
  const { id, title, chatId, gadgetId } = await populatedWorkspace(stack, "modes");

  const settings = await admin.getSettings();
  expect(settings.adminWorkspaceAccess)
      .toEqual({ effective: "metadata", chosen: "metadata", max: "full" });
  expect(settings.adminAuditRetentionDays).toEqual({ effective: 90, chosen: 90, min: 90 });

  try {
    using metadataView = await admin.inspectWorkspace(id, REASON);
    expect(await refusalOf(metadataView.getChat(chatId)))
        .toBe(ADMIN_ACCESS_ERROR_CODES.contentWithheld);
    expect(await refusalOf(metadataView.readFile(gadgetId, "notes.txt")))
        .toBe(ADMIN_ACCESS_ERROR_CODES.contentWithheld);
    // Refused by the level after being recorded, so each refusal is in the log.
    const [readRefusal, chatRefusal] = (await workspaceRecords(id)).map(accessRecord);
    expect(readRefusal).toMatchObject({
      method: "readFile", args: { gadgetId, path: "notes.txt" }, requested: "metadata",
      access: "metadata", exposed: "metadata", refused: ADMIN_ACCESS_ERROR_CODES.contentWithheld,
    });
    expect(chatRefusal).toMatchObject({
      method: "getChat", args: { chatId }, requested: "metadata", access: "metadata",
      exposed: "metadata", refused: ADMIN_ACCESS_ERROR_CODES.contentWithheld,
    });

    const withheld = (await metadataView.listActions()).entries
        .find(entry => entry.type === "observation");
    expect(withheld?.description.title).toBe("Read the test value");
    expect(withheld?.description.description).toBe("");
    expect(withheld?.description).not.toHaveProperty("fields");
    const gadget = (await metadataView.describe()).workpieces
        .find(workpiece => workpiece.id === gadgetId);
    expect(gadget).toBeDefined();
    expect(gadget).not.toHaveProperty("upstream");
    expect(await metadataView.listFiles(gadgetId)).toEqual([{ name: "notes.txt", kind: "file" }]);

    await admin.setAdminWorkspaceAccess("full");
    using fullView = await admin.inspectWorkspace(id, REASON, { access: "full" });
    expect((await fullView.getChat(chatId)).messages)
        .toContainEqual(expect.objectContaining({ type: "message", message: "hello" }));
    expect(await fullView.readFile(gadgetId, "notes.txt")).toEqual({ kind: "text", text: NOTES });
    expect((await fullView.listActions()).entries.find(entry => entry.type === "observation")
        ?.description.description).toBe(OBSERVATION_DESCRIPTION);
    expect((await fullView.describe()).workpieces.find(workpiece => workpiece.id === gadgetId))
        .toMatchObject({ upstream: {} });

    // Lowering the setting reaches a live view.
    await admin.setAdminWorkspaceAccess("metadata");
    await waitFor("the full view to be lowered", async () =>
      await outcomeOf(fullView.getChat(chatId)) === ADMIN_ACCESS_ERROR_CODES.contentWithheld
          || null);

    await admin.setAdminWorkspaceAccess("off");
    const reason = "Off-mode check";
    expect(await refusalOf(admin.inspectWorkspace(id, reason)))
        .toBe(ADMIN_ACCESS_ERROR_CODES.accessOff);
    expect(await newestRecord({ kind: "workspace" })).toMatchObject({
      kind: "workspace", workspaceId: id, workspaceTitle: title, method: "inspectWorkspace",
      admin: ADMIN_USERNAME, reason, access: "off", refused: ADMIN_ACCESS_ERROR_CODES.accessOff,
    });
    await waitFor("the live view to be turned off", async () =>
      await outcomeOf(metadataView.listChats()) === ADMIN_ACCESS_ERROR_CODES.accessOff || null);
    expect(await newestRecord({ workspace: id })).toMatchObject({
      method: "listChats", access: "off", refused: ADMIN_ACCESS_ERROR_CODES.accessOff,
      reason: REASON,
    });

    await admin.setAdminWorkspaceAccess("metadata");

    await expect(admin.setAdminWorkspaceAccess("everything" as AdminWorkspaceAccess))
        .rejects.toThrow();
    await expect(admin.setAdminAuditRetentionDays(89)).rejects.toThrow();
    await expect(admin.setAdminAuditRetentionDays(3651)).rejects.toThrow();
  } finally {
    await admin.setAdminWorkspaceAccess("metadata");
    await admin.setAdminAuditRetentionDays(90);
  }
});

it("withholds attachments, a commit's or a draft's files and commit messages below full access",
    async () => {
  using stack = new DisposableStack();
  const { id, gadgetId, head, attachmentChatId, attachmentId, draftChatId } =
      await populatedWorkspace(stack, "withheld");

  try {
    using metadataView = await admin.inspectWorkspace(id, REASON);
    // Each reads only content, so the level refuses it once it is recorded.
    const refusals: [string, Record<string, string | number>, () => PromiseLike<unknown>][] = [
      ["readChatAttachment", { chatId: attachmentChatId, id: attachmentId },
        () => metadataView.readChatAttachment(attachmentChatId, attachmentId)],
      ["readFileAtCommit", { commitId: head, path: "notes.txt" },
        () => metadataView.readFileAtCommit(head, "notes.txt")],
      ["readPendingFile", { chatId: draftChatId, gadgetId, path: "notes.txt" },
        () => metadataView.readPendingFile(draftChatId, gadgetId, "notes.txt")],
    ];
    for (const [method, args, call] of refusals) {
      expect(await refusalOf(call()), method).toBe(ADMIN_ACCESS_ERROR_CODES.contentWithheld);
      expect(await newestRecord({ workspace: id }), method).toMatchObject({
        method, args, requested: "metadata", access: "metadata", exposed: "metadata",
        refused: ADMIN_ACCESS_ERROR_CODES.contentWithheld,
      });
    }

    // A commit's message describes its change, so the history arrives without it. The record
    // holds no depth, since the call gave none.
    const withheld = await metadataView.getCommitLog(head);
    expect(withheld[0]).toMatchObject({ oid: head, message: "" });
    const withheldRecord = accessRecord(await newestRecord({ workspace: id }));
    expect(withheldRecord).toMatchObject({
      method: "getCommitLog", access: "metadata", exposed: "metadata",
    });
    expect(withheldRecord.args).toEqual({ fromCommit: head });
    expect(withheldRecord.refused).toBeUndefined();

    // A depth outside the range is refused before anything is recorded.
    await expect(metadataView.getCommitLog(head, 0)).rejects.toThrow(TypeError);
    expect(await newestRecord({ workspace: id })).toEqual(withheldRecord);

    await admin.setAdminWorkspaceAccess("full");
    using fullView = await admin.inspectWorkspace(id, REASON, { access: "full" });
    const full = await fullView.getCommitLog(head);
    expect(full[0]!.message).not.toBe("");
    expect(await newestRecord({ workspace: id })).toMatchObject({
      method: "getCommitLog", args: { fromCommit: head }, access: "full", exposed: "content",
    });
    // The message is all that the lower level withheld.
    expect(withheld).toEqual(full.map(commit => ({ ...commit, message: "" })));
  } finally {
    await admin.setAdminWorkspaceAccess("metadata");
  }
});

it("opens a view at the lower of the level asked for and the deployment's", async () => {
  using stack = new DisposableStack();
  const { id, chatId } = await populatedWorkspace(stack, "requested");
  const heldReason = "Asked for full, held to metadata";
  const defaultReason = "Asked for nothing";
  const fullReason = "Asked for full, granted it";

  // The setting is "metadata", so asking for "full" opens the view at "metadata", unrefused.
  using held = await admin.inspectWorkspace(id, heldReason, { access: "full" });
  expect((await held.describe()).access).toBe("metadata");
  expect(await refusalOf(held.getChat(chatId))).toBe(ADMIN_ACCESS_ERROR_CODES.contentWithheld);

  try {
    await admin.setAdminWorkspaceAccess("full");
    // A view keeps the level it was minted at: raising the setting does not reach it.
    expect(await refusalOf(held.getChat(chatId))).toBe(ADMIN_ACCESS_ERROR_CODES.contentWithheld);
    expect((await held.describe()).access).toBe("metadata");

    // An open that asks for nothing gets "metadata", whatever the deployment allows.
    {
      using view = await admin.inspectWorkspace(id, defaultReason);
      expect((await view.describe()).access).toBe("metadata");
      expect(await refusalOf(view.getChat(chatId))).toBe(ADMIN_ACCESS_ERROR_CODES.contentWithheld);
    }

    {
      using view = await admin.inspectWorkspace(id, fullReason, { access: "full" });
      expect((await view.describe()).access).toBe("full");
      expect((await view.getChat(chatId)).messages)
          .toContainEqual(expect.objectContaining({ type: "message", message: "hello" }));
      expect(await newestRecord({ workspace: id })).toMatchObject({
        method: "getChat", reason: fullReason, requested: "full", access: "full",
        exposed: "content",
      });
    }

    const records = (await workspaceRecords(id)).map(accessRecord);
    const heldRecords = records.filter(record => record.reason === heldReason);
    expect(heldRecords.map(record => record.method).toSorted())
        .toEqual(["describe", "describe", "getChat", "getChat", "inspectWorkspace"]);
    for (const record of heldRecords) {
      expect(record).toMatchObject({ requested: "full", access: "metadata", exposed: "metadata" });
    }
    const defaultRecords = records.filter(record => record.reason === defaultReason);
    expect(defaultRecords).toHaveLength(3);
    for (const record of defaultRecords) {
      expect(record).toMatchObject({ requested: "metadata", access: "metadata" });
    }

    // A level that is not a view level is refused before anything is recorded. The server's
    // validator throws, and capnweb delivers the throw as a rejection that keeps its TypeError.
    const newest = await newestRecord({ workspace: id });
    await expect(admin.inspectWorkspace(id, REASON, { access: "off" as AdminViewAccess }))
        .rejects.toThrow(TypeError);
    expect(await newestRecord({ workspace: id })).toEqual(newest);
  } finally {
    await admin.setAdminWorkspaceAccess("metadata");
  }
});

it("records what each call returned, and lists content reads apart", async () => {
  using stack = new DisposableStack();
  const {
    ws, ownerName, id, chatId, gadgetId, connectionId, empty, head, attachmentChatId, attachmentId,
    draftChatId,
  } = await populatedWorkspace(stack, "exposed");
  // A share link and an auto-approval rule for the two listings below to show. No write is
  // pending, so the rule applies nothing.
  const link = await ws.createShareLink("workspace", LINK_NOTE);
  await ws.setAutoApprovedActionKind(connectionId, SET_VALUE);

  try {
    await admin.setAdminWorkspaceAccess("full");
    using view = await admin.inspectWorkspace(id, REASON, { access: "full" });
    // Each call that checks its answer does so before its record is read.
    const calls: [string, () => PromiseLike<unknown>][] = [
      ["getChat", () => view.getChat(chatId)],
      // The answer is absent, so it holds no content.
      ["readFile", () => view.readFile(gadgetId, "missing.txt")],
      ["readFile", () => view.readFile(gadgetId, "notes.txt")],
      ["listFiles", () => view.listFiles(gadgetId)],
      // The workspace queues no steer.
      ["listChats", () => view.listChats()],
      // The observation's description.
      ["listActions", () => view.listActions()],
      // The test connection binds no hooks.
      ["listGatekeepers", () => view.listGatekeepers()],
      // The gadget was built from scratch, so its upstream {} names no blueprint.
      ["describe", () => view.describe()],
      ["getDiagnostics", () => view.getDiagnostics()],
      // No call is queued for the chat's agent, so no summary of a call's arguments is kept.
      ["getChatState", () => view.getChatState(chatId)],
      // An attachment's name, type, size and hash show at every level, as a title does. The
      // message's own reference also holds the attachment's path in the chat's scratch worktree,
      // which the listing leaves out.
      ["listChatAttachments", async () => {
        const attachments = await view.listChatAttachments(attachmentChatId);
        expect(attachments).toEqual([{
          id: attachmentId, oid: expect.any(String), mimeType: "text/plain", name: "a.txt",
          size: new TextEncoder().encode(ATTACHMENT).byteLength, sequence: expect.any(Number),
        }]);
        expect(Object.keys(attachments[0]!).toSorted())
            .toEqual(["id", "mimeType", "name", "oid", "sequence", "size"]);
      }],
      // The attachment's bytes.
      ["readChatAttachment", async () => expect(new TextDecoder().decode(
          await view.readChatAttachment(attachmentChatId, attachmentId))).toBe(ATTACHMENT)],
      // The message of the commit that accepted the seed chat.
      ["getCommitLog", () => view.getCommitLog(head)],
      // Paths are names. The commit's tree, which the draft's added file is not in.
      ["listFilesAtCommit", async () =>
        expect(await view.listFilesAtCommit(head)).toEqual([{ name: "notes.txt", kind: "file" }])],
      // The committed text, not the draft's.
      ["readFileAtCommit", async () =>
        expect(await view.readFileAtCommit(head, "notes.txt"))
            .toEqual({ kind: "text", text: NOTES })],
      // The answer is absent, so it holds no content.
      ["readFileAtCommit", () => view.readFileAtCommit(head, "missing.txt")],
      // The paths that differ, not the difference: that takes two file reads.
      ["listChangedPaths", async () =>
        expect(await view.listChangedPaths(empty, head)).toEqual(["notes.txt"])],
      // The paths the draft adds, modifies and removes, not what it holds at them.
      ["listPendingChanges", async () =>
        expect(await view.listPendingChanges(draftChatId)).toEqual([{
          gadgetId, baseCommit: head, mergedCommit: head,
          added: [LARGE_PATH], modified: ["notes.txt"], removed: [],
        }])],
      // The draft's text.
      ["readPendingFile", async () =>
        expect(await view.readPendingFile(draftChatId, gadgetId, "notes.txt"))
            .toEqual({ kind: "text", text: DRAFT_NOTES })],
      // A text over MAX_BUFFERED_BLOB_SIZE arrives as a stream of its UTF-8 bytes, recorded as any
      // found file is. The stream is read to its end: a caller consumes every stream it receives.
      ["readPendingFile", async () => {
        const file = await view.readPendingFile(draftChatId, gadgetId, LARGE_PATH);
        if (file.kind !== "stream") throw new Error(`Expected a stream, not ${file.kind}`);
        const text = await new Response(file.content).text();
        expect(file.byteLength).toBe(new TextEncoder().encode(LARGE_TEXT).byteLength);
        expect(file.byteLength).toBeGreaterThan(LARGE_TEXT.length);
        // Compared outside the matcher, whose failure would print both texts whole.
        expect(text === LARGE_TEXT).toBe(true);
      }],
      // A holder's profile and the connection, vendor and account ids of their choices are names,
      // shown at every level. The list is empty: no collaborator has opened the workspace.
      ["listObservers", async () => expect(await view.listObservers()).toEqual([])],
      // The test connection's vendor, title and URL, which listGatekeepers() shows too.
      ["listObserverRequirements", () => view.listObserverRequirements("workspace")],
      // A link's id, note, creator and role are names, as a title is. Its key is in no answer.
      ["listShareLinks", async () => {
        const links = await view.listShareLinks();
        expect(links).toEqual([{
          linkId: link.linkId, note: LINK_NOTE, created: expect.any(Date),
          createdBy: expect.objectContaining({ type: "user", id: ownerName }), role: "build",
        }]);
        expect(JSON.stringify(links)).not.toContain(link.key);
      }],
      // A rule's connection, kind of action and enabler are names too.
      ["listAutoApprovals", async () =>
        expect(await view.listAutoApprovals()).toEqual([{
          gatekeeperId: connectionId, actionKind: SET_VALUE,
          enabledBy: expect.objectContaining({ type: "user", id: ownerName }),
        }])],
      // The workspace publishes none.
      ["listBlueprints", () => view.listBlueprints()],
    ];
    const recorded: { method: string; exposed: string }[] = [];
    for (const [method, call] of calls) {
      await call();
      const record = accessRecord(await newestRecord({ workspace: id }));
      expect(record).toMatchObject({ method, requested: "full", access: "full" });
      expect(record.refused).toBeUndefined();
      recorded.push({ method, exposed: record.exposed });
    }
    expect(recorded).toEqual([
      { method: "getChat", exposed: "content" },
      { method: "readFile", exposed: "metadata" },
      { method: "readFile", exposed: "content" },
      { method: "listFiles", exposed: "metadata" },
      { method: "listChats", exposed: "metadata" },
      { method: "listActions", exposed: "content" },
      { method: "listGatekeepers", exposed: "metadata" },
      { method: "describe", exposed: "metadata" },
      { method: "getDiagnostics", exposed: "metadata" },
      { method: "getChatState", exposed: "metadata" },
      { method: "listChatAttachments", exposed: "metadata" },
      { method: "readChatAttachment", exposed: "content" },
      { method: "getCommitLog", exposed: "content" },
      { method: "listFilesAtCommit", exposed: "metadata" },
      { method: "readFileAtCommit", exposed: "content" },
      { method: "readFileAtCommit", exposed: "metadata" },
      { method: "listChangedPaths", exposed: "metadata" },
      { method: "listPendingChanges", exposed: "metadata" },
      { method: "readPendingFile", exposed: "content" },
      { method: "readPendingFile", exposed: "content" },
      { method: "listObservers", exposed: "metadata" },
      { method: "listObserverRequirements", exposed: "metadata" },
      { method: "listShareLinks", exposed: "metadata" },
      { method: "listAutoApprovals", exposed: "metadata" },
      { method: "listBlueprints", exposed: "metadata" },
    ]);

    const logged = (await workspaceRecords(id)).map(accessRecord);
    expect(logged.at(-1)).toMatchObject({ method: "inspectWorkspace", exposed: "metadata" });
    const contentReads = (await admin.listAdminAudit({ workspace: id, exposed: "content" }))
        .records;
    expect(contentReads.map(record => accessRecord(record).method)).toEqual([
      "readPendingFile", "readPendingFile", "readFileAtCommit", "getCommitLog",
      "readChatAttachment", "listActions", "readFile", "getChat",
    ]);
    expect(contentReads).toEqual(logged.filter(record => record.exposed === "content"));
    const metadataReads = (await admin.listAdminAudit({ workspace: id, exposed: "metadata" }))
        .records;
    // The open, and every call above that answered with no content.
    expect(metadataReads).toHaveLength(18);
    expect(metadataReads).toEqual(logged.filter(record => record.exposed === "metadata"));
    expect((await admin.listAdminAudit({ kind: "setting", exposed: "content" })).records)
        .toEqual([]);
  } finally {
    await admin.setAdminWorkspaceAccess("metadata");
  }
});

it("names who made each connection, and no one for an ambient one", async () => {
  using stack = new DisposableStack();
  const [ownerName] = nextUsernames("creator");
  const owner = stack.use(await signUp(stack.use(connect(harness.url)), ownerName!));
  // The test account is a singleton, which the owner's workspace takes as an ambient connection
  // when it is opened, so the account comes first.
  const account = await testAccount(owner);
  const ws = stack.use(await owner.newWorkspace());
  const id = (await ws.getMetadata()).id;
  const connection = await ws.newGatekeeper(
      account.id, "https://gadgets-test.example/things/created");
  if (connection === null) throw new Error("The test connection was not created");
  stack.use(connection);

  using view = await admin.inspectWorkspace(id, REASON);
  const gatekeepers = await waitFor("the ambient connection to be listed", async () => {
    const listed = await view.listGatekeepers();
    if (listed.some(gatekeeper => gatekeeper.creationSpec?.type === "ambient")) return listed;
    // Each open provides what is missing.
    (await owner.openWorkspace(id))[Symbol.dispose]();
    return null;
  });
  expect(await newestRecord({ workspace: id })).toMatchObject({
    method: "listGatekeepers", access: "metadata", exposed: "metadata",
  });

  const made = gatekeepers.find(gatekeeper => gatekeeper.creationSpec?.type === "gatekeeper");
  expect(made).toMatchObject({
    id: await connection.getId(), createdBy: { type: "user", id: ownerName },
  });
  // No person creates an ambient connection.
  const ambient = gatekeepers.find(gatekeeper => gatekeeper.creationSpec?.type === "ambient");
  expect(ambient).toMatchObject({ creationSpec: { type: "ambient", vendorId: TEST_VENDOR_ID } });
  expect(ambient?.createdBy).toBeUndefined();
});

it("lists who holds an observer record, with what was verified for each", async () => {
  using stack = new DisposableStack();
  const [ownerName, admittedName, refusedName] = nextUsernames("observed", "admitted", "refused");
  const signedUp = async (username: string) =>
    stack.use(await signUp(stack.use(connect(harness.url)), username));
  const owner = await signedUp(ownerName!);
  const admitted = await signedUp(admittedName!);
  const refused = await signedUp(refusedName!);
  // Before the workspace exists, so that its ambient connection is there from its first open: one
  // that appeared during a collaborator's open would restart the workspace under them.
  const account = await testAccount(owner);
  const admittedAccount = await testAccount(admitted);

  const ws = stack.use(await owner.newWorkspace());
  const id = (await ws.getMetadata()).id;
  const resourceUrl = "https://gadgets-test.example/things/observed";
  const connection = await ws.newGatekeeper(account.id, resourceUrl);
  if (connection === null) throw new Error("The test connection was not created");
  stack.use(connection);
  const gatekeeperId = await connection.getId();
  const profileOf = async (username: string) => {
    const added = await ws.addCollaborator(username, "workspace");
    if (added === null) throw new Error(`Failed to share the workspace with ${username}`);
    return added.profile;
  };
  const admittedProfile = await profileOf(admittedName!);
  const refusedProfile = await profileOf(refusedName!);

  // The first member answers the one question, about the connection, with an account of their
  // own, and is admitted.
  const answers = new ObserverConfigRecorder().alwaysChoose(admittedAccount.id, 1);
  stack.use(await admitted.openWorkspace(id, undefined, stack.use(stubFor(answers))));
  expect(answers.calls).toEqual([[expect.objectContaining({ gatekeeperId })]]);
  // The second has no test account and no way to be asked for one, so their open is refused.
  await expect(refused.openWorkspace(id)).rejects.toThrow("no configuration channel was provided");

  using view = await admin.inspectWorkspace(id, REASON);
  const metadataRead = async (method: string) =>
    expect(await newestRecord({ workspace: id }), method).toMatchObject({
      method, requested: "metadata", access: "metadata", exposed: "metadata",
    });

  // A record is reserved before anything is verified and outlives a refused open, so the listing
  // holds both members: who holds a record, not who was admitted.
  const observers = await view.listObservers();
  await metadataRead("listObservers");
  expect(observers).toHaveLength(2);
  // The keys as they arrived, where a stored record's other fields would have travelled.
  for (const observer of observers) {
    expect(Object.keys(observer).toSorted()).toEqual(["accountChoices", "profile"]);
    for (const choice of observer.accountChoices) {
      expect(Object.keys(choice).toSorted()).toEqual(["accountId", "gatekeeperId", "vendorId"]);
    }
  }
  expect(JSON.stringify(observers)).not.toContain("observerId");

  const verified = observers.find(observer => observer.profile.id === admittedProfile.id);
  expect(verified?.profile).toEqual(admittedProfile);
  expect(verified?.accountChoices).toContainEqual({
    gatekeeperId, accountId: admittedAccount.id, vendorId: TEST_VENDOR_ID.toLowerCase(),
  });
  // Their account is also taken, unasked, for the workspace's ambient connection.
  expect(new Set(verified?.accountChoices.map(choice => choice.accountId)))
      .toEqual(new Set([admittedAccount.id]));
  expect(observers.find(observer => observer.profile.id === refusedProfile.id))
      .toEqual({ profile: refusedProfile, accountChoices: [] });

  expect(await view.listObserverRequirements("workspace")).toContainEqual(
      expect.objectContaining({ gatekeeperId, vendorId: TEST_VENDOR_ID, resourceUrl }));
  await metadataRead("listObserverRequirements");
  expect((await view.getDiagnostics()).observers).toBe(2);
  await metadataRead("getDiagnostics");
});

it("refuses a workspace that does not exist without creating it", async () => {
  using stack = new DisposableStack();
  const { owner, ownerName, ws, id } = await newWorkspace(stack, "deleted");

  // The Overseer keeps its records in typed storage over the KV API, whose table _cf_KV an
  // object's first write creates and deleteAll() drops, so whether the table exists says whether
  // anything has been written since the deletion. Miniflare's own tables, which any visit creates,
  // are left out, and _cf_KV itself cannot be read (SQLITE_AUTH), hence sqlite_master.
  // listDurableObjectIds() cannot tell: it lists every object with a storage file, which any
  // visit creates and a deletion leaves.
  const tables = async () => {
    const storage = await harness.server.getWorker("workshop-backend")
        .getDurableObjectStorage("OverseerDurableObject", { id });
    const rows = await storage.exec<{ name: string }>(`SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT GLOB '__miniflare*' ORDER BY name`);
    return rows.map(row => row.name);
  };
  expect(await tables()).toContain("_cf_KV");

  await ws.deleteSelf();
  const deletedAt = new Date();
  await settleRestart();
  const before = await tables();
  expect(before).not.toContain("_cf_KV");

  for (let attempt = 0; attempt < 2; attempt++) {
    expect(await refusalOf(admin.inspectWorkspace(id, REASON)))
        .toBe(ADMIN_ACCESS_ERROR_CODES.workspaceNotFound);
  }
  expect(await tables()).toEqual(before);
  expect((await admin.listWorkspaces({ owner: ownerName })).workspaces
      .map(workspace => workspace.id)).not.toContain(id);
  expect((await admin.listAdminAudit({ workspace: id, since: deletedAt })).records).toEqual([]);

  // open()'s first-open path refuses before it writes, too.
  let openError: unknown;
  try {
    stack.use(await owner.openWorkspace(id));
  } catch (error) {
    openError = error;
  }
  expect(getOpenWorkspaceErrorCode(openError)).toBe(OPEN_WORKSPACE_ERROR_CODES.workspaceNotFound);
  expect(await tables()).toEqual(before);

  expect(await refusalOf(admin.inspectWorkspace("not-a-workspace-id", REASON)))
      .toBe(ADMIN_ACCESS_ERROR_CODES.workspaceNotFound);
});

it("fails a view call whose audit record cannot be written, returning nothing", async () => {
  using stack = new DisposableStack();
  const { id, chatId } = await populatedWorkspace(stack, "unaudited");
  // Addresses the deployment-wide log, which is always getByName("").
  const storage = await harness.server.getWorker("workshop-backend")
      .getDurableObjectStorage("AdminAuditDurableObject", { name: "" });

  try {
    await admin.setAdminWorkspaceAccess("full");
    using view = await admin.inspectWorkspace(id, REASON, { access: "full" });
    const logged = await workspaceRecords(id);
    expect(logged).toHaveLength(1);

    // Dropped before the setting is restored: no setting change can be recorded while it stands.
    try {
      await storage.exec(`CREATE TRIGGER admin_audit_unavailable BEFORE INSERT ON admin_audit
          BEGIN SELECT RAISE(ABORT, 'admin audit unavailable'); END`);
      await expect(view.listChats()).rejects.toThrow();
      await expect(view.getChat(chatId)).rejects.toThrow();
      await expect(admin.inspectWorkspace(id, REASON)).rejects.toThrow();
    } finally {
      await storage.exec("DROP TRIGGER IF EXISTS admin_audit_unavailable");
    }
    expect(await workspaceRecords(id)).toEqual(logged);
  } finally {
    await admin.setAdminWorkspaceAccess("metadata");
  }
});

it("stops a view once it expires, recording nothing more", async () => {
  using stack = new DisposableStack();
  const { id } = await newWorkspace(stack, "expiring");

  // Long enough for the open's hops (two config reads, the record) and describe's own on a slow
  // runner, where a one-second view could expire before describe returns.
  const lifetimeMs = 5_000;
  const before = Date.now();
  using view = await admin.inspectWorkspace(id, REASON, { lifetimeSeconds: lifetimeMs / 1000 });
  const after = Date.now();
  const { expiresAt } = await view.describe();
  expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + lifetimeMs - 1_000);
  expect(expiresAt.getTime()).toBeLessThanOrEqual(after + lifetimeMs + 1_000);

  const newest = await newestRecord({ workspace: id });
  expect(newest).toMatchObject({ method: "describe" });
  await waitFor("the view to expire", async () =>
    Date.now() > expiresAt.getTime() + 1_000 || null, lifetimeMs * 3);
  expect(await refusalOf(view.listChats())).toBe(ADMIN_ACCESS_ERROR_CODES.viewExpired);
  expect(await newestRecord({ workspace: id })).toEqual(newest);

  for (const lifetimeSeconds of [0, 3601, 1.5]) {
    await expect(admin.inspectWorkspace(id, REASON, { lifetimeSeconds }),
        `lifetime ${lifetimeSeconds}`).rejects.toThrow();
  }
  expect(await newestRecord({ workspace: id })).toEqual(newest);
});

it("bounds long names and titles in the directory and the audit log", async () => {
  using stack = new DisposableStack();
  const { owner, ownerName, ws, id } = await newWorkspace(stack, "longtext");
  const name = "N".repeat(5_000);
  const title = "T".repeat(5_000);
  await owner.setOwnDisplayName(name);
  await ws.setTitle(title);

  await waitFor("the long name to be listed", async () =>
    (await admin.listUsers({ query: ownerName })).users.some(user =>
      user.id === ownerName && user.name === name.slice(0, MAX_DIRECTORY_TEXT_LENGTH)) || null);
  const workspace = await waitFor("the long title to be listed", async () =>
    (await admin.listWorkspaces({ owner: ownerName })).workspaces.find(entry =>
      entry.id === id && entry.title === title.slice(0, MAX_DIRECTORY_TEXT_LENGTH) &&
          entry.owner.name === name.slice(0, MAX_DIRECTORY_TEXT_LENGTH)) ?? null);
  expect(workspace.owner.id).toBe(ownerName);

  using view = await admin.inspectWorkspace(id, REASON);
  expect((await view.describe()).title).toBe(title);
  const cut = `${title.slice(0, MAX_ADMIN_AUDIT_ARG_LENGTH - 1)}…`;
  const logged = await workspaceRecords(id);
  for (const method of ["inspectWorkspace", "describe"]) {
    expect(logged.find(record => record.method === method)).toMatchObject({ workspaceTitle: cut });
  }
});
