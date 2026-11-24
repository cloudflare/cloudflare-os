import { describe, expect, it } from "vitest";
import {
  BLANK_DOC_TAB_ID, BlankGoogleDoc, type DrawnDocumentTab, type DrawnElement, type DrawnTextStyle,
  type StructuralElement,
} from "../src/docs-api";
import { docImageUris, docPendingDrawing, docTabDrawing } from "../src/docs-drawing";
import { pruneTab } from "../src/docs-replica";
import type { GoogleDocParagraph, GoogleDocTable } from "../src/docs-rendering-types";
import { buildTab, footnote, grid, item, para, type BlockSpec, type Lists } from "./doc-fixture";

const pt = (magnitude: number) => ({ magnitude, unit: "PT" });

/** The drawing of the tab `blocks` build, with `more` of what a drawing reads beside them. */
const drawn = (blocks: BlockSpec[], more: DrawnDocumentTab = {}) =>
  docTabDrawing({ ...buildTab(blocks, more.lists as Lists), ...more }, "r1");

/** The content of a header or a footer: `text` in one paragraph, tethered to `objects`. */
function part(text: string, objects: string[] = []): { content: StructuralElement[] } {
  let content = buildTab([para(text)]).body.content.slice(1);
  if (objects.length) content[0].paragraph!.positionedObjectIds = objects;
  return { content };
}

const placed = (left: number, top: number, layout = "WRAP_TEXT") => ({
  positionedObjectProperties: {
    positioning: { layout, leftOffset: pt(left), topOffset: pt(top) },
    embeddedObject: { size: { width: pt(90), height: pt(60) }, imageProperties: { contentUri: `https://images.test/${left}` } },
  },
});

/** A body with a second section, set as `sectionStyle`. */
function sectioned(sectionStyle: object): DrawnDocumentTab {
  let tab: DrawnDocumentTab = buildTab([para("Cover"), { structure: "sectionBreak" }, para("Body")]);
  tab.body!.content![2].sectionBreak = { sectionStyle };
  return tab;
}

describe("a Google Doc tab's drawing", () => {
  it("names the document it was read from, and each block of the body by its range in the tab", () => {
    let tab = buildTab([
      { runs: ["Report\n"], namedStyleType: "HEADING_1" },
      { runs: ["plain ", { text: "bold", style: { bold: true } }, " end\n"] },
      grid(["cell"]),
      para("Last"),
    ]);
    let drawing = docTabDrawing(tab, "r1");
    let [heading, body, table] = drawing.blocks as [GoogleDocParagraph, GoogleDocParagraph, GoogleDocTable];

    expect(drawing.version).toBe("r1");
    // The break the body opens with is no block; every other element is one, at its indexes.
    expect(drawing.blocks.map(block => block.range)).toEqual(
      tab.body.content.slice(1).map(({ startIndex, endIndex }) => ({ start: startIndex, end: endIndex })));
    expect(heading).toMatchObject({ style: "HEADING_1", runs: [{ text: "Report" }] });
    // Nothing in a cell is a block of the body.
    expect(table.rows[0].cells[0].blocks[0]).not.toHaveProperty("range");
    // The bold run is set a step heavier than the text beside it, and each look is held once.
    expect(body.runs.map(run => drawing.textLooks[run.look].weight)).toEqual([400, 700, 400]);
    expect(body.runs[0].look).toBe(body.runs[2].look);
  });

  it("leaves bold text of a family no lighter than bold at the family's weight", () => {
    let bold = (weight: number) => {
      let style: DrawnTextStyle = { bold: true, weightedFontFamily: { fontFamily: "Inter", weight } };
      return { text: `${weight} `, style };
    };
    let drawing = drawn([{ runs: [bold(300), bold(500), bold(800), "\n"] }]);
    let [body] = drawing.blocks as GoogleDocParagraph[];
    expect(body.runs.slice(0, 3).map(run => drawing.textLooks[run.look].weight)).toEqual([400, 700, 800]);
  });

  it("draws a dropdown as a chip of its choice", () => {
    let [status] = drawn([{ runs: [{ dropdown: "Approved" }, "\n"] }]).blocks as GoogleDocParagraph[];
    expect(status.runs[0]).toMatchObject({ chip: "Approved" });
  });

  it("draws a dropdown whose choice is not named, as a new row copies one, as a chip", () => {
    let [status] = drawn([{ runs: [{ dropdown: "" }, "\n"] }]).blocks as GoogleDocParagraph[];
    expect(status.runs[0]).toMatchObject({ chip: "Dropdown" });
  });

  it("starts a lettered list at its first letter where Google has it start at 0", () => {
    let levels = (glyphType: string) => ({ listProperties: { nestingLevels: [{ glyphType, startNumber: 0 }] } });
    let { lists } = drawn([item("One", "roman"), item("Two", "decimal")],
      { lists: { roman: levels("UPPER_ROMAN"), decimal: levels("DECIMAL") } });
    expect([lists.roman[0].start, lists.decimal[0].start]).toEqual([1, 0]);
  });

  it("sets a header and a footer where Google Docs does when the document says nowhere", () => {
    let unset = drawn([para("Body")], { documentStyle: { marginHeader: pt(36), marginFooter: pt(36) } });
    // Google Docs ignores both margins until the document is told to use them.
    expect(unset.sections[0]).toMatchObject({ margins: { header: 5.25, footer: -3.6, top: 72 }, headerGap: 5.25 });

    let custom = drawn([para("Body")], {
      documentStyle: { useCustomHeaderFooterMargins: true, marginHeader: pt(20), marginFooter: pt(30) },
    });
    expect(custom.sections[0].margins).toMatchObject({ header: 20, footer: 30 });
    expect(custom.sections[0]).not.toHaveProperty("headerGap");
  });

  it("keeps a count of pages that starts at 0, and leaves out one that starts at 1", () => {
    let first = (pageNumberStart: number) => drawn([para("Body")], { documentStyle: { pageNumberStart } }).sections[0];

    expect(first(0)).toMatchObject({ pageNumberStart: 0 });
    expect(first(1)).not.toHaveProperty("pageNumberStart");
  });

  it("draws the header a section names, with the image tethered to it", () => {
    let more: DrawnDocumentTab = {
      documentStyle: { defaultHeaderId: "h", defaultFooterId: "f" },
      headers: { h: part("Head", ["logo"]) },
      footers: { f: part("Foot") },
      positionedObjects: { logo: placed(400, -20, "BEHIND_TEXT") },
    };
    let drawing = drawn([para("Body")], more);
    let [section] = drawing.sections;
    let [head] = drawing.headers[section.header!] as GoogleDocParagraph[];

    expect(section).toMatchObject({ header: "h", footer: "f" });
    expect(head).toMatchObject({ runs: [{ text: "Head" }], objects: ["logo"] });
    expect(head).not.toHaveProperty("range");
    expect(drawing.objects.logo).toMatchObject({
      width: 90, height: 60, readable: true, placed: { left: 400, top: -20, layout: "behind" },
    });
    // The drawing names the image; where Google serves it is kept apart.
    expect(JSON.stringify(drawing)).not.toContain("images.test");
    expect([...docImageUris(more)]).toEqual([["logo", "https://images.test/400"]]);
  });

  it("says which sections fill their columns from the right", () => {
    let columnProperties = [{ width: pt(200), paddingEnd: pt(20) }, { width: pt(200) }];
    let section = (contentDirection: string) =>
      docTabDrawing(sectioned({ columnProperties, contentDirection }), "r1").sections.at(-1);

    expect(section("RIGHT_TO_LEFT")).toMatchObject({ columns: [{ width: 200, gap: 20 }, { width: 200, gap: 0 }], rightToLeft: true });
    expect(section("LEFT_TO_RIGHT")).not.toHaveProperty("rightToLeft");
  });

  // Google Docs returns a first-page header, and of the header of every other page only the
  // image tethered in it.
  it("draws a header Google leaves out as the image it holds, set as the nearest returned one is", () => {
    let drawing = drawn([para("Body")], {
      documentStyle: { useFirstPageHeaderFooter: true, firstPageHeaderId: "first", firstPageFooterId: "last" },
      headers: { first: part("Head", ["corner"]) },
      footers: { last: part("Foot", ["band"]) },
      positionedObjects: {
        corner: placed(400, -20), band: placed(0, 30),
        // Tethered in no paragraph Google returned.
        "other-corner": placed(420, -20), "other-band": placed(10, 30),
      },
    });

    expect(drawing.sections[0]).toMatchObject({ firstPage: true, firstHeader: "first", header: "unreturned", footer: "unreturned" });
    expect(drawing.headers.unreturned).toMatchObject([{ type: "paragraph", runs: [], objects: ["other-corner"] }]);
    expect(drawing.footers.unreturned).toMatchObject([{ type: "paragraph", runs: [], objects: ["other-band"] }]);
    expect(drawing.objects["other-corner"].placed).toMatchObject({ left: 420, top: -20 });
  });

  // Google Docs has an unset useFirstPageHeaderFooter as the document's in the first section only.
  it("gives a later section a first page of its own only where the section says so", () => {
    let later = (useFirstPageHeaderFooter?: boolean) => {
      let { sections } = docTabDrawing({
        ...sectioned({ sectionType: "NEXT_PAGE", useFirstPageHeaderFooter }),
        documentStyle: { useFirstPageHeaderFooter: true, firstPageHeaderId: "cover", defaultHeaderId: "running" },
        headers: { cover: part("Cover"), running: part("Running") },
      }, "r1");
      expect(sections[0]).toMatchObject({ firstPage: true, firstHeader: "cover", header: "running" });
      return sections[1];
    };

    expect(later()).toMatchObject({ newPage: true, firstHeader: "cover", header: "running" });
    expect(later()).not.toHaveProperty("firstPage");
    expect(later(true)).toMatchObject({ firstPage: true });
  });

  it("fills white behind text on a page or in a paragraph of another color, and not on white", () => {
    let white = { color: { rgbColor: { red: 1, green: 1, blue: 1 } } };
    let navy = { color: { rgbColor: { blue: 0.4 } } };
    let highlight = (documentStyle: object, shading?: object) => {
      let style: DrawnTextStyle = { backgroundColor: white };
      let tab = buildTab([{ runs: [{ text: "pasted\n", style }] }]);
      if (shading) Object.assign(tab.body.content[1].paragraph!.paragraphStyle, { shading });
      let drawing = docTabDrawing({ ...tab, documentStyle }, "r1");
      let [paragraph] = drawing.blocks as GoogleDocParagraph[];
      return [drawing.page.background, drawing.textLooks[paragraph.runs[0].look].highlight];
    };

    expect(highlight({})).toEqual([undefined, undefined]);
    expect(highlight({ background: { color: navy } })).toEqual(["#000066", "#ffffff"]);
    // What is behind the text is its paragraph's shading, where that has one.
    expect(highlight({}, { backgroundColor: navy })).toEqual([undefined, "#ffffff"]);
    expect(highlight({ background: { color: navy } }, { backgroundColor: white })).toEqual(["#000066", undefined]);
  });

  it("leaves an image no header or footer is near undrawn", () => {
    let drawing = drawn([para("Body")], { positionedObjects: { stray: placed(100, 100) } });

    expect(drawing.headers).toEqual({});
    expect(drawing.objects).toEqual({});
    expect(drawing.sections[0]).not.toHaveProperty("header");
  });
});

describe("a Google Doc not created yet", () => {
  // The stand-in's named styles hold only what the copy keeps, which would set a heading as plain
  // text: a drawing that names none leaves each style to its reader.
  it("draws its blank tab with no named style", async () => {
    let { tab } = await new BlankGoogleDoc("Notes").getDrawnTab("", BLANK_DOC_TAB_ID);

    let drawing = docTabDrawing(tab!);

    expect(drawing.blocks).toMatchObject([{ type: "paragraph", range: { start: 1, end: 2 }, runs: [] }]);
    expect(drawing.named).toEqual({});
  });
});

describe("what a Google Doc tab's pending edits draw", () => {
  /** The elements `blocks` build, without the break their body opens with. */
  const elements = (blocks: BlockSpec[]): DrawnElement[] => buildTab(blocks).body.content.slice(1);
  const pending = (found: DrawnElement[], range = { start: 5, end: 9 }, lists: Lists = {}) =>
    docPendingDrawing([{ ...range, elements: found }], lists, "t1", "r1");

  it("draws a changed paragraph with what it states of its look, and nothing it does not", () => {
    let style: DrawnTextStyle = {
      bold: false, underline: true, fontSize: pt(14), foregroundColor: { color: { rgbColor: { red: 1 } } },
      link: { headingId: "h.1" },
    };
    let [paragraph] = elements([{ runs: ["plain ", { text: "set\n", style }], namedStyleType: "HEADING_2" }]);
    Object.assign(paragraph.paragraph!.paragraphStyle, { alignment: "START", indentStart: { unit: "PT" } });

    let drawing = pending([paragraph]);

    expect(drawing).toMatchObject({ tabId: "t1", version: "r1", lists: {} });
    // No revision named is no version, and the edits are the same.
    expect(docPendingDrawing([{ start: 5, end: 9, elements: [paragraph] }], {}, "t1"))
      .toEqual({ ...drawing, version: undefined });
    expect(drawing.edits).toEqual([{
      start: 5, end: 9,
      blocks: [{
        type: "paragraph", style: "HEADING_2", look: 0, end: 0,
        runs: [{ look: 1, text: "plain " }, { look: 0, text: "set", link: "#heading=h.1" }],
      }],
    }]);
    // A `false` and a zero are statements: they stand over what the named style sets.
    expect(drawing.paragraphLooks).toEqual([{ alignment: "start", indentStart: 0 }]);
    expect(drawing.textLooks).toEqual([{ bold: false, underline: true, fontSize: 14, color: "#ff0000" }, {}]);
  });

  it("draws a changed table whole, names an item's list, and leaves a footnote's mark out", () => {
    let drawing = pending(elements([
      grid(["a", "b"], ["c", "d"]), item("One", "N1"), item("Deep", "N1", 1), { runs: ["Noted", footnote(3), "\n"] },
    ]));
    let [table, one, deep, noted] = drawing.edits[0].blocks as [GoogleDocTable, ...GoogleDocParagraph[]];

    expect(table.rows.map(row => row.cells.map(cell => cell.blocks))).toMatchObject(
      [[[{ runs: [{ text: "a" }] }], [{ runs: [{ text: "b" }] }]], [[{ runs: [{ text: "c" }] }], [{ runs: [{ text: "d" }] }]]]);
    expect(table).not.toHaveProperty("range");
    expect([one.list, deep.list]).toMatchObject([{ id: "N1", level: 0 }, { id: "N1", level: 1 }]);
    // What defines the list is the saved drawing's to say, and the footnote's number the tab's.
    expect(drawing.lists).toEqual({});
    expect(noted.runs).toMatchObject([{ text: "Noted" }, { footnote: "f3", mark: "" }]);
  });

  it("sets a table of the stored copy as the saved drawing sets it, but for a row kept whole and a fill of the page's color", () => {
    let tab = buildTab([grid(["a", "b"], ["c", "d"])]);
    let table = tab.body.content[1].table!;
    let color = (red: number, green = red, blue = red) => ({ color: { rgbColor: { red, green, blue } } });
    table.tableStyle = { tableColumnProperties: [{ widthType: "FIXED_WIDTH", width: pt(170) }, { widthType: "EVENLY_DISTRIBUTED" }] };
    table.tableRows![0].tableRowStyle = { minRowHeight: pt(50), tableHeader: true, preventOverflow: true } as object;
    let [white, red] = table.tableRows![0].tableCells!;
    white.tableCellStyle = { backgroundColor: color(1), contentAlignment: "MIDDLE", paddingTop: pt(3) };
    red.tableCellStyle = { backgroundColor: color(1, 0, 0), borderTop: { width: pt(2), dashStyle: "DASH", color: color(0) }, paddingLeft: pt(9) };

    let { range: _range, ...saved } = docTabDrawing(tab, "r1").blocks.find(block => block.type === "table")!;
    let [kept] = pending(pruneTab(tab).body.content.slice(1)).edits[0].blocks;

    // The preview tells a table that a change only sets another way by these: what the copy does
    // not keep of one, or draws otherwise, would read as a change to every table an edit holds.
    expect(saved.rows[0]).toMatchObject({ unbroken: true, cells: [{ verticalAlign: "middle" }, { background: "#ff0000" }] });
    expect(saved.rows[0].cells[0]).not.toHaveProperty("background");
    expect(kept).toEqual({
      ...saved,
      rows: saved.rows.map(({ unbroken: _unbroken, ...row }, at) => ({
        ...row,
        cells: row.cells.map(cell =>
          ({ ...cell, ...at === 0 && cell.column === 0 ? { background: "#ffffff" } : {}, blocks: expect.any(Array) })),
      })),
    });
  });

  it("gives each list the edits make or change the levels the copy keeps of it, and no other list", () => {
    let lists = {
      N1: { listProperties: { nestingLevels: [{ glyphType: "DECIMAL", startNumber: 3 }, { glyphType: "ALPHA" }] } },
      B1: { listProperties: { nestingLevels: [{ glyphSymbol: "●" }] } },
    };

    let drawing = pending(elements([item("One", "N1"), item("Dot", "B1"), item("Old", "kix.1")]), undefined, lists);

    expect(drawing.lists).toEqual({
      N1: [{ numbering: "decimal", start: 3 }, { numbering: "alpha", start: 1 }],
      B1: [{ symbol: "●", start: 1 }],
    });
  });

  it("marks a table of contents and a section break by their place, and drops the break a body opens with", () => {
    let tab = buildTab([{ structure: "tableOfContents" }, { structure: "sectionBreak" }, para("New")]);

    expect(pending(tab.body.content, { start: 0, end: 0 }).edits[0].blocks).toMatchObject(
      [{ type: "contents" }, { type: "section" }, { type: "paragraph", runs: [{ text: "New" }] }]);
  });
});
