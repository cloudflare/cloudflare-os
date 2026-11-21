// Probes of a tab's JSON for looks the Markdown does not show and for its tables' cells.

import type {
  GoogleDocsTab, Paragraph, ParagraphElement, StructuralElement,
} from "../src/docs-api";
import { LINK_COLOR } from "../src/docs-model";
import type { ModelParagraphStyle, ModelTextStyle } from "../src/docs-model";

type ParagraphBlock = StructuralElement & { paragraph: Paragraph };

/** Every element of `content` in document order, those of table cells included. */
function* blocks(content: readonly StructuralElement[]): Generator<StructuralElement> {
  for (let element of content) {
    yield element;
    for (let row of element.table?.tableRows ?? []) {
      for (let cell of row.tableCells ?? []) yield* blocks(cell.content ?? []);
    }
  }
}

function isParagraph(element: StructuralElement): element is ParagraphBlock {
  return element.paragraph !== undefined;
}

/** The paragraph, of the body or of a cell, that holds `index`. */
function paragraphAt(tab: GoogleDocsTab, index: number): Paragraph | undefined {
  for (let element of blocks(tab.body.content)) {
    if (isParagraph(element) && element.startIndex <= index && index < element.endIndex) {
      return element.paragraph;
    }
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

/** The text style of the element that holds `index`. */
function styleAt(tab: GoogleDocsTab, index: number): ModelTextStyle | undefined {
  let element = paragraphAt(tab, index)?.elements.find(candidate =>
    candidate.startIndex <= index && index < candidate.endIndex);
  return element && elementTextStyle(element);
}

/** The start indexes of the paragraphs, body and cells, that carry a non-zero indent. */
export function indentedParagraphs(tab: GoogleDocsTab): number[] {
  let indented: number[] = [];
  for (let element of blocks(tab.body.content)) {
    if (!isParagraph(element)) continue;
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
  let color = style?.foregroundColor?.color.rgbColor;
  let link = LINK_COLOR.color.rgbColor;
  return style?.underline === true || !!color && Object.keys(color).length === 3 &&
    color.red === link.red && color.green === link.green && color.blue === link.blue;
}

/** The font size, in points, that the character at `index` carries itself, if any. */
export function fontSizeAt(tab: GoogleDocsTab, index: number): number | undefined {
  return styleAt(tab, index)?.fontSize?.magnitude;
}

/** The alignment the paragraph that holds `index` sets itself, if any. */
export function alignmentAt(tab: GoogleDocsTab, index: number): string | undefined {
  let style: ModelParagraphStyle | undefined = paragraphAt(tab, index)?.paragraphStyle;
  return style?.alignment;
}

/** How many rows, from the first, the table that starts at `tableStart` pins as its header. */
export function pinnedHeaderRows(tab: GoogleDocsTab, tableStart: number): number {
  let rows: { tableRowStyle?: { tableHeader?: boolean } }[] | undefined;
  for (let element of blocks(tab.body.content)) {
    if (element.table && element.startIndex === tableStart) rows = element.table.tableRows ?? [];
  }
  if (!rows) throw new Error(`No table starts at index ${tableStart}`);
  let pinned = 0;
  while (rows[pinned]?.tableRowStyle?.tableHeader === true) pinned++;
  return pinned;
}

/** The `table`-th table of the tab's body, as its structural element. Throws when there is none. */
export function tableElement(tab: GoogleDocsTab, table = 0): StructuralElement {
  let element = tab.body.content.filter(block => block.table !== undefined)[table];
  if (!element) throw new Error("Expected a table");
  return element;
}

/** The cell texts of the tab's `table`-th table, row by row: each cell's paragraphs joined. */
export function tableTexts(tab: GoogleDocsTab, table = 0): string[][] {
  return (tableElement(tab, table).table?.tableRows ?? []).map(row =>
    (row.tableCells ?? []).map(cell => (cell.content ?? []).map(element =>
      (element.paragraph?.elements ?? []).map(part => part.textRun?.content ?? "").join(""))
      .join("")));
}
