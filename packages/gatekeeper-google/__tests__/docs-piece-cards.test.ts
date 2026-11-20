// The cards from stored runs held to the cards from the whole tab: every preparation
// (`prepareTextReplacement`, `prepareAppend`, `prepareTableChange`) on a version of a store
// against the same on the tab in hand (`./docs-piece-cards-whole`), on the recorded queues,
// on seeded queues and on tabs made for where a card reads far from its edit; the strings a
// card reads (`changedMarkdown`) against the rule worked out on the two whole Markdown
// strings; and what a card reads and holds, as counts.

import { afterEach, describe, expect, it, vi } from "vitest";
import { assertGoogleDocDisplaySize, googleDocDisplayLimit } from "../src/doc-actions";
import type { GoogleDocsRequest, GoogleDocsTab, StructuralElement } from "../src/docs-api";
import {
  changedSpan, docEditResult, editedSlice, isBlankDocTab, makeDocEdit, renderTab, type DocEdit,
} from "../src/docs-replay";
import { RUN_SIZES, type RunSizes } from "../src/docs-runs";
import { DocStore, docStoreCost, type DocVersion } from "../src/docs-store";
import {
  changedMarkdown, prepareAppend, prepareTableChange, prepareTextReplacement, tableCallChange,
  type ChangedMarkdown, type TableCall,
} from "../src/docs-table-actions";
import { wholeTabReading, type TableChange } from "../src/docs-tables";
import type { MarkdownRange } from "../src/markdown-converter";
import {
  buildTab, diceOf, grid, item, para, presetLevels, type BlockSpec, type Lists,
} from "./doc-fixture";
import type { FakeDocStorage } from "./doc-store-fake";
import { countedStorage, linesWithTablesTab, nestedItemsTab, proseTab } from "./doc-store-scenarios";
import { readFixtures } from "./docs-live-fixtures";
import { SCENARIOS, stepEdit } from "./docs-live-recorder";
import {
  stepTableCall, wholeAppend, wholeTableChange, wholeTextReplacement,
} from "./docs-piece-cards-whole";
import { ReadPastPiece } from "./docs-piece-recorder";
import { pieceStore, sandwiched } from "./docs-piece-shadow";
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

// ---------------------------------------------------------------------------
// Beneath the store
// ---------------------------------------------------------------------------

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

/**
 * The statements that read one row's large column (a run's JSON, a rendering's Markdown, an
 * edit's result), `rows`, and those that read a page of a version's list, `pages`, while
 * `run` runs on a store of its own over `storage`, cut to `sizes`.
 */
function contentRows<T>(
  storage: FakeDocStorage, sizes: RunSizes, run: (store: DocStore) => T,
): { value: T; rows: number; pages: number } {
  let counted = countedStorage(storage);
  let value = run(new DocStore(counted.storage, undefined, undefined, sizes));
  let { content, pages } = counted.counts();
  return { value, rows: content, pages };
}

// ---------------------------------------------------------------------------
// The rule on two whole strings
// ---------------------------------------------------------------------------

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
 * THE REFERENCE: the rule by which `changedMarkdown` chooses its strings, worked out on the
 * two whole Markdown strings `B` and `A` and the offsets at which the runs of `after` that
 * write a character start. `T` and `U` by two loops over the strings from offset 0 and from
 * the ends, with the rule's stops and floors; the run the strings start in and the run they
 * end in; the two slices; then the span, extended by `after`'s runs while it says `more`.
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

/**
 * Runs `run` with every reader a store makes counted by the comparison it serves: a card's
 * first two readers are the comparison's from the front and its next two the one's from the
 * end (`changedMarkdown` makes them in that order); the readers after them read the strings.
 */
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
 * Holds the strings a card reads of `before` and `after`, two versions of `store` whose whole
 * Markdown is `B` and `A`, to the rule on the two whole strings: `changedMarkdown`'s offset,
 * strings and span are the reference's, the span is the two whole strings', moved, and where
 * it answers `"too-long"` the reference's first or last difference is past `most`. With
 * `tables`, the tables of the tab after: those the answer names are the ones in its string.
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
  // A card's reads decode no run and render none: every run's rendering is stored.
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
 * Holds `DocStore.changed` of two versions to their two lists compared here, entry by entry,
 * and WHAT THE STRINGS LEAN ON: every run the version after lists reads as nothing or ends
 * with a line break, so a string that starts at a run starts at a line start and one that
 * ends with a run ends after a line break.
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

// ---------------------------------------------------------------------------
// A queue prepared in a store and in hand
// ---------------------------------------------------------------------------

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
 * Prepares `edit` on the version `chain` stands at and on its tab in hand, holds the two to
 * each other (the whole answer, or the thrown name and message) and the strings the card
 * read to the rule, and moves the chain to what the edit gives. A table change is prepared
 * by `call`, the call that makes it by its table's number, and `edit` is then the change
 * the call must become, where the caller knows it.
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
    // The preparation decides the path, which is the one the edit was queued with.
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
  // The edit is found stored: the version it gives, and the tab it gives in hand.
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

/**
 * Prepares the steps of a recorded scenario in order on `tab`, each in the version and the
 * tab in hand the steps before it gave. A step its tab does not take (its text is not there,
 * its table reads as none) is counted `skipped` and not prepared.
 */
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
    // A table step is a change by how its table reads: the call that makes it names the
    // table by its number, and is held to give the same change before it is prepared.
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
  appendText: 70, replaceText: 88, insertTable: 10, insertTableRows: 4, insertTableColumns: 4,
  deleteTableRows: 3, deleteTableColumns: 1, deleteTable: 1, setTableCellStyle: 7,
  setTableColumnWidths: 4, setTableRowHeights: 1, mergeTableCells: 3, unmergeTableCells: 3,
};

/** What `ruled` held once the recorded and the seeded queues were prepared. */
let queued: typeof ruled | undefined;

describe("the cards from stored runs against the cards from the whole tab", () => {
  it.each([["one element a run", ONE], ["the real cut", RUN_SIZES]] as const)(
    "the recorded queues, %s", (_name, sizes) => {
      let tally: Tally = {};
      for (let { before, steps } of RECORDED) heldRecording(before, steps, sizes, tally);
      // Every step is prepared, each kind of table change among them, and every table step's
      // call says its change.
      expect(summed(tally)).toEqual({ prepared: RECORDED_STEPS, refused: {}, unmapped: {} });
    });

  it("the recorded queues inside a larger tab", () => {
    let tally: Tally = {};
    for (let [number, { before, steps }] of RECORDED.entries()) {
      heldRecording(sandwiched(before, 20261119 + number), steps, number % 2 ? ONE : RUN_SIZES, tally);
    }
    // A recorded table step names its table by its place among the recording's tables, which
    // in the larger tab may be a table of the filler before it: the step's builder then makes
    // a change of that table which no call makes (a block past its cells, texts for more
    // columns than it has), or one the tab refuses. Every text step and every new table is
    // prepared, and each kind of change to an existing table at least once.
    expect(summed(tally)).toEqual({
      prepared: {
        appendText: 70, replaceText: 88, insertTable: 10, insertTableRows: 2, insertTableColumns: 1,
        deleteTableRows: 2, deleteTableColumns: 1, deleteTable: 1, setTableCellStyle: 1,
        setTableColumnWidths: 3, setTableRowHeights: 1, mergeTableCells: 1, unmergeTableCells: 1,
      },
      refused: { mergeTableCells: 2, unmergeTableCells: 2 },
      unmapped: {
        insertTableRows: 2, insertTableColumns: 3, deleteTableRows: 1, setTableCellStyle: 6,
        setTableColumnWidths: 1,
      },
    });
  });

  const QUEUES = WIDER ? { tabs: 60, sizings: [ONE, TWO, THREE, RUN_SIZES] } : { tabs: 25, sizings: [ONE, RUN_SIZES] };

  it("seeded queues", () => {
    let tally: Tally = {};
    let seed = 20261119 + 4100;
    for (let [number, tab] of pieceTabs(seed, QUEUES.tabs).entries()) {
      // Four steps drawn on the tab as it is kept, a text edit and a table call by turns,
      // each prepared in the tab the steps before it gave: a step whose text or table an
      // earlier one changed is refused, the same in the store and in hand.
      let texts = tabEdits(tab, seed + 7919 * (number + 1), 4).slice(0, 2);
      let calls = pieceTableEdits(tab, seed + 104729 * (number + 1), 8)
        .flatMap(({ call }) => call ? [call] : []).slice(0, 2);
      for (let sizes of WIDER ? QUEUES.sizings : [QUEUES.sizings[number % 2]]) {
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
    // Text edits and table changes are both prepared, and both refused.
    expect(prepared.replaceText + prepared.appendText).toBeGreaterThanOrEqual(WIDER ? 100 : 20);
    expect(sum(prepared) - prepared.replaceText - prepared.appendText).toBeGreaterThanOrEqual(WIDER ? 60 : 12);
    expect(sum(refused)).toBeGreaterThanOrEqual(WIDER ? 40 : 8);
  });
});

// ---------------------------------------------------------------------------
// A card that reads far from its edit
// ---------------------------------------------------------------------------

/**
 * A version made BY HAND: `requests` applied by the model to the runs of `version` they
 * name, and the version those runs give stored (`DocStore.putSlice`), with no edit, no
 * builder and no result of an edit.
 */
function madeByHand(store: DocStore, version: DocVersion, requests: readonly GoogleDocsRequest[]): DocVersion {
  let { slice, made } = editedSlice(store, version, "by hand", requests);
  return store.transaction(() => store.putSlice(slice, made));
}

/**
 * A version made BY HAND that reads as `version` does and is cut otherwise: the runs of
 * `version` that hold the indexes `from` to `to`, their elements cut again to `sizes` by a
 * store of those sizes on the same storage, with `change` made in the elements first (a
 * change that moves no index).
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

/**
 * A numbered list of two items, `between` paragraphs that hold `text(n)`, the list's third
 * item and a last paragraph: an item added to the first two renumbers the third.
 */
function continuedList(between: number, text = (at: number) => `Filler ${at}.`): GoogleDocsTab {
  return asFetched(buildTab([
    para("Intro"), item("one", "N1"), item("two", "N1"),
    ...Array.from({ length: between }, (_, at) => para(text(at))),
    item("three", "N1"), para("End"),
  ], PRESET_NUMBERED));
}

/** The item `continuedList`'s first part gains. */
const ADDED = { oldMarkdown: "1. two\n", newMarkdown: "1. two\n1. added\n" };

/**
 * A replacement prepared on `tab` kept under `sizes`: its card is the whole tab's and its
 * strings the rule's (`heldStep`). Answers the store with the versions before and after.
 */
function heldReplacementOf(tab: GoogleDocsTab, sizes: RunSizes, oldMarkdown: string, newMarkdown: string) {
  let chain = chainOf(tab, sizes);
  let before = chain.version;
  let tally: Tally = {};
  heldStep(chain, { type: "replaceText", oldMarkdown, newMarkdown }, tally);
  expect(summed(tally)).toEqual({ prepared: { replaceText: 1 }, refused: {}, unmapped: {} });
  return { ...chain, before, after: chain.version };
}

describe("a card that reads far from its edit", () => {
  it.each([["one element a run", ONE], ["the real cut", RUN_SIZES]] as const)(
    "an item renumbered many runs later, %s", (_name, sizes) => {
      for (let between of [2, 20, 200]) {
        let tab = continuedList(between);
        let chain = chainOf(tab, sizes);
        let whole = wholeTextReplacement(tab, ADDED.oldMarkdown, ADDED.newMarkdown, LABEL);
        // The span runs from the item added to the line renumbered, every paragraph between
        // them in it.
        expect(whole.shown.old.startsWith("1. two\n\nFiller 0.")).toBe(true);
        expect(whole.shown.old.endsWith(`Filler ${between - 1}.\n\n3. three`)).toBe(true);
        expect(whole.shown.rendered.endsWith("\n\n4. three")).toBe(true);
        // The card is the whole tab's, and its strings the rule's; no run is decoded or
        // rendered for it (`expectRuled`): only the edit's piece and its slice decode.
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

  it.each([["one element a run", ONE], ["the real cut", RUN_SIZES]] as const)(
    "past the display limit, %s", (_name, sizes) => {
      // More than 1 MiB of paragraphs between the item added and the item renumbered.
      let tab = continuedList(40, at => `Filler ${at}. ${"x".repeat(30_000)}`);
      let { oldMarkdown, newMarkdown } = ADDED;
      let refusal = LIMIT.refusal().message;
      // The whole tab's card is refused by the check of what it shows.
      let whole = wholeTextReplacement(tab, oldMarkdown, newMarkdown, LABEL);
      expect(whole.shown.old.length).toBeGreaterThan(LIMIT.chars);
      expect(outcome(() => assertShown(whole.shown, oldMarkdown)))
        .toEqual({ refused: { name: "Error", message: refusal } });
      // The stored tab's is refused with the same text before any of it is joined.
      let { storage, store, base } = pieceStore(tab, sizes);
      let prepare = () => outcome(() => prepareTextReplacement(store, base, oldMarkdown, newMarkdown, LABEL, LIMIT));
      expect(prepare()).toEqual({ refused: { name: "Error", message: refusal } });
      // Prepared again, the result is found stored: what is in hand is the builders' piece
      // and the card's reads.
      docStoreCost.peakMarkdownCharsInHand = 0;
      expect(prepare()).toEqual({ refused: { name: "Error", message: refusal } });
      let peak = docStoreCost.peakMarkdownCharsInHand;
      let { after } = docEditResult(store, base, { type: "replaceText", oldMarkdown, newMarkdown });
      let longest = Math.max(longestOf(storage, base), longestOf(storage, after));
      // WHICH RUNS: the builders' piece is the closure of the item's paragraph, which holds the
      // two paragraphs after it (under three runs' Markdown, joined); then the card compares
      // from the end with one run of each version in hand, the first of them the run of the
      // item renumbered, and refuses there.
      let texts = oldMarkdown.length + newMarkdown.length;
      expect(peak).toBeLessThanOrEqual(3 * longest + texts);
      // It is `changedMarkdown` that refuses, with the limit's characters, having read a
      // few runs' Markdown and none of the paragraphs between: no string is joined.
      let B = renderTab(tab).markdown, A = store.markdown(after);
      let mdStart = B.indexOf(oldMarkdown);
      docStoreCost.peakMarkdownCharsInHand = 0;
      let { answer, rows } = expectRuled(
        { storage, sizes }, base, after, B, A, { mdStart, mdEnd: mdStart + oldMarkdown.length }, LIMIT.chars);
      expect(answer).toBe("too-long");
      // What it held is what its readers read, a run at a time: the peak is one run's
      // Markdown, and no less than the item renumbered, whose run the comparison from the
      // end reads.
      expect(docStoreCost.peakMarkdownCharsInHand).toBeLessThanOrEqual(longest);
      expect(docStoreCost.peakMarkdownCharsInHand).toBeGreaterThanOrEqual("3. three\n".length);
      expect(rows).toBeGreaterThan(0);
      expect(rows).toBeLessThanOrEqual(4);
      expect(listedRuns(storage, after).length).toBeGreaterThan(40);
    });

  const heldReplacement = heldReplacementOf;

  describe("what the whole Markdown shows to fit is not refused early", () => {
    it.each([["one element a run", ONE], ["the real cut", RUN_SIZES]] as const)(
      "a replacement of 0.45 MiB that spans many runs, %s", (_name, sizes) => {
        let line = (word: string, at: number) => `${word} ${at} ${"lorem ipsum ".repeat(840)}`.slice(0, 10_000);
        let tab = asFetched(proseTab("tab-1", 60, at => line("Paragraph", at)));
        let B = renderTab(tab).markdown;
        let oldMarkdown = B.slice(B.indexOf("Paragraph 5 "), B.indexOf("\n\nParagraph 53 "));
        let newMarkdown = Array.from({ length: 48 }, (_, at) => line("Other", at)).join("\n\n");
        expect(oldMarkdown.length).toBeGreaterThan(0.45 * 1024 * 1024);
        expect(newMarkdown.length).toBeGreaterThan(0.45 * 1024 * 1024);
        // The whole tab's card passes the check of what it shows: it shows the two texts alone.
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
      // THE CASE IT IS: the lists differ at the END of the row of equal runs, past the last
      // run of the range named, so nothing is compared from the front and the comparison
      // from the end steps back over the row entry by entry, with no Markdown read.
      let runs = listedRuns(storage, before);
      let changed = changedIn(runs, listedRuns(storage, after));
      let starts = runs.map((_, at) => runs.slice(0, at).reduce((sum, run) => sum + run.markdown.length, 0));
      let lastNamed = starts.findLastIndex(start => start < named.mdEnd);
      expect(changed.from).toBeGreaterThan(lastNamed);
      expect(changed.from).toBe(runs.length - 2);
      // THE MARKDOWN READ: the comparison from the end reads two runs where it meets the
      // range named (its last line in the version before against the paragraph in the version
      // after); then the strings' own runs, the paragraph of the version after, and the
      // paragraph and the range's two lines of the version before. None of the rest of the row.
      let { answer, rows } = expectRuled({ storage, sizes: ONE }, before, after, B, A, named, LIMIT.chars);
      expect(answer).not.toBe("too-long");
      expect(rows).toBe(2 + 1 + 3);
      // With no range named the first character that differs is the end of the version
      // after: the span stands at the row's end, as the two whole strings' does, and no
      // run is added for it.
      let unnamed = expectRuled({ storage, sizes: ONE }, before, after, B, A);
      expect(unnamed.rule.extensions).toEqual({ before: 0, after: 0 });
      expect(unnamed.rule.mdStart).toBeGreaterThan(LIMIT.chars);
    });

    it("what stands after the last character that differs is not counted", () => {
      // BY HAND: the version before lists the runs A, C, D, D, E and the version after A, D,
      // E, the two D one entry of 30,000 characters and C short, with the range named in it.
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
      // BY THE RULE: the front stops in C, so the strings start at C's run; the comparison
      // from the end starts with the cursor of the version after at that offset and stops at
      // once, so the last difference is the end of the first D; the string after is its D,
      // the string before C, D and D, and the span is C and one D removed.
      let end = { ...ruled.end };
      let fits = expectRuled({ storage, sizes: ONE }, base, after, B, A, named, 40_000);
      if (fits.answer === "too-long") throw new Error("Refused what fits.");
      // THE SIDE OF THE VERSION AFTER STOPS WHERE THE STRINGS START: the comparison from the
      // end is handed no run and reads no Markdown. Stepping on, it would hold the first D of
      // the version before against A of the version after, which the strings do not hold.
      expect(ruled.end).toEqual(end);
      expect(fits.answer.mdStart).toBe(2);
      expect(fits.answer.after).toBe(runs[2].markdown);
      expect(fits.answer.before).toBe(before[2].markdown + before[3].markdown + before[4].markdown);
      expect(fits.rule.extensions).toEqual({ before: 0, after: 0 });
      expect(fits.rule.U).toBe(2 + 17 + 30_002);
      // The second D reads alike in both and is not in the span: the string is over the
      // limit handed and the span under it.
      expect(fits.answer.before.length).toBeGreaterThan(40_000);
      expect(whole.beforeEnd - whole.start).toBeLessThan(40_000);
      // With a limit under the D removed, the card is refused, and the whole strings' span
      // holds more than the limit after the range named.
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
      // BENEATH THE STORE, the version after lists the far run under another carry key, with
      // the same rendering stored under it: the two entries differ and read alike.
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
      // The card, read again from the result stored, is the whole tab's: the far run is
      // compared, reads alike, and is in neither string.
      expect(prepareTextReplacement(store, before, oldMarkdown, newMarkdown, LABEL, LIMIT))
        .toEqual(wholeTextReplacement(tab, oldMarkdown, newMarkdown, LABEL));
      let B = runs.map(run => run.markdown).join(""), A = anew.map(run => run.markdown).join("");
      let mdStart = B.indexOf(oldMarkdown);
      let { answer, rows } = expectRuled(
        { storage, sizes: ONE }, before, after, B, A, { mdStart, mdEnd: mdStart + oldMarkdown.length }, LIMIT.chars);
      if (answer === "too-long") throw new Error("Refused what fits.");
      expect(answer.before.length + answer.after.length).toBeLessThan(100);
      // The edit's own run of each version, read by the comparison from the front, by the
      // one from the end and for the strings; and the far run of each version, read by the
      // comparison from the end. None of the paragraphs between: they are the same entries.
      expect(rows).toBe(3 * 2 + 2);
    });
  });
});

/** The level-1 item of `nestedItemsTab` made a level-0 item. */
const OUTDENTED = { oldMarkdown: "  - target item", newMarkdown: "- target item" };

/**
 * `OUTDENTED` prepared on `nestedItemsTab` of `items` and `chars` kept under `sizes`, its card held to
 * the whole tab's and its strings to the rule; then what the two lists and the card's reads
 * came to: the runs of each version that end before the range named and the Markdown they
 * write, whether the two versions read alike before it, the card's strings and the most
 * Markdown in hand while it was read.
 */
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
    // Over 1 MiB of items before the item made a level-0 one, under the real cut.
    let held = heldOutdented(600, 2_000, RUN_SIZES);
    expect(held.mdStart).toBeGreaterThan(LIMIT.chars);
    // THE CASE IT IS: the two versions' runs before the range named do not line up, and
    // read alike.
    expect(held.ahead.after.count).not.toBe(held.ahead.before.count);
    expect(held.alike).toBe(true);
    expect(held.changed.from).toBe(0);
    // Each string holds the edit's text and under two runs' Markdown.
    expect(held.answer.before.length).toBeLessThanOrEqual(held.texts + 2 * held.longest);
    expect(held.answer.after.length).toBeLessThanOrEqual(held.texts + 2 * held.longest);
    // THE PRICE: every run listed anew before the text is read once in each version, a run
    // a side, and none is joined (48 runs of the version before and 43 of the one after,
    // and the strings' own).
    expect(held.rows).toBeLessThanOrEqual(held.runs.before.length + held.runs.after.length + 6);
    expect(held.peak).toBeLessThanOrEqual(2 * held.longest + held.texts);
  });

  it.each([["one element a run", ONE], ["the real cut", RUN_SIZES]] as const)(
    "the items before an item made a level-0 one, %s", (_name, sizes) => {
      let held = heldOutdented(3_000, 100, sizes);
      let { before, after } = held.runs;
      let { from } = held.changed;
      if (sizes === ONE) {
        // The lists differ before the first run of the range named, in two runs that read alike.
        expect(from).toBeLessThan(held.ahead.before.count);
        expect(after[from].entry).not.toBe(before[from].entry);
        expect(after[from].markdown).toBe(before[from].markdown);
      } else {
        // THE RUNS DO NOT LINE UP, and read alike before the range named.
        expect(held.ahead.after.count !== held.ahead.before.count ||
          after[from].markdown !== before[from].markdown).toBe(true);
      }
      expect(held.alike).toBe(true);
      expect(held.mdStart).toBeGreaterThan(300_000);
      expect(held.answer.before.length).toBeLessThanOrEqual(held.texts + 2 * held.longest);
      expect(held.answer.after.length).toBeLessThanOrEqual(held.texts + 2 * held.longest);
      // The strings start at the run of the version after that holds the range's start.
      expect(held.answer.mdStart).toBe(held.ahead.after.length);
      // WHAT IS IN HAND while the card is read: one run's Markdown of each version while it
      // compares (the counter takes the longer), then the two strings. Measured: the longest
      // run's Markdown under either cut, the strings being shorter.
      expect(held.peak).toBeLessThanOrEqual(2 * held.longest + held.texts);
      // Every run listed anew before the text is read once in each version (3,000 and 3,000
      // rows under one-element runs; 40 and 43 under the real cut), and the strings' own.
      expect(held.rows).toBeLessThanOrEqual(held.runs.before.length + held.runs.after.length + 6);
      expect(held.rows).toBeGreaterThanOrEqual(held.ahead.before.count + held.ahead.after.count - 6);
    });

  const FOUR = runsOf(4);

  it("by hand: lines before the range named, cut otherwise, are compared and never joined", () => {
    // 90 lines, three to a run in the version before and four in the one after, and the
    // range named in line 80.
    let tab = linesOf(90);
    let { storage, base } = pieceStore(tab, THREE);
    let { content } = tab.body;
    let B = renderTab(tab).markdown;
    let mdStart = B.indexOf("Line 80 ");
    let named = { mdStart, mdEnd: mdStart + 20 };
    let kept = { storage, sizes: THREE };
    let before = listedRuns(storage, base);

    // EVERY LINE BEFORE THE RANGE EQUAL: not refused whatever stands before it; the strings
    // start at the run of the version after that holds the range's start; every run before
    // it is read once in each version and none is joined.
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

    // THE RANGE NAMED INSIDE THE RUN AFTER THOSE CUT OTHERWISE, which both lists hold as one
    // entry at one offset: the comparison passes that run with nothing read and stops at the
    // range's start, inside it, so the strings start at that run and not at the one after.
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

    // ONE LINE FAR BEFORE THAT READS OTHERWISE, with more than the limit between: refused
    // as soon as the comparison from the front finds it, the runs of the two versions up to
    // the one that holds it read once each and none after.
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
    // Nor is a list read on: one page of each version's, the first a reader asks for.
    expect(refused.pages).toBe(2);
    // THE SAME PAIR WITH THE RANGE AT THE TAB'S END, which starts where the version before
    // ends: refused once that version's list is passed by its summaries, with no Markdown
    // row more, its first page of 8 runs and the page after it; the list of the version
    // after, which holds more runs than a first page before the two lists meet, is not read on.
    expect(before.length).toBeGreaterThan(8);
    expect(before.length).toBeLessThan(8 + 32);
    expect(changedIn(before, listedRuns(storage, far)).afterTo).toBeGreaterThan(8);
    let ended = expectRuled(kept, base, far, B, A, "end", 5_000);
    expect(ended.answer).toBe("too-long");
    expect(ended.rows).toBe(refused.rows);
    expect(ended.pages).toBe(2 + 1);
    // With a limit large enough the span is the whole strings', moved, and the strings
    // start at the run of the version after that holds the line.
    let shown = expectRuled(kept, base, far, B, A, named, 50_000);
    if (shown.answer === "too-long") throw new Error("Refused what fits.");
    expect(shown.answer.mdStart).toBe(runStarts(listedRuns(storage, far)).findLast(start => start <= differs));
  });

  it("by hand: with no range named, the strings start one run before the first that differs", () => {
    // 30 lines and a table; the version after has a row more in the table and lists the
    // runs before it anew, four lines to a run where the version before has three.
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
    // The first character that differs is in the table, a run of its own: the strings start
    // at the run of the version after before it, and the span is the row added.
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
    // 600 lines, three to a run, and the version after lists lines 100 to 130 anew, four to
    // a run: the two tabs read alike, and after those runs the two lists are the same
    // entries, some 150 runs of each.
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
    // THE COMPARISON ENDS WHERE BOTH SIDES STAND AT THE STARTS OF THE RUNS AFTER THOSE CUT
    // OTHERWISE: its readers are handed the runs listed anew and that one of each list, and
    // read the Markdown of the runs listed anew, once each. No run after them is handed,
    // and nothing is compared from the end.
    let anew = (c.beforeTo - c.from) + (c.afterTo - c.from);
    expect(ruled.front.handed - counted.front).toBe(anew + 2);
    expect(rows).toBe(anew);
    expect(ruled.end.handed - counted.end).toBe(0);

    // THE SAME WITH THE RUNS CUT OTHERWISE THROUGH THE TAB'S LAST LINE: neither list holds a
    // run after them, so the comparison ends where both lists are passed at once, which is
    // no difference. Its readers are handed the runs listed anew and no other.
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
    // 90 lines, three to a run in the version before and four in the one after from line
    // 9 on, and the range named in line 5.
    let tab = linesOf(90);
    let { storage, base } = pieceStore(tab, THREE);
    let { content } = tab.body;
    let B = renderTab(tab).markdown;
    let mdStart = B.indexOf("Line 5 ");
    let named = { mdStart, mdEnd: mdStart + 20 };
    let kept = { storage, sizes: THREE };
    let before = listedRuns(storage, base);
    let last = content.at(-1)!.endIndex - 1;

    // EVERY LINE AFTER THE RANGE EQUAL: the strings end with the run of the version after
    // that holds the character after the range.
    let alike = recut(storage, base, FOUR, content[10].startIndex, last);
    let after = listedRuns(storage, alike);
    expect(after.map(run => run.markdown).join("")).toBe(B);
    expect(after.slice(-20).map(run => run.markdown.length)).not.toEqual(before.slice(-20).map(run => run.markdown.length));
    let same = expectRuled(kept, base, alike, B, B, named, 10);
    if (same.answer === "too-long") throw new Error("Refused what fits.");
    let starts = runStarts(after);
    let holder = starts.findLastIndex(start => start <= named.mdEnd);
    expect(same.answer.mdStart + same.answer.after.length).toBe(starts[holder] + after[holder].markdown.length);

    // ONE LINE FAR AFTER THAT READS OTHERWISE, with more than the limit between: refused as
    // soon as the comparison from the end finds it, the runs of the two versions back to
    // the one that holds it read once each and none before.
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
    // Holds the strings of `before` and `after` to the rule, with no range named. Beneath
    // the store, both lists hold the run that reads `shared` as ONE ENTRY, which starts at
    // offset `starts[0]` of the version before and `starts[1]` of the one after: a side
    // stands at its start, or at its end, while the other stands inside it.
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

    // FROM THE FRONT. Two lines that read alike, the first a run of its own and the second
    // the start of the next run: with the first removed, that next run stands six characters
    // earlier, and the side that has passed the line removed stands at its start while the
    // other stands at the line break before its second line. The two tabs differ in the
    // line removed: they do not read alike from that run on.
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

    // FROM THE END. One version ends with the run "left, same" and the other with that run
    // and a line "same" after it, so the run ends six characters earlier there: the side
    // that has passed the last line stands at the run's end while the other stands inside
    // it, before its last line. The last characters that differ are inside the run. The
    // line before it reads "left", as its first line does, so a comparison that passed the
    // run with nothing read would find the two tabs alike back to their first lines.
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
    // Twelve lines, one to a run after the run of the tab's first element; the version after
    // reads otherwise in line 8.
    // The range named in the line that differs, in a line after it, and none.
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
      // BENEATH THE STORE, both lists name, at one place before the runs that differ, a key
      // no rendering is stored under: the two lists differ where they did.
      let damaged = 4;
      let carryAt = (version: DocVersion) => storage.sql.exec<{ carry: string }>(
        "SELECT carry FROM doc_seq WHERE version = ? AND seq = ?", version.id, damaged).one().carry;
      storage.sql.exec(
        "UPDATE doc_seq SET carry = 'zz' WHERE version IN (?, ?) AND seq = ?", base.id, after.id, damaged);
      expect(carryAt(base)).toBe("zz");
      expect(store.changed(base, after)).toEqual(changed);
      // The pass of the summaries before the runs that differ meets the key, the version
      // before is keyed again whole and its runs are handed once more from the first: the
      // Markdown the runs passed write is counted once, and the answer is the one before the
      // damage.
      expect(changedMarkdown(store, base, after, named), `the range in line ${line}`).toEqual(sound);
      expect(carryAt(base)).not.toBe("zz");
    }
  });
});

// ---------------------------------------------------------------------------
// A span that leaves its strings
// ---------------------------------------------------------------------------

const PAIR = ["a", "b"];
const equalTables = (count: number): BlockSpec[] =>
  Array.from({ length: count }, () => [grid(PAIR), para("")]).flat();
const newTable = (after?: string): TableCall =>
  ({ method: "insertTable", table: { rows: 1, columns: 2, cells: [PAIR], ...(after === undefined ? {} : { after }) } });

/**
 * Table changes whose span the text beyond the runs that differ could change, each with the
 * runs added before the strings while the span said so, under one, two and three elements
 * a run, and the most Markdown rows its card read.
 */
const LEAVING: readonly (readonly [string, () => BlockSpec[], TableCall, readonly number[], number])[] = [
  ["a row added before rows that begin as it does",
    () => [para("Intro"), grid(["a", "b"], ["a", "c"]), para("End")],
    { method: "insertTableRows", lines: { table: 0, at: 0, cells: [["a", "z"]] } }, [0, 0, 0], 8],
  // A table added at the tab's end, after empty paragraphs: the lines added end in an empty
  // line, as the lines before them do, so the walk back may reach the strings' start. With
  // one, two and three empty paragraphs the table's place is a run's first element and its
  // last under each cut.
  ["a table added after one empty paragraph", () => [para("Intro"), para("")], newTable(), [1, 1, 0], 7],
  ["a table added after two empty paragraphs",
    () => [para("Intro"), para(""), para("")], newTable(), [1, 0, 1], 7],
  ["a table added after three empty paragraphs",
    () => [para("Intro"), para(""), para(""), para("")], newTable(), [1, 1, 0], 7],
  ["a table added before a table that begins as it does",
    () => [para("Anchor"), grid(PAIR, ["c", "d"]), para("End")], newTable("Anchor"), [0, 0, 0], 10],
  // The first character that differs is past the five tables: the strings start there and
  // hold none of them, and the walk back over equal lines then adds their ten runs.
  ["a table added before five tables that read as it does",
    () => [para("Anchor"), ...equalTables(5), para("End")], newTable("Anchor"), [10, 10, 10], 22],
  ["a table deleted before one that begins as it does",
    () => [para("Intro"), grid(PAIR), para(""), grid(PAIR, ["c", "d"]), para("End")],
    { method: "deleteTable", table: 0 }, [0, 0, 0], 12],
  ["a table added behind ten empty paragraphs",
    () => [para("Intro"), ...Array.from({ length: 10 }, () => para(""))], newTable(), [1, 0, 0], 7],
  ["a table added behind five tables that read as it does",
    () => [para("Intro"), ...equalTables(5)], newTable(), [10, 10, 10], 16],
];

describe("a span that leaves its strings is placed where the whole tab places it", () => {
  it.each(LEAVING)("%s", (_name, blocks, call, extended, most) => {
    for (let [cut, sizes] of [ONE, TWO, THREE].entries()) {
      let tab = asFetched(buildTab(blocks()));
      let chain = chainOf(tab, sizes);
      let tally: Tally = {};
      // The card is the whole tab's, and the strings and the span the rule's (`heldStep`).
      let held = heldStep(chain, undefined, tally, call);
      expect(summed(tally).prepared).toEqual({ [call.method]: 1 });
      // No run is added after the strings: the first character that differs is in both.
      expect(held!.rule.extensions, `cut ${cut}`).toEqual({ before: extended[cut], after: 0 });
      // An extension that never stopped would read on: the card's Markdown rows are few.
      expect(held!.rows, `cut ${cut}`).toBeLessThanOrEqual(most);
      // Before tables that read as the new one, the tabs first differ past them all.
      if (call.method === "insertTable" && call.table.after && extended[cut] > 0) {
        expect(held!.rule.T).toBeGreaterThan(renderTab(tab).markdown.lastIndexOf("</table>"));
      }
    }
  });
});

// ---------------------------------------------------------------------------
// What a card reads and holds
// ---------------------------------------------------------------------------

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
    // The card is the whole tab's, the line it names its table by among its fields.
    heldStep(chain, undefined, tally, call);
    expect(summed(tally).prepared).toEqual({ insertTableRows: 1 });
    let card = wholeTableChange(tab, call, LABEL);
    expect(JSON.stringify(card.description)).toContain("Text before the table");
    expect(JSON.stringify(card.description)).toContain("Named line");
    // Prepared again, the change is found stored: no run is decoded but for the piece, the
    // line before the table being read from stored Markdown where the piece does not hold it.
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

  it("a preparation's card reads the runs that differ", () => {
    // 20,000 paragraphs and a table in their middle, under the real cut.
    let lines = Array.from({ length: 20_000 }, (_, at) => `Line ${String(at).padStart(5, "0")}.`);
    let { storage, store, base } = pieceStore(linesWithTablesTab("tab-1", lines, [10_000]), RUN_SIZES);
    let longest = longestOf(storage, base);
    let peak = (run: () => unknown) => {
      docStoreCost.peakMarkdownCharsInHand = 0;
      run();
      return docStoreCost.peakMarkdownCharsInHand;
    };
    let measured = {
      replacement: peak(() => prepareTextReplacement(store, base, lines[5_000], "Changed.", LABEL, LIMIT)),
      append: peak(() => prepareAppend(store, base, "More")),
      row: peak(() => prepareTableChange(
        store, base, { method: "insertTableRows", lines: { table: 0, cells: [["x"]] } }, LABEL)),
      table: peak(() => prepareTableChange(
        store, base, { method: "insertTable", table: { rows: 1, columns: 1, after: lines[15_000] } }, LABEL)),
    };
    // THE MULTIPLE, from the code: the builders' piece is the joined Markdown of the runs
    // that hold the closure, two runs at most on this tab; the card then compares with one
    // run of each version in hand, and holds its two strings, each the edit's text and a
    // run of the version after at most. So two runs' Markdown and the edit's texts, whatever
    // the tab's 135 runs. (Measured: 6,393 characters for the replacement, 1,072 for the
    // append, 983 for the row and 4,249 for the table, the longest run being 4,238.)
    expect(listedRuns(storage, base).length).toBeGreaterThan(100);
    for (let held of Object.values(measured)) expect(held).toBeLessThanOrEqual(2 * longest + 64);
  });
});

/** The longest Markdown one run of `version` holds. */
function longestOf(storage: FakeDocStorage, version: DocVersion): number {
  return Math.max(...listedRuns(storage, version).map(run => run.markdown.length));
}

// ---------------------------------------------------------------------------
// What the tests above counted
// ---------------------------------------------------------------------------

describe("where two versions' lists differ", () => {
  it("is what the two lists compared say, and the same version differs nowhere", () => {
    // Every step the tests above prepared was held (`expectChanged`): the answer is the two
    // lists compared entry by entry, and every run listed reads as nothing or ends with a
    // line break.
    expect(listed.pairs).toBeGreaterThanOrEqual(WIDER ? 900 : 650);
    expect(listed.runs).toBeGreaterThan(10_000);
    expect(listed.anew).toBeGreaterThan(listed.pairs);
    let { storage, store, base } = pieceStore(continuedList(20), ONE);
    let runs = listedRuns(storage, base).length;
    expect(store.changed(base, base)).toEqual({ from: runs, beforeTo: runs, afterTo: runs });
  });

  it("an edit that never settles the carry and changes no later key differs in its own runs alone", () => {
    // An item added to a numbered list that no later run continues: the list's count is
    // another to the tab's end, which no run after it shows.
    let tab = asFetched(buildTab([
      para("Intro"), item("one", "N1"), item("two", "N1"),
      ...Array.from({ length: 30 }, (_, at) => para(`Filler ${at}.`)),
    ], PRESET_NUMBERED));
    let keyed = docStoreCost.runsKeyed;
    let { storage, store, before, after } = heldReplacementOf(tab, ONE, ADDED.oldMarkdown, ADDED.newMarkdown);
    // The keys of the 30 runs after the edit's were worked out to the tab's end: the carry
    // is never the earlier version's again.
    expect(docStoreCost.runsKeyed - keyed).toBeGreaterThanOrEqual(30);
    let runs = listedRuns(storage, before);
    let place = runs.findIndex(run => run.markdown.includes("1. two"));
    // The item's run is listed as it was and the run of the item added after it: the lists
    // differ in that one run, and every run after it is the entry it was.
    expect(store.changed(before, after)).toEqual({ from: place + 1, beforeTo: place + 1, afterTo: place + 2 });
    expect(listedRuns(storage, after).slice(place + 2).map(run => run.entry))
      .toEqual(runs.slice(place + 1).map(run => run.entry));
  });
});

/** The runs added before a string over the queues of the wider run, as measured. */
const WIDER_BEFORE = 23;

describe("the strings are the rule's", () => {
  it("over the recorded and the seeded queues, with no run added after a string", () => {
    // Every card of the queues was held to the rule on its two whole strings (`expectRuled`).
    // PINNED AS MEASURED: no run was added after a string, since the first character that
    // differs is in both; runs were added before one where lines only added stand behind
    // lines equal to them.
    expect(queued?.cards).toBeGreaterThanOrEqual(WIDER ? 800 : 570);
    expect(queued?.extensions).toEqual({ before: WIDER ? WIDER_BEFORE : 5, after: 0 });
    // Over every card of the file, the hand-made versions and the tabs made for a span
    // that leaves its strings among them.
    expect(ruled.extensions.after).toBe(0);
    // Some step of the queues leaves its tab reading as it did (a change of a table's look
    // that the Markdown does not show): its card is the answer of two tabs that read alike.
    // The hand-made versions add one more.
    expect(queued!.alike).toBeGreaterThanOrEqual(WIDER ? 10 : 1);
    expect(ruled.alike).toBeGreaterThan(queued!.alike);
    // A comparison reads few rows: the runs an edit's own text stands in, and the runs
    // listed under another key that it has to read to see that they read alike.
    expect(queued!.front.most).toBeLessThanOrEqual(8);
    expect(queued!.end.most).toBeLessThanOrEqual(8);
  });

  it("the rule on two whole strings gives the whole strings' span", () => {
    // THE REFERENCE ITSELF, with no store: pairs of strings of whole lines, drawn from a small
    // alphabet so that they repeat (list items at three depths, empty lines, a table's line);
    // lines replaced, added and removed, and for one pair in four a second change far before
    // or after; the string after cut into runs of one to four lines, some of them empty; no
    // range named, the replaced lines named, or a range named inside them.
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
        // One run in eight writes nothing: it starts no run of the reference's.
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
    // As measured: 22 runs added before a string and none after.
    expect(extended).toEqual({ before: 22, after: 0 });
    expect(alike).toBeGreaterThan(0);
    expect(long).toBeGreaterThan(1_000);
    expect(named).toBeGreaterThan(10_000);
  });
});

