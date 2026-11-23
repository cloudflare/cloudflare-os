// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { workbookToXlsx } from "../files/lib/xlsx.ts";
import { MAX_EXPORT_CELLS, loadExportWorkbook, refreshExportPivots } from "../files/lib/export-data.ts";
import type { CellFmt, ExportGadgetStub, SheetMeta } from "../files/lib/protocol.ts";

// The XLSX writer, fed through loadExportWorkbook from a stand-in for the gadget's export calls, so
// a test can hand it cells the gadget itself would refuse to store (refs past its grid, raw
// control characters) and see exactly what reaches the file.

type CellSpec = string | { value: string; fmt: CellFmt };

function sheetMeta(id: string, extra: Partial<SheetMeta> = {}): SheetMeta {
  return { id, name: id, rows: 100, cols: 26, colWidths: {}, rowHeights: {}, frozenRows: 0, frozenCols: 0, filter: null, charts: [], pivot: null, ...extra };
}

// Each sheet's cells in one export page, formats deduplicated as the gadget packs them.
function exportStub(sheets: { meta: SheetMeta; cells?: Record<string, CellSpec> }[]): ExportGadgetStub {
  const byId = new Map(sheets.map((sheet) => [sheet.meta.id, sheet]));
  return {
    getStructure: async () => ({ revision: 1, title: "Book", sheetOrder: sheets.map((sheet) => sheet.meta.id), sheets: Object.fromEntries(sheets.map((sheet) => [sheet.meta.id, sheet.meta])) }),
    exportPage: async ({ sheetId }) => {
      const refs: string[] = [], values: string[] = [], styles: number[] = [], fmts: CellFmt[] = [], fmtIndex = new Map<string, number>();
      for (const [ref, spec] of Object.entries(byId.get(sheetId)?.cells ?? {})) {
        refs.push(ref);
        values.push(typeof spec === "string" ? spec : spec.value);
        if (typeof spec === "string") { styles.push(-1); continue; }
        const key = JSON.stringify(spec.fmt);
        if (!fmtIndex.has(key)) { fmtIndex.set(key, fmts.length); fmts.push(spec.fmt); }
        styles.push(fmtIndex.get(key) as number);
      }
      return { revision: 1, refs, values, styles, fmts, next: null };
    },
  };
}

// As the export handler streams it.
async function xlsxStream(stub: ExportGadgetStub): Promise<ReadableStream<Uint8Array>> {
  const workbook = await loadExportWorkbook(stub, { formats: true });
  return workbookToXlsx(workbook, refreshExportPivots(workbook));
}

async function xlsx(...sheets: Parameters<typeof exportStub>[0]): Promise<Map<string, string>> {
  return unzip(await xlsxStream(exportStub(sheets)));
}

const decoder = new TextDecoder();

function uint16(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset).getUint16(offset, true);
}

function uint32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset).getUint32(offset, true);
}

// The archive format itself is the zip library's to test; this reads the parts back by the
// central directory.
async function unzip(stream: ReadableStream<Uint8Array>): Promise<Map<string, string>> {
  const archive = new Uint8Array(await new Response(stream).arrayBuffer());
  const end = archive.byteLength - 22;
  expect(uint32(archive, end)).toBe(0x06054b50);
  const parts = new Map<string, string>();
  let offset = uint32(archive, end + 16);
  for (let i = uint16(archive, end + 10); i > 0; i--) {
    const compressedSize = uint32(archive, offset + 20);
    const nameLength = uint16(archive, offset + 28);
    const local = uint32(archive, offset + 42);
    const name = decoder.decode(archive.subarray(offset + 46, offset + 46 + nameLength));
    const data = local + 30 + uint16(archive, local + 26) + uint16(archive, local + 28);
    const inflated = new Response(archive.slice(data, data + compressedSize)).body!.pipeThrough(new DecompressionStream("deflate-raw"));
    parts.set(name, await new Response(inflated).text());
    offset += 46 + nameLength + uint16(archive, offset + 30) + uint16(archive, offset + 32);
  }
  return parts;
}

function part(parts: Map<string, string>, name: string): string {
  const text = parts.get(name);
  if (text === undefined) throw new Error(`No ${name} in ${[...parts.keys()].join(", ")}`);
  return text;
}

function cellXml(xml: string, reference: string): string {
  const match = new RegExp(`<c r="${reference}"[^>]*?/>|<c r="${reference}"[^>]*>[\\s\\S]*?</c>`).exec(xml);
  if (!match) throw new Error(`No ${reference}`);
  return match[0];
}

function styleId(xml: string, reference: string): string | undefined {
  return / s="(\d+)"/.exec(cellXml(xml, reference))?.[1];
}

// The style a cell's `s` names, resolved to its font, fill, number format and alignment XML.
function cellStyle(parts: Map<string, string>, sheetXml: string, reference: string) {
  const styles = part(parts, "xl/styles.xml");
  const index = Number(styleId(sheetXml, reference) ?? 0);
  const listed = (tag: string) => [...(new RegExp(`<${tag}s count="\\d+">([\\s\\S]*?)</${tag}s>`).exec(styles)?.[1] ?? "").matchAll(new RegExp(`<${tag}\\b[^>]*?(?:/>|>[\\s\\S]*?</${tag}>)`, "g"))].map((m) => m[0]);
  const xf = [.../<cellXfs count="\d+">([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1].matchAll(/<xf\b[\s\S]*?<\/xf>/g) ?? []][index][0];
  const attribute = (name: string) => Number(new RegExp(` ${name}="(\\d+)"`).exec(xf)?.[1]);
  const numberFormatId = attribute("numFmtId");
  return {
    font: listed("font")[attribute("fontId")],
    fill: listed("fill")[attribute("fillId")],
    numberFormat: new RegExp(`<numFmt numFmtId="${numberFormatId}" formatCode="([^"]*)"/>`).exec(styles)?.[1] ?? numberFormatId,
    alignment: /<alignment [^>]*\/>/.exec(xf)?.[0],
  };
}

describe("XLSX text escaping", () => {
  it("escapes literal _xHHHH_ sequences, control characters and lone surrogates in cell text", async () => {
    const emoji = String.fromCodePoint(0x1f642);
    const parts = await xlsx({
      meta: sheetMeta("data"),
      cells: {
        A1: "_x0041_" + String.fromCharCode(1, 0xd800, 13) + emoji + String.fromCharCode(0xdc00, 0xfffe),
        A2: '  <&>" \t\n',
        A3: "_X00aB_ and _x12_",
      },
    });
    const xml = part(parts, "xl/worksheets/sheet1.xml");
    expect(cellXml(xml, "A1")).toBe(`<c r="A1" t="inlineStr"><is><t xml:space="preserve">_x005F_x0041__x0001__xFFFD__x000D_${emoji}_xFFFD__xFFFE_</t></is></c>`);
    expect(cellXml(xml, "A2")).toContain('<t xml:space="preserve">  &lt;&amp;&gt;" \t\n</t>');
    // Any-case hex is escaped; a sequence that isn't four hex digits is left alone.
    expect(cellXml(xml, "A3")).toContain(">_x005F_X00aB_ and _x12_</t>");
  });

  it("escapes a formula's cached text result but keeps its formula text as typed", async () => {
    const xml = part(await xlsx({ meta: sheetMeta("data"), cells: { A1: '="_x0041_"' } }), "xl/worksheets/sheet1.xml");
    expect(cellXml(xml, "A1")).toBe('<c r="A1" t="str"><f>"_x0041_"</f><v>_x005F_x0041_</v></c>');
  });

  it("replaces control characters and lone surrogates in formulas, which have no escape", async () => {
    const xml = part(await xlsx({ meta: sheetMeta("data"), cells: { A1: '="a' + String.fromCharCode(1, 0xd800) + 'b"&"<&>"' } }), "xl/worksheets/sheet1.xml");
    expect(cellXml(xml, "A1")).toContain('<f>"a��b"&amp;"&lt;&amp;&gt;"</f>');
  });

  it("escapes sheet names as attributes in the workbook", async () => {
    const workbook = part(await xlsx({ meta: sheetMeta("a", { name: "O'Brien & <Co> \"x\"" }) }), "xl/workbook.xml");
    expect(workbook).toContain('<sheet name="O&apos;Brien &amp; &lt;Co&gt; &quot;x&quot;" sheetId="1" r:id="rId1"/>');
  });
});

describe("XLSX cell bounds", () => {
  it("writes cells out to XFD1048576 and drops refs past Excel's grid or not in its form", async () => {
    const xml = part(await xlsx({
      meta: sheetMeta("data", { rows: 10, cols: 12 }),
      cells: {
        A1: "first",
        Z1: "outside declared columns",
        A11: "outside declared rows",
        XFD1048576: "last Excel cell",
        A0: "bad", a1: "bad", "1A": "bad", A01: "bad",
        XFE1: "outside Excel", A1048577: "outside Excel",
      },
    }), "xl/worksheets/sheet1.xml");
    expect(xml).toContain('<dimension ref="A1:XFD1048576"/>');
    expect(cellXml(xml, "Z1")).toContain("outside declared columns");
    expect(cellXml(xml, "A11")).toContain("outside declared rows");
    expect(cellXml(xml, "XFD1048576")).toContain("last Excel cell");
    expect(xml).toContain('<row r="1048576">');
    for (const reference of ["A0", "a1", "1A", "A01", "XFE1", "A1048577"]) expect(xml).not.toContain(`r="${reference}"`);
    expect(xml).not.toContain("bad");
    expect(xml).not.toContain("outside Excel");
  });

  it("gives an empty sheet a one-cell dimension and empty sheet data", async () => {
    const xml = part(await xlsx({ meta: sheetMeta("data") }), "xl/worksheets/sheet1.xml");
    expect(xml).toContain('<dimension ref="A1"/>');
    expect(xml).toContain("<sheetData></sheetData>");
  });
});

describe("XLSX frozen panes", () => {
  it("writes row-only, column-only and combined frozen panes", async () => {
    const parts = await xlsx(
      { meta: sheetMeta("rows", { frozenRows: 2 }) },
      { meta: sheetMeta("columns", { frozenCols: 3 }) },
      { meta: sheetMeta("both", { frozenRows: 4, frozenCols: 5 }) },
      { meta: sheetMeta("none") },
    );
    expect(part(parts, "xl/worksheets/sheet1.xml")).toContain('<pane ySplit="2" topLeftCell="A3" activePane="bottomLeft" state="frozen"/>');
    expect(part(parts, "xl/worksheets/sheet2.xml")).toContain('<pane xSplit="3" topLeftCell="D1" activePane="topRight" state="frozen"/>');
    expect(part(parts, "xl/worksheets/sheet3.xml")).toContain('<pane xSplit="5" ySplit="4" topLeftCell="F5" activePane="bottomRight" state="frozen"/>');
    expect(part(parts, "xl/worksheets/sheet4.xml")).toContain('<sheetView workbookViewId="0"></sheetView>');
  });

  it("freezes no more than the sheet has, and at most 50", async () => {
    const parts = await xlsx(
      { meta: sheetMeta("small", { rows: 3, cols: 2, frozenRows: 10, frozenCols: 10 }) },
      { meta: sheetMeta("large", { rows: 1000, cols: 100, frozenRows: 80, frozenCols: 60 }) },
    );
    expect(part(parts, "xl/worksheets/sheet1.xml")).toContain('<pane xSplit="2" ySplit="3" topLeftCell="C4"');
    expect(part(parts, "xl/worksheets/sheet2.xml")).toContain('<pane xSplit="50" ySplit="50" topLeftCell="AY51"');
  });
});

describe("XLSX styles", () => {
  it("writes every format field and number-format category", async () => {
    const formats: Record<string, CellFmt> = {
      A1: { b: true }, B1: { i: true }, C1: { u: true }, D1: { s: true },
      E1: { c: "#abc" }, F1: { c: "#1234" }, G1: { c: "#abcdef12" }, H1: { bg: "#112233" },
      I1: { a: "l" }, J1: { a: "c" }, K1: { a: "r" }, L1: { wrap: true }, M1: { fs: 16 },
      A2: { nf: "text" }, B2: { nf: "integer" }, C2: { nf: "number" }, D2: { nf: "number", d: 3 },
      E2: { nf: "currency" }, F2: { nf: "currency", d: 0 }, G2: { nf: "percent", d: 1 }, H2: { nf: "scientific" },
      I2: { nf: "date" }, J2: { nf: "time" }, K2: { nf: "datetime" }, L2: { d: 4 },
    };
    const parts = await xlsx({
      meta: sheetMeta("styles"),
      cells: Object.fromEntries(Object.entries(formats).map(([ref, fmt]) => [ref, { value: "1", fmt }])),
    });
    const xml = part(parts, "xl/worksheets/sheet1.xml");
    const style = (reference: string) => cellStyle(parts, xml, reference);

    expect(style("A1").font).toContain("<b/>");
    expect(style("B1").font).toContain("<i/>");
    expect(style("C1").font).toContain("<u/>");
    expect(style("D1").font).toContain("<strike/>");
    // #rgb, #rgba and #rrggbbaa become Excel's ARGB.
    expect(style("E1").font).toContain('<color rgb="FFAABBCC"/>');
    expect(style("F1").font).toContain('<color rgb="44112233"/>');
    expect(style("G1").font).toContain('<color rgb="12ABCDEF"/>');
    expect(style("H1").fill).toContain('<fgColor rgb="FF112233"/>');
    // A dark fill with no text colour gets the grid's light ink.
    expect(style("H1").font).toContain('<color rgb="FFF4F4F5"/>');
    expect(style("I1").alignment).toBe('<alignment vertical="center" horizontal="left"/>');
    expect(style("J1").alignment).toBe('<alignment vertical="center" horizontal="center"/>');
    expect(style("K1").alignment).toBe('<alignment vertical="center" horizontal="right"/>');
    expect(style("L1").alignment).toBe('<alignment vertical="center" wrapText="1"/>');
    // 16px against the grid's 13px text is 13.5pt against Calibri 11.
    expect(style("M1").font).toContain('<sz val="13.5"/>');

    expect(style("A2").numberFormat).toBe(49);
    expect(style("B2").numberFormat).toBe("#,##0");
    expect(style("C2").numberFormat).toBe("#,##0.00");
    expect(style("D2").numberFormat).toBe("#,##0.000");
    expect(style("E2").numberFormat).toBe("&quot;$&quot;#,##0.00;-&quot;$&quot;#,##0.00");
    expect(style("F2").numberFormat).toBe("&quot;$&quot;#,##0;-&quot;$&quot;#,##0");
    expect(style("G2").numberFormat).toBe("#,##0.0%");
    expect(style("H2").numberFormat).toBe("0.00E+00");
    expect(style("I2").numberFormat).toBe("mm/dd/yyyy");
    expect(style("J2").numberFormat).toBe("h:mm:ss AM/PM");
    expect(style("K2").numberFormat).toBe("mm/dd/yyyy h:mm:ss AM/PM");
    expect(style("L2").numberFormat).toBe("0.0000");
  });

  it("writes no style for a format with nothing Excel shows", async () => {
    const xml = part(await xlsx({
      meta: sheetMeta("styles"),
      cells: {
        A1: { value: "1", fmt: { nf: "unknown" } },
        B1: { value: "1", fmt: { nf: "auto" } },
        C1: { value: "1", fmt: { c: "red", bg: "#12", fs: 13, d: 11 } },
        D1: { value: "", fmt: { nf: "auto" } },
      },
    }), "xl/worksheets/sheet1.xml");
    expect(cellXml(xml, "A1")).toBe('<c r="A1"><v>1</v></c>');
    expect(cellXml(xml, "B1")).toBe('<c r="B1"><v>1</v></c>');
    expect(cellXml(xml, "C1")).toBe('<c r="C1"><v>1</v></c>');
    // An empty cell with no visible style isn't written at all.
    expect(xml).not.toContain('r="D1"');
  });

  it("deduplicates fonts, fills, number formats and cell formats", async () => {
    const repeated: CellFmt = { b: true, bg: "#112233", a: "r" };
    const parts = await xlsx({
      meta: sheetMeta("styles"),
      cells: {
        A1: { value: "same", fmt: repeated },
        // The same format with its keys in another order, and with a key Excel doesn't show.
        B1: { value: "same", fmt: { a: "r", bg: "#112233", b: true } },
        C1: { value: "", fmt: { ...repeated, nf: "unknown" } },
        // Shares A1's font and fill but not its alignment.
        D1: { value: "other", fmt: { b: true, bg: "#112233" } },
        E1: { value: "1", fmt: { nf: "currency" } },
        F1: { value: "2", fmt: { nf: "currency", d: 2 } },
      },
    });
    const xml = part(parts, "xl/worksheets/sheet1.xml");
    const styles = part(parts, "xl/styles.xml");

    expect(styleId(xml, "A1")).toBeDefined();
    expect(styleId(xml, "B1")).toBe(styleId(xml, "A1"));
    expect(cellXml(xml, "C1")).toBe(`<c r="C1" s="${styleId(xml, "A1")}"/>`);
    expect(styleId(xml, "D1")).not.toBe(styleId(xml, "A1"));
    expect(styleId(xml, "F1")).toBe(styleId(xml, "E1"));
    // Default font plus one bold-with-ink; the two built-in fills plus one; one currency code.
    expect(styles).toContain('<fonts count="2">');
    expect(styles).toContain('<fills count="3">');
    expect(styles).toContain('<numFmts count="1">');
    // Default, A1/B1/C1, D1 and E1/F1.
    expect(styles).toContain('<cellXfs count="4">');
  });
});

describe("XLSX worksheet streaming", () => {
  it("batches worksheet XML while exporting the maximum cell count", async () => {
    const NativeCompressionStream = CompressionStream;
    let compressorWrites = 0;
    vi.stubGlobal("CompressionStream", class {
      readonly readable: ReadableStream<Uint8Array>;
      readonly writable: WritableStream<Uint8Array>;
      constructor(format: ConstructorParameters<typeof CompressionStream>[0]) {
        const compressor = new NativeCompressionStream(format);
        const counter = new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            ++compressorWrites;
            controller.enqueue(chunk);
          },
        });
        void counter.readable.pipeTo(compressor.writable);
        this.readable = compressor.readable;
        this.writable = counter.writable;
      }
    });
    const columns = 8, rows = MAX_EXPORT_CELLS / columns;
    const cells: Record<string, string> = {};
    for (let index = 0; index < MAX_EXPORT_CELLS; ++index) {
      cells[String.fromCharCode(65 + index % columns) + (Math.floor(index / columns) + 1)] = "1";
    }
    try {
      const xml = part(await xlsx({ meta: sheetMeta("dense", { rows, cols: columns }), cells }), "xl/worksheets/sheet1.xml");
      expect(xml).toContain(`<dimension ref="A1:H${rows}"/>`);
      expect(cellXml(xml, `H${rows}`)).toBe(`<c r="H${rows}"><v>1</v></c>`);
      expect(xml.split("<c ").length - 1).toBe(MAX_EXPORT_CELLS);
      // ~9 MB of worksheet XML in 64 KiB batches; per-row or per-cell chunks would be 50,000 or more writes.
      expect(compressorWrites).toBeLessThan(500);
    } finally {
      vi.unstubAllGlobals();
    }
  }, 30_000);
});
