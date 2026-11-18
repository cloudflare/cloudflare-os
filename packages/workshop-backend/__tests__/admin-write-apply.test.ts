// An admin write as its workspace runs it (OverseerDurableObject.applyAdminWrite()): what it
// refuses before writing or recording anything, that the record comes before the effect, which
// operation each action runs and with what, and that the workspace keeps no note of it. Then a
// grant to read the workspace's content that a second admin approved
// (OverseerDurableObject.grantAdminContent()), which enters nothing in the action log, and its
// ending by an admin (OverseerDurableObject.endAdminGrant()).
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
  ADMIN_ACCESS_ERROR_CODES, ADMIN_GRANT_ERROR_CODES, ADMIN_GRANT_LIFETIME_SECONDS,
  MAX_ADMIN_AUDIT_ARG_LENGTH, getAdminAccessErrorCode, getAdminGrantErrorCode,
  type ActionLogEntry, type AdminAccessGrant, type AdminAuditRecord, type AdminGrantRecord,
  type AdminWriteAction, type AdminWriteArgs, type AdminWriteRecord,
  type AiChatAuthorInfo, type Overseer,
} from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { AdminAuditDurableObject } from "../src/admin-audit.js";
import type { AdminWriteCall } from "../src/admin-writes.js";
import { namedUser, type AdminContentGrantCall, type AdminGrantActor } from "../src/admin-access.js";
import { ADMIN_CONFIG_KEY } from "../src/storage-schema/blueprints-kv.js";
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
// A second admin, whom the tests' environment adds: the requester of a content access request.
const REQUESTER = "requester-admin@example.test";
const ADMIN_PROFILE: AiChatAuthorInfo = { type: "user", id: ADMIN, name: "Ada Admin" };
const OWNER: AiChatAuthorInfo = { type: "user", id: "owner@example.test", name: "Owner" };
const BOB: AiChatAuthorInfo = { type: "user", id: "bob@example.test", name: "Bob" };
const AGENT: AiChatAuthorInfo = { type: "agent", id: "first-model", name: "First" };
const REASON = "Support ticket 42";
const SESSION_ID = "admin-session";
// The pool sets no ADMIN_AUDIT_RETENTION_MIN_DAYS, so retention is at least 90 days.
const RETENTION = 90;

const CHAT_ID = 1;

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
}

// A write as AdminApiImpl.writeWorkspace() hands one over: made by ADMIN.
function callOf(action: AdminWriteAction, args: AdminWriteArgs = {},
                overrides: Partial<AdminWriteCall> = {}): AdminWriteCall {
  return {
    action, args, reason: REASON, admin: ADMIN, sessionId: SESSION_ID, via: "api", ...overrides,
  };
}

// The code a call is refused with, of either family.
async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return getAdminAccessErrorCode(err) ?? getAdminGrantErrorCode(err) ?? `uncoded: ${String(err)}`;
  }
  throw new Error("Expected a refusal.");
}

// The deployment-wide log's write records for this workspace, oldest first.
async function deploymentRecords(ws: Workspace): Promise<AdminWriteRecord[]> {
  return (await workspaceRecords(ws)).filter(record => record.kind === "write");
}

// The deployment-wide log's grant records for this workspace, oldest first.
async function grantRecords(ws: Workspace): Promise<AdminGrantRecord[]> {
  return (await workspaceRecords(ws)).filter(record => record.kind === "grant");
}

// Every record the deployment-wide log holds for this workspace, oldest first.
async function workspaceRecords(ws: Workspace): Promise<AdminAuditRecord[]> {
  let page = await env.TEST_ADMIN_AUDIT.getByName("")
      .list({ workspace: ws.id, limit: 200 }, RETENTION);
  return page.records.toReversed();
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

describe("refusals that write and record nothing", () => {
  it("refuses an uninitialised workspace without initialising it", () => withWorkspace(async ws => {
    expect(await codeOf(ws.instance.applyAdminWrite(callOf("restartWorkspace"))))
        .toBe(ADMIN_ACCESS_ERROR_CODES.workspaceNotFound);
    expect(stored(ws)).toStrictEqual([]);
    expect(await deploymentRecords(ws)).toStrictEqual([]);
  }, { seed: false }));

  it("refuses an admin who is no longer one", () => withWorkspace(async ws => {
    let before = stored(ws);
    expect(await codeOf(ws.instance.applyAdminWrite(
        callOf("stopAgent", { chatId: CHAT_ID }, { admin: OWNER.id }))))
        .toBe(ADMIN_ACCESS_ERROR_CODES.notAdmin);
    expect(stored(ws)).toStrictEqual(before);
    expect(await deploymentRecords(ws)).toStrictEqual([]);

    // The admin's own call runs.
    await ws.instance.applyAdminWrite(callOf("stopAgent", { chatId: CHAT_ID }));
    expect(await deploymentRecords(ws)).toMatchObject([{ admin: ADMIN }]);
  }));

  it.each([
    ["unset", undefined], ["off", "off"], ["a value that is not \"on\"", "true"],
  ])("refuses while ADMIN_WORKSPACE_WRITES is %s", (_name, value) => withWorkspace(async ws => {
    // Set only through the OverseerImpl's environment, the one the write path may read.
    setEnv(ws, { ADMIN_WORKSPACE_WRITES: value });
    let before = stored(ws);
    expect(await codeOf(ws.instance.applyAdminWrite(callOf("stopAgent", { chatId: CHAT_ID }))))
        .toBe(ADMIN_ACCESS_ERROR_CODES.writesOff);
    expect(stored(ws)).toStrictEqual(before);
    expect(await deploymentRecords(ws)).toStrictEqual([]);
  }));

  it.each([
    ["a blank reason", {}, { reason: "   " }],
    ["a via that is neither api nor cli", {}, { via: "browser" }],
    ["arguments the action does not take", { gadgetId: 3 }, {}],
    ["a missing argument", { chatId: undefined }, {}],
  ])("rejects a call with %s", (_name, args, overrides) => withWorkspace(async ws => {
    let before = stored(ws);
    let call = callOf("stopAgent", { chatId: CHAT_ID, ...args } as AdminWriteArgs,
        overrides as unknown as Partial<AdminWriteCall>);
    await expect(ws.instance.applyAdminWrite(call)).rejects.toBeInstanceOf(TypeError);
    expect(stored(ws)).toStrictEqual(before);
    expect(await deploymentRecords(ws)).toStrictEqual([]);
  }));
});

// The operations a write may run, each replaced by a recorder that does nothing.
const OPERATIONS = ["cancelAgent", "scheduleAccessRestart"] as const;

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
    ["restartWorkspace", {}, { scheduleAccessRestart: [["Gadget restarted."]] }],
  ])("%s", (action, args, expected) => withWorkspace(async ws => {
    let spies = spyOnOperations(ws);

    await ws.instance.applyAdminWrite(callOf(action, args));

    // Exactly that operation, with exactly those arguments, and no other.
    for (let [name, spy] of Object.entries(spies)) {
      expect(spy.mock.calls, name).toEqual(expected[name] ?? []);
    }
  }));

  it("throws the operation's own error for an unknown chat", () => withWorkspace(async ws => {
    let apply = (action: AdminWriteAction, args: AdminWriteArgs) =>
        ws.instance.applyAdminWrite(callOf(action, args));
    await expect(apply("stopAgent", { chatId: 99 })).rejects.toThrow("No such chatId: 99");

    // It was recorded before it failed, and the record stays.
    expect((await deploymentRecords(ws)).map(record => record.method))
        .toStrictEqual(["stopAgent"]);
  }));
});

// The chat's messages, oldest first.
function messagesOf(ws: Workspace): any[] {
  return [...ws.impl.storage.chats.list()];
}

describe("the effect of a write", () => {
  it("stopAgent on an idle chat succeeds", () => withWorkspace(async ws => {
    await ws.instance.applyAdminWrite(callOf("stopAgent", { chatId: CHAT_ID }));
    expect((await deploymentRecords(ws)).map(record => record.method))
        .toStrictEqual(["stopAgent"]);
  }));

  it("stopAgent keeps the messages queued for the turn it stops, as their senders' own, and " +
      "stops it as a member's stop would",
      () => withWorkspace(async ws => {
    // A turn at work, with two messages the agent has not read: no client stops it, so none
    // would put them in a draft.
    ws.impl.storage.chatMeta.put({
      ...ws.impl.storage.chatMeta.get(CHAT_ID),
      activeAgent: AGENT,
      queuedSteers: [
        { text: "Also add a streak counter.", author: BOB },
        { text: "And make it dark.", author: OWNER },
      ],
    });

    await ws.instance.applyAdminWrite(callOf("stopAgent", { chatId: CHAT_ID }));

    let meta = ws.impl.storage.chatMeta.get(CHAT_ID);
    expect(meta.queuedSteers).toBeUndefined();
    expect(meta.activeAgent).toBeUndefined();
    // Before the stop itself, in the order they were sent.
    expect(messagesOf(ws).slice(0, 3)).toMatchObject([
      { author: BOB, type: "message", message: "Also add a streak counter.", steered: true },
      { author: OWNER, type: "message", message: "And make it dark.", steered: true },
      { author: AGENT, type: "agentNudge" },
    ]);
    // Stop's boundary tells the model nothing.
    expect(messagesOf(ws)[2]).not.toHaveProperty("text");
  }));
});

// Records when the audit log is appended to, and when an action record is put, changed or removed,
// which a write never does.
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
    ["restartWorkspace", {}, "scheduleAccessRestart"],
  ])("%s is recorded, then run", (action, args, operation) =>
      withWorkspace(async ws => {
    let events = recordOrder(ws);
    vi.spyOn(ws.impl, operation).mockImplementation(() => { events.push("effect"); });

    await ws.instance.applyAdminWrite(callOf(action, args));

    expect(events).toStrictEqual(["audit", "effect"]);
  }));

  it("changes nothing when the record cannot be written", () => withWorkspace(async ws => {
    let before = stored(ws);
    let events = recordOrder(ws, async () => { throw new Error("The audit log is unavailable"); });
    let effect = vi.spyOn(ws.impl, "cancelAgent");

    await expect(ws.instance.applyAdminWrite(callOf("stopAgent", { chatId: CHAT_ID })))
        .rejects.toThrow("The audit log is unavailable");

    // No effect.
    expect(events).toStrictEqual(["audit"]);
    expect(effect).not.toHaveBeenCalled();
    expect(stored(ws)).toStrictEqual(before);
  }));

  it("writes no record for a workspace deleted while its owner is read",
      () => withWorkspace(async ws => {
    let before = stored(ws);
    let events = recordOrder(ws);
    let effect = vi.spyOn(ws.impl, "cancelAgent");
    // The owner is the last read before the record. A deletion unsets impl.ownerId.
    vi.spyOn(ws.impl, "getOwnerProfileId").mockImplementation(async () => {
      ws.impl.ownerId = undefined;
      return OWNER.id;
    });

    expect(await codeOf(ws.instance.applyAdminWrite(callOf("stopAgent", { chatId: CHAT_ID }))))
        .toBe(ADMIN_ACCESS_ERROR_CODES.workspaceNotFound);

    // No record and no effect.
    expect(events).toStrictEqual([]);
    expect(effect).not.toHaveBeenCalled();
    expect(stored(ws)).toStrictEqual(before);
  }));

  it("writes the record and nothing else for a workspace deleted while it is appended",
      () => withWorkspace(async ws => {
    let before = stored(ws);
    let events = recordOrder(ws, async () => { ws.impl.ownerId = undefined; });
    let effect = vi.spyOn(ws.impl, "cancelAgent");

    expect(await codeOf(ws.instance.applyAdminWrite(callOf("stopAgent", { chatId: CHAT_ID }))))
        .toBe(ADMIN_ACCESS_ERROR_CODES.workspaceNotFound);

    // The record stands, and nothing runs.
    expect(events).toStrictEqual(["audit"]);
    expect(effect).not.toHaveBeenCalled();
    expect(stored(ws)).toStrictEqual(before);
  }));
});

describe("the record of a write", () => {
  it("is one write record, with the workspace's own title and owner",
      () => withWorkspace(async ws => {
    let before = Date.now();

    await ws.instance.applyAdminWrite(
        callOf("stopAgent", { chatId: CHAT_ID }, { via: "cli", reason: `  ${REASON}  ` }));

    let records = await deploymentRecords(ws);
    expect(records).toEqual([{
      kind: "write", at: expect.any(Date), admin: ADMIN, sessionId: SESSION_ID, via: "cli",
      workspaceId: ws.id, workspaceOwner: OWNER.id, workspaceTitle: "Quarterly plan",
      method: "stopAgent", args: { chatId: CHAT_ID }, reason: REASON,
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

    await ws.instance.applyAdminWrite(callOf("stopAgent", { chatId: CHAT_ID }));

    expect(sent.map(record => record.workspaceTitle))
        .toStrictEqual([`${"t".repeat(MAX_ADMIN_AUDIT_ARG_LENGTH - 1)}…`]);
  }));
});

describe("what the workspace keeps of a write", () => {
  it.each<[AdminWriteAction, AdminWriteArgs]>([
    ["stopAgent", { chatId: CHAT_ID }],
    ["restartWorkspace", {}],
  ])("keeps no entry of %s in its action log, and tells its sessions of none",
      (action, args) => withWorkspace(async ws => {
    // The restart would end the session reading the log.
    vi.spyOn(ws.impl, "scheduleAccessRestart").mockImplementation(async () => undefined);
    await asOwner(ws, async client => {
      using subscriber = actionSubscriber();
      let subscription = await client.subscribeToActions(subscriber.stub);

      await ws.instance.applyAdminWrite(callOf(action, args));

      expect(await client.listActions({ filter: "all" })).toEqual({ entries: [] });
      // Long enough for a delivery to have arrived, had one been made.
      await scheduler.wait(50);
      expect(subscriber.delivered).toStrictEqual([]);
      (subscription as unknown as Disposable)[Symbol.dispose]();
    });
    expect([...ws.impl.storage.actions.list()]).toStrictEqual([]);
    // The deployment-wide record is the write's only trace.
    expect((await deploymentRecords(ws)).map(record => record.method)).toStrictEqual([action]);
  }));
});

// --- A grant to read the workspace's content, approved by a second admin ---

const DAY_MS = 24 * 60 * 60 * 1000;
const REQUESTER_PROFILE: AiChatAuthorInfo = { type: "user", id: REQUESTER, name: "Rex Requester" };
// The prefix of the keys the workspace stores its grants under.
const GRANT_KEYS = "adminGrants:";

// Sets impl.env as setEnv() does, with the level in force at "content": the cap and the admins'
// choice both say so.
function setContentLevel(ws: Workspace, vars: Record<string, unknown> = {}): void {
  let config = JSON.stringify(
      { adminWorkspaceAccess: "content", adminAuditRetentionDays: RETENTION });
  setEnv(ws, {
    ADMIN_WORKSPACE_ACCESS_MAX: "content",
    BLUEPRINTS: { get: async (key: string) => key === ADMIN_CONFIG_KEY ? config : null },
    ...vars,
  });
}

// A workspace as withWorkspace() seeds it, on a deployment whose level in force is "content".
function withContentWorkspace(fn: (ws: Workspace) => Promise<void>): Promise<void> {
  return withWorkspace(async ws => {
    setContentLevel(ws);
    ws.accounts.set(REQUESTER, REQUESTER_PROFILE);
    await fn(ws);
  });
}

// A claimed content access request as AdminApiImpl.approveContentAccess() hands one over: asked
// for by REQUESTER, approved by ADMIN.
function contentGrantOf(overrides: Partial<AdminContentGrantCall> = {}): AdminContentGrantCall {
  return {
    requestId: `request-${crypto.randomUUID()}`, requestedBy: REQUESTER, reason: REASON,
    workspaceOwner: OWNER.id, admin: ADMIN, sessionId: SESSION_ID, via: "api", ...overrides,
  };
}

// The grants the workspace stores, in no particular order.
function storedGrants(ws: Workspace): AdminAccessGrant[] {
  return [...ws.impl.storage.adminGrants.list()];
}

// Everything the workspace stores but its grants.
function storedBesidesGrants(ws: Workspace): [string, unknown][] {
  return stored(ws).filter(([key]) => !key.startsWith(GRANT_KEYS));
}

// A stored grant given an hour ago and live for another, with `overrides`: an approval's unless
// they say otherwise.
function putGrant(ws: Workspace, overrides: Partial<AdminAccessGrant> = {}): AdminAccessGrant {
  let grant: AdminAccessGrant = {
    id: crypto.randomUUID(), level: "content", source: "admins", scope: "workspace",
    grantedBy: namedUser(ADMIN_PROFILE), requestedBy: REQUESTER,
    requestId: `request-${crypto.randomUUID()}`, reason: REASON,
    grantedAt: new Date(Date.now() - 60 * 60 * 1000),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    ...overrides,
  };
  ws.impl.storage.adminGrants.put(grant);
  return grant;
}

// A grant the workspace's owner gave, as it is stored.
function putOwnerGrant(ws: Workspace, overrides: Partial<AdminAccessGrant> = {}): AdminAccessGrant {
  return putGrant(ws, {
    source: "owner", grantedBy: namedUser(OWNER), requestedBy: undefined, requestId: undefined,
    reason: undefined, ...overrides,
  });
}

// The names of the calls made to any account from here on, in order.
function accountCalls(ws: Workspace): string[] {
  let calls: string[] = [];
  let users = ws.impl.users;
  let recorded = (user: object) => new Proxy(user, {
    get: (target, key) => {
      let value = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls.push(String(key));
        return value(...args);
      };
    },
  });
  ws.impl.users = {
    ...users,
    get: (id: string) => recorded(users.get(id)),
    getByName: (name: string) => recorded(users.getByName(name)),
  };
  return calls;
}

describe("grantAdminContent", () => {
  it("stores a grant from the approver for the request, and resolves its id",
      () => withContentWorkspace(async ws => {
    let grant = contentGrantOf({ reason: `  ${REASON}  ` });
    let before = Date.now();

    let { grantId } = await ws.instance.grantAdminContent(grant);

    let [kept] = storedGrants(ws);
    expect(storedGrants(ws)).toStrictEqual([{
      id: expect.any(String), level: "content", source: "admins", scope: "workspace",
      // The approver, as a record names a user: an id and a name, and no other profile field.
      grantedBy: { id: ADMIN, name: "Ada Admin" },
      requestedBy: REQUESTER, requestId: grant.requestId, reason: REASON,
      grantedAt: expect.any(Date), expiresAt: expect.any(Date),
    }]);
    expect(kept.grantedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(kept.expiresAt.getTime())
        .toBe(kept.grantedAt.getTime() + ADMIN_GRANT_LIFETIME_SECONDS * 1000);
    expect(grantId).toBe(kept.id);

    // The one record is the approval's. It names the grant, so the calls made under it lead back
    // to the approval.
    expect(await workspaceRecords(ws)).toEqual([{
      kind: "grant", method: "approveContentAccess", at: expect.any(Date),
      admin: ADMIN, sessionId: SESSION_ID, via: "api", requestId: grant.requestId,
      workspaceId: ws.id, workspaceOwner: OWNER.id, workspaceTitle: "Quarterly plan",
      reason: REASON, requestedBy: REQUESTER, grantId: kept.id,
    }]);
  }));

  it("lets a content call answer, and is listed where admins inspect the workspace",
      () => withContentWorkspace(async ws => {
    let view = await ws.instance.openForAdmin(ADMIN, "Looking into ticket 42", "view-session", {
      via: "api", access: "content", expiresAt: new Date(Date.now() + 60 * 1000),
    });
    expect(await codeOf(view.getChat(CHAT_ID))).toBe(ADMIN_ACCESS_ERROR_CODES.grantRequired);
    expect((await view.describe()).grants).toStrictEqual([]);

    await ws.instance.grantAdminContent(contentGrantOf());

    let [kept] = storedGrants(ws);
    expect((await view.describe()).grants).toStrictEqual([kept]);
    await expect(view.getChat(CHAT_ID)).resolves.toBeDefined();
    let page = await env.TEST_ADMIN_AUDIT.getByName("")
        .list({ workspace: ws.id, method: "getChat", limit: 200 }, RETENTION);
    expect(page.records).toMatchObject([
      { method: "getChat", grantId: kept.id },
      { method: "getChat", refused: ADMIN_ACCESS_ERROR_CODES.grantRequired },
    ]);
  }));

  it("ends the live admins' grant it replaces, as ended by the approver, and leaves the owner's",
      () => withContentWorkspace(async ws => {
    let replaced = putGrant(ws);
    let owners = putOwnerGrant(ws);
    let ended = putGrant(ws, { revokedAt: new Date(Date.now() - 1000), revokedBy: namedUser(OWNER) });

    let { grantId } = await ws.instance.grantAdminContent(contentGrantOf());

    let byId = new Map(storedGrants(ws).map(grant => [grant.id, grant]));
    expect(byId.get(replaced.id)).toStrictEqual(
        { ...replaced, revokedAt: expect.any(Date), revokedBy: { id: ADMIN, name: "Ada Admin" } });
    expect(byId.get(owners.id)).toStrictEqual(owners);
    expect(byId.get(ended.id)).toStrictEqual(ended);
    expect(ws.impl.liveAdminGrants().map(grant => grant.id).toSorted())
        .toStrictEqual([grantId, owners.id].toSorted());
    // The approval's record names the grant it ended.
    expect(await workspaceRecords(ws)).toMatchObject(
        [{ method: "approveContentAccess", grantId, replacedGrantId: replaced.id }]);
  }));

  it("is recorded, then stored, and enters nothing in the action log",
      () => withContentWorkspace(async ws => {
    let events = recordOrder(ws, async () => {
      expect(storedGrants(ws)).toStrictEqual([]);
    });

    await ws.instance.grantAdminContent(contentGrantOf());

    expect(events).toStrictEqual(["audit"]);
    expect(storedGrants(ws)).toHaveLength(1);
  }));

  it("stores nothing when the record cannot be written", () => withContentWorkspace(async ws => {
    let before = stored(ws);
    recordOrder(ws, async () => { throw new Error("The audit log is unavailable"); });

    await expect(ws.instance.grantAdminContent(contentGrantOf()))
        .rejects.toThrow("The audit log is unavailable");

    expect(stored(ws)).toStrictEqual(before);
  }));

  it("refuses an approver who is the requester, before any record",
      () => withContentWorkspace(async ws => {
    let before = stored(ws);
    expect(await codeOf(ws.instance.grantAdminContent(contentGrantOf({ requestedBy: ADMIN }))))
        .toBe(ADMIN_GRANT_ERROR_CODES.secondAdminRequired);
    expect(stored(ws)).toStrictEqual(before);
    expect(await workspaceRecords(ws)).toStrictEqual([]);
  }));

  it.each([
    ["an approver", { admin: OWNER.id }],
    ["a requester", { requestedBy: "former-admin@example.test" }],
  ] as const)("refuses %s who is not an admin, before any record", (_name, overrides) =>
      withContentWorkspace(async ws => {
    let before = stored(ws);
    expect(await codeOf(ws.instance.grantAdminContent(contentGrantOf(overrides))))
        .toBe(ADMIN_ACCESS_ERROR_CODES.notAdmin);
    expect(stored(ws)).toStrictEqual(before);
    expect(await workspaceRecords(ws)).toStrictEqual([]);
  }));

  it("refuses a request naming another owner than the workspace's, before any record",
      () => withContentWorkspace(async ws => {
    let before = stored(ws);
    let refused = ws.instance.grantAdminContent(contentGrantOf({ workspaceOwner: BOB.id }));
    // Its own code: the workspace is alive, and `workspaceNotFound` would drop it from the
    // directory.
    expect(await codeOf(refused)).toBe(ADMIN_GRANT_ERROR_CODES.workspaceChanged);
    expect(stored(ws)).toStrictEqual(before);
    expect(await workspaceRecords(ws)).toStrictEqual([]);
  }));

  it("refuses a bad reason and a bad via, before any record",
      () => withContentWorkspace(async ws => {
    let before = stored(ws);
    for (let overrides of [{ reason: "   " }, { via: "agent" as any }]) {
      await expect(ws.instance.grantAdminContent(contentGrantOf(overrides)))
          .rejects.toBeInstanceOf(TypeError);
    }
    expect(stored(ws)).toStrictEqual(before);
    expect(await workspaceRecords(ws)).toStrictEqual([]);
  }));

  it("is given whatever ADMIN_WORKSPACE_WRITES says: it is not a write",
      () => withContentWorkspace(async ws => {
    setContentLevel(ws, { ADMIN_WORKSPACE_WRITES: "off" });
    await ws.instance.grantAdminContent(contentGrantOf());
    expect(storedGrants(ws)).toHaveLength(1);
  }));

  it("takes two accounts that one entry of ADMINS matches for one admin",
      () => withContentWorkspace(async ws => {
    setContentLevel(ws, { ADMINS: ["alice@example.com", "grace@example.com"] });
    let before = stored(ws);
    let request = { requestedBy: "alice@example.com" };

    expect(await codeOf(ws.instance.grantAdminContent(
        contentGrantOf({ ...request, admin: "Alice@Example.com" }))))
        .toBe(ADMIN_GRANT_ERROR_CODES.secondAdminRequired);
    expect(stored(ws)).toStrictEqual(before);
    expect(await workspaceRecords(ws)).toStrictEqual([]);

    await ws.instance.grantAdminContent(contentGrantOf({ ...request, admin: "grace@example.com" }));
    expect(storedGrants(ws)).toMatchObject(
        [{ requestedBy: "alice@example.com", grantedBy: { id: "grace@example.com" } }]);
  }));

  it.each([
    ["the admins' choice", { adminWorkspaceAccess: "metadata" }, "content"],
    ["the environment's cap", { adminWorkspaceAccess: "content" }, "metadata"],
    ["a cap left unset", { adminWorkspaceAccess: "content" }, undefined],
  ])("refuses while the level in force is below content, by %s", (_name, config, cap) =>
      withContentWorkspace(async ws => {
    setContentLevel(ws, {
      ADMIN_WORKSPACE_ACCESS_MAX: cap,
      BLUEPRINTS: { get: async () => JSON.stringify(config) },
    });
    let before = stored(ws);

    expect(await codeOf(ws.instance.grantAdminContent(contentGrantOf())))
        .toBe(ADMIN_ACCESS_ERROR_CODES.contentOff);

    expect(stored(ws)).toStrictEqual(before);
    expect(await deploymentRecords(ws)).toStrictEqual([]);
  }));

  it("writes no record for a workspace deleted while the level is read",
      () => withContentWorkspace(async ws => {
    let before = stored(ws);
    setContentLevel(ws, { BLUEPRINTS: { get: async () => {
      ws.impl.ownerId = undefined;
      return JSON.stringify({ adminWorkspaceAccess: "content" });
    } } });

    expect(await codeOf(ws.instance.grantAdminContent(contentGrantOf())))
        .toBe(ADMIN_ACCESS_ERROR_CODES.workspaceNotFound);

    expect(stored(ws)).toStrictEqual(before);
    expect(await deploymentRecords(ws)).toStrictEqual([]);
  }));

  it("gives one grant for a request handed over twice", () => withContentWorkspace(async ws => {
    let grant = contentGrantOf();
    await ws.instance.grantAdminContent(grant);
    let after = stored(ws);

    expect(await codeOf(ws.instance.grantAdminContent(grant)))
        .toBe(ADMIN_GRANT_ERROR_CODES.requestNotPending);

    // Refused before any record: the log holds one approval.
    expect(stored(ws)).toStrictEqual(after);
    expect(storedGrants(ws)).toHaveLength(1);
    expect((await grantRecords(ws)).map(record => record.method))
        .toStrictEqual(["approveContentAccess"]);

    // Another request for the same workspace gives a grant of its own, which replaces the first;
    // the first request is still not pending.
    let { grantId } = await ws.instance.grantAdminContent(contentGrantOf());
    expect(ws.impl.liveAdminGrants().map(live => live.id)).toStrictEqual([grantId]);
    expect(await codeOf(ws.instance.grantAdminContent(grant)))
        .toBe(ADMIN_GRANT_ERROR_CODES.requestNotPending);
  }));

  it("gives one grant for a request that was applied while its record was appended",
      () => withContentWorkspace(async ws => {
    let grant = contentGrantOf();
    let first: AdminAccessGrant | undefined;
    recordOrder(ws, async () => { first = putGrant(ws, { requestId: grant.requestId }); });

    expect(await codeOf(ws.instance.grantAdminContent(grant)))
        .toBe(ADMIN_GRANT_ERROR_CODES.requestNotPending);

    expect(storedGrants(ws)).toStrictEqual([first]);
  }));

  it("stores no grant for a workspace deleted while its record is appended",
      () => withContentWorkspace(async ws => {
    recordOrder(ws, async () => { ws.impl.ownerId = undefined; });

    expect(await codeOf(ws.instance.grantAdminContent(contentGrantOf())))
        .toBe(ADMIN_ACCESS_ERROR_CODES.workspaceNotFound);

    expect(storedGrants(ws)).toStrictEqual([]);
  }));

  it("deletes the grants of either source that ended longer ago than the retention",
      () => withContentWorkspace(async ws => {
    let longAgo = new Date(Date.now() - 2 * RETENTION * DAY_MS);
    putGrant(ws, { expiresAt: longAgo });
    putOwnerGrant(ws, { revokedAt: longAgo, revokedBy: namedUser(OWNER) });
    let ranOut = putGrant(ws, { expiresAt: new Date(Date.now() - DAY_MS) });

    await ws.instance.grantAdminContent(contentGrantOf());

    let [given] = ws.impl.liveAdminGrants();
    expect(storedGrants(ws).map(grant => grant.id).toSorted())
        .toStrictEqual([ranOut.id, given.id].toSorted());
    // A grant that ran out is recorded by nothing, and neither is its deletion.
    expect((await grantRecords(ws)).map(record => record.method))
        .toStrictEqual(["approveContentAccess"]);
  }));
});

// The admin who ends a grant, through a session and a `via` of their own.
const ENDER: AdminGrantActor = { admin: REQUESTER, sessionId: "ending-session", via: "cli" };
const END_REASON = "The ticket is closed";

describe("endAdminGrant", () => {
  it("records the ending of the grant, then ends it", () => withContentWorkspace(async ws => {
    let request = contentGrantOf();
    await ws.instance.grantAdminContent(request);
    let [given] = storedGrants(ws);
    let before = Date.now();

    await ws.instance.endAdminGrant(ENDER, given.id, `  ${END_REASON}  `);

    // The step is the ending admin's, by the id their session carries; the request, its
    // requester and its reason are the stored grant's.
    let records = await grantRecords(ws);
    expect(records.map(record => record.method))
        .toStrictEqual(["approveContentAccess", "endWorkspaceGrant"]);
    expect(records[1]).toEqual({
      kind: "grant", method: "endWorkspaceGrant", at: expect.any(Date),
      admin: REQUESTER, sessionId: "ending-session", via: "cli", requestId: request.requestId,
      workspaceId: ws.id, workspaceOwner: OWNER.id, workspaceTitle: "Quarterly plan",
      reason: REASON, requestedBy: REQUESTER, grantId: given.id, endReason: END_REASON,
    });

    let [ended] = storedGrants(ws);
    expect(ended).toStrictEqual({
      ...given, revokedAt: expect.any(Date), revokedBy: { id: REQUESTER, name: "Rex Requester" },
    });
    expect(ended.revokedAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(ws.impl.liveAdminGrants()).toStrictEqual([]);

    // The grant's whole life in this workspace, by its kind.
    let page = await env.TEST_ADMIN_AUDIT.getByName("")
        .list({ kind: "grant", workspace: ws.id, limit: 200 }, RETENTION);
    expect(page.records.map(record => record.method))
        .toStrictEqual(["endWorkspaceGrant", "approveContentAccess"]);
  }));

  it("ends content on the view's next call", () => withContentWorkspace(async ws => {
    let grant = putGrant(ws);
    let view = await ws.instance.openForAdmin(ADMIN, "Looking into ticket 42", "view-session", {
      via: "api", access: "content", expiresAt: new Date(Date.now() + 60 * 1000),
    });
    await expect(view.getChat(CHAT_ID)).resolves.toBeDefined();

    await ws.instance.endAdminGrant(ENDER, grant.id, END_REASON);

    expect(await codeOf(view.getChat(CHAT_ID))).toBe(ADMIN_ACCESS_ERROR_CODES.grantRequired);
    expect((await view.describe()).grants).toStrictEqual([]);
  }));

  it("names an admin who has no account by their id", () => withContentWorkspace(async ws => {
    ws.accounts.delete(REQUESTER);
    let grant = putGrant(ws);

    await ws.instance.endAdminGrant(ENDER, grant.id, END_REASON);

    expect(storedGrants(ws)).toMatchObject([{ revokedBy: { id: REQUESTER, name: REQUESTER } }]);
  }));

  it("works with writes off and whatever the level in force", () => withWorkspace(async ws => {
    // At "metadata", as withWorkspace() sets it.
    setEnv(ws, { ADMIN_WORKSPACE_WRITES: "off" });
    let grant = putGrant(ws);

    await ws.instance.endAdminGrant(ENDER, grant.id, END_REASON);

    expect(ws.impl.liveAdminGrants()).toStrictEqual([]);
    expect(await grantRecords(ws)).toMatchObject(
        [{ method: "endWorkspaceGrant", admin: REQUESTER }]);
  }));

  it("refuses an id that names no live grant an approval gave, recording nothing",
      () => withContentWorkspace(async ws => {
    let owners = putOwnerGrant(ws);
    let ended = putGrant(ws, { revokedAt: new Date(), revokedBy: namedUser(ADMIN_PROFILE) });
    let ranOut = putGrant(ws, { expiresAt: new Date(Date.now() - 1000) });
    let before = stored(ws);

    // An owner's grant is the owner's to end.
    for (let id of [owners.id, ended.id, ranOut.id, crypto.randomUUID()]) {
      expect(await codeOf(ws.instance.endAdminGrant(ENDER, id, END_REASON)))
          .toBe(ADMIN_GRANT_ERROR_CODES.notFound);
    }

    expect(stored(ws)).toStrictEqual(before);
    expect(ws.impl.liveAdminGrants()).toStrictEqual([owners]);
    expect(await workspaceRecords(ws)).toStrictEqual([]);
  }));

  it("refuses an uninitialised workspace without initialising it", () => withWorkspace(async ws => {
    expect(await codeOf(ws.instance.endAdminGrant(ENDER, crypto.randomUUID(), END_REASON)))
        .toBe(ADMIN_ACCESS_ERROR_CODES.workspaceNotFound);
    expect(stored(ws)).toStrictEqual([]);
  }, { seed: false }));

  it("refuses a bad reason, a bad via and a caller who is not an admin, recording nothing",
      () => withContentWorkspace(async ws => {
    let grant = putGrant(ws);
    let before = stored(ws);

    for (let reason of ["", "   ", "r".repeat(501)]) {
      await expect(ws.instance.endAdminGrant(ENDER, grant.id, reason))
          .rejects.toBeInstanceOf(TypeError);
    }
    await expect(ws.instance.endAdminGrant({ ...ENDER, via: "agent" as any }, grant.id, END_REASON))
        .rejects.toBeInstanceOf(TypeError);
    expect(await codeOf(
        ws.instance.endAdminGrant({ ...ENDER, admin: OWNER.id }, grant.id, END_REASON)))
        .toBe(ADMIN_ACCESS_ERROR_CODES.notAdmin);

    expect(stored(ws)).toStrictEqual(before);
    expect(await workspaceRecords(ws)).toStrictEqual([]);
  }));

  it("leaves the grant live when its record cannot be written",
      () => withContentWorkspace(async ws => {
    let grant = putGrant(ws);
    let before = stored(ws);
    recordOrder(ws, async () => { throw new Error("The audit log is unavailable"); });

    await expect(ws.instance.endAdminGrant(ENDER, grant.id, END_REASON))
        .rejects.toThrow("The audit log is unavailable");

    expect(stored(ws)).toStrictEqual(before);
    expect(ws.impl.liveAdminGrants()).toStrictEqual([grant]);
  }));

  it("ends the grant only once its record is written", () => withContentWorkspace(async ws => {
    let grant = putGrant(ws);
    let liveAtAppend: AdminAccessGrant[] | undefined;
    recordOrder(ws, async () => { liveAtAppend = ws.impl.liveAdminGrants(); });

    await ws.instance.endAdminGrant(ENDER, grant.id, END_REASON);

    expect(liveAtAppend).toStrictEqual([grant]);
    expect(ws.impl.liveAdminGrants()).toStrictEqual([]);
  }));

  it("leaves a grant another admin ended while its record was appended as that admin ended it",
      () => withContentWorkspace(async ws => {
    let grant = putGrant(ws);
    let first = { ...grant, revokedAt: new Date(), revokedBy: namedUser(ADMIN_PROFILE) };
    let events = recordOrder(ws, async () => { ws.impl.storage.adminGrants.put(first); });

    expect(await codeOf(ws.instance.endAdminGrant(ENDER, grant.id, END_REASON)))
        .toBe(ADMIN_GRANT_ERROR_CODES.notFound);

    // The record stands for the attempt.
    expect(events).toStrictEqual(["audit"]);
    expect(storedGrants(ws)).toStrictEqual([first]);
  }));

  it("ends nothing in a workspace deleted while the record is appended",
      () => withContentWorkspace(async ws => {
    let grant = putGrant(ws);
    recordOrder(ws, async () => { ws.impl.ownerId = undefined; });

    expect(await codeOf(ws.instance.endAdminGrant(ENDER, grant.id, END_REASON)))
        .toBe(ADMIN_ACCESS_ERROR_CODES.workspaceNotFound);

    expect(storedGrants(ws)).toStrictEqual([grant]);
  }));

  it("ends a grant while the deployment's settings cannot be read, and leaves pruning to others",
      () => withContentWorkspace(async ws => {
    let longAgo = new Date(Date.now() - 2 * RETENTION * DAY_MS);
    let old = [putGrant(ws, { expiresAt: longAgo }), putOwnerGrant(ws, { expiresAt: longAgo })];
    let grant = putGrant(ws);
    setContentLevel(ws, { BLUEPRINTS: { get: async () => { throw new Error("KV is down"); } } });

    await ws.instance.endAdminGrant(ENDER, grant.id, END_REASON);

    expect(storedGrants(ws).map(kept => kept.id).toSorted())
        .toStrictEqual([...old.map(each => each.id), grant.id].toSorted());
    expect(storedGrants(ws).find(kept => kept.id === grant.id)?.revokedAt).toBeInstanceOf(Date);
  }));
});

// What a grant method refuses a call with: its code and its message.
function grantRefusal(call: Promise<unknown>): Promise<{ code?: string; message: string }> {
  return call.then(
      () => { throw new Error("Expected a refusal."); },
      (err: Error) => ({ code: getAdminGrantErrorCode(err), message: err.message }));
}

describe("what the workspace's owner is shown of an approval's grant", () => {
  it("is nothing: no entry, event, grant or account call, while it is given, live and ended",
      () => withContentWorkspace(async ws => {
    await asOwner(ws, async client => {
      // What a session subscribed to the workspace's metadata and actions is delivered.
      let delivered: unknown[] = [];
      using onMetadata = new NativeRpcStub((update: unknown) => { delivered.push(update); });
      using subscriber = actionSubscriber();
      let subscriptions = [
        await client.subscribeToMetadata(onMetadata as any),
        await client.subscribeToActions(subscriber.stub),
      ];
      await scheduler.wait(50);
      let metadata = await client.getMetadata();
      expect(delivered).toStrictEqual([metadata]);
      let before = storedBesidesGrants(ws);
      // What an id that names nothing is refused with.
      let renewNothing = await grantRefusal(client.renewAdminAccess(crypto.randomUUID()));
      let revokeNothing = await grantRefusal(client.revokeAdminAccess(crypto.randomUUID()));
      expect(renewNothing.code).toBe(ADMIN_GRANT_ERROR_CODES.notFound);
      let calls = accountCalls(ws);

      // Nothing the owner can read, call or subscribe to differs for the grant.
      let unchanged = async (id: string) => {
        expect(await client.listAdminGrants()).toStrictEqual([]);
        expect(await grantRefusal(client.renewAdminAccess(id))).toStrictEqual(renewNothing);
        expect(await grantRefusal(client.revokeAdminAccess(id))).toStrictEqual(revokeNothing);
        expect(await client.getMetadata()).toStrictEqual(metadata);
        expect((await client.listActions({ filter: "all" })).entries).toStrictEqual([]);
        expect(storedBesidesGrants(ws)).toStrictEqual(before);
        // Long enough for a delivery to have arrived, had one been made.
        await scheduler.wait(50);
        expect(delivered).toStrictEqual([metadata]);
        expect(subscriber.delivered).toStrictEqual([]);
      };

      await ws.instance.grantAdminContent(contentGrantOf());
      let [given] = storedGrants(ws);
      await unchanged(given.id);
      // The owner's calls left the grant as it was stored, and live.
      expect(storedGrants(ws)).toStrictEqual([given]);

      await ws.instance.endAdminGrant(ENDER, given.id, END_REASON);
      let [ended] = storedGrants(ws);
      await unchanged(given.id);
      expect(storedGrants(ws)).toStrictEqual([ended]);

      // The only accounts asked are the two admins', each for its profile; the owner's own
      // calls read the owner's profile.
      expect(calls.filter(call => call !== "whoami")).toStrictEqual(
          ["whoamiIfExists", "whoamiIfExists"]);
      // The owner's calls wrote no audit record: the log holds the admins' two steps.
      expect((await grantRecords(ws)).map(record => record.method))
          .toStrictEqual(["approveContentAccess", "endWorkspaceGrant"]);
      for (let subscription of subscriptions) {
        (subscription as unknown as Disposable)[Symbol.dispose]();
      }
    });
  }));

  it("enters nothing in the action log for either write or for a grant to read content",
      () => withContentWorkspace(async ws => {
    vi.spyOn(ws.impl, "scheduleAccessRestart").mockImplementation(async () => {});
    let changes: [AdminWriteAction, AdminWriteArgs][] = [
      ["stopAgent", { chatId: CHAT_ID }], ["restartWorkspace", {}],
    ];
    for (let [action, args] of changes) {
      await ws.instance.applyAdminWrite(callOf(action, args));
    }
    await ws.instance.grantAdminContent(contentGrantOf());

    expect([...ws.impl.storage.actions.list()]).toStrictEqual([]);
  }));
});
