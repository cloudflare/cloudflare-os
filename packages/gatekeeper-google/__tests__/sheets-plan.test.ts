import { describe, expect, it } from "vitest";
import { prepareChanges } from "../src/sheets-input";
import { guardDigest, planSheet, resolveChanges } from "../src/sheets-plan";
import type { SpreadsheetCellValue } from "../src/sheets-read-types";
import type { PlannedChange, SheetMeta } from "../src/sheets-simulation";
import type { SheetChange } from "../src/sheets-types";
import { ChangeConflict } from "../src/slides-text";
import { TYPED_INPUT, WHITESPACE_DRIFT, grid, rect, sheet } from "./sheets-fixture";

const SHEETS = [sheet(0, "Sales"), sheet(7, "It's", { index: 1, rowCount: 100, columnCount: 26 })];

/** Plans `changes` later, for `toThrow`. */
const refused = (changes: SheetChange[]) => () => plan(changes);

/** Plans `changes` over a spreadsheet of `SHEETS`, as `updateSheet()` would queue them. */
function plan(changes: SheetChange[]) {
  let planned = resolveChanges(grid(SHEETS), prepareChanges(changes));
  return { planned, ...planSheet(grid(SHEETS), planned) };
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

  it("enters each cell in the next grid, a clear as null", () => {
    let { grid: next } = plan([
      { op: "writeCells", range: "Sales!A1:B1", values: [[1, "=A1"]] },
      { op: "clearRange", range: "Sales!B1" },
    ]);
    expect([...next.cells]).toEqual([["0:0:0", 1], ["0:0:1", null]]);
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
      .toThrow('Change 1 (writeCells): "Sales" has 20 rows and 6 columns, so A21 is outside it.');
    expect(refused([{ op: "clearRange", range: "Sales!A19:B25" }])).toThrow("so A21 is outside it.");
    expect(refused([{ op: "clearRange", range: "Sales!E1:H2" }])).toThrow("so G1 is outside it.");
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

describe("Sheets apply guard", () => {
  let changes: PlannedChange[] = [
    { op: "writeCells", sheetId: 0, rect: rect(0, 0, 1, 2), values: [[1, 2]] },
    { op: "clearRange", sheetId: 7, rect: rect(2, 2, 2, 1) },
  ];
  let [stored, later] = WHITESPACE_DRIFT;
  let entered: SpreadsheetCellValue[][][] = [[["old", stored]], [[3], [null]]];
  let digest = (overrides: { sheets?: SheetMeta[]; entered?: SpreadsheetCellValue[][][] } = {}) =>
    guardDigest(overrides.sheets ?? SHEETS, changes, overrides.entered ?? entered);

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
    // A sheet no change writes is not part of it.
    expect(await digest({ sheets: [...SHEETS, sheet(9, "Other")] })).toBe(base);
  });
});
