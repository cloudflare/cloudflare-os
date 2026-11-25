// The table engine: the requests a table change or a replacement in table cells sends, what
// each is refused with, and how the tab reads once Google applies it.

import { describe, expect, it } from "vitest";
import type {
  GoogleDocsRequest, GoogleDocsTab, Paragraph, ParagraphElement, StructuralElement, TableCell, TextStyle,
} from "../src/docs-api";
import { applyDocEdit, docEditRequests, renderTab } from "../src/docs-replay";
import type { DocEdit } from "../src/docs-replay";
import {
  addedTableCells, besideTableRefusal, changesTables, checkTabTableCells, checkTableTarget,
  chipCopies, closesTableGate, commonPrefix, commonSuffix, headerAfterInsertion, hiddenContent, MAX_TAB_TABLE_CELLS,
  MAX_TABLE_TEXT_REQUESTS, namesTable, parseCellInline, replacementPath, resolveTable,
  tableChangeRequests, tableGateRefusal, tableIdentity,
  tableShape, tableSize, tableTextRequests, textReplacementRequests,
} from "../src/docs-tables";
import type {
  ReplacementPath, TableChange, TableChangeShape, TableDeletionShape, TableRef, TextReplacement,
} from "../src/docs-tables";
import {
  canonicalizeMarkdownReplacement, computeReplaceOperations, docTabToMarkdown,
  StructuredContentError,
} from "../src/markdown-converter";
import type { DocTabSnapshot } from "../src/markdown-converter";
import { applyDocsRequests, LINK_COLOR } from "../src/docs-model";
import type { ModelParagraphStyle, ModelTextStyle } from "../src/docs-model";
import {
  appliedOneWay, BULLET_LIST, buildTab, cellOf, footnote, grid, heading, item, MODELS,
  NUMBERED_LIST, para, presetLevels, QUIET_LIST, sized, tableAt, tableHtml, thrownMessage,
} from "./doc-fixture";
import type { BlockSpec, CellSpec, Lists, ParagraphSpec, TableSpec } from "./doc-fixture";
import {
  alignmentAt, fontSizeAt, hasLinkLook, indentedParagraphs, pinnedHeaderRows, tableElement,
  tableTexts,
} from "./docs-model-probes";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TAB = "tab-1";
const FOUR_FIELDS = "bold,italic,strikethrough,link";
const SIX_FIELDS = `${FOUR_FIELDS},underline,foregroundColor`;

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

const person = (name?: string) => ({ person: { ...(name ? { name } : {}), email: "" } });
/** A paragraph that holds a person chip after its text, which makes it read-only. */
const chip = (text = "Owner: ", name = "Ana"): ParagraphSpec =>
  ({ runs: [text, person(name), "\n"] });
/** A paragraph whose only content is a chip that renders as nothing. */
const quietChip = (text = ""): ParagraphSpec => ({ runs: [text, person(), "\n"] });
const dateChip = (): ParagraphSpec => ({ runs: ["Due ", { date: "Nov 8, 2026" }, "\n"] });
const toc: BlockSpec = { structure: "tableOfContents" };

const read = (tab: GoogleDocsTab): DocTabSnapshot => docTabToMarkdown(tab);

/** The reference a queued change records of the table at `table`. */
const refOf = (content: DocTabSnapshot, table: number): TableRef =>
  ({ expected: tableIdentity(tableAt(content, table)) });

const addRows = (
  content: DocTabSnapshot, table: number, at: number, cells: string[][],
): TableChange => ({ type: "insertTableRows", at, cells, ...refOf(content, table) });
const addColumns = (
  content: DocTabSnapshot, table: number, at: number, cells: string[][],
): TableChange => ({ type: "insertTableColumns", at, cells, ...refOf(content, table) });
/** A deletion as it is queued: with what it removes that the rendering does not show. */
const queuedDeletion = (
  content: DocTabSnapshot, table: number, shape: TableDeletionShape,
): TableChange => ({ ...shape, ...refOf(content, table), ...hiddenContent(content, table, shape) });
const dropRows = (
  content: DocTabSnapshot, table: number, at: number, count = 1,
): TableChange => queuedDeletion(content, table, { type: "deleteTableRows", at, count });
const dropColumns = (
  content: DocTabSnapshot, table: number, at: number, count = 1,
): TableChange => queuedDeletion(content, table, { type: "deleteTableColumns", at, count });
const dropTable = (content: DocTabSnapshot, table: number): TableChange =>
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

/**
 * The tab a table change leaves, alike under every model behaviour: no paragraph left
 * indented, and a table that gains rows keeps its count of pinned header rows.
 */
function appliedChange(tab: GoogleDocsTab, change: TableChange): GoogleDocsTab {
  let before = docTabToMarkdown(tab);
  let requests = tableChangeRequests(before, change);
  let pinned = change.type === "insertTableRows"
    ? before.sourceMap.tables[resolveTable(before, change, change.type)] : undefined;
  for (let options of MODELS) {
    let applied = applyDocsRequests(tab, requests, options);
    // No fixture holds an indented paragraph, so one found here was left by a fill.
    expect(indentedParagraphs(applied)).toEqual([]);
    if (pinned) {
      expect(pinnedHeaderRows(applied, pinned.docStart))
        .toBe(pinnedHeaderRows(tab, pinned.docStart));
    }
  }
  return appliedOneWay(tab, requests);
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

/** A replacement in table cells, alike under every model behaviour: tab, requests, rendering. */
function appliedCellText(
  tab: GoogleDocsTab, oldMarkdown: string, newMarkdown: string,
): { applied: GoogleDocsTab; requests: GoogleDocsRequest[]; rendering: DocTabSnapshot } {
  let before = docTabToMarkdown(tab);
  let { matchStart } = replacementIn(before.markdown, oldMarkdown, newMarkdown);
  let requests = tableTextRequests(before, matchStart, oldMarkdown, newMarkdown);
  if (!requests) throw new Error("Expected a replacement in table cells");
  let applied = appliedOneWay(tab, requests);
  return { applied, requests, rendering: docTabToMarkdown(applied) };
}

/** A stored replacement (for table cells when `inTable`), alike under every model behaviour. */
function appliedReplacement(
  tab: GoogleDocsTab, oldMarkdown: string, newMarkdown: string, inTable?: true,
): { rendering: DocTabSnapshot; applied: GoogleDocsTab } {
  let before = docTabToMarkdown(tab);
  let replacement = { ...replacementIn(before.markdown, oldMarkdown, newMarkdown), inTable };
  let applied = appliedOneWay(tab, textReplacementRequests(before, replacement));
  return { rendering: docTabToMarkdown(applied), applied };
}

/**
 * A tab's rendering after a stored paragraph replacement, alike under every model behaviour;
 * `matchStart` picks the occurrence when the old text stands more than once.
 */
function appliedParagraphText(
  tab: GoogleDocsTab, oldMarkdown: string, newMarkdown: string, matchStart?: number,
): DocTabSnapshot {
  let before = docTabToMarkdown(tab);
  let replacement = replacementIn(before.markdown, oldMarkdown, newMarkdown, matchStart);
  return docTabToMarkdown(appliedOneWay(tab, textReplacementRequests(before, replacement)));
}

/** What the request builder refuses a change with. */
function refusal(tab: GoogleDocsTab, change: TableChange): string {
  return thrownMessage(() => tableChangeRequests(docTabToMarkdown(tab), change));
}

function bodyElements(tab: GoogleDocsTab, kind: "paragraph" | "table"): StructuralElement[] {
  return tab.body.content.filter(element => element[kind] !== undefined);
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

const BASIC = () => buildTab(
  [para("Before"), grid(["r0c0", "r0c1"], ["r1c0", "r1c1"]), para("After")]);

/** What the fill of a new cell sends: its requests' kinds, in order. */
const kinds = (requests: readonly GoogleDocsRequest[]): string[] =>
  requests.map(request => Object.keys(request)[0]);

// ---------------------------------------------------------------------------
// Size
// ---------------------------------------------------------------------------

describe("tableSize", () => {
  it("refuses a table that has no row, or no cell, with the method's name", () => {
    let tab = buildTab([para("Before"), grid(["gone"]), grid(["a"]), para("After")]);
    let [noRows, noCells] = tab.body.content.flatMap(element => element.table ?? []);
    delete noRows.tableRows;
    delete noCells.tableRows?.[0].tableCells;
    let content = read(tab);
    expect([0, 1].map(table => tableAt(content, table)))
      .toEqual(["<table>\n</table>", "<table>\n  <tr>\n  </tr>\n</table>"]);
    for (let table of [0, 1]) {
      expect(thrownMessage(() => tableSize(content, table, "deleteTableRows")))
        .toBe("deleteTableRows: this table is not laid out as Google Docs lays tables out, so " +
          "it cannot be changed.");
    }
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
        let applied = appliedChange(BASIC(), addRows(read(BASIC()), 0, at, cells));
        expect(tableTexts(applied).length).toBe(2 + cells.length);
      }
    }
  });

  it("reads new rows as plain beside headings, list items and bold text", () => {
    for (let at of [0, 1, 2, 3]) {
      for (let cells of [[["", ""]], [["x", "y"]], [["x", ""], ["", "y\nz"]]]) {
        appliedChange(STYLED(), addRows(read(STYLED()), 0, at, cells));
      }
    }
  });

  it("deletes rows at the top, in the middle and at the end, one and several", () => {
    let tab = buildTab([
      para("Before"), grid(["a", "b"], ["c", "d"], ["e", "f"], ["g", "h"]), para("After"),
    ]);
    for (let [at, count] of [[0, 1], [1, 1], [3, 1], [0, 3], [1, 2], [2, 2]]) {
      let applied = appliedChange(tab, dropRows(read(tab), 0, at, count));
      expect(tableTexts(applied).length).toBe(4 - count);
    }
  });

  it("leaves a cell empty whose text the stored cells lack", () => {
    let applied = appliedChange(BASIC(), addRows(read(BASIC()), 0, 1, [["only"]]));
    expect(tableTexts(applied)[1]).toEqual(["only\n", "\n"]);
  });
});

describe("columns", () => {
  it("adds columns at the start, in the middle and at the end, empty and filled", () => {
    for (let at of [0, 1, 2]) {
      for (let cells of [[[""], [""]], [["x"], ["y\nz"]], [["a", ""], ["", "b"]]]) {
        let applied = appliedChange(BASIC(), addColumns(read(BASIC()), 0, at, cells));
        expect(tableTexts(applied)[0].length).toBe(2 + cells[0].length);
      }
    }
  });

  it("reads new columns as plain beside headings, list items and bold text", () => {
    for (let at of [0, 1, 2]) {
      for (let cells of [[[""], [""], [""]], [["x"], ["y\nz"], [""]]]) {
        appliedChange(STYLED(), addColumns(read(STYLED()), 0, at, cells));
      }
    }
  });

  it("adds a column at the end of a table whose rows differ in the length of their content", () => {
    let tab = buildTab([
      para("Before"),
      { table: [["a\n", cellOf(para("long"), para("longer still"))], ["much longer text\n", "\n"]] },
      para("After"),
    ]);
    let applied = appliedChange(tab, addColumns(read(tab), 0, 2, [["x"], ["y"]]));
    expect(tableTexts(applied).map(row => row[2])).toEqual(["x\n", "y\n"]);
  });

  it("deletes columns at the start, in the middle and at the end, one and several", () => {
    let tab = buildTab([
      para("Before"), grid(["a", "b", "c", "d"], ["e", "f", "g", "h"]), para("After"),
    ]);
    for (let [at, count] of [[0, 1], [1, 1], [3, 1], [0, 3], [1, 2], [2, 2]]) {
      let applied = appliedChange(tab, dropColumns(read(tab), 0, at, count));
      expect(tableTexts(applied)[0].length).toBe(4 - count);
    }
  });
});

describe("a queued table change", () => {
  it("is built from the edit as the builder is called", () => {
    let content = read(buildTab([para("Before"), sized(3, 4), para("After")]));
    let named = refOf(content, 0);
    let merged = read(MERGED_TABLE());
    let changes: [DocTabSnapshot, TableChange][] = [
      [content, newTable([["new", "table"]], "Before")],
      [content, addRows(content, 0, 1, [["w", "x", "y", "z"], ["", "", "", ""]])],
      [content, addColumns(content, 0, 2, [["x", "y"], ["", ""], ["z", ""]])],
      [content, dropRows(content, 0, 1, 2)],
      [content, dropColumns(content, 0, 1, 2)],
      [content, dropTable(content, 0)],
      [content, {
        type: "setTableCellStyle", row: 1, column: 1, rows: 2, columns: 2,
        style: { background: "#ffcc00" }, ...named,
      }],
      [content, { type: "setTableColumnWidths", at: 1, count: 2, width: 80, ...named }],
      [content, { type: "setTableRowHeights", at: 1, count: 2, height: 30, ...named }],
      [content, { type: "mergeTableCells", row: 1, column: 1, rows: 2, columns: 2, ...named }],
      [merged, { type: "unmergeTableCells", row: 0, column: 0, ...refOf(merged, 0) }],
    ];
    for (let [render, change] of changes) {
      let requests = docEditRequests(render, change);
      expect(requests.length).toBeGreaterThan(0);
      expect(requests).toEqual(tableChangeRequests(render, change));
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
  const requestsFor = (change: (content: DocTabSnapshot) => TableChange) => {
    let before = docTabToMarkdown(AT_NINE);
    expect(before.sourceMap.tables[0].docStart).toBe(9);
    return tableChangeRequests(before, change(before));
  };

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

/** Row 0: a centred paragraph of bold 18 pt text and a heading of that look; row 1: plain. */
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

/** Sizes in the second table's row 0: cell 0's first and last character, cell 1's line break. */
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
    // The text lost the bold it took, and so did the cell's line break, which the reset reaches
    // (recorded: bullets-in-cell-2 / a row inserted below the styled row).
    expect(boldRuns(applied, 0, 0)).toEqual([]);
    expect([alignmentAt(applied, reset), fontSizeAt(applied, reset)])
      .toEqual([undefined, undefined]);
    expect(tableAt(read(applied), 0)).toContain("<td><p>new</p></td>\n    <td><p>cell</p></td>");
    appliedChange(lookTab(), change);
  });

  it("sends nothing for an empty matched cell, whose line break stays bold", () => {
    let change = addRows(read(lookTab()), 0, 0, [["", ""]]);
    expect(kinds(tableChangeRequests(docTabToMarkdown(lookTab()), change)))
      .toEqual(["insertTableRow", "deleteParagraphBullets", "updateParagraphStyle"]);
    expect(boldRuns(copied(lookTab(), change), 0, 0)).toEqual(["\n"]);
    appliedChange(lookTab(), change);
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
    appliedChange(lookTab(), change);
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
    appliedChange(tab, change);
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
    appliedChange(lookTab(), change);
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
    appliedChange(tab(), change);
  });

  it("resets a cell beside one that starts with a subtitle or a title", () => {
    for (let namedStyleType of ["SUBTITLE", "TITLE"]) {
      let tab = () => lookTab({ runs: [], namedStyleType });
      let change = addRows(read(tab()), 0, 0, [["new", "cell"]]);
      expect(kinds(tableChangeRequests(docTabToMarkdown(tab()), change)))
        .toEqual(["insertTableRow", ...FULL_RESET, ...MATCHED]);
      appliedChange(tab(), change);
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
      let change = addRows(before, 0, at, [["x", "y"]]);
      let requests = tableChangeRequests(before, change);
      expect(requests.at(-1)).toEqual(PIN);
      expect(pinnedHeaderRows(applyDocsRequests(tab(), requests), 8)).toBe(1);
      expect(pinnedHeaderRows(applyDocsRequests(tab(), requests.slice(0, -1)), 8)).toBe(2);
      appliedChange(tab(), change);
    }
  });

  it("counts the new rows a header pinned again takes in, and the rows it lets go, as the rows fall", () => {
    for (let pinned = 1; pinned <= 3; pinned++) {
      for (let at = 0; at <= 4; at++) {
        for (let count = 1; count <= 4; count++) {
          // Four rows, `count` new ones at `at`, and the first `pinned` of them the header.
          let rows = ["o0", "o1", "o2", "o3"].toSpliced(at, 0, ...Array.from({ length: count }, () => "new"));
          let header = rows.slice(0, pinned);
          let wasHeader = ["o0", "o1", "o2", "o3"].slice(0, pinned);
          let expected = at < pinned
            ? { added: header.filter(row => row === "new").length,
              dropped: wasHeader.filter(row => !header.includes(row)).length }
            : { added: 0, dropped: 0 };
          expect(headerAfterInsertion(pinned, at, count), `${pinned} ${at} ${count}`).toEqual(expected);
        }
      }
    }
  });

  it("refuses a row insertion whose table's header around its rows has changed since it was queued", () => {
    let header = (rows: number) => buildTab([
      para("Before"), { ...grid(["H1", "H2"], ["a", "b"], ["c", "d"]), ...(rows > 0 ? { headerRows: rows } : {}) },
      para("After")]);
    let refused =
      "insertTableRows: the table's pinned header rows around the new rows have changed since " +
      "this change was queued, which getContent() does not show.";
    for (let [queued, applied] of [[0, 1], [1, 0], [1, 2]] as const) {
      let change = { ...addRows(docTabToMarkdown(header(queued)), 0, 0, [["x", "y"]]), pinned: queued };
      // Its table reads the same: the pin is all that moved.
      expect(thrownMessage(() => tableChangeRequests(docTabToMarkdown(header(applied)), change))).toBe(refused);
      expect(() => tableChangeRequests(docTabToMarkdown(header(queued)), change)).not.toThrow();
    }
    // Below the header, a header of another size changes nothing of the new rows; nor, after a
    // table whose every row is pinned, does a pin taken off its last row.
    let below = { ...addRows(docTabToMarkdown(header(1)), 0, 2, [["x", "y"]]), pinned: 0 };
    expect(() => tableChangeRequests(docTabToMarkdown(header(2)), below)).not.toThrow();
    let appended = { ...addRows(docTabToMarkdown(header(3)), 0, 3, [["x", "y"]]), pinned: 0 };
    expect(() => tableChangeRequests(docTabToMarkdown(header(2)), appended)).not.toThrow();
  });

  it("refuses to build a merge of a header row with a row below the header", () => {
    let tab = pinnedTab(["H1", "H2"], ["a", "b"], ["c", "d"]);
    let before = docTabToMarkdown(tab);
    let merge = (row: number, column: number, rows: number, columns: number): TableChange =>
      ({ type: "mergeTableCells", row, column, rows, columns, ...refOf(read(tab), 0) });
    let refused =
      "mergeTableCells: the cells named take in the table's pinned header, its first row, and " +
      "rows below it, which Google Docs does not merge. Merge cells of the header rows, or " +
      "cells of the rows below them.";
    for (let across of [merge(0, 0, 2, 1), merge(0, 0, 3, 2)]) {
      expect(thrownMessage(() => tableChangeRequests(before, across))).toBe(refused);
    }
    appliedChange(tab, merge(0, 0, 1, 2));
    appliedChange(tab, merge(1, 0, 2, 2));
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
      expect(pinnedHeaderRows(appliedChange(tab, change), 8)).toBe(1);
    }
    expect(pinnedHeaderRows(appliedChange(tab, dropRows(content, 0, 0)), 8)).toBe(0);
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

/** What the request builder refuses a change with, if anything; one it accepts reads one way. */
function judge(tab: GoogleDocsTab, change: TableChange): string | undefined {
  let refused = attempt(() => tableChangeRequests(docTabToMarkdown(tab), change));
  if (refused === undefined) appliedChange(tab, change);
  return refused;
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
      let document = judge(assemble(sequence), newTable(TABLES[count++ % 2], after));
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
          let document = judge(tab, newTable(TABLES[accepted % 2]));
          expect(document).toBe(isStructure(last) ? NO_LAST_PARAGRAPH : undefined);
          if (document === undefined) accepted++;
        }
      }
    }
    expect(accepted).toBe(800);
  });

  it("adds a table to a blank tab", () => {
    let blank = buildTab([para("")]);
    let applied = appliedChange(blank, newTable([["a", "b"]]));
    expect(docTabToMarkdown(applied).markdown).toBe(`\n\n${tableHtml([["a", "b"]])}\n\n\n`);
  });

  it("leaves an empty list item or heading above a table added at the end, and below one added before it", () => {
    for (let [split, line] of [[item(""), "- "], [heading(""), "## "]] as const) {
      let tab = () => buildTab([para("Intro"), grid(["first"]), split], ALL_LISTS);
      let html = tableHtml([["new"]]);
      let atEnd = newTable([["new"]]);
      let afterTable = newTable([["new"]], "first");
      let ended = docTabToMarkdown(appliedChange(tab(), atEnd)).markdown;
      expect(ended.endsWith(`</table>\n\n${line}\n\n${html}\n\n\n`)).toBe(true);
      let followed = docTabToMarkdown(appliedChange(tab(), afterTable)).markdown;
      expect(followed.endsWith(`</table>\n\n\n\n${html}\n\n${line}\n`)).toBe(true);
      // Both split the same paragraph at the same index.
      let before = docTabToMarkdown(tab());
      expect(tableChangeRequests(before, atEnd)[0])
        .toEqual(tableChangeRequests(before, afterTable)[0]);
    }
  });

  it("says where among the tab's tables the new one is", () => {
    let tab = buildTab([para("Before"), grid(["one"]), para("Mid"), grid(["two"]), para("After")]);
    for (let [after, position] of [
      ["Before", 0], ["one", 1], ["Mid", 1], ["two", 2], ["After", 2], [undefined, 2],
    ] as const) {
      let content = renderTab(applyDocEdit(tab, newTable([["new"]], after)));
      expect(content.sourceMap.tables.length).toBe(3);
      expect(tableAt(content, position)).toBe(tableHtml([["new"]]));
    }
  });

  it("leaves no indent on the paragraph after a table added after a nested list item", () => {
    let tab = buildTab([item("top", "DEEP"), item("nested", "DEEP", 1), para("After")], ALL_LISTS);
    appliedChange(tab, newTable([["a"]], "nested"));
    appliedChange(tab, newTable([[""]], "nested"));
  });
});

describe("deleteTable among its neighbours", () => {
  it("reads as the document does between every kind of neighbour, two blocks each way", () => {
    let accepted = 0;
    let run = (sequence: [Kind, string, string][]) => {
      let tab = assemble(sequence);
      let content = read(tab);
      let target = content.sourceMap.tables.findIndex(
        (_, index) => tableAt(content, index).includes("TARGET"));
      expect(judge(tab, dropTable(content, target))).toBeUndefined();
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
      let applied = appliedChange(tab, dropTable(read(tab), 0));
      expect(docTabToMarkdown(applied).markdown).toBe("Before\n\nAfter\n");
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
      expect(thrownMessage(() => resolveTable(read(tab), ref(), "deleteTableRows")))
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
    expect(thrownMessage(() => resolveTable(read(twins), refOf(read(twins), 1), "deleteTableColumns")))
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
    let applied = appliedChange(numberedTab(true), rows);
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

describe("the changes that close a tab's tables to later ones", () => {
  it("refuses with the one wording, and closes for the changes that close the gate", () => {
    let types = [
      "insertTable", "insertTableRows", "deleteTable", "mergeTableCells", "setTableCellStyle",
      "setTableColumnWidths", "setTableRowHeights", "replaceText", "appendText",
    ];
    for (let type of types) {
      expect(tableGateRefusal(type).message).toBe(behindFailedChange(type));
    }
    expect(types.filter(type => closesTableGate({ type })))
      .toEqual(["insertTable", "insertTableRows", "deleteTable", "mergeTableCells"]);
    expect(closesTableGate({ type: "replaceText", inTable: true })).toBe(true);
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
 * What a change to the table at `table` is refused with: by the request builder and, given only
 * the table's position, by `checkTableTarget`, which must agree.
 */
function targetRefusal(tab: GoogleDocsTab, change: TableChange, table = 0): string {
  let before = docTabToMarkdown(tab);
  let refused = refusal(tab, change);
  expect(thrownMessage(() => checkTableTarget(before, table, shapeOf(change)))).toBe(refused);
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
      let applied = appliedChange(MERGED_TABLE(), change);
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
      expect(thrownMessage(() => checkTableTarget(content, table, shapeOf(change)))).toBe(
        "deleteTableRows: the rows to delete cross the merged cell at row 0, column 0 (counting " +
        "from 0). Split it with unmergeTableCells() first, or delete rows that cross no merged cell.");
      expect(refusal(tab, change)).toBe(anotherReadsTheSame("deleteTableRows"));
    }
    // It refuses nothing the request builder accepts.
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

  it("refuses a change that reads the look of a table whose widths are not one for each column", () => {
    let tab = buildTab([
      para("Before"), { ...grid(["a", "b"], ["c", "d"]), columns: [100, 100, 100] }, para("After"),
    ]);
    let content = read(tab);
    expect(refusal(tab, addColumns(content, 0, 1, [[""], [""]])))
      .toBe(notLaidOut("insertTableColumns"));
    expect(refusal(tab, {
      type: "mergeTableCells", row: 0, column: 0, rows: 1, columns: 2, ...refOf(content, 0),
    })).toBe(notLaidOut("mergeTableCells"));
    // A change that does not read the widths is made.
    appliedChange(tab, addRows(content, 0, 2, [["e", "f"]]));
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
    appliedChange(nineteen, addColumns(read(nineteen), 0, 19, [["x"]]));
    expect(targetRefusal(nineteen, addColumns(read(nineteen), 0, 0, [["", ""]]))).toBe(
      "insertTableColumns: columns can be added only until a table has 20, and this one would " +
      "have 21.");

    let wide = buildTab([para("Before"), sized(2, 25), para("After")]);
    expect(targetRefusal(wide, addColumns(read(wide), 0, 0, [[""], [""]]))).toBe(
      "insertTableColumns: columns can be added only until a table has 20, and this one would " +
      "have 26.");
    appliedChange(wide, addRows(read(wide), 0, 2, blank(1, 25)));
    appliedChange(wide, dropColumns(read(wide), 0, 20, 5));
  });

  it("adds a column only to a table of at most 500 rows", () => {
    let tall = buildTab([para("Before"), sized(501, 1), para("After")]);
    expect(targetRefusal(tall, addColumns(read(tall), 0, 1, blank(501, 1)))).toBe(
      "insertTableColumns: columns can be added only to a table of at most 500 rows, and this " +
      "one has 501.");
    let applied = appliedChange(tall, addRows(read(tall), 0, 501, [["more"]]));
    expect(tableTexts(applied).length).toBe(502);

    let limit = buildTab([para("Before"), sized(500, 1), para("After")]);
    let cells = Array.from({ length: 500 }, (_, row) => [row % 7 === 0 ? `new${row}` : ""]);
    let widened = appliedChange(limit, addColumns(read(limit), 0, 1, cells));
    expect(tableTexts(widened)[497]).toEqual(["r497c0\n", "new497\n"]);
  });

  it("refuses a deletion of more rows than one batch holds requests", () => {
    let tab = buildTab([para("Before"), sized(19_007, 1, ""), para("After")]);
    let before = docTabToMarkdown(tab);
    let tooMany = dropRows(before, 0, 1, 19_006);
    let refused = "deleteTableRows: deleting 19006 rows needs more than 19005 requests, the " +
      "most one change may send. Delete them in several calls.";
    expect(thrownMessage(() => tableChangeRequests(before, tooMany))).toBe(refused);
    expect(thrownMessage(() => checkTableTarget(before, 0, shapeOf(tooMany)))).toBe(refused);

    let most = dropRows(before, 0, 1, 19_005);
    expect(tableChangeRequests(before, most).length).toBe(19_005);
    expect(renderTab(applyDocEdit(tab, most)).sourceMap.tables[0].rows.length).toBe(2);
  });
});

const placedAfter = (tab: GoogleDocsTab, after: string | undefined): string =>
  docTabToMarkdown(appliedChange(tab, newTable([["t"]], after))).markdown;

describe("a table with no paragraph on one side", () => {
  const first = buildTab([grid(["a", "b"]), para("After")]);
  const last = buildTab([para("Before"), grid(["a", "b"])]);

  it("still takes row, column and cell changes", () => {
    for (let tab of [first, last]) {
      let content = read(tab);
      let after = (edit: Parameters<typeof applyDocEdit>[1]) =>
        tableAt(renderTab(applyDocEdit(tab, edit)), 0);
      expect(after(addRows(content, 0, 1, [["c", "d"]]))).toBe(tableHtml([["a", "b"], ["c", "d"]]));
      expect(after(dropColumns(content, 0, 0))).toBe(tableHtml([["b"]]));
      expect(after({
        type: "replaceText", oldMarkdown: "<p>a</p>", newMarkdown: "<p>changed</p>", inTable: true,
      })).toBe(tableHtml([["changed", "b"]]));
    }
  });

  it("refuses to delete the table", () => {
    for (let tab of [first, last]) {
      expect(judge(tab, dropTable(read(tab), 0)))
        .toBe(notLaidOut("deleteTable"));
    }
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
    appliedChange(RESULTS, newTable([["t"]], "## Results\n"));
  });

  it("names a tab's first paragraph by the line break in front of it", () => {
    let notes = buildTab([para("Notes"), para("Intro"), heading("Notes"), para("More")]);
    for (let after of ["Notes", "Notes\n", "Notes\n\n"]) {
      expect(refusal(notes, newTable([["t"]], after))).toBe(AMBIGUOUS_REFUSAL);
    }
    for (let after of ["\nNotes", "\nNotes\n"]) {
      expect(placedAfter(notes, after).startsWith(`Notes\n\n${T}\n\n\n\nIntro\n`)).toBe(true);
      appliedChange(notes, newTable([["t"]], after));
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

  it("refuses a table after a table of contents", () => {
    let tab = buildTab([para("Before"), toc, para("After")]);
    expect(judge(tab, newTable([["t"]], "[Table of contents]")))
      .toBe(TOC_REFUSAL);
  });

  it("refuses a table between two items of one list", () => {
    let tab = buildTab([item("one"), item("two"), para("After")], ALL_LISTS);
    let refused = "insertTable: a table cannot be added between two items of a list. Name the " +
      "list's last item instead.";
    expect(judge(tab, newTable([["t"]], "one"))).toBe(refused);
    expect(judge(tab, newTable([["t"]], "two"))).toBeUndefined();
  });

  it("refuses a table at the end of a tab that does not end in a paragraph", () => {
    for (let last of [grid(["x"]), toc]) {
      let tab = buildTab([para("Before"), last]);
      expect(judge(tab, newTable([["t"]])))
        .toBe(NO_LAST_PARAGRAPH);
    }
  });

  it("refuses a table after a table that no paragraph follows", () => {
    let tab = buildTab([para("Before"), grid(["x"])]);
    expect(judge(tab, newTable([["t"]], "x")))
      .toBe(notLaidOut("insertTable"));
  });
});

const tabCells = (op: string, held: number) =>
  `${op}: tables, rows and columns can be added, and cells merged, only until the tables of a ` +
  "tab hold 5000 cells " +
  `in all, a cell counting once for each paragraph in it, and those of this tab would hold ${held}.`;

const tenCells = (text = "x") => [Array.from({ length: 10 }, () => text)];

describe("the cells a tab's tables hold", () => {
  /** 4,980 cells in one table and 10 in a second: 4,990 in all. */
  const FULL = buildTab(
    [para("Before"), sized(498, 10), para("Mid"), sized(1, 10, "s"), para("After")]);
  const content = docTabToMarkdown(FULL);

  it("counts the paragraphs of a table inside a cell, which no replacement edits", () => {
    // A 200 x 20 table nested in one cell holds 4,000 of the tab's cells.
    let nested = buildTab([
      para("Before"), { table: [[cellOf(para("outer"), sized(200, 20), para("end"))]] }, para("After"),
    ]);
    let held = docTabToMarkdown(nested);
    expect(thrownMessage(() => checkTabTableCells(held, 2_000, "insertTable"))).toBe(tabCells("insertTable", 6_002));
    expect(() => checkTabTableCells(held, 998, "insertTable")).not.toThrow();
  });

  it("counts each cell's own paragraphs, a cell holding only a table at least once", () => {
    // Two paragraphs in one cell, and a table alone in the next.
    let alone = docTabToMarkdown(buildTab([para("Before"), {
      table: [[cellOf(para("one"), para("two")), cellOf(grid(["in"]))]],
    }, para("After")]));
    // 2, then 1 for the cell holding the table and 1 for the table's own cell.
    expect(thrownMessage(() => checkTabTableCells(alone, 4_997, "insertTable"))).toBe(tabCells("insertTable", 5_001));
    // An empty numbered item and its child are two paragraphs. A list that skips a
    // level writes the same HTML for its placeholder item, so it counts it too, erring on refusing.
    let numbered = { NN: { listProperties: { nestingLevels: [{ glyphType: "DECIMAL" }, { glyphType: "DECIMAL" }] } } };
    let parent = docTabToMarkdown(buildTab([para("Before"), {
      table: [[cellOf(item("", "NN"), item("child", "NN", 1))]],
    }, para("After")], numbered));
    expect(tableAt(parent, 0)).toMatch(/<li><[uo]l/);
    expect(thrownMessage(() => checkTabTableCells(parent, 4_999, "insertTable"))).toBe(tabCells("insertTable", 5_001));
  });

  it("counts a list item written as a heading once", () => {
    // `<li><h2>…</h2></li>` is one paragraph, not two.
    let headed = buildTab([para("Before"), {
      table: Array.from({ length: 250 }, () => Array.from({ length: 10 }, () =>
        cellOf({ runs: ["Step\n"], namedStyleType: "HEADING_2", bullet: { listId: "L1" } }))),
    }, para("After")], BULLET_LIST);
    let held = docTabToMarkdown(headed);
    expect(tableAt(held, 0)).toContain("<li><h2>");
    expect(() => checkTabTableCells(held, 2_500, "insertTable")).not.toThrow();
    expect(thrownMessage(() => checkTabTableCells(held, 2_501, "insertTable"))).toBe(tabCells("insertTable", 5_001));
  });

  it("takes an addition that brings the tab's tables to the limit, and refuses what would pass it", () => {
    let filled = applyDocEdit(FULL, addRows(content, 1, 1, tenCells()));
    let grown = renderTab(filled);
    let second = addRows(grown, 1, 2, tenCells());
    expect(refusal(filled, second)).toBe(tabCells("insertTableRows", 5010));
    expect(thrownMessage(() => checkTabTableCells(grown, addedTableCells(second), second.type)))
      .toBe(tabCells("insertTableRows", 5010));

    let column = addColumns(content, 0, 10, blank(498, 1));
    expect(refusal(FULL, column)).toBe(tabCells("insertTableColumns", 5488));
    expect(thrownMessage(() => checkTabTableCells(content, addedTableCells(column), column.type)))
      .toBe(tabCells("insertTableColumns", 5488));

    for (let after of [undefined, "After", "Nowhere", "Mid\n"]) {
      expect(refusal(FULL, newTable(blank(1, 11), after))).toBe(tabCells("insertTable", 5001));
    }

    let eleven = Array.from({ length: 11 }, () => tenCells()[0]);
    expect(refusal(FULL, addRows(content, 1, 1, eleven))).toBe(tabCells("insertTableRows", 5100));
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
    expect(thrownMessage(() => checkTabTableCells(mixed, MAX_TAB_TABLE_CELLS, "insertTable")))
      .toBe(tabCells("insertTable", 5005));
    expect(() => checkTabTableCells(mixed, 0, "insertTable")).not.toThrow();

    // Paragraphs of only a rule, alone or two in a cell, and a rule inside a paragraph of text.
    let rule = { runs: [{ horizontalRule: true as const }, "\n"] };
    let ruled = read(buildTab([
      para("Before"),
      {
        table: [[
          cellOf(rule, rule), cellOf(rule),
          cellOf({ runs: ["a", { horizontalRule: true }, "b\n"] }),
        ]],
      },
      para("After"),
    ]));
    expect(tableAt(ruled, 0)).toContain("<td><hr></td>");
    expect(thrownMessage(() => checkTabTableCells(ruled, MAX_TAB_TABLE_CELLS, "insertTable")))
      .toBe(tabCells("insertTable", 5004));
  });

  it("leaves a tab whose tables hold more every change that adds nothing", () => {
    let over = buildTab([para("Before"), sized(251, 20), para("After")]);
    let held = read(over);
    expect(refusal(over, addRows(held, 0, 251, blank(1, 20))))
      .toBe(tabCells("insertTableRows", 5040));
    expect(refusal(over, newTable([["x"]]))).toBe(tabCells("insertTable", 5021));
    appliedChange(over, dropRows(held, 0, 3, 2));
    appliedChange(over, dropColumns(held, 0, 19));
    appliedChange(over, dropTable(held, 0));
    appliedCellText(over, "<p>r7c3</p>", "<p>changed</p>");
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
      appliedChange(CHIPS, change);
    }
    let applied = appliedChange(CHIPS, addRows(content, 0, 2, [["x", ""]]));
    expect(held(applied, 2, 0)).toEqual(["x", "\n"]);
    expect(held(applied, 2, 1)).toEqual(["chip", "\n"]);
    // A copy is a chip alone in its cell, which a row added beside it copies again.
    let after = docTabToMarkdown(applied);
    expect(after.sourceMap.tables[0].rows[2].cells[1])
      .toMatchObject({ texts: [], loneChip: true, copies: "dropdown", unshown: 1 });
    appliedChange(applied, addRows(after, 0, 3, [["z", ""]]));

    expect(refusal(CHIPS, addRows(content, 0, 2, [["x", "y"]]))).toBe(CHIP_COLUMN(1, 1));
    expect(refusal(CHIPS, addRows(content, 0, 1, [["", ""], ["", "y"]])))
      .toBe(CHIP_COLUMN(1, 1));
    // A new column copies no chip.
    appliedChange(CHIPS, addColumns(content, 0, 2, [["x"], ["y"]]));
    appliedChange(CHIPS, addColumns(content, 0, 1, [["x"], ["y"]]));
  });

  it("copies a person chip, date chip, rich link or placeholder alone as the placeholder", () => {
    for (let runs of [[person("Ana"), "\n"], [person(), "\n"], [{ date: "Nov 8, 2026" }, "\n"],
      ["\uE907\n"], [{ richLink: { title: "Plan", uri: "https://x.example/" } }, "\n"],
      [person("Ana"), "  \n"]] as Runs[]) {
      let tab = () => chips(runs);
      let content = read(tab());
      let applied = appliedChange(tab(), addRows(content, 0, 2, [["x", ""], ["y"]]));
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
      appliedChange(chipFirst(), change);
    }
    let applied = appliedChange(chipFirst(), addRows(content, 0, 2, [["", ""], ["", "y"]]));
    expect(held(applied, 3, 0)).toEqual(["chip", "\n"]);
    expect(held(applied, 3, 1)).toEqual(["y", "\n"]);
  });

  it("copies nothing of several chips, so the new cells take text", () => {
    for (let runs of [[person("Ana"), person("Ben"), "\n"],
      [person("Ana"), { date: "Nov 8, 2026" }, "\n"]] as Runs[]) {
      let tab = () => chips(runs);
      expect(read(tab()).sourceMap.tables[0].rows[1].cells[1])
        .toMatchObject({ loneChip: true, copies: "nothing" });
      let applied = appliedChange(tab(), addRows(read(tab()), 0, 2, [["x", "y"]]));
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
      appliedChange(tab(), addRows(read(tab()), 0, 2, [["x", "y"]]));
    }
    let image = chips([{ dropdown: "image" }, "\n"]);
    makeInlineImage(image, 1, 1);
    appliedChange(image, addRows(read(image), 0, 2, [["x", "y"]]));
  });
});

const suggestedRefusal = (op: string) =>
  `${op}: this table holds suggested changes to its rows, columns or cells, or to their text, ` +
  "so its rows and columns cannot be changed until they are accepted or rejected.";

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
    ["suggested text in a cell", () => buildTab([
      para("Before"),
      {
        table: [["a\n", "b\n"], ["c\n", {
          paragraphs: [{ runs: ["d", { text: " new", suggested: "insertion" }, "\n"] }],
        }], ["e\n", "f\n"]],
      },
      para("After"),
    ])],
    ["a suggested style on a cell's text", () => buildTab([
      para("Before"),
      {
        table: [
          ["a\n", "b\n"],
          ["c\n", { paragraphs: [{ runs: [{ text: "d\n", suggested: "style" }] }] }],
          ["e\n", "f\n"],
        ],
      },
      para("After"),
    ])],
    ["a suggested change to a cell paragraph's style", () => buildTab([
      para("Before"),
      {
        table: [
          ["a\n", "b\n"], ["c\n", { paragraphs: [{ ...para("d"), suggestedChange: "style" }] }],
          ["e\n", "f\n"],
        ],
      },
      para("After"),
    ])],
  ];

  for (let [name, tab] of tabs) {
    it(`refuses row and column changes on a table with ${name}, and deletes it`, () => {
      let content = read(tab());
      expect(content.sourceMap.tables[0].suggested).toBeGreaterThan(0);
      // Refused before `at` is looked at: none of these names a row or column of the table.
      for (let change of [
        addRows(content, 0, 9, [["", ""]]), addColumns(content, 0, 9, [[""], [""], [""]]),
        dropRows(content, 0, 9), dropColumns(content, 0, 9),
      ]) {
        expect(targetRefusal(tab(), change)).toBe(suggestedRefusal(change.type));
      }
      // A table that is itself suggested has no cell to edit: the test below says so.
      if (name !== "a table that is itself suggested") {
        let { rendering } = appliedCellText(tab(), "<p>a</p>", "<p>changed</p>");
        expect(rendering.sourceMap.tables[0].suggested).toBeGreaterThan(0);
      }
      appliedChange(tab(), dropTable(content, 0));
      expect(kinds(tableChangeRequests(docTabToMarkdown(tab()), dropTable(content, 0))))
        .toEqual(["deleteContentRange"]);
    });
  }
});

describe("text in a table, row or cell that a suggestion inserts or deletes", () => {
  // Google marks such a suggestion on the table, row or cell, and not on the text in it.
  const inside = (oldMarkdown: string, newMarkdown: string) => (tab: GoogleDocsTab) => {
    let before = docTabToMarkdown(tab);
    let { matchStart } = replacementIn(before.markdown, oldMarkdown, newMarkdown);
    return thrownMessage(() => tableTextRequests(before, matchStart, oldMarkdown, newMarkdown));
  };
  const IN_SUGGESTION =
    "replaceText: this cell is in a table, a row or a cell that a suggestion inserts or " +
    "deletes, so its text cannot be changed until the suggestion is accepted or rejected in " +
    "Google Docs.";
  const rows = [["a\n", "b\n"], ["c\n", "d\n"], ["e\n", "f\n"]];

  it("is refused, and the text of the other rows and cells is edited", () => {
    for (let suggested of ["insertion", "deletion"] as const) {
      let row = buildTab(
        [para("Before"), { table: rows, suggestedRows: { 1: suggested } }, para("After")]);
      expect(inside("<p>c</p>", "<p>changed</p>")(row)).toBe(IN_SUGGESTION);
      expect(inside("<p>d</p>", "<p>changed</p>")(row)).toBe(IN_SUGGESTION);
      // As a stored replacement of the cell's text, as replaceText() queues one.
      expect(thrownMessage(() => docEditRequests(docTabToMarkdown(row),
        { type: "replaceText", oldMarkdown: "c", newMarkdown: "changed", inTable: true })))
        .toBe(IN_SUGGESTION);
      expect(appliedCellText(row, "<p>e</p>", "<p>changed</p>").rendering.markdown)
        .toContain("<p>changed</p>");

      let cell = buildTab([para("Before"), {
        table: [["a\n", "b\n"], ["c\n", { paragraphs: [para("d")], suggested }]],
      }, para("After")]);
      expect(inside("<p>d</p>", "<p>changed</p>")(cell)).toBe(IN_SUGGESTION);
      expect(appliedCellText(cell, "<p>c</p>", "<p>changed</p>").rendering.markdown)
        .toContain("<p>changed</p>");
    }
    let table = buildTab([para("Before"), { table: rows }, para("After")]);
    let element = tableElement(table).table;
    if (element) element.suggestedDeletionIds = ["suggest.table"];
    expect(inside("<p>a</p>", "<p>changed</p>")(table)).toBe(IN_SUGGESTION);
  });
});

describe("an edit of text that holds suggestions", () => {
  // "Plan {++new ++}for {--next --}week" with "week" a suggested style, a table whose first cell
  // holds a suggested insertion and deletion, a paragraph whose style a suggestion changes and
  // one whose bullet a suggestion changes.
  const tab = (last: ParagraphSpec = para("End")) => buildTab([
    {
      runs: [
        "Plan ", { text: "new ", suggested: "insertion" }, "for ",
        { text: "next ", suggested: "deletion" }, { text: "week\n", suggested: "style" },
      ],
    },
    {
      table: [[{
        paragraphs: [{
          runs: [
            "a", { text: "new", suggested: "insertion" }, { text: "old", suggested: "deletion" },
            "b\n",
          ],
        }],
      }, "c\n"]],
    },
    { ...para("Centred"), suggestedChange: "style" },
    { ...para("Listed"), suggestedChange: "bullet" },
    last,
  ]);
  const TOUCHES = /^(?:replaceText|appendText): the text this change touches holds suggested changes/;
  const replace = (oldMarkdown: string, newMarkdown: string, inTable?: true): DocEdit =>
    ({ type: "replaceText", oldMarkdown, newMarkdown, ...(inTable ? { inTable } : {}) });
  const built = (edit: DocEdit, from = tab()) => docEditRequests(read(from), edit);

  it("reads as the marks show it", () => {
    expect(read(tab()).markdown).toBe(
      "Plan {++new ++}for {--next --}week\n\n<table>\n  <tr>\n" +
      "    <td><p>a<ins>new</ins><del>old</del>b</p></td>\n    <td><p>c</p></td>\n  </tr>\n" +
      "</table>\n\nCentred\n\nListed\n\nEnd\n");
  });

  it("refuses a replacement that would delete, restyle or write into suggested text", () => {
    for (let edit of [
      replace("Plan {++new ++}for", "Plan for"),
      replace("{++new ++}", "{++newer ++}"),
      replace("{++new ++}", "{++**new** ++}"),
      replace("{--next --}week", "{--next --}month"),
      replace("{--next --}week", "{--next --}**week**"),
      replace("<del>old</del>b", "b", true),
      replace("a<ins>new</ins>", "a<ins>nw</ins>", true),
    ]) {
      expect(thrownMessage(() => built(edit)), JSON.stringify(edit)).toMatch(TOUCHES);
    }
  });

  it("refuses a paragraph or bullet change, a split or a join of a paragraph a suggestion restyles", () => {
    for (let edit of [
      replace("Centred", "# Centred"),
      replace("Centred", "Centred\n\nSplit"),
      replace("Centred\n\nListed", "Centred Listed"),
      replace("Listed", "- Listed"),
      replace("Listed", "## Listed"),
    ]) {
      expect(thrownMessage(() => built(edit)), JSON.stringify(edit)).toMatch(TOUCHES);
    }
    // An append to a tab that ends in one: Google would give it the bullet.
    let listedLast = tab({ ...para("Last"), suggestedChange: "bullet" });
    expect(thrownMessage(() => built({ type: "appendText", markdown: "Tail" }, listedLast)))
      .toMatch(TOUCHES);
  });

  it("refuses marks that a replacement in a cell adds or takes off", () => {
    for (let edit of [
      replace("a<ins>new</ins>", "a<ins>newer</ins>", true),
      replace("<del>old</del>b", "oldb", true),
      replace("<td><p>c</p>", "<td><p><ins>c</ins></p>", true),
    ]) {
      expect(thrownMessage(() => built(edit)), JSON.stringify(edit))
        .toMatch(/^replaceText: in a table cell <ins> and <del> mark/);
    }
  });

  it("makes an edit beside suggested text, inside a paragraph a suggestion restyles, and an append", () => {
    for (let edit of [
      replace("Plan", "Our plan"),
      replace("{++new ++}for", "{++new ++}FOR"),
      replace("for {--next", "to {--next"),
      replace("<p>a<ins>", "<p>A<ins>", true),
      replace("a<ins>new</ins>", "<ins>new</ins>", true),
      replace("<del>old</del>b", "<del>old</del>B", true),
      replace("Centred", "Centered"),
      replace("Listed", "Listed here"),
      { type: "appendText", markdown: "Tail" },
    ] satisfies DocEdit[]) {
      let requests = built(edit);
      expect(requests.length, JSON.stringify(edit)).toBeGreaterThan(0);
      // The model holds each suggestion where it stood, as Google was recorded doing.
      let after = docTabToMarkdown(applyDocsRequests(tab(), requests)).markdown;
      expect(after.match(/\{\+\+new \+\+\}|\{--next --\}|<ins>new<\/ins>|<del>old<\/del>/g))
        .toEqual(["{++new ++}", "{--next --}", "<ins>new</ins>", "<del>old</del>"]);
    }
  });

  it("repoints a link in a cell up to a line break a suggestion restyles", () => {
    // Google sets no link on a line break, so a link-only style leaves the suggestion as it was.
    let cell = () => buildTab([para("Before"), { table: [[{
      paragraphs: [
        { runs: [{ text: "Label", style: url("https://a.example") }, { text: "\n", suggested: "style" }] },
        { runs: ["Second\n"] },
      ],
    }, "c\n"]] }, para("After")]);
    let link = (destination: string) => `<p><a href="${destination}">Label</a></p>`;
    let requests = built(replace(link("https://a.example"), link("https://b.example"), true), cell());
    expect(requests).toEqual([{
      updateTextStyle: {
        range: { startIndex: 11, endIndex: 16, tabId: "tab-1" },
        textStyle: url("https://b.example"), fields: "link",
      },
    }]);
    expect(read(applyDocsRequests(cell(), requests)).markdown).toContain(link("https://b.example"));
  });

  it("refuses the deletion of a table whose text came to hold a suggestion, unless it recorded it", () => {
    let table = (cell: CellSpec) => buildTab([para("Before"), { table: [["a\n", cell]] }, para("After")]);
    let plain = () => table("b\n");
    // A suggested style shows nothing, so the table still reads as it was queued.
    let restyled = () => table({ paragraphs: [{ runs: [{ text: "b\n", suggested: "style" }] }] });
    expect(read(restyled()).markdown).toBe(read(plain()).markdown);
    expect(refusal(restyled(), dropTable(read(plain()), 0))).toBe(
      "deleteTable: this table has come to hold suggested changes to its rows, columns or " +
      "cells, or to their text, since this change was queued.");
    let recorded = dropTable(read(restyled()), 0);
    expect(recorded).toMatchObject({ suggested: 1 });
    appliedChange(restyled(), recorded);
  });
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
const statusDeletions = (content: DocTabSnapshot): TableChange[] =>
  [dropRows(content, 0, 1), dropColumns(content, 0, 1), dropTable(content, 0)];

describe("a row insertion whose reference row has come to copy otherwise", () => {
  /** Row 1 added before, as queued: with what Google copies from that row into it. */
  const queuedRow = (content: DocTabSnapshot): TableChange => ({
    type: "insertTableRows", at: 1, cells: [["", ""]], ...refOf(content, 0),
    copies: chipCopies(content.sourceMap.tables[0], 1),
  });
  const cameToCopy = "insertTableRows: the row the new rows take after has come to hold, or no " +
    "longer holds, a dropdown or other smart chip that Google Docs copies into them, which " +
    "getContent() does not show, since this change was queued.";

  it("refuses an empty row queued before its reference row came to hold a dropdown", () => {
    // A dropdown reads as nothing, so the table reads as recorded with and without it.
    expect(read(dropdownTab()).markdown).toBe(read(statusTab()).markdown);
    let plain = queuedRow(read(statusTab()));
    expect(plain).toMatchObject({ copies: "--" });
    appliedChange(statusTab(), plain);
    expect(refusal(dropdownTab(), plain)).toBe(cameToCopy);

    let copying = queuedRow(read(dropdownTab()));
    expect(copying).toMatchObject({ copies: "-d" });
    appliedChange(dropdownTab(), copying);
    expect(refusal(statusTab(), copying)).toBe(cameToCopy);
  });

  it("holds a row queued before copies were recorded to nothing of the kind", () => {
    appliedChange(dropdownTab(), addRows(read(statusTab()), 0, 1, [["", ""]]));
  });
});

describe("a deletion whose cells have come to hold what its card did not say", () => {
  it("refuses a deletion queued before a cell it removes came to hold a dropdown", () => {
    // A dropdown reads as nothing, so the table reads as recorded with and without it.
    expect(read(dropdownTab()).markdown).toBe(read(statusTab()).markdown);
    for (let change of statusDeletions(read(statusTab()))) {
      expect(change).not.toHaveProperty("unshown");
      appliedChange(statusTab(), change);
      expect(refusal(dropdownTab(), change)).toBe(cameToHoldChips(change.type));
    }
  });

  it("refuses a deletion that recorded one dropdown once its cells hold a second", () => {
    let two = () => statusTab(cellOf({ runs: [{ dropdown: "Blocked" }, { dropdown: "Late" }, "\n"] }));
    // A second dropdown reads as nothing too, so the table reads as it did with one.
    expect(read(two()).markdown).toBe(read(dropdownTab()).markdown);
    for (let change of statusDeletions(read(dropdownTab()))) {
      expect(change).toMatchObject({ unshown: 1 });
      expect(refusal(two(), change)).toBe(cameToHoldChips(change.type));
    }
    // One that recorded both applies with both, with one and with none.
    for (let change of statusDeletions(read(two()))) {
      expect(change).toMatchObject({ unshown: 2 });
      appliedChange(two(), change);
      appliedChange(dropdownTab(), change);
      appliedChange(statusTab(), change);
    }
  });

  it("looks only at the cells the deletion removes", () => {
    let content = read(statusTab());
    for (let change of [dropRows(content, 0, 2), dropColumns(content, 0, 0)]) {
      expect(change).not.toHaveProperty("unshown");
      appliedChange(dropdownTab(), change);
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
      "cells, or to their text, since this change was queued.");

    let queuedWith = dropTable(read(suggested()), 0);
    // The row suggested for deletion, and each of its two cells.
    expect(queuedWith).toMatchObject({ suggested: 3 });
    appliedChange(suggested(), queuedWith);
    appliedChange(plain(), queuedWith);
    // A second row suggested for deletion since: more than the change recorded.
    let more = () => buildTab([
      para("Before"), { table: rows, suggestedRows: { 0: "deletion", 1: "deletion" } }, para("After"),
    ]);
    expect(read(more()).markdown).toBe(read(plain()).markdown);
    expect(refusal(more(), queuedWith)).toBe(
      "deleteTable: this table has come to hold suggested changes to its rows, columns or " +
      "cells, or to their text, since this change was queued.");
    appliedChange(more(), dropTable(read(more()), 0));

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
      "cells, or to their text, since this change was queued.");
    expect(refusal(holding({ 0: "deletion" }), dropRows(read(holding()), 0, 0))).toBe(
      "deleteTableRows: this table holds suggested changes to its rows, columns or cells, or " +
      "to their text, so its rows and columns cannot be changed until they are accepted or " +
      "rejected.");
    expect(dropTable(read(holding({ 0: "deletion" })), 0)).toMatchObject({ suggested: 3 });
  });

  it("counts a suggestion on an image in a cell, which deleting the cell would discard", () => {
    let imaged = (suggested: boolean) => {
      let tab = buildTab([para("Before"), grid(["a", "b"], ["c", "d"]), para("After")]);
      makeInlineImage(tab, 1, 0);
      let { paragraph } = cellParagraph(tab, 1, 0);
      if (suggested) paragraph.elements[0].inlineObjectElement!.suggestedDeletionIds = ["suggest.image"];
      return tab;
    };
    // The image reads the same with the suggestion and without it.
    expect(read(imaged(true)).markdown).toBe(read(imaged(false)).markdown);
    expect(refusal(imaged(true), dropRows(read(imaged(false)), 0, 1))).toBe(suggestedRefusal("deleteTableRows"));
    expect(refusal(imaged(true), dropTable(read(imaged(false)), 0))).toBe(
      "deleteTable: this table has come to hold suggested changes to its rows, columns or " +
      "cells, or to their text, since this change was queued.");
  });

  // A suggested change of a chip's style or properties, and a rule's suggested deletion, read as
  // nothing.
  const deletion = { suggestedDeletionIds: ["suggest.chip"] };
  it.each([
    ["person", "person", deletion],
    ["dropdown", "dropdown", deletion],
    ["richLink", "richLink", { suggestedTextStyleChanges: { "suggest.chip": { textStyle: { italic: true } } } }],
    ["horizontalRule", "horizontalRule", deletion],
    ["date's properties", "dateElement",
      { suggestedDateElementPropertiesChanges: { "suggest.chip": { dateElementProperties: {} } } }],
    ["dropdown's properties", "dropdown",
      { suggestedDropdownPropertiesChanges: { "suggest.chip": { dropdownProperties: {} } } }],
  ] as const)("counts a suggestion on a %s in a cell", (_label, kind, suggestion) => {
    let chipped = (suggested: boolean) => {
      let tab = buildTab([para("Before"), grid(["a", "b"], ["c", "d"]), para("After")]);
      let { paragraph } = cellParagraph(tab, 1, 0);
      let { startIndex, endIndex } = paragraph.elements[0];
      let chip = {
        person: { person: { personProperties: { name: "Ana", email: "ana@example.com" } } },
        dropdown: { dropdown: { dropdownProperties: { displayValue: "Open" } } },
        richLink: { richLink: { richLinkProperties: { title: "Plan", uri: "https://example.com/plan" } } },
        dateElement: { dateElement: { dateElementProperties: { displayText: "Nov 25, 2026" } } },
        horizontalRule: { horizontalRule: {} },
      }[kind];
      let element: ParagraphElement = { startIndex, endIndex, ...chip };
      if (suggested) Object.assign(element[kind]!, suggestion);
      paragraph.elements[0] = element;
      return tab;
    };
    expect(read(chipped(true)).markdown).toBe(read(chipped(false)).markdown);
    expect(refusal(chipped(true), dropRows(read(chipped(false)), 0, 1))).toBe(suggestedRefusal("deleteTableRows"));
    expect(refusal(chipped(true), dropTable(read(chipped(false)), 0))).toBe(
      "deleteTable: this table has come to hold suggested changes to its rows, columns or " +
      "cells, or to their text, since this change was queued.");
  });

  it("carries what a deletion would remove through the changes queued before it", () => {
    let content = read(dropdownTab());
    let grown = renderTab(applyDocEdit(dropdownTab(), addRows(content, 0, 0, [["new", "row"]])));
    // The dropdown's row has moved down by one.
    expect(dropRows(grown, 0, 2)).toMatchObject({ unshown: 1 });
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
  it("stays with the text of a paragraph a table is added after", () => {
    let tab = positionedTab([para("Before"), para("Anchored"), para("After")], 1);
    expect(judge(tab, newTable([["t"]], "Anchored"))).toBeUndefined();
    let markdown = docTabToMarkdown(appliedChange(tab, newTable([["t"]], "Anchored"))).markdown;
    expect(markdown).toContain(`[Image] Anchored\n\n${tableHtml([["t"]])}`);
    let last = positionedTab([para("Before"), para("Anchored")], 1);
    expect(judge(last, newTable([["t"]]))).toBeUndefined();
  });

  it("refuses a table that would cut the paragraph at its start", () => {
    let afterTable = positionedTab(
      [para("Before"), grid(["x"]), para("Anchored"), para("After")], 1);
    expect(judge(afterTable, newTable([["t"]], "x"))).toBe(POSITIONED_REFUSAL);
    let bare = positionedTab([para("Before"), grid(["x"]), para(""), para("After")], 1);
    expect(judge(bare, newTable([["t"]], "x"))).toBe(POSITIONED_REFUSAL);
  });

  it("refuses a table after an empty paragraph that holds one", () => {
    let tab = positionedTab([para("Before"), para(""), para("After")], 1);
    expect(judge(tab, newTable([["t"]], "[Image]"))).toBe(POSITIONED_REFUSAL);
    let last = positionedTab([para("Before"), para("")], 1);
    expect(judge(last, newTable([["t"]]))).toBe(POSITIONED_REFUSAL);
    let two = positionedTab([para("Before"), para("")], 1);
    bodyParagraph(two, 1).positionedObjectIds = ["one", "two"];
    expect(judge(two, newTable([["t"]]))).toBe(POSITIONED_REFUSAL);
  });

  it("is told from typed text only by the document", () => {
    // Typed text that starts with the mark, in a paragraph that is read-only for its chip.
    let typed = buildTab([
      para("Before"), { runs: ["[Image] ", { date: "Nov 8, 2026" }, "\n"] }, para("After"),
    ]);
    expect(judge(typed, newTable([["t"]], "Nov 8, 2026"))).toBeUndefined();
    // The mark alone, beside a chip that renders as nothing: it reads as an empty paragraph
    // that holds a positioned image does.
    let mark = buildTab([para("Before"), quietChip("[Image]"), para("After")]);
    expect(judge(mark, newTable([["t"]], "[Image]"))).toBeUndefined();
    let afterTable = buildTab([
      para("Before"), grid(["x"]), { runs: ["[Image] ", { date: "Nov 8, 2026" }, "\n"] }, para("After"),
    ]);
    expect(judge(afterTable, newTable([["t"]], "x"))).toBeUndefined();
  });

  it("stays with a chip that renders as nothing, which only the document tells from none", () => {
    let tab = positionedTab([para("Before"), quietChip(), para("After")], 1);
    expect(read(tab).markdown).toBe("Before\n\n[Image]\n\nAfter\n");
    expect(judge(tab, newTable([["t"]], "[Image]"))).toBeUndefined();
    let last = positionedTab([para("Before"), quietChip()], 1);
    expect(judge(last, newTable([["t"]]))).toBeUndefined();
    let markdown = docTabToMarkdown(appliedChange(last, newTable([["t"]]))).markdown;
    expect(markdown).toBe(`Before\n\n[Image]\n\n${tableHtml([["t"]])}\n\n\n`);
  });
});

describe("what a tab's paragraphs are, however they read", () => {
  it("deletes a table between paragraphs that only read as list items", () => {
    let tab = buildTab(
      [para("1. First caption"), grid(["x"]), para("2. Second caption"), para("End")]);
    expect(judge(tab, dropTable(read(tab), 0))).toBeUndefined();
  });

  it("deletes numbered cells before a paragraph that only reads as a numbered item", () => {
    let tab = buildTab([
      para("Before"),
      { table: [[cellOf(item("one", "N1")), "a\n"], [cellOf(item("two", "N1")), "b\n"]] },
      para("2. A caption"),
    ], ALL_LISTS);
    let content = read(tab);
    for (let change of [dropRows(content, 0, 1), dropTable(content, 0)]) {
      expect(judge(tab, change)).toBeUndefined();
    }
  });

  it("sees two items of a list with no marker only in the document", () => {
    let between = buildTab(
      [item("quiet one", "Q1"), grid(["x"]), item("quiet two", "Q1"), para("End")], ALL_LISTS);
    expect(judge(between, dropTable(read(between), 0))).toBe(
      "deleteTable: this table sits between two items of one list, which deleting it would " +
      "join. That is not supported.");
    let emptyNext = buildTab([item("quiet one", "Q1"), item("", "Q1"), para("End")], ALL_LISTS);
    expect(judge(emptyNext, newTable([["t"]], "quiet one"))).toBe(
      "insertTable: a table cannot be added between two items of a list. Name the list's last " +
      "item instead.");
  });

  it("deletes a table between items of two different lists", () => {
    let tab = () => buildTab(
      [item("one", "L1"), grid(["x"]), item("two", "L2"), para("End")], ALL_LISTS);
    let applied = appliedChange(tab(), dropTable(read(tab()), 0));
    expect(docTabToMarkdown(applied).markdown).toBe("- one\n\n- two\n\nEnd\n");
    let same = buildTab([item("one"), grid(["x"]), item("two"), para("End")], ALL_LISTS);
    expect(judge(same, dropTable(read(same), 0))).toBe(
      "deleteTable: this table sits between two items of one list, which deleting it would " +
      "join. That is not supported.");
  });

  it("tells a table of contents from a paragraph that reads as one only by the document", () => {
    let typed = buildTab([
      para("Before"), quietChip("[Table of contents]"), grid(["x"]), para("After"),
    ]);
    expect(judge(typed, newTable([["t"]], "[Table of contents]"))).toBeUndefined();
    expect(judge(typed, dropTable(read(typed), 0))).toBeUndefined();

    let real = buildTab([para("Before"), toc, para(""), grid(["x"]), para("After")]);
    expect(judge(real, newTable([["t"]], "[Table of contents]"))).toBe(TOC_REFUSAL);
    let beside = buildTab([para("Before"), toc, grid(["x"]), para("After")]);
    expect(judge(beside, dropTable(read(beside), 0))).toBe(notLaidOut("deleteTable"));
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
      }
    }
  });

  it("deletes what holds none, and the footnotes after it keep their numbers", () => {
    let content = read(footnotesTab());
    for (let change of [
      dropRows(content, 0, 1), dropColumns(content, 0, 1), dropTable(content, 1),
    ]) {
      let markdown = docTabToMarkdown(appliedChange(footnotesTab(), change)).markdown;
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
      appliedChange(tab(), change);
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
      let markdown = docTabToMarkdown(appliedChange(bullets, dropRows(read(bullets), 0, row))).markdown;
      // The list goes on after the table at the number it had: a continued item reads `1.`.
      expect(markdown).toContain("</table>\n\n2. one\n1. two\n");
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
 * A replacement of the one paragraph of a single-cell table; `oldHtml` and `newHtml` are its
 * text, and the requests come back counted from the paragraph's start.
 */
function oneCell(runs: Runs, oldHtml: string, newHtml: string, wrap = "p") {
  let tab = buildTab([
    para("Before"), { table: [[cellOf({ runs: [...runs, "\n"] })]] }, para("After"),
  ]);
  let start = cellParagraph(tab, 0, 0).start;
  let result = appliedCellText(
    tab, `<${wrap}>${oldHtml}</${wrap}>`, `<${wrap}>${newHtml}</${wrap}>`);
  let html = tableAt(result.rendering, 0);
  return {
    ...result,
    tab,
    start,
    /** The requests as they are sent. */
    raw: result.requests,
    requests: relative(result.requests, start),
    /** The paragraph's text as the cell reads once the replacement is made. */
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
    appliedCellText(CELLS, oldMarkdown, newMarkdown);

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
    expect(tableAt(inBold.rendering, 0)).toContain("<p><strong>bolder</strong> plain</p>");
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
      expect(tableAt(edit(oldHtml, newHtml).rendering, 0)).toContain(newHtml);
    }
  });

  it("reads a bare & and > as text, and shows them escaped", () => {
    let { rendering, applied } = edit("<p>Open</p>", "<p>a & b > c &amp d</p>");
    expect(tableAt(rendering, 0)).toContain("<p>a &amp; b &gt; c &amp;amp d</p>");
    expect(tableTexts(applied)[0][1]).toBe("a & b > c &amp d\n");
  });

  it("replaces text in a heading, in a list item and in one paragraph of several", () => {
    expect(tableAt(edit("<h2>Title</h2>", "<h2>New <em>title</em></h2>").rendering, 0))
      .toContain("<h2>New <em>title</em></h2>\n      <p>first</p>\n      <p>second</p>");
    expect(tableAt(edit("<p>second</p>", "<p>2nd</p>").rendering, 0))
      .toContain("<p>first</p>\n      <p>2nd</p>");
    let bullet = edit("<li>\u25cf two</li>", "<li>\u25cf second item</li>");
    expect(tableAt(bullet.rendering, 0))
      .toContain("<li>\u25cf one</li><li>\u25cf second item</li>");
    // Texts after a changed one in the same cell move with it.
    let both = edit(
      "<h2>Title</h2>\n      <p>first</p>", "<h2>A longer title</h2>\n      <p>1st</p>");
    expect(tableAt(both.rendering, 0))
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
    let { rendering } = appliedCellText(
      BASIC(), "<p>r0c0</p>", `<p>r0${BULLET}c0!</p>`);
    expect(tableAt(rendering, 0)).toContain("<td><p>r0c0!</p></td>");
  });
});

describe("commonPrefix and commonSuffix", () => {
  it("measure what two texts share at each end", () => {
    expect(commonPrefix("abcd", "abxd")).toBe(2);
    expect(commonPrefix("abc", "abc")).toBe(3);
    expect(commonPrefix("abc", "")).toBe(0);
    expect(commonSuffix("abcd", "axcd", 0)).toBe(2);
    expect(commonSuffix("abc", "xyz", 0)).toBe(0);
  });

  it("stop the suffix where `from` says, in either text", () => {
    expect(commonSuffix("x a", "x a a", 3)).toBe(0);
    expect(commonSuffix("x a", "x a a", 1)).toBe(2);
    expect(commonSuffix("abab", "ab", 0)).toBe(2);
    expect(commonSuffix("abab", "ab", 1)).toBe(1);
  });

  it("never take the suffix past the shorter text", () => {
    expect(commonSuffix("aaa", "aaaaa", 0)).toBe(3);
    expect(commonSuffix("aaaaa", "aaa", 0)).toBe(3);
    expect(commonSuffix("aaa", "aaaaa", 5)).toBe(0);
  });

  it("split no surrogate pair", () => {
    // U+1F600 and U+1F601 share their high surrogate; U+1F600 and U+1F200 their low one.
    expect(commonPrefix("a\u{1F600}", "a\u{1F601}")).toBe(1);
    expect(commonPrefix("a\u{1F600}b", "a\u{1F600}c")).toBe(3);
    expect(commonSuffix("\u{1F600}z", "\u{1F200}z", 0)).toBe(1);
    expect(commonSuffix("\u{1F600}z", "\u{1F600}z", 0)).toBe(3);
  });
});

// Google does not insert inside a grapheme cluster: it refuses the insertion or moves it to the
// cluster's end, where the text and the style sent for it would land otherwise than shown.
describe("grapheme clusters in what a replacement changes", () => {
  // An e and a combining acute accent: one cluster.
  const ACCENTED = "Café";
  const WRITTEN = "CafeX́";

  it("rewrites a cluster whole in a cell rather than insert inside it", () => {
    let accent = oneCell([ACCENTED], ACCENTED, WRITTEN);
    expect(accent.requests)
      .toEqual([["delete", 3, 5], ["insert", 3, "eX́"], RESET(3, 6)]);
    expect(accent.html).toBe(WRITTEN);
    let bolded = oneCell([ACCENTED], ACCENTED, "Caf<strong>eX</strong>́");
    expect(bolded.requests).toEqual([
      ["delete", 3, 5], ["insert", 3, "eX́"], RESET(3, 6),
      ["style", 3, 5, { bold: true }, "bold"],
    ]);
    expect(bolded.html).toBe("Caf<strong>eX</strong>́");
  });

  it("starts an insertion where the text the deletion leaves has no cluster", () => {
    // The regional indicators U and S pair up as a flag once the x between them is deleted.
    let flag = oneCell(["\u{1F1FA}x\u{1F1F8}"], "\u{1F1FA}x\u{1F1F8}", "\u{1F1FA}y\u{1F1F8}");
    expect(flag.requests).toEqual([["delete", 2, 5], ["insert", 2, "y\u{1F1F8}"], RESET(2, 5)]);
    expect(flag.html).toBe("\u{1F1FA}y\u{1F1F8}");
  });

  it("rewrites a cluster whole in a paragraph rather than insert inside it", () => {
    let tab = buildTab([para(ACCENTED), para("After")]);
    let before = docTabToMarkdown(tab);
    let replacement = replacementIn(before.markdown, ACCENTED, WRITTEN);
    expect(relative(textReplacementRequests(before, replacement), 1))
      .toEqual([["delete", 3, 5], ["insert", 3, "eX́"], RESET(3, 6)]);
    expect(appliedParagraphText(tab, ACCENTED, WRITTEN).markdown).toBe(`${WRITTEN}\n\nAfter\n`);
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

/** What the request builder refuses a cell replacement with. */
function cellRefusal(tab: GoogleDocsTab, oldMarkdown: string, newMarkdown: string): string {
  let before = docTabToMarkdown(tab);
  let { matchStart } = replacementIn(before.markdown, oldMarkdown, newMarkdown);
  return thrownMessage(() => tableTextRequests(before, matchStart, oldMarkdown, newMarkdown));
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
    appliedCellText(
      PLAIN, QUOTED, "<td><p>Fix login </p></td>\n    <td><p>Open</p></td>");
    appliedCellText(
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
      appliedCellText(tab, oldMarkdown, newMarkdown);
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
    appliedCellText(LISTS, "<li>\u25cf Second</li>", "<li>\u25cf Second item</li>");
    appliedCellText(
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
      expect(thrownMessage(() => parseCellInline(html))).toBe(NOTHING_ELSE);
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
    expect(thrownMessage(() => parseCellInline("<b>x</b>"))).toBe(unsupportedTag("b"));
    expect(thrownMessage(() => parseCellInline("<a >x</a>"))).toBe(LINK_FORM);
  });

  it("names a closing tag that has no name by the two characters typed", () => {
    const NO_NAME = "replaceText: </ is not supported in a table cell. Use <strong>, <em>, " +
      "<s>, <a href=\"...\"> and <br>, and write a literal < as &lt;.";
    for (let html of ["Open</>", "Open</ p>", "</>Open", "Op</-x>en"]) {
      expect(writtenInto(html)).toBe(NO_NAME);
      expect(thrownMessage(() => parseCellInline(html))).toBe(NO_NAME);
    }
    expect(thrownMessage(() => parseCellInline("Open</"))).toBe(NO_NAME);
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
    let requests = tableTextRequests(before, matchStart, OLD_CELL, written);
    expect(requests?.length).toBe(MAX_TABLE_TEXT_REQUESTS);
    expect(kinds(requests ?? []).slice(0, 3))
      .toEqual(["insertText", "updateTextStyle", "updateTextStyle"]);
    let content = renderTab(applyDocEdit(
      tab, { type: "replaceText", oldMarkdown: OLD_CELL, newMarkdown: written, inTable: true }));
    expect(content.markdown).toContain(written);
  });

  it("refuses one request more, as a change to the cells and as a stored replacement", () => {
    let written = striped(MAX_TABLE_TEXT_REQUESTS - 1);
    expect(thrownMessage(() => tableTextRequests(before, matchStart, OLD_CELL, written)))
      .toBe(TOO_MANY_REQUESTS);
    let stored = { matchStart, oldMarkdown: OLD_CELL, newMarkdown: written, inTable: true as const };
    expect(thrownMessage(() => textReplacementRequests(before, stored))).toBe(TOO_MANY_REQUESTS);
  });

  it("refuses a list of thousands of items given new text at once", () => {
    let items = Array.from({ length: 3_000 }, (_, index) => item(`i${index}`));
    let list = buildTab(
      [para("Before"), { table: [[cellOf(...items)]] }, para("After")], ALL_LISTS);
    let listed = docTabToMarkdown(list);
    let html = tableAt(listed, 0);
    let start = listed.markdown.indexOf(html);
    // Each item needs a deletion, an insertion and a reset.
    let written = html.replace(/\u25cf i/g, "\u25cf k");
    expect(thrownMessage(() => tableTextRequests(listed, start, html, written))).toBe(TOO_MANY_REQUESTS);
  });

  it("walks a link of thousands of formatted stretches once, however many it holds", () => {
    // One link of alternately struck-through and plain stretches, pointed to another URL: a
    // walk once for each stretch would not refuse within a test's time.
    let pointed = (pairs: number) => {
      let runs = Array.from({ length: pairs }, () =>
        [linked("a", OLD, { strikethrough: true }), linked("b", OLD)]).flat();
      let tab = buildTab(
        [para("Before"), { table: [[cellOf({ runs: [...runs, "\n"] })]] }, para("After")]);
      let long = docTabToMarkdown(tab);
      let oldMarkdown = linkedStripes(OLD, pairs);
      let newMarkdown = linkedStripes(NEW, pairs);
      let found = replacementIn(long.markdown, oldMarkdown, newMarkdown).matchStart;
      return {
        shown: () => renderTab(
          applyDocEdit(tab, { type: "replaceText", oldMarkdown, newMarkdown, inTable: true })),
        requests: () => tableTextRequests(long, found, oldMarkdown, newMarkdown),
      };
    };

    // At the limit the link is pointed elsewhere whole: one request for each stretch, no clear.
    let atLimit = pointed(MAX_TABLE_TEXT_REQUESTS / 2);
    expect(atLimit.shown().markdown).toContain(linkedStripes(NEW, MAX_TABLE_TEXT_REQUESTS / 2));
    let requests = atLimit.requests() ?? [];
    expect(requests).toHaveLength(MAX_TABLE_TEXT_REQUESTS);
    for (let request of requests) {
      expect("updateTextStyle" in request && request.updateTextStyle)
        .toMatchObject({ textStyle: url(NEW), fields: "link" });
    }

    expect(thrownMessage(pointed(24_000).requests)).toBe(TOO_MANY_REQUESTS);
  });
});

// ---------------------------------------------------------------------------
// Replacements beside a table, and across one
// ---------------------------------------------------------------------------

const pathOf = (
  content: DocTabSnapshot, oldMarkdown: string, newMarkdown: string, matchStart?: number,
): ReplacementPath =>
  replacementPath(content, replacementIn(content.markdown, oldMarkdown, newMarkdown, matchStart));

const CELL_PATH: ReplacementPath = { kind: "cells", table: 0 };
const PARAGRAPH_PATH: ReplacementPath = { kind: "paragraphs" };
const beside = (side: "before" | "after" | "around"): ReplacementPath => ({ kind: "beside", side });
const refusedBeside = (side: "before" | "after" | "around") => besideTableRefusal(side).message;

const BTA = () => buildTab([para("Before"), grid(["a", "b"]), para("After")]);
const ABTAT = () => buildTab([para("A"), para("B"), grid(["a", "b"]), para("After"), para("Tail")]);
const CHIP_TABLE_DUE = () => buildTab([chip(), grid(["a", "b"]), dateChip(), para("Tail")]);
const CHIP_B_TABLE_AFTER_DUE = () =>
  buildTab([chip(), para("B"), grid(["a", "b"]), para("After"), dateChip()]);
const TWO_TABLES = (between: string) =>
  buildTab([para("Before"), grid(["a"]), para(between), grid(["b"]), para("After")]);

/** A tab once an edit has removed the paragraph that reads `line`, quoted with its line break. */
const emptied = (tab: GoogleDocsTab, line: string): GoogleDocsTab =>
  applyDocEdit(tab, { type: "replaceText", oldMarkdown: `${line}\n`, newMarkdown: "" });

describe("replacementPath", () => {
  it("puts text inside one table on the cell path", () => {
    let content = read(BTA());
    let html = tableAt(content, 0);
    expect(pathOf(content, "<p>a</p>", "<p>z</p>")).toEqual(CELL_PATH);
    // Text added strictly inside the table's HTML.
    let row = "<table>\n  <tr>";
    expect(pathOf(content, row, `${row}\n    <td><p>New</p></td>\n  </tr>\n  <tr>`)).toEqual(CELL_PATH);
    expect(pathOf(content, "</table>\n\nAfter", "<\\/table>\n\nAfter")).toEqual(CELL_PATH);
    // The table quoted whole, and with the paragraphs beside it, around one changed cell.
    expect(pathOf(content, html, html.replace("<p>a</p>", "<p>z</p>"))).toEqual(CELL_PATH);
    expect(pathOf(content, content.markdown, content.markdown.replace("<p>b</p>", "<p>z</p>")))
      .toEqual(CELL_PATH);
    // The table's whole HTML, replaced or removed: the range ends where the table does.
    expect(pathOf(content, html, "X")).toEqual(CELL_PATH);
    expect(pathOf(content, html, "")).toEqual(CELL_PATH);
    let two = read(TWO_TABLES("Mid"));
    expect(pathOf(two, "<p>b</p>", "<p>z</p>")).toEqual({ kind: "cells", table: 1 });
  });

  it("puts text that touches no table on the paragraph path", () => {
    let content = read(BTA());
    expect(pathOf(content, "Before", "Earlier")).toEqual(PARAGRAPH_PATH);
    // The quoted table and its blank line are the same in both texts, and count for nothing.
    expect(pathOf(content, "Before\n\n<table>", "Before!\n\n<table>")).toEqual(PARAGRAPH_PATH);
    expect(pathOf(content, "</table>\n\nAfter", "</table>\n\nLater")).toEqual(PARAGRAPH_PATH);
    // Text added at the end of the paragraph before the table, and at the start of the one after.
    expect(pathOf(content, "Before", "Before\n\nIntro")).toEqual(PARAGRAPH_PATH);
    expect(pathOf(content, "After", "Caption\n\nAfter")).toEqual(PARAGRAPH_PATH);
    expect(pathOf(content, "After", "XAfter")).toEqual(PARAGRAPH_PATH);
    let longer = read(ABTAT());
    expect(pathOf(longer, "A\n\n", "")).toEqual(PARAGRAPH_PATH);
    expect(pathOf(longer, "\n\nTail", "")).toEqual(PARAGRAPH_PATH);
    // A range that ends where the table's blank line starts stops short of the table.
    expect(pathOf(content, "Before\n", "")).toEqual(PARAGRAPH_PATH);
    let plain = read(buildTab([para("One"), para("Two")]));
    expect(pathOf(plain, "One", "<table>")).toEqual(PARAGRAPH_PATH);
  });

  it("says which side of a table a replacement reaches it from", () => {
    let content = read(BTA());
    let [table] = content.sourceMap.tables;
    expect(pathOf(content, "Before\n\n<table>", "Before\n\nIntro\n\n<table>"))
      .toEqual(beside("before"));
    expect(pathOf(content, "Before\n", "Before\n\nIntro\n")).toEqual(beside("before"));
    expect(pathOf(content, "</table>\n", "</table>\n\nCaption\n")).toEqual(beside("after"));
    // Text added at the table's first character and at its last, and on the line breaks around it.
    for (let [at, side] of [
      [table.mdStart - 1, "before"], [table.mdStart, "before"],
      [table.mdEnd, "after"], [table.mdEnd + 1, "after"],
    ] as const) {
      expect(pathOf(content, "", "X", at)).toEqual(beside(side));
    }
    expect(pathOf(content, "", "X", table.mdStart - 2)).toEqual(PARAGRAPH_PATH);
    expect(pathOf(content, "", "X", table.mdEnd + 2)).toEqual(PARAGRAPH_PATH);

    // The paragraph beside the table taken with the table's blank line, and that line alone.
    expect(pathOf(content, "Before\n\n", "")).toEqual(beside("before"));
    expect(pathOf(content, "Before\n\n<table>", "Before\n<table>")).toEqual(beside("before"));
    expect(pathOf(content, "\n\nAfter", "")).toEqual(beside("after"));
    expect(pathOf(content, "</table>\n\nAfter", "</table>\nAfter!")).toEqual(beside("after"));
    let todo = read(buildTab([para("A"), para("<TODO>"), grid(["a"]), para("After")]));
    expect(pathOf(todo, "<TODO>\n\n<table>", "<table>")).toEqual(beside("before"));
    expect(pathOf(todo, "<TODO>\n\n", "")).toEqual(beside("before"));

    // Text of the table together with text outside it.
    expect(pathOf(content, "Before\n\n<table>\n  <tr>\n    <td><p>a", "X")).toEqual(beside("before"));
    expect(pathOf(content, "b</p></td>\n  </tr>\n</table>\n\nAfter", "X")).toEqual(beside("after"));
    // A range ending at the table's last character, or starting at its first, has one side.
    let html = tableAt(content, 0);
    expect(pathOf(content, `Before\n\n${html}`, "X")).toEqual(beside("before"));
    expect(pathOf(content, `${html}\n\nAfter`, "X")).toEqual(beside("after"));
    expect(pathOf(content, content.markdown, "Rewritten\n")).toEqual(beside("around"));
    expect(pathOf(content, "Before\n\n<table>\n  <tr>\n    <td><p>a</p></td>\n    <td><p>b</p></td>\n  </tr>\n</table>\n\nAfter", "Gone"))
      .toEqual(beside("around"));
    // From inside one table into the next: the first table the text reaches names the side.
    let two = read(TWO_TABLES("Mid"));
    expect(pathOf(two, "a</p></td>\n  </tr>\n</table>\n\nMid\n\n<table>\n  <tr>\n    <td><p>b", "ab"))
      .toEqual(beside("after"));

    // Whatever stands beside the table: a read-only paragraph, or the empty one Google Docs
    // keeps there once an edit removes the paragraph between two tables.
    let readOnly = read(CHIP_TABLE_DUE());
    expect(pathOf(readOnly, "<table>", "X\n\n<table>")).toEqual(beside("before"));
    expect(pathOf(readOnly, "</table>", "</table>\n\nX")).toEqual(beside("after"));
    expect(pathOf(readOnly, "Owner: Ana\n\n<table>", "<table>")).toEqual(beside("before"));
    let empty = read(TWO_TABLES(""));
    let removed = read(emptied(TWO_TABLES("Mid"), "Mid"));
    expect(removed.markdown).toBe(empty.markdown);
    for (let tab of [empty, removed]) {
      let second = tab.markdown.lastIndexOf("<table>");
      expect(pathOf(tab, "<table>", "X\n\n<table>", second)).toEqual(beside("before"));
      expect(pathOf(tab, "</table>", "</table>\n\nX", tab.markdown.indexOf("</table>")))
        .toEqual(beside("after"));
    }
  });

  it("never throws", () => {
    let content = read(BTA());
    let { markdown } = content;
    let reached = new Set<string>();
    for (let start = 0; start <= markdown.length; start++) {
      for (let end = start; end <= markdown.length; end++) {
        let oldMarkdown = markdown.slice(start, end);
        for (let newMarkdown of ["", "X", `${oldMarkdown}X`, `X${oldMarkdown}`]) {
          reached.add(replacementPath(content, { matchStart: start, oldMarkdown, newMarkdown }).kind);
        }
      }
    }
    expect([...reached].toSorted()).toEqual(["beside", "cells", "paragraphs"]);
    let cases: [DocTabSnapshot, TextReplacement][] = [
      [content, { matchStart: markdown.length + 5, oldMarkdown: "gone", newMarkdown: "x" }],
      [content, { matchStart: -3, oldMarkdown: "gone", newMarkdown: "x" }],
      [read(buildTab([para("")])), { matchStart: 0, oldMarkdown: "", newMarkdown: "" }],
    ];
    for (let [target, replacement] of cases) {
      expect(replacementPath(target, replacement)).toEqual(PARAGRAPH_PATH);
    }
  });

  it("puts text that starts with < above a table on the cell path", () => {
    let content = read(BTA());
    let html = tableAt(content, 0);
    // The text shares its first character with the table, so what changes starts inside it.
    expect(pathOf(content, html, `<p>x</p>\n\n${html}`)).toEqual(CELL_PATH);
    for (let text of ["<p>x</p>", "<TODO: describe the figures>", "<50 employees only", "<"]) {
      expect(pathOf(content, "<table>", `${text}\n\n<table>`)).toEqual(CELL_PATH);
    }
  });

  it("reads a table that opens the tab, and one that ends it", () => {
    let first = read(buildTab([grid(["a", "b"]), para("After")]));
    expect(first.markdown.startsWith("<table>")).toBe(true);
    expect(pathOf(first, "<table>", "X\n\n<table>")).toEqual(beside("before"));
    expect(pathOf(first, "", "X", 0)).toEqual(beside("before"));
    expect(pathOf(first, "<p>a</p>", "<p>z</p>")).toEqual(CELL_PATH);
    expect(pathOf(first, "After", "Later")).toEqual(PARAGRAPH_PATH);

    let last = read(buildTab([para("Before"), grid(["a", "b"])]));
    expect(last.markdown.endsWith("</table>\n")).toBe(true);
    expect(pathOf(last, "</table>", "</table>\n\nX")).toEqual(beside("after"));
    // Past the line break that ends the table nothing is the table's.
    expect(pathOf(last, "", "X", last.markdown.length)).toEqual(PARAGRAPH_PATH);
    expect(pathOf(last, "<p>b</p>", "<p>z</p>")).toEqual(CELL_PATH);
    expect(pathOf(last, "Before", "Earlier")).toEqual(PARAGRAPH_PATH);
  });
});

const CONVERTER_REFUSAL = new StructuredContentError().message;

type Outcome = { value: unknown } | { error: string; structured: boolean };

function outcome(run: () => unknown): Outcome {
  try {
    return { value: run() };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { error: error.message, structured: error instanceof StructuredContentError };
  }
}

/** What the converter's own calls give for the requests of a replacement as written. */
function converterRequests(tab: DocTabSnapshot, replacement: TextReplacement): unknown[] {
  let { matchStart, oldMarkdown, newMarkdown } = replacement;
  return computeReplaceOperations(
    tab.sourceMap, tab.markdown, matchStart, matchStart + oldMarkdown.length,
    canonicalizeMarkdownReplacement(oldMarkdown, newMarkdown), tab.tabId).requests;
}

/** The converter's own requests for a replacement, and the stored paragraph replacement's. */
function bothPaths(tab: DocTabSnapshot, replacement: TextReplacement): [Outcome, Outcome] {
  return [
    outcome(() => converterRequests(tab, replacement)),
    outcome(() => textReplacementRequests(tab, replacement)),
  ];
}

/** A replacement's requests are the converter's own, and it reads one way once made. */
function expectAsConverter(tab: GoogleDocsTab, oldMarkdown: string, newMarkdown: string): void {
  let before = docTabToMarkdown(tab);
  let replacement = replacementIn(before.markdown, oldMarkdown, newMarkdown);
  expect(textReplacementRequests(before, replacement))
    .toEqual(converterRequests(before, replacement));
  appliedParagraphText(tab, oldMarkdown, newMarkdown);
}

/** What the requests of a stored paragraph replacement are refused with. */
function textRefusal(tab: GoogleDocsTab, oldMarkdown: string, newMarkdown: string): string {
  let before = docTabToMarkdown(tab);
  let replacement = replacementIn(before.markdown, oldMarkdown, newMarkdown);
  return thrownMessage(() => textReplacementRequests(before, replacement));
}

const breaks = (count: number) => "\n".repeat(count);

/** Replacements beside the one table of a tab, in every phrasing an agent may reach for. */
function generatedReplacements(
  markdown: string, table: { mdStart: number; mdEnd: number },
): TextReplacement[] {
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
      expect(tableTextRequests(before, matchStart, oldMarkdown, written)).toBeUndefined();
      expectAsConverter(BTA(), oldMarkdown, written);
    }
    let first = renderTab(applyDocEdit(BTA(), {
      type: "replaceText", oldMarkdown: "</table>\n\nAfter", newMarkdown: "</table>\nAfter!",
    }));
    expect(first.markdown.endsWith("</table>\n\nAfter!\n")).toBe(true);
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
    let refused = 0;
    for (let tab of tabs) {
      let before = docTabToMarkdown(tab);
      for (let replacement of generatedReplacements(before.markdown, before.sourceMap.tables[0])) {
        let path = replacementPath(before, replacement);
        let [own, engine] = bothPaths(before, replacement);
        if ("value" in own) {
          expect(engine).toEqual(own);
          // What the paragraph path accepts, the model of Google Docs takes.
          applyDocsRequests(tab, textReplacementRequests(before, replacement));
          accepted++;
        } else if (!own.structured || path.kind !== "beside") {
          expect(engine).toEqual(own);
        } else {
          expect(engine).toEqual({ error: refusedBeside(path.side), structured: false });
          refused++;
        }
      }
    }
    expect(accepted).toBeGreaterThan(750);
    expect(refused).toBeGreaterThan(50);
  });

  it("replays text that starts with < above a table on the path it was queued for", () => {
    let before = docTabToMarkdown(BTA());
    let html = tableAt(before, 0);
    let replacement = replacementIn(before.markdown, html, `<p>x</p>\n\n${html}`);
    expect(replacementPath(before, replacement)).toEqual(CELL_PATH);
    let requests = (stored: TextReplacement & { inTable?: true }) =>
      () => textReplacementRequests(before, stored);
    // Queued as a paragraph replacement, it is the paragraph path's to refuse: no table is
    // reached from outside.
    let error = thrown(requests(replacement));
    expect(error).toBeInstanceOf(StructuredContentError);
    expect(error).toHaveProperty("message",
      "replaceText: structured content cannot be edited. Narrow the match to plain text.");
    expect(error).not.toHaveProperty("message", refusedBeside("before"));
    // Queued for text in a table, it is a change to the table's tags.
    expect(thrownMessage(requests({ ...replacement, inTable: true }))).toBe(STRUCTURE);
  });

  it("refuses text added at a table's edge, on either side", () => {
    let neighbours: [ParagraphSpec, string, ParagraphSpec][] = [
      [para("Before"), "Before", para("After")],
      [para(""), "", para("")],
      [item("item"), "- item", heading("Next")],
      [heading("Results"), "## Results", para("After")],
    ];
    for (let [above, lineAbove, below] of neighbours) {
      let before = docTabToMarkdown(buildTab(
        [para("Start"), above, grid(["a", "b"]), below, para("End")], ALL_LISTS));
      for (let text of ["## Results Q3", "One\n\nTwo"]) {
        // The line above the table, quoted with its line break, is found by where it stands.
        let lineStart = before.sourceMap.tables[0].mdStart - 2 - lineAbove.length;
        let phrasings: [string, string, "before" | "after", number?][] = [
          ["<table>", `${text}\n\n<table>`, "before"],
          [`${lineAbove}\n\n<table>`, `${lineAbove}\n\n${text}\n\n<table>`, "before"],
          [`${lineAbove}\n`, `${lineAbove}\n\n${text}\n`, "before", lineStart],
          ["</table>", `</table>\n\n${text}`, "after"],
          ["</table>\n", `</table>\n\n${text}\n`, "after"],
        ];
        for (let [oldMarkdown, newMarkdown, side, matchStart] of phrasings) {
          let replacement = replacementIn(before.markdown, oldMarkdown, newMarkdown, matchStart);
          expect(tableTextRequests(before, replacement.matchStart, oldMarkdown, newMarkdown))
            .toBeUndefined();
          expect(outcome(() => converterRequests(before, replacement)))
            .toEqual({ error: CONVERTER_REFUSAL, structured: true });
          expect(replacementPath(before, replacement)).toEqual(beside(side));
          expect(thrownMessage(() => textReplacementRequests(before, replacement)))
            .toBe(refusedBeside(side));
        }
      }
    }
  });

  it("takes every spelling the refusal names, beside a paragraph with text and an empty one", () => {
    // A change to an example of either text changes this test.
    expect(refusedBeside("before")).toContain("\"\\n\\n<table\" becomes \"Text\\n\\n<table\"");
    expect(refusedBeside("after")).toContain("\"</table>\\n\\n\" becomes \"</table>\\n\\nText\"");

    let [first, second] = [tableHtml([["a"]]), tableHtml([["b"]])];
    // Enough of each of two tables for the quote to occur once in the tab.
    let startOfB = "<table>\n  <tr>\n    <td><p>b";
    let endOfA = "a</p></td>\n  </tr>\n</table>";
    type Spelling = [oldMarkdown: string, newMarkdown: string];
    let cases: {
      tab: () => GoogleDocsTab;
      refused?: [...Spelling, side: "before" | "after"];
      named: Spelling;
      reads: string;
    }[] = [{
      tab: () => buildTab([para("Lead"), grid(["a"]), para("After")]),
      refused: ["<table", "Intro\n\n<table", "before"],
      named: ["Lead", "Lead\n\nIntro"],
      reads: `Lead\n\nIntro\n\n${first}\n\nAfter\n`,
    }, {
      tab: () => buildTab([para(""), grid(["a"]), para("After")]),
      refused: ["<table", "Intro\n\n<table", "before"],
      named: ["\n\n<table", "Intro\n\n<table"],
      reads: `Intro\n\n${first}\n\nAfter\n`,
    }, {
      tab: () => TWO_TABLES("Mid"),
      refused: [startOfB, `Intro\n\n${startOfB}`, "before"],
      named: ["Mid", "Mid\n\nIntro"],
      reads: `Before\n\n${first}\n\nMid\n\nIntro\n\n${second}\n\nAfter\n`,
    }, {
      tab: () => TWO_TABLES("Mid"),
      refused: [endOfA, `${endOfA}\n\nCaption`, "after"],
      named: ["Mid", "Caption\n\nMid"],
      reads: `Before\n\n${first}\n\nCaption\n\nMid\n\n${second}\n\nAfter\n`,
    }, {
      tab: () => TWO_TABLES(""),
      refused: [startOfB, `Intro\n\n${startOfB}`, "before"],
      named: [`\n\n${startOfB}`, `Intro\n\n${startOfB}`],
      reads: `Before\n\n${first}\n\nIntro\n\n${second}\n\nAfter\n`,
    }, {
      tab: () => TWO_TABLES(""),
      refused: [endOfA, `${endOfA}\n\nCaption`, "after"],
      named: [`${endOfA}\n\n`, `${endOfA}\n\nCaption`],
      reads: `Before\n\n${first}\n\nCaption\n\n${second}\n\nAfter\n`,
    }, {
      tab: () => TWO_TABLES(""),
      named: ["</table>\n\n\n\n<table", "</table>\n\nMiddle\n\n<table"],
      reads: `Before\n\n${first}\n\nMiddle\n\n${second}\n\nAfter\n`,
    }, {
      tab: () => buildTab([para("Before"), grid(["a"]), para("Tail"), para("Next")]),
      refused: ["</table>", "</table>\n\nCaption", "after"],
      named: ["Tail", "Caption\n\nTail"],
      reads: `Before\n\n${first}\n\nCaption\n\nTail\n\nNext\n`,
    }, {
      tab: () => buildTab([para("Before"), grid(["a"]), para(""), para("Next")]),
      refused: ["</table>", "</table>\n\nCaption", "after"],
      named: ["</table>\n\n", "</table>\n\nCaption"],
      reads: `Before\n\n${first}\n\nCaption\n\nNext\n`,
    }, {
      tab: () => buildTab([para("Before"), grid(["a"]), para("")]),
      refused: ["</table>", "</table>\n\nCaption", "after"],
      named: ["</table>\n\n", "</table>\n\nCaption"],
      reads: `Before\n\n${first}\n\nCaption\n`,
    }];
    for (let { tab, refused, named, reads } of cases) {
      if (refused) {
        let [oldMarkdown, newMarkdown, side] = refused;
        expect(textRefusal(tab(), oldMarkdown, newMarkdown)).toBe(refusedBeside(side));
      }
      let content = read(tab());
      let { matchStart } = replacementIn(content.markdown, ...named);
      // It quotes a table, and is no change to one.
      expect(tableTextRequests(content, matchStart, ...named)).toBeUndefined();
      expect(appliedParagraphText(tab(), ...named).markdown).toBe(reads);
    }
  });

  it("writes more than one paragraph on the empty line beside a table", () => {
    let rest = `${tableHtml([["a"]])}\n\nAfter\n`;
    for (let text of ["Intro\n\nMore", "# Title"]) {
      let tab = buildTab([para(""), grid(["a"]), para("After")]);
      expect(appliedParagraphText(tab, "\n\n<table", `${text}\n\n<table`).markdown)
        .toBe(`${text}\n\n${rest}`);
    }
  });

  it("writes a heading in front of an empty paragraph, and reads as written", () => {
    // The empty paragraph after a paragraph, inside the tab and at its end.
    let places: [tab: GoogleDocsTab, oldMarkdown: string, lead: string, tail: string][] = [
      [buildTab([para("Before"), para(""), para("End")]), "Before\n\n", "Before\n\n", "\n\n"],
      [buildTab([para("Before"), para(""), para(""), para("End")]),
        "Before\n\n", "Before\n\n", "\n\n"],
      [buildTab([para("Before"), para("")]), "Before\n\n", "Before\n\n", "\n\n"],
    ];
    let texts = ["## Notes", "## Notes\n\nSee below", "See above\n\n## Notes", "See below",
      "See above\n\nSee below", "## Notes\n\n", "## Notes\n\n\n\n"];
    for (let [tab, oldMarkdown, lead, tail] of places) {
      for (let text of texts) {
        let { rendering } = appliedReplacement(tab, oldMarkdown, `${lead}${text}${tail}`);
        expect(rendering.markdown).toContain(text.replace(/\n+$/, ""));
      }
    }
  });

  // Recorded: around-tables, the paragraphs above and below a table becoming items.
  it("makes list items of the paragraphs above and below a table", () => {
    let table = grid(["a", "b"], ["c", "d"]);
    let above = buildTab([para("Top"), para("Second top"), table, para(""), para("Bottom")]);
    let bulleted = appliedParagraphText(above, "Second top", "- Second top");
    expect(bulleted.markdown).toContain("Top\n\n- Second top\n\n<table>");

    // The list is one Google made for the preset, with its nine levels.
    let made: Lists = { made: { listProperties: { nestingLevels: presetLevels() } } };
    let below = buildTab(
      [para("Top"), item("Second top", "made"), table, para(""), para("Bottom")], made);
    let listed = appliedParagraphText(below, "Bottom", "- Bottom\n- Bottom two");
    expect(listed.markdown).toMatch(/<\/table>\n\n\n\n- Bottom\n- Bottom two\n$/);
  });
});

describe("text written in front of a list item that shows no marker", () => {
  // An item whose level has no marker reads as a plain line, so a plain paragraph written in
  // front of it leaves the list. Text below a table is written in front of the paragraph after
  // it, so meets this where that paragraph is such an item, as it does with no table near.
  const places: [tab: () => GoogleDocsTab, write: (text: string) => [string, string]][] = [
    [
      () => buildTab(
        [para("Before"), grid(["a", "b"]), item("Notes", "Q1"), para("End")], ALL_LISTS),
      text => ["Notes", `${text}\n\nNotes`],
    ],
    [
      () => buildTab([para("Before"), item("Notes", "Q1"), para("End")], ALL_LISTS),
      text => ["Notes", `${text}\n\nNotes`],
    ],
  ];
  it("writes plain paragraphs there as paragraphs of their own", () => {
    for (let [tab, write] of places) {
      for (let text of ["Caption", "One\n\nTwo", "*Caption*"]) {
        let { applied } = appliedReplacement(tab(), ...write(text));
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
    let cases: [() => GoogleDocsTab, string, string][] = [
      [() => buildTab([para("Before"), grid(["a", "b"]), subtitle, para("End")]),
        "*Notes*", "Caption\n\n*Notes*"],
      [() => buildTab([para("Before"), subtitle, para("End")]), "Before", "Before\n\nCaption"],
      // A subtitle whose style is not italic reads with no marker, so its first word starts its
      // line: text ending in a break written over that word leaves the rest the subtitle.
      [() => styledTab(aroundSubtitle("Notes here")), "Notes", "Caption\n\n"],
    ];
    for (let [tab, oldMarkdown, newMarkdown] of cases) {
      let { applied } = appliedReplacement(tab(), oldMarkdown, newMarkdown);
      expect([1, 2].map(index => bodyParagraph(applied, index).paragraphStyle?.namedStyleType))
        .toEqual(["NORMAL_TEXT", "SUBTITLE"]);
    }
  });

  it("writes a heading there outside the list, and text in front of any other paragraph", () => {
    for (let [tab, write] of places) {
      let { applied } = appliedReplacement(tab(), ...write("## Head"));
      expect(bodyParagraph(applied, 1).bullet).toBeUndefined();
    }
    // Above a table that follows such an item, and below one in front of a bulleted item.
    let above = buildTab(
      [para("Start"), item("Notes", "Q1"), grid(["a", "b"]), para("End")], ALL_LISTS);
    appliedParagraphText(above, "Notes", "Notes\n\nCaption");
    let bulleted = buildTab(
      [para("Before"), grid(["a", "b"]), item("Notes"), para("End")], ALL_LISTS);
    appliedParagraphText(bulleted, "- Notes", "Caption\n\n- Notes");
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

/** Blocks whose middle paragraph is a subtitle of these runs. */
const aroundSubtitle = (...runs: ParagraphSpec["runs"]): BlockSpec[] =>
  [para("Before"), { runs: [...runs, "\n"], namedStyleType: "SUBTITLE" }, para("After")];

describe("formatting a paragraph's named style already gives", () => {
  const body = () => styledTab([
    para("Before"), heading("Notes here", 6), heading("Results here", 2), para("After"),
  ]);
  const cells = () => styledTab([
    para("Before"),
    { table: [[cellOf(heading("Cell notes", 6)), cellOf(heading("Cell results", 2))], ["a\n", "b\n"]] },
    para("After"),
  ]);

  it("drops it from text written into a paragraph outside tables, as Google stores it", () => {
    for (let [oldMarkdown, newMarkdown] of [
      ["###### Notes here", "###### Notes *there*"],
      ["###### Notes here", "###### *Notes* **here**"],
      ["## Results here", "## **Results** *here*"],
      ["## Results here", "## Results ~~here~~ **now**"],
      ["After", "After\n\n###### *New* note"],
      ["Before", "Before *and* **after**"],
    ]) {
      let { rendering } = appliedReplacement(body(), oldMarkdown, newMarkdown);
      expect(rendering.markdown).not.toContain("*Notes*");
    }
    expect(appliedReplacement(body(), "###### Notes here", "###### *Notes* here")
      .rendering.markdown).toContain("###### Notes here\n");
    expect(appliedReplacement(body(), "## Results here", "## **Results** *here*")
      .rendering.markdown).toContain("## Results *here*\n");
  });

  it("keeps it on text a replacement outside tables does not write", () => {
    // Text made bold before its paragraph became a bold heading keeps its own bold.
    const boldHeading = (text: string): ParagraphSpec =>
      ({ runs: [{ text, style: { bold: true } }, " here\n"], namedStyleType: "HEADING_2" });
    let tab = () => styledTab([para("Before"), boldHeading("Bold"), boldHeading("Two"), para("After")]);
    expect(docTabToMarkdown(tab()).markdown).toContain("## **Bold** here\n\n## **Two** here\n");
    // A write inside the paragraph's text writes only its own text.
    for (let [newMarkdown, read] of [
      ["**Bold** *literal* here", "## **Bold** *literal* here\n"],
      ["**Bold** there", "## **Bold** there\n"],
      ["**Bold** **there**", "## **Bold** there\n"],
    ]) {
      let { rendering } = appliedReplacement(tab(), "**Bold** here", newMarkdown);
      expect(rendering.markdown).toContain(read);
    }
    // One that meets a formatting marker rewrites the paragraph whole, which then loses it.
    expect(appliedReplacement(tab(), "**Bold** here", "*literal* **Bold** here")
      .rendering.markdown).toContain("## *literal* Bold here\n");
    // A rewrite of whole blocks keeps the blocks it leaves as they were.
    expect(appliedReplacement(tab(), "## **Two** here", "## **Two** here\n\n## **Three**")
      .rendering.markdown).toContain("## **Two** here\n\n## Three\n");
    // Text that is written loses it.
    expect(appliedReplacement(tab(), "## **Bold** here", "## **New** here")
      .rendering.markdown).toContain("## New here\n");
  });

  it("keeps the formatting of the rest of a list item or heading a written break splits off", () => {
    let runs = ["Notes ", { text: "here", style: { bold: true } }, "\n"];
    for (let target of [
      { runs, bullet: { listId: "Q1" } }, { runs, namedStyleType: "HEADING_2" },
    ] as ParagraphSpec[]) {
      let tab = { ...buildTab([para("Before"), target, para("After")], ALL_LISTS), namedStyles: NAMED_STYLES };
      let { rendering, applied } = appliedReplacement(tab, "Notes", "End\n\n");
      expect(rendering.markdown).toContain("End\n\n **here**\n");
      // A table placed after that text as the read shows it finds it once Google applies it.
      appliedChange(applied, newTable([["a"]], "\n **here**\n"));
    }
  });

  it("keeps the rest of a heading as Google does, literal asterisks and bold on all of it included", () => {
    // Normal text bold by its style, headings not.
    let styles = {
      styles: [
        { namedStyleType: "NORMAL_TEXT", textStyle: { bold: true } },
        { namedStyleType: "HEADING_2", textStyle: { bold: false } },
      ],
    };
    let literal = styledTab([para("Before"), heading("Notes **Literal**"), para("After")], styles);
    let { rendering, applied } = appliedReplacement(literal, "Notes", "End\n\n");
    expect(rendering.markdown).toContain("End\n\n **Literal**\n");
    appliedChange(applied, newTable([["a"]], "\n **Literal**\n"));
    // The rest bold throughout loses the bold naming its new style takes, and is given it again.
    let bold = styledTab([para("Before"), {
      runs: ["Notes ", { text: "here", style: { bold: true } }, "\n"], namedStyleType: "HEADING_2",
    }, para("After")]);
    expect(appliedReplacement(bold, "Notes ", "End\n\n").rendering.markdown)
      .toContain("End\n\n**here**\n");
  });

  const SUBTITLE_BREAK =
    "replaceText: a paragraph break written inside a subtitle would make the rest of it a " +
    "normal paragraph, without the subtitle's look. Write the break at the subtitle's end, " +
    "or replace the whole subtitle.";
  /** A heading whose last word is bold of its own, in a tab where normal text is bold by its style. */
  const boldByStyle = () => styledTab([para("Before"), {
    runs: ["Notes ", { text: "here", style: { bold: true } }, "\n"], namedStyleType: "HEADING_2",
  }, para("After")], {
    styles: [
      { namedStyleType: "NORMAL_TEXT", textStyle: { bold: true } },
      { namedStyleType: "HEADING_2", textStyle: { bold: false } },
    ],
  });

  const ITALIC_SUBTITLE = { styles: [{ namedStyleType: "SUBTITLE", textStyle: { italic: true } }] };

  it.each<[string, () => GoogleDocsTab]>([
    ["italic by its style", () => styledTab(aroundSubtitle("Notes here"), ITALIC_SUBTITLE)],
    ["after other text of the subtitle",
      () => styledTab(aroundSubtitle("Prefix Notes here"), ITALIC_SUBTITLE)],
    ["partly italic", () => styledTab(
      aroundSubtitle("Prefix Notes ", { text: "here", style: { italic: false } }), ITALIC_SUBTITLE)],
    ["of a style that is not italic", () => styledTab(aroundSubtitle("Prefix Notes here"))],
    ["in a tab whose named styles give no formatting", () => styledTab(
      aroundSubtitle("Prefix Notes here"),
      { styles: [{ namedStyleType: "NORMAL_TEXT", textStyle: { bold: false } }] })],
    ["in a tab that came without named styles", () => buildTab(aroundSubtitle("Prefix Notes here"))],
  ])("refuses a break that would leave text normal text cannot read as it does: a subtitle %s", (_, tab) => {
    expect(textRefusal(tab(), "Notes", "End\n\n")).toBe(SUBTITLE_BREAK);
  });

  // The last two rows say only that the break is taken.
  it.each<[string, () => GoogleDocsTab, string, string, string?]>([
    ["in a normal paragraph", () => styledTab([para("Before"), para("Notes here"), para("After")]),
      "Notes", "End\n\n", "End\n\n here\n"],
    ["in a heading whose own bold normal text's style also gives", boldByStyle,
      "Notes", "End\n\n", "## End\n\n here\n"],
    ["in a heading whose own bold no style gives", () => styledTab([para("Before"), {
      runs: ["Notes ", { text: "here", style: { bold: true } }, "\n"], namedStyleType: "HEADING_2",
    }, para("After")]), "Notes", "End\n\n", "## End\n\n **here**\n"],
    ["at a subtitle's end", () => styledTab(aroundSubtitle("Prefix Notes here"), ITALIC_SUBTITLE),
      "*Prefix Notes here*", "*Prefix Notes here*\n\nEnd"],
    ["after a paragraph written ahead of a subtitle",
      () => buildTab(aroundSubtitle("Prefix Notes here")), "*Prefix", "New paragraph\n\n*Prefix"],
  ])("takes a break %s", (_, tab, oldMarkdown, newMarkdown, reads = "") => {
    expect(appliedReplacement(tab(), oldMarkdown, newMarkdown).rendering.markdown).toContain(reads);
  });

  it("makes an edit beside kept text its named style also formats", () => {
    let tab = styledTab([
      para("Before"),
      { runs: [{ text: "Bold", style: { bold: true } }, " here\n"], namedStyleType: "HEADING_2" },
      heading("Plain here", 2),
      para("After"),
    ]);
    // The kept text reads as it did.
    expect(appliedReplacement(tab, "**Bold** here", "**Bold** there").rendering.markdown)
      .toContain("## **Bold** there\n");
    expect(appliedReplacement(tab, "Plain here", "**Plain** there").rendering.markdown)
      .toContain("## Plain there\n");
  });

  it("drops it from text written into a cell, and a row change queued behind it applies", () => {
    for (let [oldMarkdown, newMarkdown] of [
      ["<h6>Cell notes</h6>", "<h6><em>Cell</em> notes</h6>"],
      ["<h2>Cell results</h2>", "<h2><strong>Cell</strong> <em>results</em></h2>"],
      ["<p>a</p>", "<p><strong>a</strong></p>"],
    ]) {
      let { rendering, applied } = appliedReplacement(cells(), oldMarkdown, newMarkdown, true);
      appliedChange(applied, addRows(rendering, 0, 2, [["x", "y"]]));
    }
    let { rendering } = appliedReplacement(
      cells(), "<h6>Cell notes</h6>", "<h6><em>Cell</em> notes</h6>", true);
    expect(tableAt(rendering, 0)).toContain("<h6>Cell notes</h6>");
  });

  it("sends bold written over a cell heading's explicit bold: false, which reads the same", () => {
    let unbolded = styledTab([
      para("Before"),
      { table: [[cellOf({ runs: [{ text: "Title", style: { bold: false } }, "\n"], namedStyleType: "HEADING_2" })]] },
      para("After"),
    ]);
    let before = docTabToMarkdown(unbolded);
    let oldMarkdown = "<h2>Title</h2>";
    let newMarkdown = "<h2><strong>Title</strong></h2>";
    let requests = textReplacementRequests(
      before, { ...replacementIn(before.markdown, oldMarkdown, newMarkdown), inTable: true });
    expect(requests).toContainEqual({
      updateTextStyle: expect.objectContaining({ textStyle: { bold: true }, fields: "bold" }),
    });
    let { rendering, applied } = appliedReplacement(unbolded, oldMarkdown, newMarkdown, true);
    // Google stores the bold as the heading's own, so the text turns bold and reads as it did.
    expect(cellParagraph(applied, 0, 0).paragraph.elements[0].textRun?.textStyle?.bold)
      .toBeUndefined();
    expect(tableAt(rendering, 0)).toContain("<h2>Title</h2>");
  });

  it("reads a word left with no link by the styles that request writes, and a row change applies", () => {
    let linked = styledTab([
      para("Before"),
      {
        table: [
          [cellOf({
            runs: [{ text: "Cell", style: { bold: true, link: { url: "https://example.com/" } } }, " results\n"],
            namedStyleType: "HEADING_2",
          })],
          ["a\n"],
        ],
      },
      para("After"),
    ]);
    let { rendering, applied } = appliedReplacement(
      linked, '<h2><a href="https://example.com/"><strong>Cell</strong></a> results</h2>',
      "<h2><strong>Cell</strong> results</h2>", true);
    expect(tableAt(rendering, 0)).toContain("<h2>Cell results</h2>");
    appliedChange(applied, addRows(rendering, 0, 2, [["x"]]));
  });

  it("reads a cell's title and level-one heading each by its own named style", () => {
    let title: ParagraphSpec = { runs: ["Notes here\n"], namedStyleType: "TITLE" };
    let tab = () => styledTab([
      para("Before"),
      { table: [[cellOf(title), cellOf(heading("Cell results", 1))], ["a\n", "b\n"]] },
      para("After"),
    ], {
      styles: [
        { namedStyleType: "NORMAL_TEXT", textStyle: { bold: false } },
        { namedStyleType: "TITLE", textStyle: { bold: true } },
      ],
    });
    // Bold written into the bold title is its style's, and into the plain heading the text's own.
    for (let [oldMarkdown, newMarkdown, reads] of [
      ["<h1>Notes here</h1>", "<h1><strong>Notes here</strong></h1>", "<h1>Notes here</h1>"],
      ["<h1>Cell results</h1>", "<h1><strong>Cell</strong> results</h1>",
        "<h1><strong>Cell</strong> results</h1>"],
    ]) {
      let { rendering, applied } = appliedReplacement(tab(), oldMarkdown, newMarkdown, true);
      expect(tableAt(rendering, 0)).toContain(reads);
      appliedChange(applied, addRows(rendering, 0, 2, [["x", "y"]]));
    }
  });

  it("reads a paragraph a replacement gives another style by that style, as Google does", () => {
    // A Heading 6, italic by its style, written as normal text keeps its italic.
    let { rendering, applied } = appliedReplacement(
      body(), "###### Notes here", "*Notes* here");
    expect(rendering.markdown).toContain("\n*Notes* here\n");
    appliedReplacement(body(), "## Results here", "**Results** here");
    appliedReplacement(body(), "###### Notes here", "## *Notes* **here**");
    // A table placed after the paragraph as the read shows it finds it once Google applies it.
    appliedChange(applied, newTable([["a"]], "\n*Notes* here\n"));
  });

  it("reads a paragraph written before or after a styled one by the style it is written with", () => {
    // A bold subtitle, with a bold paragraph written in front of it.
    let bold = styledTab([para("Before"), { runs: ["Notes here\n"], namedStyleType: "SUBTITLE" }, para("After")], {
      styles: [
        { namedStyleType: "NORMAL_TEXT", textStyle: { bold: false } },
        { namedStyleType: "SUBTITLE", textStyle: { bold: true } },
      ],
    });
    let { rendering, applied } = appliedReplacement(bold, "Notes here", "**Intro**\n\nNotes here");
    expect(rendering.markdown).toContain("\n**Intro**\n\nNotes here\n");
    appliedChange(applied, newTable([["a"]], "\n**Intro**\n"));
    appliedReplacement(bold, "Notes here", "Notes here\n\n**Outro**");
    appliedReplacement(bold, "Notes here", "**Notes** here");
    appliedReplacement(bold, "Notes here", "**Intro**\n\n**Notes** here");
  });

  it("makes formatting a subtitle's style reads otherwise", () => {
    let styles = {
      styles: [
        { namedStyleType: "NORMAL_TEXT", textStyle: { bold: false } },
        { namedStyleType: "SUBTITLE", textStyle: { bold: true } },
      ],
    };
    let tab = styledTab(aroundSubtitle("Notes here"), styles);
    appliedReplacement(tab, "Notes here", "**Notes here**");
    appliedReplacement(tab, "Notes here", "*Notes* here");
  });

  it("reads a subtitle as italic only where its named style makes it so", () => {
    let subtitle: ParagraphSpec = { runs: ["Sub\n"], namedStyleType: "SUBTITLE" };
    expect(docTabToMarkdown(styledTab([subtitle])).markdown).toBe("Sub\n");
    expect(docTabToMarkdown(styledTab([subtitle], {
      styles: [{ namedStyleType: "SUBTITLE", textStyle: { italic: true } }],
    })).markdown).toBe("*Sub*\n");
    expect(docTabToMarkdown(buildTab([subtitle])).markdown).toBe("*Sub*\n");
    appliedReplacement(styledTab([para("Before"), subtitle]), "Sub", "Subtitle");
    appliedReplacement(styledTab([para("Before"), subtitle]), "Sub", "*Sub*title");
  });
});

describe("the refusals a table causes beside it", () => {
  it("answers every way of reaching a table from outside with the one refusal", () => {
    // Text at an edge that is whole paragraphs, and text that is not.
    for (let newMarkdown of ["Intro\n\n<table>", "Intro <table>", "- X\n\n\n<table>"]) {
      expect(textRefusal(BTA(), "<table>", newMarkdown)).toBe(refusedBeside("before"));
    }
    for (let newMarkdown of ["</table>\n\nCaption", "</table>X", "</table>\nCaption"]) {
      expect(textRefusal(BTA(), "</table>", newMarkdown)).toBe(refusedBeside("after"));
    }

    // The paragraph beside the table removed with the table's blank line.
    for (let [oldMarkdown, newMarkdown] of [
      ["B\n\n", ""], ["B\n\n<table>", "<table>"], ["A\n\nB\n\n<table>", "A\n\n<table>"],
    ]) {
      expect(textRefusal(ABTAT(), oldMarkdown, newMarkdown)).toBe(refusedBeside("before"));
    }
    expect(textRefusal(ABTAT(), "\n\nAfter", "")).toBe(refusedBeside("after"));
    let todo = buildTab([para("A"), para("<TODO>"), grid(["a"]), para("After")]);
    expect(textRefusal(todo, "<TODO>\n\n<table>", "<table>")).toBe(refusedBeside("before"));
    let listed = buildTab([item("item"), para("Bee"), grid(["a"]), para("After")], ALL_LISTS);
    expect(textRefusal(listed, "Bee\n\n", "")).toBe(refusedBeside("before"));

    // The paragraph Google Docs keeps beside a table: between two tables, where the table
    // opens or ends the tab, and after a table of contents.
    let twoTables = TWO_TABLES("");
    expect(textRefusal(twoTables, "</table>\n\n\n\n<table>", "</table>\n\n<table>"))
      .toBe(refusedBeside("before"));
    let titled = buildTab([para("Title"), grid(["a"]), para("After")]);
    expect(textRefusal(titled, "Title\n\n<table>", "<table>")).toBe(refusedBeside("before"));
    expect(textRefusal(titled, "\n\nAfter", "")).toBe(refusedBeside("after"));
    let contents = buildTab([para("Before"), toc, para("Mid"), grid(["a"]), para("After")]);
    expect(textRefusal(contents, "Mid\n\n<table>", "<table>")).toBe(refusedBeside("before"));
    let first = buildTab([grid(["a"]), para("After")]);
    expect(textRefusal(first, "<table>", "Intro\n\n<table>")).toBe(refusedBeside("before"));

    // A read-only paragraph beside the table, or on the far side of the paragraph beside it.
    for (let [oldMarkdown, newMarkdown] of [
      ["<table>", "Intro\n\n<table>"],
      ["Owner: Ana\n\n<table>", "Owner: Ana\n\nIntro\n\n<table>"],
      ["Owner: Ana\n", "Owner: Ana\n\nIntro\n"],
      ["<table>", "Intro <table>"],
      ["Owner: Ana\n\n<table>", "<table>"],
    ]) {
      expect(textRefusal(CHIP_TABLE_DUE(), oldMarkdown, newMarkdown)).toBe(refusedBeside("before"));
    }
    expect(textRefusal(CHIP_TABLE_DUE(), "</table>", "</table>\n\nCaption"))
      .toBe(refusedBeside("after"));
    expect(textRefusal(CHIP_TABLE_DUE(), "\n\nDue Nov 8, 2026", "")).toBe(refusedBeside("after"));
    let emptyBelow = buildTab([para("Before"), grid(["a"]), para(""), dateChip()]);
    expect(textRefusal(emptyBelow, "</table>", "</table>\n\nCaption")).toBe(refusedBeside("after"));
    expect(textRefusal(CHIP_B_TABLE_AFTER_DUE(), "B\n\n", "")).toBe(refusedBeside("before"));
    expect(textRefusal(CHIP_B_TABLE_AFTER_DUE(), "\n\nAfter", "")).toBe(refusedBeside("after"));

    // Behind an edit that removed the paragraph beside the table, which stays as an empty one.
    let headless = emptied(titled, "Title");
    expect(read(headless).markdown.startsWith("\n\n<table>")).toBe(true);
    expect(textRefusal(headless, "<table>", "Intro\n\n<table>")).toBe(refusedBeside("before"));
    let tailless = emptied(titled, "After");
    expect(read(tailless).markdown.endsWith("</table>\n\n\n")).toBe(true);
    expect(textRefusal(tailless, "</table>", "</table>\n\nCaption")).toBe(refusedBeside("after"));
    let between = read(emptied(TWO_TABLES("Mid"), "Mid"));
    let above = replacementIn(
      between.markdown, "<table>", "Intro\n\n<table>", between.markdown.lastIndexOf("<table>"));
    let below = replacementIn(
      between.markdown, "</table>", "</table>\n\nCaption", between.markdown.indexOf("</table>"));
    expect(thrownMessage(() => textReplacementRequests(between, above))).toBe(refusedBeside("before"));
    expect(thrownMessage(() => textReplacementRequests(between, below))).toBe(refusedBeside("after"));
  });

  it("names the paragraph on that side of the table, in both of its spellings", () => {
    // The line breaks of each example reach the caller as a backslash and an `n`.
    expect(refusedBeside("before")).toBe(
      "replaceText: this replacement changes a table together with what is before it, or the " +
      "blank line between them. Write text that goes above a table as a change to the paragraph " +
      "before it: end oldMarkdown at that paragraph's last character and leave the blank line " +
      "and the table out. Where that paragraph is empty (an empty line above the table's blank " +
      "line), quote the empty line with the blank line and the table's first characters, keep " +
      "them unchanged in newMarkdown, and put the text on the empty line: \"\\n\\n<table\" " +
      "becomes \"Text\\n\\n<table\". Change the text inside one table in a call of its own; add " +
      "a table with insertTable() and remove one with deleteTable().");
    expect(refusedBeside("after")).toBe(
      "replaceText: this replacement changes a table together with what is after it, or the " +
      "blank line between them. Write text that goes below a table as a change to the paragraph " +
      "after it: start oldMarkdown at that paragraph's first character and leave the table and " +
      "the blank line out. Where that paragraph is empty (an empty line below the table's blank " +
      "line), quote the table's last characters and the blank line with the empty line, keep " +
      "them unchanged in newMarkdown, and put the text on the empty line: \"</table>\\n\\n\" " +
      "becomes \"</table>\\n\\nText\". Change the text inside one table in a call of its own; " +
      "add a table with insertTable() and remove one with deleteTable().");
  });

  it("removes the paragraph next to a table with the blank line on its other side", () => {
    for (let [oldMarkdown, newMarkdown] of [["\n\nB", ""], ["A\n\nB", "A"], ["After\n\n", ""]]) {
      expectAsConverter(ABTAT(), oldMarkdown, newMarkdown);
    }
    let todo = buildTab([para("A"), para("<TODO>"), grid(["a"]), para("After")]);
    expectAsConverter(todo, "\n\n<TODO>", "");

    // After a list item the request builder refuses that phrasing, in the paragraph path's
    // words, and the paragraph can be emptied.
    let listed = buildTab([item("item"), para("Bee"), grid(["a"]), para("After")], ALL_LISTS);
    let before = docTabToMarkdown(listed);
    let other = replacementIn(before.markdown, "\n\nBee", "");
    expect(thrownMessage(() => textReplacementRequests(before, other))).toBe(
      "replaceText: cannot keep a list item while deleting the paragraphs that end its " +
      "section. Delete them in an edit that leaves the list item alone.");
    expectAsConverter(listed, "Bee", "");

    // The only paragraph on its side of the table stays, and can be emptied.
    let titled = buildTab([para("Title"), grid(["a"]), para("After")]);
    for (let line of ["Title", "After"]) {
      expectAsConverter(titled, line, "");
    }

    // Beside a read-only paragraph the blank line on the other side is that paragraph's own.
    expect(textRefusal(CHIP_B_TABLE_AFTER_DUE(), "\n\nB", "")).toBe(CONVERTER_REFUSAL);
    expect(textRefusal(CHIP_B_TABLE_AFTER_DUE(), "After\n\n", "")).toBe(CONVERTER_REFUSAL);
    expectAsConverter(CHIP_B_TABLE_AFTER_DUE(), "B", "");
    expectAsConverter(CHIP_B_TABLE_AFTER_DUE(), "After", "");
    // A read-only paragraph itself is the paragraph path's to refuse.
    expect(textRefusal(CHIP_TABLE_DUE(), "Owner: Ana", "")).toBe(CONVERTER_REFUSAL);
    expect(textRefusal(CHIP_TABLE_DUE(), "Owner: Ana", "Owner: Ana\n\nIntro"))
      .toBe(CONVERTER_REFUSAL);
  });

  it("refuses a change to a table together with what is around it", () => {
    let whole = docTabToMarkdown(BTA()).markdown;
    expect(textRefusal(BTA(), whole, whole.replace("Before", "Earlier").replace("After", "Later")))
      .toBe(refusedBeside("around"));
    expect(textRefusal(BTA(), whole, "Rewritten\n")).toBe(refusedBeside("around"));
    expect(refusedBeside("around")).toBe(
      "replaceText: this replacement changes a table together with what is around it. Change " +
      "the text inside one table, or the paragraphs before and after it, in separate calls that " +
      "leave the table and the blank lines beside it out; add a table with insertTable() and " +
      "remove one with deleteTable().");
    // Part of a table with the text on one side of it, and a table removed whole with a blank
    // line beside it, name that side.
    expect(textRefusal(BTA(), "Before\n\n<table>\n  <tr>\n    <td><p>a", "X"))
      .toBe(refusedBeside("before"));
    expect(textRefusal(BTA(), `\n\n${tableAt(read(BTA()), 0)}\n\n`, "\n\n"))
      .toBe(refusedBeside("after"));
    expect(textRefusal(
      TWO_TABLES("Mid"), "a</p></td>\n  </tr>\n</table>\n\nMid\n\n<table>\n  <tr>\n    <td><p>b", "ab"))
      .toBe(refusedBeside("after"));
  });

  it("leaves the paragraph path's refusal where no table is the reason", () => {
    let before = read(buildTab([para("Before"), toc, chip(), grid(["a", "b"]), para("After")]));
    // The last is a record queued for a paragraph whose text has moved into a cell.
    for (let [oldMarkdown, newMarkdown] of [
      ["[Table of contents]", "[Contents]"], ["Owner: Ana", "Owner: Ben"], ["<p>a</p>", "<p>changed</p>"],
    ]) {
      let replacement = replacementIn(before.markdown, oldMarkdown, newMarkdown);
      let error = thrown(() => textReplacementRequests(before, replacement));
      expect(error).toBeInstanceOf(StructuredContentError);
      expect(error).toHaveProperty("message", CONVERTER_REFUSAL);
    }
  });

  it("refuses a record queued for text in a table whose text is no longer in one", () => {
    let before = docTabToMarkdown(BTA());
    let stored = { ...replacementIn(before.markdown, "Before", "Earlier"), inTable: true as const };
    let refused = "replaceText: this change was queued for text in a table, and that text is no " +
      "longer in one.";
    expect(thrownMessage(() => textReplacementRequests(before, stored))).toBe(refused);
  });
});

/** What `run` throws, whatever it is. */
function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("Expected a refusal");
}

// ---------------------------------------------------------------------------
// The ends of the tab
// ---------------------------------------------------------------------------

describe("the ends of the tab", () => {
  const T = tableHtml([["t"]]);

  it("keeps a removed last paragraph as an empty one, which a table change behind it finds", () => {
    let tab = emptied(buildTab([para("Before"), grid(["x"]), para("After")]), "After");
    expect(read(tab).markdown.endsWith("</table>\n\n\n")).toBe(true);
    appliedChange(tab, newTable([["t"]]));
    appliedChange(tab, newTable([["t"]], "x"));
    let deleted = appliedChange(tab, dropTable(read(tab), 0));
    expect(docTabToMarkdown(deleted).markdown).toBe("Before\n\n\n");
  });

  it("keeps a removed first paragraph as an empty one, which a table change behind it finds", () => {
    let tab = emptied(buildTab([para("Title"), grid(["x"]), para("After")]), "Title");
    expect(read(tab).markdown.startsWith("\n\n<table>")).toBe(true);
    let deleted = appliedChange(tab, dropTable(read(tab), 0));
    expect(docTabToMarkdown(deleted).markdown).toBe("\n\nAfter\n");
    appliedChange(tab, newTable([["t"]], "x"));
    appliedChange(tab, addRows(read(tab), 0, 1, [["y"]]));
  });

  it("reads the empty lines that end a tab as its paragraphs", () => {
    let quiet = item("", "Q1");
    let withTable = () => buildTab([para("X"), grid(["x"]), quiet, quiet], ALL_LISTS);
    let content = read(withTable());
    expect(content.markdown.endsWith("</table>\n\n\n\n")).toBe(true);
    let deleted = appliedChange(withTable(), dropTable(content, 0));
    expect(docTabToMarkdown(deleted).markdown).toBe("X\n\n\n\n");

    let items = () => buildTab([para("X"), quiet, quiet], ALL_LISTS);
    expect(read(items()).markdown).toBe("X\n\n\n\n");
    let added = appliedChange(items(), newTable([["t"]]));
    expect(docTabToMarkdown(added).markdown).toBe(`X\n\n\n\n\n${T}\n\n\n`);
  });
});

// ---------------------------------------------------------------------------
// Behind an append
// ---------------------------------------------------------------------------

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
      let written = applyDocEdit(tab, { type: "appendText", markdown: text });
      let simulated = renderTab(written);
      expect(simulated.markdown.startsWith(before.markdown)).toBe(true);
      expect(simulated.markdown).not.toBe(before.markdown);

      // A row for the table, recorded from the read behind the append, lands in it.
      let rows = addRows(simulated, 0, 1, [["new", "row"]]);
      expect(resolveTable(simulated, refOf(before, 0), rows.type)).toBe(0);
      appliedChange(written, rows);
    }
  });
});

// ---------------------------------------------------------------------------
// Chains
// ---------------------------------------------------------------------------

/** One step of a sequence: a table change, or a replacement found at `matchStart`. */
type Step = TableChange | (TextReplacement & { type: "replaceText"; inTable?: true });

/** A step made in the model's document, alike under every model behaviour, and its rendering. */
function advance(tab: GoogleDocsTab, step: Step): { tab: GoogleDocsTab; content: DocTabSnapshot } {
  let before = docTabToMarkdown(tab);
  let applied = appliedOneWay(tab, step.type === "replaceText"
    ? textReplacementRequests(before, step) : tableChangeRequests(before, step));
  return { tab: applied, content: docTabToMarkdown(applied) };
}

/** A replacement of the `index`-th editable text of a table's cell by `html`. */
function cellReplacement(
  content: DocTabSnapshot, table: number, row: number, column: number, html: string,
): Step | undefined {
  let target = content.sourceMap.tables[table];
  let text = target.rows[row]?.cells[column]?.texts[0];
  if (!text) return undefined;
  return {
    type: "replaceText", matchStart: text.mdStart, inTable: true,
    oldMarkdown: content.markdown.slice(text.mdStart, text.mdEnd), newMarkdown: html,
  };
}

describe("chains of changes", () => {
  it("reads as the document does after every step of a table's life", () => {
    let tab = buildTab([para("Before"), para("After")]);
    let state = { tab, content: read(tab) };
    state = advance(state.tab, newTable([["a", "b"], ["c", "d"]], "Before"));
    state = advance(state.tab, addRows(state.content, 0, 1, [["new", "row"]]));
    let fill = cellReplacement(state.content, 0, 2, 1, "<strong>filled</strong> &amp; done");
    if (!fill) throw new Error("Expected an editable text");
    state = advance(state.tab, fill);
    state = advance(state.tab, addColumns(state.content, 0, 2, [["x"], ["y"], ["z"]]));
    state = advance(state.tab, dropColumns(state.content, 0, 0));
    state = advance(state.tab, dropRows(state.content, 0, 0));
    expect(tableAt(state.content, 0)).toBe(
      "<table>\n  <tr>\n    <td><p>row</p></td>\n    <td><p>y</p></td>\n  </tr>\n  <tr>\n" +
      "    <td><p><strong>filled</strong> &amp; done</p></td>\n    <td><p>z</p></td>\n  </tr>\n</table>");
    state = advance(state.tab, dropTable(state.content, 0));
    expect(state.content.markdown).toBe("Before\n\n\n\nAfter\n");
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
      let applied = appliedChange(tab, addRows(read(tab), 0, at, cells.map(row => [...row])));
      let html = tableAt(read(applied), 0);
      let reference = Math.min(at, 2);
      let copies = html.split(SHADED_TAG).length - 1;
      expect(copies, `at ${at}`).toBe(reference === 1 ? 1 + cells.length : 1);
      expect(html.split('<tr style="height:40pt">').length - 1).toBe(reference === 1 ? 1 + cells.length : 1);
    }
  });

  it("gives added columns the look and width of the column they copy, and keeps fixed widths", () => {
    let tab = styled();
    let applied = appliedChange(tab, addColumns(read(tab), 0, 1, [["n"], [""], [""]]));
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
    applied = appliedChange(tab, atEnd);
    expect(tableAt(read(applied), 0)).toContain(
      '  <colgroup><col><col style="width:120pt"><col><col></colgroup>');
  });

  it("takes the look of deleted rows and columns away with them", () => {
    let tab = styled();
    let applied = appliedChange(tab, dropColumns(read(tab), 0, 1));
    let html = tableAt(read(applied), 0);
    expect(html).not.toContain("<colgroup>");
    expect(html).toContain('<td style="border-left:2pt solid #ff0000"><p>f</p></td>');
    applied = appliedChange(tab, dropRows(read(tab), 0, 1));
    expect(tableAt(read(applied), 0)).not.toContain("height:40pt");
    expect(tableAt(read(applied), 0)).toContain('<td style="border-top:3pt dashed #0000ff"><p>h</p></td>');
  });

  it("writes the table's own style again when an added row changes what most cells share", () => {
    let shaded = { tableCellStyle: { backgroundColor: { color: { rgbColor: { green: 1 } } } } };
    let tab = buildTab([para("Before"), {
      table: [
        [{ paragraphs: [para("a")], ...shaded }, { paragraphs: [para("b")], ...shaded }],
        ["c\n", "d\n"],
      ],
    }, para("After")]);
    expect(tableAt(read(tab), 0).startsWith("<table>\n")).toBe(true);
    let applied = appliedChange(tab, addRows(read(tab), 0, 0, [["x", "y"]]));
    expect(tableAt(read(applied), 0)).toContain(
      '<table style="background-color:#00ff00">\n  <tr>\n    <td><p>x</p></td>');
  });

  it("keeps a table Google adds plain, though it stores every default", () => {
    let tab = buildTab([para("Before"), para("After")]);
    let applied = appliedChange(tab, newTable([["a", "b"]], "Before"));
    expect(tableAt(read(applied), 0).startsWith("<table>\n  <tr>\n    <td><p>a</p></td>")).toBe(true);
    expect(JSON.stringify(applied.body.content)).toContain('"paddingTop":{"magnitude":5');
  });
});

describe("setting the look of a table's cells", () => {
  const grid3 = (): GoogleDocsTab => buildTab([para("Before"), grid(["a", "b", "c"], ["d", "e", "f"], ["g", "h", "i"]), para("After")]);
  const styleChange = (
    content: DocTabSnapshot, row: number, column: number, rows: number, columns: number,
    style: Extract<TableChange, { type: "setTableCellStyle" }>["style"],
  ): TableChange => ({ type: "setTableCellStyle", row, column, rows, columns, style, ...refOf(content, 0) });

  it("shades, aligns and pads a block, and clears shading, as Google does", () => {
    let tab = grid3();
    let shaded = appliedChange(tab, styleChange(read(tab), 0, 0, 2, 2,
      { background: "#ffcc00", verticalAlign: "middle", padding: { top: "8pt", left: "0.5pt" } }));
    let html = tableAt(read(shaded), 0);
    expect(html).toContain('<td style="background-color:#ffcc00;vertical-align:middle;padding-top:8pt;padding-left:0.5pt"><p>a</p></td>');
    expect(html).toContain("<td><p>c</p></td>");
    let cleared = appliedChange(shaded, styleChange(read(shaded), 0, 0, 1, 2, { background: "transparent" }));
    expect(tableAt(read(cleared), 0)).toContain('<td style="vertical-align:middle;padding-top:8pt;padding-left:0.5pt"><p>a</p></td>');
  });

  it("draws a border on both cells of an edge they share, the later write winning", () => {
    let tab = grid3();
    let right = appliedChange(tab, styleChange(read(tab), 1, 1, 1, 1, { borders: { right: "3pt solid #ff0000" } }));
    let html = tableAt(read(right), 0);
    expect(html).toContain('<td style="border-right:3pt solid #ff0000"><p>e</p></td>');
    expect(html).toContain('<td style="border-left:3pt solid #ff0000"><p>f</p></td>');
    let over = appliedChange(right, styleChange(read(right), 1, 2, 1, 1, { borders: { left: "none" } }));
    expect(tableAt(read(over), 0)).toContain('<td style="border-right:none"><p>e</p></td>');
  });

  it("sets every edge with border, and the block's outer and inner edges with borders", () => {
    let tab = grid3();
    let all = appliedChange(tab, styleChange(read(tab), 0, 0, 3, 3, { border: "2pt dashed #0000ff" }));
    expect(tableAt(read(all), 0).startsWith('<table style="border:2pt dashed #0000ff">\n')).toBe(true);
    for (let edges of [
      { top: "1pt dotted #ff0000", bottom: "none" }, { left: "4pt solid #00ff00", right: "0.25pt solid #123456" },
      { innerHorizontal: "none" }, { innerVertical: "3pt solid #000000", top: "none" },
    ]) {
      appliedChange(tab, styleChange(read(tab), 0, 1, 2, 2, { borders: edges }));
      appliedChange(all, styleChange(read(all), 1, 0, 2, 3, { border: "none", borders: edges }));
    }
  });

  it("styles a merged cell whole, reading its edges where Google keeps them", () => {
    let tab = buildTab([para("Before"), { table: [
      ["a\n", "b\n", "c\n"],
      ["d\n", { paragraphs: [para("e")], tableCellStyle: { rowSpan: 2, columnSpan: 2 } }, "\n"],
      ["g\n", "\n", "\n"],
    ] }, para("After")]);
    let applied = appliedChange(tab, styleChange(read(tab), 1, 1, 2, 2,
      { background: "#00ff00", borders: { right: "2pt solid #ff0000", bottom: "3pt solid #0000ff", top: "none" } }));
    expect(tableAt(read(applied), 0)).toContain(
      '<td rowspan="2" colspan="2" style="background-color:#00ff00;border-top:none;' +
      'border-right:2pt solid #ff0000;border-bottom:3pt solid #0000ff"><p>e</p></td>');
    appliedChange(tab, styleChange(read(tab), 0, 0, 3, 3, { border: "1pt solid #cccccc" }));
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
});

describe("setting a table's column widths and row heights", () => {
  const sized = (): GoogleDocsTab => buildTab([para("Before"), {
    ...grid(["a", "b", "c"], ["d", "e", "f"]), headerRows: 1, columns: [null, 80, null], heights: [0, 24],
  }, para("After")]);
  const widths = (content: DocTabSnapshot, at: number, count: number, width: number | null): TableChange =>
    ({ type: "setTableColumnWidths", at, count, width, ...refOf(content, 0) });
  const heights = (content: DocTabSnapshot, at: number, count: number, height: number): TableChange =>
    ({ type: "setTableRowHeights", at, count, height, ...refOf(content, 0) });

  it("sets columns fixed or sharing the rest, leaving the others, as Google does", () => {
    let tab = sized();
    let fixed = appliedChange(tab, widths(read(tab), 0, 1, 93.333));
    expect(tableAt(read(fixed), 0)).toContain('<colgroup><col style="width:93.333pt"><col style="width:80pt"><col></colgroup>');
    let even = appliedChange(fixed, widths(read(fixed), 0, 2, null));
    expect(tableAt(read(even), 0)).not.toContain("<colgroup>");
  });

  it("sets rows' least heights, and keeps a pinned header row pinned", () => {
    let tab = sized();
    let applied = appliedChange(tab, heights(read(tab), 0, 2, 30));
    expect(tableAt(read(applied), 0).split('<tr style="height:30pt">').length - 1).toBe(2);
    expect(pinnedHeaderRows(applied, docTabToMarkdown(applied).sourceMap.tables[0].docStart)).toBe(1);
    let fitted = appliedChange(applied, heights(read(applied), 1, 1, 0));
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
  const merge = (content: DocTabSnapshot, row: number, column: number, rows: number, columns: number): TableChange =>
    ({ type: "mergeTableCells", row, column, rows, columns, ...refOf(content, 0) });
  const split = (content: DocTabSnapshot, row: number, column: number): TableChange =>
    ({ type: "unmergeTableCells", row, column, ...refOf(content, 0) });
  const table = (...rows: CellSpec[][]): GoogleDocsTab =>
    buildTab([para("Before"), { table: rows, heights: [0, 24, 0] }, para("After")]);

  it("keeps which of the joined paragraphs are titles", () => {
    const title = (text: string): ParagraphSpec => ({ runs: [`${text}\n`], namedStyleType: "TITLE" });
    let tab = table(
      [cellOf(title("One"), para("x")), cellOf(para("z"), title("Two")), "y\n"],
      ["a\n", "b\n", "c\n"],
      ["d\n", "e\n", "f\n"]);
    let applied = appliedChange(tab, merge(read(tab), 0, 0, 1, 2));
    expect((cellAt(applied, 0, 0).content ?? [])
      .map(element => element.paragraph?.paragraphStyle.namedStyleType === "TITLE"))
      .toEqual([true, false, false, true]);
  });

  it("joins the cells' paragraphs into the top-left cell, row by row, as Google does", () => {
    let tab = table(
      [cellOf(heading("Head", 3), para("x2")), "y\n", "\n"],
      ["\n", cellOf(para("z1"), para("z2")), "c\n"],
      ["d\n", "e\n", "f\n"]);
    let applied = appliedChange(tab, merge(read(tab), 0, 0, 2, 2));
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
    let applied = appliedChange(tab, merge(read(tab), 0, 0, 1, 2));
    expect(tableAt(read(applied), 0)).toContain('<td colspan="2" style="background-color:#ff0000;padding-top:10pt">\n      <p>a</p>\n      <p>b</p>');
    appliedChange(tab, merge(read(tab), 1, 0, 2, 3));
  });

  it("merges a block that holds a merged cell whole, and empty cells into one empty paragraph", () => {
    let tab = table(
      [{ paragraphs: [para("ab")], tableCellStyle: { columnSpan: 2 } }, "\n", "\n"],
      ["c\n", "d\n", "\n"],
      ["\n", "\n", "\n"]);
    appliedChange(tab, merge(read(tab), 0, 0, 2, 2));
    let applied = appliedChange(tab, merge(read(tab), 2, 0, 1, 3));
    expect(tableAt(read(applied), 0)).toContain('<td colspan="3"><p></p></td>');
    expect(refusal(tab, merge(read(tab), 0, 1, 2, 2))).toBe(
      "mergeTableCells: the cells named take in part of the merged cell at row 0, column 0 " +
      "(counting from 0), which Google Docs styles as a whole. Name all of its cells or none of them.");
  });

  it("reads a merged block's outer edges through a merged cell it holds on that edge", () => {
    // The block's right edge runs through a merged cell whose right edge is blue.
    let edge = (red: number, blue: number) =>
      ({ width: pt(2), dashStyle: "SOLID", color: { color: { rgbColor: { red, blue } } } });
    let tab = buildTab([para("Before"), { table: [
      [{ paragraphs: [para("a")], tableCellStyle: { borderRight: edge(1, 0) } },
        { paragraphs: [para("bc")], tableCellStyle: { columnSpan: 2 } },
        { paragraphs: [para("")], tableCellStyle: { borderRight: edge(0, 1) } }],
      ["d\n", "e\n", "f\n"],
    ] }, para("After")]);
    expect(tableAt(read(tab), 0)).toContain('<td colspan="2" style="border-right:2pt solid #0000ff">');
    let applied = appliedChange(tab, merge(read(tab), 0, 0, 1, 3));
    expect(tableAt(read(applied), 0)).toContain('<td colspan="3" style="border-right:2pt solid #0000ff">');
    let tall = buildTab([para("Before"), { table: [
      ["a\n", "b\n"],
      [{ paragraphs: [para("cd")], tableCellStyle: { columnSpan: 2, borderBottom: edge(0, 1) } }, "\n"],
    ] }, para("After")]);
    appliedChange(tall, merge(read(tall), 0, 0, 2, 2));
  });

  it("splits a merged cell, its text staying in the top-left cell and the others empty", () => {
    let tab = table(
      [{ paragraphs: [para("ab"), para("cd")], tableCellStyle: { rowSpan: 2, columnSpan: 2, backgroundColor: { color: { rgbColor: { green: 1 } } } } },
        { paragraphs: [para("")], tableCellStyle: { borderRight: { width: pt(3), dashStyle: "SOLID", color: { color: { rgbColor: { red: 1 } } } } } }, "x\n"],
      ["\n", "\n", "y\n"],
      ["g\n", "h\n", "i\n"]);
    let applied = appliedChange(tab, split(read(tab), 0, 0));
    let html = tableAt(read(applied), 0);
    expect(html).toContain("<p>ab</p>\n      <p>cd</p>");
    expect(html.split("background-color:#00ff00").length - 1).toBe(4);
    // The restored cells take text like any other.
    let row = '<tr style="height:24pt">\n    <td style="background-color:#00ff00"><p>';
    appliedCellText(applied, `${row}</p>`, `${row}new</p>`);
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

    let nested = buildTab([para("Before"), { table: [
      ["a\n", cellOf(para("x"), grid(["in"]), para("y"))],
    ] }, para("After")]);
    expect(refusal(nested, merge(read(nested), 0, 0, 1, 2))).toBe(
      "mergeTableCells: the cell at row 0, column 1 (counting from 0) holds a table, a footnote, a " +
      "smart chip or an element getContent() does not show, which merging cells does not support.");
  });

  it("refuses to merge cells that anchor a positioned image, whose anchor no merge has kept", () => {
    const anchored = (row: number, column: number, ...cells: CellSpec[]) => {
      let tab = buildTab([para("Before"), { table: [cells, ["c\n", "d\n"]] }, para("After")]);
      let paragraph = cellAt(tab, row, column).content?.[0]?.paragraph;
      if (!paragraph) throw new Error("Expected a paragraph");
      paragraph.positionedObjectIds = ["object"];
      return tab;
    };
    const refused = (column: number) => `mergeTableCells: the cell at row 0, column ${column} ` +
      "(counting from 0) holds a positioned image, whose anchor merging cells is not known to " +
      "keep. Merge these cells in Google Docs.";
    // An image anchored to an otherwise empty cell, to a cell with text, and to the top-left cell.
    for (let [column, tab] of [
      [1, anchored(0, 1, "Label\n", "\n")], [1, anchored(0, 1, "Label\n", "Caption\n")],
      [0, anchored(0, 0, "\n", "Label\n")],
    ] as const) {
      expect(tableAt(read(tab), 0)).toContain("[Image]");
      expect(thrownMessage(() => applyDocEdit(tab, merge(read(tab), 0, 0, 1, 2)))).toBe(refused(column));
      // The model refuses it too, for a document that came to hold the image after the check.
      let plain = structuredClone(tab);
      for (let row of plain.body.content.find(element => element.table)?.table?.tableRows ?? []) {
        for (let cell of row.tableCells ?? []) delete cell.content?.[0]?.paragraph?.positionedObjectIds;
      }
      let requests = tableChangeRequests(docTabToMarkdown(plain), merge(read(plain), 0, 0, 1, 2));
      expect(thrownMessage(() => applyDocsRequests(tab, requests)))
        .toContain("merging cells that anchor a positioned object");
      // Cells beside the anchor still merge.
      expect(tableAt(read(applyDocEdit(tab, merge(read(tab), 1, 0, 1, 2))), 0)).toContain("[Image]");
    }
  });

  it("refuses to merge into a top-left cell that is an empty heading or list item", () => {
    for (let empty of [heading(""), item("")]) {
      let tab = buildTab([para("Before"), { table: [
        [cellOf(empty), "b\n"],
        [cellOf({ ...empty, runs: ["text\n"] }), "d\n"],
      ] }, para("After")], ALL_LISTS);
      expect(refusal(tab, merge(read(tab), 0, 0, 1, 2))).toBe(
        "mergeTableCells: the cell at row 0, column 0 (counting from 0) is an empty heading or " +
        "list item, which merging cells does not support. Give it text, or make it a plain paragraph.");
      // The same heading or list item with text is the top-left cell of a merge.
      appliedChange(tab, merge(read(tab), 1, 0, 1, 2));
    }
    // A cell of several lines is not one: two empty headings are merged, and both are kept.
    let two = buildTab([
      para("Before"), { table: [[cellOf(heading(""), heading("")), "b\n"]] }, para("After"),
    ]);
    let applied = appliedChange(two, merge(read(two), 0, 0, 1, 2));
    expect(tableAt(read(applied), 0))
      .toContain('<td colspan="2">\n      <h2></h2>\n      <h2></h2>\n      <p>b</p>\n    </td>');
  });
});
