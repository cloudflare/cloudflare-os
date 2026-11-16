// An approved admin write as its workspace runs it (OverseerDurableObject.applyAdminWrite()): what
// it refuses before writing or recording anything, that the "approved" record and the entry of
// the workspace's action log both come before the effect, which operation each action runs and
// with what, and who is shown the entry. Then the one write that enters nothing in that log, a
// grant to read the workspace's content that a second admin approved, and its ending by an admin
// (OverseerDurableObject.endAdminGrant()).
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
  ADMIN_WRITE_ERROR_CODES, MAX_ADMIN_AUDIT_ARG_LENGTH,
  getAdminAccessErrorCode, getAdminGrantErrorCode, getAdminWriteErrorCode,
  type ActionLogEntry, type AdminAccessGrant, type AdminWriteAction, type AdminWriteArgs,
  type AdminWriteRecord, type AiChatAuthorInfo, type Overseer,
} from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { AdminAuditDurableObject } from "../src/admin-audit.js";
import type { AdminWriteGrant } from "../src/admin-writes.js";
import {
  auditOwnerId, namedUser, withholdActionContent, type AdminWriteActor,
} from "../src/admin-access.js";
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

// The code a call is refused with, of any family.
async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return getAdminAccessErrorCode(err) ?? getAdminWriteErrorCode(err) ??
        getAdminGrantErrorCode(err) ?? `uncoded: ${String(err)}`;
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
    ["a via that is not one", {}, { via: "browser" }],
    // An approval is a person's: one labelled as the admin gatekeeper's is refused, with where it
    // came from or without.
    ["an approver who came through the admin gatekeeper", {},
      { via: "gatekeeper", agent: { workspaceId: "c".repeat(64), chatId: 4 } }],
    ["a gatekeeper via with no origin", {}, { via: "gatekeeper" }],
    ["an origin under a client's via", {}, { agent: { workspaceId: "c".repeat(64) } }],
    ["arguments the action does not take", { gatekeeperId: 3 }, {}],
    ["a missing argument", { chatId: undefined }, {}],
    ["an invalid expiry", {}, { expiresAt: new Date(NaN) }],
    ["an expiry that is not a Date", {}, { expiresAt: "2030-01-01T00:00:00Z" }],
    ["an empty workspace owner", {}, { workspaceOwner: "" }],
    ["a missing passkey", {}, { passkey: undefined }],
    ["an empty passkey", {}, { passkey: "" }],
    ["a passkey of 257 characters", {}, { passkey: "p".repeat(MAX_ADMIN_AUDIT_ARG_LENGTH + 1) }],
    ["insiders that are not a list", {}, { insiders: REQUESTER }],
    ["an insider that is not a name", {}, { insiders: [REQUESTER, 7] }],
    ["insiders that are null", {}, { insiders: null }],
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

// A request to read content as it is handed over: asked for by REQUESTER, approved by ADMIN.
function contentGrantOf(overrides: Partial<AdminWriteGrant> = {}): AdminWriteGrant {
  return grantOf("grantContentAccess", {}, { requestedBy: REQUESTER, ...overrides });
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

describe("grantContentAccess", () => {
  it("stores a grant from the approver for the request, and reports its id and end",
      () => withContentWorkspace(async ws => {
    let grant = contentGrantOf({ reason: `  ${REASON}  ` });
    let before = Date.now();

    let { outcome } = await ws.instance.applyAdminWrite(grant);

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
    expect(outcome).toBe(`grant ${kept.id} until ${kept.expiresAt.toISOString()}`);

    // The one record is the write's "approved": the grant has no record of its own. It names
    // the grant, so the calls made under it lead back to the approval whether or not the
    // request's closing record is ever written.
    expect(await deploymentRecords(ws)).toEqual([{
      kind: "write", event: "approved", at: expect.any(Date),
      admin: ADMIN, sessionId: SESSION_ID, via: "api", requestId: grant.requestId,
      workspaceId: ws.id, workspaceOwner: OWNER.id, workspaceTitle: "Quarterly plan",
      method: "grantContentAccess", args: {}, reason: REASON, requestedBy: REQUESTER,
      passkey: PASSKEY, grantId: kept.id,
    }]);
  }));

  it("lets a content call answer, and is listed where admins inspect the workspace",
      () => withContentWorkspace(async ws => {
    let view = await ws.instance.openForAdmin(ADMIN, "Looking into ticket 42", "view-session", {
      via: "api", access: "content", expiresAt: new Date(Date.now() + 60 * 1000),
    });
    expect(await codeOf(view.getChat(CHAT_ID))).toBe(ADMIN_ACCESS_ERROR_CODES.grantRequired);
    expect((await view.describe()).grants).toStrictEqual([]);

    await ws.instance.applyAdminWrite(contentGrantOf());

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

  it("is recorded, then stored, and enters nothing in the action log",
      () => withContentWorkspace(async ws => {
    let events = recordOrder(ws, async () => {
      expect(storedGrants(ws)).toStrictEqual([]);
    });
    let recordAdminWrite = vi.spyOn(ws.impl, "recordAdminWrite");

    await ws.instance.applyAdminWrite(contentGrantOf());

    expect(events).toStrictEqual(["audit"]);
    expect(recordAdminWrite).not.toHaveBeenCalled();
    expect(storedGrants(ws)).toHaveLength(1);
  }));

  it("stores nothing when the record cannot be written", () => withContentWorkspace(async ws => {
    let before = stored(ws);
    recordOrder(ws, async () => { throw new Error("The audit log is unavailable"); });

    await expect(ws.instance.applyAdminWrite(contentGrantOf()))
        .rejects.toThrow("The audit log is unavailable");

    expect(stored(ws)).toStrictEqual(before);
  }));

  it("refuses an approver who is the requester, before any record",
      () => withContentWorkspace(async ws => {
    let before = stored(ws);
    expect(await codeOf(ws.instance.applyAdminWrite(contentGrantOf({ requestedBy: ADMIN }))))
        .toBe(ADMIN_WRITE_ERROR_CODES.secondAdminRequired);
    expect(stored(ws)).toStrictEqual(before);
    expect(await deploymentRecords(ws)).toStrictEqual([]);

    // Every other action is still its requester's to approve.
    await ws.instance.applyAdminWrite(grantOf("stopAgent", { chatId: CHAT_ID }));
    expect(await deploymentRecords(ws)).toMatchObject(
        [{ event: "approved", admin: ADMIN, requestedBy: ADMIN }]);
  }));

  it("takes two accounts that one entry of ADMINS matches for one admin",
      () => withContentWorkspace(async ws => {
    setContentLevel(ws, { ADMINS: ["alice@example.com", "grace@example.com"] });
    let before = stored(ws);
    let request = { requestedBy: "alice@example.com" };

    expect(await codeOf(ws.instance.applyAdminWrite(
        contentGrantOf({ ...request, admin: "Alice@Example.com" }))))
        .toBe(ADMIN_WRITE_ERROR_CODES.secondAdminRequired);
    expect(stored(ws)).toStrictEqual(before);
    expect(await deploymentRecords(ws)).toStrictEqual([]);

    await ws.instance.applyAdminWrite(contentGrantOf({ ...request, admin: "grace@example.com" }));
    expect(storedGrants(ws)).toMatchObject(
        [{ requestedBy: "alice@example.com", grantedBy: { id: "grace@example.com" } }]);
  }));

  // A request an agent filed through the admin gatekeeper: OWNER_ADMIN's, with a member of the
  // workspace it was filed from. OUTSIDE_ADMIN had no part in it.
  const OWNER_ADMIN = "triage-owner@example.test";
  const MEMBER_ADMIN = "triage-member@example.test";
  const OUTSIDE_ADMIN = "outside-admin@example.test";
  const AGENT_ADMINS = { ADMINS: [OWNER_ADMIN, MEMBER_ADMIN, OUTSIDE_ADMIN] };
  const agentRequest = { requestedBy: OWNER_ADMIN, insiders: [OWNER_ADMIN, MEMBER_ADMIN] };

  it("refuses an approver who was in the workspace the request was filed from, before any record",
      () => withContentWorkspace(async ws => {
    setContentLevel(ws, AGENT_ADMINS);
    let before = stored(ws);

    for (let admin of [MEMBER_ADMIN, OWNER_ADMIN]) {
      expect(await codeOf(ws.instance.applyAdminWrite(contentGrantOf({ ...agentRequest, admin }))))
          .toBe(ADMIN_WRITE_ERROR_CODES.secondAdminRequired);
    }
    expect(stored(ws)).toStrictEqual(before);
    expect(storedGrants(ws)).toStrictEqual([]);
    expect(await deploymentRecords(ws)).toStrictEqual([]);

    // An admin from outside that workspace approves. Neither the record nor the stored grant
    // keeps the list.
    let grant = contentGrantOf({ ...agentRequest, admin: OUTSIDE_ADMIN });
    await ws.instance.applyAdminWrite(grant);
    let [kept] = storedGrants(ws);
    expect(storedGrants(ws)).toStrictEqual([{
      id: expect.any(String), level: "content", source: "admins", scope: "workspace",
      grantedBy: { id: OUTSIDE_ADMIN, name: OUTSIDE_ADMIN },
      requestedBy: OWNER_ADMIN, requestId: grant.requestId, reason: REASON,
      grantedAt: expect.any(Date), expiresAt: expect.any(Date),
    }]);
    expect(await deploymentRecords(ws)).toEqual([{
      kind: "write", event: "approved", at: expect.any(Date),
      admin: OUTSIDE_ADMIN, sessionId: SESSION_ID, via: "api", requestId: grant.requestId,
      workspaceId: ws.id, workspaceOwner: OWNER.id, workspaceTitle: "Quarterly plan",
      method: "grantContentAccess", args: {}, reason: REASON, requestedBy: OWNER_ADMIN,
      passkey: PASSKEY, grantId: kept.id,
    }]);
  }));

  it("takes an insider spelled in another case for that insider",
      () => withContentWorkspace(async ws => {
    setContentLevel(ws, AGENT_ADMINS);
    let before = stored(ws);
    expect(await codeOf(ws.instance.applyAdminWrite(
        contentGrantOf({ ...agentRequest, admin: "Triage-Member@Example.test" }))))
        .toBe(ADMIN_WRITE_ERROR_CODES.secondAdminRequired);
    expect(stored(ws)).toStrictEqual(before);
    expect(await deploymentRecords(ws)).toStrictEqual([]);
  }));

  it("keeps a request with no insiders to its requester alone",
      () => withContentWorkspace(async ws => {
    setContentLevel(ws, AGENT_ADMINS);
    let request = { requestedBy: OWNER_ADMIN };
    for (let insiders of [undefined, []]) {
      expect(await codeOf(ws.instance.applyAdminWrite(
          contentGrantOf({ ...request, insiders, admin: OWNER_ADMIN }))))
          .toBe(ADMIN_WRITE_ERROR_CODES.secondAdminRequired);
    }
    expect(await deploymentRecords(ws)).toStrictEqual([]);

    await ws.instance.applyAdminWrite(contentGrantOf({ ...request, admin: MEMBER_ADMIN }));
    expect(storedGrants(ws)).toMatchObject(
        [{ requestedBy: OWNER_ADMIN, grantedBy: { id: MEMBER_ADMIN } }]);
  }));

  it("lets an insider approve every other action", () => withWorkspace(async ws => {
    setEnv(ws, AGENT_ADMINS);
    let spies = spyOnOperations(ws);

    await ws.instance.applyAdminWrite(
        grantOf("restartWorkspace", {}, { ...agentRequest, admin: MEMBER_ADMIN }));

    expect(spies.scheduleAccessRestart.mock.calls).toHaveLength(1);
    expect(await deploymentRecords(ws)).toMatchObject(
        [{ event: "approved", admin: MEMBER_ADMIN, requestedBy: OWNER_ADMIN }]);
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

    expect(await codeOf(ws.instance.applyAdminWrite(contentGrantOf())))
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

    expect(await codeOf(ws.instance.applyAdminWrite(contentGrantOf())))
        .toBe(ADMIN_ACCESS_ERROR_CODES.workspaceNotFound);

    expect(stored(ws)).toStrictEqual(before);
    expect(await deploymentRecords(ws)).toStrictEqual([]);
  }));

  it("gives one grant for a request handed over twice", () => withContentWorkspace(async ws => {
    let grant = contentGrantOf();
    await ws.instance.applyAdminWrite(grant);
    let after = stored(ws);

    expect(await codeOf(ws.instance.applyAdminWrite(grant)))
        .toBe(ADMIN_WRITE_ERROR_CODES.requestNotPending);

    // Refused before any record: the log holds one "approved".
    expect(stored(ws)).toStrictEqual(after);
    expect(storedGrants(ws)).toHaveLength(1);
    expect((await deploymentRecords(ws)).map(record => record.event)).toStrictEqual(["approved"]);

    // Another request for the same workspace gives a grant of its own.
    await ws.instance.applyAdminWrite(contentGrantOf());
    expect(ws.impl.liveAdminGrants()).toHaveLength(2);
  }));

  it("gives one grant for a request that was applied while its record was appended",
      () => withContentWorkspace(async ws => {
    let grant = contentGrantOf();
    let first: AdminAccessGrant | undefined;
    recordOrder(ws, async () => { first = putGrant(ws, { requestId: grant.requestId }); });

    expect(await codeOf(ws.instance.applyAdminWrite(grant)))
        .toBe(ADMIN_WRITE_ERROR_CODES.requestNotPending);

    expect(storedGrants(ws)).toStrictEqual([first]);
  }));

  it("stores no grant for a workspace deleted while its record is appended",
      () => withContentWorkspace(async ws => {
    recordOrder(ws, async () => { ws.impl.ownerId = undefined; });

    expect(await codeOf(ws.instance.applyAdminWrite(contentGrantOf())))
        .toBe(ADMIN_ACCESS_ERROR_CODES.workspaceNotFound);

    expect(storedGrants(ws)).toStrictEqual([]);
  }));

  it("deletes the grants of either source that ended longer ago than the retention",
      () => withContentWorkspace(async ws => {
    let longAgo = new Date(Date.now() - 2 * RETENTION * DAY_MS);
    putGrant(ws, { expiresAt: longAgo });
    putOwnerGrant(ws, { revokedAt: longAgo, revokedBy: namedUser(OWNER) });
    let ranOut = putGrant(ws, { expiresAt: new Date(Date.now() - DAY_MS) });

    await ws.instance.applyAdminWrite(contentGrantOf());

    let [given] = ws.impl.liveAdminGrants();
    expect(storedGrants(ws).map(grant => grant.id).toSorted())
        .toStrictEqual([ranOut.id, given.id].toSorted());
    // A grant that ran out is recorded by nothing, and neither is its deletion.
    expect((await deploymentRecords(ws)).map(record => record.event)).toStrictEqual(["approved"]);
  }));
});

// The admin who ends a grant, through a session and a `via` of their own.
const ENDER: AdminWriteActor = { admin: REQUESTER, sessionId: "ending-session", via: "cli" };
const END_REASON = "The ticket is closed";

describe("endAdminGrant", () => {
  it("records the revoked step of the grant's request, then ends the grant",
      () => withContentWorkspace(async ws => {
    let request = contentGrantOf();
    await ws.instance.applyAdminWrite(request);
    let [given] = storedGrants(ws);
    let before = Date.now();

    await ws.instance.endAdminGrant(ENDER, given.id, `  ${END_REASON}  `);

    // The step is the ending admin's, by the id their session carries; the request, its
    // requester and its reason are the stored grant's.
    let records = await deploymentRecords(ws);
    expect(records.map(record => record.event)).toStrictEqual(["approved", "revoked"]);
    expect(records[1]).toEqual({
      kind: "write", event: "revoked", at: expect.any(Date),
      admin: REQUESTER, sessionId: "ending-session", via: "cli", requestId: request.requestId,
      workspaceId: ws.id, workspaceOwner: OWNER.id, workspaceTitle: "Quarterly plan",
      method: "grantContentAccess", args: {}, reason: REASON, requestedBy: REQUESTER,
      grantId: given.id, endReason: END_REASON,
    });

    let [ended] = storedGrants(ws);
    expect(ended).toStrictEqual({
      ...given, revokedAt: expect.any(Date), revokedBy: { id: REQUESTER, name: "Rex Requester" },
    });
    expect(ended.revokedAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(ws.impl.liveAdminGrants()).toStrictEqual([]);

    // The request's whole life in this workspace, by its action.
    let page = await env.TEST_ADMIN_AUDIT.getByName("")
        .list({ method: "grantContentAccess", workspace: ws.id, limit: 200 }, RETENTION);
    expect(page.records.map(record => (record as AdminWriteRecord).event))
        .toStrictEqual(["revoked", "approved"]);
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
    expect(await deploymentRecords(ws)).toMatchObject([{ event: "revoked", admin: REQUESTER }]);
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
    expect(await deploymentRecords(ws)).toStrictEqual([]);
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
    let agent = { workspaceId: "c".repeat(64), chatId: 4 };
    for (let label of [
      { via: "agent" }, { via: "gatekeeper", agent }, { via: "gatekeeper" }, { via: "cli", agent },
    ]) {
      await expect(ws.instance.endAdminGrant(
          { ...ENDER, ...label } as AdminWriteActor, grant.id, END_REASON), JSON.stringify(label))
          .rejects.toBeInstanceOf(TypeError);
    }
    expect(await codeOf(
        ws.instance.endAdminGrant({ ...ENDER, admin: OWNER.id }, grant.id, END_REASON)))
        .toBe(ADMIN_ACCESS_ERROR_CODES.notAdmin);

    expect(stored(ws)).toStrictEqual(before);
    expect(await deploymentRecords(ws)).toStrictEqual([]);
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

  it("deletes the grants of either source that ended longer ago than the retention",
      () => withContentWorkspace(async ws => {
    let longAgo = new Date(Date.now() - 2 * RETENTION * DAY_MS);
    putGrant(ws, { expiresAt: longAgo });
    putOwnerGrant(ws, { expiresAt: longAgo });
    let grant = putGrant(ws);

    await ws.instance.endAdminGrant(ENDER, grant.id, END_REASON);

    expect(storedGrants(ws).map(kept => kept.id)).toStrictEqual([grant.id]);
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

      await ws.instance.applyAdminWrite(contentGrantOf());
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
      expect((await deploymentRecords(ws)).map(record => record.event))
          .toStrictEqual(["approved", "revoked"]);
      for (let subscription of subscriptions) {
        (subscription as unknown as Disposable)[Symbol.dispose]();
      }
    });
  }));

  it("enters each of the two changes in the action log, and nothing for a request to read content",
      () => withContentWorkspace(async ws => {
    vi.spyOn(ws.impl, "scheduleAccessRestart").mockImplementation(async () => {});
    let changes: [AdminWriteAction, AdminWriteArgs][] = [
      ["stopAgent", { chatId: CHAT_ID }], ["restartWorkspace", {}],
    ];
    for (let [action, args] of changes) {
      await ws.instance.applyAdminWrite(grantOf(action, args));
    }
    await ws.instance.applyAdminWrite(contentGrantOf());

    expect(await adminEntries(ws)).toHaveLength(changes.length);
  }));
});
