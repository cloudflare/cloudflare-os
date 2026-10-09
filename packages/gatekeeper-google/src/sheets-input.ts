/**
 * What an agent passes `updateSheet()`, checked before anything is read: the checks that need no
 * spreadsheet.
 */

import { REFUSED_FUNCTIONS, refusedFunction } from "./sheets-formula";
import { cellCount, cellName, isFormula, parseRange, type Rect } from "./sheets-model";
import type { SheetCellInput, SheetChange } from "./sheets-types";

/** The most changes one batch may make. */
export const MAX_CHANGES = 50;
/** The most cells one change may address. */
export const MAX_CHANGE_CELLS = 10_000;
/** The most cells one batch may address. */
export const MAX_BATCH_CELLS = 20_000;
/** Google's limit on the characters in one cell. */
export const MAX_CELL_LENGTH = 50_000;

/** A change as checked: the sheet it names, as given, and its cells. */
export type PreparedChange =
  | { op: "writeCells"; sheet: string; rect: Rect; values: SheetCellInput[][] }
  | { op: "clearRange"; sheet: string; rect: Rect };

class Refused extends Error {}

function refuse(message: string): never {
  throw new Refused(message);
}

// What each change declares. capnweb-validate passes undeclared properties through unchecked, so
// they are dropped before anything reads them: the approval describes only what is written.
const FIELDS: Record<SheetChange["op"], readonly string[]> = {
  writeCells: ["range", "values"],
  clearRange: ["range"],
};

function declared(change: SheetChange): SheetChange {
  if (!Object.hasOwn(FIELDS, change.op)) refuse("op must be writeCells or clearRange");
  let fields = change as Record<string, unknown>;
  return Object.fromEntries(["op", ...FIELDS[change.op]].flatMap(key =>
    fields[key] === undefined ? [] : [[key, fields[key]]])) as SheetChange;
}

function rangeOf(range: string): { sheet: string; rect: Rect } {
  let parsed: ReturnType<typeof parseRange>;
  try {
    parsed = parseRange(range);
  } catch (error) {
    refuse((error as Error).message.replace(/\.$/, ""));
  }
  if (parsed.sheet === undefined) {
    refuse(`range "${range}" does not name its sheet; name it as in 'Sheet name'!A1:C3`);
  }
  return { sheet: parsed.sheet, rect: parsed.rect };
}

function checkValue(value: SheetCellInput, cell: string): void {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) refuse(`the value for ${cell} is not a finite number`);
    return;
  }
  if (typeof value !== "string") refuse(`the value for ${cell} is not a string, number, boolean or null`);
  if (value === "") refuse(`the value for ${cell} is an empty string; use null to clear a cell`);
  if (value.length > MAX_CELL_LENGTH) {
    refuse(`the value for ${cell} has ${value.length.toLocaleString("en-US")} characters; a cell ` +
      `holds at most ${MAX_CELL_LENGTH.toLocaleString("en-US")}`);
  }
  if (!isFormula(value)) return;
  let refused = refusedFunction(value);
  if (refused !== undefined) {
    refuse(`the formula for ${cell} uses ${refused}, which cannot be used because ` +
      REFUSED_FUNCTIONS.get(refused));
  }
}

function checkValues(values: SheetCellInput[][], rect: Rect, range: string): SheetCellInput[][] {
  let rows = rect.endRow - rect.startRow;
  let columns = rect.endColumn - rect.startColumn;
  if (!Array.isArray(values) || values.length !== rows ||
    values.some(row => !Array.isArray(row) || row.length !== columns)) {
    refuse(`values must be ${rows} ${rows === 1 ? "row" : "rows"} of ${columns} ` +
      `${columns === 1 ? "value" : "values"} each, the shape of ${range}`);
  }
  return values.map((row, r) => row.map((value, c) => {
    checkValue(value, cellName(rect.startRow + r, rect.startColumn + c));
    return value;
  }));
}

// Prefixes a refusal with the change it is about.
function inChange<T>(label: string, body: () => T): T {
  try {
    return body();
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    throw new Error(`${label}: ${error.message}.`, { cause: error });
  }
}

/** Checks `changes` as far as they can be without the spreadsheet. Throws `Error`. */
export function prepareChanges(changes: SheetChange[]): PreparedChange[] {
  if (!Array.isArray(changes) || changes.length === 0 || changes.length > MAX_CHANGES) {
    throw new Error(`Make between 1 and ${MAX_CHANGES} changes at a time.`);
  }
  let prepared = changes.map((given, i) => inChange(`Change ${i + 1} (${given.op})`, () => {
    let change = declared(given);
    let { sheet, rect } = rangeOf(change.range);
    let cells = cellCount(rect);
    if (cells > MAX_CHANGE_CELLS) {
      refuse(`${change.range} has ${cells.toLocaleString("en-US")} cells; a change may address at ` +
        `most ${MAX_CHANGE_CELLS.toLocaleString("en-US")}`);
    }
    if (change.op === "clearRange") return { op: change.op, sheet, rect };
    return { op: change.op, sheet, rect, values: checkValues(change.values, rect, change.range) };
  }));
  let cells = prepared.reduce((total, change) => total + cellCount(change.rect), 0);
  if (cells > MAX_BATCH_CELLS) {
    throw new Error(`These changes address ${cells.toLocaleString("en-US")} cells; one batch may ` +
      `address at most ${MAX_BATCH_CELLS.toLocaleString("en-US")}.`);
  }
  return prepared;
}
