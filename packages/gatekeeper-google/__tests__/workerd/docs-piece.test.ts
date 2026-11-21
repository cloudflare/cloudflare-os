// `pieceCountsScenario` on real storage: the fake's counts, and the rows each case reads as
// billed (`pieceCountsExpected(...).rows` plus `PIECE_ROWS`).

import { describe, expect, it } from "vitest";
import {
  PIECE_ROWS, pieceCountsExpected, pieceCountsScenario,
} from "../doc-store-scenarios";
import { withDocStore } from "./doc-store-host";

/** The two shapes at the size their rows are pinned on, and a smaller one where the formula holds to a page. */
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
      // Rows written as billed: each row gained, and one more for each indexed run, rendering and result.
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

  // Rows read as billed; each case's terms are in `pieceCountsExpected`.
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

  it("reads rows of the list and of renderings, in proportion to the tab's runs", async () => {
    let { tab, cases } = await scenario(size);
    let perRun = (name: string) => cases[name].rowsRead / tab.n;
    // A scan and a pending read: a row of the list, of the rendering and of its Markdown a run.
    expect(perRun("scan")).toBeCloseTo(3, 1);
    expect(perRun("pendingRead")).toBeCloseTo(3, 1);
    // An approval while the pin holds reads the stored result, whatever the tab.
    expect(cases.approvalStored.rowsRead).toBe(3);
    expect(cases.replayAgain.rowsRead).toBe(12);
    if (shape === "prose") {
      expect(perRun("replaceMiddle")).toBeLessThan(23);
      expect(perRun("tableAfterLine")).toBeLessThan(30);
    } else {
      // A table added at the end makes its piece twice.
      expect(perRun("replaceMiddle")).toBeLessThan(28);
      expect(perRun("tableAtEnd")).toBeLessThan(51);
      expect(perRun("tableAtEnd")).toBeGreaterThan(49);
    }
  });
});
