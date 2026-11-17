import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  ADMIN_ACCESS_ERROR_CODES, getAdminAccessErrorCode, getOpenWorkspaceErrorCode,
  MAX_ADMIN_AUDIT_ARG_LENGTH, MAX_DIRECTORY_TEXT_LENGTH, OPEN_WORKSPACE_ERROR_CODES,
  type ActionLogEntry, type ActionsSubscriber, type AdminAccessErrorCode, type AdminAccessRecord,
  type AdminApi, type AdminAuditQuery, type AdminAuditRecord, type AdminWorkspaceAccess,
  type AdminWorkspaceView, type AiChatAuthorInfo, type AiChatSubscriber, type AuthenticatedApi,
  type Overseer, type PresenceParticipant, type PresenceSubscriber, type WorkpieceId,
} from "@gadgets/workshop-shared/api";
import { applyCodeChange, diffFiles, type CodeChange } from "@gadgets/workshop-shared/code-change";
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
// A chat message whose text is in no title: the chat it is sent to is named by an earlier message.
const CHAT_MESSAGE = "The rollout is paused until the audit review signs off.";
const NOTES = "Meeting notes: ship the admin audit log.\n";
const DRAFT_LINE = "Draft: review the audit filters.\n";
const DRAFT_NOTES = `${NOTES}${DRAFT_LINE}`;
const ATTACHMENT = "Agenda for the audit review.\n";
// A text file over MAX_BUFFERED_BLOB_SIZE, which a draft's listing names like any other file.
const LARGE_PATH = "large.txt";
const LARGE_TEXT = "a".repeat(MAX_BUFFERED_BLOB_SIZE + 1);
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
      config.vars = { ...config.vars, ADMINS: [ADMIN_USERNAME, AUDITOR_USERNAME] };
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
  /** A chat holding two messages: "hello", then CHAT_MESSAGE. */
  chatId: number;
  /** The owner's own listing of the workspace's gadgets and worktrees. */
  workpieces: WorkpieceRecorder;
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
 * connection, a chat whose messages are "hello" and CHAT_MESSAGE, a chat with an attachment, a
 * gadget whose head holds notes.txt, and a chat whose changes to that gadget are not accepted. The
 * gadget is seeded without a model: a human-only chat submits the file at the empty head, and
 * accepting it commits it.
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
  await ws.sendChatMessage(chatId, CHAT_MESSAGE, null);

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
    ...seeded, chatId, workpieces, gadgetId, connectionId: await connection.getId(), empty, head,
    attachmentChatId, attachmentId, draftChatId, session,
  };
}

/** One call of each of the seventeen view methods, in the interface's order, with its answer. */
async function everyAnswer(view: RpcStub<AdminWorkspaceView>, populated: Populated) {
  const { chatId, gadgetId, empty, head, attachmentChatId, draftChatId } = populated;
  return {
    describe: await view.describe(),
    listChats: await view.listChats(),
    getChatState: await view.getChatState(chatId),
    listChatAttachments: await view.listChatAttachments(attachmentChatId),
    listActions: await view.listActions(),
    listFiles: await view.listFiles(gadgetId),
    getCommitLog: await view.getCommitLog(head),
    listFilesAtCommit: await view.listFilesAtCommit(head),
    listChangedPaths: await view.listChangedPaths(empty, head),
    listPendingChanges: await view.listPendingChanges(draftChatId),
    listGatekeepers: await view.listGatekeepers(),
    listObservers: await view.listObservers(),
    listObserverRequirements: await view.listObserverRequirements("workspace"),
    listShareLinks: await view.listShareLinks(),
    listAutoApprovals: await view.listAutoApprovals(),
    listBlueprints: await view.listBlueprints(),
    getDiagnostics: await view.getDiagnostics(),
  };
}

/** The changes a chat subscription delivers: at its start, each chat's edits that no message has
 * recorded yet. */
class ChangeRecorder extends RpcTarget implements AiChatSubscriber {
  readonly changes = new Map<number, CodeChange[]>();
  streamGeneration(): void {}
  metadata(): void {}
  deleted(): void {}
  message(): void {}
  changeApplied(chatId: number, _generation: number, _revision: number, _author: AiChatAuthorInfo,
                change: CodeChange): void {
    this.changes.set(chatId, [...this.changes.get(chatId) ?? [], change]);
  }
  stream(): void {}
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
    ["setAdminWorkspaceAccess", ["metadata"]],
    ["setAdminAuditRetentionDays", [120]],
  ];
  for (const [method, args] of calls) {
    await expect(loose[method]!(...args), method).rejects.toThrow();
  }

  // The bypass is on the Overseer's Durable Object, never on a capability a user holds.
  const looseWs = ws as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  await expect(looseWs.openForAdmin!(ownerName, REASON, "session", {
    via: "api", expiresAt: new Date(Date.now() + 60_000),
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
    expect(description).toMatchObject({ id, title });
    expect(description).not.toHaveProperty("access");
    await view.listChats();
    await view.listActions();
    // The roster the members see: the owner's session is on it, and the view never is. The
    // owner's session and its subscriptions are open here, so the zero counts are the owner not
    // being counted, not an empty workspace.
    const diagnostics = await view.getDiagnostics();
    const present = diagnostics.present.map(participant => participant.user.id);
    expect(present).toContain(ownerName);
    expect(present).not.toContain(ADMIN_USERNAME);
    expect(diagnostics.sessions).toEqual({ build: 0, use: 0 });

    const logged = await workspaceRecords(id);
    expect(logged.map(record => record.method))
        .toEqual(["getDiagnostics", "listActions", "listChats", "describe", "inspectWorkspace"]);
    const sessionId = logged[0]!.sessionId;
    for (const record of logged) {
      expect(record).toMatchObject({
        kind: "workspace", workspaceId: id, workspaceOwner: ownerName, workspaceTitle: title,
        admin: ADMIN_USERNAME, reason: REASON, sessionId, via: "api", access: "metadata",
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

it("withholds what the workspace's owner can read, and turns inspection off", async () => {
  using stack = new DisposableStack();
  const populated = await populatedWorkspace(stack, "modes");
  const {
    ws, workpieces, id, title, chatId, gadgetId, head, attachmentChatId, attachmentId, draftChatId,
  } = populated;

  const settings = await admin.getSettings();
  expect(settings.adminWorkspaceAccess)
      .toEqual({ effective: "metadata", chosen: "metadata", max: "metadata" });
  expect(settings.adminAuditRetentionDays).toEqual({ effective: 90, chosen: 90, min: 90 });

  // Each part a view withholds, read first through the owner's own session: it is in the
  // workspace, so its absence from the view's answers below is the view withholding it.
  expect((await ws.getChatHistory(chatId)).messages)
      .toContainEqual(expect.objectContaining({ type: "message", message: CHAT_MESSAGE }));
  expect(await ws.readFilesAtCommit(head, ["notes.txt"]))
      .toEqual([["notes.txt", { kind: "text", text: NOTES }]]);
  // The draft is in no message yet, so the owner reads it as a subscription replays it.
  const drafts = new ChangeRecorder();
  stack.use(await ws.subscribeToChat(stack.use(stubFor(drafts))));
  const draft = await waitFor("the draft's changes to be replayed", async () =>
    drafts.changes.get(draftChatId) ?? null);
  const committed = new Map([[gadgetId, new Map([["notes.txt", NOTES]])]]);
  expect(draft.reduce(applyCodeChange, committed).get(gadgetId)?.get("notes.txt"))
      .toBe(DRAFT_NOTES);
  const bytes = await ws.getChatAttachmentContent(attachmentChatId, attachmentId);
  expect(new TextDecoder().decode(bytes)).toBe(ATTACHMENT);
  const ownerLog = await ws.getCommitLog(head);
  expect(ownerLog.length).toBeGreaterThan(1);
  for (const commit of ownerLog) expect(commit.message, commit.oid).not.toBe("");
  const observed = (await ws.listActions()).entries.find(entry => entry.type === "observation");
  expect(observed?.description).toMatchObject({
    title: "Read the test value", description: OBSERVATION_DESCRIPTION,
  });
  // A gadget built from scratch follows no blueprint, which its `upstream` says with no id.
  expect(workpieces.summaries.get(gadgetId)).toMatchObject({ upstream: {} });

  try {
    using view = await admin.inspectWorkspace(id, REASON);
    const answers = await everyAnswer(view, populated);

    expect(answers.listFiles).toEqual([{ name: "notes.txt", kind: "file" }]);
    expect(answers.listFilesAtCommit).toEqual(answers.listFiles);
    expect(answers.listPendingChanges).toMatchObject([{ gadgetId, modified: ["notes.txt"] }]);
    expect(answers.listChatAttachments).toEqual([{
      id: attachmentId, oid: expect.any(String), mimeType: "text/plain", name: "a.txt",
      size: new TextEncoder().encode(ATTACHMENT).byteLength, sequence: expect.any(Number),
    }]);
    // The message is all that the owner's history has and the view's lacks.
    expect(answers.getCommitLog).toEqual(ownerLog.map(commit => ({ ...commit, message: "" })));
    const withheld = answers.listActions.entries.find(entry => entry.id === observed?.id);
    expect(withheld).toMatchObject({
      type: "observation", description: { title: "Read the test value" },
    });
    expect(withheld?.description.description).toBe("");
    expect(withheld?.description).not.toHaveProperty("fields");
    const gadget = answers.describe.workpieces.find(workpiece => workpiece.id === gadgetId);
    expect(gadget).toMatchObject({ type: "gadget", commitId: head });
    expect(gadget).not.toHaveProperty("upstream");
    expect(answers.listChats.map(chat => chat.id))
        .toEqual(expect.arrayContaining([chatId, attachmentChatId, draftChatId]));

    // Every answer of the view and every record it left, searched as they travelled.
    const shown = JSON.stringify([answers, await workspaceRecords(id)]);
    const parts: [string, string][] = [
      ["a chat message", CHAT_MESSAGE], ["a file's text", NOTES.trim()],
      ["a draft's text", DRAFT_LINE.trim()], ["an attachment's bytes", ATTACHMENT.trim()],
      ["an observation's description", OBSERVATION_DESCRIPTION],
      ...ownerLog.map((commit): [string, string] => ["a commit message", commit.message.trim()]),
    ];
    // Compared outside the matcher, whose failure would print every answer whole.
    for (const [part, text] of parts) expect(shown.includes(text), part).toBe(false);

    await admin.setAdminWorkspaceAccess("off");
    const reason = "Off-mode check";
    expect(await refusalOf(admin.inspectWorkspace(id, reason)))
        .toBe(ADMIN_ACCESS_ERROR_CODES.accessOff);
    expect(await newestRecord({ kind: "workspace" })).toMatchObject({
      kind: "workspace", workspaceId: id, workspaceTitle: title, method: "inspectWorkspace",
      admin: ADMIN_USERNAME, reason, access: "off", refused: ADMIN_ACCESS_ERROR_CODES.accessOff,
    });
    await waitFor("the live view to be turned off", async () =>
      await outcomeOf(view.listChats()) === ADMIN_ACCESS_ERROR_CODES.accessOff || null);
    expect(await newestRecord({ workspace: id })).toMatchObject({
      method: "listChats", access: "off", refused: ADMIN_ACCESS_ERROR_CODES.accessOff,
      reason: REASON,
    });

    // A view within its lifetime answers again once the level is back.
    await admin.setAdminWorkspaceAccess("metadata");
    await waitFor("the live view to answer again", async () =>
      await outcomeOf(view.listChats()) === null || null);
    const answered = accessRecord(await newestRecord({ workspace: id }));
    expect(answered).toMatchObject({ method: "listChats", access: "metadata", reason: REASON });
    expect(answered.refused).toBeUndefined();

    await expect(admin.setAdminWorkspaceAccess("everything" as AdminWorkspaceAccess))
        .rejects.toThrow();
    await expect(admin.setAdminAuditRetentionDays(89)).rejects.toThrow();
    await expect(admin.setAdminAuditRetentionDays(3651)).rejects.toThrow();
  } finally {
    await admin.setAdminWorkspaceAccess("metadata");
    await admin.setAdminAuditRetentionDays(90);
  }
});

it("lists attachments, commits and a draft's paths without their content", async () => {
  using stack = new DisposableStack();
  const { id, gadgetId, empty, head, attachmentChatId, draftChatId } =
      await populatedWorkspace(stack, "withheld");
  using view = await admin.inspectWorkspace(id, REASON);

  // A commit's message describes its change, so the history arrives without it. The record
  // holds no depth, since the call gave none.
  const log = await view.getCommitLog(head);
  expect(log.map(commit => [commit.oid, commit.message])).toEqual([[head, ""], [empty, ""]]);
  const logRecord = accessRecord(await newestRecord({ workspace: id }));
  expect(logRecord).toMatchObject({ method: "getCommitLog", access: "metadata" });
  expect(logRecord.args).toEqual({ fromCommit: head });
  expect(logRecord.refused).toBeUndefined();

  // A depth outside the range is refused before anything is recorded.
  await expect(view.getCommitLog(head, 0)).rejects.toThrow(TypeError);
  expect(await newestRecord({ workspace: id })).toEqual(logRecord);
  expect(await view.getCommitLog(head, 1)).toEqual([log[0]]);
  expect(accessRecord(await newestRecord({ workspace: id })).args)
      .toEqual({ fromCommit: head, depth: 1 });

  // The message's own reference also holds the attachment's path in the chat's scratch worktree,
  // which the listing leaves out.
  const [attachment] = await view.listChatAttachments(attachmentChatId);
  expect(Object.keys(attachment!).toSorted())
      .toEqual(["id", "mimeType", "name", "oid", "sequence", "size"]);

  // The paths the draft adds, modifies and removes, a file over the buffered size among them.
  expect(await view.listPendingChanges(draftChatId)).toEqual([{
    gadgetId, baseCommit: head, mergedCommit: head,
    added: [LARGE_PATH], modified: ["notes.txt"], removed: [],
  }]);
  // Any stored commit can be read, the one a chat's pin names as its base among them. Its tree
  // is the commit's: the draft's added file is not in it.
  const pins = (await view.listChats()).find(chat => chat.id === draftChatId)?.codeBase?.pins;
  expect(pins).toEqual([{ gadgetId, baseCommit: head, mergedCommit: head }]);
  expect(await view.listFilesAtCommit(pins![0]!.baseCommit))
      .toEqual([{ name: "notes.txt", kind: "file" }]);
  expect(await view.listFilesAtCommit(empty)).toEqual([]);
  // The paths that differ, not the difference.
  expect(await view.listChangedPaths(empty, head)).toEqual(["notes.txt"]);
  expect(await view.listChangedPaths(head, head)).toEqual([]);

  // An id that names no chat, and one that names no stored commit. A read that fails is recorded
  // as an attempt, with no refusal.
  const missingChat = 999_999;
  const missingCommit = "0".repeat(40);
  expect(await view.listChatAttachments(missingChat)).toEqual([]);
  const failures: [string, Record<string, string | number>, () => PromiseLike<unknown>][] = [
    ["getChatState", { chatId: missingChat }, () => view.getChatState(missingChat)],
    ["listPendingChanges", { chatId: missingChat }, () => view.listPendingChanges(missingChat)],
    ["listFilesAtCommit", { commitId: missingCommit },
      () => view.listFilesAtCommit(missingCommit)],
    ["getCommitLog", { fromCommit: missingCommit }, () => view.getCommitLog(missingCommit)],
  ];
  for (const [method, args, call] of failures) {
    // The read's own error, which is not one of the view's refusals.
    expect(await outcomeOf(call()), method).toBeUndefined();
    const record = accessRecord(await newestRecord({ workspace: id }));
    expect(record, method).toMatchObject({ method, access: "metadata" });
    expect(record.args, method).toEqual(args);
    expect(record.refused, method).toBeUndefined();
  }
});

it("has no level above metadata", async () => {
  using stack = new DisposableStack();
  const { id, gadgetId, chatId, head, attachmentChatId, attachmentId, draftChatId } =
      await populatedWorkspace(stack, "nolevel");

  // An inspection has no level to ask for: the option is not one, and the view is as any other.
  using view = await admin.inspectWorkspace(id, REASON, { access: "full" } as never);
  const description = await view.describe();
  expect(description).not.toHaveProperty("access");
  expect(description.workpieces.find(workpiece => workpiece.id === gadgetId))
      .not.toHaveProperty("upstream");
  const logged = await workspaceRecords(id);
  expect(logged.map(record => record.method)).toEqual(["describe", "inspectWorkspace"]);
  for (const record of logged) {
    expect(record).toMatchObject({ access: "metadata" });
    expect(Object.keys(record)).not.toContain("requested");
  }

  // Nor is there one to set. The value is not of the setter's type, so the refusal is a
  // TypeError rather than the error of a level above the deployment's maximum, and nothing is
  // stored or recorded.
  const { adminWorkspaceAccess } = await admin.getSettings();
  const setting = await newestRecord({ kind: "setting" });
  await expect(admin.setAdminWorkspaceAccess("full" as never)).rejects.toThrow(TypeError);
  expect((await admin.getSettings()).adminWorkspaceAccess).toEqual(adminWorkspaceAccess);
  expect(await newestRecord({ kind: "setting" })).toEqual(setting);

  // A view has no method that reads content. Each of these names something the workspace holds,
  // and none is recorded: there is no call to record.
  const loose = view as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const absent: [string, unknown[]][] = [
    ["getChat", [chatId]],
    ["readChatAttachment", [attachmentChatId, attachmentId]],
    ["readFile", [gadgetId, "notes.txt"]],
    ["readFileAtCommit", [head, "notes.txt"]],
    ["readPendingFile", [draftChatId, gadgetId, "notes.txt"]],
  ];
  for (const [method, args] of absent) {
    await expect(loose[method]!(...args), method).rejects.toThrow();
  }
  expect(await workspaceRecords(id)).toEqual(logged);
});

it("records each call into a workspace", async () => {
  using stack = new DisposableStack();
  const populated = await populatedWorkspace(stack, "recorded");
  const {
    ws, ownerName, id, title, chatId, gadgetId, connectionId, empty, head, attachmentChatId,
    draftChatId,
  } = populated;
  // A share link and an auto-approval rule for the two listings below to show. No write is
  // pending, so the rule applies nothing.
  const link = await ws.createShareLink("workspace", LINK_NOTE);
  await ws.setAutoApprovedActionKind(connectionId, SET_VALUE);
  // A setting change, which the log keeps beside the access records.
  const { siteName } = await admin.getSettings();
  await admin.setSiteName("Recorded deployment");

  try {
    using view = await admin.inspectWorkspace(id, REASON);
    const answers = await everyAnswer(view, populated);
    // A read that fails is recorded as an attempt.
    const missingChat = 999_999;
    await expect(view.getChatState(missingChat)).rejects.toThrow();

    // No call is queued for the chat's agent, and no action waits on it.
    expect(answers.getChatState).toMatchObject({
      lastMessageAt: expect.any(Date), queuedCalls: [], pendingActionIds: [],
    });
    expect(answers.getChatState.turn).toBeUndefined();
    // A holder's profile and the connection, vendor and account ids of their choices are names.
    // The list is empty: no collaborator has opened the workspace.
    expect(answers.listObservers).toEqual([]);
    // A link's id, note, creator and role are names, as a title is. Its key is in no answer.
    expect(answers.listShareLinks).toEqual([{
      linkId: link.linkId, note: LINK_NOTE, created: expect.any(Date),
      createdBy: expect.objectContaining({ type: "user", id: ownerName }), role: "build",
    }]);
    expect(JSON.stringify(answers).includes(link.key)).toBe(false);
    // A rule's connection, kind of action and enabler are names too.
    expect(answers.listAutoApprovals).toEqual([{
      gatekeeperId: connectionId, actionKind: SET_VALUE,
      enabledBy: expect.objectContaining({ type: "user", id: ownerName }),
    }]);
    // The workspace publishes none.
    expect(answers.listBlueprints).toEqual([]);
    expect(answers.listGatekeepers.map(gatekeeper => gatekeeper.id)).toContain(connectionId);

    // The open, each call in the order it was made, and the failed read: oldest first.
    const expected: [string, Record<string, unknown>][] = [
      ["inspectWorkspace", { expiresAt: answers.describe.expiresAt.toISOString() }],
      ["describe", {}],
      ["listChats", {}],
      ["getChatState", { chatId }],
      ["listChatAttachments", { chatId: attachmentChatId }],
      ["listActions", {}],
      ["listFiles", { gadgetId }],
      ["getCommitLog", { fromCommit: head }],
      ["listFilesAtCommit", { commitId: head }],
      ["listChangedPaths", { fromCommit: empty, toCommit: head }],
      ["listPendingChanges", { chatId: draftChatId }],
      ["listGatekeepers", {}],
      ["listObservers", {}],
      ["listObserverRequirements", { grant: "workspace" }],
      ["listShareLinks", {}],
      ["listAutoApprovals", {}],
      ["listBlueprints", {}],
      ["getDiagnostics", {}],
      ["getChatState", { chatId: missingChat }],
    ];
    expect(expected.slice(1, 18).map(([method]) => method)).toEqual(Object.keys(answers));
    const logged = (await workspaceRecords(id)).toReversed();
    expect(logged.map(record => [record.method, accessRecord(record).args])).toEqual(expected);
    const { sessionId } = logged[0]!;
    for (const record of logged) {
      expect(record).toMatchObject({
        kind: "workspace", at: expect.any(Date), admin: ADMIN_USERNAME, sessionId, via: "api",
        workspaceId: id, workspaceOwner: ownerName, workspaceTitle: title, reason: REASON,
        access: "metadata",
      });
      // A record says who called what, when and why, and nothing of what the call returned.
      expect(Object.keys(record).toSorted(), record.method).toEqual([
        "access", "admin", "args", "at", "kind", "method", "reason", "sessionId", "via",
        "workspaceId", "workspaceOwner", "workspaceTitle",
      ]);
    }

    // The table behind the log, which is always getByName(""). Its `exposed` column holds
    // 'metadata' for every access record, refused ones included, and nothing for a setting change.
    const storage = await harness.server.getWorker("workshop-backend")
        .getDurableObjectStorage("AdminAuditDurableObject", { name: "" });
    expect(await storage.exec<{ exposed: string | null }>(
        "SELECT DISTINCT exposed FROM admin_audit WHERE kind = 'workspace'"))
        .toEqual([{ exposed: "metadata" }]);
    expect(await storage.exec<{ exposed: string | null; total: number }>(`SELECT exposed,
        COUNT(*) AS total FROM admin_audit WHERE kind = 'setting' GROUP BY exposed`))
        .toEqual([{ exposed: null, total: expect.any(Number) }]);
    expect(await storage.exec<{ total: number }>(`SELECT COUNT(*) AS total FROM admin_audit
        WHERE kind = 'workspace' AND workspace_id = '${id}'`)).toEqual([{ total: logged.length }]);
  } finally {
    await admin.setSiteName(siteName);
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
  expect(await newestRecord({ workspace: id }))
      .toMatchObject({ method: "listGatekeepers", access: "metadata" });

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
    expect(await newestRecord({ workspace: id }), method)
        .toMatchObject({ method, access: "metadata" });

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
  const diagnostics = await view.getDiagnostics();
  await metadataRead("getDiagnostics");
  expect(diagnostics.observers).toBe(2);
  // The admitted member's session is held until the test ends, and sharing the workspace grants
  // "build". Everything that session keeps counts, so the number is at least one; the refused
  // open left nothing to count, and no one holds "use".
  expect(diagnostics.sessions.build).toBeGreaterThanOrEqual(1);
  expect(diagnostics.sessions.use).toBe(0);
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

  using view = await admin.inspectWorkspace(id, REASON);
  const logged = await workspaceRecords(id);
  expect(logged).toHaveLength(1);

  try {
    await storage.exec(`CREATE TRIGGER admin_audit_unavailable BEFORE INSERT ON admin_audit
        BEGIN SELECT RAISE(ABORT, 'admin audit unavailable'); END`);
    await expect(view.listChats()).rejects.toThrow();
    await expect(view.getChatState(chatId)).rejects.toThrow();
    await expect(admin.inspectWorkspace(id, REASON)).rejects.toThrow();
  } finally {
    await storage.exec("DROP TRIGGER IF EXISTS admin_audit_unavailable");
  }
  expect(await workspaceRecords(id)).toEqual(logged);
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
