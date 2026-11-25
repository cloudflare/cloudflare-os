import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DOC_COPY_EXPIRY_PASS_KEY, DRIVE_DOC_COPY_EXPIRY_MS, DriveDocCopyLimits } from "../../src/docs-copy";
import { DOC_COPY_UNREADABLE } from "../../src/docs-replica";
import { RUN_SIZES } from "../../src/docs-runs";
import {
  DOC_ROW_BYTES, DocRowTooLargeError, DocStore, docStoreCost, heldDoc, runId, type DocPending,
  type HeldDoc,
} from "../../src/docs-store";
import { docTabToMarkdown } from "../../src/markdown-converter";
import {
  ANOTHER_DIGEST_SCENARIO, CAP_COST, CAP_COST_PAIRS, CAP_ROWS, capCostScenario, cardRowsScenario,
  countedStorage, DRIVE_READ_SCENARIO, driveReadScenario,
  EDIT_COUNTS,
  editCountsScenario,
  EXPIRY_COST, EXPIRY_COST_PAIRS, EXPIRY_PROSE_DROP, EXPIRY_ROWS, expiryCostScenario,
  FETCH_ATOMIC_SCENARIO, fetchAtomicScenario, fetchCounts, keptUnder, keyingRows, largeTabLife,
  scenarioBase, scenarioCopy, scenarioDocument, scenarioEdit, scenarioTab, STORE_SCENARIO,
  SWEEP_COST, SWEEP_COST_PAIRS, SWEEP_ROWS, sweepCostScenario, tableCounts, tinyTablesTab,
  type CapCase, type ExpiryCase, type StepCost, type SweepCase,
} from "../doc-store-scenarios";
import { WIDER } from "../wider-run";
import { withDocStore } from "./doc-store-host";

/** What a step of a tab's life moved of the store's counters. */
const stepCost = (
  rowsWritten: number, runsDecoded: number, runsRendered: number, runsKeyed: number,
): StepCost => ({ rowsWritten, runsDecoded, runsRendered, runsKeyed });

/** The UTF-16 code units of `text`, in hex: a test's message cannot print half of a surrogate pair. */
const units = (text: string) => Array.from(text, unit => unit.charCodeAt(0).toString(16));

describe("runId in the worker", () => {
  it("hashes synchronously with node:crypto", async () => {
    expect(runId("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");

    // Latin-1, CJK and an astral character: two, three and four bytes of UTF-8.
    const json = JSON.stringify({ latin: "café", cjk: "文書", astral: "\u{1F600}" });
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(json));
    const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    expect(runId(json)).toBe(hex);
  });
});

// What only a Durable Object's real storage shows of the Doc store: the rows it bills, the size
// one row takes, and the statements of a sweep on the SQLite the worker runs.
describe("DocStore on a Durable Object's storage", () => {
  const NONE: DocPending = { edits: [], roots: [] };
  const EMPTY = { doc_copy: 0, doc_md: 0, doc_result: 0, doc_run: 0, doc_seq: 0, doc_version: 0 };
  const TABS = () => [scenarioTab("t1", ["One", "Two"]), scenarioTab("t2", ["Notes"])];
  // The rows `run` wrote, as storage bills them.
  const written = (run: () => unknown): number => {
    const before = docStoreCost.rowsWritten;
    run();
    return docStoreCost.rowsWritten - before;
  };

  it("gives on real storage what it gives on the fake", async () => {
    const host = env.DOC_STORE_HOST.getByName("scenario");

    expect(await host.scenario("store")).toEqual(STORE_SCENARIO);
    expect(await host.holds("doc")).toBe(true);
  });

  it("serves nothing another digest derived and keeps the fetched rows", async () => {
    const host = env.DOC_STORE_HOST.getByName("another-digest");

    expect(await host.scenario("anotherDigest")).toEqual(ANOTHER_DIGEST_SCENARIO);
  });

  it("writes the rows it says", async () => {
    const rows = await withDocStore(store => {
      const copy = scenarioCopy(TABS());
      const keep = written(() => store.keep("doc", copy, NONE));
      const again = written(() => store.keep("doc", { ...copy, fetchedAt: 2_000 }, NONE));
      const base = scenarioBase(store, "doc", store.head("doc")!);
      const firstRead = written(() => store.markdown(base));
      const secondRead = written(() => store.markdown(base));
      const edit = written(() => scenarioEdit(store, base, "e1"));
      const trial = written(() =>
        store.trial("doc", copy, () => ({ edits: ["e1"], roots: [] }), head => store.markdown(scenarioBase(store, "doc", head))));
      return { keep, again, firstRead, secondRead, edit, trial };
    });

    expect(rows).toEqual(ROWS_WRITTEN);
  });

  // An edit and a changed fetch write the runs near the change and a list, whatever the tab's
  // length.
  it("counts what each step of a large tab's life writes, decodes, renders and keys", async () => {
    const life = await withDocStore((store, storage) => largeTabLife(store, storage));

    const { n, c, m } = life;
    expect({ n, c, m, fetched: life.fetched }).toEqual({ n: 133, c: 1, m: 133, fetched: { c: 1, m: 133 } });
    expect(life).toMatchObject(LARGE_TAB_COSTS);
    // n runs, c replaced, m after. A row written is billed twice (with its index's row); A ROW
    // REMOVED IS BILLED ONCE.
    expect(life.keep).toEqual(stepCost(5 * n + 4, 0, n, 0));
    expect(life.read).toEqual(stepCost(0, 0, 0, 0));
    expect(life.edit).toEqual(stepCost(4 * c + m + 3, 1, 1 + c, 0));
    expect(life.pendingRead).toEqual(stepCost(0, 0, 0, 0));
    expect(life.rejection).toEqual(stepCost(2 * c + m + 2, 0, 0, 0));
    expect(life.baseRead).toEqual(stepCost(0, 0, 0, 0));
    expect(life.editAgain).toEqual(life.edit);
    expect(life.approval).toEqual(stepCost(2 * c + m + 2 + 1, 0, 0, 0));
    expect(life.refetch).toEqual(stepCost((4 * c + m + 2) + (2 * c + n + 1), 0, c, 1));
    expect(life.unchanged).toEqual(stepCost(1, 0, 0, 0));
  });

  describe("an edit made in the runs its batch touches", () => {
    let answered: Promise<ReturnType<typeof editCountsScenario>> | undefined;
    /** The scenario, run once on real storage by the first test that reads it. */
    const scenario = () => answered ??= withDocStore((_, storage) => editCountsScenario(storage));

    it("makes each edit in the runs its batch touches, on real storage", async () => {
      const counts = await scenario();

      expect(counts.cases).toMatchObject(EDIT_COUNTS);
      expect(Object.keys(counts.cases).toSorted()).toEqual(Object.keys(EDIT_COUNTS).toSorted());
      for (const [name, cost] of Object.entries(counts.cases)) {
        // One run's JSON in hand at a time; the paragraph typed 100,000 characters into is its own run.
        expect(cost.peak, name).toBeLessThanOrEqual(
          name === "longInsertion" ? 2 * (100_000 + 300) : 2 * RUN_SIZES.most);
      }
    });

    // Rows read as billed, for n runs, N JSON values, L lists and an edit at place p whose list
    // is walked over q rows: an edit reads rows of the list and no value of its tab's runs.
    it("counts the rows an edit, a pending read and a first edit after a deploy read", async () => {
      const { cases, tabs } = await scenario();
      const read = (name: string) => cases[name].rowsRead;
      const wrote = (name: string) => cases[name].rowsWritten;
      const walked = (runs: number, place: number) => Math.min(runs, 500 * Math.ceil((place + 2) / 500));
      {
        // THE TAB OF LINES, which defines no list.
        const { runs: n, lists: L, largestRun } = tabs.lines;
        const p = cases.middle.at!.place, q = walked(n, p);
        expect([n, L, p]).toEqual([138, 0, 48]);
        // A PENDING READ (Markdown, then summary): each call's joined page (2n) and each run's
        // Markdown (n).
        expect(read("pendingRead")).toEqual(5 * n + 4);
        expect(wrote("pendingRead")).toEqual(0);
        // AN EDIT OF ONE PARAGRAPH. The scan: every joined page and Markdown, to rule out a second
        // place.
        const scan = 3 * n;
        // The pass that places its piece: the joined pages to the piece's run (2q).
        const placed = 2 * q;
        // The piece: the totals (n), the joined pages to its run (2q), the list on to the page's
        // end.
        const piece = n + 2 * q + (n - p);
        // The slice (n + 2q, its run the piece's) and its version (totals, sizes before p, the
        // parent's names, the child's list read as written). NO VALUE OF A RUN IS READ.
        const made = n + 2 * q + n + p + n + 2 * n;
        expect(read("middle")).toEqual(scan + placed + piece + made + 13);
        expect(read("middle")).toEqual(10 * n + 6 * q + 13);
        // WRITTEN: its run, rendering and result (2 each), the child's list (n) and record.
        const edit = n + 7;
        expect(wrote("middle")).toEqual(edit);
        // Fewer than the values of one run: it would pass them if the slice's run were stepped.
        expect(read("middle")).toBeLessThan(largestRun);
        // A PIECE OF MORE RUNS reads each run it adds, found and read (2 a run).
        expect(read("growingBeforeTable")).toEqual(read("middle") + 2 * 2);
        expect(read("lastShorter")).toEqual(read("middle") + 2);
        expect(read("lastLonger")).toEqual(read("middle") + 2);
        // A PIECE MADE IN TWO PASSES (the closure starts in the run before): one more from p - 1.
        const second = n + 2 * q + (n - (p - 1)) + 2 * 2 + 3;
        expect(read("firstParagraph")).toEqual(read("middle") + second);
        expect(read("runStart")).toEqual(read("middle") + second);
        // AN APPEND: no scan; the blank check (2q) and the pass to the tab's end (2n).
        expect(read("append")).toEqual(11 * n + 4 * q + 12);
        expect(wrote("append")).toEqual(edit);
        // A TABLE CHANGE: a pass over the joined pages for the recorded table (2n), another for the
        // cells when it adds some (2n), the pass placing its piece (2q), and the piece's passes.
        const pass = (place: number, runs: number) => n + 2 * q + (n - place) + 2 * runs + 3;
        // The slice and its version, as an edit of one paragraph has them.
        const stored = (place: number) => 5 * n + 2 * q + place;
        const pt = cases.cellStyle.at!.place;
        expect(walked(n, pt)).toEqual(q);
        // A look change: tried from the table's run (1 run), made from the run before (3 runs).
        const look = 2 * n + 2 * q + pass(pt, 1) + pass(pt - 1, 3) + stored(pt) + 9;
        expect(read("cellStyle")).toEqual(look);
        expect(read("cellStyle")).toEqual(11 * n + 8 * q - pt + 24);
        expect(wrote("cellStyle")).toEqual(edit);
        // A row added: the cells' pass besides; with text in its cells, or a column, one row more.
        expect(read("rowNoText")).toEqual(look + 2 * n);
        expect(read("rowWithText")).toEqual(look + 2 * n + 1);
        expect(read("columnWithText")).toEqual(look + 2 * n + 1);
        // A NEW TABLE AT THE TAB'S END: cells (2n), the pass to the end (2n), the list two rows
        // longer.
        const end = n - 1;
        expect(read("tableFilled")).toEqual(2 * n + 2 * n + pass(end, 1) + stored(end) + 2 * 2 + 7);
        // A NEW TABLE AFTER A PARAGRAPH: cells (2n), the scan (3n), then that paragraph's edit.
        expect(read("tableAfterParagraph")).toEqual(
          2 * n + 3 * n + 2 * q + pass(p, 1) + stored(p) + 2 * 2 + 7);
        expect(wrote("tableAfterParagraph")).toEqual(edit + 2 * 5);
        // THE FIRST EDIT AFTER A DEPLOY: whether the model follows the tab (4n), the keying (10n),
        // the edit.
        expect(read("afterDeploy")).toEqual(read("middle") + 14 * n + 25);
        // WRITTEN: the answer's record, the keying (renderings in place, the list, the record), the
        // edit.
        expect(wrote("afterDeploy")).toEqual(1 + (2 * n + 1) + edit);
      }
      {
        // THE TAB OF A LIST A TABLE: the terms in the runs' values and in the context's lists.
        const { runs: n, pages: P, nodes: N, firstPage: N0, lists: L } = tabs.listed;
        const { place: p, named: i } = cases.listedMiddle.at!;
        const q = walked(n, p);
        expect([n, P, L, p, i, q]).toEqual([601, 2, 300, 299, 1, 500]);
        // THE PIECE AROUND A TABLE: five passes of 1, 2, 3, 5 and 9 runs. Each reads its page's
        // lists in one statement: 2 * 500 rows, a row a value of the page's runs (N0) and a row a
        // list (L). THE COST OF A PASS IS ITS PAGE'S, NOT ITS RUNS'.
        const passes = 5, rendered = 1 + 2 + 3 + 5 + 9;
        const lists = 2 * 500 + N0 + L;
        const fromPlaces = passes * (n - p) + (0 + 1 + 2 + 4 + 4);
        const piece = 2 * q + passes * (n + 2 * q + lists) + fromPlaces + 2 * rendered;
        expect(read("listedPiece")).toEqual(piece + 31);
        expect(wrote("listedPiece")).toEqual(0);
        // AN EDIT OF ONE CELL: the scan, that piece, the slice and its version, the lists stepped
        // twice (2L) and the one id asked for (i).
        expect(read("listedMiddle")).toEqual(
          3 * n + read("listedPiece") + (5 * n + 2 * q + p + 2 * L + i) + 13);
        // WRITTEN as on the tab of lines: the batch makes no list.
        const edit = n + 7;
        expect(wrote("listedMiddle")).toEqual(edit);
        // THE FIRST EDIT AFTER A DEPLOY reads every run's values and each page's lists once more,
        // to key.
        expect(read("listedAfterDeploy")).toEqual(read("listedMiddle") + N + L * P + 8_987);
        // WRITTEN: of the keying's d distinct renderings, the f in its first 500 runs are written
        // in place (1 each) and the rest removed and written (3 each).
        const d = L + 2, f = 250 + 2;
        expect(wrote("listedAfterDeploy")).toEqual(1 + (f + 3 * (d - f) + n + 1) + edit);
      }

      {
        // THE SHAPE OF MANY RUNS (a table and an empty paragraph in turn): a row added to the
        // hundredth table reads NO VALUE OF A RUN; the walks of the list are the cost.
        const { runs: n, lists: L } = tabs.tables;
        const p = cases.rowManyRuns.at!.place, q = walked(n, p);
        expect([n, L, p, q]).toEqual([401, 0, 199, 401]);
        const pass = (place: number, runs: number) => n + 2 * q + (n - place) + 2 * runs + 3;
        const piece = pass(p, 1) + pass(p - 1, 2) + pass(p - 2, 3) + pass(p - 4, 5) + pass(p - 4, 9);
        expect(read("rowManyRuns")).toEqual(2 * n + 2 * n + 2 * q + piece + (5 * n + 2 * q + p) + 9);
        expect(read("rowManyRuns")).toEqual(19 * n + 14 * q - 4 * p + 75);
        expect(wrote("rowManyRuns")).toEqual(n + 7);
      }

      // EVERY OTHER CASE reads what the list's rows cost, not the tab's content.
      const tabOf = (name: string) =>
        name === "rowManyRuns" ? tabs.tables : name.startsWith("listed") ? tabs.listed : tabs.lines;
      /** The cases that render every run of their tab: a first edit after a deploy, which keys it. */
      const RENDER_ALL = ["afterDeploy", "listedAfterDeploy"];
      /** The cases whose piece reads the lists of its page: held above, each by its formula. */
      const LISTED = ["listedPiece", "listedMiddle"];
      /** The case on the shape of many runs, held above: its walks pass a tenth of its runs' values. */
      const MANY_RUNS = ["rowManyRuns"];
      /** The edits the builders build from a piece: a replacement, an append or a table change. */
      const BUILT = [
        "middle", "growingBeforeTable", "append", "listItems", "firstParagraph", "runStart",
        "lastShorter", "lastLonger", "bulletAtRunStart", "cellStyle", "rowNoText", "rowWithText",
        "columnWithText", "tableFilled", "tableAfterParagraph", "rowManyRuns",
      ];
      const few: string[] = [];
      for (const [name, cost] of Object.entries(cases)) {
        const { runs: n, lists: L, nodes: N } = tabOf(name);
        const cut = cost.listed - cost.shared;
        if (RENDER_ALL.includes(name) || LISTED.includes(name)) continue;
        expect(cost.runsKeyed, name).toBe(0);
        // A batch by hand: a last-place edit, 8 rows a run decoded or cut, a walk a widening. A
        // built edit adds its whole-tab passes (7n) and a piece pass a run decoded (4n).
        const built = BUILT.includes(name) ? 7 * n + 4 * n * cost.runsDecoded : 0;
        expect(cost.rowsRead, name).toBeLessThanOrEqual(
          8 * n + 2 * L + 14 + 8 * (cost.runsDecoded + cut) + cost.viewWidenings * (3 * n + 2 * L + 8) +
          built);
        // It reads no row a value of its tab's runs.
        if (cost.rowsRead < N / 10) few.push(name);
      }
      expect(Object.keys(cases).filter(name => !few.includes(name)).toSorted())
        .toEqual([...RENDER_ALL, ...LISTED, ...MANY_RUNS].toSorted());
    });
  });

  // Rows a card reads: `DocStore.changed` steps to the first and last difference, nothing
  // between; `changedMarkdown` adds the summaries before `from` and each reader's pages.
  it("counts the rows a preparation's card reads", async () => {
    const { rowAdded, nested } = await withDocStore((_, storage) => cardRowsScenario(storage));
    const compared = ({ before, after, changed }: typeof rowAdded) =>
      before + after + 2 * (changed.from + 1) + 2 * (before - changed.beforeTo + 1);
    {
      // A ROW ADDED TO A TABLE in 2,000 lines: only the table's run is listed anew.
      const { before: nb, after: na, changed, card } = rowAdded;
      expect([nb, na, changed]).toEqual([21, 21, { from: 9, beforeTo: 10, afterTo: 10 }]);
      expect(rowAdded.compared).toEqual({ rowsRead: compared(rowAdded) + 1, all: 4 });
      // Six readers of one 8-run page each, two forwards and two backwards, and one a version for
      // its string.
      expect(card).toEqual({
        pages: 1 + 6, joined: 1 + 6, content: 2 + 2 + 2 * 2, all: 4 + 2 * 7 + 8,
        rowsRead: rowAdded.compared.rowsRead + (1 + 2 * changed.from) + 6 * (1 + 2 * 8) + 8,
      });
      // Under two rows a run before `changed`, whatever the tab's length.
      expect(rowAdded.strings.mdStart).toBeGreaterThan(80_000);
    }
    {
      // THE ITEMS BEFORE AN ITEM MADE LEVEL 0: every run is listed anew, all but the last read as
      // before.
      const { before: nb, after: na, changed, card } = nested;
      expect([nb, na, changed]).toEqual([41, 44, { from: 0, beforeTo: 41, afterTo: 44 }]);
      expect(nested.compared).toEqual({ rowsRead: compared(nested) + 2, all: 4 });
      // THE PRICE OF COMPARING AS TEXT: from the front, every run listed anew is read once a
      // version (3 rows a run); the end and each string read a run.
      const front = 2 * 1 + 2 * (nb + na) + (nb + na);
      const end = 2 * (1 + 2 * 8) + 2;
      const strings = (1 + 2 * 1) + 1 + (1 + 2 * nb) + 1;
      expect(card).toEqual({
        pages: 3 + 3 + 2 + 1 + 3, joined: 12, content: (nb + na) + 2 + 2,
        all: 4 + (6 + 12) + (nb + na) + 4,
        rowsRead: nested.compared.rowsRead + front + end + strings + 4,
      });
      // The strings hold one run of each version, not the 320,000 characters alike before it.
      expect(nested.strings.mdStart).toBeGreaterThan(300_000);
      expect(nested.strings.before + nested.strings.after).toBeLessThan(4_000);
    }
  });

  it("undoes a fetch that throws part way, on real storage", async () => {
    expect(await withDocStore((_, storage) => fetchAtomicScenario(storage))).toEqual(FETCH_ATOMIC_SCENARIO);
  });

  it("leaves no row of a Drive read that is not approved, and decodes and renders it at each write", async () => {
    expect(await withDocStore((_, storage) => driveReadScenario(storage))).toEqual(DRIVE_READ_SCENARIO);
  });

  // Rows a fetch costs for n runs, c replaced and m left: a written row is billed twice, the
  // base's list is read once in pages (2n), and a changed fetch's sweep is pinned per shape.
  it.each([
    {
      // An answer of nearly 10 MiB: paragraphs of about 500 characters, each run its own.
      shape: "prose" as const, n: 330, pages: 1,
      first: (n: number) => ({ rowsWritten: 5 * n + 4, rowsRead: n + 4 }),
      changed: { first: 4_329, last: 4_330 },
    },
    {
      // 2,000 one-run tables with the same empty paragraph between: 2,002 distinct runs.
      shape: "tables" as const, n: 4_001, pages: 9,
      first: (n: number) => ({ rowsWritten: 4 * 2_002 + n + 4, rowsRead: 2 * n + 1 }),
      changed: { first: 42_057, last: 42_057 },
    },
  ])("counts the rows the fetches of a tab write and read: $shape", async ({ shape, n, pages, first, changed }) => {
    const counts = await withDocStore((_, storage) => fetchCounts(storage, shape));

    const c = 1, m = n;
    // The store is handed the document, so nothing else refuses one past the limit.
    expect(counts.answerBytes).toBeLessThanOrEqual(10 * 1024 * 1024);
    if (shape === "prose") expect(counts.answerBytes).toBeGreaterThan(9.5 * 1024 * 1024);
    expect(counts.first).toEqual({
      ...first(n), runsRendered: n, runsKeyed: 0, listStatements: 0, listRows: 0, replaced: n, runs: n,
    });
    // The changed run, its rendering, the list and record; and the removal of what the base held
    // alone.
    const written = (4 * c + m + 2) + (2 * c + n + 1);
    // Each page of the base's list is one statement, `RUN_LIST_BATCH` runs at most.
    const list = { listStatements: pages, listRows: n };
    expect(counts.changedFirst).toEqual({
      rowsWritten: written, rowsRead: 2 * n + changed.first, runsRendered: c, runsKeyed: 1,
      ...list, replaced: c, runs: m,
    });
    expect(counts.changedLast).toEqual({
      rowsWritten: written, rowsRead: 2 * n + changed.last, runsRendered: c,
      // The run after a changed one is keyed again; the last run of prose has none after it.
      runsKeyed: shape === "prose" ? 0 : 1,
      ...list, replaced: c, runs: m,
    });
    // Nothing changed: the copy's record is written; the list, each run found and ten rows are
    // read.
    expect(counts.unchanged).toEqual({
      rowsWritten: 1, rowsRead: 2 * n + n + 10, runsRendered: 0, runsKeyed: 0,
      ...list, replaced: 0, runs: n,
    });
  });

  // Rows read to key a version under another digest: the lists cost `N + L * P` (each run's
  // values once, the context once a page, never once a run), plus rows of tables.
  it("bills the lists of a page a row for every value of its runs and a row for every list of the tab", async () => {
    const keyed = await withDocStore((_, storage) => keyingRows(storage));

    const { runs, pages, nodes, lists } = keyed;
    expect({ runs, pages, lists }).toEqual({ runs: 601, pages: 2, lists: 300 });
    // The values of 601 stored runs: a term of its own size, so it cannot hide in another.
    expect(nodes).toBeGreaterThan(30 * runs);
    // A statement a page loads its lists, and one reads the named styles.
    expect(keyed.counts).toMatchObject({ lists: pages, styles: 1 });
    // Each table's rendering and two empty paragraphs': d distinct, f in the first 500 runs.
    const d = lists + 2, f = 250 + 2;
    const tables = 11 * runs + (2 * d + f) + (pages - 1) + 7;
    expect(keyed.rowsRead).toEqual(tables + pages + nodes + lists * pages);
  });

  // A context that defines no list: the lists statement reads the context's row and no run.
  it("reads no run for the lists of a tab that defines none", async () => {
    const keyed = await withDocStore((_, storage) => {
      const { base } = keptUnder(storage, tinyTablesTab("t1", 300), "a");
      const counted = countedStorage(storage);
      new DocStore(counted.storage, undefined, "b").summary(base);
      return { rowsRead: counted.rowsRead(), counts: counted.counts() };
    });

    const runs = 601, pages = 2, d = 300 + 2, f = 250 + 2;
    expect(keyed.counts).toMatchObject({ lists: pages, styles: 1, content: runs });
    expect(keyed.rowsRead).toEqual(9 * runs + (2 * d + f) + 7 + pages);
  });

  // A first read through Drive: the trial and the keep each store the document from its bytes.
  it("counts what a first read through Drive decodes, renders, writes and removes", async () => {
    const steps = await withDocStore((store, storage) => {
      const lines = Array.from({ length: 20_000 }, (_, at) => `Line ${String(at).padStart(5, "0")}.`);
      const step = (run: () => unknown) => {
        const before = { ...docStoreCost };
        run();
        return [
          docStoreCost.rowsWritten - before.rowsWritten, docStoreCost.runsRendered - before.runsRendered,
          docStoreCost.runsDecoded - before.runsDecoded,
        ];
      };
      let held!: HeldDoc;
      const hold = step(() => held = heldDoc(
        "doc", store.fetched(scenarioDocument([scenarioTab("t1", lines)]), 1_000)));
      const trial = step(() => store.trial(
        "doc", held, () => NONE, head => store.markdown(scenarioBase(store, "doc", head))));
      const emptied = tableCounts(storage);
      const keep = step(() => store.keep("doc", held, NONE));
      return { hold, trial, emptied, keep, n: tableCounts(storage).doc_seq };
    });

    const { n } = steps;
    expect(n).toBe(133);
    // Rows written, runs rendered, runs decoded.
    expect(steps.hold).toEqual([0, 0, 0]);
    // The trial writes a tab's rows, 5n + 3, and removes them, 3n + 2: a row removed is billed once.
    expect(steps.trial).toEqual([(5 * n + 3) + (3 * n + 2), n, n]);
    expect(steps.emptied).toEqual(EMPTY);
    // The keep writes them again, with the copy's record.
    expect(steps.keep).toEqual([5 * n + 4, n, n]);
  });

  // The row limit is measured in UTF-8 bytes; one element is held to a row, a tab is not.
  it("keeps a paragraph of just under 8,000,000 bytes of text outside ASCII and refuses a larger one, saying why", async () => {
    const outcome = await withDocStore((store, storage) => {
      // Every width of UTF-8: a character of two bytes, one of four, and `characters` of three.
      const tabOf = (characters: number) => scenarioTab("t1", [`é\u{1F600}${"文".repeat(characters)}`]);
      // The largest row the document holds, a run's or a rendering's.
      const largestRow = () => storage.sql.exec<{ bytes: number }>(
        `SELECT max(bytes) AS bytes FROM (
           SELECT length(CAST(run || context || carry || made || summary || md AS BLOB)) AS bytes FROM doc_md
           UNION ALL SELECT length(CAST(id || json AS BLOB)) FROM doc_run)`).one().bytes;
      // Settled on a paragraph of nearly the size: its indexes take more digits as it grows.
      const nearly = Math.floor((DOC_ROW_BYTES - 4_000) / 3);
      store.keep("nearly", scenarioCopy([tabOf(nearly)]), NONE);
      const fits = nearly + Math.floor((DOC_ROW_BYTES - largestRow()) / 3);
      store.drop("nearly");
      const under = tabOf(fits);
      const over = tabOf(fits + 1);

      const head = store.keep("under", scenarioCopy([under]), NONE);
      const underBytes = largestRow();
      const readBack = JSON.stringify(store.tab(scenarioBase(store, "under", head))) === JSON.stringify(under);
      let refusal: unknown;
      try {
        store.keep("over", scenarioCopy([over]), NONE);
      } catch (error) {
        refusal = error;
      }
      const counts = tableCounts(storage);
      // A tab of several such paragraphs' worth of text, in small paragraphs, is kept.
      const long = scenarioTab("t2", Array.from({ length: 2_500 }, (_, at) => `${at} ${"x".repeat(8_000)}`));
      const longHead = store.keep("long", scenarioCopy([long]), NONE);
      return {
        underBytes, underLength: JSON.stringify(under.body.content).length, readBack,
        refused: refusal instanceof DocRowTooLargeError
          ? { name: refusal.name, bytes: refusal.bytes, message: refusal.message }
          : String(refusal),
        overStored: store.head("over") !== undefined,
        counts,
        longLength: JSON.stringify(long.body.content).length,
        longRead: store.markdown(scenarioBase(store, "long", longHead)).length,
      };
    });

    expect(outcome.underBytes).toBeLessThanOrEqual(DOC_ROW_BYTES);
    expect(outcome.underBytes).toBeGreaterThan(DOC_ROW_BYTES - 3);
    // The string is about a third of the row's bytes long: its length says too little.
    expect(outcome.underLength).toBeLessThan(DOC_ROW_BYTES / 2.9);
    expect(outcome.readBack).toBe(true);
    // One character more is three bytes more.
    expect(outcome.refused).toEqual({
      name: "DocRowTooLargeError",
      bytes: outcome.underBytes + 3,
      message: `A paragraph of tab "t1" of this Google Doc is too large to keep a copy of: ` +
        `${outcome.underBytes + 3} bytes as stored, and one stored row holds 8000000. It cannot be ` +
        "read or edited through this connection until it is made smaller in Google Docs.",
    });
    expect(outcome.overStored).toBe(false);
    // Nothing of the larger paragraph is stored: the rows are the smaller document's.
    expect(outcome.counts).toEqual({ ...EMPTY, doc_copy: 1, doc_run: 3, doc_md: 2, doc_seq: 2, doc_version: 1 });
    expect(outcome.longLength).toBeGreaterThan(2 * DOC_ROW_BYTES);
    expect(outcome.longRead).toBeGreaterThan(2 * DOC_ROW_BYTES);
  });

  // A TEXT column is UTF-8: only the run whose Markdown holds half a surrogate pair is stored as JSON.
  it("stores a Markdown that holds half of a surrogate pair so that it reads back as rendered", async () => {
    const tab = scenarioTab("t1", ["One", "tail \ud83d end", "Three"]);
    const whole = docTabToMarkdown(tab);
    const read = await withDocStore((_, storage) => {
      // Runs of one element each: the opening break and the three paragraphs.
      const sizes = { ...RUN_SIZES, elements: 1 };
      const store = new DocStore(storage, undefined, undefined, sizes);
      const base = scenarioBase(store, "doc", store.keep("doc", scenarioCopy([tab], "r1", sizes), NONE));
      const cost = () => [docStoreCost.runsDecoded, docStoreCost.runsRendered];
      const first = store.markdown(base);
      const before = cost();
      const second = store.markdown(base);
      const rows = storage.sql.exec<{ md: string; summary: string }>(
        `SELECT doc_md.md, doc_md.summary FROM doc_seq JOIN doc_md ON doc_md.doc = ?2 AND doc_md.run = doc_seq.run
           AND doc_md.context = doc_seq.context AND doc_md.carry = doc_seq.carry
         WHERE doc_seq.version = ?1 ORDER BY doc_seq.seq`, base.id, base.doc).toArray();
      return {
        first: units(first), second: units(second),
        again: cost().map((count, at) => count - before[at]),
        marked: rows.map(row => row.md.startsWith("\u0001")),
        wellFormed: rows.every(row => row.md.isWellFormed()),
        lengths: rows.map(row => (JSON.parse(row.summary) as { markdownLength: number }).markdownLength),
        summary: store.summary(base),
      };
    });

    const rendered = units(whole.markdown);
    expect(rendered).toContain("d83d");
    expect(read.first).toEqual(rendered);
    expect(read.second).toEqual(rendered);
    // The second read decodes and renders nothing.
    expect(read.again).toEqual([0, 0]);
    // The paragraph that holds the half is the third run, and the one stored behind the mark.
    expect(read.marked).toEqual([false, false, true, false]);
    expect(read.wellFormed).toBe(true);
    // Each run's summary measures its Markdown as rendered, not as stored.
    expect(read.lengths).toEqual([0, "One\n".length, "\ntail \ud83d end\n".length, "\nThree\n".length]);
    expect(read.lengths.reduce((sum, length) => sum + length, 0)).toBe(whole.markdown.length);
    expect(read.summary).toMatchObject({
      markdownLength: whole.markdown.length, blocks: whole.sourceMap.blocks.length, blank: false,
      protectedRanges: 0, numberedItems: false, tables: [],
    });
  });

  // SQLite's JSON functions throw on a context that is not JSON: the version reads as
  // unreadable, and no error of SQLite's passes.
  it("reads a version whose context is not what was stored as unreadable, and drops the copy", async () => {
    const outcome = await withDocStore((_, storage) => ["not json", '{"lists":7}'].map(json => {
      const store = new DocStore(storage, undefined, "a");
      const base = scenarioBase(store, "doc", store.keep("doc", scenarioCopy(TABS()), NONE));
      storage.sql.exec(
        "UPDATE doc_run SET json = ? WHERE id = (SELECT context FROM doc_version WHERE id = ?)",
        json, base.id).toArray();
      // Another digest's store keys the version before it reads it: every run is rendered.
      const other = new DocStore(storage, undefined, "b");
      let message: string | undefined;
      try {
        other.markdown(base);
      } catch (error) {
        message = (error as Error).message;
      }
      return { message, dropped: other.head("doc") === undefined, counts: tableCounts(storage) };
    }));

    const unreadable = { message: DOC_COPY_UNREADABLE, dropped: true, counts: EMPTY };
    expect(outcome).toEqual([unreadable, unreadable]);
  });

  // The tables are removed and made inside one `transactionSync`, which real storage must take.
  it("makes its tables again, empty, when it is opened under another format", async () => {
    const outcome = await withDocStore((store, storage) => {
      const base = scenarioBase(store, "doc", store.keep("doc", scenarioCopy(TABS()), NONE));
      store.markdown(scenarioEdit(store, base, "e1"));
      const kept = tableCounts(storage);
      const other = new DocStore(storage, "other");
      const opened = tableCounts(storage);
      const again = scenarioBase(other, "doc", other.keep("doc", scenarioCopy(TABS()), NONE));
      return { kept, opened, read: other.markdown(again), format: storage.sql.exec("SELECT format FROM doc_format").one() };
    });

    expect(Object.values(outcome.kept).every(rows => rows > 0)).toBe(true);
    expect(outcome).toMatchObject({ opened: EMPTY, read: "One\n\nTwo\n", format: { format: "other" } });
  });

  // This is why the store never asks a write to return rows.
  it("loses a request's writes to a RETURNING cursor left unread", async () => {
    const host = env.DOC_STORE_HOST.getByName("returning-unread");
    const failure = (call: PromiseLike<unknown>) =>
      call.then(() => undefined, (error: unknown) => String(error));

    expect(await failure(host.writeReturningUnread())).toBeDefined();

    // The object the request broke is not asked again: the next one reads the same storage.
    expect(await env.DOC_STORE_HOST.getByName("returning-unread").unreadRows()).toBe(0);
  });
});

// The rows storage bills for each step of a document's life, each with its index's row.
const ROWS_WRITTEN = {
  // Two one-run tabs: runs and shared context (6), renderings (4), versions, lists and the record.
  keep: 15,
  // The same document kept again: the copy's record alone.
  again: 1,
  // The runs were rendered by the keep: a read writes nothing.
  firstRead: 0,
  secondRead: 0,
  // An edit: the run (2), its rendering (2), the version, its list and the result (2).
  edit: 8,
  // A trial of a document the stored copy holds unchanged.
  trial: 0,
};

// What each step of `largeTabLife` (20,000 paragraphs, n = 133 runs) moves of the store's
// counters; an edit and a changed fetch each replace one run (c) and leave m.
const LARGE_TAB_COSTS: Record<string, StepCost> = {
  // The first keep: runs (2n), context (2), renderings (2n), list (n), version and record.
  keep: { rowsWritten: 669, runsDecoded: 0, runsRendered: 133, runsKeyed: 0 },
  // A read of the Markdown and of the summary: stored rows, joined.
  read: { rowsWritten: 0, runsDecoded: 0, runsRendered: 0, runsKeyed: 0 },
  // An edit: run (2c), rendering (2c), list (m), version, result (2). Decoded: the piece's run,
  // which the slice takes. Rendered: that run and the run cut. Keyed: none.
  edit: { rowsWritten: 140, runsDecoded: 1, runsRendered: 2, runsKeyed: 0 },
  // A pending read of the version the edit gives.
  pendingRead: { rowsWritten: 0, runsDecoded: 0, runsRendered: 0, runsKeyed: 0 },
  // A rejection's sweep removes what the edit wrote and nothing else, each row billed once.
  rejection: { rowsWritten: 137, runsDecoded: 0, runsRendered: 0, runsKeyed: 0 },
  // The base then reads with nothing decoded or rendered.
  baseRead: { rowsWritten: 0, runsDecoded: 0, runsRendered: 0, runsKeyed: 0 },
  // The edit made again: what it cost the first time.
  editAgain: { rowsWritten: 140, runsDecoded: 1, runsRendered: 2, runsKeyed: 0 },
  // An approval's sweep: the copy's record marked stale (1), and the rejection's rows.
  approval: { rowsWritten: 138, runsDecoded: 0, runsRendered: 0, runsKeyed: 0 },
  // A refetch of one changed paragraph: run, rendering, list, version and record written, and
  // what only the base listed removed. Rendered: the changed run. Keyed: the run after it.
  refetch: { rowsWritten: 275, runsDecoded: 0, runsRendered: 1, runsKeyed: 1 },
  // A refetch that brings the tab unchanged: the copy's record.
  unchanged: { rowsWritten: 1, runsDecoded: 0, runsRendered: 0, runsKeyed: 0 },
};

// What a removal costs beside a store's other documents: two hundred against none and a thousand.
describe("what a removal costs on a Durable Object's storage", () => {
  const CASES = Object.keys(SWEEP_COST) as SweepCase[];

  it.each(SWEEP_COST_PAIRS)(
    "a sweep, a trial and a drop write no row and read six at the most for two hundred other documents: %d pairs",
    async pairs => {
      const beside = await withDocStore((_store, storage) => sweepCostScenario(storage, { others: 200, pairs }));
      const alone = await withDocStore((_store, storage) => sweepCostScenario(storage, { others: 0, pairs }));

      expect([beside.runs, alone.runs]).toEqual([2 * pairs + 1, 2 * pairs + 1]);
      for (const removal of CASES) {
        const { rowsRead, beside: more, rowsWritten } = SWEEP_ROWS[pairs][removal];
        expect(alone[removal], removal).toEqual({ ...SWEEP_COST[removal], rowsRead, rowsWritten });
        expect(beside[removal], removal)
          .toEqual({ ...SWEEP_COST[removal], rowsRead: rowsRead + more, rowsWritten });
        // A few rows at the most, of which storage does not say which they are.
        expect(more, removal).toBeLessThanOrEqual(6);
      }
    },
  );

  it("a sweep, a trial and a drop cost the same beside a thousand other documents as beside two hundred", async () => {
    const few = await withDocStore((_store, storage) => sweepCostScenario(storage, { others: 200, pairs: 300 }));
    const many = await withDocStore((_store, storage) => sweepCostScenario(storage, { others: 1_000, pairs: 300 }));

    // Every count of every removal, the rows read as billed included.
    expect(many).toEqual(few);
    expect(few.rejection.rowsRead).toBeGreaterThan(few.runs);
  });

  it("a drop reads no list", async () => {
    const drops = await withDocStore((_store, storage) =>
      [300, 600].map(pairs => {
        const { runs, dropLarge } = sweepCostScenario(storage, { others: 0, pairs });
        return { runs, ...dropLarge };
      }));

    // Six statements and no row answered, whatever the runs: billed the rows it removes and a
    // row for each row of the list its delete finds.
    expect(drops.map(({ statements, answered }) => ({ statements, answered })))
      .toEqual([{ statements: 6, answered: 0 }, { statements: 6, answered: 0 }]);
    expect(drops.map(({ runs, rowsRead, rowsWritten }) => rowsRead - rowsWritten - runs)).toEqual([4, 4]);
    expect(drops.map(({ rowsRead }) => rowsRead)).toEqual([1_813, 3_613]);
  });
});

// What the caps add to a keep of a connection of 200 documents, as storage bills it.
describe("what a keep at a connection's caps costs on a Durable Object's storage", () => {
  it.each(CAP_COST_PAIRS)("a keep reads a row a copy, and an eviction what its deletes are billed: %d pairs", async pairs => {
    const cost = await withDocStore((_store, storage) => capCostScenario(storage, { pairs }));

    expect([cost.runs, cost.proseRuns]).toEqual([2 * pairs + 1, 300]);
    expect(cost.copies).toEqual([200, 200, 200, 151]);
    for (const kept of Object.keys(CAP_COST) as CapCase[]) {
      expect(cost[kept], kept).toMatchObject(CAP_COST[kept]);
    }
    for (const kept of Object.keys(CAP_ROWS) as (keyof typeof CAP_ROWS)[]) {
      expect(cost[kept], kept).toMatchObject(CAP_ROWS[kept]);
    }
    // The keep that evicts nothing reads one row a copy beyond what the keep itself reads.
    expect(cost.nothing.rowsRead - cost.plain.rowsRead).toBe(200);
    // Evicting the many-run document: a row a copy and what its drop is billed.
    const drop = SWEEP_ROWS[pairs].dropLarge;
    expect(cost.manyRuns).toMatchObject({
      rowsRead: cost.plain.rowsRead + 201 + drop.rowsRead + drop.beside,
      rowsWritten: cost.plain.rowsWritten + drop.rowsWritten,
    });
  });
});

// What a connection's expiry pass costs a connection of 200 documents, as storage bills it.
describe("what a connection's expiry pass costs on a Durable Object's storage", () => {
  it.each(EXPIRY_COST_PAIRS)("a pass reads a row a copy, and a removal what its deletes are billed: %d pairs", async pairs => {
    const cost = await withDocStore((_store, storage) => expiryCostScenario(storage, { pairs }));

    expect([cost.runs, cost.proseRuns]).toEqual([2 * pairs + 1, 300]);
    expect(cost.copies).toEqual([200, 200, 0]);
    for (const call of Object.keys(EXPIRY_COST) as ExpiryCase[]) {
      expect(cost[call], call).toMatchObject(EXPIRY_COST[call]);
    }
    for (const call of Object.keys(EXPIRY_ROWS) as (keyof typeof EXPIRY_ROWS)[]) {
      expect(cost[call], call).toMatchObject(EXPIRY_ROWS[call]);
    }
    // Removing two documents: a row a copy and what each drop is billed.
    const drop = SWEEP_ROWS[pairs].dropLarge;
    expect(cost.two).toMatchObject({
      rowsRead: 202 + EXPIRY_PROSE_DROP.rowsRead + drop.rowsRead + drop.beside,
      rowsWritten: EXPIRY_PROSE_DROP.rowsWritten + drop.rowsWritten,
    });
  });
});

// A reset undoes the drops of the expiry call it ends, and nothing an earlier request dropped.
/** Runs `run` as one request of `expiry-reset` on its own stub: one that met the reset is not used again. */
const request = <T>(run: (state: DurableObjectState) => T) => runInDurableObject(
  env.DOC_STORE_HOST.getByName("expiry-reset"),
  (_instance: unknown, state: DurableObjectState) => run(state));

describe("a connection's expiry pass on a Durable Object that is reset", () => {
  const NONE: DocPending = { edits: [], roots: [] };

  it("keeps what the calls before it dropped, undoes its own, and the next call goes on", async () => {
    const told: string[] = [];
    /** A request of a connection whose pass drops one copy a call; `reset` ends it in its drop. */
    const call = (reset = false) => request(state => {
      const store = new DocStore(state.storage);
      new DriveDocCopyLimits({
        store: () => store, pendingDocs: () => new Set<string>(), kv: state.storage.kv,
        now: () => DRIVE_DOC_COPY_EXPIRY_MS, expiryCallBytes: 1,
        removed: doc => {
          // Told once the drop's own transaction returned, the copy gone as the isolate reads it.
          told.push(`${doc}:${store.head(doc) === undefined ? "gone" : "held"}`);
          if (reset) state.abort("reset inside the pass");
        },
      }).expire();
    });
    const stored = () => request(state => ({
      copies: new DocStore(state.storage).copies().map(({ doc }) => doc).toSorted(),
      hour: state.storage.kv.get(DOC_COPY_EXPIRY_PASS_KEY),
    }));
    await request(state => {
      const store = new DocStore(state.storage);
      for (const doc of ["a", "b", "c"]) {
        store.keep(doc, scenarioCopy([scenarioTab("t1", [doc])]), NONE, { at: 0 });
      }
    });

    await call();
    expect(await stored()).toEqual({ copies: ["b", "c"], hour: undefined });

    await expect(call(true)).rejects.toThrow("reset inside the pass");
    // The second copy's drop is undone with its request; the first's, a request before, stays.
    expect(told).toEqual(["a:gone", "b:gone"]);
    expect(await stored()).toEqual({ copies: ["b", "c"], hour: undefined });

    await call();
    expect(await stored()).toEqual({ copies: ["c"], hour: undefined });
    await call();
    expect(await stored()).toEqual({ copies: [], hour: DRIVE_DOC_COPY_EXPIRY_MS });
    expect(told).toEqual(["a:gone", "b:gone", "b:gone", "c:gone"]);
  });
});

// What iterating the many-run tab's runs costs, decoded one at a time.
describe("what an iteration of a tab's runs costs on a Durable Object's storage", () => {
  /** The pairs of the many-run tab: 4,001 runs, and in the wider run 19,601 too. */
  const PAIRS: readonly number[] = WIDER ? [2_000, 9_800] : [2_000];

  it.each(PAIRS)("reads four rows a run and writes none: %d pairs", async pairs => {
    const cost = await withDocStore((_store, storage) => {
      const { base } = keptUnder(storage, tinyTablesTab("t1", pairs), "a");
      const before = tableCounts(storage);
      const counted = countedStorage(storage);
      const store = new DocStore(counted.storage, undefined, "a");
      // The store's own opening statements are not the iteration's.
      const opened = { rowsRead: counted.rowsRead(), all: counted.counts().all, answered: counted.answered() };
      const decoded = docStoreCost.runsDecoded;
      let handed = 0, elements = 0;
      for (const run of store.runs(base)) {
        handed++;
        elements += run.length;
      }
      return {
        handed, elements,
        decoded: docStoreCost.runsDecoded - decoded,
        rowsRead: counted.rowsRead() - opened.rowsRead,
        rowsWritten: counted.rowsWritten(),
        statements: counted.counts().all - opened.all,
        answered: counted.answered() - opened.answered,
        pages: counted.counts().pages, content: counted.counts().content,
        unchanged: JSON.stringify(tableCounts(storage)) === JSON.stringify(before),
      };
    });

    // A page of the list is 500 runs, and one that comes short is the last.
    const runs = 2 * pairs + 1, pages = Math.floor(runs / 500) + 1;
    expect(cost).toEqual({
      // The paragraph that opens the tab is a run with the body's opening break.
      handed: runs, elements: runs + 1, decoded: runs, rowsWritten: 0, unchanged: true,
      // The totals, the list's pages, and for each run its row's check and then its JSON.
      statements: 1 + pages + 2 * runs, pages, content: runs,
      // BILLED: the list twice, by the totals and by the pages, and each run's row twice.
      rowsRead: 4 * runs,
      // The totals' one row, and a row a run of the list, of the check and of the JSON.
      answered: 1 + 3 * runs,
    });
  });
});
