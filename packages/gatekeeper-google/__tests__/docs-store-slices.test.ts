// `DocStore.slice`, `widen` and `putSlice`: which runs a slice holds and decodes, the version it
// gives, a row lost under them, the faults of a caller, and what an edit does to run boundaries.
// The differential from every stretch of runs is in `docs-store-slices-forced` and `-real`.

import { readFileSync } from "node:fs";
import path from "node:path";
import { createSimulationStore } from "@gadgets/gatekeeper-kit/simulation-store";
import { describe, expect, it } from "vitest";
import type { GoogleDocsRequest, GoogleDocsTab, StructuralElement } from "../src/docs-api";
import {
  applyDocsRequests, applyDocsRequestsToSlice, batchReach, hasModelFootnotes, hasModelIndexes,
  markModelIndexed, MODEL_LIST_ID, SliceEdgeError, unindexedTabRefusal,
} from "../src/docs-model";
import type { BatchReach } from "../src/docs-model";
import { docTabReducer } from "../src/docs-replay";
import type { QueuedDocRecord } from "../src/docs-replay";
import { DOC_COPY_UNREADABLE, pruneTab, tabIdentity } from "../src/docs-replica";
import { cutRuns, decodeRun, RUN_SIZES } from "../src/docs-runs";
import type { RunSizes } from "../src/docs-runs";
import {
  DocRowTooLargeError, DocRunRenderError, DocStore, docStoreCost, runId,
} from "../src/docs-store";
import type { DocSlice, DocVersion } from "../src/docs-store";
import {
  advanceCarry, CarryBeside, initialCarry, MARKDOWN_RENDERING_VERSION,
  namedListIds, renderRun,
} from "../src/markdown-converter";
import type { PassCarry, RenderCarry, RunSummary } from "../src/markdown-converter";
import { BULLET_LIST, buildTab, diceOf, footnote, grid, item, NUMBERED_LIST, para } from "./doc-fixture";
import type { BlockSpec } from "./doc-fixture";
import { fakeDocStorage } from "./doc-store-fake";
import type { FakeDocStorage } from "./doc-store-fake";
import {
  countedStorage, listedTablesTab, RUNS_OF_THREE, tableScans, under,
} from "./doc-store-scenarios";
import { linesTab } from "./docs-fetched-corpus";
import { readFixtures } from "./docs-live-fixtures";
import {
  BULLETED, bullets, deleteBullets, deleteRange, deleteRow, insertText, NUMBERED,
  recordedSequenceCalls, styleText, TAB,
} from "./docs-model-draws";
import {
  applied, asFetched, expectReadsAs, kept, recordedSteps, runSizes, runStarts, stretchReach,
  undone, whole,
} from "./docs-store-slice-shadow";
import type { AppliedSlice } from "./docs-store-slice-shadow";
import { collect, HEAP_MEASURED, observing } from "./heap-held";
import { fuzzedTabs, largeTabs, recordedTabs, renderedByRuns, throughJson } from "./render-run-tabs";
import type { PlainCarry } from "./render-run-tabs";

const DOC = "doc";
/** A run an element. */
const ONE_EACH: RunSizes = { ...RUNS_OF_THREE, elements: 1 };

/** A row of a version's list. */
type Listed = { run: string; context: string; carry: string; size: number };

/** The rows `version` lists, in order. */
function listed(storage: FakeDocStorage, version: DocVersion): Listed[] {
  return storage.sql.exec<Listed>(
    "SELECT run, context, carry, size FROM doc_seq WHERE version = ? ORDER BY seq", version.id,
  ).toArray();
}

/** How many elements each run `version` lists holds, in order, read off `doc_run`. */
function runLengths(storage: FakeDocStorage, version: DocVersion): number[] {
  return storage.sql.exec<{ elements: number }>(
    `SELECT json_array_length(doc_run.json) AS elements FROM doc_seq
       JOIN doc_run ON doc_run.doc = ?2 AND doc_run.id = doc_seq.run
     WHERE doc_seq.version = ?1 ORDER BY doc_seq.seq`, version.id, version.doc,
  ).toArray().map(({ elements }) => elements);
}

/** The place of the run that holds `index`: the last whose first index is not past it. */
function placeOf(starts: readonly number[], index: number): number {
  let runs = starts.length - 1;
  return Math.max(0, starts.findLastIndex((start, place) => place < runs && start <= index));
}

/** What `run` moved of the store's counters. */
function spent(run: () => unknown) {
  let before = { ...docStoreCost };
  run();
  return {
    runsDecoded: docStoreCost.runsDecoded - before.runsDecoded,
    runsRendered: docStoreCost.runsRendered - before.runsRendered,
    runsKeyed: docStoreCost.runsKeyed - before.runsKeyed,
    rowsWritten: docStoreCost.rowsWritten - before.rowsWritten,
    viewWidenings: docStoreCost.viewWidenings - before.viewWidenings,
  };
}

/** How many footnote references `elements` hold, read off their JSON. */
function footnotesIn(elements: readonly StructuralElement[]): number {
  return JSON.stringify(elements).split('"footnoteReference":').length - 1;
}

/** A carry read as a reader reads one: its numbers asked by id for each of `listIds`. */
function carryRead(carry: RenderCarry, listIds: readonly string[]): PlainCarry {
  let numbers: [string, readonly (number | null)[]][] = [];
  for (let listId of listIds) {
    let held = carry.listNumbers.get(listId);
    if (held !== undefined) numbers.push([listId, held]);
  }
  return {
    hasOutput: carry.hasOutput, abutsProtected: carry.abutsProtected,
    ...(carry.previousListId === undefined ? {} : { previousListId: carry.previousListId }),
    continuedListLevels: carry.continuedListLevels,
    listNumbers: Object.fromEntries(numbers), footnoteBase: carry.footnoteBase,
  };
}

/** `plain` with its lists in the order `carryRead` answers them, for a comparison by value. */
function carryPlain(plain: PlainCarry): PlainCarry {
  return { ...plain, listNumbers: { ...plain.listNumbers } };
}

/** A text change in the paragraph that starts at `index`: one character put after its first. */
const typed = (index: number, text = "X") => [insertText(index + 1, text)];

/** The first index of the cell paragraph of the 1x1 table that starts at `start`. */
const cellStart = (start: number) => start + 3;

describe("a version's runs handed to the model", () => {
  it("a slice holds the runs of what a batch names, found from the list", () => {
    // Paragraphs and items of a list in turn: some runs name a list and some name none.
    let blocks: BlockSpec[] = Array.from({ length: 30 }, (_, at) =>
      at % 7 < 3 ? item(`Item ${at}.`) : para(`Line ${at}.`));
    let tab = asFetched(buildTab(blocks, BULLET_LIST));
    let { storage, base } = kept(tab, RUNS_OF_THREE);
    let counted = countedStorage(storage);
    let store = new DocStore(counted.storage, undefined, undefined, RUNS_OF_THREE);
    let starts = runStarts(storage, base);
    let lengths = runLengths(storage, base);
    let runs = lengths.length;
    expect(runs).toBeGreaterThan(8);
    let exact = applyDocsRequests(tab, []).body.content;
    let firstElement = (place: number) => lengths.slice(0, place).reduce((sum, held) => sum + held, 0);
    let seen = { lists: 0, none: 0 };

    let expectSlice = (reach: BatchReach | undefined, from: number, to: number) => {
      let before = counted.counts();
      let slice!: DocSlice;
      let cost = spent(() => {
        slice = store.slice(base, reach);
      });
      let after = counted.counts();
      let where = `${JSON.stringify(reach)}: [${from}, ${to})`;
      expect([slice.from, slice.to], where).toEqual([from, to]);
      let elements = exact.slice(firstElement(from), firstElement(to));
      expect(slice.piece.content, where).toEqual(elements);
      expect(slice.piece.origin, where).toBe(starts[from]);
      expect([slice.piece.first, slice.piece.last], where).toEqual([from === 0, to === runs]);
      // The runs held are decoded and no other: a content statement a run, and nothing more.
      expect(cost, where).toMatchObject({ runsDecoded: to - from, runsRendered: 0, rowsWritten: 0 });
      expect(after.content - before.content, where).toBe(to - from);
      // Three statements over the context, whatever the runs held; two where they name no list.
      let names = namedListIds(elements).length > 0;
      expect([after.styles - before.styles, after.lists - before.lists], where)
        .toEqual([1, names ? 2 : 1]);
      if (names) seen.lists++;
      else seen.none++;
    };

    // Each run's first index, its last, and one inside it where it holds one.
    let indexes = lengths.flatMap((_, place) => {
      let first = starts[place], last = starts[place + 1] - 1;
      return [...new Set([first, Math.floor((first + last) / 2), last])];
    });
    for (let low of indexes) {
      for (let high of indexes) {
        if (high < low) continue;
        expectSlice({ from: low, to: high, behind: [] }, placeOf(starts, low), placeOf(starts, high) + 1);
      }
    }
    // An index before the tab is in the first run, and one at or past its end in the last.
    expectSlice({ from: -5, to: -5, behind: [] }, 0, 1);
    expectSlice({ from: starts[runs], to: starts[runs] + 40, behind: [] }, runs - 1, runs);
    expectSlice({ from: -5, to: starts[runs], behind: [] }, 0, runs);
    // An index of `behind` at the first run's first index takes the run before, where there is one.
    for (let place = 0; place < runs; place++) {
      let first = starts[place];
      expectSlice({ from: first, to: first, behind: [first] }, Math.max(0, place - 1), place + 1);
      expectSlice({ from: first + 1, to: first + 1, behind: [first + 1] }, place, place + 1);
      expectSlice({ from: first + 1, to: first + 1, behind: [starts[place + 1]] }, place, place + 1);
    }
    expectSlice(undefined, 0, 1);
    expect(seen.lists).toBeGreaterThan(20);
    expect(seen.none).toBeGreaterThan(20);
    expect(counted.ran().filter(statement => statement.includes("json_tree"))).toEqual([]);
  });

  // Every stretch `[from, to)` of `runs` runs, or past twelve a seeded sample covering every run.
  function stretchesOf(runs: number, seed: number): [from: number, to: number][] {
    let stretches = new Map<string, [number, number]>();
    let add = (from: number, to: number) => stretches.set(`${from},${to}`, [from, to]);
    if (runs <= 12) {
      for (let from = 0; from < runs; from++) for (let to = from + 1; to <= runs; to++) add(from, to);
    } else {
      let { below } = diceOf(seed);
      add(0, 1);
      add(runs - 1, runs);
      add(0, runs);
      while (stretches.size < 24) {
        let from = below(runs);
        add(from, from + 1 + below(Math.min(4, runs - from)));
      }
    }
    return [...stretches.values()];
  }

  /** What a slice holds beside its piece's content, with its carries read as a reader reads them. */
  function facts(slice: DocSlice, listIds: readonly string[]) {
    let { content, ...shared } = slice.piece;
    return {
      from: slice.from, to: slice.to, shared, elements: content.length,
      ours: carryRead(slice.carries.ours, listIds), theirs: carryRead(slice.carries.theirs, listIds),
      same: slice.carries.same(),
    };
  }

  it.each([
    ["a run an element", ONE_EACH], ["the sizes a store cuts to", RUN_SIZES],
  ] as const)("a slice is what the whole tab holds there, under %s", (_, sizes) => {
    let seen = { tabs: 0, stretches: 0, styled: 0, plain: 0, named: 0, model: 0 };
    let corpus = [
      ...recordedTabs(), ...largeTabs(20), ...fuzzedTabs(20261121, 30),
      // Named styles, none, and lists of the model's own form that other runs name.
      { name: "lines with named styles", tab: linesTab(14) },
      { name: "lines with no named style", tab: buildTab(Array.from({ length: 14 }, (_, at) => para(`Line ${at}.`))) },
      {
        name: "items of the model's lists",
        tab: buildTab(
          // The table is a run of its own under any sizes, and names neither list.
          Array.from({ length: 12 }, (_, at): BlockSpec => at === 6 ? grid(["a", "b"])
            : at % 4 === 0 ? item(`One ${at}.`, "model.1")
              : at % 4 === 2 ? item(`Two ${at}.`, "model.7") : para(`Line ${at}.`)),
          { "model.1": BULLET_LIST.L1, "model.7": NUMBERED_LIST.N1, "kix.unused": BULLET_LIST.L1 }),
      },
    ];
    for (let [seed, { name, tab: source }] of corpus.entries()) {
      let tab = asFetched(source);
      // A tab the model cannot follow takes no edit, and is not sliced.
      if (!hasModelIndexes(tab) || !hasModelFootnotes(tab)) continue;
      let { storage, store, base } = kept(tab, sizes);
      let starts = runStarts(storage, base);
      let lengths = runLengths(storage, base);
      let runs = lengths.length;
      let bounds = [0];
      for (let length of lengths) bounds.push(bounds.at(-1)! + length);
      let exact = applyDocsRequests(tab, []).body.content;
      let carries = renderedByRuns(tab, bounds).carries;
      let listIds = Object.keys(tab.lists);
      let modelIds = listIds.filter(id => id.startsWith(MODEL_LIST_ID));
      seen.tabs++;
      if (tab.namedStyles) seen.styled++;
      else seen.plain++;
      for (let [from, to] of stretchesOf(runs, seed)) {
        let where = `${name}, the runs [${from}, ${to}) of ${runs}`;
        let slice = store.slice(base, stretchReach(storage, base, from, to, starts));
        let elements = exact.slice(bounds[from], bounds[to]);
        if (JSON.stringify(slice.piece.content) !== JSON.stringify(elements)) {
          expect(slice.piece.content, where).toEqual(elements);
        }
        let named = namedListIds(elements).filter(id => Object.hasOwn(tab.lists, id));
        let lists = Object.fromEntries([
          ...named.map(id => [id, tab.lists[id]] as const),
          ...modelIds.filter(id => !named.includes(id)).map(id => [id, {}] as const),
        ]);
        expect(Object.keys(slice.piece.lists).toSorted(), where).toEqual(Object.keys(lists).toSorted());
        expect(facts(slice, listIds), where).toEqual({
          from, to, elements: elements.length,
          shared: {
            tabId: tab.tabId, lists, ...(tab.namedStyles ? { namedStyles: tab.namedStyles } : {}),
            origin: elements[0]?.startIndex ?? starts[from], first: from === 0, last: to === runs,
            footnotesBefore: footnotesIn(exact.slice(0, bounds[from])),
          },
          ours: carryPlain(carries[from]), theirs: carryPlain(carries[to]),
          same: JSON.stringify(carryPlain(carries[from])) === JSON.stringify(carryPlain(carries[to])),
        });
        expect(slice.piece.namedStyles, where).toEqual(tab.namedStyles);
        seen.stretches++;
        if (named.length > 0) seen.named++;
        if (modelIds.some(id => !named.includes(id))) seen.model++;
      }
    }
    // Both kinds of tab, slices that name a list, and slices handed an id they do not name.
    expect(seen.styled).toBeGreaterThan(0);
    expect(seen.plain).toBeGreaterThan(0);
    expect(seen.named).toBeGreaterThan(50);
    expect(seen.model).toBeGreaterThan(sizes === RUN_SIZES ? 0 : 5);
    expect(seen.tabs).toBeGreaterThan(200);
    expect(seen.stretches).toBeGreaterThan(seen.tabs);
  });

  /** The key `version` lists at `place`, and the rendering stored under it. */
  function renderingAt(storage: FakeDocStorage, version: DocVersion, place: number) {
    let key = storage.sql.exec<{ run: string; context: string; carry: string }>(
      "SELECT run, context, carry FROM doc_seq WHERE version = ? AND seq = ?", version.id, place).one();
    let row = storage.sql.exec<{ made: string; summary: string; md: string }>(
      "SELECT made, summary, md FROM doc_md WHERE run = ? AND context = ? AND carry = ?",
      key.run, key.context, key.carry).toArray()[0];
    return { key, row };
  }

  /** Deletes, by its key, the rendering `version` lists at `place`: answers the row deleted. */
  function lose(storage: FakeDocStorage, version: DocVersion, place: number) {
    let { key, row } = renderingAt(storage, version, place);
    expect(row, `the rendering at place ${place}`).toBeDefined();
    storage.sql.exec(
      "DELETE FROM doc_md WHERE run = ? AND context = ? AND carry = ?", key.run, key.context, key.carry);
    return row;
  }

  /** `tab` kept twice, each store over a counted storage: the reference, and the one that loses rows. */
  function keptTwice(tab: GoogleDocsTab, sizes?: RunSizes) {
    let [reference, lost] = [kept(tab, sizes), kept(tab, sizes)].map(({ storage, base }) => {
      let counted = countedStorage(storage);
      return { storage, base, counted, store: new DocStore(counted.storage, undefined, undefined, sizes) };
    });
    expect(lost.base.id).toBe(reference.base.id);
    return { reference, lost };
  }

  /** What a call that answers a slice costs: the store's counters and the statements over the context. */
  function sliced(
    of: { counted: ReturnType<typeof countedStorage>; store: DocStore }, call: (store: DocStore) => DocSlice,
  ) {
    let before = of.counted.counts();
    let slice!: DocSlice;
    let cost = spent(() => {
      slice = call(of.store);
    });
    let after = of.counted.counts();
    return { slice, cost, lists: after.lists - before.lists, styles: after.styles - before.styles };
  }

  it("a run with no stored rendering, before a slice or in it, is rendered alone with the carry into it", () => {
    // 1,201 runs, three pages; each table's cell is an item of its own list.
    let tab = listedTablesTab(TAB, 600);
    let { reference, lost } = keptTwice(tab);
    let { base } = lost;
    let starts = runStarts(lost.storage, base);
    expect(starts).toHaveLength(1_202);
    let listIds = Object.keys(tab.lists);
    // A table of the second page, and a text change in its cell: the slice is that run.
    const S = 701;
    let requests = [insertText(cellStart(starts[S]), "X")];
    let reach = batchReach(requests)!;
    // The runs between tables share one key, so the renderings deleted are tables', each its own.
    let before = [101, 303];
    let stored = (places: number[]) => places.map(place => renderingAt(lost.storage, base, place).row);
    let same = (got: DocSlice, want: DocSlice) => {
      expect(facts(got, listIds)).toEqual(facts(want, listIds));
      expect(got.piece).toEqual(want.piece);
    };

    let want = sliced(reference, store => store.slice(reference.base, reach));
    expect([want.slice.from, want.slice.to]).toEqual([S, S + 1]);
    expect(want.cost).toMatchObject({ runsDecoded: 1, runsRendered: 0, rowsWritten: 0 });
    // The slice's own three statements: its styles, its list by id, the model's ids.
    expect([want.lists, want.styles]).toEqual([2, 1]);

    // (i) Before the slice: two runs of the first page.
    let rows = before.map(place => lose(lost.storage, base, place));
    let got = sliced(lost, store => store.slice(base, reach));
    same(got.slice, want.slice);
    expect(stored(before)).toEqual(rows);
    // Each is decoded and rendered alone, and the version is not keyed again.
    expect(got.cost).toMatchObject({ runsDecoded: 1 + 2, runsRendered: 2, rowsWritten: 2 });
    expect([got.lists, got.styles]).toEqual([want.lists + 1, 2]);

    // (ii) The slice's own run as well: decoded for its rendering and once more for the piece.
    rows = [...before, S].map(place => lose(lost.storage, base, place));
    got = sliced(lost, store => store.slice(base, reach));
    same(got.slice, want.slice);
    expect(stored([...before, S])).toEqual(rows);
    expect(got.cost).toMatchObject({ runsDecoded: 1 + 3, runsRendered: 3, rowsWritten: 3 });
    expect([got.lists, got.styles]).toEqual([want.lists + 2, 2]);

    // (iv) The child of that slice reads as the whole tab's result, in both stores.
    let result = whole(tab, requests);
    if ("refused" in result) throw new Error(result.refused.message);
    let children = [[lost, got.slice] as const, [reference, want.slice] as const].map(([of, slice]) => {
      let made = applied(of.store, slice, requests) as AppliedSlice;
      return of.store.markdown(of.store.putSlice(made.slice, made.made));
    });
    expect(children[0]).toBe(result.markdown);
    expect(children[1]).toBe(result.markdown);

    // (iii) A widening over the same two runs.
    let edge = new SliceEdgeError("before", starts[S] - 1);
    let wider = sliced(reference, store => store.widen(reference.base, { from: S, to: S + 1 }, edge));
    expect([wider.slice.from, wider.slice.to]).toEqual([S - 1, S + 1]);
    expect([wider.lists, wider.styles]).toEqual([2, 1]);
    rows = before.map(place => lose(lost.storage, base, place));
    got = sliced(lost, store => store.widen(base, { from: S, to: S + 1 }, edge));
    same(got.slice, wider.slice);
    expect(stored(before)).toEqual(rows);
    expect(got.cost).toMatchObject({ runsDecoded: 2 + 2, runsRendered: 2, viewWidenings: 1 });
    expect([got.lists, got.styles]).toEqual([wider.lists + 1, 2]);
  });

  it("a run with no stored rendering is rendered with the carry into it, where the carry shows", () => {
    // Numbered footnotes: a run's key and Markdown move with the carry it is rendered with.
    let tab = asFetched(largeTabs(20).find(({ name }) => name === "paragraphs with footnotes")!.tab);
    let { reference, lost } = keptTwice(tab, RUNS_OF_THREE);
    let { base } = lost;
    let starts = runStarts(lost.storage, base);
    let runs = starts.length - 1;
    let listIds = Object.keys(tab.lists);
    // Whether the run at each place shows a footnote's number, by its stored summary.
    let noted = Array.from({ length: runs }, (_, place) =>
      (JSON.parse(renderingAt(lost.storage, base, place).row.summary) as { run: RunSummary })
        .run.numberedFootnotes > 0);
    let middle = Math.floor(runs / 2);
    let notedFrom = (place: number) => noted.indexOf(true, place);

    let cases: { name: string; lose: number[]; reach: (s: number) => BatchReach; at: number; runs: number }[] = [];
    // (v) Two such runs before a slice in the tab's middle, not next to each other.
    let first = notedFrom(2), second = notedFrom(first + 2);
    cases.push({
      name: "two runs before the slice", lose: [first, second], at: middle, runs: 1,
      reach: s => stretchReach(lost.storage, base, s, s + 1, starts),
    });
    // (vi) The run directly before the slice, taken for the element before a bulleted range.
    let behind = notedFrom(middle);
    cases.push({
      name: "the run taken for behind", lose: [behind], at: behind + 1, runs: 2,
      reach: s => ({ from: starts[s], to: starts[s], behind: [starts[s]] }),
    });
    // (vii) The second run of a slice of three, rendered with the other side's carry.
    let inside = notedFrom(middle + 3);
    cases.push({
      name: "the second run of a slice of three", lose: [inside], at: inside - 1, runs: 3,
      reach: s => stretchReach(lost.storage, base, s, s + 3, starts),
    });

    for (let { name, lose: places, reach, at, runs: held } of cases) {
      expect(places.every(place => place > 0 && noted[place]), name).toBe(true);
      expect(places.every(place => place < at + held), name).toBe(true);
      let want = sliced(reference, store => store.slice(reference.base, reach(at)));
      expect(want.slice.to - want.slice.from, name).toBe(held);
      let rows = places.map(place => lose(lost.storage, base, place));
      let got = sliced(lost, store => store.slice(base, reach(at)));
      expect(facts(got.slice, listIds), name).toEqual(facts(want.slice, listIds));
      expect(got.slice.piece, name).toEqual(want.slice.piece);
      expect(places.map(place => renderingAt(lost.storage, base, place).row), name).toEqual(rows);
      // A run rendered with the wrong carry comes to another key, and the version is keyed again.
      let inSlice = places.filter(place => place >= got.slice.from).length;
      expect(got.cost, name).toMatchObject({
        runsDecoded: held + places.length, runsRendered: places.length, rowsWritten: places.length,
      });
      expect(inSlice, name).toBe(name === "two runs before the slice" ? 0 : 1);
      // A text change in the slice's last run reads as the whole tab's result.
      let requests = typed(starts[got.slice.to - 1]);
      let result = whole(tab, requests);
      if ("refused" in result) throw new Error(result.refused.message);
      let made = applied(lost.store, got.slice, requests) as AppliedSlice;
      expectReadsAs(lost.store, lost.store.putSlice(made.slice, made.made), result, () => name);
    }
  });

  it("widening decodes again and counts", () => {
    let tab = asFetched(linesTab(30));
    let { storage, store, base } = kept(tab, RUNS_OF_THREE);
    let starts = runStarts(storage, base);
    let lengths = runLengths(storage, base);
    let runs = lengths.length;
    let bounds = [0];
    for (let length of lengths) bounds.push(bounds.at(-1)! + length);
    let exact = applyDocsRequests(tab, []).body.content;
    const K = 5;

    for (let [side, reads] of [
      // A deletion into the run after, and one from the run before, each after a change in hand.
      ["after", deleteRange(starts[K] + 30, starts[K + 1] + 7 + 3)],
      ["before", deleteRange(starts[K] - 3, starts[K] + 30)],
    ] as const) {
      let slice = store.slice(base, stretchReach(storage, base, K, K + 1, starts));
      let edge: unknown;
      try {
        applyDocsRequestsToSlice(slice.piece, [insertText(starts[K] + 1, "CHANGED"), reads]);
      } catch (thrown) {
        edge = thrown;
      }
      if (!(edge instanceof SliceEdgeError)) throw new Error(`no edge ${side} the slice`);
      expect(edge.side).toBe(side);
      // The attempt changed the piece it was handed.
      expect(JSON.stringify(slice.piece.content)).toContain("CHANGED");
      let wider!: DocSlice;
      let cost = spent(() => {
        wider = store.widen(base, { from: slice.from, to: slice.to }, edge as SliceEdgeError);
      });
      let [from, to] = side === "after" ? [K, K + 2] : [K - 1, K + 1];
      expect([wider.from, wider.to]).toEqual([from, to]);
      // From the stored runs: nothing of the failed attempt.
      expect(wider.piece.content).toEqual(exact.slice(bounds[from], bounds[to]));
      expect(wider.piece.origin).toBe(starts[from]);
      expect(cost).toMatchObject({ viewWidenings: 1, runsDecoded: 2, runsRendered: 0, rowsWritten: 0 });
    }

    // A read before the slice widens in one step to the run its index is in, however far back.
    expect(K - 3).toBeGreaterThan(0);
    for (let [index, from] of [
      [starts[K - 3] + 1, K - 3], [-1, 0], [starts[K] + 5, K - 1],
    ] as const) {
      let wider!: DocSlice;
      let cost = spent(() => {
        wider = store.widen(base, { from: K, to: K + 1 }, new SliceEdgeError("before", index));
      });
      expect([wider.from, wider.to], `before, at ${index}`).toEqual([from, K + 1]);
      expect(wider.piece.content).toEqual(exact.slice(bounds[from], bounds[K + 1]));
      expect(wider.piece.origin).toBe(starts[from]);
      expect(cost).toMatchObject({ viewWidenings: 1, runsDecoded: K + 1 - from, rowsWritten: 0 });
    }

    // Widened to both ends, each from the places the one before answered, it holds every run.
    let low = store.widen(base, { from: K, to: K + 1 }, new SliceEdgeError("before", -1));
    let all = store.widen(
      base, { from: low.from, to: low.to }, new SliceEdgeError("after", starts[runs] + 5));
    expect([all.from, all.to, all.piece.first, all.piece.last]).toEqual([0, runs, true, true]);
    expect(all.piece.content).toEqual(exact);

    // No run on the error's side: the error it was given, the same object, and no run read.
    for (let [held, edge] of [
      [{ from: 0, to: 3 }, new SliceEdgeError("before", 0)],
      [{ from: 4, to: runs }, new SliceEdgeError("after", starts[runs])],
    ] as const) {
      let thrown: unknown;
      let cost = spent(() => {
        try {
          store.widen(base, held, edge);
        } catch (caught) {
          thrown = caught;
        }
      });
      expect(thrown).toBe(edge);
      expect(cost).toMatchObject({ runsDecoded: 0, viewWidenings: 0 });
    }
  });

  it("for an edge after the slice the index is a guess, both ways", () => {
    // Runs of a paragraph or two (161 indexes each), and a one-run table after the fifteenth.
    let tab = asFetched(linesTab(60, [15]));
    let { storage, store, base } = kept(tab, RUNS_OF_THREE);
    let starts = runStarts(storage, base);
    let sizes = runSizes(storage, base);

    // OVER: after a long insertion the index falls, by stored sizes, runs past the one read.
    const K = 35;
    // From there on each run is one paragraph, 161 indexes.
    expect(sizes.slice(K, K + 14).every(size => size === 161)).toBe(true);
    let written = starts[K + 1] + 1 + 2_000;
    let over = [insertText(starts[K] + 1, "x".repeat(2_000)), insertText(written, "Y")];
    // The written index, placed in the stored sizes: twelve runs past the one it is in.
    let last = placeOf(starts, written);
    expect(last).toBe(K + 1 + 12);
    let made!: ReturnType<typeof applied>;
    let cost = spent(() => {
      made = applied(store, store.slice(base, stretchReach(storage, base, K, K + 1, starts)), over);
    });
    if ("refused" in made) throw new Error(made.refused.message);
    expect([made.slice.from, made.slice.to, made.widenings]).toEqual([K, last + 1, 1]);
    // The first slice's run, and the fourteen of the widening, of which the batch reads two.
    expect(cost).toMatchObject({ viewWidenings: 1, runsDecoded: 1 + (last - K + 1) });
    let result = whole(tab, over);
    if ("refused" in result) throw new Error(result.refused.message);
    expectReadsAs(store, store.putSlice(made.slice, made.made), result, () => "over");

    // SHORT: after a deletion the index falls short of the run the batch reads: two widenings.
    const T = sizes.indexOf(16) - 1;
    expect(T).toBeGreaterThan(2);
    expect(sizes[T]).toBeGreaterThan(150);
    let short = [
      deleteRange(starts[T] + 20, starts[T] + 120), insertText(starts[T + 2] + 1 - 100, "Y"),
    ];
    expect(placeOf(starts, starts[T + 2] + 1 - 100)).toBe(T);
    let again!: ReturnType<typeof applied>;
    cost = spent(() => {
      again = applied(store, store.slice(base, stretchReach(storage, base, T, T + 1, starts)), short);
    });
    if ("refused" in again) throw new Error(again.refused.message);
    expect([again.slice.from, again.slice.to, again.widenings]).toEqual([T, T + 3, 2]);
    expect(cost).toMatchObject({ viewWidenings: 2, runsDecoded: 1 + 2 + 3 });
    expectReadsAs(store, store.putSlice(again.slice, again.made), wholeTab(tab, short), () => "short");
  });
});

/** A batch through the store as its caller makes it. A refusal is thrown as a failure. */
function through(store: DocStore, version: DocVersion, requests: readonly GoogleDocsRequest[]) {
  let made = applied(store, store.slice(version, batchReach(requests)), requests);
  if ("refused" in made) throw new Error(`refused: ${made.refused.message}`);
  return { ...made, child: store.putSlice(made.slice, made.made) };
}

/** What the whole tab gives for a batch it takes. */
function wholeTab(tab: GoogleDocsTab, requests: readonly GoogleDocsRequest[]) {
  let result = whole(tab, requests);
  if ("refused" in result) throw new Error(`refused: ${result.refused.message}`);
  return result;
}

/** THE MODEL'S OWN CUT of `child` from `from`, against its list, to where both cuts end a run after `after`. */
function ownCut(
  storage: FakeDocStorage, child: DocVersion, sizes: RunSizes, after: number, from = 0, footnotes = 0,
) {
  let rows = storage.sql.exec<{ run: string; size: number }>(
    "SELECT run, size FROM doc_seq WHERE version = ? AND seq >= ? ORDER BY seq", child.id, from).toArray();
  let { before, total } = storage.sql.exec<{ before: number; total: number }>(
    `SELECT COALESCE(SUM(CASE WHEN seq < ?2 THEN size END), 0) AS before, SUM(size) AS total
     FROM doc_seq WHERE version = ?1`, child.id, from).one();
  let first = child.bodyEndIndex - total + before;
  // How many elements the child's runs decoded so far hold, after each.
  let bounds: number[] = [];
  let notes = footnotes;
  function* elements(): Generator<StructuralElement> {
    for (let row of rows) {
      let decoded = decodeRun(
        storage.sql.exec<{ json: string }>("SELECT json FROM doc_run WHERE id = ?", row.run).one().json,
        { first, footnotes: notes, exact: true })!;
      first += row.size;
      notes += decoded.footnotes;
      bounds.push((bounds.at(-1) ?? 0) + decoded.elements.length);
      yield* decoded.elements;
    }
  }
  let own: { run: string; size: number }[] = [];
  let cut = 0, ended = rows.length;
  for (let run of cutRuns(elements(), sizes, footnotes)) {
    own.push({ run: runId(run.json), size: run.size });
    cut += run.elements.length;
    let place = bounds.indexOf(cut);
    if (place >= 0 && from + place + 1 >= after) {
      ended = place + 1;
      break;
    }
  }
  return { listed: rows.slice(0, ended), own };
}

/** How many of `runs` are not among `others`, by name. */
function notAmong(runs: readonly { run: string }[], others: readonly { run: string }[]): number {
  let names = new Set(others.map(({ run }) => run));
  return runs.filter(({ run }) => !names.has(run)).length;
}

/** The id of the context row `version` names. */
const contextOf = (storage: FakeDocStorage, version: DocVersion) =>
  storage.sql.exec<{ context: string }>(
    "SELECT context FROM doc_version WHERE doc = ? AND id = ?", version.doc, version.id).one().context;

/** The JSON of the content row `id`. */
const contentOf = (storage: FakeDocStorage, id: string) =>
  storage.sql.exec<{ json: string }>("SELECT json FROM doc_run WHERE id = ?", id).one().json;

describe("the version a slice gives", () => {
  it("a footnote reference deleted in the first run renumbers the later runs, which keep their names", () => {
    let tab = asFetched(buildTab(Array.from({ length: 12 }, (_, at) =>
      ({ runs: [`Line ${at}`, footnote(at + 1), ".\n"] }))));
    let { storage, store, base } = kept(tab, RUNS_OF_THREE);
    let reference = applyDocsRequests(tab, []).body.content[1].paragraph!.elements
      .find(element => element.footnoteReference)!;
    let requests = [deleteRange(reference.startIndex, reference.endIndex)];
    let result = wholeTab(tab, requests);
    let made!: ReturnType<typeof through>;
    let cost = spent(() => {
      made = through(store, base, requests);
    });
    expect([made.slice.from, made.slice.to, made.made.footnotesMoved]).toEqual([0, 1, true]);
    let before = listed(storage, base), after = listed(storage, made.child);
    let later = before.length - 1;
    expect(later).toBeGreaterThan(2);
    // No later run is stored again: each keeps its name under another carry key.
    expect(after.slice(-later).map(({ run, size }) => [run, size]))
      .toEqual(before.slice(1).map(({ run, size }) => [run, size]));
    expect(after.slice(-later).every((row, at) => row.carry !== before[1 + at].carry)).toBe(true);
    // The carry is never the parent's again: every later run is keyed and rendered again.
    let cut = after.length - later;
    expect(cost).toMatchObject({
      runsKeyed: later, runsRendered: cut + later, runsDecoded: 1 + later, viewWidenings: 0,
    });
    expectReadsAs(store, made.child, result, () => "the reference deleted");
    expect(store.markdown(made.child)).not.toBe(store.markdown(base));
    expect(result.summary.markdownLength).toBeLessThan(store.summary(base).markdownLength);
  });

  it("a later run with no stored rendering is decoded and rendered where it stands, and is not counted as keyed", () => {
    // Thirty footnoted paragraphs, the first reference deleted: the walk goes to the tab's end.
    let tab = asFetched(buildTab(Array.from({ length: 30 }, (_, at) =>
      ({ runs: [`Line ${at}`, footnote(at + 1), ".\n"] }))));
    let reference = kept(tab, RUNS_OF_THREE), lost = kept(tab, RUNS_OF_THREE);
    let first = applyDocsRequests(tab, []).body.content[1].paragraph!.elements
      .find(element => element.footnoteReference)!;
    let requests = [deleteRange(first.startIndex, first.endIndex)];
    let result = wholeTab(tab, requests);
    let parent = listed(lost.storage, lost.base);
    let later = parent.length - 1;
    // Three later renderings deleted: the walk has no summary to work their keys out of.
    const LOST = [3, 4, 8];
    expect(later).toBeGreaterThan(LOST.at(-1)!);
    for (let place of LOST) {
      let { run, context, carry } = parent[place];
      lost.storage.sql.exec(
        "DELETE FROM doc_md WHERE run = ? AND context = ? AND carry = ?", run, context, carry);
    }
    let want!: ReturnType<typeof through>, made!: ReturnType<typeof through>;
    let intact = spent(() => {
      want = through(reference.store, reference.base, requests);
    });
    let cost = spent(() => {
      made = through(lost.store, lost.base, requests);
    });
    expect([made.slice.from, made.slice.to, made.made.footnotesMoved]).toEqual([0, 1, true]);
    // The child is the one a store with every rendering gives: its name and every key.
    expect(made.child.id).toBe(want.child.id);
    let child = listed(lost.storage, made.child);
    expect(child).toEqual(listed(reference.storage, want.child));
    // Keyed counts the runs whose key was worked out of a stored summary.
    let cut = child.length - later;
    expect(intact).toMatchObject({
      runsKeyed: later, runsRendered: cut + later, runsDecoded: 1 + later, viewWidenings: 0,
    });
    expect(cost).toMatchObject({
      runsKeyed: later - LOST.length, runsRendered: cut + later, runsDecoded: 1 + later, viewWidenings: 0,
    });
    expect([later, cut]).toEqual([24, 1]);
    expectReadsAs(lost.store, made.child, result, () => "three renderings lost after the slice");
  });

  it("the child lists every untouched run as it was, and none of them is read", () => {
    let tab = asFetched(linesTab(1_300));
    let { storage, base } = kept(tab, ONE_EACH);
    let counted = countedStorage(storage);
    let store = new DocStore(counted.storage, undefined, undefined, ONE_EACH);
    let starts = runStarts(storage, base);
    const S = 650;
    // One replacement in the paragraph of a middle run.
    let requests = [deleteRange(starts[S] + 5, starts[S] + 10), insertText(starts[S] + 5, "replaced")];
    let result = wholeTab(tab, requests);
    let made!: ReturnType<typeof through>;
    let cost = spent(() => {
      made = through(store, base, requests);
    });
    expect([made.slice.from, made.slice.to, made.widenings]).toEqual([S, S + 1, 0]);

    let parent = listed(storage, base), child = listed(storage, made.child);
    expect(child).toHaveLength(parent.length);
    expect(child.slice(0, S)).toEqual(parent.slice(0, S));
    expect(child.slice(S + 1)).toEqual(parent.slice(S + 1));
    expect(child[S].run).not.toBe(parent[S].run);
    expect(child[S].size).toBe(parent[S].size + 3);
    // No later run is keyed: after a paragraph outside a list the carry is the parent's again.
    expect(cost).toMatchObject({ runsDecoded: 1, runsRendered: 1, runsKeyed: 0 });
    // Every statement that reads the list is an aggregate, a page or a copy inside storage.
    let reading = counted.ran().filter(statement => /\bdoc_seq\b/.test(statement));
    expect(reading.length).toBeGreaterThanOrEqual(5);
    for (let statement of reading) {
      expect(
        /\b(COUNT|SUM)\(/.test(statement) || /LIMIT \?/.test(statement) ||
        /^INSERT OR REPLACE INTO doc_seq [^]*\bSELECT\b/.test(statement),
        statement).toBe(true);
    }
    expectReadsAs(store, made.child, result, () => "one replacement");
  });

  /** How many rows `table` holds. */
  const rowsIn = (storage: FakeDocStorage, table: string) =>
    storage.sql.exec<{ rows: number }>(`SELECT COUNT(*) AS rows FROM ${table}`).one().rows;

  it("a batch that makes a list gives the child its own context", () => {
    // A model list in a later run, a Google list, and named styles the child's context must hold.
    let tab = asFetched({
      ...buildTab(
        Array.from({ length: 14 }, (_, at) => at === 11 ? item(`Item ${at}.`, "model.1") : para(`Line ${at}.`)),
        { "kix.one": BULLET_LIST.L1, "model.1": NUMBERED_LIST.N1 }),
      namedStyles: { styles: [{ namedStyleType: "SUBTITLE", textStyle: { italic: true } }] },
    });
    let { storage, base } = kept(tab, RUNS_OF_THREE);
    // The content rows read whole, by id.
    let read: unknown[] = [];
    let store = new DocStore(observing(storage, (query, bindings) => {
      if (query.startsWith("SELECT json FROM doc_run")) read.push(bindings[0]);
    }), undefined, undefined, RUNS_OF_THREE);
    let context = contextOf(storage, base);
    let paragraph = applyDocsRequests(tab, []).body.content[6];

    // A batch that makes none: the child's context is its parent's row, which is not read whole.
    let plain = through(store, base, typed(paragraph.startIndex));
    expect(plain.made.lists).toEqual([]);
    expect(contextOf(storage, plain.child)).toBe(context);
    expect(read).not.toContain(context);

    let requests = [bullets(paragraph.startIndex, paragraph.endIndex, BULLETED)];
    let result = wholeTab(tab, requests);
    let made = through(store, base, requests);
    // The lowest id the WHOLE tab does not define, though the slice's runs name no list.
    expect(made.made.lists).toEqual(["model.2"]);
    let own = contextOf(storage, made.child);
    expect(own).not.toBe(context);
    expect(read.filter(id => id === context)).toHaveLength(1);
    let stored = JSON.parse(contentOf(storage, own)) as { lists: object; namedStyles?: unknown };
    expect(Object.keys(stored.lists)).toEqual(["kix.one", "model.1", "model.2"]);
    expect(stored.namedStyles).toEqual(tab.namedStyles);
    // It is the row a cut of the whole tab's result writes.
    let other = fakeDocStorage();
    let whole = new DocStore(other, undefined, undefined, RUNS_OF_THREE).putTab(DOC, result.tab, []);
    expect(contextOf(other, whole)).toBe(own);
    expect(contentOf(other, own)).toBe(contentOf(storage, own));
    // No later run's context key moved.
    let parent = listed(storage, base), child = listed(storage, made.child);
    let later = parent.length - made.slice.to;
    expect(later).toBeGreaterThan(1);
    expect(child.slice(-later).map(row => row.context)).toEqual(parent.slice(-later).map(row => row.context));
    expect(child.slice(-later).some(row => row.context !== "")).toBe(true);
    expectReadsAs(store, made.child, result, () => "a list made");
  });

  it("every run cut from a slice is rendered, and one the batch did not change writes no row", () => {
    // A run an element, so the cut gives each element the batch left alone back as it was.
    let tab = asFetched(buildTab(Array.from({ length: 12 }, (_, at) => para(`Line ${at}.`))));
    let { storage, store, base } = kept(tab, ONE_EACH);
    let starts = runStarts(storage, base);
    let parent = listed(storage, base);
    const S = 6;
    let tables = () => [rowsIn(storage, "doc_run"), rowsIn(storage, "doc_md")];

    // (i) Two runs, the first taken for the element before a bulleted range.
    let before = tables();
    let made!: ReturnType<typeof through>;
    let cost = spent(() => {
      made = through(store, base, [bullets(starts[S], starts[S + 1], BULLETED)]);
    });
    expect([made.slice.from, made.slice.to, made.widenings]).toEqual([S - 1, S + 1, 0]);
    let child = listed(storage, made.child);
    expect(child[S - 1]).toEqual(parent[S - 1]);
    expect(child[S].run).not.toBe(parent[S].run);
    // Both rendered; written: the changed run's content and rendering, and the list's context.
    expect(cost).toMatchObject({ runsRendered: 2, runsDecoded: 2 });
    expect(tables()).toEqual([before[0] + 2, before[1] + 1]);

    // (ii) A style-only batch handed three runs that changes the middle one alone.
    before = tables();
    cost = spent(() => {
      let slice = store.slice(base, stretchReach(storage, base, S, S + 3, starts));
      let step = applied(store, slice, [styleText(starts[S + 1] + 1, starts[S + 1] + 4, { bold: true }, "bold")]);
      if ("refused" in step) throw new Error(step.refused.message);
      made = { ...step, child: store.putSlice(step.slice, step.made) };
    });
    child = listed(storage, made.child);
    expect([child[S], child[S + 2]]).toEqual([parent[S], parent[S + 2]]);
    expect(child[S + 1].run).not.toBe(parent[S + 1].run);
    expect(cost).toMatchObject({
      runsRendered: 3, runsDecoded: 3, runsKeyed: 0, rowsWritten: 1 + 1 + parent.length + 1,
    });
    expect(tables()).toEqual([before[0] + 1, before[1] + 1]);
  });

  const append = (tabId: string): QueuedDocRecord => ({
    id: 1,
    action: { type: "appendText", markdown: "More", tabId, markdownVersion: MARKDOWN_RENDERING_VERSION },
  });
  /** What a replay refuses an append to `version` with, where it does. */
  const refusalOf = (store: DocStore, version: DocVersion) =>
    createSimulationStore(docTabReducer(store)).fold(version.tabId, version, [append(version.tabId)])
      .refused.map(({ refusal }) => refusal);
  const UNINDEXED = [{ reason: unindexedTabRefusal("appendText").message, unindexed: true }];

  // The precondition of the kept context keys, which no statement checks.
  describe("a list the batch makes is named by no run outside the slice", () => {
    /** Paragraphs whose last is an item of `model.1`, with the lists given. */
    let named = (lists: GoogleDocsTab["lists"]) => asFetched(buildTab(
      [...Array.from({ length: 8 }, (_, at) => para(`Line ${at}.`)), item("Last.", "model.1")], lists));
    let numbered = (tab: GoogleDocsTab) => {
      let paragraph = applyDocsRequests(tab, []).body.content[1];
      return [bullets(paragraph.startIndex, paragraph.endIndex, NUMBERED)];
    };

    it("a fetched tab that names such a list with no definition takes no edit", () => {
      let { storage, store, base } = kept(named({ "kix.one": BULLET_LIST.L1 }), RUNS_OF_THREE);
      let lengths = runLengths(storage, base);
      expect(lengths.length).toBeGreaterThanOrEqual(3);
      expect(store.unindexed(base)).toBe(true);
      // So no slice of it is asked for.
      expect(refusalOf(store, base)).toEqual(UNINDEXED);
    });

    it("the same tab taken at its word as the model's own shows what the condition keeps out", () => {
      // `putTab` takes a tab at its word; a fetched one never reaches here.
      let tab = throughJson(applyDocsRequests(named({ "kix.one": BULLET_LIST.L1 }), []));
      markModelIndexed(tab);
      let store = new DocStore(fakeDocStorage(), undefined, undefined, RUNS_OF_THREE);
      let version = store.putTab(DOC, tab, []);
      expect(version.exact).toBe(true);
      let requests = numbered(tab);
      let result = wholeTab(tab, requests);
      let made = through(store, version, requests);
      // The id minted is one the last run names, so the child keeps that run's old rendering.
      expect(made.made.lists).toEqual(["model.1"]);
      expect(made.slice.to).toBeLessThan(3);
      expect(store.markdown(made.child)).not.toBe(result.markdown);
    });

    it("on a tab that is followed, the child of a batch that makes a list is the whole tab's", () => {
      let tab = named({ "kix.one": BULLET_LIST.L1, "model.1": BULLET_LIST.L1 });
      let large = listedTablesTab(TAB, 600);
      for (let [name, source, requests, minted] of [
        ["the fetched tab with the list defined", tab, numbered(tab), "model.2"],
        ["a tab of 600 lists", large, [bullets(1, 2, NUMBERED)], "model.1"],
      ] as const) {
        let { storage, base } = kept(source, name.startsWith("a tab") ? undefined : RUNS_OF_THREE);
        let counted = countedStorage(storage);
        let store = new DocStore(
          counted.storage, undefined, undefined, name.startsWith("a tab") ? undefined : RUNS_OF_THREE);
        expect(store.unindexed(base), name).toBe(false);
        let result = wholeTab(source, requests);
        let made!: ReturnType<typeof through>;
        let cost = spent(() => {
          made = through(store, base, requests);
        });
        expect(made.made.lists, name).toEqual([minted]);
        expectReadsAs(store, made.child, result, () => name);
        // Decoded: the slice's runs, once an attempt; no context key moved, no run's JSON stepped.
        expect(cost.runsDecoded, name).toBe(made.slice.to - made.slice.from);
        let parent = listed(storage, base), child = listed(storage, made.child);
        let later = parent.length - made.slice.to;
        expect(child.slice(-later).map(row => [row.run, row.context]), name)
          .toEqual(parent.slice(-later).map(row => [row.run, row.context]));
        expect(counted.ran().filter(statement => statement.includes("json_tree")), name).toEqual([]);
      }
    });

    it("no tab a fetch or an edit stores names a list it does not define under the model's prefix", () => {
      // No real document is refused: Google names no list so, and the model removes no definition.
      let seen = { tabs: 0, minted: 0 };
      let expectDefined = (tab: GoogleDocsTab, where: string) => {
        seen.tabs++;
        for (let id of namedListIds(tab.body.content)) {
          if (!id.startsWith(MODEL_LIST_ID)) continue;
          seen.minted++;
          expect(Object.hasOwn(tab.lists, id), `${where}: ${id}`).toBe(true);
        }
      };
      for (let { name } of readFixtures()) {
        for (let { where, tab, after, requests } of recordedSteps(name)) {
          expectDefined(tab, `${where}, before`);
          expectDefined(pruneTab(throughJson(after)), `${where}, after`);
          let result = requests && whole(tab, requests);
          if (result && "tab" in result) expectDefined(result.tab, `${where}, the model's result`);
        }
      }
      let texts = new Set<string>();
      for (let call of recordedSequenceCalls(20261113, 320, false).calls) {
        // Each tab once: the text of a call opens with its tab's.
        let [tab] = JSON.parse(call.json) as [GoogleDocsTab, GoogleDocsRequest[]];
        let text = JSON.stringify(tab);
        if (texts.has(text)) continue;
        texts.add(text);
        expectDefined(tab, call.where);
      }
      expect(seen.tabs).toBeGreaterThan(1_000);
      expect(seen.minted).toBeGreaterThan(100);
    });
  });

  it("the child carries the identity and the write markers of the version it was made in", () => {
    let markers = [{ writeId: "write-1", id: "kix.marker1" }, { writeId: "write-2", id: "kix.marker2" }];
    let tab = asFetched(linesTab(12));
    let { store, base } = kept(tab, RUNS_OF_THREE, markers);
    expect(base.writeMarkers).toEqual(markers);
    let { child } = through(store, base, typed(1));
    expect(child.id).not.toBe(base.id);
    expect(child.writeMarkers).toEqual(markers);
    expect(tabIdentity(child)).toEqual(tabIdentity(base));
    expect(tabIdentity(child)).toEqual(tabIdentity(tab));
  });

  it("a slice left empty lists no run", () => {
    // A table of one row, alone in its run: its only row deleted, the table goes.
    let tab = asFetched(buildTab([
      para("One."), para("Two."), { table: [["a\n", "b\n"]] }, para("Three."), para("Four."),
    ]));
    let { storage, store, base } = kept(tab, RUNS_OF_THREE);
    let exact = applyDocsRequests(tab, []).body.content;
    let table = exact.find(element => element.table)!;
    let requests = [deleteRow(table.startIndex, 0)];
    let result = wholeTab(tab, requests);
    let made = through(store, base, requests);
    expect(made.slice.to - made.slice.from).toBe(1);
    expect([made.widenings, made.slice.piece.content.length, made.made.moved])
      .toEqual([0, 0, table.startIndex - table.endIndex]);
    expect(listed(storage, made.child)).toHaveLength(listed(storage, base).length - 1);
    expectReadsAs(store, made.child, result, () => "a table deleted");
  });

  it("a slice that is not of its version, and a child of no run, are faults", () => {
    const NOT_OF_VERSION = "A slice does not fit the version it names: its places, its origin or its " +
      "length are not what the version's list of runs gives.";
    const NO_RUN = "An edit would leave its tab a version that lists no run.";
    expect(NO_RUN).not.toBe(NOT_OF_VERSION);
    /** Holds that `put` throws a fault of its caller, with `message`, and that nothing is stored. */
    let expectFault = (
      storage: FakeDocStorage, store: DocStore, version: DocVersion, message: string, put: () => unknown,
      where: string,
    ) => {
      let rows = storage.rows();
      let thrown: unknown;
      let cost = spent(() => {
        try {
          put();
        } catch (caught) {
          thrown = caught;
        }
      });
      expect(thrown, where).toBeInstanceOf(Error);
      expect(thrown, where).not.toBeInstanceOf(DocRowTooLargeError);
      expect(thrown, where).not.toBeInstanceOf(DocRunRenderError);
      expect((thrown as Error).message, where).toBe(message);
      expect(message).not.toBe(DOC_COPY_UNREADABLE);
      // Nothing is stored, and the document's copy is not dropped.
      expect(storage.rows(), where).toEqual(rows);
      expect(store.head(DOC), where).toBeDefined();
      expect(store.markdown(version), where).not.toBe("");
      return cost;
    };

    let tab = asFetched(linesTab(20));
    let { storage, store, base } = kept(tab, RUNS_OF_THREE);
    let starts = runStarts(storage, base);
    let runs = starts.length - 1;
    const S = 4;
    /** A fresh slice of the middle run, and what the model answers for a text change in it. */
    let fresh = () => {
      let made = applied(store, store.slice(base, stretchReach(storage, base, S, S + 1, starts)), typed(starts[S]));
      if ("refused" in made) throw new Error(made.refused.message);
      return made;
    };
    let cases: [string, (made: AppliedSlice) => [DocSlice, AppliedSlice["made"]]][] = [
      ["both places one later", ({ slice, made }) => [{ ...slice, from: S + 1, to: S + 2 }, made]],
      ["both places one earlier", ({ slice, made }) => [{ ...slice, from: S - 1, to: S }, made]],
      ["its end past the version's runs", ({ slice, made }) => [{ ...slice, to: runs + 1 }, made]],
      ["its end alone one later", ({ slice, made }) => [{ ...slice, to: S + 2 }, made]],
      ["its end alone one earlier", ({ slice, made }) => [{ ...slice, to: S }, made]],
      ["moved by one more", ({ slice, made }) => [slice, { ...made, moved: made.moved + 1 }]],
      ["its origin one more", ({ slice, made }) =>
        [{ ...slice, piece: { ...slice.piece, origin: slice.piece.origin + 1 } }, made]],
      ["its origin one less", ({ slice, made }) =>
        [{ ...slice, piece: { ...slice.piece, origin: slice.piece.origin - 1 } }, made]],
    ];
    for (let [name, change] of cases) {
      let [slice, made] = change(fresh());
      // Asked before a row is written.
      let cost = expectFault(storage, store, base, NOT_OF_VERSION, () => store.putSlice(slice, made), name);
      expect(cost.rowsWritten, name).toBe(0);
    }
    // THE PLACES ALONE, where the origin and the length agree with the list.
    let ofLast = applied(store, store.slice(base, stretchReach(storage, base, runs - 1, runs, starts)),
      typed(starts[runs - 1])) as AppliedSlice;
    let ofFirst = applied(store, store.slice(base), typed(1)) as AppliedSlice;
    expect([ofLast.slice.from, ofLast.slice.to, ofFirst.slice.from, ofFirst.slice.to])
      .toEqual([runs - 1, runs, 0, 1]);
    let empty = fresh();
    let places: [string, DocSlice, AppliedSlice["made"]][] = [
      ["of the last run, its end past the version's runs", { ...ofLast.slice, to: runs + 1 }, ofLast.made],
      ["of the first run, its start before the version's runs", { ...ofFirst.slice, from: -1 }, ofFirst.made],
      ["its start past its end",
        { ...empty.slice, from: S + 1, to: S, piece: { ...empty.slice.piece, content: [] } },
        { ...empty.made, moved: 0 }],
    ];
    for (let [name, slice, made] of places) {
      let cost = expectFault(storage, store, base, NOT_OF_VERSION, () => store.putSlice(slice, made), name);
      expect(cost.rowsWritten, name).toBe(0);
    }

    // The slice as it is, is stored.
    let { slice, made } = fresh();
    expect(store.putSlice(slice, made).bodyEndIndex).toBe(base.bodyEndIndex + 1);

    // THE ORIGIN ALONE, on runs of one stored size, where the length agrees with the list.
    let even = kept(asFetched(linesTab(60)), RUNS_OF_THREE);
    let evenStarts = runStarts(even.storage, even.base);
    let evenSizes = runSizes(even.storage, even.base);
    const E = 35;
    expect(new Set(evenSizes.slice(E - 1, E + 2)).size).toBe(1);
    for (let by of [1, -1]) {
      let taken = applied(even.store,
        even.store.slice(even.base, stretchReach(even.storage, even.base, E, E + 1, evenStarts)),
        typed(evenStarts[E])) as AppliedSlice;
      let moved = { ...taken.slice, from: E + by, to: E + 1 + by };
      let cost = expectFault(even.storage, even.store, even.base, NOT_OF_VERSION,
        () => even.store.putSlice(moved, taken.made), `places both moved by ${by} onto a run of the same size`);
      expect(cost.rowsWritten).toBe(0);
    }

    // THE CHILD OF NO RUN, on a tab of one run whose piece is emptied.
    let single = kept(asFetched(buildTab([para("Only.")])));
    expect(runSizes(single.storage, single.base)).toHaveLength(1);
    let only = () => {
      let whole = single.store.slice(single.base);
      let answered = applyDocsRequestsToSlice(whole.piece, []);
      let held = whole.piece.content.at(-1)!.endIndex - whole.piece.origin;
      whole.piece.content.length = 0;
      return { whole, answered, held };
    };
    let emptied = only();
    expect(emptied.held).toBeGreaterThan(0);
    expectFault(single.storage, single.store, single.base, NO_RUN,
      () => single.store.putSlice(emptied.whole, { ...emptied.answered, moved: -emptied.held }), "no run");
    // With `moved` as answered, the sizes refuse it first: the fault of no run is not shadowed.
    emptied = only();
    expectFault(single.storage, single.store, single.base, NOT_OF_VERSION,
      () => single.store.putSlice(emptied.whole, emptied.answered), "emptied, not moved");
  });

  it("a version found stored is answered with nothing rendered", () => {
    let tab = asFetched(linesTab(20));
    let { storage, store, base } = kept(tab, RUNS_OF_THREE);
    let requests = typed(runStarts(storage, base)[4]);
    let first = through(store, base, requests);
    let again!: ReturnType<typeof through>;
    let cost = spent(() => {
      again = through(store, base, requests);
    });
    expect(again.child).toEqual(first.child);
    expect(cost).toMatchObject({ rowsWritten: 0, runsRendered: 0, runsKeyed: 0, runsDecoded: 1 });
  });

  it("a child another digest keyed is keyed again in place", () => {
    let tab = asFetched(linesTab(1_300));
    let { storage, store, base } = kept(tab, ONE_EACH);
    let other = under(storage, "another", ONE_EACH);
    let starts = runStarts(storage, base);
    let requests = typed(starts[650]);
    let result = wholeTab(tab, requests);
    // The other digest keys the base again, and stores the child.
    let theirs = through(other, base, requests).child;
    // 200 keys of the child's list as other code worked them out, each with its rendering.
    storage.sql.exec(
      "UPDATE doc_seq SET carry = 'other ' || seq WHERE version = ? AND seq >= 100 AND seq < 300", theirs.id);
    storage.sql.exec(
      `INSERT INTO doc_md (doc, run, context, carry, made, summary, md)
       SELECT ?2, run, context, carry, 'another', '{}', 'not this code''s' FROM doc_seq
       WHERE version = ?1 AND seq >= 100 AND seq < 300`, theirs.id, theirs.doc);
    let others = () => storage.sql.exec<{ rows: number }>(
      "SELECT COUNT(*) AS rows FROM doc_md WHERE made = 'another'").one().rows;
    expect(others()).toBeGreaterThanOrEqual(200);

    let deletes = 0;
    let counting = new DocStore(observing(storage, query => {
      if (query.startsWith("DELETE FROM doc_md")) deletes++;
    }), undefined, undefined, ONE_EACH);
    // This digest keys the base again (its first slice), then stores the child over the list.
    let slice = counting.slice(base, batchReach(requests));
    let made = applied(counting, slice, requests) as AppliedSlice;
    deletes = 0;
    let child = counting.putSlice(made.slice, made.made);
    // ONE statement for the list: not one a rendering, and none before each run.
    expect(deletes).toBe(1);
    expect(child.id).toBe(theirs.id);
    // The same runs under this code's keys; nothing of the other digest's is left under the list's
    // keys.
    expect(listed(storage, child).map(({ run }) => run)).toEqual(
      [...listed(storage, base).slice(0, 650).map(({ run }) => run), listed(storage, child)[650].run,
        ...listed(storage, base).slice(651).map(({ run }) => run)]);
    expect(listed(storage, child).every(({ carry }) => !carry.startsWith("other"))).toBe(true);
    expect(others()).toBe(0);
    expect(storage.sql.exec<{ made: string }>(
      `SELECT DISTINCT doc_md.made FROM doc_seq JOIN doc_md ON doc_md.doc = ?2 AND doc_md.run = doc_seq.run
         AND doc_md.context = doc_seq.context AND doc_md.carry = doc_seq.carry
       WHERE doc_seq.version = ?1`, child.id, child.doc).toArray()).toEqual([{ made: expect.not.stringMatching(/^another$/) }]);
    expectReadsAs(store, child, result, () => "keyed again");
  });

  it("a rendering another digest made under the key a later run comes to is not this digest's", () => {
    // A reference deleted in the first run: every later run comes to a key the parent lacks.
    let tab = asFetched(buildTab(Array.from({ length: 30 }, (_, at) =>
      ({ runs: [`Line ${at}`, footnote(at + 1), ".\n"] }))));
    let { storage, store, base } = kept(tab, RUNS_OF_THREE);
    let reference = applyDocsRequests(tab, []).body.content[1].paragraph!.elements
      .find(element => element.footnoteReference)!;
    let unnote = deleteRange(reference.startIndex, reference.endIndex);
    // The other digest's child: its renderings stand under the later runs' keys.
    let theirs = through(under(storage, "another", RUNS_OF_THREE), base, [unnote]).child;
    // ANOTHER CHILD deleting the same reference: the same keys, another list.
    let requests = [unnote, insertText(1, "X")];
    let result = wholeTab(tab, requests);
    let taken = applied(store, store.slice(base, batchReach(requests)), requests) as AppliedSlice;
    expect([taken.slice.from, taken.slice.to, taken.made.footnotesMoved]).toEqual([0, 1, true]);
    let later = listed(storage, base).length - 1;
    expect(later).toBeGreaterThanOrEqual(10);
    let child!: DocVersion;
    let cost = spent(() => {
      child = store.putSlice(taken.slice, taken.made);
    });
    expect(child.id).not.toBe(theirs.id);
    expect(listed(storage, child).slice(-later).map(({ run, context, carry }) => [run, context, carry]))
      .toEqual(listed(storage, theirs).slice(-later).map(({ run, context, carry }) => [run, context, carry]));
    // Each later run is rendered again over the other digest's row; a read of the child renders
    // nothing.
    let cut = listed(storage, child).length - later;
    expect(cost).toMatchObject({ runsRendered: cut + later, runsKeyed: later });
    let renderings = storage.sql.exec<{ made: string }>(
      `SELECT doc_md.made FROM doc_seq JOIN doc_md ON doc_md.doc = ?2 AND doc_md.run = doc_seq.run
         AND doc_md.context = doc_seq.context AND doc_md.carry = doc_seq.carry
       WHERE doc_seq.version = ?1`, child.id, child.doc).toArray();
    expect(renderings).toHaveLength(cut + later);
    expect(renderings.filter(({ made }) => made === "another")).toEqual([]);
    expect(spent(() => expectReadsAs(store, child, result, () => "rendered again")))
      .toMatchObject({ runsRendered: 0 });
  });

  it("a version is named as its runs' names pass", () => {
    // `runId` of the document, its small data, its context's name and its runs' names.
    let named = (storage: FakeDocStorage, version: DocVersion) => {
      let { context, meta } = storage.sql.exec<{ context: string; meta: string }>(
        "SELECT context, meta FROM doc_version WHERE doc = ? AND id = ?", version.doc, version.id).one();
      let runs = listed(storage, version).map(({ run }) => run);
      expect(version.id).toBe(runId(JSON.stringify([version.doc, JSON.parse(meta), context, runs])));
      return runs.length;
    };
    let storage = fakeDocStorage();
    let store = new DocStore(storage);
    let one = buildTab([para("Only.")]);
    expect(named(storage, store.putTab(DOC, one, []))).toBe(1);
    let few = kept(asFetched(linesTab(20)), RUNS_OF_THREE);
    expect(named(few.storage, few.base)).toBeGreaterThan(5);
    let large = listedTablesTab(TAB, 600);
    let many = kept(large);
    expect(named(many.storage, many.base)).toBe(1_201);
    let starts = runStarts(many.storage, many.base);
    let child = through(many.store, many.base, [insertText(cellStart(starts[701]), "X")]).child;
    expect(named(many.storage, child)).toBe(1_201);

    // Where the cuts agree (one run), the child a slice names is the version a cut names.
    let single = kept(asFetched(one));
    let edited = through(single.store, single.base, typed(1)).child;
    expect(named(single.storage, edited)).toBe(1);
    let second = new DocStore(fakeDocStorage());
    expect(second.putTab(DOC, single.store.tab(edited), []).id).toBe(edited.id);
  });
});

/** Fourteen paragraphs with named styles, an item of Google's list and one of the model's, kept. */
function listed14() {
  let tab = asFetched({
    ...buildTab(
      Array.from({ length: 14 }, (_, at) => at === 4 ? item(`Item ${at}.`, "kix.one")
        : at === 11 ? item(`Item ${at}.`, "model.1") : para(`Line ${at}.`)),
      { "kix.one": BULLET_LIST.L1, "model.1": NUMBERED_LIST.N1 }),
    namedStyles: { styles: [{ namedStyleType: "SUBTITLE", textStyle: { italic: true } }] },
  });
  let all = kept(tab, RUNS_OF_THREE);
  let starts = runStarts(all.storage, all.base);
  let first = applyDocsRequests(tab, []).body.content[5];
  expect(first.paragraph?.bullet?.listId).toBe("kix.one");
  let place = placeOf(starts, first.startIndex);
  expect(place).toBeGreaterThan(0);
  expect(place).toBeLessThan(starts.length - 3);
  return {
    ...all, tab, starts, place, context: contextOf(all.storage, all.base),
    runs: listed(all.storage, all.base).map(({ run }) => run), edit: typed(first.startIndex),
  };
}
type Kept = ReturnType<typeof listed14>;

/** Removes the content row `id`. */
const lose = (storage: FakeDocStorage, id: string) => {
  storage.sql.exec("DELETE FROM doc_run WHERE id = ?", id);
};
/** Writes `json` over the content row `id`. */
const rewrite = (storage: FakeDocStorage, id: string, json: string) => {
  storage.sql.exec("UPDATE doc_run SET json = ? WHERE id = ?", json, id);
};

/** Removes the record of the version kept, and leaves its list. */
const loseRecord = ({ storage, base }: Pick<Kept, "storage" | "base">) => {
  storage.sql.exec("DELETE FROM doc_version WHERE doc = ? AND id = ?", base.doc, base.id);
};
/** Whether the breakage `name` took the record or the list a drop finds a version's rows by. */
const leavesOrphans = (name: string) => name.startsWith("the version's");

/** What can be wrong with a context's row, by name. */
const CONTEXTS: [string, (kept: Pick<Kept, "storage" | "context">) => void][] = [
  ["the context gone", ({ storage, context }) => lose(storage, context)],
  ["the context not JSON", ({ storage, context }) => rewrite(storage, context, "not JSON {")],
  ["the context's lists not a record", ({ storage, context }) => rewrite(storage, context, '{"lists":5}')],
  ["the context a list", ({ storage, context }) => rewrite(storage, context, "[1,2]")],
];

/** Holds that `run` finds the copy unreadable, drops it, and leaves no row (but `orphans`). */
function expectUnreadable(
  storage: FakeDocStorage, store: DocStore, run: () => unknown, where: string, orphans = false,
) {
  expect(store.head(DOC), where).toBeDefined();
  let before = new Set(Object.values(storage.rows()).flat().map(row => JSON.stringify(row)));
  let thrown: unknown;
  try {
    run();
  } catch (caught) {
    thrown = caught;
  }
  expect(thrown, where).toBeInstanceOf(Error);
  expect((thrown as Error).message, where).toBe(DOC_COPY_UNREADABLE);
  expect(store.head(DOC), where).toBeUndefined();
  let { doc_format: _format, ...rows } = storage.rows();
  let left = Object.values(rows).flat();
  expect(left.filter(row => !before.has(JSON.stringify(row))), where).toEqual([]);
  if (!orphans) expect(left, where).toEqual([]);
}

// A row that cannot be read back under `slice`, `widen`, `putSlice` and `unindexed` is the copy
// found unreadable, never a fault of the caller.
describe("a row lost under a slice", () => {
  it("a run or a context lost under a slice or a widening is the copy unreadable", () => {
    let breaks: [string, (kept: Kept) => void][] = [
      ["the slice's run gone", ({ storage, runs, place }) => lose(storage, runs[place])],
      ["the slice's run not a run", ({ storage, runs, place }) => rewrite(storage, runs[place], "not JSON {")],
      ["the slice's run of no element", ({ storage, runs, place }) => rewrite(storage, runs[place], "[]")],
      // The list stands and its record does not: nothing says what the version is keyed under.
      ["the version's record gone", loseRecord],
      ...CONTEXTS,
      ["the named styles not a record", ({ storage, context, tab }) =>
        rewrite(storage, context, JSON.stringify({ lists: tab.lists, namedStyles: 5 }))],
      // The slice's run names the list: its definition is asked for by id.
      ["a definition of the slice's not a record", ({ storage, context }) =>
        rewrite(storage, context, '{"lists":{"kix.one":5,"model.1":{}}}')],
    ];
    for (let [name, broken] of breaks) {
      let made = listed14();
      // Whole, the slice is read: the breakage is what the call fails on.
      expect(Object.keys(made.store.slice(made.base, batchReach(made.edit)).piece.lists))
        .toEqual(["kix.one", "model.1"]);
      broken(made);
      expectUnreadable(
        made.storage, made.store, () => made.store.slice(made.base, batchReach(made.edit)), `slice, ${name}`,
        leavesOrphans(name));
    }
    // A widening reads the run it adds and the shared data, and nothing on the other side.
    let widened: [string, (kept: Kept) => void, ("before" | "after")?][] = [
      ["the run after gone", ({ storage, runs, place }) => lose(storage, runs[place + 1]), "after"],
      ["the run before gone", ({ storage, runs, place }) => lose(storage, runs[place - 1]), "before"],
      ["the slice's run of no element", ({ storage, runs, place }) => rewrite(storage, runs[place], "[]")],
      ["the version's record gone", loseRecord],
      ...CONTEXTS,
    ];
    for (let [name, broken, only] of widened) {
      for (let side of ["before", "after"] as const) {
        let made = listed14();
        let { place, starts } = made;
        let edge = new SliceEdgeError(side, side === "before" ? starts[place] - 1 : starts[place + 1]);
        let { from, to } = made.store.slice(made.base, batchReach(made.edit));
        broken(made);
        let widen = () => made.store.widen(made.base, { from, to }, edge);
        if (only === undefined || only === side) {
          expectUnreadable(made.storage, made.store, widen, `widen ${side}, ${name}`, leavesOrphans(name));
        } else {
          let wider = widen();
          expect([wider.from, wider.to], `widen ${side}, ${name}`)
            .toEqual(side === "before" ? [from - 1, to] : [from, to + 1]);
        }
      }
    }
  });

  it("a row lost before a slice is stored is the copy unreadable, and nothing of the child is left", () => {
    let numbered = (made: Kept) => {
      let paragraph = applyDocsRequests(made.tab, []).body.content[8];
      return [bullets(paragraph.startIndex, paragraph.endIndex, NUMBERED)];
    };
    let cases: [string, (made: Kept) => GoogleDocsRequest[], (kept: Kept) => void][] = [
      ["the version's record gone", made => made.edit, loseRecord],
      ["the version's list gone", made => made.edit, ({ storage, base }) => {
        storage.sql.exec("DELETE FROM doc_seq WHERE version = ?", base.id);
      }],
      // A batch that makes a list reads the context whole.
      ...CONTEXTS.map(([name, broken]): [string, (made: Kept) => GoogleDocsRequest[], (kept: Kept) => void] =>
        [`${name}, under a batch that makes a list`, numbered, broken]),
    ];
    for (let [name, requests, broken] of cases) {
      let made = listed14();
      let batch = requests(made);
      let taken = applied(made.store, made.store.slice(made.base, batchReach(batch)), batch) as AppliedSlice;
      if (batch !== made.edit) expect(taken.made.lists, name).toEqual(["model.2"]);
      broken(made);
      expectUnreadable(
        made.storage, made.store, () => made.store.putSlice(taken.slice, taken.made), name, leavesOrphans(name));
    }
    // Whole, each batch is stored.
    let made = listed14();
    for (let batch of [made.edit, numbered(made)]) {
      let taken = applied(made.store, made.store.slice(made.base, batchReach(batch)), batch) as AppliedSlice;
      expect(made.store.putSlice(taken.slice, taken.made).exact).toBe(true);
    }
  });

  it("a later run or its context lost under the walk after a slice is the copy unreadable", () => {
    // A reference deleted in the first run: every later run is rendered again with its context.
    let noted = () => {
      let tab = asFetched(buildTab(Array.from({ length: 12 }, (_, at) =>
        ({ runs: [`Line ${at}`, footnote(at + 1), ".\n"] }))));
      let all = kept(tab, RUNS_OF_THREE);
      let reference = applyDocsRequests(tab, []).body.content[1].paragraph!.elements
        .find(element => element.footnoteReference)!;
      let requests = [deleteRange(reference.startIndex, reference.endIndex)];
      let taken = applied(all.store, all.store.slice(all.base, batchReach(requests)), requests) as AppliedSlice;
      expect([taken.slice.from, taken.slice.to, taken.made.footnotesMoved]).toEqual([0, 1, true]);
      return {
        ...all, taken, context: contextOf(all.storage, all.base),
        runs: listed(all.storage, all.base).map(({ run }) => run),
      };
    };
    let breaks: [string, (kept: ReturnType<typeof noted>) => void][] = [
      ["the last run gone", ({ storage, runs }) => lose(storage, runs.at(-1)!)],
      ["a later run not a run", ({ storage, runs }) => rewrite(storage, runs[2], "not JSON {")],
      ...CONTEXTS,
    ];
    for (let [name, broken] of breaks) {
      let made = noted();
      expect(made.runs.length).toBeGreaterThan(3);
      broken(made);
      expectUnreadable(
        made.storage, made.store, () => made.store.putSlice(made.taken.slice, made.taken.made), name);
    }
    let intact = noted();
    expect(intact.store.putSlice(intact.taken.slice, intact.taken.made).exact).toBe(true);
  });

  it("a run or a context lost under the walk that asks whether the model follows a tab is the copy unreadable", () => {
    // Another digest's record: the question takes ONE statement over the context, valid or not.
    let asked = (broken?: (kept: Kept) => void) => {
      let made = listed14();
      broken?.(made);
      let counted = countedStorage(made.storage);
      return { ...made, counted, other: new DocStore(counted.storage, undefined, "another", RUNS_OF_THREE) };
    };
    let intact = asked();
    expect(intact.other.unindexed(intact.base)).toBe(false);
    expect(intact.counted.counts()).toMatchObject({ styles: 0, lists: 1 });
    expect(intact.other.head(DOC)).toBeDefined();

    let breaks: [string, (kept: Kept) => void][] = [
      ...CONTEXTS,
      ["a run gone", ({ storage, runs }) => lose(storage, runs[2])],
      ["a run not a run", ({ storage, runs }) => rewrite(storage, runs[2], "not JSON {")],
      ["a run of no element", ({ storage, runs }) => rewrite(storage, runs[2], "[]")],
    ];
    for (let [name, broken] of breaks) {
      let made = asked(broken);
      expectUnreadable(made.storage, made.other, () => made.other.unindexed(made.base), name);
      expect(made.counted.counts(), name).toMatchObject({ styles: 0, lists: 1 });
    }
    // A version of no run is not followed: nothing is asked of its context or recorded.
    let unlisted = asked(({ storage, base }) => {
      storage.sql.exec("DELETE FROM doc_seq WHERE version = ?", base.id);
    });
    expectUnreadable(
      unlisted.storage, unlisted.other, () => unlisted.other.unindexed(unlisted.base), "the list gone", true);
    expect(unlisted.counted.counts()).toMatchObject({ styles: 0, lists: 0 });
  });
});

// The statements `slice`, `widen`, `putSlice` and `unindexed` run, each part on its own counted
// storage.
describe("the statements a slice and the version it gives run", () => {
  let memo: ReturnType<typeof scenario> | undefined;
  const census = () => memo ??= scenario();

  /** A part of the scenario: a store over a counted storage of its own. */
  function part(storage: FakeDocStorage, digest?: string, sizes?: RunSizes) {
    let counted = countedStorage(storage);
    let store = new DocStore(counted.storage, undefined, digest, sizes);
    let call = <T>(_: string, run: (store: DocStore) => T): T => run(store);
    return { call, done: () => ({ ran: counted.ran() }) };
  }

  function scenario() {
    let tab = listedTablesTab(TAB, 600);
    let { storage, base } = kept(tab);
    let starts = runStarts(storage, base);
    let runs = starts.length - 1;
    const S = 701;
    let cell = [insertText(cellStart(starts[S]), "X")];
    let change = (store: DocStore, slice: DocSlice, requests: GoogleDocsRequest[]) => {
      let made = applied(store, slice, requests) as AppliedSlice;
      return store.putSlice(made.slice, made.made);
    };

    // EVERY RENDERING STORED, AND THE CARRY LEFT AS IT WAS: an edit's own part.
    let own = part(storage);
    let middle = own.call("slice in the middle", store => store.slice(base, batchReach(cell)));
    let last = own.call("slice in the last run", store =>
      store.slice(base, stretchReach(storage, base, runs - 1, runs, starts)));
    own.call("slice in the first run", store => store.slice(base));
    let before = own.call("widen before", store =>
      store.widen(base, { from: S, to: S + 1 }, new SliceEdgeError("before", starts[S] - 1)));
    let after = own.call("widen after", store =>
      store.widen(base, { from: S, to: S + 1 }, new SliceEdgeError("after", starts[S + 1])));
    own.call("putSlice in the middle", store => change(store, middle, cell));
    own.call("putSlice in the last run", store => change(store, last, typed(starts[runs - 1] - 1)));
    own.call("putSlice of a slice widened before", store => change(store, before, cell));
    own.call("putSlice of a slice widened after", store => change(store, after, cell));

    // RUNS WITH NO STORED RENDERING, before a slice and in it.
    let lost = part(storage);
    let lose = (...places: number[]) => {
      for (let place of places) {
        storage.sql.exec(
          `DELETE FROM doc_md WHERE (run, context, carry) IN
             (SELECT run, context, carry FROM doc_seq WHERE version = ? AND seq = ?)`, base.id, place);
      }
    };
    lose(101, 303);
    lost.call("slice past two lost renderings of one page", store => store.slice(base, batchReach(cell)));
    lose(101, 303, S);
    lost.call("slice past two, with its own run's lost", store => store.slice(base, batchReach(cell)));
    lose(101, 303);
    lost.call("widen past two lost renderings", store =>
      store.widen(base, { from: S, to: S + 1 }, new SliceEdgeError("before", starts[S] - 1)));

    // THE CARRY MOVES, OR A LIST IS MADE.
    let moves = part(storage);
    moves.call("a batch that makes a list", store =>
      change(store, store.slice(base, batchReach([bullets(1, 2, NUMBERED)])), [bullets(1, 2, NUMBERED)]));

    // A reference deleted in the first run: every later run is rendered again, in three pages.
    let noted = asFetched(buildTab(Array.from({ length: 1_100 }, (_, at) =>
      ({ runs: [`Line ${at}`, footnote(at + 1), ".\n"] }))));
    let notes = kept(noted, ONE_EACH);
    let reference = applyDocsRequests(noted, []).body.content[1].paragraph!.elements
      .find(element => element.footnoteReference)!;
    let unnote = [deleteRange(reference.startIndex, reference.endIndex)];
    let footnotes = part(notes.storage, undefined, ONE_EACH);
    let unnoted = footnotes.call("slice in the first run", store => store.slice(notes.base, batchReach(unnote)));
    footnotes.call("putSlice of a reference deleted", store => change(store, unnoted, unnote));

    // ANOTHER DIGEST keys the base and stores the child; this one asks again and puts it again.
    let other = part(storage, "another");
    other.call("the child stored by another digest", store => change(store, store.slice(base, batchReach(cell)), cell));
    let again = part(storage);
    again.call("unindexed of a record of another digest", store => store.unindexed(base));
    let rekeyed = again.call("slice of a version another digest keyed", store => store.slice(base, batchReach(cell)));
    again.call("putSlice of a child another digest keyed", store => change(store, rekeyed, cell));

    return {
      storages: [storage, notes.storage],
      own: own.done(), lost: lost.done(), moves: moves.done(), footnotes: footnotes.done(),
      other: other.done(), again: again.done(),
    };
  }

  /** Every statement the scenario's stores ran. */
  const everyStatement = () => {
    let { own, lost, moves, footnotes, other, again } = census();
    return [...new Set([own, lost, moves, footnotes, other, again].flatMap(({ ran }) => ran))];
  };

  it("scans no table, under its own name or an alias", () => {
    let [storage] = census().storages;
    let statements = everyStatement();
    // Every `SCAN` step not of a virtual table, whatever alias it names; the scenario sweeps
    // nothing.
    expect(tableScans(storage, statements)).toEqual({});
    let planOf = (holds: string) => {
      let found = statements.filter(statement => statement.includes(holds));
      expect(found, holds).toHaveLength(1);
      return storage.plan(found[0]).join("\n");
    };
    // Each by its key.
    expect(planOf("DELETE FROM doc_md WHERE made <> ?2")).toMatch(/SEARCH doc_md USING/);
    expect(planOf("SELECT ?1, seq + ?5")).toMatch(/SEARCH doc_seq USING PRIMARY KEY/);
    expect(planOf("SELECT run FROM doc_seq WHERE version = ?1 AND seq >= ?2 AND seq < ?3"))
      .toMatch(/SEARCH doc_seq USING PRIMARY KEY/);
    expect(planOf("SUM(CASE WHEN seq < ?2")).toMatch(/SEARCH doc_seq USING PRIMARY KEY/);
    expect(planOf("json_tree")).toMatch(/SEARCH run USING/);
    expect(planOf("IN (SELECT value FROM json_each(?2))")).toMatch(/SEARCH doc_run USING/);
    expect(planOf("substr(each.key, 1, length(?2))")).toMatch(/SEARCH doc_run USING/);
  });

  // By the source's text: each statement that writes those rows, with the method it stands in.
  it("one writer of a run, of a rendering and of a list", () => {
    let source = readFileSync(path.resolve(import.meta.dirname, "../src/docs-store.ts"), "utf8");
    let header = /^(?:export )?function (\w+)\(|^ {2}(?:async )?(#?\w+)\([^;]*$/gm;
    let within = (index: number) => {
      let last = [...source.slice(0, index).matchAll(header)].at(-1);
      return last?.[1] ?? last?.[2];
    };
    let users = (name: string | RegExp) =>
      [...new Set([...source.matchAll(new RegExp(name, "g"))].map(({ index }) => within(index)))].toSorted();
    let writers: Record<string, string> = { doc_run: "#putContent", doc_md: "#putMarkdown", doc_seq: "#listWriter" };
    let texts: Record<string, string[]> = { doc_run: [], doc_md: [], doc_seq: [] };
    let writes = /\b(?:INSERT(?: OR REPLACE)? INTO|REPLACE INTO|UPDATE)\s+(doc_run|doc_md|doc_seq)\b/g;
    for (let { 0: text, 1: table, index } of source.matchAll(writes)) {
      let line = source.slice(source.lastIndexOf("\n", index) + 1, index);
      let constant = /^const (\w+) = [`"]$/.exec(line)?.[1];
      texts[table].push(constant ?? text);
      if (constant) {
        // Used by name inside the one writer, and nowhere else but where it is declared.
        expect([...source.matchAll(new RegExp(`\\b${constant}\\b`, "g"))]
          .map(({ index: at }) => source.slice(source.lastIndexOf("\n", at) + 1, at).startsWith("const ")
            ? "declared" : within(at)), constant).toEqual(["declared", writers[table]]);
      } else {
        expect(within(index), text).toBe(writers[table]);
      }
    }
    expect(texts).toEqual({
      doc_run: ["INSERT INTO doc_run"],
      doc_md: ["UPDATE doc_md", "INSERT INTO doc_md"],
      doc_seq: ["PUT_RUNS", "COPY_RUNS"],
    });
    // Who calls each writer: a caller more is a line to add here, never a second writer.
    expect(users("this\\.#putContent\\(")).toEqual(["#put", "#putSliced", "#putVersion", "putTab"]);
    expect(users("this\\.#listWriter\\(")).toEqual(["#putSliced", "#putVersion", "#rekey", "putTab"]);
    expect(users("this\\.#putMarkdown\\(")).toEqual(["#keyRun", "#renderAt"]);
  });
});

// What an edit does to run boundaries, against Google's answer after the step and the model's cut.
describe("what an edit does to run boundaries", () => {
  /** The names of the runs `content` is cut into under `sizes`. */
  const cutNames = (content: Iterable<StructuralElement>, sizes: RunSizes, footnotes = 0) =>
    [...cutRuns(content, sizes, footnotes)].map(run => runId(run.json));

  // An untouched run is found again by the next fetch, by name; one the edit wrote into is not.
  it("what a fetch after approval finds: the recorded steps", () => {
    let sizes = RUN_SIZES;
    let tally = {
      steps: 0, listed: 0, outsideFound: 0, outsideNot: 0, cutFound: 0, cutNot: 0, sameList: 0,
      elementsGoogle: 0, elementsNot: 0, ownListed: 0, ownDiffer: 0, ownBefore: 0,
    };
    for (let { name } of readFixtures()) {
      for (let { where, tab, after, requests } of recordedSteps(name)) {
        if (!requests) continue;
        let { storage, store, base } = kept(asFetched(tab), sizes);
        let made = applied(store, store.slice(base, batchReach(requests)), requests);
        if ("refused" in made) continue;
        let { slice } = made;
        let child = store.putSlice(slice, made.made);
        let fetched = pruneTab(throughJson(after)).body.content;
        let fetch = new Set(cutNames(fetched, sizes));
        let parent = listed(storage, base), rows = listed(storage, child);
        let cut = rows.length - parent.length + slice.to - slice.from;
        tally.steps++;
        tally.listed += rows.length;
        for (let [place, { run }] of rows.entries()) {
          let outside = place < slice.from || place >= slice.from + cut;
          if (outside) tally[fetch.has(run) ? "outsideFound" : "outsideNot"]++;
          else tally[fetch.has(run) ? "cutFound" : "cutNot"]++;
        }
        if (rows.length === fetch.size && rows.every(({ run }) => fetch.has(run))) tally.sameList++;
        // Element by element: each side cut a run an element, so a stored element stands alone.
        let elements = new Set(cutNames(fetched, ONE_EACH));
        for (let element of cutNames(slice.piece.content, ONE_EACH, slice.piece.footnotesBefore)) {
          tally[elements.has(element) ? "elementsGoogle" : "elementsNot"]++;
        }
        // The run directly before the slice is apart: the edit may have removed what ended it.
        let settled = slice.from - 1;
        // An earlier run Google's answer holds unchanged at the same place is named in the fetch's
        // cut.
        let before = cutNames(tab.body.content, ONE_EACH), now = cutNames(fetched, ONE_EACH);
        let lengths = runLengths(storage, base);
        for (let place = 0, element = 0; place < settled; element += lengths[place++]) {
          let same = before.slice(element, element + lengths[place])
            .every((id, at) => id === now[element + at]);
          if (same) expect(fetch.has(parent[place].run), `${where}, run ${place}`).toBe(true);
        }
        // Against the model's own cut from the tab's start: the runs before are the same.
        let own = ownCut(storage, child, sizes, slice.from + cut);
        expect(own.own.slice(0, Math.max(0, settled)), where).toEqual(own.listed.slice(0, Math.max(0, settled)));
        if (settled >= 0 && own.own[settled]?.run !== own.listed[settled].run) tally.ownBefore++;
        tally.ownListed += rows.length;
        tally.ownDiffer += notAmong(own.listed, own.own);
      }
    }
    // 113 runs outside the slices, a fetch finds 112: not the run a table ended, where it is deleted.
    expect(tally).toEqual({
      steps: 209, listed: 344, outsideFound: 112, outsideNot: 1, cutFound: 23, cutNot: 208,
      sameList: 12, elementsGoogle: 877, elementsNot: 298, ownListed: 344, ownDiffer: 2, ownBefore: 1,
    });
  });

  // AGAINST THE MODEL'S OWN CUT, where no answer is recorded: the child's cut against one from the
  // start.
  it("what not joining costs: one-paragraph replacements in a tab of 20,000 lines", () => {
    let tab = asFetched(linesTab(20_000));
    let { storage, store, base } = kept(tab);
    let runs = runSizes(storage, base).length;
    expect(runs).toBeGreaterThan(100);
    let { below } = diceOf(20261122);
    let tally = { replacements: 0, differ: 0, most: 0, cut: 0 };
    for (let turn = 0; turn < 200; turn++) {
      let start = tab.body.content[1 + below(20_000)].startIndex;
      let made = through(store, base, [deleteRange(start + 5, start + 10), insertText(start + 5, "REPLACED")]);
      let cut = runSizes(storage, made.child).length - runs + made.slice.to - made.slice.from;
      let own = ownCut(
        storage, made.child, RUN_SIZES, made.slice.from + cut, made.slice.from, made.slice.piece.footnotesBefore);
      let differ = notAmong(own.listed, own.own);
      tally.replacements++;
      tally.cut += cut;
      tally.differ += differ;
      tally.most = Math.max(tally.most, differ);
    }
    expect(tally).toEqual({ replacements: 200, differ: 0, most: 0, cut: 200 });
  });
});

// What each variant of the caller's teeth found, for the test that pins it.
const teeth: Record<string, string> = {};

// THE TEETH OF THE CALLER: each variant gets one thing wrong, and must, from some stretch, give
// a version that does not read as the whole tab's result.
describe("the teeth of the caller", () => {
  /** What a variant is handed: the store, a fresh slice, the batch, and the stored summaries by place. */
  type Handed = {
    store: DocStore; slice: DocSlice; requests: GoogleDocsRequest[]; sizes: RunSizes;
    summaries: RunSummary[];
  };
  type Variant = (handed: Handed) => DocVersion;

  /** A carry moved over the stored summaries of the runs before `place`: the carry into it. */
  const carryInto = (summaries: readonly RunSummary[], place: number): PassCarry => {
    let carry = initialCarry();
    for (let summary of summaries.slice(0, place)) advanceCarry(carry, summary);
    return carry;
  };

  /** The pair a slice holds, made by the test: the carry into it, and the other side past its stored runs. */
  const pairOf = ({ slice, summaries }: Handed, ours = carryInto(summaries, slice.from)) => {
    let pair = new CarryBeside(ours, initialCarry());
    for (let summary of summaries.slice(slice.from, slice.to)) pair.advanceTheirs(summary);
    return pair;
  };

  const VARIANTS: Record<string, Variant> = {
    "the walk as it is": ({ store, slice, requests }) =>
      store.putSlice(slice, applyDocsRequestsToSlice(slice.piece, requests)),
    "the pair made by the test as the store makes it": handed => {
      let { store, slice, requests } = handed;
      return store.putSlice(
        { ...slice, carries: pairOf(handed) }, applyDocsRequestsToSlice(slice.piece, requests));
    },
    "the model handed no footnote before the slice": ({ store, slice, requests }) => {
      let piece = { ...slice.piece, footnotesBefore: 0 };
      let made = applyDocsRequestsToSlice(piece, requests);
      return store.putSlice({ ...slice, piece: slice.piece }, made);
    },
    "the cut handed footnote base 0": ({ store, slice, requests }) => {
      let made = applyDocsRequestsToSlice(slice.piece, requests);
      return store.putSlice({ ...slice, piece: { ...slice.piece, footnotesBefore: 0 } }, made);
    },
    "the slice handed only its own lists": ({ store, slice, requests }) => {
      let named = new Set(namedListIds(slice.piece.content));
      let lists = Object.fromEntries(Object.entries(slice.piece.lists).filter(([id]) => named.has(id)));
      let piece = { ...slice.piece, lists: lists as GoogleDocsTab["lists"] };
      return store.putSlice({ ...slice, piece }, applyDocsRequestsToSlice(piece, requests));
    },
    "a retry on the piece a first attempt changed": ({ store, slice, requests }) => {
      applyDocsRequestsToSlice(slice.piece, requests);
      return store.putSlice(slice, applyDocsRequestsToSlice(slice.piece, requests));
    },
    "the slice's pair started from the carry of a tab's start": handed => {
      let { store, slice, requests } = handed;
      return store.putSlice(
        { ...slice, carries: pairOf(handed, initialCarry()) }, applyDocsRequestsToSlice(slice.piece, requests));
    },
    "the slice's pair made after its stored runs": ({ store, slice, requests, summaries }) => {
      let carries = new CarryBeside(carryInto(summaries, slice.to), initialCarry());
      return store.putSlice({ ...slice, carries }, applyDocsRequestsToSlice(slice.piece, requests));
    },
    "the pass's side moved outside the pair": handed => {
      let { store, slice, requests, summaries } = handed;
      let ours = carryInto(summaries, slice.from);
      let carries = pairOf(handed, ours);
      advanceCarry(ours, summaries[slice.from]);
      return store.putSlice({ ...slice, carries }, applyDocsRequestsToSlice(slice.piece, requests));
    },
    "the later runs listed without the walk": handed => {
      let { store, slice, requests, summaries, sizes } = handed;
      let made = applyDocsRequestsToSlice(slice.piece, requests);
      // The other side moved over the runs that came out: both carries agree after the slice.
      let carries = new CarryBeside(carryInto(summaries, slice.from), initialCarry());
      if (slice.piece.content.length > 0) {
        for (let run of cutRuns(slice.piece.content, sizes, slice.piece.footnotesBefore)) {
          carries.advanceTheirs(renderRun(run.elements, slice.piece, initialCarry(), { mdStart: 0 }).summary);
        }
      }
      return store.putSlice({ ...slice, carries }, made);
    },
  };

  /** `variant` from every stretch that holds what the batch names: how many ran and mismatched. */
  function mismatches(tab: GoogleDocsTab, requests: GoogleDocsRequest[], sizes: RunSizes, variant: Variant) {
    let want = wholeTab(tab, requests);
    let { storage, store, base } = kept(tab, sizes);
    let starts = runStarts(storage, base);
    let runs = starts.length - 1;
    let summaries = storage.sql.exec<{ summary: string }>(
      `SELECT doc_md.summary FROM doc_seq JOIN doc_md ON doc_md.doc = ?2 AND doc_md.run = doc_seq.run
         AND doc_md.context = doc_seq.context AND doc_md.carry = doc_seq.carry
       WHERE doc_seq.version = ?1 ORDER BY doc_seq.seq`, base.id, base.doc,
    ).toArray().map(({ summary }) => (JSON.parse(summary) as { run: RunSummary }).run);
    expect(summaries).toHaveLength(runs);
    let reach = batchReach(requests)!;
    // The runs the batch reads, the run before a bulleted range and the run after a deletion's end included.
    let [low, high] = [Math.max(0, placeOf(starts, reach.from) - 1), Math.min(runs - 1, placeOf(starts, reach.to) + 1)];
    let ran = 0, mismatched = 0;
    for (let from = 0; from <= low; from++) {
      for (let to = high + 1; to <= runs; to++) {
        ran++;
        try {
          undone(store, () => {
            let slice = store.slice(base, stretchReach(storage, base, from, to, starts));
            let child = variant({ store, slice, requests, sizes, summaries });
            let tab = store.tab(child);
            if (JSON.stringify(tab.body.content) !== want.body || store.markdown(child) !== want.markdown ||
                JSON.stringify(tab.lists) !== JSON.stringify(want.tab.lists)) mismatched++;
          });
        } catch {
          mismatched++;
        }
      }
    }
    return { ran, mismatched };
  }

  // Paragraphs with a footnote each; one deleted in the middle, the later renumbered.
  let noted = () => {
    let tab = asFetched(buildTab(Array.from({ length: 10 }, (_, at) =>
      ({ runs: [`Line ${at}`, footnote(at + 1), ".\n"] }))));
    let reference = applyDocsRequests(tab, []).body.content[5].paragraph!.elements
      .find(element => element.footnoteReference)!;
    return [tab, [deleteRange(reference.startIndex, reference.endIndex)]] as const;
  };
  // A list the model made, named in the last run; a paragraph of an earlier run bulleted.
  let listed = () => {
    let tab = asFetched(buildTab(
      [...Array.from({ length: 9 }, (_, at) => para(`Line ${at}.`)), item("Last.", "model.1")],
      { "model.1": NUMBERED_LIST.N1 }));
    let paragraph = applyDocsRequests(tab, []).body.content[3];
    return [tab, [bullets(paragraph.startIndex, paragraph.endIndex, NUMBERED)]] as const;
  };
  // Items of one numbered list broken by a paragraph; the fourth taken out of the list.
  let numbered = () => {
    let tab = asFetched(buildTab(
      Array.from({ length: 13 }, (_, at) => at === 9 ? para("Between.") : item(`Item ${at}.`, "N1")),
      NUMBERED_LIST));
    let paragraph = applyDocsRequests(tab, []).body.content[4];
    return [tab, [deleteBullets(paragraph.startIndex, paragraph.endIndex)]] as const;
  };
  // A text change, which applies again to what it gave.
  let plain = () => {
    let tab = asFetched(linesTab(10));
    return [tab, typed(tab.body.content[5].startIndex)] as const;
  };

  it.each([
    ["the model handed no footnote before the slice", noted],
    ["the cut handed footnote base 0", noted],
    ["the slice handed only its own lists", listed],
    ["a retry on the piece a first attempt changed", plain],
    ["the slice's pair started from the carry of a tab's start", numbered],
    ["the slice's pair made after its stored runs", numbered],
    ["the pass's side moved outside the pair", numbered],
    ["the later runs listed without the walk", numbered],
  ] as const)("%s gives another version", (name, corpus) => {
    let [tab, requests] = corpus();
    // The walk as it is, and with the slice's pair made here as the store makes it: none.
    for (let honest of ["the walk as it is", "the pair made by the test as the store makes it"]) {
      let held = mismatches(tab, [...requests], ONE_EACH, VARIANTS[honest]);
      expect(held.ran, honest).toBeGreaterThan(5);
      expect(held.mismatched, honest).toBe(0);
    }
    let found = mismatches(tab, [...requests], ONE_EACH, VARIANTS[name]);
    expect(found.mismatched, name).toBeGreaterThan(0);
    teeth[name] = `${found.mismatched} of ${found.ran}`;
  });

  // Tests of a file run in order: this one reads what each variant found.
  it("each variant was found from the stretches the run shows", () => {
    expect(teeth).toEqual({
      "the model handed no footnote before the slice": "15 of 25",
      "the cut handed footnote base 0": "15 of 25",
      "the slice handed only its own lists": "18 of 21",
      "a retry on the piece a first attempt changed": "25 of 25",
      "the slice's pair started from the carry of a tab's start": "18 of 36",
      "the slice's pair made after its stored runs": "36 of 36",
      "the pass's side moved outside the pair": "27 of 36",
      "the later runs listed without the walk": "24 of 36",
    });
  });
});

describe("nothing is kept", () => {
  it("a slice let go is collectable", HEAP_MEASURED, async () => {
    let { storage, store, base } = kept(asFetched(linesTab(40)), RUNS_OF_THREE);
    // A weak reference keeps its target to the end of its job, so they are read in a later one.
    let refs = (() => {
      let made = through(store, base, typed(runStarts(storage, base)[4]));
      let { slice } = made;
      return [slice, slice.piece, slice.piece.content, slice.piece.content[0], slice.carries]
        .map(held => new WeakRef<object>(held));
    })();
    await new Promise(resolve => setImmediate(resolve));
    collect();
    expect(refs.map(ref => ref.deref())).toEqual([undefined, undefined, undefined, undefined, undefined]);
  });
});
