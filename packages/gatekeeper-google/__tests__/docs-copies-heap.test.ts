// What a search for the text a comment quotes holds of a Google Doc, on a tab of 19,601 runs
// and one of 20,000 paragraphs: over the copy a Drive connection keeps, a run and a page of
// the list; over a fetched answer at an approval, nothing of the elements it has passed.

import { describe, expect, it } from "vitest";
import type { GoogleDocsDocument, GoogleDocsTab } from "../src/docs-api";
import { driveDocCopies } from "../src/docs-copy";
import { DocStore } from "../src/docs-store";
import { locateQuoteInFetched, savedDoc } from "../src/drive-comment-body";
import { fakeDocStorage, type FakeDocStorage } from "./doc-store-fake";
import { scenarioTab, tinyTablesTab } from "./doc-store-scenarios";
import { HEAP_MEASURED, heapHeld, inUse } from "./heap-held";

/** The pairs of a table and a paragraph of the many-run tab, and the runs it is cut into. */
const PAIRS = 9_800, RUNS = 2 * PAIRS + 1;
/** The many-run tab's stored runs: one a table, the opening paragraph, and one shared empty paragraph. */
const RUN_ROWS = PAIRS + 2;
/** The many-run tab: 19,601 runs. */
const manyRuns = () => tinyTablesTab("t1", PAIRS);

const rowsOf = (storage: FakeDocStorage, table: string) =>
  storage.sql.exec<{ rows: number }>(`SELECT count(*) AS rows FROM ${table}`).one().rows;

const readsRun = (query: string) => query.startsWith("SELECT json FROM doc_run");

/**
 * `at` for a read-only measure (throws on any write but the store's opening one): true at the
 * run-JSON reads whose 1-based place is in `places`.
 */
function reading(places: readonly number[]): (query: string) => boolean {
  let seen = 0;
  return query => {
    if (!query.startsWith("SELECT") && !query.startsWith("CREATE TABLE IF NOT EXISTS doc_format")) {
      throw new Error(`A measure of a shape that is only read ran: ${query}`);
    }
    return readsRun(query) && places.includes(++seen);
  };
}

/**
 * The many-run tab kept as a Drive file's approved copy, then its view searched for `quote` as a
 * comment's lookup does. Answers what the search holds at the runs at `places`, what it
 * answered, and what storage held before.
 */
function lookedUpInDriveCopy(quote: string, places: readonly number[]) {
  let storage = fakeDocStorage();
  // Where the store's statements go: the storage, and for the measure the probe's view of it.
  let target = storage;
  let store = new DocStore({
    ...storage,
    sql: { exec: (query: string, ...bindings: unknown[]) => target.sql.exec(query, ...bindings) },
  } as FakeDocStorage);
  let copies = driveDocCopies(() => store, "doc");
  let held = copies.hold(
    { documentId: "doc", title: "Many runs", revisionId: "r1", tabs: [manyRuns()] }, 1_000);
  let kept = copies.keep(held, "folder")!;
  let before = {
    listed: rowsOf(storage, "doc_seq"),
    rows: rowsOf(storage, "doc_run"),
    approved: store.head("doc")?.approvedAt !== undefined,
  };

  let answer = "";
  let { bytes, seen } = heapHeld(storage, reading(places), observed => {
    target = observed;
    try {
      answer = JSON.stringify(savedDoc(kept).locate("t1", quote));
    } catch (refusal) {
      answer = (refusal as Error).message;
    } finally {
      target = storage;
    }
  });
  return { bytes, seen, answer, before };
}

describe("what a lookup in a stored Google Doc holds", HEAP_MEASURED, () => {
  it("a lookup in the copy a Drive connection keeps holds a run where the copy is fresh", () => {
    // The last table's text: the search reads to the tab's end to find it once.
    let looked = lookedUpInDriveCopy(`cell ${PAIRS - 1}`, [1, PAIRS, RUNS]);

    // Stored and approved before the search; the context is one row more than the runs.
    expect(looked.before).toEqual({ listed: RUNS, rows: RUN_ROWS + 1, approved: true });
    expect(looked.seen).toBe(3);
    expect(JSON.parse(looked.answer)).toMatchObject({ tabId: "t1" });
    // A page of the list and the text's tail, not a decoded run for every run passed.
    expect(looked.bytes / RUNS).toBeLessThan(16);
  });
});

/** The lower of two readings of what is in use, taken in a row, as `heapHeld` reads it. */
const settled = () => Math.min(inUse(), inUse());

/** A fetch's parsed answer of `tabs`, made here so no measuring frame names the tabs or the text. */
function fetchedAnswer(tabs: () => GoogleDocsTab[]): GoogleDocsDocument {
  return JSON.parse(JSON.stringify({ documentId: "doc", title: "Doc", revisionId: "r1", tabs: tabs() }));
}

/** What the answer of a fetch of `tabs` weighs in hand, parsed: over what was in use before. */
function answerInHand(tabs: () => GoogleDocsTab[]): number {
  let before = settled();
  let answer = fetchedAnswer(tabs);
  let bytes = settled() - before;
  // Read after the measure: the answer is in hand at it.
  return answer.tabs.length > 0 ? bytes : 0;
}

/**
 * `fetchedAnswer(tabs)` with `probe` called as the search reads `t1`'s last element, through a
 * `paragraph` accessor on the element (one on an array slot would make the array a dictionary).
 */
function probedAnswer(tabs: () => GoogleDocsTab[], probe: () => void): GoogleDocsDocument {
  let answer = fetchedAnswer(tabs);
  let element = answer.tabs.find(tab => tab.tabId === "t1")!.body.content.at(-1)!;
  let { paragraph } = element;
  Object.defineProperty(element, "paragraph", { enumerable: true, get: () => (probe(), paragraph) });
  return answer;
}

/**
 * An approval's search for `quote` in `t1` of a fetched answer: what is in use at the tab's last
 * element over what was in use BEFORE THE ANSWER WAS MADE, how often it was read, and the answer.
 */
function searchedInAnswer(tabs: () => GoogleDocsTab[], quote: string) {
  let before = settled();
  let reached = 0, most = 0;
  let answer = probedAnswer(tabs, () => {
    reached++;
    most = Math.max(most, settled());
  });
  let found: string;
  try {
    found = JSON.stringify(locateQuoteInFetched(answer, "t1", quote));
  } catch (refusal) {
    found = (refusal as Error).message;
  }
  return { bytes: most - before, reached, found };
}

/** The tab of 20,000 paragraphs. */
const linesTab = () => scenarioTab(
  "t1", Array.from({ length: 20_000 }, (_, at) => `Line ${String(at).padStart(5, "0")}.`));

describe("what an approval's search of a fetched Google Doc holds", HEAP_MEASURED, () => {
  // At the last element, what is left of the answer is the emptied body list (8 bytes a slot).
  it("an approval's search lets the answer go behind it", () => {
    let many = answerInHand(() => [manyRuns()]);
    let last = searchedInAnswer(() => [manyRuns()], `cell ${PAIRS - 1}`);
    expect(last.reached).toBe(1);
    expect(JSON.parse(last.found)).toMatchObject({ tabId: "t1" });
    // The answer is hundreds of bytes a run, so the bound is far under it.
    expect(many / RUNS).toBeGreaterThan(320);
    expect(last.bytes / RUNS).toBeLessThan(32);

    let lines = answerInHand(() => [linesTab()]);
    let end = searchedInAnswer(() => [linesTab()], "Line 19999.");
    expect(end.reached).toBe(1);
    expect(JSON.parse(end.found)).toEqual({ startIndex: 239_989, endIndex: 240_000, tabId: "t1" });
    expect(lines).toBeGreaterThan(4_000_000);
    expect(end.bytes).toBeLessThan(0.1 * lines);
  });
});
