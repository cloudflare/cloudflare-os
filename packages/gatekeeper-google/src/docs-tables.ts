// Changes to the tables of a Google Doc tab, worked out on the tab's Markdown rendering: how a
// queued change replays over that rendering, and which batchUpdate requests make the same change
// in the document. Everything here is a pure function of a rendering; nothing mutates its input.

import type { DocsLocation, GoogleDocsRequest, TableCellLocation, TextStyle } from "./docs-api";
import {
  addRequest, applyMarkdownEdit, canonicalizeMarkdownReplacement, canonicalLinkDestination,
  cellInlineHtml, cellLinkDestination, computeReplaceOperations, docsLinkForDestination,
  dropInheritedFormatting, escapeHtml, isGoogleDocsStrippedCharacter, isSafeTableLink, lineStart,
  listLineType, rewrittenBlockStyles,
  MAX_GOOGLE_DOC_REQUESTS, packTableRow, plainTextToDocRequests, StructuredContentError,
  tableRowCells, tableRowIndexes,
} from "./markdown-converter";
import {
  cellStyleSteps, coveredCells, googleCellStyle, lookWithCellStyle, lookWithColumns,
  lookWithoutColumns, lookWithoutRows, lookWithRows, readLook, renderLook,
} from "./docs-table-look";
import type {
  CellBlock, CellLook, CellStyleChange, CellStyleStep, LookAttributes, Spans, TableLook,
} from "./docs-table-look";
import type {
  BlockMapping, CellInlineRun, DocTabSnapshot, EditableMarkdown, EditableTable, InheritedFormat,
  MarkdownRange, NamedFormatting, TableCellEntry, TableMapping,
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
 * What a deletion removes that the Markdown view does not show. The approval card of a deletion
 * shows what is deleted as the view reads, so it says these in words, and the queued change
 * records them: it applies only while what it deletes holds nothing of the kind beyond that.
 */
export type HiddenContent = {
  /** Set when a deleted cell holds an element the view shows nothing for. */
  unshown?: true;
  /** Set when a table deleted whole holds suggested changes to its rows, columns or cells. */
  suggested?: true;
};

/** A structural change to a tab's tables, as stored with its pending action. */
export type TableChange =
  | { type: "insertTable"; rows: number; columns: number; cells: string[][]; after?: string }
  | ({ type: "insertTableRows"; at: number; cells: string[][] } & TableRef)
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
// Line structure
// ---------------------------------------------------------------------------

/**
 * The rows and cells of one table's HTML, as blocks of whole lines, with where each opening tag
 * stands and the style values of its look. `colgroup` is the line, line break included, that
 * says the columns' widths, when the table has one.
 */
export type TableLines = {
  tag: MarkdownRange;                         // "<table…>"
  colgroup?: MarkdownRange;                   // "  <colgroup>…</colgroup>\n"
  look: LookAttributes;
  rows: {
    mdStart: number; mdEnd: number;          // "  <tr…>\n" … "  </tr>\n"
    tag: MarkdownRange;                       // "<tr…>"
    cells: {
      mdStart: number; mdEnd: number; tag: MarkdownRange;
      rowSpan: number; columnSpan: number; nested: boolean;
    }[];
  }[];
};

const TABLE_OPENING = /^<table(?: style="([^"]+)")?>$/;
const COLGROUP = /^  (<colgroup>(?:<col(?: style="[^"]+")?>)+<\/colgroup>)$/;
const ROW_OPENING = /^  <tr(?: style="([^"]+)")?>$/;
const CELL_OPENING = /^    <td( rowspan="(\d+)")?( colspan="(\d+)")?(?: style="([^"]+)")?>/;

function malformedTable(): Error {
  return new Error("The table's HTML is not laid out as the renderer lays a table out.");
}

/**
 * The rows and cells of a table's HTML. Throws when it is not laid out as the renderer lays a
 * table out.
 */
export function tableLines(markdown: string, table: MarkdownRange): TableLines {
  let lines = markdown.slice(table.mdStart, table.mdEnd).split("\n");
  // The last line closes the table, so every line before it has to be closed before it.
  let last = lines.length - 1;
  let tableOpening = TABLE_OPENING.exec(lines[0]);
  if (last < 1 || !tableOpening || lines[last] !== "</table>") throw malformedTable();
  let tag = { mdStart: table.mdStart, mdEnd: table.mdStart + lines[0].length };
  let look: LookAttributes = { table: tableOpening[1] ?? "", rows: [], cells: [] };
  let rows: TableLines["rows"] = [];
  // Where the line at `index` starts in the Markdown.
  let offset = tag.mdEnd + 1;
  let index = 1;
  let colgroup: MarkdownRange | undefined;
  let columns = COLGROUP.exec(lines[1]);
  if (columns && last > 1) {
    colgroup = { mdStart: offset, mdEnd: offset + lines[1].length + 1 };
    look.colgroup = columns[1];
    offset = colgroup.mdEnd;
    index++;
  }
  while (index < last) {
    let rowStart = offset;
    let row = ROW_OPENING.exec(lines[index]);
    if (!row) throw malformedTable();
    let rowTag = { mdStart: offset + 2, mdEnd: offset + lines[index].length };
    look.rows.push(row[1] ?? "");
    offset += lines[index++].length + 1;
    let cells: TableLines["rows"][number]["cells"] = [];
    let styles: string[] = [];
    while (lines[index] !== "  </tr>") {
      let cellStart = offset;
      let line = lines[index];
      let opening = CELL_OPENING.exec(line);
      if (index >= last || !opening) throw malformedTable();
      offset += lines[index++].length + 1;
      let nested = false;
      if (line.length > opening[0].length) {
        if (!line.endsWith("</td>")) throw malformedTable();
      } else {
        // A cell of several lines: each indented six spaces, up to the line that closes it.
        while (lines[index] !== "    </td>") {
          if (index >= last || !lines[index].startsWith("      ")) throw malformedTable();
          if (/^ {6}<table[ >]/.test(lines[index])) nested = true;
          offset += lines[index++].length + 1;
        }
        offset += lines[index++].length + 1;
      }
      cells.push({
        mdStart: cellStart,
        mdEnd: offset,
        tag: { mdStart: cellStart + 4, mdEnd: cellStart + opening[0].length },
        rowSpan: opening[2] ? Number(opening[2]) : 1,
        columnSpan: opening[4] ? Number(opening[4]) : 1,
        nested,
      });
      styles.push(opening[5] ?? "");
    }
    offset += lines[index++].length + 1;
    look.cells.push(styles);
    rows.push({ mdStart: rowStart, mdEnd: offset, tag: rowTag, cells });
  }
  return { tag, ...(colgroup ? { colgroup } : {}), look, rows };
}

function notLaidOut(op: string): Error {
  return new Error(
    `${op}: this table is not laid out as Google Docs lays tables out, so it cannot be changed.`);
}

/** `tableLines`, with the refusal a change gets for a table that does not parse. */
function linesOf(markdown: string, table: MarkdownRange, op: string): TableLines {
  try {
    return tableLines(markdown, table);
  } catch {
    throw notLaidOut(op);
  }
}

/**
 * The look of a table whose lines are parsed. Throws the refusal of a table that is not laid out
 * as the renderer lays one out when its tags write no look exactly as the renderer would.
 */
export function readTableLook(lines: TableLines, op: string): TableLook {
  let covered = coveredCells(lines.rows.map(row => row.cells));
  let look = readLook(lines.look, covered);
  if (!look || look.columns && look.columns.length !== (lines.rows[0]?.cells.length ?? 0)) {
    throw notLaidOut(op);
  }
  return look;
}

/** The size of a table whose lines are parsed, for a change to its rows or columns. */
function sizeOf(lines: TableLines, op: string): { rows: number; columns: number } {
  let columns = lines.rows[0]?.cells.length ?? 0;
  if (columns === 0) throw notLaidOut(op);
  if (lines.rows.some(row => row.cells.length !== columns)) {
    throw new Error(
      `${op}: the rows of this table do not all have the same number of cells, so its rows ` +
      "and columns cannot be changed.");
  }
  return { rows: lines.rows.length, columns };
}

/**
 * A table's numbers of rows and columns, for a change to its rows or columns. Throws when the
 * table is not laid out as the renderer lays one out, or its rows differ in length.
 */
export function tableSize(
  markdown: string, table: MarkdownRange, op: string,
): { rows: number; columns: number } {
  return sizeOf(linesOf(markdown, table, op), op);
}

// ---------------------------------------------------------------------------
// New cells and tables
// ---------------------------------------------------------------------------

/** A cell paragraph of plain text, as the renderer writes one. */
function plainInlineHtml(text: string): string {
  return escapeHtml(text).replaceAll("\u000b", "<br>");
}

const PLAIN_CELL = {
  numbered: false, footnote: false, styled: false, loneChip: false, unshown: false,
};

/** The block of a new cell that holds `text` as plain paragraphs, and its entry in the map. */
function newCell(text: string): { html: string; entry: TableCellEntry } {
  if (!text.includes("\n")) {
    let inline = plainInlineHtml(text);
    return {
      html: `    <td><p>${inline}</p></td>\n`,
      entry: { texts: [[11, 11 + inline.length]], ...PLAIN_CELL },
    };
  }
  let html = "    <td>\n";
  let texts: [number, number][] = [];
  for (let line of text.split("\n")) {
    let inline = plainInlineHtml(line);
    let start = html.length + 9;
    texts.push([start, start + inline.length]);
    html += `      <p>${inline}</p>\n`;
  }
  return { html: `${html}    </td>\n`, entry: { texts, ...PLAIN_CELL } };
}

/**
 * The block of a new row whose cells hold `texts`, and its row in the map. A cell that `copies`
 * names holds the chip Google copies into it instead, which reads as nothing and is not editable.
 */
function newRow(
  texts: readonly string[], copies: readonly ("dropdown" | "placeholder" | undefined)[] = [],
): { html: string; packed: number[] } {
  let html = "  <tr>\n";
  let entries: TableCellEntry[] = [];
  for (let [column, text] of texts.entries()) {
    let copied = copies[column];
    let cell = copied ? copiedCell(copied) : newCell(text);
    html += cell.html;
    entries.push(cell.entry);
  }
  return { html: `${html}  </tr>\n`, packed: packTableRow(entries) };
}

/**
 * The block of a new cell that holds the chip Google copies into it, and its entry in the map. A
 * dropdown reads as nothing, and the placeholder as itself.
 */
function copiedCell(copies: "dropdown" | "placeholder"): { html: string; entry: TableCellEntry } {
  return {
    html: `    <td><p>${copies === "placeholder" ? "\uE907" : ""}</p></td>\n`,
    entry: { texts: [], ...PLAIN_CELL, loneChip: true, copies, unshown: copies === "dropdown" },
  };
}

/**
 * What Google copies into each cell of a row added beside row `reference` of a table, refusing
 * text given for a cell that takes a chip.
 */
function copiedChips(
  target: EditableTable, reference: number, cells: readonly (readonly string[])[],
): ("dropdown" | "placeholder" | undefined)[] {
  // A cell of several chips copies none of them, and its new cells are plain.
  let copies = tableRowCells(target, reference)
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

/** The HTML of a new table and the rows of its map. */
function newTable(cells: readonly (readonly string[])[]): { html: string; rows: number[][] } {
  let html = "<table>\n";
  let rows: number[][] = [];
  for (let texts of cells) {
    let row = newRow(texts);
    html += row.html;
    rows.push(row.packed);
  }
  return { html: `${html}</table>`, rows };
}

/** The HTML of a new table whose cells hold `cells` as plain text. */
export function tableHtml(cells: readonly (readonly string[])[]): string {
  return newTable(cells).html;
}

/** The texts of `count` new lines of `width` cells each, a text left out reading as empty. */
function completeCells(cells: string[][], count: number, width: number): string[][] {
  return Array.from({ length: count }, (_, line) =>
    Array.from({ length: width }, (__, cell) => cells[line]?.[cell] ?? ""));
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

function htmlOf(content: EditableMarkdown, table: MarkdownRange): string {
  return content.markdown.slice(table.mdStart, table.mdEnd);
}

/**
 * The place, among the content's tables, of the one table that reads the same as a reference
 * recorded. Throws when none does, when more than one does, or when the one that does no
 * longer reads exactly as recorded, its look aside.
 */
export function resolveTable(content: EditableMarkdown, ref: TableRef, op: string): number {
  let changed = () => new Error(
    `${op}: the table no longer reads as it did when this change was queued, or it is gone.`);
  let shape = tableShape(ref.expected);
  let found = -1;
  for (let [index, table] of content.tables.entries()) {
    if (tableShape(htmlOf(content, table)) !== shape) continue;
    if (found >= 0) {
      throw new Error(
        `${op}: another table of the tab now reads the same as the table this change was ` +
        "queued for, so the change can no longer be kept to it.");
    }
    found = index;
  }
  if (found < 0 || tableIdentity(htmlOf(content, content.tables[found])) !== ref.expected) {
    throw changed();
  }
  return found;
}

/** What a deletion asks of its table: which rows or columns go, or the whole table. */
export type TableDeletionShape =
  | { type: "deleteTableRows" | "deleteTableColumns"; at: number; count: number }
  | { type: "deleteTable" };

/**
 * What the deletion `shape` asks of the table at `table` would remove that the content does not
 * show.
 */
export function hiddenContent(
  content: EditableMarkdown, table: number, shape: TableDeletionShape,
): HiddenContent {
  let target = content.tables[table];
  let rows = target.rows.map((_, row) => tableRowCells(target, row));
  let cells = shape.type === "deleteTable" ? rows.flat()
    : shape.type === "deleteTableRows" ? rows.slice(shape.at, shape.at + shape.count).flat()
    : rows.flatMap(row => row.slice(shape.at, shape.at + shape.count));
  return {
    ...(cells.some(cell => cell.unshown) ? { unshown: true as const } : {}),
    ...(shape.type === "deleteTable" && target.suggested ? { suggested: true as const } : {}),
  };
}

/**
 * The place, among the content's tables, of the table a queued change applies to: the one
 * `resolveTable` finds. A deletion is refused there when what it would remove has come to hold
 * what the view does not show and the change did not record: its table still reads as recorded,
 * and its approval card says nothing of what would go with it.
 */
function targetOf(content: EditableMarkdown, change: ExistingTableChange): number {
  let op = change.type;
  let table = resolveTable(content, change, op);
  if (change.type === "insertTableRows" || change.type === "insertTableColumns" ||
      change.type === "mergeTableCells" || change.type === "unmergeTableCells" ||
      isLookChange(change)) return table;
  let hidden = hiddenContent(content, table, change);
  if (hidden.unshown && !change.unshown) {
    throw new Error(
      `${op}: what would be deleted has come to hold a dropdown or other smart chips, which ` +
      "getContent() does not show, since this change was queued.");
  }
  if (hidden.suggested && !change.suggested) {
    throw new Error(
      `${op}: this table has come to hold suggested changes to its rows, columns or cells ` +
      "since this change was queued.");
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
 * What one replay of a queue has learned about its tabs' tables. A change that names its table
 * by how the table read recorded that among the tables as every change before it left them, so
 * once a change to a tab's tables fails to replay, the later ones are refused as well.
 */
export class TableReplayGate {
  #closed = new Set<string>();

  /**
   * Notes that `change`, queued for tab `tabId`, did not replay. A change to a table's look
   * leaves the tables as the later changes recorded them, which leave looks out.
   */
  failed(tabId: string | undefined, change: { type: string; inTable?: true }): void {
    if (changesTables(change) && !LOOK_CHANGE_TYPES.includes(change.type)) this.close(tabId);
  }

  /** Notes that the tables of tab `tabId` may no longer be as the later changes found them. */
  close(tabId: string | undefined): void {
    if (typeof tabId === "string") this.#closed.add(tabId);
  }

  /** Throws for a change that names a table of tab `tabId` behind a table change that failed. */
  admit(tabId: string, change: { type: string }): void {
    if (!this.#closed.has(tabId) || !namesTable(change)) return;
    throw new Error(
      `${change.type}: an earlier queued change to this tab's tables no longer applies, and ` +
      "this change named its table among the tables as that one left them.");
  }
}

// ---------------------------------------------------------------------------
// Reading a rendering: lines, blocks and their protected ranges
// ---------------------------------------------------------------------------

/** The content a fresh tab reads as. */
function tabContent(tab: DocTabSnapshot): EditableMarkdown {
  return {
    markdown: tab.markdown,
    protectedRanges: tab.sourceMap.protectedRanges,
    tables: tab.sourceMap.tables,
  };
}

/**
 * The tab whose block map says what the content's paragraphs are: the tab the content came
 * from, while the content still reads exactly as it does. Without it the Markdown has to say.
 */
function documentOf(content: EditableMarkdown, tab?: DocTabSnapshot): DocTabSnapshot | undefined {
  return tab && content.markdown === tab.markdown ? tab : undefined;
}

/** The index after the line break that ends the line starting at `start`. */
function lineEnd(markdown: string, start: number): number {
  let end = markdown.indexOf("\n", start);
  return end < 0 ? markdown.length : end + 1;
}

/**
 * The protected range of the block whose one line starts at `start`, if it has one. A protected
 * block's range ends with its last line, or one character later when a paragraph follows it, so
 * a range that only passes over the line, or stops before it, is not the line's own.
 */
function ownRange(content: EditableMarkdown, start: number): MarkdownRange | undefined {
  let end = lineEnd(content.markdown, start);
  return content.protectedRanges.find(range =>
    range.mdStart <= start && (range.mdEnd === end || range.mdEnd === end + 1));
}

/** The protected range of a table: the one that starts at or before it and ends after it. */
function tableRange(content: EditableMarkdown, table: MarkdownRange): MarkdownRange | undefined {
  return content.protectedRanges.find(range =>
    range.mdStart <= table.mdStart && range.mdEnd > table.mdEnd);
}

const STRUCTURE_LINES: readonly string[] = ["[Table of contents]", "[Section break]"];

/**
 * What the block whose line starts at `start` is. With the tab the content came from, a line no
 * block starts at is a table of contents or a section break; without it, a protected line that
 * reads as one of their placeholders is.
 */
function blockAt(
  content: EditableMarkdown, start: number, doc?: DocTabSnapshot,
): "table" | "structure" | "paragraph" {
  if (content.tables.some(table => table.mdStart === start)) return "table";
  if (doc) {
    return doc.sourceMap.blocks.some(block => block.mdStart === start) ? "paragraph" : "structure";
  }
  let { markdown } = content;
  let end = markdown.indexOf("\n", start);
  let line = markdown.slice(start, end < 0 ? markdown.length : end);
  return STRUCTURE_LINES.includes(line) && ownRange(content, start) ? "structure" : "paragraph";
}

const LINE_MARKERS = /^ *(?:- |\d+\. )?(?:#{1,6} )?/;

/** The line starting at `start` without its line break and its list and heading markers. */
function lineText(markdown: string, start: number): string {
  let end = markdown.indexOf("\n", start);
  return markdown.slice(start, end < 0 ? markdown.length : end).replace(LINE_MARKERS, "");
}

/**
 * Whether the paragraph whose line starts at `start` holds a positioned image: by its block when
 * the document says, and otherwise by a protected line that starts with the image's mark.
 */
function holdsPositionedImage(
  content: EditableMarkdown, start: number, block: BlockMapping | undefined, doc: boolean,
): boolean {
  if (doc) return block?.positioned === true;
  return ownRange(content, start) !== undefined &&
    lineText(content.markdown, start).startsWith("[Image]");
}

function shiftRange<T extends MarkdownRange>(range: T, offset: number): T {
  return { ...range, mdStart: range.mdStart + offset, mdEnd: range.mdEnd + offset };
}

/**
 * The content with the two line breaks restored that the simulation of a paragraph edit drops
 * while the tab keeps them: the empty paragraph before a table that opens the content, and the
 * line break of the tab's last paragraph.
 */
function base(content: EditableMarkdown): EditableMarkdown {
  let { markdown, protectedRanges, tables } = content;
  if (markdown[0] === "\n" && tables[0]?.mdStart === 1) {
    markdown = `\n${markdown}`;
    protectedRanges = protectedRanges.map(range => shiftRange(range, 1));
    tables = tables.map(table => shiftRange(table, 1));
  }
  let breaks = 0;
  while (markdown[markdown.length - 1 - breaks] === "\n") breaks++;
  if (breaks % 2 === 0) markdown += "\n";
  return { markdown, protectedRanges, tables };
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
  content: EditableMarkdown, table: number, cells: readonly TableCellEntry[],
  removed: readonly MarkdownRange[], op: string, doc: DocTabSnapshot | undefined,
): void {
  if (cells.some(cell => cell.footnote)) {
    throw new Error(
      `${op}: what would be deleted holds a footnote. Deleting a footnote renumbers those ` +
      "after it, which is not supported.");
  }
  if (!cells.some(cell => cell.numbered) || removed.length === 0) return;
  let { markdown, tables } = content;
  let target = tables[table];
  // What stays of the table after the first removed range, and every table after it.
  let kept: MarkdownRange[] = [];
  for (let [index, range] of removed.entries()) {
    kept.push({ mdStart: range.mdEnd, mdEnd: removed[index + 1]?.mdStart ?? target.mdEnd });
  }
  for (let later of tables.slice(table + 1)) kept.push(later);
  let listInTable = kept.some(range => markdown.slice(range.mdStart, range.mdEnd).includes("<ol"));
  if (listInTable ||
      doc?.sourceMap.blocks.some(block =>
        block.mdStart >= target.mdEnd && block.listType === "numbered")) {
    throw new Error(
      `${op}: what would be deleted holds items of a numbered list, and a numbered list ` +
      "follows it in the tab, which the deletion could renumber. That is not supported.");
  }
  if (doc) return;
  let next = table + 1;
  for (let start = lineEnd(markdown, target.mdEnd); start < markdown.length;) {
    while (next < tables.length && tables[next].mdEnd <= start) next++;
    if (next < tables.length && tables[next].mdStart <= start) {
      start = lineEnd(markdown, tables[next].mdEnd);
      continue;
    }
    if (listLineType(markdown, start) === "numbered") {
      throw new Error(
        `${op}: what would be deleted holds items of a numbered list, and a line that reads ` +
        "as a numbered list item follows it in the tab, which the deletion could renumber. " +
        "Retry once the earlier changes to this tab have been approved or rejected: the " +
        "document then shows whether that line is a list item.");
    }
    start = lineEnd(markdown, start);
  }
}

/**
 * Refuse a change to rows or columns that crosses a merged cell. Google Docs grows a merged cell
 * that rows or columns are added through, merges the lines it copies from one, and moves or
 * shrinks one whose lines are deleted (probe M5), which the replay does not follow. Lines that
 * cross none leave the merged cells where they are.
 */
function checkMergesAside(lines: TableLines, shape: LineChangeShape, limit: number): void {
  let op = shape.type;
  let ofRows = op === "insertTableRows" || op === "deleteTableRows";
  let inserts = op === "insertTableRows" || op === "insertTableColumns";
  let { at, count } = shape;
  // The lines the change crosses: the one new lines copy, or those it deletes.
  let first = inserts ? Math.min(at, limit - 1) : at;
  let last = inserts ? first : at + count - 1;
  let covered = coveredCells(lines.rows.map(row => row.cells));
  for (let [r, row] of lines.rows.entries()) {
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

/** A table that passed the checks of a change to its rows or columns. */
type CheckedLines = { lines: TableLines; rows: number; columns: number };

/** The checks of a change to the rows or columns of the table at `table`. */
function checkLineChange(
  content: EditableMarkdown, table: number, shape: LineChangeShape,
  doc: DocTabSnapshot | undefined,
): CheckedLines {
  let op = shape.type;
  let target = content.tables[table];
  let lines = linesOf(content.markdown, target, op);
  let { rows, columns } = sizeOf(lines, op);
  // The map names cells by their place in a row, so it has to list the cells the HTML does.
  if (target.rows.length !== rows) throw notLaidOut(op);
  let entries = target.rows.map((_, row) => tableRowCells(target, row));
  if (entries.some(row => row.length !== columns)) throw notLaidOut(op);

  if (target.suggested) {
    throw new Error(
      `${op}: this table holds suggested changes to its rows, columns or cells, so its rows ` +
      "and columns cannot be changed until they are accepted or rejected.");
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

  checkMergesAside(lines, shape, limit);

  if (op === "insertTableRows") {
    let reference = at < rows ? at : rows - 1;
    if (entries[reference].some(cell => cell.loneChip && !cell.copies)) {
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
    checkRemovedCells(content, table, entries.slice(at, at + count).flat(),
      [{ mdStart: lines.rows[at].mdStart, mdEnd: lines.rows[at + count - 1].mdEnd }], op, doc);
  } else {
    checkRemovedCells(content, table, entries.flatMap(row => row.slice(at, at + count)),
      lines.rows.map(row => ({
        mdStart: row.cells[at].mdStart, mdEnd: row.cells[at + count - 1].mdEnd,
      })), op, doc);
  }
  return { lines, rows, columns };
}

/** The lines around a table that can be deleted. */
type DeletableTable = { before: number; after: number };

/**
 * The checks of the deletion of the table at `table`, on the content the deletion works on:
 * a paragraph on each side of the table, which are not two items of one list, and nothing in
 * the table whose removal renumbers what follows.
 */
function checkTableDeletion(
  work: EditableMarkdown, table: number, doc: DocTabSnapshot | undefined,
): DeletableTable {
  let op = "deleteTable";
  let { markdown } = work;
  let target = work.tables[table];
  let separator = target.mdStart - 1;
  let after = target.mdEnd + 2;
  if (separator < 1 || markdown[separator - 1] !== "\n" || markdown[separator] !== "\n" ||
      markdown[target.mdEnd] !== "\n" || markdown[target.mdEnd + 1] !== "\n" ||
      after >= markdown.length || work.tables.some(other => other.mdEnd === separator - 1)) {
    throw notLaidOut(op);
  }
  let before = lineStart(markdown, separator - 1);
  if (blockAt(work, before, doc) !== "paragraph" || blockAt(work, after, doc) !== "paragraph") {
    throw notLaidOut(op);
  }
  if (doc) {
    let mapping = doc.sourceMap.tables[table];
    let blockBefore = doc.sourceMap.blocks.find(block => block.docEnd === mapping.docStart);
    let blockAfter = doc.sourceMap.blocks.find(block => block.docStart === mapping.docEnd);
    if (!blockBefore || !blockAfter) throw notLaidOut(op);
    if (blockBefore.listId !== undefined && blockBefore.listId === blockAfter.listId) {
      throw new Error(
        "deleteTable: this table sits between two items of one list, which deleting it would " +
        "join. That is not supported.");
    }
  } else if (listLineType(markdown, before) !== null && listLineType(markdown, after) !== null) {
    throw new Error(
      "deleteTable: the lines before and after this table read as list items, which deleting " +
      "it could join into one list. Retry once the earlier changes to this tab have been " +
      "approved or rejected: the document then shows whether they are items of one list.");
  }
  let cells = target.rows.flatMap((_, row) => tableRowCells(target, row));
  checkRemovedCells(work, table, cells, [target], op, doc);
  return { before, after };
}

/**
 * Refuse a change for what the table at position `table` among the content's tables is or
 * holds: every check a replay makes once it has found the change's table. `tab` as for
 * `applyTableChange`.
 */
export function checkTableTarget(
  content: EditableMarkdown, table: number, shape: TableChangeShape, tab?: DocTabSnapshot,
): void {
  let doc = documentOf(content, tab);
  if (shape.type === "deleteTable") checkTableDeletion(doc ? content : base(content), table, doc);
  else checkLineChange(content, table, shape, doc);
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
// written as aside, but not one that only holds the next level of a list that skips a level, and
// a paragraph or heading outside a list.
const CELL_PARTS = /<td[ >]|<\/td>|<li>(?!<[uo]l[ >])|(?<!<li>)<(?:p|h[1-6])>/g;

/**
 * The cells a table's HTML holds, each counting once for each paragraph of its own, and at least
 * once: those of the tables inside its cells count as their own cells.
 */
function tableCellCount(html: string): number {
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
 * Refuse an addition of `added` cells that would take the tables of the content's tab past the
 * cells they may hold in all.
 */
export function checkTabTableCells(content: EditableMarkdown, added: number, op: string): void {
  if (added === 0) return;
  let held = 0;
  // Every paragraph a table's HTML shows counts, those of tables inside its cells and those no
  // replacement can edit included: the whole document has to be read back.
  for (let table of content.tables) {
    held += tableCellCount(content.markdown.slice(table.mdStart, table.mdEnd));
  }
  if (held + added > MAX_TAB_TABLE_CELLS) {
    throw new Error(
      `${op}: tables, rows and columns can be added only until the tables of a tab hold ` +
      `${MAX_TAB_TABLE_CELLS} cells in all, a cell counting once for each paragraph in it, ` +
      `and those of this tab would hold ${held + added}.`);
  }
}

// ---------------------------------------------------------------------------
// Replaying a change over a rendering
// ---------------------------------------------------------------------------

type TextEdit = { start: number; end: number; text: string };

/** `markdown` with `edits` made, which are in order and do not overlap. */
function spliceText(markdown: string, edits: readonly TextEdit[]): string {
  let parts: string[] = [];
  let cursor = 0;
  for (let edit of edits) {
    parts.push(markdown.slice(cursor, edit.start), edit.text);
    cursor = edit.end;
  }
  parts.push(markdown.slice(cursor));
  return parts.join("");
}

/**
 * The content once the HTML of the table at `table` has changed to give `markdown`, with `rows`
 * as that table's map. Everything after the table moves by the change in its length, and the
 * table's own protected range grows by it.
 */
function withTable(
  content: EditableMarkdown, table: number, markdown: string, rows: number[][],
): EditableMarkdown {
  let target = content.tables[table];
  let oldEnd = target.mdEnd;
  let delta = markdown.length - content.markdown.length;
  // Built anew, so that it carries none of the document indexes of the table as it was.
  let changed: EditableTable = {
    mdStart: target.mdStart,
    mdEnd: oldEnd + delta,
    rows,
    ...(target.suggested ? { suggested: true as const } : {}),
  };
  let own = tableRange(content, target);
  return {
    markdown,
    protectedRanges: content.protectedRanges.map(range =>
      range === own ? { mdStart: range.mdStart, mdEnd: range.mdEnd + delta }
        : range.mdStart >= oldEnd ? shiftRange(range, delta) : range),
    tables: content.tables.map((other, index) =>
      index === table ? changed : other.mdStart >= oldEnd ? shiftRange(other, delta) : other),
  };
}

/**
 * The content once the table at `table` reads with `look`: its opening tags written anew, and
 * each cell's texts moved by the change in the length of its own. The text of the table stays
 * as it is.
 */
function restyleTable(content: EditableMarkdown, table: number, look: TableLook): EditableMarkdown {
  let target = content.tables[table];
  let lines = tableLines(content.markdown, target);
  let rendered = renderLook(look);
  let edits: TextEdit[] = [{
    start: lines.tag.mdStart, end: lines.tag.mdEnd, text: `<table${rendered.table}>`,
  }];
  let colgroup = rendered.colgroup === undefined ? "" : `  ${rendered.colgroup}\n`;
  let afterTag = lines.tag.mdEnd + 1;
  edits.push(lines.colgroup
    ? { start: lines.colgroup.mdStart, end: lines.colgroup.mdEnd, text: colgroup }
    : { start: afterTag, end: afterTag, text: colgroup });
  let packed = lines.rows.map((row, r) => {
    edits.push({ start: row.tag.mdStart, end: row.tag.mdEnd, text: `<tr${rendered.rows[r]}>` });
    let entries = tableRowCells(target, r);
    for (let [c, cell] of row.cells.entries()) {
      let text = `<td${spanAttribute("rowspan", cell.rowSpan)}` +
        `${spanAttribute("colspan", cell.columnSpan)}${rendered.cells[r][c]}>`;
      edits.push({ start: cell.tag.mdStart, end: cell.tag.mdEnd, text });
      let moved = text.length - (cell.tag.mdEnd - cell.tag.mdStart);
      entries[c] = {
        ...entries[c], texts: entries[c].texts.map(([start, end]) => [start + moved, end + moved]),
      };
    }
    return packTableRow(entries);
  });
  return withTable(content, table, spliceText(content.markdown, edits), packed);
}

const spanAttribute = (name: string, span: number): string => span > 1 ? ` ${name}="${span}"` : "";

/** Replay a change to the rows or columns of the table at `table`. */
function applyLineChange(
  content: EditableMarkdown, table: number,
  change: LineChange, doc: DocTabSnapshot | undefined,
): EditableMarkdown {
  let shape = shapeOf(change);
  let { lines, rows, columns } = checkLineChange(content, table, shape, doc);
  let target = content.tables[table];
  let { at, count } = shape;
  let look = readTableLook(lines, change.type);
  let edits: TextEdit[] = [];
  let packed: number[][];
  switch (change.type) {
    case "insertTableRows": {
      checkTabTableCells(content, addedTableCells(change), change.type);
      let copies = copiedChips(target, at < rows ? at : rows - 1, change.cells);
      let added = completeCells(change.cells, count, columns).map(texts => newRow(texts, copies));
      let start = at < rows ? lines.rows[at].mdStart : lines.rows[rows - 1].mdEnd;
      edits.push({ start, end: start, text: added.map(row => row.html).join("") });
      packed = [
        ...target.rows.slice(0, at), ...added.map(row => row.packed), ...target.rows.slice(at),
      ];
      break;
    }
    case "insertTableColumns": {
      checkTabTableCells(content, addedTableCells(change), change.type);
      let texts = completeCells(change.cells, rows, count);
      packed = lines.rows.map((row, index) => {
        let added = texts[index].map(newCell);
        let start = at < columns ? row.cells[at].mdStart : row.cells[columns - 1].mdEnd;
        edits.push({ start, end: start, text: added.map(cell => cell.html).join("") });
        let entries = tableRowCells(target, index);
        entries.splice(at, 0, ...added.map(cell => cell.entry));
        return packTableRow(entries);
      });
      break;
    }
    case "deleteTableRows":
      edits.push({
        start: lines.rows[at].mdStart, end: lines.rows[at + count - 1].mdEnd, text: "",
      });
      packed = [...target.rows.slice(0, at), ...target.rows.slice(at + count)];
      break;
    case "deleteTableColumns":
      packed = lines.rows.map((row, index) => {
        edits.push({
          start: row.cells[at].mdStart, end: row.cells[at + count - 1].mdEnd, text: "",
        });
        let entries = tableRowCells(target, index);
        entries.splice(at, count);
        return packTableRow(entries);
      });
      break;
  }
  let changed = withTable(content, table, spliceText(content.markdown, edits), packed);
  // The cells and lines Google adds copy the look of those beside them, and those it deletes
  // take theirs away.
  return restyleTable(changed, table, {
    insertTableRows: lookWithRows,
    insertTableColumns: lookWithColumns,
    deleteTableRows: lookWithoutRows,
    deleteTableColumns: lookWithoutColumns,
  }[change.type](look, at, count));
}

/** Replay the deletion of the table at `table`. */
function applyTableDeletion(
  content: EditableMarkdown, table: number, doc: DocTabSnapshot | undefined,
): EditableMarkdown {
  let work = doc ? content : base(content);
  let { before, after } = checkTableDeletion(work, table, doc);
  let target = work.tables[table];
  // The separator before the table goes with it; the one after it then follows the paragraph
  // that stood before the table.
  let start = target.mdStart - 1;
  let length = target.mdEnd + 1 - start;
  let own = tableRange(work, target);
  let rangeBefore = ownRange(work, before);
  let rangeAfter = ownRange(work, after);
  let protectedRanges: MarkdownRange[] = [];
  for (let range of work.protectedRanges) {
    if (range === own) continue;
    if (range === rangeBefore) {
      // A paragraph follows it, so it reaches over the separator.
      protectedRanges.push({ mdStart: range.mdStart, mdEnd: start + 1 });
    } else if (range === rangeAfter) {
      // It starts at its own first character after a protected paragraph, and otherwise at the
      // line break of the paragraph before it.
      protectedRanges.push({
        mdStart: rangeBefore ? start + 1 : start - 1, mdEnd: range.mdEnd - length,
      });
    } else {
      protectedRanges.push(range.mdEnd <= start ? range : shiftRange(range, -length));
    }
  }
  return {
    markdown: work.markdown.slice(0, start) + work.markdown.slice(start + length),
    protectedRanges,
    tables: [
      ...work.tables.slice(0, table),
      ...work.tables.slice(table + 1).map(later => shiftRange(later, -length)),
    ],
  };
}

/**
 * Where an `after` text ends in the Markdown: the position of its last character that is not a
 * line break. It is searched with a line break put in front of the Markdown, so that a line
 * break at its start stands for the start of a line, the first line included.
 */
function findAnchor(markdown: string, after: string): number {
  let last = after.length - 1;
  while (last >= 0 && after[last] === "\n") last--;
  let padded = `\n${markdown}`;
  let found = last < 0 ? -1 : padded.indexOf(after);
  if (found < 0) {
    throw new Error(
      "insertTable: after was not found in the tab. Make sure the text exactly matches " +
      "content returned by getContent().");
  }
  if (padded.indexOf(after, found + 1) >= 0) {
    throw new Error(
      "insertTable: after matches multiple locations in the tab. To make the match unique, " +
      "include more of the text before it, a line break before it for the start of its line, " +
      "or the line break that ends its paragraph.");
  }
  return found - 1 + last;
}

/** Where a new table goes: after the table at `table`, or after the paragraph of one line. */
type NewTablePlace =
  | { table: number; block?: BlockMapping }
  | { table?: undefined; lineStart: number; lineEnd: number; block?: BlockMapping };

const POSITIONED_IMAGE = "insertTable: a table cannot be added beside a paragraph that holds " +
  "a positioned image. Name other text for the table to follow.";

/**
 * Find where a new table goes in the content an `insertTable` works on, and refuse the places
 * it cannot go. `block`, in the answer, is the paragraph the table splits, when the document
 * says which it is: the anchor paragraph, or the paragraph after the anchor table.
 */
function newTablePlace(
  work: EditableMarkdown, after: string | undefined, doc: DocTabSnapshot | undefined,
): NewTablePlace {
  let { markdown, tables } = work;
  let blocks = doc?.sourceMap.blocks;
  if (after === undefined) {
    let end = markdown.length;
    let start = lineStart(markdown, end - 1);
    let block = blocks?.find(candidate => candidate.mdStart === start);
    if (tables.at(-1)?.mdEnd === end - 1 || blockAt(work, start, doc) !== "paragraph" ||
        doc && block?.docEnd !== doc.bodyEndIndex) {
      throw new Error(
        "insertTable: the selected tab does not end in a paragraph. Name the text the table " +
        "should follow.");
    }
    return checkSplitAtEnd(work, { lineStart: start, lineEnd: end, block }, doc);
  }

  let anchor = findAnchor(markdown, after);
  let table = tables.findIndex(candidate =>
    candidate.mdStart <= anchor && anchor < candidate.mdEnd);
  if (table >= 0) {
    let target = tables[table];
    let next = target.mdEnd + 2;
    if (markdown[target.mdEnd] !== "\n" || markdown[target.mdEnd + 1] !== "\n" ||
        next >= markdown.length || blockAt(work, next, doc) !== "paragraph") {
      throw notLaidOut("insertTable");
    }
    let block: BlockMapping | undefined;
    if (doc) {
      let mapping = doc.sourceMap.tables[table];
      block = doc.sourceMap.blocks.find(candidate => candidate.docStart === mapping.docEnd);
      if (!block) throw notLaidOut("insertTable");
    }
    // The paragraph is cut at its start: an image anchored to it would stay before the table.
    if (holdsPositionedImage(work, next, block, doc !== undefined)) {
      throw new Error(POSITIONED_IMAGE);
    }
    return { table, block };
  }

  let start = lineStart(markdown, anchor);
  if (blockAt(work, start, doc) === "structure") {
    throw new Error(
      "insertTable: a table cannot follow a table of contents or a section break. Name a " +
      "paragraph instead.");
  }
  let end = lineEnd(markdown, start);
  let block = blocks?.find(candidate => candidate.mdStart === start);
  let nextBlock = block && blocks?.find(candidate => candidate.docStart === block.docEnd);
  let splitsList = doc
    ? block?.listId !== undefined && nextBlock?.listId === block.listId
    : end < markdown.length && markdown[end] !== "\n";
  if (splitsList) {
    throw new Error(
      "insertTable: a table cannot be added between two items of a list. Name the list's " +
      "last item instead.");
  }
  return checkSplitAtEnd(work, { lineStart: start, lineEnd: end, block }, doc);
}

/**
 * Refuse a table after a paragraph that holds a positioned image and nothing else: cut at its
 * line break, such a paragraph is cut at its start.
 */
function checkSplitAtEnd(
  work: EditableMarkdown, place: Extract<NewTablePlace, { lineStart: number }>,
  doc: DocTabSnapshot | undefined,
): NewTablePlace {
  let { block } = place;
  let empty = doc
    ? block !== undefined && block.docEnd - block.docStart === 1
    : /^\[Image\](?: \[Image\])*$/.test(lineText(work.markdown, place.lineStart));
  if (empty && holdsPositionedImage(work, place.lineStart, block, doc !== undefined)) {
    throw new Error(POSITIONED_IMAGE);
  }
  return place;
}

/** Replay an `insertTable`, saying where among the tab's tables the new one is. */
export function applyNewTable(
  content: EditableMarkdown, change: Extract<TableChange, { type: "insertTable" }>,
  tab?: DocTabSnapshot,
): { content: EditableMarkdown; table: number } {
  checkTabTableCells(content, addedTableCells(change), "insertTable");
  let doc = documentOf(content, tab);
  let work = doc ? content : base(content);
  let place = newTablePlace(work, change.after, doc);
  let { html, rows } = newTable(completeCells(change.cells, change.rows, change.columns));
  let { markdown } = work;
  let protectedRanges: MarkdownRange[] = [];
  // Where the inserted text goes, what it is, and where in it the table's HTML starts.
  let at: number;
  let inserted: string;
  let lead: number;
  let position: number;

  if (place.table === undefined) {
    // After the paragraph's line: the separator, the table, then the separator and the line of
    // the empty paragraph that comes with it.
    at = place.lineEnd;
    inserted = `\n${html}\n\n\n`;
    lead = 1;
    let rangeBefore = ownRange(work, place.lineStart);
    let next = at + 1;
    let rangeNext = at < markdown.length && blockAt(work, next, doc) === "paragraph"
      ? ownRange(work, next) : undefined;
    let added = false;
    for (let range of work.protectedRanges) {
      if (range === rangeBefore) {
        // A table follows it, so its range ends with its line and reaches over no separator.
        protectedRanges.push({ mdStart: range.mdStart, mdEnd: at });
        continue;
      }
      if (range.mdEnd <= at) {
        protectedRanges.push(range);
        continue;
      }
      if (!added) protectedRanges.push({ mdStart: at, mdEnd: at + html.length + 3 });
      added = true;
      // The empty paragraph before it is not protected, so it starts at that one's line break.
      protectedRanges.push(range === rangeNext
        ? { mdStart: at + html.length + 3, mdEnd: range.mdEnd + inserted.length }
        : shiftRange(range, inserted.length));
    }
    if (!added) protectedRanges.push({ mdStart: at, mdEnd: at + html.length + 3 });
    position = work.tables.filter(table => table.mdStart < at).length;
  } else {
    // After the line of the anchor table: the separator and the line of the empty paragraph
    // between the two tables, then the separator and the table.
    let anchor = work.tables[place.table];
    at = anchor.mdEnd + 1;
    inserted = `\n\n\n${html}\n`;
    lead = 3;
    let added = false;
    for (let range of work.protectedRanges) {
      if (range.mdStart < at + 1) {
        protectedRanges.push(range);
        continue;
      }
      if (!added) protectedRanges.push({ mdStart: at + 2, mdEnd: at + html.length + 5 });
      added = true;
      protectedRanges.push(shiftRange(range, inserted.length));
    }
    if (!added) protectedRanges.push({ mdStart: at + 2, mdEnd: at + html.length + 5 });
    position = place.table + 1;
  }

  let table: EditableTable = { mdStart: at + lead, mdEnd: at + lead + html.length, rows };
  return {
    content: {
      markdown: markdown.slice(0, at) + inserted + markdown.slice(at),
      protectedRanges,
      tables: [
        ...work.tables.slice(0, position),
        table,
        ...work.tables.slice(position).map(later => shiftRange(later, inserted.length)),
      ],
    },
    table: position,
  };
}

/**
 * Replay a change. `tab` is the fresh tab the content came from; while the content still reads
 * exactly as it does, what the paragraphs around a table are is read from its block map.
 */
export function applyTableChange(
  content: EditableMarkdown, change: TableChange, tab?: DocTabSnapshot,
): EditableMarkdown {
  if (change.type === "insertTable") return applyNewTable(content, change, tab).content;
  let doc = documentOf(content, tab);
  let table = targetOf(content, change);
  if (isLookChange(change)) return applyLookChange(content, table, change);
  if (change.type === "mergeTableCells") return applyMerge(content, table, change);
  if (change.type === "unmergeTableCells") return applyUnmerge(content, table, change);
  return change.type === "deleteTable"
    ? applyTableDeletion(content, table, doc)
    : applyLineChange(content, table, change, doc);
}

// ---------------------------------------------------------------------------
// Merging cells
// ---------------------------------------------------------------------------

/** A cell's content as lines, each without its indentation, with where its texts are in them. */
type CellContent = { lines: string[]; texts: [line: number, start: number, end: number][] };

/** The content of the cell at `cell`, whose texts the map gives as `entry` does. */
function cellContent(
  markdown: string, cell: TableLines["rows"][number]["cells"][number], entry: TableCellEntry,
): CellContent {
  let block = markdown.slice(cell.mdStart, cell.mdEnd - 1);
  let tagEnd = cell.tag.mdEnd - cell.mdStart;
  if (!block.includes("\n")) {
    return {
      lines: [block.slice(tagEnd, -"</td>".length)],
      texts: entry.texts.map(([start, end]) => [0, start - tagEnd, end - tagEnd]),
    };
  }
  let lines = block.slice(tagEnd + 1, block.lastIndexOf("\n")).split("\n");
  let starts: number[] = [];
  let at = tagEnd + 1;
  for (let line of lines) {
    starts.push(at + 6);
    at += line.length + 1;
  }
  return {
    lines: lines.map(line => line.slice(6)),
    texts: entry.texts.map(([start, end]) => {
      let line = starts.findLastIndex(begins => begins <= start);
      return [line, start - starts[line], end - starts[line]];
    }),
  };
}

/** The block of a cell of `content`, opened with `attributes`, and where its texts then are. */
function cellBlock(
  attributes: string, content: CellContent,
): { html: string; texts: [number, number][] } {
  let open = `    <td${attributes}>`;
  if (content.lines.length === 1) {
    return {
      html: `${open}${content.lines[0]}</td>\n`,
      texts: content.texts.map(([, start, end]) => [open.length + start, open.length + end]),
    };
  }
  let starts: number[] = [];
  let html = `${open}\n`;
  for (let line of content.lines) {
    starts.push(html.length + 6);
    html += `      ${line}\n`;
  }
  return {
    html: `${html}    </td>\n`,
    texts: content.texts.map(([line, start, end]) => [starts[line] + start, starts[line] + end]),
  };
}

const EMPTY_PARAGRAPH = "<p></p>";

/** The row and column of the merged cell, or the cell, that covers the cell at `row`, `column`. */
function headAt(spans: readonly (readonly Spans[])[], row: number, column: number): [number, number] {
  let covered = coveredCells(spans);
  for (let r = row; r >= 0; r--) {
    for (let c = column; c >= 0; c--) {
      let { rowSpan, columnSpan } = spans[r][c];
      if (!covered[r][c] && r + rowSpan > row && c + columnSpan > column) return [r, c];
    }
  }
  return [row, column];
}

/** A merge or a split, checked against its table, with the table's lines and the cells' spans. */
type CheckedMerge = CheckedLook & { look: TableLook; entries: TableCellEntry[][] };

function checkMerge(content: EditableMarkdown, table: number, change: MergeChange): CheckedMerge {
  let op = change.type;
  let target = content.tables[table];
  if (target.suggested) {
    throw new Error(
      `${op}: this table holds suggested changes to its rows, columns or cells, so its cells ` +
      "cannot be merged or split until they are accepted or rejected.");
  }
  let block: CellBlock;
  if (change.type === "mergeTableCells") {
    block = change;
  } else {
    let { row, column } = change;
    let found = linesOf(content.markdown, target, op);
    let { rows, columns } = sizeOf(found, op);
    if (row >= rows || column >= columns) {
      throw new Error(
        `unmergeTableCells: row and column must name a cell of the table, which has ${rows} ` +
        `rows and ${columns} columns.`);
    }
    let { rowSpan, columnSpan } = found.rows[row].cells[column];
    if (coveredCells(found.rows.map(line => line.cells))[row][column] ||
        rowSpan === 1 && columnSpan === 1) {
      throw new Error(
        `unmergeTableCells: no merged cell starts at row ${row}, column ${column} (counting ` +
        "from 0). Name the top-left cell of the merged cell.");
    }
    block = { row, column, rows: rowSpan, columns: columnSpan };
  }
  let checked = checkCellBlock(content, table, block, op);
  let { lines, spans } = checked;
  if (lines.rows.length !== target.rows.length) throw notLaidOut(op);
  let entries = target.rows.map((_, row) => tableRowCells(target, row));
  if (entries.some((row, r) => row.length !== lines.rows[r].cells.length)) throw notLaidOut(op);
  let look = readTableLook(lines, op);
  let covered = coveredCells(spans);
  if (change.type === "unmergeTableCells") return { ...checked, look, entries };
  let { row, column, rows, columns } = change;
  for (let r = row; r < row + rows; r++) {
    for (let c = column; c < column + columns; c++) {
      if (covered[r][c]) continue;
      let entry = entries[r][c];
      let cell = lines.rows[r].cells[c];
      let at = `row ${r}, column ${c} (counting from 0)`;
      if (cell.nested || entry.footnote || entry.unshown || entry.loneChip) {
        throw new Error(
          `mergeTableCells: the cell at ${at} holds a table, a footnote, a smart chip or an ` +
          "element getContent() does not show, which merging cells does not support.");
      }
      let { lines: parts } = cellContent(content.markdown, cell, entry);
      if (parts.length > 1 && parts.includes(EMPTY_PARAGRAPH)) {
        throw new Error(
          `mergeTableCells: the cell at ${at} holds an empty paragraph beside others, which ` +
          "merging cells does not support. Remove it first.");
      }
      if (r === row && c === column) {
        let empty = entry.texts.every(([start, end]) => start === end);
        if (entry.styled && parts.length === 1 && empty) {
          throw new Error(
            `mergeTableCells: the cell at ${at} is an empty heading or list item, which ` +
            "merging cells does not support. Give it text, or make it a plain paragraph.");
        }
      } else if (entry.styled || entry.numbered) {
        throw new Error(
          `mergeTableCells: the cell at ${at} starts with a heading, a list item or a subtitle, ` +
          "or holds a numbered list. Only the top-left cell of the block may.");
      }
    }
  }
  return { ...checked, look, entries };
}

/**
 * Replay a merge: Google joins the paragraphs of every cell of the block into its top-left cell,
 * row by row, a cell that is one empty paragraph adding none, and leaves the other cells empty.
 * The merged cell keeps its own shading, alignment and padding, and reads its right and bottom
 * edges from the cells Google keeps them on.
 */
function applyMerge(
  content: EditableMarkdown, table: number,
  change: Extract<TableChange, { type: "mergeTableCells" }>,
): EditableMarkdown {
  let { lines, spans, look, entries } = checkMerge(content, table, change);
  let { row, column, rows, columns } = change;
  let covered = coveredCells(spans);
  let parts: CellContent[] = [];
  let headKept = false;
  for (let r = row; r < row + rows; r++) {
    for (let c = column; c < column + columns; c++) {
      if (covered[r][c]) continue;
      let part = cellContent(content.markdown, lines.rows[r].cells[c], entries[r][c]);
      if (part.lines.length === 1 && part.lines[0] === EMPTY_PARAGRAPH) continue;
      parts.push(part);
      if (r === row && c === column) headKept = true;
    }
  }
  let merged: CellContent = { lines: [], texts: [] };
  for (let part of parts) {
    for (let [line, start, end] of part.texts) {
      merged.texts.push([merged.lines.length + line, start, end]);
    }
    merged.lines.push(...part.lines);
  }
  if (merged.lines.length === 0) merged = { lines: [EMPTY_PARAGRAPH], texts: [[0, 3, 3]] };
  let head = cellBlock(spanAttribute("rowspan", rows) + spanAttribute("colspan", columns), merged);
  let edits: TextEdit[] = [];
  let packed = entries.map((cells, r) => {
    let entriesOfRow = [...cells];
    let inBlock = r >= row && r < row + rows;
    for (let c = column; c < (inBlock ? column + columns : column); c++) {
      let cell = lines.rows[r].cells[c];
      if (r === row && c === column) {
        edits.push({ start: cell.mdStart, end: cell.mdEnd, text: head.html });
        entriesOfRow[c] = {
          // Only the top-left cell may start with a heading or a list item, or hold a numbered
          // list: its paragraphs come first, unless it is empty and adds none.
          ...PLAIN_CELL, texts: head.texts, numbered: cells[c].numbered,
          styled: headKept && cells[c].styled,
        };
      } else {
        edits.push({
          start: cell.mdStart, end: cell.mdEnd, text: `    <td>${EMPTY_PARAGRAPH}</td>\n`,
        });
        entriesOfRow[c] = { ...PLAIN_CELL, texts: [] };
      }
    }
    return packTableRow(entriesOfRow);
  });
  let joined = withTable(content, table, spliceText(content.markdown, edits), packed);
  let headLook = look.cells[row][column]!;
  // The block's right and bottom edges are those of the cells along them, a merged cell the
  // block holds there included: such a cell is whole inside the block, so it ends on that edge.
  let edgeOf = (r: number, c: number, side: "right" | "bottom") => {
    let [hr, hc] = headAt(spans, r, c);
    return look.cells[hr][hc]?.[`border-${side}`] ?? headLook[`border-${side}`];
  };
  let cells = look.cells.map((cellsOfRow, r) => cellsOfRow.map((cell, c) => {
    if (r < row || r >= row + rows || c < column || c >= column + columns) return cell;
    if (r !== row || c !== column) return null;
    return {
      ...headLook,
      "border-right": edgeOf(row, column + columns - 1, "right"),
      "border-bottom": edgeOf(row + rows - 1, column, "bottom"),
    };
  }));
  return restyleTable(joined, table, { ...look, cells });
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

/** Replay a split: the merged cell keeps its text, and the cells it covered come back empty. */
function applyUnmerge(
  content: EditableMarkdown, table: number,
  change: Extract<TableChange, { type: "unmergeTableCells" }>,
): EditableMarkdown {
  let { lines, spans, look, entries } = checkMerge(content, table, change);
  let { row, column } = change;
  let { rowSpan, columnSpan } = spans[row][column];
  let edits: TextEdit[] = [];
  let packed = entries.map((cells, r) => {
    let entriesOfRow = [...cells];
    let inBlock = r >= row && r < row + rowSpan;
    for (let c = column; c < (inBlock ? column + columnSpan : column); c++) {
      let cell = lines.rows[r].cells[c];
      if (r === row && c === column) {
        let open = `<td>`;
        let moved = open.length - (cell.tag.mdEnd - cell.tag.mdStart);
        edits.push({ start: cell.tag.mdStart, end: cell.tag.mdEnd, text: open });
        entriesOfRow[c] = {
          ...cells[c], texts: cells[c].texts.map(([start, end]) => [start + moved, end + moved]),
        };
      } else {
        entriesOfRow[c] = { ...PLAIN_CELL, texts: [[11, 11]] };
      }
    }
    return packTableRow(entriesOfRow);
  });
  let split = withTable(content, table, spliceText(content.markdown, edits), packed);
  let headLook = look.cells[row][column]!;
  let block = { row, column, rows: rowSpan, columns: columnSpan };
  let cells = look.cells.map((cellsOfRow, r) => cellsOfRow.map((cell, c) =>
    r >= row && r < row + rowSpan && c >= column && c < column + columnSpan ? headLook : cell));
  let flat = spans.map(cellsOfRow => cellsOfRow.map(spansOfCell => spansOfCell));
  for (let r = row; r < row + rowSpan; r++) {
    for (let c = column; c < column + columnSpan; c++) flat[r][c] = { rowSpan: 1, columnSpan: 1 };
  }
  let restyled = lookWithCellStyle(
    { ...look, cells }, flat, cellStyleSteps(block, unmergeStyle(headLook)));
  return restyleTable(split, table, restyled);
}

// ---------------------------------------------------------------------------
// Changes to a table's look
// ---------------------------------------------------------------------------

/** A table that passed the checks of a change to its look, with its cells' spans. */
type CheckedLook = { lines: TableLines; spans: Spans[][] };

/**
 * The checks of a change to the look of `block` of the table at `table`: the block lies in the
 * table and holds every merged cell it reaches whole, since Google styles all of a merged cell
 * it reaches any of.
 */
function checkCellBlock(
  content: EditableMarkdown, table: number, block: CellBlock, op: string,
): CheckedLook {
  let lines = linesOf(content.markdown, content.tables[table], op);
  let { rows, columns } = sizeOf(lines, op);
  if (block.row + block.rows > rows) {
    throw new Error(`${op}: row and rows must name rows of the table, which has ${rows}.`);
  }
  if (block.column + block.columns > columns) {
    throw new Error(
      `${op}: column and columns must name columns of the table, which has ${columns}.`);
  }
  let spans = lines.rows.map(row =>
    row.cells.map(({ rowSpan, columnSpan }) => ({ rowSpan, columnSpan })));
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
  return { lines, spans };
}

/** Refuse a change to a table's look for what the table at `table` is or holds. */
export function checkLookTarget(
  content: EditableMarkdown, table: number, change: LookChange,
): void {
  lookTarget(content, table, change);
}

function lookTarget(content: EditableMarkdown, table: number, change: LookChange): CheckedLook {
  let op = change.type;
  if (change.type !== "setTableCellStyle") {
    let lines = linesOf(content.markdown, content.tables[table], op);
    let size = sizeOf(lines, op);
    let ofRows = change.type === "setTableRowHeights";
    let limit = ofRows ? size.rows : size.columns;
    if (change.at + change.count > limit) {
      throw new Error(
        `${op}: at and count must name ${ofRows ? "rows" : "columns"} of the table, which has ` +
        `${limit}.`);
    }
    return { lines, spans: [] };
  }
  let checked = checkCellBlock(content, table, change, op);
  let { borders } = change.style;
  if (borders?.innerHorizontal !== undefined || borders?.innerVertical !== undefined) {
    let merged = checked.spans.some((row, r) => row.some(({ rowSpan, columnSpan }, c) =>
      (rowSpan > 1 || columnSpan > 1) && r >= change.row && r < change.row + change.rows &&
      c >= change.column && c < change.column + change.columns));
    if (merged) {
      throw new Error(
        `${op}: the cells named hold a merged cell, so the edges between their rows or ` +
        "columns cannot be set. Set them on blocks of cells beside it, or use border.");
    }
  }
  return checked;
}

/** Replay a change to the look of the table at `table`. */
function applyLookChange(
  content: EditableMarkdown, table: number, change: LookChange,
): EditableMarkdown {
  let { lines, spans } = lookTarget(content, table, change);
  let look = readTableLook(lines, change.type);
  switch (change.type) {
    case "setTableCellStyle": {
      let steps = cellStyleSteps(change, change.style);
      return restyleTable(content, table, lookWithCellStyle(look, spans, steps));
    }
    case "setTableColumnWidths": {
      let columns = (look.columns ?? lines.rows[0].cells.map(() => null))
        .map((width, column) => column >= change.at && column < change.at + change.count
          ? change.width : width);
      let { columns: _, ...rest } = look;
      return restyleTable(content, table,
        columns.some(width => width !== null) ? { ...rest, columns } : rest);
    }
    case "setTableRowHeights":
      return restyleTable(content, table, {
        ...look,
        rows: look.rows.map((height, row) =>
          row >= change.at && row < change.at + change.count ? change.height : height),
      });
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

/** The requests that make a change in the fresh tab, after the checks its replay makes. */
export function tableChangeRequests(tab: DocTabSnapshot, change: TableChange): GoogleDocsRequest[] {
  let content = tabContent(tab);
  let { tabId } = tab;
  let requests: GoogleDocsRequest[] = [];
  let fill = (text: string, index: number, keepParagraphStyle = false) =>
    plainTextToDocRequests(text, index, tabId, requests, keepParagraphStyle);

  if (change.type === "insertTable") {
    checkTabTableCells(content, addedTableCells(change), "insertTable");
    let place = newTablePlace(content, change.after, tab);
    let { rows, columns } = change;
    let index: number;
    if (place.table !== undefined) {
      index = tab.sourceMap.tables[place.table].docEnd;
    } else if (change.after === undefined) {
      index = tab.bodyEndIndex - 1;
    } else {
      // A line of the tab that no paragraph starts at was refused as a table of contents.
      if (!place.block) throw notLaidOut("insertTable");
      index = place.block.docEnd - 1;
    }
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

  let position = targetOf(content, change);
  let table = tab.sourceMap.tables[position];
  let tableStartLocation = { index: table.docStart, tabId };
  if (change.type === "mergeTableCells" || change.type === "unmergeTableCells") {
    let { look, spans } = checkMerge(content, position, change);
    let { row, column } = change;
    if (change.type === "mergeTableCells") {
      let { rows, columns } = change;
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
    lookTarget(content, position, change);
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
    lookTarget(content, position, change);
    cellStyleRequests(requests, tableStartLocation, cellStyleSteps(change, change.style));
    return requests;
  }
  if (change.type === "deleteTable") {
    checkTableDeletion(content, position, tab);
    addRequest(requests, {
      deleteContentRange: {
        range: { startIndex: table.docStart, endIndex: table.docEnd, tabId },
      },
    });
    return requests;
  }

  let shape = shapeOf(change);
  let { rows, columns } = checkLineChange(content, position, shape, tab);
  let { at, count } = shape;
  switch (change.type) {
    case "insertTableRows": {
      checkTabTableCells(content, addedTableCells(change), change.type);
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
      let indexes = tableRowIndexes(table, reference);
      let start = atEnd ? indexes.docEnd : indexes.docStart;
      let referenceCells = tableRowCells(table, reference);
      // A chip Google copies into a cell takes one index, before the cell's line break.
      let copies = copiedChips(table, reference, change.cells);
      let before = (column: number) => copies.slice(0, column).filter(Boolean).length;
      let rowLength = 1 + 2 * columns + before(columns);
      for (let added = count - 1; added >= 0; added--) {
        for (let column = columns - 1; column >= 0; column--) {
          fill(change.cells[added]?.[column] ?? "",
            start + added * rowLength + 2 + 2 * column + before(column),
            !referenceCells[column].styled);
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
      checkTabTableCells(content, addedTableCells(change), change.type);
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
      restoreFixedWidths(requests, tableStartLocation,
        readTableLook(tableLines(content.markdown, content.tables[position]), change.type),
        reference, at, count);
      for (let row = rows - 1; row >= 0; row--) {
        let indexes = tableRowIndexes(table, row);
        let start = atEnd ? indexes.docEnd : indexes.cells[at].docStart;
        let keep = !tableRowCells(table, row)[reference].styled;
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

// ---------------------------------------------------------------------------
// Where a replacement lies
// ---------------------------------------------------------------------------

/** A replacement of `oldMarkdown`, found at `matchStart`, by `newMarkdown`. */
export type TextReplacement = { matchStart: number; oldMarkdown: string; newMarkdown: string };

/** Which side of a table a change beside it lies on. */
export type TableSide = "before" | "after";

/** Where the text a replacement changes lies among a tab's tables. */
export type ReplacementPlace =
  /** Inside the HTML of the table at this index of `content.tables`: a change to its cells' text. */
  | { kind: "table"; table: number }
  /**
   * Text added at a table's edge. `hasParagraph` when the content shows a paragraph on that side
   * of the table; `readOnly` when a read-only paragraph covers the place the text would go;
   * `equivalent` is the same change written beside the table, if there is one.
   */
  | {
    kind: "edge"; side: TableSide; hasParagraph: boolean; readOnly: boolean;
    equivalent?: TextReplacement;
  }
  /**
   * Outside every table's HTML, on the blank line that sets a table apart. `readOnly` as for an
   * edge; `beyond` is what stands on the far side of the paragraph beside the table: a paragraph
   * that can be edited, one that is read-only, or no paragraph.
   */
  | {
    kind: "blankLine"; side: TableSide; readOnly: boolean;
    beyond: "paragraph" | "readOnly" | "none";
  }
  /** Shares text with a table's HTML without lying inside one table. */
  | { kind: "across" }
  /** Near no table. */
  | { kind: "none" };

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * The lengths of the common prefix of two texts and of the common suffix of what remains,
 * neither splitting a surrogate pair: two emoji can share their high surrogate, and Google
 * refuses to delete or insert half of a pair.
 */
function commonBounds(left: string, right: string): { prefix: number; suffix: number } {
  let shortest = Math.min(left.length, right.length);
  let prefix = 0;
  while (prefix < shortest && left.charCodeAt(prefix) === right.charCodeAt(prefix)) prefix++;
  while (prefix > 0 && isHighSurrogate(left.charCodeAt(prefix - 1))) prefix--;
  let suffix = 0;
  while (suffix < shortest - prefix &&
      left.charCodeAt(left.length - 1 - suffix) === right.charCodeAt(right.length - 1 - suffix)) {
    suffix++;
  }
  while (suffix > 0 && isLowSurrogate(left.charCodeAt(left.length - suffix))) suffix--;
  return { prefix, suffix };
}

/**
 * The range of the Markdown a replacement changes, and what replaces it, as its two texts
 * compare. A change that only adds or only removes text reads the same further left whenever
 * that text repeats the characters before it, and above a table those are the table's own; such
 * a change is read where it touches no table, when it can be.
 */
function changedRange(content: EditableMarkdown, replacement: TextReplacement): TextEdit {
  let { markdown, tables } = content;
  let { matchStart, oldMarkdown, newMarkdown } = replacement;
  let { prefix, suffix } = commonBounds(oldMarkdown, newMarkdown);
  let start = matchStart + prefix;
  let end = matchStart + oldMarkdown.length - suffix;
  let text = newMarkdown.slice(prefix, newMarkdown.length - suffix);
  if (start === end && text !== "") {
    // Text added inside a table that ends with the table's characters before that point is the
    // same text added in front of the table.
    let table = tables.find(candidate => candidate.mdStart < start && start < candidate.mdEnd);
    let lead = table && markdown.slice(table.mdStart, start);
    if (table && lead !== undefined && text.endsWith(lead)) {
      text = lead + text.slice(0, text.length - lead.length);
      start = end = table.mdStart;
    }
  } else if (text === "" && start < end) {
    // A removal that takes the table's first characters, which also stand directly before the
    // range, is the same removal ending where the table starts.
    let table = tables.find(candidate => start < candidate.mdStart && candidate.mdStart < end);
    let taken = table ? end - table.mdStart : 0;
    if (table && start - taken >= 0 &&
        markdown.slice(start - taken, start) === markdown.slice(table.mdStart, end)) {
      start -= taken;
      end -= taken;
    }
  }
  return { start, end, text };
}

/**
 * Where text added on one side of a table would go, when the content shows a paragraph there:
 * before the table, the line break that ends the paragraph above it; after it, the first
 * character of the paragraph below. A waiting paragraph edit can leave the view without that
 * paragraph's line, and the separator of another protected block is then all that stands there.
 */
function pointBeside(
  content: EditableMarkdown, table: MarkdownRange, side: TableSide,
): number | undefined {
  let { markdown } = content;
  if (side === "before") {
    let at = table.mdStart - 2;
    if (at < 0 || markdown[at] !== "\n" || markdown[at + 1] !== "\n") return undefined;
    let endsBlockBefore = at >= 2 && markdown[at - 1] === "\n" && markdown[at - 2] !== "\n" &&
      content.protectedRanges.some(range => range.mdStart < at && range.mdEnd === at + 1);
    return endsBlockBefore ? undefined : at;
  }
  let at = table.mdEnd + 2;
  if (markdown[table.mdEnd] !== "\n" || markdown[table.mdEnd + 1] !== "\n" ||
      at >= markdown.length) return undefined;
  let startsBlockAfter = markdown[at] === "\n" && blockAt(content, at + 1) !== "paragraph";
  return startsBlockAfter ? undefined : at;
}

/** Whether a read-only paragraph covers the place text added on that side of the table would go. */
function readOnlyBeside(content: EditableMarkdown, table: MarkdownRange, side: TableSide): boolean {
  let point = pointBeside(content, table, side);
  return point !== undefined && content.protectedRanges.some(range =>
    range.mdStart <= point && point < range.mdEnd);
}

/** What stands on the far side of the paragraph beside a table. */
function beyondBeside(
  content: EditableMarkdown, table: MarkdownRange, side: TableSide,
): "paragraph" | "readOnly" | "none" {
  let { markdown } = content;
  if (pointBeside(content, table, side) === undefined) return "none";
  let kindOf = (start: number) => blockAt(content, start) !== "paragraph" ? "none"
    : ownRange(content, start) ? "readOnly" : "paragraph";
  if (side === "before") {
    let paragraph = lineStart(markdown, table.mdStart - 2);
    if (paragraph === 0) return "none";
    // No blank line before it: it continues the line above, as items of one list do.
    if (markdown[paragraph - 2] !== "\n") return kindOf(lineStart(markdown, paragraph - 1));
    if (content.tables.some(other => other.mdEnd === paragraph - 2)) return "none";
    return kindOf(lineStart(markdown, paragraph - 2));
  }
  let end = lineEnd(markdown, table.mdEnd + 2);
  if (end >= markdown.length) return "none";
  if (markdown[end] !== "\n") return kindOf(end);
  return end + 1 >= markdown.length ? "none" : kindOf(end + 1);
}

/**
 * The replacement that adds `text` beside a table, at `at`, written against the paragraph on
 * that side: the line breaks the text loses at one end are those that already stand at the
 * other. Absent when no paragraph stands there or the text lacks those line breaks.
 */
function edgeEquivalent(
  content: EditableMarkdown, table: MarkdownRange, side: TableSide, at: number, text: string,
): TextReplacement | undefined {
  let { markdown } = content;
  let point = pointBeside(content, table, side);
  if (point === undefined) return undefined;
  if (side === "before") {
    let breaks = at - point;
    if (!text.endsWith("\n".repeat(breaks))) return undefined;
    let start = lineStart(markdown, point);
    let line = markdown.slice(start, point);
    return {
      matchStart: start,
      oldMarkdown: line,
      newMarkdown: line + "\n".repeat(breaks) + text.slice(0, text.length - breaks),
    };
  }
  let breaks = point - at;
  if (!text.startsWith("\n".repeat(breaks))) return undefined;
  let end = markdown.indexOf("\n", point);
  let line = markdown.slice(point, end < 0 ? markdown.length : end);
  return {
    matchStart: point,
    oldMarkdown: line,
    newMarkdown: text.slice(breaks) + "\n".repeat(breaks) + line,
  };
}

/**
 * Where the text a replacement changes lies. Text that is only added or only removed is first
 * read where it touches no table, when the same change can be written there. Never throws.
 */
export function classifyReplacement(
  content: EditableMarkdown, replacement: TextReplacement,
): ReplacementPlace {
  let { tables } = content;
  let { start, end, text } = changedRange(content, replacement);
  let empty = start === end;
  let inside = tables.findIndex(table => table.mdStart <= start && end <= table.mdEnd &&
    (!empty || table.mdStart < start && start < table.mdEnd));
  if (inside >= 0) return { kind: "table", table: inside };
  if (empty) {
    for (let table of tables) {
      let side: TableSide;
      if (start === table.mdStart - 1 || start === table.mdStart) side = "before";
      else if (start === table.mdEnd || start === table.mdEnd + 1) side = "after";
      else continue;
      let equivalent = edgeEquivalent(content, table, side, start, text);
      return {
        kind: "edge",
        side,
        hasParagraph: pointBeside(content, table, side) !== undefined,
        readOnly: readOnlyBeside(content, table, side),
        ...(equivalent ? { equivalent } : {}),
      };
    }
    return { kind: "none" };
  }
  if (tables.some(table => start < table.mdEnd && end > table.mdStart)) return { kind: "across" };
  for (let table of tables) {
    let range = tableRange(content, table) ?? table;
    if (start >= range.mdEnd || end <= range.mdStart) continue;
    let side: TableSide = end <= table.mdStart ? "before" : "after";
    return {
      kind: "blankLine",
      side,
      readOnly: readOnlyBeside(content, table, side),
      beyond: beyondBeside(content, table, side),
    };
  }
  return { kind: "none" };
}

// ---------------------------------------------------------------------------
// The paragraph path, beside a table
// ---------------------------------------------------------------------------

const BLANK_LINE_HAS_TO_STAY = "replaceText: the replacement changes the blank line between " +
  "a table and the paragraph beside it, which has to stay.";

function blankLineRefusal(beyond: "paragraph" | "readOnly" | "none"): Error {
  switch (beyond) {
    case "paragraph":
      return new Error(
        `${BLANK_LINE_HAS_TO_STAY} To remove or rewrite that paragraph, take the blank line ` +
        "on its other side instead: end oldMarkdown at the last character of the paragraph " +
        "before the table, or start it at the first character of the paragraph after the " +
        "table. If that is refused too, empty the paragraph: it cannot be removed.");
    case "readOnly":
      return new Error(
        `${BLANK_LINE_HAS_TO_STAY} A read-only paragraph stands on that paragraph's other ` +
        "side, so that paragraph can be emptied but not removed.");
    default:
      return new Error(
        `${BLANK_LINE_HAS_TO_STAY} Google Docs keeps a paragraph on each side of a table, so ` +
        "that paragraph can be emptied but not removed.");
  }
}

function readOnlyRefusal(side: TableSide): Error {
  return new Error(
    `replaceText: a paragraph ${side} the table holds an image, smart chip or other element ` +
    "and is read-only: it cannot be changed or removed, and nothing can be added between it " +
    "and the table.");
}

/**
 * Run the paragraph path on a replacement that is not a change to table cells. `run` is that
 * path. It is tried on the replacement as written first; where it refuses that as structured
 * content and a table is the reason, the replacement is run as the same change beside the
 * table, or refused with a message that says what stands in the way.
 */
export function runParagraphReplacement<T>(
  content: EditableMarkdown, replacement: TextReplacement,
  run: (replacement: TextReplacement) => T,
): T {
  let refused: StructuredContentError;
  try {
    return run(replacement);
  } catch (error) {
    if (!(error instanceof StructuredContentError)) throw error;
    refused = error;
  }
  let place = classifyReplacement(content, replacement);
  switch (place.kind) {
    case "edge":
      if (place.readOnly) throw readOnlyRefusal(place.side);
      if (!place.hasParagraph) {
        throw new Error(
          `replaceText: the paragraph ${place.side} this table is missing from the tab as it ` +
          "reads with the earlier changes that are still waiting, so nothing can be added " +
          "there yet. Retry once the earlier changes to this tab have been approved or " +
          "rejected.");
      }
      if (place.equivalent) {
        try {
          return run(place.equivalent);
        } catch (moved) {
          if (!(moved instanceof StructuredContentError)) throw moved;
        }
      }
      throw new Error(
        "replaceText: text added directly above or below a table must be whole paragraphs, " +
        "with a blank line between them and the table.");
    case "blankLine":
      if (place.readOnly) throw readOnlyRefusal(place.side);
      throw blankLineRefusal(place.beyond);
    case "across":
      throw new Error(
        "replaceText: one replacement cannot change a table together with what is around " +
        "it. Change the text inside one table, or the paragraphs before and after it, in " +
        "separate calls; add a table with insertTable() and remove one with deleteTable().");
    default:
      // Near no table, or text that lies in a table: the paragraph path's own refusal.
      throw refused;
  }
}

const NO_LONGER_IN_TABLE = "replaceText: this change was queued for text in a table, and that " +
  "text is no longer in one.";

/** Replay a stored `replaceText`: in table cells when it was queued as that, else as paragraphs. */
export function applyTextReplacement(
  content: EditableMarkdown, replacement: TextReplacement & { inTable?: true }, tabId: string,
  doc?: DocTabSnapshot,
): EditableMarkdown {
  let named = doc?.namedFormatting ?? null;
  if (replacement.inTable) {
    let result = replaceTableText(content, replacement.matchStart, replacement.oldMarkdown,
      replacement.newMarkdown, tabId, named);
    if (!result) throw new Error(NO_LONGER_IN_TABLE);
    return result.content;
  }
  let run: { matchStart: number; oldMarkdown: string; rendered: string } | undefined;
  let edited = runParagraphReplacement(content, replacement, edit => {
    let rendered = canonicalizeMarkdownReplacement(edit.oldMarkdown, edit.newMarkdown);
    if (edit.oldMarkdown === rendered) return content;
    run = { matchStart: edit.matchStart, oldMarkdown: edit.oldMarkdown, rendered };
    return applyMarkdownEdit(
      content, edit.matchStart, edit.matchStart + edit.oldMarkdown.length, rendered);
  });
  if (!named) return edited;
  // Where the content reads as the document does, its blocks name each paragraph's style, and the
  // request builder says which style each block it rewrites is written with.
  let source = documentOf(content, doc)?.sourceMap;
  let blocks = source?.blocks;
  let rewrite = source && run && rewrittenBlockStyles(source, content.markdown, run.matchStart,
    run.matchStart + run.oldMarkdown.length, run.rendered);
  return dropInheritedFormatting(content, edited, named, blocks && (start =>
    blocks.find(block => block.mdStart === start)?.namedStyleType), rewrite, !source);
}

/** The requests of a stored `replaceText` against the fresh tab. */
export function textReplacementRequests(
  tab: DocTabSnapshot, replacement: TextReplacement & { inTable?: true },
): GoogleDocsRequest[] {
  if (replacement.inTable) {
    let requests = tableTextRequests(
      tab, replacement.matchStart, replacement.oldMarkdown, replacement.newMarkdown);
    if (!requests) throw new Error(NO_LONGER_IN_TABLE);
    return requests;
  }
  return runParagraphReplacement(tabContent(tab), replacement, edit => computeReplaceOperations(
    tab.sourceMap, tab.markdown, edit.matchStart, edit.matchStart + edit.oldMarkdown.length,
    canonicalizeMarkdownReplacement(edit.oldMarkdown, edit.newMarkdown), tab.tabId).requests);
}

// ---------------------------------------------------------------------------
// The text of a cell paragraph
// ---------------------------------------------------------------------------

/** The text of a cell paragraph and how it is formatted. */
export type CellInline = { text: string; runs: (CellInlineRun & { start: number; end: number })[] };

/** The tags the text of a cell paragraph is written with, in every spelling that is read. */
const INLINE_TAGS: readonly string[] = [
  "<strong>", "</strong>", "<em>", "</em>", "<s>", "</s>", "<a>", "<a ", "</a>", "<br>", "<br/>",
  "<br />",
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

/**
 * Read the HTML of a cell paragraph's text. Throws for anything the text of a cell cannot be
 * written with.
 */
export function parseCellInline(html: string): CellInline {
  let text = "";
  let runs: CellInline["runs"] = [];
  let open: (InlineStyleTag | "a")[] = [];
  let link: string | undefined;
  // Text is added to the last run while its formatting is the one in force.
  let current: CellInline["runs"][number] | undefined;
  let restyle = () => {
    current = undefined;
  };
  let add = (characters: string) => {
    if (!current) {
      current = { text: "", start: text.length, end: text.length };
      for (let tag of open) if (tag !== "a") current[INLINE_STYLES[tag]] = true;
      if (link !== undefined) current.link = link;
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
    if (name === "a" && !closing && (html[index + 2] === " " || html[index + 2] === ">")) {
      let anchor = /^<a href="([^"]*)">/.exec(html.slice(index));
      if (!anchor) throw new Error(LINK_REFUSAL);
      if (open.includes("a")) throw new Error(TAG_ORDER_REFUSAL);
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
    } else {
      open.push(tag);
    }
    restyle();
    index += tag.length + (closing ? 3 : 2);
  }
  if (open.length > 0) throw new Error(TAG_ORDER_REFUSAL);

  // Runs that open and close tags to the same formatting are one run.
  let merged: CellInline["runs"] = [];
  for (let run of runs) {
    let previous = merged.at(-1);
    if (previous && sameFormat(previous, run) && previous.link === run.link) {
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

type InlineFormat = Pick<CellInlineRun, "bold" | "italic" | "strikethrough" | "link">;

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
  /** The HTML of the text once the replacement is made. */
  html: string;
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

/** Plan the change of one cell paragraph's text from `oldHtml` to `newHtml`, in tab `tabId`. */
/**
 * The plan of one text's change. Where `inherited` names a style the paragraph's named style gives,
 * text the change styles reads without it once Google has applied the change.
 */
function planText(
  oldHtml: string, newHtml: string, tabId: string, inherited: InheritedFormat = {},
): TextPlan {
  let before = parseCellInline(oldHtml);
  let after = parseCellInline(newHtml);
  let { prefix, suffix } = commonBounds(before.text, after.text);
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

  let text = before.text.slice(0, prefix) + inserted + before.text.slice(oldTail);
  return {
    deleteStart: prefix,
    deleteEnd: oldTail,
    inserted,
    linkBeside,
    ...(keptLink === undefined ? {} : { keptLink }),
    segments,
    html: cellInlineHtml(segments.map(segment => {
      // A style the change sends reads as the text's own only where the named style differs.
      let shown = (style: keyof InheritedFormat) => !!segment.next[style] &&
        !(inherited[style] && (!segment.old || !segment.old[style] !== !segment.next[style]));
      return {
        text: text.slice(segment.start, segment.end),
        bold: shown("bold"),
        italic: shown("italic"),
        strikethrough: shown("strikethrough"),
        link: segment.link,
      };
    })),
  };
}

/** The named style of the cell paragraph whose text follows `piece`, by the tag that opens it. */
function cellParagraphStyle(piece: string): string {
  let tag = /<(h[1-6]|p|li)\b[^>]*>[^<]*$/.exec(piece)?.[1];
  return tag?.startsWith("h") ? `HEADING_${tag[1]}` : "NORMAL_TEXT";
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
  raw: string, texts: readonly TableText[], pieces: readonly string[], lines: TableLines,
  tableStart: number,
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
  let position = tableStart + pieceStart +
    (offset < piece.text.length ? offset + dropped : pieces[stop.piece].length);
  let rowIndex = lines.rows.findIndex(row => row.mdStart <= position && position < row.mdEnd);
  let columnIndex = rowIndex < 0 ? -1 : lines.rows[rowIndex].cells.findIndex(cell =>
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
  let cell = lines.rows[rowIndex].cells[columnIndex];
  // A merged cell covers the other cells its spans reach, below it and to its right.
  let covered = lines.rows.slice(0, rowIndex + 1).some((row, headRow) =>
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
  /** The table's index among the content's tables. */
  table: number;
  /** The table's editable texts, in order. */
  texts: TableText[];
  /** The fixed HTML around the texts: one piece more than there are texts. */
  pieces: string[];
  /** The Markdown once the replacement is made as written. */
  updated: string;
  /** The table's HTML in `updated`. */
  raw: string;
  /** Each text as the replacement writes it. */
  written: string[];
  /** The plan of each text the replacement changes; absent for the others. */
  plans: (TextPlan | undefined)[];
  /** The requests of each plan, counted from the start of its text's paragraph. */
  requests: (TextRequest[] | undefined)[];
};

/**
 * Read a replacement as a change to the text of table cells: `undefined` when what it changes
 * does not lie inside one table, and a refusal when it changes more than the text of cells or
 * needs more requests than one change may send.
 */
function readTableText(
  content: EditableMarkdown, replacement: TextReplacement, tabId: string,
  named: NamedFormatting | null,
): TableTextEdit | undefined {
  let place = classifyReplacement(content, replacement);
  if (place.kind !== "table") return undefined;
  let { markdown } = content;
  let { matchStart, oldMarkdown, newMarkdown } = replacement;
  let target = content.tables[place.table];
  let lines = linesOf(markdown, target, "replaceText");
  if (lines.rows.length !== target.rows.length) throw notLaidOut("replaceText");
  let texts: TableText[] = [];
  for (let [row, line] of lines.rows.entries()) {
    let entries = tableRowCells(target, row);
    if (entries.length !== line.cells.length) throw notLaidOut("replaceText");
    for (let [column, cell] of line.cells.entries()) {
      let cellStart = cell.mdStart - target.mdStart;
      for (let [index, [start, end]] of entries[column].texts.entries()) {
        texts.push({ start: cellStart + start, end: cellStart + end, row, column, index });
      }
    }
  }
  let html = markdown.slice(target.mdStart, target.mdEnd);
  let pieces = texts.map((text, index) =>
    html.slice(index === 0 ? 0 : texts[index - 1].end, text.start));
  pieces.push(html.slice(texts.at(-1)?.end ?? 0));
  let updated = markdown.slice(0, matchStart) + newMarkdown +
    markdown.slice(matchStart + oldMarkdown.length);
  let raw = updated.slice(
    target.mdStart, target.mdEnd + newMarkdown.length - oldMarkdown.length);

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
    throw tableTextRefusal(raw, texts, pieces, lines, target.mdStart);
  }

  let plans: (TextPlan | undefined)[] = [];
  let requests: (TextRequest[] | undefined)[] = [];
  let count = 0;
  for (let [index, text] of texts.entries()) {
    let old = html.slice(text.start, text.end);
    let plan = written[index] === old ? undefined
      : planText(old, written[index], tabId, named?.[cellParagraphStyle(pieces[index])]);
    plans.push(plan);
    // A text whose HTML stays as it is needs no request, however it was written.
    let needed = plan && plan.html !== old ? textPlanRequests(plan, tabId) : undefined;
    requests.push(needed);
    count += needed?.length ?? 0;
  }
  if (count > MAX_TABLE_TEXT_REQUESTS) {
    throw new Error(
      `replaceText: this replacement in table cells needs more than ${MAX_TABLE_TEXT_REQUESTS} ` +
      "requests, the most one change may send. Change fewer cells or formatted stretches at " +
      "once.");
  }
  return { table: place.table, texts, pieces, updated, raw, written, plans, requests };
}

/**
 * Replay a replacement of the text of table cells, and say what its approval shows. `undefined`
 * when what the replacement changes does not lie inside one table.
 */
export function replaceTableText(
  content: EditableMarkdown, matchStart: number, oldMarkdown: string, newMarkdown: string,
  tabId: string, named: NamedFormatting | null = null,
): { content: EditableMarkdown; shown: { old: string; requested: string; rendered: string } } | undefined {
  let edit = readTableText(content, { matchStart, oldMarkdown, newMarkdown }, tabId, named);
  if (!edit) return undefined;
  let { markdown } = content;
  let target = content.tables[edit.table];
  let { texts, pieces, plans } = edit;

  // The table as the pieces with each text as it reads once the replacement is made, the range
  // the approval shows, and the cells' texts where they then are.
  let parts: string[] = [];
  let shownStart = matchStart;
  let shownEnd = matchStart + oldMarkdown.length;
  let rows = target.rows.slice();
  let cells: TableCellEntry[] | undefined;
  let moved = 0;
  for (let [index, text] of texts.entries()) {
    let plan = plans[index];
    let old = markdown.slice(target.mdStart + text.start, target.mdStart + text.end);
    let next = plan ? plan.html : old;
    parts.push(pieces[index], next);
    if (plan && plan.html !== edit.written[index]) {
      shownStart = Math.min(shownStart, target.mdStart + text.start);
      shownEnd = Math.max(shownEnd, target.mdStart + text.end);
    }
    let previous = texts[index - 1];
    if (!previous || previous.row !== text.row) cells = undefined;
    if (!previous || previous.row !== text.row || previous.column !== text.column) moved = 0;
    if (moved !== 0 || next.length !== old.length) {
      // The texts of a cell are counted from the cell's first line, so a text moves by what the
      // texts before it in its cell grew or shrank by.
      cells ??= tableRowCells(target, text.row);
      let [start, end] = cells[text.column].texts[text.index];
      let grown = next.length - old.length;
      cells[text.column].texts[text.index] = [start + moved, end + moved + grown];
      rows[text.row] = packTableRow(cells);
      moved += next.length - old.length;
    }
  }
  parts.push(pieces[texts.length]);
  let html = parts.join("");
  let rawDelta = newMarkdown.length - oldMarkdown.length;
  let rendered = markdown.slice(0, target.mdStart) + html + markdown.slice(target.mdEnd);
  return {
    content: withTable(content, edit.table, rendered, rows),
    shown: {
      old: markdown.slice(shownStart, shownEnd),
      requested: edit.updated.slice(shownStart, shownEnd + rawDelta),
      rendered: rendered.slice(shownStart, shownEnd + rendered.length - markdown.length),
    },
  };
}

/**
 * The requests of a replacement of the text of table cells against the fresh tab. `undefined`
 * when what the replacement changes does not lie inside one table.
 */
export function tableTextRequests(
  tab: DocTabSnapshot, matchStart: number, oldMarkdown: string, newMarkdown: string,
): GoogleDocsRequest[] | undefined {
  let { tabId } = tab;
  let edit = readTableText(
    tabContent(tab), { matchStart, oldMarkdown, newMarkdown }, tabId, tab.namedFormatting);
  if (!edit) return undefined;
  let table: TableMapping = tab.sourceMap.tables[edit.table];
  let requests: GoogleDocsRequest[] = [];
  let indexes: ReturnType<typeof tableRowIndexes> | undefined;
  let indexedRow = -1;
  // From the last text to the first, so that no request moves a paragraph still to be changed.
  for (let index = edit.texts.length - 1; index >= 0; index--) {
    let planned = edit.requests[index];
    if (!planned) continue;
    let text = edit.texts[index];
    if (!indexes || indexedRow !== text.row) {
      indexes = tableRowIndexes(table, text.row);
      indexedRow = text.row;
    }
    let paragraph = indexes.cells[text.column].paragraphs[text.index];
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
