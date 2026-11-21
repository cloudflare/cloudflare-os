// What a pass of the Doc store over a tab of thousands of numbered lists reads and writes of
// its carry, by a count of entries that grows with the lists and not with their square; and
// that the store moves a carry nowhere else. A file of its own: it replaces a module.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { GoogleDocsTab } from "../src/docs-api";
import { DocStore, docStoreCost, fetchedMarkdown, type DocPending } from "../src/docs-store";
import { initialCarry } from "../src/markdown-converter";
import { counted, touchedBy } from "./carry-count";
import { fakeDocStorage } from "./doc-store-fake";
import { listedTablesTab } from "./doc-store-scenarios";
import { documentOf } from "./docs-fetched-corpus";

// `initialCarry` as other modules import it: every pass of the store, and the second side of
// every pair it makes, then owns a counted carry (`carries` is 1 for a pass, 2 with a pair).
vi.mock("../src/markdown-converter", async importOriginal => {
  let converter = await importOriginal<typeof import("../src/markdown-converter")>();
  let { countedCarry } = await import("./carry-count");
  return { ...converter, initialCarry: () => countedCarry(converter.initialCarry()) };
});

const DOC = "doc";
const NONE: DocPending = { edits: [], roots: [] };
const SOURCES = path.resolve(import.meta.dirname, "../src");

/** A store over a storage of its own. */
const opened = () => new DocStore(fakeDocStorage());

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
