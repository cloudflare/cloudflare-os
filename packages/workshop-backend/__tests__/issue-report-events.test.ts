import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ADMIN_GATEKEEPER_VENDOR_ID } from "@gadgets/workshop-shared/admin-agent";
import type { IssueReportEvent } from "@gadgets/workshop-shared/admin-gatekeeper";
import type {
  AiChatAuthorInfo, AmbientGatekeeperMode, IssueReportPriority, IssueReportStatus,
} from "@gadgets/workshop-shared/api";
import { IssueReportsDurableObject } from "../src/issue-reports.js";
import {
  DEFAULT_ADMIN_CONFIG, type AdminConfig,
} from "../src/storage-schema/admin-settings-storage.js";
import type { FakeAdminVendor } from "./test-worker.js";
// Load the whole backend (the pool's `main`) up front, so its slow load does not count against the
// first test's timeout.
import "./test-worker.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_ISSUE_REPORTS: DurableObjectNamespace<IssueReportsDurableObject>;
    GATEKEEPER_INSTANCEADMIN: Service<FakeAdminVendor>;
    ISSUE_IMAGES: R2Bucket;
  }
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
// The store's own bounds, which it exports to nobody.
const EVENT_BATCH = 100;
const EVENT_RETRY_MS = MINUTE_MS;
const EVENT_MAX_AGE_MS = DAY_MS;
// An event's id: random, and so no number of the store's.
const EVENT_ID = expect.stringMatching(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);

type Person = Pick<AiChatAuthorInfo, "id" | "name">;
const ADA: Person = { id: "ada", name: "Ada" };
const GRACE: Person = { id: "grace@example.test", name: "Grace (admin)" };

// The admin gatekeeper's stand-in (FakeAdminVendor in test-worker.ts), which the store reaches
// through the same binding.
const vendor = env.GATEKEEPER_INSTANCEADMIN;

// The deployment a store of this suite is on. A test changes it as an admin or an operator
// would, and the store sees the change at its next call.
type Deployment = {
  // The admin gatekeeper's provisioning mode, or "unset" where no admin has chosen one.
  mode: AmbientGatekeeperMode | "unset";
  // Whether an admin disabled the admin gatekeeper's connector.
  connectorDisabled: boolean;
  // Whether the admin gatekeeper is bound at all.
  bound: boolean;
  // Whether the store's read of the admin config fails.
  configFails: boolean;
  // Whether AdminSettings fails when the alarm asks it for the retention.
  retentionFails: boolean;
};

function adminConfig(on: Deployment): AdminConfig {
  return {
    ...DEFAULT_ADMIN_CONFIG,
    disabledGatekeepers: on.connectorDisabled ? [ADMIN_GATEKEEPER_VENDOR_ID] : [],
    ambientGatekeeperModes: on.mode === "unset" ? {} : { [ADMIN_GATEKEEPER_VENDOR_ID]: on.mode },
  };
}

// A store of its own, on a deployment whose admin gatekeeper is on unless `deployment` says
// otherwise. The pool binds no BLUEPRINTS namespace, so the store is given one that serves the
// deployment's admin config, and its retention (a day, the floor set here) is answered in place
// of AdminSettings.
function store(deployment: Partial<Deployment> = {}) {
  let on: Deployment = {
    mode: "optional", connectorDisabled: false, bound: true, configFails: false,
    retentionFails: false, ...deployment,
  };
  let stub = env.TEST_ISSUE_REPORTS.getByName(crypto.randomUUID());
  // The deliveries the store started and handed to waitUntil().
  let started: Promise<unknown>[] = [];
  let run = <T>(
      f: (reports: IssueReportsDurableObject, state: DurableObjectState) => T | Promise<T>) =>
      runInDurableObject(stub, (reports, state) => {
        reports["env"] = {
          ...env,
          ISSUE_REPORT_RETENTION_MIN_DAYS: "1",
          BLUEPRINTS: { get: async () => {
            if (on.configFails) throw new Error("The admin config cannot be read.");
            return JSON.stringify(adminConfig(on));
          } },
          ...on.bound ? {} : { GATEKEEPER_INSTANCEADMIN: undefined },
        } as unknown as Cloudflare.Env;
        Object.defineProperty(state, "exports", {
          configurable: true,
          value: { AdminSettings: { getByName: () => ({
            committedAdminConfig: async () => {
              if (on.retentionFails) throw new Error("AdminSettings cannot be reached.");
              return { ...DEFAULT_ADMIN_CONFIG, issueReportRetentionDays: 1 };
            },
          }) } },
        });
        Object.defineProperty(state, "waitUntil", {
          configurable: true,
          value: (promise: Promise<unknown>) => { started.push(promise); },
        });
        return f(reports, state);
      });
  let sql = <T extends Record<string, SqlStorageValue>>(query: string,
      ...params: SqlStorageValue[]) =>
      run((_reports, state) => state.storage.sql.exec<T>(query, ...params).toArray());
  return {
    on, run, sql,
    count: async (table: string) =>
        (await sql<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`))[0].count,
    file: (priority: IssueReportPriority = "medium") => run(reports => reports.submit(
        ADA, { text: "The export button does nothing.", priority }, false)),
    setStatus: (reportId: string, status: IssueReportStatus) =>
        run(reports => reports.setStatus(GRACE, { via: "api" }, reportId, status)),
    // Waits, inside the store, for every delivery it started on its own to end.
    settled: () => run(async () => { await Promise.all(started.splice(0)); }),
    // Runs the alarm as the platform does, which clears the alarm before its handler runs.
    alarm: () => run(async (reports, state) => {
      await state.storage.deleteAlarm();
      await reports.alarm();
    }),
    alarmAt: () => run((_reports, state) => state.storage.getAlarm()),
    // The `seq` of each event that still waits, which never leaves the store.
    waiting: async () =>
        (await sql<{ seq: number }>("SELECT seq FROM events ORDER BY seq")).map(({ seq }) => seq),
    // The id of each event that still waits, oldest first.
    waitingIds: async () =>
        (await sql<{ id: string }>("SELECT id FROM events ORDER BY seq")).map(({ id }) => id),
  };
}

// The clock the store reads and the timer of its deliveries, moved by hand. It starts in the
// future and only moves forward, so no alarm the store sets comes due while a test runs.
function fakeClock(): { advance(ms: number): void } {
  let noon = (Math.floor(Date.now() / DAY_MS) + 2) * DAY_MS + 12 * HOUR_MS;
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], now: noon });
  return { advance: ms => { vi.advanceTimersByTime(ms); } };
}

// The calls the vendor has been sent since the test began, each with its events.
let sentBefore = 0;
async function sent(): Promise<IssueReportEvent[][]> {
  return (await vendor.calls()).issueReportEvents.slice(sentBefore);
}

beforeEach(async () => {
  sentBefore = (await vendor.calls()).issueReportEvents.length;
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await vendor.answerEvents("take");
  await vendor.releaseEvents();
});

describe("telling the admin gatekeeper of a filed report", () => {
  it("sends one event with the report's id, priority and filing time", async () => {
    fakeClock();
    let reports = store();
    let report = await reports.file("high");
    await reports.settled();
    expect(await sent()).toStrictEqual([[{
      kind: "reported", id: EVENT_ID, reportId: report.id, priority: "high", at: report.filedAt,
    }]]);
    expect(report.filedAt.getTime()).toBe(Date.now());
    expect(await reports.waiting()).toStrictEqual([]);
  });

  it("sends nothing else of the report", async () => {
    let reports = store();
    let report = await reports.file();
    await reports.settled();
    let [[event]] = await sent();
    expect(Object.keys(event).toSorted()).toStrictEqual(
        ["at", "id", "kind", "priority", "reportId"]);
    expect(JSON.stringify(event)).not.toContain(report.text);
    expect(JSON.stringify(event)).not.toContain(ADA.id);
  });
});

describe("telling the admin gatekeeper of the end of an investigation", () => {
  it.each(["answered", "waitingOnReporter", "withAdmin", "closed"] as const)(
      "sends one event when a report leaves \"investigating\" for %s", async status => {
    let clock = fakeClock();
    let reports = store();
    let report = await reports.file();
    await reports.setStatus(report.id, "investigating");
    await reports.settled();
    clock.advance(HOUR_MS);
    await reports.setStatus(report.id, status);
    await reports.settled();
    expect(await sent()).toStrictEqual([
      [expect.objectContaining({ kind: "reported" })],
      [{
        kind: "investigationComplete", id: EVENT_ID, reportId: report.id, status,
        at: new Date(Date.now()),
      }],
    ]);
    expect(await reports.waiting()).toStrictEqual([]);
  });

  it("sends nothing for a status that ends no investigation", async () => {
    let reports = store();
    let report = await reports.file();
    // A report that was never investigated.
    await reports.setStatus(report.id, "answered");
    await reports.setStatus(report.id, "new");
    // An investigation that goes on, and one that is put back.
    await reports.setStatus(report.id, "investigating");
    await reports.setStatus(report.id, "investigating");
    await reports.setStatus(report.id, "new");
    await reports.settled();
    expect((await sent()).flat().map(event => event.kind)).toStrictEqual(["reported"]);
    expect(await reports.waiting()).toStrictEqual([]);
    // Each change of status is still in the thread.
    expect((await reports.run(host => host.get(report.id))).entries.map(entry => entry.status))
        .toStrictEqual(["answered", "new", "investigating", "new"]);
  });

  it("sends a second event, with an id of its own, when a report is investigated again",
      async () => {
    let reports = store();
    let report = await reports.file();
    for (let status of ["investigating", "answered", "investigating", "closed"] as const) {
      await reports.setStatus(report.id, status);
      await reports.settled();
    }
    let events = (await sent()).flat();
    expect(events.slice(1)).toStrictEqual([
      expect.objectContaining({ kind: "investigationComplete", id: EVENT_ID, status: "answered" }),
      expect.objectContaining({ kind: "investigationComplete", id: EVENT_ID, status: "closed" }),
    ]);
    expect(new Set(events.map(event => event.id)).size).toBe(3);
  });

  // The clock does not move: both ends are written with one time.
  it("gives two ends of one millisecond, with the same status, an id each, which a resend keeps",
      async () => {
    fakeClock();
    let reports = store();
    let report = await reports.file();
    await reports.settled();
    await vendor.answerEvents("reject");
    for (let status of ["investigating", "answered", "investigating", "answered"] as const) {
      await reports.setStatus(report.id, status);
    }
    await reports.settled();
    expect(await reports.waiting()).toStrictEqual([2, 3]);
    await vendor.answerEvents("take");
    await reports.alarm();

    let calls = (await sent()).slice(1);
    let taken = calls.at(-1)!;
    let end = {
      kind: "investigationComplete", reportId: report.id, status: "answered",
      at: new Date(Date.now()),
    };
    expect(taken).toStrictEqual([{ ...end, id: EVENT_ID }, { ...end, id: EVENT_ID }]);
    expect(taken[1]!.id).not.toBe(taken[0]!.id);
    // Each call that was rejected carried the same events, under the same ids.
    expect(calls.length).toBeGreaterThan(1);
    for (let call of calls) expect(call).toStrictEqual(taken.slice(0, call.length));
  });

  it("tells two ends with the same status apart by their ids, which a resend keeps", async () => {
    let clock = fakeClock();
    let reports = store();
    let report = await reports.file();
    for (let status of ["investigating", "answered", "investigating"] as const) {
      await reports.setStatus(report.id, status);
      await reports.settled();
      clock.advance(HOUR_MS);
    }
    await vendor.answerEvents("reject");
    await reports.setStatus(report.id, "answered");
    await reports.settled();
    await vendor.answerEvents("take");
    await reports.alarm();

    let [first, second, resent] = (await sent()).flat().slice(1);
    expect(first).toMatchObject({ id: EVENT_ID, reportId: report.id, status: "answered" });
    expect(second).toMatchObject({ id: EVENT_ID, reportId: report.id, status: "answered" });
    expect(second!.id).not.toBe(first!.id);
    expect(second!.at.getTime() - first!.at.getTime()).toBe(2 * HOUR_MS);
    expect(resent).toStrictEqual(second);
  });

  it("does not count the reporter's reply as an end", async () => {
    let reports = store();
    let report = await reports.file();
    await reports.setStatus(report.id, "investigating");
    await reports.run(host => host.reply(ADA, report.id, "Any news?"));
    await reports.settled();
    expect((await reports.run(host => host.get(report.id))).status).toBe("investigating");
    expect((await sent()).flat().map(event => event.kind)).toStrictEqual(["reported"]);
  });
});

describe("a delivery the admin gatekeeper does not take", () => {
  it("is sent again by the alarm with the same ids, then forgotten", async () => {
    let reports = store();
    await vendor.answerEvents("reject");
    let first = await reports.file("low");
    let second = await reports.file("high");
    await reports.settled();
    expect(await reports.waiting()).toStrictEqual([1, 2]);
    let ids = await reports.waitingIds();
    expect(ids).toStrictEqual([EVENT_ID, EVENT_ID]);
    expect(ids[1]).not.toBe(ids[0]);

    await vendor.answerEvents("take");
    await reports.alarm();
    let calls = await sent();
    expect(calls.at(-1)).toStrictEqual([
      { kind: "reported", id: ids[0], reportId: first.id, priority: "low", at: first.filedAt },
      { kind: "reported", id: ids[1], reportId: second.id, priority: "high", at: second.filedAt },
    ]);
    // What was rejected first was the first event, under the same id.
    expect(calls[0]).toStrictEqual([calls.at(-1)![0]]);
    expect(await reports.waiting()).toStrictEqual([]);

    // Neither a number nor an id is used twice, even once its event is gone.
    await vendor.answerEvents("reject");
    let third = await reports.file();
    await reports.settled();
    expect(await reports.waiting()).toStrictEqual([3]);
    expect((await sent()).at(-1)).toStrictEqual([
      expect.objectContaining({ id: EVENT_ID, reportId: third.id }),
    ]);
    expect(ids).not.toContain((await sent()).at(-1)![0]!.id);
  });

  it("fails neither the filing nor the change of status", async () => {
    let logged = vi.spyOn(console, "warn").mockImplementation(() => {});
    let reports = store();
    await vendor.answerEvents("reject");
    let report = await reports.file();
    expect(report.status).toBe("new");
    await reports.setStatus(report.id, "investigating");
    await expect(reports.setStatus(report.id, "closed")).resolves.toBeUndefined();
    await reports.settled();
    expect((await reports.run(host => host.get(report.id))).status).toBe("closed");
    expect(await reports.waiting()).toStrictEqual([1, 2]);
    // The log names how many events were not taken and why, and nothing of a report.
    let entries = logged.mock.calls.map(([entry]) => entry as Record<string, unknown>)
        .filter(entry => entry.event === "issue.reports.events.undelivered");
    expect(entries.length).toBeGreaterThan(0);
    for (let entry of entries) {
      expect(entry.size).toBeGreaterThan(0);
      expect(JSON.stringify(entry)).toContain("The fake admin vendor rejects events.");
      expect(JSON.stringify(entry)).not.toContain(report.id);
    }
  });

  it("drops an event that was not taken for a day, and keeps a newer one", async () => {
    let clock = fakeClock();
    let logged = vi.spyOn(console, "error").mockImplementation(() => {});
    let reports = store();
    await vendor.answerEvents("reject");
    let report = await reports.file();
    await reports.settled();
    clock.advance(EVENT_MAX_AGE_MS);
    await reports.alarm();
    // A day old to the millisecond is not yet too old.
    expect(await reports.waiting()).toStrictEqual([1]);

    clock.advance(1);
    await reports.setStatus(report.id, "investigating");
    await reports.setStatus(report.id, "answered");
    await reports.settled();
    expect(await reports.waiting()).toStrictEqual([2]);
    expect(logged.mock.calls.map(([entry]) => entry as Record<string, unknown>)
        .filter(entry => entry.event === "issue.reports.events.dropped")
        .map(entry => entry.size)).toStrictEqual([1]);

    await vendor.answerEvents("take");
    await reports.alarm();
    expect((await sent()).at(-1)).toStrictEqual([
      expect.objectContaining({ kind: "investigationComplete", status: "answered" }),
    ]);
  });

  it("sends more events than a call carries in batches, oldest first", async () => {
    let reports = store();
    await vendor.answerEvents("reject");
    let report = await reports.file();
    await reports.settled();
    // The rest are written as an end of an investigation writes them, without 250 changes of
    // status.
    await reports.sql(
      `INSERT INTO events (id, kind, report_id, label, at)
       SELECT 'end-' || value, 'investigationComplete', ?, 'answered', ? + value
       FROM json_each(?)`,
      report.id, Date.now(), JSON.stringify(Array.from({ length: 2 * EVENT_BATCH + 49 }, (_, i) => i)));

    expect(await reports.waiting())
        .toStrictEqual(Array.from({ length: 2 * EVENT_BATCH + 50 }, (_, i) => i + 1));
    let ids = await reports.waitingIds();

    await vendor.answerEvents("take");
    let before = (await sent()).length;
    await reports.alarm();
    let calls = (await sent()).slice(before);
    expect(calls.map(call => call.length)).toStrictEqual([EVENT_BATCH, EVENT_BATCH, 50]);
    expect(calls.flat().map(event => event.id)).toStrictEqual(ids);
    expect(ids.slice(1)).toStrictEqual(
        Array.from({ length: 2 * EVENT_BATCH + 49 }, (_, i) => `end-${i}`));
    expect(await reports.waiting()).toStrictEqual([]);
  });
});

describe("a store whose events table has no id column", () => {
  // The table as a store made without the column holds it.
  const EVENTS_WITHOUT_ID = `CREATE TABLE events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      report_id TEXT NOT NULL,
      label TEXT NOT NULL,
      at INTEGER NOT NULL
    ) STRICT`;

  it("gains the column when the store next starts, with an id for each event that waited, and " +
      "tells of a report filed then", async () => {
    let reports = store();
    await reports.run((_host, state) => {
      let db = state.storage.sql;
      db.exec("DROP TABLE events");
      db.exec(EVENTS_WITHOUT_ID);
      db.exec(`INSERT INTO events (kind, report_id, label, at)
               VALUES ('reported', 'r-old', 'low', 1000),
                      ('investigationComplete', 'r-old', 'answered', 2000)`);
    });

    // The store is made again over the same storage, as its next start makes it: the pool gives
    // a test no way to restart the object in place and keep what it stored.
    let filed = await reports.run(async (host, state) => {
      let restarted = new IssueReportsDurableObject(state, host["env"]);
      let column = state.storage.sql.exec(
          `SELECT type, "notnull" FROM pragma_table_info('events') WHERE name = 'id'`).toArray();
      expect(column).toStrictEqual([{ type: "TEXT", notnull: 1 }]);
      let ids = state.storage.sql.exec<{ id: string }>("SELECT id FROM events ORDER BY seq")
          .toArray().map(({ id }) => id);
      expect(ids).toStrictEqual([EVENT_ID, EVENT_ID]);
      expect(ids[1]).not.toBe(ids[0]);
      return {
        ids, report: await restarted.submit(ADA, { text: "It broke.", priority: "high" }, false),
      };
    });
    await reports.settled();

    expect(await sent()).toStrictEqual([[
      { kind: "reported", id: filed.ids[0], reportId: "r-old", priority: "low", at: new Date(1000) },
      { kind: "investigationComplete", id: filed.ids[1], reportId: "r-old", status: "answered",
        at: new Date(2000) },
      { kind: "reported", id: EVENT_ID, reportId: filed.report.id, priority: "high",
        at: filed.report.filedAt },
    ]]);
    expect(await reports.waiting()).toStrictEqual([]);
  });
});

describe("a deployment whose admin gatekeeper is not there to be told", () => {
  it.each([
    ["has no mode set, which leaves it disabled", { mode: "unset" }],
    ["was set to \"disabled\"", { mode: "disabled" }],
    ["had its connector disabled", { connectorDisabled: true }],
    ["is not bound", { bound: false }],
  ] as [string, Partial<Deployment>][])(
      "sends nothing and keeps no event when the gatekeeper %s", async (_name, deployment) => {
    let reports = store(deployment);
    let report = await reports.file();
    await reports.setStatus(report.id, "investigating");
    await reports.setStatus(report.id, "closed");
    await reports.settled();
    expect(await sent()).toStrictEqual([]);
    expect(await reports.waiting()).toStrictEqual([]);
    await reports.alarm();
    expect(await sent()).toStrictEqual([]);
  });

  it("replays nothing once the gatekeeper is turned on", async () => {
    let reports = store({ mode: "disabled" });
    await reports.file();
    await reports.settled();
    reports.on.mode = "enabled";
    await reports.alarm();
    expect(await sent()).toStrictEqual([]);
    let report = await reports.file();
    await reports.settled();
    expect(await sent()).toStrictEqual([[expect.objectContaining({ reportId: report.id })]]);
  });

  it("empties the table of what waited when the gatekeeper is turned off", async () => {
    let reports = store();
    await vendor.answerEvents("reject");
    await reports.file();
    await reports.settled();
    expect(await reports.waiting()).toStrictEqual([1]);
    reports.on.mode = "disabled";
    let before = (await sent()).length;
    await reports.alarm();
    expect(await reports.waiting()).toStrictEqual([]);
    expect(await sent()).toHaveLength(before);
  });

  // An admin config that cannot be read says nothing of the gatekeeper: it is not "off".
  it("keeps what waits while the admin config cannot be read, and sends it once it can",
      async () => {
    fakeClock();
    let logged = vi.spyOn(console, "warn").mockImplementation(() => {});
    let reports = store({ configFails: true });
    let report = await reports.file();
    expect(report.status).toBe("new");
    await reports.settled();
    expect(await sent()).toStrictEqual([]);
    expect(await reports.waiting()).toStrictEqual([1]);
    let [id] = await reports.waitingIds();

    await expect(reports.alarm()).resolves.toBeUndefined();
    expect(await sent()).toStrictEqual([]);
    expect(await reports.waiting()).toStrictEqual([1]);
    expect(await reports.alarmAt()).toBe(Date.now() + EVENT_RETRY_MS);
    // Each failed read is logged as a delivery that was not taken.
    expect(logged.mock.calls.map(([entry]) => entry as Record<string, unknown>)
        .filter(entry => entry.event === "issue.reports.events.undelivered")).toHaveLength(2);

    reports.on.configFails = false;
    await reports.alarm();
    expect(await sent()).toStrictEqual([[{
      kind: "reported", id, reportId: report.id, priority: "medium", at: report.filedAt,
    }]]);
    expect(await reports.waiting()).toStrictEqual([]);
    expect(await reports.alarmAt()).toBe(Date.now() + DAY_MS);
  });
});

// Waits, on the real clock, until `check` holds.
async function until(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (await check()) return;
    await scheduler.wait(5);
  }
  throw new Error("Timed out waiting.");
}

// Makes a report past its retention without ageing its event: the retention's floor is a day,
// which is also how long an event is kept.
function backdate(reports: ReturnType<typeof store>, reportId: string): Promise<unknown> {
  return reports.sql("UPDATE reports SET filed_at = filed_at - ? WHERE id = ?", 2 * DAY_MS, reportId);
}

// An upload of `reportId` that began `agoMs` ago and never finished.
function pendingUpload(reports: ReturnType<typeof store>, reportId: string, agoMs: number)
    : Promise<unknown> {
  return reports.sql(
    `INSERT INTO images (report_seq, id, reporter_id, state, byte_length, started_at, n)
     SELECT seq, ?, reporter_id, 'pending', 100, ?, 1 FROM reports WHERE id = ?`,
    crypto.randomUUID(), Date.now() - agoMs, reportId);
}

describe("what arms the store's alarm for an event", () => {
  it("wakes within a minute of a report filed into an empty store, then a day later", async () => {
    fakeClock();
    let reports = store();
    expect(await reports.alarmAt()).toBeNull();
    await reports.file();
    expect(await reports.alarmAt()).toBe(Date.now() + EVENT_RETRY_MS);
    await reports.settled();
    await reports.alarm();
    expect(await reports.alarmAt()).toBe(Date.now() + DAY_MS);
  });

  it("moves a day-ahead alarm to within a minute of an investigation's end", async () => {
    let clock = fakeClock();
    let reports = store();
    let report = await reports.file();
    await reports.settled();
    await reports.alarm();
    // A change of status that ends no investigation leaves the alarm where it is.
    await reports.setStatus(report.id, "investigating");
    expect(await reports.alarmAt()).toBe(Date.now() + DAY_MS);
    clock.advance(HOUR_MS);
    await reports.setStatus(report.id, "answered");
    expect(await reports.alarmAt()).toBe(Date.now() + EVENT_RETRY_MS);
  });

  it("never moves a nearer alarm later", async () => {
    fakeClock();
    let reports = store();
    let near = Date.now() + 10_000;
    await reports.run((_host, state) => state.storage.setAlarm(near));
    let report = await reports.file();
    expect(await reports.alarmAt()).toBe(near);
    await reports.setStatus(report.id, "investigating");
    await reports.setStatus(report.id, "closed");
    expect(await reports.alarmAt()).toBe(near);
  });

  it("keeps an alarm for an event whose report is gone, and none once it is taken", async () => {
    fakeClock();
    let reports = store();
    await vendor.answerEvents("reject");
    let report = await reports.file();
    await reports.settled();
    await backdate(reports, report.id);
    await reports.alarm();
    expect(await reports.count("reports")).toBe(0);
    expect(await reports.waiting()).toStrictEqual([1]);
    let [id] = await reports.waitingIds();
    expect(await reports.alarmAt()).toBe(Date.now() + EVENT_RETRY_MS);

    await vendor.answerEvents("take");
    await reports.alarm();
    expect((await sent()).at(-1)).toStrictEqual([
      expect.objectContaining({ kind: "reported", id, reportId: report.id }),
    ]);
    // Empty of reports and of events, the store has no alarm.
    expect(await reports.waiting()).toStrictEqual([]);
    expect(await reports.alarmAt()).toBeNull();
  });
});

describe("the retention pass beside the events", () => {
  it("comes back as it does without events once none waits", async () => {
    fakeClock();
    let reports = store();
    let report = await reports.file();
    await reports.settled();
    await reports.alarm();
    expect(await reports.alarmAt()).toBe(Date.now() + DAY_MS);

    // A report that is due and cannot go yet, for an upload in flight: a minute.
    await backdate(reports, report.id);
    await pendingUpload(reports, report.id, 0);
    await reports.alarm();
    expect(await reports.count("reports")).toBe(1);
    expect(await reports.alarmAt()).toBe(Date.now() + MINUTE_MS);

    // A pass that failed: an hour.
    reports.on.retentionFails = true;
    await reports.alarm();
    expect(await reports.alarmAt()).toBe(Date.now() + HOUR_MS);
  });

  it("comes back within a minute while an event waits, whatever the pass chose", async () => {
    fakeClock();
    let reports = store();
    await vendor.answerEvents("reject");
    await reports.file();
    await reports.settled();
    // A day, but for the event.
    await reports.alarm();
    expect(await reports.alarmAt()).toBe(Date.now() + EVENT_RETRY_MS);
    // An hour, but for the event.
    reports.on.retentionFails = true;
    await reports.alarm();
    expect(await reports.alarmAt()).toBe(Date.now() + EVENT_RETRY_MS);
    expect(await reports.waiting()).toStrictEqual([1]);
  });

  it("deletes nothing that is not due when it runs early", async () => {
    let clock = fakeClock();
    let reports = store();
    await vendor.answerEvents("reject");
    let report = await reports.file();
    await reports.settled();
    let image = crypto.randomUUID();
    await reports.sql(
      `INSERT INTO images (report_seq, id, reporter_id, state, type, byte_length, started_at, n)
       SELECT seq, ?, reporter_id, 'stored', 'image/png', 3, ?, 1 FROM reports WHERE id = ?`,
      image, Date.now(), report.id);
    await env.ISSUE_IMAGES.put(`${report.id}/${image}`, new Uint8Array([1, 2, 3]));
    await pendingUpload(reports, report.id, 0);

    for (let run = 0; run < 3; run++) {
      clock.advance(EVENT_RETRY_MS);
      await reports.alarm();
    }
    expect(await reports.count("reports")).toBe(1);
    expect(await reports.count("images")).toBe(2);
    expect(await env.ISSUE_IMAGES.head(`${report.id}/${image}`)).not.toBeNull();
    await env.ISSUE_IMAGES.delete(`${report.id}/${image}`);
  });

  it("has run, and the alarm is set and has not thrown, when the delivery fails", async () => {
    fakeClock();
    let reports = store();
    await vendor.answerEvents("reject");
    let old = await reports.file();
    let kept = await reports.file();
    await reports.settled();
    await backdate(reports, old.id);
    await expect(reports.alarm()).resolves.toBeUndefined();
    expect(await reports.sql("SELECT id FROM reports")).toStrictEqual([{ id: kept.id }]);
    expect(await reports.waiting()).toStrictEqual([1, 2]);
    expect(await reports.alarmAt()).toBe(Date.now() + EVENT_RETRY_MS);
  });
});

describe("an admin gatekeeper that does not answer", () => {
  it("holds back neither a report, the pass nor the alarm, and is asked again", async () => {
    // The delivery's timer is the faked one: the clock is moved past EVENT_RETRY_MS by hand.
    let clock = fakeClock();
    let reports = store();
    await vendor.answerEvents("hang");
    let first = await reports.file("low");
    expect(await reports.alarmAt()).toBe(Date.now() + EVENT_RETRY_MS);
    await until(async () => (await sent()).length === 1);

    // A second report is filed while the call hangs: it returns, and its event waits.
    let second = await reports.file("high");
    expect(second.status).toBe("new");
    expect(await reports.waiting()).toStrictEqual([1, 2]);
    let ids = await reports.waitingIds();

    // The alarm runs its pass before it waits for the call: the stale upload is swept.
    await pendingUpload(reports, first.id, 11 * MINUTE_MS);
    let ended = false;
    let alarm = reports.alarm().then(() => { ended = true; });
    await until(async () => await reports.count("images") === 0);
    await scheduler.wait(20);
    expect(ended).toBe(false);
    // It joined the call that hangs rather than making another.
    expect(await sent()).toHaveLength(1);

    // The call is given up on: the delivery ends, and the alarm is set and returns. The clock
    // is moved inside the store, where the delivery's timer must fire.
    await reports.run(() => clock.advance(EVENT_RETRY_MS));
    await alarm;
    expect(await reports.waiting()).toStrictEqual([1, 2]);
    expect(await reports.alarmAt()).toBe(Date.now() + EVENT_RETRY_MS);

    // The call given up on resolves late: nothing is deleted or sent because of it.
    await vendor.answerEvents("take");
    expect(await vendor.releaseEvents()).toBe(1);
    await scheduler.wait(50);
    expect(await reports.waiting()).toStrictEqual([1, 2]);
    expect(await sent()).toHaveLength(1);

    // The next delivery is a call of its own, and carries both events, oldest first.
    await reports.alarm();
    expect(await sent()).toStrictEqual([
      [{ kind: "reported", id: ids[0], reportId: first.id, priority: "low", at: first.filedAt }],
      [
        { kind: "reported", id: ids[0], reportId: first.id, priority: "low", at: first.filedAt },
        { kind: "reported", id: ids[1], reportId: second.id, priority: "high", at: second.filedAt },
      ],
    ]);
    expect(await reports.waiting()).toStrictEqual([]);
    expect(await reports.alarmAt()).toBe(Date.now() + DAY_MS);
  });
});
