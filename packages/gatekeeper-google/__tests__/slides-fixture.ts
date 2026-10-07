/**
 * Builders for `presentations.get` responses in the shape Google returns them.
 *
 * `text()` lays runs out the way Slides does: each paragraph is a `paragraphMarker` spanning the
 * paragraph followed by its runs, offsets count UTF-16 code units, `startIndex` is omitted when it
 * is 0, and the last paragraph ends with the newline a shape always keeps. An AutoText occupies
 * exactly one index whatever it renders, as a live deck shows: slide number "11" spans [0, 1).
 * `slides-live-sample.json` is a recorded response (styles stripped) that pins these facts.
 */

import type { RestPageElement, RestPresentation, RestText, RestTextElement } from "../src/slides-api";

/** A run of text, or the slide-number AutoText with the content it renders. */
export type FixtureRun = string | { slideNumber: string };

/** `TextContent` for paragraphs of runs, each paragraph ending in the newline Slides stores. */
export function text(...paragraphs: FixtureRun[][]): RestText {
  let elements: RestTextElement[] = [];
  let index = 0;
  let at = (start: number, length: number) =>
    ({ ...(start === 0 ? {} : { startIndex: start }), endIndex: start + length });
  for (let paragraph of paragraphs) {
    let runs = [...paragraph, "\n"].map(run => typeof run === "string"
      ? { element: { textRun: { content: run } }, width: run.length }
      : { element: { autoText: { type: "SLIDE_NUMBER", content: run.slideNumber } }, width: 1 });
    let length = runs.reduce((sum, run) => sum + run.width, 0);
    elements.push({ ...at(index, length), paragraphMarker: {} });
    for (let { element, width } of runs) {
      elements.push({ ...element, ...at(index, width) });
      index += width;
    }
  }
  return { textElements: elements };
}

/** A shape element. */
export function shape(
  objectId: string, body?: RestText, options: { placeholder?: string; shapeType?: string } = {},
): RestPageElement {
  return {
    objectId,
    shape: {
      shapeType: options.shapeType ?? "TEXT_BOX",
      ...(options.placeholder ? { placeholder: { type: options.placeholder } } : {}),
      ...(body ? { text: body } : {}),
    },
  };
}

/** A slide page with optional speaker notes; `notes: null` omits the notes shape entirely. */
export function slide(
  objectId: string,
  pageElements: RestPageElement[],
  options: { layoutObjectId?: string; notes?: RestText | null; isSkipped?: boolean } = {},
): NonNullable<RestPresentation["slides"]>[number] {
  let notesId = `${objectId}-notes`;
  return {
    objectId,
    pageElements,
    slideProperties: {
      layoutObjectId: options.layoutObjectId ?? "layout-title-body",
      ...(options.isSkipped ? { isSkipped: true } : {}),
      notesPage: {
        notesProperties: { speakerNotesObjectId: notesId },
        pageElements: options.notes === null ? [] : [
          shape(`${objectId}-notes-slide-image`, undefined, { shapeType: "RECTANGLE" }),
          shape(notesId, options.notes, { placeholder: "BODY" }),
        ],
      },
    },
  };
}

/** A presentation of the given slides, 10in x 5.625in like Google's default 16:9 deck. */
export function presentation(slides: NonNullable<RestPresentation["slides"]>): RestPresentation {
  return {
    presentationId: "deck-1",
    title: "Quarterly review",
    locale: "en",
    pageSize: {
      width: { magnitude: 9_144_000, unit: "EMU" },
      height: { magnitude: 5_143_500, unit: "EMU" },
    },
    layouts: [
      { objectId: "layout-title", layoutProperties: { displayName: "Title slide" } },
      { objectId: "layout-title-body", layoutProperties: { displayName: "Title and body" } },
    ],
    slides,
  };
}
