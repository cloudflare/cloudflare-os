import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import {
  ADMIN_ACCESS_ERROR_CODES, ADMIN_CONTENT_REQUEST_LIFETIME_SECONDS, ADMIN_GRANT_ERROR_CODES,
  DEFAULT_ADMIN_VIEW_LIFETIME_SECONDS, MAX_ADMIN_AUDIT_ARG_LENGTH, createAdminAccessError,
  createAdminGrantError, getAdminAccessErrorCode, getAdminGrantErrorCode,
  type AdminAccessRecord, type AdminContentRequest, type AdminUserAccessRecord, type AdminVia,
} from "@gadgets/workshop-shared/api";
import type { AdminWorkspaceViewTerms } from "../src/admin-access.js";
import { AdminApiImpl } from "../src/admin-settings.js";
import type { IssueReportsDurableObject } from "../src/issue-reports.js";
import type { OverseerDurableObject } from "../src/overseer.js";
import {
  DEFAULT_ADMIN_CONFIG, type AdminConfig,
} from "../src/storage-schema/admin-settings-storage.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const ADMIN = "admin@example.test";
const REASON = "Investigating a support ticket";

type Call = { target: string; method: string; args: unknown[] };
type Handler = (...args: any[]) => unknown;

/**
 * An AdminApiImpl over fake namespaces, with ADMINS listing ADMIN and `vars` beside it. `calls`
 * lists every namespace and stub call made after the capability was minted, in order; a stub
 * method answers from `handlers[target][method]`, else with undefined. The AdminSettings stub
 * answers committedAdminConfig() with `config` over the defaults. `waitUntil` is the execution
 * context's, which records the promises it is given.
 */
function deployment(options: {
  config?: Partial<AdminConfig>;
  vars?: object;
  handlers?: Record<string, Record<string, Handler>>;
} = {}) {
  const calls: Call[] = [];
  const handlers: Record<string, Record<string, Handler>> = {
    admin: { committedAdminConfig: () => ({ ...DEFAULT_ADMIN_CONFIG, ...options.config }) },
    ...options.handlers,
  };
  const stub = (target: string) => new Proxy({}, {
    get: (_object, method) => {
      if (typeof method !== "string" || method === "then") return undefined;
      return async (...args: unknown[]) => {
        calls.push({ target, method, args });
        return handlers[target]?.[method]?.(...args);
      };
    },
  });
  const namespace = (target: string) => ({
    getByName: (name: string) => {
      calls.push({ target: `${target}s`, method: "getByName", args: [name] });
      return stub(target);
    },
  });
  const waitUntil = vi.fn<(promise: Promise<unknown>) => void>();
  const ctx = { waitUntil, exports: {
    AdminSettings: namespace("admin"),
    UserDirectoryDurableObject: namespace("directory"),
    AdminAuditDurableObject: namespace("audit"),
    UserDurableObject: namespace("user"),
    IssueReportsDurableObject: namespace("report"),
    OverseerDurableObject: {
      idFromString: (id: string) => {
        calls.push({ target: "overseers", method: "idFromString", args: [id] });
        return env.TEST_OVERSEER.idFromString(id);
      },
      get: (id: DurableObjectId) => {
        calls.push({ target: "overseers", method: "get", args: [id.toString()] });
        return stub("overseer");
      },
    },
  } } as unknown as ExecutionContext;
  const deploymentEnv = { ADMINS: [ADMIN], ...options.vars } as unknown as Cloudflare.Env;
  const mint = (adminUserId = ADMIN, via: AdminVia = "cli") => {
    const api = new AdminApiImpl(ctx, deploymentEnv, adminUserId, via);
    calls.length = 0;
    return api;
  };
  const callsTo = (target: string, method: string) =>
      calls.filter(call => call.target === target && call.method === method);
  return { mint, calls, callsTo, waitUntil };
}

async function rejection(call: Promise<unknown>): Promise<unknown> {
  try {
    await call;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the call to reject.");
}

const workspaceId = () => env.TEST_OVERSEER.newUniqueId().toString();

/** `calls` as "target.method", in order. */
const named = (calls: Call[]) => calls.map(call => `${call.target}.${call.method}`);

describe("AdminApiImpl.inspectWorkspace", () => {
  it("rejects a bad reason or lifetime before touching anything", async () => {
    const { mint, calls } = deployment();
    const api = mint();
    const id = workspaceId();
    for (let reason of ["", "   ", "r".repeat(501)]) {
      expect(await rejection(api.inspectWorkspace(id, reason))).toBeInstanceOf(TypeError);
    }
    for (let lifetimeSeconds of [0, -1, 1.5, 3601]) {
      expect(await rejection(api.inspectWorkspace(id, REASON, { lifetimeSeconds })))
          .toBeInstanceOf(TypeError);
    }
    expect(calls).toEqual([]);
  });

  it("refuses a caller no longer an admin before touching anything", async () => {
    const { mint, calls } = deployment();
    const error = await rejection(
        mint("former@example.test").inspectWorkspace(workspaceId(), REASON));
    expect(getAdminAccessErrorCode(error)).toBe(ADMIN_ACCESS_ERROR_CODES.notAdmin);
    expect(calls).toEqual([]);
  });

  it("refuses a malformed id as not found, recording nothing", async () => {
    const { mint, calls } = deployment();
    const error = await rejection(mint().inspectWorkspace("not-a-workspace", REASON));
    expect(getAdminAccessErrorCode(error)).toBe(ADMIN_ACCESS_ERROR_CODES.workspaceNotFound);
    expect(calls.map(call => `${call.target}.${call.method}`)).toEqual(["overseers.idFromString"]);
  });

  describe.each([
    ["the authoritative config", { config: { adminWorkspaceAccess: "off" as const } }],
    ["ADMIN_WORKSPACE_ACCESS_MAX off", { vars: { ADMIN_WORKSPACE_ACCESS_MAX: "off" } }],
    ["ADMIN_WORKSPACE_ACCESS_MAX not a level", { vars: { ADMIN_WORKSPACE_ACCESS_MAX: "none" } }],
    ["ADMIN_WORKSPACE_ACCESS_MAX full", { vars: { ADMIN_WORKSPACE_ACCESS_MAX: "full" } }],
  ])("while access is off by %s", (_label, setup) => {
    const offDeployment = (listing: Handler, append: Handler = () => {}) => deployment({
      ...setup,
      handlers: { directory: { workspaceListing: listing }, audit: { append } },
    });

    it("records the refused open in the deployment-wide log only, then refuses", async () => {
      const { mint, callsTo } = offDeployment(() => ({ title: "Quarterly plan", ownerId: "ada" }));
      const api = mint();
      const id = workspaceId();
      const before = Date.now();
      const error = await rejection(api.inspectWorkspace(id, `  ${REASON}  `, {
        lifetimeSeconds: 60,
      }));
      const after = Date.now();
      expect(getAdminAccessErrorCode(error)).toBe(ADMIN_ACCESS_ERROR_CODES.accessOff);

      const appends = callsTo("audit", "append");
      expect(appends).toHaveLength(1);
      const [record, retentionDays] = appends[0]!.args as [AdminAccessRecord, number];
      expect(record).toMatchObject({
        kind: "workspace", admin: ADMIN, via: "cli", workspaceId: id, workspaceOwner: "ada",
        workspaceTitle: "Quarterly plan", method: "inspectWorkspace", reason: REASON,
        requested: "metadata", access: "off", exposed: "metadata",
        refused: ADMIN_ACCESS_ERROR_CODES.accessOff,
      });
      expect(Object.keys(record).toSorted()).toEqual([
        "access", "admin", "args", "at", "exposed", "kind", "method", "reason", "refused",
        "requested", "sessionId", "via", "workspaceId", "workspaceOwner", "workspaceTitle",
      ]);
      expect(Object.keys(record.args)).toEqual(["expiresAt"]);
      const expiresAt = Date.parse(record.args.expiresAt as string);
      expect(expiresAt).toBeGreaterThanOrEqual(before + 60_000);
      expect(expiresAt).toBeLessThanOrEqual(after + 60_000);
      // No retention: the directory read awaits, so the one read before it may be stale.
      expect(retentionDays).toBeUndefined();
      expect(callsTo("overseers", "get")).toEqual([]);

      // The same capability's records share a session id.
      await rejection(api.inspectWorkspace(id, REASON));
      const [second] = callsTo("audit", "append")[1]!.args as [AdminAccessRecord];
      expect(second.sessionId).toBe(record.sessionId);
    });

    it("refuses an open for content as any other, for access being off", async () => {
      const { mint, callsTo } = offDeployment(() => ({ title: "Quarterly plan", ownerId: "ada" }));
      const error = await rejection(
          mint().inspectWorkspace(workspaceId(), REASON, { access: "content" }));
      expect(getAdminAccessErrorCode(error)).toBe(ADMIN_ACCESS_ERROR_CODES.accessOff);
      const [record] = callsTo("audit", "append")[0]!.args as [AdminAccessRecord];
      expect(record).toMatchObject({
        requested: "content", access: "off", exposed: "metadata",
        refused: ADMIN_ACCESS_ERROR_CODES.accessOff,
      });
      expect(callsTo("overseers", "get")).toEqual([]);
    });

    it.each([
      ["lists none", () => null],
      ["cannot be asked", () => { throw new Error("directory unavailable"); }],
    ])("records an empty title and owner when the directory %s", async (_case, listing) => {
      const { mint, callsTo } = offDeployment(listing);
      const error = await rejection(mint().inspectWorkspace(workspaceId(), REASON));
      expect(getAdminAccessErrorCode(error)).toBe(ADMIN_ACCESS_ERROR_CODES.accessOff);
      const [record] = callsTo("audit", "append")[0]!.args as [AdminAccessRecord];
      expect(record.workspaceTitle).toBe("");
      expect(record.workspaceOwner).toBe("");
    });

    it("fails with the audit log's own error when the refusal cannot be recorded", async () => {
      const { mint, callsTo } = offDeployment(() => ({ title: "Plan", ownerId: "ada" }), () => {
        throw new Error("audit log unavailable");
      });
      const error = await rejection(mint().inspectWorkspace(workspaceId(), REASON));
      expect(String(error)).toContain("audit log unavailable");
      expect(callsTo("overseers", "get")).toEqual([]);
    });
  });

  // The level in force is "content" only where the cap and the admins' choice both say so.
  const CONTENT = {
    config: { adminWorkspaceAccess: "content" as const },
    vars: { ADMIN_WORKSPACE_ACCESS_MAX: "content" },
  };

  it.each([
    ["no cap", { config: { adminWorkspaceAccess: "content" as const } }],
    ["the cap at metadata", { ...CONTENT, vars: { ADMIN_WORKSPACE_ACCESS_MAX: "metadata" } }],
    ["the admins' choice of metadata", { vars: CONTENT.vars }],
  ])("records an open for content below that level, by %s, without reaching the workspace",
      async (_case, setup) => {
    const { mint, callsTo } = deployment({
      ...setup,
      handlers: { directory: { workspaceListing: () => ({ title: "Plan", ownerId: "ada" }) } },
    });
    const id = workspaceId();
    const error = await rejection(mint().inspectWorkspace(id, REASON, { access: "content" }));
    expect(getAdminAccessErrorCode(error)).toBe(ADMIN_ACCESS_ERROR_CODES.contentOff);

    const appends = callsTo("audit", "append");
    expect(appends).toHaveLength(1);
    const [record, retentionDays] = appends[0]!.args as [AdminAccessRecord, number];
    expect(record).toStrictEqual({
      kind: "workspace", at: expect.any(Date), admin: ADMIN, sessionId: expect.any(String),
      via: "cli", workspaceId: id, workspaceOwner: "ada", workspaceTitle: "Plan",
      method: "inspectWorkspace", args: { expiresAt: expect.any(String) }, reason: REASON,
      requested: "content", access: "metadata", exposed: "metadata",
      refused: ADMIN_ACCESS_ERROR_CODES.contentOff,
    });
    expect(retentionDays).toBeUndefined();
    expect(callsTo("overseers", "get")).toEqual([]);
  });

  it("takes no option that is not a level a view opens at, and records nothing", () => {
    const { mint, calls } = deployment(CONTENT);
    const api = mint();
    // The method's validator throws before the method runs.
    for (const access of ["full", "off", "", 1]) {
      expect(() => api.inspectWorkspace(workspaceId(), REASON, { access } as never))
          .toThrow(TypeError);
    }
    expect(calls).toEqual([]);
  });

  it.each([
    ["no cap and no options", {}, undefined, "metadata"],
    ["the cap at metadata", { vars: { ADMIN_WORKSPACE_ACCESS_MAX: "metadata" } }, undefined,
     "metadata"],
    ["metadata asked for", {}, { access: "metadata" }, "metadata"],
    // Content must be asked for: the level alone opens a metadata view.
    ["the level at content and no options", CONTENT, undefined, "metadata"],
    ["the level at content and metadata asked for", CONTENT, { access: "metadata" }, "metadata"],
    // No grant is needed to open: the directory and the audit log are not asked either.
    ["the level at content and content asked for", CONTENT, { access: "content" }, "content"],
  ] as const)("opens a view with its channel, what it was asked for and its expiry, given %s",
      async (_case, setup, options, access) => {
    // The view comes back wrapped in its validator, so it is told apart by what it answers.
    const view = { describe: async () => "the minted view" };
    const { mint, callsTo } = deployment({
      ...setup,
      handlers: { overseer: { openForAdmin: () => view } },
    });
    const id = workspaceId();
    const before = Date.now();
    const minted = await mint(ADMIN, "api").inspectWorkspace(id, ` ${REASON} `, options);
    expect(await minted.describe()).toBe("the minted view");
    const after = Date.now();

    expect(callsTo("overseers", "get").map(call => call.args)).toEqual([[id]]);
    const opens = callsTo("overseer", "openForAdmin");
    expect(opens).toHaveLength(1);
    const [adminId, reason, sessionId, terms] = opens[0]!.args as
        [string, string, string, AdminWorkspaceViewTerms];
    expect([adminId, reason, typeof sessionId]).toEqual([ADMIN, REASON, "string"]);
    expect(terms).toStrictEqual({ via: "api", access, expiresAt: terms.expiresAt });
    const lifetime = DEFAULT_ADMIN_VIEW_LIFETIME_SECONDS * 1000;
    expect(terms.expiresAt.getTime()).toBeGreaterThanOrEqual(before + lifetime);
    expect(terms.expiresAt.getTime()).toBeLessThanOrEqual(after + lifetime);
    expect(callsTo("audit", "append")).toEqual([]);
    expect(callsTo("directory", "workspaceListing")).toEqual([]);
  });

  it.each([
    ["succeeds", () => {}],
    ["fails", () => { throw new Error("directory unavailable"); }],
  ])("drops a workspace found missing from the directory, if that %s", async (_case, remove) => {
    const { mint, callsTo } = deployment({ handlers: {
      overseer: { openForAdmin: () => {
        throw createAdminAccessError(ADMIN_ACCESS_ERROR_CODES.workspaceNotFound);
      } },
      directory: { removeWorkspace: remove },
    } });
    const id = workspaceId();
    const error = await rejection(mint().inspectWorkspace(id, REASON));
    expect(getAdminAccessErrorCode(error)).toBe(ADMIN_ACCESS_ERROR_CODES.workspaceNotFound);
    expect(callsTo("directory", "removeWorkspace").map(call => call.args)).toEqual([[id]]);
  });

  it("passes an expired view's refusal through, leaving the directory alone", async () => {
    const { mint, calls } = deployment({ handlers: { overseer: { openForAdmin: () => {
      throw createAdminAccessError(ADMIN_ACCESS_ERROR_CODES.viewExpired);
    } } } });
    const error = await rejection(mint().inspectWorkspace(workspaceId(), REASON));
    expect(getAdminAccessErrorCode(error)).toBe(ADMIN_ACCESS_ERROR_CODES.viewExpired);
    expect(calls.filter(call => call.target.startsWith("director"))).toEqual([]);
  });
});

// Each call as "target.method", in the order made.
const names = (calls: Call[]) => calls.map(call => `${call.target}.${call.method}`);

describe("AdminApiImpl.inspectUser", () => {
  const USER = "ada@example.test";

  it("rejects a bad reason or lifetime before touching anything", async () => {
    const { mint, calls } = deployment();
    const api = mint();
    for (let reason of ["", "   ", "r".repeat(501)]) {
      expect(await rejection(api.inspectUser(USER, reason))).toBeInstanceOf(TypeError);
    }
    for (let lifetimeSeconds of [0, -1, 1.5, 3601]) {
      expect(await rejection(api.inspectUser(USER, REASON, { lifetimeSeconds })))
          .toBeInstanceOf(TypeError);
    }
    expect(calls).toEqual([]);
  });

  it("refuses a caller no longer an admin before touching anything", async () => {
    const { mint, calls } = deployment();
    const error = await rejection(mint("former@example.test").inspectUser(USER, REASON));
    expect(getAdminAccessErrorCode(error)).toBe(ADMIN_ACCESS_ERROR_CODES.notAdmin);
    expect(calls).toEqual([]);
  });

  it("refuses an empty id as not found before touching anything", async () => {
    const { mint, calls } = deployment();
    const error = await rejection(mint().inspectUser("", REASON));
    expect(getAdminAccessErrorCode(error)).toBe(ADMIN_ACCESS_ERROR_CODES.userNotFound);
    expect(calls).toEqual([]);
  });

  describe.each([
    ["the authoritative config", { config: { adminWorkspaceAccess: "off" as const } }],
    ["ADMIN_WORKSPACE_ACCESS_MAX off", { vars: { ADMIN_WORKSPACE_ACCESS_MAX: "off" } }],
    ["ADMIN_WORKSPACE_ACCESS_MAX not a level", { vars: { ADMIN_WORKSPACE_ACCESS_MAX: "none" } }],
    ["ADMIN_WORKSPACE_ACCESS_MAX full", { vars: { ADMIN_WORKSPACE_ACCESS_MAX: "full" } }],
  ])("while access is off by %s", (_label, setup) => {
    it("records the refused open in the deployment-wide log only, then refuses", async () => {
      const { mint, calls, callsTo } = deployment(setup);
      const api = mint();
      const before = Date.now();
      const error = await rejection(api.inspectUser(USER, `  ${REASON}  `, {
        lifetimeSeconds: 60,
      }));
      const after = Date.now();
      expect(getAdminAccessErrorCode(error)).toBe(ADMIN_ACCESS_ERROR_CODES.accessOff);

      // The account and the directory are never reached.
      expect(names(calls)).toEqual(
          ["admin.committedAdminConfig", "audits.getByName", "audit.append"]);
      expect(callsTo("audits", "getByName")[0]!.args).toEqual([""]);
      const appended = callsTo("audit", "append")[0]!.args;
      // One argument: no retention, as a view's records are appended.
      expect(appended).toHaveLength(1);
      const [record] = appended as [AdminUserAccessRecord];
      expect(record).toStrictEqual({
        kind: "user", at: expect.any(Date), admin: ADMIN, sessionId: expect.any(String),
        via: "cli", userId: USER, method: "inspectUser", args: { expiresAt: expect.any(String) },
        reason: REASON, access: "off", refused: ADMIN_ACCESS_ERROR_CODES.accessOff,
      });
      const expiresAt = record.args.expiresAt as string;
      expect(new Date(expiresAt).toISOString()).toBe(expiresAt);
      expect(Date.parse(expiresAt)).toBeGreaterThanOrEqual(before + 60_000);
      expect(Date.parse(expiresAt)).toBeLessThanOrEqual(after + 60_000);

      // The same capability's records share a session id.
      await rejection(api.inspectUser(USER, REASON));
      const [second] = callsTo("audit", "append")[1]!.args as [AdminUserAccessRecord];
      expect(second.sessionId).toBe(record.sessionId);
    });

    it("names the id as the admin gave it, whether or not it is an account's", async () => {
      const { mint, callsTo } = deployment(setup);
      await rejection(mint().inspectUser("No Such User", REASON));
      const [record] = callsTo("audit", "append")[0]!.args as [AdminUserAccessRecord];
      expect(record.userId).toBe("No Such User");
    });

    it("fails with the audit log's own error when the refusal cannot be recorded", async () => {
      const { mint, calls } = deployment({ ...setup, handlers: { audit: { append: () => {
        throw new Error("audit log unavailable");
      } } } });
      const error = await rejection(mint().inspectUser(USER, REASON));
      expect(String(error)).toContain("audit log unavailable");
      expect(getAdminAccessErrorCode(error)).toBeUndefined();
      expect(calls.filter(call => call.target.startsWith("user"))).toEqual([]);
    });
  });

  it.each([
    ["no cap and no options", undefined, undefined],
    ["the cap at metadata", "metadata", undefined],
    // The options declare no level, so one passed all the same is never read.
    ["a level passed in the options", undefined, { access: "full" } as never],
  ] as const)("opens a view with its channel and expiry alone, given %s",
      async (_case, max, options) => {
    // The view comes back wrapped in its validator, so it is told apart by what it answers.
    const view = { describe: async () => "the minted view" };
    const { mint, calls, callsTo } = deployment({
      vars: max === undefined ? {} : { ADMIN_WORKSPACE_ACCESS_MAX: max },
      handlers: { user: { openForAdmin: () => view } },
    });
    const before = Date.now();
    const minted = await mint(ADMIN, "api").inspectUser(USER, ` ${REASON} `, options);
    expect(await minted.describe()).toBe("the minted view");
    const after = Date.now();

    // The account is reached by the id as given, and nothing is recorded here: the open's record
    // is the view's own.
    expect(names(calls)).toEqual(
        ["admin.committedAdminConfig", "users.getByName", "user.openForAdmin"]);
    expect(callsTo("users", "getByName")[0]!.args).toEqual([USER]);
    const [adminId, reason, sessionId, terms] = callsTo("user", "openForAdmin")[0]!.args as
        [string, string, string, { via: string; expiresAt: Date }];
    expect([adminId, reason, typeof sessionId]).toEqual([ADMIN, REASON, "string"]);
    expect(terms).toStrictEqual({ via: "api", expiresAt: terms.expiresAt });
    const lifetime = DEFAULT_ADMIN_VIEW_LIFETIME_SECONDS * 1000;
    expect(terms.expiresAt.getTime()).toBeGreaterThanOrEqual(before + lifetime);
    expect(terms.expiresAt.getTime()).toBeLessThanOrEqual(after + lifetime);
  });

  it.each([
    ["an account that does not exist", ADMIN_ACCESS_ERROR_CODES.userNotFound],
    ["an expired view", ADMIN_ACCESS_ERROR_CODES.viewExpired],
  ] as const)("passes the refusal of %s through, recording nothing", async (_case, code) => {
    const { mint, calls } = deployment({ handlers: { user: { openForAdmin: () => {
      throw createAdminAccessError(code);
    } } } });
    const error = await rejection(mint().inspectUser(USER, REASON));
    expect(getAdminAccessErrorCode(error)).toBe(code);
    expect(names(calls)).toEqual(
        ["admin.committedAdminConfig", "users.getByName", "user.openForAdmin"]);
  });

  it("shares the capability's session id with inspectWorkspace()", async () => {
    const { mint, callsTo } = deployment({ handlers: {
      user: { openForAdmin: () => ({}) }, overseer: { openForAdmin: () => ({}) },
    } });
    const api = mint();
    const another = mint();
    await api.inspectUser(USER, REASON);
    await api.inspectWorkspace(workspaceId(), REASON);
    await another.inspectUser(USER, REASON);
    const [first, other] = callsTo("user", "openForAdmin").map(call => call.args[2]);
    const [workspace] = callsTo("overseer", "openForAdmin").map(call => call.args[2]);
    expect(typeof first).toBe("string");
    expect(workspace).toBe(first);
    // Another capability has a session id of its own.
    expect(other).not.toBe(first);
  });
});

describe("AdminApiImpl settings", () => {
  it("says who changes a setting, through which method and session", async () => {
    const { mint, callsTo } = deployment();
    const first = mint(ADMIN, "cli");
    const second = mint(ADMIN, "api");
    await first.setSiteName("Acme");
    await first.setUserModelsEnabled(false);
    await second.setSiteName("Acme");

    const actors = [
      callsTo("admin", "updateAdminConfig")[0]!.args,
      callsTo("admin", "setUserModelsEnabled")[0]!.args,
      callsTo("admin", "updateAdminConfig")[1]!.args,
    ].map(args => args.at(-1) as { sessionId: string });
    expect(callsTo("admin", "updateAdminConfig")[0]!.args[0]).toEqual({ siteName: "Acme" });
    expect(actors[0]).toEqual(
        { admin: ADMIN, sessionId: actors[0]!.sessionId, via: "cli", method: "setSiteName" });
    expect(actors[1]).toEqual({
      admin: ADMIN, sessionId: actors[0]!.sessionId, via: "cli", method: "setUserModelsEnabled",
    });
    expect(actors[2]).toMatchObject({ via: "api", method: "setSiteName" });
    expect(actors[2]!.sessionId).not.toBe(actors[0]!.sessionId);
  });

  it("sets an access level, and never passes on a value that is not one", async () => {
    const { mint, calls, callsTo } = deployment();
    const api = mint();
    // The validator refuses it before the method's body runs: synchronously, on a direct call.
    for (let value of ["full", "FULL", "", "none", undefined, null, 1]) {
      expect(() => api.setAdminWorkspaceAccess(value as never), String(value)).toThrow(TypeError);
    }
    expect(calls).toEqual([]);

    await api.setAdminWorkspaceAccess("off");
    await api.setAdminWorkspaceAccess("metadata");
    expect(callsTo("admin", "setAdminWorkspaceAccess").map(call => call.args)).toEqual([
      ["off", expect.objectContaining({ admin: ADMIN, method: "setAdminWorkspaceAccess" })],
      ["metadata", expect.objectContaining({ admin: ADMIN, method: "setAdminWorkspaceAccess" })],
    ]);
  });
});

describe("AdminApiImpl directory listings", () => {
  it("lists users with whether each is an admin, forwarding only the query's fields", async () => {
    const cursor = "c".repeat(300_000);
    const { mint, callsTo } = deployment({ handlers: { directory: { listUsers: () => ({
      users: [{ id: ADMIN, name: "Admin" }, { id: "user", name: "User" }], nextCursor: "user",
    }) } } });
    const query = { query: "a", cursor, limit: 2, smuggled: true };
    const page = await mint().listUsers(query as Parameters<AdminApiImpl["listUsers"]>[0]);
    expect(page).toEqual({
      users: [
        { id: ADMIN, name: "Admin", isAdmin: true },
        { id: "user", name: "User", isAdmin: false },
      ],
      nextCursor: "user",
    });
    const [forwarded] = callsTo("directory", "listUsers")[0]!.args as [Record<string, unknown>];
    expect(forwarded).toStrictEqual({ query: "a", cursor, limit: 2 });
  });

  it("lists workspaces, forwarding only the query's fields", async () => {
    const owner = "o".repeat(300_000);
    const cursor = "c".repeat(300_000);
    const listed = { workspaces: [] };
    const { mint, callsTo } = deployment(
        { handlers: { directory: { listWorkspaces: () => listed } } });
    expect(await mint().listWorkspaces(
        { owner, cursor, smuggled: 1 } as Parameters<AdminApiImpl["listWorkspaces"]>[0]))
        .toBe(listed);
    const [query] = callsTo("directory", "listWorkspaces")[0]!.args as [Record<string, unknown>];
    expect(query).toStrictEqual({ owner, query: undefined, cursor, limit: 50 });
  });

  it("rejects a page size out of range before asking the directory", async () => {
    const { mint, calls } = deployment();
    const api = mint();
    for (let limit of [0, 201, 1.5]) {
      expect(await rejection(api.listUsers({ limit }))).toBeInstanceOf(TypeError);
      expect(await rejection(api.listWorkspaces({ limit }))).toBeInstanceOf(TypeError);
      expect(await rejection(api.listAdminAudit({ limit }))).toBeInstanceOf(TypeError);
    }
    expect(calls).toEqual([]);
  });
});

describe("AdminApiImpl audit log", () => {
  it("forwards a listing's filters, with the retention the environment holds up", async () => {
    const page = { records: [] };
    const { mint, callsTo } = deployment({
      config: { adminAuditRetentionDays: 100 },
      vars: { ADMIN_AUDIT_RETENTION_MIN_DAYS: "120" },
      handlers: { audit: { list: () => page } },
    });
    const since = new Date("2026-01-01T00:00:00Z");
    // `extra` is a key the query does not declare, so it does not reach the log.
    expect(await mint().listAdminAudit({
      kind: "workspace", admin: ADMIN, method: "getChatState", workspace: "w", owner: "ada",
      exposed: "content", since, cursor: "next", extra: true,
    } as Parameters<AdminApiImpl["listAdminAudit"]>[0])).toBe(page);
    expect(callsTo("audit", "list")[0]!.args).toStrictEqual([
      {
        kind: "workspace", admin: ADMIN, method: "getChatState", workspace: "w", owner: "ada",
        exposed: "content", since, cursor: "next", limit: 50,
      },
      120,
    ]);
  });

  it("forwards a statistics window, 7 days by default", async () => {
    const stats = { days: 7 };
    const { mint, callsTo } = deployment({
      config: { adminAuditRetentionDays: 200 },
      handlers: { audit: { stats: () => stats } },
    });
    const api = mint();
    expect(await api.getAdminAuditStats()).toBe(stats);
    await api.getAdminAuditStats({ days: 30, kind: "setting" });
    expect(callsTo("audit", "stats").map(call => call.args)).toStrictEqual([
      [{ days: 7, kind: undefined }, 200],
      [{ days: 30, kind: "setting" }, 200],
    ]);
    for (let days of [0, 367, 2.5]) {
      expect(await rejection(api.getAdminAuditStats({ days }))).toBeInstanceOf(TypeError);
    }
  });
});

describe("AdminApiImpl.writeWorkspace", () => {
  const ON = { ADMIN_WORKSPACE_WRITES: "on" };

  it.each([
    ["unset", {}],
    ["\"off\"", { ADMIN_WORKSPACE_WRITES: "off" }],
    ["\"true\"", { ADMIN_WORKSPACE_WRITES: "true" }],
  ])("refuses before touching anything while ADMIN_WORKSPACE_WRITES is %s",
      async (_label, vars) => {
    // A value that is neither "on" nor "off" is reported once, as an error.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { mint, calls } = deployment({ vars });
    const error = await rejection(
        mint().writeWorkspace(workspaceId(), "restartWorkspace", {}, REASON));
    expect(getAdminAccessErrorCode(error)).toBe(ADMIN_ACCESS_ERROR_CODES.writesOff);
    expect(calls).toEqual([]);
    vi.restoreAllMocks();
  });

  it("refuses a caller no longer an admin before touching anything", async () => {
    const { mint, calls } = deployment({ vars: ON });
    const error = await rejection(
        mint("former@example.test").writeWorkspace(workspaceId(), "restartWorkspace", {}, REASON));
    expect(getAdminAccessErrorCode(error)).toBe(ADMIN_ACCESS_ERROR_CODES.notAdmin);
    expect(calls).toEqual([]);
  });

  it("refuses a malformed id as not found, before any workspace is reached", async () => {
    const { mint, calls } = deployment({ vars: ON });
    const error = await rejection(
        mint().writeWorkspace("not-an-id", "restartWorkspace", {}, REASON));
    expect(getAdminAccessErrorCode(error)).toBe(ADMIN_ACCESS_ERROR_CODES.workspaceNotFound);
    expect(calls).toEqual([{ target: "overseers", method: "idFromString", args: ["not-an-id"] }]);
  });

  it("never runs with an action that is not one of ADMIN_WRITE_ACTIONS", () => {
    // The validator refuses it before the method's body runs: synchronously, on a direct call.
    const { mint, calls } = deployment({ vars: ON });
    const api = mint();
    // Deleting a chat and rejecting pending actions are not writes an admin can make.
    for (let action of ["bogus", "deleteChat", "rejectPendingActions"]) {
      expect(() => api.writeWorkspace(workspaceId(), action as any, { chatId: 3 }, REASON))
          .toThrow(TypeError);
    }
    expect(calls).toEqual([]);
  });

  it("hands the workspace the write with this capability's admin, session and `via`",
      async () => {
    const { mint, calls, callsTo } = deployment({ vars: ON });
    const id = workspaceId();
    // However the caller wrote the id, the workspace is the one it names.
    await mint(ADMIN, "cli").writeWorkspace(id.toUpperCase(), "stopAgent", { chatId: 3 }, REASON);

    expect(named(calls)).toEqual(
        ["overseers.idFromString", "overseers.get", "overseer.applyAdminWrite"]);
    expect(callsTo("overseers", "get")[0].args).toEqual([id]);
    expect(callsTo("overseer", "applyAdminWrite")[0].args).toStrictEqual([{
      action: "stopAgent", args: { chatId: 3 }, reason: REASON,
      admin: ADMIN, sessionId: expect.any(String), via: "cli",
    }]);

    // Another capability of the same admin is another session, with a `via` of its own.
    const [first] = callsTo("overseer", "applyAdminWrite")[0].args as [{ sessionId: string }];
    const { mint: mintAgain, callsTo: callsAgain } = deployment({ vars: ON });
    await mintAgain(ADMIN, "api").writeWorkspace(id, "restartWorkspace", {}, REASON);
    const [later] = callsAgain("overseer", "applyAdminWrite")[0].args as
        [{ sessionId: string; via: AdminVia }];
    expect(later.via).toBe("api");
    expect(later.sessionId).not.toBe(first.sessionId);
  });

  it.each<[string, () => unknown, boolean]>([
    ["drops a workspace found missing from the directory",
      () => createAdminAccessError(ADMIN_ACCESS_ERROR_CODES.workspaceNotFound), true],
    ["leaves the workspace listed after any other failure", () => new Error("No such chat."),
      false],
  ])("rethrows the workspace's refusal, and %s", async (_label, thrown, dropped) => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = thrown();
    const { mint, callsTo } = deployment({
      vars: ON, handlers: { overseer: { applyAdminWrite: () => { throw error; } } },
    });
    const id = workspaceId();
    expect(await rejection(mint().writeWorkspace(id, "restartWorkspace", {}, REASON)))
        .toBe(error);
    expect(callsTo("directory", "removeWorkspace").map(call => call.args))
        .toEqual(dropped ? [[id]] : []);
    expect(warned.mock.calls.map(([entry]) => (entry as { event?: string }).event))
        .toEqual(["admin.write.failed"]);
    vi.restoreAllMocks();
  });

  it("rethrows a missing workspace's refusal though the directory cannot be healed",
      async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { mint } = deployment({
      vars: ON,
      handlers: {
        overseer: { applyAdminWrite: () => {
          throw createAdminAccessError(ADMIN_ACCESS_ERROR_CODES.workspaceNotFound);
        } },
        directory: { removeWorkspace: () => { throw new Error("directory unavailable"); } },
      },
    });
    const error = await rejection(
        mint().writeWorkspace(workspaceId(), "restartWorkspace", {}, REASON));
    expect(getAdminAccessErrorCode(error)).toBe(ADMIN_ACCESS_ERROR_CODES.workspaceNotFound);
    expect(warned.mock.calls.map(([entry]) => (entry as { event?: string }).event))
        .toEqual(["admin.directory.heal.failed", "admin.write.failed"]);
    vi.restoreAllMocks();
  });
});

describe("AdminApiImpl content access requests", () => {
  const CONTENT = {
    config: { adminWorkspaceAccess: "content" as const },
    vars: { ADMIN_WORKSPACE_ACCESS_MAX: "content" },
  };
  const LISTING = { title: "Quarterly report", ownerId: "bob@example.test" };
  const REQUEST_ID = "4c1d2a0e-8a53-4c59-9a0e-3d7f1b6c2e11";
  const GRANT_ID = "0b6f6c0e-2f0b-4f0a-9d0b-6a3c0a2d9e11";

  // A request as the AdminSettings stub claims it, for a workspace id of this deployment.
  const claimed = (): AdminContentRequest => ({
    id: REQUEST_ID, workspaceId: workspaceId(), workspaceTitle: LISTING.title,
    workspaceOwner: LISTING.ownerId, reason: REASON, requestedBy: "other-admin@example.test",
    via: "api", requestedAt: new Date("2026-01-02T03:04:05.000Z"),
    expiresAt: new Date("2026-01-03T03:04:05.000Z"), state: "approved", resolvedBy: ADMIN,
    resolvedAt: new Date("2026-01-02T04:00:00.000Z"),
  });

  // A deployment at level content whose AdminSettings stub claims `request` and settles it as the
  // object would, and whose workspace gives a grant. `handlers` replace any of that.
  const approvalDeployment = (request: AdminContentRequest,
      handlers: Record<string, Record<string, Handler>> = {}) => deployment({
    ...CONTENT,
    handlers: {
      admin: {
        claimContentAccess: () => request,
        settleContentAccess: (_id: string, result: { grantId?: string; error?: string }) =>
          "error" in result ? { ...request, state: "failed", error: result.error }
            : { ...request, grantId: result.grantId },
        ...handlers.admin,
      },
      overseer: { grantAdminContent: () => ({ grantId: GRANT_ID }), ...handlers.overseer },
      directory: { workspaceListing: () => LISTING, ...handlers.directory },
    },
  });

  it.each([
    ["no cap", { ...CONTENT, vars: {} }],
    ["the cap at metadata", { ...CONTENT, vars: { ADMIN_WORKSPACE_ACCESS_MAX: "metadata" } }],
    ["the admins' choice of metadata", { vars: CONTENT.vars }],
  ])("refuses a request while the level in force is below content, by %s, storing nothing",
      async (_case, setup) => {
    const { mint, calls } = deployment({
      ...setup, handlers: { directory: { workspaceListing: () => LISTING } },
    });
    const error = await rejection(mint().requestContentAccess(workspaceId(), REASON));
    expect(getAdminAccessErrorCode(error)).toBe(ADMIN_ACCESS_ERROR_CODES.contentOff);
    // The id, then the committed config, and nothing else.
    expect(named(calls)).toEqual(["overseers.idFromString", "admin.committedAdminConfig"]);
  });

  it("refuses every method to a caller no longer an admin before touching anything", async () => {
    const { mint, calls } = deployment(CONTENT);
    const api = mint("former@example.test");
    for (let call of [
      () => api.requestContentAccess(workspaceId(), REASON),
      () => api.listContentAccessRequests(),
      () => api.getContentAccessRequest(REQUEST_ID),
      () => api.approveContentAccess(REQUEST_ID),
      () => api.denyContentAccess(REQUEST_ID),
      () => api.endWorkspaceGrant(workspaceId(), GRANT_ID, REASON),
    ]) {
      expect(getAdminAccessErrorCode(await rejection(call())))
          .toBe(ADMIN_ACCESS_ERROR_CODES.notAdmin);
    }
    expect(calls).toEqual([]);
  });

  it("refuses a bad reason or a malformed id before touching anything", async () => {
    const { mint, calls } = deployment(CONTENT);
    const api = mint();
    for (let reason of ["", "   ", "r".repeat(501)]) {
      expect(await rejection(api.requestContentAccess(workspaceId(), reason)))
          .toBeInstanceOf(TypeError);
    }
    expect(calls).toEqual([]);
    expect(getAdminAccessErrorCode(await rejection(api.requestContentAccess("not-an-id", REASON))))
        .toBe(ADMIN_ACCESS_ERROR_CODES.workspaceNotFound);
  });

  it.each<[string, Handler]>([
    ["lists no such workspace", () => null],
    ["lists it with no owner", () => ({ title: "Orphan", ownerId: "" })],
    ["cannot be asked", () => { throw new Error("directory unavailable"); }],
  ])("stores nothing for a workspace the directory %s", async (_label, workspaceListing) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { mint, callsTo } =
        deployment({ ...CONTENT, handlers: { directory: { workspaceListing } } });
    const error = await rejection(mint().requestContentAccess(workspaceId(), REASON));
    expect(getAdminGrantErrorCode(error)).toBe(ADMIN_GRANT_ERROR_CODES.workspaceUnlisted);
    expect(callsTo("admin", "requestContentAccess")).toEqual([]);
    expect(callsTo("overseers", "get")).toEqual([]);
    vi.restoreAllMocks();
  });

  it("stores the request with the directory's title and owner, never reaching the workspace",
      async () => {
    const longTitle = "t".repeat(MAX_ADMIN_AUDIT_ARG_LENGTH + 40);
    const longOwner = `${"o".repeat(MAX_ADMIN_AUDIT_ARG_LENGTH)}@example.test`;
    const { mint, calls, callsTo } = deployment({
      ...CONTENT,
      handlers: { directory: { workspaceListing: () => ({ title: longTitle, ownerId: longOwner }) } },
    });
    const id = workspaceId();
    const before = Date.now();
    const request =
        await mint(ADMIN, "api").requestContentAccess(id.toUpperCase(), `  ${REASON}  `);

    expect(named(calls)).toEqual([
      "overseers.idFromString", "admin.committedAdminConfig",
      "directorys.getByName", "directory.workspaceListing", "admin.requestContentAccess",
    ]);
    expect(callsTo("overseers", "get")).toEqual([]);
    const [stored, actor] = callsTo("admin", "requestContentAccess")[0].args as
        [AdminContentRequest, unknown];
    expect(stored).toStrictEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/), workspaceId: id,
      workspaceTitle: `${"t".repeat(MAX_ADMIN_AUDIT_ARG_LENGTH - 1)}…`,
      workspaceOwner: expect.stringMatching(/^o+…#[0-9a-f]{20}$/),
      reason: REASON, requestedBy: ADMIN, via: "api",
      requestedAt: expect.any(Date), expiresAt: expect.any(Date), state: "pending",
    });
    expect(actor).toStrictEqual({ admin: ADMIN, sessionId: expect.any(String), via: "api" });
    expect(stored.requestedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(stored.expiresAt.getTime() - stored.requestedAt.getTime())
        .toBe(ADMIN_CONTENT_REQUEST_LIFETIME_SECONDS * 1000);
    expect(ADMIN_CONTENT_REQUEST_LIFETIME_SECONDS).toBe(24 * 60 * 60);
    expect(request).toStrictEqual(stored);
  });

  it("is not a write: it asks nothing of ADMIN_WORKSPACE_WRITES", async () => {
    const { mint, callsTo } = deployment({
      ...CONTENT, vars: { ...CONTENT.vars, ADMIN_WORKSPACE_WRITES: "off" },
      handlers: { directory: { workspaceListing: () => LISTING } },
    });
    await mint().requestContentAccess(workspaceId(), REASON);
    expect(callsTo("admin", "requestContentAccess")).toHaveLength(1);
  });

  it("claims, has the workspace give the grant and settles it, in that order", async () => {
    const request = claimed();
    const { mint, calls, callsTo, waitUntil } = approvalDeployment(request);
    const settled = await mint(ADMIN, "cli").approveContentAccess(REQUEST_ID);

    expect(named(calls)).toEqual([
      "admin.claimContentAccess", "overseers.idFromString", "overseers.get",
      "overseer.grantAdminContent", "admins.getByName", "admin.settleContentAccess",
    ]);
    const actor = { admin: ADMIN, sessionId: expect.any(String), via: "cli" };
    expect(callsTo("admin", "claimContentAccess")[0].args).toStrictEqual([REQUEST_ID, actor]);
    expect(callsTo("overseers", "get")[0].args).toEqual([request.workspaceId]);
    expect(callsTo("overseer", "grantAdminContent")[0].args).toStrictEqual([{
      requestId: REQUEST_ID, requestedBy: "other-admin@example.test", reason: REASON,
      workspaceOwner: LISTING.ownerId, ...actor,
    }]);
    expect(callsTo("admin", "settleContentAccess")[0].args)
        .toStrictEqual([REQUEST_ID, { grantId: GRANT_ID }]);
    // The grant is asked for and settled whatever becomes of the client.
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(settled).toStrictEqual({ ...request, grantId: GRANT_ID });
  });

  it("settles a confirmed grant again on a fresh stub when the first settle is reset, asking the workspace once",
      async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const request = claimed();
    let settles = 0;
    const { mint, callsTo } = approvalDeployment(request, { admin: {
      settleContentAccess: (_id: string, result: { grantId?: string }) => {
        if (++settles === 1) throw Object.assign(new Error("reset"), { durableObjectReset: true });
        return { ...request, grantId: result.grantId };
      },
    } });
    expect(await mint().approveContentAccess(REQUEST_ID)).toStrictEqual({ ...request, grantId: GRANT_ID });
    expect(callsTo("overseer", "grantAdminContent")).toHaveLength(1);
    expect(callsTo("admin", "settleContentAccess").map(call => call.args))
        .toStrictEqual([[REQUEST_ID, { grantId: GRANT_ID }], [REQUEST_ID, { grantId: GRANT_ID }]]);
    expect(callsTo("admins", "getByName")).toHaveLength(2);
    vi.restoreAllMocks();
  });

  it.each<[string, () => unknown, string, boolean]>([
    ["drops a workspace found missing from the directory",
      () => createAdminAccessError(ADMIN_ACCESS_ERROR_CODES.workspaceNotFound),
      "Workspace not found.", true],
    ["leaves a workspace that changed owner listed",
      () => createAdminGrantError(ADMIN_GRANT_ERROR_CODES.workspaceChanged),
      "This workspace no longer belongs to the owner the request named, so no grant was given. " +
          "Request it again.", false],
    ["takes a thrown value that is no Error as its text", () => "unreachable", "unreachable",
      false],
    // The workspace may have committed the grant before its answer was lost.
    ["says the outcome is unknown when the call was reset",
      () => Object.assign(new Error("Durable Object reset"), { durableObjectReset: true }),
      "The workspace's answer never arrived, so whether it gave the grant is unknown.", false],
    ["says the outcome is unknown when the connection was lost",
      () => Object.assign(new Error("Network connection lost."), { retryable: true }),
      "The workspace's answer never arrived, so whether it gave the grant is unknown.", false],
  ])("settles a request the workspace gave no grant for with its message, and %s",
      async (_label, thrown, message, dropped) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const request = claimed();
    const { mint, callsTo } = approvalDeployment(request, {
      overseer: { grantAdminContent: () => { throw thrown(); } },
    });
    expect(await mint().approveContentAccess(REQUEST_ID))
        .toMatchObject({ state: "failed", error: message });
    expect(callsTo("admin", "settleContentAccess").map(call => call.args))
        .toStrictEqual([[REQUEST_ID, { error: message }]]);
    expect(callsTo("directory", "removeWorkspace").map(call => call.args))
        .toEqual(dropped ? [[request.workspaceId]] : []);
    vi.restoreAllMocks();
  });

  it.each([
    ADMIN_GRANT_ERROR_CODES.secondAdminRequired, ADMIN_GRANT_ERROR_CODES.requestNotPending,
    ADMIN_GRANT_ERROR_CODES.requestNotFound,
  ])("never reaches the workspace when the claim is refused %s", async code => {
    const { mint, calls, waitUntil } = approvalDeployment(claimed(), {
      admin: { claimContentAccess: () => { throw createAdminGrantError(code); } },
    });
    const error = await rejection(mint().approveContentAccess(REQUEST_ID));
    expect(getAdminGrantErrorCode(error)).toBe(code);
    expect(named(calls)).toEqual(["admin.claimContentAccess"]);
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it("lists, reads and denies through AdminSettings, with the capability's own actor", async () => {
    const listed = [claimed()];
    const { mint, callsTo } = deployment({
      handlers: { admin: {
        listContentAccessRequests: () => listed, getContentAccessRequest: () => listed[0],
      } },
    });
    const api = mint(ADMIN, "cli");
    expect(await api.listContentAccessRequests()).toBe(listed);
    expect(await api.getContentAccessRequest(REQUEST_ID)).toBe(listed[0]);
    await api.denyContentAccess(REQUEST_ID);
    expect(callsTo("admin", "getContentAccessRequest")[0].args).toEqual([REQUEST_ID]);
    expect(callsTo("admin", "denyContentAccess")[0].args).toStrictEqual(
        [REQUEST_ID, { admin: ADMIN, sessionId: expect.any(String), via: "cli" }]);
  });
});

describe("AdminApiImpl.endWorkspaceGrant", () => {
  const GRANT_ID = "0b6f6c0e-2f0b-4f0a-9d0b-6a3c0a2d9e11";

  // Whatever the level, and with writes off: these deployments set neither.
  it("has the workspace end it, through the capability's own session and `via`", async () => {
    const { mint, calls, callsTo } = deployment();
    const api = mint(ADMIN, "cli");
    const id = workspaceId();

    expect(await api.endWorkspaceGrant(id, GRANT_ID, `  ${REASON}  `)).toBeUndefined();

    // Nothing is appended here: the workspace records the step.
    expect(named(calls)).toEqual(
        ["overseers.idFromString", "overseers.get", "overseer.endAdminGrant"]);
    expect(callsTo("overseers", "get")[0].args).toEqual([id]);
    expect(callsTo("overseer", "endAdminGrant")[0].args).toStrictEqual(
        [{ admin: ADMIN, sessionId: expect.any(String), via: "cli" }, GRANT_ID, REASON]);
  });

  it("refuses a caller no longer an admin, a bad reason and a malformed id before reaching " +
      "any workspace", async () => {
    const { mint, callsTo } = deployment();
    expect(getAdminAccessErrorCode(await rejection(
        mint("former@example.test").endWorkspaceGrant(workspaceId(), GRANT_ID, REASON))))
        .toBe(ADMIN_ACCESS_ERROR_CODES.notAdmin);
    const api = mint();
    for (let reason of ["", "   ", "r".repeat(501)]) {
      expect(await rejection(api.endWorkspaceGrant(workspaceId(), GRANT_ID, reason)))
          .toBeInstanceOf(TypeError);
    }
    expect(getAdminAccessErrorCode(
        await rejection(api.endWorkspaceGrant("not-an-id", GRANT_ID, REASON))))
        .toBe(ADMIN_ACCESS_ERROR_CODES.workspaceNotFound);
    expect(callsTo("overseers", "get")).toEqual([]);
  });

  it.each<[string, () => unknown, boolean]>([
    ["drops a workspace found missing from the directory",
      () => createAdminAccessError(ADMIN_ACCESS_ERROR_CODES.workspaceNotFound), true],
    ["leaves the workspace listed when it holds no such grant",
      () => createAdminGrantError(ADMIN_GRANT_ERROR_CODES.notFound), false],
  ])("passes the workspace's refusal through, and %s", async (_label, thrown, dropped) => {
    const refusal = thrown();
    const { mint, callsTo } = deployment({
      handlers: { overseer: { endAdminGrant: () => { throw refusal; } } },
    });
    const id = workspaceId();
    expect(await rejection(mint().endWorkspaceGrant(id, GRANT_ID, REASON))).toBe(refusal);
    expect(callsTo("directory", "removeWorkspace").map(call => call.args))
        .toEqual(dropped ? [[id]] : []);
    // The grant's own family of codes, which the caller reads as it reads any refusal.
    if (!dropped) {
      expect(getAdminGrantErrorCode(refusal)).toBe(ADMIN_GRANT_ERROR_CODES.notFound);
    }
  });
});

describe("AdminApiImpl issue reports", () => {
  const PROFILE = { type: "user", id: ADMIN, name: "Ada Admin", commitEmail: "ada@example.test" };
  const IMAGE = new ReadableStream<Uint8Array>();

  // What the issue report store answers each method with.
  const answers = {
    list: { reports: [{ id: "report" }], nextCursor: "next" },
    get: { id: "report", entries: [] },
    addEntry: { id: "entry" },
    setStatus: undefined,
    claim: undefined,
    release: undefined,
    setLinks: undefined,
    readImage: IMAGE,
  };
  const reportDeployment = (whoamiIfExists: () => unknown = () => PROFILE) => deployment({
    handlers: {
      user: { whoamiIfExists },
      report: Object.fromEntries(
          Object.entries(answers).map(([method, answer]) => [method, () => answer])),
    },
  });

  // Each AdminApi method, the store method it reaches, and what it hands it.
  const methods: [string, (api: AdminApiImpl) => Promise<unknown>, keyof typeof answers,
      unknown[]][] = [
    ["listIssueReports", api => api.listIssueReports({ status: "new", limit: 3 }), "list",
      [{ status: "new", priority: undefined, reporter: undefined, workspace: undefined,
         assignee: undefined, unassigned: undefined, cursor: undefined, limit: 3 }]],
    ["getIssueReport", api => api.getIssueReport("report"), "get", ["report"]],
    ["addIssueReportEntry", api => api.addIssueReportEntry("report", "Which chart?", "public"),
      "addEntry", [PROFILE, "cli", "report", "Which chart?", "public"]],
    ["setIssueReportStatus", api => api.setIssueReportStatus("report", "closed"), "setStatus",
      [PROFILE, "cli", "report", "closed"]],
    ["claimIssueReport", api => api.claimIssueReport("report"), "claim",
      [PROFILE, "cli", "report", undefined]],
    ["releaseIssueReport", api => api.releaseIssueReport("report"), "release",
      [PROFILE, "cli", "report"]],
    ["setIssueReportLinks", api => api.setIssueReportLinks("report", ["https://example.com/1"]),
      "setLinks", ["report", ["https://example.com/1"]]],
    ["readIssueReportImage", api => api.readIssueReportImage("report", "image"), "readImage",
      ["report", "image"]],
  ];

  it("forwards each method to the store, and appends nothing to the audit log", async () => {
    const { mint, calls, callsTo } = reportDeployment();
    const api = mint();
    for (let [name, invoke, method, args] of methods) {
      calls.length = 0;
      expect(await invoke(api), name).toBe(answers[method]);
      expect(callsTo("report", method), name).toStrictEqual([{ target: "report", method, args }]);
      // The deployment-wide store, and nothing but the caller's own profile beside it.
      expect(callsTo("reports", "getByName"), name)
          .toStrictEqual([{ target: "reports", method: "getByName", args: [""] }]);
      expect(calls.filter(call => !["report", "reports", "user", "users"].includes(call.target)),
          name).toStrictEqual([]);
    }
  });

  it("writes in a thread as the caller's own account names them, with how they reached it",
      async () => {
    const { mint, callsTo } = reportDeployment(() => null);
    const api = mint(ADMIN, "api");
    await api.addIssueReportEntry("report", "A note", "admins");
    await api.setIssueReportStatus("report", "investigating");
    await api.claimIssueReport("report", { takeOverFrom: "grace@example.test" });
    await api.claimIssueReport("report", {});
    await api.claimIssueReport("report");
    await api.releaseIssueReport("report");
    // An admin whose account has no profile is named by their id.
    const byId = { type: "user", id: ADMIN, name: ADMIN };
    expect(callsTo("users", "getByName").map(call => call.args))
        .toStrictEqual(Array.from({ length: 6 }, () => [ADMIN]));
    expect(callsTo("report", "addEntry")[0].args)
        .toStrictEqual([byId, "api", "report", "A note", "admins"]);
    expect(callsTo("report", "setStatus")[0].args)
        .toStrictEqual([byId, "api", "report", "investigating"]);
    // The holder a take-over names is the caller's own word, passed as it was given.
    expect(callsTo("report", "claim").map(call => call.args)).toStrictEqual([
      [byId, "api", "report", "grace@example.test"],
      [byId, "api", "report", undefined], [byId, "api", "report", undefined],
    ]);
    expect(callsTo("report", "release")[0].args).toStrictEqual([byId, "api", "report"]);
  });

  it("lists with the default page size, the query passed field by field",
      async () => {
    const { mint, callsTo } = reportDeployment();
    const api = mint();
    await api.listIssueReports();
    await api.listIssueReports({
      status: "closed", priority: "low", reporter: "ada", workspace: "w1", assignee: "grace",
      unassigned: true, cursor: "c",
    });
    expect(callsTo("report", "list").map(call => call.args[0])).toStrictEqual([
      { status: undefined, priority: undefined, reporter: undefined, workspace: undefined,
        assignee: undefined, unassigned: undefined, cursor: undefined, limit: 50 },
      { status: "closed", priority: "low", reporter: "ada", workspace: "w1", assignee: "grace",
        unassigned: true, cursor: "c", limit: 50 },
    ]);
    for (let limit of [0, 1.5, 201]) {
      expect(await rejection(api.listIssueReports({ limit }))).toBeInstanceOf(TypeError);
    }
    expect(callsTo("report", "list")).toHaveLength(2);
  });

  it("refuses each method to a caller who is no longer a deployment admin", async () => {
    const { mint, calls } = reportDeployment();
    const api = mint("former-admin@example.test");
    for (let [name, invoke] of methods) {
      expect(getAdminAccessErrorCode(await rejection(invoke(api))), name)
          .toBe(ADMIN_ACCESS_ERROR_CODES.notAdmin);
    }
    expect(calls).toStrictEqual([]);
  });

  it("names the calling admin as a thread names them", async () => {
    // The store is the real one, so the ids compared are the ones an admin reads.
    const reports = env.TEST_ISSUE_REPORTS.getByName(crypto.randomUUID());
    const onStore = <T>(call: (store: IssueReportsDurableObject) => T | Promise<T>) =>
        runInDurableObject(reports, call);
    const report = await onStore(store => store.submit(
        { id: "ada", name: "Ada" }, { text: "The export fails.", priority: "low" }, false));
    type Store = IssueReportsDurableObject;
    // An account whose id is longer than a record keeps: what whoami() returns is the id as the
    // store cut it, never the account's own.
    const long = `${"a".repeat(MAX_ADMIN_AUDIT_ARG_LENGTH)}@example.test`;
    const of = (adminUserId: string, name: string) => deployment({
      vars: { ADMINS: [ADMIN, long] },
      handlers: {
        user: { whoamiIfExists: () => ({ ...PROFILE, id: adminUserId, name }) },
        report: {
          addEntry: (...args: Parameters<Store["addEntry"]>) =>
              onStore(store => store.addEntry(...args)),
          claim: (...args: Parameters<Store["claim"]>) => onStore(store => store.claim(...args)),
          get: (id: string) => onStore(store => store.get(id)),
        },
      },
    });

    // Who holds the report, by the id a take-over names: the id whoami() gave its holder.
    let holder: string | undefined;
    for (let [adminUserId, name] of [[ADMIN, "Ada Admin"], [long, "Lo Ng"]]) {
      const { mint, calls } = of(adminUserId, name);
      const api = mint(adminUserId);
      const me = await api.whoami();
      // A NamedUser and nothing else of the profile, read from the caller's own account alone.
      expect(Object.keys(me).toSorted()).toStrictEqual(["id", "name"]);
      expect(me.name).toBe(name);
      expect(named(calls)).toStrictEqual(["users.getByName", "user.whoamiIfExists"]);

      const entry = await api.addIssueReportEntry(report.id, "Mine.", "admins");
      await api.claimIssueReport(report.id, { takeOverFrom: holder });
      const read = await api.getIssueReport(report.id);
      expect(entry.author).toStrictEqual(me);
      expect(read.assignee).toMatchObject(me);
      expect(read.entries.at(-1)).toMatchObject({ author: me, assignment: expect.any(String) });
      holder = me.id;
    }
    expect((await of(long, "Lo Ng").mint(long).whoami()).id).not.toBe(long);
    expect((await of(ADMIN, "Ada Admin").mint().whoami()).id).toBe(ADMIN);

    // An admin whose account has no profile is named by their id, as their entries are.
    const bare = deployment({ handlers: { user: { whoamiIfExists: () => null } } });
    expect(await bare.mint().whoami()).toStrictEqual({ id: ADMIN, name: ADMIN });

    const former = reportDeployment();
    expect(getAdminAccessErrorCode(
        await rejection(former.mint("former-admin@example.test").whoami())))
        .toBe(ADMIN_ACCESS_ERROR_CODES.notAdmin);
    expect(former.calls).toStrictEqual([]);
  });
});
