import { describe, expect, it } from "vitest";
import type { GoogleDocsTab } from "../src/docs-api";
import {
  assertTableQueueRoom, checkTableCall, DOCUMENT_TABLES,
  MAX_QUEUED_TABLE_LENGTH, prepareTableChange, prepareTextReplacement,
} from "../src/docs-table-actions";
import type { PreparedTableChange, TableCall } from "../src/docs-table-actions";
import {
  addedTableCells, applyNewTable, applyTableChange, applyTextReplacement,
  MAX_TABLE_TEXT_REQUESTS, tableChangeRequests, tableHtml, tableTextRequests,
} from "../src/docs-tables";
import type { TableChange } from "../src/docs-tables";
import type {
  DocTableCell, DocTableCellStyle, DocTableCells, DocTableColumnWidths, DocTableDeletion, DocTableInsertion, DocTableMerge, DocTableRowHeights, NewDocTable,
} from "../src/docs-types";
import { computeReplaceOperations, docTabToMarkdown } from "../src/markdown-converter";
import type { DocTabSnapshot, EditableMarkdown } from "../src/markdown-converter";
import { BULLET_LIST, buildTab } from "./doc-fixture";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type BlockSpec = Parameters<typeof buildTab>[0][number];
type ParagraphSpec = Extract<BlockSpec, { runs: unknown }>;
type TableSpec = Extract<BlockSpec, { table: unknown }>;
type CellSpec = TableSpec["table"][number][number];
type Lists = GoogleDocsTab["lists"];

const TAB = "tab-1";
/** How the connection names the fixture's tab in approval text. */
const LABEL = "\"Main\" (tab-1)";
const MIB = 1024 * 1024;

const LISTS: Lists = {
  ...BULLET_LIST,
  N1: { listProperties: { nestingLevels: [{ glyphType: "DECIMAL" }] } },
};

const para = (text: string): ParagraphSpec => ({ runs: [`${text}\n`] });
const heading = (text: string, level = 2): ParagraphSpec =>
  ({ runs: [`${text}\n`], namedStyleType: `HEADING_${level}` });
const item = (text: string, listId = "L1"): ParagraphSpec =>
  ({ runs: [`${text}\n`], bullet: { listId } });
const grid = (...rows: string[][]): TableSpec =>
  ({ table: rows.map(row => row.map(text => `${text}\n`)) });
const cellOf = (...paragraphs: (ParagraphSpec | TableSpec)[]): CellSpec => ({ paragraphs });
/** A table of `rows` × `columns` cells, each holding its place as text. */
const sized = (rows: number, columns: number, label = "r"): TableSpec => grid(
  ...Array.from({ length: rows }, (_, row) =>
    Array.from({ length: columns }, (__, column) => `${label}${row}c${column}`)));
/** `rows` × `columns` texts, each `text`. */
const texts = (rows: number, columns: number, text = ""): string[][] =>
  Array.from({ length: rows }, () => Array.from({ length: columns }, () => text));
const footnote = (number: number) => ({ footnote: { id: `f${number}`, number: String(number) } });
const dropdown = (): CellSpec => cellOf({ runs: [{ dropdown: "Open" }, "\n"] });
/** A space and a person chip alone in a cell, which nobody has seen Google copy into a new row. */
const unseenChip = (): CellSpec =>
  cellOf({ runs: [" ", { person: { name: "Ana", email: "" } }, "\n"] });

function contentOf(snapshot: DocTabSnapshot): EditableMarkdown {
  return {
    markdown: snapshot.markdown,
    protectedRanges: snapshot.sourceMap.protectedRanges,
    tables: snapshot.sourceMap.tables,
  };
}

const tableAt = (content: EditableMarkdown, table: number): string =>
  content.markdown.slice(content.tables[table].mdStart, content.tables[table].mdEnd);

const addTable = (table: NewDocTable) => ({ method: "insertTable" as const, table });
const addRows = (lines: DocTableInsertion) => ({ method: "insertTableRows" as const, lines });
const addColumns = (lines: DocTableInsertion) =>
  ({ method: "insertTableColumns" as const, lines });
const dropRows = (lines: DocTableDeletion) => ({ method: "deleteTableRows" as const, lines });
const dropColumns = (lines: DocTableDeletion) =>
  ({ method: "deleteTableColumns" as const, lines });
const dropTable = (table: number) => ({ method: "deleteTable" as const, table });

/** A tab as read, to prepare calls against: its own rendering, or content an edit changed. */
type Read = { tab: DocTabSnapshot; content: EditableMarkdown };

function read(tab: GoogleDocsTab): Read {
  let snapshot = docTabToMarkdown(tab);
  return { tab: snapshot, content: contentOf(snapshot) };
}

/** The same tab behind a queued replacement of `oldMarkdown`, replayed over its content. */
function edited(
  { tab, content }: Read, oldMarkdown: string, newMarkdown: string, inTable?: true,
): Read {
  let matchStart = content.markdown.indexOf(oldMarkdown);
  if (matchStart < 0 || content.markdown.indexOf(oldMarkdown, matchStart + 1) >= 0) {
    throw new Error(`Expected ${JSON.stringify(oldMarkdown)} exactly once`);
  }
  let replacement = { matchStart, oldMarkdown, newMarkdown, ...(inTable ? { inTable } : {}) };
  return { tab, content: applyTextReplacement(content, replacement, TAB) };
}

const prepare = ({ tab, content }: Read, call: TableCall): PreparedTableChange =>
  prepareTableChange(content, call, tab, LABEL);

function message(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) return error.message;
    throw error;
  }
  throw new Error("Expected a refusal");
}

const refusal = (from: Read, call: TableCall): string => message(() => prepare(from, call));

/** The stored change of a call, which must be of the kind the call asks for. */
function stored<T extends TableChange["type"]>(
  from: Read, call: TableCall & { method: T },
): Extract<TableChange, { type: T }> {
  let { change } = prepare(from, call);
  if (change.type !== call.method) throw new Error(`Expected a ${call.method} change`);
  return change as Extract<TableChange, { type: T }>;
}

/** What the replay and the request builder both refuse a stored change with on a tab. */
function replayRefusal({ tab, content }: Read, change: TableChange): string {
  let replayed = message(() => applyTableChange(content, change, tab));
  expect(message(() => tableChangeRequests(tab, change))).toBe(replayed);
  return replayed;
}

const STATUS = () => buildTab([
  para("Before"),
  grid(["Task", "Status"], ["Fix login", "Open"], ["Ship docs", "Done"]),
  para("After"),
]);
const TEAM = grid(["Task", "Owner"], ["Fix login", "Ana"]);
/** Two tables that read the same, each under its own heading. */
const PAIR = () => buildTab(
  [heading("Team A"), TEAM, heading("Team B"), TEAM, para("End")]);

const readsTheSame = (op: string, table: number, other: number) =>
  `${op}: table ${table} reads the same as table ${other} of this tab (styles, column ` +
  "widths, row heights, numbers in square brackets and where numbered lists start aside), " +
  "so the change could not be kept to the table it is meant for. Make the two differ " +
  "first, for example by changing the text of a cell with replaceText(), then call " +
  `${op}() again.`;
const tabCells = (op: string, held: number) =>
  `${op}: tables, rows and columns can be added only until the tables of a tab hold 5000 cells ` +
  `in all, a cell counting once for each paragraph in it, and those of this tab would hold ${held}.`;
const cellCount = (op: string) =>
  `${op}: at most 1000 cells that have text can be added at once, an empty cell counting as ` +
  "half of one. Add the rest with further calls.";
const merged = (op: string) =>
  `${op}: this table has merged cells, so its rows and columns cannot be changed.`;
const loneChip = (row: number) =>
  `insertTableRows: row ${row} of this table, counting from 0, has a cell that holds smart chips ` +
  "and no text, which Google Docs copies into a row added beside it in a way that is not " +
  "supported: add the row in Google Docs.";
const chipColumn = (column: number, row: number) =>
  `insertTableRows: column ${column} of this table, counting from 0, holds a dropdown alone in ` +
  `row ${row}, which Google Docs copies into the new rows, so their cells in that column take ` +
  "no text. Leave them empty, and change the copies in Google Docs.";
const columnsFit = (rows: number, count: number) =>
  "insertTableColumns: cells must fit the new columns: one array for each row of the table (at " +
  `most ${rows}), each holding one text for each new column (at most ${count}; count is 1 ` +
  "unless given).";
const tallTable = (rows: number) =>
  "insertTableColumns: columns can be added only to a table of at most 500 rows, and this one " +
  `has ${rows}.`;

// ---------------------------------------------------------------------------
// Kinds, verdicts and defaults
// ---------------------------------------------------------------------------

describe("kinds and verdicts", () => {
  it("lets a user auto-approve every table change, deletions included, under one kind", () => {
    expect(DOCUMENT_TABLES).toEqual({ tag: "document-tables", label: "Table changes" });
    let from = read(STATUS());
    for (let call of [
      addTable({ rows: 1, columns: 1 }), addRows({ table: 0 }), addColumns({ table: 0 }),
      dropRows({ table: 0, at: 1 }), dropColumns({ table: 0, at: 1 }), dropTable(0),
    ]) {
      let prepared = prepare(from, call);
      expect(prepared.actionKind).toBe(DOCUMENT_TABLES);
      expect(prepared.autoApprovable).toBe(true);
    }
  });
});

describe("defaults", () => {
  const from = read(STATUS());

  it("adds after the last row or column when `at` is left out", () => {
    expect(stored(from, addRows({ table: 0 })).at).toBe(3);
    expect(stored(from, addColumns({ table: 0 })).at).toBe(2);
    expect(stored(from, addRows({ table: 0, at: 3 })).at).toBe(3);
    expect(stored(from, addRows({ table: 0, at: 1 })).at).toBe(1);
    expect(stored(from, addColumns({ table: 0, at: 0 })).at).toBe(0);
  });

  it("adds as many rows as `cells` holds, one without it, and `count` rows when given", () => {
    expect(stored(from, addRows({ table: 0 })).cells).toEqual([["", ""]]);
    expect(stored(from, addRows({ table: 0, cells: [] })).cells).toEqual([["", ""]]);
    expect(stored(from, addRows({ table: 0, cells: [["a", "b"], ["c", "d"], ["e", "f"]] })).cells)
      .toEqual([["a", "b"], ["c", "d"], ["e", "f"]]);
    expect(stored(from, addRows({ table: 0, count: 3 })).cells).toEqual(texts(3, 2));
    expect(stored(from, addRows({ table: 0, count: 3, cells: [["a", "b"]] })).cells)
      .toEqual([["a", "b"], ["", ""], ["", ""]]);
  });

  it("fills the rows and cells that `cells` leaves out with empty text", () => {
    expect(stored(from, addRows({ table: 0, cells: [["a"], [], ["", "f"]] })).cells)
      .toEqual([["a", ""], ["", ""], ["", "f"]]);
    expect(stored(from, addTable({ rows: 2, columns: 3 })).cells).toEqual(texts(2, 3));
    expect(stored(from, addTable({ rows: 2, columns: 3, cells: [["a"]] })).cells)
      .toEqual([["a", "", ""], ["", "", ""]]);
  });

  it("adds one column unless `count` is given, whatever `cells` holds", () => {
    expect(stored(from, addColumns({ table: 0 })).cells).toEqual([[""], [""], [""]]);
    expect(stored(from, addColumns({ table: 0, cells: [["Owner"], ["Ana"], ["Ben"]] })).cells)
      .toEqual([["Owner"], ["Ana"], ["Ben"]]);
    expect(stored(from, addColumns({ table: 0, count: 2 })).cells).toEqual(texts(3, 2));
    expect(stored(
      from, addColumns({ table: 0, count: 2, cells: [["Owner", "Due"], ["Ana", "Fri"]] })).cells)
      .toEqual([["Owner", "Due"], ["Ana", "Fri"], ["", ""]]);
    expect(stored(from, addColumns({ table: 0, cells: [["Owner"]] })).cells)
      .toEqual([["Owner"], [""], [""]]);
  });

  it("refuses `cells` written one array for each new column, and adds nothing", () => {
    expect(refusal(from, addColumns({ table: 0, cells: [["Owner", "Ana", "Ben"]] })))
      .toBe(columnsFit(3, 1));
    expect(refusal(from, addColumns({ table: 0, cells: [["Owner", "Due"], ["Ana", "Fri"]] })))
      .toBe(columnsFit(3, 1));
    expect(refusal(from, addColumns({ table: 0, count: 1, cells: [["a"], ["b"], ["c"], ["d"]] })))
      .toBe(columnsFit(3, 1));
    expect(refusal(from, addColumns({ table: 0, count: 2, cells: [["a", "b", "c"]] })))
      .toBe(columnsFit(3, 2));
  });

  it("deletes one row or column unless `count` is given", () => {
    expect(stored(from, dropRows({ table: 0, at: 1 }))).toMatchObject({ at: 1, count: 1 });
    expect(stored(from, dropRows({ table: 0, at: 1, count: 2 }))).toMatchObject({ at: 1, count: 2 });
    expect(stored(from, dropColumns({ table: 0, at: 0 }))).toMatchObject({ at: 0, count: 1 });
  });
});

// ---------------------------------------------------------------------------
// The stored change
// ---------------------------------------------------------------------------

describe("the stored change", () => {
  it("records the table's HTML and nothing else about it", () => {
    let from = read(STATUS());
    let expected = tableAt(from.content, 0);
    let keys = (call: TableCall) => Object.keys(prepare(from, call).change).toSorted();
    expect(prepare(from, addRows({ table: 0, cells: [["a", "b"]] })).change)
      .toEqual({ type: "insertTableRows", at: 3, cells: [["a", "b"]], expected });
    expect(prepare(from, addColumns({ table: 0, at: 1 })).change)
      .toEqual({ type: "insertTableColumns", at: 1, cells: [[""], [""], [""]], expected });
    expect(prepare(from, dropRows({ table: 0, at: 2 })).change)
      .toEqual({ type: "deleteTableRows", at: 2, count: 1, expected });
    expect(prepare(from, dropColumns({ table: 0, at: 0 })).change)
      .toEqual({ type: "deleteTableColumns", at: 0, count: 1, expected });
    expect(prepare(from, dropTable(0)).change).toEqual({ type: "deleteTable", expected });
    expect(keys(addRows({ table: 0 }))).toEqual(["at", "cells", "expected", "type"]);
    expect(keys(addColumns({ table: 0 }))).toEqual(["at", "cells", "expected", "type"]);
    expect(keys(dropRows({ table: 0, at: 0 }))).toEqual(["at", "count", "expected", "type"]);
    expect(keys(dropColumns({ table: 0, at: 0 }))).toEqual(["at", "count", "expected", "type"]);
    expect(keys(dropTable(0))).toEqual(["expected", "type"]);
    expect(keys(addTable({ rows: 1, columns: 1 }))).toEqual(["cells", "columns", "rows", "type"]);
  });

  it("records the table a call names, of two that differ", () => {
    let from = read(buildTab(
      [para("Before"), grid(["a", "b"], ["c", "d"]), para("Mid"), grid(["e", "f"], ["g", "h"]),
        para("After")]));
    expect(tableAt(from.content, 0)).not.toBe(tableAt(from.content, 1));
    for (let table of [0, 1]) {
      let expected = tableAt(from.content, table);
      expect(stored(from, addRows({ table })).expected).toBe(expected);
      expect(stored(from, dropColumns({ table, at: 0 })).expected).toBe(expected);
      expect(stored(from, dropTable(table)).expected).toBe(expected);
    }
  });

  it("stores new cells without the characters Google strips, and `after` as given", () => {
    let from = read(STATUS());
    expect(stored(from, addRows({ table: 0, cells: [["a\u0001b", ""]] })).cells)
      .toEqual([["ab", ""]]);
    expect(stored(from, addColumns({ table: 0, cells: [["x\u001f"]] })).cells)
      .toEqual([["x"], [""], [""]]);
    let table = stored(
      from, addTable({ rows: 1, columns: 2, cells: [["a", "b\u000bc\nd"]], after: "Before\n" }));
    expect(table).toEqual({
      type: "insertTable", rows: 1, columns: 2, cells: [["a", "b\u000bc\nd"]], after: "Before\n",
    });
  });
});

/** One call of each kind that changes the table at `table`. */
const changesTo = (table: number): TableCall[] => [
  addRows({ table, cells: [["a", "b"]] }), addColumns({ table }), dropRows({ table, at: 0 }),
  dropColumns({ table, at: 1 }), dropTable(table),
];

describe("two tables that read the same", () => {
  const from = read(PAIR());

  it("refuses each change to an existing table, naming both tables", () => {
    for (let call of changesTo(0)) {
      expect(refusal(from, call)).toBe(readsTheSame(call.method, 0, 1));
    }
    for (let call of changesTo(1)) {
      expect(refusal(from, call)).toBe(readsTheSame(call.method, 1, 0));
    }
  });

  it("names the first other table that reads the same", () => {
    let three = read(buildTab(
      [heading("Team A"), TEAM, heading("Team B"), TEAM, heading("Team C"), TEAM, para("End")]));
    expect(refusal(three, addRows({ table: 2 }))).toBe(readsTheSame("insertTableRows", 2, 0));
    expect(refusal(three, addRows({ table: 1 }))).toBe(readsTheSame("insertTableRows", 1, 0));
    expect(refusal(three, addRows({ table: 0 }))).toBe(readsTheSame("insertTableRows", 0, 1));
  });

  it("refuses a table for what it is or holds first", () => {
    let wide: TableSpec = {
      table: [[{ paragraphs: [para("head")], tableCellStyle: { columnSpan: 2 } }, "\n"], ["a\n", "b\n"]],
    };
    let mergedPair = read(buildTab([heading("A"), wide, heading("B"), wide, para("End")]));
    expect(refusal(mergedPair, addRows({ table: 0 }))).toBe(merged("insertTableRows"));

    let chips: TableSpec = { table: [["a\n", "b\n"], [unseenChip(), "\n"]] };
    let chipPair = read(buildTab([heading("A"), chips, heading("B"), chips, para("End")]));
    expect(refusal(chipPair, addRows({ table: 0 }))).toBe(loneChip(1));

    expect(refusal(from, addRows({ table: 0, at: 9 })))
      .toBe("insertTableRows: at must be from 0 to 2, the table's number of rows.");
  });

  it("refuses a tab whose tables are full first", () => {
    let narrow = grid(["a", "b", "c", "d", "e"]);
    let full = read(buildTab(
      [heading("A"), narrow, heading("B"), narrow, heading("C"), sized(499, 10), para("End")]));
    expect(refusal(full, addRows({ table: 0, cells: [["a"]] })))
      .toBe(tabCells("insertTableRows", 5005));
    // A change that adds nothing is refused for the tables that read the same.
    expect(refusal(full, dropColumns({ table: 0, at: 0 })))
      .toBe(readsTheSame("deleteTableColumns", 0, 1));
  });

  it("prepares a new table that reads like both, and reports its position", () => {
    let prepared = prepare(from, addTable({
      rows: 2, columns: 2, cells: [["Task", "Owner"], ["Fix login", "Ana"]], after: "## Team A\n",
    }));
    expect(tableHtml(stored(from, addTable({
      rows: 2, columns: 2, cells: [["Task", "Owner"], ["Fix login", "Ana"]], after: "## Team A\n",
    })).cells)).toBe(tableAt(from.content, 0));
    expect(prepared.table).toBe(0);
  });

  it("refuses changes to a table and to a queued table that reads like it", () => {
    let one = read(STATUS());
    let twin = stored(one, addTable({
      rows: 3, columns: 2, cells: [["Task", "Status"], ["Fix login", "Open"], ["Ship docs", "Done"]],
    }));
    let queued: Read = { tab: one.tab, content: applyNewTable(one.content, twin, one.tab).content };
    expect(tableAt(queued.content, 1)).toBe(tableAt(queued.content, 0));
    expect(refusal(queued, addRows({ table: 0 }))).toBe(readsTheSame("insertTableRows", 0, 1));
    expect(refusal(queued, dropTable(1))).toBe(readsTheSame("deleteTable", 1, 0));
    // The table of the document is the one the paragraph `After` follows.
    let apart = edited(
      queued, "<td><p>Done</p></td>\n  </tr>\n</table>\n\nAfter",
      "<td><p>Finished</p></td>\n  </tr>\n</table>\n\nAfter", true);
    expect(stored(apart, addRows({ table: 0 })).expected).toBe(tableAt(apart.content, 0));
    expect(stored(apart, addRows({ table: 1 })).expected).toBe(tableAt(apart.content, 1));
  });

  it("prepares every change for either table once a cell's text sets the two apart", () => {
    let apart = edited(
      from, "## Team A\n\n<table>\n  <tr>\n    <td><p>Task</p></td>",
      "## Team A\n\n<table>\n  <tr>\n    <td><p>Task (team A)</p></td>", true);
    expect(apart.content.markdown).not.toBe(apart.tab.markdown);
    expect(tableAt(apart.content, 0)).toContain("<td><p>Task (team A)</p></td>");
    for (let table of [0, 1]) {
      for (let call of changesTo(table)) {
        let { change } = prepare(apart, call);
        expect(change.type).toBe(call.method);
        expect("expected" in change && change.expected).toBe(tableAt(apart.content, table));
      }
    }
  });
});

/** A body item of a numbered list, then tables whose first cell holds the list's next item. */
const numbered = (second: boolean) => read(buildTab([
  item("Checklist", "N1"),
  heading("Team A"),
  { table: [[cellOf(item("Step", "N1")), "Notes\n"]] },
  ...(second ? [heading("Team B"), { table: [[cellOf(item("Step", "N1")), "Notes\n"]] }] : []),
  para("End"),
], LISTS));
/** A table whose one cell holds text and the footnote of this number. */
const revenue = (number: number): TableSpec =>
  ({ table: [[cellOf({ runs: ["Revenue", footnote(number), "\n"] })]] });

describe("tables that differ only in a number", () => {

  it("refuses rows for either of two tables that differ in where a list starts", () => {
    let both = numbered(true);
    expect(tableAt(both.content, 0)).toContain("<ol start=\"2\">");
    expect(tableAt(both.content, 1)).toContain("<ol start=\"3\">");
    expect(refusal(both, addRows({ table: 0 }))).toBe(readsTheSame("insertTableRows", 0, 1));
    expect(refusal(both, addRows({ table: 1 }))).toBe(readsTheSame("insertTableRows", 1, 0));
  });

  it("refuses rows for either of two that differ in a footnote's number, or in typed digits", () => {
    let footnotes = read(buildTab(
      [para("Intro"), heading("Q1"), revenue(1), heading("Q2"), revenue(2), para("End")]));
    expect(tableAt(footnotes.content, 0)).toContain("Revenue[1]");
    expect(tableAt(footnotes.content, 1)).toContain("Revenue[2]");
    let typed = read(buildTab(
      [heading("A"), grid(["see [1]"]), heading("B"), grid(["see [2]"]), para("End")]));
    for (let from of [footnotes, typed]) {
      expect(refusal(from, addRows({ table: 0 }))).toBe(readsTheSame("insertTableRows", 0, 1));
      expect(refusal(from, addRows({ table: 1 }))).toBe(readsTheSame("insertTableRows", 1, 0));
    }
  });

  it("records the number as it reads where only one such table stands in the tab", () => {
    let one = numbered(false);
    let { expected } = stored(one, addRows({ table: 0, cells: [["x", "y"]] }));
    expect(expected).toBe(tableAt(one.content, 0));
    expect(expected).toContain("<ol start=\"2\">");
  });
});

describe("the position of a new table", () => {
  it("is the number of tables before it once it is added", () => {
    let none = read(buildTab([para("Before"), para("After")]));
    expect(prepare(none, addTable({ rows: 1, columns: 1 })).table).toBe(0);
    expect(prepare(none, addTable({ rows: 1, columns: 1, after: "Before" })).table).toBe(0);

    let one = read(STATUS());
    expect(prepare(one, addTable({ rows: 1, columns: 1, after: "<td><p>Done</p></td>" })).table)
      .toBe(1);
    expect(prepare(one, addTable({ rows: 1, columns: 1, after: "Before" })).table).toBe(0);
    expect(prepare(one, addTable({ rows: 1, columns: 1 })).table).toBe(1);

    let two = read(PAIR());
    expect(prepare(two, addTable({ rows: 1, columns: 1 })).table).toBe(2);
    expect(prepare(two, addTable({ rows: 1, columns: 1, after: "## Team B" })).table).toBe(1);
  });

  it("is absent for a change to an existing table", () => {
    let from = read(STATUS());
    for (let call of [
      addRows({ table: 0 }), addColumns({ table: 0 }), dropRows({ table: 0, at: 0 }),
      dropColumns({ table: 0, at: 0 }), dropTable(0),
    ]) {
      expect("table" in prepare(from, call)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// A call's own arguments
// ---------------------------------------------------------------------------

const wholeNumber = (op: string, name: string, least: 0 | 1) =>
  `${op}: ${name} must be a whole number of at least ${least}.`;
const COLUMNS = "insertTable: columns must be a whole number from 1 to 20.";
const NEW_TABLE_CELLS = "insertTable: a new table holds at most 1000 cells that have text, an " +
  "empty cell counting as half of one. Add it with fewer rows, and the rest with insertTableRows().";
const halfPair = (op: string) =>
  `${op}: the text of the new cells holds half of a surrogate pair: a character such as an ` +
  "emoji, cut in two. Give whole characters.";
const paragraphBreaks = (op: string) =>
  `${op}: the text of the new cells holds more than 2000 paragraph breaks. Add it in several calls.`;
const TOO_MANY_BYTES = "Google Doc action Markdown exceeds the 1048576-byte safe submission limit.";

const argumentRefusal = (call: TableCall): string => message(() => checkTableCall(call));
const breaks = (count: number) => "\n".repeat(count);

describe("argument refusals", () => {
  const NOT_WHOLE = [1.5, -1, 2 ** 53, Number.NaN, Number.POSITIVE_INFINITY];

  it("refuses a number that is not a whole number in range, for each field", () => {
    for (let value of NOT_WHOLE) {
      expect(argumentRefusal(addTable({ rows: value, columns: 2 })))
        .toBe(wholeNumber("insertTable", "rows", 1));
      expect(argumentRefusal(addTable({ rows: 2, columns: value }))).toBe(COLUMNS);
      for (let add of [addRows, addColumns]) {
        let op = add({ table: 0 }).method;
        expect(argumentRefusal(add({ table: value }))).toBe(wholeNumber(op, "table", 0));
        expect(argumentRefusal(add({ table: 0, at: value }))).toBe(wholeNumber(op, "at", 0));
        expect(argumentRefusal(add({ table: 0, count: value }))).toBe(wholeNumber(op, "count", 1));
      }
      for (let drop of [dropRows, dropColumns]) {
        let op = drop({ table: 0, at: 0 }).method;
        expect(argumentRefusal(drop({ table: value, at: 0 }))).toBe(wholeNumber(op, "table", 0));
        expect(argumentRefusal(drop({ table: 0, at: value }))).toBe(wholeNumber(op, "at", 0));
        expect(argumentRefusal(drop({ table: 0, at: 0, count: value })))
          .toBe(wholeNumber(op, "count", 1));
      }
      expect(argumentRefusal(dropTable(value))).toBe(wholeNumber("deleteTable", "table", 0));
    }
    expect(argumentRefusal(addTable({ rows: 0, columns: 2 })))
      .toBe(wholeNumber("insertTable", "rows", 1));
    expect(argumentRefusal(addRows({ table: 0, count: 0 })))
      .toBe(wholeNumber("insertTableRows", "count", 1));
    expect(argumentRefusal(dropColumns({ table: 0, at: 0, count: 0 })))
      .toBe(wholeNumber("deleteTableColumns", "count", 1));
  });

  it("takes numbers at the ends of their ranges, and any count without a document", () => {
    for (let call of [
      addTable({ rows: 1, columns: 1 }), addTable({ rows: 1, columns: 20 }),
      addRows({ table: 0, at: 0, count: 1 }), addColumns({ table: 0, count: 10 ** 9 }),
      dropRows({ table: 0, at: 0, count: 10 ** 9 }), dropColumns({ table: 7, at: 3 }),
      dropTable(0),
    ]) {
      expect(() => checkTableCall(call)).not.toThrow();
    }
  });

  it("makes a table of 1 to 20 columns", () => {
    expect(argumentRefusal(addTable({ rows: 1, columns: 0 }))).toBe(COLUMNS);
    expect(argumentRefusal(addTable({ rows: 1, columns: 21 }))).toBe(COLUMNS);
  });

  it("refuses `cells` that do not fit a new table", () => {
    expect(argumentRefusal(addTable({ rows: 1, columns: 2, cells: [["a", "b"], ["c"]] })))
      .toBe("insertTable: cells must fit the table: at most 1 rows of at most 2 cells.");
    expect(argumentRefusal(addTable({ rows: 2, columns: 2, cells: [["a"], ["b", "c", "d"]] })))
      .toBe("insertTable: cells must fit the table: at most 2 rows of at most 2 cells.");
  });

  it("refuses an `after` that names no text", () => {
    for (let after of ["", "\n\n"]) {
      expect(argumentRefusal(addTable({ rows: 1, columns: 1, after })))
        .toBe("insertTable: after must name text of the tab.");
    }
    expect(() => checkTableCall(addTable({ rows: 1, columns: 1, after: "\nNotes\n" }))).not.toThrow();
  });

  it("refuses more than 1 MiB of text", () => {
    let half = "x".repeat(MIB / 2);
    expect(() => checkTableCall(addRows({ table: 0, cells: [[half, half]] }))).not.toThrow();
    expect(argumentRefusal(addRows({ table: 0, cells: [[half, `${half}x`]] }))).toBe(TOO_MANY_BYTES);
    expect(argumentRefusal(addColumns({ table: 0, cells: [[half], [`${half}x`]] })))
      .toBe(TOO_MANY_BYTES);
    // Counted in UTF-8: each of these characters takes two bytes.
    expect(argumentRefusal(addRows({ table: 0, cells: [["é".repeat(MIB / 2 + 1)]] })))
      .toBe(TOO_MANY_BYTES);
    expect(() => checkTableCall(
      addTable({ rows: 1, columns: 2, cells: [[half]], after: half }))).not.toThrow();
    expect(argumentRefusal(addTable({ rows: 1, columns: 2, cells: [[half]], after: `${half}x` })))
      .toBe(TOO_MANY_BYTES);
  });

  it("refuses more than 2,000 paragraph breaks in the cells of one call", () => {
    expect(() => checkTableCall(addRows({ table: 0, cells: [[breaks(2_000)]] }))).not.toThrow();
    expect(() => checkTableCall(
      addTable({ rows: 1, columns: 2, cells: [[breaks(1_500), breaks(500)]] }))).not.toThrow();
    expect(argumentRefusal(addRows({ table: 0, cells: [[breaks(2_001)]] })))
      .toBe(paragraphBreaks("insertTableRows"));
    expect(argumentRefusal(addColumns({ table: 0, cells: [[breaks(1_000)], [breaks(1_001)]] })))
      .toBe(paragraphBreaks("insertTableColumns"));
    expect(argumentRefusal(
      addTable({ rows: 2, columns: 2, cells: [[breaks(700), breaks(700)], [breaks(601)]] })))
      .toBe(paragraphBreaks("insertTable"));
  });

  it("refuses half a surrogate pair in a new cell's text", () => {
    let cut = "Done \u{1F600}".slice(0, 6);
    expect(cut.isWellFormed()).toBe(false);
    expect(argumentRefusal(addTable({ rows: 1, columns: 1, cells: [[cut]] })))
      .toBe(halfPair("insertTable"));
    expect(argumentRefusal(addRows({ table: 0, cells: [["ok", "\udc00"]] })))
      .toBe(halfPair("insertTableRows"));
    expect(argumentRefusal(addColumns({ table: 0, cells: [["ok"], ["\udc00 late"]] })))
      .toBe(halfPair("insertTableColumns"));
    expect(() => checkTableCall(
      addTable({ rows: 1, columns: 1, cells: [["Done \u{1F600}"]] }))).not.toThrow();
  });

  it("refuses a field the call does not declare, by name", () => {
    let misspelled = { table: 0, rows: [["a", "b"]] };
    expect(argumentRefusal(addRows(misspelled)))
      .toBe("insertTableRows: unknown field \"rows\". The fields are table, at, count and cells.");
    expect(argumentRefusal(addColumns(misspelled))).toBe(
      "insertTableColumns: unknown field \"rows\". The fields are table, at, count and cells.");
    let placed = { rows: 2, columns: 2, before: "## Budget" };
    expect(argumentRefusal(addTable(placed)))
      .toBe("insertTable: unknown field \"before\". The fields are rows, columns, cells and after.");
    let counted = { table: 0, at: 1, rows: 2 };
    expect(argumentRefusal(dropRows(counted)))
      .toBe("deleteTableRows: unknown field \"rows\". The fields are table, at and count.");
    expect(argumentRefusal(dropColumns(counted)))
      .toBe("deleteTableColumns: unknown field \"rows\". The fields are table, at and count.");
  });

  it("ignores an undeclared field that is undefined, and cuts a long name short", () => {
    let absent = { table: 0, rows: undefined };
    expect(() => checkTableCall(addRows(absent))).not.toThrow();
    let long = { table: 0, at: 0, ["n".repeat(60)]: 1 };
    expect(argumentRefusal(dropRows(long))).toBe(
      `deleteTableRows: unknown field "${"n".repeat(40)}". The fields are table, at and count.`);
    let quoted = { table: 0, ["a\"b\n"]: 1 };
    expect(argumentRefusal(addRows(quoted))).toBe(
      "insertTableRows: unknown field \"a\\\"b\\n\". The fields are table, at, count and cells.");
  });

  it("names an undeclared field before anything else that is wrong", () => {
    let both = { rows: 2, columns: 0, before: "## Budget" };
    expect(argumentRefusal(addTable(both)))
      .toBe("insertTable: unknown field \"before\". The fields are rows, columns, cells and after.");
    let negative = { table: -1, rows: [["a"]] };
    expect(argumentRefusal(addRows(negative)))
      .toBe("insertTableRows: unknown field \"rows\". The fields are table, at, count and cells.");
  });

  it("counts a new table's cells, one with text as 1 and an empty one as half", () => {
    expect(() => checkTableCall(
      addTable({ rows: 50, columns: 20, cells: texts(50, 20, "x") }))).not.toThrow();
    expect(argumentRefusal(addTable({ rows: 51, columns: 20, cells: texts(51, 20, "x") })))
      .toBe(NEW_TABLE_CELLS);
    expect(() => checkTableCall(addTable({ rows: 100, columns: 20 }))).not.toThrow();
    expect(argumentRefusal(addTable({ rows: 101, columns: 20 }))).toBe(NEW_TABLE_CELLS);
    // 800 cells with text and 400 without.
    expect(() => checkTableCall(
      addTable({ rows: 60, columns: 20, cells: texts(40, 20, "x") }))).not.toThrow();
    expect(argumentRefusal(
      addTable({ rows: 60, columns: 20, cells: [...texts(40, 20, "x"), ["x"]] })))
      .toBe(NEW_TABLE_CELLS);
    // A text Google strips whole leaves its cell empty.
    expect(() => checkTableCall(
      addTable({ rows: 100, columns: 20, cells: texts(100, 20, "\u0001") }))).not.toThrow();
    expect(argumentRefusal(addTable({ rows: 100, columns: 20, cells: [["x"]] })))
      .toBe(NEW_TABLE_CELLS);
    expect(argumentRefusal(addTable({ rows: 10 ** 9, columns: 20 }))).toBe(NEW_TABLE_CELLS);
  });
});

// ---------------------------------------------------------------------------
// A call against the document
// ---------------------------------------------------------------------------

describe("document refusals", () => {
  it("refuses a position that holds no table, saying how many the tab has", () => {
    expect(refusal(read(PAIR()), dropTable(2))).toBe(
      "deleteTable: tab \"tab-1\" has no table 2. It has 2 tables, numbered from 0 in the " +
      "order getContent(\"tab-1\") shows them.");
    expect(refusal(read(STATUS()), dropTable(1))).toBe(
      "deleteTable: tab \"tab-1\" has no table 1. It has 1 table, numbered from 0 in the " +
      "order getContent(\"tab-1\") shows them.");
    let none = read(buildTab([para("Before"), para("After")]));
    expect(refusal(none, dropTable(0)))
      .toBe("deleteTable: tab \"tab-1\" has no table 0: it has no tables.");
    expect(refusal(none, addRows({ table: 3 })))
      .toBe("insertTableRows: tab \"tab-1\" has no table 3: it has no tables.");
    expect(refusal(read(STATUS()), dropColumns({ table: 1, at: 0 }))).toBe(
      "deleteTableColumns: tab \"tab-1\" has no table 1. It has 1 table, numbered from 0 in the " +
      "order getContent(\"tab-1\") shows them.");
  });

  it("refuses `cells` that do not fit the new rows", () => {
    let from = read(STATUS());
    expect(refusal(from, addRows({ table: 0, cells: [["a", "b", "c"]] }))).toBe(
      "insertTableRows: cells must fit the new rows: at most 1 rows of at most 2 cells, the " +
      "table's number of columns.");
    expect(refusal(from, addRows({ table: 0, count: 2, cells: [["a"], ["b"], ["c"]] }))).toBe(
      "insertTableRows: cells must fit the new rows: at most 2 rows of at most 2 cells, the " +
      "table's number of columns.");
  });

  it("passes on what the engine refuses of the table", () => {
    let wide = read(buildTab([
      para("Before"),
      {
        table: [
          [{ paragraphs: [para("head")], tableCellStyle: { columnSpan: 2 } }, "\n"], ["a\n", "b\n"],
        ],
      },
      para("After"),
    ]));
    expect(refusal(wide, addRows({ table: 0 }))).toBe(merged("insertTableRows"));
    expect(refusal(wide, dropColumns({ table: 0, at: 0 }))).toBe(merged("deleteTableColumns"));

    // Before any default is worked out: no `at` is given.
    let ragged = read(buildTab([para("A"), { table: [["a\n", "b\n"], ["c\n"]] }, para("B")]));
    for (let call of [
      addRows({ table: 0 }), addColumns({ table: 0 }), dropRows({ table: 0, at: 0 }),
      dropColumns({ table: 0, at: 0 }),
    ]) {
      expect(refusal(ragged, call)).toBe(
        `${call.method}: the rows of this table do not all have the same number of cells, so ` +
        "its rows and columns cannot be changed.");
    }

    let chips = read(buildTab(
      [para("Before"), { table: [["a\n", "b\n"], ["c\n", dropdown()]] }, para("After")]));
    expect(refusal(chips, addRows({ table: 0, cells: [["x", "y"]] }))).toBe(chipColumn(1, 1));
    expect(refusal(chips, addRows({ table: 0, at: 1, cells: [["x"], ["", "y"]] })))
      .toBe(chipColumn(1, 1));
    expect(prepare(chips, addRows({ table: 0, cells: [["x", ""]] })).change.type)
      .toBe("insertTableRows");
    expect(prepare(chips, addRows({ table: 0, at: 0, cells: [["x", "y"]] })).change.type)
      .toBe("insertTableRows");
    let unseen = read(buildTab(
      [para("Before"), { table: [["a\n", "b\n"], ["c\n", unseenChip()]] }, para("After")]));
    expect(refusal(unseen, addRows({ table: 0 }))).toBe(loneChip(1));

    let suggested = read(buildTab([
      para("Before"),
      { table: [["a\n", "b\n"], ["c\n", "d\n"]], suggestedRows: { 1: "insertion" } },
      para("After"),
    ]));
    expect(refusal(suggested, addRows({ table: 0 }))).toBe(
      "insertTableRows: this table holds suggested changes to its rows, columns or cells, so " +
      "its rows and columns cannot be changed until they are accepted or rejected.");

    expect(refusal(read(buildTab([para("Before"), sized(501, 1), para("After")])),
      addColumns({ table: 0 }))).toBe(tallTable(501));
  });

  it("refuses rows, columns and a table once the tab's tables would hold too many cells", () => {
    let from = read(buildTab([para("Before"), sized(499, 10), para("After")]));
    let counted = (call: TableCall, change: TableChange): string => {
      expect(refusal(from, call)).toBe(tabCells(call.method, 4_990 + addedTableCells(change)));
      return refusal(from, call);
    };
    let expected = tableAt(from.content, 0);
    expect(counted(addRows({ table: 0, count: 2 }),
      { type: "insertTableRows", at: 499, cells: texts(2, 10), expected }))
      .toBe(tabCells("insertTableRows", 5_010));
    expect(counted(addTable({ rows: 1, columns: 11 }),
      { type: "insertTable", rows: 1, columns: 11, cells: texts(1, 11) }))
      .toBe(tabCells("insertTable", 5_001));
    expect(counted(addRows({ table: 0, cells: [["a\nb"]] }),
      { type: "insertTableRows", at: 499, cells: [["a\nb", ...texts(1, 9)[0]]], expected }))
      .toBe(tabCells("insertTableRows", 5_001));
    expect(stored(from, addRows({ table: 0 })).cells).toEqual(texts(1, 10));
  });

  it("refuses a count no table could take without building its cells", () => {
    let from = read(STATUS());
    expect(refusal(from, addRows({ table: 0, count: 10 ** 9 })))
      .toBe(tabCells("insertTableRows", 6 + 2 * 10 ** 9));
  });

  it("refuses a deletion of more than one batch holds when the call is made", () => {
    let from = read(buildTab([para("Before"), sized(19_007, 1), para("After")]));
    let call = dropRows({ table: 0, at: 1, count: 19_006 });
    let tooMany = "deleteTableRows: deleting 19006 rows needs more than 19005 requests, the " +
      "most one change may send. Delete them in several calls.";
    expect(refusal(from, call)).toBe(tooMany);
    let behind = edited(from, "Before", "Earlier on");
    expect(behind.content.markdown).not.toBe(behind.tab.markdown);
    expect(refusal(behind, call)).toBe(tooMany);
  });

  it("refuses a column for a table too tall before it counts the new cells", () => {
    expect(refusal(read(buildTab([para("Before"), sized(2_001, 1), para("After")])),
      addColumns({ table: 0 }))).toBe(tallTable(2_001));
    expect(refusal(read(buildTab([para("Before"), sized(1_001, 1), para("After")])),
      addColumns({ table: 0, cells: texts(1_001, 1, "x") }))).toBe(tallTable(1_001));
  });

  it("counts the cells rows and columns add, one with text as 1 and an empty one as half", () => {
    let narrow = read(buildTab([para("Before"), grid(["a", "b"]), para("After")]));
    expect(refusal(narrow, addRows({ table: 0, cells: texts(501, 2, "x") })))
      .toBe(cellCount("insertTableRows"));
    expect(stored(narrow, addRows({ table: 0, cells: texts(500, 2, "x") })).cells.length).toBe(500);
    expect(refusal(narrow, addRows({ table: 0, count: 1_001 }))).toBe(cellCount("insertTableRows"));
    expect(stored(narrow, addRows({ table: 0, count: 1_000 })).cells.length).toBe(1_000);
    // A text Google strips whole leaves its cell empty.
    expect(stored(
      narrow, addRows({ table: 0, count: 1_000, cells: texts(1_000, 2, "\u0001") })).cells)
      .toEqual(texts(1_000, 2));

    let tall = read(buildTab([para("Before"), sized(500, 1), para("After")]));
    expect(stored(
      tall, addColumns({ table: 0, count: 2, cells: texts(500, 2, "x") })).cells.length).toBe(500);
    expect(refusal(tall, addColumns({ table: 0, count: 3, cells: texts(500, 3, "x") })))
      .toBe(cellCount("insertTableColumns"));

    let wide = read(buildTab([para("Before"), sized(1, 20), para("After")]));
    expect(stored(wide, addRows({ table: 0, cells: texts(1, 20, "x") })).cells)
      .toEqual(texts(1, 20, "x"));
  });

  it("judges a change by the document while the content reads as the tab does", () => {
    let from = read(buildTab([
      para("Intro"), para("1. First caption"), grid(["x"]), para("2. Second caption"), para("End"),
    ]));
    expect(prepare(from, dropTable(0)).change.type).toBe("deleteTable");
    expect(refusal(edited(from, "Intro", "Introduction"), dropTable(0))).toBe(
      "deleteTable: the lines before and after this table read as list items, which deleting " +
      "it could join into one list. Retry once the earlier changes to this tab have been " +
      "approved or rejected: the document then shows whether they are items of one list.");
  });
});

// ---------------------------------------------------------------------------
// Approval cards
// ---------------------------------------------------------------------------

/** A row of one-paragraph cells as a card shows it: its block without the last line break. */
const rowHtml = (...cells: string[]) =>
  `  <tr>\n${cells.map(text => `    <td><p>${text}</p></td>\n`).join("")}  </tr>`;
const html = (label: string, value: string) => ({ label, kind: "text", value, syntax: "html" });
const markdownField = (label: string, value: string) =>
  ({ label, kind: "text", value, syntax: "markdown" });
const json = (label: string, value: unknown) =>
  ({ label, kind: "json", value: JSON.stringify(value, null, 2) });
const was = (table: number) => ` It was table ${table} of the tab when this change was requested.`;
const BEFORE = markdownField("Text before the table", "Before");
const FIRST = html("First row of the table", rowHtml("Task", "Status"));

describe("cards", () => {
  const from = read(STATUS());
  const card = (call: TableCall, source = from) => {
    let { title, description } = prepare(source, call);
    return { title, ...description };
  };

  it("describes a new table, and the empty paragraph that comes with it", () => {
    expect(card(addTable({ rows: 2, columns: 2 }))).toEqual({
      title: "Insert a table in Google Doc",
      description: "Insert a table of 2 rows and 2 columns in tab \"Main\" (tab-1), at the end " +
        "of the tab. Its cells are empty. An empty paragraph is added after it.",
      descriptionIsComplete: true,
    });
    expect(card(addTable({ rows: 1, columns: 1, cells: [["Total"]] }))).toEqual({
      title: "Insert a table in Google Doc",
      description: "Insert a table of 1 row and 1 column in tab \"Main\" (tab-1), at the end " +
        "of the tab. An empty paragraph is added after it.",
      fields: [json("Cells", [["Total"]])],
      descriptionIsComplete: true,
    });
    expect(card(addTable({ rows: 1, columns: 2, cells: [["a"]], after: "Before\n" }))).toEqual({
      title: "Insert a table in Google Doc",
      description: "Insert a table of 1 row and 2 columns in tab \"Main\" (tab-1), after the " +
        "paragraph, list item or table that the text below ends in. An empty paragraph is " +
        "added with it: after the new table, or between the two tables when it follows a table.",
      fields: [markdownField("After", "Before\n"), json("Cells", [["a", ""]])],
      descriptionIsComplete: true,
    });
    expect(card(addTable({ rows: 3, columns: 1, after: "<p>Done</p>" }))).toEqual({
      title: "Insert a table in Google Doc",
      description: "Insert a table of 3 rows and 1 column in tab \"Main\" (tab-1), after the " +
        "paragraph, list item or table that the text below ends in. Its cells are empty. An " +
        "empty paragraph is added with it: after the new table, or between the two tables " +
        "when it follows a table.",
      fields: [markdownField("After", "<p>Done</p>")],
      descriptionIsComplete: true,
    });
  });

  it("describes new rows, with the row above them where the first row is not it", () => {
    expect(card(addRows({ table: 0, cells: [["Ship", "Open"]] }))).toEqual({
      title: "Insert table rows in Google Doc",
      description: `Insert 1 row in a table of tab "Main" (tab-1), after its last row.${was(1)}`,
      fields: [
        json("New rows", [["Ship", "Open"]]),
        BEFORE, FIRST, html("Row above the new rows", rowHtml("Ship docs", "Done")),
      ],
      descriptionIsComplete: true,
    });
    expect(card(addRows({ table: 0, at: 2, count: 2 }))).toEqual({
      title: "Insert table rows in Google Doc",
      description: "Insert 2 rows in a table of tab \"Main\" (tab-1), before its row 3. They " +
        `are empty.${was(1)}`,
      fields: [BEFORE, FIRST, html("Row above the new rows", rowHtml("Fix login", "Open"))],
      descriptionIsComplete: true,
    });
    for (let at of [0, 1]) {
      expect(card(addRows({ table: 0, at }))).toEqual({
        title: "Insert table rows in Google Doc",
        description: `Insert 1 row in a table of tab "Main" (tab-1), before its row ${at + 1}. ` +
          `They are empty.${was(1)}`,
        fields: [BEFORE, FIRST],
        descriptionIsComplete: true,
      });
    }
  });

  it("says which chips new rows copy", () => {
    let status = read(buildTab([para("Before"), { table: [
      ["Task\n", "Status\n", "Owner\n"],
      ["Fix login\n", dropdown(), cellOf({ runs: [{ person: { name: "Ana", email: "" } }, "\n"] })],
    ] }, para("After")]));
    let { description } = card(addRows({ table: 0, cells: [["Ship docs"]] }), status);
    expect(description).toBe(
      "Insert 1 row in a table of tab \"Main\" (tab-1), after its last row. Google Docs copies " +
      "into it the dropdown or smart chip that stands alone in columns 2, 3 of the row beside " +
      `it: a dropdown with its first choice, and an empty placeholder for any other chip.${was(1)}`);
    expect(card(addRows({ table: 0, at: 0 }), status).description).toBe(
      `Insert 1 row in a table of tab "Main" (tab-1), before its row 1. They are empty.${was(1)}`);
  });

  it("describes new columns", () => {
    expect(card(addColumns({ table: 0, cells: [["Owner"], ["Ana"]] }))).toEqual({
      title: "Insert table columns in Google Doc",
      description: "Insert 1 column in a table of tab \"Main\" (tab-1), after its last " +
        `column.${was(1)}`,
      fields: [json("New cells, row by row", [["Owner"], ["Ana"], [""]]), BEFORE, FIRST],
      descriptionIsComplete: true,
    });
    expect(card(addColumns({ table: 0, at: 1, count: 2 }))).toEqual({
      title: "Insert table columns in Google Doc",
      description: "Insert 2 columns in a table of tab \"Main\" (tab-1), before its column 2. " +
        `They are empty.${was(1)}`,
      fields: [BEFORE, FIRST],
      descriptionIsComplete: true,
    });
  });

  it("describes deleted rows, with what they hold", () => {
    expect(card(dropRows({ table: 0, at: 1 }))).toEqual({
      title: "Delete table rows in Google Doc",
      description: "Delete row 2 of a table of tab \"Main\" (tab-1), with everything in " +
        `it.${was(1)}`,
      fields: [html("Deleted rows", rowHtml("Fix login", "Open")), BEFORE, FIRST],
      descriptionIsComplete: true,
    });
    expect(card(dropRows({ table: 0, at: 1, count: 2 }))).toEqual({
      title: "Delete table rows in Google Doc",
      description: "Delete rows 2 to 3 of a table of tab \"Main\" (tab-1), with everything in " +
        `them.${was(1)}`,
      fields: [
        html("Deleted rows", `${rowHtml("Fix login", "Open")}\n${rowHtml("Ship docs", "Done")}`),
        BEFORE, FIRST,
      ],
      descriptionIsComplete: true,
    });
  });

  it("describes deleted columns, with their cells row by row and without indentation", () => {
    expect(card(dropColumns({ table: 0, at: 1 }))).toEqual({
      title: "Delete table columns in Google Doc",
      description: "Delete column 2 of a table of tab \"Main\" (tab-1), with everything in " +
        `it.${was(1)}`,
      fields: [
        json("Deleted cells, row by row", [
          ["<td><p>Status</p></td>"], ["<td><p>Open</p></td>"], ["<td><p>Done</p></td>"],
        ]),
        BEFORE, FIRST,
      ],
      descriptionIsComplete: true,
    });
    let several = read(buildTab([
      para("Before"),
      { table: [["a\n", "b\n", cellOf(para("First"), para("Second"))], ["d\n", "e\n", "f\n"]] },
      para("After"),
    ]));
    expect(card(dropColumns({ table: 0, at: 1, count: 2 }), several)).toMatchObject({
      description: "Delete columns 2 to 3 of a table of tab \"Main\" (tab-1), with everything " +
        `in them.${was(1)}`,
      fields: [
        json("Deleted cells, row by row", [
          ["<td><p>b</p></td>", "<td>\n  <p>First</p>\n  <p>Second</p>\n</td>"],
          ["<td><p>e</p></td>", "<td><p>f</p></td>"],
        ]),
        BEFORE, html("First row of the table", expect.stringContaining("<td><p>a</p></td>")),
      ],
    });
  });

  it("describes a deleted table with its whole HTML", () => {
    expect(card(dropTable(0))).toEqual({
      title: "Delete a table in Google Doc",
      description: `Delete a table of tab "Main" (tab-1), with everything in it.${was(1)}`,
      fields: [html("Table", tableAt(from.content, 0)), BEFORE],
      descriptionIsComplete: true,
    });
  });

  it("says on a deleted table's card that it holds suggestions, and on no other", () => {
    let suggested = read(buildTab([
      para("Before"),
      { table: [["a\n", "b\n"], ["c\n", "d\n"]], suggestedRows: { 1: "insertion" } },
      para("After"),
    ]));
    expect(card(dropTable(0), suggested).description).toBe(
      "Delete a table of tab \"Main\" (tab-1), with everything in it. It holds suggested " +
      "changes to its rows, columns or cells, which are deleted with it. It was table 1 of the " +
      "tab when this change was requested.");
    expect(card(dropTable(0)).description).not.toContain("suggested");
  });

  it("says on a deletion's card that what is deleted holds chips the content does not show", () => {
    const UNSHOWN = " What is deleted holds a dropdown or other smart chips that are not shown " +
      "below: a cell that holds nothing else reads as empty.";
    let roadmap = read(buildTab([
      para("Before"),
      { table: [
        ["Task\n", "Status\n"],
        ["Ship docs\n", dropdown()],
        ["Fix login\n", cellOf({ runs: ["Now: ", { dropdown: "Done" }, "\n"] })],
        ["Review\n", cellOf({ runs: [{ person: { email: "owner@example.com" } }, "\n"] })],
      ] },
      para("After"),
    ]));

    // A dropdown reads as nothing, so the fields show its cell as empty and the prose says so.
    expect(card(dropColumns({ table: 0, at: 1 }), roadmap)).toEqual({
      title: "Delete table columns in Google Doc",
      description: "Delete column 2 of a table of tab \"Main\" (tab-1), with everything in " +
        `it.${UNSHOWN}${was(1)}`,
      fields: [
        json("Deleted cells, row by row", [
          ["<td><p>Status</p></td>"], ["<td><p></p></td>"], ["<td><p>Now: </p></td>"],
          ["<td><p>owner@example.com</p></td>"],
        ]),
        BEFORE, FIRST,
      ],
      descriptionIsComplete: true,
    });
    expect(card(dropRows({ table: 0, at: 1 }), roadmap)).toMatchObject({
      description: `Delete row 2 of a table of tab "Main" (tab-1), with everything in it.${UNSHOWN}${was(1)}`,
      fields: [html("Deleted rows", rowHtml("Ship docs", "")), BEFORE, FIRST],
    });
    expect(card(dropRows({ table: 0, at: 2, count: 2 }), roadmap).description).toBe(
      `Delete rows 3 to 4 of a table of tab "Main" (tab-1), with everything in them.${UNSHOWN}${was(1)}`);
    expect(card(dropTable(0), roadmap).description).toBe(
      `Delete a table of tab "Main" (tab-1), with everything in it.${UNSHOWN}${was(1)}`);

    // It follows the cells through the changes queued before the deletion.
    let renamed = edited(roadmap, "<td><p>Task</p></td>", "<td><p>Job</p></td>", true);
    expect(card(dropRows({ table: 0, at: 1 }), renamed).description).toContain(UNSHOWN);
    let { change } = prepare(roadmap, dropRows({ table: 0, at: 1, count: 2 }));
    let chipless: Read = { tab: roadmap.tab, content: applyTableChange(roadmap.content, change) };
    expect(card(dropColumns({ table: 0, at: 1 }), chipless).description).not.toContain("chips");
    expect(card(dropTable(0), chipless).description).not.toContain("chips");

    // What is deleted shows all it holds: a chip the content shows, cells with no chip.
    expect(card(dropRows({ table: 0, at: 3 }), roadmap).description).not.toContain("chips");
    expect(card(dropColumns({ table: 0, at: 0 }), roadmap).description).not.toContain("chips");
    // Nothing is deleted.
    expect(card(addColumns({ table: 0 }), roadmap).description).not.toContain("chips");
    expect(card(addRows({ table: 0, at: 0 }), roadmap).description).not.toContain("chips");
  });

  // The card is written once, and the table can come to hold more than it said and still read
  // the same: the change stores what its card said, and applies only to a table that holds no
  // more of it.
  it("stores what a deletion's card says the content does not show, and holds the table to it", () => {
    let status = (cell: CellSpec = "\n") => read(buildTab([
      para("Before"),
      { table: [["Task\n", "Status\n"], ["Fix login\n", cell], ["Ship docs\n", "Done\n"]] },
      para("After"),
    ]));
    let empty = status();
    let chipped = status(dropdown());
    expect(chipped.content.markdown).toBe(empty.content.markdown);

    for (let call of [
      dropRows({ table: 0, at: 1 }), dropColumns({ table: 0, at: 1 }), dropTable(0),
    ]) {
      let unsaid = prepare(empty, call);
      expect(unsaid.description.description).not.toContain("chips");
      expect(unsaid.change).not.toHaveProperty("unshown");
      expect(replayRefusal(chipped, unsaid.change)).toBe(
        `${call.method}: what would be deleted has come to hold a dropdown or other smart ` +
        "chips, which getContent() does not show, since this change was queued.");

      let said = prepare(chipped, call);
      expect(said.description.description).toContain("chips that are not shown below");
      expect(said.change).toMatchObject({ unshown: true });
      expect(tableChangeRequests(chipped.tab, said.change)).toHaveLength(1);
    }

    let rows = [["a\n", "b\n"], ["c\n", "d\n"]];
    let plain = read(buildTab([para("Before"), { table: rows }, para("After")]));
    let suggested = read(buildTab(
      [para("Before"), { table: rows, suggestedRows: { 1: "deletion" } }, para("After")]));
    expect(suggested.content.markdown).toBe(plain.content.markdown);
    let unsaid = prepare(plain, dropTable(0));
    expect(unsaid.change).not.toHaveProperty("suggested");
    expect(replayRefusal(suggested, unsaid.change)).toBe(
      "deleteTable: this table has come to hold suggested changes to its rows, columns or " +
      "cells since this change was queued.");
    let said = prepare(suggested, dropTable(0));
    expect(said.description.description).toContain("It holds suggested changes");
    expect(said.change).toMatchObject({ suggested: true });
    expect(tableChangeRequests(suggested.tab, said.change)).toHaveLength(1);
  });

  it("numbers the table as it stood when the change was requested", () => {
    let pair = read(buildTab(
      [para("Before"), grid(["a", "b"], ["c", "d"]), para("Mid"), grid(["e", "f"], ["g", "h"]),
        para("After")]));
    for (let call of [
      addRows({ table: 1 }), addColumns({ table: 1 }), dropRows({ table: 1, at: 0 }),
      dropColumns({ table: 1, at: 0 }), dropTable(1),
    ]) {
      let shown = card(call, pair);
      expect(shown.description.endsWith(was(2))).toBe(true);
      expect(shown.fields).toContainEqual(markdownField("Text before the table", "Mid"));
    }
  });

  it("shows the nearest text above the table, past empty paragraphs and other tables", () => {
    let under = read(buildTab([
      heading("Budget"), para(""), grid(["a", "b"]), para(""), grid(["c", "d"]), para("After"),
    ]));
    for (let table of [0, 1]) {
      expect(card(addRows({ table }), under).fields?.[0])
        .toEqual(markdownField("Text before the table", "## Budget"));
    }
    let listed = read(buildTab([item("Totals"), grid(["a", "b"]), para("After")], LISTS));
    expect(card(dropTable(0), listed).fields?.[1])
      .toEqual(markdownField("Text before the table", "- Totals"));
    let bare = read(buildTab([para(""), grid(["a", "b"]), para("After")]));
    expect(card(addRows({ table: 0 }), bare).fields)
      .toEqual([html("First row of the table", rowHtml("a", "b"))]);
    expect(card(dropTable(0), bare).fields).toEqual([html("Table", tableAt(bare.content, 0))]);
  });

  it("shows the row above new rows only below a row other than the first", () => {
    let labels = (at?: number) =>
      card(addRows({ table: 0, ...(at === undefined ? {} : { at }) })).fields?.map(field => field.label);
    expect(labels(0)).toEqual(["Text before the table", "First row of the table"]);
    expect(labels(1)).toEqual(["Text before the table", "First row of the table"]);
    expect(labels(2))
      .toEqual(["Text before the table", "First row of the table", "Row above the new rows"]);
    expect(labels())
      .toEqual(["Text before the table", "First row of the table", "Row above the new rows"]);
    expect(card(addRows({ table: 0 })).fields?.[2])
      .toEqual(html("Row above the new rows", rowHtml("Ship docs", "Done")));
  });

  it("puts the tab's name in prose only as the label it is given", () => {
    let titled: Read = { ...from, tab: { ...from.tab, title: "# **Hot** <b>" } };
    for (let call of [addTable({ rows: 1, columns: 1 }), addRows({ table: 0 }), dropTable(0)]) {
      let { description } = card(call, titled);
      expect(description).toContain("tab \"Main\" (tab-1)");
      expect(description).not.toContain("Hot");
    }
  });

  it("shows text of the document and of the agent in fields alone", () => {
    let hostile = "**bold** <script>alert(1)</script> [x](y)";
    let rows = card(addRows({ table: 0, cells: [[hostile, "ok"]] }));
    expect(rows.description).not.toContain("bold");
    expect(rows.fields?.[0]).toEqual(json("New rows", [[hostile, "ok"]]));
    let table = card(addTable({ rows: 1, columns: 1, cells: [[hostile]], after: "Bef" }));
    expect(table.description).not.toContain("bold");
    expect(table.description).not.toContain("Bef");

    let marked = read(buildTab(
      [para("# Not *a* heading"), grid(["**x** & <b>", "y"], ["c", "d"]), para("After")]));
    let deleted = card(dropRows({ table: 0, at: 0 }), marked);
    expect(deleted.description)
      .toBe(`Delete row 1 of a table of tab "Main" (tab-1), with everything in it.${was(1)}`);
    expect(deleted.fields?.[0])
      .toEqual(html("Deleted rows", rowHtml("**x** &amp; &lt;b&gt;", "y")));
    expect(deleted.fields?.[1])
      .toEqual(markdownField("Text before the table", "# Not *a* heading"));
  });

  it("marks a description that could not show everything as incomplete", () => {
    let large = read(buildTab(
      [para("Before"), grid(["a", "b"], ["x".repeat(100_000), "d"]), para("After")]));
    let shown = card(dropTable(0), large);
    expect("descriptionIsComplete" in shown).toBe(false);
    expect(shown.fields?.[0]).toMatchObject({ label: "Table", truncated: expect.anything() });
    // The same table on a card that shows its first row alone.
    expect(card(addRows({ table: 0, at: 0 }), large).descriptionIsComplete).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// What a change and the queue may store
// ---------------------------------------------------------------------------

const tooLargeTable = (op: string) =>
  `${op}: this table is too large for the table methods: its HTML alone is over the ` +
  "1048576-byte limit of one change. The text of its cells can still be changed with replaceText().";

describe("the stored size", () => {
  it("refuses every change that records a table whose HTML alone is over the limit", () => {
    let from = read(buildTab(
      [para("Before"), grid(["small", "x".repeat(MIB)], ["c", "d"]), para("After")]));
    for (let call of [addRows({ table: 0 }), dropRows({ table: 0, at: 1 }), dropTable(0)]) {
      expect(refusal(from, call)).toBe(tooLargeTable(call.method));
    }
    expect(refusal(from, addColumns({ table: 0, cells: [["x".repeat(1_000)]] })))
      .toBe(tooLargeTable("insertTableColumns"));
    // A replacement records nothing of the table.
    let { content, tab } = from;
    let oldMarkdown = "<td><p>small</p></td>";
    let prepared = prepareTextReplacement(
      content, tab, content.markdown.indexOf(oldMarkdown), oldMarkdown, "<td><p>changed</p></td>",
      LABEL);
    expect(prepared.inTable).toBe(true);
    expect(prepared.shown).toEqual(
      { old: oldMarkdown, requested: "<td><p>changed</p></td>", rendered: "<td><p>changed</p></td>" });
  });

  it("refuses a change that is too large together with its table", () => {
    let from = read(buildTab(
      [para("Before"), grid(["x".repeat(600_000), "b"], ["c", "d"]), para("After")]));
    expect(refusal(from, addRows({ table: 0, cells: [["y".repeat(600_000)]] }))).toBe(
      "insertTableRows: the change and the table it applies to exceed the 1048576-byte safe " +
      "submission limit.");
    expect(stored(from, addRows({ table: 0, cells: [["y".repeat(400_000)]] })).cells[0][0])
      .toHaveLength(400_000);
    expect(prepare(from, dropTable(0)).change.type).toBe("deleteTable");
  });

  it("stores nothing of the text before a table, which is on its card", () => {
    let from = read(buildTab(
      [para("x".repeat(MIB + 1)), grid(["a", "b"], ["c", "d"]), para("After")]));
    let prepared = prepare(from, addRows({ table: 0, cells: [["e", "f"]] }));
    expect(JSON.stringify(prepared.change).length).toBeLessThan(1_000);
    expect(prepared.description.fields?.[1])
      .toMatchObject({ label: "Text before the table", truncated: expect.anything() });
    expect("descriptionIsComplete" in prepared.description).toBe(false);
  });
});

const TOO_MUCH = (op: string) =>
  `${op}: the table changes already waiting on this document hold too much table content ` +
  "for another. Retry once some of them have been approved or rejected.";

describe("room in the queue", () => {
  const table = "x".repeat(MIB);
  const recorded = [
    { type: "insertTableRows", expected: table }, { type: "replaceText" },
    { type: "deleteTable", expected: table }, { type: "insertTable" },
    { type: "deleteTableColumns", expected: table }, { type: "appendText" },
  ];

  it("passes while the recorded tables stay at or under their limit", () => {
    expect(MAX_QUEUED_TABLE_LENGTH).toBe(4 * MIB);
    expect(() => assertTableQueueRoom([], { type: "deleteTable", expected: table })).not.toThrow();
    expect(() => assertTableQueueRoom(recorded, { type: "deleteTable", expected: table }))
      .not.toThrow();
    expect(() => assertTableQueueRoom(
      [{ type: "replaceText" }, { type: "insertTable" }],
      { type: "deleteTableRows", at: 0, count: 1, expected: "x".repeat(4 * MIB) })).not.toThrow();
  });

  it("refuses a change whose table takes the recorded tables past it", () => {
    expect(message(() => assertTableQueueRoom(
      recorded, { type: "deleteTable", expected: `${table}x` }))).toBe(TOO_MUCH("deleteTable"));
    expect(message(() => assertTableQueueRoom(
      [...recorded, { type: "deleteTableRows", expected: "x" }],
      { type: "insertTableRows", at: 0, cells: [[""]], expected: table })))
      .toBe(TOO_MUCH("insertTableRows"));
    expect(message(() => assertTableQueueRoom(
      [], { type: "insertTableColumns", at: 0, cells: [[""]], expected: `${table.repeat(4)}x` })))
      .toBe(TOO_MUCH("insertTableColumns"));
  });

  it("always takes a new table, which records none", () => {
    let full = [...recorded, { type: "deleteTable", expected: table.repeat(2) }];
    expect(() => assertTableQueueRoom(
      full, { type: "insertTable", rows: 1, columns: 1, cells: [["x"]] })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// replaceText
// ---------------------------------------------------------------------------

const PARAGRAPH_PROSE = "Replace text in tab \"Main\" (tab-1).";
const TABLE_PROSE = "Replace text in a table of tab \"Main\" (tab-1). The values below are the " +
  "table's HTML: Markdown syntax in them is written to the cells as typed.";
const STRUCTURE = "replaceText: inside a table only the text of its cells can be replaced. " +
  "Change rows and columns with insertTableRows(), insertTableColumns(), deleteTableRows() " +
  "and deleteTableColumns(), and remove a table with deleteTable().";
const TOO_MANY_REQUESTS = "replaceText: this replacement in table cells needs more than 8000 " +
  "requests, the most one change may send. Change fewer cells or formatted stretches at once.";

/** Prepare a replacement of text that occurs once in the content, or at `matchStart`. */
function replace(
  { tab, content }: Read, oldMarkdown: string, newMarkdown: string, matchStart?: number,
) {
  let found = matchStart ?? content.markdown.indexOf(oldMarkdown);
  if (found < 0 || matchStart === undefined && content.markdown.indexOf(oldMarkdown, found + 1) >= 0) {
    throw new Error(`Expected ${JSON.stringify(oldMarkdown)} exactly once`);
  }
  return prepareTextReplacement(content, tab, found, oldMarkdown, newMarkdown, LABEL);
}

/** A cell of `stretches` struck-through letters, each followed by a plain one. */
const striped = (stretches: number) => `<td><p>${"<s>a</s>b".repeat(stretches)}</p></td>`;

describe("a replacement prepared", () => {
  const from = read(buildTab([para("Before"), grid(["Open", "b"]), para("After")]));

  it("prepares a paragraph replacement with the card of any replacement outside tables", () => {
    expect(replace(from, "After", "**Later**")).toEqual({
      inTable: false, prose: PARAGRAPH_PROSE, syntax: "markdown",
      shown: { old: "After", requested: "**Later**", rendered: "**Later**" },
    });
    expect(replace(from, "After", "A\nB")).toEqual({
      inTable: false, prose: PARAGRAPH_PROSE, syntax: "markdown",
      shown: { old: "After", requested: "A\nB", rendered: "A\n\nB" },
    });
  });

  it("prepares a replacement in table cells as table HTML", () => {
    let grouped = read(buildTab([
      para("Before"),
      { table: [[cellOf({ runs: ["Hello ", { text: "World", style: { bold: true } }, "\n"] })]] },
      para("After"),
    ]));
    expect(replace(grouped, "Hello ", "<strong>Hello </strong>")).toEqual({
      inTable: true, prose: TABLE_PROSE, syntax: "html",
      shown: {
        old: "Hello <strong>World</strong>",
        requested: "<strong>Hello </strong><strong>World</strong>",
        rendered: "<strong>Hello World</strong>",
      },
    });
    // Markdown is plain text in a cell: the card says so, and shows the asterisks as written.
    expect(replace(from, "<td><p>Open</p></td>", "<td><p>**Done**</p></td>")).toEqual({
      inTable: true, prose: TABLE_PROSE, syntax: "html",
      shown: {
        old: "<td><p>Open</p></td>", requested: "<td><p>**Done**</p></td>",
        rendered: "<td><p>**Done**</p></td>",
      },
    });
  });

  it("prepares text added beside a table as a paragraph replacement, over one range", () => {
    expect(replace(from, "<table>", "## Results\n\n<table>")).toEqual({
      inTable: false, prose: PARAGRAPH_PROSE, syntax: "markdown",
      shown: {
        old: "Before\n\n<table>", requested: "Before\n\n## Results\n\n<table>",
        rendered: "Before\n\n## Results\n\n<table>",
      },
    });
    expect(replace(from, "</table>", "</table>\n\nCaption")).toEqual({
      inTable: false, prose: PARAGRAPH_PROSE, syntax: "markdown",
      shown: {
        old: "</table>\n\nAfter", requested: "</table>\n\nCaption\n\nAfter",
        rendered: "</table>\n\nCaption\n\nAfter",
      },
    });
    expect(replace(from, "<table>", "X\nY\n\n<table>")).toEqual({
      inTable: false, prose: PARAGRAPH_PROSE, syntax: "markdown",
      shown: {
        old: "Before\n\n<table>", requested: "Before\n\nX\nY\n\n<table>",
        rendered: "Before\n\nX\n\nY\n\n<table>",
      },
    });
  });

  it("shows text moved beside a table as the replay of the stored replacement leaves it", () => {
    // The content takes this replacement as written and joins the new item to the list below
    // the table; only the requests are built for the same text written against that list's
    // first item, a phrasing whose own replay would keep a blank line between the two items.
    let listed = read(buildTab(
      [para("Before"), grid(["Open", "b"]), item("After"), item("Next")], LISTS));
    expect(replace(listed, "</table>", "</table>\n\n- a")).toEqual({
      inTable: false, prose: PARAGRAPH_PROSE, syntax: "markdown",
      shown: {
        old: "</table>\n\n- After", requested: "</table>\n\n- a\n\n- After",
        rendered: "</table>\n\n- a\n- After",
      },
    });
    expect(edited(listed, "</table>", "</table>\n\n- a").content.markdown)
      .toContain("</table>\n\n- a\n- After\n- Next\n");
  });

  it("reads text that starts with `<`, added above a table, as text beside it", () => {
    expect(replace(from, "<table>", "<TODO: describe the figures>\n\n<table>")).toEqual({
      inTable: false, prose: PARAGRAPH_PROSE, syntax: "markdown",
      shown: {
        old: "Before\n\n<table>",
        requested: "Before\n\n<TODO: describe the figures>\n\n<table>",
        rendered: "Before\n\n<TODO: describe the figures>\n\n<table>",
      },
    });
    expect(replace(from, "Before\n\n<table>", "Before\n\n<50 employees only\n\n<table>")).toEqual({
      inTable: false, prose: PARAGRAPH_PROSE, syntax: "markdown",
      shown: {
        old: "Before\n\n<table>",
        requested: "Before\n\n<50 employees only\n\n<table>",
        rendered: "Before\n\n<50 employees only\n\n<table>",
      },
    });
  });

  it("prepares what the paragraph path accepts as written, table context included", () => {
    expect(replace(from, "</table>\n\nAfter", "</table>\nAfter!")).toEqual({
      inTable: false, prose: PARAGRAPH_PROSE, syntax: "markdown",
      shown: {
        old: "</table>\n\nAfter", requested: "</table>\nAfter!", rendered: "</table>\n\nAfter!",
      },
    });
  });

  it("passes on the refusals a table causes", () => {
    expect(message(() => replace(from, "<table>", "Intro <table>"))).toBe(
      "replaceText: text added directly above or below a table must be whole paragraphs, with " +
      "a blank line between them and the table.");
    expect(message(() => replace(from, "Before\n\n", ""))).toBe(
      "replaceText: the replacement changes the blank line between a table and the paragraph " +
      "beside it, which has to stay. Google Docs keeps a paragraph on each side of a table, so " +
      "that paragraph can be emptied but not removed.");
    let chip = read(buildTab([
      { runs: ["Owner: ", { person: { name: "Ana", email: "" } }, "\n"] }, grid(["a", "b"]),
      para("After"),
    ]));
    expect(message(() => replace(chip, "<table>", "Intro\n\n<table>"))).toBe(
      "replaceText: a paragraph before the table holds an image, smart chip or other element " +
      "and is read-only: it cannot be changed or removed, and nothing can be added between it " +
      "and the table.");
    expect(message(() => replace(from, from.content.markdown, "Rewritten\n"))).toBe(
      "replaceText: one replacement cannot change a table together with what is around it. " +
      "Change the text inside one table, or the paragraphs before and after it, in separate " +
      "calls; add a table with insertTable() and remove one with deleteTable().");
    let wide = read(buildTab([
      para("Before"),
      { table: [[{ paragraphs: [para("head")], tableCellStyle: { columnSpan: 2 } }, "\n"]] },
      para("After"),
    ]));
    expect(message(() => replace(wide,
      "<p>head</p></td>\n    <td><p></p></td>", "<p>head</p></td>\n    <td><p>x</p></td>")))
      .toBe("replaceText: a cell that a merged cell covers cannot be edited. Edit the merged cell.");
    // The paragraph path would take this as an edit that sends nothing; typed into the table's
    // closing tag, it is a change to the table.
    expect(message(() => replace(from, "</table>\n\nAfter", "<\\/table>\n\nAfter")))
      .toBe(STRUCTURE);
    expect(message(() => replace(from, "</table>\n\nAfter", "</tab\u0001le>\n\nAfter")))
      .toBe(STRUCTURE);
  });

  it("proves the requests against the tab's own rendering, and against no other content", () => {
    // Text that only a waiting edit holds is replaced without the tab being asked about it.
    let later = edited(from, "After", "Later");
    expect(later.tab.markdown).not.toContain("Later");
    expect(replace(later, "Later", "Latest")).toEqual({
      inTable: false, prose: PARAGRAPH_PROSE, syntax: "markdown",
      shown: { old: "Later", requested: "Latest", rendered: "Latest" },
    });

    // Without `B` the list item ends its section in front of the table. The content takes that
    // edit; the requests for it cannot be built, and the call is refused for that.
    let listed = read(buildTab(
      [para("Intro"), item("Item"), para("B"), grid(["Open", "b"]), para("After")], LISTS));
    expect(message(() => replace(listed, "\n\nB", ""))).toBe(
      "replaceText: cannot keep a list item while deleting the paragraphs that end its " +
      "section. Delete them in an edit that leaves the list item alone.");

    // Behind an earlier edit the content stands elsewhere than the tab's map has it: asked for
    // the same replacement there, the request builder refuses it, so it is not asked.
    let behind = edited(listed, "Intro", "Introduction");
    expect(behind.content.markdown).not.toBe(behind.tab.markdown);
    let paragraph = behind.content.markdown.indexOf("\n\nB");
    expect(() => computeReplaceOperations(
      behind.tab.sourceMap, behind.content.markdown, paragraph, paragraph + 3, "", TAB)).toThrow();
    expect(replace(behind, "\n\nB", "")).toEqual({
      inTable: false, prose: PARAGRAPH_PROSE, syntax: "markdown",
      shown: { old: "\n\nB", requested: "", rendered: "" },
    });

    // The same for the text of a cell, which the earlier edit moved as well.
    let open = "<td><p>Open</p></td>";
    let shut = "<td><p>Shut</p></td>";
    let cell = behind.content.markdown.indexOf(open);
    expect(() => tableTextRequests(behind.tab, cell, open, shut)).toThrow();
    expect(replace(behind, open, shut)).toEqual({
      inTable: true, prose: TABLE_PROSE, syntax: "html",
      shown: { old: open, requested: shut, rendered: shut },
    });
  });

  it("refuses a table replacement too large for one batch, behind other changes or not", () => {
    let empty = read(buildTab([para("Before"), grid(["a", ""]), para("After")]));
    let behind = edited(empty, "Before", "Earlier on");
    for (let source of [empty, behind]) {
      expect(message(() => replace(
        source, "<td><p></p></td>", striped(MAX_TABLE_TEXT_REQUESTS - 1)))).toBe(TOO_MANY_REQUESTS);
      expect(replace(source, "<td><p></p></td>", striped(MAX_TABLE_TEXT_REQUESTS - 2)).inTable)
        .toBe(true);
    }
  });
});

describe("setTableCellStyle", () => {
  const restyle = (cells: DocTableCells & { style: DocTableCellStyle }) =>
    ({ method: "setTableCellStyle" as const, cells });

  it("is a table change a user may let apply without asking", () => {
    let prepared = prepare(read(STATUS()), restyle({ table: 0, row: 0, column: 0, style: { background: "#FFCC00" } }));
    expect(prepared.actionKind).toBe(DOCUMENT_TABLES);
    expect(prepared.autoApprovable).toBe(true);
    expect(prepared.change).toEqual({
      type: "setTableCellStyle", row: 0, column: 0, rows: 1, columns: 1,
      style: { background: "#ffcc00" }, expected: tableAt(read(STATUS()).content, 0),
    });
  });

  it("stores each value as the table's HTML writes it", () => {
    let { change } = prepare(read(STATUS()), restyle({
      table: 0, row: 1, column: 0, rows: 2, columns: 2,
      style: {
        background: null, verticalAlign: "bottom", padding: { top: 0, left: 93.33333 },
        border: { width: 1 }, borders: {
          top: null, innerHorizontal: { width: 0, color: "#ff0000" },
          innerVertical: { width: 2.25, dash: "dotted", color: "#00FF00" },
        },
      },
    }));
    expect(change).toMatchObject({
      style: {
        background: "transparent", verticalAlign: "bottom", padding: { top: "0pt", left: "93.333pt" },
        border: "1pt solid #000000",
        borders: { top: "none", innerHorizontal: "none", innerVertical: "2.25pt dotted #00ff00" },
      },
    });
  });

  it("refuses arguments that are wrong whatever the document holds", () => {
    let at = { table: 0, row: 0, column: 0 };
    expect(argumentRefusal(restyle({ ...at, style: {} })))
      .toBe("setTableCellStyle: style sets nothing. Give at least one of its fields.");
    expect(argumentRefusal(restyle({ ...at, style: { background: "red" } })))
      .toBe("setTableCellStyle: style.background must be a colour written #rrggbb.");
    expect(argumentRefusal(restyle({ ...at, style: { padding: { top: 101 } } })))
      .toBe("setTableCellStyle: style.padding.top must be a number of points from 0 to 100.");
    expect(argumentRefusal(restyle({ ...at, style: { border: { width: -1 } } })))
      .toBe("setTableCellStyle: style.border.width must be a number of points from 0 to 24.");
    expect(argumentRefusal(restyle({ ...at, style: { borders: { innerVertical: null } } }))).toBe(
      "setTableCellStyle: style.borders.innerVertical is the edges between the block's columns, " +
      "and this block has only one.");
    expect(argumentRefusal(restyle({ ...at, rows: 0, style: { background: null } })))
      .toBe("setTableCellStyle: rows must be a whole number of at least 1.");
    expect(argumentRefusal(restyle({ ...at, style: { shading: "#ffffff" } as never }))).toBe(
      "setTableCellStyle: unknown field \"style.shading\". The fields of style are background, " +
      "verticalAlign, padding, border and borders.");
    expect(argumentRefusal(restyle({ ...at, style: { borders: { outer: null } } as never }))).toBe(
      "setTableCellStyle: unknown field \"style.borders.outer\". The fields of style.borders " +
      "are top, bottom, left, right, innerHorizontal and innerVertical.");
    expect(argumentRefusal(restyle({ ...at, cell: 1, style: { background: null } } as never))).toBe(
      "setTableCellStyle: unknown field \"cell\". The fields are table, row, column, rows, " +
      "columns and style.");
  });

  it("refuses cells past the table, and a table that reads like another", () => {
    expect(refusal(read(STATUS()), restyle({ table: 0, row: 3, column: 0, style: { background: null } })))
      .toBe("setTableCellStyle: row and rows must name rows of the table, which has 3.");
    let twins = read(buildTab([para("A"), TEAM, para("B"), TEAM, para("C")]));
    expect(refusal(twins, restyle({ table: 1, row: 0, column: 0, style: { background: null } })))
      .toBe(readsTheSame("setTableCellStyle", 1, 0));
  });

  it("describes the cells it restyles and the style it sets", () => {
    let { title, description } = prepare(read(STATUS()), restyle({
      table: 0, row: 1, column: 0, rows: 2, style: { borders: { bottom: { width: 2 } } },
    }));
    expect(title).toBe("Restyle table cells in Google Doc");
    expect(description.description).toBe(
      "Set the look of the cells in rows 2 to 3 and column 1 of a table of tab \"Main\" (tab-1). " +
      "A border on the block's outer edge also changes the facing edge of the cells beside it. " +
      "It was table 1 of the tab when this change was requested.");
    expect(description.fields?.[0]).toEqual(json("Style", { borders: { bottom: "2pt solid #000000" } }));
  });
});

describe("setTableColumnWidths and setTableRowHeights", () => {
  const widths = (columns: DocTableColumnWidths) => ({ method: "setTableColumnWidths" as const, columns });
  const heights = (rows: DocTableRowHeights) => ({ method: "setTableRowHeights" as const, rows });

  it("sets every line when at is left out, and one when it is given", () => {
    let from = read(STATUS());
    expect(stored(from, widths({ table: 0, width: 120.00004 }))).toMatchObject({ at: 0, count: 2, width: 120 });
    expect(stored(from, widths({ table: 0, at: 1, width: null }))).toMatchObject({ at: 1, count: 1, width: null });
    expect(stored(from, heights({ table: 0, at: 1, count: 2, height: 0 }))).toMatchObject({ at: 1, count: 2, height: 0 });
    expect(prepare(from, heights({ table: 0, height: 30 }))).toMatchObject({
      actionKind: DOCUMENT_TABLES, autoApprovable: true, title: "Set table row heights in Google Doc",
    });
  });

  it("refuses sizes Google refuses or the gatekeeper bounds", () => {
    expect(argumentRefusal(widths({ table: 0, width: 4.9 })))
      .toBe("setTableColumnWidths: width must be a number of points from 5 to 1000.");
    expect(argumentRefusal(heights({ table: 0, height: -1 })))
      .toBe("setTableRowHeights: height must be a number of points from 0 to 1000.");
    expect(argumentRefusal(heights({ table: 0, rows: 2, height: 1 } as never)))
      .toBe("setTableRowHeights: unknown field \"rows\". The fields are table, at, count and height.");
  });

  it("describes what it sets", () => {
    let from = read(STATUS());
    let { title, description } = prepare(from, widths({ table: 0, at: 0, width: 120 }));
    expect(title).toBe("Set table column widths in Google Doc");
    expect(description.description).toBe(
      "Make column 1 of a table of tab \"Main\" (tab-1) 120pt wide. It was table 1 of the tab " +
      "when this change was requested.");
    expect(prepare(from, heights({ table: 0, at: 1, count: 2, height: 0 })).description.description).toBe(
      "Make rows 2 to 3 of a table of tab \"Main\" (tab-1) as tall as their text. It was table 1 " +
      "of the tab when this change was requested.");
  });
});

describe("mergeTableCells and unmergeTableCells", () => {
  const merge = (cells: DocTableMerge) => ({ method: "mergeTableCells" as const, cells });
  const split = (cell: DocTableCell) => ({ method: "unmergeTableCells" as const, cell });

  it("merges and splits as table changes a user may let apply without asking", () => {
    let from = read(STATUS());
    let merged = prepare(from, merge({ table: 0, row: 1, column: 0, rows: 1, columns: 2 }));
    expect(merged).toMatchObject({
      actionKind: DOCUMENT_TABLES, autoApprovable: true, title: "Merge table cells in Google Doc",
      change: { type: "mergeTableCells", row: 1, column: 0, rows: 1, columns: 2 },
    });
    expect(merged.description.description).toBe(
      "Merge the cells in row 2 and columns 1 to 2 of a table of tab \"Main\" (tab-1) into one. " +
      "Their text is joined into the top-left cell, row by row. It was table 1 of the tab when " +
      "this change was requested.");
    let after = { tab: from.tab, content: applyTableChange(from.content, merged.change, from.tab) };
    let split_ = prepare(after, split({ table: 0, row: 1, column: 0 }));
    expect(split_).toMatchObject({ autoApprovable: true, title: "Split a table cell in Google Doc" });
  });

  it("refuses a block of one cell, and fields it does not declare", () => {
    expect(argumentRefusal(merge({ table: 0, row: 0, column: 0, rows: 1, columns: 1 })))
      .toBe("mergeTableCells: the block must hold at least two cells.");
    expect(argumentRefusal(split({ table: 0, row: 0, column: 0, rows: 2 } as never)))
      .toBe("unmergeTableCells: unknown field \"rows\". The fields are table, row and column.");
    expect(refusal(read(STATUS()), split({ table: 0, row: 0, column: 0 }))).toBe(
      "unmergeTableCells: no merged cell starts at row 0, column 0 (counting from 0). Name the " +
      "top-left cell of the merged cell.");
  });
});
