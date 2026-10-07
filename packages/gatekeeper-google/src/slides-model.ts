/**
 * Turns a Slides `presentations.get` response into the presentation agents read.
 *
 * Text is projected from the text runs' and AutoTexts' content, concatenated, minus the newline
 * Slides always keeps at the end of a shape or table cell. This is for reading, not for addressing
 * edits: an AutoText occupies one provider index whatever it renders (a live slide number "11"
 * spans [0, 1)), so offsets past one stop matching the provider's UTF-16 text indices.
 */

import type { RestPageElement, RestPresentation, RestText } from "./slides-api";
import type {
  PresentationInfo, Slide, SlideElement, SlideSize, TableCell,
} from "./slides-read-types";

/** A presentation as one read saw it. */
export type NormalizedPresentation = {
  info: PresentationInfo;
  /** Every slide's content, in presentation order. */
  slides: Slide[];
};

const EMU_PER_POINT = 12_700;
const MAX_TITLE_LENGTH = 200;

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
  if (element.wordArt) return { ...base, kind: "wordArt" };
  return { ...base, kind: "other" };
}

/** Normalize a presentation read with `GoogleSlidesApi.getPresentation()`. */
export function normalizePresentation(rest: RestPresentation): NormalizedPresentation {
  let layoutNames = new Map<string, string>();
  for (let layout of rest.layouts ?? []) {
    let name = layout.layoutProperties?.displayName;
    if (layout.objectId && name) layoutNames.set(layout.objectId, name);
  }

  let slides = (rest.slides ?? []).map((slide, index): Slide => {
    if (typeof slide.objectId !== "string" || slide.objectId.length === 0) {
      throw new Error("Google Slides returned an invalid slide");
    }
    let properties = slide.slideProperties;
    let elements = (slide.pageElements ?? []).map(elementOf);

    // The notes shape is absent until someone first writes notes.
    let notes = properties?.notesPage;
    let notesId = notes?.notesProperties?.speakerNotesObjectId;
    let notesShape = notesId === undefined
      ? undefined
      : notes?.pageElements?.find(element => element.objectId === notesId);
    let speakerNotes = textOf(notesShape?.shape?.text);

    let title = elements.find(element =>
      element.kind === "shape" &&
      (element.placeholder === "TITLE" || element.placeholder === "CENTERED_TITLE") &&
      element.text.length > 0);
    let layout = properties?.layoutObjectId && layoutNames.get(properties.layoutObjectId);

    return {
      id: slide.objectId,
      index,
      ...(layout ? { layout } : {}),
      skipped: properties?.isSkipped === true,
      ...(title?.kind === "shape" ? { title: title.text.slice(0, MAX_TITLE_LENGTH) } : {}),
      hasSpeakerNotes: speakerNotes.length > 0,
      elements,
      speakerNotes,
    };
  });

  let pageSize: SlideSize = {
    width: points(rest.pageSize?.width),
    height: points(rest.pageSize?.height),
  };
  return {
    info: {
      id: rest.presentationId,
      title: rest.title ?? "Untitled presentation",
      ...(rest.locale ? { locale: rest.locale } : {}),
      pageSize,
      slides: slides.map(({ elements: _elements, speakerNotes: _notes, ...summary }) => summary),
    },
    slides,
  };
}
