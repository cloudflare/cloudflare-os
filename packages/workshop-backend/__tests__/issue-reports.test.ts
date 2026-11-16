import { env } from "cloudflare:workers";
import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ISSUE_REPORT_ERROR_CODES, ISSUE_REPORT_PAGE_SIZE, MAX_ADMIN_AUDIT_ARG_LENGTH,
  MAX_ISSUE_REPORTS_PER_DAY, MAX_ISSUE_REPORT_APP_VERSION_LENGTH, MAX_ISSUE_REPORT_LINKS,
  MAX_ISSUE_REPORT_LINK_LENGTH, MAX_ISSUE_REPORT_REPLIES_PER_DAY, MAX_ISSUE_REPORT_TEXT_LENGTH,
  MAX_ISSUE_REPORT_THREAD_ENTRIES, getIssueReportErrorCode,
  type AiChatAuthorInfo, type IssueReportErrorCode, type IssueReportGrant,
  type IssueReportInput, type PublicApi,
} from "@gadgets/workshop-shared/api";
import type { AdminAuditDurableObject } from "../src/admin-audit.js";
import { IssueReportsDurableObject } from "../src/issue-reports.js";
import type { OverseerDurableObject } from "../src/overseer.js";
import server from "../src/server.js";
import type { UserDurableObject } from "../src/user.js";
import {
  DEFAULT_ADMIN_CONFIG, type AdminConfig,
} from "../src/storage-schema/admin-settings-storage.js";
// Load the whole backend (the pool's `main`) up front, so its slow load does not count against the
// first test's timeout.
import "./test-worker.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_ISSUE_REPORTS: DurableObjectNamespace<IssueReportsDurableObject>;
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
    TEST_ADMIN_AUDIT: DurableObjectNamespace<AdminAuditDurableObject>;
    ISSUE_IMAGES: R2Bucket;
  }
}

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

type Person = Pick<AiChatAuthorInfo, "id" | "name">;
const ADA: Person = { id: "ada", name: "Ada" };
const BEN: Person = { id: "ben", name: "Ben" };
const GRACE: Person = { id: "grace@example.test", name: "Grace (admin)" };
const HEDY: Person = { id: "hedy@example.test", name: "Hedy (admin)" };

const NOT_FOUND = ISSUE_REPORT_ERROR_CODES.notFound;

function store() {
  let stub = env.TEST_ISSUE_REPORTS.getByName(crypto.randomUUID());
  // The store's methods are called on the instance itself, so that a refusal arrives as the
  // error it threw, with its code.
  let run = <T>(
      f: (reports: IssueReportsDurableObject, state: DurableObjectState) => T | Promise<T>) =>
      runInDurableObject(stub, f);
  let sql = <T extends Record<string, SqlStorageValue>>(query: string,
      ...params: SqlStorageValue[]) =>
      run((_reports, state) => state.storage.sql.exec<T>(query, ...params).toArray());
  let count = async (table: string) =>
      (await sql<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`))[0].count;
  return { run, sql, count };
}

function input(patch: Partial<IssueReportInput> = {}): IssueReportInput {
  return { text: "The export button does nothing.", priority: "medium", ...patch };
}

// What a call threw: the refusal's code, or "TypeError" for invalid input.
async function refusal(call: () => unknown): Promise<IssueReportErrorCode | "TypeError"> {
  try {
    await call();
  } catch (error) {
    let code = getIssueReportErrorCode(error);
    if (code !== undefined) return code;
    if (error instanceof TypeError) return "TypeError";
    throw error;
  }
  throw new Error("Expected a refusal.");
}

// The clock the store reads, moved by hand: the tests that fill a day's bound go on the next
// day without weakening it. It starts in the future, at noon UTC, and only moves forward, so no
// alarm the store sets comes due while a test runs.
function fakeClock(): { advance(ms: number): void; nextDay(): void } {
  let noon = (Math.floor(Date.now() / DAY_MS) + 2) * DAY_MS + 12 * HOUR_MS;
  vi.useFakeTimers({ toFake: ["Date"], now: noon });
  return {
    advance: ms => { vi.setSystemTime(Date.now() + ms); },
    nextDay: () => { vi.setSystemTime(Date.now() + DAY_MS); },
  };
}

// Stands in for the deployment's AdminSettings, which the store's alarm asks for its retention.
function answerRetention(state: DurableObjectState,
    committedAdminConfig: () => Promise<Partial<AdminConfig>>): void {
  Object.defineProperty(state, "exports", {
    configurable: true,
    value: { AdminSettings: { getByName: () => ({ committedAdminConfig }) } },
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("filing an issue report", () => {
  it("stamps the report and returns it new and seen", async () => {
    let { run } = store();
    let before = Date.now();
    let report = await run(reports => reports.submit(ADA, input({
      priority: "high", context: { workspaceId: "w1", chatId: 4, gadgetId: 0, appVersion: "1.2.3" },
    }), true));
    expect(report).toStrictEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      filedAt: expect.any(Date),
      reporter: { id: "ada", name: "Ada" },
      text: "The export button does nothing.",
      priority: "high",
      context: { workspaceId: "w1", chatId: 4, gadgetId: 0, appVersion: "1.2.3" },
      status: "new",
      images: [],
      unseen: false,
    });
    expect(report.filedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(await run(reports => reports.getOwn("ada", report.id)))
        .toStrictEqual({ ...report, entries: [] });
    let { unseen: _unseen, ...shared } = report;
    expect(await run(reports => reports.get(report.id))).toStrictEqual({
      ...shared, links: [], updatedAt: report.filedAt, entries: [],
    });
  });

  it("keeps the id and the name of a profile and nothing else of it", async () => {
    let { run, sql } = store();
    let profile = {
      id: "ada", name: "Ada", type: "human", commitEmail: "ada@example.test",
      description: "Counts things.",
    } as Person;
    let report = await run(reports => reports.submit(profile, input(), false));
    await run(reports => reports.reply(profile, report.id, "Any news?"));
    await run(reports => reports.addEntry(
        { ...GRACE, commitEmail: "grace@corp.example" } as Person, { via: "api" }, report.id,
        "Looking.",
        "public"));

    let read = await run(reports => reports.get(report.id));
    expect(read.reporter).toStrictEqual({ id: "ada", name: "Ada" });
    expect(read.entries.map(entry => entry.author)).toStrictEqual(
        [{ id: "ada", name: "Ada" }, { id: "grace@example.test", name: "Grace (admin)" }]);
    let stored = JSON.stringify([
      await sql("SELECT * FROM reports"), await sql("SELECT * FROM entries"),
    ]);
    for (let withheld of ["commitEmail", "ada@example.test", "grace@corp.example", "human",
        "Counts things."]) {
      expect(stored, withheld).not.toContain(withheld);
    }
  });

  it("takes a text of 2,000 UTF-16 code units once trimmed, and no longer", async () => {
    let { run } = store();
    let longest = "x".repeat(MAX_ISSUE_REPORT_TEXT_LENGTH);
    let report = await run(reports =>
        reports.submit(ADA, input({ text: `  ${longest}\n ` }), false));
    expect(report.text).toBe(longest);

    for (let text of [`${longest}x`, "😀".repeat(1001), "", "  \n\t "]) {
      expect(await refusal(() => run(reports => reports.submit(ADA, input({ text }), false))),
          `${text.length} code units`).toBe("TypeError");
    }
    // 1,000 astral characters are 2,000 code units.
    await run(reports => reports.submit(ADA, input({ text: "😀".repeat(1000) }), false));
    expect((await run(reports => reports.listOwn("ada"))).reports).toHaveLength(2);
  });

  it("refuses a priority that is not one and a malformed context", async () => {
    let { run, count } = store();
    let refused = (patch: object) =>
        refusal(() => run(reports => reports.submit(ADA, input(patch as never), false)));
    expect(await refused({ priority: "urgent" })).toBe("TypeError");
    // A chat or a gadget is named with its workspace.
    expect(await refused({ context: { chatId: 4 } })).toBe("TypeError");
    expect(await refused({ context: { gadgetId: 1 } })).toBe("TypeError");
    for (let id of [-1, 1.5, NaN, "4", 2 ** 53]) {
      expect(await refused({ context: { workspaceId: "w1", chatId: id } }), String(id))
          .toBe("TypeError");
      expect(await refused({ context: { workspaceId: "w1", gadgetId: id } }), String(id))
          .toBe("TypeError");
    }
    expect(await refused({ context: { workspaceId: "" } })).toBe("TypeError");
    expect(await refused({ context: { workspaceId: "w".repeat(1001) } })).toBe("TypeError");
    expect(await count("reports")).toBe(0);
  });

  it("rebuilds the context field by field", async () => {
    let { run, sql } = store();
    let context = { workspaceId: "w1", chatId: 4, title: "Secret plans", owner: "ben" };
    let report = await run(reports => reports.submit(ADA, input({ context }), true));
    expect(report.context).toStrictEqual({ workspaceId: "w1", chatId: 4 });
    expect(JSON.stringify(await sql("SELECT * FROM reports"))).not.toContain("Secret plans");
    // A report from the home page names nothing, and owns no workspace whatever the caller said.
    let home = await run(reports => reports.submit(ADA, input(), true));
    expect(home.context).toStrictEqual({});
    expect(await sql("SELECT workspace_id, owns_workspace FROM reports ORDER BY seq"))
        .toStrictEqual([
          { workspace_id: "w1", owns_workspace: 1 }, { workspace_id: null, owns_workspace: 0 },
        ]);
  });

  it("trims the app version, cuts a long one and drops a blank one", async () => {
    let { run } = store();
    let long = "v".repeat(MAX_ISSUE_REPORT_APP_VERSION_LENGTH) + "w".repeat(50);
    let versions = ["  1.2.3  ", `  ${long} `, "   "];
    let ids: string[] = [];
    for (let appVersion of versions) {
      ids.push((await run(reports => reports.submit(ADA, input({ context: { appVersion } }),
          false))).id);
    }
    let expected = [
      { appVersion: "1.2.3" }, { appVersion: "v".repeat(MAX_ISSUE_REPORT_APP_VERSION_LENGTH) }, {},
    ];
    let own = await run(reports => reports.listOwn("ada"));
    let all = await run(reports => reports.list({ limit: 10 }));
    for (let [i, id] of ids.entries()) {
      expect((await run(reports => reports.get(id))).context).toStrictEqual(expected[i]);
      expect((await run(reports => reports.getOwn("ada", id))).context).toStrictEqual(expected[i]);
      expect(own.reports.find(report => report.id === id)!.context).toStrictEqual(expected[i]);
      expect(all.reports.find(report => report.id === id)!.context).toStrictEqual(expected[i]);
    }
    expect("appVersion" in own.reports.find(report => report.id === ids[2])!.context).toBe(false);
  });

  it("refuses the 21st report of a UTC day, and takes one the next day", async () => {
    let clock = fakeClock();
    let { run, count } = store();
    await run(async reports => {
      for (let i = 0; i < MAX_ISSUE_REPORTS_PER_DAY; i++) await reports.submit(ADA, input(), false);
    });
    expect(await refusal(() => run(reports => reports.submit(ADA, input(), false))))
        .toBe(ISSUE_REPORT_ERROR_CODES.tooManyReports);
    // The bound is each reporter's own.
    await run(reports => reports.submit(BEN, input(), false));
    expect(await count("reports")).toBe(MAX_ISSUE_REPORTS_PER_DAY + 1);

    // Still the same UTC day eleven hours on; the next one starts at midnight.
    clock.advance(11 * HOUR_MS);
    expect(await refusal(() => run(reports => reports.submit(ADA, input(), false))))
        .toBe(ISSUE_REPORT_ERROR_CODES.tooManyReports);
    clock.advance(2 * HOUR_MS);
    await run(reports => reports.submit(ADA, input(), false));
  });

  it("sets the alarm with the first report and leaves it where it is with the next", async () => {
    let clock = fakeClock();
    let { run } = store();
    expect(await run((_reports, state) => state.storage.getAlarm())).toBeNull();
    await run(reports => reports.submit(ADA, input(), false));
    let alarm = await run((_reports, state) => state.storage.getAlarm());
    expect(alarm).toBe(Date.now() + DAY_MS);
    clock.advance(HOUR_MS);
    await run(reports => reports.submit(ADA, input(), false));
    expect(await run((_reports, state) => state.storage.getAlarm())).toBe(alarm);
  });
});

describe("who an issue report keeps", () => {
  it("bounds a display name of any length, on the report and on every entry", async () => {
    let clock = fakeClock();
    let { run, sql } = store();
    let verbose: Person = { id: "ada", name: "N".repeat(1_000_000) };
    let report = await run(reports => reports.submit(verbose, input(), false));
    // 200 replies, 100 a UTC day.
    for (let day = 0; day < 2; day++) {
      await run(reports => {
        for (let i = 0; i < MAX_ISSUE_REPORT_REPLIES_PER_DAY; i++) {
          reports.reply(verbose, report.id, `Reply ${i}`);
        }
      });
      clock.nextDay();
    }

    let kept = `${"N".repeat(MAX_ADMIN_AUDIT_ARG_LENGTH - 1)}…`;
    let read = await run(reports => reports.get(report.id));
    expect(read.reporter.name).toBe(kept);
    expect(read.entries).toHaveLength(200);
    expect(new Set(read.entries.map(entry => entry.author.name))).toStrictEqual(new Set([kept]));
    let page = await run(reports => reports.list({ limit: 50 }));
    expect(page.reports[0].reporter.name).toBe(kept);
    for (let answer of [read, page]) {
      expect(JSON.stringify(answer).length).toBeLessThan(1024 * 1024);
    }
    expect(await sql(`SELECT MAX(LENGTH(reporter_name)) AS longest FROM reports
        UNION ALL SELECT MAX(LENGTH(author_name)) FROM entries`))
        .toStrictEqual([{ longest: 256 }, { longest: 256 }]);
  });

  it("keeps two long ids that share a start apart", async () => {
    let { run } = store();
    let start = "u".repeat(290);
    let one: Person = { id: `${start}${"1".repeat(10)}`, name: "One" };
    let two: Person = { id: `${start}${"2".repeat(10)}`, name: "Two" };
    let first = await run(reports => reports.submit(one, input({ text: "One's" }), false));
    let second = await run(reports => reports.submit(two, input({ text: "Two's" }), false));
    expect(first.reporter.id).toHaveLength(MAX_ADMIN_AUDIT_ARG_LENGTH);
    expect(first.reporter.id).not.toBe(second.reporter.id);

    for (let [reader, own, other] of [[one, first, second], [two, second, first]] as const) {
      expect((await run(reports => reports.listOwn(reader.id))).reports.map(report => report.id))
          .toStrictEqual([own.id]);
      expect((await run(reports => reports.getOwn(reader.id, own.id))).text).toBe(own.text);
      expect(await refusal(() => run(reports => reports.getOwn(reader.id, other.id))))
          .toBe(NOT_FOUND);
      expect(await refusal(() => run(reports => reports.reply(reader, other.id, "Mine?"))))
          .toBe(NOT_FOUND);
      // The filter takes the whole id, and the form a report shows.
      for (let reporter of [reader.id, own.reporter.id]) {
        let page = await run(reports => reports.list({ reporter, limit: 10 }));
        expect(page.reports.map(report => report.id)).toStrictEqual([own.id]);
      }
    }
    expect((await run(reports => reports.get(first.id))).entries).toStrictEqual([]);

    // What is unseen, the mark and the grant's link take the whole id as well.
    await run(reports => reports.addEntry(GRACE, { via: "api" }, first.id, "Try again now.", "public"));
    expect(await run(reports => reports.unseenCount(one.id))).toBe(1);
    expect(await run(reports => reports.unseenCount(two.id))).toBe(0);
    expect(await refusal(() => run(reports => reports.markSeen(two.id, first.id))))
        .toBe(NOT_FOUND);
    await run(reports => reports.markSeen(one.id, first.id));
    expect(await run(reports => reports.unseenCount(one.id))).toBe(0);

    let grant = accountGrant();
    expect(await refusal(() => run(reports => reports.checkGrantLink(
        two.id, first.id, { scope: "account" })))).toBe(NOT_FOUND);
    expect(await refusal(() => run(reports => reports.noteGrant(two.id, grant, first.id))))
        .toBe(NOT_FOUND);
    await run(reports => {
      reports.checkGrantLink(one.id, first.id, { scope: "account" });
      reports.noteGrant(one.id, grant, first.id);
    });
    expect((await run(reports => reports.getOwn(one.id, first.id))).grant)
        .toStrictEqual(shown(grant));
    // Its end is its owner's to note: the other's word for it changes nothing.
    let ended = { ...grant, endedAt: new Date() };
    await run(reports => reports.noteGrant(two.id, ended));
    expect((await run(reports => reports.getOwn(one.id, first.id))).grant)
        .toStrictEqual(shown(grant));
    await run(reports => reports.noteGrant(one.id, ended));
    expect((await run(reports => reports.getOwn(one.id, first.id))).grant)
        .toStrictEqual(shown(ended));
  });
});

describe("what a reporter has seen", () => {
  it("is raised by an admin's public entry and lowered by its own reporter alone", async () => {
    let { run } = store();
    let report = await run(reports => reports.submit(ADA, input(), false));
    let bens = await run(reports => reports.submit(BEN, input(), false));
    await run(reports => reports.addEntry(GRACE, { via: "api" }, report.id, "Try again now.", "public"));

    let adas = async () => ({
      count: await run(reports => reports.unseenCount("ada")),
      one: (await run(reports => reports.getOwn("ada", report.id))).unseen,
      listed: (await run(reports => reports.listOwn("ada"))).reports[0].unseen,
    });
    expect(await adas()).toStrictEqual({ count: 1, one: true, listed: true });
    expect(await run(reports => reports.unseenCount("ben"))).toBe(0);

    // Another reporter marking it is refused as an unknown id is, and changes nothing of it.
    expect(await refusal(() => run(reports => reports.markSeen("ben", report.id)))).toBe(NOT_FOUND);
    expect(await refusal(() => run(reports => reports.markSeen("ben", crypto.randomUUID()))))
        .toBe(NOT_FOUND);
    expect(await adas()).toStrictEqual({ count: 1, one: true, listed: true });
    expect(await run(reports => reports.unseenCount("ben"))).toBe(0);
    expect((await run(reports => reports.getOwn("ben", bens.id))).unseen).toBe(false);

    await run(reports => reports.markSeen("ada", report.id));
    expect(await adas()).toStrictEqual({ count: 0, one: false, listed: false });
    // Marking again is fine, and a later answer makes it unseen again.
    await run(reports => reports.markSeen("ada", report.id));
    await run(reports => reports.addEntry(HEDY, { via: "cli" }, report.id, "Fixed.", "public"));
    expect(await adas()).toStrictEqual({ count: 1, one: true, listed: true });
  });

  it("counts reports, not entries", async () => {
    let { run } = store();
    let ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push((await run(reports => reports.submit(ADA, input(), false))).id);
    }
    for (let id of ids.slice(0, 2)) {
      await run(reports => {
        reports.addEntry(GRACE, { via: "api" }, id, "First.", "public");
        reports.addEntry(GRACE, { via: "api" }, id, "Second.", "public");
      });
    }
    expect(await run(reports => reports.unseenCount("ada"))).toBe(2);
  });
});

describe("an issue report's thread", () => {
  it("keeps an admins-only entry from everything its reporter reads", async () => {
    let clock = fakeClock();
    let { run } = store();
    let report = await run(reports => reports.submit(ADA, input(), false));
    await run(reports => reports.reply(ADA, report.id, "It still happens."));
    let reads = async () => ({
      one: await run(reports => reports.getOwn("ada", report.id)),
      page: await run(reports => reports.listOwn("ada")),
      count: await run(reports => reports.unseenCount("ada")),
    });
    let before = await reads();

    clock.advance(HOUR_MS);
    let note = await run(reports => reports.addEntry(
        GRACE, { via: "api" }, report.id, "Looks like the quota bug.", "admins"));
    expect(note).toMatchObject({
      visibility: "admins", via: "api", text: "Looks like the quota bug.",
      author: { id: "grace@example.test", name: "Grace (admin)" },
    });
    let after = await reads();
    expect(after).toStrictEqual(before);
    expect(JSON.stringify(after)).not.toContain("quota bug");

    // The admins read it, in the order it was written, and see the thread grew.
    let read = await run(reports => reports.get(report.id));
    expect(read.entries.map(entry => entry.visibility)).toStrictEqual(["public", "admins"]);
    expect(read.updatedAt).toStrictEqual(note.at);
  });

  it("names the admin who changed a status, publicly, and leaves the report seen", async () => {
    let { run } = store();
    let report = await run(reports => reports.submit(ADA, input(), false));
    await run(reports => reports.setStatus(GRACE, { via: "cli" }, report.id, "investigating"));

    let own = await run(reports => reports.getOwn("ada", report.id));
    expect(own.status).toBe("investigating");
    expect(own.unseen).toBe(false);
    expect(await run(reports => reports.unseenCount("ada"))).toBe(0);
    expect(own.entries).toStrictEqual([{
      id: expect.any(String), at: expect.any(Date), author: { name: "Grace (admin)" },
      visibility: "public", via: "cli", text: "", status: "investigating",
    }]);

    // The status it already has adds nothing.
    await run(reports => reports.setStatus(HEDY, { via: "api" }, report.id, "investigating"));
    expect((await run(reports => reports.get(report.id))).entries).toHaveLength(1);

    // An admin's written public entry is what makes it unseen.
    await run(reports => reports.addEntry(GRACE, { via: "cli" }, report.id, "Found it.", "public"));
    expect((await run(reports => reports.getOwn("ada", report.id))).unseen).toBe(true);
    expect(await run(reports => reports.unseenCount("ada"))).toBe(1);
    // A status set after it leaves it unseen, and one set after it was seen leaves it seen.
    await run(reports => reports.setStatus(GRACE, { via: "cli" }, report.id, "answered"));
    expect(await run(reports => reports.unseenCount("ada"))).toBe(1);
    await run(reports => reports.markSeen("ada", report.id));
    await run(reports => reports.setStatus(GRACE, { via: "cli" }, report.id, "closed"));
    expect(await run(reports => reports.unseenCount("ada"))).toBe(0);
    expect(await refusal(() => run(reports => reports.setStatus(
        GRACE, { via: "cli" }, report.id, "resolved" as never)))).toBe("TypeError");
  });

  it("puts a report back in front of the admins when its reporter replies", async () => {
    let { run } = store();
    let report = await run(reports => reports.submit(ADA, input(), false));
    let status = async () => (await run(reports => reports.get(report.id))).status;

    // A reply to a new or an investigated report leaves its status.
    expect((await run(reports => reports.reply(ADA, report.id, "More detail."))).status)
        .toBeUndefined();
    expect(await status()).toBe("new");
    await run(reports => reports.setStatus(GRACE, { via: "api" }, report.id, "investigating"));
    await run(reports => reports.reply(ADA, report.id, "And more."));
    expect(await status()).toBe("investigating");

    for (let set of ["answered", "waitingOnReporter"] as const) {
      await run(reports => reports.setStatus(GRACE, { via: "api" }, report.id, set));
      let reply = await run(reports => reports.reply(ADA, report.id, `  After ${set}.  `));
      expect(reply).toStrictEqual({
        id: expect.any(String), at: expect.any(Date), author: { id: "ada", name: "Ada" },
        visibility: "public", text: `After ${set}.`, status: "withAdmin",
      });
      expect(await status()).toBe("withAdmin");
    }
    // Already with the admins: the next reply sets nothing.
    expect((await run(reports => reports.reply(ADA, report.id, "Hello?"))).status).toBeUndefined();

    await run(reports => reports.setStatus(GRACE, { via: "api" }, report.id, "closed"));
    expect(await refusal(() => run(reports => reports.reply(ADA, report.id, "One more thing."))))
        .toBe(ISSUE_REPORT_ERROR_CODES.closed);
    expect(await status()).toBe("closed");
    // The admins still write in a closed report, and reopen it by setting a status.
    await run(reports => reports.addEntry(GRACE, { via: "api" }, report.id, "Reopening.", "public"));
    await run(reports => reports.setLinks(report.id, ["https://example.com/1"]));
    await run(reports => reports.setStatus(GRACE, { via: "api" }, report.id, "investigating"));
    await run(reports => reports.reply(ADA, report.id, "Thanks."));
  });

  it("refuses a text that is not one, and an unknown report", async () => {
    let { run, count } = store();
    let report = await run(reports => reports.submit(ADA, input(), false));
    let unknown = crypto.randomUUID();
    let long = "x".repeat(MAX_ISSUE_REPORT_TEXT_LENGTH + 1);
    for (let text of ["", "   ", long]) {
      expect(await refusal(() => run(reports => reports.reply(ADA, report.id, text))))
          .toBe("TypeError");
      expect(await refusal(() => run(reports => reports.addEntry(
          GRACE, { via: "api" }, report.id, text, "public")))).toBe("TypeError");
    }
    expect(await refusal(() => run(reports => reports.addEntry(
        GRACE, { via: "api" }, report.id, "Hello.", "everyone" as never)))).toBe("TypeError");
    expect(await count("entries")).toBe(0);

    expect(await refusal(() => run(reports => reports.reply(ADA, unknown, "Hi.")))).toBe(NOT_FOUND);
    expect(await refusal(() => run(reports => reports.getOwn("ada", unknown)))).toBe(NOT_FOUND);
    expect(await refusal(() => run(reports => reports.get(unknown)))).toBe(NOT_FOUND);
    expect(await refusal(() => run(reports => reports.addEntry(
        GRACE, { via: "api" }, unknown, "Hi.", "public")))).toBe(NOT_FOUND);
    expect(await refusal(() => run(reports => reports.setStatus(GRACE, { via: "api" }, unknown, "closed"))))
        .toBe(NOT_FOUND);
    expect(await refusal(() => run(reports => reports.setLinks(unknown, [])))).toBe(NOT_FOUND);
  });

  it("bounds the reporter's replies, the admins' answers and the admins' notes apart", async () => {
    let clock = fakeClock();
    let { run } = store();
    let report = await run(reports => reports.submit(ADA, input(), false));
    let full = ISSUE_REPORT_ERROR_CODES.threadFull;
    let admins = (visibility: "public" | "admins", times: number) => run(reports => {
      for (let i = 0; i < times; i++) {
        reports.addEntry(GRACE, { via: "api" }, report.id, "Entry.", visibility);
      }
    });

    // The admins fill their notes: their answers and the reporter's replies still go in.
    await admins("admins", MAX_ISSUE_REPORT_THREAD_ENTRIES);
    expect(await refusal(() => admins("admins", 1))).toBe(full);
    await admins("public", MAX_ISSUE_REPORT_THREAD_ENTRIES - 1);
    await run(reports => reports.reply(ADA, report.id, "Reply 1."));

    // The reporter fills their side over two UTC days, 100 replies a day.
    let replies = (times: number) => run(reports => {
      for (let i = 0; i < times; i++) reports.reply(ADA, report.id, "Reply.");
    });
    await replies(MAX_ISSUE_REPORT_REPLIES_PER_DAY - 1);
    clock.nextDay();
    await replies(MAX_ISSUE_REPORT_REPLIES_PER_DAY);
    clock.nextDay();
    expect(await refusal(() => run(reports => reports.reply(ADA, report.id, "The 201st."))))
        .toBe(full);

    // After the reporter's 200th reply an admin still answers, and the reporter reads it.
    await run(reports => reports.markSeen("ada", report.id));
    let answer = await run(reports =>
        reports.addEntry(GRACE, { via: "api" }, report.id, "Last word.", "public"));
    expect(await run(reports => reports.unseenCount("ada"))).toBe(1);
    let own = await run(reports => reports.getOwn("ada", report.id));
    expect(own.entries.at(-1)).toMatchObject({ id: answer.id, text: "Last word." });
    expect(own.entries).toHaveLength(2 * MAX_ISSUE_REPORT_THREAD_ENTRIES);
    // That was the admins' 200th answer: the 201st is refused, as their notes are.
    expect(await refusal(() => admins("public", 1))).toBe(full);
    expect(await refusal(() => admins("admins", 1))).toBe(full);

    // A full thread is still closed, and the change is entered in it.
    await run(reports => reports.setStatus(HEDY, { via: "cli" }, report.id, "closed"));
    let read = await run(reports => reports.get(report.id));
    expect(read.status).toBe("closed");
    expect(read.entries).toHaveLength(3 * MAX_ISSUE_REPORT_THREAD_ENTRIES + 1);
    expect(read.entries.at(-1)).toMatchObject({
      text: "", status: "closed", visibility: "public", author: { name: "Hedy (admin)" },
    });
  });

  it("lets the reporter reply while the admins' answers are full, and the other way", async () => {
    let { run } = store();
    let report = await run(reports => reports.submit(ADA, input(), false));
    // Two changes of status come first: each is a public line of the admins' and no answer, so
    // all 200 answers still go in after them.
    await run(reports => {
      reports.setStatus(GRACE, { via: "api" }, report.id, "investigating");
      reports.setStatus(GRACE, { via: "api" }, report.id, "answered");
      for (let i = 0; i < MAX_ISSUE_REPORT_THREAD_ENTRIES; i++) {
        reports.addEntry(GRACE, { via: "api" }, report.id, "Answer.", "public");
      }
    });
    let entries = (await run(reports => reports.get(report.id))).entries;
    expect(entries.filter(entry => entry.text === "")).toHaveLength(2);
    expect(entries.filter(entry => entry.text === "Answer."))
        .toHaveLength(MAX_ISSUE_REPORT_THREAD_ENTRIES);
    expect(await refusal(() => run(reports => reports.addEntry(
        GRACE, { via: "api" }, report.id, "The 201st.", "public"))))
        .toBe(ISSUE_REPORT_ERROR_CODES.threadFull);
    // Their notes are counted apart, and so are the reporter's replies and status lines.
    await run(reports => reports.addEntry(GRACE, { via: "api" }, report.id, "A note.", "admins"));
    await run(reports => reports.reply(ADA, report.id, "Still here."));
    await run(reports => reports.setStatus(GRACE, { via: "api" }, report.id, "answered"));
    await run(reports => reports.setStatus(GRACE, { via: "api" }, report.id, "investigating"));
    expect(await refusal(() => run(reports => reports.addEntry(
        GRACE, { via: "api" }, report.id, "The 201st.", "public"))))
        .toBe(ISSUE_REPORT_ERROR_CODES.threadFull);
  });

  it("refuses the reporter's 101st reply of a UTC day across their reports", async () => {
    let clock = fakeClock();
    let { run } = store();
    let first = await run(reports => reports.submit(ADA, input(), false));
    let second = await run(reports => reports.submit(ADA, input(), false));
    let bens = await run(reports => reports.submit(BEN, input(), false));
    await run(reports => {
      for (let i = 0; i < MAX_ISSUE_REPORT_REPLIES_PER_DAY - 1; i++) {
        reports.reply(ADA, i % 2 === 0 ? first.id : second.id, "Reply.");
      }
      // An admin's entries are not the reporter's replies, even written by the same account: the
      // 100th reply of the day still goes in after one.
      reports.addEntry(ADA, { via: "api" }, bens.id, "As an admin.", "public");
      reports.reply(ADA, second.id, "The 100th.");
    });
    for (let id of [first.id, second.id]) {
      expect(await refusal(() => run(reports => reports.reply(ADA, id, "One more."))))
          .toBe(ISSUE_REPORT_ERROR_CODES.tooManyReplies);
    }
    await run(reports => reports.reply(BEN, bens.id, "Mine."));
    clock.nextDay();
    await run(reports => reports.reply(ADA, first.id, "A new day."));
  });
});

describe("an entry written through the admin gatekeeper", () => {
  const AGENT = { workspaceId: "c".repeat(64), chatId: 4 };

  it("keeps where it came from for the admins, and shows the reporter its via alone", async () => {
    let { run, sql } = store();
    let report = await run(reports => reports.submit(ADA, input(), false));

    let written = await run(reports => reports.addEntry(
        GRACE, { via: "gatekeeper", agent: AGENT }, report.id, "Try again now.", "public"));
    expect(written).toStrictEqual({
      id: expect.any(String), at: expect.any(Date), visibility: "public", via: "gatekeeper",
      agent: AGENT, text: "Try again now.",
      author: { id: "grace@example.test", name: "Grace (admin)" },
    });
    // A caller with no chat keeps none, and a change of status carries the origin too.
    let { chatId: _chatId, ...noChat } = AGENT;
    await run(reports => reports.setStatus(
        GRACE, { via: "gatekeeper", agent: noChat }, report.id, "answered"));
    await run(reports => reports.addEntry(HEDY, { via: "cli" }, report.id, "A note.", "admins"));

    let read = await run(reports => reports.get(report.id));
    expect(read.entries.map(({ via, agent, status }) => ({ via, agent, status })))
        .toStrictEqual([
          { via: "gatekeeper", agent: AGENT, status: undefined },
          { via: "gatekeeper", agent: noChat, status: "answered" },
          { via: "cli", agent: undefined, status: undefined },
        ]);
    expect(read.entries[1].agent).not.toHaveProperty("chatId");
    expect(read.entries[2]).not.toHaveProperty("agent");
    expect(await sql("SELECT via, agent FROM entries ORDER BY n")).toStrictEqual([
      { via: "gatekeeper", agent: JSON.stringify(AGENT) },
      { via: "gatekeeper", agent: JSON.stringify(noChat) },
      { via: "cli", agent: null },
    ]);

    // The reporter reads that an agent wrote it, and nothing of where: not in the report, and
    // not in the answer to their own reply.
    let own = await run(reports => reports.getOwn("ada", report.id));
    expect(own.entries.map(entry => entry.via)).toStrictEqual(["gatekeeper", "gatekeeper"]);
    for (let entry of own.entries) expect(entry).not.toHaveProperty("agent");
    expect(JSON.stringify(own)).not.toContain(AGENT.workspaceId);
    let reply = await run(reports => reports.reply(ADA, report.id, "Still broken."));
    expect(reply).not.toHaveProperty("agent");
    expect(reply).not.toHaveProperty("via");
    let page = await run(reports => reports.listOwn("ada"));
    expect(JSON.stringify(page)).not.toContain(AGENT.workspaceId);
  });

  it("copies nothing else of the caller into the entry", async () => {
    let { run, sql } = store();
    let report = await run(reports => reports.submit(ADA, input(), false));
    let caller = {
      via: "gatekeeper" as const, agent: { ...AGENT, admin: "mallory" }, insiders: ["ada"],
    };
    let written = await run(reports => reports.addEntry(
        GRACE, caller, report.id, "A note.", "admins"));
    expect(written.agent).toStrictEqual(AGENT);
    expect(await sql("SELECT agent FROM entries")).toStrictEqual(
        [{ agent: JSON.stringify(AGENT) }]);
  });

  it.each<[string, { via: unknown; agent?: unknown }]>([
    ["a via that is not one", { via: "browser" }],
    ["a gatekeeper without an origin", { via: "gatekeeper" }],
    ["an origin under cli", { via: "cli", agent: AGENT }],
    ["an origin without a workspace", { via: "gatekeeper", agent: { chatId: 4 } }],
    ["a chat that is not a whole number", { via: "gatekeeper", agent: { ...AGENT, chatId: 1.5 } }],
  ])("refuses %s before anything is written", async (_name, caller) => {
    let { run, count } = store();
    let report = await run(reports => reports.submit(ADA, input(), false));
    let before = await run(reports => reports.get(report.id));
    let malformed = caller as Parameters<IssueReportsDurableObject["addEntry"]>[1];

    expect(await refusal(() => run(reports => reports.addEntry(
        GRACE, malformed, report.id, "A note.", "admins")))).toBe("TypeError");
    expect(await refusal(() => run(reports => reports.setStatus(
        GRACE, malformed, report.id, "closed")))).toBe("TypeError");
    // Refused for the caller before the report is looked up, so an unknown report says no more.
    expect(await refusal(() => run(reports => reports.setStatus(
        GRACE, malformed, crypto.randomUUID(), "closed")))).toBe("TypeError");

    expect(await count("entries")).toBe(0);
    expect(await run(reports => reports.get(report.id))).toStrictEqual(before);
  });
});

// The schema step is the store's constructor, so a second instance over the same storage runs it
// as the store's next start does: the pool gives a test no way to restart the object in place and
// keep what it stored.
function restart(state: DurableObjectState): IssueReportsDurableObject {
  return new IssueReportsDurableObject(state, env as unknown as Cloudflare.Env);
}

describe("a store whose entries table has no agent column", () => {
  // The table as a store made without the column holds it.
  const ENTRIES_WITHOUT_AGENT = `CREATE TABLE entries (
      report_seq INTEGER NOT NULL,
      n INTEGER NOT NULL,
      id TEXT NOT NULL,
      at INTEGER NOT NULL,
      author_id TEXT NOT NULL,
      author_name TEXT NOT NULL,
      visibility TEXT NOT NULL CHECK (visibility IN ('public', 'admins')),
      via TEXT,
      text TEXT NOT NULL,
      status TEXT,
      PRIMARY KEY (report_seq, n)
    ) STRICT`;
  // A table's columns, by name: ALTER TABLE adds a column after the others, and every statement
  // of the store names its columns, so their order is not compared.
  const COLUMNS = `SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info('entries')
      ORDER BY name`;

  it("gains the column when the store next starts, keeping its entries", async () => {
    let { run, sql } = store();
    let report = await run(reports => reports.submit(ADA, input(), false));
    let { seq } = (await sql<{ seq: number }>("SELECT seq FROM reports"))[0];
    await run((_reports, state) => {
      let db = state.storage.sql;
      db.exec("DROP TABLE entries");
      db.exec(ENTRIES_WITHOUT_AGENT);
      db.exec(
        `INSERT INTO entries (report_seq, n, id, at, author_id, author_name, visibility, via,
           text, status)
         VALUES (?, 1, 'entry-1', 1000, 'ada', 'Ada', 'public', NULL, 'Any news?', NULL),
                (?, 2, 'entry-2', 2000, 'grace@example.test', 'Grace (admin)', 'admins', 'cli',
                 'Looking.', NULL)`, seq, seq);
    });
    expect((await sql<{ name: string }>(COLUMNS)).map(column => column.name))
        .not.toContain("agent");

    let migrated = await run((_reports, state) => {
      let restarted = restart(state);
      let entries = restarted.get(report.id).entries;
      let added = restarted.addEntry(GRACE, { via: "gatekeeper", agent: { workspaceId: "w" } },
          report.id, "Try again now.", "public");
      return { entries, added };
    });
    let columns = await sql(COLUMNS);
    expect(columns.map(column => column.name)).toContain("agent");
    expect(migrated.entries).toStrictEqual([
      { id: "entry-1", at: new Date(1000), author: { id: "ada", name: "Ada" },
        visibility: "public", text: "Any news?" },
      { id: "entry-2", at: new Date(2000),
        author: { id: "grace@example.test", name: "Grace (admin)" }, visibility: "admins",
        via: "cli", text: "Looking." },
    ]);
    expect(migrated.added).toMatchObject(
        { via: "gatekeeper", agent: { workspaceId: "w" }, text: "Try again now." });
    expect(await sql("SELECT n, agent FROM entries ORDER BY n")).toStrictEqual([
      { n: 1, agent: null }, { n: 2, agent: null }, { n: 3, agent: `{"workspaceId":"w"}` },
    ]);

    // A start that finds the column changes nothing.
    await run((_reports, state) => { restart(state); });
    expect(await sql(COLUMNS)).toStrictEqual(columns);
    expect((await run(reports => reports.get(report.id))).entries).toHaveLength(3);

    // A store made with the column holds the same ones.
    expect(await store().sql(COLUMNS)).toStrictEqual(columns);
  });

  it("refuses a stored origin that is not JSON, in either table", async () => {
    let fresh = store();
    let insert = `INSERT INTO entries (report_seq, n, id, at, author_id, author_name,
        visibility, via, agent, text) VALUES (1, 9, 'x', 0, 'a', 'A', 'admins', 'gatekeeper',
        'not json', '')`;
    await expect(fresh.sql(insert)).rejects.toThrow(/CHECK constraint failed/);

    let altered = store();
    await altered.run((_reports, state) => {
      state.storage.sql.exec("DROP TABLE entries");
      state.storage.sql.exec(ENTRIES_WITHOUT_AGENT);
      restart(state);
    });
    await expect(altered.sql(insert)).rejects.toThrow(/CHECK constraint failed/);
  });
});

describe("an issue report's links", () => {
  it("keeps each link as the URL it parsed to", async () => {
    let { run } = store();
    let report = await run(reports => reports.submit(ADA, input(), false));
    await run(reports =>
        reports.setLinks(report.id, ["HTTPS://Example.com/a b", "http://localhost:3000"]));
    expect((await run(reports => reports.get(report.id))).links)
        .toStrictEqual(["https://example.com/a%20b", "http://localhost:3000/"]);
  });

  it("refuses what is not an http or https URL, too many, and too long", async () => {
    let { run } = store();
    let report = await run(reports => reports.submit(ADA, input(), false));
    await run(reports => reports.setLinks(report.id, ["https://example.com/kept"]));
    let ok = "https://example.com/";
    let refused = [
      ["javascript:alert(1)"], ["data:text/html,<script>1</script>"], ["/tickets/1"],
      ["tickets.example/T-1"], ["ftp://example.com/a"], [""], [ok, "mailto:a@example.com"],
      [7 as never], Array.from({ length: MAX_ISSUE_REPORT_LINKS + 1 }, (_, i) => `${ok}${i}`),
      [`${ok}${"a".repeat(MAX_ISSUE_REPORT_LINK_LENGTH - ok.length + 1)}`],
      // Short enough as sent, too long once its spaces are encoded.
      [`${ok}${" a".repeat(900)}`],
    ];
    for (let links of refused) {
      expect(await refusal(() => run(reports => reports.setLinks(report.id, links))),
          String(links[0]).slice(0, 40)).toBe("TypeError");
    }
    expect((await run(reports => reports.get(report.id))).links)
        .toStrictEqual(["https://example.com/kept"]);

    let most = Array.from({ length: MAX_ISSUE_REPORT_LINKS }, (_, i) => `${ok}${i}`);
    most[0] = `${ok}${"a".repeat(MAX_ISSUE_REPORT_LINK_LENGTH - ok.length)}`;
    await run(reports => reports.setLinks(report.id, most));
    expect((await run(reports => reports.get(report.id))).links).toStrictEqual(most);
  });

  it("shows them to admins only", async () => {
    let { run } = store();
    let report = await run(reports => reports.submit(ADA, input(), false));
    await run(reports => reports.addEntry(GRACE, { via: "api" }, report.id, "On it.", "public"));
    let reporters = async () => ({
      one: await run(reports => reports.getOwn("ada", report.id)),
      page: await run(reports => reports.listOwn("ada")),
      count: await run(reports => reports.unseenCount("ada")),
    });
    let before = await reporters();

    let links = ["https://tickets.example/T-1", "https://example.com/pull/2"];
    await run(reports => reports.setLinks(report.id, links));
    expect((await run(reports => reports.get(report.id))).links).toStrictEqual(links);
    expect((await run(reports => reports.list({ limit: 10 }))).reports[0].links)
        .toStrictEqual(links);

    let after = await reporters();
    expect(after).toStrictEqual(before);
    for (let own of [after.one, ...after.page.reports]) {
      expect("links" in own).toBe(false);
      expect("updatedAt" in own).toBe(false);
    }
    let read = JSON.stringify(after);
    expect(read).not.toContain("tickets.example");
    expect(read).not.toContain("example.com/pull");

    await run(reports => reports.setLinks(report.id, []));
    expect((await run(reports => reports.get(report.id))).links).toStrictEqual([]);
  });
});

type NotedGrant = IssueReportGrant & { workspaceId?: string };

function workspaceGrant(patch: Partial<NotedGrant> = {}): NotedGrant {
  return {
    id: crypto.randomUUID(), scope: "workspace", workspaceId: "w1",
    expiresAt: new Date(Date.now() + 72 * HOUR_MS), ...patch,
  };
}

function accountGrant(patch: Partial<NotedGrant> = {}): NotedGrant {
  return {
    id: crypto.randomUUID(), scope: "account", expiresAt: new Date(Date.now() + 72 * HOUR_MS),
    ...patch,
  };
}

function shown({ workspaceId: _workspaceId, ...grant }: NotedGrant): IssueReportGrant {
  return grant;
}

describe("the grant given with an issue report", () => {
  it("links a workspace's grant to its owner's report of that workspace", async () => {
    let { run, sql } = store();
    let report = await run(reports => reports.submit(
        ADA, input({ context: { workspaceId: "w1" } }), true));
    let grant = workspaceGrant();
    await run(reports => {
      reports.checkGrantLink("ada", report.id, { scope: "workspace", workspaceId: "w1" });
      reports.noteGrant("ada", grant, report.id);
    });

    for (let read of [
      await run(reports => reports.getOwn("ada", report.id)),
      (await run(reports => reports.listOwn("ada"))).reports[0],
      await run(reports => reports.get(report.id)),
      (await run(reports => reports.list({ limit: 10 }))).reports[0],
    ]) {
      expect(read.grant).toStrictEqual(shown(grant));
    }
    expect(await sql("SELECT * FROM grants")).toStrictEqual([{
      id: grant.id, owner_id: "ada", scope: "workspace", workspace_id: "w1",
      expires_at: grant.expiresAt.getTime(), ended_at: null,
    }]);
  });

  it("refuses a report that is another user's, names another workspace, or holds a live grant",
      async () => {
    let { run, sql, count } = store();
    let adas = await run(reports => reports.submit(
        ADA, input({ context: { workspaceId: "w1" } }), true));
    let bens = await run(reports => reports.submit(
        BEN, input({ context: { workspaceId: "w1" } }), false));
    let home = await run(reports => reports.submit(ADA, input(), false));
    let unknown = crypto.randomUUID();
    let cases: [string, string, NotedGrant][] = [
      ["ada", bens.id, workspaceGrant()],
      ["ada", unknown, workspaceGrant()],
      ["ada", adas.id, workspaceGrant({ workspaceId: "w2" })],
      // A report from the home page names no workspace for a workspace's grant to cover.
      ["ada", home.id, workspaceGrant()],
      ["ada", home.id, workspaceGrant({ workspaceId: undefined })],
      ["ada", adas.id, { ...accountGrant(), scope: "deployment" as never }],
    ];
    let before = await sql("SELECT * FROM reports ORDER BY seq");
    for (let [owner, reportId, grant] of cases) {
      let link = { scope: grant.scope, workspaceId: grant.workspaceId, grantId: grant.id };
      expect(await refusal(() => run(reports => reports.checkGrantLink(owner, reportId, link))))
          .toBe(NOT_FOUND);
      expect(await refusal(() => run(reports => reports.noteGrant(owner, grant, reportId))))
          .toBe(NOT_FOUND);
    }
    expect(await count("grants")).toBe(0);
    expect(await sql("SELECT * FROM reports ORDER BY seq")).toStrictEqual(before);

    // A live grant is not replaced by another, and is noted again under its own id.
    let live = workspaceGrant();
    await run(reports => reports.noteGrant("ada", live, adas.id));
    let other = workspaceGrant();
    expect(await refusal(() => run(reports => reports.checkGrantLink(
        "ada", adas.id, { scope: "workspace", workspaceId: "w1", grantId: other.id }))))
        .toBe(NOT_FOUND);
    expect(await refusal(() => run(reports => reports.checkGrantLink(
        "ada", adas.id, { scope: "workspace", workspaceId: "w1" })))).toBe(NOT_FOUND);
    expect(await refusal(() => run(reports => reports.noteGrant("ada", other, adas.id))))
        .toBe(NOT_FOUND);
    await run(reports => {
      reports.checkGrantLink("ada", adas.id,
          { scope: "workspace", workspaceId: "w1", grantId: live.id });
      reports.noteGrant("ada", live, adas.id);
    });
    expect((await run(reports => reports.get(adas.id))).grant).toStrictEqual(shown(live));
    expect(await count("grants")).toBe(1);

    // Another owner's grant under the same id is not this row's, with a report or without.
    let bensHome = await run(reports => reports.submit(BEN, input(), false));
    let forged = accountGrant({ id: live.id, endedAt: new Date() });
    expect(await refusal(() => run(reports => reports.noteGrant("ben", forged, bensHome.id))))
        .toBe(NOT_FOUND);
    await run(reports => reports.noteGrant("ben", forged));
    expect((await run(reports => reports.get(adas.id))).grant).toStrictEqual(shown(live));
    expect((await run(reports => reports.get(bensHome.id))).grant).toBeUndefined();
  });

  it("links an account-wide grant only to a report whose workspace it covers", async () => {
    let { run } = store();
    let collaborates = await run(reports => reports.submit(
        ADA, input({ context: { workspaceId: "w-shared" } }), false));
    let owns = await run(reports => reports.submit(
        ADA, input({ context: { workspaceId: "w-own" } }), true));
    let home = await run(reports => reports.submit(ADA, input(), false));
    let grant = accountGrant();

    expect(await refusal(() => run(reports => reports.checkGrantLink(
        "ada", collaborates.id, { scope: "account" })))).toBe(NOT_FOUND);
    expect(await refusal(() => run(reports => reports.noteGrant("ada", grant, collaborates.id))))
        .toBe(NOT_FOUND);
    for (let report of [owns, home]) {
      await run(reports => {
        reports.checkGrantLink("ada", report.id, { scope: "account" });
        reports.noteGrant("ada", grant, report.id);
      });
      expect((await run(reports => reports.get(report.id))).grant).toStrictEqual(shown(grant));
    }
    expect((await run(reports => reports.get(collaborates.id))).grant).toBeUndefined();
  });

  it("replaces a report's grant once it was ended or has expired", async () => {
    let clock = fakeClock();
    let { run, sql } = store();
    let report = await run(reports => reports.submit(
        ADA, input({ context: { workspaceId: "w1" } }), true));
    let first = workspaceGrant();
    await run(reports => reports.noteGrant("ada", first, report.id));

    // Ended early: the copy says so, and the next grant takes its place.
    let ended = { ...first, endedAt: new Date() };
    await run(reports => reports.noteGrant("ada", ended));
    expect((await run(reports => reports.getOwn("ada", report.id))).grant)
        .toStrictEqual(shown(ended));
    let second = workspaceGrant();
    await run(reports => {
      reports.checkGrantLink("ada", report.id, { scope: "workspace", workspaceId: "w1" });
      reports.noteGrant("ada", second, report.id);
    });
    expect((await run(reports => reports.get(report.id))).grant).toStrictEqual(shown(second));

    // Expired: live until its end, then replaced.
    clock.advance(72 * HOUR_MS - 1);
    let third = workspaceGrant();
    expect(await refusal(() => run(reports => reports.noteGrant("ada", third, report.id))))
        .toBe(NOT_FOUND);
    clock.advance(1);
    await run(reports => reports.noteGrant("ada", third, report.id));
    expect((await run(reports => reports.get(report.id))).grant).toStrictEqual(shown(third));
    // Each replaced grant's row went with its link.
    expect(await sql("SELECT id FROM grants")).toStrictEqual([{ id: third.id }]);
  });

  it("shows a renewed grant's end on every report linked to it", async () => {
    let { run, sql } = store();
    let one = await run(reports => reports.submit(ADA, input(), false));
    let two = await run(reports => reports.submit(
        ADA, input({ context: { workspaceId: "w-own" } }), true));
    let grant = accountGrant();
    let later = (from: NotedGrant) =>
        ({ ...from, expiresAt: new Date(from.expiresAt.getTime() + 24 * HOUR_MS) });
    let bothShow = async (expected: NotedGrant) => {
      for (let report of [one, two]) {
        expect((await run(reports => reports.get(report.id))).grant)
            .toStrictEqual(shown(expected));
      }
    };

    // Given with a second report after a renewal: its one row takes the later end, for both.
    await run(reports => reports.noteGrant("ada", grant, one.id));
    let linkedAgain = later(grant);
    await run(reports => reports.noteGrant("ada", linkedAgain, two.id));
    await bothShow(linkedAgain);
    let renewed = later(linkedAgain);
    await run(reports => reports.noteGrant("ada", renewed));
    await bothShow(renewed);

    // The same end noted twice leaves the one row as it was.
    let ended = { ...renewed, endedAt: new Date() };
    await run(reports => reports.noteGrant("ada", ended));
    let rows = await sql("SELECT * FROM grants");
    expect(rows).toHaveLength(1);
    await run(reports => reports.noteGrant("ada", ended));
    expect(await sql("SELECT * FROM grants")).toStrictEqual(rows);
    expect((await run(reports => reports.getOwn("ada", two.id))).grant).toStrictEqual(shown(ended));
  });

  it("keeps a row only while a report names it, whatever an owner repeats", async () => {
    let { run, count } = store();
    let ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push((await run(reports => reports.submit(
          ADA, input({ context: { workspaceId: "w1" } }), true))).id);
    }
    // A fresh grant given with the report, then ended, a thousand times over.
    let turns = (reportId: string) => run(reports => {
      for (let i = 0; i < 1000; i++) {
        let grant = workspaceGrant();
        reports.noteGrant("ada", grant, reportId);
        reports.noteGrant("ada", { ...grant, endedAt: new Date() });
      }
    });
    await turns(ids[0]);
    expect(await count("grants")).toBe(1);
    await turns(ids[1]);
    await turns(ids[2]);
    expect(await count("grants")).toBe(3);

    // A grant no report names is not stored: given without a report, renewed, ended.
    let unlinked = workspaceGrant();
    await run(reports => {
      reports.noteGrant("ada", unlinked);
      reports.noteGrant("ada", { ...unlinked, endedAt: new Date() });
      reports.noteGrant("ada", accountGrant());
    });
    expect(await count("grants")).toBe(3);
  });

  it("keeps an account-wide grant's one row until its last report takes another", async () => {
    let { run, sql } = store();
    let one = await run(reports => reports.submit(ADA, input(), false));
    let two = await run(reports => reports.submit(ADA, input(), false));
    let shared = accountGrant();
    await run(reports => {
      reports.noteGrant("ada", shared, one.id);
      reports.noteGrant("ada", shared, two.id);
      reports.noteGrant("ada", { ...shared, endedAt: new Date() });
    });
    let ids = async () =>
        (await sql<{ id: string }>("SELECT id FROM grants ORDER BY id")).map(row => row.id);
    expect(await ids()).toStrictEqual([shared.id]);

    let next = accountGrant();
    await run(reports => reports.noteGrant("ada", next, one.id));
    expect(await ids()).toStrictEqual([shared.id, next.id].toSorted());
    expect((await run(reports => reports.get(two.id))).grant?.id).toBe(shared.id);
    await run(reports => reports.noteGrant("ada", next, two.id));
    expect(await ids()).toStrictEqual([next.id]);
  });
});

describe("the report an admin's view of a workspace is opened for", () => {
  it("is one the workspace's owner filed about that workspace, and no other", async () => {
    let { run, sql } = store();
    let adas = await run(reports => reports.submit(
        ADA, input({ context: { workspaceId: "w1" } }), true));
    let bens = await run(reports => reports.submit(
        BEN, input({ context: { workspaceId: "w1" } }), false));
    let home = await run(reports => reports.submit(ADA, input(), false));
    let before = await sql("SELECT * FROM reports ORDER BY seq");

    await run(reports => reports.checkReportWorkspace("ada", adas.id, "w1"));
    let cases: [string, string, string][] = [
      ["ada", crypto.randomUUID(), "w1"],
      // A collaborator's report about the workspace, asked for by its owner, and the owner's
      // report asked for by another.
      ["ada", bens.id, "w1"],
      ["ben", adas.id, "w1"],
      ["ada", adas.id, "w2"],
      // A report from the home page names no workspace, whatever is asked of it.
      ["ada", home.id, "w1"],
      ["ada", home.id, ""],
    ];
    for (let [owner, reportId, workspaceId] of cases) {
      expect(await refusal(() => run(reports =>
          reports.checkReportWorkspace(owner, reportId, workspaceId)))).toBe(NOT_FOUND);
    }
    expect(await sql("SELECT * FROM reports ORDER BY seq")).toStrictEqual(before);
  });

  it("is the owner's now, whoever owned the workspace when it was filed", async () => {
    let { run } = store();
    // Filed while Ada collaborated on the workspace, which she owns by the time it is asked.
    let report = await run(reports => reports.submit(
        ADA, input({ context: { workspaceId: "w1" } }), false));
    await run(reports => reports.checkReportWorkspace("ada", report.id, "w1"));
  });

  it("may hold a live grant, which a grant about to be given may not", async () => {
    let { run } = store();
    let report = await run(reports => reports.submit(
        ADA, input({ context: { workspaceId: "w1" } }), true));
    await run(reports => reports.noteGrant("ada", workspaceGrant(), report.id));
    expect(await refusal(() => run(reports => reports.checkGrantLink(
        "ada", report.id, { scope: "workspace", workspaceId: "w1" })))).toBe(NOT_FOUND);
    await run(reports => reports.checkReportWorkspace("ada", report.id, "w1"));
  });

  it("matches an owner whose id is longer than the store keeps", async () => {
    let { run } = store();
    let start = "u".repeat(290);
    let one: Person = { id: `${start}${"1".repeat(10)}`, name: "One" };
    let two: Person = { id: `${start}${"2".repeat(10)}`, name: "Two" };
    let report = await run(reports => reports.submit(
        one, input({ context: { workspaceId: "w1" } }), true));
    expect(report.reporter.id).not.toBe(one.id);

    await run(reports => reports.checkReportWorkspace(one.id, report.id, "w1"));
    expect(await refusal(() => run(reports =>
        reports.checkReportWorkspace(two.id, report.id, "w1")))).toBe(NOT_FOUND);
  });
});

describe("listing issue reports", () => {
  it("pages a reporter's 120 reports as 50, 50 and 20, newest first", async () => {
    let clock = fakeClock();
    let { run } = store();
    let filed: string[] = [];
    for (let day = 0; day < 6; day++) {
      filed.push(...await run(async reports => {
        let ids: string[] = [];
        for (let i = 0; i < MAX_ISSUE_REPORTS_PER_DAY; i++) {
          ids.push((await reports.submit(ADA, input(), false)).id);
          // Another reporter's reports lie between them.
          if (i % 5 === 0) await reports.submit(BEN, input(), false);
        }
        return ids;
      }));
      clock.nextDay();
    }

    let pages: string[][] = [];
    let cursor: string | undefined;
    do {
      let page = await run(reports => reports.listOwn("ada", cursor));
      pages.push(page.reports.map(report => report.id));
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    expect(pages.map(page => page.length)).toStrictEqual([ISSUE_REPORT_PAGE_SIZE, 50, 20]);
    expect(pages.flat()).toStrictEqual(filed.toReversed());

    // A reporter's cursor is the id of one of their own reports. A report's number is none: it
    // would place the reporter's reports among everybody's, and so count the others'.
    let first = await run(reports => reports.listOwn("ada"));
    expect(first.nextCursor).toBe(filed.at(-ISSUE_REPORT_PAGE_SIZE));
    let bens = await run(reports => reports.listOwn("ben"));
    expect(bens.reports).toHaveLength(24);
    expect(bens.nextCursor).toBeUndefined();
    let older = await run(reports => reports.listOwn("ben", bens.reports[0].id));
    expect(older.reports).toStrictEqual(bens.reports.slice(1));
    for (let invalid of ["", "abc", "-1", "1", "40", "100000", filed[0], crypto.randomUUID()]) {
      expect(await refusal(() => run(reports => reports.listOwn("ben", invalid))), invalid)
          .toBe("TypeError");
    }
    for (let invalid of ["", "abc", "-1", "1.5", "1e3", " 7", "9".repeat(30), filed[0]]) {
      expect(await refusal(() => run(reports => reports.list({ cursor: invalid, limit: 10 }))),
          invalid).toBe("TypeError");
    }
  });

  it("filters the admins' list, and pages it by a cursor", async () => {
    let { run } = store();
    let file = (who: Person, priority: "low" | "high", workspaceId?: string) => run(reports =>
        reports.submit(who, input({ priority, context: { workspaceId } }), false));
    let a = await file(ADA, "low", "w1");
    let b = await file(BEN, "high", "w1");
    let c = await file(ADA, "high", "w2");
    let d = await file(BEN, "low");
    await run(reports => reports.setStatus(GRACE, { via: "api" }, c.id, "investigating"));

    let listed = async (query: object) =>
        (await run(reports => reports.list({ limit: 10, ...query }))).reports.map(r => r.id);
    expect(await listed({})).toStrictEqual([d.id, c.id, b.id, a.id]);
    expect(await listed({ status: "new" })).toStrictEqual([d.id, b.id, a.id]);
    expect(await listed({ status: "investigating" })).toStrictEqual([c.id]);
    expect(await listed({ priority: "high" })).toStrictEqual([c.id, b.id]);
    expect(await listed({ reporter: "ada" })).toStrictEqual([c.id, a.id]);
    expect(await listed({ workspace: "w1" })).toStrictEqual([b.id, a.id]);
    expect(await listed({ workspace: "w1", priority: "high", reporter: "ben" }))
        .toStrictEqual([b.id]);
    expect(await listed({ status: "closed" })).toStrictEqual([]);

    let first = await run(reports => reports.list({ limit: 3 }));
    expect(first.reports.map(r => r.id)).toStrictEqual([d.id, c.id, b.id]);
    let rest = await run(reports => reports.list({ limit: 3, cursor: first.nextCursor }));
    expect(rest.reports.map(r => r.id)).toStrictEqual([a.id]);
    expect("nextCursor" in rest).toBe(false);
    // Exactly a page's worth leaves no cursor.
    expect("nextCursor" in await run(reports => reports.list({ limit: 4 }))).toBe(false);

    for (let query of [{ limit: 0 }, { limit: 201 }, { limit: 1.5 },
        { reporter: "r".repeat(1001) }, { workspace: "w".repeat(1001) }]) {
      expect(await refusal(() => run(reports => reports.list({ limit: 10, ...query }))),
          JSON.stringify(query).slice(0, 30)).toBe("TypeError");
    }
  });

  it("gives the reporter an admin's name without their id, and the admins both", async () => {
    let { run } = store();
    let report = await run(reports => reports.submit(ADA, input(), false));
    await run(reports => {
      reports.reply(ADA, report.id, "Any news?");
      reports.addEntry(GRACE, { via: "api" }, report.id, "Looking.", "public");
      reports.setStatus(GRACE, { via: "api" }, report.id, "investigating");
    });
    let own = await run(reports => reports.getOwn("ada", report.id));
    expect(own.entries.map(entry => entry.author)).toStrictEqual(
        [{ id: "ada", name: "Ada" }, { name: "Grace (admin)" }, { name: "Grace (admin)" }]);
    expect(own.entries.map(entry => Object.keys(entry.author)))
        .toStrictEqual([["id", "name"], ["name"], ["name"]]);
    expect(JSON.stringify(own)).not.toContain("grace@example.test");
    expect((await run(reports => reports.get(report.id))).entries.map(entry => entry.author.id))
        .toStrictEqual(["ada", "grace@example.test", "grace@example.test"]);

    // The rule is how the entry was written, so it holds for an admin who filed the report.
    let graces = await run(reports => reports.submit(GRACE, input(), false));
    await run(reports => {
      reports.reply(GRACE, graces.id, "As the reporter.");
      reports.addEntry(GRACE, { via: "cli" }, graces.id, "As an admin.", "public");
    });
    expect((await run(reports => reports.getOwn(GRACE.id, graces.id)))
        .entries.map(entry => entry.author))
        .toStrictEqual([{ id: "grace@example.test", name: "Grace (admin)" },
          { name: "Grace (admin)" }]);
  });
});

describe("the issue report image bucket", () => {
  it("is bound in the pool", async () => {
    let key = `probe/${crypto.randomUUID()}`;
    await env.ISSUE_IMAGES.put(key, "bytes");
    let object = await env.ISSUE_IMAGES.get(key);
    expect(await object?.text()).toBe("bytes");
    await env.ISSUE_IMAGES.delete(key);
    expect(await env.ISSUE_IMAGES.head(key)).toBeNull();
  });
});

// What AdminSettings answers while its admins have chosen a retention of `days`.
function chose(days: number): () => Promise<AdminConfig> {
  return async () => ({ ...DEFAULT_ADMIN_CONFIG, issueReportRetentionDays: days });
}

describe("issue report retention", () => {
  it("deletes a report a day past the retention, with its thread", async () => {
    let clock = fakeClock();
    let { run, sql, count } = store();
    let old = await run(reports => reports.submit(ADA, input(), false));
    await run(reports => {
      reports.reply(ADA, old.id, "Hello?");
      reports.addEntry(GRACE, { via: "api" }, old.id, "A note.", "admins");
    });
    clock.advance(2 * DAY_MS);
    let young = await run(reports => reports.submit(ADA, input(), false));
    await run(reports => reports.reply(ADA, young.id, "Kept."));

    // 90 days after the first was filed, to the millisecond, it is not yet past the retention.
    clock.advance(88 * DAY_MS);
    await run((reports, state) => {
      answerRetention(state, chose(90));
      return reports.alarm();
    });
    expect(await count("reports")).toBe(2);

    clock.advance(DAY_MS);
    await run(reports => reports.alarm());
    expect((await run(reports => reports.list({ limit: 10 }))).reports.map(report => report.id))
        .toStrictEqual([young.id]);
    expect(await refusal(() => run(reports => reports.getOwn("ada", old.id)))).toBe(NOT_FOUND);
    expect(await sql("SELECT text FROM entries")).toStrictEqual([{ text: "Kept." }]);
    // A report remains, so it comes back in a day.
    expect(await run((_reports, state) => state.storage.getAlarm())).toBe(Date.now() + DAY_MS);
  });

  it("asks AdminSettings for the retention each time it runs", async () => {
    let clock = fakeClock();
    let { run, count } = store();
    await run(reports => reports.submit(ADA, input(), false));
    clock.advance(100 * DAY_MS);
    let days = 400;
    let asked = 0;
    await run((reports, state) => {
      answerRetention(state, () => { asked++; return chose(days)(); });
      return reports.alarm();
    });
    expect(await count("reports")).toBe(1);
    // Lowered since: the next run deletes by the retention then in force.
    days = 95;
    await run(reports => reports.alarm());
    expect(asked).toBe(2);
    expect(await count("reports")).toBe(0);
  });

  it("deletes nothing when the retention cannot be asked, and comes back in an hour", async () => {
    let clock = fakeClock();
    let logged = vi.spyOn(console, "error").mockImplementation(() => {});
    let { run, count } = store();
    await run(reports => reports.submit(ADA, input(), false));
    clock.advance(1000 * DAY_MS);
    await run((reports, state) => {
      answerRetention(state, async () => { throw new Error("AdminSettings is unavailable"); });
      return reports.alarm();
    });
    expect(await count("reports")).toBe(1);
    expect(await run((_reports, state) => state.storage.getAlarm())).toBe(Date.now() + HOUR_MS);
    expect(logged.mock.calls.map(([entry]) => (entry as { event?: string }).event))
        .toStrictEqual(["issue-reports.prune.failed"]);
  });

  it("holds a stored retention up to the deployment's floor", async () => {
    let clock = fakeClock();
    let { run, count } = store();
    await run(reports => reports.submit(ADA, input(), false));
    clock.advance(30 * DAY_MS);
    await run(reports => reports.submit(ADA, input(), false));
    clock.advance(6 * DAY_MS);

    // The pool sets no ISSUE_REPORT_RETENTION_MIN_DAYS: the floor is 90 days, whatever is stored.
    await run((reports, state) => {
      answerRetention(state, chose(1));
      return reports.alarm();
    });
    expect(await count("reports")).toBe(2);

    // With the floor at 7 days the first report, 36 days old, goes and the second stays.
    await run((_reports, state) => new IssueReportsDurableObject(
        state, { ...env, ISSUE_REPORT_RETENTION_MIN_DAYS: "7" } as unknown as Cloudflare.Env)
        .alarm());
    expect(await count("reports")).toBe(1);
  });

  it("deletes 100 reports a run, a minute apart, and stops once the store is empty", async () => {
    let clock = fakeClock();
    let { run, count } = store();
    await run(async reports => {
      for (let who = 0; who < 6; who++) {
        for (let i = 0; i < MAX_ISSUE_REPORTS_PER_DAY; i++) {
          await reports.submit({ id: `user-${who}`, name: "User" }, input(), false);
        }
      }
    });
    clock.advance(91 * DAY_MS);
    await run((reports, state) => {
      answerRetention(state, chose(90));
      return reports.alarm();
    });
    expect(await count("reports")).toBe(20);
    expect(await run((_reports, state) => state.storage.getAlarm())).toBe(Date.now() + 60_000);

    await run(reports => reports.alarm());
    expect(await count("reports")).toBe(0);
    // Nothing is left to prune, so the alarm is not set again: the next report sets it.
    expect(await run((_reports, state) => state.storage.getAlarm())).toBe(Date.now() + 60_000);
  });

  it("deletes a report's grant row with it, unless another report names it", async () => {
    let clock = fakeClock();
    let { run, sql, count } = store();
    let old = await run(reports => reports.submit(ADA, input(), false));
    let oldToo = await run(reports => reports.submit(
        ADA, input({ context: { workspaceId: "w1" } }), true));
    let shared = accountGrant();
    let own = workspaceGrant();
    clock.advance(50 * DAY_MS);
    let young = await run(reports => reports.submit(ADA, input(), false));
    await run((reports, state) => {
      answerRetention(state, chose(90));
      reports.noteGrant("ada", shared, old.id);
      reports.noteGrant("ada", shared, young.id);
      reports.noteGrant("ada", own, oldToo.id);
    });

    clock.advance(41 * DAY_MS);
    await run(reports => reports.alarm());
    expect(await count("reports")).toBe(1);
    expect(await sql("SELECT id FROM grants")).toStrictEqual([{ id: shared.id }]);
    // The end of a pruned report's grant, noted again, stores nothing.
    await run(reports => reports.noteGrant("ada", { ...own, endedAt: new Date() }));
    expect(await sql("SELECT id FROM grants")).toStrictEqual([{ id: shared.id }]);

    clock.advance(50 * DAY_MS);
    await run(reports => reports.alarm());
    expect(await count("reports")).toBe(0);
    expect(await count("grants")).toBe(0);
  });

  it("reaches the deployment's AdminSettings, whose default retention is 90 days", async () => {
    let clock = fakeClock();
    let { run, count } = store();
    await run(reports => reports.submit(ADA, input(), false));
    clock.advance(89 * DAY_MS);
    await run(reports => reports.alarm());
    expect(await count("reports")).toBe(1);
    clock.advance(2 * DAY_MS);
    await run(reports => reports.alarm());
    expect(await count("reports")).toBe(0);
  });
});

// The reporter's and the admins' methods over real sessions (AuthenticatedApi and AdminApi),
// against the deployment's own store.
describe("issue reports over a user's and an admin's session", () => {
  const ORIGIN = "https://workshop.example";

  // A PublicApi session on a deployment whose admins are `admins`. No admin config is stored
  // for the session Worker: every read of it gets the defaults (signups open).
  async function connect(admins: string[] = []): Promise<RpcStub<PublicApi>> {
    // The first /api request installs the bundled blueprints, which needs storage this test
    // lacks.
    let ctx = createExecutionContext();
    Object.defineProperty(ctx, "exports", { value: Object.create(ctx.exports, {
      AdminSettings: { value: { getByName: () => ({
        ensureBundledBlueprintsInstalled: async () => true,
      }) } },
    }) });
    let deployment = { ...env, ADMINS: admins, BLUEPRINTS: { get: async () => null } };
    let response = await server.fetch(
        new Request(`${ORIGIN}/api`, { headers: { Upgrade: "websocket", Origin: ORIGIN } }),
        deployment as unknown as Cloudflare.Env, ctx);
    expect(response.status).toBe(101);
    let socket = response.webSocket;
    if (!socket) throw new TypeError("Expected a WebSocket response.");
    socket.accept();
    return newWebSocketRpcSession<PublicApi>(socket);
  }

  // A password account named `name`, and what authenticates as it.
  async function account(name: string): Promise<{ username: string; token: string }> {
    let username = `${name}${crypto.randomUUID().replaceAll("-", "")}`;
    let secret = await env.TEST_USER.getByName(username)
        .createAccount(username, name, new Uint8Array([1, 2, 3]));
    return { username, token: `${username}:${secret}` };
  }

  // How many records the deployment's admin audit log holds.
  async function auditCount(): Promise<number> {
    return (await env.TEST_ADMIN_AUDIT.getByName("").list({ limit: 200 }, 90)).records.length;
  }

  it("files a report as the session's user and keeps it from everyone else", async () => {
    let ada = await account("Ada");
    let ben = await account("Ben");
    using api = await connect();
    using session = api.authenticate(ada.token);
    using other = api.authenticate(ben.token);

    let report = await session.submitIssueReport(input({ context: { appVersion: "1.2.3" } }));
    expect(report).toStrictEqual({
      id: expect.any(String), filedAt: expect.any(Date),
      reporter: { id: ada.username, name: "Ada" },
      text: "The export button does nothing.", priority: "medium",
      context: { appVersion: "1.2.3" }, status: "new", images: [], unseen: false,
    });
    expect(await session.getIssueReport(report.id)).toStrictEqual({ ...report, entries: [] });
    expect(await session.listIssueReports()).toStrictEqual({ reports: [report] });
    expect(await session.getUnseenIssueReportCount()).toBe(0);

    expect(await refusal(() => other.getIssueReport(report.id))).toBe(NOT_FOUND);
    expect(await refusal(() => other.replyToIssueReport(report.id, "Mine too"))).toBe(NOT_FOUND);
    expect(await refusal(() => other.markIssueReportSeen(report.id))).toBe(NOT_FOUND);
    expect(await refusal(() => other.readIssueReportImage(report.id, "image"))).toBe(NOT_FOUND);
    expect(await refusal(() => session.getIssueReport("no-such-report"))).toBe(NOT_FOUND);
    expect(await other.listIssueReports()).toStrictEqual({ reports: [] });
  });

  it("refuses a report naming a workspace that is not one, and files nothing", async () => {
    let ada = await account("Ada");
    using api = await connect();
    using session = api.authenticate(ada.token);
    let unknown = env.TEST_OVERSEER.newUniqueId().toString();
    for (let workspaceId of ["not-a-workspace-id", unknown]) {
      expect(await refusal(() => session.submitIssueReport(input({ context: { workspaceId } }))))
          .toBe(ISSUE_REPORT_ERROR_CODES.contextNotFound);
    }
    expect(await session.listIssueReports()).toStrictEqual({ reports: [] });
  });

  it("files a report about a workspace on the workspace's word of who its reporter is",
      async () => {
    let ada = await account("Ada");
    let ben = await account("Ben");
    let cy = await account("Cy");
    using api = await connect();
    using session = api.authenticate(ada.token);
    using collaborator = api.authenticate(ben.token);
    using stranger = api.authenticate(cy.token);
    using workspace = session.newWorkspace();
    let { id: workspaceId } = await workspace.getMetadata();
    expect(await workspace.addCollaborator(ben.username, "workspace")).not.toBeNull();
    // What the store keeps of a report beside what it returns: the workspace, and whether the
    // reporter owns it.
    let kept = (reportId: string) => runInDurableObject(env.TEST_ISSUE_REPORTS.getByName(""),
        (_reports, state) => state.storage.sql.exec(
            "SELECT workspace_id, owns_workspace FROM reports WHERE id = ?", reportId).one());

    // The workspace is kept as it names itself, however the client spelled its id.
    let owners = await session.submitIssueReport(
        input({ context: { workspaceId: workspaceId.toUpperCase() } }));
    expect(workspaceId.toUpperCase()).not.toBe(workspaceId);
    expect(owners.context).toStrictEqual({ workspaceId });
    expect(await kept(owners.id)).toStrictEqual({ workspace_id: workspaceId, owns_workspace: 1 });
    let collaborators = await collaborator.submitIssueReport(input({ context: { workspaceId } }));
    expect(await kept(collaborators.id))
        .toStrictEqual({ workspace_id: workspaceId, owns_workspace: 0 });

    let refused = async (who: typeof session, context: IssueReportInput["context"]) =>
        expect(await refusal(() => who.submitIssueReport(input({ context }))))
            .toBe(ISSUE_REPORT_ERROR_CODES.contextNotFound);
    await refused(stranger, { workspaceId });
    await refused(session, { workspaceId, chatId: 999_999 });
    await refused(session, { workspaceId, gadgetId: 999_999 });
    await workspace.deleteSelf();
    await refused(session, { workspaceId });

    expect((await session.listIssueReports()).reports.map(report => report.id))
        .toStrictEqual([owners.id]);
    expect(await stranger.listIssueReports()).toStrictEqual({ reports: [] });
  });

  it("shows the reporter an admin's name and never their id, and records nothing in the audit log",
      async () => {
    let ada = await account("Ada");
    let grace = await account("Grace");
    using api = await connect([grace.username]);
    using session = api.authenticate(ada.token);
    using adminSession = api.authenticate(grace.token);
    using admin = (await adminSession.getAdminApi())!;
    let report = await session.submitIssueReport(input());
    let audit = await auditCount();

    await admin.addIssueReportEntry(report.id, "Internal: the data binding", "admins");
    let reply = await admin.addIssueReportEntry(report.id, "Which chart?", "public");
    await admin.setIssueReportStatus(report.id, "waitingOnReporter");
    await admin.setIssueReportLinks(report.id, ["https://example.com/ticket/1"]);
    expect((await admin.listIssueReports({ reporter: ada.username })).reports)
        .toMatchObject([{ id: report.id, links: ["https://example.com/ticket/1"] }]);

    expect(await session.getUnseenIssueReportCount()).toBe(1);
    let own = await session.getIssueReport(report.id);
    expect(own.entries).toStrictEqual([
      { id: reply.id, at: expect.any(Date), author: { name: "Grace" }, visibility: "public",
        via: "api", text: "Which chart?" },
      { id: expect.any(String), at: expect.any(Date), author: { name: "Grace" },
        visibility: "public", via: "api", text: "", status: "waitingOnReporter" },
    ]);
    let json = JSON.stringify(own);
    expect(json).not.toContain(grace.username);
    expect(json).not.toContain("Internal");
    expect(json).not.toContain("example.com");

    await session.markIssueReportSeen(report.id);
    expect(await session.getUnseenIssueReportCount()).toBe(0);
    expect(await session.replyToIssueReport(report.id, "The revenue one"))
        .toMatchObject({ author: { id: ada.username, name: "Ada" }, status: "withAdmin" });

    let whole = await admin.getIssueReport(report.id);
    expect(whole.status).toBe("withAdmin");
    expect(whole.entries.map(entry => [entry.author.id, entry.visibility, entry.text]))
        .toStrictEqual([
          [grace.username, "admins", "Internal: the data binding"],
          [grace.username, "public", "Which chart?"],
          [grace.username, "public", ""],
          [ada.username, "public", "The revenue one"],
        ]);
    expect(await auditCount()).toBe(audit);
  });

  it("hands an image's stream to the store and back, to its reporter and to admins alone",
      async () => {
    let ada = await account("Ada");
    let ben = await account("Ben");
    let grace = await account("Grace");
    using api = await connect([grace.username]);
    using session = api.authenticate(ada.token);
    using other = api.authenticate(ben.token);
    using adminSession = api.authenticate(grace.token);
    using admin = (await adminSession.getAdminApi())!;
    let report = await session.submitIssueReport(input());
    // A PNG's signature, then bytes that tell a reordering or a cut.
    let bytes = Uint8Array.from({ length: 5000 }, (_, i) =>
        [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A][i] ?? i % 251);
    let streamOf = (chunk: Uint8Array) => new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.close();
      },
    });
    let read = async (stream: ReadableStream<Uint8Array>) =>
        new Uint8Array(await new Response(stream).arrayBuffer());

    let image = await session.addIssueReportImage(report.id, streamOf(bytes), bytes.length);
    expect(image).toStrictEqual(
        { id: expect.any(String), type: "image/png", byteLength: bytes.length });
    expect((await session.getIssueReport(report.id)).images).toStrictEqual([image]);
    expect(await read(await session.readIssueReportImage(report.id, image.id)))
        .toStrictEqual(bytes);
    expect(await read(await admin.readIssueReportImage(report.id, image.id)))
        .toStrictEqual(bytes);

    expect(await refusal(() => other.readIssueReportImage(report.id, image.id))).toBe(NOT_FOUND);
    expect(await refusal(() =>
        other.addIssueReportImage(report.id, streamOf(bytes), bytes.length))).toBe(NOT_FOUND);
    expect(await refusal(() => admin.readIssueReportImage(report.id, "no-such-image")))
        .toBe(NOT_FOUND);
    expect(await refusal(() => session.addIssueReportImage(
        report.id, streamOf(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>")),
        41))).toBe(ISSUE_REPORT_ERROR_CODES.imageNotRecognised);
    expect((await session.getIssueReport(report.id)).images).toStrictEqual([image]);
  });

  it("pages the reporter's reports, fifty at a time", async () => {
    let ada = await account("Ada");
    let clock = fakeClock();
    // More than a day's bound lets through, so over three days.
    let filed: string[] = [];
    await runInDurableObject(env.TEST_ISSUE_REPORTS.getByName(""), async reports => {
      for (let day of [20, 20, ISSUE_REPORT_PAGE_SIZE + 1 - 40]) {
        for (let i = 0; i < day; i++) {
          clock.advance(1000);
          filed.push((await reports.submit({ id: ada.username, name: "Ada" }, input(), false)).id);
        }
        clock.nextDay();
      }
    });
    // The session reads the real clock: a faked Date does not cross it.
    vi.useRealTimers();
    using api = await connect();
    using session = api.authenticate(ada.token);
    let first = await session.listIssueReports();
    expect(first.reports.map(report => report.id))
        .toStrictEqual(filed.toReversed().slice(0, ISSUE_REPORT_PAGE_SIZE));
    expect(first.nextCursor).toEqual(expect.any(String));
    let last = await session.listIssueReports(first.nextCursor);
    expect(last.reports.map(report => report.id)).toStrictEqual([filed[0]]);
    expect(last.nextCursor).toBeUndefined();
    await expect(session.listIssueReports("not-a-cursor")).rejects.toThrow(TypeError);
  });
});
