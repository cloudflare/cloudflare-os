// From a call on a Google Doc to what the connection stores and submits: the checks a call gets
// once, when it is made, the change to queue with the reference it records of its table, and
// what the approval card shows. Everything here is a pure function of the tab as it stands and
// the call. A call is checked by making its change in the tab with the model of Google Docs
// (`./docs-replay`), so every check a replay repeats is the request builders', which also word
// its refusal.

import {
  buildDescription, sanitizeTitle, truncateToBytes, type RenderedDescription,
} from "@gadgets/gatekeeper-kit/action-description";
import type { ActionKind } from "@gadgets/workshop-shared/gatekeeper";
import { storedTabReading, unwrapped } from "./docs-reading";
import { changedSpan, docEditResult, uniqueMarkdown } from "./docs-replay";
import { DocRunRenderError, docStoreCost, markdownHeld } from "./docs-store";
import type { DocStore, DocVersion, StoredRun } from "./docs-store";
import {
  checkLookTarget, checkTabTableCells, checkTableTarget, chipCopies, hiddenContent, insertedTableNumber,
  headerAfterInsertion, pinnedAround,
  lineAbove, MAX_TABLE_COLUMNS, replacementPath, tableIdentity, tableShape, tableSize, tabOf,
} from "./docs-tables";
import type { HiddenContent, LookChange, TableChange } from "./docs-tables";
import { EDGES, points, SIDES } from "./docs-table-look";
import type { CellStyleChange } from "./docs-table-look";
import type {
  DocTableBorder, DocTableCell, DocTableCells, DocTableCellStyle, DocTableColumnWidths,
  DocTableDeletion, DocTableInsertion, DocTableMerge, DocTableRowHeights, NewDocTable,
} from "./docs-types";
import { MAX_MARKDOWN_BLOCKS, stripUnwritableCharacters } from "./markdown-converter";
import type { DocTabSnapshot, MarkdownRange, TabReading } from "./markdown-converter";

/**
 * Adding or deleting a table, or rows or columns of one, changing a table's look, and merging
 * or splitting its cells. A kind of its own, apart from "Document edits", so a rule enabled for
 * either covers only what its label says. A deletion may apply without asking too, since the
 * document's version history undoes it.
 */
export const DOCUMENT_TABLES: ActionKind = { tag: "document-tables", label: "Table changes" };

/** One of the session's table methods, as called. */
export type TableCall =
  | { method: "insertTable"; table: NewDocTable }
  | { method: "insertTableRows" | "insertTableColumns"; lines: DocTableInsertion }
  | { method: "deleteTableRows" | "deleteTableColumns"; lines: DocTableDeletion }
  | { method: "deleteTable"; table: number }
  | { method: "setTableCellStyle"; cells: DocTableCells & { style: DocTableCellStyle } }
  | { method: "setTableColumnWidths"; columns: DocTableColumnWidths }
  | { method: "setTableRowHeights"; rows: DocTableRowHeights }
  | { method: "mergeTableCells"; cells: DocTableMerge }
  | { method: "unmergeTableCells"; cell: DocTableCell };

/** What a table call becomes once checked against the tab. */
export type PreparedTableChange = {
  /** The change to store with the pending action. */
  change: TableChange;
  /** The approval card's title. */
  title: string;
  /** The approval card's prose and fields, to spread into the action's description. */
  description: RenderedDescription;
  /** The kind the action is grouped under for auto-approval. */
  actionKind: ActionKind;
  /** Whether a user may let actions of that kind apply without asking. */
  autoApprovable: boolean;
  /** For `insertTable`: the new table's position among the tab's tables once it is added. */
  table?: number;
};

/** The most table HTML the waiting changes of one document may record between them. */
export const MAX_QUEUED_TABLE_LENGTH = 4 * 1024 * 1024;

/** What a `replaceText` becomes once checked against the tab. */
export type PreparedTextReplacement = {
  /** Whether it changes the text of table cells; stored with the action as `inTable`. */
  inTable: boolean;
  /** The card's prose: what is replaced where and, for table cells, how the values read. */
  prose: string;
  /** The language the card's values are written in: the table's HTML for table cells. */
  syntax: "markdown" | "html";
  /**
   * What the card shows. The three are one span of the tab (`changedSpan`): as it reads now,
   * with the replacement as written, and as a read will return it.
   */
  shown: { old: string; requested: string; rendered: string };
};

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

// How much one call may add, counted in cells: twice the new cells that have text plus the new
// empty ones, so 1,000 cells with text and an empty cell counting as half of one. A cell that
// is reset costs four requests with text and two without, and a change has to reach Google Docs
// as one batch that answers in time. Whether a cell will be reset or keep the look of its
// neighbour is decided when the change applies, so every cell is charged at the dearer rate.
const MAX_CALL_CELL_COST = 2_000;

// The most UTF-8 bytes one change may store: the text it writes and the table it records.
const MAX_CHANGE_BYTES = 1024 * 1024;

const encoder = new TextEncoder();

/** Whether the texts of `groups` take more than `limit` bytes of UTF-8 between them. */
function exceedsBytes(limit: number, ...groups: Iterable<string>[]): boolean {
  let bytes = 0;
  for (let texts of groups) {
    for (let text of texts) {
      // A text has at least as many bytes as UTF-16 code units, so one too long is not encoded.
      if (text.length > limit - bytes) return true;
      bytes += encoder.encode(text).byteLength;
      if (bytes > limit) return true;
    }
  }
  return false;
}

/** Every text of `cells`, row by row. */
function* textsOf(cells: readonly (readonly string[])[]): Generator<string> {
  for (let row of cells) yield* row;
}

/** Whether a new cell given `text` holds any once the characters Google strips are gone. */
function hasText(text: string): boolean {
  return stripUnwritableCharacters(text) !== "";
}

/** What `cells` new cells cost, those of `given` that have text counting twice. */
function cellCost(cells: number, given: readonly (readonly string[])[]): number {
  let cost = cells;
  // No text can bring a count that is already too high back under the limit.
  if (cost > MAX_CALL_CELL_COST) return cost;
  for (let text of textsOf(given)) {
    if (hasText(text)) cost++;
  }
  return cost;
}

function countLineBreaks(cells: readonly (readonly string[])[]): number {
  let breaks = 0;
  for (let text of textsOf(cells)) {
    for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) breaks++;
  }
  return breaks;
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

// ---------------------------------------------------------------------------
// A call's own arguments
// ---------------------------------------------------------------------------

// `@validateRpc()` checks the fields a type declares and hands any other through unchecked, and
// every field a table call could misspell is optional: dropped, `rows` on `insertTableRows` would
// add one empty row, and `before` on `insertTable` a table at the end of the tab. So a field that
// is not listed here, one list for each argument type, is refused by name.
const NEW_TABLE_FIELDS: Record<keyof NewDocTable, true> =
  { rows: true, columns: true, cells: true, after: true };
const INSERTION_FIELDS: Record<keyof DocTableInsertion, true> =
  { table: true, at: true, count: true, cells: true };
const DELETION_FIELDS: Record<keyof DocTableDeletion, true> =
  { table: true, at: true, count: true };

const CELLS_FIELDS: Record<keyof (DocTableCells & { style: DocTableCellStyle }), true> =
  { table: true, row: true, column: true, rows: true, columns: true, style: true };
const STYLE_FIELDS: Record<keyof DocTableCellStyle, true> =
  { background: true, verticalAlign: true, padding: true, border: true, borders: true };
const PADDING_FIELDS: Record<keyof NonNullable<DocTableCellStyle["padding"]>, true> =
  { top: true, right: true, bottom: true, left: true };
const BORDER_FIELDS: Record<keyof DocTableBorder, true> = { width: true, dash: true, color: true };
const WIDTHS_FIELDS: Record<keyof DocTableColumnWidths, true> =
  { table: true, at: true, count: true, width: true };
const HEIGHTS_FIELDS: Record<keyof DocTableRowHeights, true> =
  { table: true, at: true, count: true, height: true };
const MERGE_FIELDS: Record<keyof DocTableMerge, true> =
  { table: true, row: true, column: true, rows: true, columns: true };
const CELL_FIELDS: Record<keyof DocTableCell, true> = { table: true, row: true, column: true };
const BORDERS_FIELDS: Record<keyof NonNullable<DocTableCellStyle["borders"]>, true> = {
  top: true, bottom: true, left: true, right: true, innerHorizontal: true, innerVertical: true,
};

function checkFields(
  op: string, argument: object, declared: Record<string, true>, of = "",
): void {
  for (let [name, value] of Object.entries(argument)) {
    if (value === undefined || Object.hasOwn(declared, name)) continue;
    let names = Object.keys(declared);
    let owner = of ? ` of ${of.slice(0, -1)}` : "";
    throw new Error(
      `${op}: unknown field ${JSON.stringify(of + name.slice(0, 40))}. The fields${owner} are ` +
      `${names.slice(0, -1).join(", ")} and ${names.at(-1)}.`);
  }
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** A length the agent gave, as the look writes it, refused outside `least` to `most` points. */
function lengthOf(op: string, name: string, value: number, least: number, most: number): string {
  if (!Number.isFinite(value) || value < least || value > most) {
    throw new Error(`${op}: ${name} must be a number of points from ${least} to ${most}.`);
  }
  return points(value);
}

function colorOf(op: string, name: string, value: string): string {
  if (!HEX_COLOR.test(value)) throw new Error(`${op}: ${name} must be a colour written #rrggbb.`);
  return value.toLowerCase();
}

/** A border the agent gave, as the look writes it. */
function borderOf(op: string, name: string, border: DocTableBorder | null): string {
  if (border === null) return "none";
  checkFields(op, border, BORDER_FIELDS, `${name}.`);
  let width = lengthOf(op, `${name}.width`, border.width, 0, 24);
  if (width === "0pt") return "none";
  let color = colorOf(op, `${name}.color`, border.color ?? "#000000");
  return `${width} ${border.dash ?? "solid"} ${color}`;
}

/** The change a style the agent gave makes, each value as the look writes it. */
function styleChange(
  op: string, style: DocTableCellStyle, rows: number, columns: number,
): CellStyleChange {
  checkFields(op, style, STYLE_FIELDS, "style.");
  let change: CellStyleChange = {};
  if (style.background !== undefined) {
    change.background = style.background === null ? "transparent"
      : colorOf(op, "style.background", style.background);
  }
  if (style.verticalAlign !== undefined) change.verticalAlign = style.verticalAlign;
  if (style.padding !== undefined) {
    checkFields(op, style.padding, PADDING_FIELDS, "style.padding.");
    let padding: NonNullable<CellStyleChange["padding"]> = {};
    for (let side of SIDES) {
      let value = style.padding[side];
      if (value !== undefined) padding[side] = lengthOf(op, `style.padding.${side}`, value, 0, 100);
    }
    if (Object.keys(padding).length > 0) change.padding = padding;
  }
  if (style.border !== undefined) change.border = borderOf(op, "style.border", style.border);
  if (style.borders !== undefined) {
    checkFields(op, style.borders, BORDERS_FIELDS, "style.borders.");
    let borders: NonNullable<CellStyleChange["borders"]> = {};
    for (let edge of EDGES) {
      let border = style.borders[edge];
      if (border === undefined) continue;
      if (edge === "innerHorizontal" && rows < 2 || edge === "innerVertical" && columns < 2) {
        throw new Error(
          `${op}: style.borders.${edge} is the edges between the block's ` +
          `${edge === "innerHorizontal" ? "rows" : "columns"}, and this block has only one.`);
      }
      borders[edge] = borderOf(op, `style.borders.${edge}`, border);
    }
    if (Object.keys(borders).length > 0) change.borders = borders;
  }
  if (Object.keys(change).length === 0) {
    throw new Error(`${op}: style sets nothing. Give at least one of its fields.`);
  }
  return change;
}

function checkWholeNumber(op: string, name: string, value: number, least: 0 | 1): void {
  if (!Number.isSafeInteger(value) || value < least) {
    throw new Error(`${op}: ${name} must be a whole number of at least ${least}.`);
  }
}

/** Refuse new cells' text for what it holds whatever table it goes into, with `after` beside it. */
function checkNewText(op: string, cells: readonly (readonly string[])[], after?: string): void {
  for (let text of textsOf(cells)) {
    if (!text.isWellFormed()) {
      throw new Error(
        `${op}: the text of the new cells holds half of a surrogate pair: a character such as ` +
        "an emoji, cut in two. Give whole characters.");
    }
  }
  if (countLineBreaks(cells) > MAX_MARKDOWN_BLOCKS) {
    throw new Error(
      `${op}: the text of the new cells holds more than ${MAX_MARKDOWN_BLOCKS} paragraph ` +
      "breaks. Add it in several calls.");
  }
  if (exceedsBytes(MAX_CHANGE_BYTES, textsOf(cells), after === undefined ? [] : [after])) {
    throw new Error(
      `Google Doc action Markdown exceeds the ${MAX_CHANGE_BYTES}-byte safe submission limit.`);
  }
}

/** Refuse a call whose arguments are wrong whatever the document holds. */
export function checkTableCall(call: TableCall): void {
  let op = call.method;
  switch (call.method) {
    case "insertTable": {
      let { rows, columns, cells = [], after } = call.table;
      checkFields(op, call.table, NEW_TABLE_FIELDS);
      checkWholeNumber(op, "rows", rows, 1);
      if (!Number.isSafeInteger(columns) || columns < 1 || columns > MAX_TABLE_COLUMNS) {
        throw new Error(
          `insertTable: columns must be a whole number from 1 to ${MAX_TABLE_COLUMNS}.`);
      }
      if (cells.length > rows || cells.some(row => row.length > columns)) {
        throw new Error(
          `insertTable: cells must fit the table: at most ${rows} rows of at most ${columns} ` +
          "cells.");
      }
      if (after !== undefined && after.replaceAll("\n", "") === "") {
        throw new Error("insertTable: after must name text of the tab.");
      }
      if (cellCost(rows * columns, cells) > MAX_CALL_CELL_COST) {
        throw new Error(
          `insertTable: a new table holds at most ${MAX_CALL_CELL_COST / 2} cells that have ` +
          "text, an empty cell counting as half of one. Add it with fewer rows, and the rest " +
          "with insertTableRows().");
      }
      checkNewText(op, cells, after);
      return;
    }
    case "insertTableRows":
    case "insertTableColumns": {
      let { table, at, count, cells = [] } = call.lines;
      checkFields(op, call.lines, INSERTION_FIELDS);
      checkWholeNumber(op, "table", table, 0);
      if (at !== undefined) checkWholeNumber(op, "at", at, 0);
      if (count !== undefined) checkWholeNumber(op, "count", count, 1);
      checkNewText(op, cells);
      return;
    }
    case "deleteTableRows":
    case "deleteTableColumns": {
      let { table, at, count } = call.lines;
      checkFields(op, call.lines, DELETION_FIELDS);
      checkWholeNumber(op, "table", table, 0);
      checkWholeNumber(op, "at", at, 0);
      if (count !== undefined) checkWholeNumber(op, "count", count, 1);
      return;
    }
    case "deleteTable":
      checkWholeNumber(op, "table", call.table, 0);
      return;
    case "setTableCellStyle": {
      let { table, row, column, rows = 1, columns = 1, style } = call.cells;
      checkFields(op, call.cells, CELLS_FIELDS);
      checkWholeNumber(op, "table", table, 0);
      checkWholeNumber(op, "row", row, 0);
      checkWholeNumber(op, "column", column, 0);
      checkWholeNumber(op, "rows", rows, 1);
      checkWholeNumber(op, "columns", columns, 1);
      styleChange(op, style, rows, columns);
      return;
    }
    case "setTableColumnWidths":
    case "setTableRowHeights": {
      let lines = call.method === "setTableColumnWidths" ? call.columns : call.rows;
      checkFields(
        op, lines, call.method === "setTableColumnWidths" ? WIDTHS_FIELDS : HEIGHTS_FIELDS);
      checkWholeNumber(op, "table", lines.table, 0);
      if (lines.at !== undefined) checkWholeNumber(op, "at", lines.at, 0);
      if (lines.count !== undefined) checkWholeNumber(op, "count", lines.count, 1);
      if (call.method === "setTableColumnWidths") {
        if (call.columns.width !== null) lengthOf(op, "width", call.columns.width, 5, 1000);
      } else {
        lengthOf(op, "height", call.rows.height, 0, 1000);
      }
      return;
    }
    case "mergeTableCells": {
      let { table, row, column, rows, columns } = call.cells;
      checkFields(op, call.cells, MERGE_FIELDS);
      checkWholeNumber(op, "table", table, 0);
      checkWholeNumber(op, "row", row, 0);
      checkWholeNumber(op, "column", column, 0);
      checkWholeNumber(op, "rows", rows, 1);
      checkWholeNumber(op, "columns", columns, 1);
      if (rows * columns < 2) {
        throw new Error("mergeTableCells: the block must hold at least two cells.");
      }
      return;
    }
    case "unmergeTableCells":
      checkFields(op, call.cell, CELL_FIELDS);
      checkWholeNumber(op, "table", call.cell.table, 0);
      checkWholeNumber(op, "row", call.cell.row, 0);
      checkWholeNumber(op, "column", call.cell.column, 0);
  }
}

// ---------------------------------------------------------------------------
// A call against the tab
// ---------------------------------------------------------------------------

function htmlOf(render: DocTabSnapshot, table: MarkdownRange): string {
  return render.markdown.slice(table.mdStart, table.mdEnd);
}

/**
 * The piece of the tab `tab` reads around the table a call names by its number, and the
 * table's place among that piece's tables; or the refusal of a number that names no table.
 * THE ONE PLACE a call's table number becomes a place in a rendering.
 */
function tableAt(
  tab: TabReading, table: number, op: string,
): { piece: DocTabSnapshot; place: number } {
  let { tabId } = tab;
  let held = tab.tables().count;
  if (Number.isInteger(table) && table >= 0 && table < held) {
    let piece = tab.piece({ table });
    return { piece, place: table - (piece.part?.tablesBefore ?? 0) };
  }
  throw new Error(held === 0
    ? `${op}: tab "${tabId}" has no table ${table}: it has no tables.`
    : `${op}: tab "${tabId}" has no table ${table}. It has ${plural(held, "table")}, numbered ` +
      `from 0 in the order getContent("${tabId}") shows them.`);
}

/**
 * Refuse a change to the table at `table` among the rendering's tables while another table of
 * the rendering's tab reads the same: a queued change is kept to its table by how the table
 * reads. Tables are compared by their shape, without their looks and the list and footnote
 * numbers an edit elsewhere in the tab can move.
 */
function checkReadsAlone(render: DocTabSnapshot, table: number, op: string): void {
  let shape = tableShape(htmlOf(render, render.sourceMap.tables[table]));
  // WHERE THE TABLE'S PLACE BECOMES ITS NUMBER for the refusal: both numbers are the tab's.
  let number = table + (render.part?.tablesBefore ?? 0);
  let other = tabOf(render).tablesShaped(shape).find(shaped => shaped !== number);
  if (other === undefined) return;
  throw new Error(
    `${op}: table ${number} reads the same as table ${other} of this tab (styles, column ` +
    "widths, row heights, numbers in square brackets and where numbered lists start aside), " +
    "so the change could not be kept to the table it is meant for. Make the two differ " +
    "first, for example by changing the text of a cell with replaceText(), then call " +
    `${op}() again.`);
}

/** The texts of `count` new lines of `width` cells each, as they are written: absent ones empty. */
function storedCells(
  given: readonly (readonly string[])[], count: number, width: number,
): string[][] {
  return Array.from({ length: count }, (_, line) =>
    Array.from({ length: width }, (__, cell) =>
      stripUnwritableCharacters(given[line]?.[cell] ?? "")));
}

type InsertionCall = Extract<TableCall, { method: "insertTableRows" | "insertTableColumns" }>;
type DeletionCall = Extract<TableCall, { method: "deleteTableRows" | "deleteTableColumns" }>;
type ExistingTableCall = Exclude<TableCall, { method: "insertTable" }>;
type ExistingTableChange = Exclude<TableChange, { type: "insertTable" }>;

/** The change that adds rows or columns to the table a call names. */
function insertionChange(tab: TabReading, call: InsertionCall): ExistingTableChange {
  let op = call.method;
  let { cells: given = [] } = call.lines;
  let { piece: render, place: table } = tableAt(tab, call.lines.table, op);
  let target = render.sourceMap.tables[table];
  let { rows, columns } = tableSize(render, table, op);
  let ofRows = op === "insertTableRows";
  let at = call.lines.at ?? (ofRows ? rows : columns);
  // Rows are written one array for each new row, so `cells` says how many are wanted. Columns
  // are written row by row too, and a `cells` that sets their number would turn one array
  // written for each new column into as many columns as it holds texts.
  let count = call.lines.count ?? (ofRows ? Math.max(given.length, 1) : 1);
  // What no later call gets past comes before the refusals that say what to do next.
  checkTableTarget(render, table, { type: op, at, count });
  // The cells the call would add, each once for each paragraph of its text.
  let width = ofRows ? columns : rows;
  checkTabTableCells(render, count * width + countLineBreaks(given), op);
  checkReadsAlone(render, table, op);

  if (ofRows ? given.length > count || given.some(row => row.length > columns)
    : given.length > rows || given.some(row => row.length > count)) {
    throw new Error(ofRows
      ? `insertTableRows: cells must fit the new rows: at most ${count} rows of at most ` +
        `${columns} cells, the table's number of columns.`
      : "insertTableColumns: cells must fit the new columns: one array for each row of the " +
        `table (at most ${rows}), each holding one text for each new column (at most ${count}; ` +
        "count is 1 unless given).");
  }
  if (cellCost(count * width, given) > MAX_CALL_CELL_COST) {
    throw new Error(
      `${op}: at most ${MAX_CALL_CELL_COST / 2} cells that have text can be added at once, an ` +
      "empty cell counting as half of one. Add the rest with further calls.");
  }
  let expected = tableIdentity(htmlOf(render, target));
  return ofRows
    ? {
      type: "insertTableRows", at, cells: storedCells(given, count, columns), expected,
      copies: chipCopies(target, at < rows ? at : rows - 1),
      pinned: pinnedAround(target, at),
    }
    : { type: "insertTableColumns", at, cells: storedCells(given, rows, count), expected };
}

/**
 * What a row insertion's card says of the header of `pinned` rows it goes among, pinned again
 * after the rows are added: which new rows it pins and how many rows it no longer does. Nothing
 * where the rows go below the header.
 */
function headerNote(pinned: number, at: number, count: number): string {
  let { added, dropped } = headerAfterInsertion(pinned, at, count);
  if (added === 0) return "";
  let pins = added === count
    ? count === 1 ? "the new row is pinned and repeats" : "the new rows are pinned and repeat"
    : added === 1 ? "the first new row is pinned and repeats"
    : `the first ${added} new rows are pinned and repeat`;
  let drops = dropped === 1 ? ", and 1 row that was in it no longer does"
    : `, and ${dropped} rows that were in it no longer do`;
  return ` The header stays ${plural(pinned, "row")}: ${pins} at the top of each page${drops}.`;
}

/** The change that deletes rows or columns of the table a call names. */
function deletionChange(tab: TabReading, call: DeletionCall): ExistingTableChange {
  let op = call.method;
  let { at, count = 1 } = call.lines;
  let { piece: render, place: table } = tableAt(tab, call.lines.table, op);
  let target = render.sourceMap.tables[table];
  let shape = { type: op, at, count };
  checkTableTarget(render, table, shape);
  checkReadsAlone(render, table, op);
  return {
    ...shape, expected: tableIdentity(htmlOf(render, target)),
    ...hiddenContent(render, table, shape),
  };
}

/** The change that deletes the table a call names. */
function tableDeletionChange(tab: TabReading, number: number): ExistingTableChange {
  let op = "deleteTable" as const;
  let { piece: render, place: table } = tableAt(tab, number, op);
  let target = render.sourceMap.tables[table];
  let shape = { type: op };
  checkTableTarget(render, table, shape);
  checkReadsAlone(render, table, op);
  return {
    ...shape, expected: tableIdentity(htmlOf(render, target)),
    ...hiddenContent(render, table, shape),
  };
}

/**
 * Refuse a change for what it stores: a table too large to record, which no smaller change
 * gets past, and otherwise a change too large together with the table it records.
 */
function checkStoredSize(change: TableChange): void {
  let op = change.type;
  let recorded: string[] = [];
  if (change.type !== "insertTable") {
    recorded.push(change.expected);
    if (exceedsBytes(MAX_CHANGE_BYTES, recorded)) {
      throw new Error(
        `${op}: this table is too large for the table methods: its HTML alone is over the ` +
        `${MAX_CHANGE_BYTES}-byte limit of one change. The text of its cells can still be ` +
        "changed with replaceText().");
    }
  } else if (change.after !== undefined) {
    recorded.push(change.after);
  }
  if (exceedsBytes(MAX_CHANGE_BYTES, recorded, "cells" in change ? textsOf(change.cells) : [])) {
    throw new Error(
      `${op}: the change and the table it applies to exceed the ${MAX_CHANGE_BYTES}-byte safe ` +
      "submission limit.");
  }
}

// ---------------------------------------------------------------------------
// Approval cards
// ---------------------------------------------------------------------------

const isEmpty = (cells: readonly (readonly string[])[]): boolean =>
  cells.every(row => row.every(text => text === ""));

/**
 * The nearest line above a table that is not empty and not part of a table, without its line
 * break: what an approver has to tell which table a card is about.
 */
function textBefore(render: DocTabSnapshot, table: MarkdownRange): string | undefined {
  let { part } = render;
  // What a part of the tab does not hold stands before it, and is the tab's to say.
  return lineAbove(render.markdown, render.sourceMap.tables, table.mdStart) ??
    (part && !part.first ? part.tab.lineBefore(part.mdStart) : undefined);
}

/** A cell's block as its own HTML: without its lines' indentation and its last line break. */
function cellHtml(block: string): string {
  return block.slice(0, -1).replace(/^ {4}/gm, "");
}

/** Longest result a table change's card shows, in UTF-8 bytes. */
const MAX_SHOWN_RESULT_BYTES = 8 * 1024;

/** What a table change's card shows of the tab as it will read. */
type ShownResult = {
  /** The lines that will read otherwise, or the first of them when they pass the limit. */
  text: string;
  /** Whether lines were left off the end of `text`. */
  cut: boolean;
  /** `"html"` when the lines are all of one table, `"markdown"` otherwise. */
  syntax: "html" | "markdown";
};

/**
 * How a tab reads otherwise once a table change is made in it: the two strings a
 * `ChangedMarkdown` holds, the span they differ in and the tables of the one after.
 */
export type TableChangeResult = Pick<ChangedMarkdown, "before" | "after" | "span" | "tables">;

/**
 * The lines of `after` that differ from `before`, the Markdown of a tab around a table change
 * with the span the two differ in, without the line breaks around them; `undefined` when the
 * change adds no line to those it replaces, as a deletion does. `tables` are the tables of the
 * tab after the change that stand in `after`, which say whether the lines shown are all of one
 * table.
 */
function shownResult({ before, after, span, tables }: TableChangeResult): ShownResult | undefined {
  let from = span.start;
  let to = span.afterEnd;
  while (from < to && after[from] === "\n") from++;
  while (to > from && after[to - 1] === "\n") to--;
  let result = after.slice(from, to);
  let replaced = new Set(before.slice(span.start, span.beforeEnd).split("\n"));
  if (result === "" || result.split("\n").every(line => replaced.has(line))) return undefined;
  let syntax = tables.some(table => table.mdStart <= from && to <= table.mdEnd)
    ? "html" as const : "markdown" as const;
  let { text, truncated: cut } = truncateToBytes(result, MAX_SHOWN_RESULT_BYTES);
  // Cut back to whole lines; a first line longer than the limit is shown as far as it goes.
  if (cut && text.includes("\n")) text = text.slice(0, text.lastIndexOf("\n"));
  return { text, cut, syntax };
}

/**
 * Add to a card, as its last field, what the tab will read as, unless one of `shown`, the texts
 * the card's other fields show, already holds it whole.
 */
function addResult(
  description: ReturnType<typeof buildDescription>, result: ShownResult | undefined,
  shown: readonly (string | undefined)[],
): void {
  if (!result || shown.some(text => text?.includes(result.text))) return;
  description.verbatim(
    result.cut ? "Resulting (first lines)" : "Resulting", result.text, result.syntax);
}

/** The card of a new table; `result` is what the tab will read as with it. */
function newTableCard(
  change: Extract<TableChange, { type: "insertTable" }>, label: string,
  result: ShownResult | undefined,
): { title: string; description: RenderedDescription } {
  let { rows, columns, cells, after } = change;
  let empty = isEmpty(cells);
  let description = buildDescription(
    `Insert a table of ${plural(rows, "row")} and ${plural(columns, "column")} in tab ${label}, ` +
    (after === undefined
      ? "at the end of the tab."
      : "after the paragraph, list item or table that the text below ends in.") +
    (empty ? " Its cells are empty." : "") +
    // Worded for both places a table named by `after` can come to stand, since the card is not
    // rewritten when the text it names comes to lie in a table.
    (after === undefined
      ? " An empty paragraph is added after it."
      : " An empty paragraph is added with it: after the new table, or between the two " +
        "tables when it follows a table."));
  if (after !== undefined) description.verbatim("After", after, "markdown");
  if (!empty) description.json("Cells", cells);
  addResult(description, result, [after]);
  return { title: "Insert a table in Google Doc", description: description.finish() };
}

/**
 * The sentences a deletion's card gains for what the change recorded of the cells it removes
 * that the content does not show: the card's fields show those cells as the content reads, so
 * such a cell reads there as holding less than it does. A replay refuses the change once its
 * table holds more of the kind than it recorded, so the card says all that is deleted.
 */
function hiddenNotes(change: HiddenContent): string {
  return (change.suggested
    ? " It holds suggested changes to its rows, columns or cells, or to their text, which are " +
      "deleted with it."
    : "") +
    (change.unshown
      ? " What is deleted holds a dropdown or other smart chips that are not shown below: a " +
        "cell that holds nothing else reads as empty."
      : "");
}

/** Lines `first` to `first + count - 1` by their numbers from 1, as a card names them. */
function lineNames(first: number, count: number, noun: string): string {
  return count === 1 ? `${noun} ${first + 1}` : `${noun}s ${first + 1} to ${first + count}`;
}

/**
 * The card of a change to an existing table but for its result: its title, its description
 * so far, not finished, and `shown`, the texts its fields show, which the result must not
 * repeat. Made BEFORE the edit, because the reading lets go of the piece when the edit is
 * made. It holds strings alone: slices of the piece's Markdown, which may keep that one
 * string alive, and nothing of its source map.
 */
type PendingTableCard = {
  title: string;
  description: ReturnType<typeof buildDescription>;
  shown: readonly (string | undefined)[];
};

/**
 * The card of a change to the table at `table` among the tables of `render`, the piece of
 * the tab around it as it reads before the change, with every field but the result
 * (`finishedTableCard`).
 */
function existingTableCard(
  render: DocTabSnapshot, table: number, change: ExistingTableChange, label: string,
): PendingTableCard {
  let { markdown } = render;
  let target = render.sourceMap.tables[table];
  // The table's place then: the change follows its table if that place changes before
  // approval. WHERE THE TABLE'S PLACE BECOMES ITS NUMBER for the card: the tab's, from 1.
  let number = table + (render.part?.tablesBefore ?? 0) + 1;
  let was = ` It was table ${number} of the tab when this change was requested.`;
  let before = textBefore(render, target);
  let describe = (prose: string) => buildDescription(prose + was);
  // What a change adds or deletes comes first, since the Workshop cuts a long card short. The
  // fields that tell which table it is follow, and the result comes last, so that a long one
  // pushes none of them out. `deleted` is the text a deletion's own field shows.
  let located = (
    title: string, description: ReturnType<typeof buildDescription>, firstRow?: string,
    rowAbove?: string, deleted?: string,
  ): PendingTableCard => {
    if (before !== undefined) description.verbatim("Text before the table", before, "markdown");
    if (firstRow !== undefined) description.verbatim("First row of the table", firstRow, "html");
    if (rowAbove !== undefined) description.verbatim("Row above the new rows", rowAbove, "html");
    return { title, description, shown: [before, firstRow, rowAbove, deleted] };
  };

  if (change.type === "deleteTable") {
    let description = describe(
      `Delete a table of tab ${label}, with everything in it.${hiddenNotes(change)}`);
    let html = htmlOf(render, target);
    description.verbatim("Table", html, "html");
    return located("Delete a table in Google Doc", description, undefined, undefined, html);
  }

  let { rows } = target;
  // A row's block from the first of these rows through the last, without its last line break.
  let rowsHtml = (first: number, last: number) =>
    markdown.slice(rows[first].mdStart, rows[last].mdEnd - 1);
  let firstRow = rowsHtml(0, 0);
  if (change.type === "setTableCellStyle") {
    let description = describe(
      `Set the look of the cells in ${lineNames(change.row, change.rows, "row")} and ` +
      `${lineNames(change.column, change.columns, "column")} of a table of tab ${label}.` +
      (change.style.border !== undefined || change.style.borders !== undefined
        ? " A border on the block's outer edge also changes the facing edge of the cells " +
          "beside it."
        : ""));
    description.json("Style", change.style);
    return located("Restyle table cells in Google Doc", description, firstRow);
  }
  if (change.type === "mergeTableCells") {
    let description = describe(
      `Merge the cells in ${lineNames(change.row, change.rows, "row")} and ` +
      `${lineNames(change.column, change.columns, "column")} of a table of tab ${label} into ` +
      "one. Their text is joined into the top-left cell, row by row.");
    return located("Merge table cells in Google Doc", description, firstRow);
  }
  if (change.type === "unmergeTableCells") {
    let description = describe(
      `Split the merged cell at row ${change.row + 1}, column ${change.column + 1} of a table ` +
      `of tab ${label} back into its cells. Its text stays in the top-left one.`);
    return located("Split a table cell in Google Doc", description, firstRow);
  }
  if (change.type === "setTableColumnWidths" || change.type === "setTableRowHeights") {
    let ofColumns = change.type === "setTableColumnWidths";
    let what = lineNames(change.at, change.count, ofColumns ? "column" : "row");
    let value = change.type === "setTableColumnWidths"
      ? change.width === null ? "share the width the fixed columns leave of the page"
        : `${change.width}pt wide`
      : change.height === 0 ? "as tall as their text" : `at least ${change.height}pt tall`;
    let description = describe(
      `Make ${what} of a table of tab ${label} ${value}.`);
    return located(
      ofColumns ? "Set table column widths in Google Doc" : "Set table row heights in Google Doc",
      description, firstRow);
  }
  let { at } = change;
  switch (change.type) {
    case "insertTableRows": {
      let { cells } = change;
      let empty = isEmpty(cells);
      let reference = at < rows.length ? at : rows.length - 1;
      let copies = rows[reference].cells
        .flatMap((cell, column) => cell.copies && cell.copies !== "nothing" ? [column + 1] : []);
      let them = cells.length === 1 ? "it" : "them";
      let description = describe(
        `Insert ${plural(cells.length, "row")} in a table of tab ${label}, ` +
        (at < rows.length ? `before its row ${at + 1}.` : "after its last row.") +
        (empty && copies.length === 0 ? " They are empty." : "") +
        (copies.length === 0 ? ""
          : ` Google Docs copies into ${them} the dropdown or smart chip that stands alone in ` +
            `${copies.length === 1 ? "column" : "columns"} ${copies.join(", ")} of the row ` +
            `beside ${them}: a dropdown with its first choice, and an empty placeholder for ` +
            "any other chip.") +
        headerNote(pinnedAround(target, at), at, cells.length));
      if (!empty) description.json("New rows", cells);
      // Below the first row, the first row's field already shows the row above.
      let rowAbove = at >= 2 ? rowsHtml(at - 1, at - 1) : undefined;
      return located("Insert table rows in Google Doc", description, firstRow, rowAbove);
    }
    case "insertTableColumns": {
      let { cells } = change;
      let empty = isEmpty(cells);
      let description = describe(
        `Insert ${plural(cells[0].length, "column")} in a table of tab ${label}, ` +
        (at < rows[0].cells.length ? `before its column ${at + 1}.` : "after its last column.") +
        (empty ? " They are empty." : ""));
      if (!empty) description.json("New cells, row by row", cells);
      return located("Insert table columns in Google Doc", description, firstRow);
    }
    case "deleteTableRows": {
      let { count } = change;
      let description = describe((count === 1
        ? `Delete row ${at + 1} of a table of tab ${label}, with everything in it.`
        : `Delete rows ${at + 1} to ${at + count} of a table of tab ${label}, with everything ` +
          "in them.") +
        hiddenNotes(change));
      let deleted = rowsHtml(at, at + count - 1);
      description.verbatim("Deleted rows", deleted, "html");
      return located("Delete table rows in Google Doc", description, firstRow, undefined, deleted);
    }
    case "deleteTableColumns": {
      let { count } = change;
      let description = describe((count === 1
        ? `Delete column ${at + 1} of a table of tab ${label}, with everything in it.`
        : `Delete columns ${at + 1} to ${at + count} of a table of tab ${label}, with ` +
          "everything in them.") +
        hiddenNotes(change));
      description.json("Deleted cells, row by row", rows.map(row =>
        row.cells.slice(at, at + count).map(cell =>
          cellHtml(markdown.slice(cell.mdStart, cell.mdEnd)))));
      return located("Delete table columns in Google Doc", description, firstRow);
    }
  }
}

/**
 * A pending card finished: `result`, the lines the change makes read otherwise, is added as
 * its last field, unless a field already shows it.
 */
function finishedTableCard(
  card: PendingTableCard, result: ShownResult | undefined,
): { title: string; description: RenderedDescription } {
  addResult(card.description, result, card.shown);
  return { title: card.title, description: card.description.finish() };
}

/** The change that sets the look of the cells a call names. */
function lookChange(
  tab: TabReading, call: Extract<TableCall, { method: "setTableCellStyle" }>,
): ExistingTableChange {
  let op = call.method;
  let { row, column, rows = 1, columns = 1, style } = call.cells;
  let { piece: render, place: table } = tableAt(tab, call.cells.table, op);
  let target = render.sourceMap.tables[table];
  let change: LookChange = {
    type: op, row, column, rows, columns, style: styleChange(op, style, rows, columns),
    expected: tableIdentity(htmlOf(render, target)),
  };
  checkLookTarget(render, table, change);
  checkReadsAlone(render, table, op);
  return change;
}

/** A length as a look stores it: at most three decimals. */
function inPoints(value: number): number {
  return Number(value.toFixed(3));
}

/** The change that sets the widths of columns, or the heights of rows, a call names. */
function lineLookChange(
  tab: TabReading,
  call: Extract<TableCall, { method: "setTableColumnWidths" | "setTableRowHeights" }>,
): LookChange {
  let op = call.method;
  let lines = call.method === "setTableColumnWidths" ? call.columns : call.rows;
  let { piece: render, place: table } = tableAt(tab, lines.table, op);
  let target = render.sourceMap.tables[table];
  let size = tableSize(render, table, op);
  let limit = call.method === "setTableColumnWidths" ? size.columns : size.rows;
  let at = lines.at ?? 0;
  let count = lines.count ?? (lines.at === undefined ? Math.max(limit - at, 1) : 1);
  let expected = tableIdentity(htmlOf(render, target));
  let change: LookChange = call.method === "setTableColumnWidths"
    ? {
      type: op as "setTableColumnWidths", at, count, expected,
      width: call.columns.width === null ? null : inPoints(call.columns.width),
    }
    : {
      type: op as "setTableRowHeights", at, count, height: inPoints(call.rows.height), expected,
    };
  checkLookTarget(render, table, change);
  checkReadsAlone(render, table, op);
  return change;
}

/** The change that merges the cells a call names, or splits the merged cell it names. */
function mergeChange(
  tab: TabReading,
  call: Extract<TableCall, { method: "mergeTableCells" | "unmergeTableCells" }>,
): ExistingTableChange {
  let op = call.method;
  let { table: number, row, column } = call.method === "mergeTableCells" ? call.cells : call.cell;
  let { piece: render, place: table } = tableAt(tab, number, op);
  let target = render.sourceMap.tables[table];
  let expected = tableIdentity(htmlOf(render, target));
  checkReadsAlone(render, table, op);
  return call.method === "mergeTableCells"
    ? {
      type: op as "mergeTableCells", row, column, rows: call.cells.rows,
      columns: call.cells.columns, expected,
    }
    : { type: op as "unmergeTableCells", row, column, expected };
}

/** The change a call to change an existing table becomes, checked in the order a caller meets. */
function existingTableChange(tab: TabReading, call: ExistingTableCall): ExistingTableChange {
  switch (call.method) {
    case "setTableCellStyle":
      return lookChange(tab, call);
    case "setTableColumnWidths":
    case "setTableRowHeights":
      return lineLookChange(tab, call);
    case "mergeTableCells":
    case "unmergeTableCells":
      return mergeChange(tab, call);
    case "insertTableRows":
    case "insertTableColumns":
      return insertionChange(tab, call);
    case "deleteTableRows":
    case "deleteTableColumns":
      return deletionChange(tab, call);
    case "deleteTable":
      return tableDeletionChange(tab, call.table);
  }
}

/** The change a call to add a table becomes, as it is stored. */
function newTableChange(
  call: Extract<TableCall, { method: "insertTable" }>,
): Extract<TableChange, { type: "insertTable" }> {
  let { rows, columns, cells = [], after } = call.table;
  return {
    type: "insertTable", rows, columns, cells: storedCells(cells, rows, columns),
    ...(after === undefined ? {} : { after }),
  };
}

/**
 * The change a call becomes, checked against the tab `tab` reads in the order a caller
 * meets the checks; for `insertTable`, the change as it is stored. What the builders and
 * the model refuse of it is refused when it is made (`docEditResult`). A call to add a table
 * answers a new table's change, and any other call the change of an existing table.
 */
export function tableCallChange(
  tab: TabReading, call: Extract<TableCall, { method: "insertTable" }>,
): Extract<TableChange, { type: "insertTable" }>;
export function tableCallChange(tab: TabReading, call: ExistingTableCall): ExistingTableChange;
export function tableCallChange(tab: TabReading, call: TableCall): TableChange;
export function tableCallChange(tab: TabReading, call: TableCall): TableChange {
  return call.method === "insertTable" ? newTableChange(call) : existingTableChange(tab, call);
}

/** The number of the table a call to change an existing table names. */
function tableNamed(call: ExistingTableCall): number {
  return call.method === "deleteTable" ? call.table
    : call.method === "setTableCellStyle" ? call.cells.table
    : call.method === "setTableColumnWidths" ? call.columns.table
    : call.method === "setTableRowHeights" ? call.rows.table
    : call.method === "mergeTableCells" ? call.cells.table
    : call.method === "unmergeTableCells" ? call.cell.table : call.lines.table;
}

/**
 * The change a call to change an existing table becomes, with its card but for the result,
 * both from the piece around the table, which `tab` remembers from the checks. In a function
 * of its own, so that no frame of a preparation names the piece while the edit is made.
 */
function pendingTableChange(
  tab: TabReading, call: ExistingTableCall, label: string,
): { change: ExistingTableChange; card: PendingTableCard } {
  let change = tableCallChange(tab, call);
  let { piece, place } = tableAt(tab, tableNamed(call), call.method);
  return { change, card: existingTableCard(piece, place, change, label) };
}

/**
 * What `ask` answers of a stored reading outside an edit's own `try`, before the edit is made
 * in it or once it is made and stored: what the renderer throws on a run passes as the
 * renderer threw it.
 */
function asked<T>(ask: () => T): T {
  try {
    return ask();
  } catch (error) {
    if (error instanceof DocRunRenderError) throw error.cause;
    throw error;
  }
}

/**
 * `call` checked against the tab `tab` reads, and the change to queue with its card: what
 * `prepareTableChange` answers, over any reading of the tab and with no store. The call's
 * checks and an existing table's card, but for its result, are made first, from the piece
 * `tab` answers; then `made(change)` makes the change in the tab, once (what the builders and
 * the model refuse of it is thrown there), and answers how to read what the tab reads as with
 * it; a new table's number is asked of `tab` (`insertedTableNumber`); the change's stored size
 * is checked; and only then is what `made` answered called, once, for the card's last field.
 * Nothing of a piece `tab` answered is named here while `made` runs.
 */
export function tableChangeFrom(
  tab: TabReading, call: TableCall, label: string,
  made: (change: TableChange) => () => TableChangeResult,
): PreparedTableChange {
  checkTableCall(call);
  if (call.method === "insertTable") {
    let change = tableCallChange(tab, call);
    // The builder refuses a tab whose tables would hold too many cells, then a place the
    // table cannot go.
    let result = made(change);
    let table = asked(() => insertedTableNumber(tab, change));
    checkStoredSize(change);
    let { title, description } = newTableCard(change, label, shownResult(result()));
    return {
      change, title: sanitizeTitle(title), description, actionKind: DOCUMENT_TABLES,
      autoApprovable: true, table,
    };
  }

  let { change, card } = asked(() => pendingTableChange(tab, call, label));
  // The builder finds the table by how it reads and makes its checks on the change as it is
  // stored, and the model makes the change, so a call either refuses never becomes a card.
  let result = made(change);
  checkStoredSize(change);
  let { title, description } = finishedTableCard(card, shownResult(result()));
  return {
    change, title: sanitizeTitle(title), description, actionKind: DOCUMENT_TABLES,
    autoApprovable: true,
  };
}

/**
 * Check a call against the tab as it stands, with every pending edit applied, and build the
 * change to queue and its card (`tableChangeFrom`). The change is made in the tab by the model,
 * so a call the builders or the model refuse never becomes a card, and the card shows the lines
 * of the tab that will read otherwise once the change is made. `label` names the tab in
 * approval text.
 *
 * `version` is the tab in `store`, read through one reading (`storedTabReading`) that the
 * checks and the edit ask: the table a call names is found by its number in the runs'
 * summaries, and the checks, the requests and the card of a change to it are made from the
 * piece around it; a new table's place is found by a scan of the stored Markdown or at the
 * tab's end. The card of a change to an existing table is written from that piece BEFORE the
 * edit, but for its result: the reading lets go of the piece as the edit is made, so no
 * rendering of the tab before is in hand while the model runs. The change is made with
 * `docEditResult`, which stores what it makes, before the caller's later checks and before
 * the change is queued (the editor sweeps the copy before it prepares, so a preparation that
 * fails later leaves rows the next one removes). A new table's number is then read from the
 * piece around its place, made once more (`insertedTableNumber`). The card's result reads the
 * stored Markdown of the runs in which the tab reads otherwise with the change
 * (`changedMarkdown`), and neither tab's Markdown whole: where the change renumbers a list
 * far after its table, those runs reach that far, bounded by the tab's Markdown. What storage
 * throws beneath the reading passes as storage threw it (`unwrapped`); the card's reads run
 * after the edit is stored, in no transaction, so a copy they find unreadable is dropped by
 * the store where it throws.
 */
export function prepareTableChange(
  store: DocStore, version: DocVersion, call: TableCall, label: string,
): PreparedTableChange {
  return unwrapped(() => {
    let reading = storedTabReading(store, version);
    return tableChangeFrom(reading, call, label, change => {
      let edit = docEditResult(store, version, change, reading);
      // A new table's first request says where the table goes.
      if (change.type === "insertTable" && !(edit.requests[0] && "insertTable" in edit.requests[0])) {
        throw new Error("insertTable: no position was reported.");
      }
      return () => {
        // The piece a new table's number was read from is let go before the card's reads.
        reading.takeDecoded();
        return asked(() => changedMarkdown(store, version, edit.after));
      };
    });
  });
}

/** Refuse a change when the tables recorded by the waiting changes would pass their limit. */
export function assertTableQueueRoom(
  queued: readonly { type: string; expected?: string }[],
  change: TableChange,
): void {
  // A new table records no table.
  if (change.type === "insertTable") return;
  let recorded = change.expected.length;
  for (let record of queued) recorded += record.expected?.length ?? 0;
  if (recorded > MAX_QUEUED_TABLE_LENGTH) {
    throw new Error(
      `${change.type}: the table changes already waiting on this document hold too much table ` +
      "content for another. Retry once some of them have been approved or rejected.");
  }
}

// ---------------------------------------------------------------------------
// How a tab reads otherwise once an edit is made in it
// ---------------------------------------------------------------------------

/** The Markdown of the runs in which two versions of a tab differ, and the span they differ in. */
export type ChangedMarkdown = {
  /** Where both strings start in their tabs' Markdown: the same offset in each. */
  readonly mdStart: number;
  /** The Markdown of the version before, from there. */
  readonly before: string;
  /** The Markdown of the version after, from there, to where the two tabs read alike again. */
  readonly after: string;
  /** The tables of the version after that stand in `after`, in `after`'s own offsets. */
  readonly tables: readonly MarkdownRange[];
  /** `changedSpan` of the two tabs' Markdown, in the two strings' offsets. */
  readonly span: { readonly start: number; readonly beforeEnd: number; readonly afterEnd: number };
};

// What a comparison's fault is thrown as: a fault of this code, which quotes nothing.
const fault = (): Error => new Error("The runs in which two versions of a tab differ could not be read.");

// One version's side of a comparison: a reader of its runs (`DocStore.reader`), the run in
// hand, where that run starts in its tab's Markdown, and its Markdown once it was asked for.
type Side = {
  readonly next: () => StoredRun | undefined;
  run: StoredRun | undefined;
  start: number;
  text: string | undefined;
  /** Whether the reader has passed its list. */
  ended: boolean;
  /** A place a side that reads forwards notes the start of: the list's end where it lists none. */
  readonly mark: number;
  markAt: number | undefined;
};

// A side that has no run in hand yet and stands at offset `at` of its tab's Markdown.
const sideOf = (next: () => StoredRun | undefined, at: number, mark = -1): Side =>
  ({ next, run: undefined, start: at, text: undefined, ended: false, mark, markAt: undefined });

const written = (run: StoredRun | undefined): number => run?.summary.markdownLength ?? 0;

// The Markdown of the run a side has in hand: one row, read once a run.
const textOf = (side: Side): string => side.text ??= side.run!.markdown();

// Moves a side that reads forwards to its next run, which starts where the one in hand ends.
function forth(side: Side): void {
  side.start += written(side.run);
  side.run = side.next();
  side.text = undefined;
  side.ended = side.run === undefined;
  if (side.markAt === undefined && (side.run === undefined || side.run.place === side.mark)) {
    side.markAt = side.start;
  }
}

// Moves a side that reads backwards to the run before the one in hand, which ends where
// that one starts.
function back(side: Side): void {
  side.run = side.next();
  side.text = undefined;
  side.start -= written(side.run);
  side.ended = side.run === undefined;
}

// A run of a version's list that writes a character: its place, and where its Markdown starts.
type RunStart = { readonly place: number; readonly start: number };

// THE FRONT of a comparison (`changedMarkdown`): `T`, the first offset at which the two tabs
// differ, from `t` on, where both sides stand, and no further than `until()` (the start of
// the range named, as far as it is known; `Infinity` with none). Two runs that stand at one
// offset and are one entry are passed with nothing read; otherwise the stretch both runs in
// hand hold is compared by UTF-16 units, with no string built. `entered` is told each run of
// `after` that writes a character as its side moves to it. Answers `alike` where both lists
// are passed at once or, with `alikeFrom`, both sides stand at the starts of the runs at
// those places (the lists are the same entries from there on).
function firstUnlike(
  b: Side, a: Side, t: number, until: () => number,
  alikeFrom: { readonly before: number; readonly after: number } | undefined,
  entered: (run: RunStart) => void,
): { T: number; differs: boolean; alike?: true } {
  for (;;) {
    // Each side at the run that holds the character at `t`, or past its list.
    while (!b.ended && t >= b.start + written(b.run)) forth(b);
    while (!a.ended && t >= a.start + written(a.run)) {
      forth(a);
      if (a.run && written(a.run) > 0) entered({ place: a.run.place, start: a.start });
    }
    let limit = until();
    if (t >= limit) return { T: limit, differs: false };
    if (!b.run || !a.run) {
      // A tab's end is a difference, unless both end here.
      return b.run || a.run ? { T: t, differs: true } : { T: t, differs: false, alike: true };
    }
    let atStarts = t === b.start && t === a.start;
    if (alikeFrom && atStarts && b.run.place >= alikeFrom.before &&
        a.run.place - b.run.place === alikeFrom.after - alikeFrom.before) {
      return { T: t, differs: false, alike: true };
    }
    if (atStarts && b.run.entry === a.run.entry) {
      t = Math.min(t + written(b.run), limit);
      continue;
    }
    let end = Math.min(b.start + written(b.run), a.start + written(a.run), limit);
    let before = textOf(b), after = textOf(a);
    for (; t < end; t++) {
      if (before.charCodeAt(t - b.start) !== after.charCodeAt(t - a.start)) return { T: t, differs: true };
    }
  }
}

// THE END of a comparison (`changedMarkdown`): `U`, one past the last offset of `before` at
// which the two tabs differ, counted from their ends. The sides read backwards; `before`'s
// stands at `u` and `after`'s at `u + delta`, and neither passes below `floor` (an offset of
// `before`). Two runs that end at one distance from the tabs' ends and are one entry are
// passed with nothing read, to the floor at most; otherwise the stretch both runs in hand
// hold is compared backwards by UTF-16 units, with no string built.
function lastUnlike(
  b: Side, a: Side, u: number, delta: number, floor: number,
): { U: number; differs: boolean } {
  for (;;) {
    if (u <= floor) return { U: u, differs: false };
    // Each side at the run that holds the character before its offset.
    while (!b.ended && u <= b.start) back(b);
    while (!a.ended && u + delta <= a.start) back(a);
    // A list is passed at offset 0, which is no higher than a floor.
    if (!b.run || !a.run) throw fault();
    if (u === b.start + written(b.run) && u + delta === a.start + written(a.run) &&
        b.run.entry === a.run.entry) {
      u = Math.max(b.start, floor);
      continue;
    }
    let low = Math.max(b.start, a.start - delta, floor);
    let before = textOf(b), after = textOf(a);
    for (; u > low; u--) {
      if (before.charCodeAt(u - 1 - b.start) !== after.charCodeAt(u - 1 + delta - a.start)) {
        return { U: u, differs: true };
      }
    }
  }
}

// What a comparison keeps of the runs before place `to` of `before`'s list, which both lists
// hold, from one pass of their summaries with no Markdown read: `x`, the Markdown they
// write; the last two of them that write a character, `held` and `prior` before it; and
// `first`, the one that holds the start of the range `named`, where that is below `x`.
function runsBefore(
  store: DocStore, before: DocVersion, to: number, named: MarkdownRange | "end" | undefined,
): { x: number; held?: RunStart; prior?: RunStart; first?: RunStart } {
  let kept: ReturnType<typeof runsBefore> = { x: 0 };
  if (to === 0) return kept;
  store.walk(before, run => {
    // A walk that hands its runs again starts the answer afresh.
    if (run.place === 0) kept = { x: 0 };
    if (run.summary.markdownLength > 0) {
      kept.prior = kept.held;
      kept.held = { place: run.place, start: kept.x };
      if (named && named !== "end" && kept.x <= named.mdStart) kept.first = kept.held;
    }
    kept.x += run.summary.markdownLength;
    return true;
  }, 0, to);
  return kept;
}

// Steps 1 to 3 of a comparison (`changedMarkdown`), with the two readers they need, which
// are let go when this returns: `x` by a pass of `before`'s summaries over the runs before
// `c.from`; THE FRONT, `T`, the first offset at which the two tabs differ, from `x` on and no
// further than the start of the range named (a range named before `x` starts in runs both
// lists hold: nothing is compared); `origin`, the run of `after` the strings start at: the
// one that holds `T` or, with no range named, the run before it that writes a character,
// where there is one, since the lines a change adds are placed by the line before them;
// and `eB` and `eA`, the Markdown offsets at which the two ranges `c` names end, which the
// readers run on to with no Markdown read. `range` is the range named, in offsets. Answers
// nothing where no range is named and the two tabs read alike, and `"too-long"` AS SOON AS
// THE FRONT ENDS where `T` differs more than `most` characters before the range named:
// before a reader runs on, so with no row read of the lists past `T`. The range `"end"`
// names starts at `before`'s end, which its reader alone runs on to first.
function comparedFromFront(
  store: DocStore, before: DocVersion, after: DocVersion,
  c: { from: number; beforeTo: number; afterTo: number }, named: MarkdownRange | "end" | undefined,
  most: number | undefined,
): {
  x: number; T: number;
  /** Whether `before` holds a character at `T`: `min(T + 1, LB)` is then `T + 1`. */
  holdsT: boolean;
  origin: RunStart; eB: number; eA: number;
  range: { start: number; end: number } | undefined;
} | "too-long" | undefined {
  let { x, ...kept } = runsBefore(store, before, c.from, named);
  let b = sideOf(store.reader(before, c.from), x, c.beforeTo);
  let a = sideOf(store.reader(after, c.from), x, c.afterTo);
  // `held` is the run of `after` that holds `T`, and `prior` the one before it that writes.
  let { held, prior } = kept;
  let front: { T: number; differs: boolean; alike?: true };
  if (named && named !== "end" && named.mdStart < x) {
    front = { T: named.mdStart, differs: false };
    held = kept.first;
  } else {
    // The end of `before` is known once its list is passed.
    let until = () => named === undefined ? Infinity
      : named === "end" ? (b.ended ? b.start : Infinity) : named.mdStart;
    front = firstUnlike(
      b, a, x, until, named ? undefined : { before: c.beforeTo, after: c.afterTo },
      run => {
        prior = held;
        held = run;
      });
    if (!named && front.alike) return undefined;
  }
  let holdsT = front.T < x || b.run !== undefined;
  let origin: RunStart = (named ? held : prior ?? held) ?? { place: 0, start: 0 };
  // 5. `most`, of the front: whether `T` differs too far before a range that starts at `start`.
  let tooFar = (start: number) => most !== undefined && front.differs && start - front.T > most;
  if (named && named !== "end" && tooFar(named.mdStart)) return "too-long";
  // The readers run on by the summaries: `before`'s to its tab's end where that is the
  // range named, which says where that range starts.
  while (b.markAt === undefined) forth(b);
  if (named === "end") {
    while (!b.ended) forth(b);
    if (tooFar(b.start)) return "too-long";
  }
  while (a.markAt === undefined) forth(a);
  let range = named === undefined ? undefined
    : named === "end" ? { start: b.start, end: b.start } : { start: named.mdStart, end: named.mdEnd };
  return { x, T: front.T, holdsT, origin, eB: b.markAt, eA: a.markAt, range };
}

// The characters `[from, to)` of a version's Markdown, cut out of the runs that hold them:
// its runs are passed from the one at `place`, whose Markdown starts at offset `at`, by
// their summaries, and those that hold a character of the stretch are read, the first and
// the last cut. The reader is let go when this returns.
function stretchOf(
  store: DocStore, version: DocVersion, place: number, at: number, from: number, to: number,
): string {
  let next = store.reader(version, place);
  let parts: string[] = [];
  for (let run = next(); run && at < to; run = next()) {
    let end = at + written(run);
    if (end > from && end > at) {
      let text = run.markdown();
      parts.push(at >= from && end <= to ? text : text.slice(Math.max(from, at) - at, to - at));
    }
    at = end;
  }
  return parts.length === 1 ? parts[0] : parts.join("");
}

// Step 4 of a comparison (`lastUnlike`), with the two readers it needs, backwards from the
// ends of the ranges `c` names, which are let go when this returns.
function comparedFromEnd(
  store: DocStore, before: DocVersion, after: DocVersion,
  c: { beforeTo: number; afterTo: number }, eB: number, eA: number, floor: number,
): number {
  return lastUnlike(
    sideOf(store.reader(before, c.beforeTo, true), eB),
    sideOf(store.reader(after, c.afterTo, true), eA), eB, eA - eB, floor).U;
}

/**
 * The stored Markdown in which `after` reads otherwise than `before`, and the span the two
 * tabs differ in (`changedSpan` of their whole Markdown, in the strings' offsets), with
 * neither tab's Markdown read whole. Outside the range `DocStore.changed` answers, the two
 * lists are the same entries; inside it the two versions' Markdown is compared AS TEXT, a
 * run of each in hand: forwards to the first character that differs, no further than the
 * start of `named` (a range of `before`'s Markdown; `"end"`: the empty range at its end),
 * and backwards to the last, no further than the end of `named`. The strings are whole
 * runs of `after`: from the run that holds the first character that differs, or the first
 * named (with no `named`, one run more before it, where there is one), through the run
 * that holds the character after the last that differs and after the range named.
 * `before`'s string is the same stretch of its own tab, cut out of its runs at those
 * offsets. While `changedSpan` answers `more`, the run of `after` beyond on that side,
 * which reads alike in both versions, is read once and added to both strings.
 * HOLDS the two strings and a page of each list; while it compares, one run's Markdown of
 * each version and nothing joined. A text edit's strings are its text with at most `most`
 * characters and a run of `after` on each side; a table change's, with no `most`, are
 * bounded by the tab's Markdown. WHAT THE COMPARISONS READ: a row of the list for each run
 * a reader passes, and a row of Markdown for each run that is not passed as the same entry
 * at the same offset, so text listed anew that reads as before is read once in each
 * version, a run a side, and never joined.
 * @param most With it: answers `"too-long"`, with nothing joined, where a character that
 * differs, or one tab's end, stands more than `most` characters before the start of
 * `named`, or more than `most` after its end: the two tabs' span then holds all of them
 * beside the text named, so nothing is refused that the whole Markdown would show to fit.
 * An extension never answers it.
 */
export function changedMarkdown(
  store: DocStore, before: DocVersion, after: DocVersion, named?: MarkdownRange | "end",
): ChangedMarkdown;
export function changedMarkdown(
  store: DocStore, before: DocVersion, after: DocVersion,
  named: MarkdownRange | "end" | undefined, most: number | undefined,
): ChangedMarkdown | "too-long";
export function changedMarkdown(
  store: DocStore, before: DocVersion, after: DocVersion,
  named?: MarkdownRange | "end", most?: number,
): ChangedMarkdown | "too-long" {
  // NAMES, as the steps below use them. `B` and `A` are the Markdown of `before` and of
  // `after`, never in hand, `LB` and `LA` their lengths; `c` is where the two lists differ;
  // `x` is the Markdown length of the runs before place `c.from`, the same runs in both;
  // `delta` is `LA - LB`. Offsets are of `B` unless said: the character of `A` that stands
  // against `B`'s at `u`, counted from the tabs' ends, is `A[u + delta]`. The run that
  // holds an offset is the last run that writes a character and starts at or before it.
  // NOTHING BELOW COMPARES THE RUN AT A PLACE OF ONE LIST WITH THE RUN AT A PLACE OF THE
  // OTHER, but to pass, with nothing read, two runs that are one entry and stand at one
  // offset or at one distance from the tabs' ends: the runs an edit touched are cut again
  // when its version is stored, so text that reads as before stands in other runs.

  // 1. to 3. THE FRONT, in a frame of its own: its readers are let go with it.
  // 5. `most` is decided as each comparison ends and before a string is joined: the
  // front's as soon as the front ends, in that frame.
  let c = store.changed(before, after);
  let front = comparedFromFront(store, before, after, c, named, most);
  if (front === "too-long") return front;
  if (!front) {
    return { mdStart: 0, before: "", after: "", tables: [], span: { start: 0, beforeEnd: 0, afterEnd: 0 } };
  }
  let { x, T, holdsT, origin, eB, eA, range } = front;
  let O = origin.start, delta = eA - eB;

  // 4. THE END: `U`, one past the last offset at which the two tabs differ, counted from
  // their ends, by two readers backwards from the ends of the ranges `c` names. `before`'s
  // side stops at the end of the range named (`O` with none) and `after`'s at `O`.
  let U = comparedFromEnd(store, before, after, c, eB, eA, Math.max(range ? range.end : O, O - delta));
  if (range && most !== undefined && U - range.end > most) return "too-long";

  // 6. THE STRINGS. `after`'s is whole runs: from the one that starts at `O` through the
  // one that holds the later of `A[w + delta]` and `A[T]`, which ends at `Ea`.
  let w = Math.max(U, range ? range.end : 0, holdsT ? T + 1 : T);
  let last = Math.max(w + delta, T);
  let afterRuns = store.reader(after, origin.place);
  let parts: string[] = [];
  let tables: MarkdownRange[] = [];
  let length = 0;
  // The first run of `after` past its string that writes a character.
  let beyond: StoredRun | undefined;
  let writing = (): StoredRun | undefined => {
    let run = afterRuns();
    while (run && written(run) === 0) run = afterRuns();
    return run;
  };
  // A run's Markdown and its tables, added after what `tables` and `length` hold.
  let add = (run: StoredRun): string => {
    for (let table of run.summary.tables) {
      tables.push({ mdStart: table.mdStart + length, mdEnd: table.mdEnd + length });
    }
    length += written(run);
    return run.markdown();
  };
  for (;;) {
    beyond = writing();
    if (!beyond || O + length > last) break;
    parts.push(add(beyond));
  }
  let afterText = parts.length === 1 ? parts[0] : parts.join("");
  parts = [];
  let Ea = O + length;

  // `before`'s is the same stretch of its own tab, `B[O, Ea - delta)`: the runs that hold
  // it are found by a pass of its summaries, from `O`'s run where both lists hold it and
  // from `c.from` otherwise, and the first and the last are cut.
  let Eb = Ea - delta;
  // The strings start no later than the range named, and `before`'s ends no earlier.
  if ((range && O > range.start) || Eb < Math.max(O, range ? range.end : O)) throw fault();
  let beforeText = O < x
    ? stretchOf(store, before, origin.place, O, O, Eb) : stretchOf(store, before, c.from, x, O, Eb);
  // What the span leans on: each string is the stretch the summaries say, and is empty,
  // ends in a line break or ends its tab.
  let ends = (text: string) => text === "" || text.endsWith("\n") || beyond === undefined;
  if (afterText.length !== length || beforeText.length !== Eb - O || !ends(afterText) || !ends(beforeText)) {
    throw fault();
  }

  // 7. The span, extended while the text beyond the strings could change it: the run of
  // `after` beyond on that side that writes a character, which both versions read alike, is
  // read once and added to both strings.
  // An extension takes one run the first times it is asked for on a side and twice as many
  // each time after that, so a span that walks far over text that repeats (equal tables in a
  // row) is asked for a number of times that grows with the logarithm of the runs it passes,
  // and the comparisons together read each character a bounded number of times. The strings
  // may then hold runs the span did not need: they read alike in both versions, and the
  // span, in the tab's own offsets, is the one the fewest runs give.
  let mdStart = O;
  let earlier: (() => StoredRun | undefined) | undefined;
  let asked = { before: 0, after: 0 };
  for (;;) {
    markdownHeld(beforeText.length + afterText.length);
    docStoreCost.spanCharsCompared += beforeText.length + afterText.length;
    let span = changedSpan(
      beforeText, afterText, range && { start: range.start - mdStart, end: range.end - mdStart },
      { before: mdStart > 0, after: beyond !== undefined });
    if (!("more" in span)) return { mdStart, before: beforeText, after: afterText, tables, span };
    let take = extensionRuns(asked[span.more]++);
    if (span.more === "after") {
      if (!beyond) throw fault();
      let texts: string[] = [];
      for (; beyond && texts.length < take; beyond = writing()) texts.push(add(beyond));
      let text = texts.length === 1 ? texts[0] : texts.join("");
      beforeText += text;
      afterText += text;
    } else {
      earlier ??= store.reader(after, origin.place, true);
      // The runs before the strings, nearest first.
      let runs: StoredRun[] = [];
      while (runs.length < take) {
        let run = earlier();
        while (run && written(run) === 0) run = earlier();
        if (!run) break;
        runs.push(run);
      }
      if (runs.length === 0) throw fault();
      runs.reverse();
      let added: MarkdownRange[] = [];
      let by = 0;
      for (let run of runs) {
        for (let table of run.summary.tables) {
          added.push({ mdStart: table.mdStart + by, mdEnd: table.mdEnd + by });
        }
        by += written(run);
      }
      for (let table of tables) added.push({ mdStart: table.mdStart + by, mdEnd: table.mdEnd + by });
      tables = added;
      let text = runs.length === 1 ? runs[0].markdown() : runs.map(run => run.markdown()).join("");
      beforeText = text + beforeText;
      afterText = text + afterText;
      mdStart -= by;
      length += by;
    }
  }
}

/** How many runs the extension asked for after `earlier` others on its side takes. */
function extensionRuns(earlier: number): number {
  return earlier < 4 ? 1 : 2 ** Math.min(earlier - 3, 16);
}

// ---------------------------------------------------------------------------
// replaceText and appendText
// ---------------------------------------------------------------------------

/**
 * Where the one place of `oldMarkdown` starts in the tab `tab` reads, and whether the change
 * lies inside one table, asked of the piece around that place. Throws the refusal of text
 * that is not in the tab exactly once. In a function of its own, so that no frame of a
 * preparation names the piece while the edit is made.
 */
function replacementPlace(
  tab: TabReading, oldMarkdown: string, newMarkdown: string,
): { matchStart: number; inTable: boolean } {
  let matchStart = uniqueMarkdown(tab, oldMarkdown);
  let piece = tab.piece({ markdown: { mdStart: matchStart, mdEnd: matchStart + oldMarkdown.length } });
  let path = replacementPath(
    piece, { matchStart: matchStart - (piece.part?.mdStart ?? 0), oldMarkdown, newMarkdown });
  return { matchStart, inTable: path.kind === "cells" };
}

/**
 * Check a replacement against the tab as it stands, on the path it takes, and say what its card
 * shows: the tab's rendering before and after the replacement is made in it, over the span that
 * differs (`changedSpan`). Throws the refusal of text that is not in the tab exactly once, and
 * whatever the builders or the model refuse. `label` names the tab in approval text. `version`
 * is the tab in `store`: the text is found by a scan of its stored Markdown and the path from
 * the piece around it, through one reading (`storedTabReading`) that the edit asks too; the
 * replacement is made with `docEditResult`, which stores what it makes; and the card reads the
 * stored Markdown of the runs in which the tab reads otherwise with it (`changedMarkdown`),
 * and neither tab's Markdown whole. What storage throws beneath the reading passes as storage
 * threw it (`unwrapped`); the card's reads run after the edit is stored, in no transaction, so
 * a copy they find unreadable is dropped by the store where it throws.
 * @param limit The display limit of the caller: a card whose span holds more than
 * `limit.chars` characters before the text named, or after it, is refused with
 * `limit.refusal()` before any of them is joined. The caller's own check of what the card
 * shows refuses every such card with the same text.
 */
export function prepareTextReplacement(
  store: DocStore, version: DocVersion, oldMarkdown: string, newMarkdown: string, label: string,
  limit: { readonly chars: number; refusal(): Error },
): PreparedTextReplacement {
  return unwrapped(() => {
    let reading = storedTabReading(store, version);
    // The cell path decides for every replacement whose change lies inside one table: what it
    // refuses is refused, whatever the paragraph path would make of it.
    let { matchStart, inTable } =
      asked(() => replacementPlace(reading, oldMarkdown, newMarkdown));
    let matchEnd = matchStart + oldMarkdown.length;
    let { after } = docEditResult(store, version, {
      type: "replaceText", oldMarkdown, newMarkdown, ...(inTable ? { inTable: true } : {}),
    }, reading);
    let changed = asked(() => changedMarkdown(
      store, version, after, { mdStart: matchStart, mdEnd: matchEnd }, limit.chars));
    if (changed === "too-long") throw limit.refusal();
    let { before, span } = changed;
    // The text named, in the strings' offsets.
    let start = matchStart - changed.mdStart, end = matchEnd - changed.mdStart;
    return {
      inTable,
      // The same strings mean different things in a cell and in a paragraph, so the card of a
      // change to cells says how its values read.
      prose: inTable
        ? `Replace text in a table of tab ${label}. The values below are the table's HTML: ` +
          "Markdown syntax in them is written to the cells as typed."
        : `Replace text in tab ${label}.`,
      syntax: inTable ? "html" : "markdown",
      shown: {
        old: before.slice(span.start, span.beforeEnd),
        requested: before.slice(span.start, start) + newMarkdown + before.slice(end, span.beforeEnd),
        rendered: changed.after.slice(span.start, span.afterEnd),
      },
    };
  });
}

/**
 * Check an append against the tab as it stands and give what it adds as a read will return it:
 * the text the tab's rendering gains once the append is made, every empty paragraph the append
 * writes included, without the one line break that sets it off from the tab's text before it and
 * without the line break that ends its last line. On a blank tab that is the tab's whole text.
 * `version` is the tab in `store`: the append is built from the piece at the tab's end, through
 * one reading (`storedTabReading`), and made with `docEditResult`, which stores what it makes;
 * what it adds is read from the stored Markdown of the runs in which the tab reads otherwise
 * with it (`changedMarkdown`), and on a blank tab from the Markdown of the tab it gives, which
 * is the append's own text. What storage throws beneath the reading passes as storage threw it
 * (`unwrapped`); the reads after the edit run in no transaction, so a copy they find unreadable
 * is dropped by the store where it throws.
 */
export function prepareAppend(store: DocStore, version: DocVersion, markdown: string): string {
  return unwrapped(() => {
    let reading = storedTabReading(store, version);
    // The piece the append is built from, asked outside the edit's own `try` and remembered
    // by the reading for the build: it is named by no frame here.
    asked(() => void reading.piece("end"));
    let { after } = docEditResult(store, version, { type: "appendText", markdown }, reading);
    // A blank tab's one empty paragraph is taken by the append, and its line break cannot be told
    // from the ones the append writes, so the span is read only where the tab has text.
    if (reading.blank()) return asked(() => store.markdown(after)).replace(/\n$/, "");
    // The append stands at the end of the tab's text, which is the range named: lines read
    // without one may be placed earlier, where the tab's last line repeats in what is appended.
    let changed = asked(() => changedMarkdown(store, version, after, "end"));
    return changed.after.slice(changed.span.start, changed.span.afterEnd)
      .replace(/^\n/, "").replace(/\n$/, "");
  });
}
