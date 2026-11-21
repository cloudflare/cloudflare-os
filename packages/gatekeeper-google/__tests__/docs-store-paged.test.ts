// What a read of a stored tab, and a keying of its version under another digest, ask of storage:
// its list a page at a time, a page's lists by one statement, no content table scanned. Mocks the
// renderer's carry functions and `renderRun` to count them.

import { describe, expect, it, vi } from "vitest";
import type { GoogleDocsTab } from "../src/docs-api";
import { docEditResult, type DocEdit } from "../src/docs-replay";
import { DOC_COPY_UNREADABLE, pruneTab } from "../src/docs-replica";
import { decodeRun, RUN_SIZES, type RunSizes } from "../src/docs-runs";
import { DocStore, type DocPending, type DocVersion } from "../src/docs-store";
import { docTabToMarkdown, namedListIds } from "../src/markdown-converter";
import { fakeDocStorage, type FakeDocStorage } from "./doc-store-fake";
import {
  countedStorage, keptUnder, listedProseTab, listedTablesTab, listRunsTab, RUNS_OF_THREE, scenarioTab,
  spent, tableScans, under, wholeTabsFetched,
} from "./doc-store-scenarios";
import { fuzzedTabs, recordedTabs, summaryOf, throughJson } from "./render-run-tabs";

/** How many carries the store made, and how many runs it moved one past. */
const carries = vi.hoisted(() => ({ advances: 0, made: 0 }));
/** Where the first element of each run the store rendered ends in its tab; a test empties it. */
const renderedTo = vi.hoisted((): number[] => []);

// Plain counters and no spy: a spy keeps every call's arguments.
vi.mock("../src/markdown-converter", async importOriginal => {
  let converter = await importOriginal<typeof import("../src/markdown-converter")>();
  let initialCarry: typeof converter.initialCarry = () => {
    carries.made++;
    return converter.initialCarry();
  };
  let advanceCarry: typeof converter.advanceCarry = (carry, summary) => {
    carries.advances++;
    converter.advanceCarry(carry, summary);
  };
  let renderRun: typeof converter.renderRun = (elements, ...rest) => {
    renderedTo.push(elements[0]?.endIndex);
    return converter.renderRun(elements, ...rest);
  };
  return { ...converter, initialCarry, advanceCarry, renderRun };
});

const DOC = "doc";
const NONE: DocPending = { edits: [], roots: [] };

/** 1,201 runs, three pages of the version's list, and 600 lists, each named by one table. */
const LISTED = listedTablesTab("t1", 600);
/** The runs of `LISTED`, and the place of its n-th table: a run whose rendering no other run shares. */
const RUNS = 1_201;
const table = (at: number) => 2 * at + 1;

/** An edit that types in the first table's cell. */
const EDIT: DocEdit = { type: "replaceText", oldMarkdown: "cell 0", newMarkdown: "cell zero", inTable: true };

const LISTS = "json_each(doc_run.json, '$.lists')";
const TOTALS = "SELECT COUNT(*) AS runs";

/** `LISTED` kept under the digest `a`, in a storage of its own. */
const kept = () => keptUnder(fakeDocStorage(), LISTED, "a");

/**
 * Removes the rendering of the run at each of `places` of `version`'s list: a row for each
 * key those places hold, since runs of the same content under the same keys share one.
 */
function lose(storage: FakeDocStorage, version: DocVersion, ...places: number[]): void {
  let keys = `SELECT run, context, carry FROM doc_seq
    WHERE version = ?1 AND seq IN (SELECT value FROM json_each(?2))`;
  let at = [version.id, JSON.stringify(places)];
  let listed = storage.sql.exec(keys, ...at).toArray();
  expect(listed, `places ${places.join(", ")} of the list`).toHaveLength(places.length);
  let { rowsWritten } = storage.sql.exec(
    `DELETE FROM doc_md WHERE (run, context, carry) IN (${keys})`, ...at);
  expect(rowsWritten, `the renderings at places ${places.join(", ")}`)
    .toBe(new Set(listed.map(key => JSON.stringify(key))).size);
}

/**
 * What `call` costs a store of the digest `digest` over `storage`: the store's counters, the
 * statements by kind, the carries made and moved, how many statements read a version's
 * totals, and the most text of definitions one statement answered.
 */
function cost(storage: FakeDocStorage, digest: string, call: (store: DocStore) => unknown) {
  let totals = 0;
  let counted = countedStorage({
    sql: {
      exec: (query: string, ...bindings: unknown[]) => {
        if (query.startsWith(TOTALS)) totals++;
        return storage.sql.exec(query, ...bindings);
      },
    },
    transactionSync: callback => storage.transactionSync(callback),
  } as FakeDocStorage);
  let store = under(counted.storage, digest);
  let before = { ...carries };
  let moved = spent(counted, () => call(store));
  return {
    ...moved, totals, definitions: counted.definitions(),
    advances: carries.advances - before.advances, made: carries.made - before.made,
  };
}

describe("a stored tab's list, a page at a time", () => {
  it("plans every statement of a read, a keying and a list written over, and scans no content table", () => {
    let storage = fakeDocStorage();
    let { base } = keptUnder(storage, LISTED, "a");
    let counted = countedStorage(storage);
    let whole = docTabToMarkdown(LISTED).markdown;

    // Keyed again, read, and read with three renderings lost.
    let b = under(counted.storage, "b");
    expect(b.markdown(base)).toBe(whole);
    b.summary(base);
    lose(storage, base, table(5), table(300), table(575));
    expect(b.markdown(base)).toBe(whole);
    // The same version stored from a tab in hand, and by a fetch: its list written over.
    expect(under(counted.storage, "c").putTab(DOC, LISTED, []).id).toBe(base.id);
    let fetched = () => wholeTabsFetched(
      { revision: "r1", fetchedAt: 1_000, tabs: [{ tab: LISTED, writeMarkers: [] }] });
    under(counted.storage, "d").keep(DOC, fetched(), NONE);
    // And fetched again by a store that has keyed it: the tab's runs pass in step with its list.
    under(counted.storage, "d").keep(DOC, fetched(), NONE);

    let ran = counted.ran();
    expect(ran.length).toBeGreaterThan(25);
    // No step of any plan scans a table, under any name: the scenario sweeps nothing.
    expect(tableScans(storage, ran)).toEqual({});
    // The teeth: a scan of the content table under an alias is answered by its alias.
    let scan = "SELECT run.id FROM doc_run AS run WHERE run.json = 'x'";
    expect(tableScans(storage, [scan])).toEqual({ [scan]: ["SCAN run"] });

    // The renderings another digest made are removed by their key.
    let removed = ran.filter(statement => statement.startsWith("DELETE FROM doc_md WHERE made <>") &&
      statement.includes("IN (SELECT run, context, carry FROM doc_seq"));
    expect(removed).toHaveLength(1);
    expect(storage.plan(removed[0]).some(step => step.startsWith("SEARCH doc_md USING"))).toBe(true);
    // The lists of a page are read off its runs inside storage: the only scans are of the
    // virtual tables that step a JSON value.
    let lists = ran.filter(statement => statement.includes(LISTS));
    expect(lists).toHaveLength(1);
    let scans = storage.plan(lists[0]).filter(step => step.startsWith("SCAN"));
    expect(scans.length).toBeGreaterThan(0);
    expect(scans.filter(step => !step.includes("VIRTUAL TABLE"))).toEqual([]);
    // Content is never taken as an array.
    expect(storage.arrays().filter(statement => /^SELECT (json|md)\b/.test(statement))).toEqual([]);

    // A page of a version's list is one of three statements, and the counter of pages counts
    // those and no other statement of a keep, a keying, a read and a sweep.
    let sweeping = countedStorage(storage);
    under(sweeping.storage, "d").sweep(DOC, NONE);
    let all = [...new Set([...ran, ...sweeping.ran()])];
    let pages = all.filter(statement => /FROM doc_seq\b[^]*ORDER BY (doc_seq\.)?seq LIMIT \?/.test(statement));
    expect(pages).toHaveLength(3);
    expect(pages.toSorted()).toEqual(all.filter(statement => /\bLIMIT\b/.test(statement)).toSorted());
    expect(pages.filter(statement => statement.includes("LEFT JOIN doc_md"))).toHaveLength(2);
    // The page with no join answers no summary: `null` on every row, never `undefined`.
    let [plain] = pages.filter(statement => !statement.includes("LEFT JOIN doc_md"));
    let rows = storage.sql.exec(plain, base.id, 0, 500).toArray();
    expect(rows).toHaveLength(500);
    expect(rows.every(row => row.summary === null)).toBe(true);
  });

  it("the lists a page statement answers are the lists its runs name, decoded", () => {
    type Cut = readonly [sizes: RunSizes, name: string];
    let cuts: Cut[] = [[RUN_SIZES, "the store's sizes"], [{ ...RUN_SIZES, elements: 1 }, "a run an element"]];
    let tabs: { name: string; tab: GoogleDocsTab; cuts?: Cut[] }[] = [
      ...recordedTabs(),
      ...fuzzedTabs(41, 60).filter(({ tab }) => namedListIds(tab.body.content).length > 0),
      { name: "runs that each name a dozen lists", tab: listRunsTab("t1", 6) },
      { name: "tables that each name a list", tab: listedTablesTab("t1", 40) },
      // Three pages of runs that each name a list of their own: lists at a page's edges.
      {
        name: "items that are each a run and a list", tab: listedProseTab("t1", 1_200),
        cuts: [[{ ...RUNS_OF_THREE, elements: 1 }, "a run an element"]],
      },
    ];
    let corpus = tabs.map(entry => ({ ...entry, tab: pruneTab(throughJson(entry.tab)) }));
    let inCell = 0, undefinedList = 0, statements = 0, pastTheFirstPage = 0;

    for (let { name, tab, cuts: cutTo = cuts } of corpus) {
      let named = namedListIds(tab.body.content);
      if (named.some(id => !Object.hasOwn(tab.lists, id))) undefinedList++;
      if (named.some(id => !namedListIds(tab.body.content.filter(element => !element.table)).includes(id))) inCell++;
      for (let [sizes, cut] of cutTo) {
        let where = `${name}, ${cut}`;
        let storage = fakeDocStorage();
        let { base } = keptUnder(storage, tab, "a", sizes);
        // Each statement that loads lists, with its bindings and the ids it answered.
        let asked: { bindings: unknown[]; ids: string[] }[] = [];
        let b = under({
          sql: {
            exec: (query: string, ...bindings: unknown[]) => {
              let cursor = storage.sql.exec(query, ...bindings);
              if (!query.includes(LISTS)) return cursor;
              return {
                ...cursor,
                toArray: () => {
                  let rows = cursor.toArray();
                  asked.push({ bindings, ids: rows.map(row => String(row.id)) });
                  return rows;
                },
              };
            },
          },
          transactionSync: callback => storage.transactionSync(callback),
        } as FakeDocStorage, "b", sizes);

        expect(b.markdown(base), where).toBe(docTabToMarkdown(tab).markdown);

        let runs = storage.sql.exec<{ runs: number }>(
          "SELECT COUNT(*) AS runs FROM doc_seq WHERE version = ?", base.id).one().runs;
        // One statement a page of the list, for the places of that page in the version's
        // document: every run is rendered at a keying.
        expect(asked.map(({ bindings }) => bindings.slice(2)), where).toEqual(
          Array.from({ length: Math.ceil(runs / 500) }, (_, page) => [page * 500, page * 500 + 500, base.doc]));
        for (let { bindings, ids } of asked) {
          let [, version, from, to] = bindings;
          expect(version, where).toBe(base.id);
          if (Number(from) > 0 && ids.length > 0) pastTheFirstPage++;
          let stored = storage.sql.exec<{ json: string }>(
            `SELECT doc_run.json FROM doc_seq JOIN doc_run ON doc_run.doc = ?4 AND doc_run.id = doc_seq.run
             WHERE doc_seq.version = ?1 AND doc_seq.seq >= ?2 AND doc_seq.seq < ?3 ORDER BY doc_seq.seq`,
            base.id, from, to, base.doc).toArray();
          let decoded = new Set(stored.flatMap(({ json }) =>
            namedListIds(decodeRun(json, { first: 0, footnotes: 0, exact: false })!.elements)));
          expect(ids.toSorted(), where)
            .toEqual([...decoded].filter(id => Object.hasOwn(tab.lists, id)).toSorted());
          statements++;
        }
      }
    }

    // The corpus has its teeth: lists named in cells, and lists a tab names and does not define.
    expect(inCell).toBeGreaterThan(0);
    expect(undefinedList).toBeGreaterThan(0);
    expect(statements).toBeGreaterThanOrEqual(2 * corpus.length);
    // And a page after the first whose runs name lists: the three-page tab's second and third.
    expect(pastTheFirstPage).toBeGreaterThanOrEqual(2);
  });

  it("renders a first run alone at the tab's own first index", () => {
    let tabs = fuzzedTabs(41, 60).map(({ name, tab }) => ({ name, tab: pruneTab(throughJson(tab)) }));
    let startsLate = 0, showsItsIndex = 0;

    // FETCHED TABS, the first run's rendering lost.
    for (let { name, tab } of tabs) {
      let storage = fakeDocStorage();
      let { base, counted } = keptUnder(storage, tab, "a", RUNS_OF_THREE);
      let whole = docTabToMarkdown(tab).markdown;
      let read = () => spent(counted, () =>
        expect(under(counted.storage, "a", RUNS_OF_THREE).markdown(base), name).toBe(whole));
      lose(storage, base, 0);

      // That run alone: one rendered under another key would have the version keyed again.
      expect(read(), name).toMatchObject({ runsDecoded: 1, runsRendered: 1 });
      // And the row it wrote back is the run's: read again, with nothing missing.
      expect(read(), name).toMatchObject({ runsDecoded: 0, runsRendered: 0 });

      let [first] = tab.body.content;
      if (first.startIndex > 0) startsLate++;
      // A section break is written everywhere but at index 0, so a run decoded from 0 loses one
      // that starts a body not at 0.
      if (first.sectionBreak && first.startIndex > 0) showsItsIndex++;
    }
    expect(startsLate).toBeGreaterThanOrEqual(10);
    expect(showsItsIndex).toBeGreaterThan(0);

    // A VERSION THE MODEL MADE, starting at 0: its opening break is stored with no index and
    // takes the one its run is decoded at.
    let tab = listedTablesTab("t1", 4);
    let storage = fakeDocStorage();
    let { base, counted, store } = keptUnder(storage, tab, "a");
    let made = docEditResult(store, base, EDIT).after;
    let whole = docTabToMarkdown(tab).markdown.replace("cell 0", "cell zero");
    expect(made.exact).toBe(true);
    expect(tab.body.content[0]).toEqual({ endIndex: 1, sectionBreak: {} });
    lose(storage, made, 0);
    let alone = spent(counted, () => expect(under(counted.storage, "a").markdown(made)).toBe(whole));
    expect(alone).toMatchObject({ runsDecoded: 1, runsRendered: 1 });
    // And keyed again from its runs by another digest, from the same index.
    expect(under(storage, "b").markdown(made)).toBe(whole);
  });

  it("renders a run alone past the first at the index the sizes of the runs before it give", () => {
    // A run an element, so where a run was decoded shows in where its first element ends. The
    // run lost is a section break past the first element, which a decode from index 0 would
    // write wrong under the key the list names.
    let sizes = { ...RUNS_OF_THREE, elements: 1 };
    let tabs = [...fuzzedTabs(41, 60), ...recordedTabs()]
      .map(({ name, tab }) => ({ name, tab: pruneTab(throughJson(tab)) }));
    let fromZero = 0;

    for (let { name, tab } of tabs) {
      let { content } = tab.body;
      let places = content.flatMap((element, at) => at > 0 && element.sectionBreak ? [at] : []);
      if (places.length === 0) continue;
      if (!(content[0].startIndex > 0)) fromZero += places.length;
      let storage = fakeDocStorage();
      let { base } = keptUnder(storage, tab, "a", sizes);
      expect(storage.sql.exec("SELECT COUNT(*) AS runs FROM doc_seq WHERE version = ?", base.id).one(), name)
        .toEqual({ runs: content.length });
      let whole = docTabToMarkdown(tab).markdown;
      let ends = (at: readonly number[]) => at.map(place => content[place].endIndex);
      // Section breaks of the same content share a rendering, so a loss renders breaks and the
      // first run alone: never every run, as a keying again does.
      let sharing = ends([0, ...places]);
      expect(sharing.length, name).toBeLessThan(content.length);
      // With the renderings at `lost` removed, each run rendered was decoded where it stands.
      let readWithout = (...lost: number[]) => {
        let where = `${name}, places ${lost.join(" and ")}`;
        lose(storage, base, ...lost);
        renderedTo.length = 0;
        expect(under(storage, "a", sizes).markdown(base), where).toBe(whole);
        expect(renderedTo, where).toEqual(expect.arrayContaining(ends(lost)));
        expect(sharing, where).toEqual(expect.arrayContaining(renderedTo));
      };

      for (let place of places) {
        // The break alone: its index comes from the tab's first and the sizes of the runs before.
        readWithout(place);
        // And with the first run: the walk moves the index from the tab's first.
        readWithout(0, place);
      }
    }
    expect(fromZero).toBeGreaterThanOrEqual(20);
  });

  it("renders a run alone past the first page with the carry of the runs before it", () => {
    // 1,201 runs over three pages, paragraph n at place n: items of one numbered list but for
    // every tenth place and the first 50, 100 and 150 places of the three pages, so no two pages
    // hold the same count of items at a place. Such an item's carry key holds that count.
    let made = scenarioTab("t1", [], Array.from({ length: 1_200 }, (_, at) => `Paragraph ${at + 1}`));
    for (let [place, element] of made.body.content.entries()) {
      let opensPage = place % 500 < 50 * (1 + Math.floor(place / 500));
      if (opensPage || place % 10 === 0) delete element.paragraph?.bullet;
    }
    let tab = pruneTab(throughJson(made));
    let sizes = { ...RUNS_OF_THREE, elements: 1 };
    let storage = fakeDocStorage();
    let { base, counted } = keptUnder(storage, tab, "a", sizes);
    expect(storage.sql.exec("SELECT COUNT(*) AS runs FROM doc_seq WHERE version = ?", base.id).one())
      .toEqual({ runs: 1_201 });
    let whole = docTabToMarkdown(tab).markdown;
    let read = () => spent(counted, () =>
      expect(under(counted.storage, "a", sizes).markdown(base)).toBe(whole));

    // An item of the second page and one of the third, each after a paragraph outside the list:
    // a state made from another page's summaries would differ by the count alone.
    expect(whole).toContain("\n496. Paragraph 701\n");
    expect(whole).toContain("\n793. Paragraph 1181\n");

    // The state at the first is made from the 701 runs' summaries before it, and the walk moves
    // it on to the other. Those two runs alone: a wrong count would key the version again.
    lose(storage, base, 701, 1_181);
    expect(read()).toMatchObject({ runsDecoded: 2, runsRendered: 2, pages: 3 + 2 });
    // The third page's alone: its state is made from all three pages read again.
    lose(storage, base, 1_181);
    expect(read()).toMatchObject({ runsDecoded: 1, runsRendered: 1, pages: 3 + 3 });
    // And the rows written back are the runs': read again, with nothing missing.
    expect(read()).toMatchObject({ runsDecoded: 0, runsRendered: 0, pages: 3 });
  });

  it("a run that is not JSON names no list and is unreadable where it is decoded", () => {
    let { storage, base } = kept();
    storage.sql.exec(
      "UPDATE doc_run SET json = 'not a run' WHERE id = (SELECT run FROM doc_seq WHERE version = ? AND seq = ?)",
      base.id, table(300));
    let b = under(storage, "b");

    // The copy's fault, as a missing row is, and not an error of storage.
    expect(() => b.markdown(base)).toThrow(new Error(DOC_COPY_UNREADABLE));
    expect(b.head(DOC)).toBeUndefined();
  });
});

// What each read costs on `LISTED`, by the statements it runs over the tab's context: a number
// of pages or a constant, never a number of runs. An edit's are in `docs-edit-counts.test.ts`.
const PAGED_COUNTS = {
  // A version keyed under another digest: every run decoded and rendered once, three unjoined
  // pages, the lists once a page, the styles once; then read (three joined pages).
  keyedAgain: { lists: 3, styles: 1, runsDecoded: RUNS, runsRendered: RUNS, pages: 3 + 3, joined: 3 },
  // Every rendering stored: the pages and a rendering by key a run; no carry, no totals read.
  pendingRead: {
    lists: 0, styles: 0, runsDecoded: 0, runsRendered: 0, pages: 3, joined: 3, content: RUNS,
    totals: 0, advances: 0, made: 0,
  },
  summaryRead: {
    lists: 0, styles: 0, runsDecoded: 0, runsRendered: 0, pages: 3, joined: 3, content: 0,
    totals: 0, advances: 0, made: 0,
  },
  // One rendering lost a page: each rendered alone with its page's lists. The state at the first
  // takes one page read again; a carry moves over the 11 runs before it, then the 1,190 after.
  lostRenderings: {
    lists: 3, styles: 1, runsDecoded: 3, runsRendered: 3, pages: 3 + 1, totals: 1,
    advances: 11 + 1_190, made: 1, content: 3,
  },
  // The three in one page, the second: one statement for their lists, two pages read again.
  lostInOnePage: { lists: 1, styles: 1, runsDecoded: 3, runsRendered: 3, pages: 3 + 2, totals: 1, made: 1 },
  // The first run's: no page is read again for place 0.
  lostFirst: { lists: 1, styles: 1, runsDecoded: 1, runsRendered: 1, pages: 3, totals: 1, made: 1 },
  // A rendering whose Markdown does not read back, in the second page: rendered alone.
  markdownUnreadable: {
    lists: 1, styles: 1, runsDecoded: 1, runsRendered: 1, pages: 3 + 2, totals: 1, made: 1,
  },
};

describe("the statements over a stored tab's context", () => {
  it("counts the statements over a context: one a page, never one a run", () => {
    let whole = docTabToMarkdown(LISTED).markdown;
    let measured: Record<string, object> = {};

    let { storage, base } = kept();
    let keyedAgain = cost(storage, "b", b => expect(b.markdown(base)).toBe(whole));
    // 250 definitions of 254 characters: the share of a page of 500 runs, on this shape.
    expect(keyedAgain.definitions).toBeGreaterThan(0);
    expect(keyedAgain.definitions).toBeLessThanOrEqual(250 * 300);
    measured.keyedAgain = keyedAgain;
    measured.pendingRead = cost(storage, "b", b => expect(b.markdown(base)).toBe(whole));
    let summary = under(storage, "b").summary(base);
    measured.summaryRead = cost(storage, "b", b => expect(b.summary(base)).toEqual(summary));

    lose(storage, base, table(5), table(300), table(575));
    measured.lostRenderings = cost(storage, "b", b => expect(b.summary(base)).toEqual(summary));
    lose(storage, base, table(300), table(305), table(310));
    measured.lostInOnePage = cost(storage, "b", b => expect(b.summary(base)).toEqual(summary));
    lose(storage, base, 0);
    measured.lostFirst = cost(storage, "b", b => expect(b.summary(base)).toEqual(summary));

    storage.sql.exec(
      `UPDATE doc_md SET md = '\u0001not the JSON of a string' WHERE (run, context, carry) IN
         (SELECT run, context, carry FROM doc_seq WHERE version = ? AND seq = ?)`, base.id, table(350));
    measured.markdownUnreadable = cost(storage, "b", b => expect(b.markdown(base)).toBe(whole));
    expect(under(storage, "b").markdown(base)).toBe(whole);

    expect(measured).toMatchObject(PAGED_COUNTS);
  });

  it("summarises a version of three pages as its tab rendered whole", () => {
    let { storage, base } = kept();
    let expected = summaryOf(docTabToMarkdown(LISTED));

    // The fold moves each table's place across the page boundaries at 500 and 1,000.
    expect(expected.tables).toHaveLength(600);
    expect(under(storage, "b").summary(base)).toEqual(expected);
    expect(under(storage, "b").summary(base)).toEqual(expected);
  });
});
