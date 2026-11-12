import type {
  GoogleDocsTab, ParagraphElement, StructuralElement, TableCellStyle, TextStyle,
} from "../src/docs-api";

type ParagraphPart =
  | { text: string; style?: TextStyle }
  | { person: { name?: string; email: string }; style?: TextStyle }
  | { richLink: { title: string; uri: string }; style?: TextStyle }
  | { date: string; style?: TextStyle }
  /** A dropdown chip showing this value. */
  | { dropdown: string; style?: TextStyle }
  | { footnote: { id: string; number: string }; style?: TextStyle }
  | { autoText: "PAGE_NUMBER" | "PAGE_COUNT"; style?: TextStyle }
  | { horizontalRule: true };

type ParagraphSpec = {
  runs: (ParagraphPart | string)[];
  namedStyleType?: string;
  bullet?: { listId: string; nestingLevel?: number };
};

type Suggestion = "insertion" | "deletion";

type TableCellContent = {
  /** The cell's content in order: paragraphs, and tables nested in the cell. */
  paragraphs: (ParagraphSpec | TableSpec)[];
  tableCellStyle?: TableCellStyle;
  /** Marks the cell as a suggested insertion, or as suggested for deletion. */
  suggested?: Suggestion;
};
/** A cell's content, or the text of the one paragraph it holds. */
type TableCellSpec = string | TableCellContent;
type TableSpec = {
  table: TableCellSpec[][];
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
type BlockSpec = ParagraphSpec | TableSpec | StructuralSpec;

/**
 * Builds a normalized `GoogleDocsTab` with the index bookkeeping the real API applies: a section
 * break occupies index 0, followed by paragraphs and tables in one shared index space.
 *
 * Every paragraph's last run must end in "\n", as Google's own responses do.
 */
export function buildTab(
  blocks: BlockSpec[],
  lists: GoogleDocsTab["lists"] = {},
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
      let { text, style } = typeof run === "string" ? { text: run, style: undefined } : run;
      let runStart = index;
      index += text.length;
      return {
        startIndex: runStart,
        endIndex: index,
        textRun: { content: text, textStyle: style ?? {} },
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
  lists?: GoogleDocsTab["lists"],
): GoogleDocsTab {
  return buildTab([{ table: [[{ paragraphs }]] }], lists);
}

/** A single-level bullet list definition, for paragraphs carrying a matching `bullet`. */
export const BULLET_LIST: GoogleDocsTab["lists"] = {
  L1: { listProperties: { nestingLevels: [{ glyphSymbol: "\u25cf" }] } },
};

/** A list whose custom glyph no Markdown bullet can reproduce, keyed `check`. */
export const CHECK_LIST: GoogleDocsTab["lists"] = {
  check: { listProperties: { nestingLevels: [{ glyphSymbol: "\u2610" }] } },
};
