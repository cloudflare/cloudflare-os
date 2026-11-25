// Changes to the tables of a Google Doc tab, worked out on the tab's Markdown rendering: which
// table a change is for, what a change is refused for, and which batchUpdate requests make it in
// the document. Everything here is a pure function of a rendering and of what its tab's
// reading answers of the tab as a whole; nothing mutates its input.

import type { DocsLocation, GoogleDocsRequest, TableCellLocation, TextStyle } from "./docs-api";
import { atGraphemeBoundary, isGoogleDocsStrippedCharacter, joinsGraphemes } from "./docs-content";
import {
  addRequest, canonicalizeMarkdownReplacement, canonicalLinkDestination, cellLinkDestination,
  computeReplaceOperations, docsLinkForDestination, isBlankDocTab, isSafeTableLink, lineStart,
  MAX_GOOGLE_DOC_REQUESTS, plainTextToDocRequests, StructuredContentError,
} from "./markdown-converter";
import { cellStyleSteps, coveredCells, googleCellStyle } from "./docs-table-look";
import type {
  CellBlock, CellLook, CellStyleChange, CellStyleStep, Spans, TableLook,
} from "./docs-table-look";
import type {
  BlockMapping, CellInlineRun, DocTabSnapshot, MarkdownRange, ParagraphSuggestions, TabReading,
  TableCellMapping, TableMapping,
} from "./markdown-converter";

/**
 * The widest table this module makes or widens: a limit of its own, the width the Slides
 * connection stops at too. Google Docs takes wider tables.
 */
export const MAX_TABLE_COLUMNS = 20;

/**
 * The most cells one new row or column may hold. Filling new cells takes longer the larger
 * their table, and a change has to reach Google Docs as one batch that answers in time.
 */
export const MAX_NEW_LINE_CELLS = 500;

/** The most requests one replacement of the text of table cells may send, for the same reason. */
export const MAX_TABLE_TEXT_REQUESTS = 8_000;

/**
 * The most cells the tables of one tab may hold once a table, rows or columns are added to
 * them, a cell counting once for each paragraph it holds. A document is read whole, and one
 * whose tables grow far past this is too large to read back.
 */
export const MAX_TAB_TABLE_CELLS = 5_000;

/** The table a queued change applies to. */
export type TableRef = {
  /**
   * Its HTML then, as the Markdown view showed it with every earlier queued change applied,
   * without its look (`tableIdentity`).
   */
  expected: string;
};

/**
 * What a deletion removes that the Markdown view does not show, by number. The approval card of
 * a deletion shows what is deleted as the view reads, so it says these in words, and the queued
 * change records how many there were: it applies only while what it deletes holds no more of
 * either kind than that.
 */
export type HiddenContent = {
  /** How many elements the deleted cells hold that the view shows nothing for; absent for none. */
  unshown?: number;
  /**
   * How many suggested changes to its rows, columns or cells, or to their text, a table deleted
   * whole holds; absent for none.
   */
  suggested?: number;
};

/** A change to a tab's tables, as stored with its pending action. */
export type TableChange =
  | { type: "insertTable"; rows: number; columns: number; cells: string[][]; after?: string }
  | ({ type: "insertTableRows"; at: number; cells: string[][]; copies?: string; pinned?: number } & TableRef)
  | ({ type: "insertTableColumns"; at: number; cells: string[][] } & TableRef)
  | ({ type: "deleteTableRows"; at: number; count: number } & TableRef & HiddenContent)
  | ({ type: "deleteTableColumns"; at: number; count: number } & TableRef & HiddenContent)
  | ({ type: "deleteTable" } & TableRef & HiddenContent)
  | ({ type: "setTableCellStyle"; style: CellStyleChange } & CellBlock & TableRef)
  | ({ type: "setTableColumnWidths"; at: number; count: number; width: number | null } & TableRef)
  | ({ type: "setTableRowHeights"; at: number; count: number; height: number } & TableRef)
  | ({ type: "mergeTableCells" } & CellBlock & TableRef)
  | ({ type: "unmergeTableCells"; row: number; column: number } & TableRef);

type NewTableChange = Extract<TableChange, { type: "insertTable" }>;
type ExistingTableChange = Exclude<TableChange, NewTableChange>;

/** The changes that set only a table's look, which no table's identity depends on. */
const LOOK_CHANGE_TYPES: readonly string[] =
  ["setTableCellStyle", "setTableColumnWidths", "setTableRowHeights"];

/** A change that sets only a table's look. */
export type LookChange = Extract<
  TableChange, { type: "setTableCellStyle" | "setTableColumnWidths" | "setTableRowHeights" }
>;

/** A change that merges cells, or splits a merged cell. */
type MergeChange = Extract<TableChange, { type: "mergeTableCells" | "unmergeTableCells" }>;

/** A change that adds or deletes rows or columns. */
type LineChange = Exclude<ExistingTableChange, LookChange | MergeChange | { type: "deleteTable" }>;

function isLookChange(change: TableChange): change is LookChange {
  return LOOK_CHANGE_TYPES.includes(change.type);
}

// ---------------------------------------------------------------------------
// A table's size and look
// ---------------------------------------------------------------------------

function notLaidOut(op: string): Error {
  return new Error(
    `${op}: this table is not laid out as Google Docs lays tables out, so it cannot be changed.`);
}

/**
 * The look of a table, for a change that reads it. Throws when the table gives its columns
 * widths and not one for each cell of its first row.
 */
function lookOf(table: TableMapping, op: string): TableLook {
  let { look } = table;
  if (look.columns && look.columns.length !== (table.rows[0]?.cells.length ?? 0)) {
    throw notLaidOut(op);
  }
  return look;
}

/** The size of a table, for a change to its rows or columns. */
function sizeOf(table: TableMapping, op: string): { rows: number; columns: number } {
  let columns = table.rows[0]?.cells.length ?? 0;
  if (columns === 0) throw notLaidOut(op);
  if (table.rows.some(row => row.cells.length !== columns)) {
    throw new Error(
      `${op}: the rows of this table do not all have the same number of cells, so its rows ` +
      "and columns cannot be changed.");
  }
  return { rows: table.rows.length, columns };
}

/**
 * The numbers of rows and columns of the table at `table`, for a change to its rows or columns.
 * Throws when the table has no cells, or its rows differ in length.
 */
export function tableSize(
  render: DocTabSnapshot, table: number, op: string,
): { rows: number; columns: number } {
  return sizeOf(render.sourceMap.tables[table], op);
}

// ---------------------------------------------------------------------------
// The chips a new row copies
// ---------------------------------------------------------------------------

/**
 * What Google copies into each cell of a row added beside row `reference` of the table `target`,
 * one letter a column: `d` a dropdown, `p` a placeholder, `-` nothing. The approval card of a row
 * insertion says what its rows take, and the queued change records this: it applies only while
 * the row it takes after copies the same, which the table's HTML does not show (a dropdown reads
 * as an empty cell).
 */
export function chipCopies(target: TableMapping, reference: number): string {
  return target.rows[reference].cells
    .map(({ copies }) => copies === "dropdown" ? "d" : copies === "placeholder" ? "p" : "-").join("");
}

/**
 * How many rows the table `target` pins as its header, where rows added at its row `at` go among
 * them, or 0: the batch then pins that count again, so the first rows of the table, new ones
 * included, are the header. The approval card says which rows that pins and unpins, and the
 * queued change records it, as for `chipCopies`: the table's HTML does not show a pin. Rows added
 * after the header, the last pinned row's own pin included, change nothing of it (the batch pins
 * the count again where Google gives them the row's pin).
 */
export function pinnedAround(target: TableMapping, at: number): number {
  return target.pinnedRows !== undefined && at < target.pinnedRows ? target.pinnedRows : 0;
}

/**
 * Of `count` rows added at row `at` among a header of `pinned` rows that is pinned again after
 * them: how many of the new rows are in the header, and how many rows that were are no longer.
 */
export function headerAfterInsertion(
  pinned: number, at: number, count: number,
): { added: number; dropped: number } {
  if (at >= pinned) return { added: 0, dropped: 0 };
  return { added: Math.min(at + count, pinned) - at, dropped: pinned - Math.max(at, pinned - count) };
}

/**
 * What Google copies into each cell of a row added beside row `reference` of a table, refusing
 * text given for a cell that takes a chip.
 */
function copiedChips(
  target: TableMapping, reference: number, cells: readonly (readonly string[])[],
): ("dropdown" | "placeholder" | undefined)[] {
  // A cell of several chips copies none of them, and its new cells are plain.
  let copies = target.rows[reference].cells
    .map(cell => cell.copies === "nothing" ? undefined : cell.copies);
  for (let [column, copied] of copies.entries()) {
    if (copied && cells.some(row => (row[column] ?? "") !== "")) {
      throw new Error(
        `insertTableRows: column ${column} of this table, counting from 0, holds a ` +
        `${copied === "dropdown" ? "dropdown" : "smart chip"} alone in row ${reference}, which ` +
        "Google Docs copies into the new rows, so their cells in that column take no text. " +
        "Leave them empty, and change the copies in Google Docs.");
    }
  }
  return copies;
}

// ---------------------------------------------------------------------------
// Which table a change is for
// ---------------------------------------------------------------------------

/**
 * A table's HTML without its look: the style of its `<table>`, `<tr>` and `<td>` tags, and its
 * columns' widths, those of tables in its cells included. A change is kept to its table by this,
 * so a collaborator restyling the table does not undo the changes queued for it.
 */
export function tableIdentity(html: string): string {
  if (!html.includes(' style="') && !html.includes("<colgroup>")) return html;
  return html.replace(/^ *<colgroup>.*\n/gm, "")
    .replace(/(<(?:table|tr|td)(?: rowspan="\d+")?(?: colspan="\d+")?) style="[^"]*"/g, "$1");
}

/**
 * A table's identity without the numbers the renderer counts through the whole tab: where a
 * numbered list in a cell starts, and the number of a footnote. Tables with one shape read
 * the same: they differ at most in their looks and in numbers that an edit elsewhere in the tab
 * can move.
 */
export function tableShape(html: string): string {
  let identity = tableIdentity(html);
  if (!identity.includes(' start="') && !/\[\d/.test(identity)) return identity;
  return identity.replace(/ start="-?\d+"(?=>)/g, "").replace(/\[\d+\]/g, "[]");
}

function htmlOf(render: DocTabSnapshot, table: MarkdownRange): string {
  return render.markdown.slice(table.mdStart, table.mdEnd);
}

/**
 * The nearest line of `markdown` that ends at or before offset `end`, a line start, and is
 * not empty and not part of one of `tables`, without its line break; `undefined` where the
 * Markdown holds none before `end`.
 */
export function lineAbove(
  markdown: string, tables: readonly MarkdownRange[], end: number,
): string | undefined {
  // `at` is the line break that ends the line looked at.
  for (let at = end - 1; at >= 0;) {
    let start = lineStart(markdown, at);
    let inside = tables.find(other => other.mdStart <= start && start < other.mdEnd);
    if (inside) {
      at = inside.mdStart - 1;
    } else if (start < at) {
      return markdown.slice(start, at);
    } else {
      at = start - 1;
    }
  }
  return undefined;
}

/**
 * What the builders ask of the tab `render` renders whole, answered from that rendering:
 * `piece` answers the rendering itself for every own range, with `part` saying it is the
 * whole tab.
 */
export function wholeTabReading(render: DocTabSnapshot): TabReading {
  let { markdown } = render;
  let { tables, blocks } = render.sourceMap;
  let whole: DocTabSnapshot | undefined;
  let tab: TabReading = {
    tabId: render.tabId,
    blank: () => isBlankDocTab(render),
    find(text, lineBreakBefore) {
      // The place a line break before the Markdown starts: the text's own first line break
      // there, and the rest of it at the Markdown's start.
      let before = !!lineBreakBefore && text.startsWith("\n") && markdown.startsWith(text.slice(1));
      let first = before ? -1 : markdown.indexOf(text);
      if (!before && first < 0) return "none";
      return markdown.indexOf(text, first + 1) < 0 ? first : "many";
    },
    tables() {
      let cells = 0;
      for (let table of tables) cells += tableCellCount(htmlOf(render, table));
      return { count: tables.length, cells };
    },
    tablesShaped(shape) {
      let found: number[] = [];
      for (let [index, table] of tables.entries()) {
        if (tableShape(htmlOf(render, table)) !== shape) continue;
        found.push(index);
        if (found.length === 2) break;
      }
      return found;
    },
    numberedAfter(table) {
      let target: MarkdownRange | undefined = tables[table];
      if (!target) return false;
      let { mdEnd } = target;
      return tables.slice(table + 1).some(later => htmlOf(render, later).includes("<ol")) ||
        blocks.some(block => block.mdStart >= mdEnd && block.listType === "numbered");
    },
    lineBefore: mdStart => lineAbove(markdown, tables, mdStart),
    piece: () => whole ??= {
      ...render,
      part: {
        mdStart: 0, tablesBefore: 0, first: true, last: true,
        inner: { from: 0, to: render.bodyEndIndex }, tab,
      },
    },
  };
  return tab;
}

/**
 * The reading of the tab `source` is of: `source` itself where it is one, the reading a
 * part was cut for (`part.tab`), or the whole rendering's own (`wholeTabReading`).
 */
export function tabOf(source: DocTabSnapshot | TabReading): TabReading {
  if (!("sourceMap" in source)) return source;
  return source.part?.tab ?? wholeTabReading(source);
}

/** The refusal of a change whose table reads otherwise than it did, or is gone. */
function readsOtherwise(op: string): Error {
  return new Error(
    `${op}: the table no longer reads as it did when this change was queued, or it is gone.`);
}

/**
 * The number, from 0, of the one table of the tab `tab` reads that has the shape of a
 * reference recorded (`tableShape`): the half of `resolveTable` that asks the tab as a whole.
 * Throws when no table has it, or more than one.
 */
function tableNumbered(tab: TabReading, ref: TableRef, op: string): number {
  let shaped = tab.tablesShaped(tableShape(ref.expected));
  if (shaped.length > 1) {
    throw new Error(
      `${op}: another table of the tab now reads the same as the table this change was ` +
      "queued for, so the change can no longer be kept to it.");
  }
  if (shaped.length === 0) throw readsOtherwise(op);
  return shaped[0];
}

/**
 * The place, among the rendering's tables, of the tab's table `number`, which `tableNumbered`
 * found for a reference recorded. Throws when that table no longer reads exactly as recorded,
 * its look aside.
 */
function tablePlace(render: DocTabSnapshot, number: number, ref: TableRef, op: string): number {
  // WHERE A TABLE'S NUMBER BECOMES ITS PLACE, for a table found by how it reads: the tab
  // numbers its tables through the whole of it, and a part holds those from its own on.
  let found = number - (render.part?.tablesBefore ?? 0);
  let table: MarkdownRange | undefined = render.sourceMap.tables[found];
  if (!table) throw new Error("A piece does not hold the table its change names.");
  if (tableIdentity(htmlOf(render, table)) !== ref.expected) throw readsOtherwise(op);
  return found;
}

/**
 * The place, among the rendering's tables, of the one table of the rendering's tab that reads
 * the same as a reference recorded. Throws when none does, when more than one does, or when
 * the one that does no longer reads exactly as recorded, its look aside. The two halves a
 * change's builder makes apart (`tableNumbered` of the tab, then `tablePlace` in the piece
 * around that table), composed on one rendering, which tests hold: nothing that reads or
 * edits a document calls it.
 */
export function resolveTable(render: DocTabSnapshot, ref: TableRef, op: string): number {
  return tablePlace(render, tableNumbered(tabOf(render), ref, op), ref, op);
}

/** What a deletion asks of its table: which rows or columns go, or the whole table. */
export type TableDeletionShape =
  | { type: "deleteTableRows" | "deleteTableColumns"; at: number; count: number }
  | { type: "deleteTable" };

/**
 * What the deletion `shape` asks of the table at `table` would remove that the rendering does
 * not show.
 */
export function hiddenContent(
  render: DocTabSnapshot, table: number, shape: TableDeletionShape,
): HiddenContent {
  let target = render.sourceMap.tables[table];
  let rows = target.rows.map(row => row.cells);
  let cells = shape.type === "deleteTable" ? rows.flat()
    : shape.type === "deleteTableRows" ? rows.slice(shape.at, shape.at + shape.count).flat()
    : rows.flatMap(row => row.slice(shape.at, shape.at + shape.count));
  let unshown = cells.reduce((count, cell) => count + cell.unshown, 0);
  return {
    ...(unshown > 0 ? { unshown } : {}),
    ...(shape.type === "deleteTable" && target.suggested ? { suggested: target.suggested } : {}),
  };
}

/**
 * The place, among the rendering's tables, of the table a queued change applies to: the
 * tab's table `number`, the one that reads as the change recorded (`tableNumbered`). A
 * deletion is refused there when what it would remove has come to hold more of what the view
 * does not show than the change recorded: its table still reads as recorded, and its approval
 * card says nothing of what more would go with it.
 */
function targetOf(render: DocTabSnapshot, change: ExistingTableChange, number: number): number {
  let op = change.type;
  let table = tablePlace(render, number, change, op);
  if (change.type === "insertTableRows" && change.copies !== undefined) {
    let rows = render.sourceMap.tables[table].rows.length;
    let reference = change.at < rows ? change.at : rows - 1;
    if (chipCopies(render.sourceMap.tables[table], reference) !== change.copies) {
      throw new Error(
        `${op}: the row the new rows take after has come to hold, or no longer holds, a ` +
        "dropdown or other smart chip that Google Docs copies into them, which getContent() " +
        "does not show, since this change was queued.");
    }
  }
  if (change.type === "insertTableRows" && change.pinned !== undefined) {
    if (pinnedAround(render.sourceMap.tables[table], change.at) !== change.pinned) {
      throw new Error(
        `${op}: the table's pinned header rows around the new rows have changed since this ` +
        "change was queued, which getContent() does not show.");
    }
  }
  if (change.type === "insertTableRows" || change.type === "insertTableColumns" ||
      change.type === "mergeTableCells" || change.type === "unmergeTableCells" ||
      isLookChange(change)) return table;
  let hidden = hiddenContent(render, table, change);
  if ((hidden.unshown ?? 0) > (change.unshown ?? 0)) {
    throw new Error(
      `${op}: what would be deleted has come to hold a dropdown or other smart chips, which ` +
      "getContent() does not show, since this change was queued.");
  }
  if ((hidden.suggested ?? 0) > (change.suggested ?? 0)) {
    throw new Error(
      `${op}: this table has come to hold suggested changes to its rows, columns or cells, or ` +
      "to their text, since this change was queued.");
  }
  return table;
}

const TABLE_CHANGE_TYPES: readonly string[] = [
  "insertTable", "insertTableRows", "insertTableColumns", "deleteTableRows",
  "deleteTableColumns", "deleteTable", "mergeTableCells", "unmergeTableCells",
  ...LOOK_CHANGE_TYPES,
];

/**
 * Whether a stored change changes a table of its tab: a table change, or a replacement in table
 * cells.
 */
export function changesTables(change: { type: string; inTable?: true }): boolean {
  return TABLE_CHANGE_TYPES.includes(change.type) ||
    change.type === "replaceText" && change.inTable === true;
}

/** Whether a stored change names its table by how the table read: a change to an existing table. */
export function namesTable(change: { type: string }): boolean {
  return change.type !== "insertTable" && TABLE_CHANGE_TYPES.includes(change.type);
}

/**
 * Whether a change that failed to replay leaves its tab's tables otherwise than the later changes
 * recorded them: a change to tables other than to a table's look, which the records leave out.
 */
export function closesTableGate(change: { type: string; inTable?: true }): boolean {
  return changesTables(change) && !LOOK_CHANGE_TYPES.includes(change.type);
}

/** The refusal of a change of type `type` that names a table behind a table change that failed. */
export function tableGateRefusal(type: string): Error {
  return new Error(
    `${type}: an earlier queued change to this tab's tables no longer applies, and ` +
    "this change named its table among the tables as that one left them.");
}

// ---------------------------------------------------------------------------
// Reading a rendering: a table's protected range, and what a line is
// ---------------------------------------------------------------------------

/** The protected range of a table: the one that starts at or before it and ends after it. */
function tableRange(render: DocTabSnapshot, table: MarkdownRange): MarkdownRange | undefined {
  return render.sourceMap.protectedRanges.find(range =>
    range.mdStart <= table.mdStart && range.mdEnd > table.mdEnd);
}

/**
 * What the block whose line starts at `start` is. A line no table and no paragraph starts at is
 * a table of contents or a section break.
 */
function blockAt(render: DocTabSnapshot, start: number): "table" | "structure" | "paragraph" {
  let { tables, blocks } = render.sourceMap;
  if (tables.some(table => table.mdStart === start)) return "table";
  return blocks.some(block => block.mdStart === start) ? "paragraph" : "structure";
}

// ---------------------------------------------------------------------------
// The checks a change makes against its table and its tab
// ---------------------------------------------------------------------------

/** What a change to an existing table asks of it, apart from the text of new cells. */
export type TableChangeShape =
  | {
    type: "insertTableRows" | "insertTableColumns" | "deleteTableRows" | "deleteTableColumns";
    at: number;
    count: number;
  }
  | { type: "deleteTable" };

type LineChangeShape = Exclude<TableChangeShape, { type: "deleteTable" }>;

function shapeOf(change: LineChange): LineChangeShape {
  switch (change.type) {
    case "insertTableRows":
      return { type: change.type, at: change.at, count: change.cells.length };
    case "insertTableColumns":
      return { type: change.type, at: change.at, count: change.cells[0]?.length ?? 0 };
    default:
      return { type: change.type, at: change.at, count: change.count };
  }
}

/**
 * Refuse a deletion for what it removes: a footnote, whose removal renumbers the footnotes after
 * it, or items of a numbered list while an ordered list is rendered after them, which the
 * deletion could renumber. `removed` are the ranges taken out of the table at `table`, in order.
 */
function checkRemovedCells(
  render: DocTabSnapshot, table: number, cells: readonly TableCellMapping[],
  removed: readonly MarkdownRange[], op: string,
): void {
  if (cells.some(cell => cell.footnote)) {
    throw new Error(
      `${op}: what would be deleted holds a footnote. Deleting a footnote renumbers those ` +
      "after it, which is not supported.");
  }
  if (!cells.some(cell => cell.numbered) || removed.length === 0) return;
  let { markdown } = render;
  let target = render.sourceMap.tables[table];
  // What stays of the table after the first removed range.
  let kept: MarkdownRange[] = [];
  for (let [index, range] of removed.entries()) {
    kept.push({ mdStart: range.mdEnd, mdEnd: removed[index + 1]?.mdStart ?? target.mdEnd });
  }
  let listInTable = kept.some(range => markdown.slice(range.mdStart, range.mdEnd).includes("<ol"));
  // Every table after it and every paragraph after it are the tab's to say: WHERE THE TABLE'S
  // PLACE BECOMES ITS NUMBER for what follows it.
  if (listInTable ||
      tabOf(render).numberedAfter(table + (render.part?.tablesBefore ?? 0))) {
    throw new Error(
      `${op}: what would be deleted holds items of a numbered list, and a numbered list ` +
      "follows it in the tab, which the deletion could renumber. That is not supported.");
  }
}

/**
 * Refuse a change to rows or columns that crosses a merged cell. Google Docs grows a merged cell
 * that rows or columns are added through, merges the lines it copies from one, and moves or
 * shrinks one whose lines are deleted (probe M5), which the model a queued change replays with
 * does not follow. Lines that cross none leave the merged cells where they are.
 */
function checkMergesAside(table: TableMapping, shape: LineChangeShape, limit: number): void {
  let op = shape.type;
  let ofRows = op === "insertTableRows" || op === "deleteTableRows";
  let inserts = op === "insertTableRows" || op === "insertTableColumns";
  let { at, count } = shape;
  // The lines the change crosses: the one new lines copy, or those it deletes.
  let first = inserts ? Math.min(at, limit - 1) : at;
  let last = inserts ? first : at + count - 1;
  let covered = coveredCells(table.rows.map(row => row.cells));
  for (let [r, row] of table.rows.entries()) {
    for (let [c, { rowSpan, columnSpan }] of row.cells.entries()) {
      if (covered[r][c] || rowSpan === 1 && columnSpan === 1) continue;
      let start = ofRows ? r : c;
      let end = start + (ofRows ? rowSpan : columnSpan) - 1;
      if (end < first || start > last) continue;
      let noun = ofRows ? "row" : "column";
      throw new Error(inserts
        ? `${op}: ${noun} ${first} of this table, counting from 0, which the new ${noun}s ` +
          `copy, crosses the merged cell at row ${r}, column ${c}, which Google Docs would ` +
          `grow or copy into them. ${capitalized(noun)}s can be added only beside ${noun}s ` +
          "that cross no merged cell."
        : `${op}: the ${noun}s to delete cross the merged cell at row ${r}, column ${c} ` +
          `(counting from 0). Split it with unmergeTableCells() first, or delete ${noun}s ` +
          "that cross no merged cell.");
    }
  }
}

const capitalized = (word: string): string => word[0].toUpperCase() + word.slice(1);

/** The checks of a change to the rows or columns of the table at `table`, which give its size. */
function checkLineChange(
  render: DocTabSnapshot, table: number, shape: LineChangeShape,
): { rows: number; columns: number } {
  let op = shape.type;
  let target = render.sourceMap.tables[table];
  let { rows, columns } = sizeOf(target, op);

  if (target.suggested) {
    throw new Error(
      `${op}: this table holds suggested changes to its rows, columns or cells, or to their ` +
      "text, so its rows and columns cannot be changed until they are accepted or rejected.");
  }
  let ofRows = op === "insertTableRows" || op === "deleteTableRows";
  let limit = ofRows ? rows : columns;
  let { at, count } = shape;
  if (op === "insertTableRows" || op === "insertTableColumns") {
    if (at > limit) {
      throw new Error(
        `${op}: at must be from 0 to ${limit}, the table's number of ` +
        `${ofRows ? "rows" : "columns"}.`);
    }
  } else {
    if (at + count > limit) {
      throw new Error(
        `${op}: at and count must name ${ofRows ? "rows" : "columns"} of the table, which ` +
        `has ${limit}.`);
    }
    if (count >= limit) {
      throw new Error(
        `${op}: this would delete every ${ofRows ? "row" : "column"} of the table. Use ` +
        "deleteTable() to delete the table.");
    }
    if (count > MAX_GOOGLE_DOC_REQUESTS) {
      throw new Error(
        `${op}: deleting ${count} ${ofRows ? "rows" : "columns"} needs more than ` +
        `${MAX_GOOGLE_DOC_REQUESTS} requests, the most one change may send. Delete them in ` +
        "several calls.");
    }
  }

  checkMergesAside(target, shape, limit);

  if (op === "insertTableRows") {
    let reference = at < rows ? at : rows - 1;
    if (target.rows[reference].cells.some(cell => cell.loneChip && !cell.copies)) {
      throw new Error(
        `insertTableRows: row ${reference} of this table, counting from 0, has a cell that ` +
        "holds smart chips and no text, which Google Docs copies into a row added beside it in " +
        "a way that is not supported: add the row in Google Docs.");
    }
    if (columns > MAX_NEW_LINE_CELLS) {
      throw new Error(
        `insertTableRows: rows can be added only to a table of at most ${MAX_NEW_LINE_CELLS} ` +
        `columns, and this one has ${columns}.`);
    }
  } else if (op === "insertTableColumns") {
    if (columns + count > MAX_TABLE_COLUMNS) {
      throw new Error(
        `insertTableColumns: columns can be added only until a table has ${MAX_TABLE_COLUMNS}, ` +
        `and this one would have ${columns + count}.`);
    }
    if (rows > MAX_NEW_LINE_CELLS) {
      throw new Error(
        "insertTableColumns: columns can be added only to a table of at most " +
        `${MAX_NEW_LINE_CELLS} rows, and this one has ${rows}.`);
    }
  } else if (op === "deleteTableRows") {
    checkRemovedCells(
      render, table, target.rows.slice(at, at + count).flatMap(row => row.cells),
      [{ mdStart: target.rows[at].mdStart, mdEnd: target.rows[at + count - 1].mdEnd }], op);
  } else {
    checkRemovedCells(
      render, table, target.rows.flatMap(row => row.cells.slice(at, at + count)),
      target.rows.map(row => ({
        mdStart: row.cells[at].mdStart, mdEnd: row.cells[at + count - 1].mdEnd,
      })), op);
  }
  return { rows, columns };
}

/**
 * The checks of the deletion of the table at `table`: a paragraph on each side of the table,
 * which are not two items of one list, and nothing in the table whose removal renumbers what
 * follows.
 */
function checkTableDeletion(render: DocTabSnapshot, table: number): void {
  let op = "deleteTable";
  let { markdown } = render;
  let { tables, blocks } = render.sourceMap;
  let target = tables[table];
  let separator = target.mdStart - 1;
  let after = target.mdEnd + 2;
  // A part's own ends stand for the tab's in the two comparisons with them: it holds two
  // steps on each side of the table, so the table opens it, or it ends with the two
  // characters after the table, only where the tab does.
  if (separator < 1 || markdown[separator - 1] !== "\n" || markdown[separator] !== "\n" ||
      markdown[target.mdEnd] !== "\n" || markdown[target.mdEnd + 1] !== "\n" ||
      after >= markdown.length || tables.some(other => other.mdEnd === separator - 1)) {
    throw notLaidOut(op);
  }
  let before = lineStart(markdown, separator - 1);
  if (blockAt(render, before) !== "paragraph" || blockAt(render, after) !== "paragraph") {
    throw notLaidOut(op);
  }
  let blockBefore = blocks.find(block => block.docEnd === target.docStart);
  let blockAfter = blocks.find(block => block.docStart === target.docEnd);
  if (!blockBefore || !blockAfter) throw notLaidOut(op);
  if (blockBefore.listId !== undefined && blockBefore.listId === blockAfter.listId) {
    throw new Error(
      "deleteTable: this table sits between two items of one list, which deleting it would " +
      "join. That is not supported.");
  }
  checkRemovedCells(render, table, target.rows.flatMap(row => row.cells), [target], op);
}

/**
 * Refuse a change for what the table at position `table` among the rendering's tables is or
 * holds: every check the change's requests are built behind once its table is found.
 */
export function checkTableTarget(
  render: DocTabSnapshot, table: number, shape: TableChangeShape,
): void {
  if (shape.type === "deleteTable") checkTableDeletion(render, table);
  else checkLineChange(render, table, shape);
}

// ---------------------------------------------------------------------------
// Suggested text
// ---------------------------------------------------------------------------

/** The refusal of the text edit `op`, whose batch touches what a suggestion holds. */
function suggestionRefusal(op: string): Error {
  return new Error(
    `${op}: the text this change touches holds suggested changes, made in suggesting mode: ` +
    "text a suggestion inserts or deletes, which getContent() marks {++…++} and {--…--} " +
    "(<ins> and <del> in a table), or a suggested change to the style of the text or of its " +
    "paragraph or list item, which it does not show. The change would discard them, or make " +
    "its own text part of one. They must be accepted or rejected in Google Docs first, or the " +
    "change kept clear of them.");
}

/** A paragraph that holds suggestions, as the check of a batch moves it along the batch. */
type HeldParagraph = {
  start: number;
  end: number;
  readonly own: boolean;
  readonly runs: { start: number; end: number }[];
};

/** How many characters `text` adds once Google has removed what it strips from inserted text. */
function writtenLength(text: string): number {
  let length = 0;
  for (let index = 0; index < text.length; index++) {
    if (!isGoogleDocsStrippedCharacter(text.charCodeAt(index))) length++;
  }
  return length;
}

/**
 * Throws `suggestionRefusal` where `requests`, the batch of the text edit `op` built from
 * `piece`, would touch what a suggestion holds in the piece (`ParagraphSuggestions`, of its
 * paragraphs and of the paragraphs of its tables' cells): a deletion or a text style that
 * reaches suggested text, text inserted strictly inside it, or, on a paragraph whose style or
 * bullet a suggestion changes, a paragraph or bullet request, a line break inserted into it
 * or the deletion of its own. A style named on a paragraph restyles its text, so it counts as
 * a text style on every suggested run of the paragraph. Each request is read where the
 * requests before it left what it names. A request no text edit sends, and anything after a
 * bullet request (which may take tabs off that no request states), is left to the model of
 * the batch, which refuses what it does not know of suggestions.
 */
export function refuseSuggestionsTouched(
  piece: DocTabSnapshot, requests: readonly GoogleDocsRequest[], op: string,
): void {
  let held: HeldParagraph[] = [];
  let take = (found: ParagraphSuggestions | undefined) => {
    if (!found) return;
    held.push({
      start: found.docStart, end: found.docEnd, own: !!found.own,
      runs: found.runs.map(run => ({ start: run.docStart, end: run.docEnd })),
    });
  };
  // The piece's own entries, told by where they stand: its first element ends where its inner
  // range starts, and its last starts where that ends.
  let inner = piece.part?.inner;
  let own = (entry: { docStart: number; docEnd: number }) =>
    !inner || entry.docEnd >= inner.from && entry.docStart <= inner.to;
  for (let block of piece.sourceMap.blocks) if (own(block)) take(block.suggested);
  for (let table of piece.sourceMap.tables) {
    if (!own(table)) continue;
    for (let row of table.rows) {
      for (let cell of row.cells) for (let found of cell.suggested ?? []) take(found);
    }
  }
  if (held.length === 0) return;

  for (let request of requests) {
    if ("insertText" in request) {
      let { location: { index }, text } = request.insertText;
      for (let paragraph of held) {
        if (paragraph.runs.some(run => run.start < index && index < run.end) ||
            paragraph.own && text.includes("\n") && paragraph.start <= index &&
              index < paragraph.end) {
          throw suggestionRefusal(op);
        }
      }
      // Text inserted where a run starts goes before it.
      let length = writtenLength(text);
      for (let paragraph of held) {
        if (index < paragraph.start) paragraph.start += length;
        if (index < paragraph.end) paragraph.end += length;
        for (let run of paragraph.runs) {
          if (index > run.start) continue;
          run.start += length;
          run.end += length;
        }
      }
      continue;
    }
    if ("deleteContentRange" in request) {
      let { startIndex: from, endIndex: to } = request.deleteContentRange.range;
      for (let paragraph of held) {
        let lineBreak = paragraph.end - 1;
        if (paragraph.runs.some(run => run.start < to && from < run.end) ||
            paragraph.own && from <= lineBreak && lineBreak < to) {
          throw suggestionRefusal(op);
        }
      }
      let moved = (at: number) => at <= from ? at : at >= to ? at - (to - from) : from;
      for (let paragraph of held) {
        paragraph.start = moved(paragraph.start);
        paragraph.end = moved(paragraph.end);
        for (let run of paragraph.runs) {
          run.start = moved(run.start);
          run.end = moved(run.end);
        }
      }
      continue;
    }
    if ("updateTextStyle" in request) {
      let { range: { startIndex: from, endIndex: to }, fields } = request.updateTextStyle;
      // A style that ends where a paragraph's final line break begins reaches the break too,
      // but for a link: Google sets none on a line break.
      let reachesBreak = fields.split(",").some(field => field !== "link");
      for (let paragraph of held) {
        let reach = reachesBreak && to === paragraph.end - 1 ? paragraph.end : to;
        if (paragraph.runs.some(run => run.start < reach && from < run.end)) {
          throw suggestionRefusal(op);
        }
      }
      continue;
    }
    let range = "updateParagraphStyle" in request ? request.updateParagraphStyle.range
      : "createParagraphBullets" in request ? request.createParagraphBullets.range
      : "deleteParagraphBullets" in request ? request.deleteParagraphBullets.range
      : undefined;
    if (!range) return;
    let { startIndex: from, endIndex: to } = range;
    let restyles = "updateParagraphStyle" in request &&
      request.updateParagraphStyle.fields.split(",").includes("namedStyleType");
    for (let paragraph of held) {
      if (paragraph.start < Math.max(to, from + 1) && from < paragraph.end &&
          (paragraph.own || restyles && paragraph.runs.length > 0)) {
        throw suggestionRefusal(op);
      }
    }
    if ("createParagraphBullets" in request) return;
  }
}

/**
 * How many cells a change adds to the tables of its tab, a cell counting once for each
 * paragraph of its text: 0 for a change that adds none.
 */
export function addedTableCells(change: TableChange): number {
  if (change.type !== "insertTable" && change.type !== "insertTableRows" &&
      change.type !== "insertTableColumns") return 0;
  let added = 0;
  for (let row of change.cells) {
    for (let text of row) added += text.split("\n").length;
  }
  return added;
}

// A cell opens or closes, or one of its paragraphs starts: a list item, the heading it may be
// written as aside, a paragraph or heading outside a list, or a paragraph of only a rule, which
// reads as a bare <hr> starting the cell or a line of it. The item a list that skips a level
// opens to hold the next one reads as an empty item followed by its child does, so it counts too:
// the budget may refuse a little early, but never lets a paragraph through uncounted.
const CELL_PARTS = /<td[ >]|<\/td>|<li>|(?<!<li>)<(?:p|h[1-6])>|(?<=<td[^>]*>|\n *)<hr>/g;

/**
 * The cells a table's HTML holds, each counting once for each paragraph of its own, and at least
 * once: those of the tables inside its cells count as their own cells.
 */
export function tableCellCount(html: string): number {
  let open: number[] = [];
  let count = 0;
  for (let [part] of html.matchAll(CELL_PARTS)) {
    if (part.startsWith("<td")) open.push(0);
    else if (part === "</td>") count += Math.max(1, open.pop() ?? 0);
    else if (open.length > 0) open[open.length - 1]++;
  }
  return count;
}

/**
 * Refuse an addition of `added` cells that would take the tables of the tab `source` is of
 * (`tabOf`) past the cells they may hold in all.
 */
export function checkTabTableCells(
  source: DocTabSnapshot | TabReading, added: number, op: string,
): void {
  if (added === 0) return;
  // Every paragraph a table's HTML shows counts, those of tables inside its cells and those no
  // replacement can edit included: the whole document has to be read back.
  let held = tabOf(source).tables().cells;
  if (held + added > MAX_TAB_TABLE_CELLS) {
    throw new Error(
      `${op}: tables, rows and columns can be added, and cells merged, only until the tables of ` +
      `a tab hold ${MAX_TAB_TABLE_CELLS} cells in all, a cell counting once for each paragraph in it, ` +
      `and those of this tab would hold ${held + added}.`);
  }
}

// ---------------------------------------------------------------------------
// Where a new table goes
// ---------------------------------------------------------------------------

/**
 * Where an `after` text ends in the Markdown of the tab `tab` reads: the position of its last
 * character that is not a line break. It is searched as if a line break stood in front of the
 * Markdown, so that a line break at its start stands for the start of a line, the first line
 * included.
 */
function findAnchor(tab: TabReading, after: string): number {
  let last = after.length - 1;
  while (last >= 0 && after[last] === "\n") last--;
  let found = last < 0 ? "none" : tab.find(after, true);
  if (found === "none") {
    throw new Error(
      "insertTable: after was not found in the tab. Make sure the text exactly matches " +
      "content returned by getContent().");
  }
  if (found === "many") {
    throw new Error(
      "insertTable: after matches multiple locations in the tab. To make the match unique, " +
      "include more of the text before it, a line break before it for the start of its line, " +
      "or the line break that ends its paragraph.");
  }
  return found + last;
}

/**
 * Where a new table goes: the piece of the tab its place was found in and, in that piece,
 * after the table at `table`, or after a paragraph. `block` is the paragraph the table
 * splits: the paragraph after the anchor table, or the anchor paragraph, when a paragraph
 * starts at the anchor's line.
 */
type NewTablePlace = { piece: DocTabSnapshot; table?: number; block?: BlockMapping };

const POSITIONED_IMAGE = "insertTable: a table cannot be added beside a paragraph that holds " +
  "a positioned image. Name other text for the table to follow.";

/**
 * Find where a new table goes in the tab `tab` reads, and refuse the places it cannot go:
 * the tab's end, on the piece there, or the one place `after` ends at, found in the tab as a
 * whole, on the piece around it.
 */
function newTablePlace(tab: TabReading, after: string | undefined): NewTablePlace {
  if (after === undefined) {
    // The piece at the tab's end ends where the tab does: its last line is the tab's.
    let piece = tab.piece("end");
    let { markdown } = piece;
    let { tables, blocks } = piece.sourceMap;
    let end = markdown.length;
    let start = lineStart(markdown, end - 1);
    let block = blocks.find(candidate => candidate.mdStart === start);
    if (tables.at(-1)?.mdEnd === end - 1 || blockAt(piece, start) !== "paragraph" ||
        block?.docEnd !== piece.bodyEndIndex) {
      throw new Error(
        "insertTable: the selected tab does not end in a paragraph. Name the text the table " +
        "should follow.");
    }
    return { piece, ...checkSplitAtEnd(block) };
  }

  let found = findAnchor(tab, after);
  let piece = tab.piece({ markdown: { mdStart: found, mdEnd: found + 1 } });
  // The piece's Markdown starts where its part says: the one place the anchor's offset in
  // the tab becomes its offset in the piece.
  let anchor = found - (piece.part?.mdStart ?? 0);
  let { markdown } = piece;
  let { tables, blocks } = piece.sourceMap;
  let table = tables.findIndex(candidate =>
    candidate.mdStart <= anchor && anchor < candidate.mdEnd);
  if (table >= 0) {
    let target = tables[table];
    let next = target.mdEnd + 2;
    // A part's own end stands for the tab's: it holds two steps after the table, so it ends
    // with the two characters after the table only where the tab does.
    if (markdown[target.mdEnd] !== "\n" || markdown[target.mdEnd + 1] !== "\n" ||
        next >= markdown.length || blockAt(piece, next) !== "paragraph") {
      throw notLaidOut("insertTable");
    }
    let block = blocks.find(candidate => candidate.docStart === target.docEnd);
    if (!block) throw notLaidOut("insertTable");
    // The paragraph is cut at its start: an image anchored to it would stay before the table.
    if (block.positioned) throw new Error(POSITIONED_IMAGE);
    return { piece, table, block };
  }

  let start = lineStart(markdown, anchor);
  if (blockAt(piece, start) === "structure") {
    throw new Error(
      "insertTable: a table cannot follow a table of contents or a section break. Name a " +
      "paragraph instead.");
  }
  let block = blocks.find(candidate => candidate.mdStart === start);
  let nextBlock = block && blocks.find(candidate => candidate.docStart === block.docEnd);
  if (block?.listId !== undefined && nextBlock?.listId === block.listId) {
    throw new Error(
      "insertTable: a table cannot be added between two items of a list. Name the list's " +
      "last item instead.");
  }
  return { piece, ...checkSplitAtEnd(block) };
}

/**
 * The index a new table is inserted at, for the place `newTablePlace` found: the one
 * expression of it, which the builder's request and the new table's number both come from.
 */
function newTableIndex(place: NewTablePlace, after: string | undefined): number {
  if (place.table !== undefined) return place.piece.sourceMap.tables[place.table].docEnd;
  if (after === undefined) return place.piece.bodyEndIndex - 1;
  // A line of the tab that no paragraph starts at was refused as a table of contents.
  if (!place.block) throw notLaidOut("insertTable");
  return place.block.docEnd - 1;
}

/**
 * The number, from 0, the table `change` adds has in the tab `tab` reads once it is added:
 * the tables before the piece its place is found in, and the piece's tables that start at
 * or before the index it is inserted at. THE ONE PLACE an inserted table's number is made.
 * Asked once the edit is made (its refusals are the edit's, thrown before): the reading
 * answers the piece it remembers, or makes it again where the edit let go of it, which
 * decodes and renders the closure's runs a second time after one more pass over the
 * summaries to the piece's place; the anchor's place is the reading's to remember, so no
 * Markdown is scanned again.
 */
export function insertedTableNumber(
  tab: TabReading, change: Extract<TableChange, { type: "insertTable" }>,
): number {
  let place = newTablePlace(tab, change.after);
  let index = newTableIndex(place, change.after);
  let { piece } = place;
  return (piece.part?.tablesBefore ?? 0) +
    piece.sourceMap.tables.filter(before => before.docStart <= index).length;
}

/**
 * Refuse a table after a paragraph that holds a positioned image and nothing else: cut at its
 * line break, such a paragraph is cut at its start.
 */
function checkSplitAtEnd(block: BlockMapping | undefined): { block?: BlockMapping } {
  if (block?.positioned && block.docEnd - block.docStart === 1) throw new Error(POSITIONED_IMAGE);
  return { block };
}

// ---------------------------------------------------------------------------
// Merging cells
// ---------------------------------------------------------------------------

/** The cells' spans and the look of a table that passed the checks of a merge or a split. */
type CheckedMerge = { spans: Spans[][]; look: TableLook };

function checkMerge(render: DocTabSnapshot, table: number, change: MergeChange): CheckedMerge {
  let op = change.type;
  let target = render.sourceMap.tables[table];
  if (target.suggested) {
    throw new Error(
      `${op}: this table holds suggested changes to its rows, columns or cells, or to their ` +
      "text, so its cells cannot be merged or split until they are accepted or rejected.");
  }
  let block: CellBlock;
  if (change.type === "mergeTableCells") {
    block = change;
  } else {
    let { row, column } = change;
    let { rows, columns } = sizeOf(target, op);
    if (row >= rows || column >= columns) {
      throw new Error(
        `unmergeTableCells: row and column must name a cell of the table, which has ${rows} ` +
        `rows and ${columns} columns.`);
    }
    let { rowSpan, columnSpan } = target.rows[row].cells[column];
    if (coveredCells(target.rows.map(line => line.cells))[row][column] ||
        rowSpan === 1 && columnSpan === 1) {
      throw new Error(
        `unmergeTableCells: no merged cell starts at row ${row}, column ${column} (counting ` +
        "from 0). Name the top-left cell of the merged cell.");
    }
    block = { row, column, rows: rowSpan, columns: columnSpan };
  }
  let spans = checkCellBlock(render, table, block, op);
  let look = lookOf(target, op);
  let covered = coveredCells(spans);
  if (change.type === "unmergeTableCells") return { spans, look };
  let { row, column, rows, columns } = change;
  for (let r = row; r < row + rows; r++) {
    for (let c = column; c < column + columns; c++) {
      if (covered[r][c]) continue;
      let cell = target.rows[r].cells[c];
      let at = `row ${r}, column ${c} (counting from 0)`;
      if (cell.nested || cell.footnote || cell.unshown || cell.loneChip) {
        throw new Error(
          `mergeTableCells: the cell at ${at} holds a table, a footnote, a smart chip or an ` +
          "element getContent() does not show, which merging cells does not support.");
      }
      if (cell.positioned) {
        throw new Error(
          `mergeTableCells: the cell at ${at} holds a positioned image, whose anchor merging ` +
          "cells is not known to keep. Merge these cells in Google Docs.");
      }
      if (cell.lines > 1 && cell.emptyParagraph) {
        throw new Error(
          `mergeTableCells: the cell at ${at} holds an empty paragraph beside others, which ` +
          "merging cells does not support. Remove it first.");
      }
      if (r === row && c === column) {
        let empty = cell.texts.every(text => text.mdStart === text.mdEnd);
        if (cell.styled && cell.lines === 1 && empty) {
          throw new Error(
            `mergeTableCells: the cell at ${at} is an empty heading or list item, which ` +
            "merging cells does not support. Give it text, or make it a plain paragraph.");
        }
      } else if (cell.styled || cell.numbered) {
        throw new Error(
          `mergeTableCells: the cell at ${at} starts with a heading, a list item or a subtitle, ` +
          "or holds a numbered list. Only the top-left cell of the block may.");
      }
    }
  }
  return { spans, look };
}

/**
 * The style that splitting the merged cell `head` of `look` sends after it: Google gives the
 * cells it restores the looks they kept while covered, which a read does not show, so each is
 * set to the merged cell's look, the edges between them taking its top edge.
 */
function unmergeStyle(look: CellLook): CellStyleChange {
  return {
    background: look["background-color"], verticalAlign: look["vertical-align"],
    padding: {
      top: look["padding-top"], right: look["padding-right"],
      bottom: look["padding-bottom"], left: look["padding-left"],
    },
    border: look["border-top"],
    borders: {
      top: look["border-top"], bottom: look["border-bottom"],
      left: look["border-left"], right: look["border-right"],
    },
  };
}

// ---------------------------------------------------------------------------
// Changes to a table's look
// ---------------------------------------------------------------------------

/**
 * The checks of a change to the look of `block` of the table at `table`, which give its cells'
 * spans: the block lies in the table and holds every merged cell it reaches whole, since Google
 * styles all of a merged cell it reaches any of.
 */
function checkCellBlock(
  render: DocTabSnapshot, table: number, block: CellBlock, op: string,
): Spans[][] {
  let target = render.sourceMap.tables[table];
  let { rows, columns } = sizeOf(target, op);
  if (block.row + block.rows > rows) {
    throw new Error(`${op}: row and rows must name rows of the table, which has ${rows}.`);
  }
  if (block.column + block.columns > columns) {
    throw new Error(
      `${op}: column and columns must name columns of the table, which has ${columns}.`);
  }
  let spans: Spans[][] = target.rows.map(row => row.cells);
  let covered = coveredCells(spans);
  let inside = (r: number, c: number) => r >= block.row && r < block.row + block.rows &&
    c >= block.column && c < block.column + block.columns;
  for (let [r, row] of spans.entries()) {
    for (let [c, { rowSpan, columnSpan }] of row.entries()) {
      if (covered[r][c] || rowSpan === 1 && columnSpan === 1) continue;
      let reached = false;
      let whole = true;
      for (let down = r; down < Math.min(r + rowSpan, rows); down++) {
        for (let across = c; across < Math.min(c + columnSpan, columns); across++) {
          if (inside(down, across)) reached = true;
          else whole = false;
        }
      }
      if (reached && !whole) {
        throw new Error(
          `${op}: the cells named take in part of the merged cell at row ${r}, column ${c} ` +
          "(counting from 0), which Google Docs styles as a whole. Name all of its cells or " +
          "none of them.");
      }
    }
  }
  return spans;
}

/** Refuse a change to a table's look for what the table at `table` is or holds. */
export function checkLookTarget(
  render: DocTabSnapshot, table: number, change: LookChange,
): void {
  let op = change.type;
  if (change.type !== "setTableCellStyle") {
    let size = sizeOf(render.sourceMap.tables[table], op);
    let ofRows = change.type === "setTableRowHeights";
    let limit = ofRows ? size.rows : size.columns;
    if (change.at + change.count > limit) {
      throw new Error(
        `${op}: at and count must name ${ofRows ? "rows" : "columns"} of the table, which has ` +
        `${limit}.`);
    }
    return;
  }
  let spans = checkCellBlock(render, table, change, op);
  let { borders } = change.style;
  if (borders?.innerHorizontal !== undefined || borders?.innerVertical !== undefined) {
    let merged = spans.some((row, r) => row.some(({ rowSpan, columnSpan }, c) =>
      (rowSpan > 1 || columnSpan > 1) && r >= change.row && r < change.row + change.rows &&
      c >= change.column && c < change.column + change.columns));
    if (merged) {
      throw new Error(
        `${op}: the cells named hold a merged cell, so the edges between their rows or ` +
        "columns cannot be set. Set them on blocks of cells beside it, or use border.");
    }
  }
}

// ---------------------------------------------------------------------------
// The requests of a change
// ---------------------------------------------------------------------------

/** The range of a block of a table's cells, as a request names it. */
function cellRange(
  tableStartLocation: DocsLocation, block: CellBlock,
): { tableCellLocation: TableCellLocation; rowSpan: number; columnSpan: number } {
  return {
    tableCellLocation: { tableStartLocation, rowIndex: block.row, columnIndex: block.column },
    rowSpan: block.rows,
    columnSpan: block.columns,
  };
}

/** Add a request for each of `steps`. */
function cellStyleRequests(
  requests: GoogleDocsRequest[], tableStartLocation: DocsLocation, steps: readonly CellStyleStep[],
): void {
  for (let step of steps) {
    addRequest(requests, {
      updateTableCellStyle: {
        tableRange: cellRange(tableStartLocation, step.block), ...googleCellStyle(step.set),
      },
    });
  }
}

/**
 * Set the fixed widths of a table's columns back to what `look` gives them, once `count` columns
 * have been added before column `at`, copying column `reference`. A column added beside one that
 * shares the page's width can make Google narrow the fixed columns to what their text needs,
 * and only sometimes: live probes saw a 120pt column cut to 13pt beside two such columns, and two
 * 200pt ones kept.
 */
function restoreFixedWidths(
  requests: GoogleDocsRequest[], tableStartLocation: DocsLocation, look: TableLook,
  reference: number, at: number, count: number,
): void {
  let { columns } = look;
  if (!columns || columns[reference] !== null) return;
  let byWidth = new Map<number, number[]>();
  for (let [column, width] of columns.entries()) {
    if (width === null) continue;
    byWidth.set(width, [...byWidth.get(width) ?? [], column < at ? column : column + count]);
  }
  for (let [width, columnIndices] of byWidth) {
    addRequest(requests, {
      updateTableColumnProperties: {
        tableStartLocation, columnIndices,
        tableColumnProperties: {
          widthType: "FIXED_WIDTH", width: { magnitude: width, unit: "PT" },
        },
        fields: "widthType,width",
      },
    });
  }
}

/** The requests that add the table `change` describes at `place`. */
function newTableRequests(
  place: NewTablePlace, change: Extract<TableChange, { type: "insertTable" }>,
): GoogleDocsRequest[] {
  let { tabId } = place.piece;
  let requests: GoogleDocsRequest[] = [];
  let fill = (text: string, index: number) => plainTextToDocRequests(text, index, tabId, requests);
  let { rows, columns } = change;
  let index = newTableIndex(place, change.after);
  addRequest(requests, { insertTable: { rows, columns, location: { index, tabId } } });
  let tableStart = index + 1;
  let rowLength = 1 + 2 * columns;
  // The paragraph Google adds with the table: after it, or before it when it follows a table.
  fill("", place.table === undefined ? tableStart + 2 + rows * rowLength : index);
  // From the last cell to the first, so that no fill moves a cell still to be filled.
  for (let row = rows - 1; row >= 0; row--) {
    for (let column = columns - 1; column >= 0; column--) {
      fill(change.cells[row]?.[column] ?? "", tableStart + 3 + row * rowLength + 2 * column);
    }
  }
  return requests;
}

/**
 * The requests that make `change` in its table, the tab's table `number`, which `piece`
 * holds: every check of the change against its table and its tab is made here, before its
 * requests are built.
 */
function existingTableRequests(
  piece: DocTabSnapshot, change: ExistingTableChange, number: number,
): GoogleDocsRequest[] {
  let { tabId } = piece;
  let requests: GoogleDocsRequest[] = [];
  let fill = (text: string, index: number, keepParagraphStyle = false) =>
    plainTextToDocRequests(text, index, tabId, requests, keepParagraphStyle);

  let position = targetOf(piece, change, number);
  let table = piece.sourceMap.tables[position];
  let tableStartLocation = { index: table.docStart, tabId };
  if (change.type === "mergeTableCells" || change.type === "unmergeTableCells") {
    let { look, spans } = checkMerge(piece, position, change);
    let { row, column } = change;
    if (change.type === "mergeTableCells") {
      let { rows, columns } = change;
      // Google moves the paragraphs of the block's cells into its top-left cell, taking none from a
      // cell that is one empty paragraph, and leaves each other cell one empty paragraph, which
      // still counts once: the tab gains one for each cell that holds anything, past the first.
      let filled = 0;
      for (let r = row; r < row + rows; r++) {
        for (let c = column; c < column + columns; c++) {
          let cell = table.rows[r].cells[c];
          if (cell.nested || cell.lines !== 1 || !cell.emptyParagraph || cell.unshown > 0) filled++;
        }
      }
      checkTabTableCells(piece, Math.max(0, filled - 1), change.type);
      // Only the tab says which rows are pinned: its rendering shows a header row as any other.
      let pinned = table.pinnedRows ?? 0;
      if (row < pinned && row + rows > pinned) {
        throw new Error(
          "mergeTableCells: the cells named take in the table's pinned header, its first " +
          `${pinned === 1 ? "row" : `${pinned} rows`}, and rows below it, which Google Docs ` +
          "does not merge. Merge cells of the header rows, or cells of the rows below them.");
      }
      addRequest(requests, {
        mergeTableCells: {
          tableRange: cellRange(tableStartLocation, { row, column, rows, columns }),
        },
      });
      // Google sets each merged row's least height to the height it renders at, which only it
      // knows (probe M1): the heights the rows had are sent again.
      let byHeight = new Map<number, number[]>();
      for (let r = row; r < row + rows; r++) {
        byHeight.set(look.rows[r], [...byHeight.get(look.rows[r]) ?? [], r]);
      }
      for (let [height, rowIndices] of byHeight) {
        addRequest(requests, {
          updateTableRowStyle: {
            tableStartLocation, rowIndices,
            tableRowStyle: { minRowHeight: { magnitude: height, unit: "PT" } },
            fields: "minRowHeight",
          },
        });
      }
    } else {
      let { rowSpan, columnSpan } = spans[row][column];
      addRequest(requests, {
        unmergeTableCells: {
          tableRange: cellRange(tableStartLocation, { row, column, rows: 1, columns: 1 }),
        },
      });
      let block = { row, column, rows: rowSpan, columns: columnSpan };
      cellStyleRequests(requests, tableStartLocation,
        cellStyleSteps(block, unmergeStyle(look.cells[row][column]!)));
    }
    return requests;
  }
  if (change.type === "setTableColumnWidths" || change.type === "setTableRowHeights") {
    checkLookTarget(piece, position, change);
    let indices = Array.from({ length: change.count }, (_, index) => change.at + index);
    addRequest(requests, change.type === "setTableColumnWidths"
      ? {
        updateTableColumnProperties: {
          tableStartLocation, columnIndices: indices,
          ...(change.width === null
            ? { tableColumnProperties: { widthType: "EVENLY_DISTRIBUTED" }, fields: "widthType" }
            : {
              tableColumnProperties: {
                widthType: "FIXED_WIDTH", width: { magnitude: change.width, unit: "PT" },
              },
              fields: "widthType,width",
            }),
        },
      }
      : {
        // Only the height: a pinned header row stays pinned, as probe R6 saw.
        updateTableRowStyle: {
          tableStartLocation, rowIndices: indices,
          tableRowStyle: { minRowHeight: { magnitude: change.height, unit: "PT" } },
          fields: "minRowHeight",
        },
      });
    return requests;
  }
  if (isLookChange(change)) {
    checkLookTarget(piece, position, change);
    cellStyleRequests(requests, tableStartLocation, cellStyleSteps(change, change.style));
    return requests;
  }
  if (change.type === "deleteTable") {
    checkTableDeletion(piece, position);
    addRequest(requests, {
      deleteContentRange: {
        range: { startIndex: table.docStart, endIndex: table.docEnd, tabId },
      },
    });
    return requests;
  }

  let shape = shapeOf(change);
  let { rows, columns } = checkLineChange(piece, position, shape);
  let { at, count } = shape;
  switch (change.type) {
    case "insertTableRows": {
      checkTabTableCells(piece, addedTableCells(change), change.type);
      // Each request names the reference row where the requests before it left it, so every
      // new row is added directly beside that row and takes after it.
      let atEnd = at === rows;
      let reference = atEnd ? rows - 1 : at;
      for (let added = 0; added < count; added++) {
        addRequest(requests, {
          insertTableRow: {
            tableCellLocation: {
              tableStartLocation, rowIndex: atEnd ? reference : at + added, columnIndex: 0,
            },
            insertBelow: atEnd,
          },
        });
      }
      let referenceRow = table.rows[reference];
      let start = atEnd ? referenceRow.docEnd : referenceRow.docStart;
      // A chip Google copies into a cell takes one index, before the cell's line break.
      let copies = copiedChips(table, reference, change.cells);
      let before = (column: number) => copies.slice(0, column).filter(Boolean).length;
      let rowLength = 1 + 2 * columns + before(columns);
      for (let added = count - 1; added >= 0; added--) {
        for (let column = columns - 1; column >= 0; column--) {
          fill(change.cells[added]?.[column] ?? "",
            start + added * rowLength + 2 + 2 * column + before(column),
            !referenceRow.cells[column].styled);
        }
      }
      // A row added beside a pinned header row is pinned too: keep the count the table had.
      if (table.pinnedRows !== undefined && reference < table.pinnedRows) {
        addRequest(requests, {
          pinTableHeaderRows: { tableStartLocation, pinnedHeaderRowsCount: table.pinnedRows },
        });
      }
      break;
    }
    case "insertTableColumns": {
      checkTabTableCells(piece, addedTableCells(change), change.type);
      let atEnd = at === columns;
      let reference = atEnd ? columns - 1 : at;
      for (let added = 0; added < count; added++) {
        addRequest(requests, {
          insertTableColumn: {
            tableCellLocation: {
              tableStartLocation, rowIndex: 0, columnIndex: atEnd ? reference : at + added,
            },
            insertRight: atEnd,
          },
        });
      }
      restoreFixedWidths(
        requests, tableStartLocation, lookOf(table, change.type), reference, at, count);
      for (let row = rows - 1; row >= 0; row--) {
        let { cells, docEnd } = table.rows[row];
        let start = atEnd ? docEnd : cells[at].docStart;
        let keep = !cells[reference].styled;
        // Every row above this one has grown by the new cells, two indexes each.
        for (let added = count - 1; added >= 0; added--) {
          fill(change.cells[row]?.[added] ?? "", start + 2 * count * row + 2 * added + 1, keep);
        }
      }
      break;
    }
    case "deleteTableRows":
      for (let deleted = 0; deleted < count; deleted++) {
        addRequest(requests, {
          deleteTableRow: {
            tableCellLocation: { tableStartLocation, rowIndex: at, columnIndex: 0 },
          },
        });
      }
      break;
    case "deleteTableColumns":
      for (let deleted = 0; deleted < count; deleted++) {
        addRequest(requests, {
          deleteTableColumn: {
            tableCellLocation: { tableStartLocation, rowIndex: 0, columnIndex: at },
          },
        });
      }
      break;
  }
  return requests;
}

/**
 * The requests that make `change` in the tab `tab` reads, with the piece they were built
 * from: the table a change names, or the place a new one goes, is found in the tab as a
 * whole, the piece around it is asked of the reading, and every check and request is made
 * on that piece. `piece` is the rendering the reading answered (its `part` says where it
 * stands): whoever makes an edit of the requests checks them against it (`pieceOverreach`).
 * Throws the refusal of a change the tab cannot take.
 */
export function tabTableChangeRequests(tab: TabReading, change: TableChange): {
  readonly requests: GoogleDocsRequest[];
  readonly piece: DocTabSnapshot;
} {
  if (change.type === "insertTable") {
    checkTabTableCells(tab, addedTableCells(change), "insertTable");
    let place = newTablePlace(tab, change.after);
    return { requests: newTableRequests(place, change), piece: place.piece };
  }
  let number = tableNumbered(tab, change, change.type);
  let piece = tab.piece({ table: number });
  return { requests: existingTableRequests(piece, change, number), piece };
}

/**
 * The requests that make a change in the tab that `tab` renders: `tabTableChangeRequests` for
 * the reading of that tab (`tabOf`). Throws the refusal of a change the tab cannot take.
 */
export function tableChangeRequests(tab: DocTabSnapshot, change: TableChange): GoogleDocsRequest[] {
  return tabTableChangeRequests(tabOf(tab), change).requests;
}

// ---------------------------------------------------------------------------
// Where a replacement lies
// ---------------------------------------------------------------------------

/** A replacement of `oldMarkdown`, found at `matchStart`, by `newMarkdown`. */
export type TextReplacement = { matchStart: number; oldMarkdown: string; newMarkdown: string };

/**
 * Where the text a replacement changes, as it is written, lies among the tab's tables. It
 * picks the cell path, and it words the refusal of a replacement the paragraph path turns
 * down; it does not refuse anything itself.
 */
export type ReplacementPath =
  /** The text lies inside the HTML of the table at this index of the rendering's tables. */
  | { kind: "cells"; table: number }
  /** The text touches no table, and no blank line that sets one apart. */
  | { kind: "paragraphs" }
  /**
   * The text as written reaches a table from outside, or the blank line beside one. `side`
   * is where the text outside the table's HTML lies: before it, after it, or on both sides.
   * The paragraph path still decides: it accepts some of these once it has put the text in
   * the form a read gives, and the rest are refused with `besideTableRefusal(side)`.
   */
  | { kind: "beside"; side: "before" | "after" | "around" };

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** The length of the common prefix of two texts that splits no surrogate pair. */
export function commonPrefix(left: string, right: string): number {
  let shortest = Math.min(left.length, right.length);
  let prefix = 0;
  while (prefix < shortest && left.charCodeAt(prefix) === right.charCodeAt(prefix)) prefix++;
  while (prefix > 0 && isHighSurrogate(left.charCodeAt(prefix - 1))) prefix--;
  return prefix;
}

/**
 * The length of the common suffix of two texts that reaches no further back than `from` in
 * either and splits no surrogate pair: two emoji can share a surrogate, and Google refuses to
 * delete or insert half of a pair.
 */
export function commonSuffix(left: string, right: string, from: number): number {
  let longest = Math.min(left.length, right.length) - from;
  let suffix = 0;
  while (suffix < longest &&
      left.charCodeAt(left.length - 1 - suffix) === right.charCodeAt(right.length - 1 - suffix)) {
    suffix++;
  }
  while (suffix > 0 && isLowSurrogate(left.charCodeAt(left.length - suffix))) suffix--;
  return suffix;
}

/**
 * The lengths of the common prefix of two texts and of the common suffix of what remains,
 * neither splitting a surrogate pair.
 */
function commonBounds(left: string, right: string): { prefix: number; suffix: number } {
  let prefix = commonPrefix(left, right);
  return { prefix, suffix: commonSuffix(left, right, prefix) };
}

/**
 * `commonBounds` of a text `left` and the text `right` that replaces it, narrowed so that they
 * split no grapheme cluster of either and the deletion of the rest of `left` leaves no cluster
 * across the place the rest of `right` is inserted at (`atGraphemeBoundary`, `joinsGraphemes`):
 * the replacement then lands, and is styled, where it reads.
 */
function graphemeBounds(left: string, right: string): { prefix: number; suffix: number } {
  let { prefix, suffix } = commonBounds(left, right);
  while (!atGraphemeBoundary(left, prefix) || !atGraphemeBoundary(right, prefix)) prefix--;
  while (!atGraphemeBoundary(left, left.length - suffix) ||
      !atGraphemeBoundary(right, right.length - suffix) || joinsGraphemes(left, prefix, suffix)) {
    suffix--;
  }
  return { prefix, suffix };
}

/**
 * Where the text a replacement changes lies among the tab's tables. The text is what remains
 * of `oldMarkdown` once the characters it shares with `newMarkdown` at each end are left out
 * (`commonBounds`), so table HTML quoted unchanged around a paragraph counts for nothing. Text
 * only added at a table's first or last character is beside the table, not in it. Never throws.
 */
export function replacementPath(
  render: DocTabSnapshot, replacement: TextReplacement,
): ReplacementPath {
  let { tables } = render.sourceMap;
  let { matchStart, oldMarkdown, newMarkdown } = replacement;
  let { prefix, suffix } = commonBounds(oldMarkdown, newMarkdown);
  let start = matchStart + prefix;
  let end = matchStart + oldMarkdown.length - suffix;
  let empty = start === end;
  let inside = tables.findIndex(table => table.mdStart <= start && end <= table.mdEnd &&
    (!empty || table.mdStart < start && start < table.mdEnd));
  if (inside >= 0) return { kind: "cells", table: inside };
  for (let table of tables) {
    // A table's own range takes in the line breaks that set it apart from the paragraphs
    // beside it, and a range touches it as the paragraph path has it.
    let range = tableRange(render, table) ?? table;
    let touches = empty ? range.mdStart <= start && start < range.mdEnd
      : start < range.mdEnd && end > range.mdStart;
    if (!touches) continue;
    if (empty) return { kind: "beside", side: start <= table.mdStart ? "before" : "after" };
    let before = start < table.mdStart;
    let after = end > table.mdEnd;
    return { kind: "beside", side: before && after ? "around" : before ? "before" : "after" };
  }
  return { kind: "paragraphs" };
}

// ---------------------------------------------------------------------------
// The paragraph path, beside a table
// ---------------------------------------------------------------------------

const TABLE_AS_A_WHOLE = "add a table with insertTable() and remove one with deleteTable().";

/**
 * The refusal of a replacement that reaches a table from outside it. It names the paragraph on
 * that side as the place to write, in the two spellings the paragraph path takes (the
 * paragraph's own characters, or, for an empty paragraph, its empty line quoted with the blank
 * line and the table's edge unchanged), and the table methods for a table as a whole.
 */
export function besideTableRefusal(side: "before" | "after" | "around"): Error {
  if (side === "around") {
    return new Error(
      "replaceText: this replacement changes a table together with what is around it. Change " +
      "the text inside one table, or the paragraphs before and after it, in separate calls " +
      `that leave the table and the blank lines beside it out; ${TABLE_AS_A_WHOLE}`);
  }
  // The examples show line breaks as a caller writes them in a string: a backslash and an `n`.
  let spellings = side === "before"
    ? "Write text that goes above a table as a change to the paragraph before it: end " +
      "oldMarkdown at that paragraph's last character and leave the blank line and the table " +
      "out. Where that paragraph is empty (an empty line above the table's blank line), quote " +
      "the empty line with the blank line and the table's first characters, keep them " +
      "unchanged in newMarkdown, and put the text on the empty line: \"\\n\\n<table\" becomes " +
      "\"Text\\n\\n<table\"."
    : "Write text that goes below a table as a change to the paragraph after it: start " +
      "oldMarkdown at that paragraph's first character and leave the table and the blank line " +
      "out. Where that paragraph is empty (an empty line below the table's blank line), quote " +
      "the table's last characters and the blank line with the empty line, keep them " +
      "unchanged in newMarkdown, and put the text on the empty line: \"</table>\\n\\n\" becomes " +
      "\"</table>\\n\\nText\".";
  return new Error(
    `replaceText: this replacement changes a table together with what is ${side} it, or the ` +
    `blank line between them. ${spellings} Change the text inside one table in a call of its ` +
    `own; ${TABLE_AS_A_WHOLE}`);
}

const NO_LONGER_IN_TABLE = "replaceText: this change was queued for text in a table, and that " +
  "text is no longer in one.";

/** The requests of a stored `replaceText` in the tab that `tab` renders. */
export function textReplacementRequests(
  tab: DocTabSnapshot, replacement: TextReplacement & { inTable?: true },
): GoogleDocsRequest[] {
  if (replacement.inTable) {
    let requests = tableTextRequests(
      tab, replacement.matchStart, replacement.oldMarkdown, replacement.newMarkdown);
    if (!requests) throw new Error(NO_LONGER_IN_TABLE);
    return requests;
  }
  // The paragraph path: what it returns or throws is the answer, except that a
  // `StructuredContentError` for a replacement that reaches a table from outside becomes
  // `besideTableRefusal`.
  let { matchStart, oldMarkdown, newMarkdown } = replacement;
  try {
    return computeReplaceOperations(
      tab.sourceMap, tab.markdown, matchStart, matchStart + oldMarkdown.length,
      canonicalizeMarkdownReplacement(oldMarkdown, newMarkdown), tab.tabId).requests;
  } catch (error) {
    if (!(error instanceof StructuredContentError)) throw error;
    let path = replacementPath(tab, replacement);
    throw path.kind === "beside" ? besideTableRefusal(path.side) : error;
  }
}

// ---------------------------------------------------------------------------
// The text of a cell paragraph
// ---------------------------------------------------------------------------

/** The text of a cell paragraph and how it is formatted. */
export type CellInline = { text: string; runs: (CellInlineRun & { start: number; end: number })[] };

/** The tags the text of a cell paragraph is written with, in every spelling that is read. */
const INLINE_TAGS: readonly string[] = [
  "<strong>", "</strong>", "<em>", "</em>", "<s>", "</s>", "<a>", "<a ", "</a>", "<br>", "<br/>",
  "<br />", "<ins>", "</ins>", "<del>", "</del>",
];

/** Whether a `<` at `index` begins a tag: a letter or `/` follows it. Any other `<` is text. */
function tagAt(html: string, index: number): boolean {
  if (html[index] !== "<") return false;
  let code = html.charCodeAt(index + 1);
  return code === 47 || code >= 65 && code <= 90 || code >= 97 && code <= 122;
}

function inlineTagAt(html: string, index: number): boolean {
  return INLINE_TAGS.some(tag => html.startsWith(tag, index));
}

/** The name of the tag that begins at `index`: the letters and digits after `<` or `</`. */
function tagNameAt(html: string, index: number): string {
  return /^<\/?([a-zA-Z0-9]*)/.exec(html.slice(index, index + 64))?.[1] ?? "";
}

const LINK_REFUSAL = "replaceText: a link in a table cell is written <a href=\"URL\"> with " +
  "nothing else in the tag, where URL is an http, https or mailto URL or a link within this " +
  "document as getContent() returns it.";

const TAG_ORDER_REFUSAL =
  "replaceText: the HTML of a table cell must close every tag it opens, in order.";

/** The refusal of a tag, named `name`, that the text of a cell cannot be written with. */
function tagRefusal(name: string): Error {
  if (name === "strong" || name === "em" || name === "s" || name === "br") {
    return new Error(
      "replaceText: in a table cell <strong>, <em>, <s> and <br> are written with nothing " +
      "else in the tag.");
  }
  if (name === "a") return new Error(LINK_REFUSAL);
  // Only `</` with no letter or digit after it is a tag with no name, and is named as typed.
  let tag = name === "" ? "</" : `<${name.slice(0, 20)}>`;
  return new Error(
    `replaceText: ${tag} is not supported in a table cell. Use <strong>, ` +
    "<em>, <s>, <a href=\"...\"> and <br>, and write a literal < as &lt;.");
}

const INLINE_STYLES = { strong: "bold", em: "italic", s: "strikethrough" } as const;
type InlineStyleTag = keyof typeof INLINE_STYLES;

const HREF_ESCAPES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"' };

// A link's opening tag where it starts, matched there and no further on (sticky).
const ANCHOR = /<a href="([^"]*)">/y;

/**
 * Read the HTML of a cell paragraph's text. Throws for anything the text of a cell cannot be
 * written with. `<ins>` and `<del>`, which mark suggested text, are read as such
 * (`CellInlineRun.mark`): whether a text may hold them is its plan's to say.
 */
export function parseCellInline(html: string): CellInline {
  let text = "";
  let runs: CellInline["runs"] = [];
  // The tags open, to check they close in order, and how many of each style and mark are open,
  // so a run starts in the same few steps however deep the tags are.
  let open: (InlineStyleTag | "a" | "ins" | "del")[] = [];
  let depth: Record<InlineStyleTag, number> = { strong: 0, em: 0, s: 0 };
  let marks = { ins: 0, del: 0 };
  let link: string | undefined;
  // Text is added to the last run while its formatting is the one in force.
  let current: CellInline["runs"][number] | undefined;
  let restyle = () => {
    current = undefined;
  };
  let add = (characters: string) => {
    if (!current) {
      current = { text: "", start: text.length, end: text.length };
      for (let tag of ["strong", "em", "s"] as const) if (depth[tag] > 0) current[INLINE_STYLES[tag]] = true;
      if (link !== undefined) current.link = link;
      if (marks.ins > 0 || marks.del > 0) {
        current.mark = marks.del === 0 ? "insertion" : marks.ins === 0 ? "deletion" : "both";
      }
      runs.push(current);
    }
    text += characters;
    current.text += characters;
    current.end = text.length;
  };

  for (let index = 0; index < html.length;) {
    let character = html[index];
    if (character === "&") {
      let escape = /^&(?:(amp|lt|gt)|#[0-9a-zA-Z]*|[a-zA-Z][0-9a-zA-Z]*);/.exec(
        html.slice(index, index + 40));
      if (escape && !escape[1]) {
        throw new Error(
          "replaceText: only &amp;, &lt; and &gt; are escapes in a table cell. Write a " +
          "literal & as &amp;.");
      }
      add(escape ? HREF_ESCAPES[escape[1]] : "&");
      index += escape ? escape[0].length : 1;
      continue;
    }
    if (!tagAt(html, index)) {
      add(character);
      index++;
      continue;
    }
    let lineBreak = ["<br>", "<br/>", "<br />"].find(tag => html.startsWith(tag, index));
    if (lineBreak) {
      add("\u000b");
      index += lineBreak.length;
      continue;
    }
    let name = tagNameAt(html, index);
    let closing = html[index + 1] === "/";
    if ((name === "ins" || name === "del") &&
        html.startsWith(closing ? `</${name}>` : `<${name}>`, index)) {
      if (!closing) open.push(name);
      else if (open.pop() !== name) throw new Error(TAG_ORDER_REFUSAL);
      marks[name] += closing ? -1 : 1;
      restyle();
      index += name.length + (closing ? 3 : 2);
      continue;
    }
    if (name === "a" && !closing && (html[index + 2] === " " || html[index + 2] === ">")) {
      ANCHOR.lastIndex = index;
      let anchor = ANCHOR.exec(html);
      if (!anchor) throw new Error(LINK_REFUSAL);
      if (link !== undefined) throw new Error(TAG_ORDER_REFUSAL);
      let destination = anchor[1].replace(/&(amp|lt|gt|quot);/g, (_, entity: string) =>
        HREF_ESCAPES[entity]);
      if (!isSafeTableLink(destination)) throw new Error(LINK_REFUSAL);
      link = canonicalLinkDestination(destination);
      open.push("a");
      restyle();
      index += anchor[0].length;
      continue;
    }
    let tag: InlineStyleTag | "a" | undefined =
      name === "strong" || name === "em" || name === "s" || name === "a" ? name : undefined;
    if (tag === undefined || !html.startsWith(closing ? `</${tag}>` : `<${tag}>`, index)) {
      throw tagRefusal(name);
    }
    if (closing) {
      if (open.pop() !== tag) throw new Error(TAG_ORDER_REFUSAL);
      if (tag === "a") link = undefined;
      else depth[tag]--;
    } else {
      open.push(tag);
      if (tag !== "a") depth[tag]++;
    }
    restyle();
    index += tag.length + (closing ? 3 : 2);
  }
  if (open.length > 0) throw new Error(TAG_ORDER_REFUSAL);

  // Runs that open and close tags to the same formatting are one run.
  let merged: CellInline["runs"] = [];
  for (let run of runs) {
    let previous = merged.at(-1);
    if (previous && sameFormat(previous, run) && previous.link === run.link &&
        previous.mark === run.mark) {
      previous.text += run.text;
      previous.end = run.end;
    } else {
      merged.push(run);
    }
  }
  return { text, runs: merged };
}

/** Bold, italic and strikethrough, the three styles a table's HTML shows beside a link. */
const SHOWN_STYLES = ["bold", "italic", "strikethrough"] as const;

type InlineFormat = Pick<CellInlineRun, "bold" | "italic" | "strikethrough" | "link" | "mark">;

const MARK_REFUSAL = "replaceText: in a table cell <ins> and <del> mark text a suggestion " +
  "inserts or deletes. Keep each around the text it marks and write none in new text: an edit " +
  "cannot make a suggestion or take one back. Use suggestEdit() to make one, and accept or " +
  "reject one in Google Docs.";

function sameFormat(left: InlineFormat, right: InlineFormat): boolean {
  return SHOWN_STYLES.every(style => !left[style] === !right[style]);
}

// ---------------------------------------------------------------------------
// A replacement in table cells: the plan of one changed text
// ---------------------------------------------------------------------------

/** A stretch of a text's final characters that the old and the new HTML each format one way. */
type PlanSegment = {
  /** Half-open range in the final text. */
  start: number;
  end: number;
  /** How the old HTML showed these characters: absent for characters the replacement inserts. */
  old?: InlineFormat;
  /** How the new HTML formats them. */
  next: InlineFormat;
  /** The link they read with once the replacement is made, as the HTML then shows it. */
  link?: string;
  /** Whether they are inserted text that keeps the link of the text it was typed into. */
  keepsLink: boolean;
};

/** What a replacement does to the text of one cell paragraph. */
type TextPlan = {
  /** The range of the old text that is deleted. */
  deleteStart: number;
  deleteEnd: number;
  /** The text inserted at `deleteStart`, without what Google strips from inserted text. */
  inserted: string;
  /** Whether the old HTML shows a link on a character beside the insertion or deleted by it. */
  linkBeside: boolean;
  /** The link inserted text can only have taken from the text beside it, if there is one. */
  keptLink?: string;
  segments: PlanSegment[];
};

/** A run cut to the part of it that lies in a range, placed in the final text. */
type FormatPiece = { start: number; end: number; format: InlineFormat };

/** The parts of `runs` in `[from, to)`, moved by `shift`. */
function formatPieces(
  runs: CellInline["runs"], from: number, to: number, shift: number,
): FormatPiece[] {
  let pieces: FormatPiece[] = [];
  for (let run of runs) {
    let start = Math.max(run.start, from);
    let end = Math.min(run.end, to);
    if (start < end) pieces.push({ start: start + shift, end: end + shift, format: run });
  }
  return pieces;
}

/** The plan of one text's change. */
function planText(oldHtml: string, newHtml: string, tabId: string): TextPlan {
  let before = parseCellInline(oldHtml);
  let after = parseCellInline(newHtml);
  let { prefix, suffix } = graphemeBounds(before.text, after.text);
  let oldTail = before.text.length - suffix;
  let newTail = after.text.length - suffix;
  let sameLink = (left: string | undefined, right: string | undefined) =>
    left === undefined || right === undefined ? left === right
      : cellLinkDestination(left, tabId) === cellLinkDestination(right, tabId);
  let written = (link: string | undefined) =>
    link === undefined ? undefined : cellLinkDestination(link, tabId);

  // The inserted characters, run by run, less those Google strips from inserted text.
  let inserted = "";
  let insertedPieces: FormatPiece[] = [];
  for (let piece of formatPieces(after.runs, prefix, newTail, 0)) {
    let start = prefix + inserted.length;
    for (let index = piece.start; index < piece.end; index++) {
      if (!isGoogleDocsStrippedCharacter(after.text.charCodeAt(index))) {
        inserted += after.text[index];
      }
    }
    let end = prefix + inserted.length;
    if (start < end) insertedPieces.push({ start, end, format: piece.format });
  }
  let insertEnd = prefix + inserted.length;
  if (insertedPieces.some(piece => piece.format.mark)) throw new Error(MARK_REFUSAL);

  // The link shown on the kept character before the insertion and on the one after it.
  let linkAt = (offset: number) =>
    before.runs.find(run => run.start <= offset && offset < run.end)?.link;
  let neighbours = [
    ...(prefix > 0 ? [linkAt(prefix - 1)] : []), ...(suffix > 0 ? [linkAt(oldTail)] : []),
  ];
  let [beside] = neighbours;
  let keptLink = beside !== undefined && neighbours.every(link => sameLink(link, beside))
    ? beside : undefined;
  let linkBeside = neighbours.some(link => link !== undefined) ||
    formatPieces(before.runs, prefix, oldTail, 0).some(piece => piece.format.link !== undefined);

  let segments: PlanSegment[] = [];
  let keep = (oldPieces: FormatPiece[], newPieces: FormatPiece[]) => {
    // Both lists cover the same range, so they are cut at each other's boundaries.
    let other = 0;
    for (let piece of oldPieces) {
      for (let start = piece.start; start < piece.end;) {
        while (newPieces[other].end <= start) other++;
        let end = Math.min(piece.end, newPieces[other].end);
        let next = newPieces[other].format;
        if (next.mark !== piece.format.mark) throw new Error(MARK_REFUSAL);
        segments.push({
          start, end, old: piece.format, next, keepsLink: false,
          link: sameLink(next.link, piece.format.link) ? piece.format.link : written(next.link),
        });
        start = end;
      }
    }
  };
  keep(formatPieces(before.runs, 0, prefix, 0), formatPieces(after.runs, 0, prefix, 0));
  for (let { start, end, format } of insertedPieces) {
    let keepsLink = keptLink !== undefined && format.link !== undefined &&
      sameLink(format.link, keptLink);
    segments.push({
      start, end, next: format, keepsLink, link: keepsLink ? keptLink : written(format.link),
    });
  }
  keep(
    formatPieces(before.runs, oldTail, before.text.length, insertEnd - oldTail),
    formatPieces(after.runs, newTail, after.text.length, insertEnd - newTail));

  return {
    deleteStart: prefix,
    deleteEnd: oldTail,
    inserted,
    linkBeside,
    ...(keptLink === undefined ? {} : { keptLink }),
    segments,
  };
}

/** A request of a text's plan, with its indexes counted from the start of the text's paragraph. */
type TextRequest =
  | { remove: [start: number, end: number] }
  | { insert: [at: number, text: string] }
  | { style: [start: number, end: number, textStyle: TextStyle, fields: string] };

const FOUR_FIELDS = "bold,italic,strikethrough,link";
/** The four fields and the two a link gives its text, for text that is left with no link. */
const UNLINKED_FIELDS = `${FOUR_FIELDS},underline,foregroundColor`;

/** Merge each segment into the one before it when the two abut and `same` holds. */
function stretches(
  segments: readonly PlanSegment[], same: (left: PlanSegment, right: PlanSegment) => boolean,
): { start: number; end: number; first: PlanSegment; index: number }[] {
  let merged: { start: number; end: number; first: PlanSegment; index: number }[] = [];
  for (let [index, segment] of segments.entries()) {
    let previous = merged.at(-1);
    if (previous && previous.end === segment.start && same(previous.first, segment)) {
      previous.end = segment.end;
    } else {
      merged.push({ start: segment.start, end: segment.end, first: segment, index });
    }
  }
  return merged;
}

/** The requests that make the change of one text's plan, in the order they are sent. */
function textPlanRequests(plan: TextPlan, tabId: string): TextRequest[] {
  let requests: TextRequest[] = [];
  let { segments } = plan;
  if (plan.deleteStart < plan.deleteEnd) {
    requests.push({ remove: [plan.deleteStart, plan.deleteEnd] });
  }
  if (plan.inserted) requests.push({ insert: [plan.deleteStart, plan.inserted] });

  let insertedSegments = segments.filter(segment => !segment.old);
  // Inserted text starts with none of the four styles, whatever it took from the text beside
  // it; text that keeps the link beside it is not cleared.
  for (let { start, end } of stretches(
    insertedSegments.filter(segment => !segment.keepsLink), () => true)) {
    requests.push({ style: [start, end, {}, plan.linkBeside ? UNLINKED_FIELDS : FOUR_FIELDS] });
  }
  for (let { start, end, first } of stretches(insertedSegments, (left, right) =>
    sameFormat(left.next, right.next) && left.link === right.link &&
    left.keepsLink === right.keepsLink)) {
    let textStyle: TextStyle = {};
    let fields: string[] = [];
    for (let style of SHOWN_STYLES) {
      if (!first.next[style]) continue;
      textStyle[style] = true;
      fields.push(style);
    }
    if (first.link !== undefined) {
      textStyle.link = docsLinkForDestination(first.link);
      fields.push("link");
    }
    // The link beside the insertion is set where the text may already carry it.
    if (first.keepsLink) requests.push({ style: [start, end, textStyle, FOUR_FIELDS] });
    else if (fields.length > 0) requests.push({ style: [start, end, textStyle, fields.join(",")] });
  }

  // The link each segment showed and the link it is given, as destinations that are equal
  // exactly when the two are the same link.
  let destination = (link: string | undefined) =>
    link === undefined ? undefined : cellLinkDestination(link, tabId);
  let shown = segments.map(segment => destination(segment.old?.link));
  let given = segments.map(segment => destination(segment.next.link));
  // Whether the link the kept segment at `index` showed is pointed elsewhere whole: every
  // character of the unbroken run around it that carries that link, before or after the
  // replacement, is given one link. The answer is the same for every segment of the run that
  // showed the link, so a run is walked once however many stretches it holds.
  let whole: (boolean | undefined)[] = [];
  let pointedWhole = (index: number): boolean => {
    let link = shown[index];
    let target = given[index];
    if (link === undefined || target === undefined) return false;
    let known = whole[index];
    if (known !== undefined) return known;
    let carries = (at: number) =>
      at >= 0 && at < segments.length && (shown[at] === link || given[at] === link);
    let from = index;
    while (carries(from - 1)) from--;
    let to = index;
    while (carries(to + 1)) to++;
    let pointed = true;
    for (let at = from; at <= to && pointed; at++) pointed = given[at] === target;
    for (let at = from; at <= to; at++) if (shown[at] === link) whole[at] = pointed;
    return pointed;
  };
  let keptStretches = stretches(segments, (left, right) =>
    left.old !== undefined && right.old !== undefined && sameFormat(left.old, right.old) &&
    left.old.link === right.old.link && sameFormat(left.next, right.next) &&
    left.link === right.link);
  for (let { start, end, first, index } of keptStretches) {
    let { old, next } = first;
    if (!old) continue;
    let changed = SHOWN_STYLES.filter(style => !old[style] !== !next[style]);
    let textStyle: TextStyle = {};
    if (shown[index] === given[index]) {
      // Only what differs is named, so every style the HTML does not show stays as it is.
      for (let style of changed) textStyle[style] = !!next[style];
      if (changed.length > 0) requests.push({ style: [start, end, textStyle, changed.join(",")] });
    } else if (first.link !== undefined && pointedWhole(index)) {
      for (let style of changed) textStyle[style] = !!next[style];
      textStyle.link = docsLinkForDestination(first.link);
      requests.push({ style: [start, end, textStyle, [...changed, "link"].join(",")] });
    } else {
      // A link set on part of another link repoints all of it, so the link is cleared first,
      // in a request that states the three shown styles as well.
      for (let style of SHOWN_STYLES) {
        if (next[style]) textStyle[style] = true;
        else if (old[style]) textStyle[style] = false;
      }
      if (first.link === undefined) {
        requests.push({ style: [start, end, textStyle, UNLINKED_FIELDS] });
      } else {
        requests.push({ style: [start, end, textStyle, FOUR_FIELDS] });
        requests.push({
          style: [start, end, { link: docsLinkForDestination(first.link) }, "link"],
        });
      }
    }
  }
  return requests;
}

// ---------------------------------------------------------------------------
// A replacement in table cells: reading the new HTML against the table
// ---------------------------------------------------------------------------

/** An editable text of a table: its range in the table's HTML, and whose text it is. */
type TableText = { start: number; end: number; row: number; column: number; index: number };

/** Where a walk stopped: at `offset` of piece `piece`, which is at `at` of the text walked. */
type WalkStop = { piece: number; offset: number; at: number };

/**
 * Walk `html` as the table's fixed pieces with a text between each two. Returns the texts, or
 * where the HTML first reads otherwise than a piece. `onLineBreak` is told of a text that ends
 * at a line break, which no piece starts with.
 */
function walkPieces(
  html: string, pieces: readonly string[],
  onLineBreak?: (position: number, nextPiece: string) => void,
): string[] | WalkStop {
  let texts: string[] = [];
  let position = 0;
  for (let [index, piece] of pieces.entries()) {
    if (!html.startsWith(piece, position)) {
      let offset = 0;
      while (offset < piece.length && html[position + offset] === piece[offset]) offset++;
      return { piece: index, offset, at: position + offset };
    }
    position += piece.length;
    if (index === pieces.length - 1) break;
    let start = position;
    while (position < html.length && html[position] !== "\n" &&
        !(tagAt(html, position) && !inlineTagAt(html, position))) position++;
    if (html[position] === "\n") onLineBreak?.(position, pieces[index + 1]);
    texts.push(html.slice(start, position));
  }
  return position === html.length ? texts
    : { piece: pieces.length - 1, offset: pieces[pieces.length - 1].length, at: position };
}

/** Text without the white space between two tags, and where that white space stood. */
type Squeezed = { text: string; gaps: [at: number, length: number][] };

/**
 * `html` without the white space that stands directly between two tags, neither of which is one
 * the text of a cell is written with: beside such a tag, white space is text.
 */
function squeeze(html: string): Squeezed {
  let parts: string[] = [];
  let gaps: Squeezed["gaps"] = [];
  let cursor = 0;
  let length = 0;
  for (let close = html.indexOf(">"); close >= 0; close = html.indexOf(">", close + 1)) {
    let next = close + 1;
    while (next < html.length && " \t\r\n".includes(html[next])) next++;
    if (next === close + 1 || !tagAt(html, next) || inlineTagAt(html, next)) continue;
    let open = html.lastIndexOf("<", close);
    if (open < 0 || inlineTagAt(html, open)) continue;
    parts.push(html.slice(cursor, close + 1));
    length += close + 1 - cursor;
    gaps.push([length, next - close - 1]);
    cursor = next;
  }
  parts.push(html.slice(cursor));
  return { text: parts.join(""), gaps };
}

/** The tag `html` is in at `index`: from the nearest `<` before it, when no `>` stands between. */
function tagAround(html: string, index: number): string {
  let open = html.lastIndexOf("<", index);
  return open < 0 || html.slice(open, index).includes(">") ? "" : html.slice(open, open + 64);
}

const OWN_TAG = /^<\/?(?:td|tr|table)(?![0-9a-zA-Z])/;
const LOOK_TAG = /^<(?:td|tr|table)(?![0-9a-zA-Z])/;
const COLUMNS_TAG = /^<\/?col(?:group)?(?![0-9a-zA-Z])/;
const CELL_TAG = /^<\/?td(?![0-9a-zA-Z])/;
const OPENS_BLOCK = /^<(?:p|h[1-6]|ul|ol|li)(?![0-9a-zA-Z])/;
const CLOSES_BLOCK = /^<\/(?:td|ul|ol|li)>/;
const KNOWN_TAGS: readonly string[] = [
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "td", "tr", "table", "hr",
  "colgroup", "col",
];

/**
 * The refusal of a replacement in a table whose result `raw` does not read as the table's
 * pieces with new texts between them. What went wrong is decided on the whole of it:
 * first whether only the white space between the table's tags differs, then by the first
 * difference that is left once that white space is set aside.
 */
function tableTextRefusal(
  raw: string, texts: readonly TableText[], pieces: readonly string[], table: TableMapping,
): Error {
  let squeezed = pieces.map(squeeze);
  let loose = squeeze(raw).text;
  let stop = walkPieces(loose, squeezed.map(piece => piece.text));
  if (Array.isArray(stop)) {
    return new Error(
      "replaceText: the line breaks and indentation between a table's rows, cells and " +
      "paragraphs must stay exactly as getContent() returns them.");
  }
  let piece = squeezed[stop.piece];
  let offset = stop.offset;
  // Where the character the walk stopped at stood in the table's HTML.
  let pieceStart = stop.piece === 0 ? 0 : texts[stop.piece - 1].end;
  let dropped = 0;
  for (let [at, length] of piece.gaps) if (at <= offset) dropped += length;
  let position = table.mdStart + pieceStart +
    (offset < piece.text.length ? offset + dropped : pieces[stop.piece].length);
  let rowIndex = table.rows.findIndex(row => row.mdStart <= position && position < row.mdEnd);
  let columnIndex = rowIndex < 0 ? -1 : table.rows[rowIndex].cells.findIndex(cell =>
    cell.mdStart <= position && position < cell.mdEnd);
  let want = tagAround(piece.text, offset);
  let got = tagAround(loose, stop.at);

  if (LOOK_TAG.test(want) && (want.includes(' style="') || got.includes(' style="')) ||
      COLUMNS_TAG.test(want) || COLUMNS_TAG.test(got)) {
    return new Error(
      "replaceText: a table's look, which its tags' style attributes and the <colgroup> line " +
      "write, cannot be changed with replaceText(). Quote the text of cells, not their tags.");
  }
  if (columnIndex < 0 || CELL_TAG.test(want) && OWN_TAG.test(got)) {
    return new Error(
      "replaceText: inside a table only the text of its cells can be replaced. Change rows " +
      "and columns with insertTableRows(), insertTableColumns(), deleteTableRows() and " +
      "deleteTableColumns(), and remove a table with deleteTable().");
  }
  let cell = table.rows[rowIndex].cells[columnIndex];
  // A merged cell covers the other cells its spans reach, below it and to its right.
  let covered = table.rows.slice(0, rowIndex + 1).some((row, headRow) =>
    row.cells.slice(0, columnIndex + 1).some((head, headColumn) =>
      (headRow !== rowIndex || headColumn !== columnIndex) &&
      headRow + head.rowSpan > rowIndex && headColumn + head.columnSpan > columnIndex));
  if (covered) {
    return new Error(
      "replaceText: a cell that a merged cell covers cannot be edited. Edit the merged cell.");
  }
  if (cell.nested) {
    return new Error("replaceText: a cell that holds another table cannot be edited.");
  }
  if (cell.inSuggestion) {
    return new Error(
      "replaceText: this cell is in a table, a row or a cell that a suggestion inserts or " +
      "deletes, so its text cannot be changed until the suggestion is accepted or rejected in " +
      "Google Docs.");
  }
  if (CLOSES_BLOCK.test(want) && OPENS_BLOCK.test(got) ||
      OPENS_BLOCK.test(want) && CLOSES_BLOCK.test(got)) {
    return new Error(
      "replaceText: a table cell keeps the paragraphs and list items it has: a replacement " +
      "cannot add or remove one. Write <br> for a line break within a paragraph.");
  }
  // What a list fixes around an item's text: its opening tag, and the bullet character and
  // space the item starts with, which stand in the piece before the item's text.
  let open = piece.text.lastIndexOf("<", offset);
  let inListTag = open >= 0 && piece.text.indexOf(">", open) >= offset &&
    /^<(?:ul|ol)(?![0-9a-zA-Z])/.test(piece.text.slice(open, open + 4));
  let item = piece.text.lastIndexOf("<li>");
  let bulletStart = item < 0 ? -1
    : item + 4 + (/^<h[1-6]>/.test(piece.text.slice(item + 4, item + 8)) ? 4 : 0);
  let bullet = bulletStart < 0 ? "" : piece.text.slice(bulletStart);
  let inBullet = bullet.endsWith(" ") && !bullet.includes("<") && offset >= bulletStart;
  if (inListTag || inBullet) {
    return new Error(
      "replaceText: a list item in a table cell keeps its list tags and the bullet " +
      "character it starts with. Replace only the text after the bullet.");
  }
  if (tagAt(got, 0)) {
    let name = tagNameAt(got, 0);
    if (!KNOWN_TAGS.includes(name)) return tagRefusal(name);
  }
  return new Error(
    "replaceText: in a table cell only the text of existing paragraphs, headings and list " +
    "items can be replaced, and not that of a subtitle or of a paragraph holding an image, " +
    "smart chip or other element.");
}

/** A replacement in table cells, read against its table. */
type TableTextEdit = {
  /** The table's index among the rendering's tables. */
  table: number;
  /** The table's editable texts, in order. */
  texts: TableText[];
  /**
   * The requests of each text the replacement changes, counted from the start of the text's
   * paragraph; absent for the others.
   */
  requests: (TextRequest[] | undefined)[];
};

/**
 * Read a replacement as a change to the text of table cells: `undefined` when what it changes
 * does not lie inside one table, and a refusal when it changes more than the text of cells or
 * needs more requests than one change may send.
 */
function readTableText(
  render: DocTabSnapshot, replacement: TextReplacement,
): TableTextEdit | undefined {
  let path = replacementPath(render, replacement);
  if (path.kind !== "cells") return undefined;
  let { markdown, tabId } = render;
  let { matchStart, oldMarkdown, newMarkdown } = replacement;
  let target = render.sourceMap.tables[path.table];
  let texts: TableText[] = [];
  for (let [row, { cells }] of target.rows.entries()) {
    for (let [column, cell] of cells.entries()) {
      for (let [index, text] of cell.texts.entries()) {
        texts.push({
          start: text.mdStart - target.mdStart, end: text.mdEnd - target.mdStart,
          row, column, index,
        });
      }
    }
  }
  let html = markdown.slice(target.mdStart, target.mdEnd);
  let pieces = texts.map((text, index) =>
    html.slice(index === 0 ? 0 : texts[index - 1].end, text.start));
  pieces.push(html.slice(texts.at(-1)?.end ?? 0));
  // The table as the replacement leaves it: what the two texts share at each end stands in
  // the table as it is (`replacementPath` found the rest inside it), so the rest is put in
  // the table's own HTML.
  let { prefix, suffix } = commonBounds(oldMarkdown, newMarkdown);
  let raw = html.slice(0, matchStart + prefix - target.mdStart) +
    newMarkdown.slice(prefix, newMarkdown.length - suffix) +
    html.slice(matchStart + oldMarkdown.length - suffix - target.mdStart);

  let written = walkPieces(raw, pieces, (position, nextPiece) => {
    // A text that runs into a line break and then closes as its paragraph does was written
    // with a paragraph break in it.
    let tag = position;
    while (tag < raw.length && !(tagAt(raw, tag) && !inlineTagAt(raw, tag))) tag++;
    let closing = nextPiece.slice(0, nextPiece.indexOf(">") + 1);
    if (closing && raw.startsWith(closing, tag)) {
      throw new Error(
        "replaceText: the text of a paragraph in a table cell cannot hold a paragraph " +
        "break. Write <br> for a line break within the paragraph; a paragraph cannot be " +
        "added to a cell.");
    }
  });
  if (!Array.isArray(written)) {
    throw tableTextRefusal(raw, texts, pieces, target);
  }

  let requests: (TextRequest[] | undefined)[] = [];
  let count = 0;
  for (let [index, text] of texts.entries()) {
    let old = html.slice(text.start, text.end);
    // A text written otherwise than it read has its requests sent even where it would read as
    // it did: what Google stores can differ where the read cannot tell, as for bold written
    // over a heading's explicit `bold: false`.
    let planned = written[index] === old ? []
      : textPlanRequests(planText(old, written[index], tabId), tabId);
    let needed = planned.length > 0 ? planned : undefined;
    requests.push(needed);
    count += needed?.length ?? 0;
  }
  if (count > MAX_TABLE_TEXT_REQUESTS) {
    throw new Error(
      `replaceText: this replacement in table cells needs more than ${MAX_TABLE_TEXT_REQUESTS} ` +
      "requests, the most one change may send. Change fewer cells or formatted stretches at " +
      "once.");
  }
  return { table: path.table, texts, requests };
}

/**
 * The requests of a replacement of the text of table cells in the tab that `tab` renders.
 * `undefined` when what the replacement changes does not lie inside one table.
 */
export function tableTextRequests(
  tab: DocTabSnapshot, matchStart: number, oldMarkdown: string, newMarkdown: string,
): GoogleDocsRequest[] | undefined {
  let { tabId } = tab;
  let edit = readTableText(tab, { matchStart, oldMarkdown, newMarkdown });
  if (!edit) return undefined;
  let table = tab.sourceMap.tables[edit.table];
  let requests: GoogleDocsRequest[] = [];
  // From the last text to the first, so that no request moves a paragraph still to be changed.
  for (let index = edit.texts.length - 1; index >= 0; index--) {
    let planned = edit.requests[index];
    if (!planned) continue;
    let text = edit.texts[index];
    let paragraph = table.rows[text.row].cells[text.column].texts[text.index].docStart;
    for (let request of planned) {
      if ("remove" in request) {
        let [start, end] = request.remove;
        addRequest(requests, {
          deleteContentRange: {
            range: { startIndex: paragraph + start, endIndex: paragraph + end, tabId },
          },
        });
      } else if ("insert" in request) {
        let [at, inserted] = request.insert;
        addRequest(requests, {
          insertText: { location: { index: paragraph + at, tabId }, text: inserted },
        });
      } else {
        let [start, end, textStyle, fields] = request.style;
        addRequest(requests, {
          updateTextStyle: {
            range: { startIndex: paragraph + start, endIndex: paragraph + end, tabId },
            textStyle,
            fields,
          },
        });
      }
    }
  }
  return requests;
}
