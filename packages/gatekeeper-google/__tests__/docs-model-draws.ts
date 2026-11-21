// The seeded model sequences: a random tab, a request of each kind at a place of it, and the
// property's runner, shared so the property and the slice tests draw the same sequences.

import { expect } from "vitest";
import type {
  GoogleDocsRequest, GoogleDocsTab, Paragraph, StructuralElement, TableCell, TableCellLocation,
} from "../src/docs-api";
import { applyDocsRequests, hasModelIndexes } from "../src/docs-model";
import type { ModelTextStyle } from "../src/docs-model";
import { buildTab, diceOf, presetLevels } from "./doc-fixture";
import type { BlockSpec, Dice, TableSpec } from "./doc-fixture";
import { expectRendersByRuns } from "./render-run-tabs";

/** The id of the tab every fixture of the model's tests is, which every coordinate names. */
export const TAB = "tab-1";

/** A link's destination, for a text style that sets one. */
export const LINK_A = { url: "https://a.example" };

/** The location `index` of the tab. */
export const at = (index: number) => ({ index, tabId: TAB });

/** The range `[startIndex, endIndex)` of the tab. */
export const range = (startIndex: number, endIndex: number) => ({ startIndex, endIndex, tabId: TAB });

/** The cell at a row and column of the table that starts at index `table`. */
export const cellAt = (table: number, rowIndex: number, columnIndex = 0): TableCellLocation =>
  ({ tableStartLocation: at(table), rowIndex, columnIndex });

/** An `insertText` of `text` at `index`. */
export const insertText = (index: number, text: string): GoogleDocsRequest =>
  ({ insertText: { location: at(index), text } });

/** A `deleteContentRange` of `[start, end)`. */
export const deleteRange = (start: number, end: number): GoogleDocsRequest =>
  ({ deleteContentRange: { range: range(start, end) } });

/** An `updateTextStyle` over `[start, end)` that names `fields`. */
export const styleText = (
  start: number, end: number, textStyle: ModelTextStyle, fields: string,
): GoogleDocsRequest => ({ updateTextStyle: { range: range(start, end), textStyle, fields } });

/** An `updateParagraphStyle` over `[start, end)` that names `fields`. */
export const styleParagraphs = (
  start: number, end: number, paragraphStyle: Record<string, unknown>, fields: string,
): GoogleDocsRequest =>
  ({ updateParagraphStyle: { range: range(start, end), paragraphStyle, fields } });

/** A `deleteParagraphBullets` over `[start, end)`. */
export const deleteBullets = (start: number, end: number): GoogleDocsRequest =>
  ({ deleteParagraphBullets: { range: range(start, end) } });

/** A `createParagraphBullets` over `[start, end)` with a preset. */
export const bullets = (start: number, end: number, bulletPreset: string): GoogleDocsRequest =>
  ({ createParagraphBullets: { range: range(start, end), bulletPreset } });

/** An `insertTable` of `rows` by `columns` at `index`. */
export const insertTable = (index: number, rows: number, columns: number): GoogleDocsRequest =>
  ({ insertTable: { rows, columns, location: at(index) } });

/** An `insertTableRow` beside a row of the table that starts at index `table`. */
export const insertRow = (table: number, rowIndex: number, insertBelow: boolean): GoogleDocsRequest =>
  ({ insertTableRow: { tableCellLocation: cellAt(table, rowIndex), insertBelow } });

/** An `insertTableColumn` beside a column of the table that starts at index `table`. */
export const insertColumn = (
  table: number, columnIndex: number, insertRight: boolean,
): GoogleDocsRequest =>
  ({ insertTableColumn: { tableCellLocation: cellAt(table, 0, columnIndex), insertRight } });

/** A `deleteTableRow` of a row of the table that starts at index `table`. */
export const deleteRow = (table: number, rowIndex: number): GoogleDocsRequest =>
  ({ deleteTableRow: { tableCellLocation: cellAt(table, rowIndex) } });

/** A `deleteTableColumn` of a column of the table that starts at index `table`. */
export const deleteColumn = (table: number, columnIndex: number): GoogleDocsRequest =>
  ({ deleteTableColumn: { tableCellLocation: cellAt(table, 0, columnIndex) } });

/** A `pinTableHeaderRows` of the first rows of the table that starts at index `table`. */
export const pinRows = (table: number, pinnedHeaderRowsCount: number): GoogleDocsRequest =>
  ({ pinTableHeaderRows: { tableStartLocation: at(table), pinnedHeaderRowsCount } });

/** A length of `magnitude` points. */
export const points = (magnitude: number) => ({ magnitude, unit: "PT" as const });

/** The bullet preset the gatekeeper sends for a bulleted list. */
export const BULLETED = "BULLET_DISC_CIRCLE_SQUARE";

/** The bullet preset the gatekeeper sends for a numbered list. */
export const NUMBERED = "NUMBERED_DECIMAL_ALPHA_ROMAN";

/** Every paragraph of `content` in document order, those of table cells included. */
function paragraphsIn(content: StructuralElement[]): Paragraph[] {
  return content.flatMap(element => element.paragraph
    ? [element.paragraph]
    : (element.table?.tableRows ?? []).flatMap(row =>
      (row.tableCells ?? []).flatMap(cell => paragraphsIn(cell.content ?? []))));
}

/** The tab's footnote references in document order, body and cells. */
export const footnoteReferences = (from: GoogleDocsTab) => paragraphsIn(from.body.content)
  .flatMap(paragraph => paragraph.elements)
  .flatMap(element => element.footnoteReference ? [element.footnoteReference] : []);

/** Each footnote reference of the tab as its ID and the number it shows, in document order. */
export const footnoteNumbers = (from: GoogleDocsTab) => footnoteReferences(from)
  .map(reference => [reference.footnoteId, reference.footnoteNumber]);

/** A merge of the cells of a table from one cell over a span of rows and columns. */
export const mergeCells = (
  table: number, rowIndex: number, columnIndex: number, rowSpan: number, columnSpan: number,
): GoogleDocsRequest => ({
  mergeTableCells: {
    tableRange: { tableCellLocation: cellAt(table, rowIndex, columnIndex), rowSpan, columnSpan },
  },
});

/** A split of the merged cell that holds one cell of a table. */
export const unmergeCells = (table: number, rowIndex: number, columnIndex: number): GoogleDocsRequest => ({
  unmergeTableCells: {
    tableRange: { tableCellLocation: cellAt(table, rowIndex, columnIndex), rowSpan: 1, columnSpan: 1 },
  },
});

/** What a run throws, as its message; nothing for a run that returns. */
function refusalOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return undefined;
}

/** A paragraph or table of a tab, with the list of elements that holds it. */
type Spot = { element: StructuralElement; container: StructuralElement[]; position: number };

/** Every paragraph of `content` in document order, those of table cells included. */
function paragraphSpots(content: StructuralElement[]): Spot[] {
  return content.flatMap((element, position): Spot[] => element.paragraph
    ? [{ element, container: content, position }]
    : tableCells(element).flatMap(cell => paragraphSpots(cell.content ?? [])));
}

/** Every table of `content` in document order, those nested in cells included. */
function tableSpots(content: StructuralElement[]): Spot[] {
  return content.flatMap((element, position): Spot[] => element.table
    ? [
      { element, container: content, position },
      ...tableCells(element).flatMap(cell => tableSpots(cell.content ?? [])),
    ]
    : []);
}

function tableCells(element: StructuralElement): TableCell[] {
  return (element.table?.tableRows ?? []).flatMap(row => row.tableCells ?? []);
}

/** The last paragraph of every table cell of `content`, in document order. */
function cellEndSpots(content: StructuralElement[]): Spot[] {
  return paragraphSpots(content).filter(({ container, position }) =>
    container !== content && position === container.length - 1);
}

/** Every paragraph that lies in a cell of a table that itself lies in a cell. */
function nestedParagraphSpots(content: StructuralElement[]): Spot[] {
  return content.flatMap(tableCells)
    .flatMap(cell => (cell.content ?? []).flatMap(tableCells))
    .flatMap(cell => paragraphSpots(cell.content ?? []));
}

/** Lines longer than what follows a paragraph of a random tab's nested table in its holders. */
const NESTED_LINES = "one\ntwo\nthree\nfour\n".repeat(2);

const hasMergedCell = (element: StructuralElement) => tableCells(element).some(cell =>
  (cell.tableCellStyle?.rowSpan ?? 1) > 1 || (cell.tableCellStyle?.columnSpan ?? 1) > 1);

/** The two lists a random tab's items belong to: one as a preset makes it, one of one level. */
const RANDOM_LISTS = (): GoogleDocsTab["lists"] => ({
  made: { listProperties: { nestingLevels: presetLevels() } },
  N1: { listProperties: { nestingLevels: [{ glyphType: "DECIMAL" }] } },
});

const PARAGRAPH_TEXTS = [
  "alpha", "two words", "\u{1F600} smile", "\tindented", "x", "", "a longer line of text",
];

const CELL_TEXTS = ["a", "cell", "", "two words", "\u{1F7E2} ok", "\ttabbed"];

const INSERTED_TEXTS = [
  "x", "two words", "a\nb", "\n", "\tdeep", "\t", "a\u0001b", "\u0001", "\u{1F600}",
  "one\ntwo\nthree",
];

const TEXT_STYLES: [ModelTextStyle, string][] = [
  [{ bold: true }, "bold"], [{ italic: true }, "bold,italic"], [{ link: LINK_A }, "link"],
  [{}, "link"], [{ foregroundColor: { color: { rgbColor: { red: 1 } } } }, "foregroundColor"],
];

const PARAGRAPH_STYLES: [Record<string, unknown>, string][] = [
  [{ namedStyleType: "HEADING_2" }, "namedStyleType"],
  [{ namedStyleType: "NORMAL_TEXT" }, "namedStyleType"],
  [{ indentStart: points(0), indentFirstLine: points(0) }, "indentStart,indentFirstLine"],
];

/**
 * A tab of three to eight blocks of every kind the model indexes. A noted tab also holds two to
 * four footnote references numbered by place, around and inside a table.
 */
export function randomTab({ below, pick }: Dice, noted: boolean): GoogleDocsTab {
  let line = (text: string) => ({ runs: [`${text}\n`] });
  let grid = (): TableSpec => ({
    table: Array.from({ length: 1 + below(3) }, () =>
      Array.from({ length: 1 + below(3) }, () => below(5) === 0
        ? { paragraphs: [line(pick(CELL_TEXTS)), line(pick(CELL_TEXTS))] }
        : `${pick(CELL_TEXTS)}\n`)),
  });
  let kinds: (() => BlockSpec)[] = [
    () => line(pick(PARAGRAPH_TEXTS)),
    () => line(pick(PARAGRAPH_TEXTS)),
    () => ({ ...line(pick(PARAGRAPH_TEXTS)), namedStyleType: "HEADING_2" }),
    () => ({ ...line(pick(PARAGRAPH_TEXTS)), bullet: { listId: "made", nestingLevel: below(3) } }),
    () => ({ ...line(pick(PARAGRAPH_TEXTS)), bullet: { listId: "N1" } }),
    grid,
    () => ({
      table: [[
        {
          paragraphs: [
            line("outer"),
            { table: [[{ paragraphs: [line("in a"), line("\tin tab")] }, "in b\n"]] },
            line(""),
          ],
        },
        "side\n",
      ]],
    }),
    () => below(2) === 0
      ? { structure: "tableOfContents", length: 2 + below(3) }
      : { structure: "sectionBreak", length: 2 },
    () => ({ runs: ["Owner ", { person: { name: "Ana", email: "" } }, " here\n"] }),
  ];
  let blocks = Array.from({ length: 3 + below(6) }, () => pick(kinds)());
  blocks[below(blocks.length)] = grid();
  if (noted) {
    let places = below(5) < 3 ? [0, 1, 2, 3] : [0, 1, 2, 3].filter(() => below(3) > 0);
    while (places.length < 2) places = [...new Set([...places, below(4)])];
    let note = (place: number, text: string) => ({
      runs: [text, ...(places.includes(place) ? [{ footnote: { id: `fn.${place}`, number: "0" } }] : []), "\n"],
    });
    let rows = 2 + below(2);
    let columns = 2 + below(2);
    let table = Array.from({ length: rows }, (_, row) =>
      Array.from({ length: columns }, (__, column) => ({
        paragraphs: [
          row === 0 && column === 1 ? note(1, "right") : row === 1 && column === 0
            ? note(2, "below") : line(pick(CELL_TEXTS)),
        ],
      })));
    blocks.splice(below(blocks.length + 1), 0, note(0, "intro"), { table }, note(3, "tail"));
  }
  // As in a document of Google's, a paragraph stands before and after every table and at the end.
  let spaced: BlockSpec[] = [];
  for (let block of blocks) {
    let previous = spaced.at(-1);
    if ("table" in block && (!previous || !("runs" in previous))) spaced.push(line(""));
    spaced.push(block);
  }
  let last = spaced.at(-1);
  if (!last || !("runs" in last)) spaced.push(line(""));
  let tab = buildTab(spaced, RANDOM_LISTS());
  footnoteReferences(tab).forEach((reference, index) => {
    reference.footnoteNumber = String(index + 1);
  });
  return tab;
}

/** What a random request draws on: the tab as it stands, and how to choose a place in it. */
export type Draw = Dice & {
  doc: GoogleDocsTab;
  /** One of `spots`: any of them, or, back to front, one no later than the place before. */
  choose: (spots: Spot[]) => Spot | undefined;
};

/** One request of each kind the model takes, at a place of the tab as it stands. */
export const REQUEST_KINDS: ((draw: Draw) => GoogleDocsRequest | undefined)[] = [
  function insertTextAt({ doc, choose, below, pick }) {
    let spot = choose(paragraphSpots(doc.body.content));
    if (!spot) return undefined;
    let { startIndex, endIndex } = spot.element;
    // Sometimes the index before the paragraph, which may be no paragraph's.
    let index = below(12) === 0 ? startIndex - 1 : startIndex + below(endIndex - startIndex);
    return insertText(index, pick(INSERTED_TEXTS));
  },
  function deleteInsideParagraph({ doc, choose, below }) {
    let spot = choose(paragraphSpots(doc.body.content)
      .filter(({ element }) => element.endIndex - element.startIndex >= 2));
    if (!spot) return undefined;
    let { startIndex, endIndex } = spot.element;
    let start = startIndex + below(endIndex - startIndex - 1);
    return deleteRange(start, start + 1 + below(endIndex - 1 - start));
  },
  function deleteAcrossParagraphs({ doc, choose, below }) {
    let spot = choose(paragraphSpots(doc.body.content)
      .filter(({ container, position }) => container[position + 1]?.paragraph));
    if (!spot) return undefined;
    let { startIndex, endIndex } = spot.element;
    // Up to the next paragraph's start, into it, or over its line break.
    let next = spot.container[spot.position + 1 + below(2)] ?? spot.container[spot.position + 1];
    let into = [0, 0, below(next.endIndex - next.startIndex), next.endIndex - next.startIndex];
    return deleteRange(
      startIndex + below(endIndex - startIndex), next.startIndex + into[below(into.length)]);
  },
  function deleteWholeTable({ doc, choose }) {
    let spot = choose(tableSpots(doc.body.content));
    return spot && deleteRange(spot.element.startIndex, spot.element.endIndex);
  },
  function styleTextAt({ doc, choose, below, pick }) {
    let spot = choose(paragraphSpots(doc.body.content));
    if (!spot) return undefined;
    let { startIndex, endIndex } = spot.element;
    let start = startIndex + below(endIndex - startIndex);
    // Within the paragraph, its line break included, or on into the next one.
    let end = start + 1 + below(endIndex - start + (below(6) === 0 ? 2 : 0));
    return styleText(start, end, ...pick(TEXT_STYLES));
  },
  function styleParagraphsAt({ doc, choose, below, pick }) {
    let spot = choose(paragraphSpots(doc.body.content));
    if (!spot) return undefined;
    let { startIndex, endIndex } = spot.element;
    return styleParagraphs(startIndex, endIndex + below(3), ...pick(PARAGRAPH_STYLES));
  },
  function deleteBulletsAt({ doc, choose, below }) {
    let spot = choose(paragraphSpots(doc.body.content));
    return spot && deleteBullets(spot.element.startIndex, spot.element.endIndex + below(2));
  },
  function createBulletsAt({ doc, choose, below, pick }) {
    let spots = paragraphSpots(doc.body.content);
    let plain = spots.filter(({ element }) => !element.paragraph?.bullet);
    let spot = choose(plain.length > 0 && below(4) > 0 ? plain : spots);
    if (!spot) return undefined;
    let last = spot.container[spot.position + below(3)] ?? spot.element;
    return bullets(
      spot.element.startIndex, last.endIndex,
      below(20) === 0 ? "BULLET_CHECKBOX" : pick([BULLETED, NUMBERED]));
  },
  function insertTableAt({ doc, choose, below }) {
    let spot = choose(paragraphSpots(doc.body.content));
    if (!spot) return undefined;
    let { startIndex, endIndex } = spot.element;
    let index = [startIndex, endIndex - 1, endIndex - 1, startIndex + 1][below(4)];
    return insertTable(index, below(10) === 0 ? 0 : 1 + below(2), 1 + below(2));
  },
  ...([
    (table, row) => insertRow(table, row, true),
    (table, row) => insertRow(table, row, false),
    (table, _, column) => insertColumn(table, column, true),
    (table, _, column) => insertColumn(table, column, false),
    (table, row) => deleteRow(table, row),
    (table, _, column) => deleteColumn(table, column),
    (table, row) => pinRows(table, row),
    (table, _, column) => ({
      updateTableColumnProperties: {
        tableStartLocation: at(table), columnIndices: [column],
        tableColumnProperties: { widthType: "FIXED_WIDTH", width: points(40 + column) },
        fields: "widthType,width",
      },
    }),
    (table, row, column) => ({
      updateTableCellStyle: {
        tableRange: { tableCellLocation: cellAt(table, row, column), rowSpan: 1, columnSpan: 1 },
        tableCellStyle: { backgroundColor: { color: { rgbColor: { green: 1 } } } },
        fields: "backgroundColor",
      },
    }),
    (table, row) => ({
      updateTableRowStyle: {
        tableStartLocation: at(table), rowIndices: [row],
        tableRowStyle: { minRowHeight: points(20 + row) }, fields: "minRowHeight",
      },
    }),
    (table, row, column, rows, columns, below) =>
      mergeCells(table, row, column, 1 + below(rows - row), 1 + below(columns - column)),
    (table, row, column) => unmergeCells(table, row, column),
  ] satisfies ((
    table: number, row: number, column: number, rows: number, columns: number,
    below: Dice["below"],
  ) => GoogleDocsRequest)[]).map(build => ({ doc, choose, below }: Draw) => {
    let spot = choose(tableSpots(doc.body.content));
    let rows = spot?.element.table?.tableRows ?? [];
    let columns = rows[0]?.tableCells?.length ?? 0;
    if (!spot || columns === 0) return undefined;
    return build(
      spot.element.startIndex, below(rows.length), below(columns), rows.length, columns, below);
  }),
];

/** A footnote reference of the tab, and for one in a cell of a body's table, that cell. */
type ReferencePlace = { startIndex: number; table?: number; row?: number; column?: number };

/** Every footnote reference of `doc`'s body, in the body's order, those in table cells included. */
export function referencePlaces(doc: GoogleDocsTab): ReferencePlace[] {
  let references = (content: StructuralElement[]) => paragraphsIn(content)
    .flatMap(paragraph => paragraph.elements.filter(element => element.footnoteReference));
  return doc.body.content.flatMap((element): ReferencePlace[] => element.table
    ? (element.table.tableRows ?? []).flatMap((tableRow, row) =>
      (tableRow.tableCells ?? []).flatMap((cell, column) =>
        references(cell.content ?? []).map(({ startIndex }) =>
          ({ startIndex, table: element.startIndex, row, column }))))
    : references([element]).map(({ startIndex }) => ({ startIndex })));
}

/**
 * A request that removes a footnote reference, or moves one past another: a deletion over one,
 * the row or the column of one, or a merge of a cell that holds one into the cell above it.
 */
export function notedRequest({ doc, below, pick }: Draw): GoogleDocsRequest | undefined {
  let places = referencePlaces(doc);
  let inCells = places.filter(place => place.table !== undefined);
  let kind = below(5);
  if (kind === 0 || inCells.length === 0) {
    let place = places.length > 0 ? pick(places) : undefined;
    return place && deleteRange(place.startIndex, place.startIndex + 1);
  }
  let { table = 0, row = 0, column = 0 } = pick(inCells);
  if (kind === 1) return deleteRow(table, row);
  if (kind === 2) return deleteColumn(table, column);
  let below1 = inCells.find(place => (place.row ?? 0) > 0);
  return below1 && mergeCells(below1.table ?? 0, (below1.row ?? 0) - 1, below1.column ?? 0, 2, 1);
}

/** What random sequences reached, so that a test can say its generator covers what it is for. */
export type Tally = {
  applied: number;
  refused: number;
  /** Applied requests of each kind after which a footnote that stayed shows another number. */
  renumbered: { deleteContentRange: number; deleteTableRow: number; deleteTableColumn: number };
  /** Applied merges that changed the order of the tab's footnote references. */
  mergesThatMoved: number;
  /** A change to a paragraph's length and then a deletion up to the next paragraph's start. */
  joinsAfterTouch: number;
  /** Requests refused at a cell that a merge, sent after a request into its table, covers. */
  coveredRefusals: number;
  /** Requests applied at such a cell once it was split again. */
  uncovered: number;
  /** Lines inserted in a cell of a table in a cell, and then a request inside those lines. */
  nestedGrowths: number;
  /** Tabbed paragraphs at the end of a cell made list items, then a request at the cell's end. */
  bulletedCellEnds: number;
  /** A table put into the last paragraph of a cell, and then a request at the cell's end. */
  tablesAtCellEnds: number;
};

const COVERED_CELL = "a request at a paragraph of a cell that a merged cell covers";

/** Handed each model call before it is made, in place of the property's checks; same draws. */
export type SequenceCalls = (call: {
  tab: GoogleDocsTab;
  requests: readonly GoogleDocsRequest[];
  sequence: number;
  /** Whether it is the request alone on the chain's tab; otherwise the batch so far. */
  alone: boolean;
  where: () => string;
}) => void;

/** A run of the dice over `runSequences`, taken in parts that share one tally. */
export type SequenceRun = { dice: ReturnType<typeof diceOf>; tally: Tally; next: number };

/** A run of the dice of `seed` that has drawn no sequence yet. */
export function sequenceRun(seed: number): SequenceRun {
  return {
    dice: diceOf(seed),
    tally: {
      applied: 0, refused: 0,
      renumbered: { deleteContentRange: 0, deleteTableRow: 0, deleteTableColumn: 0 },
      mergesThatMoved: 0, joinsAfterTouch: 0, coveredRefusals: 0, uncovered: 0,
      nestedGrowths: 0, bulletedCellEnds: 0, tablesAtCellEnds: 0,
    },
    next: 0,
  };
}

/**
 * The property: after each request of a random sequence, the requests so far as one batch give
 * the same tab, exact indexes, and refusals as one batch each. `between` is applied to the chain's
 * tab before each request; `each` replaces the checks.
 */
export function runSequences(
  seed: number, sequences: number, backToFront: boolean,
  between: (tab: GoogleDocsTab) => GoogleDocsTab = tab => tab, each?: SequenceCalls,
  run: SequenceRun = sequenceRun(seed),
): Tally {
  let { dice, tally } = run;
  let { random, below, pick } = dice;
  let first = run.next;
  run.next += sequences;
  for (let sequence = first; sequence < first + sequences; sequence++) {
    let noted = sequence % 2 === 0;
    let tab = randomTab(dice, noted);
    let eager = tab;
    let applied: GoogleDocsRequest[] = [];
    let where = () => `seed ${seed}, sequence ${sequence}, after ${JSON.stringify(applied)}`;
    // Every tab of the chain renders by runs as whole, and its runs' summaries and keys hold.
    if (!each) expectRendersByRuns(tab, where(), "every", { stored: true });

    /** Hold one request to the property. Gives the refusal's message when it is refused. */
    let step = (request: GoogleDocsRequest): string | undefined => {
      let after: GoogleDocsTab;
      if (each) {
        each({ tab: between(eager), requests: [request], sequence, alone: true, where });
        each({ tab, requests: [...applied, request], sequence, alone: false, where });
      }
      try {
        after = applyDocsRequests(between(eager), [request]);
      } catch (error) {
        let message = error instanceof Error ? error.message : String(error);
        if (!each) {
          expect(refusalOf(() => applyDocsRequests(tab, [...applied, request])), where())
            .toBe(message);
        }
        tally.refused++;
        return message;
      }
      let numbers = new Map(footnoteNumbers(eager).map(([id, number]) => [id, number]));
      let renumbered = footnoteNumbers(after).some(([id, number]) => numbers.get(id) !== number);
      for (let kind of ["deleteContentRange", "deleteTableRow", "deleteTableColumn"] as const) {
        if (kind in request && renumbered) tally.renumbered[kind]++;
      }
      let order = (from: GoogleDocsTab) => footnoteNumbers(from).map(([id]) => id).join();
      if ("mergeTableCells" in request && order(after) !== order(eager)) tally.mergesThatMoved++;
      applied.push(request);
      eager = after;
      if (!each) {
        expect(applyDocsRequests(tab, applied), where()).toEqual(eager);
        expect(hasModelIndexes(eager), where()).toBe(true);
        expectRendersByRuns(eager, where(), "every", { stored: true });
      }
      tally.applied++;
      return undefined;
    };

    let count = 6 + below(7);
    // Back to front, each place is drawn no later in the tab than the one before it.
    let fractions = Array.from({ length: count }, random).toSorted((a, b) => b - a);
    let limit = Infinity;
    let turn = 0;
    let choose = (spots: Spot[]): Spot | undefined => {
      if (!backToFront) return spots[below(spots.length)];
      let target = Math.min(limit, fractions[turn] * (eager.body.content.at(-1)?.endIndex ?? 0));
      let chosen = spots.filter(({ element }) => element.startIndex <= target).at(-1) ?? spots[0];
      if (chosen) limit = Math.min(limit, chosen.element.startIndex);
      return chosen;
    };

    /** A length change, then a deletion that ends where the changed paragraph ends. */
    let lengthThenJoin = () => {
      let spots = paragraphSpots(eager.body.content)
        .filter(({ container, position }) => container[position + 1]?.paragraph);
      let spot = spots[below(spots.length)];
      if (!spot) return;
      let { startIndex, endIndex } = spot.element;
      let first = endIndex - startIndex >= 3 && below(2) === 0
        ? deleteRange(startIndex, startIndex + 1)
        : insertText(startIndex + below(endIndex - startIndex), "xy");
      if (step(first) !== undefined) return;
      let changed = paragraphSpots(eager.body.content)
        .find(({ element }) => element.startIndex === startIndex);
      if (!changed) return;
      let end = changed.element.endIndex;
      if (step(deleteRange(startIndex + below(end - startIndex), end)) === undefined) {
        tally.joinsAfterTouch++;
      }
    };

    /** A table of no merged cell, a merge in it, then a request at a cell the merge covers. */
    let coverThenRequest = () => {
      let tables = tableSpots(eager.body.content).filter(({ element, container }) =>
        container === eager.body.content && !hasMergedCell(element) &&
        tableCells(element).length >= 2);
      let spot = tables[below(tables.length)];
      if (!spot) return;
      let table = spot.element.startIndex;
      let rows = spot.element.table?.tableRows ?? [];
      let columns = rows[0]?.tableCells?.length ?? 0;
      let firstIndex = (row: number, column: number) => eager.body.content
        .find(element => element.startIndex === table)
        ?.table?.tableRows?.[row]?.tableCells?.[column]?.content?.[0]?.startIndex ?? 0;
      if (step(insertText(firstIndex(below(rows.length), below(columns)), "x")) !== undefined) {
        return;
      }
      let across = columns >= 2 && (rows.length < 2 || below(2) === 0);
      let top = below(across ? rows.length : rows.length - 1);
      let left = below(across ? columns - 1 : columns);
      if (step(mergeCells(table, top, left, across ? 1 : 2, across ? 2 : 1)) !== undefined) return;
      let covered = (): number => firstIndex(across ? top : top + 1, across ? left + 1 : left);
      let index = covered();
      let answer = step(pick([
        insertText(index, "x"), styleText(index, index + 1, { bold: true }, "bold"),
        styleParagraphs(index, index + 1, { namedStyleType: "HEADING_2" }, "namedStyleType"),
        deleteBullets(index, index + 1), deleteRange(index, index + 1),
      ]));
      expect(answer, where()).toContain(COVERED_CELL);
      tally.coveredRefusals++;
      if (below(2) === 0) return;
      expect(step(unmergeCells(table, top, left)), where()).toBeUndefined();
      expect(step(insertText(covered(), "y")), where()).toBeUndefined();
      tally.uncovered++;
    };

    /** A request at the line break that ends the cell whose paragraph starts at `start`. */
    let atCellEnd = (start: number): string | undefined => {
      let cell = paragraphSpots(eager.body.content)
        .find(({ element }) => element.startIndex === start)?.container;
      let index = (cell?.at(-1)?.endIndex ?? 0) - 1;
      return step(pick([
        insertText(index, "x"), styleText(index, index + 1, { bold: true }, "bold"),
        styleParagraphs(index, index + 1, { namedStyleType: "HEADING_2" }, "namedStyleType"),
      ]));
    };

    // Pairs whose second request lies past where a holder of the first one's change ended.
    let growNestedThenInside = () => {
      let spots = nestedParagraphSpots(eager.body.content);
      let spot = spots[below(spots.length)];
      if (!spot) return;
      let { startIndex, endIndex } = spot.element;
      let index = startIndex + below(endIndex - startIndex);
      if (step(insertText(index, NESTED_LINES)) !== undefined) return;
      // In the last of the lines, which no holder reached before they were inserted.
      let inside = index + NESTED_LINES.length - 2 - below(3);
      let second = pick([
        insertText(inside, "x"), styleText(inside, inside + 1, { bold: true }, "bold"),
        deleteRange(inside, inside + 1),
      ]);
      if (step(second) === undefined) tally.nestedGrowths++;
    };
    let bulletCellEndThenBreak = () => {
      let ends = cellEndSpots(eager.body.content)
        .filter(({ element }) => !element.paragraph?.bullet);
      let spot = ends[below(ends.length)];
      if (!spot) return;
      let { container } = spot;
      let from = spot.position;
      while (from > 0 && below(2) === 0 && container[from - 1].paragraph &&
        !container[from - 1].paragraph?.bullet) from--;
      let start = container[from].startIndex;
      // A tab ahead of one of them, when none starts with one: bullets take the tabs off.
      let tabbed = container.slice(from).some(({ paragraph }) =>
        paragraph?.elements[0]?.textRun?.content.startsWith("\t"));
      let untabbed = container[from + below(container.length - from)].startIndex;
      if (!tabbed && step(insertText(untabbed, "\t")) !== undefined) return;
      let end = paragraphSpots(eager.body.content)
        .find(({ element }) => element.startIndex === start)?.container.at(-1)?.endIndex ?? 0;
      if (step(bullets(start, end, pick([BULLETED, NUMBERED]))) !== undefined) return;
      if (atCellEnd(start) === undefined) tally.bulletedCellEnds++;
    };
    let tableAtCellEndThenBreak = () => {
      let ends = cellEndSpots(eager.body.content);
      let spot = ends[below(ends.length)];
      if (!spot) return;
      let { startIndex, endIndex } = spot.element;
      let index = below(2) === 0 ? startIndex : endIndex - 1;
      if (step(insertTable(index, 1 + below(2), 1 + below(2))) !== undefined) return;
      if (atCellEnd(startIndex) === undefined) tally.tablesAtCellEnds++;
    };
    let holderPairs = [growNestedThenInside, bulletCellEndThenBreak, tableAtCellEndThenBreak];

    let scripted = below(3);
    for (; turn < count; turn++) {
      if (turn === scripted && sequence % 3 === 1) lengthThenJoin();
      else if (turn === scripted && sequence % 4 === 0) coverThenRequest();
      if (turn === scripted + 2) holderPairs[sequence % holderPairs.length]();
      let draw: Draw = { ...dice, doc: eager, choose };
      let request = (noted && below(3) === 0 ? notedRequest(draw) : undefined) ??
        pick(REQUEST_KINDS)(draw);
      if (request) step(request);
    }
  }
  return tally;
}

/** A call the sequences make of the model, as text: the tab and the batch are parsed where read. */
export type RecordedCall = {
  /** The JSON of `[tab, requests]`. */
  json: string;
  sequence: number;
  /** Whether it is the request alone on the chain's tab; otherwise the batch so far. */
  alone: boolean;
  /** What `where()` said when the call was made. */
  where: string;
};

/** Every model call the sequences of `seed` make, in order (two a request), with the tally. */
export function recordedSequenceCalls(
  seed: number, sequences: number, backToFront: boolean,
): { tally: Tally; calls: RecordedCall[] } {
  let calls: RecordedCall[] = [];
  let tally = runSequences(seed, sequences, backToFront, tab => tab, call => {
    calls.push({
      json: JSON.stringify([call.tab, call.requests]), sequence: call.sequence,
      alone: call.alone, where: call.where(),
    });
  });
  return { tally, calls };
}
