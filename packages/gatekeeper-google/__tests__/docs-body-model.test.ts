import { describe, expect, it } from "vitest";
import type {
  GoogleDocsRequest, GoogleDocsTab, Paragraph, StructuralElement, TableCell, TableCellLocation,
  TableRow,
} from "../src/docs-api";
import { docTabToMarkdown } from "../src/markdown-converter";
import { BULLET_LIST, buildTab } from "./doc-fixture";
import {
  alignmentAt, applyDocsRequests, fontSizeAt, hasLinkLook, indentedParagraphs, LINK_COLOR,
  pinnedHeaderRows,
} from "./docs-body-model";
import type { ModelParagraphStyle, ModelTextStyle } from "./docs-body-model";

const TAB = "tab-1";
const LINK_A = { url: "https://a.example" };
const LINK_B = { url: "https://b.example" };
const CHIP_PLACEHOLDER = "\uE907";
const FOUR_FIELDS = "bold,italic,strikethrough,link";

const OUTSIDE_PARAGRAPH = "The insertion index must be inside the bounds of an existing paragraph.";
const INVALID_DELETION = "Invalid deletion range. Cannot delete the requested range.";
const EMPTY_RANGE = "The range should not be empty";

const at = (index: number) => ({ index, tabId: TAB });
const range = (startIndex: number, endIndex: number) => ({ startIndex, endIndex, tabId: TAB });
const cellAt = (table: number, rowIndex: number, columnIndex = 0): TableCellLocation =>
  ({ tableStartLocation: at(table), rowIndex, columnIndex });

const insertText = (index: number, text: string): GoogleDocsRequest =>
  ({ insertText: { location: at(index), text } });
const deleteRange = (start: number, end: number): GoogleDocsRequest =>
  ({ deleteContentRange: { range: range(start, end) } });
const styleText = (
  start: number, end: number, textStyle: ModelTextStyle, fields: string,
): GoogleDocsRequest => ({ updateTextStyle: { range: range(start, end), textStyle, fields } });
const styleParagraphs = (
  start: number, end: number, paragraphStyle: Record<string, unknown>, fields: string,
): GoogleDocsRequest =>
  ({ updateParagraphStyle: { range: range(start, end), paragraphStyle, fields } });
const deleteBullets = (start: number, end: number): GoogleDocsRequest =>
  ({ deleteParagraphBullets: { range: range(start, end) } });
const insertTable = (index: number, rows: number, columns: number): GoogleDocsRequest =>
  ({ insertTable: { rows, columns, location: at(index) } });
const insertRow = (table: number, rowIndex: number, insertBelow: boolean): GoogleDocsRequest =>
  ({ insertTableRow: { tableCellLocation: cellAt(table, rowIndex), insertBelow } });
const insertColumn = (
  table: number, columnIndex: number, insertRight: boolean,
): GoogleDocsRequest =>
  ({ insertTableColumn: { tableCellLocation: cellAt(table, 0, columnIndex), insertRight } });
const deleteRow = (table: number, rowIndex: number): GoogleDocsRequest =>
  ({ deleteTableRow: { tableCellLocation: cellAt(table, rowIndex) } });
const deleteColumn = (table: number, columnIndex: number): GoogleDocsRequest =>
  ({ deleteTableColumn: { tableCellLocation: cellAt(table, 0, columnIndex) } });
const pinRows = (table: number, pinnedHeaderRowsCount: number): GoogleDocsRequest =>
  ({ pinTableHeaderRows: { tableStartLocation: at(table), pinnedHeaderRowsCount } });

const points = (magnitude: number) => ({ magnitude, unit: "PT" as const });
const sized = (magnitude: number): ModelTextStyle => ({ fontSize: points(magnitude) });

type Span = [number, number];
const span = (part: { startIndex: number; endIndex: number }): Span =>
  [part.startIndex, part.endIndex];

function paragraphOf(element: StructuralElement | undefined): Paragraph {
  if (!element?.paragraph) throw new Error("Expected a paragraph");
  return element.paragraph;
}

/** The paragraphs of the tab's body, those of its tables left out. */
function bodyParagraphs(tab: GoogleDocsTab): Paragraph[] {
  return tab.body.content.flatMap(element => element.paragraph ? [element.paragraph] : []);
}

/** The `position`-th table of the tab's body. */
function tableElement(tab: GoogleDocsTab, position = 0): StructuralElement {
  let table = tab.body.content.filter(element => element.table)[position];
  if (!table) throw new Error("Expected a table");
  return table;
}

function rowsOf(tab: GoogleDocsTab, position = 0): TableRow[] {
  return tableElement(tab, position).table?.tableRows ?? [];
}

function cellsOf(tab: GoogleDocsTab, position = 0): TableCell[][] {
  return rowsOf(tab, position).map(row => row.tableCells ?? []);
}

function cellParagraphs(cell: TableCell): Paragraph[] {
  return (cell.content ?? []).map(paragraphOf);
}

function textOf(paragraph: Paragraph): string {
  return paragraph.elements.map(element => element.textRun?.content ?? "").join("");
}

/** A paragraph's text runs, each with the style it carries. */
function runsOf(paragraph: Paragraph): [string, ModelTextStyle][] {
  return paragraph.elements.flatMap((element): [string, ModelTextStyle][] =>
    element.textRun ? [[element.textRun.content, element.textRun.textStyle]] : []);
}

function modelStyle(paragraph: Paragraph): ModelParagraphStyle {
  return paragraph.paragraphStyle;
}

/** The texts of a table's cells, row by row, each cell's paragraphs joined. */
function tableTexts(tab: GoogleDocsTab, position = 0): string[][] {
  return cellsOf(tab, position).map(row =>
    row.map(cell => cellParagraphs(cell).map(textOf).join("")));
}

const markdownOf = (tab: GoogleDocsTab) => docTabToMarkdown(tab).markdown;

type ParagraphSpec = Extract<Parameters<typeof buildTab>[0][number], { runs: unknown }>;

/** A cell holding these paragraphs. */
function cellOf(...paragraphs: ParagraphSpec[]): { paragraphs: ParagraphSpec[] } {
  return { paragraphs };
}

describe("table geometry", () => {
  it("puts a table inserted at the start of a paragraph after a new empty paragraph", () => {
    let tab = buildTab([{ runs: ["Before\n"] }, { runs: ["After\n"] }]);
    let result = applyDocsRequests(tab, [insertTable(8, 2, 3)]);

    expect(result.body.content.map(span)).toEqual([[0, 1], [1, 8], [8, 9], [9, 25], [25, 31]]);
    expect(bodyParagraphs(result).map(textOf)).toEqual(["Before\n", "\n", "After\n"]);
    let [firstRow, secondRow] = rowsOf(result);
    expect(span(firstRow)).toEqual([10, 17]);
    expect(span(secondRow)).toEqual([17, 24]);
    let firstCell = cellsOf(result)[0][0];
    expect(span(firstCell)).toEqual([11, 13]);
    expect((firstCell.content ?? []).map(span)).toEqual([[12, 13]]);
    expect(tableTexts(result)).toEqual([["\n", "\n", "\n"], ["\n", "\n", "\n"]]);
  });

  it("takes text for every cell of a new table at the index its row and column give", () => {
    let tab = buildTab([{ runs: ["Before\n"] }, { runs: ["After\n"] }]);
    let rows = 2;
    let columns = 3;
    let tableStart = 9;
    let fills: GoogleDocsRequest[] = [];
    for (let row = rows - 1; row >= 0; row--) {
      for (let column = columns - 1; column >= 0; column--) {
        fills.push(insertText(
          tableStart + 3 + row * (1 + 2 * columns) + 2 * column, `r${row}c${column}`));
      }
    }
    let result = applyDocsRequests(tab, [insertTable(8, rows, columns), ...fills]);

    expect(tableTexts(result)).toEqual([
      ["r0c0\n", "r0c1\n", "r0c2\n"], ["r1c0\n", "r1c1\n", "r1c2\n"],
    ]);
  });

  it("starts a row added below the last row one index before the table's old end", () => {
    let tab = buildTab([{ runs: ["Before\n"] }, { runs: ["After\n"] }]);
    let withTable = applyDocsRequests(tab, [insertTable(8, 2, 3)]);
    let tableEnd = tableElement(withTable).endIndex;
    expect(tableEnd).toBe(25);

    let result = applyDocsRequests(withTable, [
      insertRow(9, 1, true), insertText(tableEnd + 1, "new"),
    ]);

    let newRow = rowsOf(result)[2];
    expect(newRow.startIndex).toBe(tableEnd - 1);
    expect(tableTexts(result)[2]).toEqual(["new\n", "\n", "\n"]);
    // An empty row is one index and two for each cell.
    expect(span(tableElement(result))).toEqual([9, 25 + 7 + 3]);
  });

  it("gives every row a cell of two indexes beside the named column", () => {
    let tab = buildTab([
      { runs: ["Before\n"] },
      { runs: ["\n"] },
      { table: [["\n", "\n"], ["r0c0\n", "r0c1\n"], ["\n", "\n"], ["r1c0\n", "r1c1\n"]] },
      { runs: ["After\n"] },
    ]);
    expect(span(tableElement(tab))).toEqual([9, 47]);

    let result = applyDocsRequests(tab, [insertColumn(9, 0, true)]);

    expect(cellsOf(result).map(row => span(row[1]))).toEqual([
      [13, 15], [24, 26], [35, 37], [46, 48],
    ]);
    expect(span(tableElement(result))).toEqual([9, 55]);
    expect(tableTexts(result)).toEqual([
      ["\n", "\n", "\n"], ["r0c0\n", "\n", "r0c1\n"], ["\n", "\n", "\n"],
      ["r1c0\n", "\n", "r1c1\n"],
    ]);
  });

  it("adds a row above or below the named row, and a column left or right of the named one", () => {
    let tab = buildTab([
      { runs: ["\n"] }, { table: [["a\n", "b\n"], ["c\n", "d\n"]] }, { runs: ["\n"] },
    ]);

    expect(tableTexts(applyDocsRequests(tab, [insertRow(2, 1, false)])))
      .toEqual([["a\n", "b\n"], ["\n", "\n"], ["c\n", "d\n"]]);
    expect(tableTexts(applyDocsRequests(tab, [insertRow(2, 1, true)])))
      .toEqual([["a\n", "b\n"], ["c\n", "d\n"], ["\n", "\n"]]);
    expect(tableTexts(applyDocsRequests(tab, [insertColumn(2, 1, false)])))
      .toEqual([["a\n", "\n", "b\n"], ["c\n", "\n", "d\n"]]);
    expect(tableTexts(applyDocsRequests(tab, [insertColumn(2, 1, true)])))
      .toEqual([["a\n", "b\n", "\n"], ["c\n", "d\n", "\n"]]);
    expect(tableTexts(applyDocsRequests(tab, [deleteRow(2, 0)]))).toEqual([["c\n", "d\n"]]);
    expect(tableTexts(applyDocsRequests(tab, [deleteColumn(2, 0)]))).toEqual([["b\n"], ["d\n"]]);
  });

  it("applies each request of a batch to what the one before it left", () => {
    let tab = buildTab([{ runs: ["\n"] }, { table: [["a\n"]] }, { runs: ["\n"] }]);
    // The table is [2, 8): its row is [3, 7), and a row added below it starts where it ends.
    let result = applyDocsRequests(tab, [
      insertRow(2, 0, true), insertRow(2, 1, true),
      insertText(12, "third"), insertText(9, "second"),
    ]);

    expect(tableTexts(result)).toEqual([["a\n"], ["second\n"], ["third\n"]]);
  });

  it("leaves the tab it is given as it was", () => {
    let tab = buildTab([{ runs: ["Before\n"] }, { runs: ["After\n"] }]);
    let copy = structuredClone(tab);
    applyDocsRequests(tab, [insertTable(8, 1, 1), insertText(1, "x")]);

    expect(tab).toEqual(copy);
  });
});

const threeRowTable = () => buildTab([
  { runs: ["Before\n"] },
  { table: [["ab\n", "cd\n"], ["\n", "\n"], ["\n", "\n"]] },
  { runs: ["After\n"] },
]);

// The table is [8, 29): row 0 [9, 18), cell (0,0) [10, 14) with its paragraph at 11, cell (0,1)
// [14, 18) with its paragraph at 15.
const refusal = (requests: GoogleDocsRequest[], tab = threeRowTable()) =>
  () => applyDocsRequests(tab, requests);

describe("what Google refuses", () => {
  it("refuses text at a cell's, a row's or a table's own index", () => {
    let message = `${OUTSIDE_PARAGRAPH} You can still create new paragraphs by inserting newlines.`;
    expect(span(cellsOf(threeRowTable())[0][0])).toEqual([10, 14]);
    expect(refusal([insertText(10, "x")])).toThrow(message);
    expect(refusal([insertText(9, "x")])).toThrow(message);
    expect(refusal([insertText(8, "x")])).toThrow(message);
  });

  it("refuses a deletion that starts in one cell and ends in the next", () => {
    expect(refusal([deleteRange(11, 16)])).toThrow(INVALID_DELETION);
  });

  it("refuses to delete a cell's final line break, a whole cell or a whole row", () => {
    expect(refusal([deleteRange(11, 14)])).toThrow(INVALID_DELETION);
    expect(refusal([deleteRange(10, 14)])).toThrow(INVALID_DELETION);
    expect(refusal([deleteRange(9, 18)])).toThrow(INVALID_DELETION);
  });

  it("refuses a deletion that crosses a table's edge without holding the whole table", () => {
    expect(refusal([deleteRange(5, 12)])).toThrow(INVALID_DELETION);
    expect(refusal([deleteRange(15, 33)])).toThrow(INVALID_DELETION);
  });

  it("refuses to delete the line break before a table, and the last one of the body", () => {
    expect(refusal([deleteRange(1, 8)])).toThrow(INVALID_DELETION);
    expect(refusal([deleteRange(31, 35)])).toThrow(INVALID_DELETION);
  });

  it("refuses to delete the paragraph between two tables", () => {
    let tab = buildTab([
      { runs: ["\n"] }, { table: [["\n"]] }, { runs: ["\n"] }, { table: [["\n"]] },
      { runs: ["\n"] },
    ]);
    expect(span(tab.body.content[3])).toEqual([7, 8]);
    expect(refusal([deleteRange(7, 8)], tab)).toThrow(INVALID_DELETION);
  });

  it("refuses an empty range", () => {
    expect(refusal([deleteRange(11, 11)])).toThrow(EMPTY_RANGE);
    expect(refusal([styleText(11, 11, {}, "bold")])).toThrow(EMPTY_RANGE);
  });

  it("refuses a table location that is not the table's start index", () => {
    let message = "Invalid table start location. Must specify the start index of the table.";
    expect(refusal([insertRow(9, 0, true)])).toThrow(message);
    expect(refusal([insertColumn(7, 0, true)])).toThrow(message);
    expect(refusal([deleteRow(10, 0)])).toThrow(message);
    expect(refusal([deleteColumn(11, 0)])).toThrow(message);
    expect(refusal([pinRows(9, 1)])).toThrow(message);
  });

  it("refuses a row or column index past the end", () => {
    expect(refusal([deleteRow(8, 99)]))
      .toThrow("The row index 99 should be less than the total number of rows 3.");
    expect(refusal([insertRow(8, 3, true)]))
      .toThrow("The row index 3 should be less than the total number of rows 3.");
    expect(refusal([insertColumn(8, 2, true)]))
      .toThrow("The column index 2 should be less than the total number of columns 2.");
  });

  it("refuses a table of no rows, and a table at a table's start index", () => {
    expect(refusal([insertTable(1, 0, 2)]))
      .toThrow("The number of table rows should be greater than zero.");
    expect(refusal([insertTable(8, 1, 1)])).toThrow(OUTSIDE_PARAGRAPH);
  });

  it("refuses to delete half of a surrogate pair, or to insert between its halves", () => {
    // "a" is at 1, the pair at 2 and 3, "b" at 4.
    let tab = buildTab([{ runs: ["a\u{1F600}b\n"] }]);
    expect(refusal([deleteRange(2, 3)], tab)).toThrow(INVALID_DELETION);
    expect(refusal([deleteRange(3, 5)], tab)).toThrow(INVALID_DELETION);
    expect(refusal([insertText(3, "x")], tab))
      .toThrow("The insertion index cannot be within a grapheme cluster.");
    expect(textOf(bodyParagraphs(applyDocsRequests(tab, [deleteRange(2, 4)]))[0])).toBe("ab\n");
  });

  it("applies nothing of a batch when it throws", () => {
    let tab = threeRowTable();
    let copy = structuredClone(tab);
    expect(refusal([insertText(1, "x"), deleteRange(11, 16)], tab)).toThrow(INVALID_DELETION);
    expect(tab).toEqual(copy);
  });
});

describe("deletions Google accepts", () => {
  it("deletes text inside a cell's paragraph short of its line break", () => {
    let tab = buildTab([{ runs: ["\n"] }, { table: [["abc\n"]] }, { runs: ["\n"] }]);
    let result = applyDocsRequests(tab, [deleteRange(5, 8), insertText(5, "new")]);

    expect(tableTexts(result)).toEqual([["new\n"]]);
  });

  it("deletes exactly a table and leaves the paragraphs around it", () => {
    let tab = buildTab([
      { runs: ["Before\n"] }, { table: [["a\n", "b\n"]] }, { runs: ["After\n"] },
    ]);
    let result = applyDocsRequests(tab, [deleteRange(8, 17)]);

    expect(result.body.content.map(span)).toEqual([[0, 1], [1, 8], [8, 14]]);
    expect(bodyParagraphs(result).map(textOf)).toEqual(["Before\n", "After\n"]);
  });

  it("deletes the paragraph that follows a table when another follows it", () => {
    let tab = buildTab([
      { runs: ["Before\n"] }, { table: [["\n"]] }, { runs: ["mid\n"] }, { runs: ["After\n"] },
    ]);
    expect(span(tableElement(tab))).toEqual([8, 13]);
    let result = applyDocsRequests(tab, [deleteRange(13, 17)]);

    expect(span(tableElement(result))).toEqual([8, 13]);
    expect(result.body.content.map(span)).toEqual([[0, 1], [1, 8], [8, 13], [13, 19]]);
    expect(bodyParagraphs(result).map(textOf)).toEqual(["Before\n", "After\n"]);
  });

  it("joins two paragraphs under the style and bullet of the one whose line break remains", () => {
    let tab = buildTab([
      { runs: ["Head\n"], namedStyleType: "HEADING_1" },
      { runs: ["item\n"], bullet: { listId: "L1" } },
    ], BULLET_LIST);
    let result = applyDocsRequests(tab, [deleteRange(3, 8)]);

    let [joined] = bodyParagraphs(result);
    expect(bodyParagraphs(result)).toHaveLength(1);
    expect(textOf(joined)).toBe("Heem\n");
    expect(joined.paragraphStyle.namedStyleType).toBe("NORMAL_TEXT");
    expect(joined.bullet).toEqual({ listId: "L1" });
  });
});

describe("edits to a body the Doc tests apply", () => {
  it("rewrites a paragraph as a heading before a paragraph that holds only a chip", () => {
    let tab = buildTab([{ runs: ["Before\n"] }, { runs: [{ date: "Sep 16, 2026" }, "\n"] }]);
    let result = applyDocsRequests(tab, [
      deleteRange(1, 7),
      insertText(1, "Before"),
      styleParagraphs(1, 8, { namedStyleType: "HEADING_1" }, "namedStyleType"),
      styleText(1, 7, {}, FOUR_FIELDS),
    ]);

    expect(markdownOf(result)).toBe("# Before\n\nSep 16, 2026\n");
    let chip = paragraphOf(result.body.content[2]);
    expect(span(result.body.content[2])).toEqual([8, 10]);
    expect(chip.elements[0].dateElement).toEqual(
      paragraphOf(tab.body.content[2]).elements[0].dateElement);
    expect(chip.elements.map(span)).toEqual([[8, 9], [9, 10]]);
  });

  it("appends a paragraph at the line break of a paragraph of plain text", () => {
    let tab = buildTab([{ runs: ["gone\n"] }]);
    let result = applyDocsRequests(tab, [
      insertText(5, "\nafter"),
      deleteBullets(6, 12),
      styleParagraphs(6, 12, { namedStyleType: "NORMAL_TEXT" }, "namedStyleType"),
      styleText(6, 11, {}, FOUR_FIELDS),
    ]);

    expect(markdownOf(result)).toBe("gone\n\nafter\n");
    expect(result.body.content.map(span)).toEqual([[0, 1], [1, 6], [6, 12]]);
    expect(bodyParagraphs(result).map(textOf)).toEqual(["gone\n", "after\n"]);
  });

  it("appends a paragraph after one whose only content is a chip with no label", () => {
    let tab = buildTab([{ runs: [{ date: "" }, "\n"] }]);
    let result = applyDocsRequests(tab, [
      insertText(2, "\nadded"),
      deleteBullets(3, 9),
      styleParagraphs(3, 9, { namedStyleType: "NORMAL_TEXT" }, "namedStyleType"),
      styleText(3, 8, {}, FOUR_FIELDS),
    ]);

    expect(markdownOf(result)).toBe("\n\nadded\n");
    let [chip, added] = bodyParagraphs(result);
    expect(chip.elements.map(span)).toEqual([[1, 2], [2, 3]]);
    expect(chip.elements[0].dateElement).toBeDefined();
    expect(textOf(chip)).toBe("\n");
    expect(textOf(added)).toBe("added\n");
    expect(span(result.body.content[2])).toEqual([3, 9]);
  });

  it("leaves a tab as it is when a change sends no request", () => {
    let tab = buildTab([{ runs: [{ text: "x", style: { italic: true } }, "\n"] }]);
    let result = applyDocsRequests(tab, []);

    expect(result).toEqual(tab);
    expect(result).not.toBe(tab);
    expect(markdownOf(result)).toBe("*x*\n");
  });
});

const pinnedTable = () => buildTab([
  { runs: ["\n"] }, { table: [["H\n"], ["a\n"], ["b\n"]], headerRows: 1 }, { runs: ["\n"] },
]);

describe("rows, columns and header rows", () => {

  it("pins a row added above or below a pinned header row", () => {
    expect(pinnedHeaderRows(pinnedTable(), 2)).toBe(1);
    let above = applyDocsRequests(pinnedTable(), [insertRow(2, 0, false)]);
    let below = applyDocsRequests(pinnedTable(), [insertRow(2, 0, true)]);

    expect(pinnedHeaderRows(above, 2)).toBe(2);
    expect(pinnedHeaderRows(below, 2)).toBe(2);
    expect(tableTexts(above)).toEqual([["\n"], ["H\n"], ["a\n"], ["b\n"]]);
    expect(tableTexts(below)).toEqual([["H\n"], ["\n"], ["a\n"], ["b\n"]]);
  });

  it("does not pin a row added above the first row under the header", () => {
    let result = applyDocsRequests(pinnedTable(), [insertRow(2, 1, false)]);

    expect(pinnedHeaderRows(result, 2)).toBe(1);
    expect(rowsOf(result).map(row => row.tableRowStyle?.tableHeader === true))
      .toEqual([true, false, false, false]);
  });

  it("pins exactly the count of rows a pin request names, from the first", () => {
    let above = applyDocsRequests(pinnedTable(), [insertRow(2, 0, false), pinRows(2, 1)]);
    let below = applyDocsRequests(pinnedTable(), [insertRow(2, 0, true), pinRows(2, 1)]);

    for (let result of [above, below]) {
      expect(rowsOf(result).map(row => row.tableRowStyle?.tableHeader === true))
        .toEqual([true, false, false, false]);
    }
    expect(pinnedHeaderRows(applyDocsRequests(pinnedTable(), [pinRows(2, 2)]), 2)).toBe(2);
    expect(pinnedHeaderRows(applyDocsRequests(pinnedTable(), [pinRows(2, 0)]), 2)).toBe(0);
    // Pinning moves no index.
    expect(span(tableElement(above))).toEqual(
      span(tableElement(applyDocsRequests(pinnedTable(), [insertRow(2, 0, false)]))));
  });

  it("removes the table with its last row, and with its last column", () => {
    let tab = buildTab([
      { runs: ["Before\n"] }, { table: [["a\n", "b\n"]] }, { runs: ["After\n"] },
    ]);
    let withoutRow = applyDocsRequests(tab, [deleteRow(8, 0)]);
    let withoutColumns = applyDocsRequests(tab, [deleteColumn(8, 0), deleteColumn(8, 0)]);

    for (let result of [withoutRow, withoutColumns]) {
      expect(result.body.content.map(span)).toEqual([[0, 1], [1, 8], [8, 14]]);
      expect(bodyParagraphs(result).map(textOf)).toEqual(["Before\n", "After\n"]);
    }
  });
});

describe("chips beside a new row or column", () => {
  const PERSON = { person: { name: "Ana", email: "ana@example.com" } };
  let chips = () => buildTab([
    { runs: ["\n"] },
    {
      table: [[
        cellOf({ runs: [{ dropdown: "Open" }, "\n"] }),
        cellOf({ runs: [PERSON, "\n"] }),
        cellOf({ runs: [{ date: "Sep 16, 2026" }, "\n"] }),
        cellOf({ runs: [`${CHIP_PLACEHOLDER}\n`] }),
      ]],
    },
    { runs: ["\n"] },
  ]);

  it.each([["below", true, 1], ["above", false, 0]] as const)(
    "copies a chip that stands alone in a cell into a row added %s it",
    (_side, insertBelow, newRow) => {
      let tab = chips();
      let definition = paragraphOf(cellsOf(tab)[0][0].content?.[0]).elements[0].dropdown;
      if (!definition) throw new Error("Expected a dropdown");
      definition.dropdownProperties = {
        dropdownDefinitionId: "definition-1", selectedOptionId: "option-2", displayValue: "Open",
      };
      let result = applyDocsRequests(tab, [insertRow(2, 0, insertBelow)]);

      let [dropdown, person, date, placeholder] = cellsOf(result)[newRow];
      // Each copy takes one index, so the new cells are three indexes long.
      for (let cell of [dropdown, person, date, placeholder]) {
        expect(cell.endIndex - cell.startIndex).toBe(3);
        expect(cell.content).toHaveLength(1);
      }
      let [copy, lineBreak] = cellParagraphs(dropdown)[0].elements;
      expect(copy.dropdown?.dropdownProperties).toEqual({ dropdownDefinitionId: "definition-1" });
      expect(lineBreak.textRun?.content).toBe("\n");
      for (let cell of [person, date, placeholder]) {
        let [paragraph] = cellParagraphs(cell);
        expect(paragraph.elements.every(element => element.textRun)).toBe(true);
        expect(textOf(paragraph)).toBe(`${CHIP_PLACEHOLDER}\n`);
      }
      expect(tableElement(result).endIndex - tableElement(tab).endIndex).toBe(1 + 4 * 3);
    },
  );

  it("copies no chip into a new column", () => {
    for (let column = 0; column < 4; column++) {
      for (let insertRight of [false, true]) {
        let result = applyDocsRequests(chips(), [insertColumn(2, column, insertRight)]);
        let added = cellsOf(result)[0][insertRight ? column + 1 : column];

        expect(added.endIndex - added.startIndex).toBe(2);
        expect(cellParagraphs(added).map(textOf)).toEqual(["\n"]);
        expect(cellParagraphs(added)[0].elements).toHaveLength(1);
      }
    }
  });

  it("adds a plain row beside a chip with text, a chip among paragraphs and a lone image", () => {
    let tab = buildTab([
      { runs: ["\n"] },
      {
        table: [[
          cellOf({ runs: ["Owner ", PERSON, "\n"] }),
          cellOf({ runs: [{ dropdown: "Open" }, " now\n"] }),
          cellOf({ runs: [{ dropdown: "Open" }, "\n"] }, { runs: ["\n"] }),
          cellOf({ runs: ["\n"] }, { runs: [{ date: "Sep 16, 2026" }, "\n"] }),
          cellOf({ runs: [{ date: "" }, "\n"] }),
        ]],
      },
      { runs: ["\n"] },
    ]);
    // The last cell holds an inline image alone, which the fixture has no part for.
    let image = paragraphOf(cellsOf(tab)[0][4].content?.[0]).elements[0];
    delete image.dateElement;
    image.inlineObjectElement = { inlineObjectId: "image-1" };

    for (let insertBelow of [false, true]) {
      let result = applyDocsRequests(tab, [insertRow(2, 0, insertBelow)]);
      let added = cellsOf(result)[insertBelow ? 1 : 0];

      expect(added.map(cell => cell.endIndex - cell.startIndex)).toEqual([2, 2, 2, 2, 2]);
      expect(added.map(cell => cellParagraphs(cell).map(textOf))).toEqual(
        [["\n"], ["\n"], ["\n"], ["\n"], ["\n"]]);
    }
  });

  it("does not model a row beside a cell of two chips and no text", () => {
    let tab = buildTab([
      { runs: ["\n"] },
      { table: [[cellOf({ runs: [{ dropdown: "Open" }, PERSON, "\n"] }), "plain\n"]] },
      { runs: ["\n"] },
    ]);

    expect(() => applyDocsRequests(tab, [insertRow(2, 0, true)])).toThrow("not modelled");
    expect(tableTexts(applyDocsRequests(tab, [insertColumn(2, 0, true)])))
      .toEqual([["\n", "\n", "plain\n"]]);
  });
});

/**
 * One row: a centred, indented heading whose first character is bold and 18 points, above a
 * second paragraph; an item of a list at its second level, which states no indent; and plain
 * text.
 */
const styledRow = () => {
  let tab = buildTab([
    { runs: ["\n"] },
    {
      table: [[
        cellOf(
          {
            runs: [
              { text: "H", style: { bold: true, ...sized(18) } as ModelTextStyle }, "ead\n",
            ],
            namedStyleType: "HEADING_2",
          },
          { runs: ["second\n"] },
        ),
        cellOf({ runs: ["item\n"], bullet: { listId: "L1", nestingLevel: 1 } }),
        "plain\n",
      ]],
    },
    { runs: ["\n"] },
  ], BULLET_LIST);
  let heading = modelStyle(cellParagraphs(cellsOf(tab)[0][0])[0]);
  heading.alignment = "CENTER";
  heading.indentStart = points(20);
  return tab;
};

describe("what a new cell copies from the cell beside it", () => {

  it("copies the first paragraph's style, and its first character's onto the line break", () => {
    let tab = styledRow();
    let result = applyDocsRequests(tab, [insertRow(2, 0, true)], { copyStyles: true });
    let [fromHeading, fromItem, fromPlain] = cellsOf(result)[1];

    // One empty paragraph each, whatever the cell beside it holds.
    for (let cell of [fromHeading, fromItem, fromPlain]) {
      expect(cellParagraphs(cell).map(textOf)).toEqual(["\n"]);
      expect(cellParagraphs(cell)[0].bullet).toBeUndefined();
    }
    let [heading] = cellParagraphs(fromHeading);
    expect(modelStyle(heading)).toEqual({
      namedStyleType: "HEADING_2", alignment: "CENTER", indentStart: points(20),
    });
    expect(runsOf(heading)).toEqual([["\n", { bold: true, ...sized(18) }]]);
    expect(alignmentAt(result, fromHeading.startIndex + 1)).toBe("CENTER");
    expect(fontSizeAt(result, fromHeading.startIndex + 1)).toBe(18);

    expect(modelStyle(cellParagraphs(fromPlain)[0])).toEqual({ namedStyleType: "NORMAL_TEXT" });
    expect(runsOf(cellParagraphs(fromPlain)[0])).toEqual([["\n", {}]]);
  });

  it("indents a cell copied from a list item that states no indent", () => {
    let tab = styledRow();
    expect(indentedParagraphs(tab)).toEqual([cellsOf(tab)[0][0].startIndex + 1]);
    let result = applyDocsRequests(tab, [insertRow(2, 0, false)], { copyStyles: true });
    let [fromHeading, fromItem] = cellsOf(result)[0];

    expect(modelStyle(cellParagraphs(fromItem)[0])).toEqual({
      namedStyleType: "NORMAL_TEXT", indentStart: points(72), indentFirstLine: points(54),
    });
    expect(indentedParagraphs(result)).toEqual([
      fromHeading.startIndex + 1, fromItem.startIndex + 1, cellsOf(result)[1][0].startIndex + 1,
    ]);
  });

  it("copies into a new column from the cell of the same row in the named column", () => {
    let tab = buildTab([
      { runs: ["\n"] },
      {
        table: [
          [cellOf({ runs: [{ text: "big", style: sized(18) as ModelTextStyle }, "\n"] }), "x\n"],
          [cellOf({ runs: ["title\n"], namedStyleType: "TITLE" }), "y\n"],
        ],
      },
      { runs: ["\n"] },
    ]);
    let result = applyDocsRequests(tab, [insertColumn(2, 0, true)], { copyStyles: true });
    let [first, second] = cellsOf(result).map(row => row[1]);

    expect(runsOf(cellParagraphs(first)[0])).toEqual([["\n", sized(18)]]);
    expect(modelStyle(cellParagraphs(first)[0])).toEqual({ namedStyleType: "NORMAL_TEXT" });
    expect(runsOf(cellParagraphs(second)[0])).toEqual([["\n", {}]]);
    expect(modelStyle(cellParagraphs(second)[0])).toEqual({ namedStyleType: "TITLE" });
  });

  it("gives text put into a new cell the look the cell copied", () => {
    let tab = styledRow();
    let newParagraph = rowsOf(tab)[0].endIndex + 2;
    let copied = applyDocsRequests(
      tab, [insertRow(2, 0, true), insertText(newParagraph, "new")], { copyStyles: true });

    expect(runsOf(cellParagraphs(cellsOf(copied)[1][0])[0]))
      .toEqual([["new\n", { bold: true, ...sized(18) }]]);
    expect(fontSizeAt(copied, newParagraph)).toBe(18);
  });

  it("copies none of it otherwise", () => {
    let tab = styledRow();
    for (let options of [undefined, {}, { copyStyles: false }]) {
      let result = applyDocsRequests(
        tab, [insertRow(2, 0, true), insertColumn(2, 0, false)], options);
      let added = [...cellsOf(result)[1], cellsOf(result)[0][0]];

      for (let cell of added) {
        let [paragraph] = cellParagraphs(cell);
        expect(modelStyle(paragraph)).toEqual({ namedStyleType: "NORMAL_TEXT" });
        expect(runsOf(paragraph)).toEqual([["\n", {}]]);
        expect(paragraph.bullet).toBeUndefined();
      }
      expect(indentedParagraphs(result)).toHaveLength(1);
    }
  });
});

/** A centred paragraph whose first two characters are bold and 14 points, the rest linked. */
const formattedParagraph = () => {
  let tab = buildTab([{
    runs: [
      { text: "He", style: { bold: true, italic: true, ...sized(14) } as ModelTextStyle },
      { text: "llo", style: { link: LINK_A, underline: true } as ModelTextStyle },
      "\n",
    ],
  }]);
  modelStyle(bodyParagraphs(tab)[0]).alignment = "CENTER";
  return tab;
};

describe("the paragraph requests", () => {

  it("drops a paragraph's alignment and its text's look when a request names the style", () => {
    for (let namedStyleType of ["NORMAL_TEXT", "HEADING_2"]) {
      let result = applyDocsRequests(formattedParagraph(), [
        styleParagraphs(1, 7, { namedStyleType }, "namedStyleType"),
      ]);
      let [paragraph] = bodyParagraphs(result);

      expect(modelStyle(paragraph)).toEqual({ namedStyleType });
      expect(alignmentAt(result, 1)).toBeUndefined();
      expect(fontSizeAt(result, 1)).toBeUndefined();
      // A link stays.
      expect(runsOf(paragraph)).toEqual([["He", {}], ["llo", { link: LINK_A }], ["\n", {}]]);
    }
  });

  it("keeps both when a request names only the indents, which it sets", () => {
    let result = applyDocsRequests(formattedParagraph(), [
      styleParagraphs(1, 7, { indentStart: points(10), indentFirstLine: points(4) },
        "indentStart,indentFirstLine"),
    ]);
    let [paragraph] = bodyParagraphs(result);

    expect(modelStyle(paragraph)).toEqual({
      namedStyleType: "NORMAL_TEXT", alignment: "CENTER",
      indentStart: points(10), indentFirstLine: points(4),
    });
    expect(runsOf(paragraph)).toEqual(runsOf(bodyParagraphs(formattedParagraph())[0]));
    expect(fontSizeAt(result, 1)).toBe(14);
    expect(indentedParagraphs(result)).toEqual([1]);
  });

  it("styles every paragraph a range touches", () => {
    let tab = buildTab([{ runs: ["one\n"] }, { runs: ["two\n"] }, { runs: ["three\n"] }]);
    let result = applyDocsRequests(tab, [
      styleParagraphs(4, 6, { namedStyleType: "HEADING_3" }, "namedStyleType"),
    ]);

    expect(bodyParagraphs(result).map(paragraph => paragraph.paragraphStyle.namedStyleType))
      .toEqual(["HEADING_3", "HEADING_3", "NORMAL_TEXT"]);
  });

  it("leaves a paragraph indented when its bullet is removed, and a plain one as it was", () => {
    let tab = buildTab([
      { runs: ["first\n"], bullet: { listId: "L1" } },
      { runs: ["nested\n"], bullet: { listId: "L1", nestingLevel: 1 } },
      { runs: ["plain\n"] },
    ], BULLET_LIST);
    let result = applyDocsRequests(tab, [deleteBullets(1, 20)]);
    let [first, nested, plain] = bodyParagraphs(result);

    expect(first.bullet).toBeUndefined();
    expect(nested.bullet).toBeUndefined();
    expect(modelStyle(first)).toEqual({
      namedStyleType: "NORMAL_TEXT", indentStart: points(36), indentFirstLine: points(18),
    });
    expect(modelStyle(nested)).toEqual({
      namedStyleType: "NORMAL_TEXT", indentStart: points(72), indentFirstLine: points(54),
    });
    expect(plain).toEqual(bodyParagraphs(tab)[2]);
    expect(indentedParagraphs(result)).toEqual([1, 7]);
  });

  it("takes the indent away when a request sets both indent fields to zero", () => {
    let tab = buildTab([{ runs: ["first\n"], bullet: { listId: "L1" } }], BULLET_LIST);
    let indented = applyDocsRequests(tab, [
      deleteBullets(1, 7),
      styleParagraphs(1, 7, { namedStyleType: "NORMAL_TEXT" }, "namedStyleType"),
    ]);
    let reset = applyDocsRequests(tab, [
      deleteBullets(1, 7),
      styleParagraphs(1, 7,
        { namedStyleType: "NORMAL_TEXT", indentStart: points(0), indentFirstLine: points(0) },
        "namedStyleType,indentStart,indentFirstLine"),
    ]);

    // Naming the style alone does not take the indent a removed bullet leaves.
    expect(indentedParagraphs(indented)).toEqual([1]);
    expect(indentedParagraphs(reset)).toEqual([]);
  });

  it("accepts the reset of an empty cell up to the cell's last index", () => {
    let tab = buildTab([{ runs: ["\n"] }, { table: [["\n", "\n"]] }, { runs: ["\n"] }]);
    let first = cellsOf(tab)[0][0];
    let result = applyDocsRequests(tab, [
      deleteBullets(first.startIndex + 1, first.endIndex),
      styleParagraphs(first.startIndex + 1, first.endIndex,
        { namedStyleType: "NORMAL_TEXT", indentStart: points(0), indentFirstLine: points(0) },
        "namedStyleType,indentStart,indentFirstLine"),
    ]);

    expect(tableTexts(result)).toEqual([["\n", "\n"]]);
    expect(indentedParagraphs(result)).toEqual([]);
  });
});

const expectNotModelled = (tab: GoogleDocsTab, request: GoogleDocsRequest) =>
  expect(() => applyDocsRequests(tab, [request])).toThrow(/^not modelled: /);

/** Three rows of three cells; the first cell is merged over two rows and two columns. */
const merged = () => buildTab([
  { runs: ["\n"] },
  {
    table: [
      [
        { paragraphs: [{ runs: ["head\n"] }], tableCellStyle: { rowSpan: 2, columnSpan: 2 } },
        "\n", "c\n",
      ],
      ["\n", "\n", "f\n"],
      ["g\n", "h\n", "i\n"],
    ],
  },
  { runs: ["\n"] },
]);

/** The index of the first paragraph of the cell at `row`, `column` of the tab's first table. */
const paragraphIn = (tab: GoogleDocsTab, row: number, column: number) =>
  cellsOf(tab)[row][column].startIndex + 1;

describe("what the model does not cover", () => {
  it("throws for a row or column request on a table that holds a suggestion", () => {
    let suggestedRow = buildTab([
      { runs: ["\n"] },
      { table: [["a\n", "b\n"], ["c\n", "d\n"]], suggestedRows: { 1: "insertion" } },
      { runs: ["\n"] },
    ]);
    let suggestedCell = buildTab([
      { runs: ["\n"] },
      { table: [["a\n", { paragraphs: [{ runs: ["b\n"] }], suggested: "deletion" }]] },
      { runs: ["\n"] },
    ]);
    let suggestedTable = buildTab([{ runs: ["\n"] }, { table: [["a\n"]] }, { runs: ["\n"] }]);
    Object.assign(
      tableElement(suggestedTable).table ?? {}, { suggestedInsertionIds: ["suggest.1"] });

    for (let tab of [suggestedRow, suggestedCell, suggestedTable]) {
      expectNotModelled(tab, insertRow(2, 0, true));
      expectNotModelled(tab, insertColumn(2, 0, true));
      expectNotModelled(tab, deleteRow(2, 0));
      expectNotModelled(tab, deleteColumn(2, 0));
    }
  });

  it("throws for a row or column request on a table with a merged cell", () => {
    let tab = buildTab([
      { runs: ["\n"] },
      {
        table: [
          [{ paragraphs: [{ runs: ["a\n"] }], tableCellStyle: { columnSpan: 2 } }, "\n"],
          ["c\n", "d\n"],
        ],
      },
      { runs: ["\n"] },
    ]);

    expectNotModelled(tab, insertRow(2, 1, true));
    expectNotModelled(tab, insertColumn(2, 0, true));
    expectNotModelled(tab, deleteRow(2, 1));
    expectNotModelled(tab, deleteColumn(2, 1));
  });

  describe("in a cell that a merged cell covers", () => {
    const COVERED: [number, number][] = [[0, 1], [1, 0], [1, 1]];

    it.each(COVERED)("throws for text and for a new table at row %i, column %i", (row, column) => {
      let tab = merged();
      let paragraph = paragraphIn(tab, row, column);

      expectNotModelled(tab, insertText(paragraph, "X"));
      expectNotModelled(tab, insertTable(paragraph, 1, 1));
    });

    it.each(COVERED)("throws for a style or bullet request at row %i, column %i", (row, column) => {
      let tab = merged();
      let paragraph = paragraphIn(tab, row, column);

      expectNotModelled(tab, styleText(paragraph, paragraph + 1, { bold: true }, "bold"));
      expectNotModelled(tab, styleParagraphs(
        paragraph, paragraph + 1, { namedStyleType: "NORMAL_TEXT" }, "namedStyleType"));
      expectNotModelled(tab, deleteBullets(paragraph, paragraph + 1));
    });

    it("throws for a deletion that starts or ends there", () => {
      // The covered cell beside the merged one holds text here, so that a range can end in it.
      let tab = buildTab([
        { runs: ["\n"] },
        {
          table: [[
            { paragraphs: [{ runs: ["head\n"] }], tableCellStyle: { columnSpan: 2 } },
            cellOf({ runs: ["one\n"] }, { runs: ["two\n"] }),
          ]],
        },
        { runs: ["\n"] },
      ]);
      let covered = paragraphIn(tab, 0, 1);

      expectNotModelled(tab, deleteRange(covered, covered + 2));
      expectNotModelled(tab, deleteRange(covered + 2, covered + 5));
      expectNotModelled(tab, deleteRange(paragraphIn(tab, 0, 0), covered + 1));
    });

    it("applies a request to the merged cell itself and to the cells beside the merge", () => {
      let tab = merged();
      let result = applyDocsRequests(tab, [
        insertText(paragraphIn(tab, 2, 2), "X"), insertText(paragraphIn(tab, 2, 0), "X"),
        insertText(paragraphIn(tab, 1, 2), "X"), insertText(paragraphIn(tab, 0, 2), "X"),
        insertText(paragraphIn(tab, 0, 0), "X"),
      ]);

      expect(tableTexts(result)).toEqual([
        ["Xhead\n", "\n", "Xc\n"], ["\n", "\n", "Xf\n"], ["Xg\n", "h\n", "Xi\n"],
      ]);
    });

    it("deletes the whole table all the same", () => {
      let tab = merged();
      let [start, end] = span(tableElement(tab));
      let result = applyDocsRequests(tab, [deleteRange(start, end)]);

      expect(bodyParagraphs(result).map(textOf)).toEqual(["\n", "\n"]);
      expect(result.body.content.filter(element => element.table)).toEqual([]);
    });
  });

  it("throws for a row request on a table inside a cell", () => {
    let tab = buildTab([
      { runs: ["\n"] },
      { table: [[{ paragraphs: [{ runs: ["\n"] }, { table: [["in\n"]] }, { runs: ["\n"] }] }]] },
      { runs: ["\n"] },
    ]);
    // The outer table is at 2 and its cell at 4; the cell holds a paragraph at 5 and the inner
    // table at 6.
    expectNotModelled(tab, insertRow(6, 0, true));
    let lengths = rowsOf(applyDocsRequests(tab, [insertRow(2, 0, true)]))
      .map(row => row.endIndex - row.startIndex);
    // The new row holds one empty cell: no table is copied into it.
    expect(lengths)
      .toEqual([11, 3]);
  });

  it("throws for new bullets", () => {
    let tab = buildTab([{ runs: ["item\n"] }]);
    expectNotModelled(tab, {
      createParagraphBullets: { range: range(1, 6), bulletPreset: "BULLET_DISC_CIRCLE_SQUARE" },
    });
  });

  it("throws for a table inserted strictly inside a paragraph's text", () => {
    let tab = buildTab([{ runs: ["Before\n"] }]);
    expectNotModelled(tab, insertTable(3, 1, 1));
  });

  it("throws for a deletion that takes a table together with text beside it", () => {
    let tab = buildTab([{ runs: ["Before\n"] }, { table: [["a\n"]] }, { runs: ["After\n"] }]);
    // The table is [8, 14).
    expectNotModelled(tab, deleteRange(7, 14));
    expectNotModelled(tab, deleteRange(8, 15));
    expectNotModelled(tab, deleteRange(3, 16));
  });

  it("throws for a coordinate that names another tab, and for a field it does not know", () => {
    let tab = buildTab([{ runs: ["text\n"] }]);
    expectNotModelled(tab, { insertText: { location: { index: 1, tabId: "tab-2" }, text: "x" } });
    expectNotModelled(tab, styleText(1, 3, {}, "bold,baselineOffset"));
    expectNotModelled(tab, styleParagraphs(1, 3, { alignment: "CENTER" }, "alignment"));
  });
});

describe("a new table and the paragraph it cuts", () => {
  it("leaves a positioned object on the part of the paragraph before the table", () => {
    let tab = buildTab([{ runs: ["Before\n"] }]);
    bodyParagraphs(tab)[0].positionedObjectIds = ["image-1"];

    let atLineBreak = applyDocsRequests(tab, [insertTable(7, 1, 1)]);
    expect(bodyParagraphs(atLineBreak).map(paragraph =>
      [textOf(paragraph), paragraph.positionedObjectIds])).toEqual([
      ["Before\n", ["image-1"]], ["\n", undefined],
    ]);
    expect(span(tableElement(atLineBreak))).toEqual([8, 13]);

    let atStart = applyDocsRequests(tab, [insertTable(1, 1, 1)]);
    expect(bodyParagraphs(atStart).map(paragraph =>
      [textOf(paragraph), paragraph.positionedObjectIds])).toEqual([
      ["\n", ["image-1"]], ["Before\n", undefined],
    ]);
    expect(span(tableElement(atStart))).toEqual([2, 7]);
  });

  it.each([{}, { copyStyles: true }])(
    "leaves a bulleted paragraph on each side of a table that cuts a list item (%o)",
    options => {
      let empty = buildTab(
        [{ runs: ["\n"], bullet: { listId: "L1", nestingLevel: 1 } }], BULLET_LIST);
      let item = buildTab([{ runs: ["item\n"], bullet: { listId: "L1" } }], BULLET_LIST);
      modelStyle(bodyParagraphs(item)[0]).indentStart = points(36);

      let aroundEmpty = bodyParagraphs(applyDocsRequests(empty, [insertTable(1, 1, 1)], options));
      expect(aroundEmpty.map(paragraph => [textOf(paragraph), paragraph.bullet])).toEqual([
        ["\n", { listId: "L1", nestingLevel: 1 }], ["\n", { listId: "L1", nestingLevel: 1 }],
      ]);

      let aroundItem = bodyParagraphs(applyDocsRequests(item, [insertTable(5, 1, 1)], options));
      expect(aroundItem.map(paragraph => [textOf(paragraph), paragraph.bullet])).toEqual([
        ["item\n", { listId: "L1" }], ["\n", { listId: "L1" }],
      ]);
      // Both parts carry the indent as well.
      expect(aroundItem.map(modelStyle)).toEqual([
        { namedStyleType: "NORMAL_TEXT", indentStart: points(36) },
        { namedStyleType: "NORMAL_TEXT", indentStart: points(36) },
      ]);
    },
  );

  it("gives both parts of a heading the heading's style", () => {
    let tab = buildTab([{ runs: ["Title\n"], namedStyleType: "HEADING_2" }, { runs: ["\n"] }]);

    for (let index of [1, 6]) {
      let [before, after] = bodyParagraphs(applyDocsRequests(tab, [insertTable(index, 1, 1)]));
      expect([before, after].map(paragraph => paragraph.paragraphStyle.namedStyleType))
        .toEqual(["HEADING_2", "HEADING_2"]);
      expect([before, after].map(textOf))
        .toEqual(index === 1 ? ["\n", "Title\n"] : ["Title\n", "\n"]);
    }
  });

  it("writes a heading's look onto the cells of a table inserted at the heading's start", () => {
    let tab = buildTab([{ runs: ["Title\n"], namedStyleType: "HEADING_2" }, { runs: ["\n"] }]);
    let lineBreaks = (index: number, copyStyles: boolean) => cellsOf(
      applyDocsRequests(tab, [insertTable(index, 2, 2)], { copyStyles }),
    ).flat().map(cell => {
      let [paragraph] = cellParagraphs(cell);
      expect(paragraph.paragraphStyle.namedStyleType).toBe("NORMAL_TEXT");
      let [[text, style]] = runsOf(paragraph);
      expect(text).toBe("\n");
      return style;
    });

    for (let style of lineBreaks(1, true)) {
      expect(style.italic).toBe(true);
      expect(style.fontSize?.magnitude).toBeGreaterThan(0);
    }
    // Not at the heading's line break, not at the start of normal text, and not without copying.
    expect(lineBreaks(6, true)).toEqual([{}, {}, {}, {}]);
    expect(lineBreaks(7, true)).toEqual([{}, {}, {}, {}]);
    expect(lineBreaks(1, false)).toEqual([{}, {}, {}, {}]);
  });

  it("puts a table inserted at a table's end after a new paragraph between the two", () => {
    let tab = buildTab([{ runs: ["\n"] }, { table: [["a\n"]] }, { runs: ["After\n"] }]);
    // The first table is [2, 8), and "After" starts at its end.
    let result = applyDocsRequests(tab, [insertTable(8, 1, 1)]);

    expect(result.body.content.map(span))
      .toEqual([[0, 1], [1, 2], [2, 8], [8, 9], [9, 14], [14, 20]]);
    expect(bodyParagraphs(result).map(textOf)).toEqual(["\n", "\n", "After\n"]);
  });
});

const runsAfter = (tab: GoogleDocsTab, ...requests: GoogleDocsRequest[]) =>
  runsOf(bodyParagraphs(applyDocsRequests(tab, requests))[0]);

const linked = (text: string, extra: ModelTextStyle = {}) =>
  ({ text, style: { link: LINK_A, ...extra } as ModelTextStyle });

describe("how inserted text is styled", () => {

  it("loses the characters Google strips", () => {
    let tab = buildTab([{ runs: ["\n"] }]);
    expect(runsAfter(tab, insertText(1, "a\u0001b\uE000c\u001fd\tE\u000bf")))
      .toEqual([["abcd\tE\u000bf\n", {}]]);
  });

  it("joins the text run it is typed into, with that run's size", () => {
    let tab = buildTab([{ runs: [{ text: "Hello", style: sized(14) as ModelTextStyle }, "\n"] }]);
    let result = applyDocsRequests(tab, [insertText(3, "XY")]);

    expect(runsOf(bodyParagraphs(result)[0])).toEqual([["HeXYllo", sized(14)], ["\n", {}]]);
    expect(fontSizeAt(result, 3)).toBe(14);
  });

  it("is linked inside a link", () => {
    let tab = buildTab([{ runs: [linked("abcd"), " tail\n"] }]);
    expect(runsAfter(tab, insertText(3, "X")))
      .toEqual([["abXcd", { link: LINK_A }], [" tail\n", {}]]);
  });

  it("takes the style of the text that follows a link, not the link", () => {
    let tab = buildTab([{
      runs: [linked("ab", sized(14)), { text: " tail", style: sized(9) as ModelTextStyle }, "\n"],
    }]);
    let result = applyDocsRequests(tab, [insertText(3, "X")]);

    expect(runsOf(bodyParagraphs(result)[0])).toEqual([
      ["ab", { link: LINK_A, ...sized(14) }], ["X tail", sized(9)], ["\n", {}],
    ]);
    expect(fontSizeAt(result, 3)).toBe(9);
  });

  it("takes the style of the line break after a link that ends the paragraph's text", () => {
    let tab = buildTab([{
      runs: ["x", linked("ab", sized(14)), { text: "\n", style: sized(7) as ModelTextStyle }],
    }]);

    expect(runsAfter(tab, insertText(4, "X"))).toEqual([
      ["x", {}], ["ab", { link: LINK_A, ...sized(14) }], ["X\n", sized(7)],
    ]);
  });

  it("has no style before a link at the start of a paragraph", () => {
    let tab = buildTab([{ runs: [linked("ab", sized(14)), "\n"] }]);

    expect(runsAfter(tab, insertText(1, "X"))).toEqual([
      ["X", {}], ["ab", { link: LINK_A, ...sized(14) }], ["\n", {}],
    ]);
  });

  it("takes the style of the text before a link it is typed in front of", () => {
    let tab = buildTab([{
      runs: [{ text: "x", style: sized(9) as ModelTextStyle }, linked("ab"), "\n"],
    }]);

    expect(runsAfter(tab, insertText(2, "X"))).toEqual([
      ["xX", sized(9)], ["ab", { link: LINK_A }], ["\n", {}],
    ]);
  });

  it("takes the second link's style where two links meet", () => {
    let tab = buildTab([{
      runs: [
        linked("ab"), { text: "cd", style: { link: LINK_B, ...sized(9) } as ModelTextStyle }, "\n",
      ],
    }]);

    expect(runsAfter(tab, insertText(3, "X"))).toEqual([
      ["ab", { link: LINK_A }], ["Xcd", { link: LINK_B, ...sized(9) }], ["\n", {}],
    ]);
  });

  it("is bold after bold text that is not linked", () => {
    let tab = buildTab([{ runs: [{ text: "ab", style: { bold: true } }, " c\n"] }]);

    expect(runsAfter(tab, insertText(3, "X"))).toEqual([["abX", { bold: true }], [" c\n", {}]]);
  });

  it("starts a paragraph of the same style and bullet at every line break", () => {
    let tab = buildTab([
      { runs: ["\n"] },
      {
        table: [[cellOf({
          runs: [{ text: "ab", style: { bold: true } }, "\n"], bullet: { listId: "L1" },
        })]],
      },
      { runs: ["\n"] },
    ], BULLET_LIST);
    let cell = cellsOf(tab)[0][0];
    let result = applyDocsRequests(tab, [insertText(cell.startIndex + 2, "1\n2\n")]);
    let paragraphs = cellParagraphs(cellsOf(result)[0][0]);

    expect(paragraphs.map(textOf)).toEqual(["a1\n", "2\n", "b\n"]);
    expect(paragraphs.map(paragraph => paragraph.bullet)).toEqual(
      [{ listId: "L1" }, { listId: "L1" }, { listId: "L1" }]);
    expect((cellsOf(result)[0][0].content ?? []).map(span)).toEqual([[5, 8], [8, 10], [10, 12]]);
  });
});

const linkRun = (tab: GoogleDocsTab) => runsOf(bodyParagraphs(tab)[0])[1];

describe("links", () => {
  let look = { underline: true, foregroundColor: LINK_COLOR };
  /** Bold 14-point text, then a 10-point link with a link's look, then plain text. */
  let afterBold = () => buildTab([{
    runs: [
      { text: "B", style: { bold: true, ...sized(14) } as ModelTextStyle },
      {
        text: "link",
        style: { link: LINK_A, italic: true, ...look, ...sized(10) } as ModelTextStyle,
      },
      " tail\n",
    ],
  }]);
  /** The same link after another link. */
  let afterLink = () => buildTab([{
    runs: [
      { text: "A", style: { link: LINK_B, bold: true, ...sized(14) } as ModelTextStyle },
      { text: "link", style: { link: LINK_A, ...look, ...sized(10) } as ModelTextStyle },
      "\n",
    ],
  }]);
  const SIX_FIELDS = `${FOUR_FIELDS},underline,foregroundColor`;

  it("repoints a whole link when another is set on part of it", () => {
    let tab = buildTab([{ runs: ["x", { text: "abcd", style: { link: LINK_A } }, "y\n"] }]);
    let result = applyDocsRequests(tab, [styleText(2, 4, { link: LINK_B }, "link")]);

    expect(runsOf(bodyParagraphs(result)[0]).map(([text, style]) => [text, style.link])).toEqual([
      ["x", undefined], ["ab", LINK_B], ["cd", LINK_B], ["y\n", undefined],
    ]);
  });

  it("changes only the cleared part when a link is cleared first", () => {
    let tab = buildTab([{ runs: [{ text: "abcd", style: { link: LINK_A } }, "\n"] }]);
    let result = applyDocsRequests(tab, [
      styleText(1, 3, {}, "link"), styleText(1, 3, { link: LINK_B }, "link"),
    ]);

    expect(runsOf(bodyParagraphs(result)[0]).map(([text, style]) => [text, style.link])).toEqual([
      ["ab", LINK_B], ["cd", LINK_A], ["\n", undefined],
    ]);
  });

  it("leaves a link beside the one named as it was", () => {
    let result = applyDocsRequests(afterLink(), [styleText(2, 6, { link: LINK_B }, "link")]);
    let again = applyDocsRequests(afterLink(), [
      styleText(2, 6, { link: { url: "https://c.example" } }, "link"),
    ]);

    expect(runsOf(bodyParagraphs(result)[0]).map(([, style]) => style.link))
      .toEqual([LINK_B, LINK_B, undefined]);
    expect(runsOf(bodyParagraphs(again)[0]).map(([, style]) => style.link))
      .toEqual([LINK_B, { url: "https://c.example" }, undefined]);
  });

  it("gives linked text an underline and the link colour unless the request names them", () => {
    let tab = buildTab([{ runs: ["plain text\n"] }]);
    let result = applyDocsRequests(tab, [styleText(1, 6, { link: LINK_A }, "link")]);

    expect(runsOf(bodyParagraphs(result)[0])).toEqual([
      ["plain", { link: LINK_A, ...look }], [" text\n", {}],
    ]);
    expect(hasLinkLook(result, 1)).toBe(true);
    expect(hasLinkLook(result, 5)).toBe(true);
    expect(hasLinkLook(result, 6)).toBe(false);

    let named = applyDocsRequests(tab, [styleText(1, 6, { link: LINK_A }, SIX_FIELDS)]);
    expect(hasLinkLook(named, 1)).toBe(false);
  });

  describe("cleared, when Google restyles the text like the text before it", () => {
    let options = { unlinkRestyles: true };

    it("leaves the text bold like the text before it when the request names the link alone", () => {
      let result = applyDocsRequests(afterBold(), [styleText(2, 6, {}, "link")], options);

      expect(linkRun(result)).toEqual(["link", { bold: true, ...sized(14) }]);
      expect(hasLinkLook(result, 2)).toBe(false);
    });

    it("leaves bold as the request states it when the request names it", () => {
      let cleared = applyDocsRequests(afterBold(), [styleText(2, 6, {}, "bold,link")], options);
      let kept = applyDocsRequests(
        afterBold(), [styleText(2, 6, { italic: true }, FOUR_FIELDS)], options);

      expect(linkRun(cleared)).toEqual(["link", sized(14)]);
      expect(linkRun(cleared)[1].bold).toBeUndefined();
      expect(linkRun(kept)).toEqual(["link", { italic: true, ...sized(14) }]);
    });

    it("gives the text the size of the text before it, whatever else the request names", () => {
      for (let fields of ["link", "bold,link", FOUR_FIELDS, SIX_FIELDS]) {
        let result = applyDocsRequests(afterBold(), [styleText(2, 6, {}, fields)], options);
        expect(fontSizeAt(result, 2)).toBe(14);
        expect(fontSizeAt(result, 5)).toBe(14);
      }
    });

    it("loses its own size when the text before it is a link", () => {
      for (let fields of ["link", FOUR_FIELDS, SIX_FIELDS]) {
        let result = applyDocsRequests(afterLink(), [styleText(2, 6, {}, fields)], options);
        expect(linkRun(result)).toEqual(["link", {}]);
        expect(fontSizeAt(result, 2)).toBeUndefined();
      }
    });

    /** A 10-point link that starts a paragraph. */
    let sizedLink = { text: "link", style: { link: LINK_A, ...sized(10) } as ModelTextStyle };

    it("loses its own size where no character stands before it", () => {
      // At the start of a tab's first paragraph, and at the start of a cell.
      let first = buildTab([{ runs: [sizedLink, "\n"] }]);
      let inCell = buildTab([
        { runs: [{ text: "\n", style: sized(30) as ModelTextStyle }] },
        { table: [[cellOf({ runs: [sizedLink, "\n"] })]] },
        { runs: ["\n"] },
      ]);
      let cellText = cellsOf(inCell)[0][0].startIndex + 1;

      expect(fontSizeAt(first, 1)).toBe(10);
      expect(fontSizeAt(applyDocsRequests(first, [styleText(1, 5, {}, "link")], options), 1))
        .toBeUndefined();
      expect(fontSizeAt(inCell, cellText)).toBe(10);
      expect(fontSizeAt(
        applyDocsRequests(inCell, [styleText(cellText, cellText + 4, {}, "link")], options),
        cellText,
      )).toBeUndefined();
    });

    it("takes the size of the line break before it at the start of a later paragraph", () => {
      // "one" is at 1 to 3 and its line break, of 30 points, at 4; the link starts at 5.
      let tab = buildTab([
        { runs: ["one", { text: "\n", style: sized(30) as ModelTextStyle }] },
        { runs: [sizedLink, "\n"] },
      ]);
      let result = applyDocsRequests(tab, [styleText(5, 9, {}, "link")], options);

      expect(runsOf(bodyParagraphs(result)[1])).toEqual([["link", sized(30)], ["\n", {}]]);
      expect(fontSizeAt(result, 5)).toBe(30);
    });

    it("restyles only text that had a link", () => {
      let result = applyDocsRequests(afterBold(), [styleText(6, 9, {}, FOUR_FIELDS)], options);

      expect(runsOf(bodyParagraphs(result)[0]).slice(2)).toEqual([[" ta", {}], ["il\n", {}]]);
    });
  });

  describe("cleared, when Google leaves the rest of the text's style alone", () => {
    it("leaves the underline and colour unless the request names them", () => {
      for (let fields of ["link", FOUR_FIELDS]) {
        let result = applyDocsRequests(afterBold(), [styleText(2, 6, {}, fields)]);
        expect(linkRun(result)[1].link).toBeUndefined();
        expect(linkRun(result)[1]).toMatchObject(look);
        expect(hasLinkLook(result, 2)).toBe(true);
      }
      let named = applyDocsRequests(afterBold(), [styleText(2, 6, {}, SIX_FIELDS)]);
      expect(linkRun(named)).toEqual(["link", sized(10)]);
      expect(hasLinkLook(named, 2)).toBe(false);
    });

    it("leaves bold, italic and size as they were where the request names none", () => {
      let result = applyDocsRequests(afterBold(), [styleText(2, 6, {}, "link")]);

      expect(linkRun(result)).toEqual(["link", { italic: true, ...look, ...sized(10) }]);
    });
  });

  it.each([{}, { unlinkRestyles: true }])(
    "leaves the size of text as it was when a link is set on it, or set again (%o)",
    options => {
      let tab = buildTab([{
        runs: [{ text: "word", style: sized(10) as ModelTextStyle }, " tail\n"],
      }]);
      let set = applyDocsRequests(tab, [styleText(1, 5, { link: LINK_A }, "link")], options);
      let again = applyDocsRequests(set, [
        styleText(1, 5, { link: LINK_A }, FOUR_FIELDS), styleText(2, 4, { link: LINK_A }, "link"),
      ], options);

      for (let result of [set, again]) {
        for (let index of [1, 2, 3, 4]) expect(fontSizeAt(result, index)).toBe(10);
        expect(hasLinkLook(result, 1)).toBe(true);
      }
      expect(runsOf(bodyParagraphs(again)[0]).map(([, style]) => style.link))
        .toEqual([LINK_A, LINK_A, LINK_A, undefined]);
    },
  );

  it("sets and clears exactly the fields a request names, between the range's ends", () => {
    let tab = buildTab([{
      runs: [{ text: "r0c0", style: { bold: true, underline: true } as ModelTextStyle }, "\n"],
    }]);
    let result = applyDocsRequests(tab, [
      styleText(2, 4, { italic: true }, "bold,italic"), styleText(1, 2, { bold: false }, "bold"),
    ]);

    expect(runsOf(bodyParagraphs(result)[0])).toEqual([
      ["r", { bold: false, underline: true }],
      ["0c", { italic: true, underline: true }],
      ["0", { bold: true, underline: true }],
      ["\n", {}],
    ]);
  });
});

const notedCell = (text: string, number: string) =>
  cellOf({ runs: [text, { footnote: { id: `footnote-${number}`, number } }, "\n"] });

/** Every paragraph of `content` in document order, those of table cells included. */
function paragraphsIn(content: StructuralElement[]): Paragraph[] {
  return content.flatMap(element => element.paragraph
    ? [element.paragraph]
    : (element.table?.tableRows ?? []).flatMap(row =>
      (row.tableCells ?? []).flatMap(cell => paragraphsIn(cell.content ?? []))));
}

/** The tab's footnote references in document order, body and cells. */
const footnoteReferences = (from: GoogleDocsTab) => paragraphsIn(from.body.content)
  .flatMap(paragraph => paragraph.elements)
  .flatMap(element => element.footnoteReference ? [element.footnoteReference] : []);

/** Each footnote reference of the tab as its ID and the number it shows, in document order. */
const footnoteNumbers = (from: GoogleDocsTab) => footnoteReferences(from)
  .map(reference => [reference.footnoteId, reference.footnoteNumber]);

const footnote = (number: string) => ({ footnote: { id: `footnote-${number}`, number } });

describe("footnotes", () => {
  it("numbers the footnotes after a deleted table one lower", () => {
    let tab = buildTab([
      { runs: ["a", footnote("1"), "\n"] },
      { table: [[notedCell("in", "2")]] },
      { runs: ["tail", footnote("3"), "\n"] },
    ]);
    let [start, end] = span(tableElement(tab));
    let result = applyDocsRequests(tab, [deleteRange(start, end)]);

    expect(footnoteNumbers(result)).toEqual([["footnote-1", "1"], ["footnote-3", "2"]]);
    expect(markdownOf(result)).toBe("a\\[1\\]\n\ntail\\[2\\]\n");
  });

  it("numbers the footnotes after a deleted column one lower, in cells and in the body", () => {
    let tab = buildTab([
      { runs: ["\n"] },
      { table: [[notedCell("x", "1"), notedCell("y", "2")], ["\n", notedCell("z", "3")]] },
      { runs: ["tail", footnote("4"), "\n"] },
    ]);
    let result = applyDocsRequests(tab, [deleteColumn(2, 0)]);

    expect(footnoteNumbers(result)).toEqual([
      ["footnote-2", "1"], ["footnote-3", "2"], ["footnote-4", "3"],
    ]);
    expect(markdownOf(result)).toContain("<td><p>y[1]</p></td>");
    expect(markdownOf(result)).toContain("<td><p>z[2]</p></td>");
    expect(markdownOf(result)).toContain("tail\\[3\\]");
  });

  it("numbers the footnotes after deleted text one lower", () => {
    // "one" is at 1 to 3, its footnote at 4 and its line break at 5; "two" starts at 6.
    let tab = buildTab([
      { runs: ["one", footnote("1"), "\n"] },
      { runs: ["two\n"] },
      { runs: ["tail", footnote("2"), "\n"] },
    ]);
    let withinParagraph = applyDocsRequests(tab, [deleteRange(4, 5)]);
    let acrossParagraphs = applyDocsRequests(tab, [deleteRange(3, 7)]);

    expect(bodyParagraphs(withinParagraph).map(textOf)).toEqual(["one\n", "two\n", "tail\n"]);
    expect(bodyParagraphs(acrossParagraphs).map(textOf)).toEqual(["onwo\n", "tail\n"]);
    for (let result of [withinParagraph, acrossParagraphs]) {
      expect(footnoteNumbers(result)).toEqual([["footnote-2", "1"]]);
      expect(markdownOf(result)).toContain("tail\\[1\\]");
    }
  });

  it("numbers the footnotes after a deleted row one lower, in cells and in the body", () => {
    let tab = buildTab([
      { runs: ["\n"] },
      {
        table: [
          [notedCell("first", "1")], [notedCell("second", "2")], [notedCell("third", "3")],
        ],
      },
      { runs: ["tail", { footnote: { id: "footnote-4", number: "4" } }, "\n"] },
    ]);
    let result = applyDocsRequests(tab, [deleteRow(2, 0)]);

    expect(footnoteReferences(result)).toEqual([
      { footnoteId: "footnote-2", footnoteNumber: "1", textStyle: {} },
      { footnoteId: "footnote-3", footnoteNumber: "2", textStyle: {} },
      { footnoteId: "footnote-4", footnoteNumber: "3", textStyle: {} },
    ]);
    expect(markdownOf(result)).toContain("<td><p>second[1]</p></td>");
    expect(markdownOf(result)).toContain("tail\\[3\\]");
  });

  it("keeps a footnote reference in place, one index long, when text beside it changes", () => {
    let tab = buildTab([{ runs: ["ab", { footnote: { id: "footnote-1", number: "1" } }, "cd\n"] }]);
    let result = applyDocsRequests(tab, [insertText(2, "XY"), deleteRange(6, 7)]);
    let [paragraph] = bodyParagraphs(result);

    expect(paragraph.elements.map(span)).toEqual([[1, 5], [5, 6], [6, 8]]);
    expect(textOf(paragraph)).toBe("aXYbd\n");
    expect(paragraph.elements[1].footnoteReference?.footnoteNumber).toBe("1");
  });
});
