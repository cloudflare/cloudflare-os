import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { type AdminAuditRecord, type AdminSettingRecord } from "@gadgets/workshop-shared/api";
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

// A workspace access row written as of now, as the stacked inspection change appends them, so that
// a kind filter has another kind to leave out.
function insertAccessRow(stub: Stub, admin: string): Promise<unknown[]> {
  return sql(stub, `INSERT INTO admin_audit
      (at, kind, admin, workspace_id, workspace_title, exposed, record)
      VALUES (?, 'workspace', ?, 'w1', 'Plans', 'metadata', '{}')`, Date.now(), admin);
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
    let first = setting({ at: daysAgo(2) });
    let second = setting({ at: daysAgo(1), method: "setSignupsEnabled",
      changes: [{ setting: "signupsEnabled", before: "true", after: "false" }] });
    let third = setting({ method: "setBanner", changes: [
      { setting: "banner", key: "message", after: "Maintenance tonight" },
      { setting: "banner", key: "color", before: "blue", after: "red" },
    ] });
    let fourth = setting({ via: "api", sessionId: "session-2" });
    for (let record of [first, second, third, fourth]) await log.append(record, RETENTION);

    let page = await log.list({ limit: 10 }, RETENTION);
    expect(page.records).toEqual([fourth, third, second, first]);
    expect(page.nextCursor).toBeUndefined();
  });

  it("stores each field once", async () => {
    let log = auditLog();
    await log.append(setting(), RETENTION);
    let rows = await sql<
        { kind: string; workspace_id: string | null; exposed: string | null; record: string }>(log,
        "SELECT kind, workspace_id, exposed, record FROM admin_audit ORDER BY seq");
    expect(rows.map(row => [row.kind, row.workspace_id, row.exposed]))
        .toEqual([["setting", null, null]]);
    let json = JSON.parse(rows[0].record);
    for (let field of ["kind", "at", "admin"]) expect(json, field).not.toHaveProperty(field);
  });

  it("combines the kind, admin and since filters", async () => {
    let log = auditLog();
    let records: AdminAuditRecord[] = [
      setting({ admin: "ada", at: daysAgo(3) }),
      setting({ admin: "grace", at: daysAgo(1) }),
      setting({ admin: "ada", at: daysAgo(1) }),
    ];
    for (let record of records) await log.append(record, RETENTION);

    let list = async (query: object) =>
        (await log.list({ limit: 50, ...query }, RETENTION)).records;
    await insertAccessRow(log, "ada");
    expect(await list({ kind: "setting", admin: "ada" })).toEqual([records[2], records[0]]);
    expect((await list({ admin: "ada", since: daysAgo(2) })).map(record => record.kind))
        .toEqual(["workspace", "setting"]);
    expect(await list({ admin: "linus" })).toEqual([]);
  });

  it("pages with a cursor, and rejects a malformed cursor or an over-long filter", async () => {
    let log = auditLog();
    let records = Array.from({ length: 5 },
        (_, i) => setting({ changes: [{ setting: "siteName", after: `Site ${i}` }] }));
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
});

describe("AdminAuditDurableObject retention", () => {
  it("hides and deletes records older than the retention", async () => {
    let log = auditLog();
    await log.append(setting({ at: daysAgo(RETENTION + 10) }), RETENTION);
    let kept = setting({ at: daysAgo(RETENTION - 10) });
    await log.append(kept, RETENTION);

    expect((await log.list({ limit: 10 }, RETENTION)).records).toEqual([kept]);
    expect(await sql(log, "SELECT seq FROM admin_audit")).toHaveLength(1);
  });

  it("keeps records inside the deployment's floor whatever retention it is passed", async () => {
    let log = auditLog();
    let record = setting({ at: daysAgo(30) });
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

  it("ties the workspace columns to access records", async () => {
    let log = auditLog();
    // Each row carries the `exposed` its kind needs, so that it breaks only the CHECK it targets.
    await expectRejection(insertRow(log, "workspace", null, "t", "metadata"),
        "CHECK constraint failed");
    await expectRejection(insertRow(log, "workspace", "w1", null, "metadata"),
        "CHECK constraint failed");
    await expectRejection(insertRow(log, "setting", "w1", "t", null), "CHECK constraint failed");
    await expectRejection(
        sql(log, `INSERT INTO admin_audit (at, kind, admin, record) VALUES (0, 'setting', 'a', '{')`),
        "CHECK constraint failed");
    await insertRow(log, "workspace", "w1", "t", "metadata");
    await insertRow(log, "setting", null, null, null);
    expect(await sql(log, "SELECT seq FROM admin_audit")).toHaveLength(2);
  });

  it("ties exposed to access records", async () => {
    let log = auditLog();
    await expectRejection(insertRow(log, "workspace", "w1", "t", null), "CHECK constraint failed");
    await expectRejection(insertRow(log, "setting", null, null, "metadata"),
        "CHECK constraint failed");
    await expectRejection(insertRow(log, "workspace", "w1", "t", "bogus"),
        "CHECK constraint failed");
    expect(await sql(log, "SELECT seq FROM admin_audit")).toHaveLength(0);
  });

});

describe("AdminAuditDurableObject.stats", () => {
  it("counts every UTC day of the window, oldest first, empty days included", async () => {
    let log = auditLog();
    let recent = [new Date(), new Date(), daysAgo(2)];
    for (let at of recent) await log.append(setting({ at }), RETENTION);
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

  it("orders the top admins by count, then by id", async () => {
    let log = auditLog();
    let records: AdminAuditRecord[] = [
      setting({ admin: "grace" }),
      setting({ admin: "grace" }),
      setting({ admin: "ada" }),
      setting({ admin: "linus" }),
      setting({ admin: "ada" }),
    ];
    for (let record of records) await log.append(record, RETENTION);

    let stats = await log.stats({ days: 7 }, RETENTION);
    expect(stats.totalEvents).toBe(5);
    expect(stats.topAdmins).toEqual([
      { admin: "ada", count: 2 }, { admin: "grace", count: 2 }, { admin: "linus", count: 1 },
    ]);
  });

  it("filters by kind", async () => {
    let log = auditLog();
    await log.append(setting({ admin: "grace" }), RETENTION);
    await log.append(setting({ admin: "grace" }), RETENTION);
    await insertAccessRow(log, "ada");

    let settings = await log.stats({ days: 7, kind: "setting" }, RETENTION);
    expect(settings.totalEvents).toBe(2);
    expect(settings.topAdmins).toEqual([{ admin: "grace", count: 2 }]);
    expect((await log.stats({ days: 7 }, RETENTION)).totalEvents).toBe(3);
  });

  it("counts nothing past the retention, however long the window", async () => {
    let log = auditLog();
    await log.append(setting({ at: daysAgo(RETENTION + 5) }), RETENTION);
    await log.append(setting({ at: daysAgo(5) }), RETENTION);
    await log.append(setting({ at: daysAgo(5), admin: "grace" }), RETENTION);
    let stats = await log.stats({ days: 366 }, RETENTION);
    expect(stats.totalEvents).toBe(2);
    expect(stats.byDay).toHaveLength(366);
  });

});
