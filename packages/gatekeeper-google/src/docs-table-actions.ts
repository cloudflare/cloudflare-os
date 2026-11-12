// From a call on a Google Doc's tables to what the connection stores and submits: the checks a
// call gets once, when it is made, the change to queue with the reference it records of its
// table, and the approval card. Everything here is a pure function of a tab's simulated content
// and the call. Every check a replay repeats is made by the engine (`./docs-tables`), which also
// words its refusal.

import {
  buildDescription, sanitizeTitle, type RenderedDescription,
} from "@gadgets/gatekeeper-kit/action-description";
import type { ActionKind } from "@gadgets/workshop-shared/gatekeeper";
import {
  applyNewTable, applyTableChange, applyTextReplacement, checkLookTarget, checkTabTableCells,
  checkTableTarget,
  hiddenContent, MAX_TABLE_COLUMNS, replaceTableText, runParagraphReplacement, tableLines,
  tableIdentity, tableShape, tableSize, tableTextRequests,
} from "./docs-tables";
import type { HiddenContent, LookChange, TableChange, TextReplacement } from "./docs-tables";
import { EDGES, points, SIDES } from "./docs-table-look";
import type { CellStyleChange } from "./docs-table-look";
import type {
  DocTableBorder, DocTableCells, DocTableCellStyle, DocTableDeletion, DocTableInsertion, NewDocTable,
} from "./docs-types";
import {
  applyMarkdownEdit, canonicalizeMarkdownReplacement, computeReplaceOperations, lineStart,
  MAX_MARKDOWN_BLOCKS, stripUnwritableCharacters, tableRowCells,
} from "./markdown-converter";
import type { DocTabSnapshot, EditableMarkdown, MarkdownRange } from "./markdown-converter";

/**
 * Adding or deleting a table, or rows or columns of one, and changing a table's look. A kind of
 * its own, apart from "Document edits", so a rule enabled for either covers only what its label
 * says. A deletion may apply without asking too, since the document's version history undoes it.
 */
export const DOCUMENT_TABLES: ActionKind = { tag: "document-tables", label: "Table changes" };

/** One of the session's table methods, as called. */
export type TableCall =
  | { method: "insertTable"; table: NewDocTable }
  | { method: "insertTableRows" | "insertTableColumns"; lines: DocTableInsertion }
  | { method: "deleteTableRows" | "deleteTableColumns"; lines: DocTableDeletion }
  | { method: "deleteTable"; table: number }
  | { method: "setTableCellStyle"; cells: DocTableCells & { style: DocTableCellStyle } };

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
   * What the card shows, over one range of the tab: as it reads now, with the replacement as
   * written, and as a read will return it.
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
  return `${width} ${border.dash ?? "solid"} ${colorOf(op, `${name}.color`, border.color ?? "#000000")}`;
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
    }
  }
}

// ---------------------------------------------------------------------------
// A call against the tab
// ---------------------------------------------------------------------------

function htmlOf(content: EditableMarkdown, table: MarkdownRange): string {
  return content.markdown.slice(table.mdStart, table.mdEnd);
}

/** The table a call names by its position, or the refusal of a position that holds none. */
function tableAt(
  content: EditableMarkdown, table: number, op: string, tabId: string,
): MarkdownRange {
  let target = content.tables[table];
  if (target) return target;
  let held = content.tables.length;
  throw new Error(held === 0
    ? `${op}: tab "${tabId}" has no table ${table}: it has no tables.`
    : `${op}: tab "${tabId}" has no table ${table}. It has ${plural(held, "table")}, numbered ` +
      `from 0 in the order getContent("${tabId}") shows them.`);
}

/**
 * Refuse a change to the table at `table` while another table of the content reads the same: a
 * queued change is kept to its table by how the table reads. Tables are compared by their
 * shape, without their looks and the list and footnote numbers an edit elsewhere in the tab can
 * move.
 */
function checkReadsAlone(content: EditableMarkdown, table: number, op: string): void {
  let shape = tableShape(htmlOf(content, content.tables[table]));
  let other = content.tables.findIndex((candidate, index) =>
    index !== table && tableShape(htmlOf(content, candidate)) === shape);
  if (other < 0) return;
  throw new Error(
    `${op}: table ${table} reads the same as table ${other} of this tab (styles, column ` +
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
function insertionChange(
  content: EditableMarkdown, call: InsertionCall, tab: DocTabSnapshot,
): ExistingTableChange {
  let op = call.method;
  let { table, cells: given = [] } = call.lines;
  let target = tableAt(content, table, op, tab.tabId);
  let { rows, columns } = tableSize(content.markdown, target, op);
  let ofRows = op === "insertTableRows";
  let at = call.lines.at ?? (ofRows ? rows : columns);
  // Rows are written one array for each new row, so `cells` says how many are wanted. Columns
  // are written row by row too, and a `cells` that sets their number would turn one array
  // written for each new column into as many columns as it holds texts.
  let count = call.lines.count ?? (ofRows ? Math.max(given.length, 1) : 1);
  // What no later call gets past comes before the refusals that say what to do next.
  checkTableTarget(content, table, { type: op, at, count }, tab);
  // The cells the call would add, each once for each paragraph of its text.
  let width = ofRows ? columns : rows;
  checkTabTableCells(content, count * width + countLineBreaks(given), op);
  checkReadsAlone(content, table, op);

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
  let expected = tableIdentity(htmlOf(content, target));
  return ofRows
    ? { type: "insertTableRows", at, cells: storedCells(given, count, columns), expected }
    : { type: "insertTableColumns", at, cells: storedCells(given, rows, count), expected };
}

/** The change that deletes rows or columns of the table a call names. */
function deletionChange(
  content: EditableMarkdown, call: DeletionCall, tab: DocTabSnapshot,
): ExistingTableChange {
  let op = call.method;
  let { table, at, count = 1 } = call.lines;
  let target = tableAt(content, table, op, tab.tabId);
  let shape = { type: op, at, count };
  checkTableTarget(content, table, shape, tab);
  checkReadsAlone(content, table, op);
  return {
    ...shape, expected: tableIdentity(htmlOf(content, target)),
    ...hiddenContent(content, table, shape),
  };
}

/** The change that deletes the table a call names. */
function tableDeletionChange(
  content: EditableMarkdown, table: number, tab: DocTabSnapshot,
): ExistingTableChange {
  let op = "deleteTable" as const;
  let target = tableAt(content, table, op, tab.tabId);
  let shape = { type: op };
  checkTableTarget(content, table, shape, tab);
  checkReadsAlone(content, table, op);
  return {
    ...shape, expected: tableIdentity(htmlOf(content, target)),
    ...hiddenContent(content, table, shape),
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
function textBefore(content: EditableMarkdown, table: MarkdownRange): string | undefined {
  let { markdown, tables } = content;
  // `end` is the line break that ends the line looked at.
  for (let end = table.mdStart - 1; end >= 0;) {
    let start = lineStart(markdown, end);
    let inside = tables.find(other => other.mdStart <= start && start < other.mdEnd);
    if (inside) {
      end = inside.mdStart - 1;
    } else if (start < end) {
      return markdown.slice(start, end);
    } else {
      end = start - 1;
    }
  }
  return undefined;
}

/** A cell's block as its own HTML: without its lines' indentation and its last line break. */
function cellHtml(block: string): string {
  return block.slice(0, -1).replace(/^ {4}/gm, "");
}

/** The card of a new table. */
function newTableCard(
  change: Extract<TableChange, { type: "insertTable" }>, label: string,
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
    ? " It holds suggested changes to its rows, columns or cells, which are deleted with it."
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
 * The card of a change to the table at `table`, written from the content as it reads before
 * the change.
 */
function existingTableCard(
  content: EditableMarkdown, table: number, change: ExistingTableChange, label: string,
): { title: string; description: RenderedDescription } {
  let { markdown } = content;
  let target = content.tables[table];
  // The table's place then: the change follows its table if that place changes before approval.
  let was = ` It was table ${table + 1} of the tab when this change was requested.`;
  let before = textBefore(content, target);
  let describe = (prose: string) => buildDescription(prose + was);
  // What a change adds or deletes comes first, since the Workshop cuts a long card short. The
  // fields that tell which table it is follow.
  let located = (
    description: ReturnType<typeof buildDescription>, firstRow?: string, rowAbove?: string,
  ) => {
    if (before !== undefined) description.verbatim("Text before the table", before, "markdown");
    if (firstRow !== undefined) description.verbatim("First row of the table", firstRow, "html");
    if (rowAbove !== undefined) description.verbatim("Row above the new rows", rowAbove, "html");
    return description.finish();
  };

  if (change.type === "deleteTable") {
    let description = describe(
      `Delete a table of tab ${label}, with everything in it.${hiddenNotes(change)}`);
    description.verbatim("Table", htmlOf(content, target), "html");
    return { title: "Delete a table in Google Doc", description: located(description) };
  }

  let { rows } = tableLines(markdown, target);
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
    return {
      title: "Restyle table cells in Google Doc", description: located(description, firstRow),
    };
  }
  let { at } = change;
  switch (change.type) {
    case "insertTableRows": {
      let { cells } = change;
      let empty = isEmpty(cells);
      let copies = tableRowCells(target, at < rows.length ? at : rows.length - 1)
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
            "any other chip."));
      if (!empty) description.json("New rows", cells);
      // Below the first row, the first row's field already shows the row above.
      let rowAbove = at >= 2 ? rowsHtml(at - 1, at - 1) : undefined;
      return {
        title: "Insert table rows in Google Doc",
        description: located(description, firstRow, rowAbove),
      };
    }
    case "insertTableColumns": {
      let { cells } = change;
      let empty = isEmpty(cells);
      let description = describe(
        `Insert ${plural(cells[0].length, "column")} in a table of tab ${label}, ` +
        (at < rows[0].cells.length ? `before its column ${at + 1}.` : "after its last column.") +
        (empty ? " They are empty." : ""));
      if (!empty) description.json("New cells, row by row", cells);
      return {
        title: "Insert table columns in Google Doc",
        description: located(description, firstRow),
      };
    }
    case "deleteTableRows": {
      let { count } = change;
      let description = describe((count === 1
        ? `Delete row ${at + 1} of a table of tab ${label}, with everything in it.`
        : `Delete rows ${at + 1} to ${at + count} of a table of tab ${label}, with everything ` +
          "in them.") +
        hiddenNotes(change));
      description.verbatim("Deleted rows", rowsHtml(at, at + count - 1), "html");
      return {
        title: "Delete table rows in Google Doc",
        description: located(description, firstRow),
      };
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
      return {
        title: "Delete table columns in Google Doc",
        description: located(description, firstRow),
      };
    }
  }
}

/** The change that sets the look of the cells a call names. */
function lookChange(
  content: EditableMarkdown, call: Extract<TableCall, { method: "setTableCellStyle" }>,
  tab: DocTabSnapshot,
): ExistingTableChange {
  let op = call.method;
  let { table, row, column, rows = 1, columns = 1, style } = call.cells;
  let target = tableAt(content, table, op, tab.tabId);
  let change: LookChange = {
    type: op, row, column, rows, columns, style: styleChange(op, style, rows, columns),
    expected: tableIdentity(htmlOf(content, target)),
  };
  checkLookTarget(content, table, change);
  checkReadsAlone(content, table, op);
  return change;
}

/** The change a call to change an existing table becomes, checked in the order a caller meets. */
function existingTableChange(
  content: EditableMarkdown, call: ExistingTableCall, tab: DocTabSnapshot,
): ExistingTableChange {
  switch (call.method) {
    case "setTableCellStyle":
      return lookChange(content, call, tab);
    case "insertTableRows":
    case "insertTableColumns":
      return insertionChange(content, call, tab);
    case "deleteTableRows":
    case "deleteTableColumns":
      return deletionChange(content, call, tab);
    case "deleteTable":
      return tableDeletionChange(content, call.table, tab);
  }
}

/**
 * Check a call against the tab as it reads now and build the change to queue and its card.
 * `tab` is the fresh tab `content` came from; `label` names it in approval text.
 */
export function prepareTableChange(
  content: EditableMarkdown, call: TableCall, tab: DocTabSnapshot, label: string,
): PreparedTableChange {
  checkTableCall(call);
  if (call.method === "insertTable") {
    let { rows, columns, cells = [], after } = call.table;
    let change: Extract<TableChange, { type: "insertTable" }> = {
      type: "insertTable", rows, columns, cells: storedCells(cells, rows, columns),
      ...(after === undefined ? {} : { after }),
    };
    // The replay refuses what the engine refuses of the change as it is stored: a tab whose
    // tables would hold too many cells, then a place the table cannot go.
    let { table } = applyNewTable(content, change, tab);
    checkStoredSize(change);
    let { title, description } = newTableCard(change, label);
    return {
      change, title: sanitizeTitle(title), description, actionKind: DOCUMENT_TABLES,
      autoApprovable: true, table,
    };
  }

  let change = existingTableChange(content, call, tab);
  // The replay finds the table by how it reads and repeats the engine's checks on the change as
  // it is stored, so a call the engine would refuse never becomes a card.
  applyTableChange(content, change, tab);
  checkStoredSize(change);
  let table = call.method === "deleteTable" ? call.table
    : call.method === "setTableCellStyle" ? call.cells.table : call.lines.table;
  let { title, description } = existingTableCard(content, table, change, label);
  return {
    change, title: sanitizeTitle(title), description, actionKind: DOCUMENT_TABLES,
    autoApprovable: true,
  };
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
// replaceText
// ---------------------------------------------------------------------------

/**
 * Check a replacement against the tab as it reads now, on the path it takes, and say what its
 * card shows. `matchStart` is where `oldMarkdown` was found in `content`; `tab` is the fresh tab
 * `content` came from; `label` names it in approval text.
 */
export function prepareTextReplacement(
  content: EditableMarkdown, tab: DocTabSnapshot, matchStart: number,
  oldMarkdown: string, newMarkdown: string, label: string,
): PreparedTextReplacement {
  // The table path is tried first, and decides for every replacement whose change lies inside
  // one table: what it refuses is refused, whatever the paragraph path would make of it.
  let inTable = replaceTableText(
    content, matchStart, oldMarkdown, newMarkdown, tab.tabId, tab.namedFormatting);
  if (inTable) {
    // With no earlier edit to this tab, approval will build exactly these requests.
    if (content.markdown === tab.markdown) {
      tableTextRequests(tab, matchStart, oldMarkdown, newMarkdown);
    }
    return {
      inTable: true,
      // The same strings mean different things in a cell and in a paragraph, so the card says
      // how its values read.
      prose: `Replace text in a table of tab ${label}. The values below are the table's HTML: ` +
        "Markdown syntax in them is written to the cells as typed.",
      syntax: "html",
      shown: inTable.shown,
    };
  }

  let { markdown } = content;
  let replacement: TextReplacement = { matchStart, oldMarkdown, newMarkdown };
  // The paragraph path, on the replacement as written or on the same change beside a table.
  let { edit, rendered } = runParagraphReplacement(content, replacement, run => {
    let canonical = canonicalizeMarkdownReplacement(run.oldMarkdown, run.newMarkdown);
    let runEnd = run.matchStart + run.oldMarkdown.length;
    applyMarkdownEdit(content, run.matchStart, runEnd, canonical);
    // With no earlier edit to this tab, approval will build exactly these requests.
    if (markdown === tab.markdown) {
      computeReplaceOperations(
        tab.sourceMap, markdown, run.matchStart, runEnd, canonical, tab.tabId);
    }
    return { edit: run, rendered: canonical };
  });
  let prose = `Replace text in tab ${label}.`;
  if (edit === replacement) {
    return {
      inTable: false, prose, syntax: "markdown",
      shown: { old: oldMarkdown, requested: newMarkdown, rendered },
    };
  }
  // Run as the same change written against the paragraph beside a table: the card shows one
  // range of the tab, from the earlier start to the later end of the match and of that line.
  let matchEnd = matchStart + oldMarkdown.length;
  let start = Math.min(matchStart, edit.matchStart);
  let end = Math.max(matchEnd, edit.matchStart + edit.oldMarkdown.length);
  // What a read returns is the replay of the replacement as it is stored. That replay takes
  // the replacement as written wherever the content accepts it, also where only the requests
  // had to be built for the change beside the table, and the two can leave a list differently.
  let replayed = applyTextReplacement(content, replacement, tab.tabId, tab).markdown;
  return {
    inTable: false, prose, syntax: "markdown",
    shown: {
      old: markdown.slice(start, end),
      requested: markdown.slice(start, matchStart) + newMarkdown + markdown.slice(matchEnd, end),
      rendered: replayed.slice(start, end + replayed.length - markdown.length),
    },
  };
}
