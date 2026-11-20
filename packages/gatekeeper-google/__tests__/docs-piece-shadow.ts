// A piece of a stored tab held to the same part of the tab rendered whole, and the request
// builders on a piece held to the builders on the whole tab: the helpers that render a tab
// whole with what the pass says of its elements, name an edit's own elements in it, say
// where a piece stands from the stored rows beneath the store, build an edit from the whole
// rendering, from the closure cut from it, from a stored piece and from the whole rendering
// under the recorder, and compare; and the readings of a tab made each of those ways, for
// what is handed a reading. A helper and no test of its own. Node only: the storage is the
// fake.

import { expect } from "vitest";
import type { GoogleDocsRequest, GoogleDocsTab, StructuralElement } from "../src/docs-api";
import { DOC_DERIVED } from "../src/docs-derived";
import { hasModelIndexes } from "../src/docs-model";
import { DocReadingFault, storedTabReading } from "../src/docs-reading";
import { pieceOverreach, tabEditRequests } from "../src/docs-replay";
import type { DocEdit } from "../src/docs-replay";
import { pruneTab } from "../src/docs-replica";
import type { RunSizes } from "../src/docs-runs";
import { DocStore } from "../src/docs-store";
import type { DocPiece, DocVersion, PieceAt } from "../src/docs-store";
import { prepareTableChange, tableCallChange } from "../src/docs-table-actions";
import type { PreparedTableChange, TableCall } from "../src/docs-table-actions";
import { lineAbove, replacementPath, wholeTabReading } from "../src/docs-tables";
import type { TableChange, TextReplacement } from "../src/docs-tables";
import {
  canonicalizeMarkdownReplacement, closureOf, computeReplaceOperations, docTabToMarkdown,
  ELEMENT_TABLE, initialCarry, joinRenderedRun, markdownToDocRequests, noRenderedRuns,
  pieceRendering, renderRun,
} from "../src/markdown-converter";
import type {
  DocTabSnapshot, JoinedRuns, MarkdownRange, OwnElements, OwnRange, TabReading,
} from "../src/markdown-converter";
import {
  buildTab, diceOf, grid, heading, item, para, presetLevels,
} from "./doc-fixture";
import type { BlockSpec, Lists } from "./doc-fixture";
import type { FakeDocStorage } from "./doc-store-fake";
import { ReadPastPiece, recorded } from "./docs-piece-recorder";
import { asFetched, kept, undone } from "./docs-store-slice-shadow";

export { kept as pieceStore };

/** A tab rendered whole, with what the pass says of its elements. */
export type Whole = {
  readonly tab: GoogleDocsTab;
  readonly markdown: string;
  /** Where each element's Markdown starts, and what it writes and owns (`RunElements`). */
  readonly starts: readonly number[];
  readonly flags: readonly number[];
  /**
   * Where each element starts and ends in the tab's indexes: one whose index is no integer
   * starts or ends where the element before it ends.
   */
  readonly indexes: { readonly starts: readonly number[]; readonly ends: readonly number[] };
  /**
   * The tab as one run joined, rendered afresh at each call: `pieceRendering` takes what
   * it is handed.
   */
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

/**
 * Where the run that holds the first of `own` stands in `version`, by `PieceAt`'s rule,
 * computed BENEATH the store: from the version's list joined to the summaries stored with
 * its runs' renderings under the digest `made`.
 */
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
    // The version's last run where none holds the own elements: no run writes a character.
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

/**
 * Holds `piece` to the closure of `own` cut from `whole`: the same rendering, and the same
 * place in the tab, its inner indexes the end of the closure's first element and the start
 * of its last.
 */
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
 * Tabs in which, under one-element runs, a run writes nothing: the section break that opens
 * the body, and an element with nothing to render some runs BEFORE the own element, AT it
 * (the run just before, so that the two start at one Markdown offset) and AFTER it; and a
 * tab whose Markdown is empty. Each with its own ranges: one inside the own element's
 * Markdown and one that starts at its first character, and for the empty tab the range at
 * offset 0.
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

// ---------------------------------------------------------------------------
// The builders on a piece, held to the builders on the whole tab
// ---------------------------------------------------------------------------

/** What a build gave: its batch, or the refusal it threw. */
export type Outcome =
  | { readonly requests: GoogleDocsRequest[] }
  | { readonly refused: { readonly name: string; readonly message: string } };

/**
 * The outcome of `run`: its batch, or what it threw as a refusal. A `TypeError`, a
 * `ReadPastPiece`, a `DocReadingFault` and anything that is no `Error` is a fault and is
 * thrown on.
 */
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
 * One way an edit becomes requests, as the differential holds it: `own`, how the edit's own
 * range is named in the tab's units, and `build`, the requests from a rendering whose
 * Markdown starts at `mdStart` of the tab's (0 for the whole tab's), the edit's Markdown
 * offsets moved by as much.
 */
export type PieceEntry<Edit> = {
  readonly name: string;
  own(edit: Edit): PieceAt["own"];
  build(render: DocTabSnapshot, edit: Edit, mdStart: number): GoogleDocsRequest[];
};

/**
 * A replacement outside tables, of a text that stands once in the tab at `matchStart`, built
 * by the paragraph path's builder as the one place an edit becomes requests calls it.
 */
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

/**
 * Another range for an edit than its closure: handed the closure, the own elements and the
 * tab's flags, it answers the range to build from, or the range the recorder allows reads
 * of. The teeth take elements off the closure with it; a wider range adds some.
 */
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
 * The outcome of `edit` built from the closure of its own elements, cut from the whole tab's
 * joined runs (`pieceRendering` over `closureOf`'s range, the own elements found as
 * `DocStore.piece` finds them), with the range built from and where it stands in the tab, as
 * `DocStore.piece` says it. `shrink` builds from another range than the closure.
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
 * The objects of `requests` that are objects of `piece`: of its rendering, source map
 * included, or of the runs it keeps decoded. A batch is stored and sent as it was built, and
 * the model changes the elements a rendering was made from in place: so a batch holds none.
 */
export function sharedWithPiece(requests: GoogleDocsRequest[], piece: DocPiece): object[] {
  let ofPiece = reachable(piece.decoded, reachable(piece.rendering));
  return [...reachable(requests)].filter(object => ofPiece.has(object));
}

/**
 * The outcome of `edit` built from the piece a store answers for it (`DocStore.piece`), the
 * tab kept in a store of its own with its runs cut to `sizes` (one store a tab and sizing: a
 * piece changes nothing of a version), and the piece.
 */
export function fromStore<Edit>(
  tab: GoogleDocsTab, sizes: RunSizes, entry: PieceEntry<Edit>, edit: Edit,
): { outcome: Outcome; piece: DocPiece } {
  let held = keptFor(tab, sizes);
  let piece = held.store.piece(held.base, pieceAtFor(held.storage, held.base, entry.own(edit)));
  return {
    outcome: outcomeOf(() => entry.build(piece.rendering, edit, piece.at.mdStart)), piece,
  };
}

/**
 * THE READ PAST THE PIECE: the outcome of `edit` built from the whole tab's rendering under
 * the recorder (`recorded`), which throws `ReadPastPiece` on a read of content outside the
 * closure of the edit's own elements. The edit's offsets are the whole tab's. `shrink` has
 * the recorder fail on a read outside another range than the closure.
 */
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
  /**
   * Whether the batch names an index in the element next to the piece's first, where the tab
   * goes on before the piece, by `pieceOverreach`'s own counting.
   */
  readonly nearBefore: boolean;
  /** The same of the element next to the piece's last, where the tab goes on after. */
  readonly nearAfter: boolean;
  /**
   * Whether `pieceOverreach` counts every request of the batch on the side after the piece:
   * `false` where a request that adds length otherwise ends its count.
   */
  readonly counted: boolean;
};

/** An index no tab reaches, and one past every index a batch names after text it inserted. */
const FAR = 2 ** 40;
const FARTHER = 2 ** 50;

/**
 * Holds `edit` built from pieces of `tab` to `edit` built from the whole tab: the closure cut
 * from the whole rendering, the whole rendering under the recorder, and the stored piece
 * under each of `sizings` give the whole tab's batch or its refusal, name and message; a
 * stored piece stands where the closure does, and the batch built from it holds no object of
 * it (`sharedWithPiece`); and a batch the whole tab builds names no index past the closure
 * (`pieceOverreach`). A `ReadPastPiece` is thrown on.
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
  // The predicate itself says how far a batch reaches: asked of a piece whose inner range
  // ends one element short on a side, it names the side for a batch that names an index in
  // that element; and it names a last request far past every index only where it counts
  // that far.
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

// ---------------------------------------------------------------------------
// An edit built from a reading of its tab
// ---------------------------------------------------------------------------

/** A reading a test made of a tab, with the range of elements its last piece held. */
export type ShadowReading = TabReading & {
  /** The elements the last piece held; `undefined` where none was asked. */
  range(): ElementRange | undefined;
};

// A reading of `tab` whose answers of the tab as a whole are the whole rendering's own
// (`wholeTabReading`, asked of the rendering as `docTabToMarkdown` made it) and whose piece
// is what `cut` answers for the closure of the own range, or for the range `shrink` makes
// of it: the rendering to hand the builders, and where it stands, less its reading.
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

/**
 * A reading of `tab` whose piece is THE CLOSURE CUT FROM THE WHOLE RENDERING
 * (`pieceRendering` over `closureOf`'s range, or over the range `shrink` makes of it), where
 * `DocStore.piece` would say it stands; what it answers of the tab as a whole is the whole
 * rendering's.
 */
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
 * THE READ PAST THE PIECE, for whatever is handed a reading: a reading of `tab` whose piece
 * is the whole rendering under the recorder (`recorded`), which throws `ReadPastPiece` on a
 * read of content outside the closure of the own range (or the range `shrink` makes of it).
 * Its Markdown offsets are the whole tab's, so the piece stands at offset 0 with no table
 * before it, between the indexes the closure's outermost elements give. What it answers of
 * the tab as a whole is the whole rendering's, unrecorded: the whole-tab list is exactly a
 * reading's members.
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
  /**
   * For a batch built: whether `pieceOverreach` counts every request of it on the side after
   * the piece, `false` where a request that adds length otherwise ends its count.
   */
  readonly counted?: boolean;
};

/**
 * Holds `edit`, built by `tabEditRequests`, from pieces of `tab` to the same built from the
 * whole tab's reading: the closure's reading, the recorded reading (no `ReadPastPiece`) and
 * the stored reading under each of `sizings` give the whole tab's batch or its refusal, name
 * and message. `matchStart`, for a replacement of a text that stands once: where it stands;
 * the path it takes (`replacementPath`) is then asked of the recorded piece, as a preparation
 * asks it, and is the whole rendering's.
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

// ---------------------------------------------------------------------------
// A table call checked against a reading of its tab, and prepared on a stored tab
// ---------------------------------------------------------------------------

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

/**
 * Holds `call`, checked by `tableCallChange`, on pieces of `tab` to the same checked on the
 * whole tab's reading: the closure's reading, the recorded reading (no `ReadPastPiece`) and
 * the stored reading under each of `sizings` give the whole tab's change or its refusal,
 * name and message.
 */
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

/** What a table call prepared gave: the change's card and number, or the refusal's message. */
export type PreparedOutcome =
  | Pick<PreparedTableChange, "change" | "title" | "description" | "table">
  | { readonly refused: string };

/** `call` prepared on `version` of `store`, undone at its end: nothing of it stays stored. */
function preparedOutcome(store: DocStore, version: DocVersion, call: TableCall): PreparedOutcome {
  try {
    let { change, title, description, table } =
      undone(store, () => prepareTableChange(store, version, call, "the tab"));
    return { change, title, description, ...(table === undefined ? {} : { table }) };
  } catch (error) {
    if (!(error instanceof Error) || error instanceof TypeError || error instanceof ReadPastPiece) throw error;
    return { refused: error.message };
  }
}

/**
 * Runs `run` with every piece a store answers for `tab` (`DocStore.prototype.piece`) made
 * THE WHOLE RENDERING UNDER THE RECORDER: the store's own piece, its decoded runs and its
 * inner indexes as the store made them, but for its rendering, which is `recorded` over the
 * closure's elements, found in the whole as `fromClosure` finds them, and so stands at
 * Markdown offset 0 with no table before it. FOR A PIECE AROUND A TABLE THE RANGE REACHES
 * BACK TO THE LINE BEFORE THE TABLE where the closure does not hold one: a card names the
 * nearest text before its table, which a piece that holds none asks of its tab
 * (`TabReading.lineBefore`), and the whole rendering under the recorder has no other way to
 * answer than to be read that far. `asked` counts the pieces whose range was so widened.
 * The line break just before the range may be read too (`recorded`'s last parameter): the
 * walk back to that line looks for where the range's first line starts. The method is
 * replaced by hand and put back: a spy would keep each piece.
 */
export function withRecordedPieces<T>(tab: GoogleDocsTab, run: () => T): { value: T; asked: number } {
  let { whole, rendering } = renderedOf(tab);
  let { piece } = DocStore.prototype;
  let asked = 0;
  DocStore.prototype.piece = function (this: DocStore, version, at) {
    let made = piece.call(this, version, at);
    let own = ownIn(whole, at.own);
    let { from, to } = closureIn(whole, at.own);
    if (at.own !== "end" && "table" in at.own) {
      let tableStart = whole.starts[own.first];
      // Whether the elements from `first` to the table hold a line that is not a table's.
      let holdsLine = (first: number) => {
        let start = whole.starts[first];
        let tables = rendering.sourceMap.tables.flatMap(({ mdStart, mdEnd }) =>
          mdStart >= start && mdEnd <= tableStart ? [{ mdStart: mdStart - start, mdEnd: mdEnd - start }] : []);
        return lineAbove(rendering.markdown.slice(start, tableStart), tables, tableStart - start) !== undefined;
      };
      if (from > 0 && !holdsLine(from)) {
        asked++;
        while (from > 0 && !holdsLine(from)) from--;
      }
    }
    return {
      ...made,
      rendering: recorded({ rendering, starts: whole.starts, flags: whole.flags }, { from, to }, true),
      at: { ...made.at, mdStart: 0, tablesBefore: 0 },
    };
  };
  try {
    return { value: run(), asked };
  } finally {
    DocStore.prototype.piece = piece;
  }
}

/** What `expectSamePrepared` says of a case, for a test's tally. */
export type PreparedVerdict = {
  /** Whether the call became a change with its card. */
  readonly prepared: boolean;
  /** How many of the recorded pieces were read back to the line before their table. */
  readonly asked: number;
  /** The number the preparation answered for a new table. */
  readonly table?: number;
};

/**
 * Holds `call` PREPARED on `tab` stored under each of `sizings` (`prepareTableChange`: the
 * call's checks, the pending card, the edit and the card's result) with every piece the whole
 * rendering under the recorder (`withRecordedPieces`) to the same prepared as it is: the
 * same change, title, description and number, or the same refusal, under every sizing, and
 * no `ReadPastPiece`. So the checks, the builders and the pending card's reads of its piece
 * are held to the closure and to the one line before the table that a card asks of its tab.
 */
export function expectSamePrepared(
  tab: GoogleDocsTab, call: TableCall, sizings: readonly RunSizes[],
): PreparedVerdict {
  let first: PreparedOutcome | undefined;
  let asked = 0;
  for (let sizes of sizings) {
    let { store, base } = keptFor(tab, sizes);
    let plain = preparedOutcome(store, base, call);
    let guarded = withRecordedPieces(tab, () => preparedOutcome(store, base, call));
    expect(guarded.value).toEqual(plain);
    expect(plain).toEqual(first ?? plain);
    first ??= plain;
    asked += guarded.asked;
  }
  if (!first || "refused" in first) return { prepared: false, asked };
  return { prepared: true, asked, ...(first.table === undefined ? {} : { table: first.table }) };
}


// ---------------------------------------------------------------------------
// A tab inside a larger one
// ---------------------------------------------------------------------------

/** The lists a filler's items are of: a bulleted and a numbered one, made by the presets. */
const FILLER_LISTS: Lists = {
  bulleted: { listProperties: { nestingLevels: presetLevels() } },
  numbered: { listProperties: { nestingLevels: presetLevels(true) } },
};

/** How a filler meets the tab it stands beside: what it ends in before it, or starts with after. */
const BOUNDARIES = [
  "a paragraph", "a heading", "empty paragraphs", "deeper list items", "a table", "a section break",
] as const;

/**
 * The blocks of a filler: seeded prose, a list and a table, of words no recording and no
 * generated tab writes, with its `boundary` at the end it meets the tab at: its last blocks
 * where it stands `before` the tab, its first where it stands after.
 */
function fillerBlocks(seed: number, before: boolean): BlockSpec[] {
  let { below, pick } = diceOf(seed);
  let count = 0;
  let word = () => `${before ? "quox" : "zorp"}${seed}v${count++}`;
  let list = () => pick(["bulleted", "numbered"]);
  let body: BlockSpec[] = [];
  for (let chunk = 3 + below(3); chunk > 0; chunk--) {
    body.push(para(`${word()} blivet prose.`));
    let kind = below(4);
    if (kind === 0) body.push(heading(`${word()} head`, 1 + below(3)));
    if (kind === 1) {
      let listId = list();
      body.push(item(`${word()} item`, listId), item(`${word()} nested`, listId, 1),
        item(`${word()} item`, listId));
    }
    if (kind === 2) body.push(grid([`${word()} cell`, `${word()} cell`]), para(`${word()} after.`));
  }
  let boundary: BlockSpec[];
  switch (pick(BOUNDARIES)) {
    case "a paragraph": boundary = [para(`${word()} edge.`)]; break;
    case "a heading": boundary = [heading(`${word()} edge`, 1 + below(3))]; break;
    case "empty paragraphs": boundary = Array.from({ length: 1 + below(5) }, () => para("")); break;
    case "deeper list items": {
      let listId = list();
      boundary = Array.from({ length: 1 + below(3) },
        () => item(`${word()} deep`, listId, 1 + below(3)));
      // A list starts at level 0 where it stands before the tab; after it, the items are the
      // first of the filler and stand right behind the tab's last element.
      if (before) boundary.unshift(item(`${word()} top`, listId));
      break;
    }
    case "a table": boundary = [grid([`${word()} cell`]), para(below(2) ? "" : `${word()} after.`)]; break;
    case "a section break": boundary = [{ structure: "sectionBreak" }]; break;
  }
  // A body ends in a paragraph: a filler that starts with its boundary ends with its prose.
  return before ? [...body, ...boundary] : [...boundary, ...body, para(`${word()} end.`)];
}

/** A deep copy of `value`, every start and end index moved by `by`, every list id prefixed. */
function moved<T>(value: T, by: number, lists: string): T {
  if (Array.isArray(value)) return value.map(part => moved(part, by, lists)) as T;
  if (value === null || typeof value !== "object") return value;
  let copy: Record<string, unknown> = {};
  for (let [key, held] of Object.entries(value)) {
    copy[key] = (key === "startIndex" || key === "endIndex") && typeof held === "number" ? held + by
      : key === "listId" && typeof held === "string" ? lists + held
      : moved(held, by, lists);
  }
  return copy as T;
}

/** Where the body of `tab` ends. */
const bodyEnd = (tab: GoogleDocsTab) => tab.body.content.at(-1)!.endIndex;

/** `lists` with `prefix` before every id. */
const renamed = (lists: Lists, prefix: string): Lists =>
  Object.fromEntries(Object.entries(lists).map(([id, list]) => [prefix + id, list]));

/**
 * `tab` inside a larger tab: seeded filler before and after it in one body, every index of
 * the tab and of the filler after it moved, so that an edit of the tab's own text has its
 * closure as a strict part of the body. THE BOUNDARY VARIES WITH THE SEED: the filler before
 * ends in, and the filler after starts with, a plain paragraph, a heading, one to five empty
 * paragraphs, list items at levels 1 to 3 of either kind, a table and its paragraph, or a
 * section break. Where `ends`, there is no filler after: the larger tab ends where `tab`
 * does, so that what is built at the tab's end stands after the ending of `tab`, its closure
 * a strict part of the body by the filler before. Pruned, as a stored tab is.
 * @throws Where `tab` does not open with a section break, or the tab made is not indexed as
 * the model indexes a tab (`hasModelIndexes`).
 */
export function sandwiched(tab: GoogleDocsTab, seed: number, ends = false): GoogleDocsTab {
  let [opening, ...rest] = tab.body.content;
  if (!opening?.sectionBreak) throw new Error("The tab does not open with a section break.");
  let before = pruneTab(buildTab(fillerBlocks(seed, true), FILLER_LISTS));
  let after = pruneTab(buildTab(ends ? [] : fillerBlocks(seed + 1, false), FILLER_LISTS));
  let lead = bodyEnd(before) - 1;
  let made: GoogleDocsTab = {
    ...structuredClone(tab),
    body: {
      content: [
        structuredClone(opening),
        ...moved(before.body.content.slice(1), 0, "before."),
        ...moved(rest, lead, ""),
        ...moved(after.body.content.slice(1), lead + bodyEnd(tab) - 1, "after."),
      ],
    },
    lists: {
      ...renamed(before.lists, "before."), ...structuredClone(tab.lists),
      ...renamed(after.lists, "after."),
    },
  };
  if (!hasModelIndexes(made)) throw new Error("The tab made is not indexed as the model indexes.");
  return made;
}
