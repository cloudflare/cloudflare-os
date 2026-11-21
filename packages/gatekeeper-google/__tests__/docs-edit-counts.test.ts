// What an edit of a stored Google Doc decodes and renders outside the scenario's table, and the
// statements it runs. Rows written and read per case live in the workerd count table.

import { createSimulationStore } from "@gadgets/gatekeeper-kit/simulation-store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { replayCost } from "../src/docs-model";
import { storedTabReading } from "../src/docs-reading";
import {
  docEditResult, docTabReducer, editedSlice, type DocEdit, type QueuedDocRecord,
} from "../src/docs-replay";
import { DocStore, docStoreCost, type DocVersion } from "../src/docs-store";
import { changedMarkdown, prepareTableChange, type TableCall } from "../src/docs-table-actions";
import { docTabToMarkdown, MARKDOWN_RENDERING_VERSION } from "../src/markdown-converter";
import { fakeDocStorage, type FakeDocStorage } from "./doc-store-fake";
import {
  countedStorage, keptUnder, linesWithTablesTab, listedTablesTab, spent, tableScans, under,
} from "./doc-store-scenarios";

describe("an edit's tab, rendered and folded", () => {
  afterEach(() => vi.restoreAllMocks());

  const LINES = Array.from({ length: 20_000 }, (_, at) => `Line ${String(at).padStart(5, "0")}.`);
  let kept: ReturnType<typeof keptUnder<FakeDocStorage>> | undefined;
  /** The scenario's tab of lines, kept once in a fake of its own under the store's digest. */
  const linesKept = () => kept ??= keptUnder(
    fakeDocStorage(), linesWithTablesTab("t1", LINES, [5_000, 10_000, 15_000]), "edit-counts");

  it("the piece around a table, counted apart", () => {
    let { storage, store, base } = linesKept();
    let { longest } = storage.sql.exec<{ longest: number }>(
      "SELECT MAX(LENGTH(json)) AS longest FROM doc_run").one();
    let { markdown } = storage.sql.exec<{ markdown: number }>(
      "SELECT MAX(LENGTH(md)) AS markdown FROM doc_md").one();
    let before = { ...docStoreCost };
    docStoreCost.peakRunBytesInHand = 0;
    docStoreCost.peakMarkdownCharsInHand = 0;

    let piece = storedTabReading(store, base).piece({ table: 1 });

    // The table is a run of its own between two runs of prose. A pass from its run (one run)
    // steps back out of the runs in hand; a pass from the run before takes the table's run and
    // then the run after it, where the steps forward end (three runs): four runs decoded and
    // rendered, one at a time, and the piece widened twice.
    expect([
      docStoreCost.runsDecoded - before.runsDecoded, docStoreCost.runsRendered - before.runsRendered,
      docStoreCost.pieceWidenings - before.pieceWidenings,
    ]).toEqual([1 + 3, 1 + 3, 2]);
    // The Markdown in hand is the joined runs of an attempt, never the tab's.
    expect(docStoreCost.peakMarkdownCharsInHand).toBeLessThanOrEqual(3 * markdown);
    expect(docStoreCost.peakRunBytesInHand).toBeLessThanOrEqual(2 * longest);
    expect(piece.part).toMatchObject({ tablesBefore: 1, first: false, last: false });
    expect(piece.sourceMap.tables).toHaveLength(1);
    expect(piece.markdown.length).toBeLessThan(3 * markdown);
  });

  it("a new table's number costs its piece once more", () => {
    let { store, base } = linesKept();
    let call: TableCall = {
      method: "insertTable", table: { rows: 1, columns: 1, cells: [["new"]], after: LINES[7_000] },
    };
    let walks = vi.spyOn(DocStore.prototype, "walk");
    let pieces = vi.spyOn(DocStore.prototype, "piece");
    let before = { ...docStoreCost };

    let prepared = prepareTableChange(store, base, call, "the tab");

    // One table stands before line 7,000.
    expect(prepared.table).toBe(1);
    // The paragraph's closure stands in one run. Before the edit: the tables' cells summed,
    // the scan for the text the table follows and the pass that places the piece (three
    // walks), and the piece (one run decoded and rendered), which the slice takes; the run
    // is cut in three, each rendered. For the number, once the edit is made: the anchor's
    // place is remembered, so one walk more, to the piece's place, and the piece made
    // again (its one run decoded and rendered a second time). For the card: one walk of the
    // summaries of the runs before the ones that differ, and nothing decoded or rendered.
    expect(pieces).toHaveBeenCalledTimes(1 + 1);
    expect(walks).toHaveBeenCalledTimes(3 + 1 + 1);
    expect(docStoreCost.runsDecoded - before.runsDecoded).toBe(1 + 1);
    expect(docStoreCost.runsRendered - before.runsRendered).toBe(1 + 3 + 1);
    expect(docStoreCost.pieceWidenings - before.pieceWidenings).toBe(0);
    store.sweep("edit-counts", { edits: [], roots: [] });
  });

  it("a chain of three edits made again decodes the run of each edit's piece, and none for the model", () => {
    let { store, base } = linesKept();
    let change = (at: number): QueuedDocRecord => ({
      id: at, action: {
        type: "replaceText", oldMarkdown: LINES[at], newMarkdown: `Changed ${at}.`, tabId: "t1",
        markdownVersion: MARKDOWN_RENDERING_VERSION,
      },
    });
    let queue = [change(7), change(9_000), change(19_999)];
    let fold = () => createSimulationStore(docTabReducer(store)).fold("t1", base, queue);
    let listed = (version: DocVersion) => linesKept().storage.sql.exec<{ runs: number }>(
      "SELECT COUNT(*) AS runs FROM doc_seq WHERE version = ?", version.id).one().runs;
    fold();
    // Made again: what the first fold stored is removed, as a change of the code's digest
    // leaves it unread.
    store.sweep("doc", { edits: [], roots: [] });
    let before = { ...docStoreCost }, clones = replayCost.tabClones;

    let again = fold();

    // Each edit changes one paragraph whose closure stands in one run: that run is decoded
    // for the piece the builders read, and the model's slice takes it as it was decoded.
    // Nothing is decoded of the other runs of the version each edit is made in (the first
    // edit leaves one run more).
    let runs = listed(base);
    expect(listed(again.entity!)).toBe(runs + 1);
    expect(docStoreCost.runsDecoded - before.runsDecoded).toBe(1 + 1 + 1);
    expect(replayCost.tabClones - clones).toBe(0);
  });
});

describe("the statements an edit runs", () => {
  const LISTED = listedTablesTab("t1", 600);
  const RUNS = 1_201;
  // The runs the piece around a table of this tab decodes: an empty paragraph stands between
  // each two tables, so a step of the closure ends on the next table, and the closure is four
  // runs before the table's and four after it. Tried from the table's run (1) and from the
  // run before (2), scouted 2 and then 4 runs back (3 and 5), and made from its first run (9).
  const PIECE = 1 + 2 + 3 + 5 + 9;
  const EDIT: DocEdit = {
    type: "replaceText", oldMarkdown: "cell 300", newMarkdown: "cell changed", inTable: true,
  };
  /** What `call` costs a store of the digest `digest` over a counter on `storage`. */
  function cost(storage: FakeDocStorage, digest: string, call: (store: DocStore) => unknown) {
    let counted = countedStorage(storage);
    let store = under(counted.storage, digest);
    return { ...spent(counted, () => call(store)), ran: counted.ran() };
  }

  it("an edit reads its context once for each pass of its piece and three times for its slice", () => {
    let { storage, base } = keptUnder(fakeDocStorage(), LISTED, "a");

    // The piece around the table is made in five passes (from the table's run, from the run
    // before, two scouts and the piece itself: `PIECE` runs decoded), each of which reads the
    // named styles once and, by one statement, the definitions the page its runs stand in
    // names; then the slice's definitions, asked for by the one id its run names, the ids of
    // the model's form, and the named styles once more. NEVER A NUMBER OF RUNS: the scan and
    // the pass that places the piece read no context.
    let whole = cost(storage, "a", a => docEditResult(a, base, EDIT));
    expect(whole).toMatchObject({ styles: 5 + 1, lists: 5 + 2, runsDecoded: PIECE });
  });

  it("the first edit after a deploy keys its version once and reads no context for a run", () => {
    let { storage, base } = keptUnder(fakeDocStorage(), LISTED, "a");

    // Decoded: every run for the question whether the model follows the tab and for the
    // keying the scan of the tab's stored Markdown asks for (2 * RUNS), and the piece's runs,
    // of which the slice takes its one. Rendered: every run by the keying (RUNS), the piece's
    // runs, and the run cut. Over the context: the ids of the model's form for the question
    // (1), a page each for the keying (3), one statement for each pass of the piece (5), the
    // slice's definitions by id and the model's ids (2); the named styles for the keying, for
    // each pass of the piece and for the slice.
    let first = cost(storage, "b", b => {
      expect(b.unindexed(base)).toBe(false);
      docEditResult(b, base, EDIT);
    });
    expect(first).toMatchObject({
      runsDecoded: 2 * RUNS + PIECE, runsRendered: RUNS + PIECE + 1, lists: 1 + 3 + 5 + 2,
      styles: 1 + 5 + 1,
    });
    let { derived } = storage.sql.exec<{ derived: string }>(
      "SELECT derived FROM doc_version WHERE doc = ? AND id = ?", base.doc, base.id).one();
    expect(JSON.parse(derived)).toEqual({ made: "b", unindexed: false, keyed: true });

    // The second edit of that version costs what an edit costs.
    let second = cost(storage, "b", b => docEditResult(b, base, {
      type: "replaceText", oldMarkdown: "cell 301", newMarkdown: "cell other", inTable: true,
    }));
    expect(second).toMatchObject({ styles: 5 + 1, lists: 5 + 2, runsDecoded: PIECE });
  });

  it("every statement of an edit is planned and scans no content table", () => {
    let { storage, base } = keptUnder(fakeDocStorage(), LISTED, "a");
    let counted = countedStorage(storage);
    let store = under(counted.storage, "a");
    let other = under(counted.storage, "b");

    // An edit, and one more of the same version; the first edit under another digest; a
    // table change's card and result; a batch that widens; and the base version's Markdown read.
    let made = docEditResult(store, base, EDIT);
    store.summary(made.after);
    expect(store.markdown(made.after)).toContain("cell changed");
    docEditResult(store, base, {
      type: "replaceText", oldMarkdown: "cell 301", newMarkdown: "cell other", inTable: true,
    });
    other.unindexed(base);
    docEditResult(other, base, EDIT);
    let before = docStoreCost.viewWidenings;
    // Text typed in the first table's cell, then in the sixth's at the index the first moved:
    // the second index is not counted, so the model reads past the first table's run.
    let cellStart = (table: number) => LISTED.body.content.filter(element => element.table)[table]
      .table!.tableRows![0].tableCells![0].content![0].startIndex!;
    let typed = (index: number, text: string) => ({ insertText: { location: { index, tabId: "t1" }, text } });
    let { slice, made: widened } = editedSlice(
      store, base, "byHand", [typed(cellStart(0), "x"), typed(cellStart(5) + 1, "y")]);
    store.putSlice(slice, widened);
    expect(docStoreCost.viewWidenings - before).toBe(1);
    expect(store.markdown(base)).toBe(docTabToMarkdown(LISTED).markdown);
    // A card's reads: where the two lists differ, a reader of each version forwards and
    // backwards, and the strings of the runs that differ.
    let changed = store.changed(base, made.after);
    expect(changed.beforeTo).toBeGreaterThan(changed.from);
    for (let back of [false, true]) {
      let next = store.reader(made.after, changed.afterTo - (back ? 0 : 1), back);
      expect(next()!.markdown()).toContain("cell changed");
    }
    expect(changedMarkdown(store, base, made.after).after).toContain("cell changed");
    // The two statements that compare the lists ran, and are planned with the rest.
    let compared = counted.ran().filter(statement => /FROM doc_seq AS b\s+LEFT JOIN doc_seq AS a/.test(statement));
    expect(compared).toHaveLength(2);
    for (let statement of compared) {
      expect(storage.plan(statement).every(step => step.includes("USING PRIMARY KEY"))).toBe(true);
    }

    expect(tableScans(storage, counted.ran())).toEqual({});
    expect(storage.arrays().filter(statement => /^SELECT (json|md)\b/.test(statement))).toEqual([]);
    expect(storage.openCursors()).toBe(0);
  });
});
