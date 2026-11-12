import { describe, expect, it } from "vitest";
import {
  baseFormats, baseSizes, CELL_FORMAT_FIELDS, colorStyle, FORMAT_READ_FIELDS, isSheetColor, mergeFormat,
  projectFormat, sheetColor, THEME_COLORS, type BaseFormats, type BaseSizes, type RestCellFormat,
  type RestColorStyle,
} from "../src/sheets-format";
import { BlankSpreadsheet } from "../src/sheets-api";
import { formatRequests, gridRange } from "../src/sheets-plan";
import type { SheetCellFormat } from "../src/sheets-read-types";
import {
  applyChange, formatPiecesToFetch, gridOf, resolveArea, simulatedFormats, type Grid, type PlannedChange,
} from "../src/sheets-simulation";
import type { SheetFormatChange } from "../src/sheets-types";
import { FORMAT_READBACK, formatSheet, rect, sheet } from "./sheets-fixture";

/** `grid` with `changes` queued as one batch. */
function withChanges(grid: Grid, changes: PlannedChange[]): Grid {
  return applyChange(grid, {
    kind: "updateSpreadsheet",
    payload: { changes, sheets: {}, marker: { id: 1, token: "token" }, guard: { sha256: "", after: [] } },
  }, 1);
}

/** Base formats in which each cell's font size names its sheet, row and column. */
const POSITIONED: BaseFormats = (sheetId, row, column) =>
  ({ fontSize: sheetId * 10_000 + row * 100 + column });

/** Base sizes that name each line's sheet and position: rows from 20, columns from 100. */
const SIZED: BaseSizes = (sheetId, axis, index) => sheetId * 1000 + (axis === "rows" ? 20 : 100) + index;

describe("Google Sheets format projection", () => {
  it("reads a cell back as the agent sees it, preferring each colour's style", () => {
    expect(projectFormat(FORMAT_READBACK)).toEqual({
      bold: true,
      italic: true,
      fontSize: 14,
      textColor: "#7f0000",
      fillColor: "ACCENT1",
      numberFormat: { type: "CURRENCY", pattern: "\"$\"#,##0.00" },
      horizontalAlignment: "RIGHT",
      verticalAlignment: "MIDDLE",
      wrap: "WRAP",
      // A black border's colour is left out.
      borders: { top: { style: "SOLID_MEDIUM", color: "#ff0000" }, bottom: { style: "DASHED" } },
    } satisfies SheetCellFormat);
  });

  it("reads a cell with nothing set as null", () => {
    expect(projectFormat(undefined)).toBeNull();
    expect(projectFormat({})).toBeNull();
    // A reset field can leave its container behind.
    expect(projectFormat({ textFormat: {}, borders: {} })).toBeNull();
    expect(projectFormat({ borders: { top: { style: "NONE" }, left: { style: "STYLE_UNSPECIFIED" } } }))
      .toBeNull();
  });

  it("keeps a setting that matches the default, since it is set on the cell", () => {
    expect(projectFormat({ textFormat: { bold: false } })).toEqual({ bold: false });
  });

  it("round-trips every component of an rgb colour through Google's 32-bit storage", () => {
    for (let n = 0; n < 256; n++) {
      let byte = n.toString(16).padStart(2, "0");
      for (let color of [`#${byte}0000`, `#00${byte}00`, `#0000${byte}`]) {
        let { rgbColor } = colorStyle(color);
        let stored = Object.fromEntries(Object.entries(rgbColor!)
          .filter(([, component]) => component !== 0)
          .map(([name, component]) => [name, Math.fround(component)]));
        expect(sheetColor({ rgbColor: stored })).toBe(color);
      }
    }
  });

  it("sends a theme colour by name and reads it back as one", () => {
    for (let theme of THEME_COLORS) {
      expect(colorStyle(theme)).toEqual({ themeColor: theme });
      expect(sheetColor({ themeColor: theme }, { red: 0.25882354 })).toBe(theme);
    }
    expect(colorStyle("#FF8000")).toEqual({ rgbColor: { red: 1, green: 128 / 255, blue: 0 } });
  });

  it("falls back to the legacy colour when there is no usable style", () => {
    expect(sheetColor(undefined, { green: 1 })).toBe("#00ff00");
    expect(sheetColor({ themeColor: "THEME_COLOR_TYPE_UNSPECIFIED" }, { blue: 1 })).toBe("#0000ff");
    expect(sheetColor(undefined, {})).toBe("#000000");
    expect(sheetColor()).toBeUndefined();
    expect(projectFormat({ textFormat: { foregroundColor: {} } })).toEqual({ textColor: "#000000" });
  });

  it("names wrapping as the agent does and drops values it has no name for", () => {
    expect(["OVERFLOW_CELL", "WRAP", "LEGACY_WRAP", "CLIP"].map(wrapStrategy =>
      projectFormat({ wrapStrategy })?.wrap)).toEqual(["OVERFLOW", "WRAP", "WRAP", "CLIP"]);
    expect(projectFormat({
      wrapStrategy: "WRAP_STRATEGY_UNSPECIFIED",
      horizontalAlignment: "HORIZONTAL_ALIGN_UNSPECIFIED",
      verticalAlignment: "SIDEWAYS",
      numberFormat: { type: "NUMBER_FORMAT_TYPE_UNSPECIFIED", pattern: "0" },
    })).toBeNull();
    // A type with no pattern takes the locale's default.
    expect(projectFormat({ numberFormat: { type: "PERCENT" } })).toEqual({ numberFormat: { type: "PERCENT" } });
    expect(projectFormat({ numberFormat: { type: "DATE", pattern: "" } })).toEqual({ numberFormat: { type: "DATE" } });
  });

  it("accepts only #rrggbb and theme names as colours", () => {
    expect(["#a1B2c3", "ACCENT6", "LINK"].map(isSheetColor)).toEqual([true, true, true]);
    expect(["#abc", "red", "accent1", "#1234567", "", 5, undefined].map(isSheetColor))
      .toEqual([false, false, false, false, false, false, false]);
  });
});

/** A colour style as Google stores it: each component a 32-bit float, those that are 0 left out. */
const stored = (style: RestColorStyle | undefined) => style?.rgbColor
  ? {
      rgbColor: Object.fromEntries(Object.entries(style.rgbColor)
        .filter(([, component]) => component !== 0).map(([name, component]) => [name, Math.fround(component)])),
    }
  : style;

describe("Google Sheets format requests", () => {
  let range = gridRange(3, rect(1, 2, 2, 3));
  const RED = { rgbColor: { red: 1, green: 0, blue: 0 } };
  const BLACK = { rgbColor: { red: 0, green: 0, blue: 0 } };

  it("sets every field but the borders with one repeatCell whose mask names each", () => {
    expect(formatRequests(range, {
      bold: true, italic: false, underline: true, strikethrough: false, fontSize: 14,
      textColor: "#ff0000", fillColor: "ACCENT1", numberFormat: { type: "CURRENCY", pattern: '"$"#,##0.00' },
      horizontalAlignment: "RIGHT", verticalAlignment: "MIDDLE", wrap: "OVERFLOW",
    })).toEqual([{
      repeatCell: {
        range,
        cell: {
          userEnteredFormat: {
            textFormat: {
              bold: true, italic: false, underline: true, strikethrough: false, fontSize: 14,
              foregroundColorStyle: RED,
            },
            backgroundColorStyle: { themeColor: "ACCENT1" },
            numberFormat: { type: "CURRENCY", pattern: '"$"#,##0.00' },
            horizontalAlignment: "RIGHT",
            verticalAlignment: "MIDDLE",
            wrapStrategy: "OVERFLOW_CELL",
          },
        },
        fields: "userEnteredFormat(textFormat(bold,italic,underline,strikethrough,fontSize," +
          "foregroundColorStyle),backgroundColorStyle,numberFormat,horizontalAlignment,verticalAlignment," +
          "wrapStrategy)",
      },
    }]);
  });

  it("names a reset field in the mask and sends no value for it, so Google resets it", () => {
    // A colour reset names the older field Google also keeps it in, so a colour set there goes too.
    expect(formatRequests(range, { bold: null, fillColor: null, numberFormat: null, wrap: "CLIP" })).toEqual([{
      repeatCell: {
        range,
        cell: { userEnteredFormat: { wrapStrategy: "CLIP" } },
        fields: "userEnteredFormat(textFormat(bold),backgroundColorStyle,backgroundColor,numberFormat,wrapStrategy)",
      },
    }]);
    expect(formatRequests(range, { italic: true, textColor: null })).toEqual([{
      repeatCell: {
        range,
        cell: { userEnteredFormat: { textFormat: { italic: true } } },
        fields: "userEnteredFormat(textFormat(italic,foregroundColorStyle,foregroundColor))",
      },
    }]);
    // As a scratch spreadsheet reset bold alone and kept the rest.
    expect(formatRequests(range, { bold: null })).toEqual([{
      repeatCell: { range, cell: { userEnteredFormat: {} }, fields: "userEnteredFormat(textFormat(bold))" },
    }]);
  });

  it("draws and removes borders with one updateBorders, black when no colour is named", () => {
    expect(formatRequests(range, {
      borders: {
        top: { style: "SOLID_MEDIUM", color: "#ff0000" },
        bottom: null,
        innerHorizontal: { style: "DASHED" },
        innerVertical: { style: "DOTTED", color: "LINK" },
      },
    })).toEqual([{
      updateBorders: {
        range,
        top: { style: "SOLID_MEDIUM", colorStyle: RED },
        bottom: { style: "NONE" },
        innerHorizontal: { style: "DASHED", colorStyle: BLACK },
        innerVertical: { style: "DOTTED", colorStyle: { themeColor: "LINK" } },
      },
    }]);
  });

  it("sends a repeatCell and then an updateBorders for a format with both", () => {
    let requests = formatRequests(range, { fontSize: 9, borders: { left: { style: "DOUBLE" } } });
    expect(requests.map(request => Object.keys(request as object))).toEqual([["repeatCell"], ["updateBorders"]]);
  });

  it("reads back, as Google stores what it sends, what the simulation merges", () => {
    let change: SheetFormatChange = {
      bold: true, underline: false, fontSize: 18, textColor: "#7f1e00", fillColor: "ACCENT4",
      numberFormat: { type: "PERCENT" }, verticalAlignment: "TOP", wrap: "OVERFLOW",
      borders: { top: { style: "SOLID_THICK", color: "#00ff80" }, left: { style: "DOUBLE" }, right: null },
    };
    let [repeat, borders] = formatRequests(gridRange(0, rect(0, 0)), change) as [
      { repeatCell: { cell: { userEnteredFormat: RestCellFormat } } },
      { updateBorders: Record<string, { style: string; colorStyle?: RestColorStyle }> },
    ];
    // Google draws no border for NONE.
    let { textFormat, backgroundColorStyle, ...rest } = repeat.repeatCell.cell.userEnteredFormat;
    let cellBorders = Object.fromEntries(Object.entries(borders.updateBorders).flatMap(([side, border]) =>
      side === "range" || border.style === "NONE" ? [] : [[side, { style: border.style, colorStyle: stored(border.colorStyle) }]]));
    let readBack = projectFormat({
      ...rest,
      textFormat: { ...textFormat, foregroundColorStyle: stored(textFormat?.foregroundColorStyle) },
      backgroundColorStyle: stored(backgroundColorStyle),
      borders: cellBorders,
    });
    let { borders: sides, ...set } = change;
    expect(readBack).toEqual(mergeFormat(null, { set, borders: { top: sides!.top, left: sides!.left, right: null } }));
    expect(readBack).toEqual({
      bold: true, underline: false, fontSize: 18, textColor: "#7f1e00", fillColor: "ACCENT4",
      numberFormat: { type: "PERCENT" }, verticalAlignment: "TOP", wrap: "OVERFLOW",
      borders: { top: { style: "SOLID_THICK", color: "#00ff80" }, left: { style: "DOUBLE" } },
    });
  });
});

describe("Google Sheets queued formatting merged", () => {
  let base: SheetCellFormat = {
    bold: true, fontSize: 14, numberFormat: { type: "PERCENT" },
    borders: { top: { style: "SOLID" }, left: { style: "DASHED", color: "#ff0000" } },
  };

  it("keeps a cell's formatting when nothing is queued for it", () => {
    expect(mergeFormat(base, undefined)).toBe(base);
    expect(mergeFormat(null, undefined)).toBeNull();
  });

  it("sets what is given over what the cell has, and resets what is null", () => {
    expect(mergeFormat(base, {
      set: { bold: null, italic: true, numberFormat: { type: "DATE", pattern: "yyyy-mm-dd" } },
      borders: { left: null, bottom: { style: "DOUBLE" } },
    })).toEqual({
      fontSize: 14, italic: true, numberFormat: { type: "DATE", pattern: "yyyy-mm-dd" },
      borders: { top: { style: "SOLID" }, bottom: { style: "DOUBLE" } },
    });
  });

  it("reads a cell with every field reset as having none", () => {
    expect(mergeFormat(base, {
      set: { bold: null, fontSize: null, numberFormat: null },
      borders: { top: null, left: null },
    })).toBeNull();
    expect(mergeFormat(null, { set: { wrap: "CLIP" }, borders: {} })).toEqual({ wrap: "CLIP" });
  });
});

describe("Google Sheets format read mask", () => {
  it("asks for what a cell has set of what the agent reads, and nothing about its value", () => {
    for (let mask of [CELL_FORMAT_FIELDS, FORMAT_READ_FIELDS]) {
      for (let field of [
        "formattedValue", "effectiveValue", "userEnteredValue", "effectiveFormat", "hyperlink", "note",
        "link", "textFormatRuns", "dataValidation", "pivotTable",
      ]) {
        expect(mask).not.toContain(field);
      }
    }
    expect(FORMAT_READ_FIELDS).toContain("rowData(values(userEnteredFormat(");
    expect(CELL_FORMAT_FIELDS.startsWith("userEnteredFormat(")).toBe(true);
  });
});

describe("Google Sheets base formats", () => {
  it("places each range's cells by the first row and column Google gives it", () => {
    let formats = baseFormats([
      formatSheet({ sheetId: 0, title: "Sales" }, [
        { startRow: 0, startColumn: 0, formats: [[{ textFormat: { bold: true } }, undefined]] },
        { startRow: 4, startColumn: 2, formats: [[undefined], [{ horizontalAlignment: "CENTER" }]] },
      ]),
      formatSheet({ sheetId: 7, title: "Plan" }, [
        { startRow: 1, startColumn: 1, formats: [[{ textFormat: { italic: true } }]] },
      ]),
    ]);

    expect(formats(0, 0, 0)).toEqual({ bold: true });
    expect(formats(0, 0, 1)).toBeNull();
    expect(formats(0, 4, 2)).toBeNull();
    expect(formats(0, 5, 2)).toEqual({ horizontalAlignment: "CENTER" });
    expect(formats(7, 1, 1)).toEqual({ italic: true });
    expect(formats(0, 1, 1)).toBeNull();
  });

  it("reads each line's size by the first row and column Google gives its range, a size left out as 0", () => {
    let sizes = baseSizes([{
      properties: { sheetId: 7 },
      data: [{ startRow: 2, startColumn: 1, rowMetadata: [{ pixelSize: 40 }, {}], columnMetadata: [{ pixelSize: 150 }] }],
    }]);
    expect([sizes(7, "rows", 2), sizes(7, "rows", 3), sizes(7, "columns", 1)]).toEqual([40, 0, 150]);
    expect([sizes(7, "rows", 1), sizes(7, "columns", 2), sizes(0, "rows", 2)]).toEqual([null, null, null]);
  });
});

describe("simulated format reads", () => {
  let sheets = [sheet(0, "Sales"), sheet(7, "Plan", { index: 1, rowCount: 10, columnCount: 4 })];

  it("reads a grid with nothing moved where Google holds it, padded to the size asked for", () => {
    let base = gridOf({ sheets });
    let area = resolveArea(base, { sheet: "plan", rect: rect(8, 2, 3, 3) });

    expect(simulatedFormats(base, area, POSITIONED, SIZED)).toEqual({
      range: "Plan!C9:D10",
      formats: [
        [{ fontSize: 70_802 }, { fontSize: 70_803 }, null],
        [{ fontSize: 70_902 }, { fontSize: 70_903 }, null],
        [null, null, null],
      ],
      rowHeights: [7028, 7029, null],
      columnWidths: [7102, 7103, null],
    });
  });

  it("moves formats with their lines and leaves those of inserted lines pending", () => {
    let moved = withChanges(gridOf({ sheets }), [
      { op: "renameSheet", sheetId: 0, title: "Sales 2026" },
      { op: "insertRows", sheetId: 0, start: 1, count: 1 },
      { op: "deleteColumns", sheetId: 0, start: 0, count: 1 },
    ]);
    let area = resolveArea(moved, { sheet: "Sales 2026", rect: rect(0, 0, 3, 2) });

    expect(simulatedFormats(moved, area, POSITIONED, SIZED)).toEqual({
      range: "'Sales 2026'!A1:B3",
      formats: [
        [{ fontSize: 1 }, { fontSize: 2 }],
        [null, null],
        [{ fontSize: 101 }, { fontSize: 102 }],
      ],
      // Google sizes an inserted row from the row beside it.
      rowHeights: [20, null, 21],
      columnWidths: [101, 102],
      pendingCells: ["A2", "B2"],
    });
  });

  it("reads the cells of an added sheet as having no formatting", () => {
    let added = withChanges(gridOf({ sheets }), [
      { op: "addSheet", sheetId: 42, title: "Q4", index: 2, rowCount: 5, columnCount: 5 },
    ]);
    let area = resolveArea(added, { sheet: "Q4", rect: rect(0, 0, 2, 2) });

    // "Q4" reads as a cell's name, so Google quotes it.
    expect(simulatedFormats(added, area, POSITIONED, SIZED)).toEqual({
      range: "'Q4'!A1:B2", formats: [[null, null], [null, null]], rowHeights: [21, 21], columnWidths: [100, 100],
    });
  });

  it("reads a copy's formats from the sheet copied", () => {
    let copied = withChanges(gridOf({ sheets }), [
      { op: "duplicateSheet", sheetId: 7, newSheetId: 8, title: "Plan copy", index: 2 },
    ]);
    let area = resolveArea(copied, { sheet: "Plan copy", rect: rect(1, 1) });

    expect(simulatedFormats(copied, area, POSITIONED, SIZED)).toEqual({
      range: "'Plan copy'!B2", formats: [[{ fontSize: 70_101 }]], rowHeights: [7021], columnWidths: [7101],
    });
  });

  it("lists the merges that overlap the range, whole", () => {
    let merged = gridOf({ sheets: [sheet(0, "Sales", { merges: [rect(0, 0, 2, 2), rect(5, 3, 1, 2)] })] });
    let read = (at: ReturnType<typeof rect>) =>
      simulatedFormats(merged, resolveArea(merged, { sheet: "Sales", rect: at }), POSITIONED, SIZED).merges;
    expect(read(rect(0, 0, 3, 2))).toEqual(["A1:B2"]);
    expect(read(rect(0, 2))).toBeUndefined();
    expect(read(rect(1, 1, 6, 4))).toEqual(["A1:B2", "D6:E6"]);
  });

  it("reads the sizes beside inserted lines from the runs Google holds, not the span between them", () => {
    // Two deletions leave rows 1-2 and 100,003-100,004 beside an inserted column.
    let base = gridOf({ sheets: [sheet(0, "Sales", { rowCount: 100_004, columnCount: 1 })] });
    let queued = withChanges(base, [
      { op: "deleteRows", sheetId: 0, start: 2, count: 50_000 },
      { op: "deleteRows", sheetId: 0, start: 2, count: 50_000 },
      { op: "insertColumns", sheetId: 0, start: 1, count: 1 },
    ]);
    let pieces = formatPiecesToFetch(queued, resolveArea(queued, { sheet: "Sales", rect: rect(0, 1, 4, 1) }));
    expect(pieces).toEqual([
      { sheetId: 0, rect: { startRow: 0, endRow: 2, startColumn: 0, endColumn: 1 } },
      { sheetId: 0, rect: { startRow: 100_002, endRow: 100_004, startColumn: 0, endColumn: 1 } },
    ]);
  });

  it("lists merges in reading order, whatever order Google keeps them in", () => {
    // A scratch spreadsheet listed C3:E5 before F2:G2 once a column was inserted through both.
    let merged = gridOf({ sheets: [sheet(0, "Sales", { merges: [rect(2, 2, 3, 3), rect(1, 5, 1, 2), rect(2, 5, 1, 2)] })] });
    let area = resolveArea(merged, { sheet: "Sales", rect: rect(0, 0, 10, 8) });
    expect(simulatedFormats(merged, area, POSITIONED, SIZED).merges).toEqual(["F2:G2", "C3:E5", "F3:G3"]);
  });

  // As a scratch spreadsheet moved its merge C4:E6 and its two frozen rows and one frozen column.
  it.each<[string, PlannedChange, string[], number, number]>([
    ["a row inserted inside a merge grows it", { op: "insertRows", sheetId: 0, start: 4, count: 1 }, ["C4:E7"], 2, 1],
    ["a row inserted at its top edge moves it", { op: "insertRows", sheetId: 0, start: 3, count: 1 }, ["C5:E7"], 2, 1],
    ["a row inserted at its bottom edge leaves it", { op: "insertRows", sheetId: 0, start: 6, count: 1 }, ["C4:E6"], 2, 1],
    ["a row inserted among the frozen ones is frozen", { op: "insertRows", sheetId: 0, start: 1, count: 1 }, ["C5:E7"], 3, 1],
    ["a row inserted below the frozen ones is not", { op: "insertRows", sheetId: 0, start: 2, count: 1 }, ["C5:E7"], 2, 1],
    ["a column inserted inside a merge grows it", { op: "insertColumns", sheetId: 0, start: 3, count: 1 }, ["C4:F6"], 2, 1],
    ["a column inserted at its left edge moves it", { op: "insertColumns", sheetId: 0, start: 2, count: 1 }, ["D4:F6"], 2, 1],
    ["deleting a row of a merge shrinks it", { op: "deleteRows", sheetId: 0, start: 3, count: 1 }, ["C4:E5"], 2, 1],
    ["deleting rows through a merge shrinks it", { op: "deleteRows", sheetId: 0, start: 2, count: 2 }, ["C3:E4"], 2, 1],
    ["deleting a merge's rows removes it", { op: "deleteRows", sheetId: 0, start: 3, count: 3 }, [], 2, 1],
    ["deleting all but one of its rows keeps it", { op: "deleteRows", sheetId: 0, start: 3, count: 2 }, ["C4:E4"], 2, 1],
    ["deleting frozen rows unfreezes them", { op: "deleteRows", sheetId: 0, start: 0, count: 2 }, ["C2:E4"], 0, 1],
    ["deleting the frozen column unfreezes it", { op: "deleteColumns", sheetId: 0, start: 0, count: 1 }, ["B4:D6"], 2, 0],
  ])("%s", (_name, change, merges, frozenRows, frozenColumns) => {
    let base = gridOf({ sheets: [sheet(0, "Sales", { frozenRowCount: 2, frozenColumnCount: 1, merges: [rect(3, 2, 3, 3)] })] });
    let moved = withChanges(base, [change]);
    let [sales] = moved.sheets;
    expect(simulatedFormats(moved, resolveArea(moved, { sheet: "Sales", rect: rect(0, 0, 10, 6) }), POSITIONED, SIZED).merges ?? [])
      .toEqual(merges);
    expect([sales.frozenRowCount ?? 0, sales.frozenColumnCount ?? 0]).toEqual([frozenRows, frozenColumns]);
  });

  it("gives a copy the merges and frozen lines of the sheet copied", () => {
    let base = gridOf({ sheets: [sheet(0, "Sales", { frozenRowCount: 1, merges: [rect(0, 0, 1, 2)] })] });
    let copied = withChanges(base, [{ op: "duplicateSheet", sheetId: 0, newSheetId: 8, title: "Copy", index: 1 }]);
    expect(copied.sheets.find(s => s.id === 8)).toMatchObject({ frozenRowCount: 1, merges: [rect(0, 0, 1, 2)] });
  });
});

describe("Sheets formatting of a spreadsheet awaiting creation", () => {
  it("reads every cell of its one sheet as unformatted, and refuses another sheet", async () => {
    let blank = new BlankSpreadsheet("Budget");
    expect(await blank.readFormats("", "sheet1!A1:B2")).toEqual({
      range: "Sheet1!A1:B2", formats: [[null, null], [null, null]], rowHeights: [21, 21], columnWidths: [100, 100],
    });
    await expect(blank.readFormats("", "'Q1 Data'!A1"))
      .rejects.toThrow('No sheet named "Q1 Data": a spreadsheet awaiting creation has only "Sheet1".');
    await expect(blank.readFormats("", "Sheet1!Z1000:AA1000")).rejects.toThrow("exceeds the 1000 rows");
  });
});
