// A piece of a stored tab: the closure of an edit's own elements found run by run, held to
// the closure cut from the whole tab's rendering under several cuts of the tab into runs, with
// what it decodes, what it keeps and what it throws. A file of its own, because it wraps two
// modules for every test of its file. Node only: the storage is the fake, the collector Node's.

import { getHeapSpaceStatistics } from "node:v8";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GoogleDocsTab, StructuralElement } from "../src/docs-api";
import { DOC_COPY_UNREADABLE } from "../src/docs-replica";
import { RUN_SIZES } from "../src/docs-runs";
import type { RunSizes } from "../src/docs-runs";
import { DocPieceError, DocRunRenderError, DocStore, docStoreCost } from "../src/docs-store";
import type { DocVersion, PieceAt } from "../src/docs-store";
import type { MarkdownRange, OwnRange } from "../src/markdown-converter";
import { buildTab, diceOf, grid, item, para, presetLevels } from "./doc-fixture";
import type { BlockSpec, Dice, Lists } from "./doc-fixture";
import type { FakeDocStorage } from "./doc-store-fake";
import { under } from "./doc-store-scenarios";
import {
  closureIn, expectPieceOfWhole, ownIn, pieceAtFor, pieceStore, silentRunTabs, wholeOf,
} from "./docs-piece-shadow";
import type { Whole } from "./docs-piece-shadow";
import { asFetched, runSizes } from "./docs-store-slice-shadow";
import { collect, HEAP_MEASURED, inUse, observing } from "./heap-held";
import { fuzzedTabs, recordedTabs } from "./render-run-tabs";
import { WIDER } from "./wider-run";

/** What the two wrapped modules do beside what they are: nothing, unless a test asks. */
const wrapped = vi.hoisted(() => ({
  /** Whether the store's renderer throws on a run that holds the text `FAULT`. */
  fault: false,
  /** How many elements later than it is the store's scout is told its closure starts. */
  late: 0,
  /** Called with each run the store decodes, as it is decoded. */
  decoded: undefined as ((elements: StructuralElement[]) => void) | undefined,
}));

// The module as it is but for `renderRun` and `closureStart` as other modules import them:
// `closureOf` calls the module's own `closureStart`, so only the store's scout is told late.
vi.mock("../src/markdown-converter", async importOriginal => {
  let converter = await importOriginal<typeof import("../src/markdown-converter")>();
  let renderRun: typeof converter.renderRun = (elements, ...rest) => {
    if (wrapped.fault && JSON.stringify(elements).includes("FAULT")) throw new Error("renderer fault");
    return converter.renderRun(elements, ...rest);
  };
  let closureStart: typeof converter.closureStart = (...asked) => {
    let start = converter.closureStart(...asked);
    return start === undefined ? undefined : start + wrapped.late;
  };
  return { ...converter, renderRun, closureStart };
});

vi.mock("../src/docs-runs", async importOriginal => {
  let runs = await importOriginal<typeof import("../src/docs-runs")>();
  let decodeRun: typeof runs.decodeRun = (...asked) => {
    let decoded = runs.decodeRun(...asked);
    if (decoded) wrapped.decoded?.(decoded.elements);
    return decoded;
  };
  return { ...runs, decodeRun };
});

beforeEach(() => {
  wrapped.fault = false;
  wrapped.late = 0;
  wrapped.decoded = undefined;
});

const DOC = "doc";
/** Runs of exactly `elements` elements, a table alone: no run ends by its content. */
const runsOf = (elements: number): RunSizes =>
  ({ least: Infinity, target: Infinity, most: Infinity, elements });
const ONE = runsOf(1);
const SIZINGS: readonly (readonly [string, RunSizes])[] = [
  ["one element a run", ONE], ["two elements a run", runsOf(2)],
  ["three elements a run", runsOf(3)], ["the real cut", RUN_SIZES],
];
const EMPTY: BlockSpec = { runs: ["\n"] };
const LISTS: Lists = { L1: { listProperties: { nestingLevels: presetLevels() } } };
const times = <T>(count: number, make: (at: number) => T): T[] =>
  Array.from({ length: count }, (_, at) => make(at));

/** A tab kept in a store of its own under `sizes`, with its whole rendering. */
type Kept = { storage: FakeDocStorage; store: DocStore; base: DocVersion; whole: Whole };

function keptWhole(tab: GoogleDocsTab, sizes: RunSizes): Kept {
  let fetched = asFetched(tab);
  return { ...pieceStore(fetched, sizes), whole: wholeOf(fetched) };
}

/** What a call moved of the store's counters. */
function cost<T>(run: () => T): { answer: T; decoded: number; rendered: number; widenings: number } {
  let before = { ...docStoreCost };
  let answer = run();
  return {
    answer, decoded: docStoreCost.runsDecoded - before.runsDecoded,
    rendered: docStoreCost.runsRendered - before.runsRendered,
    widenings: docStoreCost.pieceWidenings - before.pieceWidenings,
  };
}

/** The piece of `own` in a kept tab, held to the whole tab's, with what it cost. */
function pieceOf({ storage, store, base, whole }: Kept, own: OwnRange) {
  let at = pieceAtFor(storage, base, own);
  let spent = cost(() => store.piece(base, at));
  expectPieceOfWhole(spent.answer, whole, own);
  return { ...spent, piece: spent.answer, at };
}

/** The Markdown of element `element` of `whole`: from its start to the next element's. */
const markdownOf = (whole: Whole, element: number): MarkdownRange =>
  ({ mdStart: whole.starts[element], mdEnd: whole.starts[element + 1] ?? whole.markdown.length });

/** A range inside the text `text` of `whole`'s Markdown, which holds it once. */
function inside(whole: Whole, text: string): { markdown: MarkdownRange } {
  let at = whole.markdown.indexOf(text);
  if (at < 0 || whole.markdown.indexOf(text, at + 1) >= 0) throw new Error(`"${text}" is not there once`);
  return { markdown: { mdStart: at + 1, mdEnd: at + Math.max(2, text.length - 1) } };
}

/** Own ranges of `whole` drawn by `dice`: inside one element, across three, each table, the end. */
function drawnOwn(whole: Whole, dice: Dice, draws: number): OwnRange[] {
  let writes = whole.starts.flatMap((_, element) => {
    let { mdStart, mdEnd } = markdownOf(whole, element);
    return mdEnd > mdStart ? [element] : [];
  });
  let own: OwnRange[] = ["end"];
  for (let table = 0; table < whole.joined().sourceMap.tables.length; table++) own.push({ table });
  for (let draw = 0; draw < draws && writes.length > 0; draw++) {
    let one = markdownOf(whole, dice.pick(writes));
    let mdStart = one.mdStart + dice.below(one.mdEnd - one.mdStart);
    own.push({ markdown: { mdStart, mdEnd: mdStart + 1 + dice.below(one.mdEnd - mdStart) } });
    let first = dice.below(writes.length);
    let from = markdownOf(whole, writes[first]);
    let to = markdownOf(whole, writes[Math.min(writes.length - 1, first + 2)]);
    own.push({ markdown: {
      mdStart: from.mdStart + dice.below(from.mdEnd - from.mdStart),
      mdEnd: to.mdStart + 1 + dice.below(to.mdEnd - to.mdStart),
    } });
  }
  return own;
}

/**
 * `Lead`, `empties` empty paragraphs and `Tail`, with two paragraphs and one more on each
 * side, after `pad` paragraphs that move every element that many places later.
 */
const breaksTab = (empties: number, pad = 0): GoogleDocsTab => buildTab([
  ...times(pad, at => para(`Pad ${at}`)), para("X"), para("A"), para("B"), para("Lead"),
  ...times(empties, () => EMPTY), para("Tail"), para("C"), para("D"), para("Y"),
]);

/**
 * A paragraph, an item at level 0, `deeper` items at levels 1 to 3 and the paragraph after
 * them, with one paragraph more before and three after, after `pad` paragraphs.
 */
const walkTab = (deeper: number, pad = 0): GoogleDocsTab => buildTab([
  ...times(pad, at => para(`Pad ${at}`)), para("X"), para("Before"), item("top", "L1", 0),
  ...times(deeper, at => item(`deep ${at}`, "L1", 1 + at % 3)), para("After"),
  para("C"), para("D"), para("Y"),
], LISTS);

/**
 * What a piece costs, by the store's rule, with `O` the runs of the own elements, `B` the
 * runs of the closure before the run at `place` and `A` those after the own.
 */
function pieceCost(place: number, B: number, O: number, A: number) {
  // The first attempt, from the run named: it adds runs after only where it is closed before.
  if (B === 0) return { decoded: O + A, widenings: A };
  // The second, from one run earlier.
  if (B === 1) return { decoded: O + (1 + O + A), widenings: 1 + A };
  // The scouts: 2, 4, 8, ... runs back, capped at the place, each with the run named, until
  // one reaches the run the closure starts in.
  let scouted = 0, scouts = 0;
  for (let back = 2; ; back *= 2) {
    let reach = Math.min(back, place);
    scouted += reach + 1;
    scouts++;
    if (reach >= B) break;
  }
  // The last attempt, from exactly that run.
  return {
    decoded: O + (1 + O) + scouted + (B + O + A),
    widenings: 1 + scouts + 1 + A,
  };
}

/** The places of the runs that hold elements `[from, to)` under runs of `elements` each. */
const runsHolding = (from: number, to: number, elements: number): [number, number] =>
  [Math.floor(from / elements), Math.floor((to - 1) / elements)];

/** Nine paragraphs, `Line 0` to `Line 8`, kept under `sizes`. */
const lines = (sizes: RunSizes, text: (at: number) => string = at => `Line ${at}`) =>
  keptWhole(buildTab(times(9, at => para(text(at)))), sizes);

describe("a piece of a stored tab", () => {
  describe.each(SIZINGS)("under %s", (_name, sizes) => {
    it("is the closure of the whole tab's rendering", () => {
      let dice = diceOf(7);
      let pieces = 0;
      // Every recorded tab, and drawn ones that hold what the recordings hold little of:
      // images, items off their preset, protected paragraphs, tables beside tables.
      for (let { tab } of [...recordedTabs(), ...fuzzedTabs(53, WIDER ? 60 : 20)]) {
        let kept = keptWhole(tab, sizes);
        for (let own of drawnOwn(kept.whole, dice, WIDER ? 6 : 1)) {
          pieceOf(kept, own);
          pieces++;
        }
      }
      expect(pieces).toBeGreaterThan(500);
    });

    it("is closed by runs: each step and the walk run out at a run's edge, short of it and past it", () => {
      let elements = sizes.elements;
      let crossed = 0, within = 0;
      for (let pad = 0; pad <= 3; pad++) {
        let tabs: [GoogleDocsTab, string[]][] = [
          ...[0, 2, 20].map((empties): [GoogleDocsTab, string[]] =>
            [breaksTab(empties, pad), ["Tail", "Lead"]]),
          ...[1, 20].map((deeper): [GoogleDocsTab, string[]] => [walkTab(deeper, pad), ["After"]]),
        ];
        for (let [tab, texts] of tabs) {
          let kept = keptWhole(tab, sizes);
          // The cut is the one the places below are counted in.
          if (Number.isFinite(elements)) {
            expect(runSizes(kept.storage, kept.base).length)
              .toBe(Math.ceil(kept.whole.flags.length / elements));
          }
          for (let text of texts) {
            let own = inside(kept.whole, text);
            let { widenings } = pieceOf(kept, own);
            let { first, last } = ownIn(kept.whole, own);
            let { from, to } = closureIn(kept.whole, own);
            let crosses = Number.isFinite(elements) &&
              `${runsHolding(from, to, elements)}` !== `${runsHolding(first, last + 1, elements)}`;
            if (crosses) {
              expect(widenings).toBeGreaterThan(0);
              crossed++;
            } else {
              expect(widenings).toBe(0);
              within++;
            }
          }
        }
      }
      // Every finite cut crosses a run's edge; only the real cut holds each tab in one run.
      expect(Number.isFinite(elements) ? crossed : within).toBeGreaterThan(0);
    });
  });

  describe("across many runs, one element a run", () => {
    // `B` and `A` are the runs of the closure before the own run and after it; the own
    // element is one run.
    const MANY = [
      { name: "200 empty paragraphs, back from Tail", tab: () => breaksTab(200), text: "Tail", B: 202, A: 2 },
      { name: "200 empty paragraphs, forward from Lead", tab: () => breaksTab(200), text: "Lead", B: 2, A: 202 },
      { name: "200 deeper items, back from After", tab: () => walkTab(200), text: "After", B: 201, A: 2 },
    ];

    it.each(MANY)("$name: the piece, and what it costs", ({ tab, text, B, A }) => {
      let kept = keptWhole(tab(), ONE);
      let own = inside(kept.whole, text);
      docStoreCost.peakMarkdownCharsInHand = 0;
      let { piece, at, decoded, rendered, widenings } = pieceOf(kept, own);
      // The most Markdown in hand is the last attempt's joined runs, which are the closure's:
      // an earlier attempt joins fewer, and a scout holds one run's at a time.
      expect(docStoreCost.peakMarkdownCharsInHand).toBe(piece.rendering.markdown.length);
      let { from, to } = closureIn(kept.whole, own);
      expect([at.place - from, to - 1 - at.place]).toEqual([B, A]);
      let expected = pieceCost(at.place, B, 1, A);
      expect({ decoded, rendered, widenings })
        .toEqual({ decoded: expected.decoded, rendered: expected.decoded, widenings: expected.widenings });
      expect([piece.from, piece.to]).toEqual([from, to]);
      // The run before the own run and the own run: no run after it, and none earlier.
      expect([...piece.decoded.keys()]).toEqual([at.place - 1, at.place]);
    });

    it("keeps decoded the run before the own runs and the own runs, and no run after", () => {
      // An own range of three runs, with the closure reaching a run after them.
      let kept = keptWhole(breaksTab(200), ONE);
      let { markdown } = kept.whole;
      let own: OwnRange =
        { markdown: { mdStart: markdown.indexOf("Tail") + 1, mdEnd: markdown.indexOf("D\n") + 1 } };
      let { piece, at, decoded, widenings } = pieceOf(kept, own);
      expect(piece.to - 1).toBeGreaterThan(at.place + 2);
      // The two runs added for the own range are no widening: the one after them is.
      expect({ decoded, widenings }).toEqual(pieceCost(at.place, 202, 3, 1));
      expect([...piece.decoded.keys()]).toEqual([at.place - 1, at.place, at.place + 1, at.place + 2]);

      // The own run is the tab's first: there is no run before it.
      let inOneRun = keptWhole(breaksTab(200), RUN_SIZES);
      let first = pieceOf(inOneRun, inside(inOneRun.whole, "Tail"));
      expect([first.at.place, [...first.piece.decoded.keys()]]).toEqual([0, [0]]);

      // A piece that starts in the own run keeps no run before it: the own element is the
      // third of its run, and the closure goes on into the next.
      let inThrees = lines(runsOf(3));
      let third = pieceOf(inThrees, inside(inThrees.whole, "Line 4"));
      expect([third.at.place, third.piece.from, third.piece.to]).toEqual([1, 1, 3]);
      expect([...third.piece.decoded.keys()]).toEqual([1]);
      expect([third.decoded, third.widenings]).toEqual([2, 1]);
    });

    /** A piece, and a weak reference to the first element of each run decoded for it, in order. */
    function watched({ store, base }: Kept, at: PieceAt) {
      let refs: WeakRef<StructuralElement>[] = [];
      wrapped.decoded = elements => {
        refs.push(new WeakRef(elements[0]));
      };
      let piece = store.piece(base, at);
      wrapped.decoded = undefined;
      return { piece, refs };
    }

    /** Whether each reference's target is still held, after a collection in a later job. */
    async function alive(refs: readonly WeakRef<object>[]): Promise<boolean[]> {
      // A weak reference keeps its target to the end of the job that made it.
      await new Promise(resolve => setImmediate(resolve));
      collect();
      return refs.map(ref => ref.deref() !== undefined);
    }

    it.each(MANY.filter(({ B }) => B > 2))(
      "$name: a run of the closure outside the own runs and the one before is let go", HEAP_MEASURED,
      async ({ tab, text, B, A }) => {
        let kept = keptWhole(tab(), ONE);
        let named = pieceAtFor(kept.storage, kept.base, inside(kept.whole, text));
        let { piece, refs } = watched(kept, named);
        // The last attempt decoded the closure's runs in order: `B` before the own run.
        let last = refs.slice(-(B + 1 + A));
        let [first, twoBefore, before, own, after] =
          await alive([refs[0], last[B - 2], last[B - 1], last[B], last[B + 1]]);
        expect({ twoBefore, before, own, after })
          .toEqual({ twoBefore: false, before: true, own: true, after: false });
        // One attempt in hand: the run the first attempt decoded is gone with it.
        expect(first).toBe(false);
        expect(piece.decoded.get(named.place)?.elements[0]).toBe(last[B].deref());
      });

    /** What is in use more once `make` has answered than before it, with its answer held. */
    function heldBy<T>(make: () => T): { held: T; bytes: number } {
      let before = Math.min(inUse(), inUse());
      let held = make();
      return { held, bytes: Math.min(inUse(), inUse()) - before };
    }

    it.each(MANY)("$name: what the piece holds", HEAP_MEASURED, async ({ tab, text }) => {
      let kept = keptWhole(tab(), ONE);
      let at = pieceAtFor(kept.storage, kept.base, inside(kept.whole, text));
      // In a job of its own, and made and measured once before the measure that counts:
      // what the tests before left to collect, and what the first call compiles, are not
      // the piece's, and either can move a reading by more than the piece.
      await new Promise(resolve => setImmediate(resolve));
      heldBy(() => kept.store.piece(kept.base, at));
      let { held: piece, bytes } = heldBy(() => kept.store.piece(kept.base, at));
      // THE MEASURE: the piece's Markdown at two bytes a character and its source map as
      // JSON, a byte a character. Under one element a run the closure's runs are the piece.
      // Measured: 1.9 to 2.1 times it, of which the rendering is all but a kilobyte (a copy
      // of it made from JSON is 0.85 times the measure, and each block's segments are an
      // array grown by push, which holds room for seventeen). The two runs kept decoded are
      // that kilobyte; with every run of the closure kept decoded the pieces of the empty
      // paragraphs are over four times the measure. The bound is the measure half as much
      // again.
      let measure = 2 * piece.rendering.markdown.length + JSON.stringify(piece.rendering.sourceMap).length;
      expect(measure).toBeGreaterThan(25_000);
      expect(bytes).toBeGreaterThan(0.8 * measure);
      expect(bytes).toBeLessThan(3 * measure);
    });

    it("a scout holds a byte an element of the runs it scouts", HEAP_MEASURED, async () => {
      await new Promise(resolve => setImmediate(resolve));
      let kept = keptWhole(breaksTab(4_200), ONE);
      let at = pieceAtFor(kept.storage, kept.base, inside(kept.whole, "Tail"));
      // The last scout starts at the tab's first run and renders every run to the one named.
      let runs = at.place + 1;
      expect(runs).toBe(4_206);
      // The runs decoded before it: the two attempts and the scouts of 2, 4, ..., 4,096 back.
      let earlier = pieceCost(at.place, 4_202, 1, 2).decoded - (4_202 + 1 + 2) - runs;
      // What is in use after full collections: the objects of the heap, which is all of it
      // but the engine's own code (compiled or not, it comes and goes by kilobytes as a call
      // runs, either way), and the buffers outside the heap.
      let taken = () => {
        inUse();
        inUse();
        let objects = 0;
        for (let { space_name, space_used_size } of getHeapSpaceStatistics()) {
          if (!/code|trusted/.test(space_name)) objects += space_used_size;
        }
        return { objects, buffers: process.memoryUsage().arrayBuffers };
      };
      // POINTS OF ONE SCOUT, as it decodes its run of that number: each with the run in the
      // frame and a full page of the list in hand, so that what differs between two is what
      // the scout keeps of the runs between.
      const POINTS = times(8, point => 106 + point * 500);
      /** What is in use at each point of a piece's last scout, more than before the piece. */
      let scouting = (points: readonly number[]) => {
        let calls = 0;
        let read: ReturnType<typeof taken>[] = [];
        let before = taken();
        wrapped.decoded = () => {
          if (points.includes(++calls - earlier)) read.push(taken());
        };
        kept.store.piece(kept.base, at);
        wrapped.decoded = undefined;
        expect(read.length).toBe(points.length);
        return read.map(({ objects, buffers }) =>
          ({ objects: objects - before.objects, buffers: buffers - before.buffers }));
      };
      // One piece is made before any is measured: what the first call compiles is not the
      // scout's.
      scouting([]);
      let read = scouting(POINTS);
      // OUTSIDE THE HEAP, what the scout keeps: four bytes a run for where its elements end,
      // made for all its runs before the first, and a byte an element of the runs before the
      // one in the frame, in an array that doubles: under two.
      for (let [point, run] of POINTS.entries()) {
        expect(read[point].buffers, `run ${run}`).toBeGreaterThanOrEqual(4 * runs + run - 1);
        expect(read[point].buffers, `run ${run}`).toBeLessThan(4 * runs + 2 * run);
      }
      // ON THE HEAP the scout keeps no object for a run: between its first point and its
      // last, 3,500 runs apart. Measured: 0.2 to 1 byte a run. By mutation: a number kept
      // for each run in an array measures 10.6, an empty object 67.
      let first = read[0], last = read[POINTS.length - 1];
      let slope = (last.objects - first.objects) / (POINTS[POINTS.length - 1] - POINTS[0]);
      expect(slope).toBeLessThan(4);
    });

    it("counts the Markdown of each run a scout renders", () => {
      // The second step back from "Own" passes the empty paragraph, so its closure starts
      // three runs before it: the scout of two runs is short of it, and the scout of four
      // renders a run the closure does not hold, whose Markdown is more than the piece's.
      let long = times(1_000, () => "Long").join(" ");
      let kept = keptWhole(buildTab([
        para(long), para("X"), EMPTY, para("A"), para("Own"), para("C"), para("D"), para("Y"),
      ]), ONE);
      docStoreCost.peakMarkdownCharsInHand = 0;
      let { piece, at, decoded, widenings } = pieceOf(kept, inside(kept.whole, "Own"));
      expect({ decoded, widenings }).toEqual(pieceCost(at.place, 3, 1, 2));
      expect(piece.from).toBe(at.place - 3);
      let scouted = markdownOf(kept.whole, at.place - 4);
      expect(kept.whole.markdown.slice(scouted.mdStart, scouted.mdEnd)).toContain(long);
      expect(scouted.mdEnd - scouted.mdStart).toBeGreaterThan(piece.rendering.markdown.length);
      expect(docStoreCost.peakMarkdownCharsInHand).toBe(scouted.mdEnd - scouted.mdStart);
    });
  });

  /** What `run` throws. */
  function thrownBy(run: () => unknown): unknown {
    try {
      run();
    } catch (error) {
      return error;
    }
    throw new Error("Nothing was thrown.");
  }

  it("stands at the tab's two ends", () => {
    // The first element that writes, in the tab's first run: nothing is before it to take.
    let kept = lines(runsOf(3));
    let first = pieceOf(kept, inside(kept.whole, "Line 0"));
    expect([first.at.place, first.piece.at.first, first.piece.from]).toEqual([0, true, 0]);
    expect([first.decoded, first.widenings]).toEqual([2, 1]);
    // The tab's last element: no run is added after the last, and the two before it are
    // found by one attempt more.
    let last = pieceOf(kept, "end");
    expect([last.at.place, last.piece.at.last, last.piece.to]).toEqual([3, true, 4]);
    expect([last.decoded, last.widenings]).toEqual([1 + 2, 1]);
  });

  it("keys a version keyed under another digest first, and writes what a read writes", () => {
    let fetched = asFetched(buildTab(times(9, at => para(`Line ${at}`))));
    let whole = wholeOf(fetched);
    let { storage, base } = pieceStore(fetched, ONE);
    let own = inside(whole, "Line 4");
    // The rows the first digest made say where the piece stands; the second has none.
    let at = pieceAtFor(storage, base, own);
    let other = under(storage, "another digest", ONE);
    expect(() => pieceAtFor(storage, base, own, "another digest")).toThrow("lists no run");

    // Inside a transaction that is undone, the keying is undone with it: the piece is the
    // whole's, and nothing depended on its rows being kept.
    expect(thrownBy(() => other.transaction(() => {
      expectPieceOfWhole(other.piece(base, at), whole, own);
      throw new Error("undone");
    }))).toEqual(new Error("undone"));
    expect(() => pieceAtFor(storage, base, own, "another digest")).toThrow("lists no run");

    let { answer, rendered } = cost(() => other.piece(base, at));
    expectPieceOfWhole(answer, whole, own);
    // Every run keyed again, and then the piece's.
    expect(rendered).toBeGreaterThan(whole.flags.length);
    expect(pieceAtFor(storage, base, own, "another digest")).toEqual(at);

    // Keyed under the store's digest with every rendering stored, a piece writes nothing.
    let statements: string[] = [];
    let quiet = new DocStore(
      observing(storage, query => void statements.push(query)), undefined, "another digest", ONE);
    statements.length = 0;
    let written = docStoreCost.rowsWritten;
    expectPieceOfWhole(quiet.piece(base, at), whole, own);
    expect(statements.length).toBeGreaterThan(0);
    expect(statements.filter(query => !/^\s*SELECT\b/.test(query))).toEqual([]);
    expect(docStoreCost.rowsWritten).toBe(written);
  });

  it("marks what the renderer throws, from an attempt and from a scout", () => {
    // In the own run: the first attempt renders it.
    let own = lines(ONE, line => line === 4 ? "FAULT here" : `Line ${line}`);
    let at = pieceAtFor(own.storage, own.base, inside(own.whole, "FAULT here"));
    wrapped.fault = true;
    let attempt = cost(() => thrownBy(() => own.store.piece(own.base, at)));
    expect(attempt.answer).toBeInstanceOf(DocRunRenderError);
    expect([attempt.decoded, attempt.widenings]).toEqual([1, 0]);

    // Two runs before the own run: the two attempts do not reach it, and the scout's first
    // run is it.
    wrapped.fault = false;
    let before = lines(ONE, line => line === 2 ? "FAULT" : `Line ${line}`);
    let later = pieceAtFor(before.storage, before.base, inside(before.whole, "Line 4"));
    wrapped.fault = true;
    let scout = cost(() => thrownBy(() => before.store.piece(before.base, later)));
    expect(scout.answer).toBeInstanceOf(DocRunRenderError);
    expect([scout.decoded, scout.widenings]).toEqual([1 + 2 + 1, 2]);
    expect(before.store.head(DOC)).toBeDefined();
  });

  it("names its inner indexes: the end of its first element and the start of its last", () => {
    // One element: a body of one paragraph. Its end is past its start, so `from` is past `to`.
    let alone = buildTab([para("Only")]);
    alone.body.content.shift();
    let one = keptWhole(alone, ONE);
    expect(pieceOf(one, "end").piece.at).toMatchObject({ first: true, last: true, inner: { from: 6, to: 1 } });
    // Two: the section break that opens the body, and the paragraph.
    let two = keptWhole(buildTab([para("Only")]), ONE);
    expect(pieceOf(two, "end").piece.at).toMatchObject({ first: true, last: true, inner: { from: 1, to: 1 } });
    // Many: "Line 2" to "Line 6", each seven indexes after the section break's one.
    let many = lines(ONE);
    expect(pieceOf(many, inside(many.whole, "Line 4")).piece.at)
      .toMatchObject({ first: false, last: false, inner: { from: 1 + 3 * 7, to: 1 + 6 * 7 } });
  });

  it("says a row that is gone as the store does, from an attempt and from a scout", () => {
    let gone = (kept: Kept, place: number) => kept.storage.sql.exec(
      "DELETE FROM doc_run WHERE id = (SELECT run FROM doc_seq WHERE version = ? AND seq = ?)",
      kept.base.id, place).toArray();
    for (let [back, decoded] of [[0, 0], [2, 1 + 2]]) {
      let kept = lines(ONE);
      let at = pieceAtFor(kept.storage, kept.base, inside(kept.whole, "Line 4"));
      gone(kept, at.place - back);
      let spent = cost(() => thrownBy(() => kept.store.piece(kept.base, at)));
      expect(spent.answer).toEqual(new Error(DOC_COPY_UNREADABLE));
      expect(spent.decoded).toBe(decoded);
      expect(kept.store.head(DOC)).toBeUndefined();
    }
  });

  it("holds no offset in a run that writes nothing", () => {
    for (let { name, tab, ranges } of silentRunTabs()) {
      let { storage, store, base } = pieceStore(tab, ONE);
      let whole = wholeOf(tab);
      for (let own of [...ranges.map((markdown): OwnRange => ({ markdown })), "end" as const]) {
        let at = pieceAtFor(storage, base, own);
        // The run named is the own element's, one element a run, which is not one that
        // writes nothing; where no run writes it is the last.
        let { first } = ownIn(whole, own);
        expect(at.place, name).toBe(whole.markdown === "" ? whole.flags.length - 1 : first);
        if (whole.markdown !== "") expect(whole.flags[first] & 3, name).not.toBe(0);
        let piece = store.piece(base, at);
        expectPieceOfWhole(piece, whole, own);
        if (whole.markdown === "") {
          expect([piece.from, piece.to, piece.at.first, piece.at.last], name)
            .toEqual([0, whole.flags.length, true, true]);
        }
      }
    }
  });

  it("refuses a place that does not hold the own elements", () => {
    expect(new DocPieceError("x").name).toBe("DocPieceError");
    let kept = lines(ONE);
    let own = inside(kept.whole, "Line 4");
    let at = pieceAtFor(kept.storage, kept.base, own);
    let nothing = new DocPieceError("A piece was asked for elements its version's runs do not hold.");
    /** Holds that `wrong` names nothing of `of`, said with `decoded` runs decoded. */
    let refused = (of: Kept, wrong: PieceAt, decoded: number) => {
      let spent = cost(() => thrownBy(() => of.store.piece(of.base, wrong)));
      expect(spent.answer).toEqual(nothing);
      expect(spent.answer).toBeInstanceOf(DocPieceError);
      expect(spent.decoded).toBe(decoded);
    };
    // Said before a run is decoded: a place past the own elements, as that run stands; one
    // past the list, before it, or no whole number; a place whose offset or tables are not
    // what the runs before it write; the last element at a run that is not the last.
    let after = pieceAtFor(kept.storage, kept.base, inside(kept.whole, "Line 6"));
    for (let wrong of [
      { ...after, own }, { ...at, place: 99 }, { ...at, place: at.place + 1 },
      { ...at, place: -1 }, { ...at, place: at.place - 0.5 }, { ...at, place: NaN },
      { ...at, mdStart: at.mdStart - 1 }, { ...at, tablesBefore: 1 },
      { ...at, own: "end" as const },
    ]) {
      refused(kept, wrong, 0);
    }
    // What is no number names nothing, said as early: `NaN`, and what a read past an
    // array's end hands a caller, at either end of the own range and for a table's number.
    for (let none of [NaN, kept.whole.starts[kept.whole.starts.length]]) {
      refused(kept, { ...at, own: { markdown: { ...own.markdown, mdStart: none } } }, 0);
      refused(kept, { ...at, own: { markdown: { ...own.markdown, mdEnd: none } } }, 0);
      refused(kept, { ...at, own: { table: none } }, 0);
    }
    // A table is in the run named or nowhere, said once that run is rendered.
    refused(kept, { ...at, own: { table: 0 } }, 1);
    expect(kept.store.head(DOC)).toBeDefined();

    // So a table named at a run before the one that holds it names nothing, though the
    // offset and the tables before are that run's: whether the closure of that run starts
    // in it (the tab's first run), one run before it, or further back.
    let tabled = keptWhole(buildTab([
      ...times(4, line => para(`Line ${line}`)), grid(["a", "b"]), para("After"),
    ]), ONE);
    let table: OwnRange = { table: 0 };
    let held = pieceOf(tabled, table).at;
    expect(held).toEqual({ place: 5, mdStart: tabled.whole.starts[5], tablesBefore: 0, own: table });
    for (let place of [0, 1, 3, held.place - 1]) {
      refused(tabled, { ...held, place, mdStart: tabled.whole.starts[place] }, 1);
    }
    expect(tabled.store.head(DOC)).toBeDefined();
  });

  it("refuses a closure that starts before the run it was found to start in", () => {
    let kept = lines(ONE);
    let at = pieceAtFor(kept.storage, kept.base, inside(kept.whole, "Line 6"));
    // The scout is told the closure starts one element, which is one run, later than it does.
    wrapped.late = 1;
    let thrown = thrownBy(() => kept.store.piece(kept.base, at));
    expect(thrown).toBeInstanceOf(DocPieceError);
    expect(thrown).toEqual(
      new DocPieceError("A piece's closure starts before the run it was found to start in."));
    expect(kept.store.head(DOC)).toBeDefined();
    wrapped.late = 0;
    expectPieceOfWhole(kept.store.piece(kept.base, at), kept.whole, at.own);
  });
});
