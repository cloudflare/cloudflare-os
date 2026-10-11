import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SheetArea, SheetProtection } from "../src/sheets-api";
import { compactFormula } from "../src/sheets-formula";
import { prepareChanges } from "../src/sheets-input";
import {
  checkProtections, guardAfter, guardCells, guardDigest, guardedSheets, guardFits, guardOf, MAX_GUARDED_CELLS,
  MAX_QUEUED_STEPS, planSheet, resolveChanges, sheetLabels,
} from "../src/sheets-plan";
import { linesAt } from "../src/sheets-structure";
import { enteredOf, type EnteredValue, type Rect } from "../src/sheets-model";
import {
  basePiecesOf, baseValues, enteredContent, holdsFormula, replayChanges, type Grid, type PlannedChange,
  type QueuedChange, type SheetBatch, type SheetMeta,
} from "../src/sheets-simulation";
import type { SheetChange } from "../src/sheets-types";
import { ChangeConflict } from "../src/slides-text";
import { NEW_SHEET_SIZE, TYPED_INPUT, WHITESPACE_DRIFT, grid, rect, sheet } from "./sheets-fixture";

// Every export calls through to its own code; the spies only count how many lines are listed.
vi.mock("../src/sheets-structure", { spy: true });

const SHEETS = [sheet(0, "Sales"), sheet(7, "It's", { index: 1, rowCount: 100, columnCount: 26 })];

/** A mint handing out `ids` in turn, then 999. */
function minter(...ids: number[]): () => number {
  let left = [...ids];
  return () => left.shift() ?? 999;
}

/** Resolves `changes` over a spreadsheet of `sheets`, as `updateSpreadsheet()` would queue them. */
function resolve(changes: SheetChange[], sheets: SheetMeta[] = SHEETS, mint = minter(101, 102, 103)) {
  return resolveChanges(grid(sheets), prepareChanges(changes), mint);
}

/** Plans `changes` over a spreadsheet of `SHEETS`, as `updateSpreadsheet()` would queue them. */
function plan(changes: SheetChange[]) {
  let planned = resolve(changes);
  return { planned, ...planSheet(grid(SHEETS), planned) };
}

/** Resolves `changes` later, for `toThrow`. */
const refused = (changes: SheetChange[], sheets: SheetMeta[] = SHEETS) => () => resolve(changes, sheets);

/** Plans `changes` over a spreadsheet of `sheets` later, for `toThrow`. */
const conflict = (changes: PlannedChange[], sheets: SheetMeta[] = SHEETS) => () => planSheet(grid(sheets), changes);

/** An `addSheet` of one cell, as queued. */
const add = (sheetId: number, title: string, index = 2): PlannedChange =>
  ({ op: "addSheet", sheetId, title, index, rowCount: 1, columnCount: 1 });

/** The refusal of a title another sheet has as `title`. */
const taken = (title: string) =>
  `the spreadsheet already has a sheet titled "${title}"; sheet titles must differ, ignoring case.`;

function queued(id: number, changes: PlannedChange[]): QueuedChange {
  return {
    id,
    action: {
      kind: "updateSpreadsheet",
      payload: { changes, sheets: {}, marker: { id: id + 100, token: `token-${id}` }, guard: { sha256: "", after: [] } },
    },
  };
}

function replayed(base: Grid, pending: QueuedChange[]): Grid {
  let result = replayChanges(base, pending);
  if (result.kind !== "complete") throw new Error(result.reason);
  return result.value;
}

describe("Sheets change requests", () => {
  it("enters each value typed, so Google parses nothing by locale", () => {
    let inputs = TYPED_INPUT.flatMap(({ input, sent }) => input === undefined ? [] : [{ input, sent }]);
    let { requests } = plan([{ op: "writeCells", range: "Sales!A1:E1", values: [inputs.map(({ input }) => input)] }]);
    expect(requests).toEqual([{
      updateCells: {
        range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 5 },
        rows: [{ values: inputs.map(({ sent }) => ({ userEnteredValue: sent })) }],
        fields: "userEnteredValue",
      },
    }]);
  });

  it("clears a null cell's content, and a range by sending it no rows", () => {
    let { requests } = plan([
      { op: "writeCells", range: "'it''s'!B2:C2", values: [[null, false]] },
      { op: "clearRange", range: "Sales!C3:D4" },
    ]);
    expect(requests).toEqual([
      {
        updateCells: {
          range: { sheetId: 7, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 1, endColumnIndex: 3 },
          rows: [{ values: [{}, { userEnteredValue: { boolValue: false } }] }],
          fields: "userEnteredValue",
        },
      },
      {
        updateCells: {
          range: { sheetId: 0, startRowIndex: 2, endRowIndex: 4, startColumnIndex: 2, endColumnIndex: 4 },
          fields: "userEnteredValue",
        },
      },
    ]);
  });

  it("enters each cell in the next grid, a clear as null, recording the change that entered it", () => {
    let { planned } = plan([
      { op: "writeCells", range: "Sales!A1:B1", values: [[1, "=A1"]] },
      { op: "clearRange", range: "Sales!B1" },
    ]);
    let next = planSheet(grid(SHEETS), planned, 4).grid;
    expect([...next.cells]).toEqual([
      ["0:b0:b0", { input: 1, at: 0, by: 4 }], ["0:b0:b1", { input: null, at: 0, by: 4 }],
    ]);
  });

  it("returns the grid itself for no changes", () => {
    let base = grid(SHEETS);
    expect(planSheet(base, [])).toEqual({ grid: base, requests: [] });
    expect(planSheet(base, []).grid).toBe(base);
  });

  it("writes formulas as Google stores them, naming sheets by their titles", () => {
    let { planned, requests } = plan([
      { op: "writeCells", range: "sales!A1", values: [["=SUM('it''s'!b3:a2, 'IT''S'!c1:c1, nope!a1)"]] },
    ]);
    let canonical = "=SUM('It''s'!A2:B3, 'It''s'!C1, nope!a1)";
    expect(planned).toEqual([{ op: "writeCells", sheetId: 0, rect: rect(0, 0), values: [[canonical]] }]);
    expect(requests).toMatchObject([{ updateCells: { rows: [{ values: [{ userEnteredValue: { formulaValue: canonical } }] }] } }]);
  });

  it("refuses a sheet the spreadsheet has no tab for, and cells outside a sheet's grid", () => {
    expect(refused([{ op: "clearRange", range: "Sales!A1" }, { op: "clearRange", range: "Nope!A1" }]))
      .toThrow('Change 2 (clearRange): the spreadsheet has no sheet named "Nope". Call getSpreadsheet() for sheet titles.');
    expect(refused([{ op: "writeCells", range: "sales!A21", values: [[1]] }]))
      .toThrow('Change 1 (writeCells): "Sales" has 20 rows and 6 columns, so A21 is outside it. ' +
        "insertRows with at: 21 adds rows.");
    expect(refused([{ op: "clearRange", range: "Sales!A19:B25" }])).toThrow("so A21 is outside it.");
    expect(refused([{ op: "clearRange", range: "Sales!E1:H2" }]))
      .toThrow('so G1 is outside it. insertColumns with at: "G" adds columns.');
  });

  it("re-checks each change against the grid it applies to", () => {
    let planned: PlannedChange[] = [
      { op: "clearRange", sheetId: 0, rect: rect(0, 0) },
      { op: "writeCells", sheetId: 0, rect: rect(20, 0), values: [[1]] },
    ];
    expect(() => planSheet(grid(SHEETS), planned)).toThrow(ChangeConflict);
    expect(() => planSheet(grid(SHEETS), planned)).toThrow('change 2 (writeCells): A21 is outside "Sales"');
    expect(() => planSheet(grid([SHEETS[1]]), planned))
      .toThrow("change 1 (clearRange): the spreadsheet has no sheet with ID 0");
  });

  it("formats a range with a repeatCell and then an updateBorders, its sheet as the batch leaves it", () => {
    let format = { bold: true, fontSize: null, borders: { top: { style: "SOLID", color: "#ff0000" } } } as const;
    let { planned, requests } = plan([
      { op: "renameSheet", sheet: "Sales", title: "Sales 2026" },
      { op: "insertRows", sheet: "Sales 2026", at: 21, count: 5 },
      { op: "formatCells", range: "'sales 2026'!B24:C25", format },
    ]);
    expect(planned[2]).toEqual({ op: "formatCells", sheetId: 0, rect: rect(23, 1, 2, 2), format });
    let range = { sheetId: 0, startRowIndex: 23, endRowIndex: 25, startColumnIndex: 1, endColumnIndex: 3 };
    expect(requests.slice(2)).toEqual([
      {
        repeatCell: {
          range,
          cell: { userEnteredFormat: { textFormat: { bold: true } } },
          fields: "userEnteredFormat(textFormat(bold,fontSize))",
        },
      },
      { updateBorders: { range, top: { style: "SOLID", colorStyle: { rgbColor: { red: 1, green: 0, blue: 0 } } } } },
    ]);
  });

  it("refuses formatting a sheet the spreadsheet has no tab for, or cells outside its grid", () => {
    expect(refused([{ op: "formatCells", range: "Nope!A1", format: { bold: true } }]))
      .toThrow('Change 1 (formatCells): the spreadsheet has no sheet named "Nope". Call getSpreadsheet() for sheet titles.');
    expect(refused([{ op: "formatCells", range: "Sales!A20:A21", format: { bold: true } }]))
      .toThrow('Change 1 (formatCells): "Sales" has 20 rows and 6 columns, so A21 is outside it. ' +
        "insertRows with at: 21 adds rows.");
  });
});

describe("Sheets structural change requests", () => {
  it("sends each op in the shape Google accepts, filling in defaults and minting sheet IDs", () => {
    let planned = resolve([
      { op: "addSheet", title: "Q4" },
      { op: "renameSheet", sheet: "Q4", title: "Q4 2026" },
      { op: "duplicateSheet", sheet: "Sales" },
      { op: "insertRows", sheet: "Sales", at: 21, count: 2 },
      { op: "insertColumns", sheet: "Sales", at: "A" },
      { op: "deleteRows", sheet: "It's", at: 5, count: 2 },
      { op: "deleteColumns", sheet: "It's", at: "C" },
      { op: "deleteSheet", sheet: "Q4 2026" },
    ]);
    expect(planned).toEqual([
      { op: "addSheet", sheetId: 101, title: "Q4", index: 2, ...NEW_SHEET_SIZE },
      { op: "renameSheet", sheetId: 101, title: "Q4 2026" },
      { op: "duplicateSheet", sheetId: 0, newSheetId: 102, title: "Copy of Sales", index: 1 },
      { op: "insertRows", sheetId: 0, start: 20, count: 2, appends: true },
      { op: "insertColumns", sheetId: 0, start: 0, count: 1 },
      { op: "deleteRows", sheetId: 7, start: 4, count: 2 },
      { op: "deleteColumns", sheetId: 7, start: 2, count: 1 },
      { op: "deleteSheet", sheetId: 101, ...NEW_SHEET_SIZE },
    ]);
    let { grid: next, requests } = planSheet(grid(SHEETS), planned);
    expect(requests).toEqual([
      { addSheet: { properties: { sheetId: 101, title: "Q4", index: 2, gridProperties: NEW_SHEET_SIZE } } },
      { updateSheetProperties: { properties: { sheetId: 101, title: "Q4 2026" }, fields: "title" } },
      { duplicateSheet: { sourceSheetId: 0, newSheetId: 102, insertSheetIndex: 1, newSheetName: "Copy of Sales" } },
      // Lines added after the last must take the formatting of the line before them.
      { insertDimension: { range: { sheetId: 0, dimension: "ROWS", startIndex: 20, endIndex: 22 }, inheritFromBefore: true } },
      { insertDimension: { range: { sheetId: 0, dimension: "COLUMNS", startIndex: 0, endIndex: 1 }, inheritFromBefore: false } },
      { deleteDimension: { range: { sheetId: 7, dimension: "ROWS", startIndex: 4, endIndex: 6 } } },
      { deleteDimension: { range: { sheetId: 7, dimension: "COLUMNS", startIndex: 2, endIndex: 3 } } },
      { deleteSheet: { sheetId: 101 } },
    ]);
    expect(next.sheets.map(({ id, title, index, rowCount, columnCount }) => [id, title, index, rowCount, columnCount]))
      .toEqual([[0, "Sales", 0, 22, 7], [102, "Copy of Sales", 1, 20, 6], [7, "It's", 2, 98, 25]]);
    expect(next.log.map(({ kind }) => kind))
      .toEqual(["add", "rename", "duplicate", "insert", "insert", "delete", "delete", "deleteSheet"]);
  });

  it("takes what an addSheet or duplicateSheet is given over its defaults", () => {
    let planned = resolve([
      { op: "addSheet", title: "Top", index: 0, rowCount: 5, columnCount: 2 },
      { op: "duplicateSheet", sheet: "It's", title: "Mine", index: 0 },
    ]);
    expect(planned).toEqual([
      { op: "addSheet", sheetId: 101, title: "Top", index: 0, rowCount: 5, columnCount: 2 },
      { op: "duplicateSheet", sheetId: 7, newSheetId: 102, title: "Mine", index: 0 },
    ]);
  });

  it("mints only IDs no sheet has, those the batch adds included", () => {
    let planned = resolve([
      { op: "addSheet", title: "A" },
      { op: "duplicateSheet", sheet: "A" },
    ], SHEETS, minter(0, 7, 55, 55, 56));
    expect(planned.map(change => change.op === "duplicateSheet" ? change.newSheetId : change.sheetId)).toEqual([55, 56]);
    expect(() => resolveChanges(grid(SHEETS), prepareChanges([{ op: "addSheet", title: "A" }]), () => 0))
      .toThrow("No unused sheet ID could be chosen.");
  });

  it("addresses each change to the spreadsheet as the changes before it leave it", () => {
    let { planned, requests, grid: next } = plan([
      { op: "insertRows", sheet: "Sales", at: 1, count: 2 },
      { op: "writeCells", range: "Sales!A1:A3", values: [[1], [2], [3]] },
    ]);
    expect(planned[1]).toEqual({ op: "writeCells", sheetId: 0, rect: rect(0, 0, 3), values: [[1], [2], [3]] });
    expect(requests[1]).toMatchObject({ updateCells: { range: { sheetId: 0, startRowIndex: 0, endRowIndex: 3 } } });
    // The written cells are the two new rows and the row that was first.
    expect([...next.cells.keys()]).toEqual(["0:n0.0:b0", "0:n0.1:b0", "0:b0:b0"]);
    expect(next.cells.get("0:b0:b0")).toEqual({ input: 3, at: 1, by: 0 });

    let renamed = resolve([
      { op: "renameSheet", sheet: "Sales", title: "Sales 2026" },
      { op: "writeCells", range: "'sales 2026'!A1", values: [["=SUM('SALES 2026'!b1:b2)"]] },
    ]);
    expect(renamed[1]).toEqual({ op: "writeCells", sheetId: 0, rect: rect(0, 0), values: [["=SUM('Sales 2026'!B1:B2)"]] });
    expect(refused([
      { op: "renameSheet", sheet: "Sales", title: "Sales 2026" },
      { op: "clearRange", range: "Sales!A1" },
    ])).toThrow('Change 2 (clearRange): the spreadsheet has no sheet named "Sales".');

    let added = resolve([
      { op: "addSheet", title: "Q4", rowCount: 5, columnCount: 2 },
      { op: "writeCells", range: "Q4!B5", values: [[1]] },
    ]);
    expect(added[1]).toEqual({ op: "writeCells", sheetId: 101, rect: rect(4, 1), values: [[1]] });
    expect(refused([{ op: "addSheet", title: "Q4", rowCount: 5, columnCount: 2 }, { op: "clearRange", range: "Q4!C1" }]))
      .toThrow('Change 2 (clearRange): "Q4" has 5 rows and 2 columns, so C1 is outside it.');
  });

  it("finds each change's sheet by the title it has once earlier changes apply, ignoring case", () => {
    expect(refused([{ op: "deleteSheet", sheet: "Nope" }])).toThrow(
      'Change 1 (deleteSheet): the spreadsheet has no sheet named "Nope". Call getSpreadsheet() for sheet titles.');
    // A rename takes the old title from the sheet, and a deleted sheet's title names nothing.
    expect(refused([
      { op: "renameSheet", sheet: "Sales", title: "Revenue" },
      { op: "insertRows", sheet: "Sales", at: 1 },
    ])).toThrow('Change 2 (insertRows): the spreadsheet has no sheet named "Sales".');
    expect(refused([
      { op: "addSheet", title: "A" },
      { op: "deleteSheet", sheet: "A" },
      { op: "renameSheet", sheet: "A", title: "B" },
    ])).toThrow('Change 3 (renameSheet): the spreadsheet has no sheet named "A".');
    let planned = resolve([
      { op: "insertRows", sheet: "SALES", at: 1 },
      { op: "deleteColumns", sheet: "it's", at: "A" },
      { op: "duplicateSheet", sheet: "Sales", title: "Copy" },
      { op: "deleteRows", sheet: "COPY", at: 1 },
      { op: "renameSheet", sheet: "copy", title: "Final" },
      { op: "insertColumns", sheet: "final", at: "A" },
    ]);
    expect(planned.map(change => change.sheetId)).toEqual([0, 7, 0, 101, 101, 101]);
  });

  it("refuses a title another sheet has, ignoring case", () => {
    expect(refused([{ op: "addSheet", title: "sales" }])).toThrow(`Change 1 (addSheet): ${taken("Sales")}`);
    expect(refused([{ op: "renameSheet", sheet: "It's", title: "SALES" }])).toThrow(`Change 1 (renameSheet): ${taken("Sales")}`);
    expect(refused([{ op: "duplicateSheet", sheet: "Sales" }, { op: "duplicateSheet", sheet: "Sales" }]))
      .toThrow(`Change 2 (duplicateSheet): ${taken("Copy of Sales")}`);
    expect(refused([{ op: "duplicateSheet", sheet: "Sales", title: "IT'S" }])).toThrow(taken("It's"));
    // A sheet may change the case of its own title, and a title a rename frees may be taken.
    expect(refused([{ op: "renameSheet", sheet: "Sales", title: "SALES" }])).not.toThrow();
    expect(refused([{ op: "renameSheet", sheet: "Sales", title: "Old" }, { op: "addSheet", title: "Sales" }])).not.toThrow();
    expect(refused([{ op: "duplicateSheet", sheet: "x".repeat(95) }], [sheet(0, "x".repeat(95))]))
      .toThrow(`Change 1 (duplicateSheet): "Copy of ${"x".repeat(95)}" would be over 100 characters; give the copy a title.`);
  });

  it("refuses deleting the last visible sheet, or every row or column", () => {
    let hidden = [sheet(0, "Sales"), sheet(1, "Hidden", { hidden: true })];
    expect(refused([{ op: "deleteSheet", sheet: "Sales" }], hidden))
      .toThrow('Change 1 (deleteSheet): "Sales" is the spreadsheet\'s only visible sheet, and a spreadsheet keeps at least one.');
    expect(refused([{ op: "deleteSheet", sheet: "Hidden" }], hidden)).not.toThrow();
    expect(refused([{ op: "deleteSheet", sheet: "Sales" }, { op: "deleteSheet", sheet: "It's" }]))
      .toThrow('Change 2 (deleteSheet): "It\'s" is the spreadsheet\'s only visible sheet');
    expect(refused([{ op: "deleteRows", sheet: "Sales", at: 1, count: 20 }]))
      .toThrow('Change 1 (deleteRows): deleting rows 1 to 20 would delete every row of "Sales", and a sheet keeps at least one.');
    expect(refused([{ op: "deleteColumns", sheet: "Sales", at: "A", count: 6 }]))
      .toThrow('Change 1 (deleteColumns): deleting columns A to F would delete every column of "Sales"');
    expect(refused([{ op: "deleteRows", sheet: "Sales", at: 1, count: 19 }])).not.toThrow();
  });

  it("refuses leaving only frozen rows or columns, and more columns than a sheet holds", () => {
    let frozen = [sheet(0, "Sales", { frozenRowCount: 2, frozenColumnCount: 1 })];
    expect(refused([{ op: "deleteRows", sheet: "Sales", at: 3, count: 18 }], frozen))
      .toThrow('Change 1 (deleteRows): deleting rows 3 to 20 would leave only the 2 frozen rows of "Sales"');
    expect(refused([{ op: "deleteRows", sheet: "Sales", at: 3, count: 17 }], frozen)).not.toThrow();
    expect(refused([{ op: "deleteColumns", sheet: "Sales", at: "B", count: 5 }], frozen))
      .toThrow('would leave only the 1 frozen column of "Sales"');
    let wide = [sheet(0, "Sales", { rowCount: 1, columnCount: 18_278 })];
    expect(refused([{ op: "insertColumns", sheet: "Sales", at: "A" }], wide))
      .toThrow('Change 1 (insertColumns): "Sales" has 18,278 columns, and a sheet holds at most 18,278.');
  });

  it("keeps a copy's frozen rows and columns, so the batch cannot unfreeze the copy's last line", () => {
    let frozen = [sheet(0, "Sales", { frozenRowCount: 2, frozenColumnCount: 1 })];
    expect(refused([
      { op: "duplicateSheet", sheet: "Sales" }, { op: "deleteRows", sheet: "Copy of Sales", at: 3, count: 18 },
    ], frozen)).toThrow('Change 2 (deleteRows): deleting rows 3 to 20 would leave only the 2 frozen rows of "Copy of Sales"');
    expect(refused([
      { op: "duplicateSheet", sheet: "Sales" }, { op: "deleteColumns", sheet: "Copy of Sales", at: "B", count: 5 },
    ], frozen)).toThrow('Change 2 (deleteColumns): deleting columns B to F would leave only the 1 frozen column of "Copy of Sales"');
    let planned = resolve([{ op: "duplicateSheet", sheet: "Sales" }]);
    let copy = planSheet(grid(SHEETS), planned).grid.sheets.find(candidate => candidate.title === "Copy of Sales");
    expect(copy).toBeDefined();
    expect(copy).not.toHaveProperty("frozenRowCount");
    expect(copy).not.toHaveProperty("frozenColumnCount");
  });

  it("refuses inserting or deleting rows and columns the sheet does not have", () => {
    expect(refused([{ op: "insertRows", sheet: "Sales", at: 22 }]))
      .toThrow('Change 1 (insertRows): "Sales" has 20 rows, so at must be from 1 to 21.');
    expect(refused([{ op: "insertColumns", sheet: "Sales", at: "H" }]))
      .toThrow('Change 1 (insertColumns): "Sales" has 6 columns, so at must be a column from A to G.');
    expect(refused([{ op: "deleteRows", sheet: "Sales", at: 19, count: 4 }]))
      .toThrow('Change 1 (deleteRows): "Sales" has 20 rows, so rows 19 to 22 cannot be deleted.');
    expect(refused([{ op: "deleteColumns", sheet: "Sales", at: "G" }]))
      .toThrow('Change 1 (deleteColumns): "Sales" has 6 columns, so column G cannot be deleted.');
    expect(refused([{ op: "insertRows", sheet: "Sales", at: 1, count: 5 }, { op: "deleteRows", sheet: "Sales", at: 25 }]))
      .not.toThrow();
  });

  it("refuses an index past the last sheet, and a spreadsheet of more than 10,000,000 cells", () => {
    expect(refused([{ op: "addSheet", title: "A", index: 3 }]))
      .toThrow("Change 1 (addSheet): index 3 is past the end; the spreadsheet has 2 sheets, so index may be at most 2.");
    expect(refused([{ op: "addSheet", title: "A", index: 2 }])).not.toThrow();
    expect(refused([{ op: "addSheet", title: "A", rowCount: 10_000_000, columnCount: 1 }]))
      .toThrow("Change 1 (addSheet): the spreadsheet would hold 10,002,720 cells; Google Sheets holds at most 10,000,000.");
    let big = [sheet(0, "Big", { rowCount: 9_999_000, columnCount: 1 })];
    expect(refused([{ op: "insertRows", sheet: "Big", at: 1, count: 1000 }], big)).not.toThrow();
    expect(refused([{ op: "insertColumns", sheet: "Big", at: "B" }], big)).toThrow("would hold 19,998,000 cells");
    expect(refused([{ op: "duplicateSheet", sheet: "Big" }], big)).toThrow("would hold 19,998,000 cells");
  });

  it("refuses deleting a sheet of more than 50,000 cells", () => {
    let sheets = [sheet(0, "Sales"), sheet(1, "Big", { index: 1, rowCount: 1000, columnCount: 51 })];
    expect(refused([{ op: "deleteSheet", sheet: "Big" }], sheets)).toThrow(
      'Change 1 (deleteSheet): "Big" has 51,000 cells, more than the 50,000 a sheet deleted here may have; ' +
      "delete it in Google Sheets.");
    expect(refused([{ op: "deleteColumns", sheet: "Big", at: "A" }, { op: "deleteSheet", sheet: "Big" }], sheets))
      .not.toThrow();
  });

  it("finds what no longer applies when it replays or applies", () => {
    expect(conflict([{ op: "renameSheet", sheetId: 0, title: "X" }], [SHEETS[1]]))
      .toThrow("change 1 (renameSheet): the spreadsheet has no sheet with ID 0");
    expect(conflict([add(7, "New")])).toThrow("change 1 (addSheet): the spreadsheet already has a sheet with ID 7");
    expect(conflict([add(50, "it's")])).toThrow('change 1 (addSheet): the spreadsheet already has a sheet titled "It\'s"');
    expect(conflict([{ op: "renameSheet", sheetId: 0, title: "IT'S" }])).toThrow('already has a sheet titled "It\'s"');
    expect(conflict([{ op: "duplicateSheet", sheetId: 0, newSheetId: 50, title: "C", index: 5 }]))
      .toThrow("change 1 (duplicateSheet): position 5 is past the spreadsheet's 2 sheets");
    expect(conflict([{ op: "deleteSheet", sheetId: 0, rowCount: 20, columnCount: 6 }], [SHEETS[0]]))
      .toThrow('change 1 (deleteSheet): "Sales" is the spreadsheet\'s only visible sheet');
    expect(conflict([{ op: "deleteRows", sheetId: 0, start: 19, count: 2 }]))
      .toThrow('change 1 (deleteRows): "Sales" has 20 rows, so rows 20 to 21 cannot be deleted');
    expect(conflict([{ op: "deleteColumns", sheetId: 0, start: 0, count: 6 }]))
      .toThrow('change 1 (deleteColumns): it would delete every column of "Sales"');
    expect(conflict([{ op: "insertRows", sheetId: 0, start: 21, count: 1 }]))
      .toThrow('change 1 (insertRows): "Sales" has 20 rows, so none can be inserted before row 22');
    expect(conflict([add(50, "It's")])).toThrow(ChangeConflict);
  });
});

describe("Sheets apply guard", () => {
  let cells: SheetArea[] = [{ sheetId: 0, rect: rect(0, 0, 1, 2) }, { sheetId: 7, rect: rect(2, 2, 2, 1) }];
  let [stored, later] = WHITESPACE_DRIFT;
  let entered: EnteredValue[][][] = [[["old", { formula: stored }]], [[3], [null]]];
  let digest = (overrides: { sheets?: SheetMeta[]; entered?: EnteredValue[][][] } = {}) =>
    guardDigest(overrides.sheets ?? SHEETS, { sheetIds: [0, 7], cells }, overrides.entered ?? entered);
  // The digest with `value` entered in the batch's first cell.
  let withFirst = (value: EnteredValue) => digest({ entered: [[[value, { formula: stored }]], [[3], [null]]] });

  it("is a hex SHA-256, unchanged by whitespace Google drops from a formula", async () => {
    let base = await digest();
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(await digest({ entered: [[["old", { formula: later }]], [[3], [null]]] })).toBe(base);
    // A cell left out is blank.
    expect(await digest({ entered: [[["old", { formula: stored }]], [[3]]] })).toBe(base);
    // Zero and false are values, not blanks.
    expect(await digest({ entered: [[["old", { formula: stored }]], [[3], [0]]] })).not.toBe(base);
    expect(await digest({ entered: [[["old", { formula: stored }]], [[3], [false]]] })).not.toBe(base);
  });

  it("digests text exactly, though formula-mode reads cannot tell it from a formula", async () => {
    expect(await withFirst("=order 123")).not.toBe(await withFirst("=order123"));
    expect(await withFirst(stored)).not.toBe(await withFirst(later));
    expect(await withFirst("=1")).not.toBe(await withFirst({ formula: "=1" }));
    expect(await withFirst({ error: "REF" })).not.toBe(await withFirst("#REF!"));
    expect(await withFirst({ error: "REF" })).not.toBe(await withFirst({ formula: "REF" }));
    expect(await withFirst({ error: "REF" })).not.toBe(await withFirst({ error: "N_A" }));
    // Nor can text pass for a tagged value.
    expect(await withFirst({ formula: "=1" })).not.toBe(await withFirst('["f","=1"]'));
  });

  it("changes with a value, a sheet's title or its size", async () => {
    let base = await digest();
    expect(await digest({ entered: [[["new", { formula: stored }]], [[3], [null]]] })).not.toBe(base);
    expect(await digest({ entered: [[["old", { formula: "=Sales!$D$4 + 1" }]], [[3], [null]]] })).not.toBe(base);
    expect(await digest({ entered: [[["old", { formula: stored }]], [["3"], [null]]] })).not.toBe(base);
    expect(await digest({ sheets: [sheet(0, "Sales"), { ...SHEETS[1], title: "Its" }] })).not.toBe(base);
    expect(await digest({ sheets: [sheet(0, "Sales", { rowCount: 21 }), SHEETS[1]] })).not.toBe(base);
    expect(await digest({ sheets: [SHEETS[1]] })).not.toBe(base);
    // A sheet the batch does not act on is not part of it.
    expect(await digest({ sheets: [...SHEETS, sheet(9, "Other")] })).toBe(base);
  });

  it("guards a batch queued before guards named their cells as it was guarded then", async () => {
    let batch: Pick<SheetBatch, "changes" | "guard"> = {
      changes: [
        { op: "writeCells", sheetId: 7, rect: rect(2, 2, 2, 1), values: [[1], [2]] },
        { op: "clearRange", sheetId: 0, rect: rect(0, 0, 1, 2) },
      ],
      guard: { sha256: "", after: [] },
    };
    let guard = guardOf(batch);
    expect(guard).toEqual({
      sheetIds: [0, 7], cells: [{ sheetId: 7, rect: rect(2, 2, 2, 1) }, { sheetId: 0, rect: rect(0, 0, 1, 2) }], order: false,
    });
    // The bytes hashed are those the guard was taken over when it was queued.
    let bytes = new TextEncoder().encode(JSON.stringify([
      [[0, "Sales", 20, 6], [7, "It's", 100, 26]], [[3, null], ["old", ["f", compactFormula(stored)]]],
    ]));
    let expected = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      byte => byte.toString(16).padStart(2, "0")).join("");
    expect(await guardDigest(SHEETS, guard, [[[3]], [["old", { formula: stored }]]])).toBe(expected);
    let named = { ...batch, guard: { ...batch.guard, cells: [{ sheetId: 0, rect: rect(5, 5) }] } };
    expect(guardOf(named).cells).toEqual([{ sheetId: 0, rect: rect(5, 5) }]);
  });

  it("fits only cells each sheet still has", () => {
    expect(guardFits(SHEETS, cells)).toBe(true);
    expect(guardFits(SHEETS, [{ sheetId: 0, rect: rect(19, 5) }])).toBe(true);
    expect(guardFits(SHEETS, [{ sheetId: 0, rect: rect(20, 0) }])).toBe(false);
    expect(guardFits(SHEETS, [{ sheetId: 0, rect: rect(0, 6) }])).toBe(false);
    expect(guardFits(SHEETS, [{ sheetId: 3, rect: rect(0, 0) }])).toBe(false);
  });

  it("names the sheets a batch acts on that are there before it", () => {
    expect(guardedSheets([
      { op: "addSheet", sheetId: 101, title: "Q4", index: 2, rowCount: 1, columnCount: 1 },
      { op: "clearRange", sheetId: 101, rect: rect(0, 0) },
      { op: "renameSheet", sheetId: 7, title: "X" },
      { op: "duplicateSheet", sheetId: 0, newSheetId: 102, title: "C", index: 1 },
      { op: "clearRange", sheetId: 102, rect: rect(0, 0) },
      { op: "deleteRows", sheetId: 7, start: 0, count: 1 },
    ])).toEqual([0, 7]);
  });
});

/** The cells a batch of `changes` over `sheets` overwrites or removes. */
function cellsOf(changes: SheetChange[], sheets: SheetMeta[] = SHEETS): SheetArea[] {
  return guardCells(grid(sheets), resolve(changes, sheets));
}

describe("Sheets guarded cells", () => {
  it("maps a write back through the batch's own inserted lines, leaving them out", () => {
    expect(cellsOf([
      { op: "insertRows", sheet: "Sales", at: 3, count: 2 },
      { op: "clearRange", range: "Sales!A1:A6" },
    ])).toEqual([{ sheetId: 0, rect: rect(0, 0, 4) }]);
    expect(cellsOf([
      { op: "insertColumns", sheet: "Sales", at: "B" },
      { op: "clearRange", range: "Sales!A1:C1" },
    ])).toEqual([{ sheetId: 0, rect: rect(0, 0, 1, 2) }]);
    // Lines a queued change inserted before the batch are lines the batch overwrites.
    let queuedInsert = planSheet(grid(SHEETS), [{ op: "insertRows", sheetId: 0, start: 0, count: 1 }]).grid;
    let planned = resolveChanges(queuedInsert, prepareChanges([
      { op: "insertRows", sheet: "Sales", at: 2 },
      { op: "clearRange", range: "Sales!A1:A3" },
    ]), minter());
    expect(guardCells(queuedInsert, planned)).toEqual([{ sheetId: 0, rect: rect(0, 0, 2) }]);
  });

  it("covers a deleted band across the sheet, and a deleted sheet whole", () => {
    expect(cellsOf([{ op: "deleteRows", sheet: "Sales", at: 5, count: 2 }]))
      .toEqual([{ sheetId: 0, rect: rect(4, 0, 2, 6) }]);
    expect(cellsOf([{ op: "deleteColumns", sheet: "Sales", at: "B" }])).toEqual([{ sheetId: 0, rect: rect(0, 1, 20, 1) }]);
    expect(cellsOf([{ op: "deleteSheet", sheet: "It's" }])).toEqual([{ sheetId: 7, rect: rect(0, 0, 100, 26) }]);
    // A column the batch inserted and then deletes covers nothing; the one beside it does.
    expect(cellsOf([
      { op: "insertColumns", sheet: "Sales", at: "A" },
      { op: "deleteColumns", sheet: "Sales", at: "A", count: 2 },
    ])).toEqual([{ sheetId: 0, rect: rect(0, 0, 20, 1) }]);
  });

  it("covers nothing of sheets the batch creates, nor what changes no cell", () => {
    expect(cellsOf([
      { op: "addSheet", title: "Q4" },
      { op: "clearRange", range: "Q4!A1:B2" },
      { op: "deleteRows", sheet: "Q4", at: 1 },
      { op: "duplicateSheet", sheet: "Sales" },
      { op: "clearRange", range: "'Copy of Sales'!A1" },
      { op: "renameSheet", sheet: "It's", title: "Other" },
      { op: "insertRows", sheet: "Other", at: 1 },
    ])).toEqual([]);
    // Formatting is not guarded.
    expect(cellsOf([{ op: "formatCells", range: "Sales!A1:B2", format: { bold: true } }])).toEqual([]);
  });

  it("lists cells once, and refuses more than 50,000", () => {
    expect(cellsOf([{ op: "clearRange", range: "Sales!A1:B2" }, { op: "clearRange", range: "Sales!A1:B2" }]))
      .toEqual([{ sheetId: 0, rect: rect(0, 0, 2, 2) }]);
    // An area overlapping an earlier one adds only the cells it leaves out.
    expect(cellsOf([{ op: "clearRange", range: "Sales!A1:B2" }, { op: "clearRange", range: "Sales!B2:C3" }])).toEqual([
      { sheetId: 0, rect: rect(0, 0, 2, 2) }, { sheetId: 0, rect: rect(1, 2, 1, 1) }, { sheetId: 0, rect: rect(2, 1, 1, 2) },
    ]);
    expect(cellsOf([
      { op: "clearRange", range: "Sales!A1:C3" }, { op: "clearRange", range: "Sales!B2" },
    ])).toEqual([{ sheetId: 0, rect: rect(0, 0, 3, 3) }]);
    // A sheet whose rows are deleted and then the sheet: its cells count once.
    let square = [sheet(0, "Square", { rowCount: 200, columnCount: 200 }), sheet(1, "Other", { index: 1 })];
    expect(cellsOf([
      { op: "deleteRows", sheet: "Square", at: 1, count: 100 }, { op: "deleteSheet", sheet: "Square" },
    ], square)).toEqual([{ sheetId: 0, rect: rect(0, 0, 200, 200) }]);
    let wide = [sheet(0, "Wide", { rowCount: 1000, columnCount: 60 })];
    expect(() => cellsOf([{ op: "deleteColumns", sheet: "Wide", at: "A", count: 51 }], wide)).toThrow(
      "These changes overwrite or delete 51,000 cells that are already there; one batch may overwrite or " +
      "delete at most 50,000.");
    expect(cellsOf([{ op: "deleteColumns", sheet: "Wide", at: "A", count: 50 }], wide)).toHaveLength(1);
  });
});

describe("Sheets batches built on queued changes", () => {
  let pending = [
    queued(1, [{ op: "writeCells", sheetId: 0, rect: rect(0, 0), values: [[1]] }]),
    queued(2, [{ op: "insertRows", sheetId: 7, start: 0, count: 1 }]),
    queued(3, [{ op: "writeCells", sheetId: 0, rect: rect(4, 1), values: [["=A1"]] }]),
  ];
  let simulated = replayed(grid(SHEETS), pending);
  let after = (changes: SheetChange[]) => {
    let planned = resolveChanges(simulated, prepareChanges(changes), minter(101));
    return guardAfter(simulated, pending, planned, guardCells(simulated, planned));
  };

  it("builds on the changes that entered what it overwrites", () => {
    expect(after([{ op: "clearRange", range: "Sales!A1:A2" }])).toEqual([1]);
    expect(after([{ op: "clearRange", range: "Sales!A1:B5" }])).toEqual([1, 3]);
    expect(after([{ op: "clearRange", range: "Sales!C1:D9" }])).toEqual([]);
    expect(after([{ op: "deleteRows", sheet: "Sales", at: 5 }])).toEqual([3]);
  });

  it("builds on every change to the rows, columns or tab of a sheet it acts on", () => {
    expect(after([{ op: "clearRange", range: "'It''s'!Z99" }])).toEqual([2]);
    expect(after([{ op: "renameSheet", sheet: "It's", title: "Other" }])).toEqual([2]);
    expect(after([{ op: "addSheet", title: "Q4" }])).toEqual([]);
    // Formatting builds on structure, but not on the values it formats, which it does not guard.
    expect(after([{ op: "formatCells", range: "'It''s'!A1", format: { italic: true } }])).toEqual([2]);
    expect(after([{ op: "formatCells", range: "Sales!A1:B5", format: { italic: true } }])).toEqual([]);
  });

  it("builds a batch with a formula on every structural change queued before it, on any sheet", () => {
    // Sales!D9 names It's rows as change 2 leaves them, though the batch never acts on It's.
    expect(after([{ op: "writeCells", range: "Sales!D9", values: [["='It''s'!A2"]] }])).toEqual([2]);
    expect(after([{ op: "writeCells", range: "Sales!D9", values: [[2]] }])).toEqual([]);
  });

  it("builds a batch guarding a formula on every structural change queued before it, on any sheet", () => {
    // Sales!A1 holds a formula naming It's rows, which the guard digests as change 1 leaves them.
    let deleted = [queued(1, [{ op: "deleteRows", sheetId: 7, start: 0, count: 1 }])];
    let shifted = replayed(grid(SHEETS), deleted);
    let planned = resolveChanges(shifted, prepareChanges([
      { op: "writeCells", range: "Sales!A1", values: [["x"]] },
    ]), minter());
    let cells = guardCells(shifted, planned);
    let pieces = basePiecesOf(shifted, cells);
    // Whether the guard digests a formula, as the session works it out from what it digests.
    let guarding = (held: EnteredValue) => {
      let content = enteredContent(shifted, cells, baseValues(pieces, [[[held]]]));
      return { content, formulas: content.some(area => area.some(row => row.some(holdsFormula))) };
    };
    let formula = guarding({ formula: "='It''s'!A5" });
    expect(formula.content).toEqual([[[{ formula: "='It''s'!A4" }]]]);
    expect(guardAfter(shifted, deleted, planned, cells, formula.formulas)).toEqual([1]);
    // Text starting with = names no rows.
    let text = guarding("='It''s'!A5");
    expect(text.content).toEqual([[["='It''s'!A5"]]]);
    expect(guardAfter(shifted, deleted, planned, cells, text.formulas)).toEqual([]);
  });

  it("builds a copy on every structural change queued before it, on any sheet, which its formulas name", () => {
    let rewritten = [
      queued(1, [{ op: "writeCells", sheetId: 0, rect: rect(0, 0), values: [["='It''s'!A5"]] }]),
      queued(2, [{ op: "deleteRows", sheetId: 7, start: 4, count: 1 }]),
    ];
    let shifted = replayed(grid(SHEETS), rewritten);
    let planned = resolveChanges(shifted, prepareChanges([{ op: "duplicateSheet", sheet: "Sales" }]), minter(101));
    expect(guardAfter(shifted, rewritten, planned, guardCells(shifted, planned))).toEqual([1, 2]);
  });

  it("builds a batch adding a sheet on every sheet queued before it to be added, copied or deleted", () => {
    let tabs = [
      queued(1, [{ op: "addSheet", sheetId: 50, title: "Q4", index: 0, rowCount: 5, columnCount: 5 }]),
      queued(2, [{ op: "deleteSheet", sheetId: 7, rowCount: 100, columnCount: 26 }]),
      queued(3, [{ op: "renameSheet", sheetId: 0, title: "Revenue" }]),
      queued(4, [{ op: "insertRows", sheetId: 0, start: 0, count: 1 }]),
    ];
    let moved = replayed(grid(SHEETS), tabs);
    let planned = resolveChanges(moved, prepareChanges([{ op: "addSheet", title: "Q5", index: 1 }]), minter(101));
    // Where it lands counts the sheets the first two leave; the others move no sheet.
    expect(guardAfter(moved, tabs, planned, guardCells(moved, planned))).toEqual([1, 2]);
  });

  it("builds a copy on the changes that entered what its original holds as it is copied", () => {
    expect(after([{ op: "duplicateSheet", sheet: "Sales" }])).toEqual([1, 2, 3]);
    expect(after([{ op: "duplicateSheet", sheet: "Sales" }, { op: "duplicateSheet", sheet: "Copy of Sales" }]))
      .toEqual([1, 2, 3]);
    expect(after([{ op: "duplicateSheet", sheet: "It's" }])).toEqual([2]);
    // A copy queued earlier holds what was queued for its original.
    let copied = [...pending, queued(4, [{ op: "duplicateSheet", sheetId: 0, newSheetId: 50, title: "Copy", index: 2 }])];
    let withCopy = replayed(grid(SHEETS), copied);
    let planned = resolveChanges(withCopy, prepareChanges([{ op: "duplicateSheet", sheet: "Copy" }]), minter(101));
    expect(guardAfter(withCopy, copied, planned, guardCells(withCopy, planned))).toEqual([1, 2, 3, 4]);
    // Entries made outside a replay, and those the batch makes, are no queued change's.
    let entered = grid(SHEETS, { "0:0:0": 1 });
    (planned = resolveChanges(entered, prepareChanges([
      { op: "writeCells", range: "Sales!B1", values: [[2]] }, { op: "duplicateSheet", sheet: "Sales" },
    ]), minter(101)));
    expect(guardAfter(entered, [], planned, guardCells(entered, planned))).toEqual([]);
  });

  it("labels each sheet a batch acts on or creates by its title before the batch", () => {
    let planned = resolve([
      { op: "renameSheet", sheet: "Sales", title: "X" },
      { op: "addSheet", title: "Q4" },
      { op: "duplicateSheet", sheet: "It's" },
      { op: "clearRange", range: "Q4!A1" },
    ]);
    expect(sheetLabels(grid(SHEETS), planned)).toEqual({ 0: "Sales", 101: "Q4", 7: "It's", 102: "Copy of It's" });
  });
});

/** The most lines one `linesAt` call has listed since its calls were last cleared. */
const widest = () => vi.mocked(linesAt).mock.calls.reduce((most, [, start, end]) => Math.max(most, end - start), 0);

describe("Sheets batches over millions of rows", () => {
  beforeEach(() => vi.mocked(linesAt).mockClear());

  it("adds a sheet of 2,000,000 rows and deletes all but one, listing none of the rows deleted", () => {
    let base = grid(SHEETS);
    let planned = resolveChanges(base, prepareChanges([
      { op: "addSheet", title: "Tall", rowCount: 2_000_000, columnCount: 1 },
      { op: "writeCells", range: "Tall!A2000000", values: [[1]] },
      { op: "deleteRows", sheet: "Tall", at: 2, count: 1_999_999 },
    ]), minter(101));
    let next = planSheet(base, planned).grid;
    expect(next.sheets.find(candidate => candidate.id === 101)?.rowCount).toBe(1);
    // The write went with the row it was in.
    expect(next.cells.size).toBe(0);
    let cells = guardCells(base, planned);
    expect(cells).toEqual([]);
    expect(guardAfter(base, [], planned, cells)).toEqual([]);
    expect(widest()).toBeGreaterThan(0);
    expect(widest()).toBeLessThanOrEqual(MAX_GUARDED_CELLS);
  });

  it("finds a queued write among 1,999,999 rows deleted by its position, and refuses guarding them", () => {
    let tall = [sheet(0, "Tall", { rowCount: 2_000_000, columnCount: 1 }), sheet(1, "Other")];
    let pending = [queued(1, [{ op: "writeCells", sheetId: 0, rect: rect(1_999_999, 0), values: [[5]] }])];
    let simulated = replayed(grid(tall), pending);
    let deleting = (at: number) => resolveChanges(simulated, prepareChanges([
      { op: "deleteRows", sheet: "Tall", at, count: 1_999_999 },
    ]), minter());

    let planned = deleting(2);
    expect(planSheet(simulated, planned).grid.cells.size).toBe(0);
    expect(() => guardCells(simulated, planned)).toThrow(
      "These changes overwrite or delete 1,999,999 cells that are already there; one batch may overwrite or " +
      "delete at most 50,000.");
    expect(guardAfter(simulated, pending, planned, [{ sheetId: 0, rect: rect(1, 0, 1_999_999) }])).toEqual([1]);
    // Deleting the rows above the write keeps it, in the one row left.
    let kept = planSheet(simulated, deleting(1)).grid;
    expect([...kept.cells.values()]).toEqual([{ input: 5, at: 0, by: 1 }]);
    expect(widest()).toBeLessThanOrEqual(MAX_GUARDED_CELLS);
  });
});

/** A queued write of literal values to every cell of `area` of sheet `sheetId`. */
function filled(id: number, sheetId: number, area: Rect): QueuedChange {
  let values = Array.from({ length: area.endRow - area.startRow }, (_row, r) =>
    Array.from({ length: area.endColumn - area.startColumn }, (_cell, c) => r * 100 + c));
  return queued(id, [{ op: "writeCells", sheetId, rect: area, values }]);
}

/** `count` copies of Sales over `simulated`, each titled apart, with the IDs 101 on. */
function copies(simulated: Grid, count: number) {
  let changes = Array.from({ length: count }, (_copy, i): SheetChange =>
    ({ op: "duplicateSheet", sheet: "Sales", title: `Copy ${i + 1}` }));
  return resolveChanges(simulated, prepareChanges(changes), minter(...changes.map((_copy, i) => 101 + i)));
}

describe("Sheets copies of queued cells", () => {
  let big = [sheet(0, "Sales", { rowCount: 1000, columnCount: 26 }), sheet(7, "It's", { index: 1, rowCount: 100, columnCount: 26 })];

  it("refuses a copy that would bring the cells queued changes enter past 100,000", () => {
    let simulated = replayed(grid(big), [filled(1, 0, rect(0, 0, 800, 25))]);
    expect(simulated.cells.size).toBe(20_000);
    expect(() => copies(simulated, 50)).toThrow(
      'Change 5 (duplicateSheet): copying "Sales" adds its 20,000 queued cell values and formats to the copy, which would bring ' +
      "the cell values and formats queued changes set to 120,000, and at most 100,000 may be queued. Approve or reject queued " +
      "changes first.");
    expect(copies(simulated, 4)).toHaveLength(4);
  });

  it("stops a replay at a copy that a rejected batch let through, before it enters its cells", () => {
    let write = filled(1, 0, rect(0, 0, 800, 25));
    let deletion = queued(2, [{ op: "deleteRows", sheetId: 0, start: 0, count: 800 }]);
    let simulated = replayed(grid(big), [write, deletion]);
    // With the rows deleted, the copies add nothing.
    let copied = queued(3, copies(simulated, 49));
    expect(replayed(grid(big), [write, deletion, copied]).cells.size).toBe(0);

    let result = replayChanges(grid(big), [write, copied]);
    expect(result).toMatchObject({
      kind: "incomplete",
      unsupported: copied,
      reason: "change 5 (duplicateSheet): it would bring the cell values and formats queued changes set to 120,000, more than " +
        "the 100,000 that may be queued",
    });
    if (result.kind === "incomplete") expect(result.partial.cells.size).toBe(20_000);
  });

  it("refuses a change to rows, columns or sheets once 50 are queued, counting the batch's own", () => {
    let inserts = (count: number) => Array.from({ length: count }, (): SheetChange => ({ op: "insertRows", sheet: "Sales", at: 1 }));
    let simulated = replayed(grid(SHEETS), [queued(1, resolveChanges(grid(SHEETS), prepareChanges(inserts(30)), minter()))]);
    expect(simulated.log).toHaveLength(30);
    let resolving = (changes: SheetChange[]) => () => resolveChanges(simulated, prepareChanges(changes), minter(101));
    expect(resolving(inserts(20))).not.toThrow();
    expect(resolving(inserts(21))).toThrow(
      `Change 21 (insertRows): ${MAX_QUEUED_STEPS} changes to rows, columns and sheets are queued already, the most ` +
      "that may be. Approve or reject queued changes first.");
    expect(resolving([{ op: "renameSheet", sheet: "It's", title: "Its" }, ...inserts(20)])).toThrow("Change 21 (insertRows)");
    // Cells may still be written, and formatted.
    expect(resolving([...inserts(20), { op: "writeCells", range: "Sales!A1", values: [[1]] }])).not.toThrow();
    expect(resolving([...inserts(20), { op: "formatCells", range: "Sales!A1", format: { bold: true } }])).not.toThrow();
  });

  it("counts the cells beside a range whose facing border formatting clears toward 100,000", () => {
    let tall = [sheet(0, "Sales", { rowCount: 20_000, columnCount: 10 })];
    // Left and right borders on a column format it and clear the borders facing it on both sides.
    let framed = (id: number, column: number, startRow: number): QueuedChange => queued(id, [{
      op: "formatCells", sheetId: 0, rect: rect(startRow, column, 10_000, 1),
      format: { borders: { left: { style: "SOLID" }, right: { style: "SOLID" } } },
    }]);
    let simulated = replayed(grid(tall), [framed(1, 1, 0), framed(2, 4, 0), framed(3, 7, 0)]);
    expect(simulated.formats.size).toBe(90_000);
    expect(() => resolveChanges(simulated, prepareChanges([{
      op: "formatCells", range: "Sales!B10001:B20000",
      format: { borders: { left: { style: "SOLID" }, right: { style: "SOLID" } } },
    }]), minter())).toThrow(
      "Change 1 (formatCells): it would bring the cell values and formats queued changes set to 120,000");
    expect(() => planSheet(simulated, framed(4, 1, 10_000).action.payload.changes))
      .toThrow("it would bring the cell values and formats queued changes set to 120,000");
    // Without borders it formats only its own cells.
    expect(() => resolveChanges(simulated, prepareChanges([
      { op: "formatCells", range: "Sales!B10001:B20000", format: { bold: true } },
    ]), minter())).not.toThrow();
  });

  it("builds a copy on every formatting change queued before it", () => {
    let pending = [
      queued(1, [{ op: "formatCells", sheetId: 0, rect: rect(0, 0), format: { bold: true } }]),
      queued(2, [{ op: "formatCells", sheetId: 7, rect: rect(0, 0), format: { italic: true } }]),
    ];
    let simulated = replayed(grid(SHEETS), pending);
    let copy = resolveChanges(simulated, prepareChanges([{ op: "duplicateSheet", sheet: "Sales" }]), minter(101));
    expect(guardAfter(simulated, pending, copy, guardCells(simulated, copy))).toEqual([1, 2]);
    // A write depends on neither.
    let write = resolveChanges(simulated, prepareChanges([
      { op: "writeCells", range: "Sales!A1", values: [[1]] },
    ]), minter());
    expect(guardAfter(simulated, pending, write, guardCells(simulated, write))).toEqual([]);
  });

  it("counts every cell a write or clear enters toward 100,000, but not one already entered", () => {
    let full = [sheet(0, "Sales", { rowCount: 4000, columnCount: 25 }), sheet(7, "It's", { index: 1 })];
    let simulated = replayed(grid(full), [filled(1, 0, rect(0, 0, 4000, 25))]);
    expect(simulated.cells.size).toBe(100_000);
    let resolving = (changes: SheetChange[]) => () => resolveChanges(simulated, prepareChanges(changes), minter(101));
    expect(resolving([{ op: "writeCells", range: "'It''s'!A1", values: [[1]] }])).toThrow(
      "Change 1 (writeCells): it would bring the cell values and formats queued changes set to 100,001, and at most 100,000 " +
      "may be queued. Approve or reject queued changes first.");
    expect(resolving([{ op: "clearRange", range: "'It''s'!A1:B2" }])).toThrow(
      "Change 1 (clearRange): it would bring the cell values and formats queued changes set to 100,004");
    expect(resolving([{ op: "writeCells", range: "Sales!A1:B2", values: [[1, 2], [3, 4]] }])).not.toThrow();
    // A copy of a sheet with nothing queued adds nothing.
    expect(resolving([{ op: "duplicateSheet", sheet: "It's" }])).not.toThrow();
    // Formatting a cell counts as well, even one whose value is queued.
    expect(resolving([{ op: "formatCells", range: "Sales!A1", format: { bold: true } }])).toThrow(
      "Change 1 (formatCells): it would bring the cell values and formats queued changes set to 100,001");
    expect(() => planSheet(simulated, [{ op: "clearRange", sheetId: 7, rect: rect(0, 0) }]))
      .toThrow(new ChangeConflict("change 1 (clearRange): it would bring the cell values and formats queued changes set to " +
        "100,001, more than the 100,000 that may be queued"));
  });

  it("indexes entries by sheet only for changes that need them, once per grid", () => {
    let pending = [filled(1, 0, rect(0, 0, 80, 25)), filled(2, 7, rect(0, 0, 100, 26))];
    let keys = vi.spyOn(Map.prototype, "keys");
    try {
      let simulated = replayed(grid(big), [...pending, filled(3, 0, rect(100, 0, 10, 10))]);
      let planned = resolveChanges(simulated, prepareChanges([
        { op: "writeCells", range: "Sales!A1:B1", values: [[1, 2]] },
        { op: "clearRange", range: "'It''s'!A1:C3" },
      ]), minter());
      planSheet(simulated, planned);
      guardAfter(simulated, pending, planned, guardCells(simulated, planned));
      expect(keys).not.toHaveBeenCalled();

      planSheet(simulated, copies(simulated, 3));
      expect(keys).toHaveBeenCalled();
      keys.mockClear();
      planSheet(simulated, [
        { op: "duplicateSheet", sheetId: 0, newSheetId: 101, title: "A", index: 2 },
        { op: "deleteRows", sheetId: 7, start: 0, count: 5 },
        { op: "deleteSheet", sheetId: 101, rowCount: 1000, columnCount: 26 },
      ]);
      // Once for the entered values and once for the formats.
      expect(keys).toHaveBeenCalledTimes(2);
    } finally {
      keys.mockRestore();
    }
  });

  it("copies only its original's entries, never another sheet's nor those it adds", () => {
    let pending = [filled(1, 0, rect(0, 0, 80, 25)), filled(2, 7, rect(0, 0, 100, 26))];
    let simulated = replayed(grid(big), pending);
    let planned = copies(simulated, 20);
    expect(guardAfter(simulated, pending, planned, guardCells(simulated, planned))).toEqual([1]);

    let split = vi.spyOn(String.prototype, "split");
    let next: Grid;
    let keysSplit: string[];
    try {
      next = planSheet(simulated, planned).grid;
      keysSplit = split.mock.calls.flatMap(([separator], i) =>
        String(separator) === ":" ? [String(split.mock.contexts[i])] : []);
    } finally {
      split.mockRestore();
    }
    expect(next.cells.size).toBe(2_000 + 2_600 + 20 * 2_000);
    // Each copy parses the key of each of Sales's 2,000 entries once, and no other.
    expect(keysSplit).toHaveLength(20 * 2_000);
    expect(keysSplit.every(key => key.startsWith("0:"))).toBe(true);
  });
});

/** A range of sheet `sheetId` protected from the connected account unless `fields` say otherwise. */
function protection(sheetId: number, area: SheetArea["rect"], fields: Partial<SheetProtection> = {}): SheetProtection {
  return { area: { sheetId, rect: area }, unprotected: [], requestingUserCanEdit: false, warningOnly: false, ...fields };
}

describe("Sheets protected ranges", () => {
  let metadata = {
    sheets: SHEETS,
    protectedRanges: [
      protection(0, rect(0, 0, 2, 2), { unprotected: [{ sheetId: 0, rect: rect(1, 1) }] }),
      protection(7, { startRow: 0, endRow: Infinity, startColumn: 0, endColumn: Infinity }, { requestingUserCanEdit: true }),
    ],
  };
  let check = (changes: SheetChange[], base: Grid = grid(SHEETS)) => () =>
    checkProtections(metadata, base, resolveChanges(base, prepareChanges(changes), minter(101)));

  it("refuses writing a cell the account may not edit, but not one the range leaves editable", () => {
    expect(check([{ op: "clearRange", range: "Sales!B1:C1" }]))
      .toThrow("Change 1 (clearRange): B1 is in the protected range Sales!A1:B2, which the connected account may not edit.");
    expect(check([{ op: "clearRange", range: "Sales!B2:C3" }])).not.toThrow();
    expect(check([{ op: "clearRange", range: "'It''s'!A1:Z9" }])).not.toThrow();
  });

  it("refuses formatting a cell the account may not edit, as it refuses writing one", () => {
    expect(check([{ op: "formatCells", range: "Sales!A2", format: { bold: true } }]))
      .toThrow("Change 1 (formatCells): A2 is in the protected range Sales!A1:B2, which the connected account may not edit.");
    expect(check([{ op: "formatCells", range: "Sales!B2:F20", format: { bold: true } }])).not.toThrow();
  });

  it("checks the cells Google holds, so cells of rows queued changes insert are not protected", () => {
    let inserted = planSheet(grid(SHEETS), [{ op: "insertRows", sheetId: 0, start: 0, count: 1 }]).grid;
    expect(check([{ op: "clearRange", range: "Sales!A1" }], inserted)).not.toThrow();
    expect(check([{ op: "clearRange", range: "Sales!A2" }], inserted))
      .toThrow("Change 1 (clearRange): A2 is in the protected range Sales!A1:B2");
  });

  it("refuses any change to the rows, columns or tab of a sheet holding such a range", () => {
    let message = 'Change 1 (renameSheet): "Sales" holds the protected range Sales!A1:B2, which the connected ' +
      "account may not edit, so its rows, columns and tab cannot be changed.";
    expect(check([{ op: "renameSheet", sheet: "Sales", title: "X" }])).toThrow(message);
    expect(check([{ op: "insertRows", sheet: "Sales", at: 21 }])).toThrow("Change 1 (insertRows): \"Sales\" holds");
    expect(check([{ op: "duplicateSheet", sheet: "Sales" }])).toThrow("Change 1 (duplicateSheet): \"Sales\" holds");
    expect(check([{ op: "deleteRows", sheet: "It's", at: 1 }, { op: "addSheet", title: "Q4" }])).not.toThrow();
    let unbounded = { ...metadata, protectedRanges: [protection(7, { startRow: 0, endRow: Infinity, startColumn: 0, endColumn: 3 })] };
    expect(() => checkProtections(unbounded, grid(SHEETS), [{ op: "deleteSheet", sheetId: 7, rowCount: 100, columnCount: 26 }]))
      .toThrow('Change 1 (deleteSheet): "It\'s" holds a protected range of "It\'s"');
  });
});

describe("Entered values", () => {
  it("enters input starting with = as a formula, and any other input as itself", () => {
    expect(enteredOf("=order 123")).toEqual({ formula: "=order 123" });
    expect(enteredOf("#REF!")).toBe("#REF!");
    expect(enteredOf("'=quoted")).toBe("'=quoted");
    expect([enteredOf(5), enteredOf(false), enteredOf(null)]).toEqual([5, false, null]);
  });
});
