import { describe, expect, it } from "vitest";
import type { WorksheetContent } from "../src/types";
import { checkShape, formatRange, parseRange, withPendingCells } from "../src/workbook-ranges";

describe("parseRange", () => {
  it("reads ranges and single cells, in any corner order and case", () => {
    expect(parseRange("B2:D4")).toEqual({ firstRow: 1, firstColumn: 1, lastRow: 3, lastColumn: 3 });
    expect(parseRange("d4:b2")).toEqual(parseRange("B2:D4"));
    expect(parseRange("$A$10")).toEqual({ firstRow: 9, firstColumn: 0, lastRow: 9, lastColumn: 0 });
    expect(formatRange(parseRange("AA1:XFD1048576"))).toBe("AA1:XFD1048576");
    expect(formatRange(parseRange("c3"))).toBe("C3");
  });

  it("refuses what isn't a range on one worksheet, saying what to pass", () => {
    expect(() => parseRange("Sheet1!B2:C3")).toThrow(/Pass the worksheet separately from the range: "B2:C3"/);
    for (const bad of ["", "B", "2", "B2:C3:D4", "A0", "XFE1", "A1048577", "B2-C3", "R1C1"]) {
      expect(() => parseRange(bad), bad).toThrow(/isn't a range of cells/);
    }
  });
});

describe("checkShape", () => {
  it("requires one row per row and one value per column", () => {
    const range = parseRange("B2:C3");
    expect(() => checkShape(range, [[1, 2], [3, 4]])).not.toThrow();
    expect(() => checkShape(range, [[1, 2]])).toThrow("B2:C3 is 2 rows by 2 columns, but values has 1 row.");
    expect(() => checkShape(range, [[1, 2], [3]])).toThrow("but row 2 of values has 1 value.");
  });
});

describe("withPendingCells", () => {
  const sheet: WorksheetContent = {
    name: "Budget", address: "Budget!A1:B2", truncated: false,
    values: [["Item", "Cost"], ["Rent", 1200]],
    formulas: [["Item", "Cost"], ["Rent", 1200]],
  };

  it("shows a change inside what was read in place", () => {
    const shown = withPendingCells(sheet, [{ address: "B2", values: [[1300]] }]);
    expect(shown.address).toBe("Budget!A1:B2");
    expect(shown.values).toEqual([["Item", "Cost"], ["Rent", 1300]]);
  });

  it("keeps a range the agent asked for, showing only the changed cells inside it", () => {
    const shown = withPendingCells(sheet, [
      { address: "B2:C3", values: [[1300, 1], [2, 3]] }, { address: "Z100", values: [[9]] },
    ], { within: true });
    expect(shown).toEqual({ ...sheet, values: [["Item", "Cost"], ["Rent", 1300]], formulas: [["Item", "Cost"], ["Rent", 1300]] });
  });

  it("grows the range for a change outside it, later changes winning", () => {
    const shown = withPendingCells(sheet, [
      { address: "A3:B3", values: [["Total", "=SUM(B2:B2)"]] },
      { address: "B3", values: [["=SUM(B2)"]] },
    ]);
    expect(shown.address).toBe("Budget!A1:B3");
    expect(shown.formulas).toEqual([["Item", "Cost"], ["Rent", 1200], ["Total", "=SUM(B2)"]]);
    expect(shown.values[2]).toEqual(["Total", "=SUM(B2)"]);
  });

  it("leaves out a change that would grow the range past the read's budget, and says the sheet is truncated", () => {
    const far = { address: "CV100", values: [["far"]] };
    const near = { address: "A3", values: [["Total"]] };
    const bounded = withPendingCells(sheet, [far, near], { maxCells: 10 });
    expect(bounded.address).toBe("Budget!A1:B3");
    expect(bounded.values[2]).toEqual(["Total", null]);
    expect(bounded.truncated).toBe(true);
    const roomy = withPendingCells(sheet, [far, near], { maxCells: 10_000 });
    expect(roomy.address).toBe("Budget!A1:CV100");
    expect(roomy.truncated).toBe(false);
    // Nothing fits: the read stands as it was.
    const empty: WorksheetContent = { name: "New", address: "", values: [], formulas: [], truncated: false };
    expect(withPendingCells(empty, [{ address: "A1:D5", values: Array.from({ length: 5 }, () => [1, 2, 3, 4]) }], { maxCells: 4 })).toEqual({ ...empty, truncated: true });
  });

  it("fills an empty worksheet with only the change", () => {
    const empty: WorksheetContent = { name: "New", address: "", values: [], formulas: [], truncated: false };
    const shown = withPendingCells(empty, [{ address: "C2:D2", values: [[1, null]] }]);
    expect(shown.address).toBe("C2:D2");
    expect(shown.values).toEqual([[1, null]]);
  });
});
