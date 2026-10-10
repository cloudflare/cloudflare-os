import { describe, expect, it } from "vitest";
import { prepareChanges } from "../src/sheets-input";
import type { SheetChange } from "../src/sheets-types";
import { rect } from "./sheets-fixture";

const write = (range: string, values: unknown[][]) => ({ op: "writeCells", range, values }) as SheetChange;

/** The refusal of the title of the first change, an `op`. */
const badTitle = (op: string) => `Change 1 (${op}): title must be a string of 1 to 100 characters.`;

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
    expect(refusal([{ op: "mergeCells", range: "Sales!A1" } as unknown as SheetChange]))
      .toBe("Change 1 (mergeCells): op must be one of writeCells, clearRange, formatCells, addSheet, " +
        "renameSheet, duplicateSheet, deleteSheet, insertRows, deleteRows, insertColumns or deleteColumns.");
    // Changes of every kind count toward the 50.
    let mixed: SheetChange[] = Array.from({ length: 51 }, (_, i) =>
      i % 2 === 0 ? { op: "insertRows", sheetId: 0, at: 1 } : { op: "clearRange", range: "Sales!A1" });
    expect(refusal(mixed)).toBe("Make between 1 and 50 changes at a time.");
    expect(prepareChanges(mixed.slice(0, 50))).toHaveLength(50);
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

describe("Sheets structural change input", () => {
  it("prepares each op with only what it declares, rows and columns zero-based", () => {
    expect(prepareChanges([
      { op: "addSheet", title: "Q4", ref: "q4", index: 2, rowCount: 10, columnCount: 3, sheetId: 9 } as SheetChange,
      { op: "renameSheet", sheetId: "q4", title: "Q4 2026", range: "Sales!A1" } as SheetChange,
      { op: "duplicateSheet", sheetId: 0, ref: "copy" },
      { op: "deleteSheet", sheetId: "copy", title: "x" } as SheetChange,
      { op: "insertRows", sheetId: 0, at: 5, count: 2 },
      { op: "deleteRows", sheetId: "q4", at: 1 },
      { op: "insertColumns", sheetId: 3, at: "c" },
      { op: "deleteColumns", sheetId: 3, at: "AA", count: 4 },
    ])).toEqual([
      { op: "addSheet", title: "Q4", ref: "q4", index: 2, rowCount: 10, columnCount: 3 },
      { op: "renameSheet", sheetId: "q4", title: "Q4 2026" },
      { op: "duplicateSheet", sheetId: 0, ref: "copy" },
      { op: "deleteSheet", sheetId: "copy" },
      { op: "insertRows", sheetId: 0, start: 4, count: 2 },
      { op: "deleteRows", sheetId: "q4", start: 0, count: 1 },
      { op: "insertColumns", sheetId: 3, start: 2, count: 1 },
      { op: "deleteColumns", sheetId: 3, start: 26, count: 4 },
    ]);
  });

  it("refuses a title that is empty or over 100 characters", () => {
    expect(refusal([{ op: "addSheet", title: "" }])).toBe(badTitle("addSheet"));
    expect(refusal([{ op: "addSheet", title: "x".repeat(101) }])).toBe(badTitle("addSheet"));
    expect(refusal([{ op: "renameSheet", sheetId: 0, title: 5 } as unknown as SheetChange])).toBe(badTitle("renameSheet"));
    expect(refusal([{ op: "duplicateSheet", sheetId: 0, title: "" }])).toBe(badTitle("duplicateSheet"));
    expect(prepareChanges([{ op: "addSheet", title: "x".repeat(100) }])).toHaveLength(1);
  });

  it("refuses a ref that is empty, too long or given twice", () => {
    expect(refusal([{ op: "addSheet", title: "A", ref: "" }]))
      .toBe("Change 1 (addSheet): ref must be a string of 1 to 64 characters.");
    expect(refusal([{ op: "duplicateSheet", sheetId: 0, ref: "r".repeat(65) }]))
      .toBe("Change 1 (duplicateSheet): ref must be a string of 1 to 64 characters.");
    expect(refusal([
      { op: "addSheet", title: "A", ref: "new" },
      { op: "duplicateSheet", sheetId: 0, ref: "new" },
    ])).toBe('Change 2 (duplicateSheet): ref "new" is already given to the sheet change 1 adds.');
  });

  it("takes a ref only from an earlier change, and an ID only as a non-negative integer", () => {
    expect(refusal([
      { op: "renameSheet", sheetId: "later", title: "B" },
      { op: "addSheet", title: "A", ref: "later" },
    ])).toBe('Change 1 (renameSheet): sheetId "later" is not a ref an earlier change in this batch gives ' +
      "the sheet it adds.");
    // A change's own ref is not yet given when its sheetId is read.
    expect(refusal([{ op: "duplicateSheet", sheetId: "self", ref: "self" }]))
      .toMatch(/^Change 1 \(duplicateSheet\): sheetId "self" is not a ref/);
    let notAnId = "sheetId must be a sheet's ID, a non-negative integer, or a ref an earlier change in " +
      "this batch gives the sheet it adds.";
    for (let sheetId of [-1, 1.5, Number.NaN, null, true]) {
      expect(refusal([{ op: "deleteSheet", sheetId } as unknown as SheetChange])).toBe(`Change 1 (deleteSheet): ${notAnId}`);
    }
    expect(prepareChanges([{ op: "deleteSheet", sheetId: 0 }])).toEqual([{ op: "deleteSheet", sheetId: 0 }]);
  });

  it("refuses an index, row count or column count out of range", () => {
    expect(refusal([{ op: "addSheet", title: "A", index: -1 }]))
      .toBe("Change 1 (addSheet): index must be an integer 0 or more.");
    expect(refusal([{ op: "duplicateSheet", sheetId: 0, index: 0.5 }]))
      .toBe("Change 1 (duplicateSheet): index must be an integer 0 or more.");
    expect(refusal([{ op: "addSheet", title: "A", rowCount: 0 }]))
      .toBe("Change 1 (addSheet): rowCount must be an integer from 1 to 10,000,000.");
    expect(refusal([{ op: "addSheet", title: "A", columnCount: 18_279 }]))
      .toBe("Change 1 (addSheet): columnCount must be an integer from 1 to 18,278.");
    expect(prepareChanges([{ op: "addSheet", title: "A", columnCount: 18_278 }])).toHaveLength(1);
  });

  it("refuses at and count out of shape", () => {
    expect(refusal([{ op: "insertRows", sheetId: 0, at: 0 }]))
      .toBe("Change 1 (insertRows): at must be an integer 1 or more.");
    expect(refusal([{ op: "deleteRows", sheetId: 0, at: "3" } as unknown as SheetChange]))
      .toBe("Change 1 (deleteRows): at must be an integer 1 or more.");
    for (let at of ["", "AAAA", "A1", 3]) {
      expect(refusal([{ op: "insertColumns", sheetId: 0, at } as unknown as SheetChange]))
        .toBe('Change 1 (insertColumns): at must be the letters of a column, such as "C".');
    }
    expect(refusal([{ op: "insertRows", sheetId: 0, at: 1, count: 1001 }]))
      .toBe("Change 1 (insertRows): count must be an integer from 1 to 1,000.");
    expect(refusal([{ op: "insertColumns", sheetId: 0, at: "A", count: 0 }]))
      .toBe("Change 1 (insertColumns): count must be an integer from 1 to 1,000.");
    expect(refusal([{ op: "deleteColumns", sheetId: 0, at: "A", count: 18_279 }]))
      .toBe("Change 1 (deleteColumns): count must be an integer from 1 to 18,278.");
    expect(refusal([{ op: "deleteRows", sheetId: 0, at: 1, count: 2.5 }]))
      .toBe("Change 1 (deleteRows): count must be an integer from 1 to 10,000,000.");
    expect(prepareChanges([{ op: "deleteRows", sheetId: 0, at: 1, count: 5000 }])).toHaveLength(1);
  });

  it("counts the cells of changes to ranges toward the batch's, and no others", () => {
    let full = { op: "clearRange", range: "Sales!A1:J1000" } as const;
    expect(prepareChanges([full, full, { op: "deleteRows", sheetId: 0, at: 1, count: 100 }])).toHaveLength(3);
  });
});

/** A `formatCells` change of `range` setting `value`, as given. */
const format = (value: unknown, range = "Sales!A1:B2") => ({ op: "formatCells", range, format: value }) as SheetChange;

/** The refusal of one `formatCells` change setting `value`. */
const formatRefusal = (value: unknown) => refusal([format(value)]);

describe("Sheets format change input", () => {
  it("prepares the sheet, the cells and what the format sets or resets", () => {
    expect(prepareChanges([format({
      bold: true, italic: null, fontSize: 14, textColor: "#FF0000", fillColor: "ACCENT1",
      numberFormat: { type: "CURRENCY", pattern: '"$"#,##0.00' }, horizontalAlignment: "RIGHT",
      verticalAlignment: null, wrap: "WRAP",
      borders: { top: { style: "SOLID", color: "#0000FF" }, innerVertical: null, bottom: { style: "DOTTED" } },
    }, "'Sales 2026'!B3:C4")])).toEqual([{
      op: "formatCells", sheet: "Sales 2026", rect: rect(2, 1, 2, 2),
      format: {
        bold: true, italic: null, fontSize: 14, textColor: "#ff0000", fillColor: "ACCENT1",
        numberFormat: { type: "CURRENCY", pattern: '"$"#,##0.00' }, horizontalAlignment: "RIGHT",
        verticalAlignment: null, wrap: "WRAP",
        borders: { top: { style: "SOLID", color: "#0000ff" }, innerVertical: null, bottom: { style: "DOTTED" } },
      },
    }]);
  });

  it("drops what a format, a number format or a border does not declare", () => {
    expect(prepareChanges([format({
      bold: false, fontFamily: "Comic Sans", hyperlink: "https://example.com", underline: undefined,
      numberFormat: { type: "PERCENT", locale: "fr_FR" },
      borders: { top: { style: "DASHED", width: 9 }, diagonal: { style: "SOLID" }, left: undefined },
    })])[0]).toEqual({
      op: "formatCells", sheet: "Sales", rect: rect(0, 0, 2, 2),
      format: { bold: false, numberFormat: { type: "PERCENT" }, borders: { top: { style: "DASHED" } } },
    });
  });

  it("takes a black border as one with no colour, as reads return it", () => {
    expect(prepareChanges([format({ borders: { left: { style: "SOLID", color: "#000000" } } })])[0])
      .toEqual({ op: "formatCells", sheet: "Sales", rect: rect(0, 0, 2, 2), format: { borders: { left: { style: "SOLID" } } } });
  });

  it("refuses a format that sets nothing", () => {
    for (let value of [undefined, null, "bold", [], [{ bold: true }]]) {
      expect(formatRefusal(value))
        .toBe("Change 1 (formatCells): format must be an object of the fields to set or reset.");
    }
    expect(formatRefusal({})).toBe("Change 1 (formatCells): format must set or reset at least one of " +
      "bold, italic, underline, strikethrough, fontSize, textColor, fillColor, numberFormat, " +
      "horizontalAlignment, verticalAlignment, wrap or borders.");
    expect(formatRefusal({ fontFamily: "Arial" })).toMatch(/^Change 1 \(formatCells\): format must set or reset/);
    expect(formatRefusal({ borders: {} })).toBe("Change 1 (formatCells): borders must draw or remove at " +
      "least one of top, bottom, left, right, innerHorizontal or innerVertical.");
    for (let borders of [null, [], "SOLID"]) {
      expect(formatRefusal({ borders }))
        .toBe("Change 1 (formatCells): borders must be an object of the borders to draw or remove.");
    }
  });

  it("refuses a value of the wrong kind for its field", () => {
    expect(formatRefusal({ bold: "yes" })).toBe("Change 1 (formatCells): bold must be true, false or null.");
    expect(formatRefusal({ strikethrough: 1 }))
      .toBe("Change 1 (formatCells): strikethrough must be true, false or null.");
    expect(formatRefusal({ horizontalAlignment: "JUSTIFY" }))
      .toBe("Change 1 (formatCells): horizontalAlignment must be LEFT, CENTER, RIGHT or null.");
    expect(formatRefusal({ verticalAlignment: "middle" }))
      .toBe("Change 1 (formatCells): verticalAlignment must be TOP, MIDDLE, BOTTOM or null.");
    expect(formatRefusal({ wrap: "OVERFLOW_CELL" }))
      .toBe("Change 1 (formatCells): wrap must be OVERFLOW, WRAP, CLIP or null.");
  });

  it("refuses a font size that is not a whole number of points from 1 to 400", () => {
    for (let fontSize of [0, 401, 10.5, Number.NaN, "12"]) {
      expect(formatRefusal({ fontSize }))
        .toBe("Change 1 (formatCells): fontSize must be an integer from 1 to 400, or null.");
    }
    expect(prepareChanges([format({ fontSize: 1 }), format({ fontSize: 400 }), format({ fontSize: null })]))
      .toHaveLength(3);
  });

  it("refuses a colour that is not #rrggbb or a theme colour's name", () => {
    let colors = "#rrggbb or one of TEXT, BACKGROUND, ACCENT1, ACCENT2, ACCENT3, ACCENT4, ACCENT5, " +
      "ACCENT6 or LINK";
    for (let textColor of ["red", "#f00", "#ff00001", "accent1", "ACCENT7", 0xff0000]) {
      expect(formatRefusal({ textColor })).toBe(`Change 1 (formatCells): textColor must be a colour, ${colors}.`);
    }
    expect(formatRefusal({ fillColor: "rgb(0, 0, 0)" }))
      .toBe(`Change 1 (formatCells): fillColor must be a colour, ${colors}.`);
    expect(formatRefusal({ borders: { right: { style: "SOLID", color: "black" } } }))
      .toBe(`Change 1 (formatCells): borders.right.color must be a colour, ${colors}.`);
  });

  it("refuses a number format of an unknown type, or whose pattern Google could not hold", () => {
    expect(formatRefusal({ numberFormat: "CURRENCY" }))
      .toBe("Change 1 (formatCells): numberFormat must be an object with a type, or null.");
    expect(formatRefusal({ numberFormat: { pattern: "0.00" } }))
      .toBe("Change 1 (formatCells): numberFormat.type must be TEXT, NUMBER, PERCENT, CURRENCY, DATE, " +
        "TIME, DATE_TIME or SCIENTIFIC.");
    expect(formatRefusal({ numberFormat: { type: "BOOLEAN" } })).toMatch(/numberFormat\.type must be TEXT/);
    let unfit = "Change 1 (formatCells): numberFormat.pattern must be a string of 1 to 200 characters; " +
      "leave it out for the type's default.";
    expect(formatRefusal({ numberFormat: { type: "NUMBER", pattern: "0".repeat(201) } })).toBe(unfit);
    expect(formatRefusal({ numberFormat: { type: "NUMBER", pattern: "" } })).toBe(unfit);
    expect(formatRefusal({ numberFormat: { type: "NUMBER", pattern: 0 } })).toBe(unfit);
    for (let pattern of ["0.00\n", "0\u0000", "\u009b0"]) {
      expect(formatRefusal({ numberFormat: { type: "NUMBER", pattern } }))
        .toBe("Change 1 (formatCells): numberFormat.pattern must not hold control characters.");
    }
    expect(prepareChanges([format({ numberFormat: { type: "DATE", pattern: "y".repeat(200) } })])).toHaveLength(1);
  });

  it("refuses a border with no known style", () => {
    expect(formatRefusal({ borders: { top: "SOLID" } }))
      .toBe("Change 1 (formatCells): borders.top must be a border with a style, or null.");
    expect(formatRefusal({ borders: { innerHorizontal: { color: "#ff0000" } } }))
      .toBe("Change 1 (formatCells): borders.innerHorizontal.style must be SOLID, SOLID_MEDIUM, " +
        "SOLID_THICK, DOTTED, DASHED or DOUBLE.");
    expect(formatRefusal({ borders: { bottom: { style: "NONE" } } })).toMatch(/borders\.bottom\.style must be/);
  });

  it("refuses a range that does not name its sheet, and more than 10,000 cells", () => {
    expect(refusal([format({ bold: true }, "A1:B2")]))
      .toBe("Change 1 (formatCells): range \"A1:B2\" does not name its sheet; name it as in 'Sheet name'!A1:C3.");
    expect(refusal([format({ bold: true }, "Sales!A1:A10001")]))
      .toBe("Change 1 (formatCells): Sales!A1:A10001 has 10,001 cells; a change may address at most 10,000.");
    // Formatted cells count toward the batch's 20,000 as written ones do.
    let full = format({ bold: true }, "Sales!A1:J1000");
    expect(refusal([full, full, { op: "clearRange", range: "Sales!A1" }]))
      .toBe("These changes address 20,001 cells; one batch may address at most 20,000.");
  });
});
