// Whether the model follows a stored Google Doc tab kept under another digest of the code: the
// store asks it run by run, one run in hand at a time, and its record says it from then on.

import { createSimulationStore } from "@gadgets/gatekeeper-kit/simulation-store";
import { describe, expect, it } from "vitest";
import type { GoogleDocsTab } from "../src/docs-api";
import { hasModelFootnotes, hasModelIndexes, unindexedTabRefusal } from "../src/docs-model";
import { docTabReducer, type QueuedDocRecord } from "../src/docs-replay";
import type { RunSizes } from "../src/docs-runs";
import { DocStore, docStoreCost, type DocVersion } from "../src/docs-store";
import { MARKDOWN_RENDERING_VERSION } from "../src/markdown-converter";
import { BULLET_LIST, buildTab, footnote, item, para } from "./doc-fixture";
import { fakeDocStorage, type FakeDocStorage } from "./doc-store-fake";
import { RUNS_OF_THREE, scenarioBase, under, wholeTabsFetched } from "./doc-store-scenarios";
import { linesTab } from "./docs-fetched-corpus";
import { asFetched } from "./docs-store-slice-shadow";

/** A run an element. */
const ONE_EACH: RunSizes = { ...RUNS_OF_THREE, elements: 1 };

describe("whether the model follows a version of another digest", () => {
  const append = (tabId: string): QueuedDocRecord => ({
    id: 1,
    action: { type: "appendText", markdown: "More", tabId, markdownVersion: MARKDOWN_RENDERING_VERSION },
  });
  /** What a replay refuses an append to `version` with, where it does. */
  const refusalOf = (store: DocStore, version: DocVersion) =>
    createSimulationStore(docTabReducer(store)).fold(version.tabId, version, [append(version.tabId)])
      .refused.map(({ refusal }) => refusal);
  const UNINDEXED = [{ reason: unindexedTabRefusal("appendText").message, unindexed: true }];

  /** `tab` kept under another digest and asked of the default store twice, the walk's cost held. */
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
    // Every tab above fails on an index; these, a reference to a run, fail on footnotes alone.
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
});
