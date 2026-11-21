// A store pass over thousands of numbered lists touches carry entries in proportion to the lists,
// not their square, and moves a carry nowhere else. A file of its own: it replaces a module.

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

// Every pass, and each pair's second side, owns a counted carry.
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

/** `listedTablesTab("t1", lists)` with the second table's cell an item of the first list. */
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

    // A first keep is one pass; a keep beside a differing version counts the pair's side too.
    let store = opened();
    expect(counted(() => keep(store, listedTablesTab("t1", 3), "r1")).carries).toBe(1);
    expect(counted(() => keep(store, oneItemMore(3), "r2")).carries).toBe(2);
  });

  // One list a table; a pass that listed or copied its numbers would touch ~`lists * lists / 2`.
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

  // By the sources' text: each `advanceCarry` call is named by the function header before it.
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
