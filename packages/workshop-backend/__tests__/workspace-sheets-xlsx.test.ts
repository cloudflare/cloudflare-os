import { describe, expect, it, vi } from "vitest";
import { ExportHandler, Gadget } from "../format-blueprints/workspace-sheets/files/server.js";
import { workbookToXlsx } from "../format-blueprints/workspace-sheets/files/xlsx.js";
import { createZip, crc32 } from "../format-blueprints/workspace-sheets/files/zip.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type ZipEntry = {
  bytes: Uint8Array;
  compressedSize: number;
  crc: number;
  flags: number;
  localOffset: number;
  method: number;
  uncompressedSize: number;
};

async function streamBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function uint16(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true);
}

function uint32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const input = new Response(bytes).body!.pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(input).arrayBuffer());
}

async function readZip(stream: ReadableStream<Uint8Array>) {
  const archive = await streamBytes(stream);
  const eocdOffset = archive.byteLength - 22;
  expect(uint32(archive, eocdOffset)).toBe(0x06054b50);
  expect(uint16(archive, eocdOffset + 4)).toBe(0);
  expect(uint16(archive, eocdOffset + 6)).toBe(0);
  const entryCount = uint16(archive, eocdOffset + 10);
  expect(uint16(archive, eocdOffset + 8)).toBe(entryCount);
  const centralSize = uint32(archive, eocdOffset + 12);
  const centralOffset = uint32(archive, eocdOffset + 16);
  expect(centralOffset + centralSize).toBe(eocdOffset);

  const entries = new Map<string, ZipEntry>();
  let offset = centralOffset;
  for (let i = 0; i < entryCount; ++i) {
    expect(uint32(archive, offset)).toBe(0x02014b50);
    const flags = uint16(archive, offset + 8);
    const method = uint16(archive, offset + 10);
    const crc = uint32(archive, offset + 16);
    const compressedSize = uint32(archive, offset + 20);
    const uncompressedSize = uint32(archive, offset + 24);
    const nameLength = uint16(archive, offset + 28);
    const extraLength = uint16(archive, offset + 30);
    const commentLength = uint16(archive, offset + 32);
    const localOffset = uint32(archive, offset + 42);
    const name = decoder.decode(archive.subarray(offset + 46, offset + 46 + nameLength));

    expect(uint32(archive, localOffset)).toBe(0x04034b50);
    expect(uint16(archive, localOffset + 6)).toBe(flags);
    expect(uint16(archive, localOffset + 8)).toBe(method);
    expect(uint16(archive, localOffset + 10)).toBe(0);
    expect(uint16(archive, localOffset + 12)).toBe(33);
    expect(uint32(archive, localOffset + 14)).toBe(0);
    expect(uint32(archive, localOffset + 18)).toBe(0);
    expect(uint32(archive, localOffset + 22)).toBe(0);
    const localNameLength = uint16(archive, localOffset + 26);
    const localExtraLength = uint16(archive, localOffset + 28);
    expect(decoder.decode(archive.subarray(localOffset + 30, localOffset + 30 + localNameLength))).toBe(name);

    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = archive.subarray(dataOffset, dataOffset + compressedSize);
    const descriptorOffset = dataOffset + compressedSize;
    expect(uint32(archive, descriptorOffset)).toBe(0x08074b50);
    expect(uint32(archive, descriptorOffset + 4)).toBe(crc);
    expect(uint32(archive, descriptorOffset + 8)).toBe(compressedSize);
    expect(uint32(archive, descriptorOffset + 12)).toBe(uncompressedSize);

    const bytes = await inflate(compressed);
    expect(bytes.byteLength).toBe(uncompressedSize);
    expect(crc32(bytes)).toBe(crc);
    entries.set(name, {bytes, compressedSize, crc, flags, localOffset, method, uncompressedSize});
    offset += 46 + nameLength + extraLength + commentLength;
  }
  expect(offset).toBe(eocdOffset);
  return {archive, entries};
}

function text(entries: Map<string, ZipEntry>, name: string): string {
  const entry = entries.get(name);
  expect(entry, name).toBeDefined();
  return decoder.decode(entry!.bytes);
}

function cell(value: unknown, fmt: Record<string, unknown> | null = null) {
  return {value, fmt, version: 1};
}

function sheet(name: string, extra: Record<string, unknown> = {}) {
  return {
    id: name,
    name,
    rows: 100,
    cols: 26,
    colWidths: {},
    rowHeights: {},
    frozenRows: 0,
    frozenCols: 0,
    ...extra,
  };
}

function cellXml(xml: string, reference: string): string {
  const match = new RegExp(`<c r="${reference}"[^>]*?/>|<c r="${reference}"[^>]*>[\\s\\S]*?</c>`).exec(xml);
  expect(match, reference).not.toBeNull();
  return match![0];
}

function styleId(xml: string, reference: string): string | undefined {
  return / s="(\d+)"/.exec(cellXml(xml, reference))?.[1];
}

function handler(): ExportHandler {
  return Object.create(ExportHandler.prototype) as ExportHandler;
}

// A Gadget over in-memory storage, for exercising the mutation queue without a Durable Object.
function inMemoryGadget(subscribers: Map<unknown, unknown> = new Map()) {
  const stored = new Map<string, unknown>([
    ["meta", {revision: 0, title: "Test", sheetOrder: ["sheet"], sheets: {sheet: sheet("Sheet")}, lastModified: 0}],
    ["cells:sheet", {}],
  ]);
  return Object.assign(Object.create(Gadget.prototype), {
    ctx: {
      storage: {
        get: async (key: string) => stored.get(key),
        put: async (key: string, value: unknown) => { stored.set(key, value); },
        delete: async (key: string) => stored.delete(key),
      },
    },
    mutationQueue: Promise.resolve(),
    subscribers,
  }) as Gadget;
}

function setCell(ref: string, value: string, baseVersion = 0) {
  return {senderId: "test", cellOps: [{sheetId: "sheet", ref, value, fmt: null, baseVersion}]};
}

describe("streaming ZIP32", () => {
  it("calculates CRC32 and emits valid descriptor-based deflate entries", async () => {
    expect(crc32(encoder.encode("123456789"))).toBe(0xcbf43926);
    const chunks = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("streamed "));
        controller.enqueue(encoder.encode("content"));
        controller.close();
      },
    });

    const {entries} = await readZip(createZip([
      {name: "plain.txt", data: "hello"},
      {name: "nested/utf8-\u2603.txt", data: chunks},
    ]));

    expect([...entries.keys()]).toEqual(["plain.txt", "nested/utf8-\u2603.txt"]);
    expect(text(entries, "plain.txt")).toBe("hello");
    expect(text(entries, "nested/utf8-\u2603.txt")).toBe("streamed content");
    for (const entry of entries.values()) {
      expect(entry.flags).toBe(0x0808);
      expect(entry.method).toBe(8);
      expect(entry.compressedSize).toBeGreaterThan(0);
    }
  });
});

describe("Workspace Sheets XLSX", () => {
  it("emits the required OOXML package and a valid blank worksheet for malformed state", async () => {
    for (const document of [{}, {sheetOrder: ["empty"], sheets: {empty: sheet("")}, cells: {empty: {}}}]) {
      const {entries} = await readZip(workbookToXlsx(document));
      expect([...entries.keys()]).toEqual([
        "[Content_Types].xml",
        "_rels/.rels",
        "xl/workbook.xml",
        "xl/_rels/workbook.xml.rels",
        "xl/styles.xml",
        "xl/worksheets/sheet1.xml",
      ]);
      expect(text(entries, "[Content_Types].xml")).toContain("spreadsheetml.sheet.main+xml");
      expect(text(entries, "_rels/.rels")).toContain('Target="xl/workbook.xml"');
      expect(text(entries, "xl/_rels/workbook.xml.rels")).toContain('Target="worksheets/sheet1.xml"');
      expect(text(entries, "xl/_rels/workbook.xml.rels")).toContain('Target="styles.xml"');
      expect(text(entries, "xl/workbook.xml")).toContain('<sheet name="Sheet" sheetId="1" r:id="rId1"/>');
      expect(text(entries, "xl/worksheets/sheet1.xml")).toContain("<sheetData></sheetData>");
    }
  });

  it("preserves sheet order, normalizes names, and rewrites recognized formula references", async () => {
    const longName = "This worksheet name is substantially longer than Excel permits";
    const document = {
      sheetOrder: ["a", "a", "b", "c", "d", "e", "f", "g", "h", "i"],
      sheets: {
        a: sheet("Sales/Data"),
        b: sheet("sales_data"),
        c: sheet("Sales/Data"),
        d: sheet(longName),
        e: sheet("   "),
        f: sheet("History"),
        g: sheet("O'Brien"),
        h: sheet("[Book.xlsx]Data"),
        i: sheet("Q[1]"),
      },
      cells: {
        a: {A1: cell("1")},
        b: {A1: cell("2")},
        c: {
          A1: cell('=\'Sales/Data\'!A1+sales_data!$A$1+"Sales/Data!A1"+History!A1+\'O\'\'Brien\'!A1'),
          A2: cell("='[Book.xlsx]Data'!A1+[Other.xlsx]'Sales/Data'!A1+'Q[1]'!A1+" +
              "'Sales/Data':'History'!A1+'Missing'!A1+'Sales/Data'!NOPE+foo'Sales/Data'!A1"),
        },
        d: {},
        e: {},
        f: {A1: cell("3")},
        g: {A1: cell("4")},
        h: {A1: cell("5")},
        i: {A1: cell("6")},
      },
    };
    const {entries} = await readZip(workbookToXlsx(document));
    const workbook = text(entries, "xl/workbook.xml");
    const names = [...workbook.matchAll(/<sheet name="([^"]*)"/g)].map(match => match[1]);
    expect(names).toEqual([
      "Sales_Data",
      "sales_data (2)",
      "Sales_Data (3)",
      longName.slice(0, 31),
      "Sheet",
      "History_",
      "O&apos;Brien",
      "_Book.xlsx_Data",
      "Q_1_",
    ]);
    const worksheet = text(entries, "xl/worksheets/sheet3.xml");
    const formulaCell = cellXml(worksheet, "A1");
    expect(formulaCell).toContain('<f>\'Sales_Data\'!A1+\'sales_data (2)\'!$A$1+"Sales/Data!A1"+\'History_\'!A1+\'O\'\'Brien\'!A1</f>');
    expect(formulaCell).not.toContain("<v>");
    expect(cellXml(worksheet, "A2")).toContain(
        "<f>'_Book.xlsx_Data'!A1+[Other.xlsx]'Sales/Data'!A1+'Q_1_'!A1+" +
        "'Sales/Data':'History'!A1+'Missing'!A1+'Sales/Data'!NOPE+foo'Sales/Data'!A1</f>");
    expect(workbook).toContain('<calcPr calcId="0" fullCalcOnLoad="1"/>');
  });

  it("preserves many maximum-length formulas with unmatched apostrophes", async () => {
    const formula = "'".repeat(8191);
    const cells = Object.fromEntries(Array.from({length: 64}, (_, index) => [
      `A${index + 1}`,
      cell("=" + formula),
    ]));
    const {entries} = await readZip(workbookToXlsx({
      sheetOrder: ["formulas"],
      sheets: {formulas: sheet("Formulas", {rows: 64, cols: 1})},
      cells: {formulas: cells},
    }));
    const worksheet = text(entries, "xl/worksheets/sheet1.xml");

    expect(worksheet.split(`<f>${formula}</f>`)).toHaveLength(65);
  });

  it("does not lengthen maximum-size formulas when unquoted sheet names are unchanged", async () => {
    const value = "=data!A1" + "+0".repeat(4092);
    expect(value).toHaveLength(8192);
    const {entries} = await readZip(workbookToXlsx({
      sheetOrder: ["data", "formulas"],
      sheets: {data: sheet("Data"), formulas: sheet("Formulas")},
      cells: {data: {A1: cell("1")}, formulas: {A1: cell(value)}},
    }));

    expect(cellXml(text(entries, "xl/worksheets/sheet2.xml"), "A1"))
      .toContain(`<f>${value.slice(1)}</f>`);
  });

  it("exports formulas as text when required rewrites exceed Excel's length limit", async () => {
    const renamed = "=A_B!A10" + "+0".repeat(4092);
    const future = "=IFS(TRUE,1)" + "+0".repeat(4090);
    expect(renamed).toHaveLength(8192);
    expect(future).toHaveLength(8192);
    const {entries} = await readZip(workbookToXlsx({
      sheetOrder: ["invalid", "collision", "formulas"],
      sheets: {
        invalid: sheet("A/B"),
        collision: sheet("A_B"),
        formulas: sheet("Formulas"),
      },
      cells: {invalid: {}, collision: {}, formulas: {A1: cell(renamed), A2: cell(future)}},
    }));
    const worksheet = text(entries, "xl/worksheets/sheet3.xml");

    expect(cellXml(worksheet, "A1"))
      .toBe(`<c r="A1" t="inlineStr"><is><t xml:space="preserve">${renamed}</t></is></c>`);
    expect(cellXml(worksheet, "A2"))
      .toBe(`<c r="A2" t="inlineStr"><is><t xml:space="preserve">${future}</t></is></c>`);
  });

  it("prefixes OOXML future functions without changing strings, sheet references, or existing prefixes", async () => {
    const calls = [
      "IFS(TRUE,1)", "IFNA(A1,0)", "XOR(TRUE,FALSE)", "SWITCH(1,1,1)",
      'CONCAT("a","b")', 'TEXTJOIN(",",TRUE,A1)', "UNICHAR(65)", "UNICODE(A1)", "DAYS(2,1)",
    ];
    const suffix = '+"CONCAT("+CONCAT!A1+_xlfn.CONCAT(A1)+Table1[IFS(A1)]+Table1[CONCAT!A1]';
    const {entries} = await readZip(workbookToXlsx({
      sheetOrder: ["concat", "formulas"],
      sheets: {concat: sheet("CONCAT"), formulas: sheet("Formulas")},
      cells: {concat: {A1: cell("value")}, formulas: {
        A1: cell("=" + calls.join("+") + suffix),
        A2: cell("=SUM (1,2)+ifs\t(TRUE,1)+\"SUM (\"+A1 +1"),
        A3: cell("="),
        A4: cell("=  "),
      }},
    }));
    const expected = calls.map(call => "_xlfn." + call).join("+") + suffix;
    const worksheet = text(entries, "xl/worksheets/sheet2.xml");

    expect(cellXml(worksheet, "A1")).toContain(`<f>${expected}</f>`);
    // The grid tokenizer ignores whitespace, but in Excel `SUM (` is an intersection.
    expect(cellXml(worksheet, "A2")).toContain('<f>SUM(1,2)+_xlfn.IFS(TRUE,1)+"SUM ("+A1 +1</f>');
    expect(cellXml(worksheet, "A3")).toContain('t="inlineStr"><is><t xml:space="preserve">=</t>');
    expect(cellXml(worksheet, "A4")).toContain('t="inlineStr"><is><t xml:space="preserve">=  </t>');
  });

  it("translates ERRORTYPE function tokens to Excel's ERROR.TYPE name", async () => {
    const value = '=ERRORTYPE(NA())+"ERRORTYPE("+ERRORTYPE!A1+Table1[ERRORTYPE(A1)]+' +
      "'ERRORTYPE'!ERRORTYPE(A1)+[Book.xlsx]Sheet1!ERRORTYPE(A1)+ERROR.TYPE(NA())";
    const {entries} = await readZip(workbookToXlsx({
      sheetOrder: ["errorType", "formulas"],
      sheets: {errorType: sheet("ERRORTYPE"), formulas: sheet("Formulas")},
      cells: {errorType: {A1: cell("value")}, formulas: {A1: cell(value)}},
    }));

    expect(cellXml(text(entries, "xl/worksheets/sheet2.xml"), "A1")).toContain(
        '<f>ERROR.TYPE(NA())+"ERRORTYPE("+ERRORTYPE!A1+Table1[ERRORTYPE(A1)]+' +
        "'ERRORTYPE'!ERRORTYPE(A1)+[Book.xlsx]Sheet1!ERRORTYPE(A1)+ERROR.TYPE(NA())</f>");
  });

  it("accepts an exactly maximum-size rewritten formula and rejects the next character", async () => {
    const exact = "=+ERRORTYPE(NA())" + "+0".repeat(4087);
    const overflow = "=ERRORTYPE(NA())" + "+0".repeat(4088);
    expect(exact).toHaveLength(8191);
    expect(overflow).toHaveLength(8192);
    const {entries} = await readZip(workbookToXlsx({
      sheetOrder: ["data"],
      sheets: {data: sheet("Data")},
      cells: {data: {A1: cell(exact), A2: cell(overflow)}},
    }));
    const worksheet = text(entries, "xl/worksheets/sheet1.xml");
    const exactXml = cellXml(worksheet, "A1");

    expect(exactXml).toContain("<f>+ERROR.TYPE(NA())");
    expect(exactXml).not.toContain("inlineStr");
    expect(cellXml(worksheet, "A2"))
      .toBe(`<c r="A2" t="inlineStr"><is><t xml:space="preserve">${overflow}</t></is></c>`);
  });

  it("tracks apostrophe-escaped brackets in structured references", async () => {
    const value = "=Table1[[A'[B]]+IFS(TRUE,1)+Table1[[A']B]]+CONCAT(A1)+Table1[[A'']]+XOR(TRUE,FALSE)";
    const {entries} = await readZip(workbookToXlsx({
      sheetOrder: ["data"],
      sheets: {data: sheet("Data")},
      cells: {data: {A1: cell(value)}},
    }));

    expect(cellXml(text(entries, "xl/worksheets/sheet1.xml"), "A1"))
      .toContain("<f>Table1[[A'[B]]+_xlfn.IFS(TRUE,1)+Table1[[A']B]]+_xlfn.CONCAT(A1)+Table1[[A'']]+_xlfn.XOR(TRUE,FALSE)</f>");
  });

  it("prepares large duplicate sheet-name lists without quadratic suffix searches", async () => {
    const sheetIds = Array.from({length: 15000}, (_, index) => `sheet-${index}`);
    const metadata = Object.fromEntries(sheetIds.map((id, index) => [
      id,
      sheet("x".repeat(27) + Math.floor(index / 2).toString(36).padStart(4, "0")),
    ]));
    const stream = workbookToXlsx({sheetOrder: sheetIds, sheets: metadata, cells: {}});

    await stream.cancel();
  });

  it("exports sparse typed cells safely and preserves dimensions and a combined frozen pane", async () => {
    const unusual = "_x0041_" + String.fromCharCode(1, 0xd800, 13) + String.fromCodePoint(0x1f642);
    const document = {
      sheetOrder: ["data"],
      sheets: {
        data: sheet("Data", {
          rows: 10,
          cols: 12,
          colWidths: {0: 100, 10: 2000, 11: 92, 12: 150},
          rowHeights: {1: 40, 9: 2000, 10: 80},
          frozenRows: 2,
          frozenCols: 3,
        }),
      },
      cells: {
        data: {
          A1: cell('  <&>" \t\n'),
          B1: cell(unusual),
          C1: cell('=HYPERLINK("https://example.com","Example")'),
          D1: cell("'001"),
          E1: cell(" true "),
          F1: cell("FALSE"),
          G1: cell("+$1,234.50"),
          H1: cell("-12.5%"),
          I1: cell("42", {nf: "text"}),
          J1: cell("https://example.com"),
          K1: cell("==A1"),
          L1: cell("2026-09-02", {nf: "date"}),
          A10: cell('="_x0041_"'),
          B10: cell("=A1", {nf: "text"}),
          C10: cell("last"),
          D10: cell("=[Book.xlsx]Data!A1+Jan:Data!A1"),
          E10: cell("   "),
          Z1: cell("outside declared columns"),
          M1: cell("'=A1"),
          N1: cell("TRUE", {nf: "text"}),
          A11: cell("outside declared rows"),
          XFD1048576: cell("last Excel cell"),
          A0: cell("bad"),
          a1: cell("bad"),
          XFE1: cell("outside Excel"),
          A1048577: cell("outside Excel"),
        },
      },
    };
    const {entries} = await readZip(workbookToXlsx(document));
    const xml = text(entries, "xl/worksheets/sheet1.xml");

    expect(xml).toContain('<dimension ref="A1:XFD1048576"/>');
    expect(text(entries, "xl/styles.xml")).toContain('numFmtId="49"');
    expect(xml).toContain('<sheetFormatPr defaultColWidth="12.4296875" defaultRowHeight="18"/>');
    expect(xml).toContain('<col min="1" max="1" width="13.5703125" customWidth="1"/>');
    expect(xml).toContain('<col min="11" max="11" width="255" customWidth="1"/>');
    expect(xml).toContain('<row r="2" ht="30" customHeight="1">');
    expect(xml).toContain('<row r="10" ht="409" customHeight="1">');
    expect(xml).toContain('<pane xSplit="3" ySplit="2" topLeftCell="D3" activePane="bottomRight" state="frozen"/>');
    expect(cellXml(xml, "A1")).toContain('<t xml:space="preserve">  &lt;&amp;&gt;" \t\n</t>');
    expect(cellXml(xml, "B1")).toContain("_x005F_x0041__x0001__xFFFD__x000D_");
    expect(cellXml(xml, "B1")).toContain(String.fromCodePoint(0x1f642));
    expect(cellXml(xml, "C1")).toContain('<f>HYPERLINK("https://example.com","Example")</f>');
    expect(cellXml(xml, "D1")).toContain(">001</t>");
    expect(cellXml(xml, "E1")).toContain('t="b"><v>1</v>');
    expect(cellXml(xml, "F1")).toContain('t="b"><v>0</v>');
    expect(cellXml(xml, "G1")).toContain("<v>1234.5</v>");
    expect(cellXml(xml, "H1")).toContain("<v>-0.125</v>");
    expect(cellXml(xml, "I1")).toContain("<v>42</v>");
    expect(cellXml(xml, "J1")).toContain('t="inlineStr"');
    expect(cellXml(xml, "K1")).toContain("<f>=A1</f>");
    expect(cellXml(xml, "L1")).toContain('t="inlineStr"');
    expect(cellXml(xml, "A10")).toContain('<f>"_x0041_"</f>');
    expect(cellXml(xml, "B10")).toContain("<f>A1</f>");
    expect(styleId(xml, "B10")).toBe(styleId(xml, "I1"));
    expect(cellXml(xml, "D10")).toContain("<f>[Book.xlsx]Data!A1+Jan:Data!A1</f>");
    expect(cellXml(xml, "E10")).toBe('<c r="E10"/>');
    expect(cellXml(xml, "Z1")).toContain("outside declared columns");
    expect(cellXml(xml, "M1")).toContain(">=A1</t>");
    expect(cellXml(xml, "N1")).toContain('t="b"><v>1</v>');
    expect(styleId(xml, "N1")).toBe(styleId(xml, "I1"));
    expect(cellXml(xml, "A11")).toContain("outside declared rows");
    expect(cellXml(xml, "XFD1048576")).toContain("last Excel cell");
    for (const reference of ["A0", "a1", "XFE1", "A1048577"]) expect(xml).not.toContain(`r="${reference}"`);
  });

  it("batches worksheet XML while exporting the maximum stored cell count", async () => {
    const cells: Record<string, ReturnType<typeof cell>> = {};
    for (let index = 0; index < 200000; ++index) {
      cells[String.fromCharCode(65 + index % 4) + (Math.floor(index / 4) + 1)] = cell("1");
    }
    const {entries} = await readZip(workbookToXlsx({
      sheetOrder: ["dense"],
      sheets: {dense: sheet("Dense", {rows: 50000, cols: 4})},
      cells: {dense: cells},
    }));
    const worksheet = text(entries, "xl/worksheets/sheet1.xml");

    expect(worksheet).toContain('<dimension ref="A1:D50000"/>');
    expect(cellXml(worksheet, "D50000")).toContain("<v>1</v>");
  });

  it("deduplicates styles while supporting every format field and number-format category", async () => {
    const formats = {
      A1: {b: true}, B1: {i: true}, C1: {u: true}, D1: {s: true},
      E1: {c: "#abc"}, F1: {bg: "#1234"}, G1: {a: "c"}, H1: {nf: "number", d: 3},
      I1: {fs: 18}, J1: {wrap: true}, K1: {nf: "text"}, L1: {nf: "integer"},
      M1: {nf: "currency"}, N1: {nf: "percent"}, O1: {nf: "scientific"},
      P1: {nf: "date"}, Q1: {nf: "time"}, R1: {nf: "datetime"},
      S1: {nf: "unknown"}, T1: {d: 4},
    };
    const cells: Record<string, ReturnType<typeof cell>> = {};
    for (const [reference, fmt] of Object.entries(formats)) cells[reference] = cell("1", fmt);
    const repeated = {b: true, bg: "#112233", a: "r"};
    cells.A2 = cell("same", repeated);
    cells.B2 = cell("same", {...repeated});
    cells.C2 = cell("", {...repeated});
    cells.D2 = cell("eight digit", {c: "#abcdef12"});

    const {entries} = await readZip(workbookToXlsx({
      sheetOrder: ["styles"],
      sheets: {styles: sheet("Styles", {rows: 2, cols: 20})},
      cells: {styles: cells},
    }));
    const worksheet = text(entries, "xl/worksheets/sheet1.xml");
    const styles = text(entries, "xl/styles.xml");

    expect(styles).toContain("<b/>");
    expect(styles).toContain("<i/>");
    expect(styles).toContain("<u/>");
    expect(styles).toContain("<strike/>");
    expect(styles).toContain('rgb="FFAABBCC"');
    expect(styles).toContain('rgb="44112233"');
    expect(styles).toContain('rgb="FF112233"');
    expect(styles).toContain('rgb="12ABCDEF"');
    expect(styles).toContain('horizontal="center"');
    expect(styles).toContain('horizontal="right"');
    expect(styles).toContain('wrapText="1"');
    expect(styles).toContain('<sz val="13.5"/>');
    for (const code of [
      "#,##0.000", "#,##0", '&quot;$&quot;#,##0.00;-&quot;$&quot;#,##0.00',
      "#,##0.00%", "0.00E+00", "mm/dd/yyyy", "h:mm:ss AM/PM",
      "mm/dd/yyyy h:mm:ss AM/PM", "0.0000",
    ]) expect(styles).toContain(`formatCode="${code}"`);
    expect(styleId(worksheet, "S1")).toBeUndefined();
    expect(styleId(worksheet, "A2")).toBe(styleId(worksheet, "B2"));
    expect(styleId(worksheet, "B2")).toBe(styleId(worksheet, "C2"));
    expect(cellXml(worksheet, "C2")).toMatch(/^<c r="C2" s="\d+"\/>$/);
  });

  it("writes row-only, column-only, and combined frozen panes", async () => {
    const {entries} = await readZip(workbookToXlsx({
      sheetOrder: ["rows", "columns", "both"],
      sheets: {
        rows: sheet("Rows", {frozenRows: 2}),
        columns: sheet("Columns", {frozenCols: 3}),
        both: sheet("Both", {frozenRows: 4, frozenCols: 5}),
      },
      cells: {rows: {}, columns: {}, both: {}},
    }));
    expect(text(entries, "xl/worksheets/sheet1.xml")).toContain('ySplit="2" topLeftCell="A3" activePane="bottomLeft"');
    expect(text(entries, "xl/worksheets/sheet2.xml")).toContain('xSplit="3" topLeftCell="D1" activePane="topRight"');
    expect(text(entries, "xl/worksheets/sheet3.xml")).toContain('xSplit="5" ySplit="4" topLeftCell="F5" activePane="bottomRight"');
  });

  it("fails clearly before generating more fill styles than Excel supports", () => {
    const cells: Record<string, ReturnType<typeof cell>> = {};
    for (let index = 0; index < 255; ++index) {
      const reference = String.fromCharCode(65 + index % 26) + (Math.floor(index / 26) + 1);
      cells[reference] = cell("", {bg: `#${index.toString(16).padStart(6, "0")}`});
    }
    expect(() => workbookToXlsx({
      sheetOrder: ["styles"],
      sheets: {styles: sheet("Styles", {rows: 10, cols: 26})},
      cells: {styles: cells},
    })).toThrow("XLSX fill count exceeds Excel's limit of 256");
  });

  it("ignores v5-only metadata while exporting ordinary and materialized pivot cells", async () => {
    const document = {
      sheetOrder: ["v5"],
      sheets: {
        v5: {
          ...sheet("V5"),
          filter: {range: "A1:B4"},
          charts: [{type: "bar"}],
          comments: {A1: "note"},
          pivot: {source: "A1:B4", destination: "D1"},
        },
      },
      cells: {
        v5: {
          A1: {...cell("ordinary"), comment: "ignored"},
          D1: cell("Pivot total", {b: true}),
          D2: cell("125"),
        },
      },
      filter: {},
      charts: [],
      comments: {},
      pivot: {},
    };
    const {entries} = await readZip(workbookToXlsx(document));
    const worksheet = text(entries, "xl/worksheets/sheet1.xml");
    expect(cellXml(worksheet, "A1")).toContain("ordinary");
    expect(cellXml(worksheet, "D1")).toContain("Pivot total");
    expect(cellXml(worksheet, "D2")).toContain("<v>125</v>");
    expect(worksheet).not.toContain("autoFilter");
    expect([...entries.keys()].some(name => /chart|comment|pivot/i.test(name))).toBe(false);
  });
});

describe("Workspace Sheets document snapshots", () => {
  it("completes a queued document read before beginning the next mutation", async () => {
    let releaseRead!: () => void;
    let markReadStarted!: () => void;
    const readReleased = new Promise<void>(resolve => { releaseRead = resolve; });
    const readStarted = new Promise<void>(resolve => { markReadStarted = resolve; });
    const order: string[] = [];
    const fixture = Object.assign(Object.create(Gadget.prototype), {
      mutationQueue: Promise.resolve(),
      loadMeta: vi.fn(async () => ({revision: 1})),
      assembleDocument: vi.fn(async () => {
        order.push("read started");
        markReadStarted();
        await readReleased;
        order.push("read completed");
        return {revision: 1};
      }),
      applyOperationLocked: vi.fn(async () => {
        order.push("write started");
        order.push("write completed");
        return {result: {status: "applied"}};
      }),
    });

    const read = fixture.getDocument();
    await readStarted;
    const write = fixture.applyOperation({});
    await Promise.resolve();
    expect(fixture.applyOperationLocked).not.toHaveBeenCalled();

    releaseRead();
    await expect(read).resolves.toEqual({revision: 1});
    await expect(write).resolves.toEqual({status: "applied"});
    expect(order).toEqual(["read started", "read completed", "write started", "write completed"]);
  });

  it("lets a subscriber callback read and write the document without deadlocking", async () => {
    const subscribers = new Map();
    const fixture = inMemoryGadget(subscribers);
    const events: {revision: number}[] = [];
    const documents: {revision: number; cells: Record<string, Record<string, {value: string}>>}[] = [];
    subscribers.set({
      operation: vi.fn(async (event: {revision: number}) => {
        events.push(event);
        documents.push(await fixture.getDocument());
        if (event.revision === 1) await fixture.applyOperation(setCell("B1", "from callback"));
      }),
    }, {});

    const result = await fixture.applyOperation(setCell("A1", "committed"));

    expect(result.status).toBe("applied");
    expect(result).not.toHaveProperty("result");
    expect(events.map(event => event.revision)).toEqual([1, 2]);
    expect(events[0]).not.toHaveProperty("status");
    expect(events[0]).not.toHaveProperty("conflicts");
    expect(documents[0].revision).toBe(1);
    expect(documents[0].cells.sheet.A1.value).toBe("committed");
    expect(documents[1].cells.sheet.B1.value).toBe("from callback");
  });

  it("does not broadcast unchanged or conflicting-only operations", async () => {
    const subscriber = {operation: vi.fn()};
    const fixture = inMemoryGadget(new Map([[subscriber, {}]]));
    await fixture.applyOperation(setCell("A1", "first"));
    const conflict = await fixture.applyOperation(setCell("A1", "stale", 0));
    const unchanged = await fixture.applyOperation({senderId: "test", cellOps: []});

    expect(conflict.status).toBe("conflict");
    expect(conflict.conflicts).toHaveLength(1);
    expect(unchanged.status).toBe("unchanged");
    expect(subscriber.operation).toHaveBeenCalledOnce();
  });

  it("registers a subscriber and takes its snapshot inside the mutation queue", async () => {
    const fixture = inMemoryGadget();
    const newcomer = {presence: vi.fn(), operation: vi.fn(), onRpcBroken: vi.fn()};
    let releaseWrite!: () => void;
    const writeReleased = new Promise<void>(resolve => { releaseWrite = resolve; });
    const original = fixture.applyOperationLocked.bind(fixture);
    fixture.applyOperationLocked = async (operation: unknown) => { await writeReleased; return original(operation); };

    const writing = fixture.applyOperation(setCell("A1", "before subscribe"));
    const subscribing = fixture.subscribe({dup: () => newcomer} as never, {clientId: "newcomer"});
    await Promise.resolve();
    expect(fixture.subscribers.has(newcomer)).toBe(false);

    releaseWrite();
    await writing;
    const document = await subscribing;
    expect(document.revision).toBe(1);
    expect(document.cells.sheet.A1.value).toBe("before subscribe");
    expect(fixture.subscribers.has(newcomer)).toBe(true);
    expect(newcomer.operation).not.toHaveBeenCalled();
  });
});

describe("Workspace Sheets export formats", () => {
  it("reserves one of 32 slots for XLSX and applies the same CSV eligibility rules at export", async () => {
    const ids = Array.from({length: 40}, (_, index) => `sheet-${index}`);
    const longId = "x".repeat(125);
    const sheetOrder = [ids[0], ids[0], longId, ...ids.slice(1)];
    const sheets = Object.fromEntries([...ids, longId].map(id => [id, sheet(id)]));
    const document = {sheetOrder, sheets, cells: Object.fromEntries(Object.keys(sheets).map(id => [id, {}]))};
    const gadget = {getDocument: vi.fn(async () => document)};

    const formats = await handler().getExportFormats(gadget as never);
    expect(formats).toHaveLength(32);
    expect(formats[0]).toEqual({
      id: "xlsx",
      label: "Excel Workbook",
      mode: "server",
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      fileExtension: ".xlsx",
    });
    expect(new Set(formats.map(format => format.id)).size).toBe(32);
    expect(formats.some(format => format.id === `csv:${longId}`)).toBe(false);
    expect(formats.some(format => format.id === "csv:sheet-39")).toBe(false);
    await expect(handler().export(gadget as never, "csv:sheet-39")).rejects.toThrow("unavailable");
    await expect(handler().export(gadget as never, "pdf")).rejects.toThrow("Unsupported");
  });

  it("retains raw-value CSV behavior and materializes state before returning an XLSX stream", async () => {
    const document = {
      sheetOrder: ["one"],
      sheets: {one: sheet("One", {rows: 2, cols: 3})},
      cells: {one: {
        A1: cell("a,b"),
        C1: cell('say "hi"'),
        B2: cell("=SUM(A1:A2)"),
      }},
    };
    const gadget = {getDocument: vi.fn(async () => document)};
    const csv = await handler().export(gadget as never, "csv:one");
    expect(await new Response(csv).text()).toBe('"a,b",,"say ""hi"""\r\n,=SUM(A1:A2),\r\n');

    const xlsx = await handler().export(gadget as never, "xlsx");
    expect(gadget.getDocument).toHaveBeenCalledTimes(2);
    gadget.getDocument.mockImplementation(async () => { throw new Error("borrowed capability reused"); });
    const {entries} = await readZip(xlsx);
    expect(cellXml(text(entries, "xl/worksheets/sheet1.xml"), "B2")).toContain("<f>SUM(A1:A2)</f>");
  });
});
