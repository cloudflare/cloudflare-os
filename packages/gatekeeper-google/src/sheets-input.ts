/**
 * What an agent passes `updateSheet()`, checked before anything is read: the checks that need no
 * spreadsheet.
 */

import { REFUSED_FUNCTIONS, refusedFunction } from "./sheets-formula";
import { cellCount, cellName, columnNumber, isFormula, parseRange, type Rect } from "./sheets-model";
import type { SheetCellInput, SheetChange, SheetTarget } from "./sheets-types";

/** The most changes one batch may make. */
export const MAX_CHANGES = 50;
/** The most cells one change may address. */
export const MAX_CHANGE_CELLS = 10_000;
/** The most cells one batch may address. */
export const MAX_BATCH_CELLS = 20_000;
/** Google's limit on the characters in one cell. */
export const MAX_CELL_LENGTH = 50_000;
/** Google's limit on the characters in a sheet's title. */
export const MAX_TITLE_LENGTH = 100;
/** The longest `ref` a change may give the sheet it adds. */
export const MAX_REF_LENGTH = 64;
/** The most rows or columns one change may insert. */
export const MAX_INSERTED_LINES = 1_000;
/** Google's limit on a sheet's columns: column ZZZ. */
export const MAX_COLUMNS = 18_278;
/** Google's limit on the cells of a spreadsheet, and so on a sheet's rows. */
export const MAX_SPREADSHEET_CELLS = 10_000_000;

/** The changes that insert or delete rows or columns. */
export type LineOp = "insertRows" | "deleteRows" | "insertColumns" | "deleteColumns";

/**
 * A change as checked: for a range, the sheet it names, as given, and its cells; for any other
 * change, the sheet it acts on, as given; and the first line one inserts before or deletes,
 * zero-based.
 */
export type PreparedChange =
  | { op: "writeCells"; sheet: string; rect: Rect; values: SheetCellInput[][] }
  | { op: "clearRange"; sheet: string; rect: Rect }
  | { op: "addSheet"; title: string; ref?: string; index?: number; rowCount?: number; columnCount?: number }
  | { op: "renameSheet"; sheetId: SheetTarget; title: string }
  | { op: "duplicateSheet"; sheetId: SheetTarget; title?: string; ref?: string; index?: number }
  | { op: "deleteSheet"; sheetId: SheetTarget }
  | { op: LineOp; sheetId: SheetTarget; start: number; count: number };

class Refused extends Error {}

function refuse(message: string): never {
  throw new Refused(message);
}

// What each change declares. capnweb-validate passes undeclared properties through unchecked, so
// they are dropped before anything reads them: the approval describes only what is written.
const FIELDS: Record<SheetChange["op"], readonly string[]> = {
  writeCells: ["range", "values"],
  clearRange: ["range"],
  addSheet: ["title", "ref", "index", "rowCount", "columnCount"],
  renameSheet: ["sheetId", "title"],
  duplicateSheet: ["sheetId", "title", "ref", "index"],
  deleteSheet: ["sheetId"],
  insertRows: ["sheetId", "at", "count"],
  deleteRows: ["sheetId", "at", "count"],
  insertColumns: ["sheetId", "at", "count"],
  deleteColumns: ["sheetId", "at", "count"],
};

const OPS = Object.keys(FIELDS);

function declared(change: SheetChange): SheetChange {
  if (!Object.hasOwn(FIELDS, change.op)) {
    refuse(`op must be one of ${OPS.slice(0, -1).join(", ")} or ${OPS.at(-1)}`);
  }
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

function checkTitle(title: unknown): string {
  if (typeof title !== "string" || title.length === 0 || title.length > MAX_TITLE_LENGTH) {
    refuse(`title must be a string of 1 to ${MAX_TITLE_LENGTH} characters`);
  }
  return title;
}

function checkInteger(name: string, value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    let range = max === Number.MAX_SAFE_INTEGER
      ? `${min} or more` : `from ${min.toLocaleString("en-US")} to ${max.toLocaleString("en-US")}`;
    refuse(`${name} must be an integer ${range}`);
  }
  return value;
}

function checkIndex(index: unknown): number | undefined {
  return index === undefined ? undefined : checkInteger("index", index, 0, Number.MAX_SAFE_INTEGER);
}

// The refs earlier changes of a batch gave the sheets they add, each with the change that gave it.
type Refs = Map<string, number>;

function checkRef(ref: unknown, refs: Refs, change: number): string | undefined {
  if (ref === undefined) return undefined;
  if (typeof ref !== "string" || ref.length === 0 || ref.length > MAX_REF_LENGTH) {
    refuse(`ref must be a string of 1 to ${MAX_REF_LENGTH} characters`);
  }
  let earlier = refs.get(ref);
  if (earlier !== undefined) refuse(`ref "${ref}" is already given to the sheet change ${earlier} adds`);
  refs.set(ref, change);
  return ref;
}

function checkTarget(sheetId: unknown, refs: Refs): SheetTarget {
  if (typeof sheetId === "number" && Number.isSafeInteger(sheetId) && sheetId >= 0) return sheetId;
  if (typeof sheetId === "string") {
    if (!refs.has(sheetId)) {
      refuse(`sheetId "${sheetId}" is not a ref an earlier change in this batch gives the sheet it adds`);
    }
    return sheetId;
  }
  refuse("sheetId must be a sheet's ID, a non-negative integer, or a ref an earlier change in this " +
    "batch gives the sheet it adds");
}

const COLUMN_LETTERS = /^[A-Za-z]{1,3}$/;

function checkLines(
  change: Extract<SheetChange, { op: LineOp }>, refs: Refs,
): Extract<PreparedChange, { op: LineOp }> {
  let sheetId = checkTarget(change.sheetId, refs);
  let columns = change.op === "insertColumns" || change.op === "deleteColumns";
  let start: number;
  if (columns) {
    if (typeof change.at !== "string" || !COLUMN_LETTERS.test(change.at)) {
      refuse('at must be the letters of a column, such as "C"');
    }
    start = columnNumber(change.at) - 1;
  } else {
    start = checkInteger("at", change.at, 1, Number.MAX_SAFE_INTEGER) - 1;
  }
  let max = change.op.startsWith("insert") ? MAX_INSERTED_LINES : columns ? MAX_COLUMNS : MAX_SPREADSHEET_CELLS;
  let count = checkInteger("count", change.count ?? 1, 1, max);
  return { op: change.op, sheetId, start, count };
}

function checkChange(change: SheetChange, refs: Refs, number: number): PreparedChange {
  switch (change.op) {
    case "writeCells":
    case "clearRange": {
      let { sheet, rect } = rangeOf(change.range);
      let cells = cellCount(rect);
      if (cells > MAX_CHANGE_CELLS) {
        refuse(`${change.range} has ${cells.toLocaleString("en-US")} cells; a change may address at ` +
          `most ${MAX_CHANGE_CELLS.toLocaleString("en-US")}`);
      }
      if (change.op === "clearRange") return { op: change.op, sheet, rect };
      return { op: change.op, sheet, rect, values: checkValues(change.values, rect, change.range) };
    }
    case "addSheet": {
      let title = checkTitle(change.title);
      let index = checkIndex(change.index);
      let rowCount = change.rowCount === undefined ? undefined
        : checkInteger("rowCount", change.rowCount, 1, MAX_SPREADSHEET_CELLS);
      let columnCount = change.columnCount === undefined ? undefined
        : checkInteger("columnCount", change.columnCount, 1, MAX_COLUMNS);
      let ref = checkRef(change.ref, refs, number);
      return {
        op: change.op, title,
        ...(ref === undefined ? {} : { ref }),
        ...(index === undefined ? {} : { index }),
        ...(rowCount === undefined ? {} : { rowCount }),
        ...(columnCount === undefined ? {} : { columnCount }),
      };
    }
    case "renameSheet":
      return { op: change.op, sheetId: checkTarget(change.sheetId, refs), title: checkTitle(change.title) };
    case "duplicateSheet": {
      let sheetId = checkTarget(change.sheetId, refs);
      let title = change.title === undefined ? undefined : checkTitle(change.title);
      let index = checkIndex(change.index);
      let ref = checkRef(change.ref, refs, number);
      return {
        op: change.op, sheetId,
        ...(title === undefined ? {} : { title }),
        ...(ref === undefined ? {} : { ref }),
        ...(index === undefined ? {} : { index }),
      };
    }
    case "deleteSheet":
      return { op: change.op, sheetId: checkTarget(change.sheetId, refs) };
    default:
      return checkLines(change, refs);
  }
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

/** Whether a change enters values in cells, rather than changing rows, columns or sheets. */
export function isCellChange<C extends { op: string }>(
  change: C,
): change is Extract<C, { op: "writeCells" | "clearRange" }> {
  return change.op === "writeCells" || change.op === "clearRange";
}

/** Checks `changes` as far as they can be without the spreadsheet. Throws `Error`. */
export function prepareChanges(changes: SheetChange[]): PreparedChange[] {
  if (!Array.isArray(changes) || changes.length === 0 || changes.length > MAX_CHANGES) {
    throw new Error(`Make between 1 and ${MAX_CHANGES} changes at a time.`);
  }
  let refs: Refs = new Map();
  let prepared = changes.map((given, i) => inChange(`Change ${i + 1} (${given.op})`, () =>
    checkChange(declared(given), refs, i + 1)));
  let cells = prepared.reduce((total, change) => total + (isCellChange(change) ? cellCount(change.rect) : 0), 0);
  if (cells > MAX_BATCH_CELLS) {
    throw new Error(`These changes address ${cells.toLocaleString("en-US")} cells; one batch may ` +
      `address at most ${MAX_BATCH_CELLS.toLocaleString("en-US")}.`);
  }
  return prepared;
}
