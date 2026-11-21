// The run cut and the stored form of a run: a tab cut into runs and decoded is the tab, a run is
// named by its content alone, and a tab's stored runs rendered in order render as the tab.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { GoogleDocsTab, ParagraphElement, StructuralElement } from "../src/docs-api";
import { wholeFootnoteNumber } from "../src/docs-content";
import { applyDocsRequests } from "../src/docs-model";
import { cutRuns, decodeRun, endsRun, RUN_SIZES } from "../src/docs-runs";
import type { CutRun, RunSizes } from "../src/docs-runs";
import {
  advanceCarry, docTabToMarkdown, initialCarry, renderRun, runCarryKey,
} from "../src/markdown-converter";
import type { RenderCarry, RenderedRun } from "../src/markdown-converter";
import { buildTab, cellOf, diceOf, footnote, grid, para } from "./doc-fixture";
import type { BlockSpec } from "./doc-fixture";
import {
  advancedCopy, appendRun, carryOf, expectSame, expectSameRendering, fuzzedTabs, INITIAL_CARRY,
  largeTabs, noRuns, recordedTabs, throughJson,
} from "./render-run-tabs";
import type { NamedTab } from "./render-run-tabs";

/** Sizes of a small target, under which a run of one to three elements is cut. */
const FORCED: RunSizes = { least: 0, target: 400, most: Infinity, elements: 3 };
/** Sizes that make every element a run. */
const ONE_EACH: RunSizes = { ...FORCED, elements: 1 };

/** The two cuts every property is held under. */
const CUTS: { cut: string; sizes: RunSizes }[] = [
  { cut: "about 32 KiB a run", sizes: RUN_SIZES },
  { cut: "an element a run", sizes: ONE_EACH },
];

const label = (at: number) => `Line ${String(at).padStart(5, "0")}.`;

// Built once: a test cuts these tabs and changes none.
const RECORDED = recordedTabs();
const LARGE = largeTabs();
/** 20,000 paragraphs that differ only in the digits of their text. */
const LINES = throughJson(buildTab(Array.from({ length: 20_000 }, (_, at) => para(label(at)))));
const NUMBERED_ITEMS = LARGE.find(({ name }) => name === "a numbered list of 20,000 items")!.tab;

/** The seed of the first shard of fuzzed tabs: shard `n` is drawn from this plus `n`. */
const FUZZED_SEED = 20261117;

/** The corpus, in parts small enough that a property over one fits a test. */
const CORPUS: { part: string; tabs: () => NamedTab[] }[] = [
  { part: "the recordings", tabs: () => RECORDED },
  ...Array.from({ length: 6 }, (_, shard) => ({
    part: `fuzzed tabs, shard ${shard}`, tabs: () => fuzzedTabs(FUZZED_SEED + shard, 100),
  })),
  ...LARGE.map(tab => ({ part: tab.name, tabs: () => [tab] })),
];

/** A run of a tab, and where it stands in it. */
type PlacedRun = CutRun & {
  /** The run's first index: the tab's first index and the sizes of the runs before it. */
  first: number;
  /** How many footnote references the runs before it hold. */
  footnoteBase: number;
};

/** The runs `sizes` cut `content` into, each at its place. */
function placedRuns(content: Iterable<StructuralElement>, sizes: RunSizes): PlacedRun[] {
  let first: number | undefined;
  let footnoteBase = 0;
  let placed: PlacedRun[] = [];
  for (let run of cutRuns(content, sizes)) {
    let start: unknown = run.elements[0]?.startIndex;
    first ??= Number.isInteger(start) ? start as number : 0;
    placed.push({ ...run, first, footnoteBase });
    first += run.size;
    footnoteBase += run.footnotes;
  }
  return placed;
}

/** `run` decoded at its place, which it must be a stored run for. */
function decodedRun(
  run: PlacedRun, exact = false, footnotes = run.footnoteBase,
): StructuralElement[] {
  let decoded = decodeRun(run.json, { first: run.first, footnotes, exact });
  if (!decoded) throw new Error("A run cutRuns made does not decode");
  expect(decoded.footnotes).toBe(run.footnotes);
  return decoded.elements;
}

/** `runs` decoded in order, each at its place, and joined. */
function decodedBody(runs: readonly PlacedRun[], exact = false): StructuralElement[] {
  return runs.flatMap(run => decodedRun(run, exact));
}

/** `content` as it reads back: without a start index of 0 on a section break that opens it. */
function asReadBack(content: readonly StructuralElement[]): readonly StructuralElement[] {
  let [opening, ...rest] = content;
  if (!opening?.sectionBreak || opening.startIndex !== 0) return content;
  let { startIndex: _, ...kept } = opening;
  return [kept as StructuralElement, ...rest];
}

/** How many footnote references `elements` hold, read off their JSON. */
function footnotesIn(elements: readonly StructuralElement[]): number {
  return JSON.stringify(elements).split('"footnoteReference":').length - 1;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("base64");

describe.each(CUTS)("a tab cut into runs, $cut", ({ sizes }) => {
  it.each(CORPUS)("and decoded is the tab: $part", ({ tabs }) => {
    for (let { name, tab } of tabs()) {
      let { content } = tab.body;
      expectSame(decodedBody(placedRuns(content, sizes)), asReadBack(content), () => name);
    }
  });

  it("and decoded is the tab as Google sent it, key for key", () => {
    for (let { name, tab } of RECORDED) {
      // Google sends the opening section break with no start index: nothing is left out.
      expect(asReadBack(tab.body.content), name).toBe(tab.body.content);
      let decoded = decodedBody(placedRuns(tab.body.content, sizes));
      expect(JSON.stringify(decoded), name).toBe(JSON.stringify(tab.body.content));
    }
  });

  it("and decoded as the model's is the tab the model made", () => {
    for (let { name, tab } of [...RECORDED, ...largeTabs(20)]) {
      let made = applyDocsRequests(tab, []);
      expect(made.body.content[0].startIndex, name).toBe(0);
      let runs = placedRuns(made.body.content, sizes);
      expectSame(decodedBody(runs, true), made.body.content, () => name);
      // Read as another tab's, it holds everything but its opening section break's start.
      expectSame(decodedBody(runs), asReadBack(made.body.content), () => name);
    }
  });

  it.each(CORPUS)(
    "a run's JSON is the JSON of its stored elements, and it carries its elements and says " +
    "what it holds: $part",
    ({ tabs }) => {
      for (let { name, tab } of tabs()) {
        let { content } = tab.body;
        let runs = placedRuns(content, sizes);
        let at = 0;
        for (let run of runs) {
          let where = `${name}, the run at element ${at}`;
          if (JSON.stringify(JSON.parse(run.json)) !== run.json) expect.fail(`${where}: its JSON`);
          expect(run.elements.length, where).toBeGreaterThan(0);
          // The objects the cut was given, in an array of the run's own.
          for (let element of run.elements) {
            if (element !== content[at++]) expect.fail(`${where}: not the body's own element`);
          }
          let [opening] = run.elements;
          let last = run.elements.at(-1)!;
          expect(run.size, where).toBe(last.endIndex - run.first);
          expect(run.footnotes, where).toBe(footnotesIn(run.elements));
          expect(run.holds, where)
            .toBe(opening.table ? "table" : opening.paragraph ? "paragraph" : "element");
        }
        expect(at, name).toBe(content.length);
      }
    });

  it.each(CORPUS)("the body is read once, as it comes: $part", ({ tabs }) => {
    for (let { name, tab } of tabs()) {
      let ended = false;
      let asItComes = (function* () {
        yield* tab.body.content;
        ended = true;
      })();
      // An iterator that is asked again after its end is one the cut read twice.
      let once: Iterable<StructuralElement> = {
        [Symbol.iterator]: () => ({
          next: () => {
            if (ended) throw new Error("The body was asked for an element after its end");
            return asItComes.next();
          },
        }),
      };
      let cut = Array.from(cutRuns(once, sizes), run => run.json);
      expect(ended, name).toBe(true);
      expect(cut, name).toEqual(Array.from(cutRuns(tab.body.content, sizes), run => run.json));
    }
  });

  it.each(CORPUS)(
    "a table is alone in its run and no run of several elements passes the maximum: $part",
    ({ tabs }) => {
      for (let { name, tab } of tabs()) {
        for (let run of cutRuns(tab.body.content, sizes)) {
          if (run.elements.length === 1) continue;
          expect(run.elements.some(element => element.table), name).toBe(false);
          expect(run.json.length, name).toBeLessThanOrEqual(sizes.most);
          expect(run.elements.length, name).toBeLessThanOrEqual(sizes.elements);
        }
      }
    });

  it("an empty body is one run of no element", () => {
    expect([...cutRuns([], sizes)])
      .toEqual([{ json: "[]", elements: [], size: 0, footnotes: 0, holds: "element" }]);
    for (let exact of [false, true]) {
      expect(decodeRun("[]", { first: 0, footnotes: 0, exact }))
        .toEqual({ elements: [], footnotes: 0 });
    }
    let tab: GoogleDocsTab = { ...buildTab([]), body: { content: [] } };
    let rendered = renderRun([], tab, initialCarry(), { mdStart: 0 });
    expectSameRendering(rendered, docTabToMarkdown(tab), "an empty body");
    expect(rendered.markdown).toBe("");
  });
});

/** A paragraph of `text` from `startIndex`, with the indexes given: `undefined` leaves one out. */
function paragraphAt(text: string, startIndex: unknown, endIndex: unknown): StructuralElement {
  let indexes = {
    ...(startIndex === undefined ? {} : { startIndex }),
    ...(endIndex === undefined ? {} : { endIndex }),
  };
  return {
    ...indexes,
    paragraph: { elements: [{ ...indexes, textRun: { content: text } }], paragraphStyle: {} },
  } as StructuralElement;
}

/** A copy of `elements`, every index moved by `by` and every whole footnote number by `notes`. */
function moved(
  elements: readonly StructuralElement[], by: number, notes: number,
): StructuralElement[] {
  return JSON.parse(JSON.stringify(elements), (key, held: unknown) => {
    if ((key === "startIndex" || key === "endIndex") && typeof held === "number") return held + by;
    if (key !== "footnoteNumber" || typeof held !== "string") return held;
    let number = wholeFootnoteNumber(held);
    return number === undefined ? held : String(number + notes);
  }) as StructuralElement[];
}

/** A footnote reference numbered `footnoteNumber`, or with no number, one index long at `at`. */
function referenceAt(at: number, footnoteNumber?: string): ParagraphElement {
  return {
    startIndex: at, endIndex: at + 1,
    footnoteReference: {
      footnoteId: `f${at}`, ...(footnoteNumber === undefined ? {} : { footnoteNumber }),
    },
  };
}

/** A table that ends at `endIndex` and holds `notes` footnote references, numbered from 1. */
function tableOfNotes(endIndex: number, notes: number): StructuralElement {
  let elements = Array.from({ length: notes }, (_, at) => referenceAt(3 + at, String(at + 1)));
  let paragraphStyle = { namedStyleType: "NORMAL_TEXT" };
  let paragraph = { elements, paragraphStyle };
  let content = [{ startIndex: 3, endIndex: endIndex - 1, paragraph }];
  let tableCells = [{ startIndex: 2, endIndex: endIndex - 1, content }];
  return {
    startIndex: 0, endIndex,
    table: { tableRows: [{ startIndex: 1, endIndex: endIndex - 1, tableCells }] },
  };
}

/** Sizes under which no run ends by its content: by `most` and the count of `elements` alone. */
const byMaximum = (most: number, elements = Infinity): RunSizes =>
  ({ least: Infinity, target: Infinity, most, elements });

describe("the stored form of a run", () => {
  it.each<{ body: string; content: StructuralElement[] }>([
    {
      body: "whose second paragraph holds no end index",
      content: [
        { endIndex: 1, sectionBreak: {} } as StructuralElement, paragraphAt("one\n", 1, 5),
        paragraphAt("two\n", 5, undefined), paragraphAt("three\n", 9, 15),
      ],
    },
    {
      body: "whose last element holds no end index",
      content: [
        { endIndex: 1, sectionBreak: {} } as StructuralElement, paragraphAt("one\n", 1, 5),
        paragraphAt("two\n", 5, undefined),
      ],
    },
    {
      body: "whose first element holds neither index",
      content: [
        paragraphAt("one\n", undefined, undefined), paragraphAt("two\n", 5, 9),
        paragraphAt("three\n", 9, 15),
      ],
    },
    {
      body: "that holds an end index of 1.5",
      content: [
        paragraphAt("one\n", 1.5, 1.5), paragraphAt("two\n", 2, 6), paragraphAt("three\n", 6, 1.5),
        paragraphAt("four\n", 12, 17),
      ],
    },
  ])("an element with no end ends where the one before it does: a body $body", ({ content }) => {
    for (let sizes of [ONE_EACH, RUN_SIZES]) {
      // `placedRuns` gives each run the running sum of the sizes before it as its first index.
      let runs = placedRuns(content, sizes);
      for (let run of runs) {
        expect(Number.isInteger(run.size)).toBe(true);
        expect(Number.isInteger(run.first)).toBe(true);
        expect(run.size).toBeGreaterThanOrEqual(0);
      }
      // The absent index absent, the fraction as it was.
      expect(JSON.stringify(decodedBody(runs))).toBe(JSON.stringify(content));
    }
    // One element a run: as long as its element says, or of no length where it holds no end.
    let start: unknown = content[0].startIndex;
    let end = Number.isInteger(start) ? start as number : 0;
    expect(placedRuns(content, ONE_EACH).map(run => run.size)).toEqual(content.map(element => {
      let before = end;
      if (Number.isInteger(element.endIndex)) end = element.endIndex;
      return end - before;
    }));
  });

  it("positions are counted from the run", () => {
    let blocks: BlockSpec[] = [
      { runs: ["First", footnote(1), ".\n"] }, para("Plain."),
      { table: [[cellOf({ runs: ["In a cell", footnote(2), ".\n"] }), "beside"]] },
      { runs: ["Odd", { footnote: { id: "odd", number: "007" } }, footnote(3), ".\n"] },
      ...Array.from({ length: 12 }, (_, at) => ({ runs: [label(at), footnote(4 + at), "\n"] })),
    ];
    // The content after the fixture's opening section break, which starts at index 1.
    let elements = buildTab(blocks).body.content.slice(1);
    let near = [tableOfNotes(1, 0), ...elements];
    let far = [tableOfNotes(1_000_001, 40), ...moved(elements, 1_000_000, 40)];
    expect(JSON.stringify(far)).not.toBe(JSON.stringify(near));
    for (let sizes of [RUN_SIZES, ONE_EACH]) {
      // The table is a run of its own: the runs after it are not their tab's first.
      let [, ...nearRuns] = placedRuns(near, sizes);
      let [, ...farRuns] = placedRuns(far, sizes);
      expect(nearRuns.length).toBeGreaterThan(sizes === RUN_SIZES ? 0 : 5);
      expect(farRuns.map(run => run.json)).toEqual(nearRuns.map(run => run.json));
      expect(farRuns[0].first).toBe(1_000_001);
      expect(farRuns[0].footnoteBase).toBe(40);
      expect(decodedBody(farRuns)).toEqual(far.slice(1));
      expect(decodedBody(nearRuns)).toEqual(near.slice(1));
    }
  });

  it("a stretch cut with a footnote base stores each number counted from the references before its run", () => {
    let body = buildTab([
      { runs: ["First", footnote(1), ".\n"] }, para("Plain."),
      { table: [[cellOf({ runs: ["In a cell", footnote(2), ".\n"] }), "beside"]] },
      ...Array.from({ length: 12 }, (_, at) => ({ runs: [label(at), footnote(3 + at), "\n"] })),
    ]).body.content;
    for (let sizes of [ONE_EACH]) {
      let whole = placedRuns(body, sizes);
      expect(whole.length).toBeGreaterThan(5);
      let elements = 0, based = 0;
      for (let [place, run] of whole.entries()) {
        // The elements from this run's boundary on, cut as a stretch of their own.
        let stretch = [...cutRuns(body.slice(elements), sizes, run.footnoteBase)];
        expect(stretch.map(cut => cut.json), `from run ${place}`)
          .toEqual(whole.slice(place).map(cut => cut.json));
        expect(stretch.map(cut => [cut.size, cut.footnotes]))
          .toEqual(whole.slice(place).map(cut => [cut.size, cut.footnotes]));
        if (run.footnoteBase > 0 && run.footnotes > 0) {
          // With no base the same elements are stored under other numbers.
          based++;
          expect([...cutRuns(body.slice(elements), sizes)][0].json).not.toBe(run.json);
        }
        elements += run.elements.length;
      }
      expect(based).toBeGreaterThan(3);
    }
  });

  it("an element larger than the maximum is alone", () => {
    let large = "x".repeat(70_000);
    let table: BlockSpec =
      { table: Array.from({ length: 40 }, (_, row) => [`${row} ${"y".repeat(2_000)}`]) };
    let tab = buildTab([
      para("Before."), para(large), para("Between."), table, para("After."), para(large),
    ]);
    let runs = placedRuns(tab.body.content, RUN_SIZES);
    expect(runs.map(run => run.elements.length)).toEqual([2, 1, 1, 1, 1, 1]);
    expect(runs.map(run => run.holds))
      .toEqual(["element", "paragraph", "paragraph", "table", "paragraph", "paragraph"]);
    for (let run of [runs[1], runs[3], runs[5]]) {
      expect(run.json.length).toBeGreaterThan(RUN_SIZES.most);
    }
    expectSame(decodedBody(runs), asReadBack(tab.body.content), () => "the large elements");
  });

  it("a run of several elements holds the maximum and not a character more", () => {
    let { content } = buildTab(Array.from({ length: 12 }, (_, at) => para(label(at)))).body;
    for (let count of [2, 3, 5, 8]) {
      let [{ json }] = placedRuns(content, byMaximum(Infinity, count));
      // A maximum of exactly the run's JSON, brackets and commas counted, holds the run.
      let fits = placedRuns(content, byMaximum(json.length));
      expect(fits[0].json).toBe(json);
      expect(fits[0].elements.length).toBe(count);
      // One character less holds one element less.
      let short = placedRuns(content, byMaximum(json.length - 1));
      expect(short[0].elements.length).toBe(count - 1);
      for (let [runs, most] of [[fits, json.length], [short, json.length - 1]] as const) {
        for (let run of runs) {
          if (run.elements.length > 1) expect(run.json.length).toBeLessThanOrEqual(most);
        }
        expect(JSON.stringify(decodedBody(runs))).toBe(JSON.stringify(asReadBack(content)));
      }
    }
  });

  it("an element that leaves out what it may hold is stored and read back as it is", () => {
    let rows = [
      { startIndex: 5, endIndex: 6 },
      { startIndex: 6, endIndex: 8, tableCells: [{ startIndex: 7, endIndex: 8 }] },
    ];
    let content = [
      { endIndex: 1, sectionBreak: {} }, { startIndex: 1, endIndex: 2, paragraph: {} },
      { startIndex: 2, endIndex: 4, table: {} },
      { startIndex: 4, endIndex: 9, table: { tableRows: rows } },
      { startIndex: 9, endIndex: 10, tableOfContents: {} }, { startIndex: 10, endIndex: 11 },
    ] as StructuralElement[];
    for (let sizes of [ONE_EACH, RUN_SIZES]) {
      let runs = placedRuns(content, sizes);
      expect(JSON.stringify(decodedBody(runs))).toBe(JSON.stringify(content));
      expect(runs.reduce((sum, run) => sum + run.size, 0)).toBe(11);
    }
  });
});

/** A copy of the paragraph `like` that holds `text` and starts at `startIndex`. */
function paragraphOf(like: StructuralElement, text: string, startIndex: number): StructuralElement {
  let copy = throughJson(like);
  let endIndex = startIndex + text.length;
  let [run] = copy.paragraph!.elements;
  let textRun = { ...run.textRun!, content: text };
  copy.paragraph!.elements = [{ ...run, startIndex, endIndex, textRun }];
  return { ...copy, startIndex, endIndex };
}

/** Three small changes of a body of paragraphs, each giving the body as the model indexes it. */
const CHANGES: {
  change: string;
  edit: (content: readonly StructuralElement[]) => StructuralElement[];
}[] = [
  {
    change: "one paragraph's text changed in the middle",
    edit: content => {
      let at = content.length >> 1;
      let old = content[at];
      let put = paragraphOf(old, "Changed in the middle.\n", old.startIndex);
      let after = moved(content.slice(at + 1), put.endIndex - old.endIndex, 0);
      return [...content.slice(0, at), put, ...after];
    },
  },
  {
    change: "a paragraph put in after the tenth",
    edit: content => {
      // The section break that opens the body stands before the first paragraph.
      let put = paragraphOf(content[11], "Put in.\n", content[11].startIndex);
      return [
        ...content.slice(0, 11), put, ...moved(content.slice(11), put.endIndex - put.startIndex, 0),
      ];
    },
  },
  {
    change: "a paragraph removed near the start",
    edit: content => {
      let old = content[5];
      return [...content.slice(0, 5), ...moved(content.slice(6), old.startIndex - old.endIndex, 0)];
    },
  },
];

/** How many runs of `before` and `after` stand between the first that differs and the last. */
function changedRuns(before: readonly string[], after: readonly string[]): number {
  let least = Math.min(before.length, after.length);
  let head = 0;
  while (head < least && before[head] === after[head]) head++;
  let tail = 0;
  while (tail < least - head && before.at(-1 - tail) === after.at(-1 - tail)) tail++;
  return Math.max(before.length, after.length) - head - tail;
}

/** The SHA-256 of each run's JSON, which names the run where it is stored. */
function runIds(content: Iterable<StructuralElement>, sizes: RunSizes): string[] {
  return Array.from(cutRuns(content, sizes), run => sha256(run.json));
}

/** WHAT MUST NOT BE DONE: the hash with every digit left out, those of the text too. */
const endsRunWithoutDigits: typeof endsRun = (json, sizes) =>
  endsRun(json.replace(/[0-9-]/g, ""), sizes);

/** The rule of `cutRuns` for a body of paragraphs, with `ends` in place of `endsRun`. */
function cutBy(
  ends: typeof endsRun, content: readonly StructuralElement[], sizes: RunSizes,
): string[] {
  let runs: string[] = [];
  let run = "";
  for (let { json } of cutRuns(content, ONE_EACH)) {
    let element = json.slice(1, -1);
    if (run !== "" && run.length + element.length + 2 > sizes.most) {
      runs.push(run);
      run = "";
    }
    run += `,${element}`;
    if (run.length + 1 >= sizes.least && ends(element, sizes)) {
      runs.push(run);
      run = "";
    }
  }
  return run === "" ? runs : [...runs, run];
}

/** The stored element `json` with every number that counts from its run another number. */
const elsewhere = (json: string) => json.replace(
  /"(startIndex|endIndex|footnoteNumber)":-?\d+/g, (_, key: string) => `"${key}":-987654`);

/** The body of a tab of `first` and then `count` empty paragraphs. */
const emptyParagraphs = (count: number, ...first: BlockSpec[]) =>
  buildTab([...first, ...Array.from({ length: count }, () => para(""))]).body.content;

/** The texts a long checklist repeats: none of them, stored as a paragraph, ends a run. */
const FEW_TEXTS = ["Done.", "To do, and waiting on a reply.", "Not started."];

/** 20,000 paragraphs drawn from `FEW_TEXTS` but those at `without`, a table, and 5,000 more. */
function fewTexts(without: readonly number[] = []): StructuralElement[] {
  let { pick } = diceOf(20261117);
  let stretch = (count: number) => Array.from({ length: count }, () => para(pick(FEW_TEXTS)));
  let first = stretch(20_000).filter((_, at) => !without.includes(at));
  return buildTab([...first, grid(["a", "b"]), ...stretch(5_000)]).body.content;
}

/** How many of `runs` are cut by size: within 400 characters of the maximum. */
function atTheMaximum(runs: readonly string[], sizes: RunSizes): number {
  return runs.filter(run => run.length > sizes.most - 400).length;
}

describe("the cut by content", () => {
  it("a run of the 20,000-paragraph tab holds 32 KiB on average", () => {
    let runs = Array.from(cutRuns(LINES.body.content, RUN_SIZES), run => run.json);
    let mean = runs.reduce((sum, json) => sum + json.length, 0) / runs.length;
    expect(runs.length).toBeGreaterThan(100);
    expect(mean).toBeGreaterThan(24 * 1024);
    expect(mean).toBeLessThan(40 * 1024);
    for (let json of runs) expect(json.length).toBeLessThanOrEqual(RUN_SIZES.most);
    for (let json of runs.slice(0, -1)) expect(json.length).toBeGreaterThanOrEqual(RUN_SIZES.least);
    // By content, not by size.
    expect(atTheMaximum(runs, RUN_SIZES)).toBeLessThan(runs.length / 4);
  });

  describe.each([
    { tab: "20,000 paragraphs that differ in their digits", content: () => LINES.body.content },
    { tab: "a numbered list of 20,000 items", content: () => NUMBERED_ITEMS.body.content },
  ])("a change early in a tab moves the cuts near it and no other: $tab", ({ content }) => {
    it.each(CHANGES)("$change", ({ edit }) => {
      let before = runIds(content(), RUN_SIZES);
      let after = runIds(edit(content()), RUN_SIZES);
      expect(before.length).toBeGreaterThan(100);
      let changed = changedRuns(before, after);
      expect(changed).toBeGreaterThan(0);
      // Every run after the changed ones is the run it was, byte for byte.
      expect(changed).toBeLessThanOrEqual(3);
    });
  });

  it("the changes are bodies the model indexes as they are", () => {
    for (let { change, edit } of CHANGES) {
      let edited = edit(LINES.body.content);
      expectSame(applyDocsRequests({ ...LINES, body: { content: edited } }, []).body.content,
        edited, () => change);
    }
  });

  it("elements that differ only in digits of their text do not cut alike", () => {
    let { content } = LINES.body;
    let put = CHANGES[1].edit(content);
    // The rule itself, element by element: cut by content.
    let cut = cutBy(endsRun, content, RUN_SIZES);
    expect(cut.length).toBeGreaterThan(100);
    expect(atTheMaximum(cut, RUN_SIZES)).toBeLessThan(cut.length / 4);
    expect(changedRuns(cut, cutBy(endsRun, put, RUN_SIZES))).toBeLessThanOrEqual(3);

    // With every digit left out, every run but the last is cut by size, and a paragraph put in
    // early moves every cut after it.
    let bySize = cutBy(endsRunWithoutDigits, content, RUN_SIZES);
    expect(atTheMaximum(bySize, RUN_SIZES)).toBe(bySize.length - 1);
    expect(changedRuns(bySize, cutBy(endsRunWithoutDigits, put, RUN_SIZES)))
      .toBeGreaterThan(bySize.length / 2);
  });

  it("a number outside a string moves no cut, and a digit of the text does", () => {
    let noted = LARGE.find(({ name }) => name === "paragraphs with footnotes")!.tab;
    for (let sizes of [RUN_SIZES, FORCED]) {
      let answers = new Set<boolean>();
      let numbers = 0;
      for (let { json } of cutRuns(noted.body.content, ONE_EACH)) {
        let other = elsewhere(json);
        numbers += other.split('"footnoteNumber":-987654').length - 1;
        expect(other).not.toBe(json);
        let ends = endsRun(json, sizes);
        answers.add(ends);
        if (endsRun(other, sizes) !== ends) expect.fail(`Cut apart by a number: ${json}`);
      }
      expect(numbers).toBeGreaterThan(2_000);
      expect([...answers].toSorted()).toEqual([false, true]);
    }

    // Each paragraph against the next, which differs in the last digit (or more, one in ten).
    let stored = Array.from(cutRuns(LINES.body.content, ONE_EACH), run => run.json);
    let apart = (ends: typeof endsRun) => stored.filter((json, at) =>
      at > 1 && ends(json, RUN_SIZES) !== ends(stored[at - 1], RUN_SIZES)).length;
    expect(apart(endsRun)).toBeGreaterThan(100);
    expect(apart(endsRunWithoutDigits)).toBe(0);
  });

  it("a stretch of the same element is one stored run", () => {
    let runs = Array.from(cutRuns(emptyParagraphs(5_000), RUN_SIZES), run => run.json);
    expect(runs.length).toBeGreaterThan(8);
    // Every run between the first, which opens the body, and the last, which holds the rest.
    let between = new Set(runs.slice(1, -1));
    expect(between.size).toBe(1);
    expect(atTheMaximum(runs, RUN_SIZES)).toBe(runs.length - 1);

    let ids = new Set(runs.map(sha256));
    let after = runIds(emptyParagraphs(5_000, para("Put in.")), RUN_SIZES);
    expect(after.filter(id => !ids.has(id)).length).toBeLessThanOrEqual(3);
    expect(after.filter(id => ids.has(id)).length).toBeGreaterThan(8);
  });

  it("a long stretch drawn from a few elements is cut by size, and a paragraph taken out of it moves the cuts after it as far as the next table", () => {
    let content = fewTexts();
    // No element of the stretch ends a run, whatever its place.
    let stored = Array.from(cutRuns(content, ONE_EACH), run => run.json.slice(1, -1));
    expect(new Set(stored.map(elsewhere)).size).toBeLessThan(12);
    expect(stored.filter(json => !json.includes('"table"') && endsRun(json, RUN_SIZES))).toEqual([]);

    let before = Array.from(cutRuns(content, RUN_SIZES), run => run.json);
    let table = before.findIndex(json => json.includes('"table"'));
    let stretch = before.slice(0, table);
    expect(stretch.length).toBeGreaterThan(50);
    // Every run of the stretch but its last holds the maximum, and no two are the same run.
    expect(atTheMaximum(stretch, RUN_SIZES)).toBe(stretch.length - 1);
    expect(new Set(stretch).size).toBe(stretch.length);

    // The sixth paragraph taken out: most runs of the stretch are other runs.
    let after = Array.from(cutRuns(fewTexts([5]), RUN_SIZES), run => run.json);
    let tableAfter = after.findIndex(json => json.includes('"table"'));
    expect(changedRuns(stretch, after.slice(0, tableAfter))).toBeGreaterThan(stretch.length / 2);
    // The table ends a run wherever it stands: every run from it on is the run it was.
    expect(before.length - table).toBeGreaterThan(10);
    expect(after.slice(tableAfter)).toEqual(before.slice(table));
  });
});

/** The first element of the run stored as `json`, in its stored form. */
function firstStored(json: string): Record<string, unknown> {
  return (JSON.parse(json) as Record<string, unknown>[])[0];
}

describe("the section break that opens a body", () => {
  /** The large tab as Google sends one: its opening section break holds no start index. */
  let sent = throughJson(LINES);
  delete (sent.body.content[0] as Partial<StructuralElement>).startIndex;

  it("is stored and decoded with no start index, as Google sends it", () => {
    for (let { name, tab } of RECORDED) {
      let [opening] = placedRuns(tab.body.content, ONE_EACH);
      expect(tab.body.content[0].sectionBreak, name).toBeDefined();
      expect(Object.keys(firstStored(opening.json)), name).not.toContain("startIndex");
      expect(Object.keys(decodedRun(opening)[0]), name).not.toContain("startIndex");
    }
  });

  it("of a tab the model made is stored as the one Google sent, and decoded with its start", () => {
    for (let { name, tab } of RECORDED) {
      let made = applyDocsRequests(tab, []).body.content;
      for (let sizes of [RUN_SIZES, ONE_EACH]) {
        let runs = placedRuns(made, sizes);
        // The model indexes these tabs as Google does: every run is the run of Google's tab.
        expect(runs.map(run => run.json), name)
          .toEqual(Array.from(cutRuns(tab.body.content, sizes), run => run.json));
        expect(decodedRun(runs[0], true)[0].startIndex, name).toBe(0);
        // The model writes the start index after the keys Google sent, and so does the decoder.
        expect(JSON.stringify(decodedBody(runs, true)), name).toBe(JSON.stringify(made));
      }
    }

    // An edit past the first run leaves the first run the one of the tab Google sent.
    let { endIndex } = sent.body.content.at(-1)!;
    let made = applyDocsRequests(sent, [
      { insertText: { location: { index: endIndex - 1, tabId: sent.tabId }, text: " More" } },
    ]);
    expect(made.body.content[0].startIndex).toBe(0);
    let before = runIds(sent.body.content, RUN_SIZES);
    let after = placedRuns(made.body.content, RUN_SIZES);
    expect(after.slice(0, -1).map(run => sha256(run.json))).toEqual(before.slice(0, -1));
    expect(sha256(after.at(-1)!.json)).not.toBe(before.at(-1));
    expectSame(decodedBody(after, true), made.body.content, () => "the tab the model made");
  });

  it("holds no start index of 0 in storage, whoever made the tab", () => {
    let fixture = buildTab([para("One."), para("Two.")]);
    expect(fixture.body.content[0]).toEqual({ startIndex: 0, endIndex: 1, sectionBreak: {} });
    let [opening] = placedRuns(fixture.body.content, ONE_EACH);
    expect(firstStored(opening.json)).toEqual({ endIndex: 1, sectionBreak: {} });
    expect(decodedRun(opening)).toEqual([{ endIndex: 1, sectionBreak: {} }]);
    expect(decodedRun(opening, true)).toEqual([fixture.body.content[0]]);
  });

  it.each<{ opening: string; first: StructuralElement }>([
    { opening: "a paragraph", first: paragraphAt("one\n", 0, 4) },
    { opening: "a table", first: tableOfNotes(4, 0) },
  ])("alone loses a start index of 0: a body that opens with $opening keeps it", ({ first }) => {
    let content = [first, paragraphAt("two\n", 4, 8), paragraphAt("three\n", 8, 14)];
    for (let sizes of [ONE_EACH, RUN_SIZES]) {
      let runs = placedRuns(content, sizes);
      expect(firstStored(runs[0].json).startIndex).toBe(0);
      for (let exact of [false, true]) {
        expect(JSON.stringify(decodedBody(runs, exact))).toBe(JSON.stringify(content));
      }
    }
  });

  it("is told from a section break that starts a run after the body's start", () => {
    let { content } = buildTab([para("One."), { structure: "sectionBreak" }, para("Two.")]).body;
    let runs = placedRuns(content, ONE_EACH);
    expect(content[2].sectionBreak).toBeDefined();
    expect(firstStored(runs[2].json)).toEqual({ startIndex: 0, endIndex: 1, sectionBreak: {} });
    for (let exact of [false, true]) {
      expect(decodedRun(runs[2], exact)).toEqual([content[2]]);
      expect(decodedRun(runs[2], exact)[0].startIndex).toBe(content[2].startIndex);
    }
    // Later in a run of several elements, it holds its place in the run.
    let [several] = placedRuns(content, { ...FORCED, target: Infinity });
    expect((JSON.parse(several.json) as unknown[])[2]).toEqual(content[2]);

    // Only the body's first element opens it: one at index 0 after an unindexed element keeps it.
    let atZero = { startIndex: 0, endIndex: 1, sectionBreak: {} } as StructuralElement;
    let unplaced = [{ sectionBreak: {} } as StructuralElement, paragraphAt("", undefined, undefined)];
    for (let opening of unplaced) {
      let body = [opening, atZero];
      for (let sizes of [ONE_EACH, RUN_SIZES]) {
        let stored = placedRuns(body, sizes);
        expect(firstStored(stored[0].json)).toEqual(opening);
        expect(JSON.stringify(decodedBody(stored))).toBe(JSON.stringify(body));
      }
      let second = placedRuns(body, ONE_EACH)[1];
      expect(firstStored(second.json).startIndex).toBe(0);
      for (let exact of [false, true]) expect(decodedRun(second, exact)).toEqual([atZero]);
    }
  });

  it("keeps its start index in a tab whose body starts at another index than 0", () => {
    let content = moved(buildTab([para("One."), para("Two.")]).body.content, 7, 0);
    expect(content[0]).toEqual({ startIndex: 7, endIndex: 8, sectionBreak: {} });
    for (let sizes of [ONE_EACH, RUN_SIZES]) {
      let runs = placedRuns(content, sizes);
      expect(runs[0].first).toBe(7);
      expect(firstStored(runs[0].json)).toEqual({ startIndex: 0, endIndex: 1, sectionBreak: {} });
      for (let exact of [false, true]) {
        expect(JSON.stringify(decodedBody(runs, exact))).toBe(JSON.stringify(content));
      }
    }
  });
});

/** The footnote numbers of the stored run `json` in order, as their stored types. */
function storedFootnoteNumbers(json: string): unknown[] {
  let numbers: unknown[] = [];
  JSON.parse(json, (key, held: unknown) => {
    if (key === "footnoteReference") {
      numbers.push((held as { footnoteNumber?: unknown }).footnoteNumber);
    }
    return held;
  });
  return numbers;
}

/** A paragraph from `startIndex` that holds one footnote reference for each of `numbers`. */
function paragraphOfNotes(
  startIndex: number, numbers: readonly (string | undefined)[],
): StructuralElement {
  let elements = numbers.map((number, at) => referenceAt(startIndex + at, number));
  return {
    startIndex, endIndex: startIndex + numbers.length,
    paragraph: { elements, paragraphStyle: { namedStyleType: "NORMAL_TEXT" } },
  };
}

/** Texts of a footnote's number that are no whole number, and texts that are one. */
const NO_NUMBERS = ["", "x", "007", "-0", "+1", "1.5", "1e3", " 2", "1234567890"];
const WHOLE_NUMBERS = ["0", "1", "-3", "12345", "999999999"];

describe("a footnote's number", () => {
  let noted = LARGE.find(({ name }) => name === "paragraphs with footnotes")!.tab;

  it.each(CUTS)("by place is stored as the numbers 1, 2, ... of each run, $cut", ({ sizes }) => {
    let runs = placedRuns(noted.body.content, sizes);
    let held = 0;
    for (let run of runs) {
      let numbers = storedFootnoteNumbers(run.json);
      expect(numbers).toEqual(Array.from({ length: run.footnotes }, (_, at) => at + 1));
      held += numbers.length;
    }
    expect(held).toBeGreaterThan(2_500);
    let counted = runs.filter(run => run.footnotes > 0 && run.footnoteBase > 0);
    expect(counted.length).toBeGreaterThan(10);
  });

  it("is read from the base its run is decoded with", () => {
    let whole = docTabToMarkdown(noted);
    let rendered = (base: (run: PlacedRun) => number) => {
      let joined = noRuns();
      let carry = initialCarry();
      for (let placed of placedRuns(noted.body.content, RUN_SIZES)) {
        let run = renderRun(decodedRun(placed, false, base(placed)), noted, carry,
          { mdStart: joined.markdown.length });
        appendRun(joined, run);
        advanceCarry(carry, run.summary);
      }
      return joined;
    };
    expectSameRendering(rendered(run => run.footnoteBase), whole, "each run at its base");
    // THE TEETH of the base: one off, and the tab reads other numbers.
    let off = rendered(run => run.footnoteBase + (run.footnoteBase > 0 ? 1 : 0));
    expect(off.markdown).not.toBe(whole.markdown);
    expect(off.markdown.length).toBeGreaterThanOrEqual(whole.markdown.length);
  });

  it("that is no whole number is stored as the text it is", () => {
    let paragraph = paragraphOfNotes(9, [undefined, ...NO_NUMBERS]);
    for (let text of NO_NUMBERS) expect(wholeFootnoteNumber(text), text).toBeUndefined();
    let [, run] = placedRuns([tableOfNotes(9, 5), paragraph], RUN_SIZES);
    expect(run.footnoteBase).toBe(5);
    expect(storedFootnoteNumbers(run.json)).toEqual([undefined, ...NO_NUMBERS]);
    expect(JSON.stringify(decodedRun(run))).toBe(JSON.stringify([paragraph]));
    // Whatever base it is decoded with.
    expect(decodedRun(run, false, 1_000)).toEqual([paragraph]);
  });

  it("that is a whole number is stored as a JSON number and decodes to itself", () => {
    // Out of order, and each less than the five references before the run: negative offsets.
    let texts = [...WHOLE_NUMBERS, "7", "6", "2", "2", "-999999999"];
    let paragraph = paragraphOfNotes(9, texts);
    for (let base of [0, 5, 40]) {
      let [, run] = placedRuns([tableOfNotes(9, base), paragraph], RUN_SIZES);
      expect(run.footnoteBase).toBe(base);
      let stored = storedFootnoteNumbers(run.json);
      expect(stored).toEqual(texts.map(text => Number(text) - base));
      for (let number of stored) expect(typeof number).toBe("number");
      expect(JSON.stringify(decodedRun(run))).toBe(JSON.stringify([paragraph]));
      // The same run, listed after other references, reads the numbers that many higher.
      expect(decodedRun(run, false, base + 3))
        .toEqual([paragraphOfNotes(9, texts.map(text => String(Number(text) + 3)))]);
    }
  });
});

describe("decodeRun", () => {
  it.each(["not JSON", '[{"paragraph":', "", '{"a":1}', '"text"', "5", "null", "true"])(
    "answers nothing for what is not a stored run: %j", json => {
      for (let exact of [false, true]) {
        expect(decodeRun(json, { first: 0, footnotes: 0, exact })).toBeUndefined();
      }
    });

  it("never lets out the text of what it could not read", () => {
    let secret = '[{"paragraph":{"elements":[{"textRun":{"content":"a secret of the document';
    let answer: unknown = "unanswered";
    expect(() => {
      answer = decodeRun(secret, { first: 0, footnotes: 0, exact: false });
    }).not.toThrow();
    expect(answer).toBeUndefined();
  });

  it("as the model's gives a start index to a section break only", () => {
    let at = { first: 4, footnotes: 0, exact: true };
    expect(decodeRun('[{"endIndex":3,"sectionBreak":{}}]', at)!.elements)
      .toEqual([{ endIndex: 7, sectionBreak: {}, startIndex: 4 }]);
    for (let json of ['[{"endIndex":3,"paragraph":{}}]', '[{"endIndex":3,"table":{}}]', "[{}]"]) {
      expect(Object.keys(decodeRun(json, at)!.elements[0]), json).not.toContain("startIndex");
    }
    // A section break later in the run is not the one that opens a body.
    let several = '[{"endIndex":3,"paragraph":{}},{"endIndex":4,"sectionBreak":{}}]';
    expect(decodeRun(several, at)!.elements[1]).toEqual({ endIndex: 8, sectionBreak: {} });
  });
});

/** WHAT MUST NOT BE DONE: a second notion of a numbered footnote, digits only. */
function holdsDigitsOnly(elements: readonly StructuralElement[]): boolean {
  return storedFootnoteNumbers(JSON.stringify(elements))
    .some(number => typeof number === "string" && /^\d+$/.test(number));
}

/**
 * Holds each stored run of `tab` to ONE notion of a numbered footnote: decoded and rendered with the
 * base 7 higher, its Markdown moves iff `numbered` says so, and its key iff the Markdown does.
 */
function footnoteKeyFailure(
  tab: GoogleDocsTab, sizes: RunSizes,
  numbered = (rendered: RenderedRun, _: readonly StructuralElement[]) =>
    rendered.summary.numberedFootnotes > 0,
): string | undefined {
  let carry = initialCarry();
  for (let run of placedRuns(tab.body.content, sizes)) {
    let elements = decodedRun(run);
    let rendered = renderRun(elements, tab, carry, { mdStart: 0 });
    let later: RenderCarry = { ...carry, footnoteBase: carry.footnoteBase + 7 };
    let laterRendered = renderRun(
      decodedRun(run, false, later.footnoteBase), tab, later, { mdStart: 0 });
    let moves = laterRendered.markdown !== rendered.markdown;
    let keyMoves =
      runCarryKey(laterRendered.summary, later) !== runCarryKey(rendered.summary, carry);
    if (moves !== numbered(rendered, elements)) {
      return `a rendering that ${moves ? "moves" : "does not move"} with the base: ${run.json}`;
    }
    if (keyMoves !== moves) return `a key that ${keyMoves ? "moves" : "does not"}: ${run.json}`;
    advanceCarry(carry, rendered.summary);
  }
  return undefined;
}

describe.each(CUTS)("a tab's stored runs rendered, $cut", ({ sizes }) => {
  it.each(CORPUS)("a tab decoded run by run renders as the tab: $part", ({ tabs }) => {
    for (let { name, tab } of tabs()) {
      let whole = docTabToMarkdown(tab);
      let runs = placedRuns(tab.body.content, sizes);
      // Each run entered with one pass's carry moved by `advanceCarry`, and with a copying
      // advance's.
      for (let advance of [false, true]) {
        let joined = noRuns();
        let pass = initialCarry();
        let copy = INITIAL_CARRY;
        for (let run of runs) {
          let carry = advance ? pass : carryOf(copy);
          expect(carry.footnoteBase, name).toBe(run.footnoteBase);
          let rendered = renderRun(decodedRun(run, false, carry.footnoteBase), tab, carry,
            { mdStart: joined.markdown.length });
          appendRun(joined, rendered);
          if (advance) advanceCarry(pass, rendered.summary);
          else copy = advancedCopy(copy, rendered.summary);
        }
        expect(joined.extendsProtected, name).toBe(false);
        expectSameRendering(joined, whole, () => `${name}, entered with ${
          advance ? "the carry moved in place" : "the carry a copying advance gives"}`);
      }
    }
  });

  it.each(CORPUS)(
    "a run's key holds the footnote base exactly where its stored form counts from it: $part",
    ({ tabs }) => {
      for (let { name, tab } of tabs()) {
        expect(footnoteKeyFailure(tab, sizes), name).toBeUndefined();
      }
    });
});

describe("the runs of the corpus", () => {
  it("of each large tab are more than ten under the sizes a tab is cut to", () => {
    for (let { name, tab } of LARGE) {
      let runs = placedRuns(tab.body.content, RUN_SIZES);
      expect(runs.length, name).toBeGreaterThan(10);
      // Runs of many elements: each but the first entered with a non-initial carry.
      if (!runs.some(run => run.holds === "table")) {
        expect(tab.body.content.length / runs.length, name).toBeGreaterThan(50);
      }
    }
  });

  it("are listed by more than one tab", () => {
    let seen = new Set<string>();
    let again = 0;
    for (let { tab } of fuzzedTabs(FUZZED_SEED, 100)) {
      for (let json of new Set(Array.from(cutRuns(tab.body.content, FORCED), run => run.json))) {
        if (seen.has(json)) again++;
        seen.add(json);
      }
    }
    expect(again).toBeGreaterThan(50);
  });

  it("hold footnotes of every kind, and a second notion of a numbered one fails them", () => {
    let fuzzed = Array.from({ length: 6 }, (_, shard) => fuzzedTabs(FUZZED_SEED + shard, 100))
      .flat();
    let kinds = { whole: 0, negative: 0, zero: 0, padded: 0, text: 0, none: 0 };
    let failed = { negative: 0, padded: 0 };
    for (let { tab } of fuzzed) {
      let failure = footnoteKeyFailure(tab, ONE_EACH, (_, elements) => holdsDigitsOnly(elements));
      for (let run of cutRuns(tab.body.content, ONE_EACH)) {
        let texts = storedFootnoteNumbers(JSON.stringify(run.elements));
        if (texts.length === 0) continue;
        let stored = storedFootnoteNumbers(run.json);
        let count = (kind: keyof typeof kinds, text: string | undefined, type: string) => {
          let at = texts.indexOf(text);
          if (at < 0) return false;
          expect(typeof stored[at]).toBe(type);
          kinds[kind]++;
          return true;
        };
        count("whole", "3", "number");
        count("zero", "0", "number");
        count("text", "x", "string");
        count("text", "", "string");
        count("none", undefined, "undefined");
        let negative = count("negative", "-2", "number");
        let padded = count("padded", "007", "string");
        // A one-paragraph run holding a number the second notion gets wrong is the one named.
        if (failure?.endsWith(run.json)) {
          if (negative) failed.negative++;
          if (padded) failed.padded++;
        }
      }
    }
    for (let [kind, count] of Object.entries(kinds)) expect(count, kind).toBeGreaterThan(20);
    expect(failed.negative).toBeGreaterThan(5);
    expect(failed.padded).toBeGreaterThan(5);
  });
});

/** The targets `endsRun` is pinned under, with a least size of 0: an answer each. */
const PINNED_TARGETS = [3, 5, 11, 23, 47, 97, 127, 149, 173, 199, 251, 307, 401, 601, 1_009, 2_003];

/** What `endsRun` answers for `json` under each pinned target, as a 1 or a 0 each. */
function pinnedAnswers(json: string): string {
  return PINNED_TARGETS
    .map(target => endsRun(json, { ...FORCED, target }) ? "1" : "0").join("");
}

/** A stored paragraph of `text`, its indexes written after its text. */
const line = (text: string, startIndex: number, endIndex: number) => JSON.stringify({
  paragraph: { elements: [{ textRun: { content: text }, startIndex, endIndex }] },
  startIndex, endIndex,
});

/** A stored footnote reference numbered `footnoteNumber`, one index long from `startIndex`. */
const note = (footnoteNumber: unknown, startIndex: number) => JSON.stringify({
  startIndex, endIndex: startIndex + 1,
  footnoteReference: { footnoteId: "kix.a1", footnoteNumber },
});

describe("endsRun", () => {
  // A CHANGE HERE MOVES EVERY RUN'S ID and recuts every stored tab: only change it on purpose.
  it.each<[of: string, json: string, answers: string]>([
    ["an object of nothing", "{}", "0010000000000000"],
    ["a paragraph", line("Line 00007.\n", 0, 12), "1111111110100010"],
    ["the same paragraph at another place", line("Line 00007.\n", 84, 96), "1111111110100010"],
    ["a paragraph whose text differs in a digit", line("Line 00008.\n", 0, 12), "1111111110101100"],
    ["a paragraph of other text", line("Another line.\n", 0, 14), "1111111010010000"],
    ["a text with a quote in it", line('She said "12" twice.\n', 0, 21), "1111111111111110"],
    ["that text at another place", line('She said "12" twice.\n', 300, 321), "1111111111111110"],
    ["that text with another number", line('She said "13" twice.\n', 0, 21), "1111111111000000"],
    ["a text that ends with a backslash", line("C:\\", 0, 3), "1111111010011000"],
    ["that text at another place", line("C:\\", 45, 48), "1111111010011000"],
    ["a footnote counted from its run", note(2, 4), "1111101011010000"],
    ["the same footnote under another count", note(-31, 9), "1111101011010000"],
    ["a footnote whose number is the text it is", note("007", 4), "1111111100000000"],
  ])("is this function, for %s", (_, json, answers) => {
    expect(pinnedAnswers(json)).toBe(answers);
  });

  it("answers by the sizes it is given", () => {
    let json = line("Line 00007.\n", 0, 12);
    // What counts is the room between the least size and the target.
    for (let target of PINNED_TARGETS) {
      expect(endsRun(json, { ...FORCED, least: 300, target: target + 300 }))
        .toBe(endsRun(json, { ...FORCED, target }));
    }
    // An element as long as that room, or longer, always ends its run.
    expect(endsRun(json, { ...FORCED, target: 60 })).toBe(true);
    // No room (a target at the least size or under) is a room of one: every element ends its run.
    for (let least of [400, 500, 1_400]) {
      expect(endsRun(json, { ...FORCED, least, target: 400 })).toBe(true);
    }
    expect(endsRun("", { ...FORCED, target: 60 })).toBe(false);
  });

  it("counts every unit it hashes, the backslash of an escape among them", () => {
    // 111 units are hashed, one the backslash of its escape: the answer turns on that one unit.
    let json = line("C:\\", 0, 3);
    let answers = [167, 283, 199, 398].map(target => endsRun(json, { ...FORCED, target }));
    expect(answers).toEqual([true, true, false, false]);
  });

  it("leaves a string where JSON does", () => {
    // A scanner wrong about escaped backslashes or quotes would hash the indexes as text.
    expect(pinnedAnswers(line("C:\\", 45, 48))).toBe(pinnedAnswers(line("C:\\", 0, 3)));
    expect(pinnedAnswers(line('She said "12" twice.\n', 300, 321)))
      .toBe(pinnedAnswers(line('She said "12" twice.\n', 0, 21)));
    expect(pinnedAnswers(line('She said "13" twice.\n', 0, 21)))
      .not.toBe(pinnedAnswers(line('She said "12" twice.\n', 0, 21)));
    expect(pinnedAnswers(line("Line 00008.\n", 0, 12)))
      .not.toBe(pinnedAnswers(line("Line 00007.\n", 0, 12)));
  });
});
