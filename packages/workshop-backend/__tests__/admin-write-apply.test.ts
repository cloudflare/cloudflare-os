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
  getAdminAccessErrorCode, getAdminWriteErrorCode,
  type ActionLogEntry, type AdminWriteAction, type AdminWriteArgs, type AdminWriteRecord,
  type AiChatAuthorInfo, type Overseer,
} from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { AdminAuditDurableObject } from "../src/admin-audit.js";
import type { AdminWriteGrant } from "../src/admin-writes.js";
import { auditOwnerId, withholdActionContent } from "../src/admin-access.js";
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
    ["restartWorkspace", {}, {
      scheduleAccessRestart: [["Gadget restarted by a deployment admin."]],
    }],
  ])("%s", (action, args, expected) => withWorkspace(async ws => {
    let spies = spyOnOperations(ws);

    await ws.instance.applyAdminWrite(grantOf(action, args));

    // Exactly that operation, with exactly those arguments, and no other.
    for (let [name, spy] of Object.entries(spies)) {
      expect(spy.mock.calls, name).toEqual(expected[name] ?? []);
    }
  }));

  it("names an approver who has no account by their id", () => withWorkspace(async ws => {
    ws.accounts.delete(ADMIN);
    spyOnOperations(ws);
    await ws.instance.applyAdminWrite(grantOf("stopAgent", { chatId: CHAT_ID }));
    expect(await adminEntries(ws))
        .toMatchObject([{ resolvedBy: { type: "user", id: ADMIN, name: ADMIN } }]);
  }));

  it("throws the operation's own error for an unknown chat", () => withWorkspace(async ws => {
    let apply = (action: AdminWriteAction, args: AdminWriteArgs) =>
        ws.instance.applyAdminWrite(grantOf(action, args));
    await expect(apply("stopAgent", { chatId: 99 })).rejects.toThrow("No such chatId: 99");

    // It was approved and recorded before it failed, and it left its entry, "rejected".
    expect((await deploymentRecords(ws)).map(record => record.event))
        .toStrictEqual(["approved"]);
    expect((await adminEntries(ws)).map(entry => entry.state))
        .toStrictEqual(["rejected"]);
  }));
});

// The chat's messages, oldest first.
function messagesOf(ws: Workspace): any[] {
  return [...ws.impl.storage.chats.list()];
}

describe("the effect of a write", () => {
  it("stopAgent on an idle chat succeeds", () => withWorkspace(async ws => {
    expect(await ws.instance.applyAdminWrite(grantOf("stopAgent", { chatId: CHAT_ID })))
        .toEqual({ outcome: undefined });
    expect(await adminEntries(ws)).toMatchObject([{ state: "approved" }]);
  }));

  it("stopAgent keeps the messages queued for the turn it stops, as their senders' own",
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

    await ws.instance.applyAdminWrite(grantOf("stopAgent", { chatId: CHAT_ID }));

    let meta = ws.impl.storage.chatMeta.get(CHAT_ID);
    expect(meta.queuedSteers).toBeUndefined();
    expect(meta.activeAgent).toBeUndefined();
    // Before the stop itself, in the order they were sent.
    expect(messagesOf(ws).slice(0, 3)).toMatchObject([
      { author: BOB, type: "message", message: "Also add a streak counter.", steered: true },
      { author: OWNER, type: "message", message: "And make it dark.", steered: true },
      { author: AGENT, type: "agentNudge" },
    ]);
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
    ["restartWorkspace", {}, "scheduleAccessRestart"],
  ])("%s is recorded, then entered in the action log, then run", (action, args, operation) =>
      withWorkspace(async ws => {
    let events = recordOrder(ws);
    vi.spyOn(ws.impl, operation).mockImplementation(() => { events.push("effect"); });

    await ws.instance.applyAdminWrite(grantOf(action, args));

    expect(events).toStrictEqual(["audit", "entry", "effect"]);
  }));

  it("changes nothing when the record cannot be written", () => withWorkspace(async ws => {
    let before = stored(ws);
    let events = recordOrder(ws, async () => { throw new Error("The audit log is unavailable"); });
    let effect = vi.spyOn(ws.impl, "cancelAgent");

    await expect(ws.instance.applyAdminWrite(grantOf("stopAgent", { chatId: CHAT_ID })))
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
    let effect = vi.spyOn(ws.impl, "cancelAgent");
    // The approver's profile is the last read before the record. A deletion unsets impl.ownerId.
    let { getByName } = ws.impl.users;
    ws.impl.users.getByName = (name: string) => ({
      ...getByName(name),
      whoamiIfExists: async () => {
        ws.impl.ownerId = undefined;
        return ADMIN_PROFILE;
      },
    });

    expect(await codeOf(ws.instance.applyAdminWrite(grantOf("stopAgent", { chatId: CHAT_ID }))))
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
    let effect = vi.spyOn(ws.impl, "cancelAgent");

    expect(await codeOf(ws.instance.applyAdminWrite(grantOf("stopAgent", { chatId: CHAT_ID }))))
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
    let grant = grantOf("stopAgent", { chatId: CHAT_ID },
        { requestedBy: REQUESTER, via: "cli", reason: `  ${REASON}  ` });
    let before = Date.now();

    await ws.instance.applyAdminWrite(grant);

    let records = await deploymentRecords(ws);
    expect(records).toEqual([{
      kind: "write", event: "approved", at: expect.any(Date),
      admin: ADMIN, sessionId: SESSION_ID, via: "cli", requestId: grant.requestId,
      workspaceId: ws.id, workspaceOwner: OWNER.id, workspaceTitle: "Quarterly plan",
      method: "stopAgent", args: { chatId: CHAT_ID },
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
    let recordAdminWrite = vi.spyOn(ws.impl, "recordAdminWrite");
    let during: any;
    // A stop runs synchronously, so the entry is read from storage as it stands then.
    vi.spyOn(ws.impl, "cancelAgent").mockImplementation(() => {
      during = { ...ws.impl.storage.actions.get(recordAdminWrite.mock.results[0].value as number) };
      throw new Error("The agent could not be stopped");
    });

    await expect(ws.instance.applyAdminWrite(grantOf("stopAgent", { chatId: CHAT_ID })))
        .rejects.toThrow("The agent could not be stopped");

    expect(during).toMatchObject({ state: "approved", byAdmin: true });
    let [entry] = await adminEntries(ws);
    expect(entry).toMatchObject({
      id: during.id, state: "rejected", byAdmin: true, resolvedBy: ADMIN_PROFILE,
      description: { title: `Stop the agent in chat ${CHAT_ID}` },
    });
    expect(entry.createdAt).toEqual(during.createdAt);
  }));

  it("gives an inspection its title and state, and withholds its fields",
      () => withWorkspace(async ws => {
    await ws.instance.applyAdminWrite(grantOf("stopAgent", { chatId: CHAT_ID }));
    let [entry] = await adminEntries(ws);

    // At "metadata", the deployment's level here.
    let view = await ws.instance.openForAdmin(ADMIN, "Looking into ticket 42", "view-session", {
      via: "api", access: "metadata", expiresAt: new Date(Date.now() + 60 * 1000),
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
    vi.spyOn(ws.impl, "cancelAgent").mockImplementation(() => {
      // As the action log of a workspace deleted while the write runs goes with it.
      ws.impl.storage.actions.delete(recordAdminWrite.mock.results[0].value as number);
      gone = stored(ws);
      throw new Error("The agent could not be stopped");
    });

    await expect(ws.instance.applyAdminWrite(grantOf("stopAgent", { chatId: CHAT_ID })))
        .rejects.toThrow("The agent could not be stopped");

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

      await ws.instance.applyAdminWrite(grantOf("stopAgent", { chatId: CHAT_ID }));

      expect(await client.listActions()).toEqual({ entries: [] });
      expect(await client.listActions({ filter: "all" })).toEqual({ entries: [] });
      // Long enough for a delivery to have arrived, had one been made.
      await scheduler.wait(50);
      expect(subscriber.delivered).toStrictEqual([]);
      (subscription as unknown as Disposable)[Symbol.dispose]();
    });

    // Only the owner and "build" collaborators read it.
    expect(await adminEntries(ws)).toMatchObject([{
      byAdmin: true, state: "approved", description: { title: `Stop the agent in chat ${CHAT_ID}` },
    }]);
  }));
});
