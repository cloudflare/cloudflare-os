import type { PublishedSpaceInfo } from "@gadgets/workshop-shared/api";
import { DurableObject } from "cloudflare:workers";

const PAGE_SIZE = 50;
// Every authenticated user can reach this one DO, so a search bounds what it is asked to scan.
const MAX_QUERY_LENGTH = 1000;

type SpaceRow = Pick<PublishedSpaceInfo, "key" | "name" | "kind">
    & { owner_id: string | null; owner_name: string | null };

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
      owner_name TEXT,
      search_text TEXT NOT NULL,
      rev INTEGER NOT NULL,
      listed INTEGER NOT NULL
    ) STRICT`);
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS spaces_by_name ON spaces (name, key)");
  }

  /**
   * Record whether `space` is listed, as of the space's revision `rev`: a row already at that
   * revision or a higher one is left alone, so that pushes arriving out of order converge on the
   * newest, and a space that stops being listed is never listed again by an older push. Of a
   * personal space's owner only the id and display name are kept.
   */
  syncSpace(space: PublishedSpaceInfo, listed: boolean, rev: number): void {
    let { key, name, kind, owner } = space;
    this.ctx.storage.sql.exec(
      `INSERT INTO spaces (key, name, kind, owner_id, owner_name, search_text, rev, listed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET name = excluded.name, kind = excluded.kind,
         owner_id = excluded.owner_id, owner_name = excluded.owner_name,
         search_text = excluded.search_text, rev = excluded.rev, listed = excluded.listed
       WHERE excluded.rev > spaces.rev`,
      key, name, kind, owner?.id ?? null, owner?.name ?? null,
      `${key}\n${name}\n${owner?.name ?? ""}`.toLowerCase(), rev, listed ? 1 : 0);
  }

  /**
   * One page of the listed spaces, ordered by name, ignoring case, then key: those whose key,
   * name or owner's display name contains `query`, ignoring case, or every one for a blank query.
   * `cursor` is what the previous page returned, to continue after it; the last page returns
   * none. Rejects a query over `MAX_QUERY_LENGTH` characters or containing a line break, and a
   * malformed cursor.
   */
  listSpaces(query = "", cursor?: string): { spaces: PublishedSpaceInfo[]; cursor?: string } {
    // The searched fields are joined by newlines in search_text, so a needle containing one could
    // match across two of them.
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
      `SELECT key, name, kind, owner_id, owner_name FROM spaces
       WHERE listed = 1 AND instr(search_text, ?) > 0
         AND (? IS NULL OR (name, key) > (?, ?))
       ORDER BY name, key
       LIMIT ${PAGE_SIZE + 1}`,
      query.trim().toLowerCase(), after[0], ...after,
    ).toArray();
    let spaces = rows.slice(0, PAGE_SIZE).map(({ owner_id: id, owner_name: name, ...space }) =>
        id === null ? space : { ...space, owner: { type: "user" as const, id, name: name! } });
    if (rows.length <= PAGE_SIZE) return { spaces };
    let { key, name } = spaces.at(-1)!;
    return { spaces, cursor: `${key}\n${name}` };
  }
}
