/**
 * What it takes to draw a sheet as Google Sheets draws it, with the queued changes marked on it.
 *
 * A drawing is read by window: the cells of a range, with the sheet's frozen rows and columns
 * beside them. Of each cell Google is asked what it displays and the format in effect, which
 * holds what conditional formatting gives it, and for what it holds as entered, which replay
 * needs to show queued changes over it. Queued changes are replayed over both by the functions a
 * value read and a format read use, so a drawing cannot disagree with them about what the changes
 * do to a cell.
 *
 * Where queued changes show is worked out from lines alone. A change's cells are found among the
 * rows and columns the sheet had when it was made, and placed where the changes after it leave
 * those lines.
 */

import type { SheetArea } from "./sheets-api";
import {
  projectFormat, sheetColor, type BaseFormats, type RestCellFormat, type RestColorStyle,
} from "./sheets-format";
import { isRangeChange } from "./sheets-input";
import {
  a1Of, cellName, columnLetters, findSheet, intersection, isFormula, rectName, type EnteredValue,
  type Rect,
} from "./sheets-model";
import { cellKey, planSheet } from "./sheets-plan";
import type { SheetCellFormat, SheetColor } from "./sheets-read-types";
import {
  formulaAt, insertedLine, MAX_READ_PIECES, rangesToFetch, replayChanges, simulatedFormats, simulatedRange, textBudget,
  type BaseCells,
  type BaseRead, type Grid, type PlannedChange, type QueuedChange, type SheetMeta, type SimSheet, type SimulatedArea,
} from "./sheets-simulation";
import { baseIndexOf, lineAt, lineCount, positionsIn, type Lines } from "./sheets-structure";
import type {
  SheetDrawnCell, SheetDrawnFormat, SheetDrawnLine, SpreadsheetDrawing,
} from "./sheets-rendering-types";
import type {
  SheetChange, SpreadsheetChangedArea, SpreadsheetPendingChanges,
} from "./sheets-types";

/** The most cells one drawing holds: what one format read may fetch. */
export const MAX_DRAWN_CELLS = 10_000;

// The sizes Google Sheets gives a row and a column nobody has resized, in pixels.
const DEFAULT_SIZE = { rows: 21, columns: 100 };

const BORDER = "style,color";

/**
 * The field mask of the theme's colours alone, which a drawing of a sheet Google does not hold
 * yet still resolves colour names by.
 */
export const THEME_FIELDS = "properties(spreadsheetTheme(themeColors))";

/** The field mask of a drawing read: the theme, and of each cell what it shows, holds and looks like. */
export const DRAWING_FIELDS =
  `${THEME_FIELDS},` +
  "sheets(properties(sheetId,gridProperties(hideGridlines)),merges,basicFilter(range)," +
  "charts(spec(title),position(overlayPosition))," +
  "data(startRow,startColumn,rowMetadata(pixelSize,hiddenByUser,hiddenByFilter)," +
  "columnMetadata(pixelSize,hiddenByUser,hiddenByFilter)," +
  "rowData(values(formattedValue,userEnteredValue,effectiveValue(numberValue,boolValue,errorValue(type))," +
  "hyperlink,note,dataValidation(condition(type),showCustomUi)," +
  "textFormatRuns(startIndex,format(foregroundColor,foregroundColorStyle,fontFamily,fontSize,bold,italic,underline,strikethrough))," +
  "effectiveFormat(backgroundColor,horizontalAlignment,verticalAlignment,wrapStrategy," +
  "textFormat(foregroundColor,fontFamily,fontSize,bold,italic,underline,strikethrough)," +
  `borders(top(${BORDER}),bottom(${BORDER}),left(${BORDER}),right(${BORDER})))))))`;

type RestGridRange = {
  startRowIndex?: number; endRowIndex?: number; startColumnIndex?: number; endColumnIndex?: number;
};

type RestLine = { pixelSize?: number; hiddenByUser?: boolean; hiddenByFilter?: boolean };

/** A cell as a drawing read returns it. */
export type RestDrawnCell = {
  formattedValue?: string;
  userEnteredValue?: object;
  effectiveValue?: { numberValue?: number; boolValue?: boolean; errorValue?: object };
  effectiveFormat?: RestCellFormat & { textFormat?: { fontFamily?: string } };
  hyperlink?: string;
  note?: string;
  dataValidation?: { condition?: { type?: string }; showCustomUi?: boolean };
  textFormatRuns?: { startIndex?: number; format?: RestCellFormat["textFormat"] & { fontFamily?: string } }[];
};

type RestDrawnSheet = {
  properties?: { sheetId?: number; gridProperties?: { hideGridlines?: boolean } };
  merges?: RestGridRange[];
  basicFilter?: { range?: RestGridRange };
  charts?: {
    spec?: { title?: string };
    position?: {
      overlayPosition?: {
        anchorCell?: { rowIndex?: number; columnIndex?: number };
        offsetXPixels?: number; offsetYPixels?: number; widthPixels?: number; heightPixels?: number;
      };
    };
  }[];
  data?: {
    startRow?: number;
    startColumn?: number;
    rowMetadata?: RestLine[];
    columnMetadata?: RestLine[];
    rowData?: { values?: RestDrawnCell[] }[];
  }[];
};

/** A `spreadsheets:getByDataFilter` answer to a drawing read. */
export type RestDrawing = {
  properties?: { spreadsheetTheme?: { themeColors?: { colorType?: string; color?: RestColorStyle }[] } };
  sheets?: RestDrawnSheet[];
};

type Axis = "rows" | "columns";

/**
 * What a drawing read fetched of the spreadsheet Google holds: its cells as replay reads them and
 * as they are drawn, each one's format in effect with its font, the sizes of its rows and columns,
 * each sheet's own layout, and the theme's colours by name.
 */
export type BaseDrawing = BaseRead & {
  cell: BaseCells<RestDrawnCell>;
  format: BaseFormats;
  line(sheetId: number, axis: Axis, index: number): RestLine | undefined;
  sheet(sheetId: number): RestDrawnSheet | undefined;
  theme: ReadonlyMap<string, SheetColor>;
};

/**
 * `rests` by cell and line: a drawing read, and any read of cells beside it. The first that has a
 * sheet says how it is laid out. `entered` reads a cell's `userEnteredValue`.
 */
export function baseDrawing(
  rests: readonly RestDrawing[], entered: (value: object | undefined) => EnteredValue,
): BaseDrawing {
  let cells = new Map<string, RestDrawnCell>();
  let lines = new Map<string, RestLine>();
  let sheets = new Map<number, RestDrawnSheet>();
  for (let sheet of rests.flatMap(rest => rest.sheets ?? [])) {
    let sheetId = sheet.properties?.sheetId ?? 0;
    if (!sheets.has(sheetId)) sheets.set(sheetId, sheet);
    for (let { startRow = 0, startColumn = 0, rowMetadata, columnMetadata, rowData } of sheet.data ?? []) {
      rowMetadata?.forEach((line, r) => lines.set(`${sheetId}:rows:${startRow + r}`, line));
      columnMetadata?.forEach((line, c) => lines.set(`${sheetId}:columns:${startColumn + c}`, line));
      rowData?.forEach((row, r) => row.values?.forEach((cell, c) => {
        cells.set(`${sheetId}:${startRow + r}:${startColumn + c}`, cell);
      }));
    }
  }
  let cell = (sheetId: number, row: number, column: number) => cells.get(`${sheetId}:${row}:${column}`) ?? null;
  return {
    cell,
    entered: (...at) => entered(cell(...at)?.userEnteredValue),
    shown: (...at) => cell(...at)?.formattedValue ?? null,
    format: (...at) => {
      let effective = cell(...at)?.effectiveFormat;
      let fontFamily = effective?.textFormat?.fontFamily;
      return effective ? { ...projectFormat(effective), ...(fontFamily ? { fontFamily } : {}) } : null;
    },
    line: (sheetId, axis, index) => lines.get(`${sheetId}:${axis}:${index}`),
    sheet: sheetId => sheets.get(sheetId),
    theme: new Map((rests[0]?.properties?.spreadsheetTheme?.themeColors ?? []).flatMap(({ colorType, color }) => {
      let hex = sheetColor(color);
      return colorType && hex ? [[colorType, hex] as const] : [];
    })),
  };
}

/** The cells a drawing holds: a window's own, and those of the frozen lines beside it. */
export type DrawnCells = {
  sheet: SimSheet;
  window: SimulatedArea;
  /** The zero-based rows drawn, in order, and the columns. */
  rows: number[];
  columns: number[];
  /** The same cells as rectangles: each stretch of rows with each stretch of columns. */
  areas: SimulatedArea[];
  /** The cells of the spreadsheet Google holds that they show, as `rangesToFetch` gives them. */
  pieces: SheetArea[];
};

const cellRect = (row: number, column: number): Rect =>
  ({ startRow: row, endRow: row + 1, startColumn: column, endColumn: column + 1 });

// The frozen lines a window starting at `start` leaves out, then its own, as stretches.
function stretches(frozen: number, start: number, end: number): [number, number][] {
  let lead = Math.min(frozen, start);
  return lead > 0 ? [[0, lead], [start, end]] : [[start, end]];
}

const lengthOf = (runs: [number, number][]) => runs.reduce((total, [start, end]) => total + end - start, 0);

const positions = (runs: [number, number][]) =>
  runs.flatMap(([start, end]) => Array.from({ length: end - start }, (_line, n) => start + n));

/**
 * The cells a drawing of `window` holds. Throws `Error` when they are more than
 * `MAX_DRAWN_CELLS`, or than one read may fetch.
 */
export function drawnCells(grid: Grid, window: SimulatedArea): DrawnCells {
  let sheet = grid.sheets.find(candidate => candidate.id === window.sheetId)!;
  let { rect } = window;
  let rows = stretches(sheet.frozenRowCount ?? 0, rect.startRow, rect.endRow);
  let columns = stretches(sheet.frozenColumnCount ?? 0, rect.startColumn, rect.endColumn);
  // Counted before any line is listed: a range can name millions of rows.
  if (lengthOf(rows) * lengthOf(columns) > MAX_DRAWN_CELLS) {
    throw new Error(`readDrawing may draw at most ${MAX_DRAWN_CELLS.toLocaleString("en-US")} cells, ` +
      "those of the sheet's frozen rows and columns included.");
  }
  let areas = rows.flatMap(([startRow, endRow]) => columns.map(([startColumn, endColumn]) => ({
    sheetId: sheet.id, rect: { startRow, endRow, startColumn, endColumn },
    rows: endRow - startRow, columns: endColumn - startColumn,
  })));
  let pieces = rangesToFetch(grid, areas);
  // A drawing showing none of a sheet Google holds still asks for a cell of it, since the sheet's
  // own layout comes with its cells.
  if (pieces.length === 0 && sheet.source !== undefined) pieces = [{ sheetId: sheet.source, rect: cellRect(0, 0) }];
  return { sheet, window, rows: positions(rows), columns: positions(columns), areas, pieces };
}

// The merged ranges of `held`, the sheet as Google holds it, that reach into `drawn`, placed where
// the queued changes leave them.
function mergesIn({ sheet, areas }: DrawnCells, held: RestDrawnSheet | undefined): Rect[] {
  return (held?.merges ?? []).flatMap(range => {
    let rect = placed(sheet, rectOf(range));
    return rect && areas.some(area => intersection(area.rect, rect)) ? [rect] : [];
  });
}

/**
 * The cells that the merges reaching into `drawn` start on, where those lie outside it: such a
 * merge shows what its first cell holds. `rest` is what was read for `drawn`. At most as many as
 * one read may ask for beside each other, and as `MAX_DRAWN_CELLS` leaves room for.
 */
export function mergeAnchors(drawn: DrawnCells, rest: RestDrawing): SimulatedArea[] {
  let { sheet, areas, rows, columns } = drawn;
  let held = rest.sheets?.find(({ properties }) => (properties?.sheetId ?? 0) === sheet.source);
  let room = Math.min(MAX_READ_PIECES, MAX_DRAWN_CELLS - rows.length * columns.length);
  return mergesIn(drawn, held).flatMap(({ startRow, startColumn }) => {
    let rect = cellRect(startRow, startColumn);
    return areas.some(area => intersection(area.rect, rect)) ? [] : [{ sheetId: sheet.id, rect, rows: 1, columns: 1 }];
  }).slice(0, room);
}

// A format as it is drawn: without the number format, which `text` already shows, with false
// flags left out and theme colours resolved.
function drawnFormat(format: SheetCellFormat & { fontFamily?: string }, theme: BaseDrawing["theme"]): SheetDrawnFormat {
  let color = (named: SheetColor | undefined) => named?.startsWith("#") ? named : theme.get(named ?? "");
  let { numberFormat: _shown, borders, ...rest } = format;
  let edges = Object.entries(borders ?? {}).map(([side, { style, color: named }]) => {
    let shade = color(named);
    return [side, { style, ...(shade ? { color: shade } : {}) }];
  });
  let look = {
    ...rest, textColor: color(format.textColor), fillColor: color(format.fillColor),
    borders: edges.length > 0 ? Object.fromEntries(edges) : undefined,
  };
  return Object.fromEntries(Object.entries(look).filter(([, value]) => value !== undefined && value !== false));
}

// A `GridRange` as a rectangle. Google leaves out an index that is 0, and an end that is unbounded.
function rectOf(range: RestGridRange | undefined): Rect {
  return {
    startRow: range?.startRowIndex ?? 0, endRow: range?.endRowIndex ?? Infinity,
    startColumn: range?.startColumnIndex ?? 0, endColumn: range?.endColumnIndex ?? Infinity,
  };
}

// The positions lines `start` to `end - 1` of the sheet Google holds span in `lines`, or
// undefined when none is left.
function spanIn(lines: Lines, start: number, end: number): [number, number] | undefined {
  // An unbounded end reaches past any line there is.
  let length = Math.min(end, Number.MAX_SAFE_INTEGER) - start;
  let runs = positionsIn(lines, [{ kind: "base", start, length }], 0, length);
  return runs.length > 0 ? [runs[0].start, runs.at(-1)!.end] : undefined;
}

// Where `rect` of the sheet Google holds lies in `sheet`, as queued changes leave its lines.
function placed(sheet: SimSheet, rect: Rect): Rect | undefined {
  let rows = spanIn(sheet.rows, rect.startRow, rect.endRow);
  let columns = spanIn(sheet.columns, rect.startColumn, rect.endColumn);
  return rows && columns
    ? { startRow: rows[0], endRow: rows[1], startColumn: columns[0], endColumn: columns[1] } : undefined;
}

function drawnLine(grid: Grid, { sheet }: DrawnCells, axis: Axis, position: number, base: BaseDrawing): SheetDrawnLine {
  let identity = lineAt(sheet[axis], position)!;
  let index = baseIndexOf(identity);
  let held = sheet.source === undefined || index === undefined ? undefined : base.line(sheet.source, axis, index);
  return {
    number: position + 1,
    size: held?.pixelSize ?? DEFAULT_SIZE[axis],
    ...(held?.hiddenByUser || held?.hiddenByFilter ? { hidden: true as const } : {}),
    ...(insertedLine(grid, identity) ? { inserted: true as const } : {}),
  };
}

function kindOf(value: unknown): SheetDrawnCell["kind"] {
  return typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : undefined;
}

function holdsOf(held: RestDrawnCell): NonNullable<SheetDrawnCell["holds"]> {
  let validation = held.dataValidation;
  return [
    ...(held.note ? ["note" as const] : []),
    ...(validation?.condition?.type === "BOOLEAN" ? ["checkbox" as const]
      : validation?.showCustomUi ? ["dropdown" as const] : []),
  ];
}

// The charts over `sheet` that `held`, the sheet as Google holds it, has anchored in a cell the
// queued changes leave, at the size Google gives one that says none.
function chartsOf(sheet: SimSheet, held: RestDrawnSheet | undefined): NonNullable<SpreadsheetDrawing["charts"]> {
  return (held?.charts ?? []).flatMap(({ spec, position }) => {
    let { anchorCell, offsetXPixels = 0, offsetYPixels = 0, widthPixels = 600, heightPixels = 371 } =
      position?.overlayPosition ?? {};
    let { rowIndex = 0, columnIndex = 0 } = anchorCell ?? {};
    let anchor = anchorCell && placed(sheet, cellRect(rowIndex, columnIndex));
    return anchor ? [{
      ...(spec?.title ? { title: spec.title } : {}),
      anchor: cellName(anchor.startRow, anchor.startColumn),
      offsetX: offsetXPixels, offsetY: offsetYPixels, width: widthPixels, height: heightPixels,
    }] : [];
  });
}

const listed = ({ id, title, index, rowCount, columnCount, hidden }: SheetMeta) =>
  ({ id, title, index, rowCount, columnCount, ...(hidden ? { hidden } : {}) });

// A sheet as listed, with the rows and columns it keeps in view, which come with every drawing.
const laidOut = (sheet: SheetMeta) => ({
  ...listed(sheet),
  ...(sheet.frozenRowCount ? { frozenRowCount: sheet.frozenRowCount } : {}),
  ...(sheet.frozenColumnCount ? { frozenColumnCount: sheet.frozenColumnCount } : {}),
});

/**
 * `drawn` of `grid` as Google Sheets draws it, from `base`, what a drawing read fetched of the
 * cells `drawnPieces` gives for it and of `anchors`, the cells `mergeAnchors` gives. Throws as
 * `simulatedRange` does.
 */
export function drawingOf(
  grid: Grid, drawn: DrawnCells, base: BaseDrawing, anchors: readonly SimulatedArea[],
): SpreadsheetDrawing {
  let { sheet, window } = drawn;
  let budget = textBudget();
  // What each cell shows and how it looks, by name, as a value read and a format read have them:
  // a cell of a line a queued change inserts has no format, since Google decides it.
  let shown = new Map<string, { text?: string; look: SheetCellFormat | null }>();
  let pending = new Set<string>();
  for (let area of [...drawn.areas, ...anchors]) {
    let { values, pendingCells = [] } = simulatedRange(grid, area, base, "formatted", budget);
    let { formats } = simulatedFormats(grid, area, base.format);
    for (let name of pendingCells) pending.add(name);
    values.forEach((line, r) => line.forEach((value, c) => {
      shown.set(cellName(area.rect.startRow + r, area.rect.startColumn + c), {
        ...(value === null || value === "" ? {} : { text: String(value) }), look: formats[r][c],
      });
    }));
  }

  let formats: SheetDrawnFormat[] = [];
  let indices = new Map<string, number>();
  let formatIndex = (format: SheetCellFormat | null): number | undefined => {
    if (!format) return undefined;
    let look = drawnFormat(format, base.theme);
    let key = JSON.stringify(look);
    if (key === "{}") return undefined;
    if (!indices.has(key)) indices.set(key, formats.push(look) - 1);
    return indices.get(key);
  };

  let cellAt = (r: number, c: number): SheetDrawnCell | null => {
    let row = lineAt(sheet.rows, r)!;
    let column = lineAt(sheet.columns, c)!;
    let baseRow = baseIndexOf(row);
    let baseColumn = baseIndexOf(column);
    let key = cellKey(sheet.id, row, column);
    let entry = grid.cells.get(key);
    let held = sheet.source === undefined || baseRow === undefined || baseColumn === undefined
      ? null : base.cell(sheet.source, baseRow, baseColumn);
    let name = cellName(r, c);
    let { text, look } = shown.get(name)!;
    let format = formatIndex(look);
    let kind = entry ? kindOf(entry.input)
      : held?.effectiveValue?.errorValue ? "error"
      : kindOf(held?.effectiveValue?.numberValue ?? held?.effectiveValue?.boolValue);
    let holds = held ? holdsOf(held) : [];
    // Runs are of the text as saved, so a cell a queued change writes or may change has none.
    let runs = entry || pending.has(name) || text === undefined ? [] : (held?.textFormatRuns ?? []).map(run => {
      let look = formatIndex({
        ...projectFormat({ textFormat: run.format }), ...(run.format?.fontFamily ? { fontFamily: run.format.fontFamily } : {}),
      });
      return { start: run.startIndex ?? 0, ...(look === undefined ? {} : { format: look }) };
    });
    let cell: SheetDrawnCell = {
      ...(text === undefined ? {} : { text }),
      ...(pending.has(name) ? { pending: true } : {}),
      ...(kind ? { kind } : {}),
      ...(format === undefined ? {} : { format }),
      ...(held?.hyperlink && !entry ? { link: held.hyperlink } : {}),
      ...(holds.length > 0 ? { holds } : {}),
      ...(runs.length > 0 ? { runs } : {}),
      ...(entry ? {
        change: entry.by,
        entered: isFormula(entry.input) ? formulaAt(grid, sheet.id, entry.input, entry.at).text : entry.input,
      } : {}),
      ...((entry || pending.has(name)) && held?.formattedValue ? { saved: held.formattedValue } : {}),
      ...(grid.formats.has(key) ? { formatted: true } : {}),
    };
    return Object.keys(cell).length > 0 ? cell : null;
  };
  let cells = drawn.rows.map(r => drawn.columns.map(c => cellAt(r, c)));
  let starts = anchors.flatMap(({ rect }) => {
    let cell = cellAt(rect.startRow, rect.startColumn);
    return cell ? [[cellName(rect.startRow, rect.startColumn), cell] as const] : [];
  });

  let layout = sheet.source === undefined ? undefined : base.sheet(sheet.source);
  let filter = layout?.basicFilter && placed(sheet, rectOf(layout.basicFilter.range));
  let charts = chartsOf(sheet, layout);
  let merges = mergesIn(drawn, layout);
  // Google reports a row nobody has resized at the default size, though it draws the row as tall
  // as its largest text. Text merged down several rows is in none of them alone.
  let deep = new Set(merges.filter(rect => rect.endRow - rect.startRow > 1).map(rect => `${rect.startRow}:${rect.startColumn}`));
  let fitted = (line: SheetDrawnLine, r: number): SheetDrawnLine => line.size !== DEFAULT_SIZE.rows ? line : {
    ...line,
    size: Math.max(line.size, ...cells[r].map((cell, c) =>
      cell?.text && cell.format !== undefined && !deep.has(`${drawn.rows[r]}:${drawn.columns[c]}`)
        ? Math.round((formats[cell.format].fontSize ?? 10) * 1.6) + 5 : 0)),
  };
  return {
    range: a1Of(sheet.title, window.rect),
    sheet: {
      ...laidOut(sheet),
      ...(layout?.properties?.gridProperties?.hideGridlines ? { gridlinesHidden: true as const } : {}),
    },
    rows: drawn.rows.map((position, r) => fitted(drawnLine(grid, drawn, "rows", position, base), r)),
    columns: drawn.columns.map(position => drawnLine(grid, drawn, "columns", position, base)),
    cells,
    formats,
    merges: merges.map(rectName),
    ...(starts.length > 0 ? { anchors: Object.fromEntries(starts) } : {}),
    ...(filter ? { filter: rectName({
      ...filter, endRow: Math.min(filter.endRow, sheet.rowCount), endColumn: Math.min(filter.endColumn, sheet.columnCount),
    }) } : {}),
    ...(charts.length > 0 ? { charts } : {}),
  };
}

// A queued change as `updateSpreadsheet()` took it, its sheet named as `titles` has it.
function asGiven(change: PlannedChange, titles: Record<string, string>): SheetChange {
  let sheet = titles[change.sheetId] ?? "";
  switch (change.op) {
    case "writeCells": return { op: change.op, range: a1Of(sheet, change.rect), values: change.values };
    case "clearRange": return { op: change.op, range: a1Of(sheet, change.rect) };
    case "formatCells": return { op: change.op, range: a1Of(sheet, change.rect), format: change.format };
    case "addSheet": {
      let { op, title, index, rowCount, columnCount } = change;
      return { op, title, index, rowCount, columnCount };
    }
    case "renameSheet": return { op: change.op, sheet, title: change.title };
    case "duplicateSheet": return { op: change.op, sheet, title: change.title, index: change.index };
    case "deleteSheet": return { op: change.op, sheet };
    case "insertRows":
    case "deleteRows": return { op: change.op, sheet, at: change.start + 1, count: change.count };
    case "insertColumns":
    case "deleteColumns": return { op: change.op, sheet, at: columnLetters(change.start), count: change.count };
  }
}

// Cells a change touches, among the lines the sheet has just after it.
type Mark = Pick<SpreadsheetChangedArea, "change" | "op" | "count" | "after"> & { sheet: SimSheet; rect: Rect };

/**
 * Where on sheet `sheetId` each of `changes`, which all apply over `base`, shows once the last
 * has applied, oldest first.
 */
function changedAreas(base: Grid, changes: readonly QueuedChange[], sheetId: number): SpreadsheetChangedArea[] {
  let shown = (grid: Grid) => grid.sheets.find(candidate => candidate.id === sheetId);
  // Lines alone decide where cells end up, so this replay enters no cell.
  let grid: Grid = { ...base, cells: new Map(), formats: new Map() };
  let marks: Mark[] = [];
  for (let { id, action } of changes) {
    for (let change of action.payload.changes) {
      let before = shown(grid);
      if (!isRangeChange(change)) grid = planSheet(grid, [change]).grid;
      let sheet = shown(grid);
      if (change.sheetId !== sheetId || !sheet) continue;
      if (isRangeChange(change)) {
        marks.push({ change: id, op: change.op, sheet, rect: change.rect });
        continue;
      }
      if (!("start" in change)) continue;
      let [axis, from, to] = change.op === "insertRows" || change.op === "deleteRows"
        ? ["rows", "startRow", "endRow"] as const : ["columns", "startColumn", "endColumn"] as const;
      let all = { startRow: 0, endRow: sheet.rowCount, startColumn: 0, endColumn: sheet.columnCount };
      if (change.op === "insertRows" || change.op === "insertColumns") {
        let rect = { ...all, [from]: change.start, [to]: change.start + change.count };
        marks.push({ change: id, op: change.op, sheet, rect });
        continue;
      }
      // The line that took their place, or the last when they were the last.
      let count = lineCount(sheet[axis]);
      let at = Math.min(change.start, count - 1);
      let place = { sheet, rect: { ...all, [from]: at, [to]: at + 1 }, ...(change.start >= count ? { after: true as const } : {}) };
      // Where an earlier change deleted lines just before these, the line marking it goes too:
      // that mark moves with this one.
      for (let mark of marks) {
        let stood = (lines: Lines) => positionsIn(lines, mark.sheet[axis], mark.rect[from], mark.rect[to]).length > 0;
        if (mark.op !== change.op || !before || !stood(before[axis]) || stood(sheet[axis])) continue;
        delete mark.after;
        Object.assign(mark, place);
      }
      marks.push({ change: id, op: change.op, count: change.count, ...place });
    }
  }
  let last = shown(grid);
  if (!last) return [];
  return marks.flatMap(({ sheet, rect, ...mark }) =>
    positionsIn(last.rows, sheet.rows, rect.startRow, rect.endRow).flatMap(rows =>
      positionsIn(last.columns, sheet.columns, rect.startColumn, rect.endColumn).map(columns => ({
        ...mark,
        range: rectName({ startRow: rows.start, endRow: rows.end, startColumn: columns.start, endColumn: columns.end }),
      }))));
}

// The sheets a change touches.
const touching = (change: PlannedChange) =>
  change.op === "duplicateSheet" ? [change.sheetId, change.newSheetId] : [change.sheetId];

/**
 * The queued changes that touch the sheet titled `name`, ignoring case, where they show on it,
 * and the sheets of `base`, the spreadsheet Google holds, before and after them. `name` is the
 * title the changes leave a sheet with, or that of a sheet Google holds which they delete.
 * Undefined when it names neither.
 */
export function pendingChangesOf(
  base: Grid, pending: readonly QueuedChange[], name: string,
): SpreadsheetPendingChanges | undefined {
  let replay = replayChanges(base, pending);
  let grid = replay.kind === "complete" ? replay.value : replay.partial;
  // The first change that no longer applies stops the replay, so it and those after it are stale.
  let fits = replay.kind === "complete" ? pending.length : pending.indexOf(replay.unsupported);
  let sheetId = (findSheet(grid.sheets, name) ?? findSheet(base.sheets, name))?.id;
  if (sheetId === undefined) return undefined;
  let touches = (change: PlannedChange) => touching(change).includes(sheetId);
  let touched = new Set(pending.slice(0, fits).flatMap(({ action }) => action.payload.changes.flatMap(touching)));
  return {
    changes: pending.flatMap(({ id, action }, n) => {
      // Each names its sheet by the title the batch has given it by then.
      let titles = { ...action.payload.sheets };
      let changes = action.payload.changes.flatMap(change => {
        let given = asGiven(change, titles);
        if (change.op === "renameSheet") titles[change.sheetId] = change.title;
        return touches(change) ? [given] : [];
      });
      return changes.length === 0 ? [] : [{
        id, ...(n < fits ? {} : { stale: true as const }), type: "updateSpreadsheet" as const, changes,
      }];
    }),
    areas: changedAreas(base, pending.slice(0, fits), sheetId),
    sheets: {
      saved: base.sheets.map(listed),
      pending: grid.sheets.map(sheet => ({
        ...laidOut(sheet), ...(touched.has(sheet.id) ? { touched: true as const } : {}),
      })),
    },
  };
}
