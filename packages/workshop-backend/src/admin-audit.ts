import {
  MAX_ADMIN_AUDIT_ARG_LENGTH,
  type AdminAuditPage, type AdminAuditQuery, type AdminAuditRecord, type AdminAuditStats,
  type AdminAuditStatsQuery,
} from "@gadgets/workshop-shared/api";
import { DurableObject } from "cloudflare:workers";
import {
  adminAuditStatsDays, adminListLimit, auditOwnerId, cutAdminAuditText, minAdminAuditRetentionDays,
} from "./admin-access.js";
import { utcDayKey } from "./ai-gateway-billing/limits/config.js";
import { createWorkshopLogger } from "./observability";

const logger = createWorkshopLogger("workshop.admin.audit");

const DAY_MS = 24 * 60 * 60_000;
// Rows older than the retention that one call deletes at most, so that a log left unused for long
// is trimmed over several calls rather than in one long write.
const PRUNE_BATCH = 1000;
// The longest admin or workspace filter list() takes; workspace ids are 64 characters.
const MAX_FILTER_LENGTH = 1000;
const TOP_LIMIT = 10;
// A record's method, and the user an access record's target belongs to (the account's user, or the
// workspace's owner), which stay in the JSON (see the schema below).
const METHOD = "json_extract(record, '$.method')";
const TARGET =
    "coalesce(json_extract(record, '$.userId'), json_extract(record, '$.workspaceOwner'))";

// The table's definition from its opening parenthesis: the text SQLite stores for it, which the
// constructor compares with this one.
const TABLE = `(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('workspace', 'user', 'setting')),
  admin TEXT NOT NULL,
  workspace_id TEXT,
  workspace_title TEXT,
  exposed TEXT CHECK (exposed IN ('metadata', 'content')),
  record TEXT NOT NULL CHECK (json_valid(record)),
  CHECK ((kind = 'workspace') = (workspace_id IS NOT NULL AND workspace_title IS NOT NULL)),
  CHECK ((kind = 'setting') = (exposed IS NULL))
) STRICT`;

type AuditRow = {
  seq: number;
  at: number;
  kind: string;
  admin: string;
  workspace_id: string | null;
  workspace_title: string | null;
  record: string;
};

/**
 * The deployment-wide admin audit log behind AdminApi.listAdminAudit() and getAdminAuditStats():
 * one row per AdminAuditRecord. An AdminAccessRecord is appended by the inspected workspace's
 * Overseer, once its call has read what it answers with and before that answer leaves, or by
 * AdminApiImpl before it refuses an open that never reached the workspace. An
 * AdminUserAccessRecord is appended the same way, by the inspected account's Durable Object or by
 * AdminApiImpl. An AdminSettingRecord is appended by AdminSettings before its change takes effect.
 * Always addressed as getByName(""). Callers pass the retention they read for the call; whatever
 * they pass, a record is kept at least minAdminAuditRetentionDays() days. Each method given one
 * first deletes up to 1000 rows older than it, and never lists or counts one.
 *
 * Schema (the integration suite installs a trigger on the table by this name). Each field of a
 * record is stored once: kind, at (epoch ms), admin and, for access to a workspace, workspace_id
 * and workspace_title are columns, and `exposed` is 'metadata' for every access record; the rest
 * of the record is JSON in `record`. The constructor rebuilds a table stored under another
 * definition.
 *   admin_audit(seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,
 *     kind TEXT NOT NULL CHECK (kind IN ('workspace', 'user', 'setting')), admin TEXT NOT NULL,
 *     workspace_id TEXT, workspace_title TEXT,
 *     exposed TEXT CHECK (exposed IN ('metadata', 'content')),
 *     record TEXT NOT NULL CHECK (json_valid(record)),
 *     CHECK ((kind = 'workspace') = (workspace_id IS NOT NULL AND workspace_title IS NOT NULL)),
 *     CHECK ((kind = 'setting') = (exposed IS NULL))) STRICT;
 *   indexes (at), (admin, seq), (workspace_id, seq), (kind, seq), (exposed, seq),
 *     (json_extract(record, '$.method'), seq),
 *     (coalesce(json_extract(record, '$.userId'), json_extract(record, '$.workspaceOwner')), seq)
 */
export class AdminAuditDurableObject extends DurableObject<Cloudflare.Env> {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    let sql = ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS admin_audit ${TABLE}`);
    // SQLite cannot alter a CHECK, and a table created from another definition refuses records its
    // CHECKs do not know, so a table whose stored definition is not this one is copied into one
    // that is. Any change to TABLE that keeps the columns is carried this way; one that changes
    // them needs its own copy statement. Each row keeps its seq, but AUTOINCREMENT's high-water
    // mark is not carried, so a seq above the highest row copied (one whose row has since been
    // deleted) can be handed out again, which only a list cursor held across the rebuild could
    // notice. The copy is proportional to the log and runs once. The stored text before the
    // parenthesis is not compared: a rename rewrites the name there, quoted.
    let { sql: stored } = sql.exec<{ sql: string }>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'admin_audit'").one();
    if (stored.slice(stored.indexOf("(")) !== TABLE) {
      try {
        ctx.storage.transactionSync(() => {
          sql.exec(`CREATE TABLE admin_audit_next ${TABLE}`);
          sql.exec("INSERT INTO admin_audit_next SELECT * FROM admin_audit");
          sql.exec("DROP TABLE admin_audit");
          sql.exec("ALTER TABLE admin_audit_next RENAME TO admin_audit");
        });
      } catch (error) {
        // A build rolled back onto a later definition meets rows of a kind its CHECK refuses,
        // which cannot be copied. The failed rebuild rolls back whole, leaving the stored table
        // with its rows and indexes; throwing here instead would refuse every admin change and
        // inspection until the build moved forward again.
        logger.error("failed to rebuild the admin audit table", {
          event: "admin.audit.table.rebuild.failed", error,
        });
      }
    }
    // A build that indexes the workspace owner alone creates this index at every start, so rolling
    // back onto it and forward again would otherwise leave it on the rebuilt table for good.
    sql.exec("DROP INDEX IF EXISTS admin_audit_owner");
    // The rebuild's DROP TABLE takes the table's indexes with it, so these follow it.
    sql.exec("CREATE INDEX IF NOT EXISTS admin_audit_at ON admin_audit (at)");
    sql.exec("CREATE INDEX IF NOT EXISTS admin_audit_admin ON admin_audit (admin, seq)");
    sql.exec("CREATE INDEX IF NOT EXISTS admin_audit_workspace ON admin_audit (workspace_id, seq)");
    sql.exec("CREATE INDEX IF NOT EXISTS admin_audit_kind ON admin_audit (kind, seq)");
    // Content reads are expected to be rare, so listing them reads only their rows.
    sql.exec("CREATE INDEX IF NOT EXISTS admin_audit_exposed ON admin_audit (exposed, seq)");
    // Every record names its method in the JSON. SQLite uses an index on an expression only for a
    // query that repeats the expression exactly, so list() filters on this same METHOD.
    sql.exec(`CREATE INDEX IF NOT EXISTS admin_audit_method ON admin_audit (${METHOD}, seq)`);
    sql.exec(`CREATE INDEX IF NOT EXISTS admin_audit_target ON admin_audit (${TARGET}, seq)`);
  }

  /** Store one record. Throws when it cannot be stored, which fails the call or change it records.
   * Prunes first with `retentionDays`, which only a caller holding the authoritative config passes:
   * an admin view reads the KV mirror, whose retention may be one an admin has since raised, so
   * its records are stored without pruning, and the next listing prunes. An AdminAccessRecord's
   * workspaceTitle is stored cut by cutAdminAuditText() to MAX_ADMIN_AUDIT_ARG_LENGTH, and its
   * workspaceOwner as auditOwnerId() gives it, whatever the caller sent: the fields a workspace's
   * members choose, neither bounded otherwise. An AdminUserAccessRecord's userId is kept as
   * auditOwnerId() gives it too. */
  append(record: AdminAuditRecord, retentionDays?: number): void {
    if (retentionDays !== undefined) this.#prune(retentionDays);
    // Each field is stored once, in its column or in the JSON, never both: a title stored twice let
    // an over-long one overflow the row (the platform caps one at 8 MiB) and fail every append.
    let workspaceId: string | null = null;
    let workspaceTitle: string | null = null;
    let rest: Record<string, unknown>;
    if (record.kind === "workspace") {
      let {
        kind: _kind, at: _at, admin: _admin, workspaceId: id, workspaceTitle: title,
        workspaceOwner: owner, ...fields
      } = record;
      workspaceId = id ?? null;
      // Its callers cut the title already, but neither a title nor a username has a length limit of
      // its own, and a page of records holding them whole could pass the RPC size limit, so the store
      // holds the bound itself.
      workspaceTitle = typeof title === "string"
          ? cutAdminAuditText(title, MAX_ADMIN_AUDIT_ARG_LENGTH) : null;
      rest = typeof owner === "string" ? { ...fields, workspaceOwner: auditOwnerId(owner) } : fields;
    } else if (record.kind === "user") {
      let { kind: _kind, at: _at, admin: _admin, userId, ...fields } = record;
      rest = typeof userId === "string" ? { ...fields, userId: auditOwnerId(userId) } : fields;
    } else {
      let { kind: _kind, at: _at, admin: _admin, ...fields } = record;
      rest = fields;
    }
    // The table's `exposed` column says what an access record's answer held, and a view answers
    // with metadata alone.
    let exposed = record.kind === "setting" ? null : "metadata";
    this.ctx.storage.sql.exec(
      `INSERT INTO admin_audit (at, kind, admin, workspace_id, workspace_title, exposed, record)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      record.at.getTime(), record.kind, record.admin, workspaceId, workspaceTitle, exposed,
      JSON.stringify(rest));
  }

  /** One page, newest first (see AdminApi.listAdminAudit()), each record rebuilt from its columns
   * and JSON; `limit` is validated by the caller. Throws for a malformed cursor or a filter over
   * 1000 characters. */
  list(query: Omit<AdminAuditQuery, "limit"> & { limit: number }, retentionDays: number)
      : AdminAuditPage {
    let limit = adminListLimit(query.limit);
    let cutoff = this.#prune(retentionDays);
    for (let filter of [query.admin, query.workspace, query.owner]) {
      if (filter !== undefined && filter.length > MAX_FILTER_LENGTH) {
        throw new TypeError(`Audit filters must be at most ${MAX_FILTER_LENGTH} characters.`);
      }
    }

    let where = ["at >= ?"];
    let params: (string | number)[] = [cutoff];
    if (query.kind !== undefined) {
      where.push("kind = ?");
      params.push(query.kind);
    }
    if (query.admin !== undefined) {
      where.push("admin = ?");
      params.push(query.admin);
    }
    if (query.method !== undefined) {
      where.push(`${METHOD} = ?`);
      params.push(query.method);
    }
    if (query.workspace !== undefined) {
      where.push("workspace_id = ?");
      params.push(query.workspace);
    }
    if (query.owner !== undefined) {
      // As append() keeps it, so a long id given whole finds that user's records, and only theirs.
      where.push(`${TARGET} = ?`);
      params.push(auditOwnerId(query.owner));
    }
    if (query.since !== undefined) {
      let since = query.since.getTime();
      if (Number.isNaN(since)) throw new TypeError("Invalid since.");
      where.push("at >= ?");
      params.push(since);
    }
    if (query.cursor !== undefined) {
      let before = /^[0-9]+$/.test(query.cursor) ? Number(query.cursor) : NaN;
      if (!Number.isSafeInteger(before)) throw new TypeError("Invalid cursor.");
      where.push("seq < ?");
      params.push(before);
    }

    let rows = this.ctx.storage.sql.exec<AuditRow>(
      `SELECT seq, at, kind, admin, workspace_id, workspace_title, record FROM admin_audit
       WHERE ${where.join(" AND ")} ORDER BY seq DESC LIMIT ?`,
      ...params, limit + 1).toArray();
    let page: AdminAuditPage = { records: rows.slice(0, limit).map(recordFromRow) };
    if (rows.length > limit) page.nextCursor = String(rows[limit - 1].seq);
    return page;
  }

  /** The counts getAdminAuditStats() reports for the last `days` UTC days of this object's clock. */
  stats(query: Pick<AdminAuditStatsQuery, "kind"> & { days: number }, retentionDays: number)
      : AdminAuditStats {
    let days = adminAuditStatsDays(query.days);
    let cutoff = this.#prune(retentionDays);
    let now = new Date();
    let start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
        (days - 1) * DAY_MS;
    let from = Math.max(start, cutoff);
    let sql = this.ctx.storage.sql;

    let where = "at >= ?";
    let params: (string | number)[] = [from];
    if (query.kind !== undefined) {
      where += " AND kind = ?";
      params.push(query.kind);
    }

    let counts = new Map<number, number>();
    let totalEvents = 0;
    for (let { day, count } of sql.exec<{ day: number; count: number }>(
        `SELECT at / ${DAY_MS} AS day, COUNT(*) AS count
         FROM admin_audit WHERE ${where} GROUP BY day`, ...params)) {
      counts.set(day, count);
      totalEvents += count;
    }
    let firstDay = start / DAY_MS;
    let byDay = Array.from({ length: days }, (_, i) => ({
      day: utcDayKey(new Date((firstDay + i) * DAY_MS)),
      count: counts.get(firstDay + i) ?? 0,
    }));

    return { days, totalEvents, byDay, topAdmins: this.#topAdmins(where, params) };
  }

  // The admins with the most rows matching `where`, most first.
  #topAdmins(where: string, params: (string | number)[]): { admin: string; count: number }[] {
    return this.ctx.storage.sql.exec<{ admin: string; count: number }>(
      `SELECT admin, COUNT(*) AS count FROM admin_audit WHERE ${where}
       GROUP BY admin ORDER BY count DESC, admin ASC LIMIT ${TOP_LIMIT}`, ...params).toArray();
  }

  // Delete up to PRUNE_BATCH rows older than the retention and return the cutoff every read
  // filters on, so a row past it is never listed or counted even before it is deleted. The batch is
  // chosen in `at` order, which the admin_audit_at index (holding each row's seq) answers without
  // reading the table: ordered by seq it would scan every row on each call while none has expired,
  // the usual case. Rows are appended in about time order, so either order deletes the oldest.
  #prune(retentionDays: number): number {
    if (!Number.isSafeInteger(retentionDays) || retentionDays < 1) {
      throw new TypeError("The audit retention must be a whole number of days of at least 1.");
    }
    let effective = Math.max(retentionDays, minAdminAuditRetentionDays(this.env));
    let cutoff = Date.now() - effective * DAY_MS;
    this.ctx.storage.sql.exec(
      `DELETE FROM admin_audit WHERE seq IN
         (SELECT seq FROM admin_audit WHERE at < ? ORDER BY at, seq LIMIT ${PRUNE_BATCH})`,
      cutoff);
    return cutoff;
  }
}

function recordFromRow(row: AuditRow): AdminAuditRecord {
  let rest = JSON.parse(row.record) as Record<string, unknown>;
  let columns = row.kind === "workspace"
      ? { workspaceId: row.workspace_id, workspaceTitle: row.workspace_title } : {};
  return { ...rest, kind: row.kind, at: new Date(row.at), admin: row.admin, ...columns } as
      AdminAuditRecord;
}
