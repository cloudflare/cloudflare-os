// What an edit's own part HOLDS of a stored Google Doc tab: the slice of the runs its batch
// names, the model, and the version the slice gives. Nothing for every run of the tab, and of
// its lists one carry's numbers and the lists the slice's own runs name. Measured on the
// shapes that hurt: tabs of 8,001 and 19,601 runs, and tabs of 3,000 and 7,700 numbered lists
// that one run each names, the bound pinned in bytes a run or a list and as a slope between
// the two sizes. Each shape is kept once, by the first test that reads it, and an edit is made
// in its first run and undone before anything is measured: what a first use allocates is not
// what an edit holds. Whether the model follows a version of another digest is asked run by
// run, and held here too.
// A file of its own, because it replaces a module for every test of its file: the renderer's
// `initialCarry` as other modules import it, so that each carry the store makes holds its
// numbers in a map that counts the entries read and written. THE HEAP IS MEASURED WITH THAT
// MAP IN PLACE: it holds a number and no record of a call. The walk that holds EVERY list
// apart is not reached by one edit (it takes a version that numbers every list otherwise);
// what the pair costs there is pinned where the carry is, on the class and through a fetch.

import { createSimulationStore } from "@gadgets/gatekeeper-kit/simulation-store";
import { describe, expect, it, vi } from "vitest";
import type { GoogleDocsRequest, GoogleDocsTab } from "../src/docs-api";
import {
  applyDocsRequestsToSlice, batchReach, hasModelFootnotes, hasModelIndexes, unindexedTabRefusal,
} from "../src/docs-model";
import { docTabReducer } from "../src/docs-replay";
import type { QueuedDocRecord } from "../src/docs-replay";
import type { RunSizes } from "../src/docs-runs";
import { DocStore, docStoreCost } from "../src/docs-store";
import type { DocSlice, DocVersion } from "../src/docs-store";
import { MARKDOWN_RENDERING_VERSION } from "../src/markdown-converter";
import { counted } from "./carry-count";
import { BULLET_LIST, buildTab, footnote, item, para } from "./doc-fixture";
import { fakeDocStorage } from "./doc-store-fake";
import type { FakeDocStorage } from "./doc-store-fake";
import {
  listedTablesTab, RUNS_OF_THREE, scenarioBase, tinyTablesTab, under, wholeTabsFetched,
} from "./doc-store-scenarios";
import { linesTab } from "./docs-fetched-corpus";
import { bullets, deleteRange, insertText, NUMBERED, TAB } from "./docs-model-draws";
import { applied, asFetched, kept, undone } from "./docs-store-slice-shadow";
import { HEAP_MEASURED, heapHeld } from "./heap-held";

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
/** A run an element. */
const ONE_EACH: RunSizes = { ...RUNS_OF_THREE, elements: 1 };

const isPage = (query: string) => /FROM doc_seq\b[^]*ORDER BY (doc_seq\.)?seq LIMIT \?/.test(query);
const readsRun = (query: string) => query.startsWith("SELECT json FROM doc_run");
const putsVersion = (query: string) => query.startsWith("INSERT INTO doc_version");

/** True at the `nth` statement `is` chooses, counted from 1, and at no other. */
function nth(n: number, is: (query: string) => boolean): (query: string) => boolean {
  let seen = 0;
  return query => is(query) && ++seen === n;
}

/** True at every fortieth page of a list read, from the first, and at a version's row. */
function atPages(): (query: string) => boolean {
  let pages = 0;
  return query => putsVersion(query) || (isPage(query) && pages++ % 40 === 0);
}

/** A batch through the store as its caller makes it; a refusal is a failure. */
function edit(store: DocStore, version: DocVersion, requests: readonly GoogleDocsRequest[]): DocVersion {
  let made = applied(store, store.slice(version, batchReach(requests)), requests);
  if ("refused" in made) throw new Error(`refused: ${made.refused.message}`);
  return store.putSlice(made.slice, made.made);
}

/** A kept shape: its storage, its base version, and what the tests read of the tab. */
type Shape = {
  storage: FakeDocStorage; base: DocVersion; runs: number; pages: number;
  /** The first index of the cell paragraph of the first table, of the second and of the last. */
  firstCell: number; secondCell: number; lastCell: number;
  /** The id of the context's row, and its length in characters. */
  context: string; contextLength: number;
};
const shapes = new Map<string, Shape>();

/**
 * The tab `tab` makes, kept in a storage of its own: once a file. An edit is made in its
 * first run and undone, so that what a first use of the path allocates is not measured and
 * warming up costs no pass over the tab.
 */
function shape(name: string, tab: () => GoogleDocsTab): Shape {
  let known = shapes.get(name);
  if (known) return known;
  let { storage, store, base } = kept(tab());
  let { runs } = storage.sql.exec<{ runs: number }>(
    "SELECT COUNT(*) AS runs FROM doc_seq WHERE version = ?", base.id).one();
  // The last two runs are the last table and the paragraph after it.
  let [after, table] = storage.sql.exec<{ size: number }>(
    "SELECT size FROM doc_seq WHERE version = ? ORDER BY seq DESC LIMIT 2", base.id).toArray();
  // The first run, the first table and the paragraph between it and the second.
  let [first, second, between] = storage.sql.exec<{ size: number }>(
    "SELECT size FROM doc_seq WHERE version = ? AND seq < 3 ORDER BY seq", base.id).toArray();
  let { context, length } = storage.sql.exec<{ context: string; length: number }>(
    `SELECT doc_version.context, length(doc_run.json) AS length FROM doc_version
       JOIN doc_run ON doc_run.id = doc_version.context WHERE doc_version.doc = ? AND doc_version.id = ?`,
    base.doc, base.id).one();
  undone(store, () => void edit(store, base, [insertText(1, "X")]));
  known = {
    storage, base, runs, pages: Math.ceil(runs / 500), context, contextLength: length,
    // A table's cell paragraph starts three indexes into the table.
    firstCell: first.size + 3, secondCell: first.size + second.size + between.size + 3,
    lastCell: base.bodyEndIndex - after.size - table.size + 3,
  };
  shapes.set(name, known);
  return known;
}

/** `tinyTablesTab` with a footnote reference in its first paragraph, every later index one on. */
function notedTablesTab(pairs: number): GoogleDocsTab {
  let tab = tinyTablesTab(TAB, pairs);
  let move = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(move);
    if (typeof value !== "object" || value === null) return;
    let part = value as { startIndex?: number; endIndex?: number };
    if (typeof part.startIndex === "number" && part.startIndex >= 2) part.startIndex++;
    if (typeof part.endIndex === "number" && part.endIndex >= 2) part.endIndex++;
    Object.values(part).forEach(move);
  };
  move(tab.body.content);
  let [text] = tab.body.content[1].paragraph!.elements;
  text.startIndex = 2;
  tab.body.content[1].paragraph!.elements.unshift(
    { startIndex: 1, endIndex: 2, footnoteReference: { footnoteId: "f1", footnoteNumber: "1" } });
  return tab;
}

const tables = (pairs: number) => shape(`${pairs} tables`, () => tinyTablesTab(TAB, pairs));
const noted = (pairs: number) => shape(`${pairs} tables, noted`, () => notedTablesTab(pairs));
const listed = (lists: number) => shape(`${lists} lists`, () => listedTablesTab(TAB, lists));

/**
 * What `run` holds and costs, by a store over the kept shape: the bytes in use at the
 * statements `at` chooses over the bytes before the call (`heapHeld`), how many statements
 * it chose, the store's counters, the entries of carries' numbers it touched and the carries
 * it made, and how often it read the context's row whole. What `run` writes is undone.
 * `digest` is the digest of that store's code: the one that kept the shape, where not given.
 * Numbers only: nothing `run` makes is held here.
 */
function measured(
  { storage, context }: Shape, at: (query: string) => boolean, run: (store: DocStore) => void,
  digest?: string,
) {
  let before = { ...docStoreCost };
  let contextReads = 0;
  let carries = { touched: 0, carries: 0 };
  let { bytes, seen } = heapHeld(storage, at, observed => {
    let store = new DocStore({
      ...observed,
      sql: { exec: (query: string, ...bindings: unknown[]) => {
        if (readsRun(query) && bindings[0] === context) contextReads++;
        return observed.sql.exec(query, ...bindings);
      } },
    } as FakeDocStorage, undefined, digest);
    carries = counted(() => undone(store, () => run(store)));
  });
  return {
    bytes, seen, contextReads, touched: carries.touched, carries: carries.carries,
    runsDecoded: docStoreCost.runsDecoded - before.runsDecoded,
    runsRendered: docStoreCost.runsRendered - before.runsRendered,
    runsKeyed: docStoreCost.runsKeyed - before.runsKeyed,
    rowsWritten: docStoreCost.rowsWritten - before.rowsWritten,
  };
}

// THE BOUNDS, in bytes a list of the tab.
/**
 * An edit's own part: ONE carry's numbers, a map entry and a short array for each list that
 * holds a number so far (113 to 157 measured between 3,000 and 7,700 lists: the larger and
 * half as much again, rounded up). A second carry of the tab doubles it.
 */
const BY_LIST = 240;
/**
 * A batch that makes a list: the context parsed whole, with its text as it is read and as
 * it is written (1,116 measured on 3,000 lists, rounded up by a quarter).
 */
const MADE_BY_LIST = 1_400;

/** A text change in the cell paragraph that starts at `index`. */
const inCell = (index: number) => [insertText(index, "X")];

describe("what is held for every run and for every list", HEAP_MEASURED, () => {
  // The two tabs the slope is taken between, by their pairs of a table and a paragraph:
  // 8,001 runs, and 19,601, which an answer under the limit can be.
  const PAIRS = [4_000, 9_800];

  // AN EDIT'S PART HOLDS NOTHING FOR EVERY RUN: each case on both tabs, under two mebibytes
  // and sixteen bytes a run, and by the slope between the two.
  it.each<[string, (of: Shape, footnoted: () => Shape) => ReturnType<typeof measured>, (runs: number) => object]>([
    // The walk passes every run, and decodes one. Measured at the read of the slice's run.
    ["the slice of the last table",
      of => measured(of, nth(1, readsRun), store => void store.slice(of.base, batchReach(inCell(of.lastCell)))),
      () => ({ runsDecoded: 1, rowsWritten: 0 })],
    // The list is read to the slice, its names pass for the version's id, and the child's
    // list is written inside storage. Measured at every fortieth page and at the version's row.
    ["an edit in the last table",
      of => measured(of, atPages(), store => void edit(store, of.base, inCell(of.lastCell))),
      runs => ({ runsDecoded: 1, runsRendered: 1, runsKeyed: 0, rowsWritten: runs + 3 })],
    // The walk after the slice settles at once, and the runs after are copied inside storage
    // with no page of them read but their names.
    ["an edit in the first table",
      of => measured(of, atPages(), store => void edit(store, of.base, inCell(of.firstCell))),
      runs => ({ runsDecoded: 1, runsRendered: 1, runsKeyed: 0, rowsWritten: runs + 3 })],
    // A footnote reference deleted in the first paragraph: the carry never settles, so the
    // walk goes to the tab's end, a page at a time, keying every later run from its stored
    // summary. Measured at the walk's last page: one page to the slice, then the pages of
    // the later runs twice, for their names and for the walk.
    ["a reference deleted in the first run",
      (of, footnoted) => {
        let { base } = footnoted();
        return measured(footnoted(), nth(1 + 2 * Math.ceil((of.runs - 1) / 500), isPage), store =>
          void edit(store, base, [deleteRange(1, 2)]));
      },
      runs => ({ seen: 1, runsDecoded: 1, runsRendered: 1, runsKeyed: runs - 1 })],
  ])("an edit's part holds nothing for every run: %s", (_, hold, costs) => {
    let held = PAIRS.map(pairs => {
      let of = tables(pairs);
      let { runs } = of;
      expect(runs).toBe(2 * pairs + 1);
      let cost = hold(of, () => noted(pairs));
      expect(cost.seen).toBeGreaterThan(0);
      expect(cost).toMatchObject(costs(runs));
      expect(cost.bytes, `${runs} runs`).toBeLessThanOrEqual(2 * MIB + 16 * runs);
      return cost.bytes;
    });
    // THE SLOPE, between 8,001 and 19,601 runs: bytes a run.
    expect((held[1] - held[0]) / 11_600).toBeLessThanOrEqual(16);
  });

  it("the teeth: a tab decoded whole holds hundreds of bytes a run", () => {
    for (let pairs of PAIRS) {
      let of = tables(pairs);
      // Measured the same way, at its last run's read.
      let whole = measured(of, nth(of.runs, readsRun), store => void store.tab(of.base));
      expect(whole.seen).toBe(1);
      expect(whole.bytes).toBeGreaterThan(300 * of.runs);
    }
  });

  // THE LISTS: a tab of thousands of numbered lists, each named by one run. The sizes the
  // slope is taken between; the larger is the shape that hurts (15,401 runs, a context of
  // some 2 MB).
  const LISTED = [3_000, 7_700];

  it("keeps the two tabs of numbered lists, each list named by one run", () => {
    for (let lists of LISTED) {
      let { runs, contextLength } = listed(lists);
      expect(runs).toBe(2 * lists + 1);
      // Every figure in bytes a list scales with a definition's length: 270 characters.
      expect(contextLength / lists).toBeGreaterThan(243);
      expect(contextLength / lists).toBeLessThan(297);
    }
  });

  it("an edit's part holds nothing of the lists it does not name", () => {
    // What an edit in the last table holds on each tab: at the read of its slice's run (the
    // walk to the slice alone) and at the version's row.
    let held: Record<string, number[]> = { slice: [], version: [], parsed: [] };
    for (let lists of LISTED) {
      let of = listed(lists);
      let requests = inCell(of.lastCell);
      let run = (store: DocStore) => {
        let made = applied(store, store.slice(of.base, batchReach(requests)), requests);
        if ("refused" in made) throw new Error(made.refused.message);
        // Of the tab's lists the piece holds the one its cell names, and no other.
        expect(Object.keys(made.slice.piece.lists)).toEqual([`kix.list${lists - 1}`]);
        store.putSlice(made.slice, made.made);
      };
      let slice = measured(of, nth(1, readsRun), run);
      let version = measured(of, putsVersion, run);
      for (let cost of [slice, version]) {
        // No statement reads the context whole; the walk's carry and the slice's pair.
        expect(cost).toMatchObject({ seen: 1, contextReads: 0, carries: 2, runsDecoded: 1, runsKeyed: 0 });
      }
      held.slice.push(slice.bytes);
      held.version.push(version.bytes);
      // What the context parsed whole takes: its text read, parsed and let go.
      let parsed = heapHeld(of.storage, query => query === "SELECT 1 AS probe", observed => {
        let context = JSON.parse(observed.sql.exec<{ json: string }>(
          "SELECT json FROM doc_run WHERE id = ?", of.context).one().json) as { lists: object };
        observed.sql.exec("SELECT 1 AS probe").toArray();
        expect(Object.keys(context.lists)).toHaveLength(lists);
      });
      expect(parsed.seen).toBe(1);
      held.parsed.push(parsed.bytes);
    }
    // THE SLOPE, IN BYTES A LIST: one carry's numbers, an entry for each list that holds a
    // number so far. A second carry of the tab would double it.
    let slope = (bytes: number[]) => (bytes[1] - bytes[0]) / (LISTED[1] - LISTED[0]);
    expect(slope(held.slice)).toBeLessThanOrEqual(BY_LIST);
    expect(slope(held.version)).toBeLessThanOrEqual(BY_LIST);
    expect(slope(held.slice)).toBeGreaterThan(BY_LIST / 4);
    // Under half of what the context parsed whole takes for each list (546 measured, on
    // definitions of 254 characters, which is all a fetch keeps of one: the carry's numbers
    // are a fifth to three tenths of it).
    expect(BY_LIST).toBeLessThan(slope(held.parsed) / 2);
  });

  it("a batch that makes a list holds the context parsed, and no other batch does", () => {
    // On the smaller tab: its walk after the slice keys every later run again, a pass of its own.
    let of = listed(LISTED[0]);
    let requests = [bullets(1, 2, NUMBERED)];
    let cost = measured(of, nth(2, query => query.startsWith("INSERT INTO doc_run")), store => {
      let child = edit(store, of.base, requests);
      let { lists } = JSON.parse(of.storage.sql.exec<{ json: string }>(
        `SELECT doc_run.json FROM doc_version JOIN doc_run ON doc_run.id = doc_version.context
         WHERE doc_version.doc = ? AND doc_version.id = ?`, child.doc, child.id).one().json) as { lists: object };
      // The child's context holds one list more than the tab's.
      expect(Object.keys(lists)).toHaveLength(LISTED[0] + 1);
    });
    expect(cost).toMatchObject({ seen: 1, contextReads: 1, runsKeyed: of.runs - 1 });
    // The context parsed, with its text as it is written: bytes a list of the tab.
    expect(cost.bytes / LISTED[0]).toBeLessThanOrEqual(MADE_BY_LIST);
    expect(cost.bytes / LISTED[0]).toBeGreaterThan(BY_LIST);
  });

  // PINNED BY A COUNT, never a clock: the entries of carries' numbers a call reads or writes.
  // Both sides of a slice's pair are counted, since the pair is handed a carry the same
  // `initialCarry` made.
  it("the walk to an edit's slice touches the lists each run counts in", () => {
    let touched: Record<string, number[]> = { slice: [], settled: [], renumbered: [] };
    for (let lists of LISTED) {
      let of = listed(lists);
      let store = new DocStore(of.storage);
      let requests = inCell(of.lastCell);
      undone(store, () => {
        // (a) The slice of the last table: the walk's carry over every run before it.
        let slice!: DocSlice;
        let walk = counted(() => {
          slice = store.slice(of.base, batchReach(requests));
        });
        expect(walk.carries).toBe(2);
        expect(walk.touched).toBeLessThanOrEqual(6 * lists);
        touched.slice.push(walk.touched);
        // (b) Its version, for a text change that leaves the numbers as they were: the two
        // carries are the same at once, and no page of the later runs is read.
        let made = applyDocsRequestsToSlice(slice.piece, requests);
        let put = counted(() => void store.putSlice(slice, made));
        expect(put.touched).toBeLessThanOrEqual(50);
        touched.settled.push(put.touched);
      });
      undone(store, () => {
        // (c) The second table's cell made an item of the FIRST list: that list then holds one
        // number more to the tab's end, so the walk after the slice never settles. BUILT BY
        // HAND: the model gives a bulleted range a list of its own, and a cell's first
        // paragraph has no paragraph before it to take a list from, so no batch makes this
        // tab. The piece of the second table's slice is changed as a batch would change it.
        let slice = store.slice(of.base, batchReach(inCell(of.secondCell)));
        expect([slice.from, slice.to]).toEqual([3, 4]);
        let { lists: held, content } = slice.piece;
        held["kix.list0"] = structuredClone(held["kix.list1"]);
        content[0].table!.tableRows![0].tableCells![0].content![0].paragraph!.bullet = { listId: "kix.list0" };
        let before = docStoreCost.runsKeyed;
        let put = counted(() => void store.putSlice(slice, { moved: 0, footnotesMoved: false, lists: [] }));
        expect(docStoreCost.runsKeyed - before).toBe(of.runs - 4);
        // The two sides together.
        expect(put.touched).toBeLessThanOrEqual(24 * lists);
        touched.renumbered.push(put.touched);
      });
    }
    // With the lists, and not with their square.
    for (let name of ["slice", "renumbered"]) {
      let [small, large] = touched[name];
      expect(large / small, name).toBeGreaterThan(2.3);
      expect(large / small, name).toBeLessThan(2.8);
    }
    // Two entries a list for the walk to the slice, and fourteen for a walk that never
    // settles: the pass's side and the other, each read and written at the run's own list.
    expect(touched).toEqual({ slice: [6_005, 15_405], settled: [8, 8], renumbered: [41_981, 107_781] });
  });
});

describe("whether the model follows a version of another digest", HEAP_MEASURED, () => {
  const append = (tabId: string): QueuedDocRecord => ({
    id: 1,
    action: { type: "appendText", markdown: "More", tabId, markdownVersion: MARKDOWN_RENDERING_VERSION },
  });
  /** What a replay refuses an append to `version` with, where it does. */
  const refusalOf = (store: DocStore, version: DocVersion) =>
    createSimulationStore(docTabReducer(store)).fold(version.tabId, version, [append(version.tabId)])
      .refused.map(({ refusal }) => refusal);
  const UNINDEXED = [{ reason: unindexedTabRefusal("appendText").message, unindexed: true }];

  /**
   * `tab` kept by a store of another digest, and asked of the default store: its answer, what
   * the walk decoded and held, and the answer and the cost of a second call.
   */
  function asked(tab: GoogleDocsTab, sizes: RunSizes) {
    let storage = fakeDocStorage();
    let { base } = keptBy(storage, tab, sizes);
    let store = new DocStore(storage, undefined, undefined, sizes);
    let { runs, longest } = storage.sql.exec<{ runs: number; longest: number }>(
      `SELECT COUNT(*) AS runs, MAX(length(doc_run.json)) AS longest FROM doc_seq
         JOIN doc_run ON doc_run.doc = ?2 AND doc_run.id = doc_seq.run
       WHERE doc_seq.version = ?1`, base.id, base.doc).one();
    let before = docStoreCost.runsDecoded;
    docStoreCost.peakRunBytesInHand = 0;
    let unindexed = store.unindexed(base);
    let decoded = docStoreCost.runsDecoded - before;
    // Every run decoded, one in hand at a time; the list read a page at a time, never whole.
    expect(decoded).toBe(runs);
    expect(docStoreCost.peakRunBytesInHand).toBe(2 * longest);
    expect(storage.statements().filter(statement => statement.endsWith("FROM doc_seq WHERE version = ? ORDER BY seq")))
      .toEqual([]);
    // The record says it from then on.
    expect(store.unindexed(base)).toBe(unindexed);
    expect(docStoreCost.runsDecoded - before).toBe(runs);
    return { storage, store, base, runs, unindexed };
  }

  /** `tab` kept in `storage` by a store of another digest, as a fetch keeps it. */
  function keptBy(storage: FakeDocStorage, tab: GoogleDocsTab, sizes: RunSizes) {
    let other = under(storage, "another", sizes);
    let head = other.keep(
      "doc", wholeTabsFetched({ revision: "r1", fetchedAt: 1_000, tabs: [{ tab, writeMarkers: [] }] }, sizes),
      { edits: [], roots: [] });
    return { base: scenarioBase(other, "doc", head) };
  }

  it("a version of another digest is asked run by run", () => {
    let followed = () => asFetched(linesTab(12));
    // An index one off, in the element that ends the tab or in its first paragraph.
    let off = (at: number) => {
      let tab = followed();
      let element = tab.body.content.at(at)!;
      element.endIndex++;
      element.paragraph!.elements.at(-1)!.endIndex++;
      return tab;
    };
    // A body that opens with a paragraph, and the same with that paragraph's starts left out.
    let opened = (starts: boolean) => {
      let tab = buildTab([para("first"), para("second"), para("third"), para("fourth")]);
      tab.body.content.shift();
      let move = (value: unknown): void => {
        if (Array.isArray(value)) return value.forEach(move);
        if (typeof value !== "object" || value === null) return;
        let part = value as { startIndex?: number; endIndex?: number };
        if (typeof part.startIndex === "number") part.startIndex--;
        if (typeof part.endIndex === "number") part.endIndex--;
        Object.values(part).forEach(move);
      };
      move(tab.body.content);
      let fetched = asFetched(tab);
      if (!starts) {
        let [first]: { startIndex?: number }[] = fetched.body.content;
        let [run]: { startIndex?: number }[] = fetched.body.content[0].paragraph!.elements;
        delete first.startIndex;
        delete run.startIndex;
      }
      return fetched;
    };
    let named = (lists: GoogleDocsTab["lists"]) => asFetched(buildTab(
      [...Array.from({ length: 8 }, (_, at) => para(`Line ${at}.`)), item("Last.", "model.1")], lists));

    for (let [name, tab, unindexed] of [
      ["a tab the model follows", followed(), false],
      ["an index off in its last run", off(-1), true],
      ["an index off in its first run", off(1), true],
      ["a body paragraph that ends in half a surrogate pair",
        asFetched(buildTab([para("first"), { runs: ["half \uD83D"] }, para("after"), para("last")])), true],
      ["a body that opens with a paragraph", opened(true), false],
      ["a body that opens with a paragraph whose starts are left out", opened(false), true],
      ["an item of the model's list with no definition, in the last run", named({ "kix.one": BULLET_LIST.L1 }), true],
      // What shows that the walk is handed the ids the context defines.
      ["the same item with its list defined", named({ "kix.one": BULLET_LIST.L1, "model.1": BULLET_LIST.L1 }), false],
    ] as const) {
      let answer = asked(tab, RUNS_OF_THREE);
      expect(answer.runs, name).toBeGreaterThanOrEqual(2);
      expect(answer.unindexed, name).toBe(unindexed);
      expect(answer.unindexed, name).toBe(!hasModelIndexes(tab) || !hasModelFootnotes(tab));
    }
  });

  it("each run's footnote numbers are counted from the references before it", () => {
    // Every tab above fails on an index: these are followed by their indexes, so the answer
    // is the footnotes' alone. A run an element, so each reference stands in a run of its own.
    let noted = (...numbers: number[]) => asFetched(buildTab(numbers.flatMap((number, at) =>
      [{ runs: [`Noted ${at}`, footnote(number), ".\n"] }, para(`Plain ${at}.`)])));
    for (let [numbers, unindexed] of [
      // By place: a walk that hands every run base 0 reads the second as 1, and says it is not.
      [[1, 2, 3], false],
      [[1, 2, 7], true],
      // Each its place and the references before its run: what such a walk reads as by place.
      [[1, 3, 5], true],
    ] as const) {
      let tab = noted(...numbers);
      expect(hasModelIndexes(tab)).toBe(true);
      let { storage, store, base, runs, unindexed: answer } = asked(tab, ONE_EACH);
      expect(runs).toBeGreaterThanOrEqual(4);
      expect(storage.sql.exec<{ noted: number }>(
        `SELECT COUNT(*) AS noted FROM doc_seq JOIN doc_run ON doc_run.doc = ?2 AND doc_run.id = doc_seq.run
         WHERE doc_seq.version = ?1 AND instr(doc_run.json, '"footnoteReference"') > 0`, base.id, base.doc).one().noted).toBe(3);
      expect(answer, String(numbers)).toBe(unindexed);
      expect(answer, String(numbers)).toBe(!hasModelFootnotes(tab));
      // The text of the refusal as it is, where the tab takes no edit.
      expect(refusalOf(store, base), String(numbers)).toEqual(unindexed ? UNINDEXED : []);
    }
  });

  it("the walk holds a page and a run, whatever the runs", () => {
    let of = tables(9_800);
    let { base, runs } = of;
    let walk = measured(of, nth(runs - 100, readsRun), store => void store.unindexed(base), "another");
    expect(walk).toMatchObject({ seen: 1, runsDecoded: runs, contextReads: 0 });
    expect(walk.bytes).toBeLessThanOrEqual(2 * MIB + 16 * runs);
    // THE TEETH: the tab decoded whole, at the same run's read.
    let whole = measured(of, nth(runs - 100, readsRun), store => void store.tab(base));
    expect(whole.seen).toBe(1);
    expect(whole.bytes).toBeGreaterThan(500 * runs);
  });
});
