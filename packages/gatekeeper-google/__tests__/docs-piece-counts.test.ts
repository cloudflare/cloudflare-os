// What a pending read, a queued edit, a preview's card made again, a replay, an approval and
// a rejection of a stored Google Doc decode, render, hold as strings, run as statements and
// write, on a tab of 20,000 paragraphs and on a tab of thousands of runs. The cases are one
// scenario (`pieceCountsScenario`), run here on the Node fake and in workerd on real storage
// (`workerd/docs-piece.test.ts`, which also pins the rows read as storage bills them), and
// held to one function of the tab's runs and places (`pieceCountsExpected`): a case is added
// to the scenario, never to a test file. What is this file's alone is what reads no run at
// all: the outline a replay folds, and the small rows of the store and of a copy that an
// approval and a rejection ask before they build.

import { describe, expect, it } from "vitest";
import { blankDocTabIdentity, replayGoogleDoc, type GoogleDocPendingAction } from "../src/doc-actions";
import { storedDocCopy } from "../src/docs-copy";
import { docEditKey, docEditResult, type DocEdit } from "../src/docs-replay";
import { DocStore, docStoreCost } from "../src/docs-store";
import { MARKDOWN_RENDERING_VERSION } from "../src/markdown-converter";
import { fakeDocStorage } from "./doc-store-fake";
import {
  closurePieceScenario, linesWithTablesTab, pieceCost, pieceCountsExpected, pieceCountsScenario,
  scenarioBase, wholeTabsFetched,
} from "./doc-store-scenarios";
import { WIDER } from "./wider-run";

/**
 * The two shapes, each at two sizes: the tab every bound is stated on, and a smaller one that
 * shows which figures are the tab's and which the piece's. The tables shape is 2,000 pairs by
 * default (4,001 runs) and, in the wider run, the 9,800 pairs a 10 MiB answer can hold
 * (19,601 runs). ON 9,800 PAIRS NO ROW AND NO TABLE CAN BE ADDED: the tab's tables hold more
 * cells than a tab's may once they hold 5,000, so the scenario has those cases to 4,900
 * pairs (9,801 runs), which the wider run holds to their formulas too.
 */
const SHAPES = [
  { shape: "prose", size: 20_000, smaller: 5_000 },
  { shape: "tables", size: WIDER ? 9_800 : 2_000, smaller: WIDER ? 4_900 : 1_000 },
] as const;

// Each scenario is run once a file: a tab is kept once, and each case sweeps after itself.
const answers = new Map<string, ReturnType<typeof pieceCountsScenario>>();
function scenario(shape: "prose" | "tables", size: number) {
  let key = `${shape} ${size}`;
  let answer = answers.get(key) ?? pieceCountsScenario(fakeDocStorage(), shape, size);
  answers.set(key, answer);
  return answer;
}

describe.each(SHAPES)("what each step takes in hand, on $shape", ({ shape, size, smaller }) => {
  it.each([size, smaller])("holds every case to its formula, on a tab of %i", tabSize => {
    let { tab, cases } = scenario(shape, tabSize);
    let expected = pieceCountsExpected(shape, tab);
    expect(Object.keys(cases).toSorted()).toEqual(Object.keys(expected).toSorted());
    for (let [name, held] of Object.entries(expected)) {
      // `rows` is real storage's (`workerd/docs-piece.test.ts`): the fake bills none.
      let { markdown, rows: _rows, ...counts } = held;
      let measured = cases[name];
      // The runs decoded and rendered, the widenings, the statements by kind, those that
      // write and the rows each table gains.
      expect({
        name, runsDecoded: measured.runsDecoded, runsRendered: measured.runsRendered,
        pieceWidenings: measured.pieceWidenings, pages: measured.pages, joined: measured.joined,
        content: measured.content, writes: measured.writes,
        ...(measured.stored ? { stored: measured.stored } : {}),
      }).toEqual({ name, ...counts });
      // The fake counts a changed row once: what a case writes is the rows its tables gain,
      // and nothing for a case that makes no edit.
      let gained = Object.values(counts.stored ?? {}).reduce((sum, rows) => sum + rows, 0);
      expect({ name, rowsWritten: measured.rowsWritten }).toEqual({ name, rowsWritten: gained });
      expect({ name, ok: measured.ok, restored: measured.restored })
        .toEqual({ name, ok: true, restored: true });
      // One run's JSON in hand at a time, of the tab's or of what the case stored.
      expect(measured.peakRun, name).toBeLessThanOrEqual(measured.longestRun);
      let bound = markdown.runs * measured.longestMarkdown + markdown.texts * measured.text;
      if (markdown.exact) expect(measured.peakMarkdown, name).toBe(bound);
      else expect(measured.peakMarkdown, name).toBeLessThanOrEqual(bound);
    }
  });

  it("decodes and renders the piece's runs, whatever the tab's length", () => {
    let large = scenario(shape, size), small = scenario(shape, smaller);
    expect(large.tab.n).toBeGreaterThan(1.9 * small.tab.n);
    let runs = ({ cases }: typeof large) => Object.fromEntries(Object.entries(cases).map(
      ([name, { runsDecoded, runsRendered, pieceWidenings }]) =>
        [name, { runsDecoded, runsRendered, pieceWidenings }]));
    // A tab whose tables are full has no case that adds a cell: the cases both have.
    expect(runs(large)).toEqual(Object.fromEntries(
      Object.entries(runs(small)).filter(([name]) => name in large.cases)));
    // The pending read is the floor: it answers the tab's Markdown, and holds it.
    for (let { tab, cases } of [large, small]) {
      expect(cases.pendingRead.peakMarkdown).toBeGreaterThan(tab.whole);
      expect(cases.pendingRead.runsDecoded + cases.pendingRead.runsRendered).toBe(0);
    }
  });
});

describe("what the cases show of the tab they stand on", () => {
  it("has a tab of 20,000 paragraphs under one page of runs, and one of thousands of runs", () => {
    let prose = scenario("prose", 20_000).tab, tables = scenario("tables", SHAPES[1].size).tab;
    expect(prose.n).toBeLessThan(500);
    expect(prose.whole).toBeGreaterThan(2 * 1024 * 1024);
    expect(tables.n).toBe(2 * SHAPES[1].size + 1);
    expect(tables.pages).toBe(Math.ceil(tables.n / 500));
  });

  // THE MULTIPLE OF THE EDIT'S TEXT, which every other case hides behind a small edit. `O`
  // runs of own elements and the run after them are decoded and rendered, on 5,000
  // paragraphs as on 20,000. The counter's peak is the card's two strings together
  // (`changedMarkdown` counts them as it joins them): twice the text and a few lines, where
  // a piece's joined Markdown and each string alone are about once the text.
  it("a large edit decodes its own runs and one, and its card's two strings are twice its text", () => {
    for (let size of [20_000, 5_000]) {
      let { tab, cases } = scenario("prose", size);
      let { own, cut } = tab.large!;
      expect(own).toBeGreaterThan(20);
      expect(cut).toBeGreaterThan(15);
      expect(cases.largeEdit.text).toBeGreaterThan(0.45 * 1024 * 1024);
      expect(cases.largeEdit.runsDecoded).toBe(own + 1);
      expect(cases.largeEdit.runsRendered).toBe(own + 1 + cut);
      for (let name of ["largeEdit", "largeEditAgain"]) {
        let { peakMarkdown, text, longestMarkdown, peakRun, longestRun } = cases[name];
        expect(peakMarkdown).toBeGreaterThan(2 * text);
        expect(peakMarkdown).toBeLessThan(2 * text + longestMarkdown);
        expect(peakRun).toBeLessThanOrEqual(longestRun);
      }
    }
  });

  it("a scan of a text of 1 MiB holds the text and the longest run, exactly", () => {
    let { cases } = scenario("prose", 20_000);
    expect(cases.scan.text).toBeGreaterThan(1024 * 1024);
    expect(cases.scan.peakMarkdown).toBe(cases.scan.text + cases.scan.longestMarkdown);
    expect(cases.scan.peakRun).toBe(0);
  });
});

describe("a piece whose closure is the document's", () => {
  let answer: ReturnType<typeof closurePieceScenario> | undefined;
  const closures = () => answer ??= closurePieceScenario(fakeDocStorage());

  // Under runs of one element the section break that opens the body is run 0. Beside 200
  // empty paragraphs: `X A B Lead`, the empty ones, `Tail C D Y`, with `Tail` at 205; its
  // closure is `B` to `D`, runs 3 to 207. Under 3,000 nested items: a paragraph, the level-0
  // item at 2, the items, the item changed at 3,003 and a paragraph; its closure is the
  // level-0 item to that paragraph, runs 2 to 3,004.
  it.each([
    ["breaksByElement", { n: 209, place: 205, from: 3, to: 208 }],
    ["nestedByElement", { n: 3_005, place: 3_003, from: 2, to: 3_005 }],
  ] as const)("stands where the closure does under runs of one element: %s", (name, stands) => {
    let { n, place, from, to } = closures()[name];
    expect({ n, place, from, to }).toEqual(stands);
  });

  it.each(["breaks", "breaksByElement", "nested", "nestedByElement"] as const)(
    "decodes by the formula with its scouts, keeps decoded the own run and the one before, and holds its Markdown: %s",
    name => {
      let piece = closures()[name];
      let before = piece.place - piece.from, after = piece.to - 1 - piece.place;
      let cost = pieceCost(piece.place, before, 1, after);
      expect({
        runsDecoded: piece.runsDecoded, runsRendered: piece.runsRendered, pieceWidenings: piece.pieceWidenings,
      }).toEqual({ runsDecoded: cost.runs, runsRendered: cost.runs, pieceWidenings: cost.widenings });
      // Never a run after the own, and of the runs before it the one before the place alone.
      expect(piece.decoded).toEqual(before > 0 ? [piece.place - 1, piece.place] : [piece.place]);
      // The joined piece, or a scout's one run: the closure's Markdown and a run at most.
      expect(piece.peakMarkdown).toBeGreaterThanOrEqual(piece.closure);
      expect(piece.peakMarkdown).toBeLessThanOrEqual(piece.closure + piece.longestMarkdown);
      // Queued end to end the piece is made once: the model's slice takes the own run from
      // it and decodes none.
      expect(piece.edit).toEqual({ runsDecoded: cost.runs, pieceWidenings: cost.widenings, ok: true });
    });

  it("is one run beside the empty paragraphs and every run under the nested items, under the store's sizes", () => {
    let { breaks, nested } = closures();
    expect({ n: breaks.n, from: breaks.from, to: breaks.to }).toEqual({ n: 1, from: 0, to: 1 });
    expect(nested.n).toBeGreaterThan(20);
    expect({ place: nested.place, from: nested.from, to: nested.to }).toEqual({ place: nested.n - 1, from: 0, to: nested.n });
  });
});

describe("the small readers render nothing", () => {
  const LINES = Array.from({ length: 20_000 }, (_, at) => `Line ${String(at).padStart(5, "0")}.`);
  const EDIT: DocEdit = { type: "replaceText", oldMarkdown: LINES[12_000], newMarkdown: "Changed." };
  /** The marker of a write that landed, as a fetch finds it in the tab. */
  const MARKER = { writeId: "write-9", id: "marker-9" };
  /** The tab of 20,000 lines kept with `writeMarkers`, and the edit made in it, its result stored. */
  const kept = (writeMarkers: readonly (typeof MARKER)[] = []) => {
    let store = new DocStore(fakeDocStorage());
    let pending = { edits: [docEditKey(EDIT)], roots: [] };
    let tab = linesWithTablesTab("t1", LINES, [5_000]);
    let head = store.keep(
      "doc", wholeTabsFetched({ revision: "r1", fetchedAt: 1_000, tabs: [{ tab, writeMarkers }] }), pending);
    let base = scenarioBase(store, "doc", head);
    docEditResult(store, base, EDIT);
    return { store, head, base, copy: storedDocCopy(store, "doc", head, { pending: () => pending }) };
  };
  /** What `run` moved of the runs decoded and rendered, and the Markdown it held. */
  const moved = (run: () => unknown) => {
    let before = { ...docStoreCost };
    docStoreCost.peakMarkdownCharsInHand = 0;
    run();
    return {
      runsDecoded: docStoreCost.runsDecoded - before.runsDecoded,
      runsRendered: docStoreCost.runsRendered - before.runsRendered,
      peakMarkdown: docStoreCost.peakMarkdownCharsInHand,
    };
  };
  const NOTHING = { runsDecoded: 0, runsRendered: 0, peakMarkdown: 0 };
  const pendingEdit: GoogleDocPendingAction = {
    id: 1,
    action: { ...EDIT, tabId: "t1", markdownVersion: MARKDOWN_RENDERING_VERSION, writeId: "write-1" },
  } as GoogleDocPendingAction;
  const pendingAdd = {
    id: 2,
    action: { type: "addTab", provisionalTabId: "pending-tab-2", title: "Added", writeId: "write-2" },
  } as GoogleDocPendingAction;

  // THE SMALL ROWS an approval and a rejection ask before they build anything: a tab's
  // version with its write markers (a write that already landed is settled from them),
  // whether the model follows the tab, the result a replay stored, and whether a version is
  // stored. Each read is the copy's or the store's own, held here one by one. THE CALLERS
  // that ask them, an approval's plan from the copy and a rejection's check that the copy
  // reads back, are private to their modules and are held through the sessions
  // (`workerd/google-doc-actions.test.ts`, "what a Google Doc session takes in hand": an
  // approval with a result stored, one whose write's marker is in the copy, the approval of
  // an add of a tab and a rejection, each to its exact counts).
  it("a copy's tab and its write markers, whether the model follows it, a stored result and whether a version is stored are small rows", () => {
    let { store, copy } = kept([MARKER]);
    let read: { markers: unknown; unindexed: boolean; stored: boolean; requests: number } | undefined;
    expect(moved(() => {
      let base = copy.tab("t1")!;
      let result = store.result(base, docEditKey(EDIT));
      read = {
        markers: base.writeMarkers, unindexed: store.unindexed(base), stored: store.has(base),
        requests: result && "requests" in result ? result.requests.length : 0,
      };
    })).toEqual(NOTHING);
    expect(read).toEqual({ markers: [MARKER], unindexed: false, stored: true, requests: expect.any(Number) });
    expect(read!.requests).toBeGreaterThan(0);
  });

  it("the outline's fold reads no tab", () => {
    let { copy } = kept();
    let invalidated: number[] = [];
    let outline: readonly { tabId: string }[] = [];
    expect(moved(() => {
      outline = replayGoogleDoc(
        { pending: () => [pendingEdit, pendingAdd], invalidate: record => invalidated.push(record.id) },
        copy, "A read").outline;
    })).toEqual(NOTHING);
    expect(outline.map(({ tabId }) => tabId))
      .toEqual(["t1", blankDocTabIdentity("pending-tab-2", "Added").tabId]);
    expect(invalidated).toEqual([]);
  });
});
