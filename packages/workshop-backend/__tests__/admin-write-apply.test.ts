// An admin write as its workspace runs it (OverseerDurableObject.applyAdminWrite()): what it
// refuses before writing or recording anything, that the record comes before the effect, which
// operation each action runs and with what, and that the workspace keeps no note of it.
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
  ADMIN_ACCESS_ERROR_CODES, MAX_ADMIN_AUDIT_ARG_LENGTH, getAdminAccessErrorCode,
  type ActionLogEntry, type AdminWriteAction, type AdminWriteArgs, type AdminWriteRecord,
  type AiChatAuthorInfo, type Overseer,
} from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { AdminAuditDurableObject } from "../src/admin-audit.js";
import type { AdminWriteCall } from "../src/admin-writes.js";
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

// Sets impl.env to the pool's env with writes on, the admin, a fake BLUEPRINTS serving a config
// whose inspection level is "metadata", and `vars`.
function setEnv(ws: Workspace, vars: Record<string, unknown> = {}): void {
  let config = JSON.stringify(
      { adminWorkspaceAccess: "metadata", adminAuditRetentionDays: RETENTION });
  ws.impl.env = {
    ...env,
    ADMINS: [ADMIN],
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

// The code a call is refused with.
async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return getAdminAccessErrorCode(err) ?? `uncoded: ${String(err)}`;
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
