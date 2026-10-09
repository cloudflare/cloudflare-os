import { describe, expect, it } from "vitest";
import { prepareChanges } from "../src/sheets-input";
import type { SheetChange } from "../src/sheets-types";
import { rect } from "./sheets-fixture";

const write = (range: string, values: unknown[][]) => ({ op: "writeCells", range, values }) as SheetChange;

function refusal(changes: SheetChange[]): string {
  try {
    prepareChanges(changes);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("prepareChanges accepted the changes");
}

describe("Sheets change input", () => {
  it("prepares the sheet each change names and its cells", () => {
    expect(prepareChanges([
      write("'Sales 2026'!B3:C4", [["=SUM(A1:A2)", 2], [true, null]]),
      { op: "clearRange", range: "costs!A1" },
    ])).toEqual([
      { op: "writeCells", sheet: "Sales 2026", rect: rect(2, 1, 2, 2), values: [["=SUM(A1:A2)", 2], [true, null]] },
      { op: "clearRange", sheet: "costs", rect: rect(0, 0) },
    ]);
  });

  it("drops what a change does not declare", () => {
    let prepared = prepareChanges([
      { op: "clearRange", range: "Sales!A1", values: [[1]], sheetId: 9 } as SheetChange,
      { op: "writeCells", range: "Sales!B1", values: [[1]], sheet: "Costs", rect: rect(5, 5) } as SheetChange,
    ]);
    expect(prepared).toEqual([
      { op: "clearRange", sheet: "Sales", rect: rect(0, 0) },
      { op: "writeCells", sheet: "Sales", rect: rect(0, 1), values: [[1]] },
    ]);
  });

  it("refuses no changes, too many and an unknown op", () => {
    expect(refusal([])).toBe("Make between 1 and 50 changes at a time.");
    expect(refusal(Array.from({ length: 51 }, () => ({ op: "clearRange", range: "Sales!A1" }))))
      .toBe("Make between 1 and 50 changes at a time.");
    expect(refusal([{ op: "insertRows", range: "Sales!A1" } as unknown as SheetChange]))
      .toBe("Change 1 (insertRows): op must be writeCells or clearRange.");
  });

  it("refuses a range that does not name its sheet, or is unbounded or invalid", () => {
    expect(refusal([{ op: "clearRange", range: "A1:B2" }]))
      .toBe("Change 1 (clearRange): range \"A1:B2\" does not name its sheet; name it as in 'Sheet name'!A1:C3.");
    expect(refusal([{ op: "clearRange", range: "Sales!A1" }, { op: "clearRange", range: "Sales!A:C" }]))
      .toMatch(/^Change 2 \(clearRange\): Invalid or unbounded A1 range "Sales!A:C"/);
    expect(refusal([{ op: "clearRange", range: "Sales!B2:A1" }]))
      .toMatch(/^Change 1 \(clearRange\): A1 range "Sales!B2:A1" must run from its top-left cell/);
  });

  it("refuses values not exactly the range's shape", () => {
    let message = "Change 1 (writeCells): values must be 2 rows of 3 values each, the shape of Sales!A1:C2.";
    expect(refusal([write("Sales!A1:C2", [[1, 2, 3]])])).toBe(message);
    expect(refusal([write("Sales!A1:C2", [[1, 2, 3], [4, 5]])])).toBe(message);
    expect(refusal([write("Sales!A1:C2", [[1, 2, 3], [4, 5, 6, 7]])])).toBe(message);
    expect(refusal([write("Sales!A1", [[1], [2]])]))
      .toBe("Change 1 (writeCells): values must be 1 row of 1 value each, the shape of Sales!A1.");
  });

  it("refuses more than 10,000 cells in a change and 20,000 in a batch", () => {
    expect(refusal([{ op: "clearRange", range: "Sales!A1:A10001" }]))
      .toBe("Change 1 (clearRange): Sales!A1:A10001 has 10,001 cells; a change may address at most 10,000.");
    let full = { op: "clearRange", range: "Sales!A1:J1000" } as const;
    expect(prepareChanges([full, full])).toHaveLength(2);
    expect(refusal([full, full, { op: "clearRange", range: "Sales!A1" }]))
      .toBe("These changes address 20,001 cells; one batch may address at most 20,000.");
  });

  it("refuses values Google cannot hold as given", () => {
    expect(refusal([write("Sales!A1:B1", [[1, Number.NaN]])]))
      .toBe("Change 1 (writeCells): the value for B1 is not a finite number.");
    expect(refusal([write("Sales!C5", [[Infinity]])]))
      .toBe("Change 1 (writeCells): the value for C5 is not a finite number.");
    expect(refusal([write("Sales!A1", [[""]])]))
      .toBe("Change 1 (writeCells): the value for A1 is an empty string; use null to clear a cell.");
    expect(refusal([write("Sales!A1", [[undefined]])]))
      .toBe("Change 1 (writeCells): the value for A1 is not a string, number, boolean or null.");
    expect(refusal([write("Sales!A2", [["x".repeat(50_001)]])]))
      .toBe("Change 1 (writeCells): the value for A2 has 50,001 characters; a cell holds at most 50,000.");
    expect(refusal([write("Sales!A2", [[`=${"1".repeat(50_000)}`]])]))
      .toBe("Change 1 (writeCells): the value for A2 has 50,001 characters; a cell holds at most 50,000.");
    expect(prepareChanges([write("Sales!A2", [["x".repeat(50_000)]])])).toHaveLength(1);
  });

  it("refuses each formula that reaches outside the spreadsheet, naming it and why", () => {
    expect(refusal([write("Sales!B2", [['=IMPORTRANGE("abc", "A1")']])]))
      .toBe("Change 1 (writeCells): the formula for B2 uses IMPORTRANGE, which cannot be used " +
        "because it reads another spreadsheet.");
    for (let name of ["importdata", "ImportHtml", "IMPORTXML", "importFeed", "image"]) {
      expect(refusal([write("Sales!A1:B1", [[1, `=SUM(1, ${name}("https://example.com"))`]])]))
        .toBe(`Change 1 (writeCells): the formula for B1 uses ${name.toUpperCase()}, which cannot be ` +
          "used because it makes Google fetch a URL.");
    }
    // Text that is not a formula is never a call.
    expect(prepareChanges([write("Sales!A1", [['IMAGE("https://example.com")']])])).toHaveLength(1);
  });
});
