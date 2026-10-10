/**
 * Builders for Google Sheets responses in the shape Google returns them, and what a scratch
 * spreadsheet showed the Sheets API doing, as constants the tests pin.
 */

import type { Rect } from "../src/sheets-model";
import type { SpreadsheetCellValue } from "../src/sheets-read-types";
import { cellKey } from "../src/sheets-plan";
import { gridOf, type Grid, type SheetMeta } from "../src/sheets-simulation";
import type { SheetCellInput } from "../src/sheets-types";

/** A sheet of `rowCount` by `columnCount` cells, 20 by 6 unless given. */
export function sheet(id: number, title: string, fields: Partial<SheetMeta> = {}): SheetMeta {
  return { id, title, index: id, rowCount: 20, columnCount: 6, ...fields };
}

/**
 * A grid of `sheets` as Google holds them, with what `cells` enters, keyed `sheetId:row:column`
 * by zero-based position, as entered outside a replay.
 */
export function grid(sheets: SheetMeta[], cells: Record<string, SheetCellInput> = {}): Grid {
  let base = gridOf({ sheets });
  return {
    ...base,
    cells: new Map(Object.entries(cells).map(([key, input]) => {
      let [sheetId, row, column] = key.split(":");
      return [cellKey(Number(sheetId), `b${row}`, `b${column}`), { input, at: 0, by: 0 }];
    })),
  };
}

/** A zero-based rectangle from its first row and column and its size. */
export function rect(startRow: number, startColumn: number, rows = 1, columns = 1): Rect {
  return { startRow, endRow: startRow + rows, startColumn, endColumn: startColumn + columns };
}

/** Sheets' `GridRange`. */
export type FixtureGridRange = {
  sheetId: number;
  startRowIndex?: number;
  endRowIndex?: number;
  startColumnIndex?: number;
  endColumnIndex?: number;
};

/** A protected range as `sheets(protectedRanges)` returns it, editors' addresses included. */
export function protectedRange(
  protectedRangeId: number,
  range: FixtureGridRange,
  fields: { requestingUserCanEdit?: boolean; warningOnly?: boolean; unprotectedRanges?: FixtureGridRange[] } = {},
) {
  return {
    protectedRangeId,
    range,
    requestingUserCanEdit: true,
    editors: { users: ["owner@example.com", "colleague@example.com"] },
    ...fields,
  };
}

/** `spreadsheets.get` for `sheets`, each with the protected ranges it is given. */
export function spreadsheetMetadata(
  spreadsheetId: string,
  title: string,
  sheets: (SheetMeta & { protectedRanges?: ReturnType<typeof protectedRange>[] })[],
) {
  return {
    spreadsheetId,
    properties: { title, locale: "en_US", timeZone: "America/New_York" },
    sheets: sheets.map(({ id, title: sheetTitle, index, rowCount, columnCount, hidden, protectedRanges }) => ({
      properties: {
        sheetId: id, title: sheetTitle, index, ...(hidden ? { hidden } : {}),
        gridProperties: { rowCount, columnCount },
      },
      ...(protectedRanges ? { protectedRanges } : {}),
    })),
  };
}

/** A cell as each value mode reads it. */
export type ModeReads = { formula: SpreadsheetCellValue; raw: SpreadsheetCellValue; formatted: SpreadsheetCellValue };

/** A `ValueRange` as `mode` reads `rows`, trailing blanks trimmed as Google trims them. */
export function valueRange(range: string, rows: ModeReads[][], mode: keyof ModeReads) {
  let values = rows.map(row => row.map(cell => cell[mode] ?? "")).map(row => {
    let end = row.length;
    while (end > 0 && row[end - 1] === "") end--;
    return row.slice(0, end);
  });
  while (values.length > 0 && values.at(-1)!.length === 0) values.pop();
  return values.length > 0 ? { range, majorDimension: "ROWS", values } : { range, majorDimension: "ROWS" };
}

/**
 * `values:batchGetByDataFilter`'s answer: not in the order asked, and each range's data filter
 * echoed with its zero fields left out.
 */
export function byDataFilter(ranges: { gridRange: FixtureGridRange; range: string; values?: unknown[][] }[]) {
  let echoed = (gridRange: FixtureGridRange) =>
    Object.fromEntries(Object.entries(gridRange).filter(([, value]) => value !== 0));
  return {
    valueRanges: ranges.toReversed().map(({ gridRange, range, values }) => ({
      valueRange: { range, majorDimension: "ROWS", ...(values ? { values } : {}) },
      dataFilters: [{ gridRange: echoed(gridRange) }],
    })),
  };
}

/**
 * Typed `updateCells` input in a bold, currency-formatted row, as each mode read it back. `input`
 * is what an agent passes to send it; text starting `=` cannot be sent as text, so that case has
 * none.
 */
export const TYPED_INPUT: {
  input?: SheetCellInput; sent: Record<string, unknown>; reads: ModeReads;
}[] = [
  { input: "123", sent: { stringValue: "123" }, reads: { formula: "123", raw: "123", formatted: "123" } },
  { sent: { stringValue: "=1" }, reads: { formula: "=1", raw: "=1", formatted: "=1" } },
  { input: "=1+1", sent: { formulaValue: "=1+1" }, reads: { formula: "=1+1", raw: 2, formatted: "$2.00" } },
  { input: 5, sent: { numberValue: 5 }, reads: { formula: 5, raw: 5, formatted: "$5.00" } },
  { input: true, sent: { boolValue: true }, reads: { formula: true, raw: true, formatted: "TRUE" } },
  {
    input: "07/04/2026", sent: { stringValue: "07/04/2026" },
    reads: { formula: "07/04/2026", raw: "07/04/2026", formatted: "07/04/2026" },
  },
];

/** How Google wrote each sheet title before `!` in the ranges it returned. */
export const SHEET_TITLE_QUOTING: Record<string, string> = {
  "Sales": "Sales",
  "Sheet_1": "Sheet_1",
  "TRUE": "TRUE",
  "x.y": "x.y",
  "Sales2": "Sales2",
  "Probe Tab": "'Probe Tab'",
  "A1": "'A1'",
  "ABC1234": "'ABC1234'",
  "R1C1": "'R1C1'",
  "2026": "'2026'",
  "Ünï": "'Ünï'",
  "a-b": "'a-b'",
  "It's": "'It''s'",
};

/** The ranges Google returned for ranges read from a 20-by-6 sheet titled "Sales". */
export const CANONICAL_RANGES: [read: string, returned: string][] = [
  ["sales!a10:b10", "Sales!A10:B10"],
  ["Sales!$B$3", "Sales!B3"],
];

/** The sheets of the spreadsheet `FORMULA_CANONICALIZATION` was entered in. */
export const FORMULA_SHEETS = ["Sales", "Rw", "It's"];

/** Formulas as entered with `formulaValue`, and as Google stored them. */
export const FORMULA_CANONICALIZATION: [entered: string, stored: string][] = [
  ["=sum( sales!a3:a3 )", "=sum( Sales!A3 )"],
  ["='Sales'!B3:a2", "=Sales!A2:B3"],
  ["=sales!$d$3 + 1", "=Sales!$D$3 + 1"],
  ["=SUM(  A1 ,  'It''s'!a1:a1  )", "=SUM(  A1 ,  'It''s'!A1  )"],
  ["=if(true,\"a3:a3\",'It''s'!A1)", "=if(true,\"a3:a3\",'It''s'!A1)"],
  ["=Sales!3:3", "=Sales!3:3"],
  ["=Rw!B3:A2", "=Rw!A2:B3"],
  ["=SUM(Rw!$A3:$A3)", "=SUM(Rw!$A3)"],
  ["='Rw'!A3", "=Rw!A3"],
  ["=sum(a1:a1)+ 1", "=sum(A1)+ 1"],
];

/** A formula whose whitespace Google dropped later, with no write to its sheet. */
export const WHITESPACE_DRIFT: [stored: string, later: string] = ["=Sales!$D$3 + 1", "=Sales!$D$3+1"];

/** What Google answered requests changing a spreadsheet's structure with, refusing them. */
export const STRUCTURE_REFUSALS = {
  negativeSheetId: "Sheet id must be non-negative.",
  sheetIdTaken: (sheetId: number) => `Sheet with id ${sheetId} already exists.`,
  titleTaken: (title: string) => `A sheet with the name "${title}" already exists. Please enter another name.`,
  titleTooLong: "The sheet name cannot be greater than 100 characters.",
  lastVisibleSheet: "You can't remove all the visible sheets in a document.",
  everyRow: (request: number) => `Invalid requests[${request}].deleteDimension: You can't delete all the rows on the sheet.`,
  everyColumn: (request: number) =>
    `Invalid requests[${request}].deleteDimension: You can't delete all the columns on the sheet.`,
  insertAtEnd: (size: number) =>
    `range.startIndex must be less than the grid size (${size}) if inheritFromBefore is false.`,
  insertPastEnd: (size: number) => `range.startIndex is larger than current grid size (${size})`,
};

/** The size Google gives a sheet added with none. */
export const NEW_SHEET_SIZE = { rowCount: 1000, columnCount: 26 };
