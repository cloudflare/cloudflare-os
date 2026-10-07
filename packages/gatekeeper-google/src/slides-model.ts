/**
 * Turns Slides responses into the presentation agents read: slide summaries from a presentation,
 * and one slide's content from its page.
 *
 * Text is projected from the text runs' and AutoTexts' content, concatenated, minus the newline
 * Slides always keeps at the end of a shape or table cell. This is for reading, not for addressing
 * edits: an AutoText occupies one provider index whatever it renders (a live slide number "11"
 * spans [0, 1)), so offsets past one stop matching the provider's UTF-16 text indices.
 */

import type { RestPageElement, RestPresentation, RestSlide, RestText } from "./slides-api";
import type {
  PresentationInfo, Slide, SlideElement, SlideSummary, TableCell,
} from "./slides-read-types";

/** Layout display names by layout object ID. */
export type LayoutNames = Map<string, string>;

const EMU_PER_POINT = 12_700;
const MAX_TITLE_LENGTH = 200;
const TITLE_PLACEHOLDERS = new Set(["TITLE", "CENTERED_TITLE"]);

const INVALID_ELEMENT = "Google Slides returned an invalid page element";

function points(dimension: { magnitude?: number; unit?: string } | undefined): number {
  let magnitude = dimension?.magnitude ?? 0;
  let value = dimension?.unit === "PT" ? magnitude : magnitude / EMU_PER_POINT;
  return Math.round(value * 100) / 100;
}

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
      cells[r][c] = {
        text: textOf(cell.text),
        ...(cell.rowSpan && cell.rowSpan > 1 ? { rowSpan: cell.rowSpan } : {}),
        ...(cell.columnSpan && cell.columnSpan > 1 ? { columnSpan: cell.columnSpan } : {}),
      };
    }
  }
  return cells;
}

function elementOf(element: RestPageElement): SlideElement {
  if (typeof element.objectId !== "string" || element.objectId.length === 0) {
    throw new Error(INVALID_ELEMENT);
  }
  let base = {
    id: element.objectId,
    ...(element.title ? { altTitle: element.title } : {}),
    ...(element.description ? { altDescription: element.description } : {}),
  };
  if (element.shape) {
    return {
      ...base,
      kind: "shape",
      shapeType: element.shape.shapeType ?? "TYPE_UNSPECIFIED",
      ...(element.shape.placeholder?.type ? { placeholder: element.shape.placeholder.type } : {}),
      text: textOf(element.shape.text),
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
    return { ...base, kind: "group", children: (element.elementGroup.children ?? []).map(elementOf) };
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

// Works on a summary read too, whose elements carry only placeholders and text.
function summaryOf(slide: RestSlide, index: number, layouts: LayoutNames): SlideSummary {
  if (!slide.objectId) throw new Error("Google Slides returned an invalid slide");
  let properties = slide.slideProperties;
  let layout = properties?.layoutObjectId && layouts.get(properties.layoutObjectId);
  let title = (slide.pageElements ?? [])
    .filter(({ shape }) => TITLE_PLACEHOLDERS.has(shape?.placeholder?.type ?? ""))
    .map(({ shape }) => textOf(shape?.text))
    .find(text => text.length > 0);
  return {
    id: slide.objectId,
    index,
    ...(layout ? { layout } : {}),
    skipped: properties?.isSkipped === true,
    ...(title ? { title: title.slice(0, MAX_TITLE_LENGTH) } : {}),
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
    pageSize: { width: points(rest.pageSize?.width), height: points(rest.pageSize?.height) },
    slides: (rest.slides ?? []).map((slide, index) => summaryOf(slide, index, layouts)),
  };
}

/** One slide's content, read with `GoogleSlidesApi.getSlide()`, at its place in the deck. */
export function slideOf(page: RestSlide, index: number, layouts: LayoutNames): Slide {
  return {
    ...summaryOf(page, index, layouts),
    elements: (page.pageElements ?? []).map(elementOf),
    speakerNotes: speakerNotesOf(page),
  };
}
