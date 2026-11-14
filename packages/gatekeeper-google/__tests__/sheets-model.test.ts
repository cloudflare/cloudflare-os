import { describe, expect, it } from "vitest";
import {
  a1Of, cellName, columnLetters, columnNumber, findSheet, intersection, parseRange, quoteSheetTitle,
  shownValue, validateRange,
} from "../src/sheets-model";
import { CANONICAL_RANGES, SHEET_TITLE_QUOTING, TYPED_INPUT, rect, sheet } from "./sheets-fixture";

describe("Sheets A1 ranges", () => {
  it("parses a range into its sheet title and zero-based, half-open cells", () => {
    expect(parseRange("'Sales 2026'!B3:D7")).toEqual({
      sheet: "Sales 2026", rect: { startRow: 2, endRow: 7, startColumn: 1, endColumn: 4 },
    });
    expect(parseRange("'It''s'!$A$1")).toEqual({ sheet: "It's", rect: rect(0, 0) });
    expect(parseRange("Sales!aa10")).toEqual({ sheet: "Sales", rect: rect(9, 26) });
    expect(parseRange("C2")).toEqual({ rect: rect(1, 2) });
  });

  it("refuses unbounded, reversed and oversized ranges as reads do", () => {
    expect(() => parseRange("Sales!A:C")).toThrow('Invalid or unbounded A1 range "Sales!A:C"');
    expect(() => parseRange("Sales!3:5")).toThrow("Invalid or unbounded");
    expect(() => parseRange("Sales!C3:A1")).toThrow("must run from its top-left cell");
    expect(() => parseRange("")).toThrow("between 1 and 500 characters");
    expect(() => parseRange(`A${"9".repeat(20)}`)).toThrow("is too large");
    expect(validateRange("Sales!A1:C3")).toEqual({ range: "Sales!A1:C3", rows: 3, columns: 3 });
  });

  it("names columns and cells as Google does", () => {
    for (let [letters, column] of [["A", 0], ["Z", 25], ["AA", 26], ["AZ", 51], ["ZZ", 701], ["AAA", 702]] as const) {
      expect(columnLetters(column)).toBe(letters);
      expect(columnNumber(letters)).toBe(column + 1);
    }
    expect(cellName(2, 1)).toBe("B3");
  });

  it("quotes sheet titles exactly where Google quotes them", () => {
    for (let [title, quoted] of Object.entries(SHEET_TITLE_QUOTING)) {
      expect(quoteSheetTitle(title), title).toBe(quoted);
    }
  });

  it("writes ranges in the canonical form Google returns", () => {
    let sales = [sheet(0, "Sales")];
    for (let [read, returned] of CANONICAL_RANGES) {
      let { sheet: name, rect: cells } = parseRange(read);
      expect(a1Of(findSheet(sales, name)!.title, cells)).toBe(returned);
    }
    expect(a1Of("It's", rect(0, 0, 3, 3))).toBe("'It''s'!A1:C3");
  });

  it("finds a sheet ignoring case, and with no name the first visible sheet", () => {
    let sheets = [
      sheet(7, "Hidden", { index: 0, hidden: true }),
      sheet(3, "Sales", { index: 2 }),
      sheet(5, "Costs", { index: 1 }),
    ];
    expect(findSheet(sheets, "sALES")?.id).toBe(3);
    expect(findSheet(sheets, "Nope")).toBeUndefined();
    expect(findSheet(sheets)?.id).toBe(5);
    expect(findSheet([sheet(1, "Only", { hidden: true })])).toBeUndefined();
  });

  it("intersects rectangles", () => {
    expect(intersection(rect(0, 0, 3, 3), rect(2, 2, 3, 3))).toEqual(rect(2, 2));
    expect(intersection(rect(0, 0, 2, 2), rect(2, 0, 1, 1))).toBeUndefined();
  });
});

describe("Sheets entered values as reads show them", () => {
  it("shows formulas as entered in formula mode, and their results as pending otherwise", () => {
    expect(shownValue("=SUM(A1:A3)", "formula")).toEqual({ value: "=SUM(A1:A3)", pending: false });
    expect(shownValue("=SUM(A1:A3)", "raw")).toEqual({ value: null, pending: true });
    expect(shownValue("=SUM(A1:A3)", "formatted")).toEqual({ value: null, pending: true });
    expect(shownValue("=SUM(A1:A3)")).toEqual({ value: null, pending: true });
  });

  it("shows literals exactly in raw mode, and only text and blanks in formatted mode", () => {
    for (let value of ["text", 5, true, null]) {
      expect(shownValue(value, "raw")).toEqual({ value, pending: false });
      expect(shownValue(value, "formula")).toEqual({ value, pending: false });
    }
    expect(shownValue("text", "formatted")).toEqual({ value: "text", pending: false });
    expect(shownValue(null, "formatted")).toEqual({ value: null, pending: false });
    expect(shownValue(5, "formatted")).toEqual({ value: null, pending: true });
    expect(shownValue(false, "formatted")).toEqual({ value: null, pending: true });
  });

  it("matches what Google read back for typed input wherever it claims to know the value", () => {
    let known = 0;
    for (let { input, reads } of TYPED_INPUT) {
      if (input === undefined) continue;
      for (let mode of ["formula", "raw", "formatted"] as const) {
        let shown = shownValue(input, mode);
        if (shown.pending) {
          expect(shown.value).toBeNull();
        } else {
          expect(shown.value, `${String(input)} in ${mode}`).toBe(reads[mode]);
          known++;
        }
      }
    }
    // Text in every mode, formulas in formula mode, and numbers and booleans but in formatted mode.
    expect(known).toBe(11);
  });
});
