import { ActionJournal } from "@gadgets/gatekeeper-kit/actions";
import type { ActionDescription, SpreadsheetArea, SpreadsheetPreview } from "@gadgets/workshop-shared/gatekeeper";
import { describe, expect, it } from "vitest";
import { SHEETS_ACTIONS, type SheetsHost } from "../src/sheets-actions";
import {
  NO_PREVIEW_CELLS, previewCellsOf, type GoogleSheetsApi, type PreviewCells, type SheetArea,
  type SpreadsheetMetadata,
} from "../src/sheets-api";
import type { SheetCellFormat } from "../src/sheets-read-types";
import type { EnteredValue } from "../src/sheets-model";
import {
  CONTEXT_COLUMNS, CONTEXT_ROWS, EMPTY_PREVIEW, previewSpreadsheet, WHOLE_SHEET,
} from "../src/sheets-preview";
import {
  conflictReason, type PlannedChange, type QueuedChange, type SheetMeta, type SheetsAction,
} from "../src/sheets-simulation";
import { FakeKv } from "./fake-kv";
import { rect, sheet } from "./sheets-fixture";

const URL = "https://docs.google.com/spreadsheets/d/sheet-1/edit";

function queued(id: number, changes: PlannedChange[], sheets: Record<string, string> = {}): QueuedChange {
  return {
    id,
    action: {
      kind: "updateSpreadsheet",
      payload: {
        changes, sheets, marker: { id: id + 100, token: `token-${id}` },
        guard: { sha256: "0".repeat(64), after: [] },
      },
    },
  };
}

function metadata(sheets: SheetMeta[]): SpreadsheetMetadata {
  return { id: "sheet-1", title: "Budget", sheets, protectedRanges: [] };
}

/** A cell Google holds: as entered, as displayed, and its formatting. */
type HeldCell = { entered: EnteredValue; shown?: string; format?: SheetCellFormat; fontFamily?: string };

/**
 * A spreadsheet holding `cells`, keyed `sheetId:row:column`, every column `width` pixels wide,
 * recording the areas each preview read asks for.
 */
function fakeRead(cells: Record<string, HeldCell> = {}, width = 120, more: Partial<PreviewCells> = {}) {
  let asked: (SheetArea & { title: string })[][] = [];
  let read = async (areas: (SheetArea & { title: string })[]): Promise<PreviewCells> => {
    asked.push(areas);
    let at = (sheetId: number, row: number, column: number) => {
      let inside = areas.some(area => area.sheetId === sheetId && row >= area.rect.startRow &&
        row < area.rect.endRow && column >= area.rect.startColumn && column < area.rect.endColumn);
      return inside ? cells[`${sheetId}:${row}:${column}`] : undefined;
    };
    return {
      ...NO_PREVIEW_CELLS,
      entered: (sheetId, row, column) => at(sheetId, row, column)?.entered ?? null,
      shown: (sheetId, row, column) => at(sheetId, row, column)?.shown ?? null,
      formats: (sheetId, row, column) => at(sheetId, row, column)?.format ?? null,
      fontFamily: (sheetId, row, column) => at(sheetId, row, column)?.fontFamily,
      column: () => ({ size: width }),
      ...more,
    };
  };
  return { read, asked };
}

function content(preview: { content: unknown }): SpreadsheetPreview {
  return preview.content as SpreadsheetPreview;
}

/** The cell at zero-based `row` and `column` of the sheet, from whichever area shows it. */
function cellAt(areas: SpreadsheetArea[], sheetId: number, row: number, column: number) {
  let area = areas.find(candidate => candidate.sheetId === sheetId &&
    row >= candidate.row && row < candidate.row + candidate.cells.length &&
    column >= candidate.column && column < candidate.column + candidate.cells[0].length);
  if (!area) throw new Error(`No area shows ${sheetId}:${row}:${column}`);
  return area.cells[row - area.row][column - area.column];
}

const SALES = sheet(0, "Sales");
const COSTS = sheet(1, "Costs", { index: 1 });

describe("previewing a spreadsheet's queued changes", () => {
  it("ties each changed cell to the change that entered or formatted it last", async () => {
    let { read } = fakeRead({
      "0:1:1": { entered: "old", shown: "old" },
      "0:1:2": { entered: 4, shown: "$4.00", format: { italic: true } },
    });
    let preview = await previewSpreadsheet(metadata([SALES]), [
      queued(7, [{ op: "writeCells", sheetId: 0, rect: rect(1, 1, 1, 2), values: [["first", "second"]] }]),
      queued(9, [
        { op: "writeCells", sheetId: 0, rect: rect(1, 2), values: [["third"]] },
        { op: "formatCells", sheetId: 0, rect: rect(4, 2), format: { bold: true, fillColor: "#ff0000" } },
      ]),
    ], URL, read);
    expect(preview.title).toBe("Budget");
    expect(preview.url).toBe(URL);
    expect(preview.actions).toEqual([7, 9]);
    expect(preview.omitted).toBeUndefined();
    let { areas } = content(preview);
    expect(cellAt(areas, 0, 1, 1)).toEqual({ text: "first", change: 0, previous: "old" });
    expect(cellAt(areas, 0, 1, 2)).toEqual({ text: "third", change: 1, previous: "$4.00", format: { italic: true } });
    expect(cellAt(areas, 0, 4, 2)).toEqual({ change: 1, format: { bold: true, backgroundColor: "#ff0000" } });
    expect(cellAt(areas, 0, 0, 0)).toBeNull();
  });

  it("leaves a queued formula's result out, and shows a saved one", async () => {
    let { read } = fakeRead({ "0:0:0": { entered: { formula: "=1+1" }, shown: "2" } });
    let preview = await previewSpreadsheet(metadata([SALES]), [
      queued(3, [{ op: "writeCells", sheetId: 0, rect: rect(1, 0, 1, 2), values: [["=SUM(A1:A1)", 5]] }]),
    ], URL, read);
    let { areas } = content(preview);
    expect(cellAt(areas, 0, 1, 0)).toEqual({ formula: "=SUM(A1:A1)", change: 0 });
    // A number shows as entered, though its format may display it otherwise, and to the right.
    expect(cellAt(areas, 0, 1, 1)).toEqual({ text: "5", change: 0, format: { horizontalAlignment: "right" } });
    expect(cellAt(areas, 0, 0, 0)).toEqual({ text: "2", formula: "=1+1" });
  });

  it("lists sheets added and removed in tab order, and draws cells of an added sheet", async () => {
    let { read, asked } = fakeRead();
    let preview = await previewSpreadsheet(metadata([SALES, COSTS]), [
      queued(4, [
        { op: "addSheet", sheetId: 50, title: "Forecast", index: 1, rowCount: 10, columnCount: 4 },
        { op: "writeCells", sheetId: 50, rect: rect(0, 0), values: [["Q1"]] },
      ], { 50: "Forecast" }),
      queued(5, [{ op: "deleteSheet", sheetId: 1, rowCount: 20, columnCount: 6 }], { 1: "Costs" }),
    ], URL, read);
    let { sheets, areas } = content(preview);
    expect(sheets).toEqual([
      { id: 0, title: "Sales" },
      { id: 50, title: "Forecast", status: "added" },
      { id: 1, title: "Costs", status: "removed" },
    ]);
    expect(areas).toHaveLength(1);
    expect(areas[0]).toMatchObject({ sheetId: 50, row: 0, column: 0 });
    expect(areas[0].cells[0][0]).toEqual({ text: "Q1", change: 0 });
    // Nothing Google holds is drawn, so nothing is fetched, and no width is known.
    expect(asked).toEqual([[]]);
    expect(areas[0].columnWidths).toBeUndefined();
  });

  it("draws a sheet whole from A1 when its changes fall within one", async () => {
    let small = sheet(0, "Sales", { rowCount: 1000, columnCount: 26 });
    let { read } = fakeRead();
    let preview = await previewSpreadsheet(metadata([small]), [
      queued(1, [{ op: "writeCells", sheetId: 0, rect: rect(31, 2), values: [["a"]] }]),
    ], URL, read);
    let { areas } = content(preview);
    expect(areas.map(({ row, column, cells }) => [row, column, cells.length, cells[0].length]))
      .toEqual([[0, 0, 31 + 1 + CONTEXT_ROWS, EMPTY_PREVIEW.columns]]);
    expect(cellAt(areas, 0, 31, 2)).toEqual({ text: "a", change: 0 });
  });

  it("draws each change with context, merging those near each other", async () => {
    let tall = sheet(0, "Sales", { rowCount: 1000, columnCount: 26 });
    let { read } = fakeRead();
    let preview = await previewSpreadsheet(metadata([tall]), [
      queued(1, [{ op: "writeCells", sheetId: 0, rect: rect(10, 5), values: [["a"]] }]),
      queued(2, [{ op: "writeCells", sheetId: 0, rect: rect(14, 6), values: [["b"]] }]),
      queued(3, [{ op: "writeCells", sheetId: 0, rect: rect(160, 20), values: [["c"]] }]),
    ], URL, read);
    let { areas } = content(preview);
    expect(areas.map(({ row, column, cells }) => [row, column, cells.length, cells[0].length])).toEqual([
      [10 - CONTEXT_ROWS, 5 - CONTEXT_COLUMNS, 14 - 10 + 1 + 2 * CONTEXT_ROWS, 6 - 5 + 1 + 2 * CONTEXT_COLUMNS],
      [160 - CONTEXT_ROWS, 20 - CONTEXT_COLUMNS, 1 + 2 * CONTEXT_ROWS, 1 + 2 * CONTEXT_COLUMNS],
    ]);
    expect(areas[0].columnWidths).toEqual(Array(1 + 1 + 2 * CONTEXT_COLUMNS).fill(120));
    expect(cellAt(areas, 0, 14, 6)).toEqual({ text: "b", change: 1 });
    expect(cellAt(areas, 0, 160, 20)).toEqual({ text: "c", change: 2 });
  });

  it("marks rows a queued change inserts, with cells below moved down", async () => {
    let { read } = fakeRead({ "0:2:0": { entered: "kept", shown: "kept" } });
    let preview = await previewSpreadsheet(metadata([SALES]), [
      queued(1, [
        { op: "insertRows", sheetId: 0, start: 2, count: 1 },
        { op: "writeCells", sheetId: 0, rect: rect(2, 0), values: [["new"]] },
        { op: "formatCells", sheetId: 0, rect: rect(2, 1), format: { italic: true } },
      ]),
    ], URL, read);
    let [area] = content(preview).areas;
    expect(area.insertedRows).toEqual([2 - area.row]);
    expect(cellAt([area], 0, 2, 0)).toEqual({ text: "new", change: 0 });
    // What Google gives an inserted row is not known, but what is queued on it is.
    expect(cellAt([area], 0, 2, 1)).toEqual({ change: 0, format: { italic: true } });
    expect(cellAt([area], 0, 3, 0)).toEqual({ text: "kept" });
  });

  it("draws rows and columns a queued change deletes where they stood, with what they hold", async () => {
    let { read } = fakeRead({
      "0:3:0": { entered: "gone", shown: "gone" },
      "0:3:1": { entered: 4, shown: "$4.00" },
      "0:4:0": { entered: "kept", shown: "kept" },
      "0:0:2": { entered: "Notes", shown: "Notes" },
    });
    let preview = await previewSpreadsheet(metadata([SALES]), [
      queued(1, [{ op: "deleteRows", sheetId: 0, start: 3, count: 1 }]),
      queued(2, [{ op: "deleteColumns", sheetId: 0, start: 2, count: 1 }]),
    ], URL, read);
    let [area] = content(preview).areas;
    expect(area.deletedRows).toEqual([
      { before: 3 - area.row, index: 3, count: 1, change: 0, cells: [expect.arrayContaining(["gone", "$4.00"])] },
    ]);
    expect(area.deletedRows![0].cells[0]).toHaveLength(area.cells[0].length);
    expect(cellAt([area], 0, 3, 0)).toEqual({ text: "kept" });
    expect(area.deletedColumns).toEqual([
      expect.objectContaining({ before: 2 - area.column, index: 2, count: 1, change: 1, sizes: [120] }),
    ]);
    expect(area.deletedColumns![0].cells[0][0 - area.row]).toBe("Notes");
  });

  it("ties each deleted line to the change that deleted it, after earlier deletions", async () => {
    let { read } = fakeRead();
    let preview = await previewSpreadsheet(metadata([SALES]), [
      queued(1, [{ op: "deleteRows", sheetId: 0, start: 5, count: 1 }]),
      // Rows 4 to 6 as they then stand: base rows 4, 6 and 7.
      queued(2, [{ op: "deleteRows", sheetId: 0, start: 4, count: 3 }]),
    ], URL, read);
    let [area] = content(preview).areas;
    expect(area.deletedRows!.map(({ before, index, count, change }) => ({ before: before + area.row, index, count, change })))
      .toEqual([
        { before: 4, index: 4, count: 1, change: 1 },
        { before: 4, index: 5, count: 1, change: 0 },
        { before: 4, index: 6, count: 2, change: 1 },
      ]);
  });

  it("draws only the first few of many deleted rows, and counts the rest", async () => {
    let { read } = fakeRead();
    let preview = await previewSpreadsheet(metadata([sheet(0, "Sales", { rowCount: 400 })]), [
      queued(1, [{ op: "deleteRows", sheetId: 0, start: 200, count: 150 }]),
    ], URL, read);
    let area = content(preview).areas.find(candidate => candidate.deletedRows)!;
    expect(area.deletedRows).toEqual([expect.objectContaining({ before: 200 - area.row, index: 200, count: 150 })]);
    expect(area.deletedRows![0].cells).toHaveLength(5);
  });

  it("draws the top left of the first sheet when nothing is queued", async () => {
    let big = sheet(0, "Sales", { rowCount: 1000, columnCount: 26 });
    let { read, asked } = fakeRead({ "0:0:0": { entered: "Total", shown: "Total", format: { bold: true } } });
    let preview = await previewSpreadsheet(metadata([big, sheet(1, "Costs", { index: 1 })]), [], URL, read);
    expect(preview.actions).toEqual([]);
    let { areas, sheets } = content(preview);
    expect(sheets).toEqual([{ id: 0, title: "Sales" }, { id: 1, title: "Costs" }]);
    expect(areas).toHaveLength(1);
    expect(areas[0]).toMatchObject({ sheetId: 0, row: 0, column: 0 });
    expect(areas[0].cells).toHaveLength(WHOLE_SHEET.rows);
    expect(areas[0].cells[0]).toHaveLength(WHOLE_SHEET.columns);
    expect(areas[0].cells[0][0]).toEqual({ text: "Total", format: { bold: true } });
    expect(asked).toEqual([[{
      sheetId: 0, title: "Sales", rect: rect(0, 0, WHOLE_SHEET.rows, WHOLE_SHEET.columns),
    }]]);
  });

  it("omits a change that no longer applies, and those after it, with why", async () => {
    let { read } = fakeRead();
    let gone = queued(2, [{ op: "writeCells", sheetId: 9, rect: rect(0, 0), values: [["x"]] }]);
    let preview = await previewSpreadsheet(metadata([SALES]), [
      queued(1, [{ op: "writeCells", sheetId: 0, rect: rect(0, 0), values: [["kept"]] }]),
      gone,
      queued(3, [{ op: "writeCells", sheetId: 0, rect: rect(1, 0), values: [["after"]] }]),
    ], URL, read);
    let reason = conflictReason(gone, "change 1 (writeCells): the spreadsheet has no sheet with ID 9");
    expect(preview.actions).toEqual([1]);
    expect(preview.omitted).toEqual([{ action: 2, reason }, { action: 3, reason }]);
    let { areas } = content(preview);
    expect(cellAt(areas, 0, 0, 0)).toEqual({ text: "kept", change: 0 });
    expect(cellAt(areas, 0, 1, 0)).toBeNull();
  });

  it("draws as many changes as a read may fetch, and lists the rest as omitted", async () => {
    let tall = sheet(0, "Sales", { rowCount: 5000, columnCount: 26 });
    let { read, asked } = fakeRead();
    let pending = Array.from({ length: 30 }, (_, i) =>
      queued(i + 1, [{ op: "writeCells", sheetId: 0, rect: rect(i * 100, 0), values: [[`v${i}`]] }]));
    let preview = await previewSpreadsheet(metadata([tall]), pending, URL, read);
    expect(preview.actions).toHaveLength(30);
    expect(content(preview).areas).toHaveLength(20);
    expect(asked[0]).toHaveLength(20);
    expect(preview.omitted?.map(({ action }) => action)).toEqual(Array.from({ length: 10 }, (_, i) => i + 21));
  });
});

describe("drawing a spreadsheet as Google draws it", () => {
  it("draws formats as Google does, leaving out what the spreadsheet's default already says", async () => {
    let { read } = fakeRead({
      "0:0:0": {
        entered: "Total", shown: "Total", fontFamily: "Roboto",
        format: { bold: true, fontSize: 10, textColor: "#000000", verticalAlignment: "BOTTOM", wrap: "WRAP" },
      },
      "0:0:1": { entered: 1200, shown: "$1,200.00", fontFamily: "Roboto" },
      "0:0:2": { entered: true, shown: "TRUE", format: { horizontalAlignment: "LEFT" } },
      "0:5:0": { entered: { formula: "=A1" }, shown: "Total" },
    }, 120, {
      defaultFormat: { format: { fontSize: 11, verticalAlignment: "BOTTOM" }, fontFamily: "Roboto" },
      themeColor: name => name === "ACCENT1" ? "#4285f4" : undefined,
    });
    let preview = await previewSpreadsheet(metadata([SALES]), [
      queued(1, [{
        op: "formatCells", sheetId: 0, rect: rect(2, 0, 1, 2),
        format: {
          fillColor: "ACCENT1", textColor: "ACCENT6", underline: true,
          borders: { bottom: { style: "SOLID_THICK" }, top: { style: "DASHED", color: "#FF0000" } },
        },
      }]),
    ], URL, read);
    let { areas, defaultFormat } = content(preview);
    expect(defaultFormat).toEqual({ fontFamily: "Roboto", fontSize: 11 });
    // Arial 10pt black would be standard; here 10pt is not the default, and the rest is.
    expect(cellAt(areas, 0, 0, 0)).toEqual({ text: "Total", format: { bold: true, fontSize: 10, wrapStrategy: "wrap" } });
    // Sheets right-aligns a number and centres a boolean unless the cell says otherwise, but cannot
    // be known to for a formula's result.
    expect(cellAt(areas, 0, 0, 1)).toEqual({ text: "$1,200.00", format: { horizontalAlignment: "right" } });
    expect(cellAt(areas, 0, 0, 2)).toEqual({ text: "TRUE", format: { horizontalAlignment: "left" } });
    expect(cellAt(areas, 0, 5, 0)).toEqual({ text: "Total", formula: "=A1" });
    // A theme colour the theme gives is resolved; one it lacks is left out.
    expect(cellAt(areas, 0, 2, 0)).toEqual({
      change: 0,
      format: {
        underline: true, backgroundColor: "#4285f4",
        borders: { top: { style: "dashed", color: "#ff0000" }, bottom: { style: "thick", color: "#000000" } },
      },
    });
  });

  it("draws row and column sizes, hidden lines, merges and frozen lines where queued changes move them", async () => {
    let tall = sheet(0, "Sales", { rowCount: 1000, columnCount: 26, frozenRowCount: 2, frozenColumnCount: 1 });
    let { read } = fakeRead({ "0:3:1": { entered: "Merged", shown: "Merged" } }, 120, {
      row: (_sheetId, row) => row === 5 ? { size: 40, hidden: true } : { size: 21 },
      column: (_sheetId, column) => column === 2 ? { size: 60 } : { size: 100 },
      merges: () => [rect(3, 1, 3, 2), rect(0, 0, 1, 1), rect(20, 0, 2, 2)],
      hidesGridlines: () => true,
    });
    let preview = await previewSpreadsheet(metadata([tall]), [
      queued(1, [
        // A row inserted among the frozen ones is frozen, and one inside a merge widens it.
        { op: "insertRows", sheetId: 0, start: 1, count: 1 },
        { op: "insertRows", sheetId: 0, start: 5, count: 1 },
        { op: "writeCells", sheetId: 0, rect: rect(8, 3), values: [["x"]] },
      ]),
    ], URL, read);
    let { sheets, areas } = content(preview);
    expect(sheets).toEqual([{ id: 0, title: "Sales", frozenRows: 3, frozenColumns: 1, hideGridlines: true }]);
    let [area] = areas;
    expect(area).toMatchObject({ row: 0, column: 0 });
    // Rows 1 and 5 are inserted, so Google's row 5 (hidden, 40px) is drawn as row 7.
    expect(area.rowHeights?.slice(0, 8)).toEqual([21, 21, 21, 21, 21, 21, 21, 40]);
    expect(area.hiddenRows).toEqual([7]);
    expect(area.columnWidths?.slice(0, 4)).toEqual([100, 100, 60, 100]);
    // A one-cell merge is no merge; the others keep their place below the inserted rows.
    expect(area.merges).toEqual([{ row: 4, column: 1, rows: 4, columns: 2 }, { row: 22, column: 0, rows: 2, columns: 2 }]);
    expect(cellAt(areas, 0, 4, 1)).toEqual({ text: "Merged" });
  });
});

describe("reading what a preview draws", () => {
  it("takes Google's effective formats, fonts, lines, merges and theme from one answer", () => {
    let cells = previewCellsOf({
      properties: {
        defaultFormat: { textFormat: { fontFamily: "Lexend", fontSize: 10 } },
        spreadsheetTheme: { themeColors: [{ colorType: "ACCENT1", color: { rgbColor: { red: 1, blue: 0.5 } } }] },
      },
      sheets: [{
        properties: { sheetId: 7, gridProperties: { hideGridlines: true } },
        merges: [{ sheetId: 7, startRowIndex: 2, endRowIndex: 4, startColumnIndex: 1, endColumnIndex: 3 }],
        data: [{
          startRow: 2, startColumn: 1,
          rowMetadata: [{ pixelSize: 30 }, { pixelSize: 21, hiddenByFilter: true }],
          columnMetadata: [{ pixelSize: 80, hiddenByUser: true }],
          rowData: [{ values: [{
            userEnteredValue: { numberValue: 3 }, formattedValue: "3",
            effectiveFormat: {
              textFormat: { bold: true, fontFamily: "Courier New", foregroundColorStyle: { themeColor: "ACCENT1" } },
              wrapStrategy: "CLIP",
              borders: { left: { style: "DOUBLE", colorStyle: { rgbColor: { green: 1 } } } },
            },
          }] }],
        }],
      }],
    }, [{ sheetId: 7, rect: rect(2, 1, 2, 1) }]);
    expect(cells.entered(7, 2, 1)).toBe(3);
    expect(cells.formats(7, 2, 1)).toEqual({
      bold: true, textColor: "ACCENT1", wrap: "CLIP", borders: { left: { style: "DOUBLE", color: "#00ff00" } },
    });
    expect(cells.fontFamily(7, 2, 1)).toBe("Courier New");
    expect([cells.row(7, 2), cells.row(7, 3), cells.column(7, 1)])
      .toEqual([{ size: 30 }, { size: 21, hidden: true }, { size: 80, hidden: true }]);
    expect(cells.merges(7)).toEqual([rect(2, 1, 2, 2)]);
    expect(cells.hidesGridlines(7)).toBe(true);
    expect(cells.defaultFormat).toEqual({ format: { fontSize: 10 }, fontFamily: "Lexend" });
    expect(cells.themeColor("ACCENT1")).toBe("#ff0080");
  });

  it("refuses an answer missing a range it asked for", () => {
    expect(() => previewCellsOf({ sheets: [] }, [{ sheetId: 0, rect: rect(0, 0) }]))
      .toThrow("did not return every range");
  });
});

describe("Sheets entries name the spreadsheet", () => {
  it("names the spreadsheet a queued change edits", async () => {
    let journal = new ActionJournal<SheetsAction>(new FakeKv(), { namespace: "sheets" });
    let host = { spreadsheetId: "sheet-1", api: {} as GoogleSheetsApi } as SheetsHost;
    let described: ActionDescription[] = [];
    await SHEETS_ACTIONS.bind(journal, host).submit(
      { submitAction: async (_id: number, description: ActionDescription) => { described.push(description); } },
      "editSheetValues", {
        changes: [{ op: "writeCells", sheetId: 0, rect: rect(0, 0), values: [[1]] }],
        sheets: { 0: "Sales" }, title: "Budget",
        marker: { id: 1, token: "token" }, guard: { sha256: "0".repeat(64), after: [] },
      });
    expect(described[0].subject).toEqual({
      id: "sheet-1", title: "Budget", url: URL,
      mediaType: "application/vnd.google-apps.spreadsheet", role: "edited",
    });
  });
});
