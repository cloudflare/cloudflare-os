// What an edit asks of its stored tab as a whole, answered from stored rows: the two scans of
// Markdown handed a run at a time held to a search of the joined string, a walk of some of a
// version's runs held to the walk of them all, the stored reading held to the reading of the
// whole rendering (also where a walk hands its runs again), and what a member decodes, holds
// and throws.
// Node only: the storage is the fake and the heap is Node's.
// It replaces a module for every test of its file: the renderer's `renderRun` as other
// modules import it, which throws on a run that holds the text `FAULT` while `fault.on`.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GoogleDocsTab, StructuralElement } from "../src/docs-api";
import {
  DocReadingFault, markdownScan, MAX_SCAN_FOLLOWED, storedTabReading, unwrapped, windowScan,
} from "../src/docs-reading";
import { renderTab } from "../src/docs-replay";
import { DOC_COPY_UNREADABLE } from "../src/docs-replica";
import { RUN_SIZES, type RunSizes } from "../src/docs-runs";
import {
  DocPieceError, DocRunRenderError, docStoreCost, DocStore, type DocPiece, type DocVersion,
} from "../src/docs-store";
import {
  checkTabTableCells, checkTableTarget, resolveTable, tableIdentity, tableShape, wholeTabReading,
} from "../src/docs-tables";
import type { OwnRange, TabReading } from "../src/markdown-converter";
import { buildTab, diceOf, grid, item, NUMBERED_LIST, para, tableAt, thrownMessage } from "./doc-fixture";
import type { FakeDocStorage } from "./doc-store-fake";
import { proseTab, tinyTablesTab } from "./doc-store-scenarios";
import { readFixtures } from "./docs-live-fixtures";
import {
  closureIn, expectPieceOfWhole, ownIn, pieceStore, silentRunTabs, wholeOf, type Whole,
} from "./docs-piece-shadow";
import { pieceTabs } from "./docs-piece-tabs";
import { asFetched } from "./docs-store-slice-shadow";
import { collect, HEAP_MEASURED, heapHeld } from "./heap-held";
import { WIDER } from "./wider-run";

/** Whether the store's renderer throws on a run that holds the text `FAULT`. */
const fault = vi.hoisted(() => ({ on: false }));

// The module as it is but for `renderRun` as other modules import it: the rendering of a tab
// in hand calls the module's own, so only the store's rendering of a run can fail.
vi.mock("../src/markdown-converter", async importOriginal => {
  let converter = await importOriginal<typeof import("../src/markdown-converter")>();
  let renderRun: typeof converter.renderRun = (elements, ...rest) => {
    if (fault.on && JSON.stringify(elements).includes("FAULT")) throw new Error("renderer fault");
    return converter.renderRun(elements, ...rest);
  };
  return { ...converter, renderRun };
});

const MIB = 1024 * 1024;

/** Sizes that cut a tab into runs of `elements` elements at most. */
const runsOf = (elements: number): RunSizes => ({ least: 0, target: 400, most: Infinity, elements });
const SIZINGS: readonly (readonly [string, RunSizes])[] = [
  ["one element a run", runsOf(1)], ["two elements a run", runsOf(2)],
  ["three elements a run", runsOf(3)], ["the real cut", RUN_SIZES],
];

// ---------------------------------------------------------------------------
// The two scans
// ---------------------------------------------------------------------------

type Found = number | "none" | "many";
type Scan = { take(run: string): boolean; done(): Found | "crowded" };
const SCANS: readonly (readonly [string, (text: string, lineBreakBefore?: boolean) => Scan])[] =
  [["markdownScan", markdownScan], ["windowScan", windowScan]];

/** What a search of `joined` answers, the string whole: the scans' reference. */
function searched(joined: string, text: string, lineBreakBefore = false): Found {
  let padded = lineBreakBefore ? `\n${joined}` : joined;
  let first = padded.indexOf(text);
  if (first < 0) return "none";
  if (padded.indexOf(text, first + 1) >= 0) return "many";
  return lineBreakBefore ? first - 1 : first;
}

/** What `scan` answers of `parts` handed in order, none after it says it needs no more. */
function scanned(scan: Scan, parts: readonly string[]): Found | "crowded" {
  for (let part of parts) {
    if (!scan.take(part)) break;
  }
  return scan.done();
}

/** `string` cut after each of `cuts`, which rise. */
function cutAt(string: string, cuts: readonly number[]): string[] {
  let ends = [...cuts, string.length];
  return ends.map((end, at) => string.slice(at === 0 ? 0 : ends[at - 1], end));
}

/** Every way to cut a string of `length` characters into `parts` parts, none empty. */
function* everyCut(length: number, parts: number, from = 1): Generator<number[]> {
  if (parts === 1) {
    yield [];
    return;
  }
  for (let cut = from; cut <= length - (parts - 1); cut++) {
    for (let rest of everyCut(length, parts - 1, cut + 1)) yield [cut, ...rest];
  }
}

// Forty characters in which texts repeat and overlap themselves, with line breaks.
const FORTY = "abababab\nabcabcabcabcabcabcx\n\nxyzxyzxyab";
// Texts of 1 to 24 characters, shorter than, as long as and longer than the 16 a scan finds
// a place by: there once, there twice, overlapping themselves, absent, and at the start.
const TEXTS = [
  "x", "a", "\n", "ab", "\na", "abab", "abcabcabcabcabc", "abcabcabcabcabcx", "bcabcabcabcabcabc",
  "abababab\nabcabcabcabcabc", "bcabcabcx\n\nxyzxyzxyab", "cabcabcabcabcabcy", "\nabababab",
  "abcabcabcabcabcabcx\n\nxyz", "xyzxyzxyab\n",
];

describe("a scan of Markdown handed a run at a time", () => {
  it("is forty characters and texts of every length class", () => {
    expect(FORTY).toHaveLength(40);
    let lengths = TEXTS.map(text => text.length);
    expect(lengths).toEqual(expect.arrayContaining([1, 2, 15, 16, 17, 24]));
    expect(Math.max(...lengths)).toBe(24);
    // Each answer a search gives is given of several texts, with and without the line break.
    for (let before of [false, true]) {
      let answers = TEXTS.map(text => searched(FORTY, text, before));
      for (let kind of ["none", "many"]) {
        expect(answers.filter(found => found === kind).length).toBeGreaterThanOrEqual(2);
      }
      expect(answers.filter(found => typeof found === "number").length).toBeGreaterThanOrEqual(4);
    }
    expect(searched(FORTY, "\nabababab", true)).toBe(-1);
  });

  describe.each(SCANS)("%s", (_name, scan) => {
    // A TABLE OF TWO WIDTHS: every cut into one to four parts, and into five in the wider run.
    it.each(WIDER ? [1, 2, 3, 4, 5] : [1, 2, 3, 4])(
      "answers what a search of the string does, under every cut into %i parts", parts => {
        let wrong: unknown[] = [];
        for (let cuts of everyCut(FORTY.length, parts)) {
          let cut = cutAt(FORTY, cuts);
          for (let text of TEXTS) {
            for (let before of [false, true]) {
              let answer = scanned(scan(text, before), cut);
              if (answer !== searched(FORTY, text, before)) wrong.push({ cuts, text, before, answer });
            }
          }
        }
        expect(wrong).toEqual([]);
      });

    it("answers for a text as long as the string, parts of one character and an empty part", () => {
      for (let cut of [[FORTY], [...FORTY], ["", FORTY, ""], cutAt(FORTY, [13, 13, 27])]) {
        expect(scanned(scan(FORTY), cut)).toBe(0);
        expect(scanned(scan(`\n${FORTY}`, true), cut)).toBe(-1);
        expect(scanned(scan(`${FORTY}a`), cut)).toBe("none");
        for (let text of TEXTS) {
          for (let before of [false, true]) {
            expect(scanned(scan(text, before), cut)).toBe(searched(FORTY, text, before));
          }
        }
      }
    });

    it("finds a place that spans three parts, and two places that overlap", () => {
      let parts = ["abababab\nabcabcabcabcabc", "abcx\n\nx", "yzxyzxyab"];
      expect(parts.join("")).toBe(FORTY);
      expect(scanned(scan("bcabcx\n\nxyz"), parts)).toBe(22);
      expect(FORTY.indexOf("bcabcx\n\nxyz")).toBe(22);
      expect(scanned(scan("aba"), ["xab", "ab", "ax"])).toBe("many");
      expect(scanned(scan("aba"), ["xab", "aax"])).toBe(1);
    });

    it("answers a seeded table of strings and texts as a search of the string does", () => {
      let { below } = diceOf(20261119);
      let letters = "abc\n";
      let strings = WIDER ? 300 : 120;
      let outcomes = { none: 0, many: 0, once: 0 };
      for (let number = 0; number < strings; number++) {
        let length = 200 + below(1_801);
        let string = Array.from({ length }, () => letters[below(4)]).join("");
        let cuts = Array.from({ length: below(8) }, () => 1 + below(length - 1))
          .toSorted((a, b) => a - b);
        let cut = cutAt(string, cuts);
        for (let draw = 0; draw < 12; draw++) {
          // Half are short, so that many stand more than once.
          let size = 1 + below(draw < 6 ? 8 : Math.min(400, length));
          let from = below(length - size + 1);
          let text = string.slice(from, from + size);
          // One in three is changed in one character, so that most of those are not there.
          if (draw % 3 === 2 && size > 3) {
            let at = below(size);
            text = text.slice(0, at) + (text[at] === "a" ? "b" : "a") + text.slice(at + 1);
          }
          let before = draw % 2 === 1;
          let expected = searched(string, text, before);
          expect(scanned(scan(text, before), cut)).toBe(expected);
          outcomes[typeof expected === "number" ? "once" : expected]++;
        }
      }
      for (let count of Object.values(outcomes)) expect(count).toBeGreaterThan(strings);
    });
  });

  it("a text that overlaps itself is still answered", () => {
    let line = "same line\n";
    let string = line.repeat(1_000);
    let parts = Array.from({ length: Math.ceil(1_000 / 7) }, (_, at) =>
      line.repeat(Math.min(7, 1_000 - 7 * at)));
    expect(parts.join("")).toBe(string);
    // Two hundred equal lines start at every line: more places than a scan follows at once.
    let equal = line.repeat(200);
    expect(200 / 7).toBeGreaterThan(MAX_SCAN_FOLLOWED / 7);
    expect(scanned(markdownScan(equal), parts)).toBe("crowded");
    expect(scanned(windowScan(equal), parts)).toBe(searched(string, equal));
    expect(searched(string, equal)).toBe("many");
    // The string from its second character on stands once, and reads as itself at every line.
    let rest = string.slice(1);
    expect(scanned(markdownScan(rest), parts)).toBe("crowded");
    expect(scanned(windowScan(rest), parts)).toBe(1);
    // Three equal lines are followed across a run's end three at most.
    let few = line.repeat(3);
    expect(scanned(markdownScan(few), parts)).toBe("many");
    expect(scanned(windowScan(few), parts)).toBe("many");
  });
});

// ---------------------------------------------------------------------------
// The stored reading, held to the reading of the whole rendering
// ---------------------------------------------------------------------------

/** `tab` kept under `sizes`: its store, and the two readings of it. */
function read(tab: GoogleDocsTab, sizes?: RunSizes) {
  let { storage, store, base } = pieceStore(tab, sizes);
  let rendering = renderTab(tab);
  return {
    storage, store, base, rendering,
    stored: storedTabReading(store, base), whole: wholeTabReading(rendering),
  };
}

/** What a walk of `version`'s runs at places `[from, to)` is handed, a run's Markdown read. */
function walked(store: DocStore, version: DocVersion, from?: number, to?: number) {
  let runs: { place: number; size: number; summary: unknown; markdown: string }[] = [];
  store.walk(version, ({ place, size, summary, markdown }) => {
    runs.push({ place, size, summary, markdown: markdown() });
    return true;
  }, from, to);
  return runs;
}

/** The stored Markdown of each run of `version`, in order. */
const runsMarkdown = (store: DocStore, version: DocVersion): string[] =>
  walked(store, version).map(run => run.markdown);

/**
 * Holds the piece `reading` answers of `own` to the closure of `own` cut from `whole`, and
 * to carrying the reading.
 */
function expectPieceOfReading(reading: TabReading, whole: Whole, own: OwnRange): void {
  let { part, ...rendering } = reading.piece(own);
  let { tab, ...at } = part!;
  expect(tab).toBe(reading);
  expectPieceOfWhole({ rendering, at } as DocPiece, whole, own);
}

/** Every tab Google answered in the recordings, as a fetch hands it to a store. */
const RECORDED = readFixtures().flatMap(({ before, steps }) =>
  [before, ...steps.map(step => step.after)].map(asFetched));

/** A table with a numbered list in a cell, between numbered items of the body. */
const LISTED = () => asFetched(buildTab([
  para("Intro"), grid(["a", "b"]), item("one", "N1"), para(""),
  { table: [[{ paragraphs: [item("in a cell", "N1")] }, "x\n"]] },
  para(""), grid(["a", "b"]), para("Between"), grid(["c", "d"]), para("End"),
], NUMBERED_LIST));

/** What the two readings were asked, by answer: a suite that asks one kind alone fails. */
type Asked = Record<
  "blank" | "notBlank" | "none" | "many" | "once" | "before" | "line" | "noLine" | "numbered" |
  "notNumbered" | "shapedOnce" | "shapedTwice" | "crowded", number>;
const asked = (): Asked => ({
  blank: 0, notBlank: 0, none: 0, many: 0, once: 0, before: 0, line: 0, noLine: 0, numbered: 0,
  notNumbered: 0, shapedOnce: 0, shapedTwice: 0, crowded: 0,
});

/**
 * Asks the stored reading of `tab` under `sizes` and the reading of its whole rendering every
 * question but the piece, and holds each answer of the first to the second's: `finds` seeded
 * texts with and without a line break before the Markdown, short ones (which repeat), long
 * ones (which span runs) and ones changed in a character (which are absent).
 */
function expectSameAnswers(
  tab: GoogleDocsTab, sizes: RunSizes, seed: number, finds: number, tally: Asked,
): void {
  let { store, base, rendering, stored, whole } = read(tab, sizes);
  let { markdown } = rendering;
  let { below } = diceOf(seed);
  expect(stored.tabId).toBe(whole.tabId);
  expect(stored.blank()).toBe(whole.blank());
  tally[whole.blank() ? "blank" : "notBlank"]++;
  expect(stored.tables()).toEqual(whole.tables());
  expect(whole.tables().count).toBe(rendering.sourceMap.tables.length);
  expect(stored.tablesShaped("<table>\n</table>")).toEqual([]);
  for (let table = 0; table <= rendering.sourceMap.tables.length; table++) {
    expect(stored.numberedAfter(table)).toBe(whole.numberedAfter(table));
    tally[whole.numberedAfter(table) ? "numbered" : "notNumbered"]++;
    if (table === rendering.sourceMap.tables.length) break;
    let shape = tableShape(tableAt(rendering, table));
    expect(stored.tablesShaped(shape)).toEqual(whole.tablesShaped(shape));
    if (whole.tablesShaped(shape).length === 1) expect(whole.tablesShaped(shape)).toEqual([table]);
    tally[whole.tablesShaped(shape).length > 1 ? "shapedTwice" : "shapedOnce"]++;
  }
  let runs = runsMarkdown(store, base);
  expect(runs.join("")).toBe(markdown);
  for (let draw = 0; draw < finds && markdown.length > 0; draw++) {
    let size = 1 + below(Math.min(markdown.length, draw % 3 === 0 ? 4 : draw % 3 === 1 ? 60 : 600));
    let from = draw === 0 ? 0 : below(markdown.length - size + 1);
    let text = markdown.slice(from, from + size);
    if (draw % 5 === 4) text = `${text.slice(0, -1)}☃`;
    for (let before of [false, true]) {
      // The first draw starts at the tab's start: with a line break before it, a place at -1.
      let sought = before && draw === 0 ? `\n${text}` : text;
      let expected = whole.find(sought, before);
      expect(expected).toBe(searched(markdown, sought, before));
      expect(stored.find(sought, before)).toBe(expected);
      tally[expected === -1 ? "before" : typeof expected === "number" ? "once" : expected]++;
      if (scanned(markdownScan(sought, before), runs) === "crowded") tally.crowded++;
    }
  }
  // Before each element, and before the Markdown's end.
  for (let start of new Set([...wholeOf(tab).starts, markdown.length])) {
    let line = whole.lineBefore(start);
    expect(stored.lineBefore(start)).toBe(line);
    tally[line === undefined ? "noLine" : "line"]++;
  }
}

describe("the two readings answer the same", () => {
  // A TABLE OF TWO WIDTHS: the seeded tabs, the texts sought in a seeded tab and in a recorded
  // one, and the sizings. The default pass leaves the two-element runs to the wider run.
  const TABLE = WIDER
    ? { tabs: 100, finds: 30, recordedFinds: 12, sizings: SIZINGS }
    : { tabs: 12, finds: 30, recordedFinds: 6, sizings: SIZINGS.filter((_, at) => at !== 1) };

  it.each(TABLE.sizings)("of every recorded tab and the seeded tabs, under %s", (name, sizes) => {
    let tally = asked();
    let seed = 20261119 + 1_000 * SIZINGS.findIndex(([other]) => other === name);
    let tabs = [
      ...RECORDED, LISTED(), asFetched(buildTab([para("")])), asFetched(buildTab([])),
      // Empty paragraphs alone, whose first run is blank and whose tab is not, and such a
      // stretch before text.
      asFetched(buildTab([para(""), para("")])), asFetched(buildTab([para(""), para(""), para("Text")])),
      ...pieceTabs(seed, TABLE.tabs).map(({ tab }) => tab),
    ];
    for (let [number, tab] of tabs.entries()) {
      expectSameAnswers(
        tab, sizes, seed + number,
        number < RECORDED.length ? TABLE.recordedFinds : TABLE.finds, tally);
    }
    // In the default pass no text overlaps itself past what a scan follows; the wider run
    // draws some from stretches of empty paragraphs, which the windows then answer.
    if (!WIDER) expect(tally.crowded).toBe(0);
    for (let [kind, count] of Object.entries(tally)) {
      if (kind !== "crowded") expect(count, kind).toBeGreaterThan(0);
    }
  });

  it("a text that overlaps itself is still answered", () => {
    let { store, base, stored, whole, rendering } = read(
      proseTab("tab-1", 1_000, () => "same line"), runsOf(7));
    let line = "same line\n\n";
    expect(rendering.markdown.startsWith(line.repeat(999))).toBe(true);
    let equal = line.repeat(200);
    expect(whole.find(equal)).toBe("many");
    let longest = Math.max(...runsMarkdown(store, base).map(run => run.length));
    expect(equal.length).toBeGreaterThan(20 * longest);
    docStoreCost.peakMarkdownCharsInHand = 0;
    expect(stored.find(equal)).toBe("many");
    // COUNTED as what the windows hold: the text, the window in hand and the one its tail was
    // cut from, each window under the text and a run. The scan that follows places counts the
    // text and a run.
    expect(docStoreCost.peakMarkdownCharsInHand).toBeGreaterThan(2 * equal.length);
    expect(docStoreCost.peakMarkdownCharsInHand).toBeLessThan(3 * equal.length + 2 * longest);
    let rest = rendering.markdown.slice(1);
    expect(whole.find(rest)).toBe(1);
    expect(stored.find(rest)).toBe(1);
    expect(whole.find(`\n${rendering.markdown}`, true)).toBe(-1);
    expect(stored.find(`\n${rendering.markdown}`, true)).toBe(-1);
  });

  it("no run is decoded for a question", () => {
    let { stored, rendering } = read(LISTED(), runsOf(1));
    let before = { ...docStoreCost };
    expect(stored.blank()).toBe(false);
    expect(stored.tables()).toEqual({ count: 4, cells: 8 });
    expect(stored.tablesShaped(tableShape(tableAt(rendering, 0)))).toEqual([0, 2]);
    expect(stored.numberedAfter(0)).toBe(true);
    expect(stored.numberedAfter(2)).toBe(false);
    expect(stored.find("Between")).toBe(rendering.markdown.indexOf("Between"));
    expect(stored.find("Intro\n", true)).toBe(-1 + "\nIntro\n".indexOf("Intro"));
    expect(stored.lineBefore(rendering.sourceMap.tables[3].mdStart)).toBe("Between");
    expect(stored.lineBefore(rendering.sourceMap.tables[2].mdStart)).toBe("1. one");
    expect(docStoreCost.runsDecoded).toBe(before.runsDecoded);
    expect(docStoreCost.runsRendered).toBe(before.runsRendered);
    expect(docStoreCost.runsKeyed).toBe(before.runsKeyed);
    // A piece is what decodes and renders: the runs of its closure.
    stored.piece({ table: 3 });
    expect(docStoreCost.runsDecoded).toBeGreaterThan(before.runsDecoded);
    expect(docStoreCost.runsRendered).toBeGreaterThan(before.runsRendered);
  });
});

// ---------------------------------------------------------------------------
// A walk of some of a version's runs
// ---------------------------------------------------------------------------

/** Items of one numbered list in runs apart, the third behind a paragraph and a table. */
const NUMBERED_APART = () => asFetched(buildTab([
  para("Intro"), item("one", "N1"), item("two", "N1"), para("Between"), grid(["a", "b"]),
  item("three", "N1"), para("After"), item("four", "N1"), para("End"),
], NUMBERED_LIST));

describe("a walk of some of a version's runs", () => {
  it("hands the runs at its places, each as the walk of them all does", () => {
    let { store, base } = pieceStore(NUMBERED_APART(), runsOf(1));
    let all = walked(store, base);
    expect(all.map(run => run.place)).toEqual(all.map((_, at) => at));
    expect(all.length).toBeGreaterThanOrEqual(9);
    expect(walked(store, base, 3, 5)).toEqual(all.slice(3, 5));
    // Every range, those that end past the list, start past it or hold no place among them.
    for (let from = 0; from <= all.length + 1; from++) {
      expect(walked(store, base, from), `from ${from}`).toEqual(all.slice(from));
      for (let to = 0; to <= all.length + 1; to++) {
        expect(walked(store, base, from, to), `[${from}, ${to})`)
          .toEqual(from < to ? all.slice(from, to) : []);
      }
    }
    // No run after the one a walk is ended at.
    let places: number[] = [];
    store.walk(base, run => places.push(run.place) < 2, 2);
    expect(places).toEqual([2, 3]);
  });

  it("renders a run with no stored rendering alone, at its place in the tab", () => {
    let { storage, store, base } = pieceStore(NUMBERED_APART(), runsOf(1));
    let all = walked(store, base);
    // An item that starts its list again after other text is numbered by the carry, which
    // counts the items in the runs before it: rendered from the tab's start it would be 1.
    let items = all.filter(run => /^\n?\d+\. /.test(run.markdown));
    expect(items.map(run => run.markdown.trim())).toEqual(["1. one", "1. two", "3. three", "4. four"]);
    expect(items[0].place).toBeGreaterThan(0);
    for (let { place } of items) {
      storage.sql.exec(
        "DELETE FROM doc_md WHERE (run, context, carry) IN " +
          "(SELECT run, context, carry FROM doc_seq WHERE version = ? AND seq = ?)",
        base.id, place);
      let before = { ...docStoreCost };
      expect(walked(store, base, place, place + 1)).toEqual([all[place]]);
      expect(docStoreCost.runsRendered - before.runsRendered).toBe(1);
      expect(docStoreCost.runsDecoded - before.runsDecoded).toBe(1);
      // Its rendering stands again: the walk of the same place renders nothing.
      expect(walked(store, base, place, place + 1)).toEqual([all[place]]);
      expect(docStoreCost.runsRendered - before.runsRendered).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// A walk that hands its runs again
// ---------------------------------------------------------------------------

/**
 * A numbered item before the first table, two tables no other reads as, and a line that
 * stands twice: every member's answer differs where it counts a run twice.
 */
const RESTARTED = () => asFetched(buildTab([
  para("Intro"), item("numbered first", "N1"), grid(["a", "b"]), para("Before"), para("Middle"),
  para("After"), grid(["c", "d"], ["e", "f"]), para("Twice"), para("Twice"), para("End"),
], NUMBERED_LIST));

/**
 * A blank tab whose one character is written before its last run: an empty paragraph, and
 * after it an element the pruning left with nothing to render.
 */
const BLANK_THEN_SILENT = () => {
  let tab = asFetched(buildTab([para("")]));
  let end = tab.body.content.at(-1)!.endIndex;
  tab.body.content.push({ startIndex: end, endIndex: end } as StructuralElement);
  return tab;
};

/** The members a walk is made for, each with how many of its walks handed their runs again. */
const members = () => ({
  blank: 0, tables: 0, tablesShaped: 0, numberedAfter: 0, find: 0, lineBefore: 0, piece: 0,
});
type Walked = keyof ReturnType<typeof members>;

/**
 * What a reading of `tab` is asked, each question with the member it asks and a check that
 * holds a reading's answer to the whole rendering's: every member, of every table and of every
 * element (its Markdown with the next element's sought, the line before it, its piece).
 */
function questionsOf(tab: GoogleDocsTab): { member: Walked; check(reading: TabReading): void }[] {
  let rendering = renderTab(tab);
  let whole = wholeOf(tab);
  let { markdown } = rendering;
  let questions: ReturnType<typeof questionsOf> = [];
  let answer = (member: Walked, ask: (reading: TabReading) => unknown) => {
    let expected = ask(wholeTabReading(rendering));
    questions.push({ member, check: reading => expect(ask(reading), member).toEqual(expected) });
  };
  let piece = (own: OwnRange) => questions.push({
    member: "piece", check: reading => expectPieceOfReading(reading, whole, own),
  });
  answer("blank", reading => reading.blank());
  answer("tables", reading => reading.tables());
  for (let table of rendering.sourceMap.tables.keys()) {
    let shape = tableShape(tableAt(rendering, table));
    answer("tablesShaped", reading => reading.tablesShaped(shape));
    answer("numberedAfter", reading => reading.numberedAfter(table));
    piece({ table });
  }
  let starts = [...new Set([...whole.starts, markdown.length])];
  for (let [at, start] of starts.entries()) {
    answer("lineBefore", reading => reading.lineBefore(start));
    if (start === markdown.length) continue;
    // Two elements' Markdown: under one-element runs, a text that spans two runs.
    let text = markdown.slice(start, starts[at + 2] ?? markdown.length);
    for (let before of [false, true]) answer("find", reading => reading.find(text, before));
    piece({ markdown: { mdStart: start, mdEnd: starts[at + 1] } });
  }
  piece("end");
  return questions;
}

/** How a run's key is damaged beneath a store, and the members whose walks then start again. */
const DAMAGE: readonly (readonly ["key" | "markdown", string, readonly Walked[]])[] = [
  // The list names a key no rendering is stored under: the run is rendered alone, its keys
  // are not the list's, and the version is keyed again whole.
  ["key", "a run's key in the list is not the renderer's",
    ["blank", "tables", "tablesShaped", "numberedAfter", "find", "lineBefore", "piece"]],
  // The rendering stands under that key, its summary whole and its Markdown none this code
  // stored: only a walk that asks the run's Markdown finds it, and ends there.
  ["markdown", "and the Markdown stored under it does not read back", ["find", "lineBefore"]],
];

describe("a walk that hands its runs again", () => {
  it.each(DAMAGE)("answers afresh: %s (%s)", (kind, _name, restarting) => {
    let restarted = members();
    let tabs = [RESTARTED(), BLANK_THEN_SILENT()];
    for (let tab of tabs) {
      let whole = pieceStore(tab, runsOf(1));
      let runs = runsMarkdown(whole.store, whole.base).length;
      // A TABLE OF TWO WIDTHS: the damaged run is the tab's middle one or its last, and in
      // the wider run each run after the first.
      let places = WIDER ? Array.from({ length: runs - 1 }, (_, at) => at + 1) : [runs >> 1, runs - 1];
      for (let { member, check } of questionsOf(tab)) {
        for (let place of places) {
          let { storage, store, base } = pieceStore(tab, runsOf(1));
          let key = () => storage.sql.exec<{ run: string; context: string; carry: string }>(
            "SELECT run, context, carry FROM doc_seq WHERE version = ? AND seq = ?", base.id, place,
          ).one();
          let { run, context, carry } = key();
          if (kind === "markdown") {
            storage.sql.exec(
              "UPDATE doc_md SET carry = 'zz', md = ? WHERE run = ? AND context = ? AND carry = ?",
              "\u00017", run, context, carry);
          }
          storage.sql.exec(
            "UPDATE doc_seq SET carry = 'zz' WHERE version = ? AND seq = ?", base.id, place);
          check(storedTabReading(store, base));
          // The version keyed again names the renderer's key: the walk that found the damage
          // was handed its runs once more.
          if (key().carry !== "zz") restarted[member]++;
        }
      }
    }
    for (let member of restarting) expect(restarted[member], member).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// What a question holds
// ---------------------------------------------------------------------------

const isPage =(query: string) => /FROM doc_seq\b[^]*ORDER BY (doc_seq\.)?seq LIMIT \?/.test(query);
const readsMarkdown = (query: string) => query.startsWith("SELECT md FROM doc_md");

/** True at the `nth` statement `is` chooses, counted from 1, and at no other. */
function nth(n: number, is: (query: string) => boolean): (query: string) => boolean {
  let seen = 0;
  return query => is(query) && ++seen === n;
}

type Kept = { storage: FakeDocStorage; base: DocVersion };

/**
 * How much more is in use at the statement `at` chooses, inside what `ask` asks of a stored
 * reading of `kept` made for it, than before the reading was made (`heapHeld`): a function
 * of its own, which keeps the answer's kind and no other value of what it measures.
 */
function heldBy(
  kept: Kept, at: (query: string) => boolean, ask: (reading: TabReading) => unknown,
): { bytes: number; seen: number; answer: string } {
  let answer = "";
  let { bytes, seen } = heapHeld(kept.storage, at, observed => {
    answer = String(ask(storedTabReading(new DocStore(observed), kept.base)));
  });
  return { bytes, seen, answer };
}

/** A string of its own with the characters of `text`: no view of a longer one. */
const copied = (text: string): string => Buffer.from(text, "latin1").toString("latin1");

// The read of the last page of a walk of `runs` runs: the page before it, full, is in hand.
const lastPage = (runs: number) => nth(Math.floor(runs / 500) + 1, isPage);
// The read of the Markdown of the last run but one of the last page that is full: a scan
// then has a whole page in hand, whatever the tab's runs.
const inLastFullPage = (runs: number) => nth(500 * Math.floor(runs / 500) - 1, readsMarkdown);

/** A tab of `pairs` one-cell tables kept, with where its last table's Markdown starts. */
function manyRuns(pairs: number): Kept & { runs: number; lastTable: number } {
  let tab = tinyTablesTab("tab-1", pairs);
  let { storage, base } = pieceStore(tab);
  return {
    storage, base, runs: 2 * pairs + 1,
    lastTable: renderTab(tab).sourceMap.tables.at(-1)!.mdStart,
  };
}

describe("what a question holds", () => {
  // A text of 1 MiB that spans some forty runs of 52. COUNTED: the text and the longest run's
  // Markdown, exactly. THE LIVE HEAP at the read of the middle run's Markdown, beyond the
  // text (which stands before the measure starts): 96 KB where the text is there and 66 KB
  // where its last character differs, of runs of 49 KB at most: the run before the one
  // read, which the scan's tail keeps, the page of the list and the store. Pinned at two
  // runs' Markdown and 32 KiB; the tab's Markdown joined would be 1.4 MB.
  it("a scan holds the text and a run", HEAP_MEASURED, () => {
    let filler = "lorem ipsum dolor sit amet ".repeat(23);
    let { storage, store, base } = pieceStore(
      proseTab("tab-1", 2_400, at => `Paragraph ${at} ${filler}`.slice(0, 600)));
    let runs = runsMarkdown(store, base);
    let longest = Math.max(...runs.map(run => run.length));
    expect(runs.length).toBeGreaterThan(40);
    let from = 12_345;
    let text = copied(runs.join("").slice(from, from + MIB));
    let changed = copied(`${text.slice(0, -1)}#`);
    for (let [sought, expected] of [[text, from], [changed, "none"]] as const) {
      docStoreCost.peakMarkdownCharsInHand = 0;
      expect(storedTabReading(store, base).find(sought)).toBe(expected);
      expect(docStoreCost.peakMarkdownCharsInHand).toBeLessThanOrEqual(sought.length + longest);
      expect(docStoreCost.peakMarkdownCharsInHand).toBeGreaterThan(sought.length);
      let held = heldBy(
        { storage, base }, nth(runs.length >> 1, readsMarkdown), reading => reading.find(sought));
      expect(held.seen).toBe(1);
      expect(held.answer).toBe(String(expected));
      expect(held.bytes).toBeLessThan(2 * longest + 32 * 1024);
    }
  });

  // COUNTED: the longest Markdown of the runs read, one in hand at a time, and no run before
  // the line answered or after the offset asked.
  it("the lines read backwards hold a run at a time", () => {
    let { store, base, stored, whole, rendering } = read(asFetched(buildTab([
      para(`First, and longer than every run after it: ${"lorem ipsum ".repeat(60)}`),
      para("The line"), grid(["a", "b"]), para(""), grid(["c", "d"], ["e", "f"], ["g", "h"]),
      para(""), grid(["i", "j"]), para(`Last, and as long: ${"dolor sit amet ".repeat(60)}`),
    ])), runsOf(1));
    let runs = runsMarkdown(store, base);
    let lengths = runs.map(run => run.length);
    let line = runs.findIndex(run => run.includes("The line"));
    let last = runs.findLastIndex(run => run.includes("<table>"));
    expect(runs.filter(run => run.includes("<table>"))).toHaveLength(3);
    let { tables } = rendering.sourceMap;
    // A table's run starts with the line break before the table. Behind two tables and the
    // empty lines between: the runs from the last table's back to the line's, of which the
    // second table's is the longest, and neither long paragraph.
    let behind = Math.max(...lengths.slice(line, last + 1));
    expect(last - line).toBe(5);
    expect(behind).toBe(lengths[line + 3]);
    expect(behind).toBeGreaterThan(Math.max(lengths[line + 1], lengths[last]));
    expect(behind).toBeLessThan(Math.min(lengths[line - 1], lengths[last + 1]));
    let after = rendering.markdown.indexOf("The line\n") + "The line\n".length;
    let end = rendering.markdown.length;
    let asks = [
      { mdStart: tables[2].mdStart, answer: "The line", peak: behind },
      // The first table's run and the line's.
      { mdStart: tables[0].mdStart, answer: "The line", peak: lengths[line + 1] },
      // The line stands in the run the character before the offset does: that run alone.
      { mdStart: after, answer: "The line", peak: lengths[line] },
      { mdStart: end, answer: whole.lineBefore(end), peak: lengths[last + 1] },
    ];
    expect(lengths[line + 1]).toBeGreaterThan(lengths[line]);
    for (let { mdStart, answer, peak } of asks) {
      expect(answer).toBeDefined();
      expect(whole.lineBefore(mdStart)).toBe(answer);
      docStoreCost.peakMarkdownCharsInHand = 0;
      expect(stored.lineBefore(mdStart)).toBe(answer);
      expect(docStoreCost.peakMarkdownCharsInHand).toBe(peak);
    }
  });

  // What each member is asked on the shape of many runs, and the statement inside its walk at
  // which the heap is read: the walk's last page for a pass, one of the last runs' Markdown
  // for a scan and for the lines read backwards. `lastTable` is where the last table starts.
  type Member = {
    at(runs: number): (query: string) => boolean;
    ask(reading: TabReading, lastTable: number): unknown;
    answer: string;
  };
  const MEMBERS: Record<string, Member> = {
    tables: { at: lastPage, ask: reading => reading.tables().cells > 0, answer: "true" },
    tablesShaped: {
      at: lastPage, ask: reading => reading.tablesShaped("<table>\n</table>").length, answer: "0",
    },
    numberedAfter: { at: lastPage, ask: reading => reading.numberedAfter(0), answer: "false" },
    blank: { at: () => nth(1, isPage), ask: reading => reading.blank(), answer: "false" },
    find: { at: inLastFullPage, ask: reading => typeof reading.find("<p>cell 37</p>"), answer: "number" },
    findAbsent: { at: inLastFullPage, ask: reading => reading.find("no such text"), answer: "none" },
    // Behind every other table: the lines are read back through all of them to the tab's start.
    lineBefore: {
      at: runs => nth(runs - 4, readsMarkdown),
      ask: (reading, lastTable) => reading.lineBefore(lastTable), answer: "undefined",
    },
  };

  // A tab of thousands of one-cell tables, each a run, with a run between each two: 4,001
  // and 8,001 runs (4,001 and 19,601 in the wider run). THE PER-RUN TERM of each member is
  // the difference of what it holds on the two tabs, by the runs between them. MEASURED, in
  // bytes a run, default pass and wider run: `tables` -0.3 and -0.1, `tablesShaped` -0.9
  // and 0.4, `numberedAfter` 0.0 to 4.8 and -0.4, `blank` 0.0 and 0.0, `find` of a cell's
  // text 1.7 and 0.6, `find` of an absent text 5.8 and -0.1, `lineBefore` 2.5 and 0.3:
  // nothing a run. What is left is a constant of up to 24 KB between two measures of one
  // member (what the code of a walk takes as it is compiled again between the collections
  // of a measure), which is 6 bytes a run over 4,000 runs and under 2 over 15,600. PINNED
  // at 16 bytes a run in the default pass and at 4 in the wider run: a list of the runs'
  // places alone would be 8 bytes a run, and one of their summaries over 190.
  /** The two tabs of the shape, kept once a file by the first member's test. */
  let tabs: ReturnType<typeof manyRuns>[] | undefined;

  it.each(Object.keys(MEMBERS))(
    "the shape of many runs is asked without a list of it: %s", HEAP_MEASURED, name => {
      let { at, ask, answer } = MEMBERS[name];
      let [fewer, more] = tabs ??= (WIDER ? [2_000, 9_800] : [2_000, 4_000]).map(manyRuns);
      // Asked once on the larger tab before it is measured, so that what the code itself
      // takes as it runs (the first time, and once a loop of it is compiled) is in neither
      // measure.
      ask(storedTabReading(new DocStore(more.storage), more.base), more.lastTable);
      let held = [fewer, more].map(kept => {
        let measured = heldBy(kept, at(kept.runs), reading => ask(reading, kept.lastTable));
        expect(measured.seen).toBe(1);
        expect(measured.answer).toBe(answer);
        return measured.bytes;
      });
      expect((held[1] - held[0]) / (more.runs - fewer.runs)).toBeLessThan(WIDER ? 4 : 16);
    });
});

// ---------------------------------------------------------------------------
// What a stored reading throws, and the piece it answers
// ---------------------------------------------------------------------------

/** What `run` throws, or `undefined` where it throws nothing. */
function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** A numbered list in a cell of the first table, and far after it what could be renumbered. */
const numberedFar = (later: "item" | "table" | "nothing") => asFetched(buildTab([
  para("Intro"),
  { table: [[{ paragraphs: [item("in a cell", "N1"), item("and another", "N1")] }, "x\n"], ["y\n", "z\n"]] },
  ...Array.from({ length: 8 }, (_, at) => para(`Line ${at}`)),
  ...(later === "item" ? [item("far item", "N1")]
    : later === "table" ? [{ table: [[{ paragraphs: [item("far cell", "N1")] }]] }, para("")] : []),
  para("End"),
], NUMBERED_LIST));

/**
 * A table whose first row holds a numbered list, the tab's second table: far before it a
 * table and a numbered item, and no numbered list after it.
 */
const numberedSecond = () => asFetched(buildTab([
  para("Intro"), grid(["a", "b"]), item("an item", "N1"),
  ...Array.from({ length: 8 }, (_, at) => para(`Line ${at}`)),
  { table: [[{ paragraphs: [item("in a cell", "N1"), item("and another", "N1")] }, "x\n"], ["y\n", "z\n"]] },
  para("End"),
], NUMBERED_LIST));

describe("what a stored reading throws", () => {
  afterEach(() => {
    fault.on = false;
  });

  const QUESTIONS: [string, (reading: TabReading, table: number, shape: string) => unknown][] = [
    ["blank", reading => reading.blank()],
    ["find", reading => reading.find("Between")],
    ["find with a line break before", reading => reading.find("Intro\n", true)],
    ["tables", reading => reading.tables()],
    ["tablesShaped", (reading, _table, shape) => reading.tablesShaped(shape)],
    ["numberedAfter", reading => reading.numberedAfter(0)],
    ["lineBefore", (reading, table) => reading.lineBefore(table)],
    ["piece of a table", reading => reading.piece({ table: 3 })],
    ["piece of the tab's end", reading => reading.piece("end")],
    ["piece of a range", (reading, table) =>
      reading.piece({ markdown: { mdStart: table, mdEnd: table + 1 } })],
  ];

  it.each(QUESTIONS)("%s: what storage throws is a fault, and leaves as what it was", (_name, ask) => {
    let { storage, store, base, stored, rendering } = read(LISTED(), runsOf(1));
    let table = rendering.sourceMap.tables[3].mdStart;
    let shape = tableShape(tableAt(rendering, 0));
    expect(thrownBy(() => ask(stored, table, shape))).toBeUndefined();
    // The first run's content and its rendering gone beneath the store: every question
    // starts at it, and none can be answered of it.
    let [{ run }] = storage.sql.exec<{ run: string }>(
      "SELECT run FROM doc_seq WHERE version = ? ORDER BY seq LIMIT 1", base.id).toArray();
    storage.sql.exec("DELETE FROM doc_md WHERE run = ?", run);
    storage.sql.exec("DELETE FROM doc_run WHERE id = ?", run);
    let thrown = thrownBy(() => ask(storedTabReading(store, base), table, shape));
    expect(thrown).toBeInstanceOf(DocReadingFault);
    let { cause } = thrown as DocReadingFault;
    expect(cause).toEqual(new Error(DOC_COPY_UNREADABLE));
    expect(cause).not.toBeInstanceOf(DocReadingFault);
    // The store dropped the copy where it found the row gone.
    expect(store.head(base.doc)).toBeUndefined();
    expect(thrownBy(() => unwrapped(() => {
      throw thrown;
    }))).toBe(cause);
  });

  it("unwrapped passes every answer and every other throw", () => {
    expect(unwrapped(() => 7)).toBe(7);
    let other = new Error("another");
    expect(thrownBy(() => unwrapped(() => {
      throw other;
    }))).toBe(other);
    let inner = new DocReadingFault("no error");
    expect(inner.message).toBe("A stored Google Doc tab could not be read.");
    expect(thrownBy(() => unwrapped(() => {
      throw inner;
    }))).toBe("no error");
  });

  it("the renderer's throw and a piece that names nothing pass as they are", () => {
    let { store, base, stored, rendering } = read(
      asFetched(buildTab(["One", "FAULT here", "Three"].map(para))), runsOf(1));
    let at = rendering.markdown.indexOf("FAULT");
    fault.on = true;
    let rendered = thrownBy(() => stored.piece({ markdown: { mdStart: at, mdEnd: at + 5 } }));
    expect(rendered).toBeInstanceOf(DocRunRenderError);
    expect((rendered as Error).cause).toEqual(new Error("renderer fault"));
    expect(thrownBy(() => unwrapped(() => {
      throw rendered;
    }))).toBe(rendered);
    fault.on = false;
    // A tab of no table: the reading throws it as it is, and so it leaves `unwrapped`.
    let named = thrownBy(() => stored.piece({ table: 0 }));
    expect(named).toBeInstanceOf(DocPieceError);
    expect((named as Error).message)
      .toBe("A piece was asked for elements its version's runs do not hold.");
    expect(thrownBy(() => unwrapped(() => stored.piece({ table: 0 })))).toEqual(named);
    expect(thrownBy(() => unwrapped(() => {
      throw named;
    }))).toBe(named);
    // Neither is storage's: the copy stands, and the reading answers still.
    expect(store.head(base.doc)).toBeDefined();
    expect(stored.find("Three")).toBe(rendering.markdown.indexOf("Three"));
  });
});

/** What `run` answers, or the message of the refusal it throws. */
const outcome = (run: () => unknown): unknown => {
  try {
    return run();
  } catch (error) {
    if (!(error instanceof Error) || error instanceof TypeError) throw error;
    return error.message;
  }
};

describe("the piece a stored reading answers", () => {
  it.each([SIZINGS[0], SIZINGS[3]])(
    "carries its reading, and the checks on it answer as on the whole rendering, under %s",
    (_name, sizes) => {
      let counts = { tables: 0, refused: 0, twins: 0 };
      let tabs = [
        ...RECORDED, LISTED(), numberedFar("item"), numberedFar("table"), numberedFar("nothing"),
        numberedSecond(),
      ];
      for (let tab of tabs) {
        let rendering = renderTab(tab);
        let { tables } = rendering.sourceMap;
        if (tables.length === 0) continue;
        let { stored } = read(tab, sizes);
        for (let table = 0; table < tables.length; table++) {
          let piece = stored.piece({ table });
          expect(piece.part?.tab).toBe(stored);
          let place = table - piece.part!.tablesBefore;
          expect(tableAt(piece, place)).toBe(tableAt(rendering, table));
          // The one table of the tab that reads as this one, or the refusal of two that do.
          let ref = { expected: tableIdentity(tableAt(rendering, table)) };
          let resolved = outcome(() => resolveTable(rendering, ref, "op"));
          expect(outcome(() => {
            let found = resolveTable(piece, ref, "op");
            return found + piece.part!.tablesBefore;
          })).toEqual(resolved);
          if (resolved !== table) counts.twins++;
          for (let added of [1, 4_000, 5_000]) {
            expect(outcome(() => checkTabTableCells(piece, added, "op")))
              .toEqual(outcome(() => checkTabTableCells(rendering, added, "op")));
            expect(outcome(() => checkTabTableCells(stored, added, "op")))
              .toEqual(outcome(() => checkTabTableCells(rendering, added, "op")));
          }
          // What a deletion removes, and whether a numbered list follows it in the tab.
          for (let type of ["deleteTableRows", "deleteTableColumns"] as const) {
            let shape = { type, at: 0, count: 1 };
            let whole = outcome(() => checkTableTarget(rendering, table, shape));
            expect(outcome(() => checkTableTarget(piece, place, shape))).toEqual(whole);
            if (typeof whole === "string" && whole.includes("numbered list")) counts.refused++;
          }
          counts.tables++;
        }
      }
      expect(counts.tables).toBeGreaterThan(50);
      expect(counts.twins).toBeGreaterThan(0);
      // The far item and the far table, each outside the piece of the first table.
      expect(counts.refused).toBeGreaterThanOrEqual(2);
    });

  it("refuses a deletion for a numbered list far after its table, which the piece does not hold", () => {
    for (let later of ["item", "table"] as const) {
      let { stored, rendering } = read(numberedFar(later), runsOf(1));
      let piece = stored.piece({ table: 0 });
      expect(piece.part?.last).toBe(false);
      expect(piece.markdown).not.toContain("far");
      expect(rendering.markdown).toContain("far");
      expect(thrownMessage(() => checkTableTarget(piece, 0, { type: "deleteTableRows", at: 0, count: 1 })))
        .toBe("deleteTableRows: what would be deleted holds items of a numbered list, and a " +
          "numbered list follows it in the tab, which the deletion could renumber. That is not " +
          "supported.");
    }
    let { stored } = read(numberedFar("nothing"), runsOf(1));
    expect(outcome(() =>
      checkTableTarget(stored.piece({ table: 0 }), 0, { type: "deleteTableRows", at: 0, count: 1 })))
      .toBeUndefined();
  });

  it("asks what follows a table by its number in the tab, and says so of a table it does not hold", () => {
    let { stored, rendering } = read(numberedSecond(), runsOf(1));
    let deletion = { type: "deleteTableRows", at: 0, count: 1 } as const;
    // The second table's piece holds that table alone: its place in the piece is 0.
    let second = stored.piece({ table: 1 });
    expect(second.sourceMap.tables).toHaveLength(1);
    expect(second.part?.tablesBefore).toBe(1);
    // A numbered list follows the tab's first table (the item, and the second table's cell)
    // and none follows its second.
    expect(stored.numberedAfter(0)).toBe(true);
    expect(stored.numberedAfter(1)).toBe(false);
    expect(outcome(() => checkTableTarget(rendering, 1, deletion))).toBeUndefined();
    expect(outcome(() => checkTableTarget(second, 0, deletion))).toBeUndefined();
    // A table of the tab that a piece does not hold, before it and after it: the piece was
    // made for another table, which is no refusal of the change.
    let first = stored.piece({ table: 0 });
    expect(first.sourceMap.tables).toHaveLength(1);
    let refs = [0, 1].map(table => ({ expected: tableIdentity(tableAt(rendering, table)) }));
    expect(resolveTable(first, refs[0], "op")).toBe(0);
    expect(resolveTable(second, refs[1], "op")).toBe(0);
    for (let [piece, ref] of [[second, refs[0]], [first, refs[1]]] as const) {
      expect(resolveTable(rendering, ref, "op")).toBe(refs.indexOf(ref));
      expect(thrownMessage(() => resolveTable(piece, ref, "op")))
        .toBe("A piece does not hold the table its change names.");
    }
  });

  it.each(silentRunTabs())("finds the run that writes: $name", ({ tab, ranges }) => {
    let whole = wholeOf(tab);
    let { stored, rendering } = read(tab, runsOf(1));
    for (let markdown of ranges) {
      let own: OwnRange = { markdown };
      expectPieceOfReading(stored, whole, own);
      let start = whole.starts[ownIn(whole, own).first];
      expect(stored.lineBefore(start)).toBe(wholeTabReading(rendering).lineBefore(start));
    }
  });

  it("answers the piece of the range asked, whatever range it answered before", () => {
    let tab = asFetched(buildTab([
      ...Array.from({ length: 6 }, (_, at) => para(`Before ${at}`)), grid(["a", "b"]),
      ...Array.from({ length: 6 }, (_, at) => para(`Between ${at}`)), grid(["c", "d"]),
      ...Array.from({ length: 6 }, (_, at) => para(`After ${at}`)),
    ]));
    let whole = wholeOf(tab);
    let { starts } = whole;
    let { stored } = read(tab, runsOf(1));
    // Each differs from the one before it in one part of what names a piece: a range's end,
    // its start, a range from the tab's end, the end from a table, a table's number, and a
    // table from a range.
    let owns: OwnRange[] = [
      { markdown: { mdStart: starts[1], mdEnd: starts[2] } },
      { markdown: { mdStart: starts[1], mdEnd: starts[5] } },
      { markdown: { mdStart: starts[3], mdEnd: starts[5] } },
      "end", { table: 0 }, { table: 1 },
      { markdown: { mdStart: starts[1], mdEnd: starts[2] } },
    ];
    for (let [at, own] of owns.entries()) {
      // No two that follow each other have one closure: the piece before is not this one's.
      if (at > 0) expect(closureIn(whole, own), `${at}`).not.toEqual(closureIn(whole, owns[at - 1]));
      expectPieceOfReading(stored, whole, own);
      // Asked again by a range that reads the same, the piece is the one remembered.
      expect(stored.piece(structuredClone(own))).toBe(stored.piece(own));
    }
  });

  it("a reading lets go of its piece", HEAP_MEASURED, async () => {
    let { store, base } = pieceStore(LISTED(), runsOf(1));
    let reading = storedTabReading(store, base);
    let own: OwnRange = { table: 2 };
    let before = { ...docStoreCost };
    // A function of its own, which answers a reference that holds nothing and a copy: no
    // frame of this test holds the piece.
    let first = (() => {
      let piece = reading.piece(own);
      let { part, ...rendering } = piece;
      return {
        sourceMap: new WeakRef(piece.sourceMap), rendering: structuredClone(rendering),
        at: { ...part, tab: undefined },
        // Asked again by the same range, the piece is the one remembered.
        remembered: reading.piece({ table: 2 }) === piece,
      };
    })();
    expect(first.remembered).toBe(true);
    let spent = {
      decoded: docStoreCost.runsDecoded - before.runsDecoded,
      rendered: docStoreCost.runsRendered - before.runsRendered,
    };
    expect(spent.decoded).toBeGreaterThan(0);
    expect(spent.rendered).toBeGreaterThan(0);
    // The decoded runs are handed on once, and the reading holds the piece no longer, though
    // the reading and the runs are held still.
    let decoded = reading.takeDecoded();
    expect(decoded?.size).toBeGreaterThan(0);
    expect(reading.takeDecoded()).toBeUndefined();
    // A weak reference keeps its target to the end of the job that made it.
    await new Promise(resolve => setImmediate(resolve));
    collect();
    expect(first.sourceMap.deref()).toBeUndefined();
    expect(decoded?.size).toBeGreaterThan(0);
    // Asked again, the piece is made again from storage: the same, at the same price.
    let { part, ...rendering } = reading.piece(own);
    expect(rendering).toEqual(first.rendering);
    expect({ ...part, tab: undefined }).toEqual(first.at);
    expect(part?.tab).toBe(reading);
    expect(docStoreCost.runsDecoded - before.runsDecoded).toBe(2 * spent.decoded);
    expect(docStoreCost.runsRendered - before.runsRendered).toBe(2 * spent.rendered);
  });
});
