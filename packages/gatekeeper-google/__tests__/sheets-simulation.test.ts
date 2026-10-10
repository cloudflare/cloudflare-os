import { describe, expect, it } from "vitest";
import type { SheetArea } from "../src/sheets-api";
import { planSheet } from "../src/sheets-plan";
import type { SpreadsheetCellValue, SpreadsheetValueMode } from "../src/sheets-read-types";
import {
  applyChange, basePiecesOf, baseValues, conflictReason, enteredContent, formulaAt, gridOf,
  overlayRange, rangesToFetch, replayChanges, resolveArea, simulatedRange,
  type Grid, type PlannedChange, type QueuedChange, type SheetMeta, type SheetsAction,
} from "../src/sheets-simulation";
import { positionOf } from "../src/sheets-structure";
import { grid, rect, sheet } from "./sheets-fixture";

function queued(id: number, changes: PlannedChange[], kind: SheetsAction["kind"] = "updateSheet"): QueuedChange {
  return {
    id,
    action: {
      kind,
      payload: {
        changes, sheets: { 0: "Sales" }, marker: { id: id + 100, token: `token-${id}` },
        guard: { sha256: "0".repeat(64), after: [] },
      },
    },
  };
}

function replayed(base: Grid, pending: QueuedChange[]): Grid {
  let result = replayChanges(base, pending);
  if (result.kind !== "complete") throw new Error(result.reason);
  return result.value;
}

const SALES = sheet(0, "Sales");
const COSTS = sheet(1, "Costs", { index: 1 });

/** Nothing Google holds: every cell blank. */
const BLANK = { shown: baseValues([], []), formulas: baseValues([], []) };

/** Each sheet's ID, title, index and whether it is hidden. */
const summary = (g: Grid) => g.sheets.map(({ id, title, index, hidden }) => [id, title, index, hidden ?? false]);

/** `count` rows inserted before the 1-based row `before` of sheet `sheetId`, as queued. */
const insertRows = (sheetId: number, before: number, count = 1): PlannedChange =>
  ({ op: "insertRows", sheetId, start: before - 1, count });

/** `count` rows deleted from the 1-based row `first` of sheet `sheetId`, as queued. */
const deleteRows = (sheetId: number, first: number, count = 1): PlannedChange =>
  ({ op: "deleteRows", sheetId, start: first - 1, count });

describe("Sheets queued changes in reads", () => {
  // B2:E2 enters a formula, a number, text and a clear; F2 is left as Google has it.
  let replayedGrid = applyChange(grid([SALES, COSTS]), queued(1, [
    { op: "writeCells", sheetId: 0, rect: rect(1, 1, 1, 3), values: [["=SUM(A1:A2)", 5, "text"]] },
    { op: "clearRange", sheetId: 0, rect: rect(1, 4) },
  ]).action);
  let read = { range: "Sales!B2:F2", values: [["old", 1, "was", "kept?", "untouched"]] };

  it("shows queued input exactly in formula mode", () => {
    expect(overlayRange(read, 0, rect(1, 1, 1, 5), replayedGrid, "formula")).toEqual({
      range: "Sales!B2:F2", values: [["=SUM(A1:A2)", 5, "text", null, "untouched"]],
    });
  });

  it("shows literals in raw mode, and a formula's result as pending", () => {
    expect(overlayRange(read, 0, rect(1, 1, 1, 5), replayedGrid, "raw")).toEqual({
      range: "Sales!B2:F2", values: [[null, 5, "text", null, "untouched"]], pendingCells: ["B2"],
    });
  });

  it("shows text in formatted mode, and numbers and results as pending", () => {
    let formatted = { range: "Sales!B2:F2", values: [["$3.00", "$1.00", "was", "kept?", "untouched"]] };
    expect(overlayRange(formatted, 0, rect(1, 1, 1, 5), replayedGrid)).toEqual({
      range: "Sales!B2:F2", values: [[null, null, "text", null, "untouched"]], pendingCells: ["B2", "C2"],
    });
  });

  it("lists pending cells row by row, and overlays only the sheet read", () => {
    let filled = applyChange(grid([SALES, COSTS]), queued(1, [
      { op: "writeCells", sheetId: 1, rect: rect(0, 0, 2, 2), values: [[1, "=A1"], ["=B1", true]] },
    ]).action);
    let blank = { range: "Costs!A1:B2", values: [[null, null], [null, null]] };
    expect(overlayRange(blank, 1, rect(0, 0, 2, 2), filled, "formatted").pendingCells)
      .toEqual(["A1", "B1", "A2", "B2"]);
    expect(overlayRange({ ...blank, range: "Sales!A1:B2" }, 0, rect(0, 0, 2, 2), filled, "formatted"))
      .toEqual({ ...blank, range: "Sales!A1:B2" });
  });

  it("replays changes in order, a later one entering over an earlier", () => {
    let result = replayChanges(grid([SALES]), [
      queued(1, [{ op: "writeCells", sheetId: 0, rect: rect(0, 0, 1, 2), values: [[1, 2]] }], "editSheetValues"),
      queued(2, [{ op: "writeCells", sheetId: 0, rect: rect(0, 1), values: [["=A1*2"]] }]),
    ]);
    if (result.kind !== "complete") throw new Error(result.reason);
    expect(result.appliedCount).toBe(2);
    let blank = { range: "Sales!A1:B1", values: [[null, null]] };
    expect(overlayRange(blank, 0, rect(0, 0, 1, 2), result.value, "formula"))
      .toEqual({ range: "Sales!A1:B1", values: [[1, "=A1*2"]] });
    // Each cell records the queued change that entered it last.
    expect([...result.value.cells.values()].map(({ by }) => by)).toEqual([1, 2]);
  });

  it("counts a batch of no changes as having no effect", () => {
    let base = grid([SALES]);
    expect(replayChanges(base, [queued(1, [])])).toEqual({ kind: "complete", value: base, appliedCount: 0 });
  });

  it("stops at a change whose sheet is gone, or whose cells the sheet no longer has", () => {
    let first = queued(1, [{ op: "writeCells", sheetId: 0, rect: rect(0, 0), values: [[1]] }]);
    let gone = queued(2, [
      { op: "clearRange", sheetId: 0, rect: rect(0, 0) },
      { op: "clearRange", sheetId: 5, rect: rect(0, 0) },
    ]);
    let result = replayChanges(grid([SALES]), [first, gone, queued(3, [])]);
    expect(result).toMatchObject({
      kind: "incomplete", appliedCount: 1, unsupported: gone,
      reason: "change 2 (clearRange): the spreadsheet has no sheet with ID 5",
    });
    if (result.kind !== "incomplete") throw new Error("the replay completed");
    expect(result.partial.cells.get("0:b0:b0")).toEqual({ input: 1, at: 0, by: 1 });
    expect(conflictReason(gone, "change 2 (clearRange): the spreadsheet has no sheet with ID 5")).toBe(
      "Queued change 2 no longer applies, so it and the changes queued after it are not shown: " +
      "change 2 (clearRange): the spreadsheet has no sheet with ID 5.");

    let shrunk = replayChanges(grid([sheet(0, "Sales", { rowCount: 10 })]), [
      queued(1, [{ op: "writeCells", sheetId: 0, rect: rect(14, 0), values: [[1]] }]),
    ]);
    expect(shrunk).toMatchObject({
      kind: "incomplete", appliedCount: 0, reason: 'change 1 (writeCells): A15 is outside "Sales"',
    });
    // A collaborator deleted the sheet a queued change deletes.
    let deleted = replayChanges(grid([COSTS]), [queued(1, [{ op: "deleteSheet", sheetId: 0, rowCount: 20, columnCount: 6 }])]);
    expect(deleted).toMatchObject({
      kind: "incomplete", reason: "change 1 (deleteSheet): the spreadsheet has no sheet with ID 0",
    });
  });
});

describe("Sheets structure replayed", () => {
  it("moves sheets' indexes as Google inserts and removes them, hidden sheets included", () => {
    let base = grid([sheet(0, "A"), sheet(1, "H", { index: 1, hidden: true }), sheet(2, "B", { index: 2 })]);
    let added = replayed(base, [queued(1, [{ op: "addSheet", sheetId: 9, title: "New", index: 1, rowCount: 3, columnCount: 2 }])]);
    expect(summary(added)).toEqual([[0, "A", 0, false], [9, "New", 1, false], [1, "H", 2, true], [2, "B", 3, false]]);
    let gone = applyChange(added, queued(2, [{ op: "deleteSheet", sheetId: 1, rowCount: 20, columnCount: 6 }]).action);
    expect(summary(gone)).toEqual([[0, "A", 0, false], [9, "New", 1, false], [2, "B", 2, false]]);
    let copied = applyChange(gone, queued(3, [
      { op: "duplicateSheet", sheetId: 2, newSheetId: 5, title: "B copy", index: 0 },
    ]).action);
    expect(summary(copied)).toEqual([[5, "B copy", 0, false], [0, "A", 1, false], [9, "New", 2, false], [2, "B", 3, false]]);
    // A copy of a hidden sheet is shown.
    let hiddenCopy = applyChange(base, queued(4, [{ op: "duplicateSheet", sheetId: 1, newSheetId: 6, title: "H2", index: 3 }]).action);
    expect(summary(hiddenCopy).at(-1)).toEqual([6, "H2", 3, false]);
  });

  it("copies what is queued for a sheet to its copy, which then changes apart from it", () => {
    let g = replayed(grid([SALES, COSTS]), [
      queued(1, [{ op: "writeCells", sheetId: 1, rect: rect(0, 0), values: [["x"]] }]),
      queued(2, [{ op: "duplicateSheet", sheetId: 1, newSheetId: 8, title: "Costs copy", index: 2 }]),
      queued(3, [{ op: "writeCells", sheetId: 8, rect: rect(0, 1, 1, 2), values: [["y", "z"]] }]),
    ]);
    // The copy keeps the entry as queued for the original: who entered it, and when.
    expect(g.cells.get("1:b0:b0")).toEqual({ input: "x", at: 0, by: 1 });
    expect(g.cells.get("8:b0:b0")).toEqual({ input: "x", at: 0, by: 1 });
    expect(g.cells.get("8:b0:b1")).toEqual({ input: "y", at: 1, by: 3 });
    expect(g.cells.get("8:b0:b2")?.input).toBe("z");
    expect(g.cells.has("1:b0:b1")).toBe(false);
    expect(simulatedRange(g, { sheetId: 8, rect: rect(0, 0, 1, 3), rows: 1, columns: 3 }, BLANK, "formula").values)
      .toEqual([["x", "y", "z"]]);
    // The copy reads the cells Google holds for the sheet it copies.
    expect(g.sheets.find(({ id }) => id === 8)?.source).toBe(1);
  });

  it("drops what is queued for deleted rows, columns and sheets, and moves the rest", () => {
    let g = replayed(grid([SALES, COSTS]), [
      queued(1, [
        { op: "writeCells", sheetId: 0, rect: rect(1, 0, 2, 2), values: [["r2", "r2b"], ["r3", "r3b"]] },
        { op: "writeCells", sheetId: 1, rect: rect(0, 0), values: [["gone"]] },
      ]),
      queued(2, [{ op: "deleteRows", sheetId: 0, start: 1, count: 1 }, { op: "deleteColumns", sheetId: 0, start: 1, count: 1 }]),
      queued(3, [{ op: "deleteSheet", sheetId: 1, rowCount: 20, columnCount: 6 }]),
    ]);
    expect([...g.cells.keys()]).toEqual(["0:b2:b0"]);
    expect(simulatedRange(g, { sheetId: 0, rect: rect(0, 0, 3, 2), rows: 3, columns: 2 }, BLANK, "formula").values)
      .toEqual([[null, null], ["r3", null], [null, null]]);
    expect(g.sheets.map(({ id, rowCount, columnCount }) => [id, rowCount, columnCount])).toEqual([[0, 19, 5]]);
    expect(g.log.map(({ kind }) => kind)).toEqual(["delete", "delete", "deleteSheet"]);
  });

  it("names each inserted line from the step that inserted it, so every replay agrees", () => {
    let pending = [
      queued(1, [{ op: "insertRows", sheetId: 0, start: 0, count: 1 }]),
      queued(2, [{ op: "insertRows", sheetId: 0, start: 0, count: 1 }, { op: "writeCells", sheetId: 0, rect: rect(0, 0, 2), values: [[1], [2]] }]),
    ];
    let first = replayed(grid([SALES]), pending);
    expect([...first.cells.keys()]).toEqual(["0:n1.0:b0", "0:n0.0:b0"]);
    expect([...replayed(grid([SALES]), pending).cells]).toEqual([...first.cells]);
  });
});

describe("Sheets formulas through queued structure", () => {
  // Sales and Rw; insert a row on Rw before row 2, rename Rw to "Rw 2", copy Sales, then insert a
  // row on the copy before row 1.
  let g = replayed(grid([SALES, sheet(1, "Rw", { index: 1 })]), [
    queued(1, [{ op: "insertRows", sheetId: 1, start: 1, count: 1 }]),
    queued(2, [{ op: "renameSheet", sheetId: 1, title: "Rw 2" }]),
    queued(3, [{ op: "duplicateSheet", sheetId: 0, newSheetId: 5, title: "Sales copy", index: 2 }]),
    queued(4, [{ op: "insertRows", sheetId: 5, start: 0, count: 1 }]),
  ]);
  let formula = "=Sales!B1+Rw!A3+A1";

  it("rewrites a formula Google holds through every step, on the sheet it is on at each", () => {
    expect(formulaAt(g, 0, formula, 0)).toEqual({ text: "=Sales!B1+'Rw 2'!A4+A1", cellsChanged: false, broken: false });
    // The copy's formulas were the original's until the copy was made, then follow the copy.
    expect(formulaAt(g, 5, formula, 0))
      .toEqual({ text: "='Sales copy'!B2+'Rw 2'!A4+A2", cellsChanged: false, broken: false });
  });

  it("rewrites what a queued change entered only through the steps after it", () => {
    expect(formulaAt(g, 5, "=A1+'Rw 2'!A1", 3).text).toBe("=A2+'Rw 2'!A1");
    expect(formulaAt(g, 5, "=A1", 4).text).toBe("=A1");
  });

  it("rewrites a copy's formulas by the original's changes made before the copy", () => {
    // Insert a row on Sales before row 1, then copy Sales.
    let copied = replayed(grid([SALES]), [
      queued(1, [insertRows(0, 1)]),
      queued(2, [{ op: "duplicateSheet", sheetId: 0, newSheetId: 5, title: "Sales copy", index: 1 }]),
    ]);
    let held = "=A1+Sales!B1";
    expect(formulaAt(copied, 0, held, 0).text).toBe("=A2+Sales!B2");
    expect(formulaAt(copied, 5, held, 0).text).toBe("=A2+'Sales copy'!B2");
    // The same formula held by Google in A1 of Sales, read on the copy, where it is now in A2.
    let piece = { sheetId: 0, rect: rect(0, 0) };
    let base = { shown: baseValues([piece], [[[3]]]), formulas: baseValues([piece], [[[held]]]) };
    expect(simulatedRange(copied, { sheetId: 5, rect: rect(0, 0, 2, 1), rows: 2, columns: 1 }, base, "formula"))
      .toEqual({ range: "'Sales copy'!A1:A2", values: [[null], ["=A2+'Sales copy'!B2"]] });
  });

  it("reads a reference to a title a sheet takes later as broken, and never rewrites it", () => {
    let added = planSheet(grid([SALES]), [
      { op: "addSheet", sheetId: 3, title: "Q4", index: 1, rowCount: 5, columnCount: 5 },
      { op: "insertRows", sheetId: 3, start: 0, count: 1 },
    ]).grid;
    expect(formulaAt(added, 0, "=q4!A1", 0)).toEqual({ text: "=q4!A1", cellsChanged: false, broken: true });
    let renamed = planSheet(grid([SALES, COSTS]), [{ op: "renameSheet", sheetId: 1, title: "New" }]).grid;
    expect(formulaAt(renamed, 0, "=New!A1", 0)).toEqual({ text: "=New!A1", cellsChanged: false, broken: true });
    expect(formulaAt(renamed, 0, "=Costs!A1", 0)).toEqual({ text: "=New!A1", cellsChanged: false, broken: false });
  });

  it("leaves a reference to a deleted sheet as written when another sheet takes its title", () => {
    let replaced = planSheet(grid([SALES, COSTS]), [
      { op: "deleteSheet", sheetId: 1, rowCount: COSTS.rowCount, columnCount: COSTS.columnCount },
      { op: "addSheet", sheetId: 4, title: "Costs", index: 1, rowCount: 5, columnCount: 5 },
      { op: "renameSheet", sheetId: 4, title: "New" },
      { op: "insertRows", sheetId: 4, start: 0, count: 2 },
    ]).grid;
    expect(formulaAt(replaced, 0, "=Costs!A1 + 'costs'!B2", 0))
      .toMatchObject({ text: "=Costs!A1 + 'costs'!B2", broken: true });
  });
});

describe("Sheets reads with structure queued", () => {
  let SHEET = sheet(0, "Sales", { rowCount: 10, columnCount: 4 });
  let OTHER = sheet(1, "Other", { index: 1, rowCount: 10, columnCount: 4 });

  /** How D10 of Sales, holding `formula` whose saved value is 42, reads after `steps`. */
  function shown(formula: string, steps: PlannedChange[], mode: SpreadsheetValueMode = "raw") {
    let g = planSheet(gridOf({ sheets: [SHEET, OTHER] }), steps).grid;
    let piece = { sheetId: 0, rect: rect(9, 3) };
    let base = { shown: baseValues([piece], [[[42]]]), formulas: baseValues([piece], [[[formula]]]) };
    let sales = g.sheets.find(({ id }) => id === 0)!;
    let at = rect(positionOf(sales.rows, "b9")!, positionOf(sales.columns, "b3")!);
    return simulatedRange(g, { sheetId: 0, rect: at, rows: 1, columns: 1 }, base, mode);
  }

  it("shows a formula's saved result while every reference keeps its cells", () => {
    expect(shown("=Other!A1+A1", [insertRows(1, 5)])).toEqual({ range: "Sales!D10", values: [[42]] });
    expect(shown("=A5*2", [insertRows(0, 2)])).toEqual({ range: "Sales!D11", values: [[42]] });
    expect(shown("=A5*2", [insertRows(0, 2)], "formula")).toEqual({ range: "Sales!D11", values: [["=A6*2"]] });
    expect(shown("=SUM(Other!A1:A3)", [{ op: "renameSheet", sheetId: 1, title: "Else" }], "formatted").values).toEqual([[42]]);
  });

  it("reads null and pending once a reference covers other cells or none", () => {
    let pending = { range: "Sales!D11", values: [[null]], pendingCells: ["D11"] };
    expect(shown("=SUM(A1:A5)", [insertRows(0, 3)])).toEqual(pending);
    expect(shown("=SUM(A:A)", [insertRows(0, 2)], "formatted")).toEqual(pending);
    expect(shown("=SUM(A1:A5)", [deleteRows(0, 3)])).toEqual({ range: "Sales!D9", values: [[null]], pendingCells: ["D9"] });
    expect(shown("=A3", [deleteRows(0, 3)], "formula")).toEqual({ range: "Sales!D9", values: [["=#REF!"]] });
    expect(shown("=A3", [deleteRows(0, 3)]).pendingCells).toEqual(["D9"]);
    expect(shown("=Other!A1", [{ op: "deleteSheet", sheetId: 1, rowCount: 10, columnCount: 4 }]).pendingCells)
      .toEqual(["D10"]);
    expect(shown("=Q4!A1", [{ op: "addSheet", sheetId: 3, title: "Q4", index: 2, rowCount: 1, columnCount: 1 }]).pendingCells)
      .toEqual(["D10"]);
  });

  it("reads pending any formula that depends on where cells are, or names cells it does not show", () => {
    let elsewhere = [insertRows(1, 1)];
    for (let formula of ["=ROW()", "=OFFSET(A1, 1, 1)", '=INDIRECT("A1")', "=Totals * 2", "=LET(x, 1, x)"]) {
      expect(shown(formula, elsewhere).pendingCells, formula).toEqual(["D10"]);
    }
    expect(shown("=ROW()", elsewhere, "formula").values).toEqual([["=ROW()"]]);
    // With no structure queued, Google's result stands.
    expect(shown("=ROW()", []).values).toEqual([[42]]);
  });

  it("moves literal cells with their lines, and reads inserted lines and added sheets blank", () => {
    let g = planSheet(gridOf({ sheets: [SHEET] }), [
      insertRows(0, 2),
      { op: "insertColumns", sheetId: 0, start: 0, count: 1 },
      { op: "addSheet", sheetId: 3, title: "Q4", index: 1, rowCount: 2, columnCount: 2 },
    ]).grid;
    let pieces = basePiecesOf(g, [{ sheetId: 0, rect: rect(0, 0, 3, 2) }]);
    expect(pieces).toEqual([
      { sheetId: 0, rect: rect(0, 0, 1, 1) }, { sheetId: 0, rect: rect(1, 0, 1, 1) },
    ]);
    let base = { shown: baseValues(pieces, [[["a1"]], [["a2"]]]), formulas: baseValues(pieces, [[["a1"]], [["a2"]]]) };
    expect(simulatedRange(g, { sheetId: 0, rect: rect(0, 0, 3, 2), rows: 3, columns: 2 }, base, "formatted"))
      .toEqual({ range: "Sales!A1:B3", values: [[null, "a1"], [null, null], [null, "a2"]] });
    expect(simulatedRange(g, { sheetId: 3, rect: rect(0, 0, 2, 2), rows: 2, columns: 2 }, BLANK))
      .toEqual({ range: "'Q4'!A1:B2", values: [[null, null], [null, null]] });
  });

  it("assembles each mode from entries, moved cells and rewritten formulas", () => {
    let g = replayed(gridOf({ sheets: [SHEET] }), [
      queued(1, [{ op: "writeCells", sheetId: 0, rect: rect(0, 1, 1, 2), values: [["=A2", 7]] }]),
      queued(2, [insertRows(0, 2)]),
    ]);
    let piece = { sheetId: 0, rect: rect(0, 0, 2, 4) };
    let formulas = baseValues([piece], [[["=A2+1", "old", "old", true], ["x", 5]]]);
    let area = { sheetId: 0, rect: rect(0, 0, 3, 4), rows: 3, columns: 4 };
    let read = (values: SpreadsheetCellValue[][], mode: SpreadsheetValueMode) =>
      simulatedRange(g, area, { shown: baseValues([piece], [values]), formulas }, mode);
    expect(read([["=A2+1", "old", "old", true], ["x", 5]], "formula")).toEqual({
      range: "Sales!A1:D3", values: [["=A3+1", "=A3", 7, true], [null, null, null, null], ["x", 5, null, null]],
    });
    expect(read([[3, "old", "old", true], ["x", 5]], "raw")).toEqual({
      range: "Sales!A1:D3", values: [[3, null, 7, true], [null, null, null, null], ["x", 5, null, null]],
      pendingCells: ["B1"],
    });
    expect(read([["$3.00", "old", "old", "TRUE"], ["x", "$5.00"]], "formatted")).toEqual({
      range: "Sales!A1:D3",
      values: [["$3.00", null, null, "TRUE"], [null, null, null, null], ["x", "$5.00", null, null]],
      pendingCells: ["B1", "C1"],
    });
  });

  it("rewrites what a queued change entered only by the steps queued after it", () => {
    // A1 is entered after a row is inserted before row 1 in the same batch; a later batch inserts
    // another.
    let entered = [
      queued(1, [insertRows(0, 1), { op: "writeCells", sheetId: 0, rect: rect(0, 0), values: [["=B1"]] }]),
    ];
    let once = replayed(gridOf({ sheets: [SHEET] }), entered);
    expect(once.cells.get("0:n0.0:b0")).toEqual({ input: "=B1", at: 1, by: 1 });
    let area = { sheetId: 0, rect: rect(0, 0), rows: 1, columns: 1 };
    expect(simulatedRange(once, area, BLANK, "formula").values).toEqual([["=B1"]]);
    expect(enteredContent(once, [{ sheetId: 0, rect: rect(0, 0) }], BLANK.formulas)).toEqual([[["=B1"]]]);
    let twice = replayed(gridOf({ sheets: [SHEET] }), [...entered, queued(2, [insertRows(0, 1)])]);
    expect(simulatedRange(twice, { ...area, rect: rect(1, 0) }, BLANK, "formula"))
      .toEqual({ range: "Sales!A2", values: [["=B2"]] });
    expect(enteredContent(twice, [{ sheetId: 0, rect: rect(1, 0) }], BLANK.formulas)).toEqual([[["=B2"]]]);
  });

  it("gives the guard each cell as it is to be once queued changes apply", () => {
    let g = replayed(gridOf({ sheets: [SHEET] }), [
      queued(1, [{ op: "writeCells", sheetId: 0, rect: rect(0, 0), values: [["=B5"]] }]),
      queued(2, [insertRows(0, 2)]),
    ]);
    let cells: SheetArea[] = [{ sheetId: 0, rect: rect(0, 0, 3, 2) }];
    let pieces = basePiecesOf(g, cells);
    expect(pieces).toEqual([{ sheetId: 0, rect: rect(0, 0, 1, 2) }, { sheetId: 0, rect: rect(1, 0, 1, 2) }]);
    expect(enteredContent(g, cells, baseValues(pieces, [[["old", "=A1"]], [[1, ""]]])))
      .toEqual([[["=B6", "=A1"], [null, null], [1, ""]]]);
  });
});

describe("Sheets ranges read with structure queued", () => {
  let base = grid([sheet(0, "Sales"), sheet(1, "Costs", { index: 1, hidden: true }), sheet(2, "Rest", { index: 2 })]);

  it("finds a range's sheet by its simulated title, the first visible with none, and clips it", () => {
    let g = replayed(base, [queued(1, [
      { op: "renameSheet", sheetId: 0, title: "Old" },
      { op: "duplicateSheet", sheetId: 2, newSheetId: 9, title: "Front", index: 0 },
      { op: "deleteRows", sheetId: 2, start: 0, count: 10 },
    ])]);
    expect(resolveArea(g, { sheet: "old", rect: rect(0, 0, 2, 2) })).toEqual({ sheetId: 0, rect: rect(0, 0, 2, 2), rows: 2, columns: 2 });
    expect(resolveArea(g, { rect: rect(0, 0) }).sheetId).toBe(9);
    expect(resolveArea(g, { sheet: "Rest", rect: rect(8, 4, 5, 5) }))
      .toEqual({ sheetId: 2, rect: rect(8, 4, 2, 2), rows: 5, columns: 5 });
    expect(() => resolveArea(g, { sheet: "Sales", rect: rect(0, 0) }))
      .toThrow('The spreadsheet has no sheet named "Sales" with the queued changes applied.');
    expect(() => resolveArea(g, { sheet: "Rest", rect: rect(10, 0, 2, 2) }))
      .toThrow("Range (Rest!A11:B12) exceeds grid limits. Max rows: 10, max columns: 6");
  });

  it("fetches only the cells Google holds: none for new lines, split around deleted ones", () => {
    let g = replayed(base, [queued(1, [
      { op: "insertRows", sheetId: 0, start: 2, count: 2 },
      { op: "deleteRows", sheetId: 0, start: 6, count: 1 },
      { op: "renameSheet", sheetId: 0, title: "Renamed" },
      { op: "duplicateSheet", sheetId: 0, newSheetId: 9, title: "Copy", index: 3 },
      { op: "addSheet", sheetId: 4, title: "Q4", index: 4, rowCount: 5, columnCount: 5 },
    ])]);
    expect(rangesToFetch(g, [{ sheetId: 0, rect: rect(2, 0, 2, 2) }])).toEqual([]);
    expect(rangesToFetch(g, [{ sheetId: 0, rect: rect(0, 0, 8, 2) }])).toEqual([
      { sheetId: 0, rect: rect(0, 0, 2, 2) }, { sheetId: 0, rect: rect(2, 0, 2, 2) }, { sheetId: 0, rect: rect(5, 0, 2, 2) },
    ]);
    // A copy reads its original's cells, once however many ranges ask for them.
    expect(rangesToFetch(g, [{ sheetId: 9, rect: rect(0, 0) }, { sheetId: 0, rect: rect(0, 0) }]))
      .toEqual([{ sheetId: 0, rect: rect(0, 0) }]);
    expect(rangesToFetch(g, [{ sheetId: 4, rect: rect(0, 0, 5, 5) }])).toEqual([]);
  });

  it("refuses a read of more than 20 pieces or 50,000 cells", () => {
    let message = "These ranges cannot be read with the queued changes applied. Read fewer cells, or approve or " +
      "reject the queued changes first.";
    let split = replayed(gridOf({ sheets: [sheet(0, "Sales", { rowCount: 100 })] }), [queued(1,
      Array.from({ length: 20 }, (_, i): PlannedChange => ({ op: "insertRows", sheetId: 0, start: 1 + i * 2, count: 1 })))]);
    expect(rangesToFetch(split, [{ sheetId: 0, rect: rect(0, 0, 39, 1) }])).toHaveLength(20);
    expect(() => rangesToFetch(split, [{ sheetId: 0, rect: rect(0, 0, 41, 1) }])).toThrow(message);
    let tall = gridOf({ sheets: [sheet(0, "Tall", { rowCount: 60_000, columnCount: 1 })] });
    expect(() => rangesToFetch(tall, [{ sheetId: 0, rect: rect(0, 0, 50_001) }])).toThrow(message);
    expect(rangesToFetch(tall, [{ sheetId: 0, rect: rect(0, 0, 50_000) }])).toHaveLength(1);
  });

  it("builds the base grid from metadata, sheets sorted by index", () => {
    let sheets: SheetMeta[] = [sheet(4, "B", { index: 1 }), sheet(2, "A", { index: 0 })];
    let g = gridOf({ sheets });
    expect(g.sheets.map(({ id, source, rows, columns }) => [id, source, rows, columns])).toEqual([
      [2, 2, [{ kind: "base", start: 0, length: 20 }], [{ kind: "base", start: 0, length: 6 }]],
      [4, 4, [{ kind: "base", start: 0, length: 20 }], [{ kind: "base", start: 0, length: 6 }]],
    ]);
    expect(g.log).toEqual([]);
  });
});
