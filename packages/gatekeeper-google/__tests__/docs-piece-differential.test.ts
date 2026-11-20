// The request builders of a text edit on a piece of a tab, held to the builders on the whole
// tab: a replacement outside tables and an append, each built from the closure of its own
// elements cut from the whole rendering, from the piece a store answers under several cuts of
// the tab into runs, and from the whole rendering under a recorder that fails on a read past
// the closure. The same batch, or the same refusal with the same text. Then the one place an
// edit becomes requests (`tabEditRequests`), a replacement in a table's cell and the scan's
// refusals among its edits, from a reading of the tab made each of those ways; every kind of
// table change the same way, with a table call's checks (`tableCallChange`) and its
// preparation, card and number (`prepareTableChange`), whose pieces are put under the
// recorder; an edit made in a stored version end to end, against the edit made in the tab in
// hand; and the shadow that holds the other suites' own calls the same way. Node only: the
// storage is the fake.

import { createSimulationStore } from "@gadgets/gatekeeper-kit/simulation-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GoogleDocsTab } from "../src/docs-api";
import * as model from "../src/docs-model";
import { storedTabReading } from "../src/docs-reading";
import {
  applyDocEdit, DocEditRefusedError, docEditRequests, docEditResult, docTabReducer, makeDocEdit,
  pieceOverreach, renderTab,
} from "../src/docs-replay";
import type { DocEdit, QueuedDocRecord } from "../src/docs-replay";
import { tableChangeRequests } from "../src/docs-tables";
import type { TableChange } from "../src/docs-tables";
import { RUN_SIZES } from "../src/docs-runs";
import type { RunSizes } from "../src/docs-runs";
import { DocStore, docStoreCost } from "../src/docs-store";
import type { DocVersion } from "../src/docs-store";
import { docTabToMarkdown, isBlankDocTab, MARKDOWN_RENDERING_VERSION } from "../src/markdown-converter";
import { buildTab, diceOf, para } from "./doc-fixture";
import { linesWithTablesTab } from "./doc-store-scenarios";
import { readFixtures } from "./docs-live-fixtures";
import { SCENARIOS, stepEdit } from "./docs-live-recorder";
import {
  BULLETED, bullets, deleteColumn, deleteRange, deleteRow, insertColumn, insertRow, insertTable,
  insertText, mergeCells, pinRows, recordedSequenceCalls, styleText,
} from "./docs-model-draws";
import {
  APPEND, closureReading, expectSameCallFromReadings, expectSameFromPieces, expectSameFromReadings,
  expectSamePrepared, fromClosure, fromReading, fromStore, fromWhole, pieceCase, pieceStore,
  recordedReading, renderedOf, REPLACE, sandwiched,
} from "./docs-piece-shadow";
import type { PieceCase, PieceVerdict, ReadingVerdict, Shrink } from "./docs-piece-shadow";
import {
  DEFAULT_CORPUS, DEFAULT_TABLE_CORPUS, madeTableCases, PIECE_SHAPES, pieceCorpus, pieceEdits,
  pieceTableCorpus, pieceTabs, tabEditCorpus, tabEdits,
} from "./docs-piece-tabs";
import type { PieceDraw, PieceShape, PieceTab, TabEditDraw, TableDraw } from "./docs-piece-tabs";
import { shadowTally, shrinkShadowForTest } from "./docs-piece-suite-shadow";
import { asFetched } from "./docs-store-slice-shadow";
import { recordedTabs } from "./render-run-tabs";
import { WIDER } from "./wider-run";

/** Runs of exactly `elements` elements, a table alone: no run ends by its content. */
const runsOf = (elements: number): RunSizes =>
  ({ least: Infinity, target: Infinity, most: Infinity, elements });
const ONE = runsOf(1);
const TWO = runsOf(2);
const THREE = runsOf(3);

/** What a test counts of the cases it holds. */
type Tally = {
  /** Cases the whole tab builds a batch for, and cases it refuses, the pieces the same. */
  built: number;
  refused: number;
  /** Built cases whose closure leaves an element of the tab out, in all and by entry. */
  strict: number;
  strictReplacements: number;
  strictAppends: number;
  /** Built cases whose batch names an index in the element next to the piece's first, and last. */
  nearBefore: number;
  nearAfter: number;
  /** Built cases `pieceOverreach` counts to the batch's end on the side after, and the others. */
  counted: number;
  stopped: number;
};

const noTally = (): Tally => ({
  built: 0, refused: 0, strict: 0, strictReplacements: 0, strictAppends: 0, nearBefore: 0,
  nearAfter: 0, counted: 0, stopped: 0,
});

/** Counts `verdict`, of a case of `entry`, in `tally`. */
function count(tally: Tally, { entry }: PieceCase, verdict: PieceVerdict): void {
  if (!verdict.built) {
    tally.refused++;
    return;
  }
  tally.built++;
  if (verdict.strict) {
    tally.strict++;
    if (entry === APPEND) tally.strictAppends++;
    else tally.strictReplacements++;
  }
  if (verdict.nearBefore) tally.nearBefore++;
  if (verdict.nearAfter) tally.nearAfter++;
  if (verdict.counted) tally.counted++;
  else tally.stopped++;
}

/** Every batch any test of the file checked against its piece, counted together. */
const all = noTally();

/** Holds `drawn` on `tab` under `sizings` (`expectSameFromPieces`) and counts it in `tallies`. */
function held(
  tab: GoogleDocsTab, drawn: PieceCase, sizings: readonly RunSizes[], ...tallies: Tally[]
): PieceVerdict {
  let verdict = expectSameFromPieces(tab, drawn.entry, drawn.edit, sizings);
  for (let tally of [all, ...tallies]) count(tally, drawn, verdict);
  return verdict;
}

/**
 * Holds `tally` to floors, so that a corpus that stops testing anything fails: at least so
 * many edits built and so many refused, the pieces giving the same; of the built ones, so
 * many whose closure leaves an element of the tab out, which are the cases that test the
 * closure; and of those, so many of each entry, each of which ran under the recorder.
 */
function expectAtLeast(
  tally: Tally,
  floors: { built: number; refused: number; strict: number; replacements: number; appends: number },
): void {
  expect(tally.built).toBeGreaterThanOrEqual(floors.built);
  expect(tally.refused).toBeGreaterThanOrEqual(floors.refused);
  expect(tally.strict).toBeGreaterThanOrEqual(floors.strict);
  expect(tally.strictReplacements).toBeGreaterThanOrEqual(floors.replacements);
  expect(tally.strictAppends).toBeGreaterThanOrEqual(floors.appends);
}

/** Every recorded step with the tab Google answered before it, as a fetch hands it to a store. */
const STEPS = readFixtures().flatMap(({ name, before, steps }) => {
  let scenario = SCENARIOS.find(candidate => candidate.name === name)!;
  return scenario.steps.map((step, position) =>
    ({ step, tab: asFetched(position === 0 ? before : steps[position - 1].after) }));
});

/**
 * The edit of a recorded `step` in `tab`, where it is one of the two this file holds: a
 * replacement outside tables of a text that is there once, or an append to a tab that is not
 * blank and ends in a paragraph.
 */
function textCase(tab: GoogleDocsTab, step: (typeof STEPS)[number]["step"]): PieceCase | undefined {
  let { rendering } = renderedOf(tab);
  if ("append" in step) {
    let ends = rendering.sourceMap.blocks.at(-1)?.docEnd === rendering.bodyEndIndex;
    return ends && !isBlankDocTab(rendering) ? pieceCase(APPEND, { markdown: step.append }) : undefined;
  }
  if (!("replace" in step)) return undefined;
  let edit = stepEdit(step, rendering);
  if (edit.type !== "replaceText" || edit.inTable) return undefined;
  let { oldMarkdown, newMarkdown } = edit;
  return pieceCase(REPLACE, { matchStart: rendering.markdown.indexOf(oldMarkdown), oldMarkdown, newMarkdown });
}

/** The text of the paragraph `tab` ends in. */
const ending = (tab: GoogleDocsTab) =>
  tab.body.content.at(-1)!.paragraph?.elements.map(element => element.textRun?.content ?? "").join("");

/** An `updateTextStyle` that makes `[start, end)` bold. */
const bold = (start: number, end: number) => styleText(start, end, { bold: true }, "bold");

/** A tab of another corpus as the seeded edits are drawn on one: it marks no shape. */
const unmarked = (name: string, tab: GoogleDocsTab): PieceTab =>
  ({ name, tab, shapes: new Set(), marks: new Map() });

const SIZINGS = {
  one: ["one element a run", ONE], two: ["two elements a run", TWO],
  three: ["three elements a run", THREE], real: ["the real cut", RUN_SIZES],
} as const;

// THE TABLES, EACH OF TWO WIDTHS. `PURE` is the table of the test that builds from the closure
// with no store, a seed a test; `STORED` that of the tests that build from stored runs, a
// store a tab and sizing, with the rounds of edits drawn on every tab of the recordings;
// `SANDWICHES` the seeds and the sizings of the recorded steps inside a larger tab; and
// `SEQUENCES` which of the seeded sequences' tabs edits are drawn on, and how many.
const PURE = WIDER
  ? { ...DEFAULT_CORPUS, tabs: 500, edits: 24, seeds: [0, 1, 2] } : { ...DEFAULT_CORPUS, seeds: [0] };
const STORED = WIDER
  ? { tabs: 200, edits: 16, sizings: [SIZINGS.one, SIZINGS.two, SIZINGS.three, SIZINGS.real], rounds: [0, 1, 2] }
  : { tabs: 40, edits: 8, sizings: [SIZINGS.one, SIZINGS.three, SIZINGS.real], rounds: [] };
const SANDWICHES = WIDER
  ? { seeds: [1, 2, 3], sizings: [ONE, TWO, THREE, RUN_SIZES] } : { seeds: [1], sizings: [ONE, RUN_SIZES] };
const SEQUENCES = WIDER ? { every: 8, edits: 12 } : { every: 16, edits: 8 };

/** Every case the seeded tests hold, counted together, and by the shapes of its tab. */
const seeded = noTally();
const shapes = new Map<PieceShape, { holds: number; beside: number }>(
  PIECE_SHAPES.map(shape => [shape, { holds: 0, beside: 0 }]));

/** Holds a seeded case under `sizings` and counts it, with the shapes it holds and stands beside. */
function heldSeeded(tab: PieceTab, drawn: PieceDraw, sizings: readonly RunSizes[]): void {
  let verdict = held(tab.tab, drawn, sizings, seeded);
  if (!verdict.built || !verdict.strict) return;
  for (let shape of tab.shapes) shapes.get(shape)!.holds++;
  for (let shape of drawn.beside) shapes.get(shape)!.beside++;
}

/** The seed of the tabs stored under the sizing named `name`: other tabs for each sizing. */
const storedSeed = (name: string) =>
  DEFAULT_CORPUS.seed + 100 * (1 + Object.values(SIZINGS).findIndex(([other]) => other === name));

// The tests count as they go, and the tests that state a tally read what the tests before
// them counted: the file is run whole.
describe("the builders of a text edit on a piece of the tab", () => {
  it("every recorded step, on the tab as recorded", () => {
    let tally = noTally();
    for (let { step, tab } of STEPS) {
      let drawn = textCase(tab, step);
      if (drawn) held(tab, drawn, [ONE, TWO, THREE, RUN_SIZES], tally);
    }
    // A recorded tab is short: the closure of a step is the whole tab in one case in five.
    expectAtLeast(tally, { built: 110, refused: 0, strict: 85, replacements: 55, appends: 30 });
  });

  it.each(SANDWICHES.seeds)("every recorded step, inside a larger tab, seed %i", seed => {
    let tally = noTally();
    for (let [number, { step, tab }] of STEPS.entries()) {
      // An append is built at the larger tab's end: after a filler it would stand after the
      // filler's last paragraph, its closure holding nothing of the recorded tab. So a step
      // that appends gets the filler before alone, and is built after the recorded ending.
      let larger = sandwiched(tab, seed * 1000 + number * 2, "append" in step);
      if ("append" in step) expect(ending(larger)).toBe(ending(tab));
      let drawn = textCase(larger, step);
      if (drawn) held(larger, drawn, SANDWICHES.sizings, tally);
    }
    // Inside a larger tab every closure is a strict part, and no step's tab is blank: an
    // append to a recorded tab that is blank is built after its one empty paragraph.
    expectAtLeast(tally, { built: 140, refused: 0, strict: 140, replacements: 75, appends: 60 });
    expect(tally.strict).toBe(tally.built);
  });

  // The seeded sequences are batches applied to the model, and hold no edit: the edits are
  // drawn on the tabs they reach, the last tab of every `every`-th sequence.
  it("edits drawn on the tabs the seeded sequences reach", () => {
    let tally = noTally();
    let last = new Map<number, string>();
    for (let call of recordedSequenceCalls(20261113, 320, false).calls) {
      if (call.sequence % SEQUENCES.every === 0) last.set(call.sequence, call.json);
    }
    for (let [sequence, json] of last) {
      let [tab] = JSON.parse(json) as [GoogleDocsTab, unknown];
      let reached = unmarked(`sequence ${sequence}`, asFetched(tab));
      for (let drawn of pieceEdits(reached, sequence, SEQUENCES.edits)) {
        held(reached.tab, drawn, [ONE, RUN_SIZES], tally);
      }
    }
    expect(last.size).toBe(320 / SEQUENCES.every);
    expectAtLeast(tally, { built: 30, refused: 45, strict: 30, replacements: 23, appends: 6 });
  });

  it("draws tabs of 20 to 60 elements that hold every shape", () => {
    let tabs = pieceTabs(DEFAULT_CORPUS.seed, DEFAULT_CORPUS.tabs);
    let sizes = tabs.map(({ tab }) => tab.body.content.length);
    expect([Math.min(...sizes), Math.max(...sizes)]).toEqual([20, 60]);
    // Three shapes a tab in turn, and those drawn beside them.
    for (let shape of PIECE_SHAPES) {
      expect(tabs.filter(tab => tab.shapes.has(shape)).length, shape).toBeGreaterThanOrEqual(30);
    }
    // One tab in ten holds a run of 40 empty paragraphs.
    expect(tabs.filter(({ marks }) => (marks.get("empties")?.length ?? 0) >= 40)).toHaveLength(12);
  });

  it.each(PURE.seeds)("seeded tabs and edits, from the closure, seed %i", seed => {
    for (let { tab, drawn } of pieceCorpus({ ...PURE, seed: PURE.seed + seed })) heldSeeded(tab, drawn, []);
  });

  it.each(STORED.sizings)("seeded tabs and edits, from stored runs, %s", (name, sizes) => {
    for (let { tab, drawn } of pieceCorpus({ ...STORED, seed: storedSeed(name) })) {
      heldSeeded(tab, drawn, [sizes]);
    }
  });

  it.each(STORED.sizings.flatMap(([name, sizes]) => STORED.rounds.map(round => [name, round, sizes] as const)))(
    "edits drawn on every recorded tab, from stored runs, %s, round %i", (name, round, sizes) => {
      let tally = noTally();
      for (let [number, recorded] of recordedTabs().entries()) {
        let tab = asFetched(recorded.tab);
        let edits = pieceEdits(
          unmarked(recorded.name, tab), storedSeed(name) + round * 1009 + number, STORED.edits);
        for (let drawn of edits) held(tab, drawn, [sizes], tally);
      }
      // A recorded tab is short: about half the closures are a strict part of their tab.
      expectAtLeast(tally, { built: 3_000, refused: 100, strict: 1_500, replacements: 1_300, appends: 200 });
    });

  it("holds the seeded edits on closures that are a strict part of their tab", () => {
    // What the default table gives: 1,681 built, every one strict (1,483 replacements and 198
    // appends), and 467 refused the same.
    expectAtLeast(seeded, { built: 1_500, refused: 230, strict: 1_200, replacements: 740, appends: 100 });
    expect(seeded.strict).toBeGreaterThanOrEqual(0.8 * seeded.built);
  });

  it("every shape stands beside an edit", () => {
    // For each shape, the built edits with a strict closure on a tab that holds the shape,
    // and those of them drawn beside it: about half of what the default table gives.
    let floors: Record<PieceShape, [holds: number, beside: number]> = {
      empties: [650, 120], nested: [580, 290], tabbed: [440, 140], offPreset: [500, 115],
      positioned: [460, 27], positionedInList: [420, 80], protected: [440, 30], tables: [830, 100],
      tablesBeside: [380, 13], nestedTable: [440, 27], suggested: [450, 32], sectionBreak: [450, 33],
    };
    for (let shape of PIECE_SHAPES) {
      let [holds, beside] = floors[shape];
      expect(shapes.get(shape)!.holds, shape).toBeGreaterThanOrEqual(holds);
      expect(shapes.get(shape)!.beside, shape).toBeGreaterThanOrEqual(beside);
    }
  });

  it("a wider range is no worse", () => {
    let dice = diceOf(DEFAULT_CORPUS.seed);
    let wider: Shrink = ({ from, to }, _own, flags) => ({
      from: Math.max(0, from - 1 - dice.below(6)), to: Math.min(flags.length, to + 1 + dice.below(6)),
    });
    let widened = 0;
    for (let { tab, drawn } of pieceCorpus(DEFAULT_CORPUS)) {
      let closure = fromClosure(tab.tab, drawn.entry, drawn.edit);
      let wide = fromClosure(tab.tab, drawn.entry, drawn.edit, wider);
      expect(wide.outcome).toEqual(fromWhole(tab.tab, drawn.entry, drawn.edit));
      if (wide.range.to - wide.range.from > closure.range.to - closure.range.from) widened++;
    }
    expect(widened).toBeGreaterThanOrEqual(1_000);
  });

  it("no batch reaches past its piece", () => {
    // `expectSameFromPieces` asks `pieceOverreach` of every batch the whole tab builds, with
    // the closure the batch was built from: it names no side. What that check saw, in the
    // default pass: 2,017 batches, 69 of which name an index in the element next to their
    // piece's first and 181 in the element next to its last, so the check is asked at both
    // edges.
    expect(all.built).toBeGreaterThanOrEqual(1_900);
    expect(all.nearBefore).toBeGreaterThanOrEqual(30);
    expect(all.nearAfter).toBeGreaterThanOrEqual(90);
    // The builders of a text edit write no request that adds length but `insertText`, so the
    // side after a piece is counted to the end of every batch.
    expect([all.counted, all.stopped]).toEqual([all.built, 0]);
  });

  it("counts each index of a batch where it stood at least", () => {
    // A piece between indexes 100 and 200, the tab going on at both ends.
    let inner = { from: 100, to: 200 };
    let part = { first: false, last: false, inner };
    let side = (...requests: Parameters<typeof pieceOverreach>[0]) => pieceOverreach(requests, part);

    // Before: the lowest index a batch names, whatever its order, where the tab goes on.
    expect(side(bold(100, 200))).toBeUndefined();
    expect(side(bold(99, 120))).toBe("before");
    expect(side(insertText(150, "text"), deleteRange(99, 101))).toBe("before");
    expect(pieceOverreach([bold(99, 120)], { ...part, first: true })).toBeUndefined();

    // After: a range's last index and a deletion's end, where the tab goes on.
    expect(side(bold(150, 201))).toBeUndefined();
    expect(side(bold(150, 202))).toBe("after");
    expect(side(insertText(200, "text"))).toBeUndefined();
    expect(side(insertText(201, "text"))).toBe("after");
    expect(side(deleteRange(150, 200))).toBeUndefined();
    expect(side(deleteRange(150, 201))).toBe("after");
    expect(pieceOverreach([bold(150, 202)], { ...part, last: true })).toBeUndefined();
    expect(side(bold(99, 202))).toBe("before");

    // An index after text inserted is counted less the text: where it stood at least.
    expect(side(insertText(120, "ten chars."), bold(205, 211))).toBeUndefined();
    expect(side(insertText(120, "ten chars."), bold(205, 212))).toBe("after");
    expect(side(insertText(120, "four"), insertText(130, "six ch"), insertText(210, "text"))).toBeUndefined();
    expect(side(insertText(120, "four"), insertText(130, "six ch"), insertText(211, "text"))).toBe("after");

    // What only shortens what follows it is counted past: an index after it stood higher.
    for (let shortens of [
      deleteRange(110, 190), bullets(110, 120, BULLETED), deleteRow(110, 0), deleteColumn(110, 0),
    ]) {
      expect(side(shortens, bold(150, 201))).toBeUndefined();
      expect(side(shortens, bold(150, 202))).toBe("after");
      expect(side(insertText(105, "four"), shortens, bold(150, 206))).toBe("after");
    }
    // What changes no length is counted past too.
    expect(side(pinRows(110, 1), bold(150, 202))).toBe("after");

    // What may add length no request states ends the count: nothing after it is counted.
    for (let lengthens of [
      insertTable(110, 2, 2), insertRow(110, 0, true), insertColumn(110, 0, true), mergeCells(110, 0, 0, 1, 2),
    ]) {
      expect(side(lengthens, bold(150, 5_000))).toBeUndefined();
      expect(side(bold(150, 202), lengthens)).toBe("after");
    }
    // Its own index is counted, and so is an index below it on the side before: no request
    // moves an index below the lowest one at which a length changed.
    expect(side(insertTable(201, 2, 2))).toBe("after");
    expect(side(insertTable(110, 2, 2), bold(120, 130))).toBeUndefined();
    expect(side(insertTable(110, 2, 2), bold(50, 60))).toBe("before");

    // A request of no kind that names an index names no side, alone or among others.
    let named = { createNamedRange: { name: "n", range: { startIndex: 0, endIndex: 9_000 } } } as
      unknown as Parameters<typeof pieceOverreach>[0][number];
    expect(side(named)).toBeUndefined();
    expect(side(named, bold(150, 201))).toBeUndefined();
    expect(side(named, bold(150, 202))).toBe("after");
  });

  it("a batch of no request reaches nowhere", () => {
    expect(pieceOverreach([], { first: false, last: false, inner: { from: 7, to: 7 } })).toBeUndefined();

    // An edit that changes nothing builds no request, from a piece as from the whole tab.
    let lines = Array.from({ length: 12 }, (_, line) => para(line === 6 ? "Hello world" : `Line ${line}`));
    let tab = asFetched(buildTab(lines));
    let matchStart = renderedOf(tab).rendering.markdown.indexOf("world");
    let edit = { matchStart, oldMarkdown: "world", newMarkdown: "world" };
    expect(fromWhole(tab, REPLACE, edit)).toEqual({ requests: [] });
    let closure = fromClosure(tab, REPLACE, edit);
    expect(closure.range.to - closure.range.from).toBeLessThan(tab.body.content.length);
    expect(closure.outcome).toEqual({ requests: [] });
    expect(pieceOverreach([], closure.part)).toBeUndefined();
    for (let sizes of [ONE, RUN_SIZES]) {
      let stored = fromStore(tab, sizes, REPLACE, edit);
      expect(stored.piece.at).toEqual(closure.part);
      expect(stored.outcome).toEqual({ requests: [] });
    }
    expect(expectSameFromPieces(tab, REPLACE, edit, [ONE, RUN_SIZES]))
      .toEqual({ built: true, strict: true, nearBefore: false, nearAfter: false, counted: true });
  });

  it("a batch holds no object of the piece it was built from", () => {
    // `expectSameFromPieces` asks it of every batch built from a stored piece
    // (`sharedWithPiece`). The places a style of the rendering enters a request, each reached
    // here: the style at the place text is put in, the style of the text replaced, and the
    // link a replacement keeps.
    let link = { url: "https://example.com/page" };
    let strong = { bold: true };
    let lines = Array.from({ length: 12 }, (_, line) => para(`Line ${line}`));
    let tab = asFetched(buildTab([
      ...lines.slice(0, 6),
      { runs: ["Plain and ", { text: "bold words", style: strong }, "\n"] },
      { runs: ["See ", { text: "the page", style: { link } }, "\n"] },
      ...lines.slice(6),
    ]));
    let { markdown } = renderedOf(tab).rendering;
    let cases: [oldMarkdown: string, newMarkdown: string, style: object][] = [
      ["bold words", "bolder words", strong],
      ["bold words", "bold things", strong],
      ["[the page](https://example.com/page)", "[that page](https://example.com/page)", { link }],
    ];
    for (let [oldMarkdown, newMarkdown, style] of cases) {
      let edit = { matchStart: markdown.indexOf(oldMarkdown), oldMarkdown, newMarkdown };
      expect(expectSameFromPieces(tab, REPLACE, edit, [ONE, RUN_SIZES]))
        .toMatchObject({ built: true, strict: true });
      // The batch carries the style, by value: so the copy was made.
      let { outcome, piece } = fromStore(tab, RUN_SIZES, REPLACE, edit);
      let styles = "requests" in outcome
        ? outcome.requests.flatMap(request =>
          "updateTextStyle" in request ? [request.updateTextStyle.textStyle] : [])
        : [];
      expect(styles).toContainEqual(expect.objectContaining(style));
      // And the piece holds an object equal to each of them, which the batch could have held.
      let ofPiece = [...piece.decoded.values()].flatMap(({ elements }) => elements).flatMap(
        element => element.paragraph?.elements.map(part => part.textRun?.textStyle) ?? []);
      expect(ofPiece).toContainEqual(expect.objectContaining(style));
    }
  });
});

// ---------------------------------------------------------------------------
// The one place an edit becomes requests, on a reading of the tab
// ---------------------------------------------------------------------------

/** What the tests of `tabEditRequests` count, by the kind of edit drawn. */
type KindTally = Record<TabEditDraw["kind"] | "blankAppend" | "empty", { cases: number; strict: number }>;
const noKinds = (): KindTally => ({
  replace: { cases: 0, strict: 0 }, cell: { cases: 0, strict: 0 }, append: { cases: 0, strict: 0 },
  blankAppend: { cases: 0, strict: 0 }, absent: { cases: 0, strict: 0 }, twice: { cases: 0, strict: 0 },
  empty: { cases: 0, strict: 0 },
});

/** The edit of a recorded text `step` in `tab`, as it is queued, and where its text stands. */
function stepDraw(tab: GoogleDocsTab, step: (typeof STEPS)[number]["step"]): TabEditDraw | undefined {
  let { rendering } = renderedOf(tab);
  if ("append" in step) return { edit: { type: "appendText", markdown: step.append }, kind: "append" };
  if (!("replace" in step)) return undefined;
  let edit = stepEdit(step, rendering);
  if (edit.type !== "replaceText") return undefined;
  let first = rendering.markdown.indexOf(edit.oldMarkdown);
  let once = first >= 0 && rendering.markdown.indexOf(edit.oldMarkdown, first + 1) < 0;
  return {
    edit, kind: !once ? (first < 0 ? "absent" : "twice") : edit.inTable ? "cell" : "replace",
    ...(once ? { matchStart: first } : {}),
  };
}

/** Holds `drawn` on `tab` under `sizings` (`expectSameFromReadings`) and counts it by its kind. */
function heldByReading(
  tab: GoogleDocsTab, drawn: Omit<TabEditDraw, "kind"> & { kind: keyof KindTally },
  sizings: readonly RunSizes[], tally: KindTally,
): void {
  let verdict = expectSameFromReadings(tab, drawn.edit, sizings, drawn.matchStart);
  let kind: keyof KindTally =
    drawn.kind === "append" && isBlankDocTab(renderedOf(tab).rendering) ? "blankAppend" : drawn.kind;
  // The scan's refusals are refused as the scan words them, whatever kind was drawn.
  if (drawn.kind === "absent") expect(verdict.refused).toContain("was not found");
  if (drawn.kind === "twice") expect(verdict.refused).toContain("matches multiple locations");
  tally[kind].cases++;
  if (verdict.strict) tally[kind].strict++;
}

// A case is built from stored runs once a sizing: the wider table is held in parts, a test
// each of every fourth case, and each part holds the floor by itself.
const READINGS = WIDER
  ? { tabs: 120, edits: 12, sizings: [ONE, TWO, THREE, RUN_SIZES], parts: 4 }
  : { tabs: 30, edits: 8, sizings: [ONE, RUN_SIZES], parts: 1 };

describe("a text edit built from a reading of its tab", () => {
  it("every recorded step, on the tab as recorded, under every sizing", () => {
    let tally = noKinds();
    for (let { step, tab } of STEPS) {
      let drawn = stepDraw(tab, step);
      if (drawn) heldByReading(tab, drawn, [ONE, TWO, THREE, RUN_SIZES], tally);
    }
    // About half of what the recordings give (62 strict replacements outside tables of 85,
    // 36 strict appends of 38, and 32 appends to a blank tab). A recorded tab is short: the
    // closure of each of the three replacements in a cell is its whole tab, so they are
    // strict only inside a larger tab, below.
    expect(tally.replace.strict).toBeGreaterThanOrEqual(30);
    expect(tally.cell).toEqual({ cases: 3, strict: 0 });
    expect(tally.append.strict).toBeGreaterThanOrEqual(18);
    expect(tally.blankAppend.cases).toBeGreaterThanOrEqual(16);
  });

  it("every recorded step, inside a larger tab", () => {
    let tally = noKinds();
    for (let [number, { step, tab }] of STEPS.entries()) {
      let larger = sandwiched(tab, 5_000 + number * 2, "append" in step);
      let drawn = stepDraw(larger, step);
      if (drawn) heldByReading(larger, drawn, [ONE, RUN_SIZES], tally);
    }
    // Inside a larger tab the closure of every text that stands once is a strict part, a
    // cell's among them, and no tab is blank.
    expect(tally.replace.strict).toBeGreaterThanOrEqual(42);
    expect(tally.replace.strict).toBe(tally.replace.cases);
    expect(tally.cell).toEqual({ cases: 3, strict: 3 });
    expect(tally.append.strict).toBeGreaterThanOrEqual(35);
    expect(tally.blankAppend.cases).toBe(0);
  });

  it.each(Array.from({ length: READINGS.parts }, (_, part) => part))(
    "seeded tabs and edits, cells and the scan's refusals among them, part %i", part => {
      let tally = noKinds();
      let corpus = tabEditCorpus({ ...READINGS, seed: DEFAULT_CORPUS.seed + 500 });
      for (let [number, { tab, drawn }] of corpus.entries()) {
        if (number % READINGS.parts === part) heldByReading(tab.tab, drawn, READINGS.sizings, tally);
      }
      // THE FLOOR, of each part, about half of what the default table gives, each case built
      // under the recorder too: strict replacements outside tables and in cells, strict
      // appends to a tab that is not blank, and the scan's refusals of a text that is not
      // there and of one that stands more than once, which name no piece.
      // (218, 95 and 20 strict, and 12 and 13 refused, in the default table; no part of the
      // wider table gives fewer than 312, 122 and 28, and 20 and 21.)
      expect(tally.replace.strict).toBeGreaterThanOrEqual(110);
      expect(tally.cell.strict).toBeGreaterThanOrEqual(45);
      expect(tally.append.strict).toBeGreaterThanOrEqual(10);
      expect(tally.absent.cases).toBeGreaterThanOrEqual(6);
      expect(tally.twice.cases).toBeGreaterThanOrEqual(6);
      expect([tally.absent.strict, tally.twice.strict]).toEqual([0, 0]);
    });

  it("appends to blank tabs, and a text that is empty", () => {
    let tally = noKinds();
    let silent = { startIndex: 1, endIndex: 1 } as GoogleDocsTab["body"]["content"][number];
    let quiet = buildTab([para("")]);
    quiet.body.content.splice(1, 0, silent, silent);
    let tabs = [
      buildTab([para("")]), quiet, buildTab([para("Text"), para("")]), buildTab([para("Text"), para(""), para("")]),
      buildTab(Array.from({ length: 9 }, (_, line) => para(line === 8 ? "" : `Line ${line}`))),
    ].map(asFetched);
    for (let tab of tabs) {
      for (let markdown of ["More", "# Head\n\nBody", "- one\n- two", ""]) {
        heldByReading(tab, { edit: { type: "appendText", markdown }, kind: "append" }, [ONE, RUN_SIZES], tally);
      }
      heldByReading(
        tab, { edit: { type: "replaceText", oldMarkdown: "", newMarkdown: "x" }, kind: "empty" }, [ONE], tally);
    }
    // A BLANK TAB'S CLOSURE IS NEVER STRICT: a blank tab holds no element that writes a
    // character, so each step back from its end passes every element and runs out at the
    // tab's first: the piece is the whole tab. Blankness is the tab's own answer all the
    // same, which the tabs that end in an empty paragraph after text hold: their piece at
    // the end renders as line breaks, and the tab is not blank.
    expect(tally.blankAppend).toEqual({ cases: 8, strict: 0 });
    expect(tally.append.cases).toBe(12);
    expect(tally.append.strict).toBeGreaterThanOrEqual(4);
    expect(tally.empty).toEqual({ cases: 5, strict: 0 });
  });

  it("an edit that builds no request", () => {
    // The edit that changes nothing, on a tab where its closure is a strict part and crosses
    // a run's edge: no request from any reading, no side named, and the version itself.
    let lines = Array.from({ length: 12 }, (_, line) => para(line === 6 ? "Hello world" : `Line ${line}`));
    let tab = asFetched(buildTab(lines));
    let edit: DocEdit = { type: "replaceText", oldMarkdown: "world", newMarkdown: "world" };
    let closed = closureReading(tab);
    expect(fromReading(closed, edit)).toEqual({ requests: [] });
    let range = closed.range()!;
    expect(range.to - range.from).toBeLessThan(tab.body.content.length);
    expect(fromReading(recordedReading(tab), edit)).toEqual({ requests: [] });
    for (let sizes of [ONE, THREE]) {
      let { store, storage, base } = pieceStore(tab, sizes);
      let reading = storedTabReading(store, base);
      expect(fromReading(reading, edit)).toEqual({ requests: [] });
      // The closure crosses a run's edge: more than one run was decoded for it.
      expect(reading.takeDecoded()!.size).toBeGreaterThan(1);
      let before = storage.rows();
      let made = docEditResult(store, base, edit);
      expect(made).toEqual({ requests: [], after: base });
      // Nothing is stored but the result.
      let after = storage.rows();
      expect(after.doc_result).toHaveLength(1);
      expect(after).toEqual({ ...before, doc_result: after.doc_result });
    }
  });
});

// ---------------------------------------------------------------------------
// Table changes: built from a reading, checked as a call, and prepared
// ---------------------------------------------------------------------------

/** The eleven kinds of table change. */
const TABLE_KINDS = [
  "insertTable", "insertTableRows", "insertTableColumns", "deleteTableRows", "deleteTableColumns",
  "deleteTable", "setTableCellStyle", "setTableColumnWidths", "setTableRowHeights",
  "mergeTableCells", "unmergeTableCells",
] as const satisfies readonly TableChange["type"][];
type TableKind = (typeof TABLE_KINDS)[number];

/** What the tests of table changes count for one kind of change. */
type KindCount = {
  /** Cases held, each built from the whole tab, its closure, the recorder and stored runs. */
  cases: number;
  /** Cases whose closure leaves an element of the tab out: built under the recorder too. */
  strict: number;
  /** Batches built, and those of them whose count on the side after the piece stopped. */
  built: number;
  stopped: number;
};
const noKindCounts = (): Record<TableKind, KindCount> => Object.fromEntries(
  TABLE_KINDS.map(kind => [kind, { cases: 0, strict: 0, built: 0, stopped: 0 }])) as Record<TableKind, KindCount>;
/** Counts `verdict`, of a case of `kind`, in `counts`. */
function countKind(counts: Record<TableKind, KindCount>, kind: TableKind, verdict: ReadingVerdict): void {
  let count = counts[kind];
  count.cases++;
  if (verdict.strict) count.strict++;
  if (!verdict.built) return;
  count.built++;
  if (verdict.counted === false) count.stopped++;
}
/** Of `counts`, the member `of` for every kind, in the order of `TABLE_KINDS`. */
const byKind = (counts: Record<TableKind, KindCount>, of: keyof KindCount) =>
  TABLE_KINDS.map(kind => counts[kind][of]);
/** Holds each number of `counts`, which are in the order of `TABLE_KINDS`, to its floor. */
function expectFloors(counts: readonly number[], floors: readonly number[]): void {
  expect(floors).toHaveLength(TABLE_KINDS.length);
  // No kind's floor is 0: a kind that stops being drawn fails.
  expect(Math.min(...floors)).toBeGreaterThan(0);
  for (let [at, kind] of TABLE_KINDS.entries()) expect(counts[at], kind).toBeGreaterThanOrEqual(floors[at]);
}

// THE TABLES OF THE TABLE CHANGES, EACH OF TWO WIDTHS: the seeded tabs, the changes drawn on
// each and the sizings they are held under; the sizings of the recorded steps; and those of
// the preparations, which make each change in a store twice.
const TABLE_CHANGES = WIDER
  ? { ...DEFAULT_TABLE_CORPUS, tabs: 60, edits: 8, sizings: [ONE, TWO, THREE, RUN_SIZES], prepared: [ONE, THREE] }
  : { ...DEFAULT_TABLE_CORPUS, sizings: [ONE, RUN_SIZES], prepared: [ONE, RUN_SIZES] };

/** The seeded tabs of the table changes, each with the changes drawn on it. */
const tableCorpus = () => pieceTableCorpus(TABLE_CHANGES);

/** The recorded steps that change a table, each with the change it queues on its tab. */
const TABLE_STEPS = STEPS.flatMap(({ step, tab }) => {
  if (!("table" in step)) return [];
  return [{ tab, change: stepEdit(step, renderedOf(tab).rendering) as TableChange }];
});

describe("a table change built from a reading of its tab", () => {
  /** Every case of this describe, by kind, and the seeded ones by the shapes they stand beside. */
  let all = noKindCounts();
  let besides = new Map<PieceShape, number>(PIECE_SHAPES.map(shape => [shape, 0]));
  /** The refusals the whole tab gave, each counted. */
  let refusals = new Map<string, number>();
  /** Holds `change` on `tab` under `sizings` and counts it. */
  function heldChange(
    tab: GoogleDocsTab, change: TableChange, sizings: readonly RunSizes[],
    ...counts: Record<TableKind, KindCount>[]
  ): ReadingVerdict {
    let verdict = expectSameFromReadings(tab, change, sizings);
    for (let count of [all, ...counts]) countKind(count, change.type, verdict);
    if (verdict.refused !== undefined) refusals.set(verdict.refused, (refusals.get(verdict.refused) ?? 0) + 1);
    return verdict;
  }
  const refused = (words: string) =>
    [...refusals].reduce((sum, [message, times]) => message.includes(words) ? sum + times : sum, 0);

  it("every recorded step that changes a table, on the tab as recorded", () => {
    let counts = noKindCounts();
    for (let { tab, change } of TABLE_STEPS) heldChange(tab, change, [ONE, TWO, THREE, RUN_SIZES], counts);
    // The recordings hold 41 steps that change a table, of every kind, each of which its tab
    // takes. A recorded tab is short: the closure of all but two is the whole tab, so the
    // steps are strict inside a larger tab, below.
    expect(byKind(counts, "cases")).toEqual([10, 4, 4, 3, 1, 1, 7, 4, 1, 3, 3]);
    expect(byKind(counts, "built")).toEqual(byKind(counts, "cases"));
    expect(byKind(counts, "strict")).toEqual([2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("every recorded step that changes a table, inside a larger tab", () => {
    let counts = noKindCounts();
    for (let [number, { tab, change }] of TABLE_STEPS.entries()) {
      // A table added at the tab's end is built there: with no filler after, it stands after
      // the recorded ending.
      let larger = sandwiched(tab, 7_000 + number * 2, change.type === "insertTable" && change.after === undefined);
      heldChange(larger, change, [ONE, RUN_SIZES], counts);
    }
    // Inside a larger tab every step is built from a strict part of the tab, under the
    // recorder too.
    expect(byKind(counts, "cases")).toEqual([10, 4, 4, 3, 1, 1, 7, 4, 1, 3, 3]);
    expect(byKind(counts, "built")).toEqual(byKind(counts, "cases"));
    expect(byKind(counts, "strict")).toEqual(byKind(counts, "cases"));
  });

  it("seeded tabs and changes", () => {
    let counts = noKindCounts();
    for (let { tab, draws } of tableCorpus()) {
      for (let { change, beside } of draws) {
        if (!change) continue;
        let verdict = heldChange(tab.tab, change, TABLE_CHANGES.sizings, counts);
        if (verdict.strict) for (let shape of beside) besides.set(shape, besides.get(shape)! + 1);
      }
    }
    // THE FLOOR, A KIND OF CHANGE: the cases whose closure leaves an element of the tab out,
    // each built under the recorder too, at about half of what the default table gives (31,
    // 21, 11, 10, 16, 26, 7, 8, 12, 11 and 6, in the order of the kinds).
    expectFloors(byKind(counts, "strict"), [15, 10, 5, 5, 8, 13, 3, 4, 6, 5, 3]);
    // THE SHAPES a strict change stands beside: its table, or the element a new table
    // follows, is of the shape or next to an element of it. A table in a cell, a suggested
    // row or cell, tables beside tables and a paragraph a positioned object is anchored to
    // among them. (142, 52, 39, 22 and 4 in the default table; every other shape once to
    // three times.)
    let floors: Partial<Record<PieceShape, number>> =
      { tables: 70, tablesBeside: 26, nestedTable: 19, suggested: 11, positioned: 2 };
    for (let shape of PIECE_SHAPES) {
      expect(besides.get(shape), shape).toBeGreaterThanOrEqual(floors[shape] ?? 1);
    }
  });

  it("the tabs made for what a table change asks of its tab as a whole", () => {
    let counts = noKindCounts();
    for (let { tab, draws } of madeTableCases()) {
      for (let { change } of draws) if (change) heldChange(tab.tab, change, [ONE, RUN_SIZES], counts);
    }
    // Every kind is drawn on them, and built for all but three from a strict part.
    expectFloors(byKind(counts, "strict"), [7, 7, 2, 3, 2, 4, 1, 1, 1, 1, 1]);
    // WHAT THE TAB AS A WHOLE REFUSES, each from a piece that does not hold what refuses it:
    // a second table that reads the same, a numbered list after a table of numbered items,
    // the cells the tab's tables may hold, and a text a new table is to follow that stands
    // twice, or nowhere; and a table that reads as none of the tab does.
    for (let words of [
      "another table of the tab now reads the same", "holds items of a numbered list",
      "tables, rows and columns can be added only until the tables of a tab hold",
      "insertTable: after matches multiple locations", "insertTable: after was not found",
      "the table no longer reads as it did when this change was queued",
    ]) {
      expect(refused(words), words).toBeGreaterThan(0);
    }
    // And what the builders refuse of a table, from the piece around it.
    for (let words of [
      "this would delete every row", "holds suggested changes to its rows, columns or cells",
      "do not all have the same number of cells", "no merged cell starts at",
      "cross the merged cell", "a table cannot be added between two items of a list",
    ]) {
      expect(refused(words), words).toBeGreaterThan(0);
    }
  });

  it("no table batch reaches past its piece", () => {
    // `tabEditRequests` checks every batch against the piece it was built from
    // (`pieceOverreach`), and every piece above gave the whole tab's batch: none names a
    // side. WHAT THAT CHECK SAW, by kind: the batches built, and those for which its count
    // on the side after the piece STOPPED at a request that adds length no request states.
    // A new table, a row or a column inserted and cells merged are such requests, and each
    // is the first of its batch: for every batch of those four kinds the check after the
    // piece sees nothing past it, and the differential, not the check, is what holds them.
    // The other seven kinds are counted to their last request.
    let built = byKind(all, "built"), stopped = byKind(all, "stopped");
    let lengthens: readonly TableKind[] =
      ["insertTable", "insertTableRows", "insertTableColumns", "mergeTableCells"];
    expect(stopped).toEqual(TABLE_KINDS.map((kind, at) => lengthens.includes(kind) ? built[at] : 0));
    if (!WIDER) {
      expect(built).toEqual([67, 41, 21, 10, 14, 39, 23, 18, 16, 13, 7]);
      expect(stopped).toEqual([67, 41, 21, 0, 0, 0, 0, 0, 0, 13, 0]);
    }
  });
});

describe("a table call checked against a reading of its tab", () => {
  let all = noKindCounts();
  let refusals = new Map<string, number>();
  const refused = (words: string) =>
    [...refusals].reduce((sum, [message, times]) => message.includes(words) ? sum + times : sum, 0);
  /** Holds `call`, of `kind`, on `tab` under `sizings` and counts it. */
  function heldCall(tab: GoogleDocsTab, { kind, call }: TableDraw, sizings: readonly RunSizes[]): void {
    if (!call) return;
    let verdict = expectSameCallFromReadings(tab, call, sizings);
    countKind(all, kind, verdict);
    if (verdict.refused !== undefined) refusals.set(verdict.refused, (refusals.get(verdict.refused) ?? 0) + 1);
  }

  it("seeded tabs and calls", () => {
    for (let { tab, draws } of tableCorpus()) {
      for (let drawn of draws) heldCall(tab.tab, drawn, TABLE_CHANGES.sizings);
    }
    // THE FLOOR, FOR CALLS BY NUMBER: the calls whose table's closure leaves an element of
    // the tab out, each checked under the recorder too, at about half of what the default
    // table gives (21, 11, 10, 16, 26, 7, 9, 12, 11 and 6, in the order of the kinds). A call
    // to add a table asks no piece: its checks are the build's.
    let [added, ...existing] = byKind(all, "strict");
    expect(added).toBe(0);
    expectFloors([1, ...existing], [1, 10, 5, 5, 8, 13, 3, 4, 6, 5, 3]);
    // A number past the tab's tables is refused with the tab's count.
    expect(refused("has no table")).toBeGreaterThanOrEqual(4);
  });

  it("the tabs made for what a table call asks of its tab as a whole", () => {
    for (let { tab, draws } of madeTableCases()) {
      for (let drawn of draws) heldCall(tab.tab, drawn, [ONE, RUN_SIZES]);
    }
    // Two tables that read the same are refused with both numbers, which are the tab's; and
    // the questions the checks share with the builders are refused the same.
    for (let words of [
      "reads the same as table", "holds items of a numbered list",
      "tables, rows and columns can be added only until the tables of a tab hold",
    ]) {
      expect(refused(words), words).toBeGreaterThan(0);
    }
  });
});

describe("a table call prepared on a stored tab, its pieces under the recorder", () => {
  /** What the preparations of this describe gave, by kind: prepared and refused. */
  let prepared = Object.fromEntries(TABLE_KINDS.map(kind => [kind, [0, 0]])) as Record<TableKind, [number, number]>;
  /** The recorded pieces that were read back to the line before their table. */
  let asked = 0;
  /** Holds `call` prepared on `tab` under `sizings` and counts it; the number of a new table. */
  function heldPrepared(tab: GoogleDocsTab, { kind, call }: TableDraw, sizings: readonly RunSizes[]): number | undefined {
    if (!call) return undefined;
    let verdict = expectSamePrepared(tab, call, sizings);
    prepared[kind][verdict.prepared ? 0 : 1]++;
    asked += verdict.asked;
    return verdict.table;
  }
  /**
   * The number the table `change` adds has in the tab the change gives, made in the tab in
   * hand: the place of the first table of the tab after that the tab before does not hold
   * there.
   */
  function numberInHand(tab: GoogleDocsTab, change: TableChange): number {
    let before = renderedOf(tab).rendering;
    let after = docTabToMarkdown(makeDocEdit(tab, change).after);
    let html = (render: typeof before, place: number) => {
      let table = render.sourceMap.tables[place];
      return table && render.markdown.slice(table.mdStart, table.mdEnd);
    };
    return after.sourceMap.tables.findIndex((_, place) => html(after, place) !== html(before, place));
  }

  /** The new tables of the seeded calls that were numbered as the tab made in hand numbers them. */
  let numbered = 0;
  // A preparation makes its change in a store, twice a sizing: the wider table is held in
  // parts, a test each.
  const PARTS = WIDER ? 3 : 1;

  it.each(Array.from({ length: PARTS }, (_, part) => part))(
    "seeded tabs and calls, and the number a new table is given, part %i", part => {
      for (let [number, { tab, draws }] of tableCorpus().entries()) {
        if (number % PARTS !== part) continue;
        for (let drawn of draws) {
          let table = heldPrepared(tab.tab, drawn, TABLE_CHANGES.prepared);
          if (table === undefined) continue;
          // THE ORACLE: the new table's place among the tables of the tab made in hand.
          expect(table, tab.name).toBe(numberInHand(tab.tab, drawn.change!));
          numbered++;
        }
      }
    });

  it("prepares the seeded calls as cards, each with its pieces under the recorder", () => {
    // THE FLOOR, FOR PENDING CARDS: the calls on a table the tab holds that became a card,
    // each prepared with its pieces under the recorder too, at about half of what the
    // default table gives (87 in all: 14, 10, 0, 9, 26, 7, 8, 12, 1 and 0 in the order of
    // the kinds; rows deleted and a cell split are prepared on the made tabs, below).
    let cards = TABLE_KINDS.slice(1).reduce((sum, kind) => sum + prepared[kind][0], 0);
    expect(cards).toBeGreaterThanOrEqual(43);
    // And the new tables numbered as the tab made in hand numbers them (28).
    expect(numbered).toBeGreaterThanOrEqual(14);
    // A card names the nearest text before its table. Where the piece holds none (a table
    // behind tables and empty paragraphs), it asks its tab: 30 recorded pieces were read
    // back to that line.
    expect(asked).toBeGreaterThanOrEqual(10);
  });

  it("the tabs made for what a table call asks of its tab as a whole", () => {
    let made = 0;
    for (let { tab, draws } of madeTableCases()) {
      for (let drawn of draws) {
        let table = heldPrepared(tab.tab, drawn, [ONE, THREE]);
        if (table === undefined) continue;
        expect(table, tab.name).toBe(numberInHand(tab.tab, drawn.change!));
        made++;
      }
    }
    expect(made).toBeGreaterThanOrEqual(7);
    // Every kind became a card at least once, with its pieces under the recorder (42, 28,
    // 13, 3, 12, 33, 9, 10, 14, 3 and 1 with the seeded ones), and most were refused at
    // least once the same.
    expectFloors(TABLE_KINDS.map(kind => prepared[kind][0]), [21, 14, 6, 1, 6, 16, 4, 5, 7, 1, 1]);
    expect(TABLE_KINDS.reduce((sum, kind) => sum + prepared[kind][1], 0)).toBeGreaterThanOrEqual(40);
  });
});

// ---------------------------------------------------------------------------
// End to end: an edit made in a stored version, against the edit made in the tab in hand
// ---------------------------------------------------------------------------

/** `value` with every object and array in it frozen. */
function deepFrozen<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (let part of Object.values(value)) deepFrozen(part);
  return value;
}

/** What an edit made gave: its requests and the Markdown of the tab after, or its refusal. */
type Made = { requests: readonly unknown[]; markdown: string } | { refused: string };

/** `edit` made in the tab in hand (`makeDocEdit`). */
function madeInHand(tab: GoogleDocsTab, edit: DocEdit): { made: Made; after: GoogleDocsTab } {
  try {
    let { requests, after } = makeDocEdit(tab, edit);
    return { made: { requests, markdown: docTabToMarkdown(after).markdown }, after };
  } catch (error) {
    if (!(error instanceof Error) || error instanceof TypeError) throw error;
    return { made: { refused: error.message }, after: tab };
  }
}

/** `edit` made in `version` of `store` (`docEditResult`). */
function madeInStore(store: DocStore, version: DocVersion, edit: DocEdit): { made: Made; after: DocVersion } {
  try {
    let { requests, after } = docEditResult(store, version, edit);
    return { made: { requests, markdown: store.markdown(after) }, after };
  } catch (error) {
    if (!(error instanceof DocEditRefusedError)) throw error;
    return { made: { refused: error.refusal.reason }, after: version };
  }
}

const END_TO_END = WIDER ? { tabs: 80, edits: 10 } : { tabs: 20, edits: 6 };

describe("an edit made in a stored version, held to the edit made in the tab in hand", () => {
  /** The runs of the piece an edit was last built from, and how often a slice stored left them. */
  let last: { from: number; to: number } | undefined;
  let stored = 0, left = 0;

  beforeEach(() => {
    let { piece, putSlice } = DocStore.prototype;
    vi.spyOn(DocStore.prototype, "piece").mockImplementation(function (this: DocStore, version, at) {
      let made = piece.call(this, version, at);
      last = { from: made.from, to: made.to };
      return made;
    });
    vi.spyOn(DocStore.prototype, "putSlice").mockImplementation(function (this: DocStore, slice, made) {
      stored++;
      if (last && (slice.from < last.from || slice.to > last.to)) left++;
      return putSlice.call(this, slice, made);
    });
    // THE BUILT REQUESTS ARE DEEP-FROZEN BEFORE THE MODEL RUNS: the batch is first read for
    // its reach, by the check against its piece. A write through a request then throws.
    let reach = model.batchReach;
    vi.spyOn(model, "batchReach").mockImplementation(requests => reach(deepFrozen(requests)));
  });
  afterEach(() => vi.restoreAllMocks());

  /** Holds `edit` made in a store of `tab` under each sizing to the edit made in hand. */
  function heldEndToEnd(tab: GoogleDocsTab, edit: DocEdit, sizings: readonly RunSizes[]): boolean {
    let { made } = madeInHand(tab, edit);
    for (let sizes of sizings) {
      let { store, base } = pieceStore(tab, sizes);
      last = undefined;
      expect(madeInStore(store, base, edit).made).toEqual(made);
    }
    return "requests" in made;
  }

  it("every recorded step, one element a run and under the real cut", () => {
    let built = 0, refused = 0;
    for (let { step, tab } of STEPS) {
      let drawn = stepDraw(tab, step);
      if (!drawn) continue;
      if (heldEndToEnd(tab, drawn.edit, [ONE, RUN_SIZES])) built++;
      else refused++;
    }
    // Every recorded text step is one its tab takes: 158 built, none refused.
    expect(built).toBeGreaterThanOrEqual(100);
    expect(refused).toBe(0);
  });

  it("seeded tabs and edits, and a queue of three folded", () => {
    let built = 0, refused = 0, folded = 0;
    for (let [number, tab] of pieceTabs(DEFAULT_CORPUS.seed + 700, END_TO_END.tabs).entries()) {
      let draws = tabEdits(tab, DEFAULT_CORPUS.seed + 700 + 7919 * (number + 1), END_TO_END.edits);
      for (let { edit } of draws) {
        if (heldEndToEnd(tab.tab, edit, [number % 2 === 0 ? ONE : RUN_SIZES])) built++;
        else refused++;
      }
      // A queue of the first three edits, folded over the stored tab and made in hand one
      // after the other: the same edits refused, and the same tab at the end.
      let queue = draws.slice(0, 3).map(({ edit }, at): QueuedDocRecord => ({
        id: at + 1,
        action: { ...edit, tabId: tab.tab.tabId, markdownVersion: MARKDOWN_RENDERING_VERSION },
      }));
      let inHand = tab.tab, refusedInHand: number[] = [];
      for (let { id, action } of queue) {
        let { made, after } = madeInHand(inHand, action);
        if ("refused" in made) refusedInHand.push(id);
        inHand = after;
      }
      let { store, base } = pieceStore(tab.tab, number % 2 === 0 ? RUN_SIZES : ONE);
      let fold = createSimulationStore(docTabReducer(store)).fold(tab.tab.tabId, base, queue);
      expect(fold.refused.map(({ record }) => record.id)).toEqual(refusedInHand);
      expect(store.markdown(fold.entity!)).toBe(docTabToMarkdown(inHand).markdown);
      folded++;
    }
    // About half of what the tables give: 122 built and 55 refused by default.
    expect(built).toBeGreaterThanOrEqual(WIDER ? 440 : 60);
    expect(refused).toBeGreaterThanOrEqual(WIDER ? 150 : 25);
    expect(folded).toBe(END_TO_END.tabs);
  });

  it("seeded table changes, and those of the tabs made for a table change", () => {
    let built = 0, refused = 0;
    let held = (tab: GoogleDocsTab, draws: readonly TableDraw[], sizes: RunSizes) => {
      for (let { change } of draws) {
        if (!change) continue;
        if (heldEndToEnd(tab, change, [sizes])) built++;
        else refused++;
      }
    };
    for (let [number, { tab, draws }] of tableCorpus().entries()) {
      held(tab.tab, draws, number % 2 === 0 ? ONE : RUN_SIZES);
    }
    for (let [number, { tab, draws }] of madeTableCases().entries()) {
      held(tab.tab, draws, number % 2 === 0 ? RUN_SIZES : ONE);
    }
    // About half of what the tables give: 172 built and 82 refused by default.
    expect(built).toBeGreaterThanOrEqual(85);
    expect(refused).toBeGreaterThanOrEqual(40);
  });

  it("no slice the model was handed left the runs of the piece its batch was built from", () => {
    // Counted by the three tests above, which this one reads: every version stored for an edit
    // was cut from a slice inside the runs of the edit's piece. Nothing refuses an edit for
    // it: what the model reads is the model's to bound.
    // (651 versions stored by default: an edit under each sizing, the folds' steps, and the
    // table changes.)
    expect(stored).toBeGreaterThanOrEqual(WIDER ? 800 : 320);
    expect(left).toBe(0);
  });

  it("one decode for the closure and the slice", () => {
    // On the tab of 20,000 paragraphs under the real cut: a replacement inside one paragraph
    // in the middle of a run decodes the piece's runs, and no run more for the model.
    let lines = Array.from({ length: 20_000 }, (_, at) => `Line ${String(at).padStart(5, "0")}.`);
    let { store, base } = pieceStore(asFetched(linesWithTablesTab("t1", lines, [5_000, 10_000, 15_000])), RUN_SIZES);
    let reading = storedTabReading(store, base);
    let text = lines[7_030];
    let at = reading.find(text) as number;
    let before = docStoreCost.runsDecoded;
    reading.piece({ markdown: { mdStart: at, mdEnd: at + text.length } });
    let piece = docStoreCost.runsDecoded - before;
    expect(piece).toBe(1);

    before = docStoreCost.runsDecoded;
    let made = docEditResult(store, base, { type: "replaceText", oldMarkdown: text, newMarkdown: "Changed." }, reading);
    expect(made.requests.length).toBeGreaterThan(0);
    // The reading held the piece, and the slice took its run: nothing is decoded.
    expect(docStoreCost.runsDecoded - before).toBe(0);
    // With no reading handed in: the piece's runs, and none for the model.
    before = docStoreCost.runsDecoded;
    docEditResult(store, base, { type: "replaceText", oldMarkdown: lines[7_031], newMarkdown: "Other." });
    expect(docStoreCost.runsDecoded - before).toBe(piece);
  });
});

// ---------------------------------------------------------------------------
// The suites' own calls, shadowed
// ---------------------------------------------------------------------------

describe("the suites' own calls", () => {
  afterEach(() => shrinkShadowForTest(undefined));

  /** The recorded text steps, each with the edit it queues. */
  const TEXT_STEPS = STEPS.flatMap(({ step, tab }) => {
    let drawn = stepDraw(tab, step);
    return drawn && drawn.kind !== "absent" && drawn.kind !== "twice" ? [{ tab, edit: drawn.edit }] : [];
  });

  it("are shadowed: each builds again from the closure of its edit", () => {
    let before = shadowTally();
    // Five recorded steps made in the tab in hand, and three built from its rendering: from
    // the middle of the recordings on, where the tabs are longer than an edit's closure.
    let from = Math.floor(TEXT_STEPS.length / 2);
    for (let { tab, edit } of TEXT_STEPS.slice(from, from + 5)) applyDocEdit(tab, edit);
    for (let { tab, edit } of TEXT_STEPS.slice(from + 5, from + 8)) docEditRequests(renderTab(tab), edit);
    let after = shadowTally();
    expect(after.shadowed - before.shadowed).toBe(8);
    expect(after.skipped - before.skipped).toBe(0);
    expect(after.large - before.large).toBe(0);
    // Each is built again from a strict part of its tab, or passes because its closure is
    // the whole tab.
    expect((after.strict - before.strict) + (after.whole - before.whole)).toBe(8);
    expect(after.strict - before.strict).toBeGreaterThanOrEqual(1);

    // A TABLE CHANGE is built again from the piece around its table: a recorded step that
    // changes a table, inside a larger tab, made in the tab in hand and built from its
    // rendering. Each is built from a strict part of the tab.
    let { tab, change } = TABLE_STEPS.find(step => step.change.type === "insertTableRows")!;
    let larger = sandwiched(tab, 7_100);
    before = shadowTally();
    applyDocEdit(larger, change);
    tableChangeRequests(renderTab(larger), change);
    after = shadowTally();
    expect([after.shadowed - before.shadowed, after.strict - before.strict]).toEqual([2, 2]);
  });

  it("fail the calling test where the closure builds another batch", () => {
    // One element off the back of the closure: the first edit of the default table for which
    // that builds another batch, with no error and no index past the smaller piece.
    let offBack: Shrink = ({ from, to }, own) => ({ from, to: Math.max(own.last + 1, to - 1) });
    let found = pieceCorpus(DEFAULT_CORPUS).find(({ tab, drawn }) => {
      if (drawn.entry !== REPLACE) return false;
      let whole = fromWhole(tab.tab, drawn.entry, drawn.edit);
      let { outcome, part } = fromClosure(tab.tab, drawn.entry, drawn.edit, offBack);
      return "requests" in whole && "requests" in outcome &&
        JSON.stringify(outcome) !== JSON.stringify(whole) && !pieceOverreach(outcome.requests, part);
    });
    expect(found).toBeDefined();
    let { tab, drawn } = found!;
    let { oldMarkdown, newMarkdown } = drawn.edit as { oldMarkdown: string; newMarkdown: string };
    let edit: DocEdit = { type: "replaceText", oldMarkdown, newMarkdown };

    // With the closure as it is, the call is shadowed and passes.
    let before = shadowTally();
    expect(() => applyDocEdit(tab.tab, edit)).not.toThrow();
    expect(shadowTally().strict - before.strict).toBe(1);
    // With the shadow's closure one element short, the same call fails, and says which
    // entry point and what kind of difference, and nothing of the document.
    shrinkShadowForTest(offBack);
    expect(() => applyDocEdit(tab.tab, edit)).toThrow(
      "The suites' shadow: applyDocEdit builds another batch from the closure of its edit's own elements.");
    expect(() => docEditRequests(renderTab(tab.tab), edit)).toThrow(
      "The suites' shadow: docEditRequests builds another batch from the closure of its edit's own elements.");
  });
});
