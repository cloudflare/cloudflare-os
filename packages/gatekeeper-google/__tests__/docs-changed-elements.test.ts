// What a tab's pending edits change of it, element by element, and that only the runs that
// differ are decoded to find it.

import { createSimulationStore } from "@gadgets/gatekeeper-kit/simulation-store";
import { describe, expect, it } from "vitest";
import type { StructuralElement } from "../src/docs-api";
import { changedElements, changedLists, type ChangedElements } from "../src/docs-changed-elements";
import { docTabReducer, type DocEdit, type QueuedDocRecord } from "../src/docs-replay";
import { docStoreCost, type DocStore, type DocVersion } from "../src/docs-store";
import { prepareTableChange, type TableCall } from "../src/docs-table-actions";
import { MARKDOWN_RENDERING_VERSION } from "../src/markdown-converter";
import { buildTab, grid, item, para, presetLevels, seeded } from "./doc-fixture";
import { fakeDocStorage } from "./doc-store-fake";
import { keptUnder, linesWithTablesTab, RUNS_OF_THREE } from "./doc-store-scenarios";

const TAB = "tab-1";
const lines = (label: string, count: number) =>
  Array.from({ length: count }, (_, at) => para(`${label} ${String(at).padStart(2, "0")}`));

// Cut to runs of three elements at most, a table a run of its own: 22 runs.
const BLOCKS = [
  ...lines("Line", 12),
  grid(["alpha", "beta"], ["gamma", "delta"]),
  ...lines("Mid", 6),
  item("One", "N1"), item("Two", "N1"), item("Three", "N1"),
  ...lines("Gap", 6),
  item("Four", "N1"), item("Five", "N1"), item("Six", "N1"),
  ...lines("Tail", 6),
];
const LISTS = { N1: { listProperties: { nestingLevels: presetLevels(true) } } };

/** A paragraph's text, or a table's as its rows of cells. */
const text = (element: StructuralElement): unknown => element.table
  ? (element.table.tableRows ?? []).map(row =>
    (row.tableCells ?? []).map(cell => (cell.content ?? []).map(text).join("")))
  : (element.paragraph?.elements ?? []).map(part => part.textRun?.content ?? "").join("");

function scenario() {
  let { storage, store, base } = keptUnder(fakeDocStorage(), buildTab(BLOCKS, LISTS), "changed", RUNS_OF_THREE);
  let saved = store.tab(base).body.content;
  let runs = (version: DocVersion) => storage.sql.exec<{ runs: number }>(
    "SELECT COUNT(*) AS runs FROM doc_seq WHERE version = ?", version.id).one().runs;
  return {
    store, base, runs,
    /** The saved element that reads `content`: its range. */
    at(content: string) {
      let { startIndex = 0, endIndex } = saved.find(element => text(element) === content)!;
      return { start: startIndex, end: endIndex };
    },
    table: saved.find(element => element.table)!,
  };
}

const queued = (id: number, edit: DocEdit): QueuedDocRecord =>
  ({ id, action: { ...edit, tabId: TAB, markdownVersion: MARKDOWN_RENDERING_VERSION } });
const replace = (oldMarkdown: string, newMarkdown: string, inTable?: true): DocEdit =>
  ({ type: "replaceText", oldMarkdown, newMarkdown, ...(inTable ? { inTable } : {}) });

/** `base` with `edits` applied in order, none refused. */
function pendingOf(store: DocStore, base: DocVersion, ...edits: DocEdit[]): DocVersion {
  let { entity, refused } = createSimulationStore(docTabReducer(store))
    .fold(TAB, base, edits.map((edit, id) => queued(id, edit)));
  expect(refused.map(({ refusal }) => refusal.reason)).toEqual([]);
  return entity!;
}

/** An element without its indexes. */
const unplaced = (element: StructuralElement): unknown => JSON.parse(JSON.stringify(
  element, (key, value) => key === "startIndex" || key === "endIndex" ? undefined : value));

/** `saved` with each change's elements in place of the range it names. */
function patched(saved: readonly StructuralElement[], found: readonly ChangedElements[]): StructuralElement[] {
  let out: StructuralElement[] = [], at = 0;
  let passed = (index: number) => at < saved.length && (saved[at].startIndex ?? 0) < index;
  for (let { start, end, elements } of found) {
    while (passed(start)) out.push(saved[at++]);
    while (passed(end)) at++;
    out.push(...elements);
  }
  return [...out, ...saved.slice(at)];
}

/**
 * The changes between two versions, their elements as text, and how many runs finding them
 * decoded. The saved tab with the changes made in it is the pending tab, whatever they are.
 */
function changes(store: DocStore, saved: DocVersion | undefined, pending: DocVersion) {
  let before = docStoreCost.runsDecoded;
  let found = changedElements(store, saved, pending);
  let decoded = docStoreCost.runsDecoded - before;
  let was = saved ? store.tab(saved).body.content : [];
  expect(patched(was, found).map(unplaced)).toEqual(store.tab(pending).body.content.map(unplaced));
  for (let { start, end } of found) expect(start).toBeLessThanOrEqual(end);
  return {
    decoded,
    found: found.map(({ start, end, elements }) => ({ start, end, elements: elements.map(text) })),
    elements: found.map(({ elements }) => elements),
  };
}

describe("the elements a tab's pending edits change", () => {
  it("names one replaced paragraph, and decodes its run alone in each version", () => {
    let { store, base, at, runs } = scenario();
    let pending = pendingOf(store, base, replace("Line 04", "Line four"));

    let { found, decoded } = changes(store, base, pending);

    expect(found).toEqual([{ ...at("Line 04\n"), elements: ["Line four\n"] }]);
    expect(runs(base)).toBe(22);
    expect(decoded).toBe(2);
  });

  it("names two edits far apart as two changes, with nothing between them decoded", () => {
    let { store, base, at } = scenario();
    let pending = pendingOf(store, base, replace("Line 01", "First"), replace("Tail 04", "Last"));

    let { found, decoded } = changes(store, base, pending);

    expect(found).toEqual([
      { ...at("Line 01\n"), elements: ["First\n"] },
      { ...at("Tail 04\n"), elements: ["Last\n"] },
    ]);
    expect(decoded).toBe(4);
  });

  it("names text appended as elements added where the tab ended", () => {
    let { store, base } = scenario();
    let pending = pendingOf(store, base, { type: "appendText", markdown: "Appended." });

    let { found, decoded, elements } = changes(store, base, pending);

    expect(found).toEqual([{ start: base.bodyEndIndex, end: base.bodyEndIndex, elements: ["Appended.\n"] }]);
    // The elements carry the indexes they have in the pending tab.
    expect(elements[0][0]).toMatchObject({ startIndex: base.bodyEndIndex, endIndex: pending.bodyEndIndex });
    // The saved tab's last run stands in the pending tab as it was: only the new run is read.
    expect(decoded).toBe(1);
  });

  it("names a paragraph added between two as an empty range where it stands", () => {
    let { store, base, at } = scenario();
    let pending = pendingOf(store, base, replace("Mid 02", "Mid 02\n\nInserted"));

    let { found } = changes(store, base, pending);

    let { end } = at("Mid 02\n");
    expect(found).toEqual([{ start: end, end, elements: ["Inserted\n"] }]);
  });

  it("names a paragraph removed as its range and no element", () => {
    let { store, base, at } = scenario();
    let pending = pendingOf(store, base, replace("Mid 03\n\nMid 04", "Mid 04"));

    let { found } = changes(store, base, pending);

    expect(found).toEqual([{ ...at("Mid 03\n"), elements: [] }]);
  });

  it("names a table with rows added, or a cell rewritten, as the whole table", () => {
    let { store, base, table } = scenario();
    let call: TableCall = { method: "insertTableRows", lines: { table: 0, at: 1, cells: [["new", "row"]] } };
    let rows = pendingOf(store, base, prepareTableChange(store, base, call, "the tab").change);
    let cell = pendingOf(store, base, replace("gamma", "GAMMA", true));
    let range = { start: table.startIndex, end: table.endIndex };

    expect(changes(store, base, rows)).toMatchObject({
      found: [{ ...range, elements: [[["alpha\n", "beta\n"], ["new\n", "row\n"], ["gamma\n", "delta\n"]]] }],
      decoded: 2,
    });
    expect(changes(store, base, cell)).toMatchObject({
      found: [{ ...range, elements: [[["alpha\n", "beta\n"], ["GAMMA\n", "delta\n"]]] }],
      decoded: 2,
    });
  });

  it("leaves out the items of a list an edit renumbers and does not change", () => {
    let { store, base, at } = scenario();
    let pending = pendingOf(store, base, replace("1. Three", "1. Three\n1. Extra"));

    let { found, decoded } = changes(store, base, pending);

    expect(store.markdown(base)).toContain("4. Four");
    expect(store.markdown(pending)).toContain("5. Four");
    let { end } = at("Three\n");
    expect(found).toEqual([{ start: end, end, elements: ["Extra\n"] }]);
    // The new item is a run of the pending tab alone. The run of the later items is renumbered
    // there and holds what it held: it is passed by its name, as every other run is.
    expect(decoded).toBe(1);
  });

  it("names the lists edits make, as the pending tab defines them, and none an edit only adds an item to", () => {
    let { store, base } = scenario();
    let lists = (saved: DocVersion | undefined, pending: DocVersion) =>
      changedLists(store, saved, pending, changedElements(store, saved, pending));
    let levels = (found: ReturnType<typeof lists>) =>
      Object.values(found).map(list => list.listProperties?.nestingLevels?.[0]);

    expect(lists(base, pendingOf(store, base, replace("1. Three", "1. Three\n1. Extra")))).toEqual({});
    let made = lists(base, pendingOf(store, base,
      replace("Mid 02", "Mid 02\n\n1. First"), replace("Tail 02", "Tail 02\n\n- Dot")));
    expect(levels(made)).toMatchObject([{ glyphType: "DECIMAL" }, { glyphSymbol: "●" }]);
    expect(Object.keys(made)).not.toContain("N1");
    // A tab with no saved version makes every list it names.
    expect(lists(undefined, base)).toEqual(LISTS);
  });

  it("names text an edit added and a later edit rewrote as it reads at last", () => {
    let { store, base, at } = scenario();
    let pending = pendingOf(store, base, replace("Line 04", "Line four"), replace("Line four", "Line 4!"));

    expect(changes(store, base, pending).found).toEqual([{ ...at("Line 04\n"), elements: ["Line 4!\n"] }]);
  });

  it("names every element of a tab with no saved version, and nothing between equal versions", () => {
    let { store, base } = scenario();

    expect(changes(store, base, base)).toMatchObject({ found: [], decoded: 0 });
    let { found } = changes(store, undefined, base);
    expect(found).toMatchObject([{ start: 0, end: 0 }]);
    expect(found[0].elements).toHaveLength(BLOCKS.length + 1);
  });

  it("passes the runs of a long tab by their place, and decodes those of its edits alone", () => {
    let long = Array.from({ length: 20_000 }, (_, at) => `Line ${String(at).padStart(5, "0")}.`);
    let { storage, store, base } = keptUnder(fakeDocStorage(), linesWithTablesTab(TAB, long, [10_000]), "long");
    let pending = pendingOf(store, base,
      replace(long[7], "First."), replace("cell 0", "Cell.", true), replace(long[19_999], "Last."));

    let { found, decoded } = changes(store, base, pending);

    expect(found.map(({ elements }) => elements)).toEqual([["First.\n"], [[["Cell.\n"]]], ["Last.\n"]]);
    let { runs } = storage.sql.exec<{ runs: number }>(
      "SELECT COUNT(*) AS runs FROM doc_seq WHERE version = ?", base.id).one();
    // A run of each version for each edit, and one more where an edit's run was cut in two.
    expect({ runs, decoded }).toEqual({ runs: 135, decoded: 3 * 2 + 1 });
  });

  it("names changes that make the saved tab the pending one, whichever lines are edited", () => {
    let { store, base } = scenario();
    let labels = ["Line", "Mid", "Gap", "Tail"];
    for (let seed = 1; seed <= 40; seed++) {
      let random = seeded(seed);
      let pick = <T>(of: readonly T[]) => of[Math.floor(random() * of.length)];
      let chosen = new Set(Array.from({ length: 1 + Math.floor(random() * 4) }, () =>
        `${pick(labels)} 0${Math.floor(random() * 6)}`));
      let edits = [...chosen].map(line =>
        replace(line, pick([`${line} edited`, `${line}\n\nAfter ${line}`, `Before ${line}\n\n${line}`])));

      let { found, decoded } = changes(store, base, pendingOf(store, base, ...edits));

      expect(found.length).toBeLessThanOrEqual(edits.length);
      // A run of three elements holds an edit, and a neighbour where the edit cut its run anew.
      expect(decoded).toBeLessThanOrEqual(edits.length * 5);
    }
  });
});
