// A model of how Google Docs applies the `documents.batchUpdate` requests the gatekeeper sends,
// on one tab. Tests judge a simulated edit against it, so it covers only what Google was seen to
// do: a request, or a shape of document, outside that throws "not modelled" instead of guessing.

import type {
  Bullet, DocsLocation, DocsRange, GoogleDocsRequest, GoogleDocsTab, Paragraph, ParagraphElement,
  ParagraphStyle, StructuralElement, Table, TableCell, TableCellLocation, TableCellStyle, TableRow,
  TextStyle,
} from "../src/docs-api";
import {
  docTabToMarkdown, isGoogleDocsStrippedCharacter, tableRowCells,
} from "../src/markdown-converter";

/** A length as Google writes one, in points. */
type Dimension = { magnitude: number; unit: "PT" };

/** A colour as Google writes one on a text style. */
type OptionalColor = { color: { rgbColor: { red?: number; green?: number; blue?: number } } };

/**
 * A text style with the fields the model keeps beside those the gatekeeper's types name, under
 * Google's own names. No rendering shows them.
 */
export type ModelTextStyle = TextStyle & {
  underline?: boolean;
  foregroundColor?: OptionalColor;
  fontSize?: Dimension;
};

/**
 * A paragraph style with the fields the model keeps beside those the gatekeeper's types name,
 * under Google's own names. No rendering shows them.
 */
export type ModelParagraphStyle = ParagraphStyle & {
  indentStart?: Dimension;
  indentFirstLine?: Dimension;
  alignment?: string;
};

/** The colour Google gives the text of a link. */
export const LINK_COLOR: OptionalColor = {
  color: { rgbColor: { red: 0.06666667, green: 0.33333334, blue: 0.8 } },
};

/** The size the model's cells carry on their line breaks when they took a heading's look. */
const HEADING_LOOK_FONT_SIZE: Dimension = { magnitude: 16, unit: "PT" };

/** The character a text run holds in place of a building block's chip. */
const CHIP_PLACEHOLDER = "\uE907";

/** What `insertTable` stores on each cell, as probe D1 read it: no border fields. */
const INSERTED_CELL_STYLE: TableCellStyle = {
  rowSpan: 1, columnSpan: 1, backgroundColor: {}, contentAlignment: "TOP",
  paddingLeft: { magnitude: 5, unit: "PT" }, paddingRight: { magnitude: 5, unit: "PT" },
  paddingTop: { magnitude: 5, unit: "PT" }, paddingBottom: { magnitude: 5, unit: "PT" },
};

/**
 * The width the model narrows a fixed column to when a column is added beside one that shares
 * the page's width: what probe S2c saw for a cell of plain text and 5pt padding. Google does it
 * only sometimes; the model always does, so a change that does not set the widths back shows.
 */
const NARROWED_WIDTH = 13;

const OUTSIDE_PARAGRAPH = "The insertion index must be inside the bounds of an existing paragraph.";
const WITHIN_GRAPHEME = "The insertion index cannot be within a grapheme cluster.";
const EMPTY_RANGE = "The range should not be empty";
const INVALID_DELETION = "Invalid deletion range. Cannot delete the requested range.";
const NO_ROWS = "The number of table rows should be greater than zero.";
const INVALID_TABLE_START =
  "Invalid table start location. Must specify the start index of the table.";

const TEXT_FIELDS = [
  "bold", "italic", "strikethrough", "link", "underline", "foregroundColor", "fontSize",
] as const;
type TextField = typeof TEXT_FIELDS[number];

/** What a paragraph's text loses when the paragraph is given a named style. */
const LOOK_FIELDS = [
  "bold", "italic", "strikethrough", "underline", "foregroundColor", "fontSize",
] as const;

/** What a cell added to a table takes from the first character of the cell beside it. */
const COPIED_FIELDS = [
  "bold", "italic", "strikethrough", "link", "fontSize", "foregroundColor",
] as const;

const PARAGRAPH_FIELDS = ["namedStyleType", "indentStart", "indentFirstLine"] as const;
type ParagraphField = typeof PARAGRAPH_FIELDS[number];

/** Which of Google's behaviours, where two are on record, the model takes. */
type ModelOptions = {
  /** Copy into a new cell the look Google copies from the cell or heading beside it. */
  copyStyles?: boolean;
  /** Give text whose link is removed the style of the text before it, as Google documents. */
  unlinkRestyles?: boolean;
};

function notModelled(what: string): never {
  throw new Error(`not modelled: ${what}`);
}

/** Google Docs' behaviour for the requests the gatekeeper sends, on one tab. */
export function applyDocsRequests(
  tab: GoogleDocsTab, requests: readonly GoogleDocsRequest[], options: ModelOptions = {},
): GoogleDocsTab {
  let result = structuredClone(tab);
  reindex(result);
  for (let request of requests) {
    applyRequest(result, request, options);
    reindex(result);
  }
  return result;
}

/** The start indexes of the paragraphs, body and cells, that carry a non-zero indent. */
export function indentedParagraphs(tab: GoogleDocsTab): number[] {
  let indented: number[] = [];
  for (let element of allParagraphs(tab.body.content)) {
    let style: ModelParagraphStyle = element.paragraph.paragraphStyle;
    if (style.indentStart?.magnitude || style.indentFirstLine?.magnitude) {
      indented.push(element.startIndex);
    }
  }
  return indented;
}

/** Whether the character at `index` carries the underline or the colour a link is given. */
export function hasLinkLook(tab: GoogleDocsTab, index: number): boolean {
  let style = styleAt(tab, index);
  return style?.underline === true || sameValue(style?.foregroundColor, LINK_COLOR);
}

/** The font size, in points, that the character at `index` carries itself, if any. */
export function fontSizeAt(tab: GoogleDocsTab, index: number): number | undefined {
  return styleAt(tab, index)?.fontSize?.magnitude;
}

/** The alignment the paragraph that holds `index` sets itself, if any. */
export function alignmentAt(tab: GoogleDocsTab, index: number): string | undefined {
  let style: ModelParagraphStyle | undefined =
    paragraphAt(tab.body.content, index)?.paragraph.paragraphStyle;
  return style?.alignment;
}

/** How many rows, from the first, the table that starts at `tableStart` pins as its header. */
export function pinnedHeaderRows(tab: GoogleDocsTab, tableStart: number): number {
  let found = tableAt(tab.body.content, tableStart);
  if (!found) throw new Error(`No table starts at index ${tableStart}`);
  let rows = found.table.tableRows ?? [];
  let pinned = 0;
  while (rows[pinned]?.tableRowStyle?.tableHeader === true) pinned++;
  return pinned;
}

// ---------------------------------------------------------------------------
// Finding things by index
// ---------------------------------------------------------------------------

type ParagraphElementOf = StructuralElement & { paragraph: Paragraph };

/** A cell, by the table that holds it and its row and column there. */
type CellPlace = { table: Table; rowIndex: number; columnIndex: number };

/** A paragraph and the list of elements, a body's or a cell's, that holds it. */
type ParagraphPlace = {
  container: StructuralElement[];
  position: number;
  element: ParagraphElementOf;
  paragraph: Paragraph;
  /** The cells the paragraph lies in, the outermost first: none for a paragraph of the body. */
  cells: CellPlace[];
};

/** A table and the list of elements that holds it. */
type TablePlace = {
  container: StructuralElement[];
  position: number;
  element: StructuralElement;
  table: Table;
  /** Whether the table is an element of the tab's body, not of a cell. */
  topLevel: boolean;
};

function isParagraph(element: StructuralElement): element is ParagraphElementOf {
  return element.paragraph !== undefined;
}

function cellsOf(table: Table): TableCell[] {
  return (table.tableRows ?? []).flatMap(row => row.tableCells ?? []);
}

/** Every paragraph of `content` in document order, those of table cells included. */
function* allParagraphs(content: readonly StructuralElement[]): Generator<ParagraphElementOf> {
  for (let element of content) {
    if (isParagraph(element)) yield element;
    else if (element.table) {
      for (let cell of cellsOf(element.table)) yield* allParagraphs(cell.content ?? []);
    }
  }
}

/** The paragraph that holds `index`, in `content` or in a table cell of it. */
function paragraphAt(
  content: StructuralElement[], index: number, cells: CellPlace[] = [],
): ParagraphPlace | undefined {
  for (let [position, element] of content.entries()) {
    if (index < element.startIndex) return undefined;
    if (index >= element.endIndex) continue;
    if (isParagraph(element)) {
      return { container: content, position, element, paragraph: element.paragraph, cells };
    }
    let { table } = element;
    if (!table) return undefined;
    for (let [rowIndex, row] of (table.tableRows ?? []).entries()) {
      if (index >= row.endIndex) continue;
      for (let [columnIndex, cell] of (row.tableCells ?? []).entries()) {
        // A cell's own index is before its content, in no paragraph.
        if (cell.startIndex < index && index < cell.endIndex) {
          return paragraphAt(
            cell.content ?? [], index, [...cells, { table, rowIndex, columnIndex }]);
        }
      }
      return undefined;
    }
    return undefined;
  }
  return undefined;
}

/**
 * Whether another cell of the table covers this one with its row or column span. Such a cell
 * reads as an ordinary empty cell: only the spans of the cell that covers it tell.
 */
function isCovered({ table, rowIndex, columnIndex }: CellPlace): boolean {
  let rows = table.tableRows ?? [];
  for (let headRow = 0; headRow <= rowIndex; headRow++) {
    let cells = rows[headRow]?.tableCells ?? [];
    for (let headColumn = 0; headColumn <= columnIndex && headColumn < cells.length; headColumn++) {
      if (headRow === rowIndex && headColumn === columnIndex) continue;
      let spans = cells[headColumn].tableCellStyle;
      if (headRow + (spans?.rowSpan ?? 1) > rowIndex &&
        headColumn + (spans?.columnSpan ?? 1) > columnIndex) return true;
    }
  }
  return false;
}

/**
 * The paragraph a request names by `index`. Google puts text sent to a cell that a merged cell
 * covers into the merged cell, and what it does with any other request there nobody has seen, so
 * no request is applied to a paragraph of a covered cell.
 */
function requestedParagraphAt(tab: GoogleDocsTab, index: number): ParagraphPlace | undefined {
  let place = paragraphAt(tab.body.content, index);
  if (place?.cells.some(isCovered)) {
    notModelled("a request at a paragraph of a cell that a merged cell covers");
  }
  return place;
}

/** The table whose start index is `index`, in `content` or in a table cell of it. */
function tableAt(
  content: StructuralElement[], index: number, topLevel = true,
): TablePlace | undefined {
  for (let [position, element] of content.entries()) {
    if (index < element.startIndex) return undefined;
    if (index >= element.endIndex || !element.table) continue;
    if (element.startIndex === index) {
      return { container: content, position, element, table: element.table, topLevel };
    }
    for (let cell of cellsOf(element.table)) {
      if (cell.startIndex < index && index < cell.endIndex) {
        return tableAt(cell.content ?? [], index, false);
      }
    }
    return undefined;
  }
  return undefined;
}

/** The text style a paragraph element carries, whatever kind of element it is. */
function elementTextStyle(element: ParagraphElement): ModelTextStyle | undefined {
  return element.textRun?.textStyle ?? element.person?.textStyle ?? element.richLink?.textStyle ??
    element.dateElement?.textStyle ?? element.dropdown?.textStyle ?? element.autoText?.textStyle ??
    element.footnoteReference?.textStyle ?? element.inlineObjectElement?.textStyle ??
    element.pageBreak?.textStyle ?? element.columnBreak?.textStyle;
}

function elementAt(tab: GoogleDocsTab, index: number): ParagraphElement | undefined {
  return paragraphAt(tab.body.content, index)?.paragraph.elements.find(element =>
    element.startIndex <= index && index < element.endIndex);
}

function styleAt(tab: GoogleDocsTab, index: number): ModelTextStyle | undefined {
  let element = elementAt(tab, index);
  return element && elementTextStyle(element);
}

/** The UTF-16 code unit at `index`, when a text run holds that index. */
function codeUnitAt(tab: GoogleDocsTab, index: number): number | undefined {
  let element = elementAt(tab, index);
  return element?.textRun?.content.charCodeAt(index - element.startIndex);
}

/** Whether `index` lies between the two halves of a surrogate pair. */
function splitsSurrogatePair(tab: GoogleDocsTab, index: number): boolean {
  let before = codeUnitAt(tab, index - 1);
  let after = codeUnitAt(tab, index);
  return before !== undefined && after !== undefined &&
    before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

function requireTab(tab: GoogleDocsTab, coordinate: { tabId: string }): void {
  if (coordinate.tabId !== tab.tabId) {
    notModelled(`a coordinate that does not name tab "${tab.tabId}"`);
  }
}

/** The paragraphs a range touches, which must all lie in one body or one cell. */
function paragraphsInRange(
  tab: GoogleDocsTab, range: DocsRange, request: string,
): ParagraphElementOf[] {
  requireTab(tab, range);
  if (range.startIndex >= range.endIndex) notModelled(`${request} over an empty range`);
  let first = requestedParagraphAt(tab, range.startIndex);
  let last = requestedParagraphAt(tab, range.endIndex - 1);
  if (!first || !last || first.container !== last.container) {
    notModelled(`${request} over a range that is not within the paragraphs of one body or cell`);
  }
  let touched = first.container.slice(first.position, last.position + 1);
  if (!touched.every(isParagraph)) {
    notModelled(`${request} over a range that holds a table or another structure`);
  }
  return touched;
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  let leftEntries = Object.entries(left);
  let rightValues: Record<string, unknown> = { ...right };
  return leftEntries.length === Object.keys(rightValues).length &&
    leftEntries.every(([key, value]) => sameValue(value, rightValues[key]));
}

// ---------------------------------------------------------------------------
// Indexes
// ---------------------------------------------------------------------------

/** Recompute every index of the tab from the content it holds. */
function reindex(tab: GoogleDocsTab): void {
  reindexContent(tab.body.content, 0, true);
}

function reindexContent(content: StructuralElement[], start: number, body: boolean): number {
  let index = start;
  for (let [position, element] of content.entries()) {
    let length = element.endIndex - element.startIndex;
    element.startIndex = index;
    if (element.paragraph) index = reindexParagraph(element.paragraph, index);
    else if (element.table) index = reindexTable(element.table, index);
    // The section break that opens a body takes one index.
    else index += body && position === 0 && element.sectionBreak ? 1 : length;
    element.endIndex = index;
  }
  return index;
}

function reindexParagraph(paragraph: Paragraph, start: number): number {
  let index = start;
  // Google keeps no empty text run.
  paragraph.elements = paragraph.elements.filter(element => element.textRun?.content !== "");
  for (let element of paragraph.elements) {
    // A text run is as long as its text; any other element keeps its length.
    let length = element.textRun?.content.length ?? element.endIndex - element.startIndex;
    element.startIndex = index;
    index += length;
    element.endIndex = index;
  }
  return index;
}

function reindexTable(table: Table, start: number): number {
  // One index for the table's start, one for each row's and one for each cell's.
  let index = start + 1;
  for (let row of table.tableRows ?? []) {
    row.startIndex = index++;
    for (let cell of row.tableCells ?? []) {
      cell.startIndex = index++;
      index = reindexContent(cell.content ?? [], index, false);
      cell.endIndex = index;
    }
    row.endIndex = index;
  }
  // And one for the table's end.
  return index + 1;
}

/** Number the footnote references of the tab by their place, body and cells in order. */
function renumberFootnotes(tab: GoogleDocsTab): void {
  let number = 0;
  for (let { paragraph } of allParagraphs(tab.body.content)) {
    for (let { footnoteReference } of paragraph.elements) {
      if (footnoteReference) footnoteReference.footnoteNumber = String(++number);
    }
  }
}

// ---------------------------------------------------------------------------
// Building content
// ---------------------------------------------------------------------------

function textRun(content: string, textStyle: ModelTextStyle): ParagraphElement {
  return { startIndex: 0, endIndex: content.length, textRun: { content, textStyle } };
}

/** A paragraph element holding `elements`, with indexes still to be computed. */
function paragraphElement(
  elements: ParagraphElement[], paragraphStyle: ModelParagraphStyle, bullet: Bullet | undefined,
): ParagraphElementOf {
  return {
    startIndex: 0,
    endIndex: 0,
    paragraph: { elements, paragraphStyle, ...(bullet ? { bullet } : {}) },
  };
}

/** A copy of `paragraph`'s style and bullet around other content, as Google splits a paragraph. */
function siblingParagraph(paragraph: Paragraph, elements: ParagraphElement[]): ParagraphElementOf {
  return paragraphElement(
    elements, structuredClone(paragraph.paragraphStyle), structuredClone(paragraph.bullet));
}

function plainParagraph(lineBreak: ModelTextStyle = {}): ParagraphElementOf {
  return paragraphElement(
    [textRun("\n", lineBreak)], { namedStyleType: "NORMAL_TEXT" }, undefined);
}

function cellOf(paragraph: ParagraphElementOf): TableCell {
  return { startIndex: 0, endIndex: 0, content: [paragraph] };
}

/** The indent Google leaves on, or copies from, a list item of one nesting level. */
function listItemIndent(
  bullet: Bullet,
): Pick<ModelParagraphStyle, "indentStart" | "indentFirstLine"> {
  let level = bullet.nestingLevel ?? 0;
  return {
    indentStart: { magnitude: 36 * (level + 1), unit: "PT" },
    indentFirstLine: { magnitude: 18 + 36 * level, unit: "PT" },
  };
}

/** Copy one field of a text style, removing it where the source has none. */
function copyTextField<Field extends TextField>(
  target: ModelTextStyle, source: ModelTextStyle, field: Field,
): void {
  if (source[field] === undefined) delete target[field];
  else target[field] = structuredClone(source[field]);
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

function applyRequest(tab: GoogleDocsTab, request: GoogleDocsRequest, options: ModelOptions): void {
  if ("insertText" in request) return insertText(tab, request.insertText);
  if ("deleteContentRange" in request) return deleteContentRange(tab, request.deleteContentRange);
  if ("updateTextStyle" in request) return updateTextStyle(tab, request.updateTextStyle, options);
  if ("updateParagraphStyle" in request) {
    return updateParagraphStyle(tab, request.updateParagraphStyle);
  }
  if ("deleteParagraphBullets" in request) {
    return deleteParagraphBullets(tab, request.deleteParagraphBullets);
  }
  if ("insertTable" in request) return insertTable(tab, request.insertTable, options);
  if ("insertTableRow" in request) {
    let { tableCellLocation, insertBelow } = request.insertTableRow;
    return insertTableRow(tab, tableCellLocation, insertBelow, options);
  }
  if ("insertTableColumn" in request) {
    let { tableCellLocation, insertRight } = request.insertTableColumn;
    return insertTableColumn(tab, tableCellLocation, insertRight, options);
  }
  if ("deleteTableRow" in request) {
    return deleteTableRow(tab, request.deleteTableRow.tableCellLocation);
  }
  if ("deleteTableColumn" in request) {
    return deleteTableColumn(tab, request.deleteTableColumn.tableCellLocation);
  }
  if ("pinTableHeaderRows" in request) return pinTableHeaderRows(tab, request.pinTableHeaderRows);
  if ("updateTableColumnProperties" in request) {
    return updateTableColumnProperties(tab, request.updateTableColumnProperties);
  }
  notModelled(`the request ${Object.keys(request).join(", ")}`);
}

/** `text` without the characters Google removes from inserted text. */
function writtenText(text: string): string {
  return Array.from({ length: text.length }, (_, index) => text[index])
    .filter(unit => !isGoogleDocsStrippedCharacter(unit.charCodeAt(0)))
    .join("");
}

function insertText(
  tab: GoogleDocsTab, { location, text }: { location: DocsLocation; text: string },
): void {
  requireTab(tab, location);
  let { index } = location;
  let place = requestedParagraphAt(tab, index);
  if (!place) {
    throw new Error(
      `${OUTSIDE_PARAGRAPH} You can still create new paragraphs by inserting newlines.`);
  }
  if (splitsSurrogatePair(tab, index)) throw new Error(WITHIN_GRAPHEME);
  let written = writtenText(text);
  if (written === "") notModelled("insertText of no text");

  let { elements } = place.paragraph;
  let position = elements.findIndex(element =>
    element.startIndex <= index && index < element.endIndex);
  let here = elements[position];
  if (here.startIndex < index) {
    // Inside a text run the text joins it, a link included.
    if (!here.textRun) notModelled("insertText inside an element that is not text");
    let offset = index - here.startIndex;
    here.textRun.content =
      here.textRun.content.slice(0, offset) + written + here.textRun.content.slice(offset);
  } else {
    let before = elements[position - 1]?.textRun;
    if (before && !before.textStyle.link) {
      before.content += written;
    } else if (before) {
      // Text never joins the link it follows: it is styled as what comes after it.
      if (!here.textRun) notModelled("insertText between a link and an element that is not text");
      here.textRun.content = written + here.textRun.content;
    } else if (here.textRun && !here.textRun.textStyle.link) {
      here.textRun.content = written + here.textRun.content;
    } else {
      // Nothing to take a style from: before a link, or before an element that is not text.
      elements.splice(position, 0, textRun(written, {}));
    }
  }
  splitAtLineBreaks(place);
}

/** Make a paragraph of each line of `place`'s paragraph: a line break ends a paragraph. */
function splitAtLineBreaks(place: ParagraphPlace): void {
  let { paragraph } = place;
  let lines: ParagraphElement[][] = [[]];
  for (let element of paragraph.elements) {
    let run = element.textRun;
    if (!run) {
      lines[lines.length - 1].push(element);
      continue;
    }
    for (let piece of run.content.split(/(?<=\n)/)) {
      lines[lines.length - 1].push(textRun(piece, structuredClone(run.textStyle)));
      if (piece.endsWith("\n")) lines.push([]);
    }
  }
  if (lines[lines.length - 1].length > 0) {
    notModelled("a paragraph that does not end in a line break");
  }
  lines.pop();
  if (lines.length === 0) notModelled("a paragraph with no content");
  // The first paragraph stays the one it was; each further one copies its style and bullet.
  paragraph.elements = lines[0];
  place.container.splice(place.position + 1, 0,
    ...lines.slice(1).map(line => siblingParagraph(paragraph, line)));
}

/** The elements of a paragraph without the indexes `[from, to)`. */
function elementsWithout(
  element: ParagraphElementOf, from: number, to: number,
): ParagraphElement[] {
  let kept: ParagraphElement[] = [];
  for (let part of element.paragraph.elements) {
    if (part.endIndex <= from || part.startIndex >= to) {
      kept.push(part);
    } else if (part.textRun) {
      let { content, textStyle } = part.textRun;
      let rest = content.slice(0, Math.max(0, from - part.startIndex)) +
        content.slice(Math.min(content.length, to - part.startIndex));
      if (rest) kept.push(textRun(rest, textStyle));
    } else if (part.startIndex < from || part.endIndex > to) {
      notModelled("a deletion of part of an element that is not text");
    }
  }
  return kept;
}

function deleteContentRange(tab: GoogleDocsTab, { range }: { range: DocsRange }): void {
  requireTab(tab, range);
  let { startIndex: start, endIndex: end } = range;
  if (start === end) throw new Error(EMPTY_RANGE);
  if (start > end) notModelled("a deletion whose range ends before it starts");
  // Google refuses to delete half of a surrogate pair.
  if (splitsSurrogatePair(tab, start) || splitsSurrogatePair(tab, end)) {
    throw new Error(INVALID_DELETION);
  }
  let body = tab.body.content;
  let first = requestedParagraphAt(tab, start);
  if (!first) {
    let found = tableAt(body, start);
    if (found && found.element.endIndex === end) {
      if (!found.topLevel) notModelled("the deletion of a table inside a cell");
      found.container.splice(found.position, 1);
      renumberFootnotes(tab);
      return;
    }
    if (found && end > found.element.endIndex) {
      notModelled("a deletion that takes a table together with what follows it");
    }
    // The start, the end, a row or a cell of a table: a range may cross into a table only by
    // holding all of it.
    let inTable = body.some(element =>
      element.table && element.startIndex <= start && start < element.endIndex);
    if (inTable) throw new Error(INVALID_DELETION);
    notModelled("a deletion that starts outside a paragraph and outside a table");
  }

  let last = requestedParagraphAt(tab, end);
  // What follows the range has to be a paragraph of the same body or cell: the final line break
  // of a body or a cell, and the one before a table, cannot be deleted.
  if (!last || last.container !== first.container) throw new Error(INVALID_DELETION);
  if (last.position === first.position) {
    first.paragraph.elements = elementsWithout(first.element, start, end);
  } else {
    let taken = first.container.slice(first.position, last.position + 1);
    if (!taken.every(isParagraph)) {
      notModelled(
        "a deletion that takes a table or another structure together with text around it");
    }
    if (taken.some(({ paragraph }) => paragraph.positionedObjectIds?.length)) {
      notModelled("a deletion that joins paragraphs one of which anchors a positioned object");
    }
    // The paragraph whose line break remains survives, with its style and bullet.
    last.paragraph.elements = [
      ...elementsWithout(first.element, start, first.element.endIndex),
      ...elementsWithout(last.element, last.element.startIndex, end),
    ];
    first.container.splice(first.position, last.position - first.position);
  }
  renumberFootnotes(tab);
}

/** The names in a field mask, each of which must be one of `known`. */
function fieldNames<Field extends string>(
  fields: string, known: readonly Field[], request: string,
): Set<Field> {
  let names = new Set<Field>();
  for (let name of fields.split(",")) {
    let field = known.find(candidate => candidate === name);
    if (field === undefined) notModelled(`${request} naming the field "${name}"`);
    names.add(field);
  }
  return names;
}

/** Split the text run of `paragraph` that holds `index`, so that a run starts there. */
function splitRunAt(paragraph: Paragraph, index: number): void {
  let position = paragraph.elements.findIndex(element =>
    element.startIndex < index && index < element.endIndex);
  if (position < 0) return;
  let element = paragraph.elements[position];
  if (!element.textRun) notModelled("a text style over part of an element that is not text");
  let { content, textStyle } = element.textRun;
  let offset = index - element.startIndex;
  let head = textRun(content.slice(0, offset), textStyle);
  let tail = textRun(content.slice(offset), structuredClone(textStyle));
  head.startIndex = element.startIndex;
  head.endIndex = tail.startIndex = index;
  tail.endIndex = element.endIndex;
  paragraph.elements.splice(position, 1, head, tail);
}

/**
 * Point every link of `paragraph` that shares a character with `[start, end)` to `link`, whole:
 * a link set on part of another link repoints all of it.
 */
function repointOverlappedLinks(
  paragraph: Paragraph, start: number, end: number, link: TextStyle["link"],
): void {
  let { elements } = paragraph;
  for (let from = 0; from < elements.length;) {
    let existing = elements[from].textRun?.textStyle.link;
    // A link reaches over every run beside this one that carries the same destination.
    let to = from + 1;
    if (existing) {
      while (to < elements.length &&
        sameValue(elements[to].textRun?.textStyle.link, existing)) to++;
      if (elements[from].startIndex < end && elements[to - 1].endIndex > start) {
        for (let element of elements.slice(from, to)) {
          if (element.textRun) element.textRun.textStyle.link = structuredClone(link);
        }
      }
    }
    from = to;
  }
}

const NAMED_FIELDS = ["bold", "italic", "strikethrough"] as const;

/**
 * The bold, italic and strikethrough the named style of `paragraph` gives its text, resolved over
 * normal text's; none for a tab built without named styles.
 */
function namedTextStyle(
  tab: GoogleDocsTab, paragraph: Paragraph,
): Record<(typeof NAMED_FIELDS)[number], boolean> | undefined {
  let styles = tab.namedStyles?.styles;
  if (!styles) return undefined;
  let own = styles.find(style => style.namedStyleType === paragraph.paragraphStyle.namedStyleType);
  let normal = styles.find(style => style.namedStyleType === "NORMAL_TEXT");
  let resolve = (field: (typeof NAMED_FIELDS)[number]) =>
    own?.textStyle?.[field] ?? normal?.textStyle?.[field] ?? false;
  return { bold: resolve("bold"), italic: resolve("italic"), strikethrough: resolve("strikethrough") };
}

function updateTextStyle(
  tab: GoogleDocsTab,
  { range, textStyle, fields }: { range: DocsRange; textStyle: TextStyle; fields: string },
  options: ModelOptions,
): void {
  requireTab(tab, range);
  let { startIndex: start, endIndex: end } = range;
  if (start === end) throw new Error(EMPTY_RANGE);
  let named = fieldNames(fields, TEXT_FIELDS, "updateTextStyle");
  let paragraphs = paragraphsInRange(tab, range, "updateTextStyle");
  let style: ModelTextStyle = textStyle;
  let setsLink = named.has("link") && style.link !== undefined;
  let clearsLink = named.has("link") && style.link === undefined;
  if (setsLink && named.has("underline") !== named.has("foregroundColor")) {
    notModelled("a link set by a request that names one of underline and foregroundColor");
  }
  // Read before anything changes: the text before the range may be restyled by this request.
  let preceding = styleAt(tab, start - 1);
  let inherited: ModelTextStyle = preceding && !preceding.link ? structuredClone(preceding) : {};

  for (let { paragraph } of paragraphs) {
    if (setsLink) repointOverlappedLinks(paragraph, start, end, style.link);
    splitRunAt(paragraph, start);
    splitRunAt(paragraph, end);
    let given = namedTextStyle(tab, paragraph);
    for (let element of paragraph.elements) {
      if (element.endIndex <= start || element.startIndex >= end) continue;
      if (!element.textRun) notModelled("a text style over an element that is not text");
      let own: ModelTextStyle = element.textRun.textStyle;
      let hadLink = own.link !== undefined;
      for (let field of named) copyTextField(own, style, field);
      // Google stores a style the paragraph's named style already gives as inherited, true or
      // false, as live probes showed.
      for (let field of NAMED_FIELDS) {
        if (given && named.has(field) && own[field] === given[field]) delete own[field];
      }
      if (setsLink && !named.has("underline")) {
        // A link brings its look with it.
        own.underline = true;
        own.foregroundColor = structuredClone(LINK_COLOR);
      }
      if (options.unlinkRestyles && clearsLink && hadLink) {
        for (let field of LOOK_FIELDS) {
          if (!named.has(field)) copyTextField(own, inherited, field);
        }
      }
    }
  }
}

function isDimension(value: unknown): value is Dimension {
  return typeof value === "object" && value !== null && "magnitude" in value &&
    typeof value.magnitude === "number" && "unit" in value && value.unit === "PT";
}

function updateParagraphStyle(
  tab: GoogleDocsTab,
  { range, paragraphStyle, fields }: {
    range: DocsRange; paragraphStyle: Record<string, unknown>; fields: string;
  },
): void {
  let named = fieldNames<ParagraphField>(fields, PARAGRAPH_FIELDS, "updateParagraphStyle");
  for (let { paragraph } of paragraphsInRange(tab, range, "updateParagraphStyle")) {
    let style: ModelParagraphStyle = paragraph.paragraphStyle;
    if (named.has("namedStyleType")) {
      let { namedStyleType } = paragraphStyle;
      if (typeof namedStyleType !== "string") {
        notModelled("updateParagraphStyle naming namedStyleType without giving one");
      }
      style.namedStyleType = namedStyleType;
      // Naming the style resets more than the style: the paragraph's alignment goes, and so
      // does the look of its text. A link stays.
      delete style.alignment;
      for (let { textRun: run } of paragraph.elements) {
        if (!run) continue;
        let own: ModelTextStyle = run.textStyle;
        for (let field of LOOK_FIELDS) delete own[field];
      }
    }
    for (let field of ["indentStart", "indentFirstLine"] as const) {
      if (!named.has(field)) continue;
      let value = paragraphStyle[field];
      if (value === undefined) delete style[field];
      else if (isDimension(value)) style[field] = { ...value };
      else notModelled(`updateParagraphStyle with ${field} not in points`);
    }
  }
}

function deleteParagraphBullets(tab: GoogleDocsTab, { range }: { range: DocsRange }): void {
  for (let { paragraph } of paragraphsInRange(tab, range, "deleteParagraphBullets")) {
    if (!paragraph.bullet) continue;
    // Google leaves the paragraph indented where its bullet stood.
    let style: ModelParagraphStyle = paragraph.paragraphStyle;
    Object.assign(style, listItemIndent(paragraph.bullet));
    delete paragraph.bullet;
  }
}

function insertTable(
  tab: GoogleDocsTab,
  { rows, columns, location }: { rows: number; columns: number; location: DocsLocation },
  options: ModelOptions,
): void {
  requireTab(tab, location);
  let { index } = location;
  let place = requestedParagraphAt(tab, index);
  if (!place) throw new Error(OUTSIDE_PARAGRAPH);
  if (rows === 0) throw new Error(NO_ROWS);
  if (!Number.isInteger(rows) || rows < 0 || !Number.isInteger(columns) || columns < 1) {
    notModelled(`insertTable of ${rows} rows and ${columns} columns`);
  }
  let { element, paragraph } = place;
  let atStart = index === element.startIndex;
  if (!atStart && index !== element.endIndex - 1) {
    notModelled("insertTable strictly inside a paragraph's text");
  }
  let lineBreak = paragraph.elements.at(-1)?.textRun;
  if (!lineBreak?.content.endsWith("\n")) {
    notModelled("a paragraph that does not end in a line break");
  }

  // Google cuts the paragraph in two around the table, and both parts carry its style, bullet
  // and indent. A positioned object stays with the part before the table.
  let before: ParagraphElementOf;
  let after: ParagraphElementOf;
  if (atStart) {
    before = siblingParagraph(paragraph, [textRun("\n", {})]);
    if (paragraph.positionedObjectIds) {
      before.paragraph.positionedObjectIds = paragraph.positionedObjectIds;
      delete paragraph.positionedObjectIds;
    }
    after = element;
  } else {
    before = element;
    after = siblingParagraph(paragraph, [textRun("\n", structuredClone(lineBreak.textStyle))]);
  }

  // Cut at its start, a paragraph of a named style gives the cells that style's look, written
  // onto their line breaks.
  let headingLook: ModelTextStyle | undefined = options.copyStyles && atStart &&
    paragraph.paragraphStyle.namedStyleType !== "NORMAL_TEXT"
    ? { italic: true, fontSize: HEADING_LOOK_FONT_SIZE }
    : undefined;
  let tableRows = Array.from({ length: rows }, (): TableRow => ({
    startIndex: 0,
    endIndex: 0,
    tableCells: Array.from({ length: columns }, () => ({
      ...cellOf(plainParagraph(structuredClone(headingLook))),
      tableCellStyle: structuredClone(INSERTED_CELL_STYLE),
    })),
    tableRowStyle: { minRowHeight: { unit: "PT" } },
  }));
  let tableStyle = {
    tableColumnProperties: Array.from({ length: columns }, () => ({ widthType: "EVENLY_DISTRIBUTED" })),
  };
  place.container.splice(place.position, 1,
    before, { startIndex: 0, endIndex: 0, table: { tableRows, tableStyle } }, after);
}

/** The cell a row or column request names, in a table whose rows and columns can be changed. */
type NamedCell = { place: TablePlace; rows: TableRow[]; rowIndex: number; columnIndex: number };

function namedCell(tab: GoogleDocsTab, location: TableCellLocation, request: string): NamedCell {
  requireTab(tab, location.tableStartLocation);
  let place = tableAt(tab.body.content, location.tableStartLocation.index);
  if (!place) throw new Error(INVALID_TABLE_START);
  if (!place.topLevel) notModelled(`${request} on a table inside a cell`);
  let { table } = place;
  let rows = table.tableRows ?? [];
  let cells = cellsOf(table);
  if (cells.some(({ tableCellStyle: spans }) =>
    (spans?.rowSpan ?? 1) > 1 || (spans?.columnSpan ?? 1) > 1)) {
    notModelled(`${request} on a table with a merged cell`);
  }
  if ([table, ...rows, ...cells].some(part =>
    part.suggestedInsertionIds?.length || part.suggestedDeletionIds?.length)) {
    notModelled(`${request} on a table that holds a suggestion`);
  }
  let { rowIndex, columnIndex } = location;
  if (!Number.isInteger(rowIndex) || rowIndex < 0 ||
    !Number.isInteger(columnIndex) || columnIndex < 0) {
    notModelled(`${request} at row ${rowIndex}, column ${columnIndex}`);
  }
  if (rowIndex >= rows.length) {
    throw new Error(
      `The row index ${rowIndex} should be less than the total number of rows ${rows.length}.`);
  }
  let columns = rows[rowIndex].tableCells?.length ?? 0;
  if (columnIndex >= columns) {
    throw new Error(
      `The column index ${columnIndex} should be less than the total number of columns ` +
      `${columns}.`);
  }
  return { place, rows, rowIndex, columnIndex };
}

/**
 * The paragraph of a cell added beside `reference`: plain, or with what Google copies from the
 * first paragraph of the cell beside it, which is that paragraph's style and, on the new cell's
 * line break, the text style of its first character. Never its bullet, and no second paragraph.
 */
function newCellParagraph(reference: TableCell, options: ModelOptions): ParagraphElementOf {
  let first = reference.content?.[0]?.paragraph;
  if (!options.copyStyles || !first) return plainParagraph();
  let style: ModelParagraphStyle = structuredClone(first.paragraphStyle);
  // A cell copied from a list item is indented as that item's level is.
  if (first.bullet) Object.assign(style, listItemIndent(first.bullet));
  let source = first.elements[0] && elementTextStyle(first.elements[0]);
  let lineBreak: ModelTextStyle = {};
  if (source) for (let field of COPIED_FIELDS) copyTextField(lineBreak, source, field);
  return paragraphElement([textRun("\n", lineBreak)], style, undefined);
}

/**
 * What Google copies into the cell of a new row from the chips that stand alone in the cell
 * beside it, as live probes saw it: a dropdown for a dropdown, set to its first option; the
 * placeholder character for a placeholder, or for a person chip, a date chip or a rich link, also
 * with spaces after it, which are not copied; and nothing for two or more of those chips. Nothing
 * for a cell the table map does not flag.
 */
function copiedChip(reference: TableCell, loneChip: boolean): ParagraphElement | undefined {
  if (!loneChip) return undefined;
  let elements = reference.content?.[0]?.paragraph?.elements ?? [];
  let text = elements.map(element => element.textRun?.content ?? "").join("");
  let others = elements.filter(element => !element.textRun);
  let copiedAsPlaceholder = (element: ParagraphElement) =>
    !!(element.person || element.dateElement || element.richLink);
  if (others.length === 0 && text === `${CHIP_PLACEHOLDER}\n`) return textRun(CHIP_PLACEHOLDER, {});
  if (others.length > 1 && text === "\n" && others.every(copiedAsPlaceholder)) return undefined;
  if (others.length === 1) {
    let [chip] = others;
    if (copiedAsPlaceholder(chip) && elements[0] === chip && /^ *\n$/.test(text)) {
      return textRun(CHIP_PLACEHOLDER, {});
    }
    if (chip.dropdown && text === "\n") {
      // The copy is a dropdown of the same definition, set to that definition's first option,
      // which the document does not name.
      let definition = chip.dropdown.dropdownProperties?.dropdownDefinitionId;
      return {
        startIndex: 0,
        endIndex: 1,
        dropdown: {
          textStyle: {},
          dropdownProperties: definition === undefined ? {} : { dropdownDefinitionId: definition },
        },
      };
    }
  }
  return notModelled("a row added beside a cell of chips in a shape nobody has seen copied");
}

/** Whether a cell holds anything a table map could flag as a chip. */
function mayHoldChip(cell: TableCell): boolean {
  return (cell.content ?? []).some(({ paragraph }) => paragraph?.elements.some(element =>
    !element.textRun || element.textRun.content.includes(CHIP_PLACEHOLDER)));
}

function insertTableRow(
  tab: GoogleDocsTab, location: TableCellLocation, below: boolean, options: ModelOptions,
): void {
  let { place, rows, rowIndex } = namedCell(tab, location, "insertTableRow");
  let reference = rows[rowIndex];
  let cells = reference.tableCells ?? [];
  // Which cells hold a chip alone is the table map's to say. It is asked only when the row holds
  // something it could flag.
  let flags = cells.some(mayHoldChip)
    ? docTabToMarkdown(tab).sourceMap.tables.find(table =>
      table.docStart === place.element.startIndex)
    : undefined;
  let entries = flags && tableRowCells(flags, rowIndex);
  let header = reference.tableRowStyle?.tableHeader === true;
  let height = reference.tableRowStyle?.minRowHeight;
  let row: TableRow = {
    startIndex: 0,
    endIndex: 0,
    tableCells: cells.map((cell, column) => {
      let paragraph = newCellParagraph(cell, options);
      let chip = copiedChip(cell, entries?.[column]?.loneChip === true);
      if (chip) paragraph.paragraph.elements.unshift(chip);
      return withCopiedStyle(cellOf(paragraph), cell);
    }),
    // A row added beside a pinned header row is pinned too, and every row takes the height of
    // the row it copies, as probe S1 saw.
    ...(header || height
      ? {
        tableRowStyle: {
          ...(header ? { tableHeader: true } : {}),
          ...(height ? { minRowHeight: structuredClone(height) } : {}),
        },
      }
      : {}),
  };
  rows.splice(below ? rowIndex + 1 : rowIndex, 0, row);
  place.table.tableRows = rows;
}

function insertTableColumn(
  tab: GoogleDocsTab, location: TableCellLocation, right: boolean, options: ModelOptions,
): void {
  let { place, rows, columnIndex } = namedCell(tab, location, "insertTableColumn");
  let at = right ? columnIndex + 1 : columnIndex;
  for (let row of rows) {
    let cells = row.tableCells ?? [];
    let reference = cells[columnIndex];
    if (!reference) notModelled("insertTableColumn on a table whose rows differ in length");
    // A new column copies no chip, but the cells' styles, as probe S2 saw.
    cells.splice(at, 0, withCopiedStyle(cellOf(newCellParagraph(reference, options)), reference));
    row.tableCells = cells;
  }
  // The new column takes the width of the column it copies. Beside one that shares the page's
  // width, Google may narrow the fixed columns, as probe S2c saw.
  let properties = place.table.tableStyle?.tableColumnProperties;
  if (!properties) return;
  let copied = structuredClone(properties[columnIndex]);
  if (copied?.widthType !== "FIXED_WIDTH") {
    for (let column of properties) {
      if (column.widthType === "FIXED_WIDTH") column.width = { magnitude: NARROWED_WIDTH, unit: "PT" };
    }
  }
  properties.splice(at, 0, copied ?? { widthType: "EVENLY_DISTRIBUTED" });
}

/** `cell` with the style of the cell it copies, as Google copies it into a row or column. */
function withCopiedStyle(cell: TableCell, reference: TableCell): TableCell {
  return reference.tableCellStyle
    ? { ...cell, tableCellStyle: { ...structuredClone(reference.tableCellStyle), rowSpan: 1, columnSpan: 1 } }
    : cell;
}

function deleteTableRow(tab: GoogleDocsTab, location: TableCellLocation): void {
  let { place, rows, rowIndex } = namedCell(tab, location, "deleteTableRow");
  rows.splice(rowIndex, 1);
  // A table that loses its last row is gone, and the paragraphs around it stay.
  if (rows.length === 0) place.container.splice(place.position, 1);
  renumberFootnotes(tab);
}

function deleteTableColumn(tab: GoogleDocsTab, location: TableCellLocation): void {
  let { place, rows, columnIndex } = namedCell(tab, location, "deleteTableColumn");
  for (let row of rows) {
    if ((row.tableCells?.length ?? 0) <= columnIndex) {
      notModelled("deleteTableColumn on a table whose rows differ in length");
    }
    row.tableCells?.splice(columnIndex, 1);
  }
  place.table.tableStyle?.tableColumnProperties?.splice(columnIndex, 1);
  // A table that loses its last column is gone, and the paragraphs around it stay.
  if (rows.every(row => !row.tableCells?.length)) place.container.splice(place.position, 1);
  renumberFootnotes(tab);
}

function pinTableHeaderRows(
  tab: GoogleDocsTab,
  { tableStartLocation, pinnedHeaderRowsCount: count }: {
    tableStartLocation: DocsLocation; pinnedHeaderRowsCount: number;
  },
): void {
  requireTab(tab, tableStartLocation);
  let place = tableAt(tab.body.content, tableStartLocation.index);
  if (!place) throw new Error(INVALID_TABLE_START);
  let rows = place.table.tableRows ?? [];
  if (!Number.isInteger(count) || count < 0 || count > rows.length) {
    notModelled(`pinTableHeaderRows of ${count} rows in a table of ${rows.length}`);
  }
  for (let [index, row] of rows.entries()) {
    if (index < count) row.tableRowStyle = { ...row.tableRowStyle, tableHeader: true };
    else if (row.tableRowStyle) delete row.tableRowStyle.tableHeader;
  }
}

/**
 * Set the width of columns, as probe R5 saw: the others keep theirs, an empty list names every
 * column, and a fixed width under 5pt is refused.
 */
function updateTableColumnProperties(
  tab: GoogleDocsTab,
  { tableStartLocation, columnIndices, tableColumnProperties, fields }: Extract<
    GoogleDocsRequest, { updateTableColumnProperties: unknown }
  >["updateTableColumnProperties"],
): void {
  requireTab(tab, tableStartLocation);
  let place = tableAt(tab.body.content, tableStartLocation.index);
  if (!place) throw new Error(INVALID_TABLE_START);
  if (fields !== "widthType,width" && fields !== "widthType") notModelled(`fields ${fields}`);
  let columns = place.table.tableRows?.[0]?.tableCells?.length ?? 0;
  let { widthType, width } = tableColumnProperties;
  if (widthType === "FIXED_WIDTH" && !width) {
    throw new Error("Width value must be provided when updating column width to fixed width.");
  }
  if (widthType === "FIXED_WIDTH" && width!.magnitude < 5) {
    throw new Error("Column width must not be less than minimum column width: 5.");
  }
  let style = place.table.tableStyle ??= {};
  let properties = style.tableColumnProperties ??=
    Array.from({ length: columns }, () => ({ widthType: "EVENLY_DISTRIBUTED" }));
  for (let column of columnIndices.length === 0 ? properties.keys() : columnIndices) {
    if (column >= columns) notModelled(`a column index ${column} past the table`);
    properties[column] = widthType === "FIXED_WIDTH"
      ? { widthType, width: structuredClone(width) }
      : { widthType };
  }
}
