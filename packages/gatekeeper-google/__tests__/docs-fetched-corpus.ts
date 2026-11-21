// The documents the tests of a fetched Google Doc share: the recordings' tabs, the generators'
// tabs, tabs that hold write markers and fields the copy does not keep, and what builds them.

import type { GoogleDocsDocument, GoogleDocsTab, StructuralElement } from "../src/docs-api";
import type { DocWriteMarkerCopy } from "../src/docs-replica";
import { RUN_SIZES } from "../src/docs-runs";
import type { RunSizes } from "../src/docs-runs";
import { buildTab, grid, para } from "./doc-fixture";
import type { BlockSpec } from "./doc-fixture";
import { readFixtures } from "./docs-live-fixtures";
import { fuzzedTabs, largeTabs, throughJson } from "./render-run-tabs";

/** Sizes that force runs of one element: the harshest cut. */
export const FORCED: RunSizes = { least: 1, target: 2, most: 4_096, elements: 1 };

/** The two cuts the walk is compared under. */
export const CUTS: { cut: string; sizes: RunSizes }[] = [
  { cut: "about 32 KiB a run", sizes: RUN_SIZES },
  { cut: "one element a run", sizes: FORCED },
];

/** A document of copies of `tabs`, which a walk may empty. */
export function documentOf(tabs: readonly GoogleDocsTab[], revision?: string): GoogleDocsDocument {
  return {
    documentId: "document-1",
    title: "A document",
    ...(revision === undefined ? {} : { revisionId: revision }),
    tabs: tabs.map(throughJson),
  };
}

/** `tabs`, each under an id and a place of its own, as the tabs of one document have. */
export function distinctTabs(tabs: readonly GoogleDocsTab[]): GoogleDocsTab[] {
  return tabs.map((tab, index) => ({ ...tab, tabId: `tab-${index + 1}`, index }));
}

/** The write markers of `tab`, read by hand: each pair once, in the order Google listed them. */
export function writeMarkersOf(tab: GoogleDocsTab): DocWriteMarkerCopy[] {
  let markers: DocWriteMarkerCopy[] = [];
  for (let [key, { namedRanges }] of Object.entries(tab.namedRanges)) {
    for (let { namedRangeId, name = key } of namedRanges) {
      if (!name.startsWith("gadgets-write-")) continue;
      let writeId = name.slice("gadgets-write-".length);
      if (!markers.some(marker => marker.writeId === writeId && marker.id === namedRangeId)) {
        markers.push({ writeId, id: namedRangeId });
      }
    }
  }
  return markers;
}

/** The paragraph a tab of lines holds at `at`: its text names its place. */
export const line = (at: number) =>
  para(`Line ${String(at).padStart(5, "0")}: ${"what a paragraph of a document says. ".repeat(4)}`);

/** A tab of `paragraphs` paragraphs, each with its own number, and a table at each of `tables`. */
export function linesTab(paragraphs: number, tables: readonly number[] = []): GoogleDocsTab {
  let blocks: BlockSpec[] = Array.from({ length: paragraphs }, (_, at) => line(at));
  for (let at of tables.toSorted((left, right) => right - left)) {
    blocks.splice(at, 0, grid(["a", "b"], ["c", "d"]));
  }
  return {
    ...buildTab(blocks),
    namedStyles: { styles: [{ namedStyleType: "SUBTITLE", textStyle: { italic: true } }] },
    namedRanges: { kept: { namedRanges: [{ namedRangeId: "range-1", name: "kept" }] } },
  };
}

/** `tab` with fields the copy does not keep: in the tab, its paragraphs, its lists and named styles. */
export function withUnkeptFields(tab: GoogleDocsTab): GoogleDocsTab {
  let copy: GoogleDocsTab & { documentStyle?: unknown } = throughJson(tab);
  copy.documentStyle = { pageSize: { height: { magnitude: 792, unit: "PT" } } };
  let level = {
    glyphType: "DECIMAL",
    startNumber: 1,
    bulletAlignment: "START",
    indentStart: { magnitude: 36, unit: "PT" },
    textStyle: { underline: false },
  };
  Object.assign(copy.lists, {
    "list-levels": { listProperties: { nestingLevels: [level] }, suggestedInsertionId: "s" },
    "list-bare": {},
  });
  let title = {
    namedStyleType: "TITLE",
    textStyle: { bold: true, fontSize: { magnitude: 26, unit: "PT" } },
    paragraphStyle: { namedStyleType: "TITLE", spaceBelow: { magnitude: 3, unit: "PT" } },
  };
  copy.namedStyles = { styles: [...copy.namedStyles?.styles ?? [], title] };
  for (let element of copy.body.content) {
    let { paragraph }: { paragraph?: { paragraphStyle: object; elements: object[] } } = element;
    if (!paragraph) continue;
    Object.assign(paragraph.paragraphStyle, { direction: "LEFT_TO_RIGHT", lineSpacing: 115 });
    for (let part of paragraph.elements) Object.assign(part, { suggestedInsertionIds: ["s"] });
  }
  return copy;
}

/** A document's tabs under the name a failure reports. */
export type NamedTabs = { name: string; tabs: GoogleDocsTab[] };

export const RECORDED: NamedTabs[] = readFixtures().map(({ name, before, steps }) =>
  ({ name: `the recording ${name}`, tabs: distinctTabs([before, ...steps.map(step => step.after)]) }));

export const LARGE: NamedTabs[] = largeTabs(20).map(({ name, tab }) => ({ name, tabs: [tab] }));

export const FUZZED: NamedTabs[] = Array.from({ length: 40 }, (_, document) => ({
  name: `generated tabs ${document * 5 + 1} to ${document * 5 + 5}`,
  tabs: distinctTabs(
    fuzzedTabs(11, 200).slice(document * 5, document * 5 + 5).map(({ tab }) => tab)),
}));

export const MARKED: NamedTabs = {
  name: "tabs that hold write markers and other named ranges",
  tabs: distinctTabs([
    {
      ...withUnkeptFields(linesTab(40, [7])),
      namedRanges: {
        "gadgets-write-w1": {
          namedRanges: [
            { namedRangeId: "marker-1", name: "gadgets-write-w1" },
            { namedRangeId: "marker-2", name: "gadgets-write-w1" },
            { namedRangeId: "marker-1", name: "gadgets-write-w1" },
          ],
        },
        bookmark: { namedRanges: [{ namedRangeId: "range-1", name: "bookmark" }] },
        // A range with no name of its own goes by its collection's.
        "gadgets-write-w2": { namedRanges: [{ namedRangeId: "marker-3" }] },
      },
    },
    withUnkeptFields(linesTab(3)),
    { ...linesTab(12), namedRanges: { "gadgets-write-w3": { namedRanges: [{ namedRangeId: "marker-4" }] } } },
  ]),
};

/** Weak references to each body element and each tab's parts, made here so no caller variable pins them. */
export function weakRefs(document: GoogleDocsDocument): {
  elements: WeakRef<StructuralElement>[][];
  tabs: WeakRef<object>[][];
} {
  return {
    elements: document.tabs.map(tab => tab.body.content.map(element => new WeakRef(element))),
    tabs: document.tabs.map(tab => [tab, tab.lists, tab.namedRanges, tab.namedStyles!]
      .map(part => new WeakRef<object>(part))),
  };
}
