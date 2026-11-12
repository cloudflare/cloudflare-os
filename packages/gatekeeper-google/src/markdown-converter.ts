// Bidirectional conversion between Google Docs structure and Markdown,
// with source mapping to allow Markdown-level edits to be translated back
// to Google Docs batchUpdate operations.

import type {
  GoogleDocsRequest, GoogleDocsTab, Paragraph, ParagraphElement, StructuralElement, Table,
  TableCell, TableRow, TextStyle,
} from "./docs-api";
import { lookOfTable, renderLook } from "./docs-table-look";

// ---------------------------------------------------------------------------
// Source map types
// ---------------------------------------------------------------------------

/**
 * The Markdown rendering of one document tab, with the map back to that tab's indices.
 *
 * Every tab body has its own index space, so a snapshot is only ever valid for the tab it was
 * built from — Markdown, source map and end index all restart per tab.
 */
export type DocTabSnapshot = {
  /** The tab this rendering came from; every write derived from it must carry this ID. */
  tabId: string;
  /** Tab name, as shown in the Docs tab list. */
  title: string;
  /** The containing tab, absent for a top-level tab. */
  parentTabId?: string;
  /** Position among the tabs sharing this parent. */
  index: number;
  /** Depth in the tab tree; 0 for a top-level tab. */
  nestingLevel: number;
  /** The Markdown rendering of this tab's content. */
  markdown: string;
  /** Maps Markdown positions back to this tab's Google Docs character indices. */
  sourceMap: SourceMap;
  /** The endIndex of the last structural element in this tab's body. */
  bodyEndIndex: number;
  /** What the tab's named styles give text, or `null` where the tab came without them. */
  namedFormatting: NamedFormatting | null;
}

/**
 * The bold, italic and strikethrough each named style gives the text of its paragraphs, resolved
 * over normal text's, keyed by `namedStyleType`; a style that gives none is left out. Google
 * stores a style written to text as inherited where the paragraph's named style already gives it,
 * and a read shows only what text sets itself.
 */
export type NamedFormatting = Record<string, InheritedFormat>;

/** The styles a named style gives text. */
export type InheritedFormat = { bold?: true; italic?: true; strikethrough?: true };

const INHERITED_FIELDS = ["bold", "italic", "strikethrough"] as const;

function namedFormattingOf(namedStyles: GoogleDocsTab["namedStyles"]): NamedFormatting | null {
  if (!namedStyles?.styles) return null;
  let normal = namedStyles.styles.find(style => style.namedStyleType === "NORMAL_TEXT")?.textStyle;
  let formatting: NamedFormatting = {};
  for (let { namedStyleType, textStyle } of namedStyles.styles) {
    if (!namedStyleType) continue;
    let format: InheritedFormat = {};
    for (let field of INHERITED_FIELDS) {
      if ((textStyle?.[field] ?? normal?.[field]) === true) format[field] = true;
    }
    if (Object.keys(format).length > 0) formatting[namedStyleType] = format;
  }
  return formatting;
}

export type SourceMap = {
  /** One entry per editable paragraph/heading/list item, in document order. */
  blocks: BlockMapping[];
  /** Rendered structural content that `replaceText()` must not modify or cross. */
  protectedRanges: MarkdownRange[];
  /** One entry per top-level table, in document order. */
  tables: TableMapping[];
}

/** A half-open range in the rendered Markdown string. */
export type MarkdownRange = { mdStart: number; mdEnd: number };

/**
 * A table in a rendering: where its HTML is, from `<table>` through `</table>`, and which text
 * in its cells can be edited.
 */
export type EditableTable = MarkdownRange & {
  /**
   * One array per row, holding for each of its cells in order (cells covered by a merge
   * included): 128 times the number of the cell's editable texts, plus the cell's flags (1 when
   * it holds an item of a list that numbers any of its levels, 2 when it holds a footnote, 4
   * when it starts with anything but a paragraph of normal text outside a list, 8 when it is one
   * paragraph that holds a smart chip, or another element that is neither text nor an inline
   * image, and no text beside it, 16 when it holds an element the rendering shows nothing for,
   * and 32, 64 or both for what Google copies of its chips into a row added beside it); then a start and an end for each text: the HTML between the tags of a
   * paragraph whose text can be edited, as a half-open range counted from the first character
   * of the cell's first line.
   */
  rows: number[][];
  /**
   * Set when the table, a row of it or a cell of it is a suggested insertion or suggested for
   * deletion, or a table inside one of its cells holds such a suggestion.
   */
  suggested?: true;
};

/** A table of a tab, with its place in the tab's index space. */
export type TableMapping = EditableTable & {
  /** The table's range in Google Docs index space [docStart, docEnd). */
  docStart: number;
  docEnd: number;
  /**
   * One array per row: the row's start index, then for each of its cells the cell's length in
   * the index space, followed by, for each of the cell's editable texts, how far the paragraph
   * holding it starts after the cell's own start.
   */
  docRows: number[][];
  /** How many rows, from the first, the table pins as its header; absent when it pins none. */
  pinnedRows?: number;
};

/** What a table's map says of one cell. */
export type TableCellEntry = {
  /** The cell's editable texts, as half-open ranges counted from the cell's first line. */
  texts: [number, number][];
  /** Whether the cell holds an item of a list that numbers any of its levels. */
  numbered: boolean;
  /** Whether the cell holds a footnote reference. */
  footnote: boolean;
  /**
   * Whether the cell starts with anything but a paragraph of normal text outside a list: a
   * heading, a title, a subtitle, a list item, or no paragraph at all. A cell added beside it
   * is reset to a plain paragraph; beside any other cell it keeps the look Google copies.
   */
  styled: boolean;
  /**
   * Whether the cell is one paragraph that holds a smart chip, or another element that is
   * neither text nor an inline image, and no text beside it. Google Docs copies a chip that
   * stands alone in a cell into a row added beside the cell.
   */
  loneChip: boolean;
  /**
   * What Google Docs is seen copying into a row added beside a cell of chips and no text: a
   * dropdown of the same choices for a dropdown, the placeholder character (one index each) for
   * one person chip, date chip, rich link or placeholder, and nothing for several. Absent for
   * every other cell, and for chips in a shape nobody has seen copied.
   */
  copies?: "dropdown" | "placeholder" | "nothing";
  /**
   * Whether the cell holds an element the rendering shows nothing for: a dropdown, or a smart
   * chip that has no text of its own. A cell that holds nothing else reads as an empty cell.
   */
  unshown: boolean;
};

// The packing of `EditableTable.rows` and `TableMapping.docRows`, which only the three functions
// below and the renderer know. A cell's first number in `rows` holds its flags in the low seven
// bits and the number of its texts above them.
const CELL_NUMBERED = 1;
const CELL_FOOTNOTE = 2;
const CELL_STYLED = 4;
const CELL_LONE_CHIP = 8;
const CELL_UNSHOWN = 16;
const CELL_COPIES_DROPDOWN = 32;
const CELL_COPIES_PLACEHOLDER = 64;
const CELL_TEXT = 128;

/** A cell's `copies`, which its two bits hold: both set for "nothing". */
function copiesOf(head: number): Pick<TableCellEntry, "copies"> {
  let dropdown = (head & CELL_COPIES_DROPDOWN) !== 0;
  let placeholder = (head & CELL_COPIES_PLACEHOLDER) !== 0;
  return dropdown && placeholder ? { copies: "nothing" } : dropdown ? { copies: "dropdown" }
    : placeholder ? { copies: "placeholder" } : {};
}

/** The cells of one row of a table's map. */
export function tableRowCells(table: EditableTable, row: number): TableCellEntry[] {
  let packed = table.rows[row];
  let cells: TableCellEntry[] = [];
  for (let index = 0; index < packed.length;) {
    let head = packed[index++];
    let texts: [number, number][] = [];
    for (let count = Math.floor(head / CELL_TEXT); count > 0; count--) {
      texts.push([packed[index++], packed[index++]]);
    }
    cells.push({
      texts,
      numbered: (head & CELL_NUMBERED) !== 0,
      footnote: (head & CELL_FOOTNOTE) !== 0,
      styled: (head & CELL_STYLED) !== 0,
      loneChip: (head & CELL_LONE_CHIP) !== 0,
      ...copiesOf(head),
      unshown: (head & CELL_UNSHOWN) !== 0,
    });
  }
  return cells;
}

/**
 * One row of an `EditableTable`, from its cells. The array is built by `push`, which keeps it
 * dense: a snapshot stores a dense array of small numbers at about half the size of the same
 * numbers in an array assembled by `flatMap`.
 */
export function packTableRow(cells: readonly TableCellEntry[]): number[] {
  let packed: number[] = [];
  for (let cell of cells) {
    packed.push(CELL_TEXT * cell.texts.length + (cell.numbered ? CELL_NUMBERED : 0) +
      (cell.footnote ? CELL_FOOTNOTE : 0) + (cell.styled ? CELL_STYLED : 0) +
      (cell.loneChip ? CELL_LONE_CHIP : 0) + (cell.unshown ? CELL_UNSHOWN : 0) +
      (cell.copies === "dropdown" || cell.copies === "nothing" ? CELL_COPIES_DROPDOWN : 0) +
      (cell.copies === "placeholder" || cell.copies === "nothing" ? CELL_COPIES_PLACEHOLDER : 0));
    for (let [start, end] of cell.texts) packed.push(start, end);
  }
  return packed;
}

/** Where one row and its cells are in the tab's index space. */
export function tableRowIndexes(table: TableMapping, row: number): {
  docStart: number;
  docEnd: number;
  /** `paragraphs[i]` is the start index of the paragraph the cell's i-th editable text is in. */
  cells: { docStart: number; docEnd: number; paragraphs: number[] }[];
} {
  let packed = table.rows[row];
  let docRow = table.docRows[row];
  let cells: { docStart: number; docEnd: number; paragraphs: number[] }[] = [];
  // A cell starts where the one before it ends, the first one index after the row's start.
  let cellStart = docRow[0] + 1;
  let next = 1;
  for (let index = 0; index < packed.length;) {
    let texts = Math.floor(packed[index] / CELL_TEXT);
    index += 1 + 2 * texts;
    let cellEnd = cellStart + docRow[next++];
    let paragraphs: number[] = [];
    for (let text = 0; text < texts; text++) paragraphs.push(cellStart + docRow[next++]);
    cells.push({ docStart: cellStart, docEnd: cellEnd, paragraphs });
    cellStart = cellEnd;
  }
  return { docStart: docRow[0], docEnd: cellStart, cells };
}

/**
 * Version of this module's rendering. Bump it whenever the Markdown or source map this module
 * produces changes, so callers caching a {@link DocTabSnapshot} discard entries built by older
 * code. It lives here because edits to this file are what invalidate them. A bump also has to
 * decide which earlier versions {@link REPLAYABLE_TEXT_EDIT_VERSIONS} keeps.
 */
export const MARKDOWN_RENDERING_VERSION = 7;

/**
 * Earlier rendering versions whose text edits (a replacement outside tables, an append) still
 * replay under {@link MARKDOWN_RENDERING_VERSION}: they render everything outside tables as it
 * does, but a subtitle whose named style is not italic, which 6 read as italic (an edit quoting
 * one no longer finds its text, and says so), and could queue no edit inside one. Decide this
 * list again with every bump.
 */
export const REPLAYABLE_TEXT_EDIT_VERSIONS: readonly number[] = [6];

type ListType = "bullet" | "numbered";

export type BlockMapping = {
  /** Range in the Markdown string [mdStart, mdEnd). */
  mdStart: number;
  mdEnd: number;
  /** Range in Google Docs index space [docStart, docEnd). */
  docStart: number;
  docEnd: number;
  /** Paragraph structure needed to preserve inline-only edits. */
  namedStyleType: string;
  listType: ListType | null;
  listNestingLevel: number;
  /** Provider list identity, used only when the whole list can be preserved in place. */
  listId?: string;
  /** Set when a positioned object is anchored to this paragraph. */
  positioned?: true;
  /** Fine-grained segments within this block. */
  segments: Segment[];
}

/**
 * A segment maps a range of Markdown characters to Google Docs characters.
 * Content segments have a 1:1 character mapping (since we emit the raw text
 * from the doc). Syntax-only segments represent Markdown syntax characters
 * (like "**", "# ", "- ") that don't exist in the doc.
 */
export type Segment =
  | { mdStart: number; mdEnd: number; docStart: number; docEnd: number; textStyle: TextStyle }
  | { mdStart: number; mdEnd: number; syntaxOnly: true };

type ParagraphListItem = {
  listId: string;
  /** How this level renders; null means it has no marker. */
  listType: ListType | null;
  glyphType: string | undefined;
  glyphSymbol: string | undefined;
  nestingLevel: number;
  startNumber: number;
};
type VisibleParagraphElement = {
  text: string;
  style: TextStyle;
  link?: string;
};

// ---------------------------------------------------------------------------
// Google Docs → Markdown
// ---------------------------------------------------------------------------

/**
 * Accumulates the rendered Markdown together with the source-map segments of the block being
 * emitted, so every emit site records its own mapping instead of restating the bookkeeping.
 */
class MarkdownWriter {
  text = "";
  /** Segments of the block being emitted; replaced at every block boundary. */
  segments: Segment[] = [];

  get length(): number {
    return this.text.length;
  }

  /** Start a block, returning the array its segments are collected into. */
  beginBlock(): Segment[] {
    return this.segments = [];
  }

  /** Emit text that belongs to no segment. */
  append(text: string): void {
    this.text += text;
  }

  /** Emit Markdown syntax that has no counterpart in the document. */
  syntax(markdown: string): void {
    let mdStart = this.text.length;
    this.text += markdown;
    this.segments.push({ mdStart, mdEnd: this.text.length, syntaxOnly: true });
  }

  /** Emit text mapping 1:1 onto the document characters starting at `docStart`. */
  mapped(text: string, docStart: number, textStyle: TextStyle): void {
    if (!text) return;
    let mdStart = this.text.length;
    this.text += text;
    this.segments.push({
      mdStart, mdEnd: this.text.length, docStart, docEnd: docStart + text.length, textStyle,
    });
  }
}

/** Convert one document tab to Markdown with a source map into that tab's index space. */
export function docTabToMarkdown(tab: GoogleDocsTab): DocTabSnapshot {
  let writer = new MarkdownWriter();
  let blocks: BlockMapping[] = [];
  let protectedRanges: MarkdownRange[] = [];
  let tables: TableMapping[] = [];
  let previousListId: string | undefined;
  let listNumbers = new Map<string, number[]>();
  let continuedListLevels: boolean[] = [];

  let elements = tab.body.content;
  let bodyEndIndex = elements.length > 0 ? elements[elements.length - 1].endIndex : 0;
  let namedFormatting = namedFormattingOf(tab.namedStyles);
  // Without its named styles, a subtitle is taken to be italic, as Google's older default is.
  let subtitleItalic = namedFormatting ? namedFormatting.SUBTITLE?.italic === true : true;

  for (let elem of elements) {
    let tableMap = elem.table && tableDocMapping(elem, elem.table);
    let structure = elem.table
      ? tableToHtml(elem.table, tab.lists, listNumbers, subtitleItalic, tableMap)
      : elem.tableOfContents ? "[Table of contents]"
      : elem.sectionBreak && elem.startIndex > 0 ? "[Section break]"
      : undefined;
    if (structure !== undefined) {
      let mdStart = writer.length;
      if (writer.length > 0) writer.append("\n");
      if (tableMap) {
        // A table's range is its HTML alone, without the blank line before or the line break after.
        tables.push({
          mdStart: writer.length, mdEnd: writer.length + structure.length, ...tableMap,
        });
      }
      writer.append(`${structure}\n`);
      protectedRanges.push({ mdStart, mdEnd: writer.length });
      previousListId = undefined;
      continue;
    }
    if (!elem.paragraph) continue;

    let para = elem.paragraph;
    let segments = writer.beginBlock();
    let docStart = elem.startIndex;
    let docEnd = elem.endIndex;

    let listItem = paragraphListItem(para, tab.lists);
    let listNumber = nextOrderedListNumber(listItem, listNumbers);
    let continuesList = listItem !== undefined && listItem.listId === previousListId;
    if (!continuesList) continuedListLevels.length = 0;
    let continuesListLevel = false;
    if (listItem) {
      continuedListLevels.length = listItem.nestingLevel + 1;
      continuesListLevel = !!continuedListLevels[listItem.nestingLevel];
      continuedListLevels[listItem.nestingLevel] = true;
    }
    let markdownListNumber = !continuesListLevel && listNumber !== 1 ? listNumber : undefined;

    // Blank line between blocks, except within one provider list.
    // A protected paragraph owns the preceding unmapped boundary.
    let separatorStart = writer.length;
    let previousProtected = protectedRanges.at(-1);
    let abutsProtected = previousProtected?.mdEnd === separatorStart;
    let protectedStart = abutsProtected ? separatorStart : Math.max(0, separatorStart - 1);
    if (writer.length > 0 && !continuesList) {
      writer.append("\n");
      if (previousProtected && abutsProtected) {
        previousProtected.mdEnd = writer.length;
        protectedStart = writer.length;
      }
    }
    let mdStart = writer.length;

    // Paragraph prefix (heading markers, list markers, etc.).
    let prefix = getParagraphPrefix(para, listItem, markdownListNumber);
    if (prefix) writer.syntax(prefix);

    emitParagraphContent(para, writer, subtitleItalic);

    // Trailing newline. Every Google Docs paragraph ends with \n in the doc
    // character space. In Markdown, we use \n as the line terminator.
    // The paragraph's trailing \n is already included in the last text run's
    // content, and we handled it in emitParagraphContent by not emitting it.
    // Instead, we add our own Markdown newline here.
    writer.append("\n");

    let mdEnd = writer.length;
    if (!holdsOnlyText(para)) protectedRanges.push({ mdStart: protectedStart, mdEnd });
    blocks.push({
      mdStart, mdEnd, docStart, docEnd, segments,
      namedStyleType: para.paragraphStyle.namedStyleType,
      listType: listItem?.listType ?? null,
      listNestingLevel: listItem?.nestingLevel ?? 0,
      ...(listItem ? { listId: listItem.listId } : {}),
      ...(para.positionedObjectIds?.length ? { positioned: true as const } : {}),
    });
    previousListId = listItem?.listId;
  }

  return {
    tabId: tab.tabId,
    title: tab.title,
    ...tab.parentTabId === undefined ? {} : { parentTabId: tab.parentTabId },
    index: tab.index,
    nestingLevel: tab.nestingLevel,
    markdown: writer.text,
    sourceMap: { blocks, protectedRanges, tables },
    bodyEndIndex,
    namedFormatting,
  };
}

function internalDocsDestination(kind: "bookmark" | "heading", id: string, tabId?: string): string {
  let tab = tabId ? `?tab=${encodeURIComponent(tabId)}` : "";
  return `${tab}#${kind}=${encodeURIComponent(id)}`;
}

function docsLinkDestination(link: TextStyle["link"]): string | undefined {
  if (!link) return undefined;
  if ("url" in link) return link.url;
  if ("tabId" in link) return `?tab=${encodeURIComponent(link.tabId)}`;
  if ("bookmark" in link) {
    return internalDocsDestination("bookmark", link.bookmark.id, link.bookmark.tabId);
  }
  if ("heading" in link) {
    return internalDocsDestination("heading", link.heading.id, link.heading.tabId);
  }
  if ("bookmarkId" in link) return internalDocsDestination("bookmark", link.bookmarkId);
  return internalDocsDestination("heading", link.headingId);
}

/**
 * The text one paragraph element shows in a tab's Markdown before any formatting: a run's content,
 * a chip's name, title or date, or the placeholder of an element with no text of its own.
 */
export function paragraphElementText(element: ParagraphElement): string | undefined {
  // A run's text needs nothing of its style.
  if (element.textRun) return element.textRun.content;
  return visibleParagraphElement(element)?.text;
}

function visibleParagraphElement(element: ParagraphElement): VisibleParagraphElement | undefined {
  let textRun = element.textRun;
  if (textRun) {
    return {
      text: textRun.content,
      style: textRun.textStyle,
      link: docsLinkDestination(textRun.textStyle.link),
    };
  }

  let person = element.person;
  let personText = person?.personProperties?.name || person?.personProperties?.email;
  if (personText) return { text: personText, style: person?.textStyle ?? {} };

  let richLink = element.richLink;
  let richLinkText = richLink?.richLinkProperties?.title;
  if (richLinkText) {
    return {
      text: richLinkText,
      style: richLink?.textStyle ?? {},
      link: richLink?.richLinkProperties?.uri,
    };
  }

  let dateElement = element.dateElement;
  let dateText = dateElement?.dateElementProperties?.displayText;
  if (dateText) return { text: dateText, style: dateElement?.textStyle ?? {} };

  let autoText = element.autoText;
  if (autoText) {
    let text: string;
    switch (autoText.type) {
      case "PAGE_NUMBER": text = "[Page number]"; break;
      case "PAGE_COUNT": text = "[Page count]"; break;
      default: text = "[Auto text]";
    }
    return { text, style: autoText.textStyle ?? {} };
  }

  // Elements with no text of their own render as a fixed placeholder.
  if (element.inlineObjectElement) {
    return { text: "[Image]", style: element.inlineObjectElement.textStyle ?? {} };
  }
  if (element.equation) return { text: "[Equation]", style: {} };
  if (element.footnoteReference) {
    let { footnoteNumber, textStyle } = element.footnoteReference;
    return { text: footnoteNumber ? `[${footnoteNumber}]` : "[Footnote]", style: textStyle ?? {} };
  }
  if (element.pageBreak) {
    return { text: "[Page break]", style: element.pageBreak.textStyle ?? {} };
  }
  if (element.columnBreak) {
    return { text: "[Column break]", style: element.columnBreak.textStyle ?? {} };
  }

  return undefined;
}

/**
 * The text one paragraph element renders as, or `undefined` when it renders as nothing. The
 * paragraph's trailing newline is dropped here so both renderings read a paragraph the same way.
 */
function paragraphRun(
  element: ParagraphElement,
  isLast: boolean,
): VisibleParagraphElement | undefined {
  let visible = visibleParagraphElement(element);
  if (!visible) return undefined;
  if (element.textRun && isLast) visible.text = visible.text.replace(/\n$/, "");
  return visible.text ? visible : undefined;
}

function positionedImageText(paragraph: Paragraph): string {
  return "[Image] ".repeat(paragraph.positionedObjectIds?.length ?? 0).trimEnd();
}

/** The character a text run holds in place of embedded content, such as a building block's chip. */
const CHIP_PLACEHOLDER = "\uE907";

/** Whether a paragraph holds nothing but text: no positioned object, image or chip. */
function holdsOnlyText(paragraph: Paragraph): boolean {
  return !paragraph.positionedObjectIds?.length && paragraph.elements.every(element =>
    !!element.textRun && !element.textRun.content.includes(CHIP_PLACEHOLDER));
}

/** An editable text in rendered HTML, and the start index of the paragraph it came from. */
type RenderedText = { start: number; end: number; docStart: number };

/** Rendered HTML with the editable texts in it, as ranges counted from its first character. */
type RenderedHtml = { html: string; texts: readonly RenderedText[] };

const NO_TEXTS: readonly RenderedText[] = [];

function shiftTexts(texts: readonly RenderedText[], offset: number): readonly RenderedText[] {
  return offset === 0 ? texts : texts.map(({ start, end, docStart }) => ({
    start: start + offset, end: end + offset, docStart,
  }));
}

/** What the map records of a table besides where its HTML is; rendering fills its rows. */
type TableDocMapping = Omit<TableMapping, keyof MarkdownRange>;

function isSuggested(
  value: { suggestedInsertionIds?: string[]; suggestedDeletionIds?: string[] },
): boolean {
  return !!(value.suggestedInsertionIds?.length || value.suggestedDeletionIds?.length);
}

/**
 * Whether the table, a row of it or a cell of it is a suggestion, or a table inside one of its
 * cells holds one: deleting the cell discards that suggestion too. The table's own fields count
 * beside those of its rows and cells, since a table that is itself a suggestion may mark only
 * itself.
 */
function holdsSuggestion(table: Table): boolean {
  return isSuggested(table) || !!table.tableRows?.some(row =>
    isSuggested(row) || !!row.tableCells?.some(cell =>
      isSuggested(cell) ||
      !!cell.content?.some(element => !!element.table && holdsSuggestion(element.table))));
}

function tableDocMapping(element: StructuralElement, table: Table): TableDocMapping {
  let rows = table.tableRows ?? [];
  let suggested = holdsSuggestion(table);
  let pinnedRows = 0;
  while (rows[pinnedRows]?.tableRowStyle?.tableHeader === true) pinnedRows++;
  return {
    rows: [],
    ...(suggested ? { suggested: true as const } : {}),
    docStart: element.startIndex,
    docEnd: element.endIndex,
    docRows: [],
    ...(pinnedRows > 0 ? { pinnedRows } : {}),
  };
}

/**
 * Render a table as raw HTML, which Markdown preserves without inventing a header row. A table of
 * the tab body is given `map`, which its rows are recorded in; a table inside a cell is given
 * none, and none of its text is editable.
 */
function tableToHtml(
  table: Table,
  lists: GoogleDocsTab["lists"],
  listNumbers: Map<string, number[]>,
  subtitleItalic: boolean,
  map?: Pick<TableMapping, "rows" | "docRows">,
): string {
  let rows = table.tableRows ?? [];
  let isCovered = map && coveredCellTracker(rows);
  let look = renderLook(lookOfTable(table));
  let lines = [`<table${look.table}>`];
  if (look.colgroup !== undefined) lines.push(`  ${look.colgroup}`);
  for (let [rowIndex, row] of rows.entries()) {
    lines.push(`  <tr${look.rows[rowIndex]}>`);
    let cells = (row.tableCells ?? []).map((cell, column) => tableCellToHtml(
      cell, lists, listNumbers, subtitleItalic, !!isCovered && !isCovered(rowIndex, column, cell),
      look.cells[rowIndex][column]));
    for (let cell of cells) lines.push(cell.html);
    lines.push("  </tr>");
    if (map) recordTableRow(map, row, cells, lists);
  }
  lines.push("</table>");
  return lines.join("\n");
}

/**
 * Track the merged cells of a table. The function returned is called for every cell in row order,
 * and says whether the cell is covered by a merged one: a cell that spans rows or columns covers
 * every other cell its spans reach, below it and to its right. Google puts text sent to a covered
 * cell into the merged cell, whose own text has ordinary indexes.
 */
function coveredCellTracker(
  rows: readonly TableRow[],
): (row: number, column: number, cell: TableCell) => boolean {
  let width = 0;
  for (let row of rows) width = Math.max(width, row.tableCells?.length ?? 0);
  // For each column, the row at which the merged cells seen so far stop covering it.
  let coveredBefore: number[] = [];
  return (row, column, cell) => {
    let rowSpan = cell.tableCellStyle?.rowSpan ?? 1;
    let columnSpan = cell.tableCellStyle?.columnSpan ?? 1;
    if (!(rowSpan > 1 || columnSpan > 1)) return coveredBefore[column] > row;
    let end = Math.min(column + columnSpan, width);
    for (let reached = column; reached < end; reached++) {
      coveredBefore[reached] = Math.max(coveredBefore[reached] ?? 0, row + rowSpan);
    }
    return false;
  };
}

/** Add one rendered row of a top-level table to the table's map. */
function recordTableRow(
  map: Pick<TableMapping, "rows" | "docRows">,
  row: TableRow,
  rendered: readonly RenderedHtml[],
  lists: GoogleDocsTab["lists"],
): void {
  let cells: TableCellEntry[] = [];
  // Built by `push`, as `packTableRow` builds its array: see there.
  let docRow = [row.startIndex];
  (row.tableCells ?? []).forEach((cell, column) => {
    let elements = cell.content ?? [];
    let first = elements[0]?.paragraph;
    let texts: [number, number][] = [];
    docRow.push(cell.endIndex - cell.startIndex);
    for (let text of rendered[column].texts) {
      texts.push([text.start, text.end]);
      docRow.push(text.docStart - cell.startIndex);
    }
    cells.push({
      texts,
      numbered: someCellParagraph(elements, lists, isItemOfNumberingList),
      footnote: someCellParagraph(elements, lists, holdsFootnote),
      // Google copies the style of a cell's first paragraph into a cell added beside it, and the
      // HTML does not say what that style is: a subtitle reads as a `<p>` in italics.
      styled: !first || !!first.bullet || first.paragraphStyle.namedStyleType !== "NORMAL_TEXT",
      loneChip: holdsLoneChip(elements),
      ...copiedChip(elements),
      unshown: someCellParagraph(elements, lists, holdsUnshownElement),
    });
  });
  map.rows.push(packTableRow(cells));
  map.docRows.push(docRow);
}

/** Whether a paragraph of `elements`, the cells of tables among them included, passes `test`. */
function someCellParagraph(
  elements: readonly StructuralElement[],
  lists: GoogleDocsTab["lists"],
  test: (paragraph: Paragraph, lists: GoogleDocsTab["lists"]) => boolean,
): boolean {
  return elements.some(element => element.paragraph
    ? test(element.paragraph, lists)
    : !!element.table?.tableRows?.some(row => !!row.tableCells?.some(cell =>
      someCellParagraph(cell.content ?? [], lists, test))));
}

/**
 * Whether a paragraph is an item of a list that numbers any of its levels, as `paragraphListItem`
 * reads a level. Only such an item can move a number the rendering shows; a bulleted item of the
 * list counts, since it restarts the numbered levels below it.
 */
function isItemOfNumberingList(paragraph: Paragraph, lists: GoogleDocsTab["lists"]): boolean {
  let levels = paragraph.bullet && lists[paragraph.bullet.listId]?.listProperties.nestingLevels;
  return !!levels?.some(({ glyphType }) => glyphType !== undefined && glyphType !== "NONE" &&
    glyphType !== "GLYPH_TYPE_UNSPECIFIED");
}

/** Whether a paragraph holds a footnote reference, which renders as the footnote's number. */
function holdsFootnote(paragraph: Paragraph): boolean {
  return paragraph.elements.some(element => !!element.footnoteReference);
}

/**
 * Whether a cell's content is one paragraph that holds a chip and no text beside it. A chip is
 * any element that is neither text nor an inline image, or the placeholder U+E907 in a text run;
 * white space does not count as text.
 */
function holdsLoneChip(elements: readonly StructuralElement[]): boolean {
  let paragraph = elements.length === 1 ? elements[0].paragraph : undefined;
  if (!paragraph) return false;
  let text = "";
  let chip = false;
  for (let element of paragraph.elements) {
    if (element.textRun) text += element.textRun.content;
    else if (!element.inlineObjectElement) chip = true;
  }
  return (chip || text.includes(CHIP_PLACEHOLDER)) &&
    !/\S/.test(text.replaceAll(CHIP_PLACEHOLDER, ""));
}

/**
 * What Google Docs copies of a cell's lone chips into a row added beside it, where live probes
 * have seen it: a dropdown for a dropdown alone; the placeholder for a placeholder alone, or for a
 * person chip, date chip or rich link, also with spaces after it, which are not copied; nothing
 * for two or more of those chips.
 */
function copiedChip(elements: readonly StructuralElement[]): Pick<TableCellEntry, "copies"> {
  let parts = elements.length === 1 ? elements[0].paragraph?.elements ?? [] : [];
  let text = parts.map(part => part.textRun?.content ?? "").join("");
  let others = parts.filter(part => !part.textRun);
  if (others.length === 0) return text === `${CHIP_PLACEHOLDER}\n` ? { copies: "placeholder" } : {};
  let copiedAsPlaceholder = (part: ParagraphElement) =>
    !!(part.person || part.dateElement || part.richLink);
  if (others.length > 1) {
    return text === "\n" && others.every(copiedAsPlaceholder) ? { copies: "nothing" } : {};
  }
  let [chip] = others;
  if (chip.dropdown) return text === "\n" ? { copies: "dropdown" } : {};
  return copiedAsPlaceholder(chip) && parts[0] === chip && /^ *\n$/.test(text)
    ? { copies: "placeholder" } : {};
}

/**
 * Whether a paragraph holds an element the rendering shows nothing for: a dropdown, or a smart
 * chip that has no text of its own.
 */
function holdsUnshownElement(paragraph: Paragraph): boolean {
  return paragraph.elements.some(element =>
    !element.textRun && !element.horizontalRule && !visibleParagraphElement(element));
}

/**
 * Render one cell, with `lookAttribute` after its spans. Its texts are counted from the first
 * character of its first line, and it lists none unless `editable`: a cell that a merged cell
 * covers and a cell of a table inside another cell are not.
 */
function tableCellToHtml(
  cell: TableCell,
  lists: GoogleDocsTab["lists"],
  listNumbers: Map<string, number[]>,
  subtitleItalic: boolean,
  editable: boolean,
  lookAttribute: string,
): RenderedHtml {
  let style = cell.tableCellStyle;
  let attributes = htmlIntegerAttribute("rowspan", style?.rowSpan) +
    htmlIntegerAttribute("colspan", style?.columnSpan) + lookAttribute;
  let elements = cell.content ?? [];
  // Classify every element once: the list walk below revisits them as it groups nested items.
  let items = elements.map(element =>
    element.paragraph && paragraphListItem(element.paragraph, lists));
  // A cell that holds anything but paragraphs, such as another table, lists no text either.
  editable &&= elements.every(element => element.paragraph);
  let parts: RenderedHtml[] = [];
  for (let index = 0; index < elements.length;) {
    if (items[index]) {
      let list = tableListToHtml(elements, items, index, listNumbers, subtitleItalic, editable);
      parts.push(list);
      index = list.nextIndex;
      continue;
    }
    let part =
      tableCellElementToHtml(elements[index], lists, listNumbers, subtitleItalic, editable);
    if (part !== undefined) parts.push(part);
    index++;
  }
  let content = parts.map(part => part.html).join("\n");
  let texts: RenderedText[] = [];
  let partStart = 0;
  for (let part of parts) {
    for (let text of shiftTexts(part.texts, partStart)) texts.push(text);
    partStart += part.html.length + 1;
  }
  let open = `    <td${attributes}>`;
  if (!content.includes("\n")) {
    return { html: `${open}${content}</td>`, texts: shiftTexts(texts, open.length) };
  }
  return {
    html: `${open}\n${indentHtml(content, 6)}\n    </td>`,
    texts: indentedTexts(content, texts, 6, open.length + 1),
  };
}

/**
 * Where the `texts` of `html` are once `indentHtml` has indented it by `spaces` and `lead`
 * characters stand before it. Every line gains the indentation, so a text moves by it once for
 * its own line and once for each line before.
 */
function indentedTexts(
  html: string,
  texts: readonly RenderedText[],
  spaces: number,
  lead: number,
): RenderedText[] {
  let lines = 1;
  let nextBreak = html.indexOf("\n");
  // Texts are in order, so the line breaks before each offset are counted in one pass.
  let place = (offset: number) => {
    while (nextBreak >= 0 && nextBreak < offset) {
      lines++;
      nextBreak = html.indexOf("\n", nextBreak + 1);
    }
    return lead + offset + spaces * lines;
  };
  return texts.map(({ start, end, docStart }) => ({
    start: place(start), end: place(end), docStart,
  }));
}

/**
 * Render the list starting at `startIndex`, which `items` must classify as a list item. Levels
 * between `level` and the list's own are filled with markerless items so its depth survives.
 */
function tableListToHtml(
  elements: StructuralElement[],
  items: readonly (ParagraphListItem | undefined)[],
  startIndex: number,
  listNumbers: Map<string, number[]>,
  subtitleItalic: boolean,
  editable: boolean,
  level = 0,
): RenderedHtml & { nextIndex: number } {
  let first = items[startIndex]!;
  let tag = first.listType === "numbered" ? "ol" : "ul";
  let html = htmlListOpeningTag(first, nextOrderedListNumber(first, listNumbers));
  let texts: RenderedText[] = [];
  let index = startIndex;

  while (index < elements.length) {
    let item = items[index];
    let paragraph = elements[index].paragraph;
    if (!item || !paragraph || item.listId !== first.listId ||
        item.nestingLevel !== first.nestingLevel || item.listType !== first.listType) break;
    if (index > startIndex) nextOrderedListNumber(item, listNumbers);

    let glyph = item.listType === "bullet" && item.glyphSymbol
      ? `${escapeHtml(item.glyphSymbol)} ` : "";
    let content = tableParagraphContentToHtml(paragraph, subtitleItalic);
    let headingLevel = paragraphHeadingLevel(paragraph);
    // The glyph shows the bullet and is not the item's text, so the text starts after it.
    html += headingLevel ? `<li><h${headingLevel}>${glyph}` : `<li>${glyph}`;
    if (editable && isEditableCellParagraph(paragraph)) {
      texts.push({
        start: html.length, end: html.length + content.length,
        docStart: elements[index].startIndex,
      });
    }
    html += headingLevel ? `${content}</h${headingLevel}>` : content;
    index++;
    while (index < elements.length) {
      let nested = items[index];
      if (!nested || nested.listId !== first.listId ||
          nested.nestingLevel <= first.nestingLevel) break;
      let child = tableListToHtml(
        elements, items, index, listNumbers, subtitleItalic, editable, first.nestingLevel + 1);
      for (let text of shiftTexts(child.texts, html.length)) texts.push(text);
      html += child.html;
      index = child.nextIndex;
    }
    html += "</li>";
  }

  let skipped = first.nestingLevel - level;
  let lead = `${MARKERLESS_LIST}<li>`.repeat(skipped);
  return {
    html: `${lead}${html}</${tag}>` + "</li></ul>".repeat(skipped),
    texts: shiftTexts(texts, lead.length),
    nextIndex: index,
  };
}

function tableCellElementToHtml(
  element: StructuralElement,
  lists: GoogleDocsTab["lists"],
  listNumbers: Map<string, number[]>,
  subtitleItalic: boolean,
  editable: boolean,
): RenderedHtml | undefined {
  if (element.tableOfContents) return { html: "[Table of contents]", texts: NO_TEXTS };
  if (element.table) {
    return { html: tableToHtml(element.table, lists, listNumbers, subtitleItalic), texts: NO_TEXTS };
  }
  if (!element.paragraph) return undefined;
  let paragraph = element.paragraph;
  let content = tableParagraphContentToHtml(paragraph, subtitleItalic);
  if (content === "<hr>") return { html: content, texts: NO_TEXTS };
  let headingLevel = paragraphHeadingLevel(paragraph);
  let tag = headingLevel ? `h${headingLevel}` : "p";
  let start = tag.length + 2;
  return {
    html: `<${tag}>${content}</${tag}>`,
    texts: editable && isEditableCellParagraph(paragraph)
      ? [{ start, end: start + content.length, docStart: element.startIndex }] : NO_TEXTS,
  };
}

/**
 * Whether the text of a cell paragraph can be edited: it holds nothing but text, so its HTML is
 * exactly `cellInlineHtml` of its runs, and it is not a subtitle, whose HTML carries the italic
 * the style gives it.
 */
function isEditableCellParagraph(paragraph: Paragraph): boolean {
  return holdsOnlyText(paragraph) && paragraph.paragraphStyle.namedStyleType !== "SUBTITLE";
}

/**
 * The inline HTML of a cell paragraph. Adjacent elements that render with the same formatting
 * share one element, so the run boundaries Google keeps for styles this rendering does not show
 * (a colour, a font) leave no trace in it.
 */
function tableParagraphContentToHtml(paragraph: Paragraph, subtitleItalic: boolean): string {
  let inheritedItalic = subtitleItalic && paragraph.paragraphStyle.namedStyleType === "SUBTITLE";
  let lastElement = paragraph.elements.at(-1);
  let content = "";
  let italic = false;
  // The runs since the last rule or change of inherited italic, which nothing sets apart yet.
  let runs: CellInlineRun[] = [];
  let flush = () => {
    content += cellInlineHtml(runs);
    runs = [];
  };
  for (let part of paragraph.elements) {
    if (part.horizontalRule) {
      flush();
      content += italic ? "</em><hr>" : "<hr>";
      italic = false;
      continue;
    }
    let visible = paragraphRun(part, part === lastElement);
    if (!visible) continue;
    let nextItalic = inheritedItalic && (visible.style.italic ?? true);
    if (nextItalic !== italic) {
      flush();
      content += nextItalic ? "<em>" : "</em>";
      italic = nextItalic;
    }
    let { text, style, link } = visible;
    runs.push({
      text,
      bold: style.bold,
      // A subtitle's italic is the span around its runs, opened and closed above.
      italic: !inheritedItalic && style.italic,
      strikethrough: style.strikethrough,
      link: link && isSafeTableLink(link) ? link : undefined,
    });
  }
  flush();
  if (italic) content += "</em>";
  let images = positionedImageText(paragraph);
  return images && content ? `${images} ${content}` : images || content;
}

/** Permit inert web links and native Docs destinations in generated table HTML. */
export function isSafeTableLink(link: string): boolean {
  return /^(?:https?:|mailto:)/i.test(link) || parseInternalDocsLink(link) !== undefined;
}

/** One stretch of a cell paragraph's text with the formatting the table HTML shows. */
export type CellInlineRun = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  /** The destination as the HTML shows it, absent for text that is not linked. */
  link?: string;
};

/** The HTML of a cell paragraph's text: adjacent runs formatted alike share one element. */
export function cellInlineHtml(runs: readonly CellInlineRun[]): string {
  let html = "";
  let text = "";
  let format: CellInlineRun | undefined;
  for (let run of runs) {
    if (!run.text) continue;
    if (format && !sameInlineFormat(format, run)) {
      html += formattedTextToHtml(text, format);
      text = "";
    }
    format = run;
    text += run.text;
  }
  return format ? html + formattedTextToHtml(text, format) : html;
}

function sameInlineFormat(left: CellInlineRun, right: CellInlineRun): boolean {
  return !left.bold === !right.bold && !left.italic === !right.italic &&
    !left.strikethrough === !right.strikethrough &&
    (left.link || undefined) === (right.link || undefined);
}

function formattedTextToHtml(text: string, format: CellInlineRun): string {
  let html = escapeHtml(text).replaceAll("\u000b", "<br>");
  if (format.strikethrough) html = `<s>${html}</s>`;
  if (format.italic) html = `<em>${html}</em>`;
  if (format.bold) html = `<strong>${html}</strong>`;
  if (format.link) html = `<a href="${escapeHtmlAttribute(format.link)}">${html}</a>`;
  return html;
}

function htmlListStartAttribute(value: number): string {
  return Number.isInteger(value) && value !== 1 ? ` start="${value}"` : "";
}

function htmlOrderedListType(glyphType: string): string | undefined {
  switch (glyphType) {
    case "ALPHA": return "a";
    case "UPPER_ALPHA": return "A";
    case "ROMAN": return "i";
    case "UPPER_ROMAN": return "I";
    default: return undefined;
  }
}

/** A list with hidden markers, for items whose glyph is written inline or absent. */
const MARKERLESS_LIST = '<ul style="list-style-type: none">';

function htmlListOpeningTag(item: ParagraphListItem, listNumber: number | undefined): string {
  if (item.listType === null) return MARKERLESS_LIST;
  if (item.glyphType === undefined) return item.glyphSymbol ? MARKERLESS_LIST : "<ul>";

  let type = htmlOrderedListType(item.glyphType);
  let typeAttribute = type ? ` type="${type}"` : "";
  let style = item.glyphType === "ZERO_DECIMAL"
    ? ' style="list-style-type: decimal-leading-zero"' : "";
  let startNumber = type && listNumber === 0 ? 1 : listNumber;
  return `<ol${typeAttribute}${style}${htmlListStartAttribute(startNumber ?? 1)}>`;
}

function htmlIntegerAttribute(name: string, value: number | undefined): string {
  return typeof value === "number" && Number.isInteger(value) && value > 1
    ? ` ${name}="${value}"` : "";
}

/**
 * Escape only what changes how the table markup parses. Deliberately narrower than the kit's
 * `escapeHtml()`: this output is read by an agent, so quotes and apostrophes in cell prose stay
 * as typed rather than becoming entities.
 */
export function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Escape text for a double-quoted attribute value of the table markup. */
export function escapeHtmlAttribute(text: string): string {
  return escapeHtml(text).replaceAll('"', "&quot;");
}

function escapeMarkdownText(text: string): string {
  return text.replace(/[\\`*_[\]{}()#+\-.!|>~]/g, "\\$&");
}

function escapeMarkdownLinkDestination(url: string): string {
  return url.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

function indentHtml(text: string, spaces: number): string {
  let prefix = " ".repeat(spaces);
  return prefix + text.replaceAll("\n", `\n${prefix}`);
}

/** Determine the Markdown prefix for a paragraph based on its style. */
function getParagraphPrefix(
  para: Paragraph,
  listItem: ParagraphListItem | undefined,
  listNumber: number | undefined,
): string {
  let prefix = "";
  if (listItem?.listType) {
    let indent = "  ".repeat(listItem.nestingLevel);
    prefix = listItem.listType === "numbered"
      ? `${indent}${listNumber ?? 1}. ` : `${indent}- `;
  }
  let headingLevel = paragraphHeadingLevel(para);
  return prefix + (headingLevel ? `${"#".repeat(headingLevel)} ` : "");
}

function paragraphListItem(
  paragraph: Paragraph,
  lists: GoogleDocsTab["lists"],
): ParagraphListItem | undefined {
  let bullet = paragraph.bullet;
  if (!bullet) return undefined;
  let nestingLevel = bullet.nestingLevel ?? 0;
  let level = lists[bullet.listId]?.listProperties.nestingLevels[nestingLevel];
  // A checklist level reports this placeholder in place of an absent glyph type; it is unordered.
  let glyphType = level?.glyphType === "GLYPH_TYPE_UNSPECIFIED" ? undefined : level?.glyphType;
  let listType: ListType | null = "bullet";
  if (glyphType === "NONE") listType = null;
  else if (glyphType !== undefined) listType = "numbered";
  return {
    listId: bullet.listId,
    listType,
    glyphType,
    glyphSymbol: level?.glyphSymbol,
    nestingLevel,
    startNumber: level?.startNumber ?? 1,
  };
}

function nextOrderedListNumber(
  item: ParagraphListItem | undefined,
  listNumbers: Map<string, number[]>,
): number | undefined {
  if (!item) return undefined;
  let levels = listNumbers.get(item.listId);
  if (!levels) listNumbers.set(item.listId, levels = []);
  levels.length = item.nestingLevel + 1;
  if (item.listType !== "numbered") return undefined;
  let number = (levels[item.nestingLevel] ?? item.startNumber - 1) + 1;
  levels[item.nestingLevel] = number;
  return number;
}

function paragraphHeadingLevel(paragraph: Paragraph): number | undefined {
  switch (paragraph.paragraphStyle.namedStyleType) {
    case "TITLE":
    case "HEADING_1": return 1;
    case "HEADING_2": return 2;
    case "HEADING_3": return 3;
    case "HEADING_4": return 4;
    case "HEADING_5": return 5;
    case "HEADING_6": return 6;
    default: return undefined;
  }
}

type MarkdownFormat = { open: string; close: string };

const STRIKETHROUGH_FORMAT = { open: "~~", close: "~~" };
const BOLD_FORMAT = { open: "**", close: "**" };
const ITALIC_FORMAT = { open: "*", close: "*" };

function markdownFormats(
  style: TextStyle,
  link: string | undefined,
  inheritedItalic: boolean,
): MarkdownFormat[] {
  let formats: MarkdownFormat[] = [];
  if (link) formats.push({ open: "[", close: `](${escapeMarkdownLinkDestination(link)})` });
  if (style.strikethrough) formats.push(STRIKETHROUGH_FORMAT);
  if (style.bold) formats.push(BOLD_FORMAT);
  if (style.italic ?? inheritedItalic) formats.push(ITALIC_FORMAT);
  return formats;
}

function markdownFormatTransition(
  formats: readonly MarkdownFormat[],
  nextFormats: readonly MarkdownFormat[],
): string {
  let shared = 0;
  while (shared < formats.length && shared < nextFormats.length &&
      sameMarkdownFormat(formats[shared], nextFormats[shared])) shared++;

  let markdown = "";
  for (let index = formats.length - 1; index >= shared; index--) markdown += formats[index].close;
  for (let index = shared; index < nextFormats.length; index++) markdown += nextFormats[index].open;
  return markdown;
}

function sameMarkdownFormat(left: MarkdownFormat, right: MarkdownFormat): boolean {
  return left.open === right.open && left.close === right.close;
}
function emitParagraphContent(
  para: Paragraph, writer: MarkdownWriter, subtitleItalic: boolean,
): void {
  let formats: MarkdownFormat[] = [];
  // A subtitle's text is italic unless it says otherwise where its style makes it so.
  let isSubtitle = subtitleItalic && para.paragraphStyle.namedStyleType === "SUBTITLE";
  let lastElement = para.elements.at(-1);
  let images = positionedImageText(para);
  if (images) {
    writer.syntax(images);
    let hasContent = para.elements.some((element, index) =>
      !!element.horizontalRule || !!paragraphRun(element, index === para.elements.length - 1));
    if (hasContent) writer.syntax(" ");
  }

  for (let element of para.elements) {
    if (element.horizontalRule) {
      writer.syntax("<hr>");
      continue;
    }

    let visible = paragraphRun(element, element === lastElement);
    if (!visible) continue;

    let nextFormats = markdownFormats(visible.style, visible.link, isSubtitle);
    let transition = markdownFormatTransition(formats, nextFormats);
    if (transition) writer.syntax(transition);
    formats = nextFormats;

    if (element.textRun) {
      emitMappedTextRun(writer, visible.text, visible.style, element.startIndex, !!visible.link);
    } else {
      writer.syntax(escapeMarkdownText(visible.text));
    }
  }

  let transition = markdownFormatTransition(formats, []);
  if (transition) writer.syntax(transition);
}

/**
 * Emit one text run, escaping the characters that would otherwise close a link label early. The
 * escape is syntax; the character it protects still maps to its document index.
 */
function emitMappedTextRun(
  writer: MarkdownWriter,
  text: string,
  style: TextStyle,
  docStart: number,
  escapeLinkLabel: boolean,
): void {
  let chunkStart = 0;
  if (escapeLinkLabel) {
    for (let index = 0; index < text.length; index++) {
      if (text[index] !== "\\" && text[index] !== "[" && text[index] !== "]") continue;
      writer.mapped(text.slice(chunkStart, index), docStart + chunkStart, style);
      writer.syntax("\\");
      writer.mapped(text[index], docStart + index, style);
      chunkStart = index + 1;
    }
  }
  writer.mapped(text.slice(chunkStart), docStart + chunkStart, style);
}

// ---------------------------------------------------------------------------
// Markdown → Google Docs batchUpdate requests
// ---------------------------------------------------------------------------

/** Parsed representation of a Markdown block. */
type ParsedBlock = {
  /** Plain text content (no Markdown syntax). */
  plainText: string;
  /** Paragraph style: heading level (1-6), or null for normal text. */
  headingLevel: number | null;
  /** If this is a list item: "bullet" or "numbered". */
  listType: ListType | null;
  /** Number written in an ordered-list marker. */
  listNumber: number | null;
  /** Nesting level for list items (0-based). */
  nestingLevel: number;
  /** Inline formatting spans, relative to plainText. */
  spans: FormattingSpan[];
}

type FormattingSpan = {
  start: number;
  end: number;
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  link?: string;
}

/** The most blocks, one for each line, that the Markdown of one write may hold. */
export const MAX_MARKDOWN_BLOCKS = 2_000;
const MAX_MARKDOWN_FORMATTING_TOKENS = 5_000;
// The most requests one replacement can emit within those limits, which `parseMarkdownForWrite`
// enforces on everything it writes.
// A bullet removal, a paragraph style, and a subtitle override or bullet run (subtitles are never
// list items).
const REQUESTS_PER_BLOCK = 3;
// A content deletion, the insert, the style reset, and a deletion of the removed paragraphs after
// it. Each rewritten paragraph pairs with one block, so this is also bounded per block.
const REQUESTS_PER_REWRITTEN_PARAGRAPH = 4;
// A leading deletion, an insert and style reset before the first paragraph, and a bullet removal and
// paragraph style repairing a paragraph merged into the tab's last.
const REQUESTS_PER_REPLACEMENT = 5;
/** The most requests `addRequest` lets one batch hold. */
export const MAX_GOOGLE_DOC_REQUESTS = REQUESTS_PER_REPLACEMENT +
  (REQUESTS_PER_BLOCK + REQUESTS_PER_REWRITTEN_PARAGRAPH) * MAX_MARKDOWN_BLOCKS +
  MAX_MARKDOWN_FORMATTING_TOKENS;

/** Reject Markdown whose structure would consume excessive parser or Docs batch resources. */
export function assertMarkdownWriteComplexity(markdown: string): void {
  let blocks = markdown.length === 0 ? 0 : 1;
  let formattingTokens = 0;
  for (let index = 0; index < markdown.length; index++) {
    let character = markdown[index];
    if (character === "\n") {
      blocks++;
      if (blocks > MAX_MARKDOWN_BLOCKS) {
        throw new Error(`Google Doc action Markdown exceeds the ${MAX_MARKDOWN_BLOCKS}-block complexity limit.`);
      }
      continue;
    }
    if (character === "\\" && markdown[index + 1] &&
      isMarkdownPunctuation(markdown[index + 1])) {
      index++;
      continue;
    }
    if (character === "*") {
      formattingTokens++;
      while (markdown[index + 1] === "*") index++;
    } else if (character === "~" && markdown[index + 1] === "~") {
      formattingTokens++;
      while (markdown[index + 1] === "~") index++;
    } else if (character === "]" && markdown[index + 1] === "(") {
      formattingTokens++;
    }
    if (formattingTokens > MAX_MARKDOWN_FORMATTING_TOKENS) {
      throw new Error(
        `Google Doc action Markdown exceeds the ${MAX_MARKDOWN_FORMATTING_TOKENS}-formatting-token complexity limit.`,
      );
    }
  }
}

/**
 * Parse Markdown into one block per line. Between two lines, each pair of blank lines is an empty
 * paragraph, the inverse of how rendering separates paragraphs; before the first line every blank
 * line is one, and after the last all but the first are.
 */
function parseMarkdown(markdown: string): ParsedBlock[] {
  let blocks: ParsedBlock[] = [];
  let blankLines = 0;
  let pushEmpty = (count: number) => {
    for (let index = 0; index < count; index++) blocks.push(parseLine(""));
  };
  for (let line of markdown.split("\n")) {
    if (line === "") {
      blankLines++;
      continue;
    }
    pushEmpty(blocks.length > 0 ? blankLines >> 1 : blankLines);
    blocks.push(parseLine(line));
    blankLines = 0;
  }
  pushEmpty(blocks.length > 0 ? blankLines - 1 : blankLines);
  return blocks;
}

function parseMarkdownForWrite(markdown: string): ParsedBlock[] {
  assertMarkdownWriteComplexity(markdown);
  let blocks = parseMarkdown(markdown);
  let spanCount = 0;
  for (let block of blocks) {
    spanCount += block.spans.length;
    if (spanCount > MAX_MARKDOWN_FORMATTING_TOKENS) {
      throw new Error(
        `Google Doc action Markdown exceeds the ${MAX_MARKDOWN_FORMATTING_TOKENS}-formatting-span complexity limit.`,
      );
    }
  }
  return blocks;
}

/** Parse a single line of Markdown into a ParsedBlock. */
function parseLine(line: string): ParsedBlock {
  let headingLevel: number | null = null;
  let listType: "bullet" | "numbered" | null = null;
  let nestingLevel = 0;
  let listNumber: number | null = null;
  let content = line;

  let bulletMatch = content.match(/^( *)- /);
  let numberedMatch = content.match(/^( *)(\d+)\. /);
  if (bulletMatch) {
    listType = "bullet";
    nestingLevel = Math.floor(bulletMatch[1].length / 2);
    content = content.slice(bulletMatch[0].length);
  } else if (numberedMatch) {
    listType = "numbered";
    listNumber = Number(numberedMatch[2]);
    nestingLevel = Math.floor(numberedMatch[1].length / 2);
    content = content.slice(numberedMatch[0].length);
  }

  let headingMatch = content.match(/^(#{1,6}) /);
  if (headingMatch) {
    headingLevel = headingMatch[1].length;
    content = content.slice(headingMatch[0].length);
  }

  // Parse inline formatting.
  let { plainText, spans } = parseInlineFormatting(content);

  return { plainText, headingLevel, listType, listNumber, nestingLevel, spans };
}

type MarkdownLinkIndex = {
  nextCloseBracket: Int32Array;
  closeParen: Int32Array;
};

function indexMarkdownLinks(text: string): MarkdownLinkIndex {
  let closes = new Uint8Array(text.length);
  let closeParen = new Int32Array(text.length).fill(-1);
  let openParens: number[] = [];
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "\\" && index + 1 < text.length) {
      index++;
    } else if (text[index] === "]") {
      closes[index] = 1;
    } else if (text[index] === "(") {
      openParens.push(index);
    } else if (text[index] === ")") {
      let open = openParens.pop();
      if (open !== undefined) closeParen[open] = index;
    }
  }

  let nextCloseBracket = new Int32Array(text.length + 1).fill(-1);
  let next = -1;
  for (let index = text.length - 1; index >= 0; index--) {
    if (closes[index]) next = index;
    nextCloseBracket[index] = next;
  }
  return { nextCloseBracket, closeParen };
}

function markdownLinkDestination(text: string, start: number, end: number): string {
  let url = "";
  for (let index = start; index < end; index++) {
    let escaped = text[index + 1];
    if (text[index] === "\\" && (escaped === "\\" || escaped === "(" || escaped === ")")) {
      url += escaped;
      index++;
    } else {
      url += text[index];
    }
  }
  return url;
}

function matchMarkdownLink(
  text: string,
  index: number,
  links: MarkdownLinkIndex,
): { label: string; url: string; end: number } | undefined {
  if (text[index] !== "[") return undefined;
  let closeBracket = links.nextCloseBracket[index + 1];
  if (closeBracket < 0 || text[closeBracket + 1] !== "(") return undefined;
  let end = links.closeParen[closeBracket + 1];
  if (end < 0) return undefined;
  return {
    label: text.slice(index + 1, closeBracket),
    url: markdownLinkDestination(text, closeBracket + 2, end),
    end,
  };
}

function escapeMarkdownLinkLabelText(text: string): string {
  return text.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function isMarkdownPunctuation(character: string): boolean {
  let code = character.charCodeAt(0);
  return code >= 0x21 && code <= 0x2f || code >= 0x3a && code <= 0x40 ||
    code >= 0x5b && code <= 0x60 || code >= 0x7b && code <= 0x7e;
}

function startsMarkdownEscape(markdown: string, index: number): boolean {
  if (index < 0 || markdown[index] !== "\\" ||
      !markdown[index + 1] || !isMarkdownPunctuation(markdown[index + 1])) return false;
  let preceding = 0;
  while (markdown[index - preceding - 1] === "\\") preceding++;
  return preceding % 2 === 0;
}

function assertMarkdownEscapeBoundaries(markdown: string, start: number, end: number): void {
  if (startsMarkdownEscape(markdown, start - 1) || startsMarkdownEscape(markdown, end - 1)) {
    throw new Error(
      "replaceText: Markdown escape syntax cannot be edited partially. " +
      "Include its backslash in oldMarkdown.",
    );
  }
}

function markdownTokenSplits(markdown: string): Uint8Array {
  let links = indexMarkdownLinks(markdown);
  let ranges: MarkdownRange[] = inlineMarkdownRanges(markdown, links);
  for (let index = 0; index < markdown.length;) {
    let link = matchMarkdownLink(markdown, index, links);
    if (!link) {
      index++;
      continue;
    }
    ranges.push({ mdStart: index, mdEnd: link.end + 1 });
    index = link.end + 1;
  }

  let deltas = new Int32Array(markdown.length + 1);
  for (let range of ranges) {
    deltas[range.mdStart + 1]++;
    deltas[range.mdEnd]--;
  }

  let splits = new Uint8Array(markdown.length + 1);
  let activeRanges = 0;
  let backslashes = 0;
  for (let index = 1; index <= markdown.length; index++) {
    activeRanges += deltas[index];
    if (activeRanges > 0) splits[index] = 1;

    backslashes = markdown[index - 1] === "\\" ? backslashes + 1 : 0;
    if (backslashes % 2 === 1 && markdown[index] && isMarkdownPunctuation(markdown[index])) {
      splits[index] = 1;
    }
    if (index < markdown.length && markdown[index - 1] === markdown[index] &&
        (markdown[index] === "*" || markdown[index] === "~")) splits[index] = 1;
  }
  return splits;
}

/**
 * Shared replacement bounds that never split Markdown syntax tokens, or a surrogate pair: two
 * emoji can share their high surrogate, and Google refuses to delete half of a pair.
 */
function markdownReplacementBounds(oldMarkdown: string, newMarkdown: string): {
  prefixLen: number;
  suffixLen: number;
} {
  let oldTokenSplits = markdownTokenSplits(oldMarkdown);
  let newTokenSplits = markdownTokenSplits(newMarkdown);
  let prefixLen = 0;
  while (prefixLen < oldMarkdown.length && prefixLen < newMarkdown.length &&
      oldMarkdown[prefixLen] === newMarkdown[prefixLen]) prefixLen++;
  while (prefixLen > 0 && (oldTokenSplits[prefixLen] || newTokenSplits[prefixLen] ||
      isHighSurrogate(oldMarkdown.charCodeAt(prefixLen - 1)))) prefixLen--;

  let suffixLen = 0;
  while (suffixLen < oldMarkdown.length - prefixLen &&
      suffixLen < newMarkdown.length - prefixLen &&
      oldMarkdown[oldMarkdown.length - suffixLen - 1] ===
        newMarkdown[newMarkdown.length - suffixLen - 1]) suffixLen++;
  while (suffixLen > 0 &&
      (oldTokenSplits[oldMarkdown.length - suffixLen] ||
        newTokenSplits[newMarkdown.length - suffixLen] ||
        isLowSurrogate(oldMarkdown.charCodeAt(oldMarkdown.length - suffixLen)))) suffixLen--;

  return { prefixLen, suffixLen };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function canonicalizeMarkdownFragment(markdown: string): string {
  let start = 0;
  while (markdown[start] === "\n") start++;
  let end = markdown.length;
  while (end > start && markdown[end - 1] === "\n") end--;
  return markdown.slice(0, start) + canonicalizeMarkdownForWrite(markdown.slice(start, end)) +
    markdown.slice(end);
}

function normalizeChangedListOrdinal(
  oldMarkdown: string,
  newMarkdown: string,
  changeStart: number,
): string {
  let oldLineStart = oldMarkdown.lastIndexOf("\n", changeStart - 1) + 1;
  let newLineStart = newMarkdown.lastIndexOf("\n", changeStart - 1) + 1;
  let oldMarker = /^( *)(\d+)\. /.exec(oldMarkdown.slice(oldLineStart));
  let newMarker = /^( *)(\d+)\. /.exec(newMarkdown.slice(newLineStart));
  if (!oldMarker || !newMarker || oldMarker[0] === newMarker[0] || newMarker[2] === "1") {
    return newMarkdown;
  }

  let numberStart = newLineStart + newMarker[1].length;
  return newMarkdown.slice(0, numberStart) + "1" +
    newMarkdown.slice(numberStart + newMarker[2].length);
}

/** Canonicalize changed Markdown while preserving copied document text. */
export function canonicalizeMarkdownReplacement(
  oldMarkdown: string,
  newMarkdown: string,
): string {
  let bounds = markdownReplacementBounds(oldMarkdown, newMarkdown);
  let normalized = normalizeChangedListOrdinal(oldMarkdown, newMarkdown, bounds.prefixLen);
  if (normalized !== newMarkdown) {
    newMarkdown = normalized;
    bounds = markdownReplacementBounds(oldMarkdown, newMarkdown);
  }
  let { prefixLen, suffixLen } = bounds;
  let changed = canonicalizeMarkdownFragment(
    newMarkdown.slice(prefixLen, newMarkdown.length - suffixLen),
  );
  let canonical = oldMarkdown.slice(0, prefixLen) + changed +
    oldMarkdown.slice(oldMarkdown.length - suffixLen);
  return normalizeChangedBlockBoundaries(canonical, prefixLen, prefixLen + changed.length);
}

/**
 * The Markdown a tab reads as once `appended`, already canonical, is written after it as new
 * paragraphs. The text before is kept as it is, whatever syntax it holds: only the line breaks
 * between the two are decided here.
 */
export function canonicalizeMarkdownAppend(markdown: string, appended: string): string {
  let joined = markdown + canonicalizeMarkdownFragment(
    (markdown.endsWith("\n") ? "\n" : "\n\n") + appended + "\n");
  let first = nextLineStart(joined, markdown.length);
  let edit = first === undefined ? undefined : separatorBefore(joined, first);
  return edit ? joined.slice(0, edit.start) + edit.text + joined.slice(edit.end) : joined;
}

const BOLD_STATE = 1;
const ITALIC_STATE = 2;
const STRIKETHROUGH_STATE = 4;
const INLINE_STYLE_STATES = [BOLD_STATE, ITALIC_STATE, STRIKETHROUGH_STATE] as const;

type InlineToken = { start: number; end: number; marker: "asterisk" | "strikethrough" };

function inlineTokens(text: string, links: MarkdownLinkIndex): InlineToken[] {
  let tokens: InlineToken[] = [];
  for (let index = 0; index < text.length;) {
    let escaped = text[index + 1];
    if (text[index] === "\\" && escaped && isMarkdownPunctuation(escaped)) {
      index += 2;
      continue;
    }
    let link = matchMarkdownLink(text, index, links);
    if (link) {
      index = link.end + 1;
      continue;
    }
    if (text.startsWith("~~", index)) {
      let end = index + 2;
      while (text[end] === "~") end++;
      let length = end - index;
      if (length === 2 || length === 4) {
        tokens.push({ start: index, end: index + 2, marker: "strikethrough" });
        if (length === 4) {
          tokens.push({ start: index + 2, end, marker: "strikethrough" });
        }
      }
      index = end;
      continue;
    }
    if (text[index] === "*") {
      let end = index + 1;
      while (text[end] === "*") end++;
      tokens.push({ start: index, end, marker: "asterisk" });
      index = end;
      continue;
    }
    index++;
  }
  return tokens;
}

function inlineTransition(state: number, token: InlineToken): number | undefined {
  if (token.marker === "strikethrough") return state ^ STRIKETHROUGH_STATE;
  switch (token.end - token.start) {
    case 1: return state ^ ITALIC_STATE;
    case 2: return state ^ BOLD_STATE;
    case 3: return state ^ BOLD_STATE ^ ITALIC_STATE;
    case 4: return state & ITALIC_STATE ? state ^ BOLD_STATE : undefined;
    default: return undefined;
  }
}

function completableInlineStates(tokens: InlineToken[]): Uint8Array {
  let completable = new Uint8Array(tokens.length + 1);
  completable[tokens.length] = 1;
  for (let index = tokens.length - 1; index >= 0; index--) {
    let nextStates = completable[index + 1];
    let states = nextStates;
    for (let state = 0; state < 8; state++) {
      let next = inlineTransition(state, tokens[index]);
      if (next !== undefined && nextStates & (1 << next)) states |= 1 << state;
    }
    completable[index] = states;
  }
  return completable;
}

function inlineMarkdownRanges(
  markdown: string,
  links: MarkdownLinkIndex,
): (MarkdownRange & { style: number })[] {
  let ranges: (MarkdownRange & { style: number })[] = [];
  let starts = new Map<number, number>();
  let state = 0;
  let tokens = inlineTokens(markdown, links);
  let completable = completableInlineStates(tokens);

  for (let index = 0; index < tokens.length; index++) {
    let token = tokens[index];
    let nextToken = tokens[index + 1];
    if (state & STRIKETHROUGH_STATE && token.marker === "strikethrough" &&
        nextToken?.marker === "strikethrough" && token.end === nextToken.start &&
        completable[index + 2] & (1 << state)) {
      index++;
      continue;
    }

    let next = inlineTransition(state, token);
    if (next === undefined || !(completable[index + 1] & (1 << next))) continue;
    let previousToken = tokens[index - 1];
    if (token.marker === "strikethrough" && state & STRIKETHROUGH_STATE &&
        previousToken?.marker === "strikethrough" && previousToken.end === token.start &&
        starts.get(STRIKETHROUGH_STATE) === previousToken.start) {
      starts.delete(STRIKETHROUGH_STATE);
      state = next;
      continue;
    }
    for (let style of INLINE_STYLE_STATES) {
      if (!(state & style) && next & style) starts.set(style, token.start);
      if (state & style && !(next & style)) {
        ranges.push({ mdStart: starts.get(style)!, mdEnd: token.end, style });
        starts.delete(style);
      }
    }
    state = next;
  }
  return ranges;
}

function inlineSpanStyle(
  state: number,
): Pick<FormattingSpan, "bold" | "italic" | "strikethrough"> {
  switch (state) {
    case BOLD_STATE: return { bold: true };
    case ITALIC_STATE: return { italic: true };
    default: return { strikethrough: true };
  }
}

/** Whether Google Docs strips UTF-16 code unit `code` from text it inserts. */
export function isGoogleDocsStrippedCharacter(code: number): boolean {
  return code <= 0x08 || code >= 0x0c && code <= 0x1f ||
    code >= 0xe000 && code <= 0xf8ff;
}

/** `text` without the characters Google removes from inserted text. */
export function stripUnwritableCharacters(text: string): string {
  let kept = "";
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    if (!isGoogleDocsStrippedCharacter(text.charCodeAt(index))) continue;
    kept += text.slice(start, index);
    start = index + 1;
  }
  return start === 0 ? text : kept + text.slice(start);
}

function coalesceFormattingSpans(spans: FormattingSpan[]): FormattingSpan[] {
  let coalesced: FormattingSpan[] = [];
  for (let span of spans) {
    let previous = coalesced.at(-1);
    if (previous && previous.end === span.start && previous.bold === span.bold &&
      previous.italic === span.italic && previous.strikethrough === span.strikethrough &&
      previous.link === span.link) {
      previous.end = span.end;
    } else {
      coalesced.push(span);
    }
  }
  return coalesced;
}

function sanitizeGoogleDocsParsedText(
  plainText: string,
  spans: FormattingSpan[],
): { plainText: string; spans: FormattingSpan[] } {
  let firstRemoved = -1;
  for (let index = 0; index < plainText.length; index++) {
    if (isGoogleDocsStrippedCharacter(plainText.charCodeAt(index))) {
      firstRemoved = index;
      break;
    }
  }
  if (firstRemoved === -1) return { plainText, spans: coalesceFormattingSpans(spans) };

  let removedBefore = new Uint32Array(plainText.length + 1);
  let chunks = [plainText.slice(0, firstRemoved)];
  let chunkStart = firstRemoved + 1;
  let removed = 1;
  removedBefore[chunkStart] = removed;
  for (let index = chunkStart; index < plainText.length; index++) {
    if (isGoogleDocsStrippedCharacter(plainText.charCodeAt(index))) {
      chunks.push(plainText.slice(chunkStart, index));
      chunkStart = index + 1;
      removed++;
    }
    removedBefore[index + 1] = removed;
  }

  chunks.push(plainText.slice(chunkStart));
  return {
    plainText: chunks.join(""),
    spans: coalesceFormattingSpans(spans.map(span => ({
      ...span,
      start: span.start - removedBefore[span.start],
      end: span.end - removedBefore[span.end],
    }))),
  };
}

function parseInlineFormatting(text: string): { plainText: string; spans: FormattingSpan[] } {
  let plainText = "";
  let spans: FormattingSpan[] = [];
  let starts = new Map<number, number>();
  let state = 0;
  let links = indexMarkdownLinks(text);
  let tokens = inlineTokens(text, links);
  let completable = completableInlineStates(tokens);
  let tokenIndex = 0;

  for (let index = 0; index < text.length;) {
    let escaped = text[index + 1];
    if (text[index] === "\\" && escaped && isMarkdownPunctuation(escaped)) {
      plainText += escaped;
      index += 2;
      continue;
    }

    let link = matchMarkdownLink(text, index, links);
    if (link) {
      let end = link.end + 1;
      if (!link.label) {
        plainText += text.slice(index, end);
      } else {
        let start = plainText.length;
        let inner = parseInlineFormatting(link.label);
        plainText += inner.plainText;
        spans.push({ start, end: plainText.length, link: link.url });
        for (let span of inner.spans) {
          spans.push({ ...span, start: start + span.start, end: start + span.end });
        }
      }
      index = end;
      continue;
    }

    let token = tokens[tokenIndex];
    if (token?.start === index) {
      let nextToken = tokens[tokenIndex + 1];
      if (state & STRIKETHROUGH_STATE && token.marker === "strikethrough" &&
          nextToken?.marker === "strikethrough" && token.end === nextToken.start &&
          completable[tokenIndex + 2] & (1 << state)) {
        index = nextToken.end;
        tokenIndex += 2;
        continue;
      }

      let next = inlineTransition(state, token);
      if (next !== undefined && completable[tokenIndex + 1] & (1 << next)) {
        let previousToken = tokens[tokenIndex - 1];
        if (token.marker === "strikethrough" && state & STRIKETHROUGH_STATE &&
            previousToken?.marker === "strikethrough" && previousToken.end === token.start &&
            starts.get(STRIKETHROUGH_STATE) === plainText.length) {
          plainText += text.slice(previousToken.start, token.end);
          starts.delete(STRIKETHROUGH_STATE);
          state = next;
        } else {
          for (let style of INLINE_STYLE_STATES) {
            if (!(state & style) && next & style) starts.set(style, plainText.length);
            if (state & style && !(next & style)) {
              spans.push({
                start: starts.get(style)!,
                end: plainText.length,
                ...inlineSpanStyle(style),
              });
              starts.delete(style);
            }
          }
          state = next;
        }
      } else {
        plainText += text.slice(token.start, token.end);
      }
      index = token.end;
      tokenIndex++;
      continue;
    }

    plainText += text[index++];
  }

  return sanitizeGoogleDocsParsedText(plainText, spans);
}

function canonicalInlineMarkdown(block: ParsedBlock): string {
  let boundaries = [...new Set([
    0,
    block.plainText.length,
    ...block.spans.flatMap(span => [span.start, span.end]),
  ])].toSorted((left, right) => left - right);
  let starts = block.spans.toSorted((left, right) => left.start - right.start);
  let ends = block.spans.toSorted((left, right) => left.end - right.end);
  let startIndex = 0;
  let endIndex = 0;
  let bold = 0;
  let italic = 0;
  let strikethrough = 0;
  let links = new Map<string, number>();
  let formats: MarkdownFormat[] = [];
  let markdown = "";

  function adjust(span: FormattingSpan, amount: 1 | -1): void {
    if (span.bold) bold += amount;
    if (span.italic) italic += amount;
    if (span.strikethrough) strikethrough += amount;
    if (!span.link) return;
    let count = (links.get(span.link) ?? 0) + amount;
    if (count) links.set(span.link, count);
    else links.delete(span.link);
  }

  for (let index = 0; index < boundaries.length - 1; index++) {
    let start = boundaries[index];
    let end = boundaries[index + 1];
    while (starts[startIndex]?.start === start) adjust(starts[startIndex++], 1);
    while (ends[endIndex]?.end === start) adjust(ends[endIndex++], -1);
    let style: TextStyle = {
      bold: bold > 0,
      italic: italic > 0,
      strikethrough: strikethrough > 0,
    };
    let link = links.keys().next().value;
    let nextFormats = markdownFormats(style, link && canonicalLinkDestination(link), false);
    markdown += markdownFormatTransition(formats, nextFormats);
    let text = block.plainText.slice(start, end);
    markdown += link ? escapeMarkdownLinkLabelText(text) : text;
    formats = nextFormats;
  }

  return markdown + markdownFormatTransition(formats, []);
}

/** Normalize supported Markdown to the form returned after writing and rereading it. */
export function canonicalizeMarkdownForWrite(markdown: string): string {
  let result = "";
  let lastListType: ListType | null = null;
  for (let block of parseMarkdownForWrite(markdown)) {
    if (result && (!lastListType || !block.listType || lastListType !== block.listType)) {
      result += "\n";
    }
    if (block.listType) {
      result += "  ".repeat(block.nestingLevel) + (block.listType === "numbered" ? "1. " : "- ");
    }
    if (block.headingLevel !== null) result += `${"#".repeat(block.headingLevel)} `;
    result += canonicalInlineMarkdown(block) + "\n";
    lastListType = block.listType;
  }
  return result.slice(0, -1);
}

type DocsLink = NonNullable<TextStyle["link"]>;

type MarkdownWriteOptions = {
  /**
   * The paragraph written into, and the source blocks of the rewrite it belongs to. New paragraphs
   * inherit `container`'s attributes; the block at `pairedIndex` replaces its content.
   */
  source?: {
    blocks: BlockMapping[];
    /** The source blocks' links, keyed by Markdown destination. */
    links: Map<string, DocsLink>;
    markdown: string;
    container: BlockMapping;
    pairedIndex?: number;
  };
  /** Whether blocks with no source counterpart must be reset to a plain paragraph first. */
  resetParagraphs?: boolean;
  /** Whether paragraphs reset to plain also lose their indent, which removing a bullet leaves. */
  resetIndent?: boolean;
  /** Style to apply across the insertion, for an edit that stays inside one text run. */
  sourceTextStyle?: TextStyle;
  /** Leave the paragraph before an inserted separator unchanged. */
  preserveLeadingParagraph?: boolean;
  /** Keep a fragment's final paragraph break. */
  preserveTrailingNewline?: boolean;
  /** Receives the index of each block needing bullets, for a caller that creates them itself. */
  bulleted?: (index: number) => void;
};

function parseInternalDocsLink(destination: string): DocsLink | undefined {
  let match = /^(?:\?tab=([^#&]+))?(?:#(bookmark|heading)=([^#&]+))?$/.exec(destination);
  if (!match || !match[1] && !match[2]) return undefined;

  try {
    let tabId = match[1] ? decodeURIComponent(match[1]) : undefined;
    let id = match[3] ? decodeURIComponent(match[3]) : undefined;
    if (!match[2]) return tabId ? { tabId } : undefined;
    if (!id) return undefined;
    if (match[2] === "bookmark") {
      return tabId ? { bookmark: { id, tabId } } : { bookmarkId: id };
    }
    return tabId ? { heading: { id, tabId } } : { headingId: id };
  } catch {
    return undefined;
  }
}

/** A link destination spelled as a rendering spells it, however it was written. */
export function canonicalLinkDestination(destination: string): string {
  return docsLinkDestination(parseInternalDocsLink(destination)) ?? destination;
}

/** The link a destination written in table HTML or Markdown stands for. */
export function docsLinkForDestination(destination: string): DocsLink {
  return parseInternalDocsLink(destination) ?? { url: destination };
}

/**
 * A link destination as a table cell of tab `tabId` reads once it is written: a heading or
 * bookmark named without a tab is one of that tab, as a read returns it.
 */
export function cellLinkDestination(destination: string, tabId: string): string {
  let link = parseInternalDocsLink(destination);
  if (!link) return destination;
  if ("headingId" in link) link = { heading: { id: link.headingId, tabId } };
  else if ("bookmarkId" in link) link = { bookmark: { id: link.bookmarkId, tabId } };
  return docsLinkDestination(link) ?? destination;
}

function sourceLinks(blocks: BlockMapping[]): Map<string, DocsLink> {
  let links = new Map<string, DocsLink>();
  for (let block of blocks) {
    for (let segment of block.segments) {
      if ("syntaxOnly" in segment || !segment.textStyle.link) continue;
      let destination = docsLinkDestination(segment.textStyle.link);
      if (destination !== undefined && !links.has(destination)) {
        links.set(destination, segment.textStyle.link);
      }
    }
  }
  return links;
}

function linkForWrite(source: MarkdownWriteOptions["source"], destination: string): DocsLink {
  return source?.links.get(destination) ?? docsLinkForDestination(destination);
}

function targetNamedStyle(block: ParsedBlock, source?: BlockMapping): string {
  if (block.headingLevel !== null) {
    return block.headingLevel === 1 && source?.namedStyleType === "TITLE"
      ? "TITLE"
      : `HEADING_${block.headingLevel}`;
  }
  return source?.namedStyleType === "SUBTITLE" && block.listType === null
    ? "SUBTITLE"
    : "NORMAL_TEXT";
}

function sourceBlockText(source: BlockMapping, markdown: string): string {
  let text = "";
  for (let segment of source.segments) {
    if (!("syntaxOnly" in segment)) text += markdown.slice(segment.mdStart, segment.mdEnd);
  }
  return text;
}

function sameBlockShape(source: BlockMapping, target: ParsedBlock): boolean {
  return source.listType === target.listType && source.listNestingLevel === target.nestingLevel &&
    source.namedStyleType === targetNamedStyle(target, source);
}

function blocksMatch(source: BlockMapping, sourceText: string, target: ParsedBlock): boolean {
  return sourceText === target.plainText && sameBlockShape(source, target);
}

function canPreserveListItem(
  source: BlockMapping,
  target: ParsedBlock,
  markdown: string,
): boolean {
  if (source.listId === undefined || source.listType !== target.listType) return false;
  if (source.listType === null) return true;
  return source.listNestingLevel === target.nestingLevel &&
    (target.listType !== "numbered" || target.listNumber !== null &&
      markdown.startsWith(
        `${"  ".repeat(target.nestingLevel)}${target.listNumber}. `, source.mdStart));
}

/** Whether a new paragraph, which inherits `container`'s list, can stay in it. */
function continuesList(container: BlockMapping, target: ParsedBlock): boolean {
  return container.listId !== undefined && target.listType !== null &&
    container.listType === target.listType && container.listNestingLevel === target.nestingLevel;
}

/** Whether `target` renders exactly as `source` already does. */
function isUnchangedBlock(source: BlockMapping, target: ParsedBlock, markdown: string): boolean {
  return JSON.stringify(parseLine(markdown.slice(source.mdStart, source.mdEnd - 1))) ===
    JSON.stringify(target);
}

/** Beyond this many block pairs, a rewrite's changed middle is anchored only by unique blocks. */
const MAX_ALIGNED_BLOCK_PAIRS = 250_000;

/**
 * Pair each source block with the target block that rewrites it. Unmatched sources are removed;
 * unmatched targets are new paragraphs.
 */
function alignSourceBlocks(
  sources: BlockMapping[],
  targets: ParsedBlock[],
  markdown: string,
): [number, number][] {
  let texts = sources.map(source => sourceBlockText(source, markdown));
  let match = (s: number, t: number) => blocksMatch(sources[s], texts[s], targets[t]);

  let head = 0;
  while (head < sources.length && head < targets.length && match(head, head)) head++;
  let sourceEnd = sources.length;
  let targetEnd = targets.length;
  while (sourceEnd > head && targetEnd > head && match(sourceEnd - 1, targetEnd - 1)) {
    sourceEnd--;
    targetEnd--;
  }

  let matches = Array.from({ length: head }, (_, index): [number, number] => [index, index]);
  let rows = sourceEnd - head;
  let columns = targetEnd - head;
  if (rows * columns <= MAX_ALIGNED_BLOCK_PAIRS) {
    // Row-major (rows + 1) x (columns + 1); a length never exceeds sqrt(MAX_ALIGNED_BLOCK_PAIRS).
    let width = columns + 1;
    let lengths = new Uint16Array((rows + 1) * width);
    for (let s = rows - 1; s >= 0; s--) {
      for (let t = columns - 1; t >= 0; t--) {
        let cell = s * width + t;
        lengths[cell] = match(head + s, head + t)
          ? lengths[cell + width + 1] + 1
          : Math.max(lengths[cell + width], lengths[cell + 1]);
      }
    }
    for (let s = 0, t = 0; s < rows && t < columns;) {
      let cell = s * width + t;
      if (lengths[cell] === lengths[cell + width]) s++;
      else if (lengths[cell] === lengths[cell + 1]) t++;
      else matches.push([head + s++, head + t++]);
    }
  } else {
    let key = (text: string, listType: ListType | null, nestingLevel: number) =>
      JSON.stringify([text, listType, nestingLevel]);
    let anchors = uniqueAnchors(
      sources.slice(head, sourceEnd).map((source, index) =>
        key(texts[head + index], source.listType, source.listNestingLevel)),
      targets.slice(head, targetEnd).map(target =>
        key(target.plainText, target.listType, target.nestingLevel)),
      (s, t) => match(head + s, head + t),
    );
    matches.push(...anchors.map(([s, t]): [number, number] => [head + s, head + t]));
  }
  for (let offset = 0; sourceEnd + offset <= sources.length; offset++) {
    matches.push([sourceEnd + offset, targetEnd + offset]);
  }

  let pairs: [number, number][] = [];
  let gapSource = 0;
  let gapTarget = 0;
  for (let [s, t] of matches) {
    pairs.push(...pairGap(sources, targets, gapSource, s, gapTarget, t));
    if (s < sources.length) pairs.push([s, t]);
    gapSource = s + 1;
    gapTarget = t + 1;
  }
  return pairs;
}

/** Pairs of keys unique on both sides, reduced to the longest run ordered on both. */
function uniqueAnchors(
  sourceKeys: string[],
  targetKeys: string[],
  match: (s: number, t: number) => boolean,
): [number, number][] {
  let uniqueIndices = (keys: string[]) => {
    let indices = new Map<string, number>();
    keys.forEach((key, index) => indices.set(key, indices.has(key) ? -1 : index));
    return indices;
  };
  let targetIndices = uniqueIndices(targetKeys);
  let candidates = [...uniqueIndices(sourceKeys)].flatMap(([key, s]): [number, number][] => {
    let t = targetIndices.get(key) ?? -1;
    return s >= 0 && t >= 0 && match(s, t) ? [[s, t]] : [];
  });

  let tails: number[] = [];
  let previous: number[] = [];
  candidates.forEach(([, t], index) => {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      let middle = (low + high) >> 1;
      if (candidates[tails[middle]][1] < t) low = middle + 1;
      else high = middle;
    }
    previous[index] = low > 0 ? tails[low - 1] : -1;
    tails[low] = index;
  });
  let anchors: [number, number][] = [];
  for (let index = tails.at(-1) ?? -1; index >= 0; index = previous[index]) {
    anchors.push(candidates[index]);
  }
  return anchors.toReversed();
}

/**
 * Pair the unmatched blocks between two matches, so edited paragraphs keep their own lists and
 * styles. Pairs extend from each end while the blocks' shapes agree; any surplus sits where they
 * first diverge, so a new list item lands beside the items it continues.
 */
function pairGap(
  sources: BlockMapping[],
  targets: ParsedBlock[],
  sourceStart: number,
  sourceEnd: number,
  targetStart: number,
  targetEnd: number,
): [number, number][] {
  let count = Math.min(sourceEnd - sourceStart, targetEnd - targetStart);
  let sameShape = (s: number, t: number) => sameBlockShape(sources[s], targets[t]);
  let front = 0;
  while (front < count && sameShape(sourceStart + front, targetStart + front)) front++;
  let back = 0;
  while (front + back < count && sameShape(sourceEnd - 1 - back, targetEnd - 1 - back)) back++;
  return [
    ...Array.from({ length: count - back },
      (_, index): [number, number] => [sourceStart + index, targetStart + index]),
    ...Array.from({ length: back },
      (_, index): [number, number] => [sourceEnd - back + index, targetEnd - back + index]),
  ];
}

/** Append `request` to a batch, refusing a batch larger than `MAX_GOOGLE_DOC_REQUESTS`. */
export function addRequest(requests: GoogleDocsRequest[], request: GoogleDocsRequest): void {
  if (requests.length >= MAX_GOOGLE_DOC_REQUESTS) {
    throw new Error(`Google Doc action exceeds the ${MAX_GOOGLE_DOC_REQUESTS}-request batch limit.`);
  }
  requests.push(request);
}

/**
 * Merge each range into its predecessor when the two abut and `same` holds. A paragraph-range
 * request applies to every paragraph it touches, so abutting paragraphs that need the same change
 * can share one request.
 */
function coalesceRanges<T extends { startIndex: number; endIndex: number }>(
  ranges: readonly T[],
  same: (previous: T, next: T) => boolean,
): T[] {
  let merged: T[] = [];
  for (let range of ranges) {
    let previous = merged.at(-1);
    if (previous?.endIndex === range.startIndex && same(previous, range)) {
      previous.endIndex = range.endIndex;
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/**
 * One `updateParagraphStyle` request. At least one of a style change or an indent reset must be
 * asked for, since Google rejects a request that names no fields.
 */
function updateParagraphStyleRequest(
  range: { startIndex: number; endIndex: number; tabId: string },
  namedStyleType: string | undefined,
  clearIndent: boolean,
): any {
  let paragraphStyle: Record<string, unknown> = {};
  let fields: string[] = [];
  if (namedStyleType !== undefined) {
    paragraphStyle.namedStyleType = namedStyleType;
    fields.push("namedStyleType");
  }
  if (clearIndent) {
    paragraphStyle.indentStart = { magnitude: 0, unit: "PT" };
    paragraphStyle.indentFirstLine = { magnitude: 0, unit: "PT" };
    fields.push("indentStart", "indentFirstLine");
  }
  return { updateParagraphStyle: { range, paragraphStyle, fields: fields.join(",") } };
}

/**
 * Convert a Markdown string into Google Docs batchUpdate request objects that insert the content
 * at the given index inside tab `tabId`.
 *
 * Every emitted coordinate names that tab: tab bodies have independent index spaces, so an
 * unqualified index lands in whichever tab Google picks.
 *
 * Returns requests in the order they should appear in the batchUpdate array.
 */
export function markdownToDocRequests(
  markdown: string,
  insertAt: number,
  tabId: string,
  options: MarkdownWriteOptions = {},
): any[] {
  return blocksToDocRequests(parseMarkdownForWrite(markdown), insertAt, tabId, options, []);
}

/**
 * Append to `requests` those that fill the empty paragraph at `insertAt` with `text` as plain
 * paragraphs, one per line, none of the text bold, italic, struck through or linked. The
 * paragraphs are reset as well: none is a list item, a heading or indented, whatever the
 * paragraph was, and empty text only resets it. With `keepParagraphStyle` they are left as
 * the paragraph is, and empty text sends nothing.
 */
export function plainTextToDocRequests(
  text: string,
  insertAt: number,
  tabId: string,
  requests: GoogleDocsRequest[],
  keepParagraphStyle = false,
): void {
  let blocks = text.split("\n").map((plainText): ParsedBlock => ({
    plainText, headingLevel: null, listType: null, listNumber: null, nestingLevel: 0, spans: [],
  }));
  blocksToDocRequests(blocks, insertAt, tabId,
    keepParagraphStyle ? {} : { resetParagraphs: true, resetIndent: true }, requests);
}

/** Append to `requests` the requests that insert `blocks` at `insertAt`. */
function blocksToDocRequests(
  blocks: ParsedBlock[],
  insertAt: number,
  tabId: string,
  options: MarkdownWriteOptions,
  requests: GoogleDocsRequest[],
): GoogleDocsRequest[] {
  if (blocks.length === 0) return requests;
  let { source, resetParagraphs = false } = options;
  let preserveLists = blocks.map((block, index) => source !== undefined &&
    (index === source.pairedIndex
      ? canPreserveListItem(source.container, block, source.markdown)
      : continuesList(source.container, block)));
  // A list run whose first item is rebuilt is rebuilt whole, so it stays one list.
  for (let start = 0; start < blocks.length;) {
    let end = start + 1;
    while (end < blocks.length && blocks[end].listType === blocks[start].listType) end++;
    if (blocks[start].listType && !preserveLists[start]) preserveLists.fill(false, start, end);
    start = end;
  }
  // Positions are known from the text lengths alone, so lay every block out in one pass.
  let offset = insertAt;
  let positioned = blocks.map((block, index) => {
    let paired = index === source?.pairedIndex ? source.container : undefined;
    let preserveList = preserveLists[index];
    let prefix = block.listType && !preserveList ? "\t".repeat(block.nestingLevel) : "";
    let paragraphStart = offset;
    offset += prefix.length + block.plainText.length + 1;
    return {
      block,
      paired,
      preserveList,
      targetStyle: targetNamedStyle(block, paired),
      prefix,
      paragraphStart,
      textStart: paragraphStart + prefix.length,
      paragraphEnd: offset,
      preserveStyle: options.preserveLeadingParagraph && index === 0,
    };
  });
  let fullText = positioned.map(({ block, prefix }) => prefix + block.plainText).join("\n");
  if (options.preserveTrailingNewline) fullText += "\n";

  if (fullText.length > 0) {
    addRequest(requests, { insertText: { location: { index: insertAt, tabId }, text: fullText } });
  }

  let paragraphChanges = positioned.map(({ paired, preserveList, preserveStyle, targetStyle,
    paragraphStart, paragraphEnd }) => {
    let change = {
      startIndex: paragraphStart,
      endIndex: paragraphEnd,
      deleteBullets: false,
      namedStyleType: undefined as string | undefined,
      clearIndent: false,
    };
    if (preserveStyle) return change;
    // A rewrite's paragraphs can only have inherited their container's list.
    let resetList = !preserveList &&
      (source ? source.container.listId !== undefined : resetParagraphs);
    change.deleteBullets = resetList;
    change.clearIndent = resetList && (source !== undefined || options.resetIndent === true);
    if (paired ? paired.namedStyleType !== targetStyle
      : resetParagraphs || targetStyle !== "NORMAL_TEXT") {
      change.namedStyleType = targetStyle;
    }
    return change;
  });
  // Bullets go first: removing them indents each paragraph to keep its nesting visible, and the
  // indent reset below undoes that.
  for (let { startIndex, endIndex } of coalesceRanges(
    paragraphChanges.filter(change => change.deleteBullets), () => true)) {
    addRequest(requests, { deleteParagraphBullets: { range: { startIndex, endIndex, tabId } } });
  }
  for (let { startIndex, endIndex, namedStyleType, clearIndent } of coalesceRanges(
    paragraphChanges.filter(change => change.namedStyleType !== undefined || change.clearIndent),
    (previous, next) => previous.namedStyleType === next.namedStyleType &&
      previous.clearIndent === next.clearIndent)) {
    addRequest(requests, updateParagraphStyleRequest(
      { startIndex, endIndex, tabId }, namedStyleType, clearIndent));
  }

  // Reset inherited inline styling across all inserted text in one request. Starting at the first
  // character of text leaves a leading inserted newline, which terminates the paragraph before the
  // insertion, with the style it already has.
  let textBlocks = positioned.filter(({ block }) => block.plainText.length > 0);
  let firstText = textBlocks[0];
  let lastText = textBlocks.at(-1);
  if (firstText && lastText) {
    addRequest(requests, {
      updateTextStyle: {
        range: {
          startIndex: firstText.textStart,
          endIndex: lastText.textStart + lastText.block.plainText.length,
          tabId,
        },
        textStyle: options.sourceTextStyle ?? {},
        fields: "bold,italic,strikethrough,link",
      },
    });
  }
  for (let { block, targetStyle, textStart } of textBlocks) {
    if (targetStyle !== "SUBTITLE") continue;
    addRequest(requests, {
      updateTextStyle: {
        range: { startIndex: textStart, endIndex: textStart + block.plainText.length, tabId },
        textStyle: { italic: false },
        fields: "italic",
      },
    });
  }

  for (let { block, textStart } of positioned) {
    for (let span of block.spans) {
      let startIndex = textStart + span.start;
      let endIndex = textStart + span.end;
      if (startIndex >= endIndex) continue;

      let textStyle: Record<string, unknown> = {};
      let fields: string[] = [];
      if (span.bold) { textStyle.bold = true; fields.push("bold"); }
      if (span.italic) { textStyle.italic = true; fields.push("italic"); }
      if (span.strikethrough) { textStyle.strikethrough = true; fields.push("strikethrough"); }
      if (span.link) {
        textStyle.link = linkForWrite(options.source, span.link);
        fields.push("link");
      }
      if (fields.length === 0) continue;
      addRequest(requests, {
        updateTextStyle: {
          range: { startIndex, endIndex, tabId }, textStyle, fields: fields.join(","),
        },
      });
    }
  }

  let bullets = positioned.flatMap(({ block, preserveList, paragraphStart, paragraphEnd }, index) =>
    block.listType && !preserveList
      ? [{ index, listType: block.listType, startIndex: paragraphStart, endIndex: paragraphEnd }]
      : []);
  if (options.bulleted) bullets.forEach(({ index }) => options.bulleted!(index));
  else addBulletRequests(requests, bullets, tabId);
  return requests;
}

function addBulletRequests(
  requests: any[],
  paragraphs: { listType: ListType; startIndex: number; endIndex: number }[],
  tabId: string,
): void {
  let groups = coalesceRanges(paragraphs, (previous, next) => previous.listType === next.listType);
  // Reversed: creating bullets strips each paragraph's leading tabs, shifting later indices.
  for (let { listType, startIndex, endIndex } of groups.toReversed()) {
    addRequest(requests, {
      createParagraphBullets: {
        range: { startIndex, endIndex, tabId },
        bulletPreset: listType === "numbered"
          ? "NUMBERED_DECIMAL_ALPHA_ROMAN"
          : "BULLET_DISC_CIRCLE_SQUARE",
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Replace operations: map a Markdown edit back to doc operations
// ---------------------------------------------------------------------------

/** The refusal of an edit that touches rendered content `replaceText()` must leave alone. */
export class StructuredContentError extends Error {
  constructor() {
    super("replaceText: structured content cannot be edited. Narrow the match to plain text.");
  }
}

/** Refuse edits that would modify or bridge structural content without a safe source mapping. */
export function assertMarkdownRangeEditable(
  protectedRanges: readonly MarkdownRange[],
  mdStart: number,
  mdEnd: number,
): void {
  if (protectedRanges.some(range => markdownRangeTouches(mdStart, mdEnd, range))) {
    throw new StructuredContentError();
  }
}

/**
 * A Markdown rendering together with the ranges in it that edits must leave alone and the tables
 * it holds.
 */
export type EditableMarkdown = {
  markdown: string;
  protectedRanges: MarkdownRange[];
  tables: EditableTable[];
};

/** Where the line that holds `index` starts in `markdown`. */
export function lineStart(markdown: string, index: number): number {
  return index <= 0 ? 0 : markdown.lastIndexOf("\n", index - 1) + 1;
}

/** The kind of list item the line starting at `start` reads as, or `null` for any other line. */
export function listLineType(markdown: string, start: number): ListType | null {
  while (markdown[start] === " ") start++;
  if (markdown.startsWith("- ", start)) return "bullet";
  let numberStart = start;
  while (markdown.charCodeAt(start) >= 48 && markdown.charCodeAt(start) <= 57) start++;
  return start > numberStart && markdown.startsWith(". ", start) ? "numbered" : null;
}

type TextEdit = { start: number; end: number; text: string };

function separatorBefore(markdown: string, currentStart: number): TextEdit | undefined {
  let start = currentStart;
  while (start > 0 && markdown[start - 1] === "\n") start--;
  let length = currentStart - start;
  if (start === 0 || length === 0 || markdown[currentStart] === "\n") return undefined;
  let previousType = listLineType(markdown, lineStart(markdown, start - 1));
  let expected = length > 2 ? length + length % 2
    : previousType !== null && previousType === listLineType(markdown, currentStart) ? 1 : 2;
  return length === expected ? undefined : { start, end: currentStart, text: "\n".repeat(expected) };
}

function changedSeparatorBefore(
  markdown: string,
  currentStart: number,
  changeStart: number,
  changeEnd: number,
): TextEdit | undefined {
  let edit = separatorBefore(markdown, currentStart);
  if (edit && edit.end - edit.start === 2 &&
      (edit.end <= changeStart || edit.start >= changeEnd)) return undefined;
  return edit;
}

function nextLineStart(markdown: string, start: number): number | undefined {
  let next = markdown.indexOf("\n", start);
  if (next < 0) return undefined;
  while (markdown[next] === "\n") next++;
  return next < markdown.length ? next : undefined;
}

function normalizeChangedBlockBoundaries(
  markdown: string,
  changeStart: number,
  changeEnd: number,
): string {
  let nextChangedLine = markdown[changeStart] === "\n"
    ? nextLineStart(markdown, changeStart)
    : undefined;
  let first = nextChangedLine !== undefined && nextChangedLine < changeEnd
    ? nextChangedLine
    : lineStart(markdown, changeStart);
  let last = lineStart(markdown, changeEnd > changeStart ? changeEnd - 1 : changeStart);
  let next = nextLineStart(markdown, last);
  let before = changedSeparatorBefore(markdown, first, changeStart, changeEnd);
  let after = next === undefined
    ? undefined
    : changedSeparatorBefore(markdown, next, changeStart, changeEnd);

  for (let edit of [after, before]) {
    if (edit) markdown = markdown.slice(0, edit.start) + edit.text + markdown.slice(edit.end);
  }
  return markdown;
}

function normalizeChangedListBoundaries(
  markdown: string,
  updated: string,
  oldStart: number,
  oldEnd: number,
  newEnd: number,
): string {
  let oldFirst = lineStart(markdown, oldStart);
  let oldLast = lineStart(markdown, oldEnd > oldStart ? oldEnd - 1 : oldStart);
  let newFirst = lineStart(updated, oldStart);
  let newLast = lineStart(updated, newEnd > oldStart ? newEnd - 1 : oldStart);
  let edits: TextEdit[] = [];

  if (listLineType(markdown, oldFirst) !== listLineType(updated, newFirst)) {
    let edit = separatorBefore(updated, newFirst);
    if (edit) edits.push(edit);
  }
  if (listLineType(markdown, oldLast) !== listLineType(updated, newLast)) {
    let next = nextLineStart(updated, newLast);
    let edit = next === undefined ? undefined : separatorBefore(updated, next);
    if (edit) edits.push(edit);
  }

  for (let edit of edits.toSorted((left, right) => right.start - left.start)) {
    updated = updated.slice(0, edit.start) + edit.text + updated.slice(edit.end);
  }
  return updated;
}

/** Move the ranges that end after `from` by `offset`; the ones before it stay as they are. */
/**
 * `edited`, an edit of `content` replayed as Markdown, as a read shows it once Google has applied
 * it: without the bold, italic or strikethrough written into a paragraph whose named style gives
 * it, which Google stores as inherited. Only the lines the edit changed are looked at; a line that
 * was there before reads no such style, since Google never stores one. A line reads as the style
 * its heading marker names, or as normal text, unless `styleAt` names the style of the paragraph
 * that starts there before the edit. A subtitle keeps its italic, which a read shows inherited.
 */
export function dropInheritedFormatting(
  content: EditableMarkdown, edited: EditableMarkdown, named: NamedFormatting,
  styleAt?: (lineStart: number) => string | undefined,
): EditableMarkdown {
  if (Object.keys(named).length === 0 || edited.markdown === content.markdown) return edited;
  let { prefixLen, suffixLen } = markdownReplacementBounds(content.markdown, edited.markdown);
  let { markdown } = edited;
  let { protectedRanges, tables } = edited;
  let first = lineStart(markdown, prefixLen);
  let last = markdown.length - suffixLen;
  // From the last line to the first, so that a rewritten line moves nothing still to be read.
  let starts: number[] = [];
  for (let at = first; at <= last && at < markdown.length;) {
    starts.push(at);
    let end = markdown.indexOf("\n", at);
    if (end < 0) break;
    at = end + 1;
  }
  for (let start of starts.toReversed()) {
    let end = markdown.indexOf("\n", start);
    if (end < 0) end = markdown.length;
    let line = markdown.slice(start, end);
    let marker = /^(?: *(?:- |\d+\. ))?(#{1,6} )?/.exec(line)!;
    let level = marker[1] ? marker[1].length - 1 : 0;
    let style = (start <= prefixLen ? styleAt?.(start) : undefined) ??
      (level > 0 ? `HEADING_${level}` : "NORMAL_TEXT");
    let format: InheritedFormat = { ...named[style] };
    if (style === "SUBTITLE") delete format.italic;
    let block = parseLine(line);
    if (!block.spans.some(span => INHERITED_FIELDS.some(field => format[field] && span[field]))) {
      continue;
    }
    let spans = block.spans.map(span => {
      let kept = { ...span };
      for (let field of INHERITED_FIELDS) if (format[field]) kept[field] = false;
      return kept;
    });
    let rewritten = line.slice(0, marker[0].length) + canonicalInlineMarkdown({ ...block, spans });
    let offset = rewritten.length - line.length;
    markdown = markdown.slice(0, start) + rewritten + markdown.slice(end);
    protectedRanges = shiftRangesAfter(protectedRanges, end, offset);
    tables = shiftRangesAfter(tables, end, offset);
  }
  return { markdown, protectedRanges, tables };
}

function shiftRangesAfter<T extends MarkdownRange>(ranges: T[], from: number, offset: number): T[] {
  return offset === 0 ? ranges : ranges.map(range => range.mdEnd <= from ? range : {
    ...range,
    mdStart: range.mdStart + offset,
    mdEnd: range.mdEnd + offset,
  });
}

/**
 * Splice `newMarkdown` over [mdStart, mdEnd), keeping the protected ranges and the tables on the
 * text they name. A table lies inside a protected range, and refusing an edit that overlaps one
 * is what makes shifting the rest by a constant sound.
 */
export function applyMarkdownEdit(
  content: EditableMarkdown,
  mdStart: number,
  mdEnd: number,
  newMarkdown: string,
): EditableMarkdown {
  assertMarkdownEscapeBoundaries(content.markdown, mdStart, mdEnd);
  let oldMarkdown = content.markdown.slice(mdStart, mdEnd);
  let updated = content.markdown.slice(0, mdStart) + newMarkdown +
    content.markdown.slice(mdEnd);
  let normalized = normalizeChangedListBoundaries(
    content.markdown, updated, mdStart, mdEnd, mdStart + newMarkdown.length);
  if (normalized !== updated) {
    let bounds = markdownReplacementBounds(content.markdown, normalized);
    mdStart = bounds.prefixLen;
    mdEnd = content.markdown.length - bounds.suffixLen;
    newMarkdown = normalized.slice(bounds.prefixLen, normalized.length - bounds.suffixLen);
  } else {
    let bounds = markdownReplacementBounds(oldMarkdown, newMarkdown);
    mdStart += bounds.prefixLen;
    mdEnd -= bounds.suffixLen;
    newMarkdown = newMarkdown.slice(bounds.prefixLen, newMarkdown.length - bounds.suffixLen);
  }
  assertMarkdownRangeEditable(content.protectedRanges, mdStart, mdEnd);
  newMarkdown = closeFormattingAtBreaks(content.markdown, mdStart, mdEnd, newMarkdown);
  let offset = newMarkdown.length - (mdEnd - mdStart);
  return {
    markdown: content.markdown.slice(0, mdStart) + newMarkdown + content.markdown.slice(mdEnd),
    protectedRanges: shiftRangesAfter(content.protectedRanges, mdStart, offset),
    tables: shiftRangesAfter(content.tables, mdStart, offset),
  };
}

/** Formats open at `offset` in one rendered line, outermost first. */
function openFormatsAt(line: string, offset: number): MarkdownFormat[] {
  let links = indexMarkdownLinks(line);
  for (let index = 0; index < offset;) {
    if (line[index] === "\\" && isMarkdownPunctuation(line[index + 1] ?? "")) {
      index += 2;
      continue;
    }
    let link = matchMarkdownLink(line, index, links);
    if (!link) {
      index++;
      continue;
    }
    let labelEnd = index + 1 + link.label.length;
    if (offset <= labelEnd) {
      return [
        { open: "[", close: line.slice(labelEnd, link.end + 1) },
        ...openFormatsAt(link.label, offset - index - 1),
      ];
    }
    index = link.end + 1;
  }
  let state = 0;
  for (let range of inlineMarkdownRanges(line, links)) {
    if (range.mdStart < offset && offset < range.mdEnd) state |= range.style;
  }
  return markdownFormats({
    bold: !!(state & BOLD_STATE),
    italic: !!(state & ITALIC_STATE),
    strikethrough: !!(state & STRIKETHROUGH_STATE),
  }, undefined, false);
}

/** Close and reopen the formatting around an edit at each paragraph break it inserts. */
function closeFormattingAtBreaks(
  markdown: string,
  start: number,
  end: number,
  text: string,
): string {
  if (!text.includes("\n") || BLOCK_SYNTAX_LINE.test(text) ||
    markdown.slice(start, end).includes("\n")) return text;
  let lineFrom = lineStart(markdown, start);
  let lineTo = markdown.indexOf("\n", end);
  let line = markdown.slice(lineFrom, lineTo < 0 ? undefined : lineTo);
  let formats = openFormatsAt(line, start - lineFrom);
  if (markdownFormatTransition(formats, openFormatsAt(line, end - lineFrom))) return text;
  let close = markdownFormatTransition(formats, []);
  let open = markdownFormatTransition([], formats);
  return text.replace(/\n+/g, breaks => close + breaks + open);
}

/**
 * Slice rendered Markdown, escaping the parts that came from document text so a re-parse reads
 * them as the literal characters they are. Syntax the renderer emitted is left alone, so it
 * re-parses back into the formatting it stands for.
 */
function literalMarkdownSlice(
  sourceMap: SourceMap,
  markdown: string,
  start: number,
  end: number,
): string {
  let result = "";
  let cursor = start;
  for (let block of sourceMap.blocks) {
    if (block.mdEnd <= start) continue;
    if (block.mdStart >= end) break;
    for (let index = 0; index < block.segments.length; index++) {
      let segment = block.segments[index];
      if ("syntaxOnly" in segment || segment.mdEnd <= start || segment.mdStart >= end) continue;
      let overlapStart = Math.max(start, segment.mdStart);
      let overlapEnd = Math.min(end, segment.mdEnd);
      result += markdown.slice(cursor, overlapStart);
      let content = markdown.slice(overlapStart, overlapEnd);
      let previous = block.segments[index - 1];
      let alreadyEscaped = previous && "syntaxOnly" in previous && previous.mdStart >= start &&
        previous.mdEnd === overlapStart && markdown.slice(previous.mdStart, previous.mdEnd) === "\\";
      result += alreadyEscaped ? content[0] + escapeMarkdownText(content.slice(1))
        : escapeMarkdownText(content);
      cursor = overlapEnd;
    }
  }
  return result + markdown.slice(cursor, end);
}

/**
 * A line opening a heading or list item. `m` so it matches any line of a multi-line string, which
 * is what makes this usable both on caller-supplied Markdown and on one rendered block.
 */
const BLOCK_SYNTAX_LINE = /^(?:#{1,6}| *-| *\d+\.) /m;

function markdownRangeTouches(
  mdStart: number,
  mdEnd: number,
  range: MarkdownRange,
): boolean {
  return mdStart === mdEnd
    ? mdStart >= range.mdStart && mdStart < range.mdEnd
    : mdStart < range.mdEnd && mdEnd > range.mdStart;
}

type BlockReplacementRange = MarkdownRange & {
  docStart: number;
  docEnd: number;
  blocks: BlockMapping[];
};

type DocRange = { start: number; end: number; startsAfterParagraph?: true };

function blockReplacementRange(
  sourceMap: SourceMap,
  mdStart: number,
  mdEnd: number,
  force: boolean,
  deletesBreak: boolean,
): BlockReplacementRange | undefined {
  let replaceWholeBlocks = force || deletesBreak;
  let blocks: BlockMapping[] = [];

  for (let block of sourceMap.blocks) {
    if (block.mdStart > mdEnd) break;
    // A deleted break joins the blocks on either side of it, so those count as touched.
    if (deletesBreak ? block.mdEnd < mdStart : !markdownRangeTouches(mdStart, mdEnd, block)) {
      continue;
    }
    blocks.push(block);
    replaceWholeBlocks ||= block.segments.some(segment =>
      "syntaxOnly" in segment && markdownRangeTouches(mdStart, mdEnd, segment));
  }
  replaceWholeBlocks ||= blocks.length > 1;
  let first = blocks[0];
  let last = blocks.at(-1);
  if (!replaceWholeBlocks || !first || !last) return undefined;
  return {
    mdStart: first.mdStart,
    mdEnd: last.mdEnd,
    docStart: first.docStart,
    docEnd: Math.max(last.docStart, last.docEnd - 1),
    blocks,
  };
}

function textStylesEqual(left: TextStyle, right: TextStyle): boolean {
  return left.bold === right.bold && left.italic === right.italic &&
    left.strikethrough === right.strikethrough &&
    docsLinkDestination(left.link) === docsLinkDestination(right.link);
}

function mappedTextStyle(
  sourceMap: SourceMap,
  mdStart: number,
  mdEnd: number,
): TextStyle | undefined {
  let preceding: TextStyle | undefined;
  let matched: TextStyle | undefined;
  for (let block of sourceMap.blocks) {
    // Inclusive: a block ending exactly at an insertion point still supplies `preceding`.
    if (block.mdEnd < mdStart) continue;
    if (block.mdStart > mdEnd) break;
    for (let segment of block.segments) {
      if ("syntaxOnly" in segment) continue;
      if (markdownRangeTouches(mdStart, mdEnd, segment)) {
        if (mdStart === mdEnd) return segment.textStyle;
        if (matched && !textStylesEqual(matched, segment.textStyle)) return undefined;
        matched ??= segment.textStyle;
      } else if (mdStart === mdEnd && mdStart === segment.mdEnd) {
        preceding = segment.textStyle;
      }
    }
  }
  return matched ?? preceding;
}

/**
 * Compute the batch-update operations that replace one range in a tab's Markdown rendering.
 *
 * Unchanged leading and trailing text is trimmed before document indices are calculated;
 * `trimmedOld` and `trimmedNew` report what was left to change after that trimming.
 */
export function computeReplaceOperations(
  sourceMap: SourceMap,
  markdown: string,
  matchStart: number,
  matchEnd: number,
  newMarkdown: string,
  tabId: string,
): { requests: any[]; trimmedOld: string; trimmedNew: string } {
  let oldText = markdown.slice(matchStart, matchEnd);
  if (oldText === newMarkdown) {
    return { requests: [], trimmedOld: "", trimmedNew: "" };
  }
  assertMarkdownEscapeBoundaries(markdown, matchStart, matchEnd);
  let { prefixLen, suffixLen } = markdownReplacementBounds(oldText, newMarkdown);

  let trimmedMatchStart = matchStart + prefixLen;
  let trimmedMatchEnd = matchEnd - suffixLen;
  let trimmedNew = newMarkdown.slice(prefixLen, newMarkdown.length - suffixLen);
  let trimmedOld = oldText.slice(prefixLen, oldText.length - suffixLen);
  assertMarkdownRangeEditable(sourceMap.protectedRanges, trimmedMatchStart, trimmedMatchEnd);

  let blockRange = blockReplacementRange(
    sourceMap,
    trimmedMatchStart,
    trimmedMatchEnd,
    BLOCK_SYNTAX_LINE.test(trimmedNew),
    trimmedOld.includes("\n"),
  );
  if (blockRange) {
    assertMarkdownRangeEditable(
      sourceMap.protectedRanges, blockRange.mdStart, blockRange.mdEnd - 1,
    );
    let rewritten = (
      literalMarkdownSlice(sourceMap, markdown, blockRange.mdStart, trimmedMatchStart) +
      trimmedNew +
      literalMarkdownSlice(sourceMap, markdown, trimmedMatchEnd, blockRange.mdEnd)
    ).replace(/\n$/, "");
    // Leading newlines extend the separator before the range, which already holds its breaks.
    let lead = newlineRun(rewritten, 0, 1);
    let before = newlineRun(markdown, blockRange.mdStart - 1, -1);
    let blockMarkdown = "\n".repeat(Math.ceil((before + lead) / 2) - Math.ceil(before / 2)) +
      rewritten.slice(lead);
    // The range's last block ends at its final break, so each break a trailing run renders after
    // the text adds an empty paragraph.
    let trail = /[^\n]\n+$/.test(blockMarkdown)
      ? newlineRun(blockMarkdown, blockMarkdown.length - 1, -1) : 0;
    let targets = parseMarkdownForWrite(blockMarkdown.slice(0, blockMarkdown.length - trail));
    for (let empty = 0; empty < Math.ceil(trail / 2); empty++) targets.push(parseLine(""));
    let requests = rewriteBlocks(sourceMap, markdown, blockRange.blocks, targets, tabId);
    return { requests, trimmedOld, trimmedNew };
  }

  let docRange = mdRangeToDocRange(sourceMap, trimmedMatchStart, trimmedMatchEnd);
  if (!docRange) {
    throw new Error(
      "replaceText: could not map the Markdown range to document indices. " +
      "The match may span unsupported content.");
  }
  let insertMarkdown = fragmentInsertMarkdown(
    markdown, trimmedMatchStart, trimmedMatchEnd, trimmedNew, docRange.startsAfterParagraph);
  let preserveTrailingNewline = /[^\n]\n+$/.test(insertMarkdown);
  // Paragraphs split off the one written into would inherit its list and style. Text that ends in
  // a break, written at a paragraph's start, holds only paragraphs split off ahead of it.
  let ahead = !docRange.startsAfterParagraph && preserveTrailingNewline
    ? sourceMap.blocks.find(block => block.docStart === docRange.start) : undefined;
  let writeOptions: MarkdownWriteOptions = {
    resetParagraphs: true,
    // A removed bullet leaves its indent behind.
    resetIndent: ahead?.listId !== undefined,
    preserveLeadingParagraph: !ahead ||
      ahead.listId === undefined && ahead.namedStyleType === "NORMAL_TEXT",
    preserveTrailingNewline,
  };
  if (!docRange.startsAfterParagraph) {
    writeOptions.sourceTextStyle = mappedTextStyle(sourceMap, trimmedMatchStart, trimmedMatchEnd);
  }

  let requests: any[] = [];
  if (docRange.start < docRange.end) {
    addRequest(requests, {
      deleteContentRange: {
        range: { startIndex: docRange.start, endIndex: docRange.end, tabId },
      },
    });
  }
  if (insertMarkdown.length > 0) {
    blocksToDocRequests(
      parseMarkdownForWrite(insertMarkdown), docRange.start, tabId, writeOptions, requests);
  }
  return { requests, trimmedOld, trimmedNew };
}

function newlineRun(text: string, index: number, step: 1 | -1): number {
  let count = 0;
  while (text[index + count * step] === "\n") count++;
  return count;
}

/**
 * Resize the newline runs at a fragment's edges so that, joined with the newlines around the edit,
 * each side holds as many paragraph breaks as its whole run renders. After a paragraph, the edit
 * lands before that paragraph's own break, so every existing break follows it.
 */
function fragmentInsertMarkdown(
  markdown: string,
  start: number,
  end: number,
  fragment: string,
  startsAfterParagraph = false,
): string {
  let breaks = (run: number) => Math.ceil(run / 2);
  let before = newlineRun(markdown, start - 1, -1);
  let after = newlineRun(markdown, end, 1);
  let existing = breaks(before + after);
  let lead = newlineRun(fragment, 0, 1);
  if (lead === fragment.length) return "\n".repeat(breaks(before + lead + after) - existing);
  let trail = newlineRun(fragment, fragment.length - 1, -1);
  let [precedingBreaks, followingBreaks] = startsAfterParagraph
    ? [0, existing]
    : [breaks(before), breaks(after)];
  return "\n".repeat(breaks(before + lead) - precedingBreaks) +
    fragment.slice(lead, fragment.length - trail) +
    "\n".repeat(Math.max(0, breaks(trail + after) - followingBreaks));
}

/**
 * Rewrite whole source blocks paragraph by paragraph, so each kept paragraph keeps its own list and
 * style. Requests run from the end of the range backwards, so earlier indices stay valid.
 */
function rewriteBlocks(
  sourceMap: SourceMap,
  markdown: string,
  sources: BlockMapping[],
  targets: ParsedBlock[],
  tabId: string,
): any[] {
  let requests: any[] = [];
  let links = sourceLinks(sources);
  // Bullets are created once the whole range is laid out: Google joins a new list only to the list
  // before it, and pairs are written last to first.
  let bulleted = new Set<number>();
  let keptLengths = new Map<number, number>();
  let write = (blocks: ParsedBlock[], first: number, at: number, container: BlockMapping,
    options: MarkdownWriteOptions = {}, pairedIndex?: number) => blocksToDocRequests(blocks, at,
    tabId, {
      ...options, resetParagraphs: true,
      source: { blocks: sources, links, markdown, container, pairedIndex },
      bulleted: index => bulleted.add(first + index),
    }, requests);
  let remove = (startIndex: number, endIndex: number) =>
    addRequest(requests, { deleteContentRange: { range: { startIndex, endIndex, tabId } } });

  let blockStarts = new Set(sourceMap.blocks.map(block => block.docStart));
  let pairs = alignSourceBlocks(sources, targets, markdown);
  for (let index = pairs.length - 1; index >= 0; index--) {
    let [s, t] = pairs[index];
    let [nextSource, nextTarget] = pairs[index + 1] ?? [sources.length, targets.length];
    let source = sources[s];
    let removed = sources.slice(s + 1, nextSource);
    let last = removed.at(-1);
    if (last && (nextSource < sources.length ||
        blockStarts.has(last.docEnd))) {
      remove(removed[0].docStart, last.docEnd);
    } else if (last) {
      // The paragraph break before a table or at the tab's end can't be deleted, so the kept
      // paragraph merges into it and takes on formatting that must match or be repairable.
      if (source.listId !== undefined && (source.listId !== last.listId ||
          source.listNestingLevel !== last.listNestingLevel)) {
        throw new Error(
          "replaceText: cannot keep a list item while deleting the paragraphs that end its " +
          "section. Delete them in an edit that leaves the list item alone.");
      }
      remove(source.docEnd - 1, last.docEnd - 1);
      let clearList = source.listId === undefined && last.listId !== undefined;
      if (clearList) {
        addRequest(requests, { deleteParagraphBullets: {
          range: { startIndex: source.docStart, endIndex: source.docEnd, tabId },
        } });
      }
      if (clearList || source.namedStyleType !== last.namedStyleType) {
        addRequest(requests, updateParagraphStyleRequest(
          { startIndex: source.docStart, endIndex: source.docEnd, tabId },
          source.namedStyleType, clearList));
      }
    }

    let before = index === 0 ? targets.slice(0, t) : [];
    let after = targets.slice(t + 1, nextTarget);
    if (isUnchangedBlock(source, targets[t], markdown)) {
      keptLengths.set(t, source.docEnd - source.docStart);
      if (after.length > 0) {
        write([parseLine(""), ...after], t, source.docEnd - 1, source,
          { preserveLeadingParagraph: true });
      }
      if (before.length > 0) {
        write(before, 0, source.docStart, source, { preserveTrailingNewline: true });
      }
    } else {
      if (source.docStart < source.docEnd - 1) remove(source.docStart, source.docEnd - 1);
      write([...before, targets[t], ...after], t - before.length, source.docStart, source, {},
        before.length);
    }
  }
  if (pairs[0][0] > 0) remove(sources[0].docStart, sources[pairs[0][0]].docStart);
  let offset = sources[0].docStart;
  addBulletRequests(requests, targets.flatMap((target, index) => {
    let startIndex = offset;
    let isNew = bulleted.has(index);
    offset += keptLengths.get(index) ??
      (isNew ? target.nestingLevel : 0) + target.plainText.length + 1;
    return isNew ? [{ listType: target.listType!, startIndex, endIndex: offset }] : [];
  }), tabId);
  return requests;
}

/**
 * Map a Markdown character range [mdStart, mdEnd) to a Google Docs
 * character range, using the source map.
 *
 * Content segments have 1:1 character mapping between Markdown and Doc.
 * Syntax-only segments (Markdown markers like "**", "# ") have no Doc
 * counterpart. If the range falls entirely within syntax-only segments,
 * we expand to the surrounding content boundaries.
 */
function mdRangeToDocRange(
  sourceMap: SourceMap,
  mdStart: number,
  mdEnd: number,
): DocRange | null {
  if (mdStart === mdEnd) {
    let precedingBlock = sourceMap.blocks.find(block => block.mdEnd === mdStart);
    if (precedingBlock) {
      let index = Math.max(precedingBlock.docStart, precedingBlock.docEnd - 1);
      return { start: index, end: index, startsAfterParagraph: true };
    }
    let docIndex = mdPointToDocIndex(sourceMap, mdStart);
    return docIndex === null ? null : { start: docIndex, end: docIndex };
  }

  let docStart: number | null = null;
  let docEnd: number | null = null;

  for (let block of sourceMap.blocks) {
    // Skip blocks entirely before or after our range.
    if (block.mdEnd <= mdStart) continue;
    if (block.mdStart >= mdEnd) break;

    for (let seg of block.segments) {
      // Skip segments entirely outside our range.
      if (seg.mdEnd <= mdStart) continue;
      if (seg.mdStart >= mdEnd) break;

      if ("syntaxOnly" in seg) {
        // Syntax-only segment overlaps the range. We can't map to doc indices
        // directly, but we need to extend to the nearest content boundary.
        // Use the block's doc range as a fallback.
        if (docStart === null) docStart = block.docStart;
        docEnd = block.docEnd;
        continue;
      }

      // Content segment — compute the overlapping doc range.
      let overlapMdStart = Math.max(mdStart, seg.mdStart);
      let overlapMdEnd = Math.min(mdEnd, seg.mdEnd);

      // 1:1 character mapping within content segments.
      let segDocStart = seg.docStart + (overlapMdStart - seg.mdStart);
      let segDocEnd = seg.docStart + (overlapMdEnd - seg.mdStart);

      if (docStart === null || segDocStart < docStart) docStart = segDocStart;
      if (docEnd === null || segDocEnd > docEnd) docEnd = segDocEnd;
    }
  }

  if (docStart === null || docEnd === null) return null;
  return { start: docStart, end: docEnd };
}

function mdPointToDocIndex(sourceMap: SourceMap, mdPoint: number): number | null {
  for (let block of sourceMap.blocks) {
    if (mdPoint < block.mdStart) continue;
    if (mdPoint > block.mdEnd) continue;

    let preceding: number | undefined;
    for (let seg of block.segments) {
      if ("syntaxOnly" in seg) continue;
      if (mdPoint < seg.mdStart) return preceding ?? seg.docStart;
      if (mdPoint <= seg.mdEnd) return seg.docStart + (mdPoint - seg.mdStart);
      preceding = seg.docEnd;
    }

    if (preceding !== undefined) return preceding;
    return block.docStart;
  }

  return null;
}
