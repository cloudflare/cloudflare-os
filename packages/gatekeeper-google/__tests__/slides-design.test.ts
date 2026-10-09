import { describe, expect, it } from "vitest";
import type { RestPageElement, RestSlide } from "../src/slides-api";
import { designDeck } from "../src/slides-design";
import { prepareChanges } from "../src/slides-design-input";
import { slideOf } from "../src/slides-model";
import type { ShapeElement, TableElement } from "../src/slides-read-types";
import type { SlideChange } from "../src/slides-types";
import { shape, slide, text } from "./slides-fixture";

const EMU = 12_700;
const pt = (magnitude: number) => ({ magnitude, unit: "PT" as const });

/** Runs `changes` over the slides as `updateSlides()` would queue them. */
function run(pages: RestSlide[], changes: SlideChange[]) {
  let { changes: prepared, refs } = prepareChanges(changes);
  let deck = { order: pages.map(page => page.objectId!), slides: new Map(pages.map(page => [page.objectId!, page])) };
  let { deck: next, steps } = designDeck(deck, prepared);
  return {
    refs,
    requests: steps.flatMap(step => step!.requests) as Record<string, any>[],
    read: (id = "s1") => slideOf(next.slides.get(id)!, next.order.indexOf(id), new Map()),
  };
}

function element(id: string, fields: Partial<RestPageElement>): RestPageElement {
  return { objectId: id, ...fields };
}

// A box `width` by `height` points, turned 90° clockwise about its centre at (`cx`, `cy`).
function turned(id: string, cx: number, cy: number, width: number, height: number): RestPageElement {
  return element(id, {
    size: { width: { magnitude: width * EMU, unit: "EMU" }, height: { magnitude: height * EMU, unit: "EMU" } },
    transform: {
      shearY: 1, shearX: -1,
      translateX: (cx + height / 2) * EMU, translateY: (cy - width / 2) * EMU, unit: "EMU",
    },
    shape: { shapeType: "RECTANGLE" },
  });
}

function table(id: string, rows: string[][], merged?: { row: number; column: number; columnSpan: number }) {
  return element(id, {
    table: {
      rows: rows.length,
      columns: rows[0].length,
      tableRows: rows.map((line, rowIndex) => ({
        tableCells: line.flatMap((cell, columnIndex) => {
          if (merged && rowIndex === merged.row && columnIndex > merged.column &&
            columnIndex < merged.column + merged.columnSpan) return [];
          let span = merged && rowIndex === merged.row && columnIndex === merged.column
            ? { columnSpan: merged.columnSpan } : {};
          return [{ location: { rowIndex, columnIndex }, text: text([cell]), ...span }];
        }),
      })),
    },
  });
}

function cellTexts(read: TableElement): (string | undefined)[][] {
  return read.cells.map(line => line.map(cell => cell?.text));
}

describe("Slides design changes", () => {
  it("links text as Google does: link colour and underline, and the link it overlaps retargeted", () => {
    let page = slide("s1", [shape("box", text(["See ", { content: "docs", style: { link: { url: "https://old.example" } } }, " here"]))]);
    let { read, requests } = run([page], [
      { op: "formatText", slideId: "s1", elementId: "box", find: "See do", format: { link: "https://new.example/" } },
    ]);

    expect((read().elements[0] as ShapeElement).formats).toEqual([
      { start: 0, end: 6, underline: true, color: "HYPERLINK", link: "https://new.example/" },
      // The rest of the old link follows it to the new URL, but keeps its own style.
      { start: 6, end: 8, link: "https://new.example/" },
    ]);
    expect(requests).toEqual([{
      updateTextStyle: {
        objectId: "box",
        style: {
          foregroundColor: { opaqueColor: { themeColor: "HYPERLINK" } },
          link: { url: "https://new.example/" }, underline: true,
        },
        fields: "foregroundColor,link,underline",
        textRange: { type: "FIXED_RANGE", startIndex: 0, endIndex: 6 },
      },
    }]);
  });

  it("unsets formatting given null, and addresses text by offsets guarded on the whole text", () => {
    let page = slide("s1", [shape("box", text([{ content: "Bold", style: { bold: true, fontSize: { magnitude: 20, unit: "PT" } } }]))]);
    let { read, requests } = run([page], [
      { op: "formatText", slideId: "s1", elementId: "box", range: { start: 0, end: 4 }, format: { bold: null } },
    ]);
    expect((read().elements[0] as ShapeElement).formats).toEqual([{ start: 0, end: 4, fontSize: 20 }]);
    expect(requests[0].updateTextStyle).toMatchObject({ style: {}, fields: "bold" });

    let { changes } = prepareChanges([
      { op: "formatText", slideId: "s1", elementId: "box", range: { start: 0, end: 4 }, format: { italic: true } },
    ]);
    let deck = { order: ["s1"], slides: new Map([["s1", page]]) };
    expect(() => designDeck(deck, [{ ...changes[0], before: "Bolder" }]))
      .toThrow("change 1 (formatText): the text has changed since this change was made");
  });

  it("makes paragraphs list items nested by their leading tabs, which it removes", () => {
    let page = slide("s1", [shape("box", text(["Plan"], ["\tShip"], ["\t\tTest"]))]);
    let { read, requests } = run([page], [
      { op: "formatParagraphs", slideId: "s1", elementId: "box", alignment: "center", bullets: "numbered" },
    ]);
    expect(read().elements[0]).toMatchObject({
      text: "Plan\nShip\nTest",
      paragraphs: [
        { start: 0, end: 4, alignment: "center", bullet: { level: 0 } },
        { start: 5, end: 9, alignment: "center", bullet: { level: 1 } },
        { start: 10, end: 14, alignment: "center", bullet: { level: 2 } },
      ],
    });
    // Google removes the tabs itself, so both requests address the text as it was.
    let range = { type: "FIXED_RANGE", startIndex: 0, endIndex: 18 };
    expect(requests).toEqual([
      { updateParagraphStyle: { objectId: "box", style: { alignment: "CENTER" }, fields: "alignment", textRange: range } },
      { createParagraphBullets: { objectId: "box", textRange: range, bulletPreset: "NUMBERED_DIGIT_ALPHA_ROMAN" } },
    ]);
  });

  it("refuses bullets after a list item, which Google may join to its list", () => {
    let page = slide("s1", [shape("box", text(["Intro"], { runs: ["Item"], marker: { bullet: { listId: "l" } } }, ["New"]))]);
    expect(() => run([page], [
      { op: "formatParagraphs", slideId: "s1", elementId: "box", find: "New", bullets: "bullet" },
    ])).toThrow("the paragraph before is a list item");
    expect(run([page], [
      { op: "formatParagraphs", slideId: "s1", elementId: "box", find: "Item", bullets: "none" },
    ]).read().elements[0]).not.toHaveProperty("paragraphs");
  });

  it("starts a new list each time, so text cannot join a paragraph to the list it left", () => {
    let page = slide("s1", [shape("box", text(["A"], ["B"]))]);
    expect(() => run([page], [
      { op: "formatParagraphs", slideId: "s1", elementId: "box", bullets: "bullet" },
      { op: "formatParagraphs", slideId: "s1", elementId: "box", find: "A", bullets: "none" },
      { op: "formatParagraphs", slideId: "s1", elementId: "box", find: "A", bullets: "numbered" },
      { op: "editText", slideId: "s1", elementId: "box", find: "A\nB", replace: "AB" },
    ])).toThrow("not items of the same list");
  });

  // Read back live: Google indents new items 36/18, 72/54 pt, …, and removing their bullets leaves
  // 0/0, 36/36, ….
  it("indents list items by their nesting as Google does, which a later join keeps", () => {
    let joined = (page: RestSlide, bullets: "bullet" | "none") => run([page], [
      { op: "formatParagraphs", slideId: "s1", elementId: "box", bullets },
      { op: "editText", slideId: "s1", elementId: "box", find: "A\nB", replace: "AB" },
    ]).requests.at(-1)!.updateParagraphStyle.style;
    expect(joined(slide("s1", [shape("box", text(["\tA"], ["\tB"]))]), "bullet")).toMatchObject({
      indentStart: pt(72), indentFirstLine: pt(54),
    });
    let item = (content: string, nestingLevel: number, start: number, firstLine: number) => ({
      runs: [content],
      marker: {
        bullet: { listId: "l", ...(nestingLevel ? { nestingLevel } : {}) },
        style: { indentStart: pt(start), indentFirstLine: pt(firstLine) },
      },
    });
    let list = slide("s1", [shape("box", text(item("A", 0, 36, 18), item("B", 1, 72, 54)))]);
    expect(joined(list, "none")).toMatchObject({ indentStart: pt(36), indentFirstLine: pt(36) });
  });

  // Read back live: a style reaches the newline ending its range's paragraph, which text added
  // before it then takes, but no other newline: not a further one, nor one a replacement keeps.
  it("carries a style set to a paragraph's end onto its newline, and no further", () => {
    let target = { slideId: "s1", elementId: "box" };
    let formats = (paragraphs: string[], ...changes: SlideChange[]) => {
      let page = slide("s1", [shape("box", text(...paragraphs.map(paragraph => [paragraph])))]);
      return (run([page], changes).read().elements[0] as ShapeElement).formats;
    };
    let bold = (find: string): SlideChange => ({ op: "formatText", ...target, find, format: { bold: true } });
    let edit = (find: string, replace: string): SlideChange => ({ op: "editText", ...target, find, replace });
    expect(formats(["ABC", "DEF"], bold("ABC"), edit("ABC", "ABCX"))).toEqual([{ start: 0, end: 4, bold: true }]);
    expect(formats(["ABC", "DEF"], bold("DEF"), edit("DEF", "DEFX"))).toEqual([{ start: 4, end: 8, bold: true }]);
    expect(formats(["ABC", "DEF"], bold("DEF"), edit("ABC", "ABCX"))).toEqual([{ start: 5, end: 8, bold: true }]);
    expect(formats(["ABC", "DEF"], bold("B"), edit("BC", "XY"), edit("XY", "XYZ")))
      .toEqual([{ start: 1, end: 3, bold: true }]);
    expect(formats(["ABC", "", "DEF"], bold("ABC\n"), edit("\n\n", "\nY\n")))
      .toEqual([{ start: 0, end: 3, bold: true }]);
  });

  it("creates a shape that later changes in the batch address by its ref", () => {
    let page = slide("s1", [shape("title", text(["Q3"]), { placeholder: "TITLE" })]);
    let { read, requests, refs } = run([page], [
      {
        op: "createShape", slideId: "s1", ref: "badge", shapeType: "ROUND_RECTANGLE",
        bounds: { x: 10, y: 20, width: 100, height: 40 }, text: "New", format: { bold: true }, fill: "#ff8800",
      },
      { op: "formatText", slideId: "s1", elementId: "badge", format: { fontSize: 18 } },
    ]);
    expect(refs).toEqual({ badge: expect.stringMatching(/^gk[0-9a-f]{32}$/) });
    expect(read().elements.at(-1)).toEqual({
      id: refs.badge, kind: "shape", shapeType: "ROUND_RECTANGLE",
      bounds: { x: 10, y: 20, width: 100, height: 40 },
      text: "New", formats: [{ start: 0, end: 3, bold: true, fontSize: 18 }], fill: "#ff8800",
    });
    expect(requests.map(request => Object.keys(request)[0])).toEqual([
      "createShape", "insertText", "updateTextStyle", "updateTextStyle", "updateShapeProperties", "updateTextStyle",
    ]);
    // A `SolidFill` takes its `OpaqueColor` bare, unlike text's `OptionalColor`.
    expect(requests[4].updateShapeProperties.shapeProperties.shapeBackgroundFill).toEqual({
      propertyState: "RENDERED", solidFill: { color: { rgbColor: { red: 1, green: 136 / 255 } }, alpha: 1 },
    });
    expect(requests.every(request => Object.values(request)[0].objectId === refs.badge)).toBe(true);
  });

  it("moves an element by translating it alone, and resizes a rotated one about its new box", () => {
    // 100 by 50 points, turned 90°, centred at (175, 150): the editor shows it at (125, 125).
    let page = () => slide("s1", [turned("box", 175, 150, 100, 50)]);
    expect(run([page()], [{ op: "setBounds", slideId: "s1", elementId: "box", bounds: { x: 1 } }])
      .read().elements[0]).toMatchObject({ bounds: { x: 1, y: 125, width: 100, height: 50 }, rotation: 90 });
    let moved = run([page()], [{ op: "setBounds", slideId: "s1", elementId: "box", bounds: { x: 130 } }]);
    expect(moved.requests[0].updatePageElementTransform).toEqual({
      objectId: "box", applyMode: "ABSOLUTE",
      transform: {
        scaleX: 0, shearY: 1, shearX: -1, scaleY: 0,
        translateX: 205 * EMU, translateY: 100 * EMU, unit: "EMU",
      },
    });
    expect(run([page()], [
      { op: "setBounds", slideId: "s1", elementId: "box", bounds: { width: 120 }, rotation: 45 },
    ]).read().elements[0]).toMatchObject({ bounds: { x: 125, y: 125, width: 120, height: 50 }, rotation: 45 });
  });

  it("refuses to move a grouped element, one made in the same batch, or to resize a table", () => {
    let group = element("group", { elementGroup: { children: [shape("a"), shape("b"), shape("c")] } });
    let page = slide("s1", [group, table("grid", [["A"]])]);
    expect(() => run([page], [{ op: "setBounds", slideId: "s1", elementId: "a", bounds: { x: 0 } }]))
      .toThrow('element "a" is inside group "group"');
    expect(() => run([page], [
      { op: "createShape", slideId: "s1", ref: "new", shapeType: "TEXT_BOX", bounds: { x: 0, y: 0, width: 10, height: 10 } },
      { op: "setBounds", slideId: "s1", elementId: "new", bounds: { x: 5 } },
    ])).toThrow("change 2 (setBounds): an element created in the same batch cannot be moved");
    let positioned = slide("s1", [{ ...table("grid", [["A"]]), ...turned("grid", 50, 50, 20, 20), shape: undefined }]);
    expect(() => run([positioned], [{ op: "setBounds", slideId: "s1", elementId: "grid", bounds: { width: 40 } }]))
      .toThrow("a table can only be moved");
  });

  it("deletes a grouped element only while two others stay grouped", () => {
    let children = (...ids: string[]) => element("group", { elementGroup: { children: ids.map(id => shape(id)) } });
    expect(() => run([slide("s1", [children("a", "b")])], [{ op: "deleteElement", slideId: "s1", elementId: "a" }]))
      .toThrow("would leave group");
    expect(run([slide("s1", [children("a", "b", "c")])], [{ op: "deleteElement", slideId: "s1", elementId: "a" }])
      .read().elements[0]).toMatchObject({ kind: "group", children: [{ id: "b" }, { id: "c" }] });
  });

  it("creates a table with its text, and inserts and deletes rows and columns", () => {
    let { read, refs } = run([slide("s1", [])], [
      { op: "createTable", slideId: "s1", ref: "grid", rows: 2, columns: 2, cells: [["A", "B"], ["C"]] },
      { op: "insertTableRows", slideId: "s1", elementId: "grid", at: 2 },
      { op: "insertTableColumns", slideId: "s1", elementId: "grid", at: 0, count: 2 },
      { op: "deleteTableColumns", slideId: "s1", elementId: "grid", at: 1 },
      { op: "deleteTableRows", slideId: "s1", elementId: "grid", at: 0 },
    ]);
    let grid = read().elements[0] as TableElement;
    expect(grid).toMatchObject({ id: refs.grid, rows: 2, columns: 3 });
    expect(cellTexts(grid)).toEqual([["", "C", ""], ["", "", ""]]);
  });

  it("writes rows and columns against a reference cell Google takes", () => {
    let { requests } = run([slide("s1", [table("grid", [["A", "B"]])])], [
      { op: "insertTableRows", slideId: "s1", elementId: "grid", at: 1, count: 2 },
      { op: "insertTableColumns", slideId: "s1", elementId: "grid", at: 0 },
      { op: "deleteTableRows", slideId: "s1", elementId: "grid", at: 1, count: 2 },
    ]);
    expect(requests).toEqual([
      { insertTableRows: { tableObjectId: "grid", cellLocation: { rowIndex: 0, columnIndex: 0 }, insertBelow: true, number: 2 } },
      { insertTableColumns: { tableObjectId: "grid", cellLocation: { rowIndex: 0, columnIndex: 0 }, insertRight: false, number: 1 } },
      { deleteTableRow: { tableObjectId: "grid", cellLocation: { rowIndex: 1, columnIndex: 0 } } },
      { deleteTableRow: { tableObjectId: "grid", cellLocation: { rowIndex: 1, columnIndex: 0 } } },
    ]);
  });

  it("refuses table changes that cut through a merged cell", () => {
    // Row 0's first cell spans both columns.
    let page = () => slide("s1", [table("grid", [["Wide", ""], ["A", "B"]], { row: 0, column: 0, columnSpan: 2 })]);
    expect(() => run([page()], [{ op: "insertTableColumns", slideId: "s1", elementId: "grid", at: 1 }]))
      .toThrow("holds a merged cell, at row 0, column 0");
    expect(() => run([page()], [{ op: "deleteTableColumns", slideId: "s1", elementId: "grid", at: 1 }]))
      .toThrow("a merged cell, at row 0, column 0, is in them");
    expect(() => run([page()], [
      { op: "formatTableCells", slideId: "s1", elementId: "grid", range: { row: 0, column: 1 }, fill: "#000000" },
    ])).toThrow("cuts through the merged cell");
    let filled = run([page()], [{ op: "formatTableCells", slideId: "s1", elementId: "grid", fill: "ACCENT1" }]);
    expect((filled.read().elements[0] as TableElement).cells.flat().map(cell => cell?.fill))
      .toEqual(["ACCENT1", undefined, "ACCENT1", "ACCENT1"]);
  });

  it("sets a font at regular weight, unbolding the text in the request and the replay alike", () => {
    let page = () => slide("s1", [shape("box", text([{ content: "AB", style: { bold: true } }]))]);
    let font = (format: { bold?: boolean }) => run([page()], [
      { op: "formatText", slideId: "s1", elementId: "box", format: { fontFamily: "Roboto", ...format } },
      { op: "editText", slideId: "s1", elementId: "box", find: "B", replace: "X" },
    ]);
    let { read, requests } = font({});
    expect(requests[0].updateTextStyle).toMatchObject({
      style: { bold: false, fontFamily: "Roboto", weightedFontFamily: { fontFamily: "Roboto", weight: 400 } },
    });
    // The edit restyles its text as what it replaces now is, not as it was.
    expect(requests[2].updateTextStyle.style.bold).toBe(false);
    expect((read().elements[0] as ShapeElement).formats).toEqual([{ start: 0, end: 2, bold: false, fontFamily: "Roboto" }]);
    expect((font({ bold: true }).read().elements[0] as ShapeElement).formats)
      .toEqual([{ start: 0, end: 2, bold: true, fontFamily: "Roboto" }]);
  });

  it("edits text in a shrunk shape at the sizes Google fixes when it turns the autofit off", () => {
    let box = shape("box", text([{ content: "AB", style: { fontSize: pt(40) } }]));
    box.shape!.shapeProperties = { autofit: { autofitType: "TEXT_AUTOFIT", fontScale: 0.5 } };
    let { read, requests } = run([slide("s1", [box])], [
      { op: "editText", slideId: "s1", elementId: "box", find: "B", replace: "X" },
      // The autofit is off by now, so this edit scales nothing again.
      { op: "editText", slideId: "s1", elementId: "box", find: "A", replace: "Z" },
    ]);
    expect(requests.filter(request => request.updateTextStyle).map(request => request.updateTextStyle.style))
      .toEqual([{ fontSize: pt(20) }, { fontSize: pt(20) }]);
    expect((read().elements[0] as ShapeElement).formats).toEqual([{ start: 0, end: 2, fontSize: 20 }]);
  });

  it("refuses new text filling a list item whose bullet is styled apart from its text", () => {
    let black = { foregroundColor: { opaqueColor: { rgbColor: {} } }, fontSize: pt(20) };
    let red = { foregroundColor: { opaqueColor: { rgbColor: { red: 1 } } }, fontSize: pt(30) };
    let list = (content: string, bulletStyle: object) => slide("s1", [shape("box", text({
      runs: [{ content, style: black }], marker: { bullet: { listId: "l", bulletStyle } },
    }))]);
    let edit = (page: RestSlide, find: string, replace: string) =>
      run([page], [{ op: "editText", slideId: "s1", elementId: "box", find, replace }]);
    expect(() => edit(list("A", red), "A", "X\nY")).toThrow("the new text fills a list item");
    expect(() => edit(list("A", red), "A", "A\nY")).toThrow("the new text fills a list item");
    // Splitting the item's own text leaves each part of it beside the new text.
    expect(edit(list("AB", red), "AB", "AX\nYB").read().elements[0]).toMatchObject({ text: "AX\nYB" });
    // Google lists a style's fields in its own order, which does not make it another style.
    let same = { fontSize: pt(20), foregroundColor: { opaqueColor: { rgbColor: {} } } };
    expect(edit(list("A", same), "A", "X\nY").read().elements[0]).toMatchObject({ text: "X\nY" });
  });

  it.each([false, true])("uses updated bullet styles after formatting, with a separate pending batch: %s", separate => {
    let page = slide("s1", [shape("box", text(...["A", "B"].map(content => ({
      runs: [{ content, style: { bold: false } }],
      marker: { bullet: { listId: "l", bulletStyle: { bold: false } } },
    }))))]);
    let deck = { order: ["s1"], slides: new Map([["s1", page]]) };
    let { changes } = prepareChanges([
      { op: "formatText", slideId: "s1", elementId: "box", find: "A\n", format: { bold: true } },
      { op: "editText", slideId: "s1", elementId: "box", find: "A", replace: "X\nY" },
    ]);
    let pending = separate ? designDeck(deck, changes.slice(0, 1)).deck : deck;
    let { deck: next } = designDeck(pending, separate ? changes.slice(1) : changes);
    let body = next.slides.get("s1")!.pageElements![0].shape!.text!;
    expect(body.textElements!.flatMap(entry => entry.paragraphMarker
      ? [entry.paragraphMarker.bullet?.bulletStyle] : []))
      .toEqual([{ bold: true }, { bold: true }, { bold: false }]);
    expect(slideOf(next.slides.get("s1")!, 0, new Map()).elements[0]).toMatchObject({ text: "X\nY\nB" });
  });

  it("keeps a bullet's independent style when only part of its paragraph is formatted", () => {
    let page = slide("s1", [shape("box", text({
      runs: [{ content: "AB", style: { bold: false } }],
      marker: { bullet: { listId: "l", bulletStyle: { bold: false } } },
    }))]);
    expect(() => run([page], [
      { op: "formatText", slideId: "s1", elementId: "box", find: "A", format: { bold: true } },
      { op: "editText", slideId: "s1", elementId: "box", find: "A", replace: "X\nY" },
    ])).toThrow("the new text fills a list item");
  });

  it("refuses to rotate a video, which Google cannot shear, but resizes and half-turns it", () => {
    let video = () => slide("s1", [element("vid", {
      size: { width: { magnitude: 100 * EMU, unit: "EMU" }, height: { magnitude: 50 * EMU, unit: "EMU" } },
      transform: { scaleX: 1, scaleY: 1, translateX: 10 * EMU, translateY: 20 * EMU, unit: "EMU" },
      video: {},
    })]);
    let transform = (change: { bounds?: { width: number }; rotation?: number }) =>
      run([video()], [{ op: "setBounds", slideId: "s1", elementId: "vid", ...change }])
        .requests[0].updatePageElementTransform.transform;
    expect(() => transform({ rotation: 45 })).toThrow("Google Slides cannot place a video rotated or skewed");
    expect(transform({ rotation: 180 })).toMatchObject({ scaleX: -1, scaleY: -1, shearX: 0, shearY: 0 });
    expect(transform({ bounds: { width: 200 } })).toMatchObject({ scaleX: 2, scaleY: 1, shearX: 0, shearY: 0 });
  });

  it("refuses what Google would not take before reading anything", () => {
    let refusal = (change: SlideChange) => {
      try {
        prepareChanges([change]);
      } catch (error) {
        return (error as Error).message;
      }
      return undefined;
    };
    let bounds = { x: 0, y: 0, width: 10, height: 10 };
    expect(refusal({ op: "createShape", slideId: "s1", shapeType: "BLOB", bounds }))
      .toContain('shapeType "BLOB" is not a Google Slides shape type');
    expect(refusal({ op: "updateShape", slideId: "s1", elementId: "a", fill: "red" }))
      .toContain('fill "red" is not a #rrggbb colour');
    // Google would read an empty colour as black, under an approval naming none.
    expect(refusal({ op: "createShape", slideId: "s1", shapeType: "RECTANGLE", bounds, fill: "" }))
      .toContain('fill "" is not a #rrggbb colour');
    expect(refusal({ op: "insertImage", slideId: "s1", url: "http://example.com/a.png" }))
      .toContain("url must be an https: URL");
    // 420 characters as given, but 2,420 once percent-encoded, past Google's limit.
    expect(refusal({ op: "replaceImage", slideId: "s1", elementId: "a", url: `https://example.com/${"é".repeat(400)}` }))
      .toContain("at most 2048 characters once percent-encoded");
    expect(refusal({ op: "formatText", slideId: "s1", elementId: "a", format: {} })).toContain("format sets nothing");
    expect(refusal({ op: "setAltText", slideId: "s1", elementId: "a", title: "" }))
      .toContain("alt text cannot be cleared");
    expect(() => prepareChanges([
      { op: "createShape", slideId: "s1", ref: "x", shapeType: "TEXT_BOX", bounds },
      { op: "createShape", slideId: "s1", ref: "x", shapeType: "TEXT_BOX", bounds },
    ])).toThrow('Change 2 (createShape): ref "x" names an element an earlier change creates.');
  });

  it("drops what a change does not declare, so it is neither checked around nor described", () => {
    // capnweb-validate forwards undeclared properties: here, prose for the approval, an `id` that
    // would pass an existing element off as created, and a format key that sets nothing.
    let { changes } = prepareChanges([
      { op: "setBounds", slideId: "s1", elementId: "a", bounds: { x: 1, "**Safe to approve**": 2 }, id: "b" },
      { op: "insertImage", slideId: "s1", url: "  https://img.example/a b.png" },
    ] as unknown as SlideChange[]);
    expect(changes[0]).toEqual({ op: "setBounds", slideId: "s1", elementId: "a", bounds: { x: 1 } });
    expect(changes[1]).toMatchObject({ url: "https://img.example/a%20b.png" });
    expect(() => prepareChanges([
      { op: "formatText", slideId: "s1", elementId: "a", format: { shout: true } },
    ] as unknown as SlideChange[])).toThrow("format sets nothing");
  });

  it("takes a ref named before the change that creates it as an element ID", () => {
    expect(() => run([slide("s1", [])], [
      { op: "deleteElement", slideId: "s1", elementId: "later" },
      { op: "createShape", slideId: "s1", ref: "later", shapeType: "TEXT_BOX", bounds: { x: 0, y: 0, width: 1, height: 1 } },
    ])).toThrow('change 1 (deleteElement): the slide has no element "later"');
  });
});
