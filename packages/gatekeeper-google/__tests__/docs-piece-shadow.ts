// Helpers that hold a piece of a stored tab, and what is built from a piece, to the tab
// rendered whole: the closure cut from the whole rendering, the stored piece, and the whole
// rendering under the recorder. Node only: the storage is the fake.

import { expect } from "vitest";
import type { GoogleDocsRequest, GoogleDocsTab, StructuralElement } from "../src/docs-api";
import { DOC_DERIVED } from "../src/docs-derived";
import { DocReadingFault, storedTabReading } from "../src/docs-reading";
import { pieceOverreach, tabEditRequests } from "../src/docs-replay";
import type { DocEdit } from "../src/docs-replay";
import type { RunSizes } from "../src/docs-runs";
import type { DocPiece, DocStore, DocVersion, PieceAt } from "../src/docs-store";
import { tableCallChange } from "../src/docs-table-actions";
import type { TableCall } from "../src/docs-table-actions";
import { replacementPath, wholeTabReading } from "../src/docs-tables";
import type { TableChange, TextReplacement } from "../src/docs-tables";
import {
  canonicalizeMarkdownReplacement, closureOf, computeReplaceOperations, docTabToMarkdown,
  ELEMENT_TABLE, initialCarry, joinRenderedRun, markdownToDocRequests, noRenderedRuns,
  pieceRendering, renderRun,
} from "../src/markdown-converter";
import type {
  DocTabSnapshot, JoinedRuns, MarkdownRange, OwnElements, OwnRange, TabReading,
} from "../src/markdown-converter";
import { buildTab, para } from "./doc-fixture";
import type { FakeDocStorage } from "./doc-store-fake";
import { ReadPastPiece, recorded } from "./docs-piece-recorder";
import { asFetched, kept } from "./docs-store-slice-shadow";

export { kept as pieceStore };

/** A tab rendered whole, with what the pass says of its elements. */
export type Whole = {
  readonly tab: GoogleDocsTab;
  readonly markdown: string;
  /** Where each element's Markdown starts, and what it writes and owns (`RunElements`). */
  readonly starts: readonly number[];
  readonly flags: readonly number[];
  /** Where each element starts and ends in the tab's indexes, carried over a missing index. */
  readonly indexes: { readonly starts: readonly number[]; readonly ends: readonly number[] };
  /** The tab as one run joined, rendered afresh at each call: `pieceRendering` moves its entries. */
  joined(): JoinedRuns;
};

/** `tab` rendered whole, as one run with its elements told. */
export function wholeOf(tab: GoogleDocsTab): Whole {
  let joined = () => {
    let runs = noRenderedRuns();
    joinRenderedRun(runs, renderRun(
      tab.body.content, tab, initialCarry(), { mdStart: 0, elements: true }));
    return runs;
  };
  let { markdown, starts, flags } = joined();
  let indexes = { starts: [] as number[], ends: [] as number[] };
  let end = 0;
  for (let [at, element] of tab.body.content.entries()) {
    if (at === 0 && Number.isInteger(element.startIndex)) end = element.startIndex;
    indexes.starts.push(Number.isInteger(element.startIndex) ? element.startIndex : end);
    if (Number.isInteger(element.endIndex)) end = element.endIndex;
    indexes.ends.push(end);
  }
  return { tab, markdown, starts, flags, indexes, joined };
}

/** The elements of `whole` that `own` names, by `OwnRange`'s rule. */
export function ownIn(whole: Whole, own: OwnRange): OwnElements {
  let { starts, flags } = whole;
  if (own === "end") return { first: flags.length - 1, last: flags.length - 1 };
  if ("table" in own) {
    let tables = flags.flatMap((flag, element) => flag & ELEMENT_TABLE ? [element] : []);
    return { first: tables[own.table], last: tables[own.table] };
  }
  // The last element that starts at or before a character holds it, or nothing does.
  let holder = (offset: number) => starts.findLastIndex(start => start <= offset);
  let { mdStart, mdEnd } = own.markdown;
  return { first: holder(mdStart), last: holder(Math.max(mdStart, mdEnd - 1)) };
}

/** Where the run holding the first of `own` stands in `version` (`PieceAt`), read beneath the store. */
export function pieceAtFor(
  storage: FakeDocStorage, version: DocVersion, own: OwnRange, made: string = DOC_DERIVED,
): PieceAt {
  let runs = storage.sql.exec<{ length: number; tables: number }>(
    `SELECT json_extract(doc_md.summary, '$.markdownLength') AS length,
        json_array_length(doc_md.summary, '$.tables') AS tables
      FROM doc_seq JOIN doc_md ON doc_md.doc = ?3 AND doc_md.run = doc_seq.run
        AND doc_md.context = doc_seq.context AND doc_md.carry = doc_seq.carry AND doc_md.made = ?2
      WHERE doc_seq.version = ?1 ORDER BY doc_seq.seq`, version.id, made, version.doc).toArray();
  if (runs.length === 0) throw new Error("The version lists no run rendered under the digest.");
  let found: PieceAt | undefined;
  let mdStart = 0, tablesBefore = 0;
  for (let [seq, run] of runs.entries()) {
    let holds = own === "end"
      ? seq === runs.length - 1
      : "table" in own
        ? own.table >= tablesBefore && own.table < tablesBefore + run.tables
        // The last run that writes a character and starts at or before the offset.
        : run.length > 0 && mdStart <= own.markdown.mdStart;
    // Where no run writes a character, the version's last.
    if (holds || (seq === runs.length - 1 && !found)) found = { place: seq, mdStart, tablesBefore, own };
    mdStart += run.length;
    tablesBefore += run.tables;
  }
  return found!;
}

/** The closure of `own` in `whole`: the range the rule gives of the tab whole. */
export function closureIn(whole: Whole, own: OwnRange): { from: number; to: number } {
  let closure = closureOf(whole.flags, ownIn(whole, own), { first: true, last: true });
  if ("more" in closure) throw new Error("A whole tab's closure asks for more.");
  return closure;
}

/** Holds `piece` to the closure of `own` cut from `whole`: the same rendering and the same place. */
export function expectPieceOfWhole(piece: DocPiece, whole: Whole, own: OwnRange): void {
  let { from, to } = closureIn(whole, own);
  let cut = pieceRendering(whole.joined(), from, to);
  let { markdown: _markdown, sourceMap: _sourceMap, ...identity } = docTabToMarkdown(whole.tab);
  expect(piece.rendering).toEqual({ ...identity, markdown: cut.markdown, sourceMap: cut.sourceMap });
  expect(piece.at).toEqual({
    mdStart: cut.mdStart, tablesBefore: cut.tablesBefore, first: from === 0,
    last: to === whole.flags.length,
    inner: { from: whole.indexes.ends[from], to: whole.indexes.starts[to - 1] },
  });
}

/** An element the pruning left with nothing to render, at `index`: it writes nothing. */
const silentAt = (index: number): StructuralElement =>
  ({ startIndex: index, endIndex: index }) as StructuralElement;

/** `tab` with an element that writes nothing put before its element `before`. */
function withSilent(tab: GoogleDocsTab, before: number): GoogleDocsTab {
  let content = [...tab.body.content];
  content.splice(before, 0, silentAt(content[before].startIndex));
  return { ...tab, body: { content } };
}

/**
 * Tabs in which, under one-element runs, a run writes nothing before, at and after the own
 * element, and a tab whose Markdown is empty, each with own ranges to ask.
 */
export function silentRunTabs(): { name: string; tab: GoogleDocsTab; ranges: MarkdownRange[] }[] {
  let lines = ["Zero", "One", "Two", "Three", "Own text", "Five", "Six", "Seven", "Eight"];
  let plain = buildTab(lines.map(para));
  // The own paragraph is element 5 of the plain tab, after the section break.
  let tabs = [
    { name: "a run that writes nothing before the own element", tab: withSilent(plain, 2) },
    { name: "a run that writes nothing at the own element", tab: withSilent(plain, 5) },
    { name: "a run that writes nothing after the own element", tab: withSilent(plain, 6) },
  ].map(({ name, tab }) => {
    let fetched = asFetched(tab);
    let whole = wholeOf(fetched);
    let text = whole.markdown.indexOf("Own text");
    let start = whole.starts[ownIn(whole, { markdown: { mdStart: text, mdEnd: text + 1 } }).first];
    return {
      name, tab: fetched,
      ranges: [{ mdStart: text + 1, mdEnd: text + 5 }, { mdStart: start, mdEnd: start + 3 }],
    };
  });
  let empty = buildTab([]);
  empty.body.content.push(silentAt(1));
  return [...tabs, {
    name: "a tab whose Markdown is empty", tab: asFetched(empty),
    ranges: [{ mdStart: 0, mdEnd: 0 }],
  }];
}

// --- The builders on a piece, held to the builders on the whole tab

/** What a build gave: its batch, or the refusal it threw. */
export type Outcome =
  | { readonly requests: GoogleDocsRequest[] }
  | { readonly refused: { readonly name: string; readonly message: string } };

/** The outcome of `run`, its batch or its refusal; a fault (`TypeError`, `ReadPastPiece`, ...) is thrown on. */
export function outcomeOf(run: () => GoogleDocsRequest[]): Outcome {
  try {
    return { requests: run() };
  } catch (error) {
    if (!(error instanceof Error) || error instanceof TypeError || error instanceof ReadPastPiece ||
        error instanceof DocReadingFault) {
      throw error;
    }
    return { refused: { name: error.name, message: error.message } };
  }
}

/**
 * One way an edit becomes requests: `own`, the edit's own range, and `build`, from a rendering
 * whose Markdown starts at `mdStart` of the tab's.
 */
export type PieceEntry<Edit> = {
  readonly name: string;
  own(edit: Edit): PieceAt["own"];
  build(render: DocTabSnapshot, edit: Edit, mdStart: number): GoogleDocsRequest[];
};

/** A replacement outside tables of a text that stands once at `matchStart`, by the paragraph path. */
export const REPLACE: PieceEntry<TextReplacement> = {
  name: "a replacement outside tables",
  own: ({ matchStart, oldMarkdown }) =>
    ({ markdown: { mdStart: matchStart, mdEnd: matchStart + oldMarkdown.length } }),
  build: (render, { matchStart, oldMarkdown, newMarkdown }, mdStart) => computeReplaceOperations(
    render.sourceMap, render.markdown, matchStart - mdStart,
    matchStart - mdStart + oldMarkdown.length,
    canonicalizeMarkdownReplacement(oldMarkdown, newMarkdown), render.tabId).requests,
};

/** An append to a tab that is not blank and ends in a paragraph, built as an edit builds it. */
export const APPEND: PieceEntry<{ markdown: string }> = {
  name: "an append to a tab that is not blank",
  own: () => "end",
  build: (render, { markdown }) => markdownToDocRequests(
    "\n" + markdown, render.bodyEndIndex - 1, render.tabId,
    { resetParagraphs: true, preserveLeadingParagraph: true, tabBlocks: render.sourceMap.blocks }),
};

/** An edit with the entry that builds it, the edit's type forgotten: what a corpus draws. */
export type PieceCase = { readonly entry: PieceEntry<unknown>; readonly edit: unknown };

/** `edit` with the entry that builds it, as a corpus hands the two on. */
export function pieceCase<Edit>(entry: PieceEntry<Edit>, edit: Edit): PieceCase {
  return { entry: entry as PieceEntry<unknown>, edit };
}

/** A tab rendered whole, both ways: with its elements told, and as the builders are handed it. */
type Rendered = { readonly whole: Whole; readonly rendering: DocTabSnapshot };

const RENDERED = new WeakMap<GoogleDocsTab, Rendered>();

/** `tab` rendered whole, once a tab: nothing that is handed a rendering here changes it. */
export function renderedOf(tab: GoogleDocsTab): Rendered {
  let rendered = RENDERED.get(tab);
  if (!rendered) RENDERED.set(tab, rendered = { whole: wholeOf(tab), rendering: docTabToMarkdown(tab) });
  return rendered;
}

/** The outcome of `edit` built from the whole tab's rendering. */
export function fromWhole<Edit>(tab: GoogleDocsTab, entry: PieceEntry<Edit>, edit: Edit): Outcome {
  let { rendering } = renderedOf(tab);
  return outcomeOf(() => entry.build(rendering, edit, 0));
}

/** A range of a tab's body elements, `[from, to)`. */
export type ElementRange = { readonly from: number; readonly to: number };

/** Another range than the closure to build from or allow reads of, for the teeth and a wider range. */
export type Shrink = (
  closure: ElementRange, own: OwnElements, flags: readonly number[],
) => ElementRange;

/** Where the elements `[from, to)` of `whole` stand in the tab, as `DocStore.piece` says it. */
function partOf(
  whole: Whole, { from, to }: ElementRange, cut: { mdStart: number; tablesBefore: number },
): DocPiece["at"] {
  return {
    mdStart: cut.mdStart, tablesBefore: cut.tablesBefore, first: from === 0,
    last: to === whole.flags.length,
    inner: { from: whole.indexes.ends[from], to: whole.indexes.starts[to - 1] },
  };
}

/**
 * The outcome of `edit` built from the closure of its own elements cut from the whole tab's
 * joined runs (or from what `shrink` makes of it), with where that range stands.
 */
export function fromClosure<Edit>(
  tab: GoogleDocsTab, entry: PieceEntry<Edit>, edit: Edit, shrink?: Shrink,
): { outcome: Outcome; part: DocPiece["at"]; range: ElementRange } {
  let { whole, rendering } = renderedOf(tab);
  let own = ownIn(whole, entry.own(edit));
  let closure = closureIn(whole, entry.own(edit));
  let range = shrink ? shrink(closure, own, whole.flags) : closure;
  let cut = pieceRendering(whole.joined(), range.from, range.to);
  let piece = { ...rendering, markdown: cut.markdown, sourceMap: cut.sourceMap };
  return {
    outcome: outcomeOf(() => entry.build(piece, edit, cut.mdStart)),
    part: partOf(whole, range, cut), range,
  };
}

/** A tab kept in a store of its own: `pieceStore`'s answer. */
type Kept = { storage: FakeDocStorage; store: DocStore; base: DocVersion };

const KEPT = new WeakMap<GoogleDocsTab, Map<RunSizes, Kept>>();

/** Every object reachable from `value`, added to `seen`, which also ends a walk at a cycle. */
function reachable(value: unknown, seen = new Set<object>()): Set<object> {
  if (typeof value !== "object" || value === null || seen.has(value)) return seen;
  seen.add(value);
  let inside = value instanceof Map ? [...value.keys(), ...value.values()] : Object.values(value);
  for (let each of inside) reachable(each, seen);
  return seen;
}

/**
 * The objects of `requests` that are objects of `piece`: a batch is stored as built and the
 * model changes a piece's elements in place, so a batch holds none.
 */
export function sharedWithPiece(requests: GoogleDocsRequest[], piece: DocPiece): object[] {
  let ofPiece = reachable(piece.decoded, reachable(piece.rendering));
  return [...reachable(requests)].filter(object => ofPiece.has(object));
}

/** The outcome of `edit` built from the piece a store of `tab` cut to `sizes` answers, and the piece. */
export function fromStore<Edit>(
  tab: GoogleDocsTab, sizes: RunSizes, entry: PieceEntry<Edit>, edit: Edit,
): { outcome: Outcome; piece: DocPiece } {
  let held = keptFor(tab, sizes);
  let piece = held.store.piece(held.base, pieceAtFor(held.storage, held.base, entry.own(edit)));
  return {
    outcome: outcomeOf(() => entry.build(piece.rendering, edit, piece.at.mdStart)), piece,
  };
}

/** The outcome of `edit` built from the whole rendering under the recorder of its closure (or `shrink`'s range). */
export function fromRecorded<Edit>(
  tab: GoogleDocsTab, entry: PieceEntry<Edit>, edit: Edit, shrink?: Shrink,
): Outcome {
  let { whole, rendering } = renderedOf(tab);
  let closure = closureIn(whole, entry.own(edit));
  let range = shrink ? shrink(closure, ownIn(whole, entry.own(edit)), whole.flags) : closure;
  let guarded = recorded({ rendering, starts: whole.starts, flags: whole.flags }, range);
  return outcomeOf(() => entry.build(guarded, edit, 0));
}

/** What `expectSameFromPieces` says of a case, for a test's tally. */
export type PieceVerdict = {
  /** Whether the whole tab built a batch. */
  readonly built: boolean;
  /** Whether the closure left at least one element of the tab out. */
  readonly strict: boolean;
  /** Whether the batch names an index in the element next to the piece's first, and its last. */
  readonly nearBefore: boolean;
  readonly nearAfter: boolean;
  /** Whether `pieceOverreach` counts the whole batch on the side after the piece. */
  readonly counted: boolean;
};

/** An index no tab reaches, and one past every index a batch names after text it inserted. */
const FAR = 2 ** 40;
const FARTHER = 2 ** 50;

/**
 * Holds `edit` built from the closure, under the recorder and from the stored piece under each
 * of `sizings` to the whole tab's batch or refusal; a stored piece stands where the closure
 * does and its batch holds none of it; a batch names no index past the closure.
 */
export function expectSameFromPieces<Edit>(
  tab: GoogleDocsTab, entry: PieceEntry<Edit>, edit: Edit, sizings: readonly RunSizes[],
): PieceVerdict {
  let { whole } = renderedOf(tab);
  let outcome = fromWhole(tab, entry, edit);
  let { outcome: closed, part, range } = fromClosure(tab, entry, edit);
  expect(closed).toEqual(outcome);
  expect(fromRecorded(tab, entry, edit)).toEqual(outcome);
  for (let sizes of sizings) {
    let stored = fromStore(tab, sizes, entry, edit);
    expect(stored.piece.at).toEqual(part);
    expect(stored.outcome).toEqual(outcome);
    if ("requests" in stored.outcome) {
      expect(sharedWithPiece(stored.outcome.requests, stored.piece)).toEqual([]);
    }
  }
  let strict = range.to - range.from < whole.flags.length;
  if (!("requests" in outcome)) {
    return { built: false, strict, nearBefore: false, nearAfter: false, counted: false };
  }
  let { requests } = outcome;
  expect(pieceOverreach(requests, part)).toBeUndefined();
  // How far the batch reaches: a piece one element short on a side, and a request far past.
  let nearBefore = !part.first && pieceOverreach(requests, {
    first: false, last: true, inner: { from: whole.indexes.ends[range.from + 1], to: FAR },
  }) === "before";
  let nearAfter = !part.last && pieceOverreach(requests, {
    first: true, last: false, inner: { from: 0, to: whole.indexes.starts[range.to - 2] - 1 },
  }) === "after";
  let last: GoogleDocsRequest =
    { insertText: { location: { index: FARTHER, tabId: tab.tabId }, text: "" } };
  let counted = pieceOverreach([...requests, last], {
    first: true, last: false, inner: { from: 0, to: FAR },
  }) === "after";
  return { built: true, strict, nearBefore, nearAfter, counted };
}

// --- An edit built from a reading of its tab

/** A reading a test made of a tab, with the range of elements its last piece held. */
export type ShadowReading = TabReading & {
  /** The elements the last piece held; `undefined` where none was asked. */
  range(): ElementRange | undefined;
};

// A reading of `tab` that answers of the tab as a whole as the whole rendering does, and whose
// piece is what `cut` answers for the closure (or `shrink`'s range).
function readingOver(
  tab: GoogleDocsTab, shrink: Shrink | undefined,
  cut: (range: ElementRange) => { rendering: DocTabSnapshot; part: DocPiece["at"] },
): ShadowReading {
  let { whole, rendering } = renderedOf(tab);
  let asked = wholeTabReading(rendering);
  let last: ElementRange | undefined;
  let reading: ShadowReading = {
    tabId: asked.tabId,
    blank: () => asked.blank(),
    find: (text, lineBreakBefore) => asked.find(text, lineBreakBefore),
    tables: () => asked.tables(),
    tablesShaped: shape => asked.tablesShaped(shape),
    numberedAfter: table => asked.numberedAfter(table),
    lineBefore: mdStart => asked.lineBefore(mdStart),
    piece(own) {
      let closure = closureIn(whole, own);
      last = shrink ? shrink(closure, ownIn(whole, own), whole.flags) : closure;
      let { rendering: piece, part } = cut(last);
      return { ...piece, part: { ...part, tab: reading } };
    },
    range: () => last,
  };
  return reading;
}

/** A reading of `tab` whose piece is the closure cut from the whole rendering (or `shrink`'s range). */
export function closureReading(tab: GoogleDocsTab, shrink?: Shrink): ShadowReading {
  let { whole, rendering } = renderedOf(tab);
  return readingOver(tab, shrink, range => {
    let cut = pieceRendering(whole.joined(), range.from, range.to);
    return {
      rendering: { ...rendering, markdown: cut.markdown, sourceMap: cut.sourceMap },
      part: partOf(whole, range, cut),
    };
  });
}

/**
 * A reading of `tab` whose piece is the whole rendering under the recorder of the closure (or
 * `shrink`'s range), standing at offset 0 with the whole tab's offsets.
 */
export function recordedReading(tab: GoogleDocsTab, shrink?: Shrink): ShadowReading {
  let { whole, rendering } = renderedOf(tab);
  return readingOver(tab, shrink, range => ({
    rendering: recorded({ rendering, starts: whole.starts, flags: whole.flags }, range),
    part: { ...partOf(whole, range, { mdStart: 0, tablesBefore: 0 }) },
  }));
}

/** `tab` kept in a store of its own with its runs cut to `sizes`: one store a tab and sizing. */
export function keptFor(tab: GoogleDocsTab, sizes: RunSizes): Kept {
  let stores = KEPT.get(tab) ?? new Map<RunSizes, Kept>();
  KEPT.set(tab, stores);
  let held = stores.get(sizes);
  if (!held) stores.set(sizes, held = kept(tab, sizes));
  return held;
}

/** The outcome of `edit` built by the one place an edit becomes requests, from `reading`. */
export function fromReading(reading: TabReading, edit: DocEdit): Outcome {
  return outcomeOf(() => tabEditRequests(reading, edit));
}

/** What `expectSameFromReadings` says of a case, for a test's tally. */
export type ReadingVerdict = {
  /** Whether the whole tab built a batch. */
  readonly built: boolean;
  /** The message of the refusal, where the whole tab refused. */
  readonly refused?: string;
  /** Whether the edit named a piece, and its closure left at least one element of the tab out. */
  readonly strict: boolean;
  /** For a batch built: whether `pieceOverreach` counts the whole batch on the side after. */
  readonly counted?: boolean;
};

/**
 * Holds `edit` built by `tabEditRequests` from the closure's, the recorded and the stored
 * readings to the whole tab's; with `matchStart`, the recorded piece's `replacementPath` too.
 */
export function expectSameFromReadings(
  tab: GoogleDocsTab, edit: DocEdit, sizings: readonly RunSizes[], matchStart?: number,
): ReadingVerdict {
  let { whole, rendering } = renderedOf(tab);
  let outcome = fromReading(wholeTabReading(rendering), edit);
  let closed = closureReading(tab);
  expect(fromReading(closed, edit)).toEqual(outcome);
  let range = closed.range();
  let guarded = recordedReading(tab);
  expect(fromReading(guarded, edit)).toEqual(outcome);
  for (let sizes of sizings) {
    let { store, base } = keptFor(tab, sizes);
    expect(fromReading(storedTabReading(store, base), edit)).toEqual(outcome);
  }
  if (edit.type === "replaceText" && matchStart !== undefined) {
    let replacement = { matchStart, oldMarkdown: edit.oldMarkdown, newMarkdown: edit.newMarkdown };
    let piece = recordedReading(tab).piece({
      markdown: { mdStart: matchStart, mdEnd: matchStart + edit.oldMarkdown.length },
    });
    expect(replacementPath(piece, replacement)).toEqual(replacementPath(rendering, replacement));
  }
  let strict = range !== undefined && range.to - range.from < whole.flags.length;
  if (!("requests" in outcome)) return { built: false, strict, refused: outcome.refused.message };
  let last: GoogleDocsRequest =
    { insertText: { location: { index: FARTHER, tabId: tab.tabId }, text: "" } };
  let counted = pieceOverreach([...outcome.requests, last], {
    first: true, last: false, inner: { from: 0, to: FAR },
  }) === "after";
  return { built: true, strict, counted };
}

// --- A table call checked against a reading of its tab

/** What a table call's checks gave: the change to queue, or the refusal they threw. */
export type CallOutcome =
  | { readonly change: TableChange }
  | { readonly refused: { readonly name: string; readonly message: string } };

/** The outcome of `call` checked against the tab `reading` reads (`tableCallChange`). */
export function callOutcome(reading: TabReading, call: TableCall): CallOutcome {
  try {
    return { change: tableCallChange(reading, call) };
  } catch (error) {
    if (!(error instanceof Error) || error instanceof TypeError || error instanceof ReadPastPiece ||
        error instanceof DocReadingFault) {
      throw error;
    }
    return { refused: { name: error.name, message: error.message } };
  }
}

/** Holds `call` checked by `tableCallChange` on the closure's, the recorded and the stored readings to the whole tab's. */
export function expectSameCallFromReadings(
  tab: GoogleDocsTab, call: TableCall, sizings: readonly RunSizes[],
): ReadingVerdict {
  let { whole, rendering } = renderedOf(tab);
  let outcome = callOutcome(wholeTabReading(rendering), call);
  let closed = closureReading(tab);
  expect(callOutcome(closed, call)).toEqual(outcome);
  let range = closed.range();
  expect(callOutcome(recordedReading(tab), call)).toEqual(outcome);
  for (let sizes of sizings) {
    let { store, base } = keptFor(tab, sizes);
    expect(callOutcome(storedTabReading(store, base), call)).toEqual(outcome);
  }
  let strict = range !== undefined && range.to - range.from < whole.flags.length;
  return "change" in outcome
    ? { built: true, strict } : { built: false, strict, refused: outcome.refused.message };
}
