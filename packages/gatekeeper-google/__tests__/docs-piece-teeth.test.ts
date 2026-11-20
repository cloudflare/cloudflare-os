// The teeth of the differential of the request builders on a piece of a tab: the closure made
// smaller, each way it can be, builds another batch with no error, and the test counts how
// many of those the check of a batch against its piece catches, and for how many edits the
// recorder fails on a read past the smaller range; the recorder that fails on a read past a
// piece, held to failing on each kind of read and to reading as the whole rendering does;
// and the same shrinks over table changes, which a smaller piece refuses and never builds
// otherwise, with what a table change asks of its tab as a whole answered from its piece.

import { describe, expect, it } from "vitest";
import type { GoogleDocsTab } from "../src/docs-api";
import { pieceOverreach } from "../src/docs-replay";
import { wholeTabReading } from "../src/docs-tables";
import type { TableChange } from "../src/docs-tables";
import { ELEMENT_DEEP, ELEMENT_TEXT, isBlankDocTab, markdownToDocRequests } from "../src/markdown-converter";
import type { OwnElements, TabReading } from "../src/markdown-converter";
import { BULLET_LIST, buildTab, grid, item, para, thrownMessage } from "./doc-fixture";
import { ReadPastPiece, recorded } from "./docs-piece-recorder";
import {
  callOutcome, closureIn, closureReading, fromClosure, fromReading, fromRecorded, fromWhole,
  outcomeOf, ownIn, renderedOf,
} from "./docs-piece-shadow";
import type { ElementRange, Shrink } from "./docs-piece-shadow";
import {
  DEFAULT_CORPUS, DEFAULT_TABLE_CORPUS, madeTableCases, pieceCorpus, pieceTableCorpus, tabEditCorpus,
} from "./docs-piece-tabs";
import { asFetched } from "./docs-store-slice-shadow";

/**
 * The closure's rule with each part of it counted: `back` steps back from the first own
 * element, the walk back through deeper list items or not, and `forward` steps forward from
 * the last, on a tab whole in hand. Two steps, the walk and two steps is `closureOf`.
 */
function closureWith(
  flags: readonly number[], own: OwnElements, back: number, walk: boolean, forward: number,
): ElementRange {
  let low = own.first;
  for (let step = 0; step < back && low > 0; step++) {
    do low--; while (low > 0 && !(flags[low] & ELEMENT_TEXT));
  }
  if (walk) while (low > 0 && flags[low] & ELEMENT_DEEP) low--;
  let end = flags.length - 1;
  let high = own.last;
  for (let step = 0; step < forward && high < end; step++) {
    do high++; while (high < end && !(flags[high] & ELEMENT_TEXT));
  }
  return { from: low, to: high + 1 };
}

/** The edits of the default table that the whole tab builds a batch for. */
const BUILT = 945;

// WHAT A SMALLER CLOSURE BUILDS, over those edits (an edit the whole tab refuses is not
// counted): `wrong`, ANOTHER BATCH WITH NO ERROR; `refused`, a refusal where the whole tab
// builds; and `caught`, the wrong batches that `pieceOverreach` names a side for, asked with
// the smaller piece's own place. So the table shows what the differential is for, and the
// share of the silent wrong batches that the check of a batch against its piece stops at run
// time: every one where the second step forward or the walk is missing, four in five where
// the last element is (15 of 19), and about two in three where both steps back are (26 of
// 41), since a builder that reads too little of what stands before or after the edit may
// write nothing there.
//
// The first six must bite. The last two are pinned at what they give, which is nothing, and
// that is no tooth that failed. BY MEASURE, and not by proof: the walk back through deeper
// list items takes in what the second step back does wherever that step decides a batch (the
// step bites once the walk is removed with it: `backAndWalk`), and the closure's first
// element is read by the builders and decides no batch.
//
// WHAT THE RECORDER SAYS OF A SMALLER RANGE: `past`, the built edits whose build from the
// whole rendering, under the recorder of the smaller range, fails as a read past it. That is
// the tooth of the read past the piece, and of the two rows that build no other batch: what
// they take off the closure is content the builders read. It is no tooth of the second step
// forward: of the blocks that step takes in the builders read where they stand and nothing
// they hold, which the recorder allows, so what holds that step is the batches above.
type Tooth = {
  shrink: Shrink; bites: boolean; wrong: number; refused: number; caught: number; past: number;
};
const TEETH: Record<string, Tooth> = {
  /** The second step forward removed. */
  forward: {
    shrink: (_closure, own, flags) => closureWith(flags, own, 2, true, 1),
    bites: true, wrong: 12, refused: 13, caught: 12, past: 0,
  },
  /** The walk back through deeper list items removed. */
  walk: {
    shrink: (_closure, own, flags) => closureWith(flags, own, 2, false, 2),
    bites: true, wrong: 14, refused: 0, caught: 14, past: 14,
  },
  /** One element off the back. */
  offBack: {
    shrink: ({ from, to }, own) => ({ from, to: Math.max(own.last + 1, to - 1) }),
    bites: true, wrong: 19, refused: 13, caught: 15, past: 9,
  },
  /** The second step back and the walk removed. */
  backAndWalk: {
    shrink: (_closure, own, flags) => closureWith(flags, own, 1, false, 2),
    bites: true, wrong: 15, refused: 0, caught: 15, past: 81,
  },
  /** Both steps back removed, the walk kept. */
  backBoth: {
    shrink: (_closure, own, flags) => closureWith(flags, own, 0, true, 2),
    bites: true, wrong: 41, refused: 5, caught: 26, past: 392,
  },
  /** The own elements alone. */
  own: {
    shrink: (_closure, own) => ({ from: own.first, to: own.last + 1 }),
    bites: true, wrong: 202, refused: 38, caught: 161, past: 734,
  },
  /** The second step back removed, the walk kept. */
  back: {
    shrink: (_closure, own, flags) => closureWith(flags, own, 1, true, 2),
    bites: false, wrong: 0, refused: 0, caught: 0, past: 47,
  },
  /** One element off the front. */
  offFront: {
    shrink: ({ from, to }, own) => ({ from: Math.min(own.first, from + 1), to }),
    bites: false, wrong: 0, refused: 0, caught: 0, past: 98,
  },
};

/** Whether `read` fails as a read past the piece; any other failure is thrown on. */
function readsPast(read: () => unknown): boolean {
  try {
    read();
    return false;
  } catch (error) {
    if (error instanceof ReadPastPiece) return true;
    throw error;
  }
}

describe("the closure made smaller", () => {
  let corpus = pieceCorpus(DEFAULT_CORPUS);

  it("is the rule the shrinks take parts off", () => {
    for (let { tab, drawn } of corpus) {
      let { whole } = renderedOf(tab.tab);
      let own = drawn.entry.own(drawn.edit);
      expect(closureWith(whole.flags, ownIn(whole, own), 2, true, 2)).toEqual(closureIn(whole, own));
    }
  });

  it.each(Object.keys(TEETH))("%s", name => {
    let { shrink, bites, ...pinned } = TEETH[name];
    let counts = { wrong: 0, refused: 0, caught: 0, past: 0 };
    let built = 0;
    for (let { tab, drawn } of corpus) {
      let whole = fromWhole(tab.tab, drawn.entry, drawn.edit);
      if (!("requests" in whole)) continue;
      built++;
      // Under the recorder a build reads the whole rendering: it fails, or gives the whole
      // tab's batch.
      if (readsPast(() => expect(fromRecorded(tab.tab, drawn.entry, drawn.edit, shrink)).toEqual(whole))) {
        counts.past++;
      }
      let { outcome, part } = fromClosure(tab.tab, drawn.entry, drawn.edit, shrink);
      // Compared as text, and nothing of either printed: a document's text is in them.
      if (JSON.stringify(outcome) === JSON.stringify(whole)) continue;
      if (!("requests" in outcome)) counts.refused++;
      else {
        counts.wrong++;
        if (pieceOverreach(outcome.requests, part)) counts.caught++;
      }
    }
    expect(built).toBe(BUILT);
    // A row that builds no other batch has its tooth in the recorder.
    if (bites) expect(counts.wrong).toBeGreaterThan(0);
    else expect(counts.past).toBeGreaterThan(0);
    expect(counts).toEqual(pinned);
  });
});

/** Holds `read` to failing as a read past the piece. */
function past(read: () => unknown): void {
  expect(read).toThrow(ReadPastPiece);
}

describe("the recorder of reads past a piece", () => {
  // Nine lines, a list between them and a table after them: elements 0 (the section break)
  // to 11, the range elements 4 to 6 (`Line 3`, the two items).
  let tab = asFetched(buildTab([
    para("Line 0"), para("Line 1"), para("Line 2"), para("Line 3"), item("Item 4"), item("Item 5"),
    para("Line 6"), para("Line 7"), grid(["Cell 8"]), para("Line 9"), para("Line 10"),
  ], BULLET_LIST));
  let { whole, rendering } = renderedOf(tab);
  let told = { rendering, starts: whole.starts, flags: whole.flags };
  let range = { from: 4, to: 7 };
  let from = whole.starts[range.from];
  let to = whole.starts[range.to];
  let guarded = recorded(told, range);
  let { markdown } = guarded;

  it("reads as the whole rendering inside its range", () => {
    expect(markdown.length).toBe(rendering.markdown.length);
    expect(markdown.slice(from, to)).toBe(rendering.markdown.slice(from, to));
    expect(markdown.slice(from, to)).toContain("Line 3\n\n- Item 4\n- Item 5\n");
    expect([markdown[from], markdown.at(to - 1), markdown.charCodeAt(to - 1)]).toEqual(["\n", "\n", 10]);
    expect(markdown.indexOf("Item 5", from)).toBe(rendering.markdown.indexOf("Item 5"));
    // A search backwards reads from the end of the last match it could find.
    expect(markdown.lastIndexOf("Item 4", to - 6)).toBe(rendering.markdown.indexOf("Item 4"));
    expect(markdown.startsWith("\nLine 3", from)).toBe(true);
    expect(markdown.includes("Item 5", from)).toBe(true);
    // A read of nothing is no read.
    expect(markdown.slice(0, 0)).toBe("");
    // The identity, the tab's end and an entry's position are the tab's, and read freely.
    expect([guarded.tabId, guarded.bodyEndIndex]).toEqual([rendering.tabId, rendering.bodyEndIndex]);
    let { blocks, tables } = guarded.sourceMap;
    expect(blocks.map(block => [block.mdStart, block.mdEnd, block.docStart, block.docEnd]))
      .toEqual(rendering.sourceMap.blocks.map(block => [block.mdStart, block.mdEnd, block.docStart, block.docEnd]));
    expect([tables.length, tables[0].mdStart]).toEqual([1, rendering.sourceMap.tables[0].mdStart]);
    // An entry of the range is the rendering's own; one outside is one stand-in, found again.
    expect(blocks[4]).toBe(rendering.sourceMap.blocks[4]);
    expect([blocks[4].listType, blocks[3].listType]).toEqual(["bullet", null]);
    expect(blocks.indexOf(blocks[1])).toBe(1);
    expect(blocks.slice(0, 2)[1]).toBe(blocks[1]);
    expect(blocks.find(block => block.mdStart === blocks[8].mdStart)).toBe(blocks[8]);
  });

  it("fails on a read of each kind outside its range", () => {
    past(() => markdown[from - 1]);
    past(() => markdown[to]);
    past(() => markdown.at(0));
    past(() => markdown.at(-1));
    past(() => markdown.charCodeAt(to));
    past(() => markdown.slice(from - 1, to));
    past(() => markdown.slice(from, to + 1));
    past(() => markdown.slice(from));
    // A search reads on to what it finds, and to the string's end where it finds nothing.
    past(() => markdown.indexOf("Line 6", from));
    past(() => markdown.indexOf("no such text", from));
    past(() => markdown.indexOf("Item 5"));
    past(() => markdown.includes("Line 7", from));
    past(() => markdown.lastIndexOf("Line 2", to - 6));
    past(() => markdown.lastIndexOf("Item 5", to - 5));
    past(() => markdown.lastIndexOf("no such text", to - 12));
    past(() => markdown.startsWith("Line 0\n"));
    let { blocks, tables } = guarded.sourceMap;
    past(() => blocks[0].listType);
    past(() => blocks[2].segments);
    past(() => blocks.at(-1)!.namedStyleType);
    past(() => blocks.some(block => block.listType !== null));
    past(() => tables[0].rows);
    past(() => "listId" in blocks[0]);
    past(() => Object.keys(blocks[0]));
    expect(thrownMessage(() => blocks[6].listNestingLevel))
      .toBe("A read past the piece: blocks[6].listNestingLevel");
    expect(thrownMessage(() => markdown.slice(from - 3, from + 2)))
      .toBe(`A read past the piece: slice of [${from - 3}, ${from + 2}) outside [${from}, ${to})`);
  });

  it("fails on a write, as a fault and no refusal", () => {
    let { blocks } = guarded.sourceMap;
    expect(() => { blocks[0].mdStart = 0; }).toThrow(new TypeError("A builder wrote to blocks[0]"));
    expect(() => { blocks.length = 0; }).toThrow(new TypeError("A builder wrote to blocks"));
    expect(() => Reflect.set(Object(markdown), 0, "x"))
      .toThrow(new TypeError("A builder wrote to the Markdown"));
    // What takes a plain `Error` for a builder's refusal throws it on.
    expect(() => outcomeOf(() => {
      blocks.length = 0;
      return [];
    })).toThrow(TypeError);
  });

  it("fails on a way of reading the Markdown it does not follow", () => {
    expect(() => markdown.trim()).toThrow(new TypeError("The Markdown of a recorded rendering is asked trim"));
    expect(() => `${markdown}`).toThrow(TypeError);
    expect(() => /Line/.test(markdown)).toThrow(TypeError);
  });

  it("allows every read to an end of the tab its range reaches", () => {
    let first = recorded(told, { from: 0, to: 4 }).markdown;
    expect([first[-1], first[0], first.slice(0, 6)]).toEqual([undefined, "L", "Line 0"]);
    past(() => first[whole.starts[4]]);
    let last = recorded(told, { from: 9, to: whole.flags.length }).markdown;
    expect([last[last.length], last.at(-1), last.indexOf("no such text", whole.starts[9])])
      .toEqual([undefined, "\n", -1]);
    past(() => last[whole.starts[9] - 1]);
    // The table is the range's: its entry is the rendering's own.
    expect(recorded(told, { from: 9, to: 10 }).sourceMap.tables[0].rows).toHaveLength(1);
  });

  it("gives each builder what the whole rendering gives, where its range is the whole tab", () => {
    let built = 0;
    for (let { tab: drawnOn, drawn } of pieceCorpus({ ...DEFAULT_CORPUS, tabs: 30 })) {
      let rendered = renderedOf(drawnOn.tab);
      let all = recorded(
        { rendering: rendered.rendering, starts: rendered.whole.starts, flags: rendered.whole.flags },
        { from: 0, to: rendered.whole.flags.length });
      let outcome = outcomeOf(() => drawn.entry.build(all, drawn.edit, 0));
      expect(outcome).toEqual(fromWhole(drawnOn.tab, drawn.entry, drawn.edit));
      if ("requests" in outcome) built++;
    }
    expect(built).toBeGreaterThanOrEqual(150);
  });
});

// ---------------------------------------------------------------------------
// The closure made smaller, for what an edit builds through a reading of its tab
// ---------------------------------------------------------------------------

/** What a smaller closure gives for the edits of one kind that the whole tab builds. */
type ReadingTooth = { built: number; wrong: number; refused: number; caught: number };

// THE SHRINKS ABOVE, OVER REPLACEMENTS OF THE TEXT OF TABLE CELLS AND OVER APPENDS, each
// built by the one place an edit becomes requests from the reading of the smaller closure:
// `wrong`, another batch with no error; `caught`, a batch that names an index past the
// smaller piece and is refused for it, in the words of a change that cannot be shown; and
// `refused`, any other refusal where the whole tab builds. PINNED AS MEASURED, AND NO TOOTH
// THAT FAILED: the rows that must bite are those of replacements outside tables, above.
// NO SHRINK BUILDS ANOTHER BATCH for either kind. A REPLACEMENT IN A CELL is built from its
// table alone, and AN APPEND from the tab's last paragraph and what stands at the tab's end:
// a shrink that keeps the own element changes nothing of what either reads here, and one
// forward has nothing to take of an append, whose piece ends at the tab's end. WHERE BOTH
// STEPS BACK ARE GONE (`backBoth`, `own`) the piece is the own element alone, which has no
// index between its outermost elements: every batch names an index before it and is caught.
// One element off the back of a cell's closure is caught where the batch writes into the
// paragraph after the table.
const READING_TEETH: Record<string, { cell: ReadingTooth; append: ReadingTooth }> = {
  forward: { cell: { built: 95, wrong: 0, refused: 0, caught: 0 }, append: { built: 20, wrong: 0, refused: 0, caught: 0 } },
  walk: { cell: { built: 95, wrong: 0, refused: 0, caught: 0 }, append: { built: 20, wrong: 0, refused: 0, caught: 0 } },
  offBack: { cell: { built: 95, wrong: 0, refused: 0, caught: 3 }, append: { built: 20, wrong: 0, refused: 0, caught: 0 } },
  backAndWalk: { cell: { built: 95, wrong: 0, refused: 0, caught: 0 }, append: { built: 20, wrong: 0, refused: 0, caught: 0 } },
  backBoth: { cell: { built: 95, wrong: 0, refused: 0, caught: 95 }, append: { built: 20, wrong: 0, refused: 0, caught: 20 } },
  own: { cell: { built: 95, wrong: 0, refused: 0, caught: 95 }, append: { built: 20, wrong: 0, refused: 0, caught: 20 } },
  back: { cell: { built: 95, wrong: 0, refused: 0, caught: 0 }, append: { built: 20, wrong: 0, refused: 0, caught: 0 } },
  offFront: { cell: { built: 95, wrong: 0, refused: 0, caught: 0 }, append: { built: 20, wrong: 0, refused: 0, caught: 0 } },
};

/** The words a batch past its piece is refused in. */
const NOT_SHOWN = "this change cannot be shown as it will read once applied, so it cannot be made";

describe("the closure made smaller, for an edit built from a reading", () => {
  let corpus = tabEditCorpus({ seed: DEFAULT_CORPUS.seed + 500, tabs: 30, edits: 8 })
    .filter(({ drawn }) => drawn.kind === "cell" || drawn.kind === "append");

  it.each(Object.keys(TEETH))("%s", name => {
    let { shrink } = TEETH[name];
    let noTooth = (): ReadingTooth => ({ built: 0, wrong: 0, refused: 0, caught: 0 });
    let counts = { cell: noTooth(), append: noTooth() };
    for (let { tab, drawn } of corpus) {
      let whole = fromReading(wholeTabReading(renderedOf(tab.tab).rendering), drawn.edit);
      if (!("requests" in whole)) continue;
      let tally = counts[drawn.kind as "cell" | "append"];
      tally.built++;
      let outcome = fromReading(closureReading(tab.tab, shrink), drawn.edit);
      // Compared as text, and nothing of either printed: a document's text is in them.
      if (JSON.stringify(outcome) === JSON.stringify(whole)) continue;
      if ("requests" in outcome) tally.wrong++;
      else if (outcome.refused.message.includes(NOT_SHOWN)) tally.caught++;
      else tally.refused++;
    }
    expect(counts).toEqual(READING_TEETH[name]);
  });

  it("blankness decided from the piece", () => {
    // An append built as the one place an edit becomes requests builds it, but for asking
    // the PIECE whether the tab is blank.
    let fromPiece = (tab: GoogleDocsTab, markdown: string, shrink?: Shrink) => outcomeOf(() => {
      let piece = closureReading(tab, shrink).piece("end");
      let index = piece.bodyEndIndex - 1;
      return isBlankDocTab(piece)
        ? markdownToDocRequests(markdown, index, piece.tabId, { resetParagraphs: true })
        : markdownToDocRequests("\n" + markdown, index, piece.tabId, {
          resetParagraphs: true, preserveLeadingParagraph: true, tabBlocks: piece.sourceMap.blocks,
        });
    });
    // Tabs that end in one or three empty paragraphs after text, and blank tabs.
    let tabs = [[0, 1], [1, 1], [2, 1], [5, 1], [9, 1], [1, 3], [9, 3]].map(([lines, empties]) =>
      asFetched(buildTab([
        ...Array.from({ length: lines }, (_, line) => para(`Line ${line}`)),
        ...Array.from({ length: empties }, () => para("")),
      ])));
    let own: Shrink = (_closure, elements) => ({ from: elements.first, to: elements.last + 1 });
    let wrong = { closure: 0, own: 0, told: 0 };
    let appends = ["More", "# Head", "- one\n- two"];
    for (let tab of tabs) {
      let { rendering } = renderedOf(tab);
      for (let markdown of appends) {
        let whole = fromReading(wholeTabReading(rendering), { type: "appendText", markdown });
        expect("requests" in whole).toBe(true);
        if (JSON.stringify(fromPiece(tab, markdown)) !== JSON.stringify(whole)) wrong.closure++;
        if (JSON.stringify(fromPiece(tab, markdown, own)) !== JSON.stringify(whole)) wrong.own++;
        // The same build through a reading that answers the other way of the tab.
        let reading = closureReading(tab);
        let lies = { ...reading, blank: () => !reading.blank() };
        if (JSON.stringify(fromReading(lies, { type: "appendText", markdown })) !== JSON.stringify(whole)) {
          wrong.told++;
        }
      }
    }
    // A MEASURE, AND NO TOOTH THAT BIT. A piece at a tab's end reads as blank only where the
    // tab is: a step back ends on an element that writes a character, or at the tab's first
    // element, and then the piece is the whole tab; and the own element alone, an empty
    // paragraph after text, renders with the blank line before it, which is two line breaks
    // and not a blank tab's one. So blankness asked of the piece builds the whole tab's batch
    // on every tab here, from the closure and from the own element alone. WHAT BITES is the
    // answer itself: the builder asks the tab (`TabReading.blank`), and a reading that
    // answers the other way builds another batch for every append.
    expect(wrong).toEqual({ closure: 0, own: 0, told: tabs.length * appends.length });
  });
});

// ---------------------------------------------------------------------------
// The closure made smaller, for a table change
// ---------------------------------------------------------------------------

/** The eleven kinds of table change, in the order the rows below count them. */
const TABLE_KINDS = [
  "insertTable", "insertTableRows", "insertTableColumns", "deleteTableRows", "deleteTableColumns",
  "deleteTable", "setTableCellStyle", "setTableColumnWidths", "setTableRowHeights",
  "mergeTableCells", "unmergeTableCells",
] as const satisfies readonly TableChange["type"][];

/** The table changes of the default table and of the made tabs, each with its tab. */
const tableChanges = () => [
  ...pieceTableCorpus(DEFAULT_TABLE_CORPUS), ...madeTableCases(),
].flatMap(({ tab, draws }) => draws.flatMap(({ change }) => change ? [{ tab: tab.tab, change }] : []));

/** The table changes of those tabs that the whole tab builds a batch for, by kind. */
const TABLES_BUILT = [47, 33, 13, 4, 12, 37, 9, 10, 14, 7, 1];
const NONE = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

// THE SHRINKS ABOVE, OVER TABLE CHANGES, BY KIND (in the order of `TABLE_KINDS`), each built by
// the one place an edit becomes requests from the reading of the smaller closure: `wrong`,
// another batch with no error; `caught`, a batch that names an index past the smaller piece
// and is refused for it, in the words of a change that cannot be shown; `refused`, any other
// refusal where the whole tab builds.
// WHAT A SHORT PIECE DOES TO A TABLE CHANGE IS REFUSE IT, NOT BUILD ANOTHER. No shrink builds
// another batch for any kind: `wrong` is 0 in every row, which is a measure and no tooth that
// failed. Rows and columns added and deleted, the three looks, a merge and a split are built
// from the table and nothing beside it, so they give the whole tab's batch from every piece
// that holds the table and has an index on each side of it. A TABLE DELETED and A TABLE ADDED
// read what stands beside them, and a piece that lacks it REFUSES: the own elements alone
// (`own`: every deletion, and every table added after a paragraph or a table that the piece
// then ends with), both steps back gone (`backBoth`: every deletion), and one element off
// the back where that element is the paragraph after the table, the tab's last (`offBack`).
// Those four rows must bite. WHERE THE PIECE IS THE TABLE ALONE, or starts with it, the piece
// has no index before the table, so every batch of the other kinds is caught.
const TABLE_TEETH: Record<string, { refused: number[]; caught: number[] }> = {
  forward: { refused: NONE, caught: NONE },
  walk: { refused: NONE, caught: NONE },
  offBack: { refused: [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0], caught: NONE },
  backAndWalk: { refused: NONE, caught: NONE },
  backBoth: { refused: [0, 0, 0, 0, 0, 37, 0, 0, 0, 0, 0], caught: [25, 33, 13, 4, 12, 0, 9, 10, 14, 7, 1] },
  own: { refused: [21, 0, 0, 0, 0, 37, 0, 0, 0, 0, 0], caught: [26, 33, 13, 4, 12, 0, 9, 10, 14, 7, 1] },
  back: { refused: NONE, caught: NONE },
  // A row added to the table that opens the body: the piece starts with the table.
  offFront: { refused: NONE, caught: [0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
};

describe("the closure made smaller, for a table change", () => {
  let corpus = tableChanges();

  it.each(Object.keys(TEETH))("%s", name => {
    let { shrink } = TEETH[name];
    let counts = Object.fromEntries(["built", "wrong", "refused", "caught"].map(
      row => [row, TABLE_KINDS.map(() => 0)])) as Record<"built" | "wrong" | "refused" | "caught", number[]>;
    for (let { tab, change } of corpus) {
      let whole = fromReading(wholeTabReading(renderedOf(tab).rendering), change);
      if (!("requests" in whole)) continue;
      let kind = TABLE_KINDS.indexOf(change.type);
      counts.built[kind]++;
      let outcome = fromReading(closureReading(tab, shrink), change);
      // Compared as text, and nothing of either printed: a document's text is in them.
      if (JSON.stringify(outcome) === JSON.stringify(whole)) continue;
      if ("requests" in outcome) counts.wrong[kind]++;
      else if (outcome.refused.message.includes(NOT_SHOWN)) counts.caught[kind]++;
      else counts.refused[kind]++;
    }
    let deleted = TABLE_KINDS.indexOf("deleteTable"), added = TABLE_KINDS.indexOf("insertTable");
    if (name === "own" || name === "offBack") {
      expect(counts.refused[deleted]).toBeGreaterThan(0);
      expect(counts.refused[added]).toBeGreaterThan(0);
    }
    expect(counts).toEqual({ built: TABLES_BUILT, wrong: NONE, ...TABLE_TEETH[name] });
  });

  /** A reading that answers as `reading` does but for `lie`, which its pieces ask too. */
  function lying(reading: TabReading, lie: (truth: TabReading) => Partial<TabReading>): TabReading {
    let lies: TabReading = {
      ...reading,
      piece(own) {
        let piece = reading.piece(own);
        return { ...piece, part: { ...piece.part!, tab: lies } };
      },
    };
    return Object.assign(lies, lie(lies));
  }

  it("what follows a table is the tab's to say", () => {
    // A deletion whose table holds items of a numbered list, where a numbered list stands
    // far after it: the whole tab refuses it. Built with what follows the table asked of the
    // piece's own rendering, which ends two steps after the table, it is built.
    let refusedByTab = 0, built = 0;
    for (let { tab, change } of corpus) {
      let whole = fromReading(wholeTabReading(renderedOf(tab).rendering), change);
      if ("requests" in whole || !whole.refused.message.includes("holds items of a numbered list")) continue;
      refusedByTab++;
      // The closure's own answer is the whole tab's.
      expect(fromReading(closureReading(tab), change)).toEqual(whole);
      let fromPiece = lying(closureReading(tab), lies => ({
        numberedAfter(table) {
          let piece = lies.piece({ table });
          return wholeTabReading({ ...piece, part: undefined }).numberedAfter(table - piece.part!.tablesBefore);
        },
      }));
      if ("requests" in fromReading(fromPiece, change)) built++;
    }
    expect([refusedByTab, built]).toEqual([4, 4]);
  });

  it("a table's number is the tab's", () => {
    // A call that names, by its number, a table that is not the first of its piece's, checked
    // on pieces that say no table stands before them: the call is checked against another
    // table of the piece (another change, or another refusal), or against none (a fault).
    let calls = [...pieceTableCorpus(DEFAULT_TABLE_CORPUS), ...madeTableCases()].flatMap(
      ({ tab, draws }) => draws.flatMap(({ call }) => call ? [{ tab: tab.tab, call }] : []));
    let later = 0, other = 0, faults = 0;
    for (let { tab, call } of calls) {
      let whole = callOutcome(wholeTabReading(renderedOf(tab).rendering), call);
      // The pieces the checks asked, each with the tables that stand before it.
      let before: number[] = [];
      let closed = lying(closureReading(tab), lies => ({
        piece(own) {
          let piece = closureReading(tab).piece(own);
          before.push(piece.part!.tablesBefore);
          return { ...piece, part: { ...piece.part!, tab: lies } };
        },
      }));
      expect(callOutcome(closed, call)).toEqual(whole);
      if (!before.some(tables => tables > 0)) continue;
      later++;
      let unnumbered = lying(closureReading(tab), lies => ({
        piece(own) {
          let piece = closureReading(tab).piece(own);
          return { ...piece, part: { ...piece.part!, tablesBefore: 0, tab: lies } };
        },
      }));
      try {
        if (JSON.stringify(callOutcome(unnumbered, call)) !== JSON.stringify(whole)) other++;
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        faults++;
      }
    }
    // Of 99 such calls, 20 are checked against another table and 78 against none; one gives
    // the whole tab's outcome all the same.
    expect(other).toBeGreaterThan(0);
    expect([later, other, faults]).toEqual([99, 20, 78]);
  });
});
