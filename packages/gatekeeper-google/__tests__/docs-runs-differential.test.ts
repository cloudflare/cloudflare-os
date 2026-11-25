// Every recorded step and drawn edit chains give the same pending reads, cards and results in
// hand, in a store under its own sizes and in one that cuts a run an element.

import { describe, expect, it } from "vitest";
import { googleDocDisplayLimit } from "../src/doc-actions";
import type { GoogleDocsTab } from "../src/docs-api";
import {
  DocEditRefusedError, docEditResult, makeDocEdit, renderTab, type DocEdit,
} from "../src/docs-replay";
import { pruneTab } from "../src/docs-replica";
import type { RunSizes } from "../src/docs-runs";
import { DocStore, type DocCopyHead, type DocPending, type DocVersion } from "../src/docs-store";
import { prepareAppend, prepareTextReplacement } from "../src/docs-table-actions";
import { docTabToMarkdown } from "../src/markdown-converter";
import { diceOf } from "./doc-fixture";
import { fakeDocStorage, type FakeDocStorage } from "./doc-store-fake";
import { wholeTabsFetched } from "./doc-store-scenarios";
import { readFixtures } from "./docs-live-fixtures";
import { SCENARIOS, stepEdit } from "./docs-live-recorder";
import { largeTabs, summaryOf, throughJson } from "./render-run-tabs";

const DOC = "doc";
const NONE: DocPending = { edits: [], roots: [] };
const LABEL = "\"Main\" (tab-1)";
/** Sizes that cut a tab into a run an element. */
const FORCED: RunSizes = { least: 0, target: 400, most: Infinity, elements: 1 };

/** A store, and the version of the tab a step is made in. */
type Path = { storage: FakeDocStorage; store: DocStore; sizes?: RunSizes; version?: DocVersion };

/** The two stores a tab is held in beside the tab in hand: whole runs, and forced ones. */
function storedPaths(): Path[] {
  return [undefined, FORCED].map(sizes => {
    let storage = fakeDocStorage();
    return { storage, store: new DocStore(storage, undefined, undefined, sizes), sizes };
  });
}

/** Keeps `tab` as the document's copy in each store, over the copy it holds, as a fetch does. */
function keepIn(paths: Path[], tab: GoogleDocsTab, revision: string): void {
  for (let path of paths) {
    let head: DocCopyHead = path.store.keep(
      DOC, wholeTabsFetched({ revision, fetchedAt: 1_000, tabs: [{ tab, writeMarkers: [] }] }, path.sizes), NONE);
    path.version = path.store.version(
      DOC, head.versions[0], { ...head.outline[0], writeMarkers: head.writeMarkers[0] });
  }
}

/** How many runs the version a path stands at is stored as. */
const runsOf = ({ storage, version }: Path) => storage.sql.exec<{ runs: number }>(
  "SELECT count(*) AS runs FROM doc_seq WHERE version = ?", version!.id).one().runs;

/** What `run` answers, or the reason it refuses with. Anything but a refusal is a defect. */
function outcome<T>(run: () => T): { value: T } | { refused: string } {
  try {
    return { value: run() };
  } catch (error) {
    if (error instanceof DocEditRefusedError) return { refused: error.refusal.reason };
    if (!(error instanceof Error) || error instanceof TypeError) throw error;
    return { refused: error.message };
  }
}

/** Holds that the version each path stands at reads as `tab` reads in hand. */
function expectReads(paths: Path[], tab: GoogleDocsTab, where: string): void {
  let whole = docTabToMarkdown(tab);
  let summary = summaryOf(whole);
  for (let { store, version } of paths) {
    expect(store.markdown(version!), where).toBe(whole.markdown);
    expect(store.summary(version!), where).toEqual(summary);
    expect(store.tab(version!), where).toEqual(tab);
  }
}

/**
 * Makes `edit` in hand and on each path, holding card, result and pending read alike. Answers the
 * tab it gives and moves each path on, or `undefined` where all three refuse.
 */
function expectSameStep(
  paths: Path[], tab: GoogleDocsTab, edit: DocEdit, where: string,
): GoogleDocsTab | undefined {
  if (edit.type === "appendText" || edit.type === "replaceText") {
    let cards = paths.map(({ store, version }) => outcome(() => edit.type === "appendText"
      ? prepareAppend(store, version!, edit.markdown)
      : prepareTextReplacement(
          store, version!, edit.oldMarkdown, edit.newMarkdown, LABEL,
          googleDocDisplayLimit("replaceText"))));
    expect(cards[1], where).toEqual(cards[0]);
  }
  let inHand = outcome(() => makeDocEdit(tab, edit, renderTab(tab)));
  let stored = paths.map(({ store, version }) => outcome(() => docEditResult(store, version!, edit)));
  if ("refused" in inHand) {
    for (let made of stored) expect(made, where).toEqual(inHand);
    return undefined;
  }
  for (let [at, made] of stored.entries()) {
    if ("refused" in made) throw new Error(`${where}: refused by a store alone: ${made.refused}`);
    expect(made.value.requests, where).toEqual(inHand.value.requests);
    paths[at].version = made.value.after;
  }
  expectReads(paths, inHand.value.after, where);
  return inHand.value.after;
}

// Counted by the recordings' tests for the file's last test.
const corpus = { tabs: 0, runs: 0, steps: 0, applied: 0 };

describe("the path through runs against the path with a tab whole", () => {
  it.each(readFixtures().map(fixture => [fixture.name, fixture] as const))(
    "the recording %s", (name, { before, steps }) => {
      let scenario = SCENARIOS.find(candidate => candidate.name === name)!;
      expect(scenario.steps.map(step => step.name)).toEqual(steps.map(step => step.name));
      let paths = storedPaths();
      for (let [at, step] of scenario.steps.entries()) {
        let where = `${name}, step ${at + 1} (${step.name})`;
        // The tab Google returned before the step, kept over the copy of the step before.
        let tab = pruneTab(throughJson(at === 0 ? before : steps[at - 1].after));
        keepIn(paths, tab, `r${at}`);
        corpus.tabs++;
        corpus.runs += runsOf(paths[1]);
        expectReads(paths, tab, `${where}, before`);

        let edit = outcome(() => stepEdit(step, docTabToMarkdown(tab)));
        corpus.steps++;
        if ("refused" in edit) continue;
        if (expectSameStep(paths, tab, edit.value, where)) corpus.applied++;
      }
    });

  // Ten edits each, every one made in the tab the one before gave.
  it.each([
    ["paragraphs with footnotes", 20261117, 10],
    ["protected content", 20261118, 8],
    ["tables between lists", 20261119, 7],
  ] as const)("a chain of ten edits in %s", (name, seed, applies) => {
    let { below, pick } = diceOf(seed);
    let tab = pruneTab(throughJson(largeTabs(20).find(large => large.name === name)!.tab));
    // Google sends no start index on the section break that opens a body.
    delete (tab.body.content[0] as { startIndex?: number }).startIndex;
    let paths = storedPaths();
    keepIn(paths, tab, "r1");
    expect(runsOf(paths[1])).toBeGreaterThan(2);
    expectReads(paths, tab, `${name}, as kept`);
    let applied = 0;
    for (let turn = 0; turn < 10; turn++) {
      let view = docTabToMarkdown(tab);
      // An append, or a replacement of one of the labels the tab's blocks hold.
      let labels = view.markdown.match(/[A-Z][a-z]+ (?:[A-Z][a-z]+ )?\d{5}\./g) ?? [];
      let edit = outcome(() => stepEdit(below(4) === 0 || labels.length === 0
        ? { name: "append", append: `Appended ${turn}.` }
        : { name: "replace", replace: [pick(labels), `Changed ${turn}.`] }, view));
      if ("refused" in edit) continue;
      let after = expectSameStep(paths, tab, edit.value, `${name}, edit ${turn + 1}`);
      if (after) {
        tab = after;
        applied++;
      }
    }
    expect(applied).toBe(applies);
  });

  // The file's tests run in order: this one reads what the recordings' tests counted.
  it("ran every recorded step on tabs of several runs", () => {
    expect([readFixtures().length, corpus.steps]).toEqual([35, 209]);
    expect(corpus.runs / corpus.tabs).toBeGreaterThan(2);
    expect(corpus.applied).toBeGreaterThanOrEqual(150);
  });
});
