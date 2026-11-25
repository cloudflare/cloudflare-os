import { expect } from "vitest";
import type { GoogleDocSnapshot } from "../src/doc-actions";
import type {
  GoogleDocsDocument, GoogleDocsRequest, GoogleDocsTab, NestingLevel, ParagraphElement,
  StructuralElement, TableCellStyle, TextStyle,
} from "../src/docs-api";
import { storedDocCopy } from "../src/docs-copy";
import { applyDocsRequests } from "../src/docs-model";
import type { ModelOptions } from "../src/docs-model";
import type { DocStore } from "../src/docs-store";
import { docTabToMarkdown } from "../src/markdown-converter";
import type { DocTabSnapshot } from "../src/markdown-converter";

type ParagraphPart =
  /** Text, and the suggestion it is or whose style change it carries, where it is suggested. */
  | { text: string; style?: TextStyle; suggested?: Suggestion | "style" }
  | { person: { name?: string; email: string }; style?: TextStyle }
  | { richLink: { title: string; uri: string }; style?: TextStyle }
  | { date: string; style?: TextStyle }
  /** A dropdown chip showing this value. */
  | { dropdown: string; style?: TextStyle }
  | { footnote: { id: string; number: string }; style?: TextStyle }
  | { autoText: "PAGE_NUMBER" | "PAGE_COUNT"; style?: TextStyle }
  | { horizontalRule: true };

/** One paragraph of a tab `buildTab` builds: its runs, named style and list item. */
export type ParagraphSpec = {
  runs: (ParagraphPart | string)[];
  namedStyleType?: string;
  bullet?: { listId: string; nestingLevel?: number };
  /** A suggested change to the paragraph's style, or to its bullet. */
  suggestedChange?: "style" | "bullet";
};

type Suggestion = "insertion" | "deletion";

type TableCellContent = {
  /** The cell's content in order: paragraphs, and tables nested in the cell. */
  paragraphs: (ParagraphSpec | TableSpec)[];
  tableCellStyle?: TableCellStyle;
  /** Marks the cell as a suggested insertion, or as suggested for deletion. */
  suggested?: Suggestion;
};
/** One cell of a `TableSpec`: its content, or the text of the one paragraph it holds. */
export type CellSpec = string | TableCellContent;
/** One table of a tab `buildTab` builds. */
export type TableSpec = {
  table: CellSpec[][];
  /** How many rows, from the first, are pinned as header rows. */
  headerRows?: number;
  /** Rows, by index, that are suggested: the row and each of its cells carry the suggestion. */
  suggestedRows?: Record<number, Suggestion>;
  /** Each column's fixed width in points, or `null` for one evenly distributed. */
  columns?: (number | null)[];
  /** Each row's minimum height in points, as Google stores it: 0 leaves it out. */
  heights?: number[];
};
type StructuralSpec = { structure: "sectionBreak" | "tableOfContents"; length?: number };
/** One block of a tab `buildTab` builds: a paragraph, a table or a structural element. */
export type BlockSpec = ParagraphSpec | TableSpec | StructuralSpec;
/** The list definitions of a tab, by list id. */
export type Lists = GoogleDocsTab["lists"];

/**
 * Builds a normalized `GoogleDocsTab` with the index bookkeeping the real API applies: a section
 * break occupies index 0, followed by paragraphs and tables in one shared index space.
 *
 * Every paragraph's last run must end in "\n", as Google's own responses do.
 */
export function buildTab(
  blocks: BlockSpec[],
  lists: Lists = {},
): GoogleDocsTab {
  let index = 1;
  let content: StructuralElement[] = [{ startIndex: 0, endIndex: 1, sectionBreak: {} }];

  for (let spec of blocks) {
    if ("table" in spec) {
      let table = buildTable(index, spec);
      content.push(table);
      index = table.endIndex;
      continue;
    }
    if ("structure" in spec) {
      let endIndex = index + (spec.length ?? 1);
      content.push(spec.structure === "sectionBreak"
        ? { startIndex: index, endIndex, sectionBreak: {} }
        : { startIndex: index, endIndex, tableOfContents: {} });
      index = endIndex;
      continue;
    }
    let paragraph = buildParagraph(index, spec);
    content.push(paragraph);
    index = paragraph.endIndex;
  }

  return {
    tabId: "tab-1",
    title: "Fixture",
    index: 0,
    nestingLevel: 0,
    body: { content },
    lists,
    namedRanges: {},
  };
}

function buildParagraph(startIndex: number, spec: ParagraphSpec): StructuralElement {
  let index = startIndex;
  let elements: ParagraphElement[] = spec.runs.map(run => {
    if (typeof run === "string" || "text" in run) {
      let { text, style, suggested } = typeof run === "string" ? { text: run } : run;
      let runStart = index;
      index += text.length;
      return {
        startIndex: runStart,
        endIndex: index,
        textRun: {
          content: text, textStyle: style ?? {},
          ...suggested === "style"
            ? { suggestedTextStyleChanges: { "suggest.fixture": {} } } : suggestionIds(suggested),
        },
      };
    }
    let runStart = index++;
    if ("person" in run) {
      return {
        startIndex: runStart, endIndex: index,
        person: { personProperties: run.person, textStyle: run.style ?? {} },
      };
    }
    if ("richLink" in run) {
      return {
        startIndex: runStart, endIndex: index,
        richLink: { richLinkProperties: run.richLink, textStyle: run.style ?? {} },
      };
    }
    if ("date" in run) {
      return {
        startIndex: runStart, endIndex: index,
        dateElement: { dateElementProperties: { displayText: run.date }, textStyle: run.style ?? {} },
      };
    }
    if ("dropdown" in run) {
      return {
        startIndex: runStart, endIndex: index,
        dropdown: { dropdownProperties: { displayValue: run.dropdown }, textStyle: run.style ?? {} },
      };
    }
    if ("footnote" in run) {
      return {
        startIndex: runStart, endIndex: index,
        footnoteReference: {
          footnoteId: run.footnote.id,
          footnoteNumber: run.footnote.number,
          textStyle: run.style ?? {},
        },
      };
    }
    if ("autoText" in run) {
      return {
        startIndex: runStart, endIndex: index,
        autoText: { type: run.autoText, textStyle: run.style ?? {} },
      };
    }
    return { startIndex: runStart, endIndex: index, horizontalRule: {} };
  });
  return {
    startIndex,
    endIndex: index,
    paragraph: {
      elements,
      paragraphStyle: { namedStyleType: spec.namedStyleType ?? "NORMAL_TEXT" },
      bullet: spec.bullet,
      ...spec.suggestedChange === "style"
        ? { suggestedParagraphStyleChanges: { "suggest.fixture": {} } } : {},
      ...spec.suggestedChange === "bullet"
        ? { suggestedBulletChanges: { "suggest.fixture": {} } } : {},
    },
  };
}

/** The suggestion IDs Google marks a suggested table row or cell with. */
function suggestionIds(suggested: Suggestion | undefined): {
  suggestedInsertionIds?: string[];
  suggestedDeletionIds?: string[];
} {
  if (suggested === undefined) return {};
  return suggested === "insertion"
    ? { suggestedInsertionIds: ["suggest.fixture"] }
    : { suggestedDeletionIds: ["suggest.fixture"] };
}

/**
 * Build a Google Docs table element with the provider's nested index layout. A table nested in a
 * cell continues the same index space.
 */
function buildTable(startIndex: number, spec: TableSpec): StructuralElement {
  let index = startIndex + 1;
  let tableRows = spec.table.map((row, rowIndex) => {
    let rowStart = index++;
    let suggestedRow = suggestionIds(spec.suggestedRows?.[rowIndex]);
    let tableCells = row.map(cell => {
      let cellStart = index++;
      let { paragraphs, tableCellStyle, suggested }: TableCellContent =
        typeof cell === "string" ? { paragraphs: [{ runs: [cell] }] } : cell;
      let content = paragraphs.map(part => {
        let element = "table" in part ? buildTable(index, part) : buildParagraph(index, part);
        index = element.endIndex;
        return element;
      });
      return {
        startIndex: cellStart,
        endIndex: index,
        content,
        ...(tableCellStyle ? { tableCellStyle } : {}),
        ...suggestedRow,
        ...suggestionIds(suggested),
      };
    });
    let header = rowIndex < (spec.headerRows ?? 0);
    let height = spec.heights?.[rowIndex] ?? 0;
    return {
      startIndex: rowStart,
      endIndex: index,
      tableCells,
      ...(header || height > 0
        ? {
          tableRowStyle: {
            ...(header ? { tableHeader: true } : {}),
            ...(height > 0 ? { minRowHeight: { magnitude: height, unit: "PT" } } : {}),
          },
        }
        : {}),
      ...suggestedRow,
    };
  });

  return {
    startIndex,
    endIndex: index + 1,
    table: {
      tableRows,
      ...(spec.columns
        ? {
          tableStyle: {
            tableColumnProperties: spec.columns.map(width => width === null
              ? { widthType: "EVENLY_DISTRIBUTED" }
              : { widthType: "FIXED_WIDTH", width: { magnitude: width, unit: "PT" } }),
          },
        }
        : {}),
    },
  };
}

/** A tab holding one single-cell table, which is all most table rendering tests need. */
export function cellTab(
  paragraphs: ParagraphSpec[],
  lists?: Lists,
): GoogleDocsTab {
  return buildTab([{ table: [[{ paragraphs }]] }], lists);
}

/**
 * The HTML a read gives for a table whose cells hold `cells` as plain text, a line break in a
 * text starting a paragraph of its cell: the renderer's own output for such a table.
 */
export function tableHtml(cells: readonly (readonly string[])[]): string {
  let table = cells.map(row => row.map(text =>
    ({ paragraphs: text.split("\n").map(line => ({ runs: [`${line}\n`] })) })));
  let { markdown, sourceMap } = docTabToMarkdown(buildTab([{ table }, { runs: ["\n"] }]));
  let [{ mdStart, mdEnd }] = sourceMap.tables;
  return markdown.slice(mdStart, mdEnd);
}

/** A normal paragraph holding `text`. */
export const para = (text: string): ParagraphSpec => ({ runs: [`${text}\n`] });

/** A heading holding `text`, of level 2 unless `level` says otherwise. */
export const heading = (text: string, level = 2): ParagraphSpec =>
  ({ runs: [`${text}\n`], namedStyleType: `HEADING_${level}` });

/**
 * An item of the list `listId` (`L1`, the list of `BULLET_LIST`, unless given) holding `text`,
 * at `nestingLevel` when one is given.
 */
export const item = (text: string, listId = "L1", nestingLevel?: number): ParagraphSpec =>
  ({ runs: [`${text}\n`], bullet: { listId, ...(nestingLevel ? { nestingLevel } : {}) } });

/** A table whose cells each hold one paragraph of the text given for it. */
export const grid = (...rows: string[][]): TableSpec =>
  ({ table: rows.map(row => row.map(text => `${text}\n`)) });

/** A cell holding these paragraphs and nested tables, in order. */
export const cellOf = (...paragraphs: (ParagraphSpec | TableSpec)[]): CellSpec => ({ paragraphs });

/** A table of `rows` by `columns` cells, each holding its place as text: `<label><row>c<column>`. */
export const sized = (rows: number, columns: number, label = "r"): TableSpec => grid(
  ...Array.from({ length: rows }, (_, row) =>
    Array.from({ length: columns }, (__, column) => `${label}${row}c${column}`)));

/** A footnote reference numbered `number`, as a run of a paragraph. */
export const footnote = (number: number) =>
  ({ footnote: { id: `f${number}`, number: String(number) } });

/** The HTML a rendering holds for its `table`-th table. */
export function tableAt(render: DocTabSnapshot, table: number): string {
  let { mdStart, mdEnd } = render.sourceMap.tables[table];
  return render.markdown.slice(mdStart, mdEnd);
}

/** A single-level bullet list definition, for paragraphs carrying a matching `bullet`. */
export const BULLET_LIST: GoogleDocsTab["lists"] = {
  L1: { listProperties: { nestingLevels: [{ glyphSymbol: "\u25cf" }] } },
};

/** A list whose custom glyph no Markdown bullet can reproduce, keyed `check`. */
export const CHECK_LIST: GoogleDocsTab["lists"] = {
  check: { listProperties: { nestingLevels: [{ glyphSymbol: "\u2610" }] } },
};

/** A list of one numbered level, keyed `N1`. */
export const NUMBERED_LIST: Lists = {
  N1: { listProperties: { nestingLevels: [{ glyphType: "DECIMAL" }] } },
};

/** A list whose one level has no marker, keyed `Q1`: its items read as plain lines. */
export const QUIET_LIST: Lists = {
  Q1: { listProperties: { nestingLevels: [{ glyphType: "NONE" }] } },
};

/**
 * The nine nesting levels Google gives a list that a bullet preset makes: the bulleted preset's
 * unless `numbered`. Written out here because they are Google's: the code under test must not
 * be what supplies them.
 */
export function presetLevels(numbered = false): NestingLevel[] {
  return Array.from({ length: 9 }, (_, level) => numbered
    ? { glyphType: ["DECIMAL", "ALPHA", "ROMAN"][level % 3], startNumber: 1 }
    : { glyphSymbol: ["●", "○", "■"][level % 3], startNumber: 1 });
}

/**
 * The message of the `Error` that `run` throws. Throws when `run` returns, and rethrows
 * anything it throws that is no `Error`.
 */
export function thrownMessage(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) return error.message;
    throw error;
  }
  throw new Error("Expected a refusal");
}

/** Both of Google's behaviours, where two are on record, for each of the model's two options. */
export const MODELS: readonly ModelOptions[] = [false, true].flatMap(copyStyles =>
  [false, true].map(unlinkRestyles => ({ copyStyles, unlinkRestyles })));

/**
 * The tab the model leaves once `requests` are applied to `tab`, under the last of `MODELS`;
 * `tab` itself when there are none. On the way it asserts that the tab renders the same under
 * each of `MODELS` (its Markdown, its protected ranges and its tables' maps): what a batch that
 * neutralises Google's two behaviours gives.
 */
export function appliedOneWay(
  tab: GoogleDocsTab, requests: readonly GoogleDocsRequest[],
): GoogleDocsTab {
  if (requests.length === 0) return tab;
  let results = MODELS.map(options => applyDocsRequests(tab, requests, options));
  let [first, ...others] = results.map(result => docTabToMarkdown(result));
  for (let other of others) {
    expect(other.markdown).toBe(first.markdown);
    expect(other.sourceMap.protectedRanges).toEqual(first.sourceMap.protectedRanges);
    expect(other.sourceMap.tables).toEqual(first.sourceMap.tables);
  }
  return results[results.length - 1];
}

/** A text field of an approval card, as the approval queue receives it. */
export const cardField = (label: string, value: string, syntax: "html" | "markdown") =>
  ({ label, kind: "text", value, syntax });

/** A seeded generator of numbers in [0, 1), so that a random test runs the same every time. */
export function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = state + 0x6d2b79f5 | 0;
    let mixed = Math.imul(state ^ state >>> 15, 1 | state);
    mixed = mixed + Math.imul(mixed ^ mixed >>> 7, 61 | mixed) ^ mixed;
    return ((mixed ^ mixed >>> 14) >>> 0) / 4294967296;
  };
}

/** Random numbers as a generated test draws them, from a seed. */
export type Dice = {
  /** The next number in [0, 1). */
  random: () => number;
  /** A whole number from 0 up to, not including, `limit`. */
  below: (limit: number) => number;
  /** One of `values`. */
  pick: <T>(values: readonly T[]) => T;
};

/** The dice of `seed`: the same draws at every run. */
export function diceOf(seed: number): Dice {
  let random = seeded(seed);
  let below = (limit: number) => Math.floor(random() * limit);
  return { random, below, pick: values => values[below(values.length)] };
}

/**
 * `document` kept as document `doc`'s copy in `store`, as a snapshot: its tabs pruned, its
 * revision, fetched at `Date.now()`.
 */
export function keptSnapshot(
  store: DocStore, document: GoogleDocsDocument, doc = "doc",
): GoogleDocSnapshot {
  // The store empties the document it is handed as it stores it: it is handed a copy, each
  // tab its own, and `document` stays the caller's to read.
  const copy = { ...document, tabs: document.tabs.map(tab => structuredClone(tab)) };
  const head = store.keep(doc, store.fetched(copy, Date.now()), { edits: [], roots: [] });
  return {
    revisionId: document.revisionId,
    copy: storedDocCopy(store, doc, head),
    fetchedAt: head.fetchedAt,
  };
}
