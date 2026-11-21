// The tabs and the cuts that hold a rendering by runs to the rendering of the whole tab.

import { createHash } from "node:crypto";
import { expect } from "vitest";
import type {
  GoogleDocsTab, NamedStyles, NestingLevel, StructuralElement,
} from "../src/docs-api";
import { wholeFootnoteNumber } from "../src/docs-content";
import { runId, type DocRunSummary } from "../src/docs-store";
import { tableCellCount, tableShape } from "../src/docs-tables";
import {
  advanceCarry, docTabToMarkdown, initialCarry, joinRenderedRun as appendRun,
  noRenderedRuns as noRuns, renderRun, runCarryKey, runContextKey,
} from "../src/markdown-converter";
import type {
  CarriedLevel, DocTabSnapshot, PassCarry, RenderContext, RenderedRun, RunPlace, RunSummary,
  SourceMap,
} from "../src/markdown-converter";
import {
  buildTab, cellOf, diceOf, footnote, item, para, presetLevels, seeded,
} from "./doc-fixture";
import type { BlockSpec, CellSpec, Dice, Lists, ParagraphSpec, TableSpec } from "./doc-fixture";
import { readFixtures } from "./docs-live-fixtures";

/** A tab the tests of runs render, under the name a failure reports. */
export type NamedTab = {
  name: string;
  tab: GoogleDocsTab;
};

/** A large tab, with the number of body elements its description gives it at scale 1. */
export type LargeTab = NamedTab & { about: number };

/** What two renderings are compared by: the Markdown and the source map. */
export type Rendering = Pick<DocTabSnapshot, "markdown" | "sourceMap">;

/** A carry as the tests keep one: a copy, plain data that survives JSON (a `PassCarry` moves in place). */
export type PlainCarry = {
  /** Whether anything is written yet: what is written first takes no blank line before it. */
  readonly hasOutput: boolean;
  /** Whether the last protected range ends where the Markdown written so far ends. */
  readonly abutsProtected: boolean;
  /** The list of the last paragraph; absent after a paragraph outside a list or a structure. */
  readonly previousListId?: string;
  /** The levels of that list written since another block last interrupted it. */
  readonly continuedListLevels: readonly boolean[];
  /** The last number given at each level of each list that holds one, `null` for none. */
  readonly listNumbers: { readonly [listId: string]: readonly (number | null)[] };
  /** How many footnote references the elements before hold, those of table cells included. */
  readonly footnoteBase: number;
};

/** The carry of a tab's first run, as plain data: frozen, with its parts. */
export const INITIAL_CARRY: PlainCarry = Object.freeze({
  hasOutput: false, abutsProtected: false, continuedListLevels: Object.freeze([]),
  listNumbers: Object.freeze({}), footnoteBase: 0,
});

/** A pass's carry that holds what `plain` says, its arrays copied. */
export function carryOf(plain: PlainCarry): PassCarry {
  return {
    hasOutput: plain.hasOutput,
    abutsProtected: plain.abutsProtected,
    ...(plain.previousListId === undefined ? {} : { previousListId: plain.previousListId }),
    continuedListLevels: [...plain.continuedListLevels],
    listNumbers: new Map(Object.entries(plain.listNumbers)
      .map(([listId, numbers]) => [listId, [...numbers]])),
    footnoteBase: plain.footnoteBase,
  };
}

/** What `carry` holds at this moment, as a copy whose arrays are the carry's own. */
export function plainOf(carry: PassCarry): PlainCarry {
  return {
    hasOutput: carry.hasOutput,
    abutsProtected: carry.abutsProtected,
    ...(carry.previousListId === undefined ? {} : { previousListId: carry.previousListId }),
    continuedListLevels: carry.continuedListLevels,
    listNumbers: Object.fromEntries(carry.listNumbers),
    footnoteBase: carry.footnoteBase,
  };
}

/** `numbers` with the levels of each list of `counted` in its place, written as a carry holds them. */
function withListNumbers(
  numbers: PlainCarry["listNumbers"], counted: readonly [string, (number | null)[]][],
): PlainCarry["listNumbers"] {
  let lists = new Map<string, readonly (number | null)[]>(Object.entries(numbers));
  for (let [listId, levels] of counted) {
    while (levels.length > 0 && levels.at(-1) === null) levels.pop();
    if (levels.length > 0) lists.set(listId, levels);
    else lists.delete(listId);
  }
  return Object.fromEntries(lists);
}

/** THE REFERENCE `advanceCarry` is held to: a plain copying advance, the carry after a run. */
export function advancedCopy(carry: PlainCarry, summary: RunSummary): PlainCarry {
  if (!summary.emits) return carry;
  let { endListId: previousListId, levels } = summary;
  let continuedListLevels: readonly boolean[] = [];
  if (previousListId === undefined) {
    // Nothing is continued after a paragraph outside a list or a structure.
  } else if (levels.lead) {
    let continues = carry.previousListId === summary.lead?.listId;
    continuedListLevels = [
      ...Array.from({ length: levels.min }, (_, level) =>
        continues && !!carry.continuedListLevels[level]),
      ...levels.tail,
    ];
  } else {
    continuedListLevels = levels.fixed;
  }

  let effects = Object.entries(summary.lists);
  let listNumbers = effects.length === 0 ? carry.listNumbers
    : withListNumbers(carry.listNumbers, effects.map(([listId, { keep, add, start, tail }]) => {
      let carried = Object.hasOwn(carry.listNumbers, listId) ? carry.listNumbers[listId] : [];
      let after = Array.from({ length: keep }, (_, level) => carried[level] ?? null);
      if (add > 0) after[keep - 1] = (after[keep - 1] ?? start - 1) + add;
      return [listId, [...after, ...tail]];
    }));

  return {
    hasOutput: true,
    abutsProtected: summary.lastWrites === "protected",
    ...(previousListId === undefined ? {} : { previousListId }),
    continuedListLevels,
    listNumbers,
    footnoteBase: carry.footnoteBase + summary.footnotes,
  };
}

function sameList<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Whether two carries are the same carry, part for part: what `CarryBeside.same` is held to. */
export function sameCarry(left: PlainCarry, right: PlainCarry): boolean {
  if (left.hasOutput !== right.hasOutput || left.abutsProtected !== right.abutsProtected ||
      left.previousListId !== right.previousListId || left.footnoteBase !== right.footnoteBase ||
      !sameList(left.continuedListLevels, right.continuedListLevels)) return false;
  if (left.listNumbers === right.listNumbers) return true;
  let listIds = Object.keys(left.listNumbers);
  return listIds.length === Object.keys(right.listNumbers).length && listIds.every(listId =>
    Object.hasOwn(right.listNumbers, listId) &&
    sameList(left.listNumbers[listId], right.listNumbers[listId]));
}

/** `renderRun` of a run entered with a carry a test keeps, and the carry after it as a copy. */
export function renderedFrom(
  elements: readonly StructuralElement[], context: RenderContext, carry: PlainCarry,
  at: RunPlace,
): RenderedRun & { carry: PlainCarry } {
  let pass = carryOf(carry);
  let rendered = renderRun(elements, context, pass, at);
  advanceCarry(pass, rendered.summary);
  return { ...rendered, carry: plainOf(pass) };
}

/** A tab rendered run by run. */
export type RenderedByRuns = Rendering & {
  /** A copy of the carry before each run, and last the carry after the tab. */
  carries: PlainCarry[];
  /** Where each run's Markdown starts in the tab's. */
  starts: number[];
};

/** A copy that shares no object with `value`, as a tab decoded from storage shares none. */
export function throughJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Every tab of every recording, before its first step and after each, each a copy of its own. */
export function recordedTabs(): NamedTab[] {
  return readFixtures().flatMap(({ name, before, steps }) => [
    { name: `${name}, before`, tab: throughJson(before) },
    ...steps.map((step, index) =>
      ({ name: `${name}, after step ${index + 1} (${step.name})`, tab: throughJson(step.after) })),
  ]);
}

// --- Cuts: each is the bounds of its runs, from 0 to the body's length

/** Every cut of a body of `length` elements into two runs. */
export function* everyCutInTwo(length: number): Iterable<number[]> {
  for (let cut = 1; cut < length; cut++) yield [0, cut, length];
}

/** The cut that makes every element a run of its own. */
export function oneElementRuns(length: number): number[] {
  return Array.from({ length: length + 1 }, (_, bound) => bound);
}

/** A cut into runs of one to three elements, drawn from `seed`. */
export function forcedRuns(length: number, seed: number): number[] {
  let random = seeded(seed);
  let bounds = [0];
  for (let bound = 0; bound < length;) {
    bound = Math.min(length, bound + 1 + Math.floor(random() * 3));
    bounds.push(bound);
  }
  return bounds;
}

/** `count` cuts in two drawn from `seed`: none for a body with no place to cut. */
export function seededCutsInTwo(length: number, seed: number, count: number): number[][] {
  if (length < 2) return [];
  let random = seeded(seed);
  return Array.from({ length: count }, () =>
    [0, 1 + Math.floor(random() * (length - 1)), length]);
}

// --- Rendering by runs

// The source's own joiner, so these tests hold the joiner an edit's rendering is made with too.
export {
  joinRenderedRun as appendRun, noRenderedRuns as noRuns, type JoinedRuns,
} from "../src/markdown-converter";

/**
 * Renders `tab` as the runs `bounds` cut it into, with one pass's carry, joined with `appendRun`.
 * `spoil` replaces the carry each run after the first is entered with.
 */
export function renderedByRuns(
  tab: GoogleDocsTab, bounds: readonly number[], spoil?: (carry: PlainCarry) => PlainCarry,
): RenderedByRuns {
  let joined = noRuns();
  let pass = initialCarry();
  let carries = [plainOf(pass)];
  let starts: number[] = [];
  for (let run = 0; run + 1 < bounds.length; run++) {
    if (run > 0 && spoil) pass = carryOf(spoil(carries[run]));
    let rendered = renderRun(
      tab.body.content.slice(bounds[run], bounds[run + 1]), tab, pass,
      { mdStart: joined.markdown.length });
    starts.push(joined.markdown.length);
    appendRun(joined, rendered);
    advanceCarry(pass, rendered.summary);
    carries.push(plainOf(pass));
  }
  if (joined.extendsProtected) throw new Error("A run extends a protected range before the tab");
  return { markdown: joined.markdown, sourceMap: joined.sourceMap, carries, starts };
}

/** The JSON text of each source map compared, made once a map. */
const mapTexts = new WeakMap<SourceMap, string>();

function mapText(sourceMap: SourceMap): string {
  let text = mapTexts.get(sourceMap);
  if (text === undefined) mapTexts.set(sourceMap, text = JSON.stringify(sourceMap));
  return text;
}

/** The one comparison of two renderings: the Markdown, and the source map (by its JSON text first). */
export function expectSameRendering(
  got: Rendering, whole: Rendering, where: string | (() => string),
): void {
  let message = () => typeof where === "string" ? where : where();
  if (got.markdown !== whole.markdown) expect(got.markdown, message()).toBe(whole.markdown);
  if (mapText(got.sourceMap) !== mapText(whole.sourceMap)) {
    expect(got.sourceMap, message()).toEqual(whole.sourceMap);
  }
}

/**
 * Holds `tab` rendered by runs to the tab rendered whole: as one run, one element a run, runs of
 * one to three elements and cuts in two (every one, or `"sampled"`). `stored` adds `storedByRuns`.
 */
export function expectRendersByRuns(
  tab: GoogleDocsTab, where: string, cuts: "every" | "sampled" = "every",
  { stored = false }: { stored?: boolean } = {},
): void {
  let whole = docTabToMarkdown(tab);
  let { length } = tab.body.content;
  let check = (bounds: readonly number[], how: string) =>
    expectSameRendering(renderedByRuns(tab, bounds), whole, () => `${where}, ${how}`);

  check([0, length], "as one run");
  check(oneElementRuns(length), "one element a run");
  for (let seed of cuts === "sampled" ? [1, 2] : [1, 2, 3]) {
    check(forcedRuns(length, seed), `runs of one to three elements, seed ${seed}`);
  }
  let inTwo = cuts === "sampled" ? seededCutsInTwo(length, 4, 4)
    : length <= 64 ? everyCutInTwo(length) : seededCutsInTwo(length, 4, 16);
  for (let bounds of inTwo) check(bounds, `cut in two at element ${bounds[1]}`);
  if (!stored) return;
  let renderings = new Map<string, string>();
  storedByRuns(tab, oneElementRuns(length), `${where}, one element a run`, { renderings });
  storedByRuns(tab, forcedRuns(length, 1), `${where}, runs of one to three elements`,
    { renderings });
}

// --- Large tabs

/** One numbered level, as each list of the large tabs that is not a preset's is defined. */
const NUMBERED = { listProperties: { nestingLevels: [{ glyphType: "DECIMAL" }] } };

/** `number` in five digits: a paragraph that holds it shares its text with no other. */
const numbered = (label: string, number: number) => `${label} ${String(number).padStart(5, "0")}.`;

/** Gives each text it is asked for the next number, from 1. */
function counter(): (label: string) => string {
  let lines = 0;
  return label => numbered(label, ++lines);
}

/** A paragraph of `text` with a footnote reference numbered `number` before its full stop. */
const noted = (text: string, number: number, listId?: string): ParagraphSpec => ({
  runs: [text.slice(0, -1), footnote(number), ".\n"],
  ...(listId === undefined ? {} : { bullet: { listId } }),
});

/**
 * Large tabs of the content a rendering carries state through (lists, nested lists, tables between
 * list items, footnotes, protected content), each decoded from JSON; `scale` divides the sizes. No
 * two paragraphs are the same string, and every second table's cells continue the body's list.
 */
export function largeTabs(scale = 1): LargeTab[] {
  let count = (size: number) => Math.max(1, Math.round(size / scale));
  let tabs: { name: string; about: number; blocks: BlockSpec[]; lists: Lists }[] = [];

  tabs.push({
    name: "a numbered list of 20,000 items", about: 20_000, lists: { N1: NUMBERED },
    blocks: Array.from({ length: count(20_000) }, (_, index) =>
      item(numbered("Item", index + 1), "N1")),
  });

  tabs.push({
    name: "a numbered list interrupted by a paragraph every 50 items", about: 20_000,
    lists: { N1: NUMBERED },
    blocks: Array.from({ length: count(20_000) }, (_, index) => index % 51 === 50
      ? para(numbered("Between", index + 1)) : item(numbered("Item", index + 1), "N1")),
  });

  // Twelve elements a group: a numbered list three levels deep, a bulleted one whose second
  // level is numbered, the numbered one entered again below its first level, and a paragraph
  // after every second group.
  let nested: BlockSpec[] = [];
  for (let group = 0, line = counter(); nested.length < count(6_000); group++) {
    nested.push(
      item(line("Item"), "NN"), item(line("Item"), "NN", 1), item("Deep.", "NN", 2),
      item("Deep.", "NN", 2), item(line("Item"), "NN", 1), item(line("Item"), "NN"),
      item(line("Item"), "BB"), item(line("Item"), "BB", 1), item("Deep.", "BB", 2),
      item(line("Item"), "BB", 1), item(line("Item"), "NN", 1),
      group % 2 === 0 ? item(line("Item"), "NN") : para(line("Between")),
    );
  }
  tabs.push({
    name: "nested numbered and bulleted lists", about: 6_000, blocks: nested,
    lists: {
      NN: { listProperties: { nestingLevels: presetLevels(true) } },
      BB: {
        listProperties: {
          nestingLevels: presetLevels().with(1, { glyphType: "DECIMAL", startNumber: 1 }),
        },
      },
    },
  });

  // Seven elements a group: six items of the body's list, then a table whose cells hold
  // numbered items (of the body's list in every second table, of the table's own in the
  // others) and footnotes, one of them in a table inside a cell in every fifth.
  let between: BlockSpec[] = [];
  let betweenLists: Lists = { N1: NUMBERED };
  let betweenNotes = 0;
  for (let group = 0, line = counter(); between.length < count(3_500); group++) {
    for (let index = 0; index < 6; index++) between.push(item(line("Item"), "N1"));
    let listId = group % 2 === 0 ? "N1" : `C${group}`;
    betweenLists[listId] = NUMBERED;
    let cell = numbered("Cell", group + 1);
    between.push({
      table: [[
        cellOf(item(`First ${cell}`, listId), item(`Second ${cell}`, listId)),
        cellOf(noted(`Noted ${cell}`, ++betweenNotes), ...(group % 5 === 0
          ? [{ table: [[cellOf(noted(`Inner ${cell}`, ++betweenNotes))]] }, para(`After ${cell}`)]
          : [])),
      ]],
    });
  }
  tabs.push({
    name: "tables between lists", about: 3_500, blocks: between, lists: betweenLists,
  });

  let notes = 0;
  tabs.push({
    name: "paragraphs with footnotes", about: 3_000, lists: { N1: NUMBERED },
    blocks: Array.from({ length: count(3_000) }, (_, index) => {
      let text = numbered("Note", index + 1);
      if (index % 7 === 3) return para(text);
      if (index % 7 === 5) return noted(text, ++notes, "N1");
      if (index % 7 === 6) {
        return { runs: ["Twice", footnote(++notes), ` ${text.slice(0, -1)}`, footnote(++notes), ".\n"] };
      }
      return noted(text, ++notes);
    }),
  });

  // Ten elements a group: chips, a positioned image, a table of contents and a section break
  // between plain paragraphs, and a chip in the middle of a bulleted list.
  let guarded: BlockSpec[] = [];
  let pictured = new Set<number>();
  for (let group = 0, lines = counter(); guarded.length < count(3_000); group++) {
    let line = () => lines("Line");
    let chip = (part: ParagraphSpec["runs"][number], listId?: string): ParagraphSpec => ({
      runs: [part, ` ${line()}\n`], ...(listId === undefined ? {} : { bullet: { listId } }),
    });
    guarded.push(para(line()), chip({ person: { name: "Ada", email: "ada@example.com" } }));
    guarded.push(para(line()));
    // The element this paragraph becomes: the body's opening section break stands first.
    pictured.add(guarded.length + 1);
    guarded.push(
      para(line()), item(line(), "B1"), chip({ date: "Jan 5, 2026" }, "B1"), item(line(), "B1"),
      group % 2 === 0 ? { structure: "tableOfContents", length: 4 }
        : chip({ richLink: { title: "Plan", uri: "https://example.com/plan" } }),
      para(line()),
      group % 3 === 0 ? { structure: "sectionBreak" } : chip({ dropdown: "Open" }),
    );
  }
  tabs.push({
    name: "protected content", about: 3_000, blocks: guarded,
    lists: { B1: { listProperties: { nestingLevels: [{ glyphSymbol: "●" }] } } },
  });

  // Four elements a group: three items of a list of the group's own, then a paragraph.
  let short: BlockSpec[] = [];
  let shortLists: Lists = {};
  for (let group = 0, line = counter(); short.length < count(4_000); group++) {
    let listId = `S${group}`;
    shortLists[listId] = NUMBERED;
    for (let index = 0; index < 3; index++) short.push(item(line("Item"), listId));
    short.push(para(line("Between")));
  }
  tabs.push({
    name: "a thousand short numbered lists", about: 4_000, blocks: short, lists: shortLists,
  });

  return tabs.map(({ name, about, blocks, lists }) => {
    let tab = buildTab(blocks, lists);
    if (blocks === guarded) {
      for (let element of pictured) {
        tab.body.content[element].paragraph!.positionedObjectIds = [`image-${element}`];
      }
    }
    return { name, about, tab: throughJson(tab) };
  });
}

/** What `DocStore.summary` answers of a tab whose rendering whole is `rendering`. */
export function summaryOf(rendering: DocTabSnapshot): DocRunSummary {
  let { markdown, sourceMap } = rendering;
  return {
    markdownLength: markdown.length,
    blocks: sourceMap.blocks.length,
    protectedRanges: sourceMap.protectedRanges.length,
    tables: sourceMap.tables.map(table => {
      let html = markdown.slice(table.mdStart, table.mdEnd);
      return {
        start: table.docStart, shape: runId(tableShape(html)), cells: tableCellCount(html),
        numbered: html.includes("<ol"), mdStart: table.mdStart, mdEnd: table.mdEnd,
      };
    }),
    blank: (markdown === "" || markdown === "\n") && sourceMap.protectedRanges.length === 0,
    numberedItems: sourceMap.blocks.some(block => block.listType === "numbered"),
  };
}

// --- Fuzzed tabs

/** What a level of a fuzzed list is: numbered from 1 or another start, bulleted, or neither. */
const FUZZED_LEVELS: readonly NestingLevel[] = [
  { glyphType: "DECIMAL" }, { glyphType: "DECIMAL", startNumber: 0 },
  { glyphType: "DECIMAL", startNumber: 2 }, { glyphType: "ALPHA", startNumber: 3 },
  { glyphType: "ZERO_DECIMAL", startNumber: 5 }, { glyphType: "ROMAN" }, { glyphSymbol: "●" },
  { glyphSymbol: "○", startNumber: 1 }, { glyphType: "NONE" },
  { glyphType: "GLYPH_TYPE_UNSPECIFIED", glyphSymbol: "☐" },
];

/** The lists a fuzzed tab's items name: the last is one the tab does not define. */
const FUZZED_LIST_IDS = ["A", "B", "C", "missing"];

/** The named styles a fuzzed tab has: a subtitle in italics, one that is not, and none. */
const FUZZED_STYLES: readonly (NamedStyles | undefined)[] = [
  { styles: [{ namedStyleType: "SUBTITLE", textStyle: { italic: true } }] },
  { styles: [{ namedStyleType: "NORMAL_TEXT" }, { namedStyleType: "SUBTITLE", textStyle: {} }] },
  undefined,
];

/** What a footnote reference of a fuzzed tab that is not numbered by place says its number is. */
const ODD_FOOTNOTE_NUMBERS: readonly (string | undefined)[] =
  [undefined, "", "x", "007", "0", "-2", "3", "1"];

/** One paragraph of a fuzzed tab, of few enough texts that many of a tab's runs are the same. */
function fuzzedParagraph({ below, pick, random }: Dice, listId: string | undefined): ParagraphSpec {
  let text = pick(["a", "b", "c"]);
  let kind = random();
  let spec: ParagraphSpec = kind < 0.2 ? { runs: [text, footnote(0), ".\n"] }
    : kind < 0.26 ? { runs: [{ person: { name: "Ada", email: "ada@example.com" } }, ` ${text}\n`] }
    : kind < 0.34 ? { runs: [`${text}\n`], namedStyleType: "SUBTITLE" }
    : para(text);
  if (listId === undefined) return spec;
  let nestingLevel = pick([0, 0, 0, 1, 1, 2, 3]) + (below(8) === 0 ? 1 : 0);
  return { ...spec, bullet: { listId, ...(nestingLevel ? { nestingLevel } : {}) } };
}

/** A table of a fuzzed tab: items, footnotes and subtitles in its cells, and tables in them. */
function fuzzedTable(dice: Dice, depth = 0): TableSpec {
  let { below, pick, random } = dice;
  let listId = pick(FUZZED_LIST_IDS);
  let cell = (): CellSpec => cellOf(...Array.from({ length: 1 + below(3) }, () => {
    if (depth < 2 && random() < 0.15) return fuzzedTable(dice, depth + 1);
    if (random() < 0.3) listId = pick(FUZZED_LIST_IDS);
    return fuzzedParagraph(dice, random() < 0.6 ? listId : undefined);
  }), para("z"));
  return {
    table: Array.from({ length: 1 + below(2) }, () => Array.from({ length: 1 + below(2) }, cell)),
  };
}

/** Every footnote reference of `elements` in order, those of table cells included. */
function* footnoteReferencesOf(
  elements: readonly StructuralElement[],
): Generator<{ footnoteNumber?: string }> {
  for (let { paragraph, table } of elements) {
    for (let part of paragraph?.elements ?? []) {
      if (part.footnoteReference) yield part.footnoteReference;
    }
    for (let row of table?.tableRows ?? []) {
      for (let cell of row.tableCells ?? []) yield* footnoteReferencesOf(cell.content ?? []);
    }
  }
}

/**
 * `count` generated tabs aimed at a run's summary and its keys: mixed list levels and starts, an
 * undefined list, nested tables, structures mid-body, every kind of opening section break and of
 * footnote number, and subtitles under every kind of named style. Each decoded from JSON.
 */
export function fuzzedTabs(seed: number, count: number): NamedTab[] {
  let dice = diceOf(seed);
  let { below, pick, random } = dice;
  return Array.from({ length: count }, (_, number) => {
    let lists: Lists = {};
    for (let listId of FUZZED_LIST_IDS.slice(0, -1)) {
      let nestingLevels = Array.from({ length: 2 + below(3) }, () => pick(FUZZED_LEVELS));
      lists[listId] = { listProperties: { nestingLevels } };
    }
    let blocks: BlockSpec[] = number % 10 === 0 ? [{ structure: "sectionBreak" }] : [];
    let listId = pick(FUZZED_LIST_IDS);
    for (let length = 4 + below(20); blocks.length < length;) {
      let kind = random();
      if (kind < 0.12) blocks.push(fuzzedTable(dice));
      else if (kind < 0.17) blocks.push({ structure: "tableOfContents", length: 3 });
      else if (kind < 0.22) blocks.push({ structure: "sectionBreak" });
      else {
        if (random() < 0.25) listId = pick(FUZZED_LIST_IDS);
        blocks.push(fuzzedParagraph(dice, random() < 0.65 ? listId : undefined));
      }
    }

    let tab = buildTab(blocks, lists);
    let byPlace = number % 3 !== 2;
    let place = 0;
    for (let reference of footnoteReferencesOf(tab.body.content)) {
      let stated = byPlace ? String(++place) : pick(ODD_FOOTNOTE_NUMBERS);
      if (stated === undefined) delete reference.footnoteNumber;
      else reference.footnoteNumber = stated;
    }
    let opening = ["a start index of 0", "no start index", "none"][below(3)];
    if (opening === "none") tab.body.content.shift();
    let namedStyles = pick(FUZZED_STYLES);
    if (namedStyles) tab.namedStyles = namedStyles;
    // Google sends the opening section break with no start index, which the type does not say.
    if (opening === "no start index") {
      delete (tab.body.content[0] as Partial<StructuralElement>).startIndex;
    }
    return {
      name: `seed ${seed}, tab ${number} (opening section break: ${opening})`,
      tab: throughJson(tab),
    };
  });
}

// --- A run's summary, the advance and the two keys

/** A list no generated tab and no recording names. */
const UNNAMED_LIST = "a list the run does not name";

/** What a key of `runCarryKey` holds, read back from its text. */
type CarryKeyFields = {
  s?: true;
  n?: { [listId: string]: { [level: string]: number } };
  l?: { [level: string]: true };
  f?: number;
};

/** The levels of `summary` whose carried number the run shows: leading ones and the others. */
function shownLevels(summary: RunSummary): CarriedLevel[] {
  return [...summary.lead?.levels ?? [], ...summary.counters];
}

/**
 * A carry built from the text of `key` alone that DISAGREES with `actual` wherever the key leaves
 * it free: a key that left out something the rendering reads would give another rendering.
 */
export function carryFromKey(key: string, summary: RunSummary, actual: PlainCarry): PlainCarry {
  let fields = (key === "" ? {} : JSON.parse(key)) as CarryKeyFields;
  let { lead } = summary;
  let hasOutput = fields.s === true;
  let continues = false;
  if (!summary.emits) {
    hasOutput = !actual.hasOutput;
  } else if (lead && !fields.s && (fields.l || !actual.hasOutput)) {
    hasOutput = true;
    continues = true;
  }
  let another = actual.previousListId === undefined ? UNNAMED_LIST : undefined;
  let previousListId = continues ? lead?.listId
    : lead ? another
    : actual.previousListId === undefined ? summary.listIds[0] ?? UNNAMED_LIST : undefined;

  let leading = new Set(lead?.levels.map(({ level }) => level));
  let continuedListLevels = Array.from(
    { length: Math.max(actual.continuedListLevels.length, 10) },
    (_, level) => leading.has(level) ? fields.l?.[level] === true
      : !actual.continuedListLevels[level]);

  let shown = shownLevels(summary);
  // Each list an own property, read and written, whatever its id.
  let listNumbers = Object.fromEntries(summary.listIds.map(listId => {
    let carried = Object.hasOwn(actual.listNumbers, listId) ? actual.listNumbers[listId] : [];
    let keyed = fields.n && Object.hasOwn(fields.n, listId) ? fields.n[listId] : {};
    return [listId, Array.from({ length: Math.max(carried.length, 10) }, (_, level) => {
      let held = keyed[level];
      if (held !== undefined) return held;
      let start = shown.find(need => need.listId === listId && need.level === level)?.start;
      // A shown level the key holds no number for: its start less one, said the other way.
      if (start !== undefined) return (carried[level] ?? null) === null ? start - 1 : null;
      return (carried[level] ?? 0) + 1000;
    })];
  }));
  return {
    hasOutput,
    abutsProtected: !actual.abutsProtected,
    ...(previousListId === undefined ? {} : { previousListId }),
    continuedListLevels,
    listNumbers,
    footnoteBase: fields.f ?? (summary.numberedFootnotes > 0 ? 0 : actual.footnoteBase + 999),
  };
}

/** A carry drawn from `seed` that the run of `summary` could be entered with, unrelated to its own. */
export function unrelatedCarry(summary: RunSummary, seed: number): PlainCarry {
  let { below, pick, random } = diceOf(seed);
  let previousListId = pick([undefined, summary.lead?.listId, summary.endListId, UNNAMED_LIST]);
  let continuedListLevels = previousListId === undefined ? []
    : Array.from({ length: below(5) }, () => random() < 0.6);
  while (continuedListLevels.at(-1) === false) continuedListLevels.pop();

  let starts = new Map(shownLevels(summary).map(({ listId, level, start }) =>
    [`${level} ${listId}`, start]));
  for (let [listId, { keep, start }] of Object.entries(summary.lists)) {
    starts.set(`${keep - 1} ${listId}`, start);
  }
  let listNumbers = Object.fromEntries([...summary.listIds, UNNAMED_LIST].flatMap(listId => {
    let numbers = Array.from({ length: below(5) }, (_, level) => {
      let start = starts.get(`${level} ${listId}`) ?? 1;
      return pick([null, start - 1, start, 4000 + below(1000)]);
    });
    while (numbers.at(-1) === null) numbers.pop();
    return numbers.length > 0 ? [[listId, numbers]] : [];
  }));
  let hasOutput = previousListId !== undefined || random() < 0.7;
  return {
    hasOutput,
    abutsProtected: hasOutput && random() < 0.3,
    ...(previousListId === undefined ? {} : { previousListId }),
    continuedListLevels,
    listNumbers,
    footnoteBase: below(40),
  };
}

/** Whether a level is numbered, as the renderer reads a level's glyph type. */
function isNumbered({ glyphType }: NestingLevel): boolean {
  return glyphType !== undefined && glyphType !== "NONE" && glyphType !== "GLYPH_TYPE_UNSPECIFIED";
}

/** A context that agrees with `context` on what the key of `summary`'s run names, and on nothing else. */
export function contextFromKey(summary: RunSummary, context: RenderContext): RenderContext {
  let lists: Lists = Object.fromEntries(Object.entries(context.lists).map(([listId, list]) =>
    [listId, summary.listIds.includes(listId) ? list : {
      listProperties: {
        nestingLevels: list.listProperties.nestingLevels.map(level =>
          isNumbered(level) ? { glyphSymbol: "●" } : { glyphType: "DECIMAL", startNumber: 7 }),
      },
    }]));
  let namedStyles = summary.subtitle ? context.namedStyles
    : context.namedStyles ? undefined : { styles: [] };
  return { lists, ...(namedStyles ? { namedStyles } : {}) };
}

/**
 * The name of a run among the renderings a test stores, its positions relative as a stored run's
 * are; the opening section break is written without its start index unless `keepOpeningIndex`.
 */
function runIdentity(
  elements: readonly StructuralElement[], opensBody: boolean, footnoteBase: number,
  keepOpeningIndex: boolean,
): string {
  let first = elements[0]?.startIndex ?? 0;
  let relative = (key: string, held: unknown): unknown => {
    if ((key === "startIndex" || key === "endIndex") && typeof held === "number") {
      return held - first;
    }
    if (key !== "footnoteNumber" || typeof held !== "string") return held;
    let number = wholeFootnoteNumber(held);
    return number === undefined ? held : number - footnoteBase;
  };
  let written = opensBody && !keepOpeningIndex && elements[0]?.sectionBreak && first === 0
    ? [{ ...elements[0], startIndex: undefined }, ...elements.slice(1)] : elements;
  return createHash("sha256").update(JSON.stringify(written, relative)).digest("base64");
}

/** What `storedByRuns` is asked beside the tab and the cut. */
export type StoredByRunsOptions = {
  /** The renderings stored so far, by run, context key and carry key: one map a test. */
  renderings?: Map<string, string>;
  /** What draws the unrelated carries. */
  seed?: number;
  /** Stands for the renderer's recording of a summary: the teeth pass one that leaks. */
  summaryOf?: (rendered: RenderedRun, carry: PlainCarry) => RunSummary;
  /** Stands for `runCarryKey`: the teeth pass one that leaves a field out. */
  carryKeyOf?: typeof runCarryKey;
  /** Stands for `advanceCarry`: the teeth pass one that leaves a part where it was. */
  advance?: typeof advanceCarry;
  /** Stands for the copy a test keeps of a pass's carry: the teeth pass one that is no copy. */
  kept?: (carry: PassCarry) => PlainCarry;
  /** Stands for `runContextKey`: the teeth pass one that leaves a part out. */
  contextKeyOf?: typeof runContextKey;
  /** Makes only the check that a summary is the same whatever is carried in. */
  independenceAlone?: boolean;
  /** Names a run with the start index of an opening section break kept (the teeth). */
  keepOpeningIndex?: boolean;
};

/** `expect(got).toEqual(want)`, decided by the JSON texts where they are the same. */
export function expectSame(got: unknown, want: unknown, where: () => string): void {
  if (JSON.stringify(got) !== JSON.stringify(want)) expect(got, where()).toEqual(want);
}

/** What a stored summary keeps of a rendering: its counts, and its tables from `mdStart`. */
function storedCounts({ sourceMap }: RenderedRun, mdStart: number): unknown {
  return {
    blocks: sourceMap.blocks.length,
    protectedRanges: sourceMap.protectedRanges.length,
    tables: sourceMap.tables.map(table => [table.mdStart - mdStart, table.mdEnd - mdStart]),
  };
}

/**
 * Holds the runs `bounds` cut `tab` into, entered with one pass's carry, to what the store rests on:
 * THE KEYS (a run rendered from its keys alone is the same, and a key has one Markdown), THE ADVANCE
 * (`advancedCopy`), THE OWNERSHIP (no carry changed in place) and THE SUMMARY (the same under any
 * carry). Answers each run's carry key.
 */
export function storedByRuns(
  tab: GoogleDocsTab, bounds: readonly number[], where: string,
  options: StoredByRunsOptions = {},
): string[] {
  let {
    renderings = new Map<string, string>(), seed = 1, summaryOf = rendered => rendered.summary,
    carryKeyOf = runCarryKey, contextKeyOf = runContextKey, advance = advanceCarry,
    kept = plainOf,
  } = options;
  let pass = initialCarry();
  let mdStart = 0;
  let keys: string[] = [];
  for (let run = 0; run + 1 < bounds.length; run++) {
    let elements = tab.body.content.slice(bounds[run], bounds[run + 1]);
    let at = { mdStart };
    let place = () => `${where}, elements ${bounds[run]} to ${bounds[run + 1]}`;
    // The kept carry before the run, a copy sharing nothing with the pass, and the pass's arrays.
    let before = kept(pass);
    let apart: PlainCarry = {
      ...before, continuedListLevels: [...pass.continuedListLevels],
      listNumbers: Object.fromEntries(
        Array.from(pass.listNumbers, ([listId, numbers]) => [listId, [...numbers]])),
    };
    let held = new Map(pass.listNumbers);
    // Two carries held to each other: by `sameCarry`, and by their data where it says another.
    let expectSameCarry = (got: PlainCarry, want: PlainCarry, what: string) => {
      if (sameCarry(got, want)) return;
      expectSame(got, want, () => `${place()}: ${what}`);
      expect.fail(`${place()}: ${what}: sameCarry says another`);
    };
    let rendered = renderRun(elements, tab, pass, at);
    let summary = summaryOf(rendered, before);
    let key = carryKeyOf(summary, carryOf(before));
    keys.push(key);

    for (let other of [INITIAL_CARRY, unrelatedCarry(rendered.summary, seed * 100_003 + run)]) {
      let under = renderRun(elements, tab, carryOf(other), at);
      expectSame(summaryOf(under, other), summary,
        () => `${place()}: the summary under ${JSON.stringify(other)}`);
      let moved = carryOf(other);
      advance(moved, summary);
      expectSameCarry(plainOf(moved), advancedCopy(other, summary),
        `the carry after ${JSON.stringify(other)}`);
    }
    advance(pass, summary);
    if (!options.independenceAlone) {
      expectSameCarry(plainOf(pass), advancedCopy(before, summary), "the carry after the run");
      expectSameCarry(before, apart, "the copy taken before the run, after it");
      for (let [listId, numbers] of held) {
        if (!Object.hasOwn(summary.lists, listId) && pass.listNumbers.get(listId) !== numbers) {
          expect.fail(`${place()}: the numbers of ${listId}, which the run does not count in, moved`);
        }
      }

      let again = renderRun(elements, contextFromKey(summary, tab),
        carryOf(carryFromKey(key, summary, apart)), at);
      if (again.markdown !== rendered.markdown) {
        expect(again.markdown, `${place()}: rendered from the key ${key}`).toBe(rendered.markdown);
      }
      expectSame(again.summary, rendered.summary, () => `${place()}: the summary from the key`);
      expectSame(storedCounts(again, mdStart), storedCounts(rendered, mdStart),
        () => `${place()}: the counts from the key ${key}`);

      let identity = runIdentity(
        elements, bounds[run] === 0, apart.footnoteBase, options.keepOpeningIndex === true);
      let entry = `${identity} ${contextKeyOf(summary, tab)} ${key}`;
      let stored = renderings.get(entry);
      if (stored === undefined) renderings.set(entry, rendered.markdown);
      else if (stored !== rendered.markdown) {
        expect(rendered.markdown, `${place()}: a second Markdown under the key ${key}`)
          .toBe(stored);
      }
    }
    mdStart += rendered.markdown.length;
  }
  return keys;
}
