import { describe, expect, it } from "vitest";
import { docxToMarkdown } from "../../src/content/docx";
import { buildDocx, paragraph, run, type DocxFixture } from "./test-fixtures";

async function convert(fixture: DocxFixture, maxChars?: number) {
  return docxToMarkdown(await buildDocx(fixture), { maxChars });
}

async function markdownOf(fixture: DocxFixture): Promise<string> {
  return (await convert(fixture)).markdown;
}

const style = (id: string, name: string, extra = "") =>
  `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/>${extra}</w:style>`;
const styled = (styleId: string, text: string) => paragraph(run(text), `<w:pStyle w:val="${styleId}"/>`);

describe("docxToMarkdown", () => {
  describe("headings", () => {
    it("recognises heading styles by name, including localized style ids", async () => {
      const markdown = await markdownOf({
        styles: style("Title", "Title") + style("berschrift1", "heading 1") + style("berschrift2", "heading 2") + style("H7", "heading 7"),
        body: styled("Title", "Report") + styled("berschrift1", "Einleitung") + styled("berschrift2", "Details") + styled("H7", "Deep"),
      });
      expect(markdown).toBe("# Report\n\n# Einleitung\n\n## Details\n\n###### Deep");
    });

    it("inherits heading levels through basedOn and outline levels", async () => {
      const markdown = await markdownOf({
        styles: style("Heading2", "heading 2") + style("Custom", "Fancy Heading", '<w:basedOn w:val="Heading2"/>')
          + style("Outline", "Outlined", '<w:pPr><w:outlineLvl w:val="2"/></w:pPr>') + style("Body", "Body", '<w:pPr><w:outlineLvl w:val="9"/></w:pPr>'),
        body: styled("Custom", "Inherited") + styled("Outline", "By outline") + styled("Body", "Body text"),
      });
      expect(markdown).toBe("## Inherited\n\n### By outline\n\nBody text");
    });

    it("falls back to conventional style ids when the document has no styles part", async () => {
      expect(await markdownOf({ body: styled("Heading3", "Three") + styled("Normal", "Text") })).toBe("### Three\n\nText");
    });

    it("survives a basedOn cycle", async () => {
      const markdown = await markdownOf({
        styles: style("A", "a", '<w:basedOn w:val="B"/>') + style("B", "b", '<w:basedOn w:val="A"/>'),
        body: styled("A", "Plain"),
      });
      expect(markdown).toBe("Plain");
    });
  });

  describe("lists", () => {
    const numbering = `
      <w:abstractNum w:abstractNumId="0">
        <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/></w:lvl>
        <w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/></w:lvl>
        <w:lvl w:ilvl="2"><w:start w:val="1"/><w:numFmt w:val="bullet"/></w:lvl>
      </w:abstractNum>
      <w:abstractNum w:abstractNumId="1">
        <w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl>
        <w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/></w:lvl>
      </w:abstractNum>
      <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
      <w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
      <w:num w:numId="3"><w:abstractNumId w:val="0"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="5"/></w:lvlOverride></w:num>`;
    const item = (numId: number, level: number, text: string) =>
      paragraph(run(text), `<w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${numId}"/></w:numPr>`);

    it("renders nested numbered and bulleted lists, restarting deeper counters", async () => {
      const markdown = await markdownOf({
        numbering,
        body: item(1, 0, "First") + item(1, 1, "Sub a") + item(1, 1, "Sub b") + item(1, 2, "Bullet")
          + item(1, 0, "Second") + item(1, 1, "Sub again"),
      });
      expect(markdown).toBe([
        "1. First",
        "    1. Sub a",
        "    2. Sub b",
        "        - Bullet",
        "2. Second",
        "    1. Sub again",
      ].join("\n"));
    });

    it("separates lists from paragraphs and continues numbering across them, as Word does", async () => {
      const markdown = await markdownOf({
        numbering,
        body: item(2, 0, "Bullet") + item(2, 1, "Numbered") + paragraph(run("Between")) + item(1, 0, "One") + paragraph(run("Interrupted")) + item(1, 0, "Two"),
      });
      expect(markdown).toBe("- Bullet\n    1. Numbered\n\nBetween\n\n1. One\n\nInterrupted\n\n2. Two");
    });

    it("honours start overrides and clamps skipped levels", async () => {
      expect(await markdownOf({ numbering, body: item(3, 0, "Five") + item(3, 2, "Skipped to level 2") }))
        .toBe("5. Five\n    - Skipped to level 2");
    });

    it("takes numbering from the paragraph style, and numId 0 removes it", async () => {
      const markdown = await markdownOf({
        numbering,
        styles: style("ListBullet", "List Bullet", '<w:pPr><w:numPr><w:numId w:val="2"/></w:numPr></w:pPr>'),
        body: styled("ListBullet", "Styled bullet")
          + paragraph(run("Unnumbered"), '<w:pStyle w:val="ListBullet"/><w:numPr><w:numId w:val="0"/></w:numPr>'),
      });
      expect(markdown).toBe("- Styled bullet\n\nUnnumbered");
    });

    it("treats numbering without a numbering part as bullets", async () => {
      expect(await markdownOf({ body: item(9, 0, "Orphan") })).toBe("- Orphan");
    });

    it("indents continuation lines under the marker", async () => {
      const body = paragraph(`${run("Line one")}<w:r><w:br/></w:r>${run("Line two")}`, '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>');
      expect(await markdownOf({ numbering, body })).toBe("1. Line one\n   Line two");
    });
  });

  describe("tables", () => {
    const cell = (content: string, properties = "") => `<w:tc>${properties ? `<w:tcPr>${properties}</w:tcPr>` : ""}${content}</w:tc>`;
    const row = (...cells: string[]) => `<w:tr>${cells.join("")}</w:tr>`;

    it("renders a GFM table, escaping pipes and joining cell lines with <br>", async () => {
      const table = `<w:tbl><w:tblGrid/>${row(cell(paragraph(run("Name"))), cell(paragraph(run("Notes"))))}`
        + `${row(cell(paragraph(run("a|b"))), cell(paragraph(run("line 1")) + paragraph(run("line 2"))))}</w:tbl>`;
      expect(await markdownOf({ body: paragraph(run("Before")) + table })).toBe(
        "Before\n\n| Name | Notes |\n| --- | --- |\n| a\\|b | line 1<br>line 2 |",
      );
    });

    it("pads horizontally merged cells and empties vertically merged ones", async () => {
      const table = "<w:tbl>"
        + row(cell(paragraph(run("Wide")), '<w:gridSpan w:val="2"/>'), cell(paragraph(run("Tall")), '<w:vMerge w:val="restart"/>'))
        + row(cell(paragraph(run("x"))), cell(paragraph(run("y"))), cell(paragraph(run("hidden")), "<w:vMerge/>"))
        + "</w:tbl>";
      expect(await markdownOf({ body: table })).toBe("| Wide |  | Tall |\n| --- | --- | --- |\n| x | y |  |");
    });

    it("drops rows deleted under tracked changes and flattens nested tables", async () => {
      const nested = `<w:tbl>${row(cell(paragraph(run("n1"))), cell(paragraph(run("n2"))))}</w:tbl>`;
      const table = "<w:tbl>"
        + row(cell(paragraph(run("Head"))))
        + `<w:tr><w:trPr><w:del w:id="1" w:author="a"/></w:trPr>${cell(paragraph(run("Deleted row")))}</w:tr>`
        + row(cell(nested))
        + "</w:tbl>";
      expect(await markdownOf({ body: table })).toBe("| Head |\n| --- |\n| n1; n2 |");
    });
  });

  describe("inline formatting", () => {
    it("renders bold, italic, strikethrough and monospace runs, merging adjacent runs", async () => {
      const body = paragraph(
        run("Plain ") + run("bold", "<w:b/>") + run(" also bold", "<w:b/>") + run(" and ") + run("italic", "<w:i/>")
        + run(" ") + run("gone", "<w:strike/>") + run(" ") + run("code()", '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>')
        + run(" not bold", '<w:b w:val="0"/>'),
      );
      expect(await markdownOf({ body })).toBe("Plain **bold also bold** and *italic* ~~gone~~ `code()` not bold");
    });

    it("applies character styles but not paragraph-style formatting", async () => {
      const styles = '<w:style w:type="character" w:styleId="Strong"><w:name w:val="Strong"/><w:rPr><w:b/></w:rPr></w:style>'
        + style("Heading1", "heading 1", "<w:rPr><w:b/></w:rPr>");
      const body = styled("Heading1", "Not doubly bold") + paragraph(run("Strong", '<w:rStyle w:val="Strong"/>'));
      expect(await markdownOf({ styles, body })).toBe("# Not doubly bold\n\n**Strong**");
    });

    it("keeps emphasis markers inside surrounding whitespace", async () => {
      expect(await markdownOf({ body: paragraph(run("a") + run(" spaced ", "<w:b/>") + run("b")) })).toBe("a **spaced** b");
    });

    it("escapes Markdown syntax in text without over-escaping prose", async () => {
      const body = paragraph(run("Use *stars*, [brackets], `ticks` and <tags> in snake_case or 2 * 3"))
        + paragraph(run("# not a heading")) + paragraph(run("> not a quote")) + paragraph(run("1. typed list"));
      expect(await markdownOf({ body })).toBe(
        "Use \\*stars\\*, \\[brackets\\], \\`ticks\\` and \\<tags> in snake_case or 2 * 3\n\n\\# not a heading\n\n\\> not a quote\n\n1. typed list",
      );
    });

    it("renders tabs and line breaks, and skips hidden text", async () => {
      const body = paragraph(`${run("a")}<w:r><w:tab/></w:r>${run("b")}<w:r><w:br/></w:r>${run("c")}${run("hidden", "<w:vanish/>")}`);
      expect(await markdownOf({ body })).toBe("a\tb\nc");
    });
  });

  describe("hyperlinks", () => {
    const relationships = [
      { id: "rIdLink", type: "hyperlink", target: "https://example.com/a path", external: true },
      { id: "rIdBad", type: "hyperlink", target: "javascript:alert(1)", external: true },
    ];

    it("links external relationships and leaves bookmarks and unsafe schemes as text", async () => {
      const body = paragraph(
        `<w:hyperlink r:id="rIdLink">${run("Example", "<w:b/>")}</w:hyperlink>${run(" ")}`
        + `<w:hyperlink w:anchor="_Toc1">${run("Section")}</w:hyperlink>${run(" ")}`
        + `<w:hyperlink r:id="rIdBad">${run("Click")}</w:hyperlink>`,
      );
      expect(await markdownOf({ relationships, body })).toBe("[**Example**](https://example.com/a%20path) Section Click");
    });

    it("links HYPERLINK fields and drops field codes, keeping results", async () => {
      const body = paragraph(
        '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> HYPERLINK "https://example.org/" </w:instrText></w:r>'
        + `<w:r><w:fldChar w:fldCharType="separate"/></w:r>${run("field link")}<w:r><w:fldChar w:fldCharType="end"/></w:r>`
        + run(" page ")
        + '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>PAGE</w:instrText></w:r>'
        + `<w:r><w:fldChar w:fldCharType="separate"/></w:r>${run("3")}<w:r><w:fldChar w:fldCharType="end"/></w:r>`,
      );
      expect(await markdownOf({ body })).toBe("[field link](https://example.org/) page 3");
    });
  });

  it("reads tracked insertions and skips tracked deletions", async () => {
    const body = paragraph(
      run("The ")
      + `<w:del w:id="1" w:author="a"><w:r><w:delText>old</w:delText></w:r></w:del>`
      + `<w:ins w:id="2" w:author="a">${run("new")}</w:ins>`
      + `<w:moveFrom w:id="3" w:author="a">${run(" moved-away")}</w:moveFrom>`
      + run(" text"),
    );
    expect(await markdownOf({ body })).toBe("The new text");
  });

  it("renders images as placeholders with their description and part", async () => {
    const drawing = (descr: string) => `<w:r><w:drawing><wp:inline><wp:docPr id="1" name="Picture 1" descr="${descr}"/>`
      + '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><a:blip r:embed="rIdImg"/></a:graphicData></a:graphic>'
      + "</wp:inline></w:drawing></w:r>";
    const result = await convert({
      relationships: [{ id: "rIdImg", type: "image", target: "media/image1.png" }],
      body: paragraph(drawing("Revenue [2024]")) + paragraph(drawing("")),
    });
    expect(result.markdown).toBe("![Revenue \\[2024\\]](word/media/image1.png)\n\n![image](word/media/image1.png)");
  });

  it("renders chart placeholders with a warning", async () => {
    const chart = '<w:r><w:drawing><wp:inline><wp:docPr id="1" name="Chart" title="Sales"/>'
      + '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"/></a:graphic></wp:inline></w:drawing></w:r>';
    const result = await convert({ body: paragraph(chart) });
    expect(result.markdown).toBe("![Chart: Sales]()");
    expect(result.warnings).toEqual(["Charts are shown as placeholders; their data is not converted."]);
  });

  it("renders text box content after its paragraph, once", async () => {
    const textBox = '<w:r><mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">'
      + '<mc:Choice Requires="wps"><w:drawing><wp:anchor><wp:docPr id="2" name="Text Box"/><a:graphic>'
      + '<a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:txbx>'
      + `<w:txbxContent>${paragraph(run("Boxed text"))}</w:txbxContent></wps:txbx></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice>`
      + `<mc:Fallback><w:pict><v:shape xmlns:v="urn:schemas-microsoft-com:vml"><v:textbox><w:txbxContent>${paragraph(run("Boxed text"))}</w:txbxContent></v:textbox></v:shape></w:pict></mc:Fallback>`
      + "</mc:AlternateContent></w:r>";
    expect(await markdownOf({ body: paragraph(run("Anchor") + textBox) })).toBe("Anchor\n\nBoxed text");
  });

  it("appends referenced footnotes as GFM footnote definitions", async () => {
    const markdown = await markdownOf({
      footnotes: '<w:footnote w:type="separator" w:id="-1"><w:p/></w:footnote>'
        + `<w:footnote w:id="1">${paragraph('<w:r><w:footnoteRef/></w:r>' + run(" The source."))}</w:footnote>`,
      body: paragraph(run("Claim") + '<w:r><w:footnoteReference w:id="1"/></w:r>'),
    });
    expect(markdown).toBe("Claim[^1]\n\n[^1]: The source.");
  });

  it("reads content controls and skips empty paragraphs", async () => {
    const body = `<w:sdt><w:sdtPr/><w:sdtContent>${paragraph(run("In a control"))}</w:sdtContent></w:sdt>` + paragraph("") + paragraph(run("After"));
    expect(await markdownOf({ body })).toBe("In a control\n\nAfter");
  });

  it("stops converting once the output budget is spent", async () => {
    const body = Array.from({ length: 1000 }, (_, index) => paragraph(run(`Paragraph number ${index}`))).join("");
    const result = await convert({ body }, 500);
    expect(result.truncated).toBe(true);
    expect(result.markdown.length).toBeLessThan(600);
    expect(result.markdown.startsWith("Paragraph number 0\n\nParagraph number 1")).toBe(true);
  });
});
