import { HyperlinkValue, type Scalar, colToLetter, isErr, parseRef, rcToRef } from "./formula.ts";
import type { CellFmt, CellMap, PivotAggregate, PivotSettings, SheetMeta } from "./protocol.ts";

// ---------------------------------------------------------------------------
// Pivot tables: what a pivot sheet holds, worked out from its source. The grid rebuilds a pivot
// whenever its source may have changed and saves the result; an export rebuilds every pivot from
// the cells it read, so neither waits on the other. Values come through `compute`, the caller's
// engine, so a source formula (even one reading another pivot) counts as it shows.
// ---------------------------------------------------------------------------

/** A source cell's computed value (zero-based row and column). */
export type PivotCompute = (sheetId: string, row: number, column: number) => Scalar;
/** A pivot source column, named by its header (made unique). */
export interface PivotField { name: string; column: number }
/** What a pivot sheet holds: its cells and the size it needs. */
export interface PivotOutput { cells: CellMap; rows: number; cols: number }
/** A running summary of one pivot cell's values. */
export interface AggregateState { sum: number; count: number; numericCount: number; min: number; max: number }

/** The most cells a pivot lays out; past it the pivot says it is too large. */
export const MAX_PIVOT_CELLS = 100000;
// Mirrors the server's bound on chart and pivot ranges.
const MAX_RANGE_CELLS = 200000;

/** How a source value reads as a field name, row or column key, or filter value. */
export function pivotDisplay(value: Scalar): string { return value == null || value === "" ? "(Blank)" : (isErr(value) ? value.value : String(value)); }

/** Text stored so that it reads back as itself, not as a formula, number or boolean. */
export function literalText(text: string): string {
  const s = text.trim();
  return /^[=']/.test(text) || /^(true|false)$/i.test(s) || (/^[-+]?\$?[\d,]*\.?\d+%?$/.test(s) && /\d/.test(s)) ? "'" + text : text;
}
/** What to store so a cell holds this computed value as a constant. */
export function storedValueOf(value: Scalar): string {
  if (value == null) return "";
  // The grid reads `1e-7` as text, so a very small or large number is written out in full.
  if (typeof value === "number") return Number.isFinite(value) && /e/i.test(String(value)) ? value.toLocaleString("en-US", { useGrouping: false, maximumSignificantDigits: 17 }) : String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return literalText(isErr(value) ? value.value : value instanceof HyperlinkValue ? value.label : value);
}

// The source range clipped to its sheet, as the server stores it (nothing past the cell cap).
function sourceArea(text: string, sheet: SheetMeta | undefined): { r1: number; c1: number; r2: number; c2: number } | null {
  const match = /^([A-Z]+[1-9]\d*)(?::([A-Z]+[1-9]\d*))?$/.exec(String(text || "").trim().toUpperCase());
  const a = match && parseRef(match[1]), b = match && parseRef(match[2] || match[1]);
  if (!a || !b || !sheet) return null;
  const range = { r1: Math.min(a.r, b.r), c1: Math.min(a.c, b.c), r2: Math.min(Math.max(a.r, b.r), sheet.rows - 1), c2: Math.min(Math.max(a.c, b.c), sheet.cols - 1) };
  if (range.r1 > range.r2 || range.c1 > range.c2 || (range.r2 - range.r1 + 1) * (range.c2 - range.c1 + 1) > MAX_RANGE_CELLS) return null;
  return range;
}

/** The source's columns, named by their header row; `source` is the source sheet's metadata. */
export function pivotFields(pivot: PivotSettings, source: SheetMeta | undefined, compute: PivotCompute): PivotField[] {
  const range = sourceArea(pivot.sourceRange, source); if (!range) return [];
  const fields: PivotField[] = [], used = new Set<string>();
  for (let column = range.c1; column <= range.c2; column++) {
    let name = pivotDisplay(compute(pivot.sourceSheetId, range.r1, column)).slice(0, 8192);
    if (name === "(Blank)") name = `Column ${colToLetter(column)}`;
    // Generated names are reserved too, so headers `A`, `A (2)`, `A` stay distinct.
    let unique = name; for (let count = 2; used.has(unique); count++) unique = `${name} (${count})`;
    used.add(unique);
    fields.push({ name: unique, column });
  }
  return fields;
}

export function aggregateState(): AggregateState { return { sum: 0, count: 0, numericCount: 0, min: Infinity, max: -Infinity }; }
export function addAggregate(state: AggregateState, value: Scalar) {
  // A blank isn't a value: it counts as nothing, not as 0.
  if (value == null || value === "" || isErr(value)) return;
  state.count++;
  // As in Excel, only numbers (and text that reads as one) are summed: not booleans or spaces.
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  if (Number.isFinite(number)) { state.sum += number; state.numericCount++; state.min = Math.min(state.min, number); state.max = Math.max(state.max, number); }
}
export function finishAggregate(state: AggregateState, kind: PivotAggregate): number {
  if (kind === "count") return state.count;
  if (!state.numericCount) return 0;
  if (kind === "average") return state.sum / state.numericCount;
  if (kind === "min") return state.min;
  if (kind === "max") return state.max;
  return state.sum;
}

/** The pivot's cells and size, from its source sheet (`source`) as `compute` reads it. */
export function buildPivotOutput(pivot: PivotSettings, source: SheetMeta | undefined, compute: PivotCompute): PivotOutput {
  const range = sourceArea(pivot.sourceRange, source), fields = pivotFields(pivot, source, compute);
  if (!range || !fields.length) return { cells: {}, rows: 20, cols: 8 };
  const byName = new Map(fields.map((field) => [field.name, field.column]));
  const rowColumn = byName.get(pivot.rowField), columnColumn = byName.get(pivot.columnField), valueColumn = byName.get(pivot.valueField);
  const missingField = [pivot.rowField, pivot.columnField, pivot.valueField, pivot.filterField].find((field) => field && !byName.has(field));
  if (missingField) return { cells: { A1: { value: `Pivot field not found: ${missingField.slice(0, 200)}. Choose a current source field.`, fmt: { b: true }, version: 1 } }, rows: 20, cols: 8 };
  const records: { row: string; column: string; value: Scalar }[] = [];
  for (let row = range.r1 + 1; row <= range.r2; row++) {
    if (pivot.filterField) {
      const filterColumn = byName.get(pivot.filterField);
      // `filterValue`: the single value older pivots stored.
      const legacy = (pivot as PivotSettings & { filterValue?: string }).filterValue;
      const selectedValues = pivot.filterValues || (legacy ? [legacy] : []);
      if (filterColumn != null && selectedValues.length && !selectedValues.includes(pivotDisplay(compute(pivot.sourceSheetId, row, filterColumn)))) continue;
    }
    records.push({
      row: rowColumn == null ? "Values" : pivotDisplay(compute(pivot.sourceSheetId, row, rowColumn)),
      column: columnColumn == null ? (pivot.valueField || "Value") : pivotDisplay(compute(pivot.sourceSheetId, row, columnColumn)),
      value: valueColumn == null ? 1 : compute(pivot.sourceSheetId, row, valueColumn),
    });
  }
  // A fixed locale, so the grid and a server export order them alike.
  const rowKeys = [...new Set(records.map((record) => record.row))].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  const columnKeys = [...new Set(records.map((record) => record.column))].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  // The output is every row value × every column value plus headers and totals; past the cell
  // cap or the sheet's limits it can't be laid out, so the pivot says so instead of freezing.
  const outputRows = rowKeys.length + 2, outputColumns = columnKeys.length + 2;
  if (outputRows * outputColumns > MAX_PIVOT_CELLS || outputRows > 50000 || outputColumns > 702) {
    return { cells: { A1: { value: `Pivot table too large: ${rowKeys.length.toLocaleString()} row values × ${columnKeys.length.toLocaleString()} column values. Choose fields with fewer distinct values.`, fmt: { b: true, c: "#b42318" }, version: 1 } }, rows: 20, cols: 8 };
  }
  const states = new Map<string, AggregateState>(), rowTotals = new Map<string, AggregateState>(), columnTotals = new Map<string, AggregateState>(), grandTotal = aggregateState();
  const stateFor = (map: Map<string, AggregateState>, key: string) => { if (!map.has(key)) map.set(key, aggregateState()); return map.get(key) as AggregateState; };
  for (const record of records) {
    addAggregate(stateFor(states, record.row + "\u0000" + record.column), record.value);
    addAggregate(stateFor(rowTotals, record.row), record.value); addAggregate(stateFor(columnTotals, record.column), record.value); addAggregate(grandTotal, record.value);
  }
  const cells: CellMap = {}, put = (row: number, column: number, value: string | number, fmt: CellFmt | null = null) => { cells[rcToRef(row, column)] = { value: typeof value === "number" ? storedValueOf(value) : String(value ?? ""), fmt, version: 1 }; };
  const label = literalText;
  const headerFmt = { b: true, bg: "#e1632e", c: "#ffffff" };
  const rowHeaderFmt = { b: true, bg: "#fff7f2", c: "#3f332e" };
  const totalFmt = { b: true, bg: "#fde9dc", c: "#3f332e" };
  put(0, 0, label(pivot.rowField || "Rows"), headerFmt);
  columnKeys.forEach((key, index) => put(0, index + 1, label(key), headerFmt));
  if (pivot.showRowTotals !== false) put(0, columnKeys.length + 1, "Grand Total", totalFmt);
  rowKeys.forEach((rowKey, rowIndex) => {
    put(rowIndex + 1, 0, label(rowKey), rowHeaderFmt);
    columnKeys.forEach((columnKey, columnIndex) => put(rowIndex + 1, columnIndex + 1, finishAggregate(states.get(rowKey + "\u0000" + columnKey) || aggregateState(), pivot.aggregate), pivot.aggregate === "average" ? { nf: "number", d: 2 } : null));
    if (pivot.showRowTotals !== false) put(rowIndex + 1, columnKeys.length + 1, finishAggregate(rowTotals.get(rowKey) || aggregateState(), pivot.aggregate), totalFmt);
  });
  if (pivot.showColumnTotals !== false) {
    const totalRow = rowKeys.length + 1; put(totalRow, 0, "Grand Total", totalFmt);
    columnKeys.forEach((key, index) => put(totalRow, index + 1, finishAggregate(columnTotals.get(key) || aggregateState(), pivot.aggregate), totalFmt));
    if (pivot.showRowTotals !== false) put(totalRow, columnKeys.length + 1, finishAggregate(grandTotal, pivot.aggregate), totalFmt);
  }
  return { cells, rows: Math.min(50000, Math.max(20, rowKeys.length + 4)), cols: Math.min(702, Math.max(8, columnKeys.length + 3)) };
}

/** The column widths (px, by zero-based column) a pivot's cells want: wide enough for their text, within bounds. */
export function pivotColumnWidths(cells: CellMap): Record<number, number> {
  const widths: Record<number, number> = {};
  for (const [ref, cell] of Object.entries(cells)) {
    const position = parseRef(ref); if (!position) continue;
    const minimum = position.c === 0 ? 150 : 110;
    widths[position.c] = Math.max(widths[position.c] || minimum, Math.min(320, String(cell.value || "").length * 8 + 30));
  }
  return widths;
}

/** A pivot sheet's metadata once it holds `output`: grown to fit, its columns widened and its header row taller, as the grid lays it out. */
export function pivotSheetLayout(sheet: SheetMeta, output: PivotOutput): SheetMeta {
  return {
    ...sheet,
    rows: Math.max(sheet.rows, output.rows), cols: Math.max(sheet.cols, output.cols),
    colWidths: { ...sheet.colWidths, ...pivotColumnWidths(output.cells) },
    rowHeights: { ...sheet.rowHeights, 0: 30 },
  };
}
