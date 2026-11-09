import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  MAX_ADMIN_AUDIT_ARG_LENGTH,
  type AdminAccessRecord, type AdminAuditRecord, type AdminSettingRecord, type AdminWriteRecord,
} from "@gadgets/workshop-shared/api";
import { auditOwnerId, cutAdminAuditText } from "../src/admin-access.js";
import { AdminAuditDurableObject } from "../src/admin-audit.js";
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

function write(overrides: Partial<AdminWriteRecord> = {}): AdminWriteRecord {
  return {
    kind: "write", at: new Date(), admin: "ada", sessionId: "session-1", via: "cli",
    requestId: "request-1", event: "requested", workspaceId: "w1", workspaceOwner: "owner-1",
    workspaceTitle: "Plans", method: "stopAgent", args: { chatId: 4 }, reason: "a stuck turn",
    requestedBy: "ada", ...overrides,
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
    await log.append(write(), RETENTION);
    let rows = await sql<
        { kind: string; workspace_id: string | null; exposed: string | null; record: string }>(log,
        "SELECT kind, workspace_id, exposed, record FROM admin_audit ORDER BY seq");
    expect(rows.map(row => [row.kind, row.workspace_id, row.exposed]))
        .toEqual([["workspace", "w1", "metadata"], ["setting", null, null], ["write", "w1", null]]);
    for (let row of rows) {
      let json = JSON.parse(row.record);
      for (let field of ["kind", "at", "admin", "workspaceId", "workspaceTitle", "exposed"]) {
        expect(json, field).not.toHaveProperty(field);
      }
    }
  });

  it("returns each step of a write as appended, its title cut and a long owner kept short",
      async () => {
    let log = auditLog();
    let passkey = "credential-1";
    let steps: AdminWriteRecord[] = [
      write(),
      write({ event: "refused", admin: "grace", refusal: "signature", passkey }),
      write({ event: "approved", admin: "grace", sessionId: "session-2", via: "api", passkey }),
      write({ event: "applied", admin: "grace", passkey, outcome: "3 rejected, 0 still pending" }),
      write({ event: "failed", admin: "grace", passkey, error: "No such chat." }),
      write({ event: "denied", admin: "grace" }),
      write({ event: "expired", error: "Its requester is no longer a deployment admin." }),
    ];
    for (let record of steps) await log.append(record, RETENTION);

    // Strictly, so that a step gains no field it was not given: a "requested" one has no passkey.
    let listed = (await log.list({ limit: 50 }, RETENTION)).records;
    expect(listed).toStrictEqual(steps.toReversed());
    expect(listed.at(-1)).not.toHaveProperty("passkey");
    expect(listed.every(record => !("exposed" in record))).toBe(true);

    let long = write({
      workspaceTitle: "t".repeat(5000), workspaceOwner: `${"o".repeat(600)}a`,
    });
    await log.append(long, RETENTION);
    let [kept] = (await log.list({ limit: 1 }, RETENTION)).records as AdminWriteRecord[];
    expect(kept).toStrictEqual({
      ...long,
      workspaceTitle: cutAdminAuditText(long.workspaceTitle, MAX_ADMIN_AUDIT_ARG_LENGTH),
      workspaceOwner: auditOwnerId(long.workspaceOwner),
    });
    expect(kept.workspaceTitle).toHaveLength(MAX_ADMIN_AUDIT_ARG_LENGTH);
    expect(kept.workspaceTitle.endsWith("…")).toBe(true);
    expect(kept.workspaceOwner).toMatch(/^o+…#[0-9a-f]{20}$/);
    expect(kept.workspaceOwner).toHaveLength(MAX_ADMIN_AUDIT_ARG_LENGTH);
  });

  it("finds a write record by kind, method, workspace and owner, never by what a call exposed",
      async () => {
    let log = auditLog();
    let read = access({ workspaceId: "w7", workspaceOwner: "grace" });
    let requested = write({ workspaceId: "w7", workspaceOwner: "grace" });
    let approved = write({
      event: "approved", admin: "linus", workspaceId: "w7", workspaceOwner: "grace",
    });
    let other = write({ method: "deleteChat", workspaceId: "w8" });
    for (let record of [read, setting(), requested, approved, other]) {
      await log.append(record, RETENTION);
    }

    let list = async (query: object) =>
        (await log.list({ limit: 50, ...query }, RETENTION)).records;
    expect(await list({ kind: "write" })).toEqual([other, approved, requested]);
    expect(await list({ kind: "workspace" })).toEqual([read]);
    expect(await list({ method: "stopAgent" })).toEqual([approved, requested]);
    expect(await list({ method: "deleteChat" })).toEqual([other]);
    expect(await list({ workspace: "w7" })).toEqual([approved, requested, read]);
    expect(await list({ workspace: "w7", kind: "write", admin: "linus" })).toEqual([approved]);
    expect(await list({ owner: "grace" })).toEqual([approved, requested, read]);
    expect(await list({ owner: "grace", kind: "write" })).toEqual([approved, requested]);
    expect(await list({ exposed: "metadata" })).toEqual([read]);
    expect(await list({ exposed: "content" })).toEqual([]);
    expect(await list({ kind: "write", exposed: "metadata" })).toEqual([]);
    expect(await list({ kind: "write", exposed: "content" })).toEqual([]);
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

  it("ties the workspace columns to write records too, and exposed to none of them", async () => {
    let log = auditLog();
    await expectRejection(insertRow(log, "write", null, "t", null), "CHECK constraint failed");
    await expectRejection(insertRow(log, "write", "w1", null, null), "CHECK constraint failed");
    await expectRejection(insertRow(log, "write", "w1", "t", "metadata"),
        "CHECK constraint failed");
    let exposed = { ...write(), exposed: "metadata" } as AdminWriteRecord;
    await expectRejection(log.append(exposed, RETENTION), "CHECK constraint failed");
    await insertRow(log, "write", "w1", "t", null);
    expect(await sql(log, "SELECT seq FROM admin_audit")).toHaveLength(1);
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

// The table and indexes of a log created without the "write" kind, as deployments hold it.
const TWO_KIND_SCHEMA = [
  `CREATE TABLE admin_audit (
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
  "CREATE INDEX admin_audit_at ON admin_audit (at)",
  "CREATE INDEX admin_audit_admin ON admin_audit (admin, seq)",
  "CREATE INDEX admin_audit_workspace ON admin_audit (workspace_id, seq)",
  "CREATE INDEX admin_audit_kind ON admin_audit (kind, seq)",
  "CREATE INDEX admin_audit_exposed ON admin_audit (exposed, seq)",
  "CREATE INDEX admin_audit_method ON admin_audit (json_extract(record, '$.method'), seq)",
  "CREATE INDEX admin_audit_owner ON admin_audit (json_extract(record, '$.workspaceOwner'), seq)",
];

// What an object constructed again on the same storage lists, as one that restarted does.
function listRestarted(stub: Stub): Promise<AdminAuditRecord[]> {
  return runInDurableObject(stub, (_instance, state) =>
      new AdminAuditDurableObject(state, env).list({ limit: 50 }, RETENTION).records);
}

describe("AdminAuditDurableObject rebuild", () => {
  it("rebuilds a table without the write kind once, keeping every row, seq and index",
      async () => {
    let log = auditLog();
    await sql(log, "DROP TABLE admin_audit");
    for (let statement of TWO_KIND_SCHEMA) await sql(log, statement);
    let first = setting({ at: daysAgo(3) });
    let second = access({ at: daysAgo(2), exposed: "content", args: { chatId: 4 } });
    let third = setting({ at: daysAgo(1), admin: "grace" });
    for (let record of [setting(), first, second, third]) await log.append(record, RETENTION);
    // Leave a gap, so that a copy that numbered its rows afresh would show.
    await sql(log, "DELETE FROM admin_audit WHERE seq = 1");
    await expectRejection(log.append(write(), RETENTION), "CHECK constraint failed");
    let { nextCursor } = await log.list({ limit: 1 }, RETENTION);
    expect(nextCursor).toBe("4");

    let schema = () => sql<{ type: string; name: string; tbl_name: string; sql: string }>(log,
        `SELECT type, name, tbl_name, sql FROM sqlite_master
         WHERE name LIKE 'admin_audit%' ORDER BY name`);
    let stored = () => sql(log, "SELECT * FROM admin_audit ORDER BY seq");
    let before = await stored();
    expect(await listRestarted(log)).toEqual([third, second, first]);

    expect(await stored()).toEqual(before);
    expect(before.map(row => row.seq)).toEqual([2, 3, 4]);
    expect((await log.list({ limit: 50 }, RETENTION)).records).toEqual([third, second, first]);
    expect((await log.list({ limit: 50, cursor: nextCursor }, RETENTION)).records)
        .toEqual([second, first]);

    let rebuilt = await schema();
    expect(rebuilt.map(entry => [entry.type, entry.name, entry.tbl_name])).toEqual([
      ["table", "admin_audit", "admin_audit"],
      ...["admin", "at", "exposed", "kind", "method", "owner", "workspace"]
          .map(index => ["index", `admin_audit_${index}`, "admin_audit"]),
    ]);
    expect(rebuilt[0].sql).toContain("'write'");

    let requested = write();
    await log.append(requested, RETENTION);
    expect((await log.list({ limit: 1 }, RETENTION)).records).toEqual([requested]);
    expect(await sql(log, "SELECT seq FROM admin_audit WHERE kind = 'write'"))
        .toEqual([{ seq: 5 }]);

    let rows = await stored();
    expect(await listRestarted(log)).toEqual([requested, third, second, first]);
    expect(await schema()).toEqual(rebuilt);
    expect(await stored()).toEqual(rows);
  });

  it("leaves a table that has the write kind as it is", async () => {
    let log = auditLog();
    await log.append(write(), RETENTION);
    // A table the rebuild replaced would lose a trigger installed on it.
    await sql(log, `CREATE TRIGGER admin_audit_kept AFTER DELETE ON admin_audit
        BEGIN SELECT 1; END`);
    await listRestarted(log);
    expect(await sql(log, "SELECT name FROM sqlite_master WHERE type = 'trigger'"))
        .toEqual([{ name: "admin_audit_kept" }]);
    expect(await sql(log, "SELECT seq FROM admin_audit")).toEqual([{ seq: 1 }]);
  });

  it("rebuilds in one transaction, so a copy that fails leaves the table as it was", async () => {
    let log = auditLog();
    await sql(log, "DROP TABLE admin_audit");
    // No CHECK, so that the table can hold a row the definition refuses, which fails the copy.
    await sql(log, `CREATE TABLE admin_audit (seq INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL, kind TEXT NOT NULL, admin TEXT NOT NULL, workspace_id TEXT,
        workspace_title TEXT, exposed TEXT, record TEXT NOT NULL) STRICT`);
    await sql(log, `INSERT INTO admin_audit (at, kind, admin, record)
        VALUES (0, 'setting', 'ada', '{}'), (0, 'bogus', 'ada', '{}')`);
    let stored = () => sql(log, "SELECT * FROM admin_audit ORDER BY seq");
    let before = await stored();
    expect(before).toHaveLength(2);

    // Each start fails as the first did: a table left half built would fail the next one sooner.
    for (let start = 0; start < 2; start++) {
      await expectRejection(listRestarted(log), "CHECK constraint failed");
      expect(await sql(log, "SELECT name FROM sqlite_master WHERE name LIKE 'admin_audit%'"))
          .toEqual([{ name: "admin_audit" }]);
      expect(await stored()).toEqual(before);
    }
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

  it("counts the writes approved in the window, and every step as an event", async () => {
    let log = auditLog();
    let steps: AdminAuditRecord[] = [
      write({ admin: "ada" }),
      write({ event: "refused", admin: "grace", refusal: "counter" }),
      write({ event: "approved", admin: "grace" }),
      write({ event: "applied", admin: "grace" }),
      write({ event: "approved", admin: "grace", requestId: "request-2", at: daysAgo(2) }),
      write({ event: "failed", admin: "grace", requestId: "request-2", error: "No such chat." }),
      write({ event: "denied", admin: "linus", requestId: "request-3" }),
      write({ event: "expired", requestId: "request-4" }),
      write({ event: "approved", admin: "grace", requestId: "request-5", at: daysAgo(20) }),
      // Neither is a write, though each carries an approval's `event` where a write record does.
      { ...access({ admin: "linus" }), event: "approved" } as AdminAuditRecord,
      { ...setting({ admin: "linus" }), event: "approved" } as AdminAuditRecord,
    ];
    for (let record of steps) await log.append(record, RETENTION);

    let stats = await log.stats({ days: 7 }, RETENTION);
    expect(stats.writes).toBe(2);
    expect(stats.contentReads).toBe(0);
    expect(stats.totalEvents).toBe(10);
    expect(stats.byDay.map(day => day.count).filter(count => count > 0).toSorted()).toEqual([1, 9]);
    expect(stats.topAdmins).toEqual([
      { admin: "grace", count: 5, contentReads: 0 }, { admin: "linus", count: 3, contentReads: 0 },
      { admin: "ada", count: 2, contentReads: 0 },
    ]);
    expect((await log.stats({ days: 30 }, RETENTION)).writes).toBe(3);

    let writes = await log.stats({ days: 7, kind: "write" }, RETENTION);
    expect(writes.writes).toBe(2);
    expect(writes.totalEvents).toBe(8);
    expect(writes.topAdmins).toEqual([
      { admin: "grace", count: 5, contentReads: 0 }, { admin: "ada", count: 2, contentReads: 0 },
      { admin: "linus", count: 1, contentReads: 0 },
    ]);
    for (let kind of ["setting", "workspace"] as const) {
      let others = await log.stats({ days: 30, kind }, RETENTION);
      expect(others.writes, kind).toBe(0);
      expect(others.totalEvents, kind).toBe(1);
    }
  });
});
