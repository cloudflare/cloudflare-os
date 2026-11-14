import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SheetArea } from "../src/sheets-api";
import type { BaseFormats } from "../src/sheets-format";
import { rewriteFormula, tokenize } from "../src/sheets-formula";
import type { EnteredValue, Rect } from "../src/sheets-model";
import { planSheet } from "../src/sheets-plan";
import type { SpreadsheetCellValue, SpreadsheetValueMode } from "../src/sheets-read-types";
import {
  applyChange, basePiecesOf, baseValues, conflictReason, enteredContent, formulaAt, gridOf,
  overlayRange, rangesToFetch, replayChanges, resolveArea, rewriteWork, simulatedFormats, simulatedRange,
  SimulatedTextTooLong, UnsimulatedFormula,
  type Grid, type PlannedChange, type QueuedChange, type SheetMeta, type SheetsAction,
} from "../src/sheets-simulation";
import { positionOf } from "../src/sheets-structure";
import type { SheetFormatChange } from "../src/sheets-types";
import { ChangeConflict } from "../src/slides-text";
import { ERROR_VALUE_READS, grid, rect, sheet } from "./sheets-fixture";

// Every export calls through to its own code; the spies only count calls from other modules.
vi.mock("../src/sheets-formula", { spy: true });

function queued(
  id: number, changes: PlannedChange[], kind: SheetsAction["kind"] = "updateSpreadsheet",
  sheets: Record<string, string> = {},
): QueuedChange {
  return {
    id,
    action: {
      kind,
      payload: {
        changes, sheets, marker: { id: id + 100, token: `token-${id}` },
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
const BLANK = { entered: baseValues<EnteredValue>([], []), shown: baseValues([], []) };

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

  it("stops at a change to a sheet renamed since it was queued, as its guard would refuse it", () => {
    let change = queued(
      1, [{ op: "writeCells", sheetId: 0, rect: rect(0, 0), values: [[1]] }], "updateSpreadsheet", { 0: "Sales" });
    expect(replayChanges(grid([sheet(0, "Revenue")]), [change])).toMatchObject({
      kind: "incomplete", appliedCount: 0, unsupported: change,
      reason: 'the sheet "Sales" it acts on has been renamed "Revenue"',
    });
    expect(replayChanges(grid([SALES]), [change])).toMatchObject({ kind: "complete", appliedCount: 1 });
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
    let base = { entered: baseValues<EnteredValue>([piece], [[[{ formula: held }]]]), shown: baseValues([piece], [[[held]]]) };
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

  it("follows a title only while a sheet holds it, whichever sheet that is", () => {
    // Costs is deleted, a sheet "costs" takes its title and is renamed "COSTS", with rows
    // inserted on it before and after.
    let retitled = planSheet(grid([SALES, COSTS]), [
      { op: "deleteSheet", sheetId: 1, rowCount: COSTS.rowCount, columnCount: COSTS.columnCount },
      { op: "addSheet", sheetId: 4, title: "costs", index: 1, rowCount: 5, columnCount: 5 },
      { op: "insertRows", sheetId: 4, start: 0, count: 1 },
      { op: "renameSheet", sheetId: 4, title: "COSTS" },
      { op: "insertRows", sheetId: 4, start: 0, count: 1 },
    ]).grid;
    expect(formulaAt(retitled, 0, "=Costs!A1", 0)).toEqual({ text: "=Costs!A1", cellsChanged: true, broken: true });
    expect(formulaAt(retitled, 0, "=Costs!A1", 2)).toEqual({ text: "=COSTS!A3", cellsChanged: false, broken: false });
    expect(formulaAt(retitled, 0, "=Costs!A1", 4)).toEqual({ text: "=Costs!A2", cellsChanged: false, broken: false });
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

describe("Sheets formulas through steps that cannot change them", () => {
  // Sales holds the formulas; 50 rows are inserted on Other, one at a time.
  let sheets = [
    sheet(0, "Sales", { rowCount: 2_000, columnCount: 25 }), sheet(1, "S1", { index: 1 }), sheet(2, "Other", { index: 2 }),
  ];
  let g = replayed(gridOf({ sheets }), [queued(1, Array.from({ length: 50 }, () => insertRows(2, 1)))]);
  let formula = "=SUM(A1:B2)+Sales!C3*'S1'!A1";

  it("stops building a read or guard once its text, longer for a renamed sheet, runs past its budget", () => {
    let renamed = replayed(gridOf({ sheets }), [queued(1, [{ op: "renameSheet", sheetId: 1, title: "T".repeat(100) }])]);
    let piece = { sheetId: 0, rect: rect(0, 0, 1, 2) };
    let entered = baseValues<EnteredValue>([piece], [[[{ formula: "=S1!A1" }, "text"]]]);
    let base = { entered, shown: baseValues([piece], [[[7, "text"]]]) };
    let area = { ...piece, rows: 1, columns: 2 };
    // The formula grows from 6 characters to 104.
    expect(simulatedRange(renamed, area, base, "formula", { left: 108 }).values).toEqual([[`=${"T".repeat(100)}!A1`, "text"]]);
    expect(() => simulatedRange(renamed, area, base, "formula", { left: 107 })).toThrow(SimulatedTextTooLong);
    // One budget serves every range of a read.
    let budget = { left: 150 };
    simulatedRange(renamed, area, base, "formula", budget);
    expect(budget.left).toBe(42);
    expect(() => simulatedRange(renamed, area, base, "formula", budget)).toThrow(SimulatedTextTooLong);
    expect(() => enteredContent(renamed, [piece], entered, { left: 107 })).toThrow(SimulatedTextTooLong);
    expect(enteredContent(renamed, [piece], entered, { left: 108 }))
      .toEqual([[[{ formula: `=${"T".repeat(100)}!A1` }, "text"]]]);
  });

  it("counts each formula's text an area shows once per step of the log, and again for each area showing it", () => {
    let piece = { sheetId: 0, rect: rect(0, 0, 2, 3) };
    let entered = baseValues<EnteredValue>([piece], [
      [[{ formula: "=A1" }, "=text", 3], [null, { formula: "=B2+B3" }, { error: "REF" }]],
    ]);
    let sales = { sheetId: 0, rect: rect(0, 0, 3, 3) };
    expect(rewriteWork(gridOf({ sheets }), [sales], entered)).toBe(0);
    let moved = replayed(gridOf({ sheets }), [
      queued(1, [insertRows(0, 1), insertRows(2, 1)]),
      queued(2, [{ op: "writeCells", sheetId: 0, rect: rect(0, 0, 1, 2), values: [["=C1", "x"]] }]),
      queued(3, [{ op: "writeCells", sheetId: 2, rect: rect(0, 0), values: [["=D1"]] }]),
    ]);
    // The formula queued in the inserted row 1 (3 characters), and Google's two, moved down to A2
    // (3) and B3 (6), through two steps.
    expect(rewriteWork(moved, [sales], entered)).toBe(24);
    expect(rewriteWork(moved, [sales, sales], entered)).toBe(48);
    expect(rewriteWork(moved, [sales, { sheetId: 2, rect: rect(0, 0) }], entered)).toBe(30);
  });

  beforeEach(() => {
    vi.mocked(tokenize).mockClear();
    vi.mocked(rewriteFormula).mockClear();
  });

  it("reads a formula only once to pass every step on a sheet it neither is on nor names", () => {
    expect(formulaAt(g, 0, formula, 0)).toEqual({ text: formula, cellsChanged: false, broken: false });
    expect(tokenize).toHaveBeenCalledTimes(1);
    expect(rewriteFormula).not.toHaveBeenCalled();
    // Unqualified references follow none of those steps, so nothing is read at all.
    expect(formulaAt(g, 0, "=SUM(A1:B2)", 0).text).toBe("=SUM(A1:B2)");
    expect(tokenize).toHaveBeenCalledTimes(1);
  });

  it("keeps text that holds the characters it sets references aside with", () => {
    let literal = '=IF(TRUE,"\uE000\uE100\uE001",A1)';
    expect(formulaAt(g, 0, literal, 0).text).toBe(literal);
    expect(formulaAt(g, 2, literal, 0).text).toBe('=IF(TRUE,"\uE000\uE100\uE001",A51)');
    // A reference to a sheet the formula names before it exists is set aside, and the text kept.
    let early = replayed(gridOf({ sheets }), [queued(1, [
      { op: "addSheet", sheetId: 9, title: "Q4", index: 3, rowCount: 1, columnCount: 1 },
      insertRows(2, 1),
    ])]);
    expect(formulaAt(early, 2, "=Q4!A1+A1", 0)).toEqual({ text: "=Q4!A1+A2", cellsChanged: false, broken: true });
  });

  it("refuses a formula naming a missing sheet when the reference cannot be set aside", () => {
    // Q is deleted, a new Q added and renamed: the formula's Q is the first one throughout.
    let reused = replayed(gridOf({ sheets: [...sheets, sheet(5, "Q", { index: 3 })] }), [queued(1, [
      { op: "deleteSheet", sheetId: 5, rowCount: 1000, columnCount: 26 },
      { op: "addSheet", sheetId: 6, title: "Q", index: 3, rowCount: 1, columnCount: 1 },
      { op: "renameSheet", sheetId: 6, title: "Renamed" },
    ])]);
    expect(formulaAt(reused, 0, "=Q!A1+Q!A2", 0)).toMatchObject({ text: "=Q!A1+Q!A2", broken: true });
    // Text holding the characters it sets references aside with.
    expect(() => formulaAt(reused, 0, '=IF(TRUE,"\uE000",Q!A1)', 0)).toThrow(UnsimulatedFormula);
    // Those characters in a title a queued change gives a sheet the formula names.
    let retitled = replayed(gridOf({ sheets: [...sheets, sheet(5, "Q", { index: 3 })] }), [queued(1, [
      { op: "deleteSheet", sheetId: 5, rowCount: 1000, columnCount: 26 },
      { op: "renameSheet", sheetId: 0, title: "\uE000\uE100\uE001" },
    ])]);
    expect(() => formulaAt(retitled, 1, "=Q!A1+Sales!A1", 0)).toThrow(UnsimulatedFormula);
    expect(formulaAt(retitled, 1, "=Sales!A1", 0).text).toBe("='\uE000\uE100\uE001'!A1");
    // More references than those characters can number.
    let many = "=" + Array.from({ length: 6_145 }, () => "Q!A1").join("+");
    expect(() => formulaAt(reused, 0, many, 0)).toThrow(UnsimulatedFormula);
    expect(formulaAt(reused, 0, "=" + Array.from({ length: 6_144 }, () => "Q!A1").join("+"), 0).broken).toBe(true);
  });

  it("rewrites through every step on the sheet a formula is on, or one it names", () => {
    expect(formulaAt(g, 2, "=A1", 0).text).toBe("=A51");
    expect(rewriteFormula).toHaveBeenCalledTimes(50);
    expect(formulaAt(g, 0, "=other!A2+A2", 0).text).toBe("=other!A52+A2");
    expect(rewriteFormula).toHaveBeenCalledTimes(100);
  });

  it("reads 50,000 formulas through the steps without rewriting one", () => {
    let piece = { sheetId: 0, rect: rect(0, 0, 2_000, 25) };
    let formulas = Array.from({ length: 2_000 }, (_row, r) => Array.from({ length: 25 }, () =>
      ({ formula: `=SUM(A${r + 1}:B${r + 2})+Sales!C3*'S1'!A1` })));
    let saved = formulas.map(line => line.map(() => 7));
    let base = { entered: baseValues<EnteredValue>([piece], [formulas]), shown: baseValues([piece], [saved]) };
    let read = simulatedRange(g, { ...piece, rows: 2_000, columns: 25 }, base, "raw");
    expect(read).toEqual({ range: "Sales!A1:Y2000", values: saved });
    expect(rewriteFormula).not.toHaveBeenCalled();
    // At most one read of each formula for the sheets it names; `structureSensitive` reads it in
    // its own module.
    expect(vi.mocked(tokenize).mock.calls.length).toBeLessThanOrEqual(50_000);
  });

  it("reads 50,000 formulas through 2,500 steps on other sheets without visiting one", () => {
    // Sheets T1 to T1250 are added, each followed by a row inserted on Other.
    let steps = Array.from({ length: 1_250 }, (_step, i): PlannedChange[] => [
      { op: "addSheet", sheetId: 100 + i, title: `T${i + 1}`, index: 3 + i, rowCount: 1, columnCount: 1 },
      insertRows(2, 1),
    ]).flat();
    let long = replayed(gridOf({ sheets }), [queued(1, steps)]);
    expect(long.log).toHaveLength(2_500);
    let piece = { sheetId: 0, rect: rect(0, 0, 2_000, 25) };
    let formulas = Array.from({ length: 2_000 }, (_row, r) => Array.from({ length: 25 }, () =>
      ({ formula: `=SUM(A${r + 1}:B${r + 2})+Sales!C3*'S1'!A1` })));
    let saved = formulas.map(line => line.map(() => 7));
    let base = { entered: baseValues<EnteredValue>([piece], [formulas]), shown: baseValues([piece], [saved]) };
    let read = simulatedRange(long, { ...piece, rows: 2_000, columns: 25 }, base, "raw");
    expect(read).toEqual({ range: "Sales!A1:Y2000", values: saved });
    expect(rewriteFormula).not.toHaveBeenCalled();
    expect(vi.mocked(tokenize).mock.calls.length).toBeLessThanOrEqual(50_000);
    // A formula entered after the last sheet is added visits only the row inserted after it.
    expect(formulaAt(long, 0, "=T1250!A1+Other!A1", 2_499))
      .toEqual({ text: "=T1250!A1+Other!A2", cellsChanged: false, broken: false });
    expect(rewriteFormula).toHaveBeenCalledTimes(1);
    // One naming a sheet before it is added is set aside at the first step, and visits no other.
    vi.mocked(tokenize).mockClear();
    expect(formulaAt(long, 0, "=T1!A1+T1250!A1", 0)).toEqual({ text: "=T1!A1+T1250!A1", cellsChanged: false, broken: true });
    expect(vi.mocked(tokenize).mock.calls.length).toBeLessThanOrEqual(3);
  });
});

describe("Sheets reads with structure queued", () => {
  let SHEET = sheet(0, "Sales", { rowCount: 10, columnCount: 4 });
  let OTHER = sheet(1, "Other", { index: 1, rowCount: 10, columnCount: 4 });

  /** How D10 of Sales, holding `formula` whose saved value is 42, reads after `steps`. */
  function shown(formula: string, steps: PlannedChange[], mode: SpreadsheetValueMode = "raw") {
    let g = planSheet(gridOf({ sheets: [SHEET, OTHER] }), steps).grid;
    let piece = { sheetId: 0, rect: rect(9, 3) };
    let base = { entered: baseValues<EnteredValue>([piece], [[[{ formula }]]]), shown: baseValues([piece], [[[42]]]) };
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
    let base = { entered: baseValues(pieces, [[["a1"]], [["a2"]]]), shown: baseValues(pieces, [[["a1"]], [["a2"]]]) };
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
    let entered = baseValues<EnteredValue>([piece], [[[{ formula: "=A2+1" }, "old", "old", true], ["x", 5]]]);
    let area = { sheetId: 0, rect: rect(0, 0, 3, 4), rows: 3, columns: 4 };
    let read = (mode: SpreadsheetValueMode, values: SpreadsheetCellValue[][]) =>
      simulatedRange(g, area, { entered, shown: baseValues([piece], [values]) }, mode);
    // A formula-mode read shows what cells hold as entered.
    expect(read("formula", [["=A2+1", "old", "old", true], ["x", 5]])).toEqual({
      range: "Sales!A1:D3", values: [["=A3+1", "=A3", 7, true], [null, null, null, null], ["x", 5, null, null]],
    });
    expect(read("raw", [[3, "old", "old", true], ["x", 5]])).toEqual({
      range: "Sales!A1:D3", values: [[3, null, 7, true], [null, null, null, null], ["x", 5, null, null]],
      pendingCells: ["B1"],
    });
    expect(read("formatted", [["$3.00", "old", "old", "TRUE"], ["x", "$5.00"]])).toEqual({
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
    expect(enteredContent(once, [{ sheetId: 0, rect: rect(0, 0) }], BLANK.entered)).toEqual([[[{ formula: "=B1" }]]]);
    let twice = replayed(gridOf({ sheets: [SHEET] }), [...entered, queued(2, [insertRows(0, 1)])]);
    expect(simulatedRange(twice, { ...area, rect: rect(1, 0) }, BLANK, "formula"))
      .toEqual({ range: "Sales!A2", values: [["=B2"]] });
    expect(enteredContent(twice, [{ sheetId: 0, rect: rect(1, 0) }], BLANK.entered)).toEqual([[[{ formula: "=B2" }]]]);
  });

  it("moves text starting with = as text, rewriting and pending only formulas", () => {
    // A1 and C1 hold text, B1 and D1 the same characters as formulas; a row goes in above them.
    let g = planSheet(gridOf({ sheets: [SHEET] }), [insertRows(0, 1)]).grid;
    let piece = { sheetId: 0, rect: rect(0, 0, 1, 4) };
    let entered = baseValues<EnteredValue>([piece], [[["=A1", { formula: "=A1" }, "=ROW()", { formula: "=ROW()" }]]]);
    let area = { sheetId: 0, rect: rect(0, 0, 2, 4), rows: 2, columns: 4 };
    let blank = [null, null, null, null];

    let formulas = baseValues([piece], [[["=A1", "=A1", "=ROW()", "=ROW()"]]]);
    expect(simulatedRange(g, area, { entered, shown: formulas }, "formula"))
      .toEqual({ range: "Sales!A1:D2", values: [blank, ["=A1", "=A2", "=ROW()", "=ROW()"]] });
    let raw = baseValues([piece], [[["=A1", 7, "=ROW()", 1]]]);
    expect(simulatedRange(g, area, { entered, shown: raw }, "raw"))
      .toEqual({ range: "Sales!A1:D2", values: [blank, ["=A1", 7, "=ROW()", null]], pendingCells: ["D2"] });
    // The guard sees the same.
    expect(enteredContent(g, [{ sheetId: 0, rect: rect(1, 0, 1, 4) }], entered))
      .toEqual([[["=A1", { formula: "=A2" }, "=ROW()", { formula: "=ROW()" }]]]);
  });

  it("reads an error value typed into a cell as a formula-mode read shows it, and one not known pending", () => {
    let g = planSheet(gridOf({ sheets: [SHEET, OTHER] }), [insertRows(1, 1)]).grid;
    let types = [...ERROR_VALUE_READS.map(([type]) => type), "SOMETHING_NEW"];
    let piece = { sheetId: 0, rect: rect(0, 0, types.length, 1) };
    let entered = baseValues<EnteredValue>([piece], [types.map(type => [{ error: type }])]);
    let area = { sheetId: 0, rect: piece.rect, rows: types.length, columns: 1 };

    let formulas = baseValues([piece], [[...ERROR_VALUE_READS.map(([, read]) => [read]), ["#SOMETHING_NEW ()"]]]);
    expect(simulatedRange(g, area, { entered, shown: formulas }, "formula")).toEqual({
      range: `Sales!A1:A${types.length}`,
      values: [...ERROR_VALUE_READS.map(([, read]) => [read]), [null]],
      pendingCells: [`A${types.length}`],
    });
    // Other modes show what Google read.
    let formatted = baseValues([piece], [types.map(() => ["#N/A"])]);
    expect(simulatedRange(g, area, { entered, shown: formatted }, "formatted").values).toEqual(types.map(() => ["#N/A"]));
  });

  it("reads pending a cell Google fills with nothing entered in it, in every mode, once structure is queued", () => {
    // A1 holds an array formula whose result spills into A2:A3; B1 is blank, C1 holds text.
    let piece = { sheetId: 0, rect: rect(0, 0, 3, 3) };
    let entered = baseValues<EnteredValue>([piece], [[[{ formula: "=SEQUENCE(3)" }, null, "x"]]]);
    let reads: Record<SpreadsheetValueMode, SpreadsheetCellValue[][]> = {
      formula: [["=SEQUENCE(3)", "", "x"], [2], [3]],
      raw: [[1, "", "x"], [2], [3]],
      formatted: [["1", "", "x"], ["2"], ["3"]],
    };
    let read = (g: Grid, mode: SpreadsheetValueMode) => simulatedRange(
      g, { ...piece, rows: 3, columns: 3 }, { entered, shown: baseValues([piece], [reads[mode]]) }, mode);
    // A row inserted on another sheet moves none of these cells.
    let g = planSheet(gridOf({ sheets: [SHEET, OTHER] }), [insertRows(1, 1)]).grid;
    let pendingCells = ["A2", "A3"];

    expect(read(g, "formula")).toEqual({
      range: "Sales!A1:C3", values: [["=SEQUENCE(3)", null, "x"], [null, null, null], [null, null, null]],
      pendingCells,
    });
    expect(read(g, "raw")).toEqual({
      range: "Sales!A1:C3", values: [[1, "", "x"], [null, null, null], [null, null, null]],
      pendingCells,
    });
    expect(read(g, "formatted")).toEqual({
      range: "Sales!A1:C3", values: [["1", "", "x"], [null, null, null], [null, null, null]],
      pendingCells,
    });
    // With no structure queued, Google's values stand.
    expect(read(gridOf({ sheets: [SHEET, OTHER] }), "raw"))
      .toEqual({ range: "Sales!A1:C3", values: [[1, "", "x"], [2, null, null], [3, null, null]] });
  });

  it("gives the guard each cell as it is to be once queued changes apply", () => {
    let g = replayed(gridOf({ sheets: [SHEET] }), [
      queued(1, [{ op: "writeCells", sheetId: 0, rect: rect(0, 0), values: [["=B5"]] }]),
      queued(2, [insertRows(0, 2)]),
    ]);
    let cells: SheetArea[] = [{ sheetId: 0, rect: rect(0, 0, 3, 2) }];
    let pieces = basePiecesOf(g, cells);
    expect(pieces).toEqual([{ sheetId: 0, rect: rect(0, 0, 1, 2) }, { sheetId: 0, rect: rect(1, 0, 1, 2) }]);
    expect(enteredContent(g, cells, baseValues(pieces, [[["old", { formula: "=A1" }]], [["=A1", null]]])))
      .toEqual([[[{ formula: "=B6" }, { formula: "=A1" }], [null, null], ["=A1", null]]]);
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

/** A `formatCells` change, as queued. */
const format = (sheetId: number, at: Rect, value: SheetFormatChange): PlannedChange =>
  ({ op: "formatCells", sheetId, rect: at, format: value });

/** No cell Google holds has formatting. */
const UNFORMATTED: BaseFormats = () => null;

/** Only A1 of sheet 0 has formatting. */
const FORMATTED_A1: BaseFormats = (sheetId, row, column) =>
  sheetId === 0 && row === 0 && column === 0 ? { bold: true, fontSize: 10, wrap: "CLIP" } : null;

/** Every cell has a top and a left border. */
const BORDERED: BaseFormats = () => ({ borders: { top: { style: "SOLID" }, left: { style: "DASHED" } } });

/** The formatting `rect` of sheet `sheetId` of `g` reads with, over `base`. */
const formatsOf = (g: Grid, sheetId: number, at: Rect, base = UNFORMATTED) => simulatedFormats(
  g, { sheetId, rect: at, rows: at.endRow - at.startRow, columns: at.endColumn - at.startColumn }, base);

describe("Sheets queued formatting", () => {
  it("merges queued formatting over each cell's own, a later change over an earlier", () => {
    let g = replayed(grid([SALES]), [
      queued(1, [format(0, rect(0, 0, 1, 2), { fontSize: 12, italic: true })]),
      queued(2, [format(0, rect(0, 0), { italic: null, wrap: null, textColor: "#ff0000" })]),
    ]);
    expect(formatsOf(g, 0, rect(0, 0, 1, 3), FORMATTED_A1)).toEqual({
      range: "Sales!A1:C1",
      formats: [[{ bold: true, fontSize: 12, textColor: "#ff0000" }, { fontSize: 12, italic: true }, null]],
    });
  });

  it("draws a range's outer borders on its edge cells, and inner ones on both cells they divide", () => {
    let thick = { style: "SOLID_THICK", color: "#ff0000" } as const;
    let g = applyChange(grid([SALES]), queued(1, [format(0, rect(1, 1, 2, 2), {
      borders: {
        top: { style: "SOLID" }, bottom: { style: "DASHED" }, left: { style: "DOTTED" }, right: { style: "DOUBLE" },
        innerHorizontal: { style: "SOLID_MEDIUM" }, innerVertical: thick,
      },
    })]).action);
    let medium = { style: "SOLID_MEDIUM" };
    expect(formatsOf(g, 0, rect(1, 1, 2, 2)).formats).toEqual([
      [
        { borders: { top: { style: "SOLID" }, bottom: medium, left: { style: "DOTTED" }, right: thick } },
        { borders: { top: { style: "SOLID" }, bottom: medium, left: thick, right: { style: "DOUBLE" } } },
      ],
      [
        { borders: { top: medium, bottom: { style: "DASHED" }, left: { style: "DOTTED" }, right: thick } },
        { borders: { top: medium, bottom: { style: "DASHED" }, left: thick, right: { style: "DOUBLE" } } },
      ],
    ]);
    // As a scratch spreadsheet read A5:B6 after inner borders alone: each shared edge on both sides.
    let inner = applyChange(grid([SALES]), queued(1, [format(0, rect(4, 0, 2, 2), {
      borders: { innerHorizontal: { style: "SOLID" }, innerVertical: { style: "DOTTED" } },
    })]).action);
    let solid = { style: "SOLID" };
    let dotted = { style: "DOTTED" };
    expect(formatsOf(inner, 0, rect(4, 0, 2, 2))).toEqual({
      range: "Sales!A5:B6",
      formats: [
        [{ borders: { bottom: solid, right: dotted } }, { borders: { bottom: solid, left: dotted } }],
        [{ borders: { top: solid, right: dotted } }, { borders: { top: solid, left: dotted } }],
      ],
    });
  });

  it("removes a border given as null, and reads a cell left with no formatting as null", () => {
    let g = applyChange(grid([SALES]), queued(1, [format(0, rect(0, 0, 1, 2), { borders: { top: null, left: null } })]).action);
    expect(formatsOf(g, 0, rect(0, 0, 1, 2), BORDERED).formats)
      .toEqual([[null, { borders: { left: { style: "DASHED" } } }]]);
  });

  it("removes the facing border of a cell beside an outer edge a queued change draws or removes", () => {
    // As a scratch spreadsheet showed: an edge has one owner, so B2's top border took B1's bottom.
    let solid = { style: "SOLID" } as const;
    let framed: BaseFormats = () => ({ borders: { top: solid, bottom: solid, left: solid, right: solid } });
    let g = applyChange(grid([SALES]), queued(1, [
      format(0, rect(1, 1, 2, 2), { bold: true, borders: { top: { style: "DOTTED" }, left: null } }),
    ]).action);
    let all = { borders: { top: solid, bottom: solid, left: solid, right: solid } };
    expect(formatsOf(g, 0, rect(0, 0, 4, 4), framed)).toEqual({
      range: "Sales!A1:D4",
      formats: [
        [all, { borders: { top: solid, left: solid, right: solid } }, { borders: { top: solid, left: solid, right: solid } }, all],
        [{ borders: { top: solid, bottom: solid, left: solid } },
          { bold: true, borders: { top: { style: "DOTTED" }, bottom: solid, right: solid } },
          { bold: true, borders: { top: { style: "DOTTED" }, bottom: solid, left: solid, right: solid } }, all],
        [{ borders: { top: solid, bottom: solid, left: solid } },
          { bold: true, borders: { top: solid, bottom: solid, right: solid } }, { bold: true, ...all }, all],
        [all, all, all, all],
      ],
    });
    // Neither inner borders, nor an edge along the sheet's own, have a neighbour outside.
    let edge = applyChange(grid([SALES]), queued(1, [format(0, rect(0, 0, 2, 2), {
      borders: { top: { style: "SOLID" }, left: { style: "SOLID" }, innerHorizontal: { style: "DOTTED" } },
    })]).action);
    expect(formatsOf(edge, 0, rect(0, 0, 3, 3), framed).formats[2]).toEqual([all, all, all]);
  });

  it("lets a later change's border on a shared edge replace an earlier one's", () => {
    let g = replayed(grid([SALES]), [
      queued(1, [format(0, rect(1, 0), { borders: { top: { style: "SOLID" } } })]),
      queued(2, [format(0, rect(0, 0), { borders: { bottom: { style: "DASHED" } } })]),
    ]);
    expect(formatsOf(g, 0, rect(0, 0, 2, 1))).toEqual({
      range: "Sales!A1:A2",
      formats: [[{ borders: { bottom: { style: "DASHED" } } }], [null]],
    });
  });

  it("moves queued formatting with its lines, copies it with its sheet, and drops it with them", () => {
    let bold = format(0, rect(1, 0), { bold: true });
    let g = replayed(grid([SALES, COSTS]), [
      queued(1, [bold, format(1, rect(0, 0), { italic: true })]),
      queued(2, [insertRows(0, 1)]),
      queued(3, [{ op: "duplicateSheet", sheetId: 0, newSheetId: 8, title: "Sales copy", index: 2 }]),
    ]);
    expect(formatsOf(g, 0, rect(0, 0, 3, 1)))
      .toEqual({ range: "Sales!A1:A3", formats: [[null], [null], [{ bold: true }]], pendingCells: ["A1"] });
    expect(formatsOf(g, 8, rect(2, 0)).formats).toEqual([[{ bold: true }]]);
    let pruned = replayed(g, [
      queued(4, [deleteRows(0, 3), { op: "deleteSheet", sheetId: 1, rowCount: 20, columnCount: 6 }]),
    ]);
    expect(formatsOf(pruned, 0, rect(0, 0, 3, 1)).formats).toEqual([[null], [null], [null]]);
    expect(formatsOf(pruned, 8, rect(2, 0)).formats).toEqual([[{ bold: true }]]);
    expect([...pruned.formats.keys()]).toEqual(["8:b1:b0"]);
  });

  it("reads inserted lines pending even when formatted, and an added sheet's cells as formatted", () => {
    let g = planSheet(grid([SALES]), [
      insertRows(0, 2),
      { op: "insertColumns", sheetId: 0, start: 0, count: 1 },
      format(0, rect(0, 0, 3, 2), { bold: true }),
      { op: "addSheet", sheetId: 3, title: "Q4", index: 1, rowCount: 2, columnCount: 2 },
      format(3, rect(0, 0), { italic: true }),
    ]).grid;
    expect(formatsOf(g, 0, rect(0, 0, 3, 2))).toEqual({
      range: "Sales!A1:B3",
      formats: [[null, { bold: true }], [null, null], [null, { bold: true }]],
      pendingCells: ["A1", "A2", "B2", "A3"],
    });
    expect(formatsOf(g, 3, rect(0, 0, 1, 2)))
      .toEqual({ range: "'Q4'!A1:B1", formats: [[{ italic: true }, null]] });
  });

  it("refuses formatting outside a sheet's grid when it replays", () => {
    expect(() => planSheet(grid([SALES]), [format(0, rect(19, 5, 2, 1), { bold: true })]))
      .toThrow(new ChangeConflict('change 1 (formatCells): F21 is outside "Sales"'));
    expect(() => planSheet(grid([SALES]), [format(4, rect(0, 0), { bold: true })]))
      .toThrow(new ChangeConflict("change 1 (formatCells): the spreadsheet has no sheet with ID 4"));
  });
});

describe("Sheets formatted values with a number format queued", () => {
  // B2:D2 take a currency format; E2 has its number format reset; F2 is left as it is.
  let g = applyChange(grid([SALES], { "0:1:1": 5, "0:1:2": "text" }), queued(1, [
    { op: "formatCells", sheetId: 0, rect: rect(1, 1, 1, 3), format: { numberFormat: { type: "CURRENCY" } } },
    { op: "formatCells", sheetId: 0, rect: rect(1, 4), format: { numberFormat: null, bold: true } },
  ]).action);
  let read = { range: "Sales!B2:F2", values: [["$5.00", "text", "", 0.25, 7]] };

  it("reads a formatted value pending once a queued change sets or resets its number format", () => {
    expect(overlayRange(read, 0, rect(1, 1, 1, 5), g)).toEqual({
      range: "Sales!B2:F2", values: [[null, null, null, null, 7]], pendingCells: ["B2", "C2", "D2", "E2"],
    });
  });

  it("knows a cell reads blank in any format only when a queued change empties it", () => {
    // A format such as ";;;" can hide what a cell Google reads as "" holds.
    let emptied = applyChange(g, queued(2, [{ op: "clearRange", sheetId: 0, rect: rect(1, 3) }]).action);
    expect(overlayRange(read, 0, rect(1, 1, 1, 5), emptied)).toEqual({
      range: "Sales!B2:F2", values: [[null, null, null, null, 7]], pendingCells: ["B2", "C2", "E2"],
    });
  });

  it("leaves raw and formula reads as they are", () => {
    let raw = { range: "Sales!B2:F2", values: [[5, "text", null, 0.25, 7]] };
    expect(overlayRange(raw, 0, rect(1, 1, 1, 5), g, "raw")).toEqual(raw);
    expect(overlayRange(raw, 0, rect(1, 1, 1, 5), g, "formula")).toEqual(raw);
  });

  it("does the same where queued structure moves the cells", () => {
    let moved = applyChange(g, queued(2, [insertRows(0, 1)]).action);
    let piece = { sheetId: 0, rect: rect(1, 1, 1, 5) };
    let base = (values: SpreadsheetCellValue[][]) =>
      ({ shown: baseValues([piece], [values]), entered: baseValues([piece], [[[5, "text", null, 0.25, 7]]]) });
    let area = { sheetId: 0, rect: rect(2, 1, 1, 5), rows: 1, columns: 5 };
    expect(simulatedRange(moved, area, base([["$5.00", "text", null, "25%", 7]]))).toEqual({
      range: "Sales!B3:F3", values: [[null, null, null, null, 7]], pendingCells: ["B3", "C3", "D3", "E3"],
    });
    expect(simulatedRange(moved, area, base([[5, "text", null, 0.25, 7]]), "raw").values)
      .toEqual([[5, "text", null, 0.25, 7]]);
  });

  it("reads pending a value queued on an inserted line, which takes the number format before it", () => {
    let hidden = { numberFormat: { type: "NUMBER" as const, pattern: ";;;" } };
    let sheets = [sheet(0, "Sales", { rowCount: 10, columnCount: 4 })];
    let g = replayed(gridOf({ sheets }), [queued(1, [
      { op: "formatCells", sheetId: 0, rect: rect(0, 0), format: hidden },
      insertRows(0, 2),
      { op: "insertColumns", sheetId: 0, start: 1, count: 1 },
      { op: "writeCells", sheetId: 0, rect: rect(1, 0, 1, 2), values: [["visible", "x"]] },
      { op: "writeCells", sheetId: 0, rect: rect(0, 1), values: [["y"]] },
      { op: "writeCells", sheetId: 0, rect: rect(1, 1), values: [[null]] },
      { op: "addSheet", sheetId: 3, title: "Q4", index: 1, rowCount: 2, columnCount: 2 },
      { op: "writeCells", sheetId: 3, rect: rect(0, 0), values: [["shown"]] },
    ])]);
    let area = { sheetId: 0, rect: rect(0, 0, 2, 2), rows: 2, columns: 2 };
    // A2 is on the inserted row, B1 on the inserted column; B2, on both, is emptied.
    expect(simulatedRange(g, area, BLANK)).toEqual({
      range: "Sales!A1:B2", values: [[null, null], [null, null]], pendingCells: ["A1", "B1", "A2"],
    });
    expect(simulatedRange(g, area, BLANK, "raw").values).toEqual([[null, "y"], ["visible", null]]);
    // A sheet a queued change adds starts with no formatting to take.
    expect(simulatedRange(g, { sheetId: 3, rect: rect(0, 0), rows: 1, columns: 1 }, BLANK).values)
      .toEqual([["shown"]]);
  });
});
