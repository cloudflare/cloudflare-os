// Every preparation on a stored version gives the card the tab in hand gives, and the strings
// a card reads (`changedMarkdown`) are the rule's worked out on the two whole Markdown strings,
// read without joining what is not shown.

import { afterEach, describe, expect, it, vi } from "vitest";
import { assertGoogleDocDisplaySize, googleDocDisplayLimit } from "../src/doc-actions";
import type { GoogleDocsRequest, GoogleDocsTab, StructuralElement } from "../src/docs-api";
import {
  changedSpan, docEditResult, editedSlice, findUniqueMarkdown, isBlankDocTab, makeDocEdit, renderTab,
  type DocEdit,
} from "../src/docs-replay";
import { RUN_SIZES, type RunSizes } from "../src/docs-runs";
import { DocStore, docStoreCost, type DocVersion } from "../src/docs-store";
import {
  changedMarkdown, prepareAppend, prepareTableChange, prepareTextReplacement, tableCallChange,
  tableChangeFrom, type ChangedMarkdown, type PreparedTableChange, type PreparedTextReplacement,
  type TableCall,
} from "../src/docs-table-actions";
import {
  chipCopies, pinnedAround, replacementPath, resolveTable, wholeTabReading, type TableChange,
} from "../src/docs-tables";
import type { DocTableBorder, DocTableCellStyle } from "../src/docs-types";
import type { DocTabSnapshot, MarkdownRange } from "../src/markdown-converter";
import {
  buildTab, diceOf, grid, item, para, presetLevels, type BlockSpec, type Lists,
} from "./doc-fixture";
import type { FakeDocStorage } from "./doc-store-fake";
import { countedStorage, nestedItemsTab, proseTab, tinyTablesTab } from "./doc-store-scenarios";
import { readFixtures } from "./docs-live-fixtures";
import { SCENARIOS, stepEdit } from "./docs-live-recorder";
import { ReadPastPiece } from "./docs-piece-recorder";
import { pieceStore } from "./docs-piece-shadow";
import { pieceTableEdits, pieceTabs, tabEdits } from "./docs-piece-tabs";
import { asFetched } from "./docs-store-slice-shadow";
import { WIDER } from "./wider-run";

const LABEL = "\"Main\" (tab-1)";
const LIMIT = googleDocDisplayLimit("replaceText");

/** Runs of exactly `elements` elements, a table alone: no run ends by its content. */
const runsOf = (elements: number): RunSizes =>
  ({ least: Infinity, target: Infinity, most: Infinity, elements });
const ONE = runsOf(1);
const TWO = runsOf(2);
const THREE = runsOf(3);

/** What a preparation answered, or the name and message of what it threw. */
type Outcome<T> = { value: T } | { refused: { name: string; message: string } };

/** What `run` answers or refuses with. Anything but a refusal is a defect, and is thrown on. */
function outcome<T>(run: () => T): Outcome<T> {
  try {
    return { value: run() };
  } catch (error) {
    if (!(error instanceof Error) || error instanceof TypeError || error instanceof ReadPastPiece) {
      throw error;
    }
    return { refused: { name: error.name, message: error.message } };
  }
}

// --- The cards from a tab in hand: the reference, from the whole tab's rendering and Markdown.
// Table changes share its card writers (`tableChangeFrom`), pinned in `docs-table-actions.test.ts`.

/** What `prepareTextReplacement` answers of a replacement in `tab`, or throws what it throws. */
function wholeTextReplacement(
  tab: GoogleDocsTab, oldMarkdown: string, newMarkdown: string, label: string,
): PreparedTextReplacement {
  let before = renderTab(tab);
  let { markdown } = before;
  let matchStart = findUniqueMarkdown(markdown, oldMarkdown, tab.tabId);
  let matchEnd = matchStart + oldMarkdown.length;
  let inTable =
    replacementPath(before, { matchStart, oldMarkdown, newMarkdown }).kind === "cells";
  let after = renderTab(makeDocEdit(tab, {
    type: "replaceText", oldMarkdown, newMarkdown, ...(inTable ? { inTable: true } : {}),
  }, before).after).markdown;
  let span = changedSpan(markdown, after, { start: matchStart, end: matchEnd });
  return {
    inTable,
    prose: inTable
      ? `Replace text in a table of tab ${label}. The values below are the table's HTML: ` +
        "Markdown syntax in them is written to the cells as typed."
      : `Replace text in tab ${label}.`,
    syntax: inTable ? "html" : "markdown",
    shown: {
      old: markdown.slice(span.start, span.beforeEnd),
      requested: markdown.slice(span.start, matchStart) + newMarkdown +
        markdown.slice(matchEnd, span.beforeEnd),
      rendered: after.slice(span.start, span.afterEnd),
    },
  };
}

/** What `prepareAppend` answers of an append to `tab`, or throws what it throws. */
function wholeAppend(tab: GoogleDocsTab, markdown: string): string {
  let before = renderTab(tab);
  let after = renderTab(makeDocEdit(tab, { type: "appendText", markdown }, before).after).markdown;
  let added = after;
  if (!isBlankDocTab(before)) {
    let end = before.markdown.length;
    let span = changedSpan(before.markdown, after, { start: end, end });
    added = after.slice(span.start, span.afterEnd).replace(/^\n/, "");
  }
  return added.replace(/\n$/, "");
}

/** What `prepareTableChange` answers of `call` on `tab`, or throws what it throws. */
function wholeTableChange(tab: GoogleDocsTab, call: TableCall, label: string): PreparedTableChange {
  let rendering = renderTab(tab);
  return tableChangeFrom(wholeTabReading(rendering), call, label, change => {
    let made = makeDocEdit(tab, change, rendering);
    return () => {
      let after = renderTab(made.after);
      return {
        before: rendering.markdown, after: after.markdown,
        span: changedSpan(rendering.markdown, after.markdown),
        tables: after.sourceMap.tables,
      };
    };
  });
}

/** A length a look stores (`"12pt"`), as a call gives it: its number of points. */
const pointsOf = (length: string): number => Number(length.slice(0, -2));

/** A border a look stores, as a call gives it. */
function borderOf(border: string): DocTableBorder | null {
  if (border === "none") return null;
  let [width, dash, color] = border.split(" ");
  return { width: pointsOf(width), dash: dash as DocTableBorder["dash"], color };
}

/** The style a call gives for the style a change stores: what the call's check turns into it. */
function styleOf(
  style: Extract<TableChange, { type: "setTableCellStyle" }>["style"],
): DocTableCellStyle {
  let call: DocTableCellStyle = {};
  if (style.background !== undefined) {
    call.background = style.background === "transparent" ? null : style.background;
  }
  if (style.verticalAlign !== undefined) {
    call.verticalAlign = style.verticalAlign as DocTableCellStyle["verticalAlign"];
  }
  if (style.padding) {
    call.padding = Object.fromEntries(
      Object.entries(style.padding).map(([side, length]) => [side, pointsOf(length)]));
  }
  if (style.border !== undefined) call.border = borderOf(style.border);
  if (style.borders) {
    call.borders = Object.fromEntries(
      Object.entries(style.borders).map(([edge, border]) => [edge, borderOf(border)]));
  }
  return call;
}

/** The call, by table number, that makes the stored table change `change` in the tab `whole` renders. */
function stepTableCall(change: TableChange, whole: DocTabSnapshot): TableCall {
  if (change.type === "insertTable") {
    let { rows, columns, cells, after } = change;
    return {
      method: "insertTable",
      table: { rows, columns, cells, ...(after === undefined ? {} : { after }) },
    };
  }
  let table = resolveTable(whole, change, change.type);
  switch (change.type) {
    case "insertTableRows":
      return { method: change.type, lines: { table, at: change.at, cells: change.cells } };
    case "insertTableColumns":
      return {
        method: change.type,
        lines: { table, at: change.at, count: change.cells[0].length, cells: change.cells },
      };
    case "deleteTableRows":
    case "deleteTableColumns":
      return { method: change.type, lines: { table, at: change.at, count: change.count } };
    case "deleteTable":
      return { method: change.type, table };
    case "setTableColumnWidths":
      return {
        method: change.type,
        columns: { table, at: change.at, count: change.count, width: change.width },
      };
    case "setTableRowHeights":
      return {
        method: change.type,
        rows: { table, at: change.at, count: change.count, height: change.height },
      };
    case "mergeTableCells": {
      let { row, column, rows, columns } = change;
      return { method: change.type, cells: { table, row, column, rows, columns } };
    }
    case "unmergeTableCells":
      return { method: change.type, cell: { table, row: change.row, column: change.column } };
    case "setTableCellStyle": {
      let { row, column, rows, columns, style } = change;
      return {
        method: change.type,
        cells: { table, row, column, rows, columns, style: styleOf(style) },
      };
    }
  }
}

// --- Beneath the store

/** One run a version lists, read off `doc_seq` and `doc_md`: its entry and its stored Markdown. */
type ListedRun = { entry: string; markdown: string };

/** The runs `version` lists, in order, each with its stored Markdown, read beneath the store. */
function listedRuns(storage: FakeDocStorage, version: DocVersion): ListedRun[] {
  return storage.sql.exec<{ run: string; context: string; carry: string; md: string }>(
    `SELECT doc_seq.run, doc_seq.context, doc_seq.carry, doc_md.md FROM doc_seq
       JOIN doc_md ON doc_md.doc = ?2 AND doc_md.run = doc_seq.run
         AND doc_md.context = doc_seq.context AND doc_md.carry = doc_seq.carry
     WHERE doc_seq.version = ?1 ORDER BY doc_seq.seq`, version.id, version.doc,
  ).toArray().map(({ run, context, carry, md }) => ({
    entry: `${run} ${context} ${carry}`,
    // Markdown that holds half of a surrogate pair is stored as its JSON behind a mark.
    markdown: md.startsWith("\u0001") ? JSON.parse(md.slice(1)) as string : md,
  }));
}

/** Where each run of `runs` that writes a character starts in its tab's Markdown. */
function writingStarts(runs: readonly ListedRun[]): number[] {
  let starts: number[] = [];
  let at = 0;
  for (let { markdown } of runs) {
    if (markdown.length > 0) starts.push(at);
    at += markdown.length;
  }
  return starts;
}

/** Where two lists of runs differ, as `DocStore.changed` defines it, compared in the test. */
function changedIn(before: readonly ListedRun[], after: readonly ListedRun[]) {
  let from = 0;
  while (from < before.length && before[from].entry === after[from]?.entry) from++;
  let more = after.length - before.length;
  let beforeTo = before.length;
  while (beforeTo > from && beforeTo - 1 + more >= from &&
      before[beforeTo - 1].entry === after[beforeTo - 1 + more]?.entry) {
    beforeTo--;
  }
  return { from, beforeTo, afterTo: beforeTo + more };
}

/** The rows of large columns (`rows`) and the list pages (`pages`) `run` reads, on a store of its own. */
function contentRows<T>(
  storage: FakeDocStorage, sizes: RunSizes, run: (store: DocStore) => T,
): { value: T; rows: number; pages: number } {
  let counted = countedStorage(storage);
  let value = run(new DocStore(counted.storage, undefined, undefined, sizes));
  let { content, pages } = counted.counts();
  return { value, rows: content, pages };
}

// --- The rule on two whole strings

type Range = { start: number; end: number };

/** What `ruleStrings` answers: `changedMarkdown`'s answer, and what the rule met on its way. */
type RuleStrings = {
  mdStart: number;
  before: string;
  after: string;
  span: { start: number; beforeEnd: number; afterEnd: number };
  /** How many runs of `after` were added on each side while the span said `more`. */
  extensions: { before: number; after: number };
  /** The first offset at which the tabs differ, whether it differs, and one past the last. */
  T: number;
  differs: boolean;
  U: number;
};

/**
 * THE REFERENCE: the rule by which `changedMarkdown` chooses its strings, worked out on the two
 * whole Markdown strings `B` and `A` and the starts of `after`'s runs that write a character.
 */
function ruleStrings(B: string, A: string, starts: readonly number[], named?: Range): RuleStrings {
  let LB = B.length, LA = A.length, delta = LA - LB;
  // The run that holds an offset: the last that starts at or before it.
  let holder = (offset: number) => {
    let held = -1;
    while (held + 1 < starts.length && starts[held + 1] <= offset) held++;
    return held;
  };
  let endOf = (run: number) => run < 0 ? LA : starts[run + 1] ?? LA;
  let T = 0, differs = false;
  let limit = named ? named.start : Infinity;
  for (;; T++) {
    if (T >= limit) break;
    if (T >= LB || T >= LA) {
      differs = LB !== LA;
      break;
    }
    if (B.charCodeAt(T) !== A.charCodeAt(T)) {
      differs = true;
      break;
    }
  }
  if (!named && !differs) {
    return {
      mdStart: 0, before: "", after: "", span: { start: 0, beforeEnd: 0, afterEnd: 0 },
      extensions: { before: 0, after: 0 }, T, differs, U: T,
    };
  }
  let first = holder(T);
  if (!named && first > 0) first--;
  let O = first < 0 ? 0 : starts[first];
  let U = LB;
  let floor = Math.max(named ? named.end : O, O - delta);
  while (U > floor && B.charCodeAt(U - 1) === A.charCodeAt(U - 1 + delta)) U--;
  let w = Math.max(U, named ? named.end : 0, Math.min(T + 1, LB));
  let last = holder(Math.max(w + delta, Math.min(T, LA - 1)));
  let Ea = endOf(last);
  let extensions = { before: 0, after: 0 };
  for (;;) {
    let before = B.slice(O, Ea - delta), after = A.slice(O, Ea);
    let span = changedSpan(
      before, after, named && { start: named.start - O, end: named.end - O },
      { before: O > 0, after: Ea < LA });
    if (!("more" in span)) return { mdStart: O, before, after, span, extensions, T, differs, U };
    extensions[span.more]++;
    if (span.more === "after") Ea = endOf(++last);
    else O = starts[--first];
  }
}

/** `span`, in the offsets of strings that start at `by`, in the tab's. */
const moved = (span: RuleStrings["span"], by: number) =>
  ({ start: span.start + by, beforeEnd: span.beforeEnd + by, afterEnd: span.afterEnd + by });

/** What a comparison's readers did: the runs they handed, and those whose Markdown was read. */
type Reads = { handed: number; read: number; most: number };

/** What the strings of every card held to the rule came to, for the file's last test. */
const ruled = {
  cards: 0, alike: 0, extensions: { before: 0, after: 0 }, longest: 0,
  /** The Markdown rows a card read in all, and the most one card read. */
  rows: 0, most: 0,
  /** What the comparison from the front and the one from the end read, over every card. */
  front: { handed: 0, read: 0, most: 0 } as Reads, end: { handed: 0, read: 0, most: 0 } as Reads,
};

/** Runs `run` counting the readers of each comparison: two for the front, then two for the end. */
function countedReaders<T>(run: () => T): T {
  let { reader } = DocStore.prototype;
  let made = 0;
  let card = { front: { handed: 0, read: 0 }, end: { handed: 0, read: 0 } };
  DocStore.prototype.reader = function (this: DocStore, version, place, back) {
    let next = reader.call(this, version, place, back);
    let counts = made < 2 ? card.front : made < 4 ? card.end : undefined;
    made++;
    if (!counts) return next;
    return () => {
      let handed = next();
      if (!handed) return handed;
      counts.handed++;
      return {
        place: handed.place, size: handed.size, summary: handed.summary,
        get entry() {
          return handed.entry;
        },
        markdown() {
          counts.read++;
          return handed.markdown();
        },
      };
    };
  };
  try {
    return run();
  } finally {
    DocStore.prototype.reader = reader;
    for (let side of ["front", "end"] as const) {
      ruled[side].handed += card[side].handed;
      ruled[side].read += card[side].read;
      ruled[side].most = Math.max(ruled[side].most, card[side].read);
    }
  }
}

/**
 * Holds `changedMarkdown` of two stored versions whose whole Markdown is `B` and `A` to the rule:
 * the reference's offset, strings and span, or `"too-long"` exactly where a difference is past
 * `most`; with `tables`, the tables of the tab after that stand in the string after.
 */
function expectRuled(
  kept: { storage: FakeDocStorage; sizes: RunSizes }, before: DocVersion, after: DocVersion,
  B: string, A: string, named?: MarkdownRange | "end", most?: number,
  tables?: readonly MarkdownRange[],
): { answer: ChangedMarkdown | "too-long"; rule: RuleStrings; rows: number; pages: number } {
  let range = named === undefined ? undefined
    : named === "end" ? { start: B.length, end: B.length } : { start: named.mdStart, end: named.mdEnd };
  let rule = ruleStrings(B, A, writingStarts(listedRuns(kept.storage, after)), range);
  let cost = { ...docStoreCost };
  let { value: answer, rows, pages } = contentRows(
    kept.storage, kept.sizes,
    store => countedReaders(() => changedMarkdown(store, before, after, named, most)));
  expect(docStoreCost.runsDecoded - cost.runsDecoded).toBe(0);
  expect(docStoreCost.runsRendered - cost.runsRendered).toBe(0);
  ruled.cards++;
  ruled.rows += rows;
  ruled.most = Math.max(ruled.most, rows);
  if (answer === "too-long") {
    expect(range && most !== undefined &&
      ((rule.differs && range.start - rule.T > most) || rule.U - range.end > most)).toBe(true);
    return { answer, rule, rows, pages };
  }
  if (range && most !== undefined) {
    expect(rule.differs && range.start - rule.T > most).toBe(false);
    expect(rule.U - range.end > most).toBe(false);
  }
  let { mdStart, span } = answer;
  expect({ mdStart, before: answer.before, after: answer.after, span }).toEqual({
    mdStart: rule.mdStart, before: rule.before, after: rule.after, span: rule.span,
  });
  if (B === A && !range) {
    ruled.alike++;
  } else {
    expect(moved(span, mdStart)).toEqual(changedSpan(B, A, range));
  }
  ruled.extensions.before += rule.extensions.before;
  ruled.extensions.after += rule.extensions.after;
  ruled.longest = Math.max(ruled.longest, rule.extensions.before, rule.extensions.after);
  // The tables of the string after are those of the tab after that stand in it.
  if (tables) {
    let end = mdStart + answer.after.length;
    expect(answer.tables.map(table => ({ mdStart: table.mdStart + mdStart, mdEnd: table.mdEnd + mdStart })))
      .toEqual(tables.flatMap(({ mdStart: start, mdEnd }) =>
        start >= mdStart && mdEnd <= end ? [{ mdStart: start, mdEnd }] : []));
  }
  return { answer, rule, rows, pages };
}

/** What `expectChanged` held, for the test of `DocStore.changed`. */
const listed = { pairs: 0, runs: 0, anew: 0 };

/**
 * Holds `DocStore.changed` to the two lists compared entry by entry, and every run listed to
 * read as nothing or end with a line break, which the strings lean on.
 */
function expectChanged(kept: { storage: FakeDocStorage; store: DocStore }, before: DocVersion, after: DocVersion) {
  let runs = listedRuns(kept.storage, after);
  let changed = kept.store.changed(before, after);
  expect(changed).toEqual(changedIn(listedRuns(kept.storage, before), runs));
  listed.pairs++;
  listed.anew += changed.afterTo - changed.from;
  for (let { markdown } of runs) {
    listed.runs++;
    // A finding where it fails: the run's place alone is said, and nothing of its text.
    expect(markdown === "" || markdown.endsWith("\n"), `run ${listed.runs}`).toBe(true);
  }
  return changed;
}

// --- A queue prepared in a store and in hand

/** What a test counts of the steps it prepared, by kind. */
type Tally = Record<string, { prepared: number; refused: number; unmapped: number }>;

const tallied = (tally: Tally, kind: string) =>
  tally[kind] ??= { prepared: 0, refused: 0, unmapped: 0 };

/** A tab in hand and the version of it in a store of its own, cut to `sizes`. */
type Chain = {
  tab: GoogleDocsTab; version: DocVersion; store: DocStore; storage: FakeDocStorage; sizes: RunSizes;
};

function chainOf(tab: GoogleDocsTab, sizes: RunSizes): Chain {
  let { storage, store, base } = pieceStore(tab, sizes);
  return { tab, version: base, store, storage, sizes };
}

/**
 * Prepares `edit` (or the table `call`, `edit` then the change it must become) on the chain's
 * version and on its tab in hand, holds the two cards and the strings to the rule, and moves
 * the chain on.
 */
function heldStep(
  chain: Chain, edit: DocEdit | undefined, tally: Tally, call?: TableCall,
): ReturnType<typeof expectRuled> | undefined {
  let { tab, version, store } = chain;
  let whole = renderTab(tab);
  let stored: Outcome<unknown>, inHand: Outcome<unknown>;
  let named: MarkdownRange | "end" | undefined;
  if (call) {
    stored = outcome(() => prepareTableChange(store, version, call, LABEL));
    inHand = outcome(() => wholeTableChange(tab, call, LABEL));
    if ("value" in stored) {
      let { change } = stored.value as { change: TableChange };
      if (edit) expect(change).toEqual(edit);
      edit = change;
    }
  } else if (!edit) {
    throw new Error("A step is an edit or a call.");
  } else if (edit.type === "replaceText") {
    let { oldMarkdown, newMarkdown } = edit;
    stored = outcome(() => prepareTextReplacement(store, version, oldMarkdown, newMarkdown, LABEL, LIMIT));
    inHand = outcome(() => wholeTextReplacement(tab, oldMarkdown, newMarkdown, LABEL));
    let mdStart = whole.markdown.indexOf(oldMarkdown);
    named = { mdStart, mdEnd: mdStart + oldMarkdown.length };
    if ("value" in stored) {
      expect((stored.value as { inTable: boolean }).inTable).toBe(edit.inTable ?? false);
    }
    if (mdStart < 0) named = undefined;
  } else if (edit.type === "appendText") {
    let { markdown } = edit;
    stored = outcome(() => prepareAppend(store, version, markdown));
    inHand = outcome(() => wholeAppend(tab, markdown));
    named = "end";
  } else {
    throw new Error("A table change is prepared by its call.");
  }
  expect(stored).toEqual(inHand);
  let counts = tallied(tally, call?.method ?? edit!.type);
  if ("refused" in inHand || !edit) {
    counts.refused++;
    return undefined;
  }
  counts.prepared++;
  let after = docEditResult(store, version, edit).after;
  let made = makeDocEdit(tab, edit, whole).after;
  expectChanged(chain, version, after);
  // A blank tab's append reads the tab after whole, and no span.
  let held: ReturnType<typeof expectRuled> | undefined;
  if (!(edit.type === "appendText" && isBlankDocTab(whole))) {
    let rendered = renderTab(made);
    held = expectRuled(
      chain, version, after, whole.markdown, rendered.markdown, named,
      edit.type === "replaceText" ? LIMIT.chars : undefined, rendered.sourceMap.tables);
  }
  chain.tab = made;
  chain.version = after;
  return held;
}

/** Every recorded scenario with a recording: its tab before, as a fetch hands it, and its steps. */
const RECORDED = readFixtures().map(({ name, before }) => ({
  name, before: asFetched(before),
  steps: SCENARIOS.find(candidate => candidate.name === name)!.steps,
}));

/** Prepares a recording's steps in order on `tab`; a step its tab does not take is `skipped`. */
function heldRecording(
  tab: GoogleDocsTab, steps: (typeof RECORDED)[number]["steps"], sizes: RunSizes, tally: Tally,
): void {
  let chain = chainOf(tab, sizes);
  for (let step of steps) {
    let whole = renderTab(chain.tab);
    let edit = outcome(() => stepEdit(step, whole));
    if ("refused" in edit) {
      tallied(tally, "skipped").refused++;
      continue;
    }
    let made = edit.value;
    if (made.type === "replaceText" || made.type === "appendText") {
      heldStep(chain, made, tally);
      continue;
    }
    // A recorded row insertion records what its reference row copies and whether it is pinned,
    // as one queued now does.
    if (made.type === "insertTableRows" && (made.copies === undefined || made.pinned === undefined)) {
      let target = whole.sourceMap.tables[resolveTable(whole, made, made.type)];
      let reference = Math.min(made.at, target.rows.length - 1);
      made = { ...made, copies: chipCopies(target, reference), pinned: pinnedAround(target, made.at) };
    }
    // A table step is prepared by the call naming its table by number, which must give the same
    // change.
    let call = outcome(() => stepTableCall(made, whole));
    let mapped = "value" in call
      ? outcome(() => tableCallChange(wholeTabReading(whole), (call as { value: TableCall }).value))
      : call;
    if (!("value" in call) || !("value" in mapped) || !sameChange(mapped.value as TableChange, made)) {
      tallied(tally, made.type).unmapped++;
      // The step still moves the chain, as the model makes it.
      let after = outcome(() => makeDocEdit(chain.tab, made, whole).after);
      if ("value" in after) {
        chain.version = docEditResult(chain.store, chain.version, made).after;
        chain.tab = after.value;
      }
      continue;
    }
    heldStep(chain, made, tally, call.value);
  }
}

/** Whether two table changes are the same change, member by member. */
function sameChange(left: TableChange, right: TableChange): boolean {
  try {
    expect(left).toEqual(right);
    return true;
  } catch {
    return false;
  }
}

/** A tally by what it counts: the steps prepared and those the call cannot say, by kind. */
function summed(tally: Tally) {
  let by = (count: keyof Tally[string]) => Object.fromEntries(
    Object.entries(tally).flatMap(([kind, counts]) => counts[count] ? [[kind, counts[count]]] : []));
  return { prepared: by("prepared"), refused: by("refused"), unmapped: by("unmapped") };
}

/** The steps the recordings prepare, by kind: every step of every recording, and none refused. */
const RECORDED_STEPS = {
  appendText: 71, replaceText: 95, insertTable: 11, insertTableRows: 5, insertTableColumns: 4,
  deleteTableRows: 3, deleteTableColumns: 1, deleteTable: 1, setTableCellStyle: 7,
  setTableColumnWidths: 4, setTableRowHeights: 1, mergeTableCells: 3, unmergeTableCells: 3,
};

/** What `ruled` held once the recorded and the seeded queues were prepared. */
let queued: typeof ruled | undefined;

const SIZINGS = [["one element a run", ONE], ["the real cut", RUN_SIZES]] as const;

describe("the cards from stored runs against the cards from the whole tab", () => {
  it.each(SIZINGS)("the recorded queues, %s", (_name, sizes) => {
    let tally: Tally = {};
    for (let { before, steps } of RECORDED) heldRecording(before, steps, sizes, tally);
    expect(summed(tally)).toEqual({ prepared: RECORDED_STEPS, refused: {}, unmapped: {} });
  });

  const QUEUES = WIDER ? 60 : 25;

  it("seeded queues", () => {
    let tally: Tally = {};
    let seed = 20261119 + 4100;
    for (let [number, tab] of pieceTabs(seed, QUEUES).entries()) {
      // Two text edits and two table calls by turns, each in the tab the steps before gave.
      let texts = tabEdits(tab, seed + 7919 * (number + 1), 4).slice(0, 2);
      let calls = pieceTableEdits(tab, seed + 104729 * (number + 1), 8)
        .flatMap(({ call }) => call ? [call] : []).slice(0, 2);
      for (let sizes of WIDER ? [ONE, RUN_SIZES] : [number % 2 ? RUN_SIZES : ONE]) {
        let chain = chainOf(tab.tab, sizes);
        for (let at of [0, 1]) {
          if (texts[at]) heldStep(chain, texts[at].edit, tally);
          if (calls[at]) heldStep(chain, undefined, tally, calls[at]);
        }
      }
    }
    let { prepared, refused } = summed(tally);
    let sum = (counts: Record<string, number>) => Object.values(counts).reduce((all, count) => all + count, 0);
    queued = structuredClone(ruled);
    expect(prepared.replaceText + prepared.appendText).toBeGreaterThanOrEqual(WIDER ? 100 : 20);
    expect(sum(prepared) - prepared.replaceText - prepared.appendText).toBeGreaterThanOrEqual(WIDER ? 60 : 12);
    expect(sum(refused)).toBeGreaterThanOrEqual(WIDER ? 40 : 8);
  });
});

// --- A card that reads far from its edit

/** A version made BY HAND: `requests` applied by the model and stored, with no edit or builder. */
function madeByHand(store: DocStore, version: DocVersion, requests: readonly GoogleDocsRequest[]): DocVersion {
  let { slice, made } = editedSlice(store, version, "by hand", requests);
  return store.transaction(() => store.putSlice(slice, made));
}

/**
 * A version made BY HAND: the runs holding indexes `from` to `to` cut again to `sizes`, with
 * `change` (one that moves no index) made in their elements first.
 */
function recut(
  storage: FakeDocStorage, version: DocVersion, sizes: RunSizes, from: number, to: number,
  change?: (content: StructuralElement[]) => void,
): DocVersion {
  let store = new DocStore(storage, undefined, undefined, sizes);
  let slice = store.slice(version, { from, to, behind: [] });
  change?.(slice.piece.content);
  return store.transaction(() => store.putSlice(slice, { moved: 0, footnotesMoved: false, lists: [] }));
}

/** Gives the paragraph `element` another first character: its text reads otherwise, no index moves. */
function reworded(element: StructuralElement): void {
  let run = element.paragraph!.elements[0].textRun!;
  run.content = `#${run.content.slice(1)}`;
}

/** The request that removes the paragraph `element` of the tab `tabId` whole. */
const removal = (tabId: string, { startIndex, endIndex }: StructuralElement): GoogleDocsRequest =>
  ({ deleteContentRange: { range: { startIndex, endIndex, tabId } } });

/** A tab of `lines` paragraphs, line n holding its number and filler: 100 characters each. */
const linesOf = (lines: number, then: BlockSpec[] = []): GoogleDocsTab => asFetched(buildTab([
  ...Array.from({ length: lines }, (_, at) => para(`Line ${at} ${"-".repeat(100)}`.slice(0, 100))), ...then,
]));

/** Where each run of `runs` starts in its tab's Markdown. */
const runStarts = (runs: readonly ListedRun[]): number[] =>
  runs.map((_, at) => runs.slice(0, at).reduce((sum, run) => sum + run.markdown.length, 0));

/** A numbered list as Google's preset makes it, keyed `N1`. */
const PRESET_NUMBERED: Lists = { N1: { listProperties: { nestingLevels: presetLevels(true) } } };

/** A numbered list of two items, `between` paragraphs and its third item, which an added item renumbers. */
function continuedList(between: number, text = (at: number) => `Filler ${at}.`): GoogleDocsTab {
  return asFetched(buildTab([
    para("Intro"), item("one", "N1"), item("two", "N1"),
    ...Array.from({ length: between }, (_, at) => para(text(at))),
    item("three", "N1"), para("End"),
  ], PRESET_NUMBERED));
}

/** The item `continuedList`'s first part gains. */
const ADDED = { oldMarkdown: "1. two\n", newMarkdown: "1. two\n1. added\n" };

/** A replacement prepared on `tab` kept under `sizes` (`heldStep`), with the versions before and after. */
function heldReplacementOf(tab: GoogleDocsTab, sizes: RunSizes, oldMarkdown: string, newMarkdown: string) {
  let chain = chainOf(tab, sizes);
  let before = chain.version;
  let tally: Tally = {};
  heldStep(chain, { type: "replaceText", oldMarkdown, newMarkdown }, tally);
  expect(summed(tally)).toEqual({ prepared: { replaceText: 1 }, refused: {}, unmapped: {} });
  return { ...chain, before, after: chain.version };
}

describe("a card that reads far from its edit", () => {
  it.each(SIZINGS)("an item renumbered many runs later, %s", (_name, sizes) => {
    for (let between of [2, 20, 200]) {
      let tab = continuedList(between);
      let chain = chainOf(tab, sizes);
      let whole = wholeTextReplacement(tab, ADDED.oldMarkdown, ADDED.newMarkdown, LABEL);
      // The span runs from the item added to the line renumbered.
      expect(whole.shown.old.startsWith("1. two\n\nFiller 0.")).toBe(true);
      expect(whole.shown.old.endsWith(`Filler ${between - 1}.\n\n3. three`)).toBe(true);
      expect(whole.shown.rendered.endsWith("\n\n4. three")).toBe(true);
      let tally: Tally = {};
      heldStep(chain, { type: "replaceText", ...ADDED }, tally);
      expect(summed(tally).prepared).toEqual({ replaceText: 1 });
    }
  });

  /** What `docs.ts` checks of a replacement's card: what it shows beyond the two texts. */
  function assertShown(shown: { old: string; requested: string; rendered: string }, oldMarkdown: string): void {
    let at = shown.old.indexOf(oldMarkdown);
    assertGoogleDocDisplaySize("replaceText", {
      tab: LABEL,
      context: { before: shown.old.slice(0, at), after: shown.old.slice(at + oldMarkdown.length) },
      ...(shown.rendered === shown.requested ? {} : { rendered: shown.rendered }),
    });
  }

  it.each(SIZINGS)("past the display limit, %s", (_name, sizes) => {
    // More than 1 MiB of paragraphs between the item added and the item renumbered.
    let tab = continuedList(40, at => `Filler ${at}. ${"x".repeat(30_000)}`);
    let { oldMarkdown, newMarkdown } = ADDED;
    let refusal = LIMIT.refusal().message;
    let whole = wholeTextReplacement(tab, oldMarkdown, newMarkdown, LABEL);
    expect(whole.shown.old.length).toBeGreaterThan(LIMIT.chars);
    expect(outcome(() => assertShown(whole.shown, oldMarkdown)))
      .toEqual({ refused: { name: "Error", message: refusal } });
    // The stored tab's card is refused with the same text, first and with its result stored.
    let { storage, store, base } = pieceStore(tab, sizes);
    let prepare = () => outcome(() => prepareTextReplacement(store, base, oldMarkdown, newMarkdown, LABEL, LIMIT));
    expect(prepare()).toEqual({ refused: { name: "Error", message: refusal } });
    docStoreCost.peakMarkdownCharsInHand = 0;
    expect(prepare()).toEqual({ refused: { name: "Error", message: refusal } });
    let peak = docStoreCost.peakMarkdownCharsInHand;
    let { after } = docEditResult(store, base, { type: "replaceText", oldMarkdown, newMarkdown });
    let longest = Math.max(longestOf(storage, base), longestOf(storage, after));
    // In hand: the builders' piece (under three runs) and one run of each version compared.
    expect(peak).toBeLessThanOrEqual(3 * longest + oldMarkdown.length + newMarkdown.length);
    // `changedMarkdown` refuses having read a few runs and joined no string.
    let B = renderTab(tab).markdown, A = store.markdown(after);
    let mdStart = B.indexOf(oldMarkdown);
    docStoreCost.peakMarkdownCharsInHand = 0;
    let { answer, rows } = expectRuled(
      { storage, sizes }, base, after, B, A, { mdStart, mdEnd: mdStart + oldMarkdown.length }, LIMIT.chars);
    expect(answer).toBe("too-long");
    expect(docStoreCost.peakMarkdownCharsInHand).toBeLessThanOrEqual(longest);
    expect(docStoreCost.peakMarkdownCharsInHand).toBeGreaterThanOrEqual("3. three\n".length);
    expect(rows).toBeGreaterThan(0);
    expect(rows).toBeLessThanOrEqual(4);
    expect(listedRuns(storage, after).length).toBeGreaterThan(40);
  });

  const heldReplacement = heldReplacementOf;

  describe("what the whole Markdown shows to fit is not refused early", () => {
    it.each(SIZINGS)("a replacement of 0.45 MiB that spans many runs, %s", (_name, sizes) => {
      let line = (word: string, at: number) => `${word} ${at} ${"lorem ipsum ".repeat(840)}`.slice(0, 10_000);
      let tab = asFetched(proseTab("tab-1", 60, at => line("Paragraph", at)));
      let B = renderTab(tab).markdown;
      let oldMarkdown = B.slice(B.indexOf("Paragraph 5 "), B.indexOf("\n\nParagraph 53 "));
      let newMarkdown = Array.from({ length: 48 }, (_, at) => line("Other", at)).join("\n\n");
      expect(oldMarkdown.length).toBeGreaterThan(0.45 * 1024 * 1024);
      expect(newMarkdown.length).toBeGreaterThan(0.45 * 1024 * 1024);
      // The whole tab's card shows the two texts alone, and passes the check.
      let whole = wholeTextReplacement(tab, oldMarkdown, newMarkdown, LABEL);
      assertShown(whole.shown, oldMarkdown);
      let { storage, before } = heldReplacement(tab, sizes, oldMarkdown, newMarkdown);
      expect(listedRuns(storage, before).length).toBeGreaterThan(sizes === ONE ? 60 : 10);
    });

    it("a deletion at the end of the runs read, before runs that repeat what was removed", () => {
      // A paragraph, and one line repeated in paragraphs that hold more than the limit.
      let line = "y".repeat(30_000);
      let tab = asFetched(buildTab([para("Intro"), para("Only once"), ...Array.from({ length: 40 }, () => para(line))]));
      let B = renderTab(tab).markdown;
      let oldMarkdown = `Only once\n\n${line}\n\n${line}`, newMarkdown = "Only once";
      let mdStart = B.indexOf(oldMarkdown);
      let named = { mdStart, mdEnd: mdStart + oldMarkdown.length };
      let { storage, before, after } = heldReplacement(tab, ONE, oldMarkdown, newMarkdown);
      let A = renderTab(makeDocEdit(tab, { type: "replaceText", oldMarkdown, newMarkdown }).after).markdown;
      // The lists differ past the last run of the range named, at the end of the equal runs.
      let runs = listedRuns(storage, before);
      let changed = changedIn(runs, listedRuns(storage, after));
      let starts = runs.map((_, at) => runs.slice(0, at).reduce((sum, run) => sum + run.markdown.length, 0));
      let lastNamed = starts.findLastIndex(start => start < named.mdEnd);
      expect(changed.from).toBeGreaterThan(lastNamed);
      expect(changed.from).toBe(runs.length - 2);
      // Read: two runs where the end's comparison meets the range, then the strings' (1 after, 3
      // before).
      let { answer, rows } = expectRuled({ storage, sizes: ONE }, before, after, B, A, named, LIMIT.chars);
      expect(answer).not.toBe("too-long");
      expect(rows).toBe(2 + 1 + 3);
      // With no range named the span stands at the row's end, and no run is added for it.
      let unnamed = expectRuled({ storage, sizes: ONE }, before, after, B, A);
      expect(unnamed.rule.extensions).toEqual({ before: 0, after: 0 });
      expect(unnamed.rule.mdStart).toBeGreaterThan(LIMIT.chars);
    });

    it("what stands after the last character that differs is not counted", () => {
      // By hand: runs A, C, D, D, E before and A, D, E after; D one entry of 30,000 chars, range in
      // C.
      let long = "d".repeat(30_000);
      let tab = asFetched(buildTab([para("A"), para("Short line here"), para(long), para(long), para("E")]));
      let { storage, store, base } = pieceStore(tab, ONE);
      let [, , short, first] = tab.body.content;
      let after = madeByHand(store, base, [
        { deleteContentRange: { range: { startIndex: short.startIndex, endIndex: first.endIndex, tabId: tab.tabId } } },
      ]);
      let before = listedRuns(storage, base), runs = listedRuns(storage, after);
      expect(before.map(run => run.markdown.length)).toEqual([0, 2, 17, 30_002, 30_002, 3]);
      expect(runs.map(run => run.entry)).toEqual([before[0], before[1], before[4], before[5]].map(run => run.entry));
      expect(before[3].entry).toBe(before[4].entry);
      expect(changedIn(before, runs)).toEqual({ from: 2, beforeTo: 4, afterTo: 2 });
      let B = before.map(run => run.markdown).join(""), A = runs.map(run => run.markdown).join("");
      let mdStart = B.indexOf("line");
      let named = { mdStart, mdEnd: mdStart + "line".length };
      let whole = changedSpan(B, A, { start: named.mdStart, end: named.mdEnd });
      // The strings start at C; the comparison from the end stops at once, at the first D's end.
      let end = { ...ruled.end };
      let fits = expectRuled({ storage, sizes: ONE }, base, after, B, A, named, 40_000);
      if (fits.answer === "too-long") throw new Error("Refused what fits.");
      // The side of the version after stops where the strings start: no run is handed it.
      expect(ruled.end).toEqual(end);
      expect(fits.answer.mdStart).toBe(2);
      expect(fits.answer.after).toBe(runs[2].markdown);
      expect(fits.answer.before).toBe(before[2].markdown + before[3].markdown + before[4].markdown);
      expect(fits.rule.extensions).toEqual({ before: 0, after: 0 });
      expect(fits.rule.U).toBe(2 + 17 + 30_002);
      // The string is over the limit and the span under it: the second D is not counted.
      expect(fits.answer.before.length).toBeGreaterThan(40_000);
      expect(whole.beforeEnd - whole.start).toBeLessThan(40_000);
      // Under a limit smaller than the D removed, the card is refused.
      expect(expectRuled({ storage, sizes: ONE }, base, after, B, A, named, 20_000).answer).toBe("too-long");
      expect(whole.beforeEnd - named.mdEnd).toBeGreaterThan(20_000);
    });

    it("a later run listed under another key that reads as before is compared, and not counted", () => {
      // More than the limit between the text replaced and a run near the tab's end.
      let tab = asFetched(buildTab([
        para("Intro"), para("Target line"),
        ...Array.from({ length: 40 }, (_, at) => para(`Filler ${at}. ${"x".repeat(30_000)}`)),
        para("Far line"), para("End"),
      ]));
      let oldMarkdown = "Target line", newMarkdown = "Changed line";
      let { storage, store, before, after } = heldReplacement(tab, ONE, oldMarkdown, newMarkdown);
      // Beneath the store, the far run is listed under another carry key with the same rendering.
      let far = listedRuns(storage, after).length - 2;
      storage.sql.exec(
        `INSERT INTO doc_md (doc, run, context, carry, made, summary, md)
           SELECT doc, run, context, 'far', made, summary, md FROM doc_md WHERE (run, context, carry) IN
             (SELECT run, context, carry FROM doc_seq WHERE version = ? AND seq = ?)`, after.id, far);
      storage.sql.exec("UPDATE doc_seq SET carry = 'far' WHERE version = ? AND seq = ?", after.id, far);
      let runs = listedRuns(storage, before), anew = listedRuns(storage, after);
      expect(anew[far].entry).not.toBe(runs[far].entry);
      expect(anew[far].markdown).toBe(runs[far].markdown);
      expect(store.changed(before, after)).toEqual({ from: 2, beforeTo: far + 1, afterTo: far + 1 });
      // The card is the whole tab's: the far run is compared, reads alike, and is in neither string.
      expect(prepareTextReplacement(store, before, oldMarkdown, newMarkdown, LABEL, LIMIT))
        .toEqual(wholeTextReplacement(tab, oldMarkdown, newMarkdown, LABEL));
      let B = runs.map(run => run.markdown).join(""), A = anew.map(run => run.markdown).join("");
      let mdStart = B.indexOf(oldMarkdown);
      let { answer, rows } = expectRuled(
        { storage, sizes: ONE }, before, after, B, A, { mdStart, mdEnd: mdStart + oldMarkdown.length }, LIMIT.chars);
      if (answer === "too-long") throw new Error("Refused what fits.");
      expect(answer.before.length + answer.after.length).toBeLessThan(100);
      // The edit's own run of each version, thrice, and the far run of each; none between.
      expect(rows).toBe(3 * 2 + 2);
    });
  });
});

/** The level-1 item of `nestedItemsTab` made a level-0 item. */
const OUTDENTED = { oldMarkdown: "  - target item", newMarkdown: "- target item" };

/** `OUTDENTED` prepared on `nestedItemsTab` kept under `sizes` (`heldStep`), with what its card read. */
function heldOutdented(items: number, chars: number, sizes: RunSizes) {
  let tab = nestedItemsTab("tab-1", items, chars);
  let { oldMarkdown, newMarkdown } = OUTDENTED;
  let chain = chainOf(tab, sizes);
  let before = chain.version;
  let tally: Tally = {};
  heldStep(chain, { type: "replaceText", oldMarkdown, newMarkdown }, tally);
  expect(summed(tally)).toEqual({ prepared: { replaceText: 1 }, refused: {}, unmapped: {} });
  let { storage, version: after } = chain;
  let runs = { before: listedRuns(storage, before), after: listedRuns(storage, after) };
  let B = runs.before.map(run => run.markdown).join(""), A = runs.after.map(run => run.markdown).join("");
  let mdStart = B.indexOf(oldMarkdown);
  // The runs of a version that end at or before the range named, and the Markdown they write.
  let ahead = (of: readonly ListedRun[]) => {
    let count = 0, length = 0;
    while (length + of[count].markdown.length <= mdStart) length += of[count++].markdown.length;
    return { count, length };
  };
  let changed = chain.store.changed(before, after);
  docStoreCost.peakMarkdownCharsInHand = 0;
  let { answer, rows } = expectRuled(
    chain, before, after, B, A, { mdStart, mdEnd: mdStart + oldMarkdown.length }, LIMIT.chars);
  if (answer === "too-long") throw new Error("Refused what fits.");
  return {
    runs, changed, mdStart, answer, rows, texts: oldMarkdown.length + newMarkdown.length,
    // Whether the two versions read alike before the range named.
    alike: A.slice(0, mdStart) === B.slice(0, mdStart),
    ahead: { before: ahead(runs.before), after: ahead(runs.after) },
    peak: docStoreCost.peakMarkdownCharsInHand,
    longest: Math.max(...runs.before.map(run => run.markdown.length), ...runs.after.map(run => run.markdown.length)),
  };
}

describe("text listed anew that reads as before is not read into the strings", () => {
  it("a nested list over the limit, bulleted again, is not refused", () => {
    // Over 1 MiB of items before the range, under the real cut: runs there do not line up yet read
    // alike.
    let held = heldOutdented(600, 2_000, RUN_SIZES);
    expect(held.mdStart).toBeGreaterThan(LIMIT.chars);
    expect(held.ahead.after.count).not.toBe(held.ahead.before.count);
    expect(held.alike).toBe(true);
    expect(held.changed.from).toBe(0);
    expect(held.answer.before.length).toBeLessThanOrEqual(held.texts + 2 * held.longest);
    expect(held.answer.after.length).toBeLessThanOrEqual(held.texts + 2 * held.longest);
    // Every run listed anew is read once a version and none is joined.
    expect(held.rows).toBeLessThanOrEqual(held.runs.before.length + held.runs.after.length + 6);
    expect(held.peak).toBeLessThanOrEqual(2 * held.longest + held.texts);
  });

  it("the items before an item made a level-0 one, one element a run", () => {
    let held = heldOutdented(3_000, 100, ONE);
    let { before, after } = held.runs;
    let { from } = held.changed;
    // The lists differ before the range named, in two runs that read alike.
    expect(from).toBeLessThan(held.ahead.before.count);
    expect(after[from].entry).not.toBe(before[from].entry);
    expect(after[from].markdown).toBe(before[from].markdown);
    expect(held.alike).toBe(true);
    expect(held.mdStart).toBeGreaterThan(300_000);
    expect(held.answer.before.length).toBeLessThanOrEqual(held.texts + 2 * held.longest);
    expect(held.answer.after.length).toBeLessThanOrEqual(held.texts + 2 * held.longest);
    // The strings start at the run of the version after that holds the range's start.
    expect(held.answer.mdStart).toBe(held.ahead.after.length);
    expect(held.peak).toBeLessThanOrEqual(2 * held.longest + held.texts);
    expect(held.rows).toBeLessThanOrEqual(held.runs.before.length + held.runs.after.length + 6);
    expect(held.rows).toBeGreaterThanOrEqual(held.ahead.before.count + held.ahead.after.count - 6);
  });

  const FOUR = runsOf(4);

  it("by hand: lines before the range named, cut otherwise, are compared and never joined", () => {
    // 90 lines, three to a run before and four after, the range named in line 80.
    let tab = linesOf(90);
    let { storage, base } = pieceStore(tab, THREE);
    let { content } = tab.body;
    let B = renderTab(tab).markdown;
    let mdStart = B.indexOf("Line 80 ");
    let named = { mdStart, mdEnd: mdStart + 20 };
    let kept = { storage, sizes: THREE };
    let before = listedRuns(storage, base);

    // Every line before the range equal: not refused, the strings start at the run that holds
    // the range's start, and every run before is read once a version and never joined.
    let alike = recut(storage, base, FOUR, 0, content[85].endIndex);
    let after = listedRuns(storage, alike);
    expect(after.map(run => run.markdown).join("")).toBe(B);
    expect(changedIn(before, after).from).toBe(0);
    expect(after.slice(0, 20).map(run => run.markdown.length)).not.toEqual(before.slice(0, 20).map(run => run.markdown.length));
    docStoreCost.peakMarkdownCharsInHand = 0;
    let same = expectRuled(kept, base, alike, B, B, named, 10);
    if (same.answer === "too-long") throw new Error("Refused what fits.");
    let holds = runStarts(after).findLast(start => start <= mdStart)!;
    expect(same.answer.mdStart).toBe(holds);
    let ahead = (runs: readonly ListedRun[]) => runStarts(runs).filter(start => start <= mdStart).length;
    expect(same.rows).toBeGreaterThanOrEqual(ahead(before) + ahead(after));
    expect(docStoreCost.peakMarkdownCharsInHand).toBeLessThanOrEqual(2 * 4 * 102);

    // The range inside the run both lists share after those cut otherwise: the strings start there.
    let c = changedIn(before, after);
    let shared = runStarts(after)[c.afterTo];
    expect(after[c.afterTo].entry).toBe(before[c.beforeTo].entry);
    expect(runStarts(before)[c.beforeTo]).toBe(shared);
    let inShared = B.indexOf("Line 84 ") + 3;
    expect(inShared).toBeGreaterThan(shared);
    expect(inShared + 20).toBeLessThan(shared + after[c.afterTo].markdown.length);
    let passed = expectRuled(kept, base, alike, B, B, { mdStart: inShared, mdEnd: inShared + 20 }, 10);
    if (passed.answer === "too-long") throw new Error("Refused what fits.");
    expect(passed.answer.mdStart).toBe(shared);
    expect(passed.answer.span).toEqual({
      start: inShared - shared, beforeEnd: inShared + 20 - shared, afterEnd: inShared + 20 - shared,
    });

    // One line far before that reads otherwise: refused where the front finds it, no run after read.
    let far = recut(storage, base, FOUR, 0, content[85].endIndex, elements => reworded(elements[4]));
    let A = listedRuns(storage, far).map(run => run.markdown).join("");
    let differs = B.indexOf("Line 3 ");
    expect(A.indexOf("#ine 3 ")).toBe(differs);
    let whole = changedSpan(B, A, { start: named.mdStart, end: named.mdEnd });
    expect(named.mdStart - whole.start).toBeGreaterThan(5_000);
    let refused = expectRuled(kept, base, far, B, A, named, 5_000);
    expect(refused.answer).toBe("too-long");
    let upTo = (runs: readonly ListedRun[]) => runStarts(runs).filter(start => start <= differs).length;
    expect(refused.rows).toBe(upTo(before) + upTo(listedRuns(storage, far)));
    // One list page of each version.
    expect(refused.pages).toBe(2);
    // The range at the tab's end: refused once the summaries pass the version before, one page
    // more.
    expect(before.length).toBeGreaterThan(8);
    expect(before.length).toBeLessThan(8 + 32);
    expect(changedIn(before, listedRuns(storage, far)).afterTo).toBeGreaterThan(8);
    let ended = expectRuled(kept, base, far, B, A, "end", 5_000);
    expect(ended.answer).toBe("too-long");
    expect(ended.rows).toBe(refused.rows);
    expect(ended.pages).toBe(2 + 1);
    // Under a larger limit the strings start at the run that holds the line.
    let shown = expectRuled(kept, base, far, B, A, named, 50_000);
    if (shown.answer === "too-long") throw new Error("Refused what fits.");
    expect(shown.answer.mdStart).toBe(runStarts(listedRuns(storage, far)).findLast(start => start <= differs));
  });

  it("by hand: with no range named, the strings start one run before the first that differs", () => {
    // 30 lines and a table; after, a row more and the runs before it cut four to a run.
    let tab = linesOf(30, [grid(["a", "b"], ["c", "d"]), para("End")]);
    let { storage, store, base } = pieceStore(tab, THREE);
    let table = tab.body.content[31];
    let rowed = madeByHand(store, base, [{
      insertTableRow: {
        tableCellLocation: {
          tableStartLocation: { index: table.startIndex, tabId: tab.tabId }, rowIndex: 1, columnIndex: 0,
        },
        insertBelow: true,
      },
    }]);
    let after = recut(storage, rowed, FOUR, 0, table.startIndex);
    let before = listedRuns(storage, base), runs = listedRuns(storage, after);
    let B = before.map(run => run.markdown).join(""), A = runs.map(run => run.markdown).join("");
    let tableStart = B.indexOf("<table>");
    expect(A.slice(0, tableStart)).toBe(B.slice(0, tableStart));
    expect(changedIn(before, runs).from).toBe(0);
    expect(runs.slice(0, 8).map(run => run.markdown.length)).not.toEqual(before.slice(0, 8).map(run => run.markdown.length));
    let { answer, rule } = expectRuled(
      { storage, sizes: THREE }, base, after, B, A, undefined, undefined,
      renderTab(store.tab(after)).sourceMap.tables);
    if (answer === "too-long") throw new Error("No limit was handed.");
    // The first difference is in the table: the strings start one run before it.
    let starts = runStarts(runs).filter((_, at) => runs[at].markdown.length > 0);
    let holder = starts.findLastIndex(start => start <= rule.T);
    expect(rule.T).toBeGreaterThan(tableStart);
    expect(starts[holder]).toBeLessThanOrEqual(tableStart);
    expect(answer.mdStart).toBe(starts[holder - 1]);
    expect(answer.after.slice(answer.span.start, answer.span.afterEnd))
      .toBe("  <tr>\n    <td><p></p></td>\n    <td><p></p></td>\n  </tr>\n");
    expect(answer.tables).toHaveLength(1);
  });

  it("by hand: with no range named, two tabs that read alike are read no further than the runs cut otherwise", () => {
    // 600 lines three to a run; after, lines 100 to 130 four to a run: the tabs read alike.
    let tab = linesOf(600);
    let { storage, store, base } = pieceStore(tab, THREE);
    let { content } = tab.body;
    let alike = recut(storage, base, FOUR, content[100].startIndex, content[130].endIndex);
    let before = listedRuns(storage, base), after = listedRuns(storage, alike);
    let B = before.map(run => run.markdown).join("");
    expect(after.map(run => run.markdown).join("")).toBe(B);
    let c = store.changed(base, alike);
    expect(c).toEqual(changedIn(before, after));
    expect(c.afterTo - c.from).toBeGreaterThan(5);
    expect(c.beforeTo - c.from).toBeGreaterThan(c.afterTo - c.from);
    expect(before.length - c.beforeTo).toBeGreaterThan(150);
    let counted = { alike: ruled.alike, front: ruled.front.handed, end: ruled.end.handed };
    let { answer, rows } = expectRuled({ storage, sizes: THREE }, base, alike, B, B);
    expect(answer).toEqual({
      mdStart: 0, before: "", after: "", tables: [], span: { start: 0, beforeEnd: 0, afterEnd: 0 },
    });
    expect(ruled.alike - counted.alike).toBe(1);
    // The comparison ends where both sides reach the runs after those cut otherwise: it
    // reads the runs listed anew once each, and nothing from the end.
    let anew = (c.beforeTo - c.from) + (c.afterTo - c.from);
    expect(ruled.front.handed - counted.front).toBe(anew + 2);
    expect(rows).toBe(anew);
    expect(ruled.end.handed - counted.end).toBe(0);

    // The same with the runs cut otherwise through the tab's last line.
    let tail = recut(storage, base, FOUR, content[560].startIndex, content.at(-1)!.endIndex - 1);
    let ending = listedRuns(storage, tail);
    expect(ending.map(run => run.markdown).join("")).toBe(B);
    let e = store.changed(base, tail);
    expect(e).toEqual(changedIn(before, ending));
    expect([e.beforeTo, e.afterTo]).toEqual([before.length, ending.length]);
    expect(e.afterTo).toBeLessThan(e.beforeTo);
    counted = { alike: ruled.alike, front: ruled.front.handed, end: ruled.end.handed };
    let ended = expectRuled({ storage, sizes: THREE }, base, tail, B, B);
    expect(ended.answer).toEqual(answer);
    expect(ruled.alike - counted.alike).toBe(1);
    let last = (e.beforeTo - e.from) + (e.afterTo - e.from);
    expect(ruled.front.handed - counted.front).toBe(last);
    expect(ended.rows).toBe(last);
    expect(ruled.end.handed - counted.end).toBe(0);
  });

  it("by hand: lines after the range named, cut otherwise, are compared and never joined", () => {
    // 90 lines, three to a run before and four after from line 9 on, the range in line 5.
    let tab = linesOf(90);
    let { storage, base } = pieceStore(tab, THREE);
    let { content } = tab.body;
    let B = renderTab(tab).markdown;
    let mdStart = B.indexOf("Line 5 ");
    let named = { mdStart, mdEnd: mdStart + 20 };
    let kept = { storage, sizes: THREE };
    let before = listedRuns(storage, base);
    let last = content.at(-1)!.endIndex - 1;

    // Every line after the range equal: the strings end with the run after the range.
    let alike = recut(storage, base, FOUR, content[10].startIndex, last);
    let after = listedRuns(storage, alike);
    expect(after.map(run => run.markdown).join("")).toBe(B);
    expect(after.slice(-20).map(run => run.markdown.length)).not.toEqual(before.slice(-20).map(run => run.markdown.length));
    let same = expectRuled(kept, base, alike, B, B, named, 10);
    if (same.answer === "too-long") throw new Error("Refused what fits.");
    let starts = runStarts(after);
    let holder = starts.findLastIndex(start => start <= named.mdEnd);
    expect(same.answer.mdStart + same.answer.after.length).toBe(starts[holder] + after[holder].markdown.length);

    // One line far after that reads otherwise: refused where the end finds it, no run before read.
    let far = recut(storage, base, FOUR, content[10].startIndex, last, elements => reworded(elements.at(-4)!));
    let runs = listedRuns(storage, far);
    let A = runs.map(run => run.markdown).join("");
    let differs = B.indexOf("Line 86 ");
    expect(A.indexOf("#ine 86 ")).toBe(differs);
    let whole = changedSpan(B, A, { start: named.mdStart, end: named.mdEnd });
    expect(whole.beforeEnd - named.mdEnd).toBeGreaterThan(5_000);
    let refused = expectRuled(kept, base, far, B, A, named, 5_000);
    expect(refused.answer).toBe("too-long");
    let from = (of: readonly ListedRun[]) =>
      runStarts(of).filter((start, at) => start + of[at].markdown.length > differs).length;
    expect(refused.rows).toBe(from(before) + from(runs));
    expect(expectRuled(kept, base, far, B, A, named, 50_000).answer).not.toBe("too-long");
  });

  it("by hand: one run of both lists that stands at two offsets is compared as text", () => {
    // The strings to the rule, no range named, with `shared` one entry of both lists at offsets
    // `starts`.
    let heldAtTwoOffsets = (
      storage: FakeDocStorage, before: DocVersion, after: DocVersion, shared: string,
      starts: readonly [number, number],
    ): ChangedMarkdown => {
      let lists = [listedRuns(storage, before), listedRuns(storage, after)];
      let places = lists.map(runs => runs.findIndex(run => run.markdown === shared));
      expect(lists[0][places[0]].entry).toBe(lists[1][places[1]].entry);
      expect(lists.map((runs, side) => runStarts(runs)[places[side]])).toEqual(starts);
      let [B, A] = lists.map(runs => runs.map(run => run.markdown).join(""));
      let { answer } = expectRuled({ storage, sizes: TWO }, before, after, B, A);
      if (answer === "too-long") throw new Error("No limit was handed.");
      return answer;
    };

    // From the front: a line "same" removed before a run that starts with "same".
    let front = asFetched(buildTab([
      para("a"), para("b"), para("same"), para("same"), para("other"), para("c"),
    ]));
    let lines = front.body.content;
    let fronts = pieceStore(front, TWO);
    let split = recut(fronts.storage, fronts.base, ONE, lines[2].startIndex, lines[3].endIndex - 1);
    let joined = madeByHand(fronts.store, split, [removal(front.tabId, lines[3])]);
    expect(listedRuns(fronts.storage, split).map(run => run.markdown))
      .toEqual(["a\n", "\nb\n", "\nsame\n", "\nsame\n\nother\n", "\nc\n"]);
    expect(listedRuns(fronts.storage, joined).map(run => run.markdown))
      .toEqual(["a\n", "\nb\n", "\nsame\n\nother\n", "\nc\n"]);
    // The version before stands at the run's start.
    let removed = heldAtTwoOffsets(fronts.storage, split, joined, "\nsame\n\nother\n", [11, 5]);
    expect(removed.before.slice(removed.span.start, removed.span.beforeEnd)).toBe("same\n\n");
    expect(removed.span.afterEnd).toBe(removed.span.start);
    // The same pair the other way round: the version after stands at the run's start.
    let added = heldAtTwoOffsets(fronts.storage, joined, split, "\nsame\n\nother\n", [5, 11]);
    expect(added.after.slice(added.span.start, added.span.afterEnd)).toBe("same\n\n");
    expect(added.span.beforeEnd).toBe(added.span.start);

    // From the end: a run "left, same" ending one version and followed by "same" in the
    // other; a comparison that passed it unread would find the tabs alike back to their start.
    let end = asFetched(buildTab([
      para("w"), para("x"), para("left"), para("left"), para("same"), para("same"),
    ]));
    let ending = end.body.content;
    let ends = pieceStore(end, TWO);
    let short = madeByHand(ends.store, ends.base, [removal(end.tabId, ending.at(-2)!)]);
    let apart = recut(ends.storage, ends.base, ONE, ending[2].startIndex, ending[3].endIndex - 1);
    let long = recut(
      ends.storage, madeByHand(ends.store, apart, [removal(end.tabId, ending[3])]), TWO,
      ending[1].startIndex, ending[1].endIndex - 1,
      elements => reworded(elements.find(element => element.paragraph)!));
    expect(listedRuns(ends.storage, short).map(run => run.markdown))
      .toEqual(["w\n", "\nx\n\nleft\n", "\nleft\n\nsame\n"]);
    expect(listedRuns(ends.storage, long).map(run => run.markdown))
      .toEqual(["#\n", "\nx\n", "\nleft\n\nsame\n", "\nsame\n"]);
    // The version after stands at the run's end.
    let lengthened = heldAtTwoOffsets(ends.storage, short, long, "\nleft\n\nsame\n", [11, 5]);
    expect(lengthened).toMatchObject({
      mdStart: 0, before: "w\n\nx\n\nleft\n\nleft\n", after: "#\n\nx\n\nleft\n\nsame\n",
      span: { start: 0, beforeEnd: 16, afterEnd: 16 },
    });
    // The same pair the other way round: the version before stands at the run's end.
    let shortened = heldAtTwoOffsets(ends.storage, long, short, "\nleft\n\nsame\n", [5, 11]);
    expect(shortened).toMatchObject({
      mdStart: 0, before: "#\n\nx\n\nleft\n\nsame\n\nsame\n", after: "w\n\nx\n\nleft\n\nleft\n\nsame\n",
      span: { start: 0, beforeEnd: 16, afterEnd: 16 },
    });
  });

  it("by hand: a walk of the runs both lists hold that hands them again starts the answer afresh", () => {
    // Twelve lines, one to a run, line 8 reworded; the range in line 8, line 10, and none.
    for (let line of [8, 10, undefined]) {
      let tab = asFetched(buildTab(Array.from({ length: 12 }, (_, at) => para(`Line ${at} text`))));
      let B = renderTab(tab).markdown;
      let mdStart = B.indexOf(`Line ${line} text`);
      let named = line === undefined ? undefined : { mdStart, mdEnd: mdStart + 4 };
      let { storage, store, base } = pieceStore(tab, ONE);
      let after = recut(storage, base, ONE, 0, tab.body.content.at(-1)!.endIndex - 1, elements =>
        reworded(elements.find(element => element.paragraph?.elements[0].textRun?.content === "Line 8 text\n")!));
      let A = listedRuns(storage, after).map(run => run.markdown).join("");
      expect(A).toBe(B.replace("Line 8 text", "#ine 8 text"));
      let changed = store.changed(base, after);
      expect(changed).toEqual({ from: 9, beforeTo: 10, afterTo: 10 });
      let sound = expectRuled({ storage, sizes: ONE }, base, after, B, A, named).answer;
      // Beneath the store, both lists name a key no rendering is stored under.
      let damaged = 4;
      let carryAt = (version: DocVersion) => storage.sql.exec<{ carry: string }>(
        "SELECT carry FROM doc_seq WHERE version = ? AND seq = ?", version.id, damaged).one().carry;
      storage.sql.exec(
        "UPDATE doc_seq SET carry = 'zz' WHERE version IN (?, ?) AND seq = ?", base.id, after.id, damaged);
      expect(carryAt(base)).toBe("zz");
      expect(store.changed(base, after)).toEqual(changed);
      // The version is keyed again and its runs handed afresh: the answer is the sound one.
      expect(changedMarkdown(store, base, after, named), `the range in line ${line}`).toEqual(sound);
      expect(carryAt(base)).not.toBe("zz");
    }
  });
});

// --- A span that leaves its strings

const PAIR = ["a", "b"];
const equalTables = (count: number): BlockSpec[] =>
  Array.from({ length: count }, () => [grid(PAIR), para("")]).flat();
const newTable = (after?: string): TableCall =>
  ({ method: "insertTable", table: { rows: 1, columns: 2, cells: [PAIR], ...(after === undefined ? {} : { after }) } });

/**
 * Table changes whose span the text beyond the runs that differ could change, each with the
 * runs added before the strings under one and two elements a run, and the most rows read.
 */
const LEAVING: readonly (readonly [string, () => BlockSpec[], TableCall, readonly number[], number])[] = [
  ["a row added before rows that begin as it does",
    () => [para("Intro"), grid(["a", "b"], ["a", "c"]), para("End")],
    { method: "insertTableRows", lines: { table: 0, at: 0, cells: [["a", "z"]] } }, [0, 0], 8],
  // At the tab's end after empty paragraphs, the walk back may reach the strings' start: one,
  // two and three of them put the table first or last in its run under each cut.
  ["a table added after one empty paragraph", () => [para("Intro"), para("")], newTable(), [1, 1], 7],
  ["a table added after two empty paragraphs",
    () => [para("Intro"), para(""), para("")], newTable(), [1, 0], 7],
  ["a table added after three empty paragraphs",
    () => [para("Intro"), para(""), para(""), para("")], newTable(), [1, 1], 7],
  ["a table added before a table that begins as it does",
    () => [para("Anchor"), grid(PAIR, ["c", "d"]), para("End")], newTable("Anchor"), [0, 0], 10],
  // The first difference is past the five tables: the walk back adds their ten runs.
  ["a table added before five tables that read as it does",
    () => [para("Anchor"), ...equalTables(5), para("End")], newTable("Anchor"), [10, 10], 22],
  ["a table deleted before one that begins as it does",
    () => [para("Intro"), grid(PAIR), para(""), grid(PAIR, ["c", "d"]), para("End")],
    { method: "deleteTable", table: 0 }, [0, 0], 12],
  ["a table added behind ten empty paragraphs",
    () => [para("Intro"), ...Array.from({ length: 10 }, () => para(""))], newTable(), [1, 0], 7],
  ["a table added behind five tables that read as it does",
    () => [para("Intro"), ...equalTables(5)], newTable(), [10, 10], 16],
];

describe("a span that leaves its strings is placed where the whole tab places it", () => {
  it.each(LEAVING)("%s", (_name, blocks, call, extended, most) => {
    for (let [cut, sizes] of [ONE, TWO].entries()) {
      let tab = asFetched(buildTab(blocks()));
      let chain = chainOf(tab, sizes);
      let tally: Tally = {};
      let held = heldStep(chain, undefined, tally, call);
      expect(summed(tally).prepared).toEqual({ [call.method]: 1 });
      // No run is added after the strings, and an extension stops: the rows read are few.
      expect(held!.rule.extensions, `cut ${cut}`).toEqual({ before: extended[cut], after: 0 });
      expect(held!.rows, `cut ${cut}`).toBeLessThanOrEqual(most);
      if (call.method === "insertTable" && call.table.after && extended[cut] > 0) {
        expect(held!.rule.T).toBeGreaterThan(renderTab(tab).markdown.lastIndexOf("</table>"));
      }
    }
  });
});

// --- What a card reads and holds

describe("what a card reads of its tab", () => {
  afterEach(() => vi.restoreAllMocks());

  /** A line, `between`, a table of two rows and a last paragraph: a row added to that table. */
  function behind(between: BlockSpec[], tables: number) {
    let tab = asFetched(buildTab([para("Named line"), ...between, grid(PAIR, ["c", "d"]), para("End")]));
    let call: TableCall = { method: "insertTableRows", lines: { table: tables, cells: [["x", "y"]] } };
    return { tab, call };
  }

  it.each([
    ...[0, 2, 20, 200].map(count =>
      [`${count} empty paragraphs`, () => behind(Array.from({ length: count }, () => para("")), 0)] as const),
    ...[2, 20, 200].map(count => [`a row of ${count} tables`, () => behind(
      Array.from({ length: count }, (_, at) => [grid([`cell ${at}`]), para("")]).flat(), count)] as const),
  ])("the text before a table behind %s", (_name, made) => {
    let { tab, call } = made();
    let chain = chainOf(tab, ONE);
    let { store, version } = chain;
    let tally: Tally = {};
    heldStep(chain, undefined, tally, call);
    expect(summed(tally).prepared).toEqual({ insertTableRows: 1 });
    let card = wholeTableChange(tab, call, LABEL);
    expect(JSON.stringify(card.description)).toContain("Text before the table");
    expect(JSON.stringify(card.description)).toContain("Named line");
    // Prepared again, only the piece is decoded: the line before the table is read from stored
    // Markdown.
    let { piece } = DocStore.prototype;
    let pieces = 0;
    vi.spyOn(DocStore.prototype, "piece").mockImplementation(function (this: DocStore, ...asked) {
      let decoded = docStoreCost.runsDecoded;
      let answered = piece.apply(this, asked);
      pieces += docStoreCost.runsDecoded - decoded;
      return answered;
    });
    let decoded = docStoreCost.runsDecoded;
    expect(prepareTableChange(store, version, call, LABEL)).toEqual(card);
    expect(docStoreCost.runsDecoded - decoded).toBe(pieces);
    expect(pieces).toBeGreaterThan(0);
  });
});

/** The longest Markdown one run of `version` holds. */
function longestOf(storage: FakeDocStorage, version: DocVersion): number {
  return Math.max(...listedRuns(storage, version).map(run => run.markdown.length));
}

// --- What the tests above counted

describe("where two versions' lists differ", () => {
  it("is what the two lists compared say, and the same version differs nowhere", () => {
    // Counted by `expectChanged` over every step the tests above prepared.
    expect(listed.pairs).toBeGreaterThanOrEqual(WIDER ? 700 : 450);
    expect(listed.runs).toBeGreaterThan(6_000);
    expect(listed.anew).toBeGreaterThan(listed.pairs);
    let { storage, store, base } = pieceStore(continuedList(20), ONE);
    let runs = listedRuns(storage, base).length;
    expect(store.changed(base, base)).toEqual({ from: runs, beforeTo: runs, afterTo: runs });
  });

  it("an edit that never settles the carry and changes no later key differs in its own runs alone", () => {
    // An item added to a numbered list no later run continues.
    let tab = asFetched(buildTab([
      para("Intro"), item("one", "N1"), item("two", "N1"),
      ...Array.from({ length: 30 }, (_, at) => para(`Filler ${at}.`)),
    ], PRESET_NUMBERED));
    let keyed = docStoreCost.runsKeyed;
    let { storage, store, before, after } = heldReplacementOf(tab, ONE, ADDED.oldMarkdown, ADDED.newMarkdown);
    // The carry is never the earlier version's again: the keys are worked out to the tab's end.
    expect(docStoreCost.runsKeyed - keyed).toBeGreaterThanOrEqual(30);
    let runs = listedRuns(storage, before);
    let place = runs.findIndex(run => run.markdown.includes("1. two"));
    // The lists differ in the run of the item added alone.
    expect(store.changed(before, after)).toEqual({ from: place + 1, beforeTo: place + 1, afterTo: place + 2 });
    expect(listedRuns(storage, after).slice(place + 2).map(run => run.entry))
      .toEqual(runs.slice(place + 1).map(run => run.entry));
  });
});

describe("the strings are the rule's", () => {
  it("over the recorded and the seeded queues, with no run added after a string", () => {
    // Counted by `expectRuled` over every card: the first difference is in both strings, so no
    // run is added after one; runs are added before one where added lines follow equal lines.
    expect(queued?.cards).toBeGreaterThanOrEqual(WIDER ? 600 : 350);
    expect(queued!.extensions.after).toBe(0);
    expect(queued!.extensions.before).toBeGreaterThan(0);
    expect(ruled.extensions.after).toBe(0);
    // Versions that read alike: the hand-made ones, and in the wider queues a look Markdown does
    // not show.
    if (WIDER) expect(queued!.alike).toBeGreaterThanOrEqual(1);
    expect(ruled.alike).toBeGreaterThan(queued!.alike);
    // A comparison reads few rows.
    expect(queued!.front.most).toBeLessThanOrEqual(8);
    expect(queued!.end.most).toBeLessThanOrEqual(8);
  });

  it("the rule on two whole strings gives the whole strings' span", () => {
    // The reference itself, with no store: seeded pairs of strings of lines that repeat, one to
    // four lines a run, some runs empty; no range named, the lines replaced, or a range inside.
    const LINES = ["", "a", "b", "- a", "  - a", "  - b", "1. a", "ab", "<table>x</table>", "    - a"];
    let { below } = diceOf(20261119);
    let lines = (count: number) => Array.from({ length: count }, () => `${LINES[below(LINES.length)]}\n`);
    let extended = { before: 0, after: 0 }, alike = 0, long = 0, named = 0;
    for (let pair = 0; pair < 20_000; pair++) {
      let before = lines(below(14));
      let from = below(before.length + 1), to = from + below(before.length - from + 1);
      let after = [...before.slice(0, from), ...lines(below(4)), ...before.slice(to)];
      if (below(4) === 0) after.splice(below(after.length + 1), below(2), ...lines(below(2)));
      let B = before.join(""), A = after.join("");
      // The starts of the runs of the string after that write a character.
      let starts: number[] = [];
      for (let line = 0, at = 0; line < after.length;) {
        let held = below(8) === 0 ? 0 : 1 + below(4);
        if (held > 0) starts.push(at);
        for (; held > 0 && line < after.length; held--) at += after[line++].length;
      }
      let range: Range | undefined;
      let kind = below(3);
      if (kind > 0) {
        range = { start: before.slice(0, from).join("").length, end: before.slice(0, to).join("").length };
        if (kind === 2 && range.end - range.start > 2) range = { start: range.start + below(2), end: range.end - below(2) };
        named++;
      }
      let rule = ruleStrings(B, A, starts, range);
      extended.before += rule.extensions.before;
      extended.after += rule.extensions.after;
      let whole = changedSpan(B, A, range);
      if (!range && B === A) {
        alike++;
        expect(rule.span).toEqual({ start: 0, beforeEnd: 0, afterEnd: 0 });
        continue;
      }
      expect(moved(rule.span, rule.mdStart)).toEqual(whole);
      // Where the rule says a card is too long for a small limit, the whole span is.
      if (range) {
        for (let most of [0, 3, 8]) {
          if ((rule.differs && range.start - rule.T > most) || rule.U - range.end > most) {
            long++;
            expect(range.start - whole.start > most || whole.beforeEnd - range.end > most).toBe(true);
          }
        }
      }
    }
    expect(extended).toEqual({ before: 22, after: 0 });
    expect(alike).toBeGreaterThan(0);
    expect(long).toBeGreaterThan(1_000);
    expect(named).toBeGreaterThan(10_000);
  });
});

// --- A table added after tables that read alike: its span walks far back over repeating text, and
// the characters its comparisons are handed (counted, not timed) grow with the tab, not its square.

/** A table of one cell that reads as every table of an `equal` tab does, added at the tab's end. */
const ADDED_TABLE: TableCall = { method: "insertTable", table: { rows: 1, columns: 1, cells: [["cell"]] } };

/** A tab of `pairs` one-cell tables, each followed by an empty paragraph, kept in a store. */
function tinyTables(pairs: number, equal: boolean) {
  let tab = asFetched(tinyTablesTab("t1", pairs, equal ? () => "cell" : at => `cell ${at}`));
  return { tab, ...pieceStore(tab) };
}

/**
 * The characters the comparisons of the card of `ADDED_TABLE` were handed on a kept tab of
 * `pairs` equal tables (`spanCharsCompared`), and the length of that tab's Markdown.
 */
function spanChars(pairs: number): { compared: number; tabLength: number } {
  let { tab, store, base } = tinyTables(pairs, true);
  let compared = docStoreCost.spanCharsCompared;
  prepareTableChange(store, base, ADDED_TABLE, LABEL);
  return { compared: docStoreCost.spanCharsCompared - compared, tabLength: renderTab(tab).markdown.length };
}

describe("the card of a table added after tables that read alike", () => {
  it.each([1, 4, 5, 6, 7, 12, 40, 300])("is the whole tab's, after %i tables", pairs => {
    let { tab, store, base } = tinyTables(pairs, true);
    expect(prepareTableChange(store, base, ADDED_TABLE, LABEL)).toEqual(wholeTableChange(tab, ADDED_TABLE, LABEL));
  });

  it("compares a small multiple of the tab's characters", () => {
    // Each comparison is handed both strings whole, and each extension after the first few takes
    // twice the runs of the one before, so together they are handed about five times the tab
    // (measured 4.8 at 100 to 3,000 tables). Extending a run at a time hands them a figure that
    // grows with the square of the tables: about 3,000 times the tab here.
    let { compared, tabLength } = spanChars(1_500);
    expect(compared).toBeLessThan(10 * tabLength);
  });
});
