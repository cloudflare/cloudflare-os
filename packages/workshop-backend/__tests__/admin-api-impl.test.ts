import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import {
  ADMIN_ACCESS_ERROR_CODES, ADMIN_WRITE_ERROR_CODES, ADMIN_WRITE_REQUEST_LIFETIME_SECONDS,
  DEFAULT_ADMIN_VIEW_LIFETIME_SECONDS, MAX_ADMIN_AUDIT_ARG_LENGTH, createAdminAccessError,
  createAdminWriteError, getAdminAccessErrorCode, getAdminWriteErrorCode,
  type AdminAccessRecord, type AdminPasskeyAssertion, type AdminPasskeyRegistration,
  type AdminVia, type AdminViewAccess, type AdminWriteArgs,
} from "@gadgets/workshop-shared/api";
import { AdminApiImpl } from "../src/admin-settings.js";
import type { AdminWriteApprover, StoredAdminWrite } from "../src/admin-writes.js";
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
    workspaceOwner: "bob@example.test", action: "deleteChat", args: { chatId: 3 }, reason: REASON,
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
  // the answer marked as still to be recorded, and whose workspace reports an outcome. `handlers`
  // replace any of that.
  const approvalDeployment = (request: StoredAdminWrite,
      handlers: Record<string, Record<string, Handler>> = {}) => deployment({
    vars: ON,
    handlers: {
      admin: {
        approveWorkspaceWrite: () => request,
        settleWorkspaceWrite: (_id: string, result: { outcome?: string; error?: string }) => ({
          ...request, state: "error" in result ? "failed" : "applied", ...result,
          unrecorded: true,
        }),
        ...handlers.admin,
      },
      overseer: { applyAdminWrite: () => ({ outcome: "3 rejected" }), ...handlers.overseer },
      directory: { ...handlers.directory },
    },
  });

  const methods: Record<string, (api: AdminApiImpl) => Promise<unknown>> = {
    requestWorkspaceWrite: api =>
        api.requestWorkspaceWrite(workspaceId(), "deleteChat", { chatId: 3 }, REASON),
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
      expect(await rejection(api.requestWorkspaceWrite(id, "deleteChat", { chatId: 3 }, reason)))
          .toBeInstanceOf(TypeError);
    }
    const refused: [Parameters<AdminApiImpl["requestWorkspaceWrite"]>[1], AdminWriteArgs][] = [
      ["restartWorkspace", { chatId: 1 }],
      ["deleteChat", {}],
      ["deleteChat", { chatId: -1 }],
      ["addCollaborator", { username: " ", grant: "workspace" }],
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
    expect(() => api.requestWorkspaceWrite(workspaceId(), "bogus" as any, {}, REASON))
        .toThrow(TypeError);
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
    const view = await mint(ADMIN, "api").requestWorkspaceWrite(
        id, "addCollaborator",
        { username: "carol@example.test", grant: { gadgetId: 5, role: "owner" } as any },
        `  ${REASON}  `);

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
      action: "addCollaborator",
      args: { username: "carol@example.test", grant: { gadgetId: 5 } },
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
    const api = mint(ADMIN, "cli");
    await api.requestWorkspaceWrite(workspaceId(), "restartWorkspace", {}, REASON);
    await api.denyWorkspaceWrite(REQUEST_ID);
    const [stored] = callsTo("admin", "requestWorkspaceWrite")[0].args as [StoredAdminWrite];
    expect(stored.via).toBe("cli");
    expect(callsTo("admin", "denyWorkspaceWrite")[0].args).toStrictEqual(
        [REQUEST_ID, { admin: ADMIN, sessionId: stored.sessionId, via: "cli" }]);

    // Another capability of the same admin is another session, with a `via` of its own.
    await mint(ADMIN, "api").denyWorkspaceWrite(REQUEST_ID);
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
      const approving = mint(ADMIN, "cli").approveWorkspaceWrite(REQUEST_ID, ASSERTION);
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
        requestId: REQUEST_ID, action: "deleteChat", args: { chatId: 3 }, reason: REASON,
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
      const first = mint(ADMIN, "api");
      const second = mint(ADMIN, "cli");
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
  });
});
