// What a pending read, a queued edit, a preview's card made again, a replay, an approval and
// a rejection of a stored Google Doc take in hand ON REAL STORAGE: the scenario the Node
// tests run on the fake (`pieceCountsScenario`, `docs-piece-counts.test.ts`), held here to
// the same counts and, since only a Durable Object's storage says them, to THE ROWS IT READS
// AS BILLED, each case a formula in the tab's runs and the places its pieces stand at
// (`pieceCountsExpected(...).rows`) and a small constant (`PIECE_ROWS`).
//
// THROUGH THE SESSIONS, for a bound Doc and for a Doc opened from a read and write Drive
// binding, the same steps are held with the requests Google is sent in
// `google-doc-actions.test.ts` ("what a Google Doc session takes in hand"), beside the fake
// of Google's API that file builds: this file reaches the store alone.
//
// COUNTS, ROWS AND NO HEAP: the workerd pool exposes no collector. What a call holds as live
// heap, and that nothing of a document is held once it returns, is measured in Node
// (`docs-piece-heap.test.ts`).

import { describe, expect, it } from "vitest";
import {
  PIECE_ROWS, pieceCountsExpected, pieceCountsScenario,
} from "../doc-store-scenarios";
import { withDocStore } from "./doc-store-host";

/**
 * The two shapes at the size their rows are pinned on, and a smaller one on which the same
 * formula holds to a reader's page: 16 rows, the eight runs of one page with their
 * renderings, by which a card's constant moves where its readers' pages stand otherwise in
 * the list.
 */
const SHAPES = [
  { shape: "prose", size: 20_000, smaller: 5_000 },
  { shape: "tables", size: 2_000, smaller: 1_000 },
] as const;

describe.each(SHAPES)("what each step takes in hand on real storage, on $shape", ({ shape, size, smaller }) => {
  const answers = new Map<number, Promise<ReturnType<typeof pieceCountsScenario>>>();
  /** The scenario on a tab of `of`, run once on a Durable Object's storage of its own. */
  const scenario = (of: number) => {
    let answer = answers.get(of) ?? withDocStore((_, storage) => pieceCountsScenario(storage, shape, of));
    answers.set(of, answer);
    return answer;
  };

  it.each([size, smaller])("gives the counts the fake gives, on a tab of %i", async of => {
    let { tab, cases } = await scenario(of);
    let expected = pieceCountsExpected(shape, tab);
    expect(Object.keys(cases).toSorted()).toEqual(Object.keys(expected).toSorted());
    for (let [name, held] of Object.entries(expected)) {
      let { markdown, rows: _rows, ...counts } = held;
      let measured = cases[name];
      expect({
        name, runsDecoded: measured.runsDecoded, runsRendered: measured.runsRendered,
        pieceWidenings: measured.pieceWidenings, pages: measured.pages, joined: measured.joined,
        content: measured.content, writes: measured.writes,
        ...(measured.stored ? { stored: measured.stored } : {}),
      }).toEqual({ name, ...counts });
      expect({ name, ok: measured.ok, restored: measured.restored })
        .toEqual({ name, ok: true, restored: true });
      // ROWS WRITTEN, as billed: a row for each row a table gains, and one more for each
      // run, each rendering and each result, whose tables keep an index beside their rows.
      let { doc_run: runs = 0, doc_md: renderings = 0, doc_result: results = 0 } = counts.stored ?? {};
      let gained = Object.values(counts.stored ?? {}).reduce((sum, rows) => sum + rows, 0);
      expect({ name, rowsWritten: measured.rowsWritten })
        .toEqual({ name, rowsWritten: gained + runs + renderings + results });
      expect(measured.peakRun, name).toBeLessThanOrEqual(measured.longestRun);
      let bound = markdown.runs * measured.longestMarkdown + markdown.texts * measured.text;
      if (markdown.exact) expect(measured.peakMarkdown, name).toBe(bound);
      else expect(measured.peakMarkdown, name).toBeLessThanOrEqual(bound);
    }
  });

  // ROWS READ, as billed: a row of a table a statement steps to. Each case's terms are
  // written out in `pieceCountsExpected`'s comment: a walk of the list's joined pages for
  // what is asked of the tab as a whole (uniqueness reads each run's Markdown too), a pass
  // of the piece for each attempt and scout (the version's totals, the joined pages before
  // its first run, a page of the list, each run found and read), the slice and its version,
  // and the card's two comparisons of the lists and its readers.
  it("reads the rows each case's formula gives", async () => {
    let { tab, cases } = await scenario(size);
    let expected = pieceCountsExpected(shape, tab);
    let formula = Object.fromEntries(Object.entries(expected).map(
      ([name, { rows }]) => [name, rows + PIECE_ROWS[shape][name]]));
    expect(Object.fromEntries(Object.entries(cases).map(([name, { rowsRead }]) => [name, rowsRead])))
      .toEqual(formula);
  });

  it("reads them by the same formula on a smaller tab, to a reader's page", async () => {
    let { tab, cases } = await scenario(smaller);
    let expected = pieceCountsExpected(shape, tab);
    for (let [name, { rows }] of Object.entries(expected)) {
      let off = cases[name].rowsRead - (rows + PIECE_ROWS[shape][name]);
      expect(Math.abs(off), `${name}: ${cases[name].rowsRead} rows read`).toBeLessThanOrEqual(16);
    }
  });

  // What the walks of the list cost where a tab is thousands of runs: stated, not hidden.
  it("reads rows of the list and of renderings, in proportion to the tab's runs", async () => {
    let { tab, cases } = await scenario(size);
    let perRun = (name: string) => cases[name].rowsRead / tab.n;
    // A scan and a pending read: a row of the list, of the rendering and of its Markdown.
    expect(perRun("scan")).toBeCloseTo(3, 1);
    expect(perRun("pendingRead")).toBeCloseTo(3, 1);
    // An approval while the pin holds reads the stored result, whatever the tab.
    expect(cases.approvalStored.rowsRead).toBe(3);
    expect(cases.replayAgain.rowsRead).toBe(12);
    if (shape === "prose") {
      // One page of runs: an edit reads its list a few tens of times.
      expect(perRun("replaceMiddle")).toBeLessThan(23);
      expect(perRun("tableAfterLine")).toBeLessThan(30);
    } else {
      // Five passes of a piece, each a walk of the list to its place: 27 rows a run of the
      // tab for a replacement, 50 for a table added at the end, whose piece is made twice.
      expect(perRun("replaceMiddle")).toBeLessThan(28);
      expect(perRun("tableAtEnd")).toBeLessThan(51);
      expect(perRun("tableAtEnd")).toBeGreaterThan(49);
    }
  });
});
