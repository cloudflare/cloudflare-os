/**
 * Queued Google Sheets changes, and their replay over what a read fetched.
 *
 * Replay records what each queued change enters in each cell, and a read shows a cell holding it as
 * entered: a formula as its text, and a literal value as it is. Nothing Google computes is
 * guessed: a queued formula's result, and a number or boolean as its format displays it, read null
 * and are listed as pending. Formulas elsewhere that depend on queued cells show their saved
 * results.
 *
 * Apply re-runs the same functions over a fresh read, so the preview and the write cannot disagree
 * about which cells a change writes.
 */

import type { TaggedAction } from "@gadgets/gatekeeper-kit/actions";
import {
  replaySimulation, type SimulationResult, type SimulationStep,
} from "@gadgets/gatekeeper-kit/simulation";
import { cellName, intersection, shownValue, type Rect } from "./sheets-model";
import { cellKey, planSheet } from "./sheets-plan";
import type { SpreadsheetCellValue, SpreadsheetRange, SpreadsheetValueMode } from "./sheets-read-types";
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
};

/**
 * What a read fetched, with queued changes applied: the sheets, and what queued changes entered in
 * cells, keyed by `cellKey` from `sheets-plan.ts`. A cleared cell holds null.
 */
export type Grid = {
  sheets: readonly SheetMeta[];
  cells: ReadonlyMap<string, SheetCellInput>;
};

/** A change as queued: the sheet it writes by ID, and its formulas as Google stores them. */
export type PlannedChange =
  | { op: "writeCells"; sheetId: number; rect: Rect; values: SheetCellInput[][] }
  | { op: "clearRange"; sheetId: number; rect: Rect };

/**
 * An `updateSheet()` batch. `sheets` gives the title of each sheet a change writes, as it was when
 * the batch was queued, so the approver can recognize it. `marker` identifies the batch's write in
 * the spreadsheet, so its outcome can be found when Google's answer is lost. `guard` is a digest of
 * what the batch overwrites as it was to be by the time the batch applies: as Google held it, with
 * what changes queued before it enter. `after` lists those of them whose cells it overwrites, which
 * must have been applied for the digest to hold.
 */
export type SheetBatch = {
  changes: PlannedChange[];
  sheets: Record<string, string>;
  marker: { id: number; token: string };
  guard: { sha256: string; after: number[] };
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

/** Applies one queued change to `grid`, returning a new grid. Throws `ChangeConflict`. */
export function applyChange(grid: Grid, action: SheetsAction): Grid {
  return planSheet(grid, action.payload.changes).grid;
}

function step(grid: Grid, action: SheetsAction): SimulationStep<Grid> {
  try {
    let next = applyChange(grid, action);
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
  return replaySimulation(base, changes, (grid, change) => step(grid, change.action));
}

/** The reason a read shows only some queued changes: the first that no longer applies. */
export function conflictReason(change: QueuedChange, reason: string): string {
  return `Queued change ${change.id} no longer applies, so it and the changes queued after it are ` +
    `not shown: ${reason}.`;
}

/**
 * `read`, Google's values for `rect` of sheet `sheetId` padded to its size, showing what queued
 * changes entered in its cells as `mode` reads them, and listing the cells that read null because
 * only Google can work their value out.
 */
export function overlayRange(
  read: SpreadsheetRange, sheetId: number, rect: Rect, grid: Grid, mode?: SpreadsheetValueMode,
): SpreadsheetRange {
  let pendingCells: string[] = [];
  let values = read.values.map((line, r) => line.map((value, c) => {
    let row = rect.startRow + r;
    let column = rect.startColumn + c;
    let key = cellKey(sheetId, row, column);
    if (!grid.cells.has(key)) return value;
    let shown = shownValue(grid.cells.get(key)!, mode);
    if (shown.pending) pendingCells.push(cellName(row, column));
    return shown.value;
  }));
  return { ...read, values, ...(pendingCells.length > 0 ? { pendingCells } : {}) };
}

/** The queued changes that write any of the cells `changes` write. */
export function buildsOn(pending: readonly QueuedChange[], changes: readonly PlannedChange[]): number[] {
  return pending.filter(({ action }) => action.payload.changes.some(earlier => changes.some(change =>
    change.sheetId === earlier.sheetId && intersection(change.rect, earlier.rect) !== undefined)))
    .map(({ id }) => id);
}

/**
 * `entered`, what Google holds in each of `changes`' cells in formula mode, with what queued
 * changes enter in them, as `grid` records it.
 */
export function asQueued(
  grid: Grid, changes: readonly PlannedChange[],
  entered: readonly (readonly (readonly SpreadsheetCellValue[])[])[],
): SheetCellInput[][][] {
  return changes.map(({ sheetId, rect }, i) =>
    Array.from({ length: rect.endRow - rect.startRow }, (_, r) =>
      Array.from({ length: rect.endColumn - rect.startColumn }, (_, c) => {
        let key = cellKey(sheetId, rect.startRow + r, rect.startColumn + c);
        return grid.cells.has(key) ? grid.cells.get(key)! : entered[i]?.[r]?.[c] ?? null;
      })));
}
