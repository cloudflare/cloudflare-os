import {
  MAX_GADGET_CONSOLE_LOG_TEXT_LENGTH,
  type GadgetConsoleLogEntry, type GadgetConsoleLogPage, type GadgetConsoleLogQuery,
  type WorkpieceId,
} from "@gadgets/workshop-shared/api";
import { DurableObject } from "cloudflare:workers";
import { cutAdminAuditText } from "./admin-access.js";
import { createWorkshopLogger } from "./observability.js";

const logger = createWorkshopLogger("workshop.workspace-log");

const HOUR_MS = 60 * 60_000;

/** How long a gadget console log entry is kept, in hours, counted from when it was kept. */
export const GADGET_CONSOLE_LOG_RETENTION_HOURS = 72;
/** The most one workspace's kept entries may count, in bytes, each entry counted as an estimate of
 * what it takes in storage. "client" entries may take GADGET_CONSOLE_LOG_CLIENT_BYTES_PER_WORKSPACE
 * of it and "server" entries the rest. */
export const GADGET_CONSOLE_LOG_BYTES_PER_WORKSPACE = 50_000_000;
/** The part of GADGET_CONSOLE_LOG_BYTES_PER_WORKSPACE that "client" entries may take. Nothing
 * verifies what a browser reports, so reported entries push out only other reported entries. */
export const GADGET_CONSOLE_LOG_CLIENT_BYTES_PER_WORKSPACE = 10_000_000;
/** The most one gadget's kept entries may count, in bytes: its "client" entries
 * GADGET_CONSOLE_LOG_CLIENT_BYTES_PER_GADGET of it and its "server" entries the rest. */
export const GADGET_CONSOLE_LOG_BYTES_PER_GADGET = 10_000_000;
/** The part of GADGET_CONSOLE_LOG_BYTES_PER_GADGET that a gadget's "client" entries may take. */
export const GADGET_CONSOLE_LOG_CLIENT_BYTES_PER_GADGET = 2_000_000;
/** How many entries one page of list() holds. Every page but the last is full. */
export const GADGET_CONSOLE_LOG_PAGE_SIZE = 100;

const RETENTION_MS = GADGET_CONSOLE_LOG_RETENTION_HOURS * HOUR_MS;
// Expired rows that are deleted at a time. An alarm deletes one batch and runs again for the rest,
// so that a log left unused for long is trimmed over several alarms rather than in one long write.
// An append deletes one batch too, and more only while the workspace is past a bound that expired
// rows still count toward (#holdBounds).
const EXPIRY_BATCH = 10_000;

type Source = GadgetConsoleLogEntry["source"];
// The levels an entry is kept with: the ones the table's CHECK allows.
const LEVELS: ReadonlySet<string> = new Set<GadgetConsoleLogEntry["level"]>(
    ["debug", "info", "log", "warn", "error"]);

// Each source is held to its own bounds and loses only its own entries: nothing verifies what a
// browser reports, so if the two shared a bound, any member who may report could push a gadget's
// server entries out.
function gadgetBound(source: Source): number {
  return source === "client" ? GADGET_CONSOLE_LOG_CLIENT_BYTES_PER_GADGET
      : GADGET_CONSOLE_LOG_BYTES_PER_GADGET - GADGET_CONSOLE_LOG_CLIENT_BYTES_PER_GADGET;
}

function workspaceBound(source: Source): number {
  return source === "client" ? GADGET_CONSOLE_LOG_CLIENT_BYTES_PER_WORKSPACE
      : GADGET_CONSOLE_LOG_BYTES_PER_WORKSPACE - GADGET_CONSOLE_LOG_CLIENT_BYTES_PER_WORKSPACE;
}

// The database keeps a table's rows in pages of this size, a row whole on one page.
const PAGE_BYTES = 4096;
// What a row takes beside its text and user id, with room for large ids.
const ROW_OVERHEAD_BYTES = 56;
// What a row's entries in the three indexes take.
const INDEX_BYTES = 55;

const encoder = new TextEncoder();
const utf8Length = (value: string) => encoder.encode(value).length;

// What an entry counts toward the byte bounds: an estimate of the database bytes it takes when it
// is written. A row counts as its share of a page filled with rows like it, because rows share a
// page only whole: three rows of about 1,000 characters take a page between them, and a row over
// half a page has one to itself. A row longer than a page counts as whole pages. Counting only the
// text's bytes would let entries of 2,000 characters, each on a page of its own, take twice the
// bound in storage.
//
// The bounds are on this count, not on the database, which can take more:
// - The share is exact only among like rows. Rows are stored in the order they are kept, and a row
//   that leaves the next one no room on its page gives it a page of its own, so a line that fills
//   half a page or all of one, kept in turn with empty lines, takes nearly twice what the two
//   count. A freshly filled database stays under about twice the count whatever the mix: two
//   pages next to each other hold more than a page of rows between them.
// - Once entries are pruned, a page that lost one gadget's old rows stays part-empty while it
//   still holds newer rows of other gadgets.
function entryBytes(text: string, userId?: string): number {
  let row = utf8Length(text) + utf8Length(userId ?? "") + ROW_OVERHEAD_BYTES;
  let pages = row > PAGE_BYTES ? Math.ceil(row / PAGE_BYTES) : 1 / Math.floor(PAGE_BYTES / row);
  return Math.ceil(pages * PAGE_BYTES) + INDEX_BYTES;
}

// A cursor names the last entry of its page as "<seq>@<kept_at>", each number in its one decimal
// form: a cursor has one spelling, so a caller that records the cursor it read from (the admin
// view does) records which page that was. The next page is the entries below that sequence number
// that were kept no later than that entry. The second condition is for a cursor that outlived the
// schema: the alarm deletes the schema once every entry has expired, the sequence starts again at
// 1 with the next append, and an entry kept since must not be listed as an older one.
type Cursor = { seq: number; keptAt: number };
const CURSOR = /^(0|[1-9][0-9]*)@(0|[1-9][0-9]*)$/;

// The entry a cursor names, or undefined for a string that is not a cursor.
function parseCursor(cursor: string): Cursor | undefined {
  let match = CURSOR.exec(cursor);
  if (match === null) return undefined;
  let seq = Number(match[1]);
  let keptAt = Number(match[2]);
  return Number.isSafeInteger(seq) && Number.isSafeInteger(keptAt) ? { seq, keptAt } : undefined;
}

/** Throws a TypeError unless `since` and `until` are valid times and `cursor` is a cursor. */
export function validateGadgetConsoleLogQuery(query: GadgetConsoleLogQuery): void {
  if (query.since !== undefined && Number.isNaN(query.since.getTime())) {
    throw new TypeError("Invalid since.");
  }
  if (query.until !== undefined && Number.isNaN(query.until.getTime())) {
    throw new TypeError("Invalid until.");
  }
  if (query.cursor !== undefined && parseCursor(query.cursor) === undefined) {
    throw new TypeError("Invalid cursor.");
  }
}

type LogRow = {
  seq: number;
  kept_at: number;
  at: number;
  gadget_id: WorkpieceId;
  chat_id: number | null;
  source: Source;
  user_id: string | null;
  level: GadgetConsoleLogEntry["level"];
  text: string;
};

function entryFromRow(row: LogRow): GadgetConsoleLogEntry {
  return {
    time: new Date(row.at), gadgetId: row.gadget_id, chatId: row.chat_id, source: row.source,
    ...(row.user_id !== null && { userId: row.user_id }),
    level: row.level, text: row.text,
  };
}

/**
 * One workspace's gadget console log history: its entries, bounded in age and in bytes.
 *
 * An entry is kept GADGET_CONSOLE_LOG_RETENTION_HOURS hours. The entries of each source are held
 * to that source's part of GADGET_CONSOLE_LOG_BYTES_PER_GADGET for one gadget and of
 * GADGET_CONSOLE_LOG_BYTES_PER_WORKSPACE for the workspace, a gadget's oldest deleted first. The
 * bounds are enforced by append(), and the retention by the alarm as well, so that a log nothing
 * is appended to still empties.
 *
 * Schema, created by the first append() and never by a read or the constructor, since deleting
 * everything the object holds deletes the tables too.
 *   console_logs(seq INTEGER PRIMARY KEY AUTOINCREMENT, kept_at INTEGER NOT NULL,
 *     at INTEGER NOT NULL, gadget_id INTEGER NOT NULL, chat_id INTEGER,
 *     source TEXT NOT NULL CHECK (source IN ('server', 'client')), user_id TEXT,
 *     level TEXT NOT NULL CHECK (level IN ('debug', 'info', 'log', 'warn', 'error')),
 *     text TEXT NOT NULL, bytes INTEGER NOT NULL,
 *     CHECK ((source = 'client') = (user_id IS NOT NULL))) STRICT;
 *   indexes, each for one job: (gadget_id, seq) pages one gadget's entries;
 *     (gadget_id, source, seq) reads and deletes the oldest entries of one gadget and source;
 *     (kept_at) finds expired entries
 *   console_log_usage(gadget_id INTEGER NOT NULL, source TEXT NOT NULL, bytes INTEGER NOT NULL,
 *     PRIMARY KEY (gadget_id, source)) STRICT, WITHOUT ROWID;
 * A row has two times (both epoch ms). `kept_at` is when this object kept it, by its own clock,
 * and is what the retention counts from. `at` is the entry's own `time`, which for a "client"
 * entry is whatever a browser said: the retention must not follow a time its caller chose.
 * `bytes` is what the entry counts toward the bounds (entryBytes()). console_log_usage holds the
 * sum of `bytes` for each gadget and source that has entries, kept exact by two triggers on
 * console_logs, so that a bound is checked without reading the entries.
 */
export class WorkspaceLogDurableObject extends DurableObject<Cloudflare.Env> {
  // Whether the schema exists.
  #hasTable: boolean;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.#hasTable = ctx.storage.sql.exec(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'console_logs'")
        .toArray().length > 0;
  }

  /** Keeps `entries` in order, all of them or none, each stamped with this object's clock; deletes
   * what the retention and the byte bounds no longer allow; and sets the alarm when none is set.
   * It trusts its caller for nothing it bounds: a text is cut again, a level it does not know is
   * kept as "log", and an entry's own `time` decides neither how long it is kept nor the alarm. */
  async append(entries: GadgetConsoleLogEntry[]): Promise<void> {
    if (entries.length === 0) return;
    let now = Date.now();
    let sql = this.ctx.storage.sql;

    // One transaction, so a batch is kept whole or not at all: an insert that throws (a row the
    // table's CHECKs refuse, a full disk) rolls back the rows before it and, on a first append,
    // the schema too, and append() rejects with that error.
    this.ctx.storage.transactionSync(() => {
      if (!this.#hasTable) this.#createSchema();
      let written = new Map<WorkpieceId, Set<Source>>();
      for (let entry of entries) {
        let at = entry.time.getTime();
        let text = cutAdminAuditText(entry.text, MAX_GADGET_CONSOLE_LOG_TEXT_LENGTH);
        sql.exec(
          `INSERT INTO console_logs
             (kept_at, at, gadget_id, chat_id, source, user_id, level, text, bytes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          now, Number.isNaN(at) ? now : at, entry.gadgetId, entry.chatId ?? null, entry.source,
          entry.userId ?? null, LEVELS.has(entry.level) ? entry.level : "log", text,
          entryBytes(text, entry.userId));
        let sources = written.get(entry.gadgetId);
        if (sources === undefined) {
          sources = new Set();
          written.set(entry.gadgetId, sources);
        }
        sources.add(entry.source);
      }
      this.#expire(now);
      this.#holdBounds(written, now);
    });
    this.#hasTable = true;

    // A standing alarm stays: rows are stamped with this object's clock as they arrive, so no
    // later batch is older than what the alarm was set for.
    if ((await this.ctx.storage.getAlarm()) === null) {
      let next = this.#nextExpiry(now);
      if (next !== null) await this.ctx.storage.setAlarm(next);
    }
  }

  /** One page. Reads only: creates no table, deletes nothing and sets no alarm. */
  list(query: GadgetConsoleLogQuery = {}): GadgetConsoleLogPage {
    validateGadgetConsoleLogQuery(query);
    if (!this.#hasTable) return { entries: [] };

    // An expired row is hidden here, whether or not it has been deleted yet.
    let where = ["kept_at > ?"];
    let params: (string | number)[] = [Date.now() - RETENTION_MS];
    if (query.gadgetId !== undefined) {
      where.push("gadget_id = ?");
      params.push(query.gadgetId);
    }
    // Three forms: a chat, null for the entries kept under no chat, and undefined for any.
    if (query.chatId === null) {
      where.push("chat_id IS NULL");
    } else if (query.chatId !== undefined) {
      where.push("chat_id = ?");
      params.push(query.chatId);
    }
    if (query.source !== undefined) {
      where.push("source = ?");
      params.push(query.source);
    }
    if (query.level !== undefined) {
      where.push("level = ?");
      params.push(query.level);
    }
    // `since` and `until` filter on the entry's own time; the retention does not.
    if (query.since !== undefined) {
      where.push("at >= ?");
      params.push(query.since.getTime());
    }
    if (query.until !== undefined) {
      where.push("at <= ?");
      params.push(query.until.getTime());
    }
    let cursor = query.cursor === undefined ? undefined : parseCursor(query.cursor);
    if (cursor !== undefined) {
      // The unary plus keeps this term out of the choice of index. A page is read by walking
      // `seq` downwards until it is full. With a range on `kept_at` from both sides, the index on
      // it is chosen instead: every unexpired row older than the cursor is then read and sorted
      // for each page.
      where.push("seq < ? AND +kept_at <= ?");
      params.push(cursor.seq, cursor.keptAt);
    }

    let limit = GADGET_CONSOLE_LOG_PAGE_SIZE;
    let rows = this.ctx.storage.sql.exec<LogRow>(
      `SELECT seq, kept_at, at, gadget_id, chat_id, source, user_id, level, text
       FROM console_logs WHERE ${where.join(" AND ")} ORDER BY seq DESC LIMIT ?`,
      ...params, limit + 1).toArray();
    let page: GadgetConsoleLogPage = { entries: rows.slice(0, limit).map(entryFromRow) };
    if (rows.length > limit) {
      let last = rows[limit - 1];
      page.nextCursor = `${last.seq}@${last.kept_at}`;
    }
    return page;
  }

  /** Deletes everything the object holds, its alarm included. */
  async destroy(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.#hasTable = false;
  }

  /** Deletes expired entries, then sets the next alarm, or deletes everything the object holds
   * once no entry remains. A failure is logged and tried again in an hour, not thrown. */
  async alarm(): Promise<void> {
    // The platform retries an alarm that throws only a few times and then leaves none set, and
    // expired rows would then stay stored until the next append. So a failure is caught and the
    // alarm set again here. If setting it throws too, the error leaves alarm() and the platform's
    // retries take over.
    try {
      if (!this.#hasTable) return;
      let now = Date.now();
      this.#expire(now);
      let next = this.#nextExpiry(now);
      if (next !== null) {
        await this.ctx.storage.setAlarm(next);
      } else {
        // A log whose entries have all expired leaves nothing behind, neither its schema nor an
        // alarm, and neither does an object that an append reached after its workspace was
        // deleted.
        await this.ctx.storage.deleteAll();
        this.#hasTable = false;
      }
    } catch (error) {
      logger.warn("failed to expire gadget console logs",
        { event: "gadget.console.expire.failed", error });
      await this.ctx.storage.setAlarm(Date.now() + HOUR_MS);
    }
  }

  #createSchema(): void {
    let sql = this.ctx.storage.sql;
    sql.exec(`CREATE TABLE console_logs (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      kept_at INTEGER NOT NULL,
      at INTEGER NOT NULL,
      gadget_id INTEGER NOT NULL,
      chat_id INTEGER,
      source TEXT NOT NULL CHECK (source IN ('server', 'client')),
      user_id TEXT,
      level TEXT NOT NULL CHECK (level IN ('debug', 'info', 'log', 'warn', 'error')),
      text TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      CHECK ((source = 'client') = (user_id IS NOT NULL))
    ) STRICT`);
    sql.exec("CREATE INDEX console_logs_gadget ON console_logs (gadget_id, seq)");
    sql.exec("CREATE INDEX console_logs_gadget_source ON console_logs (gadget_id, source, seq)");
    sql.exec("CREATE INDEX console_logs_kept_at ON console_logs (kept_at)");
    sql.exec(`CREATE TABLE console_log_usage (
      gadget_id INTEGER NOT NULL,
      source TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      PRIMARY KEY (gadget_id, source)
    ) STRICT, WITHOUT ROWID`);
    sql.exec(`CREATE TRIGGER console_logs_counted AFTER INSERT ON console_logs BEGIN
      INSERT INTO console_log_usage (gadget_id, source, bytes)
        VALUES (NEW.gadget_id, NEW.source, NEW.bytes)
        ON CONFLICT (gadget_id, source) DO UPDATE SET bytes = bytes + excluded.bytes;
    END`);
    sql.exec(`CREATE TRIGGER console_logs_uncounted AFTER DELETE ON console_logs BEGIN
      UPDATE console_log_usage SET bytes = bytes - OLD.bytes
        WHERE gadget_id = OLD.gadget_id AND source = OLD.source;
      DELETE FROM console_log_usage
        WHERE gadget_id = OLD.gadget_id AND source = OLD.source AND bytes = 0;
    END`);
  }

  // Deletes up to EXPIRY_BATCH rows kept longer ago than the retention, oldest first, and says
  // whether there was one. The batch is chosen in `kept_at` order, which the index on it (holding
  // each row's seq) answers without reading the table.
  #expire(now: number): boolean {
    return this.ctx.storage.sql.exec(
      `DELETE FROM console_logs WHERE seq IN
         (SELECT seq FROM console_logs WHERE kept_at <= ? ORDER BY kept_at, seq
          LIMIT ${EXPIRY_BATCH})`,
      now - RETENTION_MS).rowsWritten > 0;
  }

  // When the alarm should next run: at once while expired rows remain, else when the oldest row
  // expires and no sooner than in an hour, or null when there is no row.
  #nextExpiry(now: number): number | null {
    let { oldest } = this.ctx.storage.sql.exec<{ oldest: number | null }>(
      "SELECT MIN(kept_at) AS oldest FROM console_logs").one();
    if (oldest === null) return null;
    if (oldest <= now - RETENTION_MS) return now;
    return Math.max(oldest + RETENTION_MS, now + HOUR_MS);
  }

  // Holds the byte bounds for the gadgets and sources that were just written to, which are the
  // only ones that can have passed one. A row within its retention is deleted only once no
  // expired row is left to delete in its place. For a gadget's bound that follows from the order:
  // its oldest rows go first, and those are its expired ones.
  #holdBounds(written: Map<WorkpieceId, Set<Source>>, now: number): void {
    let sql = this.ctx.storage.sql;
    let sources = new Set<Source>();
    for (let [gadgetId, gadgetSources] of written) {
      for (let source of gadgetSources) {
        sources.add(source);
        let [usage] = sql.exec<{ bytes: number }>(
          "SELECT bytes FROM console_log_usage WHERE gadget_id = ? AND source = ?",
          gadgetId, source).toArray();
        if (usage !== undefined) this.#free(gadgetId, source, usage.bytes - gadgetBound(source));
      }
    }

    // The workspace's bound takes from the gadget holding the most, not the oldest rows of the
    // workspace: that is what keeps a gadget that logs little from losing its entries to five
    // that log a lot.
    for (let source of sources) {
      for (;;) {
        let { total } = sql.exec<{ total: number | null }>(
          "SELECT SUM(bytes) AS total FROM console_log_usage WHERE source = ?", source).one();
        let excess = (total ?? 0) - workspaceBound(source);
        if (excess <= 0) break;
        // Expired rows count until they are deleted, and append() deleted one batch of them at
        // most. What is left goes first, a batch at a time and whichever gadget holds it, until
        // the bound holds or nothing expired remains.
        if (this.#expire(now)) continue;
        let largest = sql.exec<{ gadget_id: WorkpieceId }>(
          `SELECT gadget_id FROM console_log_usage WHERE source = ?
           ORDER BY bytes DESC, gadget_id LIMIT 1`, source).one();
        this.#free(largest.gadget_id, source, excess);
      }
    }
  }

  // Deletes the oldest rows of one gadget and source until `excess` bytes are freed or none is
  // left. Nothing for an `excess` that is not positive.
  #free(gadgetId: WorkpieceId, source: Source, excess: number): void {
    if (excess <= 0) return;
    let sql = this.ctx.storage.sql;
    let last: number | undefined;
    let freed = 0;
    for (let row of sql.exec<{ seq: number; bytes: number }>(
        "SELECT seq, bytes FROM console_logs WHERE gadget_id = ? AND source = ? ORDER BY seq",
        gadgetId, source)) {
      last = row.seq;
      freed += row.bytes;
      if (freed >= excess) break;
    }
    if (last !== undefined) {
      sql.exec("DELETE FROM console_logs WHERE gadget_id = ? AND source = ? AND seq <= ?",
        gadgetId, source, last);
    }
  }
}
