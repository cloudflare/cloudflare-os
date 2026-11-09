import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_GADGET_CONSOLE_LOG_TEXT_LENGTH,
  type GadgetConsoleLogEntry, type GadgetConsoleLogQuery,
} from "@gadgets/workshop-shared/api";
import {
  GADGET_CONSOLE_LOG_BYTES_PER_GADGET, GADGET_CONSOLE_LOG_BYTES_PER_WORKSPACE,
  GADGET_CONSOLE_LOG_CLIENT_BYTES_PER_GADGET, GADGET_CONSOLE_LOG_CLIENT_BYTES_PER_WORKSPACE,
  GADGET_CONSOLE_LOG_PAGE_SIZE, GADGET_CONSOLE_LOG_RETENTION_HOURS,
  validateGadgetConsoleLogQuery, WorkspaceLogDurableObject,
} from "../src/workspace-log.js";
// Load the whole backend (the pool's `main`) up front, so its slow load does not count against the
// first test's timeout.
import "./test-worker.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_WORKSPACE_LOG: DurableObjectNamespace<WorkspaceLogDurableObject>;
  }
}

const HOUR_MS = 60 * 60_000;
const RETENTION_MS = GADGET_CONSOLE_LOG_RETENTION_HOURS * HOUR_MS;
// What "server" entries may take of each bound: what "client" entries leave.
const SERVER_BYTES_PER_GADGET =
    GADGET_CONSOLE_LOG_BYTES_PER_GADGET - GADGET_CONSOLE_LOG_CLIENT_BYTES_PER_GADGET;
const SERVER_BYTES_PER_WORKSPACE =
    GADGET_CONSOLE_LOG_BYTES_PER_WORKSPACE - GADGET_CONSOLE_LOG_CLIENT_BYTES_PER_WORKSPACE;

function workspaceLog() {
  return env.TEST_WORKSPACE_LOG.getByName(crypto.randomUUID());
}

type Stub = ReturnType<typeof workspaceLog>;

function server(overrides: Partial<GadgetConsoleLogEntry> = {}): GadgetConsoleLogEntry {
  return {
    time: new Date(), gadgetId: 1, chatId: null, source: "server", level: "log", text: "hello",
    ...overrides,
  };
}

function client(overrides: Partial<GadgetConsoleLogEntry> = {}): GadgetConsoleLogEntry {
  return server({ source: "client", userId: "user-1", ...overrides });
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

function sql<T extends Record<string, SqlStorageValue>>(stub: Stub, query: string,
    ...params: SqlStorageValue[]): Promise<T[]> {
  return runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<T>(query, ...params).toArray());
}

function getAlarm(stub: Stub): Promise<number | null> {
  return runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
}

function setAlarm(stub: Stub, time: number): Promise<void> {
  return runInDurableObject(stub, (_instance, state) => state.storage.setAlarm(time));
}

function deleteAlarm(stub: Stub): Promise<void> {
  return runInDurableObject(stub, (_instance, state) => state.storage.deleteAlarm());
}

function runAlarm(stub: Stub): Promise<void> {
  return runInDurableObject(stub, (instance: WorkspaceLogDurableObject) => instance.alarm());
}

// Runs `callback` on a second instance over the object's storage, which is what the object is once
// it has left memory and is loaded again: nothing an earlier instance remembered, only what it
// stored.
function loadedAgain<T>(stub: Stub, callback: (log: WorkspaceLogDurableObject) => T | Promise<T>)
    : Promise<T> {
  return runInDurableObject(stub, (_instance, state) =>
      callback(new WorkspaceLogDurableObject(state, env)));
}

// The object's tables that hold entries. The test pool keeps a table of its own in every object,
// so "no table" is these being absent.
async function logTables(stub: Stub): Promise<string[]> {
  let tables = await sql<{ name: string }>(stub,
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'console_log%'
       ORDER BY name`);
  return tables.map(table => table.name);
}

async function rowCount(stub: Stub, where = "1"): Promise<number> {
  let [{ count }] = await sql<{ count: number }>(stub,
      `SELECT COUNT(*) AS count FROM console_logs WHERE ${where}`);
  return count;
}

// A log that holds its schema and no row, for a test that fills the table by SQL: the schema is
// created by an append alone.
async function emptyLog(): Promise<Stub> {
  let log = workspaceLog();
  await log.append([server()]);
  await sql(log, "DELETE FROM console_logs");
  return log;
}

// Rows written by SQL, kept now and in order, each counting one of `bytes`. The triggers count the
// column, so a bound is reached without large texts.
function insertRows(stub: Stub, gadgetId: number, source: "server" | "client", bytes: number[])
    : Promise<void> {
  return runInDurableObject(stub, (_instance, state) => {
    for (let count of bytes) {
      state.storage.sql.exec(`INSERT INTO console_logs
          (kept_at, at, gadget_id, chat_id, source, user_id, level, text, bytes)
          VALUES (?1, ?1, ?2, NULL, ?3, ?4, 'log', '', ?5)`,
          Date.now(), gadgetId, source, source === "client" ? "user-1" : null, count);
    }
  });
}

type UsageRow = { gadget_id: number; source: string; bytes: number };

// console_log_usage holds exactly the sum of `bytes` for each gadget and source that has rows.
async function expectUsageExact(stub: Stub): Promise<UsageRow[]> {
  let usage = await sql<UsageRow>(stub,
      "SELECT gadget_id, source, bytes FROM console_log_usage ORDER BY gadget_id, source");
  let sums = await sql<UsageRow>(stub,
      `SELECT gadget_id, source, SUM(bytes) AS bytes FROM console_logs
       GROUP BY gadget_id, source ORDER BY gadget_id, source`);
  expect(usage).toEqual(sums);
  expect(usage.filter(row => row.bytes === 0)).toEqual([]);
  return usage;
}

function usageOf(usage: UsageRow[], gadgetId: number, source: string): number {
  return usage.find(row => row.gadget_id === gadgetId && row.source === source)?.bytes ?? 0;
}

// The `bytes` column of each entry, appended in order to one log.
async function counted(entries: GadgetConsoleLogEntry[]): Promise<number[]> {
  let log = workspaceLog();
  await log.append(entries);
  let rows = await sql<{ bytes: number }>(log, "SELECT bytes FROM console_logs ORDER BY seq");
  await expectUsageExact(log);
  return rows.map(row => row.bytes);
}

// What 2,000 entries take in a fresh database, and what they count: `shapes` in turn, over five
// gadgets, so that no bound is reached and nothing is pruned. Of a fresh fill only: once entries
// are pruned, pages that still hold other gadgets' rows stay part-empty, and the database can
// take more.
async function freshFill(shapes: GadgetConsoleLogEntry[])
    : Promise<{ grown: number; count: number }> {
  let log = workspaceLog();
  let databaseSize = () =>
      runInDurableObject(log, (_instance, state) => state.storage.sql.databaseSize);
  // The first entry creates the schema, whose pages are not the entries'.
  await log.append([shapes[0]!]);
  let before = await databaseSize();
  let [{ bytes: first }] = await sql<{ bytes: number }>(log, "SELECT bytes FROM console_logs");

  for (let batch = 0; batch < 20; batch++) {
    await log.append(Array.from({ length: 100 },
        (_, i) => ({ ...shapes[i % shapes.length]!, gadgetId: 1 + i % 5 })));
  }
  expect(await rowCount(log)).toBe(2001);
  let [{ total }] = await sql<{ total: number }>(log,
      "SELECT SUM(bytes) AS total FROM console_logs");
  return { grown: await databaseSize() - before, count: total - first };
}

// Backdates the rows matching `where` to `hours` before now.
function backdate(stub: Stub, where: string, hours: number): Promise<unknown[]> {
  return sql(stub, `UPDATE console_logs SET kept_at = ? WHERE ${where}`,
      Date.now() - hours * HOUR_MS);
}

// `count` rows of one gadget and source written by SQL, kept `hours` ago and counting `bytes` each.
function insertRowsKept(stub: Stub, hours: number, count: number, gadgetId: number,
    source: "server" | "client", bytes: number): Promise<unknown[]> {
  return sql(stub, `INSERT INTO console_logs
      (kept_at, at, gadget_id, chat_id, source, user_id, level, text, bytes)
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2)
      SELECT ?1, ?1, ?3, NULL, ?4, ?5, 'log', '', ?6 FROM n`,
      Date.now() - hours * HOUR_MS, count, gadgetId, source,
      source === "client" ? "user-1" : null, bytes);
}

type SeqRow = { seq: number; gadget_id: number; source: string; bytes: number };

function seqRows(stub: Stub): Promise<SeqRow[]> {
  return sql<SeqRow>(stub, "SELECT seq, gadget_id, source, bytes FROM console_logs ORDER BY seq");
}

// The rows of `before` that `after` no longer holds.
function deleted(before: SeqRow[], after: SeqRow[]): SeqRow[] {
  let kept = new Set(after.map(row => row.seq));
  return before.filter(row => !kept.has(row.seq));
}

function totalOf(usage: UsageRow[], source: string): number {
  return usage.filter(row => row.source === source).reduce((sum, row) => sum + row.bytes, 0);
}

// How many rows the one statement of a list() read.
function rowsReadByList(stub: Stub, query: GadgetConsoleLogQuery): Promise<number> {
  return runInDurableObject(stub, (instance: WorkspaceLogDurableObject, state) => {
    let exec = vi.spyOn(state.storage.sql, "exec");
    try {
      instance.list(query);
      expect(exec).toHaveBeenCalledTimes(1);
      return exec.mock.results[0].value.rowsRead;
    } finally {
      exec.mockRestore();
    }
  });
}

afterEach(() => vi.restoreAllMocks());

describe("WorkspaceLogDurableObject.list", () => {
  it("lists newest first as appended, in the server shape and the client shape", async () => {
    let log = workspaceLog();
    let first = server({ time: new Date(Date.now() - 5_000), text: "first" });
    let second = server({ gadgetId: 2, chatId: 7, level: "error", text: "second" });
    // A browser's clock can say anything: the entry kept last is listed first, though its own time
    // is the earliest.
    let third = client({
      time: new Date(Date.now() - 60_000), chatId: 7, level: "warn", text: "third",
      userId: "user-9",
    });
    await log.append([first, second]);
    await log.append([third]);

    let page = await log.list();
    expect(page.entries).toEqual([third, second, first]);
    expect(page.nextCursor).toBeUndefined();
    expect(page.entries[0].userId).toBe("user-9");
    for (let entry of page.entries.slice(1)) expect(entry).not.toHaveProperty("userId");
    expect(page.entries.map(entry => entry.chatId)).toEqual([7, 7, null]);
    await expectUsageExact(log);
  });

  it("pages 250 entries as 100, 100 and 50, and a cursor stays put while entries arrive",
      async () => {
    let log = workspaceLog();
    // Each entry's own time is earlier than that of the one kept before it, so the pages and
    // their cursors follow the order the entries were kept in and not their times.
    let now = Date.now();
    let entries = Array.from({ length: 250 }, (_, i) =>
        server({ time: new Date(now - i * 1000), text: `entry ${i}` }));
    await log.append(entries.slice(0, 120));
    await log.append(entries.slice(120));

    let first = await log.list();
    expect(first.entries).toHaveLength(GADGET_CONSOLE_LOG_PAGE_SIZE);
    expect(first.entries[0].text).toBe("entry 249");
    expect(first.entries[99].text).toBe("entry 150");

    await log.append([server({ text: "later" })]);

    let second = await log.list({ cursor: first.nextCursor });
    expect(second.entries).toHaveLength(GADGET_CONSOLE_LOG_PAGE_SIZE);
    expect(second.entries[0].text).toBe("entry 149");
    expect(second.entries[99].text).toBe("entry 50");

    let third = await log.list({ cursor: second.nextCursor });
    expect(third.entries.map(entry => entry.text))
        .toEqual(Array.from({ length: 50 }, (_, i) => `entry ${49 - i}`));
    expect(third.nextCursor).toBeUndefined();
    expect((await log.list()).entries[0].text).toBe("later");
  });

  it("hands out a cursor that names its page's last entry, in one spelling", async () => {
    let log = workspaceLog();
    await log.append(Array.from({ length: GADGET_CONSOLE_LOG_PAGE_SIZE + 5 }, () => server()));
    let { nextCursor } = await log.list();

    // The page's last entry is the sixth kept.
    let [last] = await sql<{ seq: number; kept_at: number }>(log,
        "SELECT seq, kept_at FROM console_logs ORDER BY seq LIMIT 1 OFFSET 5");
    expect(last.seq).toBe(6);
    expect(nextCursor).toBe(`6@${last.kept_at}`);
    expect((await log.list({ cursor: nextCursor })).entries).toHaveLength(5);

    // The same numbers spelt another way are refused, however long.
    for (let cursor of [`06@${last.kept_at}`, `6@0${last.kept_at}`,
                        `${"0".repeat(300)}6@${last.kept_at}`]) {
      await expectRejection(log.list({ cursor }), "TypeError: Invalid cursor.");
    }
  });

  it("lists nothing from a cursor handed out before every entry expired", async () => {
    let log = workspaceLog();
    await log.append(Array.from({ length: 150 }, (_, i) => server({ text: `old ${i}` })));
    // Kept almost 72 hours ago, so the first page is read shortly before its entries expire.
    await backdate(log, "1", 71.9);
    let first = await log.list();
    expect(first.entries[99].text).toBe("old 50");
    expect(first.nextCursor).toBeDefined();

    // They all expire, and the alarm deletes the schema with them, so the sequence of what is
    // kept next starts again below the cursor's.
    await backdate(log, "1", 73);
    await runAlarm(log);
    expect(await logTables(log)).toEqual([]);
    await log.append(Array.from({ length: 60 }, (_, i) => server({ text: `new ${i}` })));
    expect((await seqRows(log)).map(row => row.seq))
        .toEqual(Array.from({ length: 60 }, (_, i) => i + 1));

    // Nothing kept since is older than the first page.
    expect(await log.list({ cursor: first.nextCursor })).toEqual({ entries: [] });
    expect((await log.list()).entries).toHaveLength(60);
  });

  it("ends a listing that fills its last page exactly without a cursor", async () => {
    let log = workspaceLog();
    await log.append(Array.from({ length: GADGET_CONSOLE_LOG_PAGE_SIZE }, () => server()));
    let page = await log.list();
    expect(page.entries).toHaveLength(GADGET_CONSOLE_LOG_PAGE_SIZE);
    expect(page.nextCursor).toBeUndefined();
  });

  it("filters by gadget, source, level, since and until, and combines them", async () => {
    let log = workspaceLog();
    let now = Date.now();
    let at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000);
    await log.append([
      server({ time: at(50), text: "a" }),
      server({ time: at(40), gadgetId: 2, level: "error", text: "b" }),
      client({ time: at(30), gadgetId: 2, level: "error", text: "c" }),
      client({ time: at(20), level: "warn", text: "d" }),
      server({ time: at(10), gadgetId: 2, level: "error", text: "e" }),
    ]);
    let texts = async (query: GadgetConsoleLogQuery) =>
        (await log.list(query)).entries.map(entry => entry.text);

    expect(await texts({ gadgetId: 2 })).toEqual(["e", "c", "b"]);
    expect(await texts({ gadgetId: 99 })).toEqual([]);
    expect(await texts({ source: "client" })).toEqual(["d", "c"]);
    expect(await texts({ source: "server" })).toEqual(["e", "b", "a"]);
    expect(await texts({ level: "error" })).toEqual(["e", "c", "b"]);
    expect(await texts({ level: "debug" })).toEqual([]);
    // Both ends are inclusive.
    expect(await texts({ since: at(30) })).toEqual(["e", "d", "c"]);
    expect(await texts({ until: at(30) })).toEqual(["c", "b", "a"]);
    expect(await texts({ since: at(40), until: at(20) })).toEqual(["d", "c", "b"]);
    expect(await texts({ gadgetId: 2, source: "server", level: "error", since: at(45) }))
        .toEqual(["e", "b"]);
    expect(await texts({ gadgetId: 2, source: "server", level: "error", until: at(15) }))
        .toEqual(["b"]);
  });

  it("filters by chat in three forms: a chat, no chat, and any", async () => {
    let log = workspaceLog();
    await log.append([
      server({ chatId: 3, text: "three a" }),
      server({ chatId: 4, text: "four a" }),
      server({ chatId: null, text: "mainline a" }),
      server({ chatId: 3, gadgetId: 2, level: "error", text: "three b" }),
      server({ chatId: null, gadgetId: 2, level: "error", text: "mainline b" }),
      server({ chatId: 3, gadgetId: 2, text: "three c" }),
    ]);
    let texts = async (query?: GadgetConsoleLogQuery) =>
        (await log.list(query)).entries.map(entry => entry.text);
    let all = ["three c", "mainline b", "three b", "mainline a", "four a", "three a"];

    expect(await texts({ chatId: 3 })).toEqual(["three c", "three b", "three a"]);
    expect(await texts({ chatId: null })).toEqual(["mainline b", "mainline a"]);
    expect(await texts({})).toEqual(all);
    expect(await texts({ chatId: undefined })).toEqual(all);
    expect(await texts()).toEqual(all);
    expect(await texts({ chatId: 99 })).toEqual([]);
    expect(await texts({ chatId: 3, gadgetId: 2, level: "error" })).toEqual(["three b"]);
    expect(await texts({ chatId: null, gadgetId: 2, level: "error" })).toEqual(["mainline b"]);
    expect(await texts({ chatId: null, gadgetId: 1 })).toEqual(["mainline a"]);
  });

  it("continues the same filter from a filtered page's cursor", async () => {
    let log = workspaceLog();
    // Chat 3 and no chat in turn, 150 of each.
    await log.append(Array.from({ length: 300 }, (_, i) =>
        server({ chatId: i % 2 === 0 ? 3 : null, text: `entry ${i}` })));

    for (let chatId of [3, null]) {
      let first = await log.list({ chatId });
      expect(first.entries).toHaveLength(GADGET_CONSOLE_LOG_PAGE_SIZE);
      let second = await log.list({ chatId, cursor: first.nextCursor });
      expect(second.entries).toHaveLength(50);
      expect(second.nextCursor).toBeUndefined();
      let listed = [...first.entries, ...second.entries];
      expect(listed.every(entry => entry.chatId === chatId)).toBe(true);
      let offset = chatId === 3 ? 0 : 1;
      expect(listed.map(entry => entry.text))
          .toEqual(Array.from({ length: 150 }, (_, i) => `entry ${298 + offset - 2 * i}`));
    }
  });

  it("reads a page's rows and one more, from a cursor as from the start", async () => {
    let log = workspaceLog();
    await log.append(Array.from({ length: 500 }, () => server()));
    // Kept a minute apart, so the entry a cursor names was kept before the ones above it.
    await sql(log, "UPDATE console_logs SET kept_at = kept_at - (500 - seq) * 60000");
    let { nextCursor: cursor } = await log.list();

    // Every row matches each of these, so a page is its 100 rows and the one that says another
    // page follows, read in order: nothing older is read to be sorted.
    let queries: GadgetConsoleLogQuery[] = [
      {}, { cursor }, { cursor, chatId: null }, { cursor, source: "server" },
      { cursor, level: "log" }, { cursor, gadgetId: 1 },
    ];
    for (let query of queries) {
      expect(await rowsReadByList(log, query), JSON.stringify(query))
          .toBe(GADGET_CONSOLE_LOG_PAGE_SIZE + 1);
    }
  });

  it("throws a TypeError for a malformed cursor and for invalid dates", async () => {
    let log = workspaceLog();
    await log.append([server()]);
    let malformed = [
      "", "abc", "-1", "1.5", " 1", "1e3", "99999999999999999999",
      // A cursor is two numbers.
      "12", "12@", "@34", "12@34@56", "12@-34", "12@3.4", "12@34 ", "12@34\n",
      // Each in its one decimal form: no other spelling of a cursor is one.
      "012@34", "12@034", "00@34", `${"0".repeat(300)}12@34`, "+12@34", "0x12@34",
      "99999999999999999999@34", "12@99999999999999999999", "9007199254740992@34",
    ];
    for (let cursor of malformed) {
      await expectRejection(log.list({ cursor }), "TypeError: Invalid cursor.");
      expect(() => validateGadgetConsoleLogQuery({ cursor })).toThrow(TypeError);
    }
    await expectRejection(log.list({ since: new Date(NaN) }), "TypeError: Invalid since.");
    await expectRejection(log.list({ until: new Date(NaN) }), "TypeError: Invalid until.");
    expect(() => validateGadgetConsoleLogQuery({ since: new Date(NaN) }))
        .toThrow(new TypeError("Invalid since."));
    expect(() => validateGadgetConsoleLogQuery({ until: new Date(NaN) }))
        .toThrow(new TypeError("Invalid until."));
    expect(() => validateGadgetConsoleLogQuery({ cursor: "x" }))
        .toThrow(new TypeError("Invalid cursor."));
    expect(() => validateGadgetConsoleLogQuery(
        { since: new Date(0), until: new Date(), cursor: "12@34" })).not.toThrow();
    expect(() => validateGadgetConsoleLogQuery({ cursor: "9007199254740991@0" })).not.toThrow();
    // A query is refused before the table is looked for.
    await expectRejection(workspaceLog().list({ cursor: "x" }), "TypeError: Invalid cursor.");
  });
});

describe("WorkspaceLogDurableObject.append", () => {
  it("creates nothing for an empty append", async () => {
    let log = workspaceLog();
    await log.append([]);
    expect(await logTables(log)).toEqual([]);
    expect(await getAlarm(log)).toBeNull();
  });

  it("stores an over-long text cut", async () => {
    let log = workspaceLog();
    await log.append([server({ text: "x".repeat(MAX_GADGET_CONSOLE_LOG_TEXT_LENGTH + 500) })]);
    let [{ text }] = (await log.list()).entries;
    expect(text).toBe(`${"x".repeat(MAX_GADGET_CONSOLE_LOG_TEXT_LENGTH - 1)}…`);
    let whole = "y".repeat(MAX_GADGET_CONSOLE_LOG_TEXT_LENGTH);
    await log.append([server({ text: whole })]);
    expect((await log.list()).entries[0].text).toBe(whole);
  });

  it("keeps an entry whose level is none of the five as \"log\"", async () => {
    let log = workspaceLog();
    await log.append([
      server({ level: "trace" as GadgetConsoleLogEntry["level"], text: "unknown" }),
      server({ level: "debug", text: "known" }),
    ]);
    expect((await log.list()).entries.map(entry => [entry.text, entry.level]))
        .toEqual([["known", "debug"], ["unknown", "log"]]);
  });

  it("lists an entry whose time is not a valid date with the time it was kept", async () => {
    let log = workspaceLog();
    let before = Date.now();
    await log.append([server({ time: new Date(NaN) })]);
    let [{ kept_at: keptAt }] = await sql<{ kept_at: number }>(log,
        "SELECT kept_at FROM console_logs");
    expect(keptAt).toBeGreaterThanOrEqual(before);
    expect(keptAt).toBeLessThanOrEqual(Date.now());
    expect((await log.list()).entries[0].time).toEqual(new Date(keptAt));
  });

  it("keeps none of a batch the table refuses, and as a first append no table and no alarm",
      async () => {
    let log = workspaceLog();
    // A "client" entry names its user: the table's CHECK refuses one that does not.
    let refused = [server({ text: "one" }), server({ source: "client", text: "two" })];
    await expectRejection(log.append(refused), "CHECK constraint failed");
    expect(await logTables(log)).toEqual([]);
    expect(await getAlarm(log)).toBeNull();
    expect(await log.list()).toEqual({ entries: [] });

    // The object still works: the schema it rolled back is created by the next append.
    await log.append([server({ text: "kept" })]);
    await expectRejection(log.append(refused), "CHECK constraint failed");
    await expectRejection(
        log.append([server({ text: "three" }), server({ userId: "user-1", text: "four" })]),
        "CHECK constraint failed");
    expect((await log.list()).entries.map(entry => entry.text)).toEqual(["kept"]);
    expect(await rowCount(log)).toBe(1);
    await expectUsageExact(log);
  });
});

describe("what an entry counts toward the bounds", () => {
  it("counts an entry's share of a page, by the length of its text", async () => {
    expect(await counted([0, 300, 1000, 1400, 2000].map(length =>
        server({ text: "x".repeat(length) })))).toEqual([112, 428, 1421, 2103, 4151]);
    // The same with a user id, where there is a text.
    expect(await counted([300, 1000, 1400, 2000].map(length =>
        client({ text: "x".repeat(length) })))).toEqual([428, 1421, 2103, 4151]);
  });

  it("counts a text's UTF-8 length, not its characters", async () => {
    expect(await counted([
      server({ text: "あ".repeat(100) }),
      server({ text: "x".repeat(300) }),
    ])).toEqual([428, 428]);
  });

  it("counts a client entry's user id", async () => {
    expect(await counted([
      server({ text: "x".repeat(1960) }),
      client({ text: "x".repeat(1960), userId: "u".repeat(40) }),
    ])).toEqual([2103, 4151]);
  });

  it("counts a row longer than a page as whole pages", async () => {
    expect(await counted([server({ text: "あ".repeat(2000) })])).toEqual([8247]);
  });

  it("counts a text as it is stored, cut", async () => {
    expect(await counted([server({ text: "x".repeat(5000) })])).toEqual([4151]);
  });

  it.each([
    ["no text", server({ text: "" })],
    ["300 characters", server({ text: "x".repeat(300) })],
    ["1,000 characters", server({ text: "x".repeat(1000) })],
    ["1,400 characters", server({ text: "x".repeat(1400) })],
    ["2,000 characters and a user id", client({ text: "x".repeat(2000), userId: "u".repeat(40) })],
  ])("covers what a database freshly filled with like entries takes: %s", async (_shape, entry) => {
    let { grown, count } = await freshFill([entry]);
    expect(grown).toBeGreaterThan(0);
    expect(grown).toBeLessThanOrEqual(1.02 * count);
  });

  // An entry counts as its share of a page of rows like it, and rows are stored in the order they
  // are kept: a row that leaves the next one no room on its page gives it a page of its own. Two
  // pages next to each other still hold more than a page of rows between them.
  it.each([
    ["a line that fills a page and an empty one",
        [server({ text: "あ".repeat(1338) }), server({ text: "" })], 1.9],
    ["a line that fills half a page and an empty one",
        [server({ text: "x".repeat(1990) }), server({ text: "" })], 1.85],
  ])("covers over half of what a database freshly filled with unlike entries in turn takes: %s",
      async (_mix, shapes, least) => {
    let { grown, count } = await freshFill(shapes);
    expect(grown).toBeGreaterThan(least * count);
    expect(grown).toBeLessThan(2 * count);
  });
});

describe("WorkspaceLogDurableObject reads", () => {
  it("lists a log nothing was appended to as empty, creating no table and no alarm", async () => {
    let log = workspaceLog();
    expect(await log.list()).toEqual({ entries: [] });
    expect(await log.list({ gadgetId: 1, chatId: null })).toEqual({ entries: [] });
    expect(await logTables(log)).toEqual([]);
    expect(await getAlarm(log)).toBeNull();
  });

  it("hides expired rows without deleting them or moving the alarm", async () => {
    let log = workspaceLog();
    await log.append([server({ text: "old" }), server({ text: "older" })]);
    await sql(log, "UPDATE console_logs SET kept_at = ?", Date.now() - RETENTION_MS - 1000);
    let alarm = await getAlarm(log);
    expect(alarm).not.toBeNull();

    expect(await log.list()).toEqual({ entries: [] });
    expect(await log.list({ gadgetId: 1 })).toEqual({ entries: [] });
    expect(await rowCount(log)).toBe(2);
    expect(await getAlarm(log)).toBe(alarm);
    await expectUsageExact(log);

    // Nor does a listing set an alarm where none is set.
    await deleteAlarm(log);
    expect(await log.list()).toEqual({ entries: [] });
    expect(await getAlarm(log)).toBeNull();
  });
});

describe("WorkspaceLogDurableObject, loaded again", () => {
  it("lists what it kept, keeps more, and expires it when its alarm runs", async () => {
    let log = workspaceLog();
    let kept = server({ text: "kept" });
    await log.append([kept]);
    let more = client({ gadgetId: 2, text: "more" });

    let [found, listed] = await loadedAgain(log, async loaded => {
      let before = loaded.list();
      await loaded.append([more]);
      return [before, loaded.list()];
    });
    expect(found).toEqual({ entries: [kept] });
    expect(listed).toEqual({ entries: [more, kept] });
    expect(await rowCount(log)).toBe(2);
    await expectUsageExact(log);

    // An alarm runs days after the append that set it, so it is what most often loads the object
    // again.
    await backdate(log, "text = 'kept'", GADGET_CONSOLE_LOG_RETENTION_HOURS + 1);
    await loadedAgain(log, loaded => loaded.alarm());
    expect(await rowCount(log, "text = 'kept'")).toBe(0);
    expect(await rowCount(log)).toBe(1);
    await expectUsageExact(log);
  });
});

describe("WorkspaceLogDurableObject retention", () => {
  it("keeps an entry 72 hours, by the listing and by the alarm", async () => {
    expect(GADGET_CONSOLE_LOG_RETENTION_HOURS).toBe(72);

    let log = workspaceLog();
    await log.append([
      server({ text: "kept 70 hours ago" }), server({ text: "kept 73 hours ago" }),
      server({ text: "fresh" }),
    ]);
    await backdate(log, "text = 'kept 70 hours ago'", 70);
    await backdate(log, "text = 'kept 73 hours ago'", 73);
    expect((await log.list()).entries.map(entry => entry.text))
        .toEqual(["fresh", "kept 70 hours ago"]);

    await runAlarm(log);
    expect((await sql<{ text: string }>(log, "SELECT text FROM console_logs ORDER BY seq"))
        .map(row => row.text)).toEqual(["kept 70 hours ago", "fresh"]);
    // The next alarm is for when the oldest entry left has been kept 72 hours.
    let [{ kept_at }] = await sql<{ kept_at: number }>(log,
        "SELECT kept_at FROM console_logs WHERE text = 'kept 70 hours ago'");
    expect(await getAlarm(log)).toBe(kept_at + 72 * HOUR_MS);
  });

  it("counts from when an entry was kept, not from its own time: pruned on write", async () => {
    let log = workspaceLog();
    await log.append([server({ time: new Date("2999-01-01T00:00:00Z"), text: "future" })]);
    expect((await log.list()).entries.map(entry => entry.text)).toEqual(["future"]);

    await backdate(log, "text = 'future'", GADGET_CONSOLE_LOG_RETENTION_HOURS + 1);
    expect((await log.list()).entries).toEqual([]);
    expect(await rowCount(log)).toBe(1);

    await log.append([server({ text: "fresh" })]);
    expect(await rowCount(log, "text = 'future'")).toBe(0);
    expect(await rowCount(log)).toBe(1);
    await expectUsageExact(log);
  });

  it("counts from when an entry was kept, not from its own time: pruned by alarm", async () => {
    let log = workspaceLog();
    await log.append([
      server({ time: new Date("2999-01-01T00:00:00Z"), text: "future" }),
      server({ text: "fresh" }),
    ]);
    await backdate(log, "text = 'future'", GADGET_CONSOLE_LOG_RETENTION_HOURS + 1);
    expect(await rowCount(log)).toBe(2);

    await runAlarm(log);
    expect(await rowCount(log, "text = 'future'")).toBe(0);
    expect(await rowCount(log)).toBe(1);
    await expectUsageExact(log);
  });

  it("keeps an entry whose own time is past the retention, and finds it by that time", async () => {
    let log = workspaceLog();
    let time = new Date(Date.now() - 80 * HOUR_MS);
    let started = Date.now();
    await log.append([server({ time, text: "late" })]);

    expect((await log.list()).entries).toEqual([server({ time, text: "late" })]);
    expect((await log.list({ since: time, until: time })).entries).toHaveLength(1);
    expect((await log.list({ since: new Date(time.getTime() + 1) })).entries).toEqual([]);
    expect((await log.list({ until: new Date(time.getTime() - 1) })).entries).toEqual([]);
    // The alarm follows when the entry was kept: about 72 hours away, not the hour's minimum.
    let alarm = await getAlarm(log);
    expect(alarm).toBeGreaterThanOrEqual(started + RETENTION_MS);
    expect(alarm).toBeLessThanOrEqual(Date.now() + RETENTION_MS);
  });

  it("prunes expired rows on write, of a gadget the write is not for", async () => {
    let log = workspaceLog();
    await log.append([server({ gadgetId: 1, text: "one" }), server({ gadgetId: 2, text: "two" })]);
    await backdate(log, "gadget_id = 2", GADGET_CONSOLE_LOG_RETENTION_HOURS + 1);

    await log.append([server({ gadgetId: 1, text: "three" })]);
    expect(await rowCount(log, "gadget_id = 2")).toBe(0);
    expect(await rowCount(log, "gadget_id = 1")).toBe(2);
    let usage = await expectUsageExact(log);
    expect(usage.map(row => row.gadget_id)).toEqual([1]);
  });

  it("prunes by alarm, which re-arms while rows remain", async () => {
    let log = workspaceLog();
    let started = Date.now();
    await log.append([server({ text: "one" }), server({ gadgetId: 2, text: "two" })]);
    let first = await getAlarm(log);
    expect(first).toBeGreaterThanOrEqual(started + RETENTION_MS);
    expect(first).toBeLessThanOrEqual(Date.now() + RETENTION_MS);

    await backdate(log, "text = 'one'", GADGET_CONSOLE_LOG_RETENTION_HOURS + 1);
    // As when the platform runs it: the alarm that fired is no longer set.
    await deleteAlarm(log);
    await runAlarm(log);
    expect(await rowCount(log, "text = 'one'")).toBe(0);
    expect(await rowCount(log)).toBe(1);
    // Set again, for when the row that is left expires.
    expect(await getAlarm(log)).toBe(first);
    await expectUsageExact(log);
  });

  it("leaves a standing alarm where it is on append", async () => {
    let log = workspaceLog();
    await log.append([server({ text: "one" })]);
    // A time that no append computes, so an append that set the alarm would move it.
    let standing = Date.now() + 5 * HOUR_MS;
    await setAlarm(log, standing);

    await log.append([server({ text: "two" })]);
    expect(await getAlarm(log)).toBe(standing);
    expect(await rowCount(log)).toBe(2);
  });

  it("sets a missing alarm on append for when the oldest row expires, no sooner than an hour away",
      async () => {
    let log = workspaceLog();
    await log.append([server({ text: "old" })]);
    let keptAt = Date.now() - 10 * HOUR_MS;
    await sql(log, "UPDATE console_logs SET kept_at = ?", keptAt);
    await deleteAlarm(log);

    await log.append([server({ text: "fresh" })]);
    // When the older row expires, not 72 hours from this append.
    expect(await getAlarm(log)).toBe(keptAt + RETENTION_MS);

    // Half an hour short of expiring.
    await backdate(log, "text = 'old'", GADGET_CONSOLE_LOG_RETENTION_HOURS - 0.5);
    await deleteAlarm(log);
    let before = Date.now();
    await log.append([server({ text: "fresher" })]);
    let alarm = await getAlarm(log);
    expect(alarm).toBeGreaterThanOrEqual(before + HOUR_MS);
    expect(alarm).toBeLessThanOrEqual(Date.now() + HOUR_MS);
    expect(await rowCount(log)).toBe(3);
  });

  it("re-arms no sooner than an hour away", async () => {
    let log = workspaceLog();
    await log.append([server({ text: "one" }), server({ text: "two" })]);
    await backdate(log, "text = 'one'", GADGET_CONSOLE_LOG_RETENTION_HOURS + 1);
    // Half an hour short of expiring.
    await backdate(log, "text = 'two'", GADGET_CONSOLE_LOG_RETENTION_HOURS - 0.5);

    let before = Date.now();
    await runAlarm(log);
    expect(await rowCount(log)).toBe(1);
    let alarm = await getAlarm(log);
    expect(alarm).toBeGreaterThanOrEqual(before + HOUR_MS);
    expect(alarm).toBeLessThanOrEqual(Date.now() + HOUR_MS);
  });

  it("expires at most 10,000 rows at a time, and runs again at once for the rest", async () => {
    let log = await emptyLog();
    await sql(log, `INSERT INTO console_logs
        (kept_at, at, gadget_id, chat_id, source, user_id, level, text, bytes)
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10050)
        SELECT ?1, ?1, 1 + i % 3, NULL, 'server', NULL, 'log', '', 100 FROM n`,
        Date.now() - RETENTION_MS - HOUR_MS);

    // Read inside the object, before it takes another event: an alarm set for now runs at once.
    let before = Date.now();
    let { left, alarm } = await runInDurableObject(log,
        async (instance: WorkspaceLogDurableObject, state) => {
      await instance.alarm();
      let [{ count }] = state.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM console_logs").toArray();
      return { left: count, alarm: await state.storage.getAlarm() };
    });
    expect(left).toBe(50);
    expect(alarm).toBeGreaterThanOrEqual(before);
    expect(alarm).toBeLessThanOrEqual(Date.now());

    // Whichever runs first, this alarm or the one that was set, the other finds no table.
    await runAlarm(log);
    expect(await logTables(log)).toEqual([]);
  });

  it("deletes the object's storage from an alarm that finds nothing left", async () => {
    let log = workspaceLog();
    await log.append([server()]);
    await backdate(log, "1", GADGET_CONSOLE_LOG_RETENTION_HOURS + 1);

    await runAlarm(log);
    expect(await logTables(log)).toEqual([]);
    expect(await getAlarm(log)).toBeNull();
    expect(await log.list()).toEqual({ entries: [] });
    expect(await logTables(log)).toEqual([]);

    // An alarm that finds no table does nothing.
    await runAlarm(log);
    expect(await logTables(log)).toEqual([]);
    expect(await getAlarm(log)).toBeNull();

    await log.append([server({ text: "again" })]);
    expect((await log.list()).entries.map(entry => entry.text)).toEqual(["again"]);
    expect(await getAlarm(log)).not.toBeNull();
    await expectUsageExact(log);
  });

  it("does not throw from an alarm that cannot delete, and tries again in an hour", async () => {
    let log = workspaceLog();
    await log.append([server()]);
    // A table the expiry cannot run on.
    await sql(log, "DROP TABLE console_logs");
    await sql(log, "CREATE TABLE console_logs (x INTEGER)");
    await deleteAlarm(log);
    expect(await getAlarm(log)).toBeNull();

    let warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    let before = Date.now();
    await runAlarm(log);

    let alarm = await getAlarm(log);
    expect(alarm).toBeGreaterThanOrEqual(before + HOUR_MS);
    expect(alarm).toBeLessThanOrEqual(Date.now() + HOUR_MS);
    let failures = warnings.mock.calls.map(([line]) => line as Record<string, unknown>)
        .filter(line => line.event === "gadget.console.expire.failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      component: "workshop.workspace-log", message: "failed to expire gadget console logs",
    });
  });
});

describe("WorkspaceLogDurableObject byte bounds", () => {
  it("holds a gadget's server entries to their part, deleting its oldest", async () => {
    let log = workspaceLog();
    await log.append([server({ gadgetId: 2, text: "other" })]);
    await insertRows(log, 1, "server", Array.from({ length: 5 }, () => 2_000_000));
    expect(usageOf(await expectUsageExact(log), 1, "server"))
        .toBeGreaterThan(SERVER_BYTES_PER_GADGET);
    let before = await seqRows(log);

    await log.append([server({ gadgetId: 1, text: "small" })]);

    // The two oldest of gadget 1 went: one would have left it over its part.
    let gone = deleted(before, await seqRows(log));
    expect(gone).toEqual(before.filter(row => row.gadget_id === 1).slice(0, 2));
    let usage = await expectUsageExact(log);
    expect(usageOf(usage, 1, "server")).toBeLessThanOrEqual(SERVER_BYTES_PER_GADGET);
    expect(usageOf(usage, 1, "server")).toBeGreaterThan(6_000_000);
    expect(await rowCount(log, "gadget_id = 1")).toBe(4);
    expect(await rowCount(log, "gadget_id = 2")).toBe(1);
    expect((await log.list({ gadgetId: 1 })).entries[0].text).toBe("small");
  });

  it("leaves a gadget's server rows when its client rows pass their part", async () => {
    let log = await emptyLog();
    // The server rows are the oldest of the table.
    await insertRows(log, 1, "server", [2_000_000, 2_000_000, 2_000_000]);
    await insertRows(log, 1, "client", [900_000, 900_000, 900_000]);
    let before = await seqRows(log);

    await log.append([client({ gadgetId: 1, text: "small" })]);

    let gone = deleted(before, await seqRows(log));
    expect(gone).toEqual([before.filter(row => row.source === "client")[0]]);
    let usage = await expectUsageExact(log);
    expect(usageOf(usage, 1, "client"))
        .toBeLessThanOrEqual(GADGET_CONSOLE_LOG_CLIENT_BYTES_PER_GADGET);
    expect(usageOf(usage, 1, "server")).toBe(6_000_000);
    expect(await rowCount(log, "source = 'server'")).toBe(3);
  });

  it("leaves a gadget's client rows when its server rows pass their part", async () => {
    let log = await emptyLog();
    // The client rows are the oldest of the table.
    await insertRows(log, 1, "client", [900_000, 900_000]);
    await insertRows(log, 1, "server", Array.from({ length: 5 }, () => 2_000_000));
    let before = await seqRows(log);

    await log.append([server({ gadgetId: 1, text: "small" })]);

    let gone = deleted(before, await seqRows(log));
    expect(gone).toEqual(before.filter(row => row.source === "server").slice(0, 2));
    let usage = await expectUsageExact(log);
    expect(usageOf(usage, 1, "server")).toBeLessThanOrEqual(SERVER_BYTES_PER_GADGET);
    expect(usageOf(usage, 1, "client")).toBe(1_800_000);
    expect(await rowCount(log, "source = 'client'")).toBe(2);
  });

  it("holds each gadget and source of one batch", async () => {
    let log = await emptyLog();
    await insertRows(log, 1, "server", Array.from({ length: 5 }, () => 2_000_000));
    await insertRows(log, 1, "client", [900_000, 900_000, 900_000]);
    await insertRows(log, 2, "client", [900_000, 900_000, 900_000]);
    // Over its part, and not written to by the batch: it is held when it is next written to.
    await insertRows(log, 3, "client", [900_000, 900_000, 900_000]);

    await log.append([
      server({ gadgetId: 1 }), client({ gadgetId: 1 }), client({ gadgetId: 2 }),
      server({ gadgetId: 2 }),
    ]);

    let usage = await expectUsageExact(log);
    expect(usageOf(usage, 1, "server")).toBeLessThanOrEqual(SERVER_BYTES_PER_GADGET);
    expect(usageOf(usage, 1, "client"))
        .toBeLessThanOrEqual(GADGET_CONSOLE_LOG_CLIENT_BYTES_PER_GADGET);
    expect(usageOf(usage, 2, "client"))
        .toBeLessThanOrEqual(GADGET_CONSOLE_LOG_CLIENT_BYTES_PER_GADGET);
    expect(await rowCount(log, "gadget_id = 1 AND source = 'server'")).toBe(4);
    expect(await rowCount(log, "gadget_id = 1 AND source = 'client'")).toBe(3);
    expect(await rowCount(log, "gadget_id = 2 AND source = 'client'")).toBe(3);
    expect(await rowCount(log, "gadget_id = 2 AND source = 'server'")).toBe(1);
    expect(usageOf(usage, 3, "client")).toBe(2_700_000);
  });

  it("holds the workspace's server entries to their part, taking from a gadget that holds the most",
      async () => {
    let log = await emptyLog();
    // The gadget that holds little has the oldest rows of the table and the lowest id.
    await insertRows(log, 1, "server", [2000, 2000]);
    for (let gadgetId = 2; gadgetId <= 6; gadgetId++) {
      await insertRows(log, gadgetId, "server",
          [...Array.from({ length: 7 }, () => 1_000_000), 999_000]);
    }
    let seeded = await expectUsageExact(log);
    expect(totalOf(seeded, "server")).toBe(39_999_000);
    let before = await seqRows(log);

    await log.append([server({ gadgetId: 1, text: "x".repeat(1000) })]);

    let usage = await expectUsageExact(log);
    expect(totalOf(usage, "server")).toBeLessThanOrEqual(SERVER_BYTES_PER_WORKSPACE);
    // One row went, the oldest of one of the five: not the oldest of the table, which are the
    // first gadget's.
    let gone = deleted(before, await seqRows(log));
    expect(gone).toHaveLength(1);
    expect(gone[0].gadget_id).not.toBe(1);
    expect(gone[0]).toEqual(before.find(row => row.gadget_id === gone[0].gadget_id));
    expect(await rowCount(log, "gadget_id = 1")).toBe(3);
    expect(totalOf(usage, "server")).toBe(39_999_000 + 1421 - 1_000_000);
  });

  it("deletes expired rows before it holds a bound, so none within its retention goes for them",
      async () => {
    let log = await emptyLog();
    await insertRows(log, 1, "server", [2000, 2000]);
    await backdate(log, "gadget_id = 1", GADGET_CONSOLE_LOG_RETENTION_HOURS + 1);
    for (let gadgetId = 2; gadgetId <= 6; gadgetId++) {
      await insertRows(log, gadgetId, "server",
          [...Array.from({ length: 7 }, () => 1_000_000), 999_000]);
    }
    expect(totalOf(await expectUsageExact(log), "server")).toBe(39_999_000);

    // Past the workspace's server part only while the expired rows are counted.
    await log.append([server({ gadgetId: 1, text: "x".repeat(1000) })]);

    expect(await rowCount(log, "gadget_id > 1")).toBe(40);
    expect(await rowCount(log, "gadget_id = 1")).toBe(1);
    expect(totalOf(await expectUsageExact(log), "server")).toBe(39_995_000 + 1421);
  });

  it("deletes expired rows past one batch of 10,000 before a row within its retention goes",
      async () => {
    let log = await emptyLog();
    // More expired client rows than one batch deletes, kept before the expired server rows.
    await insertRowsKept(log, GADGET_CONSOLE_LOG_RETENTION_HOURS + 2, 10_050, 9, "client", 150);
    await insertRows(log, 1, "server", [2000, 2000]);
    await backdate(log, "gadget_id = 1", GADGET_CONSOLE_LOG_RETENTION_HOURS + 1);
    for (let gadgetId = 2; gadgetId <= 6; gadgetId++) {
      await insertRows(log, gadgetId, "server",
          [...Array.from({ length: 7 }, () => 1_000_000), 999_000]);
    }
    expect(totalOf(await expectUsageExact(log), "server")).toBe(39_999_000);

    // Past the workspace's server part only while the expired server rows are counted, and the
    // first batch holds none of them.
    await log.append([server({ gadgetId: 1, text: "x".repeat(1000) })]);

    expect(await rowCount(log, "gadget_id BETWEEN 2 AND 6")).toBe(40);
    expect(await rowCount(log, "gadget_id = 1")).toBe(1);
    expect(await rowCount(log, "gadget_id = 9")).toBe(0);
    expect(totalOf(await expectUsageExact(log), "server")).toBe(39_995_000 + 1421);
  });

  it("deletes one batch of expired rows on a write that passes no bound", async () => {
    let log = await emptyLog();
    await insertRowsKept(log, GADGET_CONSOLE_LOG_RETENTION_HOURS + 1, 10_050, 1, "server", 100);

    await log.append([server({ gadgetId: 2 })]);

    expect(await rowCount(log, "gadget_id = 1")).toBe(50);
    expect(await rowCount(log, "gadget_id = 2")).toBe(1);
    await expectUsageExact(log);
  });

  it("holds the workspace's client entries to their part, leaving server rows", async () => {
    let log = await emptyLog();
    // The gadget whose client rows are few has the oldest of them and the lowest id, and holds
    // more than any other gadget once its server rows are counted: a source's part is taken from
    // the gadget holding the most of that source.
    await insertRows(log, 1, "client", [2000, 2000]);
    await insertRows(log, 1, "server", [3_000_000, 3_000_000]);
    for (let gadgetId = 2; gadgetId <= 6; gadgetId++) {
      await insertRows(log, gadgetId, "client", [1_000_000, 999_000]);
    }
    await insertRows(log, 7, "server", [3_000_000]);
    let seeded = await expectUsageExact(log);
    expect(totalOf(seeded, "client")).toBe(9_999_000);
    let before = await seqRows(log);

    await log.append([client({ gadgetId: 1, text: "x".repeat(1000) })]);

    let usage = await expectUsageExact(log);
    expect(totalOf(usage, "client"))
        .toBeLessThanOrEqual(GADGET_CONSOLE_LOG_CLIENT_BYTES_PER_WORKSPACE);
    let gone = deleted(before, await seqRows(log));
    expect(gone).toHaveLength(1);
    expect(gone[0].source).toBe("client");
    expect(gone[0].gadget_id).not.toBe(1);
    expect(gone[0]).toEqual(
        before.find(row => row.gadget_id === gone[0].gadget_id && row.source === "client"));
    expect(await rowCount(log, "gadget_id = 1 AND source = 'client'")).toBe(3);
    expect(totalOf(usage, "server")).toBe(9_000_000);
    expect(await rowCount(log, "source = 'server'")).toBe(3);
  });

  it("takes from the next gadget once the one holding the most has no row left", async () => {
    let log = await emptyLog();
    // Written by SQL, past what append() would have left any one gadget, and in no order of id.
    await insertRows(log, 1, "server", [28_000_000]);
    await insertRows(log, 2, "server", [30_000_000]);
    await insertRows(log, 3, "server", [29_000_000]);

    await log.append([server({ gadgetId: 4, text: "small" })]);

    // The second gadget's row went, then the third's, and the total was within the part.
    let usage = await expectUsageExact(log);
    expect(usage.map(row => row.gadget_id)).toEqual([1, 4]);
    expect(usageOf(usage, 1, "server")).toBe(28_000_000);
    expect(totalOf(usage, "server")).toBeLessThanOrEqual(SERVER_BYTES_PER_WORKSPACE);
    expect((await log.list()).entries.map(entry => entry.text)).toEqual(["small", ""]);
  });

  it("holds the workspace's part for each source of one batch", async () => {
    let log = await emptyLog();
    // Written by SQL, each source past its part of the workspace.
    for (let gadgetId of [1, 2]) {
      await insertRows(log, gadgetId, "server", [25_000_000]);
      await insertRows(log, gadgetId, "client", [6_000_000]);
    }

    await log.append([server({ gadgetId: 3 }), client({ gadgetId: 3 })]);

    // One gadget's row went for each source.
    let usage = await expectUsageExact(log);
    expect(totalOf(usage, "server")).toBeLessThanOrEqual(SERVER_BYTES_PER_WORKSPACE);
    expect(totalOf(usage, "server")).toBeGreaterThan(25_000_000);
    expect(totalOf(usage, "client"))
        .toBeLessThanOrEqual(GADGET_CONSOLE_LOG_CLIENT_BYTES_PER_WORKSPACE);
    expect(totalOf(usage, "client")).toBeGreaterThan(6_000_000);
    expect(await rowCount(log, "gadget_id = 3")).toBe(2);
  });
});

describe("WorkspaceLogDurableObject.destroy", () => {
  it("leaves no table and no alarm, and a later append works", async () => {
    let log = workspaceLog();
    await log.append([server(), client()]);
    expect(await logTables(log)).toEqual(["console_log_usage", "console_logs"]);
    expect(await getAlarm(log)).not.toBeNull();

    await log.destroy();
    expect(await logTables(log)).toEqual([]);
    expect(await getAlarm(log)).toBeNull();
    expect(await log.list()).toEqual({ entries: [] });
    expect(await logTables(log)).toEqual([]);

    // Destroying a log that holds nothing is not an error.
    await log.destroy();
    await workspaceLog().destroy();

    await log.append([server({ text: "again" })]);
    expect((await log.list()).entries.map(entry => entry.text)).toEqual(["again"]);
    expect(await getAlarm(log)).not.toBeNull();
    await expectUsageExact(log);
  });
});
