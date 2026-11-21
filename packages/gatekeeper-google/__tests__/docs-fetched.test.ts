// The walk of a fetched Google Doc (`fetchedDoc`): each tab as the runs its pruned whole is cut
// into, the answer read once and emptied as read, and what it throws, and when.

import { describe, expect, it } from "vitest";
import type { GoogleDocsDocument, GoogleDocsTab } from "../src/docs-api";
import { hasModelFootnotes, hasModelIndexes } from "../src/docs-model";
import { fetchedDoc, pruneTab, tabIdentity } from "../src/docs-replica";
import type { FetchedDocTab } from "../src/docs-replica";
import { cutRuns, RUN_SIZES } from "../src/docs-runs";
import type { CutRun, RunSizes } from "../src/docs-runs";
import { thrownMessage } from "./doc-fixture";
import {
  CUTS, distinctTabs, documentOf, FORCED, FUZZED, LARGE, linesTab, MARKED, RECORDED, writeMarkersOf,
} from "./docs-fetched-corpus";

/** What a test reads of one tab of the walk, or builds of a tab whole, as plain data. */
type ReadTab = Pick<FetchedDocTab, "identity" | "writeMarkers" | "context" | "first"> & {
  runs: CutRun[];
  unindexed: boolean;
};

/** A run as plain data that shares no array with the cut that made it. */
const copiedRun = ({ json, elements, size, footnotes, holds }: CutRun): CutRun =>
  ({ json, elements: [...elements], size, footnotes, holds });

/** The whole-tab reference: what the walk must hand of `tab`, built of the tab pruned whole. */
function whole(tab: GoogleDocsTab, sizes: RunSizes): ReadTab {
  let pruned = pruneTab(tab);
  let { content } = pruned.body;
  let start = content[0]?.startIndex;
  return {
    identity: tabIdentity(pruned),
    writeMarkers: writeMarkersOf(tab),
    context: {
      lists: pruned.lists,
      ...(pruned.namedStyles ? { namedStyles: pruned.namedStyles } : {}),
    },
    first: Number.isInteger(start) ? start : 0,
    runs: [...cutRuns(content, sizes)].map(copiedRun),
    unindexed: !hasModelIndexes(pruned) || !hasModelFootnotes(pruned),
  };
}

/** The walk of `document` read to its end: each tab, then its runs, then what it says last. */
function read(document: GoogleDocsDocument, sizes?: RunSizes): ReadTab[] {
  let tabs: ReadTab[] = [];
  for (let tab of fetchedDoc(document, 0, sizes).tabs) {
    let { identity, writeMarkers, context, first } = tab;
    let runs: CutRun[] = [];
    for (let run of tab.runs) runs.push(copiedRun(run));
    tabs.push({ identity, writeMarkers, context, first, runs, unindexed: tab.unindexed() });
  }
  return tabs;
}

/** `items` behind a proxy that hands `onRead` each index read of it, before the read. */
function watched<Item>(items: Item[], onRead: (index: number) => void): Item[] {
  return new Proxy(items, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) onRead(Number(key));
      return Reflect.get(target, key, receiver) as unknown;
    },
  });
}

describe("the walk of a fetched document", () => {
  it.each([...RECORDED, ...LARGE, ...FUZZED, MARKED])(
    "hands each tab of a document as the tab pruned whole is cut: $name", ({ tabs }) => {
      for (let { cut, sizes } of CUTS) {
        expect(read(documentOf(tabs), sizes), cut).toStrictEqual(tabs.map(tab => whole(tab, sizes)));
      }
      // The sizes a tab is cut to where none are given.
      expect(read(documentOf(tabs)).map(tab => tab.runs.map(run => run.json)))
        .toEqual(tabs.map(tab => whole(tab, RUN_SIZES).runs.map(run => run.json)));
    });

  it("hands the write markers a tab holds, each once, and none of its other ranges", () => {
    expect(read(documentOf(MARKED.tabs)).map(tab => tab.writeMarkers)).toEqual([
      [{ writeId: "w1", id: "marker-1" }, { writeId: "w1", id: "marker-2" }, { writeId: "w2", id: "marker-3" }],
      [],
      [{ writeId: "w3", id: "marker-4" }],
    ]);
  });

  it("reads nothing of the document until its tabs are read, and a tab's body only as its " +
    "runs are read", () => {
    let document = documentOf(distinctTabs([linesTab(12), linesTab(12)]));
    let tabReads: number[] = [];
    let bodyReads: number[][] = document.tabs.map(() => []);
    for (let [at, tab] of document.tabs.entries()) {
      tab.body.content = watched(tab.body.content, index => bodyReads[at].push(index));
    }
    document.tabs = watched(document.tabs, index => tabReads.push(index));

    let fetched = fetchedDoc(document, 0, FORCED);
    expect(tabReads).toEqual([]);
    expect(bodyReads).toEqual([[], []]);

    let tabs = fetched.tabs[Symbol.iterator]();
    let first = tabs.next().value as FetchedDocTab;
    // Its first index is read off its first element; nothing else of its body is.
    expect(tabReads).toEqual([0]);
    expect(new Set(bodyReads[0])).toEqual(new Set([0]));
    expect(bodyReads[1]).toEqual([]);

    let runs = first.runs[Symbol.iterator]();
    let run = runs.next().value as CutRun;
    let indexes = new Set(bodyReads[0]);
    // The elements of the run, and at most the one the cut read to know the run had ended.
    expect(run.elements.length).toBeGreaterThan(0);
    expect(run.elements.length).toBeLessThan(12);
    expect(Math.max(...indexes)).toBeLessThanOrEqual(run.elements.length);
    expect(indexes.size).toBeGreaterThanOrEqual(run.elements.length);
    expect(tabReads).toEqual([0]);
    expect(bodyReads[1]).toEqual([]);
  });

  it.each([
    { name: "a tab of 2,000 paragraphs and two tables", tabs: () => [linesTab(2_000, [600, 1_400])] },
    { name: "a document of 30 tabs", tabs: () => Array.from({ length: 30 }, () => linesTab(40, [9])) },
  ])("has emptied every element it has read when a run is handed over, and every tab it has " +
    "passed: $name", ({ tabs }) => {
    let document = documentOf(distinctTabs(tabs()));
    // What the answer holds before the walk, to tell a slot the walk has not reached.
    let sent = document.tabs.map(tab => [...tab.body.content]);
    let contents = document.tabs.map(tab => tab.body.content);
    let lastRead = document.tabs.map(() => -1);
    // Reads of an element while one before it is still in the answer.
    let readBeforeRelease = 0;
    for (let [at, tab] of document.tabs.entries()) {
      let content = contents[at];
      tab.body.content = watched(content, index => {
        lastRead[at] = Math.max(lastRead[at], index);
        for (let below = 0; below < index; below++) {
          if (content[below] !== undefined) readBeforeRelease++;
        }
      });
    }
    let held = [...document.tabs];
    let runs = 0;
    let at = 0;

    for (let tab of fetchedDoc(document, 0).tabs) {
      // The tab handed over, and every tab before it, have left the answer.
      expect(document.tabs.map((slot, index) => index <= at ? slot === undefined : slot === held[index])
        .every(Boolean)).toBe(true);
      for (let run of tab.runs) {
        runs++;
        expect(run.elements.length).toBeGreaterThan(0);
        let content = contents[at];
        let reached = lastRead[at] + 1;
        expect(content.slice(0, reached).every(slot => slot === undefined)).toBe(true);
        expect(content.slice(reached).every((slot, index) => slot === sent[at][reached + index]))
          .toBe(true);
        expect(readBeforeRelease).toBe(0);
      }
      expect(contents[at].every(slot => slot === undefined)).toBe(true);
      expect(contents[at]).toHaveLength(sent[at].length);
      at++;
    }

    expect(at).toBe(held.length);
    expect(runs).toBeGreaterThan(held.length);
    expect(document.tabs).toEqual(held.map(() => undefined));
  });

  it.each(["body", "content"] as const)(
    "throws for a tab with no %s when that tab is reached, and not before", part => {
      let document = documentOf(distinctTabs([linesTab(4), linesTab(4), linesTab(4)]));
      let holder: { body?: { content?: unknown } } = document.tabs[1];
      if (part === "body") delete holder.body;
      else delete holder.body?.content;

      let tabs = fetchedDoc(document, 0, FORCED).tabs[Symbol.iterator]();
      let first = tabs.next().value as FetchedDocTab;
      expect([...first.runs].map(run => run.json))
        .toEqual(whole(linesTab(4), FORCED).runs.map(run => run.json));

      let error: unknown;
      try {
        tabs.next();
      } catch (thrown) {
        error = thrown;
      }
      expect(error).toBeInstanceOf(TypeError);
      expect((error as Error).message).toBe(`Google Docs returned a part without its ${part}`);
    });

  it("throws for an element the pruning refuses when that element is reached", () => {
    let refused = 7;
    let tab = linesTab(12);
    let holder: { paragraph?: { paragraphStyle?: unknown } } = tab.body.content[refused];
    delete holder.paragraph?.paragraphStyle;
    let before = { ...tab, body: { content: tab.body.content.slice(0, refused) } };

    let [fetched] = fetchedDoc(documentOf([tab]), 0, FORCED).tabs;
    let runs: CutRun[] = [];
    let message = thrownMessage(() => {
      for (let run of fetched.runs) runs.push(copiedRun(run));
    });

    expect(message).toBe("Google Docs returned a part without its paragraphStyle");
    expect(message).toBe(thrownMessage(() => pruneTab(tab)));
    // The runs before the element were handed over; the run the cut was building was not.
    let cut = whole(before, FORCED).runs;
    expect(runs.length).toBeGreaterThan(0);
    expect(runs).toStrictEqual(cut.slice(0, runs.length));
    expect(cut.length - runs.length).toBeLessThanOrEqual(1);
  });

  it("throws for malformed named ranges when their tab is opened", () => {
    let document = documentOf(distinctTabs([linesTab(4), linesTab(4)]));
    Object.assign(document.tabs[1], { namedRanges: { kept: { namedRanges: "none" } } });

    let tabs = fetchedDoc(document, 0).tabs[Symbol.iterator]();
    expect([...(tabs.next().value as FetchedDocTab).runs]).toHaveLength(1);

    expect(thrownMessage(() => tabs.next())).toBe("Google Docs returned invalid named ranges");
  });

  it("leaves the revision out where Google sent none", () => {
    let unrevised = fetchedDoc(documentOf([linesTab(1)]), 1_700_000_000_000);
    let revised = fetchedDoc(documentOf([linesTab(1)], "revision-7"), 42);

    expect("revision" in unrevised).toBe(false);
    expect(unrevised.fetchedAt).toBe(1_700_000_000_000);
    expect(revised.revision).toBe("revision-7");
    expect(revised.fetchedAt).toBe(42);
  });

  it.each([{ start: "1.5", startIndex: 1.5 }, { start: 'the string "1"', startIndex: "1" }])(
    "counts a tab from 0 where its first element starts at $start, as the cut does",
    ({ startIndex }) => {
      let tab = linesTab(12, [5]);
      Object.assign(tab.body.content[0], { startIndex });

      for (let { cut, sizes } of CUTS) {
        let [fetched] = read(documentOf([tab]), sizes);
        expect(fetched, cut).toStrictEqual(whole(tab, sizes));
        expect(fetched.first, cut).toBe(0);
      }
    });

  it("hands an empty body as one run of no element", () => {
    let empty = { ...linesTab(1), body: { content: [] } };

    expect(read(documentOf([empty]))).toStrictEqual([{
      ...whole(empty, RUN_SIZES),
      first: 0,
      runs: [{ json: "[]", elements: [], size: 0, footnotes: 0, holds: "element" }],
      unindexed: false,
    }]);
  });
});
