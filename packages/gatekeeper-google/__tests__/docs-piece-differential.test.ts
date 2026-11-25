// Edits built from a piece of a tab (the closure cut from the whole rendering, the stored piece,
// the whole rendering under the recorder) give the whole tab's batch or refusal: text edits,
// `tabEditRequests`, table changes and calls, edits made end to end, and other suites' calls.

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
import { DocStore } from "../src/docs-store";
import type { DocVersion } from "../src/docs-store";
import { docTabToMarkdown, isBlankDocTab, MARKDOWN_RENDERING_VERSION } from "../src/markdown-converter";
import { buildTab, diceOf, para } from "./doc-fixture";
import { readFixtures } from "./docs-live-fixtures";
import { SCENARIOS, stepEdit } from "./docs-live-recorder";
import {
  BULLETED, bullets, deleteColumn, deleteRange, deleteRow, insertColumn, insertRow, insertTable,
  insertText, mergeCells, pinRows, recordedSequenceCalls, styleText,
} from "./docs-model-draws";
import {
  APPEND, closureReading, expectSameCallFromReadings, expectSameFromPieces, expectSameFromReadings,
  fromClosure, fromReading, fromStore, fromWhole, pieceCase, pieceStore, recordedReading, renderedOf,
  REPLACE,
} from "./docs-piece-shadow";
import type { PieceCase, PieceVerdict, ReadingVerdict, Shrink } from "./docs-piece-shadow";
import {
  DEFAULT_CORPUS, DEFAULT_TABLE_CORPUS, madeTableCases, PIECE_SHAPES, pieceCorpus, pieceEdits,
  pieceTableCorpus, pieceTabs, TABLE_KINDS, tabEditCorpus, tabEdits,
} from "./docs-piece-tabs";
import type { PieceDraw, PieceShape, PieceTab, TabEditDraw, TableDraw } from "./docs-piece-tabs";
import { shadowTally, shrinkShadowForTest } from "./docs-piece-suite-shadow";
import { asFetched } from "./docs-store-slice-shadow";
import { WIDER } from "./wider-run";

/** Runs of one element each, a table alone: the harshest cut. */
const ONE: RunSizes = { least: Infinity, target: Infinity, most: Infinity, elements: 1 };

/** What a test counts of the cases it holds, by `PieceVerdict`. */
type Tally = {
  built: number; refused: number; strict: number; strictReplacements: number; strictAppends: number;
  nearBefore: number; nearAfter: number; counted: number; stopped: number;
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

/** Holds `tally` to floors, so that a corpus that stops reaching strict closures fails. */
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

/** The edit of a recorded `step`: a replacement outside tables, or an append to a tab that is not blank. */
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

/** An `updateTextStyle` that makes `[start, end)` bold. */
const bold = (start: number, end: number) => styleText(start, end, { bold: true }, "bold");

/** A tab of another corpus as the seeded edits are drawn on one: it marks no shape. */
const unmarked = (name: string, tab: GoogleDocsTab): PieceTab =>
  ({ name, tab, shapes: new Set(), marks: new Map() });

/** The two sizings every stored piece is held under. */
const SIZINGS = [["one element a run", ONE], ["the real cut", RUN_SIZES]] as const;

// The tables, each of two widths: seeded edits from the closure alone (`PURE`) and from stored
// runs (`STORED`), and edits on the seeded sequences' tabs.
const PURE = WIDER
  ? { ...DEFAULT_CORPUS, tabs: 500, edits: 24, seeds: [0, 1, 2] } : { ...DEFAULT_CORPUS, seeds: [0] };
const STORED = WIDER ? { tabs: 200, edits: 16 } : { tabs: 40, edits: 8 };
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

// The tests count as they go, and the tests that state a tally read what the tests before
// them counted: the file is run whole.
describe("the builders of a text edit on a piece of the tab", () => {
  it("every recorded step, on the tab as recorded", () => {
    let tally = noTally();
    for (let { step, tab } of STEPS) {
      let drawn = textCase(tab, step);
      if (drawn) held(tab, drawn, [ONE, RUN_SIZES], tally);
    }
    expectAtLeast(tally, { built: 110, refused: 0, strict: 85, replacements: 55, appends: 30 });
  });

  // Edits drawn on the last tab of every `every`-th seeded sequence of model batches.
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
    for (let shape of PIECE_SHAPES) {
      expect(tabs.filter(tab => tab.shapes.has(shape)).length, shape).toBeGreaterThanOrEqual(30);
    }
    // One tab in ten holds a run of 40 empty paragraphs.
    expect(tabs.filter(({ marks }) => (marks.get("empties")?.length ?? 0) >= 40)).toHaveLength(12);
  });

  it.each(PURE.seeds)("seeded tabs and edits, from the closure, seed %i", seed => {
    for (let { tab, drawn } of pieceCorpus({ ...PURE, seed: PURE.seed + seed })) heldSeeded(tab, drawn, []);
  });

  it.each(SIZINGS.map(([name, sizes], at) => [name, sizes, at] as const))(
    "seeded tabs and edits, from stored runs, %s", (_name, sizes, at) => {
      for (let { tab, drawn } of pieceCorpus({ ...STORED, seed: DEFAULT_CORPUS.seed + 100 * (1 + at) })) {
        heldSeeded(tab, drawn, [sizes]);
      }
    });

  it("holds the seeded edits on closures that are a strict part of their tab", () => {
    expectAtLeast(seeded, { built: 1_300, refused: 200, strict: 1_050, replacements: 650, appends: 85 });
    expect(seeded.strict).toBeGreaterThanOrEqual(0.8 * seeded.built);
  });

  it("every shape stands beside an edit", () => {
    // The built strict edits on a tab that holds each shape, and those drawn beside it.
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
    // Some batches name an index next to each edge of their piece: `pieceOverreach` is asked at
    // both.
    expect(all.built).toBeGreaterThanOrEqual(1_500);
    expect(all.nearBefore).toBeGreaterThanOrEqual(30);
    expect(all.nearAfter).toBeGreaterThanOrEqual(90);
    // A text edit adds length only by `insertText`: the side after is counted to every batch's end.
    expect([all.counted, all.stopped]).toEqual([all.built, 0]);
  });

  it("counts each index of a batch where it stood at least", () => {
    expect(pieceOverreach([], { first: false, last: false, inner: { from: 7, to: 7 } })).toBeUndefined();
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

  it("a batch holds no object of the piece it was built from", () => {
    // Each place a rendering's style enters a request: text put in, text replaced, a link kept.
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

// --- The one place an edit becomes requests, on a reading of the tab

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

// The wider table is held in parts, a test each, and each part holds the floor by itself.
const READINGS = WIDER ? { tabs: 120, edits: 12, parts: 4 } : { tabs: 30, edits: 8, parts: 1 };

describe("a text edit built from a reading of its tab", () => {
  it.each(Array.from({ length: READINGS.parts }, (_, part) => part))(
    "seeded tabs and edits, cells and the scan's refusals among them, part %i", part => {
      let tally = noKinds();
      let corpus = tabEditCorpus({ ...READINGS, seed: DEFAULT_CORPUS.seed + 500 });
      for (let [number, { tab, drawn }] of corpus.entries()) {
        if (number % READINGS.parts === part) heldByReading(tab.tab, drawn, [ONE, RUN_SIZES], tally);
      }
      // Strict replacements outside tables and in cells, strict appends, and the scan's
      // refusals of a text not there and of one there twice, which name no piece.
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
    // A blank tab's closure is the whole tab; a tab that ends in empty paragraphs after text
    // is not blank, though its piece at the end renders as line breaks.
    expect(tally.blankAppend).toEqual({ cases: 8, strict: 0 });
    expect(tally.append.cases).toBe(12);
    expect(tally.append.strict).toBeGreaterThanOrEqual(4);
    expect(tally.empty).toEqual({ cases: 5, strict: 0 });
  });

  it("an edit that builds no request", () => {
    // The edit that changes nothing, its closure a strict part that crosses a run's edge.
    let lines = Array.from({ length: 12 }, (_, line) => para(line === 6 ? "Hello world" : `Line ${line}`));
    let tab = asFetched(buildTab(lines));
    let edit: DocEdit = { type: "replaceText", oldMarkdown: "world", newMarkdown: "world" };
    let closed = closureReading(tab);
    expect(fromReading(closed, edit)).toEqual({ requests: [] });
    let range = closed.range()!;
    expect(range.to - range.from).toBeLessThan(tab.body.content.length);
    expect(fromReading(recordedReading(tab), edit)).toEqual({ requests: [] });
    let { store, storage, base } = pieceStore(tab, ONE);
    let reading = storedTabReading(store, base);
    expect(fromReading(reading, edit)).toEqual({ requests: [] });
    expect(reading.takeDecoded()!.size).toBeGreaterThan(1);
    let before = storage.rows();
    let made = docEditResult(store, base, edit);
    expect(made).toEqual({ requests: [], after: base });
    // Nothing is stored but the result.
    let after = storage.rows();
    expect(after.doc_result).toHaveLength(1);
    expect(after).toEqual({ ...before, doc_result: after.doc_result });
  });
});

// --- Table changes: built from a reading, and checked as a call

type TableKind = (typeof TABLE_KINDS)[number];

/** Of one kind of table change: cases, strict ones, batches built and those whose count stopped. */
type KindCount = { cases: number; strict: number; built: number; stopped: number };
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

/** The seeded tabs of the table changes, of two widths. */
const TABLE_CHANGES = WIDER ? { ...DEFAULT_TABLE_CORPUS, tabs: 60, edits: 8 } : DEFAULT_TABLE_CORPUS;

/** The seeded tabs of the table changes, each with the changes drawn on it. */
const tableCorpus = () => pieceTableCorpus(TABLE_CHANGES);

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

  it("seeded tabs and changes", () => {
    let counts = noKindCounts();
    for (let { tab, draws } of tableCorpus()) {
      for (let { change, beside } of draws) {
        if (!change) continue;
        let verdict = heldChange(tab.tab, change, [ONE, RUN_SIZES], counts);
        if (verdict.strict) for (let shape of beside) besides.set(shape, besides.get(shape)! + 1);
      }
    }
    // Strict cases of every kind, and the shapes a strict change's table stands beside.
    expectFloors(byKind(counts, "strict"), [15, 10, 5, 5, 8, 13, 3, 4, 6, 5, 3]);
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
    expectFloors(byKind(counts, "strict"), [7, 7, 2, 3, 2, 4, 1, 1, 1, 1, 1]);
    // What the tab as a whole refuses, each from a piece that does not hold what refuses it.
    for (let words of [
      "another table of the tab now reads the same", "holds items of a numbered list",
      "tables, rows and columns can be added, and cells merged, only until the tables of a tab hold",
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
    // A new table, rows, columns and a merge add length no request states and open their batch, so
    // `pieceOverreach` stops there; the other seven kinds are counted to their last request.
    let built = byKind(all, "built"), stopped = byKind(all, "stopped");
    let lengthens: readonly TableKind[] =
      ["insertTable", "insertTableRows", "insertTableColumns", "mergeTableCells"];
    expect(stopped).toEqual(TABLE_KINDS.map((kind, at) => lengthens.includes(kind) ? built[at] : 0));
    if (!WIDER) {
      expect(built).toEqual([47, 33, 13, 4, 12, 37, 9, 10, 14, 7, 1]);
      expect(stopped).toEqual([47, 33, 13, 0, 0, 0, 0, 0, 0, 7, 0]);
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
      for (let drawn of draws) heldCall(tab.tab, drawn, [ONE, RUN_SIZES]);
    }
    // Strict calls of every kind; a call to add a table asks no piece.
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
    // Two tables that read the same are refused with the tab's numbers; and the checks the
    // calls share with the builders are refused the same.
    for (let words of [
      "reads the same as table", "holds items of a numbered list",
      "tables, rows and columns can be added, and cells merged, only until the tables of a tab hold",
    ]) {
      expect(refused(words), words).toBeGreaterThan(0);
    }
  });
});

// --- End to end: an edit made in a stored version, against the edit made in the tab in hand

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
    // The built requests are deep-frozen before the model runs: a write through one throws.
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

  it("seeded tabs and edits, and a queue of three folded", () => {
    let built = 0, refused = 0, folded = 0;
    for (let [number, tab] of pieceTabs(DEFAULT_CORPUS.seed + 700, END_TO_END.tabs).entries()) {
      let draws = tabEdits(tab, DEFAULT_CORPUS.seed + 700 + 7919 * (number + 1), END_TO_END.edits);
      for (let { edit } of draws) {
        if (heldEndToEnd(tab.tab, edit, [number % 2 === 0 ? ONE : RUN_SIZES])) built++;
        else refused++;
      }
      // The first three edits folded over the stored tab and made in hand one by one: the
      // same edits refused, and the same tab at the end.
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
    expect(built).toBeGreaterThanOrEqual(85);
    expect(refused).toBeGreaterThanOrEqual(40);
  });

  it("no slice the model was handed left the runs of the piece its batch was built from", () => {
    // Counted by the two tests above.
    expect(stored).toBeGreaterThanOrEqual(WIDER ? 800 : 320);
    expect(left).toBe(0);
  });
});

// --- The suites' own calls, shadowed

describe("the suites' own calls", () => {
  afterEach(() => shrinkShadowForTest(undefined));

  /** The recorded text steps, each with the edit it queues. */
  const TEXT_STEPS = STEPS.flatMap(({ step, tab }) => {
    let drawn = stepDraw(tab, step);
    return drawn && drawn.kind !== "absent" && drawn.kind !== "twice" ? [{ tab, edit: drawn.edit }] : [];
  });

  it("are shadowed: each builds again from the closure of its edit", () => {
    let before = shadowTally();
    // Five recorded steps made in hand and three built from a rendering, from the middle of
    // the recordings, where tabs are longer than a closure.
    let from = Math.floor(TEXT_STEPS.length / 2);
    for (let { tab, edit } of TEXT_STEPS.slice(from, from + 5)) applyDocEdit(tab, edit);
    for (let { tab, edit } of TEXT_STEPS.slice(from + 5, from + 8)) docEditRequests(renderTab(tab), edit);
    let after = shadowTally();
    expect(after.shadowed - before.shadowed).toBe(8);
    expect(after.skipped - before.skipped).toBe(0);
    expect(after.large - before.large).toBe(0);
    expect((after.strict - before.strict) + (after.whole - before.whole)).toBe(8);
    expect(after.strict - before.strict).toBeGreaterThanOrEqual(1);

    // A table change is built again from the piece around its table: rows added to the
    // second table of a made tab, which stands between paragraphs.
    let made = madeTableCases().find(({ tab }) => tab.name === "a table that opens the body")!;
    let change = made.draws[4].change!;
    expect(change.type).toBe("insertTableRows");
    before = shadowTally();
    applyDocEdit(made.tab.tab, change);
    tableChangeRequests(renderTab(made.tab.tab), change);
    after = shadowTally();
    expect([after.shadowed - before.shadowed, after.strict - before.strict]).toEqual([2, 2]);
  });

  it("fail the calling test where the closure builds another batch", () => {
    // The first edit for which one element off the closure's back builds another, in-piece batch.
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
    // With the shadow's closure one element short, it fails, naming the entry point and the
    // kind of difference and nothing of the document.
    shrinkShadowForTest(offBack);
    expect(() => applyDocEdit(tab.tab, edit)).toThrow(
      "The suites' shadow: applyDocEdit builds another batch from the closure of its edit's own elements.");
    expect(() => docEditRequests(renderTab(tab.tab), edit)).toThrow(
      "The suites' shadow: docEditRequests builds another batch from the closure of its edit's own elements.");
  });
});
