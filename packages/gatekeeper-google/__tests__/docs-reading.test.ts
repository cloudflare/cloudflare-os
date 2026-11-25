// The stored reading of a tab (scans, walks, members, pieces) held to the reading of its whole
// rendering, and what it decodes and throws. The file mocks `renderRun` as other modules
// import it, to throw on a run that holds `FAULT` while `fault.on`.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GoogleDocsTab, StructuralElement } from "../src/docs-api";
import {
  DocReadingFault, markdownScan, storedTabReading, unwrapped, prefixScan,
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
import { proseTab } from "./doc-store-scenarios";
import { readFixtures } from "./docs-live-fixtures";
import {
  closureIn, expectPieceOfWhole, ownIn, pieceStore, silentRunTabs, wholeOf, type Whole,
} from "./docs-piece-shadow";
import { pieceTabs } from "./docs-piece-tabs";
import { asFetched } from "./docs-store-slice-shadow";
import { collect, HEAP_MEASURED } from "./heap-held";
import { WIDER } from "./wider-run";

/** Whether the store's renderer throws on a run that holds the text `FAULT`. */
const fault = vi.hoisted(() => ({ on: false }));

// Only the store's rendering of a run can fail: a tab in hand is rendered by the module's own.
vi.mock("../src/markdown-converter", async importOriginal => {
  let converter = await importOriginal<typeof import("../src/markdown-converter")>();
  let renderRun: typeof converter.renderRun = (elements, ...rest) => {
    if (fault.on && JSON.stringify(elements).includes("FAULT")) throw new Error("renderer fault");
    return converter.renderRun(elements, ...rest);
  };
  return { ...converter, renderRun };
});

/** Sizes that cut a tab into runs of `elements` elements at most. */
const runsOf = (elements: number): RunSizes => ({ least: 0, target: 400, most: Infinity, elements });
const SIZINGS: readonly (readonly [string, RunSizes])[] = [
  ["one element a run", runsOf(1)], ["the real cut", RUN_SIZES],
];

type Found = number | "none" | "many";
type Scan = { take(run: string): boolean; done(): Found | "crowded" };
const SCANS: readonly (readonly [string, (text: string, lineBreakBefore?: boolean) => Scan])[] =
  [["markdownScan", markdownScan], ["prefixScan", prefixScan]];

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
});

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

/** Holds the piece `reading` answers of `own` to the closure of `own` cut from `whole`. */
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
 * Holds every answer but the piece of the stored reading to the whole rendering's, with `finds`
 * seeded texts: repeating, spanning runs and absent.
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
  // A TABLE OF TWO WIDTHS: the seeded tabs and the texts sought in a recorded one.
  const TABLE = WIDER ? { tabs: 100, finds: 30, recordedFinds: 12 } : { tabs: 12, finds: 30, recordedFinds: 6 };

  it.each(SIZINGS)("of every recorded tab and the seeded tabs, under %s", (name, sizes) => {
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
    // Only the wider run draws a text that overlaps itself past what a scan follows.
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
    // The scan holds the text, its table of prefixes and a run.
    expect(docStoreCost.peakMarkdownCharsInHand).toBeGreaterThan(2 * equal.length);
    expect(docStoreCost.peakMarkdownCharsInHand).toBeLessThan(3 * equal.length + 2 * longest);
    let rest = rendering.markdown.slice(1);
    expect(whole.find(rest)).toBe(1);
    expect(stored.find(rest)).toBe(1);
    expect(whole.find(`\n${rendering.markdown}`, true)).toBe(-1);
    expect(stored.find(`\n${rendering.markdown}`, true)).toBe(-1);
  });

  it("a text that starts at many places of repetitive Markdown and is at none is answered by its prefixes", () => {
    // Every other character starts as the text does, and each goes on as it does until the end.
    let markdown = "ab".repeat(16_000);
    let runs = cutAt(markdown, [8_000, 16_000, 24_000]);
    let text = `${"ab".repeat(8_000)}x`;
    expect(scanned(markdownScan(text), runs)).toBe("crowded");
    expect(scanned(prefixScan(text), runs)).toBe("none");
    let { stored, whole } = read(proseTab("tab-1", 1, () => markdown), runsOf(1));
    expect(whole.find(text)).toBe("none");
    expect(stored.find(text)).toBe("none");
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

/** A numbered item, two tables and a repeated line: answers differ where a run counts twice. */
const RESTARTED = () => asFetched(buildTab([
  para("Intro"), item("numbered first", "N1"), grid(["a", "b"]), para("Before"), para("Middle"),
  para("After"), grid(["c", "d"], ["e", "f"]), para("Twice"), para("Twice"), para("End"),
], NUMBERED_LIST));

/** A blank tab: an empty paragraph, then an element pruned to nothing in its last run. */
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

/** Every question of every member a reading of `tab` is asked, each held to the whole rendering's answer. */
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
  // A rendering under that key, foreign Markdown: only a walk asking for Markdown finds it.
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
          // Keyed again under the renderer's key.
          if (key().carry !== "zz") restarted[member]++;
        }
      }
    }
    for (let member of restarting) expect(restarted[member], member).toBeGreaterThan(0);
  });
});

describe("what a question holds", () => {
  // The peak is the longest run read, one at a time, none before the line or after the offset.
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
    // Behind two tables the longest run read is the second table's, and neither long paragraph.
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
});

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

/** A second table whose first row holds a numbered list, after a table and a numbered item. */
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
  it.each(SIZINGS)(
    "carries its reading, and the checks on it answer as on the whole rendering, under %s",
    (_name, sizes) => {
      let counts = { tables: 0, twins: 0 };
      let far = [numberedFar("item"), numberedFar("table")];
      let refusing = new Set<GoogleDocsTab>();
      let tabs = [...RECORDED, LISTED(), ...far, numberedFar("nothing"), numberedSecond()];
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
            if (typeof whole === "string" && whole.includes("numbered list")) refusing.add(tab);
          }
          counts.tables++;
        }
      }
      expect(counts.tables).toBeGreaterThan(50);
      expect(counts.twins).toBeGreaterThan(0);
      // The far item and the far table, each outside the piece of the first table.
      for (let tab of far) expect(refusing.has(tab)).toBe(true);
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
    // Each differs from the one before in one part of what names a piece.
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
    // A function of its own, so that no frame of this test holds the piece.
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
    // The decoded runs are handed on once, and then the reading no longer holds the piece.
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
