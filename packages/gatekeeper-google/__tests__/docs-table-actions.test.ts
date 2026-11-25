// Table changes, appends and replacements prepared on a stored tab: arguments, refusals, the
// change stored and the card shown.

import { describe, expect, it, vi } from "vitest";
import { googleDocDisplayLimit } from "../src/doc-actions";
import type { GoogleDocsTab, NamedStyles } from "../src/docs-api";
import { applyDocEdit, changedSpan, renderTab, type DocEdit } from "../src/docs-replay";
import { cutRuns, RUN_SIZES, type RunSizes } from "../src/docs-runs";
import { docStoreCost, runId, type DocStore, type DocVersion } from "../src/docs-store";
import {
  assertTableQueueRoom, checkTableCall, DOCUMENT_TABLES,
  MAX_QUEUED_TABLE_LENGTH, prepareAppend, prepareTableChange, prepareTextReplacement,
} from "../src/docs-table-actions";
import type { PreparedTableChange, TableCall } from "../src/docs-table-actions";
import {
  addedTableCells, besideTableRefusal, MAX_TABLE_TEXT_REQUESTS, tableChangeRequests,
} from "../src/docs-tables";
import type { TableChange } from "../src/docs-tables";
import type {
  DocTableCell, DocTableCellStyle, DocTableCells, DocTableColumnWidths, DocTableDeletion, DocTableInsertion, DocTableMerge, DocTableRowHeights, NewDocTable,
} from "../src/docs-types";
import type { DocTabSnapshot } from "../src/markdown-converter";
import {
  BULLET_LIST, buildTab, cardField, cellOf, footnote, grid, heading, item, NUMBERED_LIST, para,
  sized, tableAt, tableHtml, thrownMessage,
} from "./doc-fixture";
import type { CellSpec, Lists, TableSpec } from "./doc-fixture";
import { fakeDocStore } from "./doc-store-fake";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** How the connection names the fixture's tab in approval text. */
const LABEL = "\"Main\" (tab-1)";
const MIB = 1024 * 1024;

const LISTS: Lists = { ...BULLET_LIST, ...NUMBERED_LIST };

/** `rows` × `columns` texts, each `text`. */
const texts = (rows: number, columns: number, text = ""): string[][] =>
  Array.from({ length: rows }, () => Array.from({ length: columns }, () => text));
const dropdown = (): CellSpec => cellOf({ runs: [{ dropdown: "Open" }, "\n"] });
/** A space and a person chip alone in a cell, which nobody has seen Google copy into a new row. */
const unseenChip = (): CellSpec =>
  cellOf({ runs: [" ", { person: { name: "Ana", email: "" } }, "\n"] });

const addTable = (table: NewDocTable) => ({ method: "insertTable" as const, table });
const addRows = (lines: DocTableInsertion) => ({ method: "insertTableRows" as const, lines });
const addColumns = (lines: DocTableInsertion) =>
  ({ method: "insertTableColumns" as const, lines });
const dropRows = (lines: DocTableDeletion) => ({ method: "deleteTableRows" as const, lines });
const dropColumns = (lines: DocTableDeletion) =>
  ({ method: "deleteTableColumns" as const, lines });
const dropTable = (table: number) => ({ method: "deleteTable" as const, table });
const restyle = (cells: DocTableCells & { style: DocTableCellStyle }) =>
  ({ method: "setTableCellStyle" as const, cells });
const widths = (columns: DocTableColumnWidths) =>
  ({ method: "setTableColumnWidths" as const, columns });
const heights = (rows: DocTableRowHeights) => ({ method: "setTableRowHeights" as const, rows });
const merge = (cells: DocTableMerge) => ({ method: "mergeTableCells" as const, cells });
const split = (cell: DocTableCell) => ({ method: "unmergeTableCells" as const, cell });

/** A tab as it stands, to prepare calls against, with its rendering. */
type Read = { doc: GoogleDocsTab; tab: DocTabSnapshot };

function read(doc: GoogleDocsTab): Read {
  return { doc, tab: renderTab(doc) };
}

/** The same tab with a queued replacement of `oldMarkdown` made in it. */
function edited(from: Read, oldMarkdown: string, newMarkdown: string, inTable?: true): Read {
  return read(applyDocEdit(
    from.doc, { type: "replaceText", oldMarkdown, newMarkdown, ...(inTable ? { inTable } : {}) }));
}

/** An element a run, a table alone: no run ends by its content. */
const ONE: RunSizes = { least: Infinity, target: Infinity, most: Infinity, elements: 1 };

type Stored = { store: DocStore; version: DocVersion };

/** `tab` stored under the store's sizes, and (`forced`) under runs of one element. */
function versionOf(tab: GoogleDocsTab): Stored & { forced: Stored } {
  let stored = (sizes?: RunSizes): Stored => {
    let store = fakeDocStore(undefined, undefined, sizes);
    return { store, version: store.putTab("doc", tab, []) };
  };
  return { ...stored(), forced: stored(ONE) };
}

/** What `call` answers of `tab` stored, which both stores of `versionOf` must answer alike. */
function onBoth<T>(tab: GoogleDocsTab, call: (store: DocStore, version: DocVersion) => T): T {
  let { store, version, forced } = versionOf(tab);
  let outcome = (run: () => T): { value: T } | { error: unknown } => {
    try {
      return { value: run() };
    } catch (error) {
      return { error };
    }
  };
  let plain = outcome(() => call(store, version));
  let several = outcome(() => call(forced.store, forced.version));
  if ("error" in plain) {
    expect("error" in several ? thrownMessage(() => { throw several.error; }) : several)
      .toBe(thrownMessage(() => { throw plain.error; }));
    throw plain.error;
  }
  expect(several).toEqual(plain);
  return plain.value;
}

const prepare = ({ doc }: Read, call: TableCall): PreparedTableChange =>
  onBoth(doc, (store, version) => prepareTableChange(store, version, call, LABEL));

const refusal = (from: Read, call: TableCall): string => thrownMessage(() => prepare(from, call));

/** The stored change of a call, which must be of the kind the call asks for. */
function stored<T extends TableChange["type"]>(
  from: Read, call: TableCall & { method: T },
): Extract<TableChange, { type: T }> {
  let { change } = prepare(from, call);
  if (change.type !== call.method) throw new Error(`Expected a ${call.method} change`);
  return change as Extract<TableChange, { type: T }>;
}

/** What the request builder, and so a replay, refuses a stored change with on a tab. */
function replayRefusal({ tab }: Read, change: TableChange): string {
  return thrownMessage(() => tableChangeRequests(tab, change));
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
  `${op}: tables, rows and columns can be added, and cells merged, only until the tables of a ` +
  "tab hold 5000 cells " +
  `in all, a cell counting once for each paragraph in it, and those of this tab would hold ${held}.`;
const cellCount = (op: string) =>
  `${op}: at most 1000 cells that have text can be added at once, an empty cell counting as ` +
  "half of one. Add the rest with further calls.";
const copiesMerged = (op: string, noun: string, line: number, row = 0, column = 0) =>
  `${op}: ${noun} ${line} of this table, counting from 0, which the new ${noun}s copy, crosses ` +
  `the merged cell at row ${row}, column ${column}, which Google Docs would grow or copy into ` +
  `them. ${noun[0].toUpperCase()}${noun.slice(1)}s can be added only beside ${noun}s that cross no merged cell.`;
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
  it("records the table's HTML, and for new rows what Google copies into them", () => {
    let from = read(STATUS());
    let expected = tableAt(from.tab, 0);
    expect(prepare(from, addRows({ table: 0, cells: [["a", "b"]] })).change)
      .toStrictEqual({ type: "insertTableRows", at: 3, cells: [["a", "b"]], expected, copies: "--", pinned: 0 });
    expect(prepare(from, addColumns({ table: 0, at: 1 })).change)
      .toStrictEqual({ type: "insertTableColumns", at: 1, cells: [[""], [""], [""]], expected });
    expect(prepare(from, dropRows({ table: 0, at: 2 })).change)
      .toStrictEqual({ type: "deleteTableRows", at: 2, count: 1, expected });
    expect(prepare(from, dropColumns({ table: 0, at: 0 })).change)
      .toStrictEqual({ type: "deleteTableColumns", at: 0, count: 1, expected });
    expect(prepare(from, dropTable(0)).change).toStrictEqual({ type: "deleteTable", expected });
    expect(prepare(from, addTable({ rows: 1, columns: 1 })).change)
      .toStrictEqual({ type: "insertTable", rows: 1, columns: 1, cells: [[""]] });
  });

  it("records the table a call names, of two that differ", () => {
    let from = read(buildTab(
      [para("Before"), grid(["a", "b"], ["c", "d"]), para("Mid"), grid(["e", "f"], ["g", "h"]),
        para("After")]));
    expect(tableAt(from.tab, 0)).not.toBe(tableAt(from.tab, 1));
    for (let table of [0, 1]) {
      let expected = tableAt(from.tab, table);
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
    // A look, a merge and a split are kept to their table the same way.
    for (let call of [
      widths({ table: 0, width: 120 }), heights({ table: 0, height: 30 }),
      merge({ table: 0, row: 0, column: 0, rows: 1, columns: 2 }),
      split({ table: 0, row: 0, column: 0 }),
    ]) {
      expect(refusal(from, call)).toBe(readsTheSame(call.method, 0, 1));
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
    expect(refusal(mergedPair, addRows({ table: 0, at: 0 })))
      .toBe(copiesMerged("insertTableRows", "row", 0));

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
    })).cells)).toBe(tableAt(from.tab, 0));
    expect(prepared.table).toBe(0);
  });

  it("refuses changes to a table and to a queued table that reads like it", () => {
    let one = read(STATUS());
    let twin = stored(one, addTable({
      rows: 3, columns: 2, cells: [["Task", "Status"], ["Fix login", "Open"], ["Ship docs", "Done"]],
    }));
    let queued = read(applyDocEdit(one.doc, twin));
    expect(tableAt(queued.tab, 1)).toBe(tableAt(queued.tab, 0));
    expect(refusal(queued, addRows({ table: 0 }))).toBe(readsTheSame("insertTableRows", 0, 1));
    expect(refusal(queued, dropTable(1))).toBe(readsTheSame("deleteTable", 1, 0));
    // The table of the document is the one the paragraph `After` follows.
    let apart = edited(
      queued, "<td><p>Done</p></td>\n  </tr>\n</table>\n\nAfter",
      "<td><p>Finished</p></td>\n  </tr>\n</table>\n\nAfter", true);
    expect(stored(apart, addRows({ table: 0 })).expected).toBe(tableAt(apart.tab, 0));
    expect(stored(apart, addRows({ table: 1 })).expected).toBe(tableAt(apart.tab, 1));
  });

  it("prepares every change for either table once a cell's text sets the two apart", () => {
    let apart = edited(
      from, "## Team A\n\n<table>\n  <tr>\n    <td><p>Task</p></td>",
      "## Team A\n\n<table>\n  <tr>\n    <td><p>Task (team A)</p></td>", true);
    expect(apart.tab.markdown).not.toBe(from.tab.markdown);
    expect(tableAt(apart.tab, 0)).toContain("<td><p>Task (team A)</p></td>");
    for (let table of [0, 1]) {
      for (let call of changesTo(table)) {
        let { change } = prepare(apart, call);
        expect(change.type).toBe(call.method);
        expect("expected" in change && change.expected).toBe(tableAt(apart.tab, table));
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
    expect(tableAt(both.tab, 0)).toContain("<ol start=\"2\">");
    expect(tableAt(both.tab, 1)).toContain("<ol start=\"3\">");
    expect(refusal(both, addRows({ table: 0 }))).toBe(readsTheSame("insertTableRows", 0, 1));
    expect(refusal(both, addRows({ table: 1 }))).toBe(readsTheSame("insertTableRows", 1, 0));
  });

  it("refuses rows for either of two that differ in a footnote's number, or in typed digits", () => {
    let footnotes = read(buildTab(
      [para("Intro"), heading("Q1"), revenue(1), heading("Q2"), revenue(2), para("End")]));
    expect(tableAt(footnotes.tab, 0)).toContain("Revenue[1]");
    expect(tableAt(footnotes.tab, 1)).toContain("Revenue[2]");
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
    expect(expected).toBe(tableAt(one.tab, 0));
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

const argumentRefusal = (call: TableCall): string => thrownMessage(() => checkTableCall(call));
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

  it("passes on what the builders refuse of the table", () => {
    // A table's size is asked first: before a default `at` is worked out, and of a deletion.
    let ragged = read(buildTab([para("A"), { table: [["a\n", "b\n"], ["c\n"]] }, para("B")]));
    for (let call of [
      addRows({ table: 0 }), addColumns({ table: 0 }), dropRows({ table: 0, at: 0 }),
    ]) {
      expect(refusal(ragged, call)).toBe(
        `${call.method}: the rows of this table do not all have the same number of cells, so ` +
        "its rows and columns cannot be changed.");
    }

    // Which chips a new row copies is worked out where its requests are built.
    let chips = read(buildTab(
      [para("Before"), { table: [["a\n", "b\n"], ["c\n", dropdown()]] }, para("After")]));
    expect(refusal(chips, addRows({ table: 0, cells: [["x", "y"]] }))).toBe(chipColumn(1, 1));
    expect(prepare(chips, addRows({ table: 0, cells: [["x", ""]] })).change.type)
      .toBe("insertTableRows");
  });

  it("counts the cells a call would add as its stored change holds them", () => {
    let from = read(buildTab([para("Before"), sized(499, 10), para("After")]));
    // One new row of ten cells, the first of which holds two paragraphs.
    let call = addRows({ table: 0, cells: [["a\nb"]] });
    let change: TableChange = {
      type: "insertTableRows", at: 499, cells: [["a\nb", ...texts(1, 9)[0]]],
      expected: tableAt(from.tab, 0),
    };
    expect(refusal(from, call)).toBe(tabCells(call.method, 4_990 + addedTableCells(change)));
    expect(refusal(from, call)).toBe(tabCells("insertTableRows", 5_001));
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
});

// ---------------------------------------------------------------------------
// Approval cards
// ---------------------------------------------------------------------------

/** A row of one-paragraph cells as a card shows it: its block without the last line break. */
const cellLine = (text: string) => `    <td><p>${text}</p></td>`;
const rowHtml = (...cells: string[]) =>
  `  <tr>\n${cells.map(text => `${cellLine(text)}\n`).join("")}  </tr>`;
const html = (label: string, value: string) => cardField(label, value, "html");
const markdownField = (label: string, value: string) => cardField(label, value, "markdown");
const json = (label: string, value: unknown) =>
  ({ label, kind: "json", value: JSON.stringify(value, null, 2) });
const was = (table: number) => ` It was table ${table} of the tab when this change was requested.`;
/** A table of one-paragraph cells as a rendering writes it, without its last line break. */
const tableOf = (...rows: string[][]) =>
  `<table>\n${rows.map(row => rowHtml(...row)).join("\n")}\n</table>`;
/** A card's last field: the lines of the tab the change makes read otherwise. */
const resulting = (value: string) => html("Resulting", value);
const BEFORE = markdownField("Text before the table", "Before");
const FIRST = html("First row of the table", rowHtml("Task", "Status"));

describe("cards", () => {
  const from = read(STATUS());
  const card = (call: TableCall, source = from) => {
    let { title, description } = prepare(source, call);
    return { title, ...description };
  };
  /** What a card says, beside that its description is complete. */
  type Card = { title: string; description: string; fields: unknown[] };

  it.each<[string, TableCall, Card]>([
    ["a new table of empty cells, and the empty paragraph that comes with it",
      addTable({ rows: 2, columns: 2 }), {
        title: "Insert a table in Google Doc",
        description: "Insert a table of 2 rows and 2 columns in tab \"Main\" (tab-1), at the end " +
          "of the tab. Its cells are empty. An empty paragraph is added after it.",
        fields: [resulting(tableOf(["", ""], ["", ""]))],
      }],
    ["a new table with text", addTable({ rows: 1, columns: 1, cells: [["Total"]] }), {
      title: "Insert a table in Google Doc",
      description: "Insert a table of 1 row and 1 column in tab \"Main\" (tab-1), at the end " +
        "of the tab. An empty paragraph is added after it.",
      fields: [json("Cells", [["Total"]]), resulting(tableOf(["Total"]))],
    }],
    ["a new table after a paragraph",
      addTable({ rows: 1, columns: 2, cells: [["a"]], after: "Before\n" }), {
        title: "Insert a table in Google Doc",
        description: "Insert a table of 1 row and 2 columns in tab \"Main\" (tab-1), after the " +
          "paragraph, list item or table that the text below ends in. An empty paragraph is " +
          "added with it: after the new table, or between the two tables when it follows a table.",
        fields: [
          markdownField("After", "Before\n"), json("Cells", [["a", ""]]),
          resulting(tableOf(["a", ""])),
        ],
      }],
    ["a new table of empty cells after a table",
      addTable({ rows: 3, columns: 1, after: "<p>Done</p>" }), {
        title: "Insert a table in Google Doc",
        description: "Insert a table of 3 rows and 1 column in tab \"Main\" (tab-1), after the " +
          "paragraph, list item or table that the text below ends in. Its cells are empty. An " +
          "empty paragraph is added with it: after the new table, or between the two tables " +
          "when it follows a table.",
        fields: [markdownField("After", "<p>Done</p>"), resulting(tableOf([""], [""], [""]))],
      }],
    ["new rows with text, and the row above them", addRows({ table: 0, cells: [["Ship", "Open"]] }), {
      title: "Insert table rows in Google Doc",
      description: `Insert 1 row in a table of tab "Main" (tab-1), after its last row.${was(1)}`,
      fields: [
        json("New rows", [["Ship", "Open"]]),
        BEFORE, FIRST, html("Row above the new rows", rowHtml("Ship docs", "Done")),
        resulting(rowHtml("Ship", "Open")),
      ],
    }],
    ["empty new rows, and the row above them", addRows({ table: 0, at: 2, count: 2 }), {
      title: "Insert table rows in Google Doc",
      description: "Insert 2 rows in a table of tab \"Main\" (tab-1), before its row 3. They " +
        `are empty.${was(1)}`,
      fields: [
        BEFORE, FIRST, html("Row above the new rows", rowHtml("Fix login", "Open")),
        resulting(`${rowHtml("", "")}\n${rowHtml("", "")}`),
      ],
    }],
    // The row above is shown only where the first row, which the card shows anyway, is not it.
    ...[0, 1].map((at): [string, TableCall, Card] => [
      `a new row before row ${at + 1}, without the row above it`, addRows({ table: 0, at }), {
        title: "Insert table rows in Google Doc",
        description: `Insert 1 row in a table of tab "Main" (tab-1), before its row ${at + 1}. ` +
          `They are empty.${was(1)}`,
        fields: [BEFORE, FIRST, resulting(rowHtml("", ""))],
      }]),
    ["new columns with text", addColumns({ table: 0, cells: [["Owner"], ["Ana"]] }), {
      title: "Insert table columns in Google Doc",
      description: "Insert 1 column in a table of tab \"Main\" (tab-1), after its last " +
        `column.${was(1)}`,
      fields: [
        json("New cells, row by row", [["Owner"], ["Ana"], [""]]), BEFORE, FIRST,
        // From the first new cell to the last: the lines between them are shown as they stand.
        resulting([
          cellLine("Owner"), "  </tr>", "  <tr>", cellLine("Fix login"), cellLine("Open"), cellLine("Ana"),
          "  </tr>", "  <tr>", cellLine("Ship docs"), cellLine("Done"), cellLine(""),
        ].join("\n")),
      ],
    }],
    ["empty new columns", addColumns({ table: 0, at: 1, count: 2 }), {
      title: "Insert table columns in Google Doc",
      description: "Insert 2 columns in a table of tab \"Main\" (tab-1), before its column 2. " +
        `They are empty.${was(1)}`,
      fields: [
        BEFORE, FIRST,
        resulting([
          cellLine(""), cellLine(""), cellLine("Status"), "  </tr>", "  <tr>", cellLine("Fix login"), cellLine(""),
          cellLine(""), cellLine("Open"), "  </tr>", "  <tr>", cellLine("Ship docs"), cellLine(""), cellLine(""),
        ].join("\n")),
      ],
    }],
    ["a deleted row, with what it holds", dropRows({ table: 0, at: 1 }), {
      title: "Delete table rows in Google Doc",
      description: "Delete row 2 of a table of tab \"Main\" (tab-1), with everything in " +
        `it.${was(1)}`,
      fields: [html("Deleted rows", rowHtml("Fix login", "Open")), BEFORE, FIRST],
    }],
    ["deleted rows, with what they hold", dropRows({ table: 0, at: 1, count: 2 }), {
      title: "Delete table rows in Google Doc",
      description: "Delete rows 2 to 3 of a table of tab \"Main\" (tab-1), with everything in " +
        `them.${was(1)}`,
      fields: [
        html("Deleted rows", `${rowHtml("Fix login", "Open")}\n${rowHtml("Ship docs", "Done")}`),
        BEFORE, FIRST,
      ],
    }],
    ["a deleted column, with its cells row by row", dropColumns({ table: 0, at: 1 }), {
      title: "Delete table columns in Google Doc",
      description: "Delete column 2 of a table of tab \"Main\" (tab-1), with everything in " +
        `it.${was(1)}`,
      fields: [
        json("Deleted cells, row by row", [
          ["<td><p>Status</p></td>"], ["<td><p>Open</p></td>"], ["<td><p>Done</p></td>"],
        ]),
        BEFORE, FIRST,
      ],
    }],
    ["a deleted table, with its whole HTML", dropTable(0), {
      title: "Delete a table in Google Doc",
      description: `Delete a table of tab "Main" (tab-1), with everything in it.${was(1)}`,
      fields: [html("Table", tableAt(from.tab, 0)), BEFORE],
    }],
    ["the cells it restyles and the style it sets",
      restyle({ table: 0, row: 1, column: 0, rows: 2, style: { borders: { bottom: { width: 2 } } } }), {
        title: "Restyle table cells in Google Doc",
        description: "Set the look of the cells in rows 2 to 3 and column 1 of a table of tab " +
          "\"Main\" (tab-1). A border on the block's outer edge also changes the facing edge of " +
          `the cells beside it.${was(1)}`,
        fields: [
          json("Style", { borders: { bottom: "2pt solid #000000" } }), BEFORE, FIRST,
          resulting("    <td style=\"border-bottom:2pt solid #000000\"><p>Ship docs</p></td>"),
        ],
      }],
    ["a column's width", widths({ table: 0, at: 0, width: 120 }), {
      title: "Set table column widths in Google Doc",
      description: `Make column 1 of a table of tab "Main" (tab-1) 120pt wide.${was(1)}`,
      fields: [BEFORE, FIRST, resulting("  <colgroup><col style=\"width:120pt\"><col></colgroup>")],
    }],
    // Rows as tall as their text read as they did: the card shows no result.
    ["rows' heights", heights({ table: 0, at: 1, count: 2, height: 0 }), {
      title: "Set table row heights in Google Doc",
      description: `Make rows 2 to 3 of a table of tab "Main" (tab-1) as tall as their text.${was(1)}`,
      fields: [BEFORE, FIRST],
    }],
    ["merged cells", merge({ table: 0, row: 1, column: 0, rows: 1, columns: 2 }), {
      title: "Merge table cells in Google Doc",
      description: "Merge the cells in row 2 and columns 1 to 2 of a table of tab \"Main\" " +
        `(tab-1) into one. Their text is joined into the top-left cell, row by row.${was(1)}`,
      fields: [
        BEFORE, FIRST,
        resulting([
          "    <td colspan=\"2\">", "      <p>Fix login</p>", "      <p>Open</p>", "    </td>",
          cellLine(""),
        ].join("\n")),
      ],
    }],
  ])("describes %s", (_name, call, expected) => {
    expect(card(call)).toEqual({ ...expected, descriptionIsComplete: true });
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

  it("says which new rows a pinned header takes in, and which rows it lets go", () => {
    let pinned = (rows: number) => read(buildTab([
      para("Before"), { ...grid(["H1", "H2"], ["a", "b"], ["c", "d"]), headerRows: rows }, para("After")]));
    let lines = (at: number, count: number, header = 1) => card(
      addRows({ table: 0, at, ...(count > 1 ? { count } : {}), cells: [["x", "y"]] }), pinned(header)).description;
    expect(lines(0, 1)).toBe(
      "Insert 1 row in a table of tab \"Main\" (tab-1), before its row 1. The header stays 1 row: " +
      `the new row is pinned and repeats at the top of each page, and 1 row that was in it no longer does.${was(1)}`);
    expect(lines(0, 2)).toContain(
      "The header stays 1 row: the first new row is pinned and repeats at the top of each page, " +
      "and 1 row that was in it no longer does.");
    expect(lines(1, 1, 2)).toContain(
      "The header stays 2 rows: the new row is pinned and repeats at the top of each page, and 1 " +
      "row that was in it no longer does.");
    // Below the header, and after a table whose every row is pinned, the header is as it was.
    expect(lines(1, 1)).not.toContain("header");
    expect(lines(3, 1, 3)).not.toContain("header");
  });

  it("describes deleted columns, with their cells row by row and without indentation", () => {
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

  it("says on a deleted table's card that it holds suggestions, and on no other", () => {
    let suggested = read(buildTab([
      para("Before"),
      { table: [["a\n", "b\n"], ["c\n", "d\n"]], suggestedRows: { 1: "insertion" } },
      para("After"),
    ]));
    expect(card(dropTable(0), suggested).description).toBe(
      "Delete a table of tab \"Main\" (tab-1), with everything in it. It holds suggested " +
      "changes to its rows, columns or cells, or to their text, which are deleted with it. It " +
      "was table 1 of the tab when this change was requested.");
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
    let chipless = read(applyDocEdit(roadmap.doc, change));
    expect(card(dropColumns({ table: 0, at: 1 }), chipless).description).not.toContain("chips");
    expect(card(dropTable(0), chipless).description).not.toContain("chips");

    // What is deleted shows all it holds: a chip the content shows, cells with no chip.
    expect(card(dropRows({ table: 0, at: 3 }), roadmap).description).not.toContain("chips");
    expect(card(dropColumns({ table: 0, at: 0 }), roadmap).description).not.toContain("chips");
    // Nothing is deleted.
    expect(card(addColumns({ table: 0 }), roadmap).description).not.toContain("chips");
    expect(card(addRows({ table: 0, at: 0 }), roadmap).description).not.toContain("chips");
  });

  // A table may come to hold more than its card said and still read the same: the change stores
  // what the card said, and applies only to a table that holds no more of it.
  it("stores what a deletion's card says the content does not show, and holds the table to it", () => {
    let status = (cell: CellSpec = "\n") => read(buildTab([
      para("Before"),
      { table: [["Task\n", "Status\n"], ["Fix login\n", cell], ["Ship docs\n", "Done\n"]] },
      para("After"),
    ]));
    let empty = status();
    let chipped = status(dropdown());
    expect(chipped.tab.markdown).toBe(empty.tab.markdown);

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
      expect(said.change).toMatchObject({ unshown: 1 });
      expect(tableChangeRequests(chipped.tab, said.change)).toHaveLength(1);
    }

    let rows = [["a\n", "b\n"], ["c\n", "d\n"]];
    let plain = read(buildTab([para("Before"), { table: rows }, para("After")]));
    let suggested = read(buildTab(
      [para("Before"), { table: rows, suggestedRows: { 1: "deletion" } }, para("After")]));
    expect(suggested.tab.markdown).toBe(plain.tab.markdown);
    let unsaid = prepare(plain, dropTable(0));
    expect(unsaid.change).not.toHaveProperty("suggested");
    expect(replayRefusal(suggested, unsaid.change)).toBe(
      "deleteTable: this table has come to hold suggested changes to its rows, columns or " +
      "cells, or to their text, since this change was queued.");
    let said = prepare(suggested, dropTable(0));
    expect(said.description.description).toContain("It holds suggested changes");
    expect(said.change).toMatchObject({ suggested: 3 });
    expect(tableChangeRequests(suggested.tab, said.change)).toHaveLength(1);
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
      .toEqual([html("First row of the table", rowHtml("a", "b")), resulting(rowHtml("", ""))]);
    expect(card(dropTable(0), bare).fields).toEqual([html("Table", tableAt(bare.tab, 0))]);
  });

  it("puts the tab's name in prose only as the label it is given", () => {
    let titled = read({ ...from.doc, title: "# **Hot** <b>" });
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

describe("the result a table change's card shows", () => {
  const from = read(STATUS());
  const fieldsOf = (call: TableCall, source = from) => prepare(source, call).description.fields ?? [];
  const labelsOf = (call: TableCall, source = from) => fieldsOf(call, source).map(field => field.label);
  /** The tab with the call's change made in it. */
  const made = (call: TableCall, source = from) =>
    read(applyDocEdit(source.doc, prepare(source, call).change));

  it("shows a new row alone, wherever it is added, as the card's last field", () => {
    for (let at of [0, 1, 2, undefined]) {
      let call = addRows({ table: 0, ...(at === undefined ? {} : { at }), cells: [["New", "Row"]] });
      expect(fieldsOf(call).at(-1)).toEqual(resulting(rowHtml("New", "Row")));
      expect(made(call).tab.markdown).toContain(`${rowHtml("New", "Row")}\n`);
    }
  });

  it("shows a new table as the tab will write it, at the end of the tab and before a table", () => {
    let atEnd = addTable({ rows: 1, columns: 2, cells: [["x", "y"]] });
    expect(fieldsOf(atEnd).at(-1)).toEqual(resulting(tableOf(["x", "y"])));
    expect(tableAt(made(atEnd).tab, 1)).toBe(tableOf(["x", "y"]));
    let inFront = addTable({ rows: 2, columns: 1, cells: [["x"], ["y"]], after: "Before\n" });
    expect(prepare(from, inFront).table).toBe(0);
    expect(fieldsOf(inFront).at(-1)).toEqual(resulting(tableOf(["x"], ["y"])));
    expect(tableAt(made(inFront).tab, 0)).toBe(tableOf(["x"], ["y"]));
  });

  it("shows the lines of the rows a merge down changes", () => {
    let down = { method: "mergeTableCells" as const, cells: { table: 0, row: 1, column: 0, rows: 2, columns: 1 } };
    expect(fieldsOf(down).at(-1)).toEqual(resulting([
      "    <td rowspan=\"2\">", "      <p>Fix login</p>", "      <p>Ship docs</p>", "    </td>",
      cellLine("Open"), "  </tr>", "  <tr>", cellLine(""),
    ].join("\n")));
  });

  it("shows nothing for a row that reads as a row the card already shows", () => {
    // As the row above it, which has a field of its own.
    expect(labelsOf(addRows({ table: 0, at: 2, cells: [["Fix login", "Open"]] }))).toEqual([
      "New rows", "Text before the table", "First row of the table", "Row above the new rows",
    ]);
    // As the first row, below which the first row's field shows the row above.
    expect(labelsOf(addRows({ table: 0, at: 1, cells: [["Task", "Status"]] })))
      .toEqual(["New rows", "Text before the table", "First row of the table"]);
  });

  it("shows the first lines of a result longer than a card holds, and says so", () => {
    let tall = read(buildTab([para("Before"), sized(400, 2), para("After")]));
    let call = addColumns({ table: 0, at: 1 });
    let { description } = prepare(tall, call);
    let shown = description.fields?.at(-1);
    if (shown?.kind !== "text") throw new Error("Expected a text field");
    expect(shown).toMatchObject({ label: "Resulting (first lines)", syntax: "html" });
    expect(shown.truncated).toBeUndefined();
    expect(new TextEncoder().encode(shown.value).length).toBeLessThanOrEqual(8 * 1024);
    // The whole result: every line of the tab that reads otherwise.
    let before = tall.tab.markdown;
    let after = made(call, tall).tab.markdown;
    let span = changedSpan(before, after);
    let whole = after.slice(span.start, span.afterEnd).replace(/^\n+|\n+$/g, "");
    expect(new TextEncoder().encode(whole).length).toBeGreaterThan(8 * 1024);
    expect(whole.startsWith(`${shown.value}\n`)).toBe(true);
    expect(shown.value.split("\n").length).toBeGreaterThan(100);
    // Everything the change sends is on the card.
    expect(description.descriptionIsComplete).toBe(true);
    // A result under the limit is shown whole, under its plain label.
    let short = read(buildTab([para("Before"), sized(40, 2), para("After")]));
    expect(labelsOf(call, short).at(-1)).toBe("Resulting");
  });
});

/**
 * A tab for one call of every kind: text, two empty paragraphs, a table of three rows with a
 * merged cell and a numbered list in a cell, an empty paragraph, a second table that reads
 * otherwise, text.
 */
const EVERY_KIND = () => buildTab([
  para("Intro"), para(""), para(""),
  { table: [
    [{ paragraphs: [para("Plan")], tableCellStyle: { columnSpan: 2 } }, "\n"],
    [cellOf(item("first", "N1"), item("second", "N1")), "Owner\n"],
    ["Review\n", "Ana\n"],
  ] },
  para(""),
  { table: [
    [{ paragraphs: [para("Budget")], tableCellStyle: { columnSpan: 2 } }, "\n", "Year\n"],
    ["Travel\n", "Open\n", "2025\n"],
    ["Venue\n", "Done\n", "2026\n"],
  ] },
  para("After"),
], LISTS);

// The cards the cases above do not reach (a split, a least height, a merge of rows and
// columns), on a table whose first row holds a merged cell, behind another table.
describe("cards on a table with a merged cell, second in its tab", () => {
  const card = (call: TableCall) => {
    let { title, description } = prepare(read(EVERY_KIND()), call);
    return { title, ...description };
  };
  const located = [
    markdownField("Text before the table", "Intro"),
    html("First row of the table", [
      "  <tr>", "    <td colspan=\"2\"><p>Budget</p></td>", cellLine(""), cellLine("Year"), "  </tr>",
    ].join("\n")),
  ];

  it.each<[string, TableCall, string, string, string]>([
    ["unmergeTableCells", split({ table: 1, row: 0, column: 0 }), "Split a table cell in Google Doc",
      "Split the merged cell at row 1, column 1 of a table of tab \"Main\" (tab-1) back into its " +
      "cells. Its text stays in the top-left one.",
      cellLine("Budget")],
    ["setTableRowHeights", heights({ table: 1, at: 1, count: 2, height: 30 }),
      "Set table row heights in Google Doc",
      "Make rows 2 to 3 of a table of tab \"Main\" (tab-1) at least 30pt tall.",
      ["  <tr style=\"height:30pt\">", cellLine("Travel"), cellLine("Open"), cellLine("2025"), "  </tr>",
        "  <tr style=\"height:30pt\">"].join("\n")],
    ["mergeTableCells", merge({ table: 1, row: 1, column: 1, rows: 2, columns: 2 }),
      "Merge table cells in Google Doc",
      "Merge the cells in rows 2 to 3 and columns 2 to 3 of a table of tab \"Main\" (tab-1) into " +
      "one. Their text is joined into the top-left cell, row by row.",
      ["    <td rowspan=\"2\" colspan=\"2\">", "      <p>Open</p>", "      <p>2025</p>", "      <p>Done</p>",
        "      <p>2026</p>", "    </td>", cellLine(""), "  </tr>", "  <tr>", cellLine("Venue"), cellLine(""),
        cellLine("")].join("\n")],
  ])("describes %s", (_name, call, title, description, result) => {
    expect(card(call)).toEqual({
      title, description: `${description}${was(2)}`, fields: [...located, resulting(result)],
      descriptionIsComplete: true,
    });
  });
});

const INTRO = () => buildTab([para("Intro")]);
const BLANK = () => buildTab([para("")]);
/** A tab that ends in a list the bullet preset made. */
const LISTED = () => buildTab([para("Intro"), item("item")], LISTS);
// The number a call, a refusal, a card and a new table speak of is the tab's, though each is
// made from the piece around its table; under runs of one element (`prepare`) every piece but
// the first table's starts after a table.
describe("a table named by its number, in a tab of many runs", () => {
  const cells = (name: string) => [[`${name}1`, `${name}2`], [`${name}3`, `${name}4`]];
  /** Four tables with three paragraphs between each two; the last reads as the first does. */
  const MANY = () => buildTab([
    para("Lead"), para("One"), para("Two"),
    grid(...cells("A")), para("After A"), para("Mid one"), para("Mid two"),
    grid(...cells("B")), para("After B"), para("Mid three"), para("Mid four"),
    grid(...cells("C")), para("After C"), para("Tail one"), para("Tail two"),
    grid(...cells("A")), para("End"),
  ]);
  const prepared = (call: TableCall) => prepare(read(MANY()), call);
  const refused = (call: TableCall) => refusal(read(MANY()), call);
  const prose = (change: PreparedTableChange) => change.description.description;

  it("a card names the number its table has in the tab", () => {
    let third = prepared(addRows({ table: 2, cells: [["x", "y"]] }));
    expect(prose(third)).toContain(" It was table 3 of the tab when this change was requested.");
    expect(third.description.fields)
      .toContainEqual(cardField("Text before the table", "Mid four", "markdown"));
    expect(third.change).toMatchObject({ expected: tableHtml(cells("C")) });

    let second = prepared(dropTable(1));
    expect(prose(second)).toContain(" It was table 2 of the tab when this change was requested.");
    expect(second.description.fields)
      .toContainEqual(cardField("Text before the table", "Mid two", "markdown"));
    expect(second.description.fields).toContainEqual(cardField("Table", tableHtml(cells("B")), "html"));

    for (let call of [
      restyle({ table: 2, row: 0, column: 0, style: { background: "#ffcc00" } }),
      widths({ table: 2, width: 90 }), heights({ table: 2, height: 30 }),
      merge({ table: 2, row: 0, column: 0, rows: 1, columns: 2 }),
      addColumns({ table: 2, cells: [["x"], ["y"]] }), dropRows({ table: 2, at: 1 }),
      dropColumns({ table: 2, at: 0 }),
    ]) {
      expect(prose(prepared(call)), call.method).toContain(" It was table 3 of the tab ");
    }
  });

  it("a number past the tables is refused with the tab's count", () => {
    expect(refused(dropTable(4))).toBe(
      "deleteTable: tab \"tab-1\" has no table 4. It has 4 tables, numbered from 0 in the order " +
      "getContent(\"tab-1\") shows them.");
    expect(refused(addRows({ table: 7 }))).toContain("has no table 7. It has 4 tables");
  });

  it("two tables that read the same are named by their numbers in the tab", () => {
    // The last table reads as the first: the piece around it starts after three tables.
    expect(refused(addRows({ table: 3 }))).toBe(readsTheSame("insertTableRows", 3, 0));
    expect(refused(addRows({ table: 0 }))).toBe(readsTheSame("insertTableRows", 0, 3));
    expect(refused(dropTable(3))).toBe(readsTheSame("deleteTable", 3, 0));
    expect(refused(restyle({ table: 3, row: 0, column: 0, style: { background: "#ffcc00" } })))
      .toBe(readsTheSame("setTableCellStyle", 3, 0));
  });

  it("a new table is given the number it has in the tab", () => {
    /** The place of the table that holds `text` among the tables of the tab the change gives. */
    let numberOf = (change: TableChange, text: string) => {
      let after = renderTab(applyDocEdit(MANY(), change));
      return after.sourceMap.tables.findIndex((_, place) => tableAt(after, place).includes(text));
    };
    let cases: [after: string | undefined, table: number][] = [
      // At the tab's end, after a paragraph between two tables, after the text of a cell,
      // which is after its table, after the tab's first line, and after the last table.
      [undefined, 4], ["Mid three", 2], ["<td><p>B4</p></td>", 2], ["Lead", 0], ["<td><p>C4</p></td>", 3],
    ];
    for (let [after, table] of cases) {
      let made = prepared(addTable({
        rows: 1, columns: 1, cells: [["newly"]], ...(after === undefined ? {} : { after }),
      }));
      expect(made.table, after).toBe(table);
      expect(numberOf(made.change, "newly"), after).toBe(table);
    }
  });
});

describe("a change prepared on a store", () => {
  /** A tab with a merged cell, for the call that splits one. */
  const MERGED = () => applyDocEdit(STATUS(), prepare(
    read(STATUS()), merge({ table: 0, row: 1, column: 0, rows: 1, columns: 2 })).change);
  /** A call on a tab, and the syntax of the result its card shows where it is not `"html"`. */
  const CASES: [string, () => GoogleDocsTab, TableCall, "markdown"?][] = [
    ["insertTable", STATUS, addTable({ rows: 1, columns: 2, cells: [["x", "y"]] })],
    ["insertTable before a table", STATUS,
      addTable({ rows: 1, columns: 1, cells: [["x"]], after: "Before\n" })],
    // The new table reads as the head of the next, so the lines that differ span the two.
    ["insertTable before a table that begins as it does", STATUS,
      addTable({ rows: 1, columns: 2, cells: [["Task", "Status"]], after: "Before\n" }),
      "markdown"],
    ["insertTableRows", STATUS, addRows({ table: 0, cells: [["New", "Row"]] })],
    ["insertTableColumns", STATUS, addColumns({ table: 0 })],
    ["deleteTableRows", STATUS, dropRows({ table: 0, at: 1 })],
    ["deleteTableColumns", STATUS, dropColumns({ table: 0, at: 1 })],
    ["deleteTable", STATUS, dropTable(0)],
    ["setTableCellStyle", STATUS,
      restyle({ table: 0, row: 1, column: 1, style: { background: "#ffcc00" } })],
    ["setTableColumnWidths", STATUS, widths({ table: 0, width: 120 })],
    ["setTableRowHeights", STATUS, heights({ table: 0, height: 30 })],
    ["mergeTableCells", STATUS, merge({ table: 0, row: 1, column: 0, rows: 1, columns: 2 })],
    ["unmergeTableCells", MERGED, split({ table: 0, row: 1, column: 0 })],
  ];
  /** The result a card shows, where it shows one. */
  const resultOf = ({ description }: PreparedTableChange) =>
    description.fields?.find(({ label }) => label.startsWith("Resulting"));

  it("shows the same card for a change found stored as for one just made", () => {
    let shown = { html: 0, markdown: 0 };
    for (let [name, tab, call, spans] of CASES) {
      let syntax: "html" | "markdown" = spans ?? "html";
      let { store, version } = versionOf(tab());
      let made = prepareTableChange(store, version, call, LABEL);
      let before = { ...docStoreCost };
      let found = prepareTableChange(store, version, call, LABEL);
      expect(docStoreCost.resultsStored - before.resultsStored).toBe(0);
      expect(docStoreCost.resultsFound - before.resultsFound).toBe(1);
      // Title, description and every field, with its syntax.
      expect(found).toEqual(made);
      // The syntax follows the source map: HTML for lines of one table, Markdown across two.
      let result = resultOf(found);
      if (result) {
        expect(result, name).toMatchObject({ syntax });
        // Lines of two tables: the end of one and the start of the next.
        if (spans) {
          expect(result, name)
            .toMatchObject({ value: expect.stringMatching(/<\/table>\n+<table>/) });
        }
        shown[syntax]++;
      }
    }
    expect(shown.html).toBeGreaterThan(4);
    expect(shown.markdown).toBe(1);
  });

  // A card reads the stored Markdown of the runs that read otherwise: no tab's Markdown or
  // summary whole, and nothing rendered but the builders' piece and the runs the edit changed.
  it("reads the Markdown of the runs in which the tab reads otherwise, with nothing rendered for it", () => {
    let runsOf = (tab: GoogleDocsTab) =>
      [...cutRuns(tab.body.content, RUN_SIZES)].map(run => runId(run.json));
    let table = addRows({ table: 0, cells: [["New", "Row"]] });
    // Each case with the runs rendered for its builders, on a tab of three runs.
    let cases: [DocEdit, (store: DocStore, version: DocVersion) => unknown, number][] = [
      [{ type: "replaceText", oldMarkdown: "Before", newMarkdown: "Earlier" },
        (store, version) => prepareTextReplacement(
          store, version, "Before", "Earlier", LABEL, googleDocDisplayLimit("replaceText")), 3],
      [{ type: "appendText", markdown: "More" },
        (store, version) => prepareAppend(store, version, "More"), 1 + 2 + 3 + 3],
      [prepare(read(STATUS()), table).change,
        (store, version) => prepareTableChange(store, version, table, LABEL), 1 + 3],
    ];
    for (let [edit, call, builders] of cases) {
      let before = runsOf(STATUS());
      let changed = runsOf(applyDocEdit(STATUS(), edit)).filter(run => !before.includes(run));
      expect([before.length, changed.length]).toEqual([3, 1]);
      let { store, version } = versionOf(STATUS());
      let whole = vi.spyOn(store, "markdown");
      let summary = vi.spyOn(store, "summary");
      let rendered = docStoreCost.runsRendered;
      call(store, version);
      expect(whole).not.toHaveBeenCalled();
      expect(summary).not.toHaveBeenCalled();
      expect(docStoreCost.runsRendered - rendered).toBe(builders + changed.length);
      // Found stored, only the builders' runs are rendered.
      rendered = docStoreCost.runsRendered;
      call(store, version);
      expect(whole).not.toHaveBeenCalled();
      expect(docStoreCost.runsRendered - rendered).toBe(builders);
    }
  });
});

/** What an append of `markdown` to `tab` adds, as a read will return it. */
function appendTo(tab: GoogleDocsTab, markdown: string): string {
  return onBoth(tab, (store, version) => prepareAppend(store, version, markdown));
}
/** What the card shows of an append, and the tab's rendering it was cut from. */
const appended = (tab: GoogleDocsTab, markdown: string) => ({
  shown: appendTo(tab, markdown),
  after: renderTab(applyDocEdit(tab, { type: "appendText", markdown })).markdown,
});

describe("an append prepared", () => {

  it("shows plain text as typed, on a tab with text and on a blank one", () => {
    expect(renderTab(BLANK()).markdown).toBe("\n");
    expect(appended(INTRO(), "plain")).toEqual({ shown: "plain", after: "Intro\n\nplain\n" });
    expect(appended(BLANK(), "plain")).toEqual({ shown: "plain", after: "plain\n" });
  });

  it("shows a numbered list as it will read, each item that continues its level as 1.", () => {
    expect(appended(INTRO(), "1. a\n2. b"))
      .toEqual({ shown: "1. a\n1. b", after: "Intro\n\n1. a\n1. b\n" });
  });

  it("shows the empty paragraphs an append writes after its text", () => {
    expect(appended(INTRO(), "a\n\nb\n\n"))
      .toEqual({ shown: "a\n\nb\n\n", after: "Intro\n\na\n\nb\n\n\n" });
    expect(appended(BLANK(), "a\n\nb\n\n"))
      .toEqual({ shown: "a\n\nb\n\n", after: "a\n\nb\n\n\n" });
  });

  it("shows the empty paragraph an append writes before its text", () => {
    expect(appended(INTRO(), "\nplain"))
      .toEqual({ shown: "\n\nplain", after: "Intro\n\n\n\nplain\n" });
    // The blank tab's one line break cannot be told from those the append writes.
    expect(appended(BLANK(), "\nplain")).toEqual({ shown: "\n\nplain", after: "\n\nplain\n" });
  });

  it("shows items that continue the tab's last list with nothing dropped at their start", () => {
    expect(appended(LISTED(), "- x\n- y"))
      .toEqual({ shown: "- x\n- y", after: "Intro\n\n- item\n- x\n- y\n" });
  });

  it("shows what stands at the tab's end where the append ends as the tab's last line reads", () => {
    // The tab's last line and the nested item read the same one line earlier: not the append's.
    expect(appended(LISTED(), "  - nested\n- item")).toEqual({
      shown: "  - nested\n- item", after: "Intro\n\n- item\n  - nested\n- item\n",
    });
  });

  it("leaves out a final line break that writes nothing", () => {
    expect(appended(INTRO(), "plain\n")).toEqual({ shown: "plain", after: "Intro\n\nplain\n" });
  });

  it("refuses an append to a tab that does not end in a paragraph", () => {
    // `buildTab` ends a tab where its last block ends; Google ends one with a paragraph.
    let tab = buildTab([para("Intro"), grid(["a", "b"])]);
    expect(thrownMessage(() => appendTo(tab, "plain"))).toBe(
      "appendText: the selected tab does not end in a paragraph. Add a paragraph after its " +
      "final table or structural element and retry.");
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
    let oldMarkdown = "<td><p>small</p></td>";
    let prepared = replace(from, oldMarkdown, "<td><p>changed</p></td>");
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
    expect(thrownMessage(() => assertTableQueueRoom(
      recorded, { type: "deleteTable", expected: `${table}x` }))).toBe(TOO_MUCH("deleteTable"));
    expect(thrownMessage(() => assertTableQueueRoom(
      [...recorded, { type: "deleteTableRows", expected: "x" }],
      { type: "insertTableRows", at: 0, cells: [[""]], expected: table })))
      .toBe(TOO_MUCH("insertTableRows"));
    expect(thrownMessage(() => assertTableQueueRoom(
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

/** Prepare a replacement of text that occurs once in the tab. */
function replace({ doc }: Read, oldMarkdown: string, newMarkdown: string) {
  return onBoth(doc, (store, version) =>
    prepareTextReplacement(
      store, version, oldMarkdown, newMarkdown, LABEL, googleDocDisplayLimit("replaceText")));
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
    // The bold run joins the one after it, so what differs reaches past the text named: the
    // card shows the cell's line from there to its end.
    expect(replace(grouped, "Hello ", "<strong>Hello </strong>")).toEqual({
      inTable: true, prose: TABLE_PROSE, syntax: "html",
      shown: {
        old: "Hello <strong>World</strong></p></td>",
        requested: "<strong>Hello </strong><strong>World</strong></p></td>",
        rendered: "<strong>Hello World</strong></p></td>",
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

  it("refuses text that starts with `<`, added above a table, as a change to the table's tags", () => {
    // The text shares its first character with the table, so the table path decides.
    expect(thrownMessage(() => replace(from, "<table>", "<TODO: describe the figures>\n\n<table>")))
      .toBe(STRUCTURE);
    expect(STRUCTURE).not.toBe(besideTableRefusal("before").message);
    // Written against the paragraph before the table, it is a paragraph of its own.
    expect(replace(from, "Before", "Before\n\n<TODO: describe the figures>")).toEqual({
      inTable: false, prose: PARAGRAPH_PROSE, syntax: "markdown",
      shown: {
        old: "Before", requested: "Before\n\n<TODO: describe the figures>",
        rendered: "Before\n\n<TODO: describe the figures>",
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

  it("passes on the refusal of a replacement that reaches a table from outside", () => {
    expect(thrownMessage(() => replace(from, "<table>", "Intro <table>")))
      .toBe(besideTableRefusal("before").message);
  });

  it("refuses to end a list item's section in front of a table, in the paragraph path's words", () => {
    // Without `B` the list item ends its section in front of the table, which cannot be built.
    let listed = read(buildTab(
      [para("Intro"), item("Item"), para("B"), grid(["Open", "b"]), para("After")], LISTS));
    expect(thrownMessage(() => replace(listed, "\n\nB", ""))).toBe(
      "replaceText: cannot keep a list item while deleting the paragraphs that end its " +
      "section. Delete them in an edit that leaves the list item alone.");
  });

  it("refuses a replacement in table cells too large for one batch", () => {
    let empty = read(buildTab([para("Before"), grid(["a", ""]), para("After")]));
    expect(thrownMessage(() => replace(
      empty, "<td><p></p></td>", striped(MAX_TABLE_TEXT_REQUESTS - 1)))).toBe(TOO_MANY_REQUESTS);
    expect(replace(empty, "<td><p></p></td>", striped(MAX_TABLE_TEXT_REQUESTS - 2)).inTable)
      .toBe(true);
  });
});

describe("setTableCellStyle", () => {
  it("is a table change a user may let apply without asking", () => {
    let prepared = prepare(read(STATUS()), restyle({ table: 0, row: 0, column: 0, style: { background: "#FFCC00" } }));
    expect(prepared.actionKind).toBe(DOCUMENT_TABLES);
    expect(prepared.autoApprovable).toBe(true);
    expect(prepared.change).toEqual({
      type: "setTableCellStyle", row: 0, column: 0, rows: 1, columns: 1,
      style: { background: "#ffcc00" }, expected: tableAt(read(STATUS()).tab, 0),
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
});

describe("setTableColumnWidths and setTableRowHeights", () => {
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
});

describe("mergeTableCells and unmergeTableCells", () => {
  it("merges and splits as table changes a user may let apply without asking", () => {
    let from = read(STATUS());
    let merged = prepare(from, merge({ table: 0, row: 1, column: 0, rows: 1, columns: 2 }));
    expect(merged).toMatchObject({
      actionKind: DOCUMENT_TABLES, autoApprovable: true, title: "Merge table cells in Google Doc",
      change: { type: "mergeTableCells", row: 1, column: 0, rows: 1, columns: 2 },
    });
    let after = read(applyDocEdit(from.doc, merged.change));
    let split_ = prepare(after, split({ table: 0, row: 1, column: 0 }));
    expect(split_).toMatchObject({ autoApprovable: true, title: "Split a table cell in Google Doc" });
  });

  it("counts a merge's cells that hold anything, past the first, against the tab's cells", () => {
    // 4,990 cells. A merge of 2 by 5 moves the paragraphs of the nine cells it covers into its
    // top-left cell and leaves each of them one empty paragraph: 4,999.
    let from = read(buildTab([para("Before"), sized(499, 10), para("After")]));
    expect(refusal(from, merge({ table: 0, row: 0, column: 0, rows: 2, columns: 6 })))
      .toBe(tabCells("mergeTableCells", 5_001));
    let merged = prepare(from, merge({ table: 0, row: 0, column: 0, rows: 2, columns: 5 }));
    // The tab read back after it holds what the check counted.
    let after = read(applyDocEdit(from.doc, merged.change));
    expect(refusal(after, addRows({ table: 0, at: 499 }))).toBe(tabCells("insertTableRows", 5_009));

    // At 5,000, blank cells merge around a label, which adds nothing; a second label adds one.
    let full = read(buildTab([para("Before"), sized(499, 10), para("Between"),
      grid(["Label", ""], ["", ""], ["Other", ""], ["", "Text"], ["x", "y"]), para("After")]));
    let blank = prepare(full, merge({ table: 1, row: 0, column: 0, rows: 2, columns: 2 }));
    let around = read(applyDocEdit(full.doc, blank.change));
    expect(refusal(around, addRows({ table: 0, at: 499 }))).toBe(tabCells("insertTableRows", 5_010));
    expect(refusal(full, merge({ table: 1, row: 2, column: 0, rows: 2, columns: 2 })))
      .toBe(tabCells("mergeTableCells", 5_001));
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

/** A tab of `blocks` whose named styles are `styles`. */
const styled = (blocks: Parameters<typeof buildTab>[0], styles: NamedStyles["styles"]): GoogleDocsTab =>
  ({ ...buildTab(blocks), namedStyles: { styles } });

describe("a replacement in a paragraph its named style formats", () => {
  it("shows as it will read bold written where the style already gives it", () => {
    // Bold written into a subtitle bold by its style writes nothing a read shows; the card says so.
    let source = read(styled(
      [para("Other text"), { runs: ["Notes here\n"], namedStyleType: "SUBTITLE" }, para("After")], [
        { namedStyleType: "NORMAL_TEXT", textStyle: { bold: false } },
        { namedStyleType: "SUBTITLE", textStyle: { bold: true } },
      ]));
    let { shown } = replace(source, "Notes here", "**Notes here**");
    expect(shown).toEqual(
      { old: "Notes here", requested: "**Notes here**", rendered: "Notes here" });
    let made = applyDocEdit(
      source.doc, { type: "replaceText", oldMarkdown: "Notes here", newMarkdown: "**Notes here**" });
    expect(renderTab(made).markdown).toBe(source.tab.markdown);
  });

  it("is prepared for a break that splits off text normal text's style also gives", () => {
    // Bold of its own in a heading, where normal text is bold by its style: the rest of the
    // heading becomes normal text and reads without the markers.
    let bolded = read(styled([para("Before"), {
      runs: ["Notes ", { text: "here", style: { bold: true } }, "\n"], namedStyleType: "HEADING_2",
    }, para("After")], [
      { namedStyleType: "NORMAL_TEXT", textStyle: { bold: true } },
      { namedStyleType: "HEADING_2", textStyle: { bold: false } },
    ]));
    let { shown } = replace(bolded, "Notes", "End\n\n");
    expect(shown).toEqual(
      { old: "Notes **here**", requested: "End\n\n **here**", rendered: "End\n\n here" });
    expect(shown.requested).not.toBe(shown.rendered);
    expect(renderTab(applyDocEdit(
      bolded.doc, { type: "replaceText", oldMarkdown: "Notes", newMarkdown: "End\n\n" })).markdown)
      .toBe("Before\n\n## End\n\n here\n\nAfter\n");
  });
});
