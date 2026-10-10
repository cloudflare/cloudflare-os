/**
 * A1 ranges and cells as Google Sheets names them, and what a cell holding entered input reads as.
 *
 * Positions are zero-based and ranges half-open, as Google's `GridRange` indices are. A1 names are
 * written in Google's canonical form: column letters upper case, a single cell named alone, and a
 * sheet title bare only where Google leaves it bare.
 */

import type { SpreadsheetCellValue, SpreadsheetValueMode } from "./sheets-read-types";
import type { SheetCellInput } from "./sheets-types";

/** The longest A1 range accepted. */
export const MAX_RANGE_LENGTH = 500;

/** A bounded A1 range, with its size in rows and columns. */
export type ValidatedRange = {
  range: string;
  rows: number;
  columns: number;
};

/** A rectangle of cells: zero-based rows and columns, each end exclusive. */
export type Rect = { startRow: number; endRow: number; startColumn: number; endColumn: number };

// A quoted sheet title escapes an apostrophe as two apostrophes. Requiring explicit cell
// coordinates keeps reads bounded; named, whole-row, and whole-column ranges are rejected.
const BOUNDED_RANGE =
  /^(?:('(?:[^']|'')+'|[^'!]+)!)?\$?([A-Za-z]{1,3})\$?([1-9]\d*)(?::\$?([A-Za-z]{1,3})\$?([1-9]\d*))?$/;

// Titles Google leaves unquoted in a range: name-like, and not readable as a cell or R1C1 name.
const BARE_TITLE = /^[A-Za-z_][A-Za-z0-9_.]*$/;
const CELL_LIKE_TITLE = /^[A-Za-z]{1,3}[0-9]+$/;
const R1C1_LIKE_TITLE = /^[Rr][0-9]*[Cc][0-9]*$/;

/** The one-based number of a column's letters: A is 1, AA is 27. */
export function columnNumber(column: string): number {
  let result = 0;
  for (let character of column.toUpperCase()) {
    result = result * 26 + character.charCodeAt(0) - 64;
  }
  return result;
}

/** The letters of a zero-based column: 0 is A, 26 is AA. */
export function columnLetters(column: number): string {
  let letters = "";
  for (let n = column + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    letters = String.fromCharCode(65 + (n - 1) % 26) + letters;
  }
  return letters;
}

function matchRange(range: string): { sheet?: string; rect: Rect; rows: number; columns: number } {
  if (typeof range !== "string" || range.length === 0 || range.length > MAX_RANGE_LENGTH) {
    throw new Error(`A1 ranges must contain between 1 and ${MAX_RANGE_LENGTH} characters.`);
  }

  let match = range.match(BOUNDED_RANGE);
  if (!match) {
    throw new Error(
      `Invalid or unbounded A1 range "${range}". Use a bounded range such as ` +
      "`'Sheet name'!A1:F200`.",
    );
  }

  let startColumn = columnNumber(match[2]);
  let startRow = Number(match[3]);
  let endColumn = columnNumber(match[4] ?? match[2]);
  let endRow = Number(match[5] ?? match[3]);
  if (endColumn < startColumn || endRow < startRow) {
    throw new Error(`A1 range "${range}" must run from its top-left cell to its bottom-right cell.`);
  }

  let rows = endRow - startRow + 1;
  let columns = endColumn - startColumn + 1;
  if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(columns)) {
    throw new Error(`A1 range "${range}" is too large.`);
  }
  let quoted = match[1];
  let sheet = quoted === undefined ? undefined
    : quoted.startsWith("'") ? quoted.slice(1, -1).replaceAll("''", "'") : quoted;
  return {
    ...(sheet === undefined ? {} : { sheet }),
    rect: { startRow: startRow - 1, endRow, startColumn: startColumn - 1, endColumn },
    rows,
    columns,
  };
}

/** Checks that `range` is a bounded A1 range, and measures it. Throws `Error`. */
export function validateRange(range: string): ValidatedRange {
  let { rows, columns } = matchRange(range);
  return { range, rows, columns };
}

/**
 * The sheet a bounded A1 range names (its title, unquoted), if it names one, and its cells.
 * Throws `Error`.
 */
export function parseRange(range: string): { sheet?: string; rect: Rect } {
  let { sheet, rect } = matchRange(range);
  if (!Number.isSafeInteger(rect.endRow)) throw new Error(`A1 range "${range}" is too large.`);
  return { ...(sheet === undefined ? {} : { sheet }), rect };
}

/** A sheet title as Google writes it before `!` in a range: quoted unless it reads as a name. */
export function quoteSheetTitle(title: string): string {
  if (BARE_TITLE.test(title) && !CELL_LIKE_TITLE.test(title) && !R1C1_LIKE_TITLE.test(title)) {
    return title;
  }
  return `'${title.replaceAll("'", "''")}'`;
}

/** The A1 name of a zero-based cell, such as `B3`. */
export function cellName(row: number, column: number): string {
  return `${columnLetters(column)}${row + 1}`;
}

/** The cells of `rect` in A1 notation, with no sheet: `B3` for one cell, else `A1:C3`. */
export function rectName(rect: Rect): string {
  let start = cellName(rect.startRow, rect.startColumn);
  if (rect.endRow - rect.startRow === 1 && rect.endColumn - rect.startColumn === 1) return start;
  return `${start}:${cellName(rect.endRow - 1, rect.endColumn - 1)}`;
}

/** A range as Google returns it: `Sales!B3` for one cell, else `Sales!A1:C3`. */
export function a1Of(title: string, rect: Rect): string {
  return `${quoteSheetTitle(title)}!${rectName(rect)}`;
}

/** The number of cells in `rect`. */
export function cellCount(rect: Rect): number {
  return (rect.endRow - rect.startRow) * (rect.endColumn - rect.startColumn);
}

/** The cells two rectangles share, if any. */
export function intersection(a: Rect, b: Rect): Rect | undefined {
  let rect = {
    startRow: Math.max(a.startRow, b.startRow),
    endRow: Math.min(a.endRow, b.endRow),
    startColumn: Math.max(a.startColumn, b.startColumn),
    endColumn: Math.min(a.endColumn, b.endColumn),
  };
  return rect.startRow < rect.endRow && rect.startColumn < rect.endColumn ? rect : undefined;
}

/**
 * The sheet a range names: the one whose title equals `name` ignoring case, as Google matches
 * them. With no name, the first visible sheet, which is the one Google reads.
 */
export function findSheet<S extends { title: string; index: number; hidden?: boolean }>(
  sheets: readonly S[], name?: string,
): S | undefined {
  if (name === undefined) {
    return sheets.filter(sheet => !sheet.hidden).toSorted((a, b) => a.index - b.index)[0];
  }
  let wanted = name.toLowerCase();
  return sheets.find(sheet => sheet.title.toLowerCase() === wanted);
}

/** Whether entered input is a formula: text starting with `=`. */
export function isFormula(input: SheetCellInput): input is string {
  return typeof input === "string" && input.startsWith("=");
}

/**
 * What a cell holding `input` reads as in `mode`, or null and pending when only Google can work it
 * out. Formula reads show input as entered. Raw reads show literal values, but not a formula's
 * result. Formatted reads show text, but not numbers, booleans or results, whose display depends
 * on the cell's number format and the spreadsheet's locale.
 */
export function shownValue(
  input: SheetCellInput, mode: SpreadsheetValueMode = "formatted",
): { value: SpreadsheetCellValue; pending: boolean } {
  let known = mode === "formula" ||
    (mode === "raw" ? !isFormula(input) : input === null || (typeof input === "string" && !isFormula(input)));
  return known ? { value: input, pending: false } : { value: null, pending: true };
}
