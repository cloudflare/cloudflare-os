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

  // What sharing saves, on real storage: an edit and a changed fetch write the runs near the
  // change and a list, whatever the tab's length.
  it("counts what each step of a large tab's life writes, decodes, renders and keys", async () => {
    const life = await withDocStore((store, storage) => largeTabLife(store, storage));

    const { n, c, m } = life;
    expect({ n, c, m, fetched: life.fetched }).toEqual({ n: 133, c: 1, m: 133, fetched: { c: 1, m: 133 } });
    expect(life).toMatchObject(LARGE_TAB_COSTS);
    // Each number of the table, from the runs of the tab (n), the runs a change replaced (c)
    // and the runs of the changed tab (m). A row written to an ordinary table (a run, a
    // rendering, a result) is billed with the row of its key's index, twice; A ROW REMOVED IS
    // BILLED ONCE, whichever table it is of.
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

    // One expectation, two storages: every case gives on real storage the counts it gives
    // on the Node fake, the child read back is the whole-tab model's, and a sweep leaves the
    // kept rows.
    it("makes each edit in the runs its batch touches, on real storage", async () => {
      const counts = await scenario();

      expect(counts.cases).toMatchObject(EDIT_COUNTS);
      expect(Object.keys(counts.cases).toSorted()).toEqual(Object.keys(EDIT_COUNTS).toSorted());
      for (const [name, cost] of Object.entries(counts.cases)) {
        // One run's JSON in hand at a time; the paragraph a batch typed 100,000 characters
        // into is a run of its own.
        expect(cost.peak, name).toBeLessThanOrEqual(
          name === "longInsertion" ? 2 * (100_000 + 300) : 2 * RUN_SIZES.most);
      }
    });

    // Rows read, as billed: a row of a table a statement steps to, and a row for every step
    // of `json_each` or `json_tree`. For a tab of n runs in P pages of its list, whose
    // stored runs hold N JSON values and whose context defines L lists, and an edit whose
    // slice starts at place p, holds 1 run that names i lists, and whose list is walked in
    // joined pages over q rows to the slice's end (500 a page, n at most). The small
    // constants are the records, the named styles, a run by its id, and the row a range of
    // the list is closed by, as real storage shows them.
    // AN EDIT READS ROWS OF THE LIST AND NO VALUE OF ITS TAB'S RUNS: what it asks of
    // the tab as a whole is a walk of the list's joined pages each, and its piece is made in
    // passes, each of which reads the version's totals (n), the joined pages for the state
    // at its first run (2q), the list from that run with no join to the page's end, the
    // lists its page's runs name (one statement), and each run it renders, found and read.
    // The rows each case writes are pinned beside the rows it reads, as billed too.
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
        // A PENDING READ, the Markdown and then the summary: the joined page of each call
        // (a row of the list and the row of the rendering it names: 2n and 2n) and each
        // run's Markdown by its key (n). Rows of tables alone.
        expect(read("pendingRead")).toEqual(5 * n + 4);
        expect(wrote("pendingRead")).toEqual(0);
        // AN EDIT OF ONE PARAGRAPH, term by term.
        // The scan for its text: the joined pages of the whole list (2n) and each run's
        // Markdown by its key (n); every run is read, since a second place must be ruled out.
        const scan = 3 * n;
        // The pass that places its piece: the joined pages to the piece's run (2q).
        const placed = 2 * q;
        // The piece, one pass from the paragraph's run: the version's totals (n), the joined
        // pages for the state at that run (2q), and the list from it with no join, to the
        // page's end (n - p). Its one run, found and read, is among the constants.
        const piece = n + 2 * q + (n - p);
        // The slice: the version's totals (n) and the joined pages to the slice's end (2q);
        // its run is the piece's, taken as it was decoded and read no second time. Its
        // version: the totals again (n), the sizes before the slice's end (p), the parent's
        // names outside the slice (n), and the child's list, a row read for each row written
        // (2n). NO VALUE OF A RUN IS READ: the lists are asked for by id or by the page's
        // runs, and here the context defines none.
        const made = n + 2 * q + n + p + n + 2 * n;
        expect(read("middle")).toEqual(scan + placed + piece + made + 13);
        expect(read("middle")).toEqual(10 * n + 6 * q + 13);
        // WRITTEN: its run, the run's rendering and its result, each billed with the row of
        // its key's index (2 each), the child's list (n) and the child's record.
        const edit = n + 7;
        expect(wrote("middle")).toEqual(edit);
        // Fewer than the values of one run: it would pass them if the slice's run were stepped.
        expect(read("middle")).toBeLessThan(largestRun);
        // A PIECE OF MORE RUNS reads each, found and read (2 a run): the paragraph before a
        // table, whose closure holds the table's run and the next (2 more), and the last
        // paragraph of a run, whose closure holds the next run (1 more). The place cancels
        // out: the piece's page is read from it, and the version sums the sizes before it.
        expect(read("growingBeforeTable")).toEqual(read("middle") + 2 * 2);
        expect(read("lastShorter")).toEqual(read("middle") + 2);
        expect(read("lastLonger")).toEqual(read("middle") + 2);
        // A PIECE MADE IN TWO PASSES, for the first paragraph of a run, whose closure starts
        // in the run before: the pass from the paragraph's run, as above, and one from the
        // run before, which reads the totals, the joined pages, the list from one place
        // earlier and two runs.
        const second = n + 2 * q + (n - (p - 1)) + 2 * 2 + 3;
        expect(read("firstParagraph")).toEqual(read("middle") + second);
        expect(read("runStart")).toEqual(read("middle") + second);
        // AN APPEND has no scan: whether the tab is blank is asked of the first joined page
        // (2q, here the whole list), the pass that places the tab's end reads every joined
        // page (2n), and its piece and its slice stand at the last place.
        expect(read("append")).toEqual(11 * n + 4 * q + 12);
        expect(wrote("append")).toEqual(edit);
        // A TABLE CHANGE, term by term. What it asks of the tab as a whole is a pass over the
        // joined pages each (a row of the list and the row of the rendering it names, whose
        // summary it reads): the table that reads as recorded (2n: every run, since a second
        // such table must be ruled out), and for a change that adds cells the cells the
        // tab's tables hold (2n). Its piece is placed by a pass to the table's run (2q) and
        // made in passes, each of which reads the totals (n), the joined pages for the state
        // at its first run (2q), the list from that run to the page's end, each run it
        // renders, found and read, and three rows more.
        const pass = (place: number, runs: number) => n + 2 * q + (n - place) + 2 * runs + 3;
        // The slice and its version, as an edit of one paragraph has them.
        const stored = (place: number) => 5 * n + 2 * q + place;
        const pt = cases.cellStyle.at!.place;
        expect(walked(n, pt)).toEqual(q);
        // A look change: the table is a run of its own between two runs of prose, and its
        // piece is tried from its run (1 run) and made from the run before (3 runs).
        const look = 2 * n + 2 * q + pass(pt, 1) + pass(pt - 1, 3) + stored(pt) + 9;
        expect(read("cellStyle")).toEqual(look);
        expect(read("cellStyle")).toEqual(11 * n + 8 * q - pt + 24);
        expect(wrote("cellStyle")).toEqual(edit);
        // A row added: the pass over the tables' cells besides. With text in its cells, and
        // for a column, one row more.
        expect(read("rowNoText")).toEqual(look + 2 * n);
        expect(read("rowWithText")).toEqual(look + 2 * n + 1);
        expect(read("columnWithText")).toEqual(look + 2 * n + 1);
        // A NEW TABLE AT THE TAB'S END: the tables' cells (2n), the pass that places the
        // tab's end (2n), one pass of the piece at the last place, and the slice and its
        // version there, whose list is two rows longer, a row read for each written.
        const end = n - 1;
        expect(read("tableFilled")).toEqual(2 * n + 2 * n + pass(end, 1) + stored(end) + 2 * 2 + 7);
        // A NEW TABLE AFTER A PARAGRAPH: the tables' cells (2n), the scan for the text it is
        // to follow (3n), and the piece, the slice and the version as the edit of that
        // paragraph has them, the list two rows longer.
        expect(read("tableAfterParagraph")).toEqual(
          2 * n + 3 * n + 2 * q + pass(p, 1) + stored(p) + 2 * 2 + 7);
        expect(wrote("tableAfterParagraph")).toEqual(edit + 2 * 5);
        // THE FIRST EDIT AFTER A DEPLOY: the question whether the model follows the tab (its
        // totals, its list, each run found and read: 4n), the keying, which the scan asks
        // for (the list read and written over, each run found and read, the renderings of
        // the other digest looked up and removed and this digest's written: 10n), and the
        // edit.
        expect(read("afterDeploy")).toEqual(read("middle") + 14 * n + 25);
        // WRITTEN: the record of the question's answer; the keying, which writes each run's
        // rendering over in place (n, the index's row as it was), the list (n) and the
        // version's record; and the edit.
        expect(wrote("afterDeploy")).toEqual(1 + (2 * n + 1) + edit);
      }
      {
        // THE TAB OF A LIST A TABLE: the terms in the runs' values and in the context's lists.
        const { runs: n, pages: P, nodes: N, firstPage: N0, lists: L } = tabs.listed;
        const { place: p, named: i } = cases.listedMiddle.at!;
        const q = walked(n, p);
        expect([n, P, L, p, i, q]).toEqual([601, 2, 300, 299, 1, 500]);
        // THE PIECE AROUND A TABLE, five passes (from the table's run, from the run before,
        // two scouts and the piece: 1, 2, 3, 5 and 9 runs, from places p, p - 1, p - 2,
        // p - 4 and p - 4). The pass that places it reads the joined pages to its run (2q).
        // EACH PASS reads the totals (n), the joined pages for its state (2q), the list from
        // its first run with no join, and THE LISTS ITS PAGE'S RUNS NAME, by the one
        // statement a pass of a piece runs for its page: the page's rows of the list and its
        // runs (2 * 500), A ROW FOR EVERY VALUE OF THOSE RUNS' JSON (N0, the first page's)
        // and a row for every list the context defines (L). So a piece of 9 runs reads the
        // values of 500 runs five times: THE COST OF A PASS IS ITS PAGE'S, NOT ITS RUNS'.
        const passes = 5, rendered = 1 + 2 + 3 + 5 + 9;
        const lists = 2 * 500 + N0 + L;
        const fromPlaces = passes * (n - p) + (0 + 1 + 2 + 4 + 4);
        const piece = 2 * q + passes * (n + 2 * q + lists) + fromPlaces + 2 * rendered;
        expect(read("listedPiece")).toEqual(piece + 31);
        expect(wrote("listedPiece")).toEqual(0);
        // AN EDIT OF ONE CELL: the scan (3n), that piece, and the slice and its version as on
        // the tab of lines, with the context's lists stepped twice, by the slice's
        // definitions asked for by id and by the ids of the model's form (2L), and a row for
        // the one id asked for (i).
        expect(read("listedMiddle")).toEqual(
          3 * n + read("listedPiece") + (5 * n + 2 * q + p + 2 * L + i) + 13);
        // WRITTEN as on the tab of lines: the batch makes no list, so the child has no
        // context of its own.
        const edit = n + 7;
        expect(wrote("listedMiddle")).toEqual(edit);
        // THE FIRST EDIT AFTER A DEPLOY reads the runs' values and the lists of each page
        // ONCE MORE, for the keying, which renders every run (N and L a page). The rest is
        // rows of tables and the lists stepped for the question.
        expect(read("listedAfterDeploy")).toEqual(read("listedMiddle") + N + L * P + 8_987);
        // WRITTEN: the record of the question's answer, the keying and the edit. The keying's
        // list names d distinct renderings, f of them in its first 500 runs: those are written
        // over in place (a row each), and each of the others is a row removed with the other
        // digest's and a row written with its index's (3 each); then the list and the record.
        const d = L + 2, f = 250 + 2;
        expect(wrote("listedAfterDeploy")).toEqual(1 + (f + 3 * (d - f) + n + 1) + edit);
      }

      {
        // THE SHAPE OF MANY RUNS: a table and an empty paragraph in turn, each a run. A row
        // added to the hundredth table reads NO VALUE OF A RUN AND 31 ROWS A RUN OF THE TAB:
        // the two passes for what it asks of the tab as a whole (4n), the pass that places
        // its piece (2q), the five passes of the piece (from the table's run, from the run
        // before, two scouts and the piece: 1, 2, 3, 5 and 9 runs, from places p, p - 1,
        // p - 2, p - 4 and p - 4), each of which reads the totals and the joined pages for
        // its state (n + 2q) and the list from its first run (about n / 2 here), and the
        // slice and its version (5n + 2q + p). On this shape the walks of the list are the
        // cost: 12,512 rows for a tab of 401 runs.
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
      /**
       * The case on the shape of many runs, held above by its formula: its runs are so small
       * that the rows of its walks pass a tenth of the values its tab's runs hold.
       */
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
        // A batch by hand: at most the edit of one paragraph at its tab's last place, eight
        // rows for each run decoded and each run cut, and for each widening a walk from the
        // list's start. An edit the builders build, besides: what it asks of the tab as a
        // whole and the pass that places its piece (a scan and a pass, or three passes: 7n at
        // most), and at most a pass of its piece for each run it decodes (4n each).
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

  // Rows read by the card of a queued change, as billed. For two versions of nb and na
  // runs whose lists differ at `[from, beforeTo)` and `[from, afterTo)`:
  // WHERE THEY DIFFER (`DocStore.changed`): each list's total (nb and na, and a row more
  // where another version's list closes its range), the first place that differs (the two
  // lists stepped to it: 2 a place) and the last (the two lists stepped back to it from
  // their ends: 2 a place). Nothing is read of the places between.
  // THE STRINGS (`changedMarkdown`), beyond that: the pass of the summaries before `from`
  // (2 a run, and the version's record); and for each of its readers the version's record,
  // 2 rows for each run of the pages it reads (a row of the list and the row of the rendering
  // it names; a first page of 8 runs, then 32, 128 and 500), a row more for a page that
  // reaches its list's end, and a row for each run's Markdown it reads.
  it("counts the rows a preparation's card reads", async () => {
    const { rowAdded, nested } = await withDocStore((_, storage) => cardRowsScenario(storage));
    const compared = ({ before, after, changed }: typeof rowAdded) =>
      before + after + 2 * (changed.from + 1) + 2 * (before - changed.beforeTo + 1);
    {
      // A ROW ADDED TO A TABLE in the middle of 2,000 lines: the table's run is listed
      // anew, and nothing else.
      const { before: nb, after: na, changed, card } = rowAdded;
      expect([nb, na, changed]).toEqual([21, 21, { from: 9, beforeTo: 10, afterTo: 10 }]);
      expect(rowAdded.compared).toEqual({ rowsRead: compared(rowAdded) + 1, all: 4 });
      // Six readers, each of one page of 8 runs: two forwards from the table's run, which
      // read it in each version; two backwards from the run after it, which read it again;
      // and one of each version for its string, the table's run and the run before it.
      expect(card).toEqual({
        pages: 1 + 6, joined: 1 + 6, content: 2 + 2 + 2 * 2, all: 4 + 2 * 7 + 8,
        rowsRead: rowAdded.compared.rowsRead + (1 + 2 * changed.from) + 6 * (1 + 2 * 8) + 8,
      });
      // Under two rows a run of the tab beyond `changed`, whatever the tab's length: the
      // pass before the place that differs.
      expect(rowAdded.strings.mdStart).toBeGreaterThan(80_000);
    }
    {
      // THE ITEMS BEFORE AN ITEM MADE A LEVEL-0 ONE, under the real cut: every run is
      // listed anew, cut otherwise, and all but the last read as before.
      const { before: nb, after: na, changed, card } = nested;
      expect([nb, na, changed]).toEqual([41, 44, { from: 0, beforeTo: 41, afterTo: 44 }]);
      expect(nested.compared).toEqual({ rowsRead: compared(nested) + 2, all: 4 });
      // THE PRICE OF COMPARING AS TEXT: every run listed anew before the text is read once
      // in each version by the comparison from the front, three rows a run (its row of the
      // list, the rendering's row the page names, and its Markdown): nb + na runs. The
      // comparison from the end reads the last run of each; the string after is its last
      // run; the string before is found by a pass of its list from `from` (two rows a
      // run) and is one run. Four of the pages reach their list's end.
      const front = 2 * 1 + 2 * (nb + na) + (nb + na);
      const end = 2 * (1 + 2 * 8) + 2;
      const strings = (1 + 2 * 1) + 1 + (1 + 2 * nb) + 1;
      expect(card).toEqual({
        pages: 3 + 3 + 2 + 1 + 3, joined: 12, content: (nb + na) + 2 + 2,
        all: 4 + (6 + 12) + (nb + na) + 4,
        rowsRead: nested.compared.rowsRead + front + end + strings + 4,
      });
      // The strings hold the item's line and one run of each version, of the 320,000
      // characters that read alike before it.
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

  // What a fetch costs in rows, on real storage, for a tab of n runs of which a change
  // replaces c and leaves m. Rows written: a row of an ordinary table (a run, a rendering) is
  // billed with the row of its key's index, twice.
  // Rows read, the terms that are the fetch's own:
  // - `2n`, THE STORED BASE'S LIST, read in pages as the tab's runs pass: a run's row of the
  //   list and the row of the rendering it names, each once. A fetch that changed nothing
  //   reads it as a changed one does: a run is keyed as it is cut, before the version's id
  //   says that nothing changed.
  // - a row for each run found stored when it is asked for by its name, and the small rows
  //   of the copy's record and the two versions' records.
  // The rest of a changed fetch is its sweep of the version it replaced, whose reads follow
  // how many of the tab's runs are distinct: it is pinned as the number it is for each shape.
  it.each([
    {
      // An answer of nearly 10 MiB: paragraphs of about 500 characters, each run its own.
      shape: "prose" as const, n: 330, pages: 1,
      first: (n: number) => ({ rowsWritten: 5 * n + 4, rowsRead: n + 4 }),
      changed: { first: 4_329, last: 4_330 },
    },
    {
      // Many runs: 2,000 small tables, each a run, and between two of them an empty
      // paragraph, the same run each time: d = 2,002 distinct runs, each with one rendering.
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
    // The run that changed, its rendering, the tab's list and its record; and the removal of
    // what the version it replaces held alone.
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
    // Nothing changed: the copy's record is the one row written. Read: the base's list, a
    // row for each run found stored, and ten small rows.
    expect(counts.unchanged).toEqual({
      rowsWritten: 1, rowsRead: 2 * n + n + 10, runsRendered: 0, runsKeyed: 0,
      ...list, replaced: 0, runs: n,
    });
  });

  // What it costs in rows read, on real storage, to key a version again under another digest
  // and read it: a tab of n runs in P pages of its list, whose stored runs are N values of
  // JSON and whose context defines L lists. THE UNIT, which every sum of rows read is written
  // in: a row of a table a statement steps to, and a row for every step of `json_each` or
  // `json_tree`.
  // - `N + L * P`, THE LISTS OF A PAGE, loaded by one statement a page: `json_tree` walks every
  //   value of the page's runs, and `json_each` steps over every list the context defines,
  //   named or not. Both with coefficient 1: the runs are stepped once a keying and the context
  //   once a page, never once a run.
  // - `2n + P + (P - 1)`, the rows of tables that statement reads: each run's row of the list
  //   and the row of its content, the context's row, and the list's next row where one
  //   follows the page, at which the page's range ends.
  // - `4n`: the version's totals, its list in pages with no join, and each run's content,
  //   found by its id and then read.
  // - `n`, a row for each entry of the list written: `json_each` hands out the writer's batch.
  // - `2n`, the joined pages of the read that follows the keying.
  // - THE RENDERINGS, of which the list names d distinct ones, f of them in the first batch of
  //   500 runs that the writer flushes. A rendering of the first batch is found by its key and
  //   written over in place, which reads its row; the other digest's are then removed (the
  //   list's rows, each distinct key's row and its index's, and each row removed), so a later
  //   run finds one only where a run before it wrote it: `(n - (d - f)) + f + (n + 2d + (d - f))`.
  // - 7 small rows: the format, the version's record read three times and written once, its
  //   context's id, and the context's named styles.
  it("bills the lists of a page a row for every value of its runs and a row for every list of the tab", async () => {
    const keyed = await withDocStore((_, storage) => keyingRows(storage));

    const { runs, pages, nodes, lists } = keyed;
    expect({ runs, pages, lists }).toEqual({ runs: 601, pages: 2, lists: 300 });
    // The values of 601 stored runs: a term of its own size, so it cannot hide in another.
    expect(nodes).toBeGreaterThan(30 * runs);
    // A statement a page loads its lists, and one reads the named styles.
    expect(keyed.counts).toMatchObject({ lists: pages, styles: 1 });
    // The renderings the list names: each table's, and an empty paragraph's at the tab's start
    // and after a table; the first 500 runs name 250 tables' and those two.
    const d = lists + 2, f = 250 + 2;
    const tables = 11 * runs + (2 * d + f) + (pages - 1) + 7;
    expect(keyed.rowsRead).toEqual(tables + pages + nodes + lists * pages);
  });

  // The ids a page's runs name are asked for at the first list `json_each` hands out. A context
  // that defines no list hands out none, so the statement reads the context's row and neither
  // a row nor a value of a run: `2n + (P - 1) + N` fewer than above, the keying's other rows
  // being the same on a tab of as many runs and renderings.
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

  // A first read through Drive of a tab of n runs: the read holds the document, tries it and,
  // once approved, keeps it. The trial and the keep each store the document from its bytes,
  // so it is decoded 2n and rendered 2n; 10n + 7 rows are written, and the trial's 3n + 2
  // are removed again.
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

  // THE test of the limit: its measure is the UTF-8 of what a row holds, not a string's length.
  // One element is held to a row, and a tab is not: a tab is as many rows as it has runs.
  it("keeps a paragraph of just under 8,000,000 bytes of text outside ASCII and refuses a larger one, saying why", async () => {
    const outcome = await withDocStore((store, storage) => {
      // A paragraph that holds every width of UTF-8 beside its JSON's ASCII: a character of two
      // bytes, one of four that is two units of the string, and `characters` of three bytes.
      const tabOf = (characters: number) => scenarioTab("t1", [`é\u{1F600}${"文".repeat(characters)}`]);
      // The largest row the document holds: the paragraph is a run of its own, and the row of
      // its rendering (its keys, the digest, its summary and its Markdown) holds more beside
      // the text than the row of the run does.
      const largestRow = () => storage.sql.exec<{ bytes: number }>(
        `SELECT max(bytes) AS bytes FROM (
           SELECT length(CAST(run || context || carry || made || summary || md AS BLOB)) AS bytes FROM doc_md
           UNION ALL SELECT length(CAST(id || json AS BLOB)) FROM doc_run)`).one().bytes;
      // The paragraph's indexes and its Markdown's length take more digits as it grows, so the
      // count is settled on a paragraph of nearly the size.
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
    // Nothing of the larger paragraph is stored: the rows are the smaller document's, its
    // opening break and its paragraph each a run with its rendering.
    expect(outcome.counts).toEqual({ ...EMPTY, doc_copy: 1, doc_run: 3, doc_md: 2, doc_seq: 2, doc_version: 1 });
    expect(outcome.longLength).toBeGreaterThan(2 * DOC_ROW_BYTES);
    expect(outcome.longRead).toBeGreaterThan(2 * DOC_ROW_BYTES);
  });

  // A TEXT column is UTF-8: half of a surrogate pair bound to one reads back as three U+FFFD.
  // By run: each run's Markdown is stored as its own row, and only the one that holds the half
  // is stored as its JSON, behind the mark.
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

  // A run's size is an INTEGER column of a STRICT table: a size that is not one would fail the
  // keep. An element with no end ends where the element before it does.
  it("keeps a tab whose element holds no end", async () => {
    const outcome = await withDocStore((_, storage) => {
      const sizes = { ...RUN_SIZES, elements: 1 };
      const store = new DocStore(storage, undefined, undefined, sizes);
      return [2, 3].map(at => {
        const tab = scenarioTab("t1", ["One", "Two", "Three"]);
        delete (tab.body.content[at] as { endIndex?: number }).endIndex;
        const doc = `doc-${at}`;
        const base = scenarioBase(store, doc, store.keep(doc, scenarioCopy([tab], "r1", sizes), NONE));
        return {
          sizes: storage.sql.exec<{ size: number }>(
            "SELECT size FROM doc_seq WHERE version = ? ORDER BY seq", base.id).toArray().map(row => row.size),
          readBack: JSON.stringify(store.tab(base)) === JSON.stringify(tab),
          unindexed: store.unindexed(base),
        };
      });
    });

    expect(outcome).toEqual([
      // The second paragraph holds no end: the third is counted from where the first ends.
      { sizes: [1, 4, 0, 10], readBack: true, unindexed: true },
      // The last paragraph holds none.
      { sizes: [1, 4, 4, 0], readBack: true, unindexed: true },
    ]);
  });

  // A run is rendered with the definitions its context holds, which the worker's SQLite reads
  // with its JSON functions, and those throw on text that is not JSON: a context that is not
  // what was stored is unreadable, and no error of SQLite's passes.
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

  it("removes what a sweep orphans, and nothing a version still lists", async () => {
    const counts = await withDocStore((store, storage) => {
      const one = scenarioBase(store, "one", store.keep("one", scenarioCopy(TABS()), NONE));
      const two = scenarioBase(store, "two", store.keep("two", scenarioCopy(TABS()), NONE));
      store.markdown(one);
      const child = scenarioEdit(store, one, "e1");
      scenarioEdit(store, child, "e2");
      scenarioEdit(store, two, "e1");
      const queued = tableCounts(storage);
      // The second edit is decided: its version goes, and the first's stays.
      store.sweep("one", { edits: ["e1"], roots: [] });
      const decided = tableCounts(storage);
      // The first document goes: the second's rows stay, the runs both hold included.
      store.drop("one");
      const dropped = tableCounts(storage);
      const read = store.markdown(two);
      store.drop("two");
      return { queued, decided, dropped, read, emptied: tableCounts(storage) };
    });

    expect(counts).toEqual({
      // Two documents that read the same hold rows of their own: their runs, their context
      // and their renderings as their versions and run lists. Each tab and each version an
      // edit gives is one run, rendered as it is stored: for each document the two tabs' and
      // their one context, and the runs of the first document's two edits and of the
      // second's one.
      queued: { doc_copy: 2, doc_md: 7, doc_result: 3, doc_run: 9, doc_seq: 7, doc_version: 7 },
      decided: { doc_copy: 2, doc_md: 6, doc_result: 2, doc_run: 8, doc_seq: 6, doc_version: 6 },
      dropped: { doc_copy: 1, doc_md: 3, doc_result: 1, doc_run: 4, doc_seq: 3, doc_version: 3 },
      read: "One\n\nTwo\n",
      emptied: EMPTY,
    });
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

  it("leaves no row of a document read in a trial", async () => {
    const outcome = await withDocStore((store, storage) => {
      const read = store.trial("doc", scenarioCopy(TABS()), () => NONE, head => {
        const base = scenarioBase(store, "doc", head);
        scenarioEdit(store, base, "e1");
        return { markdown: store.markdown(base), during: tableCounts(storage) };
      });
      return { ...read, after: tableCounts(storage), head: store.head("doc") === undefined };
    });

    expect(outcome.markdown).toBe("One\n\nTwo\n");
    // The two tabs and the version the edit gives, each one run with its rendering.
    expect(outcome.during).toEqual({ doc_copy: 0, doc_md: 3, doc_result: 1, doc_run: 4, doc_seq: 3, doc_version: 3 });
    expect(outcome.after).toEqual(EMPTY);
    expect(outcome.head).toBe(true);
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

// The rows storage bills for each step of a document's life. A row of an ordinary table (a run,
// a context, a rendering, a result) is billed with the row of its key's index.
const ROWS_WRITTEN = {
  // Two tabs, each one run: their runs and the context they share (6), the rendering of each
  // run (4), two versions, two run lists of one row each and the copy's record.
  keep: 15,
  // The same document kept again: the copy's record alone.
  again: 1,
  // The runs were rendered by the keep: a read writes nothing.
  firstRead: 0,
  secondRead: 0,
  // An edit: the run it changed, which is its tab's one run (2), that run's rendering (2), the
  // version it gives, its run list of one row, and the edit's result (2).
  edit: 8,
  // A trial of a document the stored copy holds unchanged.
  trial: 0,
};

// What each step of the life of a tab of 20,000 paragraphs (`largeTabLife`) moves of the store's
// counters, on real storage: 133 runs (n), of which an edit of one paragraph and a fetch that
// brings one paragraph changed each replace one (c) and leave as many (m).
const LARGE_TAB_COSTS: Record<string, StepCost> = {
  // The first keep: the runs (2n), the context (2), their renderings (2n), the list (n), the
  // version and the copy's record. Each run is rendered alone, to be stored.
  keep: { rowsWritten: 669, runsDecoded: 0, runsRendered: 133, runsKeyed: 0 },
  // A read of the Markdown and of the summary: stored rows, joined.
  read: { rowsWritten: 0, runsDecoded: 0, runsRendered: 0, runsKeyed: 0 },
  // An edit in the middle: the changed run (2c), its rendering (2c), the child's list (m), its
  // version and the result (2). Decoded: the one run that holds the closure of the edit's
  // paragraph, for the piece the builders read, which the model's slice takes (1). Rendered:
  // that run for the piece (1), and the run cut from the slice, to be stored (c). Keyed: none:
  // the carry after the slice is the base's.
  edit: { rowsWritten: 140, runsDecoded: 1, runsRendered: 2, runsKeyed: 0 },
  // A pending read of the version the edit gives.
  pendingRead: { rowsWritten: 0, runsDecoded: 0, runsRendered: 0, runsKeyed: 0 },
  // A rejection's sweep removes everything the edit wrote, and nothing else, each row billed
  // once: the child's list (m), its version, the result, and the rendering (c) and the run (c)
  // only the child listed.
  rejection: { rowsWritten: 137, runsDecoded: 0, runsRendered: 0, runsKeyed: 0 },
  // The base then reads with nothing decoded or rendered.
  baseRead: { rowsWritten: 0, runsDecoded: 0, runsRendered: 0, runsKeyed: 0 },
  // The edit made again: what it cost the first time.
  editAgain: { rowsWritten: 140, runsDecoded: 1, runsRendered: 2, runsKeyed: 0 },
  // An approval's sweep: the copy's record marked stale (1), and the rejection's rows.
  approval: { rowsWritten: 138, runsDecoded: 0, runsRendered: 0, runsKeyed: 0 },
  // A refetch that brings one paragraph changed: the changed run (2c), its rendering (2c), the
  // fetched tab's list (m), its version and the copy's record, written over in place (1); and
  // removed of the base it replaces, each row billed once, its list (n), its version, and the
  // run (c) and the rendering (c) only it listed. Rendered: the changed run. Keyed: the run
  // directly after it.
  refetch: { rowsWritten: 275, runsDecoded: 0, runsRendered: 1, runsKeyed: 1 },
  // A refetch that brings the tab unchanged: the copy's record.
  unchanged: { rowsWritten: 1, runsDecoded: 0, runsRendered: 0, runsKeyed: 0 },
};

// What a removal costs beside the other documents of a store, as storage bills it: a store
// that holds two hundred other documents against one that holds none, and against one that
// holds a thousand, on a tab of many runs.
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

    // Six statements and no row answered, whatever the document's runs. It is billed the
    // rows it removes and, beside them, a row for each row of the list as the list's
    // delete finds it: three rows a pair of a table and a paragraph more for a tab twice
    // as long, and nothing else.
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
    // The one that evicts the many-run document reads a row a copy and what a drop of that
    // document is billed: no row of a list but those its delete removes.
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
    // The pass that removes the prose and the many-run document reads a row a copy and what
    // a drop of each is billed: no row of a list but those its delete removes.
    const drop = SWEEP_ROWS[pairs].dropLarge;
    expect(cost.two).toMatchObject({
      rowsRead: 202 + EXPIRY_PROSE_DROP.rowsRead + drop.rowsRead + drop.beside,
      rowsWritten: EXPIRY_PROSE_DROP.rowsWritten + drop.rowsWritten,
    });
  });
});

// What a reset of the object leaves of an expiry pass. A call of the pass is one synchronous
// stretch, which the object commits whole or not at all, so a reset undoes the drops of the
// call it ends, each made in a transaction that had returned, and nothing an earlier request
// dropped: what one call drops is bounded for that.
/**
 * Runs `run` as one request of the `DocStoreHost` named `expiry-reset`, through a stub of its
 * own: one that met the reset is not used again.
 */
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

// What a reader of a tab's own text costs, as storage bills it: the runs of the many-run tab,
// decoded one at a time.
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
      // The version's totals, the pages of its list and, for each run, that its row is
      // stored and then its JSON.
      statements: 1 + pages + 2 * runs, pages, content: runs,
      // BILLED: the list twice, by the totals and by the pages, and each run's row twice.
      rowsRead: 4 * runs,
      // The totals' one row, and a row a run of the list, of the check and of the JSON.
      answered: 1 + 3 * runs,
    });
  });
});
