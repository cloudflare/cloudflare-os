/**
 * Turns Slides responses into the presentation agents read: slide summaries from a presentation,
 * and one slide's content from its page.
 *
 * Text is projected from the text runs' and AutoTexts' content, concatenated, minus the newline
 * Slides always keeps at the end of a shape or table cell. An AutoText occupies one provider index
 * whatever it renders (a live slide number "11" spans [0, 1)), so offsets past one stop matching
 * the provider's UTF-16 text indices; `slides-text.ts` maps between the two to address edits.
 */

import type { RestPageElement, RestPresentation, RestSlide, RestText } from "./slides-api";
import {
  emu, IDENTITY, localBox, matrixOf, multiply, placementOf, points, roundedPlacement, type Matrix,
} from "./slides-geometry";
import { cellPropertiesOf, formattingOf, shapePropertiesOf } from "./slides-format";
import type {
  PresentationInfo, Slide, SlideElement, SlideSummary, TableCell,
} from "./slides-read-types";

/** Layout display names by layout object ID. */
export type LayoutNames = Map<string, string>;

const MAX_TITLE_LENGTH = 200;
const TITLE_PLACEHOLDERS = new Set(["TITLE", "CENTERED_TITLE"]);

const INVALID_ELEMENT = "Google Slides returned an invalid page element";

function textOf(text: RestText | undefined): string {
  let content = (text?.textElements ?? [])
    .map(element => element.textRun?.content ?? element.autoText?.content ?? "")
    .join("");
  return content.endsWith("\n") ? content.slice(0, -1) : content;
}

function cellsOf(table: NonNullable<RestPageElement["table"]>): (TableCell | null)[][] {
  let rows = table.rows ?? 0;
  let columns = table.columns ?? 0;
  let cells: (TableCell | null)[][] =
    Array.from({ length: rows }, () => Array.from({ length: columns }, () => null));
  for (let row of table.tableRows ?? []) {
    for (let cell of row.tableCells ?? []) {
      // A merged cell appears once, at its top-left; the positions it covers stay null. Google
      // omits a zero index, as it omits every zero-valued field.
      if (!cell.location) throw new Error(INVALID_ELEMENT);
      let r = cell.location.rowIndex ?? 0;
      let c = cell.location.columnIndex ?? 0;
      if (r >= rows || c >= columns) throw new Error(INVALID_ELEMENT);
      let text = textOf(cell.text);
      cells[r][c] = {
        text,
        ...formattingOf(cell.text, text),
        ...(cell.rowSpan && cell.rowSpan > 1 ? { rowSpan: cell.rowSpan } : {}),
        ...(cell.columnSpan && cell.columnSpan > 1 ? { columnSpan: cell.columnSpan } : {}),
        ...cellPropertiesOf(cell.tableCellProperties),
      };
    }
  }
  return cells;
}

/** One element, placed by `parent`, the matrix of the groups holding it. */
function elementOf(element: RestPageElement, parent: Matrix = IDENTITY): SlideElement {
  if (typeof element.objectId !== "string" || element.objectId.length === 0) {
    throw new Error(INVALID_ELEMENT);
  }
  let matrix = element.transform && multiply(parent, matrixOf(element.transform));
  let box = localBox(element);
  let exact = matrix && box && placementOf(matrix, box);
  let placement = exact && roundedPlacement(exact);
  let base = {
    id: element.objectId,
    ...(placement ? { bounds: placement.bounds } : {}),
    ...(placement?.rotation ? { rotation: placement.rotation } : {}),
    ...(element.title ? { altTitle: element.title } : {}),
    ...(element.description ? { altDescription: element.description } : {}),
  };
  if (element.shape) {
    let text = textOf(element.shape.text);
    return {
      ...base,
      kind: "shape",
      shapeType: element.shape.shapeType ?? "TYPE_UNSPECIFIED",
      ...(element.shape.placeholder?.type ? { placeholder: element.shape.placeholder.type } : {}),
      text,
      ...formattingOf(element.shape.text, text),
      ...shapePropertiesOf(element.shape.shapeProperties),
    };
  }
  if (element.table) {
    return {
      ...base,
      kind: "table",
      rows: element.table.rows ?? 0,
      columns: element.table.columns ?? 0,
      cells: cellsOf(element.table),
    };
  }
  if (element.elementGroup) {
    let children = (element.elementGroup.children ?? []).map(child => elementOf(child, matrix ?? parent));
    return { ...base, kind: "group", children };
  }
  if (element.image) return { ...base, kind: "image" };
  if (element.video) return { ...base, kind: "video" };
  if (element.line) return { ...base, kind: "line" };
  if (element.sheetsChart) return { ...base, kind: "sheetsChart" };
  if (element.wordArt) return { ...base, kind: "wordArt", text: element.wordArt.renderedText ?? "" };
  return { ...base, kind: "other" };
}

/** The layout names a presentation or its outline lists. */
export function layoutNames(rest: RestPresentation): LayoutNames {
  let names: LayoutNames = new Map();
  for (let { objectId, layoutProperties } of rest.layouts ?? []) {
    let name = layoutProperties?.displayName;
    if (objectId && name) names.set(objectId, name);
  }
  return names;
}

/** The IDs of a presentation's slides, in presentation order. */
export function slideIds(rest: RestPresentation): string[] {
  return (rest.slides ?? []).map(slide => {
    if (!slide.objectId) throw new Error("Google Slides returned an invalid slide");
    return slide.objectId;
  });
}

// The notes shape is absent until someone first writes notes.
function speakerNotesOf(slide: RestSlide): string {
  let notes = slide.slideProperties?.notesPage;
  let id = notes?.notesProperties?.speakerNotesObjectId;
  return textOf(notes?.pageElements?.find(element => id && element.objectId === id)?.shape?.text);
}

/** A slide's title: the text of its first title placeholder that has any. */
export function titleOf(slide: RestSlide): string | undefined {
  return (slide.pageElements ?? [])
    .filter(({ shape }) => TITLE_PLACEHOLDERS.has(shape?.placeholder?.type ?? ""))
    .map(({ shape }) => textOf(shape?.text))
    .find(text => text.length > 0)
    ?.slice(0, MAX_TITLE_LENGTH);
}

// Works on a summary read too, whose elements carry only placeholders and text.
function summaryOf(slide: RestSlide, index: number, layouts: LayoutNames): SlideSummary {
  if (!slide.objectId) throw new Error("Google Slides returned an invalid slide");
  let properties = slide.slideProperties;
  let layout = properties?.layoutObjectId && layouts.get(properties.layoutObjectId);
  let title = titleOf(slide);
  return {
    id: slide.objectId,
    index,
    ...(layout ? { layout } : {}),
    skipped: properties?.isSkipped === true,
    ...(title ? { title } : {}),
    hasSpeakerNotes: speakerNotesOf(slide).length > 0,
  };
}

/** Summarize a presentation read with `GoogleSlidesApi.getPresentation()`. */
export function presentationInfo(rest: RestPresentation): PresentationInfo {
  let layouts = layoutNames(rest);
  return {
    id: rest.presentationId,
    title: rest.title ?? "Untitled presentation",
    ...(rest.locale ? { locale: rest.locale } : {}),
    pageSize: {
      width: points(emu(rest.pageSize?.width)), height: points(emu(rest.pageSize?.height)),
    },
    slides: (rest.slides ?? []).map((slide, index) => summaryOf(slide, index, layouts)),
  };
}

/** One slide's content, read with `GoogleSlidesApi.getSlide()`, at its place in the deck. */
export function slideOf(page: RestSlide, index: number, layouts: LayoutNames): Slide {
  return {
    ...summaryOf(page, index, layouts),
    elements: (page.pageElements ?? []).map(element => elementOf(element)),
    speakerNotes: speakerNotesOf(page),
  };
}
