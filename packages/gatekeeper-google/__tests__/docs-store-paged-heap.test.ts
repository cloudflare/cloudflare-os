// What the first read of a stored Google Doc tab after an eviction or a deploy holds, on a tab of
// 19,601 runs: its answer and a page of the version's list, and nothing a run but the answer.

import { describe, expect, it } from "vitest";
import type { DocStore } from "../src/docs-store";
import { fakeDocStorage } from "./doc-store-fake";
import { countedStorage, keptUnder, spent, tinyTablesTab, under } from "./doc-store-scenarios";
import { HEAP_MEASURED, heapHeld } from "./heap-held";

const isPage = (query: string) => /FROM doc_seq\b[^]*ORDER BY (doc_seq\.)?seq LIMIT \?/.test(query);

/** True at the `nth` statement `is` chooses, counted from 1, and at no other. */
function nth(n: number, is: (query: string) => boolean): (query: string) => boolean {
  let seen = 0;
  return query => is(query) && ++seen === n;
}

const RUNS = 19_601, PAGES = 40;
/** A digest no store of this file has read under, so that a test run again keys again. */
let digests = 0;
let known: ReturnType<typeof keptUnder<ReturnType<typeof fakeDocStorage>>> | undefined;
/** The tab of 19,601 runs, kept under the digest `a` once a file. */
const kept = () => known ??= keptUnder(fakeDocStorage(), tinyTablesTab("t1", 9_800), "a");

/**
 * What `read` by a store of `digest` holds at the statement `at` chooses over the bytes before
 * the call (`heapHeld`), how many statements it chose, and its statements by kind.
 */
function measured(digest: string, at: (query: string) => boolean, read: (store: DocStore) => void) {
  let { storage } = kept();
  let cost: ReturnType<typeof spent> | undefined;
  let { bytes, seen } = heapHeld(storage, at, observed => {
    let statements = countedStorage(observed);
    cost = spent(statements, () => read(under(statements.storage, digest)));
  });
  return { bytes, seen, ...cost! };
}

describe("what a read of a stored tab holds", HEAP_MEASURED, () => {
  it("a read of its Markdown holds the answer and a page of its version's list", () => {
    let { storage, base } = kept();
    expect(storage.sql.exec("SELECT COUNT(*) AS runs FROM doc_seq WHERE version = ?", base.id).one())
      .toEqual({ runs: RUNS });
    // Read once, unmeasured: what a first use of the path allocates is not what a read holds.
    let markdownLength = under(storage, "a").markdown(base).length;

    // Beside the Markdown, a string a run and its place.
    let markdown = measured("a", nth(PAGES, isPage), store => void store.markdown(base));
    expect(markdown).toMatchObject({ seen: 1, pages: PAGES, content: RUNS });
    expect(markdown.bytes).toBeLessThanOrEqual(markdownLength + 57 * RUNS);
  });

  it("a read after a change of digest keys the version a page of rows at a time", () => {
    // Keyed a page a statement, then read: at the last page, a page of rows and no whole list.
    let { base } = kept();
    let keyed = measured(`b${++digests}`, nth(PAGES, isPage), store => void store.summary(base));
    expect(keyed).toMatchObject({
      seen: 1, pages: 2 * PAGES, joined: PAGES, runsDecoded: RUNS, runsRendered: RUNS,
    });
    expect(keyed.bytes).toBeLessThanOrEqual(16 * RUNS);
  });
});
