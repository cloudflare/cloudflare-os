import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { docxToMarkdown } from "../../src/content/docx";
import { DocumentEditError, editDocx, type DocumentEdit } from "../../src/content/docx-edit";
import { docxFeatures, markdownToDocx } from "../../src/content/docx-write";
import { parsePart } from "../../src/content/ooxml";
import { OpcPackage } from "../../src/content/pptx-package";
import { attribute, childElements, descendants, firstChild } from "../../src/content/xml";
import { openZip } from "../../src/content/zip";
import { writeZip } from "../../src/content/zip-write";
import { validateDocx } from "./docx-validate";
import { buildDocx, paragraph, run } from "./test-fixtures";

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../fixtures/${name}`, import.meta.url).pathname));
const REPORT = fixture("python-docx-report.docx");
const DATE = new Date("2026-05-06T07:08:09.000Z");
const TRACKED = { trackChanges: true, author: "Gadgets Agent", date: DATE };
const SILENT = { trackChanges: false, author: "Gadgets Agent", date: DATE };
/** python-docx marks a comment's reference with a style its template doesn't define; Word ignores that. */
const PYTHON_DOCX_GAPS = ["CommentReference"];

async function documentXml(bytes: Uint8Array): Promise<string> {
  return openZip(bytes).readText("word/document.xml");
}

async function markdown(bytes: Uint8Array): Promise<string> {
  return (await docxToMarkdown(bytes)).markdown;
}

async function edit(bytes: Uint8Array, edits: DocumentEdit[], options = TRACKED) {
  const result = await editDocx(bytes, edits, options);
  // The hand-built fixtures declare no content types, so only a real package is held to all of them.
  if ((await openZip(bytes).readText("[Content_Types].xml")).includes("Override")) await validateDocx(result.bytes, { missingStyles: PYTHON_DOCX_GAPS });
  return result;
}

describe("editDocx: replacing text", () => {
  it("starts from a fixture that passes the structural checks", async () => {
    await validateDocx(REPORT, { missingStyles: PYTHON_DOCX_GAPS });
  });

  it("matches across the runs Word splits a sentence into, keeping their formatting", async () => {
    const { bytes, changes } = await edit(REPORT, [{ find: "Budget remains within the approved", replace: "Spending is under the revised" }], SILENT);
    expect(await markdown(bytes)).toContain("\n\nSpending is under the revised envelope.\n\n");
    expect(changes).toEqual([{ before: "Budget remains within the approved envelope.", after: "Spending is under the revised envelope." }]);
  });

  it("records a tracked replacement as a deletion and an insertion by the author", async () => {
    const { bytes } = await edit(REPORT, [{ find: "on track", replace: "two weeks late" }]);
    const xml = await documentXml(bytes);
    expect(xml).toContain(`<w:del w:id="`);
    const deleted = /<w:del ([^>]*)><w:r><w:rPr><w:b\/><\/w:rPr><w:delText xml:space="preserve">on track<\/w:delText><\/w:r><\/w:del>/.exec(xml);
    expect(deleted?.[1]).toMatch(/w:author="Gadgets Agent" w:date="2026-05-06T07:08:09Z"/);
    // The inserted text takes the bold of the text it replaces.
    expect(xml).toMatch(/<w:ins [^>]*w:author="Gadgets Agent"[^>]*><w:r><w:rPr><w:b\/><\/w:rPr><w:t xml:space="preserve">two weeks late<\/w:t><\/w:r><\/w:ins>/);
    // Read as if accepted.
    expect(await markdown(bytes)).toContain("The launch is **two weeks late** for the *third* quarter");
  });

  it("replaces part of a run, splitting it around the change", async () => {
    const { bytes } = await edit(REPORT, [{ find: "security review", replace: "privacy review" }]);
    const xml = await documentXml(bytes);
    expect(xml).toContain('<w:r><w:t xml:space="preserve"> quarter, pending the vendor’s </w:t></w:r><w:del');
    expect(xml).toMatch(/<w:del [^>]*><w:r><w:delText xml:space="preserve">security review<\/w:delText><\/w:r><\/w:del><w:ins [^>]*><w:r><w:t xml:space="preserve">privacy review<\/w:t><\/w:r><\/w:ins><w:r><w:t xml:space="preserve">.<\/w:t><\/w:r><\/w:p>/);
    expect(await markdown(bytes)).toContain("pending the vendor’s privacy review.");
  });

  it("matches curly quotes and non-breaking spaces by their plain forms", async () => {
    const { bytes } = await edit(REPORT, [{ find: "the vendor's security", replace: "the vendor's" }], SILENT);
    expect(await markdown(bytes)).toContain("pending the vendor's review.");
  });

  it("refuses text that occurs more than once, saying how often, unless all is set", async () => {
    const twice = await buildDocx({ body: paragraph(run("Status: draft")) + paragraph(run("Owner: draft")) });
    await expect(editDocx(twice, [{ find: "draft", replace: "final" }], TRACKED)).rejects.toThrow(/"draft" occurs 2 times; quote more/);
    await expect(editDocx(twice, [{ find: "draft", replace: "final" }], TRACKED)).rejects.toBeInstanceOf(DocumentEditError);
    const { bytes, changes } = await edit(twice, [{ find: "draft", replace: "final", all: true }]);
    expect(await markdown(bytes)).toBe("Status: final\n\nOwner: final");
    expect(changes).toHaveLength(2);
  });

  it("replaces every occurrence within one paragraph", async () => {
    const doc = await buildDocx({ body: paragraph(run("a-b") + run("-a") + run("-b-a")) });
    const { bytes, changes } = await edit(doc, [{ find: "a", replace: "Z", all: true }]);
    expect(await markdown(bytes)).toBe("Z-b-Z-b-Z");
    expect(changes).toEqual([{ before: "a-b-a-b-a", after: "Z-b-Z-b-Z" }]);
    const silent = await edit(doc, [{ find: "-b-", replace: "+", all: true }], SILENT);
    expect(await markdown(silent.bytes)).toBe("a+a+a");
  });

  it("explains a miss, and points out one that differs only in capitalization", async () => {
    await expect(editDocx(REPORT, [{ find: "budget remains", replace: "x" }], TRACKED)).rejects.toThrow(/differs in capitalization from "Budget remains"/);
    await expect(editDocx(REPORT, [{ find: "Contoso Ltd.", replace: "x" }], TRACKED)).rejects.toThrow(/wasn't found in the document's body.*headers, footers/);
    await expect(editDocx(REPORT, [{ find: "", replace: "x" }], TRACKED)).rejects.toThrow(/empty/);
  });

  it("names the edit that failed", async () => {
    const error = await editDocx(REPORT, [{ find: "on track", replace: "x" }, { find: "nowhere", replace: "y" }], TRACKED).catch(caught => caught);
    expect(error).toBeInstanceOf(DocumentEditError);
    expect(error.editIndex).toBe(1);
    expect(error.message).toMatch(/^Edit 2: "nowhere" wasn't found/);
  });

  it("won't cut through a picture or field inside the matched text", async () => {
    const doc = await buildDocx({ body: paragraph(run("before ") + '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>PAGE</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>' + run("1") + '<w:r><w:fldChar w:fldCharType="end"/></w:r>' + run(" after")) });
    await expect(editDocx(doc, [{ find: "before 1 after", replace: "x" }], TRACKED)).rejects.toThrow(/spans a picture, field/);
    const { bytes } = await edit(doc, [{ find: "after", replace: "later" }]);
    expect(await documentXml(bytes)).toContain("<w:instrText>PAGE</w:instrText>");
  });

  it("reads a colleague's pending changes as accepted, editing around them", async () => {
    const pending = '<w:del w:id="7" w:author="Sam" w:date="2026-01-01T00:00:00Z"><w:r><w:delText>old </w:delText></w:r></w:del>'
      + '<w:ins w:id="8" w:author="Sam" w:date="2026-01-01T00:00:00Z"><w:r><w:t xml:space="preserve">new </w:t></w:r></w:ins>';
    const doc = await buildDocx({ body: paragraph(run("The ") + pending + run("plan.")) });
    await expect(editDocx(doc, [{ find: "old plan", replace: "x" }], TRACKED)).rejects.toThrow(/wasn't found/);
    const { bytes } = await edit(doc, [{ find: "new plan", replace: "final plan" }]);
    const xml = await documentXml(bytes);
    expect(xml).toContain('<w:del w:id="7" w:author="Sam" w:date="2026-01-01T00:00:00Z"><w:r><w:delText>old </w:delText></w:r></w:del>');
    // Sam's pending insertion is deleted inside his revision; Word shows it as his text struck through by the agent.
    expect(xml).toMatch(/<w:ins w:id="8" [^>]*><w:del w:id="(9|1\d)" w:author="Gadgets Agent"[^>]*><w:r><w:delText xml:space="preserve">new <\/w:delText>/);
    expect(await markdown(bytes)).toBe("The final plan.");
  });

  it("matches tabs and line breaks, and writes them back", async () => {
    const { bytes } = await edit(REPORT, [{ find: "Owners\tDue", replace: "Owner\tDate\nTBD" }], SILENT);
    const xml = await documentXml(bytes);
    expect(xml).toContain('<w:t xml:space="preserve">Owner</w:t><w:tab/><w:t xml:space="preserve">Date</w:t><w:br/><w:t xml:space="preserve">TBD</w:t>');
  });

  it("declares the relationships prefix on a document that never had one when a link is inserted", async () => {
    const pkg = await OpcPackage.open(await markdownToDocx("Plain prose."));
    const xmlnsR = ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
    expect(pkg.text("word/document.xml")).toContain(xmlnsR);
    pkg.set("word/document.xml", pkg.text("word/document.xml")!.replace(xmlnsR, ""));
    const { bytes } = await edit(await pkg.toBytes(), [{ insertAfter: "Plain prose.", markdown: "See [the plan](https://example.com/plan)." }], SILENT);
    const xml = await documentXml(bytes);
    expect(xml).toContain("<w:hyperlink r:id=");
    expect(/<w:document\b[^>]*>/.exec(xml)![0]).toContain(xmlnsR);
  });

  it("edits text inside a table cell and a hyperlink", async () => {
    const { bytes } = await edit(REPORT, [{ find: "In review", replace: "Approved" }]);
    expect(await markdown(bytes)).toContain("| Security | Priya | Approved |");
    const linked = await markdownToDocx("See [the plan](https://example.com/plan) today.");
    const result = await edit(linked, [{ find: "the plan", replace: "our plan" }]);
    expect(await markdown(result.bytes)).toBe("See [our plan](https://example.com/plan) today.");
  });
});

describe("editDocx: keeping everything else", () => {
  it("leaves every other part, and every other paragraph, byte for byte", async () => {
    const { bytes } = await edit(REPORT, [{ find: "Closing remarks.", replace: "Thanks." }]);
    const before = openZip(REPORT);
    const after = openZip(bytes);
    expect(after.entries().map(entry => entry.name)).toEqual(before.entries().map(entry => entry.name));
    for (const entry of before.entries()) {
      if (entry.name === "word/document.xml") continue;
      expect(await after.readBytes(entry.name), entry.name).toEqual(await before.readBytes(entry.name));
    }
    const original = await before.readText("word/document.xml");
    const edited = await after.readText("word/document.xml");
    const at = original.indexOf("Closing remarks.");
    const paragraphStart = original.lastIndexOf("<w:p>", at);
    const paragraphEnd = original.indexOf("</w:p>", at) + "</w:p>".length;
    expect(edited.slice(0, paragraphStart)).toBe(original.slice(0, paragraphStart));
    expect(edited.endsWith(original.slice(paragraphEnd))).toBe(true);
  });

  it("keeps the comment anchored to the text it was on", async () => {
    const { bytes } = await edit(REPORT, [{ find: "before Friday", replace: "by Thursday" }]);
    const xml = await documentXml(bytes);
    expect(xml).toMatch(/<w:commentRangeStart w:id="0"\/>[\s\S]*by Thursday[\s\S]*<w:commentRangeEnd w:id="0"\/>/);
    expect(await docxFeatures(bytes)).toContain("1 comment");
  });

  it("numbers its revisions above every id the document already uses", async () => {
    const { bytes } = await edit(REPORT, [
      { find: "on track", replace: "late" }, { deleteParagraph: "Closing remarks." }, { insertAfter: "Summary", markdown: "New *text*.\n\n- a\n- b" },
    ]);
    const document = parsePart(await documentXml(bytes));
    const ids = ["w:ins", "w:del"].flatMap(name => Array.from(descendants(document, name), element => Number(attribute(element, "w:id"))));
    expect(ids.length).toBeGreaterThan(5);
    expect(new Set(ids).size).toBe(ids.length);
    expect(Math.min(...ids)).toBeGreaterThan(0); // the comment and bookmark ids are 0
  });
});

describe("editDocx: inserting Markdown", () => {
  it("inserts after a paragraph in the document's own styles, as tracked insertions", async () => {
    const { bytes, changes } = await edit(REPORT, [{ insertAfter: "Budget remains", markdown: "## Next steps\n\nAgree the **scope** by [Friday](https://example.com/cal).\n\n- Book the room\n- Send the agenda" }]);
    const xml = await documentXml(bytes);
    // The report's own Heading 2 and List Bullet, not new definitions.
    expect(xml).toMatch(/<w:p><w:pPr><w:pStyle w:val="Heading2"\/><w:rPr><w:ins [^>]*\/><\/w:rPr><\/w:pPr><w:ins [^>]*><w:r><w:t xml:space="preserve">Next steps/);
    expect(xml.match(/<w:pStyle w:val="ListBullet"\/><w:rPr><w:ins /g)).toHaveLength(2);
    // The report has no Hyperlink style, so that one alone is added, after the report's own.
    const styles = await openZip(bytes).readText("word/styles.xml");
    const original = await openZip(REPORT).readText("word/styles.xml");
    expect(styles.startsWith(original.slice(0, original.lastIndexOf("</w:styles>")))).toBe(true);
    expect(styles.slice(original.lastIndexOf("</w:styles>")).match(/w:styleId="[^"]+"/g)).toEqual(['w:styleId="Hyperlink"']);
    expect(await markdown(bytes)).toContain("Budget remains within the approved envelope.\n\n## Next steps\n\nAgree the **scope** by [Friday](https://example.com/cal).\n\n- Book the room\n- Send the agenda\n\n# Milestones");
    expect(changes).toEqual([{ after: "## Next steps\n\nAgree the **scope** by [Friday](https://example.com/cal).\n\n- Book the room\n- Send the agenda" }]);
    expect(await openZip(bytes).readText("word/_rels/document.xml.rels")).toContain('Target="https://example.com/cal" TargetMode="External"');
  });

  it("inserts before a paragraph, restarting a numbered list in the document's List Number style", async () => {
    const { bytes } = await edit(REPORT, [{ insertBefore: "Closing remarks.", markdown: "1. First\n2. Second" }], SILENT);
    expect(await markdown(bytes)).toContain("Colors: red text\n\n1. First\n2. Second\n\nClosing remarks.");
    const numbering = await openZip(bytes).readText("word/numbering.xml");
    expect(numbering).toContain('<w:startOverride w:val="1"/>');
  });

  it("adds styles a document lacks, and a table that stays apart from its neighbours", async () => {
    const plain = await buildDocx({ body: paragraph(run("Intro")) + "<w:tbl><w:tblPr/><w:tblGrid><w:gridCol/></w:tblGrid><w:tr><w:tc><w:p/></w:tc></w:tr></w:tbl>" + paragraph(run("Outro")) });
    const { bytes } = await edit(plain, [{ insertBefore: "Outro", markdown: "| A | B |\n|---|---|\n| 1 | 2 |" }]);
    const body = childElements(firstChild(parsePart(await documentXml(bytes)), "w:body")).map(element => element.name);
    expect(body).toEqual(["w:p", "w:tbl", "w:p", "w:tbl", "w:p"]);
    expect(await openZip(bytes).readText("word/styles.xml")).toContain('w:styleId="GridTable4-Accent1"');
    expect(await markdown(bytes)).toContain("| A | B |\n| --- | --- |\n| 1 | 2 |\n\nOutro");
  });

  it("lays an inserted table out in the style the document's tables already use", async () => {
    const { bytes } = await edit(REPORT, [{ insertAfter: "Closing remarks.", markdown: "| Item | Cost |\n|---|---:|\n| Room | $40 |" }]);
    const xml = await documentXml(bytes);
    expect(xml.match(/<w:tblStyle w:val="LightGrid-Accent1"\/>/g)).toHaveLength(2);
    expect(await openZip(bytes).readText("word/styles.xml")).not.toContain("GridTable4-Accent1");
    expect(xml).toMatch(/<w:trPr><w:cantSplit\/><w:tblHeader\/><w:ins [^>]*\/><\/w:trPr>/);
  });

  it("creates the numbering part a document without lists needs", async () => {
    const plain = await buildDocx({ body: paragraph(run("Intro")) });
    const { bytes } = await edit(plain, [{ insertAfter: "Intro", markdown: "1. one\n2. two" }]);
    const zip = openZip(bytes);
    expect(zip.has("word/numbering.xml")).toBe(true);
    expect(await zip.readText("[Content_Types].xml")).toContain("/word/numbering.xml");
    expect(await markdown(bytes)).toBe("Intro\n\n1. one\n2. two");
  });

  it("refuses an anchor that is in more than one paragraph", async () => {
    const twice = await buildDocx({ body: paragraph(run("Note: one")) + paragraph(run("Note: two")) });
    await expect(editDocx(twice, [{ insertAfter: "Note", markdown: "x" }], TRACKED)).rejects.toThrow(/is in 2 paragraphs/);
  });
});

describe("editDocx: deleting paragraphs", () => {
  it("records a tracked deletion of the text and the paragraph mark", async () => {
    const { bytes, changes } = await edit(REPORT, [{ deleteParagraph: "Figure 1 shows" }]);
    const xml = await documentXml(bytes);
    expect(xml).toMatch(/<w:p><w:pPr><w:rPr><w:del [^>]*\/><\/w:rPr><\/w:pPr><w:del [^>]*><w:r><w:delText>Figure 1 shows the rollout plan.<\/w:delText><\/w:r><\/w:del><\/w:p>/);
    expect(await markdown(bytes)).not.toContain("Figure 1");
    expect(changes).toEqual([{ before: "Figure 1 shows the rollout plan." }]);
  });

  it("removes the paragraph outright when changes aren't tracked", async () => {
    const { bytes } = await edit(REPORT, [{ deleteParagraph: "Colors:" }], SILENT);
    expect(await documentXml(bytes)).not.toContain("Colors:");
    expect(await docxFeatures(bytes)).not.toContain("text colors and highlighting");
  });

  it("deletes a list item's mark after its paragraph properties' own run properties", async () => {
    const doc = await buildDocx({ body: paragraph(run("Keep")) + paragraph(run("Drop"), '<w:jc w:val="center"/><w:rPr><w:b/></w:rPr>') + paragraph(run("End")) });
    const { bytes } = await edit(doc, [{ deleteParagraph: "Drop" }]);
    expect(await documentXml(bytes)).toMatch(/<w:pPr><w:jc w:val="center"\/><w:rPr><w:del [^>]*\/><w:b\/><\/w:rPr><\/w:pPr>/);
  });

  it("refuses deletions that would break the document's structure", async () => {
    const tables = await buildDocx({ body: "<w:tbl><w:tblPr/><w:tblGrid><w:gridCol/></w:tblGrid><w:tr><w:tc><w:p/></w:tc></w:tr></w:tbl>" + paragraph(run("Last")) });
    await expect(editDocx(tables, [{ deleteParagraph: "Last" }], SILENT)).rejects.toThrow(/keeps a table from running into/);
    const single = await buildDocx({ body: paragraph(run("Only")) });
    await expect(editDocx(single, [{ deleteParagraph: "Only" }], SILENT)).rejects.toThrow(/only paragraph/);
    const section = await buildDocx({ body: paragraph(run("Part one"), "<w:sectPr/>") + paragraph(run("Part two")) });
    await expect(editDocx(section, [{ deleteParagraph: "Part one" }], SILENT)).rejects.toThrow(/ends a section/);
  });

  it("empties a cell's only paragraph rather than leaving the cell invalid", async () => {
    const { bytes } = await edit(REPORT, [{ deleteParagraph: "Marcus" }], SILENT);
    expect(await markdown(bytes)).toContain("| Support |  | Hiring |");
  });
});

describe("editDocx: documents it can't edit", () => {
  it("refuses bytes that aren't a Word package", async () => {
    await expect(editDocx(new Uint8Array([1, 2, 3]), [{ find: "a", replace: "b" }], TRACKED)).rejects.toBeInstanceOf(DocumentEditError);
  });

  it("refuses an empty list of edits", async () => {
    await expect(editDocx(REPORT, [], TRACKED)).rejects.toThrow(/No edits/);
  });
});

describe("docxFeatures", () => {
  it("names what a Word-authored report would lose to a rewrite", async () => {
    expect(await docxFeatures(REPORT)).toEqual(["1 comment", "1 image", "headers and footers", "text colors and highlighting"]);
  });

  it("counts tracked changes left for review", async () => {
    const { bytes } = await edit(REPORT, [{ find: "on track", replace: "late" }]);
    expect(await docxFeatures(bytes)).toContain("unaccepted tracked changes");
  });

  it("names footnotes, merged cells, sections and content controls", async () => {
    const doc = await buildDocx({
      body: paragraph(run("Text"), "") + '<w:p><w:r><w:footnoteReference w:id="2"/></w:r></w:p>'
        + '<w:tbl><w:tblPr/><w:tblGrid><w:gridCol/><w:gridCol/></w:tblGrid><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p/></w:tc></w:tr></w:tbl>'
        + '<w:p><w:pPr><w:sectPr/></w:pPr></w:p><w:sdt><w:sdtContent><w:p/></w:sdtContent></w:sdt>'
        + '<w:p><w:bookmarkStart w:id="1" w:name="target"/><w:bookmarkEnd w:id="1"/></w:p><w:sectPr/>',
    });
    expect(await docxFeatures(doc)).toEqual(["1 footnote", "1 content control", "merged table cells", "2 sections", "bookmarks"]);
  });

  it("finds features whatever prefix the document binds, and only in the branch a reader shows", async () => {
    const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
    const MC = "http://schemas.openxmlformats.org/markup-compatibility/2006";
    const doc = await writeZip([{ name: "word/document.xml", data: `<x:document xmlns:x="${W}" xmlns:mc="${MC}"><x:body>` +
      '<x:p><x:r><x:footnoteReference x:id="1"/></x:r></x:p><x:tbl><x:tr><x:tc><x:tbl/></x:tc></x:tr></x:tbl>' +
      '<x:p><mc:AlternateContent><mc:Choice Requires="wps"><x:txbxContent/></mc:Choice><mc:Fallback><x:txbxContent/></mc:Fallback></mc:AlternateContent></x:p>' +
      "</x:body></x:document>" }]);
    expect(await docxFeatures(doc)).toEqual(["1 text box", "1 footnote", "nested tables"]);
  });
});

