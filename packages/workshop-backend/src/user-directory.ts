import {
  MAX_DIRECTORY_TEXT_LENGTH, type AdminUserRecord, type AdminWorkspacePage,
  type AdminWorkspaceRecord, type UserDirectoryRecord,
} from "@gadgets/workshop-shared/api";
import { DurableObject } from "cloudflare:workers";

const SEARCH_RESULT_LIMIT = 10;
// Every authenticated user can reach this one DO, so a search bounds what it is asked to scan.
const MAX_QUERY_LENGTH = 1000;
const MAX_EXCLUDE_IDS = 1000;
// A page stops early once its text would pass this many characters, which keeps it far below the
// RPC message limit whatever the directory holds, since ids are stored whole.
const MAX_PAGE_TEXT_LENGTH = 1_000_000;

/** How often a user DO or an Overseer reports activity to the directory at most: an hour, the
 * precision of AdminUserRecord.lastLogin and AdminWorkspaceRecord.lastActive. */
export const DIRECTORY_ACTIVITY_INTERVAL_MS = 60 * 60_000;

/** What a user DO reports of its account beside its profile (see syncUser()). */
export type UserDirectoryActivity = {
  /** When the account was created, if recorded; the first known value is kept. */
  created?: Date;
  /** When the session being reported started; the stored value only moves forward. */
  lastLogin?: Date;
};

/** A workspace as its Overseer reports it to the directory (see syncWorkspace()). */
export type WorkspaceDirectoryEntry = {
  /** The workspace (Overseer Durable Object) id. */
  id: string;
  /** Its title as of the sync's revision, whole; the directory keeps its first
   * MAX_DIRECTORY_TEXT_LENGTH characters. */
  title: string;
  /** The owner's canonical user id. */
  ownerId: string;
  /** When it was initialised, if known. */
  created?: Date;
  /** When it was last active, if this sync reports activity; the stored value only moves forward. */
  lastActive?: Date;
};

/** One page of UserDirectoryDurableObject.listUsers(): AdminUserRecord without `isAdmin`, which
 * AdminApiImpl adds from ADMINS. */
export type UserDirectoryPage = { users: Omit<AdminUserRecord, "isAdmin">[]; nextCursor?: string };

// A display name or title as the directory keeps and lists it: its first MAX_DIRECTORY_TEXT_LENGTH
// characters, one fewer rather than half of a surrogate pair.
function clamp(text: string): string {
  if (text.length <= MAX_DIRECTORY_TEXT_LENGTH) return text;
  const last = text.charCodeAt(MAX_DIRECTORY_TEXT_LENGTH - 1);
  const end = last >= 0xd800 && last <= 0xdbff
      ? MAX_DIRECTORY_TEXT_LENGTH - 1 : MAX_DIRECTORY_TEXT_LENGTH;
  return text.slice(0, end);
}

// Name and id are joined by a newline in search_text, so a needle containing one could match
// across the two fields.
function validateQuery(query: string): void {
  if (query.length > MAX_QUERY_LENGTH || /[\r\n]/.test(query)) {
    throw new Error(
      `Search query must be at most ${MAX_QUERY_LENGTH} characters with no line breaks.`);
  }
}

function validateLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError("A page limit must be a positive whole number.");
  }
}

// A time as the directory stores it: epoch ms, NULL for unknown.
function epochMs(date: Date | undefined): number | null {
  return date ? date.getTime() : null;
}

// Collects rows into one page in the order a query yields them: at most `limit` (the query asks
// for one more, to learn whether another page follows), and fewer once their text would pass
// MAX_PAGE_TEXT_LENGTH, though never none while any remain. Rows are read one at a time, so none
// past the first one left out is ever read.
function collectPage<Row, Item extends { id: string }>(
    rows: Iterable<Row>, limit: number, toItem: (row: Row) => Item,
    textLength: (item: Item) => number): { items: Item[]; nextCursor?: string } {
  const items: Item[] = [];
  let text = 0;
  for (const row of rows) {
    const item = toItem(row);
    const length = textLength(item);
    if (items.length >= limit || (items.length > 0 && text + length > MAX_PAGE_TEXT_LENGTH)) {
      return { items, nextCursor: items[items.length - 1].id };
    }
    items.push(item);
    text += length;
  }
  return { items };
}

/**
 * Deployment-wide directory of users and workspaces: users find collaborators in it
 * (AuthenticatedApi.searchUsers()), and admins list the deployment's users and workspaces
 * (AdminApi.listUsers() and listWorkspaces()). Each user DO mirrors its profile and activity here
 * (`UserDurableObject.#syncDirectory`), each Overseer mirrors its workspace
 * (`OverseerImpl.syncDirectory`) and takes it out on deletion (`removeFromDirectory`), and
 * AdminApiImpl removes a workspace it finds gone. Durable Objects cannot be enumerated, so the
 * directory fills as it is used: an account is listed once it has started a session since the
 * directory began recording accounts for user search (one recorded before the admin listings is
 * listed without `lastLogin` until its next session), a workspace when it is next opened.
 *
 * The admin listings live here rather than in a store of their own because this is already the
 * deployment-wide singleton (always `getByName("")`), every user DO already feeds it through a
 * revision protocol that backfills lazily, and it is already migrated and bound in tests: a second
 * store would duplicate the users table, the sync protocol and the per-session writes.
 *
 * It is a finding aid, not a record: display names and titles take any length, so they are kept
 * and listed as their first MAX_DIRECTORY_TEXT_LENGTH characters, as boundAgentCatalog() clamps a
 * catalog (the admin audit log marks its cuts instead, since a record must not pass a fragment off
 * as the whole). Ids are identities and stay whole, and a username has no length limit, so a page
 * is bounded by its text as well as by its count.
 */
export class UserDirectoryDurableObject extends DurableObject<Cloudflare.Env> {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      search_text TEXT NOT NULL,
      rev INTEGER NOT NULL
    ) STRICT`);
    // Times are epoch ms; NULL means unknown.
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS user_activity (
      id TEXT PRIMARY KEY,
      created INTEGER,
      last_login INTEGER
    ) STRICT`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      search_text TEXT NOT NULL,
      created INTEGER,
      last_active INTEGER,
      rev INTEGER NOT NULL
    ) STRICT`);
    ctx.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS workspaces_by_owner ON workspaces (owner_id, id)");
  }

  /**
   * Insert or update one user's record: the name clamped to MAX_DIRECTORY_TEXT_LENGTH, the search
   * text built from the clamped name and the id's first MAX_DIRECTORY_TEXT_LENGTH characters, the
   * id whole. `rev` is the user DO's profile revision: a record already at a higher revision is
   * left alone, so syncs that arrive out of order still converge on the newest profile.
   * `activity` is merged whatever `rev` is, as UserDirectoryActivity says.
   */
  syncUser(record: UserDirectoryRecord, rev: number, activity?: UserDirectoryActivity): void {
    const name = clamp(record.name);
    this.ctx.storage.sql.exec(
      `INSERT INTO users (id, name, search_text, rev) VALUES (?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, search_text = excluded.search_text,
         rev = excluded.rev
       WHERE excluded.rev > users.rev`,
      record.id, name, `${clamp(record.id)}\n${name}`.toLowerCase(), rev);
    if (activity?.created || activity?.lastLogin) {
      this.ctx.storage.sql.exec(
        `INSERT INTO user_activity (id, created, last_login) VALUES (?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           created = coalesce(user_activity.created, excluded.created),
           last_login = max(coalesce(user_activity.last_login, excluded.last_login),
                            coalesce(excluded.last_login, user_activity.last_login))`,
        record.id, epochMs(activity.created), epochMs(activity.lastLogin));
    }
  }

  /**
   * Insert or update one workspace, its title clamped and its search text bounded as syncUser()'s
   * are. `rev` is the Overseer's time-based directory revision, so a workspace reinitialised under
   * the same id outranks what its earlier life reported: a higher `rev` replaces the title, the
   * owner and (when the sync carries one) `created`; a lower or equal one changes none of them but
   * fills a `created` the row lacks. `lastActive` only moves forward.
   */
  syncWorkspace(entry: WorkspaceDirectoryEntry, rev: number): void {
    const title = clamp(entry.title);
    // Every expression in the SET list reads the row as it was before the update.
    this.ctx.storage.sql.exec(
      `INSERT INTO workspaces (id, title, owner_id, search_text, created, last_active, rev)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         title = iif(excluded.rev > workspaces.rev, excluded.title, workspaces.title),
         owner_id = iif(excluded.rev > workspaces.rev, excluded.owner_id, workspaces.owner_id),
         search_text = iif(excluded.rev > workspaces.rev, excluded.search_text,
                           workspaces.search_text),
         created = iif(excluded.rev > workspaces.rev,
                       coalesce(excluded.created, workspaces.created),
                       coalesce(workspaces.created, excluded.created)),
         last_active = max(coalesce(workspaces.last_active, excluded.last_active),
                           coalesce(excluded.last_active, workspaces.last_active)),
         rev = max(workspaces.rev, excluded.rev)`,
      entry.id, title, entry.ownerId,
      `${entry.id}\n${title}\n${clamp(entry.ownerId)}`.toLowerCase(),
      epochMs(entry.created), epochMs(entry.lastActive), rev);
  }

  /** Forget a workspace: its Overseer, deleting it, or AdminApiImpl on finding it gone. */
  removeWorkspace(id: string): void {
    this.ctx.storage.sql.exec("DELETE FROM workspaces WHERE id = ?", id);
  }

  /**
   * The title (clamped) and owner the directory lists for a workspace, or null when it lists none:
   * what AdminApiImpl records, the title cut, for an open refused before reaching the workspace.
   * Rejects an id over 1000 characters (workspace ids are 64).
   */
  workspaceListing(id: string): { title: string; ownerId: string } | null {
    if (id.length > MAX_QUERY_LENGTH) {
      throw new Error(`Workspace id must be at most ${MAX_QUERY_LENGTH} characters.`);
    }
    const row = this.ctx.storage.sql.exec<{ title: string; owner_id: string }>(
      "SELECT title, owner_id FROM workspaces WHERE id = ?", id).toArray()[0];
    return row ? { title: clamp(row.title), ownerId: row.owner_id } : null;
  }

  /**
   * Case-insensitive substring search over name and id, excluding every id in `excludeIds`.
   * The id is indexed first so an exact id starts at position one; ties sort by id then name.
   * Rejects a query over `MAX_QUERY_LENGTH` characters or containing a line break, and more than
   * `MAX_EXCLUDE_IDS` distinct exclusions. Names are clamped as every read clamps them, since a
   * row stored before the directory clamped may hold more.
   */
  searchUsers(query: string, excludeIds: string[]): UserDirectoryRecord[] {
    validateQuery(query);
    const excluded = [...new Set(excludeIds)];
    if (excluded.length > MAX_EXCLUDE_IDS) {
      throw new Error(`At most ${MAX_EXCLUDE_IDS} users can be excluded from a search.`);
    }
    const needle = query.trim().toLowerCase();
    if (needle === "") return [];
    return this.ctx.storage.sql.exec<UserDirectoryRecord>(
      `SELECT id, name FROM users
       WHERE id NOT IN (SELECT value FROM json_each(?)) AND instr(search_text, ?) > 0
       ORDER BY instr(search_text, ?), id, name COLLATE NOCASE
       LIMIT ${SEARCH_RESULT_LIMIT}`,
      JSON.stringify(excluded), needle, needle,
    ).toArray().map(({ id, name }) => ({ id, name: clamp(name) }));
  }

  /**
   * Users in id order after `cursor` (the previous page's last id, of any length), matching
   * `query` as searchUsers() matches (blank matches all), with their activity and clamped names:
   * at most `limit`, and fewer once the page's ids and names would pass a million characters
   * (never none while any remain). Rejects a `query` over 1000 characters or with a line break;
   * `limit` must be a positive whole number (AdminApiImpl bounds it).
   */
  listUsers(options: { query?: string; cursor?: string; limit: number }): UserDirectoryPage {
    const { query = "", cursor, limit } = options;
    validateQuery(query);
    validateLimit(limit);
    const needle = query.trim().toLowerCase();
    const conditions: string[] = [];
    const bindings: string[] = [];
    if (cursor !== undefined) {
      conditions.push("users.id > ?");
      bindings.push(cursor);
    }
    if (needle !== "") {
      conditions.push("instr(users.search_text, ?) > 0");
      bindings.push(needle);
    }
    const rows = this.ctx.storage.sql.exec<{
      id: string; name: string; created: number | null; last_login: number | null;
    }>(
      `SELECT users.id AS id, users.name AS name, user_activity.created AS created,
         user_activity.last_login AS last_login
       FROM users LEFT JOIN user_activity ON user_activity.id = users.id
       ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""}
       ORDER BY users.id LIMIT ?`,
      ...bindings, limit + 1);
    const { items, nextCursor } = collectPage(rows, limit, row => ({
      id: row.id,
      name: clamp(row.name),
      ...row.created !== null && { created: new Date(row.created) },
      ...row.last_login !== null && { lastLogin: new Date(row.last_login) },
    }), user => user.id.length + user.name.length);
    return nextCursor === undefined ? { users: items } : { users: items, nextCursor };
  }

  /**
   * Workspaces in id order after `cursor`, of `owner` (matched exactly, any length) if given,
   * matching `query` against id, title and owner id, each owner's display name joined from the
   * users table and clamped (their id, clamped, while it has none); paged and bounded as
   * listUsers() is, counting ids, titles and owners. Rejects what listUsers() rejects.
   */
  listWorkspaces(options: { owner?: string; query?: string; cursor?: string; limit: number })
      : AdminWorkspacePage {
    const { owner, query = "", cursor, limit } = options;
    validateQuery(query);
    validateLimit(limit);
    const needle = query.trim().toLowerCase();
    const conditions: string[] = [];
    const bindings: string[] = [];
    if (owner !== undefined) {
      conditions.push("workspaces.owner_id = ?");
      bindings.push(owner);
    }
    if (cursor !== undefined) {
      conditions.push("workspaces.id > ?");
      bindings.push(cursor);
    }
    if (needle !== "") {
      conditions.push("instr(workspaces.search_text, ?) > 0");
      bindings.push(needle);
    }
    const rows = this.ctx.storage.sql.exec<{
      id: string; title: string; owner_id: string; owner_name: string | null;
      created: number | null; last_active: number | null;
    }>(
      `SELECT workspaces.id AS id, workspaces.title AS title, workspaces.owner_id AS owner_id,
         users.name AS owner_name, workspaces.created AS created,
         workspaces.last_active AS last_active
       FROM workspaces LEFT JOIN users ON users.id = workspaces.owner_id
       ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""}
       ORDER BY workspaces.id LIMIT ?`,
      ...bindings, limit + 1);
    const { items, nextCursor } = collectPage(rows, limit, (row): AdminWorkspaceRecord => ({
      id: row.id,
      title: clamp(row.title),
      owner: { id: row.owner_id, name: clamp(row.owner_name ?? row.owner_id) },
      ...row.created !== null && { created: new Date(row.created) },
      ...row.last_active !== null && { lastActive: new Date(row.last_active) },
    }), workspace => workspace.id.length + workspace.title.length + workspace.owner.id.length
        + workspace.owner.name.length);
    return nextCursor === undefined ? { workspaces: items } : { workspaces: items, nextCursor };
  }
}
