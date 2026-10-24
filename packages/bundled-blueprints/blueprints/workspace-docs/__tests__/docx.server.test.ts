// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DOCX_LIMITS, documentToDocx } from "../files/lib/docx.ts";
import type { DocxSettings, DocxSource } from "../files/lib/docx.ts";

// The Word export, read back the way Word reads it: the package is unzipped and its parts' XML
// checked for the structure each kind of block must produce.

const decoder = new TextDecoder();
// A 1x1 PNG.
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG = `data:image/png;base64,${PNG_BASE64}`;

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

/** Every entry of a ZIP stream, by name, read through its central directory. */
async function unzip(stream: ReadableStream<Uint8Array>): Promise<Map<string, Uint8Array>> {
  const archive = new Uint8Array(await new Response(stream).arrayBuffer());
  const eocd = archive.byteLength - 22;
  expect(uint32(archive, eocd)).toBe(0x06054b50);
  const count = uint16(archive, eocd + 10);
  let offset = uint32(archive, eocd + 16);
  const entries = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    expect(uint32(archive, offset)).toBe(0x02014b50);
    const compressedSize = uint32(archive, offset + 20);
    const nameLength = uint16(archive, offset + 28);
    const skip = nameLength + uint16(archive, offset + 30) + uint16(archive, offset + 32);
    const local = uint32(archive, offset + 42);
    const name = decoder.decode(archive.subarray(offset + 46, offset + 46 + nameLength));
    const data = local + 30 + uint16(archive, local + 26) + uint16(archive, local + 28);
    entries.set(name, await inflate(archive.subarray(data, data + compressedSize)));
    offset += 46 + skip;
  }
  return entries;
}

/** The exported package's parts, text ones decoded. */
async function exportDocx(blocks: string[], options: { settings?: DocxSettings } = {}) {
  const source: DocxSource = { blocks: blocks.map((html) => ({ html })), lastModified: Date.UTC(2026, 0, 2) };
  const entries = await unzip(documentToDocx(source, options.settings));
  const part = (name: string) => {
    const bytes = entries.get(name);
    expect(bytes, name).toBeDefined();
    return decoder.decode(bytes);
  };
  return { entries, part, document: part("word/document.xml") };
}

/** The body's paragraphs (those in table cells included), each as its XML. */
function paragraphs(document: string): string[] {
  return document.match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g) ?? [];
}
/** A paragraph's visible text. */
function textOf(xml: string): string {
  return [...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join("");
}
/** The paragraph whose text starts with `start`. */
function paragraph(document: string, start: string): string {
  const found = paragraphs(document).find((p) => textOf(p).startsWith(start));
  expect(found, start).toBeDefined();
  return found!;
}
const attr = (xml: string, pattern: RegExp) => pattern.exec(xml)?.[1];

describe("Word export", () => {
  it("writes a complete package, titled from the document", async () => {
    const { entries, part } = await exportDocx(["<p>Plan</p>", "<p>Hello</p>"]);
    expect([...entries.keys()].toSorted()).toEqual([
      "[Content_Types].xml", "_rels/.rels", "docProps/app.xml", "docProps/core.xml", "word/_rels/document.xml.rels",
      "word/document.xml", "word/fontTable.xml", "word/numbering.xml", "word/settings.xml", "word/styles.xml",
    ]);
    expect(part("docProps/core.xml")).toContain("<dc:title>Plan</dc:title>");
    expect(part("[Content_Types].xml")).toContain('PartName="/word/document.xml"');
    expect(part("_rels/.rels")).toContain('Target="word/document.xml"');
  });

  it("titles the document by its first line, not the stored title no editor shows", async () => {
    const stored = { title: "Stale name", blocks: [{ html: "<p><br></p>" }, { html: "<h1>First &amp; foremost</h1>" }, { html: "<p>body</p>" }], lastModified: 1 };
    const core = decoder.decode((await unzip(documentToDocx(stored))).get("docProps/core.xml"));
    expect(core).toContain("<dc:title>First &amp; foremost</dc:title>");
  });

  it("maps headings to Word's heading styles, h4 and below to the third", async () => {
    const { document } = await exportDocx(["<h1>One</h1>", "<h2>Two</h2>", "<h3>Three</h3>", "<h4>Four</h4>", "<p>Body</p>"]);
    expect(attr(paragraph(document, "One"), /<w:pStyle w:val="([^"]+)"/)).toBe("Heading1");
    expect(attr(paragraph(document, "Two"), /<w:pStyle w:val="([^"]+)"/)).toBe("Heading2");
    expect(attr(paragraph(document, "Three"), /<w:pStyle w:val="([^"]+)"/)).toBe("Heading3");
    expect(attr(paragraph(document, "Four"), /<w:pStyle w:val="([^"]+)"/)).toBe("Heading3");
    expect(paragraph(document, "Body")).not.toContain("<w:pStyle");
  });

  it("writes inline formatting, palette colours and alignment as run and paragraph properties", async () => {
    const { document } = await exportDocx([
      '<p style="text-align: center;"><b>bold</b> <i>italic</i> <u>under</u> <s>strike</s> <span class="tc-red">red</span></p>',
    ]);
    const p = paragraph(document, "bold");
    expect(p).toContain('<w:jc w:val="center"/>');
    const run = (text: string) => [...p.matchAll(/<w:r>([\s\S]*?)<\/w:r>/g)].map((m) => m[1]).find((r) => textOf(r) === text)!;
    expect(run("bold")).toContain("<w:b/>");
    expect(run("italic")).toContain("<w:i/>");
    expect(run("under")).toContain('<w:u w:val="single"/>');
    expect(run("strike")).toContain("<w:strike/>");
    expect(run("red")).toContain('<w:color w:val="D44C47"/>');
  });

  // Each top-level list has its own numbering, so a numbered list restarts as it does on the page;
  // a nested bulleted list is a level of its parent's.
  it("numbers each list on its own, restarting, with nested lists as levels", async () => {
    const { document, part } = await exportDocx([
      "<ol><li>First</li><li>Second</li></ol>",
      "<p>Between</p>",
      '<ol start="5"><li>Fifth</li></ol>',
      "<ul><li>Bullet<ul><li>Nested</li></ul></li></ul>",
    ]);
    const numPr = (start: string) => {
      const p = paragraph(document, start);
      return { numId: attr(p, /<w:numId w:val="(\d+)"/), level: attr(p, /<w:ilvl w:val="(\d+)"/) };
    };
    expect(numPr("First")).toEqual({ numId: "1", level: "0" });
    expect(numPr("Second")).toEqual({ numId: "1", level: "0" });
    expect(numPr("Fifth")).toEqual({ numId: "2", level: "0" });
    expect(numPr("Bullet")).toEqual({ numId: "3", level: "0" });
    expect(numPr("Nested")).toEqual({ numId: "3", level: "1" });

    const numbering = part("word/numbering.xml");
    const abstract = (id: number) => new RegExp(`<w:abstractNum w:abstractNumId="${id}">([\\s\\S]*?)</w:abstractNum>`).exec(numbering)![1];
    const level0 = (id: number) => /<w:lvl w:ilvl="0">([\s\S]*?)<\/w:lvl>/.exec(abstract(id))![1];
    expect(level0(1)).toContain('<w:start w:val="1"/><w:numFmt w:val="decimal"/>');
    expect(level0(2)).toContain('<w:start w:val="5"/><w:numFmt w:val="decimal"/>');
    expect(level0(3)).toContain('<w:numFmt w:val="bullet"/>');
    for (const id of [1, 2, 3]) expect(numbering).toContain(`<w:num w:numId="${id}"><w:abstractNumId w:val="${id}"/></w:num>`);
  });

  // To-do items carry Word's clickable checkbox content control instead of a number.
  it("writes to-do items as clickable checkboxes, done ones struck through", async () => {
    const { document, part } = await exportDocx(['<ul class="checklist"><li data-checked="true">Done</li><li>Open</li></ul>']);
    const done = paragraph(document, "☒Done");
    const open = paragraph(document, "☐Open");
    expect(done).toContain('<w14:checkbox><w14:checked w14:val="1"/>');
    expect(open).toContain('<w14:checkbox><w14:checked w14:val="0"/>');
    expect(done).not.toContain("<w:numPr>");
    expect(done).toMatch(/<w:strike\/>[\s\S]*Done/);
    expect(open).not.toContain("<w:strike/>");
    expect(part("word/numbering.xml")).not.toContain("<w:abstractNum ");
    expect(part("word/fontTable.xml")).toContain('w:name="MS Gothic"');
  });

  // On the page a to-do list inside an item starts past the item's text (its 1.7em padding plus the
  // list's 1.6em); one straight inside the list (as Tab makes it) is one level in.
  it("indents a to-do list inside an item as far as the page does", async () => {
    const { document } = await exportDocx([
      '<ul class="checklist"><li>Parent<ul><li>Child<ul><li>Grandchild</li></ul></li></ul></li></ul>',
      '<ul class="checklist"><li>Tab parent</li><ul><li>Tab child</li></ul></ul>',
    ]);
    const left = (text: string) => Number(attr(paragraph(document, text), /<w:ind w:left="(\d+)"/));
    // 3.3em of the 11pt text is 726 twips.
    expect(left("☐Child") - left("☐Parent")).toBe(726);
    expect(left("☐Grandchild") - left("☐Child")).toBe(726);
    expect(left("☐Tab child") - left("☐Tab parent")).toBe(360);
  });

  it("writes a table's header row, column widths, and column and row spans", async () => {
    const { document } = await exportDocx([
      '<table><colgroup><col style="width: 25%;"><col style="width: 75%;"></colgroup>' +
      "<thead><tr><th>Name</th><th>Role</th></tr></thead><tbody>" +
      '<tr><td colspan="2">Wide</td></tr><tr><td rowspan="2">Tall</td><td>a</td></tr><tr><td>b</td></tr></tbody></table>',
    ]);
    const table = /<w:tbl>[\s\S]*<\/w:tbl>/.exec(document)![0];
    expect([...table.matchAll(/<w:gridCol w:w="(\d+)"\/>/g)].map((m) => Number(m[1]))).toEqual([2340, 7020]);
    expect(table).toContain('w:firstRow="1"');
    const rows = table.match(/<w:tr>[\s\S]*?<\/w:tr>/g)!;
    expect(rows).toHaveLength(4);
    expect(rows[0]).toContain('<w:shd w:val="clear" w:color="auto" w:fill="F7F7F8"/>');
    // The header row repeats on each page the table runs onto; only it does.
    expect(rows[0]).toContain("<w:trPr><w:cantSplit/><w:tblHeader/></w:trPr>");
    expect(rows.slice(1).some((row) => row.includes("<w:tblHeader/>"))).toBe(false);
    expect(rows[1]).not.toContain("w:fill=");
    expect(rows[1]).toContain('<w:gridSpan w:val="2"/>');
    expect(rows[2]).toContain('<w:vMerge w:val="restart"/>');
    expect(rows[3]).toContain("<w:vMerge/>");
    expect(textOf(rows[3])).toBe("b");
  });

  it("takes a table's first row of th cells as its header when it has no thead", async () => {
    const { document } = await exportDocx(["<table><tbody><tr><th>H</th></tr><tr><td>x</td></tr></tbody></table>"]);
    expect(document).toContain('w:firstRow="1"');
    const { document: plain } = await exportDocx(["<table><tbody><tr><td>x</td></tr></tbody></table>"]);
    expect(plain).toContain('w:firstRow="0"');
  });

  it("embeds a data-URL image as media, and leaves out remote and broken ones", async () => {
    const { entries, part, document } = await exportDocx([
      `<p><img class="doc-image" src="${PNG}" alt="Dot" style="width:350px;height:auto;"></p>`,
      '<p><img src="https://evil.example/x.png" alt="remote"><img src="data:image/png;base64,!!!!" alt="broken"></p>',
    ]);
    expect([...entries.keys()].filter((name) => name.startsWith("word/media/"))).toEqual(["word/media/image1.png"]);
    expect([...entries.get("word/media/image1.png")!]).toEqual([...Buffer.from(PNG_BASE64, "base64")]);
    const rid = attr(document, /<a:blip r:embed="([^"]+)"/);
    expect(part("word/_rels/document.xml.rels")).toContain(`Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"`);
    expect(part("[Content_Types].xml")).toContain('<Default Extension="png" ContentType="image/png"/>');
    // Half the editor's 700px measure is half of the 6.5in content width.
    expect(attr(document, /<wp:extent cx="(\d+)"/)).toBe(String(Math.round(9360 / 2) * 635));
    expect(document.match(/<a:blip /g)).toHaveLength(1);
    // The page's 6px corners: 6/700 of 9360 twips, as a share of the 175px-high picture's height.
    const geometry = /<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val (\d+)"\/><\/a:avLst><\/a:prstGeom>/.exec(document);
    expect(Number(geometry?.[1])).toBe(Math.round(6 / 700 * 9360 * 635 / Number(attr(document, /<wp:extent cx="\d+" cy="(\d+)"/)) * 100000));
  });

  it("links safe URLs as external hyperlinks and leaves unsafe ones as plain text", async () => {
    const { document, part } = await exportDocx([
      '<p><a href="https://example.com/a?b=1&amp;c=2">safe</a> <a href="javascript:alert(1)">unsafe</a> <a href="mailto:a@b.c">mail</a></p>',
    ]);
    const rels = part("word/_rels/document.xml.rels");
    const hyperlinks = [...document.matchAll(/<w:hyperlink r:id="([^"]+)"[^>]*>([\s\S]*?)<\/w:hyperlink>/g)];
    expect(hyperlinks.map((m) => textOf(m[2]))).toEqual(["safe", "mail"]);
    expect(rels).toContain(`Id="${hyperlinks[0][1]}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/a?b=1&amp;c=2" TargetMode="External"`);
    expect(rels).not.toContain("javascript");
    expect(textOf(paragraph(document, "safe"))).toBe("safe unsafe mail");
  });

  it("styles quotes, code, dividers and the document's typeface", async () => {
    const { document, part } = await exportDocx(["<blockquote>Quoted</blockquote>", "<pre>let x = 1;\nx++</pre>", "<hr>"], { settings: { font: "serif" } });
    expect(attr(paragraph(document, "Quoted"), /<w:pStyle w:val="([^"]+)"/)).toBe("Quote");
    expect(attr(paragraph(document, "let x"), /<w:pStyle w:val="([^"]+)"/)).toBe("Code");
    expect(document).toContain('<w:pStyle w:val="Divider"/>');
    expect(part("word/styles.xml")).toContain('w:ascii="Georgia"');
  });

  // A shaded, bordered paragraph shows a hairline seam between its shading and its padding borders
  // in Word for the web; a shaded table cell, padded by its margins, doesn't. In a quote the block
  // stays a paragraph, so the quote's rule runs down its left, padded with whole-pixel borders.
  it("writes a code block as a shaded one-cell table, and as a padded paragraph in a quote", async () => {
    const { document, part } = await exportDocx(["<ul><li>item<pre>let x = 1;</pre></li></ul>", "<blockquote><pre>quoted();</pre></blockquote>"]);
    const box = /<w:tbl>(?:(?!<\/w:tbl>)[\s\S])*let x = 1;[\s\S]*?<\/w:tbl>/.exec(document)![0];
    expect(box).toContain('<w:tblStyle w:val="CodeBox"/>');
    // Under the item's text, as on the page.
    expect(box).toContain('<w:tblInd w:w="420" w:type="dxa"/>');
    expect(box).toContain('<w:trPr><w:cantSplit/></w:trPr>');
    expect(box).toContain('<w:shd w:val="clear" w:color="auto" w:fill="F3F3F4"/>');
    expect(attr(paragraph(box, "let x"), /<w:pStyle w:val="([^"]+)"/)).toBe("Code");
    const styles = part("word/styles.xml");
    const code = /<w:style [^>]*w:styleId="Code">.*?<\/w:style>/.exec(styles)![0];
    expect(code).not.toContain("<w:pBdr>");
    expect(code).not.toContain("<w:shd ");
    expect(styles).toMatch(/w:styleId="CodeBox">.*?<w:tblCellMar><w:top w:w="140" w:type="dxa"\/><w:left w:w="180"/);

    const quoted = paragraph(document, "quoted");
    expect(document.match(/<w:tbl>/g)).toHaveLength(1);
    const borders = [...quoted.matchAll(/<w:(top|left|bottom|right) w:val="single" w:sz="(\d+)" w:space="\d+" w:color="([0-9A-F]{6})"\/>/g)];
    expect(borders.map((m) => [m[1], Number(m[2]) / 8, m[3]])).toEqual([["top", 6, "F3F3F4"], ["left", 1.5, "DADADC"], ["bottom", 6, "F3F3F4"], ["right", 7.5, "F3F3F4"]]);
    expect(quoted).toMatch(/<\/w:pBdr><w:shd w:val="clear" w:color="auto" w:fill="F3F3F4"\/>.*<w:spacing [^>]*\/><w:ind w:right="180" /);
  });

  it("keeps a heading that starts a list item a heading, numbered with the item", async () => {
    const { document } = await exportDocx(["<ol><li>First</li><li><h2>Section</h2><p>Body</p></li></ol>"]);
    const heading = paragraph(document, "Section");
    expect(attr(heading, /<w:pStyle w:val="([^"]+)"/)).toBe("Heading2");
    expect(heading).toMatch(/<w:numPr><w:ilvl w:val="0"\/><w:numId w:val="1"\/><\/w:numPr>/);
    expect(attr(paragraph(document, "First"), /<w:pStyle w:val="([^"]+)"/)).toBe("ListParagraph");
    // Word draws the number in the paragraph mark's formatting: the page's marker is the item's
    // (body size, plain, muted), not the heading's. The mark's properties close the pPr.
    expect(heading).toMatch(/<w:rPr><w:b w:val="0"\/><w:bCs w:val="0"\/><w:color w:val="7B7B84"\/><w:sz w:val="22"\/><w:szCs w:val="22"\/><\/w:rPr><\/w:pPr>/);
    expect(paragraph(document, "First")).not.toContain("<w:rPr><w:b w:val=\"0\"/>");
  });

  it("exports a document from before blocks, and an empty one as one empty paragraph", async () => {
    const legacy = await unzip(documentToDocx({ blocks: null, legacyContent: "<h1>Old</h1><p>legacy</p>" }));
    expect(textOf(decoder.decode(legacy.get("word/document.xml")))).toBe("Oldlegacy");
    const { document } = await exportDocx([]);
    expect(document).toContain("<w:body><w:p/><w:sectPr>");
  });

  // The markers the page shows: the editor's CSS keeps square bullets and lower-roman numbers for
  // every level past the third, numbers a list inside a bulleted one 1., 2., and gives a bulleted
  // list inside a numbered one the browser's circle. Lists the browser indents (a list straight
  // inside a list, as Tab makes them) are levels of the same numbering.
  it("gives every list level the marker the page shows, however deep", async () => {
    const { document, part } = await exportDocx([
      "<ul><li>b1</li><ul><li>b2</li><ul><li>b3</li><ul><li>b4</li><ul><li>b5</li></ul></ul></ul></ul></ul>",
      "<ol><li>n1<ol><li>n2<ol><li>n3<ol><li>n4</li></ol></li></ol></li></ol></li></ol>",
      "<ul><li>outer<ol><li>inner number<ul><li>inner bullet</li></ul></li></ol></li></ul>",
      "<ol><li>top<ul><li>bullet in number</li></ul></li></ol>",
    ]);
    const numbering = part("word/numbering.xml");
    const marker = (text: string) => {
      const p = paragraph(document, text);
      const numId = attr(p, /<w:numId w:val="(\d+)"/)!, ilvl = attr(p, /<w:ilvl w:val="(\d+)"/)!;
      const abstract = new RegExp(`<w:abstractNum w:abstractNumId="${numId}">([\\s\\S]*?)</w:abstractNum>`).exec(numbering)![1]!;
      const level = new RegExp(`<w:lvl w:ilvl="${ilvl}">([\\s\\S]*?)</w:lvl>`).exec(abstract)![1]!;
      const format = attr(level, /<w:numFmt w:val="([^"]+)"/);
      return format === "bullet" ? attr(level, /<w:lvlText w:val="([^"]+)"/) : format;
    };
    expect(["b1", "b2", "b3", "b4", "b5"].map(marker)).toEqual(["•", "◦", "▪", "▪", "▪"]);
    expect(attr(paragraph(document, "b5"), /<w:numId w:val="(\d+)"/)).toBe(attr(paragraph(document, "b1"), /<w:numId w:val="(\d+)"/));
    expect(["n1", "n2", "n3", "n4"].map(marker)).toEqual(["decimal", "lowerLetter", "lowerRoman", "lowerRoman"]);
    expect(["outer", "inner number", "inner bullet"].map(marker)).toEqual(["•", "decimal", "◦"]);
    expect(marker("bullet in number")).toBe("◦");
  });

  // A list's bottom margin separates it from what follows, even another list (where Word's
  // contextual spacing would otherwise close the gap); the document's first block sits at the top.
  it("spaces a list off from what follows, and sets the first block flush with the top", async () => {
    const { document } = await exportDocx(["<h1>Top</h1>", "<ol><li>one</li><li>two</li></ol>", "<ul><li>next list</li></ul>", "<p>after</p>"]);
    expect(paragraph(document, "Top")).toContain('<w:spacing w:before="0"/>');
    expect(paragraph(document, "one")).not.toContain("<w:spacing");
    const last = paragraph(document, "two");
    expect(last).toContain('<w:spacing w:before="0" w:after="176"/>');
    expect(last).toContain('<w:contextualSpacing w:val="0"/>');
    expect(paragraph(document, "next list")).toContain('w:after="176"');
    // Schema order: spacing before ind before contextualSpacing.
    expect(last).toMatch(/<w:spacing [^>]*\/><w:ind [^>]*\/><w:contextualSpacing w:val="0"\/>/);
  });

  it("repeats the text colour on links, which Apple's readers would otherwise paint blue", async () => {
    const { document } = await exportDocx(['<p><a href="https://a.example">plain</a> <span class="tc-red"><a href="https://b.example">red</a></span></p>', '<blockquote><a href="https://c.example">quoted</a></blockquote>']);
    const runOf = (text: string) => [...document.matchAll(/<w:r>([\s\S]*?)<\/w:r>/g)].map((m) => m[1]!).find((r) => textOf(r) === text)!;
    expect(runOf("plain")).toContain('<w:rStyle w:val="Hyperlink"/><w:color w:val="1B1B1F"/>');
    expect(runOf("red")).toContain('<w:color w:val="D44C47"/>');
    expect(runOf("quoted")).toContain('<w:color w:val="46464E"/>');
  });

  it("expands a code block's tabs to the page's two-column stops", async () => {
    const { document } = await exportDocx(["<pre>a\tb\n\tc<br>ab\td</pre>"]);
    const code = paragraph(document, "a");
    expect(code).not.toContain("<w:tab/>");
    expect(textOf(code)).toBe("a b  cab  d");
  });

  // On the page a picture is a block at the left of its text column: in a list item it sits under
  // the item's text with no marker of its own, and a paragraph's alignment doesn't move it.
  it("writes a picture in a list item or aligned paragraph without marker or alignment, in schema order", async () => {
    const { document } = await exportDocx([
      `<ul><li>Item<img class="doc-image" src="${PNG}" alt="in list" style="width:100px"></li></ul>`,
      `<p style="text-align: center;"><img class="doc-image" src="${PNG}" alt="centered" style="width:100px"></p>`,
    ]);
    const pictures = paragraphs(document).filter((p) => p.includes("<w:drawing>"));
    expect(pictures).toHaveLength(2);
    for (const p of pictures) {
      expect(p).not.toContain("<w:numPr>");
      expect(p).not.toContain("<w:jc ");
      expect(p).not.toContain("w:hanging");
      const pPr = /<w:pPr>(.*?)<\/w:pPr>/.exec(p)![1]!;
      const order = [...pPr.matchAll(/<w:(\w+)/g)].map((m) => m[1]);
      expect(order.indexOf("spacing")).toBeLessThan(order.includes("ind") ? order.indexOf("ind") : Infinity);
    }
    expect(pictures[0]).toContain('<w:ind w:left="420"/>');
  });

  it("sizes a table's grid for the columns a row span carries down", async () => {
    const { document } = await exportDocx(["<table><tr><td rowspan=\"2\">A</td><td>B</td></tr><tr><td>C</td><td>D</td></tr></table>"]);
    expect(document.match(/<w:gridCol /g)).toHaveLength(3);
    for (const text of ["A", "B", "C", "D"]) paragraph(document, text);
  });

  it("numbers a list item split by a picture once, and a picture-only item too", async () => {
    const img = `<img class="doc-image" src="${PNG}" alt="x" style="width:100px">`;
    const { document } = await exportDocx([`<ol><li>Before${img}After</li><li>${img}</li><li>Third</li></ol>`]);
    const numbered = paragraphs(document).filter((p) => p.includes("<w:numPr>"));
    expect(numbered.map(textOf)).toEqual(["Before", "", "Third"]);
    const after = paragraph(document, "After");
    expect(after).not.toContain("w:hanging");
    expect(after).toContain('w:left="');
  });

  it("keeps a cell's lists in the cell's text size, with no margin below the cell's last block", async () => {
    const { document, part } = await exportDocx(["<table><tbody><tr><td><ul><li>cell item</li><li>last item</li></ul></td></tr></tbody></table>"]);
    expect(attr(paragraph(document, "cell item"), /<w:pStyle w:val="([^"]+)"/)).toBe("TableList");
    expect(paragraph(document, "last item")).toMatch(/<w:spacing [^>]*w:after="0"/);
    expect(part("word/styles.xml")).toContain('<w:style w:type="paragraph" w:styleId="TableList"><w:name w:val="Table List"/><w:basedOn w:val="TableText"/>');
  });

  // A quote's rule is one straight line beside everything in it, its colour reaches its lists, and
  // like code blocks it isn't split across pages.
  it("draws a quote's rule at one x, mutes its lists, and keeps quotes and code blocks whole", async () => {
    const { document, part } = await exportDocx(["<blockquote><p>Intro</p><ul><li>quoted item</li></ul><p>Outro</p></blockquote>"]);
    expect(attr(paragraph(document, "Intro"), /<w:left w:val="single" w:sz="12" w:space="(\d+)"/)).toBe("10");
    // The item's first line starts at 200 + 420 - 300 = 320 twips, 16pt right of the rule at 0.
    expect(attr(paragraph(document, "quoted item"), /<w:left w:val="single" w:sz="12" w:space="(\d+)"/)).toBe("16");
    expect(paragraph(document, "quoted item")).toContain('<w:color w:val="46464E"/>');
    expect(paragraph(document, "Intro")).toContain("<w:keepNext/>");
    expect(paragraph(document, "quoted item")).toContain("<w:keepNext/>");
    expect(paragraph(document, "Outro")).not.toContain("<w:keepNext/>");
    const styles = part("word/styles.xml");
    expect(styles).toMatch(/w:styleId="Quote">.*?<w:pPr><w:keepLines\/>/);
    expect(styles).toMatch(/w:styleId="Code">.*?<w:pPr><w:keepLines\/>/);
  });

  // Runs the previous Docs editor sized (captured from its build): points, Chrome's <font size>,
  // and the `xxx-large` it wrote before sizes were in points.
  it("keeps the run sizes of older documents", async () => {
    const { document } = await exportDocx(['<p>Font <font style="font-size: 30pt;">sized 30</font> <font size="5">five</font> <span style="font-size: xxx-large;">huge</span></p>']);
    const sizes = [...paragraph(document, "Font").matchAll(/<w:r>.*?<w:sz w:val="(\d+)"\/>.*?<w:t[^>]*>([^<]*)</g)].map((m) => [m[2], m[1]]);
    expect(sizes).toEqual([["sized 30", "60"], ["five", "33"], ["huge", "66"]]);
  });

  it("refuses a document past its limits rather than exhausting memory", () => {
    const many = { blocks: Array.from({ length: DOCX_LIMITS.blocks + 1 }, () => ({ html: "<p>x</p>" })) };
    expect(() => documentToDocx(many)).toThrow(`more than ${DOCX_LIMITS.blocks}`);
    const deep = { blocks: [{ html: "<div>".repeat(DOCX_LIMITS.depth + 5) + "x" }] };
    expect(() => documentToDocx(deep)).toThrow("nested too deeply");
  });

  it("refuses tables whose spans would multiply into too many cells", () => {
    const rows = "<tr><td>x</td></tr>".repeat(1000);
    const wide = { blocks: [{ html: `<table><tr><td colspan="1000">a</td></tr>${rows}</table>` }] };
    expect(() => documentToDocx(wide)).toThrow(`more than ${DOCX_LIMITS.tableCells} cells`);
  });

  it("keeps out-of-range sizes, indents, list starts and image widths within what Word reads", async () => {
    const { document, part } = await exportDocx([
      `<p>${"<big>".repeat(60)}huge${"</big>".repeat(60)}</p>`,
      '<p style="margin-left: 99999999px; text-indent: 99999999px;">far</p>',
      '<ol start="99999999999"><li>late</li></ol>',
      `<p><img src="${PNG}" style="width: .px;" width="0"></p>`,
    ]);
    expect(attr(paragraph(document, "huge"), /<w:sz w:val="(\d+)"/)).toBe("3276");
    expect(attr(paragraph(document, "far"), /w:left="(\d+)"/)).toBe("9360");
    expect(attr(paragraph(document, "far"), /w:firstLine="(\d+)"/)).toBe("9360");
    expect(part("word/numbering.xml")).toContain('<w:start w:val="32767"/>');
    expect(document).not.toContain("NaN");
    expect(Number(attr(document, /<wp:extent cx="(\d+)"/))).toBeGreaterThan(1);
  });
});
