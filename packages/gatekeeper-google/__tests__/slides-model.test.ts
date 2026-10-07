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
