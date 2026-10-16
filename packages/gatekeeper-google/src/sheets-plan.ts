/**
 * `updateSpreadsheet()` changes: where each lands, their replay over a grid, the requests that make
 * them, and the digest of what they overwrite.
 *
 * Queueing, replay and apply all run `planSheet`, so the cells a read previews and the batch an
 * approval writes come from the same code. Values are sent typed, so Google parses nothing by
 * locale: text stays text, and only input starting with `=` is a formula. Formatting is sent with
 * a field mask naming each field a change gives, so a field reset clears only that field and a
 * field left out is kept. Changes apply in order,
 * as Google applies a batch's requests, so a change addresses the spreadsheet as the changes
 * before it leave it.
 */

import type { SheetArea, SheetProtection } from "./sheets-api";
import { colorStyle, wrapStrategy, type BorderSide, type FormatEntry } from "./sheets-format";
import { canonicalFormula, compactFormula } from "./sheets-formula";
import {
  isCellChange, isRangeChange, MAX_CELL_LENGTH, MAX_COLUMNS, MAX_SPREADSHEET_CELLS, MAX_TITLE_LENGTH,
  type LineOp, type PreparedChange,
} from "./sheets-input";
import {
  a1Of, cellName, columnLetters, findSheet, isFormula, type EnteredValue, type Rect,
} from "./sheets-model";
import type { SheetBorder, SheetColor } from "./sheets-read-types";
import type {
  Entry, Grid, PlannedChange, QueuedChange, SheetMeta, SimSheet, StructuralStep,
} from "./sheets-simulation";
import {
  baseIndexOf, deleteLines, insertLines, lineAt, lineCount, linesAt, positionOf, positionsIn, type Lines,
} from "./sheets-structure";
import type { SheetCellInput, SheetFormatChange } from "./sheets-types";
import { ChangeConflict } from "./slides-text";

/** The rows of a sheet added with none given, as in Google Sheets. */
export const DEFAULT_ROW_COUNT = 1000;
/** The columns of a sheet added with none given, as in Google Sheets. */
export const DEFAULT_COLUMN_COUNT = 26;
/** The most cells a batch may overwrite or delete, which its guard covers. */
export const MAX_GUARDED_CELLS = 50_000;
/**
 * The most cell values and formats queued changes may set in all, by writing, clearing,
 * formatting or copying cells: every read, queued batch and apply replays each of them.
 */
export const MAX_QUEUED_ENTRIES = 100_000;
/**
 * The most changes to rows, columns and sheets that may be queued at once: reads, queued batches
 * and applies replay formulas and queued cells through each of them.
 */
export const MAX_QUEUED_STEPS = 50;
/** The most cells a sheet deleted here may have, so the guard can cover them. */
export const MAX_DELETED_SHEET_CELLS = 50_000;

function plural(count: number, noun: string): string {
  return `${count.toLocaleString("en-US")} ${noun}${count === 1 ? "" : "s"}`;
}

/** The key in `Grid.cells` of a cell, by its sheet and the identities of its row and column. */
export function cellKey(sheetId: number, row: string, column: string): string {
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

type Axis = "rows" | "columns";

function axisOf(op: LineOp): Axis {
  return op === "insertRows" || op === "deleteRows" ? "rows" : "columns";
}

function lineName(axis: Axis, position: number): string {
  return axis === "rows" ? String(position + 1) : columnLetters(position);
}

// Lines by their names: "row 5", "rows 5 to 6", "column C".
function band(axis: Axis, start: number, count: number): string {
  let noun = axis === "rows" ? "row" : "column";
  return count === 1
    ? `${noun} ${lineName(axis, start)}`
    : `${noun}s ${lineName(axis, start)} to ${lineName(axis, start + count - 1)}`;
}

function cellsOf(sheets: readonly SheetMeta[]): number {
  return sheets.reduce((total, sheet) => total + sheet.rowCount * sheet.columnCount, 0);
}

/**
 * A grid being changed in place, which no one else holds, with the keys of its entries and formats
 * by sheet once a change needs one sheet's, so it visits only those.
 */
type Working = {
  sheets: SimSheet[]; cells: Map<string, Entry>; formats: Map<string, FormatEntry>; log: StructuralStep[];
  keys?: Map<number, Set<string>>;
};

function working(grid: Grid): Working {
  return {
    sheets: [...grid.sheets], cells: new Map(grid.cells), formats: new Map(grid.formats), log: [...grid.log],
  };
}

// What is kept by cell: entered input and formatting.
function byCell(work: Working): Map<string, unknown>[] {
  return [work.cells, work.formats];
}

// The keys of sheet `sheetId`'s entries in `keys`, an empty set added if it has none.
function keySet(keys: Map<number, Set<string>>, sheetId: number): Set<string> {
  let set = keys.get(sheetId);
  if (!set) keys.set(sheetId, set = new Set());
  return set;
}

// The keys of the entries on sheet `sheetId`, which the caller may add to or delete from. The
// first call indexes every entry's key by its sheet and `enter` keeps the index from then on, so
// changes that only write cells never build it.
function keysOn(work: Working, sheetId: number): Set<string> {
  if (!work.keys) {
    work.keys = new Map();
    for (let map of byCell(work)) {
      for (let key of map.keys()) keySet(work.keys, Number(key.slice(0, key.indexOf(":")))).add(key);
    }
  }
  return keySet(work.keys, sheetId);
}

function enter(work: Working, sheetId: number, key: string, entry: Entry): void {
  work.cells.set(key, entry);
  if (work.keys) keySet(work.keys, sheetId).add(key);
}

function enterFormat(work: Working, sheetId: number, key: string, format: FormatEntry): void {
  work.formats.set(key, format);
  if (work.keys) keySet(work.keys, sheetId).add(key);
}

// The entries and formats queued changes have made.
function queued(work: Working): number {
  return work.cells.size + work.formats.size;
}

// The entries and formats on the cells `keys` names, which a copy of them makes.
function heldBy(work: Working, keys: ReadonlySet<string>): number {
  let count = 0;
  for (let key of keys) count += Number(work.cells.has(key)) + Number(work.formats.has(key));
  return count;
}

// How many cells of `rows` by `columns` of sheet `sheetId` hold nothing in `map` yet.
function unentered(
  map: ReadonlyMap<string, unknown>, sheetId: number, rows: readonly (string | undefined)[],
  columns: readonly (string | undefined)[],
): number {
  let count = 0;
  for (let row of rows) {
    for (let column of columns) if (!map.has(cellKey(sheetId, row!, column!))) count++;
  }
  return count;
}

// The entries and formats `change`, which applies to `work`, adds: those of the cells a write,
// clear or format sets that have none yet, or those a copy takes from its original.
function entriesAdded(work: Working, change: PlannedChange): number {
  if (change.op === "duplicateSheet") return heldBy(work, keysOn(work, change.sheetId));
  if (!isRangeChange(change)) return 0;
  let sheet = work.sheets.find(candidate => candidate.id === change.sheetId)!;
  let { rect } = change;
  if (change.op === "formatCells") return formatsAdded(work, sheet, rect, change.format);
  return unentered(work.cells, sheet.id,
    linesAt(sheet.rows, rect.startRow, rect.endRow), linesAt(sheet.columns, rect.startColumn, rect.endColumn));
}

// The cells beside `rect` of `sheet` whose facing border `format` clears, as `recordFormat` does:
// those beside each outer edge it sets a border on, within the sheet.
function bordered(
  sheet: SimSheet, rect: Rect, format: SheetFormatChange, each: (row: string, column: string, side: BorderSide) => void,
): void {
  let { borders = {} } = format;
  let beside = (rowAt: number, columnAt: number, side: BorderSide) => {
    let row = rowAt < 0 ? undefined : lineAt(sheet.rows, rowAt);
    let column = columnAt < 0 ? undefined : lineAt(sheet.columns, columnAt);
    if (row !== undefined && column !== undefined) each(row, column, side);
  };
  for (let column = rect.startColumn; column < rect.endColumn; column++) {
    if (borders.top !== undefined) beside(rect.startRow - 1, column, "bottom");
    if (borders.bottom !== undefined) beside(rect.endRow, column, "top");
  }
  for (let row = rect.startRow; row < rect.endRow; row++) {
    if (borders.left !== undefined) beside(row, rect.startColumn - 1, "right");
    if (borders.right !== undefined) beside(row, rect.endColumn, "left");
  }
}

// How many cells formatting `rect` of `sheet` with `format` gives formats that have none yet: the
// range's, and those beside it whose facing border it clears.
function formatsAdded(work: Working, sheet: SimSheet, rect: Rect, format: SheetFormatChange): number {
  let count = unentered(work.formats, sheet.id,
    linesAt(sheet.rows, rect.startRow, rect.endRow), linesAt(sheet.columns, rect.startColumn, rect.endColumn));
  bordered(sheet, rect, format, (row, column) => {
    if (!work.formats.has(cellKey(sheet.id, row, column))) count++;
  });
  return count;
}

// `sheets` with `sheet` placed at its index and those from there on one along, as Google inserts one.
function placed(sheets: readonly SimSheet[], sheet: SimSheet): SimSheet[] {
  return [...sheets.map(other => other.index >= sheet.index ? { ...other, index: other.index + 1 } : other), sheet]
    .toSorted((a, b) => a.index - b.index);
}

function removed(sheets: readonly SimSheet[], gone: SimSheet): SimSheet[] {
  return sheets.flatMap(other => other.id === gone.id ? []
    : [other.index > gone.index ? { ...other, index: other.index - 1 } : other]);
}

// How many of `sheet`'s leading lines along `axis` are frozen; Google keeps at least one unfrozen.
function frozenCount(sheet: SimSheet, axis: Axis): number {
  return (axis === "rows" ? sheet.frozenRowCount : sheet.frozenColumnCount) ?? 0;
}

function withLines(sheet: SimSheet, axis: Axis, lines: Lines): SimSheet {
  return axis === "rows"
    ? { ...sheet, rows: lines, rowCount: lineCount(lines) }
    : { ...sheet, columns: lines, columnCount: lineCount(lines) };
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

type FormatField = keyof Omit<SheetFormatChange, "borders">;

// Where Sheets' `CellFormat` holds each field a change sets, in the order the mask names them.
const FORMAT_PATHS: Record<FormatField, string> = {
  bold: "textFormat.bold",
  italic: "textFormat.italic",
  underline: "textFormat.underline",
  strikethrough: "textFormat.strikethrough",
  fontSize: "textFormat.fontSize",
  textColor: "textFormat.foregroundColorStyle",
  fillColor: "backgroundColorStyle",
  numberFormat: "numberFormat",
  horizontalAlignment: "horizontalAlignment",
  verticalAlignment: "verticalAlignment",
  wrap: "wrapStrategy",
};

// The older field Google also keeps each colour in. A reset names it too, so a colour set through
// it does not survive the reset.
const LEGACY_COLOR_PATHS: Partial<Record<FormatField, string>> = {
  textColor: "textFormat.foregroundColor",
  fillColor: "backgroundColor",
};

function formatValue(field: FormatField, value: NonNullable<SheetFormatChange[FormatField]>): unknown {
  switch (field) {
    case "textColor":
    case "fillColor":
      return colorStyle(value as SheetColor);
    case "wrap":
      return wrapStrategy(value as NonNullable<SheetFormatChange["wrap"]>);
    default:
      return value;
  }
}

function borderValue(border: SheetBorder | null) {
  return border === null ? { style: "NONE" } : { style: border.style, colorStyle: colorStyle(border.color ?? "#000000") };
}

/**
 * The requests that set `format` on `range`: a `repeatCell` for every field but the borders, whose
 * mask names each field given, so one given as `null` is reset to the default, and an
 * `updateBorders`, which removes a border given as `null`.
 */
export function formatRequests(range: ReturnType<typeof gridRange>, format: SheetFormatChange): unknown[] {
  let requests: unknown[] = [];
  let userEnteredFormat: Record<string, unknown> = {};
  let text: Record<string, unknown> = {};
  let paths: string[] = [];
  let textPaths: string[] = [];
  for (let field of Object.keys(FORMAT_PATHS) as FormatField[]) {
    let value = format[field];
    if (value === undefined) continue;
    let legacy = value === null ? LEGACY_COLOR_PATHS[field] : undefined;
    for (let path of legacy ? [FORMAT_PATHS[field], legacy] : [FORMAT_PATHS[field]]) {
      let [group, name] = path.split(".");
      if (name === undefined) {
        paths.push(group);
        if (value !== null) userEnteredFormat[group] = formatValue(field, value);
      } else {
        textPaths.push(name);
        if (value !== null) text[name] = formatValue(field, value);
      }
    }
  }
  if (textPaths.length > 0) {
    paths.unshift(`textFormat(${textPaths.join(",")})`);
    if (Object.keys(text).length > 0) userEnteredFormat.textFormat = text;
  }
  if (paths.length > 0) {
    requests.push({ repeatCell: { range, cell: { userEnteredFormat }, fields: `userEnteredFormat(${paths.join(",")})` } });
  }
  if (format.borders) {
    requests.push({
      updateBorders: {
        range,
        ...Object.fromEntries(Object.entries(format.borders).flatMap(([side, border]) =>
          border === undefined ? [] : [[side, borderValue(border)]])),
      },
    });
  }
  return requests;
}

/**
 * Records in `work` what `format` sets on each cell of `rect` of `sheet`: a border along the
 * range's edge on the cells of that edge, and one between its rows or columns on both cells it
 * divides. An edge has one owner, so a cell beside an outer edge whose border changes loses its own
 * border on that side, as Google removes it.
 */
function recordFormat(work: Working, sheet: SimSheet, rect: Rect, format: SheetFormatChange): void {
  let { borders = {}, ...set } = format;
  let rows = linesAt(sheet.rows, rect.startRow, rect.endRow);
  let columns = linesAt(sheet.columns, rect.startColumn, rect.endColumn);
  let update = (row: string, column: string, change: (entry: FormatEntry) => FormatEntry) => {
    let key = cellKey(sheet.id, row, column);
    enterFormat(work, sheet.id, key, change(work.formats.get(key) ?? { set: {}, borders: {} }));
  };
  rows.forEach((row, r) => columns.forEach((column, c) => {
    let sides: FormatEntry["borders"] = {};
    let edge = (side: BorderSide, outer: boolean, inner: "innerHorizontal" | "innerVertical") => {
      let border = outer ? borders[side] : borders[inner];
      if (border !== undefined) sides[side] = border;
    };
    edge("top", r === 0, "innerHorizontal");
    edge("bottom", r === rows.length - 1, "innerHorizontal");
    edge("left", c === 0, "innerVertical");
    edge("right", c === columns.length - 1, "innerVertical");
    update(row!, column!, entry => ({
      set: { ...entry.set, ...set },
      borders: { ...entry.borders, ...sides },
    }));
  }));
  bordered(sheet, rect, format, (row, column, side) =>
    update(row, column, entry => ({ ...entry, borders: { ...entry.borders, [side]: null } })));
}

/**
 * Applies `change` to `work`, recording `by` in the cells it enters, and returns its requests.
 * Throws what `conflict` makes for a change that does not apply.
 */
function applyOne(work: Working, change: PlannedChange, by: number, conflict: (reason: string) => Error): unknown[] {
  let find = (id: number) => work.sheets.find(sheet => sheet.id === id);
  let existing = (id: number) => {
    let sheet = find(id);
    if (!sheet) throw conflict(`the spreadsheet has no sheet with ID ${id}`);
    return sheet;
  };
  let unused = (id: number, title: string, index: number) => {
    if (find(id)) throw conflict(`the spreadsheet already has a sheet with ID ${id}`);
    let other = findSheet(work.sheets, title);
    if (other) throw conflict(`the spreadsheet already has a sheet titled "${other.title}"`);
    if (index > work.sheets.length) {
      throw conflict(`position ${index} is past the spreadsheet's ${plural(work.sheets.length, "sheet")}`);
    }
  };
  // Checked before the entries are made, so a replay that would grow past the limit stops short.
  let room = (added: number) => {
    let total = queued(work) + added;
    if (total > MAX_QUEUED_ENTRIES) {
      throw conflict(`it would bring the cell values and formats queued changes set to ${total.toLocaleString("en-US")}, ` +
        `more than the ${MAX_QUEUED_ENTRIES.toLocaleString("en-US")} that may be queued`);
    }
  };

  switch (change.op) {
    case "writeCells":
    case "clearRange":
    case "formatCells": {
      let sheet = existing(change.sheetId);
      let { rect } = change;
      let outside = outsideCell(sheet, rect);
      if (outside !== undefined) throw conflict(`${outside} is outside "${sheet.title}"`);
      let range = gridRange(change.sheetId, rect);
      let rows = linesAt(sheet.rows, rect.startRow, rect.endRow);
      let columns = linesAt(sheet.columns, rect.startColumn, rect.endColumn);
      if (change.op === "formatCells") {
        room(formatsAdded(work, sheet, rect, change.format));
        recordFormat(work, sheet, rect, change.format);
        return formatRequests(range, change.format);
      }
      room(unentered(work.cells, sheet.id, rows, columns));
      rows.forEach((row, r) => columns.forEach((column, c) => {
        let input = change.op === "writeCells" ? change.values[r][c] : null;
        enter(work, sheet.id, cellKey(sheet.id, row!, column!), { input, at: work.log.length, by });
      }));
      // Cells of `range` that `rows` leaves out are cleared, so a clear sends none.
      return [change.op === "clearRange"
        ? { updateCells: { range, fields: "userEnteredValue" } }
        : {
            updateCells: {
              range,
              rows: change.values.map(row => ({ values: row.map(cellData) })),
              fields: "userEnteredValue",
            },
          }];
    }
    case "addSheet": {
      let { sheetId, title, index, rowCount, columnCount } = change;
      unused(sheetId, title, index);
      // An added sheet's lines are all new, so none of its cells is read from Google.
      let lines = work.log.length;
      work.sheets = placed(work.sheets, {
        id: sheetId, title, index, rowCount, columnCount,
        rows: insertLines([], 0, rowCount, lines), columns: insertLines([], 0, columnCount, lines),
      });
      work.log.push({ kind: "add", sheetId, title });
      return [{ addSheet: { properties: { sheetId, title, index, gridProperties: { rowCount, columnCount } } } }];
    }
    case "renameSheet": {
      let sheet = existing(change.sheetId);
      let other = findSheet(work.sheets, change.title);
      if (other && other.id !== sheet.id) throw conflict(`the spreadsheet already has a sheet titled "${other.title}"`);
      work.sheets = work.sheets.map(candidate => candidate.id === sheet.id ? { ...candidate, title: change.title } : candidate);
      work.log.push({ kind: "rename", sheetId: sheet.id, from: sheet.title, to: change.title });
      return [{ updateSheetProperties: { properties: { sheetId: sheet.id, title: change.title }, fields: "title" } }];
    }
    case "duplicateSheet": {
      let source = existing(change.sheetId);
      let { newSheetId, title, index } = change;
      unused(newSheetId, title, index);
      let copied = keysOn(work, source.id);
      room(heldBy(work, copied));
      work.sheets = placed(work.sheets, {
        id: newSheetId, title, index, rowCount: source.rowCount, columnCount: source.columnCount,
        rows: source.rows, columns: source.columns,
        ...(source.source === undefined ? {} : { source: source.source }),
        ...(source.frozenRowCount === undefined ? {} : { frozenRowCount: source.frozenRowCount }),
        ...(source.frozenColumnCount === undefined ? {} : { frozenColumnCount: source.frozenColumnCount }),
      });
      // The copy holds what is queued for the original, and its cells move with its own lines.
      for (let key of copied) {
        let [, row, column] = key.split(":");
        let copy = cellKey(newSheetId, row, column);
        let entry = work.cells.get(key);
        if (entry) enter(work, newSheetId, copy, entry);
        let format = work.formats.get(key);
        if (format) enterFormat(work, newSheetId, copy, format);
      }
      work.log.push({ kind: "duplicate", sheetId: source.id, title: source.title, newSheetId, newTitle: title });
      // Google picks a localized name, and the first position, for a copy given neither.
      return [{
        duplicateSheet: { sourceSheetId: source.id, newSheetId, insertSheetIndex: index, newSheetName: title },
      }];
    }
    case "deleteSheet": {
      let sheet = existing(change.sheetId);
      if (!sheet.hidden && work.sheets.filter(candidate => !candidate.hidden).length === 1) {
        throw conflict(`"${sheet.title}" is the spreadsheet's only visible sheet`);
      }
      work.sheets = removed(work.sheets, sheet);
      for (let key of keysOn(work, sheet.id)) {
        for (let map of byCell(work)) map.delete(key);
      }
      work.keys!.delete(sheet.id);
      work.log.push({ kind: "deleteSheet", sheetId: sheet.id, title: sheet.title });
      return [{ deleteSheet: { sheetId: sheet.id } }];
    }
    default: {
      let sheet = existing(change.sheetId);
      let axis = axisOf(change.op);
      let lines = axis === "rows" ? sheet.rows : sheet.columns;
      let count = lineCount(lines);
      let noun = axis === "rows" ? "row" : "column";
      let range = {
        sheetId: sheet.id, dimension: axis === "rows" ? "ROWS" : "COLUMNS",
        startIndex: change.start, endIndex: change.start + change.count,
      };
      let next: Lines;
      if (change.op === "insertRows" || change.op === "insertColumns") {
        if (change.start > count) {
          throw conflict(`"${sheet.title}" has ${plural(count, noun)}, so none can be inserted before ` +
            `${noun} ${lineName(axis, change.start)}`);
        }
        next = insertLines(lines, change.start, change.count, work.log.length);
        work.log.push({ kind: "insert", sheetId: sheet.id, title: sheet.title, axis, start: change.start, count: change.count });
        // New lines take the formatting of the line before them; Google refuses lines added after
        // the last unless they do.
        work.sheets = work.sheets.map(candidate => candidate.id === sheet.id ? withLines(candidate, axis, next) : candidate);
        return [{ insertDimension: { range, inheritFromBefore: change.start > 0 } }];
      }
      if (change.start + change.count > count) {
        throw conflict(`"${sheet.title}" has ${plural(count, noun)}, so ${band(axis, change.start, change.count)} ` +
          "cannot be deleted");
      }
      if (change.count >= count) throw conflict(`it would delete every ${noun} of "${sheet.title}"`);
      // A collaborator may have frozen lines since the change was queued.
      let frozen = frozenCount(sheet, axis);
      if (frozen > 0 && count - change.count <= frozen) {
        throw conflict(`it would leave only the ${plural(frozen, `frozen ${noun}`)} of "${sheet.title}"`);
      }
      // A band may span millions of lines, so the sheet's entries are found by their position.
      let part = axis === "rows" ? 1 : 2;
      let keys = keysOn(work, sheet.id);
      for (let key of keys) {
        let position = positionOf(lines, key.split(":")[part]);
        if (position !== undefined && position >= change.start && position < change.start + change.count) {
          for (let map of byCell(work)) map.delete(key);
          keys.delete(key);
        }
      }
      next = deleteLines(lines, change.start, change.count);
      work.log.push({ kind: "delete", sheetId: sheet.id, title: sheet.title, axis, start: change.start, count: change.count });
      work.sheets = work.sheets.map(candidate => candidate.id === sheet.id ? withLines(candidate, axis, next) : candidate);
      return [{ deleteDimension: { range } }];
    }
  }
}

// What `applyOne` throws when a change `resolveChanges` checked does not apply after all.
function unexpected(i: number, change: PlannedChange) {
  return (reason: string) => new ChangeConflict(`change ${i + 1} (${change.op}): ${reason}`);
}

/**
 * Walks `prepared` over `grid` as each change leaves it, finding the sheet each acts on by the
 * title it then has. Fills in what a change leaves to its default, gives each sheet added an ID
 * from `mint` that no sheet has, and writes formulas' references as Google stores them. Throws
 * `Error` for a change Google would refuse, or one that would delete what the guard cannot cover.
 */
export function resolveChanges(
  grid: Grid, prepared: readonly PreparedChange[], mint: () => number,
): PlannedChange[] {
  let work = working(grid);
  let used = new Set(grid.sheets.map(sheet => sheet.id));
  let fresh = () => {
    for (let tries = 0; tries < 100; tries++) {
      let id = mint();
      if (!used.has(id)) {
        used.add(id);
        return id;
      }
    }
    throw new Error("No unused sheet ID could be chosen.");
  };

  return prepared.map((change, i): PlannedChange => {
    let label = `Change ${i + 1} (${change.op})`;
    let sheetFor = (title: string) => sheetNamed(work, title, label);
    let titleFree = (title: string, except?: number) => {
      let other = findSheet(work.sheets, title);
      if (other && other.id !== except) {
        throw new Error(`${label}: the spreadsheet already has a sheet titled "${other.title}"; sheet ` +
          "titles must differ, ignoring case.");
      }
    };
    let placeable = (index: number) => {
      let count = work.sheets.length;
      if (index > count) {
        throw new Error(`${label}: index ${index} is past the end; the spreadsheet has ` +
          `${plural(count, "sheet")}, so index may be at most ${count}.`);
      }
    };
    let fits = (added: number) => {
      let total = cellsOf(work.sheets) + added;
      if (total > MAX_SPREADSHEET_CELLS) {
        throw new Error(`${label}: the spreadsheet would hold ${total.toLocaleString("en-US")} cells; ` +
          `Google Sheets holds at most ${MAX_SPREADSHEET_CELLS.toLocaleString("en-US")}.`);
      }
    };

    let next = ((): PlannedChange => {
      switch (change.op) {
        case "writeCells":
        case "clearRange":
        case "formatCells":
          return resolveCells(work, change, label);
        case "addSheet": {
          let index = change.index ?? work.sheets.length;
          let rowCount = change.rowCount ?? DEFAULT_ROW_COUNT;
          let columnCount = change.columnCount ?? DEFAULT_COLUMN_COUNT;
          titleFree(change.title);
          placeable(index);
          fits(rowCount * columnCount);
          return { op: "addSheet", sheetId: fresh(), title: change.title, index, rowCount, columnCount };
        }
        case "renameSheet": {
          let sheet = sheetFor(change.sheet);
          titleFree(change.title, sheet.id);
          return { op: "renameSheet", sheetId: sheet.id, title: change.title };
        }
        case "duplicateSheet": {
          let source = sheetFor(change.sheet);
          let title = change.title ?? `Copy of ${source.title}`;
          if (title.length > MAX_TITLE_LENGTH) {
            throw new Error(`${label}: "${title}" would be over ${MAX_TITLE_LENGTH} characters; give the copy ` +
              "a title.");
          }
          titleFree(title);
          let index = change.index ?? source.index + 1;
          placeable(index);
          fits(source.rowCount * source.columnCount);
          return { op: "duplicateSheet", sheetId: source.id, newSheetId: fresh(), title, index };
        }
        case "deleteSheet": {
          let sheet = sheetFor(change.sheet);
          if (!sheet.hidden && work.sheets.filter(candidate => !candidate.hidden).length === 1) {
            throw new Error(`${label}: "${sheet.title}" is the spreadsheet's only visible sheet, and ` +
              "a spreadsheet keeps at least one.");
          }
          let cells = sheet.rowCount * sheet.columnCount;
          if (cells > MAX_DELETED_SHEET_CELLS) {
            throw new Error(`${label}: "${sheet.title}" has ${cells.toLocaleString("en-US")} cells, more ` +
              `than the ${MAX_DELETED_SHEET_CELLS.toLocaleString("en-US")} a sheet deleted here may ` +
              "have; delete it in Google Sheets.");
          }
          return { op: "deleteSheet", sheetId: sheet.id, rowCount: sheet.rowCount, columnCount: sheet.columnCount };
        }
        default:
          return resolveLines(change, sheetFor(change.sheet), label, fits);
      }
    })();
    if (!isRangeChange(next) && work.log.length >= MAX_QUEUED_STEPS) {
      throw new Error(`${label}: ${MAX_QUEUED_STEPS} changes to rows, columns and sheets are queued already, ` +
        "the most that may be. Approve or reject queued changes first.");
    }
    let added = entriesAdded(work, next);
    let total = queued(work) + added;
    if (total > MAX_QUEUED_ENTRIES) {
      let what = next.op === "duplicateSheet"
        ? `copying "${work.sheets.find(sheet => sheet.id === next.sheetId)?.title}" adds its ` +
          `${added.toLocaleString("en-US")} queued cell ${added === 1 ? "value or format" : "values and formats"} ` +
          "to the copy, which"
        : "it";
      throw new Error(`${label}: ${what} would bring the cell values and formats queued changes set to ` +
        `${total.toLocaleString("en-US")}, and at most ${MAX_QUEUED_ENTRIES.toLocaleString("en-US")} may ` +
        "be queued. Approve or reject queued changes first.");
    }
    applyOne(work, next, 0, unexpected(i, next));
    return next;
  });
}

// The sheet titled `title`, as the changes before the one `label` names leave the spreadsheet.
function sheetNamed(work: Working, title: string, label: string): SimSheet {
  let sheet = findSheet(work.sheets, title);
  if (sheet) return sheet;
  throw new Error(`${label}: the spreadsheet has no sheet named "${title}". Call ` +
    "getSpreadsheet() for sheet titles.");
}

function resolveCells(
  work: Working, change: Extract<PreparedChange, { op: "writeCells" | "clearRange" | "formatCells" }>,
  label: string,
): PlannedChange {
  let sheet = sheetNamed(work, change.sheet, label);
  let outside = outsideCell(sheet, change.rect);
  if (outside !== undefined) {
    let hint = change.rect.endColumn > sheet.columnCount
      ? `insertColumns with at: "${columnLetters(sheet.columnCount)}" adds columns`
      : `insertRows with at: ${sheet.rowCount + 1} adds rows`;
    throw new Error(`${label}: "${sheet.title}" has ${plural(sheet.rowCount, "row")} and ` +
      `${plural(sheet.columnCount, "column")}, so ${outside} is outside it. ${hint}.`);
  }
  if (change.op === "clearRange") return { op: change.op, sheetId: sheet.id, rect: change.rect };
  if (change.op === "formatCells") return { op: change.op, sheetId: sheet.id, rect: change.rect, format: change.format };
  let titleOf = (name: string) => findSheet(work.sheets, name)?.title;
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
}

function resolveLines(
  change: Extract<PreparedChange, { op: LineOp }>, sheet: SimSheet, label: string,
  fits: (added: number) => void,
): PlannedChange {
  let axis = axisOf(change.op);
  let count = axis === "rows" ? sheet.rowCount : sheet.columnCount;
  let noun = axis === "rows" ? "row" : "column";
  let { start } = change;
  if (change.op === "insertRows" || change.op === "insertColumns") {
    if (start > count) {
      let allowed = axis === "rows" ? `from 1 to ${count + 1}` : `a column from A to ${columnLetters(count)}`;
      throw new Error(`${label}: "${sheet.title}" has ${plural(count, noun)}, so at must be ${allowed}.`);
    }
    if (axis === "columns" && count + change.count > MAX_COLUMNS) {
      throw new Error(`${label}: "${sheet.title}" has ${plural(count, noun)}, and a sheet holds at ` +
        `most ${MAX_COLUMNS.toLocaleString("en-US")}.`);
    }
    fits(change.count * (axis === "rows" ? sheet.columnCount : sheet.rowCount));
    return { op: change.op, sheetId: sheet.id, start, count: change.count, ...(start === count ? { appends: true } : {}) };
  }
  if (start + change.count > count) {
    throw new Error(`${label}: "${sheet.title}" has ${plural(count, noun)}, so ` +
      `${band(axis, start, change.count)} cannot be deleted.`);
  }
  if (change.count === count) {
    throw new Error(`${label}: deleting ${band(axis, start, change.count)} would delete every ${noun} ` +
      `of "${sheet.title}", and a sheet keeps at least one.`);
  }
  let frozen = frozenCount(sheet, axis);
  if (frozen > 0 && count - change.count <= frozen) {
    throw new Error(`${label}: deleting ${band(axis, start, change.count)} would leave only the ` +
      `${plural(frozen, `frozen ${noun}`)} of "${sheet.title}", and a sheet keeps at least one ${noun} ` +
      "unfrozen.");
  }
  return { op: change.op, sheetId: sheet.id, start, count: change.count };
}

/**
 * Applies `changes` to `grid` in order, the cells they enter recording `by`, the ID of the queued
 * change they make. Returns the grid as they leave it, and the Sheets requests that make them;
 * `grid` itself when there are none. Throws `ChangeConflict` for a change that no longer applies:
 * a sheet that is gone, an ID or title another sheet has taken, the last visible sheet, rows or
 * columns the sheet no longer has, or cells outside a sheet's grid.
 */
export function planSheet(
  grid: Grid, changes: readonly PlannedChange[], by = 0,
): { grid: Grid; requests: unknown[] } {
  if (changes.length === 0) return { grid, requests: [] };
  let work = working(grid);
  let requests = changes.flatMap((change, i) => applyOne(work, change, by, unexpected(i, change)));
  return { grid: { sheets: work.sheets, cells: work.cells, formats: work.formats, log: work.log }, requests };
}

// The cells `rect` of `sheet` covers as they were in `original`, the same sheet before the batch,
// in as few rectangles as lines the batch inserted leave possible.
function mappedBack(original: SimSheet, sheet: SimSheet, rect: Rect): SheetArea[] {
  let rows = positionsIn(original.rows, sheet.rows, rect.startRow, rect.endRow);
  let columns = positionsIn(original.columns, sheet.columns, rect.startColumn, rect.endColumn);
  return rows.flatMap(r => columns.map(c => ({
    sheetId: sheet.id, rect: { startRow: r.start, endRow: r.end, startColumn: c.start, endColumn: c.end },
  })));
}

// The cells of `area` that `other` does not cover, in at most four rectangles.
function uncovered(area: SheetArea, other: SheetArea): SheetArea[] {
  let a = area.rect;
  let b = other.rect;
  if (area.sheetId !== other.sheetId || b.startRow >= a.endRow || b.endRow <= a.startRow ||
    b.startColumn >= a.endColumn || b.endColumn <= a.startColumn) return [area];
  let rows = { startRow: Math.max(a.startRow, b.startRow), endRow: Math.min(a.endRow, b.endRow) };
  let pieces: Rect[] = [];
  if (a.startRow < b.startRow) pieces.push({ ...a, endRow: b.startRow });
  if (a.startColumn < b.startColumn) pieces.push({ ...rows, startColumn: a.startColumn, endColumn: b.startColumn });
  if (b.endColumn < a.endColumn) pieces.push({ ...rows, startColumn: b.endColumn, endColumn: a.endColumn });
  if (b.endRow < a.endRow) pieces.push({ ...a, startRow: b.endRow });
  return pieces.map(rect => ({ sheetId: area.sheetId, rect }));
}

/**
 * The cells `planned` overwrites or removes, as `grid`, the spreadsheet just before the batch,
 * holds them: each write's cells mapped back through the batch's own earlier changes, less those
 * of lines and sheets it creates; each deleted band of rows or columns; each deleted sheet. Each
 * cell is in one area only. Throws `Error` when they are more than `MAX_GUARDED_CELLS`.
 */
export function guardCells(grid: Grid, planned: readonly PlannedChange[]): SheetArea[] {
  let work = working(grid);
  let areas: SheetArea[] = [];
  planned.forEach((change, i) => {
    let sheet = work.sheets.find(candidate => candidate.id === change.sheetId);
    let original = grid.sheets.find(candidate => candidate.id === change.sheetId);
    let covered: SheetArea[] = [];
    if (sheet && original) {
      if (isCellChange(change)) covered = mappedBack(original, sheet, change.rect);
      else if (change.op === "deleteSheet") {
        covered = [{
          sheetId: original.id,
          rect: { startRow: 0, endRow: original.rowCount, startColumn: 0, endColumn: original.columnCount },
        }];
      } else if (change.op === "deleteRows" || change.op === "deleteColumns") {
        let end = change.start + change.count;
        covered = mappedBack(original, sheet, change.op === "deleteRows"
          ? { startRow: change.start, endRow: end, startColumn: 0, endColumn: sheet.columnCount }
          : { startRow: 0, endRow: sheet.rowCount, startColumn: change.start, endColumn: end });
      }
    }
    // Earlier areas the new one covers give way to it, and it adds only what they leave uncovered.
    for (let area of covered) {
      areas = areas.filter(earlier => uncovered(earlier, area).length > 0);
      areas.push(...areas.reduce((left, earlier) => left.flatMap(piece => uncovered(piece, earlier)), [area]));
    }
    applyOne(work, change, 0, unexpected(i, change));
  });
  let cells = areas.reduce((total, { rect }) =>
    total + (rect.endRow - rect.startRow) * (rect.endColumn - rect.startColumn), 0);
  if (cells > MAX_GUARDED_CELLS) {
    throw new Error(`These changes overwrite or delete ${cells.toLocaleString("en-US")} cells that are ` +
      `already there; one batch may overwrite or delete at most ${MAX_GUARDED_CELLS.toLocaleString("en-US")}.`);
  }
  return areas;
}

/** The IDs of the sheets `changes` act on that are there before them, ascending. */
export function guardedSheets(changes: readonly PlannedChange[]): number[] {
  let created = new Set<number>();
  let addressed = new Set<number>();
  for (let change of changes) {
    if (change.op === "addSheet") {
      created.add(change.sheetId);
      continue;
    }
    if (!created.has(change.sheetId)) addressed.add(change.sheetId);
    if (change.op === "duplicateSheet") created.add(change.newSheetId);
  }
  return [...addressed].toSorted((a, b) => a - b);
}

// Whether `changes` place a sheet among the others, at an index that counts them.
function placesSheet(changes: readonly PlannedChange[]): boolean {
  return changes.some(change => change.op === "addSheet" || change.op === "duplicateSheet");
}

/**
 * What a batch's guard covers: the sheets it acts on; its cells, which a batch queued before the
 * guard named them leaves to be those its changes write; and, when it places a sheet, the sheets'
 * order.
 */
export function guardOf(batch: {
  changes: readonly PlannedChange[]; guard: { cells?: readonly SheetArea[] };
}): { sheetIds: number[]; cells: SheetArea[]; order: boolean } {
  return {
    sheetIds: guardedSheets(batch.changes),
    cells: batch.guard.cells
      ? [...batch.guard.cells]
      : batch.changes.filter(isCellChange).map(({ sheetId, rect }) => ({ sheetId, rect })),
    order: placesSheet(batch.changes),
  };
}

/** Whether each of `cells` lies within its sheet's grid, so it can be read. */
export function guardFits(sheets: readonly SheetMeta[], cells: readonly SheetArea[]): boolean {
  return cells.every(({ sheetId, rect }) => {
    let sheet = sheets.find(candidate => candidate.id === sheetId);
    return sheet !== undefined && rect.endRow <= sheet.rowCount && rect.endColumn <= sheet.columnCount;
  });
}

// The sheets a change to rows, columns or sheets acts on or creates.
function structuralSheets(change: PlannedChange): number[] {
  if (isRangeChange(change)) return [];
  return change.op === "duplicateSheet" ? [change.sheetId, change.newSheetId] : [change.sheetId];
}

/**
 * The queued changes a batch builds on, which must have been applied before it: those that
 * entered what `cells` of `grid` hold, those that entered what a sheet the batch copies holds as
 * it is copied, those changing rows, columns or sheets of a sheet the batch acts on, or of any
 * sheet when the batch enters a formula, copies a sheet, or `guardsFormula`, its guard digests one,
 * and, when the batch places a sheet at an index that counts the others, those adding, copying or
 * deleting one.
 */
export function guardAfter(
  grid: Grid, pending: readonly QueuedChange[], planned: readonly PlannedChange[],
  cells: readonly SheetArea[], guardsFormula = false,
): number[] {
  let after = new Set<number>();
  // Each entry is found in `cells` by its position, so no line of them is listed.
  for (let [key, entry] of grid.cells) {
    if (entry.by === 0 || after.has(entry.by)) continue;
    let [sheetId, row, column] = key.split(":");
    let sheet = grid.sheets.find(candidate => candidate.id === Number(sheetId));
    if (!sheet) continue;
    let r = positionOf(sheet.rows, row);
    let c = positionOf(sheet.columns, column);
    if (r === undefined || c === undefined) continue;
    if (cells.some(area => area.sheetId === sheet.id && within(area.rect, r, c))) after.add(entry.by);
  }
  // A copy holds what is queued for its original as the batch copies it, so a copy of a copy the
  // batch made holds that copy's.
  if (grid.cells.size > 0 && planned.some(change => change.op === "duplicateSheet")) {
    let work = working(grid);
    planned.forEach((change, i) => {
      if (change.op === "duplicateSheet") {
        for (let key of keysOn(work, change.sheetId)) {
          let by = work.cells.get(key)?.by;
          if (by) after.add(by);
        }
      }
      applyOne(work, change, 0, unexpected(i, change));
    });
  }
  let addressed = new Set(guardedSheets(planned));
  // A formula names rows, columns and sheets as earlier structure leaves them, on any sheet, as do
  // those a copy takes from its original and those the guard digests, so a batch with one depends
  // on every structural change queued before it. A copy also takes the formatting queued for its
  // original, which records no change it came from, so it depends on every formatting change too.
  let copies = planned.some(change => change.op === "duplicateSheet");
  let formulas = guardsFormula || copies ||
    planned.some(change => change.op === "writeCells" && change.values.some(row => row.some(isFormula)));
  let places = placesSheet(planned);
  for (let { id, action } of pending) {
    if (action.payload.changes.some(change => (copies && change.op === "formatCells") ||
      structuralSheets(change).some(sheetId => formulas || addressed.has(sheetId)) ||
      (places && (placesSheet([change]) || change.op === "deleteSheet")))) {
      after.add(id);
    }
  }
  return [...after].toSorted((a, b) => a - b);
}

/** Titles for the approver of each sheet `planned` acts on, as `grid` has them, or creates. */
export function sheetLabels(grid: Grid, planned: readonly PlannedChange[]): Record<string, string> {
  let labels = new Map<number, string>();
  let label = (sheetId: number, title: string | undefined) => {
    if (title !== undefined && !labels.has(sheetId)) labels.set(sheetId, title);
  };
  for (let change of planned) {
    if (change.op === "addSheet") label(change.sheetId, change.title);
    else label(change.sheetId, grid.sheets.find(sheet => sheet.id === change.sheetId)?.title);
    if (change.op === "duplicateSheet") label(change.newSheetId, change.title);
  }
  return Object.fromEntries(labels);
}

function within({ startRow, endRow, startColumn, endColumn }: Rect, row: number, column: number): boolean {
  return row >= startRow && row < endRow && column >= startColumn && column < endColumn;
}

// The protected range's cells by name, where its ends are bounded.
function protectionName(protection: SheetProtection, title: string): string {
  let { rect } = protection.area;
  if ([rect.endRow, rect.endColumn].every(Number.isFinite)) return `the protected range ${a1Of(title, rect)}`;
  return `a protected range of "${title}"`;
}

/**
 * Refuses a change writing or formatting a cell Google holds that is in a protected range the
 * connected account may not edit, and that the range does not leave editable, and any change to
 * the rows, columns or tab of a sheet holding such a range. Cells of lines queued changes insert
 * are not protected. A range that only warns is no obstacle: Google warns in its own editor, but
 * lets the API write it.
 * Throws `Error`.
 */
export function checkProtections(
  metadata: { sheets: readonly SheetMeta[]; protectedRanges: readonly SheetProtection[] },
  grid: Grid, planned: readonly PlannedChange[],
): void {
  let locked = metadata.protectedRanges.filter(protection =>
    !protection.requestingUserCanEdit && !protection.warningOnly);
  if (locked.length === 0) return;
  let work = working(grid);
  planned.forEach((change, i) => {
    let label = `Change ${i + 1} (${change.op})`;
    let sheet = work.sheets.find(candidate => candidate.id === change.sheetId);
    let source = sheet?.source;
    let protections = locked.filter(protection => protection.area.sheetId === source);
    if (sheet && source !== undefined && protections.length > 0) {
      let title = metadata.sheets.find(candidate => candidate.id === source)?.title ?? sheet.title;
      if (!isRangeChange(change)) {
        throw new Error(`${label}: "${sheet.title}" holds ${protectionName(protections[0], title)}, which ` +
          "the connected account may not edit, so its rows, columns and tab cannot be changed.");
      }
      let { rect } = change;
      let rows = linesAt(sheet.rows, rect.startRow, rect.endRow).map(row => row === undefined ? undefined : baseIndexOf(row));
      let columns = linesAt(sheet.columns, rect.startColumn, rect.endColumn).map(column => column === undefined ? undefined : baseIndexOf(column));
      for (let protection of protections) {
        rows.forEach((row, r) => columns.forEach((column, c) => {
          if (row === undefined || column === undefined || !within(protection.area.rect, row, column)) return;
          let editable = protection.unprotected.some(area => area.sheetId === source && within(area.rect, row, column));
          if (editable) return;
          throw new Error(`${label}: ${cellName(rect.startRow + r, rect.startColumn + c)} is in ` +
            `${protectionName(protection, title)}, which the connected account may not edit.`);
        }));
      }
    }
    applyOne(work, change, 0, unexpected(i, change));
  });
}

// A cell as the digest encodes it: text, numbers, booleans and blanks as themselves, a formula or
// an error tagged, so no two kinds of value encode alike.
function digested(value: EnteredValue): unknown {
  if (value === null || typeof value !== "object") return value;
  return "formula" in value ? ["f", compactFormula(value.formula)] : ["e", value.error];
}

/**
 * A hex SHA-256 of what a batch overwrites or removes: the size and title of each sheet in
 * `guard.sheetIds`, the cells of each of `guard.cells` as entered (`entered[i]`, those of
 * `guard.cells[i]`), and with `guard.order` every sheet's ID in index order, hidden ones included,
 * since where a batch places a sheet counts them. Whitespace in a formula is ignored, since Google
 * may change it in a formula nobody edits; text is digested exactly.
 */
export async function guardDigest(
  sheets: readonly SheetMeta[],
  guard: { sheetIds: readonly number[]; cells: readonly SheetArea[]; order?: boolean },
  entered: readonly (readonly (readonly EnteredValue[])[])[],
): Promise<string> {
  let described = guard.sheetIds.map(id => {
    let sheet = sheets.find(candidate => candidate.id === id);
    return sheet ? [id, sheet.title, sheet.rowCount, sheet.columnCount] : [id, null];
  });
  let cells = guard.cells.map(({ rect }, i) => {
    let values: unknown[] = [];
    for (let row = rect.startRow; row < rect.endRow; row++) {
      for (let column = rect.startColumn; column < rect.endColumn; column++) {
        values.push(digested(entered[i]?.[row - rect.startRow]?.[column - rect.startColumn] ?? null));
      }
    }
    return values;
  });
  let order = guard.order ? [sheets.toSorted((a, b) => a.index - b.index).map(({ id }) => id)] : [];
  let bytes = new TextEncoder().encode(JSON.stringify([described, cells, ...order]));
  let digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}
