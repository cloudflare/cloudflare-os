import type { UserDirectoryRecord } from "@gadgets/workshop-shared/api";
import { DurableObject } from "cloudflare:workers";

const SEARCH_RESULT_LIMIT = 10;

/**
 * Deployment-wide directory of user profiles, so a user can find collaborators
 * by name or id. Each user DO mirrors updates to its own profile here
 * (`UserDurableObject.#syncDirectory`).
 */
export class UserDirectoryDurableObject extends DurableObject<Cloudflare.Env> {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      search_text TEXT NOT NULL
    ) STRICT`);
  }

  /** Insert or update one user's record. */
  syncUser(record: UserDirectoryRecord): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO users (id, name, search_text) VALUES (?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, search_text = excluded.search_text`,
      record.id, record.name, `${record.id}\n${record.name}`.toLowerCase());
  }

  /**
   * Case-insensitive substring search over name and id, excluding every id in `excludeIds`.
   * The id is indexed first so an exact id starts at position one; ties sort by id then name.
   */
  searchUsers(query: string, excludeIds: string[]): UserDirectoryRecord[] {
    const needle = query.trim().toLowerCase();
    if (needle === "") return [];
    return this.ctx.storage.sql.exec<UserDirectoryRecord>(
      `SELECT id, name FROM users
       WHERE id NOT IN (SELECT value FROM json_each(?)) AND instr(search_text, ?) > 0
       ORDER BY instr(search_text, ?), id, name COLLATE NOCASE
       LIMIT ${SEARCH_RESULT_LIMIT}`,
      JSON.stringify(excludeIds), needle, needle,
    ).toArray();
  }
}
