import { EvaluationBudget, type Engine, type EngineCell, HyperlinkValue, type Scalar, displayValue, isErr, makeEngine, rcToRef } from "./formula.ts";
import type { CellFmt, ExportGadgetStub, SheetMeta } from "./protocol.ts";

// A new sheet's size (the server's sheetMeta), and what an export assumes for a sheet without one.
export const DEFAULT_ROWS = 100;
export const DEFAULT_COLS = 26;

// ---------------------------------------------------------------------------
// Export data. A big workbook can't travel as one value (getDocument), and a million cell
// objects wouldn't fit in memory twice over, so exports read the cells in pages (exportPage:
// parallel arrays, formats deduplicated) into ExportCells: one array per field, put in
// reading order by a counting sort on the row.
// ---------------------------------------------------------------------------
export const EXPORT_PAGE_CHARS = 3_000_000;
/** One sheet's exported cells as parallel arrays (zero-based row and column, raw value, index into the workbook's `fmts` or -1), plus their reading order. */
export class ExportCells {
  declare rows: number[];
  declare cols: number[];
  declare values: string[];
  declare fmtIds: number[];
  declare order: Int32Array;
  constructor() { this.rows = []; this.cols = []; this.values = []; this.fmtIds = []; this.order = new Int32Array(0); }
  get size(): number { return this.rows.length; }
  add(row: number, column: number, value: string, fmtId: number) { this.rows.push(row); this.cols.push(column); this.values.push(value); this.fmtIds.push(fmtId); }
  // `order`: cell indices by row, then column.
  sort() {
    const n = this.size, rows = this.rows, cols = this.cols;
    let maxRow = 0;
    for (let i = 0; i < n; ++i) if (rows[i] > maxRow) maxRow = rows[i];
    const starts = new Int32Array(maxRow + 2);
    for (let i = 0; i < n; ++i) starts[rows[i] + 1]++;
    for (let r = 0; r <= maxRow; ++r) starts[r + 1] += starts[r];
    const next = starts.slice(0, maxRow + 1), order = new Int32Array(n);
    for (let i = 0; i < n; ++i) order[next[rows[i]]++] = i;
    for (let r = 0; r <= maxRow; ++r) {
      if (starts[r + 1] - starts[r] > 1) order.subarray(starts[r], starts[r + 1]).sort((a, b) => cols[a] - cols[b]);
    }
    this.order = order;
  }
}
// { revision, title, sheetOrder, sheets, cells: Map(sheetId -> ExportCells), fmts: [fmt] }.
// Pages read while someone edits can mix revisions; then it reads again (twice at most, then
// takes what it has rather than fail).
/** A workbook as an export reads it: the structure, each sheet's cells, and the distinct formats they index. */
export interface ExportWorkbook {
  revision: number;
  title: string;
  sheetOrder: string[];
  sheets: Record<string, SheetMeta>;
  cells: Map<string, ExportCells>;
  fmts: CellFmt[];
}
/**
 * Releases an RPC result. Over Workers RPC each result holds the call open until it is disposed
 * (a big export makes hundreds of `exportPage` calls), and the runtime warns about every one left
 * to the garbage collector. A direct call (the tests) returns a plain object with no disposer.
 */
export function disposeResult(result: unknown): void {
  if (result && typeof result === "object") (result as Partial<Disposable>)[Symbol.dispose]?.();
}
/** The most cells one export reads: past about this, the workbook no longer fits the export's memory (128 MB). */
export const MAX_EXPORT_CELLS = 400_000;
/** The most characters of cell text one export reads, for workbooks of long texts that stay under the cell cap. */
export const MAX_EXPORT_TEXT = 40_000_000;
export async function loadExportWorkbook(gadget: ExportGadgetStub, { formats, sheetIds = null }: { formats: boolean; sheetIds?: string[] | null }): Promise<ExportWorkbook> {
  for (let attempt = 0; ; ++attempt) {
    const strict = attempt < 2;
    const structure = await gadget.getStructure();
    disposeResult(structure);
    const ids = [...new Set((sheetIds || structure.sheetOrder).map(String))].filter((id) => structure.sheets[id]);
    const cells = new Map<string, ExportCells>(), fmts: CellFmt[] = [], fmtIndex = new Map<string, number>();
    let consistent = true, total = 0, text = 0;
    for (const id of ids) {
      const data = new ExportCells();
      let after: string | null = "";
      do {
        const page = await gadget.exportPage({ sheetId: id, after, formats });
        // Disposing a result releases its call, not the data already read out of it.
        disposeResult(page);
        if (page.revision !== structure.revision) { consistent = false; if (strict) break; }
        if (page.missing) break;
        total += page.refs.length;
        for (const value of page.values) text += value.length;
        if (total > MAX_EXPORT_CELLS || text > MAX_EXPORT_TEXT) throw new Error(`This workbook has more than ${total > MAX_EXPORT_CELLS ? MAX_EXPORT_CELLS.toLocaleString("en-US") + " cells" : MAX_EXPORT_TEXT.toLocaleString("en-US") + " characters of text"}, more than can be exported at once. Split it into smaller workbooks to export it.`);
        // A page asked for with formats carries `styles` and `fmts`.
        const local = formats ? (page.fmts as CellFmt[]).map((fmt) => {
          const key = JSON.stringify(fmt);
          let index = fmtIndex.get(key);
          if (index === undefined) { index = fmts.length; fmtIndex.set(key, index); fmts.push(fmt); }
          return index;
        }) : [];
        for (let i = 0; i < page.refs.length; ++i) {
          const position = parseCsvCellRef(page.refs[i]);
          if (!position) continue;
          const style = formats ? (page.styles as number[])[i] : -1;
          data.add(position.row, position.column, page.values[i], style >= 0 ? local[style] : -1);
        }
        after = page.next;
      } while (after != null);
      if (!consistent && strict) break;
      data.sort();
      cells.set(id, data);
    }
    if (consistent || !strict) {
      return { revision: structure.revision, title: structure.title, sheetOrder: structure.sheetOrder, sheets: structure.sheets, cells, fmts };
    }
  }
}

// Formula results for exports: the grid's engine (lib/formula.ts) over the exported cells, which it
// reads through a { ref: { value } } view per sheet (indexed the first time a sheet is read).
// Results are worked out on demand and cached, so only what an export asks for is computed.
// A workbook whose formulas would take too long to work out (thousands of lookups over
// thousands of rows) stops after EXPORT_READ_BUDGET cell reads by the engine: that formula and
// later ones get EXPORT_UNKNOWN, so Excel gets them without a cached result (it recalculates on
// open) and CSV gets their text. Time can't be the measure: a Worker's clock stands still while
// it computes.
const EXPORT_READ_BUDGET = 60_000_000; // several seconds
export const EXPORT_UNKNOWN: Readonly<{ unknown: true }> = Object.freeze({ unknown: true });
/** A cell's value for an export: what the grid computes, or EXPORT_UNKNOWN for a formula past the budget. */
export type ExportValue = Scalar | typeof EXPORT_UNKNOWN;
export class ExportEvaluator {
  declare workbook: ExportWorkbook;
  declare indexes: Map<string, Map<string, number>>;
  declare limits: { work: number; budget: number };
  declare spent: boolean;
  declare results: Map<string, Scalar>;
  declare engine: Engine;
  constructor(workbook: ExportWorkbook) {
    this.workbook = workbook;
    this.indexes = new Map();
    this.limits = { work: 0, budget: EXPORT_READ_BUDGET };
    this.spent = false;
    this.results = new Map(); // what the engine worked out before the budget ran out
    const order = workbook.sheetOrder.filter((id) => workbook.sheets[id]), sheets: Record<string, { name: string }> = {}, cells: Record<string, Record<string, EngineCell | undefined>> = {};
    for (const id of order) { sheets[id] = { name: workbook.sheets[id].name }; cells[id] = this.view(id); }
    this.engine = makeEngine({ sheetOrder: order, sheets, cells }, this.limits);
  }
  view(id: string): Record<string, EngineCell | undefined> {
    return new Proxy<Record<string, EngineCell | undefined>>({}, {
      get: (_, ref) => {
        if (typeof ref !== "string") return undefined;
        const i = this.index(id).get(ref);
        return i === undefined ? undefined : { value: this.cellsOf(id).values[i] };
      },
    });
  }
  // A sheet's cells; only asked for sheets the workbook read (an index into them exists).
  cellsOf(id: string): ExportCells { return this.workbook.cells.get(id) as ExportCells; }
  index(id: string): Map<string, number> {
    let index = this.indexes.get(id);
    if (!index) {
      index = new Map();
      const data = this.workbook.cells.get(id);
      if (data) for (let i = 0; i < data.size; ++i) index.set(rcToRef(data.rows[i], data.cols[i]), i);
      this.indexes.set(id, index);
    }
    return index;
  }
  // The cell's value as the grid computes it (0-based row and column).
  // EXPORT_UNKNOWN for a formula once the budget is spent.
  value(sheetId: string, row: number, column: number): ExportValue {
    if (!this.workbook.cells.has(sheetId)) return null;
    const ref = rcToRef(row, column), key = sheetId + "!" + ref;
    if (this.results.has(key)) return this.results.get(key) as Scalar;
    const value = this.compute(sheetId, ref);
    if (value !== EXPORT_UNKNOWN) this.results.set(key, value as Scalar);
    return value;
  }
  compute(sheetId: string, ref: string): ExportValue {
    if (this.spent) {
      const i = this.index(sheetId).get(ref);
      if (i !== undefined && this.cellsOf(sheetId).values[i][0] === "=") return EXPORT_UNKNOWN;
      // A literal reads only itself.
      this.limits.budget = Infinity;
      try { return this.engine.computeRef(sheetId, ref); } finally { this.limits.budget = 0; }
    }
    try { return this.engine.computeRef(sheetId, ref); }
    catch (e) {
      if (!(e instanceof EvaluationBudget)) throw e;
      this.spent = true; this.limits.budget = 0;
      return this.compute(sheetId, ref);
    }
  }
  // The cell's text as the grid shows it (a formula's own text when its value is unknown).
  display(sheetId: string, row: number, column: number, fmt: CellFmt | null): string {
    const value = this.value(sheetId, row, column);
    // Only a stored formula is ever unknown, so the cell is in the index.
    if (value === EXPORT_UNKNOWN) return this.cellsOf(sheetId).values[this.index(sheetId).get(rcToRef(row, column)) as number];
    return displayValue(value as Scalar, fmt).text;
  }
}
// The grid's filter token for a computed value (client.js filterToken).
export function computedFilterToken(value: Scalar): string {
  if (isErr(value)) return "e:" + value.value;
  if (value == null || value === "") return "z:";
  if (typeof value === "number") return "n:" + String(value);
  if (typeof value === "boolean") return "b:" + (value ? "1" : "0");
  return "s:" + String(value instanceof HyperlinkValue ? value.label : value);
}

export function parseCsvCellRef(ref: string): { row: number; column: number } | null {
  const match = /^([A-Z]+)([1-9]\d*)$/.exec(ref);
  if (!match) return null;
  let column = 0;
  for (const char of match[1]) column = column * 26 + char.charCodeAt(0) - 64;
  return { row: Number(match[2]) - 1, column: column - 1 };
}

// Encodes a string generator into ~64 KiB chunks, generated lazily as the archive reaches it.
const TEXT_CHUNK_SIZE = 64 * 1024;
const textEncoder = new TextEncoder();
export function textStream(generator: Generator<string>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const parts: string[] = [];
      let length = 0;
      while (length < TEXT_CHUNK_SIZE) {
        const result = generator.next();
        if (result.done) {
          if (parts.length) controller.enqueue(textEncoder.encode(parts.join("")));
          controller.close();
          return;
        }
        parts.push(result.value);
        length += result.value.length;
      }
      controller.enqueue(textEncoder.encode(parts.join("")));
    },
    cancel(reason) { generator.return(reason); },
  }, { highWaterMark: 0 });
}
