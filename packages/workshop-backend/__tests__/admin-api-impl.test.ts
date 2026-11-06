import { describe, expect, it } from "vitest";
import { type AdminVia } from "@gadgets/workshop-shared/api";
import { AdminApiImpl } from "../src/admin-settings.js";
import {
  DEFAULT_ADMIN_CONFIG, type AdminConfig,
} from "../src/storage-schema/admin-settings-storage.js";

const ADMIN = "admin@example.test";

type Call = { target: string; method: string; args: unknown[] };
type Handler = (...args: any[]) => unknown;

/**
 * An AdminApiImpl over fake namespaces, with `vars` as its environment. `calls`
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
    AdminAuditDurableObject: namespace("audit"),
  } } as unknown as ExecutionContext;
  const deploymentEnv = { ...options.vars } as unknown as Cloudflare.Env;
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
      kind: "setting", admin: ADMIN, since, cursor: "next", extra: true,
    } as Parameters<AdminApiImpl["listAdminAudit"]>[0])).toBe(page);
    expect(callsTo("audit", "list")[0]!.args).toStrictEqual([
      { kind: "setting", admin: ADMIN, since, cursor: "next", limit: 50 },
      120,
    ]);
  });

  it("rejects a page size out of range before asking the log", async () => {
    const { mint, calls } = deployment();
    const api = mint();
    for (let limit of [0, 201, 1.5]) {
      expect(await rejection(api.listAdminAudit({ limit }))).toBeInstanceOf(TypeError);
    }
    expect(calls).toEqual([]);
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
