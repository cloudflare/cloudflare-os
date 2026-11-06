import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  MAX_ADMIN_AUDIT_ARG_LENGTH,
  type AdminAccessRecord, type AdminAuditRecord, type AdminSettingRecord,
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
    let fourth = access({
      method: "getChat", args: { chatId: 4 }, requested: "full", access: "full", exposed: "content",
    });
    for (let record of [first, second, third, fourth]) await log.append(record, RETENTION);

    let page = await log.list({ limit: 10 }, RETENTION);
    expect(page.records).toEqual([fourth, third, second, first]);
    expect(page.nextCursor).toBeUndefined();
  });

  it("stores each field once", async () => {
    let log = auditLog();
    await log.append(access(), RETENTION);
    await log.append(setting(), RETENTION);
    let rows = await sql<
        { kind: string; workspace_id: string | null; exposed: string | null; record: string }>(log,
        "SELECT kind, workspace_id, exposed, record FROM admin_audit ORDER BY seq");
    expect(rows.map(row => [row.kind, row.workspace_id, row.exposed]))
        .toEqual([["workspace", "w1", "metadata"], ["setting", null, null]]);
    for (let row of rows) {
      let json = JSON.parse(row.record);
      for (let field of ["kind", "at", "admin", "workspaceId", "workspaceTitle", "exposed"]) {
        expect(json, field).not.toHaveProperty(field);
      }
    }
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

  it("filters by workspace owner through its index", async () => {
    let log = auditLog();
    let adas = access({ workspaceOwner: "ada" });
    let graces = [access({ workspaceOwner: "grace", workspaceId: "w2" }),
      access({ workspaceOwner: "grace", workspaceId: "w3", exposed: "content" })];
    for (let record of [adas, ...graces, setting()]) await log.append(record, RETENTION);

    expect((await log.list({ limit: 50, owner: "grace" }, RETENTION)).records)
        .toEqual([graces[1], graces[0]]);
    expect((await log.list({ limit: 50, owner: "grace", exposed: "content" }, RETENTION)).records)
        .toEqual([graces[1]]);
    expect((await log.list({ limit: 50, owner: "linus" }, RETENTION)).records).toEqual([]);
    await expectRejection(log.list({ limit: 2, owner: "a".repeat(1001) }, RETENTION),
        "Audit filters must be at most 1000 characters.");

    let plan = await sql<{ detail: string }>(log, `EXPLAIN QUERY PLAN SELECT seq FROM admin_audit
        WHERE json_extract(record, '$.workspaceOwner') = 'grace' ORDER BY seq DESC`);
    expect(plan.map(step => step.detail).join("\n")).toContain("admin_audit_owner");
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
    let { exposed: _exposed, ...unexposed } = access();
    await expectRejection(log.append(unexposed as AdminAccessRecord, RETENTION),
        "CHECK constraint failed");
    expect(await sql(log, "SELECT seq FROM admin_audit")).toHaveLength(0);
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
    let stats = await log.stats({ days: 1 }, RETENTION);
    expect(stats.topWorkspaces).toEqual(
        [{ workspaceId: "w1", title: record.workspaceTitle, count: 1, contentReads: 0 }]);
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

  it("orders the top lists by count, then by id", async () => {
    let log = auditLog();
    let records: AdminAuditRecord[] = [
      access({ admin: "grace", workspaceId: "w2" }),
      access({ admin: "grace", workspaceId: "w2" }),
      access({ admin: "ada", workspaceId: "w3" }),
      access({ admin: "linus", workspaceId: "w1" }),
      setting({ admin: "ada" }),
    ];
    for (let record of records) await log.append(record, RETENTION);

    let stats = await log.stats({ days: 7 }, RETENTION);
    expect(stats.totalEvents).toBe(5);
    expect(stats.topAdmins).toEqual([
      { admin: "ada", count: 2, contentReads: 0 }, { admin: "grace", count: 2, contentReads: 0 },
      { admin: "linus", count: 1, contentReads: 0 },
    ]);
    expect(stats.topWorkspaces.map(w => [w.workspaceId, w.count]))
        .toEqual([["w2", 2], ["w1", 1], ["w3", 1]]);
  });

  it("titles a workspace with its newest non-empty title", async () => {
    let log = auditLog();
    await log.append(access({ workspaceTitle: "First", at: daysAgo(1) }), RETENTION);
    await log.append(access({ workspaceTitle: "Renamed" }), RETENTION);
    await log.append(access({ workspaceTitle: "" }), RETENTION);
    await log.append(access({ workspaceId: "w2", workspaceTitle: "" }), RETENTION);

    let stats = await log.stats({ days: 7 }, RETENTION);
    expect(stats.topWorkspaces).toEqual([
      { workspaceId: "w1", title: "Renamed", count: 3, contentReads: 0 },
      { workspaceId: "w2", title: "", count: 1, contentReads: 0 },
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
    expect(settings.topWorkspaces).toEqual([]);

    let workspaces = await log.stats({ days: 7, kind: "workspace" }, RETENTION);
    expect(workspaces.totalEvents).toBe(1);
    expect(workspaces.topAdmins).toEqual([{ admin: "ada", count: 1, contentReads: 0 }]);
    expect(workspaces.topWorkspaces)
        .toEqual([{ workspaceId: "w1", title: "Plans", count: 1, contentReads: 0 }]);
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
    expect(stats.topWorkspaces)
        .toEqual([{ workspaceId: "w1", title: "Plans", count: 2, contentReads: 1 }]);
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

  it("counts each top admin's and workspace's content reads, ranking by every record", async () => {
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
    expect(stats.topWorkspaces).toEqual([
      { workspaceId: "w9", title: "Plans", count: 5, contentReads: 0 },
      { workspaceId: "w2", title: "Plans", count: 2, contentReads: 2 },
      { workspaceId: "w1", title: "Plans", count: 1, contentReads: 1 },
      { workspaceId: "w3", title: "Plans", count: 1, contentReads: 1 },
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
    expect(capped.topWorkspaces.map(w => w.workspaceId))
        .toEqual(Array.from({ length: 10 }, (_, i) => `w${String(i).padStart(2, "0")}`));
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
    expect(workspaces.topWorkspaces).toEqual(all.topWorkspaces);
  });
});
