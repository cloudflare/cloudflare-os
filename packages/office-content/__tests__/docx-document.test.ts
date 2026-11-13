import { describe, expect, it } from "vitest";
import {
  readDocxDocument, type DocxBlock, type DocxInline, type DocxParagraph, type DocxTable,
} from "../src/docx-document";
import { buildLayoutDocx, paragraph, run } from "./test-fixtures";

const paragraphs = (blocks: readonly DocxBlock[]): DocxParagraph[] => blocks.filter(block => block.kind === "paragraph");
const firstRun = (block: DocxParagraph) => {
  const inline = block.inlines.find((candidate): candidate is Extract<DocxInline, { kind: "text" }> => candidate.kind === "text");
  if (!inline) throw new Error("paragraph has no text");
  return inline.run;
};
const text = (block: DocxParagraph) => block.inlines.map(inline => inline.kind === "text" ? inline.text : "").join("");

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function picture(relationshipId: string): string {
  return `<w:r><w:drawing><wp:inline><wp:extent cx="1270000" cy="635000"/><wp:docPr id="1" name="p" descr="A chart of sales"/>` +
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:blipFill><a:blip r:embed="${relationshipId}"/></pic:blipFill></pic:pic>` +
    `</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
}

describe("readDocxDocument", () => {
  it("applies document defaults, then the style chain, then direct properties", async () => {
    const document = await readDocxDocument(await buildLayoutDocx({
      styles:
        '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial"/><w:sz w:val="20"/><w:color w:val="111111"/></w:rPr></w:rPrDefault>' +
        '<w:pPrDefault><w:pPr><w:spacing w:after="200" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
        '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:sz w:val="22"/></w:rPr></w:style>' +
        '<w:style w:type="paragraph" w:styleId="Base"><w:name w:val="Base"/><w:basedOn w:val="Normal"/>' +
        '<w:pPr><w:spacing w:before="240"/><w:ind w:left="720"/><w:jc w:val="center"/></w:pPr><w:rPr><w:b/><w:color w:val="222222"/></w:rPr></w:style>' +
        '<w:style w:type="paragraph" w:styleId="Derived"><w:name w:val="heading 2"/><w:basedOn w:val="Base"/>' +
        '<w:pPr><w:spacing w:after="0"/></w:pPr><w:rPr><w:i/><w:color w:val="333333"/></w:rPr></w:style>' +
        '<w:style w:type="character" w:styleId="Loud"><w:name w:val="Loud"/><w:rPr><w:caps/><w:color w:val="444444"/></w:rPr></w:style>',
      body:
        paragraph(run("plain")) +
        paragraph(
          run("styled") + run("character", '<w:rStyle w:val="Loud"/>') + run("direct", '<w:rStyle w:val="Loud"/><w:b w:val="0"/><w:color w:val="555555"/><w:sz w:val="48"/>'),
          '<w:pStyle w:val="Derived"/><w:ind w:left="1440" w:hanging="360"/>',
        ),
    }));
    const [plain, styled] = paragraphs(document.body);

    expect(plain).toMatchObject({ spacingBefore: 0, spacingAfter: 10, lineSpacing: { rule: "auto", value: 1.15 }, alignment: "left" });
    expect(firstRun(plain!)).toMatchObject({ font: "Arial", size: 11, bold: false, color: "#111111" });

    expect(styled).toMatchObject({
      headingLevel: 2, alignment: "center", spacingBefore: 12, spacingAfter: 0,
      lineSpacing: { rule: "auto", value: 1.15 }, indentLeft: 72, indentFirstLine: -18,
    });
    const [fromStyle, fromCharacterStyle, direct] = styled!.inlines.map(inline => inline.kind === "text" ? inline.run : undefined);
    expect(fromStyle).toMatchObject({ font: "Arial", size: 11, bold: true, italic: true, caps: false, color: "#333333" });
    expect(fromCharacterStyle).toMatchObject({ bold: true, italic: true, caps: true, color: "#444444" });
    expect(direct).toMatchObject({ size: 24, bold: false, italic: true, caps: true, color: "#555555" });
  });

  it("resolves theme fonts and theme colours, tinted and shaded", async () => {
    const document = await readDocxDocument(await buildLayoutDocx({
      theme:
        '<a:clrScheme name="t"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:dk2><a:srgbClr val="1F497D"/></a:dk2>' +
        '<a:accent1><a:srgbClr val="4F81BD"/></a:accent1></a:clrScheme>' +
        '<a:fontScheme name="t"><a:majorFont><a:latin typeface="Calibri"/></a:majorFont><a:minorFont><a:latin typeface="Cambria"/></a:minorFont></a:fontScheme>',
      styles: '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:asciiTheme="minorHAnsi"/></w:rPr></w:rPrDefault></w:docDefaults>',
      body: paragraph(
        run("minor") +
        run("major", '<w:rFonts w:asciiTheme="majorHAnsi" w:ascii="Stale"/><w:color w:val="FF0000" w:themeColor="accent1"/>') +
        run("literal", '<w:rFonts w:ascii="Georgia"/><w:color w:val="17365D" w:themeColor="text2" w:themeShade="BF"/>') +
        run("tinted", '<w:shd w:val="clear" w:fill="FFFFFF" w:themeFill="accent1" w:themeFillTint="3F"/>'),
      ),
    }));
    const runs = paragraphs(document.body)[0]!.inlines.map(inline => inline.kind === "text" ? inline.run : undefined);

    expect(runs[0]).toMatchObject({ font: "Cambria" });
    // The theme wins over the literal values Word caches beside it.
    expect(runs[1]).toMatchObject({ font: "Calibri", color: "#4F81BD" });
    expect(runs[2]!.font).toBe("Georgia");
    // Word's own arithmetic for these is #17365D and #D3DFEE; rounding differs by one step at most.
    expect(runs[2]!.color).toMatch(/^#1[67]3[67]5[DE]$/);
    expect(runs[3]!.shading).toMatch(/^#D[34]\w{2}E[EF]$/);
  });

  it("numbers lists with each level's format and text, restarting deeper levels and overridden lists", async () => {
    const level = (index: number, format: string, pattern: string, extra = "") =>
      `<w:lvl w:ilvl="${index}"><w:start w:val="1"/><w:numFmt w:val="${format}"/><w:lvlText w:val="${pattern}"/>` +
      `<w:pPr><w:ind w:left="${720 * (index + 1)}" w:hanging="360"/></w:pPr>${extra}</w:lvl>`;
    const item = (label: string, numId: number, ilvl: number) =>
      paragraph(run(label), `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr>`);
    const document = await readDocxDocument(await buildLayoutDocx({
      numbering:
        `<w:abstractNum w:abstractNumId="0">${level(0, "decimal", "%1.")}${level(1, "lowerLetter", "%1.%2)")}${level(2, "upperRoman", "(%3)")}</w:abstractNum>` +
        `<w:abstractNum w:abstractNumId="1">${level(0, "bullet", "", '<w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol"/><w:color w:val="FF0000"/></w:rPr>')}</w:abstractNum>` +
        '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>' +
        '<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>' +
        '<w:num w:numId="3"><w:abstractNumId w:val="0"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>',
      body:
        item("a", 1, 0) + item("b", 1, 1) + item("c", 1, 1) + item("d", 1, 2) + item("e", 1, 0) + item("f", 1, 1) +
        item("bullet", 2, 0) + item("continues", 1, 0) + item("restarted", 3, 0) + item("not a list", 0, 0),
    }));
    const blocks = paragraphs(document.body);

    expect(blocks.map(block => block.marker?.text)).toEqual(["1.", "1.a)", "1.b)", "(I)", "2.", "2.a)", "•", "3.", "1.", undefined]);
    expect(blocks[1]).toMatchObject({ indentLeft: 72, indentFirstLine: -18 });
    // The bullet keeps its level's colour but not the symbol font, whose glyph no other font has.
    expect(blocks[6]!.marker!.run).toMatchObject({ color: "#FF0000" });
    expect(blocks[6]!.marker!.run.font).not.toBe("Symbol");
  });

  it("keeps text hidden only in Word's Web Layout, such as a table of contents' page numbers", async () => {
    const document = await readDocxDocument(await buildLayoutDocx({
      body: paragraph(run("Chapter one") + run("12", "<w:webHidden/>") + run("secret", "<w:vanish/>")),
    }));

    expect(paragraphs(document.body).map(text)).toEqual(["Chapter one12"]);
  });

  it("reads a table of many empty rows without failing, up to its row limit", async () => {
    const document = await readDocxDocument(await buildLayoutDocx({ body: `<w:tbl>${"<w:tr/>".repeat(200_000)}</w:tbl>` }));

    const [table] = document.body;
    expect(table).toMatchObject({ kind: "table" });
    expect(table!.kind === "table" && table.rows.length).toBe(5_000);
    expect(document.truncated).toBe(true);
  });

  it("ignores list levels Word does not have, which would otherwise size a list's counters", async () => {
    const numbered = (ilvl: number) => paragraph(run("x"), `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="1"/></w:numPr>`);
    const started = Date.now();
    const document = await readDocxDocument(await buildLayoutDocx({
      numbering:
        '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum>' +
        '<w:num w:numId="1"><w:abstractNumId w:val="0"/><w:lvlOverride w:ilvl="999999999"><w:startOverride w:val="5"/></w:lvlOverride></w:num>',
      body: numbered(0) + numbered(0) + numbered(999999999),
    }));

    expect(paragraphs(document.body).map(block => block.marker?.text)).toEqual(["1.", "2.", "3."]);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("counts the pages a paragraph's breaks make against the document's blocks", async () => {
    const breaks = '<w:r><w:t>x</w:t><w:br w:type="page"/></w:r>'.repeat(20_000);
    const document = await readDocxDocument(await buildLayoutDocx({ body: `<w:p>${breaks}<w:r><w:t>end</w:t></w:r></w:p>` }));
    expect(document.body.length).toBeLessThanOrEqual(5_000);
    expect(document.truncated).toBe(true);
  });

  it("stops reading tables once the document holds as many cells as it may, empty ones included", async () => {
    const row = `<w:tr>${"<w:tc/>".repeat(100)}</w:tr>`;
    const document = await readDocxDocument(await buildLayoutDocx({ body: `<w:tbl>${row.repeat(1_000)}</w:tbl>` }));
    const [table] = document.body;
    expect(table!.kind === "table" && table.rows.length).toBe(500);
    expect(document.truncated).toBe(true);
  });

  it("reads only as many blocks as asked, for a glimpse of the start", async () => {
    const document = await readDocxDocument(await buildLayoutDocx({ body: paragraph(run("x")).repeat(100) }), { maxBlocks: 3 });
    expect(document.body).toHaveLength(3);
    expect(document.truncated).toBe(true);
  });

  it("follows fields only a few deep, however many a run is inside", async () => {
    const begin = '<w:r><w:fldChar w:fldCharType="begin"/></w:r>';
    const separate = '<w:r><w:fldChar w:fldCharType="separate"/></w:r>';
    const end = '<w:r><w:fldChar w:fldCharType="end"/></w:r>';
    const nested = (begin + separate).repeat(10_000) + run("x").repeat(2_000) + end.repeat(10_000);
    const started = Date.now();
    const document = await readDocxDocument(await buildLayoutDocx({ body: `<w:p>${nested}${run("after")}</w:p>` }));
    expect(Date.now() - started).toBeLessThan(2_000);
    const [block] = paragraphs(document.body);
    expect(block!.inlines.at(-1)).toMatchObject({ kind: "text", text: "after" });
  });

  it("numbers a restarted list on its own, and resumes the list it interrupted", async () => {
    const item = (numId: number) => paragraph(run("x"), `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr>`);
    const document = await readDocxDocument(await buildLayoutDocx({
      numbering:
        '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum>' +
        '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>' +
        '<w:num w:numId="2"><w:abstractNumId w:val="0"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>',
      body: item(1) + item(1) + item(2) + item(1),
    }));
    expect(paragraphs(document.body).map(block => block.marker?.text)).toEqual(["1.", "2.", "1.", "3."]);
  });

  it("does not make a heading of a paragraph whose own outline level says it is body text", async () => {
    const document = await readDocxDocument(await buildLayoutDocx({
      styles: '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>',
      body: paragraph(run("Title"), '<w:pStyle w:val="Heading1"/>') + paragraph(run("Body"), '<w:pStyle w:val="Heading1"/><w:outlineLvl w:val="9"/>'),
    }));
    expect(paragraphs(document.body).map(block => block.headingLevel)).toEqual([1, undefined]);
  });

  it("breaks before a paragraph that asks to start a page only when it does not already", async () => {
    const heading = (text: string) => paragraph(run(text), "<w:pageBreakBefore/>");
    const document = await readDocxDocument(await buildLayoutDocx({
      body: heading("First") + paragraph(run("Body")) + heading("Second") + paragraph('<w:r><w:br w:type="page"/></w:r>') + heading("Third"),
    }));
    expect(document.body.map(block => block.kind === "paragraph" ? (block.inlines[0] as { text?: string } | undefined)?.text : block.kind))
      .toEqual(["First", "Body", "pageBreak", "Second", "pageBreak", "Third"]);
  });

  it("keeps the break before a section that continues when its first paragraph asks to start a page", async () => {
    const sectionEnd = (type: string) => `<w:p><w:pPr><w:sectPr><w:type w:val="${type}"/></w:sectPr></w:pPr></w:p>`;
    const document = await readDocxDocument(await buildLayoutDocx({
      body: paragraph(run("One")) + sectionEnd("nextPage") + paragraph(run("Two"), "<w:pageBreakBefore/>") +
        `<w:sectPr><w:type w:val="continuous"/></w:sectPr>`,
    }));
    expect(document.body.map(block => block.kind)).toContain("pageBreak");
  });

  it("breaks before each paragraph in a content control that asks to start a page", async () => {
    const heading = (text: string) => paragraph(run(text), "<w:pageBreakBefore/>");
    const document = await readDocxDocument(await buildLayoutDocx({
      body: `<w:sdt><w:sdtContent>${heading("First")}${heading("Second")}</w:sdtContent></w:sdt>`,
    }));
    expect(document.body.map(block => block.kind)).toEqual(["paragraph", "pageBreak", "paragraph"]);
  });

  it("keeps no more of a font's name than Office would, however long the file makes it", async () => {
    const long = "F".repeat(100_000);
    const document = await readDocxDocument(await buildLayoutDocx({
      body: paragraph(run("x", `<w:rFonts w:ascii="${long}"/>`)),
    }));
    expect(firstRun(paragraphs(document.body)[0]!).font).toHaveLength(64);
  });

  it("keeps no more tab stops for a paragraph than Word allows", async () => {
    const tabs = Array.from({ length: 1_000 }, (_, index) => `<w:tab w:val="left" w:pos="${(index + 1) * 20}"/>`).join("");
    const document = await readDocxDocument(await buildLayoutDocx({ body: paragraph(run("x"), `<w:tabs>${tabs}</w:tabs>`) }));
    expect(paragraphs(document.body)[0]!.tabStops).toHaveLength(64);
  });

  it("keeps only the start of a marker pattern, which every numbered paragraph repeats", async () => {
    const numbered = paragraph(run("x"), '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>');
    const document = await readDocxDocument(await buildLayoutDocx({
      numbering:
        `<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="${"%1".repeat(100_000)}"/></w:lvl></w:abstractNum>` +
        '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>',
      body: numbered.repeat(3),
    }));

    expect(paragraphs(document.body).map(block => block.marker?.text)).toEqual(["1".repeat(50), "2".repeat(50), "3".repeat(50)]);
  });

  it("applies a table style's conditional formats as the table's look asks", async () => {
    const border = (side: string, size: number) => `<w:${side} w:val="single" w:sz="${size}" w:color="0000FF"/>`;
    const cell = (label: string) => `<w:tc><w:tcPr><w:tcW w:w="1440" w:type="dxa"/></w:tcPr>${paragraph(run(label))}</w:tc>`;
    const row = (...labels: string[]) => `<w:tr>${labels.map(cell).join("")}</w:tr>`;
    const document = await readDocxDocument(await buildLayoutDocx({
      settings: '<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat>',
      styles:
        '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:jc w:val="right"/></w:pPr></w:style>' +
        '<w:style w:type="table" w:styleId="Grid"><w:name w:val="Grid"/><w:pPr><w:spacing w:after="0"/><w:jc w:val="center"/></w:pPr>' +
        `<w:tblPr><w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map(side => border(side, 8)).join("")}</w:tblBorders>` +
        '<w:tblCellMar><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr>' +
        `<w:tblStylePr w:type="firstRow"><w:rPr><w:b/></w:rPr><w:tcPr><w:tcBorders>${border("bottom", 24)}<w:insideV w:val="nil"/></w:tcBorders><w:shd w:val="clear" w:fill="111111"/></w:tcPr></w:tblStylePr>` +
        '<w:tblStylePr w:type="firstCol"><w:rPr><w:i/></w:rPr></w:tblStylePr>' +
        '<w:tblStylePr w:type="band1Horz"><w:tcPr><w:shd w:val="clear" w:fill="EEEEEE"/></w:tcPr></w:tblStylePr>' +
        '<w:tblStylePr w:type="band1Vert"><w:tcPr><w:shd w:val="clear" w:fill="FF0000"/></w:tcPr></w:tblStylePr></w:style>',
      body:
        '<w:tbl><w:tblPr><w:tblStyle w:val="Grid"/><w:tblLook w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr>' +
        '<w:tblGrid><w:gridCol w:w="1440"/><w:gridCol w:w="1440"/></w:tblGrid>' +
        `${row("head", "head")}${row("first", "body")}${row("second", "body")}</w:tbl>`,
    }));
    const table = document.body[0] as DocxTable;
    const cellAt = (rowIndex: number, column: number) => table.rows[rowIndex]!.cells[column]!;
    const cellRun = (rowIndex: number, column: number) => firstRun(paragraphs(cellAt(rowIndex, column).blocks)[0]!);

    expect(table.columnWidths).toEqual([72, 72]);
    // The first row has its own format, so banding starts on the row after it; column bands are off.
    expect(table.rows.map(tableRow => tableRow.cells[1]!.shading)).toEqual(["#111111", "#EEEEEE", undefined]);
    expect(cellRun(0, 1)).toMatchObject({ bold: true, italic: false, color: "#FFFFFF" });
    expect(cellRun(1, 0)).toMatchObject({ bold: false, italic: true });
    expect(cellRun(1, 1)).toMatchObject({ bold: false, italic: false });
    // The table style's paragraph properties sit below the paragraph style's.
    expect(paragraphs(cellAt(1, 1).blocks)[0]).toMatchObject({ spacingAfter: 0, alignment: "right" });

    expect(cellAt(0, 0).borders).toMatchObject({ top: { width: 1 }, left: { width: 1 }, bottom: { width: 3 } });
    expect(cellAt(0, 0).borders.right).toBeUndefined();
    expect(cellAt(2, 1).borders).toMatchObject({ top: { width: 1 }, right: { width: 1 }, bottom: { width: 1 }, left: { width: 1, color: "#0000FF" } });
    expect(cellAt(1, 0).margins).toEqual({ top: 0, right: 5, bottom: 0, left: 5 });
  });

  it("merges cells across rows and columns", async () => {
    const cell = (label: string, properties = "") => `<w:tc><w:tcPr>${properties}</w:tcPr>${paragraph(run(label))}</w:tc>`;
    const document = await readDocxDocument(await buildLayoutDocx({
      body:
        '<w:tbl><w:tblGrid><w:gridCol w:w="1000"/><w:gridCol w:w="1000"/><w:gridCol w:w="1000"/></w:tblGrid>' +
        `<w:tr>${cell("tall", '<w:vMerge w:val="restart"/>')}${cell("wide", '<w:gridSpan w:val="2"/>')}</w:tr>` +
        `<w:tr>${cell("", "<w:vMerge/>")}${cell("b")}${cell("c")}</w:tr></w:tbl>`,
    }));
    const table = document.body[0] as DocxTable;

    expect(table.rows[0]!.cells.map(cell => [cell.columnSpan, cell.rowSpan])).toEqual([[1, 2], [2, 1]]);
    expect(table.rows[1]!.cells.map(cell => text(paragraphs(cell.blocks)[0]!))).toEqual(["b", "c"]);
  });

  it("returns a stored picture's bytes and never follows a linked one", async () => {
    const document = await readDocxDocument(await buildLayoutDocx({
      body: paragraph(picture("rIdStored") + picture("rIdLinked") + picture("rIdScript")),
      files: { "media/image1.png": PNG, "media/image2.svg": new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>") },
      relationships: [
        { id: "rIdStored", type: "image", target: "media/image1.png" },
        { id: "rIdLinked", type: "image", target: "https://tracker.example/pixel.png", external: true },
        { id: "rIdScript", type: "image", target: "media/image2.svg" },
      ],
    }));
    const [stored, linked, vector] = paragraphs(document.body)[0]!.inlines;

    expect(stored).toMatchObject({ kind: "image", contentType: "image/png", width: 100, height: 50, description: "A chart of sales" });
    expect(stored!.kind === "image" && stored.bytes).toEqual(PNG);
    expect(linked).toEqual({ kind: "unsupported", what: "picture" });
    expect(vector).toEqual({ kind: "unsupported", what: "picture" });
    expect(document.omitted).toEqual(["picture"]);
  });

  it("keeps only web and mail links", async () => {
    const link = (id: string, label: string) => `<w:hyperlink r:id="${id}">${run(label)}</w:hyperlink>`;
    const document = await readDocxDocument(await buildLayoutDocx({
      body: paragraph(link("rIdWeb", "web") + link("rIdMail", "mail") + link("rIdScript", "script") + link("rIdFile", "file")),
      relationships: [
        { id: "rIdWeb", type: "hyperlink", target: "https://example.com/a b", external: true },
        { id: "rIdMail", type: "hyperlink", target: "mailto:someone@example.com", external: true },
        { id: "rIdScript", type: "hyperlink", target: "javascript:alert(1)", external: true },
        { id: "rIdFile", type: "hyperlink", target: "file:///etc/passwd", external: true },
      ],
    }));
    const links = paragraphs(document.body)[0]!.inlines.map(inline => inline.kind === "text" ? [inline.text, inline.href] : []);

    expect(links).toEqual([["web", "https://example.com/a%20b"], ["mail", "mailto:someone@example.com"], ["script", undefined], ["file", undefined]]);
  });

  it("reads the first section's page, header and footer, and starts a new page only where asked", async () => {
    const section = (type: string) => `<w:pPr><w:sectPr><w:type w:val="${type}"/><w:pgSz w:w="11906" w:h="16838"/>` +
      '<w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800" w:header="708" w:footer="708"/>' +
      '<w:headerReference w:type="default" r:id="rIdHeader"/><w:footerReference w:type="default" r:id="rIdFooter"/></w:sectPr></w:pPr>';
    const document = await readDocxDocument(await buildLayoutDocx({
      header: paragraph(run("Confidential")),
      footer: paragraph(`<w:r><w:t>Page </w:t></w:r><w:fldSimple w:instr=" PAGE ">${run("7")}</w:fldSimple>`),
      body:
        `<w:p>${section("nextPage")}${run("one")}</w:p>` +
        `<w:p>${section("continuous")}${run("two")}</w:p>` +
        paragraph(run("three") + '<w:r><w:br w:type="page"/></w:r>' + run("four")) +
        paragraph(run("five"), "<w:pageBreakBefore/>") +
        '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>',
    }));

    expect(document.page).toMatchObject({ width: 595.3, height: 841.9, marginLeft: 90, marginTop: 72, headerDistance: 35.4 });
    expect(paragraphs(document.header).map(text)).toEqual(["Confidential"]);
    expect(paragraphs(document.footer).map(text)).toEqual(["Page 7"]);
    // The second section is continuous, so only the third starts a page; then the two explicit breaks.
    expect(document.body.map(block => block.kind === "paragraph" ? text(block) : "|")).toEqual(["one", "two", "|", "three", "|", "four", "|", "five"]);
  });

  it("names what it does not draw and numbers footnote references", async () => {
    const drawing = (uri: string) => `<w:r><w:drawing><wp:inline><a:graphic><a:graphicData uri="${uri}"/></a:graphic></wp:inline></w:drawing></w:r>`;
    const document = await readDocxDocument(await buildLayoutDocx({
      body: paragraph(
        run("See") + '<w:r><w:footnoteReference w:id="12"/></w:r>' +
        drawing("http://schemas.openxmlformats.org/drawingml/2006/chart") +
        '<w:r><w:pict><v:shape xmlns:v="urn:schemas-microsoft-com:vml"><v:textbox><w:txbxContent><w:p/></w:txbxContent></v:textbox></v:shape></w:pict></w:r>' +
        '<m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><m:r><m:t>x</m:t></m:r></m:oMath>' +
        `<w:del>${run("deleted")}</w:del>` + run("hidden", "<w:vanish/>"),
      ),
    }));
    const { inlines } = paragraphs(document.body)[0]!;

    expect(inlines.map(inline => inline.kind === "text" ? inline.text : inline.kind === "unsupported" ? inline.what : inline.kind))
      .toEqual(["See", "1", "chart", "textBox", "equation"]);
    expect(inlines[1]).toMatchObject({ run: { verticalAlign: "superscript" } });
    expect(document.omitted).toEqual(["notes", "chart", "textBox", "equation"]);
  });

  it("drops same-style spacing where a paragraph asks for contextual spacing", async () => {
    const document = await readDocxDocument(await buildLayoutDocx({
      styles: '<w:style w:type="paragraph" w:styleId="Item"><w:name w:val="Item"/><w:pPr><w:spacing w:before="120" w:after="120"/><w:contextualSpacing/></w:pPr></w:style>',
      body: paragraph(run("a"), '<w:pStyle w:val="Item"/>') + paragraph(run("b"), '<w:pStyle w:val="Item"/>') + paragraph(run("c")),
    }));

    expect(paragraphs(document.body).map(block => [block.spacingBefore, block.spacingAfter])).toEqual([[6, 0], [0, 6], [0, 0]]);
  });

  it("stops at its block limit and says so", async () => {
    const document = await readDocxDocument(await buildLayoutDocx({ body: paragraph(run("x")).repeat(5_010) }));

    expect(document.body).toHaveLength(5_000);
    expect(document.truncated).toBe(true);
  });

  it("keeps the page setup, header and footer of a document cut short, and of one exactly at the limit", async () => {
    const section = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:headerReference w:type="default" r:id="rIdHeader"/></w:sectPr>';
    const read = (blocks: number) => buildLayoutDocx({
      header: paragraph(run("Confidential")),
      body: paragraph(run("x")).repeat(blocks) + section,
    }).then(readDocxDocument);

    const cut = await read(5_010);
    expect(cut.truncated).toBe(true);
    expect(cut.page).toMatchObject({ width: 595.3, height: 841.9 });
    expect(paragraphs(cut.header).map(text)).toEqual(["Confidential"]);

    const whole = await read(5_000);
    expect(whole.truncated).toBe(false);
    expect(paragraphs(whole.header).map(text)).toEqual(["Confidential"]);
  });
});
