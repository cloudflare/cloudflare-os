// The model on a slice of a tab gives the whole tab's outcome from every stretch, widened where it
// reads outside: every recorded step, the cases the guard is written for, `batchReach`, and what a
// slice answers for the rest of the tab.

import { describe, expect, it } from "vitest";
import type { GoogleDocsRequest, GoogleDocsTab } from "../src/docs-api";
import {
  applyDocsRequests, applyDocsRequestsToSlice, batchReach, replayCost,
} from "../src/docs-model";
import type { ModelCost, ModelOptions, TabSlice } from "../src/docs-model";
import { docEditRequests } from "../src/docs-replay";
import { pruneTab } from "../src/docs-replica";
import { docTabToMarkdown } from "../src/markdown-converter";
import { buildTab, diceOf, MODELS, para, presetLevels } from "./doc-fixture";
import { readFixtures } from "./docs-live-fixtures";
import { SCENARIOS, stepEdit } from "./docs-live-recorder";
import type { ScenarioStep } from "./docs-live-recorder";
import {
  BULLETED, bullets, deleteBullets, deleteColumn, deleteRange, deleteRow, insertRow, insertTable,
  insertText, mergeCells, NUMBERED, range, styleParagraphs, styleText,
} from "./docs-model-draws";
import {
  appliedFrom, elementHolding, everyStretch, expectEverySlice, FAMILY_KINDS,
  GUARD_MUTANTS, ingestedTab, isSliceEdge, LISTS_PLACES, MIXED_PLACES, mutantModel, requestOf,
  RANGE_KINDS, sampledSlices, SLICE_TABS, sliceOf, TABLE_KINDS, wholeOutcome,
} from "./docs-slice-shadow";
import type { FamilyKind, SliceApply } from "./docs-slice-shadow";
import { largeTabs, throughJson } from "./render-run-tabs";

/** The batch the builders make for `step` in `tab`, or nothing where they refuse the step. */
function builtBatch(tab: GoogleDocsTab, step: ScenarioStep): GoogleDocsRequest[] | undefined {
  let view = docTabToMarkdown(tab);
  try {
    return docEditRequests(view, stepEdit(step, view));
  } catch (error) {
    if (!(error instanceof Error) || error instanceof TypeError) throw error;
    return undefined;
  }
}

/** Every recorded step whose batch the builders make: the tab before it, and the batch. */
function* recordedBatches(): Generator<{
  fixture: string; where: string; tab: GoogleDocsTab; requests: GoogleDocsRequest[];
}> {
  for (let { name, before, steps } of readFixtures()) {
    let scenario = SCENARIOS.find(candidate => candidate.name === name)!;
    for (let [position, step] of scenario.steps.entries()) {
      // The tab Google returned before the step.
      let tab = pruneTab(throughJson(position === 0 ? before : steps[position - 1].after));
      let requests = builtBatch(tab, step);
      let where = `${name}, step ${position + 1} (${step.name})`;
      if (requests) yield { fixture: name, where, tab, requests };
    }
  }
}

/** The edge the model throws for `requests` on the stretch `[from, to)`, if it throws one. */
function edgeFrom(
  tab: GoogleDocsTab, requests: readonly GoogleDocsRequest[], from: number, to: number,
  options: ModelOptions = {}, apply: SliceApply = applyDocsRequestsToSlice,
): { side: "before" | "after"; index: number } | undefined {
  try {
    apply(sliceOf(tab, from, to, "model"), requests, options);
  } catch (thrown) {
    if (isSliceEdge(thrown)) return { side: thrown.side, index: thrown.index };
  }
  return undefined;
}

/** How many times `[from, to)` is widened for `requests`, its outcome held to the whole tab's. */
function widenedFrom(
  tab: GoogleDocsTab, requests: readonly GoogleDocsRequest[], from: number, to: number,
  options: ModelOptions = {},
): number {
  let { widenings, ...outcome } = appliedFrom(tab, requests, options, from, to, "model");
  expect(outcome, `from the stretch [${from}, ${to})`).toEqual(wholeOutcome(tab, requests, options));
  return widenings;
}

/** An item of the list `listId` holding `text`. */
const itemOf = (listId: string, text: string) => ({ runs: [`${text}\n`], bullet: { listId } });

/** A list as a bullet preset makes one: the bulleted preset's, or the numbered one's. */
const listOf = (numbered: boolean) => ({ listProperties: { nestingLevels: presetLevels(numbered) } });

/** A request that makes `[start, end)` bold. */
const bold = (start: number, end: number) => styleText(start, end, { bold: true }, "bold");

/** A footnote reference numbered `number`, as a paragraph of `buildTab` takes one. */
const note = (id: string, number: number) => ({ footnote: { id, number: String(number) } });

/** References in three paragraphs, the second with two, and a table with one in a cell. */
const noted = () => buildTab([
  para("lead"),
  { runs: ["alpha", note("fn.1", 1), "\n"] },
  { runs: ["beta", note("fn.2", 2), " gamma", note("fn.3", 3), "\n"] },
  { runs: ["\tdelta", note("fn.4", 4), "\n"] },
  { table: [["a\n", { paragraphs: [{ runs: ["b", note("fn.5", 5), "\n"] }] }], ["c\n", "d\n"]] },
  para("tail"),
]);

/** How far the end of the whole tab's body moves for `batch`. */
const wholeMoved = (tab: GoogleDocsTab, batch: GoogleDocsRequest[]) =>
  applyDocsRequests(tab, batch).body.content.at(-1)!.endIndex - tab.body.content.at(-1)!.endIndex;

/** The kinds that name a range. */
const RANGED: readonly FamilyKind[] = RANGE_KINDS;

// What the recordings' tests add to, for the test after them.
const corpus = { fixtures: 0, steps: 0, built: 0, stretches: 0, nothing: 0 };

describe("the model on a slice of a tab", () => {
  it.each(readFixtures().map(fixture => [fixture.name, fixture] as const))(
    "every recorded step, from every slice: %s", (name, { steps }) => {
      corpus.fixtures++;
      corpus.steps += steps.length;
      for (let [seed, { where, tab, requests }] of [...recordedBatches()]
        .filter(batch => batch.fixture === name).entries()) {
        corpus.built++;
        // As the replay applies a batch, with the lists a store hands: every stretch.
        let { ran, nothing } = expectEverySlice(tab, requests, {}, () => where);
        corpus.stretches += ran;
        corpus.nothing += nothing;
        // Under each of Google's behaviours, and with every list handed: a sample.
        let length = tab.body.content.length;
        for (let [variant, options] of MODELS.entries()) {
          expectEverySlice(tab, requests, options, () => `${where}, ${JSON.stringify(options)}`,
            "model", sampledSlices(length, seed * 10 + variant, 8));
        }
        expectEverySlice(tab, requests, {}, () => `${where}, every list handed`, "all",
          sampledSlices(length, seed * 10 + 9, 8));
      }
    });

  it("the hole a guard that reads the side off the lookup leaves, stated", () => {
    let tab = SLICE_TABS.MIXED;
    let { length } = tab.body.content;
    let table = tab.body.content[MIXED_PLACES.table];
    // Index 1 is the start of the tab's first paragraph, so the whole tab takes the batch.
    let batch = [deleteRange(table.startIndex, table.endIndex), insertText(1, "x")];
    let whole = wholeOutcome(tab, batch, {});
    expect("tab" in whole).toBe(true);

    // With the table removed the lookup of index 1 finds nothing; the side is the index's.
    let toEnd = [MIXED_PLACES.table, length] as const;
    expect(edgeFrom(tab, batch, ...toEnd)).toEqual({ side: "before", index: 1 });
    expect(appliedFrom(tab, batch, {}, ...toEnd, "model")).toEqual({ ...whole, widenings: 1 });

    // A guard that told the side from what the lookup found: nothing found, on a slice that
    // is the tab's last, is past no end, so it answers a refusal the whole tab does not give.
    let byLookup = mutantModel(GUARD_MUTANTS["side-by-lookup"]).applyDocsRequestsToSlice;
    expect(edgeFrom(tab, batch, ...toEnd, {}, byLookup)).toBeUndefined();
    expect(appliedFrom(tab, batch, {}, ...toEnd, "model", byLookup)).toEqual({
      refused: {
        name: "Error",
        message: "The insertion index must be inside the bounds of an existing paragraph. " +
          "You can still create new paragraphs by inserting newlines.",
      },
      widenings: 0,
    });

    // And from the table alone, which no tab here ends in, it names the wrong side: a caller
    // that follows it widens toward the tab's end, away from the paragraph the batch writes.
    let alone = [MIXED_PLACES.table, MIXED_PLACES.table + 1] as const;
    expect(edgeFrom(tab, batch, ...alone, {}, byLookup)).toEqual({ side: "after", index: 1 });
    expect(edgeFrom(tab, batch, ...alone)).toEqual({ side: "before", index: 1 });
  });

  describe("named cases", () => {
    const { MIXED, LISTS } = SLICE_TABS;
    const mixed = MIXED.body.content;
    const INVALID_DELETION = "Invalid deletion range. Cannot delete the requested range.";

    it("an edit ending at the slice's last element reads nothing after it", () => {
      let [first, last] = [mixed[4], mixed[5]];
      let batch = [styleParagraphs(first.startIndex, last.endIndex, { namedStyleType: "HEADING_2" }, "namedStyleType")];

      expect(edgeFrom(MIXED, batch, 4, 6)).toBeUndefined();
      expect(widenedFrom(MIXED, batch, 4, 6)).toBe(0);
    });

    it("a deletion that joins with the paragraph after the slice reads it", () => {
      let { endIndex } = mixed[4];
      let batch = [deleteRange(endIndex - 1, endIndex)];

      expect(edgeFrom(MIXED, batch, 4, 5)).toEqual({ side: "after", index: endIndex });
      expect(widenedFrom(MIXED, batch, 4, 5)).toBe(1);
    });

    it("an insertion at the very start of the slice's first paragraph reads nothing before it", () => {
      let batch = [insertText(mixed[5].startIndex, "x")];

      expect(edgeFrom(MIXED, batch, 5, 7)).toBeUndefined();
      expect(widenedFrom(MIXED, batch, 5, 7)).toBe(0);
    });

    it("a deletion that starts at the slice's first index reads nothing before it", () => {
      let { startIndex } = mixed[5];
      let batch = [deleteRange(startIndex, startIndex + 2)];

      expect(edgeFrom(MIXED, batch, 5, 7)).toBeUndefined();
      expect(widenedFrom(MIXED, batch, 5, 7)).toBe(0);
    });

    it("bullets behind a list that continues outside the slice read the item before it", () => {
      let { startIndex, endIndex } = LISTS.body.content[LISTS_PLACES.plain];
      let batch = [bullets(startIndex, endIndex, BULLETED)];
      let stretch = [LISTS_PLACES.plain, LISTS_PLACES.plain + 1] as const;

      expect(edgeFrom(LISTS, batch, ...stretch)).toEqual({ side: "before", index: startIndex - 1 });
      expect(widenedFrom(LISTS, batch, ...stretch)).toBe(1);
      // The paragraph joins the list of the item before it: no list is made.
      let made = appliedFrom(LISTS, batch, {}, ...stretch, "model");
      expect("tab" in made && made.tab.body.content[LISTS_PLACES.plain].paragraph?.bullet)
        .toEqual({ listId: "kix.b", nestingLevel: 1 });
    });

    it("bullets behind an item of another preset's list read it, and make a list", () => {
      let { startIndex, endIndex } = LISTS.body.content[LISTS_PLACES.plain];
      let batch = [bullets(startIndex, endIndex, NUMBERED)];
      let stretch = [LISTS_PLACES.plain, LISTS_PLACES.plain + 1] as const;

      expect(edgeFrom(LISTS, batch, ...stretch)).toEqual({ side: "before", index: startIndex - 1 });
      expect(widenedFrom(LISTS, batch, ...stretch)).toBe(1);
      // The item before is read to know that its list does not continue.
      let slice = sliceOf(LISTS, LISTS_PLACES.plain - 1, LISTS_PLACES.plain + 1, "model");
      let made = applyDocsRequestsToSlice(slice, batch);
      expect(made.lists).toEqual(["model.1"]);
      expect(Object.hasOwn(LISTS.lists, "model.1")).toBe(false);
      expect(slice.content[1].paragraph?.bullet).toEqual({ listId: "model.1" });
    });

    it.each([...TABLE_KINDS, "deleteContentRange"] as const)(
      "a table alone in its slice takes %s with nothing read around it", kind => {
        let { startIndex, endIndex } = mixed[MIXED_PLACES.table];
        let batch = [requestOf(kind, startIndex, { end: endIndex })];
        let stretch = [MIXED_PLACES.table, MIXED_PLACES.table + 1] as const;

        expect(edgeFrom(MIXED, batch, ...stretch)).toBeUndefined();
        expect(widenedFrom(MIXED, batch, ...stretch)).toBe(0);
        expect("tab" in wholeOutcome(MIXED, batch, {})).toBe(true);
      });

    it("the tab's final paragraph keeps its line break, by Google's refusal", () => {
      let { endIndex } = mixed.at(-1)!;
      let batch = [deleteRange(endIndex - 1, endIndex)];
      let stretch = [mixed.length - 1, mixed.length] as const;

      expect(widenedFrom(MIXED, batch, ...stretch)).toBe(0);
      expect(wholeOutcome(MIXED, batch, {})).toEqual({ refused: { name: "Error", message: INVALID_DELETION } });
    });

    it("a slice handed only its own lists mints an id another paragraph uses", () => {
      let tab = buildTab(
        [itemOf("model.1", "a"), para("plain"), itemOf("model.2", "b"), para("target"), para("end")],
        { "model.1": listOf(false), "model.2": listOf(true) });
      let { startIndex, endIndex } = tab.body.content[4];
      let batch = [bullets(startIndex, endIndex, BULLETED)];

      // The whole tab makes the lowest id no list of it has, and so does a slice handed
      // every id of the model's form, whatever it holds of their definitions.
      let whole = wholeOutcome(tab, batch, {});
      expect("tab" in whole && Object.keys(whole.tab.lists)).toEqual(["model.1", "model.2", "model.3"]);
      expect(widenedFrom(tab, batch, 4, 5)).toBe(1);
      let handed = sliceOf(tab, 3, 5, "model");
      expect(handed.lists["model.1"]).toEqual({});
      expect(applyDocsRequestsToSlice(handed, batch).lists).toEqual(["model.3"]);

      // Handed only the lists its own paragraphs name, it makes an id the tab's first
      // paragraph uses: the reason every id of the model's form is handed.
      let crippled = sliceOf(tab, 3, 5, "model");
      delete crippled.lists["model.1"];
      expect(applyDocsRequestsToSlice(crippled, batch).lists).toEqual(["model.1"]);
    });

    it("a slice of a tab of 500 lists Google made holds none of them but its own", () => {
      let lists = Object.fromEntries(Array.from({ length: 500 }, (_, list) =>
        [`kix.${list}`, { listProperties: { nestingLevels: presetLevels(list % 2 === 1) } }]));
      let tab = buildTab([
        ...Array.from({ length: 6 }, (_, list) =>
          ({ runs: [`item ${list}\n`], bullet: { listId: `kix.${list * 70}` } })),
        para("plain"),
      ], lists);
      let { startIndex, endIndex } = tab.body.content[7];

      expect(Object.keys(sliceOf(tab, 2, 4, "model").lists)).toEqual(["kix.70", "kix.140"]);
      expect(Object.keys(sliceOf(tab, 7, 8, "model").lists)).toEqual([]);
      for (let preset of [BULLETED, NUMBERED]) {
        expectEverySlice(tab, [bullets(startIndex, endIndex, preset)], {}, () => preset);
      }
    });

    it("a slice that starts with a surrogate pair does not read the unit before it", () => {
      let origin = mixed[MIXED_PLACES.pair].startIndex;
      for (let to = MIXED_PLACES.pair + 1; to <= mixed.length; to++) {
        let stretch = [MIXED_PLACES.pair, to] as const;
        expect(widenedFrom(MIXED, [insertText(origin, "x")], ...stretch)).toBe(0);
        // The pair whole.
        expect(widenedFrom(MIXED, [deleteRange(origin, origin + 2)], ...stretch)).toBe(0);
        expect("tab" in wholeOutcome(MIXED, [deleteRange(origin, origin + 2)], {})).toBe(true);
        // Inside the pair, one index past the origin: the whole tab's refusals, word for word.
        expect(widenedFrom(MIXED, [insertText(origin + 1, "x")], ...stretch)).toBe(0);
        expect(widenedFrom(MIXED, [deleteRange(origin + 1, origin + 3)], ...stretch)).toBe(0);
      }
      expect(wholeOutcome(MIXED, [insertText(origin + 1, "x")], {})).toEqual({
        refused: { name: "Error", message: "The insertion index cannot be within a grapheme cluster." },
      });
      expect(wholeOutcome(MIXED, [deleteRange(origin + 1, origin + 3)], {}))
        .toEqual({ refused: { name: "Error", message: INVALID_DELETION } });
    });

    it("a link cleared from a slice's first index reads the unit before it only where it is used", () => {
      let { startIndex: origin } = mixed[MIXED_PLACES.linked];
      let unlink = [styleText(origin, origin + 4, {}, "link")];
      let restyles: ModelOptions = { unlinkRestyles: true };
      for (let to = MIXED_PLACES.linked + 1; to <= mixed.length; to++) {
        let stretch = [MIXED_PLACES.linked, to] as const;
        // The text takes the look of the unit before it, the line break of the element
        // before the stretch.
        expect(edgeFrom(MIXED, unlink, ...stretch, restyles)).toEqual({ side: "before", index: origin - 1 });
        expect(widenedFrom(MIXED, unlink, ...stretch, restyles)).toBe(1);
        // Nothing uses the unit before: it is not read.
        expect(widenedFrom(MIXED, unlink, ...stretch)).toBe(0);
        // One index later, the unit before the range is the stretch's own.
        expect(widenedFrom(MIXED, [styleText(origin + 1, origin + 4, {}, "link")], ...stretch, restyles))
          .toBe(0);
      }

      // The outcome depends on that unit: with a line break that is not bold before it, the
      // text is given another style.
      let plain = throughJson(MIXED);
      delete plain.body.content[MIXED_PLACES.linked - 1].paragraph!.elements.at(-1)!.textRun!.textStyle.bold;
      let styleAfter = (tab: GoogleDocsTab) => {
        let made = wholeOutcome(tab, unlink, restyles);
        return "tab" in made && made.tab.body.content[MIXED_PLACES.linked].paragraph?.elements[0].textRun?.textStyle;
      };
      expect(styleAfter(MIXED)).toEqual({ bold: true });
      expect(styleAfter(plain)).toEqual({});
    });

    it("a slice is handed the tab's named styles", () => {
      let tab = buildTab([para("plain"), { runs: ["Title\n"], namedStyleType: "HEADING_1" }, para("end")]);
      tab.namedStyles = { styles: [{ namedStyleType: "HEADING_1", textStyle: { bold: true } }] };
      let { startIndex, endIndex } = tab.body.content[2];
      let batch = [styleText(startIndex, endIndex - 1, { bold: true }, "bold")];
      let styleOf = (slice: TabSlice) => slice.content
        .find(element => element.startIndex === startIndex)?.paragraph?.elements[0].textRun?.textStyle;

      for (let [from, to] of everyStretch(4).filter(([start, end]) => start <= 2 && end > 2)) {
        // The model stores a style the paragraph's named style already gives as inherited.
        expect(widenedFrom(tab, batch, from, to)).toBe(0);
        let handed = sliceOf(tab, from, to, "model");
        applyDocsRequestsToSlice(handed, batch);
        expect(styleOf(handed)).toEqual({});

        // Without the named styles the text holds the style: the reason they are handed.
        let { namedStyles: _, ...without } = sliceOf(tab, from, to, "model");
        applyDocsRequestsToSlice(without, batch);
        expect(styleOf(without)).toEqual({ bold: true });
      }
    });
  });

  describe("batchReach", () => {
    /** The nine kinds that can change a length; the other eight change none. */
    const LENGTHENS: readonly FamilyKind[] = [
      "insertText", "deleteContentRange", "insertTable", "createParagraphBullets", "insertTableRow",
      "insertTableColumn", "deleteTableRow", "deleteTableColumn", "mergeTableCells",
    ];

    it.each(FAMILY_KINDS)("names what %s reads", kind => {
      let reach = batchReach([requestOf(kind, 12, { end: 18 })]);
      // A deletion's exclusive end counts, a styled or bulleted range's last index, and a
      // bulleted range's start is also where the element before it is read from.
      let to = kind === "deleteContentRange" ? 18
        : RANGED.includes(kind) ? 17 : 12;
      expect(reach).toEqual({ from: 12, to, behind: kind === "createParagraphBullets" ? [12] : [] });
    });

    it("names nothing for no request, or for kinds the model does not take", () => {
      let other = { createNamedRange: { name: "n", range: range(3, 9) } } as unknown as GoogleDocsRequest;

      expect(batchReach([])).toBeUndefined();
      expect(batchReach([other])).toBeUndefined();
      expect(batchReach([other, insertText(4, "x")])).toEqual({ from: 4, to: 4, behind: [] });
      // An empty styled range names its start.
      expect(batchReach([bold(5, 5)])).toEqual({ from: 5, to: 5, behind: [] });
    });

    it.each<[string, GoogleDocsRequest[], ReturnType<typeof batchReach>]>([
      ["a row added with text", [
        insertRow(8, 1, true), insertText(64, "new"), insertText(62, "row"), bold(64, 67), bold(62, 65),
      ], { from: 8, to: 8, behind: [] }],
      ["a growing replacement", [
        deleteRange(1, 2), insertText(1, "x".repeat(37)), bold(1, 38),
      ], { from: 1, to: 2, behind: [] }],
      ["an append", [
        insertText(66, "\nappended"), deleteBullets(67, 75),
        styleParagraphs(67, 75, { namedStyleType: "NORMAL_TEXT" }, "namedStyleType"), bold(67, 75),
      ], { from: 66, to: 66, behind: [] }],
      ["a table inserted and filled", [
        insertTable(20, 2, 2), insertText(31, "d"), insertText(29, "c"), insertText(26, "b"),
        insertText(24, "a"),
      ], { from: 20, to: 20, behind: [] }],
      // The bulleted range starts at the lowest index a length changed at, so it counts.
      ["a replacement that makes list items", [
        deleteRange(1, 7), insertText(1, "one\ntwo"),
        styleParagraphs(5, 9, { namedStyleType: "NORMAL_TEXT" }, "namedStyleType"), bold(1, 8),
        bullets(1, 9, BULLETED),
      ], { from: 1, to: 7, behind: [1] }],
      ["bullets after an insertion below them", [
        insertText(0, "x"), bullets(1, 9, BULLETED),
      ], { from: 0, to: 0, behind: [] }],
      ["a batch written from the back to the front", [
        deleteRange(100, 110), insertText(100, "late"), deleteRange(50, 55), insertText(50, "early"),
      ], { from: 50, to: 110, behind: [] }],
      // The floor is the lowest index a length changed at, not the last.
      ["a range between two insertions", [
        insertText(80, "x"), insertText(50, "y"), bold(60, 61),
      ], { from: 50, to: 80, behind: [] }],
    ])("counts no index an earlier request can have moved: %s", (_, batch, reach) => {
      expect(batchReach(batch)).toEqual(reach);
    });

    it.each(FAMILY_KINDS)("counts a range above %s only where the kind changes no length", kind => {
      let first = requestOf(kind, 20, { end: 24 });
      let own = batchReach([first])!;

      expect(batchReach([first, bold(40, 44)]))
        .toEqual(LENGTHENS.includes(kind) ? own : { ...own, to: 43 });
    });

    it("counts an index below a bulleted range that the tabs taken off may have moved", () => {
      // The one guess: a bulleted range that starts inside its paragraph takes the leading
      // tabs off from the paragraph's start, below the range's own, which is its floor.
      let tab = buildTab([para("eight ch"), { runs: ["\t\tsevenxx\n"] }, para("end")]);
      let batch = [bullets(14, 15, BULLETED), insertText(12, "x")];
      expect([tab.body.content[2].startIndex, tab.body.content[2].endIndex]).toEqual([10, 20]);

      expect(batchReach(batch)).toEqual({ from: 12, to: 14, behind: [14] });
      // The guard keeps the outcome the whole tab's from every stretch.
      expect("tab" in wholeOutcome(tab, batch, {})).toBe(true);
      expect(expectEverySlice(tab, batch, {}, () => "the guess").ran).toBe(10);
    });

    it("names no element the recorded batches do not touch", () => {
      let steps = 0;
      let elements = 0;
      let widened: string[] = [];
      for (let { where, tab, requests } of recordedBatches()) {
        let reach = batchReach(requests);
        if (!reach) continue;
        steps++;
        // The elements from the lowest index named to the highest, and the one behind a bulleted range.
        let from = elementHolding(tab, reach.from);
        let to = elementHolding(tab, reach.to) + 1;
        let origin = ingestedTab(tab).body.content[from].startIndex;
        if (from > 0 && reach.behind.includes(origin)) from--;
        elements += to - from;
        if (widenedFrom(tab, requests, from, to) > 0) widened.push(where);
      }

      // The builders' own batches, held to the rule a caller chooses its first slice by: no
      // step widens, and the steps read 287 elements between them.
      expect(widened).toEqual([]);
      expect([steps, elements]).toEqual([209, 287]);
    });
  });

  describe("the slice is the draft", () => {

    it("changes the slice in place, copies no tab and re-indexes only what moved", () => {
      let tab = noted();
      let second = tab.body.content[3];
      let slice = sliceOf(tab, 3, 4, "model");
      let { content } = slice;
      let clones = replayCost.tabClones;
      let cost: ModelCost = { fullReindexes: 0 };

      applyDocsRequestsToSlice(slice, [styleText(second.startIndex, second.startIndex + 4, { bold: true }, "bold")], {}, cost);
      expect(cost.fullReindexes).toBe(0);
      applyDocsRequestsToSlice(slice, [insertText(second.startIndex, "xy")], {}, cost);
      expect(cost.fullReindexes).toBe(1);

      expect(slice.content).toBe(content);
      expect(content[0].paragraph?.elements[0].textRun).toEqual({ content: "xybeta", textStyle: { bold: true } });
      expect(content[0].endIndex).toBe(second.endIndex + 2);
      expect(replayCost.tabClones).toBe(clones);
    });

    it("leaves a slice part-changed by a batch that throws", () => {
      let tab = noted();
      let second = tab.body.content[3];
      let slice = sliceOf(tab, 3, 4, "model");
      let given = throughJson(slice.content);

      // Not relied on: a caller discards the slice of a batch that throws.
      expect(() => applyDocsRequestsToSlice(
        slice, [insertText(second.startIndex, "xy"), deleteRange(0, 0)])).toThrow("The range should not be empty");
      expect(slice.content).not.toEqual(given);
    });

    it("says what a batch leaves for the rest of the tab", () => {
      let tab = noted();
      let [, , , second, third, table] = tab.body.content;
      let first = second.paragraph!.elements[1];
      let answers = (from: number, to: number, batch: GoogleDocsRequest[]) => {
        let slice = sliceOf(tab, from, to, "model");
        let made = applyDocsRequestsToSlice(slice, batch);
        // How far the slice's end moved is how far the whole tab's does.
        expect(made.moved).toBe(wholeMoved(tab, batch));
        return { made, slice };
      };

      // A reference of the stretch removed: the one left says its place, counted from the
      // one reference before the stretch.
      let removed = answers(3, 4, [deleteRange(first.startIndex, first.endIndex)]);
      expect(removed.made).toEqual({ moved: -1, footnotesMoved: true, lists: [] });
      expect(removed.slice.content[0].paragraph?.elements.flatMap(element =>
        element.footnoteReference ? [element.footnoteReference.footnoteNumber] : [])).toEqual(["2"]);
      // The flag is set by every request that can remove or move a reference, whatever it did.
      expect(answers(3, 4, [deleteRange(second.startIndex, second.startIndex + 1)]).made)
        .toEqual({ moved: -1, footnotesMoved: true, lists: [] });
      expect(answers(3, 4, [insertText(second.startIndex, "fives")]).made)
        .toEqual({ moved: 5, footnotesMoved: false, lists: [] });
      expect(answers(3, 4, [styleText(second.startIndex, second.startIndex + 2, { bold: true }, "bold")]).made)
        .toEqual({ moved: 0, footnotesMoved: false, lists: [] });

      // A table alone in its stretch.
      for (let batch of [
        [deleteRow(table.startIndex, 1)], [deleteColumn(table.startIndex, 1)],
        [mergeCells(table.startIndex, 0, 0, 2, 1)],
      ]) {
        let { made } = answers(5, 6, batch);
        expect(made).toEqual({ moved: wholeMoved(tab, batch), footnotesMoved: true, lists: [] });
        expect(made.moved).not.toBe(0);
      }

      // Two lists made, in the order they were made; the tab taken off the second moves the end.
      let bulleted = answers(2, 5, [
        bullets(second.startIndex, second.endIndex, BULLETED),
        bullets(third.startIndex, third.endIndex, NUMBERED),
      ]);
      expect(bulleted.made).toEqual({ moved: -1, footnotesMoved: false, lists: ["model.1", "model.2"] });
      expect(Object.keys(bulleted.slice.lists)).toEqual(["model.1", "model.2"]);
    });
  });

  // The chains of edits the path through runs is held to, on the same tabs, seeds and draws:
  // an append, or a replacement of a label, each made in the tab the one before gave.
  it.each([
    ["paragraphs with footnotes", 20261117],
    ["protected content", 20261118],
    ["tables between lists", 20261119],
  ] as const)("batches the builders make, from every slice: a chain of ten edits in %s", (name, seed) => {
    let { below, pick } = diceOf(seed);
    let tab = pruneTab(throughJson(largeTabs(20).find(large => large.name === name)!.tab));
    let held = 0;
    for (let turn = 0; turn < 10; turn++) {
      let view = docTabToMarkdown(tab);
      let labels = view.markdown.match(/[A-Z][a-z]+ (?:[A-Z][a-z]+ )?\d{5}\./g) ?? [];
      let requests = builtBatch(tab, below(4) === 0 || labels.length === 0
        ? { name: "append", append: `Appended ${turn}.` }
        : { name: "replace", replace: [pick(labels), `Changed ${turn}.`] });
      if (!requests) continue;
      let { length } = tab.body.content;
      expectEverySlice(tab, requests, {}, () => `${name}, edit ${turn + 1}`, "model",
        length <= 12 ? undefined : sampledSlices(length, seed + turn, 12));
      let made = wholeOutcome(tab, requests, {});
      if ("refused" in made) continue;
      tab = made.tab;
      held++;
    }
    expect(held).toBeGreaterThanOrEqual(7);
  });

  // The file's tests run in order: this one reads what the recordings' tests counted.
  it("ran every recorded step, from stretches that hold nothing its batch names too", () => {
    expect([corpus.fixtures, corpus.steps]).toEqual([35, 209]);
    expect(corpus.built).toBeGreaterThanOrEqual(150);
    expect(corpus.nothing / corpus.stretches).toBeGreaterThan(1 / 3);
  });
});
