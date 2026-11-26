import { readFileSync } from "node:fs";
import path from "node:path";
import { createSimulationStore } from "@gadgets/gatekeeper-kit/simulation-store";
import { describe, expect, it, vi } from "vitest";
import type { GoogleDocsRequest, GoogleDocsTab } from "../src/docs-api";
import * as model from "../src/docs-model";
import {
  applyDocsRequests, hasModelFootnotes, hasModelIndexes, isModelIndexed, replayCost,
  unindexedTabRefusal,
} from "../src/docs-model";
import { storedTabReading, unwrapped } from "../src/docs-reading";
import {
  docEditKey, docEditResult, docTabReducer, renderTab, type DocEdit, type DocRefusal,
  type QueuedDocRecord,
} from "../src/docs-replay";
import { DOC_COPY_FORMAT_VERSION, DOC_COPY_UNREADABLE, pruneTab } from "../src/docs-replica";
import {
  DOC_COPY_APPROVAL_GRAIN_MS, DOC_ROW_BYTES, DOC_STORE_FORMAT, DocRowTooLargeError, DocStore,
  docStoreCost, heldDoc, runId, type DocCopyHead, type DocPending, type DocRunSummary,
  type DocStoreCost, type DocVersion, type StoredRun,
} from "../src/docs-store";
import { cutRuns, RUN_SIZES, type RunSizes } from "../src/docs-runs";
import { tableCellCount, tableShape } from "../src/docs-tables";
import {
  advanceCarry, docTabToMarkdown, initialCarry, joinRenderedRun, MARKDOWN_RENDERING_VERSION,
  renderRun, type DocTabSnapshot,
} from "../src/markdown-converter";
import {
  buildTab, BULLET_LIST, footnote, grid, item, NUMBERED_LIST, para, tableAt, type BlockSpec,
  type Lists,
} from "./doc-fixture";
import { fakeDocStorage, fakeDocStore, type FakeDocStorage } from "./doc-store-fake";
import { readFixtures } from "./docs-live-fixtures";
import { appendRun, largeTabs, summaryOf, throughJson } from "./render-run-tabs";
import {
  ANOTHER_DIGEST_SCENARIO, anotherDigestScenario, CAP_COST, CAP_COST_PAIRS, capCostScenario,
  countedStorage, fetchedRows, listRunsTab, proseTab, RUNS_OF_THREE, scenarioEdit,
  spent as statementsSpent, STORE_SCENARIO, storedRows, storeScenario, SWEEP_COST, SWEEP_COST_PAIRS,
  sweepCostScenario, tableScans, tinyTablesTab, wholeTabsFetched, type CapCase, type SweepCase,
  type WholeTabsFetched,
} from "./doc-store-scenarios";

// The SHA-256 of `text`'s UTF-8 as the Web Crypto API gives it, in lowercase hex.
async function subtleSha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("runId", () => {
  it("is the SHA-256 of the string's UTF-8, as 64 lowercase hex digits", () => {
    expect(runId("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(runId("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(runId('{"paragraph":{}}')).toMatch(/^[0-9a-f]{64}$/);
  });

  it("agrees with crypto.subtle on text outside ASCII", async () => {
    // Latin-1, CJK and an astral character: two, three and four bytes of UTF-8.
    const json = JSON.stringify({ latin: "café", cjk: "文書", astral: "\u{1F600}" });

    expect(runId(json)).toBe(await subtleSha256(json));
  });

  it("names two strings that differ by one character differently, and the same string the same", () => {
    const json = (text: string) => JSON.stringify([{ paragraph: { text } }]);

    expect(runId(json("onE"))).not.toBe(runId(json("one")));
    expect(runId(json("one"))).toBe(runId(json("one")));
  });
});

const DOC = "doc";
const NONE: DocPending = { edits: [], roots: [] };

/** A pruned tab named `tabId` that holds `blocks`, as Google sends one. */
function tabOf(tabId: string, blocks: BlockSpec[], lists?: Lists): GoogleDocsTab {
  let tab = pruneTab({ ...buildTab(blocks, lists), tabId, title: `Tab ${tabId}` });
  // Google sends no start index on the section break that opens a body.
  delete (tab.body.content[0] as { startIndex?: number }).startIndex;
  return tab;
}

/** Sizes that cut a tab into runs of one element each. */
const ONE: RunSizes = { ...RUN_SIZES, elements: 1 };

/** The names of the runs `tab` is stored as under `sizes`, in order. */
const runIds = (tab: GoogleDocsTab, sizes: RunSizes = RUN_SIZES) =>
  [...cutRuns(tab.body.content, sizes)].map(run => runId(run.json));

const PROSE = () => tabOf("t1", [para("One"), para("Two")]);
const NOTES = () => tabOf("t2", [para("Notes"), grid(["a", "b"], ["c", "d"]), para("End")]);

/** A document of `tabs` as a keep takes it, with no write marker, its runs cut to `sizes`. */
function copyOf(
  tabs: GoogleDocsTab[], more: { revision?: string; fetchedAt?: number } = {},
  sizes: RunSizes = RUN_SIZES,
): WholeTabsFetched {
  return wholeTabsFetched(
    { revision: "r1", fetchedAt: 1_000, tabs: tabs.map(tab => ({ tab, writeMarkers: [] })), ...more },
    sizes);
}

function opened(
  format?: string, made?: string, sizes?: RunSizes,
): { storage: FakeDocStorage; store: DocStore } {
  let storage = fakeDocStorage();
  return { storage, store: new DocStore(storage, format, made, sizes) };
}

/** The base version of the `at`-th tab of the copy `head` names. */
function baseOf(store: DocStore, head: DocCopyHead, at = 0, doc = DOC): DocVersion {
  let version = store.version(doc, head.versions[at], {
    ...head.outline[at], writeMarkers: head.writeMarkers[at],
  });
  if (!version) throw new Error("The copy's base version is not stored.");
  return version;
}

/** The requests that type `text` at the start of `tab`'s first paragraph. */
function typing(tab: GoogleDocsTab, text: string): GoogleDocsRequest[] {
  return [{ insertText: { location: { index: 1, tabId: tab.tabId }, text } }];
}

/** Makes the edit keyed `edit` in `version` as a reducer does, typing at the tab's start. */
const edited = scenarioEdit;

/** The version the edit keyed `e1` gave in `version`, read back. */
function scenarioBaseResult(store: DocStore, version: DocVersion): DocVersion {
  let found = store.result(version, "e1");
  if (!found || !("after" in found)) throw new Error("The edit's result is not stored.");
  return found.after;
}

/**
 * The store's costs a test measures: the ingest peak, the widenings and a card's span
 * comparisons are measured where asked.
 */
type Spent = Omit<
  DocStoreCost, "ingestPeakBufferedBytes" | "viewWidenings" | "pieceWidenings" | "spanCharsCompared"
>;

/** What `run` spent in the store: the counts' differences, and the peaks from 0. */
function spent(run: () => unknown): Spent {
  let before = { ...docStoreCost };
  docStoreCost.peakRunBytesInHand = 0;
  docStoreCost.peakMarkdownCharsInHand = 0;
  run();
  return {
    runsDecoded: docStoreCost.runsDecoded - before.runsDecoded,
    runsRendered: docStoreCost.runsRendered - before.runsRendered,
    runsKeyed: docStoreCost.runsKeyed - before.runsKeyed,
    peakRunBytesInHand: docStoreCost.peakRunBytesInHand,
    peakMarkdownCharsInHand: docStoreCost.peakMarkdownCharsInHand,
    rowsWritten: docStoreCost.rowsWritten - before.rowsWritten,
    resultsStored: docStoreCost.resultsStored - before.resultsStored,
    resultsFound: docStoreCost.resultsFound - before.resultsFound,
  };
}

/** The summary of `version` as storage holds it: read with no run decoded and nothing rendered. */
function storedSummary(store: DocStore, version: DocVersion): DocRunSummary {
  let summary: DocRunSummary | undefined;
  let cost = spent(() => summary = store.summary(version));
  expect(cost).toMatchObject({ runsDecoded: 0, runsRendered: 0, rowsWritten: 0 });
  if (!summary) throw new Error("The summary was not read.");
  return summary;
}

/** The statements `run` gave storage that no earlier call had. */
function newStatements(storage: FakeDocStorage, run: () => unknown): string[] {
  let before = new Set(storage.statements());
  run();
  return storage.statements().filter(statement => !before.has(statement));
}

/** How many rows each table of documents holds. */
function counts(storage: FakeDocStorage): Record<string, number> {
  return Object.fromEntries(Object.entries(storage.rows())
    .filter(([table]) => table !== "doc_format")
    .map(([table, rows]) => [table, rows.length]));
}

const EMPTY = { doc_copy: 0, doc_md: 0, doc_result: 0, doc_run: 0, doc_seq: 0, doc_version: 0 };

/** The UTF-16 code units of `text`, in hex: a test's message cannot print half of a surrogate pair. */
const units = (text: string) => Array.from(text, unit => unit.charCodeAt(0).toString(16));

/** The names of `table`'s columns, in the order they were declared. */
const columnsOf = (storage: FakeDocStorage, table: string) =>
  storage.sql.exec<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`).toArray()
    .map(({ name }) => name);

type Row = Record<string, unknown>;
const rowsOf = (storage: FakeDocStorage, table: string) => storage.rows()[table] as Row[];

/** The piece at the end of `version`, as a reading makes it; storage's errors pass through. */
const pieceAtEnd = (store: DocStore, version: DocVersion): DocTabSnapshot =>
  unwrapped(() => storedTabReading(store, version).piece("end"));

describe("DocStore", () => {
  it("stores a tab as its runs, its context and a version, and decodes it back", () => {
    let { storage, store } = opened();
    let tab = tabOf("t1", [para("One"), item("first", "N1"), grid(["a", "b"])], NUMBERED_LIST);
    let runs = runIds(tab);

    let version = store.putTab(DOC, tab, []);

    // Two runs, each rendered as stored: the break, paragraph and list item, then the table alone.
    expect(runs).toHaveLength(2);
    expect(counts(storage)).toEqual({ ...EMPTY, doc_run: 3, doc_md: 2, doc_seq: 2, doc_version: 1 });
    expect(rowsOf(storage, "doc_seq").map(row => row.run)).toEqual(runs);
    expect(rowsOf(storage, "doc_md").map(row => row.run).toSorted()).toEqual(runs.toSorted());
    expect(rowsOf(storage, "doc_run").map(row => row.id).toSorted()).toEqual([
      ...runs, runId(JSON.stringify({ lists: tab.lists })),
    ].toSorted());
    expect(version).toMatchObject({ tabId: "t1", title: "Tab t1", doc: DOC, exact: false });
    expect(version.bodyEndIndex).toBe(tab.body.content.at(-1)!.endIndex);
    let decoded = store.tab(version);
    expect(decoded).toEqual(tab);
    expect(Object.keys(decoded)).toEqual(Object.keys(tab));
    expect(docTabToMarkdown(decoded)).toEqual(docTabToMarkdown(tab));
  });

  it("names a version by its document, its tab's id, its context and its runs", () => {
    let { store } = opened();
    let tab = tabOf("t1", [item("first", "N1")], NUMBERED_LIST);
    let { id } = store.putTab(DOC, tab, []);

    expect(spent(() => expect(store.putTab(DOC, tab, []).id).toBe(id)).rowsWritten).toBe(0);
    expect(store.putTab("other", tab, []).id).not.toBe(id);
    expect(store.putTab(DOC, { ...tab, tabId: "t9" }, []).id).not.toBe(id);
    let lists: Lists = { N1: { listProperties: { nestingLevels: [{ glyphType: "ALPHA" }] } } };
    expect(store.putTab(DOC, { ...tab, lists }, []).id).not.toBe(id);
    expect(store.putTab(DOC, tabOf("t1", [item("second", "N1")], NUMBERED_LIST), []).id).not.toBe(id);
  });

  it("names a version without storing it", () => {
    let { storage, store } = opened();
    let tab = PROSE();

    let id = "";
    expect(newStatements(storage, () => id = store.versionId(DOC, tab))).toEqual([]);
    expect(counts(storage)).toEqual(EMPTY);
    expect(store.putTab(DOC, tab, []).id).toBe(id);
  });

  // The refetch after a write's marker is removed must find what was stored for the tab.
  it("a tab fetched again with another marker, title or place is the same version", () => {
    let { store } = opened();
    let tab = PROSE();
    let marker = { writeId: "w1", id: "kix.1" };

    let first = store.putTab(DOC, tab, []);
    let child = edited(store, first, "e1");
    let cost = spent(() => {
      let marked = store.putTab(DOC, tab, [marker]);
      expect(marked).toEqual({ ...first, writeMarkers: [marker] });
    });
    let moved = { ...tab, title: "Renamed", index: 3, nestingLevel: 1, parentTabId: "t0" };
    let last = store.putTab(DOC, moved, [marker]);

    expect(cost.rowsWritten).toBe(0);
    expect(spent(() => store.putTab(DOC, moved, [marker])).rowsWritten).toBe(0);
    expect(last).toEqual({
      tabId: "t1", title: "Renamed", parentTabId: "t0", index: 3, nestingLevel: 1,
      id: first.id, doc: DOC, bodyEndIndex: first.bodyEndIndex, exact: false, writeMarkers: [marker],
    });
    let found = store.result(last, "e1");
    expect(found).toMatchObject({ after: { id: child.id, title: "Renamed", index: 3, writeMarkers: [marker] } });
  });

  // A kept view reads markers from its record, so a marker or a title alone names another copy.
  it("a copy that differs only by a marker, or only by a title, is another copy over the same versions", () => {
    let { storage, store } = opened();
    let first = store.keep(DOC, copyOf([PROSE(), NOTES()]), NONE);
    let marker = { writeId: "w1", id: "kix.1" };
    let marked = wholeTabsFetched({
      revision: "r1", fetchedAt: 2_000,
      tabs: [{ tab: PROSE(), writeMarkers: [marker] }, { tab: NOTES(), writeMarkers: [] }],
    });
    let renamed = copyOf([PROSE(), { ...NOTES(), title: "Renamed" }], { fetchedAt: 3_000 });

    let kept = [marked, renamed].map(copy => {
      let id = heldDoc(DOC, copy).id;
      let cost = spent(() => expect(store.keep(DOC, copy, NONE).id).toBe(id));
      // The copy's record is the one row written: every version of it was stored.
      expect(cost.rowsWritten).toBe(1);
      expect(store.holds(DOC, first.id)).toBe(false);
      return store.head(DOC)!;
    });

    expect(new Set([first.id, kept[0].id, kept[1].id]).size).toBe(3);
    for (let head of kept) expect(head.versions).toEqual(first.versions);
    expect(kept[0]).toMatchObject({ writeMarkers: [[marker], []], outline: first.outline });
    expect(kept[1].writeMarkers).toEqual(first.writeMarkers);
    expect(kept[1].outline.map(tab => tab.title)).toEqual(["Tab t1", "Renamed"]);
    expect(counts(storage)).toMatchObject({ doc_copy: 1, doc_version: 2 });
  });

  it("writes nothing for a run, a context or a version it already holds, and hands storage no content it holds", () => {
    let { storage, store } = opened();
    let tab = NOTES();
    store.putTab(DOC, tab, []);
    let before = storage.rows();

    let statements: string[] = [];
    storage.refuse(statement => {
      statements.push(statement);
      return false;
    });
    let cost = spent(() => store.putTab(DOC, tab, []));

    expect(cost).toMatchObject({ rowsWritten: 0, runsRendered: 0 });
    expect(statements.filter(statement => /INSERT|UPDATE|DELETE/.test(statement))).toEqual([]);
    expect(storage.rows()).toEqual(before);
  });

  it("a read of a stored tab decodes nothing, renders nothing and writes no row", () => {
    let { store } = opened();
    let tab = NOTES();
    let { markdown } = docTabToMarkdown(tab);

    // Three runs, the table alone in the second, each rendered alone as the tab is stored.
    let stored = spent(() => store.putTab(DOC, tab, []));
    let version = store.putTab(DOC, tab, []);
    let first = spent(() => expect(store.markdown(version)).toBe(markdown));
    let second = spent(() => expect(store.markdown(version)).toBe(markdown));

    expect(stored).toMatchObject({ runsDecoded: 0, runsRendered: 3 });
    expect(first).toMatchObject({ runsDecoded: 0, runsRendered: 0, rowsWritten: 0 });
    expect(second).toMatchObject({ runsDecoded: 0, runsRendered: 0, rowsWritten: 0 });
    expect(first.peakRunBytesInHand).toBe(0);
    expect(second.peakRunBytesInHand).toBe(0);
  });

  // SQLite's TEXT has no half of a surrogate pair: stored as it is, it reads back as U+FFFD.
  it("reads back the Markdown it stored, half of a surrogate pair and a leading mark included", () => {
    for (let [at, text] of ["tail \ud83d end", "\udc00", "\u0001 marked", "\u0001\"quoted\\"].entries()) {
      let { storage, store } = opened();
      let tab = tabOf(`t${at}`, [para("One"), para(text)]);
      let rendering = docTabToMarkdown(tab);
      expect(rendering.markdown).toContain(text);

      let version = store.putTab(DOC, tab, []);
      // Read from its row each time: the tab is one run, rendered when it was stored.
      for (let read = 0; read < 3; read++) {
        expect(units(store.markdown(version)), `${at}, read ${read}`).toEqual(units(rendering.markdown));
      }

      expect(storedSummary(store, version).markdownLength).toBe(rendering.markdown.length);
      expect(String(rowsOf(storage, "doc_md")[0].md).isWellFormed()).toBe(true);
    }
  });

  it("stores well-formed Markdown as it is", () => {
    let { storage, store } = opened();
    let tab = tabOf("t1", [para("\"One\" \u{1F600}"), para("Two")]);
    let version = store.putTab(DOC, tab, []);

    expect(store.markdown(version)).toBe(docTabToMarkdown(tab).markdown);
    expect(rowsOf(storage, "doc_md")[0].md).toBe(docTabToMarkdown(tab).markdown);
  });

  it("summarises a rendering: its length, whether it is blank, its counts", () => {
    let { store } = opened();
    // A table of contents and a paragraph that holds a chip are each a protected range.
    let tab = tabOf("t1", [
      para("One"), { structure: "tableOfContents" }, item("first", "N1"), item("second", "N1"),
      { runs: ["Ask ", { person: { email: "someone@example.com" } }, "\n"] },
    ], NUMBERED_LIST);
    let rendering = docTabToMarkdown(tab);

    let summary = {
      markdownLength: rendering.markdown.length,
      blank: false,
      blocks: rendering.sourceMap.blocks.length,
      protectedRanges: 2,
      numberedItems: true,
      tables: [],
    };
    // What storing summarised of the runs is what storage answers after, whatever the runs.
    let summarised = (of: GoogleDocsTab) => {
      let version = store.putTab(DOC, of, []);
      let made = store.summary(version);
      expect(storedSummary(store, version)).toEqual(made);
      return made;
    };

    expect(rendering.sourceMap.protectedRanges).toHaveLength(2);
    expect(rendering.sourceMap.blocks.length).not.toBe(2);
    expect(summarised(tab)).toEqual(summary);
    // The same tab as six runs of one element: the runs' summaries joined are the tab's.
    let other = opened(undefined, undefined, ONE).store;
    expect(storedSummary(other, other.putTab(DOC, tab, []))).toEqual(summary);
    expect(summarised(tabOf("t2", [para("")]))).toMatchObject({
      blank: true, numberedItems: false, blocks: 1,
    });
    expect(summarised(PROSE())).toMatchObject({ blank: false, numberedItems: false });
    // A chip with no label renders as nothing and is protected: the tab is not blank.
    let chip = tabOf("t3", [{ runs: [{ richLink: { title: "", uri: "https://example.com/" } }, "\n"] }]);
    expect(summarised(chip)).toMatchObject({ blank: false, markdownLength: 1, protectedRanges: 1 });
    // The same of a rendering a read of the Markdown stored.
    for (let [read, held] of [
      [tabOf("t4", [para("")]), { blank: true, protectedRanges: 0, blocks: 1 }],
      [{ ...chip, tabId: "t5" }, { blank: false, markdownLength: 1, protectedRanges: 1 }],
    ] as const) {
      let version = store.putTab(DOC, read, []);
      store.markdown(version);
      expect(storedSummary(store, version)).toMatchObject(held);
    }
  });

  it("summarises each table: where it starts, its shape, its cells, whether it holds a numbered list, where its Markdown lies", () => {
    let { store } = opened();
    let tab = tabOf("t1", [
      para("Before"), grid(["a", "b"], ["c", "d"]), para("Between"),
      { table: [[{ paragraphs: [item("one", "N1"), item("two", "N1")] }]] }, para("After"),
      { table: [[{ paragraphs: [item("one"), item("two")] }]] }, para("Last"),
    ], { ...NUMBERED_LIST, ...BULLET_LIST });
    let rendering = docTabToMarkdown(tab);

    let version = store.putTab(DOC, tab, []);
    let { tables } = store.summary(version);
    let markdown = store.markdown(version);

    // The third table holds a list that is not numbered.
    expect(tableAt(rendering, 2)).toContain("<li");
    expect(tables).toHaveLength(3);
    for (let [at, table] of tables.entries()) {
      let html = tableAt(rendering, at);
      expect(markdown.slice(table.mdStart, table.mdEnd)).toBe(html);
      expect(table).toEqual({
        start: rendering.sourceMap.tables[at].docStart,
        shape: runId(tableShape(html)),
        cells: tableCellCount(html),
        numbered: at === 1,
        mdStart: rendering.sourceMap.tables[at].mdStart,
        mdEnd: rendering.sourceMap.tables[at].mdEnd,
      });
    }
    expect(tables.map(table => table.cells)).toEqual([4, 2, 2]);
    expect(tables.map(table => table.numbered)).toEqual([false, true, false]);
    // Each table is a run, so its place sums the runs before it: the same under one-element runs.
    expect(storedSummary(store, version).tables).toEqual(tables);
    let other = opened(undefined, undefined, ONE).store;
    expect(storedSummary(other, other.putTab(DOC, tab, [])).tables).toEqual(tables);
  });

  it("gives two tables that read the same the same shape, whatever their numbers", () => {
    let { store } = opened();
    let numbered = { table: [[{ paragraphs: [item("one", "N1")] }]] };
    // The second table's list goes on from the first's, so its item is numbered 2.
    let tab = tabOf("t1", [numbered, para("Between"), numbered, para("After"), grid(["x"])], NUMBERED_LIST);

    let version = store.putTab(DOC, tab, []);
    let { tables } = store.summary(version);

    expect(tableAt(docTabToMarkdown(tab), 1)).not.toBe(tableAt(docTabToMarkdown(tab), 0));
    expect(tables[1].shape).toBe(tables[0].shape);
    expect(tables[2].shape).not.toBe(tables[0].shape);
    expect(storedSummary(store, version).tables).toEqual(tables);
  });

  it("says of a decoded tab what the model said of the tab stored", () => {
    let { storage, store } = opened();
    let fetched = PROSE();
    let made = applyDocsRequests(fetched, typing(fetched, "x"));
    let further = typing(made, "y");
    let costOf = (tab: GoogleDocsTab) => {
      let cost = { fullReindexes: 0 };
      applyDocsRequests(tab, further, {}, cost);
      return cost.fullReindexes;
    };

    let version = store.putTab(DOC, made, []);
    let decoded = store.tab(version);

    expect(version.exact).toBe(true);
    expect(isModelIndexed(decoded)).toBe(true);
    expect(costOf(decoded)).toBeLessThanOrEqual(costOf(made));
    // As Google sends it, the same tab is another version: a model's tab never stands for a fetch.
    let sent = store.putTab(DOC, JSON.parse(JSON.stringify(made)) as GoogleDocsTab, []);
    expect(sent.id).not.toBe(version.id);
    expect(sent.exact).toBe(false);
    expect(store.version(DOC, sent.id, sent)).toMatchObject({ id: sent.id, exact: false });
    expect(store.version(DOC, version.id, version)).toMatchObject({ id: version.id, exact: true });
    expect(isModelIndexed(store.tab(sent))).toBe(false);
    // It reads back as Google sends it: no start index on the body's opening break.
    let [opening, ...rest] = decoded.body.content;
    expect(opening).toEqual({ startIndex: 0, endIndex: 1, sectionBreak: {} });
    expect(store.tab(sent)).toEqual({
      ...decoded, body: { content: [{ endIndex: 1, sectionBreak: {} }, ...rest] },
    });
    // One run and one context under two versions, and the run's one rendering.
    expect(counts(storage)).toEqual({ ...EMPTY, doc_run: 2, doc_md: 1, doc_seq: 2, doc_version: 2 });
    // A tab as fetched is not the model's: it is indexed before a batch is applied to it.
    let base = store.putTab(DOC, fetched, []);
    expect(base.exact).toBe(false);
    expect(isModelIndexed(store.tab(base))).toBe(false);
    expect(costOf(store.tab(base))).toBeGreaterThan(costOf(decoded));
  });

  it("keeps a document: its outline, its tabs' base versions, its revision and its clocks", () => {
    let { storage, store } = opened();
    let tabs = [PROSE(), NOTES()];

    let head = store.keep(DOC, copyOf(tabs, { revision: "r7", fetchedAt: 4_000 }), NONE);

    expect(head).toEqual({
      id: head.id, revision: "r7", fetchedAt: 4_000, checkedAt: 4_000, stale: false,
      outline: tabs.map(({ tabId, title, index, nestingLevel }) => ({ tabId, title, index, nestingLevel })),
      versions: tabs.map(tab => store.versionId(DOC, tab)),
      writeMarkers: [[], []],
      made: store.head(DOC)!.made,
      bytes: head.bytes,
    });
    expect(store.head(DOC)).toEqual(head);
    expect(store.tab(baseOf(store, head, 1))).toEqual(tabs[1]);
    // One run for the first tab and three for the second, sharing a context, each rendered.
    expect(counts(storage)).toEqual({
      ...EMPTY, doc_copy: 1, doc_run: 5, doc_md: 4, doc_seq: 4, doc_version: 2,
    });
    // A copy Google reported no revision for has none, as kept and as read back: never a null.
    let bare = store.keep("bare", copyOf([PROSE()], { revision: undefined }), NONE);
    expect(bare).not.toHaveProperty("revision");
    expect(store.head("bare")).toEqual(bare);
    expect(store.head("bare")).not.toHaveProperty("revision");
    expect(store.head("absent")).toBeUndefined();
  });

  it("names a copy by its revision and its versions: the same document kept twice is one copy", () => {
    let { store } = opened();
    let first = store.keep(DOC, copyOf([PROSE(), NOTES()]), NONE);

    let again = store.keep(DOC, copyOf([PROSE(), NOTES()], { fetchedAt: 9_000 }), NONE);

    expect(again.id).toBe(first.id);
    expect(again.fetchedAt).toBe(9_000);
    expect(store.keep(DOC, copyOf([PROSE(), NOTES()], { revision: "r2" }), NONE).id).not.toBe(first.id);
    expect(store.keep(DOC, copyOf([PROSE()]), NONE).id).not.toBe(first.id);
    // A changed body under the same revision, or none, is another copy with the same outline.
    for (let revision of ["r1", undefined]) {
      let other = opened().store;
      let before = copyOf([PROSE(), NOTES()], { revision });
      let after = copyOf([tabOf("t1", [para("One"), para("Three")]), NOTES()], { revision });
      expect(heldDoc(DOC, after).id).not.toBe(heldDoc(DOC, before).id);

      let kept = other.keep(DOC, before, NONE);
      let changed = other.keep(DOC, after, NONE);

      expect(changed.id).not.toBe(kept.id);
      expect(changed.outline).toEqual(kept.outline);
      expect(changed.versions[0]).not.toBe(kept.versions[0]);
      expect(changed.versions[1]).toBe(kept.versions[1]);
      expect(other.holds(DOC, kept.id)).toBe(false);
      expect(other.holds(DOC, changed.id)).toBe(true);
    }
  });

  it("names a copy without storing it", () => {
    let { storage, store } = opened();

    for (let copy of [copyOf([PROSE(), NOTES()]), copyOf([PROSE()], { revision: undefined })]) {
      let id = "";
      expect(newStatements(storage, () => id = heldDoc(DOC, copy).id)).toEqual([]);
      expect(counts(storage).doc_version).toBe(0);
      expect(store.keep(DOC, copy, NONE).id).toBe(id);
      store.drop(DOC);
    }
  });

  it("replaces a copy and removes what only the earlier one reached", () => {
    let { storage, store } = opened();
    let first = store.keep(DOC, copyOf([PROSE(), NOTES()]), NONE);
    store.markdown(baseOf(store, first, 0));
    store.markdown(baseOf(store, first, 1));
    let changed = tabOf("t1", [para("One"), para("Three")]);

    let second = store.keep(DOC, copyOf([changed, NOTES()], { revision: "r2" }), NONE);

    expect(second.versions[1]).toBe(first.versions[1]);
    expect(rowsOf(storage, "doc_version").map(row => row.id).toSorted()).toEqual([...second.versions].toSorted());
    // The changed tab's run and Markdown were replaced; the other tab's runs and the context stay.
    expect(counts(storage)).toEqual({ doc_copy: 1, doc_md: 4, doc_result: 0, doc_run: 5, doc_seq: 4, doc_version: 2 });
    expect(rowsOf(storage, "doc_run").map(row => row.id)).not.toContain(runIds(PROSE())[0]);
    expect(store.markdown(baseOf(store, second, 0))).toBe(docTabToMarkdown(changed).markdown);
  });

  it("a keep leaves what the pending edits and roots reach", () => {
    let { store } = opened();
    let base = baseOf(store, store.keep(DOC, copyOf([PROSE(), NOTES()]), NONE));
    let child = edited(store, base, "e1");
    // The blank tab of a pending add, and an edit queued in it.
    let root = store.putTab(DOC, tabOf("added", [para("")]), []);
    let added = edited(store, root, "e2");
    let again = copyOf([PROSE(), tabOf("t2", [para("Notes"), para("End")])], { revision: "r2" });
    let stored = () => [child, root, added].map(version => store.has(version));

    // The document is fetched again, its other tab changed, with both edits and the add pending.
    store.keep(DOC, again, { edits: ["e1", "e2"], roots: [root.id] });

    expect(store.result(base, "e1")).toMatchObject({ after: { id: child.id } });
    expect(store.result(root, "e2")).toMatchObject({ after: { id: added.id } });
    expect(stored()).toEqual([true, true, true]);

    // The same fetch with nothing pending leaves none of them.
    store.keep(DOC, again, NONE);

    expect(store.result(base, "e1")).toBeUndefined();
    expect(store.result(root, "e2")).toBeUndefined();
    expect(stored()).toEqual([false, false, false]);
    expect(store.has(base)).toBe(true);
  });

  it("keys a rendering by its context, and sweeps it by that key", () => {
    let { storage, store } = opened();
    // One body of one run under two definitions of its list: numbered, then bulleted.
    let blocks = [para("One"), item("first", "N1"), item("second", "N1")];
    let numbered = tabOf("t1", blocks, NUMBERED_LIST);
    let bulleted = tabOf("t1", blocks, { N1: BULLET_LIST.L1 });
    let [run, ...more] = runIds(numbered);
    let numberedText = docTabToMarkdown(numbered).markdown;
    let bulletedText = docTabToMarkdown(bulleted).markdown;
    expect(more).toEqual([]);
    expect(runIds(bulleted)).toEqual([run]);
    expect(bulletedText).not.toBe(numberedText);

    let first = store.keep(DOC, copyOf([numbered]), NONE);
    expect(store.markdown(baseOf(store, first))).toBe(numberedText);

    // Under the other definition the run stays; its earlier rendering goes with its version.
    let second = store.keep(DOC, copyOf([bulleted], { revision: "r2" }), NONE);
    let base = () => baseOf(store, second);
    expect(counts(storage)).toEqual({ ...EMPTY, doc_copy: 1, doc_run: 2, doc_md: 1, doc_seq: 1, doc_version: 1 });
    expect(rowsOf(storage, "doc_run").map(row => row.id)).toContain(run);
    expect(store.markdown(base())).toBe(bulletedText);
    expect(store.summary(base()).numberedItems).toBe(false);

    // Another document lists the run under the first context: each reads its own rendering.
    let other = baseOf(store, store.keep("other", copyOf([numbered]), NONE), 0, "other");
    expect(store.markdown(other)).toBe(numberedText);
    expect(store.summary(other).numberedItems).toBe(true);
    expect(store.markdown(base())).toBe(bulletedText);
    expect(counts(storage).doc_md).toBe(2);

    // A third document defines another list too: the run is keyed by the list it names alone.
    let wider = tabOf("t1", blocks, { ...NUMBERED_LIST, ...BULLET_LIST });
    let third = baseOf(store, store.keep("third", copyOf([wider]), NONE), 0, "third");
    let listed = (version: DocVersion) => rowsOf(storage, "doc_seq")
      .filter(row => row.version === version.id).map(({ run, context, carry }) => [run, context, carry]);
    expect(rowsOf(storage, "doc_version").map(row => row.context)).toHaveLength(3);
    expect(new Set(rowsOf(storage, "doc_version").map(row => row.context)).size).toBe(3);
    expect(listed(third)).toEqual(listed(other));
    expect(listed(third)).not.toEqual(listed(base()));
    expect(counts(storage).doc_md).toBe(3);
    expect(store.markdown(third)).toBe(numberedText);
    store.drop("third");
    expect(counts(storage).doc_md).toBe(2);

    store.drop("other");
    expect(counts(storage).doc_md).toBe(1);
    expect(spent(() => expect(store.markdown(base())).toBe(bulletedText)).runsRendered).toBe(0);
  });

  it("keeps the rows a stale copy names until the next keep", () => {
    let { storage, store } = opened();
    let first = store.keep(DOC, copyOf([PROSE(), NOTES()]), NONE);
    let before = storage.rows();

    store.touch(DOC, { stale: true });

    expect({ ...storage.rows(), doc_copy: [] }).toEqual({ ...before, doc_copy: [] });
    expect(store.head(DOC)).toEqual({ ...first, stale: true });
    let changed = tabOf("t1", [para("One"), para("Three")]);
    let statements: unknown[][] = [];
    storage.refuse((statement, bindings) => {
      if (statement.startsWith("INSERT INTO doc_run")) statements.push([...bindings]);
      return false;
    });
    let second = store.keep(DOC, copyOf([changed, NOTES()], { revision: "r2" }), NONE);
    // The changed tab's run is written, and nothing of the tab the two copies share.
    expect(statements.map(([id]) => id)).toEqual(runIds(changed));
    expect(second.stale).toBe(false);
    expect(store.holds(DOC, second.id)).toBe(true);
  });

  it("touch changes when the copy was checked, or marks it stale, and nothing else", () => {
    let { storage, store } = opened();
    let head = store.keep(DOC, copyOf([PROSE()]), NONE);
    let other = store.keep("other", copyOf([NOTES()]), NONE);
    let rows = () => ({ ...storage.rows(), doc_copy: [] });
    let before = rows();

    store.touch(DOC, { checkedAt: 5_000 });
    expect(store.head(DOC)).toEqual({ ...head, checkedAt: 5_000 });
    expect(spent(() => store.touch(DOC, { checkedAt: 5_000 })).rowsWritten).toBe(0);
    store.touch(DOC, { checkedAt: null });
    let due = { ...head };
    delete (due as { checkedAt?: number }).checkedAt;
    expect(store.head(DOC)).toEqual(due);
    expect(spent(() => store.touch(DOC, { stale: true })).rowsWritten).toBe(1);
    expect(spent(() => store.touch(DOC, { stale: true })).rowsWritten).toBe(0);
    expect(store.head(DOC)).toEqual({ ...due, stale: true });
    // Neither a check nor an approval takes the mark of a write away.
    store.touch(DOC, { checkedAt: 6_000 });
    expect(store.head(DOC)).toEqual({ ...due, checkedAt: 6_000, stale: true });
    expect(spent(() => store.touch(DOC, { approved: { folder: "f1", at: 9_000 } })).rowsWritten).toBe(1);
    expect(store.head(DOC)).toMatchObject({ checkedAt: 6_000, stale: true, folder: "f1" });

    expect(rows()).toEqual(before);
    // One store holds every document of its host: each form changed this document's record only.
    expect(store.head("other")).toEqual(other);
    // Nothing is touched where no copy is stored.
    expect(spent(() => store.touch("absent", { checkedAt: 1 })).rowsWritten).toBe(0);
    expect(store.head("absent")).toBeUndefined();
  });

  it("holds a copy by name until another is kept, a write is noted or it is dropped", () => {
    let { store } = opened();
    let first = store.keep(DOC, copyOf([PROSE()]), NONE);
    expect(store.holds(DOC, first.id)).toBe(true);
    expect(store.holds("other", first.id)).toBe(false);

    let second = store.keep(DOC, copyOf([NOTES()], { revision: "r2" }), NONE);
    expect(store.holds(DOC, first.id)).toBe(false);
    expect(store.holds(DOC, second.id)).toBe(true);

    store.touch(DOC, { stale: true });
    expect(store.holds(DOC, second.id)).toBe(false);

    let third = store.keep(DOC, copyOf([NOTES()], { revision: "r2" }), NONE);
    expect(third.id).toBe(second.id);
    expect(store.holds(DOC, third.id)).toBe(true);
    store.drop(DOC);
    expect(store.holds(DOC, third.id)).toBe(false);
  });

  it.each([
    ["outline is not JSON", "outline = '{'"],
    ["outline is not a list", "outline = '{}'"],
    ["versions is not a list", "versions = '\"v\"'"],
    ["outline and versions differ in length", "versions = '[]'"],
    ["outline entry names no tab", "outline = '[{\"title\":\"x\"}]'"],
    ["version is not a string", "versions = '[1]'"],
    ["markers is not a list", "markers = '\"m\"'"],
    ["markers and outline differ in length", "markers = '[]'"],
    ["markers entry is not a list", "markers = '[{}]'"],
  ])("reads a record whose %s as absent, never throws for it, and replaces it at the next keep", (_what, set) => {
    let { storage, store } = opened();
    let first = store.keep(DOC, copyOf([PROSE()]), NONE);
    store.markdown(baseOf(store, first));
    storage.sql.exec(`UPDATE doc_copy SET ${set} WHERE doc = ?`, DOC).toArray();

    expect(store.head(DOC)).toBeUndefined();
    expect(store.holds(DOC, first.id)).toBe(true);
    store.touch(DOC, { checkedAt: 2_000 });
    store.touch(DOC, { stale: true });
    let second = store.keep(DOC, copyOf([NOTES()], { revision: "r2" }), NONE);

    expect(store.head(DOC)).toEqual(second);
    // The one tab's three runs, each with its rendering, and its context.
    expect(counts(storage)).toEqual({ ...EMPTY, doc_copy: 1, doc_run: 4, doc_md: 3, doc_seq: 3, doc_version: 1 });
    expect(rowsOf(storage, "doc_version").map(row => row.id)).toEqual(second.versions);

    // A sweep and a drop of such a record remove what it named, and do not throw either.
    storage.sql.exec(`UPDATE doc_copy SET ${set} WHERE doc = ?`, DOC).toArray();
    store.sweep(DOC, NONE);
    expect(counts(storage)).toEqual({ ...EMPTY, doc_copy: 1 });
    store.drop(DOC);
    expect(counts(storage)).toEqual(EMPTY);
  });

  it("records where and when a copy was last approved", () => {
    let { store } = opened();
    let hour = DOC_COPY_APPROVAL_GRAIN_MS;
    let at = 7 * hour + 1_234;

    let head = store.keep(DOC, copyOf([PROSE()]), NONE, { folder: "f1", at });
    expect(head).toMatchObject({ folder: "f1", approvedAt: 7 * hour });
    expect(store.head(DOC)).toEqual(head);

    let touch = (folder: string | undefined, clock: number) =>
      spent(() => store.touch(DOC, { approved: { ...(folder ? { folder } : {}), at: clock } })).rowsWritten;
    expect(touch("f2", at)).toBe(1);
    expect(touch("f2", at)).toBe(0);
    expect(touch("f2", 8 * hour - 1)).toBe(0);
    expect(touch("f2", 8 * hour)).toBe(1);
    expect(store.head(DOC)).toMatchObject({ folder: "f2", approvedAt: 8 * hour });
    expect(touch(undefined, 8 * hour)).toBe(1);
    expect(store.head(DOC)).not.toHaveProperty("folder");
    expect(store.head(DOC)).toMatchObject({ id: head.id, approvedAt: 8 * hour });

    // A bound Doc's copy stores neither, and the copy's name moves with neither.
    let bare = store.keep(DOC, copyOf([PROSE()]), NONE);
    expect(bare).not.toHaveProperty("folder");
    expect(bare).not.toHaveProperty("approvedAt");
    expect(store.head(DOC)).toEqual(bare);
    expect(bare.id).toBe(head.id);
    // A session that stands on no folder: the approval's hour is recorded all the same.
    let unfiled = store.keep(DOC, copyOf([PROSE()]), NONE, { at });
    expect(unfiled.id).toBe(head.id);
    expect(unfiled).toMatchObject({ approvedAt: 7 * hour });
    expect(unfiled).not.toHaveProperty("folder");
    expect(store.head(DOC)).toEqual(unfiled);
  });

  it("gives no handle under another tab's name, nor of a version whose record is not what was stored", () => {
    let { storage, store } = opened();
    let head = store.keep(DOC, copyOf([PROSE()]), NONE);
    let [id] = head.versions;
    let as = { ...head.outline[0], writeMarkers: [] };

    expect(store.version(DOC, id, as)).toMatchObject({ id, tabId: "t1", doc: DOC });
    expect(store.version(DOC, id, { ...as, tabId: "t2" })).toBeUndefined();
    expect(store.version("other", id, as)).toBeUndefined();
    expect(store.version(DOC, "absent", as)).toBeUndefined();

    let { bodyEndIndex } = baseOf(store, head);
    for (let meta of [
      "{", "[]", JSON.stringify({ bodyEndIndex, exact: false }),
      JSON.stringify({ tabId: "t1", bodyEndIndex: `${bodyEndIndex}`, exact: false }),
      JSON.stringify({ tabId: "t1", bodyEndIndex }),
    ]) {
      storage.sql.exec("UPDATE doc_version SET meta = ? WHERE doc = ? AND id = ?", meta, DOC, id).toArray();
      expect(store.version(DOC, id, as), meta).toBeUndefined();
    }
  });

  it("stores what an edit made in a version, and finds it by the edit's key", () => {
    let { storage, store } = opened();
    let base = baseOf(store, store.keep(DOC, copyOf([PROSE()]), NONE));
    let requests = typing(PROSE(), "x");
    let after = store.putTab(DOC, applyDocsRequests(store.tab(base), requests), []);

    let stored = spent(() => store.putResult(base, "e1", { requests, after }));
    let found = spent(() => {
      expect(store.result(base, "e1")).toEqual({ requests, after: { ...after, writeMarkers: base.writeMarkers } });
    });

    expect(stored).toMatchObject({ rowsWritten: 1, resultsStored: 1 });
    expect(found).toMatchObject({ resultsFound: 1, runsDecoded: 0, rowsWritten: 0 });
    expect(rowsOf(storage, "doc_result")).toEqual([{
      version: base.id, edit: "e1", made: store.head(DOC)!.made, child: after.id,
      result: JSON.stringify({ requests }),
    }]);
    expect(store.result(base, "e2")).toBeUndefined();
    expect(store.result(after, "e1")).toBeUndefined();
    // Storing it again changes nothing.
    expect(spent(() => store.putResult(base, "e1", { requests, after }))).toMatchObject({
      rowsWritten: 0, resultsStored: 0,
    });
    // An edit that changes nothing gives the version itself, as the handle asked.
    store.putResult(base, "same", { requests: [], after: base });
    expect(store.result(base, "same")).toEqual({ requests: [], after: base });
  });

  it("stores a refusal with everything it holds", () => {
    let { storage, store } = opened();
    let base = baseOf(store, store.keep(DOC, copyOf([PROSE()]), NONE));
    let refusals: DocRefusal[] = [
      { reason: "The text was not found." },
      { reason: "The tab cannot be indexed.", unindexed: true },
      { reason: "No answer.", unmodelled: { what: "a shape", invariant: true }, closesGate: true },
      { reason: "The model threw.", modelError: { name: "TypeError", frames: "at one\nat two" } },
    ];

    for (let [at, refusal] of refusals.entries()) {
      store.putResult(base, `e${at}`, { refusal });
      expect(store.result(base, `e${at}`)).toEqual({ refusal });
    }
    expect(rowsOf(storage, "doc_result").map(row => row.child)).toEqual([null, null, null, null]);
  });

  it("answers no result once the version it gave is gone", () => {
    let { storage, store } = opened();
    let base = baseOf(store, store.keep(DOC, copyOf([PROSE()]), NONE));
    let child = edited(store, base, "e1");

    storage.sql.exec("DELETE FROM doc_version WHERE id = ?", child.id).toArray();

    expect(store.result(base, "e1")).toBeUndefined();
  });

  // The limit itself, in bytes of UTF-8, is pinned on real storage in the workerd test.
  it("refuses requests too large for a row, saying which change", () => {
    let { storage, store } = opened();
    let base = baseOf(store, store.keep(DOC, copyOf([PROSE()]), NONE));
    let requests = typing(PROSE(), "x".repeat(DOC_ROW_BYTES));

    let thrown: unknown;
    try {
      store.putResult(base, "e1", { requests, after: base });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DocRowTooLargeError);
    let { message, bytes, name } = thrown as DocRowTooLargeError;
    expect(name).toBe("DocRowTooLargeError");
    expect(bytes).toBeGreaterThan(DOC_ROW_BYTES);
    expect(message).toBe(
      `The change an edit makes to tab "t1" of this Google Doc is too large to keep a copy of: ` +
      `${bytes} bytes as stored, and one stored row holds 8000000. It cannot be read or edited ` +
      "through this connection until it is made smaller in Google Docs.");
    expect(counts(storage).doc_result).toBe(0);
  });

  // The limit itself, in bytes of UTF-8, is pinned on real storage in the workerd test.
  it("refuses a Markdown too large for a row, saying which element, and writes nothing", () => {
    let { storage, store } = opened();
    store.putTab(DOC, PROSE(), []);
    let before = storage.rows();
    // A rendering's row also holds the run's summary, so a paragraph whose run just fits a row
    // has a rendering that does not.
    let sized = (length: number) => tabOf("t9", [para("Nine"), para("x".repeat(length))]);
    let rowOf = (tab: GoogleDocsTab) => {
      let [, paragraph] = [...cutRuns(tab.body.content, RUN_SIZES)];
      return runId(paragraph.json).length + paragraph.json.length;
    };
    let fitting = sized(DOC_ROW_BYTES - 1_000);
    fitting = sized(DOC_ROW_BYTES - 1_000 + DOC_ROW_BYTES - rowOf(fitting));
    expect(rowOf(fitting)).toBe(DOC_ROW_BYTES);

    for (let put of [
      // The tab's own rows are undone with its rendering's.
      () => store.putTab(DOC, fitting, []),
      () => store.keep(DOC, copyOf([PROSE(), fitting]), NONE),
    ]) {
      let thrown: unknown;
      try {
        put();
      } catch (error) {
        thrown = error;
      }

      expect(thrown, String(put)).toBeInstanceOf(DocRowTooLargeError);
      let { message, bytes } = thrown as DocRowTooLargeError;
      expect(bytes).toBeGreaterThan(DOC_ROW_BYTES);
      expect(message).toMatch(/^A paragraph of tab "t9" of this Google Doc is too large to keep a copy of: /);
      expect(storage.rows()).toEqual(before);
    }
  });

  it("names a table and the lists that are too large for a row, and writes nothing", () => {
    let { storage, store } = opened();
    let before = storage.rows();
    // Two bytes of UTF-8 a character: the value passes a row though its length does not.
    let long = "é".repeat(DOC_ROW_BYTES / 2);
    let table = tabOf("t7", [para("Seven"), grid([long])]);
    let lists: GoogleDocsTab = {
      ...PROSE(), tabId: "t8",
      lists: { L1: { listProperties: { nestingLevels: [{ glyphSymbol: long }] } } },
    };

    for (let [tab, named] of [
      [table, /^A table of tab "t7" of this Google Doc is too large to keep a copy of: /],
      [lists, /^The lists of tab "t8" of this Google Doc is too large to keep a copy of: /],
    ] as const) {
      let thrown: unknown;
      try {
        store.putTab(DOC, tab, []);
      } catch (error) {
        thrown = error;
      }

      expect(thrown, String(named)).toBeInstanceOf(DocRowTooLargeError);
      expect((thrown as DocRowTooLargeError).message).toMatch(named);
      expect(storage.rows()).toEqual(before);
    }
  });

  describe("sweep", () => {
    it("sweeps a version no pending edit reaches, with its result, its run and its Markdown", () => {
      let { storage, store } = opened();
      let base = baseOf(store, store.keep(DOC, copyOf([PROSE()]), NONE));
      store.markdown(base);
      let before = storage.rows();
      let child = edited(store, base, "e1");
      store.markdown(child);
      expect(counts(storage)).toMatchObject({ doc_md: 2, doc_result: 1, doc_run: 3, doc_seq: 2, doc_version: 2 });

      store.sweep(DOC, NONE);

      expect(storage.rows()).toEqual(before);
      expect(store.markdown(base)).toBe(docTabToMarkdown(PROSE()).markdown);
    });

    it("keeps a chain of results while every edit of it is pending, and the runs two versions share", () => {
      let { storage, store } = opened();
      let tab = PROSE();
      let base = baseOf(store, store.keep(DOC, copyOf([tab]), NONE));
      let first = edited(store, base, "e1");
      let second = edited(store, first, "e2");
      // An edit that changes the text back: its version lists the run the first edit's does.
      let undone = store.putTab(DOC, applyDocsRequests(store.tab(second), [
        { deleteContentRange: { range: { startIndex: 1, endIndex: 3, tabId: tab.tabId } } },
      ]), []);
      store.putResult(second, "e3", { requests: [], after: undone });
      let back = store.tab(undone);
      expect(JSON.stringify(back.body.content)).toBe(JSON.stringify(store.tab(first).body.content));
      let before = storage.rows();

      store.sweep(DOC, { edits: ["e1", "e2", "e3"], roots: [] });
      expect(storage.rows()).toEqual(before);
      expect(undone.id).toBe(first.id);

      // Without the first edit nothing reaches the others.
      store.sweep(DOC, { edits: ["e2", "e3"], roots: [] });
      expect(counts(storage)).toEqual({ ...EMPTY, doc_copy: 1, doc_run: 2, doc_md: 1, doc_seq: 1, doc_version: 1 });
    });

    it("keeps the blank tab of a pending add and what the edits queued in it made, and sweeps them once the add is not pending", () => {
      let { storage, store } = opened();
      store.keep(DOC, copyOf([PROSE()]), NONE);
      let before = storage.rows();
      let blank = tabOf("added", [para("")]);
      let root = store.putTab(DOC, blank, []);
      let child = edited(store, root, "e1");
      let held = storage.rows();
      let pending = { edits: ["e1"], roots: [store.versionId(DOC, blank)] };

      store.sweep(DOC, pending);
      expect(storage.rows()).toEqual(held);
      expect(store.result(root, "e1")).toMatchObject({ after: { id: child.id } });
      // A root nothing stored yet names no version, and is ignored.
      store.sweep(DOC, { edits: ["e1"], roots: [...pending.roots, "not-stored"] });
      expect(storage.rows()).toEqual(held);

      store.sweep(DOC, { edits: ["e1"], roots: [] });
      expect(storage.rows()).toEqual(before);
    });

    it("ends on two edits that undo each other", () => {
      let { storage, store } = opened();
      let a = baseOf(store, store.keep(DOC, copyOf([PROSE()]), NONE));
      let b = edited(store, a, "there");
      store.putResult(b, "back", { requests: [], after: a });
      let before = storage.rows();

      store.sweep(DOC, { edits: ["there", "back"], roots: [] });

      expect(storage.rows()).toEqual(before);
      expect(counts(storage)).toMatchObject({ doc_result: 2, doc_version: 2 });
    });

    it("removes the result of an edit that is not pending from a version it keeps", () => {
      let { storage, store } = opened();
      let base = baseOf(store, store.keep(DOC, copyOf([PROSE()]), NONE));
      let kept = edited(store, base, "e1");
      edited(store, base, "e2");
      store.putResult(base, "refused", { refusal: { reason: "No." } });

      store.sweep(DOC, { edits: ["e1"], roots: [] });

      expect(rowsOf(storage, "doc_result").map(row => [row.version, row.edit, row.child]))
        .toEqual([[base.id, "e1", kept.id]]);
      expect(counts(storage)).toMatchObject({ doc_version: 2, doc_seq: 2, doc_run: 3 });
    });

    // A refusal gives no version and a no-op edit its base: undecided, their results go alone.
    it("removes the results of edits that are not pending where no version goes with them", () => {
      let { storage, store } = opened();
      let base = baseOf(store, store.keep(DOC, copyOf([PROSE()]), NONE));
      let before = storage.rows();
      store.putResult(base, "refused", { refusal: { reason: "No." } });
      store.putResult(base, "same", { requests: [], after: base });
      expect(rowsOf(storage, "doc_result").map(row => row.child)).toEqual([null, base.id]);
      let pending = { edits: ["refused", "same"], roots: [] };
      expect(spent(() => store.sweep(DOC, pending)).rowsWritten).toBe(0);

      // One of the two is decided: its result goes and the other's stays.
      store.sweep(DOC, { edits: ["same"], roots: [] });
      expect(rowsOf(storage, "doc_result").map(row => row.edit)).toEqual(["same"]);

      store.sweep(DOC, NONE);
      expect(storage.rows()).toEqual(before);
    });

    it("sweeps one document and leaves another's rows, a run the two both hold included", () => {
      let { storage, store } = opened();
      let one = baseOf(store, store.keep("one", copyOf([PROSE()]), NONE), 0, "one");
      let two = baseOf(store, store.keep("two", copyOf([PROSE()]), NONE), 0, "two");
      store.markdown(one);
      edited(store, one, "e1");
      let child = edited(store, two, "e1");
      // Each document holds rows of its own: its run, the edit's run, its context and renderings.
      expect(counts(storage)).toEqual({ doc_copy: 2, doc_md: 4, doc_result: 2, doc_run: 6, doc_seq: 4, doc_version: 4 });
      let content = (doc: string) =>
        ["doc_md", "doc_run"].map(table => rowsOf(storage, table).filter(row => row.doc === doc));
      expect(content("one").map(rows => rows.length)).toEqual([2, 3]);
      expect(content("two").map(rows => rows.map(row => ({ ...row, doc: "one" })))).toEqual(content("one"));
      let before = content("two");

      // The second, its edit pending, is swept while the first holds a dead version: nothing goes.
      store.sweep("two", { edits: ["e1"], roots: [] });
      expect(counts(storage)).toMatchObject({ doc_md: 4, doc_run: 6 });
      // The first, swept with nothing pending, loses its edit's version and what only it listed;
      // the second's rows stay. Then the first is dropped.
      store.sweep("one", NONE);
      expect(content("one").map(rows => rows.length)).toEqual([1, 2]);
      expect(content("two")).toEqual(before);
      store.drop("one");

      expect(rowsOf(storage, "doc_version").map(row => row.doc)).toEqual(["two", "two"]);
      expect(content("one")).toEqual([[], []]);
      expect(content("two")).toEqual(before);
      expect(counts(storage)).toEqual({ doc_copy: 1, doc_md: 2, doc_result: 1, doc_run: 3, doc_seq: 2, doc_version: 2 });
      expect(store.markdown(two)).toBe(docTabToMarkdown(PROSE()).markdown);
      expect(store.result(two, "e1")).toMatchObject({ after: { id: child.id } });
      expect(store.tab(child)).toEqual(applyDocsRequests(PROSE(), typing(PROSE(), "e1")));
    });

    it("sweeps an orphan a rolled-back caller never pointed at", () => {
      let { storage, store } = opened();
      store.keep(DOC, copyOf([PROSE()]), NONE);
      let before = storage.rows();
      // A version and rendering stored by a request that failed before any record named them.
      let orphan = tabOf("t1", [para("Orphan")]);
      store.putTab(DOC, orphan, []);
      expect(storage.rows()).not.toEqual(before);

      store.sweep(DOC, { edits: ["e1"], roots: [] });

      expect(storage.rows()).toEqual(before);
    });

    it("writes nothing when there is nothing to remove", () => {
      let { storage, store } = opened();
      let base = baseOf(store, store.keep(DOC, copyOf([PROSE(), NOTES()]), NONE));
      edited(store, base, "e1");
      let before = storage.rows();

      let ran = newStatements(storage, () => {
        expect(spent(() => store.sweep(DOC, { edits: ["e1"], roots: [] })).rowsWritten).toBe(0);
      });

      expect(storage.rows()).toEqual(before);
      expect(ran.filter(statement => /DELETE|UPDATE|INSERT/.test(statement))).toEqual([]);
    });

    it("drops a document's copy and everything stored for it", () => {
      let { storage, store } = opened();
      let head = store.keep(DOC, copyOf([PROSE(), NOTES()]), NONE);
      let child = edited(store, baseOf(store, head), "e1");
      store.markdown(child);
      store.markdown(baseOf(store, head, 1));

      store.drop(DOC);

      expect(counts(storage)).toEqual(EMPTY);
      expect(store.head(DOC)).toBeUndefined();
      store.drop(DOC);
      expect(counts(storage)).toEqual(EMPTY);
    });

    it("leaves a document whole when storage refuses a write in the middle of its drop", () => {
      let { storage, store } = opened();
      let head = store.keep(DOC, copyOf([PROSE(), NOTES()]), NONE);
      store.markdown(edited(store, baseOf(store, head), "e1"));
      let before = storage.rows();

      // The results are deleted first, then the run lists; the record goes last.
      storage.refuse(statement => statement.startsWith("DELETE FROM doc_seq"));
      expect(() => store.drop(DOC)).toThrow("storage refused the write");
      storage.refuse(undefined);

      expect(storage.rows()).toEqual(before);
      expect(store.head(DOC)).toEqual(head);
    });
  });

  // Every statement a scenario of keeps, edits, results, reads, a piece, sweeps and drops ran.
  function statementsOfAScenario(): FakeDocStorage {
    let { storage, store } = opened();
    let one = store.keep("one", copyOf([PROSE(), NOTES()]), NONE, { folder: "f1", at: 1 });
    let two = store.keep("two", copyOf([NOTES()]), NONE);
    let base = baseOf(store, one, 0, "one");
    let child = edited(store, base, "e1");
    edited(store, child, "e2");
    // An edit in a tab of several runs, which lists the runs it does not touch as they were.
    edited(store, baseOf(store, one, 1, "one"), "e3");
    store.putResult(base, "refused", { refusal: { reason: "No." } });
    store.markdown(base);
    pieceAtEnd(store, base);
    store.summary(child);
    store.unindexed(base);
    store.has(base);
    store.result(base, "e1");
    store.touch("one", { checkedAt: null });
    store.touch("one", { stale: true });
    store.touch("one", { approved: { at: 2 } });
    store.holds("two", two.id);
    store.trial("two", copyOf([PROSE()], { revision: "r2" }), () => NONE, () => undefined);
    store.sweep("one", { edits: ["e1"], roots: [] });
    store.keep("one", copyOf([NOTES()], { revision: "r3" }), NONE);
    store.drop("one");
    store.drop("two");
    // Another digest's rows, and a tab that names a list, for the statements that touch them.
    let other = new DocStore(storage, undefined, "other");
    let listed = tabOf("t1", [para("One"), item("first", "N1")], NUMBERED_LIST);
    let kept = baseOf(other, other.keep("one", copyOf([listed]), NONE), 0, "one");
    other.markdown(kept);
    edited(other, kept, "e1");
    let again = baseOf(store, store.head("one")!, 0, "one");
    store.markdown(again);
    pieceAtEnd(store, again);
    edited(store, again, "e1");
    store.unindexed(again);
    store.sweep("one", { edits: ["e1"], roots: [] });
    return storage;
  }

  it("scans no content table", () => {
    let storage = statementsOfAScenario();
    let removed = (statement: string) => /^DROP TABLE IF EXISTS doc_\w+$/.test(statement);
    let statements = storage.statements();

    expect(statements.filter(removed)).toHaveLength(6);
    // The scenario ran the statements that read runs, copy a list inside storage, remove another
    // digest's renderings, sum sizes, and sweep and drop.
    for (let ran of [
      /LEFT JOIN doc_md/, /LEFT JOIN doc_run/, /json_each\(doc_run\.json, '\$\.lists'\)/,
      /^INSERT OR REPLACE INTO doc_seq [\s\S]*\bSELECT\b[\s\S]*\bFROM doc_seq\b/,
      /^DELETE FROM doc_md WHERE made <>[\s\S]*IN \(SELECT run, context, carry FROM doc_seq\b/,
      /^SELECT COALESCE\(SUM\([\s\S]*\bFROM doc_seq\b/,
      // And those of a sweep that removes a version beside a live one, of a sweep of a
      // document none of whose versions is live, and of a drop.
      /^DELETE FROM doc_md WHERE doc = \?1\s+AND \(run, context, carry\) IN [\s\S]*AND \(run, context, carry\) NOT IN/,
      /^DELETE FROM doc_run WHERE doc = \?1\s+AND id IN \(SELECT run FROM[\s\S]*AND id NOT IN/,
      /^DELETE FROM doc_run WHERE doc = \?1\s+AND id IN \(\s*SELECT context FROM[\s\S]*AND id NOT IN/,
      /^DELETE FROM doc_md WHERE doc = \?1 AND made <> \?2$/,
      /^DELETE FROM doc_md WHERE doc = \?$/, /^DELETE FROM doc_run WHERE doc = \?$/,
    ]) {
      expect(statements.some(statement => ran.test(statement)), String(ran)).toBe(true);
    }
    for (let statement of statements.filter(ran => !removed(ran))) {
      for (let step of storage.plan(statement)) {
        expect(step, statement).not.toMatch(/SCAN doc_(run|md|result|seq|version|copy)\b/);
      }
    }
    // `tableScans` reads every scan, by alias too; the sweep searches lists and content by key.
    expect(tableScans(storage, statements)).toEqual({});
    for (let statement of statements.filter(ran => /^DELETE FROM doc_(md|run)[^]*NOT IN/.test(ran))) {
      let searched = storage.plan(statement).filter(step => /\bdoc_(seq|version|md|run)\b/.test(step));
      expect(searched, statement).toEqual(expect.arrayContaining([
        expect.stringMatching(/^SEARCH doc_(md|run) USING (COVERING )?INDEX \S+ \(doc=\? AND /),
      ]));
      expect(searched.every(step => step.startsWith("SEARCH")), statement).toBe(true);
    }
  });

  it("declares the small columns before the large one", () => {
    let { storage: created } = opened();
    let tables = created.statements().filter(statement => statement.startsWith("CREATE TABLE"));

    let last: Record<string, string> = {};
    for (let table of tables) {
      let [, name, columns] = /^CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*)\) STRICT/.exec(table)!;
      let declared = columns.split(/,\s*PRIMARY KEY \(/)[0].split(",").map(column => column.trim().split(/\s+/)[0]);
      last[name] = declared.at(-1)!;
    }

    expect(tables).toHaveLength(7);
    expect(last).toMatchObject({ doc_run: "json", doc_md: "md", doc_result: "result" });
    // The tables of small rows are clustered by their keys, and there is no other index.
    for (let table of tables) {
      expect(/WITHOUT ROWID/.test(table), table).toBe(/doc_(seq|version|copy) /.test(table));
    }
    expect(created.statements().filter(statement => /CREATE (UNIQUE )?INDEX/.test(statement))).toEqual([]);
  });

  // `toArray()` puts every row on the heap, so content is read by key with `one()`.
  it("reads content one row a statement, never as an array", () => {
    let { storage, store } = opened();
    let head = store.keep(DOC, copyOf([PROSE(), NOTES()]), NONE);
    let base = baseOf(store, head);
    let child = edited(store, base, "e1");
    edited(store, child, "e2");
    store.markdown(base);
    store.summary(base);
    store.markdown(baseOf(store, head, 1));
    store.markdown(scenarioBaseResult(store, base));
    store.sweep(DOC, { edits: ["e1"], roots: [] });

    let selected = storage.arrays()
      .map(statement => /^\s*SELECT\s+(?:DISTINCT\s+)?([\s\S]*?)\s+FROM\b/.exec(statement)?.[1] ?? "")
      .flatMap(list => list.split(",").map(column => column.trim()));
    expect(selected).toContain("doc_md.summary");
    expect(selected.filter(column => /^(\w+\.)?(json|md|result)$/.test(column))).toEqual([]);
    expect(storage.statements().some(statement => /^SELECT (json|md|result) FROM/.test(statement))).toBe(true);
    expect(storage.openCursors()).toBe(0);
  });

  it("leaves no cursor open", () => {
    let { storage, store } = opened();
    let copy = copyOf([PROSE(), NOTES()]);
    let head = store.keep(DOC, copy, NONE);
    let base = baseOf(store, head);
    let child = edited(store, base, "e1");
    store.markdown(child);
    let pending = { edits: ["e1"], roots: [] };
    let calls: (() => unknown)[] = [
      () => new DocStore(storage),
      () => store.transaction(() => store.head(DOC)),
      () => store.keep(DOC, copy, pending),
      () => heldDoc(DOC, copy),
      () => store.trial(DOC, copyOf([NOTES()], { revision: "r2" }), () => pending, unkept => store.markdown(baseOf(store, unkept))),
      () => store.head(DOC),
      () => store.touch(DOC, { checkedAt: 2 }),
      () => store.touch(DOC, { approved: { at: 2 } }),
      () => store.holds(DOC, head.id),
      () => store.sweep(DOC, pending),
      () => store.versionId(DOC, PROSE()),
      () => store.version(DOC, base.id, base),
      () => store.has(base),
      () => store.unindexed(base),
      () => store.putTab(DOC, PROSE(), []),
      () => store.tab(base),
      () => pieceAtEnd(store, base),
      () => store.markdown(base),
      () => store.summary(base),
      () => store.result(base, "e1"),
      () => store.putResult(base, "e9", { refusal: { reason: "No." } }),
      () => store.touch(DOC, { stale: true }),
      () => store.drop(DOC),
    ];

    for (let call of calls) {
      call();
      expect(storage.openCursors(), String(call)).toBe(0);
    }
  });

  // A cursor of a write that returns rows, left unread, fails the request and loses its writes.
  it("never asks storage to return rows from a write", () => {
    let source = readFileSync(path.resolve(import.meta.dirname, "../src/docs-store.ts"), "utf8");

    expect(source).not.toMatch(/RETURNING/i);
  });

  describe("trial", () => {
    it("reads a document in a trial and leaves no row of it", () => {
      let { storage, store } = opened();

      let read = store.trial(DOC, copyOf([PROSE(), NOTES()]), () => NONE, head => {
        expect(counts(storage)).toMatchObject({ doc_copy: 0, doc_version: 2 });
        expect(store.head(DOC)).toBeUndefined();
        let base = baseOf(store, head);
        edited(store, base, "e1");
        return store.markdown(baseOf(store, head, 1));
      });

      expect(read).toBe(docTabToMarkdown(NOTES()).markdown);
      expect(counts(storage)).toEqual(EMPTY);
      expect(store.head(DOC)).toBeUndefined();
    });

    it("leaves the stored copy as it was after a trial of a later document, and keeps what an edit made in a tab the two share", () => {
      let { storage, store } = opened();
      let stored = store.keep(DOC, copyOf([PROSE(), NOTES()]), NONE);
      let before = storage.rows();
      let changed = tabOf("t2", [para("Notes"), para("Changed")]);

      let made = store.trial(DOC, copyOf([PROSE(), changed], { revision: "r2" }), () => ({ edits: ["e1"], roots: [] }), head => {
        expect(head.id).not.toBe(stored.id);
        expect(head.versions[0]).toBe(stored.versions[0]);
        store.markdown(baseOf(store, head, 1));
        edited(store, baseOf(store, head, 1), "e1");
        let child = edited(store, baseOf(store, head, 0), "e1");
        store.markdown(child);
        return { child, changed: head.versions[1] };
      });

      expect(store.head(DOC)).toEqual(stored);
      // The changed tab's version, run and Markdown are gone, with what the edit made there.
      expect(rowsOf(storage, "doc_version").map(row => row.id)).not.toContain(made.changed);
      expect(rowsOf(storage, "doc_run").map(row => row.id)).not.toContain(runId(JSON.stringify(changed.body.content)));
      // What the edit made in the tab the stored copy holds unchanged is still found.
      let base = baseOf(store, stored);
      expect(store.result(base, "e1")).toMatchObject({ after: { id: made.child.id } });
      expect(spent(() => store.markdown(made.child))).toMatchObject({ runsDecoded: 0, runsRendered: 0 });
      store.sweep(DOC, NONE);
      expect(storage.rows()).toEqual(before);
    });

    it("commits what a trial's use wrote to the KV, and rethrows what it threw", () => {
      let { storage, store } = opened();
      let failure = new Error("The read was refused.");

      expect(() => store.trial(DOC, copyOf([PROSE()]), () => NONE, head => {
        storage.kv.put("action:1", { failed: true });
        edited(store, baseOf(store, head), "e1");
        throw failure;
      })).toThrow(failure);

      expect(storage.kv.get("action:1")).toEqual({ failed: true });
      expect(counts(storage)).toEqual(EMPTY);
    });

    it("leaves nothing of a trial whose storage fails part way", () => {
      let { storage, store } = opened();
      store.keep(DOC, copyOf([PROSE()]), NONE);
      storage.kv.put("action:1", { failed: false });
      let before = storage.rows();
      storage.refuse(statement => statement.startsWith("DELETE FROM doc_seq"));

      expect(() => store.trial(DOC, copyOf([NOTES()], { revision: "r2" }), () => NONE, () => {
        storage.kv.put("action:1", { failed: true });
      })).toThrow("storage refused the write");

      storage.refuse(undefined);
      expect(storage.rows()).toEqual(before);
      expect(storage.kv.get("action:1")).toEqual({ failed: false });
    });

    it("refuses a trial whose use returns a promise, and undoes its rows and the KV writes it made", () => {
      let { storage, store } = opened();
      let stored = store.keep(DOC, copyOf([PROSE()]), NONE);
      let before = storage.rows();

      expect(() => store.trial(DOC, copyOf([PROSE(), NOTES()], { revision: "r2" }), () => ({ edits: ["e1"], roots: [] }), async () => {
        storage.kv.put("action:1", { failed: true });
        edited(store, baseOf(store, stored), "e1");
        await Promise.resolve();
      })).toThrow("A DocStore transaction must be synchronous: its callback returned a promise.");

      expect(storage.rows()).toEqual(before);
      expect(storage.kv.keys()).toEqual([]);
    });

    it("a trial sweeps the result of an edit that is not pending, and keeps a pending edit's in a tab the stored copy holds", () => {
      let { storage, store } = opened();
      let stored = store.keep(DOC, copyOf([PROSE()]), NONE);
      let base = baseOf(store, stored);

      let kept = store.trial(DOC, copyOf([PROSE()]), () => ({ edits: ["queued"], roots: [] }), () => {
        edited(store, base, "prepared");
        return edited(store, base, "queued");
      });

      expect(rowsOf(storage, "doc_result").map(row => [row.version, row.edit, row.child]))
        .toEqual([[base.id, "queued", kept.id]]);
      expect(rowsOf(storage, "doc_version").map(row => row.id).toSorted()).toEqual([base.id, kept.id].toSorted());
    });

    it("reads what is pending after use", () => {
      let { storage, store } = opened();
      let base = baseOf(store, store.keep(DOC, copyOf([PROSE()]), NONE));
      let pending: DocPending = { edits: ["e1"], roots: [] };

      store.trial(DOC, copyOf([PROSE()]), () => pending, () => {
        edited(store, base, "e1");
        // The replay marked the record: its edit is not pending when the sweep asks.
        pending = NONE;
      });

      expect(counts(storage)).toMatchObject({ doc_result: 0, doc_version: 1 });
    });

    // The limit is pinned on real storage in the workerd test; a trial meets it before `use`.
    it("refuses a trial of a tab with a paragraph too large for a row before use runs", () => {
      let { storage, store } = opened();
      let large = tabOf("t1", [para("x".repeat(DOC_ROW_BYTES))]);
      let used = false;

      let thrown: unknown;
      try {
        store.trial(DOC, copyOf([PROSE(), large]), () => NONE, () => {
          used = true;
        });
      } catch (error) {
        thrown = error;
      }

      // The element that passes a row is named, not its tab.
      expect(thrown).toBeInstanceOf(DocRowTooLargeError);
      expect((thrown as Error).message)
        .toMatch(/^A paragraph of tab "t1" of this Google Doc is too large to keep a copy of: /);
      expect(used).toBe(false);
      expect(counts(storage)).toEqual(EMPTY);
    });

    // No host runs a trial with roots: a Doc opened through Drive queues no added tab.
    it("a trial keeps what a root names and what the edits queued there made, and leaves no row of a document with no stored copy and no root", () => {
      let { storage, store } = opened();
      let blank = tabOf("added", [para("")]);
      let root = store.putTab(DOC, blank, []);
      let queued = edited(store, root, "e1");
      let held = storage.rows();
      let pending = { edits: ["e1"], roots: [root.id] };

      store.trial(DOC, copyOf([PROSE()]), () => pending, head => {
        edited(store, baseOf(store, head), "e1");
        expect(store.result(root, "e1")).toMatchObject({ after: { id: queued.id } });
      });
      expect(storage.rows()).toEqual(held);

      store.trial(DOC, copyOf([PROSE()]), () => ({ edits: ["e1"], roots: [] }), () => undefined);
      expect(counts(storage)).toEqual(EMPTY);
    });
  });

  it.each([
    ["run is gone", "DELETE FROM doc_run WHERE id = ?"],
    ["run is not JSON", "UPDATE doc_run SET json = '[{' WHERE id = ?"],
    ["run is not a list of elements", "UPDATE doc_run SET json = '{}' WHERE id = ?"],
  ])("reads a version whose %s as unreadable, and drops the copy", (_what, statement) => {
    let { storage, store } = opened();
    let base = baseOf(store, store.keep(DOC, copyOf([PROSE()]), NONE));
    storage.sql.exec(statement, runIds(PROSE())[0]).toArray();

    expect(() => store.tab(base)).toThrow(new Error(DOC_COPY_UNREADABLE));

    expect(store.head(DOC)).toBeUndefined();
    expect(counts(storage)).toMatchObject({ doc_copy: 0, doc_version: 0 });
  });

  it("reads a version whose context is not what was stored as unreadable", () => {
    let { storage, store } = opened();
    let base = baseOf(store, store.keep(DOC, copyOf([PROSE()]), NONE));
    storage.sql.exec("UPDATE doc_run SET json = '{\"lists\":3}' WHERE id = ?", runId(JSON.stringify({ lists: {} }))).toArray();

    expect(() => pieceAtEnd(store, base)).toThrow(new Error(DOC_COPY_UNREADABLE));
    expect(store.head(DOC)).toBeUndefined();
  });

  it("reads a version whose run list is gone as unreadable, never as an empty tab", () => {
    let { store } = opened();
    let base = baseOf(store, store.keep(DOC, copyOf([PROSE()]), NONE));
    let child = edited(store, base, "e1");
    store.sweep(DOC, NONE);

    for (let read of [
      () => store.tab(child), () => pieceAtEnd(store, child), () => store.markdown(child),
      () => store.summary(child),
    ]) {
      store.keep(DOC, copyOf([PROSE()]), NONE);
      expect(read, String(read)).toThrow(new Error(DOC_COPY_UNREADABLE));
      expect(store.head(DOC)).toBeUndefined();
    }
    // A tab as fetched whose version is gone: asking whether the model indexes it decodes it.
    let fetched = store.putTab(DOC, NOTES(), []);
    store.sweep(DOC, NONE);
    expect(() => store.unindexed(fetched)).toThrow(new Error(DOC_COPY_UNREADABLE));
    expect(store.has(child)).toBe(false);
    expect(store.has(fetched)).toBe(false);
  });

  it("says whether a version can be decoded without reading its content", () => {
    let { storage, store } = opened();
    let head = store.keep(DOC, copyOf([PROSE(), NOTES()]), NONE);
    let [prose, notes] = [baseOf(store, head, 0), baseOf(store, head, 1)];

    let ran = newStatements(storage, () => {
      expect(spent(() => expect(store.has(prose)).toBe(true)).runsDecoded).toBe(0);
    });
    expect(ran.filter(statement => /\b(json|md|result)\b/.test(statement.split("FROM")[0]))).toEqual([]);

    // One of the tab's three runs is gone: its table's.
    storage.sql.exec("DELETE FROM doc_run WHERE id = ?", runIds(NOTES())[1]).toArray();
    expect(store.has(notes)).toBe(false);
    expect(store.has(prose)).toBe(true);
    storage.sql.exec("DELETE FROM doc_run WHERE id = ?", runId(JSON.stringify({ lists: {} }))).toArray();
    expect(store.has(prose)).toBe(false);
    expect(store.has({ ...prose, id: "absent" })).toBe(false);
  });

  it("undoes every row and KV write of a transaction that throws", () => {
    let { storage, store } = opened();
    store.keep(DOC, copyOf([PROSE()]), NONE);
    storage.kv.put("kept", 1);
    let before = storage.rows();

    expect(() => store.transaction(() => {
      store.keep(DOC, copyOf([NOTES()], { revision: "r2" }), NONE);
      storage.kv.put("kept", 2);
      storage.kv.put("added", 3);
      throw new Error("The request failed.");
    })).toThrow("The request failed.");

    expect(storage.rows()).toEqual(before);
    expect(storage.kv.get("kept")).toBe(1);
    expect(storage.kv.keys()).toEqual(["kept"]);
    expect(store.transaction(() => 7)).toBe(7);
  });

  it("refuses a transaction whose callback returns a promise, and undoes what it wrote", () => {
    let { storage, store } = opened();
    let before = storage.rows();

    expect(() => store.transaction(async () => {
      store.keep(DOC, copyOf([PROSE()]), NONE);
      storage.kv.put("added", 1);
      await Promise.resolve();
    })).toThrow("A DocStore transaction must be synchronous: its callback returned a promise.");

    expect(storage.rows()).toEqual(before);
    expect(storage.kv.keys()).toEqual([]);
  });

  it("leaves the earlier copy whole when storage refuses a write in the middle of a keep, and at its record", () => {
    let { storage, store } = opened();
    let first = store.keep(DOC, copyOf([PROSE(), NOTES()]), NONE);
    let before = storage.rows();
    let later = copyOf([tabOf("t1", [para("Later")]), tabOf("t2", [para("Also later")])], { revision: "r2" });

    // The second tab's version, and then the record itself.
    for (let refused of [
      (statement: string, bindings: readonly unknown[]) =>
        statement.startsWith("INSERT INTO doc_version") && bindings[1] === store.versionId(DOC, later.tabs[1].tab),
      (statement: string) => statement.startsWith("INSERT OR REPLACE INTO doc_copy"),
    ]) {
      storage.refuse(refused);
      expect(() => store.keep(DOC, later, NONE)).toThrow("storage refused the write");
      storage.refuse(undefined);

      expect(storage.rows()).toEqual(before);
      expect(store.head(DOC)).toEqual(first);
      expect(store.tab(baseOf(store, first, 1))).toEqual(NOTES());
    }
  });

  it("starts empty when it is opened under another format", () => {
    let { storage, store } = opened("1");
    let head = store.keep(DOC, copyOf([PROSE()]), NONE);
    edited(store, baseOf(store, head), "e1");
    store.markdown(baseOf(store, head));
    let before = storage.rows();

    // Opened under the same format, the rows stay.
    expect(new DocStore(storage, "1").head(DOC)).toEqual(head);
    expect(storage.rows()).toEqual(before);

    let other = new DocStore(storage, "2");
    expect(counts(storage)).toEqual(EMPTY);
    expect(storage.rows().doc_format).toEqual([{ id: 0, format: "2" }]);
    expect(other.head(DOC)).toBeUndefined();
  });

  it("removes every row of another format or none of them", () => {
    let { storage, store } = opened();
    let head = store.keep(DOC, copyOf([PROSE()]), NONE);
    store.markdown(edited(store, baseOf(store, head), "e1"));
    let before = storage.rows();
    expect(Object.values(counts(storage)).every(rows => rows > 0)).toBe(true);

    // The results, the run lists and the versions are removed before the renderings.
    storage.refuse(statement => statement === "DROP TABLE IF EXISTS doc_md");
    expect(() => new DocStore(storage, "other")).toThrow("storage refused the write");
    storage.refuse(undefined);

    expect(storage.rows()).toEqual(before);
    expect(store.head(DOC)).toEqual(head);

    let other = new DocStore(storage, "other");
    expect(counts(storage)).toEqual(EMPTY);
    expect(storage.rows().doc_format).toEqual([{ id: 0, format: "other" }]);
    expect(other.head(DOC)).toBeUndefined();
  });

  // A bump of the format is all a change to a table's columns needs: `CREATE TABLE IF NOT
  // EXISTS` alone would leave the earlier columns under the later format, for good.
  it("makes its tables again under another format, with the columns this code defines", () => {
    let { storage: fresh } = opened();
    let storage = fakeDocStorage();
    storage.sql.exec("CREATE TABLE doc_format (id INTEGER PRIMARY KEY CHECK (id = 0), format TEXT NOT NULL) STRICT");
    storage.sql.exec("INSERT INTO doc_format (id, format) VALUES (0, 'earlier')");
    // An earlier layout: `doc_seq` with no `size`, and a row in it.
    storage.sql.exec(`CREATE TABLE doc_seq (
      version TEXT NOT NULL, seq INTEGER NOT NULL, run TEXT NOT NULL, context TEXT NOT NULL,
      carry TEXT NOT NULL, PRIMARY KEY (version, seq)) STRICT, WITHOUT ROWID`);
    storage.sql.exec("INSERT INTO doc_seq (version, seq, run, context, carry) VALUES ('v', 0, 'r', 'c', '')");

    for (let open = 0; open < 2; open++) {
      let store = new DocStore(storage);

      expect(columnsOf(storage, "doc_seq")).toEqual(columnsOf(fresh, "doc_seq"));
      expect(storage.rows().doc_format).toEqual([{ id: 0, format: DOC_STORE_FORMAT }]);
      let head = store.keep(DOC, copyOf([PROSE()]), NONE);
      expect(store.tab(baseOf(store, head))).toEqual(PROSE());
    }
    expect(counts(storage)).toMatchObject({ doc_copy: 1, doc_seq: 1 });
  });

  it("names its format by the copy's version", () => {
    let { storage } = opened();

    expect(DOC_STORE_FORMAT).toBe(`${DOC_COPY_FORMAT_VERSION}`);
    expect(storage.rows().doc_format).toEqual([{ id: 0, format: DOC_STORE_FORMAT }]);
  });

  describe("under another digest", () => {
    // A two-tab document written under digest "a": a read, a result with its child, an index check.
    function written() {
      let storage = fakeDocStorage();
      let a = new DocStore(storage, undefined, "a");
      let head = a.keep(DOC, copyOf([PROSE(), NOTES()]), NONE);
      let base = baseOf(a, head);
      a.markdown(base);
      let child = scenarioEdit(a, base, "e1");
      a.unindexed(base);
      return { storage, head, base, child, fetched: fetchedRows(storage, DOC) };
    }
    const PENDING: DocPending = { edits: ["e1"], roots: [] };
    const madeIn = (storage: FakeDocStorage, table: string) => rowsOf(storage, table).map(row => row.made);

    it("opens with one read and no write", () => {
      let { storage } = written();
      let before = storage.rows();
      let statements: string[] = [];
      storage.refuse(statement => {
        statements.push(statement);
        return false;
      });

      let b = new DocStore(storage, undefined, "b");
      // The format's own table and its row: no statement for a table of documents.
      let ran = statements.filter(statement => !statement.startsWith("CREATE TABLE IF NOT EXISTS doc_format"));

      expect(ran).toEqual(["SELECT format FROM doc_format WHERE id = 0"]);
      expect(storage.rows()).toEqual(before);
      expect(b.head(DOC)?.made).toBe("a");
    });

    it("keeps what was fetched, byte for byte", () => {
      let { storage, base, fetched } = written();
      let b = new DocStore(storage, undefined, "b");
      let calls = [
        () => b.result(base, "e1"), () => b.markdown(base), () => b.summary(base),
        () => b.unindexed(base), () => scenarioEdit(b, base, "e1"), () => b.sweep(DOC, PENDING),
        () => b.sweep(DOC, NONE),
      ];

      // The four runs of the two tabs and the context they share.
      expect(fetched.doc_run).toHaveLength(5);
      expect(fetched.doc_seq).toHaveLength(4);
      for (let call of calls) {
        call();
        expect(fetchedRows(storage, DOC), String(call)).toEqual(fetched);
      }
    });

    it("replaces in place what the other digest made", () => {
      let { storage, base, child } = written();
      let b = new DocStore(storage, undefined, "b");
      let before = counts(storage);

      // The child reads the same under both digests: its rows and the base's are written in place.
      let cost = spent(() => {
        b.markdown(base);
        expect(scenarioEdit(b, base, "e1").id).toBe(child.id);
      });

      expect(cost.rowsWritten).toBe(7);
      expect(counts(storage)).toEqual(before);
      expect(madeIn(storage, "doc_result")).toEqual(["b"]);
      // The second tab's three runs were not read.
      expect(madeIn(storage, "doc_md").toSorted()).toEqual(["a", "a", "a", "b", "b"]);
      expect(b.result(base, "e1")).toMatchObject({ after: { id: child.id } });
    });

    it("writes over everything the other digest's row held, not only its mark", () => {
      let { storage, head, base, child } = written();
      let a = new DocStore(storage, undefined, "a");
      let markdown = docTabToMarkdown(PROSE()).markdown;
      let summary = a.summary(base);
      // Both digests run the same code, so "a"'s rows are made to say what other code would derive.
      storage.sql.exec("UPDATE doc_md SET md = 'stale', summary = ?", JSON.stringify({ markdownLength: 5, tables: [] })).toArray();
      storage.sql.exec("UPDATE doc_result SET result = ?, child = ?", JSON.stringify({ requests: [] }), head.versions[1]).toArray();
      let b = new DocStore(storage, undefined, "b");

      expect(b.markdown(base)).toBe(markdown);
      // Read from storage: the row is this digest's, whole.
      expect(spent(() => expect(b.markdown(base)).toBe(markdown))).toMatchObject({ runsRendered: 0 });
      expect(spent(() => expect(b.summary(base)).toEqual(summary))).toMatchObject({ runsRendered: 0 });
      expect(scenarioEdit(b, base, "e1").id).toBe(child.id);
      expect(b.result(base, "e1")).toEqual({ requests: typing(PROSE(), "e1"), after: child });
      expect(rowsOf(storage, "doc_result")).toHaveLength(1);
    });

    it("replaces a refusal by requests and requests by a refusal", () => {
      let { storage, base } = written();
      let refusal: DocRefusal = { reason: "The text was not found." };
      let a = new DocStore(storage, undefined, "a");
      a.putResult(base, "e2", { refusal });
      let b = new DocStore(storage, undefined, "b");
      let child = (edit: string) => rowsOf(storage, "doc_result").find(row => row.edit === edit)?.child;

      b.putResult(base, "e2", { requests: [], after: base });
      b.putResult(base, "e1", { refusal });

      expect(b.result(base, "e2")).toEqual({ requests: [], after: base });
      expect(child("e2")).toBe(base.id);
      expect(b.result(base, "e1")).toEqual({ refusal });
      expect(child("e1")).toBeNull();
      expect(madeIn(storage, "doc_result")).toEqual(["b", "b"]);
    });

    it("says again whether the model indexes a tab as fetched that is stored again, so nothing is decoded for it", () => {
      let { storage, base } = written();
      let b = new DocStore(storage, undefined, "b");
      let derived = () => rowsOf(storage, "doc_version").find(row => row.id === base.id)?.derived;
      expect(derived()).toBe(JSON.stringify({ made: "a", unindexed: false, keyed: true }));

      // The tab is in hand: its run is rendered and keyed, and its three rows written in place.
      expect(spent(() => expect(b.putTab(DOC, PROSE(), []).id).toBe(base.id))).toMatchObject({
        rowsWritten: 3, runsDecoded: 0, runsRendered: 1,
      });

      expect(derived()).toBe(JSON.stringify({ made: "b", unindexed: false, keyed: true }));
      expect(spent(() => expect(b.unindexed(base)).toBe(false))).toMatchObject({ runsDecoded: 0, rowsWritten: 0 });
      expect(spent(() => b.putTab(DOC, PROSE(), [])).rowsWritten).toBe(0);
    });

    it("removes the other digest's renderings from a document with no pending edit, where no version and no result goes", () => {
      let { storage, store: a } = opened(undefined, "a");
      let head = a.keep(DOC, copyOf([PROSE(), NOTES()]), NONE);
      a.markdown(baseOf(a, head));
      let b = new DocStore(storage, undefined, "b");

      b.sweep(DOC, NONE);

      expect(rowsOf(storage, "doc_md")).toEqual([]);
      expect(b.head(DOC)).toEqual({ ...head, made: "b" });
      expect(counts(storage)).toEqual({ ...EMPTY, doc_copy: 1, doc_run: 5, doc_seq: 4, doc_version: 2 });
    });

    it("removes the other digest's renderings of the tab beside the one a pending edit of this digest was made in", () => {
      let { storage, store: a } = opened(undefined, "a");
      let head = a.keep(DOC, copyOf([PROSE(), NOTES()]), NONE);
      let base = baseOf(a, head);
      let child = edited(a, base, "e1");
      let b = new DocStore(storage, undefined, "b");
      // The edit made again keys parent and child under this digest; the unread tab beside stays.
      expect(edited(b, base, "e1").id).toBe(child.id);
      expect(madeIn(storage, "doc_md").toSorted()).toEqual(["a", "a", "a", "b", "b"]);

      b.sweep(DOC, PENDING);

      expect(madeIn(storage, "doc_md")).toEqual(["b", "b"]);
      expect(rowsOf(storage, "doc_version").map(row => row.id).toSorted())
        .toEqual([...head.versions, child.id].toSorted());
      expect(b.result(base, "e1")).toMatchObject({ after: { id: child.id } });
    });

    it("keeps the record marked through a keep, until that keep's sweep", () => {
      let { storage, head } = written();
      let b = new DocStore(storage, undefined, "b");

      let kept = b.keep(DOC, copyOf([PROSE(), NOTES()]), PENDING);

      expect(kept).toEqual({ ...head, made: "b" });
      expect(b.head(DOC)).toEqual(kept);
      // The keep re-keyed each tab from the tab in hand; the child's rows went with its version.
      expect(madeIn(storage, "doc_md")).toEqual(["b", "b", "b", "b"]);
      expect(madeIn(storage, "doc_result")).toEqual([]);
    });

    it("sweeps one document and leaves another's rows of the other digest, unread", () => {
      let { storage, base } = written();
      let a = new DocStore(storage, undefined, "a");
      let second = baseOf(a, a.keep("second", copyOf([tabOf("t1", [para("Second")])]), NONE), 0, "second");
      a.markdown(second);
      scenarioEdit(a, second, "e1");
      let b = new DocStore(storage, undefined, "b");

      b.sweep(DOC, PENDING);

      expect(rowsOf(storage, "doc_result").map(row => [row.version, row.made])).toEqual([[second.id, "a"]]);
      expect(madeIn(storage, "doc_md")).toEqual(["a", "a"]);
      expect(b.head("second")!.made).toBe("a");
      expect(b.result(second, "e1")).toBeUndefined();
      expect(spent(() => b.markdown(second))).toMatchObject({ runsDecoded: 1, runsRendered: 1 });
      expect(b.result(base, "e1")).toBeUndefined();
    });

    it("is not lost half-way", () => {
      let { storage, base } = written();
      let b = new DocStore(storage, undefined, "b");
      let before = storage.rows();
      storage.refuse(statement => statement.startsWith("DELETE FROM doc_md"));

      expect(() => b.sweep(DOC, PENDING)).toThrow("storage refused the write");

      expect(storage.rows()).toEqual(before);
      storage.refuse(statement => /^(INSERT|UPDATE)/.test(statement));
      expect(b.result(base, "e1")).toBeUndefined();
      expect(() => b.markdown(base)).toThrow("storage refused the write");
      storage.refuse(undefined);
      b.sweep(DOC, PENDING);
      expect(madeIn(storage, "doc_result")).toEqual([]);
      expect(madeIn(storage, "doc_md")).toEqual([]);
      expect(b.head(DOC)!.made).toBe("b");
    });
  });

  it("says whether the model indexes a tab without decoding it, under the digest that stored it", () => {
    let { storage, store } = opened();
    let indexed = PROSE();
    // A tab whose last paragraph Google sent one index short of what the model counts.
    let off = PROSE();
    off.body.content.at(-1)!.endIndex += 1;
    expect([hasModelIndexes(indexed), hasModelIndexes(off)]).toEqual([true, false]);
    let versions = [store.putTab(DOC, indexed, []), store.putTab("off", off, [])];

    let ran = newStatements(storage, () => {
      let cost = spent(() => {
        expect(versions.map(version => store.unindexed(version))).toEqual([false, true]);
      });
      expect(cost).toMatchObject({ runsDecoded: 0, rowsWritten: 0 });
    });
    expect(ran).toEqual([]);
    expect(storage.statements()).toContain("SELECT derived FROM doc_version WHERE doc = ? AND id = ?");
  });

  it("answers that the model indexes a version it made, reading nothing", () => {
    let { storage, store } = opened();
    let tab = PROSE();
    let made = store.putTab(DOC, applyDocsRequests(tab, typing(tab, "x")), []);
    let asked = 0;
    storage.refuse(() => {
      asked++;
      return false;
    });

    expect(made.exact).toBe(true);
    expect(store.unindexed(made)).toBe(false);
    expect(asked).toBe(0);
  });

  it("stores a tab the model made without walking it for its indexes", () => {
    let { storage, store } = opened();
    let walk = vi.spyOn(model, "hasModelIndexes");
    try {
      let tab = PROSE();
      let made = store.putTab(DOC, applyDocsRequests(tab, typing(tab, "x")), []);
      expect(walk).toHaveBeenCalledTimes(0);
      expect(rowsOf(storage, "doc_version").find(row => row.id === made.id)?.derived)
        .toBe(JSON.stringify({
          made: store.keep("other", copyOf([]), NONE).made, unindexed: false, keyed: true,
        }));

      store.putTab(DOC, tab, []);
      expect(walk).toHaveBeenCalledTimes(1);
      // A version this digest stored is not walked again.
      store.putTab(DOC, tab, []);
      expect(walk).toHaveBeenCalledTimes(1);
    } finally {
      walk.mockRestore();
    }
  });

  it("counts the Markdown that passes through it", () => {
    let { store } = opened();
    let tab = NOTES();
    let { length } = docTabToMarkdown(tab).markdown;
    // The tab's three runs, and the Markdown of each rendered alone, in order.
    let runs = [...cutRuns(tab.body.content, RUN_SIZES)];
    let carry = initialCarry();
    let lengths = runs.map(run => {
      let rendered = renderRun(run.elements, tab, carry, { mdStart: 0 });
      advanceCarry(carry, rendered.summary);
      return rendered.markdown.length;
    });
    let longest = Math.max(...lengths);
    expect(lengths).toHaveLength(3);
    expect(longest).toBeLessThan(length);
    let peak = (run: () => unknown) => spent(run).peakMarkdownCharsInHand;

    // Storing holds one run's Markdown at a time, so the peak is the longest run's.
    let version = store.putTab("first", tab, []);
    expect(peak(() => version = store.putTab(DOC, tab, []))).toBe(longest);
    expect(peak(() => store.putTab(DOC, tab, []))).toBe(0);
    // A version's Markdown answered is the tab's.
    expect(peak(() => store.markdown(version))).toBe(length);
    expect(peak(() => store.summary(version))).toBe(0);
    // An append's piece here is the whole tab: the closure of the last paragraph holds all three runs.
    expect(peak(() => docEditResult(store, version, { type: "appendText", markdown: "More" }))).toBe(length);
    // On a longer tab the piece is the last two runs, joined.
    let longer = tabOf("t3", [
      para("Notes"), grid(["a", "b"]), para("Middle"), grid(["c", "d"]), para("Near"), para("End"),
    ]);
    let longerCarry = initialCarry();
    let longerLengths = [...cutRuns(longer.body.content, RUN_SIZES)].map(run => {
      let rendered = renderRun(run.elements, longer, longerCarry, { mdStart: 0 });
      advanceCarry(longerCarry, rendered.summary);
      return rendered.markdown.length;
    });
    expect(longerLengths).toHaveLength(5);
    let stored = store.putTab("longer", longer, []);
    expect(peak(() => docEditResult(store, stored, { type: "appendText", markdown: "More" })))
      .toBe(longerLengths[3] + longerLengths[4]);
    expect(longerLengths[3] + longerLengths[4]).toBeLessThan(docTabToMarkdown(longer).markdown.length);
    // Two bytes a character, from a run's read to its parse and from its cut to its store.
    let longestRun = 2 * Math.max(...runs.map(run => run.json.length));
    expect(spent(() => store.tab(version)).peakRunBytesInHand).toBe(longestRun);
    expect(spent(() => store.putTab(DOC, tab, [])).peakRunBytesInHand).toBe(longestRun);
  });

  it("gives on the fake what it gives on real storage", () => {
    // The workerd project runs the same two scenarios in a Durable Object and expects these.
    expect(storeScenario(fakeDocStorage())).toEqual(STORE_SCENARIO);
    expect(anotherDigestScenario(fakeDocStorage())).toEqual(ANOTHER_DIGEST_SCENARIO);
  });

  it("is made over a storage of its own by fakeDocStore", () => {
    let [one, two] = [fakeDocStore(), fakeDocStore("9", "x")];

    one.keep(DOC, copyOf([PROSE()]), NONE);

    expect(one.head(DOC)).toBeDefined();
    expect(two.head(DOC)).toBeUndefined();
    expect(two.keep(DOC, copyOf([PROSE()]), NONE).made).toBe("x");
  });
});

// ---------------------------------------------------------------------------
// A version of several runs
// ---------------------------------------------------------------------------

type ListRow = { version: string; seq: number; run: string; context: string; carry: string; size: number };
type MarkdownRow = { run: string; context: string; carry: string; made: string; summary: string; md: string };

/** The rows of `version`'s run list, in order. */
const listOf = (storage: FakeDocStorage, version: DocVersion) =>
  (rowsOf(storage, "doc_seq") as ListRow[]).filter(row => row.version === version.id);

/** The row of the rendering `row` names, where one is stored. */
const renderingOf = (storage: FakeDocStorage, { run, context, carry }: ListRow) =>
  (rowsOf(storage, "doc_md") as MarkdownRow[])
    .find(row => row.run === run && row.context === context && row.carry === carry);

describe("DocStore, a version of several runs", () => {
  // Eight one-element runs whose keys show a carried number, a blank line before, and nothing ('').
  const SEVERAL = () => tabOf("t1", [
    para("Intro"), item("first", "N1"), item("second", "N1"), para("Between"),
    item("third", "N1"), grid(["a", "b"], ["c", "d"]), para("Close"),
  ], NUMBERED_LIST);
  const [BREAK, INTRO, SECOND, THIRD, TABLE, CLOSE] = [0, 1, 3, 5, 6, 7];
  const BLANK_LINE = JSON.stringify({ s: true });

  /** `tab` stored under runs of one element, with its rendering whole and each run's place in it. */
  function kept(tab = SEVERAL(), doc = DOC, on = opened(undefined, undefined, ONE)) {
    let { storage, store } = on;
    let version = store.putTab(doc, tab, []);
    let whole = docTabToMarkdown(tab);
    let list = listOf(storage, version);
    // Where each run's Markdown stands in the tab's: the running sum of the summaries' lengths.
    let start = 0;
    let inPlace = list.map(row => {
      let { markdownLength } = JSON.parse(renderingOf(storage, row)!.summary) as DocRunSummary;
      return whole.markdown.slice(start, start += markdownLength);
    });
    /** What `renderRun` gives the elements of run `at` from the initial carry. */
    let alone = (at: number) => renderRun(
      [...cutRuns(tab.body.content, ONE)][at].elements, tab, initialCarry(), { mdStart: 0 }).markdown;
    return { storage, store, version, tab, whole, list, inPlace, alone };
  }

  /** Removes the rendering `row` names. */
  const remove = (storage: FakeDocStorage, { run, context, carry }: ListRow) => storage.sql.exec(
    "DELETE FROM doc_md WHERE run = ? AND context = ? AND carry = ?", run, context, carry).toArray();

  it("is cut into eight runs, each keyed by what it shows of the carry", () => {
    let { list, inPlace, whole } = kept();

    expect(list).toHaveLength(8);
    expect(list.map(row => row.carry)).toEqual([
      "", "", BLANK_LINE, "", BLANK_LINE, JSON.stringify({ n: { N1: { 0: 2 } }, s: true }),
      BLANK_LINE, BLANK_LINE,
    ]);
    // The three items read the tab's one list, and no other run reads anything of the context.
    let [, , first] = list;
    expect(first.context).toMatch(/^[0-9a-f]{64}$/);
    expect(list.map(row => row.context)).toEqual(
      ["", "", first.context, first.context, "", first.context, "", ""]);
    expect(inPlace.join("")).toBe(whole.markdown);
    expect(inPlace.slice(0, 6)).toEqual(
      ["", "Intro\n", "\n1. first\n", "1. second\n", "\nBetween\n", "\n3. third\n"]);
  });

  it("decodes a version of several runs in order", () => {
    let { store, version, tab } = kept();
    let longest = Math.max(...[...cutRuns(tab.body.content, ONE)].map(run => run.json.length));

    let cost = spent(() => expect(store.tab(version)).toEqual(tab));

    expect(cost.runsDecoded).toBe(8);
    // Each run's JSON was in hand alone.
    expect(cost.peakRunBytesInHand).toBe(2 * longest);
  });

  it("joins the stored Markdown of a version's runs", () => {
    let { storage, store, version, whole, list, inPlace } = kept();

    let cost = spent(() => expect(store.markdown(version)).toBe(whole.markdown));

    expect(cost).toMatchObject({ runsDecoded: 0, runsRendered: 0, rowsWritten: 0 });
    // Each row holds ITS run's Markdown, and none the tab's.
    let stored = list.map(row => renderingOf(storage, row)!.md);
    expect(stored).toEqual(inPlace);
    expect(stored).not.toContain(whole.markdown);
    expect(counts(storage).doc_md).toBe(8);
  });

  it("joins the summaries of a version's runs", () => {
    let { storage, store, version, whole, list } = kept();
    let fields = ["blank", "blocks", "markdownLength", "numberedItems", "protectedRanges", "tables"];

    let summary = storedSummary(store, version);

    expect(summary).toEqual(summaryOf(whole));
    expect(summary).toMatchObject({ blank: false, numberedItems: true, protectedRanges: 1 });
    // The seventh run: the table's place in the tab adds the six runs before to its run's summary.
    let own = (JSON.parse(renderingOf(storage, list[TABLE])!.summary) as DocRunSummary).tables[0];
    let [table] = summary.tables;
    expect(own.start).toBe(0);
    expect(table.start).toBe(list.slice(0, TABLE).reduce((sum, row) => sum + row.size, 0));
    expect(table.mdStart - own.mdStart).toBe(whole.markdown.indexOf("\n<table>"));
    expect(table.mdEnd - table.mdStart).toBe(own.mdEnd - own.mdStart);
    // The answer holds a summary's fields and no other, for one run as for many.
    expect(Object.keys(summary).toSorted()).toEqual(fields);
    expect(Object.keys(JSON.parse(renderingOf(storage, list[TABLE])!.summary))).toContain("run");
    let single = opened();
    let one = single.store.putTab(DOC, PROSE(), []);
    expect(listOf(single.storage, one)).toHaveLength(1);
    expect(Object.keys(single.store.summary(one)).toSorted()).toEqual(fields);
    expect(single.store.summary(one)).toEqual(summaryOf(docTabToMarkdown(PROSE())));
    // A tab whose every run is blank is blank; one with a blank first run and text later is not.
    let empty = kept(tabOf("t2", [para("")]));
    expect(empty.list).toHaveLength(2);
    expect(empty.store.summary(empty.version)).toEqual(summaryOf(empty.whole));
    expect(empty.store.summary(empty.version).blank).toBe(true);
    let later = kept(tabOf("t3", [para(""), para("Text")]));
    expect(JSON.parse(renderingOf(later.storage, later.list[BREAK])!.summary)).toMatchObject({ blank: true });
    expect(later.store.summary(later.version)).toEqual(summaryOf(later.whole));
    expect(later.store.summary(later.version).blank).toBe(false);
  });

  it.each([
    ["the third item's, which shows a carried number", THIRD, "markdown"],
    ["the closing paragraph's, which shows a blank line", CLOSE, "markdown"],
    ["the second item's, which shows nothing of the carry", SECOND, "markdown"],
    ["the opening section break's, which writes nothing", BREAK, "markdown"],
    ["the third item's, read by the summary first", THIRD, "summary"],
    ["the table's, read by the summary first", TABLE, "summary"],
  ] as const)("a version with one run's rendering missing renders that run alone: %s", (_name, at, read) => {
    let { storage, store, version, whole, list, inPlace, alone } = kept();
    let before = rowsOf(storage, "doc_md");
    remove(storage, list[at]);
    expect(counts(storage).doc_md).toBe(7);
    let renders = replayCost.renders;

    let cost = spent(() => {
      if (read === "markdown") expect(store.markdown(version)).toBe(whole.markdown);
      else expect(store.summary(version)).toEqual(summaryOf(whole));
    });

    // That run alone, with the carry it is entered with: never the tab.
    expect(cost).toMatchObject({ runsDecoded: 1, runsRendered: 1, rowsWritten: 1 });
    expect(replayCost.renders).toBe(renders);
    // The row written holds that run's Markdown under the list's key; every other row is as it was.
    expect(renderingOf(storage, list[at])!.md).toBe(inPlace[at]);
    expect(rowsOf(storage, "doc_md")).toEqual(before);
    expect(store.markdown(version)).toBe(whole.markdown);
    expect(spent(() => {
      store.markdown(version);
      store.summary(version);
    })).toMatchObject({ runsDecoded: 0, runsRendered: 0, rowsWritten: 0 });

    if (at === THIRD) {
      // The carry matters: rendered alone with the initial carry, the run would read otherwise.
      expect(JSON.parse(list[at].carry)).toEqual({ n: { N1: { 0: 2 } }, s: true });
      expect(inPlace[at]).toBe("\n3. third\n");
      expect(alone(at)).toBe("1. third\n");
    } else if (at === CLOSE) {
      expect(list[at].carry).toBe(BLANK_LINE);
      expect(inPlace[at]).toBe("\nClose\n");
      expect(alone(at)).toBe("Close\n");
    } else if (at === SECOND) {
      // A continued item shows nothing of the carry: in place it reads as it does alone.
      expect(list[at].carry).toBe("");
      expect(inPlace[at]).toBe("1. second\n");
      expect(alone(at)).toBe(inPlace[at]);
    } else if (at === TABLE) {
      // Its place matters: the read answered the table's start in the tab, the row from the run's.
      let [own] = (JSON.parse(renderingOf(storage, list[at])!.summary) as DocRunSummary).tables;
      expect(own.start).toBe(0);
      expect(summaryOf(whole).tables[0].start).toBe(list.slice(0, at).reduce((sum, row) => sum + row.size, 0));
      expect(summaryOf(whole).tables[0].start).toBeGreaterThan(0);
    } else {
      expect([list[at].context, list[at].carry, inPlace[at]]).toEqual(["", "", ""]);
    }
  });

  it("two versions that share their first runs read their own Markdown", () => {
    // Two tabs of one document that open with the same paragraph and differ after it.
    let on = opened(undefined, undefined, ONE);
    let one = kept(tabOf("t1", [para("Same"), para("Alpha")]), DOC, on);
    let two = kept(tabOf("t2", [para("Same"), para("Beta")]), DOC, on);
    let { storage, store } = on;
    let shared = (at: number) => {
      expect(two.list[at]).toMatchObject({ run: one.list[at].run, context: "", carry: "" });
      return one.list[at];
    };

    // They share two runs and their renderings: the opening break's (empty) and the paragraph's.
    expect([one.list.length, two.list.length]).toEqual([3, 3]);
    expect(renderingOf(storage, shared(BREAK))!.md).toBe("");
    expect(renderingOf(storage, shared(INTRO))!.md).toBe("Same\n");
    expect(two.list[2].run).not.toBe(one.list[2].run);
    expect(counts(storage)).toMatchObject({ doc_md: 4, doc_run: 5, doc_seq: 6 });
    expect(store.markdown(one.version)).toBe("Same\n\nAlpha\n");
    expect(store.markdown(two.version)).toBe("Same\n\nBeta\n");

    // A missing shared rendering is rendered again, that run alone, by whichever version reads
    // first.
    for (let [at, markdown] of [[INTRO, "Same\n"], [BREAK, ""]] as const) {
      let before = rowsOf(storage, "doc_md");
      remove(storage, shared(at));
      expect(spent(() => expect(store.markdown(two.version)).toBe("Same\n\nBeta\n")))
        .toMatchObject({ runsDecoded: 1, runsRendered: 1, rowsWritten: 1 });
      expect(renderingOf(storage, shared(at))!.md).toBe(markdown);
      expect(rowsOf(storage, "doc_md")).toEqual(before);
      expect(spent(() => expect(store.markdown(one.version)).toBe("Same\n\nAlpha\n")))
        .toMatchObject({ runsDecoded: 0, runsRendered: 0, rowsWritten: 0 });
    }
  });

  it("a stored Markdown that does not read back is rendered again, that run alone", () => {
    let { storage, store, version, whole, list, inPlace } = kept();
    let before = rowsOf(storage, "doc_md");
    let { run, context, carry } = list[THIRD];
    // The mark of a Markdown stored as JSON, before text that is not JSON.
    storage.sql.exec(
      "UPDATE doc_md SET md = ?4 WHERE run = ?1 AND context = ?2 AND carry = ?3",
      run, context, carry, "\u0001not a Markdown this code stored").toArray();

    expect(spent(() => expect(store.markdown(version)).toBe(whole.markdown)))
      .toMatchObject({ runsDecoded: 1, runsRendered: 1, rowsWritten: 1 });
    // Written over: the row reads back, and the next read renders nothing.
    expect(renderingOf(storage, list[THIRD])!.md).toBe(inPlace[THIRD]);
    expect(rowsOf(storage, "doc_md")).toEqual(before);
    expect(spent(() => store.markdown(version)))
      .toMatchObject({ runsDecoded: 0, runsRendered: 0, rowsWritten: 0 });

    // And a summary that does not read back, through a read of the summary.
    storage.sql.exec(
      "UPDATE doc_md SET summary = '{}' WHERE run = ?1 AND context = ?2 AND carry = ?3",
      run, context, carry).toArray();
    expect(spent(() => expect(store.summary(version)).toEqual(summaryOf(whole))))
      .toMatchObject({ runsDecoded: 1, runsRendered: 1, rowsWritten: 1 });
    expect(rowsOf(storage, "doc_md")).toEqual(before);
    expect(spent(() => store.summary(version)))
      .toMatchObject({ runsDecoded: 0, runsRendered: 0, rowsWritten: 0 });

    // And a summary that holds what a reader asks but not the run's own summary.
    let { run: _run, ...asked } = JSON.parse(renderingOf(storage, list[THIRD])!.summary);
    expect(Object.keys(asked).toSorted()).toEqual(Object.keys(summaryOf(whole)).toSorted());
    storage.sql.exec(
      "UPDATE doc_md SET summary = ?4 WHERE run = ?1 AND context = ?2 AND carry = ?3",
      run, context, carry, JSON.stringify(asked)).toArray();
    expect(spent(() => expect(store.summary(version)).toEqual(summaryOf(whole))))
      .toMatchObject({ runsDecoded: 1, runsRendered: 1, rowsWritten: 1 });
    expect(rowsOf(storage, "doc_md")).toEqual(before);
    expect(store.markdown(version)).toBe(whole.markdown);
  });

  // A record that says its keys are the store's over an empty list, as a part-swept version leaves.
  it.each(["markdown", "summary", "tab"] as const)(
    "a keyed version whose list is gone is unreadable, never an empty tab: %s", read => {
      let { storage, store } = opened(undefined, undefined, ONE);
      let version = baseOf(store, store.keep(DOC, copyOf([SEVERAL()], {}, ONE), NONE));
      let whole = docTabToMarkdown(SEVERAL());
      expect(store[read](version)).toEqual({
        markdown: whole.markdown, summary: summaryOf(whole), tab: SEVERAL(),
      }[read]);
      storage.sql.exec("DELETE FROM doc_seq WHERE version = ?", version.id).toArray();

      expect(() => store[read](version)).toThrow(new Error(DOC_COPY_UNREADABLE));

      expect(store.head(DOC)).toBeUndefined();
      expect(counts(storage)).toMatchObject({ doc_copy: 0, doc_version: 0 });
    },
  );

  // A run that holds a footnote is stored with its numbers counted from the run's start, and
  // decoded with the number of the references before it, which the carry holds.
  it("a run rendered alone, or keyed again, shows its footnotes numbered by their place in the tab", () => {
    let on = opened(undefined, "a", ONE);
    let { storage, store, version, whole, list, inPlace } = kept(tabOf("t1", [
      { runs: ["First", footnote(1), ".\n"] }, { runs: ["Second", footnote(2), ".\n"] },
      { runs: ["Third", footnote(3), ".\n"] },
    ]), DOC, on);
    let last = 3;
    expect(list).toHaveLength(4);
    // The third paragraph's run stores its reference as 1; its key holds the two before it.
    expect(rowsOf(storage, "doc_run").find(row => row.id === list[last].run)!.json)
      .toContain('"footnoteNumber":1');
    expect(JSON.parse(list[last].carry)).toEqual({ f: 2, s: true });
    expect(inPlace[last]).toBe("\nThird\\[3\\].\n");
    let before = rowsOf(storage, "doc_md");

    remove(storage, list[last]);
    expect(spent(() => expect(store.markdown(version)).toBe(whole.markdown)))
      .toMatchObject({ runsDecoded: 1, runsRendered: 1, rowsWritten: 1 });
    expect(rowsOf(storage, "doc_md")).toEqual(before);

    // Under another digest every run is rendered again, each under the key it had.
    let other = new DocStore(storage, undefined, "b", ONE);
    expect(spent(() => expect(other.markdown(version)).toBe(whole.markdown)))
      .toMatchObject({ runsDecoded: 4, runsRendered: 4 });
    expect(listOf(storage, version)).toEqual(list);
    expect(rowsOf(storage, "doc_md")).toEqual(before.map(row => ({ ...row, made: "b" })));
    expect(other.summary(version)).toEqual(summaryOf(whole));
  });

  // A subtitle reads as italic unless the tab's named styles say it is not: these say so, and
  // that one fact of them is the context a run rendered alone, or keyed again, is handed.
  it("a run rendered alone, or keyed again, reads the tab's named styles", () => {
    let tab: GoogleDocsTab = {
      ...tabOf("t1", [para("Intro"), { runs: ["Under\n"], namedStyleType: "SUBTITLE" }, para("Close")]),
      namedStyles: { styles: [{ namedStyleType: "NORMAL_TEXT" }, { namedStyleType: "SUBTITLE", textStyle: {} }] },
    };
    let { storage, store, version, whole, list, inPlace } = kept(tab, DOC, opened(undefined, "a", ONE));
    let subtitle = 2;
    let { namedStyles: _styles, ...unstyled } = tab;
    expect(inPlace[subtitle]).toBe("\nUnder\n");
    expect(docTabToMarkdown(unstyled).markdown).toContain("*Under*");
    expect(list[subtitle].context).toMatch(/^[0-9a-f]{64}$/);
    let before = rowsOf(storage, "doc_md");

    remove(storage, list[subtitle]);
    expect(spent(() => expect(store.markdown(version)).toBe(whole.markdown)))
      .toMatchObject({ runsDecoded: 1, runsRendered: 1, rowsWritten: 1 });
    expect(rowsOf(storage, "doc_md")).toEqual(before);

    // Under another digest every run is rendered again, each under the key it had.
    let other = new DocStore(storage, undefined, "b", ONE);
    expect(other.markdown(version)).toBe(whole.markdown);
    expect(listOf(storage, version)).toEqual(list);
    expect(rowsOf(storage, "doc_md")).toEqual(before.map(row => ({ ...row, made: "b" })));
  });

  // Keyed again, a table's run is summarised with the table's start in that run, as a keep does.
  it("a version keyed again under another digest summarises a table where it stands", () => {
    let { storage, version, whole, list } = kept(SEVERAL(), DOC, opened(undefined, "a", ONE));
    let before = rowsOf(storage, "doc_md");
    // The table's start in the tab: the sizes of the six runs before its own.
    let start = list.slice(0, TABLE).reduce((sum, row) => sum + row.size, 0);
    expect(start).toBeGreaterThan(0);

    let other = new DocStore(storage, undefined, "b", ONE);

    expect(other.summary(version)).toEqual(summaryOf(whole));
    expect(other.summary(version).tables.map(table => table.start)).toEqual([start]);
    expect(listOf(storage, version)).toEqual(list);
    expect(rowsOf(storage, "doc_md")).toEqual(before.map(row => ({ ...row, made: "b" })));
  });

  it("a rendering stored under a key the list does not name is not served", () => {
    let { storage, store, version, whole, list } = kept();
    let { run, context } = list[THIRD];
    // What another version would have stored of the same run entered with another carry.
    let planted = { run, context, carry: BLANK_LINE, made: store.keep("other", copyOf([], {}, ONE), NONE).made };
    storage.sql.exec(
      "INSERT INTO doc_md (doc, run, context, carry, made, summary, md) VALUES (?, ?, ?, ?, ?, ?, ?)",
      DOC, run, context, planted.carry, planted.made, renderingOf(storage, list[THIRD])!.summary,
      "\n1. planted\n").toArray();

    expect(spent(() => expect(store.markdown(version)).toBe(whole.markdown)))
      .toMatchObject({ runsDecoded: 0, runsRendered: 0, rowsWritten: 0 });
    expect(renderingOf(storage, { ...list[THIRD], carry: planted.carry })!.md).toBe("\n1. planted\n");
  });

  it("has asks of a version's runs with one statement", () => {
    let small = kept();
    let large = opened(undefined, undefined, ONE);
    let long = large.store.putTab(
      DOC, tabOf("large", Array.from({ length: 2_000 }, (_, at) => para(`Line ${at}.`))), []);
    /** Every statement `run` gave storage, in order. */
    let asked = (storage: FakeDocStorage, run: () => unknown) => {
      let statements: string[] = [];
      storage.refuse(statement => {
        statements.push(statement);
        return false;
      });
      run();
      storage.refuse(undefined);
      return statements;
    };

    expect([small.list.length, listOf(large.storage, long).length]).toEqual([8, 2_001]);
    let statements = asked(small.storage, () => expect(small.store.has(small.version)).toBe(true));
    // The version's record, its runs and its context: three, whatever the number of runs.
    expect(statements).toHaveLength(3);
    expect(asked(large.storage, () => expect(large.store.has(long)).toBe(true))).toEqual(statements);
    // The runs are reached by their key's index, and no content is read.
    let [, runs] = statements;
    expect(runs).toContain("LEFT JOIN doc_run");
    expect(small.storage.plan(runs).filter(step => /doc_run/.test(step)))
      .toEqual([expect.stringMatching(/^SEARCH doc_run USING COVERING INDEX \S+ \(doc=\? AND id=\?\) LEFT-JOIN$/)]);

    // One listed run is gone.
    let { storage, store, version, list } = small;
    storage.sql.exec("DELETE FROM doc_run WHERE id = ?", list[THIRD].run).toArray();
    expect(store.has(version)).toBe(false);
    // The context is gone.
    let again = kept();
    again.storage.sql.exec(
      "DELETE FROM doc_run WHERE id = ?", rowsOf(again.storage, "doc_version")[0].context).toArray();
    expect(again.store.has(again.version)).toBe(false);
    // The list is empty.
    let emptied = kept();
    emptied.storage.sql.exec("DELETE FROM doc_seq WHERE version = ?", emptied.version.id).toArray();
    expect(emptied.store.has(emptied.version)).toBe(false);
  });

  it("a run of no element among others is unreadable", () => {
    let { storage, store } = opened(undefined, undefined, ONE);
    let version = baseOf(store, store.keep(DOC, copyOf([tabOf("t1", [para("One"), para("Two")])], {}, ONE), NONE));
    expect(listOf(storage, version)).toHaveLength(3);
    // The middle run is made the run of an empty body, stored under its own name.
    storage.sql.exec("INSERT INTO doc_run (doc, id, json) VALUES (?, ?, '[]')", DOC, runId("[]")).toArray();
    storage.sql.exec(
      "UPDATE doc_seq SET run = ? WHERE version = ? AND seq = 1", runId("[]"), version.id).toArray();

    expect(() => store.tab(version)).toThrow(new Error(DOC_COPY_UNREADABLE));
    expect(store.head(DOC)).toBeUndefined();
  });

  it("a run of no element among others is unreadable when its elements are asked for", () => {
    let { storage, store } = opened(undefined, undefined, ONE);
    let version = baseOf(store, store.keep(DOC, copyOf([tabOf("t1", [para("One"), para("Two")])], {}, ONE), NONE));
    let next = store.reader(version, 0);
    let runs: StoredRun[] = [];
    for (let run = next(); run; run = next()) runs.push(run);
    expect(runs).toHaveLength(3);
    // The middle run's row is made to hold what an empty body's does.
    storage.sql.exec(
      "UPDATE doc_run SET json = '[]' WHERE doc = ? AND id = ?", DOC, listOf(storage, version)[1].run).toArray();

    expect(() => runs[1].elements(version.bodyEndIndex - runs[2].size - runs[1].size))
      .toThrow(new Error(DOC_COPY_UNREADABLE));
    expect(store.head(DOC)).toBeUndefined();
  });

  // A read that renders finds a run or the context damaged: unreadable, and the copy dropped.
  describe.each([
    ["one run's rendering is missing", undefined],
    ["it is keyed under another digest", "b"],
  ] as const)("a version read where %s", (_when, digest) => {
    it.each([
      ["a run is gone", "run", "DELETE FROM doc_run WHERE id = ?"],
      ["a run is not a list of elements", "run", "UPDATE doc_run SET json = '{}' WHERE id = ?"],
      ["the context is gone", "context", "DELETE FROM doc_run WHERE id = ?"],
      ["the context is not JSON", "context", "UPDATE doc_run SET json = 'not json' WHERE id = ?"],
      ["the context's lists are not an object", "context", "UPDATE doc_run SET json = '{\"lists\":7}' WHERE id = ?"],
      ["the context's named styles are not an object", "context",
        "UPDATE doc_run SET json = '{\"lists\":{\"N1\":{}},\"namedStyles\":7}' WHERE id = ?"],
      ["a list's definition is not an object", "context", "UPDATE doc_run SET json = '{\"lists\":{\"N1\":7}}' WHERE id = ?"],
    ] as const)("is unreadable where %s, and its copy is dropped", (_what, damaged, statement) => {
      for (let read of ["markdown", "summary"] as const) {
        let { storage, store } = opened(undefined, undefined, ONE);
        let base = baseOf(store, store.keep(DOC, copyOf([SEVERAL()], {}, ONE), NONE));
        let third = listOf(storage, base)[THIRD];
        let { context } = rowsOf(storage, "doc_version").find(row => row.id === base.id)!;
        // Its own digest renders only the run lacking a rendering; another renders every run.
        let reader = digest === undefined ? store : new DocStore(storage, undefined, digest, ONE);
        if (digest === undefined) remove(storage, third);
        storage.sql.exec(statement, damaged === "run" ? third.run : context).toArray();

        expect(() => reader[read](base), read).toThrow(new Error(DOC_COPY_UNREADABLE));

        expect(reader.head(DOC), read).toBeUndefined();
        expect(counts(storage), read).toEqual(EMPTY);
        // What is kept next is whole again, and reads.
        let again = baseOf(reader, reader.keep(DOC, copyOf([SEVERAL()], {}, ONE), NONE));
        expect(reader.markdown(again), read).toBe(docTabToMarkdown(SEVERAL()).markdown);
      }
    });
  });

  it("a piece renders in hand and stores nothing", () => {
    let { storage, store, version, whole } = kept();
    let before = storage.rows();
    let renders = replayCost.renders;

    let piece!: DocTabSnapshot;
    let made = spent(() => piece = pieceAtEnd(store, version));

    // Tried from the last run (1), the run before (2), a scout (3) and made from the closure's start (3).
    expect(made).toMatchObject({
      runsDecoded: 1 + 2 + 3 + 3, runsRendered: 1 + 2 + 3 + 3, rowsWritten: 0,
    });
    // No tab is rendered: the store renders runs.
    expect(replayCost.renders - renders).toBe(0);
    expect(whole.markdown.endsWith(piece.markdown)).toBe(true);
    expect(made.peakMarkdownCharsInHand).toBeLessThan(whole.markdown.length);
    expect(storage.rows()).toEqual(before);
  });

  it("every render is counted", () => {
    let { store, version, tab } = kept();
    let rendered = (run: () => unknown) => spent(run).runsRendered;

    // A tab the store decoded is the runs it was decoded from.
    let decoded = store.tab(version);
    expect(rendered(() => renderTab(decoded))).toBe(8);
    // A tab the store was given is the runs it cut it into.
    expect(rendered(() => renderTab(tab))).toBe(8);
    let made = applyDocsRequests(decoded, typing(decoded, "x"));
    store.putTab(DOC, made, []);
    expect(rendered(() => renderTab(made))).toBe(8);
    // A tab the store never held is in one piece.
    expect(rendered(() => renderTab(SEVERAL()))).toBe(1);
    expect(rendered(() => renderTab(applyDocsRequests(decoded, typing(decoded, "y"))))).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Runs cut by content
// ---------------------------------------------------------------------------

describe("DocStore, runs cut by content", () => {
  const line = (at: number) => `Line ${String(at).padStart(5, "0")}.`;
  let large: GoogleDocsTab | undefined;
  /** A tab of 20,000 paragraphs, built once. Never changed. */
  const LARGE = () => large ??= tabOf("large", Array.from({ length: 20_000 }, (_, at) => para(line(at))));

  /** Break, paragraph, item, interrupting paragraph, item numbered over it; the second at `SECOND`. */
  const INTERRUPTED = () => tabOf(
    "t1", [para("Intro"), item("first", "N1"), para("Between"), item("second", "N1")], NUMBERED_LIST);
  const SECOND = 4;
  /** Sets the carry key version `version`'s list names for the run at `seq`. */
  const listCarry = (storage: FakeDocStorage, version: DocVersion, seq: number, carry: string) =>
    storage.sql.exec(
      "UPDATE doc_seq SET carry = ?3 WHERE version = ?1 AND seq = ?2", version.id, seq, carry).toArray();
  /** The digest each stored rendering was made under. */
  const madeBy = (storage: FakeDocStorage) => rowsOf(storage, "doc_md").map(row => row.made);

  /** The record of an append to tab `tabId`, as a replay folds it. */
  const append = (tabId: string): QueuedDocRecord => ({
    id: 1,
    action: { type: "appendText", markdown: "More", tabId, markdownVersion: MARKDOWN_RENDERING_VERSION },
  });
  /** What a replay refuses an append to `version` with, where it does. */
  const refusalOf = (store: DocStore, version: DocVersion) =>
    createSimulationStore(docTabReducer(store)).fold(version.tabId, version, [append(version.tabId)])
      .refused.map(({ refusal }) => refusal);
  const UNINDEXED = [{ reason: unindexedTabRefusal("appendText").message, unindexed: true }];

  it("stores a large tab as runs of about 32 KiB, and reads it back", () => {
    let { storage, store } = opened();
    let tab = LARGE();
    let whole = docTabToMarkdown(tab);

    let version = store.putTab("first", tab, []);
    let cost = spent(() => version = store.putTab(DOC, tab, []));

    let list = listOf(storage, version);
    let lengths = [...cutRuns(tab.body.content, RUN_SIZES)].map(run => run.json.length);
    expect(list).toHaveLength(133);
    expect(lengths).toHaveLength(133);
    // No run of several elements passes 64 KiB, and one run is in hand at a time.
    expect(Math.max(...lengths)).toBeLessThanOrEqual(RUN_SIZES.most);
    expect(lengths.reduce((sum, length) => sum + length, 0) / lengths.length).toBeGreaterThan(24_000);
    expect(cost.peakRunBytesInHand).toBe(2 * Math.max(...lengths));
    expect(cost.peakRunBytesInHand).toBeLessThanOrEqual(2 * 65_536);
    // Each run is rendered once, alone, as the tab is stored.
    expect(cost.runsRendered).toBe(133);
    expect(store.tab(version)).toEqual(tab);
    expect(store.markdown(version)).toBe(whole.markdown);
    expect(store.summary(version)).toEqual(summaryOf(whole));
  });

  // A tab is as many rows as it has runs: only one element is held to a row.
  it("keeps a tab far larger than a row would take as one value", () => {
    let { store } = opened();
    let tab = tabOf("t1", Array.from({ length: 1_200 }, (_, at) => para(`${line(at)} ${"x".repeat(8_000)}`)));
    expect(JSON.stringify(tab.body.content).length).toBeGreaterThan(DOC_ROW_BYTES);

    let version = baseOf(store, store.keep(DOC, copyOf([tab]), NONE));

    expect(store.markdown(version)).toBe(docTabToMarkdown(tab).markdown);
    expect(store.tab(version)).toEqual(tab);
  });

  /** `LARGE()` with the text of each paragraph `changed` names replaced by what it gives. */
  const largeWith = (changed: Record<number, string>) => tabOf(
    "large", Array.from({ length: 20_000 }, (_, at) => para(changed[at] ?? line(at))));
  /** The rows of `list` whose run `beside` does not list: the runs a change replaced. */
  const notIn = (list: ListRow[], beside: ListRow[]) => {
    let known = new Set(beside.map(row => row.run));
    return list.filter(row => !known.has(row.run));
  };
  /** The rows of `list` whose rendering's key `beside` does not list. */
  const keyedApart = (list: ListRow[], beside: ListRow[]) => {
    let known = new Set(beside.map(({ run, context, carry }) => JSON.stringify([run, context, carry])));
    return list.filter(({ run, context, carry }) => !known.has(JSON.stringify([run, context, carry])));
  };
  /** Whether a statement asks storage whether a rendering stands under a key. */
  const looksUpRendering = ([statement]: [string, readonly unknown[]]) =>
    statement.startsWith("SELECT 1 AS found FROM doc_md");
  let builtOnce: ReturnType<typeof largeTabs> | undefined;
  /** A tab of `largeTabs()`, pruned as a fetch prunes it. The tabs are built once. Never changed. */
  const largeTab = (name: string) =>
    pruneTab((builtOnce ??= largeTabs()).find(tab => tab.name === name)!.tab);
  /** The runs `store.putSlice` rendered to store while `run` ran, not the piece's for builders. */
  function renderedToStore(store: DocStore, run: () => unknown): number {
    let rendered = 0;
    let putSlice = store.putSlice.bind(store);
    let spy = vi.spyOn(store, "putSlice").mockImplementation((...given) => {
      let before = docStoreCost.runsRendered;
      try {
        return putSlice(...given);
      } finally {
        rendered += docStoreCost.runsRendered - before;
      }
    });
    try {
      run();
    } finally {
      spy.mockRestore();
    }
    return rendered;
  }
  /** `edit` made in `base` through `docEditResult`, not held: what it cost, and what it stored. */
  function editCost(store: DocStore, base: DocVersion, edit: DocEdit) {
    let made!: DocVersion;
    let cost!: Spent;
    let renders = replayCost.renders;
    let toStore = renderedToStore(store, () => {
      cost = spent(() => made = docEditResult(store, base, edit).after);
    });
    return { made, cost, toStore, renders: replayCost.renders - renders };
  }

  it("a read of a large tab whose renderings are stored decodes no run and renders none", () => {
    let { store } = opened();
    let base = baseOf(store, store.keep(DOC, copyOf([LARGE()]), NONE));
    let renders = replayCost.renders;

    let markdown = "";
    let cost = spent(() => {
      markdown = store.markdown(base);
      store.summary(base);
    });

    expect(cost).toMatchObject({ runsDecoded: 0, runsRendered: 0, runsKeyed: 0, rowsWritten: 0 });
    expect(replayCost.renders - renders).toBe(0);
    expect(markdown).toBe(docTabToMarkdown(LARGE()).markdown);
  });

  // THIS EDIT MOVES NO NUMBERING: the changed runs stored are all that follows the change.
  it("an edit in the middle stores the runs it changed and a list, and renders its piece and those", () => {
    let { storage, store } = opened();
    let base = baseOf(store, store.keep(DOC, copyOf([LARGE()]), NONE));
    let parent = listOf(storage, base);
    let before = counts(storage);
    let edit: DocEdit = { type: "replaceText", oldMarkdown: line(9_000), newMarkdown: "Changed." };

    let { made, cost, toStore, renders } = editCost(store, base, edit);

    let child = listOf(storage, made);
    let changed = notIn(child, parent);
    let [n, m, c] = [parent.length, child.length, changed.length];
    expect([n, m, c]).toEqual([133, 133, 1]);
    expect(c).toBeLessThanOrEqual(3);
    // The child lists its parent's runs under their keys, but for the one the edit changed.
    expect(child[0]).toEqual({ ...parent[0], version: made.id });
    expect(child.filter(row => row !== changed[0]).map(({ run, context, carry }) => [run, context, carry]))
      .toEqual(parent.filter(row => row.seq !== changed[0].seq)
        .map(({ run, context, carry }) => [run, context, carry]));
    expect(counts(storage)).toEqual({
      ...before, doc_run: before.doc_run + c, doc_md: before.doc_md + c, doc_seq: before.doc_seq + m,
      doc_version: before.doc_version + 1, doc_result: 1,
    });
    // Decoded: the piece's run, which the slice takes; rendered: it and the run cut; none keyed.
    expect(cost).toMatchObject({ runsDecoded: 1, runsRendered: 1 + c, runsKeyed: 0, resultsStored: 1 });
    expect(toStore).toBe(c);
    expect(renders).toBe(0);
    expect(store.markdown(made)).toBe(docTabToMarkdown(store.tab(made)).markdown);
  });

  /** A list item made two near the start of a tab of `largeTabs()` that is a numbered list. */
  const ITEM_ADDED: DocEdit = {
    type: "replaceText", oldMarkdown: "Item 00010.", newMarkdown: "Item 00010.\n1. Added.",
  };

  // The carry never settles, but every later run shows `1.` at its level: keyed, never rendered.
  it("an edit that renumbers a list that continues to the end keys every later run and renders none of them", () => {
    let { storage, store } = opened();
    let tab = largeTab("a numbered list of 20,000 items");
    let base = baseOf(store, store.keep(DOC, copyOf([tab]), NONE));
    let parent = listOf(storage, base);
    let before = counts(storage);

    let spentOn!: ReturnType<typeof editCost>;
    let statements = asked(storage, () => spentOn = editCost(store, base, ITEM_ADDED));
    let { made, cost, toStore } = spentOn;

    let child = listOf(storage, made);
    let changed = notIn(child, parent);
    let later = child.length - 1 - changed.at(-1)!.seq;
    let [n, m, c] = [parent.length, child.length, changed.length];
    expect([n, m, c, later]).toEqual([142, 142, 1, 141]);
    expect(c).toBeLessThanOrEqual(3);
    // Decoded: the piece's run; rendered: it and the run cut; keyed with no statement: every later run.
    expect(cost).toMatchObject({ runsDecoded: 1, runsRendered: 1 + c, runsKeyed: later });
    expect(statements.filter(looksUpRendering)).toEqual([]);
    expect(toStore).toBe(c);
    expect(keyedApart(child, parent)).toEqual(changed);
    expect(counts(storage)).toMatchObject({ doc_run: before.doc_run + c, doc_md: before.doc_md + c });
    expect(store.markdown(made)).toBe(docTabToMarkdown(store.tab(made)).markdown);
  });

  // A run that opens a stretch of the list after a paragraph shows the number carried into it.
  it("an edit that moves a number later runs show renders those runs", () => {
    let { storage, store } = opened();
    let tab = largeTab("a numbered list interrupted by a paragraph every 50 items");
    let base = baseOf(store, store.keep(DOC, copyOf([tab]), NONE));
    let parent = listOf(storage, base);
    let before = counts(storage);

    let { made, cost, toStore } = editCost(store, base, ITEM_ADDED);

    let child = listOf(storage, made);
    let changed = notIn(child, parent);
    let later = child.length - 1 - changed.at(-1)!.seq;
    // The later runs whose key is another than the parent's: each shows a number that moved.
    let renumbered = keyedApart(child, parent).length - changed.length;
    let [n, m, c, r] = [parent.length, child.length, changed.length, renumbered];
    expect([n, m, c, later, r]).toEqual([140, 140, 1, 139, 137]);
    expect(c).toBeLessThanOrEqual(3);
    // Rendered: the piece's run, the run cut, and every later run that opens a stretch of the list (r).
    expect(cost).toMatchObject({ runsDecoded: 1 + r, runsRendered: 1 + c + r, runsKeyed: later });
    expect(toStore).toBe(c + r);
    expect(counts(storage)).toMatchObject({ doc_run: before.doc_run + c, doc_md: before.doc_md + c + r });
    expect(store.markdown(made)).toBe(docTabToMarkdown(store.tab(made)).markdown);
  });

  it("a refetch that brings a tab changed in two places renders the runs of both", () => {
    let { storage, store } = opened();
    let parent = listOf(storage, baseOf(store, store.keep(DOC, copyOf([LARGE()]), NONE)));
    let tab = largeWith({ 3_000: "Changed early.", 15_000: "Changed late." });

    let head!: DocCopyHead;
    let cost = spent(() => head = store.keep(DOC, copyOf([tab], { revision: "r2" }), NONE));

    let changed = notIn(listOf(storage, baseOf(store, head)), parent);
    expect(changed).toHaveLength(2);
    expect(changed[1].seq - changed[0].seq).toBeGreaterThan(50);
    // At each place the changed run is rendered and the next keyed; the rest keep their keys.
    expect(cost).toMatchObject({ runsDecoded: 0, runsRendered: 2, runsKeyed: 2 });
    expect(store.markdown(baseOf(store, head))).toBe(docTabToMarkdown(tab).markdown);
  });

  // Each tab is stored beside the earlier base of the tab with its id, wherever it stood before.
  it("a refetch that brings a tab put in first and a later tab changed keys each tab beside its own earlier base", () => {
    let { store } = opened(undefined, undefined, ONE);
    let lines = (tabId: string, third = `${tabId} line 3.`) => tabOf(
      tabId, [1, 2, 3, 4, 5].map(at => para(at === 3 ? third : `${tabId} line ${at}.`)));
    store.keep(DOC, copyOf([lines("t1"), lines("t2")], {}, ONE), NONE);
    let tabs = [tabOf("t0", [para("Zero"), para("Nought"), para("Nil")]), lines("t1"), lines("t2", "Changed.")];
    let put = runIds(tabs[0], ONE).length;

    let head!: DocCopyHead;
    let cost = spent(() => head = store.keep(DOC, copyOf(tabs, { revision: "r2" }, ONE), NONE));

    // Rendered: the new tab's runs and the last tab's changed paragraph; keyed: the one after it.
    expect(put).toBe(4);
    expect(cost).toMatchObject({ runsDecoded: 0, runsRendered: put + 1, runsKeyed: 1 });
    expect(head.outline.map(({ tabId }) => tabId)).toEqual(["t0", "t1", "t2"]);
    for (let [at, tab] of tabs.entries()) {
      let whole = docTabToMarkdown(tab);
      let read = spent(() => {
        expect(store.markdown(baseOf(store, head, at)), tab.tabId).toBe(whole.markdown);
        expect(store.summary(baseOf(store, head, at)), tab.tabId).toEqual(summaryOf(whole));
      });
      expect(read, tab.tabId).toMatchObject({ runsDecoded: 0, runsRendered: 0, rowsWritten: 0 });
    }
  });

  // A run counts footnotes from its start: one added early re-renders only later runs that hold
  // one.
  it("a refetch that brings a footnote added before others writes the runs near it, shares every later run, keys them all and renders only those that hold a footnote", () => {
    /** 20,000 paragraphs, a footnote every 500th; `added` puts one after the tenth, renumbering. */
    let noted = (added: boolean) => {
      let number = 0;
      let reference = (id: string) => ({ footnote: { id, number: String(++number) } });
      let blocks: BlockSpec[] = [];
      for (let at = 0; at < 20_000; at++) {
        blocks.push(at % 500 === 0 ? { runs: [line(at), reference(`note-${at}`), "\n"] } : para(line(at)));
        if (added && at === 9) blocks.push({ runs: ["Added", reference("note-added"), "\n"] });
      }
      return tabOf("large", blocks);
    };
    let { storage, store } = opened();
    let base = baseOf(store, store.keep(DOC, copyOf([noted(false)]), NONE));
    let parent = listOf(storage, base);
    let before = counts(storage);
    let tab = noted(true);

    // The earlier base stays, as a pending record's root would keep it, until the sweep below.
    let head!: DocCopyHead;
    let cost = spent(() => head = store.keep(
      DOC, copyOf([tab], { revision: "r2" }), { edits: [], roots: [base.id] }));

    let fetched = listOf(storage, baseOf(store, head));
    let changed = notIn(fetched, parent);
    let later = fetched.filter(row => row.seq > changed.at(-1)!.seq);
    let holdsFootnote = (row: ListRow) =>
      JSON.parse(renderingOf(storage, row)!.summary).run.numberedFootnotes > 0;
    let [n, m, c, L, F] =
      [parent.length, fetched.length, changed.length, later.length, later.filter(holdsFootnote).length];
    expect([n, m, c, L, F]).toEqual([132, 132, 2, 130, 39]);
    expect(c).toBeLessThanOrEqual(3);
    // A later run's stored JSON does not hold the count before it: each has the id it had.
    expect(later.map(row => row.run)).toEqual(parent.slice(-L).map(row => row.run));
    expect(counts(storage)).toEqual({
      ...before, doc_run: before.doc_run + c, doc_md: before.doc_md + c + F,
      doc_seq: before.doc_seq + m, doc_version: before.doc_version + 1,
    });
    // Rendered: the changed runs (c) and later runs whose key holds the count (F); keyed: all
    // later.
    expect(cost).toMatchObject({ runsDecoded: 0, runsRendered: c + F, runsKeyed: L });

    // Swept with the replaced base: its list (n), record (1), renderings (c + F) and runs (c).
    let swept = spent(() => store.sweep(DOC, NONE));
    expect(swept.rowsWritten).toBe(n + 1 + (c + F) + c);
    expect(counts(storage)).toEqual(before);
    let markdown = store.markdown(baseOf(store, head));
    expect(markdown).toBe(docTabToMarkdown(tab).markdown);
    // Every later footnote reads one more.
    expect(markdown).toContain("Added\\[2\\]");
    expect(markdown).toContain(`${line(500)}\\[3\\]`);
    expect(markdown).toContain(`${line(19_500)}\\[41\\]`);
  });

  const TABLES = 300;
  /** `TABLES` identical small tables among paragraphs; `added` puts one more in the middle. */
  const manyTables = (added = false) => tabOf("t1", [
    para("Between 0."),
    ...Array.from({ length: TABLES }, (_, at) => [
      grid(["a", "b"]), para(`Between ${at + 1}.`),
      ...(added && at === 149 ? [grid(["a", "b"]), para("Added.")] : []),
    ]).flat(),
  ]);

  // A repeated id costs keys, not renders; a tab of many tables writes a list as long every time.
  it("a table like the others put in keys every later run and renders the one run that is new", () => {
    let { storage, store } = opened();
    let base = baseOf(store, store.keep(DOC, copyOf([manyTables()]), NONE));
    let parent = listOf(storage, base);
    let n = parent.length;
    expect(n).toBe(2 * TABLES + 1);
    // The tables are one run and one rendering: a paragraph each, the table, and the context.
    expect(counts(storage)).toMatchObject({ doc_run: TABLES + 1 + 1 + 1, doc_md: TABLES + 1 + 1 });
    let tab = manyTables(true);

    let head!: DocCopyHead;
    let cost!: Spent;
    let statements = asked(storage, () => {
      cost = spent(() => head = store.keep(DOC, copyOf([tab], { revision: "r2" }), NONE));
    });

    let fetched = listOf(storage, baseOf(store, head));
    let added = notIn(fetched, parent);
    let later = fetched.length - 1 - added[0].seq;
    expect([fetched.length, added.length, later]).toEqual([603, 1, 300]);
    // Rendered: the paragraph put in; keyed with no statement: every later run.
    expect(cost).toMatchObject({ runsDecoded: 0, runsRendered: 1, runsKeyed: later });
    expect(statements.filter(looksUpRendering)).toEqual([]);
    expect(store.markdown(baseOf(store, head))).toBe(docTabToMarkdown(tab).markdown);
  });

  it("an edit in a tab of many tables writes a list of a row a run", () => {
    let { storage, store } = opened();
    let base = baseOf(store, store.keep(DOC, copyOf([manyTables()]), NONE));
    let n = listOf(storage, base).length;
    let edit: DocEdit = { type: "replaceText", oldMarkdown: "Between 150.", newMarkdown: "Changed." };

    let { made, cost, toStore } = editCost(store, base, edit);

    expect(n).toBe(601);
    // The piece: tried (1), the run before (2), scouted (3), made (5); then the run cut; none
    // keyed.
    expect(cost).toMatchObject({
      runsDecoded: 1 + 2 + 3 + 5, runsRendered: (1 + 2 + 3 + 5) + 1, runsKeyed: 0,
    });
    expect(toStore).toBe(1);
    expect(store.markdown(made)).toBe(docTabToMarkdown(store.tab(made)).markdown);
  });

  // Through an edit the carries are compared before a later run is read.
  it("an edit that leaves the carry as it was keys no later run", () => {
    let { storage, store } = opened(undefined, undefined, ONE);
    let tab = tabOf("t1", [para("Intro"), item("one", "N1"), item("two", "N1"), para("After")], NUMBERED_LIST);
    let base = baseOf(store, store.keep(DOC, copyOf([tab], {}, ONE), NONE));
    let n = listOf(storage, base).length;

    let { made, cost, toStore } = editCost(
      store, base, { type: "replaceText", oldMarkdown: "one", newMarkdown: "uno" });

    expect(n).toBe(5);
    // The piece is the whole tab here (1 + 2 + 3 + n runs), then the changed item.
    expect(cost).toMatchObject({ runsRendered: (1 + 2 + 3 + n) + 1, runsKeyed: 0 });
    expect(toStore).toBe(1);
    expect(store.markdown(made)).toBe(docTabToMarkdown(store.tab(made)).markdown);
  });

  // After a re-keyed run the walk compares the carries, never assuming them the same.
  it("a refetch keys the run directly after a change even where the carries are the same", () => {
    let { storage, store } = opened(undefined, undefined, ONE);
    let items = (first: string) => tabOf(
      "t1", [para("Intro"), item(first, "N1"), item("two", "N1"), para("After")], NUMBERED_LIST);
    let base = baseOf(store, store.keep(DOC, copyOf([items("one")], {}, ONE), NONE));
    let n = listOf(storage, base).length;

    let cost = spent(() => store.keep(DOC, copyOf([items("uno")], { revision: "r2" }, ONE), NONE));

    expect(n).toBe(5);
    // The changed item is rendered to be stored; the item after it is keyed and settles the walk.
    expect(cost).toMatchObject({ runsDecoded: 0, runsRendered: 1, runsKeyed: 1 });
  });

  /** Paragraph, items `first` and `same`, paragraph: with `first` = `same`, one run at two places. */
  const TWO_ITEMS = (first: string) => tabOf(
    "t1", [para("Intro"), item(first, "N1"), item("same", "N1"), para("After")], NUMBERED_LIST);

  // A run listed at several places is known under each place's key: opening and continuing items.
  it("a run re-keyed onto the key the earlier base lists for it at a later place asks storage nothing", () => {
    let { storage, store } = opened(undefined, undefined, ONE);
    let parent = listOf(storage, baseOf(store, store.keep(DOC, copyOf([TWO_ITEMS("same")], {}, ONE), NONE)));
    let [opens, continues] = [parent[2], parent[3]];
    expect(continues.run).toBe(opens.run);
    expect(continues.carry).not.toBe(opens.carry);
    let tab = TWO_ITEMS("other");

    let head!: DocCopyHead;
    let cost!: Spent;
    let statements = asked(storage, () => {
      cost = spent(() => head = store.keep(DOC, copyOf([tab], { revision: "r2" }, ONE), NONE));
    });

    // Rendered: the changed item; keyed: the next, as the base keys it there, and the last
    // paragraph.
    expect(cost).toMatchObject({ runsDecoded: 0, runsRendered: 1, runsKeyed: 2 });
    expect(statements.filter(looksUpRendering)).toEqual([]);
    let fetched = listOf(storage, baseOf(store, head));
    expect(fetched[3]).toMatchObject({ run: opens.run, context: continues.context, carry: continues.carry });
    let whole = docTabToMarkdown(tab);
    let read = spent(() => expect(store.markdown(baseOf(store, head))).toBe(whole.markdown));
    expect(read).toMatchObject({ runsDecoded: 0, runsRendered: 0, rowsWritten: 0 });
    expect(whole.markdown).toContain("1. other\n1. same\n");
  });

  /** Paragraph, two numbered items, paragraph; with `between`, a paragraph of `text` between. */
  const ITEMS = (between: boolean, text = "Between") => tabOf("t1", [
    para("Intro"), item("one", "N1"), ...(between ? [para(text)] : []), item("two", "N1"),
    para("After"),
  ], NUMBERED_LIST);

  // Neither fetch replaces a run, but the second item's key differs on each side of the change.
  it.each([
    ["removed from between two items of a list", true, 1],
    ["put in between two items of a list", false, 2],
  ] as const)("a refetch that brings a paragraph %s re-keys the item after it", (_what, between, rendered) => {
    let { storage, store } = opened(undefined, undefined, ONE);
    let parent = listOf(storage, baseOf(store, store.keep(DOC, copyOf([ITEMS(between)], {}, ONE), NONE)));
    let tab = ITEMS(!between);

    let head!: DocCopyHead;
    let cost = spent(() => head = store.keep(DOC, copyOf([tab], { revision: "r2" }, ONE), NONE));

    let fetched = listOf(storage, baseOf(store, head));
    expect([parent.length, fetched.length]).toEqual(between ? [6, 5] : [5, 6]);
    // Only a paragraph put in is a run the earlier base does not list.
    expect(notIn(fetched, parent)).toHaveLength(rendered - 1);
    // The second item is the one run both list that is keyed apart.
    let second = fetched.at(-2)!;
    expect(keyedApart(fetched, parent).filter(row => row.run === parent.at(-2)!.run)).toEqual([second]);
    // Rendered: a paragraph put in and the re-keyed second item; keyed: that item alone.
    expect(cost).toMatchObject({ runsDecoded: 0, runsRendered: rendered, runsKeyed: 1 });
    let whole = docTabToMarkdown(tab);
    let read = spent(() => expect(store.markdown(baseOf(store, head))).toBe(whole.markdown));
    expect(read).toMatchObject({ runsDecoded: 0, runsRendered: 0, rowsWritten: 0 });
    expect(whole.markdown).toContain(between ? "1. one\n1. two\n" : "\nBetween\n\n2. two\n");
    expect(store.summary(baseOf(store, head))).toEqual(summaryOf(whole));
  });

  // A pending root stores the second item's rendering under the walk's key: one statement finds it.
  it("a run re-keyed onto a key another version's rendering is stored under asks storage once and is not rendered", () => {
    let { storage, store } = opened(undefined, undefined, ONE);
    let root = store.putTab(DOC, ITEMS(true), []);
    let pending: DocPending = { edits: [], roots: [root.id] };
    let theirs = listOf(storage, root);
    let parent = listOf(storage, baseOf(store, store.keep(DOC, copyOf([ITEMS(false)], {}, ONE), pending)));
    let tab = ITEMS(true, "Other");

    let head!: DocCopyHead;
    let cost!: Spent;
    let statements = asked(storage, () => {
      cost = spent(() => head = store.keep(DOC, copyOf([tab], { revision: "r2" }, ONE), pending));
    });

    // Rendered: the paragraph put in; keyed: the second item, found under another version's row.
    expect(cost).toMatchObject({ runsDecoded: 0, runsRendered: 1, runsKeyed: 1 });
    let second = listOf(storage, baseOf(store, head)).at(-2)!;
    let { run, context, carry } = theirs.at(-2)!;
    expect(second).toMatchObject({ run, context, carry });
    expect(context).not.toBe("");
    expect(carry).not.toBe(parent.at(-2)!.carry);
    expect(statements.filter(looksUpRendering).map(([, bound]) => bound.slice(0, 3)))
      .toEqual([[run, context, carry]]);
    let whole = docTabToMarkdown(tab);
    let read = spent(() => expect(store.markdown(baseOf(store, head))).toBe(whole.markdown));
    expect(read).toMatchObject({ runsDecoded: 0, runsRendered: 0, rowsWritten: 0 });
    expect(whole.markdown).toContain("\nOther\n\n2. two\n");
  });

  // A re-keyed run is moved past like any other: a table rendered after it starts where it stands.
  it("a table put in after a re-keyed run is summarised where it stands", () => {
    let { storage, store } = opened(undefined, undefined, ONE);
    store.keep(DOC, copyOf([tabOf("t1", [para("One"), para("Two"), para("Three")])], {}, ONE), NONE);
    let tab = tabOf("t1", [
      para("Changed"), para("Two"), para("Three"), grid(["a", "b"], ["c", "d"]), para("End"),
    ]);

    let head!: DocCopyHead;
    let cost = spent(() => head = store.keep(DOC, copyOf([tab], { revision: "r2" }, ONE), NONE));

    // Rendered: the changed paragraph, the table and the one after; keyed: the paragraph after.
    expect(cost).toMatchObject({ runsDecoded: 0, runsRendered: 3, runsKeyed: 1 });
    let version = baseOf(store, head);
    let list = listOf(storage, version);
    expect(list).toHaveLength(6);
    let whole = docTabToMarkdown(tab);
    expect(summaryOf(whole).tables.map(table => table.start))
      .toEqual([list.slice(0, 4).reduce((sum, row) => sum + row.size, 0)]);
    expect(storedSummary(store, version)).toEqual(summaryOf(whole));
    expect(store.markdown(version)).toBe(whole.markdown);
  });

  // The steps of the recordings at which a later run's Markdown changes with no number moved:
  // the run after the change starts with a blank line it did not start with, or the reverse.
  it.each([["list-text-edits", 4], ["lists-to-paragraphs", 2]] as const)(
    "a key that changes without a number moving is found: %s, step %i", (name, step) => {
      let { steps, before } = readFixtures().find(fixture => fixture.name === name)!;
      let tabs = [before, ...steps.map(({ after }) => after)].map(tab => pruneTab(throughJson(tab)));
      let { storage, store } = opened(undefined, undefined, ONE);
      let parent = listOf(storage, baseOf(store, store.keep(DOC, copyOf([tabs[step - 1]], {}, ONE), NONE)));

      let head!: DocCopyHead;
      let cost = spent(() => head = store.keep(DOC, copyOf([tabs[step]], { revision: "r2" }, ONE), NONE));

      let fetched = listOf(storage, baseOf(store, head));
      // A run both versions list is rendered again, under another key than the earlier base's.
      let shared = new Set(parent.map(row => row.run));
      expect(keyedApart(fetched, parent).filter(row => shared.has(row.run)).length).toBeGreaterThan(0);
      expect(cost.runsKeyed).toBeGreaterThan(0);
      expect(cost.runsRendered).toBeLessThan(fetched.length);
      expect(store.markdown(baseOf(store, head))).toBe(docTabToMarkdown(tabs[step]).markdown);
    });

  /** Five paragraphs: under runs of one element, the opening break and a run each. */
  const SEVERAL = (fourth = "Four") => tabOf(
    "t1", [para("One"), para("Two"), para("Three"), para(fourth), para("Five")]);
  const FOURTH: DocEdit = { type: "replaceText", oldMarkdown: "Four", newMarkdown: "Vier" };
  /**
   * The runs the piece around `FOURTH` decodes and renders: tried from its run (1) and the run
   * before (2), scouted two back (3), and made from its closure's first run (4).
   */
  const FOURTH_PIECE = 1 + 2 + 3 + 4;
  /** A store under runs of one element that keeps `SEVERAL()`: its base version and its list. */
  function severalKept(made?: string) {
    let { storage, store } = opened(undefined, made, ONE);
    let base = baseOf(store, store.keep(DOC, copyOf([SEVERAL()], {}, ONE), NONE));
    return { storage, store, base, parent: listOf(storage, base) };
  }
  const KEY = "WHERE run = ? AND context = ? AND carry = ?";
  const keyOf = ({ run, context, carry }: ListRow) => [run, context, carry];

  it("an edit of a version that is not keyed under this digest keys it first, rendering every run", () => {
    let { storage, base, parent } = severalKept("a");
    let store = new DocStore(storage, undefined, "b", ONE);

    let { made, cost, toStore } = editCost(store, base, FOURTH);

    let n = parent.length;
    expect(n).toBe(6);
    // Under another digest the scan keys the version first (n runs), then the piece and the run cut.
    expect(cost).toMatchObject({
      runsDecoded: n + FOURTH_PIECE, runsRendered: n + FOURTH_PIECE + 1, runsKeyed: 0,
    });
    expect(toStore).toBe(1);
    expect(store.markdown(made)).toBe(docTabToMarkdown(SEVERAL("Vier")).markdown);
  });

  describe("an edit of a version with a rendering missing before its slice renders that run alone", () => {
    // The run lacking its rendering is before the change: the edit's walk reads it, same key.
    const LACKING = 2;

    it("where the row is gone", () => {
      let { storage, store, base, parent } = severalKept();
      let row = renderingOf(storage, parent[LACKING]);
      storage.sql.exec(`DELETE FROM doc_md ${KEY}`, ...keyOf(parent[LACKING])).toArray();

      let { made, cost, toStore } = editCost(store, base, FOURTH);

      let [n, m] = [parent.length, listOf(storage, made).length];
      expect([n, m]).toEqual([6, 6]);
      // The lacking run, rendered alone by the scan; the piece; and the run cut.
      expect(cost).toMatchObject({
        runsDecoded: 1 + FOURTH_PIECE, runsRendered: 1 + FOURTH_PIECE + 1, runsKeyed: 0,
      });
      expect(toStore).toBe(1);
      let read = spent(() => expect(store.markdown(made)).toBe(docTabToMarkdown(SEVERAL("Vier")).markdown));
      expect(read).toMatchObject({ runsDecoded: 0, runsRendered: 0 });
      // The scan stored the row the parent lacked: that run's Markdown alone.
      read = spent(() => expect(store.markdown(base)).toBe(docTabToMarkdown(SEVERAL()).markdown));
      expect(read).toMatchObject({ runsDecoded: 0, runsRendered: 0 });
      expect(renderingOf(storage, parent[LACKING])).toEqual(row);
      expect(row!.md).toBe("\nTwo\n");
    });

    it("where its summary does not read back", () => {
      let { storage, store, base, parent } = severalKept();
      let row = renderingOf(storage, parent[LACKING]);
      storage.sql.exec(`UPDATE doc_md SET summary = '{}' ${KEY}`, ...keyOf(parent[LACKING])).toArray();

      let { made, cost, toStore } = editCost(store, base, FOURTH);

      let [n, m] = [parent.length, listOf(storage, made).length];
      expect([n, m]).toEqual([6, 6]);
      // As where the row is gone: the scan finds the summary unreadable, renders that run
      // alone and writes its row over.
      expect(cost).toMatchObject({
        runsDecoded: 1 + FOURTH_PIECE, runsRendered: 1 + FOURTH_PIECE + 1, runsKeyed: 0,
      });
      expect(toStore).toBe(1);
      let read = spent(() => expect(store.markdown(made)).toBe(docTabToMarkdown(SEVERAL("Vier")).markdown));
      expect(read).toMatchObject({ runsDecoded: 0, runsRendered: 0 });
      read = spent(() => expect(store.markdown(base)).toBe(docTabToMarkdown(SEVERAL()).markdown));
      expect(read).toMatchObject({ runsDecoded: 0, runsRendered: 0 });
      expect(renderingOf(storage, parent[LACKING])).toEqual(row);
    });
  });

  // A FETCH HEALS A DAMAGED COPY: a keep reads no content of the copy it replaces.
  describe("a keep over a copy whose base lacks a rendering and its run succeeds and reads whole", () => {
    const LOST = 2;
    /** `severalKept()` with the rendering and the run at `LOST` removed, or the base's context. */
    function damaged(what: "run" | "context") {
      let kept = severalKept();
      let { storage, base, parent } = kept;
      if (what === "run") {
        storage.sql.exec(`DELETE FROM doc_md ${KEY}`, ...keyOf(parent[LOST])).toArray();
        storage.sql.exec("DELETE FROM doc_run WHERE id = ?", parent[LOST].run).toArray();
      } else {
        storage.sql.exec(
          "DELETE FROM doc_run WHERE id = (SELECT context FROM doc_version WHERE id = ?)", base.id).toArray();
      }
      return kept;
    }
    const CHANGED = () => SEVERAL("Vier");
    const whole = (tab: GoogleDocsTab) => docTabToMarkdown(tab).markdown;

    it("where the fetch brings the tab changed elsewhere", () => {
      let { store, base, parent } = damaged("run");

      let head!: DocCopyHead;
      let cost = spent(() => head = store.keep(DOC, copyOf([CHANGED()], { revision: "r2" }, ONE), NONE));

      // Runs before the one lacking a summary keep their keys; it and all after are rendered.
      expect(cost).toMatchObject({ runsDecoded: 0, runsRendered: parent.length - LOST, runsKeyed: 0 });
      expect(store.version(DOC, base.id, base)).toBeUndefined();
      let fetched = baseOf(store, head);
      let read = spent(() => expect(store.markdown(fetched)).toBe(whole(CHANGED())));
      expect(read).toMatchObject({ runsDecoded: 0, runsRendered: 0 });
      expect(store.tab(fetched)).toEqual(CHANGED());
      expect(store.head(DOC)).toMatchObject({ id: head.id, revision: "r2" });
    });

    it("where the fetch brings the tab unchanged", () => {
      let { store, base, parent } = damaged("run");

      let head!: DocCopyHead;
      let cost = spent(() => head = store.keep(DOC, copyOf([SEVERAL()], { revision: "r2" }, ONE), NONE));

      // Keyed as cut: the run lacking a rendering and those after it rendered, missing rows
      // written.
      expect(head.versions).toEqual([base.id]);
      expect(cost).toMatchObject({
        runsDecoded: 0, runsRendered: parent.length - LOST, runsKeyed: 0, rowsWritten: 3,
      });
      // The read that follows joins what is stored.
      let read = spent(() => expect(store.markdown(base)).toBe(whole(SEVERAL())));
      expect(read).toMatchObject({ runsDecoded: 0, runsRendered: 0 });
    });

    it("where the base's context is gone", () => {
      let { store } = damaged("context");

      let head = store.keep(DOC, copyOf([CHANGED()], { revision: "r2" }, ONE), NONE);

      let fetched = baseOf(store, head);
      expect(store.markdown(fetched)).toBe(whole(CHANGED()));
      expect(store.tab(fetched)).toEqual(CHANGED());
    });

    it("through a trial", () => {
      let { store } = damaged("run");
      let use = vi.fn((head: DocCopyHead) => store.markdown(baseOf(store, head)));

      let read = store.trial(DOC, copyOf([CHANGED()], { revision: "r2" }, ONE), () => NONE, use);

      expect(use).toHaveBeenCalledTimes(1);
      expect(read).toBe(whole(CHANGED()));
    });
  });

  it("storing a version reads no content of the one beside it", () => {
    let { storage, store } = severalKept();

    let cost!: Spent;
    let statements = asked(storage, () => {
      cost = spent(() => store.keep(DOC, copyOf([SEVERAL("Vier")], { revision: "r2" }, ONE), NONE));
    }).map(([statement]) => statement);

    expect(statements.filter(statement => /SELECT\s+(json|md)\b/.test(statement))).toEqual([]);
    expect(statements.some(statement => statement.includes("LEFT JOIN doc_md"))).toBe(true);
    expect(cost).toMatchObject({ runsDecoded: 0, runsRendered: 1, runsKeyed: 1 });
  });

  it("a version stored beside one that lists no run is stored as without it", () => {
    let { storage, store, base, parent } = severalKept();
    storage.sql.exec("DELETE FROM doc_seq WHERE version = ?", base.id).toArray();

    let head!: DocCopyHead;
    let cost = spent(() => head = store.keep(DOC, copyOf([SEVERAL("Vier")], { revision: "r2" }, ONE), NONE));

    expect(cost).toMatchObject({ runsDecoded: 0, runsRendered: parent.length, runsKeyed: 0 });
    expect(store.markdown(baseOf(store, head))).toBe(docTabToMarkdown(SEVERAL("Vier")).markdown);
  });

  it("a list defined otherwise under the same id renders the runs that name it and no other", () => {
    // Under runs of one element: the opening break, then the items of the list `LA` at 1, 4
    // and 7, before, between and after the items of `LB` (2, 5) and the paragraphs (3, 6).
    let defined = (la: Lists[string]) => tabOf("t1", [
      item("a one", "LA"), item("b one", "LB"), para("Plain one"), item("a two", "LA"),
      item("b two", "LB"), para("Plain two"), item("a three", "LA"),
    ], { LA: la, LB: NUMBERED_LIST.N1 });
    let [numbered, bulleted] = [defined(NUMBERED_LIST.N1), defined(BULLET_LIST.L1)];
    let { storage, store } = opened(undefined, undefined, ONE);
    let base = baseOf(store, store.keep(DOC, copyOf([numbered], {}, ONE), NONE));
    let parent = listOf(storage, base);
    let rows = parent.map(row => renderingOf(storage, row));

    // The earlier base stays, as a pending record's root keeps it.
    let head!: DocCopyHead;
    let cost = spent(() => head = store.keep(
      DOC, copyOf([bulleted], { revision: "r2" }, ONE), { edits: [], roots: [base.id] }));

    let fetched = listOf(storage, baseOf(store, head));
    // The body is the same: every run has the id it had.
    expect(fetched.map(row => row.run)).toEqual(parent.map(row => row.run));
    let redefined = fetched.filter((row, at) => row.context !== parent[at].context).map(row => row.seq);
    expect(redefined).toEqual([1, 4, 7]);
    // Rendered: the three runs naming the redefined list; keyed: the four after the first of them.
    expect(cost).toMatchObject({ runsDecoded: 0, runsRendered: 3, runsKeyed: 4 });
    // A run that names another list, or none, keeps its row, and the earlier base's rows stand.
    for (let at of [0, 2, 3, 5, 6]) expect(keyOf(fetched[at])).toEqual(keyOf(parent[at]));
    expect(parent.map(row => renderingOf(storage, row))).toEqual(rows);
    expect(store.markdown(baseOf(store, head))).toBe(docTabToMarkdown(bulleted).markdown);
    expect(store.markdown(base)).toBe(docTabToMarkdown(numbered).markdown);
  });

  describe("sweep, with lists of many rows", () => {
    const EDIT: DocEdit = { type: "replaceText", oldMarkdown: line(9_000), newMarkdown: "Changed." };
    /** The large tab kept and edited in the middle: the two lists and the runs the edit changed. */
    function editedLarge() {
      let { storage, store } = opened();
      let base = baseOf(store, store.keep(DOC, copyOf([LARGE()]), NONE));
      let made = docEditResult(store, base, EDIT).after;
      let [parent, child] = [listOf(storage, base), listOf(storage, made)];
      return { storage, store, base, n: parent.length, m: child.length, c: notIn(child, parent).length };
    }

    // The store's part of an approval: the copy marked stale, the same sweep, the edit unqueued.
    it("approving it removes the same, and the next keep stores the changed runs again", () => {
      let { storage, store, n, c } = editedLarge();
      let before = counts(storage);

      store.touch(DOC, { stale: true });
      let cost!: Spent;
      let statements = asked(storage, () => cost = spent(() => store.sweep(DOC, NONE)));

      expect(statements).toHaveLength(10);

      // The tab as Google returns it after the write, stored beside the earlier base.
      let tab = largeWith({ 9_000: "Changed." });
      let head!: DocCopyHead;
      statements = asked(storage, () => {
        cost = spent(() => head = store.keep(DOC, copyOf([tab], { revision: "r2" }), NONE));
      });

      // Rendered: the changed runs, stored again (one term). Keyed: the run after them.
      expect(cost).toMatchObject({ runsDecoded: 0, runsRendered: c, runsKeyed: 1 });
      // That keep's sweep: one `DELETE` each for renderings, runs and contexts; then results, list,
      // record.
      expect(statements.map(([statement]) => /^DELETE FROM (\w+)/.exec(statement)?.[1]).filter(Boolean))
        .toEqual(["doc_md", "doc_run", "doc_run", "doc_result", "doc_seq", "doc_version"]);
      expect(counts(storage)).toEqual({ ...before, doc_result: 0, doc_seq: n, doc_version: 1, doc_md: n, doc_run: n + 1 });
      expect(store.markdown(baseOf(store, head))).toBe(docTabToMarkdown(tab).markdown);
    });

    // The two list-comparing statements read the document's own lists once each, no other's.
    it("a sweep reads two rows a run of every list of its document, and none of another's", () => {
      let { storage, store, base } = editedLarge();
      let first = docEditResult(store, base, EDIT).after;
      let second: DocEdit = { type: "replaceText", oldMarkdown: line(15_000), newMarkdown: "Changed too." };
      let dead = docEditResult(store, first, second).after;
      // Another document holds the same tab, and so a list of as many rows.
      let other = store.keep("other", copyOf([LARGE()]), NONE);
      expect(counts(storage)).toMatchObject({ doc_version: 4, doc_seq: 4 * 133 });

      let statements = asked(storage, () => store.sweep(DOC, { edits: [docEditKey(EDIT)], roots: [] }));

      // No statement passes over a table; the list reads name the dead and the two live versions.
      expect(statements.filter(([statement]) => statement.startsWith("SELECT DISTINCT"))).toEqual([]);
      let comparing = statements.filter(([statement]) => /^DELETE FROM doc_(md|run)[^]*FROM doc_seq/.test(statement));
      expect(comparing.map(([statement]) => /^DELETE FROM (\w+)/.exec(statement)![1])).toEqual(["doc_md", "doc_run"]);
      let listed = (ids: unknown) => (JSON.parse(String(ids)) as string[])
        .reduce((rows, id) => rows + rowsOf(storage, "doc_seq").filter(row => row.version === id).length, 0);
      for (let [, [doc, gone, live]] of comparing) {
        expect(doc).toBe(DOC);
        expect(JSON.parse(String(gone))).toEqual([dead.id]);
        expect(JSON.parse(String(live)).toSorted()).toEqual([base.id, first.id].toSorted());
        expect(JSON.parse(String(live))).not.toContain(other.versions[0]);
      }
      // The lists were whole when the two ran: 3 lists of 133 rows, read by each.
      expect(counts(storage)).toMatchObject({ doc_version: 3, doc_seq: 3 * 133 });
      expect(comparing.length * (listed(JSON.stringify([base.id, first.id])) + 133)).toBe(2 * 3 * 133);
    });

    // RUNS SHARED BETWEEN TABS: the two tabs share the break, Alpha and Beta.
    it("a fetch that changes one tab leaves the runs its other tab shares", () => {
      let { storage, store } = opened(undefined, undefined, ONE);
      let tabs = (first: string) => copyOf([
        tabOf("t1", [para(first), para("Beta"), para("Gamma")]),
        tabOf("t2", [para("Alpha"), para("Beta"), para("Zeta")]),
      ], {}, ONE);
      let head = store.keep(DOC, tabs("Alpha"), NONE);
      let alpha = listOf(storage, baseOf(store, head, 0))[1];
      let other = baseOf(store, head, 1);
      let before = counts(storage);

      store.keep(DOC, { ...tabs("Changed"), revision: "r2" }, NONE);

      // The second tab still lists Alpha's run, so the sweep removes no content.
      expect(counts(storage)).toMatchObject({ doc_md: before.doc_md + 1, doc_run: before.doc_run + 1 });
      expect(renderingOf(storage, alpha)).toBeDefined();
      expect(rowsOf(storage, "doc_run").some(row => row.id === alpha.run)).toBe(true);
      let read = spent(() => expect(store.markdown(other)).toBe("Alpha\n\nBeta\n\nZeta\n"));
      expect(read).toMatchObject({ runsDecoded: 0, runsRendered: 0, rowsWritten: 0 });
    });
  });

  it("a tab whose footnotes are not numbered by place is read as it is and takes no edit", () => {
    let { storage, store } = opened();
    // The reference that stands first says 2, and the second 1.
    let tab = tabOf("t1", [
      { runs: ["First", footnote(2), ".\n"] }, { runs: ["Second", footnote(1), ".\n"] },
    ]);
    let placed = tabOf("t1", [
      { runs: ["First", footnote(1), ".\n"] }, { runs: ["Second", footnote(2), ".\n"] },
    ]);
    expect([hasModelIndexes(tab), hasModelFootnotes(tab), hasModelFootnotes(placed)])
      .toEqual([true, false, true]);

    let version = store.putTab(DOC, tab, []);

    expect(store.unindexed(version)).toBe(true);
    expect(store.unindexed(store.putTab(DOC, placed, []))).toBe(false);
    expect(store.tab(version)).toEqual(tab);
    // The numbers are shown as they are.
    let markdown = store.markdown(version);
    expect(markdown).toBe(docTabToMarkdown(tab).markdown);
    expect(markdown).not.toBe(docTabToMarkdown(placed).markdown);
    expect(refusalOf(store, version)).toEqual(UNINDEXED);
    expect(refusalOf(store, store.putTab(DOC, placed, []))).toEqual([]);

    // Under another digest the answer is worked out again from the tab decoded, and is the same.
    let other = new DocStore(storage, undefined, "b");
    expect(spent(() => expect(other.unindexed(version)).toBe(true)).runsDecoded).toBe(1);
    expect(refusalOf(other, version)).toEqual(UNINDEXED);
    expect(other.unindexed(store.putTab(DOC, placed, []))).toBe(false);
  });

  // A tab's runs are not bounded by its size: each table is a run, and so is each stretch between.
  it("a tab of many tables is a run a table and a run between them", () => {
    let { storage, store } = opened();
    let tables = 300;
    let wide = grid(...Array.from({ length: 40 }, (_, row) =>
      Array.from({ length: 10 }, (__, column) => `cell ${row}.${column} ${"x".repeat(40)}`)));
    let tab = tabOf("t1", [
      ...Array.from({ length: tables }, (_, at) => [grid([`a${at}`, `b${at}`]), para(`Between ${at}`)]).flat(),
      wide, para("End"),
    ]);
    let whole = docTabToMarkdown(tab);

    let version = store.putTab(DOC, tab, []);

    // The opening break, each small table and its paragraph, the wide table, the last paragraph.
    let list = listOf(storage, version);
    expect(list).toHaveLength(1 + 2 * tables + 2);
    expect(list.length).toBeGreaterThanOrEqual(2 * tables);
    let runs = [...cutRuns(tab.body.content, RUN_SIZES)];
    expect(runs.filter(run => run.holds === "table")).toHaveLength(tables + 1);
    expect(runs.filter(run => run.holds === "table").every(run => run.elements.length === 1)).toBe(true);
    // A table larger than a run of paragraphs may be is one run all the same.
    expect(runs.at(-2)!.json.length).toBeGreaterThan(RUN_SIZES.most);
    expect(store.tab(version)).toEqual(tab);
    expect(store.markdown(version)).toBe(whole.markdown);
    expect(store.summary(version)).toEqual(summaryOf(whole));
  });

  /** Every statement `run` gave `storage` with its bindings, in order. */
  function asked(storage: FakeDocStorage, run: () => unknown): [string, readonly unknown[]][] {
    let statements: [string, readonly unknown[]][] = [];
    storage.refuse((statement, bindings) => {
      statements.push([statement, [...bindings]]);
      return false;
    });
    run();
    storage.refuse(undefined);
    return statements;
  }
  const writesList = ([statement]: [string, readonly unknown[]]) =>
    statement.startsWith("INSERT OR REPLACE INTO doc_seq");

  // A batch bounds one bound value: a list's entries go as JSON, and a tab can be 10,000s of runs.
  it("a list longer than a batch is written whole and in order", () => {
    let { storage, store } = opened(undefined, "a", ONE);
    let tab = tabOf("t1", Array.from({ length: 1_200 }, (_, at) => para(`Line ${at}.`)));
    let runs = runIds(tab, ONE);
    expect(runs).toHaveLength(1_201);

    let version!: DocVersion;
    let lists = asked(storage, () => version = store.putTab(DOC, tab, [])).filter(writesList);

    // Two batches of 500 runs and one of 201, each from the place the one before ended at.
    expect(lists.map(([, [, entries, from]]) => [(JSON.parse(String(entries)) as unknown[]).length, from]))
      .toEqual([[500, 0], [500, 500], [201, 1_000]]);
    let list = listOf(storage, version);
    expect(list.map(row => row.seq)).toEqual(runs.map((_, at) => at));
    expect(list.map(row => row.run)).toEqual(runs);
    expect(store.markdown(version)).toBe(docTabToMarkdown(tab).markdown);

    // Stored again under another digest, the list is written over in place by the same batches.
    let other = new DocStore(storage, undefined, "b", ONE);
    let again = asked(storage, () => expect(other.putTab(DOC, tab, []).id).toBe(version.id));
    expect(again.filter(writesList).map(([, [, , from]]) => from)).toEqual([0, 500, 1_000]);
    expect(listOf(storage, version)).toEqual(list);
    expect(other.markdown(version)).toBe(docTabToMarkdown(tab).markdown);
  });

  // The key a list held at a place is looked for by the place in the list, not in the batch.
  it("removes another digest's rendering under a key the list held past its first batch", () => {
    let storage = fakeDocStorage();
    let a = new DocStore(storage, undefined, "a", ONE);
    let tab = tabOf("t1", Array.from({ length: 700 }, (_, at) => para(`Line ${at}.`)));
    let version = a.putTab(DOC, tab, []);
    let list = listOf(storage, version);
    // By hand, in the second batch of 500: the list and the rendering alike under another key.
    let at = 600;
    let held = { ...list[at], carry: JSON.stringify({ other: 1 }) };
    listCarry(storage, version, at, held.carry);
    storage.sql.exec(
      "UPDATE doc_md SET carry = ?4 WHERE run = ?1 AND context = ?2 AND carry = ?3",
      held.run, held.context, list[at].carry, held.carry).toArray();
    expect(renderingOf(storage, held)).toBeDefined();

    let b = new DocStore(storage, undefined, "b", ONE);
    expect(b.markdown(version)).toBe(docTabToMarkdown(tab).markdown);

    expect(listOf(storage, version)).toEqual(list);
    expect(renderingOf(storage, held)).toBeUndefined();
    expect(new Set(madeBy(storage))).toEqual(new Set(["b"]));
  });

  it("keeps a tab with an empty body and reads it back empty", () => {
    let { storage, store } = opened();
    let tab: GoogleDocsTab = { ...tabOf("t1", [para("")]), body: { content: [] } };
    let whole = docTabToMarkdown(tab);

    let head = store.keep(DOC, copyOf([tab]), NONE);
    let version = baseOf(store, head);

    // One run of no element, so the version is not one that was swept.
    expect(listOf(storage, version)).toMatchObject([{ run: runId("[]"), size: 0 }]);
    expect(rowsOf(storage, "doc_run").find(row => row.id === runId("[]"))?.json).toBe("[]");
    expect(version.bodyEndIndex).toBe(0);
    let reads = () => {
      expect(store.tab(version)).toEqual(tab);
      expect(store.markdown(version)).toBe("");
      expect(store.summary(version)).toEqual(summaryOf(whole));
    };
    reads();
    expect(store.summary(version).blank).toBe(true);
    // The second reads decode the one run for the tab, render nothing and write nothing.
    expect(spent(reads)).toMatchObject({ runsDecoded: 1, runsRendered: 0, rowsWritten: 0 });
    expect(spent(() => {
      store.markdown(version);
      store.summary(version);
    })).toMatchObject({ runsDecoded: 0, runsRendered: 0, rowsWritten: 0 });
    // Nothing was dropped, so no fetch follows.
    expect(store.head(DOC)).toEqual(head);
    expect(store.has(version)).toBe(true);
  });

  it.each([
    ["a paragraph in the middle", 2], ["the last element", 3],
  ])("keeps a tab whose element holds no end: %s", (_name, at) => {
    let { storage, store } = opened(undefined, undefined, ONE);
    // A tab as Google could send it, with one end index left out.
    let tab = tabOf("t1", [para("One"), para("Two"), para("Three")]);
    delete (tab.body.content[at] as { endIndex?: number }).endIndex;

    let version = baseOf(store, store.keep(DOC, copyOf([tab], {}, ONE), NONE));

    let sizes = storage.sql.exec<{ size: number; type: string }>(
      "SELECT size, typeof(size) AS type FROM doc_seq WHERE version = ? ORDER BY seq", version.id).toArray();
    expect(sizes.map(row => row.type)).toEqual(["integer", "integer", "integer", "integer"]);
    // The element with no end ends where the one before it does.
    expect(sizes[at].size).toBe(0);
    expect(Number.isInteger(version.bodyEndIndex)).toBe(true);
    expect(store.tab(version)).toEqual(tab);
    expect(store.unindexed(version)).toBe(true);
    expect(refusalOf(store, version)).toEqual(UNINDEXED);
  });

  it("works the keys of a kept base version out again before any rendering is looked up", () => {
    let storage = fakeDocStorage();
    let a = new DocStore(storage, undefined, "a", ONE);
    let tab = INTERRUPTED();
    let whole = docTabToMarkdown(tab);
    let version = baseOf(a, a.keep(DOC, copyOf([tab], {}, ONE), NONE));
    let list = listOf(storage, version);
    let fetched = fetchedRows(storage, DOC);
    // The second item shows the number carried over the paragraph between.
    let second = list[SECOND];
    expect(JSON.parse(second.carry)).toEqual({ n: { N1: { 0: 1 } }, s: true });
    // By hand: another carry for the run, with what that carry would have stored under the digest.
    let planted = JSON.stringify({ s: true });
    listCarry(storage, version, SECOND, planted);
    storage.sql.exec(
      "INSERT INTO doc_md (doc, run, context, carry, made, summary, md) VALUES (?, ?, ?, ?, 'b', ?, ?)",
      DOC, second.run, second.context, planted, renderingOf(storage, second)!.summary, "\n1. second\n").toArray();

    let b = new DocStore(storage, undefined, "b", ONE);
    let first = spent(() => expect(b.markdown(version)).toBe(whole.markdown));

    // Each run is decoded and rendered once, and the list holds the true key again.
    expect(first).toMatchObject({ runsDecoded: 5, runsRendered: 5 });
    expect(listOf(storage, version)).toEqual(list);
    expect(whole.markdown).toContain("\n2. second\n");
    expect(renderingOf(storage, second)).toMatchObject({ made: "b", md: "\n2. second\n" });
    expect(fetchedRows(storage, DOC)).toEqual(fetched);
    expect(spent(() => expect(b.markdown(version)).toBe(whole.markdown)))
      .toMatchObject({ runsDecoded: 0, runsRendered: 0, rowsWritten: 0 });
    expect(b.summary(version)).toEqual(summaryOf(whole));
  });

  it("keys a version again whole where a run rendered alone shows another key than its list names", () => {
    let storage = fakeDocStorage();
    let store = new DocStore(storage, undefined, "a", ONE);
    let tab = INTERRUPTED();
    let whole = docTabToMarkdown(tab);
    let version = baseOf(store, store.keep(DOC, copyOf([tab], {}, ONE), NONE));
    let list = listOf(storage, version);
    // By hand: a carry for the second item that the run does not show, with no rendering under it.
    let planted = { ...list[SECOND], carry: JSON.stringify({ s: true }) };
    listCarry(storage, version, SECOND, planted.carry);

    let first = spent(() => expect(store.markdown(version)).toBe(whole.markdown));

    // Its keys are not the list's, so every run is keyed again and the list gets the true key.
    expect(first).toMatchObject({ runsDecoded: 6, runsRendered: 6 });
    expect(listOf(storage, version)).toEqual(list);
    expect(renderingOf(storage, planted)).toBeUndefined();
    expect(counts(storage).doc_md).toBe(5);
    expect(spent(() => expect(store.markdown(version)).toBe(whole.markdown)))
      .toMatchObject({ runsDecoded: 0, runsRendered: 0, rowsWritten: 0 });
    expect(store.summary(version)).toEqual(summaryOf(whole));
  });

  it("serves no rendering another digest wrote over: the run is rendered alone under the store's", () => {
    let storage = fakeDocStorage();
    let a = new DocStore(storage, undefined, "a", ONE);
    let tab = tabOf("t1", [para("Intro"), para("Mine")]);
    let whole = docTabToMarkdown(tab);
    let version = baseOf(a, a.keep(DOC, copyOf([tab], {}, ONE), NONE));
    let made = () => listOf(storage, version).map(row => renderingOf(storage, row)!.made);
    // Digest "b" stores another version sharing two runs, writing over their renderings.
    new DocStore(storage, undefined, "b", ONE)
      .putTab(DOC, tabOf("t1", [para("Intro"), para("Theirs")]), []);
    expect(made()).toEqual(["b", "b", "a"]);

    // Digest "a" again, as after a change is taken back: two of its renderings are not its own.
    let again = new DocStore(storage, undefined, "a", ONE);
    let first = spent(() => expect(again.markdown(version)).toBe(whole.markdown));

    expect(first).toMatchObject({ runsDecoded: 2, runsRendered: 2 });
    expect(made()).toEqual(["a", "a", "a"]);
    expect(again.summary(version)).toEqual(summaryOf(whole));
    expect(spent(() => expect(again.markdown(version)).toBe(whole.markdown)))
      .toMatchObject({ runsDecoded: 0, runsRendered: 0, rowsWritten: 0 });
  });

  it("renders a run re-keyed onto a key under which another digest's rendering stands", () => {
    let storage = fakeDocStorage();
    let tab = INTERRUPTED();
    let whole = docTabToMarkdown(tab);
    // Under digest "a", a pending root puts the second item after the paragraph, under its key
    // there.
    let a = new DocStore(storage, undefined, "a", ONE);
    let root = a.putTab(DOC, tabOf("t1", [
      para("Intro"), item("first", "N1"), para("Between"), item("second", "N1"), para("Last"),
    ], NUMBERED_LIST), []);
    let pending: DocPending = { edits: [], roots: [root.id] };
    let theirs = listOf(storage, root).slice(0, 5);
    // The base's list is not interrupted: its second item is keyed otherwise.
    let b = new DocStore(storage, undefined, "b", ONE);
    b.keep(DOC, copyOf([tabOf("t1", [para("Intro"), item("first", "N1"), item("second", "N1")], NUMBERED_LIST)], {}, ONE), pending);
    expect(theirs.map(row => renderingOf(storage, row)!.made)).toEqual(["b", "b", "b", "a", "a"]);

    // The fetch puts the paragraph in: the second item is re-keyed onto the other version's key.
    let head!: DocCopyHead;
    let cost = spent(() => head = b.keep(DOC, copyOf([tab], { revision: "r2" }, ONE), pending));

    // Rendered: the paragraph, and the second item, whose row is another digest's; keyed: that
    // item.
    expect(cost).toMatchObject({ runsDecoded: 0, runsRendered: 2, runsKeyed: 1 });
    let version = baseOf(b, head);
    let list = listOf(storage, version);
    expect(list.map(keyOf)).toEqual(theirs.map(keyOf));
    expect(list.map(row => renderingOf(storage, row)!.made)).toEqual(["b", "b", "b", "b", "b"]);
    expect(spent(() => expect(b.markdown(version)).toBe(whole.markdown)))
      .toMatchObject({ runsDecoded: 0, runsRendered: 0, rowsWritten: 0 });
    expect(b.summary(version)).toEqual(summaryOf(whole));
  });

  it.each(["read", "keep", "putTab"] as const)(
    "removes another digest's rendering under a key the list held and does not hold, at a %s",
    how => {
      let storage = fakeDocStorage();
      let a = new DocStore(storage, undefined, "a", ONE);
      let tab = INTERRUPTED();
      let whole = docTabToMarkdown(tab);
      let version = baseOf(a, a.keep(DOC, copyOf([tab], {}, ONE), NONE));
      let list = listOf(storage, version);
      // By hand: the list and the rendering alike under a key code with another carry would leave.
      let held = { ...list[SECOND], carry: JSON.stringify({ other: 1 }) };
      listCarry(storage, version, SECOND, held.carry);
      storage.sql.exec(
        "UPDATE doc_md SET carry = ?4 WHERE run = ?1 AND context = ?2 AND carry = ?3",
        held.run, held.context, list[SECOND].carry, held.carry).toArray();
      expect(renderingOf(storage, held)).toBeDefined();

      let b = new DocStore(storage, undefined, "b", ONE);
      let read = how === "read" ? version
        : how === "keep" ? baseOf(b, b.keep(DOC, copyOf([tab], {}, ONE), NONE))
        : b.putTab(DOC, tab, []);
      expect(read.id).toBe(version.id);
      expect(b.markdown(read)).toBe(whole.markdown);

      // Gone as the list is written over; only a keep's sweep would find the old key later.
      expect(listOf(storage, version)).toEqual(list);
      expect(renderingOf(storage, held)).toBeUndefined();
      expect(madeBy(storage)).toEqual(["b", "b", "b", "b", "b"]);
    },
  );

  it("keeps what its digest said of a version's keys and of its indexes, whichever is asked first", () => {
    /** A version kept under one digest, and a store under another. */
    let other = () => {
      let storage = fakeDocStorage();
      let a = new DocStore(storage, undefined, "a", ONE);
      let tab = INTERRUPTED();
      let version = baseOf(a, a.keep(DOC, copyOf([tab], {}, ONE), NONE));
      return { tab, version, store: new DocStore(storage, undefined, "b", ONE) };
    };
    /** The runs `run` decodes and renders. */
    let cost = (run: () => unknown) => {
      let { runsDecoded, runsRendered } = spent(run);
      return [runsDecoded, runsRendered];
    };

    // Keyed, then asked: the tab is decoded once for the answer, and the keys stay.
    let keyedFirst = other();
    expect(cost(() => keyedFirst.store.markdown(keyedFirst.version))).toEqual([5, 5]);
    expect(cost(() => keyedFirst.store.unindexed(keyedFirst.version))).toEqual([5, 0]);
    expect(cost(() => keyedFirst.store.markdown(keyedFirst.version))).toEqual([0, 0]);
    expect(cost(() => keyedFirst.store.unindexed(keyedFirst.version))).toEqual([0, 0]);

    // Asked, then keyed: what was said of the indexes stays.
    let askedFirst = other();
    expect(cost(() => askedFirst.store.unindexed(askedFirst.version))).toEqual([5, 0]);
    expect(cost(() => askedFirst.store.markdown(askedFirst.version))).toEqual([5, 5]);
    expect(cost(() => askedFirst.store.unindexed(askedFirst.version))).toEqual([0, 0]);
    expect(cost(() => askedFirst.store.markdown(askedFirst.version))).toEqual([0, 0]);

    // Keyed, then stored again: the indexes are said of the tab in hand, nothing rendered.
    let storedAgain = other();
    expect(cost(() => storedAgain.store.markdown(storedAgain.version))).toEqual([5, 5]);
    expect(cost(() => storedAgain.store.putTab(DOC, storedAgain.tab, []))).toEqual([0, 0]);
    expect(cost(() => storedAgain.store.unindexed(storedAgain.version))).toEqual([0, 0]);
    expect(cost(() => storedAgain.store.markdown(storedAgain.version))).toEqual([0, 0]);

    // Keyed, then fetched at a later revision: said as elements pass, nothing decoded or rendered.
    let fetchedAgain = other();
    expect(cost(() => fetchedAgain.store.markdown(fetchedAgain.version))).toEqual([5, 5]);
    expect(cost(() => fetchedAgain.store.keep(
      DOC, copyOf([fetchedAgain.tab], { revision: "r2" }, ONE), NONE))).toEqual([0, 0]);
    expect(cost(() => fetchedAgain.store.unindexed(fetchedAgain.version))).toEqual([0, 0]);
    expect(cost(() => fetchedAgain.store.markdown(fetchedAgain.version))).toEqual([0, 0]);
  });

  it("loads the lists a page of runs names by one statement, not the tab's", () => {
    let storage = fakeDocStorage();
    let lists: Lists = Object.fromEntries(Array.from({ length: 500 }, (_, at) =>
      [`L${at}`, { listProperties: { nestingLevels: [{ glyphType: "DECIMAL" }] } }]));
    let tab = tabOf("t1", [
      para("Intro"), item("one", "L3"), item("two", "L7"), para("Between"), item("three", "L3"),
      { table: [[{ paragraphs: [item("in a cell", "L499"), item("and another", "L3")] }]] },
    ], lists);
    let a = new DocStore(storage, undefined, "a", ONE);
    let version = baseOf(a, a.keep(DOC, copyOf([tab], {}, ONE), NONE));
    let context = rowsOf(storage, "doc_version")[0].context;

    let b = new DocStore(storage, undefined, "b", ONE);
    let statements = asked(storage, () => expect(b.markdown(version)).toBe(docTabToMarkdown(tab).markdown));

    // Keying again asks the lists once a page, by that page's places, and the named styles once.
    let named = statements.filter(([statement]) => statement.includes("json_each(doc_run.json, '$.lists')"));
    expect(named.map(([, bindings]) => bindings)).toEqual([[context, version.id, 0, 500, DOC]]);
    // And that statement answers the definitions those runs name, and no other of the 500.
    expect(named.map(([statement, bindings]) =>
      storage.sql.exec<{ id: string }>(statement, ...bindings).toArray().map(row => row.id).toSorted()))
      .toEqual([["L3", "L499", "L7"]]);
    expect(statements.filter(([statement]) => statement.includes("'$.namedStyles'"))).toHaveLength(1);
    // The context's JSON, 500 definitions, is never read whole.
    expect(statements.filter(([statement, [id]]) => statement.startsWith("SELECT json FROM doc_run") && id === context))
      .toEqual([]);
    expect(storage.arrays().filter(statement => /^SELECT json\b/.test(statement))).toEqual([]);
  });
});

// A run, a context and a rendering are rows of ONE document: a sweep and a drop read and write
// that document's rows alone, and compare its versions' lists inside storage.
describe("DocStore, a document's own rows", () => {
  /** A document of one tab under runs of one element: the opening break and a run a block. */
  const blocksOf = (blocks: BlockSpec[], lists?: Lists) => tabOf("t1", blocks, lists);
  /** Every statement `run` gave storage, with what it bound. */
  function given(storage: FakeDocStorage, run: () => unknown): [string, readonly unknown[]][] {
    let statements: [string, readonly unknown[]][] = [];
    storage.refuse((statement, bindings) => {
      statements.push([statement, [...bindings]]);
      return false;
    });
    try {
      run();
    } finally {
      storage.refuse(undefined);
    }
    return statements;
  }
  const deleted = (statements: [string, readonly unknown[]][]) =>
    statements.map(([statement]) => /^DELETE FROM (\w+)/.exec(statement)?.[1]).filter(Boolean);

  describe("sweep", () => {
    it.each(SWEEP_COST_PAIRS)(
      "costs the same beside two hundred other documents as with none: %d pairs", pairs => {
        let beside = sweepCostScenario(fakeDocStorage(), { others: 200, pairs });
        let alone = sweepCostScenario(fakeDocStorage(), { others: 0, pairs });

        // The same statements, rows answered and rows changed; real billing is pinned in workerd.
        expect(beside).toEqual(alone);
        expect(alone.runs).toBe(2 * pairs + 1);
        for (let removal of Object.keys(SWEEP_COST) as SweepCase[]) {
          expect(alone[removal], removal).toMatchObject(SWEEP_COST[removal]);
        }
      });

    it("names no row of another document", () => {
      let [beside, alone] = [3, 0].map(others => sweepCostScenario(fakeDocStorage(), { others, pairs: 20 }));
      expect(beside).toEqual(alone);

      // Two documents that hold the same tabs and take the same edit.
      let { storage, store } = opened();
      let one = baseOf(store, store.keep("one", copyOf([PROSE(), NOTES()]), NONE), 0, "one");
      let two = baseOf(store, store.keep("two", copyOf([PROSE(), NOTES()]), NONE), 0, "two");
      edited(store, one, "e1");
      edited(store, two, "e1");
      let versions = (doc: string) => rowsOf(storage, "doc_version").filter(row => row.doc === doc).map(row => String(row.id));
      let [mine, theirs] = [versions("one"), versions("two")];
      expect([mine.length, theirs.length]).toEqual([3, 3]);
      expect(mine.filter(id => theirs.includes(id))).toEqual([]);

      let statements = given(storage, () => {
        store.sweep("one", NONE);
        store.drop("one");
      });

      // Every statement is bound to this document or its versions, so none passes over a table.
      let named = statements.flatMap(([, bindings]) => bindings.flatMap(bound =>
        typeof bound === "string" && bound.startsWith("[") ? JSON.parse(bound) as unknown[] : [bound]));
      expect(statements.length).toBeGreaterThan(12);
      expect(statements.filter(([, bindings]) => bindings.length === 0)).toEqual([]);
      expect(named).toContain("one");
      expect(named.filter(bound => bound === "two" || theirs.includes(String(bound)))).toEqual([]);
      // A name that is not a version of the document is the digest of the store's code.
      expect(new Set(named.filter(bound => typeof bound === "string" && /^[0-9a-f]{64}$/.test(bound) && !mine.includes(bound))))
        .toEqual(new Set([store.head("two")!.made]));
    });

    // The second item is one run in both versions, keyed after the first item and after a
    // paragraph.
    it("removes a run only a dead version listed and keeps one a live version lists under another key, with its other rendering", () => {
      let { storage, store } = opened(undefined, undefined, ONE);
      let items = (between: boolean) => blocksOf([
        para("Intro"), item("one", "N1"), ...(between ? [para("Between")] : []), item("two", "N1"),
        para("After"),
      ], NUMBERED_LIST);
      let live = listOf(storage, baseOf(store, store.keep(DOC, copyOf([items(false)], {}, ONE), NONE)));
      let before = storage.rows();
      let dead = listOf(storage, store.putTab(DOC, items(true), []));
      let [two, theirs, between] = [live.at(-2)!, dead.at(-2)!, dead.at(-3)!];
      expect(theirs.run).toBe(two.run);
      expect(theirs.carry).not.toBe(two.carry);
      expect(live.some(row => row.run === between.run)).toBe(false);
      expect([renderingOf(storage, theirs), renderingOf(storage, between)].every(Boolean)).toBe(true);

      store.sweep(DOC, NONE);

      let runs = rowsOf(storage, "doc_run").map(row => row.id);
      expect(runs).toContain(two.run);
      expect(runs).not.toContain(between.run);
      expect(renderingOf(storage, two)).toBeDefined();
      expect(renderingOf(storage, theirs)).toBeUndefined();
      expect(storage.rows()).toEqual(before);
    });

    it("removes a run a dead version lists twice, once", () => {
      let { storage, store } = opened(undefined, undefined, ONE);
      store.keep(DOC, copyOf([blocksOf([para("Alpha")])], {}, ONE), NONE);
      let before = storage.rows();
      let dead = listOf(storage, store.putTab(DOC, blocksOf([para("Same"), para("Same")]), []));
      // The opening break is the base's run; the two paragraphs are one run, listed twice.
      expect(dead.map(row => row.run)).toEqual([dead[0].run, dead[1].run, dead[1].run]);
      expect(rowsOf(storage, "doc_run").filter(row => row.id === dead[1].run)).toHaveLength(1);
      let renderings = rowsOf(storage, "doc_md").filter(row => row.run === dead[1].run).length;
      expect(renderings).toBe(dead[1].carry === dead[2].carry ? 1 : 2);

      // Its list (3), its record, the run, once, and the run's renderings.
      expect(spent(() => store.sweep(DOC, NONE)).rowsWritten).toBe(3 + 1 + 1 + renderings);

      expect(storage.rows()).toEqual(before);
    });

    it("removes a context no version of the document names and leaves the same context of another document", () => {
      let { storage, store } = opened();
      let blocks = [para("One"), item("first", "N1")];
      let bulleted = blocksOf(blocks, { N1: BULLET_LIST.L1 });
      store.keep(DOC, copyOf([blocksOf(blocks, NUMBERED_LIST)]), NONE);
      store.keep("other", copyOf([bulleted]), NONE);
      let before = storage.rows();
      let dead = store.putTab(DOC, bulleted, []);
      let context = rowsOf(storage, "doc_version").find(row => row.id === dead.id)!.context;
      let holders = () => rowsOf(storage, "doc_run").filter(row => row.id === context).map(row => row.doc);
      expect(holders()).toEqual([DOC, "other"]);

      store.sweep(DOC, NONE);

      expect(holders()).toEqual(["other"]);
      expect(storage.rows()).toEqual(before);
    });

    it("drops a document by its key: no row of it is left in any table, and every row of another document is as it was", () => {
      // The second document's life, in a storage that held and dropped the first, and in a fresh
      // one.
      let lived = (first: boolean) => {
        let { storage, store } = opened();
        if (first) {
          let one = baseOf(store, store.keep("one", copyOf([PROSE(), NOTES()]), NONE, { folder: "f1", at: 1 }), 0, "one");
          store.markdown(edited(store, one, "e1"));
          store.putResult(one, "refused", { refusal: { reason: "No." } });
        }
        let two = baseOf(store, store.keep("two", copyOf([PROSE(), NOTES()]), NONE), 0, "two");
        store.markdown(edited(store, two, "e1"));
        if (first) {
          expect(counts(storage)).toEqual({ doc_copy: 2, doc_md: 10, doc_result: 3, doc_run: 12, doc_seq: 10, doc_version: 6 });
          expect(deleted(given(storage, () => store.drop("one"))))
            .toEqual(["doc_result", "doc_seq", "doc_version", "doc_md", "doc_run", "doc_copy"]);
        }
        return storage;
      };

      expect(storedRows(lived(true))).toBe(storedRows(lived(false)));
    });

    it("removes everything of a document none of whose versions is live, with no list read", () => {
      let { storage, store } = opened();
      store.keep("other", copyOf([NOTES()]), NONE);
      let before = storage.rows();
      let inside: Record<string, number> = {};
      let swept: [string, readonly unknown[]][] = [];
      // A first read's trial: no copy is stored and no root is pending, so nothing is live.
      storage.refuse((statement, bindings) => {
        if (inside.doc_seq) swept.push([statement, [...bindings]]);
        return false;
      });
      store.trial(DOC, copyOf([PROSE(), NOTES()]), () => NONE, () => {
        inside = counts(storage);
      });
      storage.refuse(undefined);

      expect(inside).toMatchObject({ doc_seq: 3 + 4, doc_version: 1 + 2, doc_run: 4 + 5, doc_md: 3 + 4 });
      // The one statement that names the lists is the one that removes them.
      expect(swept.map(([statement]) => statement).filter(statement => /doc_seq/.test(statement)))
        .toEqual(["DELETE FROM doc_seq WHERE version IN (SELECT id FROM doc_version WHERE doc = ?)"]);
      expect(deleted(swept)).toEqual(["doc_result", "doc_seq", "doc_version", "doc_md", "doc_run"]);
      expect(storage.rows()).toEqual(before);
    });
  });

  describe("a copy's bytes", () => {
    /** What `head` should count: the UTF-8 bytes of each listed run, at each place, and contexts. */
    function bytesStored(storage: FakeDocStorage, doc: string, head: DocCopyHead): number {
      let json = new Map(rowsOf(storage, "doc_run").filter(row => row.doc === doc)
        .map(row => [String(row.id), Buffer.byteLength(String(row.json), "utf8")]));
      let contexts = new Map(rowsOf(storage, "doc_version").filter(row => row.doc === doc)
        .map(row => [String(row.id), String(row.context)]));
      let lists = rowsOf(storage, "doc_seq");
      return head.versions.reduce((sum, id) => sum + json.get(contexts.get(id)!)! +
        lists.filter(row => row.version === id).reduce((runs, row) => runs + json.get(String(row.run))!, 0), 0);
    }

    it.each([
      { shape: "prose", tabs: () => [proseTab("t1", 400)] },
      // 601 runs, of which every stretch between two tables is the same run: counted at each place.
      { shape: "many runs", tabs: () => [tinyTablesTab("t1", 300)] },
      { shape: "text outside Latin-1", tabs: () => [tabOf("t1", [para("café 文書 \u{1F600}"), para("שלום")])] },
      { shape: "two tabs", tabs: () => [PROSE(), NOTES()] },
    ])("counts a copy's bytes as it is stored: $shape", ({ tabs }) => {
      let { storage, store } = opened();

      let head = store.keep(DOC, copyOf(tabs()), NONE);

      expect(head.bytes).toBeGreaterThan(0);
      expect(head.bytes).toBe(bytesStored(storage, DOC, head));
      expect(store.head(DOC)!.bytes).toBe(head.bytes);
      let { bytes } = storage.sql.exec<{ bytes: number }>("SELECT bytes FROM doc_copy WHERE doc = ?", DOC).one();
      expect(bytes).toBe(head.bytes);
      // Counted at each place a run is listed: the document as fetched, not the rows that hold it.
      let rows = rowsOf(storage, "doc_run").reduce((sum, row) => sum + Buffer.byteLength(String(row.json), "utf8"), 0);
      expect(head.bytes).toBeGreaterThanOrEqual(rows);
    });

    it("counts the same for a tab fetched unchanged, of which nothing is written", () => {
      let { storage, store } = opened();
      let first = store.keep(DOC, copyOf([tinyTablesTab("t1", 50), NOTES()]), NONE);
      let again!: DocCopyHead;

      // The copy's record is the one row written.
      expect(spent(() => again = store.keep(DOC, copyOf([tinyTablesTab("t1", 50), NOTES()], { fetchedAt: 2_000 }), NONE)).rowsWritten)
        .toBe(1);

      expect(again.bytes).toBe(first.bytes);
      expect(store.head(DOC)!.bytes).toBe(bytesStored(storage, DOC, again));
    });

    it("counts a held document as the fetched one", () => {
      let { storage, store } = opened();
      let tabs = () => [tinyTablesTab("t1", 50), tabOf("t2", [para("café 文書 \u{1F600}")])];
      let fetched = store.keep("fetched", copyOf(tabs()), NONE);

      let held = store.keep(DOC, heldDoc(DOC, copyOf(tabs())), NONE);

      expect(held.bytes).toBe(fetched.bytes);
      expect(held.bytes).toBe(bytesStored(storage, DOC, held));
    });

    it("a trial's record carries the bytes and stores none", () => {
      let { storage, store } = opened();
      let kept = store.keep("kept", copyOf([PROSE(), NOTES()]), NONE);
      let before = storage.rows();

      let tried = store.trial(DOC, copyOf([PROSE(), NOTES()]), () => NONE, head => head.bytes);

      expect(tried).toBe(kept.bytes);
      expect(store.head(DOC)).toBeUndefined();
      expect(storage.rows()).toEqual(before);
    });
  });

  describe("the copies' records", () => {
    it("lists the copies' small records by one statement that reads a row a copy", () => {
      let storage = fakeDocStorage();
      let kept = new DocStore(storage);
      let guarded = kept.keep("guarded", copyOf([PROSE(), NOTES()]), NONE, { folder: "f1", at: 5 * DOC_COPY_APPROVAL_GRAIN_MS + 9 });
      let bound = kept.keep("bound", copyOf([NOTES()]), NONE);
      edited(kept, baseOf(kept, guarded, 0, "guarded"), "e1");
      let counted = countedStorage(storage);
      let store = new DocStore(counted.storage);
      let before = { statements: counted.counts().all, answered: counted.answered() };

      let copies = store.copies();

      // A record a copy: its key, its last approved read's hour where scoped, its fetch and bytes.
      expect(copies.toSorted((a, b) => a.doc < b.doc ? -1 : 1)).toEqual([
        { doc: "bound", fetchedAt: bound.fetchedAt, bytes: bound.bytes },
        {
          doc: "guarded", approvedAt: 5 * DOC_COPY_APPROVAL_GRAIN_MS, fetchedAt: guarded.fetchedAt,
          bytes: guarded.bytes,
        },
      ]);
      // One statement, which answers a row a copy and nothing else.
      expect(counted.counts().all - before.statements).toBe(1);
      expect(counted.answered() - before.answered).toBe(copies.length);
      let [statement] = counted.ran().filter(ran => ran.includes("FROM doc_copy") && !ran.includes("WHERE"));
      expect(statement).toBe("SELECT doc, approved, fetched_at, bytes FROM doc_copy");
      // It scans the copies' records, its purpose, and names no large column and no other table.
      expect(tableScans(storage, [statement])).toEqual({ [statement]: ["SCAN doc_copy"] });
      for (let large of ["outline", "markers", "versions"]) expect(statement).not.toContain(large);
      expect(statement.match(/\bdoc_\w+/g)).toEqual(["doc_copy"]);
    });

    it.each(CAP_COST_PAIRS)(
      "a keep at the cap adds one statement that answers a row a copy, and six for each copy " +
      "it evicts: %d pairs", pairs => {
        let cost = capCostScenario(fakeDocStorage(), { pairs });

        expect([cost.runs, cost.proseRuns]).toEqual([2 * pairs + 1, 300]);
        expect(cost.copies).toEqual([200, 200, 200, 151]);
        for (let kept of Object.keys(CAP_COST) as CapCase[]) {
          expect(cost[kept], kept).toMatchObject(CAP_COST[kept]);
        }
        // An eviction writes only what it removes: the keep's rows and the evicted copies' rows.
        expect(cost.nothing.rowsWritten).toBe(cost.plain.rowsWritten);
        expect(cost.fifty.rowsWritten - cost.plain.rowsWritten).toBe(50 * cost.plain.rowsWritten);
        expect(cost.manyRuns.rowsWritten).toBeGreaterThan(cost.runs);
      });

    it("lists no copy of a store that holds none, and none of a document dropped", () => {
      let { store } = opened();
      expect(store.copies()).toEqual([]);

      store.keep(DOC, copyOf([PROSE()]), NONE);
      store.trial("tried", copyOf([NOTES()]), () => NONE, () => {
        // A trial's document is no copy.
        expect(store.copies().map(({ doc }) => doc)).toEqual([DOC]);
      });
      store.drop(DOC);

      expect(store.copies()).toEqual([]);
    });
  });
});

describe("the fake storage", () => {
  function numbered(): FakeDocStorage {
    let storage = fakeDocStorage();
    storage.sql.exec("CREATE TABLE doc_n (id INTEGER PRIMARY KEY, text TEXT NOT NULL) STRICT");
    for (let id of [1, 2, 3]) storage.sql.exec("INSERT INTO doc_n (id, text) VALUES (?, ?)", id, `row ${id}`);
    return storage;
  }
  const ids = (storage: FakeDocStorage) => (storage.rows().doc_n as Row[]).map(row => row.id);

  it("steps a cursor one row ahead", () => {
    let storage = numbered();
    let cursor = storage.sql.exec<{ id: number }>("SELECT id FROM doc_n ORDER BY id");
    expect(storage.openCursors()).toBe(1);

    // The first row was read when the cursor was made: a change to it is not seen.
    storage.sql.exec("UPDATE doc_n SET text = 'changed' WHERE id = 1");
    storage.sql.exec("DELETE FROM doc_n WHERE id = 3");
    expect(cursor.next()).toEqual({ done: false, value: { id: 1 } });
    // The rows after it are read as the cursor is stepped: the row removed is never answered.
    expect(cursor.toArray()).toEqual([{ id: 2 }]);
    expect(storage.openCursors()).toBe(0);
    expect(cursor.next()).toEqual({ done: true });

    expect(storage.sql.exec("INSERT INTO doc_n (id, text) VALUES (7, 'seven')").rowsWritten).toBe(1);
    expect(storage.sql.exec("SELECT id FROM doc_n").rowsWritten).toBe(0);
    expect(() => storage.sql.exec("SELECT id FROM doc_n").one()).toThrow("Expected exactly one result");
    expect(storage.sql.exec("SELECT id FROM doc_n WHERE id = 7").one()).toEqual({ id: 7 });
    expect(storage.arrays()).toEqual(["SELECT id FROM doc_n ORDER BY id"]);
  });

  it("steps two cursors of the same query apart", () => {
    let storage = numbered();
    const query = "SELECT id FROM doc_n WHERE id >= ? ORDER BY id";
    let first = storage.sql.exec<{ id: number }>(query, 1);
    let second = storage.sql.exec<{ id: number }>(query, 2);
    expect(first.next()).toEqual({ done: false, value: { id: 1 } });
    expect(second.toArray()).toEqual([{ id: 2 }, { id: 3 }]);
    expect(first.toArray()).toEqual([{ id: 2 }, { id: 3 }]);
    // Both drained, the query runs again from its first row.
    expect(storage.sql.exec<{ id: number }>(query, 3).toArray()).toEqual([{ id: 3 }]);
    expect(storage.openCursors()).toBe(0);
  });

  it("runs a query again after it failed", () => {
    let storage = numbered();
    const read = "SELECT json_extract(?, '$.id') AS id";
    expect(() => storage.transactionSync(() => storage.sql.exec(read, "{").toArray())).toThrow("malformed JSON");
    expect(storage.sql.exec(read, '{"id": 4}').toArray()).toEqual([{ id: 4 }]);
    const write = "INSERT INTO doc_n (id, text) VALUES (?, 'again')";
    expect(() => storage.sql.exec(write, 1)).toThrow("UNIQUE constraint failed");
    expect(storage.sql.exec(write, 4).rowsWritten).toBe(1);
  });

  it("nests transactions and restores the KV with the rows", () => {
    let storage = numbered();
    storage.kv.put("kept", "before");

    storage.transactionSync(() => {
      storage.sql.exec("DELETE FROM doc_n WHERE id = 1");
      storage.kv.put("outer", 1);
      expect(() => storage.transactionSync(() => {
        storage.sql.exec("DELETE FROM doc_n WHERE id = 2");
        storage.kv.put("kept", "inner");
        storage.kv.delete("outer");
        throw new Error("The inner transaction failed.");
      })).toThrow("The inner transaction failed.");
      // The inner transaction's writes are undone, the outer's stand.
      expect(ids(storage)).toEqual([2, 3]);
      expect(storage.kv.get("kept")).toBe("before");
      expect(storage.kv.get("outer")).toBe(1);
    });

    expect(ids(storage)).toEqual([2, 3]);
    expect(storage.kv.keys()).toEqual(["kept", "outer"]);
    expect(() => storage.transactionSync(() => {
      storage.sql.exec("DELETE FROM doc_n");
      storage.kv.delete("kept");
      throw new Error("The outer transaction failed.");
    })).toThrow("The outer transaction failed.");
    expect(ids(storage)).toEqual([2, 3]);
    expect(storage.kv.keys()).toEqual(["kept", "outer"]);
  });

  it("makes a cursor open at a rollback throw", () => {
    let storage = numbered();
    let cursor = storage.sql.exec<{ id: number }>("SELECT id FROM doc_n ORDER BY id");
    expect(cursor.next()).toEqual({ done: false, value: { id: 1 } });

    expect(() => storage.transactionSync(() => {
      throw new Error("The transaction failed.");
    })).toThrow("The transaction failed.");

    expect(() => cursor.next()).toThrow("The cursor was closed by a rollback.");
    expect(() => cursor.toArray()).toThrow("The cursor was closed by a rollback.");
    expect(storage.openCursors()).toBe(0);
    // A cursor a committed transaction leaves open goes on.
    let kept = storage.sql.exec<{ id: number }>("SELECT id FROM doc_n ORDER BY id");
    storage.transactionSync(() => storage.sql.exec("UPDATE doc_n SET text = 'x' WHERE id = 3"));
    expect(kept.toArray().map(row => row.id)).toEqual([1, 2, 3]);
  });

  it("refuses the statements it is told to, before they run, and explains a statement's plan", () => {
    let storage = numbered();
    storage.refuse((statement, bindings) => statement.startsWith("DELETE") && bindings[0] === 2);

    expect(() => storage.sql.exec("DELETE FROM doc_n WHERE id = ?", 2)).toThrow("storage refused the write");
    storage.sql.exec("DELETE FROM doc_n WHERE id = ?", 1);
    storage.refuse(undefined);
    storage.sql.exec("DELETE FROM doc_n WHERE id = ?", 2);

    expect(ids(storage)).toEqual([3]);
    expect(storage.plan("SELECT text FROM doc_n WHERE id = ?")).toEqual([
      expect.stringMatching(/^SEARCH doc_n USING INTEGER PRIMARY KEY/),
    ]);
    expect(storage.plan("SELECT id FROM doc_n WHERE text = ?")).toEqual(["SCAN doc_n"]);
  });
});

describe("the joiner of rendered runs", () => {
  it("the joiner the source uses is the tests'", () => {
    expect(appendRun).toBe(joinRenderedRun);
  });
});

describe("DocStore.piece, the lists its runs name", () => {
  const ONE_ELEMENT: RunSizes = { ...RUNS_OF_THREE, elements: 1 };
  /** A tab of a section break and `count` items of one bulleted list, as Google sends one. */
  const itemsTab = (count: number) =>
    tabOf("t1", Array.from({ length: count }, (_, at) => item(`Item ${at}`, "B1")), BULLET_LIST);
  /** `tab` kept by a store of the digest `made` over `storage`, cut to `sizes`: its base version. */
  function keptIn(storage: FakeDocStorage, tab: GoogleDocsTab, sizes?: RunSizes, made?: string) {
    let store = new DocStore(storage, undefined, made, sizes);
    return baseOf(store, store.keep(DOC, copyOf([tab], {}, sizes), NONE));
  }
  /** What the piece at the end of `version` costs a default store over `storage`, and the piece. */
  function pieceIn(storage: FakeDocStorage, version: DocVersion, sizes?: RunSizes) {
    let counted = countedStorage(storage);
    let store = new DocStore(counted.storage, undefined, undefined, sizes);
    let piece!: DocTabSnapshot;
    let cost = statementsSpent(counted, () => piece = pieceAtEnd(store, version));
    return { piece, cost };
  }
  /** Holds a piece at a tab's end to the end of the tab rendered whole. */
  function expectEndOf(piece: DocTabSnapshot, tab: GoogleDocsTab): void {
    let whole = docTabToMarkdown(tab).markdown;
    expect(piece.markdown).not.toBe("");
    expect(whole.endsWith(piece.markdown)).toBe(true);
    expect(piece.part?.last).toBe(true);
  }

  it("a piece loads its lists a page at a time, never a statement a run", () => {
    // Runs naming a dozen of 18 lists, one page: each pass reads styles once, the page's lists
    // once.
    let dozens = listRunsTab("t1", 60);
    let storage = fakeDocStorage();
    let base = keptIn(storage, dozens);
    let { piece, cost } = pieceIn(storage, base);
    // The last run holds the closure of the tab's end: one pass.
    expect(cost).toMatchObject({ styles: 1, lists: 1, runsRendered: 1, rowsWritten: 0 });
    expectEndOf(piece, dozens);

    // Three pages: four passes, each one statement over the styles and one over the page's lists.
    let items = itemsTab(1_300);
    storage = fakeDocStorage();
    base = keptIn(storage, items, ONE_ELEMENT);
    expect(listOf(storage, base)).toHaveLength(1_301);
    let listed = pieceIn(storage, base, ONE_ELEMENT);
    expect(listed.cost).toMatchObject({
      styles: 4, lists: 4, runsDecoded: 1 + 2 + 3 + 3, runsRendered: 1 + 2 + 3 + 3, rowsWritten: 0,
    });
    expectEndOf(listed.piece, items);

    // Runs that name no list: the same statements, which answer no row.
    let plain = tabOf("t1", Array.from({ length: 1_300 }, (_, at) => para(`Line ${at}.`)));
    storage = fakeDocStorage();
    base = keptIn(storage, plain, ONE_ELEMENT);
    let counted = countedStorage(storage);
    let plainPiece = statementsSpent(
      counted, () => pieceAtEnd(new DocStore(counted.storage, undefined, undefined, ONE_ELEMENT), base));
    expect(plainPiece).toMatchObject({ styles: 4, lists: 4 });
    expect(counted.definitions()).toBe(0);

    // A run that names a list the tab does not define renders as the whole tab does.
    let undefinedList = tabOf("t1", [para("Before"), item("Stray", "B1"), para("After")], BULLET_LIST);
    undefinedList.lists = {};
    storage = fakeDocStorage();
    base = keptIn(storage, undefinedList, ONE_ELEMENT);
    let { piece: stray } = pieceIn(storage, base, ONE_ELEMENT);
    expect(stray.markdown).toBe(docTabToMarkdown(undefinedList).markdown);
  });
});

describe("DocStore.lists", () => {
  it("answers the definitions of the lists asked for alone, with no run read", () => {
    let storage = fakeDocStorage();
    let store = new DocStore(storage);
    let tab = tabOf("t1", [item("One", "N1"), item("Dot", "L1"), para("Plain")], { ...NUMBERED_LIST, ...BULLET_LIST });
    let base = baseOf(store, store.keep(DOC, copyOf([tab]), NONE));
    let counted = countedStorage(storage);
    let reader = new DocStore(counted.storage);
    let decoded = docStoreCost.runsDecoded, opening = counted.counts().all;

    expect(reader.lists(base, ["N1", "nope"])).toEqual({ N1: tab.lists.N1 });
    expect(reader.lists(base, ["L1", "N1"])).toEqual(tab.lists);
    // A call reads the version's row and its context's twice: no page of the list and no run.
    expect(counted.counts()).toEqual({ all: opening + 6, styles: 2, lists: 2, pages: 0, joined: 0, content: 0 });
    expect(docStoreCost.runsDecoded).toBe(decoded);
    // No id asks nothing.
    expect(reader.lists(base, [])).toEqual({});
    expect(counted.counts().all).toBe(opening + 6);
  });

  it("answers a list an edit makes from the edit's version, and not from the one before it", () => {
    let store = new DocStore(fakeDocStorage());
    let base = baseOf(store, store.keep(DOC, copyOf([tabOf("t1", [para("Plain")])]), NONE));

    let { after } = docEditResult(store, base, { type: "appendText", markdown: "1. New" });

    let { listId } = store.tab(after).body.content.at(-1)!.paragraph!.bullet!;
    expect(store.lists(after, [listId])[listId].listProperties?.nestingLevels?.[0])
      .toMatchObject({ glyphType: "DECIMAL" });
    expect(store.lists(base, [listId])).toEqual({});
  });
});

describe("DocStore.reader", () => {
  const ONE_ELEMENT: RunSizes = { least: Infinity, target: Infinity, most: Infinity, elements: 1 };
  /** 1,200 one-run paragraphs: lines repeating every 400, and a list continued near the end. */
  const LINES = () => tabOf("t1", [
    para("Intro"), item("one", "N1"), item("two", "N1"),
    ...Array.from({ length: 1_195 }, (_, at) => para(`Line ${at % 400}`)),
    item("three", "N1"), para("End"),
  ], { N1: { listProperties: { nestingLevels: [{ glyphType: "DECIMAL", startNumber: 1 }] } } });
  /** `LINES` kept in a store over `storage` under the digest `made`: the store and the base. */
  function linesKept(storage: FakeDocStorage, made?: string) {
    let store = new DocStore(storage, undefined, made, ONE_ELEMENT);
    return { store, base: baseOf(store, store.keep(DOC, copyOf([LINES()], {}, ONE_ELEMENT), NONE)) };
  }
  type Handed = { place: number; size: number; summary: DocRunSummary; markdown: string; entry: string };
  /** Every run a walk of `version` hands, with its Markdown. */
  function walked(store: DocStore, version: DocVersion): Handed[] {
    let runs: Handed[] = [];
    store.walk(version, ({ place, size, summary, markdown, entry }) => {
      if (place === 0) runs = [];
      runs.push({ place, size, summary, markdown: markdown(), entry });
      return true;
    });
    return runs;
  }
  /** The runs a reader of `version` from `place` hands, with their Markdown: all, or the first `most`. */
  function read(store: DocStore, version: DocVersion, place: number, back: boolean, most = Infinity) {
    let next = store.reader(version, place, back);
    let runs: Handed[] = [];
    for (let run = next(); run; run = runs.length < most ? next() : undefined) {
      let { size, summary, entry } = run;
      runs.push({ place: run.place, size, summary, markdown: run.markdown(), entry });
    }
    if (most === Infinity) {
      // Past the list it answers nothing, however often it is asked.
      expect(next()).toBeUndefined();
      expect(next()).toBeUndefined();
    }
    return runs;
  }

  /** Deletes the stored renderings of the runs at `places` of `version`. */
  function gone(storage: FakeDocStorage, version: DocVersion, places: number[]): void {
    for (let place of places) {
      storage.sql.exec(
        "DELETE FROM doc_md WHERE (run, context, carry) IN " +
          "(SELECT run, context, carry FROM doc_seq WHERE version = ? AND seq = ?)",
        version.id, place);
    }
  }

  it("hands a version's runs as a walk does, forwards and backwards, from every place", () => {
    let { store, base } = linesKept(fakeDocStorage());
    let all = walked(store, base);
    expect(all).toHaveLength(1_201);
    expect(all.map(run => run.place)).toEqual(all.map((_, at) => at));
    // The runs with their summaries and their Markdown, from the places around a page's edge.
    for (let place of [0, 1, 499, 500, 501, 999, 1_000, 1_001, 1_200, 1_201]) {
      expect(read(store, base, place, false), `forwards from ${place}`).toEqual(all.slice(place));
      expect(read(store, base, place, true), `backwards from ${place}`).toEqual(all.slice(0, place).toReversed());
    }
    // From every place: the first three runs handed.
    for (let place = 0; place <= all.length; place++) {
      expect(read(store, base, place, false, 3)).toEqual(all.slice(place, place + 3));
      expect(read(store, base, place, true, 3)).toEqual(all.slice(Math.max(0, place - 3), place).toReversed());
    }
    // A place past the list: nothing forwards, and the whole list backwards.
    expect(read(store, base, 5_000, false)).toEqual([]);
    expect(read(store, base, 5_000, true)).toEqual(all.toReversed());
  });

  it("names a run's stored rendering: one entry for one row, two for two that read otherwise", () => {
    let { store, base } = linesKept(fakeDocStorage());
    let all = walked(store, base);
    let line = all.findIndex(run => run.markdown.includes("Line 7\n"));
    // The same line 400 paragraphs on is the same run under the same keys: one row.
    expect(all[line + 400].markdown).toBe(all[line].markdown);
    expect(all[line + 400].entry).toBe(all[line].entry);
    expect(all[line + 1].entry).not.toBe(all[line].entry);
    // Two readers of one version hand the same entries, forwards and backwards.
    expect(read(store, base, line, false, 1)[0].entry).toBe(all[line].entry);
    expect(read(store, base, line + 1, true, 1)[0].entry).toBe(all[line].entry);
    // A walk that asks no entry makes none: it is made where it is read.
    let handed: unknown;
    store.walk(base, run => {
      handed = Object.getOwnPropertyDescriptor(run, "entry");
      return false;
    });
    expect(handed).toMatchObject({ get: expect.any(Function) });
  });

  it("names a run's content, and decodes the run where asked at the place it is told", () => {
    let store = new DocStore(fakeDocStorage(), undefined, undefined, ONE_ELEMENT);
    let tab = tabOf("t1", [
      { runs: ["First", footnote(1), "\n"] }, item("same", "N1"), item("same", "N1"),
      { runs: ["Last", footnote(2), "\n"] },
    ], NUMBERED_LIST);
    let base = baseOf(store, store.keep(DOC, copyOf([tab], {}, ONE_ELEMENT), NONE));
    let next = store.reader(base, 0);
    let runs: StoredRun[] = [];
    let cost = { ...docStoreCost };
    for (let run = next(); run; run = next()) runs.push(run);
    // The two items hold the same elements and read "1." and "2.": one content, two entries.
    let [first, second, last] = runs.slice(-3);
    expect(second.content).toBe(first.content);
    expect(second.entry).not.toBe(first.entry);
    expect(last.content).not.toBe(first.content);
    // A run handed is not decoded. Asked once the reader has passed the list, each decodes
    // alone, and told where it starts and the footnotes before it, as the tab does.
    expect(docStoreCost.runsDecoded - cost.runsDecoded).toBe(0);
    let at = base.bodyEndIndex - runs.reduce((sum, run) => sum + run.size, 0), footnotes = 0;
    let content = runs.flatMap(run => {
      let elements = run.elements(at, footnotes);
      at += run.size;
      footnotes += JSON.stringify(elements).split("\"footnoteReference\"").length - 1;
      return elements;
    });
    expect(docStoreCost.runsDecoded - cost.runsDecoded).toBe(runs.length);
    expect(content).toEqual(store.tab(base).body.content);
    // Told of no footnote before it, a run counts its own from one.
    expect(JSON.stringify(last.elements(0))).toContain("\"footnoteNumber\":\"1\"");
  });

  it("counts the Markdown asked of it in hand, a run at a time, and none of a run it only hands", () => {
    let { store, base } = linesKept(fakeDocStorage());
    let all = walked(store, base);
    let longest = Math.max(...all.map(run => run.markdown.length));
    for (let back of [false, true]) {
      for (let place of [1, 500, all.length - 3, all.length]) {
        docStoreCost.peakMarkdownCharsInHand = 0;
        let runs = read(store, base, place, back, 3);
        // The longest of the runs read, and nothing added up over them.
        expect(docStoreCost.peakMarkdownCharsInHand, `${place}, ${back}`)
          .toBe(Math.max(0, ...runs.map(run => run.markdown.length)));
      }
    }
    // The tab's last run alone, which is shorter than the longest: the peak is its own.
    docStoreCost.peakMarkdownCharsInHand = 0;
    let [last] = read(store, base, all.length, true, 1);
    expect(last.markdown).toBe(all.at(-1)!.markdown);
    expect(docStoreCost.peakMarkdownCharsInHand).toBe(last.markdown.length);
    expect(last.markdown.length).toBeGreaterThan(0);
    expect(last.markdown.length).toBeLessThan(longest);
    // A run handed whose Markdown is not asked for is not read, and counts nothing.
    docStoreCost.peakMarkdownCharsInHand = 0;
    let next = store.reader(base, 0);
    for (let run = next(); run; run = next()) expect(run.summary.markdownLength).toBe(all[run.place].markdown.length);
    expect(docStoreCost.peakMarkdownCharsInHand).toBe(0);
  });

  it("renders a run whose rendering is gone alone, in either direction, and reads the same", () => {
    for (let back of [false, true]) {
      let storage = fakeDocStorage();
      let { store, base } = linesKept(storage);
      let all = walked(store, base);
      // The list's third item, numbered by the carry; forwards, a line before it at 300, 700,
      // 1,100.
      let third = all.findIndex(run => run.markdown.includes("3. three"));
      expect(third).toBeGreaterThan(1_100);
      let missing = back ? [third] : [third, 700];
      gone(storage, base, missing);
      let cost = { ...docStoreCost };
      let runs = read(store, base, back ? all.length : 0, back);
      expect(back ? runs.toReversed() : runs).toEqual(all);
      // Each is rendered once, alone: the line's one row stands for its three places.
      expect(docStoreCost.runsRendered - cost.runsRendered).toBe(missing.length);
      expect(docStoreCost.runsDecoded - cost.runsDecoded).toBe(missing.length);
      // Its rendering stands again: nothing is rendered for the next reader.
      read(store, base, 0, false);
      expect(docStoreCost.runsRendered - cost.runsRendered).toBe(missing.length);
    }
    // BACKWARDS a run renders with the state the earlier summaries give; with one gone too, the
    // version is keyed again whole, and reads the same.
    let storage = fakeDocStorage();
    let { store, base } = linesKept(storage);
    let all = walked(store, base);
    gone(storage, base, [all.length - 2, 700]);
    let cost = { ...docStoreCost };
    expect(read(store, base, all.length, true).toReversed()).toEqual(all);
    expect(docStoreCost.runsRendered - cost.runsRendered).toBe(all.length);
  });

  /** A two-item list continued 30 lines on, kept: its walked runs and the 2nd and 3rd items' places. */
  function continuedKept() {
    let storage = fakeDocStorage();
    let store = new DocStore(storage, undefined, undefined, ONE_ELEMENT);
    let tab = tabOf("t1", [
      para("Intro"), item("one", "N1"), item("two", "N1"),
      ...Array.from({ length: 30 }, (_, at) => para(`Line ${at}`)),
      item("three", "N1"), para("End"),
    ], { N1: { listProperties: { nestingLevels: [{ glyphType: "DECIMAL", startNumber: 1 }] } } });
    let base = baseOf(store, store.keep(DOC, copyOf([tab], {}, ONE_ELEMENT), NONE));
    let all = walked(store, base);
    let [second, third] = [". two\n", "3. three\n"].map(text => all.findIndex(run => run.markdown.endsWith(text)));
    expect([second, third]).toEqual([3, 34]);
    return { storage, store, base, all, second, third };
  }
  /** Makes the stored Markdown of the run at `place` of `version` one that does not read back. */
  function unread(storage: FakeDocStorage, version: DocVersion, place: number): void {
    storage.sql.exec(
      "UPDATE doc_md SET md = char(1) || '{bad' WHERE (run, context, carry) IN " +
        "(SELECT run, context, carry FROM doc_seq WHERE version = ? AND seq = ?)",
      version.id, place);
  }

  it("backwards, renders each run with the state of its own place", () => {
    // The two items' Markdown does not read back but their summaries do: each state is worked out.
    let { storage, store, base, all, second, third } = continuedKept();
    for (let place of [second, third]) unread(storage, base, place);
    let cost = { ...docStoreCost };
    // Each run is rendered with its own place's state, so no key differs and nothing is keyed again.
    expect(read(store, base, all.length, true).toReversed()).toEqual(all);
    expect(docStoreCost.runsRendered - cost.runsRendered).toBe(2);
    expect(docStoreCost.runsDecoded - cost.runsDecoded).toBe(2);
    expect(docStoreCost.runsKeyed - cost.runsKeyed).toBe(0);
    // Both renderings stand again: nothing is rendered for the next reader.
    expect(read(store, base, 0, false)).toEqual(all);
    expect(docStoreCost.runsRendered - cost.runsRendered).toBe(2);
  });

  it("backwards, reads a run's Markdown again once the version is keyed again for it", () => {
    // The third item's Markdown is unreadable and the second's rendering gone: no state for it.
    let { storage, store, base, all, second, third } = continuedKept();
    gone(storage, base, [second]);
    unread(storage, base, third);
    let cost = { ...docStoreCost };
    // The version is keyed again whole, and the run in hand, still unreadable, rendered alone once more.
    expect(read(store, base, all.length, true).toReversed()).toEqual(all);
    expect(docStoreCost.runsRendered - cost.runsRendered).toBe(all.length + 1);
    // The copy is kept, and nothing is rendered for the next reader.
    let rendered = docStoreCost.runsRendered;
    expect(read(store, base, 0, false)).toEqual(all);
    expect(docStoreCost.runsRendered).toBe(rendered);
  });

  it("keys a version kept under another digest first, when the reader is made", () => {
    let storage = fakeDocStorage();
    let { store: earlier, base } = linesKept(storage, "earlier");
    let all = walked(earlier, base);
    let store = new DocStore(storage, undefined, "later", ONE_ELEMENT);
    let cost = { ...docStoreCost };
    let next = store.reader(base, 600, true);
    // Every run was rendered as the reader was made, and none as it reads.
    expect(docStoreCost.runsRendered - cost.runsRendered).toBe(all.length);
    let handed = next()!;
    expect(docStoreCost.runsRendered - cost.runsRendered).toBe(all.length);
    let { place, size, summary, markdown } = all[599];
    expect({ place: handed.place, size: handed.size, summary: handed.summary, markdown: handed.markdown() })
      .toEqual({ place, size, summary, markdown });
  });
});

describe("DocStore.runs", () => {
  /** Six paragraphs that each name a footnote: under `RUNS_OF_THREE`, a run each. */
  const NOTED = () => tabOf("t1", Array.from({ length: 6 }, (_, at) =>
    ({ runs: [`Paragraph ${at}`, footnote(at + 1), ".\n"] })));
  const SHAPES: [string, () => GoogleDocsTab][] = [
    ["prose", () => proseTab("t1", 400)],
    ["many runs", () => tinyTablesTab("t1", 300)],
    ["footnotes", NOTED],
  ];
  const SIZES: [string, RunSizes | undefined][] = [["the store's sizes", undefined], ["runs of three", RUNS_OF_THREE]];

  /** `tab` kept alone under `sizes`: the storage, a store over it and the tab's base version. */
  function keptAlone(tab: GoogleDocsTab, sizes?: RunSizes) {
    let { storage, store } = opened(undefined, undefined, sizes);
    return { storage, store, base: baseOf(store, store.keep(DOC, copyOf([tab], {}, sizes), NONE)) };
  }

  it.each(SHAPES.flatMap(([shape, tab]) => SIZES.map(([cut, sizes]) => [shape, cut, tab, sizes] as const)))(
    "hands a version's runs decoded one at a time, with the indexes they have in the tab: %s under %s",
    (_shape, _cut, tab, sizes) => {
      let { storage, store, base } = keptAlone(tab(), sizes);
      let listed = listOf(storage, base).length;

      let runs: (readonly unknown[])[] = [];
      let cost = spent(() => {
        for (let elements of store.runs(base)) runs.push(elements);
      });

      expect(runs).toHaveLength(listed);
      expect(cost).toMatchObject({ runsDecoded: listed, runsRendered: 0, runsKeyed: 0, rowsWritten: 0 });
      // The tab whole decodes each run at its place too: elements, indexes and footnote numbers.
      expect(runs.flat()).toEqual(store.tab(base).body.content);
      expect(JSON.stringify(runs.flat())).toBe(JSON.stringify(store.tab(base).body.content));
    });

  it("hands the footnotes the numbers they have in the tab, whichever run names them", () => {
    let { store, base } = keptAlone(NOTED(), RUNS_OF_THREE);

    let numbers = [...store.runs(base)].map(elements => elements.flatMap(element =>
      (element.paragraph?.elements ?? []).flatMap(part => part.footnoteReference?.footnoteNumber ?? [])));

    // A stored number counts from its run's start: each of these is stored as "1".
    expect(numbers).toEqual([["1"], ["2"], ["3"], ["4"], ["5"], ["6"]]);
  });

  it("hands an edit's version its runs, and an empty body one run of no element", () => {
    let { store, base } = keptAlone(PROSE());
    let after = edited(store, base, "e1");
    expect([...store.runs(after)].flat()).toEqual(store.tab(after).body.content);

    let empty = store.putTab(DOC, { ...PROSE(), tabId: "t9", body: { content: [] } }, []);
    expect([...store.runs(empty)]).toEqual([[]]);
    // The reader, which is not told how many runs there are, decodes that run to none as well.
    expect(store.reader(empty, 0)()!.elements(0)).toEqual([]);
  });

  it("reads the list a page at a time and no rendering", () => {
    // 1,203 runs: three pages of the list.
    let storage = fakeDocStorage();
    let store = new DocStore(storage, undefined, undefined, ONE);
    let base = baseOf(store, store.keep(DOC, copyOf([proseTab("t1", 1_202)], {}, ONE), NONE));
    let counted = countedStorage(storage);
    let reader = new DocStore(counted.storage, undefined, undefined, ONE);
    let before = new Set(counted.ran());

    let handed = 0;
    let cost = statementsSpent(counted, () => {
      for (let elements of reader.runs(base)) handed += elements.length;
    });
    let ran = counted.ran().filter(statement => !before.has(statement));

    expect(handed).toBe(1_203);
    // The totals, three pages with no join, and for each run that it is stored and its JSON.
    expect(cost).toMatchObject({
      runsDecoded: 1_203, runsRendered: 0, runsKeyed: 0, rowsWritten: 0,
      pages: 3, joined: 0, content: 1_203, all: 1 + 3 + 2 * 1_203, styles: 0, lists: 0,
    });
    expect(ran).toHaveLength(4);
    expect(ran.filter(statement => statement.includes("doc_md"))).toEqual([]);
    expect(ran.filter(statement => !statement.startsWith("SELECT"))).toEqual([]);
  });

  it("asks storage for a run when that run is asked for, and for nothing after the last", () => {
    let { storage, base } = keptAlone(NOTED(), RUNS_OF_THREE);
    let counted = countedStorage(storage);
    let store = new DocStore(counted.storage, undefined, undefined, RUNS_OF_THREE);
    let ran = () => counted.counts().all;

    let before = ran();
    let runs = store.runs(base);
    // Nothing is read until the first run is asked for.
    expect(ran()).toBe(before);
    let asked: number[] = [];
    for (let step = runs.next(); !step.done; step = runs.next()) {
      asked.push(ran() - before);
      before = ran();
    }

    // The first run: totals, the list's page, the run's row and JSON; each after: row and JSON.
    expect(asked).toEqual([4, 2, 2, 2, 2, 2]);
    // The page came short, so its end reads nothing.
    expect(ran()).toBe(before);
  });

  it.each([
    ["a run is missing", "DELETE FROM doc_run WHERE id = ?"],
    ["a run is not a list of elements", "UPDATE doc_run SET json = '{}' WHERE id = ?"],
  ])("is unreadable, and drops the copy, where %s", (_what, statement) => {
    let { storage, store, base } = keptAlone(NOTED(), RUNS_OF_THREE);
    storage.sql.exec(statement, listOf(storage, base)[1].run).toArray();

    let runs = store.runs(base);
    // The run before the damaged one is handed; the copy goes when the damaged one is met.
    expect(runs.next().done).toBe(false);
    expect(store.head(DOC)).toBeDefined();
    expect(() => runs.next()).toThrow(new Error(DOC_COPY_UNREADABLE));

    expect(store.head(DOC)).toBeUndefined();
    expect(counts(storage)).toEqual(EMPTY);
  });

  it("is unreadable where the version lists no run, and where a run of no element stands among others", () => {
    let swept = keptAlone(NOTED(), RUNS_OF_THREE);
    swept.storage.sql.exec("DELETE FROM doc_seq WHERE version = ?", swept.base.id).toArray();
    expect(() => [...swept.store.runs(swept.base)]).toThrow(new Error(DOC_COPY_UNREADABLE));
    expect(swept.store.head(DOC)).toBeUndefined();

    let { storage, store, base } = keptAlone(NOTED(), RUNS_OF_THREE);
    storage.sql.exec("INSERT INTO doc_run (doc, id, json) VALUES (?, ?, '[]')", DOC, runId("[]")).toArray();
    storage.sql.exec("UPDATE doc_seq SET run = ? WHERE version = ? AND seq = 1", runId("[]"), base.id).toArray();
    expect(() => [...store.runs(base)]).toThrow(new Error(DOC_COPY_UNREADABLE));
    expect(store.head(DOC)).toBeUndefined();
  });
});
