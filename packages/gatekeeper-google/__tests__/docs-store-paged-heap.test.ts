// What a read of a stored Google Doc tab, and the keying of its version under another digest
// of the code, HOLD: a page of the version's list and a page's lists, whatever the tab's runs
// and whatever its lists. Measured on the shapes that hurt: a tab of 19,601 runs, tabs of
// thousands of numbered lists that one run each names, and a tab of one page whose runs name
// every list. Each bound is in bytes a run or bytes a list, pinned at the measure rounded up
// by a quarter. A large shape is kept once, by the first test that reads it.
// A file of its own, because it replaces a module for every test of its file: the renderer's
// `initialCarry` and `advanceCarry` as other modules import them, each counted, and each
// carry made with its numbers in a map that counts the entries read and written.

import { describe, expect, it, vi } from "vitest";
import type { GoogleDocsTab } from "../src/docs-api";
import type { DocStore } from "../src/docs-store";
import { counted } from "./carry-count";
import { fakeDocStorage, type FakeDocStorage } from "./doc-store-fake";
import {
  countedStorage, keptUnder, listedProseTab, listedTablesTab, spent, tinyTablesTab, under,
} from "./doc-store-scenarios";
import { HEAP_MEASURED, heapHeld } from "./heap-held";
import { WIDER } from "./wider-run";

/** How many carries the store made, and how many runs it moved one past. */
const carries = vi.hoisted(() => ({ advances: 0, made: 0 }));

// The module as it is but for `initialCarry` and `advanceCarry` as other modules import them,
// each counted before it runs, and a carry's numbers counted too. Plain counters and no spy:
// a spy keeps every call's arguments, which would pin each carry and spoil the measures.
vi.mock("../src/markdown-converter", async importOriginal => {
  let converter = await importOriginal<typeof import("../src/markdown-converter")>();
  let { countedCarry } = await import("./carry-count");
  let initialCarry: typeof converter.initialCarry = () => {
    carries.made++;
    return countedCarry(converter.initialCarry());
  };
  let advanceCarry: typeof converter.advanceCarry = (carry, summary) => {
    carries.advances++;
    converter.advanceCarry(carry, summary);
  };
  return { ...converter, initialCarry, advanceCarry };
});

const isPage = (query: string) => /FROM doc_seq\b[^]*ORDER BY (doc_seq\.)?seq LIMIT \?/.test(query);
const readsRun = (query: string) => query.startsWith("SELECT json FROM doc_run");

/** True at the `nth` statement `is` chooses, counted from 1, and at no other. */
function nth(n: number, is: (query: string) => boolean): (query: string) => boolean {
  let seen = 0;
  return query => is(query) && ++seen === n;
}

type Kept = ReturnType<typeof keptUnder<FakeDocStorage>>;
const shapes = new Map<string, Kept>();

/** The tab `tab` makes, kept under the digest `a` in a storage of its own: once a file. */
function shape(name: string, tab: () => GoogleDocsTab): Kept {
  let kept = shapes.get(name);
  if (!kept) shapes.set(name, kept = keptUnder(fakeDocStorage(), tab(), "a"));
  return kept;
}

/**
 * A digest no store of this file has read under: a keying is measured under one of its own,
 * so that a test run again keys again.
 */
const otherDigest = (() => {
  let made = 0;
  return () => `b${++made}`;
})();

const tables7700 = () => shape("7,700 lists", () => listedTablesTab("t1", 7_700));
const tiny19601 = () => shape("19,601 runs", () => tinyTablesTab("t1", 9_800));

/** What the kept shape lists and defines: its runs, and the id and the length of its context's row. */
function sizeOf({ storage, base }: Kept) {
  let { runs } = storage.sql.exec<{ runs: number }>(
    "SELECT COUNT(*) AS runs FROM doc_seq WHERE version = ?", base.id).one();
  let { context, length } = storage.sql.exec<{ context: string; length: number }>(
    `SELECT doc_version.context, length(doc_run.json) AS length FROM doc_version
       JOIN doc_run ON doc_run.id = doc_version.context WHERE doc_version.doc = ? AND doc_version.id = ?`,
    base.doc, base.id).one();
  return { runs, pages: Math.ceil(runs / 500), context, contextLength: length };
}

/**
 * What `read` holds and costs, by a store of the digest `digest` over the kept shape: the
 * bytes in use at the statement `at` chooses over the bytes before the call (`heapHeld`), how
 * many statements it chose, the store's counters and its statements by kind, the carries it
 * made and moved, the entries of their numbers it touched, the most text of definitions one
 * statement answered, how many statements read the version's totals and how many the
 * context's row whole. Numbers only: nothing `read` answers is held here.
 */
function measured(
  { storage, base }: Kept, digest: string, at: (query: string) => boolean,
  read: (store: DocStore) => void,
) {
  let { context } = sizeOf({ storage, base } as Kept);
  let totals = 0, contextReads = 0, definitions = 0, touched = 0;
  let cost: ReturnType<typeof spent> | undefined;
  let before = { ...carries };
  let { bytes, seen } = heapHeld(storage, at, observed => {
    let statements = countedStorage({
      sql: {
        exec: (query: string, ...bindings: unknown[]) => {
          if (query.startsWith("SELECT COUNT(*) AS runs")) totals++;
          if (readsRun(query) && bindings[0] === context) contextReads++;
          return observed.sql.exec(query, ...bindings);
        },
      },
      transactionSync: callback => observed.transactionSync(callback),
    } as FakeDocStorage);
    let store = under(statements.storage, digest);
    touched = counted(() => {
      cost = spent(statements, () => read(store));
    }).touched;
    definitions = statements.definitions();
  });
  return {
    bytes, seen, ...cost!, totals, contextReads, definitions, touched,
    advances: carries.advances - before.advances, made: carries.made - before.made,
  };
}

/**
 * Reads the kept shape's summary and its Markdown once, by the store that kept it, and answers
 * the Markdown's length. A function of its own: neither answer is then a temporary of a
 * test's frame, which would hold it through the measures that follow.
 */
function readOnce({ storage, base }: Kept): number {
  let store = under(storage, "a");
  store.markdown(base);
  return store.summary(base).markdownLength;
}

// THE BOUNDS, in bytes: each the measure on this machine rounded up by a quarter. A list of a
// version read whole, each summary parsed, is 700 to 900 bytes a run, and the list as it
// was, held beside a keying, 180 bytes a run and 570 a list: every bound here is under those.
/** A run of a tab, for a pending read of its summary: the answer's table (96 measured). */
const S = 120;
/** A run of a tab, beside its Markdown, for a pending read of it: a string and its place (46). */
const M = 57;
/** A run of a tab, for a keying under another digest: a page, and no list as it was (12). */
const K = 16;
/**
 * A list of a tab, for a keying: the pass's one carry, a map entry and a short array for
 * each list numbered so far, and a page (150 to 176 measured).
 */
const L = 220;
/**
 * A list of a tab whose definitions are as long as Google sends, for a keying, BY THE LISTS
 * THE TAB HAS: a page's definitions are about 480 KB of text whatever the tab, so they are
 * 240 bytes a list of 2,000 lists and 120 of 4,000; the carry and a page of rows are the
 * rest (462 and 293 measured).
 */
const LL: Record<number, number> = { 2_000: 578, 4_000: 366 };
/**
 * A list of a tab of one page whose runs name every list, for a keying: the text of every
 * definition, by id, and the carry (548 measured).
 */
const P = 685;

describe("what a read and a keying of a stored tab hold", HEAP_MEASURED, () => {
  it("keeps a tab of 7,700 lists, each named by one run", () => {
    let size = sizeOf(tables7700());

    expect(size).toMatchObject({ runs: 15_401, pages: 31 });
    expect(size.contextLength).toBeGreaterThan(2_000_000);
    expect(size.contextLength).toBeLessThan(2_200_000);
  });

  it("a pending read makes no carry, whatever the lists", () => {
    let kept = tables7700();
    for (let read of [(store: DocStore) => void store.markdown(kept.base), (store: DocStore) => void store.summary(kept.base)]) {
      // No carry made, none moved, no statement over the context and no totals: 31 pages.
      expect(measured(kept, "a", () => false, read)).toMatchObject({
        made: 0, advances: 0, touched: 0, lists: 0, styles: 0, totals: 0, pages: 31,
        runsDecoded: 0, runsRendered: 0,
      });
    }

    // The teeth: with the last table's rendering lost, the read makes one carry and moves it
    // over the runs before that run, and renders the one run.
    let small = shape("600 lists", () => listedTablesTab("t1", 600));
    let summary = JSON.stringify(under(small.storage, "a").summary(small.base));
    small.storage.sql.exec(
      `DELETE FROM doc_md WHERE (run, context, carry) IN
         (SELECT run, context, carry FROM doc_seq WHERE version = ? AND seq = ?)`, small.base.id, 1_199);
    let lost = measured(small, "a", () => false, store => {
      expect(JSON.stringify(store.summary(small.base))).toBe(summary);
    });
    expect(lost).toMatchObject({ made: 1, runsDecoded: 1, runsRendered: 1, totals: 1 });
    expect(lost.advances).toBeGreaterThanOrEqual(1_200);
  });

  it("a pending read holds a page of its version's list, whatever the runs", () => {
    let kept = tiny19601();
    let { runs, pages } = sizeOf(kept);
    expect({ runs, pages }).toEqual({ runs: 19_601, pages: 40 });
    // Read once, unmeasured: what a first use of the path allocates is not what a read holds.
    let markdownLength = readOnce(kept);

    // Its answer (a table's summary for each of 9,800 tables) and a page.
    let summary = measured(kept, "a", nth(pages, isPage), store => void store.summary(kept.base));
    expect(summary).toMatchObject({ seen: 1, pages, lists: 0, styles: 0, made: 0 });
    expect(summary.bytes).toBeLessThanOrEqual(S * runs);
    // The Markdown it answers, a string a run, and a page.
    let markdown = measured(kept, "a", nth(pages, isPage), store => void store.markdown(kept.base));
    expect(markdown).toMatchObject({ seen: 1, pages, content: runs, made: 0 });
    expect(markdown.bytes).toBeLessThanOrEqual(markdownLength + M * runs);
  });

  it("a keying after a change of digest holds a page of rows and a page's definitions", () => {
    // (a) By run. The read finds the version not keyed with no page read, keys it (a page a
    // statement) and reads it (as many again): measured at the keying's last page.
    let tiny = tiny19601();
    let { runs, pages } = sizeOf(tiny);
    let byRun = measured(tiny, otherDigest(), nth(pages, isPage), store => void store.summary(tiny.base));
    expect(byRun).toMatchObject({ seen: 1, pages: 2 * pages, joined: pages, runsDecoded: runs, runsRendered: runs });
    expect(byRun.bytes).toBeLessThanOrEqual(K * runs);

    // (b) By list: what is left for every list is the pass's one carry.
    let listed = tables7700();
    let size = sizeOf(listed);
    expect(size.contextLength).toBeGreaterThan(2_000_000);
    expect(size.contextLength).toBeLessThan(2_200_000);
    let byList = measured(
      listed, otherDigest(), nth(size.pages, isPage), store => void store.summary(listed.base));
    expect(byList).toMatchObject({
      seen: 1, pages: 2 * size.pages, lists: size.pages, styles: 1, contextReads: 0,
      runsDecoded: size.runs, runsRendered: size.runs,
    });
    expect(byList.bytes).toBeLessThanOrEqual(L * 7_700);
    // 250 definitions of 254 characters, as storage writes them out: a page's share.
    expect(byList.definitions).toBeGreaterThan(0);
    expect(byList.definitions).toBeLessThanOrEqual(250 * 300);

    // And by count: the entries of the carry's numbers the keying touches grow with the
    // lists, not with their square.
    let fewer = shape("3,000 lists", () => listedTablesTab("t1", 3_000));
    let smaller = measured(fewer, otherDigest(), () => false, store => void store.summary(fewer.base));
    expect(smaller.touched).toBeGreaterThan(0);
    expect(smaller.touched).toBeLessThanOrEqual(6 * 3_000);
    expect(byList.touched).toBeLessThanOrEqual(6 * 7_700);
    expect(byList.touched / smaller.touched).toBeGreaterThan(2.3);
    expect(byList.touched / smaller.touched).toBeLessThan(2.8);
  });

  // A list's definition as Google sends one is about 1.9 KB, so a page's definitions are
  // about 480 KB of text: 1,900 bytes a list of a page, 250 lists a page on this shape.
  it("the same with definitions as long as Google sends", () => {
    let lists = WIDER ? 4_000 : 2_000;
    let kept = shape("long definitions", () => listedTablesTab("t1", lists, "long"));
    let { runs, pages, context, contextLength } = sizeOf(kept);
    expect({ runs, pages }).toEqual({ runs: 2 * lists + 1, pages: Math.ceil((2 * lists + 1) / 500) });
    let definition = JSON.stringify(listedTablesTab("t1", 1, "long").lists["kix.list0"]).length;
    expect(definition).toBeGreaterThanOrEqual(1_850);
    expect(definition).toBeLessThanOrEqual(1_950);
    expect(contextLength).toBeGreaterThan(1_850 * lists);
    expect(contextLength).toBeLessThan(1_950 * lists);

    let digest = otherDigest();
    let keyed = measured(kept, digest, nth(pages, isPage), store => void store.summary(kept.base));
    // One statement a page, none a run; and the context's row is never read whole.
    expect(keyed).toMatchObject({
      seen: 1, lists: pages, styles: 1, runsDecoded: runs, runsRendered: runs, contextReads: 0,
    });
    expect(keyed.definitions).toBeGreaterThan(0);
    expect(keyed.definitions).toBeLessThanOrEqual(250 * 2_000);
    expect(keyed.bytes).toBeLessThanOrEqual(LL[lists] * lists);
    // The teeth: the context parsed whole is several times that.
    let whole = heapHeld(kept.storage, query => query === "SELECT 1 AS held", observed => {
      let parsed = JSON.parse(
        observed.sql.exec<{ json: string }>("SELECT json FROM doc_run WHERE id = ?", context).one().json,
      ) as { lists: Record<string, unknown> };
      observed.sql.exec("SELECT 1 AS held").toArray();
      expect(Object.keys(parsed.lists)).toHaveLength(lists);
    });
    expect(whole.seen).toBe(1);
    expect(whole.bytes).toBeGreaterThan(1_500 * lists);

    expect(measured(kept, digest, () => false, store => void store.summary(kept.base)))
      .toMatchObject({ lists: 0, styles: 0, runsDecoded: 0 });
  });

  // A page's definitions are at most the context's text, a row, and are all of it where one
  // page's runs name every list; on a tab of many pages they are a page's share.
  it("on a tab of one page whose runs name every list, a page's definitions are the tab's", () => {
    let lists = 3_000;
    let kept = shape("one page of prose", () => listedProseTab("t1", lists));
    let { runs, contextLength } = sizeOf(kept);
    expect(runs).toBeGreaterThan(1);
    expect(runs).toBeLessThanOrEqual(500);
    expect(contextLength).toBeGreaterThan(750_000);
    expect(contextLength).toBeLessThan(900_000);

    // Measured at the read of the last run's JSON: the page's definitions are in hand from
    // the first run to the last.
    let keyed = measured(kept, otherDigest(), nth(runs, readsRun), store => void store.summary(kept.base));
    expect(keyed).toMatchObject({ seen: 1, lists: 1, styles: 1, runsDecoded: runs, contextReads: 0 });
    // The one statement answers every definition the tab holds, as text.
    expect(keyed.definitions).toBeGreaterThanOrEqual(0.9 * contextLength);
    expect(keyed.definitions).toBeLessThanOrEqual(contextLength);
    expect(keyed.bytes).toBeLessThanOrEqual(P * lists);
    expect(keyed.bytes).toBeGreaterThan(254 * lists);
  });
});
