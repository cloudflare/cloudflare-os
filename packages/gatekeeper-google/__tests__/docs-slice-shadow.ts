// The model on a slice of a tab, held to the model on the whole tab: helpers that cut a stretch
// of a tab's elements, apply a batch to it, widen it and compare the tab put back together. The
// model's entry is a parameter, so a model built from its source with a guard changed runs too.

import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript6";
import { beforeAll, describe, expect, it } from "vitest";
import type { GoogleDocsRequest, GoogleDocsTab, StructuralElement } from "../src/docs-api";
import * as docsContent from "../src/docs-content";
import {
  applyDocsRequests, applyDocsRequestsToSlice, batchReach, MODEL_LIST_ID,
} from "../src/docs-model";
import type { ModelOptions, ModelTextStyle, SliceResult, TabSlice } from "../src/docs-model";
import { buildTab, diceOf, presetLevels } from "./doc-fixture";
import type { BlockSpec, Dice, TableSpec } from "./doc-fixture";
import {
  at, BULLETED, bullets, cellAt, deleteBullets, deleteColumn, deleteRange, deleteRow, insertTable,
  insertText, LINK_A, mergeCells, NUMBERED, points, recordedSequenceCalls, styleParagraphs,
  styleText, unmergeCells,
} from "./docs-model-draws";
import type { RecordedCall } from "./docs-model-draws";
import { throughJson } from "./render-run-tabs";
import { WIDER } from "./wider-run";

/** The model's entry for a slice, or that of a model built from the source text. */
export type SliceApply = typeof applyDocsRequestsToSlice;

/** Which lists a slice is handed: `model`, as a store hands them, or `all` of the tab's. */
export type ListsHanded = "model" | "all";

/** Stretches of a tab's top-level elements, each `[from, to)`. */
export type Stretches = readonly (readonly [from: number, to: number])[];

/** How a batch was refused: the error's name and its message. */
export type Refusal = { name: string; message: string };

/** What a batch gives: the tab, or the refusal. */
export type Outcome = { tab: GoogleDocsTab } | { refused: Refusal };

/** What a tab is cut and put back together from, worked out once a tab. */
type Frame = {
  /** The tab as ingest leaves it, decoded from JSON. */
  tab: GoogleDocsTab;
  /** Each top-level element as JSON text. */
  texts: string[];
  ends: number[];
  /** How many footnote references the tab holds before each element, and in all. */
  footnotesBefore: number[];
  /** The ids of the lists each element's paragraphs name, cells included. */
  named: string[][];
  /** The tab's lists as JSON text. */
  lists: string;
  /** The elements with their indexes and footnote numbers moved, by how far each moved. */
  shifted: Map<string, (string | undefined)[]>;
};

const frames = new WeakMap<GoogleDocsTab, Frame>();

/** Every paragraph of `content`, those of table cells included, in document order. */
function* paragraphsOf(content: readonly StructuralElement[]): Generator<
  NonNullable<StructuralElement["paragraph"]>
> {
  for (let element of content) {
    if (element.paragraph) yield element.paragraph;
    for (let row of element.table?.tableRows ?? []) {
      for (let cell of row.tableCells ?? []) yield* paragraphsOf(cell.content ?? []);
    }
  }
}

/** How many footnote references `content` holds, those of cells included. */
function footnotesIn(content: readonly StructuralElement[]): number {
  let count = 0;
  for (let { elements } of paragraphsOf(content)) {
    for (let element of elements) if (element.footnoteReference) count++;
  }
  return count;
}

/** `tab` as ingest leaves it, decoded from JSON; `numbered` numbers its footnotes by place. */
export function asIngested(tab: GoogleDocsTab, numbered = false): GoogleDocsTab {
  let ingested = throughJson(applyDocsRequests(tab, []));
  if (numbered) {
    let place = 0;
    for (let { elements } of paragraphsOf(ingested.body.content)) {
      for (let { footnoteReference } of elements) {
        if (footnoteReference) footnoteReference.footnoteNumber = String(++place);
      }
    }
  }
  return ingested;
}

/** The frame of `tab`: made once for a tab handed in, and for the tab it is ingested as. */
function frameOf(tab: GoogleDocsTab): Frame {
  let known = frames.get(tab);
  if (known) return known;
  let ingested = asIngested(tab);
  let { content } = ingested.body;
  let footnotesBefore = [0];
  for (let element of content) footnotesBefore.push(footnotesBefore.at(-1)! + footnotesIn([element]));
  let frame: Frame = {
    tab: ingested,
    texts: content.map(element => JSON.stringify(element)),
    ends: content.map(element => element.endIndex),
    footnotesBefore,
    named: content.map(element => [...new Set([...paragraphsOf([element])]
      .flatMap(paragraph => paragraph.bullet ? [paragraph.bullet.listId] : []))]),
    lists: JSON.stringify(ingested.lists),
    shifted: new Map(),
  };
  frames.set(tab, frame);
  frames.set(ingested, frame);
  return frame;
}

/** `tab` as the helpers here take it: as ingest leaves it, the same object at every call. */
export function ingestedTab(tab: GoogleDocsTab): GoogleDocsTab {
  return frameOf(tab).tab;
}

/** The position of the element of the tab that holds `index`: its last where none does. */
export function elementHolding(tab: GoogleDocsTab, index: number): number {
  let { ends } = frameOf(tab);
  let position = ends.findIndex(end => end > index);
  return position === -1 ? ends.length - 1 : position;
}

/** A fresh `TabSlice` of the elements `[from, to)` of `tab`, decoded from JSON as a stored run is. */
export function sliceOf(tab: GoogleDocsTab, from: number, to: number, lists: ListsHanded): TabSlice {
  let frame = frameOf(tab);
  let whole = frame.tab;
  if (from < 0 || from >= to || to > frame.texts.length) {
    throw new Error(`no stretch [${from}, ${to}) of ${frame.texts.length} elements`);
  }
  let handed: GoogleDocsTab["lists"] = {};
  if (lists === "all") handed = JSON.parse(frame.lists) as GoogleDocsTab["lists"];
  else {
    for (let id of Object.keys(whole.lists)) {
      if (id.startsWith(MODEL_LIST_ID)) handed[id] = {} as GoogleDocsTab["lists"][string];
    }
    for (let id of new Set(frame.named.slice(from, to).flat())) {
      if (Object.hasOwn(whole.lists, id)) handed[id] = throughJson(whole.lists[id]);
    }
  }
  return {
    tabId: whole.tabId,
    lists: handed,
    ...(whole.namedStyles ? { namedStyles: throughJson(whole.namedStyles) } : {}),
    content: JSON.parse(`[${frame.texts.slice(from, to).join(",")}]`) as StructuralElement[],
    origin: from === 0 ? 0 : frame.ends[from - 1],
    first: from === 0,
    last: to === frame.texts.length,
    footnotesBefore: frame.footnotesBefore[from],
  };
}

/** Whether `thrown` is a slice edge, by what it holds: a model built from source has its own class. */
export function isSliceEdge(
  thrown: unknown,
): thrown is { name: "SliceEdgeError"; side: "before" | "after"; index: number } {
  if (typeof thrown !== "object" || thrown === null) return false;
  let { name, side, index } = thrown as { name?: unknown; side?: unknown; index?: unknown };
  return name === "SliceEdgeError" && (side === "before" || side === "after") &&
    typeof index === "number";
}

/** The refusal `thrown` is. Anything thrown that is no `Error` is thrown on. */
function refusalOf(thrown: unknown): Refusal {
  if (!(thrown instanceof Error)) throw thrown;
  return { name: thrown.name, message: thrown.message };
}

/** Move every index under `value` by `moved` and every whole footnote number by `notes`. */
function shift(value: unknown, moved: number, notes: number): void {
  if (Array.isArray(value)) {
    for (let held of value) shift(held, moved, notes);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  let part = value as Record<string, unknown>;
  if (typeof part.startIndex === "number") part.startIndex += moved;
  if (typeof part.endIndex === "number") part.endIndex += moved;
  let reference = part.footnoteReference as { footnoteNumber?: string } | undefined;
  if (reference?.footnoteNumber !== undefined && /^\d+$/.test(reference.footnoteNumber)) {
    reference.footnoteNumber = String(Number(reference.footnoteNumber) + notes);
  }
  for (let held of Object.values(part)) shift(held, moved, notes);
}

/** The text of the element at `position` with its indexes and footnote numbers moved. */
function shiftedText(frame: Frame, position: number, moved: number, notes: number): string {
  if (moved === 0 && notes === 0) return frame.texts[position];
  let key = `${moved},${notes}`;
  let texts = frame.shifted.get(key);
  if (!texts) frame.shifted.set(key, texts = []);
  let text = texts[position];
  if (text === undefined) {
    let element: unknown = JSON.parse(frame.texts[position]);
    shift(element, moved, notes);
    text = texts[position] = JSON.stringify(element);
  }
  return text;
}

/** A batch applied from a stretch, as text: the body and the lists of the tab put together. */
type Applied =
  | { body: string; lists: string; widenings: number }
  | { refused: Refusal; widenings: number };

/** The widening loop on elements: on a slice edge, widened to the element that holds the index. */
function applied(
  frame: Frame, requests: readonly GoogleDocsRequest[], options: ModelOptions, from: number,
  to: number, handed: ListsHanded, apply: SliceApply,
): Applied {
  let { tab, texts } = frame;
  let widenings = 0;
  for (;;) {
    let slice = sliceOf(tab, from, to, handed);
    let made: SliceResult;
    try {
      made = apply(slice, requests, options);
    } catch (thrown) {
      if (!isSliceEdge(thrown)) return { refused: refusalOf(thrown), widenings };
      let holds = elementHolding(tab, thrown.index);
      if (thrown.side === "before") {
        if (from === 0) throw new Error("a slice edge before a stretch that opens the tab", { cause: thrown });
        from = Math.min(from - 1, holds);
      } else {
        if (to === texts.length) throw new Error("a slice edge after a stretch that ends the tab", { cause: thrown });
        to = Math.max(to + 1, holds + 1);
      }
      widenings++;
      continue;
    }
    // The references after the stretch stand as many places later as the stretch gained.
    let notes = footnotesIn(slice.content) - (frame.footnotesBefore[to] - frame.footnotesBefore[from]);
    let parts = texts.slice(0, from);
    for (let element of slice.content) parts.push(JSON.stringify(element));
    for (let position = to; position < texts.length; position++) {
      parts.push(shiftedText(frame, position, made.moved, notes));
    }
    let lists = made.lists.length === 0 ? frame.lists : JSON.stringify({
      ...tab.lists, ...Object.fromEntries(made.lists.map(id => [id, slice.lists[id]])),
    });
    return { body: `[${parts.join(",")}]`, lists, widenings };
  }
}

/** The tab of `frame` with the body and the lists a batch applied from a stretch gave. */
function tabOf(frame: Frame, made: { body: string; lists: string }): GoogleDocsTab {
  return {
    ...frame.tab,
    body: { content: JSON.parse(made.body) as StructuralElement[] },
    lists: JSON.parse(made.lists) as GoogleDocsTab["lists"],
  };
}

/**
 * `requests` applied to `tab` from the stretch `[from, to)`, widened where needed: the tab put back
 * together, or the refusal, and how many times the stretch was widened.
 */
export function appliedFrom(
  tab: GoogleDocsTab, requests: readonly GoogleDocsRequest[], options: ModelOptions, from: number,
  to: number, lists: ListsHanded, apply: SliceApply = applyDocsRequestsToSlice,
): Outcome & { widenings: number } {
  let frame = frameOf(tab);
  let made = applied(frame, requests, options, from, to, lists, apply);
  return "refused" in made ? made : { tab: tabOf(frame, made), widenings: made.widenings };
}

/** What the whole tab gives for `requests`: the tab, or the refusal. */
export function wholeOutcome(
  tab: GoogleDocsTab, requests: readonly GoogleDocsRequest[], options: ModelOptions,
): Outcome {
  try {
    return { tab: applyDocsRequests(ingestedTab(tab), requests, options) };
  } catch (thrown) {
    return { refused: refusalOf(thrown) };
  }
}

/** What the whole tab gives for a batch, with the body and the lists as text where it applies. */
type Whole = { outcome: Outcome; body?: string; lists?: string };

function wholeOf(
  frame: Frame, requests: readonly GoogleDocsRequest[], options: ModelOptions,
): Whole {
  let outcome = wholeOutcome(frame.tab, requests, options);
  return "refused" in outcome
    ? { outcome }
    : { outcome, body: JSON.stringify(outcome.tab.body.content), lists: JSON.stringify(outcome.tab.lists) };
}

/** `value` as JSON text with the keys of every object in order. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_, held: unknown) =>
    typeof held === "object" && held !== null && !Array.isArray(held)
      ? Object.fromEntries(Object.entries(held).toSorted(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
      : held);
}

/** Whether a batch applied from a stretch gave the whole tab's refusal or tab, keys in any order. */
function sameOutcome(whole: Whole, made: Applied): boolean {
  let { outcome } = whole;
  if ("refused" in outcome) {
    return "refused" in made && made.refused.name === outcome.refused.name &&
      made.refused.message === outcome.refused.message;
  }
  if ("refused" in made) return false;
  if (made.body === whole.body && made.lists === whole.lists) return true;
  return canonical(JSON.parse(made.body)) === canonical(outcome.tab.body.content) &&
    canonical(JSON.parse(made.lists)) === canonical(outcome.tab.lists);
}

/** Every stretch `[from, to)` of `length` elements. */
export function everyStretch(length: number): [from: number, to: number][] {
  let stretches: [number, number][] = [];
  for (let from = 0; from < length; from++) {
    for (let to = from + 1; to <= length; to++) stretches.push([from, to]);
  }
  return stretches;
}

/** Whether the stretch `[from, to)` holds no index the batch names (`batchReach`). */
function holdsNothing(
  frame: Frame, reach: ReturnType<typeof batchReach>, from: number, to: number,
): boolean {
  let origin = from === 0 ? 0 : frame.ends[from - 1];
  return !reach || frame.ends[to - 1] <= reach.from || origin > reach.to;
}

/** The position of the element that holds the lowest index `requests` name, if they name one. */
export function namedPosition(
  tab: GoogleDocsTab, requests: readonly GoogleDocsRequest[],
): number | undefined {
  let reach = batchReach(requests);
  return reach && elementHolding(tab, reach.from);
}

/**
 * Holds, for every stretch of `tab` (or `stretches`), that `requests` applied from it give what the
 * whole tab gives. Answers how many ran, how many held nothing the batch names, and whether it applied.
 */
export function expectEverySlice(
  tab: GoogleDocsTab, requests: readonly GoogleDocsRequest[], options: ModelOptions,
  where: () => string, lists: ListsHanded = "model", stretches?: Stretches,
): { ran: number; nothing: number; applied: boolean } {
  let frame = frameOf(tab);
  let whole = wholeOf(frame, requests, options);
  let reach = batchReach(requests);
  let ran = 0;
  let nothing = 0;
  for (let [from, to] of stretches ?? everyStretch(frame.texts.length)) {
    let made = applied(frame, requests, options, from, to, lists, applyDocsRequestsToSlice);
    if (!sameOutcome(whole, made)) {
      let got: Outcome = "refused" in made ? { refused: made.refused } : { tab: tabOf(frame, made) };
      expect(got, `${where()}, from the stretch [${from}, ${to})`).toEqual(whole.outcome);
    }
    ran++;
    if (holdsNothing(frame, reach, from, to)) nothing++;
  }
  return { ran, nothing, applied: "tab" in whole.outcome };
}

/** The walk of `expectEverySlice` with the model's entry given, counting mismatches in place of asserting. */
export function mismatchesFromEverySlice(
  tab: GoogleDocsTab, requests: readonly GoogleDocsRequest[], options: ModelOptions,
  apply: SliceApply, stretches?: Stretches,
): { ran: number; widenings: number; mismatches: { from: number; to: number }[] } {
  let frame = frameOf(tab);
  let whole = wholeOf(frame, requests, options);
  let widenings = 0;
  let mismatches: { from: number; to: number }[] = [];
  let ran = 0;
  for (let [from, to] of stretches ?? everyStretch(frame.texts.length)) {
    ran++;
    let made: Applied;
    try {
      made = applied(frame, requests, options, from, to, "model", apply);
    } catch {
      mismatches.push({ from, to });
      continue;
    }
    widenings += made.widenings;
    if (!sameOutcome(whole, made)) mismatches.push({ from, to });
  }
  return { ran, widenings, mismatches };
}

/**
 * A seeded sample of `count` stretches that holds the whole tab and, around the lowest element a
 * batch names (`named`), that element alone and a stretch wholly before and after it.
 */
export function sampledSlices(
  length: number, seed: number, count: number, named?: number,
): [from: number, to: number][] {
  let { below } = diceOf(seed);
  let stretches = new Map<string, [number, number]>();
  let add = (from: number, to: number) => stretches.set(`${from},${to}`, [from, to]);
  add(0, length);
  if (named !== undefined) {
    add(named, named + 1);
    if (named > 0) {
      let from = below(named);
      add(from, from + 1 + below(named - from));
    }
    if (named + 1 < length) {
      let from = named + 1 + below(length - named - 1);
      add(from, from + 1 + below(length - from));
    }
  }
  let all = length * (length + 1) / 2;
  while (stretches.size < Math.min(count, all)) {
    let from = below(length);
    add(from, from + 1 + below(length - from));
  }
  return [...stretches.values()];
}

// --- The tabs, their places and the families of requests

/** The look Google gives linked text, with the link. */
const LINKED: ModelTextStyle = {
  link: LINK_A, underline: true,
  foregroundColor: { color: { rgbColor: { red: 0.06666667, green: 0.33333334, blue: 0.8 } } },
};

const reference = (id: string) => ({ footnote: { id, number: "0" } });

/**
 * MIXED: list items, footnotes, a section break two indexes long and a table mid-body, and what
 * the model's short cuts read: a surrogate pair, a bold line break before a link, leading tabs.
 */
const mixed = (table: TableSpec): BlockSpec[] => [
  { runs: ["first item", reference("fn.a"), "\n"], bullet: { listId: "made" } },
  { runs: ["\u{1F600} second\n"], bullet: { listId: "made" } },
  { structure: "sectionBreak", length: 2 },
  { runs: ["plain", { text: "\n", style: { bold: true } }] },
  { runs: [{ text: "link", style: LINKED }, " words\n"] },
  table,
  { runs: ["noted", reference("fn.c"), "\n"] },
  { runs: ["\t\ttabbed\n"] },
  { runs: ["after", reference("fn.d"), "\n"] },
];

/** ENDS-IN-TABLE-THEN-PARAGRAPH: the tab's last paragraph stands directly after a table. */
const ends = (table: TableSpec): BlockSpec[] => [
  { runs: ["alpha\n"] },
  { runs: ["Heading\n"], namedStyleType: "HEADING_2" },
  { runs: ["numbered item\n"], bullet: { listId: "N1" } },
  { runs: ["two words\n"] },
  { runs: ["Owner ", { person: { name: "Ana", email: "" } }, " here\n"] },
  table,
  { runs: ["last\n"] },
];

/**
 * LISTS: the lists of two presets with nested items, a table, and after it an item of a list
 * of the model's own form and a plain paragraph.
 */
const lists = (table: TableSpec): BlockSpec[] => [
  { runs: ["b one\n"], bullet: { listId: "kix.b" } },
  { runs: ["b nested\n"], bullet: { listId: "kix.b", nestingLevel: 1 } },
  { runs: ["plain\n"] },
  { runs: ["n one\n"], bullet: { listId: "kix.n" } },
  { runs: ["n nested\n"], bullet: { listId: "kix.n", nestingLevel: 2 } },
  table,
  { runs: ["m item\n"], bullet: { listId: "model.2" } },
  { runs: ["\tend\n"] },
];

const preset = (numbered = false) => ({ listProperties: { nestingLevels: presetLevels(numbered) } });

/** The three tabs' builders, with the table each holds unless another is given. */
const TAB_SPECS = {
  "MIXED": {
    blocks: mixed, lists: { made: preset() },
    table: { table: [["a\n", { paragraphs: [{ runs: ["b", reference("fn.b"), "\n"] }] }], ["c\n", "two words\n"]] },
  },
  "ENDS-IN-TABLE-THEN-PARAGRAPH": {
    blocks: ends, lists: { N1: { listProperties: { nestingLevels: [{ glyphType: "DECIMAL" }] } } },
    table: { table: [["a\n", "b\n"], [{ paragraphs: [{ runs: ["c\n"] }, { runs: ["\ttab\n"] }] }, "d\n"]] },
  },
  "LISTS": {
    blocks: lists, lists: { "kix.b": preset(), "kix.n": preset(true), "model.2": preset() },
    table: {
      table: [
        [{ paragraphs: [{ runs: ["in cell\n"], bullet: { listId: "kix.n" } }] }, "b\n"], ["c\n", "d\n"],
      ],
    },
  },
} satisfies Record<string, {
  blocks: (table: TableSpec) => BlockSpec[]; lists: GoogleDocsTab["lists"]; table: TableSpec;
}>;

export type SliceTabName = keyof typeof TAB_SPECS;

/** The tab `name`, with `table` in place of its own where given. */
function sliceTab(name: SliceTabName, table?: TableSpec): GoogleDocsTab {
  let spec = TAB_SPECS[name];
  let tab = buildTab(spec.blocks(table ?? spec.table), throughJson(spec.lists));
  if (name === "ENDS-IN-TABLE-THEN-PARAGRAPH") {
    tab.namedStyles = {
      styles: [
        { namedStyleType: "NORMAL_TEXT", textStyle: {} },
        { namedStyleType: "HEADING_2", textStyle: { bold: true } },
      ],
    };
  }
  return ingestedTab(asIngested(tab, true));
}

/** The three tabs, of eight to ten elements, every request is run on, here and through stored runs. */
export const SLICE_TABS: Readonly<Record<SliceTabName, GoogleDocsTab>> = {
  "MIXED": sliceTab("MIXED"),
  "ENDS-IN-TABLE-THEN-PARAGRAPH": sliceTab("ENDS-IN-TABLE-THEN-PARAGRAPH"),
  "LISTS": sliceTab("LISTS"),
};

/** Where what the tests name stands in MIXED, as positions among its top-level elements. */
export const MIXED_PLACES = { pair: 2, longBreak: 3, linked: 5, table: 6, tabbed: 8 } as const;

/** Where the plain paragraph that follows an item of the bulleted preset's list stands in LISTS. */
export const LISTS_PLACES = { plain: 3 } as const;

/**
 * The places of `tab`, in order: each element's start, start + 1, an index inside it, end - 1 and
 * end; and index 0 and the body's end + 1.
 */
export function placesOf(tab: GoogleDocsTab): number[] {
  let { content } = ingestedTab(tab).body;
  let places = new Set([0, (content.at(-1)?.endIndex ?? 0) + 1]);
  for (let element of content) {
    let { startIndex: start, endIndex: end } = element;
    for (let index of [start, start + 1, end - 1, end]) places.add(index);
    if (element.paragraph) places.add(start + (end - start >> 1));
    let cells = (element.table?.tableRows ?? []).flatMap(row => row.tableCells ?? []);
    let first = cells[0]?.content?.[0];
    let last = cells.at(-1)?.content?.[0];
    if (first) places.add(first.startIndex);
    if (last) places.add(last.startIndex + 1);
  }
  return [...places].toSorted((a, b) => a - b);
}

/** The kinds of request the model takes, by what a request of the kind names. */
export const INSERTION_KINDS = ["insertText", "insertTable"] as const;
export const RANGE_KINDS = [
  "deleteContentRange", "updateTextStyle", "updateParagraphStyle", "deleteParagraphBullets",
  "createParagraphBullets",
] as const;
export const TABLE_KINDS = [
  "insertTableRow", "insertTableColumn", "deleteTableRow", "deleteTableColumn",
  "pinTableHeaderRows", "updateTableColumnProperties", "updateTableCellStyle",
  "updateTableRowStyle", "mergeTableCells", "unmergeTableCells",
] as const;

/** One of the seventeen kinds of request the model takes. */
export type FamilyKind =
  typeof INSERTION_KINDS[number] | typeof RANGE_KINDS[number] | typeof TABLE_KINDS[number];

/** Every kind, in the order the model dispatches them. */
export const FAMILY_KINDS: readonly FamilyKind[] = [...INSERTION_KINDS.slice(0, 1), ...RANGE_KINDS,
  ...INSERTION_KINDS.slice(1), ...TABLE_KINDS];

const INSERTED = ["x", "one\ntwo", "\t", "\u{1F600}"];
const TEXT_STYLES: [ModelTextStyle, string][] = [
  [{ bold: true }, "bold"], [{}, "link"], [{ link: LINK_A }, "link"], [{ italic: true }, "bold,italic"],
  [{ foregroundColor: { color: { rgbColor: { red: 1 } } } }, "foregroundColor"],
];
const PARAGRAPH_STYLES: [Record<string, unknown>, string][] = [
  [{ namedStyleType: "HEADING_2" }, "namedStyleType"],
  [{ namedStyleType: "NORMAL_TEXT" }, "namedStyleType"],
  [{ indentStart: points(0), indentFirstLine: points(0) }, "indentStart,indentFirstLine"],
];

/** One request of `kind` at `index`; `variant` chooses among a kind's texts, styles and spans. */
export function requestOf(
  kind: FamilyKind, index: number,
  { end = index + 1, row = 0, column = 0, variant = 0 }: {
    end?: number; row?: number; column?: number; variant?: number;
  } = {},
): GoogleDocsRequest {
  let cell = cellAt(index, row, column);
  switch (kind) {
    case "insertText": return insertText(index, INSERTED[variant % INSERTED.length]);
    case "insertTable": return insertTable(index, 1 + variant % 2, 1 + variant % 2);
    case "deleteContentRange": return deleteRange(index, end);
    case "updateTextStyle":
      return styleText(index, end, ...TEXT_STYLES[variant % TEXT_STYLES.length]);
    case "updateParagraphStyle":
      return styleParagraphs(index, end, ...PARAGRAPH_STYLES[variant % PARAGRAPH_STYLES.length]);
    case "deleteParagraphBullets": return deleteBullets(index, end);
    case "createParagraphBullets":
      return bullets(index, end, variant % 2 === 0 ? BULLETED : NUMBERED);
    case "insertTableRow":
      return { insertTableRow: { tableCellLocation: cell, insertBelow: variant % 2 === 0 } };
    case "insertTableColumn":
      return { insertTableColumn: { tableCellLocation: cell, insertRight: variant % 2 === 0 } };
    case "deleteTableRow": return { deleteTableRow: { tableCellLocation: cell } };
    case "deleteTableColumn": return { deleteTableColumn: { tableCellLocation: cell } };
    case "pinTableHeaderRows":
      return { pinTableHeaderRows: { tableStartLocation: at(index), pinnedHeaderRowsCount: row } };
    case "updateTableColumnProperties":
      return {
        updateTableColumnProperties: {
          tableStartLocation: at(index), columnIndices: [column],
          tableColumnProperties: { widthType: "FIXED_WIDTH", width: points(40 + column) },
          fields: "widthType,width",
        },
      };
    case "updateTableCellStyle":
      return {
        updateTableCellStyle: {
          tableRange: { tableCellLocation: cell, rowSpan: 1, columnSpan: 1 },
          tableCellStyle: { backgroundColor: { color: { rgbColor: { green: 1 } } } },
          fields: "backgroundColor",
        },
      };
    case "updateTableRowStyle":
      return {
        updateTableRowStyle: {
          tableStartLocation: at(index), rowIndices: [row],
          tableRowStyle: { minRowHeight: points(20 + row) }, fields: "minRowHeight",
        },
      };
    case "mergeTableCells":
      return mergeCells(index, row, column, 1 + variant % 2, 1 + (variant >> 1) % 2);
    case "unmergeTableCells": return unmergeCells(index, row, column);
  }
}

/** Exactly `cap` of `all` (or all of it), spread evenly, the first and the last always. */
function thinned<T>(all: readonly T[], cap: number): T[] {
  if (all.length <= cap) return [...all];
  return Array.from({ length: cap }, (_, taken) =>
    all[Math.round(taken * (all.length - 1) / (cap - 1))]);
}

/**
 * The requests of `kind` over the places of `tab`: two at each place for an insertion; the ranges
 * from each place to the places in the next elements, thinned to `ranges`, with a link cleared and
 * whole paragraphs bulleted always; at each table's every row and column and one past, for a table.
 */
export function familyOf(tab: GoogleDocsTab, kind: FamilyKind, ranges: number): GoogleDocsRequest[] {
  let { content } = ingestedTab(tab).body;
  let places = placesOf(tab);
  if (kind === "insertText" || kind === "insertTable") {
    return places.flatMap((place, variant) =>
      [requestOf(kind, place, { variant }), requestOf(kind, place, { variant: variant + 1 })]);
  }
  if (RANGE_KINDS.some(range => range === kind)) {
    let all: [start: number, end: number][] = [];
    for (let [position, start] of places.entries()) {
      let reach = elementHolding(tab, start) + 2;
      for (let end of places.slice(position + 1)) {
        // An end at an element's own end counts as that element's.
        if (elementHolding(tab, end - 1) <= reach) all.push([start, end]);
      }
    }
    let requests = thinned(all, ranges)
      .map(([start, end], variant) => requestOf(kind, start, { end, variant }));
    if (kind === "updateTextStyle") {
      for (let { startIndex, paragraph } of content) {
        let run = paragraph?.elements[0];
        if (run?.textRun?.textStyle.link) {
          requests.push(styleText(startIndex, run.endIndex, {}, "link"));
        }
      }
    }
    if (kind === "createParagraphBullets") {
      for (let { startIndex, endIndex, paragraph } of content) {
        if (!paragraph || paragraph.bullet) continue;
        for (let glyphs of [BULLETED, NUMBERED]) requests.push(bullets(startIndex, endIndex, glyphs));
      }
    }
    return requests;
  }
  let requests: GoogleDocsRequest[] = [];
  for (let { startIndex, table } of content) {
    let rows = table?.tableRows ?? [];
    if (!table) continue;
    for (let row = 0; row <= rows.length; row++) {
      for (let column = 0; column <= (rows[0]?.tableCells?.length ?? 0); column++) {
        requests.push(requestOf(kind, startIndex, { row, column, variant: row + column }));
      }
    }
  }
  return [...requests, requestOf(kind, content[1].startIndex)];
}

/** A request that removes or adds a top-level element, and then any request. */
export type Pair = {
  /** The tab's name, and what the first request does: together they name the pair's test. */
  name: SliceTabName;
  first: string;
  tab: GoogleDocsTab;
  requests: [first: GoogleDocsRequest, second: GoogleDocsRequest];
  /** Where the second request's index lies: before what the first names, in it, or after it. */
  zone: "before" | "at" | "after";
  label: string;
};

/** The first requests of the pairs, by what each does to the tab's top-level elements. */
export const PAIR_FIRSTS = [
  "a whole table deleted", "a table's only row deleted", "a table's only column deleted",
  "two paragraphs joined", "a line break inserted", "a table inserted",
] as const;

/**
 * The pairs: for each tab and first request, forty seeded second requests of every kind in turn,
 * at a place before, in or after what the first names. 720 pairs.
 */
export function pairsCorpus(): Pair[] {
  let pairs: Pair[] = [];
  for (let [tabAt, name] of (Object.keys(TAB_SPECS) as SliceTabName[]).entries()) {
    for (let [firstAt, first] of PAIR_FIRSTS.entries()) {
      let tab = first === "a table's only row deleted" ? sliceTab(name, { table: [["a\n", "b\n"]] })
        : first === "a table's only column deleted" ? sliceTab(name, { table: [["a\n"], ["b\n"]] })
          : SLICE_TABS[name];
      let { content } = tab.body;
      let table = content.find(element => element.table)!;
      // The first paragraph, past the tab's first three elements, that a paragraph follows.
      let joined = content.findIndex((element, position) =>
        position >= 3 && element.paragraph && content[position + 1]?.paragraph);
      let paragraph = content[joined];
      let [request, low, high]: [GoogleDocsRequest, number, number] =
        first === "a whole table deleted"
          ? [deleteRange(table.startIndex, table.endIndex), table.startIndex, table.endIndex]
          : first === "a table's only row deleted"
            ? [deleteRow(table.startIndex, 0), table.startIndex, table.endIndex]
            : first === "a table's only column deleted"
              ? [deleteColumn(table.startIndex, 0), table.startIndex, table.endIndex]
              : first === "two paragraphs joined"
                ? [deleteRange(paragraph.endIndex - 1, paragraph.endIndex), paragraph.startIndex,
                  content[joined + 1].endIndex]
                : first === "a line break inserted"
                  ? [insertText(paragraph.startIndex + 1, "a\nb"), paragraph.startIndex, paragraph.endIndex]
                  : [insertTable(paragraph.endIndex - 1, 1, 1), paragraph.startIndex, paragraph.endIndex];
      let { below, pick }: Dice = diceOf(20261120 + 100 * tabAt + firstAt);
      let places = placesOf(tab);
      let zones = {
        before: places.filter(place => place < low),
        at: places.filter(place => place >= low && place <= high),
        after: places.filter(place => place > high),
      };
      // How far the first request moves what follows it: the body's end, after it less before.
      let moved = applyDocsRequests(tab, [request]).body.content.at(-1)!.endIndex -
        content.at(-1)!.endIndex;
      // The kinds in turn, so that no zone is drawn all of table kinds.
      let start = below(FAMILY_KINDS.length);
      for (let draw = 0; draw < 40; draw++) {
        let zone = (["before", "at", "after"] as const)[draw % 3];
        // A place after what the first names is named where the first request leaves it.
        let index = pick(zones[zone]) + (zone === "after" ? moved : 0);
        let second = requestOf(FAMILY_KINDS[(start + draw) % FAMILY_KINDS.length], index, {
          end: index + 1 + below(6), row: below(3), column: below(3), variant: below(8),
        });
        pairs.push({
          name, first, tab, requests: [request, second], zone,
          label: `${name}: ${first}, then ${JSON.stringify(second)}`,
        });
      }
    }
  }
  return pairs;
}

// --- A model built from the source text

const MODEL_SOURCE = path.resolve(import.meta.dirname, "../src/docs-model.ts");

/** The model's module built from its source text with each `find` (once each) replaced by its `put`. */
export function mutantModel(
  replace: readonly (readonly [find: string, put: string])[],
): typeof import("../src/docs-model") {
  let text = readFileSync(MODEL_SOURCE, "utf8");
  for (let [find, put] of replace) {
    if (text.split(find).length !== 2) throw new Error(`the guard's text moved: ${find}`);
    text = text.replace(find, () => put);
  }
  let { outputText } = ts.transpileModule(text, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  let exported = {};
  // The model's own text, evaluated as a second module.
  new Function("exports", "require", outputText)(exported, required);
  return exported as typeof import("../src/docs-model");
}

/** What the model's module imports as a value: its content rules, and nothing else. */
function required(name: string): unknown {
  if (name === "./docs-content") return docsContent;
  throw new Error(`the model imports ${name}`);
}

const ENTRY_GUARD = `    if (index < this.origin) {
      if (!this.first) throw new SliceEdgeError("before", index);
    } else if (position === -1) {
      if (!this.last) throw new SliceEdgeError("after", index);
    }
`;
const REINDEX = "walkContent(this.#content, this.origin, this.opens(), storeIndexes);";

/**
 * The models built to show each part of the guard is needed: four take a part out, `side-by-lookup`
 * reads the side off the lookup, and the last two re-index from 0, with the exit check and without.
 */
export const GUARD_MUTANTS = {
  "lookup-before": [["if (!this.first) throw new SliceEdgeError(\"before\", index);", ";"]],
  "lookup-after": [["if (!this.last) throw new SliceEdgeError(\"after\", index);", ";"]],
  "element-before": [[
    "if (position === 0 && !this.first) throw new SliceEdgeError(\"before\", this.origin - 1);", ";",
  ]],
  "body-opening": [["return this.first;", "return true;"]],
  "side-by-lookup": [[
    ENTRY_GUARD,
    "    if (position === -1) { if (!this.last) throw new SliceEdgeError(\"after\", index); } " +
    "else if (index < this.#content[position].startIndex && !this.first) " +
    "throw new SliceEdgeError(\"before\", index);\n",
  ]],
  "reindex-from-zero": [[REINDEX, REINDEX.replace("this.origin", "0")]],
  "reindex-from-zero, unchecked": [
    [REINDEX, REINDEX.replace("this.origin", "0")],
    ["invariant(\"a slice whose elements do not follow one another from its origin\");", ";"],
  ],
} as const satisfies Record<string, readonly (readonly [find: string, put: string])[]>;

// --- The seeded sequences, from the slices of their tabs

/**
 * Registers the tests that hold every call the sequences of `seed` of one `parity` make of the
 * model from the slices of its tab: a call of one request from every stretch, a call of the batch
 * so far from every stretch in the wider run and from a sample otherwise. `widerOnly` registers
 * the tests and skips them outside the wider run.
 */
export function sequencesFromEverySlice(
  seed: number, backToFront: boolean, parity: 0 | 1, widerOnly: boolean,
): void {
  let title = `the sequences of seed ${seed}, ${parity === 0 ? "even" : "odd"}, from every slice` +
    (widerOnly ? " (the wider run: GOOGLE_DOCS_WIDER_TESTS=1)" : "");
  describe.skipIf(widerOnly && !WIDER)(title, () => {
    // Text, not objects: a tab is parsed where it is used.
    let calls: RecordedCall[] = [];
    let counted = { calls: 0, stretches: 0, nothing: 0 };

    beforeAll(() => {
      calls = recordedSequenceCalls(seed, 320, backToFront).calls
        .filter(call => call.sequence % 2 === parity);
    });

    it.each(Array.from({ length: 10 }, (_, share) => share))("share %i of 10", share => {
      for (let [position, call] of calls.entries()) {
        if ((call.sequence - parity) / 2 % 10 !== share) continue;
        let [tab, requests] = JSON.parse(call.json) as [GoogleDocsTab, GoogleDocsRequest[]];
        // A batch so far is held from the stretches a hole in the guard was found from: the
        // lowest element it names alone, one stretch before it, one after it, the whole tab.
        let stretches = call.alone || WIDER ? undefined : sampledSlices(
          tab.body.content.length, seed + position, 8, namedPosition(tab, requests));
        let { ran, nothing } = expectEverySlice(tab, requests, {}, () => call.where, "model", stretches);
        counted.calls++;
        counted.stretches += ran;
        counted.nothing += nothing;
      }
    });

    // The tests of a file run in order: this one reads what the shares counted.
    it("ran every call of its half", () => {
      expect(counted.calls).toBe(calls.length);
      expect(counted.calls).toBeGreaterThan(3_000);
      expect(counted.stretches).toBeGreaterThan(15 * counted.calls);
      expect(counted.nothing / counted.stretches).toBeGreaterThan(1 / 5);
    });
  });
}
