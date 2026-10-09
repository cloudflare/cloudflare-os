/**
 * Turns Slides responses into the presentation agents read: slide summaries from a presentation,
 * and one slide's content from its page.
 *
 * Text is projected from the text runs' and AutoTexts' content, concatenated, minus the newline
 * Slides always keeps at the end of a shape or table cell. An AutoText occupies one provider index
 * whatever it renders (a live slide number "11" spans [0, 1)), so offsets past one stop matching
 * the provider's UTF-16 text indices; `slides-text.ts` maps between the two to address edits.
 */

import type { RestBorderRow, RestPageElement, RestPresentation, RestSlide, RestText } from "./slides-api";
import {
  emu, IDENTITY, localBox, matrixOf, multiply, placementOf, points, roundedPlacement, slidePoint,
  tableLinesOf, type Box, type Matrix,
} from "./slides-geometry";
import { borderOf, cellPropertiesOf, colorOf, dashOf, formattingOf, shapePropertiesOf } from "./slides-format";
import type {
  LineElement, PresentationInfo, Slide, SlideElement, SlideLayout, SlideSummary, TableBorder,
  TableCell, TableElement,
} from "./slides-read-types";

/** Layout display names by layout object ID. */
export type LayoutNames = Map<string, string>;

const MAX_TITLE_LENGTH = 200;
const TITLE_PLACEHOLDERS = new Set(["TITLE", "CENTERED_TITLE"]);

const INVALID_ELEMENT = "Google Slides returned an invalid page element";

const LINE_CATEGORIES: Record<string, NonNullable<LineElement["category"]>> = {
  STRAIGHT: "straight", BENT: "bent", CURVED: "curved",
};
const VIDEO_SOURCES: Record<string, "youtube" | "drive"> = { YOUTUBE: "youtube", DRIVE: "drive" };

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

/**
 * One line of a table's grid of cell edges, `length` long: the edge at each position, null where
 * Google reports none, as inside a merged cell.
 */
function edgesOf(row: RestBorderRow, length: number): (TableBorder | null)[] {
  let edges: (TableBorder | null)[] = Array.from({ length }, () => null);
  for (let { location, tableBorderProperties } of row.tableBorderCells ?? []) {
    let at = location?.columnIndex ?? 0;
    if (at >= length || !tableBorderProperties) throw new Error(INVALID_ELEMENT);
    edges[at] = borderOf(tableBorderProperties);
  }
  return edges;
}

/** A table's column widths, row heights and borders, as far as Google reports them all. */
function tableLayoutOf(
  table: NonNullable<RestPageElement["table"]>, matrix: Matrix | undefined,
): Pick<TableElement, "columnWidths" | "rowHeights" | "border" | "borders"> {
  let rows = table.rows ?? 0;
  let columns = table.columns ?? 0;
  // Lengths along the table's own axes, scaled as its transform draws them.
  let scaleX = matrix ? Math.hypot(matrix.a, matrix.b) : 1;
  let scaleY = matrix && scaleX ? Math.abs(matrix.a * matrix.d - matrix.b * matrix.c) / scaleX : 1;
  let { widths, heights } = tableLinesOf(table);
  let read: Pick<TableElement, "columnWidths" | "rowHeights" | "border" | "borders"> = {
    ...(widths ? { columnWidths: widths.map(width => points(width * scaleX)) } : {}),
    ...(heights ? { rowHeights: heights.map(height => points(height * scaleY)) } : {}),
  };
  let { horizontalBorderRows: across, verticalBorderRows: down } = table;
  if (across?.length === rows + 1 && down?.length === rows) {
    let horizontal = across.map(row => edgesOf(row, columns));
    let vertical = down.map(row => edgesOf(row, columns + 1));
    let kinds = new Set([...horizontal, ...vertical].flat().flatMap(edge => edge ? [JSON.stringify(edge)] : []));
    if (kinds.size === 1) read.border = JSON.parse([...kinds][0]);
    else if (kinds.size > 1) read.borders = { horizontal, vertical };
  }
  return read;
}

/** A line's ends, arrows, look and connections, as far as Google reports them. */
function lineOf(
  line: NonNullable<RestPageElement["line"]>, matrix: Matrix | undefined, box: Box | undefined,
): Omit<LineElement, "id" | "kind"> {
  let properties = line.lineProperties;
  let category = LINE_CATEGORIES[line.lineCategory ?? ""];
  let color = colorOf(properties?.lineFill?.solidFill?.color);
  let weight = properties?.weight?.magnitude ? points(emu(properties.weight)) : undefined;
  let read: Omit<LineElement, "id" | "kind"> = {
    ...(category ? { category } : {}),
    // A line runs from its box's top-left corner to its bottom-right, before its transform flips it.
    ...(matrix && box ? {
      start: slidePoint(matrix, box.x, box.y), end: slidePoint(matrix, box.x + box.width, box.y + box.height),
    } : {}),
    ...(color ? { color } : {}),
    ...(weight ? { weight } : {}),
    ...dashOf(properties?.dashStyle),
  };
  for (let end of ["start", "end"] as const) {
    let arrow = properties?.[`${end}Arrow`];
    if (arrow && arrow !== "NONE") read[`${end}Arrow`] = arrow;
    let connection = properties?.[`${end}Connection`];
    // Google omits a zero site index, as it omits every zero-valued field.
    if (connection?.connectedObjectId) {
      read[`${end}Connection`] = {
        elementId: connection.connectedObjectId, site: connection.connectionSiteIndex ?? 0,
      };
    }
  }
  return read;
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
      ...tableLayoutOf(element.table, matrix),
    };
  }
  if (element.elementGroup) {
    let children = (element.elementGroup.children ?? []).map(child => elementOf(child, matrix ?? parent));
    return { ...base, kind: "group", children };
  }
  if (element.image) {
    let { sourceUrl } = element.image;
    return { ...base, kind: "image", ...(sourceUrl ? { sourceUrl } : {}) };
  }
  if (element.video) {
    let { source, id, url } = element.video;
    let from = VIDEO_SOURCES[source ?? ""];
    return {
      ...base, kind: "video", ...(from ? { source: from } : {}), ...(id ? { videoId: id } : {}),
      ...(url ? { url } : {}),
    };
  }
  if (element.line) return { ...base, kind: "line", ...lineOf(element.line, matrix, box) };
  if (element.sheetsChart) {
    let { spreadsheetId, chartId } = element.sheetsChart;
    return {
      ...base, kind: "sheetsChart", ...(spreadsheetId ? { spreadsheetId } : {}),
      ...(chartId !== undefined ? { chartId } : {}),
    };
  }
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

/** The master of every layout and slide a presentation or its outline lists, by object ID. */
export function mastersOf(rest: RestPresentation): Map<string, string> {
  let pages = [
    ...(rest.layouts ?? []).map(({ objectId, layoutProperties }) => [objectId, layoutProperties?.masterObjectId]),
    ...(rest.slides ?? []).map(({ objectId, slideProperties }) => [objectId, slideProperties?.masterObjectId]),
  ];
  return new Map(pages.filter((page): page is [string, string] => !!page[0] && !!page[1]));
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
  let master = properties?.masterObjectId;
  let title = titleOf(slide);
  return {
    id: slide.objectId,
    index,
    ...(layout ? { layout } : {}),
    ...(master ? { master } : {}),
    skipped: properties?.isSkipped === true,
    ...(title ? { title } : {}),
    hasSpeakerNotes: speakerNotesOf(slide).length > 0,
  };
}

/** The layouts a presentation read with `GoogleSlidesApi.getPresentation()` lists. */
function layoutsOf(rest: RestPresentation): SlideLayout[] {
  return (rest.layouts ?? []).flatMap(({ objectId, layoutProperties, pageElements }) => {
    let name = layoutProperties?.displayName;
    let master = layoutProperties?.masterObjectId;
    if (!objectId || !name || !master) return [];
    let placeholders = (pageElements ?? []).flatMap(({ shape }) => shape?.placeholder?.type ?? []);
    return [{ id: objectId, name, master, placeholders }];
  });
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
    layouts: layoutsOf(rest),
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
