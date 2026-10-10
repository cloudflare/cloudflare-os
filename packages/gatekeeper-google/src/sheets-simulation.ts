/**
 * Queued Google Sheets changes, and their replay over what a read fetched.
 *
 * Replay records what each queued change enters in each cell, and a read shows a cell holding it as
 * entered: a formula as its text, and a literal value as it is. Nothing Google computes is
 * guessed: a queued formula's result, and a number or boolean as its format displays it, read null
 * and are listed as pending. Formulas elsewhere that depend on queued cells show their saved
 * results.
 *
 * Queued changes to rows, columns and sheets move cells with their lines, and rewrite formulas as
 * Google rewrites them. A formula Google holds keeps showing its saved result only while every
 * reference in it keeps exactly its cells and nothing in it depends on where cells are; otherwise
 * it reads null and pending too. Cells of inserted lines and added sheets read blank.
 *
 * Apply re-runs the same functions over a fresh read, so the preview and the write cannot disagree
 * about which cells a change writes.
 */

import type { TaggedAction } from "@gadgets/gatekeeper-kit/actions";
import {
  replaySimulation, type SimulationResult, type SimulationStep,
} from "@gadgets/gatekeeper-kit/simulation";
import type { SheetArea } from "./sheets-api";
import {
  rewriteFormula, structureSensitive, tokenize, type RewriteStep, type RewrittenFormula,
} from "./sheets-formula";
import type { LineOp } from "./sheets-input";
import { a1Of, cellName, findSheet, isFormula, shownValue, type Rect } from "./sheets-model";
import { cellKey, planSheet } from "./sheets-plan";
import type { SpreadsheetCellValue, SpreadsheetRange, SpreadsheetValueMode } from "./sheets-read-types";
import { baseIndexOf, baseLines, basePieces, linesAt, type Lines } from "./sheets-structure";
import { ChangeConflict } from "./slides-text";
import type { SheetCellInput } from "./sheets-types";

/** A sheet as the spreadsheet's metadata describes it. */
export type SheetMeta = {
  id: number;
  title: string;
  index: number;
  rowCount: number;
  columnCount: number;
  hidden?: boolean;
  /** How many leading rows are frozen, when any are; Google keeps at least one row unfrozen. */
  frozenRowCount?: number;
  /** How many leading columns are frozen, when any are. */
  frozenColumnCount?: number;
};

/**
 * A sheet as queued changes leave it: its rows and columns, and `source`, the ID of the sheet
 * Google holds whose cells its lines of that sheet read. A sheet Google holds is its own source, a
 * copy has its original's, and a sheet a queued change adds has none.
 */
export type SimSheet = SheetMeta & { rows: Lines; columns: Lines; source?: number };

/**
 * What a queued change entered in a cell: `input`, null for a clear; `at`, the length of the
 * grid's log when it was entered, so its formula is rewritten only by the steps after; and `by`,
 * the ID of the queued change that entered it, 0 outside a replay.
 */
export type Entry = { input: SheetCellInput; at: number; by: number };

/** A change to rows, columns or sheets as replayed, with the titles sheets then had. */
export type StructuralStep =
  | (Extract<RewriteStep, { kind: "insert" | "delete" | "rename" | "deleteSheet" }> & { sheetId: number })
  | (Extract<RewriteStep, { kind: "duplicate" }> & { sheetId: number; newSheetId: number })
  | { kind: "add"; sheetId: number; title: string };

/**
 * What a read fetched, with queued changes applied: the sheets, sorted by index; what queued
 * changes entered in cells, keyed by `cellKey` from `sheets-plan.ts` with the identities of the
 * cell's row and column, so an entry moves with its lines; and every change to rows, columns or
 * sheets replayed, in order.
 */
export type Grid = {
  sheets: readonly SimSheet[];
  cells: ReadonlyMap<string, Entry>;
  log: readonly StructuralStep[];
};

/**
 * A change as queued: the sheet it acts on by ID, its formulas as Google stores them, and the
 * first line it inserts before or deletes, zero-based. A deleted sheet's size is the approver's;
 * `appends` says inserted lines go after the last.
 */
export type PlannedChange =
  | { op: "writeCells"; sheetId: number; rect: Rect; values: SheetCellInput[][] }
  | { op: "clearRange"; sheetId: number; rect: Rect }
  | { op: "addSheet"; sheetId: number; title: string; index: number; rowCount: number; columnCount: number }
  | { op: "renameSheet"; sheetId: number; title: string }
  | { op: "duplicateSheet"; sheetId: number; newSheetId: number; title: string; index: number }
  | { op: "deleteSheet"; sheetId: number; rowCount: number; columnCount: number }
  | { op: Extract<LineOp, `insert${string}`>; sheetId: number; start: number; count: number; appends?: true }
  | { op: Extract<LineOp, `delete${string}`>; sheetId: number; start: number; count: number };

/**
 * An `updateSheet()` batch. `sheets` gives the title of each sheet a change acts on or creates, as
 * it was when the batch was queued (a created sheet's as created), so the approver can recognize
 * it. `marker` identifies the batch's write in the spreadsheet, so its outcome can be found when
 * Google's answer is lost. `guard` is a digest of what the batch overwrites or removes as it was to
 * be by the time the batch applies: as Google held it, with what changes queued before it enter.
 * `after` lists those of them it builds on, which must have been applied for the digest to hold.
 * `cells` are the cells it covers, as the spreadsheet is to be just before the batch applies;
 * without them, the cells the changes write.
 */
export type SheetBatch = {
  changes: PlannedChange[];
  sheets: Record<string, string>;
  marker: { id: number; token: string };
  guard: { sha256: string; after: number[]; cells?: SheetArea[] };
};

/**
 * The payload of each kind of queued change. A batch is queued as `editSheetValues` when it only
 * enters literal values and clears cells, and `updateSheet` otherwise; they differ in nothing but
 * which kinds a user may let apply without asking.
 */
export type SheetsActions = {
  editSheetValues: SheetBatch;
  updateSheet: SheetBatch;
};

/** A queued change, as the journal stores it. */
export type SheetsAction = TaggedAction<SheetsActions>;

/** One journal entry visible to replay. */
export type QueuedChange = { readonly id: number; readonly action: SheetsAction };

/** The grid of a spreadsheet as Google holds it, with no change queued. */
export function gridOf(metadata: { sheets: readonly SheetMeta[] }): Grid {
  return {
    sheets: metadata.sheets
      .map(sheet => ({
        ...sheet, rows: baseLines(sheet.rowCount), columns: baseLines(sheet.columnCount), source: sheet.id,
      }))
      .toSorted((a, b) => a.index - b.index),
    cells: new Map(),
    log: [],
  };
}

/**
 * Applies one queued change to `grid`, returning a new grid. `id` is the change's action ID, which
 * the cells it enters record. Throws `ChangeConflict`.
 */
export function applyChange(grid: Grid, action: SheetsAction, id = 0): Grid {
  return planSheet(grid, action.payload.changes, id).grid;
}

function replayStep(grid: Grid, change: QueuedChange): SimulationStep<Grid> {
  try {
    let next = applyChange(grid, change.action, change.id);
    return next === grid ? { kind: "known-no-effect" } : { kind: "applied", value: next };
  } catch (error) {
    if (error instanceof ChangeConflict) return { kind: "unsupported", reason: error.message };
    throw error;
  }
}

/** Replays queued changes over a read, stopping at the first that no longer applies. */
export function replayChanges(
  base: Grid, changes: readonly QueuedChange[],
): SimulationResult<Grid, QueuedChange> {
  return replaySimulation(base, changes, replayStep);
}

/** The reason a read shows only some queued changes: the first that no longer applies. */
export function conflictReason(change: QueuedChange, reason: string): string {
  return `Queued change ${change.id} no longer applies, so it and the changes queued after it are ` +
    `not shown: ${reason}.`;
}

// Whether `formula` has a reference naming the sheet titled `title`, ignoring case.
function names(formula: string, title: string): boolean {
  let wanted = title.toLowerCase();
  return tokenize(formula).some(token => token.kind === "reference" && token.sheet?.toLowerCase() === wanted);
}

// `formula`, on sheet `host`, rewritten through `step`. A reference to a title no sheet had, which
// a step gives a sheet, is not followed: its cells count as changed.
function rewriteThrough(formula: string, step: StructuralStep, host: number): RewrittenFormula {
  switch (step.kind) {
    case "insert":
    case "delete":
    case "deleteSheet":
      return rewriteFormula(formula, step, host === step.sheetId);
    case "rename": {
      let rewritten = rewriteFormula(formula, step, false);
      let taken = step.from.toLowerCase() !== step.to.toLowerCase() && names(formula, step.to);
      return taken ? { ...rewritten, cellsChanged: true } : rewritten;
    }
    case "duplicate": {
      let rewritten = rewriteFormula(formula, step, host === step.newSheetId);
      return names(formula, step.newTitle) ? { ...rewritten, cellsChanged: true } : rewritten;
    }
    case "add":
      return { text: formula, cellsChanged: names(formula, step.title), broken: false };
  }
}

// Stands in for a reference set aside from rewriting: private-use characters, which no formula
// Google accepts holds, around one encoding which reference it is.
const FROZEN_START = "\uE000";
const FROZEN_END = "\uE001";
const FROZEN_INDEX = 0xE100;
const FROZEN_LAST = 0xF8FF;
const FROZEN = /\uE000([\uE100-\uF8FF])\uE001/g;

/**
 * `formula`, on sheet `sheetId` once the grid's log has run, rewritten through the log from step
 * `from` on, as Google rewrites it, with whether its references' cells changed or broke on the
 * way. A copy's formulas were on the sheet copied until the copy was made.
 */
export function formulaAt(grid: Grid, sheetId: number, formula: string, from: number): RewrittenFormula {
  let { log } = grid;
  // The sheet the formula is on at each step, found from the last back.
  let hosts: number[] = [];
  let host = sheetId;
  for (let s = log.length - 1; s >= from; s--) {
    hosts[s - from] = host;
    let step = log[s];
    if (step.kind === "duplicate" && step.newSheetId === host) host = step.sheetId;
  }
  // The titles the spreadsheet has before each step, found from the last back.
  let titles: Set<string>[] = [];
  let live = new Set(grid.sheets.map(sheet => sheet.title.toLowerCase()));
  for (let s = log.length - 1; s >= from; s--) {
    let step = log[s];
    live = new Set(live);
    if (step.kind === "add") live.delete(step.title.toLowerCase());
    if (step.kind === "duplicate") live.delete(step.newTitle.toLowerCase());
    if (step.kind === "deleteSheet") live.add(step.title.toLowerCase());
    if (step.kind === "rename") {
      live.delete(step.to.toLowerCase());
      live.add(step.from.toLowerCase());
    }
    titles[s - from] = live;
  }
  // A reference naming a sheet that does not exist when a step runs, because it never did or was
  // deleted, is not that sheet's, even if a later step gives a sheet its title: it is set aside
  // until the end, so no later step rewrites it, and reads broken.
  let frozen: string[] = [];
  // Text already holding the stand-in, or more references than it can number, is not set aside,
  // and reads broken instead.
  let unfreezable = false;
  let freezable = !formula.includes(FROZEN_START);
  let freeze = (text: string, exists: Set<string>) => tokenize(text).map(token => {
    if (token.kind !== "reference" || token.sheet === undefined || exists.has(token.sheet.toLowerCase())) {
      return token.text;
    }
    if (!freezable || FROZEN_INDEX + frozen.length > FROZEN_LAST) {
      unfreezable = true;
      return token.text;
    }
    frozen.push(token.text);
    return FROZEN_START + String.fromCharCode(FROZEN_INDEX + frozen.length - 1) + FROZEN_END;
  }).join("");
  let result: RewrittenFormula = { text: formula, cellsChanged: false, broken: false };
  for (let s = from; s < log.length; s++) {
    let before = frozen.length;
    let text = freeze(result.text, titles[s - from]);
    let rewritten = rewriteThrough(text, log[s], hosts[s - from]);
    result = {
      text: rewritten.text,
      cellsChanged: result.cellsChanged || rewritten.cellsChanged,
      broken: result.broken || rewritten.broken || frozen.length > before || unfreezable,
    };
  }
  return {
    ...result,
    text: result.text.replace(FROZEN, (_, index: string) => frozen[index.charCodeAt(0) - FROZEN_INDEX]),
  };
}

/**
 * `read`, Google's values for `rect` of sheet `sheetId` padded to its size, showing what queued
 * changes entered in its cells as `mode` reads them, and listing the cells that read null because
 * only Google can work their value out. For a grid whose log is empty, where every cell is where
 * Google holds it.
 */
export function overlayRange(
  read: SpreadsheetRange, sheetId: number, rect: Rect, grid: Grid, mode?: SpreadsheetValueMode,
): SpreadsheetRange {
  let sheet = grid.sheets.find(candidate => candidate.id === sheetId);
  if (!sheet) return read;
  let rows = linesAt(sheet.rows, rect.startRow, rect.endRow);
  let columns = linesAt(sheet.columns, rect.startColumn, rect.endColumn);
  let pendingCells: string[] = [];
  let values = read.values.map((line, r) => line.map((value, c) => {
    let entry = rows[r] === undefined || columns[c] === undefined
      ? undefined : grid.cells.get(cellKey(sheetId, rows[r], columns[c]));
    if (!entry) return value;
    let shown = shownValue(entry.input, mode);
    if (shown.pending) pendingCells.push(cellName(rect.startRow + r, rect.startColumn + c));
    return shown.value;
  }));
  return { ...read, values, ...(pendingCells.length > 0 ? { pendingCells } : {}) };
}

/** The most pieces of the spreadsheet Google holds that one simulated read may fetch. */
export const MAX_READ_PIECES = 20;
/** The most cells one simulated read may fetch. */
export const MAX_READ_CELLS = 50_000;

/**
 * A range a read asks for in the grid: the sheet, its cells clipped to the sheet's grid as Google
 * clips them, and the size asked for, which the values are padded to.
 */
export type SimulatedArea = { sheetId: number; rect: Rect; rows: number; columns: number };

/**
 * Finds the sheet a parsed range names in `grid`, the first visible sheet when it names none, and
 * clips its cells to the sheet as Google does. Throws `Error` as Google refuses such a range.
 */
export function resolveArea(grid: Grid, range: { sheet?: string; rect: Rect }): SimulatedArea {
  let sheet = findSheet(grid.sheets, range.sheet);
  if (!sheet) {
    throw new Error(range.sheet === undefined
      ? "The spreadsheet has no visible sheet with the queued changes applied."
      : `The spreadsheet has no sheet named "${range.sheet}" with the queued changes applied.`);
  }
  let { rect } = range;
  if (rect.startRow >= sheet.rowCount || rect.startColumn >= sheet.columnCount) {
    throw new Error(`Range (${a1Of(sheet.title, rect)}) exceeds grid limits. Max rows: ` +
      `${sheet.rowCount}, max columns: ${sheet.columnCount}`);
  }
  return {
    sheetId: sheet.id,
    rect: { ...rect, endRow: Math.min(rect.endRow, sheet.rowCount), endColumn: Math.min(rect.endColumn, sheet.columnCount) },
    rows: rect.endRow - rect.startRow,
    columns: rect.endColumn - rect.startColumn,
  };
}

function sheetOf(grid: Grid, sheetId: number): SimSheet {
  let sheet = grid.sheets.find(candidate => candidate.id === sheetId);
  if (!sheet) throw new Error(`The simulated spreadsheet has no sheet with ID ${sheetId}.`);
  return sheet;
}

/**
 * The cells of the spreadsheet Google holds that `areas` of `grid` show, as areas of the sheets
 * Google holds: none for inserted lines or added sheets, and pieces of a range that deleted or
 * inserted lines split. Each piece is listed once.
 */
export function basePiecesOf(grid: Grid, areas: readonly { sheetId: number; rect: Rect }[]): SheetArea[] {
  let pieces = new Map<string, SheetArea>();
  for (let { sheetId, rect } of areas) {
    let sheet = sheetOf(grid, sheetId);
    if (sheet.source === undefined) continue;
    for (let rows of basePieces(sheet.rows, rect.startRow, rect.endRow)) {
      for (let columns of basePieces(sheet.columns, rect.startColumn, rect.endColumn)) {
        let piece = {
          sheetId: sheet.source,
          rect: {
            startRow: rows.start, endRow: rows.start + rows.length,
            startColumn: columns.start, endColumn: columns.start + columns.length,
          },
        };
        pieces.set(JSON.stringify(piece), piece);
      }
    }
  }
  return [...pieces.values()];
}

/**
 * `basePiecesOf` for a read. Throws `Error` when they are more than a read may fetch.
 */
export function rangesToFetch(grid: Grid, areas: readonly { sheetId: number; rect: Rect }[]): SheetArea[] {
  let pieces = basePiecesOf(grid, areas);
  let cells = pieces.reduce((total, { rect }) =>
    total + (rect.endRow - rect.startRow) * (rect.endColumn - rect.startColumn), 0);
  if (pieces.length > MAX_READ_PIECES || cells > MAX_READ_CELLS) {
    throw new Error("These ranges cannot be read with the queued changes applied. Read fewer cells, " +
      "or approve or reject the queued changes first.");
  }
  return pieces;
}

/** Values of cells of the sheets Google holds, by sheet ID and zero-based row and column. */
export type BaseValues = (sheetId: number, row: number, column: number) => SpreadsheetCellValue;

/** `values[i]`, what a read of `pieces[i]` returned padded to its size, by cell. */
export function baseValues(
  pieces: readonly SheetArea[], values: readonly (readonly (readonly SpreadsheetCellValue[])[])[],
): BaseValues {
  let cells = new Map<string, SpreadsheetCellValue>();
  pieces.forEach(({ sheetId, rect }, i) => values[i]?.forEach((line, r) => line.forEach((value, c) => {
    if (value !== null) cells.set(`${sheetId}:${rect.startRow + r}:${rect.startColumn + c}`, value);
  })));
  return (sheetId, row, column) => cells.get(`${sheetId}:${row}:${column}`) ?? null;
}

/** What Google holds in a read's base cells: in the mode read, and in formula mode. */
export type BaseRead = { shown: BaseValues; formulas: BaseValues };

// The value of one cell of `sheet` in `mode`, and whether only Google can work it out.
function cellValue(
  grid: Grid, sheet: SimSheet, row: string | undefined, column: string | undefined, base: BaseRead,
  mode: SpreadsheetValueMode,
): { value: SpreadsheetCellValue; pending: boolean } {
  if (row === undefined || column === undefined) return { value: null, pending: false };
  let entry = grid.cells.get(cellKey(sheet.id, row, column));
  if (entry) {
    let input = isFormula(entry.input) ? formulaAt(grid, sheet.id, entry.input, entry.at).text : entry.input;
    return shownValue(input, mode);
  }
  let baseRow = baseIndexOf(row);
  let baseColumn = baseIndexOf(column);
  // A cell of an inserted line, or of an added sheet, is blank.
  if (sheet.source === undefined || baseRow === undefined || baseColumn === undefined) {
    return { value: null, pending: false };
  }
  let formula = base.formulas(sheet.source, baseRow, baseColumn);
  if (!isFormula(formula) || grid.log.length === 0) {
    return { value: base.shown(sheet.source, baseRow, baseColumn), pending: false };
  }
  let rewritten = formulaAt(grid, sheet.id, formula, 0);
  if (mode === "formula") return { value: rewritten.text, pending: false };
  if (rewritten.cellsChanged || rewritten.broken || structureSensitive(formula)) {
    return { value: null, pending: true };
  }
  return { value: base.shown(sheet.source, baseRow, baseColumn), pending: false };
}

// The values of `rect` of `sheet`, padded to `rows` by `columns`, and the cells pending.
function cellValues(
  grid: Grid, sheet: SimSheet, rect: Rect, size: { rows: number; columns: number }, base: BaseRead,
  mode: SpreadsheetValueMode,
): { values: SpreadsheetCellValue[][]; pendingCells: string[] } {
  let rows = linesAt(sheet.rows, rect.startRow, rect.endRow);
  let columns = linesAt(sheet.columns, rect.startColumn, rect.endColumn);
  let pendingCells: string[] = [];
  let values = Array.from({ length: size.rows }, (_row, r) => Array.from({ length: size.columns }, (_column, c) => {
    if (r >= rows.length || c >= columns.length) return null;
    let { value, pending } = cellValue(grid, sheet, rows[r], columns[c], base, mode);
    if (pending) pendingCells.push(cellName(rect.startRow + r, rect.startColumn + c));
    return value;
  }));
  return { values, pendingCells };
}

/**
 * `area` of `grid` as a read in `mode` returns it, from `base`, what Google holds in the cells
 * `basePiecesOf` gives for it: queued input as entered, cells moved with their lines, formulas
 * Google holds rewritten, and the cells only Google can work out null and pending.
 */
export function simulatedRange(
  grid: Grid, area: SimulatedArea, base: BaseRead, mode: SpreadsheetValueMode = "formatted",
): SpreadsheetRange {
  let sheet = sheetOf(grid, area.sheetId);
  let { values, pendingCells } = cellValues(grid, sheet, area.rect, area, base, mode);
  return {
    range: a1Of(sheet.title, area.rect),
    values,
    ...(pendingCells.length > 0 ? { pendingCells } : {}),
  };
}

/**
 * What each of `areas`, which lie within their sheets, holds in formula mode once the changes
 * `grid` replays apply, from `formulas`, what Google holds in the cells `basePiecesOf` gives for
 * them in formula mode.
 */
export function enteredContent(
  grid: Grid, areas: readonly SheetArea[], formulas: BaseValues,
): SheetCellInput[][][] {
  let base = { shown: formulas, formulas };
  return areas.map(({ sheetId, rect }) => cellValues(grid, sheetOf(grid, sheetId), rect, {
    rows: rect.endRow - rect.startRow, columns: rect.endColumn - rect.startColumn,
  }, base, "formula").values);
}
