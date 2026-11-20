import { describe, expect, it } from "vitest";
import type { GoogleDocsTab, StructuralElement } from "../src/docs-api";
import { cutRuns, RUN_SIZES } from "../src/docs-runs";
import {
  advanceCarry, CarryBeside, docTabToMarkdown, initialCarry, namedListIds, renderRun,
  runCarryKey, runContextKey,
} from "../src/markdown-converter";
import type { PassCarry, RenderedRun, RunSummary } from "../src/markdown-converter";
import { countedCarry, touchedBy } from "./carry-count";
import { buildTab, cellOf, diceOf, item, para } from "./doc-fixture";
import type { BlockSpec } from "./doc-fixture";
import { listedTablesTab } from "./doc-store-scenarios";
import {
  advancedCopy, appendRun, carryOf, everyCutInTwo, expectRendersByRuns, expectSame,
  expectSameRendering, forcedRuns, fuzzedTabs, INITIAL_CARRY, largeTabs, noRuns, oneElementRuns,
  plainOf, recordedTabs, renderedByRuns, renderedFrom, sameCarry, seededCutsInTwo, storedByRuns,
} from "./render-run-tabs";
import type { NamedTab, PlainCarry, Rendering, StoredByRunsOptions } from "./render-run-tabs";

// Built once: a test renders these tabs and changes none.
const RECORDED = recordedTabs();
const LARGE = largeTabs();
/** The corpus of the tests that render every tab one element a run. */
const CORPUS: NamedTab[] = [...RECORDED, ...largeTabs(10)];

/** The seed of the first shard of fuzzed tabs: shard `n` is drawn from this plus `n`. */
const FUZZED_SEED = 20261116;
/** The first shard, for the teeth that only a fuzzed tab bites. */
const FUZZED_FIRST = fuzzedTabs(FUZZED_SEED, 100);
/** The corpus of the teeth: small enough that each tooth is found within its budget. */
const TEETH: NamedTab[] = [...RECORDED, ...largeTabs(20)];

/** The recordings' tabs, one group a scenario: the tab it starts from opens each. */
const RECORDINGS: { name: string; tabs: NamedTab[] }[] = [];
for (let tab of RECORDED) {
  if (tab.name.endsWith(", before")) RECORDINGS.push({ name: tab.name.slice(0, -8), tabs: [] });
  RECORDINGS.at(-1)!.tabs.push(tab);
}

/**
 * The first of `tabs` that `storedByRuns` fails, one element a run and then in runs of one to
 * three, under `options`. `renderings`, where given, is shared by every tab: a run of one tab
 * is then looked for among the runs of the others.
 */
function firstFailing(
  tabs: readonly NamedTab[], options: StoredByRunsOptions, renderings?: Map<string, string>,
): string | undefined {
  return tabs.find(({ name, tab }) => {
    let { length } = tab.body.content;
    let stored = { ...options, renderings: renderings ?? new Map<string, string>() };
    try {
      storedByRuns(tab, oneElementRuns(length), name, stored);
      storedByRuns(tab, forcedRuns(length, 1), name, stored);
      return false;
    } catch {
      return true;
    }
  })?.name;
}

/** The key `runCarryKey` gives, without `field`. */
function keyWithout(field: "s" | "n" | "l" | "f"): typeof runCarryKey {
  return (summary, carry) => {
    let key = runCarryKey(summary, carry);
    if (key === "") return key;
    let { [field]: _left, ...fields } = JSON.parse(key) as Record<string, unknown>;
    return Object.keys(fields).length > 0 ? JSON.stringify(fields) : "";
  };
}

/** The context key without the first list the run names. */
const withoutList: typeof runContextKey = (summary, context) =>
  runContextKey({ ...summary, listIds: summary.listIds.slice(1) }, context);

/** The context key without what the named styles say of a subtitle. */
const withoutItalic: typeof runContextKey = (summary, context) =>
  runContextKey({ ...summary, subtitle: false }, context);

/** The carry key and a copy of the carry before each element of `tab`, one element a run. */
function keysOf(tab: GoogleDocsTab): { keys: string[]; carries: PlainCarry[] } {
  let pass = initialCarry();
  let carries = [plainOf(pass)];
  let keys = tab.body.content.map(element => {
    let { summary } = renderRun([element], tab, pass, { mdStart: 0 });
    let key = runCarryKey(summary, pass);
    advanceCarry(pass, summary);
    carries.push(plainOf(pass));
    return key;
  });
  return { keys, carries };
}

/** The carry key of a run entered with a carry a test keeps. */
function keyOf(summary: RunSummary, carry: PlainCarry): string {
  return runCarryKey(summary, carryOf(carry));
}

/** `advanceCarry` that leaves `part` of the carry as it was before the run. */
function advanceWithout(part: keyof PassCarry): typeof advanceCarry {
  return (carry, summary) => {
    let before = { ...carry };
    let numbers = Object.keys(summary.lists)
      .map(listId => [listId, carry.listNumbers.get(listId)] as const);
    advanceCarry(carry, summary);
    if (part === "listNumbers") {
      for (let [listId, held] of numbers) {
        if (held) carry.listNumbers.set(listId, held);
        else carry.listNumbers.delete(listId);
      }
    } else if (part === "previousListId") {
      if (before.previousListId === undefined) delete carry.previousListId;
      else carry.previousListId = before.previousListId;
    } else {
      Object.assign(carry, { [part]: before[part] });
    }
  };
}

/**
 * No copy of `pass` but a view of it, which reads the pass's carry whenever it is read: what
 * keeping a carry past a move comes to.
 */
function viewOf(pass: PassCarry): PlainCarry {
  return {
    get hasOutput() { return pass.hasOutput; },
    get abutsProtected() { return pass.abutsProtected; },
    get previousListId() { return pass.previousListId; },
    get continuedListLevels() { return pass.continuedListLevels; },
    get listNumbers() { return Object.fromEntries(pass.listNumbers); },
    get footnoteBase() { return pass.footnoteBase; },
  };
}

/** `advanceCarry`, with the numbers of the first list the run counts in changed in place. */
const advanceInPlace: typeof advanceCarry = (carry, summary) => {
  let [listId] = Object.keys(summary.lists);
  let held = listId === undefined ? undefined : carry.listNumbers.get(listId);
  advanceCarry(carry, summary);
  let after = held && carry.listNumbers.get(listId);
  if (!held || !after) return;
  (held as (number | null)[]).splice(0, held.length, ...after);
  carry.listNumbers.set(listId, held);
};

/** `advanceCarry`, with every list's numbers then replaced by a copy of them. */
const advanceByCopy: typeof advanceCarry = (carry, summary) => {
  advanceCarry(carry, summary);
  for (let [listId, numbers] of carry.listNumbers) carry.listNumbers.set(listId, [...numbers]);
};

/** The summary of each element of `tab`, one element a run: the same under any carry. */
function summariesOf(tab: GoogleDocsTab): RunSummary[] {
  return tab.body.content.map(element =>
    renderRun([element], tab, initialCarry(), { mdStart: 0 }).summary);
}

/**
 * The list of another version beside a list of `runs` runs, as places in that list: by `seed`
 * about one run in eight dropped, one in eight repeated once and one in eight moved two
 * places on.
 */
function listBeside(runs: number, seed: number): number[] {
  let { below } = diceOf(seed);
  let kinds = Array.from({ length: runs }, () => below(8));
  let theirs = kinds.flatMap((kind, run) => kind === 0 ? [] : kind === 1 ? [run, run] : [run]);
  // From the end, so that a run moved on is not moved again by the one before it.
  for (let at = theirs.length - 3; at >= 0; at--) {
    if (kinds[theirs[at]] === 2) theirs.splice(at + 2, 0, ...theirs.splice(at, 1));
  }
  return theirs;
}

/** What a walk beside another list saw of `same()`. */
type BesideWalk = {
  /** How many times the two carries were the same, and were not. */
  same: number; apart: number;
  /** Whether they were the same again after they were not. */
  settled: boolean;
  /** How many times `same()` was not what the two copies say. */
  wrong: number;
};

/**
 * The walk of a version keyed beside another, over the runs of `summaries` and THEIR list
 * `theirs`: one pass's carry and the other version's beside it (`CarryBeside`), each held to
 * a copy moved by `advancedCopy`. Our runs in order; before each, their runs up to the place
 * that holds it are passed; then the run itself on our side and, where their list holds it at
 * that place, on theirs. After every move `same()` is what `sameCarry` says of the two copies,
 * our carry is our copy, and their carry reads as their copy. `outside` moves our carry by
 * `advanceCarry` and not through the pair, and then only counts where `same()` is wrong.
 */
function walkedBeside(
  name: string, summaries: readonly RunSummary[], theirs: readonly number[], outside = false,
): BesideWalk {
  let ours = initialCarry();
  let beside = new CarryBeside(ours, initialCarry());
  let ourCopy = INITIAL_CARRY, theirCopy = INITIAL_CARRY;
  let walk: BesideWalk = { same: 0, apart: 0, settled: false, wrong: 0 };
  let last = true;
  let check = (after: string) => {
    let same = beside.same();
    let where = () => `${name}, after ${after}`;
    if (same !== sameCarry(ourCopy, theirCopy)) {
      walk.wrong++;
      if (!outside) expect.fail(`${where()}: same() is ${same}`);
    }
    if (outside) return;
    if (same) walk.same++;
    else walk.apart++;
    if (same && !last) walk.settled = true;
    last = same;
    if (!sameCarry(plainOf(ours), ourCopy)) expectSame(plainOf(ours), ourCopy, where);
    let { listNumbers, ...parts } = theirCopy;
    let view = beside.theirs;
    expectSame({
      hasOutput: view.hasOutput, abutsProtected: view.abutsProtected,
      ...(view.previousListId === undefined ? {} : { previousListId: view.previousListId }),
      continuedListLevels: view.continuedListLevels, footnoteBase: view.footnoteBase,
    }, parts, () => `${where()}: their carry's parts`);
    let listIds = [...Object.keys(ourCopy.listNumbers), ...Object.keys(listNumbers), "no such list"];
    for (let listId of listIds) {
      let want = Object.hasOwn(listNumbers, listId) ? listNumbers[listId] : undefined;
      let got = view.listNumbers.get(listId);
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        expect(got, `${where()}: their numbers of ${listId}`).toEqual(want);
      }
    }
  };
  // The places their list holds each of our runs at, in order.
  let places = new Map<number, number[]>();
  for (let [place, run] of theirs.entries()) places.set(run, [...places.get(run) ?? [], place]);
  let next = 0;
  for (let [run, summary] of summaries.entries()) {
    let at = places.get(run)?.find(place => place >= next);
    if (at !== undefined) {
      for (; next < at; next++) {
        beside.advanceTheirs(summaries[theirs[next]]);
        theirCopy = advancedCopy(theirCopy, summaries[theirs[next]]);
        check(`their run ${next}`);
      }
      next = at + 1;
    }
    if (outside) advanceCarry(ours, summary);
    else beside.advanceOurs(summary);
    ourCopy = advancedCopy(ourCopy, summary);
    check(`our run ${run}`);
    if (at === undefined) continue;
    beside.advanceTheirs(summary);
    theirCopy = advancedCopy(theirCopy, summary);
    check(`run ${run} on their side`);
  }
  return walk;
}

/** The summary of each run of `listedTablesTab("t1", 2_000)` as the store cuts it. */
function listedSummaries(): RunSummary[] {
  let tab = listedTablesTab("t1", 2_000);
  return Array.from(cutRuns(tab.body.content, RUN_SIZES), run =>
    renderRun(run.elements, tab, initialCarry(), { mdStart: 0 }).summary);
}

/** Whether two renderings differ, by the comparison every test of runs uses. */
function differ(got: Rendering, whole: Rendering): boolean {
  try {
    expectSameRendering(got, whole, "");
    return false;
  } catch {
    return true;
  }
}

/**
 * How many footnote references `elements` hold, counted in their JSON text and not by a walk
 * like the renderer's: a key is the only place the text holds the name between bare quotes.
 */
function footnoteReferences(elements: readonly StructuralElement[]): number {
  return JSON.stringify(elements).split('"footnoteReference":').length - 1;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (let part of Object.values(value)) deepFreeze(part);
  }
  return value;
}

/** Holds `carry` to the one way a carry is written, so that equal carries are equal data. */
function expectWrittenOneWay(carry: PlainCarry, where: string): void {
  // `Array.from` reads a hole as `undefined`, which JSON would write as `null`.
  let levels = Array.from(carry.continuedListLevels);
  let numbers = Object.values(carry.listNumbers).map(list => Array.from(list));
  if ((carry.previousListId === undefined ? levels.length > 0 : levels.at(-1) === false) ||
      levels.some(level => typeof level !== "boolean") ||
      numbers.some(list => list.length === 0 || list.at(-1) === null ||
        list.some(number => number !== null && !Number.isInteger(number)))) {
    expect.fail(`${where}: a carry written another way, ${JSON.stringify(carry)}`);
  }
}

/**
 * Every boundary of `tab` as a cut: the three elements before it and the three after, as
 * two runs from the carry `chain` (the tab one element a run) gives where they start, against
 * the same elements as one run from that carry.
 */
function expectEveryBoundaryJoins(
  tab: GoogleDocsTab, chain: ReturnType<typeof renderedByRuns>, name: string,
): void {
  let { content } = tab.body;
  for (let cut = 1; cut < content.length; cut++) {
    let from = Math.max(0, cut - 3);
    let to = Math.min(content.length, cut + 3);
    let carry = chain.carries[from];
    let mdStart = chain.starts[from];
    // Two passes from the carry there: one over the elements as one run, one over the two.
    let whole = carryOf(carry);
    let one = renderRun(content.slice(from, to), tab, whole, { mdStart });
    advanceCarry(whole, one.summary);
    let pass = carryOf(carry);
    let first = renderRun(content.slice(from, cut), tab, pass, { mdStart });
    advanceCarry(pass, first.summary);
    let second = renderRun(
      content.slice(cut, to), tab, pass, { mdStart: mdStart + first.markdown.length });
    advanceCarry(pass, second.summary);
    let joined = noRuns(mdStart);
    appendRun(joined, first);
    appendRun(joined, second);
    let got = { ...joined, carry: plainOf(pass) };
    let want = {
      markdown: one.markdown, sourceMap: one.sourceMap, extendsProtected: one.extendsProtected,
      mdStart, starts: [], flags: [], carry: plainOf(whole),
    };
    // By their JSON text first, as `expectSameRendering` compares: `toEqual` decides and
    // gives the message where the texts differ.
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      expect(got, `${name}, elements ${from} to ${to} cut at ${cut}`).toEqual(want);
    }
  }
}

describe("a tab rendered by runs", () => {
  it("a recording's tab rendered by runs is the tab rendered whole, at every cut", () => {
    // 33 scenarios before their first step, and after each of 199 steps.
    expect(RECORDED.length).toBeGreaterThanOrEqual(232);
    for (let { name, tab } of RECORDED) {
      // Short enough that `expectRendersByRuns` makes every cut in two.
      expect(tab.body.content.length, name).toBeLessThanOrEqual(64);
      expectRendersByRuns(tab, name);
    }
  });

  // What holds what. A cut changes the rendering only of the elements around it, so (4) is
  // every cut of a large tab at a cost linear in the tab: each boundary with three elements
  // on either side, entered with the carry the tab gives there. (3) holds long runs entered
  // with a carry that is not the initial one, which no other part renders. (1) holds the
  // chain of carries from the first element to the last, and (2) runs of unequal lengths.
  it.each(LARGE)("a large tab rendered by runs is the tab rendered whole: $name", ({ name, tab }) => {
    let whole = docTabToMarkdown(tab);
    let { length } = tab.body.content;

    // (1) One element a run.
    let chain = renderedByRuns(tab, oneElementRuns(length));
    expectSameRendering(chain, whole, `${name}, one element a run`);
    // (2) Runs of one to three elements.
    for (let seed of [1, 2, 3]) {
      expectSameRendering(renderedByRuns(tab, forcedRuns(length, seed)), whole,
        `${name}, runs of one to three elements, seed ${seed}`);
    }
    // (3) Two long runs.
    for (let bounds of seededCutsInTwo(length, 5, 8)) {
      expectSameRendering(renderedByRuns(tab, bounds), whole,
        `${name}, cut in two at element ${bounds[1]}`);
    }
    // (4) Every boundary.
    expectEveryBoundaryJoins(tab, chain, name);
  });

  it("the large tabs have the sizes and the distinct items their tests rest on", () => {
    for (let { name, tab, about } of LARGE) {
      let elements = tab.body.content.length;
      expect(Math.abs(elements - about), name).toBeLessThanOrEqual(about / 10);
    }

    // A run is cut by the strings of its elements: no two of a list's items may be the same.
    for (let { name, tab } of LARGE.slice(0, 2)) {
      let texts = tab.body.content.flatMap(({ paragraph }) => paragraph
        ? [paragraph.elements.map(element => element.textRun?.content).join("")] : []);
      expect(texts.length, name).toBeGreaterThanOrEqual(19_000);
      expect(new Set(texts).size, name).toBe(texts.length);
    }

    // A table whose cells continue the body's list shows the numbers the body carried: its
    // rendering depends on the carry it is entered with.
    let { tab } = LARGE.find(({ name }) => name === "tables between lists")!;
    let whole = docTabToMarkdown(tab);
    let inTab = whole.sourceMap.tables
      .map(table => ({ table, html: whole.markdown.slice(table.mdStart, table.mdEnd) }))
      .find(({ html }) => html.includes('<ol start="'));
    expect(inTab).toBeDefined();
    let element = tab.body.content.find(({ startIndex }) => startIndex === inTab!.table.docStart)!;
    expect(element.table).toBeDefined();
    let alone = renderRun([element], tab, initialCarry(), { mdStart: 0 });
    expect(alone.markdown).not.toBe(`${inTab!.html}\n`);
    expect(alone.markdown).not.toContain('<ol start="');
    // Every second table continues the body's list, the others number a list of their own.
    let continued = whole.sourceMap.tables.filter(table =>
      whole.markdown.slice(table.mdStart, table.mdEnd).includes('<ol start="'));
    expect(continued.length).toBe(whole.sourceMap.tables.length / 2);
  });
});

describe("the carry", () => {
  it("is all that a run needs of the elements before it", () => {
    let footnotes = 0;
    for (let { name, tab } of CORPUS) {
      let { content } = tab.body;
      let chain = renderedByRuns(tab, oneElementRuns(content.length), carry => carry);
      expectSameRendering(chain, docTabToMarkdown(tab), name);
      // The renderer counts `footnoteBase` and does not read it, so spoiling it changes no
      // rendering: it is held to the references before each run here, and what reads it (the
      // decoder of a stored run) is held to it by that decoder's tests.
      let before = 0;
      for (let run = 0; run <= content.length; run++) {
        expectWrittenOneWay(chain.carries[run], `${name}, before element ${run}`);
        // A run of no elements writes nothing and leaves the carry as it found it.
        let none = renderedFrom([], tab, chain.carries[run], { mdStart: chain.starts[run] ?? 0 });
        if (none.markdown !== "" || none.extendsProtected ||
            JSON.stringify(none.carry) !== JSON.stringify(chain.carries[run])) {
          expect(none, `${name}, no elements before element ${run}`).toEqual({
            ...noRuns(), carry: chain.carries[run],
          });
        }
        if (chain.carries[run].footnoteBase !== before) {
          expect(chain.carries[run].footnoteBase, `${name}, before element ${run}`).toBe(before);
        }
        if (run < content.length) before += footnoteReferences([content[run]]);
      }
      footnotes += before;
    }
    // References in paragraphs, in table cells and in tables inside cells are all counted.
    expect(footnotes).toBeGreaterThanOrEqual(300);
  });

  // A level a list skips has no number: a hole while a run counts, a `null` in the carry. An
  // item of that level after a cut starts at the level's own first number, which only a level
  // that does not start at 1 tells from a `null` counted as 0.
  it("a level carried with no number starts at the level's first number", () => {
    let tab = buildTab([item("a", "L", 1), item("b", "L", 0)], {
      L: {
        listProperties: {
          nestingLevels: [{ glyphType: "DECIMAL", startNumber: 5 }, { glyphType: "DECIMAL" }],
        },
      },
    });
    expect(docTabToMarkdown(tab).markdown).toBe("  1. a\n5. b\n");
    // The body's opening section break and the nested item.
    let nested = renderedFrom(tab.body.content.slice(0, 2), tab, INITIAL_CARRY, { mdStart: 0 });
    expect(nested.carry.listNumbers).toEqual({ L: [null, 1] });
    expectRendersByRuns(tab, "a skipped level that starts at 5");
  });

  // The tab rendered whole and by runs would lose the blank line after its first structure
  // alike, so this one is held to the Markdown itself.
  it.each<{ name: string; first: BlockSpec; ends: string }>([
    { name: "a table", first: { table: [["a"]] }, ends: "</table>\n\nb\n" },
    {
      name: "a table of contents", first: { structure: "tableOfContents" },
      ends: "[Table of contents]\n\nb\n",
    },
    {
      name: "a section break", first: { structure: "sectionBreak" },
      ends: "[Section break]\n\nb\n",
    },
  ])("a structure that is the first thing written is output: $name", ({ name, first, ends }) => {
    let tab = buildTab([first, para("b")]);
    let { content } = tab.body;
    expect(docTabToMarkdown(tab).markdown.slice(-ends.length)).toBe(ends);
    expectRendersByRuns(tab, name);
    // The body's opening section break writes nothing; the structure after it does.
    let opening = renderedFrom(content.slice(0, 1), tab, INITIAL_CARRY, { mdStart: 0 });
    expect(opening.carry.hasOutput).toBe(false);
    let structure = renderedFrom(content.slice(1, 2), tab, opening.carry, { mdStart: 0 });
    expect(structure.carry.hasOutput).toBe(true);
    expect(renderedFrom(content.slice(0, 2), tab, INITIAL_CARRY, { mdStart: 0 }).carry.hasOutput)
      .toBe(true);
  });

  // The teeth: with one field left as a tab's first run has it, some tab renders otherwise.
  it.each([
    "hasOutput", "abutsProtected", "previousListId", "continuedListLevels", "listNumbers",
  ] as const)("nothing but the carry crosses a boundary: %s", field => {
    let spoil = (carry: PlainCarry): PlainCarry => ({ ...carry, [field]: INITIAL_CARRY[field] });
    let spoiled = CORPUS.find(({ tab }) => differ(
      renderedByRuns(tab, oneElementRuns(tab.body.content.length), spoil), docTabToMarkdown(tab)));
    expect(spoiled?.name, `no tab renders otherwise without ${field}`).toBeDefined();
  });

  it("renderRun changes nothing it is given", () => {
    let tabs = [...RECORDED.filter((_, index) => index % 20 === 0), ...largeTabs(10)];
    for (let { name, tab } of tabs) {
      let frozen = deepFreeze(structuredClone(tab));
      let { length } = frozen.body.content;
      for (let bounds of [oneElementRuns(length), forcedRuns(length, 7)]) {
        let joined = noRuns();
        // A pass's carry: a map cannot be frozen, so its arrays are, and a copy that shares
        // nothing with it is taken before the call and held to one taken after.
        let carry = carryOf(INITIAL_CARRY);
        for (let run = 0; run + 1 < bounds.length; run++) {
          deepFreeze([carry.continuedListLevels, ...carry.listNumbers.values()]);
          let before = structuredClone(plainOf(carry));
          let rendered = renderRun(frozen.body.content.slice(bounds[run], bounds[run + 1]),
            frozen, carry, deepFreeze({ mdStart: joined.markdown.length }));
          expectSame(plainOf(carry), before, () => `${name}: the carry after run ${run} is rendered`);
          appendRun(joined, rendered);
          advanceCarry(carry, rendered.summary);
        }
        expectSameRendering(joined, docTabToMarkdown(tab), name);
      }
    }
  });

  // Each run is entered with a pass's carry made of the copy of the carry before it, as its
  // JSON text reads back: what a test keeps of a carry says all of it.
  it("a carry kept as plain data is the same carry", () => {
    for (let { name, tab } of CORPUS) {
      let chain = renderedByRuns(tab, oneElementRuns(tab.body.content.length),
        carry => JSON.parse(JSON.stringify(carry)) as PlainCarry);
      expectSameRendering(chain, docTabToMarkdown(tab), name);
    }
  });
});

describe("a run's summary and its keys", () => {
  // The summary and the keys written out for one tab, so that each field is read once as data.
  // The properties below hold them to the renderer; an over-specific key they would let pass.
  it("says what a run leads with, shows, counts and leaves", () => {
    let noted: BlockSpec = { runs: ["f", { footnote: { id: "f1", number: "5" } }, "\n"] };
    let tab = buildTab([
      item("a", "N", 1), item("b", "N"), item("c", "N", 1), para("d"), item("e", "N", 1),
      { table: [[cellOf(item("f", "N"), item("g", "N", 1), noted)]] }, item("h", "B"),
      { runs: ["i\n"], namedStyleType: "SUBTITLE" }, item("j", "none"),
    ], {
      N: {
        listProperties: {
          nestingLevels: [{ glyphType: "DECIMAL", startNumber: 3 }, { glyphType: "DECIMAL" }],
        },
      },
      B: { listProperties: { nestingLevels: [{ glyphSymbol: "●" }] } },
    });
    let summaryOf = (from: number, to: number, of = tab) =>
      renderRun(of.body.content.slice(from, to), of, initialCarry(), { mdStart: 0 }).summary;
    let first = { listId: "N", level: 0, start: 3 };
    let second = { listId: "N", level: 1, start: 1 };

    // The opening section break writes nothing.
    expect(summaryOf(0, 1)).toEqual({
      emits: false, counters: [], footnotes: 0, numberedFootnotes: 0, listIds: [],
      subtitle: false, levels: { lead: false, fixed: [] }, lists: {},
    });
    // Three items of one list: each level's first leading item shows the carried number.
    let items = summaryOf(1, 4);
    expect(items).toEqual({
      emits: true, firstWrites: "paragraph", lead: { listId: "N", levels: [second, first] },
      counters: [], footnotes: 0, numberedFootnotes: 0, listIds: ["N"], subtitle: false,
      lastWrites: "text", endListId: "N", levels: { lead: true, min: 0, tail: [true, true] },
      lists: { N: { keep: 1, add: 1, start: 3, tail: [1] } },
    });
    // A paragraph, an item, a table whose cell opens the list again, and a bulleted item: the
    // second level is shown before the first is counted, and not after it.
    let mixed = summaryOf(4, 8);
    expect(mixed).toEqual({
      emits: true, firstWrites: "paragraph", counters: [second, first], footnotes: 1,
      numberedFootnotes: 1, listIds: ["B", "N"], subtitle: false, lastWrites: "text",
      endListId: "B", levels: { lead: false, fixed: [true] },
      lists: {
        N: { keep: 1, add: 1, start: 3, tail: [1] }, B: { keep: 1, add: 0, start: 1, tail: [] },
      },
    });
    // A leading item and then a structure: nothing is continued after it.
    expect(summaryOf(5, 7)).toEqual({
      emits: true, firstWrites: "paragraph", lead: { listId: "N", levels: [second] },
      counters: [first], footnotes: 1, numberedFootnotes: 1, listIds: ["N"], subtitle: false,
      lastWrites: "protected", levels: { lead: false, fixed: [] },
      lists: { N: { keep: 1, add: 1, start: 3, tail: [1] } },
    });
    // A table alone: what the run writes first is a structure.
    expect(summaryOf(6, 7).firstWrites).toBe("structure");
    // A leading item with a bullet, and one of a list the tab does not define: the levels a
    // run leads with are the numbered ones.
    expect(summaryOf(7, 8).lead).toEqual({ listId: "B", levels: [] });
    expect(summaryOf(9, 10).lead).toEqual({ listId: "none", levels: [] });
    // A level is said once, however many of the run's items show its number: of two leading
    // items at one level the first, and one entry for a list a paragraph interrupts twice.
    let another = { listId: "A", level: 0, start: 1 };
    let repeats = buildTab([
      item("a", "N"), item("b", "N"), para("c"), item("d", "N"), para("e"), item("f", "N"),
      para("g"), item("h", "A"),
    ], { ...tab.lists, A: { listProperties: { nestingLevels: [{ glyphType: "DECIMAL" }] } } });
    expect(summaryOf(1, 3, repeats).lead).toEqual({ listId: "N", levels: [first] });
    expect(summaryOf(3, 7, repeats).counters).toEqual([first]);
    let both = summaryOf(5, 9, repeats);
    expect(both.counters).toEqual([first, another]);

    let carry: PlainCarry = {
      hasOutput: true, abutsProtected: false, previousListId: "N",
      continuedListLevels: [true, true], listNumbers: { N: [7, 2] }, footnoteBase: 0,
    };
    // The carried list continues at both levels: the items show `1.`, which for the first
    // level is not what its start gives.
    expect(keyOf(items, carry)).toBe('{"n":{"N":{"0":0}}}');
    expect(keyOf(items, { ...carry, previousListId: "B" }))
      .toBe('{"n":{"N":{"0":7,"1":2}},"s":true}');
    expect(keyOf(mixed, { ...carry, footnoteBase: 4 }))
      .toBe('{"f":4,"n":{"N":{"0":7,"1":2}},"s":true}');
    // A leading item that shows `1.` and a later one that shows the number carried.
    let twice = buildTab([item("a", "N"), para("b"), item("c", "N")], tab.lists);
    let { summary } = renderRun(twice.body.content, twice, initialCarry(), { mdStart: 0 });
    expect(keyOf(summary, carry)).toBe('{"l":{"0":true},"n":{"N":{"0":7}}}');
    expect(keyOf(summary, { ...carry, listNumbers: { N: [2] } })).toBe('{"l":{"0":true}}');
    // Carried at 0, the leading item shows `1.` continued or not: the number alone is the key.
    expect(keyOf(summary, { ...carry, listNumbers: { N: [0] } })).toBe('{"n":{"N":{"0":0}}}');
    // The lists of a key are in the order of their ids, not the order the run shows them in.
    expect(keyOf(both, { ...carry, listNumbers: { N: [7], A: [4] } }))
      .toBe('{"n":{"A":{"0":4},"N":{"0":7}},"s":true}');
    // A run that writes nothing shows nothing of a carry, whatever the carry holds, and moves
    // nothing: every part is what it was, and every array the array it was.
    expect(keyOf(summaryOf(0, 1), carry)).toBe("");
    let pass = carryOf(carry);
    let levels = pass.continuedListLevels;
    let held = pass.listNumbers.get("N");
    advanceCarry(pass, summaryOf(0, 1));
    expect(plainOf(pass)).toEqual(carry);
    expect(pass.continuedListLevels).toBe(levels);
    expect(pass.listNumbers.get("N")).toBe(held);
    // A run that counts in no list leaves each list's numbers the array they were.
    advanceCarry(pass, summaryOf(4, 5));
    expect([...pass.listNumbers]).toEqual([["N", held]]);
    expect(pass.listNumbers.get("N")).toBe(held);
    // A run that counts in a list gives it numbers of its own, and leaves the array as it was.
    advanceCarry(pass, items);
    expect(plainOf(pass).listNumbers).toEqual({ N: [8, 1] });
    expect(held).toEqual([7, 2]);

    // A list named as something every object inherits is a list like any other: its carried
    // number is in the key, the list is the carry's own after the run, and a tab that does
    // not define it says so.
    for (let listId of ["constructor", "__proto__", "toString"]) {
      let named = buildTab([
        item("a", listId), item("b", listId, 1), para("c"), item("d", listId), para("e"),
        item("f", listId),
      ], { [listId]: tab.lists.N });
      let last = named.body.content.slice(-1);
      let { summary: one } = renderRun(last, named, initialCarry(), { mdStart: 0 });
      for (let number of [4, 7]) {
        let numbered: PlainCarry = { ...carry, listNumbers: { [listId]: [number] } };
        let rendered = renderedFrom(last, named, numbered, { mdStart: 0 });
        expect(rendered.markdown).toBe(`\n${number + 1}. f\n`);
        expect(keyOf(one, numbered)).toBe(`{"n":{"${listId}":{"0":${number}}},"s":true}`);
        expect(Object.entries(rendered.carry.listNumbers)).toEqual([[listId, [number + 1]]]);
        expect(Object.entries(advancedCopy(numbered, one).listNumbers))
          .toEqual([[listId, [number + 1]]]);
      }
      expect(runContextKey(one, { lists: {} })).toBe(`{"lists":{"${listId}":null}}`);
      expectRendersByRuns(named, `a list named ${listId}`, "every", { stored: true });
    }

    // A numbered footnote is one whose number is a whole number as its text: not one padded
    // with zeros, not a word, not an empty number and not a reference with none.
    let notedBy = (...numbers: (string | undefined)[]) => {
      let { body } = buildTab([{
        runs: [
          ...numbers.map((number, at) => ({ footnote: { id: `n${at}`, number: number ?? "" } })),
          "\n",
        ],
      }]);
      let paragraph = body.content[1];
      for (let [at, { footnoteReference }] of paragraph.paragraph!.elements.entries()) {
        if (numbers[at] === undefined) delete footnoteReference?.footnoteNumber;
      }
      return renderRun([paragraph], tab, initialCarry(), { mdStart: 0 }).summary;
    };
    expect(notedBy("007", "-3", "x", "", undefined))
      .toMatchObject({ footnotes: 5, numberedFootnotes: 1 });
    expect(notedBy("-3")).toMatchObject({ footnotes: 1, numberedFootnotes: 1 });
    let later = { ...carry, footnoteBase: 4 };
    expect(keyOf(notedBy("-3"), later)).toBe('{"f":4,"s":true}');
    for (let number of ["007", "x", "", undefined]) {
      expect(notedBy(number)).toMatchObject({ footnotes: 1, numberedFootnotes: 0 });
      expect(keyOf(notedBy(number), later)).toBe('{"s":true}');
    }

    expect(runContextKey(items, tab)).toBe('{"lists":{"N":{"listProperties":{"nestingLevels":' +
      '[{"glyphType":"DECIMAL","startNumber":3},{"glyphType":"DECIMAL"}]}}}}');
    // A definition whose keys come in another order, at any depth, is the same definition.
    expect(runContextKey(items, {
      lists: {
        N: {
          listProperties: {
            nestingLevels: [{ startNumber: 3, glyphType: "DECIMAL" }, { glyphType: "DECIMAL" }],
          },
        },
      },
    })).toBe(runContextKey(items, tab));
    expect(runContextKey(summaryOf(8, 10), tab))
      .toBe('{"lists":{"none":null},"subtitleItalic":true}');
    expect(runContextKey(summaryOf(4, 5), tab)).toBe("");
  });

  // One test a recording, a shard of fuzzed tabs or a large tab, each with a map of
  // renderings of its own: `storedByRuns` renders every run five times.
  describe("the carry moved in place is the carry a copying advance gives, at every cut: a " +
      "run's summary, the advance and the two keys agree with the renderer under any carry", () => {
    it.each(RECORDINGS)("the recording $name", ({ tabs }) => {
      let renderings = new Map<string, string>();
      for (let { name, tab } of tabs) {
        let { length } = tab.body.content;
        storedByRuns(tab, oneElementRuns(length), `${name}, one element a run`, { renderings });
        for (let bounds of everyCutInTwo(length)) {
          storedByRuns(tab, bounds, `${name}, cut in two at element ${bounds[1]}`, { renderings });
        }
        for (let seed of [1, 2, 3]) {
          storedByRuns(tab, forcedRuns(length, seed),
            `${name}, runs of one to three elements, seed ${seed}`, { renderings, seed });
        }
      }
    });

    it.each(Array.from({ length: 12 }, (_, shard) => shard))("fuzzed tabs, shard %i", shard => {
      let renderings = new Map<string, string>();
      for (let { name, tab } of shard === 0 ? FUZZED_FIRST : fuzzedTabs(FUZZED_SEED + shard, 100)) {
        let { length } = tab.body.content;
        expect(length, name).toBeLessThanOrEqual(64);
        storedByRuns(tab, oneElementRuns(length), `${name}, one element a run`, { renderings });
        for (let bounds of everyCutInTwo(length)) {
          storedByRuns(tab, bounds, `${name}, cut in two at element ${bounds[1]}`, { renderings });
        }
        for (let seed of [1, 2]) {
          storedByRuns(tab, forcedRuns(length, seed),
            `${name}, runs of one to three elements, seed ${seed}`, { renderings, seed });
        }
      }
    });

    // One test a cut, so that each keeps to its budget: the tab's cuts share its renderings.
    describe.each(LARGE)("the large tab: $name", ({ name, tab }) => {
      let renderings = new Map<string, string>();
      let { length } = tab.body.content;

      it("one element a run", () => {
        storedByRuns(tab, oneElementRuns(length), `${name}, one element a run`, { renderings });
      });

      it.each([1, 2])("runs of one to three elements, seed %i", seed => {
        storedByRuns(tab, forcedRuns(length, seed),
          `${name}, runs of one to three elements, seed ${seed}`, { renderings, seed });
      });
    });
  });

  // The teeth of the check above: a run is otherwise only rendered again from a carry rebuilt
  // from its own key, which a summary that leaks the carry it was recorded under would pass.
  describe("a run's summary is the same whatever is carried into it", () => {
    it("as the renderer records it, on every tab of the corpus", () => {
      expect(firstFailing(TEETH, { independenceAlone: true })).toBeUndefined();
    });

    type Leak = {
      field: string;
      corpus: NamedTab[];
      leak: (summary: RunSummary, carry: PlainCarry) => RunSummary;
    };
    let leaks: Leak[] = [
      {
        field: "lead.levels without the levels the carry continues", corpus: TEETH,
        leak: (summary, carry) => {
          let { lead } = summary;
          if (!lead || lead.listId !== carry.previousListId) return summary;
          let levels = lead.levels.filter(({ level }) => !carry.continuedListLevels[level]);
          return { ...summary, lead: { ...lead, levels } };
        },
      },
      {
        field: "counters without the levels the carry holds no number for", corpus: TEETH,
        leak: (summary, carry) => ({
          ...summary,
          counters: summary.counters.filter(({ listId, level }) =>
            typeof carry.listNumbers[listId]?.[level] === "number"),
        }),
      },
      {
        field: "lists[id].add plus the number the carry holds", corpus: TEETH,
        leak: (summary, carry) => ({
          ...summary,
          lists: Object.fromEntries(Object.entries(summary.lists).map(([listId, effect]) =>
            [listId, {
              ...effect, add: effect.add + (carry.listNumbers[listId]?.[effect.keep - 1] ?? 0),
            }])),
        }),
      },
      {
        field: "footnotes plus the carry's footnote base", corpus: TEETH,
        leak: (summary, carry) => ({
          ...summary, footnotes: summary.footnotes + carry.footnoteBase,
        }),
      },
      {
        field: "levels with the carry's continued levels copied in", corpus: TEETH,
        leak: (summary, carry) => !summary.levels.lead ? summary : {
          ...summary,
          levels: {
            lead: false,
            fixed: [
              ...Array.from({ length: summary.levels.min }, (_, level) =>
                carry.previousListId === summary.lead?.listId &&
                  !!carry.continuedListLevels[level]),
              ...summary.levels.tail,
            ],
          },
        },
      },
    ];
    it.each(leaks)("and not with $field", ({ corpus, leak }) => {
      let summaryOf = (rendered: RenderedRun, carry: PlainCarry) => leak(rendered.summary, carry);
      let failing = firstFailing(corpus, { independenceAlone: true, summaryOf });
      expect(failing, "no tab fails a summary that leaks the carry").toBeDefined();
    });
  });

  it("a summary survives JSON, and so does a key", () => {
    for (let { name, tab } of [...CORPUS, ...FUZZED_FIRST]) {
      let carry = INITIAL_CARRY;
      for (let element of tab.body.content) {
        let { summary, carry: after } = renderedFrom([element], tab, carry, { mdStart: 0 });
        let decoded = JSON.parse(JSON.stringify(summary)) as RunSummary;
        let entered = carryOf(carry);
        let key = runCarryKey(summary, entered);
        let again = carryOf(carry);
        advanceCarry(again, decoded);
        if (!sameCarry(plainOf(again), after) || runCarryKey(decoded, entered) !== key ||
            runContextKey(decoded, tab) !== runContextKey(summary, tab)) {
          expect.fail(`${name}: a summary decoded from JSON says another carry or key`);
        }
        // A key is text: the empty string, or JSON that says the same when written again.
        if (key !== "" && JSON.stringify(JSON.parse(key)) !== key) {
          expect.fail(`${name}: the key ${key} is not written one way`);
        }
        carry = JSON.parse(JSON.stringify(after)) as PlainCarry;
      }
    }
  });

  describe("every field of the key matters", () => {
    it("with every field, no tab of the corpus fails", () => {
      expect(firstFailing([...TEETH, ...FUZZED_FIRST], {})).toBeUndefined();
    });

    it.each(["s", "n", "l", "f"] as const)("without %s, a tab fails", field => {
      let failing = firstFailing([...TEETH, ...FUZZED_FIRST], { carryKeyOf: keyWithout(field) });
      expect(failing, `no tab fails a key without ${field}`).toBeDefined();
    });
  });

  // The teeth of the advance and of the ownership `storedByRuns` holds at every run.
  describe("every part of the carry is moved, and nothing else of it", () => {
    it.each([
      "hasOutput", "abutsProtected", "previousListId", "continuedListLevels", "listNumbers",
      "footnoteBase",
    ] as const)("with %s left as it was, a tab fails", part => {
      let failing = firstFailing(TEETH, { advance: advanceWithout(part) });
      expect(failing, `no tab fails an advance that leaves ${part}`).toBeDefined();
    });

    it("with a carry kept past the move and read after it, a tab fails", () => {
      expect(firstFailing(TEETH, { kept: viewOf })).toBeDefined();
    });

    it("with a list's numbers changed in place, a tab fails", () => {
      expect(firstFailing(TEETH, { advance: advanceInPlace })).toBeDefined();
    });

    it("with the numbers of the lists a run does not count in copied, a tab fails", () => {
      expect(firstFailing(TEETH, { advance: advanceByCopy })).toBeDefined();
    });
  });

  it("a run renders the same wherever it stands", () => {
    let opening = (kind: string) =>
      FUZZED_FIRST.filter(({ name }) => name.includes(`opening section break: ${kind}`));
    // A section break stands first in the body, with a start index of 0 and with none, and
    // again directly after it, where it starts a run that nothing is written before.
    let starts = (kind: string) => opening(kind).filter(({ tab }) => {
      let [first, second] = tab.body.content;
      return !!first.sectionBreak && !!second.sectionBreak;
    });
    expect(starts("a start index of 0").length).toBeGreaterThan(0);
    expect(starts("no start index").length).toBeGreaterThan(0);
    expect(opening("none").length).toBeGreaterThan(0);

    expect(firstFailing(FUZZED_FIRST, {})).toBeUndefined();
    // The teeth of the stored form: named with its start index, the section break that opens
    // a body is the one after it, which is written.
    expect(firstFailing(FUZZED_FIRST, { keepOpeningIndex: true })).toBeDefined();
  });

  it("every part of the context key matters", () => {
    // One map for the shard: its tabs define the same list ids each their own way.
    expect(firstFailing(FUZZED_FIRST, {}, new Map())).toBeUndefined();
    expect(firstFailing(FUZZED_FIRST, { contextKeyOf: withoutList }, new Map())).toBeDefined();
    expect(firstFailing(FUZZED_FIRST, { contextKeyOf: withoutItalic }, new Map())).toBeDefined();
  });

  it("a carry that differs only in what a run does not show has the same key", () => {
    let [list, interrupted] = LARGE;
    let whole = keysOf(list.tab);
    expect(new Set(whole.carries.map(carry => JSON.stringify(carry))).size)
      .toBeGreaterThanOrEqual(list.tab.body.content.length);
    expect(new Set(whole.keys).size).toBeLessThanOrEqual(8);

    // An item put in near the start moves every later number of the list. The keys are of the
    // carry and the summary, which no index is in, so the copy needs no index of its own.
    let { content } = interrupted.tab.body;
    let at = 5;
    let longer = {
      ...interrupted.tab,
      body: { content: [...content.slice(0, at), content[at], ...content.slice(at)] },
    };
    let before = keysOf(interrupted.tab).keys;
    let after = keysOf(longer).keys;
    let changed = before.flatMap((key, element) =>
      element >= at && after[element + 1] !== key ? [element] : []);
    // An item opens a stretch of the list where the element before it is not an item.
    let opens = content.flatMap(({ paragraph }, element) => element >= at && paragraph?.bullet &&
      !content[element - 1].paragraph?.bullet ? [element] : []);
    expect(opens.length).toBeGreaterThanOrEqual(380);
    expect(changed).toEqual(opens);
    expect(after.slice(0, at)).toEqual(before.slice(0, at));
  });

  it("the key of a run entered with the initial carry is the empty string", () => {
    for (let { name, tab } of [...TEETH, ...FUZZED_FIRST]) {
      let { content } = tab.body;
      for (let bounds of [oneElementRuns(content.length), forcedRuns(content.length, 3)]) {
        for (let run = 0; run + 1 < bounds.length; run++) {
          let elements = content.slice(bounds[run], bounds[run + 1]);
          let { summary } = renderRun(elements, tab, initialCarry(), { mdStart: 0 });
          let key = runCarryKey(summary, initialCarry());
          if (key !== "") {
            expect(key, `${name}, elements ${bounds[run]} to ${bounds[run + 1]}`).toBe("");
          }
        }
      }
    }
  });

  it("namedListIds names the lists of the body, of cells and of tables in cells", () => {
    let tab = buildTab([
      item("one", "b"), para("two"), item("three", "a"), item("four", "b"),
      {
        table: [[cellOf(
          item("five", "c"), { table: [[cellOf(item("six", "d"), item("seven", "a"))]] },
          para("eight"),
        )]],
      },
    ]);
    expect(namedListIds(tab.body.content)).toEqual(["a", "b", "c", "d"]);
    expect(namedListIds(tab.body.content.slice(0, 3))).toEqual(["b"]);
    expect(namedListIds([])).toEqual([]);
    // It is what the renderer says a run names.
    for (let { name, tab: fuzzed } of FUZZED_FIRST) {
      let { content } = fuzzed.body;
      for (let bounds of [oneElementRuns(content.length), [0, content.length]]) {
        for (let run = 0; run + 1 < bounds.length; run++) {
          let elements = content.slice(bounds[run], bounds[run + 1]);
          let { summary } = renderRun(elements, fuzzed, initialCarry(), { mdStart: 0 });
          expect(namedListIds(elements), name).toEqual(summary.listIds);
        }
      }
    }
  });

  describe("a second carry beside a pass's own", () => {
    /** The tabs the walk beside is made over, with the summaries of their elements. */
    const BESIDE = [...CORPUS, ...fuzzedTabs(FUZZED_SEED, 40)]
      .map(({ name, tab }) => ({ name, summaries: summariesOf(tab) }));
    const SEEDS = [1, 2, 3];

    it("is the same exactly where a copy of it is", () => {
      let seen: BesideWalk = { same: 0, apart: 0, settled: false, wrong: 0 };
      for (let { name, summaries } of BESIDE) {
        for (let seed of SEEDS) {
          let walk = walkedBeside(
            `${name}, seed ${seed}`, summaries, listBeside(summaries.length, seed));
          seen.same += walk.same;
          seen.apart += walk.apart;
          seen.settled ||= walk.settled;
        }
      }
      // Not vacuous: the two are often the same, often not, and do settle.
      expect(seen.same).toBeGreaterThanOrEqual(200);
      expect(seen.apart).toBeGreaterThanOrEqual(200);
      expect(seen.settled).toBe(true);
    });

    it("is wrong where the pass's carry is moved outside the pair", () => {
      let wrong = 0;
      for (let { name, summaries } of BESIDE) {
        for (let seed of SEEDS) {
          wrong += walkedBeside(name, summaries, listBeside(summaries.length, seed), true).wrong;
        }
      }
      expect(wrong).toBeGreaterThan(0);
    });

    // Their list holds one more item of the first list, so the two differ at that list to
    // the tab's end and the pair holds one list apart. Both carries are counted: what a run
    // costs is the entries of the two maps together.
    it("costs the lists a run counts in, on both sides", () => {
      let summaries = listedSummaries();
      expect(summaries.length).toBe(4_001);
      let ours = countedCarry(initialCarry()), apart = countedCarry(initialCarry());
      let beside = new CarryBeside(ours, apart);
      beside.advanceOurs(summaries[0]);
      beside.advanceTheirs(summaries[0]);
      beside.advanceTheirs(summaries[1]);
      let most = 0, settled = 0;
      for (let summary of summaries.slice(1)) {
        most = Math.max(most, touchedBy(() => {
          beside.advanceOurs(summary);
          beside.advanceTheirs(summary);
        }));
        if (touchedBy(() => { if (beside.same()) settled++; }) !== 0) {
          expect.fail("same() read an entry of the numbers");
        }
      }
      expect(settled).toBe(0);
      // A table: 7 entries to move our side and 6 to move theirs. Never over 24.
      expect(most).toBe(13);
      expect(apart.listNumbers.size).toBe(1);
      expect(ours.listNumbers.size).toBe(2_000);
    });

    // Their list holds every table twice, so every list holds another number on their side to
    // the tab's end and the pair holds every list passed apart: thousands by the end, which is
    // where a move that listed or copied what it holds apart would cost the lists so far.
    it("that holds every list apart costs no more", () => {
      let summaries = listedSummaries();
      let ours = countedCarry(initialCarry()), apart = countedCarry(initialCarry());
      let beside = new CarryBeside(ours, apart);
      let last = summaries.length - 500;
      let most = 0, listed = 0, sizes: number[] = [];
      for (let [run, summary] of summaries.entries()) {
        let moved = touchedBy(() => {
          beside.advanceOurs(summary);
          beside.advanceTheirs(summary);
          if (Object.keys(summary.lists).length > 0) beside.advanceTheirs(summary);
        });
        let same: boolean | undefined;
        if (touchedBy(() => { same = beside.same(); }) !== 0) {
          expect.fail("same() read an entry of the numbers");
        }
        if (same !== (run === 0)) expect.fail(`same() is ${same} after run ${run}`);
        sizes.push(apart.listNumbers.size);
        if (run < last) continue;
        most = Math.max(most, moved);
        // The teeth: what a step that listed what is held apart would add to each move.
        listed += touchedBy(() => [...apart.listNumbers]);
      }
      // Held apart: one list more at each table, to the tab's end.
      expect(sizes.every((size, run) => run === 0 || size >= sizes[run - 1])).toBe(true);
      expect(sizes[2_000]).toBe(1_000);
      expect(sizes.at(-1)).toBe(2_000);
      // A table: 7 entries to move our side, 6 and then 7 to move theirs twice. Never over 24.
      expect(most).toBe(20);
      expect(listed).toBeGreaterThan(500 * 1_000);
    });
  });

  it("sameCarry compares two carries part for part", () => {
    let carry: PlainCarry = {
      hasOutput: true, abutsProtected: false, previousListId: "L",
      continuedListLevels: [true, false, true], listNumbers: { L: [3, null, 2], M: [1] },
      footnoteBase: 4,
    };
    let apart = JSON.parse(JSON.stringify(carry)) as PlainCarry;
    expect(sameCarry(carry, apart)).toBe(true);
    expect(sameCarry(carry, carry)).toBe(true);
    expect(sameCarry(INITIAL_CARRY, { ...INITIAL_CARRY, listNumbers: {} })).toBe(true);
    let { previousListId: _list, ...without } = carry;
    let others: PlainCarry[] = [
      { ...carry, hasOutput: false },
      { ...carry, abutsProtected: true },
      { ...carry, previousListId: "M" },
      without,
      { ...carry, continuedListLevels: [true, true, true] },
      { ...carry, continuedListLevels: [true] },
      { ...carry, listNumbers: { L: [3, null, 3], M: [1] } },
      { ...carry, listNumbers: { L: [3, 0, 2], M: [1] } },
      { ...carry, listNumbers: { L: [3, null, 2] } },
      { ...carry, listNumbers: { L: [3, null, 2], N: [1] } },
      { ...carry, listNumbers: { L: [3, null, 2], M: [1], N: [1] } },
      { ...carry, footnoteBase: 5 },
    ];
    for (let other of others) {
      expect(sameCarry(carry, other), JSON.stringify(other)).toBe(false);
      expect(sameCarry(other, carry), JSON.stringify(other)).toBe(false);
    }
  });
});
