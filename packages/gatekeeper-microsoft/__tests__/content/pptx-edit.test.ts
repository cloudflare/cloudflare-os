import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pptxToMarkdown } from "../../src/content/pptx";
import { describePptx, editPptx, pptxFeatures, PresentationEditError, type PresentationEdit } from "../../src/content/pptx-edit";
import { OpcPackage } from "../../src/content/pptx-package";
import { markdownToPptx } from "../../src/content/pptx-write";
import { chartPng } from "./pptx-test-images";
import { slideLayoutType, validatePptx } from "./pptx-validate";

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../fixtures/${name}`, import.meta.url).pathname));
const DECK = fixture("python-pptx-deck.pptx");

async function read(bytes: Uint8Array): Promise<string> {
  return (await pptxToMarkdown(bytes)).markdown;
}

async function edit(bytes: Uint8Array, edits: PresentationEdit[]) {
  const result = await editPptx(bytes, edits);
  const validated = await validatePptx(result.bytes);
  return { ...result, ...validated };
}

describe("editPptx: find and replace", () => {
  it("replaces text split across runs, keeping the first character's formatting", async () => {
    const { bytes, pkg, slides, changes } = await edit(DECK, [{ find: "Quarterly revenue grew 12%", replace: "Quarterly revenue grew 14%" }]);
    expect(changes).toEqual([{ slide: 2, before: "Quarterly revenue grew 12%", after: "Quarterly revenue grew 14%",
      summary: 'Slide 2: replaced "Quarterly revenue grew 12%" with "Quarterly revenue grew 14%".' }]);
    const xml = pkg.text(slides[1]!)!;
    expect(xml).toMatch(/<a:r><a:rPr[^>]*b="1"[^>]*\/><a:t>Quarterly revenue grew 14%<\/a:t><\/a:r>/);
    expect(xml).not.toContain("<a:t>terly rev</a:t>");
    expect(await read(bytes)).toContain("**Quarterly revenue grew 14%**");
  });

  it("leaves every part it didn't edit byte for byte as it was", async () => {
    const before = await OpcPackage.open(DECK);
    const { pkg } = await edit(DECK, [{ find: "Churn fell in every region", replace: "Churn fell everywhere" }]);
    for (const name of before.names()) {
      if (name === "ppt/slides/slide2.xml" || name === "ppt/presentation.xml" || name === "docProps/app.xml") continue;
      expect(pkg.bytes(name), name).toEqual(before.bytes(name));
    }
  });

  it("refuses ambiguous text, naming where it occurs, unless all is set", async () => {
    await expect(editPptx(DECK, [{ find: "Revenue", replace: "Sales" }])).rejects.toThrow(
      /"Revenue" appears 3 times in the presentation \(slide 2, slide 3 and slide 5\)\. Include more of the surrounding text .* or pass all: true/);
    const { bytes, changes } = await edit(DECK, [{ find: "Revenue", replace: "Sales", all: true }]);
    expect(changes.map(change => change.slide)).toEqual([2, 3, 5]);
    const markdown = await read(bytes);
    expect(markdown).toContain("| Region | Sales |");
    expect(markdown).toContain("Sales trend");
  });

  it("matches case exactly and says so when nothing matches", async () => {
    await expect(editPptx(DECK, [{ find: "quarterly REVENUE", replace: "x" }])).rejects.toThrow(/wasn't found in the presentation\. Text is matched exactly, including case/);
    await expect(editPptx(DECK, [{ find: "", replace: "x" }])).rejects.toThrow(/can't be empty/);
    await expect(editPptx(DECK, [{ find: "a\nb", replace: "x" }])).rejects.toThrow(/can't span paragraphs/);
  });

  it("replaces in speaker notes and table cells, and turns a newline into a line break", async () => {
    const { pkg, slides, changes } = await edit(DECK, [
      { find: "restatement", replace: "restatement in Q2" },
      { find: "$2.4M", replace: "$2.5M\n(restated)" },
    ]);
    expect(changes[0]).toMatchObject({ slide: 2, notes: true });
    expect(pkg.text(slides[2]!)).toMatch(/<a:t>\$2\.5M<\/a:t><\/a:r><a:br>.*?<\/a:br><a:r>.*?<a:t>\(restated\)<\/a:t>/);
  });

  it("changes nothing when any edit fails, and says which edit", async () => {
    await expect(editPptx(DECK, [{ find: "Highlights", replace: "Summary" }, { deleteSlide: 9 }])).rejects.toThrow(
      /^Edit 2: deleteSlide must be a whole slide number from 1 to 5; 9 isn't\. The deck has 5 slides\.$/);
    await expect(editPptx(DECK, [])).rejects.toBeInstanceOf(PresentationEditError);
  });
});

describe("editPptx: slides", () => {
  it("deletes a slide with its notes, chart parts and their content types", async () => {
    const { pkg, slides, changes } = await edit(DECK, [{ deleteSlide: 5 }, { deleteSlide: 2 }]);
    expect(changes.map(change => change.summary)).toEqual(['Deleted slide 5 "Revenue trend".', 'Deleted slide 2 "Highlights".']);
    expect(slides).toHaveLength(3);
    expect(pkg.names().filter(name => /chart|embeddings|notesSlide/.test(name))).toEqual([]);
    // The image on slide 4 stays.
    expect(pkg.names().filter(name => name.startsWith("ppt/media/"))).toHaveLength(1);
    expect(pkg.text("docProps/app.xml")).toContain("<Slides>3</Slides>");
  });

  it("drops links that jumped to a deleted slide, keeping their text", async () => {
    const pkg = await OpcPackage.open(DECK);
    const rId = pkg.relate("ppt/slides/slide1.xml", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide", "ppt/slides/slide3.xml");
    pkg.set("ppt/slides/slide1.xml", pkg.text("ppt/slides/slide1.xml")!.replace("<a:r><a:t>Finance team, Q3</a:t>",
      `<a:r><a:rPr lang="en-US"><a:hlinkClick r:id="${rId}" action="ppaction://hlinksldjump"/></a:rPr><a:t>Finance team, Q3</a:t>`));
    expect(pkg.text("ppt/slides/slide1.xml")).toContain("hlinksldjump");
    const { pkg: edited, slides } = await edit(await pkg.toBytes(), [{ deleteSlide: 3 }]);
    expect(edited.text(slides[0]!)).not.toContain("hlinkClick");
    expect(edited.text(slides[0]!)).toContain("Finance team, Q3");
  });

  it("adds slides on the deck's own layouts, where asked", async () => {
    const { bytes, pkg, slides, changes } = await edit(DECK, [{ addSlides: "# Next steps\n\n- Hire two engineers\n- Close the books", after: 1 }]);
    expect(changes).toEqual([{ slide: 2, after: "# Next steps\n\n- Hire two engineers\n- Close the books", summary: 'Added slide 2 "Next steps".' }]);
    expect(slideLayoutType(pkg, slides[1]!)).toBe("obj");
    expect(pkg.relationships(slides[1]!).find(relationship => relationship.type.endsWith("/slideLayout"))!.target).toBe("../slideLayouts/slideLayout2.xml");
    expect(await read(bytes)).toMatch(/## Slide 1: Northwind Quarterly Review[\s\S]*## Slide 2: Next steps\n\n- Hire two engineers\n- Close the books\n\n## Slide 3: Highlights/);
    await expect(editPptx(DECK, [{ addSlides: "# x", after: 6 }])).rejects.toThrow(/after must be a whole slide number from 0 to 5 \(0 means before the first slide\)/);
  });

  it("duplicates a slide, copying its notes and chart and sharing its layout and pictures", async () => {
    const { bytes, pkg, slides, changes } = await edit(DECK, [{ duplicateSlide: 2 }, { duplicateSlide: 5, after: 0 }]);
    expect(changes.map(change => change.summary)).toEqual(['Slide 2 "Highlights" copied as slide 3.', 'Slide 5 "Our new office" copied as slide 1.']);
    expect(slides).toHaveLength(7);
    const markdown = await read(bytes);
    expect(markdown.match(/Mention the revenue restatement\./g)).toHaveLength(2);
    expect(pkg.names().filter(name => name.startsWith("ppt/notesSlides/") && name.endsWith(".xml"))).toHaveLength(2);
    expect(pkg.names().filter(name => name.startsWith("ppt/media/"))).toHaveLength(1);
    // The copies' ids are new; the notes of the copy point at the copy.
    const notes = pkg.relationships(slides[3]!).find(relationship => relationship.type.endsWith("/notesSlide"))!;
    const notesPart = pkg.target(slides[3]!, notes);
    expect(pkg.relationships(notesPart).some(relationship => pkg.target(notesPart, relationship) === slides[3])).toBe(true);
    const charts = await edit(DECK, [{ duplicateSlide: 5 }]);
    expect(charts.pkg.names().filter(name => /^ppt\/charts\/chart\d+\.xml$/.test(name))).toHaveLength(2);
    expect(charts.pkg.names().filter(name => name.startsWith("ppt/embeddings/"))).toHaveLength(2);
  });

  it("leaves a copied slide's modern comments, and the commentRel that named them, on the original", async () => {
    const P188 = "http://schemas.microsoft.com/office/powerpoint/2018/8/main";
    const pkg = await OpcPackage.open(await markdownToPptx("# One\n\n- a"));
    const slide = pkg.names().find(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))!;
    pkg.set("ppt/comments/modernComment_1.xml", `<p188:cmLst xmlns:p188="${P188}"/>`, "application/vnd.ms-powerpoint.comments+xml");
    const id = pkg.relate(slide, "http://schemas.microsoft.com/office/2018/10/relationships/comments", "ppt/comments/modernComment_1.xml");
    pkg.set(slide, pkg.text(slide)!.replace("</p:sld>", `<p:extLst><p:ext uri="{6950BFC3-D8DA-4A85-94F7-54DA5524770B}"><p188:commentRel xmlns:p188="${P188}" r:id="${id}"/></p:ext></p:extLst></p:sld>`));
    const { pkg: edited, slides } = await edit(await pkg.toBytes(), [{ duplicateSlide: 1 }]);
    const comments = (part: string) => edited.relationships(part).filter(relationship => relationship.type.endsWith("/comments"));
    expect(comments(slides[0]!)).toHaveLength(1);
    expect(edited.text(slides[0]!)).toContain("<p188:commentRel");
    expect(comments(slides[1]!)).toHaveLength(0);
    expect(edited.text(slides[1]!)).not.toContain("commentRel");
  });

  it("moves slides, numbering each edit against the deck as the edits before left it", async () => {
    const { bytes, changes } = await edit(DECK, [{ moveSlide: 5, to: 1 }, { deleteSlide: 2 }, { moveSlide: 1, to: 4 }]);
    expect(changes.map(change => change.summary)).toEqual([
      'Moved slide 5 "Revenue trend" to position 1.',
      'Deleted slide 2 "Northwind Quarterly Review".',
      'Moved slide 1 "Revenue trend" to position 4.',
    ]);
    expect([...(await read(bytes)).matchAll(/## Slide \d+: (.*)/g)].map(match => match[1])).toEqual(["Highlights", "Regional revenue", "Our new office", "Revenue trend"]);
    await expect(editPptx(DECK, [{ moveSlide: 1, to: 0 }])).rejects.toThrow(/to must be a whole slide number from 1 to 5/);
  });

  it("keeps sections in step when slides are added, copied, moved and deleted", async () => {
    const pkg = await OpcPackage.open(DECK);
    const section = (name: string, ids: number[]) =>
      `<p14:section name="${name}" id="{${name === "A" ? "11111111" : "22222222"}-2222-3333-4444-555555555555}"><p14:sldIdLst>${ids.map(id => `<p14:sldId id="${id}"/>`).join("")}</p14:sldIdLst></p14:section>`;
    pkg.set("ppt/presentation.xml", pkg.text("ppt/presentation.xml")!.replace("</p:presentation>",
      '<p:extLst><p:ext uri="{521415D9-36F7-43E2-AB2F-B90AF26B5E84}"><p14:sectionLst xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main">' +
      `${section("A", [256, 257])}${section("B", [258, 259, 260])}</p14:sectionLst></p:ext></p:extLst></p:presentation>`));
    const { pkg: edited, presentation } = await edit(await pkg.toBytes(), [{ duplicateSlide: 1 }, { moveSlide: 4, to: 6 }, { deleteSlide: 3 }, { addSlides: "# End\n\n- x" }]);
    const xml = edited.text(presentation)!;
    const listed = [...xml.matchAll(/<p:sldId id="(\d+)"/g)].map(match => match[1]);
    const sectioned = [...xml.matchAll(/<p14:sldId id="(\d+)"/g)].map(match => match[1]);
    expect(sectioned).toEqual(listed);
  });
});

describe("editPptx: placeholders and notes", () => {
  it("replaces a placeholder's text by its describePptx name, keeping its font and levels", async () => {
    const { bytes, pkg, slides, changes } = await edit(DECK, [{ setText: { slide: 2, placeholder: "body", markdown: "- Revenue grew **14%**\n  - Led by EMEA\n- Margin up" } }]);
    expect(changes).toEqual([{ slide: 2, before: "Quarterly revenue grew 12%\nChurn fell in every region\nEMEA churn fell the most\nRevenue targets met",
      after: "Revenue grew 14%\nLed by EMEA\nMargin up", summary: "Slide 2: replaced the body text." }]);
    expect(pkg.text(slides[1]!)).toContain('<a:pPr lvl="1"/>');
    expect(await read(bytes)).toContain("## Slide 2: Highlights\n\n- Revenue grew **14%**\n  - Led by EMEA\n- Margin up");
    const described = await describePptx(bytes);
    expect(described[1]!.placeholders.find(placeholder => placeholder.name === "body")!.markdown).toBe("- Revenue grew **14%**\n  - Led by EMEA\n- Margin up");
  });

  it("names the placeholders a slide has when asked for one it doesn't", async () => {
    await expect(editPptx(DECK, [{ setText: { slide: 3, placeholder: "body", markdown: "x" } }])).rejects.toThrow(
      /Slide 3 has no placeholder "body"\. Its placeholders are: title\./);
    await expect(editPptx(DECK, [{ setText: { slide: 8, placeholder: "title", markdown: "x" } }])).rejects.toThrow(/setText\.slide must be a whole slide number from 1 to 5/);
  });

  it("puts a picture in a content placeholder, fitted and described", async () => {
    const result = await editPptx(DECK, [{ setText: { slide: 2, placeholder: "body", markdown: "![Revenue by quarter](chart.png)" } }],
      { images: new Map([["chart.png", { bytes: chartPng(), mimeType: "image/png" }]]) });
    const { pkg, slides } = await validatePptx(result.bytes);
    const xml = pkg.text(slides[1]!)!;
    expect(xml).toMatch(/<p:pic><p:nvPicPr><p:cNvPr id="\d+" name="Picture \d+" descr="Revenue by quarter"\/>.*<p:ph idx="1"\/>/);
    await expect(editPptx(DECK, [{ setText: { slide: 2, placeholder: "body", markdown: "text\n\n![a](chart.png)" } }],
      { images: new Map([["chart.png", { bytes: chartPng(), mimeType: "image/png" }]]) })).rejects.toThrow(/either text or one picture/);
  });

  it("shows a link's destination in what the approver sees of a placeholder or notes edit", async () => {
    const deck = await markdownToPptx("# One\n\n- a");
    const { changes } = await edit(deck, [
      { setText: { slide: 1, placeholder: "body", markdown: "- See [the plan](https://example.com/plan)" } },
      { setNotes: { slide: 1, markdown: "Open [the plan](https://example.com/plan)." } },
    ]);
    expect(changes[0]!.after).toContain("See the plan (https://example.com/plan)");
    expect(changes[1]).toMatchObject({ after: "Open the plan (https://example.com/plan).", notes: true });
  });

  it("declares the relationships prefix on a slide or notes page that never had one when a link is added", async () => {
    const withNotes = await editPptx(await markdownToPptx("# One\n\n- a"), [{ setNotes: { slide: 1, markdown: "Say this." } }]);
    const pkg = await OpcPackage.open(withNotes.bytes);
    const xmlnsR = ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
    for (const part of ["ppt/slides/slide1.xml", "ppt/notesSlides/notesSlide1.xml"]) {
      expect(pkg.text(part)).toContain(xmlnsR);
      pkg.set(part, pkg.text(part)!.replace(xmlnsR, ""));
    }
    const { pkg: edited } = await edit(await pkg.toBytes(), [
      { setText: { slide: 1, placeholder: "body", markdown: "- See [the plan](https://example.com/plan)" } },
      { setNotes: { slide: 1, markdown: "Open [the plan](https://example.com/plan)." } },
    ]);
    for (const part of ["ppt/slides/slide1.xml", "ppt/notesSlides/notesSlide1.xml"]) {
      const xml = edited.text(part)!;
      expect(xml).toContain("hlinkClick r:id=");
      expect(/<p:(?:sld|notes)\b[^>]*>/.exec(xml)![0]).toContain(xmlnsR);
    }
  });

  it("sets speaker notes, adding a notes page (and a notes master) where there was none", async () => {
    const deck = await markdownToPptx("# One\n\n- a\n\n# Two\n\n- b");
    const { bytes, pkg, changes } = await edit(deck, [{ setNotes: { slide: 2, markdown: "Say **this**." } }, { setNotes: { slide: 2, markdown: "Say that." } }]);
    expect(changes.map(change => change.summary)).toEqual(["Slide 2: added speaker notes.", "Slide 2: replaced the speaker notes."]);
    expect(changes[1]).toMatchObject({ before: "Say this.", after: "Say that.", notes: true });
    expect(pkg.names().filter(name => name.includes("notesMaster") && name.endsWith(".xml"))).toHaveLength(1);
    expect(await read(bytes)).toContain("## Slide 2: Two\n\n- b\n\n### Notes\n\nSay that.");
    expect((await describePptx(bytes))[1]!.notes).toBe("Say that.");
  });
});

describe("describePptx", () => {
  it("reports layouts, named placeholders, other text, pictures and notes", async () => {
    const slides = await describePptx(DECK);
    expect(slides.map(slide => [slide.number, slide.layout])).toEqual([[1, "Title Slide"], [2, "Title and Content"], [3, "Title Only"], [4, "Title Only"], [5, "Title Only"]]);
    expect(slides[0]!.placeholders).toEqual([
      { name: "title", type: "title", markdown: "Northwind Quarterly Review" },
      { name: "subtitle", type: "subtitle", index: 1, markdown: "Finance team, Q3" },
    ]);
    expect(slides[1]!.placeholders[1]).toEqual({ name: "body", type: "body", index: 1,
      markdown: "- **Quar**terly revenue grew 12%\n- Churn fell in every region\n  - EMEA churn fell the most\n- Revenue targets met" });
    expect(slides[1]!.notes).toBe("Mention the revenue restatement.");
    expect(slides[2]!.otherText).toEqual(["| Region | Revenue |\n| --- | --- |\n| EMEA | $1.2M |\n| Americas | $2.4M |"]);
    expect(slides[3]!.images).toEqual([{ name: "Picture 2", description: "image.png" }]);
  });

  it("numbers several body placeholders by index, and reads what markdownToPptx wrote", async () => {
    const bytes = await markdownToPptx("# Choice\n\n### Build\n- a\n\n+++\n\n### Buy\n- b");
    const [slide] = await describePptx(bytes);
    expect(slide!.layout).toBe("Comparison");
    expect(slide!.placeholders.map(placeholder => [placeholder.name, placeholder.markdown])).toEqual([
      ["title", "Choice"], ["body", "Build"], ["body 3", "Buy"], ["body 2", "- a"], ["body 4", "- b"],
    ]);
  });
});

describe("pptxFeatures", () => {
  it("lists what a Markdown rewrite of a PowerPoint deck would lose", async () => {
    expect(await pptxFeatures(DECK)).toEqual(["1 image", "charts", "animations", "transitions", "speaker notes"]);
  });

  it("finds nothing to lose in a deck written from Markdown, beyond its notes", async () => {
    expect(await pptxFeatures(await markdownToPptx("# A\n\n- b\n\n| x | y |\n|---|---|\n| 1 | 2 |"))).toEqual([]);
    expect(await pptxFeatures(await markdownToPptx("# A\n\n- b\n\n> Notes: n"))).toEqual(["speaker notes"]);
  });
});
