// A model of how Google Docs applies the `documents.batchUpdate` requests the gatekeeper sends,
// on one tab. It covers what Google was seen to do, and where the record ends it says so in the
// doc comment of the behaviour it infers. A request, or a shape of document, outside that
// throws `NotModelledError` instead of guessing.

import type {
  Bullet, Dimension as ApiDimension, DocsLocation, DocsRange, GoogleDocsRequest, GoogleDocsTab,
  NestingLevel, OptionalColor as ApiColor, Paragraph, ParagraphElement, ParagraphStyle,
  StructuralElement,
  Table, TableCell, TableCellLocation, TableCellStyle, TableRow, TextRun, TextStyle,
} from "./docs-api";
import {
  BULLET_PRESETS, CHIP_PLACEHOLDER, holdsOwnSuggestion, holdsSuggestion,
  isGoogleDocsStrippedCharacter, LIST_LEVELS, loneChipCopy, madeByPreset,
} from "./docs-content";

/** A length as Google writes one, in points. */
type Dimension = { magnitude: number; unit: "PT" };

/** A colour as Google writes one on a text style. */
type OptionalColor = { color: { rgbColor: { red?: number; green?: number; blue?: number } } };

/**
 * A text style with the fields the model keeps beside those the gatekeeper's types name, under
 * Google's own names. No rendering shows them.
 */
export type ModelTextStyle = TextStyle & {
  underline?: boolean;
  foregroundColor?: OptionalColor;
  fontSize?: Dimension;
};

/**
 * A paragraph style with the fields the model keeps beside those the gatekeeper's types name,
 * under Google's own names. No rendering shows them.
 */
export type ModelParagraphStyle = ParagraphStyle & {
  indentStart?: Dimension;
  indentFirstLine?: Dimension;
  alignment?: string;
};

/** The colour Google gives the text of a link. */
export const LINK_COLOR: OptionalColor = {
  color: { rgbColor: { red: 0.06666667, green: 0.33333334, blue: 0.8 } },
};

/** The size the model's cells carry on their line breaks when they took a heading's look. */
const HEADING_LOOK_FONT_SIZE: Dimension = { magnitude: 16, unit: "PT" };

/** What `insertTable` stores on each cell, as probe D1 read it: no border fields. */
const INSERTED_CELL_STYLE: TableCellStyle = {
  rowSpan: 1, columnSpan: 1, backgroundColor: {}, contentAlignment: "TOP",
  paddingLeft: { magnitude: 5, unit: "PT" }, paddingRight: { magnitude: 5, unit: "PT" },
  paddingTop: { magnitude: 5, unit: "PT" }, paddingBottom: { magnitude: 5, unit: "PT" },
};

/**
 * The width the model narrows a fixed column to when a column is added beside one that shares
 * the page's width: what probe S2c saw for a cell of plain text and 5pt padding. Google does it
 * only sometimes; the model always does, so a change that does not set the widths back shows.
 */
const NARROWED_WIDTH = 13;

const OUTSIDE_PARAGRAPH = "The insertion index must be inside the bounds of an existing paragraph.";
const WITHIN_GRAPHEME = "The insertion index cannot be within a grapheme cluster.";
const EMPTY_RANGE = "The range should not be empty";
const INVALID_DELETION = "Invalid deletion range. Cannot delete the requested range.";
const NO_ROWS = "The number of table rows should be greater than zero.";
const INVALID_TABLE_START =
  "Invalid table start location. Must specify the start index of the table.";

const TEXT_FIELDS = [
  "bold", "italic", "strikethrough", "link", "underline", "foregroundColor", "fontSize",
] as const;
type TextField = typeof TEXT_FIELDS[number];

/** The look a paragraph's text loses, where it is the same on every run, to a named style. */
const LOOK_FIELDS = [
  "bold", "italic", "strikethrough", "underline", "foregroundColor", "fontSize",
] as const;

/** What a cell added to a table takes from the first character of the cell beside it. */
const COPIED_FIELDS = [
  "bold", "italic", "strikethrough", "link", "fontSize", "foregroundColor",
] as const;

const PARAGRAPH_FIELDS = ["namedStyleType", "indentStart", "indentFirstLine"] as const;
type ParagraphField = typeof PARAGRAPH_FIELDS[number];

/** What a run of the model cost. A caller that passes one has it counted into. */
export type ModelCost = {
  /** How many times every index of the piece in hand was recomputed: a tab's, or a slice's. */
  fullReindexes: number;
};

/**
 * What the replay of pending Doc edits has spent in this isolate since it started, counted
 * always (each is one integer added). Tests read the differences; nothing else reads them.
 */
export type ReplayCost = {
  /**
   * Tabs in hand rendered to Markdown whole (`renderTab`). Nothing of the store's path counts
   * here: it renders runs, never a tab.
   */
  renders: number;
  /**
   * Whole-tab copies the model made: one for each `applyDocsRequests` call.
   * `applyDocsRequestsToSlice` makes none.
   */
  tabClones: number;
  /**
   * Times every index of the piece in hand (a tab, or a slice of one) was recomputed, whether
   * or not a caller passed a `ModelCost`.
   */
  fullReindexes: number;
  /**
   * Reducer steps run: one for each pending record that a fold of the tab tree or of a tab is
   * given.
   */
  folds: number;
  /** Times a replay read the pending list from its queue: a storage scan of every record. */
  queueReads: number;
  /**
   * Times a tab's pending actions were serialized to tell later whether its queue moved
   * (`googleDocPendingFingerprint`).
   */
  fingerprints: number;
  /**
   * Parts of the piece in hand (a tab, or a slice of one: elements, rows and cells) whose
   * indexes a lookup by index compared with the index it was given, on its way to a paragraph
   * or a table.
   */
  lookupSteps: number;
};

/** The running totals of `ReplayCost`. */
export const replayCost: ReplayCost = {
  renders: 0, tabClones: 0, fullReindexes: 0, folds: 0, queueReads: 0, fingerprints: 0,
  lookupSteps: 0,
};

/** Which of Google's behaviours, where two are on record, the model takes. */
export type ModelOptions = {
  /** Copy into a new cell the look Google copies from the cell or heading beside it. */
  copyStyles?: boolean;
  /** Give text whose link is removed the style of the text before it, as Google documents. */
  unlinkRestyles?: boolean;
};

/**
 * The model's refusal to answer. `invariant` is false for a shape the request builders refuse
 * themselves, with their own text, before anything is sent: a document or request Google
 * accepts whose result is not on record. It is true for every other shape, which nothing the
 * builders send and no document Google returns reaches, whether or not Google would accept
 * the request: a throw there means a bug in a caller, never something to tell a user.
 * `what` names the shape and never holds document text.
 */
export class NotModelledError extends Error {
  readonly what: string;
  readonly invariant: boolean;

  constructor(what: string, isInvariant: boolean) {
    super(isInvariant
      ? `not modelled: ${what} (an internal invariant: nothing the gatekeeper sends reaches this)`
      : `not modelled: ${what}`);
    this.name = "NotModelledError";
    this.what = what;
    this.invariant = isInvariant;
  }
}

/** Refuse a shape the request builders refuse themselves before anything is sent. */
function notModelled(what: string): never {
  throw new NotModelledError(what, false);
}

/** Refuse a shape that nothing the builders send and no document Google returns reaches. */
function invariant(what: string): never {
  throw new NotModelledError(what, true);
}

/**
 * The tabs `applyDocsRequests` returned: each carries every index, exact, and no empty text
 * run, so a batch applied to one starts with nothing to recompute. Held weakly. A tab is never
 * changed in place, which is what lets it be known by its object. It speaks of tabs whole in
 * a caller's hand, which nothing that reads or edits a document holds: the path from stored
 * runs reads none of it.
 */
const indexed = new WeakSet<GoogleDocsTab>();

/**
 * Whether `tab`, a tab whole in a caller's hand, is one `applyDocsRequests` returned: every
 * index exact, no empty text run. Nothing that reads or edits a document holds such a tab: it
 * answers `true` for a tab a test hands on, and is kept for the whole-tab path.
 */
export function isModelIndexed(tab: GoogleDocsTab): boolean {
  return indexed.has(tab);
}

/**
 * Says of `tab` what `isModelIndexed` says of a tab the model returned. For a tab decoded
 * from the JSON such a tab was stored as, which holds the same indexes and the same runs: a
 * tab whole in a caller's hand (`DocStore.tab`), which nothing that reads or edits a document
 * decodes; kept for the whole-tab path.
 */
export function markModelIndexed(tab: GoogleDocsTab): void {
  indexed.add(tab);
}

/**
 * A piece of a tab as the model takes it: whole consecutive elements of the tab's body where
 * they stand, and the tab's shared data. A whole tab is the slice that holds every element.
 *
 * WHAT THE CALLER ESTABLISHES. `content` holds every index, exact, in the tab's coordinates
 * (the opening section break's start included), no empty text run, and footnote numbers by
 * place (`hasModelIndexes` and `hasModelFootnotes` of the tab; a stored run decoded at its
 * place is that: the one start a followed tab may leave out is the opening section break's,
 * which the decode writes, so no part of `content` is without a start). No two parts of it
 * are the same object (decoded JSON never is). `lists` holds the definition of each list a
 * paragraph of `content` names, cells included, AND AN ENTRY FOR EVERY ID OF THE TAB THAT
 * STARTS WITH `MODEL_LIST_ID`, whatever its definition (an empty one will do): a list the
 * model makes takes the lowest `model.N` no list of the WHOLE tab has, and a slice handed
 * only its own lists would mint an id a paragraph outside it uses. No other id of the tab is
 * read, so none need be handed.
 *
 * THE MODEL CHANGES `content` AND `lists` IN PLACE: the slice is its draft. After a batch
 * that throws, both are part-changed: discard them, and build the slice again to try again.
 */
export type TabSlice = {
  readonly tabId: string;
  readonly lists: GoogleDocsTab["lists"];
  readonly namedStyles?: GoogleDocsTab["namedStyles"];
  /** The slice's elements, in the body's order. */
  readonly content: StructuralElement[];
  /** The index the slice's first element starts at. Nothing a batch does moves it. */
  readonly origin: number;
  /** Whether the slice's first element is the tab's first. */
  readonly first: boolean;
  /** Whether the slice's last element is the tab's last. */
  readonly last: boolean;
  /** How many footnote references the tab holds before the slice, those of cells included. */
  readonly footnotesBefore: number;
};

/** What a batch applied to a slice leaves for the rest of the tab. */
export type SliceResult = {
  /**
   * How far every index after the slice moved: where the slice ends after the batch less
   * where it ended before.
   */
  readonly moved: number;
  /**
   * Whether a request ran that can remove a footnote reference or move one past another,
   * whatever it removed or moved. The slice's own references are numbered again from
   * `footnotesBefore`; those after the slice may stand at other places by now, which a
   * caller that keeps numbers relative to a run reads off the count of each run and rewrites
   * nowhere.
   */
  readonly footnotesMoved: boolean;
  /** The ids of the lists the batch added to `lists`, in the order it made them. */
  readonly lists: readonly string[];
};

/**
 * What the id of every list the model makes starts with: `model.` and then a number. A
 * caller that hands the model a piece of a tab hands it every id of the tab that starts so
 * (`TabSlice.lists`).
 */
export const MODEL_LIST_ID = "model.";

/**
 * Thrown where a batch reads an element the slice does not hold. Never a refusal of the
 * batch: the caller applies the batch again to a slice that also holds `index`, built again
 * from what it was built from. The message names the side and the index and nothing of the
 * document.
 */
export class SliceEdgeError extends Error {
  /** Which side of the slice the read fell on. */
  readonly side: "before" | "after";
  /**
   * The index the read wanted: below the slice's origin for `before`, at or past where the
   * slice ends for `after`. IN THE DRAFT'S COORDINATES: for `before` those are the tab's
   * own (nothing a batch does moves an index below the origin), for `after` they are the
   * tab's moved by what the batch's earlier requests added to or took from the slice. So
   * for `after` it is a guess at where in the tab the read falls (`batchReach` counts no
   * index an earlier request can have moved, for that reason): a caller that widens by it
   * may take a run the batch does not read, or come short and widen again. Either way the
   * outcome is the whole tab's.
   */
  readonly index: number;

  constructor(side: "before" | "after", index: number) {
    super(`slice edge: a read at index ${index} lies ${side} the slice`);
    this.name = "SliceEdgeError";
    this.side = side;
    this.index = index;
  }
}

/**
 * Google Docs' behaviour for the requests the gatekeeper sends, on one tab: a copy of `tab`
 * with `requests` applied in order and every index exact. `tab` is left as it is. Throws
 * an `Error` carrying Google's own text where Google refuses a request, and `NotModelledError`
 * where the model has no answer; either way nothing of the batch is applied, as Google applies
 * a batch whole or not at all. THE WHOLE-TAB ENTRY: nothing that reads or edits a document
 * calls it (an edit is made by `applyDocsRequestsToSlice` in the runs its batch touches); it is
 * the statement of a batch on a tab in hand that the slice entry is held to.
 */
export function applyDocsRequests(
  tab: GoogleDocsTab, requests: readonly GoogleDocsRequest[], options: ModelOptions = {},
  cost?: ModelCost,
): GoogleDocsTab {
  let { copy, draft } = copiedDraftAfter(tab, requests, options, cost);
  finish(draft);
  indexed.add(copy);
  return copy;
}

/**
 * Google Docs' behaviour for the requests the gatekeeper sends, on a piece of one tab:
 * `requests` applied in order to `slice`, IN PLACE, every index of it exact afterwards and
 * its footnote references numbered from `slice.footnotesBefore` where a request can have
 * moved one. Answers what the batch leaves for the rest of the tab (`SliceResult`).
 * Copies nothing and re-indexes nothing on the way in.
 *
 * Throws an `Error` carrying Google's own text where Google refuses a request and
 * `NotModelledError` where the model has no answer, as `applyDocsRequests` does, and
 * `SliceEdgeError` where a request reads an element the slice does not hold. For every slice
 * of a tab the outcome is that of the whole tab or a `SliceEdgeError`, never another tab
 * and never another refusal: a slice that is `first` and `last` never throws one.
 */
export function applyDocsRequestsToSlice(
  slice: TabSlice, requests: readonly GoogleDocsRequest[], options: ModelOptions = {},
  cost?: ModelCost,
): SliceResult {
  return finish(draftAfter(slice, requests, options, false, cost));
}

/** Where a lookup by index lands: the positions that lead there from the body. */
export type ModelPlace = {
  /**
   * The paragraph that holds the index: for each cell on the way, the position of its table,
   * its row and its column, then the paragraph's position in the body or the last cell.
   */
  paragraph?: readonly number[];
  /** The table that starts at the index, by the same path. */
  table?: readonly number[];
};

/**
 * Where the model finds `index` once `requests` are applied to a copy of `tab`, before the
 * indexes they moved are recomputed: what `paragraphAt` and `tableAt` answer in the draft the
 * next request of the batch would find. Tests compare it with a linear scan of the tab
 * `applyDocsRequests` returns for the same requests; nothing else reads it.
 */
export function modelPlaceAfter(
  tab: GoogleDocsTab, requests: readonly GoogleDocsRequest[], index: number,
  options: ModelOptions = {},
): ModelPlace {
  let { draft } = copiedDraftAfter(tab, requests, options);
  need(draft, index);
  return { paragraph: pathTo(paragraphAt(draft, index)), table: pathTo(tableAt(draft, index)) };
}

/** The positions that lead to `place` from the body, as a `ModelPlace` gives them. */
function pathTo(place: ParagraphPlace | TablePlace | undefined): number[] | undefined {
  return place && [
    ...place.cells.flatMap(cell => [cell.position, cell.rowIndex, cell.columnIndex]),
    place.position,
  ];
}

/**
 * A copy of `tab`, and the draft of it with `requests` applied in order: the copy is the
 * slice that holds every element, so it is the draft's own. The copy of a tab the model did
 * not return is indexed first: a tab as Google sent it may leave an index out or hold an
 * empty text run.
 */
function copiedDraftAfter(
  tab: GoogleDocsTab, requests: readonly GoogleDocsRequest[], options: ModelOptions,
  cost?: ModelCost,
): { copy: GoogleDocsTab; draft: Draft } {
  replayCost.tabClones++;
  let copy = structuredClone(tab);
  let whole: TabSlice = {
    tabId: copy.tabId, lists: copy.lists, namedStyles: copy.namedStyles,
    content: copy.body.content, origin: 0, first: true, last: true, footnotesBefore: 0,
  };
  return { copy, draft: draftAfter(whole, requests, options, !indexed.has(tab), cost) };
}

/**
 * The draft that is `slice` with `requests` applied in order, whose indexes are exact below
 * the watermark: the draft a further request of the batch would be applied to. `reindexFirst`
 * recomputes every index before the first request, for a piece whose indexes the caller has
 * not established.
 */
function draftAfter(
  slice: TabSlice, requests: readonly GoogleDocsRequest[], options: ModelOptions,
  reindexFirst: boolean, cost?: ModelCost,
): Draft {
  let draft: Draft = {
    tab: slice, body: new SliceBody(slice), endedAt: slice.origin, validBelow: Infinity,
    settled: new Map(), merged: new WeakMap(), unsuggested: new WeakSet(), footnotesMoved: false,
    made: [], cost,
  };
  if (reindexFirst) reindexAll(draft);
  draft.endedAt = draft.body.end();
  for (let request of requests) applyRequest(draft, request, options);
  return draft;
}

/**
 * Leave a draft as a batch leaves its piece of the tab, and say what the batch leaves for
 * the rest of the tab.
 */
function finish(draft: Draft): SliceResult {
  // Every index is recomputed unless none can be off: no request has moved one since they
  // were all exact. A request that empties a text run lowers the watermark too, so a draft
  // whose watermark stands at `Infinity` holds no empty run either.
  if (draft.validBelow !== Infinity) reindexAll(draft);
  // The footnotes are numbered once: nothing reads a footnote's number between two requests.
  if (draft.footnotesMoved) draft.body.renumber();
  // A piece stored again is cut into runs that count each element from where the one before
  // it ends, so a piece that does not read so from its origin is refused here, as a fault.
  if (!draft.body.follows()) invariant("a slice whose elements do not follow one another from its origin");
  return {
    moved: draft.body.end() - draft.endedAt, footnotesMoved: draft.footnotesMoved,
    lists: draft.made,
  };
}

/** A piece of a tab while requests are applied to it, and how far its indexes can be trusted. */
type Draft = {
  /** The tab's shared data: its id, its lists, which a request may add to, and its named styles. */
  tab: Pick<TabSlice, "tabId" | "lists" | "namedStyles">;
  /** The elements of the piece: every read of the body goes through it. */
  body: SliceBody;
  /** Where the piece ended before the first request, every index exact. */
  endedAt: number;
  /**
   * Every element that precedes this index in document order carries exact indexes, and so do
   * the start of each table, row and cell that holds it and their ends. What follows may be
   * off by what the requests so far added or removed. `Infinity` when every index is exact.
   */
  validBelow: number;
  /**
   * How many entries of each list on the way to the watermark carry exact indexes, counted
   * from the list's first: the body's elements, the rows of a table, the cells of a row and the
   * elements of a cell that hold the watermark. The last of them reaches the watermark, so a
   * lookup below the watermark finds its place among them and reads no entry past them. A list
   * that is not here is exact throughout wherever such a lookup reaches it. Empty while every
   * index is exact.
   */
  settled: Map<readonly Indexed[], number>;
  /**
   * Per table a lookup landed in, whether it holds a cell that spans more than one row or
   * column: only such a table has covered cells. Answered by one walk of the table's cells
   * and kept until `mergeTableCells` or `unmergeTableCells` names the table, the two requests
   * that change a span.
   */
  merged: WeakMap<Table, boolean>;
  /**
   * The tables a row or column request named that hold no suggestion on themselves, a row or a
   * cell. No request adds one, so a table is walked for them once, not once for each of the
   * requests that name it.
   */
  unsuggested: WeakSet<Table>;
  /**
   * Whether a request that can remove a footnote reference or move one past another ran, so
   * numbers are due: set by every `deleteContentRange`, `deleteTableRow`, `deleteTableColumn`
   * and `mergeTableCells`, whatever it removed or moved.
   */
  footnotesMoved: boolean;
  /** The ids of the lists the requests so far added to the tab's, in the order they were made. */
  made: string[];
  cost?: ModelCost;
};

/**
 * The elements of the piece of a body a draft works on, and THE ONE WAY TO THEM. The list is
 * private: the rest of the model reaches an element of the body only through a method here,
 * each of which judges a read that can fall outside the slice BY ITS INDEX, never by what it
 * found. A list of the body reaches other code only as the `container` of a place `entry`
 * answered, to be read and changed at the positions the lookup found.
 */
class SliceBody {
  readonly #content: StructuralElement[];
  /** The index the piece's first element starts at. Nothing a batch does moves it. */
  readonly origin: number;
  /** Whether the piece's first element is the tab's first. */
  readonly first: boolean;
  /** Whether the piece's last element is the tab's last. */
  readonly last: boolean;
  /** How many footnote references the tab holds before the piece. */
  readonly footnotesBefore: number;

  constructor(slice: TabSlice) {
    this.#content = slice.content;
    this.origin = slice.origin;
    this.first = slice.first;
    this.last = slice.last;
    this.footnotesBefore = slice.footnotesBefore;
  }

  /**
   * Where a lookup of `index` starts in the body: the list and the position of the first
   * settled element that ends after `index` (`settledEndingAfter`), -1 where none does. The
   * caller has made every index up to `index` exact (`need`). THE LIST IS ANSWERED AS
   * `container`, the name a place holds a list under, and every function that takes the
   * answer keeps it under that name (never another, never a destructuring that renames it):
   * so a census of every use of `container` covers the lookups' own reads of the body.
   *
   * THE GUARD. `index < origin` is before the slice whatever the slice holds by now (a batch
   * may have removed its first element): throws `before` unless `first`. At or past the
   * origin, no element found is past the slice's end: throws `after` unless `last`.
   */
  entry(draft: Draft, index: number): { container: StructuralElement[]; position: number } {
    let position = settledEndingAfter(draft, this.#content, index);
    // The side is the index's, never what the search found: nothing a batch does moves the
    // origin, and with every index up to this one exact, no settled element ending after it
    // means that it lies at or past where the piece ends.
    if (index < this.origin) {
      if (!this.first) throw new SliceEdgeError("before", index);
    } else if (position === -1) {
      if (!this.last) throw new SliceEdgeError("after", index);
    }
    return { container: this.#content, position };
  }

  /**
   * The element that stands directly before position `position` of the body. Position 0 of
   * a slice that is not `first` stands after an element the slice does not hold: throws
   * `before`, at index `origin - 1`.
   */
  before(position: number): StructuralElement | undefined {
    if (position === 0 && !this.first) throw new SliceEdgeError("before", this.origin - 1);
    return this.#content[position - 1];
  }

  /** Whether `container` is the body's own list (and not a cell's). */
  is(container: readonly StructuralElement[]): boolean {
    return container === this.#content;
  }

  /** Whether the body's first element is the tab's first: the opening section break's rule. */
  opens(): boolean {
    return this.first;
  }

  /** Recompute every index of the body, from `origin` (`walkContent`). */
  reindex(): void {
    walkContent(this.#content, this.origin, this.opens(), storeIndexes);
  }

  /** Number the body's footnote references by place, from `footnotesBefore`. */
  renumber(): void {
    walkFootnotes(this.#content, this.footnotesBefore, (reference, number) => {
      reference.footnoteNumber = number;
    });
  }

  /** Where the body's last element ends; `origin` for a body of none. */
  end(): number {
    return this.#content.at(-1)?.endIndex ?? this.origin;
  }

  /**
   * Whether every element of the body starts where the one before it ends, the first at
   * `origin`. One pass over the body's own elements, none entered.
   */
  follows(): boolean {
    let index = this.origin;
    for (let element of this.#content) {
      if (element.startIndex !== index) return false;
      index = element.endIndex;
    }
    return true;
  }
}

/**
 * Make every index that a lookup reads exact, before it reads any. `index` is the last index
 * the lookup reads, and which that is depends on the request:
 * - a range that is styled or bulleted reads the elements of `[startIndex, endIndex)` and
 *   needs `endIndex - 1`. Its exclusive end is where the watermark sits right after the
 *   paragraph it styles was written, as the style that ends every cell fill finds it, so
 *   asking for the exclusive end would recompute the whole piece once per fill;
 * - a deletion reads the element at its exclusive end and needs `endIndex` itself: the
 *   paragraph there is the one that survives, the code unit there tells whether the range
 *   cuts a surrogate pair, and a whole table is recognised by its end;
 * - an insertion needs its index, and a request that names a table that table's start.
 * At or past the watermark the whole piece in hand is recomputed, once, and counted.
 */
function need(draft: Draft, index: number): void {
  if (index >= draft.validBelow) reindexAll(draft);
}

/** Recompute every index of the draft's piece of the tab, and count it. */
function reindexAll(draft: Draft): void {
  draft.body.reindex();
  draft.validBelow = Infinity;
  draft.settled.clear();
  if (draft.cost) draft.cost.fullReindexes++;
  replayCost.fullReindexes++;
}

/**
 * Recompute the indexes of the `count` elements of a body or cell from `position` on, whose
 * lengths a request changed. The first of them starts at `start`, which is exact, and `was`
 * is where the last of them ended before the request. Every cell, row and table that holds
 * them ends later by what they grew, and the watermark comes down to their end: what follows
 * them in the piece is off by as much until the whole piece is recomputed.
 */
function touched(
  draft: Draft, { container, position, cells }: ParagraphPlace | TablePlace, count: number,
  start: number, was: number,
): void {
  let end = walkContent(
    container, start, draft.body.is(container) && draft.body.opens(), storeIndexes, position,
    position + count);
  for (let { element, row, cell } of cells) {
    cell.endIndex += end - was;
    row.endIndex += end - was;
    element.endIndex += end - was;
  }
  lower(draft, container, cells, position + count, end);
}

/**
 * Bring the watermark down to `index`: the first `count` entries of `container` are exact, and
 * so is every list that holds it down to the body, up to and with the table, row and cell of
 * `cells` that lead to it. What `settled` held is replaced: a lookup below the watermark
 * reaches no list that held the earlier one and does not hold this one.
 */
function lower(
  draft: Draft, container: readonly StructuralElement[], cells: readonly CellPlace[],
  count: number, index: number,
): void {
  let { settled } = draft;
  settled.clear();
  for (let held of cells) {
    settled.set(held.container, held.position + 1);
    if (held.table.tableRows) settled.set(held.table.tableRows, held.rowIndex + 1);
    if (held.row.tableCells) settled.set(held.row.tableCells, held.columnIndex + 1);
  }
  settled.set(container, count);
  draft.validBelow = index;
}

// ---------------------------------------------------------------------------
// Finding things by index
// ---------------------------------------------------------------------------

type ParagraphElementOf = StructuralElement & { paragraph: Paragraph };

/** A cell, by the table that holds it, that table's element, and its row and column there. */
type CellPlace = {
  element: StructuralElement;
  /** The list that holds `element`: the body's, or the cell's before it. */
  container: readonly StructuralElement[];
  /** Where `element` stands in `container`. */
  position: number;
  table: Table;
  row: TableRow;
  cell: TableCell;
  rowIndex: number;
  columnIndex: number;
};

/** A paragraph and the list of elements, a body's or a cell's, that holds it. */
type ParagraphPlace = {
  container: StructuralElement[];
  position: number;
  element: ParagraphElementOf;
  paragraph: Paragraph;
  /** The cells the paragraph lies in, the outermost first: none for a paragraph of the body. */
  cells: CellPlace[];
};

/** A table and the list of elements that holds it. */
type TablePlace = {
  container: StructuralElement[];
  position: number;
  element: StructuralElement;
  table: Table;
  /** The cells the table lies in, the outermost first: none for a table of the body. */
  cells: CellPlace[];
};

function isParagraph(element: StructuralElement): element is ParagraphElementOf {
  return element.paragraph !== undefined;
}

function cellsOf(table: Table): TableCell[] {
  return (table.tableRows ?? []).flatMap(row => row.tableCells ?? []);
}

/** Every paragraph of `container` in document order, those of table cells included. */
function* allParagraphs(container: readonly StructuralElement[]): Generator<ParagraphElementOf> {
  for (let element of container) {
    if (isParagraph(element)) yield element;
    else if (element.table) {
      for (let cell of cellsOf(element.table)) yield* allParagraphs(cell.content ?? []);
    }
  }
}

/**
 * The position of the first of `container` that ends after `index`, which is below the
 * draft's watermark: found by halving among the entries the draft has settled, the whole list
 * when it is not on the way to the watermark. A stored index past the watermark is not in
 * order with those before it, so no entry past the settled ones is read. -1 when none of them
 * ends after the index. `container` is a list of elements, of rows or of cells.
 */
function settledEndingAfter(draft: Draft, container: readonly Indexed[], index: number): number {
  let count = Math.min(container.length, draft.settled.get(container) ?? Infinity);
  let position = firstEndingAfter(container, index, count, true);
  return position < count ? position : -1;
}

/**
 * The cell whose content holds `index`, in the table that is the element at `position` of
 * `container`; none where that element is no table. It reads no row or cell past those the
 * draft has settled: the row is the first of them that reaches past the index, and the cell
 * the first of that row's.
 */
function cellHolding(
  draft: Draft, container: readonly StructuralElement[], position: number, index: number,
): CellPlace | undefined {
  let element = container[position];
  let { table } = element;
  if (!table) return undefined;
  let rows = table.tableRows ?? [];
  let rowIndex = settledEndingAfter(draft, rows, index);
  let row: TableRow | undefined = rows[rowIndex];
  let cells = row?.tableCells ?? [];
  let columnIndex = settledEndingAfter(draft, cells, index);
  let cell: TableCell | undefined = cells[columnIndex];
  // A cell's own index is before its content, in no paragraph.
  return row && cell && cell.startIndex < index
    ? { element, container, position, table, row, cell, rowIndex, columnIndex }
    : undefined;
}

/** The paragraph that holds `index`, in the body or in a table cell of it. */
function paragraphAt(draft: Draft, index: number): ParagraphPlace | undefined {
  let { container, position } = draft.body.entry(draft, index);
  return paragraphIn(draft, container, index, [], position);
}

/**
 * The paragraph that holds `index`, in `container` or in a table cell of it. `position` is
 * that of the first settled element of `container` that ends after `index`: searched for,
 * unless the caller has it (the body's, which its guard answered).
 */
function paragraphIn(
  draft: Draft, container: StructuralElement[], index: number, cells: CellPlace[],
  // Halved, not walked: at each list on the way (the body's elements, then a table's rows, a
  // row's cells and a cell's paragraphs) the lookup compares the index with about the binary
  // logarithm of the entries whose indexes are exact, and with none past the watermark.
  position = settledEndingAfter(draft, container, index),
): ParagraphPlace | undefined {
  let element: StructuralElement | undefined = container[position];
  if (!element || index < element.startIndex) return undefined;
  if (isParagraph(element)) {
    return { container, position, element, paragraph: element.paragraph, cells };
  }
  let held = cellHolding(draft, container, position, index);
  return held ? paragraphIn(draft, held.cell.content ?? [], index, [...cells, held]) : undefined;
}

/**
 * Whether another cell of the table covers this one with its row or column span. Such a cell
 * reads as an ordinary empty cell: only the spans of the cell that covers it tell.
 */
function isCovered({ table, rowIndex, columnIndex }: CellPlace): boolean {
  let rows = table.tableRows ?? [];
  for (let headRow = 0; headRow <= rowIndex; headRow++) {
    let cells = rows[headRow]?.tableCells ?? [];
    for (let headColumn = 0; headColumn <= columnIndex && headColumn < cells.length; headColumn++) {
      if (headRow === rowIndex && headColumn === columnIndex) continue;
      let spans = cells[headColumn].tableCellStyle;
      if (headRow + (spans?.rowSpan ?? 1) > rowIndex &&
        headColumn + (spans?.columnSpan ?? 1) > columnIndex) return true;
    }
  }
  return false;
}

/**
 * The paragraph a request names by `index`. Google puts text sent to a cell that a merged cell
 * covers into the merged cell, and what it does with any other request there nobody has seen, so
 * no request is applied to a paragraph of a covered cell.
 */
function requestedParagraphAt(draft: Draft, index: number): ParagraphPlace | undefined {
  need(draft, index);
  let place = paragraphAt(draft, index);
  // Only a table that holds a merged cell has a covered one, and a table is asked once: a walk
  // of its cells for every request to one of them would be a pass over the table each.
  if (place?.cells.some(cell => holdsMergedCell(draft, cell.table) && isCovered(cell))) {
    invariant("a request at a paragraph of a cell that a merged cell covers");
  }
  return place;
}

/** Whether a cell of `table` spans more than one row or column. */
function holdsMergedCell(draft: Draft, table: Table): boolean {
  let known = draft.merged.get(table);
  if (known === undefined) {
    known = cellsOf(table).some(({ tableCellStyle: spans }) =>
      (spans?.rowSpan ?? 1) > 1 || (spans?.columnSpan ?? 1) > 1);
    draft.merged.set(table, known);
  }
  return known;
}

/** The table whose start index is `index`, in the body or in a table cell of it. */
function tableAt(draft: Draft, index: number): TablePlace | undefined {
  let { container, position } = draft.body.entry(draft, index);
  return tableIn(draft, container, index, [], position);
}

/**
 * The table whose start index is `index`, in `container` or in a table cell of it, from
 * `position` as `paragraphIn` takes it.
 */
function tableIn(
  draft: Draft, container: StructuralElement[], index: number, cells: CellPlace[],
  position = settledEndingAfter(draft, container, index),
): TablePlace | undefined {
  let element: StructuralElement | undefined = container[position];
  let table = element?.table;
  if (!element || !table || index < element.startIndex) return undefined;
  if (element.startIndex === index) {
    return { container, position, element, table, cells };
  }
  let held = cellHolding(draft, container, position, index);
  return held ? tableIn(draft, held.cell.content ?? [], index, [...cells, held]) : undefined;
}

/** The table a request names by its start index. */
function requestedTableAt(draft: Draft, index: number): TablePlace | undefined {
  need(draft, index);
  return tableAt(draft, index);
}

/** The text style a paragraph element carries, whatever kind of element it is. */
function elementTextStyle(element: ParagraphElement): ModelTextStyle | undefined {
  return element.textRun?.textStyle ?? element.person?.textStyle ?? element.richLink?.textStyle ??
    element.dateElement?.textStyle ?? element.dropdown?.textStyle ?? element.autoText?.textStyle ??
    element.footnoteReference?.textStyle ?? element.inlineObjectElement?.textStyle ??
    element.pageBreak?.textStyle ?? element.columnBreak?.textStyle;
}

/**
 * The position of the first of the first `count` of `container` that ends after `index`,
 * `count` when none does. They are in index order, so this halves its way there. `counted`
 * says they are a tab's elements, rows or cells, whose comparisons `lookupSteps` counts;
 * a paragraph's elements are searched with it too.
 */
function firstEndingAfter(
  container: readonly { endIndex: number }[], index: number, count = container.length,
  counted = false,
): number {
  let low = 0;
  let high = count;
  while (low < high) {
    let middle = (low + high) >> 1;
    if (counted) replayCost.lookupSteps++;
    if (container[middle].endIndex > index) high = middle;
    else low = middle + 1;
  }
  return low;
}

function elementAt(draft: Draft, index: number): ParagraphElement | undefined {
  need(draft, index);
  let elements = paragraphAt(draft, index)?.paragraph.elements ?? [];
  let element = elements.at(firstEndingAfter(elements, index));
  return element && element.startIndex <= index ? element : undefined;
}

function styleAt(draft: Draft, index: number): ModelTextStyle | undefined {
  let element = elementAt(draft, index);
  return element && elementTextStyle(element);
}

/** The UTF-16 code unit at `index`, when a text run holds that index. */
function codeUnitAt(draft: Draft, index: number): number | undefined {
  let element = elementAt(draft, index);
  return element?.textRun?.content.charCodeAt(index - element.startIndex);
}

/** Whether `unit`, a UTF-16 code unit, is the first half of a surrogate pair. */
function isFirstHalf(unit: number | undefined): boolean {
  return unit !== undefined && unit >= 0xd800 && unit <= 0xdbff;
}

/** Whether `index` lies between the two halves of a surrogate pair. */
function splitsSurrogatePair(draft: Draft, index: number): boolean {
  need(draft, index);
  // The piece in hand starts at an element's start, and the unit before an element's start is
  // a line break or no text, never the first half of a pair (`hasModelIndexes`): so the unit
  // before the piece is not read.
  if (index <= draft.body.origin) return false;
  // The unit at the index is read only where the one before it is a first half.
  if (!isFirstHalf(codeUnitAt(draft, index - 1))) return false;
  let after = codeUnitAt(draft, index);
  return after !== undefined && after >= 0xdc00 && after <= 0xdfff;
}

function requireTab(tab: Draft["tab"], coordinate: { tabId: string }): void {
  if (coordinate.tabId !== tab.tabId) {
    invariant(`a coordinate that does not name tab "${tab.tabId}"`);
  }
}

/** The paragraphs a range touches, which must all lie in one body or one cell. */
function paragraphsInRange(
  draft: Draft, range: DocsRange, request: string,
): ParagraphElementOf[] {
  requireTab(draft.tab, range);
  if (range.startIndex >= range.endIndex) invariant(`${request} over an empty range`);
  need(draft, range.endIndex - 1);
  let first = requestedParagraphAt(draft, range.startIndex);
  let last = requestedParagraphAt(draft, range.endIndex - 1);
  if (!first || !last || first.container !== last.container) {
    invariant(`${request} over a range that is not within the paragraphs of one body or cell`);
  }
  let reached = first.container.slice(first.position, last.position + 1);
  if (!reached.every(isParagraph)) {
    invariant(`${request} over a range that holds a table or another structure`);
  }
  return reached;
}

/**
 * Whether two values of plain data (primitives, arrays and objects of them) are the same, key
 * for key. An object with a key the other lacks is not, also where the key holds `undefined`.
 */
export function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  let leftEntries = Object.entries(left);
  let rightValues: Record<string, unknown> = { ...right };
  return Array.isArray(left) === Array.isArray(right) &&
    leftEntries.length === Object.keys(rightValues).length &&
    leftEntries.every(([key, value]) =>
      Object.hasOwn(rightValues, key) && sameValue(value, rightValues[key]));
}

// ---------------------------------------------------------------------------
// Indexes
// ---------------------------------------------------------------------------

/** A part of a tab that carries indexes: an element, a row, a cell or a paragraph's element. */
type Indexed = StructuralElement | TableRow | TableCell | ParagraphElement;

/**
 * What a walk does with the indexes it computes for one part. It is called for a part after
 * the parts it holds.
 */
type IndexVisitor = (part: Indexed, startIndex: number, endIndex: number) => void;

/**
 * Compute the indexes of the elements of `container` from `from` up to `to`, the first of
 * which starts at `start`, and of everything they hold, and hand each to `visit`. `body` says
 * that `container` opens the tab's body: its first element is the tab's first. Gives the index
 * the last element ends at. This is the one definition of how a tab is indexed: recomputing
 * writes what it gives, and the index guard compares with it.
 */
function walkContent(
  container: readonly StructuralElement[], start: number, body: boolean, visit: IndexVisitor,
  from = 0, to = container.length,
): number {
  let index = start;
  for (let position = from; position < to; position++) {
    let element = container[position];
    let elementStart = index;
    if (element.paragraph) index = walkParagraph(element.paragraph, index, visit);
    else if (element.table) index = walkTable(element.table, index, visit);
    // The section break that opens a body takes one index; any other element keeps its length.
    else if (body && position === 0 && element.sectionBreak) index += 1;
    else index += element.endIndex - element.startIndex;
    visit(element, elementStart, index);
  }
  return index;
}

function walkParagraph(paragraph: Paragraph, start: number, visit: IndexVisitor): number {
  let index = start;
  for (let element of paragraph.elements) {
    // A text run is as long as its text; any other element keeps its length.
    let length = element.textRun?.content.length ?? element.endIndex - element.startIndex;
    visit(element, index, index + length);
    index += length;
  }
  return index;
}

function walkTable(table: Table, start: number, visit: IndexVisitor): number {
  // One index for the table's start, one for each row's and one for each cell's.
  let index = start + 1;
  for (let row of table.tableRows ?? []) {
    let rowStart = index++;
    for (let cell of row.tableCells ?? []) {
      let cellStart = index++;
      index = walkContent(cell.content ?? [], index, false, visit);
      visit(cell, cellStart, index);
    }
    visit(row, rowStart, index);
  }
  // And one for the table's end.
  return index + 1;
}

/** Write the indexes a walk computes, and drop the empty text runs, which Google does not keep. */
function storeIndexes(part: Indexed, startIndex: number, endIndex: number): void {
  part.startIndex = startIndex;
  part.endIndex = endIndex;
  if ("paragraph" in part && part.paragraph) {
    let { paragraph } = part;
    if (paragraph.elements.some(element => element.textRun?.content === "")) {
      paragraph.elements = paragraph.elements.filter(element => element.textRun?.content !== "");
    }
  }
}

/**
 * What `hasModelIndexes` and `hasModelFootnotes` ask of a tab whole, asked of its body AS THE
 * ELEMENTS PASS: a caller that reads a body once, and keeps no element, hands each over.
 */
export type ModelFollowing = {
  /** Takes the next element of the body, in the body's order. Reads it and changes nothing. */
  take(element: StructuralElement): void;
  /**
   * Whether the model follows the elements taken so far: `hasModelIndexes(tab) &&
   * hasModelFootnotes(tab)` of a tab whose body is those elements, in that order, and whose
   * lists are the ones the following was made with.
   */
  followed(): boolean;
};

/** Whether `following` follows the body of `tab`, handed to it element by element. */
function followsTab(following: ModelFollowing, tab: GoogleDocsTab): boolean {
  for (let element of tab.body.content) following.take(element);
  return following.followed();
}

/**
 * The index guard as a body's elements pass: whether every index Google sent in the elements
 * taken is the one the model computes from their content, and whether the elements are ones a
 * batch can be applied to a piece of (`hasModelIndexes` says which). It carries the index the
 * last element ends at, and whether the body is opened, which is all one element's indexes
 * take of the elements before it. `lists` is what the tab defines, as `modelFollowing` takes
 * it.
 */
function followingIndexes(lists: Readonly<Record<string, unknown>>): ModelFollowing {
  let same = true;
  let index = 0;
  let opened = false;
  // Google leaves out the start of the section break that opens a body, and of nothing else a
  // body holds: a part without a start anywhere else is not one the model can place.
  let opening: StructuralElement | undefined;
  let visit: IndexVisitor = (part, startIndex, endIndex) => {
    let sent: { startIndex?: number; endIndex: number } = part;
    let start = sent.startIndex ?? (part === opening ? 0 : undefined);
    // The model drops an empty text run, so a tab that holds one is not indexed as it is.
    let emptyRun = "textRun" in part && part.textRun?.content === "";
    // A list the model makes takes the lowest id of its own form that the tab does not
    // define, so a paragraph that names one with no definition would join a list a later
    // batch makes: a change outside what the batch touches.
    let listId = "paragraph" in part ? part.paragraph?.bullet?.listId : undefined;
    let undefinedOwn = listId !== undefined && listId.startsWith(MODEL_LIST_ID) &&
      !Object.hasOwn(lists, listId);
    if (start !== startIndex || sent.endIndex !== endIndex || emptyRun || undefinedOwn) {
      same = false;
    }
  };
  return {
    take(element) {
      opening = !opened && element.sectionBreak ? element : undefined;
      index = walkContent([element], index, !opened, visit);
      opened = true;
      // A piece of the body may start after any paragraph of the body, and the unit before
      // its start is taken for no first half of a surrogate pair (`splitsSurrogatePair`).
      let last = element.paragraph?.elements.at(-1)?.textRun?.content;
      if (isFirstHalf(last?.charCodeAt(last.length - 1))) same = false;
    },
    followed: () => same,
  };
}

/**
 * Whether every index Google sent in `tab` is the one the model computes from the tab's
 * content: the model's indexing is then the identity on the tab, and a request built against
 * the tab lands in the model where it lands in the document. The start of the section break
 * that opens the body, which Google leaves out, is 0; a tab with any other start left out is
 * not followed. False for a tab that holds an element whose length the model's rules get
 * wrong; such a tab cannot be replayed. False too for a tab one of whose body paragraphs ends
 * in the first half of a surrogate pair: a batch is applied to a piece of a tab without
 * reading the unit before the piece. False too for a tab one of whose paragraphs names a list
 * of the model's own form (`MODEL_LIST_ID`) that the tab does not define: the model would
 * give that id to the next list it makes. Reads the tab and changes nothing.
 */
export function hasModelIndexes(tab: GoogleDocsTab): boolean {
  return followsTab(followingIndexes(tab.lists), tab);
}

/**
 * The refusal of a write `op` to a tab the model cannot follow (`hasModelIndexes` or
 * `hasModelFootnotes` fails for it): the tab can be read and not changed through this
 * connection.
 */
export function unindexedTabRefusal(op: string): Error {
  return new Error(
    `${op}: this tab holds content whose place in the document cannot be worked out here, so a ` +
    "change to it could not be shown as it will read once applied. The tab can be read but not " +
    "changed through this connection. Make the change in Google Docs.");
}

/** A footnote reference, as a paragraph holds one. */
type FootnoteReference = NonNullable<ParagraphElement["footnoteReference"]>;

/**
 * Hand `visit` each footnote reference of `container` with the number its place gives it: its
 * place among the tab's references, body and cells in order, counted from 1, as a string.
 * `before` is how many references the tab holds before `container`; gives how many it holds
 * to the end of `container`. This is the one definition of how footnotes are numbered:
 * numbering writes what it gives, and the footnote guard compares with it.
 */
function walkFootnotes(
  container: readonly StructuralElement[], before: number,
  visit: (reference: FootnoteReference, number: string) => void,
): number {
  let place = before;
  for (let { paragraph } of allParagraphs(container)) {
    for (let { footnoteReference } of paragraph.elements) {
      if (footnoteReference) visit(footnoteReference, String(++place));
    }
  }
  return place;
}

/**
 * The footnote guard as a body's elements pass: whether every footnote reference of the
 * elements taken holds the number its place gives it. It carries the count of references.
 */
function followingFootnotes(): ModelFollowing {
  let same = true;
  let place = 0;
  let visit = (reference: FootnoteReference, number: string) => {
    if (reference.footnoteNumber !== number) same = false;
  };
  return {
    take(element) {
      place = walkFootnotes([element], place, visit);
    },
    followed: () => same,
  };
}

/**
 * Whether every footnote reference of `tab` holds the number the model gives it: its place
 * among the tab's references, body and cells in order, counted from 1, as a string. The
 * model numbers footnotes by place after a request that can move one, so a tab whose numbers
 * are anything else would read otherwise once such a request is applied. Reads the tab and
 * changes nothing.
 */
export function hasModelFootnotes(tab: GoogleDocsTab): boolean {
  return followsTab(followingFootnotes(), tab);
}

/**
 * A `ModelFollowing` that has taken no element: it follows an empty body. `lists` is what
 * the tab defines; only whether an id of the model's own form (`MODEL_LIST_ID`) is among
 * them is read, so a caller that holds no definition may hand the ids alone.
 */
export function modelFollowing(lists: Readonly<Record<string, unknown>>): ModelFollowing {
  let indexes = followingIndexes(lists);
  let footnotes = followingFootnotes();
  return {
    take(element) {
      indexes.take(element);
      footnotes.take(element);
    },
    followed: () => indexes.followed() && footnotes.followed(),
  };
}

// ---------------------------------------------------------------------------
// Building content
// ---------------------------------------------------------------------------

/** The fields Google marks suggested text with. */
type RunSuggestions =
  Pick<TextRun, "suggestedInsertionIds" | "suggestedDeletionIds" | "suggestedTextStyleChanges">;

/** A copy of the suggestions `run` carries, for a run cut from it: each part keeps them. */
function runSuggestions(run: TextRun): RunSuggestions {
  let { suggestedInsertionIds, suggestedDeletionIds, suggestedTextStyleChanges } = run;
  return structuredClone({
    ...(suggestedInsertionIds ? { suggestedInsertionIds } : {}),
    ...(suggestedDeletionIds ? { suggestedDeletionIds } : {}),
    ...(suggestedTextStyleChanges ? { suggestedTextStyleChanges } : {}),
  });
}

function textRun(
  content: string, textStyle: ModelTextStyle, suggestions: RunSuggestions = {},
): ParagraphElement {
  return {
    startIndex: 0, endIndex: content.length, textRun: { content, textStyle, ...suggestions },
  };
}

/**
 * A run of `written`, styled as `run` is and carrying none of its suggestions: text inserted
 * beside suggested text is no part of the suggestion (recorded in `suggestions-beside-edits`).
 */
function besideSuggestion(written: string, run: TextRun): ParagraphElement {
  return textRun(written, structuredClone(run.textStyle));
}

/** A paragraph element holding `elements`, with indexes still to be computed. */
function paragraphElement(
  elements: ParagraphElement[], paragraphStyle: ModelParagraphStyle, bullet: Bullet | undefined,
): ParagraphElementOf {
  return {
    startIndex: 0,
    endIndex: 0,
    paragraph: { elements, paragraphStyle, ...(bullet ? { bullet } : {}) },
  };
}

/** A copy of `paragraph`'s style and bullet around other content, as Google splits a paragraph. */
function siblingParagraph(paragraph: Paragraph, elements: ParagraphElement[]): ParagraphElementOf {
  return paragraphElement(
    elements, structuredClone(paragraph.paragraphStyle), structuredClone(paragraph.bullet));
}

function plainParagraph(lineBreak: ModelTextStyle = {}): ParagraphElementOf {
  return paragraphElement(
    [textRun("\n", lineBreak)], { namedStyleType: "NORMAL_TEXT" }, undefined);
}

function cellOf(paragraph: ParagraphElementOf): TableCell {
  return { startIndex: 0, endIndex: 0, content: [paragraph] };
}

/** The indent Google leaves on, or copies from, a list item of one nesting level. */
function listItemIndent(
  bullet: Bullet,
): Pick<ModelParagraphStyle, "indentStart" | "indentFirstLine"> {
  let level = bullet.nestingLevel ?? 0;
  return {
    indentStart: { magnitude: 36 * (level + 1), unit: "PT" },
    indentFirstLine: { magnitude: 18 + 36 * level, unit: "PT" },
  };
}

/** `color` as Google stores it: without the components that are 0. */
function storedColor<Color extends ApiColor>(color: Color): Color {
  let stored = structuredClone(color);
  let rgb = stored.color?.rgbColor;
  for (let part of ["red", "green", "blue"] as const) {
    if (rgb?.[part] === 0) delete rgb[part];
  }
  return stored;
}

/** `length` as Google stores it: without its magnitude where that is 0. */
function storedLength(length: ApiDimension): ApiDimension {
  let { magnitude, ...rest } = length;
  return magnitude === 0 ? rest : { ...rest, magnitude };
}

/**
 * Copy one field of a text style, removing it where the source has none. A colour is copied as
 * Google stores one.
 */
function copyTextField<Field extends TextField>(
  target: ModelTextStyle, source: ModelTextStyle, field: Field,
): void {
  let { foregroundColor } = source;
  if (field === "foregroundColor" && foregroundColor) {
    target.foregroundColor = storedColor(foregroundColor);
  } else if (source[field] === undefined) delete target[field];
  else target[field] = structuredClone(source[field]);
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

function applyRequest(draft: Draft, request: GoogleDocsRequest, options: ModelOptions): void {
  if ("insertText" in request) return insertText(draft, request.insertText);
  if ("deleteContentRange" in request) return deleteContentRange(draft, request.deleteContentRange);
  if ("updateTextStyle" in request) return updateTextStyle(draft, request.updateTextStyle, options);
  if ("updateParagraphStyle" in request) {
    return updateParagraphStyle(draft, request.updateParagraphStyle);
  }
  if ("deleteParagraphBullets" in request) {
    return deleteParagraphBullets(draft, request.deleteParagraphBullets);
  }
  if ("createParagraphBullets" in request) {
    return createParagraphBullets(draft, request.createParagraphBullets);
  }
  if ("insertTable" in request) return insertTable(draft, request.insertTable, options);
  if ("insertTableRow" in request) {
    let { tableCellLocation, insertBelow } = request.insertTableRow;
    return insertTableRow(draft, tableCellLocation, insertBelow, options);
  }
  if ("insertTableColumn" in request) {
    let { tableCellLocation, insertRight } = request.insertTableColumn;
    return insertTableColumn(draft, tableCellLocation, insertRight, options);
  }
  if ("deleteTableRow" in request) {
    return deleteTableRow(draft, request.deleteTableRow.tableCellLocation);
  }
  if ("deleteTableColumn" in request) {
    return deleteTableColumn(draft, request.deleteTableColumn.tableCellLocation);
  }
  if ("pinTableHeaderRows" in request) return pinTableHeaderRows(draft, request.pinTableHeaderRows);
  if ("updateTableColumnProperties" in request) {
    return updateTableColumnProperties(draft, request.updateTableColumnProperties);
  }
  if ("updateTableCellStyle" in request) {
    return updateTableCellStyle(draft, request.updateTableCellStyle);
  }
  if ("updateTableRowStyle" in request) {
    return updateTableRowStyle(draft, request.updateTableRowStyle);
  }
  if ("mergeTableCells" in request) {
    return mergeTableCells(draft, request.mergeTableCells.tableRange);
  }
  if ("unmergeTableCells" in request) {
    return unmergeTableCells(draft, request.unmergeTableCells.tableRange);
  }
  invariant(`the request ${Object.keys(request).join(", ")}`);
}

/**
 * What a batch names of its tab IN THE TAB'S OWN COORDINATES: the first guess at the
 * elements it reads. A batch is written front to back, so an index past where an earlier
 * request of it changed a length is in coordinates that request moved, and names nothing
 * of the tab as it is stored: such an index is not counted. What the batch reads there is
 * in the slice as it grew or is found by the guard of a slice, which is what makes a slice
 * chosen by a guess safe.
 */
export type BatchReach = {
  /** The lowest index counted. */
  readonly from: number;
  /** The highest: a deletion's exclusive end counts, since the element there is read. */
  readonly to: number;
  /**
   * The start of each `createParagraphBullets` range that is counted: the request reads
   * the element before the paragraph that holds it.
   */
  readonly behind: readonly number[];
};

/**
 * What one request names of its tab, as the request is written: `low` and `high`, its lowest
 * and its highest index; `lengthens`, whether it can change a length; and `behind`, set where
 * it reads the element before the paragraph its lowest index is in.
 */
export type Named = { low: number; high: number; lengthens: boolean; behind?: boolean };

/** What a request at one index names: an insertion, or a table request, by its table's start. */
function namedAt({ index }: DocsLocation, lengthens: boolean): Named {
  return { low: index, high: index, lengthens };
}

/** What a styled or bulleted range names: its start, and the last index it holds. */
function namedOver({ startIndex, endIndex }: DocsRange, lengthens: boolean): Named {
  return { low: startIndex, high: Math.max(startIndex, endIndex - 1), lengthens };
}

/**
 * What `request` names, by its kind: the kinds `applyRequest` takes, one for one, and
 * `undefined` for any other. An insertion names its index; a deletion its start and its
 * exclusive end; a styled or bulleted range its start and the last index it holds, or its
 * start where it is empty; a table request the start of its table. The indexes are the
 * request's own: where an earlier request of its batch changed a length, they are in the
 * coordinates that request left, which is the caller's to count (`batchReach`).
 */
export function namedBy(request: GoogleDocsRequest): Named | undefined {
  if ("insertText" in request) return namedAt(request.insertText.location, true);
  if ("deleteContentRange" in request) {
    let { startIndex, endIndex } = request.deleteContentRange.range;
    return { low: startIndex, high: endIndex, lengthens: true };
  }
  if ("updateTextStyle" in request) return namedOver(request.updateTextStyle.range, false);
  if ("updateParagraphStyle" in request) {
    return namedOver(request.updateParagraphStyle.range, false);
  }
  if ("deleteParagraphBullets" in request) {
    return namedOver(request.deleteParagraphBullets.range, false);
  }
  // The tabs a bulleted paragraph starts with are taken off.
  if ("createParagraphBullets" in request) {
    return { ...namedOver(request.createParagraphBullets.range, true), behind: true };
  }
  if ("insertTable" in request) return namedAt(request.insertTable.location, true);
  if ("insertTableRow" in request) {
    return namedAt(request.insertTableRow.tableCellLocation.tableStartLocation, true);
  }
  if ("insertTableColumn" in request) {
    return namedAt(request.insertTableColumn.tableCellLocation.tableStartLocation, true);
  }
  if ("deleteTableRow" in request) {
    return namedAt(request.deleteTableRow.tableCellLocation.tableStartLocation, true);
  }
  if ("deleteTableColumn" in request) {
    return namedAt(request.deleteTableColumn.tableCellLocation.tableStartLocation, true);
  }
  if ("pinTableHeaderRows" in request) {
    return namedAt(request.pinTableHeaderRows.tableStartLocation, false);
  }
  if ("updateTableColumnProperties" in request) {
    return namedAt(request.updateTableColumnProperties.tableStartLocation, false);
  }
  if ("updateTableCellStyle" in request) {
    let { tableCellLocation } = request.updateTableCellStyle.tableRange;
    return namedAt(tableCellLocation.tableStartLocation, false);
  }
  if ("updateTableRowStyle" in request) {
    return namedAt(request.updateTableRowStyle.tableStartLocation, false);
  }
  // A merge moves the paragraphs of the cells it joins, and drops those of an empty one.
  if ("mergeTableCells" in request) {
    return namedAt(request.mergeTableCells.tableRange.tableCellLocation.tableStartLocation, true);
  }
  if ("unmergeTableCells" in request) {
    let { tableCellLocation } = request.unmergeTableCells.tableRange;
    return namedAt(tableCellLocation.tableStartLocation, false);
  }
  return undefined;
}

/**
 * The reach of `requests`, or `undefined` where none of them names an index (no request, or
 * only kinds the model does not take). Per kind, what a request names: an insertion
 * (`insertText`, `insertTable`) its index; `deleteContentRange` its start and its exclusive
 * end; a styled or bulleted range (`updateTextStyle`, `updateParagraphStyle`,
 * `createParagraphBullets`, `deleteParagraphBullets`) its start and the last index it holds
 * (`endIndex - 1`, and its start where it is empty); every table request the start of its
 * table.
 *
 * AN INDEX COUNTS WHILE NO EARLIER REQUEST CAN HAVE MOVED IT: the requests are read in
 * order, and an index counts where it is at or below the lowest index at which an earlier
 * request can change a length (at that index the element is the one the earlier request
 * wrote to). The kinds that can are `insertText`, `deleteContentRange`, `insertTable`,
 * `createParagraphBullets` (it takes leading tabs off), `insertTableRow`,
 * `insertTableColumn`, `deleteTableRow`, `deleteTableColumn` and `mergeTableCells`, each
 * taken to change lengths from the lowest index it names; the other eight change no
 * length. THAT FLOOR IS EXACT FOR EVERY KIND BUT ONE: `createParagraphBullets` takes the
 * leading tabs off each paragraph FROM THE PARAGRAPH'S START, which is below the range's
 * start where the range starts inside a paragraph. The floor of a bulleted range is still
 * its start, so a later index between the paragraph's start and the range's start is
 * counted though the tabs taken off may have moved it: it is then a guess, as an index
 * after a widening is, and the guard makes the outcome right (a read outside the slice
 * widens it). The builders bullet whole paragraphs, so their batches never name such an
 * index. So the reach of a replacement is its deletion, that of a row added with text is the
 * table's start, and a batch written from the back of the tab to the front counts every
 * request. No index is checked here: a batch whose indexes no request can have moved is read
 * as written.
 */
export function batchReach(requests: readonly GoogleDocsRequest[]): BatchReach | undefined {
  let from = Infinity;
  let to = -Infinity;
  let behind: number[] = [];
  let floor = Infinity;
  for (let request of requests) {
    let named = namedBy(request);
    if (!named) continue;
    for (let index of [named.low, named.high]) {
      if (index > floor) continue;
      from = Math.min(from, index);
      to = Math.max(to, index);
    }
    if (named.behind && named.low <= floor) behind.push(named.low);
    if (named.lengthens) floor = Math.min(floor, named.low);
  }
  return from === Infinity ? undefined : { from, to, behind };
}

/** `text` without the characters Google removes from inserted text. */
function writtenText(text: string): string {
  return Array.from({ length: text.length }, (_, index) => text[index])
    .filter(unit => !isGoogleDocsStrippedCharacter(unit.charCodeAt(0)))
    .join("");
}

function insertText(
  draft: Draft, { location, text }: { location: DocsLocation; text: string },
): void {
  requireTab(draft.tab, location);
  let { index } = location;
  let place = requestedParagraphAt(draft, index);
  if (!place) {
    throw new Error(
      `${OUTSIDE_PARAGRAPH} You can still create new paragraphs by inserting newlines.`);
  }
  if (splitsSurrogatePair(draft, index)) throw new Error(WITHIN_GRAPHEME);
  let written = writtenText(text);
  if (written === "") invariant("insertText of no text");

  let { elements } = place.paragraph;
  let position = elements.findIndex(element =>
    element.startIndex <= index && index < element.endIndex);
  let here = elements[position];
  if (here.startIndex < index) {
    // Inside a text run the text joins it, a link included, and so does a suggestion on the
    // run: Google makes the text part of it (probed live; the builders refuse such an insert).
    if (!here.textRun) invariant("insertText inside an element that is not text");
    let offset = index - here.startIndex;
    here.textRun.content =
      here.textRun.content.slice(0, offset) + written + here.textRun.content.slice(offset);
  } else {
    let before = elements[position - 1]?.textRun;
    if (before && !before.textStyle.link) {
      if (holdsSuggestion(before)) elements.splice(position, 0, besideSuggestion(written, before));
      else before.content += written;
    } else if (before) {
      // Text never joins the link it follows: it is styled as what comes after it.
      if (!here.textRun) invariant("insertText between a link and an element that is not text");
      if (holdsSuggestion(here.textRun)) {
        elements.splice(position, 0, besideSuggestion(written, here.textRun));
      } else {
        here.textRun.content = written + here.textRun.content;
      }
    } else if (here.textRun && !here.textRun.textStyle.link) {
      if (holdsSuggestion(here.textRun)) {
        elements.splice(position, 0, besideSuggestion(written, here.textRun));
      } else {
        here.textRun.content = written + here.textRun.content;
      }
    } else {
      // Nothing to take a style from: before a link, or before an element that is not text.
      elements.splice(position, 0, textRun(written, {}));
    }
  }
  let { startIndex, endIndex } = place.element;
  touched(draft, place, splitAtLineBreaks(place), startIndex, endIndex);
}

/**
 * Make a paragraph of each line of `place`'s paragraph: a line break ends a paragraph. Gives
 * how many paragraphs that made.
 */
function splitAtLineBreaks(place: ParagraphPlace): number {
  let { paragraph } = place;
  let lines: ParagraphElement[][] = [[]];
  for (let element of paragraph.elements) {
    let run = element.textRun;
    if (!run) {
      lines[lines.length - 1].push(element);
      continue;
    }
    for (let piece of run.content.split(/(?<=\n)/)) {
      lines[lines.length - 1].push(
        textRun(piece, structuredClone(run.textStyle), runSuggestions(run)));
      if (piece.endsWith("\n")) lines.push([]);
    }
  }
  if (lines[lines.length - 1].length > 0) {
    invariant("a paragraph that does not end in a line break");
  }
  lines.pop();
  if (lines.length === 0) invariant("a paragraph with no content");
  // Google gives a split paragraph's suggested bullet to the first part as a bullet, and the
  // suggestion to the last (recorded, and refused by the builders).
  if (lines.length > 1 && holdsOwnSuggestion(paragraph)) {
    notModelled("a split of a paragraph that holds a suggested change to its style or bullet");
  }
  // The first paragraph stays the one it was; each further one copies its style and bullet.
  paragraph.elements = lines[0];
  place.container.splice(place.position + 1, 0,
    ...lines.slice(1).map(line => siblingParagraph(paragraph, line)));
  return lines.length;
}

/** The elements of a paragraph without the indexes `[from, to)`. */
function elementsWithout(
  element: ParagraphElementOf, from: number, to: number,
): ParagraphElement[] {
  let kept: ParagraphElement[] = [];
  for (let part of element.paragraph.elements) {
    if (part.endIndex <= from || part.startIndex >= to) {
      kept.push(part);
    } else if (part.textRun) {
      let { content, textStyle } = part.textRun;
      let rest = content.slice(0, Math.max(0, from - part.startIndex)) +
        content.slice(Math.min(content.length, to - part.startIndex));
      if (rest) kept.push(textRun(rest, textStyle, runSuggestions(part.textRun)));
    } else if (part.startIndex < from || part.endIndex > to) {
      invariant("a deletion of part of an element that is not text");
    }
  }
  return kept;
}

function deleteContentRange(draft: Draft, { range }: { range: DocsRange }): void {
  requireTab(draft.tab, range);
  let { startIndex: start, endIndex: end } = range;
  if (start === end) throw new Error(EMPTY_RANGE);
  if (start > end) invariant("a deletion whose range ends before it starts");
  // A deletion reads what stands at its exclusive end: the paragraph that survives, the code
  // unit a surrogate pair is told by, and the end of a table it removes whole.
  need(draft, end);
  // Google refuses to delete half of a surrogate pair.
  if (splitsSurrogatePair(draft, start) || splitsSurrogatePair(draft, end)) {
    throw new Error(INVALID_DELETION);
  }
  let first = requestedParagraphAt(draft, start);
  if (!first) {
    let found = tableAt(draft, start);
    if (found && found.element.endIndex === end) {
      if (found.cells.length > 0) invariant("the deletion of a table inside a cell");
      found.container.splice(found.position, 1);
      // Nothing is left to recompute: what stood before the table is as it was.
      lower(draft, found.container, [], found.position, start);
      draft.footnotesMoved = true;
      return;
    }
    if (found && end > found.element.endIndex) {
      invariant("a deletion that takes a table together with what follows it");
    }
    // The start, the end, a row or a cell of a table: a range may cross into a table only by
    // holding all of it.
    let { container, position } = draft.body.entry(draft, start);
    if (container[position]?.table) throw new Error(INVALID_DELETION);
    invariant("a deletion that starts outside a paragraph and outside a table");
  }

  let last = requestedParagraphAt(draft, end);
  // What follows the range has to be a paragraph of the same body or cell: the final line break
  // of a body or a cell, and the one before a table, cannot be deleted.
  if (!last || last.container !== first.container) throw new Error(INVALID_DELETION);
  // Deleting suggested text discards that much of the suggestion, and a paragraph removed or
  // joined into the next takes the suggested changes to its style and bullet with it.
  let taken = first.container.slice(first.position, last.position + 1);
  for (let { paragraph } of taken) {
    if (!paragraph) continue;
    if (paragraph.elements.some(part => part.textRun && holdsSuggestion(part.textRun) &&
        part.startIndex < end && start < part.endIndex)) {
      notModelled("a deletion of text that holds a suggestion");
    }
    if (paragraph !== last.paragraph && holdsOwnSuggestion(paragraph)) {
      notModelled("a deletion of a paragraph that holds a suggested change to its style or bullet");
    }
  }
  let firstStart = first.element.startIndex;
  let lastEnd = last.element.endIndex;
  if (last.position === first.position) {
    first.paragraph.elements = elementsWithout(first.element, start, end);
  } else {
    if (!taken.every(isParagraph)) {
      invariant(
        "a deletion that takes a table or another structure together with text around it");
    }
    // Inferred, not on record: a positioned object stays with its paragraph when whole paragraphs
    // in front of it are deleted, since nothing of that paragraph changes. What Google does with
    // the object of a paragraph that is removed, or that text is joined into, nobody has seen:
    // the builders refuse every edit that would send such a deletion.
    let removesAnchor = taken.slice(0, -1).some(({ paragraph }) =>
      paragraph.positionedObjectIds?.length);
    let joinsIntoAnchor = last.paragraph.positionedObjectIds?.length &&
      start > first.element.startIndex;
    if (removesAnchor || joinsIntoAnchor) {
      notModelled(
        "a deletion that removes a paragraph that anchors a positioned object, or joins text " +
        "into one");
    }
    // The paragraph whose line break remains survives, with its style and bullet.
    last.paragraph.elements = [
      ...elementsWithout(first.element, start, first.element.endIndex),
      ...elementsWithout(last.element, last.element.startIndex, end),
    ];
    first.container.splice(first.position, last.position - first.position);
  }
  // The paragraph that survives stands where the first one stood.
  touched(draft, first, 1, firstStart, lastEnd);
  draft.footnotesMoved = true;
}

/** The names in a field mask, each of which must be one of `known`. */
function fieldNames<Field extends string>(
  fields: string, known: readonly Field[], request: string,
): Set<Field> {
  let names = new Set<Field>();
  for (let name of fields.split(",")) {
    let field = known.find(candidate => candidate === name);
    if (field === undefined) invariant(`${request} naming the field "${name}"`);
    names.add(field);
  }
  return names;
}

/** Split the text run of `paragraph` that holds `index`, so that a run starts there. */
function splitRunAt(paragraph: Paragraph, index: number): void {
  let position = firstEndingAfter(paragraph.elements, index);
  let element = paragraph.elements.at(position);
  if (!element || element.startIndex >= index) return;
  if (!element.textRun) invariant("a text style over part of an element that is not text");
  let { content, textStyle } = element.textRun;
  let offset = index - element.startIndex;
  let suggestions = runSuggestions(element.textRun);
  let head = textRun(content.slice(0, offset), textStyle, suggestions);
  let tail = textRun(
    content.slice(offset), structuredClone(textStyle), structuredClone(suggestions));
  head.startIndex = element.startIndex;
  head.endIndex = tail.startIndex = index;
  tail.endIndex = element.endIndex;
  paragraph.elements.splice(position, 1, head, tail);
}

/**
 * Point every link of `paragraph` that shares a character with `[start, end)` to `link`, whole:
 * a link set on part of another link repoints all of it.
 */
function repointOverlappedLinks(
  paragraph: Paragraph, start: number, end: number, link: TextStyle["link"],
): void {
  let { elements } = paragraph;
  let linkAt = (position: number) => elements[position]?.textRun?.textStyle.link;
  for (let at = firstEndingAfter(elements, start);
    at < elements.length && elements[at].startIndex < end; at++) {
    let existing = linkAt(at);
    // Every run of a link carries its destination, so a link whose run in the range points
    // there already does so whole, and is left: a request for each of its runs walks it once.
    if (!existing || sameValue(existing, link)) continue;
    // A link reaches over every run beside this one that carries the same destination.
    let from = at;
    while (from > 0 && sameValue(linkAt(from - 1), existing)) from--;
    let to = at + 1;
    while (sameValue(linkAt(to), existing)) to++;
    // Google repoints the whole link, its runs past the request included: one that holds a
    // suggestion would have its suggested text changed with it.
    for (let position = from; position < to; position++) {
      let run = elements[position].textRun;
      if (run && holdsSuggestion(run)) notModelled("a link repointed over text that holds a suggestion");
    }
    for (let position = from; position < to; position++) {
      let run = elements[position].textRun;
      if (run) run.textStyle.link = structuredClone(link);
    }
    at = to - 1;
  }
}

const NAMED_FIELDS = ["bold", "italic", "strikethrough"] as const;

/**
 * The bold, italic and strikethrough the named style of `paragraph` gives its text, resolved over
 * normal text's; none for a tab built without named styles.
 */
function namedTextStyle(
  tab: Draft["tab"], paragraph: Paragraph,
): Record<(typeof NAMED_FIELDS)[number], boolean> | undefined {
  let styles = tab.namedStyles?.styles;
  if (!styles) return undefined;
  let own = styles.find(style => style.namedStyleType === paragraph.paragraphStyle.namedStyleType);
  let normal = styles.find(style => style.namedStyleType === "NORMAL_TEXT");
  let resolve = (field: (typeof NAMED_FIELDS)[number]) =>
    own?.textStyle?.[field] ?? normal?.textStyle?.[field] ?? false;
  return { bold: resolve("bold"), italic: resolve("italic"), strikethrough: resolve("strikethrough") };
}

/** What a text style on suggested text is not modelled as. */
const SUGGESTED_TEXT_STYLE = "a text style on text that holds a suggestion";

/**
 * Throws for a paragraph request (`request`) on `paragraph` while a suggestion changes its
 * style or bullet: what Google does with the suggestion is not recorded, and the builders
 * refuse such a request.
 */
function notOnOwnSuggestion(paragraph: Paragraph, request: string): void {
  if (holdsOwnSuggestion(paragraph)) {
    notModelled(`${request} on a paragraph that holds a suggested change to its style or bullet`);
  }
}

function updateTextStyle(
  draft: Draft,
  { range, textStyle, fields }: { range: DocsRange; textStyle: TextStyle; fields: string },
  options: ModelOptions,
): void {
  let { tab } = draft;
  requireTab(tab, range);
  let { startIndex: start, endIndex: end } = range;
  if (start === end) throw new Error(EMPTY_RANGE);
  let named = fieldNames(fields, TEXT_FIELDS, "updateTextStyle");
  let paragraphs = paragraphsInRange(draft, range, "updateTextStyle");
  let style: ModelTextStyle = textStyle;
  let setsLink = named.has("link") && style.link !== undefined;
  let clearsLink = named.has("link") && style.link === undefined;
  if (setsLink && named.has("underline") !== named.has("foregroundColor")) {
    invariant("a link set by a request that names one of underline and foregroundColor");
  }
  // Read before anything changes: the text of the range may take the look of the text before
  // it. Only a link cleared under `unlinkRestyles` does, so nothing else reads what stands
  // before the range, which may be outside the piece in hand.
  let preceding = options.unlinkRestyles && clearsLink ? styleAt(draft, start - 1) : undefined;
  let inherited: ModelTextStyle = preceding && !preceding.link ? structuredClone(preceding) : {};

  for (let { paragraph, endIndex } of paragraphs) {
    if (setsLink) repointOverlappedLinks(paragraph, start, end, style.link);
    splitRunAt(paragraph, start);
    splitRunAt(paragraph, end);
    let given = namedTextStyle(tab, paragraph);
    // Give `own` the request's value of each field of `taken`.
    let restyle = (own: ModelTextStyle, taken: Iterable<TextField>) => {
      for (let field of taken) copyTextField(own, style, field);
      // Google stores a style the paragraph's named style already gives as inherited, true or
      // false, as live probes showed.
      for (let field of NAMED_FIELDS) {
        if (given && named.has(field) && own[field] === given[field]) delete own[field];
      }
    };
    let { elements } = paragraph;
    for (let position = firstEndingAfter(elements, start);
      position < elements.length && elements[position].startIndex < end; position++) {
      let element = elements[position];
      if (!element.textRun) invariant("a text style over an element that is not text");
      if (holdsSuggestion(element.textRun)) notModelled(SUGGESTED_TEXT_STYLE);
      let own: ModelTextStyle = element.textRun.textStyle;
      let hadLink = own.link !== undefined;
      restyle(own, named);
      if (setsLink && !named.has("underline")) {
        // A link brings its look with it.
        own.underline = true;
        own.foregroundColor = structuredClone(LINK_COLOR);
      }
      if (options.unlinkRestyles && clearsLink && hadLink) {
        for (let field of LOOK_FIELDS) {
          if (!named.has(field)) copyTextField(own, inherited, field);
        }
      }
    }
    // A range that ends where a paragraph's final line break begins reaches the break too:
    // Google returns the break in one run with the text before it, styled or cleared with
    // it. A link is the exception, and with it the look a link brings: the break after
    // linked text stays as it was.
    let lineBreak = paragraph.elements.at(-1)?.textRun;
    let reaching = [...named].filter(field => field !== "link");
    if (end === endIndex - 1 && lineBreak && reaching.length > 0) {
      if (holdsSuggestion(lineBreak)) notModelled(SUGGESTED_TEXT_STYLE);
      restyle(lineBreak.textStyle, reaching);
    }
  }
}

function isDimension(value: unknown): value is Dimension {
  return typeof value === "object" && value !== null && "magnitude" in value &&
    typeof value.magnitude === "number" && "unit" in value && value.unit === "PT";
}

function updateParagraphStyle(
  draft: Draft,
  { range, paragraphStyle, fields }: {
    range: DocsRange; paragraphStyle: Record<string, unknown>; fields: string;
  },
): void {
  let named = fieldNames<ParagraphField>(fields, PARAGRAPH_FIELDS, "updateParagraphStyle");
  for (let { paragraph } of paragraphsInRange(draft, range, "updateParagraphStyle")) {
    notOnOwnSuggestion(paragraph, "updateParagraphStyle");
    let style: ModelParagraphStyle = paragraph.paragraphStyle;
    if (named.has("namedStyleType")) {
      // Naming the style restyles the text, below.
      if (paragraph.elements.some(element => element.textRun && holdsSuggestion(element.textRun))) {
        notModelled(SUGGESTED_TEXT_STYLE);
      }
      let { namedStyleType } = paragraphStyle;
      if (typeof namedStyleType !== "string") {
        invariant("updateParagraphStyle naming namedStyleType without giving one");
      }
      style.namedStyleType = namedStyleType;
      // Naming the style resets more than the style: the paragraph's alignment goes, and so does
      // each part of its text's look that every run of it has alike, its break's included, as a
      // look given the whole line. A look on part of the text stays, and so do links (probes
      // P2, P5, P6: bold and size on the whole line go, italic on one word stays).
      delete style.alignment;
      let runs = paragraph.elements.flatMap(element =>
        element.textRun ? [element.textRun.textStyle as ModelTextStyle] : []);
      for (let field of LOOK_FIELDS) {
        let first = JSON.stringify(runs[0]?.[field]);
        if (first !== undefined && runs.every(own => JSON.stringify(own[field]) === first)) {
          for (let own of runs) delete own[field];
        }
      }
      // Naming the style also takes the indent off a paragraph that is not a list item, as
      // recorded for a paragraph split off a list item: its bullet removed and its style named,
      // it reads with no indent. That a list item keeps the indent of its level is inferred: no
      // recorded document names the style of one.
      if (!paragraph.bullet) {
        delete style.indentStart;
        delete style.indentFirstLine;
      }
    }
    for (let field of ["indentStart", "indentFirstLine"] as const) {
      if (!named.has(field)) continue;
      let value = paragraphStyle[field];
      if (value === undefined) delete style[field];
      else if (isDimension(value)) style[field] = { ...value };
      else invariant(`updateParagraphStyle with ${field} not in points`);
    }
  }
}

function deleteParagraphBullets(draft: Draft, { range }: { range: DocsRange }): void {
  for (let { paragraph } of paragraphsInRange(draft, range, "deleteParagraphBullets")) {
    notOnOwnSuggestion(paragraph, "deleteParagraphBullets");
    if (!paragraph.bullet) continue;
    // Google leaves the paragraph indented where its bullet stood.
    let style: ModelParagraphStyle = paragraph.paragraphStyle;
    Object.assign(style, listItemIndent(paragraph.bullet));
    delete paragraph.bullet;
  }
}

/**
 * Add a list of the preset's levels to the tab, under an id no list of it has: the lowest of
 * the model's own form (`MODEL_LIST_ID`) that the tab's lists do not hold.
 */
function mintList(draft: Draft, preset: readonly NestingLevel[]): string {
  let { lists } = draft.tab;
  let number = 1;
  while (lists[`${MODEL_LIST_ID}${number}`]) number++;
  let listId = `${MODEL_LIST_ID}${number}`;
  lists[listId] = { listProperties: { nestingLevels: structuredClone([...preset]) } };
  draft.made.push(listId);
  return listId;
}

/** Remove the tab characters a paragraph's text starts with, and say how many there were. */
function stripLeadingTabs(paragraph: Paragraph): number {
  let tabs = 0;
  let { elements } = paragraph;
  while (elements[0]?.textRun) {
    let run = elements[0].textRun;
    let own = run.content.length - run.content.replace(/^\t+/, "").length;
    if (own > 0 && holdsSuggestion(run)) notModelled("a deletion of text that holds a suggestion");
    tabs += own;
    run.content = run.content.slice(own);
    if (run.content !== "") break;
    elements.shift();
  }
  return tabs;
}

/**
 * Make list items of the paragraphs a range touches, as Google is recorded doing it. None of
 * them may be a list item when the request runs: the builders remove bullets first.
 *
 * The range joins the list of the item directly before it when that list was made by the
 * same preset, and otherwise a list the request makes, with the preset's nine levels. It
 * never joins the list after it. Each paragraph loses its leading tabs and lands at level
 * `joined + tabs - least`: `tabs` is how many it had, `least` the fewest any paragraph of
 * the range had, and `joined` the level of the item the range joined behind, or 0 in a list
 * of its own. So a range lands no shallower than the item before it, and an empty paragraph
 * with fewer tabs, put first and deleted afterwards, is what lets the others land deeper.
 * Each paragraph is indented as its level is.
 *
 * Inferred, not on record: a list counts as made by the preset when `madeByPreset` says so,
 * which is how a list made in the Docs editor is told from one this request made. A paragraph
 * that would land past the ninth level is not modelled: no recording shows what Google does
 * with it, and the builders refuse to write one.
 */
function createParagraphBullets(
  draft: Draft, { range, bulletPreset }: { range: DocsRange; bulletPreset: string },
): void {
  let { tab } = draft;
  if (!Object.hasOwn(BULLET_PRESETS, bulletPreset)) {
    invariant("createParagraphBullets with a preset the gatekeeper does not send");
  }
  let preset = BULLET_PRESETS[bulletPreset];
  let paragraphs = paragraphsInRange(draft, range, "createParagraphBullets");
  if (paragraphs.some(({ paragraph }) => paragraph.bullet)) {
    invariant("createParagraphBullets over a range that holds a list item");
  }
  for (let { paragraph } of paragraphs) notOnOwnSuggestion(paragraph, "createParagraphBullets");

  // The item joined behind is read before any paragraph changes. It stands before the range's
  // first paragraph: in the body that may be outside the piece in hand, which the body says.
  let first = paragraphAt(draft, range.startIndex);
  let previous = first && (first.cells.length === 0
    ? draft.body.before(first.position) : first.container[first.position - 1]);
  let before = previous?.paragraph?.bullet;
  let behind = before && madeByPreset(tab.lists[before.listId], preset) ? before : undefined;
  let listId = behind?.listId ?? mintList(draft, preset);
  let joined = behind?.nestingLevel ?? 0;

  let tabs = paragraphs.map(({ paragraph }) => stripLeadingTabs(paragraph));
  let least = Math.min(...tabs);
  for (let [index, { paragraph }] of paragraphs.entries()) {
    let level = joined + tabs[index] - least;
    // No recording shows what Google Docs does with a level a list does not have. The builders
    // write every item at the level it is given and refuse one past the ninth
    // (`LIST_LEVEL_TOO_DEEP`), so no batch of theirs reaches this.
    if (level >= LIST_LEVELS) {
      notModelled("createParagraphBullets of a paragraph past the ninth level of its list");
    }
    paragraph.bullet = { listId, ...(level > 0 ? { nestingLevel: level } : {}) };
    let style: ModelParagraphStyle = paragraph.paragraphStyle;
    Object.assign(style, listItemIndent(paragraph.bullet));
  }
  // Only the tabs taken off change a length.
  if (first && tabs.some(count => count > 0)) {
    let last = paragraphs[paragraphs.length - 1];
    touched(draft, first, paragraphs.length, paragraphs[0].startIndex, last.endIndex);
  }
}

function insertTable(
  draft: Draft,
  { rows, columns, location }: { rows: number; columns: number; location: DocsLocation },
  options: ModelOptions,
): void {
  requireTab(draft.tab, location);
  let { index } = location;
  let place = requestedParagraphAt(draft, index);
  if (!place) throw new Error(OUTSIDE_PARAGRAPH);
  if (rows === 0) throw new Error(NO_ROWS);
  if (!Number.isInteger(rows) || rows < 0 || !Number.isInteger(columns) || columns < 1) {
    invariant(`insertTable of ${rows} rows and ${columns} columns`);
  }
  let { element, paragraph } = place;
  let atStart = index === element.startIndex;
  if (!atStart && index !== element.endIndex - 1) {
    invariant("insertTable strictly inside a paragraph's text");
  }
  let lineBreak = paragraph.elements.at(-1)?.textRun;
  if (!lineBreak?.content.endsWith("\n")) {
    invariant("a paragraph that does not end in a line break");
  }

  // Google cuts the paragraph in two around the table, and both parts carry its style, bullet
  // and indent. A positioned object stays with the part before the table.
  let before: ParagraphElementOf;
  let after: ParagraphElementOf;
  if (atStart) {
    before = siblingParagraph(paragraph, [textRun("\n", {})]);
    if (paragraph.positionedObjectIds) {
      before.paragraph.positionedObjectIds = paragraph.positionedObjectIds;
      delete paragraph.positionedObjectIds;
    }
    after = element;
  } else {
    before = element;
    after = siblingParagraph(paragraph, [textRun("\n", structuredClone(lineBreak.textStyle))]);
  }

  // Cut at its start, a paragraph of a named style gives the cells that style's look, written
  // onto their line breaks.
  let headingLook: ModelTextStyle | undefined = options.copyStyles && atStart &&
    paragraph.paragraphStyle.namedStyleType !== "NORMAL_TEXT"
    ? { italic: true, fontSize: HEADING_LOOK_FONT_SIZE }
    : undefined;
  let tableRows = Array.from({ length: rows }, (): TableRow => ({
    startIndex: 0,
    endIndex: 0,
    tableCells: Array.from({ length: columns }, () => ({
      ...cellOf(plainParagraph(structuredClone(headingLook))),
      tableCellStyle: structuredClone(INSERTED_CELL_STYLE),
    })),
    tableRowStyle: { minRowHeight: { unit: "PT" } },
  }));
  let tableStyle = {
    tableColumnProperties: Array.from({ length: columns }, () => ({ widthType: "EVENLY_DISTRIBUTED" })),
  };
  let { startIndex, endIndex } = element;
  place.container.splice(place.position, 1,
    before, { startIndex: 0, endIndex: 0, table: { tableRows, tableStyle } }, after);
  touched(draft, place, 3, startIndex, endIndex);
}

/**
 * Recompute the indexes of a table whose rows, columns or cells a request changed. Of a table
 * the request removed nothing is left to recompute: what stood before it is as it was.
 */
function tableTouched(draft: Draft, place: TablePlace): void {
  let { startIndex, endIndex } = place.element;
  if (place.container[place.position] === place.element) {
    touched(draft, place, 1, startIndex, endIndex);
  } else lower(draft, place.container, place.cells, place.position, startIndex);
}

/** The cell a row or column request names, in a table whose rows and columns can be changed. */
type NamedCell = { place: TablePlace; rows: TableRow[]; rowIndex: number; columnIndex: number };

function namedCell(draft: Draft, location: TableCellLocation, request: string): NamedCell {
  requireTab(draft.tab, location.tableStartLocation);
  let place = requestedTableAt(draft, location.tableStartLocation.index);
  if (!place) throw new Error(INVALID_TABLE_START);
  if (place.cells.length > 0) invariant(`${request} on a table inside a cell`);
  let { table } = place;
  let rows = table.tableRows ?? [];
  if (!draft.unsuggested.has(table)) {
    if ([table, ...rows, ...cellsOf(table)].some(part =>
      part.suggestedInsertionIds?.length || part.suggestedDeletionIds?.length)) {
      notModelled(`${request} on a table that holds a suggestion`);
    }
    draft.unsuggested.add(table);
  }
  let { rowIndex, columnIndex } = location;
  if (!Number.isInteger(rowIndex) || rowIndex < 0 ||
    !Number.isInteger(columnIndex) || columnIndex < 0) {
    invariant(`${request} at row ${rowIndex}, column ${columnIndex}`);
  }
  if (rowIndex >= rows.length) {
    throw new Error(
      `The row index ${rowIndex} should be less than the total number of rows ${rows.length}.`);
  }
  let columns = rows[rowIndex].tableCells?.length ?? 0;
  if (columnIndex >= columns) {
    throw new Error(
      `The column index ${columnIndex} should be less than the total number of columns ` +
      `${columns}.`);
  }
  // Only a request whose lines cross no merged cell is modelled: one that does grows, moves or
  // copies the merged cell (probe M5). The line a new one copies counts as crossed.
  let ofRows = request === "insertTableRow" || request === "deleteTableRow";
  let line = ofRows ? rowIndex : columnIndex;
  // Only a table that holds a merged cell has one to cross, and a table is asked once.
  if (!holdsMergedCell(draft, table)) return { place, rows, rowIndex, columnIndex };
  rows.forEach((row, r) => (row.tableCells ?? []).forEach((cell, c) => {
    let spans = cell.tableCellStyle;
    let span = ofRows ? spans?.rowSpan ?? 1 : spans?.columnSpan ?? 1;
    let other = ofRows ? spans?.columnSpan ?? 1 : spans?.rowSpan ?? 1;
    let start = ofRows ? r : c;
    if ((span > 1 || other > 1) && line >= start && line < start + span) {
      notModelled(`${request} on a line that crosses a merged cell`);
    }
  }));
  return { place, rows, rowIndex, columnIndex };
}

/**
 * The paragraph of a cell added beside `reference`: plain, or with what Google copies from the
 * first paragraph of the cell beside it, which is that paragraph's style and, on the new cell's
 * line break, the text style of its first character. Never its bullet, and no second paragraph.
 */
function newCellParagraph(reference: TableCell, options: ModelOptions): ParagraphElementOf {
  let first = reference.content?.[0]?.paragraph;
  if (!options.copyStyles || !first) return plainParagraph();
  let style: ModelParagraphStyle = structuredClone(first.paragraphStyle);
  // A cell copied from a list item is indented as that item's level is.
  if (first.bullet) Object.assign(style, listItemIndent(first.bullet));
  let source = first.elements[0] && elementTextStyle(first.elements[0]);
  let lineBreak: ModelTextStyle = {};
  if (source) for (let field of COPIED_FIELDS) copyTextField(lineBreak, source, field);
  return paragraphElement([textRun("\n", lineBreak)], style, undefined);
}

/**
 * What a new row's cell holds of the chips that stand alone in the cell beside it, as live
 * probes saw Google copy them: a dropdown of the same definition, set to that definition's first
 * option, which the document does not name; the placeholder character; or nothing.
 */
function newRowChip(reference: TableCell): ParagraphElement | undefined {
  let copy = loneChipCopy(reference.content ?? []);
  if (copy === "unseen") {
    notModelled("a row added beside a cell of chips in a shape nobody has seen copied");
  }
  if (copy === "placeholder") return textRun(CHIP_PLACEHOLDER, {});
  if (copy !== "dropdown") return undefined;
  let definition = reference.content?.[0]?.paragraph?.elements
    .find(element => element.dropdown)?.dropdown?.dropdownProperties?.dropdownDefinitionId;
  return {
    startIndex: 0,
    endIndex: 1,
    dropdown: {
      textStyle: {},
      dropdownProperties: definition === undefined ? {} : { dropdownDefinitionId: definition },
    },
  };
}

function insertTableRow(
  draft: Draft, location: TableCellLocation, below: boolean, options: ModelOptions,
): void {
  let { place, rows, rowIndex } = namedCell(draft, location, "insertTableRow");
  let reference = rows[rowIndex];
  let cells = reference.tableCells ?? [];
  let header = reference.tableRowStyle?.tableHeader === true;
  let height = reference.tableRowStyle?.minRowHeight;
  let row: TableRow = {
    startIndex: 0,
    endIndex: 0,
    tableCells: cells.map(cell => {
      let paragraph = newCellParagraph(cell, options);
      let chip = newRowChip(cell);
      if (chip) paragraph.paragraph.elements.unshift(chip);
      return withCopiedStyle(cellOf(paragraph), cell);
    }),
    // A row added beside a pinned header row is pinned too, and every row takes the height of
    // the row it copies, as probe S1 saw.
    ...(header || height
      ? {
        tableRowStyle: {
          ...(header ? { tableHeader: true } : {}),
          ...(height ? { minRowHeight: structuredClone(height) } : {}),
        },
      }
      : {}),
  };
  rows.splice(below ? rowIndex + 1 : rowIndex, 0, row);
  place.table.tableRows = rows;
  tableTouched(draft, place);
}

function insertTableColumn(
  draft: Draft, location: TableCellLocation, right: boolean, options: ModelOptions,
): void {
  let { place, rows, columnIndex } = namedCell(draft, location, "insertTableColumn");
  let at = right ? columnIndex + 1 : columnIndex;
  for (let row of rows) {
    let cells = row.tableCells ?? [];
    let reference = cells[columnIndex];
    if (!reference) notModelled("insertTableColumn on a table whose rows differ in length");
    // A new column copies no chip, but the cells' styles, as probe S2 saw.
    cells.splice(at, 0, withCopiedStyle(cellOf(newCellParagraph(reference, options)), reference));
    row.tableCells = cells;
  }
  tableTouched(draft, place);
  // The new column takes the width of the column it copies. Beside one that shares the page's
  // width, Google may narrow the fixed columns, as probe S2c saw.
  let properties = place.table.tableStyle?.tableColumnProperties;
  if (!properties) return;
  let copied = structuredClone(properties[columnIndex]);
  if (copied?.widthType !== "FIXED_WIDTH") {
    for (let column of properties) {
      if (column.widthType === "FIXED_WIDTH") column.width = { magnitude: NARROWED_WIDTH, unit: "PT" };
    }
  }
  properties.splice(at, 0, copied ?? { widthType: "EVENLY_DISTRIBUTED" });
}

/** `cell` with the style of the cell it copies, as Google copies it into a row or column. */
function withCopiedStyle(cell: TableCell, reference: TableCell): TableCell {
  return reference.tableCellStyle
    ? { ...cell, tableCellStyle: { ...structuredClone(reference.tableCellStyle), rowSpan: 1, columnSpan: 1 } }
    : cell;
}

function deleteTableRow(draft: Draft, location: TableCellLocation): void {
  let { place, rows, rowIndex } = namedCell(draft, location, "deleteTableRow");
  // The rows of this table that are exact: all of them unless the watermark lies in the table.
  let known = draft.settled.get(rows) ?? Infinity;
  let [row] = rows.splice(rowIndex, 1);
  // The table ends earlier by the row's length, which the row's indexes give whether or not
  // they are exact: what lies past the watermark is off by one amount at both its ends. The
  // rows that follow are left as they are and the watermark comes down to where the row
  // began, so deleting row after row of a table does not walk the table once for each.
  place.element.endIndex -= row.endIndex - row.startIndex;
  if (rows.length === 0) {
    // A table that loses its last row is gone, and the paragraphs around it stay.
    place.container.splice(place.position, 1);
    lower(draft, place.container, [], place.position, place.element.startIndex);
  } else if (rowIndex < known) {
    // The row began where its index says, below the watermark: the rows before it stay exact.
    lower(draft, place.container, [], place.position + 1, row.startIndex);
    draft.settled.set(rows, rowIndex);
  } else {
    // The row lay past the watermark, which is in an earlier row of this table, so its start
    // may be off either way. The settled rows are before it and stand as they are.
    draft.validBelow = Math.min(draft.validBelow, row.startIndex);
  }
  draft.footnotesMoved = true;
}

function deleteTableColumn(draft: Draft, location: TableCellLocation): void {
  let { place, rows, columnIndex } = namedCell(draft, location, "deleteTableColumn");
  for (let row of rows) {
    if ((row.tableCells?.length ?? 0) <= columnIndex) {
      notModelled("deleteTableColumn on a table whose rows differ in length");
    }
    row.tableCells?.splice(columnIndex, 1);
  }
  place.table.tableStyle?.tableColumnProperties?.splice(columnIndex, 1);
  // A table that loses its last column is gone, and the paragraphs around it stay.
  if (rows.every(row => !row.tableCells?.length)) place.container.splice(place.position, 1);
  tableTouched(draft, place);
  draft.footnotesMoved = true;
}

function pinTableHeaderRows(
  draft: Draft,
  { tableStartLocation, pinnedHeaderRowsCount: count }: {
    tableStartLocation: DocsLocation; pinnedHeaderRowsCount: number;
  },
): void {
  requireTab(draft.tab, tableStartLocation);
  let place = requestedTableAt(draft, tableStartLocation.index);
  if (!place) throw new Error(INVALID_TABLE_START);
  let rows = place.table.tableRows ?? [];
  if (!Number.isInteger(count) || count < 0 || count > rows.length) {
    invariant(`pinTableHeaderRows of ${count} rows in a table of ${rows.length}`);
  }
  for (let [index, row] of rows.entries()) {
    if (index < count) row.tableRowStyle = { ...row.tableRowStyle, tableHeader: true };
    else if (row.tableRowStyle) delete row.tableRowStyle.tableHeader;
  }
}

/**
 * Set the width of columns, as probe R5 saw: the others keep theirs, an empty list names every
 * column, and a fixed width under 5pt is refused.
 */
function updateTableColumnProperties(
  draft: Draft,
  { tableStartLocation, columnIndices, tableColumnProperties, fields }: Extract<
    GoogleDocsRequest, { updateTableColumnProperties: unknown }
  >["updateTableColumnProperties"],
): void {
  requireTab(draft.tab, tableStartLocation);
  let place = requestedTableAt(draft, tableStartLocation.index);
  if (!place) throw new Error(INVALID_TABLE_START);
  if (fields !== "widthType,width" && fields !== "widthType") invariant(`fields ${fields}`);
  let columns = place.table.tableRows?.[0]?.tableCells?.length ?? 0;
  let { widthType, width } = tableColumnProperties;
  if (widthType === "FIXED_WIDTH") {
    if (!width) {
      throw new Error("Width value must be provided when updating column width to fixed width.");
    }
    if (width.magnitude < 5) {
      throw new Error("Column width must not be less than minimum column width: 5.");
    }
  }
  let style = place.table.tableStyle ??= {};
  let properties = style.tableColumnProperties ??=
    Array.from({ length: columns }, () => ({ widthType: "EVENLY_DISTRIBUTED" }));
  for (let column of columnIndices.length === 0 ? properties.keys() : columnIndices) {
    if (column >= columns) invariant(`a column index ${column} past the table`);
    properties[column] = widthType === "FIXED_WIDTH"
      ? { widthType, width: structuredClone(width) }
      : { widthType };
  }
}

const BORDER_SIDES = {
  borderTop: { along: "top", opposite: "borderBottom", step: [-1, 0] },
  borderBottom: { along: "bottom", opposite: "borderTop", step: [1, 0] },
  borderLeft: { along: "left", opposite: "borderRight", step: [0, -1] },
  borderRight: { along: "right", opposite: "borderLeft", step: [0, 1] },
} as const;
const CELL_STYLE_FIELDS: readonly (keyof TableCellStyle)[] = [
  "backgroundColor", "contentAlignment", "paddingTop", "paddingRight", "paddingBottom",
  "paddingLeft", "borderTop", "borderRight", "borderBottom", "borderLeft",
];

/**
 * Style cells, as probes R1, R2, R2b and R7 saw. A request reaches the whole of every merged
 * cell it reaches any cell of, and sets each field on every cell it reaches, but a border only
 * on the cells along that side of each merged cell, or of each cell, and then on the facing side
 * of the cells beside them, last write winning. A field the mask names and the style leaves out
 * is cleared.
 */
function updateTableCellStyle(
  draft: Draft,
  { tableRange, tableCellStyle, fields }: Extract<
    GoogleDocsRequest, { updateTableCellStyle: unknown }
  >["updateTableCellStyle"],
): void {
  let { tableCellLocation: location, rowSpan, columnSpan } = tableRange;
  // The table's cells, and the merged cell, or the cell, that covers each.
  let { grid, heads } = rangeTable(draft, tableRange);
  let named = fields.split(",") as (keyof TableCellStyle)[];
  if (named.some(field => !CELL_STYLE_FIELDS.includes(field))) invariant(`fields ${fields}`);
  for (let field of named) {
    let border = tableCellStyle[field];
    if (!field.startsWith("border") || border === undefined) continue;
    let { dashStyle, color } = border as { dashStyle?: string; color?: { color?: unknown } };
    if (!dashStyle) throw new Error("The dash style is invalid: DASH_STYLE_UNSPECIFIED");
    if (!color?.color) {
      throw new Error(
        "Table cell borders cannot be transparent. To hide a table cell border, make its width 0.");
    }
  }
  let reached = new Set<string>();
  for (let r = location.rowIndex; r < location.rowIndex + rowSpan; r++) {
    for (let c = location.columnIndex; c < location.columnIndex + columnSpan; c++) {
      if (!grid[r]?.[c]) invariant(`a cell range past the table at row ${r}, column ${c}`);
      reached.add(heads[r][c].join());
    }
  }
  // The style with its colours and its lengths as Google stores them.
  let given: TableCellStyle = { ...tableCellStyle };
  if (given.backgroundColor) given.backgroundColor = storedColor(given.backgroundColor);
  for (let side of Object.keys(BORDER_SIDES) as (keyof typeof BORDER_SIDES)[]) {
    let border = given[side];
    if (!border) continue;
    given[side] = {
      ...border,
      ...(border.color ? { color: storedColor(border.color) } : {}),
      ...(border.width ? { width: storedLength(border.width) } : {}),
    };
  }
  for (let side of ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"] as const) {
    let padding = given[side];
    if (padding) given[side] = storedLength(padding);
  }
  // Give `cell` the request's value of `field`, as its own field `own`.
  let set = (cell: TableCell, field: keyof TableCellStyle, own = field) => {
    let style: Record<string, unknown> = cell.tableCellStyle ??= {};
    let value = given[field];
    if (value === undefined) delete style[own];
    else style[own] = structuredClone(value);
  };
  for (let key of reached) {
    let [hr, hc] = key.split(",").map(Number);
    let spans = grid[hr][hc].tableCellStyle;
    let lastRow = Math.min(hr + (spans?.rowSpan ?? 1), grid.length) - 1;
    let lastColumn = Math.min(hc + (spans?.columnSpan ?? 1), grid[hr].length) - 1;
    for (let field of named) {
      if (!(field in BORDER_SIDES)) {
        for (let r = hr; r <= lastRow; r++) for (let c = hc; c <= lastColumn; c++) set(grid[r][c], field);
        continue;
      }
      let { along, opposite, step } = BORDER_SIDES[field as keyof typeof BORDER_SIDES];
      let cells: [number, number][] = [];
      if (along === "top" || along === "bottom") {
        for (let c = hc; c <= lastColumn; c++) cells.push([along === "top" ? hr : lastRow, c]);
      } else {
        for (let r = hr; r <= lastRow; r++) cells.push([r, along === "left" ? hc : lastColumn]);
      }
      for (let [r, c] of cells) {
        set(grid[r][c], field);
        let beside = grid[r + step[0]]?.[c + step[1]];
        if (beside) set(beside, field, opposite);
      }
    }
  }
}

/**
 * Set the least height of rows, as probe R6 saw: a pinned row stays pinned, 0 is stored as a
 * height without a magnitude, and a negative one is refused.
 */
function updateTableRowStyle(
  draft: Draft,
  { tableStartLocation, rowIndices, tableRowStyle, fields }: Extract<
    GoogleDocsRequest, { updateTableRowStyle: unknown }
  >["updateTableRowStyle"],
): void {
  requireTab(draft.tab, tableStartLocation);
  let place = requestedTableAt(draft, tableStartLocation.index);
  if (!place) throw new Error(INVALID_TABLE_START);
  if (fields !== "minRowHeight") invariant(`fields ${fields}`);
  let { magnitude } = tableRowStyle.minRowHeight;
  if (magnitude < 0) throw new Error("The minimum row height cannot be negative.");
  let rows = place.table.tableRows ?? [];
  for (let index of rowIndices.length === 0 ? rows.keys() : rowIndices) {
    let row = rows[index];
    if (!row) invariant(`a row index ${index} past the table`);
    row.tableRowStyle = {
      ...row.tableRowStyle,
      minRowHeight: magnitude === 0 ? { unit: "PT" } : { magnitude, unit: "PT" },
    };
  }
}

/**
 * The height the model gives each merged row: Google sets the height the row renders at (probe
 * M1 saw 21pt for a line of text, 25pt and 26pt for more), which only it knows.
 */
const MERGED_ROW_HEIGHT = 21;

type TableRange = { tableCellLocation: TableCellLocation; rowSpan: number; columnSpan: number };

/** The table a range names, its cells, and the cell covering each cell. */
function rangeTable(draft: Draft, range: TableRange) {
  let location = range.tableCellLocation;
  requireTab(draft.tab, location.tableStartLocation);
  let place = requestedTableAt(draft, location.tableStartLocation.index);
  if (!place) throw new Error(INVALID_TABLE_START);
  let rows = place.table.tableRows ?? [];
  let grid = rows.map(row => row.tableCells ?? []);
  let heads = grid.map(row => row.map((): [number, number] => [-1, -1]));
  grid.forEach((row, r) => row.forEach((cell, c) => {
    if (heads[r][c][0] >= 0) return;
    let spans = cell.tableCellStyle;
    for (let down = r; down < Math.min(r + (spans?.rowSpan ?? 1), grid.length); down++) {
      for (let across = c; across < Math.min(c + (spans?.columnSpan ?? 1), row.length); across++) {
        heads[down][across] = [r, c];
      }
    }
  }));
  return { place, rows, grid, heads };
}

/** Whether a cell is one empty paragraph, which a merge takes nothing from (probe M7). */
function isEmptyCell(cell: TableCell): boolean {
  let content = cell.content ?? [];
  let paragraph = content.length === 1 ? content[0].paragraph : undefined;
  return !!paragraph && paragraph.elements.length === 1 &&
    paragraph.elements[0].textRun?.content === "\n";
}

/**
 * Merge cells, as probes M1, M2, M4 and M7 saw: the top-left cell takes the paragraphs of every
 * cell of the range, row by row, one that is one empty paragraph adding none; the others are
 * left one empty paragraph and keep their styles; each merged row's least height is set. A range
 * that takes in part of a merged cell, or that takes in a pinned header row and a row below the
 * header, is refused. That the second holds for any number of pinned rows is inferred from one
 * pinned row, the only header probe M4 merged across.
 */
function mergeTableCells(draft: Draft, range: TableRange): void {
  let { place, rows, grid, heads } = rangeTable(draft, range);
  let { rowIndex: top, columnIndex: left } = range.tableCellLocation;
  let bottom = top + range.rowSpan - 1;
  let right = left + range.columnSpan - 1;
  if (bottom >= grid.length || right >= (grid[0]?.length ?? 0)) invariant("a range past the table");
  let inside = (r: number, c: number) => r >= top && r <= bottom && c >= left && c <= right;
  let pinned = (r: number) => rows[r].tableRowStyle?.tableHeader === true;
  let cut = pinned(top) !== pinned(bottom);
  grid.forEach((row, r) => row.forEach((_, c) => {
    let [hr, hc] = heads[r][c];
    if (inside(hr, hc) !== inside(r, c)) cut = true;
  }));
  if (cut) throw new Error("A non-rectangular collection of cells cannot be merged.");
  // What a merge does with a positioned object anchored to a paragraph of the range, which it
  // moves, joins or leaves out as one empty paragraph, nobody has seen.
  let anchors = range.rowSpan * range.columnSpan > 1 && grid.some((row, r) => row.some((cell, c) =>
    inside(r, c) && cell.content?.some(({ paragraph }) => paragraph?.positionedObjectIds?.length)));
  if (anchors) notModelled("merging cells that anchor a positioned object");
  // A merge moves the cells below the first ahead of the cells beside it, and a footnote with
  // them. That Google then numbers the footnotes by where they stand is inferred: no recorded
  // document holds a merge over one.
  draft.footnotesMoved = true;
  if (range.rowSpan * range.columnSpan === 1) return;
  let joined: StructuralElement[] = [];
  for (let r = top; r <= bottom; r++) {
    for (let c = left; c <= right; c++) {
      let cell = grid[r][c];
      if (!isEmptyCell(cell)) joined.push(...cell.content ?? []);
      if (r !== top || c !== left) {
        cell.content = [plainParagraph()];
        if (cell.tableCellStyle) cell.tableCellStyle = { ...cell.tableCellStyle, rowSpan: 1, columnSpan: 1 };
      }
    }
  }
  let head = grid[top][left];
  head.content = joined.length > 0 ? joined : [plainParagraph()];
  head.tableCellStyle = { ...head.tableCellStyle, rowSpan: range.rowSpan, columnSpan: range.columnSpan };
  for (let r = top; r <= bottom; r++) {
    rows[r].tableRowStyle = {
      ...rows[r].tableRowStyle, minRowHeight: { magnitude: MERGED_ROW_HEIGHT, unit: "PT" },
    };
  }
  draft.merged.delete(place.table);
  tableTouched(draft, place);
}

/**
 * Split a merged cell, as probes M3 and M6 saw: named by any of its cells, it keeps its text, the
 * cells it covered show the styles they kept, and it takes the right edge of the cells along its
 * right side. A cell that is not merged is left as it is.
 */
function unmergeTableCells(draft: Draft, range: TableRange): void {
  let { place, grid, heads } = rangeTable(draft, range);
  let { rowIndex, columnIndex } = range.tableCellLocation;
  let [hr, hc] = heads[rowIndex][columnIndex];
  let head = grid[hr][hc];
  let style = head.tableCellStyle;
  let columns = style?.columnSpan ?? 1;
  if ((style?.rowSpan ?? 1) === 1 && columns === 1) return;
  let edge = grid[hr][hc + columns - 1].tableCellStyle?.borderRight;
  head.tableCellStyle = {
    ...style, rowSpan: 1, columnSpan: 1, ...(edge ? { borderRight: structuredClone(edge) } : {}),
  };
  draft.merged.delete(place.table);
}
