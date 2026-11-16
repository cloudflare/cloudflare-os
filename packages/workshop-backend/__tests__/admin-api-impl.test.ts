import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import {
  ADMIN_ACCESS_ERROR_CODES, ADMIN_GRANT_ERROR_CODES, ADMIN_WRITE_ERROR_CODES,
  ADMIN_WRITE_REQUEST_LIFETIME_SECONDS, DEFAULT_ADMIN_VIEW_LIFETIME_SECONDS,
  ISSUE_REPORT_ERROR_CODES, MAX_ADMIN_AUDIT_ARG_LENGTH, createAdminAccessError,
  createAdminGrantError, createAdminWriteError, createIssueReportError, getAdminAccessErrorCode,
  getAdminGrantErrorCode, getAdminWriteErrorCode, getIssueReportErrorCode,
  type AdminAccessRecord, type AdminAgentOrigin, type AdminPasskeyAssertion,
  type AdminPasskeyRegistration, type AdminUserAccessRecord, type AdminWriteArgs,
} from "@gadgets/workshop-shared/api";
import type {
  AdminCaller, AdminViewTerms, AdminWorkspaceViewTerms,
} from "../src/admin-access.js";
import { AdminApiImpl } from "../src/admin-settings.js";
import type { AdminWriteApprover, StoredAdminWrite } from "../src/admin-writes.js";
import type { IssueReportsDurableObject } from "../src/issue-reports.js";
import type { OverseerDurableObject } from "../src/overseer.js";
import {
  DEFAULT_ADMIN_CONFIG, type AdminConfig,
} from "../src/storage-schema/admin-settings-storage.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
    TEST_ISSUE_REPORTS: DurableObjectNamespace<IssueReportsDurableObject>;
  }
}

const ADMIN = "admin@example.test";
const REASON = "Investigating a support ticket";
// An answer of the right shape: the fake AdminSettings object decides what it is worth.
const ASSERTION: AdminPasskeyAssertion =
    { credentialId: "AA", clientDataJSON: "AA", authenticatorData: "AA", signature: "AA" };

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
  const mint = (adminUserId = ADMIN, caller: AdminCaller = { via: "cli" }) => {
    const api = new AdminApiImpl(ctx, deploymentEnv, adminUserId, caller);
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
    const minted = await mint(ADMIN, { via: "api" }).inspectWorkspace(id, ` ${REASON} `, options);
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

  it("opens a view for one issue report, naming the report in the view's terms", async () => {
    const { mint, callsTo } = deployment({
      ...CONTENT, handlers: { overseer: { openForAdmin: () => ({}) } },
    });
    const api = mint(ADMIN, { via: "api" });
    await api.inspectWorkspace(
        workspaceId(), REASON, { access: "content", forIssueReport: "report-1" });
    await api.inspectWorkspace(workspaceId(), REASON, { forIssueReport: "report-2" });
    const terms = callsTo("overseer", "openForAdmin")
        .map(call => call.args[3] as AdminWorkspaceViewTerms);
    expect(terms).toStrictEqual([
      { via: "api", access: "content", expiresAt: terms[0]!.expiresAt,
        forIssueReport: "report-1" },
      { via: "api", access: "metadata", expiresAt: terms[1]!.expiresAt,
        forIssueReport: "report-2" },
    ]);
  });

  it("takes no issue report that is not a non-empty string of at most 128 characters, and " +
      "reaches nothing", async () => {
    const { mint, calls, callsTo } = deployment({
      ...CONTENT, handlers: { overseer: { openForAdmin: () => ({}) } },
    });
    const api = mint();
    // The method's validator throws before the method runs.
    for (const forIssueReport of [true, 1, null, {}]) {
      expect(() => api.inspectWorkspace(workspaceId(), REASON, { forIssueReport } as never))
          .toThrow(TypeError);
    }
    // The workspace checks no terms, so an id no report has is refused before it is reached.
    for (const forIssueReport of ["", "r".repeat(129)]) {
      expect(await rejection(api.inspectWorkspace(workspaceId(), REASON, { forIssueReport })))
          .toBeInstanceOf(TypeError);
    }
    expect(calls).toEqual([]);

    const longest = "r".repeat(128);
    await api.inspectWorkspace(workspaceId(), REASON, { forIssueReport: longest });
    expect(callsTo("overseer", "openForAdmin")[0]!.args[3])
        .toMatchObject({ forIssueReport: longest });
  });

  it("passes on the refusal of a report that is not the workspace's owner's, leaving the " +
      "workspace in the directory and recording nothing", async () => {
    const { mint, calls, callsTo } = deployment({ ...CONTENT, handlers: { overseer: {
      openForAdmin: () => { throw createIssueReportError(ISSUE_REPORT_ERROR_CODES.notFound); },
    } } });
    const error = await rejection(mint().inspectWorkspace(
        workspaceId(), REASON, { access: "content", forIssueReport: "report-1" }));
    expect(getIssueReportErrorCode(error)).toBe(ISSUE_REPORT_ERROR_CODES.notFound);
    expect(calls.filter(call => call.target.startsWith("director"))).toEqual([]);
    expect(callsTo("audit", "append")).toEqual([]);
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
    const minted = await mint(ADMIN, { via: "api" }).inspectUser(USER, ` ${REASON} `, options);
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
    const first = mint(ADMIN, { via: "cli" });
    const second = mint(ADMIN, { via: "api" });
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

describe("AdminApiImpl passkeys", () => {
  const REGISTRATION: AdminPasskeyRegistration = {
    credentialId: "AA", clientDataJSON: "AA", authenticatorData: "AA", publicKey: "AA",
    publicKeyAlgorithm: -7,
  };
  const ON = { ADMIN_WORKSPACE_WRITES: "on" };

  // What the AdminSettings stub answers each method with.
  const answers = {
    listAdminPasskeys: [{ id: "AA" }],
    beginAdminPasskeyEnrolment: { challenge: "enrol" },
    addAdminPasskey: { id: "AA", name: "Laptop" },
    beginAdminPasskeyRemoval: { challenge: "remove" },
    removeAdminPasskey: undefined,
  };
  type Method = keyof typeof answers;
  const NEEDS_WRITES: Method[] = ["beginAdminPasskeyEnrolment", "addAdminPasskey"];
  const NEEDS_ADMIN: Method[] =
      ["listAdminPasskeys", "beginAdminPasskeyRemoval", "removeAdminPasskey"];

  const passkeyDeployment = (vars: object) => deployment({
    vars,
    handlers: { admin: Object.fromEntries(
        Object.entries(answers).map(([method, answer]) => [method, () => answer])) },
  });

  const call = (api: AdminApiImpl, method: Method): Promise<unknown> => ({
    listAdminPasskeys: () => api.listAdminPasskeys(),
    beginAdminPasskeyEnrolment: () => api.beginAdminPasskeyEnrolment(),
    addAdminPasskey: () => api.addAdminPasskey("Laptop", REGISTRATION),
    beginAdminPasskeyRemoval: () => api.beginAdminPasskeyRemoval("credential"),
    removeAdminPasskey: () => api.removeAdminPasskey("credential", ASSERTION),
  })[method]();

  const actor = (method: string) =>
      ({ admin: ADMIN, sessionId: expect.any(String), via: "cli", method });
  // What each method forwards to the AdminSettings object: the caller's id, or the actor.
  const forwarded: Record<Method, unknown[]> = {
    listAdminPasskeys: [],
    beginAdminPasskeyEnrolment: [ADMIN],
    addAdminPasskey: ["Laptop", REGISTRATION, actor("addAdminPasskey")],
    beginAdminPasskeyRemoval: ["credential", ADMIN],
    removeAdminPasskey: ["credential", ASSERTION, actor("removeAdminPasskey")],
  };

  it("forwards each method with the caller's id or its actor while writes are on", async () => {
    const { mint, calls } = passkeyDeployment(ON);
    const api = mint();
    for (let method of [...NEEDS_ADMIN, ...NEEDS_WRITES]) {
      calls.length = 0;
      expect(await call(api, method)).toBe(answers[method]);
      expect(calls).toStrictEqual([{ target: "admin", method, args: forwarded[method] }]);
    }
  });

  it.each([
    ["unset", {}],
    ["\"off\"", { ADMIN_WORKSPACE_WRITES: "off" }],
    ["\"true\"", { ADMIN_WORKSPACE_WRITES: "true" }],
  ])("refuses enrolment, and still lists and removes, while ADMIN_WORKSPACE_WRITES is %s",
      async (_label, vars) => {
    // A value that is neither "on" nor "off" is reported once, as an error.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { mint, calls } = passkeyDeployment(vars);
    const api = mint();
    for (let method of NEEDS_WRITES) {
      expect(getAdminWriteErrorCode(await rejection(call(api, method))))
          .toBe(ADMIN_WRITE_ERROR_CODES.writesOff);
    }
    expect(calls).toEqual([]);

    for (let method of NEEDS_ADMIN) {
      calls.length = 0;
      expect(await call(api, method)).toBe(answers[method]);
      expect(calls).toStrictEqual([{ target: "admin", method, args: forwarded[method] }]);
    }
    vi.restoreAllMocks();
  });

  it.each([["on", ON], ["unset", {}]])(
      "refuses a caller no longer an admin before touching anything, with writes %s",
      async (_label, vars) => {
    const { mint, calls } = passkeyDeployment(vars);
    const api = mint("former@example.test");
    for (let method of [...NEEDS_ADMIN, ...NEEDS_WRITES]) {
      expect(getAdminAccessErrorCode(await rejection(call(api, method))))
          .toBe(ADMIN_ACCESS_ERROR_CODES.notAdmin);
    }
    expect(calls).toEqual([]);
  });
});

describe("AdminApiImpl write requests", () => {
  const ON = { ADMIN_WORKSPACE_WRITES: "on", PUBLIC_BASE_URL: "https://workshop.example/" };
  const REQUEST_ID = "4c1d2a0e-8a53-4c59-9a0e-3d7f1b6c2e11";
  const LISTING = { title: "Quarterly report", ownerId: "bob@example.test" };

  // A request as the AdminSettings stub answers getWorkspaceWrite() with.
  const STORED: StoredAdminWrite = {
    id: REQUEST_ID, workspaceId: "a".repeat(64), workspaceTitle: "Quarterly report",
    workspaceOwner: "bob@example.test", action: "stopAgent", args: { chatId: 3 }, reason: REASON,
    requestedBy: "other-admin@example.test", via: "api", sessionId: "the requester's session",
    requestedAt: new Date("2026-01-02T03:04:05.000Z"),
    expiresAt: new Date("2026-01-02T03:14:05.000Z"), state: "denied",
    resolvedBy: ADMIN, resolvedAt: new Date("2026-01-02T03:05:00.000Z"),
  };

  const writesDeployment = (vars: object = ON,
      workspaceListing: Handler = () => LISTING) => deployment({
    vars,
    handlers: {
      admin: { getWorkspaceWrite: () => STORED },
      directory: { workspaceListing },
    },
  });

  // A deployment whose AdminSettings stub approves `request` and settles it as the object would,
  // the answer marked as still to be recorded and a refusal's record still owed, and whose
  // workspace reports an outcome. `handlers` replace any of that.
  const approvalDeployment = (request: StoredAdminWrite,
      handlers: Record<string, Record<string, Handler>> = {}) => deployment({
    vars: ON,
    handlers: {
      admin: {
        approveWorkspaceWrite: () => request,
        settleWorkspaceWrite: (_id: string, result: { outcome?: string; error?: string }) => ({
          ...request, state: "error" in result ? "failed" : "applied", ...result,
          unrecorded: true,
          refusals: [{ admin: ADMIN, sessionId: "another session", via: "api", refusal: "challenge" }],
        }),
        ...handlers.admin,
      },
      overseer: { applyAdminWrite: () => ({ outcome: "3 rejected" }), ...handlers.overseer },
      directory: { ...handlers.directory },
    },
  });

  const methods: Record<string, (api: AdminApiImpl) => Promise<unknown>> = {
    requestWorkspaceWrite: api =>
        api.requestWorkspaceWrite(workspaceId(), "stopAgent", { chatId: 3 }, REASON),
    requestContentAccess: api =>
        api.requestWorkspaceWrite(workspaceId(), "grantContentAccess", {}, REASON),
    getWorkspaceWrite: api => api.getWorkspaceWrite(REQUEST_ID),
    denyWorkspaceWrite: api => api.denyWorkspaceWrite(REQUEST_ID),
    beginWorkspaceWriteApproval: api => api.beginWorkspaceWriteApproval(REQUEST_ID),
    approveWorkspaceWrite: api => api.approveWorkspaceWrite(REQUEST_ID, ASSERTION),
  };

  it.each([
    ["unset", {}],
    ["\"off\"", { ADMIN_WORKSPACE_WRITES: "off" }],
    ["\"true\"", { ADMIN_WORKSPACE_WRITES: "true" }],
  ])("refuses every method before touching anything while ADMIN_WORKSPACE_WRITES is %s",
      async (_label, vars) => {
    // A value that is neither "on" nor "off" is reported once, as an error.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { mint, calls } = writesDeployment({ ...ON, ADMIN_WORKSPACE_WRITES: undefined, ...vars });
    const api = mint();
    for (let call of Object.values(methods)) {
      expect(getAdminWriteErrorCode(await rejection(call(api))))
          .toBe(ADMIN_WRITE_ERROR_CODES.writesOff);
    }
    expect(calls).toEqual([]);
    vi.restoreAllMocks();
  });

  it("refuses a caller no longer an admin before touching anything", async () => {
    const { mint, calls } = writesDeployment();
    const api = mint("former@example.test");
    for (let call of Object.values(methods)) {
      expect(getAdminAccessErrorCode(await rejection(call(api))))
          .toBe(ADMIN_ACCESS_ERROR_CODES.notAdmin);
    }
    expect(calls).toEqual([]);
  });

  it("refuses a bad reason or bad arguments before touching anything", async () => {
    const { mint, calls } = writesDeployment();
    const api = mint();
    const id = workspaceId();
    for (let reason of ["", "   ", "r".repeat(501)]) {
      expect(await rejection(api.requestWorkspaceWrite(id, "stopAgent", { chatId: 3 }, reason)))
          .toBeInstanceOf(TypeError);
    }
    const refused: [Parameters<AdminApiImpl["requestWorkspaceWrite"]>[1], AdminWriteArgs][] = [
      ["restartWorkspace", { chatId: 1 }],
      ["stopAgent", {}],
      ["stopAgent", { chatId: -1 }],
      ["stopAgent", { chatId: 3, gatekeeperId: 1 }],
      ["grantContentAccess", { chatId: 1 }],
    ];
    for (let [action, args] of refused) {
      const error = await rejection(api.requestWorkspaceWrite(id, action, args, REASON));
      expect(error).toBeInstanceOf(TypeError);
      expect(getAdminWriteErrorCode(error)).toBeUndefined();
    }
    expect(calls).toEqual([]);
  });

  it("never runs with an action that is not one of ADMIN_WRITE_ACTIONS", () => {
    // The validator refuses it before the method's body runs: synchronously, on a direct call.
    const { mint, calls } = writesDeployment();
    const api = mint();
    // Deleting a chat and rejecting pending actions are not writes an admin can request.
    for (let action of ["bogus", "deleteChat", "rejectPendingActions"]) {
      expect(() => api.requestWorkspaceWrite(workspaceId(), action as any, { chatId: 3 }, REASON))
          .toThrow(TypeError);
    }
    expect(calls).toEqual([]);
  });

  it("refuses a malformed id as not found, before the directory is asked", async () => {
    const { mint, calls } = writesDeployment();
    const error = await rejection(
        mint().requestWorkspaceWrite("not-an-id", "restartWorkspace", {}, REASON));
    expect(getAdminAccessErrorCode(error)).toBe(ADMIN_ACCESS_ERROR_CODES.workspaceNotFound);
    expect(calls).toEqual([{ target: "overseers", method: "idFromString", args: ["not-an-id"] }]);
  });

  it("refuses a request no page could approve: PUBLIC_BASE_URL is unset", async () => {
    const { mint, calls, callsTo } = writesDeployment({ ADMIN_WORKSPACE_WRITES: "on" });
    const api = mint();
    const error = await rejection(
        api.requestWorkspaceWrite(workspaceId(), "restartWorkspace", {}, REASON));
    expect(getAdminWriteErrorCode(error)).toBe(ADMIN_WRITE_ERROR_CODES.originUnset);
    expect(calls).toEqual([callsTo("overseers", "idFromString")[0]]);

    expect(getAdminWriteErrorCode(await rejection(api.getWorkspaceWrite(REQUEST_ID))))
        .toBe(ADMIN_WRITE_ERROR_CODES.originUnset);
  });

  it.each<[string, Handler]>([
    ["lists no such workspace", () => null],
    ["lists it with no owner", () => ({ title: "Orphan", ownerId: "" })],
    ["cannot be asked", () => { throw new Error("directory unavailable"); }],
  ])("stores nothing for a workspace the directory %s", async (_label, workspaceListing) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { mint, calls, callsTo } = writesDeployment(ON, workspaceListing);
    const id = workspaceId();
    const error = await rejection(
        mint().requestWorkspaceWrite(id, "restartWorkspace", {}, REASON));
    expect(getAdminWriteErrorCode(error)).toBe(ADMIN_WRITE_ERROR_CODES.workspaceUnlisted);
    expect(callsTo("directory", "workspaceListing")).toEqual(
        [{ target: "directory", method: "workspaceListing", args: [id] }]);
    expect(calls.filter(call => call.target === "admin" || call.target === "audit")).toEqual([]);
    expect(callsTo("overseers", "get")).toEqual([]);
    vi.restoreAllMocks();
  });

  it("stores the request with the directory's title and owner, never reaching the workspace",
      async () => {
    const longTitle = "t".repeat(MAX_ADMIN_AUDIT_ARG_LENGTH + 40);
    const longOwner = `${"o".repeat(MAX_ADMIN_AUDIT_ARG_LENGTH)}@example.test`;
    const { mint, calls, callsTo } =
        writesDeployment(ON, () => ({ title: longTitle, ownerId: longOwner }));
    const id = workspaceId();
    const before = Date.now();
    // An argument given as undefined is one not given, and is not stored.
    const view = await mint(ADMIN, { via: "api" }).requestWorkspaceWrite(
        id, "stopAgent", { chatId: 3, gatekeeperId: undefined }, `  ${REASON}  `);

    // In order: the id, the directory, then the one call that records and stores.
    expect(calls.map(call => `${call.target}.${call.method}`)).toEqual([
      "overseers.idFromString", "directorys.getByName", "directory.workspaceListing",
      "admin.requestWorkspaceWrite",
    ]);
    expect(callsTo("overseers", "get")).toEqual([]);

    const [stored] = callsTo("admin", "requestWorkspaceWrite")[0].args as [StoredAdminWrite];
    expect(stored).toStrictEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/), workspaceId: id,
      workspaceTitle: `${"t".repeat(MAX_ADMIN_AUDIT_ARG_LENGTH - 1)}…`,
      workspaceOwner: expect.stringMatching(/^o+…#[0-9a-f]{20}$/),
      action: "stopAgent", args: { chatId: 3 },
      reason: REASON, requestedBy: ADMIN, via: "api", sessionId: expect.any(String),
      requestedAt: expect.any(Date), expiresAt: expect.any(Date), state: "pending",
    });
    expect(stored.workspaceOwner).toHaveLength(MAX_ADMIN_AUDIT_ARG_LENGTH);
    expect(stored.requestedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(stored.requestedAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(stored.expiresAt.getTime() - stored.requestedAt.getTime())
        .toBe(ADMIN_WRITE_REQUEST_LIFETIME_SECONDS * 1000);
    expect(ADMIN_WRITE_REQUEST_LIFETIME_SECONDS).toBe(600);

    // The view is the stored request without the session, plus the page that approves it.
    const { sessionId, ...shown } = stored;
    expect(view).toStrictEqual(
        { ...shown, approvalUrl: `https://workshop.example/admin/approve/${stored.id}` });
    expect(view).not.toHaveProperty("sessionId");
    expect(view.via).toBe("api");
  });

  it("stores the workspace's id as the id itself prints it, however the caller wrote it",
      async () => {
    const { mint, callsTo } = writesDeployment();
    const id = workspaceId();
    const written = id.toUpperCase();
    expect(written).not.toBe(id);
    const view = await mint().requestWorkspaceWrite(written, "restartWorkspace", {}, REASON);

    expect(callsTo("directory", "workspaceListing")[0].args).toEqual([id]);
    const [stored] = callsTo("admin", "requestWorkspaceWrite")[0].args as [StoredAdminWrite];
    expect(stored.workspaceId).toBe(id);
    expect(view.workspaceId).toBe(id);
  });

  it("requests and denies through the capability's own session and `via`", async () => {
    const { mint, callsTo } = writesDeployment();
    const api = mint(ADMIN, { via: "cli" });
    await api.requestWorkspaceWrite(workspaceId(), "restartWorkspace", {}, REASON);
    await api.denyWorkspaceWrite(REQUEST_ID);
    const [stored] = callsTo("admin", "requestWorkspaceWrite")[0].args as [StoredAdminWrite];
    expect(stored.via).toBe("cli");
    expect(callsTo("admin", "denyWorkspaceWrite")[0].args).toStrictEqual(
        [REQUEST_ID, { admin: ADMIN, sessionId: stored.sessionId, via: "cli" }]);

    // Another capability of the same admin is another session, with a `via` of its own.
    await mint(ADMIN, { via: "api" }).denyWorkspaceWrite(REQUEST_ID);
    const [, later] = callsTo("admin", "denyWorkspaceWrite")[0].args;
    expect(later).toStrictEqual({ admin: ADMIN, sessionId: expect.any(String), via: "api" });
    expect((later as { sessionId: string }).sessionId).not.toBe(stored.sessionId);
  });

  it("reads a request by id, as its view", async () => {
    const { mint, calls } = writesDeployment();
    const view = await mint().getWorkspaceWrite(REQUEST_ID);
    expect(calls).toStrictEqual(
        [{ target: "admin", method: "getWorkspaceWrite", args: [REQUEST_ID] }]);
    const { sessionId, ...shown } = STORED;
    expect(view).toStrictEqual(
        { ...shown, approvalUrl: `https://workshop.example/admin/approve/${REQUEST_ID}` });
    expect(view).not.toHaveProperty("sessionId");
  });

  it("forwards a failure of the AdminSettings object as it is", async () => {
    const refusal = new Error("refused by the settings object");
    const { mint } = deployment({
      vars: ON,
      handlers: {
        admin: {
          requestWorkspaceWrite: () => { throw refusal; },
          denyWorkspaceWrite: () => { throw refusal; },
        },
        directory: { workspaceListing: () => LISTING },
      },
    });
    const api = mint();
    expect(await rejection(
        api.requestWorkspaceWrite(workspaceId(), "restartWorkspace", {}, REASON))).toBe(refusal);
    expect(await rejection(api.denyWorkspaceWrite(REQUEST_ID))).toBe(refusal);
  });

  describe("a request to read a workspace's content", () => {
    const CONTENT = {
      config: { adminWorkspaceAccess: "content" as const },
      vars: { ...ON, ADMIN_WORKSPACE_ACCESS_MAX: "content" },
    };
    const handlers = { directory: { workspaceListing: () => LISTING } };

    it.each([
      ["no cap", { ...CONTENT, vars: ON }],
      ["the cap at metadata", { ...CONTENT, vars: { ...ON, ADMIN_WORKSPACE_ACCESS_MAX: "metadata" } }],
      ["the admins' choice of metadata", { vars: CONTENT.vars }],
    ])("is refused while the level in force is below content, by %s, storing and recording nothing",
        async (_case, setup) => {
      const { mint, calls, callsTo } = deployment({ ...setup, handlers });
      const error = await rejection(
          mint().requestWorkspaceWrite(workspaceId(), "grantContentAccess", {}, REASON));
      expect(getAdminAccessErrorCode(error)).toBe(ADMIN_ACCESS_ERROR_CODES.contentOff);
      // Only the committed config was read.
      expect(named(calls)).toEqual(["admin.committedAdminConfig"]);
      expect(callsTo("overseers", "get")).toEqual([]);
    });

    it("is stored like any other request at level content, never reaching the workspace",
        async () => {
      const { mint, callsTo } = deployment({ ...CONTENT, handlers });
      const id = workspaceId();
      const view = await mint(ADMIN, { via: "api" }).requestWorkspaceWrite(
          id, "grantContentAccess", {}, REASON);

      const [stored] = callsTo("admin", "requestWorkspaceWrite")[0].args as [StoredAdminWrite];
      expect(stored).toMatchObject({
        workspaceId: id, workspaceTitle: LISTING.title, workspaceOwner: LISTING.ownerId,
        action: "grantContentAccess", args: {}, reason: REASON, requestedBy: ADMIN, via: "api",
        state: "pending",
      });
      expect(stored.expiresAt.getTime() - stored.requestedAt.getTime())
          .toBe(ADMIN_WRITE_REQUEST_LIFETIME_SECONDS * 1000);
      expect(view).toMatchObject({
        id: stored.id, action: "grantContentAccess",
        approvalUrl: `https://workshop.example/admin/approve/${stored.id}`,
      });
      expect(callsTo("overseers", "get")).toEqual([]);
      expect(callsTo("audit", "append")).toEqual([]);
    });

    it("leaves the level alone for every other action", async () => {
      const { mint, callsTo } = deployment({ vars: ON, handlers });
      await mint().requestWorkspaceWrite(workspaceId(), "restartWorkspace", {}, REASON);
      expect(callsTo("admin", "committedAdminConfig")).toEqual([]);
      expect(callsTo("admin", "requestWorkspaceWrite")).toHaveLength(1);
    });
  });

  describe("ending a grant an approval gave", () => {
    const GRANT_ID = "0b6f6c0e-2f0b-4f0a-9d0b-6a3c0a2d9e11";

    // Whatever the level, and with writes off: these deployments set neither.
    it("has the workspace end it, through the capability's own session and `via`", async () => {
      const { mint, calls, callsTo } = deployment();
      const api = mint(ADMIN, { via: "cli" });
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

  describe("approval", () => {
    const { passkeyRefused, requestNotFound, requestNotPending, workspaceChanged } =
        ADMIN_WRITE_ERROR_CODES;
    // Who approved, as AdminSettings stored it: not the capability the tests call through.
    const APPROVER: AdminWriteApprover = {
      admin: "approver@example.test", sessionId: "the approver's session", via: "api",
      passkey: "credential-id",
    };

    // A request as the AdminSettings stub answers approveWorkspaceWrite() with, for a workspace
    // id of this deployment.
    const approvedWrite = (): StoredAdminWrite & { approver: AdminWriteApprover } => ({
      ...STORED, workspaceId: workspaceId(), state: "approved", approver: APPROVER,
    });

    it("begins an approval for the caller", async () => {
      const challenge = { challenge: "approve" };
      const { mint, calls } = deployment({
        vars: ON, handlers: { admin: { beginWorkspaceWriteApproval: () => challenge } },
      });
      expect(await mint().beginWorkspaceWriteApproval(REQUEST_ID)).toBe(challenge);
      expect(calls).toStrictEqual(
          [{ target: "admin", method: "beginWorkspaceWriteApproval", args: [REQUEST_ID, ADMIN] }]);
    });

    it("approves, has the workspace run the write and settles it, in that order", async () => {
      const request = approvedWrite();
      const release = Promise.withResolvers<void>();
      const { mint, calls, callsTo, waitUntil } = approvalDeployment(request, { admin: {
        settleWorkspaceWrite: async () => {
          await release.promise;
          return { ...request, state: "applied", outcome: "3 rejected", unrecorded: true };
        },
      } });
      const approving = mint(ADMIN, { via: "cli" }).approveWorkspaceWrite(REQUEST_ID, ASSERTION);
      await vi.waitFor(() => expect(callsTo("admin", "settleWorkspaceWrite")).toHaveLength(1));

      expect(named(calls)).toEqual([
        "admin.approveWorkspaceWrite", "overseers.idFromString", "overseers.get",
        "overseer.applyAdminWrite", "admin.settleWorkspaceWrite",
      ]);
      // The ceremony is this capability's.
      expect(callsTo("admin", "approveWorkspaceWrite")[0].args).toStrictEqual(
          [REQUEST_ID, ASSERTION, { admin: ADMIN, sessionId: expect.any(String), via: "cli" }]);
      // The grant is the request's fields and the approver AdminSettings stored: its actor and
      // its passkey, so the workspace's record and the closing record name the same ones.
      expect(callsTo("overseers", "get")[0].args).toEqual([request.workspaceId]);
      expect(callsTo("overseer", "applyAdminWrite")[0].args).toStrictEqual([{
        requestId: REQUEST_ID, action: "stopAgent", args: { chatId: 3 }, reason: REASON,
        requestedBy: "other-admin@example.test", expiresAt: request.expiresAt,
        workspaceOwner: "bob@example.test", ...APPROVER,
      }]);
      expect(callsTo("admin", "settleWorkspaceWrite")[0].args)
          .toStrictEqual([REQUEST_ID, { outcome: "3 rejected" }]);

      // The run is kept alive until the request is settled, whatever becomes of the client.
      expect(waitUntil).toHaveBeenCalledTimes(1);
      let kept = false;
      const running = waitUntil.mock.calls[0][0].then(() => { kept = true; });
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(kept).toBe(false);
      release.resolve();
      await running;
      expect(kept).toBe(true);

      // The view is the settled request, without what only the server keeps.
      const { sessionId, approver, ...shown } = request;
      expect(await approving).toStrictEqual({
        ...shown, state: "applied", outcome: "3 rejected",
        approvalUrl: `https://workshop.example/admin/approve/${REQUEST_ID}`,
      });
    });

    it.each<[string, () => unknown, string, boolean]>([
      ["drops a workspace found missing from the directory",
        () => createAdminAccessError(ADMIN_ACCESS_ERROR_CODES.workspaceNotFound),
        "Workspace not found.", true],
      ["leaves a workspace that changed owner listed",
        () => createAdminWriteError(workspaceChanged),
        "This workspace no longer belongs to the owner the request named, so the write was " +
            "not run. Request it again.", false],
      ["leaves the workspace listed after any other failure",
        () => new Error("No such chat."), "No such chat.", false],
      ["takes a thrown value that is no Error as its text", () => "unreachable", "unreachable",
        false],
    ])("settles a write the workspace did not run with its message, and %s",
        async (_label, thrown, message, dropped) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const request = approvedWrite();
      const { mint, calls, callsTo, waitUntil } = approvalDeployment(request, {
        overseer: { applyAdminWrite: () => { throw thrown(); } },
      });
      // The ceremony succeeded, so the call resolves, with the workspace's answer.
      const view = await mint().approveWorkspaceWrite(REQUEST_ID, ASSERTION);
      expect(view).toMatchObject({ state: "failed", error: message });
      expect(view).not.toHaveProperty("unrecorded");
      expect(view).not.toHaveProperty("refusals");

      expect(callsTo("admin", "settleWorkspaceWrite").map(call => call.args))
          .toStrictEqual([[REQUEST_ID, { error: message }]]);
      expect(callsTo("directory", "removeWorkspace").map(call => call.args))
          .toEqual(dropped ? [[request.workspaceId]] : []);
      // The workspace is asked once, and the directory is healed before the request is settled.
      expect(callsTo("overseer", "applyAdminWrite")).toHaveLength(1);
      expect(named(calls).at(-1)).toBe("admin.settleWorkspaceWrite");
      expect(waitUntil).toHaveBeenCalledTimes(1);
      vi.restoreAllMocks();
    });

    it("settles a write to a missing workspace though the directory cannot be healed",
        async () => {
      const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { mint, callsTo } = approvalDeployment(approvedWrite(), {
        overseer: { applyAdminWrite: () => {
          throw createAdminAccessError(ADMIN_ACCESS_ERROR_CODES.workspaceNotFound);
        } },
        directory: { removeWorkspace: () => { throw new Error("directory unavailable"); } },
      });
      expect((await mint().approveWorkspaceWrite(REQUEST_ID, ASSERTION)).state).toBe("failed");
      expect(callsTo("admin", "settleWorkspaceWrite")).toHaveLength(1);
      expect(warned.mock.calls.map(([entry]) => (entry as { event?: string }).event))
          .toEqual(["admin.directory.heal.failed", "admin.write.failed"]);
      vi.restoreAllMocks();
    });

    it.each([passkeyRefused, requestNotPending, requestNotFound])(
        "never reaches the workspace when the approval is refused %s", async code => {
      const { mint, calls, waitUntil } = approvalDeployment(approvedWrite(), {
        admin: { approveWorkspaceWrite: () => { throw createAdminWriteError(code); } },
      });
      const error = await rejection(mint().approveWorkspaceWrite(REQUEST_ID, ASSERTION));
      expect(getAdminWriteErrorCode(error)).toBe(code);
      expect(named(calls)).toEqual(["admin.approveWorkspaceWrite"]);
      expect(waitUntil).not.toHaveBeenCalled();
    });

    it("runs a request once when two capabilities approve it", async () => {
      const request = approvedWrite();
      let approvals = 0;
      const { mint, callsTo, waitUntil } = approvalDeployment(request, { admin: {
        approveWorkspaceWrite: () => {
          if (++approvals > 1) throw createAdminWriteError(requestNotPending);
          return request;
        },
      } });
      const first = mint(ADMIN, { via: "api" });
      const second = mint(ADMIN, { via: "cli" });
      const [won, lost] = await Promise.allSettled([
        first.approveWorkspaceWrite(REQUEST_ID, ASSERTION),
        second.approveWorkspaceWrite(REQUEST_ID, ASSERTION),
      ]);
      expect(won).toMatchObject({ status: "fulfilled", value: { state: "applied" } });
      expect(lost.status).toBe("rejected");
      expect(getAdminWriteErrorCode((lost as PromiseRejectedResult).reason))
          .toBe(requestNotPending);
      expect(callsTo("admin", "approveWorkspaceWrite")).toHaveLength(2);
      expect(callsTo("overseer", "applyAdminWrite")).toHaveLength(1);
      expect(callsTo("admin", "settleWorkspaceWrite")).toHaveLength(1);
      expect(waitUntil).toHaveBeenCalledTimes(1);
    });

    it("forwards a failure to settle as it is, having asked the workspace once", async () => {
      const failure = new Error("the settings object is unreachable");
      const { mint, callsTo, waitUntil } = approvalDeployment(approvedWrite(), {
        admin: { settleWorkspaceWrite: () => { throw failure; } },
      });
      expect(await rejection(mint().approveWorkspaceWrite(REQUEST_ID, ASSERTION))).toBe(failure);
      expect(callsTo("overseer", "applyAdminWrite")).toHaveLength(1);
      // The same promise was given to waitUntil(), which the caller's own rejection handles.
      expect(await rejection(waitUntil.mock.calls[0][0])).toBe(failure);
    });

    it("hands the workspace who was in the workspace an agent's request was filed from, " +
        "and shows it to no client", async () => {
      const insiders = ["other-admin@example.test", "member-admin@example.test"];
      const request: ReturnType<typeof approvedWrite> = {
        ...approvedWrite(), action: "grantContentAccess", args: {}, via: "gatekeeper",
        agent: { workspaceId: "c".repeat(64), chatId: 4 }, insiders,
      };
      const { mint, callsTo } = approvalDeployment(request, {
        admin: { getWorkspaceWrite: () => request },
      });
      const api = mint();
      const shown = await api.approveWorkspaceWrite(REQUEST_ID, ASSERTION);

      // The workspace checks the approver against the list again, so the grant carries it.
      expect(callsTo("overseer", "applyAdminWrite")[0].args).toStrictEqual([{
        requestId: REQUEST_ID, action: "grantContentAccess", args: {}, reason: REASON,
        requestedBy: "other-admin@example.test", expiresAt: request.expiresAt,
        workspaceOwner: "bob@example.test", ...APPROVER, insiders,
      }]);
      // Neither the approval's answer nor a later read of the request shows it.
      expect(shown).not.toHaveProperty("insiders");
      expect(await api.getWorkspaceWrite(REQUEST_ID)).not.toHaveProperty("insiders");
    });
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
         cursor: undefined, limit: 3 }]],
    ["getIssueReport", api => api.getIssueReport("report"), "get", ["report"]],
    ["addIssueReportEntry", api => api.addIssueReportEntry("report", "Which chart?", "public"),
      "addEntry", [PROFILE, { via: "cli" }, "report", "Which chart?", "public"]],
    ["setIssueReportStatus", api => api.setIssueReportStatus("report", "closed"), "setStatus",
      [PROFILE, { via: "cli" }, "report", "closed"]],
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
    const api = mint(ADMIN, { via: "api" });
    await api.addIssueReportEntry("report", "A note", "admins");
    await api.setIssueReportStatus("report", "investigating");
    // An admin whose account has no profile is named by their id.
    const byId = { type: "user", id: ADMIN, name: ADMIN };
    expect(callsTo("users", "getByName").map(call => call.args)).toStrictEqual([[ADMIN], [ADMIN]]);
    expect(callsTo("report", "addEntry")[0].args)
        .toStrictEqual([byId, { via: "api" }, "report", "A note", "admins"]);
    expect(callsTo("report", "setStatus")[0].args)
        .toStrictEqual([byId, { via: "api" }, "report", "investigating"]);
  });

  it("lists with the default page size, the query passed field by field",
      async () => {
    const { mint, callsTo } = reportDeployment();
    const api = mint();
    await api.listIssueReports();
    await api.listIssueReports({
      status: "closed", priority: "low", reporter: "ada", workspace: "w1", cursor: "c",
    });
    expect(callsTo("report", "list").map(call => call.args[0])).toStrictEqual([
      { status: undefined, priority: undefined, reporter: undefined, workspace: undefined,
        cursor: undefined, limit: 50 },
      { status: "closed", priority: "low", reporter: "ada", workspace: "w1", cursor: "c",
        limit: 50 },
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
});

describe("AdminApiImpl lent to the admin gatekeeper", () => {
  const AGENT: AdminAgentOrigin = { workspaceId: "c".repeat(64), chatId: 4 };
  const GATEKEEPER: AdminCaller = { via: "gatekeeper", agent: AGENT };
  const LISTING = { title: "Quarterly plan", ownerId: "ada" };
  const USER = "ada@example.test";
  const ON = { ADMIN_WORKSPACE_WRITES: "on", PUBLIC_BASE_URL: "https://workshop.example/" };

  // What each caller's label is on the terms of a view of a workspace and of a user's account,
  // the record of a refused open of each, a stored write request and its view, and the actor of
  // a step taken in a request.
  async function labels(caller: AdminCaller) {
    const opening = deployment({ handlers: {
      overseer: { openForAdmin: () => ({}) }, user: { openForAdmin: () => ({}) },
    } });
    await opening.mint(ADMIN, caller).inspectWorkspace(workspaceId(), REASON);
    const terms = opening.callsTo("overseer", "openForAdmin")[0]!.args[3] as
        AdminWorkspaceViewTerms;
    await opening.mint(ADMIN, caller).inspectUser(USER, REASON);
    const userTerms = opening.callsTo("user", "openForAdmin")[0]!.args[3] as AdminViewTerms;

    const off = deployment({
      config: { adminWorkspaceAccess: "off" },
      handlers: { directory: { workspaceListing: () => LISTING } },
    });
    const error = await rejection(off.mint(ADMIN, caller).inspectWorkspace(workspaceId(), REASON));
    expect(getAdminAccessErrorCode(error)).toBe(ADMIN_ACCESS_ERROR_CODES.accessOff);
    const refused = off.callsTo("audit", "append")[0]!.args[0] as AdminAccessRecord;
    await rejection(off.mint(ADMIN, caller).inspectUser(USER, REASON));
    const refusedUser = off.callsTo("audit", "append")[0]!.args[0] as AdminUserAccessRecord;

    const writes = deployment({
      vars: ON, handlers: { directory: { workspaceListing: () => LISTING } },
    });
    const api = writes.mint(ADMIN, caller);
    const view = await api.requestWorkspaceWrite(workspaceId(), "restartWorkspace", {}, REASON);
    const stored = writes.callsTo("admin", "requestWorkspaceWrite")[0]!.args[0] as
        StoredAdminWrite;
    await api.denyWorkspaceWrite(stored.id);
    const actor = writes.callsTo("admin", "denyWorkspaceWrite")[0]!.args.at(-1) as object;
    return { terms, userTerms, refused, refusedUser, stored, view, actor };
  }

  it("labels an open, a refused open and a write request with where the call came from",
      async () => {
    const { terms, userTerms, refused, refusedUser, stored, view, actor } =
        await labels(GATEKEEPER);
    expect(terms).toStrictEqual(
        { via: "gatekeeper", agent: AGENT, access: "metadata", expiresAt: terms.expiresAt });
    expect(userTerms).toStrictEqual(
        { via: "gatekeeper", agent: AGENT, expiresAt: userTerms.expiresAt });
    expect(refused).toMatchObject({
      kind: "workspace", admin: ADMIN, via: "gatekeeper", agent: AGENT,
      method: "inspectWorkspace", refused: ADMIN_ACCESS_ERROR_CODES.accessOff,
    });
    expect(refusedUser).toMatchObject({
      kind: "user", admin: ADMIN, via: "gatekeeper", agent: AGENT, userId: USER,
      method: "inspectUser", refused: ADMIN_ACCESS_ERROR_CODES.accessOff,
    });
    expect(stored).toMatchObject({ requestedBy: ADMIN, via: "gatekeeper", agent: AGENT });
    expect(view).toMatchObject({ requestedBy: ADMIN, via: "gatekeeper", agent: AGENT });
    expect(actor).toStrictEqual(
        { admin: ADMIN, sessionId: stored.sessionId, via: "gatekeeper", agent: AGENT });
    // Each holds its own copy: the caller's object is not what a record keeps.
    for (let labelled of [terms, userTerms, refused, refusedUser, stored]) {
      expect(labelled.agent).toStrictEqual(AGENT);
      expect(labelled.agent).not.toBe(AGENT);
    }
  });

  it("copies nothing of the caller into a record but its via and its origin", async () => {
    const insiders = ["ada", "grace"];
    const caller = { ...GATEKEEPER, insiders, admin: "mallory" } as AdminCaller;
    const { terms, userTerms, refused, refusedUser, stored, view, actor } = await labels(caller);
    expect(Object.keys(terms).toSorted()).toEqual(["access", "agent", "expiresAt", "via"]);
    expect(Object.keys(userTerms).toSorted()).toEqual(["agent", "expiresAt", "via"]);
    for (let labelled of [refused, refusedUser, view, actor]) {
      expect(labelled).not.toHaveProperty("insiders");
    }
    expect([refused.admin, refusedUser.admin, stored.requestedBy]).toEqual([ADMIN, ADMIN, ADMIN]);
    // The stored request alone keeps who was in the workspace it was filed from, as its own
    // copy of the list.
    expect(stored.insiders).toStrictEqual(insiders);
    expect(stored.insiders).not.toBe(insiders);
  });

  it("gives a client's session no origin anywhere", async () => {
    const { terms, userTerms, refused, refusedUser, stored, view, actor } =
        await labels({ via: "cli" });
    for (let labelled of [terms, userTerms, refused, refusedUser, stored, view, actor]) {
      expect(labelled).toHaveProperty("via", "cli");
      expect(labelled).not.toHaveProperty("agent");
      expect(labelled).not.toHaveProperty("insiders");
    }
  });

  // Neither a workspace nor an account checks the terms it is opened with, so a label that is
  // not one must never reach either.
  it("refuses a caller that is not one, at its first labelled call", async () => {
    const { mint, calls } = deployment({ handlers: {
      overseer: { openForAdmin: () => ({}) }, user: { openForAdmin: () => ({}) },
    } });
    for (let caller of [
      { via: "gatekeeper" }, { via: "gatekeeper", agent: null },
      { via: "gatekeeper", agent: { workspaceId: "" } },
      { via: "gatekeeper", agent: { ...AGENT, chatId: -1 } },
      { via: "cli", agent: AGENT }, { via: "api", agent: AGENT }, { via: "browser" },
      { via: undefined },
    ]) {
      const api = mint(ADMIN, caller as AdminCaller);
      expect(await rejection(api.inspectWorkspace(workspaceId(), REASON)), JSON.stringify(caller))
          .toBeInstanceOf(TypeError);
      expect(await rejection(api.inspectUser(USER, REASON)), JSON.stringify(caller))
          .toBeInstanceOf(TypeError);
      expect(calls.filter(call => call.method === "openForAdmin" || call.method === "append"))
          .toEqual([]);
    }
  });

  it("writes an issue report entry and a status line that admins read with the origin",
      async () => {
    // The store is the real one, so what comes back is what an admin reads.
    const reports = env.TEST_ISSUE_REPORTS.getByName(crypto.randomUUID());
    const onStore = <T>(call: (store: IssueReportsDurableObject) => T | Promise<T>) =>
        runInDurableObject(reports, call);
    const report = await onStore(store => store.submit(
        { id: "ada", name: "Ada" }, { text: "The export fails.", priority: "low" }, false));
    const profile = { type: "user", id: ADMIN, name: "Grace (admin)" };
    type Store = IssueReportsDurableObject;
    const deploymentOf = () => deployment({ handlers: {
      user: { whoamiIfExists: () => profile },
      report: {
        addEntry: (...args: Parameters<Store["addEntry"]>) =>
            onStore(store => store.addEntry(...args)),
        setStatus: (...args: Parameters<Store["setStatus"]>) =>
            onStore(store => store.setStatus(...args)),
        get: (id: string) => onStore(store => store.get(id)),
      },
    } });

    const lent = deploymentOf().mint(ADMIN, GATEKEEPER);
    const entry = await lent.addIssueReportEntry(report.id, "Looks like the quota.", "admins");
    expect(entry).toMatchObject({ via: "gatekeeper", agent: AGENT, visibility: "admins" });
    await lent.setIssueReportStatus(report.id, "investigating");
    const person = deploymentOf().mint(ADMIN, { via: "cli" });
    await person.addIssueReportEntry(report.id, "Confirmed.", "admins");

    const read = await person.getIssueReport(report.id);
    expect(read.entries.map(({ via, agent, text, status }) => ({ via, agent, text, status })))
        .toStrictEqual([
          { via: "gatekeeper", agent: AGENT, text: "Looks like the quota.", status: undefined },
          { via: "gatekeeper", agent: AGENT, text: "", status: "investigating" },
          { via: "cli", agent: undefined, text: "Confirmed.", status: undefined },
        ]);
    expect(read.entries[2]).not.toHaveProperty("agent");
    // The reporter reads the status line as an agent's, without where it came from.
    const own = await onStore(store => store.getOwn("ada", report.id));
    expect(own.entries).toHaveLength(1);
    expect(own.entries[0]).toMatchObject({ via: "gatekeeper", status: "investigating" });
    expect(own.entries[0]).not.toHaveProperty("agent");
  });
});
