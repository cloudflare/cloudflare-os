// What the renderer says of each element of a run where it is asked, and the rendering of a
// range of a tab's elements cut from runs joined: the same part of the tab rendered whole.

import { describe, expect, it, vi } from "vitest";
import type { GoogleDocsTab, StructuralElement } from "../src/docs-api";
import { CHIP_PLACEHOLDER } from "../src/docs-content";
import {
  advanceCarry, ELEMENT_BLOCK, ELEMENT_BREAKS, ELEMENT_DEEP,
  ELEMENT_PROTECTS, ELEMENT_TABLE, ELEMENT_TEXT, initialCarry, joinRenderedRun,
  noRenderedRuns, pieceRendering, renderRun,
} from "../src/markdown-converter";
import type {
  JoinedRuns, MarkdownRange, RenderedRun, SourceMap,
} from "../src/markdown-converter";
import { buildTab, diceOf, grid, heading, item, NUMBERED_LIST, para } from "./doc-fixture";
import type { BlockSpec, Dice } from "./doc-fixture";
import {
  carryOf, expectSameRendering, forcedRuns, fuzzedTabs, largeTabs, oneElementRuns, plainOf,
  recordedTabs, seededCutsInTwo,
} from "./render-run-tabs";
import type { NamedTab, PlainCarry, Rendering } from "./render-run-tabs";
import { WIDER } from "./wider-run";

/** How many ranges are drawn of each tab under each cut, beside those every tab is held to. */
const DRAWN = WIDER ? 200 : 40;

const CORPUS: NamedTab[] = [...recordedTabs(), ...largeTabs(20), ...fuzzedTabs(53, 60)];

/** The cuts every tab is rendered under, each the bounds of its runs. */
const CUTS: readonly { name: string; of: (length: number) => number[] }[] = [
  { name: "one element a run", of: oneElementRuns },
  { name: "runs of one to three elements", of: length => forcedRuns(length, 2) },
  { name: "cut in two", of: length => seededCutsInTwo(length, 5, 1)[0] ?? [0, length] },
];

/** A tab rendered whole, with what the pass says of its elements. */
type Told = Rendering & {
  /** Where each element's Markdown starts, and after them where the Markdown ends. */
  starts: number[];
  flags: number[];
};

function toldWhole(tab: GoogleDocsTab): Told {
  let { markdown, sourceMap, elements } =
    renderRun(tab.body.content, tab, initialCarry(), { mdStart: 0, elements: true });
  return {
    markdown, sourceMap, starts: [...elements!.starts, markdown.length],
    flags: [...elements!.flags],
  };
}

/** A tab's runs under a cut, each rendered once with its elements told. */
type CutTab = {
  tab: GoogleDocsTab;
  bounds: readonly number[];
  runs: RenderedRun[];
  /** A copy of the carry each run is entered with, and where its Markdown starts. */
  carries: PlainCarry[];
  runStarts: number[];
};

function cutTab(tab: GoogleDocsTab, bounds: readonly number[]): CutTab {
  let pass = initialCarry();
  let cut: CutTab = { tab, bounds, runs: [], carries: [], runStarts: [] };
  let at = 0;
  for (let run = 0; run + 1 < bounds.length; run++) {
    cut.carries.push(plainOf(pass));
    cut.runStarts.push(at);
    let rendered = renderRun(tab.body.content.slice(bounds[run], bounds[run + 1]), tab, pass,
      { mdStart: at, elements: true });
    cut.runs.push(rendered);
    advanceCarry(pass, rendered.summary);
    at += rendered.markdown.length;
  }
  return cut;
}

/**
 * The runs of `cut` from run `first` on, joined for one piece to take: the runs that hold an
 * element of `[from, to)` rendered again, since the piece moves their entries in place.
 */
function joinedFor(cut: CutTab, first: number, from: number, to: number): JoinedRuns {
  let { tab, bounds } = cut;
  let joined = noRenderedRuns(cut.runStarts[first]);
  for (let run = first; run < cut.runs.length; run++) {
    let taken = bounds[run] < to && bounds[run + 1] > from;
    joinRenderedRun(joined, !taken ? cut.runs[run] : renderRun(
      tab.body.content.slice(bounds[run], bounds[run + 1]), tab, carryOf(cut.carries[run]),
      { mdStart: cut.runStarts[run], elements: true }));
  }
  return joined;
}

/** Whether a paragraph holds anything that is no text: what a protected range guards. */
function holdsMoreThanText({ paragraph }: StructuralElement): boolean {
  return !!paragraph && (!!paragraph.positionedObjectIds?.length || paragraph.elements.some(
    element => !element.textRun || element.textRun.content.includes(CHIP_PLACEHOLDER)));
}

/** Whether an element owns a protected range, told from the element alone. */
function protects(element: StructuralElement): boolean {
  return !!element.table || !!element.tableOfContents ||
    (!!element.sectionBreak && element.startIndex > 0) || holdsMoreThanText(element);
}

/** A copy of `value` with every Markdown offset in it counted from `by` characters later. */
function movedCopy<T>(value: T, by: number): T {
  if (Array.isArray(value)) return value.map(part => movedCopy(part, by)) as T;
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, held]) =>
    [key, key === "mdStart" || key === "mdEnd" ? held - by : movedCopy(held, by)])) as T;
}

type Piece = Rendering & { mdStart: number; tablesBefore: number };

/**
 * What elements `[from, to)` read as in `whole`: their entries, offsets counted from the first,
 * the last protected range ended where they end, and the blank line a protected range before
 * them ends in a range of its own.
 */
function partOfWhole(tab: GoogleDocsTab, whole: Told, from: number, to: number): Piece {
  let { content } = tab.body;
  let mdStart = whole.starts[from];
  let length = whole.starts[to] - mdStart;
  let docFrom = from === to ? Infinity : content[from].startIndex ?? 0;
  let docTo = from === to ? Infinity : content[to - 1].endIndex;
  let own = ({ docStart }: { docStart: number }) => docStart >= docFrom && docStart < docTo;
  let owners = content.flatMap((element, index) => protects(element) ? [index] : []);
  let ranges = whole.sourceMap.protectedRanges;
  let protectedRanges = movedCopy(
    ranges.filter((_, range) => owners[range] >= from && owners[range] < to), mdStart);
  let last = protectedRanges.at(-1);
  if (last) last.mdEnd = Math.min(last.mdEnd, length);
  let before: MarkdownRange | undefined = ranges[owners.findLastIndex(owner => owner < from)];
  if (length > 0 && before && before.mdEnd > mdStart) {
    protectedRanges.unshift({ mdStart: 0, mdEnd: 1 });
  }
  let firstIndex = from < content.length ? content[from].startIndex ?? 0 : Infinity;
  return {
    markdown: whole.markdown.slice(mdStart, mdStart + length),
    sourceMap: {
      blocks: movedCopy(whole.sourceMap.blocks.filter(own), mdStart),
      protectedRanges,
      tables: movedCopy(whole.sourceMap.tables.filter(own), mdStart),
    },
    mdStart,
    tablesBefore: whole.sourceMap.tables.filter(table => table.docStart < firstIndex).length,
  };
}

/** The protected ranges of a rendering. */
const protectedOf = ({ sourceMap }: { sourceMap: SourceMap }) => sourceMap.protectedRanges;

function expectSamePiece(got: Piece, want: Piece, where: () => string): void {
  expectSameRendering(got, want, where);
  if (got.mdStart !== want.mdStart || got.tablesBefore !== want.tablesBefore) {
    expect({ mdStart: got.mdStart, tablesBefore: got.tablesBefore }, where())
      .toEqual({ mdStart: want.mdStart, tablesBefore: want.tablesBefore });
  }
}

/**
 * The ranges a tab is cut into pieces by: the whole tab, every range of up to four elements at
 * its ends and around each table, and `DRAWN` seeded ones.
 */
function rangesOf(tab: GoogleDocsTab, { below }: Dice): [number, number][] {
  let { length } = tab.body.content;
  let ranges = new Map<string, [number, number]>();
  let add = (from: number, to: number) => {
    if (from >= 0 && from <= to && to <= length) ranges.set(`${from} ${to}`, [from, to]);
  };
  let within = (low: number, high: number, empty: boolean) => {
    for (let from = low; from <= high; from++) {
      for (let to = empty ? from : from + 1; to <= Math.min(high, from + 4); to++) add(from, to);
    }
  };
  add(0, length);
  within(0, 4, true);
  within(length - 4, length, true);
  for (let [index, element] of tab.body.content.entries()) {
    if (element.table) within(index - 2, index + 3, false);
  }
  for (let draw = 0; draw < (length > 0 ? DRAWN : 0); draw++) {
    let from = below(length);
    add(from, from + 1 + below(Math.min(draw % 2 === 0 ? 6 : Infinity, length - from)));
  }
  return [...ranges.values()];
}

/** What a rendering says of its elements against the Markdown each writes. */
function expectFlagsSayWhatIsWritten(told: Told, where: string): void {
  for (let element = 0; element < told.flags.length; element++) {
    let written = told.markdown.slice(told.starts[element], told.starts[element + 1]);
    let says = told.flags[element] & (ELEMENT_BREAKS | ELEMENT_TEXT);
    let wants = written === "" ? 0 : /^\n+$/.test(written) ? ELEMENT_BREAKS : ELEMENT_TEXT;
    if (says !== wants) expect({ element, says }, where).toEqual({ element, says: wants });
  }
}

/** Every text a regular expression is tested on while `call` runs. */
function textsTested(call: () => void): string[] {
  let tests = vi.spyOn(RegExp.prototype, "test");
  try {
    call();
    return tests.mock.calls.map(([text]) => text);
  } finally {
    tests.mockRestore();
  }
}

describe("what a rendered run says of its elements", () => {
  it("says where every element's Markdown starts", () => {
    for (let { name, tab } of CORPUS) {
      let { content } = tab.body;
      let told = toldWhole(tab);
      let { blocks, protectedRanges, tables } = told.sourceMap;
      expect(told.flags.length, name).toBe(content.length);
      expect(told.starts.length, name).toBe(content.length + 1);
      expect(told.starts.every((start, at) => at === 0 || start >= told.starts[at - 1]), name)
        .toBe(true);
      expectFlagsSayWhatIsWritten(told, name);

      let owned = (flag: number) =>
        content.flatMap((_, element) => told.flags[element] & flag ? [element] : []);
      let blockOwners = owned(ELEMENT_BLOCK), tableOwners = owned(ELEMENT_TABLE);
      expect(blockOwners.map(element => content[element].startIndex), name)
        .toEqual(blocks.map(block => block.docStart));
      expect(tableOwners.map(element => content[element].startIndex), name)
        .toEqual(tables.map(table => table.docStart));
      expect(owned(ELEMENT_PROTECTS), name)
        .toEqual(content.flatMap((element, index) => protects(element) ? [index] : []));
      expect(protectedRanges.length, name).toBe(owned(ELEMENT_PROTECTS).length);
      expect(owned(ELEMENT_DEEP), name).toEqual(blockOwners.filter((_, block) =>
        blocks[block].listType !== null && blocks[block].listNestingLevel > 0));

      // A paragraph's Markdown is its blank line, where it has one, and its block; a table's
      // the blank line, its HTML and the line break after it.
      for (let [block, element] of blockOwners.entries()) {
        let lead = blocks[block].mdStart - told.starts[element];
        if ((lead !== 0 && lead !== 1) || blocks[block].mdEnd !== told.starts[element + 1]) {
          expect.fail(`${name}: element ${element} is not where its block is`);
        }
      }
      for (let [table, element] of tableOwners.entries()) {
        let lead = tables[table].mdStart - told.starts[element];
        if ((lead !== 0 && lead !== 1) || tables[table].mdEnd + 1 !== told.starts[element + 1]) {
          expect.fail(`${name}: element ${element} is not where its table is`);
        }
      }
    }
  });

  it("joined runs say what the whole tab says", () => {
    for (let { name, tab } of CORPUS) {
      let whole = toldWhole(tab);
      for (let cut of CUTS) {
        let { length } = tab.body.content;
        let joined = joinedFor(cutTab(tab, cut.of(length)), 0, 0, 0);
        expect([...joined.starts, joined.markdown.length], `${name}, ${cut.name}`)
          .toEqual(whole.starts);
        expect(joined.flags, `${name}, ${cut.name}`).toEqual(whole.flags);
      }
    }
  });

  it("what an element writes is told from the text it writes", () => {
    let last: BlockSpec[] = [
      { runs: ["\u000b\n"] }, heading(""), item("", "L1"), para(""),
    ];
    for (let [index, block] of last.entries()) {
      for (let blocks of [[para("Before."), block], [block]]) {
        let tab = buildTab(blocks, NUMBERED_LIST);
        // As the tab's first element: with no opening section break before it.
        if (blocks.length === 1) tab.body.content.shift();
        let told = toldWhole(tab);
        let where = `block ${index}, ${blocks.length === 1 ? "first" : "after a paragraph"}`;
        expectFlagsSayWhatIsWritten(told, where);
        // An empty paragraph outside a list writes line breaks alone; a soft line break, a
        // heading's marker and a list item's are characters.
        expect(told.flags.at(-1)! & (ELEMENT_BREAKS | ELEMENT_TEXT), where)
          .toBe(index === 3 ? ELEMENT_BREAKS : ELEMENT_TEXT);
      }
    }
  });

  it("a rendering that is not asked says nothing of its elements", () => {
    for (let { name, tab } of CORPUS) {
      let bounds = forcedRuns(tab.body.content.length, 2);
      let pass = initialCarry();
      let at = 0;
      for (let run = 0; run + 1 < bounds.length; run++) {
        let elements = tab.body.content.slice(bounds[run], bounds[run + 1]);
        let plain = renderRun(elements, tab, pass, { mdStart: at });
        let { elements: told, ...asked } =
          renderRun(elements, tab, pass, { mdStart: at, elements: true });
        expect("elements" in plain, name).toBe(false);
        expect(told?.starts.length, name).toBe(elements.length);
        expect(plain, `${name}, run ${run}`).toEqual(asked);
        advanceCarry(pass, plain.summary);
        at += plain.markdown.length;
      }
    }
  });

  it("a structure's text is not read to tell what it writes, asked or not", () => {
    // A test of a table's HTML would copy it once more: a structure is written untested.
    let tab = buildTab([grid(["Cell", "Next"]), para("After."), grid(["Last"])]);
    let { content } = tab.body;
    // The table first in its run, as each is on a tab of many tables, and after a paragraph.
    for (let [from, to, tables] of [[1, 2, 1], [1, 4, 2], [0, 4, 2], [2, 4, 1]]) {
      for (let elements of [false, true]) {
        let tested = textsTested(() =>
          renderRun(content.slice(from, to), tab, initialCarry(), { mdStart: 0, elements }));
        let { markdown, sourceMap } =
          renderRun(content.slice(from, to), tab, initialCarry(), { mdStart: 0, elements });
        let where = `elements ${from} to ${to}, ${elements ? "asked" : "not asked"}`;
        expect(sourceMap.tables.length, where).toBe(tables);
        for (let { mdStart, mdEnd } of sourceMap.tables) {
          let html = markdown.slice(mdStart, mdEnd);
          expect(html, where).toMatch(/^<table[^]*<\/table>$/);
          expect(tested.filter(text => text.includes(html)), where).toEqual([]);
        }
        // What the paragraph writes is tested only where the pass tells its elements.
        expect(tested.includes("After."), where).toBe(elements && to === 4);
      }
    }
  });
});

describe("a piece cut from joined runs", () => {
  it.each(CUTS)("is the same part of the whole: $name", cut => {
    for (let [number, { name, tab }] of CORPUS.entries()) {
      let whole = toldWhole(tab);
      let runs = cutTab(tab, cut.of(tab.body.content.length));
      for (let [from, to] of rangesOf(tab, diceOf(1_000 + number))) {
        expectSamePiece(pieceRendering(joinedFor(runs, 0, from, to), from, to),
          partOfWhole(tab, whole, from, to), () => `${name}, elements ${from} to ${to}`);
      }
    }
  });

  it.each(CUTS)("runs joined from a later run place a piece the same: $name", cut => {
    for (let [number, { name, tab }] of CORPUS.entries()) {
      let whole = toldWhole(tab);
      let runs = cutTab(tab, cut.of(tab.body.content.length));
      // From the second run on and from a middle one.
      for (let first of new Set([1, runs.runs.length >> 1])) {
        if (first < 1 || first >= runs.runs.length) continue;
        let skipped = runs.bounds[first];
        let tablesSkipped =
          whole.flags.slice(0, skipped).filter(flag => flag & ELEMENT_TABLE).length;
        for (let [from, to] of rangesOf(tab, diceOf(2_000 + number))) {
          if (from < skipped) continue;
          let want = partOfWhole(tab, whole, from, to);
          expectSamePiece(
            pieceRendering(joinedFor(runs, first, from, to), from - skipped, to - skipped),
            { ...want, tablesBefore: want.tablesBefore - tablesSkipped },
            () => `${name}, elements ${from} to ${to}, joined from run ${first}`);
        }
      }
    }
  });

  describe("what an element writes backwards stays true at a piece's two ends", () => {
    let chip: BlockSpec = { runs: [{ person: { name: "Ada", email: "ada@example.com" } }, "\n"] };
    // Elements: the opening section break, the table, a paragraph, the chip's, a paragraph.
    let tab = buildTab([grid(["Cell"]), para("After the table."), chip, para("Last.")]);
    let whole = toldWhole(tab);
    let piece = (from: number, to: number, first = 0, of = tab) => {
      let runs = cutTab(of, oneElementRuns(of.body.content.length));
      return pieceRendering(joinedFor(runs, first, 0, 0), from - first, to - first);
    };

    it("in the whole tab a range ends in the blank line of the element after it", () => {
      let [table, guarded] = protectedOf(whole);
      expect(table.mdEnd).toBe(whole.starts[2] + 1);
      expect(guarded).toEqual({ mdStart: whole.starts[3] - 1, mdEnd: whole.starts[4] + 1 });
    });

    it("a piece that ends with a protected element ends its range where the piece ends", () => {
      let ended = piece(0, 2);
      expect(protectedOf(ended)).toEqual([{ mdStart: 0, mdEnd: ended.markdown.length }]);
      // The chip's range starts one character before a piece its paragraph is first in.
      let guarded = piece(3, 4);
      expect(protectedOf(guarded)).toEqual([{ mdStart: -1, mdEnd: guarded.markdown.length }]);
    });

    it("a piece that ends before a protecting paragraph leaves its last character unguarded", () => {
      // The chip's range starts on the line break that ends this piece: no entry of it.
      let last = whole.starts[3] - 1;
      expect(whole.markdown[last]).toBe("\n");
      expect(protectedOf(whole)[1].mdStart).toBe(last);
      let before = piece(2, 3);
      expect(before.markdown).toBe(whole.markdown.slice(whole.starts[2], whole.starts[3]));
      expect(protectedOf(before)).toEqual([{ mdStart: 0, mdEnd: 1 }]);
      expect(protectedOf(before).filter(range => range.mdEnd >= before.markdown.length))
        .toEqual([]);
    });

    it("a piece that starts after a protected element holds the blank line as a range", () => {
      for (let from of [2, 4]) {
        let started = piece(from, from + 1);
        expect(started.markdown.startsWith("\n"), `element ${from}`).toBe(true);
        expect(protectedOf(started), `element ${from}`).toEqual([{ mdStart: 0, mdEnd: 1 }]);
      }
      // The chip's own range comes after the one the table leaves.
      let both = piece(2, 4);
      expect(protectedOf(both)).toEqual([
        { mdStart: 0, mdEnd: 1 },
        { mdStart: whole.starts[3] - 1 - whole.starts[2], mdEnd: both.markdown.length },
      ]);
    });

    it("and so does one cut from runs joined after the protected element", () => {
      for (let from of [2, 4]) {
        let runs = cutTab(tab, oneElementRuns(tab.body.content.length));
        let joined = joinedFor(runs, from, 0, 0);
        expect(joined.extendsProtected, `element ${from}`).toBe(true);
        expect(protectedOf(pieceRendering(joined, 0, 1)), `element ${from}`)
          .toEqual([{ mdStart: 0, mdEnd: 1 }]);
        expect(piece(from, from + 1, from), `element ${from}`)
          .toEqual({ ...piece(from, from + 1), tablesBefore: 0 });
      }
    });

    it("and one whose runs start with an element that writes nothing", () => {
      // An element that writes nothing, as pruning may leave one, between the table and the
      // paragraph after it.
      let between = structuredClone(tab);
      let at = between.body.content[2].startIndex;
      between.body.content.splice(2, 0, { startIndex: at, endIndex: at });
      let told = toldWhole(between);
      expect(told.flags[2]).toBe(0);
      expect(told.starts[2]).toBe(told.starts[3]);
      expect(protectedOf(told)[0].mdEnd).toBe(told.starts[3] + 1);

      let runs = cutTab(between, oneElementRuns(between.body.content.length));
      let joined = joinedFor(runs, 2, 0, 0);
      expect(joined.starts[1]).toBe(joined.mdStart);
      expect(joined.extendsProtected).toBe(true);
      let paragraph = pieceRendering(joined, 1, 2);
      expect(protectedOf(paragraph)).toEqual([{ mdStart: 0, mdEnd: 1 }]);
      expect(paragraph).toEqual({ ...piece(3, 4, 0, between), tablesBefore: 0 });
      // The element that writes nothing, alone: no character, and no range.
      let nothing = pieceRendering(joinedFor(runs, 2, 0, 0), 0, 1);
      expect(nothing.markdown).toBe("");
      expect(protectedOf(nothing)).toEqual([]);
      expect(protectedOf(piece(2, 4, 0, between))).toEqual([{ mdStart: 0, mdEnd: 1 }]);
    });
  });

  it("refuses runs that do not say what their elements write, and a range they do not hold", () => {
    let tab = buildTab([para("One."), grid(["Cell"]), para("Two.")]);
    let { content } = tab.body;
    let asked = renderRun(content.slice(0, 2), tab, initialCarry(), { mdStart: 0, elements: true });
    let pass = initialCarry();
    advanceCarry(pass, asked.summary);
    let silent = renderRun(content.slice(2), tab, pass, { mdStart: asked.markdown.length });

    let joined = noRenderedRuns();
    joinRenderedRun(joined, asked);
    expect(() => joinRenderedRun(joined, silent)).toThrow(/says nothing of its elements/);
    // Nothing of the run refused is joined.
    expect(joined.markdown).toBe(asked.markdown);
    expect(joined.sourceMap).toEqual(asked.sourceMap);

    let unasked = noRenderedRuns();
    joinRenderedRun(unasked, renderRun(content, tab, initialCarry(), { mdStart: 0 }));
    expect(unasked.starts).toEqual([]);
    expect(() => pieceRendering(unasked, 0, 0)).toThrow(/do not say what their elements write/);

    for (let [from, to] of [[-1, 1], [2, 1], [0, 3], [3, 3]]) {
      let two = noRenderedRuns();
      joinRenderedRun(two, renderRun(content.slice(0, 2), tab, initialCarry(),
        { mdStart: 0, elements: true }));
      expect(() => pieceRendering(two, from, to), `${from} to ${to}`)
        .toThrow(/no range of the elements joined/);
    }
  });
});
