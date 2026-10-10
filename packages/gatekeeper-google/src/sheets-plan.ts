/**
 * `updateSheet()` changes: where each lands, their replay over a grid, the requests that make
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
import { a1Of, cellName, columnLetters, findSheet, isFormula, type Rect } from "./sheets-model";
import type { SheetBorder, SheetColor } from "./sheets-read-types";
import type {
  Entry, Grid, PlannedChange, QueuedChange, SheetMeta, SimSheet, StructuralStep,
} from "./sheets-simulation";
import {
  baseIndexOf, deleteLines, insertLines, lineAt, lineCount, linesAt, positionOf, type Lines,
} from "./sheets-structure";
import type { SheetCellInput, SheetFormatChange, SheetTarget } from "./sheets-types";
import { ChangeConflict } from "./slides-text";

/** The rows of a sheet added with none given, as in Google Sheets. */
export const DEFAULT_ROW_COUNT = 1000;
/** The columns of a sheet added with none given, as in Google Sheets. */
export const DEFAULT_COLUMN_COUNT = 26;
/** The most cells a batch may overwrite or delete, which its guard covers. */
export const MAX_GUARDED_CELLS = 50_000;
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

/** A grid being changed in place, which no one else holds. */
type Working = {
  sheets: SimSheet[]; cells: Map<string, Entry>; formats: Map<string, FormatEntry>; log: StructuralStep[];
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

// `sheets` with `sheet` placed at its index and those from there on one along, as Google inserts one.
function placed(sheets: readonly SimSheet[], sheet: SimSheet): SimSheet[] {
  return [...sheets.map(other => other.index >= sheet.index ? { ...other, index: other.index + 1 } : other), sheet]
    .toSorted((a, b) => a.index - b.index);
}

function removed(sheets: readonly SimSheet[], gone: SimSheet): SimSheet[] {
  return sheets.flatMap(other => other.id === gone.id ? []
    : [other.index > gone.index ? { ...other, index: other.index - 1 } : other]);
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
    let [group, name] = FORMAT_PATHS[field].split(".");
    if (name === undefined) {
      paths.push(group);
      if (value !== null) userEnteredFormat[group] = formatValue(field, value);
    } else {
      textPaths.push(name);
      if (value !== null) text[name] = formatValue(field, value);
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
    work.formats.set(key, change(work.formats.get(key) ?? { set: {}, borders: {} }));
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
  let beside = (rowAt: number, columnAt: number, side: BorderSide) => {
    let row = rowAt < 0 ? undefined : lineAt(sheet.rows, rowAt);
    let column = columnAt < 0 ? undefined : lineAt(sheet.columns, columnAt);
    if (row === undefined || column === undefined) return;
    update(row, column, entry => ({ ...entry, borders: { ...entry.borders, [side]: null } }));
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

  switch (change.op) {
    case "writeCells":
    case "clearRange":
    case "formatCells": {
      let sheet = existing(change.sheetId);
      let { rect } = change;
      let outside = outsideCell(sheet, rect);
      if (outside !== undefined) throw conflict(`${outside} is outside "${sheet.title}"`);
      let range = gridRange(change.sheetId, rect);
      if (change.op === "formatCells") {
        recordFormat(work, sheet, rect, change.format);
        return formatRequests(range, change.format);
      }
      let rows = linesAt(sheet.rows, rect.startRow, rect.endRow);
      let columns = linesAt(sheet.columns, rect.startColumn, rect.endColumn);
      rows.forEach((row, r) => columns.forEach((column, c) => {
        let input = change.op === "writeCells" ? change.values[r][c] : null;
        work.cells.set(cellKey(sheet.id, row!, column!), { input, at: work.log.length, by });
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
      work.sheets = placed(work.sheets, {
        id: newSheetId, title, index, rowCount: source.rowCount, columnCount: source.columnCount,
        rows: source.rows, columns: source.columns,
        ...(source.source === undefined ? {} : { source: source.source }),
      });
      // The copy holds what is queued for the original, and its cells move with its own lines. The
      // keys added name the copy, so the loop skips them.
      for (let map of byCell(work)) {
        for (let [key, entry] of map) {
          let [sheetId, row, column] = key.split(":");
          if (Number(sheetId) === source.id) map.set(cellKey(newSheetId, row, column), entry);
        }
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
      for (let map of byCell(work)) {
        for (let key of map.keys()) {
          if (Number(key.split(":")[0]) === sheet.id) map.delete(key);
        }
      }
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
      let deleted = new Set(linesAt(lines, change.start, change.start + change.count));
      let part = axis === "rows" ? 1 : 2;
      for (let map of byCell(work)) {
        for (let key of map.keys()) {
          let parts = key.split(":");
          if (Number(parts[0]) === sheet.id && deleted.has(parts[part])) map.delete(key);
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
 * Walks `prepared` over `grid` as each change leaves it, finding the sheet each acts on: a range's
 * by the title it then has, any other change's by ID or by the ref an earlier change gave the
 * sheet it adds. Fills in what a change leaves to its default, gives each sheet added an ID from
 * `mint` that no sheet has, and writes formulas' references as Google stores them. Returns the
 * changes and, for each ref, the ID of the sheet it names. Throws `Error` for a change Google
 * would refuse, or one that would delete what the guard cannot cover.
 */
export function resolveChanges(
  grid: Grid, prepared: readonly PreparedChange[], mint: () => number,
): { planned: PlannedChange[]; refs: Record<string, number> } {
  let work = working(grid);
  let refs = new Map<string, number>();
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

  let planned = prepared.map((change, i): PlannedChange => {
    let label = `Change ${i + 1} (${change.op})`;
    let sheetFor = (target: SheetTarget): SimSheet => {
      let id = typeof target === "number" ? target : refs.get(target);
      if (id === undefined) throw new Error(`${label}: no earlier change gives a sheet the ref "${target}".`);
      let sheet = work.sheets.find(candidate => candidate.id === id);
      if (sheet) return sheet;
      throw new Error(typeof target === "number"
        ? `${label}: the spreadsheet has no sheet with ID ${id}. Call getSpreadsheet() for sheet IDs.`
        : `${label}: the sheet ref "${target}" names is deleted by an earlier change.`);
    };
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
          let sheetId = fresh();
          if (change.ref !== undefined) refs.set(change.ref, sheetId);
          return { op: "addSheet", sheetId, title: change.title, index, rowCount, columnCount };
        }
        case "renameSheet": {
          let sheet = sheetFor(change.sheetId);
          titleFree(change.title, sheet.id);
          return { op: "renameSheet", sheetId: sheet.id, title: change.title };
        }
        case "duplicateSheet": {
          let source = sheetFor(change.sheetId);
          let title = change.title ?? `Copy of ${source.title}`;
          if (title.length > MAX_TITLE_LENGTH) {
            throw new Error(`${label}: "${title}" would be over ${MAX_TITLE_LENGTH} characters; give the copy ` +
              "a title.");
          }
          titleFree(title);
          let index = change.index ?? source.index + 1;
          placeable(index);
          fits(source.rowCount * source.columnCount);
          let newSheetId = fresh();
          if (change.ref !== undefined) refs.set(change.ref, newSheetId);
          return { op: "duplicateSheet", sheetId: source.id, newSheetId, title, index };
        }
        case "deleteSheet": {
          let sheet = sheetFor(change.sheetId);
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
          return resolveLines(change, sheetFor(change.sheetId), label, fits);
      }
    })();
    applyOne(work, next, 0, unexpected(i, next));
    return next;
  });
  return { planned, refs: Object.fromEntries(refs) };
}

function resolveCells(
  work: Working, change: Extract<PreparedChange, { op: "writeCells" | "clearRange" | "formatCells" }>,
  label: string,
): PlannedChange {
  let sheet = findSheet(work.sheets, change.sheet);
  if (!sheet) {
    throw new Error(`${label}: the spreadsheet has no sheet named "${change.sheet}". Call ` +
      "getSpreadsheet() for sheet titles.");
  }
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
  let frozen = (axis === "rows" ? sheet.frozenRowCount : sheet.frozenColumnCount) ?? 0;
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
  return { grid: work, requests };
}

// Runs of consecutive positions, leaving out those undefined.
function runsOf(positions: readonly (number | undefined)[]): { start: number; end: number }[] {
  let runs: { start: number; end: number }[] = [];
  for (let position of positions) {
    if (position === undefined) continue;
    let last = runs.at(-1);
    if (last && last.end === position) last.end++;
    else runs.push({ start: position, end: position + 1 });
  }
  return runs;
}

// The cells `rect` of `sheet` covers as they were in `original`, the same sheet before the batch,
// in as few rectangles as lines the batch inserted leave possible.
function mappedBack(original: SimSheet, sheet: SimSheet, rect: Rect): SheetArea[] {
  let rows = runsOf(linesAt(sheet.rows, rect.startRow, rect.endRow)
    .map(row => row === undefined ? undefined : positionOf(original.rows, row)));
  let columns = runsOf(linesAt(sheet.columns, rect.startColumn, rect.endColumn)
    .map(column => column === undefined ? undefined : positionOf(original.columns, column)));
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

/**
 * What a batch's guard covers: the sheets it acts on, and its cells, which a batch queued before
 * the guard named them leaves to be those its changes write.
 */
export function guardOf(batch: {
  changes: readonly PlannedChange[]; guard: { cells?: readonly SheetArea[] };
}): { sheetIds: number[]; cells: SheetArea[] } {
  return {
    sheetIds: guardedSheets(batch.changes),
    cells: batch.guard.cells
      ? [...batch.guard.cells]
      : batch.changes.filter(isCellChange).map(({ sheetId, rect }) => ({ sheetId, rect })),
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
 * entered what `cells` of `grid` hold, and those changing rows, columns or sheets of a sheet the
 * batch acts on.
 */
export function guardAfter(
  grid: Grid, pending: readonly QueuedChange[], planned: readonly PlannedChange[],
  cells: readonly SheetArea[],
): number[] {
  let after = new Set<number>();
  if (grid.cells.size > 0) {
    for (let { sheetId, rect } of cells) {
      let sheet = grid.sheets.find(candidate => candidate.id === sheetId);
      if (!sheet) continue;
      let columns = linesAt(sheet.columns, rect.startColumn, rect.endColumn);
      for (let row of linesAt(sheet.rows, rect.startRow, rect.endRow)) {
        for (let column of columns) {
          let entry = row === undefined || column === undefined
            ? undefined : grid.cells.get(cellKey(sheetId, row, column));
          if (entry && entry.by !== 0) after.add(entry.by);
        }
      }
    }
  }
  let addressed = new Set(guardedSheets(planned));
  // A formula names rows, columns and sheets as earlier structure leaves them, on any sheet, so a
  // batch with one depends on every structural change queued before it.
  let formulas = planned.some(change => change.op === "writeCells" && change.values.some(row => row.some(isFormula)));
  for (let { id, action } of pending) {
    if (action.payload.changes.some(change => structuralSheets(change).some(sheetId =>
      formulas || addressed.has(sheetId)))) {
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
 * connected account may not edit, and that the range does not leave editable, and any change to the rows, columns or
 * tab of a sheet holding such a range. Cells of lines queued changes insert are not protected.
 * Throws `Error`.
 */
export function checkProtections(
  metadata: { sheets: readonly SheetMeta[]; protectedRanges: readonly SheetProtection[] },
  grid: Grid, planned: readonly PlannedChange[],
): void {
  let locked = metadata.protectedRanges.filter(protection => !protection.requestingUserCanEdit);
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

/**
 * A hex SHA-256 of what a batch overwrites or removes: the size and title of each sheet in
 * `guard.sheetIds`, and the cells of each of `guard.cells` as entered (`entered[i]`, the values of
 * `guard.cells[i]` in formula mode). Whitespace in formulas is ignored, since Google may change
 * it in a formula nobody edits.
 */
export async function guardDigest(
  sheets: readonly SheetMeta[],
  guard: { sheetIds: readonly number[]; cells: readonly SheetArea[] },
  entered: readonly (readonly (readonly SheetCellInput[])[])[],
): Promise<string> {
  let described = guard.sheetIds.map(id => {
    let sheet = sheets.find(candidate => candidate.id === id);
    return sheet ? [id, sheet.title, sheet.rowCount, sheet.columnCount] : [id, null];
  });
  let cells = guard.cells.map(({ rect }, i) => {
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
