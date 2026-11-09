import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_ADMIN_AUDIT_ARG_LENGTH,
  type AdminAccessRecord, type AdminAuditRecord, type AdminSettingRecord,
  type AdminUserAccessRecord,
} from "@gadgets/workshop-shared/api";
import type { AdminAuditDurableObject } from "../src/admin-audit.js";
import { utcDayKey } from "../src/ai-gateway-billing/limits/config.js";
// Load the whole backend (the pool's `main`) up front, so its slow load does not count against the
// first test's timeout.
import "./test-worker.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_ADMIN_AUDIT: DurableObjectNamespace<AdminAuditDurableObject>;
  }
}

const DAY_MS = 24 * 60 * 60_000;
// The pool sets no ADMIN_AUDIT_RETENTION_MIN_DAYS, so the floor is the default, 90 days.
const RETENTION = 90;

function auditLog() {
  return env.TEST_ADMIN_AUDIT.getByName(crypto.randomUUID());
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * DAY_MS);
}

function access(overrides: Partial<AdminAccessRecord> = {}): AdminAccessRecord {
  return {
    kind: "workspace", at: new Date(), admin: "ada", sessionId: "session-1", via: "api",
    workspaceId: "w1", workspaceOwner: "owner-1", workspaceTitle: "Plans", method: "describe",
    args: {}, reason: "ticket 1",
    requested: "metadata", access: "metadata", exposed: "metadata", ...overrides,
  };
}

function userAccess(overrides: Partial<AdminUserAccessRecord> = {}): AdminUserAccessRecord {
  return {
    kind: "user", at: new Date(), admin: "ada", sessionId: "session-1", via: "api",
    userId: "grace", method: "describe", args: {}, reason: "ticket 1",
    requested: "metadata", access: "metadata", exposed: "metadata", ...overrides,
  };
}

function setting(overrides: Partial<AdminSettingRecord> = {}): AdminSettingRecord {
  return {
    kind: "setting", at: new Date(), admin: "ada", sessionId: "session-1", via: "cli",
    method: "setSiteName", changes: [{ setting: "siteName", before: "Old", after: "New" }],
    ...overrides,
  };
}

// Await a stub call's rejection with a single handler: expect(...).rejects forks the underlying
// JsRpcPromise, and the leftover copy is reported as an unhandled rejection.
async function expectRejection(call: Promise<unknown>, message: string): Promise<void> {
  let caught: unknown;
  let rejected = false;
  try { await call; } catch (err) { rejected = true; caught = err; }
  expect(rejected).toBe(true);
  expect(String(caught)).toContain(message);
}

type Stub = ReturnType<typeof auditLog>;

function sql<T extends Record<string, SqlStorageValue>>(stub: Stub, query: string,
    ...params: SqlStorageValue[]): Promise<T[]> {
  return runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<T>(query, ...params).toArray());
}

// A raw row, past append()'s shaping, to test the table's own CHECKs.
function insertRow(stub: Stub, kind: string, workspaceId: string | null, title: string | null,
    exposed: string | null): Promise<unknown[]> {
  return sql(stub, `INSERT INTO admin_audit
      (at, kind, admin, workspace_id, workspace_title, exposed, record)
      VALUES (0, ?, 'ada', ?, ?, ?, '{}')`, kind, workspaceId, title, exposed);
}

describe("AdminAuditDurableObject.list", () => {
  it("lists newest first, and returns each record as appended", async () => {
    let log = auditLog();
    let first = access({ at: daysAgo(2), args: { chatId: 4 }, refused: "ADMIN_CONTENT_WITHHELD" });
    let second = setting({ at: daysAgo(1) });
    let third = access({ workspaceId: "w2", method: "inspectWorkspace" });
    let fourth = userAccess({
      method: "inspectUser", args: { expiresAt: "2030-01-01T00:00:00.000Z" }, access: "off",
      refused: "ADMIN_WORKSPACE_ACCESS_OFF",
    });
    let fifth = access({
      method: "getChat", args: { chatId: 4 }, requested: "full", access: "full", exposed: "content",
    });
    let sixth = userAccess({
      method: "listConnectedAccounts", requested: "full", access: "full", exposed: "content",
    });
    for (let record of [first, second, third, fourth, fifth, sixth]) {
      await log.append(record, RETENTION);
    }

    let page = await log.list({ limit: 10 }, RETENTION);
    expect(page.records).toEqual([sixth, fifth, fourth, third, second, first]);
    expect(page.nextCursor).toBeUndefined();
  });

  it("stores each field once", async () => {
    let log = auditLog();
    await log.append(access(), RETENTION);
    await log.append(userAccess(), RETENTION);
    await log.append(setting(), RETENTION);
    let rows = await sql<
        { kind: string; workspace_id: string | null; exposed: string | null; record: string }>(log,
        "SELECT kind, workspace_id, exposed, record FROM admin_audit ORDER BY seq");
    expect(rows.map(row => [row.kind, row.workspace_id, row.exposed])).toEqual(
        [["workspace", "w1", "metadata"], ["user", null, "metadata"], ["setting", null, null]]);
    for (let row of rows) {
      let json = JSON.parse(row.record);
      for (let field of ["kind", "at", "admin", "workspaceId", "workspaceTitle", "exposed"]) {
        expect(json, field).not.toHaveProperty(field);
      }
    }
    // The ids a record is found by stay in the JSON, where the target index reads them.
    expect(JSON.parse(rows[0].record).workspaceOwner).toBe("owner-1");
    expect(JSON.parse(rows[1].record).userId).toBe("grace");
  });

  it("combines the kind, admin, workspace and since filters", async () => {
    let log = auditLog();
    let records: AdminAuditRecord[] = [
      access({ admin: "ada", workspaceId: "w1", at: daysAgo(3) }),
      access({ admin: "ada", workspaceId: "w2", at: daysAgo(1) }),
      access({ admin: "grace", workspaceId: "w1", at: daysAgo(1) }),
      setting({ admin: "ada", at: daysAgo(1) }),
    ];
    for (let record of records) await log.append(record, RETENTION);

    let list = async (query: object) =>
        (await log.list({ limit: 50, ...query }, RETENTION)).records;
    expect(await list({ kind: "setting" })).toEqual([records[3]]);
    expect(await list({ kind: "workspace", admin: "ada" })).toEqual([records[1], records[0]]);
    expect(await list({ workspace: "w1" })).toEqual([records[2], records[0]]);
    expect(await list({ workspace: "w1", admin: "ada", since: daysAgo(2) })).toEqual([]);
    expect(await list({ admin: "ada", since: daysAgo(2) })).toEqual([records[3], records[1]]);
  });

  it("filters on what a call exposed, alone and with the other filters", async () => {
    let log = auditLog();
    let records: AdminAuditRecord[] = [
      access({ admin: "ada", workspaceId: "w1", exposed: "content", at: daysAgo(3) }),
      access({ admin: "ada", workspaceId: "w2", exposed: "content", at: daysAgo(1) }),
      access({ admin: "grace", workspaceId: "w1", exposed: "content", at: daysAgo(1) }),
      access({ admin: "ada", workspaceId: "w1", at: daysAgo(1) }),
      setting({ admin: "ada", at: daysAgo(1) }),
    ];
    for (let record of records) await log.append(record, RETENTION);

    let list = async (query: object) =>
        (await log.list({ limit: 50, ...query }, RETENTION)).records;
    expect(await list({ exposed: "content" })).toEqual([records[2], records[1], records[0]]);
    expect(await list({ exposed: "content", kind: "workspace", admin: "ada" }))
        .toEqual([records[1], records[0]]);
    expect(await list({ exposed: "content", workspace: "w1" })).toEqual([records[2], records[0]]);
    expect(await list({ exposed: "content", admin: "ada", workspace: "w1", since: daysAgo(2) }))
        .toEqual([]);
    expect(await list({ exposed: "content", since: daysAgo(2) }))
        .toEqual([records[2], records[1]]);
    expect(await list({ exposed: "metadata" })).toEqual([records[3]]);
    expect(await list({ kind: "setting", exposed: "metadata" })).toEqual([]);
    expect(await list({ kind: "setting", exposed: "content" })).toEqual([]);
  });

  it("pages with a cursor, and rejects a malformed cursor or an over-long filter", async () => {
    let log = auditLog();
    let records = Array.from({ length: 5 }, (_, i) => access({ args: { i } }));
    for (let record of records) await log.append(record, RETENTION);

    let first = await log.list({ limit: 2 }, RETENTION);
    expect(first.records).toEqual([records[4], records[3]]);
    let second = await log.list({ limit: 2, cursor: first.nextCursor }, RETENTION);
    expect(second.records).toEqual([records[2], records[1]]);
    let last = await log.list({ limit: 2, cursor: second.nextCursor }, RETENTION);
    expect(last.records).toEqual([records[0]]);
    expect(last.nextCursor).toBeUndefined();

    for (let cursor of ["abc", "-1", "1.5", "99999999999999999999"]) {
      await expectRejection(log.list({ limit: 2, cursor }, RETENTION), "Invalid cursor.");
    }
    await expectRejection(log.list({ limit: 2, admin: "a".repeat(1001) }, RETENTION),
        "Audit filters must be at most 1000 characters.");
    await expectRejection(log.list({ limit: 2, workspace: "w".repeat(1001) }, RETENTION),
        "Audit filters must be at most 1000 characters.");
  });

  it("filters by method through its index, paging within the filter", async () => {
    let log = auditLog();
    let names = Array.from({ length: 3 }, (_, i) => setting({ admin: i === 1 ? "grace" : "ada" }));
    let signups = setting({ method: "setSignupsEnabled",
      changes: [{ setting: "signupsEnabled", before: "true", after: "false" }] });
    for (let record of [names[0], signups, names[1], names[2]]) {
      await log.append(record, RETENTION);
    }

    let first = await log.list({ limit: 2, method: "setSiteName" }, RETENTION);
    expect(first.records).toEqual([names[2], names[1]]);
    let second = await log.list(
        { limit: 2, method: "setSiteName", cursor: first.nextCursor }, RETENTION);
    expect(second.records).toEqual([names[0]]);
    expect(second.nextCursor).toBeUndefined();
    expect((await log.list({ limit: 50, method: "setSignupsEnabled" }, RETENTION)).records)
        .toEqual([signups]);
    expect((await log.list({ limit: 50, method: "setSiteName", admin: "grace" }, RETENTION))
        .records).toEqual([names[1]]);

    let plan = await sql<{ detail: string }>(log, `EXPLAIN QUERY PLAN SELECT seq FROM admin_audit
        WHERE json_extract(record, '$.method') = 'setSiteName' ORDER BY seq DESC`);
    expect(plan.map(step => step.detail).join("\n")).toContain("admin_audit_method");
  });

  it("filters by the user a record's target belongs to, through its index", async () => {
    let log = auditLog();
    let records: AdminAuditRecord[] = [
      access({ workspaceOwner: "ada" }),
      access({ workspaceOwner: "grace", workspaceId: "w2" }),
      userAccess({ userId: "grace", admin: "linus" }),
      userAccess({ userId: "ada" }),
      access({ workspaceOwner: "grace", workspaceId: "w3", exposed: "content" }),
      userAccess({
        userId: "grace", method: "listBlueprints", requested: "full", access: "full",
        exposed: "content",
      }),
      setting(),
    ];
    for (let record of records) await log.append(record, RETENTION);

    let list = async (query: object) =>
        (await log.list({ limit: 50, ...query }, RETENTION)).records;
    // Grace's account and the workspaces she owns, newest first.
    expect(await list({ owner: "grace" }))
        .toEqual([records[5], records[4], records[2], records[1]]);
    expect(await list({ owner: "grace", kind: "user" })).toEqual([records[5], records[2]]);
    expect(await list({ owner: "grace", kind: "workspace" })).toEqual([records[4], records[1]]);
    expect(await list({ owner: "grace", kind: "setting" })).toEqual([]);
    expect(await list({ owner: "grace", exposed: "content" })).toEqual([records[5], records[4]]);
    expect(await list({ owner: "grace", admin: "linus" })).toEqual([records[2]]);
    expect(await list({ owner: "linus" })).toEqual([]);
    await expectRejection(log.list({ limit: 2, owner: "a".repeat(1001) }, RETENTION),
        "Audit filters must be at most 1000 characters.");

    let plan = await sql<{ detail: string }>(log, `EXPLAIN QUERY PLAN SELECT seq FROM admin_audit
        WHERE coalesce(json_extract(record, '$.userId'), json_extract(record, '$.workspaceOwner'))
            = 'grace' ORDER BY seq DESC`);
    expect(plan.map(step => step.detail).join("\n")).toContain("admin_audit_target");
  });

  it("lists access to users' accounts by kind, and by a method name both views share", async () => {
    let log = auditLog();
    let records: AdminAuditRecord[] = [
      access({ method: "describe" }),
      userAccess({ method: "describe" }),
      userAccess({ method: "listSessions" }),
      access({ method: "listFiles", args: { path: "src" } }),
      setting(),
    ];
    for (let record of records) await log.append(record, RETENTION);

    let list = async (query: object) =>
        (await log.list({ limit: 50, ...query }, RETENTION)).records;
    expect(await list({ kind: "user" })).toEqual([records[2], records[1]]);
    expect(await list({ method: "describe" })).toEqual([records[1], records[0]]);
    expect(await list({ method: "describe", kind: "user" })).toEqual([records[1]]);
    expect(await list({ method: "describe", kind: "workspace" })).toEqual([records[0]]);
    expect(await list({ method: "listSessions" })).toEqual([records[2]]);
    // A user record names no workspace, so the workspace filter never matches one.
    expect(await list({ workspace: "w1" })).toEqual([records[3], records[0]]);
    expect(await list({ workspace: "w1", kind: "user" })).toEqual([]);
    expect(await list({ workspace: "grace" })).toEqual([]);
  });
});

describe("AdminAuditDurableObject retention", () => {
  it("hides and deletes records older than the retention", async () => {
    let log = auditLog();
    await log.append(access({ at: daysAgo(RETENTION + 10) }), RETENTION);
    let kept = access({ at: daysAgo(RETENTION - 10) });
    await log.append(kept, RETENTION);

    expect((await log.list({ limit: 10 }, RETENTION)).records).toEqual([kept]);
    expect(await sql(log, "SELECT seq FROM admin_audit")).toHaveLength(1);
  });

  it("stores a record given no retention without pruning", async () => {
    let log = auditLog();
    let old = access({ at: daysAgo(RETENTION + 10) });
    await log.append(old, RETENTION + 30);
    await log.append(access(), undefined);
    expect(await sql(log, "SELECT seq FROM admin_audit")).toHaveLength(2);
    expect((await log.list({ limit: 10 }, RETENTION + 30)).records).toHaveLength(2);
  });

  it("keeps records inside the deployment's floor whatever retention it is passed", async () => {
    let log = auditLog();
    let record = access({ at: daysAgo(30) });
    await log.append(record, 1);
    expect((await log.list({ limit: 10 }, 1)).records).toEqual([record]);
    await expectRejection(log.list({ limit: 10 }, 0), "at least 1");
  });

  it("keeps longer than the floor when the retention says", async () => {
    let log = auditLog();
    let record = setting({ at: daysAgo(RETENTION + 30) });
    await log.append(record, RETENTION + 60);
    expect((await log.list({ limit: 10 }, RETENTION + 60)).records).toEqual([record]);
    expect((await log.stats({ days: 366 }, RETENTION + 60)).totalEvents).toBe(1);
    // The same window under the floor's retention counts nothing there.
    expect((await log.stats({ days: 366 }, RETENTION)).totalEvents).toBe(0);
  });
});

describe("AdminAuditDurableObject schema", () => {
  it("rejects a record of an unknown kind", async () => {
    let log = auditLog();
    let bogus = { ...setting(), kind: "bogus" } as unknown as AdminAuditRecord;
    await expectRejection(log.append(bogus, RETENTION), "CHECK constraint failed");
  });

  it("ties the workspace columns to records of access to a workspace", async () => {
    let log = auditLog();
    // Each row carries the `exposed` its kind needs, so that it breaks only the CHECK it targets.
    await expectRejection(insertRow(log, "workspace", null, "t", "metadata"),
        "CHECK constraint failed");
    await expectRejection(insertRow(log, "workspace", "w1", null, "metadata"),
        "CHECK constraint failed");
    await expectRejection(insertRow(log, "user", "w1", "t", "metadata"),
        "CHECK constraint failed");
    await expectRejection(insertRow(log, "setting", "w1", "t", null), "CHECK constraint failed");
    await expectRejection(
        sql(log, `INSERT INTO admin_audit (at, kind, admin, record) VALUES (0, 'setting', 'a', '{')`),
        "CHECK constraint failed");
    await insertRow(log, "workspace", "w1", "t", "metadata");
    await insertRow(log, "user", null, null, "metadata");
    await insertRow(log, "setting", null, null, null);
    expect(await sql(log, "SELECT seq FROM admin_audit")).toHaveLength(3);
  });

  it("ties exposed to access records, of a workspace and of a user's account", async () => {
    let log = auditLog();
    await expectRejection(insertRow(log, "workspace", "w1", "t", null), "CHECK constraint failed");
    await expectRejection(insertRow(log, "user", null, null, null), "CHECK constraint failed");
    await expectRejection(insertRow(log, "setting", null, null, "metadata"),
        "CHECK constraint failed");
    await expectRejection(insertRow(log, "workspace", "w1", "t", "bogus"),
        "CHECK constraint failed");
    await expectRejection(insertRow(log, "user", null, null, "bogus"), "CHECK constraint failed");
    let { exposed: _exposed, ...unexposed } = access();
    await expectRejection(log.append(unexposed as AdminAccessRecord, RETENTION),
        "CHECK constraint failed");
    let { exposed: _userExposed, ...unexposedUser } = userAccess();
    await expectRejection(log.append(unexposedUser as AdminUserAccessRecord, RETENTION),
        "CHECK constraint failed");
    expect(await sql(log, "SELECT seq FROM admin_audit")).toHaveLength(0);
  });

  it("keeps a long user id as a long owner is kept, and finds its account and workspaces by it",
      async () => {
    let log = auditLog();
    let ada = `${"u".repeat(600)}a`;
    let grace = `${"u".repeat(600)}g`;
    for (let userId of [ada, grace]) await log.append(userAccess({ userId }), RETENTION);
    // A workspace this long id owns is found with the account, by either form of the id.
    await log.append(access({ workspaceOwner: grace }), RETENTION);

    let kept = (await log.list({ limit: 50, kind: "user" }, RETENTION)).records
        .map(r => (r as AdminUserAccessRecord).userId);
    expect(kept.every(userId => userId.length === MAX_ADMIN_AUDIT_ARG_LENGTH)).toBe(true);
    expect(new Set(kept).size).toBe(2);
    expect(kept[0]).toMatch(/^u+…#[0-9a-f]{20}$/);
    for (let [userId, stored, kinds] of
        [[ada, kept[1], ["user"]], [grace, kept[0], ["workspace", "user"]]] as const) {
      let byWhole = (await log.list({ limit: 50, owner: userId }, RETENTION)).records;
      expect(byWhole.map(r => r.kind)).toEqual(kinds);
      for (let record of byWhole) {
        let target = record.kind === "user" ? record.userId
            : (record as AdminAccessRecord).workspaceOwner;
        expect(target).toBe(stored);
      }
      expect((await log.list({ limit: 50, owner: stored }, RETENTION)).records).toEqual(byWhole);
    }
    let [{ size }] = await sql<{ size: number }>(log,
        "SELECT max(length(record)) AS size FROM admin_audit");
    expect(size).toBeLessThan(10_000);
  });

  it("keeps a long owner short, apart from another sharing its start, and finds it by its whole id",
      async () => {
    let log = auditLog();
    let ada = `${"o".repeat(600)}a`;
    let grace = `${"o".repeat(600)}g`;
    let huge = "o".repeat(800_000);
    for (let owner of [ada, grace, huge]) await log.append(access({ workspaceOwner: owner }), RETENTION);

    let kept = (await log.list({ limit: 50 }, RETENTION)).records
        .map(r => (r as AdminAccessRecord).workspaceOwner);
    expect(kept.every(owner => owner.length === MAX_ADMIN_AUDIT_ARG_LENGTH)).toBe(true);
    expect(new Set(kept).size).toBe(3);
    expect(kept[2]).toMatch(/^o+…#[0-9a-f]{20}$/);
    for (let [owner, stored] of [[ada, kept[2]], [grace, kept[1]]]) {
      let byWhole = (await log.list({ limit: 50, owner }, RETENTION)).records;
      expect(byWhole.map(r => (r as AdminAccessRecord).workspaceOwner)).toEqual([stored]);
      expect((await log.list({ limit: 50, owner: stored }, RETENTION)).records).toEqual(byWhole);
    }
    let [{ size }] = await sql<{ size: number }>(log,
        "SELECT max(length(record)) AS size FROM admin_audit");
    expect(size).toBeLessThan(10_000);
  });

  it("stores an over-long title cut, once, whatever the caller sent", async () => {
    let log = auditLog();
    let title = "t".repeat(3 * 2 ** 20);
    await log.append(access({ workspaceTitle: title }), RETENTION);

    let [record] = (await log.list({ limit: 1 }, RETENTION)).records as AdminAccessRecord[];
    expect(record.workspaceTitle).toHaveLength(MAX_ADMIN_AUDIT_ARG_LENGTH);
    expect(record.workspaceTitle.endsWith("…")).toBe(true);
    let [{ size }] = await sql<{ size: number }>(log,
        "SELECT length(record) + length(workspace_title) AS size FROM admin_audit");
    expect(size).toBeLessThan(10_000);
  });
});

describe("AdminAuditDurableObject.stats", () => {
  it("counts every UTC day of the window, oldest first, empty days included", async () => {
    let log = auditLog();
    let recent = [new Date(), new Date(), daysAgo(2)];
    for (let at of recent) await log.append(access({ at }), RETENTION);
    await log.append(setting({ at: daysAgo(20) }), RETENTION);

    let stats = await log.stats({ days: 7 }, RETENTION);
    expect(stats.days).toBe(7);
    expect(stats.byDay).toHaveLength(7);
    // Consecutive days, derived from the returned keys rather than a mocked clock.
    for (let i = 1; i < 7; i++) {
      expect(Date.parse(stats.byDay[i].day) - Date.parse(stats.byDay[i - 1].day)).toBe(DAY_MS);
    }
    let expected = new Map<string, number>();
    for (let at of recent) expected.set(utcDayKey(at), (expected.get(utcDayKey(at)) ?? 0) + 1);
    for (let { day, count } of stats.byDay) expect(count, day).toBe(expected.get(day) ?? 0);
    expect(stats.totalEvents).toBe(3);
    expect(stats.byDay.filter(d => d.count === 0).length).toBeGreaterThanOrEqual(4);

    expect((await log.stats({ days: 30 }, RETENTION)).totalEvents).toBe(4);
  });

  it("orders the top admins by count, then by id, counting both kinds of record", async () => {
    let log = auditLog();
    let records: AdminAuditRecord[] = [
      access({ admin: "grace" }),
      access({ admin: "grace" }),
      access({ admin: "ada" }),
      access({ admin: "linus" }),
      setting({ admin: "ada" }),
    ];
    for (let record of records) await log.append(record, RETENTION);

    let stats = await log.stats({ days: 7 }, RETENTION);
    expect(stats.totalEvents).toBe(5);
    expect(stats.topAdmins).toEqual([
      { admin: "ada", count: 2, contentReads: 0 }, { admin: "grace", count: 2, contentReads: 0 },
      { admin: "linus", count: 1, contentReads: 0 },
    ]);
  });

  it("filters by kind", async () => {
    let log = auditLog();
    await log.append(access({ admin: "ada" }), RETENTION);
    await log.append(setting({ admin: "grace" }), RETENTION);
    await log.append(setting({ admin: "grace" }), RETENTION);

    let settings = await log.stats({ days: 7, kind: "setting" }, RETENTION);
    expect(settings.totalEvents).toBe(2);
    expect(settings.topAdmins).toEqual([{ admin: "grace", count: 2, contentReads: 0 }]);

    let workspaces = await log.stats({ days: 7, kind: "workspace" }, RETENTION);
    expect(workspaces.totalEvents).toBe(1);
    expect(workspaces.topAdmins).toEqual([{ admin: "ada", count: 1, contentReads: 0 }]);
  });

  it("counts nothing past the retention, however long the window", async () => {
    let log = auditLog();
    await log.append(access({ at: daysAgo(RETENTION + 5), exposed: "content" }), RETENTION);
    await log.append(access({ at: daysAgo(5) }), RETENTION);
    await log.append(access({ at: daysAgo(5), admin: "grace", exposed: "content" }), RETENTION);
    let stats = await log.stats({ days: 366 }, RETENTION);
    expect(stats.totalEvents).toBe(2);
    expect(stats.byDay).toHaveLength(366);
    expect(stats.contentReads).toBe(1);
    expect(stats.topAdmins).toEqual([
      { admin: "ada", count: 1, contentReads: 0 }, { admin: "grace", count: 1, contentReads: 1 },
    ]);
  });

  it("counts the content reads in the window", async () => {
    let log = auditLog();
    await log.append(access({ exposed: "content" }), RETENTION);
    await log.append(access({ exposed: "content", at: daysAgo(2) }), RETENTION);
    await log.append(access({ exposed: "content", at: daysAgo(20) }), RETENTION);
    await log.append(access(), RETENTION);
    // A day holding only a setting record counts no content read.
    await log.append(setting({ at: daysAgo(4) }), RETENTION);

    let stats = await log.stats({ days: 7 }, RETENTION);
    expect(stats.totalEvents).toBe(4);
    expect(stats.contentReads).toBe(2);
    expect((await log.stats({ days: 30 }, RETENTION)).contentReads).toBe(3);
  });

  it("counts each top admin's content reads, ranking by every record", async () => {
    let log = auditLog();
    let records: AdminAuditRecord[] = [
      access({ admin: "grace", workspaceId: "w2", exposed: "content" }),
      access({ admin: "grace", workspaceId: "w2", exposed: "content" }),
      access({ admin: "ada", workspaceId: "w3", exposed: "content" }),
      access({ admin: "linus", workspaceId: "w1", exposed: "content" }),
      // Many calls exposing nothing rank first, with no content read.
      ...Array.from({ length: 5 }, () => access({ admin: "zed", workspaceId: "w9" })),
      setting({ admin: "ada" }),
    ];
    for (let record of records) await log.append(record, RETENTION);

    let stats = await log.stats({ days: 7 }, RETENTION);
    expect(stats.contentReads).toBe(4);
    expect(stats.topAdmins).toEqual([
      { admin: "zed", count: 5, contentReads: 0 }, { admin: "ada", count: 2, contentReads: 1 },
      { admin: "grace", count: 2, contentReads: 2 }, { admin: "linus", count: 1, contentReads: 1 },
    ]);

    let many = auditLog();
    for (let i = 0; i < 12; i++) {
      let id = String(i).padStart(2, "0");
      await many.append(
          access({ admin: `a${id}`, workspaceId: `w${id}`, exposed: "content" }), RETENTION);
    }
    let capped = await many.stats({ days: 7 }, RETENTION);
    expect(capped.contentReads).toBe(12);
    expect(capped.topAdmins.map(a => a.admin))
        .toEqual(Array.from({ length: 10 }, (_, i) => `a${String(i).padStart(2, "0")}`));
  });

  it("filters the content reads by kind", async () => {
    let log = auditLog();
    await log.append(access({ admin: "ada", exposed: "content" }), RETENTION);
    await log.append(access({ admin: "grace", workspaceId: "w2" }), RETENTION);
    await log.append(setting({ admin: "grace" }), RETENTION);

    let settings = await log.stats({ days: 7, kind: "setting" }, RETENTION);
    expect(settings.contentReads).toBe(0);
    expect(settings.topAdmins).toEqual([{ admin: "grace", count: 1, contentReads: 0 }]);

    let all = await log.stats({ days: 7 }, RETENTION);
    let workspaces = await log.stats({ days: 7, kind: "workspace" }, RETENTION);
    expect(all.contentReads).toBe(1);
    expect(all.topAdmins).toEqual([
      { admin: "grace", count: 2, contentReads: 0 }, { admin: "ada", count: 1, contentReads: 1 },
    ]);
    expect(workspaces.contentReads).toBe(all.contentReads);
    expect(workspaces.topAdmins).toEqual([
      { admin: "ada", count: 1, contentReads: 1 }, { admin: "grace", count: 1, contentReads: 0 },
    ]);
  });

  it("counts access to users' accounts, its content reads included, and filters by its kind",
      async () => {
    let log = auditLog();
    let records: AdminAuditRecord[] = [
      userAccess({ admin: "ada" }),
      userAccess({
        admin: "ada", method: "listConnectedAccounts", requested: "full", access: "full",
        exposed: "content",
      }),
      userAccess({ admin: "grace", at: daysAgo(2) }),
      access({ admin: "grace", exposed: "content" }),
      setting({ admin: "linus" }),
    ];
    for (let record of records) await log.append(record, RETENTION);

    let all = await log.stats({ days: 7 }, RETENTION);
    expect(all.totalEvents).toBe(5);
    expect(all.contentReads).toBe(2);
    expect(all.topAdmins).toEqual([
      { admin: "ada", count: 2, contentReads: 1 }, { admin: "grace", count: 2, contentReads: 1 },
      { admin: "linus", count: 1, contentReads: 0 },
    ]);
    let expected = new Map<string, number>();
    for (let { at } of records) expected.set(utcDayKey(at), (expected.get(utcDayKey(at)) ?? 0) + 1);
    for (let { day, count } of all.byDay) expect(count, day).toBe(expected.get(day) ?? 0);

    let users = await log.stats({ days: 7, kind: "user" }, RETENTION);
    expect(users.totalEvents).toBe(3);
    expect(users.contentReads).toBe(1);
    expect(users.topAdmins).toEqual([
      { admin: "ada", count: 2, contentReads: 1 }, { admin: "grace", count: 1, contentReads: 0 },
    ]);
    expect(users.byDay.reduce((sum, { count }) => sum + count, 0)).toBe(3);

    let workspaces = await log.stats({ days: 7, kind: "workspace" }, RETENTION);
    expect([workspaces.totalEvents, workspaces.contentReads]).toEqual([1, 1]);
    let settings = await log.stats({ days: 7, kind: "setting" }, RETENTION);
    expect([settings.totalEvents, settings.contentReads]).toEqual([1, 0]);
  });
});

// The table and indexes of a build whose log knows only workspace and setting records, statement
// for statement, and the index a build that filters by workspace owner alone adds beside them.
const TWO_KIND_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS admin_audit (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('workspace', 'setting')),
      admin TEXT NOT NULL,
      workspace_id TEXT,
      workspace_title TEXT,
      exposed TEXT CHECK (exposed IN ('metadata', 'content')),
      record TEXT NOT NULL CHECK (json_valid(record)),
      CHECK ((kind = 'workspace') = (workspace_id IS NOT NULL AND workspace_title IS NOT NULL)),
      CHECK ((kind = 'workspace') = (exposed IS NOT NULL))
    ) STRICT`,
  "CREATE INDEX IF NOT EXISTS admin_audit_at ON admin_audit (at)",
  "CREATE INDEX IF NOT EXISTS admin_audit_admin ON admin_audit (admin, seq)",
  "CREATE INDEX IF NOT EXISTS admin_audit_workspace ON admin_audit (workspace_id, seq)",
  "CREATE INDEX IF NOT EXISTS admin_audit_kind ON admin_audit (kind, seq)",
  "CREATE INDEX IF NOT EXISTS admin_audit_exposed ON admin_audit (exposed, seq)",
  `CREATE INDEX IF NOT EXISTS admin_audit_method
      ON admin_audit (json_extract(record, '$.method'), seq)`,
];
const OWNER_INDEX = `CREATE INDEX IF NOT EXISTS admin_audit_owner
    ON admin_audit (json_extract(record, '$.workspaceOwner'), seq)`;
const USER_ROW = `INSERT INTO admin_audit (at, kind, admin, exposed, record)
    VALUES (0, 'user', 'ada', 'metadata', '{"userId":"grace"}')`;

type StoredRow = Record<string, SqlStorageValue> & { seq: number };
type SchemaRow = { type: string; name: string; sql: string | null };

function storedRows(db: SqlStorage): StoredRow[] {
  return db.exec<StoredRow>("SELECT * FROM admin_audit ORDER BY seq").toArray();
}

// What a run of the constructor can change: the log's rows, what sqlite_master holds of it (its
// table, its indexes and anything a rebuild left behind), and the count of rows written so far,
// which a rebuild's copy moves and a statement that finds nothing to do leaves alone.
function snapshot(db: SqlStorage) {
  return {
    rows: storedRows(db),
    schema: db.exec<SchemaRow>(
        "SELECT type, name, sql FROM sqlite_master WHERE name LIKE 'admin#_audit%' ESCAPE '#' " +
            "ORDER BY name").toArray(),
    changes: db.exec<{ n: number }>("SELECT total_changes() AS n").one().n,
  };
}

function schemaNames(schema: SchemaRow[]): string[] {
  return schema.map(row => row.name);
}

// The stored table's definition from its opening parenthesis, the part a rename leaves alone.
function tableDefinition(schema: SchemaRow[]): string {
  let text = schema.find(row => row.name === "admin_audit")!.sql!;
  return text.slice(text.indexOf("("));
}

// Drops the table and makes it again with `statements`, holding the same rows under the same seqs.
function replant(db: SqlStorage, statements: string[]): void {
  let rows = storedRows(db);
  db.exec("DROP TABLE admin_audit");
  for (let statement of statements) db.exec(statement);
  for (let row of rows) {
    db.exec(`INSERT INTO admin_audit
        (seq, at, kind, admin, workspace_id, workspace_title, exposed, record)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        row.seq, row.at, row.kind, row.admin, row.workspace_id, row.workspace_title, row.exposed,
        row.record);
  }
}

// Runs the object's constructor again over its stored state, as the next start does.
function construct(instance: AdminAuditDurableObject, state: DurableObjectState)
    : AdminAuditDurableObject {
  let Log = instance.constructor as
      new (ctx: DurableObjectState, env: Cloudflare.Env) => AdminAuditDurableObject;
  return new Log(state, env);
}

// A log of workspace and setting records with a gap in their seqs, so that a copy renumbering
// them shows, and what it lists.
async function seededLog(): Promise<{ log: Stub; listed: AdminAuditRecord[] }> {
  let log = auditLog();
  let records = [
    access({ at: daysAgo(3) }), setting({ at: daysAgo(2) }), setting({ at: daysAgo(2) }),
    access({
      method: "getChat", args: { chatId: 4 }, requested: "full", access: "full", exposed: "content",
    }),
    setting(),
  ];
  for (let record of records) await log.append(record, RETENTION);
  await sql(log, "DELETE FROM admin_audit WHERE seq = 2");
  return { log, listed: (await log.list({ limit: 50 }, RETENTION)).records };
}

// Plants `statements`' table under a seeded log's rows, constructs the object again, and checks
// that the log holds the same rows in a table of the current definition, which takes a user record
// and which the start after that one leaves alone.
async function expectRebuilt(statements: string[]): Promise<void> {
  let { log, listed } = await seededLog();
  let [seeded, rebuilt, restarted] = await runInDurableObject(log, (instance, state) => {
    let db = state.storage.sql;
    let start = snapshot(db);
    replant(db, statements);
    expect(storedRows(db)).toEqual(start.rows);
    expect(() => db.exec(USER_ROW)).toThrow("CHECK constraint failed");
    construct(instance, state);
    let afterRebuild = snapshot(db);
    construct(instance, state);
    return [start, afterRebuild, snapshot(db)];
  });

  expect(seeded.rows.map(row => row.seq)).toEqual([1, 3, 4, 5]);
  expect(rebuilt.rows).toEqual(seeded.rows);
  // The rename stores the table's name quoted, which a start must still read as the current
  // definition: one that did not would copy the whole log again, moving the count of rows written.
  expect(restarted).toEqual(rebuilt);
  // The stored definition is a fresh log's from its parenthesis on, under the same indexes.
  expect(schemaNames(rebuilt.schema)).toEqual(schemaNames(seeded.schema));
  expect(schemaNames(rebuilt.schema)).toContain("admin_audit_target");
  expect(schemaNames(rebuilt.schema)).not.toContain("admin_audit_owner");
  expect(schemaNames(rebuilt.schema)).not.toContain("admin_audit_next");
  expect(tableDefinition(rebuilt.schema)).toBe(tableDefinition(seeded.schema));
  expect((await log.list({ limit: 50 }, RETENTION)).records).toEqual(listed);

  let added = userAccess();
  await log.append(added, RETENTION);
  expect((await log.list({ limit: 50 }, RETENTION)).records).toEqual([added, ...listed]);
  let [{ seq }] = await sql<{ seq: number }>(log,
      "SELECT seq FROM admin_audit WHERE kind = 'user'");
  expect(seq).toBeGreaterThan(5);
}

describe("AdminAuditDurableObject's table rebuild", () => {
  it("rebuilds a table that knows no user records, keeping every row under its seq", async () => {
    await expectRebuilt(TWO_KIND_SCHEMA);
  });

  it("rebuilds one that indexes the workspace owner alone, dropping that index", async () => {
    await expectRebuilt([...TWO_KIND_SCHEMA, OWNER_INDEX]);
  });

  it("leaves a table of the current definition alone", async () => {
    let { log, listed } = await seededLog();
    let [seeded, constructed] = await runInDurableObject(log, (instance, state) => {
      let start = snapshot(state.storage.sql);
      construct(instance, state);
      return [start, snapshot(state.storage.sql)];
    });
    expect(seeded.rows).toHaveLength(4);
    expect(constructed).toEqual(seeded);
    expect((await log.list({ limit: 50 }, RETENTION)).records).toEqual(listed);
  });

  it("drops the workspace-owner index from a table of the current definition without rebuilding it",
      async () => {
    let { log, listed } = await seededLog();
    let [seeded, indexed, constructed] = await runInDurableObject(log, (instance, state) => {
      let db = state.storage.sql;
      let start = snapshot(db);
      db.exec(OWNER_INDEX);
      let withIndex = snapshot(db);
      construct(instance, state);
      return [start, withIndex, snapshot(db)];
    });
    expect(schemaNames(indexed.schema)).toContain("admin_audit_owner");
    expect(constructed).toEqual({ ...seeded, changes: indexed.changes });
    expect((await log.list({ limit: 50 }, RETENTION)).records).toEqual(listed);
  });

  it("keeps a table of a later definition, whose rows it cannot copy, logs that, and still appends",
      async () => {
    let log = auditLog();
    let { planted, constructed, events } = await runInDurableObject(log, (instance, state) => {
      let db = state.storage.sql;
      let current = tableDefinition(snapshot(db).schema);
      let later = current.replace("'user', 'setting')", "'user', 'setting', 'later')");
      expect(later).not.toBe(current);
      db.exec("DROP TABLE admin_audit");
      db.exec(`CREATE TABLE admin_audit ${later}`);
      db.exec(`INSERT INTO admin_audit (at, kind, admin, exposed, record)
          VALUES (?1, 'setting', 'ada', NULL, '{}'), (?1, 'later', 'ada', 'metadata', '{}')`,
          Date.now());
      let planted = snapshot(db);
      // The log is the only sign that this table refuses what the build's own would take.
      let logged = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        construct(instance, state);
        let events = logged.mock.calls.map(([entry]) => (entry as { event?: unknown })?.event);
        return { planted, constructed: snapshot(db), events };
      } finally {
        logged.mockRestore();
      }
    });

    expect(events).toEqual(["admin.audit.table.rebuild.failed"]);
    expect(planted.rows.map(row => [row.seq, row.kind])).toEqual([[1, "setting"], [2, "later"]]);
    expect(constructed.rows).toEqual(planted.rows);
    expect(schemaNames(constructed.schema)).not.toContain("admin_audit_next");
    expect(tableDefinition(constructed.schema)).toBe(tableDefinition(planted.schema));
    for (let record of [access(), userAccess(), setting()]) await log.append(record, RETENTION);
    expect(await sql(log, "SELECT kind FROM admin_audit ORDER BY seq")).toEqual(
        ["setting", "later", "workspace", "user", "setting"].map(kind => ({ kind })));
  });
});
