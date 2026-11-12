import { describe, expect, it } from "vitest";
import type {
  GoogleDocsRequest, GoogleDocsTab, Paragraph, StructuralElement, TableCell, TextStyle,
} from "../src/docs-api";
import {
  addedTableCells, applyNewTable, applyTableChange, applyTextReplacement, changesTables,
  checkTabTableCells, checkTableTarget, classifyReplacement, hiddenContent, MAX_TAB_TABLE_CELLS,
  MAX_TABLE_TEXT_REQUESTS, namesTable, parseCellInline, replaceTableText, resolveTable,
  runParagraphReplacement, tableChangeRequests, tableHtml, tableIdentity, tableLines,
  TableReplayGate, tableShape, tableSize, tableTextRequests, textReplacementRequests,
} from "../src/docs-tables";
import type {
  ReplacementPlace, TableChange, TableChangeShape, TableDeletionShape, TableRef, TextReplacement,
} from "../src/docs-tables";
import {
  applyMarkdownEdit, canonicalizeMarkdownAppend, canonicalizeMarkdownForWrite,
  canonicalizeMarkdownReplacement, computeReplaceOperations, docTabToMarkdown,
  markdownToDocRequests, StructuredContentError, tableRowCells,
} from "../src/markdown-converter";
import type { DocTabSnapshot, EditableMarkdown, EditableTable } from "../src/markdown-converter";
import { BULLET_LIST, buildTab } from "./doc-fixture";
import {
  alignmentAt, applyDocsRequests, fontSizeAt, hasLinkLook, indentedParagraphs, LINK_COLOR,
  pinnedHeaderRows,
} from "./docs-body-model";
import type { ModelParagraphStyle, ModelTextStyle } from "./docs-body-model";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type BlockSpec = Parameters<typeof buildTab>[0][number];
type ParagraphSpec = Extract<BlockSpec, { runs: unknown }>;
type TableSpec = Extract<BlockSpec, { table: unknown }>;
type CellSpec = TableSpec["table"][number][number];
type Lists = GoogleDocsTab["lists"];

const TAB = "tab-1";
const FOUR_FIELDS = "bold,italic,strikethrough,link";
const SIX_FIELDS = `${FOUR_FIELDS},underline,foregroundColor`;

/** Both of Google's behaviours, where two are on record, for each of the model's two options. */
const MODELS = [false, true].flatMap(copyStyles =>
  [false, true].map(unlinkRestyles => ({ copyStyles, unlinkRestyles })));

const NUMBERED_LIST: Lists = {
  N1: { listProperties: { nestingLevels: [{ glyphType: "DECIMAL" }] } },
};
/** A list whose one level has no marker: its items read as plain lines. */
const QUIET_LIST: Lists = {
  Q1: { listProperties: { nestingLevels: [{ glyphType: "NONE" }] } },
};
const ALL_LISTS: Lists = {
  ...BULLET_LIST,
  ...NUMBERED_LIST,
  ...QUIET_LIST,
  L2: { listProperties: { nestingLevels: [{ glyphSymbol: "\u25cf" }] } },
  // A bulleted level above a numbered one.
  MIX: { listProperties: { nestingLevels: [{ glyphSymbol: "\u25cf" }, { glyphType: "DECIMAL" }] } },
  DEEP: {
    listProperties: { nestingLevels: [{ glyphSymbol: "\u25cf" }, { glyphSymbol: "\u25cb" }] },
  },
};

const para = (text: string): ParagraphSpec => ({ runs: [`${text}\n`] });
const heading = (text: string, level = 2): ParagraphSpec =>
  ({ runs: [`${text}\n`], namedStyleType: `HEADING_${level}` });
const item = (text: string, listId = "L1", nestingLevel?: number): ParagraphSpec =>
  ({ runs: [`${text}\n`], bullet: { listId, ...(nestingLevel ? { nestingLevel } : {}) } });
const person = (name?: string) => ({ person: { ...(name ? { name } : {}), email: "" } });
/** A paragraph that holds a person chip after its text, which makes it read-only. */
const chip = (text = "Owner: ", name = "Ana"): ParagraphSpec =>
  ({ runs: [text, person(name), "\n"] });
/** A paragraph whose only content is a chip that renders as nothing. */
const quietChip = (text = ""): ParagraphSpec => ({ runs: [text, person(), "\n"] });
const dateChip = (): ParagraphSpec => ({ runs: ["Due ", { date: "Nov 8, 2026" }, "\n"] });
const toc: BlockSpec = { structure: "tableOfContents" };
const grid = (...rows: string[][]): TableSpec =>
  ({ table: rows.map(row => row.map(text => `${text}\n`)) });
/** A cell holding these paragraphs. */
const cellOf = (...paragraphs: (ParagraphSpec | TableSpec)[]): CellSpec => ({ paragraphs });

function contentOf(snapshot: DocTabSnapshot): EditableMarkdown {
  return {
    markdown: snapshot.markdown,
    protectedRanges: snapshot.sourceMap.protectedRanges,
    tables: snapshot.sourceMap.tables,
  };
}

const read = (tab: GoogleDocsTab): EditableMarkdown => contentOf(docTabToMarkdown(tab));

const tableAt = (content: EditableMarkdown, table: number): string =>
  content.markdown.slice(content.tables[table].mdStart, content.tables[table].mdEnd);

/** Tables as a replay knows them: where their HTML is, their cells' texts and flags. */
function editableTables(tables: readonly EditableTable[]): EditableTable[] {
  return tables.map(({ mdStart, mdEnd, rows, suggested }) =>
    ({ mdStart, mdEnd, rows, ...(suggested ? { suggested } : {}) }));
}

/** The reference a queued change records of the table at `table`. */
const refOf = (content: EditableMarkdown, table: number): TableRef =>
  ({ expected: tableIdentity(tableAt(content, table)) });

const addRows = (
  content: EditableMarkdown, table: number, at: number, cells: string[][],
): TableChange => ({ type: "insertTableRows", at, cells, ...refOf(content, table) });
const addColumns = (
  content: EditableMarkdown, table: number, at: number, cells: string[][],
): TableChange => ({ type: "insertTableColumns", at, cells, ...refOf(content, table) });
/** A deletion as it is queued: with what it removes that the content does not show. */
const queuedDeletion = (
  content: EditableMarkdown, table: number, shape: TableDeletionShape,
): TableChange => ({ ...shape, ...refOf(content, table), ...hiddenContent(content, table, shape) });
const dropRows = (
  content: EditableMarkdown, table: number, at: number, count = 1,
): TableChange => queuedDeletion(content, table, { type: "deleteTableRows", at, count });
const dropColumns = (
  content: EditableMarkdown, table: number, at: number, count = 1,
): TableChange => queuedDeletion(content, table, { type: "deleteTableColumns", at, count });
const dropTable = (content: EditableMarkdown, table: number): TableChange =>
  queuedDeletion(content, table, { type: "deleteTable" });
/** A new table of these cells: `rows` × `columns`, every cell present. */
const newTable = (cells: string[][], after?: string): TableChange => ({
  type: "insertTable", rows: cells.length, columns: cells[0].length, cells,
  ...(after === undefined ? {} : { after }),
});

/** The shape of a stored change to an existing table, as the engine derives it. */
function shapeOf(change: TableChange): TableChangeShape {
  switch (change.type) {
    case "insertTable": throw new Error("insertTable names no table");
    case "setTableCellStyle":
    case "setTableColumnWidths":
    case "setTableRowHeights":
    case "mergeTableCells":
    case "unmergeTableCells":
      throw new Error(`${change.type} adds or deletes no rows or columns`);
    case "deleteTable": return { type: change.type };
    case "insertTableRows": return { type: change.type, at: change.at, count: change.cells.length };
    case "insertTableColumns":
      return { type: change.type, at: change.at, count: change.cells[0].length };
    default: return { type: change.type, at: change.at, count: change.count };
  }
}

function expectRendering(simulated: EditableMarkdown, tab: GoogleDocsTab): void {
  let after = docTabToMarkdown(tab);
  expect(simulated.markdown).toBe(after.markdown);
  expect(simulated.protectedRanges).toEqual(after.sourceMap.protectedRanges);
  expect(editableTables(simulated.tables)).toEqual(editableTables(after.sourceMap.tables));
}

/**
 * Simulation equals application: the change replayed over the tab's rendering reads exactly as
 * the document does once Google has applied the change's requests, under each of the model's
 * behaviours. Returns the document the model leaves.
 */
function expectSameAsGoogle(tab: GoogleDocsTab, change: TableChange): GoogleDocsTab {
  let before = docTabToMarkdown(tab);
  let simulated = applyTableChange(contentOf(before), change, before);
  let requests = tableChangeRequests(before, change);
  let pinned = change.type === "insertTableRows"
    ? before.sourceMap.tables[resolveTable(contentOf(before), change, change.type)] : undefined;
  let applied = tab;
  for (let options of MODELS) {
    applied = applyDocsRequests(tab, requests, options);
    expectRendering(simulated, applied);
    // No fixture holds an indented paragraph, so one found here was left by a fill.
    expect(indentedParagraphs(applied)).toEqual([]);
    if (pinned) {
      expect(pinnedHeaderRows(applied, pinned.docStart))
        .toBe(pinnedHeaderRows(tab, pinned.docStart));
    }
  }
  return applied;
}

/** The same for the view form, which replays without the tab the content came from. */
function expectViewSameAsGoogle(tab: GoogleDocsTab, change: TableChange): EditableMarkdown {
  let before = docTabToMarkdown(tab);
  let simulated = applyTableChange(contentOf(before), change);
  let requests = tableChangeRequests(before, change);
  for (let options of MODELS) expectRendering(simulated, applyDocsRequests(tab, requests, options));
  return simulated;
}

/** A stored replacement of text that occurs once in the tab. */
function replacementIn(
  markdown: string, oldMarkdown: string, newMarkdown: string, matchStart?: number,
): TextReplacement {
  let found = matchStart ?? markdown.indexOf(oldMarkdown);
  if (found < 0 || matchStart === undefined && markdown.indexOf(oldMarkdown, found + 1) >= 0) {
    throw new Error(`Expected ${JSON.stringify(oldMarkdown)} exactly once`);
  }
  return { matchStart: found, oldMarkdown, newMarkdown };
}

/** The property for a replacement in table cells. Returns the document the model leaves. */
function expectCellTextSameAsGoogle(
  tab: GoogleDocsTab, oldMarkdown: string, newMarkdown: string,
): { applied: GoogleDocsTab; requests: GoogleDocsRequest[]; simulated: EditableMarkdown } {
  let before = docTabToMarkdown(tab);
  let { matchStart } = replacementIn(before.markdown, oldMarkdown, newMarkdown);
  let replayed = replaceTableText(contentOf(before), matchStart, oldMarkdown, newMarkdown, TAB);
  let requests = tableTextRequests(before, matchStart, oldMarkdown, newMarkdown);
  if (!replayed || !requests) throw new Error("Expected a replacement in table cells");
  let applied = tab;
  for (let options of MODELS) {
    applied = requests.length > 0 ? applyDocsRequests(tab, requests, options) : tab;
    expectRendering(replayed.content, applied);
  }
  return { applied, requests, simulated: replayed.content };
}

/** The property for a stored replacement that is not one in table cells. */
function expectParagraphTextSameAsGoogle(
  tab: GoogleDocsTab, oldMarkdown: string, newMarkdown: string, matchStart?: number,
): EditableMarkdown {
  let before = docTabToMarkdown(tab);
  let replacement = replacementIn(before.markdown, oldMarkdown, newMarkdown, matchStart);
  let simulated = applyTextReplacement(contentOf(before), replacement, TAB);
  let requests = textReplacementRequests(before, replacement);
  for (let options of MODELS) {
    let applied = requests.length > 0 ? applyDocsRequests(tab, requests, options) : tab;
    expect(simulated.markdown).toBe(docTabToMarkdown(applied).markdown);
  }
  return simulated;
}

function message(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) return error.message;
    throw error;
  }
  throw new Error("Expected a refusal");
}

/** What the replay and the request builder each refuse a change with, which must agree. */
function refusal(tab: GoogleDocsTab, change: TableChange): string {
  let before = docTabToMarkdown(tab);
  let replayed = message(() => applyTableChange(contentOf(before), change, before));
  expect(message(() => tableChangeRequests(before, change))).toBe(replayed);
  return replayed;
}

function bodyElements(tab: GoogleDocsTab, kind: "paragraph" | "table"): StructuralElement[] {
  return tab.body.content.filter(element => element[kind] !== undefined);
}

function tableElement(tab: GoogleDocsTab, table = 0): StructuralElement {
  let element = bodyElements(tab, "table")[table];
  if (!element) throw new Error("Expected a table");
  return element;
}

function cellAt(tab: GoogleDocsTab, row: number, column: number, table = 0): TableCell {
  let cell = tableElement(tab, table).table?.tableRows?.[row]?.tableCells?.[column];
  if (!cell) throw new Error("Expected a cell");
  return cell;
}

/** The start index of a cell's paragraph, and the paragraph. */
function cellParagraph(
  tab: GoogleDocsTab, row: number, column: number, table = 0, index = 0,
): { start: number; paragraph: Paragraph } {
  let element = cellAt(tab, row, column, table).content?.[index];
  if (!element?.paragraph) throw new Error("Expected a paragraph");
  return { start: element.startIndex, paragraph: element.paragraph };
}

function bodyParagraph(tab: GoogleDocsTab, index: number): Paragraph {
  let paragraph = bodyElements(tab, "paragraph")[index]?.paragraph;
  if (!paragraph) throw new Error("Expected a paragraph");
  return paragraph;
}

const cellText = (tab: GoogleDocsTab, row: number, column: number, table = 0): string =>
  (cellAt(tab, row, column, table).content ?? []).map(element =>
    (element.paragraph?.elements ?? []).map(part => part.textRun?.content ?? "").join("")).join("");

const tableTexts = (tab: GoogleDocsTab, table = 0): string[][] =>
  (tableElement(tab, table).table?.tableRows ?? []).map((row, rowIndex) =>
    (row.tableCells ?? []).map((_, column) => cellText(tab, rowIndex, column, table)));

const BASIC = () => buildTab(
  [para("Before"), grid(["r0c0", "r0c1"], ["r1c0", "r1c1"]), para("After")]);

/** What the fill of a new cell sends: its requests' kinds, in order. */
const kinds = (requests: readonly GoogleDocsRequest[]): string[] =>
  requests.map(request => Object.keys(request)[0]);

// ---------------------------------------------------------------------------
// Lines and templates
// ---------------------------------------------------------------------------

describe("tableLines", () => {
  it("returns each row and cell as a block of whole lines, with spans and nested tables", () => {
    let tab = buildTab([
      para("Before"),
      {
        table: [
          ["a\n", { paragraphs: [para("head")], tableCellStyle: { rowSpan: 2, columnSpan: 2 } }, "\n"],
          [cellOf(para("one"), para("two")), "\n", cellOf(para("x"), grid(["in"]), para("y"))],
        ],
      },
      para("After"),
    ]);
    let content = read(tab);
    let { rows } = tableLines(content.markdown, content.tables[0]);
    let block = (range: { mdStart: number; mdEnd: number }) =>
      content.markdown.slice(range.mdStart, range.mdEnd);

    expect(rows.map(row => row.cells.length)).toEqual([3, 3]);
    expect(block(rows[0])).toBe(
      "  <tr>\n    <td><p>a</p></td>\n    <td rowspan=\"2\" colspan=\"2\"><p>head</p></td>\n" +
      "    <td><p></p></td>\n  </tr>\n");
    expect(block(rows[0].cells[1])).toBe("    <td rowspan=\"2\" colspan=\"2\"><p>head</p></td>\n");
    expect(rows[0].cells.map(({ rowSpan, columnSpan }) => [rowSpan, columnSpan]))
      .toEqual([[1, 1], [2, 2], [1, 1]]);
    expect(block(rows[1].cells[0]))
      .toBe("    <td>\n      <p>one</p>\n      <p>two</p>\n    </td>\n");
    expect(rows[1].cells.map(cell => cell.nested)).toEqual([false, false, true]);
    expect(block(rows[1].cells[2]).startsWith("    <td>\n      <p>x</p>\n      <table>\n"))
      .toBe(true);
    expect(block(rows[1].cells[2]).endsWith("      <p>y</p>\n    </td>\n")).toBe(true);
    expect(rows[1].mdEnd).toBe(content.tables[0].mdEnd - "</table>".length);
  });

  it("returns rows of different lengths as they are", () => {
    let content = read(buildTab([para("A"), { table: [["a\n", "b\n"], ["c\n"]] }, para("B")]));
    expect(tableLines(content.markdown, content.tables[0]).rows.map(row => row.cells.length))
      .toEqual([2, 1]);
  });

  it("throws on HTML that is not laid out as a table is", () => {
    for (let html of [
      "<table>", "<table>\n</table>\nx", "<table>\n  <tr>\n</table>",
      "<table>\n  <tr>\n    <td><p>a</p></td>\n</table>",
      "<table>\n  <tr>\n  <td><p>a</p></td>\n  </tr>\n</table>",
      "<table>\n  <tr>\n    <td><p>a</p>\n  </tr>\n</table>",
      "<table>\n  <tr>\n    <td>\n    <p>a</p>\n    </td>\n  </tr>\n</table>",
      "<table>\n  <tr>\n    <td>\n      <p>a</p>\n  </tr>\n</table>",
      "<table>\n    <td><p>a</p></td>\n</table>",
    ]) {
      expect(() => tableLines(html, { mdStart: 0, mdEnd: html.length }), html).toThrow();
    }
  });
});

describe("tableSize", () => {
  it("returns the rows and columns of a rendered table", () => {
    let content = read(BASIC());
    expect(tableSize(content.markdown, content.tables[0], "insertTableRows"))
      .toEqual({ rows: 2, columns: 2 });
  });

  it("refuses a table that is not laid out as one, or has no row, with the method's name", () => {
    for (let html of [
      "<table>\n  <tr>\n</table>", "<table>\n</table>", "<table>\n  <tr>\n  </tr>\n</table>",
    ]) {
      expect(message(() => tableSize(html, { mdStart: 0, mdEnd: html.length }, "deleteTableRows")))
        .toBe("deleteTableRows: this table is not laid out as Google Docs lays tables out, so " +
          "it cannot be changed.");
    }
  });

  it("refuses rows of different lengths with the method's name", () => {
    let content = read(buildTab([para("A"), { table: [["a\n", "b\n"], ["c\n"]] }, para("B")]));
    expect(message(() => tableSize(content.markdown, content.tables[0], "insertTableColumns")))
      .toBe("insertTableColumns: the rows of this table do not all have the same number of " +
        "cells, so its rows and columns cannot be changed.");
  });
});

describe("tableHtml", () => {
  it("writes plain cells as the renderer writes them", () => {
    let cells: [string, CellSpec][] = [
      ["plain", "plain\n"],
      ["", "\n"],
      ["a & b < c > d", "a & b < c > d\n"],
      ["line\u000bbreak", "line\u000bbreak\n"],
      ["one\ntwo\n\nfour", cellOf(para("one"), para("two"), para(""), para("four"))],
      ["\n", cellOf(para(""), para(""))],
    ];
    let content = read(buildTab([
      para("A"), { table: cells.map(([, cell]) => [cell, "x\n"]) }, para("B"),
    ]));
    expect(tableHtml(cells.map(([text]) => [text, "x"]))).toBe(tableAt(content, 0));
  });
});

// ---------------------------------------------------------------------------
// Rows and columns
// ---------------------------------------------------------------------------

/** A table whose rows hold a heading, list items, bold text and several paragraphs. */
const STYLED = () => buildTab([
  para("Before"),
  {
    table: [
      [cellOf(heading("Head")), cellOf(item("one"), item("deep", "DEEP", 1))],
      [cellOf({ runs: [{ text: "bold", style: { bold: true } }, "\n"] }), cellOf(para("a"), para("b"))],
      ["plain\n", cellOf(item("n1", "N1"))],
    ],
  },
  para("After"),
], ALL_LISTS);

describe("rows", () => {
  it("adds rows at the top, in the middle and at the end, empty and filled", () => {
    for (let at of [0, 1, 2]) {
      for (let cells of [[["", ""]], [["x", "y\nz"]], [["a", ""], ["", "b"], ["c\n\nd", "e"]]]) {
        let applied = expectSameAsGoogle(BASIC(), addRows(read(BASIC()), 0, at, cells));
        expect(tableTexts(applied).length).toBe(2 + cells.length);
        expectViewSameAsGoogle(BASIC(), addRows(read(BASIC()), 0, at, cells));
      }
    }
  });

  it("reads new rows as plain beside headings, list items and bold text", () => {
    for (let at of [0, 1, 2, 3]) {
      for (let cells of [[["", ""]], [["x", "y"]], [["x", ""], ["", "y\nz"]]]) {
        expectSameAsGoogle(STYLED(), addRows(read(STYLED()), 0, at, cells));
      }
    }
  });

  it("deletes rows at the top, in the middle and at the end, one and several", () => {
    let tab = buildTab([
      para("Before"), grid(["a", "b"], ["c", "d"], ["e", "f"], ["g", "h"]), para("After"),
    ]);
    for (let [at, count] of [[0, 1], [1, 1], [3, 1], [0, 3], [1, 2], [2, 2]]) {
      let applied = expectSameAsGoogle(tab, dropRows(read(tab), 0, at, count));
      expect(tableTexts(applied).length).toBe(4 - count);
      expectViewSameAsGoogle(tab, dropRows(read(tab), 0, at, count));
    }
  });

  it("leaves a cell empty whose text the stored cells lack", () => {
    let applied = expectSameAsGoogle(BASIC(), addRows(read(BASIC()), 0, 1, [["only"]]));
    expect(tableTexts(applied)[1]).toEqual(["only\n", "\n"]);
  });
});

describe("columns", () => {
  it("adds columns at the start, in the middle and at the end, empty and filled", () => {
    for (let at of [0, 1, 2]) {
      for (let cells of [[[""], [""]], [["x"], ["y\nz"]], [["a", ""], ["", "b"]]]) {
        let applied = expectSameAsGoogle(BASIC(), addColumns(read(BASIC()), 0, at, cells));
        expect(tableTexts(applied)[0].length).toBe(2 + cells[0].length);
        expectViewSameAsGoogle(BASIC(), addColumns(read(BASIC()), 0, at, cells));
      }
    }
  });

  it("reads new columns as plain beside headings, list items and bold text", () => {
    for (let at of [0, 1, 2]) {
      for (let cells of [[[""], [""], [""]], [["x"], ["y\nz"], [""]]]) {
        expectSameAsGoogle(STYLED(), addColumns(read(STYLED()), 0, at, cells));
      }
    }
  });

  it("adds a column at the end of a table whose rows differ in the length of their content", () => {
    let tab = buildTab([
      para("Before"),
      { table: [["a\n", cellOf(para("long"), para("longer still"))], ["much longer text\n", "\n"]] },
      para("After"),
    ]);
    let applied = expectSameAsGoogle(tab, addColumns(read(tab), 0, 2, [["x"], ["y"]]));
    expect(tableTexts(applied).map(row => row[2])).toEqual(["x\n", "y\n"]);
  });

  it("deletes columns at the start, in the middle and at the end, one and several", () => {
    let tab = buildTab([
      para("Before"), grid(["a", "b", "c", "d"], ["e", "f", "g", "h"]), para("After"),
    ]);
    for (let [at, count] of [[0, 1], [1, 1], [3, 1], [0, 3], [1, 2], [2, 2]]) {
      let applied = expectSameAsGoogle(tab, dropColumns(read(tab), 0, at, count));
      expect(tableTexts(applied)[0].length).toBe(4 - count);
      expectViewSameAsGoogle(tab, dropColumns(read(tab), 0, at, count));
    }
  });
});

// ---------------------------------------------------------------------------
// Index arithmetic
// ---------------------------------------------------------------------------

const columnRequests = (requests: GoogleDocsRequest[]) => requests.flatMap(request =>
  "insertTableColumn" in request
    ? [[request.insertTableColumn.tableCellLocation.columnIndex, request.insertTableColumn.insertRight]]
    : []);

const rowRequests = (requests: GoogleDocsRequest[]) => requests.flatMap(request =>
  "insertTableRow" in request
    ? [[request.insertTableRow.tableCellLocation.rowIndex, request.insertTableRow.insertBelow]]
    : []);

const fillIndexes = (requests: GoogleDocsRequest[]) => requests.flatMap(request =>
  "insertText" in request ? [request.insertText.location.index] : []).toSorted((a, b) => a - b);

describe("index arithmetic", () => {
  /** A 2 by 2 table at index 9 holding r0c0 to r1c1: its rows start at 10 and 23. */
  const AT_NINE = buildTab(
    [para("Before"), para(""), grid(["r0c0", "r0c1"], ["r1c0", "r1c1"]), para("After")]);
  const requestsFor = (change: (content: EditableMarkdown) => TableChange) => {
    let before = docTabToMarkdown(AT_NINE);
    expect(before.sourceMap.tables[0].docStart).toBe(9);
    return tableChangeRequests(before, change(contentOf(before)));
  };

  it("fillIndexes a row added below row 0 at 25 and 27", () => {
    let requests = requestsFor(content => addRows(content, 0, 1, [["x", "y"]]));
    expect(rowRequests(requests)).toEqual([[1, false]]);
    expect(fillIndexes(requests)).toEqual([25, 27]);
  });

  it("fillIndexes a row added at the end from the table's end plus one", () => {
    let tableEnd = docTabToMarkdown(AT_NINE).sourceMap.tables[0].docEnd;
    let requests = requestsFor(content => addRows(content, 0, 2, [["x", "y"]]));
    expect(rowRequests(requests)).toEqual([[1, true]]);
    expect(fillIndexes(requests)).toEqual([tableEnd + 1, tableEnd + 3]);
  });

  it("fillIndexes a column added at 1 at 18 and 33", () => {
    let requests = requestsFor(content => addColumns(content, 0, 1, [["x"], ["y"]]));
    expect(columnRequests(requests)).toEqual([[1, false]]);
    expect(fillIndexes(requests)).toEqual([18, 33]);
  });

  it("names the reference row or column where the requests before left it", () => {
    let twoRows = requestsFor(content => addRows(content, 0, 1, [["a", "b"], ["c", "d"]]));
    expect(rowRequests(twoRows)).toEqual([[1, false], [2, false]]);
    expect(fillIndexes(twoRows)).toEqual([25, 27, 30, 32]);
    expect(rowRequests(requestsFor(content => addRows(content, 0, 2, [["a", "b"], ["c", "d"]]))))
      .toEqual([[1, true], [1, true]]);
    expect(columnRequests(requestsFor(content => addColumns(content, 0, 1, [["a", "b"], ["c", "d"]]))))
      .toEqual([[1, false], [2, false]]);
    expect(columnRequests(requestsFor(content => addColumns(content, 0, 2, [["a", "b"], ["c", "d"]]))))
      .toEqual([[1, true], [1, true]]);
  });

  it("sends every coordinate with the tab's ID", () => {
    let requests = requestsFor(content => addRows(content, 0, 1, [["x", "y"]]));
    expect(JSON.stringify(requests).match(/"tabId":"tab-1"/g)?.length)
      .toBe(JSON.stringify(requests).match(/"(index|startIndex)":/g)?.length);
  });
});

// ---------------------------------------------------------------------------
// New cells: matched to their neighbour, or reset
// ---------------------------------------------------------------------------

const LOOK_STYLE: ModelTextStyle = { bold: true, fontSize: { magnitude: 18, unit: "PT" } };

function centre(tab: GoogleDocsTab, row: number, column: number): void {
  let style: ModelParagraphStyle = cellParagraph(tab, row, column).paragraph.paragraphStyle;
  style.alignment = "CENTER";
}

/**
 * A table whose row 0 holds a centred paragraph of bold 18 pt text and a heading with the same
 * look, and whose row 1 holds plain cells.
 */
function lookTab(second: ParagraphSpec = heading("Head")): GoogleDocsTab {
  let tab = buildTab([
    para("Before"),
    {
      table: [
        [
          cellOf({ runs: [{ text: "centred", style: LOOK_STYLE }, "\n"] }),
          cellOf({ ...second, runs: [{ text: "Head", style: LOOK_STYLE }, "\n"] }),
        ],
        ["plain\n", "plain\n"],
      ],
    },
    para("After"),
  ], ALL_LISTS);
  centre(tab, 0, 0);
  centre(tab, 0, 1);
  return tab;
}

const copied = (tab: GoogleDocsTab, change: TableChange): GoogleDocsTab =>
  applyDocsRequests(tab, tableChangeRequests(docTabToMarkdown(tab), change), { copyStyles: true });

/** The text of a cell's first paragraph that is bold, run by run. */
const boldRuns = (tab: GoogleDocsTab, row: number, column: number): string[] =>
  cellParagraph(tab, row, column).paragraph.elements.flatMap(({ textRun }) =>
    textRun?.textStyle.bold ? [textRun.content] : []);

const FULL_RESET =
  ["insertText", "deleteParagraphBullets", "updateParagraphStyle", "updateTextStyle"];
const EMPTY_RESET = ["deleteParagraphBullets", "updateParagraphStyle"];
const MATCHED = ["insertText", "updateTextStyle"];

/** A table in front of a heading: a table added after it cuts the heading at its start. */
const tableBeforeHeading = () =>
  buildTab([para("Before"), grid(["first"]), heading("Results"), para("End")]);

/**
 * The font sizes a tab's second table carries in its first row: on the first and the last
 * character of the first cell's paragraph, and on the second cell's line break.
 */
function newCellSizes(tab: GoogleDocsTab): (number | undefined)[] {
  let filled = cellParagraph(tab, 0, 0, 1);
  let length = filled.paragraph.elements.reduce(
    (sum, element) => sum + (element.textRun?.content.length ?? 0), 0);
  return [filled.start, filled.start + length - 1, cellParagraph(tab, 0, 1, 1).start]
    .map(index => fontSizeAt(tab, index));
}

describe("new cells take after their reference cell", () => {
  it("matches a cell beside normal text and resets one beside a heading", () => {
    let change = addRows(read(lookTab()), 0, 0, [["new", "cell"]]);
    let requests = tableChangeRequests(docTabToMarkdown(lookTab()), change);
    // The cells are filled from the last to the first: the heading's column, then the other.
    expect(kinds(requests)).toEqual(["insertTableRow", ...FULL_RESET, ...MATCHED]);
    expect(requests.at(-1))
      .toMatchObject({ updateTextStyle: { textStyle: {}, fields: FOUR_FIELDS } });

    let applied = copied(lookTab(), change);
    let matched = cellParagraph(applied, 0, 0).start;
    let reset = cellParagraph(applied, 0, 1).start;
    expect([alignmentAt(applied, matched), fontSizeAt(applied, matched)]).toEqual(["CENTER", 18]);
    // The text lost the bold it took; the cell's line break keeps what Google copied onto it.
    expect(boldRuns(applied, 0, 0)).toEqual(["\n"]);
    expect([alignmentAt(applied, reset), fontSizeAt(applied, reset)])
      .toEqual([undefined, undefined]);
    expect(tableAt(read(applied), 0)).toContain("<td><p>new</p></td>\n    <td><p>cell</p></td>");
    expectSameAsGoogle(lookTab(), change);
  });

  it("sends nothing for an empty matched cell, whose line break stays bold", () => {
    let change = addRows(read(lookTab()), 0, 0, [["", ""]]);
    expect(kinds(tableChangeRequests(docTabToMarkdown(lookTab()), change)))
      .toEqual(["insertTableRow", "deleteParagraphBullets", "updateParagraphStyle"]);
    expect(boldRuns(copied(lookTab(), change), 0, 0)).toEqual(["\n"]);
    expectSameAsGoogle(lookTab(), change);
  });

  it("matches both cells of a row added beside a plain row", () => {
    let change = addRows(read(lookTab()), 0, 1, [["new", "cell"]]);
    expect(kinds(tableChangeRequests(docTabToMarkdown(lookTab()), change)))
      .toEqual(["insertTableRow", ...MATCHED, ...MATCHED]);
    let applied = copied(lookTab(), change);
    for (let column of [0, 1]) {
      let start = cellParagraph(applied, 1, column).start;
      expect([alignmentAt(applied, start), fontSizeAt(applied, start)])
        .toEqual([undefined, undefined]);
    }
    expectSameAsGoogle(lookTab(), change);
  });

  it("matches or resets each cell of a new column by the cell beside it in its row", () => {
    let tab = buildTab([
      para("Before"),
      {
        table: [
          [cellOf({ runs: [{ text: "centred", style: LOOK_STYLE }, "\n"] }), "x\n"],
          [cellOf(item("bullet", "DEEP", 1)), "y\n"],
        ],
      },
      para("After"),
    ], ALL_LISTS);
    centre(tab, 0, 0);
    let change = addColumns(read(tab), 0, 0, [["top"], ["bottom"]]);
    expect(kinds(tableChangeRequests(docTabToMarkdown(tab), change)))
      .toEqual(["insertTableColumn", ...FULL_RESET, ...MATCHED]);
    let applied = copied(tab, change);
    expect(alignmentAt(applied, cellParagraph(applied, 0, 0).start)).toBe("CENTER");
    expect(indentedParagraphs(applied)).toEqual([]);
    expectSameAsGoogle(tab, change);
  });

  it("adds every row of a call directly beside the reference row, so each copies from it", () => {
    let change = addRows(read(lookTab()), 0, 0, [["one", ""], ["two", ""]]);
    let requests = tableChangeRequests(docTabToMarkdown(lookTab()), change);
    expect(requests.slice(0, 2)).toEqual([0, 1].map(rowIndex => ({
      insertTableRow: {
        tableCellLocation: { tableStartLocation: { index: 8, tabId: TAB }, rowIndex, columnIndex: 0 },
        insertBelow: false,
      },
    })));
    let applied = copied(lookTab(), change);
    for (let row of [0, 1]) {
      let start = cellParagraph(applied, row, 0).start;
      expect([alignmentAt(applied, start), fontSizeAt(applied, start)]).toEqual(["CENTER", 18]);
    }
    expectSameAsGoogle(lookTab(), change);
  });

  it("names the reference column the same way, and the last one at the end", () => {
    let columnsOf = (change: TableChange) =>
      tableChangeRequests(docTabToMarkdown(lookTab()), change).flatMap(request =>
        "insertTableColumn" in request
          ? [[request.insertTableColumn.tableCellLocation.columnIndex, request.insertTableColumn.insertRight]]
          : []);
    let cells = [["a", "b"], ["c", "d"]];
    expect(columnsOf(addColumns(read(lookTab()), 0, 0, cells))).toEqual([[0, false], [1, false]]);
    expect(columnsOf(addColumns(read(lookTab()), 0, 2, cells))).toEqual([[1, true], [1, true]]);
    expectSameAsGoogle(lookTab(), addColumns(read(lookTab()), 0, 0, cells));
    expectSameAsGoogle(lookTab(), addColumns(read(lookTab()), 0, 2, cells));
    expectSameAsGoogle(lookTab(), addRows(read(lookTab()), 0, 2, cells));
  });

  it("resets every cell of a new table, filled or empty, as it does the paragraph beside it", () => {
    // The table cuts the heading at its start, and Google writes the heading's look onto the
    // line breaks of the new cells, where no rendering shows it.
    let tab = tableBeforeHeading;
    let change = newTable([["Filled", ""]], "first");
    let requests = tableChangeRequests(docTabToMarkdown(tab()), change);
    // The paragraph between the two tables, then the cells from the last to the first.
    expect(kinds(requests)).toEqual(["insertTable", ...EMPTY_RESET, ...EMPTY_RESET, ...FULL_RESET]);

    // Without the resets the cells keep the heading's size, and so does text put into one.
    let unreset = requests.filter(request =>
      !("deleteParagraphBullets" in request) && !("updateParagraphStyle" in request));
    expect(newCellSizes(applyDocsRequests(tab(), unreset, { copyStyles: true })))
      .toEqual([16, 16, 16]);
    expect(newCellSizes(applyDocsRequests(tab(), requests, { copyStyles: true })))
      .toEqual([undefined, undefined, undefined]);
    expectSameAsGoogle(tab(), change);
  });

  it("resets a cell beside one that starts with a subtitle or a title", () => {
    for (let namedStyleType of ["SUBTITLE", "TITLE"]) {
      let tab = () => lookTab({ runs: [], namedStyleType });
      let change = addRows(read(tab()), 0, 0, [["new", "cell"]]);
      expect(kinds(tableChangeRequests(docTabToMarkdown(tab()), change)))
        .toEqual(["insertTableRow", ...FULL_RESET, ...MATCHED]);
      expectSameAsGoogle(tab(), change);
    }
  });
});

const pinnedTab = (...rows: string[][]) =>
  buildTab([para("Before"), { ...grid(...rows), headerRows: 1 }, para("After")]);

describe("pinned header rows", () => {
  const PIN = {
    pinTableHeaderRows: { tableStartLocation: { index: 8, tabId: TAB }, pinnedHeaderRowsCount: 1 },
  };

  it("pins the count the table had when a row is added beside a pinned row", () => {
    for (let [tab, at] of [
      [() => pinnedTab(["H1", "H2"], ["a", "b"]), 0], [() => pinnedTab(["H1", "H2"]), 1],
    ] as const) {
      let before = docTabToMarkdown(tab());
      let change = addRows(contentOf(before), 0, at, [["x", "y"]]);
      let requests = tableChangeRequests(before, change);
      expect(requests.at(-1)).toEqual(PIN);
      expect(pinnedHeaderRows(applyDocsRequests(tab(), requests), 8)).toBe(1);
      expect(pinnedHeaderRows(applyDocsRequests(tab(), requests.slice(0, -1)), 8)).toBe(2);
      expectSameAsGoogle(tab(), change);
    }
  });

  it("sends no pin for any other change", () => {
    let tab = pinnedTab(["H1", "H2"], ["a", "b"], ["c", "d"]);
    let content = read(tab);
    for (let change of [
      addRows(content, 0, 1, [["x", "y"]]), addRows(content, 0, 3, [["x", "y"]]),
      addColumns(content, 0, 0, [["x"], ["y"], ["z"]]), dropRows(content, 0, 1),
    ]) {
      expect(kinds(tableChangeRequests(docTabToMarkdown(tab), change)))
        .not.toContain("pinTableHeaderRows");
      expect(pinnedHeaderRows(expectSameAsGoogle(tab, change), 8)).toBe(1);
    }
    expect(pinnedHeaderRows(expectSameAsGoogle(tab, dropRows(content, 0, 0)), 8)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Inserting and deleting a table, among every kind of neighbour
// ---------------------------------------------------------------------------

const KINDS = {
  plain: (label: string) => [para(label)],
  chip: (label: string) => [chip(`${label} `)],
  empty: () => [para("")],
  quiet: () => [quietChip()],
  item: (label: string, list: string) => [item(label, list)],
  emptyItem: (_: string, list: string) => [item("", list)],
  heading: (label: string) => [heading(label)],
  emptyHeading: () => [heading("")],
  table: (label: string) => [grid([label])],
  toc: () => [toc],
} satisfies Record<string, (label: string, list: string) => BlockSpec[]>;
type Kind = keyof typeof KINDS;
const ALL_KINDS = Object.keys(KINDS) as Kind[];
const isStructure = (kind: Kind | undefined) => kind === "table" || kind === "toc";

/**
 * A tab of these blocks between a first and a last paragraph. Google keeps a paragraph beside a
 * table, so an empty one stands between two structures.
 */
function assemble(sequence: readonly [Kind, string, string][], closed = true): GoogleDocsTab {
  let blocks: BlockSpec[] = [para("Start")];
  let previous: Kind | undefined;
  for (let [kind, label, list] of sequence) {
    if (isStructure(kind) && isStructure(previous)) blocks.push(para(""));
    blocks.push(...KINDS[kind](label, list));
    previous = kind;
  }
  if (closed) {
    if (isStructure(previous)) blocks.push(para(""));
    blocks.push(para("End"));
  }
  return buildTab(blocks, ALL_LISTS);
}

function attempt(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    if (error instanceof Error) return error.message;
    throw error;
  }
}

/**
 * Judge a change in both forms. The replay over the tab's own rendering and the request builder
 * refuse the same things; what either form accepts reads as the document does afterwards.
 */
function judge(
  tab: GoogleDocsTab, change: TableChange,
): { document: string | undefined; view: string | undefined } {
  let before = docTabToMarkdown(tab);
  let content = contentOf(before);
  let document = attempt(() => applyTableChange(content, change, before));
  expect(attempt(() => tableChangeRequests(before, change))).toBe(document);
  if (document === undefined) expectSameAsGoogle(tab, change);
  let view = attempt(() => applyTableChange(content, change));
  if (document === undefined && view === undefined) expectViewSameAsGoogle(tab, change);
  return { document, view };
}

const TOC_REFUSAL = "insertTable: a table cannot follow a table of contents or a section " +
  "break. Name a paragraph instead.";
const AMBIGUOUS_REFUSAL = "insertTable: after matches multiple locations in the tab. To make " +
  "the match unique, include more of the text before it, a line break before it for the start " +
  "of its line, or the line break that ends its paragraph.";
const NOT_FOUND_REFUSAL = "insertTable: after was not found in the tab. Make sure the text " +
  "exactly matches content returned by getContent().";
const NO_LAST_PARAGRAPH = "insertTable: the selected tab does not end in a paragraph. Name " +
  "the text the table should follow.";
const LIST_ITEMS_READ = "deleteTable: the lines before and after this table read as list " +
  "items, which deleting it could join into one list. Retry once the earlier changes to this " +
  "tab have been approved or rejected: the document then shows whether they are items of one " +
  "list.";

/** The text that names a block of each kind, for the kinds that have text. */
const ANCHOR_TEXT: Partial<Record<Kind, string>> = {
  plain: "ANCHOR", chip: "ANCHOR Ana", item: "ANCHOR", heading: "ANCHOR", table: "ANCHOR",
  toc: "[Table of contents]",
};

describe("insertTable among its neighbours", () => {
  const TABLES = [[["x", "y\nz"]], [["", ""], ["", ""]]];

  it("reads as the document does after every kind of anchor and neighbour", () => {
    let accepted = 0;
    let count = 0;
    let run = (sequence: [Kind, string, string][], anchor: Kind) => {
      let after = ANCHOR_TEXT[anchor];
      if (after === undefined) return;
      let { document, view } = judge(assemble(sequence), newTable(TABLES[count++ % 2], after));
      expect(view).toBe(document);
      if (document === undefined) accepted++;
      else expect([TOC_REFUSAL, AMBIGUOUS_REFUSAL]).toContain(document);
    };
    for (let anchor of ALL_KINDS) {
      for (let near of ALL_KINDS) {
        for (let far of ALL_KINDS) {
          // The block before and the block after; the two before; the two after.
          run([[near, "B1", "L1"], [anchor, "ANCHOR", "L1"], [far, "A1", "L2"]], anchor);
          run([[far, "B2", "L1"], [near, "B1", "L1"], [anchor, "ANCHOR", "L1"]], anchor);
          run([[anchor, "ANCHOR", "L1"], [near, "A1", "L2"], [far, "A2", "L2"]], anchor);
        }
      }
    }
    expect(accepted).toBeGreaterThan(1200);
  });

  it("reads as the document does at the end of a tab, after every kind of last block", () => {
    let accepted = 0;
    for (let last of ALL_KINDS) {
      for (let near of ALL_KINDS) {
        for (let far of ALL_KINDS) {
          let tab = assemble([[far, "B2", "L2"], [near, "B1", "L1"], [last, "LAST", "L1"]], false);
          let { document, view } = judge(tab, newTable(TABLES[accepted % 2]));
          expect(view).toBe(document);
          expect(document).toBe(isStructure(last) ? NO_LAST_PARAGRAPH : undefined);
          if (document === undefined) accepted++;
        }
      }
    }
    expect(accepted).toBe(800);
  });

  it("adds a table to a blank tab, also where the view shows it as empty", () => {
    let blank = buildTab([para("")]);
    let change = newTable([["a", "b"]]);
    let applied = expectSameAsGoogle(blank, change);
    expect(docTabToMarkdown(applied).markdown).toBe(`\n\n${tableHtml([["a", "b"]])}\n\n\n`);
    expectViewSameAsGoogle(blank, change);
    let emptied = applyTableChange({ markdown: "", protectedRanges: [], tables: [] }, change);
    expectRendering(emptied, applied);
  });

  it("leaves an empty list item or heading on the side of the table its replay shows it", () => {
    for (let [split, line] of [[item(""), "- "], [heading(""), "## "]] as const) {
      let tab = () => buildTab([para("Intro"), grid(["first"]), split], ALL_LISTS);
      let html = tableHtml([["new"]]);
      let atEnd = newTable([["new"]]);
      let afterTable = newTable([["new"]], "first");
      let ended = docTabToMarkdown(expectSameAsGoogle(tab(), atEnd)).markdown;
      expect(ended.endsWith(`</table>\n\n${line}\n\n${html}\n\n\n`)).toBe(true);
      let followed = docTabToMarkdown(expectSameAsGoogle(tab(), afterTable)).markdown;
      expect(followed.endsWith(`</table>\n\n\n\n${html}\n\n${line}\n`)).toBe(true);
      // Both split the same paragraph at the same index.
      let before = docTabToMarkdown(tab());
      expect(tableChangeRequests(before, atEnd)[0])
        .toEqual(tableChangeRequests(before, afterTable)[0]);
    }
  });

  it("says where among the tab's tables the new one is", () => {
    let tab = buildTab([para("Before"), grid(["one"]), para("Mid"), grid(["two"]), para("After")]);
    let before = docTabToMarkdown(tab);
    for (let [after, position] of [
      ["Before", 0], ["one", 1], ["Mid", 1], ["two", 2], ["After", 2], [undefined, 2],
    ] as const) {
      let change = newTable([["new"]], after);
      if (change.type !== "insertTable") throw new Error("Expected a new table");
      for (let fresh of [before, undefined]) {
        let added = applyNewTable(contentOf(before), change, fresh);
        expect(added.table).toBe(position);
        expect(tableAt(added.content, position)).toBe(tableHtml([["new"]]));
        expect(added.content).toEqual(applyTableChange(contentOf(before), change, fresh));
      }
    }
  });

  it("leaves no indent on the paragraph after a table added after a nested list item", () => {
    let tab = buildTab([item("top", "DEEP"), item("nested", "DEEP", 1), para("After")], ALL_LISTS);
    expectSameAsGoogle(tab, newTable([["a"]], "nested"));
    expectSameAsGoogle(tab, newTable([[""]], "nested"));
  });
});

describe("deleteTable among its neighbours", () => {
  it("reads as the document does between every kind of neighbour, two blocks each way", () => {
    let accepted = 0;
    let run = (sequence: [Kind, string, string][]) => {
      let tab = assemble(sequence);
      let content = read(tab);
      let target = content.tables.findIndex(
        (_, index) => tableAt(content, index).includes("TARGET"));
      let { document, view } = judge(tab, dropTable(content, target));
      expect(document).toBeUndefined();
      if (view !== undefined) expect(view).toBe(LIST_ITEMS_READ);
      accepted++;
    };
    for (let near of ALL_KINDS) {
      for (let far of ALL_KINDS) {
        run([[near, "B1", "L1"], ["table", "TARGET", ""], [far, "A1", "L2"]]);
        run([[far, "B2", "L1"], [near, "B1", "L1"], ["table", "TARGET", ""], ["plain", "A1", ""]]);
        run([["plain", "B1", ""], ["table", "TARGET", ""], [near, "A1", "L2"], [far, "A2", "L2"]]);
      }
    }
    expect(accepted).toBe(300);
  });

  it("deletes a table with merged cells and one that holds a nested table", () => {
    let merged = buildTab([
      para("Before"),
      {
        table: [
          [{ paragraphs: [para("head")], tableCellStyle: { columnSpan: 2 } }, "\n"],
          ["a\n", "b\n"],
        ],
      },
      para("After"),
    ]);
    let nested = buildTab([
      para("Before"), { table: [[cellOf(para("x"), grid(["in"]), para("y")), "b\n"]] }, para("After"),
    ]);
    for (let tab of [merged, nested]) {
      let applied = expectSameAsGoogle(tab, dropTable(read(tab), 0));
      expect(docTabToMarkdown(applied).markdown).toBe("Before\n\nAfter\n");
      expectViewSameAsGoogle(tab, dropTable(read(tab), 0));
    }
  });
});

// ---------------------------------------------------------------------------
// Which table a change is for
// ---------------------------------------------------------------------------

const noLongerReads = (op: string) =>
  `${op}: the table no longer reads as it did when this change was queued, or it is gone.`;
const anotherReadsTheSame = (op: string) =>
  `${op}: another table of the tab now reads the same as the table this change was queued ` +
  "for, so the change can no longer be kept to it.";
const behindFailedChange = (op: string) =>
  `${op}: an earlier queued change to this tab's tables no longer applies, and this change ` +
  "named its table among the tables as that one left them.";

/** Rows for a table recorded as reading `expected`. */
const rowsFor = (expected: string, cells: string[][], at = 1): TableChange =>
  ({ type: "insertTableRows", at, cells, expected });

describe("resolveTable", () => {
  const first = grid(["a", "b"]);
  const second = grid(["c", "d"]);
  const TWO = () => buildTab([para("Before"), first, para("Mid"), second, para("After")]);
  const ref = () => refOf(read(TWO()), 1);

  it("finds a table that reads like no other wherever it now is", () => {
    expect(resolveTable(read(TWO()), ref(), "deleteTable")).toBe(1);
    let added = buildTab(
      [para("New"), grid(["e"]), para("Before"), first, para("Mid"), second, para("After")]);
    expect(resolveTable(read(added), ref(), "deleteTable")).toBe(2);
    let removed = buildTab([para("Before"), para("Mid"), second, para("After")]);
    expect(resolveTable(read(removed), ref(), "deleteTable")).toBe(0);
  });

  it("refuses a table whose own text changed, or that is gone", () => {
    let edited = buildTab(
      [para("Before"), first, para("Mid"), grid(["c", "changed"]), para("After")]);
    let gone = buildTab([para("Before"), first, para("Mid"), para("After")]);
    for (let tab of [edited, gone]) {
      expect(message(() => resolveTable(read(tab), ref(), "deleteTableRows")))
        .toBe(noLongerReads("deleteTableRows"));
      expect(refusal(tab, rowsFor(ref().expected, [["x", "y"]])))
        .toBe(noLongerReads("insertTableRows"));
    }
  });

  it("refuses when a second table reads the same, and never picks one", () => {
    let copy = buildTab(
      [para("Before"), first, para("Mid"), second, para("More"), second, para("After")]);
    expect(refusal(copy, rowsFor(ref().expected, [["x", "y"]])))
      .toBe(anotherReadsTheSame("insertTableRows"));
    let twins = buildTab([para("Before"), first, para("Mid"), first, para("After")]);
    expect(refusal(twins, { type: "deleteTable", ...refOf(read(twins), 0) }))
      .toBe(anotherReadsTheSame("deleteTable"));
    expect(message(() => resolveTable(read(twins), refOf(read(twins), 1), "deleteTableColumns")))
      .toBe(anotherReadsTheSame("deleteTableColumns"));
  });
});

/** A body item of a numbered list, then a table whose first cell holds the list's next item. */
const numberedTab = (inList: boolean, second = false) => buildTab([
  inList ? item("Checklist", "N1") : para("Checklist"),
  heading("Team A"),
  { table: [[cellOf(item("Step", "N1")), "Notes\n"]] },
  ...(second ? [heading("Team B"), { table: [[cellOf(item("Step", "N1")), "Notes\n"]] }] : []),
  para("End"),
], ALL_LISTS);

const footnote = (number: number) => ({ footnote: { id: `f${number}`, number: String(number) } });
/** A table whose cell holds a footnote, numbered `first`, and a second such table if asked. */
const footnoteTab = (introHasOne: boolean, second = false) => {
  let number = introHasOne ? 2 : 1;
  return buildTab([
    { runs: ["Intro", ...(introHasOne ? [footnote(1)] : []), "\n"] },
    heading("Q1"),
    { table: [[cellOf({ runs: ["Revenue", footnote(number), "\n"] })]] },
    ...(second
      ? [heading("Q2"), { table: [[cellOf({ runs: ["Revenue", footnote(number + 1), "\n"] })]] }]
      : []),
    para("End"),
  ]);
};

describe("tables that read the same", () => {
  it("takes the number a list starts at and the number of a footnote out of a shape", () => {
    expect(tableShape("<td><ol start=\"3\"><li>a</li></ol></td>"))
      .toBe("<td><ol><li>a</li></ol></td>");
    expect(tableShape("<ol type=\"a\" start=\"3\">")).toBe("<ol type=\"a\">");
    expect(tableShape("<ol style=\"list-style-type: decimal-leading-zero\" start=\"2\">"))
      .toBe("<ol style=\"list-style-type: decimal-leading-zero\">");
    expect(tableShape("<p>see [12]</p><a href=\"https://x.example/[12]\">y</a>"))
      .toBe("<p>see []</p><a href=\"https://x.example/[]\">y</a>");
    for (let html of [
      "<p>[Footnote]</p>", "<p>[a]</p>", "<p>x start=\"3\"&gt;</p>", tableHtml([["a", "b"]]),
    ]) {
      expect(tableShape(html)).toBe(html);
    }
    let both = read(numberedTab(true, true));
    expect(tableAt(both, 0)).toContain("<ol start=\"2\"><li>Step</li></ol>");
    expect(tableAt(both, 1)).toContain("<ol start=\"3\"><li>Step</li></ol>");
    expect(tableShape(tableAt(both, 0))).toBe(tableShape(tableAt(both, 1)));
  });

  it("refuses a change whose table shows another list number than was recorded", () => {
    let recorded = refOf(read(numberedTab(true)), 0);
    let rows = rowsFor(recorded.expected, [["x", "y"]]);
    let applied = expectSameAsGoogle(numberedTab(true), rows);
    expect(tableTexts(applied)).toEqual([["Step\n", "Notes\n"], ["x\n", "y\n"]]);
    // With the body item out of the list the table reads <ol>, not <ol start="2">.
    expect(tableAt(read(numberedTab(false)), 0)).toContain("<ol><li>Step</li></ol>");
    expect(refusal(numberedTab(false), rows)).toBe(noLongerReads("insertTableRows"));
  });

  it("never hands a change to a table that came to show the number recorded", () => {
    let rows = rowsFor(tableAt(read(numberedTab(true, true)), 0), [["x", "y"]]);
    expect(refusal(numberedTab(true, true), rows)).toBe(anotherReadsTheSame("insertTableRows"));
    // The first table then reads <ol> and the second <ol start="2">: compared by its HTML as it
    // is, exactly one table reads as the first was recorded, and it is the second.
    let moved = read(numberedTab(false, true));
    expect(tableAt(moved, 1)).toBe(rows.type === "insertTableRows" ? rows.expected : "");
    expect(refusal(numberedTab(false, true), rows)).toBe(anotherReadsTheSame("insertTableRows"));
  });

  it("refuses a change whose table shows another footnote number than was recorded", () => {
    expect(tableAt(read(footnoteTab(false)), 0)).toContain("Revenue[1]");
    let rows = rowsFor(tableAt(read(footnoteTab(false)), 0), [["x"]]);
    expect(tableAt(read(footnoteTab(true)), 0)).toContain("Revenue[2]");
    expect(refusal(footnoteTab(true), rows)).toBe(noLongerReads("insertTableRows"));
    for (let table of [0, 1]) {
      let both = read(footnoteTab(false, true));
      expect(refusal(footnoteTab(false, true), rowsFor(tableAt(both, table), [["x"]])))
        .toBe(anotherReadsTheSame("insertTableRows"));
    }
  });

  it("reads typed digits in square brackets as a footnote's number", () => {
    let tab = buildTab(
      [heading("A"), grid(["see [1]"]), heading("B"), grid(["see [2]"]), para("End")]);
    for (let table of [0, 1]) {
      expect(refusal(tab, rowsFor(tableAt(read(tab), table), [["x"]])))
        .toBe(anotherReadsTheSame("insertTableRows"));
    }
  });
});

type QueuedText = { type: "replaceText"; oldMarkdown: string; newMarkdown: string; inTable?: true };

/**
 * Replay stored changes over a fresh tab's content the way the connection does: each is admitted
 * by the gate first, and one that throws is skipped and reported to the gate.
 */
function replayQueue(
  tab: GoogleDocsTab, changes: readonly (TableChange | QueuedText)[],
): { content: EditableMarkdown; messages: (string | undefined)[] } {
  let before = docTabToMarkdown(tab);
  let content = contentOf(before);
  let gate = new TableReplayGate();
  let messages: (string | undefined)[] = [];
  for (let change of changes) {
    let failure = attempt(() => {
      gate.admit(TAB, change);
      content = change.type === "replaceText"
        ? applyTextReplacement(content, {
          ...change, matchStart: content.markdown.indexOf(change.oldMarkdown),
        }, TAB)
        : applyTableChange(content, change, before);
    });
    if (failure !== undefined) gate.failed(TAB, change);
    messages.push(failure);
  }
  return { content, messages };
}

const H = tableHtml([["Task", "Owner"]]);
const taskTable = grid(["Task", "Owner"]);
const rowCounts = (content: EditableMarkdown) => content.tables.map(table => table.rows.length);

let staysOpen = (note: (gate: TableReplayGate) => void) => {
  let gate = new TableReplayGate();
  note(gate);
  return attempt(() => gate.admit(TAB, { type: "deleteTableRows" })) === undefined;
};

let aroundMid = (h: TableSpec, g?: TableSpec) =>
  buildTab([para("Before"), h, para("Mid"), ...(g ? [g] : []), para("After")]);

const markDone = (name: string): QueuedText => ({
  type: "replaceText",
  oldMarkdown: `## ${name}\n\n<table>\n  <tr>\n    <td><p>Task</p></td>`,
  newMarkdown: `## ${name}\n\n<table>\n  <tr>\n    <td><p>Task (done)</p></td>`,
  inTable: true,
});

describe("a queue replayed through the gate", () => {
  const PAIR = buildTab([heading("X"), taskTable, heading("Y"), taskTable, para("End")]);
  const rowsForX = rowsFor(H, [["x1", "x2"]]);
  const rowsForY = rowsFor(tableHtml([["Task (done)", "Owner"]]), [["y1", "y2"]]);

  it("lands each change in its own table when every change before it replays", () => {
    let { content, messages } = replayQueue(
      PAIR, [markDone("Y"), rowsForX, markDone("X"), rowsForY]);
    expect(messages).toEqual([undefined, undefined, undefined, undefined]);
    expect(tableAt(content, 0)).toBe(tableHtml([["Task (done)", "Owner"], ["x1", "x2"]]));
    expect(tableAt(content, 1)).toBe(tableHtml([["Task (done)", "Owner"], ["y1", "y2"]]));
  });

  it("refuses the changes behind one that failed, which would reach another table", () => {
    // The first change rejected: X and Y read the same again when rows for X are replayed.
    let { content, messages } = replayQueue(PAIR, [rowsForX, markDone("X"), rowsForY]);
    expect(messages).toEqual([
      anotherReadsTheSame("insertTableRows"), undefined, behindFailedChange("insertTableRows"),
    ]);
    expect(rowCounts(content)).toEqual([1, 1]);
    expect(tableAt(content, 0)).toBe(tableHtml([["Task (done)", "Owner"]]));
    // What the gate is for: X then reads exactly as Y did when its rows were recorded.
    let misdirected = applyTableChange(content, rowsForY);
    expect(tableAt(misdirected, 0)).toContain("<td><p>y1</p></td>");
    expect(rowCounts(misdirected)).toEqual([2, 1]);
  });

  it("drops a later change with the one that failed, though it names another table", () => {
    const G = tableHtml([["Risk", "Owner"]]);
    let risks = grid(["Risk", "Owner"]);
    let queue = [rowsFor(H, [["h1", "h2"]]), rowsFor(G, [["g1", "g2"]])];
    let both = replayQueue(aroundMid(taskTable, risks), queue);
    expect(both.messages).toEqual([undefined, undefined]);
    expect(rowCounts(both.content)).toEqual([2, 2]);

    let edited = aroundMid(grid(["Task", "Someone"]), risks);
    let behind = replayQueue(edited, queue);
    expect(behind.messages)
      .toEqual([noLongerReads("insertTableRows"), behindFailedChange("insertTableRows")]);
    expect(behind.content).toEqual(read(edited));

    let deleted = replayQueue(aroundMid(taskTable), queue);
    expect(deleted.messages).toEqual([undefined, noLongerReads("insertTableRows")]);
    expect(rowCounts(deleted.content)).toEqual([2]);
  });

  it("refuses a change for a table that the queue made read like another", () => {
    let tab = buildTab([para("Before"), taskTable, para("After")]);
    let another = newTable([["Task", "Owner"]], "After");
    let full = replayQueue(tab, [rowsFor(H, [["a", "b"]]), another, rowsFor(H, [["c", "d"]])]);
    expect(full.messages).toEqual([undefined, undefined, undefined]);
    expect(tableAt(full.content, 0)).toContain("<td><p>a</p></td>");
    expect(tableAt(full.content, 1)).toContain("<td><p>c</p></td>");
    // Without the first change, two tables read as the rows recorded theirs.
    let rejected = replayQueue(tab, [another, rowsFor(H, [["c", "d"]])]);
    expect(rejected.messages).toEqual([undefined, anotherReadsTheSame("insertTableRows")]);
    expect(rowCounts(rejected.content)).toEqual([1, 1]);
  });

  it("leaves alone what is placed by its text, the changes before, and other tabs", () => {
    let tab = buildTab([para("Before"), taskTable, para("After")]);
    let stale = rowsFor(tableHtml([["Gone"]]), [["x"]]);
    let { content, messages } = replayQueue(tab, [
      { type: "replaceText", oldMarkdown: "Before", newMarkdown: "Earlier" },
      stale,
      newTable([["New"]], "After"),
      { type: "replaceText", oldMarkdown: "After", newMarkdown: "Later" },
      { type: "replaceText", oldMarkdown: "<p>Owner</p>", newMarkdown: "<p>Lead</p>", inTable: true },
      rowsFor(H, [["a", "b"]]),
    ]);
    expect(messages).toEqual([
      undefined, noLongerReads("insertTableRows"), undefined, undefined, undefined,
      behindFailedChange("insertTableRows"),
    ]);
    expect(content.markdown).toBe(
      `Earlier\n\n${tableHtml([["Task", "Lead"]])}\n\nLater\n\n${tableHtml([["New"]])}\n\n\n`);

    let gate = new TableReplayGate();
    gate.failed(TAB, stale);
    expect(() => gate.admit("other-tab", stale)).not.toThrow();
    expect(() => gate.admit(TAB, newTable([["New"]]))).not.toThrow();
    expect(() => gate.admit(TAB, { type: "replaceText" })).not.toThrow();
    expect(message(() => gate.admit(TAB, { type: "deleteTable" })))
      .toBe(behindFailedChange("deleteTable"));
  });

  it("closes a tab for a failed table change, and for nothing else", () => {
    expect(staysOpen(gate => gate.failed(TAB, { type: "replaceText" }))).toBe(true);
    expect(staysOpen(gate => gate.failed(TAB, { type: "appendText" }))).toBe(true);
    expect(staysOpen(gate => gate.failed(undefined, { type: "deleteTable" }))).toBe(true);
    expect(staysOpen(gate => gate.close(undefined))).toBe(true);
    expect(staysOpen(gate => gate.failed(TAB, { type: "replaceText", inTable: true }))).toBe(false);
    expect(staysOpen(gate => gate.failed(TAB, { type: "insertTable" }))).toBe(false);
    expect(staysOpen(gate => gate.close(TAB))).toBe(false);
  });

  it("says which stored changes change a table and which name one", () => {
    let structural = [
      "insertTable", "insertTableRows", "insertTableColumns", "deleteTableRows",
      "deleteTableColumns", "deleteTable",
    ];
    for (let type of structural) {
      expect(changesTables({ type })).toBe(true);
      expect(namesTable({ type })).toBe(type !== "insertTable");
    }
    expect(changesTables({ type: "replaceText", inTable: true })).toBe(true);
    for (let type of ["replaceText", "appendText"]) {
      expect(changesTables({ type })).toBe(false);
      expect(namesTable({ type })).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/**
 * What a change to the table at `table` is refused with: by the replay, by the request builder
 * and, given only the table's position, by `checkTableTarget`, which must all agree.
 */
function targetRefusal(tab: GoogleDocsTab, change: TableChange, table = 0): string {
  let before = docTabToMarkdown(tab);
  let refused = refusal(tab, change);
  expect(message(() => checkTableTarget(contentOf(before), table, shapeOf(change), before)))
    .toBe(refused);
  return refused;
}

const notLaidOut = (op: string) =>
  `${op}: this table is not laid out as Google Docs lays tables out, so it cannot be changed.`;
const MERGED_TABLE = () => buildTab([
  para("Before"),
  {
    table: [
      [{ paragraphs: [para("head")], tableCellStyle: { columnSpan: 2 } }, "\n", "c\n"],
      ["a\n", "b\n", "c\n"],
      ["d\n", "e\n", "f\n"],
    ],
  },
  para("After"),
]);

/** A table of `rows` × `columns` cells, each holding its place as text. */
const sized = (rows: number, columns: number, label = "r"): TableSpec => grid(
  ...Array.from({ length: rows }, (_, row) =>
    Array.from({ length: columns }, (__, column) => `${label}${row}c${column}`)));
const blank = (rows: number, columns: number): string[][] =>
  Array.from({ length: rows }, () => Array.from({ length: columns }, () => ""));

describe("refusals for what a table is", () => {
  it("refuses row and column changes that cross a merged cell", () => {
    let content = read(MERGED_TABLE());
    let copies = (op: string, noun: string, line: number) =>
      `${op}: ${noun} ${line} of this table, counting from 0, which the new ${noun}s copy, ` +
      "crosses the merged cell at row 0, column 0, which Google Docs would grow or copy into " +
      `them. ${noun === "row" ? "Rows" : "Columns"} can be added only beside ${noun}s that cross no merged cell.`;
    let deletes = (op: string, noun: string) =>
      `${op}: the ${noun}s to delete cross the merged cell at row 0, column 0 (counting from 0). ` +
      `Split it with unmergeTableCells() first, or delete ${noun}s that cross no merged cell.`;
    expect(targetRefusal(MERGED_TABLE(), addRows(content, 0, 0, [["", "", ""]])))
      .toBe(copies("insertTableRows", "row", 0));
    expect(targetRefusal(MERGED_TABLE(), addColumns(content, 0, 1, [[""], [""], [""]])))
      .toBe(copies("insertTableColumns", "column", 1));
    expect(targetRefusal(MERGED_TABLE(), dropRows(content, 0, 0)))
      .toBe(deletes("deleteTableRows", "row"));
    expect(targetRefusal(MERGED_TABLE(), dropColumns(content, 0, 1, 2)))
      .toBe(deletes("deleteTableColumns", "column"));
  });

  it("changes rows and columns beside a merged cell, which moves with its lines, as Google does", () => {
    let content = read(MERGED_TABLE());
    for (let change of [
      addRows(content, 0, 1, [["x", "y", "z"]]), addRows(content, 0, 3, [["", "", "end"]]),
      addColumns(content, 0, 2, [["n"], [""], [""]]), addColumns(content, 0, 3, [["m"], [""], [""]]),
      dropRows(content, 0, 1, 2), dropColumns(content, 0, 2),
    ]) {
      let applied = expectSameAsGoogle(MERGED_TABLE(), change);
      expect(tableAt(read(applied), 0), change.type).toContain('<td colspan="2"><p>head</p></td>');
    }
  });

  it("says what the table is before it looks for another that reads the same", () => {
    let merged: TableSpec = {
      table: [[{ paragraphs: [para("head")], tableCellStyle: { columnSpan: 2 } }, "\n"], ["a\n", "b\n"]],
    };
    let tab = buildTab([para("Before"), merged, para("Mid"), merged, para("After")]);
    let content = read(tab);
    for (let table of [0, 1]) {
      let change = dropRows(content, table, 0);
      expect(message(() => checkTableTarget(content, table, shapeOf(change)))).toBe(
        "deleteTableRows: the rows to delete cross the merged cell at row 0, column 0 (counting " +
        "from 0). Split it with unmergeTableCells() first, or delete rows that cross no merged cell.");
      expect(refusal(tab, change)).toBe(anotherReadsTheSame("deleteTableRows"));
    }
    // It refuses nothing the replay accepts.
    let plain = read(BASIC());
    expect(() => checkTableTarget(plain, 0, shapeOf(addRows(plain, 0, 2, [["", ""]]))))
      .not.toThrow();
    expect(() => checkTableTarget(plain, 0, { type: "deleteTable" })).not.toThrow();
  });

  it("refuses rows of different lengths", () => {
    let tab = buildTab([para("A"), { table: [["a\n", "b\n"], ["c\n"]] }, para("B")]);
    let content = read(tab);
    for (let change of [addRows(content, 0, 0, [["", ""]]), dropColumns(content, 0, 0)]) {
      expect(targetRefusal(tab, change)).toBe(
        `${change.type}: the rows of this table do not all have the same number of cells, so ` +
        "its rows and columns cannot be changed.");
    }
  });

  it("refuses a table whose HTML is not laid out as Google Docs lays tables out", () => {
    let before = docTabToMarkdown(BASIC());
    let broken = { ...before, markdown: before.markdown.replace("    <td><p>r0c0", "    <xd><p>r0c0") };
    expect(broken.markdown.length).toBe(before.markdown.length);
    let content = contentOf(broken);
    for (let change of [
      addRows(content, 0, 0, [["", ""]]), addColumns(content, 0, 0, [[""], [""]]),
      dropRows(content, 0, 0), dropColumns(content, 0, 0),
    ]) {
      let refused = message(() => applyTableChange(content, change, broken));
      expect(refused).toBe(notLaidOut(change.type));
      expect(message(() => tableChangeRequests(broken, change))).toBe(refused);
      expect(message(() => checkTableTarget(content, 0, shapeOf(change)))).toBe(refused);
    }
  });

  it("refuses a row or column that the table does not have", () => {
    let content = read(BASIC());
    expect(targetRefusal(BASIC(), addRows(content, 0, 3, [["", ""]])))
      .toBe("insertTableRows: at must be from 0 to 2, the table's number of rows.");
    expect(targetRefusal(BASIC(), addColumns(content, 0, 3, [[""], [""]])))
      .toBe("insertTableColumns: at must be from 0 to 2, the table's number of columns.");
    expect(targetRefusal(BASIC(), dropRows(content, 0, 1, 2)))
      .toBe("deleteTableRows: at and count must name rows of the table, which has 2.");
    expect(targetRefusal(BASIC(), dropColumns(content, 0, 2)))
      .toBe("deleteTableColumns: at and count must name columns of the table, which has 2.");
  });

  it("refuses to delete every row or column", () => {
    let content = read(BASIC());
    expect(targetRefusal(BASIC(), dropRows(content, 0, 0, 2))).toBe(
      "deleteTableRows: this would delete every row of the table. Use deleteTable() to delete " +
      "the table.");
    expect(targetRefusal(BASIC(), dropColumns(content, 0, 0, 2))).toBe(
      "deleteTableColumns: this would delete every column of the table. Use deleteTable() to " +
      "delete the table.");
  });

  it("widens a table only up to 20 columns, and leaves a wider one every other change", () => {
    let twenty = buildTab([para("Before"), sized(1, 20), para("After")]);
    expect(targetRefusal(twenty, addColumns(read(twenty), 0, 20, [[""]]))).toBe(
      "insertTableColumns: columns can be added only until a table has 20, and this one would " +
      "have 21.");
    let nineteen = buildTab([para("Before"), sized(1, 19), para("After")]);
    expectSameAsGoogle(nineteen, addColumns(read(nineteen), 0, 19, [["x"]]));
    expect(targetRefusal(nineteen, addColumns(read(nineteen), 0, 0, [["", ""]]))).toBe(
      "insertTableColumns: columns can be added only until a table has 20, and this one would " +
      "have 21.");

    let wide = buildTab([para("Before"), sized(2, 25), para("After")]);
    expect(targetRefusal(wide, addColumns(read(wide), 0, 0, [[""], [""]]))).toBe(
      "insertTableColumns: columns can be added only until a table has 20, and this one would " +
      "have 26.");
    expectSameAsGoogle(wide, addRows(read(wide), 0, 2, blank(1, 25)));
    expectSameAsGoogle(wide, dropColumns(read(wide), 0, 20, 5));
  });

  it("adds a column only to a table of at most 500 rows", () => {
    let tall = buildTab([para("Before"), sized(501, 1), para("After")]);
    expect(targetRefusal(tall, addColumns(read(tall), 0, 1, blank(501, 1)))).toBe(
      "insertTableColumns: columns can be added only to a table of at most 500 rows, and this " +
      "one has 501.");
    let applied = expectSameAsGoogle(tall, addRows(read(tall), 0, 501, [["more"]]));
    expect(tableTexts(applied).length).toBe(502);

    let limit = buildTab([para("Before"), sized(500, 1), para("After")]);
    let cells = Array.from({ length: 500 }, (_, row) => [row % 7 === 0 ? `new${row}` : ""]);
    let widened = expectSameAsGoogle(limit, addColumns(read(limit), 0, 1, cells));
    expect(tableTexts(widened)[497]).toEqual(["r497c0\n", "new497\n"]);
  });

  it("refuses a deletion of more rows than one batch holds requests", () => {
    let tab = buildTab([para("Before"), sized(19_007, 1, ""), para("After")]);
    let before = docTabToMarkdown(tab);
    let content = contentOf(before);
    let tooMany = dropRows(content, 0, 1, 19_006);
    let refused = "deleteTableRows: deleting 19006 rows needs more than 19005 requests, the " +
      "most one change may send. Delete them in several calls.";
    expect(message(() => applyTableChange(content, tooMany, before))).toBe(refused);
    expect(message(() => tableChangeRequests(before, tooMany))).toBe(refused);
    expect(message(() => checkTableTarget(content, 0, shapeOf(tooMany), before))).toBe(refused);
    // Behind an earlier change, where the content does not read as the tab does.
    let altered = applyTextReplacement(
      content, replacementIn(content.markdown, "Before", "Earlier"), TAB);
    expect(message(() => applyTableChange(altered, tooMany, before))).toBe(refused);

    let most = dropRows(content, 0, 1, 19_005);
    expect(applyTableChange(content, most, before).tables[0].rows.length).toBe(2);
    expect(tableChangeRequests(before, most).length).toBe(19_005);
  });
});

const placedAfter = (tab: GoogleDocsTab, after: string | undefined): string =>
  docTabToMarkdown(expectSameAsGoogle(tab, newTable([["t"]], after))).markdown;

describe("a table with no paragraph on one side", () => {
  const first = buildTab([grid(["a", "b"]), para("After")]);
  const last = buildTab([para("Before"), grid(["a", "b"])]);

  it("still takes row, column and cell changes", () => {
    for (let tab of [first, last]) {
      let content = read(tab);
      expect(tableAt(applyTableChange(content, addRows(content, 0, 1, [["c", "d"]])), 0))
        .toBe(tableHtml([["a", "b"], ["c", "d"]]));
      expect(tableAt(applyTableChange(content, dropColumns(content, 0, 0)), 0))
        .toBe(tableHtml([["b"]]));
      let start = content.markdown.indexOf("<p>a</p>");
      let replaced = replaceTableText(content, start, "<p>a</p>", "<p>changed</p>", TAB);
      expect(replaced && tableAt(replaced.content, 0)).toBe(tableHtml([["changed", "b"]]));
    }
  });

  it("refuses to delete the table, in both forms", () => {
    for (let tab of [first, last]) {
      expect(judge(tab, dropTable(read(tab), 0)))
        .toEqual({ document: notLaidOut("deleteTable"), view: notLaidOut("deleteTable") });
    }
  });
});

describe("the tables of a replayed change", () => {
  it("carry no index of the document for a table the change touched", () => {
    let tab = buildTab([para("Before"), grid(["a"]), para("Mid"), grid(["b"]), para("After")]);
    let before = docTabToMarkdown(tab);
    let content = contentOf(before);
    let replaced = replaceTableText(
      content, content.markdown.indexOf("<p>a</p>"), "<p>a</p>", "<p>changed</p>", TAB);
    for (let changed of [
      applyTableChange(content, addRows(content, 0, 1, [["x"]]), before),
      applyTableChange(content, addColumns(content, 0, 1, [["x"]]), before),
      applyTableChange(content, newTable([["x"]], "Before"), before),
      replaced?.content,
    ]) {
      expect(Object.keys(changed?.tables[0] ?? {}).toSorted()).toEqual(["mdEnd", "mdStart", "rows"]);
    }
    // Nothing is changed in the content a change is replayed over.
    expect(content).toEqual(contentOf(docTabToMarkdown(tab)));
  });
});

describe("refusals for where a new table goes", () => {
  const RESULTS = buildTab([
    para("Notes"), heading("Results"), para("Body"), heading("Results summary"), para("Notes"),
    heading("Budget"), para("End"),
  ]);
  const T = tableHtml([["t"]]);

  it("refuses an after that is missing or repeated", () => {
    expect(refusal(RESULTS, newTable([["t"]], "Nowhere"))).toBe(NOT_FOUND_REFUSAL);
    expect(refusal(RESULTS, newTable([["t"]], "## Results"))).toBe(AMBIGUOUS_REFUSAL);
    expect(refusal(RESULTS, newTable([["t"]], "Notes"))).toBe(AMBIGUOUS_REFUSAL);
    // A stored after always names text; one of line breaks alone is not found.
    expect(refusal(RESULTS, newTable([["t"]], "\n\n"))).toBe(NOT_FOUND_REFUSAL);
  });

  it("names the paragraph a line break ends, and a later one when text follows the anchor", () => {
    expect(placedAfter(RESULTS, "## Results\n")).toContain(`## Results\n\n${T}\n\n\n\nBody\n`);
    expect(placedAfter(RESULTS, "Notes\n\n## Budget")).toContain(`## Budget\n\n${T}\n\n\n\nEnd\n`);
    expectViewSameAsGoogle(RESULTS, newTable([["t"]], "## Results\n"));
  });

  it("names a tab's first paragraph by the line break in front of it", () => {
    let notes = buildTab([para("Notes"), para("Intro"), heading("Notes"), para("More")]);
    for (let after of ["Notes", "Notes\n", "Notes\n\n"]) {
      expect(refusal(notes, newTable([["t"]], after))).toBe(AMBIGUOUS_REFUSAL);
    }
    for (let after of ["\nNotes", "\nNotes\n"]) {
      expect(placedAfter(notes, after).startsWith(`Notes\n\n${T}\n\n\n\nIntro\n`)).toBe(true);
      expectViewSameAsGoogle(notes, newTable([["t"]], after));
    }
    for (let after of ["\n## Notes", "## Notes"]) {
      expect(placedAfter(notes, after)).toContain(`## Notes\n\n${T}\n\n\n\nMore\n`);
    }

    let summary = buildTab(
      [heading("Summary", 1), para("Intro"), heading("Summary"), para("More")]);
    expect(placedAfter(summary, "\n# Summary").startsWith(`# Summary\n\n${T}\n`)).toBe(true);

    let scope = buildTab([para("Notes"), para("Intro"), para("Notes on scope")]);
    expect(refusal(scope, newTable([["t"]], "\nNotes"))).toBe(AMBIGUOUS_REFUSAL);
    expect(placedAfter(scope, "\nNotes\n").startsWith(`Notes\n\n${T}\n`)).toBe(true);

    let twice = buildTab([para("Notes"), para("Intro"), para("Notes")]);
    expect(refusal(twice, newTable([["t"]], "\nNotes\n"))).toBe(AMBIGUOUS_REFUSAL);
    expect(placedAfter(twice, "Intro\n\nNotes").endsWith(`Intro\n\nNotes\n\n${T}\n\n\n`))
      .toBe(true);

    let led = buildTab([para(""), para("Notes"), para("End")]);
    expect(placedAfter(led, "\nNotes")).toBe(placedAfter(led, "Notes"));
  });

  it("refuses a table after a table of contents, in both forms", () => {
    let tab = buildTab([para("Before"), toc, para("After")]);
    expect(judge(tab, newTable([["t"]], "[Table of contents]")))
      .toEqual({ document: TOC_REFUSAL, view: TOC_REFUSAL });
  });

  it("refuses a table between two items of one list", () => {
    let tab = buildTab([item("one"), item("two"), para("After")], ALL_LISTS);
    let refused = "insertTable: a table cannot be added between two items of a list. Name the " +
      "list's last item instead.";
    expect(judge(tab, newTable([["t"]], "one"))).toEqual({ document: refused, view: refused });
    expect(judge(tab, newTable([["t"]], "two"))).toEqual({ document: undefined, view: undefined });
  });

  it("refuses a table at the end of a tab that does not end in a paragraph", () => {
    for (let last of [grid(["x"]), toc]) {
      let tab = buildTab([para("Before"), last]);
      expect(judge(tab, newTable([["t"]])))
        .toEqual({ document: NO_LAST_PARAGRAPH, view: NO_LAST_PARAGRAPH });
    }
  });

  it("refuses a table after a table that no paragraph follows", () => {
    let tab = buildTab([para("Before"), grid(["x"])]);
    expect(judge(tab, newTable([["t"]], "x")))
      .toEqual({ document: notLaidOut("insertTable"), view: notLaidOut("insertTable") });
  });
});

const tabCells = (op: string, held: number) =>
  `${op}: tables, rows and columns can be added only until the tables of a tab hold 5000 cells ` +
  `in all, a cell counting once for each paragraph in it, and those of this tab would hold ${held}.`;

const tenCells = (text = "x") => [Array.from({ length: 10 }, () => text)];

describe("the cells a tab's tables hold", () => {
  /** 4,980 cells in one table and 10 in a second: 4,990 in all. */
  const FULL = buildTab(
    [para("Before"), sized(498, 10), para("Mid"), sized(1, 10, "s"), para("After")]);
  const full = docTabToMarkdown(FULL);
  const content = contentOf(full);

  it("takes an addition that brings the tab's tables to the limit", () => {
    let applied = expectSameAsGoogle(FULL, addRows(content, 1, 1, tenCells()));
    expect(tableTexts(applied, 1).length).toBe(2);
  });

  it("refuses rows, a column and a table that would pass it", () => {
    let grown = applyTableChange(content, addRows(content, 1, 1, tenCells()), full);
    let second = addRows(grown, 1, 2, tenCells());
    expect(message(() => applyTableChange(grown, second, full)))
      .toBe(tabCells("insertTableRows", 5010));
    expect(message(() => checkTabTableCells(grown, addedTableCells(second), second.type)))
      .toBe(tabCells("insertTableRows", 5010));

    let column = addColumns(content, 0, 10, blank(498, 1));
    expect(refusal(FULL, column)).toBe(tabCells("insertTableColumns", 5488));
    expect(message(() => checkTabTableCells(content, addedTableCells(column), column.type)))
      .toBe(tabCells("insertTableColumns", 5488));

    for (let after of [undefined, "After", "Nowhere", "Mid\n"]) {
      expect(refusal(FULL, newTable(blank(1, 11), after))).toBe(tabCells("insertTable", 5001));
    }
  });

  it("counts a cell once for each paragraph it holds", () => {
    let paragraphs = [["a\nb", ...tenCells()[0].slice(1)]];
    expect(addedTableCells(addRows(content, 1, 1, paragraphs))).toBe(11);
    expect(refusal(FULL, addRows(content, 1, 1, paragraphs)))
      .toBe(tabCells("insertTableRows", 5001));
    expect(addedTableCells(dropRows(content, 1, 0))).toBe(0);
    expect(addedTableCells(dropTable(content, 1))).toBe(0);

    // Two editable paragraphs, a cell of a chip, and a merged cell with the cell it covers.
    let mixed = read(buildTab([
      para("Before"),
      {
        table: [
          [cellOf(para("one"), para("two")), cellOf(chip())],
          [{ paragraphs: [para("head")], tableCellStyle: { columnSpan: 2 } }, "\n"],
        ],
      },
      para("After"),
    ]));
    expect(message(() => checkTabTableCells(mixed, MAX_TAB_TABLE_CELLS, "insertTable")))
      .toBe(tabCells("insertTable", 5005));
    expect(() => checkTabTableCells(mixed, 0, "insertTable")).not.toThrow();
  });

  it("leaves a tab whose tables hold more every change that adds nothing", () => {
    let over = buildTab([para("Before"), sized(251, 20), para("After")]);
    let held = read(over);
    expect(refusal(over, addRows(held, 0, 251, blank(1, 20))))
      .toBe(tabCells("insertTableRows", 5040));
    expect(refusal(over, newTable([["x"]]))).toBe(tabCells("insertTable", 5021));
    expectSameAsGoogle(over, dropRows(held, 0, 3, 2));
    expectSameAsGoogle(over, dropColumns(held, 0, 19));
    expectSameAsGoogle(over, dropTable(held, 0));
    expectCellTextSameAsGoogle(over, "<p>r7c3</p>", "<p>changed</p>");
  });

  it("counts the content the change is replayed over", () => {
    let shrunk = applyTableChange(content, dropRows(content, 0, 100, 10), full);
    expect(message(() => applyTableChange(shrunk, addColumns(shrunk, 0, 10, blank(488, 1)), full)))
      .toBe(tabCells("insertTableColumns", 5378));
    let eleven = Array.from({ length: 11 }, () => tenCells()[0]);
    expect(applyTableChange(shrunk, addRows(shrunk, 1, 1, eleven), full).tables[1].rows.length)
      .toBe(12);
    expect(refusal(FULL, addRows(content, 1, 1, eleven))).toBe(tabCells("insertTableRows", 5100));
  });
});

const LONE_CHIP = (row: number) =>
  `insertTableRows: row ${row} of this table, counting from 0, has a cell that holds smart chips ` +
  "and no text, which Google Docs copies into a row added beside it in a way that is not " +
  "supported: add the row in Google Docs.";
const CHIP_COLUMN = (column: number, row: number, kind = "dropdown") =>
  `insertTableRows: column ${column} of this table, counting from 0, holds a ${kind} alone in ` +
  `row ${row}, which Google Docs copies into the new rows, so their cells in that column take ` +
  "no text. Leave them empty, and change the copies in Google Docs.";

/** Turn the first element of a cell's paragraph into an inline image. */
function makeInlineImage(tab: GoogleDocsTab, row: number, column: number): void {
  let { paragraph } = cellParagraph(tab, row, column);
  let { startIndex, endIndex } = paragraph.elements[0];
  paragraph.elements[0] = { startIndex, endIndex, inlineObjectElement: { inlineObjectId: "image" } };
}

/** A table whose last cell holds these paragraphs, each given as its runs. */
const chips = (...cell: Runs[]) => buildTab([
  para("Before"),
  { table: [["a\n", "b\n"], ["c\n", cellOf(...cell.map(runs => ({ runs })))]] },
  para("After"),
]);

/** A table whose last row holds a dropdown alone in its first cell. */
const chipFirst = () => buildTab([
  para("Before"),
  { table: [["a\n", "b\n"], [cellOf({ runs: [{ dropdown: "Open" }, "\n"] }), "d\n"]] },
  para("After"),
]);

/** What a cell's first paragraph holds: its text runs, and `chip` for any other element. */
const held = (tab: GoogleDocsTab, row: number, column: number): string[] =>
  cellParagraph(tab, row, column).paragraph.elements.map(element =>
    element.textRun?.content ?? "chip");

describe("a chip alone in a cell", () => {
  const CHIPS = chips([{ dropdown: "Not started" }, "\n"]);

  it("copies a dropdown alone into a row added beside it, which takes no text there", () => {
    let content = read(CHIPS);
    for (let change of [
      addRows(content, 0, 2, [["x", ""]]), addRows(content, 0, 2, [["", ""], ["y"]]),
      addRows(content, 0, 1, [["x"]]), addRows(content, 0, 0, [["x", "y"]]),
    ]) {
      expectSameAsGoogle(CHIPS, change);
    }
    let applied = expectSameAsGoogle(CHIPS, addRows(content, 0, 2, [["x", ""]]));
    expect(held(applied, 2, 0)).toEqual(["x", "\n"]);
    expect(held(applied, 2, 1)).toEqual(["chip", "\n"]);
    // A copy is a chip alone in its cell, which a row added beside it copies again.
    let after = docTabToMarkdown(applied);
    expect(tableRowCells(after.sourceMap.tables[0], 2)[1])
      .toMatchObject({ texts: [], loneChip: true, copies: "dropdown", unshown: true });
    expectSameAsGoogle(applied, addRows(contentOf(after), 0, 3, [["z", ""]]));

    expect(refusal(CHIPS, addRows(content, 0, 2, [["x", "y"]]))).toBe(CHIP_COLUMN(1, 1));
    expect(refusal(CHIPS, addRows(content, 0, 1, [["", ""], ["", "y"]])))
      .toBe(CHIP_COLUMN(1, 1));
    // A new column copies no chip.
    expectSameAsGoogle(CHIPS, addColumns(content, 0, 2, [["x"], ["y"]]));
    expectSameAsGoogle(CHIPS, addColumns(content, 0, 1, [["x"], ["y"]]));
  });

  it("copies a person chip, date chip, rich link or placeholder alone as the placeholder", () => {
    for (let runs of [[person("Ana"), "\n"], [person(), "\n"], [{ date: "Nov 8, 2026" }, "\n"],
      ["\uE907\n"], [{ richLink: { title: "Plan", uri: "https://x.example/" } }, "\n"],
      [person("Ana"), "  \n"]] as Runs[]) {
      let tab = () => chips(runs);
      let content = read(tab());
      let applied = expectSameAsGoogle(tab(), addRows(content, 0, 2, [["x", ""], ["y"]]));
      expect([2, 3].map(row => held(applied, row, 1))).toEqual([["\uE907", "\n"], ["\uE907", "\n"]]);
      expect(refusal(tab(), addRows(content, 0, 2, [["x", "y"]])))
        .toBe(CHIP_COLUMN(1, 1, "smart chip"));
    }
  });

  it("fills the cells after a copied chip at their own places", () => {
    let content = read(chipFirst());
    for (let change of [
      addRows(content, 0, 2, [["", "y"]]), addRows(content, 0, 2, [["", ""], ["", "y"], ["", "z"]]),
      addRows(content, 0, 1, [["", "y"], ["", "z"]]),
    ]) {
      expectSameAsGoogle(chipFirst(), change);
    }
    let applied = expectSameAsGoogle(chipFirst(), addRows(content, 0, 2, [["", ""], ["", "y"]]));
    expect(held(applied, 3, 0)).toEqual(["chip", "\n"]);
    expect(held(applied, 3, 1)).toEqual(["y", "\n"]);
  });

  it("copies nothing of several chips, so the new cells take text", () => {
    for (let runs of [[person("Ana"), person("Ben"), "\n"],
      [person("Ana"), { date: "Nov 8, 2026" }, "\n"]] as Runs[]) {
      let tab = () => chips(runs);
      expect(tableRowCells(read(tab()).tables[0], 1)[1])
        .toMatchObject({ loneChip: true, copies: "nothing" });
      let applied = expectSameAsGoogle(tab(), addRows(read(tab()), 0, 2, [["x", "y"]]));
      expect(held(applied, 2, 1)).toEqual(["y", "\n"]);
    }
  });

  it("refuses every other cell of chips and no text", () => {
    let alone: Runs[] = [
      [" ", person("Ana"), "\n"], [person("Ana"), "\uE907\n"], [{ dropdown: "Open" }, " \n"],
      [{ dropdown: "Open" }, person("Ana"), "\n"],
    ];
    for (let runs of alone) {
      let tab = chips(runs);
      expect(targetRefusal(tab, addRows(read(tab), 0, 2, [["x", ""]]))).toBe(LONE_CHIP(1));
    }
    let beside = chips([{ dropdown: "Open" }, { dropdown: "image" }, "\n"]);
    makeInlineImage(beside, 1, 1);
    expect(targetRefusal(beside, addRows(read(beside), 0, 2, [["x", ""]]))).toBe(LONE_CHIP(1));
  });

  it("adds a row beside a chip with text, a chip among paragraphs and an inline image", () => {
    let withText: Runs[][] = [
      [["Owner: ", person("Ana"), "\n"]], [[person("Ana"), ", ", person("Ben"), "\n"]],
      [[person("Ana"), "\n"], ["\n"]],
    ];
    for (let cell of withText) {
      let tab = () => chips(...cell);
      expectSameAsGoogle(tab(), addRows(read(tab()), 0, 2, [["x", "y"]]));
    }
    let image = chips([{ dropdown: "image" }, "\n"]);
    makeInlineImage(image, 1, 1);
    expectSameAsGoogle(image, addRows(read(image), 0, 2, [["x", "y"]]));
  });
});

const suggestedRefusal = (op: string) =>
  `${op}: this table holds suggested changes to its rows, columns or cells, so its rows and ` +
  "columns cannot be changed until they are accepted or rejected.";

describe("a table that holds suggestions", () => {
  const rows = [["a\n", "b\n"], ["c\n", "d\n"], ["e\n", "f\n"]];
  const tabs: [string, () => GoogleDocsTab][] = [
    ["a suggested row", () => buildTab(
      [para("Before"), { table: rows, suggestedRows: { 1: "insertion" } }, para("After")])],
    ["a row suggested for deletion", () => buildTab(
      [para("Before"), { table: rows, suggestedRows: { 1: "deletion" } }, para("After")])],
    ["a suggested cell", () => buildTab([
      para("Before"),
      { table: [["a\n", "b\n"], ["c\n", { paragraphs: [para("d")], suggested: "insertion" }], ["e\n", "f\n"]] },
      para("After"),
    ])],
    ["a table that is itself suggested", () => {
      let tab = buildTab([para("Before"), { table: rows }, para("After")]);
      let { table } = tableElement(tab);
      if (table) table.suggestedInsertionIds = ["suggest.table"];
      return tab;
    }],
  ];

  for (let [name, tab] of tabs) {
    it(`refuses row and column changes on a table with ${name}, and deletes it`, () => {
      let content = read(tab());
      expect(content.tables[0].suggested).toBe(true);
      // Refused before `at` is looked at: none of these names a row or column of the table.
      for (let change of [
        addRows(content, 0, 9, [["", ""]]), addColumns(content, 0, 9, [[""], [""], [""]]),
        dropRows(content, 0, 9), dropColumns(content, 0, 9),
      ]) {
        expect(targetRefusal(tab(), change)).toBe(suggestedRefusal(change.type));
      }
      let { simulated } = expectCellTextSameAsGoogle(tab(), "<p>a</p>", "<p>changed</p>");
      expect(simulated.tables[0].suggested).toBe(true);
      expectSameAsGoogle(tab(), dropTable(content, 0));
      expect(kinds(tableChangeRequests(docTabToMarkdown(tab()), dropTable(content, 0))))
        .toEqual(["deleteContentRange"]);
    });
  }
});

const cameToHoldChips = (op: string) =>
  `${op}: what would be deleted has come to hold a dropdown or other smart chips, which ` +
  "getContent() does not show, since this change was queued.";
/** A status table whose row 1 has an empty status cell, or `cell` in its place. */
const statusTab = (cell: CellSpec = "\n") => buildTab([
  para("Before"),
  { table: [["Task\n", "Status\n"], ["Fix login\n", cell], ["Ship docs\n", "Done\n"]] },
  para("After"),
]);
/** The same table with a dropdown alone in that cell, which reads as the empty cell does. */
const dropdownTab = () => statusTab(cellOf({ runs: [{ dropdown: "Blocked" }, "\n"] }));
/** The deletion of that cell's row, of its column and of its table, as queued over `content`. */
const statusDeletions = (content: EditableMarkdown): TableChange[] =>
  [dropRows(content, 0, 1), dropColumns(content, 0, 1), dropTable(content, 0)];

describe("a deletion whose cells have come to hold what its card did not say", () => {
  it("refuses a deletion queued before a cell it removes came to hold a dropdown", () => {
    // A dropdown reads as nothing, so the table reads as recorded with and without it.
    expect(read(dropdownTab()).markdown).toBe(read(statusTab()).markdown);
    for (let change of statusDeletions(read(statusTab()))) {
      expect(change).not.toHaveProperty("unshown");
      expectSameAsGoogle(statusTab(), change);
      expect(refusal(dropdownTab(), change)).toBe(cameToHoldChips(change.type));
    }
  });

  it("applies a deletion that recorded the dropdown, with it and once it is gone", () => {
    for (let change of statusDeletions(read(dropdownTab()))) {
      expect(change).toMatchObject({ unshown: true });
      expectSameAsGoogle(dropdownTab(), change);
      expectSameAsGoogle(statusTab(), change);
    }
  });

  it("looks only at the cells the deletion removes", () => {
    let content = read(statusTab());
    for (let change of [dropRows(content, 0, 2), dropColumns(content, 0, 0)]) {
      expect(change).not.toHaveProperty("unshown");
      expectSameAsGoogle(dropdownTab(), change);
    }
  });

  it("refuses the deletion of a table that came to hold suggestions, unless it recorded them", () => {
    let rows = [["a\n", "b\n"], ["c\n", "d\n"]];
    let plain = () => buildTab([para("Before"), { table: rows }, para("After")]);
    let suggested = () => buildTab(
      [para("Before"), { table: rows, suggestedRows: { 1: "deletion" } }, para("After")]);
    expect(read(suggested()).markdown).toBe(read(plain()).markdown);

    let queuedBefore = dropTable(read(plain()), 0);
    expect(queuedBefore).not.toHaveProperty("suggested");
    expect(refusal(suggested(), queuedBefore)).toBe(
      "deleteTable: this table has come to hold suggested changes to its rows, columns or " +
      "cells since this change was queued.");

    let queuedWith = dropTable(read(suggested()), 0);
    expect(queuedWith).toMatchObject({ suggested: true });
    expectSameAsGoogle(suggested(), queuedWith);
    expectSameAsGoogle(plain(), queuedWith);

    // A suggestion in a table inside a cell is deleted with the cell, so it counts the same.
    let holding = (suggestedRows?: Record<number, "deletion">) => buildTab([
      para("Before"),
      { table: [[{ paragraphs: [
        { runs: ["\n"] }, { table: rows, ...(suggestedRows ? { suggestedRows } : {}) },
        { runs: ["\n"] },
      ] }, "x\n"], ["y\n", "z\n"]] },
      para("After"),
    ]);
    expect(read(holding({ 0: "deletion" })).markdown).toBe(read(holding()).markdown);
    let outer = dropTable(read(holding()), 0);
    expect(outer).not.toHaveProperty("suggested");
    expect(refusal(holding({ 0: "deletion" }), outer)).toBe(
      "deleteTable: this table has come to hold suggested changes to its rows, columns or " +
      "cells since this change was queued.");
    expect(refusal(holding({ 0: "deletion" }), dropRows(read(holding()), 0, 0))).toBe(
      "deleteTableRows: this table holds suggested changes to its rows, columns or cells, so " +
      "its rows and columns cannot be changed until they are accepted or rejected.");
    expect(dropTable(read(holding({ 0: "deletion" })), 0)).toMatchObject({ suggested: true });
  });

  it("carries what a deletion would remove through the changes queued before it", () => {
    let content = read(dropdownTab());
    let grown = applyTableChange(content, addRows(content, 0, 0, [["new", "row"]]));
    // The dropdown's row has moved down by one.
    expect(dropRows(grown, 0, 2)).toMatchObject({ unshown: true });
    expect(dropRows(grown, 0, 0)).not.toHaveProperty("unshown");
    expect(dropRows(grown, 0, 1)).not.toHaveProperty("unshown");
  });
});

const POSITIONED_REFUSAL = "insertTable: a table cannot be added beside a paragraph that holds " +
  "a positioned image. Name other text for the table to follow.";

/** A tab of these blocks, with a positioned object anchored to the body paragraphs named. */
function positionedTab(blocks: BlockSpec[], ...paragraphs: number[]): GoogleDocsTab {
  let tab = buildTab(blocks, ALL_LISTS);
  for (let index of paragraphs) bodyParagraph(tab, index).positionedObjectIds = ["object"];
  return tab;
}

describe("a positioned image", () => {
  const refused = { document: POSITIONED_REFUSAL, view: POSITIONED_REFUSAL };
  const accepted = { document: undefined, view: undefined };

  it("stays with the text of a paragraph a table is added after", () => {
    let tab = positionedTab([para("Before"), para("Anchored"), para("After")], 1);
    expect(judge(tab, newTable([["t"]], "Anchored"))).toEqual(accepted);
    let markdown = docTabToMarkdown(expectSameAsGoogle(tab, newTable([["t"]], "Anchored"))).markdown;
    expect(markdown).toContain(`[Image] Anchored\n\n${tableHtml([["t"]])}`);
    let last = positionedTab([para("Before"), para("Anchored")], 1);
    expect(judge(last, newTable([["t"]]))).toEqual(accepted);
  });

  it("refuses a table that would cut the paragraph at its start", () => {
    let afterTable = positionedTab(
      [para("Before"), grid(["x"]), para("Anchored"), para("After")], 1);
    expect(judge(afterTable, newTable([["t"]], "x"))).toEqual(refused);
    let bare = positionedTab([para("Before"), grid(["x"]), para(""), para("After")], 1);
    expect(judge(bare, newTable([["t"]], "x"))).toEqual(refused);
  });

  it("refuses a table after an empty paragraph that holds one", () => {
    let tab = positionedTab([para("Before"), para(""), para("After")], 1);
    expect(judge(tab, newTable([["t"]], "[Image]"))).toEqual(refused);
    let last = positionedTab([para("Before"), para("")], 1);
    expect(judge(last, newTable([["t"]]))).toEqual(refused);
    let two = positionedTab([para("Before"), para("")], 1);
    bodyParagraph(two, 1).positionedObjectIds = ["one", "two"];
    expect(judge(two, newTable([["t"]]))).toEqual(refused);
  });

  it("is told from typed text only by the document", () => {
    // Typed text that starts with the mark, in a paragraph that is read-only for its chip.
    let typed = buildTab([
      para("Before"), { runs: ["[Image] ", { date: "Nov 8, 2026" }, "\n"] }, para("After"),
    ]);
    expect(judge(typed, newTable([["t"]], "Nov 8, 2026"))).toEqual(accepted);
    // The mark alone, beside a chip that renders as nothing: the view takes it for an empty
    // paragraph that holds a positioned image.
    let mark = buildTab([para("Before"), quietChip("[Image]"), para("After")]);
    expect(judge(mark, newTable([["t"]], "[Image]")))
      .toEqual({ document: undefined, view: POSITIONED_REFUSAL });
    let afterTable = buildTab([
      para("Before"), grid(["x"]), { runs: ["[Image] ", { date: "Nov 8, 2026" }, "\n"] }, para("After"),
    ]);
    expect(judge(afterTable, newTable([["t"]], "x")))
      .toEqual({ document: undefined, view: POSITIONED_REFUSAL });
  });

  it("stays with a chip that renders as nothing, which only the document tells from none", () => {
    let tab = positionedTab([para("Before"), quietChip(), para("After")], 1);
    expect(read(tab).markdown).toBe("Before\n\n[Image]\n\nAfter\n");
    expect(judge(tab, newTable([["t"]], "[Image]")))
      .toEqual({ document: undefined, view: POSITIONED_REFUSAL });
    let last = positionedTab([para("Before"), quietChip()], 1);
    expect(judge(last, newTable([["t"]])))
      .toEqual({ document: undefined, view: POSITIONED_REFUSAL });
    let markdown = docTabToMarkdown(expectSameAsGoogle(last, newTable([["t"]]))).markdown;
    expect(markdown).toBe(`Before\n\n[Image]\n\n${tableHtml([["t"]])}\n\n\n`);
  });
});

let numberedLineFollows = (op: string) =>
  `${op}: what would be deleted holds items of a numbered list, and a line that reads as a ` +
  "numbered list item follows it in the tab, which the deletion could renumber. Retry once " +
  "the earlier changes to this tab have been approved or rejected: the document then shows " +
  "whether that line is a list item.";

/** A stored replacement of the one cell that reads `from` by one that reads `to`. */
const inCell = (markdown: string, from: string, to: string) => ({
  ...replacementIn(markdown, `<td><p>${from}</p></td>`, `<td><p>${to}</p></td>`),
  inTable: true as const,
});

describe("the document form and the view form", () => {
  it("deletes a table between paragraphs that only read as list items", () => {
    let tab = buildTab(
      [para("1. First caption"), grid(["x"]), para("2. Second caption"), para("End")]);
    expect(judge(tab, dropTable(read(tab), 0)))
      .toEqual({ document: undefined, view: LIST_ITEMS_READ });
  });

  it("deletes numbered cells before a paragraph that only reads as a numbered item", () => {
    let tab = buildTab([
      para("Before"),
      { table: [[cellOf(item("one", "N1")), "a\n"], [cellOf(item("two", "N1")), "b\n"]] },
      para("2. A caption"),
    ], ALL_LISTS);
    let content = read(tab);
    for (let change of [dropRows(content, 0, 1), dropTable(content, 0)]) {
      expect(judge(tab, change))
        .toEqual({ document: undefined, view: numberedLineFollows(change.type) });
    }
  });

  it("sees two items of a list with no marker only in the document", () => {
    let between = buildTab(
      [item("quiet one", "Q1"), grid(["x"]), item("quiet two", "Q1"), para("End")], ALL_LISTS);
    expect(judge(between, dropTable(read(between), 0))).toEqual({
      document: "deleteTable: this table sits between two items of one list, which deleting it " +
        "would join. That is not supported.",
      view: undefined,
    });
    let emptyNext = buildTab([item("quiet one", "Q1"), item("", "Q1"), para("End")], ALL_LISTS);
    expect(judge(emptyNext, newTable([["t"]], "quiet one"))).toEqual({
      document: "insertTable: a table cannot be added between two items of a list. Name the " +
        "list's last item instead.",
      view: undefined,
    });
  });

  it("deletes a table between items of two different lists", () => {
    let tab = () => buildTab(
      [item("one", "L1"), grid(["x"]), item("two", "L2"), para("End")], ALL_LISTS);
    expect(judge(tab(), dropTable(read(tab()), 0)))
      .toEqual({ document: undefined, view: LIST_ITEMS_READ });
    let applied = expectSameAsGoogle(tab(), dropTable(read(tab()), 0));
    expect(docTabToMarkdown(applied).markdown).toBe("- one\n\n- two\n\nEnd\n");
    let same = buildTab([item("one"), grid(["x"]), item("two"), para("End")], ALL_LISTS);
    expect(judge(same, dropTable(read(same), 0)).document).toBe(
      "deleteTable: this table sits between two items of one list, which deleting it would " +
      "join. That is not supported.");
  });

  it("judges a change behind edits that cancel out by the view once one of them has applied", () => {
    let tab = buildTab(
      [item("one", "L1"), grid(["x"]), item("two", "L2"), para("End")], ALL_LISTS);
    let snapshot = docTabToMarkdown(tab);
    // A cell replaced and replaced back leaves the content reading as the tab does, so the
    // deletion queued behind the two is judged by the document: its neighbours are in two lists.
    let there = inCell(snapshot.markdown, "x", "y");
    let changed = applyTextReplacement(contentOf(snapshot), there, TAB);
    let back = inCell(changed.markdown, "y", "x");
    let restored = applyTextReplacement(changed, back, TAB);
    expect(restored.markdown).toBe(snapshot.markdown);
    let deletion = dropTable(restored, 0);
    expect(applyTableChange(restored, deletion, snapshot).markdown).toBe("- one\n\n- two\n\nEnd\n");
    expect(tableChangeRequests(snapshot, deletion)).toHaveLength(1);

    // With the first replacement applied, the content behind the second no longer reads as the
    // tab does. The view judges the deletion, and takes the two lines for items of one list.
    let applied = applyDocsRequests(tab, textReplacementRequests(snapshot, there), MODELS[0]);
    let fresh = docTabToMarkdown(applied);
    let behind = applyTextReplacement(contentOf(fresh), back, TAB);
    expect(behind.markdown).toBe(snapshot.markdown);
    expect(message(() => applyTableChange(behind, deletion, fresh))).toBe(LIST_ITEMS_READ);

    // Had it reached the front of the queue, the document would have decided again.
    let front = applyDocsRequests(applied, textReplacementRequests(fresh, back), MODELS[0]);
    expect(docTabToMarkdown(expectSameAsGoogle(front, deletion)).markdown)
      .toBe("- one\n\n- two\n\nEnd\n");
  });

  it("tells a table of contents from a paragraph that reads as one only by the document", () => {
    let typed = () => buildTab([
      para("Before"), quietChip("[Table of contents]"), grid(["x"]), para("After"),
    ]);
    expect(judge(typed(), newTable([["t"]], "[Table of contents]")))
      .toEqual({ document: undefined, view: TOC_REFUSAL });
    expect(judge(typed(), dropTable(read(typed()), 0)))
      .toEqual({ document: undefined, view: notLaidOut("deleteTable") });

    let real = buildTab([para("Before"), toc, para(""), grid(["x"]), para("After")]);
    expect(judge(real, newTable([["t"]], "[Table of contents]")))
      .toEqual({ document: TOC_REFUSAL, view: TOC_REFUSAL });
    let beside = buildTab([para("Before"), toc, grid(["x"]), para("After")]);
    expect(judge(beside, dropTable(read(beside), 0)))
      .toEqual({ document: notLaidOut("deleteTable"), view: notLaidOut("deleteTable") });
  });
});

// ---------------------------------------------------------------------------
// What a deletion may not hold
// ---------------------------------------------------------------------------

const cited = (number: number): CellSpec => cellOf({ runs: ["cited", footnote(number), "\n"] });

const holdsFootnote = (op: string) =>
  `${op}: what would be deleted holds a footnote. Deleting a footnote renumbers those after ` +
  "it, which is not supported.";

/** A footnote in row 0, one in the paragraph after the table and one in a later table. */
const footnotesTab = (last = false) => buildTab([
  para("Before"),
  { table: [[cited(1), "b\n"], ["c\n", "d\n"]] },
  ...(last ? [para("After")] : [
    { runs: ["After", footnote(2), "\n"] }, grid(["plain"]), para("Mid"), { table: [[cited(3)]] },
    para("End"),
  ]),
]);

describe("footnotes in what is deleted", () => {
  it("refuses to delete a row, a column or a table that holds one, whatever follows", () => {
    for (let last of [false, true]) {
      let content = read(footnotesTab(last));
      for (let change of [
        dropRows(content, 0, 0), dropColumns(content, 0, 0), dropTable(content, 0),
      ]) {
        expect(targetRefusal(footnotesTab(last), change)).toBe(holdsFootnote(change.type));
        expect(message(() => applyTableChange(content, change))).toBe(holdsFootnote(change.type));
      }
    }
  });

  it("deletes what holds none, and the footnotes after it keep their numbers", () => {
    let content = read(footnotesTab());
    for (let change of [
      dropRows(content, 0, 1), dropColumns(content, 0, 1), dropTable(content, 1),
    ]) {
      let markdown = docTabToMarkdown(expectSameAsGoogle(footnotesTab(), change)).markdown;
      expect(markdown).toContain("After\\[2\\]");
      expect(markdown).toContain("cited[3]");
    }
  });

  it("refuses a cell whose nested table holds the footnote", () => {
    let nested = buildTab([
      para("Before"),
      { table: [[cellOf(para("x"), { table: [[cited(1)]] }, para("y")), "b\n"], ["c\n", "d\n"]] },
      para("After"),
    ]);
    let content = read(nested);
    for (let change of [
      dropRows(content, 0, 0), dropColumns(content, 0, 0), dropTable(content, 0),
    ]) {
      expect(targetRefusal(nested, change)).toBe(holdsFootnote(change.type));
    }
  });
});

const numberedFollows = (op: string) =>
  `${op}: what would be deleted holds items of a numbered list, and a numbered list follows ` +
  "it in the tab, which the deletion could renumber. That is not supported.";

describe("items of a numbered list in what is deleted", () => {
  /** A table whose first column is one numbered list down its rows. */
  const listed: TableSpec = {
    table: ["one", "two", "three"].map((text, index) => [cellOf(item(text, "N1")), `c${index}\n`]),
  };
  const tab = (...following: BlockSpec[]) =>
    buildTab([para("Before"), listed, para("After"), ...following], ALL_LISTS);

  it("refuses a deletion while a later row, table or body item continues the list", () => {
    let alone = read(tab());
    expect(targetRefusal(tab(), dropRows(alone, 0, 0))).toBe(numberedFollows("deleteTableRows"));
    expect(targetRefusal(tab(), dropRows(alone, 0, 1))).toBe(numberedFollows("deleteTableRows"));
    for (let following of [
      [item("four", "N1"), para("End")],
      [{ table: [[cellOf(item("four", "N1"))]] }, para("End")] satisfies BlockSpec[],
    ]) {
      let content = read(tab(...following));
      for (let change of [
        dropRows(content, 0, 2), dropColumns(content, 0, 0), dropTable(content, 0),
      ]) {
        expect(targetRefusal(tab(...following), change)).toBe(numberedFollows(change.type));
      }
    }
  });

  it("deletes them when no ordered list follows", () => {
    let content = read(tab());
    for (let change of [
      dropRows(content, 0, 2), dropColumns(content, 0, 0), dropTable(content, 0),
    ]) {
      expectSameAsGoogle(tab(), change);
      expectViewSameAsGoogle(tab(), change);
    }
  });

  it("refuses a bulleted item of a list that numbers a lower level", () => {
    let mixed = buildTab([
      para("Before"),
      { table: [[cellOf(item("top", "MIX"))], [cellOf(item("sub", "MIX", 1))], ["plain\n"]] },
      para("After"),
    ], ALL_LISTS);
    let content = read(mixed);
    expect(tableAt(content, 0)).not.toContain("<ol><li>top");
    expect(targetRefusal(mixed, dropRows(content, 0, 0))).toBe(numberedFollows("deleteTableRows"));
  });

  it("deletes rows that hold no list item, or bullets of a list that numbers nothing", () => {
    let bullets = buildTab([
      item("zero", "N1"), para("Before"),
      { table: [[cellOf(item("bullet"))], ["plain\n"], ["more\n"]] },
      item("one", "N1"), item("two", "N1"), para("End"),
    ], ALL_LISTS);
    for (let row of [0, 1]) {
      let markdown = docTabToMarkdown(expectSameAsGoogle(bullets, dropRows(read(bullets), 0, row))).markdown;
      // The list goes on after the table at the number it had: a continued item reads `1.`.
      expect(markdown).toContain("</table>\n\n2. one\n1. two\n");
      expectViewSameAsGoogle(bullets, dropRows(read(bullets), 0, row));
    }
  });
});

// ---------------------------------------------------------------------------
// The text of cells
// ---------------------------------------------------------------------------

type Runs = ParagraphSpec["runs"];
type RelativeRequest =
  | ["delete", number, number]
  | ["insert", number, string]
  | ["style", number, number, TextStyle, string];

/** Requests on one paragraph, with their indexes counted from the paragraph's start. */
function relative(requests: readonly GoogleDocsRequest[], start: number): RelativeRequest[] {
  return requests.map((request): RelativeRequest => {
    if ("deleteContentRange" in request) {
      let { startIndex, endIndex } = request.deleteContentRange.range;
      return ["delete", startIndex - start, endIndex - start];
    }
    if ("insertText" in request) {
      return ["insert", request.insertText.location.index - start, request.insertText.text];
    }
    if ("updateTextStyle" in request) {
      let { range, textStyle, fields } = request.updateTextStyle;
      return ["style", range.startIndex - start, range.endIndex - start, textStyle, fields];
    }
    throw new Error(`Unexpected request ${Object.keys(request).join()}`);
  });
}

/**
 * A replacement of the text of the one paragraph of a single-cell table, through the property.
 * `oldHtml` and `newHtml` are the paragraph's text; the requests come back counted from the
 * paragraph's start.
 */
function oneCell(runs: Runs, oldHtml: string, newHtml: string, wrap = "p") {
  let tab = buildTab([
    para("Before"), { table: [[cellOf({ runs: [...runs, "\n"] })]] }, para("After"),
  ]);
  let start = cellParagraph(tab, 0, 0).start;
  let result = expectCellTextSameAsGoogle(
    tab, `<${wrap}>${oldHtml}</${wrap}>`, `<${wrap}>${newHtml}</${wrap}>`);
  let html = tableAt(result.simulated, 0);
  return {
    ...result,
    tab,
    start,
    /** The requests as they are sent. */
    raw: result.requests,
    requests: relative(result.requests, start),
    /** The paragraph's text as the replay leaves it. */
    html: html.slice("<table>\n  <tr>\n    <td><p>".length, -"</p></td>\n  </tr>\n</table>".length),
  };
}

const bold = (text: string) => ({ text, style: { bold: true } });
const RESET = (start: number, end: number): RelativeRequest =>
  ["style", start, end, {}, FOUR_FIELDS];

describe("the text of table cells", () => {
  const CELLS = buildTab([
    para("Before"),
    {
      table: [
        ["Fix login\n", "Open\n"],
        [cellOf({ runs: [bold("bold"), " plain\n"] }), "\n"],
        [cellOf(heading("Title"), para("first"), para("second")), cellOf(item("one"), item("two"))],
      ],
    },
    para("After"),
  ], ALL_LISTS);
  const edit = (oldMarkdown: string, newMarkdown: string) =>
    expectCellTextSameAsGoogle(CELLS, oldMarkdown, newMarkdown);

  it("replaces text in one cell, in several, in an empty one, and empties one", () => {
    expect(tableTexts(edit("<p>Open</p>", "<p>Done</p>").applied)[0][1]).toBe("Done\n");
    let several = edit(
      "<td><p>Fix login</p></td>\n    <td><p>Open</p></td>",
      "<td><p>Fix logout</p></td>\n    <td><p>Closed</p></td>");
    expect(tableTexts(several.applied)[0]).toEqual(["Fix logout\n", "Closed\n"]);
    expect(tableTexts(edit("<td><p></p></td>", "<td><p>filled</p></td>").applied)[1][1])
      .toBe("filled\n");
    expect(tableTexts(edit("<p>Open</p>", "<p></p>").applied)[0][1]).toBe("\n");
    expect(tableTexts(edit("<p>Open</p>", "<p>Open now</p>").applied)[0][1]).toBe("Open now\n");
  });

  it("changes only the range and the styles that differ", () => {
    let start = cellParagraph(CELLS, 0, 1).start;
    expect(relative(edit("<p>Open</p>", "<p>Opened</p>").requests, start))
      .toEqual([["insert", 4, "ed"], RESET(4, 6)]);
    expect(relative(edit("<p>Open</p>", "<p>Oven</p>").requests, start))
      .toEqual([["delete", 1, 2], ["insert", 1, "v"], RESET(1, 2)]);
    expect(relative(edit("<p>Open</p>", "<p><em>Open</em></p>").requests, start))
      .toEqual([["style", 0, 4, { italic: true }, "italic"]]);
  });

  it("keeps text typed into bold text bold, and adds and removes formatting", () => {
    let inBold = edit("<strong>bold</strong> plain", "<strong>bolder</strong> plain");
    expect(tableAt(inBold.simulated, 0)).toContain("<p><strong>bolder</strong> plain</p>");
    for (let [oldHtml, newHtml] of [
      ["<p>Open</p>", "<p><strong>Open</strong></p>"],
      ["<p>Open</p>", "<p>O<em>pe</em>n</p>"],
      ["<p>Open</p>", "<p><s>Open</s> again</p>"],
      ["<p>Open</p>", "<p><a href=\"https://x.example/\">Open</a></p>"],
      ["<p>Open</p>", "<p><a href=\"mailto:a@b.example\"><strong><em><s>Op</s></em></strong></a>en</p>"],
      ["<strong>bold</strong> plain", "bold plain"],
      ["<strong>bold</strong> plain", "<strong>bo</strong>ld <strong>plain</strong>"],
      ["<p>Open</p>", "<p>Op<br>en</p>"],
      ["<p>Open</p>", "<p>a &amp; b &lt; c &gt; d</p>"],
    ]) {
      expect(tableAt(edit(oldHtml, newHtml).simulated, 0)).toContain(newHtml);
    }
  });

  it("reads a bare & and > as text, and shows them escaped", () => {
    let { simulated, applied } = edit("<p>Open</p>", "<p>a & b > c &amp d</p>");
    expect(tableAt(simulated, 0)).toContain("<p>a &amp; b &gt; c &amp;amp d</p>");
    expect(tableTexts(applied)[0][1]).toBe("a & b > c &amp d\n");
  });

  it("replaces text in a heading, in a list item and in one paragraph of several", () => {
    expect(tableAt(edit("<h2>Title</h2>", "<h2>New <em>title</em></h2>").simulated, 0))
      .toContain("<h2>New <em>title</em></h2>\n      <p>first</p>\n      <p>second</p>");
    expect(tableAt(edit("<p>second</p>", "<p>2nd</p>").simulated, 0))
      .toContain("<p>first</p>\n      <p>2nd</p>");
    let bullet = edit("<li>\u25cf two</li>", "<li>\u25cf second item</li>");
    expect(tableAt(bullet.simulated, 0))
      .toContain("<li>\u25cf one</li><li>\u25cf second item</li>");
    // Texts after a changed one in the same cell move with it.
    let both = edit(
      "<h2>Title</h2>\n      <p>first</p>", "<h2>A longer title</h2>\n      <p>1st</p>");
    expect(tableAt(both.simulated, 0))
      .toContain("<h2>A longer title</h2>\n      <p>1st</p>\n      <p>second</p>");
  });

  it("shows runs that differ only in an unseen style as one element", () => {
    let sizedRun: ModelTextStyle = { fontSize: { magnitude: 14, unit: "PT" } };
    let { html, applied } = oneCell(
      ["Hello ", { text: "World", style: sizedRun }], "Hello World", "Hello <strong>there</strong> World");
    expect(html).toBe("Hello <strong>there</strong> World");
    expect(cellParagraph(applied, 0, 0).paragraph.elements.length).toBeGreaterThan(2);
  });

  it("leaves a link the HTML does not show on text whose formatting changes", () => {
    let hidden = { text: "call", style: { link: { url: "tel:123" } } };
    let { applied, requests, html } = oneCell([hidden], "call", "<strong>call</strong>");
    expect(requests).toEqual([["style", 0, 4, { bold: true }, "bold"]]);
    expect(html).toBe("<strong>call</strong>");
    expect(cellParagraph(applied, 0, 0).paragraph.elements[0].textRun?.textStyle)
      .toMatchObject({ bold: true, link: { url: "tel:123" } });
  });
});

describe("existing characters that Google strips from inserted text", () => {
  const BULLET = "\uF0B7";
  const text = `${BULLET} Item one`;

  it("counts offsets from the text as the document has it", () => {
    let after = oneCell([text], text, `${BULLET} Item two`);
    expect(after.requests).toEqual([["delete", 7, 10], ["insert", 7, "two"], RESET(7, 10)]);
    expect(cellText(after.applied, 0, 0)).toBe(`${BULLET} Item two\n`);
    expect(after.html).toBe(`${BULLET} Item two`);

    let before = oneCell([text], text, `New${text}`);
    expect(before.requests).toEqual([["insert", 0, "New"], RESET(0, 3)]);
    expect(before.html).toBe(`New${text}`);
  });

  it("drops the character only where the replacement rewrites the text around it", () => {
    let around = oneCell([text], text, `Other${BULLET}words`);
    expect(around.requests).toEqual([["delete", 0, 10], ["insert", 0, "Otherwords"], RESET(0, 10)]);
    expect(around.html).toBe("Otherwords");
    expect(cellText(around.applied, 0, 0)).toBe("Otherwords\n");
  });

  it("shows a new text that holds such a character without it", () => {
    let content = read(BASIC());
    let oldMarkdown = "<p>r0c0</p>";
    let newMarkdown = `<p>r0${BULLET}c0!</p>`;
    let shown = replaceTableText(
      content, content.markdown.indexOf(oldMarkdown), oldMarkdown, newMarkdown, TAB)?.shown;
    expect(shown).toEqual({ old: oldMarkdown, requested: newMarkdown, rendered: "<p>r0c0!</p>" });
    expectCellTextSameAsGoogle(BASIC(), oldMarkdown, newMarkdown);
  });
});

describe("surrogate pairs", () => {
  it("replaces an emoji by one that shares its high surrogate, whole", () => {
    let status = oneCell(["\u{1F7E2} On track"], "\u{1F7E2} On track", "\u{1F534} Blocked");
    expect(status.requests)
      .toEqual([["delete", 0, 11], ["insert", 0, "\u{1F534} Blocked"], RESET(0, 10)]);
    let swapped = oneCell(["Smile \u{1F600} now"], "Smile \u{1F600} now", "Smile \u{1F601} now");
    expect(swapped.requests).toEqual([["delete", 6, 8], ["insert", 6, "\u{1F601}"], RESET(6, 8)]);
  });

  it("removes the first of two emoji that share a high surrogate, whole", () => {
    let removed = oneCell(["\u{1F600}\u{1F601}x"], "\u{1F600}\u{1F601}x", "\u{1F601}x");
    expect(removed.requests).toEqual([["delete", 0, 2]]);
  });
});

describe("existing text that reads like an escape", () => {
  it("counts offsets from the text decoded once", () => {
    let lessThan = oneCell(["use &lt; here"], "use &amp;lt; here", "use &amp;lt; there");
    expect(lessThan.requests).toEqual([["insert", 9, "t"], RESET(9, 10)]);
    expect(lessThan.html).toBe("use &amp;lt; there");
    let ampersand = oneCell(["a &amp; b"], "a &amp;amp; b", "a &amp;amp; bc");
    expect(ampersand.requests).toEqual([["insert", 9, "c"], RESET(9, 10)]);
    expect(cellText(ampersand.applied, 0, 0)).toBe("a &amp; bc\n");
  });
});

// ---------------------------------------------------------------------------
// Links in the text of cells
// ---------------------------------------------------------------------------

const X = "https://x.example/";
const C = "https://c.example/";
const OLD = "http://old.example/";
const NEW = "https://new.example/";
const url = (destination: string) => ({ link: { url: destination } });
const a = (destination: string, html: string) => `<a href="${destination}">${html}</a>`;

/** A run that is a link as Google makes one: with its colour and underline, at 14 pt. */
function linked(
  text: string, destination = X, more: TextStyle = {},
): { text: string; style: TextStyle } {
  let style: ModelTextStyle = {
    ...url(destination), ...more, underline: true, foregroundColor: LINK_COLOR,
    fontSize: { magnitude: 14, unit: "PT" },
  };
  return { text, style };
}

type OneCell = ReturnType<typeof oneCell>;

/** The document the model leaves, with text whose link is removed restyled or not. */
const under = (result: OneCell, unlinkRestyles: boolean, requests = result.raw): GoogleDocsTab =>
  applyDocsRequests(result.tab, requests, { unlinkRestyles });

/** The font size each character of `[from, to)` of the paragraph carries, under both models. */
function sizes(result: OneCell, from: number, to: number): (number | undefined)[][] {
  return [false, true].map(unlinkRestyles => Array.from({ length: to - from }, (_, index) =>
    fontSizeAt(under(result, unlinkRestyles), result.start + from + index)));
}

const all = (length: number, size: number | undefined) =>
  [false, true].map(() => Array.from({ length }, () => size));

/** Whether each character of `[from, to)` has the look of a link, under both models. */
function looks(result: OneCell, from: number, to: number): boolean[] {
  return [false, true].flatMap(unlinkRestyles => Array.from({ length: to - from }, (_, index) =>
    hasLinkLook(under(result, unlinkRestyles), result.start + from + index)));
}

/** No request clears a link by naming `link` alone, and none gives the link's look a value. */
function expectCarefulUnlinks(requests: readonly RelativeRequest[]): void {
  for (let request of requests) {
    if (request[0] !== "style") continue;
    let [, , , textStyle, fields] = request;
    if (fields === "link") expect(textStyle.link).toBeDefined();
    expect(Object.keys(textStyle)).not.toContain("underline");
    expect(Object.keys(textStyle)).not.toContain("foregroundColor");
  }
}

describe("links in the text of cells", () => {
  it("clears a link on part of another before it sets one there", () => {
    let relinked = oneCell([linked("Docs home")], a(X, "Docs home"), a(X, "Docs ") + a(C, "home"));
    expect(relinked.requests)
      .toEqual([["style", 5, 9, {}, FOUR_FIELDS], ["style", 5, 9, url(C), "link"]]);
    expect(relinked.html).toBe(a(X, "Docs ") + a(C, "home"));

    let unlinked = oneCell([linked("Docs home")], a(X, "Docs home"), `${a(X, "Docs ")}home`);
    expect(unlinked.requests).toEqual([["style", 5, 9, {}, SIX_FIELDS]]);

    let other = oneCell(
      [linked("Docment")], a(X, "Docment"), a(X, "Doc") + a(C, "u") + a(X, "ment"));
    expect(other.html).toBe(a(X, "Doc") + a(C, "u") + a(X, "ment"));
    let none = oneCell([linked("Docment")], a(X, "Docment"), `${a(X, "Doc")}u${a(X, "ment")}`);
    expect(none.html).toBe(`${a(X, "Doc")}u${a(X, "ment")}`);
    for (let result of [relinked, unlinked, other, none]) expectCarefulUnlinks(result.requests);
  });

  it("states the three shown styles in the request that clears a link", () => {
    let mail = "mailto:a@b.example";
    let ana = oneCell(
      [bold("Owner: "), linked("Ana", mail)],
      `<strong>Owner: </strong>${a(mail, "Ana")}`, "<strong>Owner: </strong>Ana");
    expect(ana.requests).toEqual([["style", 7, 10, {}, SIX_FIELDS]]);
    expect(ana.html).toBe("<strong>Owner: </strong>Ana");
    expect(looks(ana, 7, 10)).not.toContain(true);

    let boldLink = oneCell(
      ["see ", linked("Docs", X, { bold: true })], `see ${a(X, "<strong>Docs</strong>")}`,
      "see <strong>Docs</strong>");
    expect(boldLink.requests).toEqual([["style", 4, 8, { bold: true }, SIX_FIELDS]]);

    let styled = "<strong><em>";
    let half = oneCell(
      [linked("Docs home", X, { bold: true, italic: true })],
      a(X, `${styled}Docs home</em></strong>`),
      a(X, `${styled}Docs </em></strong>`) + a(C, `${styled}home</em></strong>`));
    expect(half.requests).toEqual([
      ["style", 5, 9, { bold: true, italic: true }, FOUR_FIELDS], ["style", 5, 9, url(C), "link"],
    ]);
    for (let result of [ana, boldLink, half]) expectCarefulUnlinks(result.requests);
  });

  it("sets the link again on a word corrected inside it, and clears nothing", () => {
    let corrected = oneCell([linked("Docment")], a(X, "Docment"), a(X, "Document"));
    expect(corrected.requests).toEqual([["insert", 3, "u"], ["style", 3, 4, url(X), FOUR_FIELDS]]);
    expect(corrected.html).toBe(a(X, "Document"));
    expect(sizes(corrected, 0, 8)).toEqual(all(8, 14));
    expect(looks(corrected, 0, 8)).not.toContain(false);

    let inBold = oneCell(
      [linked("Docment", X, { bold: true })], a(X, "<strong>Docment</strong>"),
      a(X, "<strong>Document</strong>"));
    expect(inBold.requests)
      .toEqual([["insert", 3, "u"], ["style", 3, 4, { bold: true, ...url(X) }, FOUR_FIELDS]]);
    expect(sizes(inBold, 0, 8)).toEqual(all(8, 14));
  });

  it("gives text added at the edge of a link, where its paragraph's text ends, the link", () => {
    let atEnd = oneCell([linked("Docs")], a(X, "Docs"), a(X, "Docs home"));
    expect(atEnd.requests).toEqual([["insert", 4, " home"], ["style", 4, 9, url(X), FOUR_FIELDS]]);
    expect(atEnd.html).toBe(a(X, "Docs home"));
    expect(sizes(atEnd, 0, 4)).toEqual(all(4, 14));

    let atStart = oneCell(
      [linked("Docs"), " now"], `${a(X, "Docs")} now`, `${a(X, "My Docs")} now`);
    expect(atStart.requests).toEqual([["insert", 0, "My "], ["style", 0, 3, url(X), FOUR_FIELDS]]);
    expect(atStart.html).toBe(`${a(X, "My Docs")} now`);
    expect(sizes(atStart, 0, 7)).toEqual(all(3, undefined).map(none => [...none, 14, 14, 14, 14]));

    // The added text is in the link only because of that request: Google styles it from the
    // other side, so without the request it stands outside the link.
    for (let [result, outside] of [
      [atEnd, `${a(X, "Docs")} home`], [atStart, `My ${a(X, "Docs")} now`],
    ] as const) {
      let html = tableAt(read(under(result, false, result.raw.slice(0, -1))), 0);
      expect(html).toContain(`<p>${outside}</p>`);
    }
  });

  it("resets and then links text added at the end of a link that more text follows", () => {
    let followed = oneCell([linked("Docs"), "."], `${a(X, "Docs")}.`, `${a(X, "Docs home")}.`);
    expect(followed.requests).toEqual([
      ["insert", 4, " home"], ["style", 4, 9, {}, SIX_FIELDS], ["style", 4, 9, url(X), "link"],
    ]);
    expect(followed.html).toBe(`${a(X, "Docs home")}.`);
    // It took its style from the full stop after it.
    expect(sizes(followed, 4, 9)).toEqual(all(5, undefined));

    let between = oneCell(
      [linked("Docs"), linked("Site", C)], a(X, "Docs") + a(C, "Site"), a(X, "Docs home") + a(C, "Site"));
    expect(between.requests).toEqual([
      ["insert", 4, " home"], ["style", 4, 9, {}, SIX_FIELDS], ["style", 4, 9, url(X), "link"],
    ]);
  });

  it("points a link elsewhere whole in one request for each stretch, and clears nothing", () => {
    let whole = oneCell([linked("Docs", OLD)], a(OLD, "Docs"), a(NEW, "Docs"));
    expect(whole.requests).toEqual([["style", 0, 4, url(NEW), "link"]]);
    expect(sizes(whole, 0, 4)).toEqual(all(4, 14));

    let halfBold = oneCell(
      [linked("Do", OLD, { bold: true }), linked("cs", OLD)],
      a(OLD, "<strong>Do</strong>") + a(OLD, "cs"), a(NEW, "<strong>Do</strong>") + a(NEW, "cs"));
    expect(halfBold.requests)
      .toEqual([["style", 0, 2, url(NEW), "link"], ["style", 2, 4, url(NEW), "link"]]);

    let madeBold = oneCell([linked("Docs", OLD)], a(OLD, "Docs"), a(NEW, "<strong>Docs</strong>"));
    expect(madeBold.requests).toEqual([["style", 0, 4, { bold: true, ...url(NEW) }, "bold,link"]]);

    let extended = oneCell([linked("Docs", OLD)], a(OLD, "Docs"), a(NEW, "Docs home"));
    expect(extended.requests).toEqual([
      ["insert", 4, " home"], ["style", 4, 9, {}, SIX_FIELDS], ["style", 4, 9, url(NEW), "link"],
      ["style", 0, 4, url(NEW), "link"],
    ]);
    expect(sizes(extended, 0, 4)).toEqual(all(4, 14));
  });

  it("clears a link pointed elsewhere in part, beside text that keeps it", () => {
    let result = oneCell([linked("wxyz")], a(X, "wxyz"), a(X, "bb") + a(C, "z"));
    expect(result.requests).toEqual([
      ["delete", 0, 3], ["insert", 0, "bb"], ["style", 0, 2, url(X), FOUR_FIELDS],
      ["style", 2, 3, {}, FOUR_FIELDS], ["style", 2, 3, url(C), "link"],
    ]);
    expect(result.html).toBe(a(X, "bb") + a(C, "z"));
    // Set without the clear, the new link would repoint the text that keeps the old one.
    let repointed = under(
      result, false, [...result.raw.slice(0, -2), result.raw[result.raw.length - 1]]);
    expect(tableAt(read(repointed), 0)).toContain(`<p>${a(C, "bbz")}</p>`);
  });

  it("clears every stretch of a link of which only a part is pointed elsewhere", () => {
    // Three stretches of one link; the last keeps it, so neither of the others is set directly.
    let partly = oneCell(
      [linked("aa", OLD, { bold: true }), linked("bb", OLD), linked("cc", OLD, { bold: true })],
      a(OLD, "<strong>aa</strong>") + a(OLD, "bb") + a(OLD, "<strong>cc</strong>"),
      a(NEW, "<strong>aa</strong>") + a(NEW, "bb") + a(OLD, "<strong>cc</strong>"));
    expect(partly.requests).toEqual([
      ["style", 0, 2, { bold: true }, FOUR_FIELDS], ["style", 0, 2, url(NEW), "link"],
      ["style", 2, 4, {}, FOUR_FIELDS], ["style", 2, 4, url(NEW), "link"],
    ]);
    // Two links that trade places: each one's run holds text the other link is given.
    let traded = oneCell(
      [linked("ab"), linked("cd", C)], a(X, "ab") + a(C, "cd"), a(C, "ab") + a(X, "cd"));
    expect(traded.requests).toEqual([
      ["style", 0, 2, {}, FOUR_FIELDS], ["style", 0, 2, url(C), "link"],
      ["style", 2, 4, {}, FOUR_FIELDS], ["style", 2, 4, url(X), "link"],
    ]);
    expect(traded.html).toBe(a(C, "ab") + a(X, "cd"));
  });

  it("resets only the unlinked part of text inserted inside a link", () => {
    let mixed = oneCell([linked("Docment")], a(X, "Docment"), `${a(X, "Doc")}X${a(X, "ument")}`);
    expect(mixed.requests).toEqual([
      ["insert", 3, "Xu"], ["style", 3, 4, {}, SIX_FIELDS], ["style", 4, 5, url(X), FOUR_FIELDS],
    ]);
    expect(mixed.html).toBe(`${a(X, "Doc")}X${a(X, "ument")}`);
    expectCarefulUnlinks(mixed.requests);
  });

  it("gives a link its look, and takes it from text left with no link", () => {
    expect(looks(oneCell(["Open"], "Open", a(X, "Open")), 0, 4)).not.toContain(false);
    expect(looks(oneCell([linked("Docs")], a(X, "Docs"), `${a(X, "Docs")} (draft)`), 4, 12))
      .not.toContain(true);
    expect(looks(oneCell([linked("Docs")], a(X, "Docs"), `See ${a(X, "Docs")}`), 0, 4))
      .not.toContain(true);
    expect(looks(oneCell([linked("Docs")], a(X, "Docs"), "plain"), 0, 5)).not.toContain(true);
    expect(looks(oneCell([linked("Docs")], a(X, "Docs"), a(X, "Documents")), 0, 9))
      .not.toContain(false);
  });

  it("leaves a colour that is not a link's on text beside a change", () => {
    let red: ModelTextStyle = { foregroundColor: { color: { rgbColor: { red: 1 } } } };
    let result = oneCell([{ text: "red text here", style: red }], "red text here", "red word here");
    expect(result.requests).toEqual([["delete", 4, 8], ["insert", 4, "word"], RESET(4, 8)]);
    let runs = cellParagraph(result.applied, 0, 0).paragraph.elements.flatMap(({ textRun }) =>
      textRun && textRun.content !== "\n" ? [textRun] : []);
    expect(runs.map(run => run.content).join("")).toBe("red word here");
    for (let run of runs) expect(run.textStyle).toEqual(red);
    expectCarefulUnlinks(result.requests);
  });

  it("writes a heading or bookmark link with its tab, and keeps one the document shows", () => {
    let headingLink = oneCell(["Open"], "Open", a("#heading=h.x", "Open"));
    expect(headingLink.html).toBe(a("?tab=tab-1#heading=h.x", "Open"));
    // Text that showed no link may hide one, so the link is cleared before it is set.
    expect(headingLink.requests).toEqual(
      [RESET(0, 4), ["style", 0, 4, { link: { heading: { id: "h.x", tabId: TAB } } }, "link"]]);
    let bookmark = oneCell(["Open"], "Open", a("#bookmark=b.y", "Open"));
    expect(bookmark.html).toBe(a("?tab=tab-1#bookmark=b.y", "Open"));
    expect(bookmark.requests).toEqual(
      [RESET(0, 4), ["style", 0, 4, { link: { bookmark: { id: "b.y", tabId: TAB } } }, "link"]]);
    let otherTab = oneCell(["Open"], "Open", a("?tab=t.2#heading=h.x", "Open"));
    expect(otherTab.html).toBe(a("?tab=t.2#heading=h.x", "Open"));
    expect(otherTab.requests).toEqual(
      [RESET(0, 4), ["style", 0, 4, { link: { heading: { id: "h.x", tabId: "t.2" } } }, "link"]]);

    // A link the document holds without a tab reads `#heading=…` and stays so.
    let bare = { text: "Intro", style: { link: { headingId: "h.x" } } };
    let shown = a("#heading=h.x", "Intro");
    let beside = oneCell([bare, " rest"], `${shown} rest`, `${shown} rested`);
    expect(beside.requests).toEqual([["insert", 10, "ed"], RESET(10, 12)]);
    expect(beside.html).toBe(`${shown} rested`);
    for (let written of ["#heading=h.x", "?tab=tab-1#heading=h.x"]) {
      let inside = oneCell([bare, " rest"], `${shown} rest`, `${a(written, "Intero")} rest`);
      expect(inside.requests)
        .toEqual(
          [["insert", 3, "e"], ["style", 3, 4, { link: { headingId: "h.x" } }, FOUR_FIELDS]]);
      expect(inside.html).toBe(`${a("#heading=h.x", "Intero")} rest`);
    }
  });
});

const shownFor = (runs: Runs, oldMarkdown: string, newMarkdown: string) => {
  let content = read(
    buildTab([para("Before"), { table: [[cellOf({ runs: [...runs, "\n"] })]] }, para("After")]));
  return replaceTableText(content, content.markdown.indexOf(oldMarkdown), oldMarkdown, newMarkdown, TAB)?.shown;
};

describe("what the approval of a cell replacement shows", () => {

  it("shows the match where the canonical form changes nothing", () => {
    expect(shownFor(["Open"], "<p>Open</p>", "<p><em>Done</em></p>"))
      .toEqual({ old: "<p>Open</p>", requested: "<p><em>Done</em></p>", rendered: "<p><em>Done</em></p>" });
  });

  it("widens to the whole text where runs group across an end of the match", () => {
    expect(shownFor(["Hello ", bold("World")], "Hello ", "<strong>Hello </strong>")).toEqual({
      old: "Hello <strong>World</strong>",
      requested: "<strong>Hello </strong><strong>World</strong>",
      rendered: "<strong>Hello World</strong>",
    });
    expect(shownFor([{ text: "Hello ", style: { italic: true } }, "World"], "World", "<em>World</em>")).toEqual({
      old: "<em>Hello </em>World",
      requested: "<em>Hello </em><em>World</em>",
      rendered: "<em>Hello World</em>",
    });
  });

  it("shows the match alone where the text it canonicalizes lies inside it", () => {
    expect(shownFor(["Open"], "<p>Open</p>", "<p>a & b</p>"))
      .toEqual({ old: "<p>Open</p>", requested: "<p>a & b</p>", rendered: "<p>a &amp; b</p>" });
    expect(shownFor(["Open"], "<p>Open</p>", `<p>${a("#heading=h.x", "Open")}</p>`)).toEqual({
      old: "<p>Open</p>",
      requested: `<p>${a("#heading=h.x", "Open")}</p>`,
      rendered: `<p>${a("?tab=tab-1#heading=h.x", "Open")}</p>`,
    });
  });
});

// ---------------------------------------------------------------------------
// Refusals of a replacement in table cells
// ---------------------------------------------------------------------------

const WHITE_SPACE = "replaceText: the line breaks and indentation between a table's rows, " +
  "cells and paragraphs must stay exactly as getContent() returns them.";
const STRUCTURE = "replaceText: inside a table only the text of its cells can be replaced. " +
  "Change rows and columns with insertTableRows(), insertTableColumns(), deleteTableRows() " +
  "and deleteTableColumns(), and remove a table with deleteTable().";
const COVERED_CELL =
  "replaceText: a cell that a merged cell covers cannot be edited. Edit the merged cell.";
const NESTED_CELL = "replaceText: a cell that holds another table cannot be edited.";
const PARAGRAPH_BREAK = "replaceText: the text of a paragraph in a table cell cannot hold a " +
  "paragraph break. Write <br> for a line break within the paragraph; a paragraph cannot be " +
  "added to a cell.";
const PARAGRAPHS = "replaceText: a table cell keeps the paragraphs and list items it has: a " +
  "replacement cannot add or remove one. Write <br> for a line break within a paragraph.";
const LIST_ITEM = "replaceText: a list item in a table cell keeps its list tags and the " +
  "bullet character it starts with. Replace only the text after the bullet.";
const CELL_CONTENT = "replaceText: in a table cell only the text of existing paragraphs, " +
  "headings and list items can be replaced, and not that of a subtitle or of a paragraph " +
  "holding an image, smart chip or other element.";
const unsupportedTag = (name: string) =>
  `replaceText: <${name}> is not supported in a table cell. Use <strong>, <em>, <s>, ` +
  "<a href=\"...\"> and <br>, and write a literal < as &lt;.";
const NOTHING_ELSE = "replaceText: in a table cell <strong>, <em>, <s> and <br> are written " +
  "with nothing else in the tag.";
const TAG_ORDER = "replaceText: the HTML of a table cell must close every tag it opens, in order.";
const LINK_FORM = "replaceText: a link in a table cell is written <a href=\"URL\"> with " +
  "nothing else in the tag, where URL is an http, https or mailto URL or a link within this " +
  "document as getContent() returns it.";
const ESCAPES = "replaceText: only &amp;, &lt; and &gt; are escapes in a table cell. Write a " +
  "literal & as &amp;.";
const TOO_MANY_REQUESTS = "replaceText: this replacement in table cells needs more than 8000 " +
  "requests, the most one change may send. Change fewer cells or formatted stretches at once.";

/** What the replay and the request builder each refuse a cell replacement with. */
function cellRefusal(tab: GoogleDocsTab, oldMarkdown: string, newMarkdown: string): string {
  let before = docTabToMarkdown(tab);
  let { matchStart } = replacementIn(before.markdown, oldMarkdown, newMarkdown);
  let replayed = message(() =>
    replaceTableText(contentOf(before), matchStart, oldMarkdown, newMarkdown, TAB));
  expect(message(() => tableTextRequests(before, matchStart, oldMarkdown, newMarkdown)))
    .toBe(replayed);
  return replayed;
}

const tableRow = (...cells: string[]) =>
  `  <tr>\n${cells.map(text => `    <td><p>${text}</p></td>\n`).join("")}  </tr>\n`;

describe("refusals of a replacement in table cells", () => {
  const PLAIN = buildTab(
    [para("Before"), grid(["Task", "Status"], ["Fix login", "Open"]), para("After")]);
  const QUOTED = "<td><p>Fix login</p></td>\n    <td><p>Open</p></td>";
  /** `Open` in front of a cell merged over the one after it. */
  const MERGED = buildTab([
    para("Before"),
    {
      table: [[
        "Fix login\n", "Open\n", { paragraphs: [para("Notes")], tableCellStyle: { columnSpan: 2 } }, "\n",
      ]],
    },
    para("After"),
  ]);
  const SEVERAL = buildTab([
    para("Before"), { table: [[cellOf(para("First"), para("Second")), "Total\n"]] }, para("After"),
  ]);
  const WIDE = buildTab([
    para("Before"),
    grid(["Task", "Owner", "Status"], ["Fix login", "Ana", "Open"], ["Ship docs", "Ben", "Open"]),
    para("After"),
  ]);
  const WIDE_ROW = "    <td><p>Fix login</p></td>\n    <td><p>Ana</p></td>\n    <td><p>Open</p></td>\n";
  const ALL_ROWS = tableRow("Task", "Owner", "Status") + tableRow("Fix login", "Ana", "Open") +
    tableRow("Ship docs", "Ben", "Open");
  const LISTS = buildTab([
    item("Zero", "N1"),
    {
      table: [[
        cellOf(item("First"), item("Second")), cellOf(item("Step", "N1")),
        cellOf({ ...item("Title"), namedStyleType: "HEADING_2" }), "\n",
      ]],
    },
    para("After"),
  ], ALL_LISTS);
  const ODD = buildTab([
    para("Before"),
    {
      table: [[
        cellOf(chip("Owner: ")), cellOf({ runs: ["Sub\n"], namedStyleType: "SUBTITLE" }),
        cellOf(para("x"), grid(["in"]), para("y")),
      ]],
    },
    para("After"),
  ]);

  it("says so when only the white space between the table's tags differs", () => {
    for (let written of [
      "<td><p>Fix login</p></td>\n  <td><p>Done</p></td>",
      "<td><p>Fix login</p></td>\n\t<td><p>Done</p></td>",
      "<td><p>Fix login</p></td><td><p>Done</p></td>",
      "<td><p>Fix login</p></td>\n    <td><p>Done</p></td>\n",
    ]) {
      expect(cellRefusal(PLAIN, QUOTED, written)).toBe(WHITE_SPACE);
    }
    expect(cellRefusal(MERGED,
      "<td><p>Open</p></td>\n    <td colspan=\"2\">", "<td><p>Done</p></td>\n  <td colspan=\"2\">"))
      .toBe(WHITE_SPACE);
    expect(cellRefusal(SEVERAL, "<p>First</p>\n      <p>Second</p>", "<p>One</p>\n<p>Second</p>"))
      .toBe(WHITE_SPACE);
  });

  it("does not let a slip in the white space hide another mistake", () => {
    expect(cellRefusal(PLAIN, QUOTED, `${QUOTED.replace("Open", "Done")}\n    <td><p>New</p></td>`))
      .toBe(STRUCTURE);
    expect(cellRefusal(PLAIN, QUOTED, "<td><p>Fix login</p><p>more</p></td>\n    <td><p>Open</p></td>"))
      .toBe(PARAGRAPHS);
    expect(cellRefusal(MERGED,
      "<p>Notes</p></td>\n    <td><p></p></td>", "<p>Notes</p></td>\n  <td><p>x</p></td>"))
      .toBe(COVERED_CELL);
    expect(cellRefusal(WIDE, WIDE_ROW, "    <td><p>Fix login</p></td>\n  <td><p>Ana</p></td>\n"))
      .toBe(STRUCTURE);
    // White space beside the tags a text is written with is text.
    expectCellTextSameAsGoogle(
      PLAIN, QUOTED, "<td><p>Fix login </p></td>\n    <td><p>Open</p></td>");
    expectCellTextSameAsGoogle(
      PLAIN, QUOTED, "<td><p><strong>Fix</strong> <strong>login</strong></p></td>\n    <td><p>Open</p></td>");
  });

  it("replaces the text of a merged cell, which a replacement quoting its covered cells keeps", () => {
    let tall = buildTab([
      para("Before"),
      {
        table: [
          [{ paragraphs: [para("Q1")], tableCellStyle: { rowSpan: 2 } }, "Jan\n"],
          ["\n", "Feb\n"],
          ["Q2\n", "Apr\n"],
        ],
      },
      para("After"),
    ]);
    let square = buildTab([
      para("Before"),
      {
        table: [
          [{ paragraphs: [para("Total"), para("of all")], tableCellStyle:
            { rowSpan: 2, columnSpan: 2 } }, "\n", "a\n"],
          ["\n", "\n", "b\n"],
        ],
      },
      para("After"),
    ]);
    let replacements: [GoogleDocsTab, string, string][] = [
      [MERGED, "<p>Notes</p>", "<p>Note <strong>well</strong></p>"],
      [MERGED, "<td><p>Open</p></td>\n    <td colspan=\"2\"><p>Notes</p></td>",
        "<td><p>Done</p></td>\n    <td colspan=\"2\"><p>Notes</p></td>"],
      [MERGED, "<p>Notes</p></td>\n    <td><p></p></td>", "<p>Later</p></td>\n    <td><p></p></td>"],
      [tall, "<p>Q1</p>", "<p><em>First</em> quarter</p>"],
      [tall, "<p>Q1</p></td>\n    <td><p>Jan</p>", "<p>H1</p></td>\n    <td><p>January</p>"],
      [square, "<p>of all</p>", "<p>of <a href=\"https://e.com\">all</a></p>"],
      [square, "<p>Total</p>", "<p></p>"],
    ];
    for (let [tab, oldMarkdown, newMarkdown] of replacements) {
      expectCellTextSameAsGoogle(tab, oldMarkdown, newMarkdown);
    }
    expect(cellRefusal(tall, "<td><p></p></td>\n    <td><p>Feb</p>",
      "<td><p>covered</p></td>\n    <td><p>Feb</p>")).toBe(COVERED_CELL);
    expect(cellRefusal(square, "<td><p></p></td>\n    <td><p>b</p>",
      "<td><p>x</p></td>\n    <td><p>b</p>")).toBe(COVERED_CELL);
  });

  it("refuses a change in a cell a merged cell covers and in a cell that holds a table", () => {
    expect(cellRefusal(MERGED,
      "<p>Notes</p></td>\n    <td><p></p></td>", "<p>Notes</p></td>\n    <td><p>covered</p></td>"))
      .toBe(COVERED_CELL);
    expect(cellRefusal(MERGED,
      "<p>Notes</p></td>\n    <td><p></p></td>", "<p>Note</p></td>\n    <td><p>covered</p></td>"))
      .toBe(COVERED_CELL);
    expect(cellRefusal(MERGED, "<p>Notes</p></td>", "<p>Notes</p><p>More</p></td>"))
      .toBe(PARAGRAPHS);
    expect(cellRefusal(ODD, "<p>x</p>", "<p>changed</p>")).toBe(NESTED_CELL);
    expect(cellRefusal(ODD, "<p>in</p>", "<p>out</p>")).toBe(NESTED_CELL);
  });

  it("refuses a paragraph break typed into a text", () => {
    let empty = buildTab([para("Before"), grid(["Address", ""]), para("After")]);
    expect(cellRefusal(empty, "<td><p></p></td>", "<td><p>12 Main St\nSpringfield</p></td>"))
      .toBe(PARAGRAPH_BREAK);
    expect(cellRefusal(empty, "<td><p></p></td>", "<td><p>12 Main St\nSpringfield\nUSA</p></td>"))
      .toBe(PARAGRAPH_BREAK);
    expect(cellRefusal(LISTS, "<li>\u25cf Second</li>", "<li>\u25cf Sec\nond</li>"))
      .toBe(PARAGRAPH_BREAK);
  });

  it("refuses a list item written without its bullet or with its list's tag changed", () => {
    for (let [oldMarkdown, newMarkdown] of [
      ["<li>\u25cf Second</li>", "<li>Second item</li>"],
      ["<li>\u25cf Second</li>", "<li>- Second</li>"],
      ["<ul style=\"list-style-type: none\"><li>\u25cf First</li>", "<ul><li>\u25cf First</li>"],
      ["<ol start=\"2\"><li>Step</li>", "<ol><li>Step</li>"],
      ["<li><h2>\u25cf Title</h2></li>", "<li><h2>Title</h2></li>"],
    ]) {
      expect(cellRefusal(LISTS, oldMarkdown, newMarkdown)).toBe(LIST_ITEM);
    }
    expectCellTextSameAsGoogle(LISTS, "<li>\u25cf Second</li>", "<li>\u25cf Second item</li>");
    expectCellTextSameAsGoogle(
      LISTS, "<li><h2>\u25cf Title</h2></li>", "<li><h2>\u25cf New title</h2></li>");
  });

  it("refuses a paragraph or list item added to a cell or taken out of it", () => {
    let twoLines = "    <td>\n      <p>Open</p>\n      <p>since Monday</p>\n    </td>";
    let several = "    <td>\n      <p>First</p>\n      <p>Second</p>\n    </td>";
    let cases: [GoogleDocsTab, string, string][] = [
      [PLAIN, "    <td><p>Open</p></td>", twoLines],
      [PLAIN, `    ${QUOTED}`, `    <td><p>Fix login</p></td>\n${twoLines}`],
      [PLAIN, "<td><p>Open</p></td>", "<td><p>Open</p><p>since Monday</p></td>"],
      [SEVERAL, several, "    <td><p>First</p></td>"],
      [SEVERAL, several, "    <td>\n      <p>First</p>\n    </td>"],
      [SEVERAL, "      <p>Second</p>\n    </td>", "      <p>Second</p>\n      <p>Third</p>\n    </td>"],
      [LISTS, "<li>\u25cf Second</li></ul>", "<li>\u25cf Second</li><li>\u25cf Third</li></ul>"],
      [LISTS, "<li>\u25cf First</li><li>\u25cf Second</li></ul>", "<li>\u25cf First</li></ul>"],
    ];
    for (let [tab, oldMarkdown, newMarkdown] of cases) {
      expect(cellRefusal(tab, oldMarkdown, newMarkdown)).toBe(PARAGRAPHS);
    }
  });

  it("refuses anything else outside a cell's editable texts", () => {
    for (let [tab, oldMarkdown, newMarkdown] of [
      [ODD, "<p>Owner: Ana</p>", "<p>Owner: Ben</p>"],
      [ODD, "<p><em>Sub</em></p>", "<p><em>Subtitle</em></p>"],
      [PLAIN, "<td><p>Open</p></td>", "<td><h2>Open</h2></td>"],
      [PLAIN, "<td><p>Open</p></td>", "<td><p>Open</p>extra</td>"],
      [PLAIN, "<td><p>Open</p></td>\n", "<td><p>Open\n"],
    ] as const) {
      expect(cellRefusal(tab, oldMarkdown, newMarkdown)).toBe(CELL_CONTENT);
    }
  });

  it("refuses a change to rows, columns or the table's own tags", () => {
    let cases: [GoogleDocsTab, string, string][] = [
      [PLAIN, QUOTED, `${QUOTED}\n    <td><p>New</p></td>`],
      [PLAIN, tableRow("Fix login", "Open"), tableRow("Fix login", "Open") + tableRow("New", "Row")],
      [PLAIN, "  </tr>\n  <tr>\n", "  </tr>\n"],
      [WIDE, WIDE_ROW, "    <td><p>Fix login</p></td>\n    <td><p>Ana</p></td>\n"],
      [WIDE, WIDE_ROW, "    <td><p>Fix login</p></td>\n    <td><p>Open</p></td>\n"],
      [WIDE, ALL_ROWS, tableRow("Task", "Status") + tableRow("Fix login", "Open") + tableRow("Ship docs", "Open")],
      [WIDE, ALL_ROWS, tableRow("Task", "Owner", "Status", "Due") +
        tableRow("Fix login", "Ana", "Open", "Fri") + tableRow("Ship docs", "Ben", "Open", "Mon")],
      [WIDE, tableRow("Fix login", "Ana", "Open") + tableRow("Ship docs", "Ben", "Open"),
        tableRow("Fix login", "Ana", "Open")],
      [MERGED, "    <td><p>Open</p></td>\n    <td colspan=\"2\">", "    <td colspan=\"2\">"],
      [PLAIN, "<td><p>Open</p></td>", "<td rowspan=\"2\"><p>Open</p></td>"],
    ];
    for (let [tab, oldMarkdown, newMarkdown] of cases) {
      expect(cellRefusal(tab, oldMarkdown, newMarkdown)).toBe(STRUCTURE);
    }
  });

  it("refuses what the paragraph path reduces to nothing in a table's closing tag", () => {
    for (let typed of ["<\\/table>\n\nAfter", "</tab\u0001le>\n\nAfter"]) {
      let oldMarkdown = "</table>\n\nAfter";
      // The paragraph path reads the text as unchanged, and would queue an edit that sends nothing.
      expect(canonicalizeMarkdownReplacement(oldMarkdown, typed)).toBe(oldMarkdown);
      expect(cellRefusal(PLAIN, oldMarkdown, typed)).toBe(STRUCTURE);
    }
  });

  let writtenInto = (html: string) => cellRefusal(PLAIN, "<p>Open</p>", `<p>${html}</p>`);

  it("names a tag the text of a cell cannot be written with", () => {
    expect(writtenInto("<b>Open</b>")).toBe(unsupportedTag("b"));
    expect(writtenInto("<span>Open</span>")).toBe(unsupportedTag("span"));
    expect(writtenInto("<STRONG>Open</STRONG>")).toBe(unsupportedTag("STRONG"));
    expect(writtenInto("Open</span>")).toBe(unsupportedTag("span"));
    for (let html of [
      "<strong class=\"x\">Open</strong>", "<em >Open</em>", "<s>Open</s >", "Op<br >en",
    ]) {
      expect(writtenInto(html)).toBe(NOTHING_ELSE);
      expect(message(() => parseCellInline(html))).toBe(NOTHING_ELSE);
    }
    expect(writtenInto("<strong>Open")).toBe(TAG_ORDER);
    expect(writtenInto("<strong><em>Open</strong></em>")).toBe(TAG_ORDER);
    expect(writtenInto(a(X, `Op${a(C, "e")}n`))).toBe(TAG_ORDER);
    for (let html of [
      "<a>Open</a>", "<a href=\"https://x.example\" target=\"_blank\">Open</a>",
      "<a href='https://x.example'>Open</a>", "<a href=\"javascript:alert(1)\">Open</a>",
      "<a href=\"ftp://x.example/\">Open</a>", `${a(X, "Open").slice(0, -1)} >`,
    ]) {
      expect(writtenInto(html)).toBe(LINK_FORM);
    }
    expect(writtenInto("Open&nbsp;now")).toBe(ESCAPES);
    expect(writtenInto("Open&#160;now")).toBe(ESCAPES);
    expect(message(() => parseCellInline("<b>x</b>"))).toBe(unsupportedTag("b"));
    expect(message(() => parseCellInline("<a >x</a>"))).toBe(LINK_FORM);
  });

  it("names a closing tag that has no name by the two characters typed", () => {
    const NO_NAME = "replaceText: </ is not supported in a table cell. Use <strong>, <em>, " +
      "<s>, <a href=\"...\"> and <br>, and write a literal < as &lt;.";
    for (let html of ["Open</>", "Open</ p>", "</>Open", "Op</-x>en"]) {
      expect(writtenInto(html)).toBe(NO_NAME);
      expect(message(() => parseCellInline(html))).toBe(NO_NAME);
    }
    expect(message(() => parseCellInline("Open</"))).toBe(NO_NAME);
    // A digit after the slash is a name.
    expect(writtenInto("Open</1>")).toBe(unsupportedTag("1"));
  });

  it("reads the text of a cell as the renderer wrote it", () => {
    expect(parseCellInline("a &amp; <strong>b<br>c</strong>&lt;<a href=\"https://x.example/?a=1&amp;b=2\">d</a>"))
      .toEqual({
        text: "a & b\u000bc<d",
        runs: [
          { text: "a & ", start: 0, end: 4 },
          { text: "b\u000bc", start: 4, end: 7, bold: true },
          { text: "<", start: 7, end: 8 },
          { text: "d", start: 8, end: 9, link: "https://x.example/?a=1&b=2" },
        ],
      });
    expect(parseCellInline("<em>a</em><em>b</em> < 3 > 2 & more <br/><br />"))
      .toEqual({
        text: "ab < 3 > 2 & more \u000b\u000b",
        runs: [
          { text: "ab", start: 0, end: 2, italic: true },
          { text: " < 3 > 2 & more \u000b\u000b", start: 2, end: 20 },
        ],
      });
    expect(parseCellInline("")).toEqual({ text: "", runs: [] });
  });
});

/** A text of `stretches` struck-through letters, each followed by a plain one. */
const striped = (stretches: number) => `<td><p>${"<s>a</s>b".repeat(stretches)}</p></td>`;

/** A cell paragraph that is one link over `pairs` struck-through letters, each before a plain one. */
const linkedStripes = (destination: string, pairs: number) =>
  `<p>${(a(destination, "<s>a</s>") + a(destination, "b")).repeat(pairs)}</p>`;

describe("the size of a replacement in table cells", () => {
  const tab = buildTab([para("Before"), grid(["a", ""]), para("After")]);
  const before = docTabToMarkdown(tab);
  const OLD_CELL = "<td><p></p></td>";
  const matchStart = before.markdown.indexOf(OLD_CELL);

  it("takes a replacement that needs exactly the most requests one change may send", () => {
    let written = striped(MAX_TABLE_TEXT_REQUESTS - 2);
    expect(replaceTableText(contentOf(before), matchStart, OLD_CELL, written, TAB)).toBeDefined();
    let requests = tableTextRequests(before, matchStart, OLD_CELL, written);
    expect(requests?.length).toBe(MAX_TABLE_TEXT_REQUESTS);
    expect(kinds(requests ?? []).slice(0, 3))
      .toEqual(["insertText", "updateTextStyle", "updateTextStyle"]);
  });

  it("refuses one request more, when it is queued, at every replay and at approval", () => {
    let written = striped(MAX_TABLE_TEXT_REQUESTS - 1);
    let content = contentOf(before);
    expect(message(() => replaceTableText(content, matchStart, OLD_CELL, written, TAB)))
      .toBe(TOO_MANY_REQUESTS);
    expect(message(() => tableTextRequests(before, matchStart, OLD_CELL, written)))
      .toBe(TOO_MANY_REQUESTS);
    // Behind an unrelated change, where the content does not read as the tab does.
    let altered = applyTextReplacement(
      content, replacementIn(content.markdown, "Before", "Earlier on"), TAB);
    let moved = altered.markdown.indexOf(OLD_CELL);
    expect(moved).not.toBe(matchStart);
    expect(message(() => replaceTableText(altered, moved, OLD_CELL, written, TAB)))
      .toBe(TOO_MANY_REQUESTS);
    let stored = { matchStart: moved, oldMarkdown: OLD_CELL, newMarkdown: written, inTable: true as const };
    expect(message(() => applyTextReplacement(altered, stored, TAB))).toBe(TOO_MANY_REQUESTS);
    expect(message(() => textReplacementRequests(before, { ...stored, matchStart })))
      .toBe(TOO_MANY_REQUESTS);
  });

  it("refuses a list of thousands of items given new text at once", () => {
    let items = Array.from({ length: 3_000 }, (_, index) => item(`i${index}`));
    let list = buildTab(
      [para("Before"), { table: [[cellOf(...items)]] }, para("After")], ALL_LISTS);
    let listed = docTabToMarkdown(list);
    let html = tableAt(contentOf(listed), 0);
    let start = listed.markdown.indexOf(html);
    // Each item needs a deletion, an insertion and a reset.
    let written = html.replace(/\u25cf i/g, "\u25cf k");
    expect(message(() => replaceTableText(contentOf(listed), start, html, written, TAB)))
      .toBe(TOO_MANY_REQUESTS);
    expect(message(() => tableTextRequests(listed, start, html, written))).toBe(TOO_MANY_REQUESTS);
  });

  it("walks a link of thousands of formatted stretches once, however many it holds", () => {
    // One link whose text alternates between struck through and plain, pointed to another URL.
    // Walked once for each of its stretches, a link of 48,000 takes minutes to plan, and the
    // refusal below would not come within the time a test is given.
    let pointed = (pairs: number) => {
      let runs = Array.from({ length: pairs }, () =>
        [linked("a", OLD, { strikethrough: true }), linked("b", OLD)]).flat();
      let long = docTabToMarkdown(buildTab(
        [para("Before"), { table: [[cellOf({ runs: [...runs, "\n"] })]] }, para("After")]));
      let oldMarkdown = linkedStripes(OLD, pairs);
      let newMarkdown = linkedStripes(NEW, pairs);
      let found = replacementIn(long.markdown, oldMarkdown, newMarkdown).matchStart;
      return {
        replay: () => replaceTableText(contentOf(long), found, oldMarkdown, newMarkdown, TAB),
        requests: () => tableTextRequests(long, found, oldMarkdown, newMarkdown),
      };
    };

    // At the limit the link is pointed elsewhere whole: one request for each stretch, no clear.
    let atLimit = pointed(MAX_TABLE_TEXT_REQUESTS / 2);
    expect(atLimit.replay()?.shown.rendered).toBe(linkedStripes(NEW, MAX_TABLE_TEXT_REQUESTS / 2));
    let requests = atLimit.requests() ?? [];
    expect(requests).toHaveLength(MAX_TABLE_TEXT_REQUESTS);
    for (let request of requests) {
      expect("updateTextStyle" in request && request.updateTextStyle)
        .toMatchObject({ textStyle: url(NEW), fields: "link" });
    }

    expect(message(pointed(24_000).replay)).toBe(TOO_MANY_REQUESTS);
  });
});

// ---------------------------------------------------------------------------
// Replacements beside a table, and across one
// ---------------------------------------------------------------------------

const classify = (
  content: EditableMarkdown, oldMarkdown: string, newMarkdown: string, matchStart?: number,
): ReplacementPlace =>
  classifyReplacement(
    content, replacementIn(content.markdown, oldMarkdown, newMarkdown, matchStart));

/** The Markdown a replacement gives when it is made as written. */
const spliced = (markdown: string, { matchStart, oldMarkdown, newMarkdown }: TextReplacement) =>
  markdown.slice(0, matchStart) + newMarkdown + markdown.slice(matchStart + oldMarkdown.length);

const BTA = () => buildTab([para("Before"), grid(["a", "b"]), para("After")]);
const ABTAT = () => buildTab([para("A"), para("B"), grid(["a", "b"]), para("After"), para("Tail")]);
const CHIP_TABLE_DUE = () => buildTab([chip(), grid(["a", "b"]), dateChip(), para("Tail")]);
const CHIP_B_TABLE_AFTER_DUE = () =>
  buildTab([chip(), para("B"), grid(["a", "b"]), para("After"), dateChip()]);
const edgePlace = (
  side: "before" | "after", hasParagraph: boolean, readOnly: boolean, equivalent?: TextReplacement,
): ReplacementPlace =>
  ({ kind: "edge", side, hasParagraph, readOnly, ...(equivalent ? { equivalent } : {}) });

let addedBelow = (content: EditableMarkdown) =>
  classify(content, "</table>", "</table>\n\nX", content.markdown.indexOf("</table>"));

let addedAbove = (content: EditableMarkdown) =>
  classify(content, "<table>", "X\n\n<table>", content.markdown.lastIndexOf("<table>"));

describe("classifyReplacement", () => {
  it("says where the text a replacement changes lies", () => {
    let content = read(BTA());
    let after = content.markdown.indexOf("After");
    expect(classify(content, "<p>a</p>", "<p>z</p>")).toEqual({ kind: "table", table: 0 });
    expect(classify(content, "<table>", "X\n\n<table>")).toEqual(edgePlace(
      "before", true, false, { matchStart: 0, oldMarkdown: "Before", newMarkdown: "Before\n\nX" }));
    expect(classify(content, "</table>", "</table>\n\nX")).toEqual(edgePlace(
      "after", true, false, { matchStart: after, oldMarkdown: "After", newMarkdown: "X\n\nAfter" }));
    expect(classify(content, "<table>", "Intro <table>")).toEqual(edgePlace("before", true, false));
    let first = read(buildTab([grid(["a", "b"]), para("After")]));
    expect(first.markdown.startsWith("<table>")).toBe(true);
    expect(classify(first, "<table>", "X\n\n<table>")).toEqual(edgePlace("before", false, false));

    let none = { kind: "blankLine", readOnly: false, beyond: "none" };
    expect(classify(content, "Before\n\n", "")).toEqual({ ...none, side: "before" });
    expect(classify(content, "Before\n\n<table>", "Before\n<table>"))
      .toEqual({ ...none, side: "before" });
    expect(classify(content, "\n\nAfter", "")).toEqual({ ...none, side: "after" });
    let longer = read(ABTAT());
    expect(classify(longer, "B\n\n", ""))
      .toEqual({ kind: "blankLine", side: "before", readOnly: false, beyond: "paragraph" });
    expect(classify(longer, "\n\nAfter", ""))
      .toEqual({ kind: "blankLine", side: "after", readOnly: false, beyond: "paragraph" });

    expect(classify(content, "Before\n\n<table>\n  <tr>\n    <td><p>a", "X"))
      .toEqual({ kind: "across" });
    expect(classify(content, content.markdown, "All new\n")).toEqual({ kind: "across" });
    let two = read(
      buildTab([para("Before"), grid(["a"]), para("Mid"), grid(["b"]), para("After")]));
    expect(classify(two, "a</p></td>\n  </tr>\n</table>\n\nMid\n\n<table>\n  <tr>\n    <td><p>b", "ab"))
      .toEqual({ kind: "across" });
    expect(classify(content, "Before", "Earlier")).toEqual({ kind: "none" });
    expect(classify(content, "After", "XAfter")).toEqual({ kind: "none" });
  });

  it("never throws", () => {
    let content = read(BTA());
    let plain = read(buildTab([para("One"), para("Two")]));
    let end = content.markdown.length;
    let cases: [EditableMarkdown, TextReplacement][] = [
      [content, { matchStart: 0, oldMarkdown: "", newMarkdown: "X" }],
      [content, { matchStart: 0, oldMarkdown: "Before", newMarkdown: "" }],
      [content, { matchStart: end, oldMarkdown: "", newMarkdown: "X" }],
      [content, { matchStart: end - 1, oldMarkdown: "\n", newMarkdown: "" }],
      [content, { matchStart: end + 5, oldMarkdown: "gone", newMarkdown: "x" }],
      [plain, { matchStart: 0, oldMarkdown: "One", newMarkdown: "<table>" }],
      [{ markdown: "", protectedRanges: [], tables: [] }, { matchStart: 0, oldMarkdown: "", newMarkdown: "" }],
    ];
    for (let [target, replacement] of cases) {
      expect(() => classifyReplacement(target, replacement)).not.toThrow();
    }
    expect(classify(plain, "One", "<table>")).toEqual({ kind: "none" });
  });

  it("finds no paragraph where a waiting edit removed its line from between two blocks", () => {
    let removed = (blocks: BlockSpec[], oldMarkdown: string, newMarkdown: string) => {
      let content = read(buildTab(blocks));
      return applyTextReplacement(
        content, replacementIn(content.markdown, oldMarkdown, newMarkdown), TAB);
    };
    let tables = [para("Before"), grid(["a"]), para("Mid"), grid(["b"]), para("After")];
    let between = removed(tables, "Mid\n", "");
    expect(between.markdown).toContain("</table>\n\n\n<table>");
    let emptied = removed(
      [para("Before"), grid(["a"]), para(""), grid(["b"]), para("After")],
      "</table>\n\n\n", "</table>\n\n");
    for (let content of [between, emptied]) {
      expect(addedBelow(content)).toEqual(edgePlace("after", false, false));
      expect(addedAbove(content)).toEqual(edgePlace("before", false, false));
    }
    expect(addedAbove(removed([para("Before"), toc, para("Mid"), grid(["b"]), para("After")], "Mid\n", "")))
      .toEqual(edgePlace("before", false, false));
    expect(addedAbove(removed([chip(), para("Mid"), grid(["b"]), para("After")], "Mid\n", "")))
      .toEqual(edgePlace("before", false, false));
    expect(addedBelow(removed([para("Before"), grid(["a"]), para("Mid"), toc, para("After")], "Mid\n", "")))
      .toEqual(edgePlace("after", false, false));

    // On a fresh rendering a paragraph stands on each side.
    let fresh = read(buildTab([para("Before"), grid(["a"]), para(""), grid(["b"]), para("After")]));
    let line = fresh.markdown.indexOf("</table>") + "</table>\n\n".length;
    expect(addedBelow(fresh)).toEqual(edgePlace(
      "after", true, false, { matchStart: line, oldMarkdown: "", newMarkdown: "X\n\n" }));
    expect(addedAbove(fresh)).toEqual(edgePlace(
      "before", true, false, { matchStart: line, oldMarkdown: "", newMarkdown: "\n\nX" }));
    let afterChip = read(buildTab([chip(), grid(["b"]), para("After")]));
    expect(addedAbove(afterChip))
      .toMatchObject({ kind: "edge", hasParagraph: true, readOnly: true });
  });

  it("reads text only added or only removed where it touches no table", () => {
    let content = read(BTA());
    for (let text of [
      "<TODO: describe the figures>", "<50 employees only", "<b>Note</b>", "<", "<table>",
    ]) {
      let moved = edgePlace("before", true, false, {
        matchStart: 0, oldMarkdown: "Before", newMarkdown: `Before\n\n${text}`,
      });
      for (let [oldMarkdown, newMarkdown] of [
        ["<table>", `${text}\n\n<table>`],
        ["Before\n\n<table>", `Before\n\n${text}\n\n<table>`],
        ["Before\n", `Before\n\n${text}\n`],
      ]) {
        let replacement = replacementIn(content.markdown, oldMarkdown, newMarkdown);
        expect(classifyReplacement(content, replacement)).toEqual(moved);
        expect(spliced(content.markdown, moved.kind === "edge" && moved.equivalent || replacement))
          .toBe(spliced(content.markdown, replacement));
        let { matchStart } = replacement;
        expect(replaceTableText(content, matchStart, oldMarkdown, newMarkdown, TAB))
          .toBeUndefined();
        expect(tableTextRequests(docTabToMarkdown(BTA()), matchStart, oldMarkdown, newMarkdown))
          .toBeUndefined();
      }
    }
    expect(classify(content, "<table>", "<TODO><table>")).toEqual(edgePlace("before", true, false));

    // Placed as written: these change the table itself.
    let row = "<table>\n  <tr>";
    expect(classify(content, row, `${row}\n    <td><p>New</p></td>\n  </tr>\n  <tr>`))
      .toEqual({ kind: "table", table: 0 });
    expect(classify(content, "</table>\n\nAfter", "<\\/table>\n\nAfter"))
      .toEqual({ kind: "table", table: 0 });
    let whole = "<table>\n  <tr>\n    <td><p>Z</p></td>\n  </tr>\n</table>";
    expect(classify(content, "<table>", `${whole}\n\n<table>`)).toEqual(edgePlace("before", true, false, {
      matchStart: 0, oldMarkdown: "Before", newMarkdown: `Before\n\n${whole}`,
    }));
  });

  it("reads a paragraph removed with a table's blank line as a change to that line", () => {
    let todo = read(buildTab([para("A"), para("<TODO>"), grid(["a"]), para("After")]));
    let beside = { kind: "blankLine", side: "before", readOnly: false, beyond: "paragraph" };
    expect(classify(todo, "<TODO>\n\n<table>", "<table>")).toEqual(beside);
    expect(classify(todo, "A\n\n<TODO>\n\n<table>", "A\n\n<table>")).toEqual(beside);
    expect(classify(todo, "<TODO>\n\n", "")).toEqual(beside);
    let firstParagraph = read(buildTab([para("<TODO>"), grid(["a"]), para("After")]));
    expect(classify(firstParagraph, "<TODO>\n\n<table>", "<table>"))
      .toEqual({ ...beside, beyond: "none" });

    // Nothing is moved below a table: one position to the left the range would hold its end.
    let note = read(buildTab([para("Before"), grid(["a"]), para("note>"), para("Tail")]));
    expect(classify(note, "</table>\n\nnote>", "</table>"))
      .toEqual({ kind: "blankLine", side: "after", readOnly: false, beyond: "paragraph" });
    let reads = read(buildTab([para("<table>"), grid(["a"]), para("After")]));
    expect(classify(reads, "<table>\n\n<table>\n  <tr>", "<table>\n  <tr>", 0))
      .toMatchObject({ kind: "blankLine", side: "before" });
  });

  it("says when a read-only paragraph covers the place beside the table", () => {
    let both = read(CHIP_TABLE_DUE());
    expect(classify(both, "<table>", "X\n\n<table>"))
      .toMatchObject({ kind: "edge", side: "before", readOnly: true, equivalent: { oldMarkdown: "Owner: Ana" } });
    expect(classify(both, "</table>", "</table>\n\nX")).toMatchObject({
      kind: "edge", side: "after", readOnly: true, equivalent: { oldMarkdown: "Due Nov 8, 2026" },
    });
    expect(classify(both, "Owner: Ana\n\n<table>", "<table>"))
      .toMatchObject({ kind: "blankLine", side: "before", readOnly: true });

    let beyond = read(CHIP_B_TABLE_AFTER_DUE());
    expect(classify(beyond, "B\n\n", ""))
      .toEqual({ kind: "blankLine", side: "before", readOnly: false, beyond: "readOnly" });
    expect(classify(beyond, "\n\nAfter", ""))
      .toEqual({ kind: "blankLine", side: "after", readOnly: false, beyond: "readOnly" });
    expect(classify(beyond, "<table>", "X\n\n<table>"))
      .toMatchObject({ kind: "edge", readOnly: false });
    expect(classify(beyond, "</table>", "</table>\n\nX"))
      .toMatchObject({ kind: "edge", readOnly: false });

    // An empty paragraph below a table whose line break a read-only paragraph after it owns.
    let emptyBelow = read(buildTab([para("Before"), grid(["a"]), para(""), dateChip()]));
    expect(classify(emptyBelow, "</table>", "</table>\n\nX"))
      .toMatchObject({ kind: "edge", side: "after", readOnly: true });
    let emptyAbove = read(buildTab([chip(), para(""), grid(["a"]), para("After")]));
    expect(classify(emptyAbove, "<table>", "X\n\n<table>"))
      .toMatchObject({ kind: "edge", side: "before", readOnly: false });
    let quiet = read(
      buildTab([para("Before"), quietChip(), grid(["a"]), quietChip(), para("After")]));
    expect(classify(quiet, "<table>", "X\n\n<table>"))
      .toMatchObject({ kind: "edge", readOnly: true });
    expect(classify(quiet, "</table>", "</table>\n\nX"))
      .toMatchObject({ kind: "edge", readOnly: true });
  });
});

const CONVERTER_REFUSAL = new StructuredContentError().message;
const readOnlyBeside = (side: string) =>
  `replaceText: a paragraph ${side} the table holds an image, smart chip or other element and ` +
  "is read-only: it cannot be changed or removed, and nothing can be added between it and the " +
  "table.";
const paragraphMissing = (side: string) =>
  `replaceText: the paragraph ${side} this table is missing from the tab as it reads with the ` +
  "earlier changes that are still waiting, so nothing can be added there yet. Retry once the " +
  "earlier changes to this tab have been approved or rejected.";
const EDGE_REFUSAL = "replaceText: text added directly above or below a table must be whole " +
  "paragraphs, with a blank line between them and the table.";
const BLANK_LINE = "replaceText: the replacement changes the blank line between a table and " +
  "the paragraph beside it, which has to stay.";
const BLANK_OTHER_SIDE = `${BLANK_LINE} To remove or rewrite that paragraph, take the blank ` +
  "line on its other side instead: end oldMarkdown at the last character of the paragraph " +
  "before the table, or start it at the first character of the paragraph after the table. If " +
  "that is refused too, empty the paragraph: it cannot be removed.";
const BLANK_KEPT = `${BLANK_LINE} Google Docs keeps a paragraph on each side of a table, so ` +
  "that paragraph can be emptied but not removed.";
const BLANK_READ_ONLY = `${BLANK_LINE} A read-only paragraph stands on that paragraph's other ` +
  "side, so that paragraph can be emptied but not removed.";
const TOGETHER = "replaceText: one replacement cannot change a table together with what is " +
  "around it. Change the text inside one table, or the paragraphs before and after it, in " +
  "separate calls; add a table with insertTable() and remove one with deleteTable().";
const TABLE_REFUSALS = [
  readOnlyBeside("before"), readOnlyBeside("after"), paragraphMissing("before"),
  paragraphMissing("after"), EDGE_REFUSAL, BLANK_OTHER_SIDE, BLANK_KEPT, BLANK_READ_ONLY, TOGETHER,
];

type Outcome = { value: unknown } | { error: string; structured: boolean };

function outcome(run: () => unknown): Outcome {
  try {
    return { value: run() };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { error: error.message, structured: error instanceof StructuredContentError };
  }
}

/** What the converter's own calls give for the replay of a replacement as written. */
function converterReplay(content: EditableMarkdown, replacement: TextReplacement): string {
  let { matchStart, oldMarkdown, newMarkdown } = replacement;
  let rendered = canonicalizeMarkdownReplacement(oldMarkdown, newMarkdown);
  return oldMarkdown === rendered ? content.markdown
    : applyMarkdownEdit(content, matchStart, matchStart + oldMarkdown.length, rendered).markdown;
}

/** What the converter's own calls give for the requests of a replacement as written. */
function converterRequests(tab: DocTabSnapshot, replacement: TextReplacement): unknown[] {
  let { matchStart, oldMarkdown, newMarkdown } = replacement;
  return computeReplaceOperations(
    tab.sourceMap, tab.markdown, matchStart, matchStart + oldMarkdown.length,
    canonicalizeMarkdownReplacement(oldMarkdown, newMarkdown), tab.tabId).requests;
}

/**
 * The replay and the requests of a stored replacement that is not one in table cells, each
 * beside what the converter's own calls give for the replacement as written.
 */
function bothPaths(tab: DocTabSnapshot, replacement: TextReplacement): [Outcome, Outcome][] {
  let content = contentOf(tab);
  return [
    [outcome(() => converterReplay(content, replacement)),
      outcome(() => applyTextReplacement(content, replacement, TAB).markdown)],
    [outcome(() => converterRequests(tab, replacement)),
      outcome(() => textReplacementRequests(tab, replacement))],
  ];
}

/** The replay and the requests come back as the converter's own calls give them for `as`. */
function expectAsConverter(
  tab: GoogleDocsTab, oldMarkdown: string, newMarkdown: string, as?: [string, string],
): void {
  let before = docTabToMarkdown(tab);
  let replacement = replacementIn(before.markdown, oldMarkdown, newMarkdown);
  let own = as ? replacementIn(before.markdown, as[0], as[1]) : replacement;
  expect(applyTextReplacement(contentOf(before), replacement, TAB).markdown)
    .toBe(converterReplay(contentOf(before), own));
  expect(textReplacementRequests(before, replacement)).toEqual(converterRequests(before, own));
}

/** What the replay and the requests of a stored paragraph replacement are each refused with. */
function textRefusal(tab: GoogleDocsTab, oldMarkdown: string, newMarkdown: string): string {
  let before = docTabToMarkdown(tab);
  let replacement = replacementIn(before.markdown, oldMarkdown, newMarkdown);
  let replayed = message(() => applyTextReplacement(contentOf(before), replacement, TAB));
  expect(message(() => textReplacementRequests(before, replacement))).toBe(replayed);
  return replayed;
}

const breaks = (count: number) => "\n".repeat(count);

/** Replacements beside the one table of a tab, in every phrasing an agent may reach for. */
function generatedReplacements(markdown: string, table: EditableTable): TextReplacement[] {
  let html = markdown.slice(table.mdStart, table.mdEnd);
  let lineBefore = markdown.slice(
    markdown.lastIndexOf("\n", table.mdStart - 3) + 1, table.mdStart - 2);
  let after = table.mdEnd + 2;
  let lineAfter = markdown.slice(after, markdown.indexOf("\n", after));
  // Each context as the text before the added text, the text after it, and the neighbour.
  let contexts: [string, string, "before" | "after" | undefined][] = [
    ["</table>", lineAfter, "after"], [lineBefore, "<table>", "before"],
    [html, lineAfter, "after"], [lineBefore, html, "before"],
    ["", "<table>", undefined], ["</table>", "", undefined],
    [lineBefore, "", "before"], ["</table>", "", undefined],
  ];
  let separators = ["\n\n", "\n\n", "\n\n", "\n\n", "", "", "\n", "\n"];
  let replacements: TextReplacement[] = [];
  for (let [index, [head, tail, neighbour]] of contexts.entries()) {
    let oldMarkdown = head + separators[index] + tail;
    let matchStart = markdown.indexOf(oldMarkdown);
    for (let text of ["", "X", "# X", "- X", "X\n\nY", "X\nY", "<X>"]) {
      for (let lead = 0; lead <= 3; lead++) {
        for (let trail = 0; trail <= 3; trail++) {
          for (let mark of neighbour ? ["", "!"] : [""]) {
            replacements.push({
              matchStart,
              oldMarkdown,
              newMarkdown: head + (neighbour === "before" ? mark : "") + breaks(lead) + text +
                breaks(trail) + tail + (neighbour === "after" ? mark : ""),
            });
          }
        }
      }
    }
  }
  return replacements;
}

describe("a replacement beside a table", () => {
  it("leaves what the paragraph path accepts as that path has it", () => {
    let before = docTabToMarkdown(BTA());
    for (let written of ["</table>\nAfter!", "</table>\n# After", "</table>\nCaption\n\nAfter"]) {
      let { matchStart, oldMarkdown } = replacementIn(
        before.markdown, "</table>\n\nAfter", written);
      expect(replaceTableText(contentOf(before), matchStart, oldMarkdown, written, TAB))
        .toBeUndefined();
      expectAsConverter(BTA(), oldMarkdown, written);
    }
    let first = replacementIn(before.markdown, "</table>\n\nAfter", "</table>\nAfter!");
    expect(applyTextReplacement(contentOf(before), first, TAB).markdown.endsWith("</table>\n\nAfter!\n"))
      .toBe(true);
  });

  it("changes nothing the paragraph path accepts, in a generated set of replacements", () => {
    let tabs = [
      BTA(),
      buildTab([item("item"), grid(["a", "b"]), item("other", "L2"), para("End")], ALL_LISTS),
      buildTab([heading("Results"), grid(["a", "b"]), para(""), para("End")]),
      CHIP_TABLE_DUE(),
      CHIP_B_TABLE_AFTER_DUE(),
    ];
    let accepted = 0;
    let moved = 0;
    for (let [index, tab] of tabs.entries()) {
      let before = docTabToMarkdown(tab);
      for (let replacement of generatedReplacements(before.markdown, before.sourceMap.tables[0])) {
        let place = classifyReplacement(contentOf(before), replacement);
        for (let [own, engine] of bothPaths(before, replacement)) {
          if ("value" in own) {
            expect(engine).toEqual(own);
            accepted++;
          } else if (!own.structured || place.kind === "none" || place.kind === "table") {
            expect(engine).toEqual(own);
          } else if ("value" in engine) {
            expect(place.kind).toBe("edge");
            moved++;
          } else {
            expect(TABLE_REFUSALS).toContain(engine.error);
            expect(engine.error).not.toBe(CONVERTER_REFUSAL);
            // Beside read-only paragraphs nothing can be added or removed next to the table.
            if (index === 3 && place.kind !== "across") {
              expect(engine.error).toBe(readOnlyBeside(place.side));
            }
          }
        }
      }
    }
    expect(accepted).toBeGreaterThan(1500);
    expect(moved).toBeGreaterThan(100);
  });

  it("adds text at a table's edge as the same change written beside the table", () => {
    let neighbours: [ParagraphSpec, string, ParagraphSpec, string][] = [
      [para("Before"), "Before", para("After"), "After"],
      [para(""), "", para(""), ""],
      [item("item"), "- item", heading("Next"), "## Next"],
      [heading("Results"), "## Results", para("After"), "After"],
    ];
    for (let [above, lineAbove, below, lineBelow] of neighbours) {
      let tab = () => buildTab(
        [para("Start"), above, grid(["a", "b"]), below, para("End")], ALL_LISTS);
      let before = docTabToMarkdown(tab());
      let content = contentOf(before);
      for (let text of ["## Results Q3", "One\n\nTwo"]) {
        let movedAbove: [string, string] = [lineAbove, `${lineAbove}\n\n${text}`];
        let movedBelow: [string, string] = [lineBelow, `${text}\n\n${lineBelow}`];
        // The line above the table, quoted with its line break, is found by where it stands.
        let lineStart = content.tables[0].mdStart - 2 - lineAbove.length;
        let phrasings: [string, string, [string, string], number?][] = [
          ["<table>", `${text}\n\n<table>`, movedAbove],
          [`${lineAbove}\n\n<table>`, `${lineAbove}\n\n${text}\n\n<table>`, movedAbove],
          [`${lineAbove}\n`, `${lineAbove}\n\n${text}\n`, movedAbove, lineStart],
          ["</table>", `</table>\n\n${text}`, movedBelow],
          ["</table>\n", `</table>\n\n${text}\n`, movedBelow],
        ];
        for (let [oldMarkdown, newMarkdown, [line, moved], matchStart] of phrasings) {
          let replacement = replacementIn(content.markdown, oldMarkdown, newMarkdown, matchStart);
          expect(replaceTableText(content, replacement.matchStart, oldMarkdown, newMarkdown, TAB))
            .toBeUndefined();
          expect(outcome(() => converterReplay(content, replacement)))
            .toEqual({ error: CONVERTER_REFUSAL, structured: true });
          let place = classifyReplacement(content, replacement);
          if (place.kind !== "edge" || !place.equivalent) throw new Error("Expected an equivalent");
          expect(place.equivalent).toMatchObject({ oldMarkdown: line, newMarkdown: moved });
          expect(spliced(content.markdown, place.equivalent))
            .toBe(spliced(content.markdown, replacement));
          // It is run as the paragraph path runs the equivalent.
          expect(applyTextReplacement(content, replacement, TAB).markdown)
            .toBe(converterReplay(content, place.equivalent));
          expect(textReplacementRequests(before, replacement))
            .toEqual(converterRequests(before, place.equivalent));
          expectParagraphTextSameAsGoogle(tab(), oldMarkdown, newMarkdown, matchStart);
        }
      }
    }
  });

  it("adds text that starts with < above a table as the plain paragraph it is", () => {
    for (let text of ["<TODO: describe the figures>", "<50 employees only", "<b>Note</b>"]) {
      for (let [oldMarkdown, newMarkdown] of [
        ["<table>", `${text}\n\n<table>`],
        ["Before\n\n<table>", `Before\n\n${text}\n\n<table>`],
        ["Before\n", `Before\n\n${text}\n`],
      ]) {
        expectAsConverter(BTA(), oldMarkdown, newMarkdown, ["Before", `Before\n\n${text}`]);
        let simulated = expectParagraphTextSameAsGoogle(BTA(), oldMarkdown, newMarkdown);
        expect(simulated.markdown.startsWith(`Before\n\n${text}\n\n<table>\n`)).toBe(true);
      }
    }
  });

  it("writes a heading in front of an empty paragraph as its replay shows", () => {
    // Below a table that is the paragraph a new table comes with, inside the tab and at its end;
    // the same replacement with no table near goes the same way.
    let places: [tab: GoogleDocsTab, oldMarkdown: string, lead: string, tail: string][] = [
      [buildTab([para("Before"), grid(["a", "b"]), para(""), para("End")]),
        "</table>", "</table>\n\n", ""],
      [buildTab([para("Before"), grid(["a", "b"]), para("")]), "</table>", "</table>\n\n", ""],
      [buildTab([para("Before"), para(""), para("End")]), "Before\n\n", "Before\n\n", "\n\n"],
      [buildTab([para("Before"), para(""), para(""), para("End")]),
        "Before\n\n", "Before\n\n", "\n\n"],
      [buildTab([para("Before"), para("")]), "Before\n\n", "Before\n\n", "\n\n"],
    ];
    let texts = ["## Notes", "## Notes\n\nSee below", "See above\n\n## Notes", "See below",
      "See above\n\nSee below", "## Notes\n\n", "## Notes\n\n\n\n"];
    for (let [tab, oldMarkdown, lead, tail] of places) {
      for (let text of texts) {
        let { simulated, fresh } = replacementOutcome(tab, oldMarkdown, `${lead}${text}${tail}`);
        expect(fresh).toBe(simulated);
        expect(fresh).toContain(text.replace(/\n+$/, ""));
      }
    }
  });
});

/**
 * What a replacement reads as while it waits and once Google has applied it, which is the same
 * under each of the model's behaviours, and the document it leaves.
 */
function replacementOutcome(
  tab: GoogleDocsTab, oldMarkdown: string, newMarkdown: string,
): { simulated: string; fresh: string; applied: GoogleDocsTab } {
  let before = docTabToMarkdown(tab);
  let replacement = replacementIn(before.markdown, oldMarkdown, newMarkdown);
  let simulated = applyTextReplacement(contentOf(before), replacement, TAB).markdown;
  let requests = textReplacementRequests(before, replacement);
  let applied = MODELS.map(options => applyDocsRequests(tab, requests, options));
  let reads = new Set(applied.map(result => docTabToMarkdown(result).markdown));
  expect(reads.size).toBe(1);
  return { simulated, fresh: [...reads][0], applied: applied[0] };
}

describe("text written in front of a list item that shows no marker", () => {
  // An item of a list whose level has no marker reads as a plain line, so a plain paragraph
  // written in front of it is taken out of the list it is typed into. Text added below a table
  // goes in front of the paragraph after the table, so it meets this where that paragraph is
  // such an item; the same replacement with no table near goes the same way.
  const places: [tab: () => GoogleDocsTab, write: (text: string) => [string, string]][] = [
    [
      () => buildTab(
        [para("Before"), grid(["a", "b"]), item("Notes", "Q1"), para("End")], ALL_LISTS),
      text => ["</table>", `</table>\n\n${text}`],
    ],
    [
      () => buildTab([para("Before"), item("Notes", "Q1"), para("End")], ALL_LISTS),
      text => ["Notes", `${text}\n\nNotes`],
    ],
  ];
  it("writes plain paragraphs there as paragraphs of their own, as their replay shows", () => {
    for (let [tab, write] of places) {
      for (let text of ["Caption", "One\n\nTwo", "*Caption*"]) {
        let { simulated, fresh, applied } = replacementOutcome(tab(), ...write(text));
        expect(fresh).toBe(simulated);
        let added = text.split("\n\n").length;
        let lists = Array.from({ length: added + 1 },
          (_, index) => bodyParagraph(applied, index + 1).bullet?.listId);
        expect(lists)
          .toEqual([...Array(added).fill(undefined), "Q1"]);
        // A removed bullet leaves its indent behind, which is reset too.
        expect(indentedParagraphs(applied)).toEqual([]);
      }
    }
  });

  it("writes a plain paragraph in front of a subtitle as a normal paragraph", () => {
    let subtitle: ParagraphSpec = { runs: ["Notes\n"], namedStyleType: "SUBTITLE" };
    for (let tab of [
      () => buildTab([para("Before"), grid(["a", "b"]), subtitle, para("End")]),
      () => buildTab([para("Before"), subtitle, para("End")]),
    ]) {
      let oldMarkdown = tab().body.content.some(element => element.table) ? "</table>" : "Before";
      let { simulated, fresh, applied } =
        replacementOutcome(tab(), oldMarkdown, `${oldMarkdown}\n\nCaption`);
      expect(fresh).toBe(simulated);
      expect([1, 2].map(index => bodyParagraph(applied, index).paragraphStyle?.namedStyleType))
        .toEqual(["NORMAL_TEXT", "SUBTITLE"]);
    }
  });

  it("writes a heading there, and text in front of any other paragraph, as its replay shows", () => {
    for (let [tab, write] of places) {
      let { simulated, fresh, applied } = replacementOutcome(tab(), ...write("## Head"));
      expect(fresh).toBe(simulated);
      expect(bodyParagraph(applied, 1).bullet).toBeUndefined();
    }
    // Above a table that follows such an item, and below one in front of a bulleted item.
    let above = buildTab(
      [para("Start"), item("Notes", "Q1"), grid(["a", "b"]), para("End")], ALL_LISTS);
    expectParagraphTextSameAsGoogle(above, "<table>", "Caption\n\n<table>");
    let bulleted = buildTab(
      [para("Before"), grid(["a", "b"]), item("Notes"), para("End")], ALL_LISTS);
    expectParagraphTextSameAsGoogle(bulleted, "</table>", "</table>\n\nCaption");
  });
});

/** Named styles as a document gives them: Heading 6 italic, Heading 2 made bold, Subtitle plain. */
const NAMED_STYLES: NonNullable<GoogleDocsTab["namedStyles"]> = {
  styles: [
    { namedStyleType: "NORMAL_TEXT", textStyle: { bold: false, italic: false, strikethrough: false } },
    { namedStyleType: "HEADING_2", textStyle: { bold: true } },
    { namedStyleType: "HEADING_6", textStyle: { italic: true } },
    { namedStyleType: "SUBTITLE", textStyle: { italic: false } },
  ],
};

/** `blocks` in a tab with `NAMED_STYLES`. */
function styledTab(blocks: BlockSpec[], namedStyles = NAMED_STYLES): GoogleDocsTab {
  return { ...buildTab(blocks), namedStyles };
}

/**
 * A stored replacement, replayed with the tab its content came from, reads as the document does
 * once Google has applied it. Returns the replay and the document the model leaves.
 */
function expectStyledSameAsGoogle(
  tab: GoogleDocsTab, oldMarkdown: string, newMarkdown: string, inTable?: true,
): { simulated: EditableMarkdown; applied: GoogleDocsTab } {
  let before = docTabToMarkdown(tab);
  let replacement = { ...replacementIn(before.markdown, oldMarkdown, newMarkdown), inTable };
  let simulated = applyTextReplacement(contentOf(before), replacement, TAB, before);
  let requests = textReplacementRequests(before, replacement);
  let applied = tab;
  for (let options of MODELS) {
    applied = requests.length > 0 ? applyDocsRequests(tab, requests, options) : tab;
    expectRendering(simulated, applied);
  }
  return { simulated, applied };
}

describe("formatting a paragraph's named style already gives", () => {
  const body = () => styledTab([
    para("Before"), heading("Notes here", 6), heading("Results here", 2), para("After"),
  ]);
  const cells = () => styledTab([
    para("Before"),
    { table: [[cellOf(heading("Cell notes", 6)), cellOf(heading("Cell results", 2))], ["a\n", "b\n"]] },
    para("After"),
  ]);

  it("reads the named styles a tab gives its text", () => {
    expect(docTabToMarkdown(body()).namedFormatting).toEqual({
      HEADING_2: { bold: true }, HEADING_6: { italic: true },
    });
    expect(docTabToMarkdown(buildTab([para("x")])).namedFormatting).toBeNull();
  });

  it("drops it from text written into a paragraph outside tables, as Google stores it", () => {
    for (let [oldMarkdown, newMarkdown] of [
      ["###### Notes here", "###### Notes *there*"],
      ["###### Notes here", "###### *Notes* **here**"],
      ["## Results here", "## **Results** *here*"],
      ["## Results here", "## Results ~~here~~ **now**"],
      ["After", "After\n\n###### *New* note"],
      ["Before", "Before *and* **after**"],
    ]) {
      let { simulated } = expectStyledSameAsGoogle(body(), oldMarkdown, newMarkdown);
      expect(simulated.markdown).not.toContain("*Notes*");
    }
    expect(expectStyledSameAsGoogle(body(), "###### Notes here", "###### *Notes* here")
      .simulated.markdown).toContain("###### Notes here\n");
    expect(expectStyledSameAsGoogle(body(), "## Results here", "## **Results** *here*")
      .simulated.markdown).toContain("## Results *here*\n");
  });

  it("drops it from text written into a cell, and a row change queued behind it applies", () => {
    for (let [oldMarkdown, newMarkdown] of [
      ["<h6>Cell notes</h6>", "<h6><em>Cell</em> notes</h6>"],
      ["<h2>Cell results</h2>", "<h2><strong>Cell</strong> <em>results</em></h2>"],
      ["<p>a</p>", "<p><strong>a</strong></p>"],
    ]) {
      let { simulated, applied } = expectStyledSameAsGoogle(cells(), oldMarkdown, newMarkdown, true);
      let rows = addRows(simulated, 0, 2, [["x", "y"]]);
      let fresh = docTabToMarkdown(applied);
      expect(applyTableChange(contentOf(fresh), rows, fresh).markdown)
        .toBe(applyTableChange(simulated, rows).markdown);
    }
    let { simulated } = expectStyledSameAsGoogle(
      cells(), "<h6>Cell notes</h6>", "<h6><em>Cell</em> notes</h6>", true);
    expect(tableAt(simulated, 0)).toContain("<h6>Cell notes</h6>");
  });

  it("reads a paragraph a replacement gives another style by that style, as Google does", () => {
    // ask-bonk's case: a Heading 6, italic by its style, written as normal text keeps its italic.
    let { simulated } = expectStyledSameAsGoogle(body(), "###### Notes here", "*Notes* here");
    expect(simulated.markdown).toContain("\n*Notes* here\n");
    expectStyledSameAsGoogle(body(), "## Results here", "**Results** here");
    expectStyledSameAsGoogle(body(), "###### Notes here", "## *Notes* **here**");
    // A table placed after the paragraph as the read shows it finds it once Google applies it.
    let fresh = docTabToMarkdown(expectStyledSameAsGoogle(body(), "###### Notes here", "*Notes* here").applied);
    let table = newTable([["a"]], "\n*Notes* here\n");
    expect(() => applyTableChange(contentOf(fresh), table, fresh)).not.toThrow();
    expect(() => applyTableChange(simulated, table)).not.toThrow();
  });

  it("reads a subtitle as italic only where its named style makes it so", () => {
    let subtitle: ParagraphSpec = { runs: ["Sub\n"], namedStyleType: "SUBTITLE" };
    expect(docTabToMarkdown(styledTab([subtitle])).markdown).toBe("Sub\n");
    expect(docTabToMarkdown(styledTab([subtitle], {
      styles: [{ namedStyleType: "SUBTITLE", textStyle: { italic: true } }],
    })).markdown).toBe("*Sub*\n");
    expect(docTabToMarkdown(buildTab([subtitle])).markdown).toBe("*Sub*\n");
    expectStyledSameAsGoogle(styledTab([para("Before"), subtitle]), "Sub", "Subtitle");
    expectStyledSameAsGoogle(styledTab([para("Before"), subtitle]), "Sub", "*Sub*title");
  });
});

describe("the refusals a table causes beside it", () => {
  it("says to retry where a waiting edit removed the paragraph beside the table", () => {
    let titled = () => buildTab([para("Title"), grid(["a"]), para("After")]);
    let content = read(titled());
    let headless = applyTextReplacement(
      content, replacementIn(content.markdown, "Title\n", ""), TAB);
    expect(headless.markdown.startsWith("\n<table>")).toBe(true);
    expect(headless.protectedRanges[0].mdStart).toBe(0);
    for (let oldMarkdown of ["<table>", "\n<table>"]) {
      let replacement = replacementIn(headless.markdown, oldMarkdown, "Intro\n\n<table>");
      expect(message(() => applyTextReplacement(headless, replacement, TAB)))
        .toBe(paragraphMissing("before"));
      expect(classifyReplacement(headless, replacement)).toEqual(edgePlace("before", false, false));
    }
    let tailless = applyTextReplacement(
      content, replacementIn(content.markdown, "After\n", ""), TAB);
    expect(tailless.markdown.endsWith("</table>\n\n")).toBe(true);
    expect(message(() => applyTextReplacement(
      tailless, replacementIn(tailless.markdown, "</table>", "</table>\n\nCaption"), TAB)))
      .toBe(paragraphMissing("after"));

    // Once the edit has applied, the tab holds the paragraph, emptied, and the text is added.
    let applied = buildTab([para(""), grid(["a"]), para("After")]);
    expect(read(applied).markdown.startsWith("\n\n<table>")).toBe(true);
    expectParagraphTextSameAsGoogle(applied, "<table>", "Intro\n\n<table>");
  });

  it("says to retry, and not that a paragraph is read-only, between two tables", () => {
    let tables = (middle: ParagraphSpec) =>
      buildTab([para("Before"), grid(["a"]), middle, grid(["b"]), para("After")]);
    let content = read(tables(para("Mid")));
    let between = applyTextReplacement(content, replacementIn(content.markdown, "Mid\n", ""), TAB);
    let above = replacementIn(
      between.markdown, "<table>", "Intro\n\n<table>", between.markdown.lastIndexOf("<table>"));
    let below = replacementIn(
      between.markdown, "</table>", "</table>\n\nCaption", between.markdown.indexOf("</table>"));
    expect(message(() => applyTextReplacement(between, above, TAB)))
      .toBe(paragraphMissing("before"));
    expect(message(() => applyTextReplacement(between, below, TAB)))
      .toBe(paragraphMissing("after"));

    let applied = docTabToMarkdown(tables(para("")));
    for (let replacement of [
      replacementIn(
        applied.markdown, "<table>", "Intro\n\n<table>", applied.markdown.lastIndexOf("<table>")),
      replacementIn(
        applied.markdown, "</table>", "</table>\n\nCaption", applied.markdown.indexOf("</table>")),
    ]) {
      let simulated = applyTextReplacement(contentOf(applied), replacement, TAB);
      let requests = textReplacementRequests(applied, replacement);
      expect(simulated.markdown)
        .toBe(docTabToMarkdown(applyDocsRequests(tables(para("")), requests)).markdown);
    }
  });

  it("says to retry for a fresh tab whose first block is a table", () => {
    let first = docTabToMarkdown(buildTab([grid(["a"]), para("After")]));
    let replacement = replacementIn(first.markdown, "<table>", "Intro\n\n<table>");
    expect(message(() => textReplacementRequests(first, replacement)))
      .toBe(paragraphMissing("before"));
  });

  it("names the read-only paragraph that stands in the way", () => {
    for (let [oldMarkdown, newMarkdown] of [
      ["<table>", "Intro\n\n<table>"],
      ["Owner: Ana\n\n<table>", "Owner: Ana\n\nIntro\n\n<table>"],
      ["Owner: Ana\n", "Owner: Ana\n\nIntro\n"],
      ["<table>", "Intro <table>"],
      ["Owner: Ana\n\n<table>", "<table>"],
    ]) {
      expect(textRefusal(CHIP_TABLE_DUE(), oldMarkdown, newMarkdown))
        .toBe(readOnlyBeside("before"));
    }
    expect(textRefusal(CHIP_TABLE_DUE(), "</table>", "</table>\n\nCaption"))
      .toBe(readOnlyBeside("after"));
    expect(textRefusal(CHIP_TABLE_DUE(), "\n\nDue Nov 8, 2026", "")).toBe(readOnlyBeside("after"));
    // No other message would help: the paragraph can be neither emptied nor added to.
    expect(textRefusal(CHIP_TABLE_DUE(), "Owner: Ana", "")).toBe(CONVERTER_REFUSAL);
    expect(textRefusal(CHIP_TABLE_DUE(), "Owner: Ana", "Owner: Ana\n\nIntro"))
      .toBe(CONVERTER_REFUSAL);

    let emptyBelow = buildTab([para("Before"), grid(["a"]), para(""), dateChip()]);
    expect(textRefusal(emptyBelow, "</table>", "</table>\n\nCaption"))
      .toBe(readOnlyBeside("after"));
    expectParagraphTextSameAsGoogle(emptyBelow, "<table>", "Intro\n\n<table>");
  });

  it("refuses text at an edge that is not whole paragraphs set apart by a blank line", () => {
    expect(textRefusal(BTA(), "<table>", "Intro <table>")).toBe(EDGE_REFUSAL);
    expect(textRefusal(BTA(), "</table>", "</table>X")).toBe(EDGE_REFUSAL);
    expect(textRefusal(BTA(), "</table>", "</table>\nCaption")).toBe(EDGE_REFUSAL);
    // The equivalent is refused by the paragraph path as structured content: the same message.
    let before = docTabToMarkdown(BTA());
    let place = classify(contentOf(before), "<table>", "- X\n\n\n<table>");
    if (place.kind !== "edge" || !place.equivalent) throw new Error("Expected an equivalent");
    let { equivalent } = place;
    expect(outcome(() => converterReplay(contentOf(before), equivalent)))
      .toEqual({ error: CONVERTER_REFUSAL, structured: true });
    let listItem = replacementIn(before.markdown, "<table>", "- X\n\n\n<table>");
    expect(message(() => applyTextReplacement(contentOf(before), listItem, TAB)))
      .toBe(EDGE_REFUSAL);
    // The paragraph path's request builder takes that equivalent where its replay refuses it;
    // a change is queued only once its replay has accepted it.
    expect(textReplacementRequests(before, listItem))
      .toEqual(converterRequests(before, equivalent));
    expectAsConverter(BTA(), "<table>", "X\n\n\n<table>", ["Before", "Before\n\nX\n"]);
  });

  it("names the other blank line where the paragraph can be removed that way", () => {
    for (let [oldMarkdown, newMarkdown] of [
      ["B\n\n", ""], ["B\n\n<table>", "<table>"], ["A\n\nB\n\n<table>", "A\n\n<table>"],
      ["\n\nAfter", ""],
    ]) {
      expect(textRefusal(ABTAT(), oldMarkdown, newMarkdown)).toBe(BLANK_OTHER_SIDE);
    }
    for (let [oldMarkdown, newMarkdown] of [["\n\nB", ""], ["A\n\nB", "A"], ["After\n\n", ""]]) {
      expectAsConverter(ABTAT(), oldMarkdown, newMarkdown);
      expectParagraphTextSameAsGoogle(ABTAT(), oldMarkdown, newMarkdown);
    }
    let todo = buildTab([para("A"), para("<TODO>"), grid(["a"]), para("After")]);
    expect(textRefusal(todo, "<TODO>\n\n<table>", "<table>")).toBe(BLANK_OTHER_SIDE);
    expectAsConverter(todo, "\n\n<TODO>", "");
  });

  it("names the way out where a list item stands before the paragraph", () => {
    let tab = buildTab([item("item"), para("Bee"), grid(["a"]), para("After")], ALL_LISTS);
    expect(textRefusal(tab, "Bee\n\n", "")).toBe(BLANK_OTHER_SIDE);
    // The other phrasing is refused by the request builder alone, in the paragraph path's words.
    let before = docTabToMarkdown(tab);
    let other = replacementIn(before.markdown, "\n\nBee", "");
    expect(() => applyTextReplacement(contentOf(before), other, TAB)).not.toThrow();
    expect(message(() => textReplacementRequests(before, other))).toBe(
      "replaceText: cannot keep a list item while deleting the paragraphs that end its " +
      "section. Delete them in an edit that leaves the list item alone.");
    expectAsConverter(tab, "Bee", "");
    expectParagraphTextSameAsGoogle(tab, "Bee", "");
  });

  it("says a paragraph Google Docs keeps beside a table can only be emptied", () => {
    let twoTables = buildTab([para("Before"), grid(["a"]), para(""), grid(["b"]), para("After")]);
    expect(textRefusal(twoTables, "</table>\n\n\n\n<table>", "</table>\n\n<table>"))
      .toBe(BLANK_KEPT);
    let titled = () => buildTab([para("Title"), grid(["a"]), para("After")]);
    expect(textRefusal(titled(), "Title\n\n<table>", "<table>")).toBe(BLANK_KEPT);
    expect(textRefusal(titled(), "\n\nAfter", "")).toBe(BLANK_KEPT);
    let contents = buildTab([para("Before"), toc, para("Mid"), grid(["a"]), para("After")]);
    expect(textRefusal(contents, "Mid\n\n<table>", "<table>")).toBe(BLANK_KEPT);
    for (let line of ["Title", "After"]) {
      expectAsConverter(titled(), line, "");
      expectParagraphTextSameAsGoogle(titled(), line, "");
    }
  });

  it("says so where a read-only paragraph stands on the paragraph's other side", () => {
    expect(textRefusal(CHIP_B_TABLE_AFTER_DUE(), "B\n\n", "")).toBe(BLANK_READ_ONLY);
    expect(textRefusal(CHIP_B_TABLE_AFTER_DUE(), "\n\nAfter", "")).toBe(BLANK_READ_ONLY);
    expect(textRefusal(CHIP_B_TABLE_AFTER_DUE(), "\n\nB", "")).toBe(CONVERTER_REFUSAL);
    expect(textRefusal(CHIP_B_TABLE_AFTER_DUE(), "After\n\n", "")).toBe(CONVERTER_REFUSAL);
    expectAsConverter(CHIP_B_TABLE_AFTER_DUE(), "B", "");
    expectAsConverter(CHIP_B_TABLE_AFTER_DUE(), "After", "");
  });

  it("refuses a change to a table together with what is around it", () => {
    let two = buildTab([para("Before"), grid(["a"]), para("Mid"), grid(["b"]), para("After")]);
    let whole = docTabToMarkdown(BTA()).markdown;
    expect(textRefusal(BTA(), "Before\n\n<table>\n  <tr>\n    <td><p>a", "X")).toBe(TOGETHER);
    expect(textRefusal(BTA(), whole, whole.replace("Before", "Earlier").replace("After", "Later")))
      .toBe(TOGETHER);
    expect(textRefusal(BTA(), `\n\n${tableAt(read(BTA()), 0)}\n\n`, "\n\n")).toBe(TOGETHER);
    expect(textRefusal(two, "a</p></td>\n  </tr>\n</table>\n\nMid\n\n<table>\n  <tr>\n    <td><p>b", "ab"))
      .toBe(TOGETHER);
  });

  it("leaves the paragraph path's refusal where no table is the reason", () => {
    let tab = buildTab([para("Before"), toc, chip(), grid(["a", "b"]), para("After")]);
    expect(textRefusal(tab, "[Table of contents]", "[Contents]")).toBe(CONVERTER_REFUSAL);
    expect(textRefusal(tab, "Owner: Ana", "Owner: Ben")).toBe(CONVERTER_REFUSAL);
    // A record queued for a paragraph whose text has moved into a cell.
    expect(textRefusal(tab, "<p>a</p>", "<p>changed</p>")).toBe(CONVERTER_REFUSAL);
  });

  it("refuses a record queued for text in a table whose text is no longer in one", () => {
    let before = docTabToMarkdown(BTA());
    let stored = { ...replacementIn(before.markdown, "Before", "Earlier"), inTable: true as const };
    let refused = "replaceText: this change was queued for text in a table, and that text is no " +
      "longer in one.";
    expect(message(() => applyTextReplacement(contentOf(before), stored, TAB))).toBe(refused);
    expect(message(() => textReplacementRequests(before, stored))).toBe(refused);
  });
});

/** A paragraph path's answer that refuses the replacement as structured content. */
const structured = (): never => {
  throw new StructuredContentError();
};

/** A paragraph path that notes what it is handed and answers each call as `answers` say. */
function recording(...answers: (() => unknown)[]) {
  let calls: TextReplacement[] = [];
  let run = (replacement: TextReplacement): unknown => {
    let answer = answers[calls.length];
    calls.push(replacement);
    if (!answer) throw new Error("The paragraph path was run once more than expected");
    return answer();
  };
  return { calls, run };
}

/** What `run` throws, whatever it is. */
function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("Expected a refusal");
}

describe("runParagraphReplacement", () => {
  const content = read(BTA());
  const atEdge = replacementIn(content.markdown, "<table>", "Intro\n\n<table>");

  it("hands the replacement itself to the paragraph path and returns what that returns", () => {
    let result = { accepted: true };
    let { calls, run } = recording(() => result);
    // The strings as written lie at a table's edge, which is not looked at once it is accepted.
    expect(runParagraphReplacement(content, atEdge, run)).toBe(result);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(atEdge);
  });

  it("hands it the equivalent beside the table when the first is structured content", () => {
    let place = classifyReplacement(content, atEdge);
    if (place.kind !== "edge" || !place.equivalent) throw new Error("Expected an equivalent");
    let { calls, run } = recording(structured, () => "moved");
    expect(runParagraphReplacement(content, atEdge, run)).toBe("moved");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toBe(atEdge);
    expect(calls[1]).not.toBe(atEdge);
    expect(calls[1]).toEqual(place.equivalent);
    expect(calls[1]).toEqual({ matchStart: 0, oldMarkdown: "Before", newMarkdown: "Before\n\nIntro" });
  });

  it("answers an equivalent that is structured content too with the edge refusal", () => {
    let { calls, run } = recording(structured, structured);
    expect(message(() => runParagraphReplacement(content, atEdge, run))).toBe(EDGE_REFUSAL);
    expect(calls).toHaveLength(2);
  });

  it("lets every other error through as it is, from either call", () => {
    let failure = new Error("replaceText: the paragraph path's own refusal");
    let fail = (): never => {
      throw failure;
    };
    let first = recording(fail);
    expect(thrown(() => runParagraphReplacement(content, atEdge, first.run))).toBe(failure);
    expect(first.calls).toHaveLength(1);
    let second = recording(structured, fail);
    expect(thrown(() => runParagraphReplacement(content, atEdge, second.run))).toBe(failure);
    expect(second.calls).toHaveLength(2);
  });

  it("rethrows the structured-content refusal itself where no table is the reason", () => {
    for (let [kind, oldMarkdown, newMarkdown] of [
      ["none", "Before", "Earlier"], ["table", "<p>a</p>", "<p>changed</p>"],
    ]) {
      let replacement = replacementIn(content.markdown, oldMarkdown, newMarkdown);
      expect(classifyReplacement(content, replacement).kind).toBe(kind);
      let refused = new StructuredContentError();
      let { calls, run } = recording(() => {
        throw refused;
      });
      expect(thrown(() => runParagraphReplacement(content, replacement, run))).toBe(refused);
      expect(calls).toHaveLength(1);
    }
  });

  it("runs the paragraph path once where a table's own refusal is the answer", () => {
    let cases: [() => GoogleDocsTab, string, string, string][] = [
      [BTA, "<table>", "Intro <table>", EDGE_REFUSAL],
      [CHIP_TABLE_DUE, "<table>", "Intro\n\n<table>", readOnlyBeside("before")],
      [ABTAT, "B\n\n", "", BLANK_OTHER_SIDE],
      [CHIP_TABLE_DUE, "\n\nDue Nov 8, 2026", "", readOnlyBeside("after")],
      [BTA, "Before\n\n<table>\n  <tr>\n    <td><p>a", "X", TOGETHER],
    ];
    for (let [tab, oldMarkdown, newMarkdown, refusedWith] of cases) {
      let beside = read(tab());
      let replacement = replacementIn(beside.markdown, oldMarkdown, newMarkdown);
      let { calls, run } = recording(structured);
      expect(message(() => runParagraphReplacement(beside, replacement, run))).toBe(refusedWith);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toBe(replacement);
    }
  });
});

// ---------------------------------------------------------------------------
// The ends of the tab
// ---------------------------------------------------------------------------

/** The document the model leaves for a change built against the tab as Google returns it. */
const appliedTo = (tab: GoogleDocsTab, change: (content: EditableMarkdown) => TableChange) => {
  let before = docTabToMarkdown(tab);
  return applyDocsRequests(tab, tableChangeRequests(before, change(contentOf(before))));
};

describe("the ends of the tab", () => {
  const T = tableHtml([["t"]]);

  it("reads a last line that lost its line break as the paragraph the tab keeps", () => {
    let view: EditableMarkdown = { markdown: "Before\n\nLater", protectedRanges: [], tables: [] };
    let tab = buildTab([para("Before"), para("Later")]);
    for (let after of [undefined, "Later"]) {
      let simulated = applyTableChange(view, newTable([["t"]], after));
      expect(simulated.markdown).toBe(`Before\n\nLater\n\n${T}\n\n\n`);
      expectRendering(simulated, appliedTo(tab, () => newTable([["t"]], after)));
    }
  });

  it("reads the separator a removed last paragraph left as the paragraph the tab keeps", () => {
    let content = read(buildTab([para("Before"), grid(["x"]), para("After")]));
    let view = applyTextReplacement(content, replacementIn(content.markdown, "After\n", ""), TAB);
    expect(view.markdown.endsWith("</table>\n\n")).toBe(true);
    // The tab keeps that paragraph, emptied.
    let tab = buildTab([para("Before"), grid(["x"]), para("")]);
    expectRendering(
      applyTableChange(view, newTable([["t"]])), appliedTo(tab, () => newTable([["t"]])));
    expectRendering(
      applyTableChange(view, newTable([["t"]], "x")), appliedTo(tab, () => newTable([["t"]], "x")));
    let deleted = applyTableChange(view, dropTable(view, 0));
    expect(deleted.markdown).toBe("Before\n\n\n");
    expectRendering(deleted, appliedTo(tab, fresh => dropTable(fresh, 0)));
  });

  it("reads a table's separator at the start of the content as the paragraph the tab keeps", () => {
    let content = read(buildTab([para("Title"), grid(["x"]), para("After")]));
    let view = applyTextReplacement(content, replacementIn(content.markdown, "Title\n", ""), TAB);
    expect(view.markdown.startsWith("\n<table>")).toBe(true);
    expect(view.protectedRanges[0].mdStart).toBe(0);
    let tab = buildTab([para(""), grid(["x"]), para("After")]);

    let deleted = applyTableChange(view, dropTable(view, 0));
    expect(deleted.markdown).toBe("\n\nAfter\n");
    expectRendering(deleted, appliedTo(tab, fresh => dropTable(fresh, 0)));
    let added = applyTableChange(view, newTable([["t"]], "x"));
    expectRendering(added, appliedTo(tab, () => newTable([["t"]], "x")));
    // A row change does not look past its table, and leaves the content's start as it is.
    let widened = applyTableChange(view, addRows(view, 0, 1, [["y"]]));
    expect(widened.markdown.startsWith("\n<table>")).toBe(true);
    expect(widened.protectedRanges[0].mdStart).toBe(0);
  });

  it("takes no base on the tab's own rendering, whose even tail is real", () => {
    let quiet = item("", "Q1");
    let withTable = () => buildTab([para("X"), grid(["x"]), quiet, quiet], ALL_LISTS);
    let content = read(withTable());
    expect(content.markdown.endsWith("</table>\n\n\n\n")).toBe(true);
    let deleted = expectSameAsGoogle(withTable(), dropTable(content, 0));
    expect(docTabToMarkdown(deleted).markdown).toBe("X\n\n\n\n");

    let items = () => buildTab([para("X"), quiet, quiet], ALL_LISTS);
    expect(read(items()).markdown).toBe("X\n\n\n\n");
    let added = expectSameAsGoogle(items(), newTable([["t"]]));
    expect(docTabToMarkdown(added).markdown).toBe(`X\n\n\n\n\n${T}\n\n\n`);

    // Behind other changes there is no tab to say the tail is real: one line break more.
    expect(applyTableChange(content, dropTable(content, 0)).markdown).toBe("X\n\n\n\n\n");
    expect(applyTableChange(read(items()), newTable([["t"]])).markdown)
      .toBe(`X\n\n\n\n\n\n${T}\n\n\n`);
  });
});

// ---------------------------------------------------------------------------
// Behind an append
// ---------------------------------------------------------------------------

/** Replay an append as the connection does: the tab's text kept, ranges and tables as they are. */
const withAppended = (content: EditableMarkdown, text: string): EditableMarkdown => ({
  ...content,
  markdown: canonicalizeMarkdownAppend(content.markdown, canonicalizeMarkdownForWrite(text)),
});

describe("a table change behind an append", () => {

  it("finds its table as it was read, whatever the tab and the appended text hold", () => {
    for (let [beforeText, cell, text] of [
      ["Before", "Required*", "*Source: finance.*"],
      ["Be*fore", "plain", "x * y"],
      ["Before", "a ~~ b", "x ~~ y"],
      ["Before", "see [1", "x](https://y.example)"],
    ]) {
      let tab = buildTab([para(beforeText), grid([cell, "other"]), para("After")]);
      let before = docTabToMarkdown(tab);
      let simulated = withAppended(contentOf(before), text);
      expect(simulated.markdown.startsWith(before.markdown)).toBe(true);
      let written = applyDocsRequests(tab, markdownToDocRequests(
        `\n${text}`, before.bodyEndIndex - 1, before.tabId,
        { resetParagraphs: true, preserveLeadingParagraph: true }));
      expectRendering(simulated, written);

      // A row for the table, recorded from the simulated content, lands in it.
      let rows = addRows(simulated, 0, 1, [["new", "row"]]);
      expect(resolveTable(simulated, refOf(simulated, 0), rows.type)).toBe(0);
      expect(resolveTable(read(written), refOf(simulated, 0), rows.type)).toBe(0);
      expectRendering(applyTableChange(simulated, rows, before), expectSameAsGoogle(written, rows));
    }
  });
});

// ---------------------------------------------------------------------------
// Chains and random sequences
// ---------------------------------------------------------------------------

/** One step of a sequence: a table change, or a replacement found at `matchStart`. */
type Step = TableChange | (TextReplacement & { type: "replaceText"; inTable?: true });

/**
 * Apply a step to the model's document and replay it over the simulated content of the steps
 * before it, in both forms. Returns the document and the content after it, or nothing when the
 * engine refuses the step against the document.
 */
function advance(
  tab: GoogleDocsTab, content: EditableMarkdown, step: Step,
): { tab: GoogleDocsTab; content: EditableMarkdown } | undefined {
  let before = docTabToMarkdown(tab);
  // The content carried from the steps before reads as the document does.
  expect(content.markdown).toBe(before.markdown);
  let replay = (tabOfContent?: DocTabSnapshot) => step.type === "replaceText"
    ? applyTextReplacement(content, step, TAB)
    : applyTableChange(content, step, tabOfContent);
  let requests: GoogleDocsRequest[];
  try {
    requests = step.type === "replaceText"
      ? textReplacementRequests(before, step) : tableChangeRequests(before, step);
  } catch (error) {
    // What the request builder refuses, the replay over the tab's own rendering refuses too.
    expect(attempt(() => replay(before))).toBe(error instanceof Error ? error.message : "");
    return undefined;
  }
  let simulated = replay(before);
  let view = step.type === "replaceText" ? undefined : attempt(() => replay());
  let applied = tab;
  for (let options of MODELS) {
    applied = requests.length > 0 ? applyDocsRequests(tab, requests, options) : tab;
    expectRendering(simulated, applied);
    if (step.type !== "replaceText" && view === undefined) expectRendering(replay(), applied);
  }
  return { tab: applied, content: simulated };
}

function mustAdvance(tab: GoogleDocsTab, content: EditableMarkdown, step: Step) {
  let next = advance(tab, content, step);
  if (!next) throw new Error(`The engine refused ${step.type}`);
  return next;
}

/** A replacement of the `index`-th editable text of a table's cell by `html`. */
function cellReplacement(
  content: EditableMarkdown, table: number, row: number, column: number, html: string,
): Step | undefined {
  let target = content.tables[table];
  let cell = tableLines(content.markdown, target).rows[row]?.cells[column];
  let text = cell && tableRowCells(target, row)[column]?.texts[0];
  if (!cell || !text) return undefined;
  let matchStart = cell.mdStart + text[0];
  return {
    type: "replaceText", matchStart, inTable: true,
    oldMarkdown: content.markdown.slice(matchStart, cell.mdStart + text[1]), newMarkdown: html,
  };
}

describe("chains of changes", () => {
  it("reads as the document does after every step of a table's life", () => {
    let tab = buildTab([para("Before"), para("After")]);
    let state = { tab, content: read(tab) };
    state = mustAdvance(state.tab, state.content, newTable([["a", "b"], ["c", "d"]], "Before"));
    state = mustAdvance(state.tab, state.content, addRows(state.content, 0, 1, [["new", "row"]]));
    let fill = cellReplacement(state.content, 0, 2, 1, "<strong>filled</strong> &amp; done");
    if (!fill) throw new Error("Expected an editable text");
    state = mustAdvance(state.tab, state.content, fill);
    state = mustAdvance(
      state.tab, state.content, addColumns(state.content, 0, 2, [["x"], ["y"], ["z"]]));
    state = mustAdvance(state.tab, state.content, dropColumns(state.content, 0, 0));
    state = mustAdvance(state.tab, state.content, dropRows(state.content, 0, 0));
    expect(tableAt(state.content, 0)).toBe(
      "<table>\n  <tr>\n    <td><p>row</p></td>\n    <td><p>y</p></td>\n  </tr>\n  <tr>\n" +
      "    <td><p><strong>filled</strong> &amp; done</p></td>\n    <td><p>z</p></td>\n  </tr>\n</table>");
    state = mustAdvance(state.tab, state.content, dropTable(state.content, 0));
    expect(state.content.markdown).toBe("Before\n\n\n\nAfter\n");
  });

  it("runs every operation on the content every other operation leaves", () => {
    /** The operations, each on the first table of the content it is given. */
    let operations: ((content: EditableMarkdown) => Step | undefined)[] = [
      content => newTable([["n1", "n2"]], content.tables.length > 0 ? "After" : undefined),
      content => content.tables[0] && addRows(content, 0, 1, [
        ["r1", "r2", "r3"].slice(0, tableSize(content.markdown, content.tables[0], "x").columns),
      ]),
      content => content.tables[0] && addColumns(
        content, 0, 1, content.tables[0].rows.map((_, row) => [`c${row}`])),
      content => content.tables[0] && dropRows(content, 0, 0),
      content => content.tables[0] && dropColumns(content, 0, 0),
      content => content.tables[0] && cellReplacement(content, 0, 0, 0, "<em>changed</em>"),
      content => content.tables[0] && dropTable(content, 0),
    ];
    let steps = 0;
    for (let first of operations) {
      for (let second of operations) {
        let tab = buildTab([para("Before"), sized(3, 3), para("After")]);
        let state = { tab, content: read(tab) };
        for (let operation of [first, second]) {
          let step = operation(state.content);
          if (!step) continue;
          state = mustAdvance(state.tab, state.content, step);
          steps++;
        }
      }
    }
    expect(steps).toBeGreaterThan(90);
  });
});

/** A seeded generator of numbers in [0, 1). */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = state + 0x6d2b79f5 | 0;
    let mixed = Math.imul(state ^ state >>> 15, 1 | state);
    mixed = mixed + Math.imul(mixed ^ mixed >>> 7, 61 | mixed) ^ mixed;
    return ((mixed ^ mixed >>> 14) >>> 0) / 4294967296;
  };
}

const escapeCellHtml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll("\u000b", "<br>");

describe("random sequences of changes", () => {
  // Texts with emoji that share a high surrogate, and text that reads like an escape.
  const POOL = [
    "", "x", "two words", "\u{1F600}", "\u{1F601} done", "\u{1F7E2} On track", "\u{1F534}",
    "use &lt; here", "a & b", "one\ntwo", "line\u000bbreak",
  ];

  it("reads as the document does after every step", () => {
    let random = seeded(20261109);
    let pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)];
    let below = (limit: number) => Math.floor(random() * limit);
    let cells = (rows: number, columns: number) =>
      Array.from({ length: rows }, () => Array.from({ length: columns }, () => pick(POOL)));
    let made = 0;
    let refused = 0;

    for (let sequence = 0; sequence < 300; sequence++) {
      // Blocks of every kind around one table, so that every step has a table to change.
      let blocks = Array.from({ length: 3 + below(4) }, (_, index): [Kind, string, string] =>
        [pick(ALL_KINDS), `K${index}`, index % 2 === 0 ? "L1" : "L2"]);
      blocks[below(blocks.length)] = ["table", "TABLE", ""];
      let tab = assemble(blocks);
      let state = { tab, content: read(tab) };
      for (let stepIndex = 0; stepIndex < 4; stepIndex++) {
        let { content } = state;
        let table = below(Math.max(1, content.tables.length));
        let target = content.tables[table];
        let size = target && attempt(() => tableSize(content.markdown, target, "x")) === undefined
          ? tableSize(content.markdown, target, "x") : undefined;
        let lines = content.markdown.split("\n").filter(line => line.trim() !== "");
        let step: Step | undefined;
        switch (below(8)) {
          case 0:
            step = newTable(
              cells(1 + below(2), 1 + below(3)), pick([undefined, pick(lines), `${pick(lines)}\n`]));
            break;
          case 1:
            if (size) step = addRows(
              content, table, below(size.rows + 1), cells(1 + below(2), size.columns));
            break;
          case 2:
            if (size) step = addColumns(
              content, table, below(size.columns + 1), cells(size.rows, 1 + below(2)));
            break;
          case 3:
            if (size) step = dropRows(content, table, below(size.rows), 1);
            break;
          case 4:
            if (size) step = dropColumns(content, table, below(size.columns), 1);
            break;
          case 5:
            if (target) step = dropTable(content, table);
            break;
          case 6:
            if (size) {
              let text = pick(POOL.filter(candidate => !candidate.includes("\n")));
              let html = escapeCellHtml(text);
              html = pick([html, `<strong>${html}</strong>`, `${html}<em>!</em>`]);
              step = cellReplacement(content, table, below(size.rows), below(size.columns), html);
            }
            break;
          default:
            if (target) {
              let above = random() < 0.5;
              let text = pick(["Plain words", "## A heading", "One\n\nTwo"]);
              step = above
                ? {
                  type: "replaceText", matchStart: target.mdStart, oldMarkdown: "<table>",
                  newMarkdown: `${text}\n\n<table>`,
                }
                : {
                  type: "replaceText", matchStart: target.mdEnd - 8, oldMarkdown: "</table>",
                  newMarkdown: `</table>\n\n${text}`,
                };
            }
        }
        if (!step) continue;
        let next = advance(state.tab, state.content, step);
        if (next) {
          state = next;
          made++;
        } else {
          refused++;
        }
      }
    }
    // Most steps are made; the rest are refused by the request builder and by the replay alike.
    expect(made).toBeGreaterThan(700);
    expect(refused).toBeGreaterThan(100);
  });
});

describe("a table's look through changes to its rows and columns", () => {
  const pt = (magnitude: number) => ({ magnitude, unit: "PT" });
  const red = { color: { rgbColor: { red: 1 } } };
  const blue = { color: { rgbColor: { blue: 1 } } };
  const SHADED: CellSpec = {
    paragraphs: [para("e")],
    tableCellStyle: {
      backgroundColor: { color: { rgbColor: { red: 1, green: 0.8 } } }, contentAlignment: "MIDDLE",
      paddingLeft: pt(9), borderRight: { width: pt(2), dashStyle: "SOLID", color: red },
      borderBottom: { width: pt(3), dashStyle: "DASH", color: blue },
    },
  };
  const styled = (): GoogleDocsTab => buildTab([para("Before"), {
    table: [
      ["a\n", "b\n", "c\n"],
      ["d\n", SHADED, { paragraphs: [para("f")], tableCellStyle: { borderLeft: { width: pt(2), dashStyle: "SOLID", color: red } } }],
      ["g\n", { paragraphs: [para("h")], tableCellStyle: { borderTop: { width: pt(3), dashStyle: "DASH", color: blue } } }, "i\n"],
    ],
    columns: [null, 120, null],
    heights: [0, 40, 0],
  }, para("After")]);
  const SHADED_TAG = '<td style="background-color:#ffcc00;vertical-align:middle;padding-left:9pt;' +
    'border-right:2pt solid #ff0000;border-bottom:3pt dashed #0000ff">';

  it("gives added rows the look and height of the row they copy, as Google does", () => {
    for (let [at, cells] of [[1, [["x", "y", "z"]]], [2, [[], []]], [3, [["end"]]]] as const) {
      let tab = styled();
      let applied = expectSameAsGoogle(tab, addRows(read(tab), 0, at, cells.map(row => [...row])));
      let html = tableAt(read(applied), 0);
      let reference = Math.min(at, 2);
      let copies = html.split(SHADED_TAG).length - 1;
      expect(copies, `at ${at}`).toBe(reference === 1 ? 1 + cells.length : 1);
      expect(html.split('<tr style="height:40pt">').length - 1).toBe(reference === 1 ? 1 + cells.length : 1);
    }
  });

  it("gives added columns the look and width of the column they copy, and keeps fixed widths", () => {
    let tab = styled();
    let applied = expectSameAsGoogle(tab, addColumns(read(tab), 0, 1, [["n"], [""], [""]]));
    expect(tableAt(read(applied), 0)).toContain(
      '  <colgroup><col><col style="width:120pt"><col style="width:120pt"><col></colgroup>');
    // Beside a column that shares the page's width, the fixed widths are set again.
    let atEnd = addColumns(read(tab), 0, 3, [["n"], [""], [""]]);
    let requests = tableChangeRequests(docTabToMarkdown(tab), atEnd);
    expect(requests.filter(request => "updateTableColumnProperties" in request)).toEqual([{
      updateTableColumnProperties: {
        tableStartLocation: { index: docTabToMarkdown(tab).sourceMap.tables[0].docStart, tabId: TAB },
        columnIndices: [1],
        tableColumnProperties: { widthType: "FIXED_WIDTH", width: { magnitude: 120, unit: "PT" } },
        fields: "widthType,width",
      },
    }]);
    applied = expectSameAsGoogle(tab, atEnd);
    expect(tableAt(read(applied), 0)).toContain(
      '  <colgroup><col><col style="width:120pt"><col><col></colgroup>');
  });

  it("takes the look of deleted rows and columns away with them", () => {
    let tab = styled();
    let applied = expectSameAsGoogle(tab, dropColumns(read(tab), 0, 1));
    let html = tableAt(read(applied), 0);
    expect(html).not.toContain("<colgroup>");
    expect(html).toContain('<td style="border-left:2pt solid #ff0000"><p>f</p></td>');
    applied = expectSameAsGoogle(tab, dropRows(read(tab), 0, 1));
    expect(tableAt(read(applied), 0)).not.toContain("height:40pt");
    expect(tableAt(read(applied), 0)).toContain('<td style="border-top:3pt dashed #0000ff"><p>h</p></td>');
  });

  it("writes the table's own style again when an added row changes what most cells share", () => {
    let shaded = (text: string): CellSpec =>
      ({ paragraphs: [para(text)], tableCellStyle: { backgroundColor: { color: { rgbColor: { green: 1 } } } } });
    let tab = buildTab([para("Before"), { table: [[shaded("a"), shaded("b")], ["c\n", "d\n"]] }, para("After")]);
    expect(tableAt(read(tab), 0).startsWith("<table>\n")).toBe(true);
    let applied = expectSameAsGoogle(tab, addRows(read(tab), 0, 0, [["x", "y"]]));
    expect(tableAt(read(applied), 0)).toContain(
      '<table style="background-color:#00ff00">\n  <tr>\n    <td><p>x</p></td>');
  });

  it("keeps a table Google adds plain, though it stores every default", () => {
    let tab = buildTab([para("Before"), para("After")]);
    let applied = expectSameAsGoogle(tab, newTable([["a", "b"]], "Before"));
    expect(tableAt(read(applied), 0).startsWith("<table>\n  <tr>\n    <td><p>a</p></td>")).toBe(true);
    expect(JSON.stringify(applied.body.content)).toContain('"paddingTop":{"magnitude":5');
  });
});

describe("setting the look of a table's cells", () => {
  const grid3 = (): GoogleDocsTab => buildTab([para("Before"), grid(["a", "b", "c"], ["d", "e", "f"], ["g", "h", "i"]), para("After")]);
  const styleChange = (
    content: EditableMarkdown, row: number, column: number, rows: number, columns: number,
    style: Extract<TableChange, { type: "setTableCellStyle" }>["style"],
  ): TableChange => ({ type: "setTableCellStyle", row, column, rows, columns, style, ...refOf(content, 0) });

  it("shades, aligns and pads a block, and clears shading, as Google does", () => {
    let tab = grid3();
    let shaded = expectSameAsGoogle(tab, styleChange(read(tab), 0, 0, 2, 2,
      { background: "#ffcc00", verticalAlign: "middle", padding: { top: "8pt", left: "0.5pt" } }));
    let html = tableAt(read(shaded), 0);
    expect(html).toContain('<td style="background-color:#ffcc00;vertical-align:middle;padding-top:8pt;padding-left:0.5pt"><p>a</p></td>');
    expect(html).toContain("<td><p>c</p></td>");
    let cleared = expectSameAsGoogle(shaded, styleChange(read(shaded), 0, 0, 1, 2, { background: "transparent" }));
    expect(tableAt(read(cleared), 0)).toContain('<td style="vertical-align:middle;padding-top:8pt;padding-left:0.5pt"><p>a</p></td>');
  });

  it("draws a border on both cells of an edge they share, the later write winning", () => {
    let tab = grid3();
    let right = expectSameAsGoogle(tab, styleChange(read(tab), 1, 1, 1, 1, { borders: { right: "3pt solid #ff0000" } }));
    let html = tableAt(read(right), 0);
    expect(html).toContain('<td style="border-right:3pt solid #ff0000"><p>e</p></td>');
    expect(html).toContain('<td style="border-left:3pt solid #ff0000"><p>f</p></td>');
    let over = expectSameAsGoogle(right, styleChange(read(right), 1, 2, 1, 1, { borders: { left: "none" } }));
    expect(tableAt(read(over), 0)).toContain('<td style="border-right:none"><p>e</p></td>');
  });

  it("sets every edge with border, and the block's outer and inner edges with borders", () => {
    let tab = grid3();
    let all = expectSameAsGoogle(tab, styleChange(read(tab), 0, 0, 3, 3, { border: "2pt dashed #0000ff" }));
    expect(tableAt(read(all), 0).startsWith('<table style="border:2pt dashed #0000ff">\n')).toBe(true);
    for (let edges of [
      { top: "1pt dotted #ff0000", bottom: "none" }, { left: "4pt solid #00ff00", right: "0.25pt solid #123456" },
      { innerHorizontal: "none" }, { innerVertical: "3pt solid #000000", top: "none" },
    ]) {
      expectSameAsGoogle(tab, styleChange(read(tab), 0, 1, 2, 2, { borders: edges }));
      expectSameAsGoogle(all, styleChange(read(all), 1, 0, 2, 3, { border: "none", borders: edges }));
    }
  });

  it("styles a merged cell whole, reading its edges where Google keeps them", () => {
    let tab = buildTab([para("Before"), { table: [
      ["a\n", "b\n", "c\n"],
      ["d\n", { paragraphs: [para("e")], tableCellStyle: { rowSpan: 2, columnSpan: 2 } }, "\n"],
      ["g\n", "\n", "\n"],
    ] }, para("After")]);
    let applied = expectSameAsGoogle(tab, styleChange(read(tab), 1, 1, 2, 2,
      { background: "#00ff00", borders: { right: "2pt solid #ff0000", bottom: "3pt solid #0000ff", top: "none" } }));
    expect(tableAt(read(applied), 0)).toContain(
      '<td rowspan="2" colspan="2" style="background-color:#00ff00;border-top:none;' +
      'border-right:2pt solid #ff0000;border-bottom:3pt solid #0000ff"><p>e</p></td>');
    expectSameAsGoogle(tab, styleChange(read(tab), 0, 0, 3, 3, { border: "1pt solid #cccccc" }));
    expect(refusal(tab, styleChange(read(tab), 1, 1, 1, 1, { background: "#00ff00" }))).toBe(
      "setTableCellStyle: the cells named take in part of the merged cell at row 1, column 1 " +
      "(counting from 0), which Google Docs styles as a whole. Name all of its cells or none of them.");
    expect(refusal(tab, styleChange(read(tab), 0, 0, 3, 3, { borders: { innerVertical: "none" } }))).toBe(
      "setTableCellStyle: the cells named hold a merged cell, so the edges between their rows or " +
      "columns cannot be set. Set them on blocks of cells beside it, or use border.");
  });

  it("refuses cells past the table", () => {
    let tab = grid3();
    expect(refusal(tab, styleChange(read(tab), 2, 0, 2, 1, { background: "#000000" })))
      .toBe("setTableCellStyle: row and rows must name rows of the table, which has 3.");
    expect(refusal(tab, styleChange(read(tab), 0, 3, 1, 1, { background: "#000000" })))
      .toBe("setTableCellStyle: column and columns must name columns of the table, which has 3.");
  });

  it("keeps the queue's later changes when a look change no longer applies", () => {
    let gate = new TableReplayGate();
    gate.failed(TAB, { type: "setTableCellStyle" });
    expect(() => gate.admit(TAB, { type: "insertTableRows" })).not.toThrow();
    gate.failed(TAB, { type: "insertTableRows" });
    expect(() => gate.admit(TAB, { type: "setTableCellStyle" })).toThrow();
  });
});

describe("setting a table's column widths and row heights", () => {
  const sized = (): GoogleDocsTab => buildTab([para("Before"), {
    ...grid(["a", "b", "c"], ["d", "e", "f"]), headerRows: 1, columns: [null, 80, null], heights: [0, 24],
  }, para("After")]);
  const widths = (content: EditableMarkdown, at: number, count: number, width: number | null): TableChange =>
    ({ type: "setTableColumnWidths", at, count, width, ...refOf(content, 0) });
  const heights = (content: EditableMarkdown, at: number, count: number, height: number): TableChange =>
    ({ type: "setTableRowHeights", at, count, height, ...refOf(content, 0) });

  it("sets columns fixed or sharing the rest, leaving the others, as Google does", () => {
    let tab = sized();
    let fixed = expectSameAsGoogle(tab, widths(read(tab), 0, 1, 93.333));
    expect(tableAt(read(fixed), 0)).toContain('<colgroup><col style="width:93.333pt"><col style="width:80pt"><col></colgroup>');
    let even = expectSameAsGoogle(fixed, widths(read(fixed), 0, 2, null));
    expect(tableAt(read(even), 0)).not.toContain("<colgroup>");
  });

  it("sets rows' least heights, and keeps a pinned header row pinned", () => {
    let tab = sized();
    let applied = expectSameAsGoogle(tab, heights(read(tab), 0, 2, 30));
    expect(tableAt(read(applied), 0).split('<tr style="height:30pt">').length - 1).toBe(2);
    expect(pinnedHeaderRows(applied, docTabToMarkdown(applied).sourceMap.tables[0].docStart)).toBe(1);
    let fitted = expectSameAsGoogle(applied, heights(read(applied), 1, 1, 0));
    expect(tableAt(read(fitted), 0)).toContain('<tr style="height:30pt">\n    <td><p>a</p></td>');
    expect(tableAt(read(fitted), 0)).toContain("  <tr>\n    <td><p>d</p></td>");
  });

  it("refuses columns or rows past the table", () => {
    let tab = sized();
    expect(refusal(tab, widths(read(tab), 2, 2, 50)))
      .toBe("setTableColumnWidths: at and count must name columns of the table, which has 3.");
    expect(refusal(tab, heights(read(tab), 2, 1, 50)))
      .toBe("setTableRowHeights: at and count must name rows of the table, which has 2.");
  });
});

describe("merging and splitting cells", () => {
  const pt = (magnitude: number) => ({ magnitude, unit: "PT" });
  const shaded = (text: string, red: number): CellSpec => ({
    paragraphs: [para(text)],
    tableCellStyle: { backgroundColor: { color: { rgbColor: { red } } }, paddingTop: pt(red * 10) },
  });
  const merge = (content: EditableMarkdown, row: number, column: number, rows: number, columns: number): TableChange =>
    ({ type: "mergeTableCells", row, column, rows, columns, ...refOf(content, 0) });
  const split = (content: EditableMarkdown, row: number, column: number): TableChange =>
    ({ type: "unmergeTableCells", row, column, ...refOf(content, 0) });
  const table = (...rows: CellSpec[][]): GoogleDocsTab =>
    buildTab([para("Before"), { table: rows, heights: [0, 24, 0] }, para("After")]);

  it("joins the cells' paragraphs into the top-left cell, row by row, as Google does", () => {
    let tab = table(
      [cellOf(heading("Head", 3), para("x2")), "y\n", "\n"],
      ["\n", cellOf(para("z1"), para("z2")), "c\n"],
      ["d\n", "e\n", "f\n"]);
    let applied = expectSameAsGoogle(tab, merge(read(tab), 0, 0, 2, 2));
    let html = tableAt(read(applied), 0);
    expect(html).toContain(
      '    <td rowspan="2" colspan="2">\n      <h3>Head</h3>\n      <p>x2</p>\n      <p>y</p>\n' +
      "      <p>z1</p>\n      <p>z2</p>\n    </td>\n    <td><p></p></td>\n    <td><p></p></td>\n");
    // The rows keep the heights they had, which Google would have set to what they render at.
    expect(html).toContain('  <tr style="height:24pt">\n    <td><p></p></td>\n    <td><p></p></td>\n    <td><p>c</p></td>');
  }, );

  it("keeps the top-left cell's look, reading the block's edges where Google keeps them", () => {
    let tab = table(
      [shaded("a", 1), shaded("b", 0.5), "c\n"],
      ["d\n", "e\n", "f\n"],
      ["g\n", "h\n", "i\n"]);
    let applied = expectSameAsGoogle(tab, merge(read(tab), 0, 0, 1, 2));
    expect(tableAt(read(applied), 0)).toContain('<td colspan="2" style="background-color:#ff0000;padding-top:10pt">\n      <p>a</p>\n      <p>b</p>');
    expectSameAsGoogle(tab, merge(read(tab), 1, 0, 2, 3));
  });

  it("merges a block that holds a merged cell whole, and empty cells into one empty paragraph", () => {
    let tab = table(
      [{ paragraphs: [para("ab")], tableCellStyle: { columnSpan: 2 } }, "\n", "\n"],
      ["c\n", "d\n", "\n"],
      ["\n", "\n", "\n"]);
    expectSameAsGoogle(tab, merge(read(tab), 0, 0, 2, 2));
    let applied = expectSameAsGoogle(tab, merge(read(tab), 2, 0, 1, 3));
    expect(tableAt(read(applied), 0)).toContain('<td colspan="3"><p></p></td>');
    expect(refusal(tab, merge(read(tab), 0, 1, 2, 2))).toBe(
      "mergeTableCells: the cells named take in part of the merged cell at row 0, column 0 " +
      "(counting from 0), which Google Docs styles as a whole. Name all of its cells or none of them.");
  });

  it("reads a merged block's outer edges through a merged cell it holds on that edge", () => {
    // ask-bonk's case: the block's right edge runs through a merged cell whose right edge is blue.
    let edge = (red: number, blue: number) =>
      ({ width: pt(2), dashStyle: "SOLID", color: { color: { rgbColor: { red, blue } } } });
    let tab = buildTab([para("Before"), { table: [
      [{ paragraphs: [para("a")], tableCellStyle: { borderRight: edge(1, 0) } },
        { paragraphs: [para("bc")], tableCellStyle: { columnSpan: 2 } },
        { paragraphs: [para("")], tableCellStyle: { borderRight: edge(0, 1) } }],
      ["d\n", "e\n", "f\n"],
    ] }, para("After")]);
    expect(tableAt(read(tab), 0)).toContain('<td colspan="2" style="border-right:2pt solid #0000ff">');
    let applied = expectSameAsGoogle(tab, merge(read(tab), 0, 0, 1, 3));
    expect(tableAt(read(applied), 0)).toContain('<td colspan="3" style="border-right:2pt solid #0000ff">');
    let tall = buildTab([para("Before"), { table: [
      ["a\n", "b\n"],
      [{ paragraphs: [para("cd")], tableCellStyle: { columnSpan: 2, borderBottom: edge(0, 1) } }, "\n"],
    ] }, para("After")]);
    expectSameAsGoogle(tall, merge(read(tall), 0, 0, 2, 2));
  });

  it("splits a merged cell, its text staying in the top-left cell and the others empty", () => {
    let tab = table(
      [{ paragraphs: [para("ab"), para("cd")], tableCellStyle: { rowSpan: 2, columnSpan: 2, backgroundColor: { color: { rgbColor: { green: 1 } } } } },
        { paragraphs: [para("")], tableCellStyle: { borderRight: { width: pt(3), dashStyle: "SOLID", color: { color: { rgbColor: { red: 1 } } } } } }, "x\n"],
      ["\n", "\n", "y\n"],
      ["g\n", "h\n", "i\n"]);
    let applied = expectSameAsGoogle(tab, split(read(tab), 0, 0));
    let html = tableAt(read(applied), 0);
    expect(html).toContain("<p>ab</p>\n      <p>cd</p>");
    expect(html.split("background-color:#00ff00").length - 1).toBe(4);
    // The restored cells take text like any other.
    let row = '<tr style="height:24pt">\n    <td style="background-color:#00ff00"><p>';
    expectCellTextSameAsGoogle(applied, `${row}</p>`, `${row}new</p>`);
    expect(refusal(tab, split(read(tab), 0, 1))).toBe(
      "unmergeTableCells: no merged cell starts at row 0, column 1 (counting from 0). Name the " +
      "top-left cell of the merged cell.");
  });

  it("refuses to merge what it cannot join exactly", () => {
    let tab = buildTab([para("Before"), { table: [
      ["a\n", { paragraphs: [item("one")] }, "\n"],
      [cellOf(para("x"), para("")), "b\n", { paragraphs: [{ runs: ["n", { footnote: { id: "f1", number: "1" } }, "\n"] }] }],
    ] }, para("After")], ALL_LISTS);
    expect(refusal(tab, merge(read(tab), 0, 0, 1, 2))).toBe(
      "mergeTableCells: the cell at row 0, column 1 (counting from 0) starts with a heading, a list " +
      "item or a subtitle, or holds a numbered list. Only the top-left cell of the block may.");
    expect(refusal(tab, merge(read(tab), 1, 0, 1, 2))).toBe(
      "mergeTableCells: the cell at row 1, column 0 (counting from 0) holds an empty paragraph " +
      "beside others, which merging cells does not support. Remove it first.");
    expect(refusal(tab, merge(read(tab), 1, 1, 1, 2))).toBe(
      "mergeTableCells: the cell at row 1, column 2 (counting from 0) holds a table, a footnote, a " +
      "smart chip or an element getContent() does not show, which merging cells does not support.");
  });

  it("closes the replay gate when a merge no longer applies", () => {
    let gate = new TableReplayGate();
    gate.failed(TAB, { type: "mergeTableCells" });
    expect(() => gate.admit(TAB, { type: "setTableCellStyle" })).toThrow();
  });
});
