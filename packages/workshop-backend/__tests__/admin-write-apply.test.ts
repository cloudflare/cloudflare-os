// An approved admin write as its workspace runs it (OverseerDurableObject.applyAdminWrite()): what
// it refuses before writing or recording anything, that the "approved" record and the entry of
// the workspace's action log both come before the effect, which operation each action runs and
// with what, and who is shown the entry.
//
// Runs against a real OverseerDurableObject (the TEST_OVERSEER binding) whose impl.env is replaced
// per test: the write path must read the environment only through it. The deployment-wide log is
// the real AdminAuditDurableObject the Overseer reaches through ctx.exports, read back through the
// TEST_ADMIN_AUDIT binding. What the workspace's owner is shown is read through a real owner
// session opened on the same object.

import { describe, expect, it, vi } from "vitest";
import { env, RpcStub as NativeRpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import {
  ADMIN_ACCESS_ERROR_CODES, ADMIN_WRITE_ERROR_CODES, MAX_ADMIN_AUDIT_ARG_LENGTH,
  MAX_ADMIN_REJECTED_ACTIONS, getAdminAccessErrorCode, getAdminWriteErrorCode,
  type ActionLogEntry, type AdminWriteAction, type AdminWriteArgs, type AdminWriteRecord,
  type AiChatAuthorInfo, type Overseer,
} from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { AdminAuditDurableObject } from "../src/admin-audit.js";
import type { AdminWriteGrant } from "../src/admin-writes.js";
import { auditOwnerId, withholdActionContent } from "../src/admin-access.js";
import { ADMIN_CONFIG_KEY } from "../src/storage-schema/blueprints-kv.js";
import { FIXTURE_EPOCH, putAction } from "./fixtures.js";
// Load the whole backend (the pool's `main`) up front, so its slow load does not count against the
// first test's timeout.
import "./test-worker.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
    TEST_ADMIN_AUDIT: DurableObjectNamespace<AdminAuditDurableObject>;
  }
}

// The pool's ADMINS.
const ADMIN = "deployment-admin@example.test";
// A second admin, whom the tests' environment adds: the requester where one differs.
const REQUESTER = "requester-admin@example.test";
const ADMIN_PROFILE: AiChatAuthorInfo = { type: "user", id: ADMIN, name: "Ada Admin" };
const OWNER: AiChatAuthorInfo = { type: "user", id: "owner@example.test", name: "Owner" };
const BOB: AiChatAuthorInfo = { type: "user", id: "bob@example.test", name: "Bob" };
const AGENT: AiChatAuthorInfo = { type: "agent", id: "first-model", name: "First" };
const REASON = "Support ticket 42";
const SESSION_ID = "admin-session";
const PASSKEY = "credential-id";
// The pool sets no ADMIN_AUDIT_RETENTION_MIN_DAYS, so retention is at least 90 days.
const RETENTION = 90;

const CHAT_ID = 1;
const GATEKEEPER_ID = 1;
const OTHER_GATEKEEPER_ID = 2;

// A user object's id, as the fake namespace derives it from the account's name.
function userIdOf(name: string): string {
  return `user-do:${name}`;
}
const OWNER_USER_ID = userIdOf(OWNER.id);

type Workspace = {
  impl: any;
  instance: OverseerDurableObject;
  state: DurableObjectState;
  id: string;
  // The accounts that exist, by name: what whoami() and whoamiIfExists() answer.
  accounts: Map<string, AiChatAuthorInfo>;
};

// The fake user objects: each answers what a workspace asks of an account, and nothing is kept.
function fakeUsers(ws: Workspace) {
  let user = (id: string) => {
    let profile = ws.accounts.get(id.slice(userIdOf("").length));
    return {
      id,
      whoami: async () => {
        if (!profile) throw new Error(`No account behind ${id}.`);
        return profile;
      },
      whoamiIfExists: async () => profile ?? null,
      listGatekeeperVendors: async () => [],
      setWorkspaceLastActive: async () => {},
      recordSharedWorkspaceOpen: async () => {},
      workspaceRemoved: async () => {},
      messageArrived: async () => {},
      getWorkspace: async () => null,
      getGadget: async () => null,
      syncWorkspaceOutputs: async () => {},
    };
  };
  return {
    idFromString: (id: string) => id,
    idFromName: userIdOf,
    get: user,
    getByName: (name: string) => user(userIdOf(name)),
  };
}

// Sets impl.env to the pool's env with writes on, both admins, a fake BLUEPRINTS serving a config
// whose inspection level is "metadata", and `vars`.
function setEnv(ws: Workspace, vars: Record<string, unknown> = {}): void {
  let config = JSON.stringify(
      { adminWorkspaceAccess: "metadata", adminAuditRetentionDays: RETENTION });
  ws.impl.env = {
    ...env,
    ADMINS: [ADMIN, REQUESTER],
    ADMIN_WORKSPACE_WRITES: "on",
    BLUEPRINTS: { get: async (key: string) => key === ADMIN_CONFIG_KEY ? config : null },
    ...vars,
  };
}

async function withWorkspace(fn: (ws: Workspace) => Promise<void>,
                             opts: { seed?: boolean } = {}): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`admin-write-${crypto.randomUUID()}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject, state) => {
    let impl = (instance as unknown as { impl: any }).impl;
    let ws: Workspace = {
      impl, instance, state, id: state.id.toString(),
      accounts: new Map([[OWNER.id, OWNER], [ADMIN, ADMIN_PROFILE], [BOB.id, BOB]]),
    };
    setEnv(ws);
    if (opts.seed ?? true) seed(ws);
    await fn(ws);
  });
}

// An initialised workspace: its owner, a title, an idle chat and two connections.
function seed(ws: Workspace): void {
  let impl = ws.impl;
  impl.directories = {
    getByName: () => ({ syncWorkspace: async () => {}, removeWorkspace: async () => {} }),
  };
  impl.users = fakeUsers(ws);
  // The two side effects of opening a session that call out to the owner's account.
  impl.ensureAmbientCapsules = async () => {};
  impl.markOutputsDirty = () => {};
  impl.ownerId = OWNER_USER_ID;
  impl.ownerProfileId = OWNER.id;
  impl.storage.ownerId.put(OWNER_USER_ID);
  impl.storage.title.put("Quarterly plan");

  impl.storage.chatMeta.put(
      { id: CHAT_ID, title: "Plans", started: new Date(0), lastActive: new Date(0) });
  impl.storage.nextGatekeeperId.put(OTHER_GATEKEEPER_ID + 1);
  for (let id of [GATEKEEPER_ID, OTHER_GATEKEEPER_ID]) {
    impl.storage.gatekeepers.put({
      id, resourceTitle: `Repo ${id}`, class: {} as any,
      creationSpec: {
        type: "gatekeeper", vendorId: "TestVendor", resourceUrl: `https://example.com/repo${id}`,
        typeUrlPattern: "https://*",
      },
    });
  }
}

// A grant as AdminApiImpl.approveWorkspaceWrite() hands one over: requested and approved by ADMIN.
function grantOf(action: AdminWriteAction, args: AdminWriteArgs = {},
                 overrides: Partial<AdminWriteGrant> = {}): AdminWriteGrant {
  return {
    action, args, reason: REASON, requestedBy: ADMIN, workspaceOwner: OWNER.id,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    admin: ADMIN, sessionId: SESSION_ID, via: "api", passkey: PASSKEY,
    requestId: `request-${crypto.randomUUID()}`,
    ...overrides,
  };
}

// The code a call is refused with, of either family.
async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return getAdminAccessErrorCode(err) ?? getAdminWriteErrorCode(err) ?? `uncoded: ${String(err)}`;
  }
  throw new Error("Expected a refusal.");
}

// The deployment-wide log's records for this workspace, oldest first.
async function deploymentRecords(ws: Workspace): Promise<AdminWriteRecord[]> {
  let page = await env.TEST_ADMIN_AUDIT.getByName("")
      .list({ workspace: ws.id, limit: 200 }, RETENTION);
  return (page.records as AdminWriteRecord[]).toReversed();
}

// Everything the workspace stores, keys and values, but the journal of chats awaiting fan-out:
// the seed's chat is in it until its drain clears it, in its own time.
function stored(ws: Workspace): [string, unknown][] {
  return [...ws.state.storage.kv.list()].filter(([key]) => !key.startsWith("dirtyChats:"));
}

// Runs `fn` over a real owner session on the workspace: what its owner reads and decides.
async function asOwner<T>(ws: Workspace, fn: (client: Overseer) => Promise<T>): Promise<T> {
  // Disposed with the session: the session holds a duplicate of the stub until then.
  using notifyClosed = new NativeRpcStub<() => void>(() => {});
  using client = await ws.instance.open(OWNER_USER_ID, OWNER.id, notifyClosed);
  return await fn(client);
}

// The workspace's action log as its owner lists it, newest first.
async function ownerLog(ws: Workspace): Promise<ActionLogEntry[]> {
  return asOwner(ws, async client => (await client.listActions()).entries);
}

// The entries of admin writes in that log, newest first.
async function adminEntries(ws: Workspace): Promise<ActionLogEntry[]> {
  return (await ownerLog(ws)).filter(entry => entry.type === "action" && entry.byAdmin);
}

// A subscriber to the action log that keeps the entries it is delivered. A native stub over a
// plain object forwards onRpcBroken(), which a "build" session's subscription calls.
function actionSubscriber() {
  let delivered: ActionLogEntry[] = [];
  let stub = new NativeRpcStub({
    ready: async () => {}, onRpcBroken: () => {},
    entry: async (entry: ActionLogEntry) => { delivered.push(entry); },
  } as any) as any;
  return { stub, delivered, [Symbol.dispose]: () => stub[Symbol.dispose]() };
}

// A gatekeeper facet that records the actions it is told were rejected, and fails for `failing`,
// with `refusal` when one is given.
function fakeFacet(ws: Workspace, failing: number[] = [],
                   refusal?: string): { rejected: number[]; asked: number[] } {
  let facet = { rejected: [] as number[], asked: [] as number[] };
  ws.impl.getGatekeeperFacet = async (id: number) => {
    facet.asked.push(id);
    return {
      rejectAction: async (action: number) => {
        if (failing.includes(action)) {
          throw new Error(refusal ?? `The vendor refused to drop action ${action}`);
        }
        facet.rejected.push(action);
      },
    };
  };
  return facet;
}

describe("refusals that write and record nothing", () => {
  it("refuses an uninitialised workspace without initialising it", () => withWorkspace(async ws => {
    expect(await codeOf(ws.instance.applyAdminWrite(grantOf("restartWorkspace"))))
        .toBe(ADMIN_ACCESS_ERROR_CODES.workspaceNotFound);
    expect(stored(ws)).toStrictEqual([]);
    expect(await deploymentRecords(ws)).toStrictEqual([]);
  }, { seed: false }));

  it("refuses a grant that names another owner than the workspace's",
      () => withWorkspace(async ws => {
    let before = stored(ws);
    let refused = ws.instance.applyAdminWrite(
        grantOf("stopAgent", { chatId: CHAT_ID }, { workspaceOwner: BOB.id }));
    // Its own code: the workspace is alive, and `workspaceNotFound` would drop it from the
    // directory.
    await expect(refused.catch(getAdminWriteErrorCode))
        .resolves.toBe(ADMIN_WRITE_ERROR_CODES.workspaceChanged);
    await expect(refused.catch(getAdminAccessErrorCode)).resolves.toBeUndefined();
    expect(stored(ws)).toStrictEqual(before);
    expect(await deploymentRecords(ws)).toStrictEqual([]);

    // The owner's own id runs.
    await ws.instance.applyAdminWrite(grantOf("stopAgent", { chatId: CHAT_ID }));
    expect((await deploymentRecords(ws)).map(record => record.event)).toStrictEqual(["approved"]);
  }));

  it("runs for a long owner id in the form an audit record keeps", () => withWorkspace(async ws => {
    let longOwner = `${"o".repeat(MAX_ADMIN_AUDIT_ARG_LENGTH + 40)}@example.test`;
    ws.impl.ownerProfileId = longOwner;
    expect(auditOwnerId(longOwner)).not.toBe(longOwner);

    await ws.instance.applyAdminWrite(
        grantOf("stopAgent", { chatId: CHAT_ID }, { workspaceOwner: auditOwnerId(longOwner) }));
    expect(await deploymentRecords(ws)).toMatchObject(
        [{ event: "approved", workspaceOwner: auditOwnerId(longOwner) }]);
  }));

  it.each([
    ["an approver who is not an admin", { admin: OWNER.id }],
    ["a requester who is not an admin", { requestedBy: "former-admin@example.test" }],
  ] as const)("refuses %s", (_name, overrides) => withWorkspace(async ws => {
    let before = stored(ws);
    expect(await codeOf(ws.instance.applyAdminWrite(
        grantOf("stopAgent", { chatId: CHAT_ID }, overrides))))
        .toBe(ADMIN_ACCESS_ERROR_CODES.notAdmin);
    expect(stored(ws)).toStrictEqual(before);
    expect(await deploymentRecords(ws)).toStrictEqual([]);

    // With a requester who is an admin too, it runs.
    await ws.instance.applyAdminWrite(
        grantOf("stopAgent", { chatId: CHAT_ID }, { requestedBy: REQUESTER }));
    expect(await deploymentRecords(ws)).toMatchObject([{ admin: ADMIN, requestedBy: REQUESTER }]);
  }));

  it.each([
    ["unset", undefined], ["off", "off"], ["a value that is not \"on\"", "true"],
  ])("refuses while ADMIN_WORKSPACE_WRITES is %s", (_name, value) => withWorkspace(async ws => {
    // Set only through the OverseerImpl's environment, the one the write path may read.
    setEnv(ws, { ADMIN_WORKSPACE_WRITES: value });
    let before = stored(ws);
    expect(await codeOf(ws.instance.applyAdminWrite(grantOf("stopAgent", { chatId: CHAT_ID }))))
        .toBe(ADMIN_WRITE_ERROR_CODES.writesOff);
    expect(stored(ws)).toStrictEqual(before);
    expect(await deploymentRecords(ws)).toStrictEqual([]);
  }));

  it.each([
    ["a blank reason", {}, { reason: "   " }],
    ["a via that is neither api nor cli", {}, { via: "browser" }],
    ["arguments the action does not take", { gatekeeperId: 3 }, {}],
    ["a missing argument", { chatId: undefined }, {}],
    ["an invalid expiry", {}, { expiresAt: new Date(NaN) }],
    ["an expiry that is not a Date", {}, { expiresAt: "2030-01-01T00:00:00Z" }],
    ["an empty workspace owner", {}, { workspaceOwner: "" }],
    ["a missing passkey", {}, { passkey: undefined }],
    ["an empty passkey", {}, { passkey: "" }],
    ["a passkey of 257 characters", {}, { passkey: "p".repeat(MAX_ADMIN_AUDIT_ARG_LENGTH + 1) }],
  ])("rejects a grant with %s", (_name, args, overrides) => withWorkspace(async ws => {
    let before = stored(ws);
    let grant = grantOf("stopAgent", { chatId: CHAT_ID, ...args },
        overrides as unknown as Partial<AdminWriteGrant>);
    await expect(ws.instance.applyAdminWrite(grant)).rejects.toBeInstanceOf(TypeError);
    expect(stored(ws)).toStrictEqual(before);
    expect(await deploymentRecords(ws)).toStrictEqual([]);
  }));

  it("refuses a request that expired two minutes ago, and allows a minute of clock skew",
      () => withWorkspace(async ws => {
    let before = stored(ws);
    expect(await codeOf(ws.instance.applyAdminWrite(grantOf("stopAgent", { chatId: CHAT_ID },
        { expiresAt: new Date(Date.now() - 2 * 60 * 1000) }))))
        .toBe(ADMIN_WRITE_ERROR_CODES.requestNotPending);
    expect(stored(ws)).toStrictEqual(before);
    expect(await deploymentRecords(ws)).toStrictEqual([]);

    await ws.instance.applyAdminWrite(grantOf("stopAgent", { chatId: CHAT_ID },
        { expiresAt: new Date(Date.now() - 30 * 1000) }));
    expect(await deploymentRecords(ws)).toHaveLength(1);
  }));
});

// The operations a write may run, each replaced by a recorder that does nothing.
const OPERATIONS = ["cancelAgent", "scheduleAccessRestart", "deleteChat", "rejectAction"] as const;

// Spies on every operation, and returns each one's calls by name.
function spyOnOperations(ws: Workspace): Record<string, { mock: { calls: unknown[][] } }> {
  let spies: Record<string, { mock: { calls: unknown[][] } }> = {};
  for (let name of OPERATIONS) {
    spies[name] = vi.spyOn(ws.impl, name).mockImplementation(async () => undefined);
  }
  return spies;
}

describe("each action runs its one operation", () => {
  it.each<[AdminWriteAction, AdminWriteArgs, Record<string, unknown[][]>]>([
    ["stopAgent", { chatId: CHAT_ID }, { cancelAgent: [[CHAT_ID]] }],
    ["restartWorkspace", {}, {
      scheduleAccessRestart: [["Gadget restarted by a deployment admin."]],
    }],
    ["deleteChat", { chatId: CHAT_ID }, { deleteChat: [[CHAT_ID]] }],
    ["rejectPendingActions", {}, { rejectAction: [[7, expect.any(Function)]] }],
  ])("%s", (action, args, expected) => withWorkspace(async ws => {
    putAction(ws.impl.storage, 7, { gatekeeperId: GATEKEEPER_ID });
    let spies = spyOnOperations(ws);

    await ws.instance.applyAdminWrite(grantOf(action, args));

    // Exactly that operation, with exactly those arguments, and no other.
    for (let [name, spy] of Object.entries(spies)) {
      expect(spy.mock.calls, name).toEqual(expected[name] ?? []);
    }
  }));

  it("rejects each pending action as the admin who approved", () => withWorkspace(async ws => {
    putAction(ws.impl.storage, 7, { gatekeeperId: GATEKEEPER_ID });
    let spies = spyOnOperations(ws);
    await ws.instance.applyAdminWrite(grantOf("rejectPendingActions"));
    let resolver = spies.rejectAction.mock.calls[0][1] as () => Promise<AiChatAuthorInfo>;
    expect(await resolver()).toEqual(ADMIN_PROFILE);
  }));

  it("names an approver who has no account by their id", () => withWorkspace(async ws => {
    ws.accounts.delete(ADMIN);
    putAction(ws.impl.storage, 7, { gatekeeperId: GATEKEEPER_ID });
    let spies = spyOnOperations(ws);
    await ws.instance.applyAdminWrite(grantOf("rejectPendingActions"));
    let resolver = spies.rejectAction.mock.calls[0][1] as () => Promise<AiChatAuthorInfo>;
    expect(await resolver()).toEqual({ type: "user", id: ADMIN, name: ADMIN });
  }));

  it("throws the operation's own error for an unknown chat", () => withWorkspace(async ws => {
    let apply = (action: AdminWriteAction, args: AdminWriteArgs) =>
        ws.instance.applyAdminWrite(grantOf(action, args));
    await expect(apply("stopAgent", { chatId: 99 })).rejects.toThrow("No such chatId: 99");
    await expect(apply("deleteChat", { chatId: 99 })).rejects.toThrow("No such chatId: 99");

    // Each was approved and recorded before it failed, and each left its entry, "rejected".
    expect((await deploymentRecords(ws)).map(record => record.event))
        .toStrictEqual(["approved", "approved"]);
    expect((await adminEntries(ws)).map(entry => entry.state))
        .toStrictEqual(["rejected", "rejected"]);
  }));
});

// The chat's messages, oldest first.
function messagesOf(ws: Workspace): any[] {
  return [...ws.impl.storage.chats.list()];
}

describe("the effect of a write", () => {
  it("deleteChat removes the chat and its messages", () => withWorkspace(async ws => {
    ws.impl.addChatMessages(CHAT_ID, OWNER, [{ type: "message", message: "a request" }]);
    await ws.instance.applyAdminWrite(grantOf("deleteChat", { chatId: CHAT_ID }));
    expect(ws.impl.storage.chatMeta.get(CHAT_ID)).toBeUndefined();
    expect(messagesOf(ws)).toStrictEqual([]);
  }));

  it("stopAgent on an idle chat succeeds", () => withWorkspace(async ws => {
    expect(await ws.instance.applyAdminWrite(grantOf("stopAgent", { chatId: CHAT_ID })))
        .toEqual({ outcome: undefined });
    expect(await adminEntries(ws)).toMatchObject([{ state: "approved" }]);
  }));
});

// The stored actions that are no admin write's entry, by id, each with its state.
function actionStates(ws: Workspace): Record<number, string> {
  return Object.fromEntries([...ws.impl.storage.actions.list()]
      .filter((record: any) => !record.byAdmin).map((record: any) => [record.id, record.state]));
}

// Puts the pending creation of connection `gatekeeperId`, as createExternalResource queues one.
function putCreation(ws: Workspace, id: number, gatekeeperId: number): void {
  ws.impl.storage.actions.put({
    id, gatekeeperId, type: "action", action: "create", state: "pending",
    caller: { from: "user" }, createdAt: new Date(FIXTURE_EPOCH + id),
    description: { title: "Create", description: "Create", implementsRevert: false },
  });
  if (id >= ws.impl.storage.nextActionId.get()) ws.impl.storage.nextActionId.put(id + 1);
}

function reject(ws: Workspace, args: AdminWriteArgs = {}): Promise<{ outcome?: string }> {
  return ws.instance.applyAdminWrite(grantOf("rejectPendingActions", args));
}

describe("rejectPendingActions", () => {
  it("rejects every pending action as the admin, starting no turn",
      () => withWorkspace(async ws => {
    for (let id of [0, 1, 2]) putAction(ws.impl.storage, id, { gatekeeperId: GATEKEEPER_ID });
    let facet = fakeFacet(ws);
    let drain = vi.spyOn(ws.impl, "drainAutoApprovals");

    expect(await reject(ws)).toEqual({ outcome: "Rejected 3 pending actions; 0 remain." });

    expect(facet.rejected).toStrictEqual([0, 1, 2]);
    for (let id of [0, 1, 2]) {
      expect(ws.impl.storage.actions.get(id))
          .toMatchObject({ state: "rejected", resolvedBy: ADMIN_PROFILE });
    }
    // No rejection starts or resumes an agent turn, and no auto-approval drain follows.
    expect([...ws.impl.storage.activeAgents.list()]).toStrictEqual([]);
    expect(drain).not.toHaveBeenCalled();
  }));

  it("rejects the oldest MAX_ADMIN_REJECTED_ACTIONS and leaves the rest pending",
      () => withWorkspace(async ws => {
    let count = MAX_ADMIN_REJECTED_ACTIONS + 1;
    for (let id = 0; id < count; id++) {
      putAction(ws.impl.storage, id, { gatekeeperId: GATEKEEPER_ID });
    }
    let facet = fakeFacet(ws);

    expect(await reject(ws)).toEqual({ outcome: "Rejected 500 pending actions; 1 remain." });

    expect(facet.rejected).toHaveLength(MAX_ADMIN_REJECTED_ACTIONS);
    expect(ws.impl.storage.actions.get(MAX_ADMIN_REJECTED_ACTIONS - 1).state).toBe("rejected");
    expect(ws.impl.storage.actions.get(MAX_ADMIN_REJECTED_ACTIONS).state).toBe("pending");
  }));

  it("goes on past an action that cannot be rejected, and reports it",
      () => withWorkspace(async ws => {
    for (let id of [0, 1, 2]) putAction(ws.impl.storage, id, { gatekeeperId: GATEKEEPER_ID });
    fakeFacet(ws, [0]);

    expect(await reject(ws)).toEqual({
      outcome: "Rejected 2 pending actions; 1 remain. 1 could not be rejected: " +
          "The vendor refused to drop action 0.",
    });
    expect(actionStates(ws)).toEqual({ 0: "pending", 1: "rejected", 2: "rejected" });
    expect(await adminEntries(ws)).toMatchObject([{ state: "approved" }]);
  }));

  it("fails when no action could be rejected", () => withWorkspace(async ws => {
    for (let id of [0, 1]) putAction(ws.impl.storage, id, { gatekeeperId: GATEKEEPER_ID });
    fakeFacet(ws, [0, 1]);

    await expect(reject(ws)).rejects.toThrow(
        "No pending action could be rejected: The vendor refused to drop action 0");
    expect(actionStates(ws)).toEqual({ 0: "pending", 1: "pending" });
    expect(await adminEntries(ws)).toMatchObject([{ state: "rejected" }]);
  }));

  it("reports a long error cut to the length an audit record keeps",
      () => withWorkspace(async ws => {
    for (let id of [0, 1]) putAction(ws.impl.storage, id, { gatekeeperId: GATEKEEPER_ID });
    fakeFacet(ws, [0], "x".repeat(5000));
    let cut = `${"x".repeat(MAX_ADMIN_AUDIT_ARG_LENGTH - 1)}…`;

    expect(await reject(ws)).toEqual({
      outcome: `Rejected 1 pending actions; 1 remain. 1 could not be rejected: ${cut}.`,
    });
    // Only the action that cannot be rejected is left, so the next request fails, with the same
    // cut.
    await expect(reject(ws)).rejects.toMatchObject(
        { message: `No pending action could be rejected: ${cut}` });
  }));

  it("rejects the actions of a removed connection without asking for its facet",
      () => withWorkspace(async ws => {
    for (let id of [0, 1]) putAction(ws.impl.storage, id, { gatekeeperId: GATEKEEPER_ID });
    ws.impl.removeGatekeeper(GATEKEEPER_ID);
    let facet = fakeFacet(ws);

    expect(await reject(ws)).toEqual({ outcome: "Rejected 2 pending actions; 0 remain." });
    expect(facet.asked).toStrictEqual([]);
    expect(actionStates(ws)).toEqual({ 0: "rejected", 1: "rejected" });
  }));

  it("leaves another connection's actions alone when given a connection",
      () => withWorkspace(async ws => {
    putAction(ws.impl.storage, 0, { gatekeeperId: GATEKEEPER_ID });
    putAction(ws.impl.storage, 1, { gatekeeperId: OTHER_GATEKEEPER_ID });
    putAction(ws.impl.storage, 2, { gatekeeperId: GATEKEEPER_ID });
    let facet = fakeFacet(ws);

    expect(await reject(ws, { gatekeeperId: GATEKEEPER_ID }))
        .toEqual({ outcome: "Rejected 2 pending actions; 0 remain." });
    expect(facet.asked).toStrictEqual([GATEKEEPER_ID, GATEKEEPER_ID]);
    expect(actionStates(ws)).toEqual({ 0: "rejected", 1: "pending", 2: "rejected" });
  }));

  it("reports nothing to reject", () => withWorkspace(async ws => {
    expect(await reject(ws)).toEqual({ outcome: "Rejected 0 pending actions; 0 remain." });
  }));
});

// Seeds a pending creation of GATEKEEPER_ID with two actions queued on it, and one pending action
// on the other connection.
function seedCreation(ws: Workspace) {
  putCreation(ws, 0, GATEKEEPER_ID);
  for (let id of [1, 2]) putAction(ws.impl.storage, id, { gatekeeperId: GATEKEEPER_ID });
  putAction(ws.impl.storage, 3, { gatekeeperId: OTHER_GATEKEEPER_ID });
  return { facet: fakeFacet(ws), removeGatekeeper: vi.spyOn(ws.impl, "removeGatekeeper") };
}

describe("rejectPendingActions and a pending creation", () => {
  it("removes the creation's connection and rejects what was queued on it",
      () => withWorkspace(async ws => {
    let { facet, removeGatekeeper } = seedCreation(ws);

    expect(await reject(ws)).toEqual({
      outcome: "Rejected 4 pending actions; 0 remain. " +
          "Connections removed with a rejected creation: 1.",
    });

    expect(ws.impl.storage.gatekeepers.get(GATEKEEPER_ID)).toBeUndefined();
    expect(removeGatekeeper.mock.calls).toEqual([[GATEKEEPER_ID]]);
    for (let id of [0, 1, 2, 3]) {
      expect(ws.impl.storage.actions.get(id))
          .toMatchObject({ state: "rejected", resolvedBy: ADMIN_PROFILE });
    }
    // Only the other connection's gatekeeper is told: the creation's was never created.
    expect(facet.asked).toStrictEqual([OTHER_GATEKEEPER_ID]);
    expect(facet.rejected).toStrictEqual([3]);
  }));

  it("leaves another connection's action pending when given the creation's connection",
      () => withWorkspace(async ws => {
    let { facet } = seedCreation(ws);

    expect(await reject(ws, { gatekeeperId: GATEKEEPER_ID })).toEqual({
      outcome: "Rejected 3 pending actions; 0 remain. " +
          "Connections removed with a rejected creation: 1.",
    });
    expect(actionStates(ws)).toEqual({ 0: "rejected", 1: "rejected", 2: "rejected", 3: "pending" });
    expect(facet.asked).toStrictEqual([]);
  }));

  it("rejects everything queued behind a creation, however much", () => withWorkspace(async ws => {
    putCreation(ws, 0, GATEKEEPER_ID);
    let queued = MAX_ADMIN_REJECTED_ACTIONS + 1;
    for (let id = 1; id <= queued; id++) {
      putAction(ws.impl.storage, id, { gatekeeperId: GATEKEEPER_ID });
    }
    let facet = fakeFacet(ws);

    // The bound is on the rejections made one by one.
    expect(await reject(ws)).toEqual({
      outcome: "Rejected 502 pending actions; 0 remain. " +
          "Connections removed with a rejected creation: 1.",
    });
    expect(Object.values(actionStates(ws))).toStrictEqual(Array(queued + 1).fill("rejected"));
    expect(facet.asked).toStrictEqual([]);
  }));
});

// Records when the audit log is appended to, when an action record is put and when it changes.
function recordOrder(ws: Workspace, append: () => Promise<void> = async () => {}): string[] {
  let events: string[] = [];
  ws.impl.adminAudits = {
    getByName: () => ({ append: async () => { events.push("audit"); await append(); } }),
  };
  ws.impl.storage.actions.subscribe({
    add: () => events.push("entry"),
    update: () => events.push("entry changed"),
    remove: () => events.push("entry removed"),
  });
  return events;
}

describe("the order of a write", () => {
  it.each<[AdminWriteAction, AdminWriteArgs, string]>([
    ["stopAgent", { chatId: CHAT_ID }, "cancelAgent"],
    ["deleteChat", { chatId: CHAT_ID }, "deleteChat"],
  ])("%s is recorded, then entered in the action log, then run", (action, args, operation) =>
      withWorkspace(async ws => {
    let events = recordOrder(ws);
    vi.spyOn(ws.impl, operation).mockImplementation(async () => { events.push("effect"); });

    await ws.instance.applyAdminWrite(grantOf(action, args));

    expect(events).toStrictEqual(["audit", "entry", "effect"]);
  }));

  it("changes nothing when the record cannot be written", () => withWorkspace(async ws => {
    let before = stored(ws);
    let events = recordOrder(ws, async () => { throw new Error("The audit log is unavailable"); });
    let effect = vi.spyOn(ws.impl, "deleteChat");

    await expect(ws.instance.applyAdminWrite(grantOf("deleteChat", { chatId: CHAT_ID })))
        .rejects.toThrow("The audit log is unavailable");

    // No entry and no effect.
    expect(events).toStrictEqual(["audit"]);
    expect(effect).not.toHaveBeenCalled();
    expect(stored(ws)).toStrictEqual(before);
  }));

  it("writes no record for a workspace deleted while its owner and the approver are read",
      () => withWorkspace(async ws => {
    let before = stored(ws);
    let events = recordOrder(ws);
    let effect = vi.spyOn(ws.impl, "deleteChat");
    // The approver's profile is the last read before the record. A deletion unsets impl.ownerId.
    let { getByName } = ws.impl.users;
    ws.impl.users.getByName = (name: string) => ({
      ...getByName(name),
      whoamiIfExists: async () => {
        ws.impl.ownerId = undefined;
        return ADMIN_PROFILE;
      },
    });

    expect(await codeOf(ws.instance.applyAdminWrite(grantOf("deleteChat", { chatId: CHAT_ID }))))
        .toBe(ADMIN_ACCESS_ERROR_CODES.workspaceNotFound);

    // No record, no entry and no effect.
    expect(events).toStrictEqual([]);
    expect(effect).not.toHaveBeenCalled();
    expect(stored(ws)).toStrictEqual(before);
  }));

  it("writes the record and nothing else for a workspace deleted while it is appended",
      () => withWorkspace(async ws => {
    let before = stored(ws);
    let events = recordOrder(ws, async () => { ws.impl.ownerId = undefined; });
    let effect = vi.spyOn(ws.impl, "deleteChat");

    expect(await codeOf(ws.instance.applyAdminWrite(grantOf("deleteChat", { chatId: CHAT_ID }))))
        .toBe(ADMIN_ACCESS_ERROR_CODES.workspaceNotFound);

    // The record stands; the workspace's action log gains no entry, and nothing runs.
    expect(events).toStrictEqual(["audit"]);
    expect(effect).not.toHaveBeenCalled();
    expect(stored(ws)).toStrictEqual(before);
  }));
});

describe("the record of a write", () => {
  it("is an approved write record, with the workspace's own title and owner",
      () => withWorkspace(async ws => {
    let grant = grantOf("rejectPendingActions", { gatekeeperId: OTHER_GATEKEEPER_ID },
        { requestedBy: REQUESTER, via: "cli", reason: `  ${REASON}  ` });
    let before = Date.now();

    await ws.instance.applyAdminWrite(grant);

    let records = await deploymentRecords(ws);
    expect(records).toEqual([{
      kind: "write", event: "approved", at: expect.any(Date),
      admin: ADMIN, sessionId: SESSION_ID, via: "cli", requestId: grant.requestId,
      workspaceId: ws.id, workspaceOwner: OWNER.id, workspaceTitle: "Quarterly plan",
      method: "rejectPendingActions", args: { gatekeeperId: OTHER_GATEKEEPER_ID },
      reason: REASON, requestedBy: REQUESTER, passkey: PASSKEY,
    }]);
    expect(records[0].at.getTime()).toBeGreaterThanOrEqual(before);
  }));

  it("cuts a long title before the record leaves the workspace", () => withWorkspace(async ws => {
    ws.impl.storage.title.put("t".repeat(2000));
    // The record as the workspace sends it: the log cuts a title too.
    let sent: AdminWriteRecord[] = [];
    ws.impl.adminAudits = {
      getByName: () => ({ append: async (record: AdminWriteRecord) => { sent.push(record); } }),
    };

    await ws.instance.applyAdminWrite(grantOf("stopAgent", { chatId: CHAT_ID }));

    expect(sent.map(record => record.workspaceTitle))
        .toStrictEqual([`${"t".repeat(MAX_ADMIN_AUDIT_ARG_LENGTH - 1)}…`]);
  }));
});

describe("the entry of a write in the workspace's action log", () => {
  it("is read by the owner as an admin's approved action, which they cannot decide",
      () => withWorkspace(async ws => {
    let grant = grantOf("stopAgent", { chatId: CHAT_ID });
    await asOwner(ws, async client => {
      // A subscription of an open "build" session is delivered the entry.
      using subscriber = actionSubscriber();
      let subscription = await client.subscribeToActions(subscriber.stub);

      await ws.instance.applyAdminWrite(grant);

      let { entries } = await client.listActions();
      expect(entries).toEqual([{
        id: expect.any(Number), type: "action", byAdmin: true, state: "approved",
        gatekeeperId: undefined, resourceTitle: "Deployment admin", resourceUrl: undefined,
        createdAt: expect.any(Date), appliedAt: expect.any(Date),
        resolvedBy: ADMIN_PROFILE, autoApproved: undefined, creation: undefined,
        description: {
          title: `Stop the agent in chat ${CHAT_ID}`,
          description:
              "A deployment admin's change to this workspace, through an approved write request.",
          fields: [
            { label: "Reason", kind: "text", value: REASON },
            { label: "Request", kind: "inline", value: grant.requestId },
          ],
          descriptionIsComplete: true, implementsRevert: false, autoApprovable: false,
        },
      }]);
      let [entry] = entries;
      expect(entry.gatekeeperId).toBeUndefined();
      await vi.waitFor(() => expect(subscriber.delivered).toEqual([entry]));

      // It was never pending, so neither decision reaches a gatekeeper.
      let notPending = `Action is not pending: ${entry.id}`;
      await expect(client.approveAction(entry.id)).rejects.toThrow(notPending);
      await expect(client.rejectAction(entry.id)).rejects.toThrow(notPending);
      (subscription as unknown as Disposable)[Symbol.dispose]();
    });
  }));

  it("is approved while the operation runs, and rejected once it has thrown",
      () => withWorkspace(async ws => {
    let during: ActionLogEntry[] = [];
    vi.spyOn(ws.impl, "deleteChat").mockImplementation(async () => {
      during = await adminEntries(ws);
      // Lets the clock move on, so that the change of state is later than the entry.
      await scheduler.wait(20);
      throw new Error("The chat could not be deleted");
    });

    await expect(ws.instance.applyAdminWrite(grantOf("deleteChat", { chatId: CHAT_ID })))
        .rejects.toThrow("The chat could not be deleted");

    expect(during).toMatchObject([{ state: "approved", byAdmin: true }]);
    let [entry] = await adminEntries(ws);
    expect(entry).toMatchObject({
      id: during[0].id, state: "rejected", byAdmin: true, resolvedBy: ADMIN_PROFILE,
      description: { title: `Delete chat ${CHAT_ID}` },
    });
    expect(entry.appliedAt!.getTime()).toBeGreaterThan(during[0].appliedAt!.getTime());
    expect(entry.createdAt).toEqual(during[0].createdAt);
  }));

  it("gives an inspection its title and state, and withholds its fields",
      () => withWorkspace(async ws => {
    await ws.instance.applyAdminWrite(grantOf("stopAgent", { chatId: CHAT_ID }));
    let [entry] = await adminEntries(ws);

    // At "metadata", the deployment's level here.
    let view = await ws.instance.openForAdmin(ADMIN, "Looking into ticket 42", "view-session", {
      via: "api", expiresAt: new Date(Date.now() + 60 * 1000),
    });
    let { entries } = await view.listActions();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: entry.id, type: "action", byAdmin: true, state: "approved", resolvedBy: ADMIN_PROFILE,
      description: { title: `Stop the agent in chat ${CHAT_ID}`, description: "" },
    });
    expect(entries[0].description).not.toHaveProperty("fields");

    // An admin's reason is content to a later inspection, as any action's fields are: withheld.
    let withheld = withholdActionContent(entry);
    expect(withheld).toMatchObject({ byAdmin: true, description: { description: "" } });
    expect(withheld.description).not.toHaveProperty("fields");
  }));

  it("is not written again once it is gone, when the operation throws",
      () => withWorkspace(async ws => {
    let recordAdminWrite = vi.spyOn(ws.impl, "recordAdminWrite");
    let gone: [string, unknown][] = [];
    vi.spyOn(ws.impl, "deleteChat").mockImplementation(async () => {
      // As the action log of a workspace deleted while the write runs goes with it.
      ws.impl.storage.actions.delete(recordAdminWrite.mock.results[0].value as number);
      gone = stored(ws);
      throw new Error("The chat could not be deleted");
    });

    await expect(ws.instance.applyAdminWrite(grantOf("deleteChat", { chatId: CHAT_ID })))
        .rejects.toThrow("The chat could not be deleted");

    expect(stored(ws)).toStrictEqual(gone);
  }));
});

const VIEWER: AiChatAuthorInfo = { type: "user", id: "viewer@example.test", name: "Viewer" };

// Runs `fn` over a real "use" session on the workspace: a collaborator who only uses a gadget.
async function asUseViewer<T>(ws: Workspace, fn: (client: Overseer) => Promise<T>): Promise<T> {
  ws.accounts.set(VIEWER.id, VIEWER);
  // What open() consults for someone who is not the owner: their access, and the sharing manager,
  // which it reaches only to redeem a share key.
  let authorize = vi.spyOn(ws.impl, "authorizeCollaborator")
      .mockResolvedValue({ role: "use", gadgetIds: "all" });
  let sharing = vi.spyOn(ws.impl, "getSharingManager").mockResolvedValue({});
  try {
    using notifyClosed = new NativeRpcStub<() => void>(() => {});
    using client = await ws.instance.open(userIdOf(VIEWER.id), VIEWER.id, notifyClosed);
    return await fn(client);
  } finally {
    authorize.mockRestore();
    sharing.mockRestore();
  }
}

describe("who is shown a write", () => {
  it("shows a session that only uses a gadget nothing", () => withWorkspace(async ws => {
    await asUseViewer(ws, async client => {
      using subscriber = actionSubscriber();
      let subscription = await client.subscribeToActions(subscriber.stub);

      await ws.instance.applyAdminWrite(grantOf("deleteChat", { chatId: CHAT_ID }));
      expect(ws.impl.storage.chatMeta.get(CHAT_ID)).toBeUndefined();

      expect(await client.listActions()).toEqual({ entries: [] });
      expect(await client.listActions({ filter: "all" })).toEqual({ entries: [] });
      // Long enough for a delivery to have arrived, had one been made.
      await scheduler.wait(50);
      expect(subscriber.delivered).toStrictEqual([]);
      (subscription as unknown as Disposable)[Symbol.dispose]();
    });

    // Only the owner and "build" collaborators read it.
    expect(await adminEntries(ws)).toMatchObject([{
      byAdmin: true, state: "approved", description: { title: `Delete chat ${CHAT_ID}` },
    }]);
  }));
});
