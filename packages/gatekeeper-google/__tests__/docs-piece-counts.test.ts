// What each step of a stored Google Doc decodes, renders, holds and runs (`pieceCountsScenario`,
// held to `pieceCountsExpected`; its rows read are held in `workerd/docs-piece.test.ts`), pieces
// whose closure is the document's, and the small rows that read no run.

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

/** The tab every bound is stated on, by shape; workerd also holds a smaller one of each. */
const SHAPES = [
  { shape: "prose", size: 20_000 }, { shape: "tables", size: WIDER ? 9_800 : 2_000 },
] as const;

// Each scenario is run once a file: a tab is kept once, and each case sweeps after itself.
const answers = new Map<string, ReturnType<typeof pieceCountsScenario>>();
function scenario(shape: "prose" | "tables", size: number) {
  let key = `${shape} ${size}`;
  let answer = answers.get(key) ?? pieceCountsScenario(fakeDocStorage(), shape, size);
  answers.set(key, answer);
  return answer;
}
const prose = () => scenario("prose", 20_000);

describe.each(SHAPES)("what each step takes in hand, on $shape", ({ shape, size }) => {
  it("holds every case to its formula", () => {
    let { tab, cases } = scenario(shape, size);
    let expected = pieceCountsExpected(shape, tab);
    expect(Object.keys(cases).toSorted()).toEqual(Object.keys(expected).toSorted());
    for (let [name, held] of Object.entries(expected)) {
      // `rows` is real storage's (`workerd/docs-piece.test.ts`): the fake bills none.
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
      expect(measured.peakRun, name).toBeLessThanOrEqual(measured.longestRun);
      let bound = markdown.runs * measured.longestMarkdown + markdown.texts * measured.text;
      if (markdown.exact) expect(measured.peakMarkdown, name).toBe(bound);
      else expect(measured.peakMarkdown, name).toBeLessThanOrEqual(bound);
    }
  });
});

describe("what the cases show of the tab they stand on", () => {
  it("has a tab of 20,000 paragraphs under one page of runs, and one of thousands of runs", () => {
    let tables = scenario("tables", SHAPES[1].size).tab;
    expect(prose().tab.n).toBeLessThan(500);
    expect(prose().tab.whole).toBeGreaterThan(2 * 1024 * 1024);
    expect(tables.n).toBe(2 * SHAPES[1].size + 1);
    expect(tables.pages).toBe(Math.ceil(tables.n / 500));
  });

  // The card counts its two strings together: the peak is twice the edit's text and under a run more.
  it("a large edit decodes its own runs and one, and its card's two strings are twice its text", () => {
    let { tab, cases } = prose();
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
  });

  it("a scan of a text of 1 MiB holds the text and the longest run, exactly", () => {
    let { cases } = prose();
    expect(cases.scan.text).toBeGreaterThan(1024 * 1024);
    expect(cases.scan.peakMarkdown).toBe(cases.scan.text + cases.scan.longestMarkdown);
    expect(cases.scan.peakRun).toBe(0);
  });
});

describe("a piece whose closure is the document's", () => {
  let answer: ReturnType<typeof closurePieceScenario> | undefined;
  const closures = () => answer ??= closurePieceScenario(fakeDocStorage());

  // Under runs of one element: `Tail` at 205 beside 200 empty paragraphs, and the item changed at
  // 3,003 under 3,000 nested items, each with the closure it stands in.
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

  // What an approval and a rejection ask before they build: small rows, no run decoded or rendered.
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
