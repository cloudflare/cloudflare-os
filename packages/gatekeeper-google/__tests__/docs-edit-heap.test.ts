// What an edit of a stored Google Doc holds on the shapes that hurt: a tab of 19,601 runs
// (one-cell tables, each a run, with a run between each two) and a tab of 20,000 paragraphs.
// An edit holds nothing for every run and, while the model runs, nothing of its piece's
// rendering; a widening holds one slice at a time. The carry's numbers an edit touches are
// pinned by a count, with the renderer's `initialCarry` replaced for every test of this file.

import { afterEach, describe, expect, it, vi } from "vitest";
import { googleDocDisplayLimit } from "../src/doc-actions";
import type { GoogleDocsRequest, GoogleDocsTab } from "../src/docs-api";
import { SliceEdgeError, applyDocsRequestsToSlice, batchReach } from "../src/docs-model";
import { storedTabReading, type StoredTabReading } from "../src/docs-reading";
import { docEditResult, editedSlice, type DocEdit } from "../src/docs-replay";
import type { RunSizes } from "../src/docs-runs";
import { DocStore, docStoreCost, type DocSlice, type DocVersion } from "../src/docs-store";
import { prepareTableChange, prepareTextReplacement, type TableCall } from "../src/docs-table-actions";
import type { OwnRange } from "../src/markdown-converter";
import { counted } from "./carry-count";
import type { FakeDocStorage } from "./doc-store-fake";
import { linesWithTablesTab, listedTablesTab, tinyTablesTab } from "./doc-store-scenarios";
import { linesTab } from "./docs-fetched-corpus";
import { bullets, insertText, NUMBERED, styleText, TAB } from "./docs-model-draws";
import { asFetched, kept, runStarts, undone } from "./docs-store-slice-shadow";
import { buildTab, para } from "./doc-fixture";
import { collect, HEAP_MEASURED, heapHeld, inUse } from "./heap-held";

// The module as it is but for `initialCarry` as other modules import it: each carry made has
// its numbers in a map that counts. A plain counter and no spy: a spy keeps every call's
// arguments, which would pin each carry and spoil the measures.
vi.mock("../src/markdown-converter", async importOriginal => {
  let converter = await importOriginal<typeof import("../src/markdown-converter")>();
  let { countedCarry } = await import("./carry-count");
  let initialCarry: typeof converter.initialCarry = () => countedCarry(converter.initialCarry());
  return { ...converter, initialCarry };
});

const MIB = 1 << 20;
const isPage = (query: string) => /FROM doc_seq\b[^]*ORDER BY (doc_seq\.)?seq LIMIT \?/.test(query);
const readsRun = (query: string) => query.startsWith("SELECT json FROM doc_run");
const putsResult = (query: string) => query.startsWith("INSERT INTO doc_result");

/** True at the `nth` statement `is` chooses, counted from 1, and at no other. */
function nth(n: number, is: (query: string) => boolean): (query: string) => boolean {
  let seen = 0;
  return query => is(query) && ++seen === n;
}

/**
 * True at a result's row, and at the pages of a list read joined to its renderings that
 * start 500 runs into the list and every 8,000 runs after: a full page of a walk is then in
 * hand, so two tabs are read at the same moments of each walk and differ by what is held for
 * every run.
 */
function atPages(): (query: string, bindings: readonly unknown[]) => boolean {
  return (query, bindings) => putsResult(query) ||
    (isPage(query) && query.includes("LEFT JOIN doc_md") && Number(bindings[2]) % 8_000 === 500);
}

/** A kept shape: its storage, its base version and its runs. */
type Shape = { storage: FakeDocStorage; base: DocVersion; runs: number };
const shapes = new Map<string, Shape>();

/**
 * The tab `tab` makes, kept in a storage of its own: once a file, by the first test that reads
 * it. An edit is made in its first run and undone, so that what a first use of the path
 * allocates is not measured.
 */
function shapeKept(name: string, tab: () => GoogleDocsTab): Shape {
  let known = shapes.get(name);
  if (known) return known;
  let { storage, store, base } = kept(tab());
  let { runs } = storage.sql.exec<{ runs: number }>(
    "SELECT COUNT(*) AS runs FROM doc_seq WHERE version = ?", base.id).one();
  undone(store, () => {
    let { slice, made } = editedSlice(store, base, "warm", [insertText(1, "X")]);
    store.putSlice(slice, made);
  });
  known = { storage, base, runs };
  shapes.set(name, known);
  return known;
}

const tables = (pairs: number) => shapeKept(`${pairs} tables`, () => tinyTablesTab(TAB, pairs));
const listed = (lists: number) => shapeKept(`${lists} lists`, () => listedTablesTab(TAB, lists));

const APPEND: DocEdit = { type: "appendText", markdown: "More" };

describe("what an edit holds on the shapes that hurt", HEAP_MEASURED, () => {
  // The two tabs a slope is taken between, by their pairs of a table and a paragraph (8,001
  // runs, and 19,601, which an answer under the limit can be) and by their lists.
  const PAIRS = [4_000, 9_800];
  const LISTED = [3_000, 7_700];
  const slope = (bytes: number[], sizes: number[]) => (bytes[1] - bytes[0]) / (sizes[1] - sizes[0]);

  it("an edit holds nothing for every run", () => {
    let own = (of: Shape) => {
      let before = { ...docStoreCost };
      let cost = heapHeld(of.storage, atPages(), observed => {
        let store = new DocStore(observed);
        undone(store, () => void docEditResult(store, of.base, APPEND));
      });
      // Along the walks and at the result's row, not at a walk's first page alone.
      expect(cost.seen).toBeGreaterThanOrEqual(4);
      // The piece at the tab's end, and no other run: every walk passes the runs before it
      // and decodes none. The tab ends in a table and an empty paragraph, each a run, so the
      // closure of its end is the last four runs: tried from the last run (1) and from the
      // run before (2), scouted 2 and then 4 runs back (3 and 5), and made from its first
      // run (4). The slice takes the last run from the piece.
      expect(docStoreCost.runsDecoded - before.runsDecoded).toBe(1 + 2 + 3 + 5 + 4);
      expect(docStoreCost.viewWidenings - before.viewWidenings).toBe(0);
      return cost.bytes;
    };
    // NOTHING FOR EVERY RUN: under two mebibytes and sixteen bytes a run, and by the slope.
    let byRun = PAIRS.map(pairs => {
      let of = tables(pairs);
      let bytes = own(of);
      expect(bytes, `${of.runs} runs`).toBeLessThanOrEqual(2 * MIB + 16 * of.runs);
      return bytes;
    });
    expect(slope(byRun, PAIRS.map(pairs => 2 * pairs + 1))).toBeLessThanOrEqual(16);
  });

  // PINNED BY A COUNT, never a clock: the entries of carries' numbers a call reads or writes.
  it("an edit touches the lists each run before it counts in", () => {
    let touched: number[] = [];
    for (let lists of LISTED) {
      let of = listed(lists);
      // One edit in the tab's last table. Each pass over the runs before it moves a carry
      // past them, which reads and writes the number of the one list each table's run counts
      // in (2 entries a list): the five passes of the piece (from the table's run, from the
      // run before, two scouts and the piece itself) and the walk to the slice, 6 * 2 a list.
      // The walk after the slice reads nothing.
      let store = new DocStore(of.storage);
      let edit: DocEdit = {
        type: "replaceText", oldMarkdown: `cell ${lists - 1}`, newMarkdown: "cell changed", inTable: true,
      };
      let whole = counted(() => undone(store, () => void docEditResult(store, of.base, edit)));
      expect(whole.touched).toBeLessThanOrEqual(13 * lists);
      expect(whole.touched).toBeGreaterThan(11 * lists);
      touched.push(whole.touched);
    }
    // With the lists, and not with their square.
    let [small, large] = touched;
    expect(large / small).toBeGreaterThan(2.3);
    expect(large / small).toBeLessThan(2.8);
  });
});

describe("what the widening loop holds", HEAP_MEASURED, () => {
  /** Runs of twenty elements, whatever their content. */
  const TWENTIES: RunSizes = { least: 0, target: 1 << 30, most: Infinity, elements: 20 };

  it("a batch that widens holds one slice at a time", () => {
    // Some 2 MB of run JSON in 300 runs.
    let { storage, base } = kept(asFetched(linesTab(6_000)), TWENTIES);
    let starts = runStarts(storage, base);
    let runs = starts.length - 1;
    expect(runs).toBeGreaterThan(200);
    // A range styled from the second run's second index to the tab's end, and a bulleted
    // range one index past the second run's first index: the first guess is every run but
    // the first, the model reads the element before the bulleted paragraph, and the second
    // attempt is the whole tab.
    let requests: GoogleDocsRequest[] = [
      styleText(starts[1] + 1, base.bodyEndIndex - 1, { bold: true }, "bold"),
      bullets(starts[1] + 1, starts[1] + 3, NUMBERED),
    ];
    // Made once before anything is measured: what the first edge thrown allocates for good
    // (the test runner reads its source maps to write an error's stack) is not what the loop
    // holds.
    void editedSlice(new DocStore(storage), base, "byHand", requests);
    // A slice of every run, alone: what the widened attempt must hold. Measured at the read
    // of its last run.
    let whole = heapHeld(storage, nth(runs, readsRun), observed =>
      void new DocStore(observed).slice(base, { from: starts[0], to: base.bodyEndIndex - 1, behind: [] }));
    expect(whole.seen).toBe(1);
    expect(whole.bytes).toBeGreaterThan(MIB);

    // Through the loop the source uses, at the read of the last run of the second attempt.
    let before = { ...docStoreCost };
    let held = heapHeld(storage, nth(runs - 1 + runs, readsRun), observed =>
      void editedSlice(new DocStore(observed), base, "byHand", requests));
    expect(held.seen).toBe(1);
    expect(docStoreCost.viewWidenings - before.viewWidenings).toBe(1);
    expect(docStoreCost.runsDecoded - before.runsDecoded).toBe(runs - 1 + runs);
    expect(held.bytes).toBeLessThanOrEqual(1.4 * whole.bytes);

    // THE TEETH: the same batch through a loop that keeps the failed slice in a variable
    // while the wider one is decoded holds both.
    let both = heapHeld(storage, nth(runs - 1 + runs, readsRun), observed => {
      let store = new DocStore(observed);
      let slice: DocSlice = store.slice(base, batchReach(requests));
      for (;;) {
        try {
          applyDocsRequestsToSlice(slice.piece, requests);
          return;
        } catch (thrown) {
          if (!(thrown instanceof SliceEdgeError)) throw thrown;
          slice = store.widen(base, slice, thrown);
        }
      }
    });
    expect(both.seen).toBe(1);
    expect(both.bytes).toBeGreaterThan(1.8 * whole.bytes);
  });
});

// WHAT AN EDIT BUILT FROM A PIECE HOLDS OF THE TAB BEFORE, once its builders have returned:
// the runs the piece decoded that the model's slice names, and nothing of the piece's
// rendering. A weak reference keeps its target to the end of the job that made it, so the
// piece is asked in one job (by a reading the caller makes and goes on holding, as a
// preparation does) and the edit made in a later one.
describe("what an edit holds of its piece while the model runs", HEAP_MEASURED, () => {
  const PARAGRAPHS = 20_000;
  const lines = () => shapeKept("20,000 lines", () => asFetched(linesTab(PARAGRAPHS)));
  /** The text of line `at`, whole. */
  const textOf = (at: number) =>
    `Line ${String(at).padStart(5, "0")}: ${"what a paragraph of a document says. ".repeat(4)}`.trimEnd();
  const laterJob = () => new Promise(resolve => setImmediate(resolve));
  afterEach(() => vi.restoreAllMocks());

  /**
   * Asks `reading` the piece of `own`, and answers a weak reference to its source map and
   * nothing else. In a function of its own: no frame of the test names the piece.
   */
  function watchedPiece(reading: StoredTabReading, own: OwnRange): WeakRef<object> {
    return new WeakRef(reading.piece(own).sourceMap);
  }

  it("no rendering of the tab before is in hand while the model runs", async () => {
    let of = lines();
    let middle = 9_000;
    let cases: [string, DocEdit, (reading: StoredTabReading) => OwnRange][] = [
      ["a replacement", { type: "replaceText", oldMarkdown: textOf(middle), newMarkdown: "Changed." },
        reading => {
          let at = reading.find(textOf(middle)) as number;
          return { markdown: { mdStart: at, mdEnd: at + textOf(middle).length } };
        }],
      ["an append", APPEND, () => "end"],
    ];
    let held: number[] = [];
    // Each edit made once before anything is measured: what a first use of the path
    // allocates for good is not what the edit holds.
    for (let [, edit] of cases) {
      let warm = new DocStore(of.storage);
      undone(warm, () => void docEditResult(warm, of.base, edit));
    }
    for (let [name, edit, ownOf] of cases) {
      let store = new DocStore(of.storage);
      let before = Math.min(inUse(), inUse());
      // The caller's reading, held to the end, and the piece it asked.
      let reading = storedTabReading(store, of.base);
      let rendering = watchedPiece(reading, ownOf(reading));
      await laterJob();
      expect(rendering.deref(), name).toBeDefined();
      await laterJob();

      let collected: boolean | undefined, bytes = 0;
      let slice = DocStore.prototype.slice;
      vi.spyOn(DocStore.prototype, "slice").mockImplementation(function (this: DocStore, ...given) {
        // At the model's first slice: the piece's rendering is unreachable, and what is in
        // use more than before the reading was made is the decoded runs handed on, the
        // batch and what the reading remembers of its answers.
        if (collected === undefined) {
          bytes = Math.min(inUse(), inUse()) - before;
          collected = rendering.deref() === undefined;
        }
        return slice.apply(this, given);
      });
      let decoded = docStoreCost.runsDecoded;
      undone(store, () => void docEditResult(store, of.base, edit, reading));
      vi.restoreAllMocks();

      expect(collected, name).toBe(true);
      // The piece came with the reading, and the slice took its run: nothing more decoded.
      expect(docStoreCost.runsDecoded - decoded, name).toBe(0);
      expect(reading.takeDecoded(), name).toBeUndefined();
      held.push(bytes);
    }
    // The run handed on, decoded, the batch and the edit's text: a small multiple of a run
    // and no term of the tab, whose rendering whole is megabytes.
    for (let bytes of held) expect(bytes).toBeLessThanOrEqual(240_000);
  });

  // A TABLE CHANGE'S PREPARATION makes its piece, its pending card and its edit in one job,
  // where a weak reference tells nothing (it keeps its target to the job's end). So each
  // piece the store answers is given a weight, hung on its source map and reachable from
  // nothing else: it is in use for as long as that source map can be reached.
  describe("a table change prepared", () => {
    const WEIGHT = 8 * MIB;
    const text = (at: number) => `Line ${String(at).padStart(5, "0")}.`;
    const tabled = () => shapeKept("20,000 lines and three tables", () => asFetched(linesWithTablesTab(
      TAB, Array.from({ length: PARAGRAPHS }, (_, at) => text(at)), [5_000, 10_000, 15_000])));
    const CALLS: [name: string, call: TableCall, pieces: number][] = [
      ["a row added", { method: "insertTableRows", lines: { table: 1, cells: [["added"]] } }, 1],
      // The piece around the new table's place is made once more, for its number.
      ["a table added", { method: "insertTable", table: { rows: 1, columns: 1, after: text(7_030) } }, 2],
    ];

    /**
     * `call` prepared on the tab, every piece weighted: how many pieces the store made, and
     * what is in use more than before the preparation at the model's first slice and at the
     * card's first read: where the lists of the tab before and after differ.
     */
    function prepared(call: TableCall): { pieces: number; atSlice: number; atCard: number } {
      let of = tabled();
      let store = new DocStore(of.storage);
      let pieces = 0, atSlice: number | undefined, atCard: number | undefined;
      // The three methods are replaced by hand: a spy keeps every call's answer, and the
      // answer of `piece` is what must be let go.
      let { piece, slice, changed } = DocStore.prototype;
      let before = Math.min(inUse(), inUse());
      DocStore.prototype.piece = function (this: DocStore, version, at) {
        let made = piece.call(this, version, at);
        Object.assign(made.rendering.sourceMap, { weight: new Uint8Array(WEIGHT) });
        pieces++;
        return made;
      };
      DocStore.prototype.slice = function (this: DocStore, ...given) {
        atSlice ??= Math.min(inUse(), inUse()) - before;
        return slice.apply(this, given);
      };
      DocStore.prototype.changed = function (this: DocStore, ...versions) {
        atCard ??= Math.min(inUse(), inUse()) - before;
        return changed.apply(this, versions);
      };
      try {
        undone(store, () => void prepareTableChange(store, of.base, call, "the tab"));
      } finally {
        Object.assign(DocStore.prototype, { piece, slice, changed });
      }
      return { pieces, atSlice: atSlice!, atCard: atCard! };
    }

    it.each(CALLS)("no rendering of the tab before is in hand while the model runs: %s", (_name, call, pieces) => {
      // Made once before anything is measured.
      prepared(call);
      let held = prepared(call);
      expect(held.pieces).toBe(pieces);
      // The reading the preparation holds, and the pending card, keep nothing of the piece's
      // source map: its weight is collected by the model's first slice.
      expect(held.atSlice).toBeLessThan(WEIGHT / 2);
    });

    it("the piece a new table's number is read from is let go before the card's reads", () => {
      let [, call] = CALLS[1];
      prepared(call);
      let held = prepared(call);
      expect(held.pieces).toBe(2);
      // Neither piece's weight is in use at the card's first read.
      expect(held.atCard).toBeLessThan(WEIGHT / 2);
    });
  });

  it("a run the slice does not take is let go before the model runs", async () => {
    let of = lines();
    let starts = runStarts(of.storage, of.base);
    let lineLength = (of.base.bodyEndIndex - 1) / PARAGRAPHS;
    // The first paragraph of a run in the middle of the tab: its closure reaches the run
    // before, which the piece keeps decoded and the batch does not name.
    let place = Math.floor(of.runs / 2);
    let first = (starts[place] - 1) / lineLength;
    expect(Number.isInteger(first)).toBe(true);
    let store = new DocStore(of.storage);
    let before: WeakRef<object> | undefined, held: boolean | undefined;
    let piece = DocStore.prototype.piece;
    vi.spyOn(DocStore.prototype, "piece").mockImplementation(function (this: DocStore, version, at) {
      let made = piece.call(this, version, at);
      // One element of the run before the piece's place, and nothing else of the piece.
      held = made.decoded.has(at.place - 1) && made.decoded.has(at.place);
      before = new WeakRef(made.decoded.get(at.place - 1)!.elements[0]);
      return made;
    });
    let reading = storedTabReading(store, of.base);
    let text = textOf(first);
    let at = reading.find(text) as number;
    void watchedPiece(reading, { markdown: { mdStart: at + 5, mdEnd: at + 10 } });
    expect(held).toBe(true);
    await laterJob();
    expect(before!.deref()).toBeDefined();
    await laterJob();

    let collected: boolean | undefined;
    let putSlice = DocStore.prototype.putSlice;
    vi.spyOn(DocStore.prototype, "putSlice").mockImplementation(function (this: DocStore, ...given) {
      collect();
      collected ??= before!.deref() === undefined;
      return putSlice.apply(this, given);
    });
    undone(store, () => void docEditResult(store, of.base, {
      type: "replaceText", oldMarkdown: text.slice(5, 10), newMarkdown: "first",
    }, reading));

    // Let go with the caller's reading still held: the first slice took the run it names,
    // and the map was emptied of the run before.
    expect(collected).toBe(true);
    expect(reading.version).toBe(of.base);
  });

  it("a result found stored lets go of the piece too", () => {
    // Twelve paragraphs of 200,000 characters, each a run: the piece around the seventh is
    // five of them, a megabyte of Markdown, so that a piece still in hand shows in the heap.
    let wide = shapeKept("12 wide paragraphs", () => asFetched(buildTab(
      Array.from({ length: 12 }, (_, at) => para(`P${at} ${String(at).repeat(200_000)}`)))));
    let store = new DocStore(wide.storage);
    undone(store, () => {
      // Made once, and found stored after.
      prepareTextReplacement(store, wide.base, "P6 ", "Q6 ", "Tab", googleDocDisplayLimit("replaceText"));
      let before = Math.min(inUse(), inUse());
      let bytes: number | undefined;
      let changed = DocStore.prototype.changed;
      vi.spyOn(DocStore.prototype, "changed").mockImplementation(function (this: DocStore, ...versions) {
        // The card's first read after the edit was found: where the two lists differ.
        bytes ??= Math.min(inUse(), inUse()) - before;
        return changed.apply(this, versions);
      });
      let decoded = docStoreCost.runsDecoded;
      prepareTextReplacement(store, wide.base, "P6 ", "Q6 ", "Tab", googleDocDisplayLimit("replaceText"));
      vi.restoreAllMocks();

      // Decoded: the piece the preparation asked for the path the replacement takes, and
      // no run for an edit found stored. The closure is two runs before the paragraph's and
      // two after it: tried from its run (1) and from the run before (2), scouted two runs
      // back (3), and made (5).
      expect(docStoreCost.runsDecoded - decoded).toBe(1 + 2 + 3 + 5);
      // The piece is a megabyte of Markdown and two decoded runs of 200,000 characters: let
      // go, what is in use is under an eighth of it.
      expect(bytes).toBeDefined();
      expect(bytes!).toBeLessThanOrEqual(100_000);
    });
  });
});
