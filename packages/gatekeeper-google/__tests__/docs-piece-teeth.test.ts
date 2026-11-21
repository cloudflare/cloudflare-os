// The teeth of the piece differential: each way of making the closure smaller, pinned at what
// it builds, refuses, `pieceOverreach` catches and the recorder fails on; and the recorder
// itself, held to failing on each kind of read past its range.

import { describe, expect, it } from "vitest";
import type { GoogleDocsTab } from "../src/docs-api";
import { pieceOverreach } from "../src/docs-replay";
import { wholeTabReading } from "../src/docs-tables";
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
  DEFAULT_CORPUS, DEFAULT_TABLE_CORPUS, madeTableCases, pieceCorpus, pieceTableCorpus, TABLE_KINDS,
} from "./docs-piece-tabs";
import { asFetched } from "./docs-store-slice-shadow";

/** The closure's rule in parts: `back` steps, the walk through deeper items, `forward` steps. */
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

// Over the built edits: `wrong`, another batch with no error; `refused`, a refusal where the
// whole tab builds; `caught`, the wrong batches `pieceOverreach` names a side for; `past`, the
// builds the recorder of the smaller range fails. The first six rows bite with wrong batches;
// the last two build none, and their tooth is the recorder.
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
      // Under the recorder a build fails, or gives the whole tab's batch.
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
  // Elements 0 (the section break) to 11; the range is elements 4 to 6 (`Line 3`, two items).
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
    expect(markdown.lastIndexOf("Item 4", to - 6)).toBe(rendering.markdown.indexOf("Item 4"));
    expect(markdown.startsWith("\nLine 3", from)).toBe(true);
    expect(markdown.includes("Item 5", from)).toBe(true);
    expect(markdown.slice(0, 0)).toBe("");
    // The identity, the tab's end and an entry's position are read freely.
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
    // A search reads to what it finds, or to the string's end.
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

// --- Blankness, for an append built through a reading of its tab

/** The words a batch past its piece is refused in. */
const NOT_SHOWN = "this change cannot be shown as it will read once applied, so it cannot be made";

describe("the closure made smaller, for an edit built from a reading", () => {
  it("blankness decided from the piece", () => {
    // An append built as `tabEditRequests` builds it, but asking the piece whether the tab is blank.
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
    // A piece at a tab's end reads as blank only where the tab is, so asking it is no worse;
    // what bites is the answer: a reading that answers the other way builds another batch.
    expect(wrong).toEqual({ closure: 0, own: 0, told: tabs.length * appends.length });
  });
});

// --- The closure made smaller, for a table change


/** The table changes of the default table and of the made tabs, each with its tab. */
const tableChanges = () => [
  ...pieceTableCorpus(DEFAULT_TABLE_CORPUS), ...madeTableCases(),
].flatMap(({ tab, draws }) => draws.flatMap(({ change }) => change ? [{ tab: tab.tab, change }] : []));

/** The table changes of those tabs that the whole tab builds a batch for, by kind. */
const TABLES_BUILT = [47, 33, 13, 4, 12, 37, 9, 10, 14, 7, 1];
const NONE = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

// The shrinks over table changes, by kind: a short piece refuses a table change and never
// builds another (`wrong` is 0). A table deleted or added reads what stands beside it, so
// `own`, `backBoth` and `offBack` refuse those; a piece that starts with its table has no index
// before it, so every other batch is caught.
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
    // A deletion the whole tab refuses for a numbered list far after its table is built where
    // the piece's own rendering is asked what follows the table.
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
    // A call on a table not first in its piece, checked on pieces that say no table stands
    // before them, meets another table or none.
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
    expect(other).toBeGreaterThan(0);
    expect([later, other, faults]).toEqual([99, 20, 78]);
  });
});
