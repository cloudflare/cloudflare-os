import type { SheetCell, SheetCellStyle, SheetModel } from "@gadgets/office-content/xlsx-sheets";

/** The height of the lettered column headers and the width of the numbered row headers, in pixels. */
export const SHEET_HEADER_HEIGHT = 20;
export const SHEET_ROW_HEADER_WIDTH = 40;


/** More columns than any sheet has, so `row * COLUMN_SPAN + column` is unique. */
const COLUMN_SPAN = 16_384;

/** A merged range in terms of the rows and columns drawn. */
export type SheetSpan = {
  rowSpan: number;
  colSpan: number;
  /** The sheet row and column of the merge's top-left cell, which holds its value. */
  sourceRow: number;
  sourceColumn: number;
};

/**
 * Where everything in a sheet is drawn. Hidden rows and columns are left out, so the grid is
 * addressed by position (the nth row or column drawn), and `rows` and `columns` give each
 * position's index in the sheet.
 */
export type SheetLayout = {
  sheet: SheetModel;
  styles: readonly SheetCellStyle[];
  rows: readonly number[];
  columns: readonly number[];
  rowHeights: readonly number[];
  columnWidths: readonly number[];
  /** Each row's top and each column's left edge from the grid's origin, with the far edge last. */
  rowTops: readonly number[];
  columnLefts: readonly number[];
  /** How many leading positions stay in view. */
  frozenRows: number;
  frozenColumns: number;
  /** The first and one past the last row that must be drawn with each row, because a merge joins them. */
  mergeStart: readonly number[];
  mergeEnd: readonly number[];
  /** The cell at a sheet row and column, if the file has one. */
  cellAt: (row: number, column: number) => SheetCell | undefined;
  /** The style of a sheet row and column: the cell's, else its row's, else its column's. */
  styleAt: (row: number, column: number) => SheetCellStyle;
  /** The merge whose top-left is at a position. */
  spanAt: (rowPosition: number, columnPosition: number) => SheetSpan | undefined;
  /** Whether a position lies inside a merge without being its top-left. */
  isCovered: (rowPosition: number, columnPosition: number) => boolean;
};

const edges = (sizes: readonly number[]): number[] => {
  const result = [0];
  for (const size of sizes) result.push(result[result.length - 1] + size);
  return result;
};

const positionsIn = (positions: Map<number, number>, from: number, to: number) => {
  const found: number[] = [];
  for (let index = from; index <= to; index++) {
    const position = positions.get(index);
    if (position !== undefined) found.push(position);
  }
  return found;
};

/**
 * Lays a sheet out for drawing, showing at most `maxRows` by `maxColumns` of it. Excel shows a
 * grid that never ends, so `padding` empty rows and columns follow the sheet's own.
 */
export const layoutSheet = (
  sheet: SheetModel,
  styles: readonly SheetCellStyle[],
  maxRows: number,
  maxColumns: number,
  padding: { rows: number; columns: number } = { rows: 0, columns: 0 },
): SheetLayout => {
  const rowsByIndex = new Map(sheet.rows.map((row) => [row.index, row]));
  const columnsByIndex = new Map(sheet.columns.map((column) => [column.index, column]));
  const cells = new Map<number, SheetCell>();
  for (const row of sheet.rows) {
    for (const cell of row.cells) cells.set(row.index * COLUMN_SPAN + cell.column, cell);
  }

  const rowTotal = Math.min(maxRows, Math.max(sheet.rowCount, sheet.frozen.rows + 1) + padding.rows);
  const columnTotal = Math.min(maxColumns, Math.max(sheet.columnCount, sheet.frozen.columns + 1) + padding.columns);
  const rows: number[] = [];
  const rowPositions = new Map<number, number>();
  for (let index = 0; index < rowTotal; index++) {
    if (rowsByIndex.get(index)?.hidden) continue;
    rowPositions.set(index, rows.length);
    rows.push(index);
  }
  const columns: number[] = [];
  const columnPositions = new Map<number, number>();
  for (let index = 0; index < columnTotal; index++) {
    if (columnsByIndex.get(index)?.hidden) continue;
    columnPositions.set(index, columns.length);
    columns.push(index);
  }
  const frozenRows = rows.filter((index) => index < sheet.frozen.rows).length;
  const frozenColumns = columns.filter((index) => index < sheet.frozen.columns).length;

  const spans = new Map<number, SheetSpan>();
  const covered = new Set<number>();
  const mergeStart = rows.map((_, position) => position);
  const mergeEnd = rows.map((_, position) => position + 1);
  for (const merge of sheet.merges) {
    // Frozen rows are always drawn and the rest only near the viewport, so a merge cannot join
    // the two: one that crosses the frozen edge is joined only above it.
    const rowSpan = positionsIn(rowPositions, merge.top, merge.bottom)
      .filter((position, _, found) => found[0] >= frozenRows || position < frozenRows);
    const colSpan = positionsIn(columnPositions, merge.left, merge.right);
    if (rowSpan.length === 0 || colSpan.length === 0) continue;
    for (const row of rowSpan) {
      for (const column of colSpan) covered.add(row * COLUMN_SPAN + column);
    }
    const key = rowSpan[0] * COLUMN_SPAN + colSpan[0];
    covered.delete(key);
    spans.set(key, { rowSpan: rowSpan.length, colSpan: colSpan.length, sourceRow: merge.top, sourceColumn: merge.left });
    const end = rowSpan[0] + rowSpan.length;
    for (const row of rowSpan) {
      mergeStart[row] = Math.min(mergeStart[row], rowSpan[0]);
      mergeEnd[row] = Math.max(mergeEnd[row], end);
    }
  }
  // Merges in different columns can chain, each starting inside the rows of another.
  for (let row = 0; row < rows.length; row++) mergeStart[row] = Math.min(mergeStart[row], mergeStart[mergeStart[row]]);
  for (let row = rows.length - 1; row >= 0; row--) mergeEnd[row] = Math.max(mergeEnd[row], mergeEnd[mergeEnd[row] - 1]);

  const rowHeights = rows.map((index) => rowsByIndex.get(index)?.height ?? sheet.defaultRowHeight);
  const columnWidths = columns.map((index) => columnsByIndex.get(index)?.width ?? sheet.defaultColumnWidth);
  const cellAt = (row: number, column: number) => cells.get(row * COLUMN_SPAN + column);
  return {
    sheet,
    styles,
    rows,
    columns,
    rowHeights,
    columnWidths,
    rowTops: edges(rowHeights),
    columnLefts: edges(columnWidths),
    frozenRows,
    frozenColumns,
    mergeStart,
    mergeEnd,
    cellAt,
    styleAt: (row, column) =>
      styles[cellAt(row, column)?.style ?? rowsByIndex.get(row)?.style ?? columnsByIndex.get(column)?.style ?? 0] ?? styles[0],
    spanAt: (row, column) => spans.get(row * COLUMN_SPAN + column),
    isCovered: (row, column) => covered.has(row * COLUMN_SPAN + column),
  };
};

/** The scrolling rows to draw, as positions: the first and one past the last. */
export type SheetRowWindow = { start: number; end: number };

/** Rows are added and dropped this many at a time, so most scroll events change nothing. */
const WINDOW_STEP = 16;

/**
 * The rows to draw when the grid is scrolled to `scrollTop` in a viewport `height` tall: those in
 * view and a margin around them, widened so that no merge is cut.
 */
export const rowWindow = (layout: SheetLayout, scrollTop: number, height: number): SheetRowWindow => {
  const { rowTops, frozenRows, mergeStart, mergeEnd } = layout;
  const count = layout.rows.length;
  let first = frozenRows;
  while (first < count && rowTops[first + 1] < scrollTop) first++;
  let last = first;
  while (last < count && rowTops[last] < scrollTop + height) last++;
  const start = Math.max(frozenRows, Math.floor(first / WINDOW_STEP) * WINDOW_STEP - WINDOW_STEP);
  const end = Math.min(count, Math.ceil(last / WINDOW_STEP) * WINDOW_STEP + WINDOW_STEP);
  if (start >= end) return { start: frozenRows, end: frozenRows };
  return { start: Math.max(frozenRows, mergeStart[start]), end: mergeEnd[end - 1] };
};

/** A, B, …, Z, AA, AB, …: how spreadsheets letter their columns. */
export const columnLetter = (index: number): string => {
  let letters = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  }
  return letters;
};
