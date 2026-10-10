import { describe, expect, it } from "vitest";
import type { SheetArea, SheetProtection } from "../src/sheets-api";
import { compactFormula } from "../src/sheets-formula";
import { prepareChanges } from "../src/sheets-input";
import {
  checkProtections, guardAfter, guardCells, guardDigest, guardedSheets, guardFits, guardOf, planSheet,
  resolveChanges, sheetLabels,
} from "../src/sheets-plan";
import type { SpreadsheetCellValue } from "../src/sheets-read-types";
import {
  replayChanges, type Grid, type PlannedChange, type QueuedChange, type SheetBatch, type SheetMeta,
} from "../src/sheets-simulation";
import type { SheetChange } from "../src/sheets-types";
import { ChangeConflict } from "../src/slides-text";
import { NEW_SHEET_SIZE, TYPED_INPUT, WHITESPACE_DRIFT, grid, rect, sheet } from "./sheets-fixture";

const SHEETS = [sheet(0, "Sales"), sheet(7, "It's", { index: 1, rowCount: 100, columnCount: 26 })];

/** A mint handing out `ids` in turn, then 999. */
function minter(...ids: number[]): () => number {
  let left = [...ids];
  return () => left.shift() ?? 999;
}

/** Resolves `changes` over a spreadsheet of `sheets`, as `updateSheet()` would queue them. */
function resolve(changes: SheetChange[], sheets: SheetMeta[] = SHEETS, mint = minter(101, 102, 103)) {
  return resolveChanges(grid(sheets), prepareChanges(changes), mint);
}

/** Plans `changes` over a spreadsheet of `SHEETS`, as `updateSheet()` would queue them. */
function plan(changes: SheetChange[]) {
  let { planned } = resolve(changes);
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
      kind: "updateSheet",
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
});

describe("Sheets structural change requests", () => {
  it("sends each op in the shape Google accepts, filling in defaults and minting sheet IDs", () => {
    let { planned, refs } = resolve([
      { op: "addSheet", title: "Q4", ref: "q4" },
      { op: "renameSheet", sheetId: "q4", title: "Q4 2026" },
      { op: "duplicateSheet", sheetId: 0 },
      { op: "insertRows", sheetId: 0, at: 21, count: 2 },
      { op: "insertColumns", sheetId: 0, at: "A" },
      { op: "deleteRows", sheetId: 7, at: 5, count: 2 },
      { op: "deleteColumns", sheetId: 7, at: "C" },
      { op: "deleteSheet", sheetId: "q4" },
    ]);
    expect(refs).toEqual({ q4: 101 });
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
    let { planned } = resolve([
      { op: "addSheet", title: "Top", index: 0, rowCount: 5, columnCount: 2 },
      { op: "duplicateSheet", sheetId: 7, title: "Mine", index: 0 },
    ]);
    expect(planned).toEqual([
      { op: "addSheet", sheetId: 101, title: "Top", index: 0, rowCount: 5, columnCount: 2 },
      { op: "duplicateSheet", sheetId: 7, newSheetId: 102, title: "Mine", index: 0 },
    ]);
  });

  it("mints only IDs no sheet has, those the batch adds included", () => {
    let { planned, refs } = resolve([
      { op: "addSheet", title: "A", ref: "a" },
      { op: "duplicateSheet", sheetId: "a", ref: "b" },
    ], SHEETS, minter(0, 7, 55, 55, 56));
    expect(refs).toEqual({ a: 55, b: 56 });
    expect(planned.map(change => change.op === "duplicateSheet" ? change.newSheetId : change.sheetId)).toEqual([55, 56]);
    expect(() => resolveChanges(grid(SHEETS), prepareChanges([{ op: "addSheet", title: "A" }]), () => 0))
      .toThrow("No unused sheet ID could be chosen.");
  });

  it("addresses each change to the spreadsheet as the changes before it leave it", () => {
    let { planned, requests, grid: next } = plan([
      { op: "insertRows", sheetId: 0, at: 1, count: 2 },
      { op: "writeCells", range: "Sales!A1:A3", values: [[1], [2], [3]] },
    ]);
    expect(planned[1]).toEqual({ op: "writeCells", sheetId: 0, rect: rect(0, 0, 3), values: [[1], [2], [3]] });
    expect(requests[1]).toMatchObject({ updateCells: { range: { sheetId: 0, startRowIndex: 0, endRowIndex: 3 } } });
    // The written cells are the two new rows and the row that was first.
    expect([...next.cells.keys()]).toEqual(["0:n0.0:b0", "0:n0.1:b0", "0:b0:b0"]);
    expect(next.cells.get("0:b0:b0")).toEqual({ input: 3, at: 1, by: 0 });

    let renamed = resolve([
      { op: "renameSheet", sheetId: 0, title: "Sales 2026" },
      { op: "writeCells", range: "'sales 2026'!A1", values: [["=SUM('SALES 2026'!b1:b2)"]] },
    ]).planned;
    expect(renamed[1]).toEqual({ op: "writeCells", sheetId: 0, rect: rect(0, 0), values: [["=SUM('Sales 2026'!B1:B2)"]] });
    expect(refused([
      { op: "renameSheet", sheetId: 0, title: "Sales 2026" },
      { op: "clearRange", range: "Sales!A1" },
    ])).toThrow('Change 2 (clearRange): the spreadsheet has no sheet named "Sales".');

    let added = resolve([
      { op: "addSheet", title: "Q4", rowCount: 5, columnCount: 2 },
      { op: "writeCells", range: "Q4!B5", values: [[1]] },
    ]).planned;
    expect(added[1]).toEqual({ op: "writeCells", sheetId: 101, rect: rect(4, 1), values: [[1]] });
    expect(refused([{ op: "addSheet", title: "Q4", rowCount: 5, columnCount: 2 }, { op: "clearRange", range: "Q4!C1" }]))
      .toThrow('Change 2 (clearRange): "Q4" has 5 rows and 2 columns, so C1 is outside it.');
  });

  it("refuses an unknown sheet, and a ref to a sheet an earlier change deletes", () => {
    expect(refused([{ op: "deleteSheet", sheetId: 3 }]))
      .toThrow("Change 1 (deleteSheet): the spreadsheet has no sheet with ID 3. Call getSpreadsheet() for sheet IDs.");
    expect(refused([
      { op: "addSheet", title: "A", ref: "a" },
      { op: "deleteSheet", sheetId: "a" },
      { op: "renameSheet", sheetId: "a", title: "B" },
    ])).toThrow('Change 3 (renameSheet): the sheet ref "a" names is deleted by an earlier change.');
  });

  it("refuses a title another sheet has, ignoring case", () => {
    expect(refused([{ op: "addSheet", title: "sales" }])).toThrow(`Change 1 (addSheet): ${taken("Sales")}`);
    expect(refused([{ op: "renameSheet", sheetId: 7, title: "SALES" }])).toThrow(`Change 1 (renameSheet): ${taken("Sales")}`);
    expect(refused([{ op: "duplicateSheet", sheetId: 0 }, { op: "duplicateSheet", sheetId: 0 }]))
      .toThrow(`Change 2 (duplicateSheet): ${taken("Copy of Sales")}`);
    expect(refused([{ op: "duplicateSheet", sheetId: 0, title: "IT'S" }])).toThrow(taken("It's"));
    // A sheet may change the case of its own title, and a title a rename frees may be taken.
    expect(refused([{ op: "renameSheet", sheetId: 0, title: "SALES" }])).not.toThrow();
    expect(refused([{ op: "renameSheet", sheetId: 0, title: "Old" }, { op: "addSheet", title: "Sales" }])).not.toThrow();
    expect(refused([{ op: "duplicateSheet", sheetId: 0 }], [sheet(0, "x".repeat(95))]))
      .toThrow(`Change 1 (duplicateSheet): "Copy of ${"x".repeat(95)}" would be over 100 characters; give the copy a title.`);
  });

  it("refuses deleting the last visible sheet, or every row or column", () => {
    let hidden = [sheet(0, "Sales"), sheet(1, "Hidden", { hidden: true })];
    expect(refused([{ op: "deleteSheet", sheetId: 0 }], hidden))
      .toThrow('Change 1 (deleteSheet): "Sales" is the spreadsheet\'s only visible sheet, and a spreadsheet keeps at least one.');
    expect(refused([{ op: "deleteSheet", sheetId: 1 }], hidden)).not.toThrow();
    expect(refused([{ op: "deleteSheet", sheetId: 0 }, { op: "deleteSheet", sheetId: 7 }]))
      .toThrow('Change 2 (deleteSheet): "It\'s" is the spreadsheet\'s only visible sheet');
    expect(refused([{ op: "deleteRows", sheetId: 0, at: 1, count: 20 }]))
      .toThrow('Change 1 (deleteRows): deleting rows 1 to 20 would delete every row of "Sales", and a sheet keeps at least one.');
    expect(refused([{ op: "deleteColumns", sheetId: 0, at: "A", count: 6 }]))
      .toThrow('Change 1 (deleteColumns): deleting columns A to F would delete every column of "Sales"');
    expect(refused([{ op: "deleteRows", sheetId: 0, at: 1, count: 19 }])).not.toThrow();
  });

  it("refuses leaving only frozen rows or columns, and more columns than a sheet holds", () => {
    let frozen = [sheet(0, "Sales", { frozenRowCount: 2, frozenColumnCount: 1 })];
    expect(refused([{ op: "deleteRows", sheetId: 0, at: 3, count: 18 }], frozen))
      .toThrow('Change 1 (deleteRows): deleting rows 3 to 20 would leave only the 2 frozen rows of "Sales"');
    expect(refused([{ op: "deleteRows", sheetId: 0, at: 3, count: 17 }], frozen)).not.toThrow();
    expect(refused([{ op: "deleteColumns", sheetId: 0, at: "B", count: 5 }], frozen))
      .toThrow('would leave only the 1 frozen column of "Sales"');
    let wide = [sheet(0, "Sales", { rowCount: 1, columnCount: 18_278 })];
    expect(refused([{ op: "insertColumns", sheetId: 0, at: "A" }], wide))
      .toThrow('Change 1 (insertColumns): "Sales" has 18,278 columns, and a sheet holds at most 18,278.');
  });

  it("refuses inserting or deleting rows and columns the sheet does not have", () => {
    expect(refused([{ op: "insertRows", sheetId: 0, at: 22 }]))
      .toThrow('Change 1 (insertRows): "Sales" has 20 rows, so at must be from 1 to 21.');
    expect(refused([{ op: "insertColumns", sheetId: 0, at: "H" }]))
      .toThrow('Change 1 (insertColumns): "Sales" has 6 columns, so at must be a column from A to G.');
    expect(refused([{ op: "deleteRows", sheetId: 0, at: 19, count: 4 }]))
      .toThrow('Change 1 (deleteRows): "Sales" has 20 rows, so rows 19 to 22 cannot be deleted.');
    expect(refused([{ op: "deleteColumns", sheetId: 0, at: "G" }]))
      .toThrow('Change 1 (deleteColumns): "Sales" has 6 columns, so column G cannot be deleted.');
    expect(refused([{ op: "insertRows", sheetId: 0, at: 1, count: 5 }, { op: "deleteRows", sheetId: 0, at: 25 }]))
      .not.toThrow();
  });

  it("refuses an index past the last sheet, and a spreadsheet of more than 10,000,000 cells", () => {
    expect(refused([{ op: "addSheet", title: "A", index: 3 }]))
      .toThrow("Change 1 (addSheet): index 3 is past the end; the spreadsheet has 2 sheets, so index may be at most 2.");
    expect(refused([{ op: "addSheet", title: "A", index: 2 }])).not.toThrow();
    expect(refused([{ op: "addSheet", title: "A", rowCount: 10_000_000, columnCount: 1 }]))
      .toThrow("Change 1 (addSheet): the spreadsheet would hold 10,002,720 cells; Google Sheets holds at most 10,000,000.");
    let big = [sheet(0, "Big", { rowCount: 9_999_000, columnCount: 1 })];
    expect(refused([{ op: "insertRows", sheetId: 0, at: 1, count: 1000 }], big)).not.toThrow();
    expect(refused([{ op: "insertColumns", sheetId: 0, at: "B" }], big)).toThrow("would hold 19,998,000 cells");
    expect(refused([{ op: "duplicateSheet", sheetId: 0 }], big)).toThrow("would hold 19,998,000 cells");
  });

  it("refuses deleting a sheet of more than 50,000 cells", () => {
    let sheets = [sheet(0, "Sales"), sheet(1, "Big", { index: 1, rowCount: 1000, columnCount: 51 })];
    expect(refused([{ op: "deleteSheet", sheetId: 1 }], sheets)).toThrow(
      'Change 1 (deleteSheet): "Big" has 51,000 cells, more than the 50,000 a sheet deleted here may have; ' +
      "delete it in Google Sheets.");
    expect(refused([{ op: "deleteColumns", sheetId: 1, at: "A" }, { op: "deleteSheet", sheetId: 1 }], sheets))
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
  let entered: SpreadsheetCellValue[][][] = [[["old", stored]], [[3], [null]]];
  let digest = (overrides: { sheets?: SheetMeta[]; entered?: SpreadsheetCellValue[][][] } = {}) =>
    guardDigest(overrides.sheets ?? SHEETS, { sheetIds: [0, 7], cells }, overrides.entered ?? entered);

  it("is a hex SHA-256, unchanged by whitespace Google drops from a formula", async () => {
    let base = await digest();
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(await digest({ entered: [[["old", later]], [[3], [null]]] })).toBe(base);
    // A row Google trims of trailing blanks reads the same as one padded with them.
    expect(await digest({ entered: [[["old", stored]], [[3]]] })).toBe(base);
    expect(await digest({ entered: [[["old", stored]], [[3], [""]]] })).toBe(base);
    // Zero and false are values, not blanks.
    expect(await digest({ entered: [[["old", stored]], [[3], [0]]] })).not.toBe(base);
    expect(await digest({ entered: [[["old", stored]], [[3], [false]]] })).not.toBe(base);
  });

  it("changes with a value, a sheet's title or its size", async () => {
    let base = await digest();
    expect(await digest({ entered: [[["new", stored]], [[3], [null]]] })).not.toBe(base);
    expect(await digest({ entered: [[["old", "=Sales!$D$4 + 1"]], [[3], [null]]] })).not.toBe(base);
    expect(await digest({ entered: [[["old", stored]], [["3"], [null]]] })).not.toBe(base);
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
    expect(guard).toEqual({ sheetIds: [0, 7], cells: [{ sheetId: 7, rect: rect(2, 2, 2, 1) }, { sheetId: 0, rect: rect(0, 0, 1, 2) }] });
    // The bytes hashed are those the guard was taken over when it was queued.
    let bytes = new TextEncoder().encode(JSON.stringify([
      [[0, "Sales", 20, 6], [7, "It's", 100, 26]], [[3, null], ["old", compactFormula(stored)]],
    ]));
    let expected = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      byte => byte.toString(16).padStart(2, "0")).join("");
    expect(await guardDigest(SHEETS, guard, [[[3]], [["old", stored]]])).toBe(expected);
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
  return guardCells(grid(sheets), resolve(changes, sheets).planned);
}

describe("Sheets guarded cells", () => {
  it("maps a write back through the batch's own inserted lines, leaving them out", () => {
    expect(cellsOf([
      { op: "insertRows", sheetId: 0, at: 3, count: 2 },
      { op: "clearRange", range: "Sales!A1:A6" },
    ])).toEqual([{ sheetId: 0, rect: rect(0, 0, 4) }]);
    expect(cellsOf([
      { op: "insertColumns", sheetId: 0, at: "B" },
      { op: "clearRange", range: "Sales!A1:C1" },
    ])).toEqual([{ sheetId: 0, rect: rect(0, 0, 1, 2) }]);
    // Lines a queued change inserted before the batch are lines the batch overwrites.
    let queuedInsert = planSheet(grid(SHEETS), [{ op: "insertRows", sheetId: 0, start: 0, count: 1 }]).grid;
    let { planned } = resolveChanges(queuedInsert, prepareChanges([
      { op: "insertRows", sheetId: 0, at: 2 },
      { op: "clearRange", range: "Sales!A1:A3" },
    ]), minter());
    expect(guardCells(queuedInsert, planned)).toEqual([{ sheetId: 0, rect: rect(0, 0, 2) }]);
  });

  it("covers a deleted band across the sheet, and a deleted sheet whole", () => {
    expect(cellsOf([{ op: "deleteRows", sheetId: 0, at: 5, count: 2 }]))
      .toEqual([{ sheetId: 0, rect: rect(4, 0, 2, 6) }]);
    expect(cellsOf([{ op: "deleteColumns", sheetId: 0, at: "B" }])).toEqual([{ sheetId: 0, rect: rect(0, 1, 20, 1) }]);
    expect(cellsOf([{ op: "deleteSheet", sheetId: 7 }])).toEqual([{ sheetId: 7, rect: rect(0, 0, 100, 26) }]);
    // A column the batch inserted and then deletes covers nothing; the one beside it does.
    expect(cellsOf([
      { op: "insertColumns", sheetId: 0, at: "A" },
      { op: "deleteColumns", sheetId: 0, at: "A", count: 2 },
    ])).toEqual([{ sheetId: 0, rect: rect(0, 0, 20, 1) }]);
  });

  it("covers nothing of sheets the batch creates, nor what changes no cell", () => {
    expect(cellsOf([
      { op: "addSheet", title: "Q4", ref: "q4" },
      { op: "clearRange", range: "Q4!A1:B2" },
      { op: "deleteRows", sheetId: "q4", at: 1 },
      { op: "duplicateSheet", sheetId: 0, ref: "copy" },
      { op: "clearRange", range: "'Copy of Sales'!A1" },
      { op: "renameSheet", sheetId: 7, title: "Other" },
      { op: "insertRows", sheetId: 7, at: 1 },
    ])).toEqual([]);
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
      { op: "deleteRows", sheetId: 0, at: 1, count: 100 }, { op: "deleteSheet", sheetId: 0 },
    ], square)).toEqual([{ sheetId: 0, rect: rect(0, 0, 200, 200) }]);
    let wide = [sheet(0, "Wide", { rowCount: 1000, columnCount: 60 })];
    expect(() => cellsOf([{ op: "deleteColumns", sheetId: 0, at: "A", count: 51 }], wide)).toThrow(
      "These changes overwrite or delete 51,000 cells that are already there; one batch may overwrite or " +
      "delete at most 50,000.");
    expect(cellsOf([{ op: "deleteColumns", sheetId: 0, at: "A", count: 50 }], wide)).toHaveLength(1);
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
    let { planned } = resolveChanges(simulated, prepareChanges(changes), minter(101));
    return guardAfter(simulated, pending, planned, guardCells(simulated, planned));
  };

  it("builds on the changes that entered what it overwrites", () => {
    expect(after([{ op: "clearRange", range: "Sales!A1:A2" }])).toEqual([1]);
    expect(after([{ op: "clearRange", range: "Sales!A1:B5" }])).toEqual([1, 3]);
    expect(after([{ op: "clearRange", range: "Sales!C1:D9" }])).toEqual([]);
    expect(after([{ op: "deleteRows", sheetId: 0, at: 5 }])).toEqual([3]);
  });

  it("builds on every change to the rows, columns or tab of a sheet it acts on", () => {
    expect(after([{ op: "clearRange", range: "'It''s'!Z99" }])).toEqual([2]);
    expect(after([{ op: "renameSheet", sheetId: 7, title: "Other" }])).toEqual([2]);
    expect(after([{ op: "addSheet", title: "Q4" }])).toEqual([]);
  });

  it("builds a batch with a formula on every structural change queued before it, on any sheet", () => {
    // Sales!D9 names It's rows as change 2 leaves them, though the batch never acts on It's.
    expect(after([{ op: "writeCells", range: "Sales!D9", values: [["='It''s'!A2"]] }])).toEqual([2]);
    expect(after([{ op: "writeCells", range: "Sales!D9", values: [[2]] }])).toEqual([]);
  });

  it("labels each sheet a batch acts on or creates by its title before the batch", () => {
    let { planned } = resolve([
      { op: "renameSheet", sheetId: 0, title: "X" },
      { op: "addSheet", title: "Q4", ref: "q4" },
      { op: "duplicateSheet", sheetId: 7 },
      { op: "clearRange", range: "Q4!A1" },
    ]);
    expect(sheetLabels(grid(SHEETS), planned)).toEqual({ 0: "Sales", 101: "Q4", 7: "It's", 102: "Copy of It's" });
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
    checkProtections(metadata, base, resolveChanges(base, prepareChanges(changes), minter(101)).planned);

  it("refuses writing a cell the account may not edit, but not one the range leaves editable", () => {
    expect(check([{ op: "clearRange", range: "Sales!B1:C1" }]))
      .toThrow("Change 1 (clearRange): B1 is in the protected range Sales!A1:B2, which the connected account may not edit.");
    expect(check([{ op: "clearRange", range: "Sales!B2:C3" }])).not.toThrow();
    expect(check([{ op: "clearRange", range: "'It''s'!A1:Z9" }])).not.toThrow();
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
    expect(check([{ op: "renameSheet", sheetId: 0, title: "X" }])).toThrow(message);
    expect(check([{ op: "insertRows", sheetId: 0, at: 21 }])).toThrow("Change 1 (insertRows): \"Sales\" holds");
    expect(check([{ op: "duplicateSheet", sheetId: 0 }])).toThrow("Change 1 (duplicateSheet): \"Sales\" holds");
    expect(check([{ op: "deleteRows", sheetId: 7, at: 1 }, { op: "addSheet", title: "Q4" }])).not.toThrow();
    let unbounded = { ...metadata, protectedRanges: [protection(7, { startRow: 0, endRow: Infinity, startColumn: 0, endColumn: 3 })] };
    expect(() => checkProtections(unbounded, grid(SHEETS), [{ op: "deleteSheet", sheetId: 7, rowCount: 100, columnCount: 26 }]))
      .toThrow('Change 1 (deleteSheet): "It\'s" holds a protected range of "It\'s"');
  });
});
