import { describe, expect, it } from "vitest";
import type { RestPageElement, RestPresentation } from "../src/slides-api";
import { layoutNames, presentationInfo, slideOf } from "../src/slides-model";
import type { ShapeElement } from "../src/slides-read-types";
import { presentation, shape, slide, text } from "./slides-fixture";
import liveOutline from "./slides-live-outline.json";
import liveSample from "./slides-live-sample.json";

function onlySlide(...elements: RestPageElement[]) {
  return slideOf(slide("s1", elements), 0, new Map());
}

describe("Slides model", () => {
  it("concatenates runs and AutoText content, dropping only the final newline", () => {
    let body = text(["Revenue ", "up 👍"], ["Page ", { slideNumber: "11" }, " of 12"]);
    let [element] = onlySlide(shape("box", body)).elements as ShapeElement[];
    expect(element.text).toBe("Revenue up 👍\nPage 11 of 12");
  });

  // Responses recorded from a real deck: a slide number, a table whose top-left cell's location is
  // `{}` and whose merged-over cell is absent, soft line breaks, and speaker notes written through
  // the API. The outline is the same two slides through the summary field mask, which leaves
  // elements without IDs and text elements without indices.
  it("reads recorded Google Slides responses", () => {
    let sample = liveSample as RestPresentation;
    let layouts = layoutNames(sample);
    let [withTable, withBreaks] = sample.slides!.map((page, i) => slideOf(page, i, layouts));

    expect(presentationInfo(liveOutline as RestPresentation).slides).toEqual([
      { id: "g7c11224212bb9f2f_8", index: 0, layout: "G| Big Copy White", skipped: false,
        title: "The £330M API Meltdown", hasSpeakerNotes: true },
      { id: "g722ffecb27484c70_34", index: 1, layout: "H| Chart + Copy Left Column",
        skipped: false, title: "This Isn't Just Their Problem", hasSpeakerNotes: false },
    ]);
    expect(withTable.speakerNotes).toBe("Mention the £330M\nthen demo");
    expect(withTable.elements).toContainEqual(
      { id: "g7c11224212bb9f2f_9", kind: "shape", shapeType: "TEXT_BOX", placeholder: "SLIDE_NUMBER",
        text: "3" });
    expect(withTable.elements).toContainEqual({
      id: "gkprobe_table", kind: "table", rows: 2, columns: 3,
      cells: [
        [{ text: "Header", columnSpan: 2 }, null, { text: "" }],
        [{ text: "a" }, { text: "" }, { text: "c 👍" }],
      ],
    });
    expect(withBreaks.elements).toContainEqual(expect.objectContaining({
      id: "g722ffecb27484c70_36",
      text: expect.stringContaining("Developers\u000b254 Average APIs per company\n"),
    }));
  });

  it("reads a shape with no text and an empty placeholder as empty", () => {
    let elements = onlySlide(
      shape("rect", undefined, { shapeType: "RECTANGLE" }),
      shape("title", text([""]), { placeholder: "TITLE" }),
    ).elements;
    expect(elements.map(element => element.kind === "shape" && element.text)).toEqual(["", ""]);
  });

  it("lays out table cells by location, leaving merged-over positions null", () => {
    let [table] = onlySlide({
      objectId: "t1",
      table: {
        rows: 2, columns: 2,
        tableRows: [
          { tableCells: [{ location: { columnIndex: 0 }, columnSpan: 2, text: text(["Header"]) }] },
          { tableCells: [
            { location: { rowIndex: 1 }, text: text(["a"]) },
            { location: { rowIndex: 1, columnIndex: 1 }, text: text(["b"]) },
          ] },
        ],
      },
    }).elements;

    expect(table).toEqual({
      id: "t1", kind: "table", rows: 2, columns: 2,
      cells: [[{ text: "Header", columnSpan: 2 }, null], [{ text: "a" }, { text: "b" }]],
    });
  });

  it("keeps grouped elements nested, word art's text, and alt text on any element", () => {
    let [group, wordArt, image] = onlySlide(
      { objectId: "g1", elementGroup: { children: [shape("c1", text(["inside"])), shape("c2")] } },
      { objectId: "wa", wordArt: { renderedText: "Quarterly revenue: $10M" } },
      { objectId: "img", title: "Logo", description: "Company logo", image: {} },
    ).elements;

    expect(group).toMatchObject({
      kind: "group", children: [{ id: "c1", text: "inside" }, { id: "c2", text: "" }],
    });
    expect(wordArt).toEqual({ id: "wa", kind: "wordArt", text: "Quarterly revenue: $10M" });
    expect(image).toEqual({
      id: "img", kind: "image", altTitle: "Logo", altDescription: "Company logo",
    });
  });

  it("places elements in points, composing group transforms and reading rotation clockwise", () => {
    let inch = 914_400;
    let size = (width: number, height: number) => ({
      width: { magnitude: width, unit: "EMU" as const },
      height: { magnitude: height, unit: "EMU" as const },
    });
    // Turned 90° clockwise about its own top-left corner, which then sits at (3in, 1in).
    let turned = {
      objectId: "turned", size: size(2 * inch, inch),
      transform: { shearY: 1, shearX: -1, translateX: 3 * inch, translateY: inch, unit: "EMU" as const },
    };
    let [plain, rotated, group, unplaced] = onlySlide(
      { ...shape("plain"), size: size(inch, inch / 2),
        transform: { scaleX: 2, scaleY: 1, translateX: 36, translateY: 72, unit: "PT" } },
      { ...shape("turned"), ...turned },
      {
        objectId: "group",
        transform: { scaleX: 1, scaleY: 1, translateX: inch, unit: "EMU" },
        elementGroup: { children: [
          { ...shape("left"), size: size(inch, inch), transform: { scaleX: 1, scaleY: 1 } },
          { ...shape("right"), size: size(inch, inch),
            transform: { scaleX: 1, scaleY: 1, translateX: 2 * inch, translateY: inch } },
        ] },
      },
      shape("unplaced"),
    ).elements;

    expect(plain).toMatchObject({ bounds: { x: 36, y: 72, width: 144, height: 36 } });
    expect(plain).not.toHaveProperty("rotation");
    // The 144 x 72 box turned about its centre, which is at (180, 144).
    expect(rotated).toMatchObject({ bounds: { x: 108, y: 108, width: 144, height: 72 }, rotation: 90 });
    expect(group).toMatchObject({
      bounds: { x: 72, y: 0, width: 216, height: 144 },
      children: [
        { id: "left", bounds: { x: 72, y: 0, width: 72, height: 72 } },
        { id: "right", bounds: { x: 216, y: 72, width: 72, height: 72 } },
      ],
    });
    expect(unplaced).not.toHaveProperty("bounds");
  });

  it("reads formatting set on text, paragraphs, shapes and cells, merging equal adjacent runs", () => {
    let bold = { bold: true, fontSize: { magnitude: 18, unit: "PT" as const } };
    let body = text(
      { runs: [{ content: "Big ", style: bold }, { content: "news", style: bold }, " today"],
        marker: { style: { alignment: "CENTER", spaceBelow: { magnitude: 127_000, unit: "EMU" } } } },
      { runs: [{ content: "item", style: {
        foregroundColor: { opaqueColor: { rgbColor: { red: 1, blue: 0.5 } } },
        backgroundColor: {}, link: { url: "https://example.com" }, baselineOffset: "NONE",
      } }], marker: { bullet: { listId: "l1", glyph: "●" } } },
      { runs: [{ content: "deep", style: { foregroundColor: { opaqueColor: { themeColor: "ACCENT1" } } } }],
        marker: { bullet: { listId: "l1", nestingLevel: 2 } } },
    );
    let box = {
      ...shape("box", body),
      // A `SolidFill` holds its `OpaqueColor` bare, where text wraps one in an `OptionalColor`.
      shape: { ...shape("box", body).shape, shapeProperties: {
        shapeBackgroundFill: { propertyState: "NOT_RENDERED" as const },
        outline: { outlineFill: { solidFill: { color: { rgbColor: {} } } },
          weight: { magnitude: 25_400, unit: "EMU" as const } },
        contentAlignment: "MIDDLE",
      } },
    };
    let table = { objectId: "t", table: { rows: 1, columns: 1, tableRows: [{ tableCells: [{
      location: {}, text: text(["cell"]),
      tableCellProperties: { tableCellBackgroundFill: { solidFill: { color: { themeColor: "LIGHT2" } } } },
    }] }] } };

    let [shapeRead, tableRead] = onlySlide(box, table).elements;

    expect(shapeRead).toMatchObject({
      text: "Big news today\nitem\ndeep",
      formats: [
        { start: 0, end: 8, bold: true, fontSize: 18 },
        { start: 15, end: 19, color: "#ff0080", link: "https://example.com" },
        { start: 20, end: 24, color: "ACCENT1" },
      ],
      paragraphs: [
        { start: 0, end: 14, alignment: "center", spaceBelow: 10 },
        { start: 15, end: 19, bullet: { level: 0 } },
        { start: 20, end: 24, bullet: { level: 2 } },
      ],
      fill: "none",
      outline: { color: "#000000", weight: 2 },
      contentAlignment: "middle",
    });
    expect(tableRead).toHaveProperty("cells.0.0", { text: "cell", fill: "LIGHT2" });
  });

  it("reads speaker notes from the notes page's speaker-notes shape only", () => {
    let slides = [
      slide("with-notes", [], { notes: text(["Mention Q3"], ["then demo"]) }),
      slide("no-notes-shape", [], { notes: null }),
      slide("empty-notes", [], { notes: text([""]) }),
    ].map((page, i) => slideOf(page, i, new Map()));

    expect(slides.map(s => [s.speakerNotes, s.hasSpeakerNotes])).toEqual([
      ["Mention Q3\nthen demo", true],
      ["", false],
      ["", false],
    ]);
  });

  it("summarizes slides in order with layout names, skip state and a bounded title", () => {
    let long = "T".repeat(250);
    let info = presentationInfo(presentation([
      slide("s1", [shape("t", text([long]), { placeholder: "TITLE" })], {
        layoutObjectId: "layout-title",
      }),
      slide("s2", [shape("t2", text(["Agenda"]), { placeholder: "CENTERED_TITLE" })], {
        layoutObjectId: "layout-unknown", isSkipped: true,
      }),
      slide("s3", [shape("body", text(["No title here"]), { placeholder: "BODY" })]),
    ]));

    expect(info).toEqual({
      id: "deck-1",
      title: "Quarterly review",
      locale: "en",
      pageSize: { width: 720, height: 405 },
      slides: [
        { id: "s1", index: 0, layout: "Title slide", skipped: false, title: "T".repeat(200),
          hasSpeakerNotes: false },
        { id: "s2", index: 1, skipped: true, title: "Agenda", hasSpeakerNotes: false },
        { id: "s3", index: 2, layout: "Title and body", skipped: false, hasSpeakerNotes: false },
      ],
    });
  });

  it("rejects a page element without an object ID", () => {
    expect(() => onlySlide({ shape: { shapeType: "TEXT_BOX" } }))
      .toThrow("Google Slides returned an invalid page element");
  });
});
