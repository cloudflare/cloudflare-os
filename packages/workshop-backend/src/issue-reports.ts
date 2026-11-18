import {
  ISSUE_REPORT_ERROR_CODES, ISSUE_REPORT_PAGE_SIZE, ISSUE_REPORT_PRIORITIES,
  ISSUE_REPORT_STATUSES, MAX_ISSUE_REPORTS_PER_DAY, MAX_ISSUE_REPORT_APP_VERSION_LENGTH,
  MAX_ISSUE_REPORT_LINKS, MAX_ISSUE_REPORT_LINK_LENGTH, MAX_ISSUE_REPORT_REPLIES_PER_DAY,
  MAX_ISSUE_REPORT_TEXT_LENGTH, MAX_ISSUE_REPORT_THREAD_ENTRIES, createIssueReportError,
  type AdminAccessGrant, type AdminIssueReport, type AdminIssueReportPage,
  type AdminIssueReportQuery, type AdminVia, type AiChatAuthorInfo, type IssueReport,
  type IssueReportAuthor, type IssueReportContext, type IssueReportEntry, type IssueReportGrant,
  type IssueReportInput, type IssueReportPriority, type IssueReportStatus, type NamedUser,
  type OwnIssueReport, type OwnIssueReportPage,
} from "@gadgets/workshop-shared/api";
import { DurableObject } from "cloudflare:workers";
import { adminAccessPolicy, adminListLimit, auditOwnerId, namedUser } from "./admin-access.js";
import { createWorkshopLogger } from "./observability";

const logger = createWorkshopLogger("workshop.issue-reports");

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
// Reports past the retention that one alarm deletes at most, so that a store left with many is
// trimmed over several short writes, a minute apart.
const PRUNE_BATCH = 100;
// The longest reporter or workspace filter list() takes, and the longest workspace id a report
// names; workspace ids are 64 characters.
const MAX_FILTER_LENGTH = 1000;

// A report with the copy of its grant, if it names one.
const REPORT_SELECT = `SELECT r.seq, r.id, r.filed_at, r.reporter_id, r.reporter_name, r.text,
    r.priority, r.workspace_id, r.context, r.status, r.links, r.updated_at, r.last_admin_public,
    r.seen, g.id AS grant_id, g.scope AS grant_scope, g.expires_at AS grant_expires_at,
    g.ended_at AS grant_ended_at
  FROM reports r LEFT JOIN grants g ON g.id = r.grant_id`;

// The three kinds of entry MAX_ISSUE_REPORT_THREAD_ENTRIES bounds, each apart. A bare change of
// status (an admin's public entry with no text) is in none of them.
const THREAD_KINDS = {
  replies: "visibility = 'public' AND via IS NULL",
  adminPublic: "visibility = 'public' AND via IS NOT NULL AND text <> ''",
  adminOnly: "visibility = 'admins'",
} as const;

type ReportRow = {
  seq: number;
  id: string;
  filed_at: number;
  reporter_id: string;
  reporter_name: string;
  text: string;
  priority: string;
  workspace_id: string | null;
  context: string;
  status: string;
  links: string;
  updated_at: number;
  last_admin_public: number;
  seen: number;
  grant_id: string | null;
  grant_scope: string | null;
  grant_expires_at: number | null;
  grant_ended_at: number | null;
};

type EntryRow = {
  n: number;
  id: string;
  at: number;
  author_id: string;
  author_name: string;
  visibility: string;
  via: string | null;
  text: string;
  status: string | null;
};

// What a grant is linked to a report by (see IssueReportsDurableObject.checkGrantLink()).
type GrantLink = { scope: AdminAccessGrant["scope"]; workspaceId?: string; grantId?: string };

function startOfUtcDay(): number {
  let now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

// `text` trimmed; throws unless it is non-blank and at most MAX_ISSUE_REPORT_TEXT_LENGTH UTF-16
// code units once trimmed.
function writtenText(text: string): string {
  let trimmed = typeof text === "string" ? text.trim() : "";
  if (trimmed === "" || trimmed.length > MAX_ISSUE_REPORT_TEXT_LENGTH) {
    throw new TypeError(
        `The text must be non-blank and at most ${MAX_ISSUE_REPORT_TEXT_LENGTH} characters.`);
  }
  return trimmed;
}

// Where a reporter was, rebuilt field by field so that nothing else a client sent is kept. Throws
// for an id that is not one, and for a chat or gadget without its workspace.
function reportContext(input: IssueReportContext | undefined): IssueReportContext {
  let context: IssueReportContext = {};
  let { workspaceId, chatId, gadgetId, appVersion } = input ?? {};
  if (workspaceId !== undefined) {
    if (typeof workspaceId !== "string" || workspaceId === "" ||
        workspaceId.length > MAX_FILTER_LENGTH) {
      throw new TypeError("Invalid workspace id.");
    }
    context.workspaceId = workspaceId;
  }
  for (let [key, id] of [["chatId", chatId], ["gadgetId", gadgetId]] as const) {
    if (id === undefined) continue;
    if (workspaceId === undefined) {
      throw new TypeError("A report that names a chat or a gadget must name its workspace.");
    }
    if (!Number.isSafeInteger(id) || id < 0) throw new TypeError(`Invalid ${key}.`);
    context[key] = id;
  }
  // A label, so an over-long one is cut rather than refused.
  let version = typeof appVersion === "string"
      ? appVersion.trim().slice(0, MAX_ISSUE_REPORT_APP_VERSION_LENGTH) : "";
  if (version !== "") context.appVersion = version;
  return context;
}

// `links` as a report keeps them: each the `href` of the URL it parses to, so that what a client
// later puts in a link is what was checked here. Throws for too many, for one that is too long
// (as sent or as parsed), and for anything that is not an http or https URL.
function reportLinks(links: string[]): string[] {
  if (!Array.isArray(links) || links.length > MAX_ISSUE_REPORT_LINKS) {
    throw new TypeError(`An issue report takes at most ${MAX_ISSUE_REPORT_LINKS} links.`);
  }
  return links.map(link => {
    let href: string | undefined;
    if (typeof link === "string" && link.length <= MAX_ISSUE_REPORT_LINK_LENGTH) {
      try {
        let url = new URL(link);
        if (url.protocol === "http:" || url.protocol === "https:") href = url.href;
      } catch {
        // Not a URL: refused below, as a URL of another scheme is.
      }
    }
    if (href === undefined || href.length > MAX_ISSUE_REPORT_LINK_LENGTH) {
      throw new TypeError("A link must be an http or https URL of at most " +
          `${MAX_ISSUE_REPORT_LINK_LENGTH} characters.`);
    }
    return href;
  });
}

// The fields a report shows to its reporter and to the admins alike.
function reportOf(row: ReportRow): IssueReport {
  let context = JSON.parse(row.context) as IssueReportContext;
  let report: IssueReport = {
    id: row.id,
    filedAt: new Date(row.filed_at),
    reporter: { id: row.reporter_id, name: row.reporter_name },
    text: row.text,
    priority: row.priority as IssueReportPriority,
    context: row.workspace_id === null ? context : { workspaceId: row.workspace_id, ...context },
    status: row.status as IssueReportStatus,
  };
  if (row.grant_id !== null) {
    report.grant = {
      id: row.grant_id,
      scope: row.grant_scope as AdminAccessGrant["scope"],
      expiresAt: new Date(row.grant_expires_at!),
    };
    if (row.grant_ended_at !== null) report.grant.endedAt = new Date(row.grant_ended_at);
  }
  return report;
}

// A report as its reporter reads it: built from reportOf() and nothing of the admins' form, so
// neither the links nor when its thread last grew (which an admins-only entry moves) is in it.
function ownReportOf(row: ReportRow): OwnIssueReport {
  return { ...reportOf(row), unseen: row.last_admin_public > row.seen };
}

function adminReportOf(row: ReportRow): AdminIssueReport {
  return {
    ...reportOf(row),
    links: JSON.parse(row.links) as string[],
    updatedAt: new Date(row.updated_at),
  };
}

// An entry as `reader` reads it. The reporter reads an entry the admins wrote (its row has a
// `via`) without its author's id: an admin's id is their account name. The rule is the row's
// `via`, never a comparison of ids, so it holds for an admin who filed the report too.
function entryOf(row: EntryRow, reader: "reporter" | "admins"): IssueReportEntry {
  let author: IssueReportAuthor = reader === "reporter" && row.via !== null
      ? { name: row.author_name } : { id: row.author_id, name: row.author_name };
  let entry: IssueReportEntry = {
    id: row.id,
    at: new Date(row.at),
    author,
    visibility: row.visibility as IssueReportEntry["visibility"],
    text: row.text,
  };
  if (row.via !== null) entry.via = row.via as AdminVia;
  if (row.status !== null) entry.status = row.status as IssueReportStatus;
  return entry;
}

function notFound(): Error {
  return createIssueReportError(ISSUE_REPORT_ERROR_CODES.notFound);
}

/**
 * The deployment-wide store of issue reports: each report with its thread, the links admins
 * attached and a copy of the grant given with it. Always addressed as getByName(""). Its callers
 * decide who may call what: nothing here checks that a caller is the reporter or an admin beyond
 * the ids it is handed.
 *
 * Every user it is handed (a profile, or a bare profile id) goes through namedUser() or
 * auditOwnerId() before it is compared or stored, so that one user is one id here however long
 * their id is, and nothing of a profile but the id and the name is kept.
 *
 * How long a report is kept is not stored here: alarm() asks AdminSettings for the retention in
 * force each time it runs, and deletes the reports filed before it, with their threads. No read
 * filters by age.
 *
 * Schema. A report's workspace is a column, for the filter, and the rest of where its reporter
 * was is JSON in `context`. `last_admin_public` is the `n` of the newest public entry an admin
 * wrote (0 for none) and `seen` the value it had when the reporter last marked the report seen,
 * so a report is unseen while the first is greater. `grant_id` names a row of `grants`, which
 * holds a row only while a report names it.
 *   reports(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
 *     filed_at INTEGER NOT NULL, reporter_id TEXT NOT NULL, reporter_name TEXT NOT NULL,
 *     text TEXT NOT NULL, priority TEXT NOT NULL, workspace_id TEXT,
 *     owns_workspace INTEGER NOT NULL, context TEXT NOT NULL CHECK (json_valid(context)),
 *     status TEXT NOT NULL, links TEXT NOT NULL CHECK (json_valid(links)), grant_id TEXT,
 *     updated_at INTEGER NOT NULL, last_admin_public INTEGER NOT NULL, seen INTEGER NOT NULL)
 *     STRICT;
 *   indexes (reporter_id, seq), (status, seq), (priority, seq), (workspace_id, seq), (filed_at),
 *     (grant_id) WHERE grant_id IS NOT NULL
 *   entries(report_seq INTEGER NOT NULL, n INTEGER NOT NULL, id TEXT NOT NULL,
 *     at INTEGER NOT NULL, author_id TEXT NOT NULL, author_name TEXT NOT NULL,
 *     visibility TEXT NOT NULL CHECK (visibility IN ('public', 'admins')), via TEXT,
 *     text TEXT NOT NULL, status TEXT, PRIMARY KEY (report_seq, n)) STRICT;
 *   index (author_id, at)
 *   grants(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, scope TEXT NOT NULL, workspace_id TEXT,
 *     expires_at INTEGER NOT NULL, ended_at INTEGER) STRICT;
 * An entry's `via` is set for an entry the admins wrote and NULL for the reporter's own; a bare
 * change of status is an admins' public entry whose text is ''.
 */
export class IssueReportsDurableObject extends DurableObject<Cloudflare.Env> {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    let sql = ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS reports (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      filed_at INTEGER NOT NULL,
      reporter_id TEXT NOT NULL,
      reporter_name TEXT NOT NULL,
      text TEXT NOT NULL,
      priority TEXT NOT NULL,
      workspace_id TEXT,
      owns_workspace INTEGER NOT NULL,
      context TEXT NOT NULL CHECK (json_valid(context)),
      status TEXT NOT NULL,
      links TEXT NOT NULL CHECK (json_valid(links)),
      grant_id TEXT,
      updated_at INTEGER NOT NULL,
      last_admin_public INTEGER NOT NULL,
      seen INTEGER NOT NULL
    ) STRICT`);
    sql.exec("CREATE INDEX IF NOT EXISTS reports_reporter ON reports (reporter_id, seq)");
    sql.exec("CREATE INDEX IF NOT EXISTS reports_status ON reports (status, seq)");
    sql.exec("CREATE INDEX IF NOT EXISTS reports_priority ON reports (priority, seq)");
    sql.exec("CREATE INDEX IF NOT EXISTS reports_workspace ON reports (workspace_id, seq)");
    sql.exec("CREATE INDEX IF NOT EXISTS reports_filed_at ON reports (filed_at)");
    // Whether any report still names a grant is asked whenever a link is replaced or a report
    // deleted; few reports name one, so the index holds only those.
    sql.exec(`CREATE INDEX IF NOT EXISTS reports_grant ON reports (grant_id)
        WHERE grant_id IS NOT NULL`);
    sql.exec(`CREATE TABLE IF NOT EXISTS entries (
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
    ) STRICT`);
    // The reporter's replies of a day are counted across all their reports.
    sql.exec("CREATE INDEX IF NOT EXISTS entries_author ON entries (author_id, at)");
    sql.exec(`CREATE TABLE IF NOT EXISTS grants (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      workspace_id TEXT,
      expires_at INTEGER NOT NULL,
      ended_at INTEGER
    ) STRICT`);
  }

  // --- The reporter ---

  /**
   * Files a report for `reporter`, with status "new", and returns it. `ownsWorkspace`: whether
   * the reporter owns the workspace the report names, as the caller found; false when it names
   * none. The caller has checked that the reporter can open what the context names. Throws
   * (TypeError) for a text that is blank or over MAX_ISSUE_REPORT_TEXT_LENGTH once trimmed, a
   * priority that is not one, and a context that is malformed; refused `tooManyReports` once the
   * reporter has filed MAX_ISSUE_REPORTS_PER_DAY since UTC midnight. Sets the alarm that prunes
   * the store when none is set.
   */
  async submit(reporter: Pick<AiChatAuthorInfo, "id" | "name">, input: IssueReportInput,
      ownsWorkspace: boolean): Promise<OwnIssueReport> {
    let user = namedUser(reporter);
    let text = writtenText(input.text);
    if (!ISSUE_REPORT_PRIORITIES.includes(input.priority)) {
      throw new TypeError("Invalid priority.");
    }
    let { workspaceId, ...context } = reportContext(input.context);
    let sql = this.ctx.storage.sql;
    // Reports are numbered in the order they are filed, so the newest ones are today's.
    let { today } = sql.exec<{ today: number }>(
      `SELECT COUNT(*) AS today FROM
         (SELECT filed_at FROM reports WHERE reporter_id = ? ORDER BY seq DESC LIMIT ?)
       WHERE filed_at >= ?`,
      user.id, MAX_ISSUE_REPORTS_PER_DAY, startOfUtcDay()).one();
    if (today >= MAX_ISSUE_REPORTS_PER_DAY) {
      throw createIssueReportError(ISSUE_REPORT_ERROR_CODES.tooManyReports);
    }

    let id = crypto.randomUUID();
    let now = Date.now();
    sql.exec(
      `INSERT INTO reports (id, filed_at, reporter_id, reporter_name, text, priority,
         workspace_id, owns_workspace, context, status, links, updated_at, last_admin_public,
         seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', '[]', ?, 0, 0)`,
      id, now, user.id, user.name, text, input.priority, workspaceId ?? null,
      ownsWorkspace && workspaceId !== undefined ? 1 : 0, JSON.stringify(context), now);
    if (await this.ctx.storage.getAlarm() === null) {
      await this.ctx.storage.setAlarm(now + DAY_MS);
    }
    return ownReportOf(this.#report("r.id = ?", id)!);
  }

  /** One page of the reporter's reports, newest first, ISSUE_REPORT_PAGE_SIZE at most. Throws for
   * a cursor that is not one. The page is filtered by the reporter whatever the cursor. */
  listOwn(reporterId: string, cursor?: string): OwnIssueReportPage {
    let { rows, nextCursor } = this.#page(
        ["r.reporter_id = ?"], [auditOwnerId(reporterId)], cursor, ISSUE_REPORT_PAGE_SIZE);
    let page: OwnIssueReportPage = { reports: rows.map(ownReportOf) };
    if (nextCursor !== undefined) page.nextCursor = nextCursor;
    return page;
  }

  /** A report `reporterId` filed, with its public thread, oldest entry first, each entry as the
   * reporter reads it: an admin's without the admin's id. `notFound` for any other report. */
  getOwn(reporterId: string, reportId: string): OwnIssueReport & { entries: IssueReportEntry[] } {
    let row = this.#ownReport(reporterId, reportId);
    return { ...ownReportOf(row), entries: this.#entries(row.seq, "reporter") };
  }

  /**
   * Adds the reporter's reply to the public thread of a report they filed, and returns it. A
   * reply to a report that is "answered" or "waitingOnReporter" sets it "withAdmin", which the
   * entry then carries. Throws (TypeError) for a text that is not one; refused `notFound`,
   * `closed`, `threadFull` at MAX_ISSUE_REPORT_THREAD_ENTRIES replies in the report, and
   * `tooManyReplies` at MAX_ISSUE_REPORT_REPLIES_PER_DAY replies since UTC midnight over all the
   * reporter's reports. The admins' entries count in neither.
   */
  reply(reporter: Pick<AiChatAuthorInfo, "id" | "name">, reportId: string, text: string)
      : IssueReportEntry {
    let user = namedUser(reporter);
    let body = writtenText(text);
    let report = this.#ownReport(user.id, reportId);
    if (report.status === "closed") {
      throw createIssueReportError(ISSUE_REPORT_ERROR_CODES.closed);
    }
    if (this.#threadCount(report.seq, "replies") >= MAX_ISSUE_REPORT_THREAD_ENTRIES) {
      throw createIssueReportError(ISSUE_REPORT_ERROR_CODES.threadFull);
    }
    let { today } = this.ctx.storage.sql.exec<{ today: number }>(
      `SELECT COUNT(*) AS today FROM entries
       WHERE author_id = ? AND at >= ? AND ${THREAD_KINDS.replies}`,
      user.id, startOfUtcDay()).one();
    if (today >= MAX_ISSUE_REPORT_REPLIES_PER_DAY) {
      throw createIssueReportError(ISSUE_REPORT_ERROR_CODES.tooManyReplies);
    }
    let reopens = report.status === "answered" || report.status === "waitingOnReporter";
    let entry = this.#addEntry(report.seq, user, "public", null, body,
        reopens ? "withAdmin" : undefined);
    return entryOf(entry, "reporter");
  }

  /** How many of the reporter's reports hold a public entry an admin wrote that they have not
   * marked seen. An admins-only entry and a bare change of status change nothing here. */
  unseenCount(reporterId: string): number {
    return this.ctx.storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM reports WHERE reporter_id = ? AND last_admin_public > seen",
      auditOwnerId(reporterId)).one().count;
  }

  /** Marks what a report `reporterId` filed holds now as seen. `notFound` for any other report,
   * of which nothing is written: the one statement names the report and its reporter. */
  markSeen(reporterId: string, reportId: string): void {
    let marked = this.ctx.storage.sql.exec(
      "UPDATE reports SET seen = last_admin_public WHERE id = ? AND reporter_id = ? RETURNING seq",
      reportId, auditOwnerId(reporterId)).toArray();
    if (marked.length === 0) throw notFound();
  }

  // --- The grant given with a report ---

  /**
   * Throws `notFound` unless report `reportId` can be linked to a grant `ownerId` is about to
   * give: the report is theirs; for scope "workspace" it names `link.workspaceId`; for scope
   * "account" it names no workspace or one its reporter owns, so that a report never shows a
   * grant that does not cover its workspace; and the grant it holds, if any, is `link.grantId`
   * or has ended. Reads only: called before the grant is stored, so that a grant is never given
   * for a report that cannot show it.
   */
  checkGrantLink(ownerId: string, reportId: string, link: GrantLink): void {
    this.#linkableReport(auditOwnerId(ownerId), reportId, link);
  }

  /**
   * Stores what the workspace or account that holds a grant says of it, after it stored the grant
   * or its change. Called by the workspace or the account, never on a client's word.
   *
   * With `reportId` it links that report to the grant under the rule of checkGrantLink(), checked
   * again here in the same synchronous step as the link, inserting the grant's row when there is
   * none. A report's ended grant is replaced, a live one is not; in the same step the replaced
   * grant's row is deleted unless another report still names it.
   *
   * Without `reportId` it only updates: the row of a grant some report names takes the new end,
   * and a grant no report names is not stored at all. It never inserts.
   *
   * So `grants` holds only rows a report names, whatever an owner's calls: an owner gives and
   * ends grants without limit, and this table must not grow with them. The same end noted twice
   * changes nothing the second time.
   */
  noteGrant(ownerId: string, grant: IssueReportGrant & { workspaceId?: string },
      reportId?: string): void {
    let owner = auditOwnerId(ownerId);
    let sql = this.ctx.storage.sql;
    let expiresAt = grant.expiresAt.getTime();
    let endedAt = grant.endedAt?.getTime() ?? null;
    if (reportId === undefined) {
      sql.exec("UPDATE grants SET expires_at = ?, ended_at = ? WHERE id = ? AND owner_id = ?",
          expiresAt, endedAt, grant.id, owner);
      return;
    }
    this.ctx.storage.transactionSync(() => {
      let report = this.#linkableReport(owner, reportId,
          { scope: grant.scope, workspaceId: grant.workspaceId, grantId: grant.id });
      // A row under this id that another owner's grant made is not this grant's.
      let stored = sql.exec<{ owner_id: string }>(
          "SELECT owner_id FROM grants WHERE id = ?", grant.id).toArray();
      if (stored.length > 0 && stored[0].owner_id !== owner) throw notFound();
      sql.exec(
        `INSERT INTO grants (id, owner_id, scope, workspace_id, expires_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           expires_at = excluded.expires_at, ended_at = excluded.ended_at`,
        grant.id, owner, grant.scope, grant.workspaceId ?? null, expiresAt, endedAt);
      sql.exec("UPDATE reports SET grant_id = ? WHERE seq = ?", grant.id, report.seq);
      if (report.grant_id !== null) this.#deleteUnnamedGrants([report.grant_id]);
    });
  }

  // The report `reportId` when the rule of checkGrantLink() lets `owner` (as auditOwnerId() gives
  // it) link it; throws `notFound` otherwise.
  #linkableReport(owner: string, reportId: string, link: GrantLink)
      : { seq: number; grant_id: string | null } {
    type Row = {
      seq: number; workspace_id: string | null; owns_workspace: number; grant_id: string | null;
      expires_at: number | null; ended_at: number | null;
    };
    let [report] = this.ctx.storage.sql.exec<Row>(
      `SELECT r.seq, r.workspace_id, r.owns_workspace, r.grant_id, g.expires_at, g.ended_at
       FROM reports r LEFT JOIN grants g ON g.id = r.grant_id
       WHERE r.id = ? AND r.reporter_id = ?`, reportId, owner).toArray();
    if (report === undefined) throw notFound();
    let covered = link.scope === "workspace"
        ? link.workspaceId !== undefined && report.workspace_id === link.workspaceId
        : link.scope === "account" &&
            (report.workspace_id === null || report.owns_workspace === 1);
    if (!covered) throw notFound();
    let held = report.grant_id !== null && report.grant_id !== link.grantId;
    if (held && report.ended_at === null && report.expires_at! > Date.now()) throw notFound();
    return report;
  }

  // Deletes each of `ids` from `grants` unless a report names it.
  #deleteUnnamedGrants(ids: string[]): void {
    this.ctx.storage.sql.exec(
      `DELETE FROM grants WHERE id IN (SELECT value FROM json_each(?))
         AND NOT EXISTS (SELECT 1 FROM reports WHERE grant_id = grants.id)`,
      JSON.stringify(ids));
  }

  // --- The admins ---

  /** One page of reports, newest first, filtered as `query` says; `limit` is validated by the
   * caller. Throws for a malformed cursor or a filter over 1000 characters. The reporter filter
   * takes an id as a report shows it or whole. */
  list(query: Omit<AdminIssueReportQuery, "limit"> & { limit: number }): AdminIssueReportPage {
    let limit = adminListLimit(query.limit);
    for (let filter of [query.reporter, query.workspace]) {
      if (filter !== undefined && filter.length > MAX_FILTER_LENGTH) {
        throw new TypeError(`Report filters must be at most ${MAX_FILTER_LENGTH} characters.`);
      }
    }
    let where: string[] = [];
    let params: string[] = [];
    if (query.status !== undefined) {
      where.push("r.status = ?");
      params.push(query.status);
    }
    if (query.priority !== undefined) {
      where.push("r.priority = ?");
      params.push(query.priority);
    }
    if (query.reporter !== undefined) {
      where.push("r.reporter_id = ?");
      params.push(auditOwnerId(query.reporter));
    }
    if (query.workspace !== undefined) {
      where.push("r.workspace_id = ?");
      params.push(query.workspace);
    }
    let { rows, nextCursor } = this.#page(where, params, query.cursor, limit);
    let page: AdminIssueReportPage = { reports: rows.map(adminReportOf) };
    if (nextCursor !== undefined) page.nextCursor = nextCursor;
    return page;
  }

  /** One report with its whole thread, admins-only entries included, oldest entry first.
   * `notFound` for an id that names none. */
  get(reportId: string): AdminIssueReport & { entries: IssueReportEntry[] } {
    let row = this.#report("r.id = ?", reportId);
    if (row === undefined) throw notFound();
    return { ...adminReportOf(row), entries: this.#entries(row.seq, "admins") };
  }

  /**
   * Adds an entry `admin` wrote to a report's thread, for the reporter ("public") or for admins
   * alone ("admins"), and returns it. It changes no status, and works on a closed report. A
   * public one makes the report unseen by its reporter. Throws (TypeError) for a text or a
   * visibility that is not one; refused `notFound`, and `threadFull` once the admins have written
   * MAX_ISSUE_REPORT_THREAD_ENTRIES entries of that visibility.
   */
  addEntry(admin: Pick<AiChatAuthorInfo, "id" | "name">, via: AdminVia, reportId: string,
      text: string, visibility: IssueReportEntry["visibility"]): IssueReportEntry {
    let author = namedUser(admin);
    let body = writtenText(text);
    if (visibility !== "public" && visibility !== "admins") {
      throw new TypeError("Invalid visibility.");
    }
    let { seq } = this.#reportSeq(reportId);
    let written = this.#threadCount(seq, visibility === "public" ? "adminPublic" : "adminOnly");
    if (written >= MAX_ISSUE_REPORT_THREAD_ENTRIES) {
      throw createIssueReportError(ISSUE_REPORT_ERROR_CODES.threadFull);
    }
    return entryOf(this.#addEntry(seq, author, visibility, via, body), "admins");
  }

  /**
   * Sets a report's status, entered in its thread as a public line with no text that names
   * `admin`. A status the report already has changes nothing. Never refused `threadFull`, so a
   * full thread can still be closed, and it leaves the report as seen as it was. Throws
   * (TypeError) for a status that is not one; refused `notFound`.
   */
  setStatus(admin: Pick<AiChatAuthorInfo, "id" | "name">, via: AdminVia, reportId: string,
      status: IssueReportStatus): void {
    let author = namedUser(admin);
    if (!ISSUE_REPORT_STATUSES.includes(status)) throw new TypeError("Invalid status.");
    let report = this.#reportSeq(reportId);
    if (report.status !== status) this.#addEntry(report.seq, author, "public", via, "", status);
  }

  /** Replaces a report's links with `links` as reportLinks() keeps them. Throws (TypeError) for
   * links that are not ones; refused `notFound`. */
  setLinks(reportId: string, links: string[]): void {
    let kept = JSON.stringify(reportLinks(links));
    let changed = this.ctx.storage.sql.exec(
        "UPDATE reports SET links = ? WHERE id = ? RETURNING seq", kept, reportId).toArray();
    if (changed.length === 0) throw notFound();
  }

  // --- Retention ---

  /**
   * Deletes the reports filed before the retention in force, with their threads, PRUNE_BATCH a
   * run. The retention is asked of AdminSettings (the committed config) each time, never kept: if
   * that question fails nothing is deleted, since a report must not go by a value that may be
   * stale. Sets the next alarm itself: a minute ahead while more reports are due, a day ahead
   * while any report remains, an hour ahead after a failure. Never throws: the platform gives up
   * on an alarm that keeps throwing.
   */
  async alarm(): Promise<void> {
    let sql = this.ctx.storage.sql;
    let next = HOUR_MS;
    try {
      let config = await this.ctx.exports.AdminSettings.getByName("").committedAdminConfig();
      let { issueReportRetentionDays } = adminAccessPolicy(config, this.env);
      // Chosen in `filed_at` order, which its index answers without reading the table.
      let due = sql.exec<{ seq: number }>(
        "SELECT seq FROM reports WHERE filed_at < ? ORDER BY filed_at, seq LIMIT ?",
        Date.now() - issueReportRetentionDays * DAY_MS, PRUNE_BATCH + 1).toArray();
      this.#deleteReports(due.slice(0, PRUNE_BATCH).map(({ seq }) => seq));
      next = due.length > PRUNE_BATCH ? MINUTE_MS : DAY_MS;
    } catch (error) {
      logger.error("failed to delete the issue reports past their retention", {
        event: "issue-reports.prune.failed", error,
      });
    }
    try {
      // An empty store needs no alarm: submit() sets one with the next report.
      let kept = sql.exec("SELECT 1 FROM reports LIMIT 1").toArray();
      if (kept.length > 0) await this.ctx.storage.setAlarm(Date.now() + next);
    } catch (error) {
      logger.error("failed to set the issue reports' next alarm", {
        event: "issue-reports.alarm.failed", error,
      });
    }
  }

  // Deletes the reports `seqs` number, with their entries and each grant row no report names
  // any more: the one place a report is deleted.
  #deleteReports(seqs: number[]): void {
    if (seqs.length === 0) return;
    let sql = this.ctx.storage.sql;
    let list = JSON.stringify(seqs);
    let within = "IN (SELECT value FROM json_each(?))";
    this.ctx.storage.transactionSync(() => {
      let grants = sql.exec<{ grant_id: string }>(
        `SELECT DISTINCT grant_id FROM reports WHERE seq ${within} AND grant_id IS NOT NULL`,
        list).toArray();
      sql.exec(`DELETE FROM entries WHERE report_seq ${within}`, list);
      sql.exec(`DELETE FROM reports WHERE seq ${within}`, list);
      this.#deleteUnnamedGrants(grants.map(({ grant_id }) => grant_id));
    });
  }

  // --- Rows ---

  #report(where: string, ...params: string[]): ReportRow | undefined {
    return this.ctx.storage.sql.exec<ReportRow>(
        `${REPORT_SELECT} WHERE ${where}`, ...params).toArray()[0];
  }

  // The report `reportId` when `reporterId` filed it; `notFound` otherwise, for a report of
  // another reporter exactly as for an id that names none.
  #ownReport(reporterId: string, reportId: string): ReportRow {
    let row = this.#report("r.id = ? AND r.reporter_id = ?", reportId, auditOwnerId(reporterId));
    if (row === undefined) throw notFound();
    return row;
  }

  // What the admins' writes need of a report; `notFound` for an id that names none.
  #reportSeq(reportId: string): { seq: number; status: string } {
    let [row] = this.ctx.storage.sql.exec<{ seq: number; status: string }>(
        "SELECT seq, status FROM reports WHERE id = ?", reportId).toArray();
    if (row === undefined) throw notFound();
    return row;
  }

  // One page of the reports matching `where`, newest first, and the cursor of the next when
  // there is one. Throws for a cursor that is not a report's number.
  #page(where: string[], params: string[], cursor: string | undefined, limit: number)
      : { rows: ReportRow[]; nextCursor?: string } {
    let values: (string | number)[] = [...params];
    if (cursor !== undefined) {
      let before = /^[0-9]+$/.test(cursor) ? Number(cursor) : NaN;
      if (!Number.isSafeInteger(before)) throw new TypeError("Invalid cursor.");
      where = [...where, "r.seq < ?"];
      values.push(before);
    }
    let filter = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    let rows = this.ctx.storage.sql.exec<ReportRow>(
        `${REPORT_SELECT} ${filter} ORDER BY r.seq DESC LIMIT ?`, ...values, limit + 1).toArray();
    return rows.length > limit
        ? { rows: rows.slice(0, limit), nextCursor: String(rows[limit - 1].seq) } : { rows };
  }

  // A report's thread as `reader` reads it, oldest entry first: for the reporter the public
  // entries alone, so that no admins-only row is read for them.
  #entries(reportSeq: number, reader: "reporter" | "admins"): IssueReportEntry[] {
    let visible = reader === "reporter" ? "AND visibility = 'public'" : "";
    return this.ctx.storage.sql.exec<EntryRow>(
      `SELECT n, id, at, author_id, author_name, visibility, via, text, status FROM entries
       WHERE report_seq = ? ${visible} ORDER BY n`, reportSeq).toArray()
        .map(row => entryOf(row, reader));
  }

  // How many entries of one of the three bounded kinds a report's thread holds.
  #threadCount(reportSeq: number, kind: keyof typeof THREAD_KINDS): number {
    return this.ctx.storage.sql.exec<{ count: number }>(
      `SELECT COUNT(*) AS count FROM entries WHERE report_seq = ? AND ${THREAD_KINDS[kind]}`,
      reportSeq).one().count;
  }

  // Adds an entry to a report's thread, in one step with what it changes of the report: when its
  // thread last grew; its status, when the entry sets one; and, for a public entry an admin wrote
  // (a `via` and a text), `last_admin_public`, which makes the report unseen. A bare change of
  // status has no text, so it does not. Returns the entry's row.
  #addEntry(reportSeq: number, author: NamedUser, visibility: IssueReportEntry["visibility"],
      via: AdminVia | null, text: string, status?: IssueReportStatus): EntryRow {
    let sql = this.ctx.storage.sql;
    let row: EntryRow = {
      n: 0, id: crypto.randomUUID(), at: Date.now(), author_id: author.id,
      author_name: author.name, visibility, via, text, status: status ?? null,
    };
    this.ctx.storage.transactionSync(() => {
      row.n = sql.exec<{ n: number }>(
        "SELECT COALESCE(MAX(n), 0) + 1 AS n FROM entries WHERE report_seq = ?",
        reportSeq).one().n;
      sql.exec(
        `INSERT INTO entries (report_seq, n, id, at, author_id, author_name, visibility, via,
           text, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        reportSeq, row.n, row.id, row.at, row.author_id, row.author_name, row.visibility,
        row.via, row.text, row.status);
      let answers = via !== null && visibility === "public" && text !== "";
      sql.exec(
        `UPDATE reports SET updated_at = ?, status = COALESCE(?, status),
           last_admin_public = CASE WHEN ? THEN ? ELSE last_admin_public END
         WHERE seq = ?`,
        row.at, row.status, answers ? 1 : 0, row.n, reportSeq);
    });
    return row;
  }
}
