// What the removals of a Google Doc's stored copies HOLD, measured on the shape that hurts: a
// tab of 19,601 runs (thousands of one-cell tables, a run each, with a run between each two).
// Each bound is stated in bytes a run of that tab, but the one of a pass over a connection's
// copies (a keep's, the expiry's), which is in bytes a copy. And what A READER OF A STORED
// TAB'S OWN TEXT holds, the search for the text a comment quotes: on that tab, in bytes a run,
// and on a tab of 20,000 paragraphs, against what one decoded run weighs; and the same search
// as a comment's lookup makes it, over the copy a Drive connection keeps of a Doc it read. And
// what THE SEARCH AT AN APPROVAL holds of the answer a fetch just parsed, which hands it the
// tab's body elements one at a time, each leaving the answer as it is handed over, and of
// which nothing is stored: against what that answer weighs in hand.
//
// THE STORAGES OF THIS FILE, so that no measure depends on another test or on their order:
// 1. A shape that is only read is kept once a file, by the first test that reads it, and a
//    measure may use it only if it runs no statement but a `SELECT`.
// 2. A measure that writes or deletes anything builds a storage of its own, inside its test.
// 3. A measure of a removal asserts what was removed: the rows the document held before the
//    measured call, and what is left after it.
// 4. A probe chooses a handful of statements: each one chosen costs rounds of full collections.

import { describe, expect, it } from "vitest";
import type { GoogleDocsDocument, GoogleDocsTab } from "../src/docs-api";
import {
  DRIVE_DOC_COPY_EXPIRY_MS, driveDocCopies, DriveDocCopyLimits, MAX_DRIVE_DOC_COPIES,
  storedDocCopy,
} from "../src/docs-copy";
import { DOC_COPY_APPROVAL_GRAIN_MS, DocStore, type DocPending } from "../src/docs-store";
import { locateQuoteInFetched, locateQuoteInRuns, savedDoc } from "../src/drive-comment-body";
import { buildTab, para, sized } from "./doc-fixture";
import { fakeDocStorage, type FakeDocStorage } from "./doc-store-fake";
import {
  keptUnder, scenarioCopy, scenarioEdit, scenarioTab, storedRows, tableCounts, tinyTablesTab,
} from "./doc-store-scenarios";
import { HEAP_MEASURED, heapHeld, inUse } from "./heap-held";

const NONE: DocPending = { edits: [], roots: [] };
/** The pairs of a table and a paragraph of the many-run tab, and the runs it is cut into. */
const PAIRS = 9_800, RUNS = 2 * PAIRS + 1;
/**
 * The rows the many-run tab's runs are stored as: one for each table, one for the paragraph
 * that opens the tab and ONE for every stretch between two tables, which all hold the same
 * empty paragraph and so are one run of the document, listed at 9,800 places.
 */
const RUN_ROWS = PAIRS + 2;
/** The many-run tab: 19,601 runs. */
const manyRuns = () => tinyTablesTab("t1", PAIRS);

/** True at each of the first `most` statements that delete rows of a document's table. */
function firstDeletes(most = 8): (query: string) => boolean {
  let seen = 0;
  return query => query.startsWith("DELETE FROM doc_") && ++seen <= most;
}

const rowsOf = (storage: FakeDocStorage, table: string) =>
  storage.sql.exec<{ rows: number }>(`SELECT count(*) AS rows FROM ${table}`).one().rows;

/**
 * The sweep that follows a rejection, in a storage of its own that keeps the many-run tab: one
 * edit is made in the tab and the document is swept with no edit pending. Answers what the
 * sweep holds at its deletes (`heapHeld`), the rows of the lists before and after it, and
 * whether storage is then what a storage that only kept the tab holds. Numbers only.
 */
function sweptAfterRejection() {
  let { storage, store, base } = keptUnder(fakeDocStorage(), manyRuns(), "a");
  scenarioEdit(store, base, "e1");
  let listedBefore = rowsOf(storage, "doc_seq");
  let { bytes, seen } = heapHeld(storage, firstDeletes(), observed => {
    new DocStore(observed, undefined, "a").sweep("doc", NONE);
  });
  let control = keptUnder(fakeDocStorage(), manyRuns(), "a").storage;
  return {
    bytes, seen, listedBefore, listedAfter: rowsOf(storage, "doc_seq"),
    asOnlyKept: storedRows(storage) === storedRows(control),
  };
}

/**
 * The sweep that ends the trial of a first read, in a storage of its own that holds no copy:
 * a trial of a document of the many-run tab whose `use` does nothing. The document is made
 * before the measure and stays whole through it, so the measure is of what the trial's sweep
 * holds beside it. Answers that, the rows of the runs and of the list stored while `use` ran,
 * and every table's rows after the trial. Numbers only.
 */
function firstTrialSwept() {
  let storage = fakeDocStorage();
  let document = scenarioCopy([manyRuns()]);
  let inside = { runs: 0, listed: 0 };
  let { bytes, seen } = heapHeld(storage, firstDeletes(), observed => {
    new DocStore(observed).trial("doc", document, () => NONE, () => {
      inside = { runs: rowsOf(storage, "doc_run"), listed: rowsOf(storage, "doc_seq") };
    });
  });
  return { bytes, seen, inside, left: tableCounts(storage) };
}

/** A document of one short paragraph that says `text`. */
const small = (text: string) => scenarioCopy([scenarioTab("t1", [text])]);
/** A connection's KV that holds nothing and keeps nothing: no keep asks it anything. */
const NO_KV = { get: () => undefined, put() {} };
/** The clock of the hour `hour`, as an approval is recorded. */
const hour = (at: number) => ({ at: at * DOC_COPY_APPROVAL_GRAIN_MS });

/**
 * An eviction of the many-run tab, in a storage of its own: a connection's limits keep the tab
 * as one document, and an hour later the keep of a small second document, under a cap of one
 * document, evicts it. Answers what that keep holds at its deletes (`heapHeld`), the rows the
 * first document had in the runs' table and in its list before it, how many removals the
 * connection was told of, and whether storage is then what a storage that kept the small
 * document alone holds. Numbers only.
 */
function evictedManyRuns() {
  let storage = fakeDocStorage();
  let limitsOver = (observed: FakeDocStorage, removed: () => void) => new DriveDocCopyLimits({
    store: () => new DocStore(observed), pendingDocs: () => new Set(), removed,
    caps: { count: 1, bytes: Infinity }, kv: NO_KV,
  });
  limitsOver(storage, () => {}).keep("many", scenarioCopy([manyRuns()]), NONE, hour(1));
  let before = {
    runs: storage.sql.exec<{ rows: number }>("SELECT count(*) AS rows FROM doc_run WHERE doc = 'many'").one().rows,
    listed: rowsOf(storage, "doc_seq"),
  };
  let second = small("Small");
  let told = 0;
  let { bytes, seen } = heapHeld(storage, firstDeletes(), observed => {
    limitsOver(observed, () => { told++; }).keep("small", second, NONE, hour(2));
  });
  let control = fakeDocStorage();
  new DocStore(control).keep("small", small("Small"), NONE, hour(2));
  return { bytes, seen, before, told, asOnlySmall: storedRows(storage) === storedRows(control) };
}

/**
 * The keep that brings a connection of 200 one-paragraph documents to 201, in a storage of its
 * own, under the connection's own caps. Answers what it holds while the copies' records are
 * in hand (the connection is asked for its pending documents then, which is where the probe
 * stands) and at the deletes of the eviction that follows, with how many copies were listed
 * and how many removals were told. Numbers only.
 */
function keptOverTwoHundred() {
  let storage = fakeDocStorage();
  let store = new DocStore(storage);
  for (let at = 0; at < MAX_DRIVE_DOC_COPIES; at++) {
    store.keep(`doc-${at}`, small(`Document ${at}`), NONE, hour(at + 1));
  }
  let last = small("The last");
  let told = 0, listed = 0;
  let { bytes, seen } = heapHeld(
    storage, query => query === "SELECT 'pending'" || query.startsWith("DELETE FROM doc_"),
    observed => {
      let kept = new DocStore(observed);
      new DriveDocCopyLimits({
        store: () => kept,
        // The records are in hand here, and nowhere after it.
        pendingDocs: () => {
          listed = rowsOf(storage, "doc_copy");
          observed.sql.exec("SELECT 'pending'").toArray();
          return new Set();
        },
        removed: () => { told++; },
        kv: NO_KV,
      }).keep("last", last, NONE, hour(MAX_DRIVE_DOC_COPIES + 1));
    });
  return { bytes, seen, told, listed, left: rowsOf(storage, "doc_copy") };
}

/**
 * An expiry of the many-run tab, in a storage of its own: a connection's limits keep the tab
 * as its one document, and its expiry pass runs on a clock eight days on. Answers what the
 * pass holds at its deletes (`heapHeld`), the rows the document had in the runs' table and in
 * its list before it, every table's rows after it, how many removals the connection was told
 * of and how many keys it wrote. Numbers only.
 */
function expiredManyRuns() {
  let storage = fakeDocStorage();
  let limitsOver = (observed: FakeDocStorage, removed: () => void, put: () => void) =>
    new DriveDocCopyLimits({
      store: () => new DocStore(observed), pendingDocs: () => new Set(), removed,
      kv: { get: () => undefined, put }, now: () => hour(8 * 24).at,
    });
  limitsOver(storage, () => {}, () => {}).keep("many", scenarioCopy([manyRuns()]), NONE, hour(1));
  let before = {
    runs: storage.sql.exec<{ rows: number }>("SELECT count(*) AS rows FROM doc_run WHERE doc = 'many'").one().rows,
    listed: rowsOf(storage, "doc_seq"),
  };
  let told = 0, written = 0;
  let { bytes, seen } = heapHeld(storage, firstDeletes(), observed => {
    limitsOver(observed, () => { told++; }, () => { written++; }).expire();
  });
  return { bytes, seen, before, told, written, left: tableCounts(storage) };
}

/**
 * The expiry pass over a connection of 200 one-paragraph documents, in a storage of its own,
 * of which the `expired` listed last are past the limit. Answers what the pass holds at the
 * deletes of the copy it removes first, where the record of every copy past the limit is in
 * hand, and as it writes its hour (the KV's `put` runs a statement the probe stands at), with
 * how many removals were told and how many copies are left. Numbers only.
 */
function passedOverTwoHundred(expired: number) {
  let storage = fakeDocStorage();
  let store = new DocStore(storage);
  for (let at = 0; at < MAX_DRIVE_DOC_COPIES; at++) {
    store.keep(`doc-${at}`, small(`Document ${at}`), NONE, hour(24));
  }
  // The copies a pass meets last, as it lists them: approved a day before the others.
  let past = store.copies().slice(MAX_DRIVE_DOC_COPIES - expired).map(({ doc }) => doc);
  for (let doc of past) store.touch(doc, { approved: hour(0) });
  // Of approvals in one hour the pass removes first the copy the store lists first.
  let first = past[0];
  let told = 0;
  let { bytes, seen } = heapHeld(
    storage, (query, bindings) => query === "SELECT 'passed'" ||
      (query.startsWith("DELETE FROM doc_") && bindings[0] === first),
    observed => {
      let kept = new DocStore(observed);
      new DriveDocCopyLimits({
        store: () => kept, pendingDocs: () => new Set(), removed: () => { told++; },
        kv: { get: () => undefined, put: () => { observed.sql.exec("SELECT 'passed'").toArray(); } },
        now: () => DRIVE_DOC_COPY_EXPIRY_MS,
      }).expire();
    });
  return { bytes, seen, told, left: rowsOf(storage, "doc_copy") };
}

// THE BOUNDS, in bytes a run of the many-run tab. A list brought to the isolate is some
// hundreds of bytes a run (the names of a run and of its rendering's key, twice 64
// characters): measured here, a sweep that takes the dead version's keys in hand holds 264,
// and one that then deletes a row a statement, at the end of a first read's trial, 91.
/** A sweep that removes a version beside a live one (0.4 measured, 7 KiB in all). */
const SWEPT = 2;
/** The sweep of a trial none of whose versions is live (3.5 measured, 68 KiB in all). */
const TRIED = 6;
/** An eviction: a drop by the document's key, after a keep (0.4 measured, 8 KiB in all). */
const EVICTED = 16;
/** An expiry: the same drop, after a pass over the one record (1.1 measured, 22 KiB in all). */
const EXPIRED = 16;
/**
 * A pass over the copies' records, in bytes a COPY of the connection, not a run: a record is
 * a key and three numbers. A keep's: 140 to 170 measured, 28 to 34 KiB for 201 copies. The
 * expiry's, at the deletes of the copy it removes first of 200 past the limit: 210 measured,
 * 41 KiB for 200 copies; as it writes its hour, with nothing removed, under 7 KiB in all.
 */
const COPY_RECORD = 400;

describe("what a removal of a stored Google Doc holds", HEAP_MEASURED, () => {
  it("a sweep after a rejection holds no list", () => {
    let swept = sweptAfterRejection();

    expect(swept.seen).toBeGreaterThan(0);
    // Two versions' lists before the sweep, the kept version's alone after it.
    expect(swept.listedBefore).toBeGreaterThan(39_000);
    expect(swept.listedAfter).toBe(RUNS);
    expect(swept.asOnlyKept).toBe(true);
    expect(swept.bytes / RUNS).toBeLessThan(SWEPT);
  });

  it("the sweep of a first read's trial holds no list", () => {
    let tried = firstTrialSwept();

    expect(tried.seen).toBeGreaterThan(0);
    // The context's row is one more than the runs'.
    expect(tried.inside).toEqual({ runs: RUN_ROWS + 1, listed: RUNS });
    expect(tried.left).toEqual({
      doc_copy: 0, doc_md: 0, doc_result: 0, doc_run: 0, doc_seq: 0, doc_version: 0,
    });
    expect(tried.bytes / RUNS).toBeLessThan(TRIED);
  });

  it("an eviction of a tab of 19,601 runs holds none of it", () => {
    let evicted = evictedManyRuns();

    expect(evicted.seen).toBeGreaterThan(0);
    // The context's row is one more than the runs'.
    expect(evicted.before).toEqual({ runs: RUN_ROWS + 1, listed: RUNS });
    expect(evicted.told).toBe(1);
    expect(evicted.asOnlySmall).toBe(true);
    expect(evicted.bytes / RUNS).toBeLessThan(EVICTED);
  });

  it("a keep over 200 copies holds a record a copy", () => {
    let kept = keptOverTwoHundred();

    // The pass over the records, and the six deletes of the one eviction.
    expect(kept.seen).toBe(7);
    expect(kept.listed).toBe(MAX_DRIVE_DOC_COPIES + 1);
    expect(kept.told).toBe(1);
    expect(kept.left).toBe(MAX_DRIVE_DOC_COPIES);
    expect(kept.bytes / kept.listed).toBeLessThan(COPY_RECORD);
  });

  it("an expiry of a tab of 19,601 runs holds none of it", () => {
    let expired = expiredManyRuns();

    expect(expired.seen).toBeGreaterThan(0);
    // The context's row is one more than the runs'.
    expect(expired.before).toEqual({ runs: RUN_ROWS + 1, listed: RUNS });
    expect(expired.left).toEqual({
      doc_copy: 0, doc_md: 0, doc_result: 0, doc_run: 0, doc_seq: 0, doc_version: 0,
    });
    expect([expired.told, expired.written]).toEqual([1, 1]);
    expect(expired.bytes / RUNS).toBeLessThan(EXPIRED);
  });

  it("an expiry pass over 200 copies holds a record a copy", () => {
    // None past the limit: the probe stands where the pass writes its hour.
    let passed = passedOverTwoHundred(0);
    expect(passed.seen).toBe(1);
    expect([passed.told, passed.left]).toEqual([0, MAX_DRIVE_DOC_COPIES]);
    expect(passed.bytes / MAX_DRIVE_DOC_COPIES).toBeLessThan(COPY_RECORD);

    // Every copy past the limit: the six deletes of the first run with all 200 records in
    // hand, and the call, under its bound, removes them all and writes its hour.
    let removing = passedOverTwoHundred(MAX_DRIVE_DOC_COPIES);
    expect(removing.seen).toBe(7);
    expect([removing.told, removing.left]).toEqual([MAX_DRIVE_DOC_COPIES, 0]);
    expect(removing.bytes / MAX_DRIVE_DOC_COPIES).toBeLessThan(COPY_RECORD);
  });
});

// ---------------------------------------------------------------------------
// What a reader of a stored tab's own text holds
// ---------------------------------------------------------------------------

type Kept = ReturnType<typeof keptUnder<FakeDocStorage>>;
const shapes = new Map<string, Kept>();

/**
 * The tab `tab` makes, kept under the digest `a` in a storage of its own: once a file, by the
 * first test that reads it. FOR MEASURES THAT ONLY READ (`reading`).
 */
function shape(name: string, tab: () => GoogleDocsTab): Kept {
  let kept = shapes.get(name);
  if (!kept) shapes.set(name, kept = keptUnder(fakeDocStorage(), tab(), "a"));
  return kept;
}

const manyRunsKept = () => shape("19,601 runs", manyRuns);
/** A tab of 20,000 paragraphs, `Line 00000.` and on: some hundreds of paragraphs a run. */
const linesKept = () => shape("20,000 paragraphs", () => scenarioTab(
  "t1", Array.from({ length: 20_000 }, (_, at) => `Line ${String(at).padStart(5, "0")}.`)));

/**
 * What the kept shape stores of its tab: the runs its version lists, the rows of the runs'
 * table, and the longest run's JSON in bytes at two a character, which a decoded run weighs
 * about.
 */
function sizeOf({ storage, base }: Kept) {
  let number = (query: string, ...bindings: unknown[]) =>
    Number(Object.values(storage.sql.exec(query, ...bindings).one())[0]);
  return {
    runs: number("SELECT COUNT(*) AS runs FROM doc_seq WHERE version = ?", base.id),
    rows: rowsOf(storage, "doc_run"),
    run: 2 * number("SELECT MAX(LENGTH(json)) AS longest FROM doc_run"),
  };
}

const readsRun = (query: string) => query.startsWith("SELECT json FROM doc_run");

/**
 * `at` for a measure of a shape that is only read: it throws for a statement that is not a
 * `SELECT`, but the one a store opens with, which makes a table only where there is none.
 * True at the statements that read a run's JSON whose place among them, counted from 1, is
 * one of `places`.
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
 * A search for `quote` in the kept shape's tab, through a view of its stored copy
 * (`savedDoc`). Answers what the search holds as it reads the runs at `places` (`heapHeld`)
 * and what it answered: the range as JSON, or the refusal's message. Numbers and that string
 * only.
 */
function searched({ storage }: Kept, quote: string, places: readonly number[]) {
  let answer = "";
  let { bytes, seen } = heapHeld(storage, reading(places), observed => {
    let store = new DocStore(observed, undefined, "a");
    let saved = savedDoc(storedDocCopy(store, "doc", store.head("doc")!));
    try {
      answer = JSON.stringify(saved.locate("t1", quote));
    } catch (refusal) {
      answer = (refusal as Error).message;
    }
  });
  return { bytes, seen, answer };
}

/**
 * An iteration of the runs of the kept shape's tab to its end, nothing done with any: by a
 * `for...of`, which holds the run it was handed until the next is made, or, `stepped`, by a
 * caller that lets go of each run before it asks for the next. Answers what it holds as it
 * reads the runs at `places` and how many runs it was handed.
 */
function iterated({ storage, base }: Kept, places: readonly number[], stepped = false) {
  let handed = 0;
  let { bytes, seen } = heapHeld(storage, reading(places), observed => {
    let runs = new DocStore(observed, undefined, "a").runs(base);
    if (stepped) {
      let step = () => !runs.next().done;
      while (step()) handed++;
    } else {
      for (let _elements of runs) handed++;
    }
  });
  return { bytes, seen, handed };
}

/** A paragraph of a thousand text runs of no text, which take no index, at index 3. */
const noText = () => ({ paragraph: { elements: Array.from({ length: 1_000 }, () =>
  ({ startIndex: 3, endIndex: 3, textRun: { content: "" } })) } });
/** A paragraph of one text run that holds `content` from `startIndex`. */
const oneText = (startIndex: number, content: string) => ({ paragraph: { elements: [
  { startIndex, endIndex: startIndex + content.length, textRun: { content } }] } });

/**
 * A search for `bc` across `items` paragraphs of a thousand text runs of no text each, between
 * a paragraph that ends `ab` and one that starts `cd`, each paragraph made as it is asked
 * for. Answers what is in use as the last paragraph is asked for over what was before the
 * search, and the range found as JSON.
 */
function searchedAcrossNoText(items: number) {
  let most = 0;
  let runs = function* () {
    yield [oneText(1, "ab")];
    for (let at = 0; at < items; at++) yield [noText()];
    most = inUse();
    yield [oneText(3, "cd\n")];
  };
  let before = inUse();
  let answer = JSON.stringify(locateQuoteInRuns("t1", runs(), "bc", { wholeChips: true }));
  return { bytes: most - before, answer };
}

/**
 * A lookup of quoted text over the copy a Drive connection keeps, in a storage of its own,
 * by the calls a Drive source makes of `driveDocCopies` (the source itself runs only in
 * workerd): the many-run tab, as a fetch answers it, is held and kept as the file's copy with
 * its read approved under a folder (the trial between the two, which leaves no row, is
 * measured above); then the view that keep answered, which is what the source's snapshot
 * holds and hands a read while the copy is fresh, is searched for `quote` (`savedDoc`), as a
 * comment's lookup searches it. Answers what the search holds as it reads the runs at
 * `places` (`heapHeld`), what it answered, and what storage held before the search: the runs
 * the tab's list names, the rows of the runs' table and whether the copy's record says when
 * a read of it was approved. Numbers and that string only.
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

// THE BOUNDS OF A READ. At the statement that reads a run's JSON the reader has in hand what
// it keeps of the runs before: a page of the version's list (500 runs at most, some 300 bytes
// each) and, of a search, the end of the text so far with its pieces and the first place's.
/**
 * On the many-run tab, in bytes a run of the tab: 8 to 12 measured, 157 to 221 KB in all,
 * which is the page. A decoded run held for every run passed would be hundreds of bytes a run.
 */
const READ = 16;
/**
 * On the tab of 20,000 paragraphs, as a part of `run`, the longest run's JSON at two bytes a
 * character (131,032 bytes), which a decoded run weighs about (0.93 measured): 0.37 to 0.43
 * measured, 48 to 56 KB in all, the page of its 133 runs and the search's own. With the run
 * before in hand, 1.3.
 */
const NO_RUN = 0.75;
/** The same with the run a `for...of` holds until the next is made (1.3 measured; two, 2.2). */
const ONE_RUN = 1.75;
/**
 * What a search holds of 200,000 text runs of no text it passed, in all: 13 KB measured. A
 * piece kept for each is 15 MB.
 */
const NO_TEXT = 64 * 1024;

describe("what a reader of a stored Google Doc's own text holds", HEAP_MEASURED, () => {
  it("a search of a tab of 19,601 runs holds a run", () => {
    let kept = manyRunsKept();
    let { runs, rows } = sizeOf(kept);
    // The context's row is one more than the runs'.
    expect([runs, rows]).toEqual([RUNS, RUN_ROWS + 1]);

    // The last table's text: the search reads to the tab's end to find it once.
    let last = searched(kept, `cell ${PAIRS - 1}`, [1, PAIRS, RUNS]);
    expect(last.seen).toBe(3);
    expect(JSON.parse(last.answer)).toMatchObject({ tabId: "t1" });
    expect(last.bytes / RUNS).toBeLessThan(READ);

    // Text of the tab's fourth run and of 1,110 later ones: the first place is in hand from
    // the fifth run to the last.
    let twice = searched(kept, "cell 1", [1, 5, PAIRS, RUNS]);
    expect(twice.seen).toBe(4);
    expect(twice.answer).toBe("That text appears 1111 times; quote more of it so it is unique.");
    expect(twice.bytes / RUNS).toBeLessThan(READ);
  });

  it("a search of a tab of 20,000 paragraphs holds a run", () => {
    let kept = linesKept();
    let { runs, run } = sizeOf(kept);
    expect(runs).toBeGreaterThan(100);

    // Text of the last run: found once, with nothing of the runs before in hand.
    let last = searched(kept, "Line 19999.", [1, Math.ceil(runs / 2), runs]);
    expect(last.seen).toBe(3);
    expect(JSON.parse(last.answer)).toEqual({ startIndex: 239_989, endIndex: 240_000, tabId: "t1" });
    expect(last.bytes).toBeLessThan(NO_RUN * run);

    // Text of the first run's first ten paragraphs: the first place is in hand from the
    // second run to the last.
    let twice = searched(kept, "Line 0000", [1, 2, Math.ceil(runs / 2), runs]);
    expect(twice.seen).toBe(4);
    expect(twice.answer).toBe("That text appears 10 times; quote more of it so it is unique.");
    expect(twice.bytes).toBeLessThan(NO_RUN * run);
  });

  it("an iteration of a tab's runs holds one, and none once its caller lets go of it", () => {
    let many = iterated(manyRunsKept(), [1, PAIRS, RUNS]);
    expect([many.seen, many.handed]).toEqual([3, RUNS]);
    expect(many.bytes / RUNS).toBeLessThan(READ);

    let kept = linesKept();
    let { runs, run } = sizeOf(kept);
    let places = [1, Math.ceil(runs / 2), runs];
    let held = iterated(kept, places);
    expect([held.seen, held.handed]).toEqual([3, runs]);
    expect(held.bytes).toBeLessThan(ONE_RUN * run);
    // The run its caller holds is all of it: the store keeps none.
    expect(held.bytes).toBeGreaterThan(NO_RUN * run);
    let stepped = iterated(kept, places, true);
    expect([stepped.seen, stepped.handed]).toEqual([3, runs]);
    expect(stepped.bytes).toBeLessThan(NO_RUN * run);
  });

  it("a search keeps one piece of a stretch that reads as no text", () => {
    let across = searchedAcrossNoText(200);

    expect(across.answer).toBe(JSON.stringify({ startIndex: 2, endIndex: 4, tabId: "t1" }));
    expect(across.bytes).toBeLessThan(NO_TEXT);
  });

  it("a lookup in the copy a Drive connection keeps holds a run where the copy is fresh", () => {
    // The last table's text, as the search above: read to the tab's end, from stored rows.
    let looked = lookedUpInDriveCopy(`cell ${PAIRS - 1}`, [1, PAIRS, RUNS]);

    // The copy was stored, and its read approved, before the search.
    expect(looked.before).toEqual({ listed: RUNS, rows: RUN_ROWS + 1, approved: true });
    expect(looked.seen).toBe(3);
    expect(JSON.parse(looked.answer)).toMatchObject({ tabId: "t1" });
    expect(looked.bytes / RUNS).toBeLessThan(READ);
  });
});

// ---------------------------------------------------------------------------
// What an approval's search of a fetched answer holds
// ---------------------------------------------------------------------------

/** The lower of two readings of what is in use, taken in a row, as `heapHeld` reads it. */
const settled = () => Math.min(inUse(), inUse());

/**
 * A Doc as a fetch answers it: a parse of its own of the tabs `tabs` makes, in their order.
 * The tabs are made in this call, so no frame that measures names them or the text parsed.
 */
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
 * `fetchedAnswer(tabs)` with `probe` called when the search of tab `tabId` reads the first
 * element of its body, or the last (`slot`): the search asks every element for its
 * `paragraph`, which here is an accessor. On the element and not on the body's slot, since an
 * accessor at an index of an array makes of the whole array a dictionary, which weighs more
 * than what is measured.
 */
function probedAnswer(
  tabs: () => GoogleDocsTab[], tabId: string, slot: "first" | "last", probe: () => void,
): GoogleDocsDocument {
  let answer = fetchedAnswer(tabs);
  let element = answer.tabs.find(tab => tab.tabId === tabId)!.body.content.at(slot === "first" ? 0 : -1)!;
  let { paragraph } = element;
  Object.defineProperty(element, "paragraph", { enumerable: true, get: () => (probe(), paragraph) });
  return answer;
}

/**
 * A search for `quote` in tab `tabId` of a fetched answer of `tabs`, as an approval makes it
 * (`locateQuoteInFetched`). Answers what is in use when the search reads the first element of
 * that tab, or the last (`slot`), over what was in use BEFORE THE ANSWER WAS MADE; how often
 * the search read it; and what the search answered, the range as JSON or the refusal's
 * message. This frame holds the answer, as the approval's does, and numbers and that string.
 */
function searchedInAnswer(
  tabs: () => GoogleDocsTab[], tabId: string, quote: string, slot: "first" | "last",
) {
  let before = settled();
  let reached = 0, most = 0;
  let answer = probedAnswer(tabs, tabId, slot, () => {
    reached++;
    most = Math.max(most, settled());
  });
  let found: string;
  try {
    found = JSON.stringify(locateQuoteInFetched(answer, tabId, quote));
  } catch (refusal) {
    found = (refusal as Error).message;
  }
  return { bytes: most - before, reached, found };
}

const LINES = 20_000;
/** The tab of 20,000 paragraphs, named `tabId`. */
const linesTab = (tabId: string) => scenarioTab(
  tabId, Array.from({ length: LINES }, (_, at) => `Line ${String(at).padStart(5, "0")}.`));

// THE BOUNDS OF AN APPROVAL'S SEARCH. When the search reads the tab's last element, the frame
// that fetched still names the answer, and of the answer what is left is the body's list,
// emptied (a slot an element: 8 bytes), beside the element being read and the search's own.
/**
 * On the many-run tab, in bytes a run of the tab: 11.9 measured, 233 KB in all, 8 of them the
 * emptied slot of each element; the answer in hand is 839 bytes a run, 16.4 MB.
 */
const SEARCHED = 32;
/**
 * On the tab of 20,000 paragraphs, as a part of the answer in hand (7.9 MB, 394 bytes a
 * paragraph): 0.027 measured, 213 KB in all, of which 160 KB are the emptied slots.
 */
const BEHIND = 0.1;
/** A tab that is one table of 4,000 rows of two cells, and a paragraph after it. */
const largeTableTab = () => ({ ...buildTab([sized(4_000, 2), para("The end.")]), tabId: "t1" });
/**
 * On that tab, as a part of the answer in hand (4.4 MB), when the search reads the paragraph
 * after the table: 0.006 measured (27 KB), and 0.2 once, where a collection had not yet taken
 * what the search kept of the table's text.
 */
const TABLE_BEHIND = 0.4;
/**
 * What is in hand of two tabs of 20,000 paragraphs that are not searched when the first
 * element of the tab searched is read, as a part of ONE of them: none measured.
 */
const OTHER_TABS = 0.02;

describe("what an approval's search of a fetched Google Doc holds", HEAP_MEASURED, () => {
  it("an approval's search lets the answer go behind it", () => {
    let many = answerInHand(() => [manyRuns()]);
    let last = searchedInAnswer(() => [manyRuns()], "t1", `cell ${PAIRS - 1}`, "last");
    expect(last.reached).toBe(1);
    expect(JSON.parse(last.found)).toMatchObject({ tabId: "t1" });
    // The answer is hundreds of bytes a run, so the bound is far under it.
    expect(many / RUNS).toBeGreaterThan(10 * SEARCHED);
    expect(last.bytes / RUNS).toBeLessThan(SEARCHED);

    let lines = answerInHand(() => [linesTab("t1")]);
    let end = searchedInAnswer(() => [linesTab("t1")], "t1", "Line 19999.", "last");
    expect(end.reached).toBe(1);
    expect(JSON.parse(end.found)).toEqual({ startIndex: 239_989, endIndex: 240_000, tabId: "t1" });
    expect(lines).toBeGreaterThan(4_000_000);
    expect(end.bytes).toBeLessThan(BEHIND * lines);
  });

  it("an approval's search holds no more of a tab that is mostly one table than its answer", () => {
    let answer = answerInHand(() => [largeTableTab()]);
    let { bytes, reached, found } =
      searchedInAnswer(() => [largeTableTab()], "t1", "The end.", "last");
    expect(reached).toBe(1);
    expect(JSON.parse(found)).toMatchObject({ tabId: "t1" });
    expect(answer).toBeGreaterThan(2_000_000);
    // The table left the answer as the search was handed it, and the search has read past it.
    expect(bytes).toBeLessThan(TABLE_BEHIND * answer);
  });

  it("an approval's search lets every other tab go before it reads the tab searched", () => {
    let lines = answerInHand(() => [linesTab("t0")]);
    let first = searchedInAnswer(
      () => [linesTab("t0"), scenarioTab("t1", ["The budget is final."]), linesTab("t2")],
      "t1", "budget", "first");

    expect(first.reached).toBe(1);
    expect(JSON.parse(first.found)).toEqual({ startIndex: 5, endIndex: 11, tabId: "t1" });
    expect(lines).toBeGreaterThan(4_000_000);
    expect(first.bytes).toBeLessThan(OTHER_TABS * lines);
  });
});
