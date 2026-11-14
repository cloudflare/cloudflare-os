// ---------------------------------------------------------------------------
// Row and column identity. Every line of a sheet has an id that never changes while it exists,
// so a cell is named by (row id, column id) and an edit, a formula reference or a column width
// stays with its line however lines are inserted, deleted or moved around it.
//
// A sheet's lines are an ordered list of every id ever placed on that axis. A deleted line stays
// in the list, marked deleted (a tombstone), so a range whose end line was deleted still knows
// where it ended, and an insert placed before a line someone else deleted still lands where it
// was meant to. Lines a sheet started with have ids 0..n-1 (a sheet nobody inserted into is in
// identity order and needs nothing stored); lines inserted later get ids from newLineIds, far
// above any such count.
// ---------------------------------------------------------------------------

/** Rows or columns. */
export type Axis = "rows" | "cols";

/** A run of consecutive ids in a stored order: `[first id, count]`, or `[first id, count, 1]` for deleted lines. */
export type Run = [number, number] | [number, number, 1];

/** A sheet's line order as stored and sent: each axis as runs (see Run). */
export interface StoredOrder {
  rows: Run[];
  cols: Run[];
}

/**
 * A change to a sheet's lines, by id. `insert` places new ids before line `before` (null: at the
 * end); `delete` marks lines deleted; `move` takes lines out and puts them, in their current
 * order, before `before` (null: at the end). A line named by `before` may itself be deleted.
 */
export type LineOp =
  | { kind: "insert"; sheetId: string; axis: Axis; ids: number[]; before: number | null }
  | { kind: "delete"; sheetId: string; axis: Axis; ids: number[] }
  | { kind: "move"; sheetId: string; axis: Axis; ids: number[]; before: number | null };

/** What LineOrder works out once per change: the live lines, where each id sits, and live counts before each position. */
interface OrderIndex {
  live: number[];
  liveIndex: Map<number, number>;
  position: Map<number, number>;
  liveBefore: Int32Array;
}

/** One axis of a sheet: every id placed on it in order, with the deleted ones marked. */
export class LineOrder {
  private ids: number[];
  private deleted: Set<number>;
  private index: OrderIndex | null = null;

  constructor(ids: number[], deleted: Iterable<number> = []) {
    this.ids = ids;
    this.deleted = new Set(deleted);
  }

  /** Lines 0..count-1, as a sheet starts. */
  static identity(count: number): LineOrder {
    return new LineOrder(Array.from({ length: Math.max(0, count) }, (_, i) => i));
  }

  /** An order from its stored runs; anything malformed in them is skipped. */
  static fromRuns(runs: unknown): LineOrder {
    const ids: number[] = [], deleted: number[] = [], seen = new Set<number>();
    for (const run of Array.isArray(runs) ? runs : []) {
      if (!Array.isArray(run)) continue;
      const [start, count, gone] = run as unknown[];
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) || (start as number) < 0 || (count as number) < 1) continue;
      for (let id = start as number; id < (start as number) + (count as number); id++) {
        if (seen.has(id)) continue;
        seen.add(id); ids.push(id);
        if (gone === 1) deleted.push(id);
      }
    }
    return new LineOrder(ids, deleted);
  }

  /** The order as runs of consecutive ids. */
  toRuns(): Run[] {
    const runs: Run[] = [];
    for (const id of this.ids) {
      const gone = this.deleted.has(id), last = runs[runs.length - 1];
      if (last && last[0] + last[1] === id && (last[2] === 1) === gone) last[1]++;
      else runs.push(gone ? [id, 1, 1] : [id, 1]);
    }
    return runs;
  }

  clone(): LineOrder { return new LineOrder(this.ids.slice(), this.deleted); }

  private built(): OrderIndex {
    if (this.index) return this.index;
    const live: number[] = [], liveIndex = new Map<number, number>(), position = new Map<number, number>();
    const liveBefore = new Int32Array(this.ids.length + 1);
    this.ids.forEach((id, i) => {
      position.set(id, i);
      liveBefore[i] = live.length;
      if (!this.deleted.has(id)) { liveIndex.set(id, live.length); live.push(id); }
    });
    liveBefore[this.ids.length] = live.length;
    return this.index = { live, liveIndex, position, liveBefore };
  }

  /** How many lines are not deleted. */
  get size(): number { return this.built().live.length; }
  /** The live lines' ids, top to bottom (or left to right). */
  live(): readonly number[] { return this.built().live; }
  /** The id of the live line at `index`. */
  idAt(index: number): number | undefined { return this.built().live[index]; }
  /** Where a live line is (-1: deleted or never placed). */
  indexOf(id: number): number { return this.built().liveIndex.get(id) ?? -1; }
  /** Whether the id was ever placed here (live or deleted). */
  has(id: number): boolean { return this.built().position.has(id); }
  /** Whether the id names a live line. */
  isLive(id: number): boolean { return this.built().liveIndex.has(id); }
  /** Every id ever placed, deleted ones included. */
  get placed(): number { return this.ids.length; }
  /** How many lines the axis started with (ids 0..n-1, deleted ones included): the size a new sheet is created at before its other line operations. */
  get started(): number { let n = 0; for (const id of this.ids) if (id < FIRST_NEW_ID) n++; return n; }

  /**
   * The live lines a span from line `a` to line `b` (either order) covers, as `[first, last]`
   * live indexes: a deleted end walks inward to the nearest live line. Null when no live line is
   * left between them, or an end was never placed.
   */
  span(a: number, b: number): [number, number] | null {
    const { position, liveBefore } = this.built();
    const pa = position.get(a), pb = position.get(b);
    if (pa === undefined || pb === undefined) return null;
    const lo = Math.min(pa, pb), hi = Math.max(pa, pb);
    const first = liveBefore[lo], end = liveBefore[hi + 1];
    return end > first ? [first, end - 1] : null;
  }

  /** The live index of the first live line at or after line `id`'s place (`size` when none is). */
  liveFrom(id: number): number | null {
    const { position, liveBefore } = this.built();
    const p = position.get(id);
    return p === undefined ? null : liveBefore[p];
  }

  /** Whether `id` sits before `other` (both placed). */
  before(id: number, other: number): boolean {
    const { position } = this.built();
    return (position.get(id) ?? Infinity) < (position.get(other) ?? Infinity);
  }

  /**
   * Why `op` can't apply (null when it can): inserted ids must be new, unique and safe integers,
   * moved and deleted ones live, and the axis must keep between 1 and `max` lines.
   */
  refusal(op: LineOp, max: number): string | null {
    const ids = op.ids;
    if (!Array.isArray(ids) || !ids.length) return "no lines";
    if (new Set(ids).size !== ids.length || !ids.every((id) => Number.isSafeInteger(id) && id >= 0)) return "bad line ids";
    if (op.kind === "insert") {
      if (ids.some((id) => this.has(id))) return "line id taken";
      if (this.size + ids.length > max) return "too many lines";
    } else if (!ids.every((id) => this.isLive(id))) return "line gone";
    if (op.kind === "delete" && this.size - ids.length < 1) return "last line";
    if (op.kind !== "delete" && op.before != null && (!this.has(op.before) || ids.includes(op.before))) return "bad position";
    return null;
  }

  /**
   * Applies `op` (callers that can't trust it check `refusal` first). Inserting an id already
   * placed, or deleting or moving one that isn't, is skipped, so an op applied twice does nothing
   * more. Returns whether anything changed.
   */
  apply(op: LineOp): boolean {
    if (op.kind === "delete") {
      let changed = false;
      for (const id of op.ids) if (this.isLive(id)) { this.deleted.add(id); changed = true; }
      if (changed) this.index = null;
      return changed;
    }
    const placeBefore = (lines: number[]) => {
      const at = op.before == null ? -1 : this.ids.indexOf(op.before);
      if (at < 0) this.ids.push(...lines); else this.ids.splice(at, 0, ...lines);
    };
    if (op.kind === "insert") {
      const fresh = op.ids.filter((id) => !this.has(id));
      if (!fresh.length) return false;
      placeBefore(fresh);
    } else {
      const moving = new Set(op.ids.filter((id) => this.has(id)));
      if (!moving.size || (op.before != null && moving.has(op.before))) return false;
      const lines = this.ids.filter((id) => moving.has(id));
      const before = this.ids.join();
      this.ids = this.ids.filter((id) => !moving.has(id));
      placeBefore(lines);
      if (this.ids.join() === before) return false;
    }
    this.index = null;
    return true;
  }
}

/** Both axes of one sheet. */
export class SheetOrder {
  rows: LineOrder;
  cols: LineOrder;
  constructor(rows: LineOrder, cols: LineOrder) { this.rows = rows; this.cols = cols; }

  /** A sheet's order from what is stored (nothing stored: identity order of its size). */
  static from(stored: StoredOrder | null | undefined, rows: number, cols: number): SheetOrder {
    return stored ? new SheetOrder(LineOrder.fromRuns(stored.rows), LineOrder.fromRuns(stored.cols)) : new SheetOrder(LineOrder.identity(rows), LineOrder.identity(cols));
  }

  axis(axis: Axis): LineOrder { return axis === "rows" ? this.rows : this.cols; }
  clone(): SheetOrder { return new SheetOrder(this.rows.clone(), this.cols.clone()); }
  toStored(): StoredOrder { return { rows: this.rows.toRuns(), cols: this.cols.toRuns() }; }

  /** The cell key ("rowId:colId") of the live cell at a position, or null past the edge. */
  keyAt(r: number, c: number): string | null {
    const row = this.rows.idAt(r), col = this.cols.idAt(c);
    return row === undefined || col === undefined ? null : row + ":" + col;
  }

  /** Where the cell with this key is now, or null when its row or column is deleted. */
  positionOf(key: string): { r: number; c: number } | null {
    const ids = parseCellKey(key);
    if (!ids) return null;
    const r = this.rows.indexOf(ids.row), c = this.cols.indexOf(ids.col);
    return r < 0 || c < 0 ? null : { r, c };
  }

  /** Whether the cell's row and column are both live. */
  liveKey(key: string): boolean {
    const ids = parseCellKey(key);
    return !!ids && this.rows.isLive(ids.row) && this.cols.isLive(ids.col);
  }
}

const CELL_KEY = /^(\d{1,16}):(\d{1,16})$/;
/** A cell key's row and column ids ("12:3" -> { row: 12, col: 3 }), or null when it isn't one. */
export function parseCellKey(key: string): { row: number; col: number } | null {
  const m = CELL_KEY.exec(key);
  if (!m) return null;
  const row = Number(m[1]), col = Number(m[2]);
  return Number.isSafeInteger(row) && Number.isSafeInteger(col) ? { row, col } : null;
}

/** The cell key of a row and column id. */
export function cellKey(row: number, col: number): string { return row + ":" + col; }

/** Where ids for inserted lines start: past every line a sheet can start with, so they never meet one. */
export const FIRST_NEW_ID = 2 ** 32;
const NEW_ID_SLOTS = Math.floor((2 ** 52 - FIRST_NEW_ID) / 32);

/**
 * `count` fresh, consecutive line ids for an insert. They start at a random multiple of 32 (the
 * rows of one insert share storage blocks) in a range far larger than any workbook could use, so
 * two tabs inserting at once practically never pick the same; the server refuses an insert whose
 * id is taken.
 */
export function newLineIds(count: number): number[] {
  const words = new Uint32Array(2);
  crypto.getRandomValues(words);
  const slot = Math.floor((words[0] / 2 ** 32 + words[1] / 2 ** 64) * NEW_ID_SLOTS);
  const start = FIRST_NEW_ID + slot * 32;
  return Array.from({ length: count }, (_, i) => start + i);
}
