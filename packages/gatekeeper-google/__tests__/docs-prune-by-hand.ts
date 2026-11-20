// A second pruning of a Google Doc's tab, written helper by helper and independent of the table
// `pruneTab` reads (`../src/docs-replica`). The tests of `docs-replica.test.ts` compare `pruneTab`
// with it; it goes when no test compares with it.
//
// Every helper builds the objects and arrays it returns: a field `kept` copies is a primitive,
// and an array is mapped or spread.

import type {
  Dimension, DocList, GoogleDocsTab, NamedStyles, OptionalColor, Paragraph, ParagraphElement,
  StructuralElement, Table, TableCell, TableCellBorder, TableCellStyle, TableRow, TextStyle,
} from "../src/docs-api";
import type { ModelParagraphStyle, ModelTextStyle } from "../src/docs-model";

/** `source` with only the fields `keys` name, those it has. */
function kept<T extends object, K extends keyof T>(source: T, keys: readonly K[]): Pick<T, K> {
  let out = {} as Pick<T, K>;
  for (let key of keys) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

/** `{ [key]: prune(value) }`, or nothing for a value that is not there. */
function optional<K extends string, V, P>(
  key: K, value: V | undefined, prune: (value: V) => P,
): { [key in K]?: P } {
  return value === undefined ? {} : { [key]: prune(value) } as { [key in K]?: P };
}

/** The indexes of a part, with a start index only where Google sent one. */
function prunedIndexes<T extends { startIndex: number; endIndex: number }>(
  part: T,
): { startIndex: number; endIndex: number } {
  return kept(part, ["startIndex", "endIndex"]);
}

function prunedDimension(dimension: Dimension): Dimension {
  return kept(dimension, ["magnitude", "unit"]);
}

function prunedColor({ color }: OptionalColor): OptionalColor {
  if (!color) return {};
  return { color: optional("rgbColor", color.rgbColor, rgb => kept(rgb, ["red", "green", "blue"])) };
}

/** A link's target, under whichever of Google's names it came. */
type LinkTarget = {
  url?: string; tabId?: string; bookmarkId?: string; headingId?: string;
  bookmark?: { id?: string; tabId?: string }; heading?: { id?: string; tabId?: string };
};

function prunedLink(link: LinkTarget): LinkTarget {
  return {
    ...kept(link, ["url", "tabId", "bookmarkId", "headingId"]),
    ...optional("bookmark", link.bookmark, bookmark => kept(bookmark, ["id", "tabId"])),
    ...optional("heading", link.heading, heading => kept(heading, ["id", "tabId"])),
  };
}

function prunedTextStyle(style: ModelTextStyle): ModelTextStyle {
  return {
    ...kept(style, ["bold", "italic", "strikethrough", "underline"]),
    ...optional("link", style.link, prunedLink),
    ...optional("foregroundColor", style.foregroundColor, prunedColor),
    ...optional("fontSize", style.fontSize, prunedDimension),
  } as ModelTextStyle;
}

/** The text style of an element that is not a text run, when it has one. */
function textStyle(of: { textStyle?: TextStyle }): { textStyle?: ModelTextStyle } {
  return optional("textStyle", of.textStyle, prunedTextStyle);
}

function prunedElement(element: ParagraphElement): ParagraphElement {
  let {
    textRun, autoText, horizontalRule, pageBreak, columnBreak, footnoteReference, equation,
    inlineObjectElement, person, richLink, dateElement, dropdown,
  } = element;
  let pruned: ParagraphElement = prunedIndexes(element);
  if (textRun) {
    pruned.textRun = { content: textRun.content, textStyle: prunedTextStyle(textRun.textStyle ?? {}) };
  }
  if (autoText) pruned.autoText = { ...kept(autoText, ["type"]), ...textStyle(autoText) };
  if (horizontalRule) pruned.horizontalRule = {};
  if (pageBreak) pruned.pageBreak = textStyle(pageBreak);
  if (columnBreak) pruned.columnBreak = textStyle(columnBreak);
  if (footnoteReference) {
    pruned.footnoteReference = {
      ...kept(footnoteReference, ["footnoteId", "footnoteNumber"]), ...textStyle(footnoteReference),
    };
  }
  if (equation) pruned.equation = {};
  if (inlineObjectElement) {
    pruned.inlineObjectElement = {
      ...kept(inlineObjectElement, ["inlineObjectId"]), ...textStyle(inlineObjectElement),
    };
  }
  if (person) {
    pruned.person = {
      ...textStyle(person),
      ...optional("personProperties", person.personProperties,
        properties => kept(properties, ["name", "email"])),
    };
  }
  if (richLink) {
    pruned.richLink = {
      ...textStyle(richLink),
      ...optional("richLinkProperties", richLink.richLinkProperties,
        properties => kept(properties, ["title", "uri"])),
    };
  }
  if (dateElement) {
    pruned.dateElement = {
      ...textStyle(dateElement),
      ...optional("dateElementProperties", dateElement.dateElementProperties,
        properties => kept(properties, ["displayText"])),
    };
  }
  if (dropdown) {
    pruned.dropdown = {
      ...kept(dropdown, ["dropdownId"]),
      ...textStyle(dropdown),
      ...optional("dropdownProperties", dropdown.dropdownProperties, properties =>
        kept(properties, ["dropdownDefinitionId", "selectedOptionId", "displayValue"])),
    };
  }
  return pruned;
}

function prunedParagraph(paragraph: Paragraph): Paragraph {
  let style: ModelParagraphStyle = paragraph.paragraphStyle;
  return {
    elements: paragraph.elements.map(prunedElement),
    paragraphStyle: {
      ...kept(style, ["namedStyleType", "headingId", "alignment"]),
      ...optional("indentStart", style.indentStart, prunedDimension),
      ...optional("indentFirstLine", style.indentFirstLine, prunedDimension),
    } as ModelParagraphStyle,
    ...optional("bullet", paragraph.bullet, bullet => kept(bullet, ["listId", "nestingLevel"])),
    ...optional("positionedObjectIds", paragraph.positionedObjectIds, ids => [...ids]),
  };
}

/** The ids of the suggestions that would insert or delete a table, a row or a cell. */
function prunedSuggestions(
  part: { suggestedInsertionIds?: string[]; suggestedDeletionIds?: string[] },
): { suggestedInsertionIds?: string[]; suggestedDeletionIds?: string[] } {
  return {
    ...optional("suggestedInsertionIds", part.suggestedInsertionIds, ids => [...ids]),
    ...optional("suggestedDeletionIds", part.suggestedDeletionIds, ids => [...ids]),
  };
}

function prunedBorder(border: TableCellBorder): TableCellBorder {
  return {
    ...optional("color", border.color, prunedColor),
    ...optional("width", border.width, prunedDimension),
    ...kept(border, ["dashStyle"]),
  };
}

function prunedCellStyle(style: TableCellStyle): TableCellStyle {
  return {
    ...kept(style, ["rowSpan", "columnSpan", "contentAlignment"]),
    ...optional("backgroundColor", style.backgroundColor, prunedColor),
    ...optional("paddingTop", style.paddingTop, prunedDimension),
    ...optional("paddingRight", style.paddingRight, prunedDimension),
    ...optional("paddingBottom", style.paddingBottom, prunedDimension),
    ...optional("paddingLeft", style.paddingLeft, prunedDimension),
    ...optional("borderTop", style.borderTop, prunedBorder),
    ...optional("borderRight", style.borderRight, prunedBorder),
    ...optional("borderBottom", style.borderBottom, prunedBorder),
    ...optional("borderLeft", style.borderLeft, prunedBorder),
  };
}

function prunedCell(cell: TableCell): TableCell {
  return {
    ...prunedIndexes(cell),
    ...optional("content", cell.content, prunedContent),
    ...optional("tableCellStyle", cell.tableCellStyle, prunedCellStyle),
    ...prunedSuggestions(cell),
  };
}

function prunedRow(row: TableRow): TableRow {
  return {
    ...prunedIndexes(row),
    ...optional("tableCells", row.tableCells, cells => cells.map(prunedCell)),
    ...optional("tableRowStyle", row.tableRowStyle, style => ({
      ...kept(style, ["tableHeader"]),
      ...optional("minRowHeight", style.minRowHeight, prunedDimension),
    })),
    ...prunedSuggestions(row),
  };
}

function prunedTable(table: Table): Table {
  return {
    ...optional("tableRows", table.tableRows, rows => rows.map(prunedRow)),
    ...optional("tableStyle", table.tableStyle, style => optional(
      "tableColumnProperties", style.tableColumnProperties, columns => columns.map(column => ({
        ...kept(column, ["widthType"]), ...optional("width", column.width, prunedDimension),
      })))),
    ...prunedSuggestions(table),
  };
}

function prunedContent(content: readonly StructuralElement[]): StructuralElement[] {
  return content.map(element => ({
    ...prunedIndexes(element),
    ...optional("paragraph", element.paragraph, prunedParagraph),
    ...optional("table", element.table, prunedTable),
    ...optional("sectionBreak", element.sectionBreak, () => ({})),
    ...optional("tableOfContents", element.tableOfContents, () => ({})),
  }));
}

function prunedList(list: DocList): DocList {
  return {
    listProperties: {
      nestingLevels: (list.listProperties?.nestingLevels ?? []).map(level =>
        kept(level, ["glyphType", "glyphSymbol", "startNumber"])),
    },
  };
}

function prunedNamedStyles(named: NamedStyles): NamedStyles {
  return optional("styles", named.styles, styles => styles.map(style => ({
    ...kept(style, ["namedStyleType"]),
    ...optional("textStyle", style.textStyle, text => kept(text, ["bold", "italic", "strikethrough"])),
  })));
}

/**
 * A tab pruned by one helper for each kind of part, each naming the fields it keeps: a second
 * way to the result of `pruneTab`, which reads them off one table. The two must write the same
 * JSON for any tab Google can send.
 */
export function pruneTabByHand(tab: GoogleDocsTab): GoogleDocsTab {
  return {
    tabId: tab.tabId,
    title: tab.title,
    ...kept(tab, ["parentTabId"]),
    index: tab.index,
    nestingLevel: tab.nestingLevel,
    body: { content: prunedContent(tab.body.content) },
    lists: Object.fromEntries(
      Object.entries(tab.lists).map(([id, list]) => [id, prunedList(list)])),
    namedRanges: {},
    ...optional("namedStyles", tab.namedStyles, prunedNamedStyles),
  };
}
