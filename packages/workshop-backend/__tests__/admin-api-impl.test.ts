import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import {
  ADMIN_ACCESS_ERROR_CODES, DEFAULT_ADMIN_VIEW_LIFETIME_SECONDS, MAX_ADMIN_AUDIT_ARG_LENGTH,
  createAdminAccessError, getAdminAccessErrorCode,
  type AdminAccessRecord, type AdminVia, type AdminViewAccess,
} from "@gadgets/workshop-shared/api";
import { AdminApiImpl } from "../src/admin-settings.js";
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
 * answers committedAdminConfig() with `config` over the defaults.
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
  const ctx = { exports: {
    AdminSettings: namespace("admin"),
    UserDirectoryDurableObject: namespace("directory"),
    AdminAuditDurableObject: namespace("audit"),
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
  return { mint, calls, callsTo };
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

  it("never runs with a level that is not \"metadata\" or \"full\"", () => {
    // The validator refuses it before the method's body runs: synchronously, on a direct call.
    const { mint, calls } = deployment();
    const api = mint();
    const id = workspaceId();
    expect(() => api.inspectWorkspace(id, REASON, { access: "off" as any })).toThrow(TypeError);
    expect(() => api.inspectWorkspace(id, REASON, { access: "everything" as any }))
        .toThrow(TypeError);
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
    const { mint, calls } = deployment({ config: { adminWorkspaceAccess: "full" } });
    const error = await rejection(mint().inspectWorkspace("not-a-workspace", REASON));
    expect(getAdminAccessErrorCode(error)).toBe(ADMIN_ACCESS_ERROR_CODES.workspaceNotFound);
    expect(calls.map(call => `${call.target}.${call.method}`)).toEqual(["overseers.idFromString"]);
  });

  describe.each([
    ["the authoritative config", { config: { adminWorkspaceAccess: "off" as const } }],
    ["ADMIN_WORKSPACE_ACCESS_MAX off", { vars: { ADMIN_WORKSPACE_ACCESS_MAX: "off" } }],
    ["ADMIN_WORKSPACE_ACCESS_MAX not a level", { vars: { ADMIN_WORKSPACE_ACCESS_MAX: "none" } }],
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

      // A level asked for is recorded too, refused alike.
      await rejection(api.inspectWorkspace(id, REASON, { access: "full" }));
      const [third] = callsTo("audit", "append")[2]!.args as [AdminAccessRecord];
      expect(third).toMatchObject({ requested: "full", access: "off" });
    });

    it("cuts a long title as the audit log cuts any", async () => {
      const { mint, callsTo } = offDeployment(() => ({ title: "t".repeat(1000), ownerId: "ada" }));
      await rejection(mint().inspectWorkspace(workspaceId(), REASON));
      const [record] = callsTo("audit", "append")[0]!.args as [AdminAccessRecord];
      expect(record.workspaceTitle).toBe(`${"t".repeat(MAX_ADMIN_AUDIT_ARG_LENGTH - 1)}…`);
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

  it.each([
    ["full", "full", undefined, "metadata"],
    ["full", "full", "full", "full"],
    ["full", undefined, "full", "metadata"],
    ["metadata", "full", "full", "metadata"],
    ["metadata", "full", "metadata", "metadata"],
  ] as const)("opens a view at the lowest of %s, the cap %s and the level asked for, %s",
      async (chosen, max, requested, access) => {
    // The view comes back wrapped in its validator, so it is told apart by what it answers.
    const view = { describe: async () => "the minted view" };
    const { mint, callsTo } = deployment({
      config: { adminWorkspaceAccess: chosen },
      vars: max === undefined ? {} : { ADMIN_WORKSPACE_ACCESS_MAX: max },
      handlers: { overseer: { openForAdmin: () => view } },
    });
    const id = workspaceId();
    const before = Date.now();
    const minted = await mint(ADMIN, "api").inspectWorkspace(
        id, ` ${REASON} `, requested === undefined ? undefined : { access: requested });
    expect(await minted.describe()).toBe("the minted view");
    const after = Date.now();

    expect(callsTo("overseers", "get").map(call => call.args)).toEqual([[id]]);
    const opens = callsTo("overseer", "openForAdmin");
    expect(opens).toHaveLength(1);
    const [adminId, reason, sessionId, terms] = opens[0]!.args as
        [string, string, string,
         { via: string; requested: AdminViewAccess; access: AdminViewAccess; expiresAt: Date }];
    expect([adminId, reason, typeof sessionId]).toEqual([ADMIN, REASON, "string"]);
    expect(terms.via).toBe("api");
    expect(terms.requested).toBe(requested ?? "metadata");
    expect(terms.access).toBe(access);
    const lifetime = DEFAULT_ADMIN_VIEW_LIFETIME_SECONDS * 1000;
    expect(terms.expiresAt.getTime()).toBeGreaterThanOrEqual(before + lifetime);
    expect(terms.expiresAt.getTime()).toBeLessThanOrEqual(after + lifetime);
    expect(callsTo("audit", "append")).toEqual([]);
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
    expect(await mint().listAdminAudit({
      kind: "workspace", admin: ADMIN, method: "getChat", workspace: "w", owner: "ada",
      exposed: "content", since, cursor: "next", extra: true,
    } as Parameters<AdminApiImpl["listAdminAudit"]>[0])).toBe(page);
    expect(callsTo("audit", "list")[0]!.args).toStrictEqual([
      {
        kind: "workspace", admin: ADMIN, method: "getChat", workspace: "w", owner: "ada",
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
