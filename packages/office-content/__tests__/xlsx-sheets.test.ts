import { describe, expect, it } from "vitest";
import { applyTint } from "../src/xlsx-sheet-styles";
import { columnWidthPixels, defaultColumnWidthPixels, readWorkbookSheets, type SheetModel, type WorkbookSheets } from "../src/xlsx-sheets";
import { buildStyledXlsx, buildXlsx, fixtureRelationships, type StyledXlsxFixture } from "./test-fixtures";

const LIMITS = { maxRows: 100, maxColumns: 20 };

const read = async (fixture: StyledXlsxFixture, limits = LIMITS): Promise<WorkbookSheets> =>
  readWorkbookSheets(await buildStyledXlsx(fixture), limits);

/** The cell at a reference such as `B2`, with its style resolved. */
const cellAt = (workbook: WorkbookSheets, sheet: SheetModel, reference: string) => {
  const column = reference.charCodeAt(0) - 65;
  const cell = sheet.rows.find(row => row.index === Number(reference.slice(1)) - 1)?.cells.find(candidate => candidate.column === column);
  if (!cell) throw new Error(`No cell at ${reference}`);
  return { ...cell, style: workbook.styles[cell.style]! };
};

const text = (value: string) => `<is><t>${value}</t></is>`;

const DEFAULT_FONT = '<font><sz val="11"/><name val="Calibri"/></font>';
const NO_FILLS = '<fills><fill><patternFill patternType="none"/></fill></fills>';
const NO_BORDERS = "<borders><border/></borders>";

describe("readWorkbookSheets", () => {
  it("reads a plain workbook with Excel's defaults", async () => {
    const workbook = await readWorkbookSheets(await buildXlsx({
      sheets: [{ name: "Data", rows: '<row r="1"><c r="A1" t="inlineStr"><is><t>North</t></is></c><c r="B1"><v>1200</v></c></row>' }],
    }), LIMITS);
    expect(workbook.styles).toEqual([{
      font: { name: "Calibri", size: 11, bold: false, italic: false, underline: "none", strike: false },
      borders: {}, horizontal: "general", vertical: "bottom", wrap: false, indent: 0,
    }]);
    expect(workbook.sheets).toEqual([{
      name: "Data",
      rowCount: 1,
      columnCount: 2,
      defaultColumnWidth: 64,
      defaultRowHeight: 20,
      // The fixture's `<col min="1" max="1"/>` names a column without sizing it.
      columns: [{ index: 0, width: 64, hidden: false }],
      rows: [{
        index: 0, height: 20, hidden: false,
        cells: [{ column: 0, text: "North", kind: "text", style: 0 }, { column: 1, text: "1200", kind: "number", style: 0 }],
      }],
      merges: [],
      frozen: { rows: 0, columns: 0 },
      showGridlines: true,
      truncated: false,
      uncalculatedFormulas: false,
      undrawn: [],
    }]);
  });

  it("gives each kind of value its kind and its formatted text", async () => {
    const workbook = await read({
      styles:
        '<numFmts><numFmt numFmtId="164" formatCode="$#,##0.00;[Red]-$#,##0.00"/><numFmt numFmtId="165" formatCode="&quot;ID &quot;@"/></numFmts>' +
        `<fonts>${DEFAULT_FONT}</fonts>${NO_FILLS}${NO_BORDERS}` +
        '<cellXfs><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="14"/><xf numFmtId="9"/><xf numFmtId="165"/></cellXfs>',
      sheets: [{
        name: "Kinds",
        rows:
          '<row r="1"><c r="A1" s="1"><v>1200</v></c><c r="B1" s="1"><v>-3.5</v></c><c r="C1" s="2"><v>45000</v></c>' +
          `<c r="D1" s="3"><v>0.256</v></c><c r="E1" s="4" t="inlineStr">${text("x7")}</c></row>` +
          '<row r="2"><c r="A2" t="b"><v>0</v></c><c r="B2" t="e"><v>#N/A</v></c><c r="C2" t="str"><f>A1&amp;""</f><v>formula text</v></c>' +
          '<c r="D2"><f>1/3</f><v>0.3333333333333333</v></c><c r="E2"><f>SUM(A1:B1)</f><v></v></c></row>',
      }],
    });
    const sheet = workbook.sheets[0]!;
    const shown = (reference: string) => {
      const { text: value, kind, color } = cellAt(workbook, sheet, reference);
      return color ? [value, kind, color] : [value, kind];
    };
    expect(shown("A1")).toEqual(["$1,200.00", "number"]);
    expect(shown("B1")).toEqual(["-$3.50", "number", "#FF0000"]);
    expect(shown("C1")).toEqual(["3/15/2023", "date"]);
    expect(shown("D1")).toEqual(["26%", "number"]);
    expect(shown("E1")).toEqual(["ID x7", "text"]);
    expect(shown("A2")).toEqual(["FALSE", "boolean"]);
    expect(shown("B2")).toEqual(["#N/A", "error"]);
    expect(shown("C2")).toEqual(["formula text", "text"]);
    expect(shown("D2")).toEqual(["0.333333333", "number"]);
    // A formula never calculated has no value to show, and no style either, so it is not a cell;
    // the sheet says it has one, for a viewer to explain the gap.
    expect(sheet.rows[1]!.cells.map(cell => cell.column)).toEqual([0, 1, 2, 3]);
    expect(sheet.uncalculatedFormulas).toBe(true);
  });

  it("uses the 1904 date system when the workbook says so", async () => {
    const workbook = await read({
      date1904: true,
      styles: `<fonts>${DEFAULT_FONT}</fonts><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs>`,
      sheets: [{ name: "Mac", rows: '<row r="1"><c r="A1" s="1"><v>1</v></c></row>' }],
    });
    expect(cellAt(workbook, workbook.sheets[0]!, "A1").text).toBe("1/2/1904");
  });

  it("resolves fonts, fills, borders and alignment, sharing equal styles", async () => {
    const workbook = await read({
      styles:
        '<numFmts><numFmt numFmtId="164" formatCode="0.0"/></numFmts>' +
        `<fonts>${DEFAULT_FONT}` +
        '<font><b/><i val="1"/><u/><strike val="0"/><sz val="14"/><color rgb="FFFF0000"/><name val="Arial"/></font>' +
        '<font><u val="doubleAccounting"/><strike/><color auto="1"/></font></fonts>' +
        '<fills><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
        '<fill><patternFill patternType="solid"><fgColor rgb="FFFFC7CE"/><bgColor indexed="64"/></patternFill></fill>' +
        '<fill><patternFill patternType="mediumGray"><fgColor rgb="FF000000"/><bgColor rgb="FFFFFFFF"/></patternFill></fill></fills>' +
        '<borders><border/><border><left style="thin"><color auto="1"/></left><right style="medium"><color rgb="FF00B050"/></right>' +
        '<top style="double"><color indexed="10"/></top><bottom style="none"/><diagonal style="thin"/></border></borders>' +
        '<cellXfs><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>' +
        '<xf numFmtId="0" fontId="1" fillId="2" borderId="1"><alignment horizontal="center" vertical="top" wrapText="1" indent="2"/></xf>' +
        // Differs from the one before only in its number format, so it shares the style.
        '<xf numFmtId="164" fontId="1" fillId="2" borderId="1"><alignment horizontal="center" vertical="top" wrapText="1" indent="2"/></xf>' +
        '<xf numFmtId="0" fontId="2" fillId="3" borderId="0"><alignment horizontal="right"/></xf></cellXfs>',
      sheets: [{
        name: "Styled",
        rows: `<row r="1"><c r="A1" s="1" t="inlineStr">${text("a")}</c><c r="B1" s="2"><v>2</v></c><c r="C1" s="3" t="inlineStr">${text("c")}</c></row>`,
      }],
    });
    const sheet = workbook.sheets[0]!;
    expect(cellAt(workbook, sheet, "A1").style).toEqual({
      font: { name: "Arial", size: 14, bold: true, italic: true, underline: "single", strike: false, color: "#FF0000" },
      fill: "#FFC7CE",
      borders: {
        top: { style: "double", color: "#FF0000" },
        right: { style: "medium", color: "#00B050" },
        left: { style: "thin", color: "#000000" },
      },
      horizontal: "center", vertical: "top", wrap: true, indent: 2,
    });
    expect(sheet.rows[0]!.cells.map(cell => cell.style)).toEqual([1, 1, 2]);
    expect(cellAt(workbook, sheet, "B1").text).toBe("2.0");
    expect(cellAt(workbook, sheet, "C1").style).toEqual({
      // A font that names no face or size takes the default font's.
      font: { name: "Calibri", size: 11, bold: false, italic: false, underline: "double", strike: true },
      // A pattern is drawn as the colour it averages to.
      fill: "#808080",
      borders: {}, horizontal: "right", vertical: "bottom", wrap: false, indent: 0,
    });
    expect(workbook.styles).toHaveLength(3);
  });

  it("resolves theme colours with tint, indexed colours and a workbook's own palette", async () => {
    const workbook = await read({
      themeColors:
        '<a:dk1><a:sysClr val="windowText" lastClr="111111"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
        '<a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1>',
      styles:
        `<fonts>${DEFAULT_FONT}<font><color theme="1"/></font><font><color theme="4"/></font><font><color theme="4" tint="0.4"/></font>` +
        '<font><color theme="4" tint="-0.25"/></font><font><color theme="0" tint="-0.15"/></font><font><color indexed="12"/></font>' +
        '<font><color indexed="64"/></font><font><color theme="5"/></font><font><color theme="99"/></font></fonts>' +
        '<cellXfs><xf fontId="0"/><xf fontId="1"/><xf fontId="2"/><xf fontId="3"/><xf fontId="4"/><xf fontId="5"/><xf fontId="6"/><xf fontId="7"/><xf fontId="8"/><xf fontId="9"/></cellXfs>',
      sheets: [{
        name: "Colours",
        rows: `<row r="1">${Array.from({ length: 9 }, (_, index) => `<c r="${String.fromCharCode(65 + index)}1" s="${index + 1}"><v>1</v></c>`).join("")}</row>`,
      }],
    });
    const colors = workbook.sheets[0]!.rows[0]!.cells.map(cell => workbook.styles[cell.style]!.font.color);
    expect(colors).toEqual([
      // theme 1 is dk1 (the scheme's first entry): the index swaps each light and dark pair.
      "#111111",
      "#4472C4",
      // Excel's "Accent 1, Lighter 40%" and "Darker 25%".
      "#8FAADC",
      "#2F5597",
      // "White, Darker 15%".
      "#D9D9D9",
      "#0000FF",
      // The system colour is the automatic one.
      undefined,
      // An entry the theme part leaves out comes from the Office theme.
      "#C0504D",
      undefined,
    ]);

    const custom = await read({
      styles:
        `<fonts>${DEFAULT_FONT}<font><color indexed="2"/></font></fonts><cellXfs><xf fontId="0"/><xf fontId="1"/></cellXfs>` +
        '<colors><indexedColors><rgbColor rgb="00000000"/><rgbColor rgb="00FFFFFF"/><rgbColor rgb="00123456"/></indexedColors></colors>',
      sheets: [{ name: "Palette", rows: '<row r="1"><c r="A1" s="1"><v>1</v></c></row>' }],
    });
    expect(cellAt(custom, custom.sheets[0]!, "A1").style.font.color).toBe("#123456");
  });

  it("converts column widths and row heights to pixels", async () => {
    const workbook = await read({
      styles: `<fonts>${DEFAULT_FONT}<font><sz val="20"/></font></fonts><cellXfs><xf fontId="0"/><xf fontId="1"/><xf fontId="0"><alignment wrapText="1"/></xf></cellXfs>`,
      sheets: [{
        name: "Sizes",
        before:
          '<sheetFormatPr baseColWidth="10" defaultRowHeight="18"/>' +
          '<cols><col min="2" max="3" width="21.42578125" customWidth="1"/><col min="5" max="16384" width="9.140625" hidden="1"/></cols>',
        rows:
          `<row r="1" ht="30" customHeight="1"><c r="A1" t="inlineStr">${text("tall")}</c></row>` +
          `<row r="2"><c r="A2" s="1" t="inlineStr">${text("big font")}</c></row>` +
          `<row r="3"><c r="A3" s="2" t="inlineStr"><is><t>one\ntwo\nthree</t></is></c></row>` +
          `<row r="4"><c r="A4" t="inlineStr">${text("plain")}</c></row>`,
      }],
    });
    const sheet = workbook.sheets[0]!;
    // 10 digits of 7 pixels and 5 of padding, rounded up to a multiple of 8.
    expect(sheet.defaultColumnWidth).toBe(80);
    expect(sheet.defaultRowHeight).toBe(24);
    expect(sheet.columns.slice(0, 3)).toEqual([
      { index: 1, width: 150, hidden: false },
      { index: 2, width: 150, hidden: false },
      { index: 4, width: 64, hidden: true },
    ]);
    // A column range that runs to the sheet's edge stops at the limit.
    expect(sheet.columns.at(-1)).toEqual({ index: 19, width: 64, hidden: true });
    // A stored height in points; otherwise what the row's tallest font or wrapped lines need.
    expect(sheet.rows.map(row => row.height)).toEqual([40, 35, 56, 24]);
  });

  it("measures widths in the default font's digit width", () => {
    // Calibri 11: Excel's 8.43-character default is stored as 9.140625 and is 64 pixels wide.
    expect(columnWidthPixels(9.140625, 7)).toBe(64);
    expect(columnWidthPixels(8.7109375, 7)).toBe(61);
    expect(columnWidthPixels(21.42578125, 7)).toBe(150);
    expect(columnWidthPixels(0, 7)).toBe(0);
    expect(defaultColumnWidthPixels(8, 7)).toBe(64);
    expect(defaultColumnWidthPixels(8, 8)).toBe(72);
  });

  it("reads hidden rows, frozen panes, gridlines and merges", async () => {
    const workbook = await read({
      sheets: [{
        name: "Layout",
        before:
          '<sheetViews><sheetView showGridLines="0" workbookViewId="0"><pane xSplit="1" ySplit="2" topLeftCell="B3" activePane="bottomRight" state="frozen"/></sheetView></sheetViews>',
        rows:
          `<row r="1"><c r="A1" t="inlineStr">${text("Title")}</c></row>` +
          '<row r="2" hidden="1"><c r="A2"><v>1</v></c></row>' +
          '<row r="5" hidden="true"/>',
        after:
          '<mergeCells count="5"><mergeCell ref="A1:D1"/><mergeCell ref="B3:C8"/><mergeCell ref="C8:F9"/><mergeCell ref="E2:E2"/><mergeCell ref="S99:ZZ200"/><mergeCell ref="nonsense"/></mergeCells>',
      }],
    });
    const sheet = workbook.sheets[0]!;
    expect(sheet.showGridlines).toBe(false);
    expect(sheet.frozen).toEqual({ rows: 2, columns: 1 });
    expect(sheet.rows.map(row => [row.index, row.hidden])).toEqual([[0, false], [1, true], [4, true]]);
    expect(sheet.merges).toEqual([
      { top: 0, left: 0, bottom: 0, right: 3 },
      { top: 2, left: 1, bottom: 7, right: 2 },
      // C8:F9 overlaps B3:C8 and E2:E2 is one cell, so neither is a merge; the last is cut to the limits.
      { top: 98, left: 18, bottom: 99, right: 19 },
    ]);
    // Merges count toward the sheet's extent though their cells are empty.
    expect([sheet.rowCount, sheet.columnCount]).toEqual([100, 20]);
  });

  it("ignores a split that is not frozen", async () => {
    const workbook = await read({
      sheets: [{ name: "Split", before: '<sheetViews><sheetView workbookViewId="0"><pane xSplit="2400" ySplit="1200" state="split"/></sheetView></sheetViews>', rows: "" }],
    });
    expect(workbook.sheets[0]!.frozen).toEqual({ rows: 0, columns: 0 });
    expect(workbook.sheets[0]!.showGridlines).toBe(true);
  });

  it("formats an unstyled cell's value with its row's or column's number format", async () => {
    const workbook = await read({
      styles: `<fonts>${DEFAULT_FONT}</fonts><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="9"/></cellXfs>`,
      sheets: [{
        name: "Formats",
        before: '<cols><col min="1" max="1" width="12" style="1"/></cols>',
        rows:
          '<row r="1"><c r="A1"><v>45000</v></c><c r="B1"><v>45000</v></c></row>' +
          '<row r="2" s="2" customFormat="1"><c r="A2"><v>0.25</v></c></row>',
      }],
    });
    const sheet = workbook.sheets[0]!;

    expect(sheet.rows[0]!.cells.map(cell => cell.text)).toEqual(["3/15/2023", "45000"]);
    // The row's format comes before the column's.
    expect(sheet.rows[1]!.cells.map(cell => cell.text)).toEqual(["25%"]);
  });

  it("puts a date stored as ISO text through the cell's date format", async () => {
    const workbook = await read({
      styles: `<fonts>${DEFAULT_FONT}</fonts><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="22"/></cellXfs>`,
      sheets: [{
        name: "Dates",
        rows:
          '<row r="1"><c r="A1" t="d" s="1"><v>2023-03-15T00:00:00Z</v></c><c r="B1" t="d" s="2"><v>2023-03-15T18:00:00</v></c>' +
          '<c r="C1" t="d"><v>2023-03-15</v></c><c r="D1" t="d"><v>2023-03-15T18:00:00Z</v></c><c r="E1" t="d" s="1"><v>1900-02-28</v></c>' +
          '<c r="F1" t="d" s="1"><v>soon</v></c></row>',
      }],
    });
    expect(workbook.sheets[0]!.rows[0]!.cells.map(cell => cell.text)).toEqual([
      "3/15/2023", "3/15/2023 18:00", "2023-03-15", "2023-03-15 18:00:00", "2/28/1900", "soon",
    ]);
  });

  it("shows the first of a row's cells that name one place, without formatting the rest", async () => {
    const workbook = await read({
      sheets: [{ name: "Repeats", rows: `<row r="1">${'<c r="A1"><v>1</v></c>'.repeat(1_000)}<c r="A1"><v>2</v></c><c r="B1"><v>3</v></c></row>` }],
    });
    expect(workbook.sheets[0]!.rows[0]!.cells.map(cell => `${cell.column}:${cell.text}`)).toEqual(["0:1", "1:3"]);
  });

  it("gives cells with no style of their own their row's, then their column's", async () => {
    const workbook = await read({
      styles:
        `<fonts>${DEFAULT_FONT}<font><b/></font><font><i/></font></fonts>` +
        '<cellXfs><xf fontId="0"/><xf fontId="1"/><xf fontId="2"/></cellXfs>',
      sheets: [{
        name: "Defaults",
        before: '<cols><col min="2" max="2" width="9" style="2"/></cols>',
        rows:
          '<row r="1" s="1" customFormat="1"><c r="A1"><v>1</v></c><c r="B1"><v>2</v></c><c r="C1" s="0"><v>3</v></c></row>' +
          // `s` on a row means nothing without `customFormat`.
          '<row r="2" s="1"><c r="A2"><v>4</v></c><c r="B2"><v>5</v></c></row>' +
          '<row r="3" s="1" customFormat="1"/>',
      }],
    });
    const sheet = workbook.sheets[0]!;
    const fonts = (row: number) => sheet.rows[row]!.cells.map(cell => {
      const { bold, italic } = workbook.styles[cell.style]!.font;
      return bold ? "bold" : italic ? "italic" : "plain";
    });
    expect(fonts(0)).toEqual(["bold", "bold", "plain"]);
    expect(fonts(1)).toEqual(["plain", "italic"]);
    // The model carries both defaults for the cells the file does not list.
    expect(sheet.columns).toEqual([{ index: 1, width: 63, hidden: false, style: 2 }]);
    expect(sheet.rows.map(row => row.style)).toEqual([1, undefined, 1]);
    // A styled cell with no value is still a cell: it may carry a fill or a border.
    const styledEmpty = await read({
      styles: `<fonts>${DEFAULT_FONT}</fonts>${NO_FILLS}<cellXfs><xf/><xf/></cellXfs>`,
      sheets: [{ name: "Empty", rows: '<row r="1"><c r="B1" s="1"/><c r="C1"/></row>' }],
    });
    expect(styledEmpty.sheets[0]!.rows[0]!.cells).toEqual([{ column: 1, text: "", kind: "text", style: 0 }]);
  });

  it("attaches hyperlinks to their cells without following them", async () => {
    const workbook = await read({
      sheets: [{
        name: "Links",
        rows:
          `<row r="1"><c r="A1" t="inlineStr">${text("site")}</c><c r="B1" t="inlineStr">${text("place")}</c><c r="C1" t="inlineStr">${text("none")}</c></row>` +
          `<row r="2"><c r="A2" t="inlineStr">${text("range")}</c><c r="B2" t="inlineStr">${text("script")}</c></row>`,
        after:
          '<hyperlinks><hyperlink ref="A1" r:id="rIdLink"/><hyperlink ref="B1" location="Notes!A1" display="place"/>' +
          '<hyperlink ref="A2:A3" r:id="rIdAnchor" location="top"/><hyperlink ref="B2" r:id="rIdScript"/><hyperlink ref="C1" r:id="rIdMissing"/></hyperlinks>',
        relationships: [
          { id: "rIdLink", type: "hyperlink", target: "https://example.com/a?b=1", external: true },
          { id: "rIdAnchor", type: "hyperlink", target: "https://example.com/page", external: true },
          { id: "rIdScript", type: "hyperlink", target: "javascript:alert(1)", external: true },
        ],
      }],
    });
    const sheet = workbook.sheets[0]!;
    expect(sheet.rows.map(row => row.cells.map(cell => cell.hyperlink))).toEqual([
      ["https://example.com/a?b=1", "#Notes!A1", undefined],
      // The target is reported as written, whatever its scheme: showing it is the viewer's decision.
      ["https://example.com/page#top", "javascript:alert(1)"],
    ]);
  });

  it("drops a link target too long to be an address, and counts each cell's copy against the workbook's text", async () => {
    const cells = (row: number) => Array.from({ length: 20 }, (_, column) =>
      `<c r="${String.fromCharCode(65 + column)}${row}" t="inlineStr">${text("x")}</c>`).join("");
    const workbook = await read({
      sheets: [{
        name: "Links",
        rows: Array.from({ length: 40 }, (_, row) => `<row r="${row + 1}">${cells(row + 1)}</row>`).join(""),
        after: '<hyperlinks><hyperlink ref="A1:T40" r:id="rIdLong"/><hyperlink ref="A1" r:id="rIdHuge"/></hyperlinks>',
        relationships: [
          { id: "rIdLong", type: "hyperlink", target: `https://example.com/${"a".repeat(8_000)}`, external: true },
          { id: "rIdHuge", type: "hyperlink", target: `https://example.com/${"a".repeat(10_000)}`, external: true },
        ],
      }],
    });
    const links = workbook.sheets[0]!.rows.flatMap(row => row.cells.map(cell => cell.hyperlink));
    // 800 copies of an 8,000-character address would pass the workbook's budget of 4 million.
    expect(links[0]).toMatch(/^https:\/\/example\.com\/a{8000}$/);
    expect(links.filter(Boolean).length).toBeLessThan(500);
    expect(links.at(-1)).toBeUndefined();
    expect(workbook.sheets[0]!.truncated).toBe(true);
  });

  it("reports what a sheet holds that is not in the model", async () => {
    const X14 = "http://schemas.microsoft.com/office/spreadsheetml/2009/9/main";
    const XDR = "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing";
    const workbook = await read({
      sheets: [
        {
          name: "Busy",
          rows: '<row r="1"><c r="A1"><v>1</v></c></row>',
          after:
            '<conditionalFormatting sqref="A1"><cfRule type="cellIs" priority="1" operator="greaterThan"><formula>0</formula></cfRule></conditionalFormatting>' +
            '<dataValidations count="1"><dataValidation type="list" sqref="B1"><formula1>"Yes,No"</formula1></dataValidation></dataValidations>' +
            '<drawing r:id="rIdDrawing"/><legacyDrawing r:id="rIdVml"/>' +
            `<extLst><ext uri="{05C60535-1F16-4fd2-B633-F4F36F0B64E0}"><x14:sparklineGroups xmlns:x14="${X14}"><x14:sparklineGroup/></x14:sparklineGroups></ext></extLst>`,
          relationships: [
            { id: "rIdDrawing", type: "drawing", target: "../drawings/drawing1.xml" },
            { id: "rIdVml", type: "vmlDrawing", target: "../drawings/vmlDrawing1.vml" },
            { id: "rIdComments", type: "comments", target: "../comments1.xml" },
            { id: "rIdPivot", type: "pivotTable", target: "../pivotTables/pivotTable1.xml" },
          ],
        },
        { name: "Quiet", rows: '<row r="1"><c r="A1"><v>1</v></c></row>' },
        {
          name: "Extensions",
          rows: "",
          after: `<extLst><ext uri="{78C0D931-6437-407d-A8EE-F0AAD7539E65}"><x14:conditionalFormattings xmlns:x14="${X14}"/></ext></extLst>`,
        },
      ],
      parts: {
        "xl/drawings/drawing1.xml":
          `<xdr:wsDr xmlns:xdr="${XDR}"><xdr:twoCellAnchor><xdr:graphicFrame/></xdr:twoCellAnchor>` +
          "<xdr:oneCellAnchor><xdr:pic/></xdr:oneCellAnchor><xdr:twoCellAnchor><xdr:sp/></xdr:twoCellAnchor></xdr:wsDr>",
        "xl/drawings/_rels/drawing1.xml.rels": fixtureRelationships([{ id: "rId1", type: "chart", target: "../charts/chart1.xml" }]),
      },
    });
    expect(workbook.sheets.map(sheet => sheet.undrawn)).toEqual([
      ["charts", "comments", "conditionalFormatting", "dataValidation", "images", "pivotTables", "shapes", "sparklines"],
      [],
      ["conditionalFormatting"],
    ]);
  });

  it("keeps no more of a cell's text than it can show, however many cells share a long string", async () => {
    const workbook = await readWorkbookSheets(await buildXlsx({
      strings: `<si><t>${"x".repeat(100_000)}</t></si>`,
      sheets: [{ name: "Shared", rows: `<row r="1">${Array.from({ length: 20 }, (_, index) => `<c r="${String.fromCharCode(65 + index)}1" t="s"><v>0</v></c>`).join("")}</row>` }],
    }), LIMITS);
    const [sheet] = workbook.sheets;
    expect(sheet!.rows[0]!.cells.map(cell => cell.text.length)).toEqual(Array.from({ length: 20 }, () => 2_000));
    expect(sheet!.truncated).toBe(false);
  });

  it("stops at the row and column limits and says so", async () => {
    const workbook = await read({
      sheets: [
        { name: "Tall", rows: '<row r="1"><c r="A1"><v>1</v></c></row><row r="2"><c r="A2"><v>2</v></c></row><row r="3"><c r="A3"><v>3</v></c></row>' },
        { name: "Wide", rows: '<row r="1"><c r="A1"><v>1</v></c><c r="C1"><v>3</v></c></row>' },
        // Styled but empty cells past the limit are not content anyone is missing.
        { name: "Fits", rows: '<row r="1"><c r="A1"><v>1</v></c><c r="C1" s="0"/></row>' },
      ],
    }, { maxRows: 2, maxColumns: 2 });
    expect(workbook.sheets.map(sheet => [sheet.truncated, sheet.rowCount, sheet.columnCount])).toEqual([[true, 2, 1], [true, 1, 1], [false, 1, 1]]);
  });

  it("puts rows and cells in order whatever order the file lists them in", async () => {
    const workbook = await read({
      sheets: [{
        name: "Shuffled",
        rows: '<row r="3"><c r="B3"><v>4</v></c><c r="A3"><v>3</v></c></row><row r="1"><c><v>1</v></c><c><v>2</v></c></row><row><c><v>5</v></c></row>',
      }],
    });
    expect(workbook.sheets[0]!.rows.map(row => [row.index, row.cells.map(cell => `${cell.column}:${cell.text}`)])).toEqual([
      [0, ["0:1", "1:2"]],
      // A row with no `r` follows the one before it in the file.
      [1, ["0:5"]],
      [2, ["0:3", "1:4"]],
    ]);
  });

  it("leaves out hidden sheets and keeps tab order", async () => {
    const bytes = await buildXlsx({
      sheets: [{ name: "Second", rows: "" }, { name: "Secret", state: "hidden", rows: "" }, { name: "First", rows: "" }],
    });
    expect((await readWorkbookSheets(bytes, LIMITS)).sheets.map(sheet => sheet.name)).toEqual(["Second", "First"]);
  });
});

describe("applyTint", () => {
  it.each([
    ["#4472C4", 0.8, "#DAE3F3"],
    ["#4472C4", 0.6, "#B4C7E7"],
    ["#4472C4", -0.5, "#203864"],
    ["#000000", 0.5, "#808080"],
    ["#FFFFFF", -0.5, "#808080"],
    ["#FF0000", 0, "#FF0000"],
  ])("tints %s by %d to %s", (color, tint, expected) => {
    expect(applyTint(color, tint)).toBe(expected);
  });
});
