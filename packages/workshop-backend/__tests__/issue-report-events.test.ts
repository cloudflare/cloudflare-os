import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ADMIN_GATEKEEPER_VENDOR_ID } from "@gadgets/workshop-shared/admin-agent";
import type {
  IssueReportChange, IssueReportEvent,
} from "@gadgets/workshop-shared/admin-gatekeeper";
import {
  ISSUE_REPORT_ERROR_CODES, MAX_ISSUE_REPORT_REPLIES_PER_DAY, MAX_ISSUE_REPORT_THREAD_ENTRIES,
  getIssueReportErrorCode,
  type AiChatAuthorInfo, type AmbientGatekeeperMode, type IssueReportPriority,
  type IssueReportStatus,
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
    GATEKEEPER_ADMIN: Service<FakeAdminVendor>;
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
const HEDY: Person = { id: "hedy@example.test", name: "Hedy (admin)" };
// An image as a reporter's upload sends it, a stream: a PNG's signature and the start of its
// first chunk.
const IMAGE = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52];
const imageStream = () => new Response(new Uint8Array(IMAGE)).body!;

// The admin gatekeeper's stand-in (FakeAdminVendor in test-worker.ts), which the store reaches
// through the same binding.
const vendor = env.GATEKEEPER_ADMIN;

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
  // Runs, inside the store, while the admin config it read is on its way back.
  whileConfigIsRead?: (reports: IssueReportsDurableObject) => Promise<void>;
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
            let read = JSON.stringify(adminConfig(on));
            await on.whileConfigIsRead?.(reports);
            return read;
          } },
          ...on.bound ? {} : { GATEKEEPER_ADMIN: undefined },
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

// Each event of `kind` the vendor has been sent since the test began, oldest first, as often as
// it was sent.
async function sentOf<K extends IssueReportEvent["kind"]>(kind: K)
    : Promise<Extract<IssueReportEvent, { kind: K }>[]> {
  return (await sent()).flat()
      .filter((event): event is Extract<IssueReportEvent, { kind: K }> => event.kind === kind);
}
const ends = () => sentOf("investigationComplete");
const changes = () => sentOf("changed");

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
    // The two ids are random, and say nothing of the report: the rest holds neither.
    let { id: _id, reportId: _reportId, ...rest } = event;
    expect(JSON.stringify(rest)).not.toContain(report.text);
    expect(JSON.stringify(rest)).not.toContain(ADA.id);
  });
});

describe("telling the admin gatekeeper of the end of an investigation", () => {
  it.each([
    "answered", "waitingOnReporter", "withAdmin", "fixSuggested", "fixInProgress", "fixProposed",
    "closed",
  ] as const)("sends one event when a report leaves \"investigating\" for %s", async status => {
    let clock = fakeClock();
    let reports = store();
    let report = await reports.file();
    await reports.setStatus(report.id, "investigating");
    await reports.settled();
    clock.advance(HOUR_MS);
    await reports.setStatus(report.id, status);
    await reports.settled();
    expect(await ends()).toStrictEqual([{
      kind: "investigationComplete", id: EVENT_ID, reportId: report.id, status,
      at: new Date(Date.now()),
    }]);
    expect(await reports.waiting()).toStrictEqual([]);
  });

  it("sends no end for a status that ends no investigation", async () => {
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
    expect(await ends()).toStrictEqual([]);
    expect(await reports.waiting()).toStrictEqual([]);
    // Each change of status is in the thread, and was told as a change.
    let statuses = ["answered", "new", "investigating", "new"];
    expect((await reports.run(host => host.get(report.id))).entries.map(entry => entry.status))
        .toStrictEqual(statuses);
    expect((await changes()).map(event => event.status)).toStrictEqual(statuses);
  });

  it("sends a second event, with an id of its own, when a report is investigated again",
      async () => {
    let reports = store();
    let report = await reports.file();
    for (let status of ["investigating", "answered", "investigating", "closed"] as const) {
      await reports.setStatus(report.id, status);
      await reports.settled();
    }
    let events = await ends();
    expect(events).toStrictEqual([
      expect.objectContaining({ kind: "investigationComplete", id: EVENT_ID, status: "answered" }),
      expect.objectContaining({ kind: "investigationComplete", id: EVENT_ID, status: "closed" }),
    ]);
    expect(events[1]!.id).not.toBe(events[0]!.id);
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
    // Four changes of status, two of which ended an investigation.
    expect(await reports.waiting()).toStrictEqual([2, 3, 4, 5, 6, 7]);
    await vendor.answerEvents("take");
    await reports.alarm();

    let calls = (await sent()).slice(1);
    let taken = calls.at(-1)!;
    let end = {
      kind: "investigationComplete", reportId: report.id, status: "answered",
      at: new Date(Date.now()),
    };
    let ended = taken.filter(event => event.kind === "investigationComplete");
    expect(ended).toStrictEqual([{ ...end, id: EVENT_ID }, { ...end, id: EVENT_ID }]);
    expect(ended[1]!.id).not.toBe(ended[0]!.id);
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

    let [first, second, resent] = await ends();
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
    expect(await ends()).toStrictEqual([]);
    expect((await changes()).map(event => event.change)).toStrictEqual(["status", "reply"]);
  });
});

describe("a change to a report", () => {
  type Host = IssueReportsDurableObject;
  type Caller = typeof PERSON | typeof AGENT;
  const PERSON = { via: "api" } as const;
  const AGENT = { via: "gatekeeper", agent: { workspaceId: "w".repeat(64), chatId: 1 } } as const;
  const LINK = "https://example.com/issues/1";
  const REPLY = "Any news?";

  // A write that changes a report: what readies the report for it, the write itself, and what
  // its event says the write was.
  type Write = {
    before?: (host: Host, id: string, caller: Caller) => Promise<unknown>;
    write: (host: Host, id: string, caller: Caller) => Promise<unknown>;
    change: IssueReportChange;
    status?: IssueReportStatus;
  };
  // The writes an admin makes, in person or through the admin gatekeeper.
  const ADMIN_WRITES: [string, Write][] = [
    ["a change of status", {
      write: (host, id, caller) => host.setStatus(GRACE, caller, id, "fixInProgress"),
      change: "status", status: "fixInProgress",
    }],
    ["a public entry", {
      write: (host, id, caller) => host.addEntry(GRACE, caller, id, "Try again now.", "public"),
      change: "reply",
    }],
    ["an admins-only entry", {
      write: (host, id, caller) => host.addEntry(GRACE, caller, id, "A cache key.", "admins"),
      change: "note",
    }],
    ["a claim", {
      write: (host, id, caller) => host.claim(GRACE, caller, id),
      change: "assignment",
    }],
    ["a release", {
      before: (host, id, caller) => host.claim(GRACE, caller, id),
      write: (host, id, caller) => host.release(GRACE, caller, id),
      change: "assignment",
    }],
  ];
  // The writes that are a person's alone, and the one that is labelled by no caller.
  const OTHER_WRITES: [string, Write][] = [
    ["the reporter's reply", {
      write: (host, id) => host.reply(ADA, id, REPLY),
      change: "reply",
    }],
    ["the reporter's reply that reopens the report", {
      before: (host, id) => host.setStatus(GRACE, PERSON, id, "answered"),
      write: (host, id) => host.reply(ADA, id, REPLY),
      change: "reply", status: "withAdmin",
    }],
    ["a take-over", {
      before: (host, id) => host.claim(HEDY, PERSON, id),
      write: (host, id) => host.claim(GRACE, PERSON, id, HEDY.id),
      change: "assignment",
    }],
    ["links that differ from the report's", {
      write: (host, id) => host.setLinks(id, [LINK]),
      change: "links",
    }],
  ];

  // Files a report, makes `write` an hour later, and expects the one event that tells of it:
  // toStrictEqual() takes no field it is not given, nor a `status` that is there and undefined.
  async function expectOneEvent({ before, write, change, status }: Write, caller: Caller) {
    let clock = fakeClock();
    let reports = store();
    let report = await reports.file();
    await reports.run(host => before?.(host, report.id, caller));
    await reports.settled();
    let earlier = (await sent()).flat();
    clock.advance(HOUR_MS);

    await reports.run(host => write(host, report.id, caller));
    await reports.settled();
    let events = (await sent()).flat().slice(earlier.length);
    expect(events).toStrictEqual([{
      kind: "changed", id: EVENT_ID, reportId: report.id, change,
      ...status !== undefined && { status }, at: new Date(Date.now()),
    }]);
    expect(earlier.map(event => event.id)).not.toContain(events[0]!.id);
    expect(await reports.waiting()).toStrictEqual([]);
  }

  describe.each([
    ["a person", PERSON], ["the admin gatekeeper", AGENT],
  ] as [string, Caller][])("made by %s", (_name, caller) => {
    it.each(ADMIN_WRITES)("sends one event for %s", (_write, write) =>
        expectOneEvent(write, caller));
  });

  it.each(OTHER_WRITES)("sends one event for %s", (_write, write) =>
      expectOneEvent(write, PERSON));

  it("carries the status a write set, as admins read it", async () => {
    let reports = store();
    let report = await reports.file();
    await reports.setStatus(report.id, "withAdmin");
    // A move the reporter does not read: a line for the admins alone, and the true status.
    await reports.setStatus(report.id, "fixSuggested");
    await reports.setStatus(report.id, "answered");
    // The reply that reopens the report, then one that reopens nothing.
    await reports.run(host => host.reply(ADA, report.id, REPLY));
    await reports.run(host => host.reply(ADA, report.id, REPLY));
    await reports.settled();

    expect((await reports.run(host => host.get(report.id))).entries[1])
        .toMatchObject({ visibility: "admins", status: "fixSuggested" });
    expect((await changes()).map(({ change, status }) => ({ change, status }))).toStrictEqual([
      { change: "status", status: "withAdmin" },
      { change: "status", status: "fixSuggested" },
      { change: "status", status: "answered" },
      { change: "reply", status: "withAdmin" },
      { change: "reply", status: undefined },
    ]);
    expect((await changes()).at(-1)).not.toHaveProperty("status");
  });

  it("sends nothing for a write that changed nothing", async () => {
    let reports = store();
    let report = await reports.file();
    let other = await reports.file();
    await reports.run(async host => {
      await host.claim(GRACE, PERSON, report.id);
      await host.setLinks(report.id, [LINK]);
    });
    await reports.settled();
    await reports.alarm();
    let before = (await sent()).length;
    let alarmAt = await reports.alarmAt();

    await reports.run(async host => {
      await host.setStatus(GRACE, PERSON, report.id, "new");
      await host.setStatus(GRACE, AGENT, report.id, "new");
      await host.claim(GRACE, PERSON, report.id);
      await host.claim(GRACE, PERSON, report.id, HEDY.id);
      await host.claim(GRACE, AGENT, report.id);
      await host.release(GRACE, PERSON, other.id);
      await host.release(GRACE, AGENT, other.id);
      await host.setLinks(report.id, [LINK]);
      await host.setLinks(other.id, []);
      host.markSeen("ada", report.id);
    });
    await reports.settled();
    expect((await sent()).slice(before)).toStrictEqual([]);
    expect(await reports.waiting()).toStrictEqual([]);
    expect(await reports.alarmAt()).toBe(alarmAt);
  });

  it("sends nothing for a refused call", async () => {
    let clock = fakeClock();
    let reports = store();
    let report = await reports.file();
    let closed = await reports.file();
    let full = await reports.file();
    await reports.run(async host => {
      await host.claim(HEDY, PERSON, report.id);
      await host.setStatus(GRACE, PERSON, closed.id, "closed");
      for (let i = 0; i < MAX_ISSUE_REPORT_THREAD_ENTRIES; i++) {
        await host.addEntry(GRACE, AGENT, full.id, "A note.", "admins");
        await host.setStatus(GRACE, AGENT, full.id, i % 2 === 0 ? "answered" : "withAdmin");
        if (i % 2 === 0) await host.claim(GRACE, AGENT, full.id);
        else await host.release(GRACE, AGENT, full.id);
      }
      for (let i = 0; i < MAX_ISSUE_REPORT_REPLIES_PER_DAY; i++) {
        await host.reply(ADA, report.id, REPLY);
      }
    });
    await reports.settled();
    await reports.alarm();
    expect(await reports.waiting()).toStrictEqual([]);
    let before = (await sent()).length;
    let alarmAt = await reports.alarmAt();

    let unknown = crypto.randomUUID();
    let refused = async (call: (host: Host) => unknown) => {
      try {
        await reports.run(call);
      } catch (error) {
        return getIssueReportErrorCode(error) ?? (error as Error).name;
      }
      return "not refused";
    };
    let codes = ISSUE_REPORT_ERROR_CODES;
    let calls: [string, (host: Host) => unknown][] = [
      [codes.notFound, host => host.setStatus(GRACE, PERSON, unknown, "closed")],
      [codes.notFound, host => host.addEntry(GRACE, PERSON, unknown, "A note.", "admins")],
      [codes.notFound, host => host.claim(GRACE, PERSON, unknown)],
      [codes.notFound, host => host.release(GRACE, PERSON, unknown)],
      [codes.notFound, host => host.setLinks(unknown, [LINK])],
      [codes.notFound, host => host.setLinks(unknown, [])],
      // Another's report is none to a reporter.
      [codes.notFound, host => host.reply(GRACE, report.id, REPLY)],
      [codes.closed, host => host.reply(ADA, closed.id, REPLY)],
      [codes.tooManyReplies, host => host.reply(ADA, full.id, REPLY)],
      [codes.threadFull, host => host.addEntry(GRACE, AGENT, full.id, "A note.", "admins")],
      [codes.threadFull, host => host.setStatus(GRACE, AGENT, full.id, "closed")],
      [codes.threadFull, host => host.claim(GRACE, AGENT, full.id)],
      [codes.assigned, host => host.claim(GRACE, PERSON, report.id)],
      [codes.assigned, host => host.claim(GRACE, AGENT, report.id)],
      [codes.assigned, host => host.release(GRACE, PERSON, report.id)],
      // A take-over from an admin who does not hold the report.
      [codes.assigned, host => host.claim(GRACE, PERSON, report.id, ADA.id)],
      // The take-over through the gatekeeper, and what is not a status, a text or a link.
      ["TypeError", host => host.claim(GRACE, AGENT, report.id, HEDY.id)],
      ["TypeError", host => host.setStatus(GRACE, PERSON, report.id, "done" as IssueReportStatus)],
      ["TypeError", host => host.addEntry(GRACE, PERSON, report.id, " ", "public")],
      ["TypeError", host => host.addEntry(GRACE, { via: "web" } as never, report.id, "A note.",
          "admins")],
      ["TypeError", host => host.reply(ADA, report.id, " ")],
      ["TypeError", host => host.setLinks(report.id, ["ftp://example.com/"])],
    ];
    for (let [code, call] of calls) expect(await refused(call)).toBe(code);
    // The reporter's replies of the day are spent: a thread that is full refuses the next day's.
    await reports.sql(
        `INSERT INTO entries (report_seq, n, id, at, author_id, author_name, visibility, text)
         SELECT r.seq, 1000 + value, 'reply-' || value, ?, 'ada', 'Ada', 'public', 'Reply.'
         FROM reports r, json_each(?) WHERE r.id = ?`,
        Date.now(), JSON.stringify(Array.from(
            { length: MAX_ISSUE_REPORT_THREAD_ENTRIES - MAX_ISSUE_REPORT_REPLIES_PER_DAY },
            (_, i) => i)), report.id);
    clock.advance(DAY_MS);
    expect(await refused(host => host.reply(ADA, report.id, REPLY))).toBe(codes.threadFull);

    await reports.settled();
    expect((await sent()).slice(before)).toStrictEqual([]);
    expect(await reports.waiting()).toStrictEqual([]);
    expect(await reports.alarmAt()).toBe(alarmAt);
  });

  it("sends nothing for an image or a grant, at filing or later", async () => {
    let reports = store();
    let report = await reports.file();
    let grant = {
      id: crypto.randomUUID(), scope: "account" as const,
      expiresAt: new Date(Date.now() + 72 * HOUR_MS),
    };
    // What the reporter attaches with the report, right after it is filed.
    await reports.run(async host => {
      await host.addImage("ada", report.id, imageStream(), IMAGE.length);
      host.noteGrant("ada", grant, report.id);
    });
    await reports.settled();
    expect(await sent()).toStrictEqual([[expect.objectContaining({ kind: "reported" })]]);

    // And what they attach later, to a report an admin has written to: the grant's end, a
    // grant in its place and another image.
    await reports.setStatus(report.id, "answered");
    await reports.run(async host => {
      host.noteGrant("ada", { ...grant, endedAt: new Date() });
      host.noteGrant("ada", { ...grant, id: crypto.randomUUID() }, report.id);
      await host.addImage("ada", report.id, imageStream(), IMAGE.length);
    });
    await reports.settled();
    expect((await sent()).flat().map(event => event.kind)).toStrictEqual(["reported", "changed"]);
    expect(await reports.waiting()).toStrictEqual([]);

    // Each of them is in the report.
    let stored = await reports.run(host => host.get(report.id));
    expect(stored.images).toHaveLength(2);
    expect(stored.grant?.id).not.toBe(grant.id);
    await env.ISSUE_IMAGES.delete(stored.images.map(({ id }) => `${report.id}/${id}`));
  });

  it("sends both when a report leaves investigating, each with its own id, the end first",
      async () => {
    let clock = fakeClock();
    let reports = store();
    let report = await reports.file();
    await reports.setStatus(report.id, "investigating");
    await reports.settled();
    let before = (await sent()).length;
    clock.advance(HOUR_MS);
    await reports.setStatus(report.id, "fixProposed");
    await reports.settled();

    let event = { reportId: report.id, status: "fixProposed", at: new Date(Date.now()) };
    let [call, ...others] = (await sent()).slice(before);
    expect(others).toStrictEqual([]);
    expect(call).toStrictEqual([
      { kind: "investigationComplete", id: EVENT_ID, ...event },
      { kind: "changed", id: EVENT_ID, change: "status", ...event },
    ]);
    expect(call![1]!.id).not.toBe(call![0]!.id);

    // An investigation that is put back ends none, and is a change.
    await reports.setStatus(report.id, "investigating");
    await reports.setStatus(report.id, "new");
    await reports.settled();
    expect(await ends()).toHaveLength(1);
    expect((await changes()).map(({ status }) => status))
        .toStrictEqual(["investigating", "fixProposed", "investigating", "new"]);
  });

  it("gives a report that was filed \"reported\" and no \"changed\"", async () => {
    let reports = store();
    let report = await reports.file("low");
    await reports.settled();
    await reports.alarm();
    expect(await sent()).toStrictEqual([[{
      kind: "reported", id: EVENT_ID, reportId: report.id, priority: "low", at: report.filedAt,
    }]]);
    expect(await reports.waiting()).toStrictEqual([]);
  });

  describe("lets the reporter reply when the gatekeeper cannot be told", () => {
    it.each(["reject", "hang"] as const)(
        "with a gatekeeper that answers \"%s\": the event waits, and the alarm offers it again " +
        "under the same id", async answer => {
      let clock = fakeClock();
      vi.spyOn(console, "warn").mockImplementation(() => {});
      let reports = store();
      let report = await reports.file();
      await reports.settled();
      await vendor.answerEvents(answer);

      let entry = await reports.run(host => host.reply(ADA, report.id, REPLY));
      expect(entry).toMatchObject({ visibility: "public", text: REPLY });
      // The reply has returned, and the call that tells of it has not been taken.
      await until(async () => (await sent()).length === 2);
      if (answer === "hang") {
        // The call is given up on: the clock is moved inside the store, where its timer fires.
        await reports.run(() => clock.advance(EVENT_RETRY_MS));
      }
      await reports.settled();
      expect(await reports.waiting()).toStrictEqual([2]);
      let [id] = await reports.waitingIds();
      expect((await sent())[1]).toStrictEqual([
        { kind: "changed", id, reportId: report.id, change: "reply", at: entry.at },
      ]);

      await vendor.answerEvents("take");
      await vendor.releaseEvents();
      await reports.alarm();
      expect((await sent()).at(-1)).toStrictEqual((await sent())[1]);
      expect(await sent()).toHaveLength(3);
      expect(await reports.waiting()).toStrictEqual([]);
    });

    it.each([
      ["turned off", { mode: "disabled" }],
      ["not bound", { bound: false }],
    ] as [string, Partial<Deployment>][])(
        "with a gatekeeper that is %s: nobody is told, and no event is kept",
        async (_name, deployment) => {
      let reports = store();
      let report = await reports.file();
      await reports.settled();
      Object.assign(reports.on, deployment);

      let entry = await reports.run(host => host.reply(ADA, report.id, REPLY));
      expect(entry).toMatchObject({ visibility: "public", text: REPLY });
      await reports.settled();
      expect(await reports.waiting()).toStrictEqual([]);
      await reports.alarm();
      expect(await sent()).toHaveLength(1);
      expect((await reports.run(host => host.getOwn("ada", report.id))).entries)
          .toStrictEqual([entry]);
    });
  });

  it("writes the event with the entry", async () => {
    let reports = store();
    let report = await reports.file();
    await reports.settled();
    // The delivery is held, so what the reply wrote is still there to be read.
    await vendor.answerEvents("hang");
    let entry = await reports.run(host => host.reply(ADA, report.id, REPLY));
    let thread = async () => (await reports.run(host => host.getOwn("ada", report.id))).entries;
    expect(await thread()).toStrictEqual([entry]);
    expect(await reports.sql("SELECT seq, kind, report_id, label, status, at FROM events"))
        .toStrictEqual([{
          seq: 2, kind: "changed", report_id: report.id, label: "reply", status: null,
          at: entry.at.getTime(),
        }]);

    // A refused reply left neither.
    await expect(reports.run(host => host.reply(ADA, report.id, " "))).rejects.toThrow(TypeError);
    await expect(reports.run(host => host.reply(GRACE, report.id, REPLY))).rejects.toThrow();
    expect(await thread()).toStrictEqual([entry]);
    expect(await reports.waiting()).toStrictEqual([2]);

    await vendor.answerEvents("take");
    await vendor.releaseEvents();
    await reports.settled();
  });
});

describe("a change whose event cannot be written", () => {
  it("is undone, whichever write made it", async () => {
    let reports = store();
    let report = await reports.file();
    await reports.setStatus(report.id, "answered");
    await reports.settled();
    let read = () => reports.run(host => host.get(report.id));
    let before = await read();
    await reports.sql(`CREATE TRIGGER no_event BEFORE INSERT ON events
        BEGIN SELECT RAISE(ABORT, 'The event cannot be written.'); END`);

    let label = { via: "api" } as const;
    for (let write of [
      (host: IssueReportsDurableObject) => host.reply(ADA, report.id, "Any news?"),
      (host: IssueReportsDurableObject) =>
          host.addEntry(GRACE, label, report.id, "Looking.", "admins"),
      (host: IssueReportsDurableObject) => host.setStatus(GRACE, label, report.id, "closed"),
      (host: IssueReportsDurableObject) => host.claim(GRACE, label, report.id),
      (host: IssueReportsDurableObject) => host.setLinks(report.id, ["https://example.test/1"]),
      (host: IssueReportsDurableObject) => host.submit(
          ADA, { text: "Another report.", priority: "low" }, false),
    ]) {
      await expect(reports.run(write)).rejects.toThrow("The event cannot be written.");
    }

    expect(await read()).toStrictEqual(before);
    expect(await reports.count("reports")).toBe(1);
    expect(await reports.waiting()).toStrictEqual([]);
  });
});

describe("a store whose events table has no status column", () => {
  // The table as a store made without the column holds it.
  const EVENTS_WITHOUT_STATUS = `CREATE TABLE events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL,
      kind TEXT NOT NULL,
      report_id TEXT NOT NULL,
      label TEXT NOT NULL,
      at INTEGER NOT NULL
    ) STRICT`;

  it("gains the column when the store next starts, keeps each event that waited, and tells " +
      "of a status set then", async () => {
    let reports = store();
    await reports.run((_host, state) => {
      let db = state.storage.sql;
      db.exec("DROP TABLE events");
      db.exec(EVENTS_WITHOUT_STATUS);
      db.exec(`INSERT INTO events (id, kind, report_id, label, at)
               VALUES ('event-1', 'reported', 'r-old', 'low', 1000),
                      ('event-2', 'investigationComplete', 'r-old', 'answered', 2000)`);
    });

    // The store is made again over the same storage, as its next start makes it.
    let report = await reports.run(async (host, state) => {
      let restarted = new IssueReportsDurableObject(state, host["env"]);
      let column = state.storage.sql.exec(
          `SELECT type, "notnull" FROM pragma_table_info('events') WHERE name = 'status'`)
          .toArray();
      expect(column).toStrictEqual([{ type: "TEXT", notnull: 0 }]);
      let filed = await restarted.submit(ADA, { text: "It broke.", priority: "high" }, false);
      await restarted.setStatus(GRACE, { via: "api" }, filed.id, "fixSuggested");
      return filed;
    });
    await reports.settled();

    expect((await sent()).flat()).toStrictEqual([
      { kind: "reported", id: "event-1", reportId: "r-old", priority: "low", at: new Date(1000) },
      { kind: "investigationComplete", id: "event-2", reportId: "r-old", status: "answered",
        at: new Date(2000) },
      { kind: "reported", id: EVENT_ID, reportId: report.id, priority: "high",
        at: report.filedAt },
      { kind: "changed", id: EVENT_ID, reportId: report.id, change: "status",
        status: "fixSuggested", at: expect.any(Date) },
    ]);
    expect(await reports.waiting()).toStrictEqual([]);
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
    // The report, its two changes of status and, before the second, the investigation's end.
    expect(await reports.waiting()).toStrictEqual([1, 2, 3, 4]);
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
    expect(await reports.waiting()).toStrictEqual([2, 3, 4]);
    expect(logged.mock.calls.map(([entry]) => entry as Record<string, unknown>)
        .filter(entry => entry.event === "issue.reports.events.dropped")
        .map(entry => entry.size)).toStrictEqual([1]);

    await vendor.answerEvents("take");
    await reports.alarm();
    expect((await sent()).at(-1)).toStrictEqual([
      expect.objectContaining({ kind: "changed", status: "investigating" }),
      expect.objectContaining({ kind: "investigationComplete", status: "answered" }),
      expect.objectContaining({ kind: "changed", status: "answered" }),
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

  it("keeps an event written while a check found the gatekeeper off, and sends it once it is on",
      async () => {
    let reports = store();
    await vendor.answerEvents("reject");
    await reports.file();
    await reports.settled();
    await vendor.answerEvents("take");
    reports.on.mode = "disabled";
    let later: string | undefined;
    reports.on.whileConfigIsRead = async (store) => {
      reports.on.whileConfigIsRead = undefined;
      // Turned on, and a report filed, while the read that says "off" is on its way.
      reports.on.mode = "enabled";
      later = (await store.submit(ADA, { text: "The page is blank.", priority: "low" }, false)).id;
    };
    let before = (await sent()).length;

    await reports.alarm();
    await reports.settled();

    expect(await reports.waiting()).toStrictEqual([]);
    expect((await sent()).slice(before)).toStrictEqual(
        [[expect.objectContaining({ kind: "reported", reportId: later })]]);
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

  it("moves a day-ahead alarm to within a minute of a write to a report", async () => {
    let clock = fakeClock();
    let reports = store();
    let report = await reports.file();
    await reports.settled();
    await reports.alarm();
    // A write that changes nothing leaves the alarm where it is.
    await reports.setStatus(report.id, "new");
    expect(await reports.alarmAt()).toBe(Date.now() + DAY_MS);
    clock.advance(HOUR_MS);
    await reports.setStatus(report.id, "investigating");
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
