import type { PublishedSpaceInfo } from "@gadgets/workshop-shared/api";
import { DurableObject } from "cloudflare:workers";

const PAGE_SIZE = 50;
// Every authenticated user can reach this one DO, so a search bounds what it is asked to scan.
const MAX_QUERY_LENGTH = 1000;

type SpaceRow = Pick<PublishedSpaceInfo, "key" | "name" | "kind"> & { owner_id: string | null };

// What a space is searched by: its key and name, joined by a line break, which no key holds.
const searchText = (key: string, name: string) => `${key}\n${name}`.toLowerCase();

/**
 * Deployment-wide directory of the spaces open to visitors, those with a published workspace at
 * the top of their tree, so that anyone signed in can find them. A presentation-only mirror that
 * owns nothing: each space pushes whether it is listed here (`SpaceDurableObject.alarm`), and
 * opening one is still decided by the space.
 */
export class SpaceDirectoryDurableObject extends DurableObject<Cloudflare.Env> {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    // A row is kept, unlisted, once its space stops being listed, holding the space's `rev`.
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS spaces (
      key TEXT PRIMARY KEY,
      name TEXT NOT NULL COLLATE NOCASE,
      kind TEXT NOT NULL,
      owner_id TEXT,
      search_text TEXT NOT NULL,
      rev INTEGER NOT NULL,
      listed INTEGER NOT NULL
    ) STRICT`);
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS spaces_by_name ON spaces (name, key)");
    // A table may have an `owner_name` column, a personal space's owner's display name, which no
    // read needs (it is the space's name) and which its rows' search text includes. Each row's
    // search text is computed again and the column dropped, in one transaction: the column's
    // absence is what keeps this from running more than once.
    let columns = ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(spaces)").toArray();
    if (columns.some(column => column.name === "owner_name")) {
      ctx.storage.transactionSync(() => {
        let rows = ctx.storage.sql.exec<{ key: string; name: string }>(
            "SELECT key, name FROM spaces").toArray();
        for (let { key, name } of rows) {
          ctx.storage.sql.exec(
              "UPDATE spaces SET search_text = ? WHERE key = ?", searchText(key, name), key);
        }
        ctx.storage.sql.exec("ALTER TABLE spaces DROP COLUMN owner_name");
      });
    }
  }

  /**
   * Record whether `space` is listed, as of the space's revision `rev`: a row already at that
   * revision or a higher one is left alone, so that pushes arriving out of order converge on the
   * newest, and a space that stops being listed is never listed again by an older push. Of a
   * personal space's owner only the id is kept: its display name is the space's name, which the
   * space was given at its claim (see `SpaceInfo.name`).
   */
  syncSpace(space: PublishedSpaceInfo, listed: boolean, rev: number): void {
    let { key, name, kind, owner } = space;
    this.ctx.storage.sql.exec(
      `INSERT INTO spaces (key, name, kind, owner_id, search_text, rev, listed)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET name = excluded.name, kind = excluded.kind,
         owner_id = excluded.owner_id, search_text = excluded.search_text, rev = excluded.rev,
         listed = excluded.listed
       WHERE excluded.rev > spaces.rev`,
      key, name, kind, owner?.id ?? null, searchText(key, name), rev, listed ? 1 : 0);
  }

  /**
   * One page of the listed spaces, ordered by name, ignoring case, then key: those whose key or
   * name contains `query`, ignoring case, or every one for a blank query.
   * `cursor` is what the previous page returned, to continue after it; the last page returns
   * none. Rejects a query over `MAX_QUERY_LENGTH` characters or containing a line break, and a
   * malformed cursor.
   */
  listSpaces(query = "", cursor?: string): { spaces: PublishedSpaceInfo[]; cursor?: string } {
    // The key and name are joined by a newline in search_text, so a needle containing one could
    // match across the two.
    if (query.length > MAX_QUERY_LENGTH || /[\r\n]/.test(query)) {
      throw new Error(
          `Search query must be at most ${MAX_QUERY_LENGTH} characters with no line breaks.`);
    }
    // The cursor is the key and name of a page's last space, joined by a line break, which no key
    // holds. Carrying its own place in the order, it continues after that space whether or not
    // it is still listed, and looks up no row, so it tells nothing of a space that is not.
    let after: [string | null, string | null] = [null, null];
    if (cursor !== undefined) {
      let at = cursor.indexOf("\n");
      if (at < 0) throw new Error("Invalid cursor.");
      after = [cursor.slice(at + 1), cursor.slice(0, at)];
    }
    let rows = this.ctx.storage.sql.exec<SpaceRow>(
      `SELECT key, name, kind, owner_id FROM spaces
       WHERE listed = 1 AND instr(search_text, ?) > 0
         AND (? IS NULL OR (name, key) > (?, ?))
       ORDER BY name, key
       LIMIT ${PAGE_SIZE + 1}`,
      query.trim().toLowerCase(), after[0], ...after,
    ).toArray();
    let spaces = rows.slice(0, PAGE_SIZE).map(({ owner_id: id, ...space }) =>
        id === null ? space : { ...space, owner: { type: "user" as const, id, name: space.name } });
    if (rows.length <= PAGE_SIZE) return { spaces };
    let { key, name } = spaces.at(-1)!;
    return { spaces, cursor: `${key}\n${name}` };
  }
}
