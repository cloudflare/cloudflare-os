import {
  ISSUE_REPORT_ERROR_CODES, ISSUE_REPORT_PAGE_SIZE, ISSUE_REPORT_PRIORITIES,
  ISSUE_REPORT_STATUSES, MAX_ISSUE_REPORTS_PER_DAY, MAX_ISSUE_REPORT_APP_VERSION_LENGTH,
  MAX_ISSUE_REPORT_IMAGES, MAX_ISSUE_REPORT_IMAGE_BYTES, MAX_ISSUE_REPORT_IMAGE_BYTES_PER_USER,
  MAX_ISSUE_REPORT_IMAGE_UPLOADS_PER_USER, MAX_ISSUE_REPORT_LINKS, MAX_ISSUE_REPORT_LINK_LENGTH,
  MAX_ISSUE_REPORT_REPLIES_PER_DAY, MAX_ISSUE_REPORT_TEXT_LENGTH,
  MAX_ISSUE_REPORT_THREAD_ENTRIES, createIssueReportError,
  type AdminAccessGrant, type AdminAccessRecord, type AdminAgentOrigin, type AdminIssueReport,
  type AdminIssueReportPage,
  type AdminIssueReportQuery, type AdminVia, type AiChatAuthorInfo, type IssueReport,
  type IssueReportAuthor, type IssueReportContext, type IssueReportEntry, type IssueReportGrant,
  type IssueReportImage, type IssueReportInput, type IssueReportPriority, type IssueReportStatus,
  type NamedUser, type OwnIssueReport, type OwnIssueReportPage,
} from "@gadgets/workshop-shared/api";
import { ADMIN_GATEKEEPER_VENDOR_ID } from "@gadgets/workshop-shared/admin-agent";
import type {
  AdminGatekeeperVendor, IssueReportEvent,
} from "@gadgets/workshop-shared/admin-gatekeeper";
import { DurableObject } from "cloudflare:workers";
import {
  adminAccessPolicy, adminCallerTerms, adminListLimit, auditOwnerId, namedUser,
} from "./admin-access.js";
import { readAdminConfig } from "./admin-config.js";
import { getAuthVendorBinding } from "./auth/auth-vendors.js";
import { sniffImageMimeType } from "./chat-attachment-validation.js";
import { createWorkshopLogger } from "./observability";
import { ambientGatekeeperMode } from "./provisioning-policy.js";

const logger = createWorkshopLogger("workshop.issue-reports");

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
// Reports past the retention that one alarm deletes at most, so that a store left with many is
// trimmed over several short writes, a minute apart; and as many stale uploads a sweep. A report
// holds five images at most, so a batch's images are 500 keys, under the 1000 one delete call
// of the bucket takes.
const PRUNE_BATCH = 100;
// How old a 'pending' image row is before the sweep deletes it with its object: ten minutes,
// twice what an upload is given, so a row that old belongs to no upload that can still finish.
const PENDING_IMAGE_SECONDS = 10 * 60;
// How long an upload may run before it is cut off: five minutes, which the largest image takes
// on a connection of 140 kbit/s. Half of PENDING_IMAGE_SECONDS, so that an upload that is still
// being received is never old enough to be swept.
const IMAGE_UPLOAD_SECONDS = 5 * 60;
// The bytes the longest image signature takes: no image an issue report takes is shorter.
const IMAGE_SIGNATURE_BYTES = 12;
// What makes a report due for deletion, given the time its retention began (see #dueBefore()).
const REPORT_DUE = "filed_at < ?";
// The longest reporter or workspace filter list() takes, and the longest workspace id a report
// names; workspace ids are 64 characters.
const MAX_FILTER_LENGTH = 1000;
// The events one call to the admin gatekeeper carries.
const EVENT_BATCH = 100;
// How soon an event the admin gatekeeper has not taken is offered again, and how long one call
// to it is waited for.
const EVENT_RETRY_MS = MINUTE_MS;
// An event the admin gatekeeper has not taken for this long is dropped, and the drop logged.
const EVENT_MAX_AGE_MS = DAY_MS;

// A report with the copy of its grant, if it names one.
const REPORT_SELECT = `SELECT r.seq, r.id, r.filed_at, r.reporter_id, r.reporter_name, r.text,
    r.priority, r.workspace_id, r.context, r.status, r.links, r.updated_at, r.last_admin_public,
    r.seen, g.id AS grant_id, g.scope AS grant_scope, g.expires_at AS grant_expires_at,
    g.ended_at AS grant_ended_at,
    (SELECT json_group_array(
         json_object('id', i.id, 'type', i.type, 'byteLength', i.byte_length) ORDER BY i.n)
       FROM images i WHERE i.report_seq = r.seq AND i.state = 'stored') AS images
  FROM reports r LEFT JOIN grants g ON g.id = r.grant_id`;

// The kinds of entry MAX_ISSUE_REPORT_THREAD_ENTRIES bounds, each apart, and within a kind the
// entries made through the admin gatekeeper apart from people's (see #threadCount()). A bare
// change of status (an admin's public entry with no text) is bounded only when it was made
// through the gatekeeper (see setStatus()).
const THREAD_KINDS = {
  replies: "visibility = 'public' AND via IS NULL",
  adminPublic: "visibility = 'public' AND via IS NOT NULL AND text <> ''",
  adminOnly: "visibility = 'admins'",
  status: "visibility = 'public' AND via IS NOT NULL AND text = ''",
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
  images: string;
};

// What an image's object is named by: its report's id and its own, as their rows hold them.
type ImageKey = { report_id: string; id: string };

// An upload's reservation: the 'pending' row of `images` it inserted.
type PendingImage = ImageKey & {
  report_seq: number;
  reporter_id: string;
  byte_length: number;
  started_at: number;
};

type EventRow = {
  seq: number;
  id: string;
  kind: IssueReportEvent["kind"];
  report_id: string;
  label: string;
  at: number;
};

type EntryRow = {
  n: number;
  id: string;
  at: number;
  author_id: string;
  author_name: string;
  visibility: string;
  via: string | null;
  agent: string | null;
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
    images: JSON.parse(row.images) as IssueReportImage[],
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
// `via`, never a comparison of ids, so it holds for an admin who filed the report too. Where an
// agent's entry came from (`agent`) is for admins alone: the reporter reads its `via`.
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
  if (row.agent !== null && reader === "admins") {
    entry.agent = JSON.parse(row.agent) as AdminAgentOrigin;
  }
  if (row.status !== null) entry.status = row.status as IssueReportStatus;
  return entry;
}

// An event as the admin gatekeeper is sent it: a row's `label` is the priority of a report that
// was filed, or the status an investigation ended with.
function eventOf({ id, kind, report_id: reportId, label, at }: EventRow): IssueReportEvent {
  let event = { id, reportId, at: new Date(at) };
  return kind === "reported"
      ? { kind, ...event, priority: label as IssueReportPriority }
      : { kind, ...event, status: label as Exclude<IssueReportStatus, "new" | "investigating"> };
}

// Whether the deployment has turned the admin gatekeeper off: an admin disabled the connector,
// or its provisioning mode is "disabled", as it is until an admin sets one.
async function adminGatekeeperOff(env: Cloudflare.Env): Promise<boolean> {
  let config = await readAdminConfig(env);
  return config.disabledGatekeepers.includes(ADMIN_GATEKEEPER_VENDOR_ID) ||
      ambientGatekeeperMode(config, ADMIN_GATEKEEPER_VENDOR_ID) === "disabled";
}

function notFound(): Error {
  return createIssueReportError(ISSUE_REPORT_ERROR_CODES.notFound);
}

// The key of an image's object in the bucket. Built from rows alone, never from what a caller
// sent, and neither stored nor returned: whoever holds a key was let through by a row.
function imageKey(image: ImageKey): string {
  return `${image.report_id}/${image.id}`;
}

function uploadTookTooLong(): Error {
  return new Error("The image upload took too long. Try again.");
}

function fewerBytesThanDeclared(): TypeError {
  return new TypeError("The image holds fewer bytes than its byteLength.");
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
 * force each time it runs, and deletes the reports filed before it, with their threads and
 * images. No read filters by age.
 *
 * An image's bytes are one object in the R2 bucket bound as ISSUE_IMAGES, named by imageKey(),
 * and its row in `images` is everything else, which is what every decision reads: who may read
 * it, how many a report has, how many bytes a reporter holds. An object never exists without its
 * row: a row is inserted, 'pending', before its object is put; an upload deletes its object only
 * after its put has settled, since a delete sent while the put is in flight can be answered
 * before the put lands; and a row is deleted only after the delete of its object has resolved.
 * So what a failure leaves is a row, which the sweep or the alarm retries, never an object
 * nothing names, and a report with images outlives its retention for as long as the bucket
 * cannot be reached. The put happens here rather than in the session that received the stream,
 * so that one class writes the row before its object and deletes it after, and an upload whose
 * session dropped is cleared away by the code that began it.
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
 *     agent TEXT CHECK (agent IS NULL OR json_valid(agent)),
 *     text TEXT NOT NULL, status TEXT, PRIMARY KEY (report_seq, n)) STRICT;
 *   index (author_id, at)
 *   grants(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, scope TEXT NOT NULL, workspace_id TEXT,
 *     expires_at INTEGER NOT NULL, ended_at INTEGER) STRICT;
 *   images(report_seq INTEGER NOT NULL, id TEXT PRIMARY KEY, reporter_id TEXT NOT NULL,
 *     state TEXT NOT NULL CHECK (state IN ('pending', 'stored')), type TEXT,
 *     byte_length INTEGER NOT NULL, started_at INTEGER NOT NULL, n INTEGER NOT NULL) STRICT;
 *   indexes (report_seq, n), (reporter_id), (state, started_at)
 *   events(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, kind TEXT NOT NULL,
 *     report_id TEXT NOT NULL, label TEXT NOT NULL, at INTEGER NOT NULL) STRICT;
 * An entry's `via` is set for an entry the admins wrote and NULL for the reporter's own, and its
 * `agent` is the AdminAgentOrigin, as JSON, of one written through the admin gatekeeper; a bare
 * change of status is an admins' public entry whose text is ''. An image is 'pending' from its
 * upload's reservation, when `started_at` and `n` (its place among its report's images) are set
 * and `byte_length` is the length its sender declared, until its object is in the bucket; only
 * a 'stored' image has a `type`, and only a 'stored' image is listed or read.
 *
 * `events` holds what the admin gatekeeper is still to be told (see IssueReportEvent): a report
 * that was filed, an investigation that ended. A row is written in one step with the change it
 * tells of and deleted once the gatekeeper has taken it; nothing else of a report leaves the
 * store this way, and nothing but the delivery reads the table. The event is known outside the
 * store by the row's random `id`: its `seq`, which counts the deployment's events, stays here.
 * On a deployment whose admin gatekeeper is not bound or is turned off the table is emptied
 * instead, so turning the gatekeeper on tells it of nothing that came before.
 */
export class IssueReportsDurableObject extends DurableObject<Cloudflare.Env> {
  // The delivery of the waiting events that is under way, if one is: see #deliverEvents().
  #delivery: Promise<void> | undefined;

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
      agent TEXT CHECK (agent IS NULL OR json_valid(agent)),
      text TEXT NOT NULL,
      status TEXT,
      PRIMARY KEY (report_seq, n)
    ) STRICT`);
    // A store whose entries table has no `agent` column gains it here: CREATE TABLE IF NOT EXISTS
    // leaves an existing table as it is.
    if (sql.exec("SELECT 1 FROM pragma_table_info('entries') WHERE name = 'agent'")
        .toArray().length === 0) {
      sql.exec(
          "ALTER TABLE entries ADD COLUMN agent TEXT CHECK (agent IS NULL OR json_valid(agent))");
    }
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
    sql.exec(`CREATE TABLE IF NOT EXISTS images (
      report_seq INTEGER NOT NULL,
      id TEXT PRIMARY KEY,
      reporter_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'stored')),
      type TEXT,
      byte_length INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      n INTEGER NOT NULL
    ) STRICT`);
    sql.exec("CREATE INDEX IF NOT EXISTS images_report ON images (report_seq, n)");
    // A reporter's held bytes and uploads in flight are summed across all their reports.
    sql.exec("CREATE INDEX IF NOT EXISTS images_reporter ON images (reporter_id)");
    // The sweep reads the oldest 'pending' rows.
    sql.exec("CREATE INDEX IF NOT EXISTS images_state ON images (state, started_at)");
    // What the admin gatekeeper is still to be told, oldest first by `seq`, which is never used
    // twice. Emptied when the gatekeeper is not bound or is turned off.
    sql.exec(`CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL,
      kind TEXT NOT NULL,
      report_id TEXT NOT NULL,
      label TEXT NOT NULL,
      at INTEGER NOT NULL
    ) STRICT`);
    // A store whose events table has no `id` column gains it here, as `entries` gains `agent`,
    // and each event that waits in it is given its id.
    if (sql.exec("SELECT 1 FROM pragma_table_info('events') WHERE name = 'id'")
        .toArray().length === 0) {
      sql.exec("ALTER TABLE events ADD COLUMN id TEXT NOT NULL DEFAULT ''");
      for (let { seq } of sql.exec<{ seq: number }>("SELECT seq FROM events").toArray()) {
        sql.exec("UPDATE events SET id = ? WHERE seq = ?", crypto.randomUUID(), seq);
      }
    }
  }

  // --- The reporter ---

  /**
   * Files a report for `reporter`, with status "new", and returns it. `ownsWorkspace`: whether
   * the reporter owns the workspace the report names, as the caller found; false when it names
   * none. The caller has checked that the reporter can open what the context names. Throws
   * (TypeError) for a text that is blank or over MAX_ISSUE_REPORT_TEXT_LENGTH once trimmed, a
   * priority that is not one, and a context that is malformed; refused `tooManyReports` once the
   * reporter has filed MAX_ISSUE_REPORTS_PER_DAY since UTC midnight. Tells the admin gatekeeper
   * of the report ("reported"), which leaves the alarm no later than EVENT_RETRY_MS away: that
   * run is also what sets the alarm that prunes the store.
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
    this.#addEvent("reported", id, input.priority, now);
    await this.#wakeForEvents();
    this.ctx.waitUntil(this.#deliverEvents());
    return ownReportOf(this.#report("r.id = ?", id)!);
  }

  /**
   * Adds an image to a report `reporterId` filed: `image` is a stream of its bytes and
   * `byteLength` how many it holds, as the caller declared. The bytes go to the bucket as they
   * arrive, a piece at a time, and nothing is held whole. Returns the image once it is stored.
   *
   * Refused `imageTooLarge` over MAX_ISSUE_REPORT_IMAGE_BYTES; `notFound` for a report that is
   * not the reporter's or is past the retention in force (the alarm is about to delete it, and
   * an upload must not put that off); `closed`; `tooManyImages` at MAX_ISSUE_REPORT_IMAGES in
   * the report; `tooManyUploads` at MAX_ISSUE_REPORT_IMAGE_UPLOADS_PER_USER uploads of the
   * reporter in flight; `imageQuotaReached` past MAX_ISSUE_REPORT_IMAGE_BYTES_PER_USER; and
   * `imageNotRecognised` unless the first bytes are a PNG's, a JPEG's or a WebP's. Throws
   * (TypeError) for a `byteLength` that is not a whole number and for a stream that holds more
   * or fewer bytes than it, and an Error for an upload cut off after IMAGE_UPLOAD_SECONDS.
   * Whatever refuses or fails it, the stream is cancelled and nothing of it stays stored.
   */
  async addImage(reporterId: string, reportId: string, image: ReadableStream<Uint8Array>,
      byteLength: number): Promise<IssueReportImage> {
    let sql = this.ctx.storage.sql;
    let reader = image.getReader();
    let row: PendingImage;
    try {
      // 1. The length, before any row. Nothing shorter than a signature is an image.
      if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
        throw new TypeError("An image's byteLength must be a whole number.");
      }
      if (byteLength > MAX_ISSUE_REPORT_IMAGE_BYTES) {
        throw createIssueReportError(ISSUE_REPORT_ERROR_CODES.imageTooLarge);
      }
      if (byteLength < IMAGE_SIGNATURE_BYTES) {
        throw createIssueReportError(ISSUE_REPORT_ERROR_CODES.imageNotRecognised);
      }
      // 2. Stale uploads give their room back first. When the bucket cannot be reached they
      // keep it, and this upload goes on.
      try {
        await this.#sweepPendingImages();
      } catch (error) {
        logger.error("failed to delete the issue report image uploads that never finished", {
          event: "issue.report.image.sweep.failed", error,
        });
      }
      // 3. The retention in force, which fails the upload if it cannot be asked.
      let dueBefore = await this.#dueBefore();
      // 4. The reservation, in one step with that answer: there is no `await` from the answer
      // to the inserted row, so uploads racing each other count each other's.
      row = this.#reserveImage(auditOwnerId(reporterId), reportId, byteLength, dueBefore);
    } catch (error) {
      // No byte of the stream has been read.
      reader.cancel().catch(() => {});
      throw error;
    }

    let key = imageKey(row);
    let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
    let put: Promise<unknown> | undefined;
    let stored: IssueReportImage | undefined;
    let failure: unknown;
    // 5. The cut-off, counted from the reservation. It only marks the upload and stops its two
    // streams: the upload fails where it is waiting, and its cleanup deletes what there is.
    let cutOff: Error | undefined;
    let timer = setTimeout(() => {
      cutOff = uploadTookTooLong();
      reader.cancel(cutOff).catch(() => {});
      writer?.abort(cutOff).catch(() => {});
    }, IMAGE_UPLOAD_SECONDS * 1000);
    // What `step` settled as, unless the upload was cut off meanwhile: that is looked at first,
    // because a read that was waiting when its reader was cancelled rejects for a stream that
    // came over a binding and reports the end for a local one, and neither is the stream's own
    // error or end.
    let settled = async <T>(step: Promise<T>): Promise<T> => {
      let outcome = await step.then(value => ({ value }), (error: unknown) => ({ error }));
      if (cutOff !== undefined) throw cutOff;
      if ("error" in outcome) throw outcome.error;
      return outcome.value;
    };
    try {
      // 6. The format, from the first bytes, before anything is sent to the bucket. The pieces
      // read for it are kept as they came.
      let read = async (): Promise<Uint8Array | undefined> => {
        let { done, value } = await settled(reader.read());
        return done ? undefined : value;
      };
      let head: Uint8Array[] = [];
      let prefix = new Uint8Array(IMAGE_SIGNATURE_BYTES);
      for (let held = 0; held < IMAGE_SIGNATURE_BYTES;) {
        let piece = await read();
        if (piece === undefined) throw fewerBytesThanDeclared();
        prefix.set(piece.subarray(0, IMAGE_SIGNATURE_BYTES - held), held);
        held += piece.byteLength;
        head.push(piece);
      }
      let type = sniffImageMimeType(prefix);
      if (type === undefined) {
        throw createIssueReportError(ISSUE_REPORT_ERROR_CODES.imageNotRecognised);
      }

      // 7. The put, with the last byte held back. The bucket stores an object as soon as its
      // body has received `byteLength` bytes, before the body is closed, and an abort after
      // that leaves the object. So until the source has reported its end the body is a byte
      // short, and the bucket can hold nothing of an upload that turns out longer or broken.
      let body = new FixedLengthStream(byteLength);
      writer = body.writable.getWriter();
      put = this.env.ISSUE_IMAGES.put(key, body.readable);
      // Awaited below and in the cleanup; a rejection that arrives in between is not unhandled.
      put.catch(() => {});
      let count = 0;
      let last: Uint8Array | undefined;
      // One piece at a time, each written before the next is read: the bucket's own
      // backpressure, with nothing held but the piece in hand.
      let next = async () => head.shift() ?? await read();
      for (let piece = await next(); piece !== undefined; piece = await next()) {
        if (piece.byteLength === 0) continue;
        if (count + piece.byteLength > byteLength) {
          throw new TypeError("The image holds more bytes than its byteLength.");
        }
        count += piece.byteLength;
        if (count < byteLength) {
          await settled(writer.write(piece));
        } else {
          last = piece.slice(-1);
          if (piece.byteLength > 1) await settled(writer.write(piece.subarray(0, -1)));
        }
      }
      if (last === undefined) throw fewerBytesThanDeclared();
      await settled(writer.write(last));
      await settled(writer.close());
      await settled(put);

      // 8. The finish, in one step: the put resolved and the upload was not cut off. A row as
      // old as the sweep takes is the sweep's, so a row a sweep has read never becomes 'stored'
      // under it.
      let finished = sql.exec(
        `UPDATE images SET state = 'stored', type = ?
         WHERE id = ? AND state = 'pending' AND started_at > ? RETURNING id`,
        type, row.id, Date.now() - PENDING_IMAGE_SECONDS * 1000).toArray();
      if (finished.length === 0) {
        // The put outlasted its row's age. When a sweep has taken the row since, it is put back
        // while its report exists, so that the object this put stored has a row while the
        // cleanup deletes it, and is the sweep's to retry if that delete fails. This is the one
        // place that leans on a delete succeeding: when the report has been deleted since, or
        // the sweep deletes the row after this step, the object has no row to be retried by,
        // and the cleanup's delete is the one it gets.
        this.#insertPendingImage(row);
        throw uploadTookTooLong();
      }
      stored = { id: row.id, type, byteLength };
      return stored;
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      // 9. The cleanup of an upload that did not store its image.
      clearTimeout(timer);
      if (stored === undefined) {
        reader.cancel(failure).catch(() => {});
        writer?.abort(failure).catch(() => {});
        try {
          if (put !== undefined) {
            // The delete is sent only once the put has settled, resolved or rejected: sent
            // sooner it can be answered before the put lands, and the object then stays.
            await put.then(() => {}, () => {});
            await this.env.ISSUE_IMAGES.delete(key);
          }
          sql.exec("DELETE FROM images WHERE id = ? AND state = 'pending'", row.id);
        } catch (error) {
          // The row stays for the sweep, which deletes the object again and then the row.
          logger.error("failed to delete an issue report image that was not stored", {
            event: "issue.report.image.delete.failed", error,
          });
        }
      }
    }
  }

  /** One page of the reporter's reports, newest first, ISSUE_REPORT_PAGE_SIZE at most. The cursor
   * is the id of the last report of the page before, which is the reporter's own: a report's
   * number counts every report the deployment was sent, so it is never handed to a reporter or
   * taken from one. Throws for a cursor that is not the id of a report `reporterId` filed. */
  listOwn(reporterId: string, cursor?: string): OwnIssueReportPage {
    let reporter = auditOwnerId(reporterId);
    let before: number | undefined;
    if (cursor !== undefined) {
      before = this.#report("r.id = ? AND r.reporter_id = ?", cursor, reporter)?.seq;
      if (before === undefined) throw new TypeError("Invalid cursor.");
    }
    let { rows, last } = this.#page(
        ["r.reporter_id = ?"], [reporter], before, ISSUE_REPORT_PAGE_SIZE);
    let page: OwnIssueReportPage = { reports: rows.map(ownReportOf) };
    if (last !== undefined) page.nextCursor = last.id;
    return page;
  }

  /** A report `reporterId` filed, with its public thread, oldest entry first, each entry as the
   * reporter reads it: an admin's without the admin's id. `notFound` for any other report. */
  getOwn(reporterId: string, reportId: string): OwnIssueReport & { entries: IssueReportEntry[] } {
    let row = this.#ownReport(reporterId, reportId);
    return { ...ownReportOf(row), entries: this.#entries(row.seq, "reporter") };
  }

  /** The bytes of an image of a report `reporterId` filed, as a stream: the reporter's read.
   * `notFound` for any other report, and for an image that is not stored in it. */
  async readOwnImage(reporterId: string, reportId: string, imageId: string)
      : Promise<ReadableStream<Uint8Array>> {
    return this.#openImage(this.#storedImage(this.#ownReport(reporterId, reportId), imageId));
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
   * Throws `notFound` unless report `reportId` was filed by `ownerId` and names workspace
   * `workspaceId`: what lets an admin's view of that workspace be opened for the report
   * (AdminWorkspaceInspectOptions.forIssueReport). Reads only. Called by the workspace, with its
   * own owner and id, never on a client's word.
   */
  checkReportWorkspace(ownerId: string, reportId: string, workspaceId: string): void {
    // The reporter is compared with the owner as they are when this is asked, not with who
    // owned the workspace when the report was filed (`owns_workspace`), and no grant is read: a
    // report that holds a live grant is still its owner's.
    let found = this.ctx.storage.sql.exec(
      "SELECT 1 FROM reports WHERE id = ? AND reporter_id = ? AND workspace_id = ?",
      reportId, auditOwnerId(ownerId), workspaceId).toArray();
    if (found.length === 0) throw notFound();
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
    let before: number | undefined;
    if (query.cursor !== undefined) {
      before = /^[0-9]+$/.test(query.cursor) ? Number(query.cursor) : NaN;
      if (!Number.isSafeInteger(before)) throw new TypeError("Invalid cursor.");
    }
    let { rows, last } = this.#page(where, params, before, limit);
    let page: AdminIssueReportPage = { reports: rows.map(adminReportOf) };
    if (last !== undefined) page.nextCursor = String(last.seq);
    return page;
  }

  /** One report with its whole thread, admins-only entries included, oldest entry first.
   * `notFound` for an id that names none. */
  get(reportId: string): AdminIssueReport & { entries: IssueReportEntry[] } {
    let row = this.#report("r.id = ?", reportId);
    if (row === undefined) throw notFound();
    return { ...adminReportOf(row), entries: this.#entries(row.seq, "admins") };
  }

  /** The bytes of an image of any report, as a stream: the admins' read. The caller has checked
   * that it serves an admin. `notFound` for an image that is not stored in that report. */
  async readImage(reportId: string, imageId: string): Promise<ReadableStream<Uint8Array>> {
    return this.#openImage(this.#storedImage(this.#reportSeq(reportId), imageId));
  }

  /**
   * Adds an entry `admin` wrote to a report's thread, for the reporter ("public") or for admins
   * alone ("admins"), and returns it. `caller` is how the admin's call is labelled, kept with the
   * entry as adminCallerTerms() gives it. It changes no status, and works on a closed report. A
   * public one makes the report unseen by its reporter. Throws (TypeError) for a caller, a text
   * or a visibility that is not one; refused `notFound`, and `threadFull` once the admins have
   * written MAX_ISSUE_REPORT_THREAD_ENTRIES entries of that visibility. The entries made through
   * the admin gatekeeper, which a rule can make with nobody deciding, have a bound of their own
   * and take no place of a person's.
   */
  addEntry(admin: Pick<AiChatAuthorInfo, "id" | "name">,
      caller: Pick<AdminAccessRecord, "via" | "agent">, reportId: string,
      text: string, visibility: IssueReportEntry["visibility"]): IssueReportEntry {
    let author = namedUser(admin);
    let label = adminCallerTerms(caller);
    let body = writtenText(text);
    if (visibility !== "public" && visibility !== "admins") {
      throw new TypeError("Invalid visibility.");
    }
    let { seq } = this.#reportSeq(reportId);
    let written = this.#threadCount(
        seq, visibility === "public" ? "adminPublic" : "adminOnly", label.via === "gatekeeper");
    if (written >= MAX_ISSUE_REPORT_THREAD_ENTRIES) {
      throw createIssueReportError(ISSUE_REPORT_ERROR_CODES.threadFull);
    }
    return entryOf(this.#addEntry(seq, author, visibility, label, body), "admins");
  }

  /**
   * Sets a report's status, entered in its thread as a public line with no text that names
   * `admin` and is labelled as `caller` (see addEntry()). A status the report already has changes
   * nothing. A person's call is never refused `threadFull`, so a full thread can still be closed;
   * a call made through the admin gatekeeper, which a rule can make with nobody deciding, is,
   * once MAX_ISSUE_REPORT_THREAD_ENTRIES changes of this report's status were made through it. It
   * leaves the report as seen as it was. A report that leaves "investigating" for any status but "new" has
   * ended an investigation, which the admin gatekeeper is told ("investigationComplete"). Throws
   * (TypeError) for a caller or a status that is not one; refused `notFound`.
   */
  async setStatus(admin: Pick<AiChatAuthorInfo, "id" | "name">,
      caller: Pick<AdminAccessRecord, "via" | "agent">, reportId: string,
      status: IssueReportStatus): Promise<void> {
    let author = namedUser(admin);
    let label = adminCallerTerms(caller);
    if (!ISSUE_REPORT_STATUSES.includes(status)) throw new TypeError("Invalid status.");
    let report = this.#reportSeq(reportId);
    if (report.status === status) return;
    if (label.via === "gatekeeper" &&
        this.#threadCount(report.seq, "status", true) >= MAX_ISSUE_REPORT_THREAD_ENTRIES) {
      throw createIssueReportError(ISSUE_REPORT_ERROR_CODES.threadFull);
    }
    let { at } = this.#addEntry(report.seq, author, "public", label, "", status);
    if (report.status !== "investigating" || status === "new") return;
    this.#addEvent("investigationComplete", report.id, status, at);
    await this.#wakeForEvents();
    this.ctx.waitUntil(this.#deliverEvents());
  }

  /** Replaces a report's links with `links` as reportLinks() keeps them. Throws (TypeError) for
   * links that are not ones; refused `notFound`. */
  setLinks(reportId: string, links: string[]): void {
    let kept = JSON.stringify(reportLinks(links));
    let changed = this.ctx.storage.sql.exec(
        "UPDATE reports SET links = ? WHERE id = ? RETURNING seq", kept, reportId).toArray();
    if (changed.length === 0) throw notFound();
  }

  // --- Images ---

  // The reservation of an upload of `byteLength` bytes to the report `reportId`, by `reporter`
  // (as auditOwnerId() gives it): its 'pending' row, inserted here. One synchronous step, so
  // that what it counts cannot change before its row is in. Once inserted the row holds the
  // declared length and a slot in the report, so uploads racing each other cannot pass a bound
  // together. `dueBefore` is #dueBefore()'s answer.
  #reserveImage(reporter: string, reportId: string, byteLength: number, dueBefore: number)
      : PendingImage {
    let sql = this.ctx.storage.sql;
    let [report] = sql.exec<{ seq: number; id: string; status: string; due: number }>(
      `SELECT seq, id, status, ${REPORT_DUE} AS due FROM reports
       WHERE id = ? AND reporter_id = ?`, dueBefore, reportId, reporter).toArray();
    if (report === undefined || report.due) throw notFound();
    if (report.status === "closed") {
      throw createIssueReportError(ISSUE_REPORT_ERROR_CODES.closed);
    }
    let { images } = sql.exec<{ images: number }>(
      "SELECT COUNT(*) AS images FROM images WHERE report_seq = ?", report.seq).one();
    if (images >= MAX_ISSUE_REPORT_IMAGES) {
      throw createIssueReportError(ISSUE_REPORT_ERROR_CODES.tooManyImages);
    }
    // Over all the reporter's reports. An upload in flight is a stream and an open put held in
    // this one object, so a reporter may not hold one for every slot of every open report.
    let held = sql.exec<{ uploads: number; bytes: number }>(
      `SELECT COUNT(*) FILTER (WHERE state = 'pending') AS uploads,
         COALESCE(SUM(byte_length), 0) AS bytes
       FROM images WHERE reporter_id = ?`, reporter).one();
    if (held.uploads >= MAX_ISSUE_REPORT_IMAGE_UPLOADS_PER_USER) {
      throw createIssueReportError(ISSUE_REPORT_ERROR_CODES.tooManyUploads);
    }
    if (held.bytes + byteLength > MAX_ISSUE_REPORT_IMAGE_BYTES_PER_USER) {
      throw createIssueReportError(ISSUE_REPORT_ERROR_CODES.imageQuotaReached);
    }
    let row: PendingImage = {
      report_seq: report.seq, report_id: report.id, id: crypto.randomUUID(),
      reporter_id: reporter, byte_length: byteLength, started_at: Date.now(),
    };
    this.#insertPendingImage(row);
    return row;
  }

  // Inserts an upload's 'pending' row, last among its report's images: only while its report
  // exists, and not over a row of that id.
  #insertPendingImage(image: PendingImage): void {
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO images
         (report_seq, id, reporter_id, state, byte_length, started_at, n)
       SELECT seq, ?, ?, 'pending', ?, ?,
         (SELECT COALESCE(MAX(n), 0) + 1 FROM images WHERE report_seq = reports.seq)
       FROM reports WHERE seq = ?`,
      image.id, image.reporter_id, image.byte_length, image.started_at, image.report_seq);
  }

  // Deletes the uploads that never finished: up to PRUNE_BATCH 'pending' rows older than
  // PENDING_IMAGE_SECONDS, oldest first, their objects in one call of the bucket and then, once
  // that resolved, the rows. It waits for no put: an upload whose row is that old is gone, or
  // is refused at its finish. Throws what the bucket threw, having deleted no row.
  async #sweepPendingImages(): Promise<void> {
    let sql = this.ctx.storage.sql;
    let stale = sql.exec<ImageKey>(
      `SELECT r.id AS report_id, i.id FROM images i JOIN reports r ON r.seq = i.report_seq
       WHERE i.state = 'pending' AND i.started_at < ? ORDER BY i.started_at LIMIT ?`,
      Date.now() - PENDING_IMAGE_SECONDS * 1000, PRUNE_BATCH).toArray();
    if (stale.length === 0) return;
    await this.env.ISSUE_IMAGES.delete(stale.map(imageKey));
    this.ctx.storage.transactionSync(() => {
      for (let { id } of stale) {
        sql.exec("DELETE FROM images WHERE id = ? AND state = 'pending'", id);
      }
    });
  }

  // The row of the 'stored' image `imageId` of `report`; `notFound` for an id that names none
  // there, and for an upload that has not finished.
  #storedImage(report: { seq: number; id: string }, imageId: string): ImageKey {
    let [image] = this.ctx.storage.sql.exec<{ id: string }>(
      "SELECT id FROM images WHERE report_seq = ? AND id = ? AND state = 'stored'",
      report.seq, imageId).toArray();
    if (image === undefined) throw notFound();
    return { report_id: report.id, id: image.id };
  }

  // The bytes of the image a row names, as the bucket's own byte stream, which crosses the
  // binding as it is: nothing is read or held here. `notFound` when the object is not there.
  async #openImage(image: ImageKey): Promise<ReadableStream<Uint8Array>> {
    let object = await this.env.ISSUE_IMAGES.get(imageKey(image));
    if (object === null) {
      logger.error("an issue report image's row has no object in the bucket", {
        event: "issue.report.image.missing",
      });
      throw notFound();
    }
    return object.body;
  }

  // --- Events ---

  // Writes the row that tells the admin gatekeeper of a change. Called in the synchronous step
  // that made the change, so the two are one write.
  #addEvent(kind: IssueReportEvent["kind"], reportId: string,
      label: IssueReportPriority | IssueReportStatus, at: number): void {
    this.ctx.storage.sql.exec(
        "INSERT INTO events (id, kind, report_id, label, at) VALUES (?, ?, ?, ?, ?)",
        crypto.randomUUID(), kind, reportId, label, at);
  }

  // An event row is waiting: wake within EVENT_RETRY_MS, so that it outlives an object evicted
  // before its delivery settles. Only ever moves the alarm earlier. Its caller awaits nothing
  // between writing the row and this, so the row and the alarm are one write. What it costs:
  // alarm()'s pass runs once more, a minute after each report filed and each investigation
  // ended, even where the admin gatekeeper is off. The pass deletes only what is due, so an
  // early run changes nothing.
  async #wakeForEvents(): Promise<void> {
    let retry = Date.now() + EVENT_RETRY_MS;
    let at = await this.ctx.storage.getAlarm();
    if (at === null || at > retry) await this.ctx.storage.setAlarm(retry);
  }

  // Offers the waiting events to the admin gatekeeper: see #sendEvents(). One delivery runs at
  // a time, and a start while one runs joins it. Never rejects and never touches the alarm. The
  // delivery begins in a later microtask, so that it is kept here before it can end.
  #deliverEvents(): Promise<void> {
    return this.#delivery ??= Promise.resolve().then(() => this.#sendEvents());
  }

  // One delivery: the waiting events, oldest first, EVENT_BATCH a call, each batch deleted once
  // the admin gatekeeper has taken it. Where the gatekeeper is not bound or is turned off nobody
  // is to be told, and every row is deleted.
  //
  // A call that is rejected, or has not settled within EVENT_RETRY_MS, ends the delivery: its
  // rows stay for alarm() to offer again, with the same `id`, except those older than
  // EVENT_MAX_AGE_MS, which are dropped. A call given up on is not waited for: whatever it
  // comes to later deletes nothing, since by then another delivery may be sending the same
  // rows. So a gatekeeper that hangs holds back neither a later event nor the alarm.
  async #sendEvents(): Promise<void> {
    let sql = this.ctx.storage.sql;
    let rows: EventRow[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      for (;;) {
        rows = sql.exec<EventRow>(
          "SELECT seq, id, kind, report_id, label, at FROM events ORDER BY seq LIMIT ?",
          EVENT_BATCH).toArray();
        if (rows.length === 0) return;
        let vendor = getAuthVendorBinding(this.env, ADMIN_GATEKEEPER_VENDOR_ID) as
            Service<AdminGatekeeperVendor> | null;
        if (vendor === null || await adminGatekeeperOff(this.env)) {
          sql.exec("DELETE FROM events");
          return;
        }
        await Promise.race([
          vendor.issueReportEvents(rows.map(eventOf)),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(reject, EVENT_RETRY_MS,
                new Error("The admin gatekeeper did not answer in time."));
          }),
        ]);
        clearTimeout(timer);
        sql.exec("DELETE FROM events WHERE seq <= ?", rows.at(-1)!.seq);
      }
    } catch (error) {
      logger.warn("the admin gatekeeper did not take the issue report events", {
        event: "issue.reports.events.undelivered", size: rows.length, error,
      });
      let dropped = sql.exec(
          "DELETE FROM events WHERE at < ? RETURNING seq", Date.now() - EVENT_MAX_AGE_MS).toArray();
      if (dropped.length > 0) {
        logger.error("dropped the issue report events the admin gatekeeper never took", {
          event: "issue.reports.events.dropped", size: dropped.length,
        });
      }
    } finally {
      clearTimeout(timer);
      this.#delivery = undefined;
    }
  }

  // --- Retention ---

  // The time before which a report was filed if it is past the retention in force: see
  // REPORT_DUE. The retention is asked of AdminSettings (the committed config) each time, never
  // kept.
  async #dueBefore(): Promise<number> {
    let config = await this.ctx.exports.AdminSettings.getByName("").committedAdminConfig();
    return Date.now() - adminAccessPolicy(config, this.env).issueReportRetentionDays * DAY_MS;
  }

  /**
   * Deletes the uploads that never finished, then the reports filed before the retention in
   * force, with their threads and images, PRUNE_BATCH a run. If the retention cannot be asked
   * no report is deleted, since a report must not go by a value that may be stale.
   *
   * A report's images go first: their objects in one call of the bucket, then their rows, then
   * each report of the batch that has no image row left. So a report whose objects could not
   * be deleted keeps its rows and is retried, as is one that gained an image while the bucket
   * was called, and a report with no image goes whatever the bucket did. A due report with an
   * upload in flight is left for a later run: the upload finishes or is swept within
   * PENDING_IMAGE_SECONDS, and none begins on a due report.
   *
   * After the pass, whatever woke it, it offers the waiting events to the admin gatekeeper
   * (#deliverEvents()), which cannot fail it and is given up on within EVENT_RETRY_MS.
   *
   * Sets the next alarm itself: an hour ahead after a failure, else a minute ahead while a
   * report is still due, else a day ahead while anything remains; and no later than
   * EVENT_RETRY_MS ahead while an event still waits, whatever else the store holds. Never
   * throws: the platform gives up on an alarm that keeps throwing.
   */
  async alarm(): Promise<void> {
    let sql = this.ctx.storage.sql;
    let failed = false;
    let dueLeft = false;
    try {
      await this.#sweepPendingImages();
    } catch (error) {
      failed = true;
      logger.error("failed to delete the issue report image uploads that never finished", {
        event: "issue.report.image.sweep.failed", error,
      });
    }
    try {
      let dueBefore = await this.#dueBefore();
      // Chosen in `filed_at` order, which its index answers without reading the table.
      let image = "SELECT 1 FROM images WHERE report_seq = reports.seq";
      let dueSeqs = (where: string, limit: number) => sql.exec<{ seq: number }>(
        `SELECT seq FROM reports WHERE ${REPORT_DUE} AND ${where} ORDER BY filed_at, seq LIMIT ?`,
        dueBefore, limit).toArray().map(({ seq }) => seq);
      // The reports with no image fill the batch first, and those with images what is left of
      // it: reports whose objects cannot be deleted stay due, and chosen by age alone they
      // would fill every batch ahead of the reports that need nothing of the bucket.
      let bare = dueSeqs(`NOT EXISTS (${image})`, PRUNE_BATCH);
      let pictured = dueSeqs(`EXISTS (${image}) AND NOT EXISTS (${image} AND state = 'pending')`,
          PRUNE_BATCH - bare.length);
      let seqs = JSON.stringify([...bare, ...pictured]);
      let within = "IN (SELECT value FROM json_each(?))";
      let images = sql.exec<ImageKey>(
        `SELECT r.id AS report_id, i.id FROM images i JOIN reports r ON r.seq = i.report_seq
         WHERE i.report_seq ${within}`, seqs).toArray();
      let deleted = true;
      if (images.length > 0) {
        try {
          await this.env.ISSUE_IMAGES.delete(images.map(imageKey));
        } catch (error) {
          deleted = false;
          failed = true;
          logger.error("failed to delete the images of the issue reports past their retention", {
            event: "issue.report.image.delete.failed", error,
          });
        }
      }
      this.ctx.storage.transactionSync(() => {
        if (deleted) {
          sql.exec(`DELETE FROM images WHERE id ${within}`,
              JSON.stringify(images.map(({ id }) => id)));
        }
        let gone = sql.exec<{ seq: number }>(
          `SELECT seq FROM reports WHERE seq ${within} AND NOT EXISTS
             (SELECT 1 FROM images WHERE report_seq = reports.seq)`, seqs).toArray();
        this.#deleteReports(gone.map(({ seq }) => seq));
      });
      dueLeft = sql.exec(`SELECT 1 FROM reports WHERE ${REPORT_DUE} LIMIT 1`, dueBefore)
          .toArray().length > 0;
    } catch (error) {
      failed = true;
      logger.error("failed to delete the issue reports past their retention", {
        event: "issue-reports.prune.failed", error,
      });
    }
    await this.#deliverEvents();
    try {
      // An empty store needs no alarm: submit() sets one with the next report. An event that
      // still waits brings the alarm back within EVENT_RETRY_MS, in a store with no report too.
      let kept = sql.exec(
        "SELECT 1 FROM reports UNION ALL SELECT 1 FROM images WHERE state = 'pending' LIMIT 1")
          .toArray();
      let waiting = sql.exec("SELECT 1 FROM events LIMIT 1").toArray().length > 0;
      if (kept.length > 0 || waiting) {
        let pass = kept.length > 0 ? (failed ? HOUR_MS : dueLeft ? MINUTE_MS : DAY_MS) : Infinity;
        await this.ctx.storage.setAlarm(
            Date.now() + Math.min(pass, waiting ? EVENT_RETRY_MS : Infinity));
      }
    } catch (error) {
      logger.error("failed to set the issue reports' next alarm", {
        event: "issue-reports.alarm.failed", error,
      });
    }
  }

  // Deletes the reports `seqs` number, with their entries and each grant row no report names
  // any more: the one place a report is deleted. A report it is handed has no image row left.
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

  // What the admins' writes and their read of an image need of a report; `notFound` for an id
  // that names none.
  #reportSeq(reportId: string): { seq: number; id: string; status: string } {
    let [row] = this.ctx.storage.sql.exec<{ seq: number; id: string; status: string }>(
        "SELECT seq, id, status FROM reports WHERE id = ?", reportId).toArray();
    if (row === undefined) throw notFound();
    return row;
  }

  // One page of the reports matching `where` that were filed before the report numbered
  // `before`, newest first, with the page's last report when more follow it.
  #page(where: string[], params: string[], before: number | undefined, limit: number)
      : { rows: ReportRow[]; last?: ReportRow } {
    let values: (string | number)[] = [...params];
    if (before !== undefined) {
      where = [...where, "r.seq < ?"];
      values.push(before);
    }
    let filter = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    let rows = this.ctx.storage.sql.exec<ReportRow>(
        `${REPORT_SELECT} ${filter} ORDER BY r.seq DESC LIMIT ?`, ...values, limit + 1).toArray();
    return rows.length > limit ? { rows: rows.slice(0, limit), last: rows[limit - 1] } : { rows };
  }

  // A report's thread as `reader` reads it, oldest entry first: for the reporter the public
  // entries alone, so that no admins-only row is read for them.
  #entries(reportSeq: number, reader: "reporter" | "admins"): IssueReportEntry[] {
    let visible = reader === "reporter" ? "AND visibility = 'public'" : "";
    return this.ctx.storage.sql.exec<EntryRow>(
      `SELECT n, id, at, author_id, author_name, visibility, via, agent, text, status FROM entries
       WHERE report_seq = ? ${visible} ORDER BY n`, reportSeq).toArray()
        .map(row => entryOf(row, reader));
  }

  // How many entries of one kind a report's thread holds: those made through the admin
  // gatekeeper when `agent` is set, and people's otherwise.
  #threadCount(reportSeq: number, kind: keyof typeof THREAD_KINDS, agent = false): number {
    return this.ctx.storage.sql.exec<{ count: number }>(
      `SELECT COUNT(*) AS count FROM entries WHERE report_seq = ? AND ${THREAD_KINDS[kind]}
         AND via IS ${agent ? "" : "NOT"} 'gatekeeper'`,
      reportSeq).one().count;
  }

  // Adds an entry to a report's thread, in one step with what it changes of the report: when its
  // thread last grew; its status, when the entry sets one; and, for a public entry an admin wrote
  // (a `via` and a text), `last_admin_public`, which makes the report unseen. A bare change of
  // status has no text, so it does not. `label` is an admin's checked label (adminCallerTerms()),
  // or null for the reporter's own entry. Returns the entry's row.
  #addEntry(reportSeq: number, author: NamedUser, visibility: IssueReportEntry["visibility"],
      label: Pick<AdminAccessRecord, "via" | "agent"> | null, text: string,
      status?: IssueReportStatus): EntryRow {
    let sql = this.ctx.storage.sql;
    let via = label?.via ?? null;
    let row: EntryRow = {
      n: 0, id: crypto.randomUUID(), at: Date.now(), author_id: author.id,
      author_name: author.name, visibility, via,
      agent: label?.agent ? JSON.stringify(label.agent) : null, text, status: status ?? null,
    };
    this.ctx.storage.transactionSync(() => {
      row.n = sql.exec<{ n: number }>(
        "SELECT COALESCE(MAX(n), 0) + 1 AS n FROM entries WHERE report_seq = ?",
        reportSeq).one().n;
      sql.exec(
        `INSERT INTO entries (report_seq, n, id, at, author_id, author_name, visibility, via,
           agent, text, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        reportSeq, row.n, row.id, row.at, row.author_id, row.author_name, row.visibility,
        row.via, row.agent, row.text, row.status);
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
