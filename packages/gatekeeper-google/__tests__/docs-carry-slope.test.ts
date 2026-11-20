// What a pass over a tab of thousands of numbered lists reads and writes of its carry: pinned
// by a count of entries, which grows with the lists and not with their square. No time is
// pinned: a count holds on any machine.
// A file of its own, because it replaces a module for every test of its file.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { GoogleDocsTab } from "../src/docs-api";
import { DocStore, docStoreCost, fetchedMarkdown, type DocPending } from "../src/docs-store";
import { initialCarry } from "../src/markdown-converter";
import { counted, touchedBy } from "./carry-count";
import { fakeDocStorage } from "./doc-store-fake";
import { listedTablesTab, scenarioBase } from "./doc-store-scenarios";
import { documentOf } from "./docs-fetched-corpus";

// The module as it is but for `initialCarry` as other modules import it: every pass of the
// store then owns a counted carry, and so does the second side of every pair the store makes,
// which is handed a carry made the same way. What a walk that holds a pair touches is
// therefore the two maps together, and `carries` says whether it held one: 1 for a pass
// alone, 2 for a pass with a pair.
vi.mock("../src/markdown-converter", async importOriginal => {
  let converter = await importOriginal<typeof import("../src/markdown-converter")>();
  let { countedCarry } = await import("./carry-count");
  return { ...converter, initialCarry: () => countedCarry(converter.initialCarry()) };
});

const DOC = "doc";
const NONE: DocPending = { edits: [], roots: [] };
const SOURCES = path.resolve(import.meta.dirname, "../src");

/** A store under the digest `made`, over `storage`. */
function opened(made?: string, storage = fakeDocStorage()): DocStore {
  return new DocStore(storage, undefined, made);
}

/** Keeps a document of `tab` as Google answers one: a walk empties it, so each keep reads its own. */
function keep(store: DocStore, tab: GoogleDocsTab, revision: string) {
  return store.keep(DOC, store.fetched(documentOf([tab], revision), 1_000), NONE);
}

/** What `run` moved of the store's counts, and of the counted carries. */
function spent(run: () => unknown) {
  let before = { ...docStoreCost };
  let carry = counted(run);
  return {
    ...carry,
    runsDecoded: docStoreCost.runsDecoded - before.runsDecoded,
    runsRendered: docStoreCost.runsRendered - before.runsRendered,
    runsKeyed: docStoreCost.runsKeyed - before.runsKeyed,
  };
}

/** The paragraph of each table's cell of a `listedTablesTab`, in order. */
function cellsOf(tab: GoogleDocsTab) {
  return tab.body.content.flatMap(element => {
    let paragraph = element.table?.tableRows?.[0]?.tableCells?.[0]?.content?.[0]?.paragraph;
    return paragraph ? [paragraph] : [];
  });
}

/**
 * `listedTablesTab("t1", lists)` with the second table's cell an item of the FIRST list: no
 * index moves and every list stays defined. The first list then holds one number more than
 * in the tab as it was, to the tab's end.
 */
function oneItemMore(lists: number): GoogleDocsTab {
  let tab = listedTablesTab("t1", lists);
  cellsOf(tab)[1].bullet = { listId: "kix.list0" };
  return tab;
}

/**
 * `listedTablesTab("t1", lists)` with every second table's cell an item of the list of the
 * table before it: no index moves and every list stays defined. Every list then holds another
 * count than in the tab as it was (two where it held one, or none), to the tab's end.
 */
function everyListOtherwise(lists: number): GoogleDocsTab {
  let tab = listedTablesTab("t1", lists);
  for (let [at, cell] of cellsOf(tab).entries()) {
    if (at % 2 === 1) cell.bullet = { listId: `kix.list${at - 1}` };
  }
  return tab;
}

describe("the carry of a pass over a tab of thousands of numbered lists", () => {
  it("the counter counts", () => {
    let carry = initialCarry();
    for (let list = 0; list < 100; list++) carry.listNumbers.set(`kix.list${list}`, [1]);
    // A copy, a spread and a listing are every entry; a read is one.
    expect(touchedBy(() => new Map(carry.listNumbers))).toBe(100);
    expect(touchedBy(() => [...carry.listNumbers])).toBe(100);
    expect(touchedBy(() => carry.listNumbers.forEach(() => {}))).toBe(100);
    expect(touchedBy(() => carry.listNumbers.get("kix.list7"))).toBe(1);
    expect(touchedBy(() => carry.listNumbers.size)).toBe(0);

    // A keep with nothing stored before is one pass. A keep beside a stored version that
    // differs holds that version's carry beside its own, and the pair's side is counted too.
    let store = opened();
    expect(counted(() => keep(store, listedTablesTab("t1", 3), "r1")).carries).toBe(1);
    expect(counted(() => keep(store, oneItemMore(3), "r2")).carries).toBe(2);
  });

  // A run reads and writes the numbers of the lists it counts in: here one list a table, read
  // as the table is rendered and keyed and replaced as the pass moves. A pass that listed or
  // copied its numbers at a run would touch about `lists * lists / 2` entries.
  it("a fetch's keep touches the lists each run counts in", () => {
    let touched = [3_000, 7_700].map(lists => {
      let cost = spent(() => keep(opened(), listedTablesTab("t1", lists), "r1"));
      expect(cost).toMatchObject({ carries: 1, runsRendered: 2 * lists + 1 });
      expect(cost.touched).toBeLessThanOrEqual(6 * lists);
      return cost.touched;
    });
    // The lists' ratio is 2.57; the ratio of their squares is 6.6.
    expect(touched[1] / touched[0]).toBeGreaterThan(2.3);
    expect(touched[1] / touched[0]).toBeLessThan(2.8);
  });

  // The first list holds one number more than in the version beside, to the tab's end, so the
  // two carries are never the same again and every later run is keyed again: the walk moves
  // both carries past each, and asks at each whether they are the same. Counted on both
  // sides, the pass's numbers and what the pair holds apart.
  it("a refetch keyed beside a version whose numbers never settle touches no more", () => {
    let touched = [3_000, 7_700].map(lists => {
      let store = opened();
      keep(store, listedTablesTab("t1", lists), "r1");
      let cost = spent(() => keep(store, oneItemMore(lists), "r2"));
      // The changed table is rendered; the runs after it are keyed from their summaries.
      expect(cost).toMatchObject({
        carries: 2, runsRendered: 1, runsDecoded: 0, runsKeyed: 2 * lists - 3,
      });
      // A table keyed again: 1 entry read for its key, 7 to move this version's carry past
      // it and 6 to move the other's.
      expect(cost.touched).toBeLessThanOrEqual(14 * lists);
      return cost.touched;
    });
    expect(touched[1] / touched[0]).toBeGreaterThan(2.3);
    expect(touched[1] / touched[0]).toBeLessThan(2.8);
  });

  // Every list holds another count than in the version beside, to the tab's end, so the pair
  // holds every list passed apart, thousands by the end: the shape on which a move that
  // listed or copied what differs would cost the square of the lists.
  it("a refetch keyed beside a version that numbers every list otherwise touches no more", () => {
    let touched = [1_500, 3_000].map(lists => {
      let store = opened();
      keep(store, listedTablesTab("t1", lists), "r1");
      let cost = spent(() => keep(store, everyListOtherwise(lists), "r2"));
      // Every second table is rendered; of the others and the stretches between, all but the
      // first of each are keyed from their summaries.
      expect(cost).toMatchObject({
        carries: 2, runsRendered: lists / 2, runsDecoded: 0, runsKeyed: 1.5 * lists - 2,
      });
      // A pair of tables, the first keyed again and the second rendered: 30 entries, which
      // is 15 a list.
      expect(cost.touched).toBeLessThanOrEqual(15 * lists);
      return cost.touched;
    });
    // The lists' ratio is 2; the ratio of their squares is 4.
    expect(touched[1] / touched[0]).toBeGreaterThan(1.8);
    expect(touched[1] / touched[0]).toBeLessThan(2.2);
  });

  // The version is kept under one digest and read under another: each run is decoded,
  // rendered and keyed again, in one pass that owns its carry.
  it("a keying after a change of digest touches the lists each run counts in", () => {
    let touched = [400, 800].map(lists => {
      let storage = fakeDocStorage();
      let head = keep(opened("a", storage), listedTablesTab("t1", lists), "r1");
      let store = opened("b", storage);
      let base = scenarioBase(store, DOC, head);
      let cost = spent(() => store.markdown(base));
      expect(cost).toMatchObject({ carries: 1, runsRendered: 2 * lists + 1 });
      expect(cost.touched).toBeLessThanOrEqual(6 * lists);
      return cost.touched;
    });
    expect(touched[1] / touched[0]).toBeGreaterThan(1.8);
    expect(touched[1] / touched[0]).toBeLessThan(2.2);
  });

  // By the sources' text, read as files: each call of `advanceCarry` in the store is found
  // with the function it is in, which is named by the last `function <name>(` or method
  // header before it.
  it("the store moves a carry in `passed` and in `fetchedMarkdown`, and nowhere else", () => {
    let store = readFileSync(path.join(SOURCES, "docs-store.ts"), "utf8");
    let header = /^(?:export )?function (\w+)\(|^ {2}(?:async )?(#?\w+)\([^;]*$/gm;
    let movers = [...store.matchAll(/advanceCarry\(/g)].map(({ index }) => {
      let last = [...store.slice(0, index).matchAll(header)].at(-1);
      return last?.[1] ?? last?.[2];
    });
    expect(movers.toSorted()).toEqual(["fetchedMarkdown", "passed"]);
    // No source copies a carry, compares two whole, or keeps one where the module loads.
    let files = readdirSync(SOURCES, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile());
    expect(files.length).toBeGreaterThan(50);
    for (let file of files) {
      let text = readFileSync(path.join(file.parentPath, file.name), "utf8");
      for (let name of ["sameCarry", "INITIAL_CARRY", "withListNumbers"]) {
        expect(text.includes(name), `${name} in ${file.name}`).toBe(false);
      }
    }
  });

  it("the Markdown of a fetched tab in hand touches the lists each run counts in", () => {
    let lists = 3_000;
    let store = opened();
    let [tab] = store.fetched(documentOf([listedTablesTab("t1", lists)], "r1"), 1_000).tabs;
    let cost = counted(() => fetchedMarkdown(tab));
    expect(cost.carries).toBe(1);
    expect(cost.touched).toBeLessThanOrEqual(6 * lists);
  });
});
