// A deployment admin's read-only view of a workspace (OverseerDurableObject.openForAdmin() and
// AdminWorkspaceView): what it refuses before recording anything, what it records and where, what
// a level below "full" withholds, how live views follow the deployment's setting, and that nothing
// it does reaches the workspace's members or its connections.
//
// Runs against a real OverseerDurableObject (the TEST_OVERSEER binding) whose impl.env is replaced
// per test: the admin path must read the environment only through it. The deployment-wide log is
// the real AdminAuditDurableObject the Overseer reaches through ctx.exports, read back through the
// TEST_ADMIN_AUDIT binding.

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import {
  ADMIN_ACCESS_ERROR_CODES, MAX_ADMIN_ACCESS_REASON_LENGTH, MAX_ADMIN_AUDIT_ARG_LENGTH,
  MAX_ADMIN_VIEW_LIFETIME_SECONDS, getAdminAccessErrorCode,
  type AdminAccessRecord, type AdminWorkspaceAccess, type AiChatAuthorInfo,
} from "@gadgets/workshop-shared/api";
import type { OverseerDurableObject } from "../src/overseer.js";
import type { AdminAuditDurableObject } from "../src/admin-audit.js";
import type { AdminViewTerms } from "../src/admin-access.js";
import { ADMIN_CONFIG_KEY } from "../src/storage-schema/blueprints-kv.js";
import { putAction } from "./fixtures.js";
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
const OWNER_USER_ID = "owner-user-do";
// A view that outlives its open by a margin a slow runner keeps (the open reads the config twice
// and awaits its record), then expires within the test.
const SHORT_LIFETIME_MS = 1000;
const OWNER: AiChatAuthorInfo = { type: "user", id: "owner@example.test", name: "Owner" };
const REASON = "Support ticket 42";
// The pool sets no ADMIN_AUDIT_RETENTION_MIN_DAYS, so retention is at least 90 days.
const RETENTION = 90;

const GATEKEEPER_ID = 0;
const CHAT_ID = 1;

type Workspace = {
  impl: any;
  instance: OverseerDurableObject;
  state: DurableObjectState;
  id: string;
  // The deployment's stored settings, as the fake KV serves them.
  config: { adminWorkspaceAccess: AdminWorkspaceAccess; adminAuditRetentionDays: number };
  // Replaces the KV read when set, so a test can hold a call at its config read.
  kvGet?: (key: string) => Promise<string | null>;
  gadgetId: number;
  commitId: string;
};

function serveConfig(ws: Workspace, key: string): string | null {
  return key === ADMIN_CONFIG_KEY ? JSON.stringify(ws.config) : null;
}

// Sets impl.env to the pool's env plus a fake BLUEPRINTS serving `ws.config`, and `vars`.
function setEnv(ws: Workspace, vars: Record<string, unknown> = {}): void {
  ws.impl.env = {
    ...env,
    BLUEPRINTS: { get: (key: string) => ws.kvGet ? ws.kvGet(key) : serveConfig(ws, key) },
    ...vars,
  };
}

async function withWorkspace(fn: (ws: Workspace) => Promise<void>,
                             opts: { seed?: boolean } = {}): Promise<void> {
  let stub = env.TEST_OVERSEER.getByName(`admin-view-${crypto.randomUUID()}`);
  await runInDurableObject(stub, async (instance: OverseerDurableObject, state) => {
    let impl = (instance as unknown as { impl: any }).impl;
    let ws: Workspace = {
      impl, instance, state, id: state.id.toString(),
      config: { adminWorkspaceAccess: "metadata", adminAuditRetentionDays: RETENTION },
      gadgetId: -1, commitId: "",
    };
    setEnv(ws);
    if (opts.seed ?? true) await seed(ws);
    await fn(ws);
  });
}

async function seed(ws: Workspace): Promise<void> {
  let impl = ws.impl;
  impl.directories = {
    getByName: () => ({ syncWorkspace: async () => {}, removeWorkspace: async () => {} }),
  };
  impl.users = {
    idFromString: (id: string) => id,
    get: () => ({ whoami: async () => OWNER, getGadget: async () => null }),
  };
  impl.ownerId = OWNER_USER_ID;
  impl.ownerProfileId = OWNER.id;
  impl.storage.ownerId.put(OWNER_USER_ID);
  impl.storage.title.put("Quarterly plan");

  impl.storage.chatMeta.put({
    id: CHAT_ID, title: "Plans", started: new Date(0), lastActive: new Date(0),
    queuedSteers: [{ text: "steer text", author: OWNER }],
  });
  impl.addChatMessages(CHAT_ID, OWNER, [{ type: "message", message: "secret message" }]);

  impl.storage.nextGatekeeperId.put(GATEKEEPER_ID + 1);
  impl.storage.gatekeepers.put({
    id: GATEKEEPER_ID, resourceTitle: "Repo", resourceUrl: "https://example.com/repo",
    class: {} as any,
    creationSpec: {
      type: "gatekeeper", vendorId: "TestVendor", resourceUrl: "https://example.com/repo",
      typeUrlPattern: "https://*",
    },
  });
  putAction(impl.storage, 0, { type: "observation", gatekeeperId: GATEKEEPER_ID });
  putAction(impl.storage, 1, { type: "action", gatekeeperId: GATEKEEPER_ID });
  putAction(impl.storage, 2, { type: "bindHook", gatekeeperId: GATEKEEPER_ID });
  for (let id of [0, 1]) {
    let record = impl.storage.actions.get(id);
    record.description.fields = [{ label: "Body", kind: "inline", value: "secret field" }];
    impl.storage.actions.put(record);
  }
  let hook = impl.storage.actions.get(2);
  hook.hookId = 0;
  impl.storage.actions.put(hook);
  impl.storage.boundHooks.put({
    id: 0, actionId: 2, gatekeeperId: GATEKEEPER_ID, controller: {} as any, callback: {} as any,
    description: { title: "On push", description: "secret hook description" }, enabled: true,
  });

  let files = new Map([["notes.txt", "private notes\n"]]);
  ws.commitId = await impl.gitCache.writeFilesAsCommit(files, {
    parents: [],
    author: { name: "Owner", email: "owner@example.test" },
    message: "notes",
    timestamp: new Date(1700000000_000),
  });
  let gadget = impl.createGadget("Notes", "NOTES", undefined, undefined, ws.commitId);
  ws.gadgetId = gadget.id;
  impl.storage.gadgets.put({
    ...gadget,
    upstream: { blueprintId: "bp-1" },
    bindings: { REPO: { target: GATEKEEPER_ID } },
  });
}

// A view asks for the level it is minted at unless `overrides` says otherwise.
function terms(overrides: Partial<AdminViewTerms> = {}): AdminViewTerms {
  return {
    via: "api", access: "metadata", expiresAt: new Date(Date.now() + 600_000), ...overrides,
    requested: overrides.requested ?? overrides.access ?? "metadata",
  };
}

function open(ws: Workspace, overrides: Partial<AdminViewTerms> = {},
              admin = ADMIN, reason = REASON) {
  return ws.instance.openForAdmin(admin, reason, "session-1", terms(overrides));
}

// The code a refusal carries, failing the test if `promise` resolves.
async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (err) {
    return getAdminAccessErrorCode(err) ?? `uncoded: ${String(err)}`;
  }
  throw new Error("Expected a refusal.");
}

// The deployment-wide log's records for this workspace, oldest first.
async function deploymentRecords(ws: Workspace): Promise<AdminAccessRecord[]> {
  let page = await env.TEST_ADMIN_AUDIT.getByName("")
      .list({ workspace: ws.id, limit: 200 }, RETENTION);
  return (page.records as AdminAccessRecord[]).toReversed();
}

function storageKeys(ws: Workspace): string[] {
  return [...ws.state.storage.kv.list()].map(([key]) => key);
}

describe("opening an admin view", () => {
  it("refuses an uninitialised workspace without initialising it", () => withWorkspace(async ws => {
    expect(await codeOf(open(ws))).toBe(ADMIN_ACCESS_ERROR_CODES.workspaceNotFound);
    expect(storageKeys(ws)).toStrictEqual([]);
    expect(await deploymentRecords(ws)).toStrictEqual([]);
  }, { seed: false }));

  it("refuses, unrecorded, a caller who is not an admin and malformed terms",
      () => withWorkspace(async ws => {
    expect(await codeOf(open(ws, {}, "owner@example.test")))
        .toBe(ADMIN_ACCESS_ERROR_CODES.notAdmin);
    await expect(open(ws, {}, ADMIN, "   ")).rejects.toThrow(TypeError);
    await expect(open(ws, {}, ADMIN, "x".repeat(MAX_ADMIN_ACCESS_REASON_LENGTH + 1)))
        .rejects.toThrow(TypeError);
    await expect(open(ws, { via: "gatekeeper" as any })).rejects.toThrow(TypeError);
    await expect(open(ws, { access: "off" as any })).rejects.toThrow(TypeError);
    await expect(open(ws, { requested: "off" as any })).rejects.toThrow(TypeError);
    await expect(open(ws, { requested: "everything" as any })).rejects.toThrow(TypeError);
    await expect(open(ws, { requested: "full", access: "off" as any })).rejects.toThrow(TypeError);
    await expect(open(ws, { requested: "metadata", access: "full" })).rejects.toThrow(TypeError);
    // Past the helper, which fills in a missing level.
    await expect(ws.instance.openForAdmin(ADMIN, REASON, "session-1",
        { ...terms(), requested: undefined } as unknown as AdminViewTerms))
        .rejects.toThrow(TypeError);
    await expect(open(ws, { expiresAt: new Date(NaN) })).rejects.toThrow(TypeError);
    await expect(open(ws, { expiresAt: "tomorrow" as any })).rejects.toThrow(TypeError);
    await expect(open(ws, {
      expiresAt: new Date(Date.now() + (MAX_ADMIN_VIEW_LIFETIME_SECONDS + 120) * 1000),
    })).rejects.toThrow(TypeError);
    // Already past is not malformed: it is an expired view.
    expect(await codeOf(open(ws, { expiresAt: new Date(Date.now() - 1000) })))
        .toBe(ADMIN_ACCESS_ERROR_CODES.viewExpired);

    expect(await deploymentRecords(ws)).toStrictEqual([]);
  }));

  it("records the open before returning the view", () => withWorkspace(async ws => {
    let expiresAt = new Date(Date.now() + 600_000);
    await open(ws, { via: "cli", expiresAt });
    let [record, ...rest] = await deploymentRecords(ws);
    expect(rest).toStrictEqual([]);
    expect(record).toStrictEqual({
      kind: "workspace", workspaceId: ws.id, workspaceOwner: OWNER.id, at: expect.any(Date),
      admin: ADMIN, sessionId: "session-1", via: "cli", workspaceTitle: "Quarterly plan",
      method: "inspectWorkspace", args: { expiresAt: expiresAt.toISOString() }, reason: REASON,
      requested: "metadata", access: "metadata", exposed: "metadata",
    });
  }));

  it("records an open while the setting is off as refused",
      () => withWorkspace(async ws => {
    ws.config.adminWorkspaceAccess = "off";
    expect(await codeOf(open(ws))).toBe(ADMIN_ACCESS_ERROR_CODES.accessOff);
    let records = await deploymentRecords(ws);
    expect(records.map(r => [r.method, r.access, r.refused]))
        .toStrictEqual([["inspectWorkspace", "off", ADMIN_ACCESS_ERROR_CODES.accessOff]]);
  }));

  it("fails when the record cannot be written", () => withWorkspace(async ws => {
    let live = await open(ws);
    ws.impl.adminAudits = {
      getByName: () => ({ append: async () => { throw new Error("audit store down"); } }),
    };
    await expect(open(ws)).rejects.toThrow("audit store down");
    await expect(live.listChats()).rejects.toThrow("audit store down");
    expect((await deploymentRecords(ws)).map(r => r.method)).toStrictEqual(["inspectWorkspace"]);
  }));
});

describe("a metadata view", () => {
  it("records every call, content refusals included",
      () => withWorkspace(async ws => {
    let view = await open(ws);
    await view.describe();
    await view.listChats();
    expect(await codeOf(view.getChat(CHAT_ID))).toBe(ADMIN_ACCESS_ERROR_CODES.contentWithheld);
    await view.listActions({ filter: "all" });
    await view.listFiles(ws.gadgetId);
    expect(await codeOf(view.readFile(ws.gadgetId, "notes.txt")))
        .toBe(ADMIN_ACCESS_ERROR_CODES.contentWithheld);
    await view.listGatekeepers();
    await view.getDiagnostics();

    let records = await deploymentRecords(ws);
    expect(records.map(r => [r.method, r.args, r.access, r.refused])).toStrictEqual([
      ["inspectWorkspace", { expiresAt: expect.any(String) }, "metadata", undefined],
      ["describe", {}, "metadata", undefined],
      ["listChats", {}, "metadata", undefined],
      ["getChat", { chatId: CHAT_ID }, "metadata", ADMIN_ACCESS_ERROR_CODES.contentWithheld],
      ["listActions", { filter: "all" }, "metadata", undefined],
      ["listFiles", { gadgetId: ws.gadgetId }, "metadata", undefined],
      ["readFile", { gadgetId: ws.gadgetId, path: "notes.txt" }, "metadata",
       ADMIN_ACCESS_ERROR_CODES.contentWithheld],
      ["listGatekeepers", {}, "metadata", undefined],
      ["getDiagnostics", {}, "metadata", undefined],
    ]);
    expect(new Set(records.map(r => r.reason))).toStrictEqual(new Set([REASON]));
    expect(new Set(records.map(r => r.requested))).toStrictEqual(new Set(["metadata"]));
    expect(new Set(records.map(r => r.exposed))).toStrictEqual(new Set(["metadata"]));
  }));

  it("withholds content but keeps structure", () => withWorkspace(async ws => {
    let view = await open(ws);

    let chats = await view.listChats();
    expect(chats.map(chat => chat.title)).toStrictEqual(["Plans"]);
    expect(chats[0]).not.toHaveProperty("queuedSteers");

    let { entries } = await view.listActions();
    expect(entries.map(entry => [entry.type, entry.description.title])).toStrictEqual([
      ["bindHook", "Action 2"], ["action", "Action 1"], ["observation", "Action 0"],
    ]);
    for (let entry of entries) {
      expect(entry.description.description).toBe("");
      expect(entry.description).not.toHaveProperty("fields");
    }

    let description = await view.describe();
    expect(description).toMatchObject({
      id: ws.id, title: "Quarterly plan", owner: OWNER, access: "metadata", collaborators: [],
    });
    let gadget = description.workpieces.find(w => w.id === ws.gadgetId)!;
    expect(gadget).toMatchObject({ type: "gadget", title: "Notes", commitId: ws.commitId });
    expect(gadget).not.toHaveProperty("upstream");

    let [gatekeeper] = await view.listGatekeepers();
    expect(gatekeeper).toMatchObject({
      id: GATEKEEPER_ID, resourceTitle: "Repo", vendorId: "testvendor",
      bindings: [{ gadgetId: ws.gadgetId, name: "REPO" }],
    });
    expect(gatekeeper.hooks.map(hook => [hook.description.title, hook.description.description]))
        .toStrictEqual([["On push", ""]]);

    expect(await view.listFiles(ws.gadgetId)).toStrictEqual([{ name: "notes.txt", kind: "file" }]);
  }));

  it("changes nothing a member sees and joins no session", () => withWorkspace(async ws => {
    let impl = ws.impl;
    let actionsBefore = [...impl.storage.actions.list()];
    let notified: string[] = [];
    impl.storage.actions.subscribe({
      add: () => notified.push("add"),
      update: () => notified.push("update"),
      remove: () => notified.push("remove"),
    });

    let view = await open(ws);
    await view.describe();
    await view.listChats();
    await view.listActions();
    await view.getChat(CHAT_ID).catch(() => {});

    expect(notified).toStrictEqual([]);
    expect([...impl.storage.actions.list()]).toStrictEqual(actionsBefore);
    expect(impl.liveSessionCounts()).toStrictEqual({ owner: 0, build: 0, use: 0 });
    expect((await view.getDiagnostics()).sessions).toStrictEqual({ owner: 0, build: 0, use: 0 });
  }));
});

describe("a full view", () => {
  it("reads content when both the cap and the setting allow it, through impl.env alone",
      () => withWorkspace(async ws => {
    // The pool's own env caps at "metadata": only impl.env says "full".
    setEnv(ws, { ADMIN_WORKSPACE_ACCESS_MAX: "full" });
    ws.config.adminWorkspaceAccess = "full";
    let view = await open(ws, { access: "full" });

    let history = await view.getChat(CHAT_ID);
    expect(history.messages.map(message => message.type === "message" && message.message))
        .toStrictEqual(["secret message"]);
    expect(await view.readFile(ws.gadgetId, "notes.txt"))
        .toStrictEqual({ kind: "text", text: "private notes\n" });
    expect((await view.listChats())[0].queuedSteers).toStrictEqual(
        [{ text: "steer text", author: OWNER }]);
    let { workpieces } = await view.describe();
    expect(workpieces.find(w => w.id === ws.gadgetId)!.upstream)
        .toStrictEqual({ blueprintId: "bp-1" });
    let [gatekeeper] = await view.listGatekeepers();
    expect(gatekeeper.hooks[0].description.description).toBe("secret hook description");
    let { entries } = await view.listActions();
    expect(entries.find(entry => entry.type === "action")!.description)
        .toMatchObject({ description: "Action 1 description", fields: [expect.anything()] });
    expect((await deploymentRecords(ws)).every(r => r.access === "full")).toBe(true);
  }));

  it("records what each call's answer exposed", () => withWorkspace(async ws => {
    setEnv(ws, { ADMIN_WORKSPACE_ACCESS_MAX: "full" });
    ws.config.adminWorkspaceAccess = "full";
    let view = await open(ws, { access: "full" });

    await view.getChat(CHAT_ID);
    await view.readFile(ws.gadgetId, "notes.txt");
    await view.listChats();
    await view.describe();
    await view.listGatekeepers();
    await view.listActions();
    await view.listFiles(ws.gadgetId);
    await view.getDiagnostics();
    expect(await view.readFile(ws.gadgetId, "missing.txt")).toStrictEqual({ kind: "absent" });
    expect((await view.getChat(999)).messages).toStrictEqual([]);
    expect((await view.listActions({ beforeId: 0 })).entries).toStrictEqual([]);

    let records = await deploymentRecords(ws);
    expect(records.map(r => [r.method, r.exposed])).toStrictEqual([
      ["inspectWorkspace", "metadata"],
      ["getChat", "content"],
      ["readFile", "content"],
      ["listChats", "content"],
      ["describe", "content"],
      ["listGatekeepers", "content"],
      ["listActions", "content"],
      ["listFiles", "metadata"],
      ["getDiagnostics", "metadata"],
      ["readFile", "metadata"],
      ["getChat", "metadata"],
      ["listActions", "metadata"],
    ]);
    expect(records.every(r => r.requested === "full" && r.access === "full")).toBe(true);
  }));

  it("returns nothing when the deployment-wide record cannot be written",
      () => withWorkspace(async ws => {
    setEnv(ws, { ADMIN_WORKSPACE_ACCESS_MAX: "full" });
    ws.config.adminWorkspaceAccess = "full";
    let view = await open(ws, { access: "full" });
    ws.impl.adminAudits = {
      getByName: () => ({ append: async () => { throw new Error("audit store down"); } }),
    };
    await expect(view.getChat(CHAT_ID)).rejects.toThrow("audit store down");
    expect((await deploymentRecords(ws)).map(r => r.method)).toStrictEqual(["inspectWorkspace"]);
  }));

  it("is held to the environment's cap whatever the setting says", () => withWorkspace(async ws => {
    ws.config.adminWorkspaceAccess = "full";
    let view = await open(ws, { access: "full" });
    expect(await codeOf(view.getChat(CHAT_ID))).toBe(ADMIN_ACCESS_ERROR_CODES.contentWithheld);
    expect((await deploymentRecords(ws)).map(r => r.access)).toStrictEqual(["metadata", "metadata"]);
  }));

  it("opens at the deployment's level when it asks for more, and is never raised",
      () => withWorkspace(async ws => {
    // As AdminApiImpl mints a view that asked for "full" while the deployment allows "metadata".
    let view = await open(ws, { requested: "full", access: "metadata" });
    expect(await codeOf(view.getChat(CHAT_ID))).toBe(ADMIN_ACCESS_ERROR_CODES.contentWithheld);
    expect((await deploymentRecords(ws)).map(r => [r.method, r.requested, r.access, r.exposed]))
        .toStrictEqual([
          ["inspectWorkspace", "full", "metadata", "metadata"],
          ["getChat", "full", "metadata", "metadata"],
        ]);

    setEnv(ws, { ADMIN_WORKSPACE_ACCESS_MAX: "full" });
    ws.config.adminWorkspaceAccess = "full";
    expect(await codeOf(view.getChat(CHAT_ID))).toBe(ADMIN_ACCESS_ERROR_CODES.contentWithheld);
    expect((await view.describe()).access).toBe("metadata");
  }));

  it("withholds from its next call once the setting drops to metadata",
      () => withWorkspace(async ws => {
    setEnv(ws, { ADMIN_WORKSPACE_ACCESS_MAX: "full" });
    ws.config.adminWorkspaceAccess = "full";
    let view = await open(ws, { access: "full" });
    expect((await view.listChats())[0].queuedSteers).toBeDefined();

    ws.config.adminWorkspaceAccess = "metadata";
    expect((await view.listChats())[0]).not.toHaveProperty("queuedSteers");
    expect(await codeOf(view.readFile(ws.gadgetId, "notes.txt")))
        .toBe(ADMIN_ACCESS_ERROR_CODES.contentWithheld);
  }));
});

describe("a live view's checks", () => {
  it("refuses, recorded, a call once the setting is off", () => withWorkspace(async ws => {
    let view = await open(ws);
    ws.config.adminWorkspaceAccess = "off";
    expect(await codeOf(view.describe())).toBe(ADMIN_ACCESS_ERROR_CODES.accessOff);
    let records = await deploymentRecords(ws);
    expect(records.at(-1)).toMatchObject(
        { method: "describe", access: "off", refused: ADMIN_ACCESS_ERROR_CODES.accessOff });
  }));

  it("refuses, unrecorded, a call after expiry or demotion, or on a deleted workspace",
      () => withWorkspace(async ws => {
    let shortLived = await open(ws, { expiresAt: new Date(Date.now() + SHORT_LIFETIME_MS) });
    let view = await open(ws);
    await scheduler.wait(SHORT_LIFETIME_MS + 100);
    expect(await codeOf(shortLived.listChats())).toBe(ADMIN_ACCESS_ERROR_CODES.viewExpired);

    setEnv(ws, { ADMINS: ["someone-else@example.test"] });
    expect(await codeOf(view.listChats())).toBe(ADMIN_ACCESS_ERROR_CODES.notAdmin);
    setEnv(ws);

    ws.impl.ownerId = undefined;
    expect(await codeOf(view.listChats())).toBe(ADMIN_ACCESS_ERROR_CODES.workspaceNotFound);

    expect((await deploymentRecords(ws)).map(r => r.method))
        .toStrictEqual(["inspectWorkspace", "inspectWorkspace"]);
  }));

  it("writes nothing for a call that the workspace's deletion overtakes",
      () => withWorkspace(async ws => {
    let view = await open(ws);
    let reached!: () => void;
    let atRead = new Promise<void>(resolve => { reached = resolve; });
    let release!: () => void;
    let released = new Promise<void>(resolve => { release = resolve; });
    ws.kvGet = async key => {
      reached();
      await released;
      return serveConfig(ws, key);
    };

    let call = view.listChats();
    await atRead;
    await ws.state.storage.deleteAll();
    ws.impl.ownerId = undefined;
    release();

    expect(await codeOf(call)).toBe(ADMIN_ACCESS_ERROR_CODES.workspaceNotFound);
    expect(storageKeys(ws)).toStrictEqual([]);
    expect((await deploymentRecords(ws)).map(r => r.method)).toStrictEqual(["inspectWorkspace"]);
  }));

  it("writes nothing for a call that expires while it reads the setting",
      () => withWorkspace(async ws => {
    let view = await open(ws, { expiresAt: new Date(Date.now() + SHORT_LIFETIME_MS) });
    let reached!: () => void;
    let atRead = new Promise<void>(resolve => { reached = resolve; });
    let release!: () => void;
    let released = new Promise<void>(resolve => { release = resolve; });
    ws.kvGet = async key => {
      reached();
      await released;
      return serveConfig(ws, key);
    };

    let call = view.listChats();
    await atRead;
    await scheduler.wait(SHORT_LIFETIME_MS + 100);
    release();

    expect(await codeOf(call)).toBe(ADMIN_ACCESS_ERROR_CODES.viewExpired);
    expect((await deploymentRecords(ws)).map(r => r.method)).toStrictEqual(["inspectWorkspace"]);
  }));
});

// Holds describe() at its read of the owner's profile until `release`.
function holdDescribe(ws: Workspace): { reached: Promise<void>, release: () => void } {
  let reach!: () => void;
  let reached = new Promise<void>(resolve => { reach = resolve; });
  let release!: () => void;
  let released = new Promise<void>(resolve => { release = resolve; });
  ws.impl.users = {
    idFromString: (id: string) => id,
    get: () => ({ whoami: async () => { reach(); await released; return OWNER; } }),
  };
  return { reached, release };
}

describe("a call overtaken while it reads its answer", () => {
  it("writes nothing when the workspace is deleted", () => withWorkspace(async ws => {
    let view = await open(ws);
    let hold = holdDescribe(ws);

    let call = view.describe();
    await hold.reached;
    await ws.state.storage.deleteAll();
    ws.impl.ownerId = undefined;
    hold.release();

    expect(await codeOf(call)).toBe(ADMIN_ACCESS_ERROR_CODES.workspaceNotFound);
    expect(storageKeys(ws)).toStrictEqual([]);
    expect((await deploymentRecords(ws)).map(r => r.method)).toStrictEqual(["inspectWorkspace"]);
  }));

  it("writes nothing when the view expires", () => withWorkspace(async ws => {
    let view = await open(ws, { expiresAt: new Date(Date.now() + SHORT_LIFETIME_MS) });
    let hold = holdDescribe(ws);

    let call = view.describe();
    await hold.reached;
    await scheduler.wait(SHORT_LIFETIME_MS + 100);
    hold.release();

    expect(await codeOf(call)).toBe(ADMIN_ACCESS_ERROR_CODES.viewExpired);
    expect((await deploymentRecords(ws)).map(r => r.method)).toStrictEqual(["inspectWorkspace"]);
  }));
});

describe("the records' bounds", () => {
  it("cut a long title, while describe() returns it whole",
      () => withWorkspace(async ws => {
    let title = "t".repeat(2_000_000);
    ws.impl.storage.title.put(title);
    let view = await open(ws);
    expect((await view.describe()).title).toBe(title);

    let cut = `${"t".repeat(MAX_ADMIN_AUDIT_ARG_LENGTH - 1)}…`;
    let records = await deploymentRecords(ws);
    expect(records.map(r => r.workspaceTitle)).toStrictEqual([cut, cut]);
  }));

  it("report the workspace's operational state in the diagnostics", () => withWorkspace(async ws => {
    let view = await open(ws);
    let diagnostics = await view.getDiagnostics();
    expect(diagnostics).toMatchObject({
      chats: 1, pendingActions: 3, hooks: { total: 1, enabled: 1 }, observers: 0,
      ownerRegistrationPending: false, activeAgentChatIds: [], pendingAgentCalls: 0,
    });
  }));
});

// Deletes a stored object that a connection could serve again, and makes reaching any connection's
// facet visible to the test.
function forbidPulls(ws: Workspace, oid: string, type: "blob" | "tree"): { pulled: boolean } {
  let state = { pulled: false };
  ws.impl.storage.gitObjectMetadata.put(
      { oid, type, onRemote: [GATEKEEPER_ID], pullableFrom: [], pendingPush: [] });
  ws.impl.storage.gitObjects.delete(oid);
  ws.impl.getGatekeeperFacet = () => {
    state.pulled = true;
    throw new Error("an admin read reached a connection");
  };
  return state;
}

describe("file reads", () => {
  it("never pull a missing blob through a connection", () => withWorkspace(async ws => {
    setEnv(ws, { ADMIN_WORKSPACE_ACCESS_MAX: "full" });
    ws.config.adminWorkspaceAccess = "full";
    let view = await open(ws, { access: "full" });
    let entry = await ws.impl.gitCache.pathEntryAtCommit(ws.commitId, "notes.txt");
    let pulls = forbidPulls(ws, entry.oid, "blob");

    await expect(view.readFile(ws.gadgetId, "notes.txt"))
        .rejects.toThrow(`git object ${entry.oid} is not stored in this workspace`);
    expect(pulls.pulled).toBe(false);
    // Recorded as an attempt that exposed nothing.
    let records = await deploymentRecords(ws);
    expect(records.at(-1))
        .toMatchObject({ method: "readFile", access: "full", exposed: "metadata" });
    expect(records.at(-1)).not.toHaveProperty("refused");
  }));

  it("never pull a missing tree through a connection", () => withWorkspace(async ws => {
    let view = await open(ws);
    let root = await ws.impl.gitCache.pathEntryAtCommit(ws.commitId, "");
    let pulls = forbidPulls(ws, root.oid, "tree");

    await expect(view.listFiles(ws.gadgetId))
        .rejects.toThrow(`git object ${root.oid} is not stored in this workspace`);
    expect(pulls.pulled).toBe(false);
  }));

  it("read only a permanent gadget's head", () => withWorkspace(async ws => {
    let view = await open(ws);
    await expect(view.listFiles(GATEKEEPER_ID))
        .rejects.toThrow(`No gadget with committed code has id ${GATEKEEPER_ID}.`);
    await expect(view.listFiles(999)).rejects.toThrow("No gadget with committed code has id 999.");
  }));
});
