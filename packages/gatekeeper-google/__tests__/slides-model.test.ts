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
    // The fixture keeps the table's borders but not its column widths or row heights.
    expect(withTable.elements).toContainEqual({
      id: "gkprobe_table", kind: "table", rows: 2, columns: 3,
      cells: [
        [{ text: "Header", columnSpan: 2 }, null, { text: "" }],
        [{ text: "a" }, { text: "" }, { text: "c 👍" }],
      ],
      border: { color: "#9e9e9e", weight: 0.75 },
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

  it("reads links to slides, font weight, paragraph indents, outline dashes and fill opacity", () => {
    let linked = (link: object) => ({ content: "x", style: { link } });
    let body = text(
      { runs: [linked({ pageObjectId: "s2" }), " ", linked({ relativeLink: "NEXT_SLIDE" }), " ",
        linked({}), " ", linked({ url: "https://example.com" })],
      marker: { style: { indentStart: { magnitude: 36, unit: "PT" }, indentFirstLine: { unit: "PT" } } } },
      [{ content: "light", style: { weightedFontFamily: { fontFamily: "Inter", weight: 300 } } },
        { content: "regular", style: { weightedFontFamily: { fontFamily: "Inter", weight: 400 } } }],
    );
    let box = { ...shape("box", body), shape: { ...shape("box", body).shape, shapeProperties: {
      shapeBackgroundFill: { solidFill: { color: { themeColor: "ACCENT1" }, alpha: 0.5 } },
      outline: { outlineFill: { solidFill: { color: { themeColor: "DARK1" }, alpha: 1 } },
        weight: { magnitude: 12_700, unit: "EMU" as const }, dashStyle: "DASH_DOT" },
    } } };
    let solid = { ...shape("solid"), shape: { shapeType: "RECTANGLE", shapeProperties: {
      shapeBackgroundFill: { solidFill: { color: { themeColor: "ACCENT1" }, alpha: 1 } },
      outline: { weight: { magnitude: 12_700, unit: "EMU" as const }, dashStyle: "SOLID" },
    } } };
    let table = { objectId: "t", table: { rows: 1, columns: 1, tableRows: [{ tableCells: [{
      location: {}, text: text(["cell"]),
      tableCellProperties: { tableCellBackgroundFill: { solidFill: { color: { themeColor: "LIGHT2" }, alpha: 0.25 } } },
    }] }] } };

    let [boxRead, solidRead, tableRead] = onlySlide(box, solid, table).elements;

    expect(boxRead).toMatchObject({
      formats: [
        { start: 0, end: 1, link: { slideId: "s2" } },
        { start: 2, end: 3, link: { relative: "next" } },
        { start: 4, end: 5, link: { slideIndex: 0 } },
        { start: 6, end: 7, link: "https://example.com" },
        { start: 8, end: 13, fontWeight: 300 },
      ],
      paragraphs: [{ start: 0, end: 7, indentStart: 36, indentFirstLine: 0 }],
      fill: "ACCENT1", fillOpacity: 0.5,
      outline: { color: "DARK1", weight: 1, dash: "DASH_DOT" },
    });
    expect((boxRead as ShapeElement).formats).toHaveLength(5);
    expect(solidRead).toEqual({
      id: "solid", kind: "shape", shapeType: "RECTANGLE", text: "", fill: "ACCENT1",
      outline: { weight: 1 },
    });
    expect(tableRead).toHaveProperty("cells.0.0", { text: "cell", fill: "LIGHT2", fillOpacity: 0.25 });
  });

  it("reads an image's source, a video's, a chart's spreadsheet, and a line's ends and arrows", () => {
    let pt = (width: number, height: number) => ({
      width: { magnitude: width, unit: "PT" as const }, height: { magnitude: height, unit: "PT" as const },
    });
    let [image, video, chart, arrow, rising] = onlySlide(
      { objectId: "img", image: { contentUrl: "https://lh3.googleusercontent.com/bearer",
        sourceUrl: "https://example.com/logo.png" } as object },
      { objectId: "vid", video: { source: "YOUTUBE", id: "dQw4w9WgXcQ",
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" } },
      { objectId: "chart", sheetsChart: { spreadsheetId: "sheet-1", chartId: 42,
        contentUrl: "https://lh3.googleusercontent.com/bearer" } as object },
      { objectId: "arrow", size: pt(100, 50), transform: { scaleX: 1, scaleY: 1, translateX: 10, translateY: 20, unit: "PT" },
        line: { lineCategory: "STRAIGHT", lineProperties: {
          lineFill: { solidFill: { color: { themeColor: "DARK1" }, alpha: 1 } },
          weight: { magnitude: 2, unit: "PT" }, dashStyle: "DOT", startArrow: "NONE", endArrow: "FILL_ARROW",
          startConnection: { connectedObjectId: "box", connectionSiteIndex: 3 },
          endConnection: { connectedObjectId: "other" },
        } } },
      // Flipped vertically: drawn from bottom-left to top-right.
      { objectId: "rising", size: pt(100, 50), transform: { scaleX: 1, scaleY: -1, translateY: 70, unit: "PT" },
        line: { lineCategory: "BENT" } },
    ).elements;

    expect(image).toEqual({ id: "img", kind: "image", sourceUrl: "https://example.com/logo.png" });
    expect(video).toEqual({ id: "vid", kind: "video", source: "youtube", videoId: "dQw4w9WgXcQ",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
    expect(chart).toEqual({ id: "chart", kind: "sheetsChart", spreadsheetId: "sheet-1", chartId: 42 });
    expect(arrow).toEqual({
      id: "arrow", kind: "line", bounds: { x: 10, y: 20, width: 100, height: 50 }, category: "straight",
      start: { x: 10, y: 20 }, end: { x: 110, y: 70 }, endArrow: "FILL_ARROW", color: "DARK1",
      weight: 2, dash: "DOT",
      startConnection: { elementId: "box", site: 3 }, endConnection: { elementId: "other", site: 0 },
    });
    expect(rising).toMatchObject({ category: "bent", start: { x: 0, y: 70 }, end: { x: 100, y: 20 } });
  });

  it("reads table column widths, row heights and borders, collapsing borders that all match", () => {
    let pt = (magnitude: number) => ({ magnitude, unit: "PT" as const });
    let thin = { tableBorderFill: { solidFill: { color: { rgbColor: {} }, alpha: 1 } },
      weight: pt(1), dashStyle: "SOLID" };
    let dashed = { ...thin, dashStyle: "DASH" };
    // As Google stores a transparent edge, read back live.
    let hidden = { tableBorderFill: {}, weight: { unit: "EMU" }, dashStyle: "SOLID" };
    let grid = (rows: number, columns: number, at: (r: number, c: number) => object | undefined) =>
      Array.from({ length: rows }, (_, r) => ({ tableBorderCells: Array.from({ length: columns }, (_, c) => {
        let properties = at(r, c);
        return properties && { location: { rowIndex: r, columnIndex: c }, tableBorderProperties: properties };
      }).filter(cell => cell !== undefined) }));
    // One row of two columns, doubled in width by its transform.
    let table = (horizontal: object[], vertical: object[]) => ({
      objectId: "t", transform: { scaleX: 2, scaleY: 1, unit: "PT" as const },
      table: {
        rows: 1, columns: 2,
        tableColumns: [{ columnWidth: pt(50) }, { columnWidth: pt(70) }],
        tableRows: [{ rowHeight: pt(30), tableCells: [
          { location: {}, text: text(["a"]) }, { location: { columnIndex: 1 }, text: text(["b"]) },
        ] }],
        horizontalBorderRows: horizontal, verticalBorderRows: vertical,
      },
    });

    let [uniform, mixed] = onlySlide(
      table(grid(2, 2, () => thin), grid(1, 3, () => thin)),
      { ...table(grid(2, 2, (r, c) => r === 1 && c === 1 ? dashed : thin),
        grid(1, 3, (_, c) => c === 1 ? undefined : c === 2 ? hidden : thin)), objectId: "t2" },
    ).elements;

    expect(uniform).toMatchObject({
      columnWidths: [100, 140], rowHeights: [30], border: { color: "#000000", weight: 1 },
    });
    expect(uniform).not.toHaveProperty("borders");
    let line = { color: "#000000", weight: 1 };
    expect(mixed).toMatchObject({
      borders: {
        horizontal: [[line, line], [line, { ...line, dash: "DASH" }]],
        vertical: [[line, null, "none"]],
      },
    });
    expect(mixed).not.toHaveProperty("border");
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

  it("summarizes slides in order with layout names, skip state and a bounded title, and lists layouts", () => {
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
      layouts: [
        { id: "layout-title", name: "Title slide", placeholders: ["CENTERED_TITLE", "SUBTITLE"] },
        { id: "layout-title-body", name: "Title and body", placeholders: ["TITLE", "BODY", "BODY"] },
      ],
    });
  });

  it("rejects a page element without an object ID", () => {
    expect(() => onlySlide({ shape: { shapeType: "TEXT_BOX" } }))
      .toThrow("Google Slides returned an invalid page element");
  });
});
