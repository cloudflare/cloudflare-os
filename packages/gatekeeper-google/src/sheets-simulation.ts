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
 * Queued formatting is recorded by cell, as entered input is, and merged over the formatting the
 * cell has. What Google decides is left pending: the formatting of inserted lines, a border beside
 * one a queued change draws, and, in a formatted read, a value in a number format a queued change
 * sets.
 *
 * Apply re-runs the same functions over a fresh read, so the preview and the write cannot disagree
 * about which cells a change writes.
 */

import type { TaggedAction } from "@gadgets/gatekeeper-kit/actions";
import {
  replaySimulation, type SimulationResult, type SimulationStep,
} from "@gadgets/gatekeeper-kit/simulation";
import type { SheetArea } from "./sheets-api";
import { mergeFormat, type BaseFormats, type FormatEntry } from "./sheets-format";
import {
  rewriteFormula, structureSensitive, tokenize, type RewriteStep, type RewrittenFormula,
} from "./sheets-formula";
import type { LineOp } from "./sheets-input";
import {
  a1Of, cellName, enteredOf, findSheet, isFormula, shownValue, type EnteredValue, type Rect,
} from "./sheets-model";
import { cellKey, planSheet } from "./sheets-plan";
import type {
  SpreadsheetCellValue, SpreadsheetFormats, SpreadsheetRange, SpreadsheetValueMode,
} from "./sheets-read-types";
import { baseIndexOf, baseLines, basePieces, linesAt, type Lines } from "./sheets-structure";
import { ChangeConflict } from "./slides-text";
import type { SheetCellInput, SheetFormatChange } from "./sheets-types";

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
 * changes entered in cells, and set on their formatting, keyed by `cellKey` from `sheets-plan.ts`
 * with the identities of the cell's row and column, so an entry moves with its lines; and every
 * change to rows, columns or sheets replayed, in order.
 */
export type Grid = {
  sheets: readonly SimSheet[];
  cells: ReadonlyMap<string, Entry>;
  formats: ReadonlyMap<string, FormatEntry>;
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
  | { op: "formatCells"; sheetId: number; rect: Rect; format: SheetFormatChange }
  | { op: "addSheet"; sheetId: number; title: string; index: number; rowCount: number; columnCount: number }
  | { op: "renameSheet"; sheetId: number; title: string }
  | { op: "duplicateSheet"; sheetId: number; newSheetId: number; title: string; index: number }
  | { op: "deleteSheet"; sheetId: number; rowCount: number; columnCount: number }
  | { op: Extract<LineOp, `insert${string}`>; sheetId: number; start: number; count: number; appends?: true }
  | { op: Extract<LineOp, `delete${string}`>; sheetId: number; start: number; count: number };

/**
 * An `updateSpreadsheet()` batch. `sheets` gives the title of each sheet a change acts on or
 * creates, as it was when the batch was queued (a created sheet's as created), so the approver can
 * recognize it. `marker` identifies the batch's write in the spreadsheet, so its outcome can be
 * found when Google's answer is lost. `guard` is a digest of what the batch overwrites or removes
 * as it was to be by the time the batch applies: as Google held it, with what changes queued
 * before it enter. `after` lists those of them it builds on, which must have been applied for the
 * digest to hold. `cells` are the cells it covers, as the spreadsheet is to be just before the
 * batch applies; without them, the cells the changes write.
 */
export type SheetBatch = {
  changes: PlannedChange[];
  sheets: Record<string, string>;
  marker: { id: number; token: string };
  guard: { sha256: string; after: number[]; cells?: SheetArea[] };
};

/**
 * The payload of each kind of queued change. A batch is queued as `editSheetValues` when it only
 * enters literal values and clears cells, `formatSheets` when it only formats cells, and
 * `updateSpreadsheet` otherwise; they differ in nothing but which kinds a user may let apply without
 * asking.
 */
export type SheetsActions = {
  editSheetValues: SheetBatch;
  formatSheets: SheetBatch;
  updateSpreadsheet: SheetBatch;
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
    formats: new Map(),
    log: [],
  };
}

/**
 * Applies one queued change to `grid`, returning a new grid. `id` is the change's action ID, which
 * the cells it enters record. Throws `ChangeConflict`, also for a sheet it acts on that is no longer
 * titled as when it was queued, which its guard would refuse.
 */
export function applyChange(grid: Grid, action: SheetsAction, id = 0): Grid {
  for (let [sheetId, title] of Object.entries(action.payload.sheets)) {
    // A sheet the change creates is not there yet.
    let sheet = grid.sheets.find(candidate => candidate.id === Number(sheetId));
    if (sheet && sheet.title !== title) {
      throw new ChangeConflict(`the sheet "${title}" it acts on has been renamed "${sheet.title}"`);
    }
  }
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
 * Thrown for a formula naming a missing sheet that `formulaAt` cannot set aside: its text holds the
 * characters it sets references aside with, from the start or from a title a queued change gives a
 * sheet, or it names missing sheets more often than they number.
 */
export class UnsimulatedFormula extends Error {}

// What `formulaAt` needs of a grid's log, worked out once per grid in space linear in the log and
// the sheets. By title, ignoring case: `held`, the runs of steps `[start, end)` before which a
// sheet has it, ascending and apart; and `involving`, the steps involving it. By sheet:
// `targeting`, the steps that rewrite the formulas on it as theirs (unqualified references, or a
// copy's references to its original); `copying`, the steps that copy to it; and `hosts`, the
// sheet a formula ending on it is on from each step of a run on.
type LogView = {
  held: Map<string, [number, number][]>;
  involving: Map<string, number[]>;
  targeting: Map<number, number[]>;
  copying: Map<number, number[]>;
  hosts: Map<number, { start: number; host: number }[]>;
};

const LOG_VIEWS = new WeakMap<Grid, LogView>();

// Adds `value` to the list `map` holds for `key`.
function listed<K, V>(map: Map<K, V[]>, key: K, value: V) {
  let values = map.get(key);
  if (values) values.push(value);
  else map.set(key, [value]);
}

function logView(grid: Grid): LogView {
  let view = LOG_VIEWS.get(grid);
  if (view) return view;
  let { log } = grid;
  view = { held: new Map(), involving: new Map(), targeting: new Map(), copying: new Map(), hosts: new Map() };
  let { held } = view;
  // The titles held before the step reached, found from the last back, each with the step its run
  // ends before.
  let live = new Map(grid.sheets.map(sheet => [sheet.title.toLowerCase(), log.length]));
  let close = (title: string, start: number) => {
    let end = live.get(title);
    if (end === undefined) return;
    live.delete(title);
    if (start >= end) return;
    // Runs are found from the last back, so the one found before this one follows it.
    let later = held.get(title)?.at(-1);
    if (later?.[0] === end) later[0] = start;
    else listed(held, title, [start, end] as [number, number]);
  };
  let open = (title: string, end: number) => {
    if (!live.has(title)) live.set(title, end);
  };
  for (let s = log.length - 1; s >= 0; s--) {
    let step = log[s];
    if (step.kind === "add") close(step.title.toLowerCase(), s + 1);
    if (step.kind === "duplicate") close(step.newTitle.toLowerCase(), s + 1);
    if (step.kind === "deleteSheet") open(step.title.toLowerCase(), s + 1);
    if (step.kind === "rename") {
      close(step.to.toLowerCase(), s + 1);
      open(step.from.toLowerCase(), s + 1);
    }
  }
  for (let title of live.keys()) close(title, 0);
  for (let runs of held.values()) runs.reverse();
  log.forEach((step, s) => {
    let titles = step.kind === "rename" ? [step.from, step.to]
      : step.kind === "duplicate" ? [step.title, step.newTitle] : [step.title];
    for (let title of new Set(titles.map(name => name.toLowerCase()))) listed(view.involving, title, s);
    let target = step.kind === "duplicate" ? step.newSheetId
      : step.kind === "rename" || step.kind === "add" ? undefined : step.sheetId;
    if (target !== undefined) listed(view.targeting, target, s);
    if (step.kind === "duplicate") listed(view.copying, step.newSheetId, s);
  });
  LOG_VIEWS.set(grid, view);
  return view;
}

// The index of the first of `sorted` that is at least `value`, or its length.
function firstAtLeast(sorted: readonly number[], value: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    let middle = (low + high) >>> 1;
    if (sorted[middle] < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

// The sheet a formula on sheet `sheetId` once the log has run is on, as runs of steps, each from
// its `start` to the next's: found from the last step back, through the copies that made each.
function hostsOf(grid: Grid, view: LogView, sheetId: number) {
  let hosts = view.hosts.get(sheetId);
  if (hosts) return hosts;
  hosts = [];
  let host = sheetId;
  let end = grid.log.length;
  while (end > 0) {
    let copies = view.copying.get(host) ?? [];
    let copy = copies[firstAtLeast(copies, end) - 1];
    if (copy === undefined) {
      hosts.push({ start: 0, host });
      break;
    }
    hosts.push({ start: copy, host });
    host = (grid.log[copy] as Extract<StructuralStep, { kind: "duplicate" }>).sheetId;
    end = copy;
  }
  hosts.reverse();
  view.hosts.set(sheetId, hosts);
  return hosts;
}

// The titles of the sheets `formula`'s references name, ignoring case. Only a reference with a
// `!` names one.
function namedSheets(formula: string): Set<string> {
  if (!formula.includes("!")) return new Set();
  return new Set(tokenize(formula).flatMap(token =>
    token.kind === "reference" && token.sheet !== undefined ? [token.sheet.toLowerCase()] : []));
}

/**
 * `formula`, on sheet `sheetId` once the grid's log has run, rewritten through the log from step
 * `from` on, as Google rewrites it, with whether its references' cells changed or broke on the
 * way. A copy's formulas were on the sheet copied until the copy was made.
 */
export function formulaAt(grid: Grid, sheetId: number, formula: string, from: number): RewrittenFormula {
  let { log } = grid;
  let view = logView(grid);
  let hosts = hostsOf(grid, view, sheetId);
  // The run of `hosts` that step `s` is in.
  let hostRun = (s: number) => {
    let low = 0;
    let high = hosts.length - 1;
    while (low < high) {
      let middle = (low + high + 1) >>> 1;
      if (hosts[middle].start <= s) low = middle;
      else high = middle - 1;
    }
    return low;
  };
  // The run of steps holding `title` that ends after step `s`, if any.
  let heldRun = (title: string, s: number) => {
    let runs = view.held.get(title) ?? [];
    let low = 0;
    let high = runs.length;
    while (low < high) {
      let middle = (low + high) >>> 1;
      if (runs[middle][1] <= s) low = middle + 1;
      else high = middle;
    }
    return runs[low] as [number, number] | undefined;
  };
  let exists = (title: string, s: number) => (heldRun(title, s)?.[0] ?? Infinity) <= s;
  // A reference naming a sheet that does not exist when a step runs, because it never did or was
  // deleted, is not that sheet's, even if a later step gives a sheet its title: it is set aside
  // until the end, so no later step rewrites it, and reads broken.
  let frozen: string[] = [];
  let freezable = !formula.includes(FROZEN_START);
  let freeze = (text: string, s: number) => tokenize(text).map(token => {
    if (token.kind !== "reference" || token.sheet === undefined || exists(token.sheet.toLowerCase(), s)) {
      return token.text;
    }
    // Rewritten by later steps, it would read as neither Google's text nor the formula's.
    if (!freezable || FROZEN_INDEX + frozen.length > FROZEN_LAST) {
      throw new UnsimulatedFormula("A formula names a missing sheet in a way that cannot be followed.");
    }
    frozen.push(token.text);
    return FROZEN_START + String.fromCharCode(FROZEN_INDEX + frozen.length - 1) + FROZEN_END;
  }).join("");
  let result: RewrittenFormula = { text: formula, cellsChanged: false, broken: false };
  let named: Set<string> | undefined;
  // The first step from `s` on that may change the formula: one rewriting the formulas on the
  // sheet it is then on, or one involving a sheet it names or run while that sheet is missing.
  let next = (s: number) => {
    if (s >= log.length) return log.length;
    let found = log.length;
    for (let run = hostRun(s); run < hosts.length; run++) {
      let end = hosts[run + 1]?.start ?? log.length;
      let steps = view.targeting.get(hosts[run].host) ?? [];
      let step = steps[firstAtLeast(steps, Math.max(s, hosts[run].start))];
      if (step !== undefined && step < end) {
        found = step;
        break;
      }
    }
    for (let title of named ??= namedSheets(result.text)) {
      let steps = view.involving.get(title) ?? [];
      found = Math.min(found, steps[firstAtLeast(steps, s)] ?? found);
      let run = heldRun(title, s);
      found = Math.min(found, run === undefined || run[0] > s ? s : run[1]);
    }
    return found;
  };
  for (let s = next(from); s < log.length; s = next(s + 1)) {
    let before = frozen.length;
    let text = freeze(result.text, s);
    let rewritten = rewriteThrough(text, log[s], hosts[hostRun(s)].host);
    if (rewritten.text !== result.text) named = undefined;
    result = {
      text: rewritten.text,
      cellsChanged: result.cellsChanged || rewritten.cellsChanged,
      broken: result.broken || rewritten.broken || frozen.length > before,
    };
  }
  // A formula holding the placeholders' characters itself has none set aside, so its text stands.
  if (frozen.length === 0) return result;
  // A title a queued change gave a sheet may hold them too, and could not be told from a placeholder.
  if (result.text.split(FROZEN_START).length - 1 !== frozen.length) {
    throw new UnsimulatedFormula("A formula names a missing sheet in a way that cannot be followed.");
  }
  return {
    ...result,
    text: result.text.replace(FROZEN, (match, index: string) => frozen[index.charCodeAt(0) - FROZEN_INDEX] ?? match),
  };
}

type Shown = { value: SpreadsheetCellValue; pending: boolean };

/**
 * `shown`, the cell keyed `key` as `mode` reads it, made pending when a formatted read would show
 * it in a number format only Google can display: one a queued change sets or resets, or, for a
 * value queued on an inserted row or column, the one it takes from the line before it. That holds
 * for a cell that reads blank too, since a format such as `;;;` hides what a cell holds; only a
 * cell a queued change empties is known to read blank.
 */
function displayed(shown: Shown, grid: Grid, key: string, mode: SpreadsheetValueMode = "formatted"): Shown {
  if (mode !== "formatted") return shown;
  let input = grid.cells.get(key)?.input;
  let unknown = grid.formats.get(key)?.set.numberFormat !== undefined ||
    (input !== undefined && key.split(":").slice(1).some(identity => insertedLine(grid, identity)));
  return !unknown || input === null ? shown : { value: null, pending: true };
}

/**
 * `read`, Google's values for `rect` of sheet `sheetId` padded to its size, showing what queued
 * changes entered in its cells as `mode` reads them, and listing the cells that read null because
 * only Google can work their value out, or, in a formatted read, display it in a number format a
 * queued change sets. For a grid whose log is empty, where every cell is where Google holds it.
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
    let row = rows[r];
    let column = columns[c];
    if (row === undefined || column === undefined) return value;
    let key = cellKey(sheetId, row, column);
    let entry = grid.cells.get(key);
    let shown = displayed(entry ? shownValue(entry.input, mode) : { value, pending: false }, grid, key, mode);
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
 * The most formula text one simulated read or guard may rewrite, in characters, counting each
 * formula it shows once for every queued change to rows, columns or sheets: each costs a pass over
 * the formula's text.
 */
export const MAX_REWRITE_WORK = 5_000_000;
/**
 * The most text, in UTF-16 units, one simulated read or guard may build, as Google caps its own
 * answers at 5 MiB: a rewritten formula can be longer than the one Google holds, as when a sheet it
 * names is renamed to a longer title.
 */
export const MAX_SIMULATED_TEXT = 5 * 1024 * 1024;

/** Thrown when a simulated read or guard would build more than `MAX_SIMULATED_TEXT`. */
export class SimulatedTextTooLong extends Error {}

/** What is left of `MAX_SIMULATED_TEXT` for one simulated read or guard, across its ranges. */
export type TextBudget = { left: number };

/** A fresh `TextBudget`. */
export function textBudget(): TextBudget {
  return { left: MAX_SIMULATED_TEXT };
}

// Takes the text of `value` from `budget`, throwing `SimulatedTextTooLong` once it runs out.
function spend<T extends EnteredValue>(budget: TextBudget, value: T): T {
  budget.left -= typeof value === "string" ? value.length : holdsFormula(value) ? value.formula.length : 0;
  if (budget.left < 0) throw new SimulatedTextTooLong("A simulated read or guard would build too much text.");
  return value;
}

/**
 * How much formula text showing `areas` of `grid` rewrites, in characters, from `entered`, what
 * Google holds in the cells `basePiecesOf` gives for them: each formula an area shows, Google's or
 * queued, once for every step of the log, and again for every other area showing it.
 */
export function rewriteWork(
  grid: Grid, areas: readonly { sheetId: number; rect: Rect }[], entered: BaseCells<EnteredValue>,
): number {
  if (grid.log.length === 0) return 0;
  let text = 0;
  for (let { sheetId, rect } of areas) {
    let sheet = sheetOf(grid, sheetId);
    let columns = linesAt(sheet.columns, rect.startColumn, rect.endColumn);
    for (let row of linesAt(sheet.rows, rect.startRow, rect.endRow)) {
      for (let column of columns) {
        if (row === undefined || column === undefined) continue;
        let entry = grid.cells.get(cellKey(sheet.id, row, column));
        if (entry) {
          if (isFormula(entry.input)) text += entry.input.length;
          continue;
        }
        let baseRow = baseIndexOf(row);
        let baseColumn = baseIndexOf(column);
        if (sheet.source === undefined || baseRow === undefined || baseColumn === undefined) continue;
        let value = entered(sheet.source, baseRow, baseColumn);
        if (holdsFormula(value)) text += value.formula.length;
      }
    }
  }
  return text * grid.log.length;
}

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
export type BaseCells<T> = (sheetId: number, row: number, column: number) => T | null;

/** Cells of the sheets Google holds as a read shows them. */
export type BaseValues = BaseCells<SpreadsheetCellValue>;

/** `values[i]`, what a read of `pieces[i]` returned padded to its size, by cell. */
export function baseValues<T extends EnteredValue = SpreadsheetCellValue>(
  pieces: readonly SheetArea[], values: readonly (readonly (readonly (T | null)[])[])[],
): BaseCells<T> {
  let cells = new Map<string, T>();
  pieces.forEach(({ sheetId, rect }, i) => values[i]?.forEach((line, r) => line.forEach((value, c) => {
    if (value !== null) cells.set(`${sheetId}:${rect.startRow + r}:${rect.startColumn + c}`, value);
  })));
  return (sheetId, row, column) => cells.get(`${sheetId}:${row}:${column}`) ?? null;
}

/**
 * What Google holds in a read's base cells: as entered, which tells a formula from text that
 * starts with `=`, and as the mode read shows them, which also shows what Google fills cells
 * holding nothing entered with.
 */
export type BaseRead = { entered: BaseCells<EnteredValue>; shown: BaseValues };

/** Whether a cell holds a formula, rather than text, even text starting with `=`. */
export function holdsFormula(value: EnteredValue): value is { formula: string } {
  return value !== null && typeof value === "object" && "formula" in value;
}

// Each error value Google lets a cell hold typed, by type, as a formula-mode read shows it.
const ERROR_TEXT = new Map([
  ["N_A", "#N/A ()"], ["NAME", "#NAME? ()"], ["VALUE", "#VALUE! ()"], ["NUM", "#NUM! ()"],
  ["NULL_VALUE", "#NULL! ()"], ["ERROR", "#ERROR! ()"], ["REF", "#REF! ()"], ["DIVIDE_BY_ZERO", "#DIV/0! ()"],
]);

// A cell holding no formula as a formula-mode read shows it. An error of a type not known here
// reads pending.
function literalText(value: Exclude<EnteredValue, { formula: string }>): { value: SpreadsheetCellValue; pending: boolean } {
  if (value === null || typeof value !== "object") return { value, pending: false };
  let text = ERROR_TEXT.get(value.error);
  return text === undefined ? { value: null, pending: true } : { value: text, pending: false };
}

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
  let entered = base.entered(sheet.source, baseRow, baseColumn);
  let shown = { value: base.shown(sheet.source, baseRow, baseColumn), pending: false };
  // A cell Google fills with nothing entered in it, as an array formula's result spills into it or
  // a pivot table fills it, holds what only Google can work out once structure is queued.
  if (entered === null && shown.value !== null && shown.value !== "" && grid.log.length > 0) {
    return { value: null, pending: true };
  }
  // Anything but a formula, text starting with `=` included, moves with its line as it is.
  if (!holdsFormula(entered)) return mode === "formula" ? literalText(entered) : shown;
  if (grid.log.length === 0) return mode === "formula" ? { value: entered.formula, pending: false } : shown;
  let rewritten = formulaAt(grid, sheet.id, entered.formula, 0);
  if (mode === "formula") return { value: rewritten.text, pending: false };
  if (rewritten.cellsChanged || rewritten.broken || structureSensitive(entered.formula)) {
    return { value: null, pending: true };
  }
  return shown;
}

// The values of `rect` of `sheet`, padded to `rows` by `columns`, and the cells pending.
function cellValues(
  grid: Grid, sheet: SimSheet, rect: Rect, size: { rows: number; columns: number }, base: BaseRead,
  mode: SpreadsheetValueMode, budget: TextBudget,
): { values: SpreadsheetCellValue[][]; pendingCells: string[] } {
  let rows = linesAt(sheet.rows, rect.startRow, rect.endRow);
  let columns = linesAt(sheet.columns, rect.startColumn, rect.endColumn);
  let pendingCells: string[] = [];
  let values = Array.from({ length: size.rows }, (_row, r) => Array.from({ length: size.columns }, (_column, c) => {
    if (r >= rows.length || c >= columns.length) return null;
    let row = rows[r];
    let column = columns[c];
    let shown = cellValue(grid, sheet, row, column, base, mode);
    let { value, pending } = row === undefined || column === undefined
      ? shown : displayed(shown, grid, cellKey(sheet.id, row, column), mode);
    if (pending) pendingCells.push(cellName(rect.startRow + r, rect.startColumn + c));
    return spend(budget, value);
  }));
  return { values, pendingCells };
}

/**
 * `area` of `grid` as a read in `mode` returns it, from `base`, what Google holds in the cells
 * `basePiecesOf` gives for it: queued input as entered, cells moved with their lines, formulas
 * Google holds rewritten, and the cells only Google can work out null and pending. Its text is
 * taken from `budget`, shared by the ranges of one read: throws `SimulatedTextTooLong` once that
 * runs out.
 */
export function simulatedRange(
  grid: Grid, area: SimulatedArea, base: BaseRead, mode: SpreadsheetValueMode = "formatted",
  budget = textBudget(),
): SpreadsheetRange {
  let sheet = sheetOf(grid, area.sheetId);
  let { values, pendingCells } = cellValues(grid, sheet, area.rect, area, base, mode, budget);
  return {
    range: a1Of(sheet.title, area.rect),
    values,
    ...(pendingCells.length > 0 ? { pendingCells } : {}),
  };
}

const NEW_LINE = /^n(\d+)\./;

// Whether the line with `identity` is one a queued insert of rows or columns made, rather than one
// of a sheet a queued change added.
function insertedLine(grid: Grid, identity: string): boolean {
  let match = identity.match(NEW_LINE);
  return match !== null && grid.log[Number(match[1])]?.kind === "insert";
}

/**
 * `area` of `grid` as a format read returns it, from `base`, the formats of the cells of the
 * spreadsheet Google holds that `basePiecesOf` gives for it, or, for a grid whose log is empty,
 * of the area itself: what queued changes set merged over what each cell has, and cells moved
 * with their lines. Cells of added sheets start with no formatting. Cells of inserted lines read
 * null and pending, since Google gives an inserted row the formatting of the row beside it but not
 * its borders, and an inserted column its borders as well.
 */
export function simulatedFormats(grid: Grid, area: SimulatedArea, base: BaseFormats): SpreadsheetFormats {
  let sheet = sheetOf(grid, area.sheetId);
  let { rect } = area;
  let rows = linesAt(sheet.rows, rect.startRow, rect.endRow);
  let columns = linesAt(sheet.columns, rect.startColumn, rect.endColumn);
  let pendingCells: string[] = [];
  let formats = Array.from({ length: area.rows }, (_row, r) => Array.from({ length: area.columns }, (_column, c) => {
    let row = rows[r];
    let column = columns[c];
    if (row === undefined || column === undefined) return null;
    let entry = grid.formats.get(cellKey(sheet.id, row, column));
    if (insertedLine(grid, row) || insertedLine(grid, column)) {
      pendingCells.push(cellName(rect.startRow + r, rect.startColumn + c));
      return null;
    }
    let baseRow = baseIndexOf(row);
    let baseColumn = baseIndexOf(column);
    let held = sheet.source === undefined || baseRow === undefined || baseColumn === undefined
      ? null : base(sheet.source, baseRow, baseColumn);
    return mergeFormat(held, entry);
  }));
  return {
    range: a1Of(sheet.title, rect),
    formats,
    ...(pendingCells.length > 0 ? { pendingCells } : {}),
  };
}

/**
 * What each of `areas`, which lie within their sheets, holds as entered once the changes `grid`
 * replays apply, from `entered`, what Google holds in the cells `basePiecesOf` gives for them:
 * queued input, cells moved with their lines, and formulas rewritten.
 */
export function enteredContent(
  grid: Grid, areas: readonly SheetArea[], entered: BaseCells<EnteredValue>, budget = textBudget(),
): EnteredValue[][][] {
  return areas.map(({ sheetId, rect }) => {
    let sheet = sheetOf(grid, sheetId);
    let columns = linesAt(sheet.columns, rect.startColumn, rect.endColumn);
    return linesAt(sheet.rows, rect.startRow, rect.endRow).map(row => columns.map(column => {
      if (row === undefined || column === undefined) return null;
      let entry = grid.cells.get(cellKey(sheet.id, row, column));
      if (entry) {
        return spend(budget, enteredOf(
          isFormula(entry.input) ? formulaAt(grid, sheet.id, entry.input, entry.at).text : entry.input));
      }
      let baseRow = baseIndexOf(row);
      let baseColumn = baseIndexOf(column);
      // A cell of an inserted line, or of an added sheet, is blank.
      if (sheet.source === undefined || baseRow === undefined || baseColumn === undefined) return null;
      let value = entered(sheet.source, baseRow, baseColumn);
      if (!holdsFormula(value) || grid.log.length === 0) return spend(budget, value);
      return spend(budget, { formula: formulaAt(grid, sheet.id, value.formula, 0).text });
    }));
  });
}
