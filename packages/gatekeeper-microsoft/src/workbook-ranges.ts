// A1-style ranges on one worksheet ("B2:D4", "A10"), for checking what `updateCells` writes and for
// showing pending cell changes in reads of the workbook before they are approved.

import type { CellValue, WorksheetContent } from "./types";

/** A rectangle of cells, 0-based and inclusive. */
export type CellRange = { firstRow: number; firstColumn: number; lastRow: number; lastColumn: number };

// Excel's grid: 1,048,576 rows by 16,384 columns (XFD).
const MAX_ROWS = 1_048_576;
const MAX_COLUMNS = 16_384;

const CELL = /^\$?([A-Za-z]{1,3})\$?([0-9]{1,7})$/;

/** A column's 0-based index from its letters: 0 for "A", 26 for "AA". */
export function columnIndex(letters: string): number {
  let index = 0;
  for (const char of letters.toUpperCase()) index = index * 26 + char.charCodeAt(0) - 64;
  return index - 1;
}

/** A column's letters from its 0-based index. */
export function columnLetters(index: number): string {
  let letters = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) letters = String.fromCharCode(65 + (n - 1) % 26) + letters;
  return letters;
}

function parseCell(text: string): { row: number; column: number } | null {
  const match = CELL.exec(text.trim());
  if (!match) return null;
  const column = columnIndex(match[1]!);
  const row = Number(match[2]) - 1;
  return row >= 0 && row < MAX_ROWS && column < MAX_COLUMNS ? { row, column } : null;
}

/**
 * Parses a range on one worksheet. Throws an error the agent can act on for anything else, including
 * a sheet-qualified range, which `updateCells` takes as a separate argument.
 */
export function parseRange(address: string): CellRange {
  if (typeof address !== "string") throw new Error("The range must be text like \"B2:D4\".");
  if (address.includes("!")) {
    throw new Error(`Pass the worksheet separately from the range: "${address.slice(address.lastIndexOf("!") + 1)}", not "${address}".`);
  }
  const [start, end, extra] = address.split(":");
  const first = parseCell(start ?? "");
  const last = end === undefined ? first : parseCell(end);
  if (extra !== undefined || first === null || last === null) {
    throw new Error(`"${address}" isn't a range of cells. Use one like "B2:D4", or "A10" for one cell.`);
  }
  return {
    firstRow: Math.min(first.row, last.row), firstColumn: Math.min(first.column, last.column),
    lastRow: Math.max(first.row, last.row), lastColumn: Math.max(first.column, last.column),
  };
}

/** The range as Excel writes it: "B2:D4", or "A10" for one cell. */
export function formatRange(range: CellRange): string {
  const first = `${columnLetters(range.firstColumn)}${range.firstRow + 1}`;
  const last = `${columnLetters(range.lastColumn)}${range.lastRow + 1}`;
  return first === last ? first : `${first}:${last}`;
}

/** How many rows a range spans. */
export function rangeRows(range: CellRange): number {
  return range.lastRow - range.firstRow + 1;
}

/** How many columns a range spans. */
export function rangeColumns(range: CellRange): number {
  return range.lastColumn - range.firstColumn + 1;
}

/** Checks that `values` fills `range` exactly: one row per row, one value per column. */
export function checkShape(range: CellRange, values: readonly (readonly CellValue[])[]): void {
  const rows = rangeRows(range);
  const columns = rangeColumns(range);
  const size = `${formatRange(range)} is ${rows} row${rows === 1 ? "" : "s"} by ${columns} column${columns === 1 ? "" : "s"}`;
  if (!Array.isArray(values) || values.length !== rows) {
    throw new Error(`${size}, but values has ${Array.isArray(values) ? values.length : 0} row${Array.isArray(values) && values.length === 1 ? "" : "s"}.`);
  }
  values.forEach((row, index) => {
    if (!Array.isArray(row) || row.length !== columns) {
      throw new Error(`${size}, but row ${index + 1} of values has ${Array.isArray(row) ? row.length : 0} value${Array.isArray(row) && row.length === 1 ? "" : "s"}.`);
    }
  });
}

/**
 * A worksheet read with pending cell changes applied, as Excel will show it once they are
 * approved. A change outside the range read grows it, within `maxCells`: one that would grow it
 * past the read's budget is left out and the sheet reported truncated, as a used range too large
 * to read is, so a change far from the rest can't make a read allocate the gap. A read of a range
 * the agent asked for (`within`) never grows: only the changed cells inside it show. A formula is
 * shown as its text in `values` too, since nothing has computed it yet.
 */
export function withPendingCells(sheet: WorksheetContent, changes: readonly { address: string; values: CellValue[][] }[],
                                 { maxCells = Infinity, within = false }: { maxCells?: number; within?: boolean } = {}): WorksheetContent {
  if (changes.length === 0) return sheet;
  const bang = sheet.address.lastIndexOf("!");
  const prefix = bang >= 0 ? sheet.address.slice(0, bang + 1) : "";
  const read = sheet.values.length === 0 ? undefined : parseRange(sheet.address.slice(bang + 1));
  if (within && read === undefined) return sheet;
  let range = read;
  let truncated = sheet.truncated;
  const shown: { address: string; values: CellValue[][] }[] = [];
  for (const change of changes) {
    const changed = parseRange(change.address);
    if (within) {
      if (intersects(changed, read!)) shown.push(change);
      continue;
    }
    const union = range === undefined ? changed : {
      firstRow: Math.min(range.firstRow, changed.firstRow), firstColumn: Math.min(range.firstColumn, changed.firstColumn),
      lastRow: Math.max(range.lastRow, changed.lastRow), lastColumn: Math.max(range.lastColumn, changed.lastColumn),
    };
    if (rangeRows(union) * rangeColumns(union) > maxCells) {
      truncated = true;
      continue;
    }
    range = union;
    shown.push(change);
  }
  if (range === undefined) return { ...sheet, truncated };
  const grown = range;
  const grid = (source: CellValue[][]): CellValue[][] => Array.from({ length: rangeRows(grown) }, (_, row) =>
    Array.from({ length: rangeColumns(grown) }, (_, column) => {
      if (read === undefined) return null;
      const sourceRow = grown.firstRow + row - read.firstRow;
      const sourceColumn = grown.firstColumn + column - read.firstColumn;
      return source[sourceRow]?.[sourceColumn] ?? null;
    }));
  const values = grid(sheet.values);
  const formulas = grid(sheet.formulas);
  for (const change of shown) {
    const changed = parseRange(change.address);
    change.values.forEach((row, rowOffset) => row.forEach((value, columnOffset) => {
      const r = changed.firstRow + rowOffset - grown.firstRow;
      const c = changed.firstColumn + columnOffset - grown.firstColumn;
      // Only inside the range shown: a change overlapping an asked-for range reaches past it.
      if (r < 0 || c < 0 || r >= values.length || c >= values[r]!.length) return;
      values[r]![c] = value;
      formulas[r]![c] = value;
    }));
  }
  return { ...sheet, address: prefix + formatRange(grown), values, formulas, truncated };
}

/** Whether two ranges share a cell. */
function intersects(a: CellRange, b: CellRange): boolean {
  return a.firstRow <= b.lastRow && b.firstRow <= a.lastRow && a.firstColumn <= b.lastColumn && b.firstColumn <= a.lastColumn;
}
