/**
 * A spreadsheet drawn for the person deciding its queued changes, as it will be once they apply
 * (see `Gatekeeper.previewResource()`).
 *
 * The drawing reuses the simulated reads: queued changes are replayed over the spreadsheet's
 * metadata, and each area drawn is read as a formatted read, a formula read and a format read with
 * them applied. So a cell shows what an agent would read there, and what only Google can work out
 * (a queued formula's result, a value in a queued number format, the formatting Google gives an
 * inserted line) is left out rather than guessed.
 *
 * Cells are drawn as Google draws them: the format read starts from each cell's effective format,
 * conditional formatting included, with what queued changes set over it, and the drawing carries
 * each cell's font, the sizes of rows and columns, which are hidden, merges, frozen lines and
 * hidden gridlines. Not drawn: alternating colours (banding) and tables' styles, which Google
 * leaves out of effective formats; rich text within a cell; and how Google will resize a row once
 * a queued change wraps or enlarges its text.
 *
 * Each cell a queued change enters a value in, or formats, names the last change that did, so a
 * surface can mark it. Lines a change deletes are drawn where they stood, with what they hold now
 * and the change that deletes them. What else changes to rows, columns and sheets do is shown by
 * the sheets' list and by inserted lines, not by marks, since nothing records which change made them.
 *
 * The areas drawn are those the queued changes enter or format, and the lines they insert or delete, each
 * with a few rows and columns around it, nearby ones merged. They are bounded as a simulated read
 * is, and smaller: when they would be more, later ones are left out, and a change none of whose
 * cells is drawn is listed as omitted.
 */

import type {
  ResourcePreview, SpreadsheetArea, SpreadsheetBorder, SpreadsheetCell, SpreadsheetCellFormat,
  SpreadsheetDeletedLines, SpreadsheetPreview,
} from "@gadgets/workshop-shared/gatekeeper";
import type { PreviewCells, SheetArea, SpreadsheetMetadata } from "./sheets-api";
import { mergeFormat } from "./sheets-format";
import { cellName, findSheet, isFormula, type EnteredValue, type Rect } from "./sheets-model";
import { cellKey } from "./sheets-plan";
import type { SheetBorder, SheetCellFormat } from "./sheets-read-types";
import { baseIndexOf, basePieces, linesAt, positionOf, type Lines } from "./sheets-structure";
import {
  applyChange, basePiecesOf, conflictReason, gridOf, holdsFormula, insertedLine, MAX_READ_PIECES, MAX_REWRITE_WORK,
  replayChanges, rewriteWork, simulatedFormats, simulatedRange, SimulatedTextTooLong, textBudget,
  UnsimulatedFormula, type Grid, type QueuedChange, type SimSheet,
} from "./sheets-simulation";

/** Rows of context drawn above and below what queued changes touch. */
export const CONTEXT_ROWS = 3;
/** Columns of context drawn either side of what queued changes touch. */
export const CONTEXT_COLUMNS = 2;
/** The area drawn of the first sheet when no queued change touches a cell. */
export const EMPTY_PREVIEW = { rows: 30, columns: 12 };
/**
 * The most of a sheet drawn whole, from A1: a sheet whose changes all fall within it is shown as
 * the person knows it, from its top, rather than as windows onto the changed cells.
 */
export const WHOLE_SHEET = { rows: 100, columns: 26 };
/** The most cells one area shows; a larger one keeps its top left. */
export const MAX_AREA = { rows: 60, columns: 20 };
/**
 * The most cells a preview draws in all, well under what a simulated read may fetch: each is read
 * as entered, as displayed and with its effective format, borders included, in an answer capped at
 * 5 MiB. A fully formatted cell costs about 700 bytes of it.
 */
export const MAX_PREVIEW_CELLS = 5_000;
// How far along an inserted row, or down an inserted column, it is drawn.
const INSERTED_BAND = { rows: 10, columns: 12 };
/** The most lines of one run of deleted lines drawn; the rest are counted. */
export const DELETED_SHOWN = 5;
// The sizes Google gives a column and a row by default, in pixels, for a line whose size was not
// read, such as one a queued change inserts.
const DEFAULT_COLUMN_WIDTH = 100;
const DEFAULT_ROW_HEIGHT = 21;

const TOO_MANY = "There are too many queued changes to draw at once, so this one is not shown.";
const UNDRAWABLE = "This change touches cells that cannot be drawn with the queued changes to rows, " +
  "columns and sheets applied.";

/** A cell a queued change entered or formatted, at its position once the changes apply. */
type Mark = { sheetId: number; row: number; column: number; by: number };

/**
 * Lines `start` to `start + count - 1` of a sheet Google holds, which queued change `by` deletes,
 * and `at`, the position of the line they stood just before once the changes apply.
 */
export type Deletion = {
  sheetId: number; axis: "rows" | "columns"; start: number; count: number; by: number; at: number;
};

type Range = { start: number; end: number };

// The lines below `count` of the sheet Google holds that `lines` no longer has, in order. Lines
// are only inserted and deleted, never moved, so those it has stay in order.
function missing(lines: Lines, count: number): Range[] {
  let gaps: Range[] = [];
  let next = 0;
  for (let run of lines) {
    if (run.kind !== "base") continue;
    if (run.start > next) gaps.push({ start: next, end: run.start });
    next = run.start + run.length;
  }
  if (next < count) gaps.push({ start: next, end: count });
  return gaps;
}

// `ranges` less `taken`, a subset of them, both in order.
function without(ranges: readonly Range[], taken: readonly Range[]): Range[] {
  let left: Range[] = [];
  for (let range of ranges) {
    let from = range.start;
    for (let cut of taken) {
      if (cut.end <= from || cut.start >= range.end) continue;
      if (cut.start > from) left.push({ start: from, end: cut.start });
      from = Math.max(from, cut.end);
    }
    if (from < range.end) left.push({ start: from, end: range.end });
  }
  return left;
}

// Where in `lines` the deleted line `index` of the sheet Google holds stood: just before the
// first line Google holds after it that is kept, else just after the last kept before it.
function deletedAt(lines: Lines, index: number): number {
  let position = 0;
  let afterKept = 0;
  for (let run of lines) {
    if (run.kind === "base" && run.start > index) return position;
    position += run.length;
    if (run.kind === "base") afterKept = position;
  }
  return afterKept;
}

/**
 * The lines of sheets Google holds that `pending` delete, each run by the change that deletes it,
 * placed in `grid`, what they leave. A sheet a change deletes is not counted: its tab says so.
 */
export function deletionsOf(metadata: SpreadsheetMetadata, pending: readonly QueuedChange[], grid: Grid): Deletion[] {
  let held = new Map(metadata.sheets.map(sheet => [sheet.id, sheet]));
  let final = new Map(grid.sheets.map(sheet => [sheet.id, sheet]));
  let deletions: Deletion[] = [];
  let before = gridOf(metadata);
  for (let { id, action } of pending) {
    let after = applyChange(before, action, id);
    for (let sheet of after.sheets) {
      let was = before.sheets.find(candidate => candidate.id === sheet.id);
      let size = held.get(sheet.id);
      let last = final.get(sheet.id);
      if (!was || !size || !last || sheet.source !== sheet.id) continue;
      for (let axis of ["rows", "columns"] as const) {
        if (was[axis] === sheet[axis]) continue;
        let count = axis === "rows" ? size.rowCount : size.columnCount;
        for (let { start, end } of without(missing(sheet[axis], count), missing(was[axis], count))) {
          deletions.push({ sheetId: sheet.id, axis, start, count: end - start, by: id, at: deletedAt(last[axis], start) });
        }
      }
    }
    before = after;
  }
  return deletions.toSorted((a, b) => a.sheetId - b.sheetId || a.start - b.start);
}

// The deletions `area` of `grid` draws: those standing within it, or at the end of its sheet.
function deletionsIn(grid: Grid, area: SheetArea, deletions: readonly Deletion[]): Deletion[] {
  let sheet = grid.sheets.find(candidate => candidate.id === area.sheetId);
  if (!sheet) return [];
  let { rect } = area;
  return deletions.filter(deletion => {
    if (deletion.sheetId !== area.sheetId) return false;
    let [start, end, total] = deletion.axis === "rows"
      ? [rect.startRow, rect.endRow, sheet.rowCount] : [rect.startColumn, rect.endColumn, sheet.columnCount];
    return deletion.at >= start && (deletion.at < end || (deletion.at === end && end === total));
  });
}

// What a preview reads of the sheets Google holds to draw the lines `areas` show deleted.
function deletedPieces(grid: Grid, areas: readonly SheetArea[], deletions: readonly Deletion[]): SheetArea[] {
  return areas.flatMap(area => {
    let sheet = grid.sheets.find(candidate => candidate.id === area.sheetId)!;
    let { rect } = area;
    return deletionsIn(grid, area, deletions).flatMap(deletion => {
      let lines = { start: deletion.start, end: deletion.start + Math.min(deletion.count, DELETED_SHOWN) };
      let across = deletion.axis === "rows"
        ? basePieces(sheet.columns, rect.startColumn, rect.endColumn)
        : basePieces(sheet.rows, rect.startRow, rect.endRow);
      return across.map(piece => ({
        sheetId: sheet.source!,
        rect: deletion.axis === "rows"
          ? { startRow: lines.start, endRow: lines.end, startColumn: piece.start, endColumn: piece.start + piece.length }
          : { startRow: piece.start, endRow: piece.start + piece.length, startColumn: lines.start, endColumn: lines.end },
      }));
    });
  });
}

// What a preview reads of the sheets Google holds to draw `areas` of `grid`.
function piecesOf(grid: Grid, areas: readonly SheetArea[], deletions: readonly Deletion[]): SheetArea[] {
  return [...basePiecesOf(grid, areas), ...deletedPieces(grid, areas, deletions)];
}

/**
 * The cells the changes `grid` replays entered or formatted, at their positions in it, with the
 * change that did so last.
 */
function marksOf(grid: Grid): Mark[] {
  let sheets = new Map(grid.sheets.map(sheet => [sheet.id, sheet]));
  let marks: Mark[] = [];
  for (let map of [grid.cells, grid.formats]) {
    for (let [key, entry] of map) {
      let [sheetId, row, column] = key.split(":");
      let sheet = sheets.get(Number(sheetId));
      if (!sheet) continue;
      let r = positionOf(sheet.rows, row);
      let c = positionOf(sheet.columns, column);
      if (r !== undefined && c !== undefined) marks.push({ sheetId: sheet.id, row: r, column: c, by: entry.by ?? 0 });
    }
  }
  return marks;
}

// Groups `marks`, all of one sheet, into rectangles whose padded areas would overlap: rows near
// each other into bands, and within a band, columns near each other.
function clusters(marks: Mark[]): Rect[] {
  let rects: Rect[] = [];
  let byRow = marks.toSorted((a, b) => a.row - b.row);
  let start = 0;
  for (let i = 1; i <= byRow.length; i++) {
    if (i < byRow.length && byRow[i].row - byRow[i - 1].row <= 2 * CONTEXT_ROWS + 1) continue;
    let band = byRow.slice(start, i).toSorted((a, b) => a.column - b.column);
    let first = 0;
    for (let j = 1; j <= band.length; j++) {
      if (j < band.length && band[j].column - band[j - 1].column <= 2 * CONTEXT_COLUMNS + 1) continue;
      let group = band.slice(first, j);
      rects.push({
        startRow: group.reduce((least, mark) => Math.min(least, mark.row), Infinity),
        endRow: group.reduce((most, mark) => Math.max(most, mark.row), -Infinity) + 1,
        startColumn: group[0].column,
        endColumn: group.at(-1)!.column + 1,
      });
      first = j;
    }
    start = i;
  }
  return rects;
}

// The rows and columns queued inserts added to `sheet`, each as the band of it drawn.
function insertedBands(grid: Grid, sheet: SimSheet): Rect[] {
  let bands: Rect[] = [];
  let runs = (lines: SimSheet["rows"], band: (start: number, end: number) => Rect) => {
    let position = 0;
    for (let run of lines) {
      if (run.kind === "new" && grid.log[run.id]?.kind === "insert") {
        bands.push(band(position, position + run.length));
      }
      position += run.length;
    }
  };
  runs(sheet.rows, (startRow, endRow) =>
    ({ startRow, endRow, startColumn: 0, endColumn: Math.min(sheet.columnCount, INSERTED_BAND.columns) }));
  runs(sheet.columns, (startColumn, endColumn) =>
    ({ startRow: 0, endRow: Math.min(sheet.rowCount, INSERTED_BAND.rows), startColumn, endColumn }));
  return bands;
}

// Where `deletions` of `sheet` stood, each as a line of no size there, drawn as an inserted band is.
function deletedBands(deletions: readonly Deletion[], sheet: SimSheet): Rect[] {
  return deletions.filter(deletion => deletion.sheetId === sheet.id).map(({ axis, at }) => axis === "rows"
    ? { startRow: at, endRow: at, startColumn: 0, endColumn: Math.min(sheet.columnCount, INSERTED_BAND.columns) }
    : { startRow: 0, endRow: Math.min(sheet.rowCount, INSERTED_BAND.rows), startColumn: at, endColumn: at });
}

// `rect` with its context, within `sheet`, and no larger than an area may be.
function padded(rect: Rect, sheet: SimSheet): Rect {
  let startRow = Math.max(0, rect.startRow - CONTEXT_ROWS);
  let startColumn = Math.max(0, rect.startColumn - CONTEXT_COLUMNS);
  return limited({
    startRow,
    endRow: Math.min(sheet.rowCount, rect.endRow + CONTEXT_ROWS),
    startColumn,
    endColumn: Math.min(sheet.columnCount, rect.endColumn + CONTEXT_COLUMNS),
  });
}

function limited(rect: Rect): Rect {
  return {
    ...rect,
    endRow: Math.min(rect.endRow, rect.startRow + MAX_AREA.rows),
    endColumn: Math.min(rect.endColumn, rect.startColumn + MAX_AREA.columns),
  };
}

// `sheet` from A1 to just past everything in `rects`, if that is no more than a sheet drawn whole.
function wholeSheet(sheet: SimSheet, rects: readonly Rect[]): Rect | undefined {
  if (rects.length === 0) return undefined;
  let endRow = Math.min(sheet.rowCount,
    Math.max(EMPTY_PREVIEW.rows, ...rects.map(rect => rect.endRow + CONTEXT_ROWS)));
  let endColumn = Math.min(sheet.columnCount,
    Math.max(EMPTY_PREVIEW.columns, ...rects.map(rect => rect.endColumn + CONTEXT_COLUMNS)));
  if (endRow > WHOLE_SHEET.rows || endColumn > WHOLE_SHEET.columns) return undefined;
  return { startRow: 0, endRow, startColumn: 0, endColumn };
}

// Whether `a` and `b` overlap or touch.
function meet(a: SheetArea, b: SheetArea): boolean {
  return a.sheetId === b.sheetId &&
    a.rect.startRow <= b.rect.endRow && b.rect.startRow <= a.rect.endRow &&
    a.rect.startColumn <= b.rect.endColumn && b.rect.startColumn <= a.rect.endColumn;
}

// `areas` with `area` added, merged with every one it meets.
function withArea(areas: readonly SheetArea[], area: SheetArea): SheetArea[] {
  let rest = [...areas];
  let merged = area;
  for (let i = rest.findIndex(other => meet(other, merged)); i >= 0; i = rest.findIndex(other => meet(other, merged))) {
    let { rect } = rest.splice(i, 1)[0];
    merged = {
      sheetId: merged.sheetId,
      rect: limited({
        startRow: Math.min(rect.startRow, merged.rect.startRow),
        endRow: Math.max(rect.endRow, merged.rect.endRow),
        startColumn: Math.min(rect.startColumn, merged.rect.startColumn),
        endColumn: Math.max(rect.endColumn, merged.rect.endColumn),
      }),
    };
  }
  return [...rest, merged];
}

function cells(rect: Rect): number {
  return (rect.endRow - rect.startRow) * (rect.endColumn - rect.startColumn);
}

// Whether `areas` of `grid` are few and small enough to draw.
function fits(grid: Grid, areas: readonly SheetArea[], deletions: readonly Deletion[]): boolean {
  let read = piecesOf(grid, areas, deletions);
  return read.reduce((total, { rect }) => total + cells(rect), 0) <= MAX_PREVIEW_CELLS &&
    read.length <= MAX_READ_PIECES;
}

/**
 * The areas of `grid` a preview draws, sheets in tab order, and `marks`, the cells queued changes
 * touch: around each run of marked cells, each inserted band and where each of `deletions` stood,
 * padded with context, nearby ones merged, as many as fit; without any, the top left of the first
 * visible sheet.
 */
export function previewAreas(
  grid: Grid, { whole = true, deletions = [] }: { whole?: boolean; deletions?: readonly Deletion[] } = {},
): { areas: SheetArea[]; marks: Mark[] } {
  let marks = marksOf(grid);
  let order = new Map(grid.sheets.map((sheet, i) => [sheet.id, i]));
  let candidates = grid.sheets.flatMap(sheet => {
    let rects = [
      ...clusters(marks.filter(mark => mark.sheetId === sheet.id)), ...insertedBands(grid, sheet),
      ...deletedBands(deletions, sheet),
    ];
    let top = whole && wholeSheet(sheet, rects);
    if (top) return [{ sheetId: sheet.id, rect: top }];
    return rects.map(rect => ({ sheetId: sheet.id, rect: padded(rect, sheet) }))
      .filter(({ rect }) => cells(rect) > 0)
      .toSorted((a, b) => a.rect.startRow - b.rect.startRow || a.rect.startColumn - b.rect.startColumn);
  });
  let areas: SheetArea[] = [];
  for (let candidate of candidates) {
    let next = withArea(areas, candidate);
    if (fits(grid, next, deletions)) areas = next;
  }
  if (areas.length === 0) {
    let first = findSheet(grid.sheets, undefined);
    let size = whole ? WHOLE_SHEET : EMPTY_PREVIEW;
    let rect = first && {
      startRow: 0, endRow: Math.min(first.rowCount, size.rows),
      startColumn: 0, endColumn: Math.min(first.columnCount, size.columns),
    };
    if (first && rect && cells(rect) > 0) areas = [{ sheetId: first.id, rect }];
  }
  areas.sort((a, b) => order.get(a.sheetId)! - order.get(b.sheetId)! ||
    a.rect.startRow - b.rect.startRow || a.rect.startColumn - b.rect.startColumn);
  return { areas, marks };
}

/** How Sheets draws a cell whose spreadsheet sets no default format of its own. */
const STANDARD_FORMAT: SpreadsheetCellFormat = {
  bold: false, italic: false, underline: false, strikethrough: false, fontFamily: "Arial", fontSize: 10,
  textColor: "#000000", backgroundColor: "#ffffff", verticalAlignment: "bottom", wrapStrategy: "overflow",
};

const BORDER_STYLES: Record<SheetBorder["style"], SpreadsheetBorder["style"]> = {
  SOLID: "solid", SOLID_MEDIUM: "medium", SOLID_THICK: "thick", DASHED: "dashed", DOTTED: "dotted",
  DOUBLE: "double",
};

/**
 * `format`, as a format read or replay gives it, as a surface draws it, with `fontFamily`: a
 * theme colour resolved by `themeColor`, and left out if the theme does not give it.
 */
function drawnFormat(
  format: SheetCellFormat | null, fontFamily: string | undefined, themeColor: (name: string) => string | undefined,
): SpreadsheetCellFormat {
  let color = (value: string | undefined) =>
    value === undefined ? undefined : value.startsWith("#") ? value.toLowerCase() : themeColor(value);
  let drawn: SpreadsheetCellFormat = {};
  fontFamily = fontName(fontFamily);
  if (!format) return fontFamily === undefined ? drawn : { fontFamily };
  for (let field of ["bold", "italic", "underline", "strikethrough"] as const) {
    if (format[field] !== undefined) drawn[field] = format[field];
  }
  if (fontFamily !== undefined) drawn.fontFamily = fontFamily;
  if (format.fontSize !== undefined) drawn.fontSize = format.fontSize;
  let textColor = color(format.textColor);
  if (textColor) drawn.textColor = textColor;
  let backgroundColor = color(format.fillColor);
  if (backgroundColor) drawn.backgroundColor = backgroundColor;
  if (format.horizontalAlignment) {
    drawn.horizontalAlignment = format.horizontalAlignment.toLowerCase() as "left" | "center" | "right";
  }
  if (format.verticalAlignment) {
    drawn.verticalAlignment = format.verticalAlignment.toLowerCase() as "top" | "middle" | "bottom";
  }
  if (format.wrap) drawn.wrapStrategy = format.wrap.toLowerCase() as "overflow" | "wrap" | "clip";
  let borders: NonNullable<SpreadsheetCellFormat["borders"]> = {};
  for (let side of ["top", "right", "bottom", "left"] as const) {
    let edge = format.borders?.[side];
    if (!edge) continue;
    // A border's colour is left out when black, and a theme colour the theme lacks drawn black.
    borders[side] = { style: BORDER_STYLES[edge.style], color: color(edge.color) ?? "#000000" };
  }
  if (Object.keys(borders).length > 0) drawn.borders = borders;
  return drawn;
}

// The fields of `format` that differ from `base`'s. Font names are compared ignoring case.
function differences(format: SpreadsheetCellFormat, base: SpreadsheetCellFormat): SpreadsheetCellFormat {
  let same = (field: string, value: unknown) => field === "fontFamily"
    ? String(value).toLowerCase() === base.fontFamily?.toLowerCase()
    : JSON.stringify(value) === JSON.stringify(base[field as keyof SpreadsheetCellFormat]);
  return Object.fromEntries(Object.entries(format).filter(([field, value]) => !same(field, value)));
}

// A font as Google names it, which for a spreadsheet's default may be a CSS-like list such as
// "arial,sans,sans-serif": its first name.
function fontName(font: string | undefined): string | undefined {
  let name = font?.split(",")[0].trim().replace(/^["']|["']$/g, "");
  return name || undefined;
}

// How Sheets aligns `value` when its cell sets no alignment, where its type decides.
function typeAlignment(value: EnteredValue | undefined): SpreadsheetCellFormat["horizontalAlignment"] {
  if (typeof value === "number") return "right";
  if (typeof value === "boolean") return "center";
  return undefined;
}

/** The format a cell with none of its own has, as far as it differs from Sheets' standard. */
function spreadsheetDefault(base: PreviewCells): SpreadsheetCellFormat {
  let { format, fontFamily } = base.defaultFormat;
  return differences(drawnFormat(format, fontFamily, base.themeColor), STANDARD_FORMAT);
}

/**
 * Where the line Google holds at `count` (the first unfrozen one) lies once `lines` are as queued
 * changes leave them: just after the last frozen line kept, so lines inserted among the frozen
 * ones are frozen too, as Google freezes them.
 */
function frozenAt(lines: Lines, count: number | undefined): number {
  for (let index = (count ?? 0) - 1; index >= 0; index--) {
    let position = positionOf(lines, `b${index}`);
    if (position !== undefined) return position + 1;
  }
  return 0;
}

/**
 * Where lines `start` to `end - 1` of those Google holds lie once `lines` are as queued changes
 * leave them: from the first kept to the last, with any inserted among them, as Google grows a
 * merge; undefined when none is kept.
 */
function spanOf(lines: Lines, start: number, end: number): { start: number; end: number } | undefined {
  let first: number | undefined;
  let last: number | undefined;
  for (let index = start; index < end && first === undefined; index++) first = positionOf(lines, `b${index}`);
  for (let index = end - 1; index >= start && last === undefined; index--) last = positionOf(lines, `b${index}`);
  return first === undefined || last === undefined ? undefined : { start: first, end: last + 1 };
}

// The merges of `sheet` that `rect` shows, relative to it and clipped to it.
function mergesIn(sheet: SimSheet, rect: Rect, base: PreviewCells): NonNullable<SpreadsheetArea["merges"]> {
  if (sheet.source === undefined) return [];
  return base.merges(sheet.source).flatMap(merge => {
    if (!Number.isFinite(merge.endRow) || !Number.isFinite(merge.endColumn)) return [];
    let rows = spanOf(sheet.rows, merge.startRow, merge.endRow);
    let columns = spanOf(sheet.columns, merge.startColumn, merge.endColumn);
    if (!rows || !columns) return [];
    let top = Math.max(rows.start, rect.startRow);
    let left = Math.max(columns.start, rect.startColumn);
    let bottom = Math.min(rows.end, rect.endRow);
    let right = Math.min(columns.end, rect.endColumn);
    if (bottom <= top || right <= left || (bottom - top) * (right - left) < 2) return [];
    return [{ row: top - rect.startRow, column: left - rect.startColumn, rows: bottom - top, columns: right - left }];
  });
}

/**
 * `area` of `grid` as it will be, from `base`, what Google holds in the cells `basePiecesOf` gives
 * for it. `changes` numbers each queued change by its index in the preview's actions; `defaults`
 * is the format a cell with none of its own has, as `spreadsheetDefault` gives it, and `deletions`
 * the lines queued changes delete, as `deletionsOf` gives them, which `base` also holds. Throws as
 * `simulatedRange` does.
 */
export function drawArea(
  grid: Grid, area: SheetArea, base: PreviewCells, changes: ReadonlyMap<number, number>,
  budget = textBudget(), defaults = spreadsheetDefault(base), deletions: readonly Deletion[] = [],
): SpreadsheetArea {
  let sheet = grid.sheets.find(candidate => candidate.id === area.sheetId)!;
  let { rect } = area;
  let size = { sheetId: sheet.id, rect, rows: rect.endRow - rect.startRow, columns: rect.endColumn - rect.startColumn };
  let read = { entered: base.entered, shown: base.shown };
  let formatted = simulatedRange(grid, size, read, "formatted", budget);
  let formulas = simulatedRange(grid, size, read, "formula", budget);
  let formats = simulatedFormats(grid, size, base.formats).formats;
  let pending = new Set(formatted.pendingCells);
  let rows = linesAt(sheet.rows, rect.startRow, rect.endRow);
  let columns = linesAt(sheet.columns, rect.startColumn, rect.endColumn);
  // Where in the spreadsheet Google holds a line is, if it is one of its lines.
  let held = (identity: string | undefined) => identity === undefined ? undefined : baseIndexOf(identity);
  let drawnDefault = { ...STANDARD_FORMAT, ...defaults };
  let drawn = rows.map((row, r) => columns.map((column, c): SpreadsheetCell | null => {
    if (row === undefined || column === undefined) return null;
    let key = cellKey(sheet.id, row, column);
    let entry = grid.cells.get(key);
    let baseRow = held(row);
    let baseColumn = held(column);
    let source = sheet.source !== undefined && baseRow !== undefined && baseColumn !== undefined
      ? { sheetId: sheet.source, row: baseRow, column: baseColumn } : undefined;
    let cell: SpreadsheetCell = {};
    let value = formatted.values[r][c];
    if (!pending.has(cellName(rect.startRow + r, rect.startColumn + c))) {
      if (value !== null && value !== "") cell.text = String(value);
    } else if (entry && entry.input !== null && !isFormula(entry.input)) {
      // A literal as entered, though the number format Google gives it may display it otherwise.
      cell.text = typeof entry.input === "boolean" ? String(entry.input).toUpperCase() : String(entry.input);
    }
    let formula = entry
      ? isFormula(entry.input)
      : source !== undefined && holdsFormula(base.entered(source.sheetId, source.row, source.column));
    let text = formulas.values[r][c];
    if (formula && typeof text === "string") cell.formula = text;
    let by = entry?.by || grid.formats.get(key)?.by;
    let change = by ? changes.get(by) : undefined;
    if (change !== undefined) cell.change = change;
    if (entry && source) {
      let previous = base.shown(source.sheetId, source.row, source.column);
      if (previous) cell.previous = previous;
    }
    // A cell of an inserted line takes formatting Google decides, so only what is queued is drawn.
    let own = formats[r][c] ?? mergeFormat(null, grid.formats.get(key));
    let font = source && base.fontFamily(source.sheetId, source.row, source.column);
    let format = differences(drawnFormat(own, font, base.themeColor), drawnDefault);
    let entered = entry ? entry.input : source && base.entered(source.sheetId, source.row, source.column);
    let alignment = cell.text !== undefined && !formula && own?.horizontalAlignment === undefined &&
      defaults.horizontalAlignment === undefined ? typeAlignment(entered) : undefined;
    if (alignment) format.horizontalAlignment = alignment;
    if (Object.keys(format).length > 0) cell.format = format;
    return Object.keys(cell).length > 0 ? cell : null;
  }));
  // A row or column of the sheet Google holds, as read.
  let line = (identity: string | undefined, of: PreviewCells["row"]) => {
    let index = held(identity);
    return sheet.source === undefined || index === undefined ? undefined : of(sheet.source, index);
  };
  let rowLines = rows.map(row => line(row, base.row));
  let columnLines = columns.map(column => line(column, base.column));
  let sizes = (lines: typeof rowLines, fallback: number) =>
    lines.some(read => read?.size !== undefined) ? { sizes: lines.map(read => read?.size ?? fallback) } : {};
  let hidden = (lines: typeof rowLines) => lines.flatMap((read, i) => read?.hidden ? [i] : []);
  let insertedRows = rows.flatMap((row, r) => row !== undefined && insertedLine(grid, row) ? [r] : []);
  let insertedColumns = columns.flatMap((column, c) => column !== undefined && insertedLine(grid, column) ? [c] : []);
  let columnWidths = sizes(columnLines, DEFAULT_COLUMN_WIDTH).sizes;
  let rowHeights = sizes(rowLines, DEFAULT_ROW_HEIGHT).sizes;
  let hiddenRows = hidden(rowLines);
  let hiddenColumns = hidden(columnLines);
  let merges = mergesIn(sheet, rect, base);
  let deleted = { rows: [] as SpreadsheetDeletedLines[], columns: [] as SpreadsheetDeletedLines[] };
  for (let deletion of deletionsIn(grid, area, deletions)) {
    let rowsDeleted = deletion.axis === "rows";
    let across = rowsDeleted ? columns : rows;
    let indices = Array.from({ length: Math.min(deletion.count, DELETED_SHOWN) }, (_, i) => deletion.start + i);
    let cellsOf = (index: number) => across.map(identity => {
      let other = held(identity);
      if (sheet.source === undefined || other === undefined) return null;
      return (rowsDeleted ? base.shown(sheet.source, index, other) : base.shown(sheet.source, other, index)) || null;
    });
    let lineSizes = indices.map(index => sheet.source === undefined ? undefined
      : (rowsDeleted ? base.row : base.column)(sheet.source, index)?.size);
    let change = changes.get(deletion.by);
    deleted[deletion.axis].push({
      before: deletion.at - (rowsDeleted ? rect.startRow : rect.startColumn),
      index: deletion.start,
      count: deletion.count,
      ...(change !== undefined ? { change } : {}),
      cells: indices.map(cellsOf),
      ...(lineSizes.some(size => size !== undefined)
        ? { sizes: lineSizes.map(size => size ?? (rowsDeleted ? DEFAULT_ROW_HEIGHT : DEFAULT_COLUMN_WIDTH)) } : {}),
    });
  }
  return {
    sheetId: sheet.id,
    row: rect.startRow,
    column: rect.startColumn,
    cells: drawn,
    ...(columnWidths ? { columnWidths } : {}),
    ...(rowHeights ? { rowHeights } : {}),
    ...(hiddenRows.length > 0 ? { hiddenRows } : {}),
    ...(hiddenColumns.length > 0 ? { hiddenColumns } : {}),
    ...(merges.length > 0 ? { merges } : {}),
    ...(insertedRows.length > 0 ? { insertedRows } : {}),
    ...(insertedColumns.length > 0 ? { insertedColumns } : {}),
    ...(deleted.rows.length > 0 ? { deletedRows: deleted.rows } : {}),
    ...(deleted.columns.length > 0 ? { deletedColumns: deleted.columns } : {}),
  };
}

// Every sheet once `grid`'s changes apply, in tab order, with those they add and remove marked: a
// removed sheet just before the first sheet kept that followed it, or last.
// Each sheet's frozen lines are where queued changes to its lines leave them, and whether it hides
// its gridlines is known from `base` for sheets it read.
function previewSheets(metadata: SpreadsheetMetadata, grid: Grid, base: PreviewCells): SpreadsheetPreview["sheets"] {
  let held = new Set(metadata.sheets.map(sheet => sheet.id));
  let kept = new Set(grid.sheets.map(sheet => sheet.id));
  let sheets: SpreadsheetPreview["sheets"] = grid.sheets.map(sheet => {
    let frozenRows = frozenAt(sheet.rows, sheet.frozenRowCount);
    let frozenColumns = frozenAt(sheet.columns, sheet.frozenColumnCount);
    return {
      id: sheet.id,
      title: sheet.title,
      ...(held.has(sheet.id) ? {} : { status: "added" as const }),
      ...(frozenRows > 0 ? { frozenRows } : {}),
      ...(frozenColumns > 0 ? { frozenColumns } : {}),
      ...(sheet.source !== undefined && base.hidesGridlines(sheet.source) ? { hideGridlines: true as const } : {}),
    };
  });
  let before = metadata.sheets.toSorted((a, b) => a.index - b.index);
  before.forEach(({ id, title }, i) => {
    if (kept.has(id)) return;
    let next = before.slice(i + 1).find(later => kept.has(later.id));
    let at = next ? sheets.findIndex(sheet => sheet.id === next.id) : sheets.length;
    sheets.splice(at, 0, { id, title, status: "removed" });
  });
  return sheets;
}

/**
 * The spreadsheet `metadata` describes as it will be once `pending`, its queued changes in order,
 * apply. `read` fetches what Google holds in areas of its sheets, each named by its title.
 */
export async function previewSpreadsheet(
  metadata: SpreadsheetMetadata, pending: readonly QueuedChange[], url: string,
  read: (areas: (SheetArea & { title: string })[]) => Promise<PreviewCells>,
): Promise<ResourcePreview> {
  let replay = replayChanges(gridOf(metadata), pending);
  let grid = replay.kind === "complete" ? replay.value : replay.partial;
  let drawable = pending;
  let omitted: { action: number; reason: string }[] = [];
  if (replay.kind === "incomplete") {
    let at = pending.indexOf(replay.unsupported);
    drawable = pending.slice(0, at);
    let reason = conflictReason(replay.unsupported, replay.reason);
    omitted = pending.slice(at).map(({ id }) => ({ action: id, reason }));
  }
  let actions = drawable.map(({ id }) => id);
  let changes = new Map(actions.map((id, index) => [id, index]));

  let titles = new Map(metadata.sheets.map(sheet => [sheet.id, sheet.title]));
  let deletions = deletionsOf(metadata, drawable, grid);
  let drawAll = async (whole: boolean) => {
    let { areas, marks } = previewAreas(grid, { whole, deletions });
    let pieces = piecesOf(grid, areas, deletions);
    let base = await read(pieces.map(piece => ({ ...piece, title: titles.get(piece.sheetId)! })));
    let drawn: SpreadsheetArea[] = [];
    let shown: SheetArea[] = [];
    let undrawable = new Set<number>();
    let work = 0;
    let budget = textBudget();
    let defaults = spreadsheetDefault(base);
    for (let area of areas) {
      let cost = rewriteWork(grid, [area], base.entered);
      try {
        if (work + cost > MAX_REWRITE_WORK) throw new UnsimulatedFormula("Too many formulas to rewrite.");
        drawn.push(drawArea(grid, area, base, changes, budget, defaults, deletions));
        shown.push(area);
        work += cost;
      } catch (error) {
        if (!(error instanceof UnsimulatedFormula || error instanceof SimulatedTextTooLong)) throw error;
        for (let mark of marks) if (holds(area, mark)) undrawable.add(mark.by);
      }
    }
    return { marks, drawn, shown, undrawable, base, defaults };
  };
  // A whole sheet holds more that can't be simulated -- a formula out of reach, too much text --
  // than windows onto the changes do; if it costs a change its place, draw the windows instead.
  let attempt = await drawAll(true);
  if (attempt.undrawable.size > 0) attempt = await drawAll(false);
  let { marks, drawn, shown, undrawable, base, defaults } = attempt;
  // A change none of whose cells is drawn is listed, with why.
  let marked = new Set(marks.map(mark => mark.by));
  let seen = new Set(marks.filter(mark => shown.some(area => holds(area, mark))).map(mark => mark.by));
  for (let id of actions) {
    if (seen.has(id) || !marked.has(id)) continue;
    omitted.push({ action: id, reason: undrawable.has(id) ? UNDRAWABLE : TOO_MANY });
  }
  omitted.sort((a, b) => a.action - b.action);

  return {
    title: metadata.title,
    url,
    actions,
    ...(omitted.length > 0 ? { omitted } : {}),
    content: {
      type: "spreadsheet",
      sheets: previewSheets(metadata, grid, base),
      ...(Object.keys(defaults).length > 0 ? { defaultFormat: defaults } : {}),
      areas: drawn,
    },
  };
}

// Whether `area` shows the cell `mark`.
function holds(area: SheetArea, mark: Mark): boolean {
  let { rect } = area;
  return area.sheetId === mark.sheetId && mark.row >= rect.startRow && mark.row < rect.endRow &&
    mark.column >= rect.startColumn && mark.column < rect.endColumn;
}
