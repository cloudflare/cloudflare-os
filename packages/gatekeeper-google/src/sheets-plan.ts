/**
 * `updateSheet()` changes: where each lands, their replay over a grid, the requests that make
 * them, and the digest of what they overwrite.
 *
 * Queueing, replay and apply all run `planSheet`, so the cells a read previews and the batch an
 * approval writes come from the same code. Values are sent typed, so Google parses nothing by
 * locale: text stays text, and only input starting with `=` is a formula.
 */

import { canonicalFormula, compactFormula } from "./sheets-formula";
import { MAX_CELL_LENGTH, type PreparedChange } from "./sheets-input";
import { cellName, findSheet, isFormula, type Rect } from "./sheets-model";
import type { Grid, PlannedChange, SheetMeta } from "./sheets-simulation";
import type { SheetCellInput } from "./sheets-types";
import { ChangeConflict } from "./slides-text";

function plural(count: number, noun: string): string {
  return `${count.toLocaleString("en-US")} ${noun}${count === 1 ? "" : "s"}`;
}

/** The key of a zero-based cell in `Grid.cells`. */
export function cellKey(sheetId: number, row: number, column: number): string {
  return `${sheetId}:${row}:${column}`;
}

// A cell of `rect` that lies outside `sheet`'s grid: past its last column if any is, else below it.
function outsideCell(sheet: SheetMeta, rect: Rect): string | undefined {
  if (rect.endColumn > sheet.columnCount) {
    return cellName(rect.startRow, Math.max(rect.startColumn, sheet.columnCount));
  }
  if (rect.endRow > sheet.rowCount) return cellName(Math.max(rect.startRow, sheet.rowCount), rect.startColumn);
  return undefined;
}

/**
 * Finds the sheet each change names in `grid`, and writes its formulas' references as Google
 * stores them. Throws `Error` for a sheet the spreadsheet has no tab for, or cells outside a
 * sheet's grid.
 */
export function resolveChanges(grid: Grid, prepared: readonly PreparedChange[]): PlannedChange[] {
  let titleOf = (name: string) => findSheet(grid.sheets, name)?.title;
  return prepared.map((change, i) => {
    let label = `Change ${i + 1} (${change.op})`;
    let sheet = findSheet(grid.sheets, change.sheet);
    if (!sheet) {
      throw new Error(`${label}: the spreadsheet has no sheet named "${change.sheet}". Call ` +
        "getSpreadsheet() for sheet titles.");
    }
    let outside = outsideCell(sheet, change.rect);
    if (outside !== undefined) {
      throw new Error(`${label}: "${sheet.title}" has ${plural(sheet.rowCount, "row")} and ` +
        `${plural(sheet.columnCount, "column")}, so ${outside} is outside it.`);
    }
    if (change.op === "clearRange") return { op: change.op, sheetId: sheet.id, rect: change.rect };
    let values = change.values.map((row, r) => row.map((value, c) => {
      if (!isFormula(value)) return value;
      let formula = canonicalFormula(value, titleOf);
      // Quoting a sheet's title can lengthen a formula past what a cell holds.
      if (formula.length > MAX_CELL_LENGTH) {
        let cell = cellName(change.rect.startRow + r, change.rect.startColumn + c);
        throw new Error(`${label}: the formula for ${cell} runs to ` +
          `${formula.length.toLocaleString("en-US")} characters once its references are written ` +
          `as Google stores them; a cell holds at most ${MAX_CELL_LENGTH.toLocaleString("en-US")}.`);
      }
      return formula;
    }));
    return { op: change.op, sheetId: sheet.id, rect: change.rect, values };
  });
}

/** Sheets' `GridRange` for `rect` of sheet `sheetId`. */
export function gridRange(sheetId: number, rect: Rect) {
  return {
    sheetId,
    startRowIndex: rect.startRow,
    endRowIndex: rect.endRow,
    startColumnIndex: rect.startColumn,
    endColumnIndex: rect.endColumn,
  };
}

function cellData(value: SheetCellInput) {
  if (value === null) return {};
  if (isFormula(value)) return { userEnteredValue: { formulaValue: value } };
  switch (typeof value) {
    case "string": return { userEnteredValue: { stringValue: value } };
    case "number": return { userEnteredValue: { numberValue: value } };
    case "boolean": return { userEnteredValue: { boolValue: value } };
  }
}

/**
 * Applies `changes` to `grid` in order. Returns the grid with what they enter, and the Sheets
 * requests that enter it; `grid` itself when there are none. Throws `ChangeConflict` for a sheet
 * that is gone, or cells outside a sheet's grid.
 */
export function planSheet(
  grid: Grid, changes: readonly PlannedChange[],
): { grid: Grid; requests: unknown[] } {
  if (changes.length === 0) return { grid, requests: [] };
  let cells = new Map(grid.cells);
  let requests = changes.map((change, i) => {
    let conflict = (reason: string) => new ChangeConflict(`change ${i + 1} (${change.op}): ${reason}`);
    let sheet = grid.sheets.find(candidate => candidate.id === change.sheetId);
    if (!sheet) throw conflict(`the spreadsheet has no sheet with ID ${change.sheetId}`);
    let { rect } = change;
    let outside = outsideCell(sheet, rect);
    if (outside !== undefined) throw conflict(`${outside} is outside "${sheet.title}"`);
    for (let row = rect.startRow; row < rect.endRow; row++) {
      for (let column = rect.startColumn; column < rect.endColumn; column++) {
        let value = change.op === "writeCells"
          ? change.values[row - rect.startRow][column - rect.startColumn] : null;
        cells.set(cellKey(change.sheetId, row, column), value);
      }
    }
    let range = gridRange(change.sheetId, rect);
    // Cells of `range` that `rows` leaves out are cleared, so a clear sends none.
    return change.op === "clearRange"
      ? { updateCells: { range, fields: "userEnteredValue" } }
      : {
          updateCells: {
            range,
            rows: change.values.map(row => ({ values: row.map(cellData) })),
            fields: "userEnteredValue",
          },
        };
  });
  return { grid: { sheets: grid.sheets, cells }, requests };
}

/**
 * A hex SHA-256 of what `changes` overwrite: the size and title of each sheet they write, and the
 * cells they write as entered (`entered[i]`, the values of `changes[i]`'s cells in formula mode).
 * Whitespace in formulas is ignored, since Google may change it in a formula nobody edits.
 */
export async function guardDigest(
  sheets: readonly SheetMeta[],
  changes: readonly PlannedChange[],
  entered: readonly (readonly (readonly SheetCellInput[])[])[],
): Promise<string> {
  let ids = [...new Set(changes.map(change => change.sheetId))].toSorted((a, b) => a - b);
  let described = ids.map(id => {
    let sheet = sheets.find(candidate => candidate.id === id);
    return sheet ? [id, sheet.title, sheet.rowCount, sheet.columnCount] : [id, null];
  });
  let cells = changes.map(({ rect }, i) => {
    let values: unknown[] = [];
    for (let row = rect.startRow; row < rect.endRow; row++) {
      for (let column = rect.startColumn; column < rect.endColumn; column++) {
        // Google answers a blank cell before the last value of a row with "", and leaves out one
        // after it, so the two are the same.
        let given = entered[i]?.[row - rect.startRow]?.[column - rect.startColumn];
        let value = given === undefined || given === "" ? null : given;
        values.push(typeof value === "string" && isFormula(value) ? compactFormula(value) : value);
      }
    }
    return values;
  });
  let bytes = new TextEncoder().encode(JSON.stringify([described, cells]));
  let digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}
